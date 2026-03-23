import { describe, it, expect, vi, afterEach } from 'vitest'
import { SyncClient } from '../client/sync-client'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import type { Mutation, SanityPatchOperations } from '../mutation'
import { isServerMsg, type ServerMsg } from '../protocol'
import type { ClientMsg } from '../protocol'

afterEach(() => { vi.useRealTimers() })

/** Access SyncClient internals for testing (private fields). */
function internals(syncClient: SyncClient) {
  return syncClient as unknown as {
    transport: { close(): void }
    unsubMessage: (() => void) | null
    handleServerMsg(msg: ServerMsg): void
  }
}

/** Simulate disconnect + reconnect, returns new server transport. */
function simulateReconnect(syncClient: SyncClient) {
  internals(syncClient).transport.close()
  const { client: newTransport, server: newServer } = createMemoryTransportPair()
  const si = internals(syncClient)
  si.unsubMessage?.()
  si.unsubMessage = newTransport.onMessage((raw: unknown) => {
    if (isServerMsg(raw)) si.handleServerMsg(raw)
  })
  return newServer
}

/** Type the raw messages received by the server transport. */
function asMutateMsg(msg: unknown) {
  return msg as ClientMsg & { type: 'mutate'; mutationId: string; mutation: Mutation }
}

function replaceApply(_state: unknown, mutation: Mutation): unknown | null {
  if (mutation.kind === 'replace') return mutation.state
  return null
}

function makeClient(initialState: unknown = { count: 0 }) {
  const { client: transport, server } = createMemoryTransportPair()
  const syncClient = new SyncClient({
    transport,
    documents: {
      main: { initialState, applyMutation: replaceApply },
    },
    sendDebounce: { ms: 0, maxWaitMs: 0 }, // immediate for testing
  })
  return { syncClient, server, transport }
}

