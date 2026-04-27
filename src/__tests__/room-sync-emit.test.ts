/**
 * The SDK's `getDocumentState(...).observable` is an rxjs subject that
 * can fire a cached value SYNCHRONOUSLY inside `subscribe()` — observed
 * under Vite SSR module loading. The default `mock-sanity.ts` uses
 * `queueMicrotask` to defer emits, so the existing test suite never
 * exercised this path. These tests use a hand-rolled mock that emits
 * synchronously to pin the contract:
 *
 *   "A bridge whose first emit fires inside its own constructor must
 *    still produce a hydrated, ref-resolved Room."
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@sanity/sdk', () => createSyncEmitSdkMock())

import type { SanityInstance } from '@sanity/sdk'
import type { DocumentMapping, RefDescriptor } from '../mapping'
import { Room } from '../server/room'

type SubFn = (doc: Record<string, unknown> | null) => void

interface FakeStore {
  docs: Map<string, Record<string, unknown> | null>
  subscribers: Map<string, Set<SubFn>>
}

const STORE_REGISTRY = new Map<unknown, FakeStore>()

/** Create the SDK mock factory. Each `createSanityInstance` call gets
 *  its own store, accessible via the returned helpers. */
function createSyncEmitSdkMock() {
  return {
    createSanityInstance: (() => {
      const inst = { __id: Math.random() } as unknown as SanityInstance
      const store: FakeStore = { docs: new Map(), subscribers: new Map() }
      STORE_REGISTRY.set(inst, store)
      return inst
    }) as unknown,
    createDocumentHandle: (h: { documentId: string; documentType: string }) => h,
    getDocumentState: (inst: unknown, handle: { documentId: string }) => {
      const store = STORE_REGISTRY.get(inst)
      if (!store) throw new Error('unknown SanityInstance')
      const docId = handle.documentId
      return {
        observable: {
          subscribe: (observer: { next: SubFn }) => {
            const next: SubFn =
              typeof observer === 'function' ? (observer as unknown as SubFn) : observer.next.bind(observer)
            let subs = store.subscribers.get(docId)
            if (!subs) {
              subs = new Set()
              store.subscribers.set(docId, subs)
            }
            subs.add(next)
            // Synchronous emit of cached value — the failure mode under
            // test. NOT queueMicrotask. NOT setTimeout.
            const cached = store.docs.get(docId)
            if (cached !== undefined) next(cached)
            return { unsubscribe: () => subs?.delete(next) }
          },
        },
      }
    },
    applyDocumentActions: async () => ({ submitted: async () => {} }),
    editDocument: () => ({ type: 'document.edit' }),
    createDocument: () => ({ type: 'document.create' }),
  }
}

function helpers(instance: SanityInstance) {
  const store = STORE_REGISTRY.get(instance)
  if (!store) throw new Error('unknown instance')
  return {
    setDoc(docId: string, doc: Record<string, unknown>) {
      store.docs.set(docId, doc)
      const subs = store.subscribers.get(docId)
      if (subs) for (const s of subs) s(doc)
    },
    setMissing(docId: string) {
      store.docs.set(docId, null)
    },
  }
}

const noopMutate = () => null

const plainMapping: DocumentMapping<{ value: number }> = {
  documentType: 'plain',
  fromSanity: (d) => ({ value: Number(d.value ?? 0) }),
  toSanityPatch: (s) => ({ patch: { value: s.value } }),
  applyMutation: noopMutate,
}

describe('Room — synchronous SDK emit during subscribe()', () => {
  it('hydrates the main doc when the SDK emits cached state synchronously', async () => {
    const sdk = (await import('@sanity/sdk')) as unknown as {
      createSanityInstance: () => SanityInstance
    }
    const instance = sdk.createSanityInstance()
    helpers(instance).setDoc('main-1', { _id: 'main-1', value: 7 })

    const room = new Room(
      { documents: { main: { docId: 'main-1', mapping: plainMapping } }, gracePeriodMs: 50 },
      instance,
      { projectId: 'p', dataset: 'd' },
    )

    await room.ready
    expect(room.getDocState('main')).toEqual({ value: 7 })
    await room.dispose()
  })

  it('hydrates ref bridges when both main and ref docs emit synchronously', async () => {
    const sdk = (await import('@sanity/sdk')) as unknown as {
      createSanityInstance: () => SanityInstance
    }
    const instance = sdk.createSanityInstance()
    const h = helpers(instance)
    h.setDoc('parent-1', {
      _id: 'parent-1',
      value: 1,
      refs: [{ _ref: 'child-a', _key: 'k1' }],
    })
    h.setDoc('child-a', { _id: 'child-a', name: 'aurora' })

    const refMapping: DocumentMapping<unknown> = {
      documentType: 'child',
      fromSanity: (d) => d,
      toSanityPatch: (s) => ({ patch: s as Record<string, unknown> }),
      applyMutation: noopMutate,
    }
    const parentMapping: DocumentMapping<{ value: number; refs: unknown[] }> = {
      documentType: 'parent',
      fromSanity: (d) => ({ value: Number(d.value ?? 0), refs: [] }),
      fromSanityWithRefs: (d, refDocs) => ({
        value: Number(d.value ?? 0),
        refs: [...refDocs.values()],
      }),
      toSanityPatch: (s) => ({ patch: { value: s.value } }),
      applyMutation: noopMutate,
      resolveRefs: (d) => {
        const out: RefDescriptor[] = []
        for (const r of (d.refs as Array<{ _ref?: string; _key?: string }>) ?? []) {
          if (r._ref && r._key) out.push({ key: r._key, docId: r._ref, mapping: refMapping })
        }
        return out
      },
    }

    const room = new Room(
      { documents: { main: { docId: 'parent-1', mapping: parentMapping } }, gracePeriodMs: 50 },
      instance,
      { projectId: 'p', dataset: 'd' },
    )

    await room.ready
    const state = room.getDocState<{ value: number; refs: unknown[] }>('main')
    expect(state.value).toBe(1)
    expect(state.refs).toHaveLength(1)
    await room.dispose()
  })

  it('does not crash when sync-emitting bridge fires before docs.set runs', async () => {
    // Regression: pre-fix, the bridge's onChange ran inside the
    // SanityBridge constructor, before Room.createDoc could register
    // the docs entry. handleSanityChange found nothing and returned
    // silently — refs never spawned, room never resolved. With the
    // queueMicrotask deferral, this resolves in <50ms.
    const sdk = (await import('@sanity/sdk')) as unknown as {
      createSanityInstance: () => SanityInstance
    }
    const instance = sdk.createSanityInstance()
    helpers(instance).setDoc('p2', { _id: 'p2', value: 99 })
    const room = new Room(
      { documents: { main: { docId: 'p2', mapping: plainMapping } }, gracePeriodMs: 50 },
      instance,
      { projectId: 'p', dataset: 'd' },
    )
    const settled = await Promise.race([
      room.ready.then(() => 'resolved' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 100)),
    ])
    expect(settled).toBe('resolved')
    expect(room.getDocState('main')).toEqual({ value: 99 })
    await room.dispose()
  })
})
