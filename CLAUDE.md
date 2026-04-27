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
5. **`RoomManager.dispose()`** disposes the SDK if (and only if) the manager was constructed with `instanceFactory`.

## Testing

Tests use `vi.mock('@sanity/sdk')` with `createMockSanity()` from `src/testing/mock-sanity.ts`. The mock intercepts all SDK calls and stores docs in memory. `createMemoryTransportPair()` provides in-process transport for client↔server tests.

The mock SDK supports: `createDocument`, `editDocument`, `publishDocument`, `applyDocumentActions`, `getDocumentState`. Publish actions copy draft content to a `published:{id}` entry and strip weak ref markers.

For resilience tests, `mock.setSilent(docId)` makes `getDocumentState(...).observable` never emit for that doc — exercises `SanityBridge.firstEmitTimeoutMs` / `onStall` paths.

The default mock emits asynchronously (via `queueMicrotask`) so the race between bridge-construct and `this.docs.set` doesn't manifest. `room-sync-emit.test.ts` uses a separate, hand-rolled mock that emits **synchronously** inside `subscribe()` to pin the microtask-hop fix in `Room`. Don't replace that with `mock-sanity.ts` — the bug only reproduces under sync emit.
