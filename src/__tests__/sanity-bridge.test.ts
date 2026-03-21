import { describe, it, expect, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { createMockSanity } from '../testing/mock-sanity'
import { SanityBridge } from '../server/sanity-bridge'
import { flushMicrotasks } from '../testing/memory-transport'

describe('SanityBridge', () => {
  it('calls onChange when doc changes', async () => {
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
    expect(bridge.getRawDoc()).toEqual(expect.objectContaining({ title: 'Updated' }))

    bridge.dispose()
  })

  it('strips drafts. prefix from docId', () => {
    const mock = createMockSanity()
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'drafts.my-doc',
      documentType: 'test',
      onChange: () => {},
    })
    expect(bridge.docId).toBe('my-doc')
    bridge.dispose()
  })

  it('write sends patches', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    bridge.write({ value: 2 })
    await flushMicrotasks()

    expect(mock.getPatches('doc-1').length).toBeGreaterThanOrEqual(1)
    bridge.dispose()
  })

  it('buffers writes until ready', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })

    // Write before first emit
    bridge.write({ value: 99 })
    expect(mock.getPatches('doc-1')).toHaveLength(0)

    // First emit triggers flush
    await flushMicrotasks()
    expect(mock.getPatches('doc-1').length).toBeGreaterThanOrEqual(1)

    bridge.dispose()
  })

  it('write with refDocs uses editDocument not createDocument (Bug #3)', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 }, 'ref-1': { name: 'existing' } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    // Write main doc + ref doc (ref doc already exists as draft)
    bridge.write(
      { value: 2 },
      [{ docId: 'ref-1', documentType: 'customFont', content: { name: 'updated' } }],
    )
    await flushMicrotasks()

    // Main doc should be updated
    expect(mock.getDoc('doc-1')?.value).toBe(2)
    // Ref doc should be updated (not fail because it already exists)
    expect(mock.getDoc('ref-1')?.name).toBe('updated')
    bridge.dispose()
  })

  it('dispose stops onChange', async () => {
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
