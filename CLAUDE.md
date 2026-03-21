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
- `@sanity/sdk` — document state, editDocument, applyDocumentActions
- `@sanity/diff-patch` — `diffValue(before, after)` produces `SanityPatchOperations[]`
- `@sanity/mutator` — `Mutation.apply(doc)` applies Sanity patches to plain JS objects

## Testing

Tests use `vi.mock('@sanity/sdk')` with `createMockSanity()` from `src/testing/mock-sanity.ts`. The mock intercepts all SDK calls and stores docs in memory. `createMemoryTransportPair()` provides in-process transport for client↔server tests.
