/**
 * Transport abstraction — the only thing sanity-sync needs from whatever
 * carries messages between client and server. WebSocket, POST+SSE,
 * long-polling, in-process — anything that implements this interface works.
 */

export interface Transport {
  /** Send a JSON-serializable message to the other side. */
  send(msg: unknown): void
  /** Register a message handler. Returns an unsubscribe function. */
  onMessage(handler: (msg: unknown) => void): () => void
  /** Register a close/disconnect handler. Returns an unsubscribe function. */
  onClose(handler: () => void): () => void
  /** Optional. Fires on every successful open (including reconnects).
   *  When omitted, SyncClient uses the first server message as the
   *  "connected" signal and can't distinguish "dialling" from "hung". */
  onOpen?(handler: () => void): () => void
  /** Close the connection. */
  close(): void
}

/**
 * Server-side transport handle for one connected client.
 * Created by the transport adapter when a client connects.
 */
export interface ServerTransport extends Transport {
  readonly clientId: string
}