describe('SyncClient', () => {
  it('returns initial state', () => {
    const { syncClient } = makeClient({ count: 42 })
    expect(syncClient.getDocState('main')).toEqual({ count: 42 })
    syncClient.dispose()
  })

  it('throws for unknown document', () => {
    const { syncClient } = makeClient()
    expect(() => syncClient.getDocState('nonexistent')).toThrow('Unknown document')
    syncClient.dispose()
  })

  it('applies mutations optimistically', () => {
    const { syncClient } = makeClient({ count: 0 })
    syncClient.mutate('main', { kind: 'replace', state: { count: 5 } })
    expect(syncClient.getDocState('main')).toEqual({ count: 5 })
    syncClient.dispose()
  })

  it('notifies subscribers on mutation', () => {
    const { syncClient } = makeClient()
    const listener = vi.fn()
    syncClient.subscribeDoc('main', listener)

    syncClient.mutate('main', { kind: 'replace', state: { count: 1 } })
    expect(listener).toHaveBeenCalledTimes(1)
    syncClient.dispose()
  })

  it('unsubscribe stops notifications', () => {
    const { syncClient } = makeClient()
    const listener = vi.fn()
    const unsub = syncClient.subscribeDoc('main', listener)
    unsub()

    syncClient.mutate('main', { kind: 'replace', state: { count: 1 } })
    expect(listener).not.toHaveBeenCalled()
    syncClient.dispose()
  })

  it('handles server state update', async () => {
    const { syncClient, server } = makeClient({ count: 0 })
    const listener = vi.fn()
    syncClient.subscribeDoc('main', listener)

    // Server sends new state
    const msg: ServerMsg = { channel: 'doc:main', type: 'state', state: { count: 99 } }
    server.send(msg)
    await flushMicrotasks()

    expect(syncClient.getDocState('main')).toEqual({ count: 99 })
    expect(listener).toHaveBeenCalled()
    syncClient.dispose()
  })

  it('rebases pending mutations on server state', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ count: 0 })

    // Client mutates — pending, not yet acked
    syncClient.mutate('main', { kind: 'replace', state: { count: 10 } })

    // Server sends external state change
    const msg: ServerMsg = { channel: 'doc:main', type: 'state', state: { count: 50 } }
    server.send(msg)
    await vi.advanceTimersByTimeAsync(0)

    // Pending mutation replayed on new server state
    // replace mutation returns its own state, so the rebase gives { count: 10 }
    expect(syncClient.getDocState('main')).toEqual({ count: 10 })
    syncClient.dispose()
  })

  it('ack removes from pending without state change', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ count: 0 })
    const listener = vi.fn()

    syncClient.mutate('main', { kind: 'replace', state: { count: 5 } })
    syncClient.subscribeDoc('main', listener)

    // Server acks — we need the mutationId from what was sent
    const serverReceived: unknown[] = []
    server.onMessage((m) => serverReceived.push(m))
    await vi.advanceTimersByTimeAsync(0) // flush debounce

    const { mutationId } = asMutateMsg(serverReceived[0])
    server.send({ channel: 'doc:main', type: 'ack', mutationId } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // State should still be { count: 5 } — no recompute needed
    expect(syncClient.getDocState('main')).toEqual({ count: 5 })
    syncClient.dispose()
  })

  it('reject rolls back mutation', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ count: 0 })

    syncClient.mutate('main', { kind: 'replace', state: { count: 5 } })
    expect(syncClient.getDocState('main')).toEqual({ count: 5 })

    // Capture mutationId
    const serverReceived: unknown[] = []
    server.onMessage((m) => serverReceived.push(m))
    await vi.advanceTimersByTimeAsync(0)

    const { mutationId } = asMutateMsg(serverReceived[0])
    server.send({
      channel: 'doc:main',
      type: 'reject',
      mutationId,
      reason: 'invalid',
    } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Rolled back to server state (count: 0)
    expect(syncClient.getDocState('main')).toEqual({ count: 0 })
    syncClient.dispose()
  })

  it('supports multiple documents independently', async () => {
    const { client: transport, server } = createMemoryTransportPair()
    const syncClient = new SyncClient({
      transport,
      documents: {
        docA: { initialState: 'a', applyMutation: replaceApply },
        docB: { initialState: 'b', applyMutation: replaceApply },
      },
      sendDebounce: { ms: 0, maxWaitMs: 0 },
    })

    syncClient.mutate('docA', { kind: 'replace', state: 'A2' })
    expect(syncClient.getDocState('docA')).toBe('A2')
    expect(syncClient.getDocState('docB')).toBe('b')

    server.send({ channel: 'doc:docB', type: 'state', state: 'B2' } satisfies ServerMsg)
    await flushMicrotasks()
    expect(syncClient.getDocState('docB')).toBe('B2')
    expect(syncClient.getDocState('docA')).toBe('A2')

    syncClient.dispose()
  })

  it('app channel send and receive', async () => {
    const { syncClient, server } = makeClient()
    const handler = vi.fn()

    syncClient.onApp('chat', handler)
    server.send({ channel: 'chat', type: 'app', payload: { text: 'hello' } } satisfies ServerMsg)
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith({ text: 'hello' })

    // Client sends app message — verify it reaches server
    const serverReceived: unknown[] = []
    server.onMessage((m) => serverReceived.push(m))

    syncClient.sendApp('chat', { text: 'hi back' })
    await flushMicrotasks()

    expect(serverReceived).toContainEqual({
      channel: 'chat',
      type: 'app',
      payload: { text: 'hi back' },
    })

    syncClient.dispose()
  })

  it('status changes on close', () => {
    const { syncClient, transport } = makeClient()
    const handler = vi.fn()
    syncClient.onStatus(handler)

    expect(syncClient.status).toBe('connected')
    transport.close()
    expect(syncClient.status).toBe('disconnected')
    expect(handler).toHaveBeenCalledWith('disconnected')

    syncClient.dispose()
  })

  it('restores connected status after reconnect state message', async () => {
    vi.useFakeTimers()
    const { syncClient } = makeClient({ count: 0 })

    const newServer = simulateReconnect(syncClient)
    expect(syncClient.status).toBe('disconnected')

    newServer.send({ channel: 'doc:main', type: 'state', state: { count: 200 } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    expect(syncClient.getDocState('main')).toEqual({ count: 200 })
    expect(syncClient.status).toBe('connected')
    syncClient.dispose()
  })

  it('sends mutations to server', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient()
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))

    syncClient.mutate('main', { kind: 'replace', state: { count: 7 } })
    await vi.advanceTimersByTimeAsync(0) // flush debounce

    expect(received).toHaveLength(1)
    const sent = asMutateMsg(received[0])
    expect(sent.channel).toBe('doc:main')
    expect(sent.type).toBe('mutate')
    syncClient.dispose()
  })
})

