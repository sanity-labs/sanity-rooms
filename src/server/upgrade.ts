/**
 * HTTP-upgrade helpers — bridge a Node `IncomingMessage` upgrade event
 * to a `RoomManager` without every app rewriting URL parsing, auth
 * extraction, and `wss.handleUpgrade(...)` plumbing.
 *
 * Most apps share the same WS path shape:
 *   /ws/<scope>/<id>/<role>     e.g. /ws/group/B6PV8G/vote
 * `parseRoomUpgradePath` turns a request into a typed object; pass a
 * regex to handle other shapes.
 *
 * The full bridge expects callers to derive the room id + context from
 * the parsed path — that's the *only* app-specific bit, and the auth
 * callback. Everything else is shared.
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { WsServerTransport } from '../transport/ws-server-transport'
import type { RoomManager } from './room-manager'

export interface ParsedRoomUpgradePath {
  /** First captured group (typically the resource scope, e.g. "group"). */
  scope: string
  /** Second captured group (typically the resource id / invite code). */
  id: string
  /** Third captured group (typically the role / channel name). */
  role: string
  /** Token from `?token=` query string, if present. */
  token: string | null
  /** Cookies as a flat object (decoded values, no parsing of attributes). */
  cookies: Record<string, string>
}

/**
 * Parse `/ws/<scope>/<id>/<role>` (the default shape) or a custom regex
 * with three named groups. Returns null on mismatch — callers should
 * `reject(socket, 404)` and bail.
 */
export function parseRoomUpgradePath(
  req: IncomingMessage,
  pattern: RegExp = DEFAULT_PATH_PATTERN,
): ParsedRoomUpgradePath | null {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
  const m = url.pathname.match(pattern)
  if (!m) return null
  const [, scope, id, role] = m
  if (!scope || !id || !role) return null
  return {
    scope,
    id,
    role,
    token: url.searchParams.get('token'),
    cookies: parseCookies(req.headers.cookie ?? ''),
  }
}

const DEFAULT_PATH_PATTERN = /^\/ws\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) {
      try {
        out[k] = decodeURIComponent(v)
      } catch {
        out[k] = v
      }
    }
  }
  return out
}

/**
 * Reject an in-progress upgrade with a status line — closes the socket
 * cleanly so browsers see a real error code instead of the connection
 * just dropping.
 */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  } catch {
    /* socket may already be closed */
  }
  socket.destroy()
}

export interface BridgeHttpUpgradeOptions {
  manager: RoomManager
  /**
   * Decide whether/how to admit the upgrade. Return:
   *  - `{ roomId, context }` to proceed
   *  - `null` to send a generic 401 (cleaner than throwing)
   *  - throw a `RoomUpgradeError` to control status + reason
   *
   * Receives the parsed path; the auth implementation is the only
   * inherently app-specific bit.
   */
  authorize(parsed: ParsedRoomUpgradePath, req: IncomingMessage): Promise<{ roomId: string; context: unknown } | null>
  /** Optional regex override for the upgrade path. */
  pathPattern?: RegExp
  /** WebSocketServer to reuse. A noServer instance is created on demand. */
  wss?: WebSocketServer
  /** Custom client id factory. Defaults to a fresh randomUUID per upgrade. */
  clientIdFor?(parsed: ParsedRoomUpgradePath, req: IncomingMessage): string
}

/**
 * Throw from `authorize` to send a specific status. Anything else surfaces as
 * a 500 (logged to the manager's logger).
 */
export class RoomUpgradeError extends Error {
  readonly status: number
  readonly reason: string
  constructor(status: number, reason: string) {
    super(`${status} ${reason}`)
    this.status = status
    this.reason = reason
    this.name = 'RoomUpgradeError'
  }
}

/**
 * Returns an HTTP `upgrade` event handler — wire it via
 * `httpServer.on('upgrade', handler)`. The handler:
 *  1. Parses the path.
 *  2. Calls `authorize` for the app-specific room id + context.
 *  3. Asks the RoomManager for the room (auto-creating).
 *  4. Promotes the socket via `wss.handleUpgrade` and registers a
 *     `WsServerTransport` with the room.
 */
export function bridgeHttpUpgrade(options: BridgeHttpUpgradeOptions): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = options.wss ?? new WebSocketServer({ noServer: true })
  return (req, socket, head) => {
    void run(req, socket, head)
  }

  async function run(req: IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      const parsed = parseRoomUpgradePath(req, options.pathPattern)
      if (!parsed) {
        rejectUpgrade(socket, 404, 'unknown ws path')
        return
      }
      const admit = await options.authorize(parsed, req).catch((err) => {
        if (err instanceof RoomUpgradeError) {
          rejectUpgrade(socket, err.status, err.reason)
          return null
        }
        throw err
      })
      if (admit === null) {
        // authorize returned null OR threw a RoomUpgradeError that was
        // already rejected. socket is closed; bail.
        if (socket.writable) rejectUpgrade(socket, 401, 'unauthorized')
        return
      }
      const room = await options.manager.getOrCreate(admit.roomId, admit.context)
      if (!room) {
        rejectUpgrade(socket, 503, 'room creation failed — server recovering')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const clientId = options.clientIdFor ? options.clientIdFor(parsed, req) : randomUUID()
        const transport = new WsServerTransport(clientId, ws)
        room.addClient(transport)
      })
    } catch (err) {
      // Don't crash the process on a single bad upgrade.
      try {
        rejectUpgrade(socket, 500, 'internal error')
      } catch {
        /* ignore */
      }
      // Surface the error so callers can wire it into Sentry / logs.
      // We can't reach the manager's logger from here generically.
      console.error('[bridgeHttpUpgrade] error:', err)
    }
  }
}
