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

function makeRoom(initialValue = 0) {
  const mock = createMockSanity({ 'doc-1': { value: initialValue } })
  const room = new Room(
    {
      documents: {
        main: { docId: 'doc-1', mapping: testMapping, initialState: { value: initialValue } },
      },
      gracePeriodMs: 100,
    },
    mock.instance, mock.resource,
  )
  return { room, mock }
}

function connectClient(room: Room) {
  const { client, server } = createMemoryTransportPair()
  const received: ServerMsg[] = []
  client.onMessage((m) => received.push(m as ServerMsg))
  const clientId = room.addClient(server)
  return { clientId, client, server, received }
}

describe('Room', () => {
  it('sends initial state on client join', async () => {
    const { room } = makeRoom(42)
    const { received } = connectClient(room)

    await flushMicrotasks()

    const stateMsg = received.find((m) => m.type === 'state')
    expect(stateMsg).toBeDefined()
    expect((stateMsg as any).state).toEqual({ value: 42 })
    await room.dispose()
  })

  it('handles client mutation → broadcast + ack', async () => {
    const { room } = makeRoom(0)
    const c1 = connectClient(room)
    const c2 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0
    c2.received.length = 0

    // Client 1 mutates
    const mutateMsg: ClientMsg = {
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'mut-1',
      mutation: { kind: 'replace', state: { value: 99 } },
    }
    c1.client.send(mutateMsg)
    await flushMicrotasks() // server receives
    await flushMicrotasks() // client receives response

    // Client 1 gets state + ack
    const c1State = c1.received.find((m) => m.type === 'state' && (m as any).state?.value === 99)
    const c1Ack = c1.received.find((m) => m.type === 'ack')
    expect(c1State).toBeDefined()
    expect(c1Ack).toBeDefined()
    expect((c1Ack as any).mutationId).toBe('mut-1')

    // Client 2 gets state broadcast
    const c2State = c2.received.find((m) => m.type === 'state' && (m as any).state?.value === 99)
    expect(c2State).toBeDefined()

    await room.dispose()
  })

  it('broadcasts external Sanity edits to all clients', async () => {
    const { room, mock } = makeRoom(0)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    mock.simulateExternalEdit('doc-1', { value: 777 })
    await flushMicrotasks()

    const stateMsg = c1.received.find((m) => m.type === 'state' && (m as any).state?.value === 777)
    expect(stateMsg).toBeDefined()
    await room.dispose()
  })

  it('rejects invalid mutations', async () => {
    const { room } = makeRoom(0)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    const mutateMsg: ClientMsg = {
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'mut-bad',
      mutation: { kind: 'named', name: 'unknown', input: {} },
    }
    c1.client.send(mutateMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    const reject = c1.received.find((m) => m.type === 'reject')
    expect(reject).toBeDefined()
    expect((reject as any).mutationId).toBe('mut-bad')
    await room.dispose()
  })

  it('rejects mutations for unknown document', async () => {
    const { room } = makeRoom(0)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    const mutateMsg: ClientMsg = {
      channel: 'doc:nonexistent',
      type: 'mutate',
      mutationId: 'mut-x',
      mutation: { kind: 'replace', state: { value: 1 } },
    }
    c1.client.send(mutateMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    const reject = c1.received.find((m) => m.type === 'reject')
    expect(reject).toBeDefined()
    await room.dispose()
  })

  it('app channel: routes to handler and broadcasts', async () => {
    const { room } = makeRoom(0)
    const handler = vi.fn()
    room.registerAppChannel('chat', {
      onMessage(clientId, payload, r) {
        handler(clientId, payload)
        r.broadcastApp('chat', { echo: payload }, clientId)
      },
    })

    const c1 = connectClient(room)
    const c2 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0
    c2.received.length = 0

    const appMsg: ClientMsg = { channel: 'chat', type: 'app', payload: { text: 'hello' } }
    c1.client.send(appMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith(c1.clientId, { text: 'hello' })

    // c2 gets the broadcast, c1 doesn't (excluded)
    const c2App = c2.received.find((m) => m.type === 'app')
    expect(c2App).toBeDefined()
    const c1App = c1.received.find((m) => m.type === 'app')
    expect(c1App).toBeUndefined()

    await room.dispose()
  })

  it('app channel: notifies on client join and leave', async () => {
    const { room } = makeRoom(0)
    const joinHandler = vi.fn()
    const leaveHandler = vi.fn()
    room.registerAppChannel('presence', {
      onMessage() {},
      onClientJoin: joinHandler,
      onClientLeave: leaveHandler,
    })

    const c1 = connectClient(room)
    expect(joinHandler).toHaveBeenCalledWith(c1.clientId, room)

    room.removeClient(c1.clientId)
    expect(leaveHandler).toHaveBeenCalledWith(c1.clientId, room)

    await room.dispose()
  })

  it('grace period: disposes after timeout when empty', async () => {
    vi.useFakeTimers()
    const { room } = makeRoom(0)
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
    const { room } = makeRoom(0)
    const onEmpty = vi.fn()
    room.onEmpty = onEmpty

    const c1 = connectClient(room)
    room.removeClient(c1.clientId)

    vi.advanceTimersByTime(50) // halfway
    const c2 = connectClient(room) // reconnect
    vi.advanceTimersByTime(100)

    expect(onEmpty).not.toHaveBeenCalled()
    room.removeClient(c2.clientId)
    vi.advanceTimersByTime(100)
    expect(onEmpty).toHaveBeenCalled()
  })

  it('getDocState and mutateDoc for app-level access', async () => {
    const { room } = makeRoom(10)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    expect(room.getDocState('main')).toEqual({ value: 10 })

    room.mutateDoc('main', { kind: 'replace', state: { value: 50 } })
    expect(room.getDocState('main')).toEqual({ value: 50 })

    await flushMicrotasks()
    const stateMsg = c1.received.find((m) => m.type === 'state' && (m as any).state?.value === 50)
    expect(stateMsg).toBeDefined()

    await room.dispose()
  })

  it('supports multiple documents', async () => {
    const mock = createMockSanity({
      'doc-a': { value: 1 },
      'doc-b': { value: 2 },
    })
    const room = new Room(
      {
        documents: {
          alpha: { docId: 'doc-a', mapping: testMapping, initialState: { value: 1 } },
          beta: { docId: 'doc-b', mapping: testMapping, initialState: { value: 2 } },
        },
      },
      mock.instance, mock.resource,
    )

    expect(room.getDocState('alpha')).toEqual({ value: 1 })
    expect(room.getDocState('beta')).toEqual({ value: 2 })

    room.mutateDoc('alpha', { kind: 'replace', state: { value: 100 } })
    expect(room.getDocState('alpha')).toEqual({ value: 100 })
    expect(room.getDocState('beta')).toEqual({ value: 2 })

    await room.dispose()
  })

  it('clientCount reflects connected clients', async () => {
    const { room } = makeRoom(0)
    expect(room.clientCount).toBe(0)

    const c1 = connectClient(room)
    expect(room.clientCount).toBe(1)

    const c2 = connectClient(room)
    expect(room.clientCount).toBe(2)

    room.removeClient(c1.clientId)
    expect(room.clientCount).toBe(1)

    room.removeClient(c2.clientId)
    expect(room.clientCount).toBe(0)

    await room.dispose()
  })

  // ── Ref following ──────────────────────────────────────────────────────

  it('resolveRefs: auto-subscribes to referenced docs', async () => {
    const mock = createMockSanity({
      'main-doc': { value: 1, refs: [{ _ref: 'ref-a' }, { _ref: 'ref-b' }] },
      'ref-a': { name: 'Font A' },
      'ref-b': { name: 'Palette B' },
    })

    const refMapping: DocumentMapping<Record<string, unknown>> = {
      documentType: 'asset',
      fromSanity(doc) { return doc },
      toSanityPatch(state) { return { patch: state } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as Record<string, unknown> : null
      },
    }

    const parentMapping: DocumentMapping<{ value: number }> = {
      documentType: 'test',
      fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
      toSanityPatch(state) { return { patch: { value: state.value } } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as { value: number } : null
      },
      resolveRefs(doc) {
        return ((doc.refs ?? []) as any[]).map((r: any) => ({
          key: `ref-${r._ref}`,
          docId: r._ref,
          mapping: refMapping,
        }))
      },
    }

    const room = new Room(
      {
        documents: {
          main: { docId: 'main-doc', mapping: parentMapping, initialState: { value: 1 } },
        },
      },
      mock.instance, mock.resource,
    )

    // Wait for initial subscriptions to fire
    await flushMicrotasks()
    await flushMicrotasks()

    const c1 = connectClient(room)
    await flushMicrotasks()

    // Client should receive state for main doc AND ref docs
    const mainState = c1.received.find((m) => m.type === 'state' && (m as any).channel === 'doc:main')
    expect(mainState).toBeDefined()

    const refAState = c1.received.find((m) => m.type === 'state' && (m as any).channel === 'doc:ref-ref-a')
    expect(refAState).toBeDefined()
    expect((refAState as any).state).toHaveProperty('name', 'Font A')

    const refBState = c1.received.find((m) => m.type === 'state' && (m as any).channel === 'doc:ref-ref-b')
    expect(refBState).toBeDefined()
    expect((refBState as any).state).toHaveProperty('name', 'Palette B')

    await room.dispose()
  })

  it('resolveRefs: updates subscriptions when refs change', async () => {
    const mock = createMockSanity({
      'main-doc': { value: 1, refs: [{ _ref: 'ref-a' }] },
      'ref-a': { name: 'A' },
      'ref-c': { name: 'C' },
    })

    const refMapping: DocumentMapping<Record<string, unknown>> = {
      documentType: 'asset',
      fromSanity(doc) { return doc },
      toSanityPatch(state) { return { patch: state } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as Record<string, unknown> : null
      },
    }

    const parentMapping: DocumentMapping<{ value: number }> = {
      documentType: 'test',
      fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
      toSanityPatch(state) { return { patch: { value: state.value } } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as { value: number } : null
      },
      resolveRefs(doc) {
        return ((doc.refs ?? []) as any[]).map((r: any) => ({
          key: `ref-${r._ref}`,
          docId: r._ref,
          mapping: refMapping,
        }))
      },
    }

    const room = new Room(
      {
        documents: {
          main: { docId: 'main-doc', mapping: parentMapping, initialState: { value: 1 } },
        },
      },
      mock.instance, mock.resource,
    )

    await flushMicrotasks()
    await flushMicrotasks()

    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // Simulate main doc changing refs: remove ref-a, add ref-c
    mock.simulateExternalEdit('main-doc', { value: 2, refs: [{ _ref: 'ref-c' }] })
    await flushMicrotasks()
    await flushMicrotasks()
    await flushMicrotasks()

    // Client should get new ref-c state
    const refCState = c1.received.find((m) => m.type === 'state' && (m as any).channel === 'doc:ref-ref-c')
    expect(refCState).toBeDefined()
    expect((refCState as any).state).toHaveProperty('name', 'C')

    await room.dispose()
  })

  it('resolveRefs: external edit on ref doc broadcasts to clients', async () => {
    const mock = createMockSanity({
      'main-doc': { value: 1, refs: [{ _ref: 'ref-a' }] },
      'ref-a': { name: 'Original' },
    })

    const refMapping: DocumentMapping<Record<string, unknown>> = {
      documentType: 'asset',
      fromSanity(doc) { return doc },
      toSanityPatch(state) { return { patch: state } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as Record<string, unknown> : null
      },
    }

    const parentMapping: DocumentMapping<{ value: number }> = {
      documentType: 'test',
      fromSanity(doc) { return { value: Number(doc.value ?? 0) } },
      toSanityPatch(state) { return { patch: { value: state.value } } },
      applyMutation(_state, mutation) {
        return mutation.kind === 'replace' ? mutation.state as { value: number } : null
      },
      resolveRefs(doc) {
        return ((doc.refs ?? []) as any[]).map((r: any) => ({
          key: `ref-${r._ref}`,
          docId: r._ref,
          mapping: refMapping,
        }))
      },
    }

    const room = new Room(
      {
        documents: {
          main: { docId: 'main-doc', mapping: parentMapping, initialState: { value: 1 } },
        },
      },
      mock.instance, mock.resource,
    )

    await flushMicrotasks()
    await flushMicrotasks()

    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // External edit on ref doc
    mock.simulateExternalEdit('ref-a', { name: 'Updated' })
    await flushMicrotasks()
    await flushMicrotasks()

    const refUpdate = c1.received.find(
      (m) => m.type === 'state' && (m as any).channel === 'doc:ref-ref-a' && (m as any).state?.name === 'Updated',
    )
    expect(refUpdate).toBeDefined()

    await room.dispose()
  })
})
