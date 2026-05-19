# sanity-rooms

> **Early stage** — APIs may change. Core features (sync, refs, publish) are stable and tested.

Transport-agnostic, optimistic document synchronization for Sanity. Multi-client rooms with real-time broadcast, a document mapping layer, publishing, and app-defined channels — on top of `@sanity/sdk`.

> 📘 **Building a new app on top of this?** Read [`EXAMPLE.md`](./EXAMPLE.md) first.
> It's a complete, self-contained walkthrough using a "Mood Board" domain (board doc with inline children + image ref docs) that exercises every concept — `DocumentMapping`, `resolveRefs`, ref dereferencing, image uploads, weak refs, publishing, app channels, multiplayer correctness, HMR, reconnect — and calls out the mistakes that trip up implementers (REST‑instead‑of‑WS, embedded asset refs, custom protocols). The README below is a reference once you've understood the shape.

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
  // Required: called once per unique `RoomConfig.instanceKey` the manager sees.
  // Each instance is disposed when the last room with that key disposes.
  instanceFactory: () => createSanityInstance({ projectId: 'xxx', dataset: 'production', auth: { token } }),
  resource: { projectId: 'xxx', dataset: 'production' },
  factory: {
    async create(roomId, context) {
      // context = whatever you pass to getOrCreate (e.g. authenticated user)
      return {
        // REQUIRED: identifies the SanityInstance pool this room joins.
        // Rooms with the same key share a SanityInstance; rooms with
        // different keys are fully isolated. See "Instance pooling" below.
        instanceKey: `doc:${roomId}`,
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
  instanceFactory,
  resource,
  factory: {
    async create(roomId, context) {
      const user = context as SessionUser
      const doc = await sanityClient.fetch(`*[_type == "myDoc" && _id == $id][0]{ _id, owner }`, { id: roomId })
      if (!doc || doc.owner?._ref !== user.id) return null  // reject
      return {
        instanceKey: `doc:${doc._id}`,
        documents: { config: { docId: doc._id, mapping } },
      }
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
new RoomManager({ instanceFactory, resource, factory, logger })
```

## Instance pooling

> Tl;dr: **`RoomConfig.instanceKey` is required.** Choose it so a fault in one tenant's docs can't reach another tenant. Different keys = isolated SDK state machines.

Every room declares an `instanceKey` (on `RoomConfig`). Rooms with the same key share one `SanityInstance` and benefit from the SDK's shared-listener multiplexing — one upstream connection serves every doc subscription on that instance. Rooms with different keys get **completely isolated** instances: independent listener sockets, independent chain reconcilers, independent buffer state.

A chain-rot or other SDK fault on one key recreates only that key's instance. Rooms on every other key are untouched.

| `instanceKey` shape | When to use |
|---|---|
| `\`tenant:${id}\`` | Multi-tenant SaaS — one upstream connection per tenant, isolates one tenant's faults from another |
| `\`doc:${id}\`` | Heavy single-doc apps (editing one big document with many users) |
| `'global'` | Single-tenant tools, internal back-office. Cheapest in connections; no isolation. |

Cost: each unique `instanceKey` opens its own SSE listener to Sanity. At small scale this is nothing; at very high tenant count, plan for the proportional connection load.

The factory return:

```typescript
{
  async create(roomId, context) {
    return {
      instanceKey: `tenant:${(context as Ctx).tenantId}`,  // ← required
      documents: { /* … */ },
    }
  }
}
```

This is a deliberate breaking change from earlier versions that defaulted every room to a single shared instance. Defaulting silently to "share with everyone" produced cross-tenant data loss in production: one rotted doc cascaded across every active tenant on the machine. Forcing an explicit key catches the mistake at compile time.

`manager.getInstanceKeys()` returns `[{key, refCount}]` for ops visibility.

## Resilience

### Connection state

`SyncClient.status` is `'connecting' | 'connected' | 'disconnected'`. Initial state is `'connecting'` — apps can show a real reconnect affordance during first connect AND during reconnects.

```typescript
client.onStatus((status) => setReconnecting(status !== 'connected'))
```

`client.ready` rejects (instead of hanging) if the transport closes before the first hydration. Callers can `await client.ready` and surface a real error UI.

### Write outcomes: nothing fails silently

Every write through `bridge.write()` returns a `Promise<WriteOutcome>`:

```typescript
type WriteOutcome =
  | { kind: 'committed'; transactionId: string }
  | { kind: 'rejected'; transactionId: string; reason: 'server' | 'chain-rot' | 'local'; message: string }
```

The bridge awaits the SDK's `.submitted()` Promise — so server-side rejections (validation, ref integrity, revision conflict, rate limit, chain reconciler deadlock) all surface as typed outcomes rather than being swallowed by a `.catch()`.

Internally the Room awaits the outcome before sending the mutating client an `ack`. The client's optimistic UI updates instantly on `mutate()` (synchronous local state change) — but the server confirmation is held until Sanity actually committed. No more "client thinks it locked in, Sanity has nothing."

If a write rejects with `reason: 'server' | 'local'`, the Room sends `{ type: 'reject', mutationId, reason }` to the mutating client. The SyncClient runs `recomputeLocal()` and the optimistic state rolls back.

### Chain-rot self-heal

`@sanity/sdk`'s chain reconciler can enter an unresolvable buffer state and throw `DeadlineExceededError` after a 30-second deadline. Once that fires, the `SanityInstance` is poisoned for the affected doc — subsequent writes through the same instance, even on unrelated fields, fail with the same error. There is no SDK-side recovery API.

This library handles it at the application layer:

1. Bridge classifies the rejection: `/Did not resolve chain|DeadlineExceededError/` → `reason: 'chain-rot'`.
2. Bridge fires its `onChainRot` callback up to the Room, which forwards to the RoomManager.
3. `RoomManager.handleChainRot(instanceKey)` creates a fresh `SanityInstance` via `instanceFactory()`, swaps it into the pool for that key, and walks every Room currently using that key to re-create their bridges on the new instance (`Room.recreateBridges`). In-memory domain state is preserved across the swap.
4. Per-key serialization + 5s cooldown prevents re-entrant recoveries and hot-loops.

The voter's optimistic UI stays in place during the ~500ms recovery — bridges swap underneath them.

### Self-heal replay (zero-flicker recovery)

In-flight mutations whose `.submitted()` Promise rejects with chain-rot don't surface a `reject` to the client. Instead, the Room **holds them in a per-doc pending queue**, and after `recreateBridges` runs, it classifies each pending mutation against fresh server state via `DocumentMapping.classify`:

```typescript
interface DocumentMapping<TState, TSanityDoc, TSanityPatch> {
  // … fromSanity, toSanityPatch, applyMutation, resolveRefs, fromSanityWithRefs …
  classify?(
    freshState: TState,
    beforeState: TState,
    afterState: TState,
    patch: TSanityPatch,
  ): Classification
}

type Classification = 'EQUAL' | 'EQUAL_TO_AFTER' | 'DIVERGED_COMPATIBLE' | 'DIVERGED_CONFLICTING'
```

The Room routes each pending mutation based on the classification:

| Result | What the Room does |
|---|---|
| `EQUAL` (fresh matches pre-mutation state) | Replay verbatim through the new bridge |
| `DIVERGED_COMPATIBLE` (someone else wrote, but not to our target fields) | Replay verbatim |
| `EQUAL_TO_AFTER` (already at the goal — idempotent retry) | `ack` without re-issuing |
| `DIVERGED_CONFLICTING` (someone else wrote our target fields) | `reject` with `reason: 'rebase-needed'` and `freshServerState` |

If `classify` is unspecified, the Room defaults to `EQUAL` (blind replay). That's correct for single-writer docs but **unsafe for multi-writer docs** — implement `classify` whenever multiple sources can write the same doc.

### Rebase-needed: client rebases on top of fresh state

The wire-protocol reject message can carry an optional `freshServerState`:

```typescript
interface ServerRejectMsg {
  channel: string
  type: 'reject'
  mutationId: string
  reason: string
  freshServerState?: unknown  // populated when reason starts with 'rebase-needed'
}
```

When SyncClient receives a `reject` with `reason: 'rebase-needed'` and `freshServerState` set, it adopts the fresh server state and **rebases the unsent local diff on top of it** — same shape as the reconnect rebase below. The voter's optimistic UI flows forward instead of being wiped back.

### Reconnect: local edits survive

When the transport reconnects, SyncClient rebases `diff(lastSentState, localState)` on top of the freshly-hydrated `serverState`. Unsent local edits are preserved across network blips and re-flushed automatically. (Earlier versions discarded local edits on reconnect; that was the dominant source of "I tapped a star during a brief WS drop and lost it.")

### WS transport: bounded outbound queue

`WsClientTransport.send()` buffers outbound messages in a bounded queue (default cap 256) when the socket isn't `OPEN`. The queue drains on the next `onopen` event BEFORE SyncClient's own `onOpen` handlers run, so messages enqueued during reconnect are guaranteed to be sent before any fresh state arrives. When the cap is exceeded, the oldest message is dropped with a `console.warn` — visible signal rather than silent loss.

### Graceful shutdown

`gracefulShutdown` handles signal-time draining: refuse new connections, dispose every Room (which disposes every Bridge, which resolves every pending write), then exit. Hard deadline so a stuck dispose can't outrun the platform's SIGKILL grace window.

```typescript
import { gracefulShutdown } from 'sanity-rooms/server'

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void gracefulShutdown({
      manager,
      signal: sig,
      hardDeadlineMs: 25_000,  // 5s buffer below Fly's 30s SIGKILL grace
      beforeManagerDispose: () =>
        new Promise<void>((r) => server.close(() => r())),
    }).finally(() => process.exit(0))
  })
}
```

Without a drain, Node exits the moment a signal arrives, killing every in-flight `applyDocumentActions().submitted()` mid-HTTP and dropping every WebSocket connection without a `disconnect` frame. The helper is what you almost certainly want for any production deployment.

### Observability

The Bridge fires `onWriteOutcome(outcome)` for every committed or rejected write. Consumers wire this into their own metrics aggregator (per-Room or per-Manager) — the library doesn't own routing because it doesn't own HTTP endpoints.

```typescript
// In the factory's create():
return {
  instanceKey,
  documents: { /* … */ },
  onWriteOutcome: (outcome) => {
    if (outcome.kind === 'committed') metrics.committed++
    else if (outcome.reason === 'chain-rot') metrics.rejectedChainRot++
    else if (outcome.reason === 'server') metrics.rejectedServer++
    else metrics.rejectedLocal++
  },
}
```

Then expose the counters wherever your app reports metrics (HTTP scrape, Statsd, etc).

### Diagnostic stall detection (opt-in)

`SanityBridge` accepts `firstEmitTimeoutMs` (default `0`, off). When set, the bridge fires `onStall(reason)` if the SDK observable hasn't emitted a non-null doc in that window — useful for surfacing missing-doc / auth / schema issues with a clear reason.

```typescript
new SanityBridge({
  ...,
  firstEmitTimeoutMs: 10_000,
  onStall: (reason) => logger.warn(reason),
})
```

### Buffer cap

A bridge buffering pre-ready writes caps its queue at `maxPendingWrites` (default 200) — oldest dropped first since the newest replace state supersedes them. The dropped write's `WriteOutcome` resolves with `{ kind: 'rejected', reason: 'local' }` so callers awaiting it never hang.

### Test affordances

Two methods on `SanityBridge` exist solely for tests that need to deterministically exercise the chain-rot path without waiting for the SDK's 30-second deadline:

- `__testInflightWriteCount(): number` — count of currently-pending `applyDocumentActions().submitted()` Promises on this bridge.
- `__testSimulateInflightChainRot(): number` — force-resolves every in-flight write as a chain-rot rejection AND fires `onChainRot`. Mirrors what a real SDK chain reconciler stall produces, but synchronously. Returns the number of writes that were rotted.

Both should never be called from production code. The repro harness uses them to exercise the self-heal replay path against real Sanity.

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
