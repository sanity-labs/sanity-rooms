/**
 * DocumentMapping — the bridge between a Sanity document's stored shape
 * and the app's in-memory state shape.
 *
 * Apps provide an implementation per document type. The sync package
 * never sees the app's state type directly — it only calls these methods.
 */

import type { Mutation } from './mutation'

export interface DocumentMapping<TState> {
  /** Sanity document type (e.g. "message") */
  documentType: string

  /** GROQ projection for fetching (e.g. `{ ..., customFonts[]-> }`) */
  projection?: string

  /** Convert a Sanity document to the app's in-memory state */
  fromSanity(doc: Record<string, unknown>): TState

  /** Convert app state to a Sanity patch object for writing */
  toSanityPatch(state: TState): Record<string, unknown>

  /** Apply a mutation to app state. Returns new state, or null if invalid. */
  applyMutation(state: TState, mutation: Mutation): TState | null
}
