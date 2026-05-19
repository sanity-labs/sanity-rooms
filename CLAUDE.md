# sanity-rooms — CLAUDE.md

## Git subtree

This package is a **git subtree** embedded in the morphing-clock monorepo. It has its own upstream repo:

```
Remote: git@github.com:sanity-labs/sanity-rooms.git
Prefix: packages/sanity-rooms
```

After committing changes in the monorepo, push the subtree:

```bash
git remote add sanity-rooms git@github.com:sanity-labs/sanity-rooms.git  # once
git subtree push --prefix=packages/sanity-rooms sanity-rooms main
```

### Lock file sync

The upstream CI uses `--frozen-lockfile`, so the subtree's own `pnpm-lock.yaml` must stay current. From within the monorepo:

```bash
pnpm sync:subtree-lock   # regenerate packages/sanity-rooms/pnpm-lock.yaml
```

This runs automatically via pre-commit hook when `packages/sanity-rooms/package.json` is staged. To run manually: `cd packages/sanity-rooms && pnpm install --ignore-workspace --lockfile-only`.

## Commands

```bash
npx vitest run packages/sanity-rooms/          # run all tests
npx tsc --noEmit -p packages/sanity-rooms/tsconfig.json  # typecheck
```

## Architecture

Two layers:
- **SanityBridge** (server) — raw Sanity doc store via `@sanity/sdk`. Subscribe + write. No domain knowledge.
- **Room** (server) — domain state hub. Mapping, ref assembly, broadcast, app channels.
- **SyncClient** (client) — optimistic local state, diff-at-flush via `@sanity/diff-patch`, patches applied via `@sanity/mutator`.

Key deps:
- `@sanity/sdk` — document state, editDocument, publishDocument, applyDocumentActions
- `@sanity/diff-patch` — `diffValue(before, after)` produces `SanityPatchOperations[]`
- `@sanity/mutator` — `Mutation.apply(doc)` applies Sanity patches to plain JS objects

## Publishing

`Room.publish(docKey)` publishes the main doc + all its ref docs via SDK's `publishDocument`. Ref docs are published first so weak refs can strengthen.

- All editing writes to **drafts** (SDK behavior — `editDocument` always targets `drafts.{id}`)
- Publishing copies draft → published. Weak refs (`_weak: true` + `_strengthenOnPublish`) become strong refs.
- `Room.onMutation(cb)` fires after any mutation — use for dirty-tracking (has draft diverged from published?)
- Publish is exposed as a method on Room, NOT a protocol message. App code decides how to trigger it (app channel, REST endpoint, etc.)

## Document references

Ref docs (custom fonts, palettes, backgrounds) are separate Sanity documents referenced by the main doc:

1. `resolveRefs(rawDoc)` → returns `RefDescriptor[]` (docId + mapping per ref)
2. Room creates a SanityBridge per ref doc (auto-subscribes via SDK shared listener)
3. `fromSanityWithRefs(rawDoc, refDocs)` assembles domain state with dereferenced content
4. `toSanityPatch(state)` returns `{ patch, refPatches }` — both written atomically
5. Refs use `_weak: true` + `_strengthenOnPublish` so drafts can reference other drafts
6. On `publish()`, ref docs are published before the main doc (required for ref strengthening)

## Invariants — do not quietly remove

