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

import {
  applyDocumentActions,
  createDocumentHandle,
  type DocumentAction,
  publishDocument,
  type SanityInstance,
} from '@sanity/sdk'
import { applySanityPatches } from '../apply-patches'
import { docChannel, parseChannel } from '../channel'
import { consoleLogger, type Logger } from '../logger'
import type { DocumentMapping } from '../mapping'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isClientMsg } from '../protocol'
import { immutableReconcile } from '../reconcile'
import type { ServerTransport } from '../transport'
import { SanityBridge, type SanityResource } from './sanity-bridge'

// ── Types ─────────────────────────────────────────────────────────────────

export interface RoomDocConfig {
  docId: string
  mapping: DocumentMapping<unknown>
}

export interface RoomConfig {
  documents: Record<string, RoomDocConfig>
  gracePeriodMs?: number
  /** Custom logger. Defaults to console. */
  logger?: Logger
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
  /** Transaction IDs of our own writes — skip echoes with matching _rev.
   *  Map<txnId, timestamp> — entries older than 60s are pruned on each write. */
  ownTxns: Map<string, number>
  /** Called after state changes — resolves the ready promise when fully hydrated. */
  onHydrated?: () => void
}

// ── Room ──────────────────────────────────────────────────────────────────

export class Room {
  private clients = new Map<string, ClientInfo>()
  private docs = new Map<string, DocEntry>()
  private appChannels = new Map<string, AppChannelHandler>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private gracePeriodMs: number
  private disposed = false
  private holdCount = 0
  private instance: SanityInstance
  private resource: SanityResource
  private logger: Logger

  // Ref-following: ref bridges per parent doc key
  private refBridges = new Map<string, Map<string, SanityBridge>>()
  private updatingRefs = new Set<string>()

  /** Resolves when all doc bridges have received their first state from the SDK. */
  // biome-ignore lint/suspicious/noConfusingVoidType: standard Promise.all return type
  readonly ready: Promise<void[]>

  private onDisposeListeners: Array<() => void> = []
  private onMutationListeners: Array<(docKey: string) => void> = []

  constructor(config: RoomConfig, instance: SanityInstance, resource: SanityResource) {
    this.instance = instance
    this.resource = resource
    this.gracePeriodMs = config.gracePeriodMs ?? 30_000
    this.logger = config.logger ?? consoleLogger

    const readyPromises: Promise<void>[] = []
    for (const [key, docConfig] of Object.entries(config.documents)) {
      readyPromises.push(this.createDoc(key, docConfig))
    }
    this.ready = Promise.all(readyPromises)
  }

  // ── Client management ─────────────────────────────────────────────────

  /** Add a client connection. Sends current state once hydrated. Returns the client ID. */
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

