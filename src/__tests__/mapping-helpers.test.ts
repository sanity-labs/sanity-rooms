import { describe, expect, it } from 'vitest'
import { replaceMapping } from '../mapping-helpers'

describe('replaceMapping', () => {
  const mapping = replaceMapping<{ value: number; title?: string }>('test')

  it('strips Sanity system fields on read', () => {
    const state = mapping.fromSanity({
      _id: 'doc-1',
      _type: 'test',
      _rev: 'abc',
      _createdAt: '2026-01-01',
      _updatedAt: '2026-01-02',
      value: 42,
      title: 'hello',
    })
    expect(state).toEqual({ value: 42, title: 'hello' })
  })

  it('omits Sanity system fields on write', () => {
    const result = mapping.toSanityPatch({ value: 1, title: 't' } as any)
    expect(result.patch).toEqual({ value: 1, title: 't' })
    expect(result.patch).not.toHaveProperty('_id')
    expect(result.patch).not.toHaveProperty('_rev')
  })

  it('accepts replace mutations', () => {
    const next = mapping.applyMutation({ value: 0 }, { kind: 'replace', state: { value: 99 } })
    expect(next).toEqual({ value: 99 })
  })

  it('rejects non-replace mutations', () => {
    const next = mapping.applyMutation({ value: 0 }, { kind: 'sanityPatch', operations: [] })
    expect(next).toBeNull()
  })

  it('exposes documentType', () => {
    expect(mapping.documentType).toBe('test')
  })
})
