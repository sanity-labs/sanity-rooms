/**
 * Mutation types — how changes are described in the sync protocol.
 *
 * Four kinds:
 * - `replace`: Full state replacement (caller sends entire state, SyncClient diffs at flush)
 * - `named`: Intent-based mutation (e.g. "addFrame", "updateSegment")
 * - `merge`: Shallow key merge (internal, produced by SyncClient from replace diffs)
 * - `sanityPatch`: Sanity-native patch operations (produced by diffValue at flush time)
 */

import type { SanityPatchOperations } from '@sanity/diff-patch'

export type Mutation =
  | { kind: 'replace'; state: unknown }
  | { kind: 'named'; name: string; input: unknown }
  | { kind: 'merge'; partial: Record<string, unknown> }
  | { kind: 'sanityPatch'; operations: SanityPatchOperations[] }

export type { SanityPatchOperations }
