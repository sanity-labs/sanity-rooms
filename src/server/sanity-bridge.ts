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
    // Buffer writes until SDK state is ready (grants loaded, doc fetched)
    if (!this.ready) {
      this.pendingWrites.push({ patch, refDocs, transactionId })
      return
    }

    const actions: any[] = []

    // Main doc edit
    const mainHandle = createDocumentHandle({
      documentId: this.docId,
      documentType: this.documentType,
      ...this.resource,
    })
    actions.push(editDocument(mainHandle, { set: patch }))

    // Write main doc
    applyDocumentActions(this.instance, { actions, ...(transactionId && { transactionId }) }).catch((err) => {
      console.error(`[sanity-bridge] main doc write error for ${this.docId}:`, err)
    })

    // Write ref docs separately (edit if exists, create if new)
    if (refDocs) {
      for (const ref of refDocs) {
        const editHandle = createDocumentHandle({
          documentId: ref.docId,
          documentType: ref.documentType,
          ...this.resource,
        })
        applyDocumentActions(this.instance, {
          actions: [editDocument(editHandle, { set: ref.content })],
        }).catch(() => {
          // Edit failed (doc doesn't exist yet) — create it
          const createHandle = createDocumentTypeHandle({
            documentId: ref.docId,
            documentType: ref.documentType,
            ...this.resource,
          })
          applyDocumentActions(this.instance, {
            actions: [createDocument(createHandle, ref.content)],
          }).catch((err2) => {
            console.error(`[sanity-bridge] ref doc error for ${ref.docId}:`, err2)
          })
        })
      }
    }
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
