/**
 * WebSocket transport adapter for the browser.
 *
 * Wraps a browser `WebSocket` in the sanity-rooms `Transport` interface.
 * Handles reconnection with exponential backoff (1s base, 1.5× multiplier,
 * max 10s). Accepts a full WebSocket URL so it's not tied to any URL convention.
 *
 * @example
 * ```typescript
 * const transport = new WsClientTransport('wss://example.com/ws/my-room')
 * const client = new SyncClient({ transport, documents: { ... } })
 * ```
 */

import type { Transport } from '../transport'

export interface WsClientTransportOptions {
  /** Full WebSocket URL (e.g. `wss://example.com/ws/room-id`). */
  url: string
  /** Enable console logging of sent/received messages. Default: false. */
  debug?: boolean
  /** Channel names to suppress from debug logging (e.g. `['presence']`). */
  debugIgnoreChannels?: string[]
}

export class WsClientTransport implements Transport {
  private ws: WebSocket | null = null
  private messageHandlers = new Set<(msg: unknown) => void>()
  private closeHandlers = new Set<() => void>()
  private openHandlers = new Set<() => void>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private url: string
  private debug: boolean
  private debugIgnoreChannels: Set<string>
  private disposed = false

  constructor(url: string)
  constructor(options: WsClientTransportOptions)
  constructor(urlOrOptions: string | WsClientTransportOptions) {
    if (typeof urlOrOptions === 'string') {
      this.url = urlOrOptions
      this.debug = false
      this.debugIgnoreChannels = new Set()
    } else {
      this.url = urlOrOptions.url
      this.debug = urlOrOptions.debug ?? false
      this.debugIgnoreChannels = new Set(urlOrOptions.debugIgnoreChannels)
    }
    this.connect()
  }

  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.debug && !this.debugIgnoreChannels.has((msg as any).channel))
        console.log('[ws:out]', (msg as any).type, (msg as any).channel, msg)
      this.ws.send(JSON.stringify(msg))
    }
  }

  onMessage(handler: (msg: unknown) => void): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler)
    return () => {
      this.openHandlers.delete(handler)
    }
  }

  close(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  private connect(): void {
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      if (this.debug) console.log('[ws] connected')
      this.reconnectAttempt = 0
      for (const h of this.openHandlers) h()
    }

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string)
        if (this.debug && !this.debugIgnoreChannels.has((msg as any).channel))
          console.log('[ws:in]', (msg as any).type, (msg as any).channel, msg)
        for (const h of this.messageHandlers) h(msg)
      } catch {
        // ignore malformed messages
      }
    }

    this.ws.onerror = (e) => {
      if (this.debug) console.error('[ws] error:', e)
    }

    this.ws.onclose = (e) => {
      if (this.debug) console.log('[ws] closed:', e.code, e.reason)
      for (const h of this.closeHandlers) h()
      if (!this.disposed) this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(10_000, 1000 * 1.5 ** this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }
}
