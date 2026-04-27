import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { SanityBridge } from '../server/sanity-bridge'
import { flushMicrotasks } from '../testing/memory-transport'
import { createMockSanity } from '../testing/mock-sanity'

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

  it('write with existing ref doc edits without creating', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 }, 'ref-1': { name: 'existing' } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    // Tell the bridge ref-1 already exists in Sanity
    bridge.markRefDocKnown('ref-1')

    bridge.write({ value: 2 }, [{ docId: 'ref-1', documentType: 'customFont', content: { name: 'updated' } }])
    await flushMicrotasks()

    expect(mock.getDoc('doc-1')?.value).toBe(2)
    expect(mock.getDoc('ref-1')?.name).toBe('updated')
    bridge.dispose()
  })

  it('write with new ref doc creates then edits transparently', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    // ref doc doesn't exist — bridge should create + edit automatically
    bridge.write({ value: 2 }, [{ docId: 'new-ref', documentType: 'customBackground', content: { name: 'new bg' } }])
    await flushMicrotasks()

    expect(mock.getDoc('doc-1')?.value).toBe(2)
    expect(mock.getDoc('new-ref')?.name).toBe('new bg')
    expect(mock.getDoc('new-ref')?._id).toBe('new-ref')
    bridge.dispose()
  })

  it('second write to same ref doc skips create', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    // First write — creates the ref doc
    bridge.write({ value: 2 }, [{ docId: 'new-ref', documentType: 'customBackground', content: { name: 'v1' } }])
    await flushMicrotasks()
    expect(mock.getDoc('new-ref')?.name).toBe('v1')

    // Second write — should NOT try createDocument again (would throw "already exists")
    bridge.write({ value: 3 }, [{ docId: 'new-ref', documentType: 'customBackground', content: { name: 'v2' } }])
    await flushMicrotasks()
    expect(mock.getDoc('new-ref')?.name).toBe('v2')
    bridge.dispose()
  })

  it('markRefDocKnown prevents unnecessary create on existing docs', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 }, 'ref-1': { name: 'existing' } })
    const bridge = new SanityBridge({
      instance: mock.instance,
      resource: mock.resource,
      docId: 'doc-1',
      documentType: 'test',
      onChange: () => {},
    })
    await flushMicrotasks()

    // Without markRefDocKnown, writing would try createDocument on an existing doc → fail
    // With it, the bridge knows to skip createDocument
    bridge.markRefDocKnown('ref-1')

    bridge.write({ value: 2 }, [{ docId: 'ref-1', documentType: 'customFont', content: { name: 'updated' } }])
    await flushMicrotasks()

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

  describe('stall detection', () => {
    it('fires onStall when SDK never emits within firstEmitTimeoutMs', async () => {
      vi.useFakeTimers()
      const mock = createMockSanity()
      mock.setSilent('missing-doc')
      const onStall = vi.fn()
      const bridge = new SanityBridge({
        instance: mock.instance,
        resource: mock.resource,
        docId: 'missing-doc',
        documentType: 'test',
        onChange: () => {},
        firstEmitTimeoutMs: 5000,
        onStall,
        logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      })
      expect(onStall).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5001)
      expect(onStall).toHaveBeenCalledTimes(1)
      expect(onStall.mock.calls[0]?.[0]).toMatch(/no SDK emit in 5000ms/)
      bridge.dispose()
      vi.useRealTimers()
    })

    it('does NOT fire onStall when doc emits before timeout', async () => {
      vi.useFakeTimers()
      const mock = createMockSanity({ 'doc-ok': { value: 1 } })
      const onStall = vi.fn()
      const bridge = new SanityBridge({
        instance: mock.instance,
        resource: mock.resource,
        docId: 'doc-ok',
        documentType: 'test',
        onChange: () => {},
        firstEmitTimeoutMs: 5000,
        onStall,
      })
      // Microtask delivers the initial state
      await vi.advanceTimersByTimeAsync(0)
      vi.advanceTimersByTime(10000)
      expect(onStall).not.toHaveBeenCalled()
      bridge.dispose()
      vi.useRealTimers()
    })

    it('disabled when firstEmitTimeoutMs is 0', () => {
      vi.useFakeTimers()
      const mock = createMockSanity()
      mock.setSilent('missing')
      const onStall = vi.fn()
      const bridge = new SanityBridge({
        instance: mock.instance,
        resource: mock.resource,
        docId: 'missing',
        documentType: 'test',
        onChange: () => {},
        firstEmitTimeoutMs: 0,
        onStall,
      })
      vi.advanceTimersByTime(60_000)
      expect(onStall).not.toHaveBeenCalled()
      bridge.dispose()
      vi.useRealTimers()
    })
  })

  describe('pending writes cap', () => {
    it('drops oldest buffered write when maxPendingWrites is exceeded', () => {
      const mock = createMockSanity()
      mock.setSilent('stuck')
      let warned = ''
      const bridge = new SanityBridge({
        instance: mock.instance,
        resource: mock.resource,
        docId: 'stuck',
        documentType: 'test',
        onChange: () => {},
        firstEmitTimeoutMs: 0,
        maxPendingWrites: 3,
        logger: {
          error: () => {},
          warn: (msg: unknown) => {
            warned = String(msg)
          },
          info: () => {},
          debug: () => {},
        },
      })
      // 4 writes — first one should be evicted
      bridge.write({ value: 1 })
      bridge.write({ value: 2 })
      bridge.write({ value: 3 })
      bridge.write({ value: 4 })
      expect(warned).toMatch(/pending-writes cap/)
      bridge.dispose()
    })
  })
})