1. **`Room.createDoc` and `Room.updateRefs` defer their `onChange` body via `queueMicrotask`**. The SDK's rxjs Subject can fire a cached value synchronously inside `subscribe()` (this happens under Vite SSR module loading), before `this.docs.set` registers the entry. The microtask hop pushes `handleSanityChange` past that race so the entry exists when looked up. Pinned by `room-sync-emit.test.ts`.
2. **`SyncClient.status`** is `'connecting' | 'connected' | 'disconnected'`. Initial = `'connecting'`. `client.ready` rejects on transport-close-before-hydration so callers don't await forever.
3. **`Transport.onOpen?`** is optional — when present, SyncClient flips to `'connecting'` on every reconnect dial. Without it, "first state msg = connected".
4. **`SanityBridge.firstEmitTimeoutMs`** opt-in (default 0 = off). When set, fires `onStall(reason)` if the SDK observable doesn't first-emit in that window — diagnostic only.
5. **`RoomConfig.instanceKey` is REQUIRED.** Per-key SanityInstance pooling: rooms with the same key share an instance, different keys are fully isolated. No default. Forgetting it is a TS error at the factory call site and a runtime throw in `createRoom` if you bypass TS. This is the breaking change that closed the 2026-05-16 cross-tenant data-loss surface — don't soften it back to a default.
6. **`RoomManagerOptions.instanceFactory` is REQUIRED.** Pre-fix there was an `instance:` literal option too; it's gone because per-key pooling needs to mint fresh instances on demand for new keys + on chain-rot recovery. `manager.dispose()` walks every key's instance.
7. **Chain-rot recovery is per-instanceKey, not global.** `RoomManager.handleChainRot(key)` only recreates that key's instance and only walks rooms with that key. Pinned by scenario O (real Sanity, two groups) + the `cross-key-isolation-unit` test in `room-manager.test.ts`. If a future refactor walks `this.rooms` unconditionally during recovery, that regresses the isolation property.
8. **`Bridge.write()` returns `Promise<WriteOutcome>` and awaits `.submitted()`.** The discriminated union (`committed` / `rejected:server` / `rejected:chain-rot` / `rejected:local`) is the contract that surfaces server rejections that pre-fix were swallowed by a bare `.catch()`. Don't reintroduce a `void` return or a non-awaited submission.
9. **Room defers `ack` to the mutating client until `bridge.write` commits.** Optimistic broadcast to *other* clients still fires synchronously (so spectator UIs feel instant). Client-side optimistic `localState` on `mutate()` is also unchanged. The single thing that's deferred is the server-to-mutator `ack` confirmation.
10. **Pending-mutation queue is the source of truth for replay.** Room tracks `pendingMutations: Map<mutationId, {beforeState, afterState, patch, refDocs, clientId, channel, transactionId}>` per doc. Chain-rot rejections HOLD entries (no `reject` to client). `recreateBridges` classifies via `DocumentMapping.classify` and replays / acks-idempotent / sends `rebase-needed`. If `classify` is unspecified, default is `EQUAL` (blind replay) — correct for single-writer docs only.
11. **`'rebase-needed'` reject reason carries `freshServerState`** on the wire (`ServerRejectMsg.freshServerState?: unknown`). SyncClient adopts the fresh state and rebases `diff(lastSentState, localState)` on top — same shape as the reconnect rebase. Voter's UI does not snap back.
12. **WS reconnect rebases, never wipes.** Earlier versions discarded local edits on reconnect; that path was the dominant silent-loss vector during network blips. Both `WsClientTransport`'s outbound queue (cap 256, drop-oldest with `console.warn`) and SyncClient's reconnect path (rebase local diff on fresh serverState) preserve unsent intent. Don't reintroduce the wipe.
13. **`gracefulShutdown(opts)` exists in `sanity-rooms/server`.** Consumers wire it to their SIGTERM/SIGINT handlers + `server.close()` via `beforeManagerDispose`. Hard deadline default 25s (Fly SIGKILL grace is 30s). Idempotent: a second call while the first is in flight returns the same in-flight Promise.
14. **`__testInflightWriteCount()` + `__testSimulateInflightChainRot()` on `SanityBridge` are test-only.** Production code never reaches them (they need a Bridge reference held only by the Room which is held only by the RoomManager — no HTTP/WS exposure). They synthesize chain-rot deterministically for scenarios N and O in the disaster harness. Don't remove them; don't call them from prod.

## Testing

Tests use `vi.mock('@sanity/sdk')` with `createMockSanity()` from `src/testing/mock-sanity.ts`. The mock intercepts all SDK calls and stores docs in memory. `createMemoryTransportPair()` provides in-process transport for client↔server tests.

The mock SDK supports: `createDocument`, `editDocument`, `publishDocument`, `applyDocumentActions`, `getDocumentState`. Publish actions copy draft content to a `published:{id}` entry and strip weak ref markers.

For resilience tests, `mock.setSilent(docId)` makes `getDocumentState(...).observable` never emit for that doc — exercises `SanityBridge.firstEmitTimeoutMs` / `onStall` paths.

The default mock emits asynchronously (via `queueMicrotask`) so the race between bridge-construct and `this.docs.set` doesn't manifest. `room-sync-emit.test.ts` uses a separate, hand-rolled mock that emits **synchronously** inside `subscribe()` to pin the microtask-hop fix in `Room`. Don't replace that with `mock-sanity.ts` — the bug only reproduces under sync emit.