    // Wait for all doc bridges to load before sending state — otherwise
    // the client receives null/empty state and overwrites its good initial data.
    this.ready.then(() => {
      // Client may have disconnected while we were waiting
      if (!this.clients.has(clientId)) return

      for (const [key, doc] of this.docs) {
        this.sendTo(clientId, { channel: docChannel(key), type: 'state', state: doc.state })
      }

      for (const handler of this.appChannels.values()) {
        handler.onClientJoin?.(clientId, this)
      }
    })
    return clientId
  }

  /** Remove a client connection. Starts the grace-period timer if no clients remain. */
  removeClient(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    client.unsubMessage()
    client.unsubClose()
    this.clients.delete(clientId)
    for (const handler of this.appChannels.values()) {
      handler.onClientLeave?.(clientId, this)
    }
    this.maybeStartGraceTimer()
  }

  get clientCount(): number {
    return this.clients.size
  }

  /**
   * Prevent the room from being reclaimed. Each hold() must be paired with
   * a release(). While held, the grace-period timer will not start even if
   * all clients disconnect.
   */
  /**
   * Register a callback that fires when the room is disposed.
   * Multiple listeners are supported — all fire in registration order.
   */
  onDispose(cb: () => void): void {
    this.onDisposeListeners.push(cb)
  }

  /** Register a callback that fires after any document mutation (from clients or mutateDoc). */
  onMutation(cb: (docKey: string) => void): void {
    this.onMutationListeners.push(cb)
  }

  hold(): void {
    this.holdCount++
  }

  /**
   * Release a previous hold(). If no clients remain and no holds are active,
   * the grace-period timer starts.
   */
  release(): void {
    this.holdCount = Math.max(0, this.holdCount - 1)
    this.maybeStartGraceTimer()
  }

  private maybeStartGraceTimer(): void {
    if (this.clients.size === 0 && this.holdCount === 0) {
      this.graceTimer = setTimeout(() => {
        if (this.clients.size === 0 && this.holdCount === 0) this.dispose()
      }, this.gracePeriodMs)
    }
  }

  // ── Domain state access ───────────────────────────────────────────────

  /** Get the Sanity document ID for a doc key (stripped of drafts. prefix). */
  getDocId(docKey: string): string {
    const doc = this.docs.get(docKey)
    if (!doc) throw new Error(`Unknown document key: ${docKey}`)
    return doc.bridge.docId
  }

  /** Get the current domain state for a document key. Throws if unknown. */
  getDocState<T = unknown>(docKey: string): T {
    const doc = this.docs.get(docKey)
    if (doc) return doc.state as T
    throw new Error(`Unknown document key: ${docKey}`)
  }

  /** Apply a mutation to a document. Writes to Sanity and broadcasts to all clients. */
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
    this.recordOwnTxn(doc, txnId)
    doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId)

    // Broadcast domain state to all clients
    this.broadcastAll({ channel: docChannel(docKey), type: 'state', state: result })

    // Notify mutation listeners
    for (const cb of this.onMutationListeners) cb(docKey)
  }

  // ── Publish ─────────────────────────────────────────────────────────

  /**
   * Publish a document and all its referenced documents to make them
   * publicly available (published perspective).
   *
   * Ref docs are published first so that the main doc's weak references
   * can be strengthened on publish (Sanity requires published targets).
   */
  async publish(docKey: string): Promise<{ success: boolean; error?: string }> {
    const doc = this.docs.get(docKey)
    if (!doc) return { success: false, error: `Unknown document key: ${docKey}` }

    const actions: DocumentAction[] = []

    // 1. Publish ref docs first — but only those that actually have a draft.
    // Real SDK throws "no draft version was found" if a doc has no draft to
    // publish, which aborts the whole transaction. Ref docs that haven't been
    // edited this session (or any session since last publish) have no draft;
    // skip them silently — there's nothing to publish.
    const refMap = this.refBridges.get(docKey)
    if (refMap) {
      for (const refBridge of refMap.values()) {
        if (!refBridge.hasDraft()) continue
        actions.push(
          publishDocument(
            createDocumentHandle({
              documentId: refBridge.docId,
              documentType: refBridge.documentType,
              ...this.resource,
            }),
          ),
        )
      }
    }

    // 2. Publish main doc — same guard. If the user clicks publish without
    // having edited (or after the draft was already published), there's
    // nothing to do; succeed idempotently.
    if (doc.bridge.hasDraft()) {
      actions.push(
        publishDocument(
          createDocumentHandle({
            documentId: doc.bridge.docId,
            documentType: doc.bridge.documentType,
            ...this.resource,
          }),
        ),
      )
    }

    // Nothing to publish — all docs are already at parity with their published
    // versions. Treat as success: the published state is what the user wants.
    if (actions.length === 0) return { success: true }

    try {
      const result = await applyDocumentActions(this.instance, { actions })
      await result.submitted()
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`[room] publish failed for ${docKey}:`, message)
      return { success: false, error: message }
    }
  }

  // ── App channels ──────────────────────────────────────────────────────

  /** Register a named app channel (e.g. 'chat', 'publish', 'presence'). */
  registerAppChannel(name: string, handler: AppChannelHandler): void {
    this.appChannels.set(name, handler)
  }

  /** Broadcast a payload to all clients on an app channel. Optionally exclude one client. */
  broadcastApp(channel: string, payload: unknown, exclude?: string): void {
    const msg: ServerMsg = { channel, type: 'app', payload }
    if (exclude) this.broadcastExcept(exclude, msg)
    else this.broadcastAll(msg)
  }

  /** Send a payload to one specific client on an app channel. */
  sendApp(clientId: string, channel: string, payload: unknown): void {
    this.sendTo(clientId, { channel, type: 'app', payload })
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    for (const doc of this.docs.values()) {
      doc.bridge.dispose()
      doc.ownTxns.clear()
    }
    this.docs.clear()
    for (const [, refMap] of this.refBridges) {
      for (const bridge of refMap.values()) bridge.dispose()
    }
    this.refBridges.clear()
    for (const client of this.clients.values()) {
      client.unsubMessage()
      client.unsubClose()
      client.transport.close()
    }
    this.clients.clear()
    this.appChannels.clear()
    for (const cb of this.onDisposeListeners) cb()
    this.onDisposeListeners.length = 0
  }

  /** Record a write transaction ID and prune entries older than 60s. */
  private recordOwnTxn(doc: DocEntry, txnId: string): void {
    const now = Date.now()
    doc.ownTxns.set(txnId, now)
    // Prune stale entries (60s is well beyond SDK write throttle + network round trip)
    if (doc.ownTxns.size > 50) {
      const cutoff = now - 60_000
      for (const [id, ts] of doc.ownTxns) {
        if (ts < cutoff) doc.ownTxns.delete(id)
      }
    }
  }

  // ── Internal: doc setup ───────────────────────────────────────────────

  private createDoc(key: string, docConfig: RoomDocConfig): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false
      const tryResolve = () => {
        if (resolved) return
        const doc = this.docs.get(key)
        if (!doc || doc.state === null) return
        // If this doc has refs, wait until ref bridges have emitted too
        const refMap = this.refBridges.get(key)
        if (docConfig.mapping.resolveRefs && refMap && refMap.size > 0) {
          for (const refBridge of refMap.values()) {
            if (Object.keys(refBridge.getRawDoc()).length === 0) return // ref not loaded yet
          }
        }
        resolved = true
        resolve()
      }

      const bridge = new SanityBridge({
        instance: this.instance,
        resource: this.resource,
        docId: docConfig.docId,
        documentType: docConfig.mapping.documentType,
        logger: this.logger,
        onChange: (rawDoc) => {
          this.handleSanityChange(key, rawDoc)
          tryResolve()
        },
      })

      this.docs.set(key, {
        bridge,
        onHydrated: tryResolve,
        mapping: docConfig.mapping,
        state: null,
        ownTxns: new Map(),
      })
    })
  }

  /**
   * Called when the SDK emits a raw doc change (our own write echo OR external edit).
   * Maps the raw doc to domain state, compares with current state, broadcasts if different.
   *
   * If ref bridges exist but haven't loaded yet, defers mapping — broadcasting
   * with incomplete refs would strip custom resources from the domain state.
   */
  private handleSanityChange(key: string, rawDoc: Record<string, unknown>): void {
    const doc = this.docs.get(key)
    if (!doc) return

    // Skip our own write echoes — we know all our transaction IDs
    const rev = rawDoc._rev as string | undefined
    if (rev && doc.ownTxns.has(rev) /* don't delete — SDK may emit same _rev multiple times */) {
      return
    }

    // Update ref subscriptions
    if (doc.mapping.resolveRefs) {
      this.updateRefs(key, doc.mapping, rawDoc)
    }

    // If any ref bridges haven't loaded yet, defer — mapping with incomplete
    // refs would produce state missing custom resources. The ref bridge's
    // onChange will re-trigger this method once it loads.
    if (this.hasUnloadedRefs(key)) return

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

    // Check if fully hydrated (for ready promise)
    doc.onHydrated?.()
  }

  // ── Internal: ref following ───────────────────────────────────────────

  private updateRefs(parentKey: string, mapping: DocumentMapping<unknown>, rawDoc: Record<string, unknown>): void {
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
      if (!desiredKeys.has(refKey)) {
        bridge.dispose()
        current.delete(refKey)
      }
    }

    for (const [refKey, desc] of desiredKeys) {
      if (!current.has(refKey)) {
        const parentDoc = this.docs.get(parentKey)
        const refBridge = new SanityBridge({
          instance: this.instance,
          resource: this.resource,
          docId: desc.docId,
          documentType: desc.mapping.documentType,
          logger: this.logger,
          onChange: (_refDoc) => {
            // Ref doc loaded — tell the parent bridge it exists (so writes use edit, not create)
            parentDoc?.bridge.markRefDocKnown(desc.docId)
            // Re-assemble parent state with the now-loaded ref
            this.handleSanityChange(parentKey, this.docs.get(parentKey)?.bridge.getRawDoc() ?? {})
          },
        })
        current.set(refKey, refBridge)
      }
    }
    this.updatingRefs.delete(parentKey)
  }

  /** True if any ref bridge for this parent hasn't emitted its first state yet. */
  private hasUnloadedRefs(parentKey: string): boolean {
    const refMap = this.refBridges.get(parentKey)
    if (!refMap) return false
    for (const bridge of refMap.values()) {
      if (Object.keys(bridge.getRawDoc()).length === 0) return true
    }
    return false
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
    const refMap = new Map(refs.map((r) => [r.key, r]))
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
    if (this.disposed) return
    const parsed = parseChannel(msg.channel)

    if (parsed.type === 'app' || msg.type === 'app') {
      const channelName = parsed.type === 'app' ? parsed.id : msg.channel
      const handler = this.appChannels.get(channelName)
      if (handler && msg.type === 'app') {
        try {
          handler.onMessage(clientId, msg.payload, this)
        } catch (err: unknown) {
          this.logger.error(`[room] app channel "${channelName}" handler error:`, err)
        }
      }
      return
    }

    if (parsed.type === 'doc' && msg.type === 'mutate') {
      const doc = this.docs.get(parsed.id)
      if (!doc) {
        this.sendTo(clientId, {
          channel: msg.channel,
          type: 'reject',
          mutationId: msg.mutationId,
          reason: `Unknown document: ${parsed.id}`,
        })
        return
      }

      let result: unknown

      if (msg.mutation.kind === 'sanityPatch') {
        // Sanity-native patches: apply using @sanity/mutator
        result = applySanityPatches(doc.state, msg.mutation.operations)
      } else {
        result = doc.mapping.applyMutation(doc.state, msg.mutation)
      }

      if (result === null) {
        this.sendTo(clientId, {
          channel: msg.channel,
          type: 'reject',
          mutationId: msg.mutationId,
          reason: 'Mutation returned null',
        })
        return
      }

      doc.state = result

      // Write to Sanity — always use toSanityPatch so ref docs
      // (custom fonts/palettes/backgrounds) are written alongside the main doc
      const txnId = crypto.randomUUID()
      this.recordOwnTxn(doc, txnId)
      const { patch, refPatches } = doc.mapping.toSanityPatch(result)
      const refDocs = this.buildRefDocWrites(patch as Record<string, unknown>, doc.mapping, refPatches)
      doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId)

      // Broadcast to OTHER clients, ack to sender
      this.broadcastExcept(clientId, { channel: msg.channel, type: 'state', state: result })
      this.sendTo(clientId, { channel: msg.channel, type: 'ack', mutationId: msg.mutationId })

      // Notify mutation listeners
      for (const cb of this.onMutationListeners) cb(parsed.id)
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
