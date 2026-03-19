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

  /** Convert app state to a Sanity patch object for writing */
  toSanityPatch(state: TState): TSanityPatch

  /** Apply a mutation to app state. Returns new state, or null if invalid. */
  applyMutation(state: TState, mutation: Mutation): TState | null

  /**
   * Discover referenced document IDs to auto-subscribe.
   * Called when the main document changes. The Room diffs against current
   * subscriptions and adds/removes bridges as needed. All refs share the
   * same SDK shared listener — zero extra connections.
   */
  resolveRefs?(doc: TSanityDoc): RefDescriptor[]
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
