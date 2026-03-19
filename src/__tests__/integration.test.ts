/**
 * Integration tests — full round-trip: SyncClient ↔ Room via MemoryTransport.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { createMockSanity } from '../testing/mock-sanity'
import { Room, type RoomConfig } from '../server/room'
import { SyncClient } from '../client/sync-client'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import type { DocumentMapping } from '../mapping'

afterEach(() => { vi.useRealTimers() })

interface Counter { value: number }

const counterMapping: DocumentMapping<Counter> = {
  documentType: 'counter',
  fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
  toSanityPatch(state) { return { patch: { value: state.value } } },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as Counter
    return null
  },
}

function setup(initialValue = 0) {
  const mock = createMockSanity({ 'counter-1': { value: initialValue } })
  const roomConfig: RoomConfig = {
    documents: { counter: { docId: 'counter-1', mapping: counterMapping, initialState: { value: initialValue } } },
    gracePeriodMs: 100,
  }
  const room = new Room(roomConfig, mock.instance, mock.resource)
  return { room, mock }
}

function connectSyncClient(room: Room, initialValue = 0) {
  const { client: transport, server } = createMemoryTransportPair()
  room.addClient(server)
  const syncClient = new SyncClient({
    transport,
    documents: {
      counter: {
        initialState: { value: initialValue },
        applyMutation: counterMapping.applyMutation as (state: unknown, mutation: import('../mutation').Mutation) => unknown | null,
      },
    },
    sendDebounce: { ms: 0, maxWaitMs: 0 },
  })
  return { syncClient, transport }
}

describe('Integration: SyncClient ↔ Room', () => {
  it('single client: mutate → optimistic → ack', async () => {
    const { room } = setup(0)
    const { syncClient } = connectSyncClient(room, 0)
    await flushMicrotasks()

    syncClient.mutate('counter', { kind: 'replace', state: { value: 42 } })
    expect(syncClient.getDocState('counter')).toEqual({ value: 42 })

    await flushMicrotasks()
    expect(syncClient.getDocState('counter')).toEqual({ value: 42 })
    expect(room.getDocState('counter')).toEqual({ value: 42 })

    syncClient.dispose()
    await room.dispose()
  })

  it('two clients: A mutates → B sees update', async () => {
    const { room } = setup(0)
    const a = connectSyncClient(room, 0)
    const b = connectSyncClient(room, 0)
    await flushMicrotasks()

    a.syncClient.mutate('counter', { kind: 'replace', state: { value: 100 } })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(b.syncClient.getDocState('counter')).toEqual({ value: 100 })

    a.syncClient.dispose()
    b.syncClient.dispose()
    await room.dispose()
  })

  it('external edit → both clients updated', async () => {
    const { room, mock } = setup(0)
    const a = connectSyncClient(room, 0)
    const b = connectSyncClient(room, 0)
    await flushMicrotasks()

    mock.simulateExternalEdit('counter-1', { value: 999 })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(a.syncClient.getDocState('counter')).toEqual({ value: 999 })
    expect(b.syncClient.getDocState('counter')).toEqual({ value: 999 })

    a.syncClient.dispose()
    b.syncClient.dispose()
    await room.dispose()
  })

  it('app channel round-trip', async () => {
    const { room } = setup(0)
    const serverHandler = vi.fn((_clientId: string, payload: unknown, r: Room) => {
      r.broadcastApp('chat', { echo: payload })
    })
    room.registerAppChannel('chat', { onMessage: serverHandler })

    const a = connectSyncClient(room, 0)
    const b = connectSyncClient(room, 0)
    await flushMicrotasks()

    const aReceived: unknown[] = []
    const bReceived: unknown[] = []
    a.syncClient.onApp('chat', (p) => aReceived.push(p))
    b.syncClient.onApp('chat', (p) => bReceived.push(p))

    a.syncClient.sendApp('chat', { text: 'hello' })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(serverHandler).toHaveBeenCalled()
    expect(aReceived).toContainEqual({ echo: { text: 'hello' } })
    expect(bReceived).toContainEqual({ echo: { text: 'hello' } })

    a.syncClient.dispose()
    b.syncClient.dispose()
    await room.dispose()
  })

  it('reconnection: new client receives current state', async () => {
    const { room } = setup(0)
    const a = connectSyncClient(room, 0)
    await flushMicrotasks()

    a.syncClient.mutate('counter', { kind: 'replace', state: { value: 50 } })
    await flushMicrotasks()
    a.syncClient.dispose()

    const b = connectSyncClient(room, 0)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(b.syncClient.getDocState('counter')).toEqual({ value: 50 })

    b.syncClient.dispose()
    await room.dispose()
  })
})
