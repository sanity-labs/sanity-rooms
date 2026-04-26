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
}

export class SanityBridge {
  readonly docId: string
  readonly documentType: string
  private rawDoc: Record<string, unknown> = {}
  private readonly instance: SanityInstance
  private readonly resource: SanityResource
  private readonly onChange: (doc: Record<string, unknown>) => void
  private readonly logger: import('../logger').Logger
  private unsubscribe: (() => void) | null = null
  private ready = false
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
        // SDK fires `null` immediately on subscribe before the doc
        // resolves; that's expected and silent. The `error:` handler
        // below surfaces real failures (auth, network, etc.).
        if (!doc) return
        this.rawDoc = doc as Record<string, unknown>
        if (!this.ready) {
          this.ready = true
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
      this.pendingWrites.push({ patch, refDocs, transactionId })
      return
    }

    const actions: any[] = []

    if (refDocs) {
      for (const ref of refDocs) {
        const refHandle = createDocumentHandle({
          documentId: ref.docId,
          documentType: ref.documentType,
          ...this.resource,
        })
        // editDocument fails on non-existent docs — create first if new.
        // knownRefDocs tracks docs we've already created, so we only
        // create once. Subsequent writes just edit.
        if (!this.knownRefDocs.has(ref.docId)) {
          actions.push(createDocument(refHandle))
          this.knownRefDocs.add(ref.docId)
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

    // TEMP DIAG: log when a write fires + when it succeeds so the admin
    // can correlate UI clicks with Sanity persistence.
    this.logger.info(`[bridge:${this.docId}] write firing — actions=${actions.length}, txn=${transactionId ?? 'none'}`)
    applyDocumentActions(this.instance, {
      actions,
      ...(transactionId && { transactionId }),
    })
      .then((result) => {
        this.logger.info(
          `[bridge:${this.docId}] write OK — submitted=${typeof result?.submitted === 'function' ? 'pending' : 'sync'}`,
        )
      })
      .catch((err) => {
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
  }
}
