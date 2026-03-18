/**
 * Mutation types — how changes are described in the sync protocol.
 *
 * Three kinds, designed for incremental adoption:
 * - `replace`: Full state replacement (simplest, start here)
 * - `named`: Intent-based mutation (e.g. "addFrame", "updateSegment")
 * - `patch`: Raw Sanity-style patches
 */

export type Mutation =
  | { kind: 'replace'; state: unknown }
  | { kind: 'named'; name: string; input: unknown }
  | { kind: 'patch'; patches: SanityPatch[] }

export interface SanityPatch {
  op: 'set' | 'unset' | 'inc' | 'dec' | 'insert'
  path: string
  value?: unknown
}
