/**
 * Transport abstraction — the only thing sanity-sync needs from whatever
 * carries messages between client and server. WebSocket, POST+SSE,
 * long-polling, in-process — anything that implements this interface works.
 */

export interface Transport {
  send(msg: unknown): void
  onMessage(handler: (msg: unknown) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

/**
 * Server-side transport handle for one connected client.
 * Created by the transport adapter when a client connects.
 */
export interface ServerTransport extends Transport {
  readonly clientId: string
}
