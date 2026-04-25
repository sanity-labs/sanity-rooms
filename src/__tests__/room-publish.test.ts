/**
 * Room.publish() tests — verifies publishing main docs and ref docs
 * through the SDK's publishDocument + applyDocumentActions.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', async () => {
  const { createSdkMocks } = await import('../testing/mock-sanity')
  return createSdkMocks()
})

import type { DocumentMapping, RefDescriptor, SanityPatchResult } from '../mapping'
import { Room } from '../server/room'
import { createMemoryTransportPair, flushMicrotasks } from '../testing/memory-transport'
import { createMockSanity } from '../testing/mock-sanity'

// ── Simple mapping (no refs) ─────────────────────────────────────────────

const simpleMapping: DocumentMapping<{ value: number }> = {
  documentType: 'test',
  fromSanity(doc) {
    return { value: Number(doc.value ?? 0) }
  },
  toSanityPatch(state) {
    return { patch: { value: state.value } }
  },
  applyMutation(_state, mutation) {
    if (mutation.kind === 'replace') return mutation.state as { value: number }
    return null
  },
}

// ── Mapping with refs ────────────────────────────────────────────────────

interface RefState {
  value: number
  items?: Array<{ name: string; data: string }>
}

const itemMapping: DocumentMapping<Record<string, unknown>> = {
  documentType: 'item',
  fromSanity(doc) {
    return doc
  },
  toSanityPatch(state) {
    return { patch: state }
  },
  applyMutation() {
    return null
  },
}

const refMapping: DocumentMapping<RefState> = {
  documentType: 'test',
  fromSanity(doc) {
    return { value: Number(doc.value ?? 0), items: (doc.items ?? []) as any[] }
  },
  fromSanityWithRefs(doc, refDocs) {
    const items = ((doc.items ?? []) as Array<{ _ref: string }>).map((ref) => {
      const refDoc = refDocs.get(`item-${ref._ref}`)
      return refDoc ? { name: String(refDoc.name), data: String(refDoc.data) } : { name: ref._ref, data: '' }
    })
    return { value: Number(doc.value ?? 0), items }
  },
  toSanityPatch(state): SanityPatchResult {
    const refs = (state.items ?? []).map((item, i) => ({
      _ref: `item-${item.name}`,
      _key: `k${i}`,
      _type: 'reference',
      _weak: true,
      _strengthenOnPublish: { type: 'item', weak: false },
    }))
    const refPatches: Record<string, Record<string, unknown>> = {}
    for (const item of state.items ?? []) {
      refPatches[`item-item-${item.name}`] = { name: item.name, data: item.data }
    }
    return {
      patch: { value: state.value, items: refs.length ? refs : undefined },
      ...(Object.keys(refPatches).length > 0 && { refPatches }),
    }
  },
  applyMutation(_state, mutation) {
    return mutation.kind === 'replace' ? (mutation.state as RefState) : null
  },
  resolveRefs(doc) {
    const refs: RefDescriptor[] = []
    for (const item of (doc.items ?? []) as Array<{ _ref: string }>) {
      if (item._ref) {
        refs.push({ key: `item-${item._ref}`, docId: item._ref, mapping: itemMapping })
      }
    }
    return refs
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function makeRoom(mapping: DocumentMapping<any>, initialDoc: Record<string, unknown>) {
  // Seed with `_id: 'drafts.doc-1'` so the bridge sees a pending draft —
  // matches real SDK behavior where editDocument creates drafts.X. Tests that
  // want to simulate "already-published, no draft" should override _id explicitly.
  const mock = createMockSanity({ 'doc-1': { _id: 'drafts.doc-1', ...initialDoc } })
  const room = new Room(
    { documents: { config: { docId: 'doc-1', mapping } }, gracePeriodMs: 100 },
    mock.instance,
    mock.resource,
  )
  await room.ready
  return { room, mock }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Room.publish', () => {
  it('publishes a simple document successfully', async () => {
    const { room, mock } = await makeRoom(simpleMapping, { value: 42 })

    const result = await room.publish('config')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()

    // Published entry should exist in mock
    const published = mock.getDoc('published:doc-1')
    expect(published).toBeDefined()
    expect(published?.value).toBe(42)

    await room.dispose()
  })

  it('returns error for unknown doc key', async () => {
    const { room } = await makeRoom(simpleMapping, { value: 1 })

    const result = await room.publish('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown document key')

    await room.dispose()
  })

  it('publishes ref docs before main doc', async () => {
    const mock = createMockSanity({
      'doc-1': {
        _id: 'drafts.doc-1',
        value: 10,
        items: [{ _ref: 'item-alpha', _key: 'k0', _type: 'reference', _weak: true }],
      },
      'item-alpha': { _id: 'drafts.item-alpha', _type: 'item', name: 'alpha', data: 'hello' },
    })

    const room = new Room(
      { documents: { config: { docId: 'doc-1', mapping: refMapping } }, gracePeriodMs: 100 },
      mock.instance,
      mock.resource,
    )
    await room.ready
    await flushMicrotasks()
    await flushMicrotasks()

    const result = await room.publish('config')
    expect(result.success).toBe(true)

    // Both ref and main should be published
    const publishedRef = mock.getDoc('published:item-alpha')
    expect(publishedRef).toBeDefined()
    expect(publishedRef?.name).toBe('alpha')

    const publishedMain = mock.getDoc('published:doc-1')
    expect(publishedMain).toBeDefined()
    expect(publishedMain?.value).toBe(10)

    await room.dispose()
  })

  it('strips weak ref markers on publish', async () => {
    const mock = createMockSanity({
      'doc-1': {
        _id: 'drafts.doc-1',
        value: 1,
        items: [
          {
            _ref: 'item-x',
            _key: 'k0',
            _type: 'reference',
            _weak: true,
            _strengthenOnPublish: { type: 'item', weak: false },
          },
        ],
      },
    })

    const room = new Room(
      { documents: { config: { docId: 'doc-1', mapping: simpleMapping } }, gracePeriodMs: 100 },
      mock.instance,
      mock.resource,
    )
    await room.ready

    await room.publish('config')

    const published = mock.getDoc('published:doc-1')
    expect(published).toBeDefined()
    const ref = (published?.items as any)?.[0]
    expect(ref?._weak).toBeUndefined()
    expect(ref?._strengthenOnPublish).toBeUndefined()

    await room.dispose()
  })

  // Regression: real SDK's publishDocument throws "no draft version was found"
  // for docs that have only a published version (no pending changes). Before
  // the hasDraft() guard, Room.publish would blindly add publish actions for
  // every ref bridge, causing the whole transaction to abort and the main
  // doc's publish to fail too. Production users hit this when a message
  // referenced custom backgrounds that were already published with no edits.
  describe('no-draft handling', () => {
    it('skips ref docs that have no draft', async () => {
      const mock = createMockSanity({
        'doc-1': {
          _id: 'drafts.doc-1',
          value: 10,
          items: [{ _ref: 'item-alpha', _key: 'k0', _type: 'reference', _weak: true }],
        },
        // Ref doc has only the published version — no `drafts.` prefix
        'item-alpha': { _id: 'item-alpha', _type: 'item', name: 'alpha', data: 'hello' },
      })

      const room = new Room(
        { documents: { config: { docId: 'doc-1', mapping: refMapping } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      await room.ready
      await flushMicrotasks()
      await flushMicrotasks()

      // Without the hasDraft() guard, this would throw because the SDK rejects
      // publishing a doc that has no draft.
      const result = await room.publish('config')
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()

      // Main doc was published (it had a draft)
      expect(mock.getDoc('published:doc-1')).toBeDefined()

      await room.dispose()
    })

    it('skips main doc that has no draft (idempotent re-publish)', async () => {
      const mock = createMockSanity({
        // No draft for main doc — represents "already-published, nothing to do"
        'doc-1': { _id: 'doc-1', value: 5 },
      })

      const room = new Room(
        { documents: { config: { docId: 'doc-1', mapping: simpleMapping } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      await room.ready

      const result = await room.publish('config')
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()

      await room.dispose()
    })

    it('publishes nothing → success (all docs already at parity)', async () => {
      const mock = createMockSanity({
        'doc-1': {
          _id: 'doc-1',
          value: 10,
          items: [{ _ref: 'item-alpha', _key: 'k0', _type: 'reference', _weak: true }],
        },
        'item-alpha': { _id: 'item-alpha', _type: 'item', name: 'alpha', data: 'hello' },
      })

      const room = new Room(
        { documents: { config: { docId: 'doc-1', mapping: refMapping } }, gracePeriodMs: 100 },
        mock.instance,
        mock.resource,
      )
      await room.ready
      await flushMicrotasks()
      await flushMicrotasks()

      const result = await room.publish('config')
      expect(result.success).toBe(true)

      // Nothing was published because nothing had a draft
      expect(mock.getDoc('published:doc-1')).toBeUndefined()
      expect(mock.getDoc('published:item-alpha')).toBeUndefined()

      await room.dispose()
    })
  })

  it('onMutation fires on mutateDoc', async () => {
    const { room } = await makeRoom(simpleMapping, { value: 0 })
    const cb = vi.fn()
    room.onMutation(cb)

    room.mutateDoc('config', { kind: 'replace', state: { value: 5 } })
    expect(cb).toHaveBeenCalledWith('config')

    await room.dispose()
  })

  it('onMutation fires on client mutation', async () => {
    const { room } = await makeRoom(simpleMapping, { value: 0 })
    const cb = vi.fn()
    room.onMutation(cb)

    const pair = createMemoryTransportPair()
    room.addClient(pair.server)
    await flushMicrotasks()

    pair.client.send({
      channel: 'doc:config',
      type: 'mutate',
      mutationId: 'test-mut',
      mutation: { kind: 'replace', state: { value: 99 } },
    })
    await flushMicrotasks()

    expect(cb).toHaveBeenCalledWith('config')

    await room.dispose()
  })
})
