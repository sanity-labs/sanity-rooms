import { describe, expect, it } from 'vitest'
import { immutableReconcile } from '../reconcile'

describe('immutableReconcile', () => {
  it('returns prev when data is identical', () => {
    const prev = { a: 1, b: { c: 2 } }
    const curr = { a: 1, b: { c: 2 } }
    const result = immutableReconcile(prev, curr)
    expect(result).toBe(prev)
  })

  it('returns curr when data differs', () => {
    const prev = { a: 1 }
    const curr = { a: 2 }
    const result = immutableReconcile(prev, curr)
    expect(result).not.toBe(prev)
    expect(result).toEqual({ a: 2 })
  })

  it('preserves unchanged nested object refs', () => {
    const nested = { c: 3, d: 4 }
    const prev = { a: 1, b: nested }
    const curr = { a: 2, b: { c: 3, d: 4 } }
    const result = immutableReconcile(prev, curr)
    expect(result.b).toBe(nested)
    expect(result.a).toBe(2)
  })

  it('handles arrays — preserves unchanged element refs', () => {
    const item = { id: 1, name: 'foo' }
    const prev = [item, { id: 2, name: 'bar' }]
    const curr = [
      { id: 1, name: 'foo' },
      { id: 2, name: 'baz' },
    ]
    const result = immutableReconcile(prev, curr)
    expect(result[0]).toBe(item)
    expect(result[1]).not.toBe(prev[1])
  })

  it('handles array length change', () => {
    const prev = [{ a: 1 }, { a: 2 }]
    const curr = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const result = immutableReconcile(prev, curr)
    expect(result[0]).toBe(prev[0])
    expect(result[1]).toBe(prev[1])
    expect(result).toHaveLength(3)
  })

  it('handles null prev', () => {
    const curr = { a: 1 }
    expect(immutableReconcile(null, curr)).toBe(curr)
  })

  it('handles primitives', () => {
    expect(immutableReconcile(1, 2)).toBe(2)
    expect(immutableReconcile('a', 'a')).toBe('a')
  })

  it('handles key removal', () => {
    const prev = { a: 1, b: 2 } as Record<string, number>
    const curr = { a: 1 }
    const result = immutableReconcile(prev, curr)
    expect(result).not.toBe(prev)
    expect(result).toEqual({ a: 1 })
  })
})
