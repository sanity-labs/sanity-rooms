/**
 * DocumentMapping — the bridge between a Sanity document's stored shape
 * and the app's in-memory state shape.
 *
 * Apps provide an implementation per document type. The sync package
 * never sees the app's state type directly — it only calls these methods.
 */

import type { Mutation } from './mutation'

export interface DocumentMapping<TState, TSanityDoc = Record<string, unknown>, TSanityPatch = Record<string, unknown>> {
  /** Sanity document type (e.g. "message") */
  documentType: string

  /** Convert a Sanity document to the app's in-memory state */
  fromSanity(doc: TSanityDoc): TState

  /**
   * Convert app state to Sanity patches for the main document,
   * plus optional patches for referenced documents.
   */
  toSanityPatch(state: TState): SanityPatchResult<TSanityPatch>

  /** Apply a mutation to app state. Returns new state, or null if invalid. */
  applyMutation(state: TState, mutation: Mutation): TState | null

  /**
   * Discover referenced document IDs to auto-subscribe.
   * Called when the main document changes. The Room diffs against current
   * subscriptions and adds/removes bridges as needed. All refs share the
   * same SDK shared listener — zero extra connections.
   */
  resolveRefs?(doc: TSanityDoc): RefDescriptor[]

  /**
   * Assemble the full state from the main doc + referenced docs.
   * Called by the Room when assembling composite state from the main doc
   * and its locally-held ref doc states. If not provided, fromSanity is
   * used on the main doc alone (no ref assembly).
   */
  fromSanityWithRefs?(doc: TSanityDoc, refDocs: Map<string, Record<string, unknown>>): TState
}

/** Result of toSanityPatch — main doc patches + patches for referenced docs. */
export interface SanityPatchResult<TSanityPatch = Record<string, unknown>> {
  /** Patches for the main document */
  patch: TSanityPatch
  /** Patches for referenced documents, keyed by the same ref key used in resolveRefs */
  refPatches?: Record<string, Record<string, unknown>>
}

/** Describes a referenced document to auto-follow. */
export interface RefDescriptor {
  /** Stable key for diffing (e.g. "cf-font123") */
  key: string
  /** Sanity document ID */
  docId: string
  /** Mapping for the referenced document */
  mapping: DocumentMapping<unknown>
}
