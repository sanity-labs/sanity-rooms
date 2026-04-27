import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import type { DocumentMapping } from '../mapping'
import type { ClientMsg, ServerMsg } from '../protocol'
import { Room } from '../server/room'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import { createMockSanity } from '../testing/mock-sanity'

afterEach(() => {
  vi.useRealTimers()
})

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

  it('does not send null state before bridge has loaded (Bug #1)', async () => {
    // Create room WITHOUT awaiting ready — connect client immediately
    const mock = createMockSanity() // no initial docs → bridge hasn't emitted yet
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: testMapping } }, gracePeriodMs: 100 },
      mock.instance,
      mock.resource,
    )
    // Connect BEFORE ready resolves
    const { received } = connectClient(room)
    await flushMicrotasks()

    // Should NOT have received a state message with null
    const nullState = received.find((m) => m.type === 'state' && (m as any).state === null)
    expect(nullState).toBeUndefined()

    // Now simulate the bridge loading the doc
    mock.simulateExternalEdit('doc-1', { value: 100 })
    await flushMicrotasks()
    await flushMicrotasks()

    // NOW client should receive the real state
    const stateMsg = received.find((m) => m.type === 'state' && (m as any).state?.value === 100)
    expect(stateMsg).toBeDefined()
    await room.dispose()
  })

  it('own write echoes do not reset state (Bug #2)', async () => {
    const { room } = await makeRoom(10)
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // Server-side mutation (like AI tool call)
    room.mutateDoc('main', { kind: 'replace', state: { value: 999 } })
    expect(room.getDocState('main')).toEqual({ value: 999 })
    await flushMicrotasks()
    await flushMicrotasks()

    // The write echo comes back from the mock SDK — should be suppressed
    // State should still be 999, not reset to the echo value
    expect(room.getDocState('main')).toEqual({ value: 999 })

    // Client should have received value=999 (from mutateDoc broadcast),
    // NOT a second state message reverting it
    const stateMessages = c1.received.filter((m) => m.type === 'state')
    expect(stateMessages.length).toBe(1)
    expect((stateMessages[0] as any).state).toEqual({ value: 999 })
    await room.dispose()
  })

  it('client disconnecting before ready does not crash', async () => {
    const mock = createMockSanity()
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: testMapping } }, gracePeriodMs: 100 },
      mock.instance,
      mock.resource,
    )
    const { client, server } = createMemoryTransportPair()
    const received: ServerMsg[] = []
    client.onMessage((m) => received.push(m as ServerMsg))
    const clientId = room.addClient(server)

    // Disconnect before ready resolves
    room.removeClient(clientId)

    // Now let the bridge load
    mock.simulateExternalEdit('doc-1', { value: 42 })
    await room.ready
    await flushMicrotasks()

    // Should not have sent anything to the disconnected client
    expect(received.filter((m) => m.type === 'state')).toHaveLength(0)
    await room.dispose()
  })

  it('client mutation → ack to sender, state to others', async () => {
    const { room } = await makeRoom(0)
    const c1 = connectClient(room)
    const c2 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0
    c2.received.length = 0

    c1.client.send({
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'mut-1',
      mutation: { kind: 'replace', state: { value: 99 } },
    } satisfies ClientMsg)
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

    c1.client.send({
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'bad',
      mutation: { kind: 'named', name: 'x', input: {} },
    } satisfies ClientMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(c1.received.find((m) => m.type === 'reject')).toBeDefined()
    await room.dispose()
  })

  it('app channel routes and broadcasts', async () => {
    const { room } = await makeRoom(0)
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
    const onDispose = vi.fn()
    room.onDispose(onDispose)
    const c1 = connectClient(room)
    room.removeClient(c1.clientId)
    expect(onDispose).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onDispose).toHaveBeenCalled()
  })

  it('grace period cancelled by reconnection', async () => {
    vi.useFakeTimers()
    const { room } = await makeRoom(0)
    const onDispose = vi.fn()
    room.onDispose(onDispose)
    const c1 = connectClient(room)
    room.removeClient(c1.clientId)
    vi.advanceTimersByTime(50)
    const c2 = connectClient(room)
    vi.advanceTimersByTime(100)
    expect(onDispose).not.toHaveBeenCalled()
    room.removeClient(c2.clientId)
    vi.advanceTimersByTime(100)
    expect(onDispose).toHaveBeenCalled()
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
    connectClient(room)
    expect(room.clientCount).toBe(2)
    room.removeClient(c1.clientId)
    expect(room.clientCount).toBe(1)
    await room.dispose()
  })

  it('sanityPatch mutation writes ref docs to Sanity', async () => {
    // Mapping with ref doc support — simulates custom backgrounds
    interface RefState {
      value: number
      refs: Array<{ _ref: string; data: string }>
    }
    const refMapping: DocumentMapping<RefState> = {
      documentType: 'test',
      fromSanity(doc) {
        return { value: Number(doc.value ?? 0), refs: (doc.refs ?? []) as RefState['refs'] }
      },
      toSanityPatch(state) {
        const refPatches: Record<string, Record<string, unknown>> = {}
        for (const ref of state.refs) {
          refPatches[`ref-${ref._ref}`] = { data: ref.data }
        }
        return {
          patch: { value: state.value, refs: state.refs.map((r) => ({ _ref: r._ref })) },
          refPatches,
        }
      },
      applyMutation(_state, mutation) {
        if (mutation.kind === 'replace') return mutation.state as RefState
        return null
      },
      resolveRefs(doc) {
        return ((doc.refs ?? []) as Array<{ _ref: string }>).map((r) => ({
          key: `ref-${r._ref}`,
          docId: r._ref,
          mapping: {
            documentType: 'refDoc',
            fromSanity: (d: Record<string, unknown>) => d,
            toSanityPatch: (s: unknown) => ({ patch: s as Record<string, unknown> }),
            applyMutation: () => null,
          },
        }))
      },
    }

    const mock = createMockSanity({ 'doc-1': { value: 0, refs: [] } })
    const room = new Room(
      { documents: { main: { docId: 'doc-1', mapping: refMapping } }, gracePeriodMs: 100 },
      mock.instance,
      mock.resource,
    )
    await room.ready
    const c1 = connectClient(room)
    await flushMicrotasks()
    c1.received.length = 0

    // Client sends sanityPatch that adds a ref
    c1.client.send({
      channel: 'doc:main',
      type: 'mutate',
      mutationId: 'ref-mut-1',
      mutation: {
        kind: 'sanityPatch',
        operations: [{ set: { value: 42, refs: [{ _ref: 'bg-1', data: 'aurora' }] } }],
      },
    } satisfies ClientMsg)
    await flushMicrotasks()
    await flushMicrotasks()

    // The ref doc should have been written to Sanity
    const refDoc = mock.getDoc('bg-1')
    expect(refDoc).toBeDefined()
    expect(refDoc?.data).toBe('aurora')

    // Main doc value should also be written
    expect(mock.getDoc('doc-1')?.value).toBe(42)

    await room.dispose()
  })

  describe('missing documents', () => {
    it('room.ready hangs when the main doc is silent (never emits)', async () => {
      const mock = createMockSanity()
      mock.setSilent('missing-main')
      const room = new Room(
        { documents: { main: { docId: 'missing-main', mapping: testMapping } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      const settled = await Promise.race([
        room.ready.then(() => 'resolved' as const).catch(() => 'rejected' as const),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100)),
      ])
      expect(settled).toBe('pending')
      await room.dispose()
    })

    it('room.ready resolves when a previously-silent doc starts emitting', async () => {
      vi.useFakeTimers()
      const mock = createMockSanity()
      mock.setSilent('late-doc')
      const room = new Room(
        { documents: { main: { docId: 'late-doc', mapping: testMapping } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      // Now an external write makes the doc available
      mock.setSilent('late-doc', false)
      mock.simulateExternalEdit('late-doc', { value: 7 })
      await vi.advanceTimersByTimeAsync(0)
      await expect(room.ready).resolves.toBeDefined()
      expect(room.getDocState('main')).toEqual({ value: 7 })
      await room.dispose()
    })

    it('room.ready hangs when a resolved ref points to a silent (dangling) doc', async () => {
      const mock = createMockSanity({
        'group-1': { value: 1, refs: [{ _ref: 'missing-ref', _key: 'r1' }] },
      })
      mock.setSilent('missing-ref') // ref doc never emits
      const refMapping: DocumentMapping<unknown> = {
        documentType: 'refType',
        fromSanity: (d) => d,
        toSanityPatch: (s) => ({ patch: s as Record<string, unknown> }),
        applyMutation: () => null,
      }
      const mappingWithRefs: DocumentMapping<{ value: number; refs: unknown[] }> = {
        documentType: 'group',
        fromSanity: (d) => ({ value: Number(d.value ?? 0), refs: [] }),
        fromSanityWithRefs: (d, refDocs) => ({
          value: Number(d.value ?? 0),
          refs: [...refDocs.values()],
        }),
        toSanityPatch: (s) => ({ patch: { value: s.value } }),
        applyMutation: () => null,
        resolveRefs: (d) => {
          const out: Array<{ key: string; docId: string; mapping: DocumentMapping<unknown> }> = []
          for (const r of (d.refs as Array<{ _ref?: string; _key?: string }>) ?? []) {
            if (r._ref && r._key) out.push({ key: r._key, docId: r._ref, mapping: refMapping })
          }
          return out
        },
      }
      const room = new Room(
        { documents: { main: { docId: 'group-1', mapping: mappingWithRefs } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      const settled = await Promise.race([
        room.ready.then(() => 'resolved' as const).catch(() => 'rejected' as const),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100)),
      ])
      expect(settled).toBe('pending')
      await room.dispose()
    })

    it('room.ready resolves once the dangling ref doc starts emitting', async () => {
      vi.useFakeTimers()
      const mock = createMockSanity({
        'group-1': { value: 1, refs: [{ _ref: 'late-ref', _key: 'r1' }] },
      })
      mock.setSilent('late-ref')
      const refMapping: DocumentMapping<unknown> = {
        documentType: 'refType',
        fromSanity: (d) => d,
        toSanityPatch: (s) => ({ patch: s as Record<string, unknown> }),
        applyMutation: () => null,
      }
      const mappingWithRefs: DocumentMapping<{ value: number; refs: unknown[] }> = {
        documentType: 'group',
        fromSanity: (d) => ({ value: Number(d.value ?? 0), refs: [] }),
        fromSanityWithRefs: (d, refDocs) => ({
          value: Number(d.value ?? 0),
          refs: [...refDocs.values()],
        }),
        toSanityPatch: (s) => ({ patch: { value: s.value } }),
        applyMutation: () => null,
        resolveRefs: (d) => {
          const out: Array<{ key: string; docId: string; mapping: DocumentMapping<unknown> }> = []
          for (const r of (d.refs as Array<{ _ref?: string; _key?: string }>) ?? []) {
            if (r._ref && r._key) out.push({ key: r._key, docId: r._ref, mapping: refMapping })
          }
          return out
        },
      }
      const room = new Room(
        { documents: { main: { docId: 'group-1', mapping: mappingWithRefs } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      mock.setSilent('late-ref', false)
      mock.simulateExternalEdit('late-ref', { _id: 'late-ref', payload: 'arrived' })
      await vi.advanceTimersByTimeAsync(0)
      await expect(room.ready).resolves.toBeDefined()
      const state = room.getDocState<{ value: number; refs: unknown[] }>('main')
      expect(state.refs.length).toBe(1)
      await room.dispose()
    })
  })
})
