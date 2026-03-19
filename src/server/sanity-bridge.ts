/**
 * SanityBridge — raw document store backed by @sanity/sdk.
 *
 * Subscribes to a document's state, stores the raw Sanity doc, and writes
 * raw patches via editDocument + applyDocumentActions. Does NO domain mapping —
 * that's the Room's job.
 */

import {
  getDocumentState,
  editDocument,
  createDocument,
  applyDocumentActions,
  createDocumentHandle,
  createDocumentTypeHandle,
  type SanityInstance,
} from '@sanity/sdk'

export interface SanityResource {
  projectId: string
  dataset: string
}

export interface SanityBridgeOptions {
  instance: SanityInstance
  resource: SanityResource
  docId: string
  documentType: string
  /** Called whenever the raw Sanity doc changes. */
  onChange: (doc: Record<string, unknown>) => void
}

export class SanityBridge {
  readonly docId: string
  readonly documentType: string
  private rawDoc: Record<string, unknown> = {}
  private readonly instance: SanityInstance
  private readonly resource: SanityResource
  private readonly onChange: (doc: Record<string, unknown>) => void
  private unsubscribe: (() => void) | null = null
  private ready = false
  private pendingWrites: Array<{ patch: Record<string, unknown>; refDocs?: Array<{ docId: string; documentType: string; content: Record<string, unknown> }>; transactionId?: string }> = []

  constructor(options: SanityBridgeOptions) {
    this.instance = options.instance
    this.resource = options.resource
    // Strip drafts. prefix — the SDK manages draft lifecycle internally
    this.docId = options.docId.replace(/^drafts\./, '')
    this.documentType = options.documentType
    console.log(`[bridge] created: ${this.docId} (${this.documentType})`)
    this.onChange = options.onChange

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
        // Flush any writes that arrived before the SDK was ready
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

  /** Write raw patches to the main doc. Optionally write ref docs separately. */
  write(
    patch: Record<string, unknown>,
    refDocs?: Array<{ docId: string; documentType: string; content: Record<string, unknown> }>,
    transactionId?: string,
  ): void {
    console.log(`[bridge:${this.docId}] write: ready=${this.ready} keys=${Object.keys(patch)} refDocs=${refDocs?.length ?? 0} txn=${transactionId}`)
    // Buffer writes until SDK state is ready (grants loaded, doc fetched)
    if (!this.ready) {
      this.pendingWrites.push({ patch, refDocs, transactionId })
      return
    }

    // Build all actions in one batch — atomic transaction
    const actions: any[] = []

    // Ref doc creates (in same atomic transaction as main doc edit)
    if (refDocs) {
      for (const ref of refDocs) {
        const refHandle = createDocumentTypeHandle({
          documentId: ref.docId,
          documentType: ref.documentType,
          ...this.resource,
        })
        actions.push(createDocument(refHandle, ref.content))
      }
    }

    // Main doc edit LAST (refs exist in the same transaction)
    const mainHandle = createDocumentHandle({
      documentId: this.docId,
      documentType: this.documentType,
      ...this.resource,
    })
    actions.push(editDocument(mainHandle, { set: patch }))

    applyDocumentActions(this.instance, {
      actions,
      ...(transactionId && { transactionId }),
    }).then(
      async (result) => {
        console.log(`[bridge:${this.docId}] applied: txn=${result.transactionId} actions=${actions.length}`)
        try {
          await result.submitted()
          console.log(`[bridge:${this.docId}] CONFIRMED`)
        } catch (err: any) {
          console.error(`[bridge:${this.docId}] REJECTED:`, err.message ?? err)
        }
      },
      (err) => console.error(`[bridge:${this.docId}] FAILED:`, err.message ?? err),
    )
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
