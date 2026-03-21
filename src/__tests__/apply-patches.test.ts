import { describe, it, expect } from 'vitest'
import { applySanityPatches } from '../apply-patches'
import type { SanityPatchOperations } from '@sanity/diff-patch'

describe('applySanityPatches', () => {
  it('applies set operations to top-level keys', () => {
    const doc = { a: 1, b: 2 }
    const ops: SanityPatchOperations[] = [{ set: { a: 99 } }]
    expect(applySanityPatches(doc, ops)).toEqual({ a: 99, b: 2 })
  })

  it('applies unset operations', () => {
    const doc = { a: 1, b: 2, c: 3 }
    const ops: SanityPatchOperations[] = [{ unset: ['b'] }]
    const result = applySanityPatches(doc, ops) as Record<string, unknown>
    expect(result.a).toBe(1)
    expect(result.c).toBe(3)
    expect('b' in result).toBe(false)
  })

  it('applies _key-based array patches', () => {
    const doc = {
      items: [
        { _key: 'a', text: 'hello' },
        { _key: 'b', text: 'world' },
      ],
    }
    const ops: SanityPatchOperations[] = [{ set: { 'items[_key=="a"].text': 'HELLO' } }]
    const result = applySanityPatches(doc, ops) as { items: Array<{ _key: string; text: string }> }
    expect(result.items[0].text).toBe('HELLO')
    expect(result.items[1].text).toBe('world')
  })

  it('returns original doc when operations are empty', () => {
    const doc = { a: 1 }
    expect(applySanityPatches(doc, [])).toBe(doc)
  })

  it('returns original doc for null/non-object input', () => {
    expect(applySanityPatches(null, [{ set: { a: 1 } }])).toBe(null)
    expect(applySanityPatches(42, [{ set: { a: 1 } }])).toBe(42)
  })

  it('does not leak _id/_type/_rev into result when not in original', () => {
    const doc = { value: 1 }
    const ops: SanityPatchOperations[] = [{ set: { value: 2 } }]
    const result = applySanityPatches(doc, ops) as Record<string, unknown>
    expect(result.value).toBe(2)
    expect('_id' in result).toBe(false)
    expect('_type' in result).toBe(false)
    expect('_rev' in result).toBe(false)
  })

  it('preserves _id/_type when they existed in original', () => {
    const doc = { _id: 'doc-1', _type: 'test', value: 1 }
    const ops: SanityPatchOperations[] = [{ set: { value: 2 } }]
    const result = applySanityPatches(doc, ops) as Record<string, unknown>
    expect(result._id).toBe('doc-1')
    expect(result._type).toBe('test')
    expect(result.value).toBe(2)
  })
})
