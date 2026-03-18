# sanity-rooms

Transport-agnostic, optimistic document synchronization for Sanity. Provides multi-client rooms with real-time broadcast, a document mapping layer, and app-defined channels — on top of `@sanity/sdk`'s listener and conflict resolution infrastructure.

## What this is

A coordination layer between `@sanity/sdk` (Sanity connection) and your app (multiple clients editing documents). It handles:

- **Rooms** — server-side state hubs managing N clients × M documents
- **Optimistic updates** — two levels: client→server (immediate UI), server→Sanity (via sdk)
- **Document mapping** — your in-memory state shape ≠ Sanity doc shape? Provide `fromSanity`/`toSanityPatch` and the package handles the translation
- **Transport abstraction** — WebSocket, POST+SSE, long-polling, in-process. Implement 4 methods, done.
- **App channels** — first-class named channels for concerns the package doesn't own (chat, presence, streaming)

## What this is NOT

| Concern | sanity-rooms | Where it lives instead |
|---------|------------|----------------------|
| Sanity API client | No | `@sanity/client` |
| Document listeners, conflict rebase, revision tracking | No (delegates) | `@sanity/sdk` via `SdkAdapter` |
| React hooks | No | Your app (`useSyncExternalStore` wrapper is ~10 lines) |
| Auth, permissions | No | Your app / transport layer |
| GROQ queries | Not yet | Planned: local evaluation via `groq-js` with optimistic state |
| AI chat, streaming | No | App channel (`room.registerAppChannel('chat', ...)`) |
| WebSocket server | No | Your app provides a `Transport` adapter |

## Comparison with @sanity/sdk

| Feature | @sanity/sdk | sanity-rooms |
|---------|------------|-------------|
| **Single-client document state** | `getDocumentState()` → reactive `StateSource` | `SyncClient.getDocState()` + `subscribeDoc()` |
| **Optimistic updates** | `editDocument()` with automatic rebase | Client-side `MutationQueue` with rebase on server state |
| **Conflict resolution** | Automatic 3-way merge | Delegates to sdk on server side; client rebases pending mutations |
| **Shared listener** | Single EventSource, multicasted | Delegates to sdk (via `SdkAdapter.subscribe`) |
| **Multi-client broadcast** | ❌ Single consumer | ✅ Room broadcasts to N clients |
| **Transport** | Hardcoded (Sanity API over HTTP/WS) | Pluggable (`Transport` interface) |
| **Shape mapping** | ❌ Stored shape = in-memory shape | ✅ `DocumentMapping` with `fromSanity`/`toSanityPatch` |
| **App-defined channels** | ❌ | ✅ Named channels with handlers |
| **Room lifecycle** | ❌ | ✅ Grace period, dispose, `onEmpty` callback |
| **Server-side usage** | Works but not optimized | Designed for it (Room runs on your server) |
| **React dependency** | Optional (hooks in `@sanity/sdk-react`) | None |
| **GROQ queries** | `getQueryState()` / `resolveQuery()` | Not yet (planned with local evaluation) |

**In short:** `@sanity/sdk` manages one client's connection to Sanity. `sanity-rooms` manages N clients' connections to your server, which uses `@sanity/sdk` to talk to Sanity.

## Architecture

```
Clients (browser)                         Your Server (Node)
─────────────────                         ──────────────────
SyncClient ←─┐                            Room
  optimistic │                              ├─ SanityBridge per doc
  state      │    ┌──────────────┐          │   ├─ SdkAdapter.subscribe()
  per doc    ├────│  Transport   │──────────│   ├─ SdkAdapter.applyPatches()
             │    │  (anything)  │          │   └─ DocumentMapping
SyncClient ←─┘    └──────────────┘          ├─ client registry + broadcast
                                            ├─ app channels (chat, etc.)
                                            └─ grace period lifecycle
```

## Packages

| Export | Import | Contains |
|--------|--------|----------|
| `.` | `import { ... } from 'sanity-rooms'` | Types, protocol, transport, mapping, channel helpers, debounce, reconcile |
| `./server` | `import { Room, RoomManager } from 'sanity-rooms/server'` | Room, RoomManager, SanityBridge, SdkAdapter |
| `./client` | `import { SyncClient } from 'sanity-rooms/client'` | SyncClient, MutationQueue |
| `./testing` | `import { createMemoryTransportPair, createMockSanity } from 'sanity-rooms/testing'` | In-process transport, mock Sanity adapter |

## Usage

### Server

