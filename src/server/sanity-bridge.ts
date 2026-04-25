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
    const sub = docState.observable.subscribe((doc) => {
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
  }
}
