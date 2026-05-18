/**
 * SanityBridge — raw document store backed by @sanity/sdk.
 *
 * Subscribes to a document's state, stores the raw Sanity doc, and writes
 * raw patches via editDocument + applyDocumentActions. Does NO domain mapping —
 * that's the Room's job.
 *
 * Strips `drafts.` prefix from doc IDs — the SDK manages draft lifecycle internally.
 * Buffers writes until the SDK state is ready (grants loaded, doc fetched).
 */

import {
  applyDocumentActions,
  createDocument,
  createDocumentHandle,
  editDocument,
  getDocumentState,
  type SanityInstance,
} from '@sanity/sdk'

export interface SanityResource {
  projectId: string
  dataset: string
}

export interface RefDocWrite {
  docId: string
  documentType: string
  content: Record<string, unknown>
}

/**
 * The outcome of a bridge write attempt, after the SDK has reported back
 * via `.submitted()`. This is what callers (the Room) need to make
 * orchestration decisions: ack the client, retry, recreate the SDK
 * instance, or surface a permanent rejection.
 *
 * - `committed`: the server accepted and committed the write. Safe to ACK.
 * - `rejected`/server: Sanity rejected at the server (schema, ref integrity,
 *    validation, revision conflict, rate limit). Callers should:
 *      - if retryable (e.g. 409), rebase against latest and retry
 *      - if not, surface to client as a permanent rejection
 * - `rejected`/chain-rot: the SDK's chain reconciler can't progress.
 *    The caller's owner of this SanityInstance MUST recreate it and replay
 *    pending writes; this instance is dead for this doc.
 * - `rejected`/local: the SDK rejected on local apply. Should never happen
 *    for well-formed patches; treat as a bug + retry once after recreate.
 * - `buffered`: the bridge is not yet ready (first SDK emit hasn't arrived).
 *    The write is queued and will be flushed; this Promise resolves when
 *    the buffered write actually executes, with the real outcome.
 */
export type WriteOutcome =
  | { kind: 'committed'; transactionId: string }
  | { kind: 'rejected'; transactionId: string; reason: 'server' | 'chain-rot' | 'local'; message: string }

export interface SanityBridgeOptions {
  instance: SanityInstance
  resource: SanityResource
  docId: string
  documentType: string
  onChange: (doc: Record<string, unknown>) => void
  logger?: import('../logger').Logger
  /** If > 0, surface a stall when no non-null doc has been emitted in
   *  this window. Default: 0 (off). Useful as a diagnostic when an SDK
   *  subscription is suspected of hanging. */
  firstEmitTimeoutMs?: number
  /** Called once on stall with a one-line reason. */
  onStall?(reason: string): void
  /** Max buffered writes while waiting for first emit. Default: 200. */
  maxPendingWrites?: number
  /**
   * Fired once when the bridge detects chain-rot from its `.submitted()`
   * Promise rejection (DeadlineExceededError or similar). The owner of
   * this bridge's `SanityInstance` must respond by disposing the
   * instance and re-creating all bridges that share it — re-subscribing
   * on the same instance is a no-op (the SDK's internal queued-write
   * state stays poisoned). Fired at most once per bridge lifetime;
   * subsequent chain-rot writes are still surfaced via the `WriteOutcome`
   * but no additional callbacks fire.
   */
  onChainRot?: () => void
  /**
   * Fired for EVERY write outcome — committed or rejected. Used by the
   * RoomManager to aggregate metrics (counts by outcome kind/reason).
   * Pre-F7 these outcomes were only visible in log strings; with
   * structured metrics, operators can alarm on rejection-rate spikes
   * before voters lose data.
   */
  onWriteOutcome?: (outcome: WriteOutcome) => void
}