```typescript
import { Room, RoomManager } from 'sanity-rooms/server'
import type { DocumentMapping } from 'sanity-rooms'

// 1. Define how your state maps to/from Sanity documents
const messageMapping: DocumentMapping<MessageConfig> = {
  documentType: 'message',
  projection: '{ ..., customFonts[]-> }',
  fromSanity: (doc) => sanityToConfig(doc),
  toSanityPatch: (state) => configToSanity(state),
  applyMutation: (state, mutation) => {
    if (mutation.kind === 'replace') return mutation.state as MessageConfig
    return null
  },
}

// 2. Create an SdkAdapter (bridges @sanity/sdk to sanity-rooms)
const adapter: SdkAdapter = {
  subscribe(docId, docType, callback) {
    const state = getDocumentState(sanityInstance, { documentId: docId, documentType: docType })
    const sub = state.observable.subscribe((doc) => callback(doc))
    return () => sub.unsubscribe()
  },
  applyPatches(docId, docType, patches) {
    editDocument({ documentId: docId, documentType: docType }, { set: patches })
  },
}

// 3. Create rooms via a factory
const manager = new RoomManager(adapter, {
  async create(roomId, context) {
    const doc = await fetchDoc(roomId)
    if (!doc) return null
    return {
      documents: {
        message: { docId: doc._id, mapping: messageMapping, initialState: sanityToConfig(doc) },
      },
    }
  },
})

// 4. On client connection (WebSocket example)
wss.on('connection', async (ws) => {
  const room = await manager.getOrCreate(roomId)
  const transport = createWsTransport(ws)  // you write this adapter
  room.addClient(transport)
})
```

### Client

```typescript
import { SyncClient } from 'sanity-rooms/client'

const client = new SyncClient({
  transport: createWsTransport(ws),  // you write this adapter
  documents: {
    message: {
      initialState: config,
      applyMutation: (state, mutation) => {
        if (mutation.kind === 'replace') return mutation.state
        return null
      },
      reconcile: immutableReconcile,  // preserve referential identity
    },
  },
})

// Read state (optimistic — includes pending mutations)
const config = client.getDocState<MessageConfig>('message')

// Subscribe to changes
client.subscribeDoc('message', () => {
  const updated = client.getDocState<MessageConfig>('message')
  setConfig(updated) // React setState, Svelte store, etc.
})

// Mutate (applied optimistically, sent to server debounced)
client.mutate('message', { kind: 'replace', state: newConfig })

// App channels (chat, presence, whatever)
client.sendApp('chat', { text: 'hello' })
client.onApp('chat', (payload) => handleChatMessage(payload))
```

### Transport adapter (WebSocket example, ~20 lines)

```typescript
import type { Transport, ServerTransport } from 'sanity-rooms'

function createWsServerTransport(ws: WebSocket, clientId: string): ServerTransport {
  return {
    clientId,
    send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
    onMessage: (handler) => {
      const listener = (data: any) => handler(JSON.parse(String(data)))
      ws.on('message', listener)
      return () => ws.off('message', listener)
    },
    onClose: (handler) => { ws.on('close', handler); return () => ws.off('close', handler) },
    close: () => ws.close(),
  }
}
```

## Mutation kinds

| Kind | Payload | Use case |
|------|---------|----------|
| `replace` | Full state object | Simplest — send entire state. Start here. |
| `named` | `{ name, input }` | Intent-based (e.g. "addFrame at index 3"). Better conflict resolution. |
| `patch` | Sanity-style patches | Raw field-level patches. Most granular. |

All three flow through the same protocol. Your `DocumentMapping.applyMutation` decides how to handle each kind.

## App channels

The package routes `doc:*` channels internally. Everything else is an **app channel** — the package forwards messages without interpreting them.

```typescript
// Server: register a handler
room.registerAppChannel('chat', {
  onMessage(clientId, payload, room) {
    // Process the message, then broadcast
    room.broadcastApp('chat', { from: clientId, ...payload }, clientId)
  },
  onClientJoin(clientId, room) { /* send history, etc. */ },
  onClientLeave(clientId, room) { /* cleanup */ },
})

// Server: send directly to one client
room.sendApp(clientId, 'chat', { type: 'system', text: 'Welcome!' })

// Client: send and receive
client.sendApp('chat', { text: 'hello' })
client.onApp('chat', (payload) => { /* handle */ })
```

## What's NOT here yet

- **GROQ query subscriptions** — planned. Will use `groq-js` to evaluate queries locally against optimistic document state, so results update immediately (not after Sanity API round-trip).
- **Reconnection** — `SyncClient` detects disconnect via `onClose` and exposes `status`. Reconnection logic (retry, backoff, re-auth) is your transport adapter's responsibility. On reconnect, the Room sends current state automatically.
- **React bindings** — trivial to add in your app:
  ```typescript
  function useDocState<T>(client: SyncClient, docId: string): T {
    return useSyncExternalStore(
      (cb) => client.subscribeDoc(docId, cb),
      () => client.getDocState<T>(docId),
    )
  }
  ```
