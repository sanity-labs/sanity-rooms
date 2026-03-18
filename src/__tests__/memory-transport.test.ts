import { describe, it, expect, vi } from 'vitest'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'

describe('MemoryTransport', () => {
  it('delivers messages from client to server', async () => {
    const { client, server } = createMemoryTransportPair()
    const handler = vi.fn()
    server.onMessage(handler)

    client.send({ hello: 'world' })
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith({ hello: 'world' })
  })

  it('delivers messages from server to client', async () => {
    const { client, server } = createMemoryTransportPair()
    const handler = vi.fn()
    client.onMessage(handler)

    server.send({ foo: 'bar' })
    await flushMicrotasks()

    expect(handler).toHaveBeenCalledWith({ foo: 'bar' })
  })

  it('deep clones messages to prevent shared references', async () => {
    const { client, server } = createMemoryTransportPair()
    const received: unknown[] = []
    server.onMessage((msg) => received.push(msg))

    const original = { data: [1, 2, 3] }
    client.send(original)
    await flushMicrotasks()

    expect(received[0]).toEqual(original)
    expect(received[0]).not.toBe(original)
  })

  it('close triggers onClose on both sides', () => {
    const { client, server } = createMemoryTransportPair()
    const clientClose = vi.fn()
    const serverClose = vi.fn()
    client.onClose(clientClose)
    server.onClose(serverClose)

    client.close()
    expect(clientClose).toHaveBeenCalled()
    expect(serverClose).toHaveBeenCalled()
  })

  it('does not deliver messages after close', async () => {
    const { client, server } = createMemoryTransportPair()
    const handler = vi.fn()
    server.onMessage(handler)

    client.close()
    client.send({ should: 'not arrive' })
    await flushMicrotasks()

    expect(handler).not.toHaveBeenCalled()
  })

  it('unsubscribe stops delivery', async () => {
    const { client, server } = createMemoryTransportPair()
    const handler = vi.fn()
    const unsub = server.onMessage(handler)

    unsub()
    client.send({ test: true })
    await flushMicrotasks()

    expect(handler).not.toHaveBeenCalled()
  })

  it('server has a clientId', () => {
    const { server } = createMemoryTransportPair()
    expect(typeof server.clientId).toBe('string')
    expect(server.clientId.length).toBeGreaterThan(0)
  })
})
