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
  getDocumentState,
  publishDocument,
  type SanityInstance,
} from '@sanity/sdk'
import { firstValueFrom } from 'rxjs'
import { applySanityPatches } from '../apply-patches'
import { docChannel, parseChannel } from '../channel'
import { consoleLogger, type Logger } from '../logger'
import type { Classification, DocumentMapping } from '../mapping'
import type { Mutation } from '../mutation'
import type { ClientMsg, ServerMsg } from '../protocol'
import { isClientMsg } from '../protocol'
import { immutableReconcile } from '../reconcile'
import type { ServerTransport } from '../transport'
import { type RefDocWrite, SanityBridge, type SanityResource } from './sanity-bridge'

// Sentinel client id used for server-originated mutations (e.g. reactions
// channel writes) routed through the pending-mutation queue. Any sendTo
// call against this id resolves to "no client" and is a no-op — exactly
// the fire-and-log behavior server writes have always had, but with the
// added benefit that chain-rot now triggers the same automatic replay
// path that client writes get.
const SERVER_MUTATION_CLIENT_ID = '__server__'

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
  /**
   * Called when any bridge (main or ref) attached to this Room reports
   * chain rot (Sanity SDK chain reconciler DeadlineExceededError). The
   * caller (RoomManager) should dispose the shared `SanityInstance`
   * and re-create it; this Room's `recreateBridges(newInstance)` then
   * brings it back online without losing room state.
   */
  onChainRot?: () => void
  /**
   * F7 metrics: called for every bridge write outcome (committed or
   * rejected, all reasons). The RoomManager subscribes to aggregate
   * counts across all rooms so operators can see rejection-rate
   * trends and alarm before voters lose data.
   */
  onWriteOutcome?: (outcome: import('./sanity-bridge').WriteOutcome) => void
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
  /** Original `docId` used to construct the bridge. Needed to recreate
   *  bridges after a chain-rot recovery without losing track of which
   *  doc each entry maps to. */
  docId: string
  /** Domain state — the Room's authoritative app-level state. */
  state: unknown
  /** Transaction IDs of our own writes — skip echoes with matching _rev.
   *  Map<txnId, timestamp> — entries older than 60s are pruned on each write. */
  ownTxns: Map<string, number>
  /** Self-heal: pending mutations keyed by mutationId. A mutation lives
   *  here from the moment `bridge.write` is called until it resolves
   *  with `committed` or a non-chain-rot rejection. Chain-rot rejections
   *  leave the entry in place; `recreateBridges` walks this map to
   *  replay each mutation through the fresh bridge with a classify-then-act
   *  step. See `self-heal-plan.md`. */
  pendingMutations: Map<string, PendingMutation>
  /** Called after state changes — resolves the ready promise when fully hydrated. */
  onHydrated?: () => void
}

/**
 * Self-heal record. Captured at write time so chain-rot recovery has
 * everything needed to safely replay or rebase.
 */
interface PendingMutation {
  mutationId: string
  clientId: string
  channel: string
  transactionId: string
  /** Domain state at the moment the write was issued — the pre-condition. */
  beforeState: unknown
  /** Domain state the voter intended the doc to reach — the post-condition. */
  afterState: unknown
  /** The Sanity patch the bridge will apply. */
  patch: Record<string, unknown>
  /** Ref-doc writes carried alongside the main patch (group docs only). */
  refDocs?: RefDocWrite[]
  /** Epoch ms — for staleness pruning if a mutation lingers across multiple
   *  recoveries without resolving. Not yet enforced; here for future use. */
  enqueuedAt: number
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
  private onChainRotCallback: (() => void) | null = null
  private onWriteOutcomeCallback: ((outcome: import('./sanity-bridge').WriteOutcome) => void) | null = null

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
    this.onChainRotCallback = config.onChainRot ?? null
    this.onWriteOutcomeCallback = config.onWriteOutcome ?? null

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

    // Self-heal: capture before/after so chain-rot recovery can classify
    // and replay this server-originated write the same way client writes
    // are handled.
    const beforeState = doc.state
    doc.state = result
    const afterState = result

