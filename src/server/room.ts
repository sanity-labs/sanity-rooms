/**
 * Room — server-side state hub for one logical resource.
 *
 * Manages N documents (each with a SanityBridge + mapping layer),
 * N connected clients (each with a ServerTransport), and app-defined
 * channels for concerns like chat or presence.
 *
 * Supports dynamic ref-following: when a document's mapping has `resolveRefs`,
 * the Room auto-subscribes to referenced docs and broadcasts their state.
 * All refs share the SDK's single shared listener — zero extra connections.
 */

import type { ServerTransport } from '../transport'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isClientMsg } from '../protocol'
import { docChannel, parseChannel } from '../channel'
import type { DocumentMapping } from '../mapping'
import { SanityBridge, type SdkAdapter } from './sanity-bridge'

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

// ── Room ──────────────────────────────────────────────────────────────────

export class Room {
  private clients = new Map<string, ClientInfo>()
  private bridges = new Map<string, SanityBridge<unknown>>()
  private appChannels = new Map<string, AppChannelHandler>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private gracePeriodMs: number
  private disposed = false
  private adapter: SdkAdapter

  // Ref-following: tracks which ref bridges belong to which parent doc
  private refBridges = new Map<string, Map<string, SanityBridge<unknown>>>() // parentKey → (refKey → bridge)

  onEmpty: (() => void) | null = null

