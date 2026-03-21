/**
 * SyncClient — transport-agnostic optimistic document store.
 *
 * Manages multiple documents, each with independent optimistic state.
 * Mutations are applied locally immediately, sent to the server debounced,
 * and reconciled when the server confirms or rejects.
 */

import type { Transport } from '../transport'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isServerMsg } from '../protocol'
import { docChannel, parseChannel } from '../channel'
import { type DebouncedFlusher, createFlusher, clearFlusher, scheduleFlusher } from '../debounce'
import { MutationQueue } from './mutation-queue'

export interface DocConfig {
  initialState: unknown
  applyMutation: (state: unknown, mutation: Mutation) => unknown | null
  reconcile?: (prev: unknown, next: unknown) => unknown
}

export interface SyncClientOptions {
  transport: Transport
  documents: Record<string, DocConfig>
  sendDebounce?: { ms: number; maxWaitMs: number }
}

interface DocState {
  serverState: unknown
  localState: unknown
  queue: MutationQueue
  config: DocConfig
  listeners: Set<() => void>
}

type StatusListener = (status: 'connected' | 'disconnected') => void
type AppHandler = (payload: unknown) => void

let nextMutationId = 0
function generateMutationId(): string {
  return `m_${++nextMutationId}_${Date.now()}`
}

export class SyncClient {
  private docs = new Map<string, DocState>()
  private transport: Transport
  private unsubMessage: (() => void) | null = null
  private unsubClose: (() => void) | null = null
  private statusListeners = new Set<StatusListener>()
  private appHandlers = new Map<string, Set<AppHandler>>()
  private _status: 'connected' | 'disconnected' = 'connected'
  private flusher: DebouncedFlusher = createFlusher()
  private pendingSends: ClientMsg[] = []
  private debounceMs: number
  private maxWaitMs: number
  private disposed = false

  constructor(options: SyncClientOptions) {
    this.transport = options.transport
    this.debounceMs = options.sendDebounce?.ms ?? 500
    this.maxWaitMs = options.sendDebounce?.maxWaitMs ?? 1000

    for (const [docId, config] of Object.entries(options.documents)) {
      this.docs.set(docId, {
        serverState: config.initialState,
        localState: config.initialState,
        queue: new MutationQueue(),
        config,
        listeners: new Set(),
      })
    }

    this.unsubMessage = this.transport.onMessage((raw) => {
      if (isServerMsg(raw)) this.handleServerMsg(raw)
    })
    this.unsubClose = this.transport.onClose(() => {
      this._status = 'disconnected'
      for (const listener of this.statusListeners) listener('disconnected')
    })
  }

  // ── Document state ──────────────────────────────────────────────────────

  getDocState<T = unknown>(docId: string): T {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    return doc.localState as T
  }

  subscribeDoc(docId: string, listener: () => void): () => void {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    doc.listeners.add(listener)
    return () => { doc.listeners.delete(listener) }
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  mutate(docId: string, mutation: Mutation): void {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)

    const mutationId = generateMutationId()
    doc.queue.enqueue(mutationId, mutation)
    this.recomputeLocal(doc)

    const msg: ClientMsg = {
      channel: docChannel(docId),
      type: 'mutate',
      mutationId,
      mutation,
    }
    // For replace mutations, drop previous pending replaces for the same doc
    // (only the latest full state matters)
    if (mutation.kind === 'replace') {
      const channel = docChannel(docId)
      this.pendingSends = this.pendingSends.filter(
        (m) => !(m.type === 'mutate' && m.channel === channel && m.mutation.kind === 'replace'),
      )
    }
    this.pendingSends.push(msg)
    scheduleFlusher(this.flusher, () => this.flush(), this.debounceMs, this.maxWaitMs)
  }

  // ── App channels ────────────────────────────────────────────────────────

  sendApp(channel: string, payload: unknown): void {
    this.transport.send({ channel, type: 'app', payload } satisfies ClientMsg)
  }

  onApp(channel: string, handler: AppHandler): () => void {
    let handlers = this.appHandlers.get(channel)
    if (!handlers) {
      handlers = new Set()
      this.appHandlers.set(channel, handlers)
    }
    handlers.add(handler)
    return () => { handlers!.delete(handler) }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  get status(): 'connected' | 'disconnected' {
    return this._status
  }

  onStatus(handler: StatusListener): () => void {
    this.statusListeners.add(handler)
    return () => { this.statusListeners.delete(handler) }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearFlusher(this.flusher)
    this.unsubMessage?.()
    this.unsubClose?.()
    this.transport.close()
    this.docs.clear()
    this.statusListeners.clear()
    this.appHandlers.clear()
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private handleServerMsg(msg: ServerMsg): void {
    if (msg.type === 'error') return // App can handle via onApp or ignore

    if (!('channel' in msg)) return
    const parsed = parseChannel(msg.channel)

    if (parsed.type === 'app') {
      const handlers = this.appHandlers.get(parsed.id)
      if (handlers) {
        for (const handler of handlers) handler((msg as { payload: unknown }).payload)
      }
      return
    }

    if (parsed.type !== 'doc') return
    const doc = this.docs.get(parsed.id)
    if (!doc) return

    switch (msg.type) {
      case 'state': {
        const newState = msg.state
        doc.serverState = newState
        this.recomputeLocal(doc)
        // Mark connected on first state message after reconnect
        if (this._status === 'disconnected') {
          this._status = 'connected'
          for (const listener of this.statusListeners) listener('connected')
        }
        break
      }
      case 'ack': {
        doc.queue.ack(msg.mutationId)
        // No recompute needed — local state already includes this mutation
        break
      }
      case 'reject': {
        doc.queue.reject(msg.mutationId)
        this.recomputeLocal(doc)
        break
      }
    }
  }

  private recomputeLocal(doc: DocState): void {
    const prev = doc.localState
    let next = doc.queue.rebase(doc.serverState, doc.config.applyMutation)
    if (doc.config.reconcile) {
      next = doc.config.reconcile(prev, next)
    }
    doc.localState = next
    for (const listener of doc.listeners) listener()
  }

  private flush(): void {
    const msgs = this.pendingSends.splice(0)
    for (const msg of msgs) {
      this.transport.send(msg)
    }
  }
}
