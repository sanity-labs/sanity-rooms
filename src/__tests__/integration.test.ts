/**
 * Integration tests — full round-trip: SyncClient ↔ Room via MemoryTransport.
 * No mocking of sync internals — tests the complete data flow.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Room, type RoomConfig } from '../server/room'
import { SyncClient } from '../client/sync-client'
import { createMockSanity } from '../testing/mock-sanity'

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
    documents: {
      counter: {
        docId: 'counter-1',
        mapping: counterMapping,
        initialState: { value: initialValue },
      },
    },
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
  it('single client happy path: mutate → optimistic → ack', async () => {
    const { room } = setup(0)
    const { syncClient } = connectSyncClient(room, 0)
    await flushMicrotasks()

    // Client receives initial state from room
    expect(syncClient.getDocState('counter')).toEqual({ value: 0 })

    // Mutate
    syncClient.mutate('counter', { kind: 'replace', state: { value: 42 } })

    // Optimistic: local state updated immediately
    expect(syncClient.getDocState('counter')).toEqual({ value: 42 })

    // Wait for round-trip
    await flushMicrotasks()

    // Still 42 after server processes
    expect(syncClient.getDocState('counter')).toEqual({ value: 42 })

    // Room also has updated state
    expect(room.getDocState('counter')).toEqual({ value: 42 })

    syncClient.dispose()
    await room.dispose()
  })

  it('two clients: A mutates → B sees update', async () => {
    const { room } = setup(0)
    const a = connectSyncClient(room, 0)
    const b = connectSyncClient(room, 0)
    await flushMicrotasks()

    // A mutates
    a.syncClient.mutate('counter', { kind: 'replace', state: { value: 100 } })
    await flushMicrotasks()
    await flushMicrotasks() // extra flush for message relay

    // B sees the update
    expect(b.syncClient.getDocState('counter')).toEqual({ value: 100 })

    a.syncClient.dispose()
    b.syncClient.dispose()
    await room.dispose()
  })

  it('external Sanity edit → both clients updated', async () => {
    const { room, mock } = setup(0)
    const a = connectSyncClient(room, 0)
    const b = connectSyncClient(room, 0)
    await flushMicrotasks()

    // External edit in Sanity
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

    // A sends app message
    a.syncClient.sendApp('chat', { text: 'hello' })
    await flushMicrotasks()
    await flushMicrotasks()

    // Server handler called
    expect(serverHandler).toHaveBeenCalled()

    // Both clients receive broadcast (handler doesn't exclude)
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

    // A mutates
    a.syncClient.mutate('counter', { kind: 'replace', state: { value: 50 } })
    await flushMicrotasks()

    // A disconnects
    a.syncClient.dispose()

    // B connects — should get current state (50)
    const b = connectSyncClient(room, 0) // starts with 0
    await flushMicrotasks()
    await flushMicrotasks()

    // B receives the room's current state
    expect(b.syncClient.getDocState('counter')).toEqual({ value: 50 })

    b.syncClient.dispose()
    await room.dispose()
  })

  it('room lifecycle: grace period → dispose → manager cleanup', async () => {
    vi.useFakeTimers()
    const { room } = setup(0)
    const onEmpty = vi.fn()
    room.onEmpty = onEmpty

    const { server } = createMemoryTransportPair()
    const clientId = room.addClient(server)

    room.removeClient(clientId)
    expect(onEmpty).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(onEmpty).toHaveBeenCalled()
  })

  it('mutation to Sanity: patches arrive via mock', async () => {
    const { room, mock } = setup(10)
    const a = connectSyncClient(room, 10)
    await flushMicrotasks()

    a.syncClient.mutate('counter', { kind: 'replace', state: { value: 25 } })
    await flushMicrotasks()

    // Verify Sanity received the patch
    const patches = mock.getPatches('counter-1')
    expect(patches.length).toBeGreaterThanOrEqual(1)
    expect(patches[patches.length - 1]).toEqual({ value: 25 })

    a.syncClient.dispose()
    await room.dispose()
  })
})
