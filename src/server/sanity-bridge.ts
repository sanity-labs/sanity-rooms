/**
 * SanityBridge — wraps @sanity/sdk to manage one document with a mapping layer.
 *
 * Subscribes to document state via sdk's getDocumentState(), maps between
 * Sanity doc shape and app state shape via DocumentMapping, and applies
 * mutations through editDocument(). sdk handles listener dedup, own-write
 * filtering, conflict rebasing, and revision tracking automatically.
 */

import type { Mutation } from '../mutation'
import type { DocumentMapping } from '../mapping'

/**
 * Narrow interface for the @sanity/sdk functions we use.
 * Makes the bridge testable without importing the full SDK.
 */
export interface SdkAdapter {
  /** Subscribe to a document's state. Returns unsubscribe function. */
  subscribe(
    docId: string,
    documentType: string,
    callback: (doc: Record<string, unknown> | null) => void,
  ): () => void

  /** Apply patches to a document via editDocument. */
  applyPatches(
    docId: string,
    documentType: string,
    patches: Record<string, unknown>,
  ): void
}

export interface SanityBridgeOptions<TState> {
  adapter: SdkAdapter
  docId: string
  mapping: DocumentMapping<TState>
  initialState: TState
  onStateChange: (state: TState) => void
  /** Called with the raw Sanity doc on every change (for resolveRefs). */
  onRawDoc?: (doc: Record<string, unknown>) => void
}

export class SanityBridge<TState> {
  private state: TState
  private readonly mapping: DocumentMapping<TState>
  private readonly adapter: SdkAdapter
  private readonly docId: string
  private readonly onStateChange: (state: TState) => void
  private readonly onRawDoc?: (doc: Record<string, unknown>) => void
  private unsubscribe: (() => void) | null = null

  constructor(options: SanityBridgeOptions<TState>) {
    this.adapter = options.adapter
    this.docId = options.docId
    this.mapping = options.mapping
    this.state = options.initialState
    this.onStateChange = options.onStateChange
    this.onRawDoc = options.onRawDoc

    this.unsubscribe = this.adapter.subscribe(
      this.docId,
      this.mapping.documentType,
      (doc) => {
        if (!doc) return
        const mapped = this.mapping.fromSanity(doc)
        this.state = mapped
        this.onStateChange(mapped)
        this.onRawDoc?.(doc)
      },
    )
  }

  getState(): TState {
    return this.state
  }

  applyMutation(mutation: Mutation): TState | null {
    const result = this.mapping.applyMutation(this.state, mutation)
    if (result === null) return null

    this.state = result

    // Convert to Sanity patches and send to SDK
    const patches = this.mapping.toSanityPatch(result)
    this.adapter.applyPatches(this.docId, this.mapping.documentType, patches)

    return result
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