export class SanityBridge {
  readonly docId: string
  readonly documentType: string
  private rawDoc: Record<string, unknown> = {}
  private readonly instance: SanityInstance
  private readonly resource: SanityResource
  private readonly onChange: (doc: Record<string, unknown>) => void
  private readonly logger: import('../logger').Logger
  private readonly onStall?: (reason: string) => void
  private readonly onChainRot?: () => void
  private readonly onWriteOutcome?: (outcome: WriteOutcome) => void
  private chainRotSignaled = false
  private readonly maxPendingWrites: number
  private unsubscribe: (() => void) | null = null
  private ready = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private stallReported = false
  private pendingWrites: Array<{
    patch: Record<string, unknown>
    refDocs?: RefDocWrite[]
    transactionId?: string
    /** Resolves when this buffered write eventually executes. */
    resolveOutcome: (o: WriteOutcome) => void
  }> = []
  /**
   * In-flight write outcome resolvers, keyed by transactionId. Tracked so
   * a test affordance (`__testSimulateInflightChainRot`) can force-resolve
   * still-pending `.submitted()` outcomes as chain-rot — exactly the
   * shape a real SDK chain reconciler stall produces.
   *
   * In production this map fills on every `write()` call and empties as
   * soon as the SDK's `.submitted()` settles. The only consumer outside
   * normal write resolution is the test hook below.
   */
  private inflightResolvers = new Map<string, (o: WriteOutcome) => void>()
  /** Ref doc IDs we've already created — skip createDocument for these. */
  private knownRefDocs = new Set<string>()
  private disposed = false
  private readonly handle: ReturnType<typeof createDocumentHandle>

  constructor(options: SanityBridgeOptions) {
    this.instance = options.instance
    this.resource = options.resource
    this.docId = options.docId.replace(/^drafts\./, '')
    this.documentType = options.documentType
    this.onChange = options.onChange
    this.logger = options.logger ?? console
    this.onStall = options.onStall
    this.onChainRot = options.onChainRot
    this.onWriteOutcome = options.onWriteOutcome
    this.maxPendingWrites = options.maxPendingWrites ?? 200

    const stallMs = options.firstEmitTimeoutMs ?? 0
    if (stallMs > 0) {
      this.stallTimer = setTimeout(() => {
        if (this.ready) return
        const reason =
          `[bridge:${this.docId}] no SDK emit in ${stallMs}ms — likely causes: ` +
          `(1) doc id does not exist in the dataset, ` +
          `(2) auth token is missing/invalid for drafts perspective, ` +
          `(3) schema doesn't include "${this.documentType}", ` +
          `(4) the SDK's underlying live-listener has stalled and needs the SanityInstance recreated.`
        this.logger.warn(reason)
        this.stallReported = true
        this.onStall?.(reason)
      }, stallMs)
    }

    this.handle = createDocumentHandle({
      documentId: this.docId,
      documentType: this.documentType,
      ...this.resource,
    })
    this.subscribeToDoc()
  }

