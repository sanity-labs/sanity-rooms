# Sanity SDK Learnings

Hard-won lessons from integrating `@sanity/sdk` (v2.8.0) into a server-side multi-client document sync system. These are things not covered in the docs that took significant debugging to discover.

## SDK internals

### The observable emits `local`, not `remote`

`getDocumentState(instance, handle).observable` emits the SDK's `local` state — which includes optimistic edits that haven't been confirmed by the server yet. There's no public API to subscribe to only remote/confirmed changes.

Internally the SDK tracks `remote` (server-confirmed) and `local` (with pending optimistic patches). The observable emits `local`. When you call `editDocument` + `applyDocumentActions`, the SDK updates `local` immediately and emits — so you see your own writes reflected before the server confirms.

### `applyDocumentActions` resolves on local apply, not server confirmation

The promise from `applyDocumentActions` resolves as soon as the actions are applied to the local state. To know when the server has confirmed, call `result.submitted()` which returns another promise.

```typescript
const result = await applyDocumentActions(instance, { actions: [...] })
// ^ local state updated, observable emitted

await result.submitted()
// ^ server confirmed (or rejected — this throws)
```

### Transaction IDs become `_rev`

When you pass a `transactionId` to `applyDocumentActions`, the SDK sets `_rev` on the local doc to that transaction ID. This is how you can identify your own write echoes — compare the emitted doc's `_rev` against your known transaction IDs.

```typescript
const txnId = crypto.randomUUID()
applyDocumentActions(instance, { actions, transactionId: txnId })
// The next observable emit will have doc._rev === txnId
```

### The SDK writes to drafts, not published docs

`editDocument` always targets the draft version (`drafts.{id}`). Even with `liveEdit: true` on the handle, the internal `processActions` pipeline uses `getDraftId()`. The published document is only updated when you call `publishDocument`.

### Don't pass `drafts.` prefix to the SDK

The SDK calls `getDraftId(documentId)` internally which adds `drafts.`. If you pass `drafts.my-doc`, it becomes `drafts.drafts.my-doc` — a phantom document that never matches anything. Always strip the prefix before giving an ID to `createDocumentHandle`.

### Grants must load before writes work

The SDK's internal reducer (`applyFirstQueuedTransaction`) checks `if (!prev.grants) return prev` — if ACL grants haven't loaded from the server yet, queued transactions are silently deferred. They pile up in the queue, and if the state changes before grants arrive, they may be applied against stale state and silently reverted.

The fix: wait for the document state to be non-undefined/non-null before writing. The `getDocumentState` observable emits `null` initially, then the real doc once grants + fetch complete.

### `getDocumentState` subscription creates entries that block `createDocument`

When you subscribe to a doc via `getDocumentState`, the SDK creates an entry in its internal `documentStates` map — even if the doc doesn't exist on the server. Later, `createDocument` checks `if (working[draftId])` and throws "A draft version of this document already exists" because the subscription created a truthy entry.

**Don't subscribe to a document before creating it.** Create first, then subscribe.

### `editDocument` vs `createDocument`

- `createDocument` throws if a draft already exists (`"A draft version already exists"`)
- `editDocument` **requires the doc to exist** in draft or published form — it throws `"Cannot edit document because it does not exist in draft or published form"` otherwise. It is NOT an upsert.
- `createDocument` + `editDocument` in the same `applyDocumentActions` batch WORKS — the create runs first, then the edit sees the newly created draft.

**For ref docs that may or may not exist:** batch `createDocument(handle)` before `editDocument(handle, { set: ... })`. If the doc already exists, skip the `createDocument`. The bridge must track which ref docs have been created to choose the right action.

## Server-side reference integrity

### Sanity enforces referential integrity on the server

If you write a document with `{ customBackgrounds: [{ _ref: "bg-123" }] }` and `bg-123` doesn't exist as a published document, the server returns a 409 Conflict: `"references non-existent document"`. This applies even if `bg-123` exists as a DRAFT — strong references must point to published docs.

### Weak references with `_strengthenOnPublish` solve the draft problem

This is how Sanity Studio handles references to drafts:

```javascript
{
  _type: 'reference',
  _ref: 'my-doc-id',
  _weak: true,
  _strengthenOnPublish: {
    type: 'customBackground',
    weak: false,
  },
}
```

