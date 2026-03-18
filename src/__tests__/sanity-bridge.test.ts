import { describe, it, expect, vi } from 'vitest'
import { SanityBridge } from '../server/sanity-bridge'
import { createMockSanity } from '../testing/mock-sanity'
import { flushMicrotasks } from '../testing/memory-transport'
import type { DocumentMapping } from '../mapping'
import type { Mutation } from '../mutation'

// Simple mapping: Sanity doc has { title, count }, app state is same shape
const testMapping: DocumentMapping<{ title: string; count: number }> = {
  documentType: 'test',
  fromSanity(doc) {
    return { title: String(doc.title ?? ''), count: Number(doc.count ?? 0) }
  },
  toSanityPatch(state) {
    return { title: state.title, count: state.count }
  },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as { title: string; count: number }
    return null
  },
}

describe('SanityBridge', () => {
  it('provides initial state', () => {
    const mock = createMockSanity({ 'doc-1': { title: 'Hello', count: 5 } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      adapter: mock.adapter,
      docId: 'doc-1',
      mapping: testMapping,
      initialState: { title: 'Hello', count: 5 },
      onStateChange: onChange,
    })

    expect(bridge.getState()).toEqual({ title: 'Hello', count: 5 })
    bridge.dispose()
  })

  it('updates state when Sanity doc changes externally', async () => {
    const mock = createMockSanity({ 'doc-1': { title: 'Hello', count: 5 } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      adapter: mock.adapter,
      docId: 'doc-1',
      mapping: testMapping,
      initialState: { title: 'Hello', count: 5 },
      onStateChange: onChange,
    })

    await flushMicrotasks() // initial subscription emit

    mock.simulateExternalEdit('doc-1', { title: 'Updated', count: 10 })

    expect(bridge.getState()).toEqual({ title: 'Updated', count: 10 })
    expect(onChange).toHaveBeenCalledWith({ title: 'Updated', count: 10 })
    bridge.dispose()
  })

  it('applies mutations and sends patches to Sanity', () => {
    const mock = createMockSanity({ 'doc-1': { title: 'A', count: 1 } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      adapter: mock.adapter,
      docId: 'doc-1',
      mapping: testMapping,
      initialState: { title: 'A', count: 1 },
      onStateChange: onChange,
    })

    const mutation: Mutation = { kind: 'replace', state: { title: 'B', count: 2 } }
    const result = bridge.applyMutation(mutation)

    expect(result).toEqual({ title: 'B', count: 2 })
    expect(bridge.getState()).toEqual({ title: 'B', count: 2 })

    // Verify patches were sent to mock Sanity
    const patches = mock.getPatches('doc-1')
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ title: 'B', count: 2 })

    bridge.dispose()
  })

  it('returns null for invalid mutations', () => {
    const mock = createMockSanity({ 'doc-1': { title: 'A', count: 1 } })

    const bridge = new SanityBridge({
      adapter: mock.adapter,
      docId: 'doc-1',
      mapping: testMapping,
      initialState: { title: 'A', count: 1 },
      onStateChange: vi.fn(),
    })

    const mutation: Mutation = { kind: 'named', name: 'bad', input: {} }
    const result = bridge.applyMutation(mutation)

    expect(result).toBeNull()
    expect(bridge.getState()).toEqual({ title: 'A', count: 1 })
    expect(mock.getPatches('doc-1')).toHaveLength(0)

    bridge.dispose()
  })

  it('dispose unsubscribes from Sanity', async () => {
    const mock = createMockSanity({ 'doc-1': { title: 'A', count: 1 } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      adapter: mock.adapter,
      docId: 'doc-1',
      mapping: testMapping,
      initialState: { title: 'A', count: 1 },
      onStateChange: onChange,
    })

    await flushMicrotasks()
    onChange.mockClear()

    bridge.dispose()

    mock.simulateExternalEdit('doc-1', { title: 'After', count: 99 })
    expect(onChange).not.toHaveBeenCalled()
  })
})
