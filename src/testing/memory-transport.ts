/**
 * MemoryTransport — in-process transport pair for testing.
 *
 * Messages are delivered synchronously via microtask queue.
 * No network involved — both sides share memory.
 */

import type { ServerTransport, Transport } from '../transport'

let nextClientId = 0

export interface MemoryTransportPair {
  client: Transport
  server: ServerTransport
}

export function createMemoryTransportPair(): MemoryTransportPair {
  const clientId = `test-client-${++nextClientId}`

  const clientMessageHandlers = new Set<(msg: unknown) => void>()
  const serverMessageHandlers = new Set<(msg: unknown) => void>()
  const clientCloseHandlers = new Set<() => void>()
  const serverCloseHandlers = new Set<() => void>()
  let closed = false

  const client: Transport = {
    send(msg) {
      if (closed) return
      const copy = structuredClone(msg)
      queueMicrotask(() => {
        for (const handler of serverMessageHandlers) handler(copy)
      })
    },
    onMessage(handler) {
      clientMessageHandlers.add(handler)
      return () => {
        clientMessageHandlers.delete(handler)
      }
    },
    onClose(handler) {
      clientCloseHandlers.add(handler)
      return () => {
        clientCloseHandlers.delete(handler)
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const handler of serverCloseHandlers) handler()
      for (const handler of clientCloseHandlers) handler()
    },
  }

  const server: ServerTransport = {
    clientId,
    send(msg) {
      if (closed) return
      const copy = structuredClone(msg)
      queueMicrotask(() => {
        for (const handler of clientMessageHandlers) handler(copy)
      })
    },
    onMessage(handler) {
      serverMessageHandlers.add(handler)
      return () => {
        serverMessageHandlers.delete(handler)
      }
    },
    onClose(handler) {
      serverCloseHandlers.add(handler)
      return () => {
        serverCloseHandlers.delete(handler)
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const handler of clientCloseHandlers) handler()
      for (const handler of serverCloseHandlers) handler()
    },
  }

  return { client, server }
}

/** Flush all pending microtasks (for tests that need synchronous delivery). */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
