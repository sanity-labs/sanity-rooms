/**
 * SyncClient — transport-agnostic optimistic document store.
 *
 * For replace mutations (full-state updates from the UI), the client keeps
 * localState as the optimistic truth and diffs at flush time using
 * @sanity/diff-patch. This produces granular Sanity-native patches that
 * compose correctly during concurrent edits (user + AI, multiple clients).
 *
 * Named mutations (intent-based, e.g. AI tool calls) still go through the
 * traditional mutation queue with ack/reject handling.
 */

import { diffValue } from '@sanity/diff-patch'
import type { Transport } from '../transport'
import { applySanityPatches } from '../apply-patches'
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
  /** What the server last confirmed — diffs are computed against this at flush time. */
  lastSentState: unknown
  /** Queue for named mutations only (AI tool calls). Replace mutations bypass the queue. */
  queue: MutationQueue
  config: DocConfig
  listeners: Set<() => void>
  /** Whether localState has unsent changes (replace mutations not yet flushed). */
  dirty: boolean
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
        lastSentState: config.initialState,
        queue: new MutationQueue(),
        config,
        listeners: new Set(),
        dirty: false,
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

    if (mutation.kind === 'replace') {
      // Replace: update local state directly, diff at flush time
      const prev = doc.localState
      doc.localState = mutation.state
      doc.dirty = true
      if (doc.config.reconcile) {
        doc.localState = doc.config.reconcile(prev, doc.localState)
      }
      for (const listener of doc.listeners) listener()
      scheduleFlusher(this.flusher, () => this.flush(), this.debounceMs, this.maxWaitMs)
      return
    }

    // Named/other mutations: go through the queue (existing behavior)
    const mutationId = generateMutationId()
    doc.queue.enqueue(mutationId, mutation)
    this.recomputeLocal(doc)

    this.pendingSends.push({
      channel: docChannel(docId),
      type: 'mutate',
      mutationId,
      mutation,
    })
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
    if (msg.type === 'error') return

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
        const received = msg.state

        if (this._status === 'disconnected') {
          // Reconnect: full reset — accept server state, discard unsent local edits
          doc.serverState = received
          doc.localState = received
          doc.lastSentState = received
          doc.dirty = false
          doc.queue.clear()
          this.pendingSends = this.pendingSends.filter(
            (m) => !(m.type === 'mutate' && m.channel === docChannel(parsed.id)),
          )
          this._status = 'connected'
          for (const listener of this.statusListeners) listener('connected')
        } else if (doc.dirty) {
          // Connected + dirty: reapply unsent local changes on top of fresh server state
          doc.serverState = received
          const localChanges = diffValue(doc.lastSentState, doc.localState)
          if (localChanges.length > 0) {
            doc.localState = applySanityPatches(received, localChanges)
          } else {
            doc.localState = received
            doc.dirty = false
          }
          doc.lastSentState = received
        } else {
          // Connected + clean: accept server state
          doc.serverState = received
          doc.localState = received
          doc.lastSentState = received
        }

        // Recompute with any queued named mutations on top
        if (doc.queue.hasPending()) {
          this.recomputeLocal(doc)
        } else {
          for (const listener of doc.listeners) listener()
        }
        break
      }
      case 'ack': {
        doc.queue.ack(msg.mutationId)
        break
      }
      case 'reject': {
        doc.queue.reject(msg.mutationId)
        this.recomputeLocal(doc)
        break
      }
    }
  }

  /** Recompute local state by replaying queued named mutations on server state. */
  private recomputeLocal(doc: DocState): void {
    const prev = doc.localState
    let next = doc.queue.rebase(doc.serverState, doc.config.applyMutation)
    if (doc.config.reconcile) {
      next = doc.config.reconcile(prev, next)
    }
    doc.localState = next
    for (const listener of doc.listeners) listener()
  }

  /** Flush pending sends + diff dirty docs. */
  private flush(): void {
    // Diff dirty docs and produce sanityPatch mutations
    for (const [docId, doc] of this.docs) {
      if (!doc.dirty) continue

      const operations = diffValue(doc.lastSentState, doc.localState)
      if (operations.length === 0) {
        doc.dirty = false
        continue
      }

      const mutationId = generateMutationId()
      this.pendingSends.push({
        channel: docChannel(docId),
        type: 'mutate',
        mutationId,
        mutation: { kind: 'sanityPatch', operations },
      })
      doc.lastSentState = doc.localState
      doc.dirty = false
    }

    // Send all pending messages
    const msgs = this.pendingSends.splice(0)
    for (const msg of msgs) {
      this.transport.send(msg)
    }
  }
}
