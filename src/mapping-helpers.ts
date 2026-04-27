/**
 * Mapping helpers for the common cases. Saves apps from rewriting
 * fromSanity/toSanityPatch/applyMutation by hand for every doc when
 * the domain shape IS the Sanity shape.
 */

import type { DocumentMapping } from './mapping'
import type { Mutation } from './mutation'

/**
 * Build a DocumentMapping for the "domain shape == Sanity shape" case.
 * Strips Sanity system fields (`_id`, `_type`, `_rev`, `_createdAt`,
 * `_updatedAt`) on read, omits them from the patch on write. Accepts
 * `replace` mutations only.
 *
 * Use when your app stores a doc as-is and doesn't need a derived
 * domain projection. For anything more sophisticated (refs, computed
 * fields), implement `DocumentMapping` directly.
 */
export function replaceMapping<T extends Record<string, unknown>>(
  documentType: string,
): DocumentMapping<T> {
  return {
    documentType,
    fromSanity(doc) {
      return stripSystemFields(doc) as T
    },
    toSanityPatch(state) {
      return { patch: stripSystemFields(state as Record<string, unknown>) }
    },
    applyMutation(_state, mutation: Mutation) {
      if (mutation.kind === 'replace') return mutation.state as T
      return null
    },
  }
}

const SYSTEM_FIELDS = new Set(['_id', '_type', '_rev', '_createdAt', '_updatedAt'])

function stripSystemFields(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(doc)) {
    if (!SYSTEM_FIELDS.has(k)) out[k] = doc[k]
  }
  return out
}
