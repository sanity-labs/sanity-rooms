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
      return {
        instanceKey: 'test',
        documents: { main: { docId: 'doc-1', mapping: testMapping } },
        gracePeriodMs: 50,
      }
    },
  }
}

describe('RoomManager', () => {
  it('creates room via factory', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })
    const room = await manager.getOrCreate('r1')
    expect(room).not.toBeNull()
    await manager.dispose()
  })

  it('returns existing room on second call', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })
    const r1 = await manager.getOrCreate('r1')
    const r2 = await manager.getOrCreate('r1')
    expect(r1).toBe(r2)
    await manager.dispose()
  })

  it('deduplicates concurrent creation', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const createFn = vi.fn(makeFactory().create)
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: { create: createFn },
    })
    const [a, b] = await Promise.all([manager.getOrCreate('r1'), manager.getOrCreate('r1')])
    expect(a).toBe(b)
    expect(createFn).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })

  it('returns null when factory rejects', async () => {
    const mock = createMockSanity()
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(false),
    })
    expect(await manager.getOrCreate('r1')).toBeNull()
    await manager.dispose()
  })

  it('get returns existing or undefined', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })
    expect(manager.get('r1')).toBeUndefined()
    await manager.getOrCreate('r1')
    expect(manager.get('r1')).toBeDefined()
    await manager.dispose()
  })

  it('removes room when it empties', async () => {
    vi.useFakeTimers()
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })
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
    it('throws when constructed without instanceFactory', () => {
      // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
      const RM = RoomManager as any
      expect(
        () =>
          new RM({
            resource: { projectId: 'x', dataset: 'y' },
            factory: makeFactory(),
          }),
      ).toThrow(/instanceFactory/)
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
          return {
            instanceKey: 'test',
            documents: { main: { docId: 'silent-doc', mapping: testMapping } },
            gracePeriodMs: 50,
          }
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
    const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })

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

  describe('dispose() during in-flight create', () => {
    it('awaits in-flight create and disposes the resulting room (no leak)', async () => {
      const mock = createMockSanity({ 'doc-1': { value: 0 } })

      // Hold the factory in flight: `create` awaits a deferred we
      // control. This simulates the real-world race where a voter
      // upgrade is mid-handshake (GROQ + ensureVoteRecord) when a
      // hot-reload triggers `dispose()`.
      let releaseCreate: () => void = () => undefined
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      const factory: RoomFactory = {
        async create() {
          await createGate
          return {
        instanceKey: 'test',
        documents: { main: { docId: 'doc-1', mapping: testMapping } },
        gracePeriodMs: 50,
      }
        },
      }

      const manager = new RoomManager({
        instanceFactory: () => mock.instance,
        resource: mock.resource,
        factory,
      })

      // Start a getOrCreate that's now blocked inside the factory.
      const inflight = manager.getOrCreate('r1')

      // Register a dispose-listener on the in-flight room as soon as
      // it resolves — this proves the manager's `dispose()` reaches
      // the racing room and closes it. Without the fix, the room
      // would resolve after `manager.dispose()` returns and would
      // never have its dispose listener fired.
      let disposeListenerFired = false
      const withListener = inflight.then((room) => {
        if (room) room.onDispose(() => {
          disposeListenerFired = true
        })
        return room
      })

      // Dispose runs concurrently. It MUST wait for the in-flight
      // create to settle before clearing rooms.
      const disposed = manager.dispose()

      // Release the factory so the create can finish.
      releaseCreate()

      const [room] = await Promise.all([withListener, disposed])
      expect(room).not.toBeNull()
      expect(disposeListenerFired).toBe(true)
      expect(manager.get('r1')).toBeUndefined()
    })

    it('refuses new getOrCreate calls after dispose', async () => {
      const mock = createMockSanity({ 'doc-1': { value: 0 } })
      const manager = new RoomManager({
      instanceFactory: () => mock.instance,
      resource: mock.resource,
      factory: makeFactory(),
    })
      await manager.dispose()
      const result = await manager.getOrCreate('r1')
      expect(result).toBeNull()
    })

    it('is idempotent — second dispose() is a no-op', async () => {
      const mock = createMockSanity({ 'doc-1': { value: 0 } })
      const manager = new RoomManager({
        instanceFactory: () => mock.instance,
        resource: mock.resource,
        factory: makeFactory(),
      })
      const sdkDispose = vi.fn()
      ;(mock.instance as { dispose?: () => void }).dispose = sdkDispose
      // Create a room so the SDK instance actually gets acquired.
      // (Per-key pooling means instances are lazy — created on first
      // `getOrCreate`, not at manager construction time.)
      await manager.getOrCreate('r1')
      await manager.dispose()
      await manager.dispose()
      expect(sdkDispose).toHaveBeenCalledTimes(1)
    })
  })

  // ── per-key instance pool race conditions ────────────────────────
  //
  // The two cases I flagged when the per-key pooling landed:
  //
  // 1. After the last room with key K disposes (refcount→0, instance
  //    disposed), creating a new room with key K must give a FRESH
  //    instance — not the disposed one. JS is single-threaded so the
  //    sync release-then-acquire is atomic; the test pins that the
  //    factory gets called twice and the new room sees a new instance.
  //
  // 2. Two synchronous calls to handleChainRot for the same key (e.g.
  //    two bridges in two rooms sharing the same instanceKey both
  //    reject their .submitted() Promise in the same tick) must
  //    produce exactly ONE recovery cascade — not two. The lazy-init
  //    of `chainRotByKey` is safe because the `inProgress = true`
  //    flag is set synchronously before any `await`, so subsequent
  //    synchronous calls see the guard. The test pins that.

  describe('per-key SanityInstance pooling', () => {
    it('fresh instance after last-room-disposed-same-key release', async () => {
      const instances: ReturnType<typeof createMockSanity>['instance'][] = []
      const factory = vi.fn(() => {
        const m = createMockSanity({ 'doc-1': { value: 0 } })
        instances.push(m.instance)
        return m.instance
      })
      const manager = new RoomManager({
        instanceFactory: factory,
        resource: { projectId: 'p', dataset: 'd' },
        factory: makeFactory(),
      })

      // First room → first instance via factory
      const r1 = await manager.getOrCreate('r1')
      expect(r1).not.toBeNull()
      expect(factory).toHaveBeenCalledTimes(1)
      const firstInstance = instances[0]
      const firstDispose = vi.fn()
      ;(firstInstance as { dispose?: () => void }).dispose = firstDispose

      // Dispose the only room with this key → release → instance disposed.
      await r1!.dispose()
      // (Direct dispose-on-room triggers the onDispose hook → releaseInstance.)
      expect(firstDispose).toHaveBeenCalledTimes(1)
      expect(manager.getInstanceKeys()).toEqual([])

      // Same key, new room → factory called AGAIN, new instance returned.
      const r2 = await manager.getOrCreate('r1')
      expect(r2).not.toBeNull()
      expect(factory).toHaveBeenCalledTimes(2)
      expect(instances[1]).not.toBe(instances[0])
      expect(manager.getInstanceKeys()).toEqual([{ key: 'test', refCount: 1 }])

      await manager.dispose()
    })

    it('concurrent synchronous chain-rot signals on same key trigger ONE recovery', async () => {
      const factory = vi.fn(() => createMockSanity({ 'doc-1': { value: 0 } }).instance)
      const manager = new RoomManager({
        instanceFactory: factory,
        resource: { projectId: 'p', dataset: 'd' },
        factory: makeFactory(),
      })

      // Create two rooms with the SAME instanceKey (the test factory
      // returns instanceKey: 'test' for every room). They share one
      // SanityInstance — factory called once.
      const r1 = await manager.getOrCreate('r1')
      const r2 = await manager.getOrCreate('r2')
      expect(r1).not.toBeNull()
      expect(r2).not.toBeNull()
      expect(factory).toHaveBeenCalledTimes(1)
      expect(manager.getInstanceKeys()).toEqual([{ key: 'test', refCount: 2 }])

      // Reach into the private handleChainRot via the manager prototype
      // to simulate two synchronous chain-rot signals for the same key
      // in the same event-loop tick. (In production these would come
      // from two bridges in two rooms whose .submitted() Promises
      // rejected within the same microtask.)
      //
      // The cardinal property: only ONE recovery cascade should run.
      // After the dust settles, the factory should have been called
      // exactly 2 times total: once for the original acquire, once
      // for the recovery's recreate.
      // biome-ignore lint/suspicious/noExplicitAny: reaching into private for race test
      const handleChainRot = (manager as any).handleChainRot.bind(manager) as (key: string) => Promise<void>
      const p1 = handleChainRot('test')
      const p2 = handleChainRot('test')
      await Promise.all([p1, p2])

      // Exactly 2 factory calls total: 1 acquire + 1 recovery recreate.
      // If the dedup is broken, we'd see 3 (acquire + two recoveries).
      expect(factory).toHaveBeenCalledTimes(2)

      // The pool still has one entry for the key (refcount unchanged
      // by recovery; the instance behind it was swapped).
      expect(manager.getInstanceKeys()).toEqual([{ key: 'test', refCount: 2 }])

      await manager.dispose()
    })

    it('chain-rot on key A does not touch instance for key B', async () => {
      const factory = vi.fn(() => createMockSanity({ 'doc-1': { value: 0 } }).instance)

      // Factory that returns different keys depending on roomId.
      const multiKeyFactory: RoomFactory = {
        async create(roomId): Promise<RoomConfig | null> {
          return {
            instanceKey: roomId === 'room-A' ? 'key-A' : 'key-B',
            documents: { main: { docId: 'doc-1', mapping: testMapping } },
            gracePeriodMs: 50,
          }
        },
      }
      const manager = new RoomManager({
        instanceFactory: factory,
        resource: { projectId: 'p', dataset: 'd' },
        factory: multiKeyFactory,
      })

      await manager.getOrCreate('room-A')
      await manager.getOrCreate('room-B')
      expect(factory).toHaveBeenCalledTimes(2) // one per key
      const before = manager.getInstanceKeys()
      expect(before).toEqual(
        expect.arrayContaining([
          { key: 'key-A', refCount: 1 },
          { key: 'key-B', refCount: 1 },
        ]),
      )

      // Fire chain-rot for key-A only.
      // biome-ignore lint/suspicious/noExplicitAny: reaching into private for the test
      await (manager as any).handleChainRot('key-A')

      // Total factory calls: 2 (initial keys) + 1 (recovery for key-A only) = 3.
      // If chain-rot for key-A had pulled in key-B, this would be 4.
      expect(factory).toHaveBeenCalledTimes(3)

      // Both keys still in the pool. Both refCounts unchanged.
      const after = manager.getInstanceKeys()
      expect(after).toEqual(
        expect.arrayContaining([
          { key: 'key-A', refCount: 1 },
          { key: 'key-B', refCount: 1 },
        ]),
      )

      await manager.dispose()
    })
  })
})
