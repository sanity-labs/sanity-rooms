import { describe, it, expect, vi } from 'vitest'
import { RoomManager } from '../server/room-manager'
import { createMockSanity } from '../testing/mock-sanity'

import { createMemoryTransportPair } from '../testing/memory-transport'
import type { RoomFactory } from '../server/room-manager'
import type { RoomConfig } from '../server/room'
import type { DocumentMapping } from '../mapping'

const testMapping: DocumentMapping<{ value: number }> = {
  documentType: 'test',
  fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
  toSanityPatch(state) { return { patch: { value: state.value } } },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as { value: number }
    return null
  },
}

function makeFactory(shouldCreate = true): RoomFactory {
  return {
    async create(roomId): Promise<RoomConfig | null> {
      if (!shouldCreate) return null
      return {
        documents: {
          main: { docId: roomId, mapping: testMapping, initialState: { value: 0 } },
        },
        gracePeriodMs: 50,
      }
    },
  }
}

describe('RoomManager', () => {
  it('creates a room via factory', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())

    const room = await manager.getOrCreate('room-1')
    expect(room).not.toBeNull()
    expect(room!.clientCount).toBe(0)

    await manager.dispose()
  })

  it('returns existing room on second call', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())

    const room1 = await manager.getOrCreate('room-1')
    const room2 = await manager.getOrCreate('room-1')
    expect(room1).toBe(room2)

    await manager.dispose()
  })

  it('deduplicates concurrent creation', async () => {
    const mock = createMockSanity()
    const createFn = vi.fn(makeFactory().create)
    const manager = new RoomManager(mock.instance, mock.resource, { create: createFn })

    const [room1, room2] = await Promise.all([
      manager.getOrCreate('room-1'),
      manager.getOrCreate('room-1'),
    ])

    expect(room1).toBe(room2)
    expect(createFn).toHaveBeenCalledTimes(1)

    await manager.dispose()
  })

  it('returns null when factory rejects', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory(false))

    const room = await manager.getOrCreate('room-1')
    expect(room).toBeNull()

    await manager.dispose()
  })

  it('get returns existing or undefined', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())

    expect(manager.get('room-1')).toBeUndefined()

    await manager.getOrCreate('room-1')
    expect(manager.get('room-1')).toBeDefined()

    await manager.dispose()
  })

  it('removes room from manager when it empties', async () => {
    vi.useFakeTimers()
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())

    const room = await manager.getOrCreate('room-1')
    expect(manager.get('room-1')).toBeDefined()

    // Add and remove a client to trigger grace period
    const { server } = createMemoryTransportPair()
    room!.addClient(server)
    room!.removeClient(server.clientId)

    vi.advanceTimersByTime(100)
    expect(manager.get('room-1')).toBeUndefined()

    vi.useRealTimers()
    await manager.dispose()
  })
})
