import { describe, it, expect, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { createMockSanity } from '../testing/mock-sanity'
import { RoomManager } from '../server/room-manager'
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
    async create(): Promise<RoomConfig | null> {
      if (!shouldCreate) return null
      return { documents: { main: { docId: 'doc-1', mapping: testMapping, initialState: { value: 0 } } }, gracePeriodMs: 50 }
    },
  }
}

describe('RoomManager', () => {
  it('creates room via factory', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    const room = await manager.getOrCreate('r1')
    expect(room).not.toBeNull()
    await manager.dispose()
  })

  it('returns existing room on second call', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    const r1 = await manager.getOrCreate('r1')
    const r2 = await manager.getOrCreate('r1')
    expect(r1).toBe(r2)
    await manager.dispose()
  })

  it('deduplicates concurrent creation', async () => {
    const mock = createMockSanity()
    const createFn = vi.fn(makeFactory().create)
    const manager = new RoomManager(mock.instance, mock.resource, { create: createFn })
    const [a, b] = await Promise.all([manager.getOrCreate('r1'), manager.getOrCreate('r1')])
    expect(a).toBe(b)
    expect(createFn).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('returns null when factory rejects', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory(false))
    expect(await manager.getOrCreate('r1')).toBeNull()
    await manager.dispose()
  })

  it('get returns existing or undefined', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    expect(manager.get('r1')).toBeUndefined()
    await manager.getOrCreate('r1')
    expect(manager.get('r1')).toBeDefined()
    await manager.dispose()
  })

  it('removes room when it empties', async () => {
    vi.useFakeTimers()
    const mock = createMockSanity()
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    const room = await manager.getOrCreate('r1')
    const { server } = createMemoryTransportPair()
    room!.addClient(server)
    room!.removeClient(server.clientId)
    vi.advanceTimersByTime(100)
    expect(manager.get('r1')).toBeUndefined()
    vi.useRealTimers()
    await manager.dispose()
  })
})