  constructor(config: RoomConfig, adapter: SdkAdapter) {
    this.adapter = adapter
    this.gracePeriodMs = config.gracePeriodMs ?? 30_000

    for (const [key, docConfig] of Object.entries(config.documents)) {
      this.createDocBridge(key, docConfig)
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

    // Send current state for all documents (primary + refs)
    for (const [key, bridge] of this.bridges) {
      this.sendTo(clientId, {
        channel: docChannel(key),
        type: 'state',
        state: bridge.getState(),
      })
    }
    for (const [, refMap] of this.refBridges) {
      for (const [refKey, bridge] of refMap) {
        this.sendTo(clientId, {
          channel: docChannel(refKey),
          type: 'state',
          state: bridge.getState(),
        })
      }
    }

    // Notify app channels
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

    // Notify app channels
    for (const handler of this.appChannels.values()) {
      handler.onClientLeave?.(clientId, this)
    }

    if (this.clients.size === 0) {
      this.graceTimer = setTimeout(() => {
        if (this.clients.size === 0) {
          this.dispose()
        }
      }, this.gracePeriodMs)
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  // ── State access (for app code, e.g. AI tools) ────────────────────────

  getDocState<T = unknown>(docKey: string): T {
    const bridge = this.bridges.get(docKey)
    if (bridge) return bridge.getState() as T
    // Check ref bridges
    for (const [, refMap] of this.refBridges) {
      const refBridge = refMap.get(docKey)
      if (refBridge) return refBridge.getState() as T
    }
    throw new Error(`Unknown document key: ${docKey}`)
  }

  mutateDoc(docKey: string, mutation: Mutation): void {
    const bridge = this.bridges.get(docKey)
    if (!bridge) throw new Error(`Unknown document key: ${docKey}`)

    const result = bridge.applyMutation(mutation)
    if (result !== null) {
      this.broadcastAll({
        channel: docChannel(docKey),
        type: 'state',
        state: result,
      })
    }
  }

  // ── App channels ──────────────────────────────────────────────────────

  registerAppChannel(name: string, handler: AppChannelHandler): void {
    this.appChannels.set(name, handler)
  }

  broadcastApp(channel: string, payload: unknown, exclude?: string): void {
    const msg: ServerMsg = { channel, type: 'app', payload }
    if (exclude) {
      this.broadcastExcept(exclude, msg)
    } else {
      this.broadcastAll(msg)
    }
  }

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

    for (const bridge of this.bridges.values()) {
      bridge.dispose()
    }
    this.bridges.clear()

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
    this.onEmpty?.()
  }

  // ── Internal: bridge creation ─────────────────────────────────────────

  private createDocBridge(key: string, docConfig: RoomDocConfig): void {
    const bridge = new SanityBridge({
      adapter: this.adapter,
      docId: docConfig.docId,
      mapping: docConfig.mapping,
      initialState: docConfig.initialState,
      onStateChange: (state) => {
        this.broadcastAll({
          channel: docChannel(key),
          type: 'state',
          state,
        })
      },
      onRawDoc: docConfig.mapping.resolveRefs
        ? (doc) => this.updateRefs(key, docConfig.mapping, doc)
        : undefined,
    })
    this.bridges.set(key, bridge)
  }

  // ── Internal: ref following ───────────────────────────────────────────

  private updateRefs(
    parentKey: string,
    mapping: DocumentMapping<unknown>,
    rawDoc: Record<string, unknown>,
  ): void {
    if (!mapping.resolveRefs) return

    const desired = mapping.resolveRefs(rawDoc)
    const desiredKeys = new Map(desired.map((r) => [r.key, r]))

    let current = this.refBridges.get(parentKey)
    if (!current) {
      current = new Map()
      this.refBridges.set(parentKey, current)
    }

    // Remove stale refs
    for (const [refKey, bridge] of current) {
      if (!desiredKeys.has(refKey)) {
        bridge.dispose()
        current.delete(refKey)
      }
    }

    // Add new refs
    for (const [refKey, desc] of desiredKeys) {
      if (!current.has(refKey)) {
        const refBridge = new SanityBridge({
          adapter: this.adapter,
          docId: desc.docId,
          mapping: desc.mapping,
          initialState: {},
          onStateChange: (state) => {
            this.broadcastAll({
              channel: docChannel(refKey),
              type: 'state',
              state,
            })
          },
        })
        current.set(refKey, refBridge)
      }
    }
  }

  // ── Internal: message handling ────────────────────────────────────────

  private handleClientMsg(clientId: string, msg: ClientMsg): void {
    console.log(`[room] client ${clientId} msg:`, msg.type, msg.channel)
    const parsed = parseChannel(msg.channel)

    // App channel messages
    if (parsed.type === 'app' || msg.type === 'app') {
      const channelName = parsed.type === 'app' ? parsed.id : msg.channel
      const handler = this.appChannels.get(channelName)
      if (handler && msg.type === 'app') {
        handler.onMessage(clientId, msg.payload, this)
      }
      return
    }

    // Document mutations
    if (parsed.type === 'doc' && msg.type === 'mutate') {
      const bridge = this.bridges.get(parsed.id)
      if (!bridge) {
        this.sendTo(clientId, {
          channel: msg.channel,
          type: 'reject',
          mutationId: msg.mutationId,
          reason: `Unknown document: ${parsed.id}`,
        })
        return
      }

      console.log(`[room] applying mutation to ${parsed.id}:`, msg.mutation.kind)
      const result = bridge.applyMutation(msg.mutation)
      if (result === null) {
        this.sendTo(clientId, {
          channel: msg.channel,
          type: 'reject',
          mutationId: msg.mutationId,
          reason: 'Mutation returned null (invalid)',
        })
        return
      }

      // Broadcast updated state to ALL clients
      this.broadcastAll({
        channel: msg.channel,
        type: 'state',
        state: result,
      })

      // Ack to sender
      this.sendTo(clientId, {
        channel: msg.channel,
        type: 'ack',
        mutationId: msg.mutationId,
      })
    }
  }

  private sendTo(clientId: string, msg: ServerMsg): void {
    const client = this.clients.get(clientId)
    if (client) client.transport.send(msg)
  }

  private broadcastAll(msg: ServerMsg): void {
    for (const client of this.clients.values()) {
      client.transport.send(msg)
    }
  }

  private broadcastExcept(excludeClientId: string, msg: ServerMsg): void {
    for (const [id, client] of this.clients) {
      if (id !== excludeClientId) client.transport.send(msg)
    }
  }
}
