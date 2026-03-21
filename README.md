# sanity-rooms

> **⚠️ Proof of Concept — Work in Progress**
> This is an early-stage experiment, 100% vibecoded. APIs will change. Not production-ready.

Transport-agnostic, optimistic document synchronization for Sanity. Provides multi-client rooms with real-time broadcast, a document mapping layer, and app-defined channels — on top of `@sanity/sdk`'s document store and shared listener.

## What this is

A coordination layer between `@sanity/sdk` (Sanity connection) and your app (multiple clients editing documents). It handles:

- **Rooms** — server-side state hubs managing N clients x M documents
- **Two-layer architecture** — SDK layer (raw Sanity docs) + domain layer (your app's mapped state)
- **Document mapping** — your in-memory state shape != Sanity doc shape? Provide `fromSanity`/`toSanityPatch` and the Room handles translation
- **Ref following** — `resolveRefs` discovers referenced docs, Room auto-subscribes via SDK's shared listener (zero extra connections), `fromSanityWithRefs` assembles the full state
- **Transport abstraction** — WebSocket, POST+SSE, long-polling, in-process. Implement 4 methods, done.
- **App channels** — first-class named channels for concerns the package doesn't own (chat, presence, streaming)
- **Own-write echo suppression** — tracks transaction IDs, skips SDK echoes from our own writes

## What this is NOT

| Concern | sanity-rooms | Where it lives instead |
|---------|------------|----------------------|
| Sanity API client | No | `@sanity/client` |
| React hooks | No | Your app (`useSyncExternalStore` wrapper is ~10 lines) |
| Auth, permissions | No | Your app / transport layer |
| GROQ queries | Not yet | Planned: local evaluation via `groq-js` with optimistic state |
| AI chat, streaming | No | App channel (`room.registerAppChannel('chat', ...)`) |
| WebSocket server | No | Your app provides a `Transport` adapter |

## Architecture

```
Clients (browser)                         Your Server (Node)
-----------------                         ------------------
SyncClient <--+                            Room
  optimistic  |                              +-- SanityBridge per doc (raw doc store)
  local state |    +----------------+        |     +-- getDocumentState() (SDK)
  diff at     +----| Transport      |--------+     +-- editDocument() + applyDocumentActions()
  flush time  |    | (pluggable)    |        +-- DocumentMapping (domain <-> raw)
SyncClient <--+    +----------------+        +-- resolveRefs + fromSanityWithRefs (ref assembly)
                                             +-- client registry + broadcast
  @sanity/diff-patch (diffValue)             +-- app channels (chat, etc.)
  @sanity/mutator (apply patches)            +-- Room.ready (waits for all bridges)
                                             +-- grace period lifecycle
```

**Two layers, clean separation:**
- **SanityBridge** stores raw Sanity docs. Subscribes via SDK, writes via SDK. No domain knowledge.
- **Room** owns all domain logic. Maps raw docs to app state, assembles refs, broadcasts to clients.

## Packages

| Export | Import | Contains |
|--------|--------|----------|
| `.` | `import { ... } from 'sanity-rooms'` | Types, protocol, transport, mapping, channel helpers, debounce, reconcile |
| `./server` | `import { Room, RoomManager } from 'sanity-rooms/server'` | Room, RoomManager, SanityBridge, SanityResource |
| `./client` | `import { SyncClient } from 'sanity-rooms/client'` | SyncClient, MutationQueue |
| `./testing` | `import { createMemoryTransportPair, createMockSanity } from 'sanity-rooms/testing'` | In-process transport, mock SDK |

## Usage

### Server

```typescript
import { createSanityInstance } from '@sanity/sdk'
import { Room, RoomManager } from 'sanity-rooms/server'
import type { DocumentMapping } from 'sanity-rooms'

const instance = createSanityInstance({ projectId, dataset, auth: { token } })
const resource = { projectId, dataset }

// 1. Define your mapping
const messageMapping: DocumentMapping<MessageConfig> = {
  documentType: 'message',
  fromSanity: (doc) => sanityToConfig(doc),
  toSanityPatch: (state) => {
    const result = configToSanity(state)
    return { patch: result.message, refPatches: buildRefPatches(result) }
  },
  applyMutation: (state, mutation) => {
    if (mutation.kind === 'replace') return mutation.state
    return null
  },
  resolveRefs: (doc) => extractCustomResourceRefs(doc),
  fromSanityWithRefs: (doc, refDocs) => assembleWithDereferencedRefs(doc, refDocs),
}

// 2. Create rooms via a factory
const manager = new RoomManager(instance, resource, {
  async create(roomId) {
    const doc = await sanityClient.fetch(`*[_id == $id][0]{ _id }`, { id: roomId })
    if (!doc) return null
    return { documents: { config: { docId: doc._id, mapping: messageMapping } } }
  },
})

// 3. On client connection — create a transport pair and wire both sides
const room = await manager.getOrCreate(roomId)
await room.ready // waits for SDK to hydrate all docs + refs
```

### Connecting clients to rooms

The `Transport` interface is how clients and rooms communicate. Each connection needs a **pair** — a client-side transport and a server-side transport linked together. What links them is up to you: WebSocket, HTTP, or shared memory.

#### Option A: WebSocket

```typescript
import type { ServerTransport } from 'sanity-rooms'

// Server: on WS connection, wrap the socket in a ServerTransport
wss.on('connection', (ws) => {
  const transport: ServerTransport = {
    clientId: crypto.randomUUID(),
    send: (msg) => ws.send(JSON.stringify(msg)),
    onMessage: (handler) => {
      const fn = (data: any) => handler(JSON.parse(String(data)))
      ws.on('message', fn)
      return () => ws.off('message', fn)
    },
    onClose: (handler) => { ws.on('close', handler); return () => ws.off('close', handler) },
    close: () => ws.close(),
  }
  room.addClient(transport)
})

// Client (browser): wrap the browser WebSocket
const ws = new WebSocket('wss://...')
const transport: Transport = {
  send: (msg) => ws.send(JSON.stringify(msg)),
  onMessage: (handler) => {
    const fn = (e: MessageEvent) => handler(JSON.parse(e.data))
    ws.addEventListener('message', fn)
    return () => ws.removeEventListener('message', fn)
  },
  onClose: (handler) => { ws.addEventListener('close', handler); return () => ws.removeEventListener('close', handler) },
  close: () => ws.close(),
}
const syncClient = new SyncClient({ transport, documents: { ... } })
```

#### Option B: In-process (no network)

For testing, SSR, or same-process setups where client and server run in the same Node process:

```typescript
import { createMemoryTransportPair } from 'sanity-rooms/testing'

// Creates a linked pair — send on one side, receive on the other
const { client, server } = createMemoryTransportPair()

// Server side
room.addClient(server)

// Client side — same process, no WebSocket
const syncClient = new SyncClient({ transport: client, documents: { ... } })

// They communicate via microtasks — no serialization, no network
syncClient.mutate('config', { kind: 'replace', state: newConfig })
```

### Client API

```typescript
import { SyncClient } from 'sanity-rooms/client'

const syncClient = new SyncClient({
  transport, // from either option above
  documents: {
    config: {
      initialState: config,
      applyMutation: (state, mutation) => {
        if (mutation.kind === 'replace') return mutation.state
        return null
      },
      reconcile: immutableReconcile, // preserve referential identity
    },
  },
})

// Read state (optimistic — includes pending mutations)
syncClient.subscribeDoc('config', () => {
  const updated = syncClient.getDocState('config')
  setConfig(updated) // React setState, Svelte store, etc.
})

// Mutate — just pass the full new state. SyncClient handles the rest:
// - Updates localState instantly (optimistic)
// - At flush time, diffs against lastSentState using @sanity/diff-patch
// - Sends only changed fields as Sanity-native patch operations
// - Concurrent edits compose correctly (_key-based array diffs)
syncClient.mutate('config', { kind: 'replace', state: newConfig })

// App channels (chat, presence, whatever)
syncClient.sendApp('chat', { text: 'hello' })
syncClient.onApp('chat', (payload) => handleChat(payload))
```

### How diff-at-flush works

The caller sends `{ kind: 'replace', state: fullNewState }` — the simplest possible API. Internally:

1. **Optimistic update** — `localState = newState` immediately. No queue, no diffing.
2. **Debounce** — rapid edits (slider drags) coalesce into one send.
3. **Flush** — `diffValue(lastSentState, localState)` from `@sanity/diff-patch` produces `SanityPatchOperations[]`. Only changed fields are sent over the wire.
4. **Server** — applies patches to its state, writes to Sanity via `toSanityPatch` (handles ref docs), broadcasts full state to other clients.
5. **External changes** — when the server broadcasts state from another client or AI, `SyncClient` reapplies unsent local changes on top using `@sanity/mutator`. Since patches are per-key and per-array-item (`_key`), concurrent edits to different parts of the document compose correctly.
6. **Reconnect** — full reset to server state. Unsent local edits are lost (same as any unsaved work).

## Document references

Custom resources (fonts, palettes, backgrounds) are stored as separate Sanity documents with references from the main doc. The package handles this via:

1. **`resolveRefs(doc)`** — discovers ref IDs from the raw main doc
2. **Ref bridges** — Room auto-subscribes to each ref doc via SDK's shared listener (one connection for all)
3. **`fromSanityWithRefs(doc, refDocs)`** — assembles the complete domain state from main doc + ref docs
4. **`toSanityPatch` returns `refPatches`** — ref doc content to write alongside the main doc
5. **Atomic writes** — ref doc edits + main doc edit go in one `applyDocumentActions` batch
6. **Ref doc upsert** — uses `editDocument` (not `createDocument`) for ref docs so existing drafts don't cause batch failures
7. **Weak references** — refs use `_weak: true` + `_strengthenOnPublish` so drafts can reference other drafts

## What's NOT here yet

- **GROQ query subscriptions** — planned with local evaluation via `groq-js`
- **React bindings** — trivial:
  ```typescript
  function useDocState<T>(client: SyncClient, docId: string): T {
    return useSyncExternalStore(
      (cb) => client.subscribeDoc(docId, cb),
      () => client.getDocState<T>(docId),
    )
  }
  ```
