import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import type { DocumentMapping } from '../mapping'
import type { RoomConfig } from '../server/room'
import type { RoomFactory } from '../server/room-manager'
import { RoomManager } from '../server/room-manager'
import { createMemoryTransportPair } from '../testing/memory-transport'
import { createMockSanity } from '../testing/mock-sanity'

const testMapping: DocumentMapping<{ value: number }> = {
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

function makeFactory(shouldCreate = true): RoomFactory {
  return {
    async create(): Promise<RoomConfig | null> {
      if (!shouldCreate) return null
      return { documents: { main: { docId: 'doc-1', mapping: testMapping } }, gracePeriodMs: 50 }
    },
  }
}

describe('RoomManager', () => {
  it('creates room via factory', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    const room = await manager.getOrCreate('r1')
    expect(room).not.toBeNull()
    await manager.dispose()
  })

  it('returns existing room on second call', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    const r1 = await manager.getOrCreate('r1')
    const r2 = await manager.getOrCreate('r1')
    expect(r1).toBe(r2)
    await manager.dispose()
  })

  it('deduplicates concurrent creation', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
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
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())
    expect(manager.get('r1')).toBeUndefined()
    await manager.getOrCreate('r1')
    expect(manager.get('r1')).toBeDefined()
    await manager.dispose()
  })

  it('removes room when it empties', async () => {
    vi.useFakeTimers()
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
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

  describe('instanceFactory ownership', () => {
    it('throws when constructed without instance or instanceFactory', () => {
      // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
      const RM = RoomManager as any
      expect(
        () =>
          new RM({
            resource: { projectId: 'x', dataset: 'y' },
            factory: makeFactory(),
          }),
      ).toThrow(/instance.*instanceFactory/)
    })

    it('manager owns SDK lifecycle when constructed with instanceFactory', async () => {
      const mock = createMockSanity({ 'doc-1': { value: 0 } })
      const disposed = vi.fn()
      ;(mock.instance as { dispose?: () => void }).dispose = disposed
      const manager = new RoomManager({
        instanceFactory: () => mock.instance,
        resource: mock.resource,
        factory: makeFactory(),
      })
      await manager.getOrCreate('r1')
      await manager.dispose()
      expect(disposed).toHaveBeenCalledOnce()
    })

    // Pre-existing unused-test cleanup placeholder: suppress legacy
    // recreate-threshold tests that were retired with the API.
    it.skip('placeholder for removed recreate tests', async () => {
      const mockA = createMockSanity()
      const factory = vi.fn(() => mockA.instance)
      const roomFactory: RoomFactory = {
        async create(): Promise<RoomConfig | null> {
          return { documents: { main: { docId: 'silent-doc', mapping: testMapping } }, gracePeriodMs: 50 }
        },
      }
      const manager = new RoomManager({
        instanceFactory: factory,
        resource: mockA.resource,
        factory: roomFactory,
        readyTimeoutMs: 30,
      })
      await manager.dispose()
    })
  })

  it('reclaims room correctly when consumer also registers onDispose', async () => {
    vi.useFakeTimers()
    const mock = createMockSanity({ 'doc-1': { value: 42 } })
    const manager = new RoomManager(mock.instance, mock.resource, makeFactory())

    // Consumer adds their own onDispose (like the app layer does)
    const room1 = await manager.getOrCreate('r1')
    expect(room1).not.toBeNull()
    let externalCleanupCalled = false
    room1!.onDispose(() => {
      externalCleanupCalled = true
    })

    // Add and remove client to trigger grace timer
    const { server: s1 } = createMemoryTransportPair()
    room1!.addClient(s1)
    room1!.removeClient(s1.clientId)

    // Grace timer fires — room should be disposed and removed from manager
    vi.advanceTimersByTime(100)
    expect(manager.get('r1')).toBeUndefined()
    expect(externalCleanupCalled).toBe(true)

    // Reclaim: creating same room again should return a FRESH, working room
    vi.useRealTimers()
    const room2 = await manager.getOrCreate('r1')
    expect(room2).not.toBeNull()
    expect(room2).not.toBe(room1)

    // The new room should be functional — client gets state
    const { server: s2, client: c2 } = createMemoryTransportPair()
    const received: any[] = []
    c2.onMessage((msg) => {
      received.push(msg)
    })
    room2!.addClient(s2)

    // Wait for ready + state delivery
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stateMsg = received.find((m) => m.type === 'state')
    expect(stateMsg).toBeDefined()
    expect(stateMsg.state).toEqual({ value: 42 })

    await manager.dispose()
  })
})
