# sanity-rooms

> **Early stage** — APIs may change. Core features (sync, refs, publish) are stable and tested.

Transport-agnostic, optimistic document synchronization for Sanity. Multi-client rooms with real-time broadcast, a document mapping layer, publishing, and app-defined channels — on top of `@sanity/sdk`.

## What this is

A coordination layer between `@sanity/sdk` and your app. It handles:

- **Rooms** — server-side state hubs managing N clients x M documents
- **Two-layer architecture** — SDK layer (raw Sanity docs) + domain layer (your app's mapped state)
- **Document mapping** — `fromSanity`/`toSanityPatch` translate between Sanity's shape and yours
- **Ref following** — `resolveRefs` discovers referenced docs, Room auto-subscribes via SDK's shared listener
- **Publishing** — `Room.publish(docKey)` publishes a doc and all its refs in one batch
- **Transports** — built-in WebSocket adapters for browser and Node, or implement your own (4 methods)
- **App channels** — named channels for concerns the package doesn't own (chat, presence, streaming)
- **Echo suppression** — tracks transaction IDs, skips SDK echoes from own writes

## Quick Start

### Server

```typescript
import { RoomManager } from 'sanity-rooms/server'
import { WsServerTransport } from 'sanity-rooms/transport/ws-server'
import { createSanityInstance } from '@sanity/sdk'

const manager = new RoomManager({
  // `instanceFactory` lets RoomManager own the SDK lifecycle and
  // recover from stalls. See "Resilience" below. Pass a literal
  // `instance:` instead if you want full control (e.g. tests).
  instanceFactory: () => createSanityInstance({ projectId: 'xxx', dataset: 'production', auth: { token } }),
  resource: { projectId: 'xxx', dataset: 'production' },
  factory: {
    async create(roomId, context) {
      // context = whatever you pass to getOrCreate (e.g. authenticated user)
      return {
        documents: {
          config: {
            docId: roomId,
            mapping: {
              documentType: 'myDocument',
              fromSanity: (doc) => doc,
              toSanityPatch: (state) => ({ patch: state }),
              applyMutation: (state, mutation) =>
                mutation.kind === 'replace' ? mutation.state : null,
            },
          },
        },
      }
    },
  },
  readyTimeoutMs: 15000,  // optional, default 15s
  logger: console,         // optional, default console
})

// On WebSocket upgrade:
const room = await manager.getOrCreate(roomId, authenticatedUser)
if (!room) { socket.destroy(); return }
room.addClient(new WsServerTransport(clientId, ws))
```

### Client (browser)

```typescript
import { SyncClient } from 'sanity-rooms/client'
import { WsClientTransport } from 'sanity-rooms/transport/ws-client'

const client = new SyncClient({
  transport: new WsClientTransport('wss://example.com/ws/my-room'),
  documents: {
    config: {
      applyMutation: (state, mutation) =>
        mutation.kind === 'replace' ? mutation.state : null,
    },
  },
})

await client.ready // wait for server hydration

client.getDocState('config')                                          // read
client.mutate('config', { kind: 'replace', state: { title: 'Hi' } }) // write (optimistic, debounced)
client.subscribeDoc('config', () => { /* state changed */ })          // listen
client.hasPendingWrites()                                             // unsaved changes?
```

### React integration (~10 lines)

```typescript
function useDocState<T>(client: SyncClient, docId: string): T {
  return useSyncExternalStore(
    (cb) => client.subscribeDoc(docId, cb),
    () => client.getDocState<T>(docId),
  )
}
```

## Packages

| Export | Import | Contains |
|--------|--------|----------|
| `.` | `sanity-rooms` | Types, protocol, Logger, mapping, utilities |
| `./server` | `sanity-rooms/server` | Room, RoomManager, SanityBridge |
| `./client` | `sanity-rooms/client` | SyncClient, MutationQueue |
| `./transport/ws-client` | `sanity-rooms/transport/ws-client` | Browser WebSocket (reconnecting) |
| `./transport/ws-server` | `sanity-rooms/transport/ws-server` | Node `ws` adapter |
| `./testing` | `sanity-rooms/testing` | In-process transport, mock SDK |

## Architecture

```
Browser                                   Server (Node)
───────                                   ─────────────
SyncClient                                Room
  optimistic state ←──Transport──→          SanityBridge per doc
  diff at flush time                        DocumentMapping (domain ↔ raw)
  @sanity/diff-patch                        resolveRefs + ref assembly
  @sanity/mutator                           client registry + broadcast
                                            app channels, publish, lifecycle
```

**SanityBridge** stores raw Sanity docs. Subscribes via SDK, writes via SDK. No domain knowledge.
**Room** owns domain logic. Mapping, ref assembly, broadcast, publish, app channels.

## How sync works

1. **Optimistic** — `client.mutate()` updates local state instantly
2. **Debounce** — rapid edits coalesce into one send
3. **Diff** — `@sanity/diff-patch` produces granular Sanity-native patches (only changed fields)
4. **Server** — Room applies patches, writes to Sanity, broadcasts to other clients
5. **Rebase** — when external changes arrive, SyncClient replays unsent local changes on top
6. **Reconnect** — full reset to server state (unsent local edits lost)

## Mutations

| Kind | Use case | Who produces it |
|------|----------|-----------------|
| `replace` | Full state update (UI edits) | Your app — most common |
| `named` | Intent-based (e.g. "addFrame") | Your app, server interprets |
| `sanityPatch` | Granular field diffs | SyncClient internally |
| `merge` | Shallow key merge | Internal |

**For most apps, you only need `replace`.** SyncClient handles diffing.

## Document references

Ref docs (fonts, palettes, backgrounds) are separate Sanity documents referenced by the main doc:

1. `resolveRefs(rawDoc)` → returns `RefDescriptor[]` (docId + mapping per ref)
2. Room creates a SanityBridge per ref (auto-subscribes via SDK shared listener)
3. `fromSanityWithRefs(rawDoc, refDocs)` → assembles domain state with dereferenced content
4. `toSanityPatch(state)` → returns `{ patch, refPatches }` — both written atomically
5. Refs use `_weak: true` + `_strengthenOnPublish` so drafts can reference other drafts

## Publishing

All edits go to **drafts** (SDK behavior). `Room.publish()` makes content live:

```typescript
const result = await room.publish('config')
// { success: true } or { success: false, error: 'reason' }
```

Publishes ref docs first, then main doc. Weak refs auto-strengthen on publish.

| Operation | Targets |
|-----------|---------|
| `client.mutate()` → Room → `editDocument` | Drafts only |
| `room.publish()` → `publishDocument` | Draft → Published |
| GROQ `perspective: 'published'` | Published only |

### Dirty tracking

`Room.onMutation(cb)` fires after every mutation (from any client or `room.mutateDoc()`):

```typescript
room.onMutation((docKey) => {
  if (docKey === 'config') hasUnpublishedChanges = true
})
```

### Publish via app channel (recommended)

```typescript
// Server
room.registerAppChannel('publish', {
  onMessage: async (_clientId, payload) => {
    if (payload.type === 'publish-request') {
      const result = await room.publish('config')
      room.broadcastApp('publish', result.success
        ? { type: 'publish-success' }
        : { type: 'publish-failed', error: result.error })
    }
  },
})

// Client
client.sendApp('publish', { type: 'publish-request' })
client.onApp('publish', (msg) => { /* update UI */ })
```

## Auth pattern

The factory's `context` argument carries auth info:

```typescript
const manager = new RoomManager({
  instance, resource,
  factory: {
    async create(roomId, context) {
      const user = context as SessionUser
      const doc = await sanityClient.fetch(`*[_type == "myDoc" && _id == $id][0]{ _id, owner }`, { id: roomId })
      if (!doc || doc.owner?._ref !== user.id) return null  // reject
      return { documents: { config: { docId: doc._id, mapping } } }
    },
  },
})

const room = await manager.getOrCreate(roomId, authenticatedUser)
```

## Error handling

- `Room.publish()` returns `{ success: false, error }` — never throws
- `SyncClient.mutate()` / `getDocState()` / `sendApp()` throw if disposed or not hydrated
- App channel handlers are wrapped in try-catch — errors are logged, room keeps running
- `RoomManager.getOrCreate()` returns `null` on factory rejection or ready-timeout
- `SyncClient.ready` **rejects** if the transport closes or the client is disposed before the first hydration — callers can `await client.ready` and surface a real "couldn't reach the server" UI instead of waiting forever

All logging goes through a configurable `Logger` interface (default: `console`):

```typescript
import type { Logger } from 'sanity-rooms'
const logger: Logger = { error: Sentry.captureException, warn: console.warn, info: console.info, debug: () => {} }
new RoomManager({ instance, resource, factory, logger })
```

## Resilience

### Connection state

`SyncClient.status` is `'connecting' | 'connected' | 'disconnected'`. Initial state is `'connecting'` — apps can show a real reconnect affordance during first connect AND during reconnects.

```typescript
client.onStatus((status) => setReconnecting(status !== 'connected'))
```

`client.ready` rejects (instead of hanging) if the transport closes before the first hydration. Callers can `await client.ready` and surface a real error UI.

### SDK lifecycle

Pass `instanceFactory` so the manager owns the SDK — `manager.dispose()` then disposes the SDK too.

```typescript
new RoomManager({
  instanceFactory: () => createSanityInstance({ projectId, dataset, auth: { token } }),
  resource: { projectId, dataset },
  factory: { /* … */ },
  readyTimeoutMs: 15_000,  // default
})
```

### Diagnostic stall detection (opt in)

`SanityBridge` accepts `firstEmitTimeoutMs` (default `0`, off). When set, the bridge fires `onStall(reason)` if the SDK observable hasn't emitted a non-null doc in that window — useful for surfacing missing-doc / auth / schema issues with a clear reason.

```typescript
new SanityBridge({
  ...,
  firstEmitTimeoutMs: 10_000,
  onStall: (reason) => logger.warn(reason),
})
```

### Buffer cap

A stalled bridge caps its pending-writes queue at `maxPendingWrites` (default 200) — oldest dropped first since the newest replace state supersedes them.

## Custom transports

The built-in `WsClientTransport` and `WsServerTransport` cover most cases. For other protocols, implement the interface:

```typescript
interface Transport {
  send(msg: unknown): void
  onMessage(handler: (msg: unknown) => void): () => void  // returns unsubscribe
  onClose(handler: () => void): () => void                // returns unsubscribe
  onOpen?(handler: () => void): () => void                // optional — lets SyncClient emit 'connecting' on reconnect dial
  close(): void
}

interface ServerTransport extends Transport {
  readonly clientId: string
}
```

For testing, use `createMemoryTransportPair()` from `sanity-rooms/testing` — linked in-process pair, no network. `createMockSanity().setSilent(docId)` simulates a stalled SDK observable so you can exercise stall + recreate paths without a real Sanity project.

## What's NOT here yet

- **Nested refs** — ref docs can't themselves have refs (one level only)
- **GROQ query subscriptions** — planned with local evaluation via `groq-js`
- **SDK auto-recreate on persistent failure** — if a long-running SDK instance drifts into a stuck state, the lib provides no auto-recovery. Apps that need it can dispose + rebuild the manager themselves; the lib intentionally doesn't ship the heuristic since "fresh SDK every N timeouts" masks more bugs than it fixes.