    // Write to Sanity — generate txnId BEFORE write so echo suppression works
    const { patch, refPatches } = doc.mapping.toSanityPatch(result)
    const refDocs = this.buildRefDocWrites(patch as Record<string, unknown>, doc.mapping, refPatches)
    const txnId = crypto.randomUUID()
    this.recordOwnTxn(doc, txnId)

    // Server-side mutations use a synthetic mutationId + sentinel clientId
    // so they ride the same pending-mutation queue as client writes.
    // sendTo() against the sentinel id is a no-op (no client matches), so
    // the resolve path naturally drops the ack/reject — exactly what we
    // want for fire-and-log behavior, except now chain-rot also gets the
    // automatic replay treatment.
    const serverMutationId = `srv-${txnId}`
    doc.pendingMutations.set(serverMutationId, {
      mutationId: serverMutationId,
      clientId: SERVER_MUTATION_CLIENT_ID,
      channel: docChannel(docKey),
      transactionId: txnId,
      beforeState,
      afterState,
      patch: patch as Record<string, unknown>,
      refDocs,
      enqueuedAt: Date.now(),
    })

    doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId).then(
      (outcome) => this.resolvePendingMutation(docKey, serverMutationId, outcome),
      (err) => {
        this.logger.error(
          `[room] bridge.write threw for server-mutation on ${docKey}: ${err?.message ?? err}`,
        )
        this.resolvePendingMutation(docKey, serverMutationId, {
          kind: 'rejected',
          transactionId: txnId,
          reason: 'local',
          message: `bridge.write threw: ${err?.message ?? err}`,
        })
      },
    )

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
    return new Promise((resolve, reject) => {
      let resolved = false
      let rejected = false
      const tryResolve = () => {
        if (resolved || rejected) return
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
        onStall: (reason) => {
          if (resolved || rejected) return
          rejected = true
          reject(new Error(reason))
        },
        onChainRot: () => this.signalChainRot(key),
        onWriteOutcome: (outcome) => this.onWriteOutcomeCallback?.(outcome),
        onChange: (rawDoc) => {
          // Defer one microtask: under Vite SSR the SDK's rxjs Subject
          // can fire a cached value synchronously inside subscribe(),
          // before this.docs.set runs below. queueMicrotask pushes
          // this past that race so handleSanityChange always finds
          // the entry.
          queueMicrotask(() => {
            this.handleSanityChange(key, rawDoc)
            tryResolve()
          })
        },
      })

      this.docs.set(key, {
        bridge,
        onHydrated: tryResolve,
        mapping: docConfig.mapping,
        docId: docConfig.docId,
        state: null,
        ownTxns: new Map(),
        pendingMutations: new Map(),
      })
    })
  }

  /**
   * Called by any bridge attached to this Room (main doc or ref) when
   * it detects chain rot. Forwards to the RoomManager-supplied callback
   * once per Room lifetime — the manager owns the SDK instance and is
   * the only thing that can recreate it.
   */
  private chainRotForwarded = false
  private signalChainRot(docKey: string): void {
    if (this.chainRotForwarded) return
    this.chainRotForwarded = true
    this.logger.error(`[room] CHAIN-ROT signaled by doc '${docKey}' — forwarding to manager`)
    try {
      this.onChainRotCallback?.()
    } catch (err) {
      this.logger.error(`[room] onChainRot handler threw: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * Re-create all doc bridges (and ref bridges) using a NEW SanityInstance,
   * then self-heal: replay every pending mutation through the recreated
   * bridges after verifying each one is safe to replay against fresh
   * server state.
   *
   * Called by RoomManager when chain rot is detected on the shared
   * instance. Preserves in-memory `doc.state` so the room remains
   * authoritative across the swap; the new bridges re-subscribe and
   * deliver fresh state from Sanity, which gets reconciled against
   * `doc.state` via the existing change-emit path.
   *
   * Self-heal flow (the `if doc.pendingMutations.size` block below):
   *   1. Snapshot pending mutations per doc (they sit in `doc.pendingMutations`
   *      from the moment `bridge.write` was called).
   *   2. After new bridges are up, read fresh server state for each doc
   *      via the new instance — bypasses the just-rotted reconciler.
   *   3. For each pending mutation, run `mapping.classify(fresh, before, after, patch)`.
   *      Based on the result: replay through new bridge, ack as idempotent
   *      no-op, or reject with `rebase-needed` + freshServerState so the
   *      client can rebase optimistic state.
   *
   * If `mapping.classify` is undefined, all pending mutations are treated
   * as EQUAL (blind replay) — correct for single-writer docs like
   * `voteRecord`, unsafe for multi-writer docs. Implement classify on
   * any mapping where multiple sources can write.
   */
  async recreateBridges(newInstance: SanityInstance): Promise<void> {
    if (this.disposed) return
    this.logger.warn(`[room] recreateBridges() — swapping SanityInstance for ${this.docs.size} doc(s)`)

    const oldInstance = this.instance
    this.instance = newInstance

    // Snapshot old bridges + their docKeys + docIds
    const snapshot: Array<{ key: string; docId: string; mapping: DocumentMapping<unknown>; oldBridge: SanityBridge }> = []
    for (const [key, doc] of this.docs) {
      snapshot.push({ key, docId: doc.docId, mapping: doc.mapping, oldBridge: doc.bridge })
    }

    // Dispose ref bridges too (they share the same SanityInstance).
    for (const [, refMap] of this.refBridges) {
      for (const refBridge of refMap.values()) refBridge.dispose()
    }
    this.refBridges.clear()

    // Construct new bridges and update each doc entry's `bridge` field.
    // Allow the chain-rot signal to fire again on the new bridges if
    // they too rot (rare, but possible).
    this.chainRotForwarded = false
    for (const { key, docId, mapping, oldBridge } of snapshot) {
      const newBridge = new SanityBridge({
        instance: this.instance,
        resource: this.resource,
        docId,
        documentType: mapping.documentType,
        logger: this.logger,
        onChainRot: () => this.signalChainRot(key),
        onWriteOutcome: (outcome) => this.onWriteOutcomeCallback?.(outcome),
        onChange: (rawDoc) => {
          queueMicrotask(() => {
            this.handleSanityChange(key, rawDoc)
          })
        },
      })
      const doc = this.docs.get(key)
      if (doc) doc.bridge = newBridge
      oldBridge.dispose()
    }

    // Self-heal: replay pending mutations through the new bridges.
    // We do this AFTER the bridge swap so each replay write hits the
    // fresh `SanityInstance`. Sequential per doc to keep backpressure
    // sane; mutations for different docs run in parallel.
    await Promise.all(
      [...this.docs.keys()].map((key) => this.replayPendingMutations(key)),
    )

    // Don't dispose the old instance here — RoomManager owns its
    // lifecycle and will dispose after all rooms have swapped.
    void oldInstance
  }

  /**
   * Self-heal worker: walks `doc.pendingMutations` for a single doc,
   * classifies each entry against fresh server state, and routes it
   * to the appropriate next step. Idempotent — entries are removed
   * from `pendingMutations` once replayed (the original bridge.write
   * `.then` continues to call `resolvePendingMutation`, which sees the
   * empty entry and short-circuits).
   *
   * Errors during fresh-state read are NOT fatal — if we can't read
   * fresh state we fall back to a defensive `rebase-needed` reject on
   * every pending mutation for that doc, letting the client rebase
   * against whatever state it observes next. Worse case: voter sees
   * the same flicker the pre-self-heal F1-F7 code produced.
   */
  private async replayPendingMutations(docKey: string): Promise<void> {
    const doc = this.docs.get(docKey)
    if (!doc) return
    if (doc.pendingMutations.size === 0) return

    // Snapshot the pending mutations — replay outcomes will mutate the
    // map, and we want to iterate over a stable list.
    const pending = [...doc.pendingMutations.values()]
    this.logger.warn(
      `[room] replayPendingMutations(${docKey}) — ${pending.length} pending mutation(s) to classify`,
    )

    let fresh: unknown
    try {
      fresh = await this.readFreshDocState(doc.docId, doc.mapping)
    } catch (err) {
      // Read failed — defensive reject so clients rebase against whatever
      // state arrives next. Better than leaving mutations orphaned.
      this.logger.error(
        `[room] replayPendingMutations(${docKey}) — failed to read fresh state: ${(err as Error)?.message ?? err}`,
      )
      for (const m of pending) {
        doc.pendingMutations.delete(m.mutationId)
        this.sendTo(m.clientId, {
          channel: m.channel,
          type: 'reject',
          mutationId: m.mutationId,
          reason: 'rebase-needed: fresh state unavailable during chain-rot recovery',
        })
      }
      return
    }

    const classify = doc.mapping.classify
    for (const m of pending) {
      const cls: Classification = classify
        ? classify(fresh, m.beforeState, m.afterState, m.patch)
        : 'EQUAL' // Default safe for single-writer docs; classify() is the explicit override.

      switch (cls) {
        case 'EQUAL':
        case 'DIVERGED_COMPATIBLE': {
          // Safe to replay through the new bridge. The original mutation's
          // entry stays in `pendingMutations` until this write resolves —
          // the .then below routes the outcome via resolvePendingMutation
          // (which acks/rejects the client). If the original bridge.write
          // Promise also fires (with stale chain-rot rejection), it'll see
          // an empty pending entry and short-circuit.
          this.logger.warn(
            `[room] replay(${docKey} mutation=${m.mutationId}) class=${cls} — re-issuing through new bridge`,
          )
          doc.bridge.write(m.patch, m.refDocs, m.transactionId).then(
            (outcome) => this.resolvePendingMutation(docKey, m.mutationId, outcome),
            (err) =>
              this.resolvePendingMutation(docKey, m.mutationId, {
                kind: 'rejected',
                transactionId: m.transactionId,
                reason: 'local',
                message: `replay bridge.write threw: ${(err as Error)?.message ?? err}`,
              }),
          )
          break
        }
        case 'EQUAL_TO_AFTER': {
          // Server already shows what the voter wanted. Treat as
          // committed — ack the client and drop the entry.
          this.logger.warn(
            `[room] replay(${docKey} mutation=${m.mutationId}) class=EQUAL_TO_AFTER — idempotent ack`,
          )
          doc.pendingMutations.delete(m.mutationId)
          this.sendTo(m.clientId, { channel: m.channel, type: 'ack', mutationId: m.mutationId })
          break
        }
        case 'DIVERGED_CONFLICTING': {
          // Real conflict. Ship fresh state alongside the reject so the
          // client can rebase optimistic edits onto it. The SyncClient
          // handler for `rebase-needed` adopts the fresh server state
          // and re-flushes whatever local diff remains.
          this.logger.warn(
            `[room] replay(${docKey} mutation=${m.mutationId}) class=DIVERGED_CONFLICTING — sending rebase-needed`,
          )
          doc.pendingMutations.delete(m.mutationId)
          this.sendTo(m.clientId, {
            channel: m.channel,
            type: 'reject',
            mutationId: m.mutationId,
            reason: 'rebase-needed',
            freshServerState: fresh,
          })
          break
        }
      }
    }
  }

  /**
   * Read the current server-side domain state for a document via a NEW
   * `SanityInstance` (i.e. one that hasn't been poisoned by chain rot).
   *
   * Uses `getDocumentState` and races the first non-null emission against
   * a 5-second timeout — the chain reconciler on a fresh instance has
   * its own deadline, but we don't want chain-rot recovery to be
   * gated on it. If the read takes longer than 5s we surface a timeout
   * error and the caller (replayPendingMutations) falls back to the
   * defensive rebase-needed path.
   */
  private async readFreshDocState(docId: string, mapping: DocumentMapping<unknown>): Promise<unknown> {
    const handle = createDocumentHandle({
      documentId: docId,
      documentType: mapping.documentType,
      ...this.resource,
    })
    const observable = getDocumentState(this.instance, handle).observable
    const TIMEOUT_MS = 5_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const rawDoc = (await Promise.race([
      firstValueFrom(observable).then((v) => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        return v
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`fresh-read timeout (${TIMEOUT_MS}ms) on ${docId}`)),
          TIMEOUT_MS,
        )
      }),
    ])) as Record<string, unknown> | null
    if (!rawDoc) throw new Error(`fresh-read returned null for ${docId}`)
    return mapping.fromSanityWithRefs
      ? mapping.fromSanityWithRefs(rawDoc, this.getRefDocStates(this.docKeyForDocId(docId) ?? ''))
      : mapping.fromSanity(rawDoc)
  }

  private docKeyForDocId(docId: string): string | null {
    for (const [key, doc] of this.docs) {
      if (doc.docId === docId) return key
    }
    return null
  }

  /**
   * Called when the SDK emits a raw doc change (our own write echo OR external edit).
   * Maps the raw doc to domain state, compares with current state, broadcasts if different.
   *
   * If ref bridges exist but haven't loaded yet, defers mapping — broadcasting
   * with incomplete refs would strip custom resources from the domain state.
   *
   * `fromRef`: true when invoked from a ref bridge's onChange (the parent
   * `rawDoc` itself didn't change, only one of its referenced docs did).
   * In that path the ownTxns echo-suppression is skipped — `rawDoc._rev`
   * is the PARENT's last-known revision, which may still be a previous
   * own-write of ours, but the actual change we're propagating originated
   * in a ref doc external to this room's own write ledger. Without this
   * split, any ref-doc update silently stops broadcasting once the room
   * has done any direct write to the parent (reactions, lifecycle flips,
   * etc.) — a long-lived bug in the per-voter voteRecord subscriptions.
   */
  private handleSanityChange(key: string, rawDoc: Record<string, unknown>, fromRef = false): void {
    const doc = this.docs.get(key)
    if (!doc) return

    // Skip our own write echoes — we know all our transaction IDs.
    // ONLY meaningful for direct parent-doc emissions; see the docblock.
    if (!fromRef) {
      const rev = rawDoc._rev as string | undefined
      if (rev && doc.ownTxns.has(rev) /* don't delete — SDK may emit same _rev multiple times */) {
        return
      }
    }

    // Update ref subscriptions — only when the parent doc itself emitted.
    // A ref-triggered call passes the (unchanged) cached parent rawDoc, so
    // re-running resolveRefs would just rebuild the same ref set.
    if (!fromRef && doc.mapping.resolveRefs) {
      this.updateRefs(key, doc.mapping, rawDoc)
    }

    // First hydration only: if refs haven't loaded yet, defer — initial
    // assembly may need them to produce a valid state (e.g. a "must have
    // an admin" invariant). Once doc.state exists, parent-doc emits ALWAYS
    // update state with whatever refs are currently loaded; new refs slot
    // in incrementally as their bridges hydrate. Otherwise a parent change
    // that introduces new refs (e.g. closedAt flipping on a voter room
    // causes voteRecord refs to be subscribed) would leave doc.state stale
    // until every new ref had emitted — and any client reconnecting in
    // that window would receive the pre-change snapshot from addClient.
    if (doc.state === null && this.hasUnloadedRefs(key)) return

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
          onWriteOutcome: (outcome) => this.onWriteOutcomeCallback?.(outcome),
          onChange: (_refDoc) => {
            queueMicrotask(() => {
              parentDoc?.bridge.markRefDocKnown(desc.docId)
              this.handleSanityChange(parentKey, this.docs.get(parentKey)?.bridge.getRawDoc() ?? {}, true)
            })
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

      // Self-heal: capture beforeState BEFORE we overwrite doc.state so
      // the replay classifier in `recreateBridges` can decide whether the
      // pending mutation is still safe to issue after a chain-rot recovery.
      const beforeState = doc.state
      doc.state = result
      const afterState = result

      // Write to Sanity — always use toSanityPatch so ref docs
      // (custom fonts/palettes/backgrounds) are written alongside the main doc
      const txnId = crypto.randomUUID()
      this.recordOwnTxn(doc, txnId)
      const { patch, refPatches } = doc.mapping.toSanityPatch(result)
      const refDocs = this.buildRefDocWrites(patch as Record<string, unknown>, doc.mapping, refPatches)

      // Record the pending mutation BEFORE issuing the write. If chain-rot
      // fires, `recreateBridges` will find this entry and decide whether to
      // replay it through the recreated bridge.
      doc.pendingMutations.set(msg.mutationId, {
        mutationId: msg.mutationId,
        clientId,
        channel: msg.channel,
        transactionId: txnId,
        beforeState,
        afterState,
        patch: patch as Record<string, unknown>,
        refDocs,
        enqueuedAt: Date.now(),
      })

      // Broadcast OPTIMISTICALLY to OTHER clients so the visual update
      // is fast. The mutating client's ACK is deferred until Sanity
      // actually commits, so that voter knows if their write landed.
      this.broadcastExcept(clientId, { channel: msg.channel, type: 'state', state: result })

      // Notify mutation listeners now (in-memory state changed).
      for (const cb of this.onMutationListeners) cb(parsed.id)

      // Await the bridge's actual write outcome. The .then below routes
      // outcomes via `resolvePendingMutation`, which is idempotent so a
      // replayed outcome arriving after the original (e.g. old-bridge
      // chain-rot reject racing with new-bridge commit) is a no-op.
      doc.bridge.write(patch as Record<string, unknown>, refDocs, txnId).then(
        (outcome) => this.resolvePendingMutation(parsed.id, msg.mutationId, outcome),
        (err) => {
          // Shouldn't happen — bridge.write should always resolve, even
          // on failure. But if it throws, treat as reject.
          this.logger.error(
            `[room] bridge.write threw for mutation ${msg.mutationId} on ${parsed.id}: ${err?.message ?? err}`,
          )
          this.resolvePendingMutation(parsed.id, msg.mutationId, {
            kind: 'rejected',
            transactionId: txnId,
            reason: 'local',
            message: `bridge.write threw: ${err?.message ?? err}`,
          })
        },
      )
    }
  }

  /**
   * Self-heal: route a single bridge write outcome.
   *
   * Idempotent in the mutationId: if the entry has already been removed
   * (because a replay or earlier outcome already handled it) this is a
   * no-op. That's important because a chain-rotted bridge.write Promise
   * may continue resolving after `recreateBridges` has already replayed
   * the mutation through a fresh bridge — without this idempotency the
   * client would receive a double ack/reject.
   *
   * Behavior by outcome:
   * - `committed` → remove from pending, send `ack` to the client.
   * - `rejected`/`chain-rot` → KEEP in pending; `recreateBridges` will
   *   handle replay once the RoomManager has constructed a fresh
   *   `SanityInstance`. No client message — the voter's optimistic UI
   *   stays in place during recovery.
   * - `rejected`/everything else → remove from pending, send `reject`
   *   so the client knows the mutation did NOT land.
   */
  private resolvePendingMutation(
    docKey: string,
    mutationId: string,
    outcome: import('./sanity-bridge').WriteOutcome,
  ): void {
    const doc = this.docs.get(docKey)
    if (!doc) return
    const pending = doc.pendingMutations.get(mutationId)
    if (!pending) return // Already resolved by a parallel path (replay).

    if (outcome.kind === 'committed') {
      doc.pendingMutations.delete(mutationId)
      this.sendTo(pending.clientId, { channel: pending.channel, type: 'ack', mutationId })
      return
    }

    if (outcome.reason === 'chain-rot') {
      // Hold the mutation — `recreateBridges` will replay it through
      // the fresh `SanityInstance` once the RoomManager has swapped
      // bridges. The voter's optimistic UI stays in place; no client
      // message goes out for this transient SDK-internal failure.
      this.logger.warn(
        `[room] mutation ${mutationId} on ${docKey} held for chain-rot replay (txn=${outcome.transactionId})`,
      )
      return
    }

    // Permanent rejection — server validation, ref integrity, local apply bug.
    this.logger.error(
      `[room] mutation ${mutationId} rejected on ${docKey}: ${outcome.reason}: ${outcome.message}`,
    )
    doc.pendingMutations.delete(mutationId)
    this.sendTo(pending.clientId, {
      channel: pending.channel,
      type: 'reject',
      mutationId,
      reason: `${outcome.reason}: ${outcome.message}`,
    })
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
