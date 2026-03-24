/**
 * WebSocket transport adapter for Node.js servers.
 *
 * Wraps a `ws` WebSocket in the sanity-rooms `ServerTransport` interface.
 * Requires the `ws` package as a peer dependency.
 *
 * @example
 * ```typescript
 * import WebSocket from 'ws'
 * import { WsServerTransport } from 'sanity-rooms/transport/ws-server'
 *
 * wss.on('connection', (ws) => {
 *   const transport = new WsServerTransport(crypto.randomUUID(), ws)
 *   room.addClient(transport)
 * })
 * ```
 */

import type { ServerTransport } from '../transport'

// Use a minimal interface instead of importing `ws` directly — this way the
// module is importable even when `ws` is a peer dep that may not be installed.
interface WsLike {
  readonly OPEN: number
  readonly readyState: number
  send(data: string): void
  close(): void
  on(event: string, listener: (...args: any[]) => void): void
  off(event: string, listener: (...args: any[]) => void): void
}

export class WsServerTransport implements ServerTransport {
  readonly clientId: string
  private ws: WsLike

  constructor(clientId: string, ws: WsLike) {
    this.clientId = clientId
    this.ws = ws
  }

  send(msg: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(handler: (msg: unknown) => void): () => void {
    const listener = (data: unknown) => {
      try {
        handler(JSON.parse(String(data)))
      } catch {
        // ignore malformed messages
      }
    }
    this.ws.on('message', listener)
    return () => {
      this.ws.off('message', listener)
    }
  }

  onClose(handler: () => void): () => void {
    this.ws.on('close', handler)
    return () => {
      this.ws.off('close', handler)
    }
  }

  close(): void {
    this.ws.close()
  }
}
