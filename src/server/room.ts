/**
 * Room — server-side state hub for one logical resource.
 *
 * Two layers:
 * - SDK layer (SanityBridge): raw Sanity docs. Subscribe, store, write.
 * - Domain layer (Room): mapped app state. Owns all mapping, ref assembly, broadcast.
 *
 * The bridge never sees domain state. The Room never sees raw Sanity docs
 * except through the mapping functions.
 */

import type { ServerTransport } from '../transport'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isClientMsg } from '../protocol'
import { docChannel, parseChannel } from '../channel'
import type { DocumentMapping } from '../mapping'
import { immutableReconcile } from '../reconcile'
import type { SanityInstance } from '@sanity/sdk'
import { SanityBridge, type SanityResource } from './sanity-bridge'

// ── Types ─────────────────────────────────────────────────────────────────

export interface RoomDocConfig {
  docId: string
  mapping: DocumentMapping<unknown>
  initialState: unknown
}

export interface RoomConfig {
  documents: Record<string, RoomDocConfig>
  gracePeriodMs?: number
}

export interface AppChannelHandler {
  onMessage(clientId: string, payload: unknown, room: Room): void
  onClientJoin?(clientId: string, room: Room): void
  onClientLeave?(clientId: string, room: Room): void
}

interface ClientInfo {
  transport: ServerTransport
  unsubMessage: () => void
  unsubClose: () => void
}

interface DocEntry {
  bridge: SanityBridge
  mapping: DocumentMapping<unknown>
  /** Domain state — the Room's authoritative app-level state. */
  state: unknown
  /** Transaction IDs of our own writes — skip echoes with matching _rev. */
  ownTxns: Set<string>
}

// ── Room ──────────────────────────────────────────────────────────────────

export class Room {
  private clients = new Map<string, ClientInfo>()
  private docs = new Map<string, DocEntry>()
  private appChannels = new Map<string, AppChannelHandler>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private gracePeriodMs: number
  private disposed = false
  private instance: SanityInstance
  private resource: SanityResource

  // Ref-following: ref bridges per parent doc key
  private refBridges = new Map<string, Map<string, SanityBridge>>()
  private updatingRefs = new Set<string>()

  onEmpty: (() => void) | null = null

  constructor(config: RoomConfig, instance: SanityInstance, resource: SanityResource) {
    this.instance = instance
    this.resource = resource
    this.gracePeriodMs = config.gracePeriodMs ?? 30_000

    for (const [key, docConfig] of Object.entries(config.documents)) {
      this.createDoc(key, docConfig)
    }
  }

  // ── Client management ─────────────────────────────────────────────────

  addClient(transport: ServerTransport): string {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }

    const clientId = transport.clientId
    const unsubMessage = transport.onMessage((raw) => {
      if (isClientMsg(raw)) this.handleClientMsg(clientId, raw)
    })
    const unsubClose = transport.onClose(() => {
      this.removeClient(clientId)
    })
    this.clients.set(clientId, { transport, unsubMessage, unsubClose })

    // Send current domain state for all docs
    for (const [key, doc] of this.docs) {
      this.sendTo(clientId, { channel: docChannel(key), type: 'state', state: doc.state })
    }

