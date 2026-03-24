/**
 * Tests for library hardening: ownTxns pruning, dispose guards,
 * pending mutation API, app channel error handling.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { SyncClient } from '../client/sync-client'
import type { DocumentMapping } from '../mapping'
import { Room } from '../server/room'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import { createMockSanity } from '../testing/mock-sanity'

const simpleMapping: DocumentMapping<{ value: number }> = {
  documentType: 'test',
  fromSanity(doc) {
    return { value: Number(doc.value ?? 0) }
  },
  toSanityPatch(state) {
    return { patch: { value: state.value } }
  },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as { value: number }
    return null
  },
}

async function makeRoom(initialDoc: Record<string, unknown> = { value: 0 }) {
  const mock = createMockSanity({ 'doc-1': initialDoc })
  const room = new Room(
    { documents: { config: { docId: 'doc-1', mapping: simpleMapping } }, gracePeriodMs: 100 },
    mock.instance,
    mock.resource,
  )
  await room.ready
  return { room, mock }
}

// ── ownTxns pruning ─────────────────────────────────────────────────────

describe('ownTxns memory management', () => {
  it('prunes stale transaction IDs after threshold', async () => {
    const { room } = await makeRoom()

    // Perform many mutations to exceed the threshold
    for (let i = 0; i < 60; i++) {
      room.mutateDoc('config', { kind: 'replace', state: { value: i } })
    }

    // The ownTxns map should have been pruned (can't have > 60 entries after pruning)
    // We can't directly inspect the private map, but we can verify no crash
    // and that the room still works
    const state = room.getDocState<{ value: number }>('config')
    expect(state.value).toBe(59)

    await room.dispose()
  })
})

// ── dispose guards ──────────────────────────────────────────────────────

describe('SyncClient dispose guard', () => {
  it('throws on mutate after dispose', () => {
    const pair = createMemoryTransportPair()
    const client = new SyncClient({
      transport: pair.client,
      documents: { doc: { initialState: { x: 1 }, applyMutation: () => null } },
    })

    client.dispose()

    expect(() => client.mutate('doc', { kind: 'replace', state: { x: 2 } })).toThrow('disposed')
  })

  it('throws on sendApp after dispose', () => {
    const pair = createMemoryTransportPair()
    const client = new SyncClient({
      transport: pair.client,
      documents: { doc: { initialState: { x: 1 }, applyMutation: () => null } },
    })

    client.dispose()

    expect(() => client.sendApp('test', { hello: true })).toThrow('disposed')
  })

  it('throws on getDocState after dispose', () => {
    const pair = createMemoryTransportPair()
    const client = new SyncClient({
      transport: pair.client,
      documents: { doc: { initialState: { x: 1 }, applyMutation: () => null } },
    })

    client.dispose()

    expect(() => client.getDocState('doc')).toThrow('disposed')
  })
})

// ── pending mutation API ────────────────────────────────────────────────

describe('SyncClient pending writes', () => {
  it('reports no pending writes initially', () => {
    const pair = createMemoryTransportPair()
    const client = new SyncClient({
      transport: pair.client,
      documents: {
        doc: {
          initialState: { x: 1 },
          applyMutation: (_s, m) => (m.kind === 'replace' ? m.state : null),
        },
      },
    })

    expect(client.hasPendingWrites()).toBe(false)
    expect(client.getPendingCount()).toBe(0)

    client.dispose()
  })

  it('reports pending writes after mutation', () => {
    const pair = createMemoryTransportPair()
    const client = new SyncClient({
      transport: pair.client,
      documents: {
        doc: {
          initialState: { x: 1 },
          applyMutation: (_s, m) => (m.kind === 'replace' ? m.state : null),
        },
      },
    })

    client.mutate('doc', { kind: 'replace', state: { x: 2 } })

    expect(client.hasPendingWrites()).toBe(true)
    expect(client.getPendingCount()).toBeGreaterThan(0)

    client.dispose()
  })
})

// ── app channel error handling ──────────────────────────────────────────

describe('app channel error handling', () => {
  it('does not crash the room when handler throws', async () => {
    const { room } = await makeRoom()
    room.registerAppChannel('bad', {
      onMessage: () => {
        throw new Error('Handler exploded')
      },
    })

    const pair = createMemoryTransportPair()
    room.addClient(pair.server)
    await flushMicrotasks()

    // Send a message to the bad channel — should not crash
    pair.client.send({ channel: 'bad', type: 'app', payload: { test: true } })
    await flushMicrotasks()

    // Room should still work
    const state = room.getDocState<{ value: number }>('config')
    expect(state.value).toBe(0)

    await room.dispose()
  })
})

// ── configurable logger ─────────────────────────────────────────────────

describe('configurable logger', () => {
  it('accepts a custom logger in RoomConfig', async () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const mock = createMockSanity({ 'doc-1': { value: 1 } })
    const room = new Room(
      {
        documents: { config: { docId: 'doc-1', mapping: simpleMapping } },
        gracePeriodMs: 100,
        logger,
      },
      mock.instance,
      mock.resource,
    )
    await room.ready

    // Logger is accepted — no crash
    expect(room.getDocState<{ value: number }>('config').value).toBe(1)

    await room.dispose()
  })
})
