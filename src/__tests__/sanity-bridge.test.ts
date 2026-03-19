/**
 * SanityBridge tests — verifies the raw document store behavior.
 * Bridge stores raw docs and writes raw patches. No domain mapping.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockSanity, createSdkMocks } from '../testing/mock-sanity'
import { flushMicrotasks } from '../testing/memory-transport'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

const { SanityBridge } = await import('../server/sanity-bridge')

describe('SanityBridge', () => {
  it('notifies onChange when doc changes', async () => {
    const mock = createMockSanity({ 'doc-1': { title: 'Hello' } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange,
    })

    await flushMicrotasks()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: 'Hello' }))

    mock.simulateExternalEdit('doc-1', { title: 'Updated' })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated' }))

    bridge.dispose()
  })

  it('getRawDoc returns current state', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 42 } })

    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })

    await flushMicrotasks()
    expect(bridge.getRawDoc()).toEqual(expect.objectContaining({ value: 42 }))

    bridge.dispose()
  })

  it('write sends patches to SDK', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })

    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })

    bridge.write({ value: 2 })
    await flushMicrotasks()

    const patches = mock.getPatches('doc-1')
    expect(patches.length).toBeGreaterThanOrEqual(1)
    expect(patches[patches.length - 1]).toEqual(expect.objectContaining({ value: 2 }))

    bridge.dispose()
  })

  it('dispose stops notifications', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const onChange = vi.fn()

    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange,
    })

    await flushMicrotasks()
    onChange.mockClear()
    bridge.dispose()

    mock.simulateExternalEdit('doc-1', { value: 99 })
    expect(onChange).not.toHaveBeenCalled()
  })
})
