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
  private readonly maxPendingWrites: number
  private unsubscribe: (() => void) | null = null
  private ready = false
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private stallReported = false
  private pendingWrites: Array<{ patch: Record<string, unknown>; refDocs?: RefDocWrite[]; transactionId?: string }> = []
  /** Ref doc IDs we've already created — skip createDocument for these. */
  private knownRefDocs = new Set<string>()

  constructor(options: SanityBridgeOptions) {
    this.instance = options.instance
    this.resource = options.resource
    this.docId = options.docId.replace(/^drafts\./, '')
    this.documentType = options.documentType
    this.onChange = options.onChange
    this.logger = options.logger ?? console
    this.onStall = options.onStall
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

    const handle = createDocumentHandle({
      documentId: this.docId,
      documentType: this.documentType,
      ...this.resource,
    })
    const docState = getDocumentState(this.instance, handle)
    // FULL observer — without `error` and `complete` handlers, an
    // errored observable silently drops the failure and the bridge
    // hangs forever. That's the root cause of the "Room ready
    // timeout" loop: a doc fails to load (auth, missing doc, network
    // blip, schema mismatch), the bridge never emits, the room
    // times out at 15s, and the SAME error repeats on every reconnect
    // because nothing surfaces what's wrong. Logging here at least
    // makes the failure visible; we may later want to set
    // `this.errored` and surface it through the room so clients get
    // a real status instead of silent retries.
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
          for (const w of this.pendingWrites) {
            this.write(w.patch, w.refDocs, w.transactionId)
          }
          this.pendingWrites = []
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
        this.logger.error(`[bridge:${this.docId}] observable error: ${msg}`)
      },
      complete: () => {
        this.logger.warn(`[bridge:${this.docId}] observable completed unexpectedly — no further updates`)
      },
    })
    this.unsubscribe = () => sub.unsubscribe()
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
  write(patch: Record<string, unknown>, refDocs?: RefDocWrite[], transactionId?: string): void {
    if (!this.ready) {
      if (this.pendingWrites.length >= this.maxPendingWrites) {
        this.pendingWrites.shift()
        this.logger.warn(
          `[bridge:${this.docId}] pending-writes cap (${this.maxPendingWrites}) reached — dropping oldest buffered write`,
        )
      }
      this.pendingWrites.push({ patch, refDocs, transactionId })
      return
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

    applyDocumentActions(this.instance, {
      actions,
      ...(transactionId && { transactionId }),
    }).catch((err) => {
      this.logger.error(`[bridge:${this.docId}] write error:`, err.message ?? err)
    })
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
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
    this.pendingWrites = []
  }
}
