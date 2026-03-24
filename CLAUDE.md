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

## Testing

Tests use `vi.mock('@sanity/sdk')` with `createMockSanity()` from `src/testing/mock-sanity.ts`. The mock intercepts all SDK calls and stores docs in memory. `createMemoryTransportPair()` provides in-process transport for client↔server tests.

The mock SDK supports: `createDocument`, `editDocument`, `publishDocument`, `applyDocumentActions`, `getDocumentState`. Publish actions copy draft content to a `published:{id}` entry and strip weak ref markers.
