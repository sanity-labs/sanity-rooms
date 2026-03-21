/**
 * Apply Sanity patch operations to a plain JS object using @sanity/mutator.
 *
 * Handles set, unset, diffMatchPatch, insert — including _key-based array paths.
 * Used by both the client (reapply local changes on server state) and the server
 * (apply incoming sanityPatch mutations).
 */

import type { SanityPatchOperations } from '@sanity/diff-patch'
import { Mutation as SanityMutation } from '@sanity/mutator'

/** Sentinel value for docs that don't have _id/_type (domain objects, not Sanity docs). */
const SYNC_ID = '__sync__'

type MutableRecord = Record<string, unknown>

export function applySanityPatches(doc: unknown, operations: SanityPatchOperations[]): unknown {
  if (!doc || typeof doc !== 'object' || operations.length === 0) return doc

  const orig = doc as MutableRecord
  const hadId = '_id' in orig
  const hadType = '_type' in orig
  const hadRev = '_rev' in orig
  const hadUpdatedAt = '_updatedAt' in orig

  // @sanity/mutator requires _id and _type, and patch id must match doc _id
  const docId = typeof orig._id === 'string' ? orig._id : SYNC_ID
  const withMeta = { _id: docId, _type: typeof orig._type === 'string' ? orig._type : SYNC_ID, ...orig }
  const mutations = operations.map(op => ({ patch: { id: docId, ...op } }))
  const applied = new SanityMutation({ mutations }).apply(withMeta as { _id: string; _type: string })

  if (!applied) return doc

  const result = applied as MutableRecord

  // Strip metadata we injected; preserve what was already there.
  // @sanity/mutator adds _rev and _updatedAt on apply.
  if (!hadId) delete result._id
  if (!hadType) delete result._type
  if (!hadRev) delete result._rev
  if (!hadUpdatedAt) delete result._updatedAt
  if (hadId) result._id = orig._id
  if (hadType) result._type = orig._type

  return result
}
