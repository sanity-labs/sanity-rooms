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
 *
 * Hydration: when `initialState` is omitted, the doc starts unhydrated.
 * The `ready` promise resolves once all docs receive their first `state`
 * message from the server. Mutations are blocked until hydration completes.
 */

import { diffValue } from '@sanity/diff-patch'
import { applySanityPatches } from '../apply-patches'
import { docChannel, parseChannel } from '../channel'
import { clearFlusher, createFlusher, type DebouncedFlusher, scheduleFlusher } from '../debounce'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isServerMsg } from '../protocol'
import type { Transport } from '../transport'
import { MutationQueue } from './mutation-queue'

const UNHYDRATED = Symbol('unhydrated')

export interface DocConfig {
  /** Initial state. Omit to wait for the server's first `state` message. */
  initialState?: unknown
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
  /** Whether this doc has received its initial state (from constructor or server). */
  hydrated: boolean
}

/**
 * - `connecting` — initial state, or transport dialling after a close.
 * - `connected`  — transport open AND at least one doc hydrated since
 *                  the last open.
 * - `disconnected` — transport closed; auto-reconnect (if any) will
 *                    bring us back to `connecting`.
 */
export type SyncClientStatus = 'connecting' | 'connected' | 'disconnected'

type StatusListener = (status: SyncClientStatus) => void
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
  private _status: SyncClientStatus = 'connecting'
  private flusher: DebouncedFlusher = createFlusher()
  private pendingSends: ClientMsg[] = []
  private debounceMs: number
  private maxWaitMs: number
  private disposed = false
  private _resolveReady: (() => void) | null = null
  private _rejectReady: ((err: Error) => void) | null = null
  private unsubOpen: (() => void) | null = null

  /** Resolves when all docs have received their initial state. Rejects
   *  if the transport closes before the first hydration so callers can
   *  surface an honest error UI instead of awaiting forever. */
  readonly ready: Promise<void>

  constructor(options: SyncClientOptions) {
    this.transport = options.transport
    this.debounceMs = options.sendDebounce?.ms ?? 500
    this.maxWaitMs = options.sendDebounce?.maxWaitMs ?? 1000

    for (const [docId, config] of Object.entries(options.documents)) {
      const hasInitial = config.initialState !== undefined
      this.docs.set(docId, {
        serverState: hasInitial ? config.initialState : UNHYDRATED,
        localState: hasInitial ? config.initialState : UNHYDRATED,
        lastSentState: hasInitial ? config.initialState : UNHYDRATED,
        queue: new MutationQueue(),
        config,
        listeners: new Set(),
        dirty: false,
        hydrated: hasInitial,
      })
    }

    if ([...this.docs.values()].every((d) => d.hydrated)) {
      this.ready = Promise.resolve()
      this._status = 'connected'
    } else {
      this.ready = new Promise((resolve, reject) => {
        this._resolveReady = resolve
        this._rejectReady = reject
      })
      this.ready.catch(() => {})
    }

    this.unsubMessage = this.transport.onMessage((raw) => {
      if (isServerMsg(raw)) this.handleServerMsg(raw)
    })
    this.unsubClose = this.transport.onClose(() => {
      if (this._rejectReady) {
        const reject = this._rejectReady
        this._resolveReady = null
        this._rejectReady = null
        reject(new Error('Transport closed before initial hydration'))
      }
      this._setStatus('disconnected')
    })
    if (this.transport.onOpen) {
      this.unsubOpen = this.transport.onOpen(() => {
        if (this._status === 'disconnected') this._setStatus('connecting')
      })
    }
  }

  private _setStatus(next: SyncClientStatus): void {
    if (this._status === next) return
    this._status = next
    for (const listener of this.statusListeners) listener(next)
  }

  // ── Document state ──────────────────────────────────────────────────────

  /** Get the current optimistic state for a document. Throws if disposed, unknown, or not hydrated. */
  getDocState<T = unknown>(docId: string): T {
    if (this.disposed) throw new Error('SyncClient is disposed')
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    if (!doc.hydrated) throw new Error(`Document "${docId}" not hydrated — await client.ready`)
    return doc.localState as T
  }

  /** Subscribe to state changes for a document. Returns an unsubscribe function. */
  subscribeDoc(docId: string, listener: () => void): () => void {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    doc.listeners.add(listener)
    return () => {
      doc.listeners.delete(listener)
    }
  }

  // ── Hydration ─────────────────────────────────────────────────────────

  get isHydrated(): boolean {
    return [...this.docs.values()].every((d) => d.hydrated)
  }

  isDocHydrated(docId: string): boolean {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    return doc.hydrated
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  /**
   * Apply a mutation. For `replace`: updates local state optimistically,
   * diffs at flush time, sends only changed fields. For `named`: queues
   * and sends immediately. Throws if disposed or not hydrated.
   */
  mutate(docId: string, mutation: Mutation): void {
    if (this.disposed) throw new Error('SyncClient is disposed')
    const doc = this.docs.get(docId)
    if (!doc) throw new Error(`Unknown document: ${docId}`)
    if (!doc.hydrated) throw new Error(`Cannot mutate "${docId}" before hydration — await client.ready`)

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

  /** Send a message on an app channel. Throws if disposed. */
  sendApp(channel: string, payload: unknown): void {
    if (this.disposed) throw new Error('SyncClient is disposed')
    this.transport.send({ channel, type: 'app', payload } satisfies ClientMsg)
  }

  /** Listen for messages on an app channel. Returns an unsubscribe function. */
  onApp(channel: string, handler: AppHandler): () => void {
    let handlers = this.appHandlers.get(channel)
    if (!handlers) {
      handlers = new Set()
      this.appHandlers.set(channel, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers!.delete(handler)
    }
  }

  // ── Pending writes ────────────────────────────────────────────────────

  /** True if any document has unsent local changes or queued named mutations. */
  hasPendingWrites(): boolean {
    for (const doc of this.docs.values()) {
      if (doc.dirty || doc.queue.hasPending()) return true
    }
    return this.pendingSends.length > 0
  }

  /** Number of pending sends (dirty doc flushes + queued named mutations). */
  getPendingCount(): number {
    let count = this.pendingSends.length
    for (const doc of this.docs.values()) {
      if (doc.dirty) count++
      count += doc.queue.pendingCount
    }
    return count
  }

  // ── Status ──────────────────────────────────────────────────────────────

  get status(): SyncClientStatus {
    return this._status
  }

  /** Listen for connection status changes. Returns an unsubscribe function. */
  onStatus(handler: StatusListener): () => void {
    this.statusListeners.add(handler)
    return () => {
      this.statusListeners.delete(handler)
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Close the transport and clean up. Subsequent calls to mutate/sendApp/getDocState will throw. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearFlusher(this.flusher)
    this.unsubMessage?.()
    this.unsubClose?.()
    this.unsubOpen?.()
    if (this._rejectReady) {
      const reject = this._rejectReady
      this._resolveReady = null
      this._rejectReady = null
      reject(new Error('SyncClient disposed before initial hydration'))
    }
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

        if (!doc.hydrated) {
          // First state message — hydrate
          doc.serverState = received
          doc.localState = received
          doc.lastSentState = received
          doc.hydrated = true
          for (const listener of doc.listeners) listener()
          if (this._resolveReady && [...this.docs.values()].every((d) => d.hydrated)) {
            const resolve = this._resolveReady
            this._resolveReady = null
            this._rejectReady = null
            resolve()
          }
          this._setStatus('connected')
          break
        }

        if (this._status !== 'connected') {
          // Reconnect: full reset — accept server state, discard unsent local edits
          doc.serverState = received
          doc.localState = received
          doc.lastSentState = received
          doc.dirty = false
          doc.queue.clear()
          this.pendingSends = this.pendingSends.filter(
            (m) => !(m.type === 'mutate' && m.channel === docChannel(parsed.id)),
          )
          this._setStatus('connected')
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
    if (!doc.hydrated) return
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
      if (!doc.hydrated || !doc.dirty) continue

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