// ── Diff-at-flush tests ──────────────────────────────────────────────────

describe('SyncClient diff-at-flush', () => {
  it('sends only changed fields as sanityPatch at flush time', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ a: 1, b: 2, c: 3 })
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))

    // Change only key 'a'
    syncClient.mutate('main', { kind: 'replace', state: { a: 99, b: 2, c: 3 } })
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toHaveLength(1)
    const msg = asMutateMsg(received[0])
    expect(msg.mutation.kind).toBe('sanityPatch')
    const ops = (msg.mutation as { kind: 'sanityPatch'; operations: SanityPatchOperations[] }).operations
    const setOps = ops.find(o => o.set)
    expect(setOps?.set).toHaveProperty('a', 99)
    expect(setOps?.set).not.toHaveProperty('b')
    expect(setOps?.set).not.toHaveProperty('c')
    syncClient.dispose()
  })

  it('sends nothing when state is unchanged', async () => {
    vi.useFakeTimers()
    const initial = { a: 1, b: 2 }
    const { syncClient, server } = makeClient(initial)
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))

    // "Replace" with identical values
    syncClient.mutate('main', { kind: 'replace', state: { a: 1, b: 2 } })
    await vi.advanceTimersByTimeAsync(0)

    // diffValue should produce empty patches → nothing sent
    expect(received).toHaveLength(0)
    syncClient.dispose()
  })

  it('coalesces rapid replaces into single patch', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ count: 0 })
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))

    // Rapid-fire edits before debounce fires
    for (let i = 1; i <= 10; i++) {
      syncClient.mutate('main', { kind: 'replace', state: { count: i } })
    }
    await vi.advanceTimersByTimeAsync(0)

    // Only one message sent, with the final diff
    expect(received).toHaveLength(1)
    const msg = asMutateMsg(received[0])
    const ops = (msg.mutation as { kind: 'sanityPatch'; operations: SanityPatchOperations[] }).operations
    const setOp = ops.find(o => o.set)
    expect(setOp?.set).toHaveProperty('count', 10)
    syncClient.dispose()
  })

  it('external state merges with dirty local keys', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ a: 1, b: 2, c: 3 })

    // User edits key 'a' locally (dirty, not yet flushed)
    syncClient.mutate('main', { kind: 'replace', state: { a: 99, b: 2, c: 3 } })

    // Server sends external change to key 'b'
    server.send({ channel: 'doc:main', type: 'state', state: { a: 1, b: 200, c: 3 } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Local state should have user's 'a' AND server's 'b'
    const state = syncClient.getDocState<any>('main')
    expect(state.a).toBe(99) // user's unsent edit preserved
    expect(state.b).toBe(200) // server's change applied
    expect(state.c).toBe(3) // unchanged
    syncClient.dispose()
  })

  it('external state fully applies when local is clean', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeClient({ a: 1, b: 2 })

    // No local edits — state is clean
    server.send({ channel: 'doc:main', type: 'state', state: { a: 10, b: 20 } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    expect(syncClient.getDocState('main')).toEqual({ a: 10, b: 20 })
    syncClient.dispose()
  })

  it('reconnect resets to server state', async () => {
    vi.useFakeTimers()
    const { syncClient } = makeClient({ a: 1, b: 2 })

    syncClient.mutate('main', { kind: 'replace', state: { a: 99, b: 2 } })

    const newServer = simulateReconnect(syncClient)
    expect(syncClient.status).toBe('disconnected')

    newServer.send({ channel: 'doc:main', type: 'state', state: { a: 50, b: 100 } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Full reset — local unsent edit lost
    expect(syncClient.getDocState('main')).toEqual({ a: 50, b: 100 })
    expect(syncClient.status).toBe('connected')
    syncClient.dispose()
  })

  it('reconnect does not revert AI changes (THE BUG)', async () => {
    vi.useFakeTimers()
    const { syncClient, server, transport } = makeClient({ frames: ['f1'], cameraTrack: [] })

    // User edits frames
    syncClient.mutate('main', { kind: 'replace', state: { frames: ['f1', 'f2'], cameraTrack: [] } })

    // Flush to server
    await vi.advanceTimersByTimeAsync(0)

    // AI adds camera keyframes (server broadcasts)
    server.send({ channel: 'doc:main', type: 'state', state: { frames: ['f1', 'f2'], cameraTrack: ['kf1', 'kf2'] } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Disconnect + reconnect
    transport.close()
    server.send({ channel: 'doc:main', type: 'state', state: { frames: ['f1', 'f2'], cameraTrack: ['kf1', 'kf2'] } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Camera keyframes must survive — not reverted
    const state = syncClient.getDocState<any>('main')
    expect(state.cameraTrack).toEqual(['kf1', 'kf2'])
    expect(state.frames).toEqual(['f1', 'f2'])
    syncClient.dispose()
  })

  it('named mutations still go through queue path', async () => {
    vi.useFakeTimers()
    const namedApply = (state: unknown, mutation: Mutation): unknown | null => {
      if (mutation.kind === 'replace') return mutation.state
      if (mutation.kind === 'named' && mutation.name === 'increment') {
        const s = state as { count: number }
        const input = mutation.input as { by: number }
        return { count: s.count + input.by }
      }
      return null
    }
    const { client: transport, server } = createMemoryTransportPair()
    const syncClient = new SyncClient({
      transport,
      documents: { main: { initialState: { count: 0 }, applyMutation: namedApply } },
      sendDebounce: { ms: 0, maxWaitMs: 0 },
    })
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))

    syncClient.mutate('main', { kind: 'named', name: 'increment', input: { by: 5 } })
    expect(syncClient.getDocState('main')).toEqual({ count: 5 }) // optimistic

    await vi.advanceTimersByTimeAsync(0)
    expect(received).toHaveLength(1)
    expect(asMutateMsg(received[0]).mutation.kind).toBe('named') // sent as named, NOT sanityPatch
    syncClient.dispose()
  })

  it('array-level composability: edits to different _key items survive', async () => {
    vi.useFakeTimers()
    const frame1 = { _key: 'f1', text: 'hello' }
    const frame2 = { _key: 'f2', text: 'world' }
    const { syncClient, server } = makeClient({ frames: [frame1, frame2] })

    // User edits frame 1
    const editedFrame1 = { _key: 'f1', text: 'HELLO' }
    syncClient.mutate('main', { kind: 'replace', state: { frames: [editedFrame1, frame2] } })

    // Server sends state where AI edited frame 2
    const aiEditedFrame2 = { _key: 'f2', text: 'WORLD' }
    server.send({ channel: 'doc:main', type: 'state', state: { frames: [frame1, aiEditedFrame2] } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    // Both edits should survive
    const state = syncClient.getDocState<any>('main')
    expect(state.frames).toEqual([
      { _key: 'f1', text: 'HELLO' },  // user's edit
      { _key: 'f2', text: 'WORLD' },  // AI's edit
    ])
    syncClient.dispose()
  })
})

// ── Hydration tests ───────────────────────────────────────────────────────

function makeUnhydratedClient() {
  const { client: transport, server } = createMemoryTransportPair()
  const syncClient = new SyncClient({
    transport,
    documents: {
      main: { applyMutation: replaceApply },
    },
    sendDebounce: { ms: 0, maxWaitMs: 0 },
  })
  return { syncClient, server, transport }
}

describe('SyncClient hydration', () => {
  it('ready resolves immediately when all docs have initialState', async () => {
    const { syncClient } = makeClient({ count: 0 })
    await syncClient.ready // should not hang
    expect(syncClient.isHydrated).toBe(true)
    syncClient.dispose()
  })

  it('ready resolves after server sends state for unhydrated doc', async () => {
    const { syncClient, server } = makeUnhydratedClient()
    expect(syncClient.isHydrated).toBe(false)

    let resolved = false
    syncClient.ready.then(() => { resolved = true })
    await flushMicrotasks()
    expect(resolved).toBe(false)

    server.send({ channel: 'doc:main', type: 'state', state: { count: 42 } } satisfies ServerMsg)
    await flushMicrotasks()

    expect(resolved).toBe(true)
    expect(syncClient.isHydrated).toBe(true)
    syncClient.dispose()
  })

  it('getDocState throws before hydration', () => {
    const { syncClient } = makeUnhydratedClient()
    expect(() => syncClient.getDocState('main')).toThrow('not hydrated')
    syncClient.dispose()
  })

  it('mutate throws before hydration', () => {
    const { syncClient } = makeUnhydratedClient()
    expect(() => syncClient.mutate('main', { kind: 'replace', state: { count: 1 } })).toThrow('before hydration')
    syncClient.dispose()
  })

  it('getDocState works after hydration', async () => {
    const { syncClient, server } = makeUnhydratedClient()
    server.send({ channel: 'doc:main', type: 'state', state: { count: 99 } } satisfies ServerMsg)
    await flushMicrotasks()

    expect(syncClient.getDocState('main')).toEqual({ count: 99 })
    syncClient.dispose()
  })

  it('subscribers notified on hydration', async () => {
    const { syncClient, server } = makeUnhydratedClient()
    const listener = vi.fn()
    syncClient.subscribeDoc('main', listener)

    server.send({ channel: 'doc:main', type: 'state', state: { count: 1 } } satisfies ServerMsg)
    await flushMicrotasks()

    expect(listener).toHaveBeenCalledTimes(1)
    syncClient.dispose()
  })

  it('mixed docs: ready waits for all unhydrated docs', async () => {
    const { client: transport, server } = createMemoryTransportPair()
    const syncClient = new SyncClient({
      transport,
      documents: {
        hydrated: { initialState: 'ready', applyMutation: replaceApply },
        pending: { applyMutation: replaceApply },
      },
      sendDebounce: { ms: 0, maxWaitMs: 0 },
    })

    expect(syncClient.isHydrated).toBe(false)
    expect(syncClient.isDocHydrated('hydrated')).toBe(true)
    expect(syncClient.isDocHydrated('pending')).toBe(false)

    let resolved = false
    syncClient.ready.then(() => { resolved = true })
    await flushMicrotasks()
    expect(resolved).toBe(false)

    server.send({ channel: 'doc:pending', type: 'state', state: 'loaded' } satisfies ServerMsg)
    await flushMicrotasks()

    expect(resolved).toBe(true)
    expect(syncClient.isHydrated).toBe(true)
    expect(syncClient.getDocState('pending')).toBe('loaded')
    expect(syncClient.getDocState('hydrated')).toBe('ready')
    syncClient.dispose()
  })

  it('mutations work normally after hydration', async () => {
    vi.useFakeTimers()
    const { syncClient, server } = makeUnhydratedClient()

    server.send({ channel: 'doc:main', type: 'state', state: { count: 10 } } satisfies ServerMsg)
    await vi.advanceTimersByTimeAsync(0)

    syncClient.mutate('main', { kind: 'replace', state: { count: 20 } })
    expect(syncClient.getDocState('main')).toEqual({ count: 20 })

    // Flush should produce a sanityPatch
    const received: unknown[] = []
    server.onMessage((m) => received.push(m))
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toHaveLength(1)
    expect(asMutateMsg(received[0]).mutation.kind).toBe('sanityPatch')
    syncClient.dispose()
  })
})