    for (const handler of this.appChannels.values()) {
      handler.onClientJoin?.(clientId, this)
    }
    return clientId
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    client.unsubMessage()
    client.unsubClose()
    this.clients.delete(clientId)
    for (const handler of this.appChannels.values()) {
      handler.onClientLeave?.(clientId, this)
    }
    if (this.clients.size === 0) {
      this.graceTimer = setTimeout(() => {
        if (this.clients.size === 0) this.dispose()
      }, this.gracePeriodMs)
    }
  }

  get clientCount(): number { return this.clients.size }

  // ── Domain state access ───────────────────────────────────────────────

  getDocState<T = unknown>(docKey: string): T {
    const doc = this.docs.get(docKey)
    if (doc) return doc.state as T
    throw new Error(`Unknown document key: ${docKey}`)
  }

  mutateDoc(docKey: string, mutation: Mutation): void {
    const doc = this.docs.get(docKey)
    if (!doc) throw new Error(`Unknown document key: ${docKey}`)

    const result = doc.mapping.applyMutation(doc.state, mutation)
    if (result === null) return

    doc.state = result

    // Write to Sanity — generate txnId BEFORE write so echo suppression works
    const { patch, refPatches } = doc.mapping.toSanityPatch(result)
    const refDocs = this.buildRefDocWrites(patch as Record<string, unknown>, doc.mapping, refPatches)
    const txnId = crypto.randomUUID()
    doc.ownTxns.add(txnId)
    doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId)

    // Broadcast domain state to all clients
    this.broadcastAll({ channel: docChannel(docKey), type: 'state', state: result })
  }

  // ── App channels ──────────────────────────────────────────────────────

  registerAppChannel(name: string, handler: AppChannelHandler): void {
    this.appChannels.set(name, handler)
  }

  broadcastApp(channel: string, payload: unknown, exclude?: string): void {
    const msg: ServerMsg = { channel, type: 'app', payload }
    if (exclude) this.broadcastExcept(exclude, msg)
    else this.broadcastAll(msg)
  }

  sendApp(clientId: string, channel: string, payload: unknown): void {
    this.sendTo(clientId, { channel, type: 'app', payload })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
    for (const doc of this.docs.values()) doc.bridge.dispose()
    this.docs.clear()
    for (const [, refMap] of this.refBridges) {
      for (const bridge of refMap.values()) bridge.dispose()
    }
    this.refBridges.clear()
    for (const client of this.clients.values()) {
      client.unsubMessage(); client.unsubClose(); client.transport.close()
    }
    this.clients.clear()
    this.appChannels.clear()
    this.onEmpty?.()
  }

  // ── Internal: doc setup ───────────────────────────────────────────────

  private createDoc(key: string, docConfig: RoomDocConfig): void {
    const bridge = new SanityBridge({
      instance: this.instance,
      resource: this.resource,
      docId: docConfig.docId,
      documentType: docConfig.mapping.documentType,
      onChange: (rawDoc) => this.handleSanityChange(key, rawDoc),
    })

    this.docs.set(key, {
      bridge,
      mapping: docConfig.mapping,
      state: docConfig.initialState,
      ownTxns: new Set(),
    })
  }

  /**
   * Called when the SDK emits a raw doc change (our own write echo OR external edit).
   * Maps the raw doc to domain state, compares with current state, broadcasts if different.
   */
  private handleSanityChange(key: string, rawDoc: Record<string, unknown>): void {
    const doc = this.docs.get(key)
    if (!doc) return

    // Skip our own write echoes — we know all our transaction IDs
    const rev = rawDoc._rev as string | undefined
    if (rev && doc.ownTxns.has(rev)) {
      // Our own write — don't touch domain state, don't create ref subscriptions
      // (ref bridges are created when the server confirms, via a later non-own echo)
      return
    }

    // Update ref subscriptions
    if (doc.mapping.resolveRefs) {
      this.updateRefs(key, doc.mapping, rawDoc)
    }

    // Map to domain state (with refs if available)
    const mapped = doc.mapping.fromSanityWithRefs
      ? doc.mapping.fromSanityWithRefs(rawDoc, this.getRefDocStates(key))
      : doc.mapping.fromSanity(rawDoc)

    // Compare with current state — skip if unchanged
    const reconciled = immutableReconcile(doc.state, mapped)
    if (reconciled === doc.state) return

    // External change — update state and broadcast
    doc.state = reconciled
    this.broadcastAll({ channel: docChannel(key), type: 'state', state: reconciled })
  }

  // ── Internal: ref following ───────────────────────────────────────────

  private updateRefs(
    parentKey: string,
    mapping: DocumentMapping<unknown>,
    rawDoc: Record<string, unknown>,
  ): void {
    if (!mapping.resolveRefs) return
    if (this.updatingRefs.has(parentKey)) return
    this.updatingRefs.add(parentKey)
    const desired = mapping.resolveRefs(rawDoc)
    const desiredKeys = new Map(desired.map((r) => [r.key, r]))

    let current = this.refBridges.get(parentKey)
    if (!current) {
      current = new Map()
      this.refBridges.set(parentKey, current)
    }

    for (const [refKey, bridge] of current) {
      if (!desiredKeys.has(refKey)) { bridge.dispose(); current.delete(refKey) }
    }

    for (const [refKey, desc] of desiredKeys) {
      if (!current.has(refKey)) {
        const refBridge = new SanityBridge({
          instance: this.instance,
          resource: this.resource,
          docId: desc.docId,
          documentType: desc.mapping.documentType,
          onChange: (_refDoc) => {
            // Ref doc changed — re-assemble parent state
            this.handleSanityChange(parentKey, this.docs.get(parentKey)?.bridge.getRawDoc() ?? {})
          },
        })
        current.set(refKey, refBridge)
      }
    }
    this.updatingRefs.delete(parentKey)
  }

  private getRefDocStates(parentKey: string): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>()
    const refMap = this.refBridges.get(parentKey)
    if (refMap) {
      for (const [refKey, bridge] of refMap) {
        const raw = bridge.getRawDoc()
        if (raw && Object.keys(raw).length > 0) result.set(refKey, raw)
      }
    }
    return result
  }

  /** Build ref doc write descriptors from toSanityPatch output. */
  private buildRefDocWrites(
    patch: Record<string, unknown>,
    mapping: DocumentMapping<unknown>,
    refPatches?: Record<string, Record<string, unknown>>,
  ): Array<{ docId: string; documentType: string; content: Record<string, unknown> }> | undefined {
    if (!refPatches || !mapping.resolveRefs) return undefined
    const refs = mapping.resolveRefs(patch)
    const refMap = new Map(refs.map(r => [r.key, r]))
    const writes: Array<{ docId: string; documentType: string; content: Record<string, unknown> }> = []
    for (const [refKey, content] of Object.entries(refPatches)) {
      const desc = refMap.get(refKey)
      if (desc) {
        writes.push({ docId: desc.docId, documentType: desc.mapping.documentType, content })
      }
    }
    return writes.length > 0 ? writes : undefined
  }

  // ── Internal: client messages ─────────────────────────────────────────

  private handleClientMsg(clientId: string, msg: ClientMsg): void {
    const parsed = parseChannel(msg.channel)

    if (parsed.type === 'app' || msg.type === 'app') {
      const channelName = parsed.type === 'app' ? parsed.id : msg.channel
      const handler = this.appChannels.get(channelName)
      if (handler && msg.type === 'app') handler.onMessage(clientId, msg.payload, this)
      return
    }

    if (parsed.type === 'doc' && msg.type === 'mutate') {
      const doc = this.docs.get(parsed.id)
      if (!doc) {
        this.sendTo(clientId, { channel: msg.channel, type: 'reject', mutationId: msg.mutationId, reason: `Unknown document: ${parsed.id}` })
        return
      }

      const result = doc.mapping.applyMutation(doc.state, msg.mutation)
      if (result === null) {
        this.sendTo(clientId, { channel: msg.channel, type: 'reject', mutationId: msg.mutationId, reason: 'Mutation returned null' })
        return
      }

      doc.state = result

      // Write to Sanity — generate txnId BEFORE write so echo suppression works
      const { patch, refPatches } = doc.mapping.toSanityPatch(result)
      const refDocs = this.buildRefDocWrites(patch as Record<string, unknown>, doc.mapping, refPatches)
      const txnId = crypto.randomUUID()
      doc.ownTxns.add(txnId)
      doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId)

      // Broadcast to OTHER clients, ack to sender
      this.broadcastExcept(clientId, { channel: msg.channel, type: 'state', state: result })
      this.sendTo(clientId, { channel: msg.channel, type: 'ack', mutationId: msg.mutationId })
    }
  }

  // ── Internal: transport ───────────────────────────────────────────────

  private sendTo(clientId: string, msg: ServerMsg): void {
    this.clients.get(clientId)?.transport.send(msg)
  }

  private broadcastAll(msg: ServerMsg): void {
    for (const client of this.clients.values()) client.transport.send(msg)
  }

  private broadcastExcept(excludeClientId: string, msg: ServerMsg): void {
    for (const [id, client] of this.clients) {
      if (id !== excludeClientId) client.transport.send(msg)
    }
  }
}
