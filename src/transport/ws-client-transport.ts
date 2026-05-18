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

/** Maximum messages to hold in the outbound queue while the socket
 *  isn't OPEN. Sized so a voter clicking stars rapidly during a 10s
 *  network blip won't lose any: 50 = ~5 mutations/s × 10s. Exceed it
 *  and the oldest is dropped (with a console.warn so it's visible). */
const DEFAULT_OUTBOUND_QUEUE_LIMIT = 256

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
  /** Outbound queue — messages submitted via `send()` while the socket
   *  isn't OPEN. Drained on `onopen`. Before F6 this was a silent drop:
   *  if `SyncClient.flush()` fired during the disconnect-then-reconnect
   *  window of a network blip, the mutation was lost forever with zero
   *  signal. Now we buffer and replay; if the queue exceeds
   *  `outboundQueueLimit` the oldest is dropped (with a warn). */
  private outboundQueue: string[] = []
  private outboundQueueLimit: number
  private outboundDroppedCount = 0

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
    this.outboundQueueLimit = DEFAULT_OUTBOUND_QUEUE_LIMIT
    this.connect()
  }

  send(msg: unknown): void {
    const serialized = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (this.debug && !this.debugIgnoreChannels.has((msg as any).channel))
        console.log('[ws:out]', (msg as any).type, (msg as any).channel, msg)
      this.ws.send(serialized)
      return
    }
    // Socket isn't OPEN (CONNECTING/CLOSING/CLOSED/null). Queue so
    // we don't drop the message during a network blip.
    if (this.outboundQueue.length >= this.outboundQueueLimit) {
      this.outboundQueue.shift()
      this.outboundDroppedCount++
      if (this.debug || this.outboundDroppedCount === 1) {
        console.warn(
          `[ws] outbound queue full (${this.outboundQueueLimit}) — dropping oldest. total dropped=${this.outboundDroppedCount}`,
        )
      }
    }
    this.outboundQueue.push(serialized)
    if (this.debug && !this.debugIgnoreChannels.has((msg as any).channel))
      console.log('[ws:queued]', (msg as any).type, (msg as any).channel, `qLen=${this.outboundQueue.length}`)
  }

  /** Drain the outbound queue through the (newly OPEN) socket. */
  private drainOutboundQueue(): void {
    if (this.outboundQueue.length === 0) return
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const drained = this.outboundQueue.length
    for (const s of this.outboundQueue) {
      try {
        this.ws.send(s)
      } catch (err) {
        if (this.debug) console.error('[ws] drain send error:', err)
      }
    }
    this.outboundQueue = []
    if (this.debug) console.log(`[ws] drained ${drained} queued message(s) after reconnect`)
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
      // Drain queued outbound messages before letting open handlers run
      // — that way the SyncClient sees its earlier sends honored before
      // any onOpen-triggered "(re)hydrating" logic runs.
      this.drainOutboundQueue()
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
