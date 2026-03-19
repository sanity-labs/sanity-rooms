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
  state       |    +----------------+        |     +-- getDocumentState() (SDK)
  per doc     +----| Transport      |--------+     +-- editDocument() + applyDocumentActions()
              |    | (pluggable)    |        |     +-- createDocument() for ref docs
SyncClient <--+    +----------------+        +-- DocumentMapping (domain <-> raw)
                                             +-- resolveRefs + fromSanityWithRefs (ref assembly)
                                             +-- client registry + broadcast
                                             +-- app channels (chat, etc.)
                                             +-- Room.ready (waits for all bridges)
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

// 3. On client connection
const room = await manager.getOrCreate(roomId)
await room.ready // waits for SDK to hydrate all docs + refs
room.addClient(transport)
```

### Client

```typescript
import { SyncClient } from 'sanity-rooms/client'

const client = new SyncClient({
  transport,
  documents: {
    config: {
      initialState: config,
      applyMutation: (state, mutation) => {
        if (mutation.kind === 'replace') return mutation.state
        return null
      },
      reconcile: immutableReconcile,
    },
  },
})

// Optimistic state
client.subscribeDoc('config', () => {
  setConfig(client.getDocState('config'))
})

// Mutate (optimistic + debounced send)
client.mutate('config', { kind: 'replace', state: newConfig })

// App channels
client.sendApp('chat', { text: 'hello' })
client.onApp('chat', (payload) => handleChat(payload))
```

## Document references

Custom resources (fonts, palettes, backgrounds) are stored as separate Sanity documents with references from the main doc. The package handles this via:

1. **`resolveRefs(doc)`** — discovers ref IDs from the raw main doc
2. **Ref bridges** — Room auto-subscribes to each ref doc via SDK's shared listener (one connection for all)
3. **`fromSanityWithRefs(doc, refDocs)`** — assembles the complete domain state from main doc + ref docs
4. **`toSanityPatch` returns `refPatches`** — ref doc content to write alongside the main doc
5. **Atomic writes** — ref doc creates + main doc edit go in one `applyDocumentActions` batch
6. **Weak references** — refs use `_weak: true` + `_strengthenOnPublish` so drafts can reference other drafts

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
