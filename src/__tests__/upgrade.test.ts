import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DocumentMapping } from '../mapping'
import type { RoomConfig } from '../server/room'
import { RoomManager } from '../server/room-manager'
import { bridgeHttpUpgrade, parseRoomUpgradePath, RoomUpgradeError } from '../server/upgrade'
import { createMockSanity } from '../testing/mock-sanity'

const mapping: DocumentMapping<{ value: number }> = {
  documentType: 'test',
  fromSanity(d) {
    return { value: Number(d.value ?? 0) }
  },
  toSanityPatch(s) {
    return { patch: { value: s.value } }
  },
  applyMutation(_s, m) {
    return m.kind === 'replace' ? (m.state as { value: number }) : null
  },
}

function fakeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers: { host: 'localhost:8201', ...headers } } as unknown as IncomingMessage
}

function fakeSocket() {
  let written = ''
  let destroyed = false
  const socket = {
    writable: true,
    write(s: string) {
      written += s
      return true
    },
    destroy() {
      destroyed = true
      socket.writable = false
    },
  } as unknown as Duplex & { _written(): string; _destroyed(): boolean }
  Object.defineProperty(socket, '_written', { value: () => written })
  Object.defineProperty(socket, '_destroyed', { value: () => destroyed })
  return socket
}

describe('parseRoomUpgradePath', () => {
  it('parses /ws/<scope>/<id>/<role> with the default pattern', () => {
    const parsed = parseRoomUpgradePath(fakeReq('/ws/group/B6PV8G/vote?token=abc'))
    expect(parsed).toMatchObject({ scope: 'group', id: 'B6PV8G', role: 'vote', token: 'abc' })
  })

  it('returns null on mismatch', () => {
    expect(parseRoomUpgradePath(fakeReq('/wrong/path'))).toBeNull()
    expect(parseRoomUpgradePath(fakeReq('/ws/only-two/segments'))).toBeNull()
  })

  it('parses cookies into a flat object', () => {
    const parsed = parseRoomUpgradePath(fakeReq('/ws/x/y/z', { cookie: 'session=abc; other=hello%20world' }))
    expect(parsed?.cookies).toEqual({ session: 'abc', other: 'hello world' })
  })

  it('honours a custom regex pattern', () => {
    const pattern = /^\/sock\/(workspace)\/([a-z]+)\/(channel)$/
    const parsed = parseRoomUpgradePath(fakeReq('/sock/workspace/abc/channel'), pattern)
    expect(parsed?.scope).toBe('workspace')
    expect(parsed?.id).toBe('abc')
  })
})

describe('bridgeHttpUpgrade', () => {
  it('rejects 404 on path mismatch', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, {
      async create(): Promise<RoomConfig | null> {
        return { documents: { main: { docId: 'doc-1', mapping } } }
      },
    })
    const handle = bridgeHttpUpgrade({
      manager,
      authorize: async () => ({ roomId: 'r1', context: undefined }),
    })
    const socket = fakeSocket()
    handle(fakeReq('/wrong/path'), socket, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))
    expect((socket as any)._written()).toMatch(/404 unknown ws path/)
    expect((socket as any)._destroyed()).toBe(true)
    await manager.dispose()
  })

  it('rejects with status from RoomUpgradeError thrown in authorize', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, {
      async create(): Promise<RoomConfig | null> {
        return { documents: { main: { docId: 'doc-1', mapping } } }
      },
    })
    const handle = bridgeHttpUpgrade({
      manager,
      authorize: async () => {
        throw new RoomUpgradeError(403, 'forbidden')
      },
    })
    const socket = fakeSocket()
    handle(fakeReq('/ws/group/B6PV8G/vote'), socket, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))
    expect((socket as any)._written()).toMatch(/403 forbidden/)
    await manager.dispose()
  })

  it('rejects 401 when authorize returns null', async () => {
    const mock = createMockSanity({ 'doc-1': { value: 0 } })
    const manager = new RoomManager(mock.instance, mock.resource, {
      async create(): Promise<RoomConfig | null> {
        return { documents: { main: { docId: 'doc-1', mapping } } }
      },
    })
    const handle = bridgeHttpUpgrade({
      manager,
      authorize: async () => null,
    })
    const socket = fakeSocket()
    handle(fakeReq('/ws/group/B6PV8G/vote'), socket, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 10))
    expect((socket as any)._written()).toMatch(/401 unauthorized/)
    await manager.dispose()
  })

  it('rejects 503 when RoomManager getOrCreate returns null', async () => {
    const mock = createMockSanity()
    mock.setSilent('silent-doc')
    const manager = new RoomManager({
      instance: mock.instance,
      resource: mock.resource,
      readyTimeoutMs: 30,
      factory: {
        async create(): Promise<RoomConfig | null> {
          return { documents: { main: { docId: 'silent-doc', mapping } } }
        },
      },
    })
    const handle = bridgeHttpUpgrade({
      manager,
      authorize: async () => ({ roomId: 'r1', context: {} }),
    })
    const socket = fakeSocket()
    handle(fakeReq('/ws/group/B6PV8G/vote'), socket, Buffer.alloc(0))
    await new Promise((r) => setTimeout(r, 100))
    expect((socket as any)._written()).toMatch(/503/)
    await manager.dispose()
  })
})
