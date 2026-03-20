/**
 * Room ref-following tests — verifies that custom resources survive
 * the full round-trip: client mutation → Room → SDK echo → fromSanityWithRefs.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock @sanity/sdk — must use dynamic import in factory to avoid hoisting issues
vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { Room } from '../server/room'
import { createMockSanity } from '../testing/mock-sanity'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import type { DocumentMapping, RefDescriptor, SanityPatchResult } from '../mapping'
import type { ServerMsg } from '../protocol'

// ── Test mappings ───────────────────────────────────────────────────────────

interface TestConfig {
  value: number
  items?: Array<{ name: string; data: string }>
}

const itemMapping: DocumentMapping<Record<string, unknown>> = {
  documentType: 'item',
  fromSanity(doc) { return doc },
  toSanityPatch(state) { return { patch: state } },
  applyMutation(_state, mutation) {
    return mutation.kind === 'replace' ? mutation.state as Record<string, unknown> : null
  },
}

const testMapping: DocumentMapping<TestConfig> = {
  documentType: 'test',
  fromSanity(doc) {
    return { value: Number(doc.value ?? 0), items: (doc.items ?? []) as any[] }
  },
  toSanityPatch(state): SanityPatchResult {
    // Split items into refs + separate docs (like configToSanity does)
    const refs = (state.items ?? []).map((item, i) => ({
      _ref: `item-${item.name}`,
      _key: `k${i}`,
      _type: 'reference',
    }))
    const refPatches: Record<string, Record<string, unknown>> = {}
    for (const item of state.items ?? []) {
      refPatches[`item-item-${item.name}`] = { name: item.name, data: item.data }
    }
    return {
      patch: { value: state.value, items: refs.length ? refs : undefined },
      ...(Object.keys(refPatches).length > 0 && { refPatches }),
    }
  },
  applyMutation(_state, mutation) {
    return mutation.kind === 'replace' ? mutation.state as TestConfig : null
  },
  resolveRefs(doc) {
    const refs: RefDescriptor[] = []
    for (const r of (doc.items ?? []) as any[]) {
      if (r?._ref) refs.push({ key: `item-${r._ref}`, docId: r._ref, mapping: itemMapping })
    }
    return refs
  },
  fromSanityWithRefs(doc, refDocs) {
    const items: TestConfig['items'] = []
    for (const r of (doc.items ?? []) as any[]) {
      if (r?._ref) {
        const refDoc = refDocs.get(`item-${r._ref}`)
        if (refDoc) items.push({ name: refDoc.name as string, data: refDoc.data as string })
      }
    }
    return { value: Number(doc.value ?? 0), items }
  },
}

// ── Tests ───────────────────────────────────────────────────────────────────

function connectClient(room: Room) {
  const { client, server } = createMemoryTransportPair()
  const received: ServerMsg[] = []
  client.onMessage((m) => received.push(m as ServerMsg))
  room.addClient(server)
  return { client, received }
}

describe('Room with refs', () => {
  it('client mutation with items → items survive SDK echo', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const room = new Room(
      {
        documents: {
          main: { docId: 'doc-1', mapping: testMapping },
        },
      },
      mock.instance,
      mock.resource,
    )

    await flushMicrotasks()

    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // Client sends config with items (like adding a custom background)
    c1.client.send({
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'mut-1',
      mutation: {
        kind: 'replace',
        state: {
          value: 2,
          items: [{ name: 'item-1', data: 'shader code' }],
        },
      },
    })
    await flushMicrotasks()
    await flushMicrotasks()
    await flushMicrotasks()

    // Room should have the items in its state
    const state = room.getDocState<TestConfig>('main')
    expect(state.value).toBe(2)
    expect(state.items).toHaveLength(1)
    expect(state.items![0].name).toBe('item-1')
    expect(state.items![0].data).toBe('shader code')

    await room.dispose()
  })

  it('second client receives state with items after first client mutates', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: testMapping } } },
      mock.instance,
      mock.resource,
    )
    await flushMicrotasks()

    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // Client 1 adds items
    c1.client.send({
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'mut-1',
      mutation: { kind: 'replace', state: { value: 2, items: [{ name: 'item-1', data: 'code' }] } },
    })
    await flushMicrotasks()
    await flushMicrotasks()

    // Client 2 joins — should get state with items
    const c2 = connectClient(room)
    await flushMicrotasks()

    const stateMsg = c2.received.find((m) => m.type === 'state' && (m as any).channel === 'doc:main')
    expect(stateMsg).toBeDefined()
    const state = (stateMsg as any).state as TestConfig
    expect(state.items).toHaveLength(1)
    expect(state.items![0].name).toBe('item-1')
    expect(state.items![0].data).toBe('code')

    await room.dispose()
  })

  it('mutateDoc (server-side) preserves items', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: testMapping } } },
      mock.instance,
      mock.resource,
    )
    await flushMicrotasks()

    room.mutateDoc('main', {
      kind: 'replace',
      state: { value: 3, items: [{ name: 'bg-1', data: 'shader' }] },
    })

    const state = room.getDocState<TestConfig>('main')
    expect(state.value).toBe(3)
    expect(state.items).toHaveLength(1)
    expect(state.items![0].name).toBe('bg-1')

    // Wait for SDK echo — state should NOT be overwritten
    await flushMicrotasks()
    await flushMicrotasks()
    await flushMicrotasks()

    const stateAfterEcho = room.getDocState<TestConfig>('main')
    expect(stateAfterEcho.items).toHaveLength(1)
    expect(stateAfterEcho.items![0].data).toBe('shader')

    await room.dispose()
  })

  it('own-write echo is skipped via rev tracking', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: testMapping } } },
      mock.instance,
      mock.resource,
    )
    await flushMicrotasks()

    // Mutate via mutateDoc — this writes to SDK and tracks the rev
    room.mutateDoc('main', {
      kind: 'replace',
      state: { value: 2, items: [{ name: 'bg-1', data: 'shader' }] },
    })

    expect(room.getDocState<TestConfig>('main').items![0].data).toBe('shader')

    // Let the write complete and SDK echo arrive
    await flushMicrotasks()
    await flushMicrotasks()
    await flushMicrotasks()

    // State should STILL have full items — echo was skipped because rev matched
    const stateAfter = room.getDocState<TestConfig>('main')
    expect(stateAfter.items).toHaveLength(1)
    expect(stateAfter.items![0].data).toBe('shader')
  })

  it('external edit on ref doc triggers re-assembly', async () => {
    const mock = createMockSanity({
      'doc-1': { value: 1, items: [{ _ref: 'item-x', _key: 'k1', _type: 'reference' }] },
      'item-x': { name: 'x', data: 'original' },
    })

    const room = new Room(
      {
        documents: {
          main: {
            docId: 'doc-1',
            mapping: testMapping,
          },
        },
      },
      mock.instance,
      mock.resource,
    )

    await flushMicrotasks()
    await flushMicrotasks()
    await flushMicrotasks()

    // External edit on ref doc
    mock.simulateExternalEdit('item-x', { name: 'x', data: 'updated-externally' })
    await flushMicrotasks()
    await flushMicrotasks()

    const state = room.getDocState<TestConfig>('main')
    expect(state.items).toHaveLength(1)
    expect(state.items![0].data).toBe('updated-externally')

    await room.dispose()
  })
})
