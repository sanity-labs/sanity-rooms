/**
 * DocumentMapping — the bridge between a Sanity document's stored shape
 * and the app's in-memory state shape.
 *
 * Apps provide an implementation per document type. The sync package
 * never sees the app's state type directly — it only calls these methods.
 */

import type { Mutation } from './mutation'

/**
 * Outcome of classifying a pending mutation against fresh server state
 * during chain-rot recovery. Determines whether the mutation can be
 * replayed verbatim, is already at the target, or needs the client to
 * rebase.
 *
 * - `EQUAL`: fresh server state matches the pre-condition exactly —
 *   nobody else wrote during the rot window. Replay verbatim.
 * - `EQUAL_TO_AFTER`: fresh server state matches the target — the
 *   mutation's effect already lives in Sanity (idempotent retry, or
 *   a different writer reached the same goal). Treat as committed.
 * - `DIVERGED_COMPATIBLE`: fresh state differs from pre-condition,
 *   but the divergent fields are disjoint from what this mutation
 *   touches. Replay is safe — non-overlapping write.
 * - `DIVERGED_CONFLICTING`: fresh state differs in a way that overlaps
 *   with this mutation's target fields. Client must rebase.
 */
export type Classification = 'EQUAL' | 'EQUAL_TO_AFTER' | 'DIVERGED_COMPATIBLE' | 'DIVERGED_CONFLICTING'

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

  /**
   * Self-heal classifier for chain-rot recovery. Called by the Room
   * when replaying a pending mutation after the underlying
   * `SanityInstance` has been recreated. The classifier decides
   * whether the mutation is safe to re-issue.
   *
   * Implementations should perform a structural compare on the fields
   * the mutation actually targets — overly conservative `DIVERGED_CONFLICTING`
   * is safe (the client will rebase) but causes a visible UI flicker.
   * Overly optimistic `EQUAL` can overwrite a concurrent writer's
   * changes — only use it when you can prove no other writer touches
   * the targeted fields.
   *
   * If unspecified, the Room treats every pending mutation as `EQUAL`,
   * which is correct for single-writer documents (where no other source
   * can write between rot and recovery) but unsafe for multi-writer
   * documents — provide an explicit classifier for those.
   */
  classify?(
    freshState: TState,
    beforeState: TState,
    afterState: TState,
    patch: TSanityPatch,
  ): Classification
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
