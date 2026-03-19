import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import { createMockSanity } from '../testing/mock-sanity'
import { Room } from '../server/room'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import type { DocumentMapping } from '../mapping'
import type { ServerMsg, ClientMsg } from '../protocol'

afterEach(() => { vi.useRealTimers() })

const testMapping: DocumentMapping<{ value: number }> = {
  documentType: 'test',
  fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
  toSanityPatch(state) { return { patch: { value: state.value } } },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as { value: number }
    return null
  },
}

async function makeRoom(initialValue = 0) {
  const mock = createMockSanity({ 'doc-1': { value: initialValue } })
  const room = new Room(
    { documents: { main: { docId: 'doc-1', mapping: testMapping } }, gracePeriodMs: 100 },
    mock.instance,
    mock.resource,
  )
  await room.ready
  return { room, mock }
}

function connectClient(room: Room) {
  const { client, server } = createMemoryTransportPair()
  const received: ServerMsg[] = []
  client.onMessage((m) => received.push(m as ServerMsg))
  room.addClient(server)
  return { clientId: server.clientId, client, received }
}

describe('Room', () => {
  it('sends initial state on client join', async () => {
    const { room } = await makeRoom(42)
    const { received } = connectClient(room)
    await flushMicrotasks()
    const stateMsg = received.find((m) => m.type === 'state')
    expect(stateMsg).toBeDefined()
    expect((stateMsg as any).state).toEqual({ value: 42 })
    await room.dispose()
  })

  it('client mutation → ack to sender, state to others', async () => {
    const { room } = await makeRoom(0)
    const c1 = connectClient(room)
    const c2 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0
    c2.received.length = 0

    c1.client.send({ channel: 'doc:main', type: 'mutate', mutationId: 'mut-1', mutation: { kind: 'replace', state: { value: 99 } } } satisfies ClientMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(c1.received.find((m) => m.type === 'ack')).toBeDefined()
    expect(c1.received.find((m) => m.type === 'state')).toBeUndefined() // sender doesn't get state
    expect(c2.received.find((m) => m.type === 'state' && (m as any).state?.value === 99)).toBeDefined()
    await room.dispose()
  })

  it('external edit broadcasts to all', async () => {
    const { room, mock } = await makeRoom(0)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    mock.simulateExternalEdit('doc-1', { value: 777 })
    await flushMicrotasks()
    await flushMicrotasks()

    expect(c1.received.find((m) => m.type === 'state' && (m as any).state?.value === 777)).toBeDefined()
    await room.dispose()
  })

  it('rejects invalid mutations', async () => {
    const { room } = await makeRoom(0)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    c1.client.send({ channel: 'doc:main', type: 'mutate', mutationId: 'bad', mutation: { kind: 'named', name: 'x', input: {} } } satisfies ClientMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(c1.received.find((m) => m.type === 'reject')).toBeDefined()
    await room.dispose()
  })

  it('app channel routes and broadcasts', async () => {
    const { room } = await makeRoom(0)
    const handler = vi.fn()
    room.registerAppChannel('chat', {
      onMessage(clientId, payload, r) { handler(clientId, payload); r.broadcastApp('chat', { echo: payload }, clientId) },
    })
    const c1 = connectClient(room)
    const c2 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0
    c2.received.length = 0

    c1.client.send({ channel: 'chat', type: 'app', payload: { text: 'hi' } } satisfies ClientMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith(c1.clientId, { text: 'hi' })
    expect(c2.received.find((m) => m.type === 'app')).toBeDefined()
    expect(c1.received.find((m) => m.type === 'app')).toBeUndefined()
    await room.dispose()
  })

  it('grace period disposes after timeout', async () => {
    vi.useFakeTimers()
    const { room } = await makeRoom(0)
    const onEmpty = vi.fn()
    room.onEmpty = onEmpty
    const c1 = connectClient(room)
    room.removeClient(c1.clientId)
    expect(onEmpty).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onEmpty).toHaveBeenCalled()
  })

  it('grace period cancelled by reconnection', async () => {
    vi.useFakeTimers()
    const { room } = await makeRoom(0)
    const onEmpty = vi.fn()
    room.onEmpty = onEmpty
    const c1 = connectClient(room)
    room.removeClient(c1.clientId)
    vi.advanceTimersByTime(50)
    const c2 = connectClient(room)
    vi.advanceTimersByTime(100)
    expect(onEmpty).not.toHaveBeenCalled()
    room.removeClient(c2.clientId)
    vi.advanceTimersByTime(100)
    expect(onEmpty).toHaveBeenCalled()
  })

  it('getDocState and mutateDoc', async () => {
    const { room } = await makeRoom(10)
    await flushMicrotasks()
    expect(room.getDocState('main')).toEqual({ value: 10 })
    room.mutateDoc('main', { kind: 'replace', state: { value: 50 } })
    expect(room.getDocState('main')).toEqual({ value: 50 })
    await room.dispose()
  })

  it('clientCount reflects connections', async () => {
    const { room } = await makeRoom(0)
    expect(room.clientCount).toBe(0)
    const c1 = connectClient(room)
    expect(room.clientCount).toBe(1)
    const c2 = connectClient(room)
    expect(room.clientCount).toBe(2)
    room.removeClient(c1.clientId)
    expect(room.clientCount).toBe(1)
    await room.dispose()
  })
})