  private subscribeToDoc(): void {
    if (this.disposed) return
    const docState = getDocumentState(this.instance, this.handle)
    // FULL observer — without `error` and `complete` handlers, an
    // errored observable silently drops the failure and the bridge
    // hangs forever. That's the root cause of the "Room ready
    // timeout" loop: a doc fails to load (auth, missing doc, network
    // blip, schema mismatch), the bridge never emits, the room
    // times out at 15s.
    //
    // On error/complete, we re-subscribe. The SDK's listener welcome
    // event fires on every fresh subscription and produces a new
    // `sync` event — that resets the chain reconciler's base
    // revision and clears whatever stuck buffer caused the
    // DeadlineExceededError. This makes the bridge resilient to
    // transient SDK chain failures (e.g. when an external service
    // mutates the doc and the listener event arrives with a
    // `previousRev` the SDK couldn't bridge from its last known base).
    const sub = docState.observable.subscribe({
      next: (doc) => {
        if (!doc) return
        this.rawDoc = doc as Record<string, unknown>
        if (!this.ready) {
          this.ready = true
          if (this.stallTimer) {
            clearTimeout(this.stallTimer)
            this.stallTimer = null
          }
          if (this.stallReported) {
            this.logger.info(`[bridge:${this.docId}] recovered after stall — first emit received`)
          }
          // Flush buffered writes. Each buffered write has a
          // deferred Promise we resolve with the actual outcome.
          const toFlush = this.pendingWrites
          this.pendingWrites = []
          for (const w of toFlush) {
            this.write(w.patch, w.refDocs, w.transactionId).then(w.resolveOutcome)
          }
        }
        this.onChange(this.rawDoc)
      },
      // Without `error`/`complete` handlers an errored observable is
      // silently dropped and the bridge hangs forever — that's the
      // root cause of "Room ready timeout" loops where reconnects
      // keep failing because a doc fails to load (auth, network,
      // schema mismatch) and nothing surfaces. These two handlers
      // make the failure visible.
      error: (err) => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
        // Some SDK errors (DeadlineExceededError, MaxBufferExceededError)
        // carry a `state` payload with the chain reconciler's view —
        // base revision + buffered (unchainable) mutation events. Log
        // it so we can diagnose what events are arriving with mismatched
        // `previousRev`.
        const state = (err as { state?: unknown } | undefined)?.state
        const stateStr = state ? `\nstate=${safeJsonStringify(state)}` : ''
        this.logger.error(`[bridge:${this.docId}] observable error: ${msg}${stateStr}`)
        const isChainRot = /Did not resolve chain|DeadlineExceededError/.test(msg)
        if (isChainRot) {
          // Re-subscribing is a NO-OP for chain rot — the SDK's
          // internal state is poisoned and the welcome replay will
          // hit the same unchainable buffer. Signal up so the
          // RoomManager can dispose the whole SanityInstance and
          // construct a fresh one. Do NOT call handleSubscriptionEnd
          // here — that loops on the same instance and produces the
          // 30+ identical error spam we saw in prod logs.
          this.maybeSignalChainRot()
        } else {
          // Non-chain errors: re-subscribe (this used to recover
          // transient SDK chain failures via the listener welcome's
          // fresh sync event; that path was fine for non-chain-rot
          // errors).
          this.handleSubscriptionEnd()
        }
      },
      complete: () => {
        this.logger.warn(`[bridge:${this.docId}] observable completed — re-subscribing`)
        this.handleSubscriptionEnd()
      },
    })
    this.unsubscribe = () => sub.unsubscribe()
  }

  /** Dispose the dead subscription and re-subscribe. The new subscription
   *  triggers a listener welcome → fresh sync event → reset chain. */
  private handleSubscriptionEnd(): void {
    if (this.disposed) return
    this.unsubscribe?.()
    this.unsubscribe = null
    this.subscribeToDoc()
  }

  getRawDoc(): Record<string, unknown> {
    return this.rawDoc
  }

  /**
   * Whether a draft version currently exists for this doc.
   *
   * Sanity SDK's `getDocumentState` emits the draft when one exists, otherwise
   * the published version. The `_id` prefix reveals which: `drafts.X` → draft
   * exists; bare `X` → only published. Used by Room.publish to skip docs that
   * have nothing to publish (real SDK throws "no draft version was found"
   * otherwise, aborting the whole publish transaction).
   */
  hasDraft(): boolean {
    const id = this.rawDoc._id
    return typeof id === 'string' && id.startsWith('drafts.')
  }

  /** Mark a ref doc as already existing in Sanity — prevents createDocument on next write. */
  markRefDocKnown(docId: string): void {
    this.knownRefDocs.add(docId.replace(/^drafts\./, ''))
  }

  /**
   * Write raw patches to the main doc, optionally creating ref docs atomically.
   * Ref doc creates go first in the action batch so they exist when the main doc
   * edit references them.
   */
  write(patch: Record<string, unknown>, refDocs?: RefDocWrite[], transactionId?: string): Promise<WriteOutcome> {
    const txn = transactionId ?? 'no-txn'
    if (!this.ready) {
      if (this.pendingWrites.length >= this.maxPendingWrites) {
        const dropped = this.pendingWrites.shift()
        // Resolve the dropped write with a chain-rot-equivalent
        // outcome so its caller doesn't await forever.
        const dropOutcome: WriteOutcome = {
          kind: 'rejected',
          transactionId: dropped?.transactionId ?? 'no-txn',
          reason: 'local',
          message: `dropped from buffer: pending-writes cap (${this.maxPendingWrites}) reached`,
        }
        dropped?.resolveOutcome(dropOutcome)
        try {
          this.onWriteOutcome?.(dropOutcome)
        } catch {
          /* swallow handler error so we keep cycling the buffer */
        }
        this.logger.warn(
          `[bridge:${this.docId}] pending-writes cap (${this.maxPendingWrites}) reached — dropping oldest buffered write`,
        )
      }
      return new Promise<WriteOutcome>((resolve) => {
        this.pendingWrites.push({ patch, refDocs, transactionId, resolveOutcome: resolve })
      })
    }

    const actions: any[] = []

    if (refDocs) {
      for (const ref of refDocs) {
        // Strip the drafts. prefix so the knownRefDocs lookup agrees with
        // markRefDocKnown (which also strips). Without this, docs already
        // existing in Sanity get a second createDocument attempt that fails
        // with "draft already exists" and aborts the whole transaction.
        const bareRefId = ref.docId.replace(/^drafts\./, '')
        const refHandle = createDocumentHandle({
          documentId: bareRefId,
          documentType: ref.documentType,
          ...this.resource,
        })
        if (!this.knownRefDocs.has(bareRefId)) {
          actions.push(createDocument(refHandle))
          this.knownRefDocs.add(bareRefId)
        }
        actions.push(editDocument(refHandle, { set: ref.content }))
      }
    }

    actions.push(
      editDocument(
        createDocumentHandle({ documentId: this.docId, documentType: this.documentType, ...this.resource }),
        { set: patch },
      ),
    )

    // (txn is already declared above near the !ready guard)
    // FORENSIC: log stage1 entry count + first malformed entry shape per write
    try {
      const stage1 = (patch as { stage1?: unknown[] }).stage1
      if (Array.isArray(stage1)) {
        const bad = stage1.find((e) => !(e as { song?: unknown }).song)
        if (bad)
          console.log(
            `[FORENSIC bridge:${this.docId}] write txn=${txn} stage1.length=${stage1.length} BAD ENTRY: ${JSON.stringify(bad)}`,
          )
      }
    } catch {}
    // Bridge.write AWAITS the SDK's `.submitted()` Promise so the caller
    // (Room) sees the actual server-commit outcome. Two phases:
    //
    //   1. local-apply phase: `applyDocumentActions(...)` itself. If it
    //      rejects, the SDK refused to even queue the action (rare —
    //      bad shape, instance-level failure).
    //   2. server-commit phase: `result.submitted()`. Resolves when
    //      Sanity has committed the transaction. Rejects on schema
    //      violation, ref integrity, validation, revision conflict,
    //      rate limit, or chain reconciler deadlock (DeadlineExceededError).
    //
    // Outcomes flow through `inflightResolvers` — a per-txn deferred
    // resolver — so a test affordance can synthetically rot in-flight
    // writes without having to monkey-patch the Sanity SDK. In production
    // this layer is a pass-through: the resolver fires from the normal
    // .submitted() success/failure handler exactly once.
    return new Promise<WriteOutcome>((resolveOuter) => {
      const completeOutcome = (outcome: WriteOutcome) => {
        // Idempotent: if the test hook already resolved this txn, skip.
        if (!this.inflightResolvers.has(txn)) return
        this.inflightResolvers.delete(txn)
        try {
          this.onWriteOutcome?.(outcome)
        } catch (err) {
          this.logger.error(
            `[bridge:${this.docId}] onWriteOutcome handler threw: ${(err as Error)?.message ?? err}`,
          )
        }
        resolveOuter(outcome)
      }
      this.inflightResolvers.set(txn, completeOutcome)

      applyDocumentActions(this.instance, {
        actions,
        ...(transactionId && { transactionId }),
      }).then(
        (result) => {
          const submitted = (result as { submitted?: () => Promise<unknown> })?.submitted
          if (typeof submitted !== 'function') {
            this.logger.warn(`[bridge:${this.docId}] write COMMITTED-no-submitted-api txn=${txn}`)
            completeOutcome({ kind: 'committed', transactionId: txn })
            return
          }
          ;(submitted.call(result) as Promise<unknown>).then(
            () => {
              this.logger.warn(`[bridge:${this.docId}] write COMMITTED txn=${txn}`)
              completeOutcome({ kind: 'committed', transactionId: txn })
            },
            (err) => {
              const message = (err as Error)?.message ?? String(err)
              const isChainRot = /Did not resolve chain|DeadlineExceededError/.test(message)
              this.logger.error(
                `[bridge:${this.docId}] write SERVER-REJECTED txn=${txn} (${isChainRot ? 'chain-rot' : 'server'}): ${message}`,
              )
              if (isChainRot) this.maybeSignalChainRot()
              completeOutcome({
                kind: 'rejected',
                transactionId: txn,
                reason: isChainRot ? 'chain-rot' : 'server',
                message,
              })
            },
          )
        },
        (err) => {
          const message = (err as Error)?.message ?? String(err)
          const isChainRot = /Did not resolve chain|DeadlineExceededError/.test(message)
          this.logger.error(
            `[bridge:${this.docId}] write LOCAL-ERR txn=${txn} (${isChainRot ? 'chain-rot' : 'local'}): ${message}`,
          )
          if (isChainRot) this.maybeSignalChainRot()
          completeOutcome({
            kind: 'rejected',
            transactionId: txn,
            reason: isChainRot ? 'chain-rot' : 'local',
            message,
          })
        },
      )
    })
  }

  /**
   * Test affordance — count of currently in-flight write outcome
   * resolvers. Used by the repro harness to gate the synthetic
   * chain-rot trigger on "writes actually in flight". Production code
   * must not call this.
   */
  __testInflightWriteCount(): number {
    return this.inflightResolvers.size
  }

  /**
   * Test affordance — DO NOT USE IN PRODUCTION. Force-resolves every
   * currently in-flight write as a chain-rot rejection AND fires the
   * `onChainRot` signal. Mirrors what a real SDK chain reconciler stall
   * produces, but synchronously and deterministically — used by the
   * repro harness's scenario N to exercise the self-heal replay path.
   *
   * Returns the number of in-flight writes that were synthetically rotted.
   */
  __testSimulateInflightChainRot(): number {
    const stale = [...this.inflightResolvers.entries()]
    this.inflightResolvers.clear()
    for (const [txn, resolve] of stale) {
      const outcome: WriteOutcome = {
        kind: 'rejected',
        transactionId: txn,
        reason: 'chain-rot',
        message: '__testSimulateInflightChainRot: synthetic chain-rot injected for in-flight write',
      }
      try {
        this.onWriteOutcome?.(outcome)
      } catch {
        /* noop */
      }
      try {
        resolve(outcome)
      } catch {
        /* noop */
      }
    }
    this.maybeSignalChainRot()
    return stale.length
  }

  private maybeSignalChainRot(): void {
    if (this.chainRotSignaled || this.disposed) return
    this.chainRotSignaled = true
    this.logger.error(
      `[bridge:${this.docId}] CHAIN-ROT DETECTED — signaling owner to recreate SanityInstance`,
    )
    try {
      this.onChainRot?.()
    } catch (err) {
      this.logger.error(`[bridge:${this.docId}] onChainRot handler threw: ${(err as Error)?.message ?? err}`)
    }
  }

  /**
   * Write Sanity-native patch operations directly (produced by @sanity/diff-patch).
   * Each SanityPatchOperations object becomes an editDocument action.
   */
  writePatch(operations: Array<Record<string, unknown>>, transactionId?: string): void {
    if (!this.ready) return // patches are transient — don't buffer

    const handle = createDocumentHandle({
      documentId: this.docId,
      documentType: this.documentType,
      ...this.resource,
    })
    const actions = operations.map((op) => editDocument(handle, op))

    applyDocumentActions(this.instance, {
      actions,
      ...(transactionId && { transactionId }),
    }).catch((err) => {
      this.logger.error(`[bridge:${this.docId}] writePatch error:`, err.message ?? err)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
    // CRITICAL: resolve every buffered write's outcome promise before
    // clearing the queue, otherwise callers awaiting bridge.write()
    // hang forever. Treat dispose as a permanent "local" rejection;
    // the Room can decide what to do with the orphaned mutation
    // (typically: send `reject` to the originating client so it can
    // retry on the new bridge after RoomManager swaps the instance).
    const orphaned = this.pendingWrites
    this.pendingWrites = []
    for (const w of orphaned) {
      const disposeOutcome: WriteOutcome = {
        kind: 'rejected',
        transactionId: w.transactionId ?? 'no-txn',
        reason: 'local',
        message: 'bridge disposed before write was attempted',
      }
      try {
        w.resolveOutcome(disposeOutcome)
      } catch {
        /* noop */
      }
      try {
        this.onWriteOutcome?.(disposeOutcome)
      } catch {
        /* noop */
      }
    }

    // Also drain in-flight write outcome resolvers. Their underlying
    // applyDocumentActions Promises may still settle later against a
    // disposed SDK instance — but the Room's resolvePendingMutation
    // is idempotent (it short-circuits when the entry is absent), so
    // a stale settle has no effect.
    const inflight = [...this.inflightResolvers.entries()]
    this.inflightResolvers.clear()
    for (const [txn, resolve] of inflight) {
      const disposeOutcome: WriteOutcome = {
        kind: 'rejected',
        transactionId: txn,
        reason: 'local',
        message: 'bridge disposed before write completed',
      }
      try {
        this.onWriteOutcome?.(disposeOutcome)
      } catch {
        /* noop */
      }
      try {
        resolve(disposeOutcome)
      } catch {
        /* noop */
      }
    }
  }
}

/** JSON.stringify that won't crash on cyclic refs in SDK error state.
 *  Truncates large strings so the log isn't noise. */
function safeJsonStringify(v: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      v,
      (_k, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[circular]'
          seen.add(val)
        }
        if (typeof val === 'string' && val.length > 400) return `${val.slice(0, 400)}…`
        return val
      },
      2,
    )
  } catch {
    return String(v)
  }
}
