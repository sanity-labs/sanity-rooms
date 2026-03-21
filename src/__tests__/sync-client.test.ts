import { describe, it, expect, vi, afterEach } from 'vitest'
import { SyncClient } from '../client/sync-client'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import type { Mutation } from '../mutation'
import type { ServerMsg } from '../protocol'

afterEach(() => { vi.useRealTimers() })

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

    const mutationId = (serverReceived[0] as any).mutationId
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

    const mutationId = (serverReceived[0] as any).mutationId
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
    const { syncClient, server, transport } = makeClient({ count: 0 })

    // Connection drops
    transport.close()
    expect(syncClient.status).toBe('disconnected')

    // Reconnect — server sends fresh state
    server.send({ channel: 'doc:main', type: 'state', state: { count: 200 } } satisfies ServerMsg)
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
    expect((received[0] as any).channel).toBe('doc:main')
    expect((received[0] as any).type).toBe('mutate')
    expect((received[0] as any).mutation).toEqual({ kind: 'replace', state: { count: 7 } })
    syncClient.dispose()
  })
})