Weak refs skip the referential integrity check. When the referencing document is published, the SDK automatically removes `_weak` and `_strengthenOnPublish`, making it a strong reference.

### Batch order matters but doesn't guarantee atomicity for refs

Even when you batch `createDocument(refDoc) + editDocument(mainDoc)` in one `applyDocumentActions` call, the server may process the edit before the create — causing a referential integrity failure. Use weak refs instead of trying to order the batch.

## Observable behavior

### Single emit per write (not multiple)

Despite having an internal pipeline with stages (queued → applied → outgoing → verified), `getDocumentState().observable` emits **once** per write with `_rev = transactionId`. The observable uses `distinctUntilChanged` internally and only emits when the `local` document actually changes.

### The 1-second throttle is not configurable

The SDK has a hardcoded `INITIAL_OUTGOING_THROTTLE_TIME = 1000` ms. Writes are batched and sent to the server at most once per second. You cannot change this.

### `subscribeDocumentEvents` requires the document store to be initialized

If you subscribe to events for a document that hasn't been loaded via `getDocumentState`, the events subject may not exist. Always ensure the document is subscribed before listening for events.

## Architecture lessons

### Keep the SDK layer raw

Don't mix domain mapping with SDK subscriptions. The bridge should store and emit raw Sanity documents. The Room (or your app layer) handles all domain mapping. If you map inside the bridge, own-write echoes produce different objects than what you stored (because the round-trip through `toSanity → SDK → fromSanity` isn't referentially identical), and your echo suppression breaks.

### Own-write echo suppression via transaction IDs

Generate a `transactionId` BEFORE calling `applyDocumentActions` (not from the result — the result arrives after the synchronous echo). Add it to a `Set<string>`. When the observable emits, check `doc._rev` against the set. If it matches, skip — it's your own write.

```typescript
const txnId = crypto.randomUUID()
doc.ownTxns.add(txnId)
applyDocumentActions(instance, { actions, transactionId: txnId })
```

Don't delete from `ownTxns` on first match — the SDK may emit the same `_rev` multiple times during internal state transitions.

### `immutableReconcile` for deduplication

Use deep structural comparison (like `immutableReconcile`) to suppress redundant broadcasts. When an external edit arrives that doesn't change the domain state (e.g., only `_rev` changed), reconcile returns the same object reference → skip the broadcast. This prevents unnecessary WS messages to clients.

### Wait for refs before serving clients

If your document has references to other documents, the Room's `ready` promise should not resolve until both the main doc AND all ref bridges have emitted. Otherwise the first client gets an incomplete state (refs unresolved).

## Companion packages

### `@sanity/diff-patch` — diffing two document states

`diffValue(before, after)` produces `SanityPatchOperations[]` — the native format `editDocument` accepts. Handles:
- Object diffs: recurses per-key, only patches changed keys, handles deletions via `unset`
- Array diffs by `_key`: items with `_key` are diffed by key (not index), so edits to different items produce independent patches
- String diffs: uses `diffMatchPatch` for text-level diffs (efficient for keystroke edits)
- Reference equality fast-path: `source === target` → skip (zero cost for unchanged subtrees)

Use this for computing minimal patches on the client before sending over the wire.

### `@sanity/mutator` — applying patches to plain JS objects

`Mutation.apply(doc)` applies Sanity-format patches (set, unset, diffMatchPatch, insert) to a document, including `_key`-based array paths like `frames[_key=="f1"].text`.

To apply `SanityPatchOperations[]` from `diffValue`:
```typescript
import { Mutation } from '@sanity/mutator'
const mutations = operations.map(op => ({ patch: { id: doc._id, ...op } }))
const result = new Mutation({ mutations }).apply(doc)
```

**Important:** `Mutation.apply` requires `_id` and `_type` on the document, and the patch `id` must match `_id`. For domain objects without Sanity metadata, inject sentinel values and strip them after.

**Important:** `Mutation.apply` adds `_rev` and `_updatedAt` to the result. Strip these if the original document didn't have them.

## Missing from the SDK (as of v2.8.0)

- No public API to distinguish local vs remote state changes
- No configurable write throttle
- No server-side usage documentation
- No way to subscribe to only the `remote` document state
- `subscribeDocumentEvents` is underdocumented and doesn't fire in all cases
- `perspective: 'drafts'` vs `perspective: 'previewDrafts'` naming inconsistency (the latter is deprecated but still used in older code)
