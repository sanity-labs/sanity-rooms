/**
 * MockSanity — in-memory mock for testing without a real Sanity project.
 *
 * Creates a mock SanityInstance and intercepts @sanity/sdk calls.
 * Documents stored in a plain Map. External edits trigger subscriber callbacks.
 */

import type { SanityInstance } from '@sanity/sdk'

/** Recursively strip _weak and _strengthenOnPublish from references. */
function stripWeakRefs(obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (key === '_weak' || key === '_strengthenOnPublish') {
      delete obj[key]
    } else if (obj[key] && typeof obj[key] === 'object') {
      stripWeakRefs(obj[key] as Record<string, unknown>)
    }
  }
}

interface DocEntry {
  doc: Record<string, unknown>
  subscribers: Set<(doc: Record<string, unknown> | null) => void>
}

export interface MockSanityInstance {
  instance: SanityInstance
  /** Simulate an external edit (as if another user edited in Sanity Studio). */
  simulateExternalEdit(docId: string, doc: Record<string, unknown>): void
  /** Get current document state. */
  getDoc(docId: string): Record<string, unknown> | undefined
  /** Get all patches applied to a document (for assertions). */
  getPatches(docId: string): Array<Record<string, unknown>>
  /** Resource config for Room/RoomManager. */
  resource: { projectId: string; dataset: string }
}

/**
 * Create a mock Sanity environment for testing.
 *
 * IMPORTANT: Tests using this must call `vi.mock('@sanity/sdk')` and wire
 * the mock functions before importing the modules under test. See the
 * test files for the pattern.
 */
export function createMockSanity(initialDocs?: Record<string, Record<string, unknown>>): MockSanityInstance {
  const docs = new Map<string, DocEntry>()
  const patchLog = new Map<string, Array<Record<string, unknown>>>()

  if (initialDocs) {
    for (const [id, doc] of Object.entries(initialDocs)) {
      docs.set(id, { doc: { _id: id, ...doc }, subscribers: new Set() })
    }
  }

  function getOrCreateEntry(docId: string): DocEntry {
    let entry = docs.get(docId)
    if (!entry) {
      entry = { doc: {}, subscribers: new Set() }
      docs.set(docId, entry)
    }
    return entry
  }

  // Mock SanityInstance — just needs an instanceId and config
  const instance = {
    instanceId: 'mock-instance',
    config: { projectId: 'test-project', dataset: 'test-dataset' },
    isDisposed: () => false,
    dispose: () => {},
    onDispose: () => () => {},
    getParent: () => undefined,
    createChild: () => instance,
    match: () => instance,

    // Internal: used by our mock SDK functions
    _docs: docs,
    _patchLog: patchLog,
    _getOrCreateEntry: getOrCreateEntry,
  } as unknown as SanityInstance

  return {
    instance,
    resource: { projectId: 'test-project', dataset: 'test-dataset' },

    simulateExternalEdit(docId, doc) {
      const entry = getOrCreateEntry(docId)
      entry.doc = { ...doc }
      for (const subscriber of entry.subscribers) {
        subscriber(entry.doc)
      }
    },

    getDoc(docId) {
      return docs.get(docId)?.doc
    },

    getPatches(docId) {
      return patchLog.get(docId) ?? []
    },
  }
}

/**
 * Setup SDK mocks for vitest. Call this in a vi.mock('@sanity/sdk', ...) factory.
 * Returns mock implementations that use the MockSanity's document store.
 */
export function createSdkMocks(_defaultMock?: MockSanityInstance) {
  return {
    createSanityInstance: () => _defaultMock?.instance,
    createDocumentHandle: (h: any) => h,
    createDocumentTypeHandle: (h: any) => h,

    getDocumentState: (inst: any, handle: any) => {
      const docId = handle.documentId
      const entry = inst._getOrCreateEntry(docId)
      return {
        observable: {
          // Accept either a plain `next` callback OR a full Observer
          // ({next, error, complete}) — matches real RxJS observables.
          // Production code uses the Observer form so the SanityBridge
          // can surface SDK errors instead of swallowing them.
          subscribe: (callbackOrObserver: any) => {
            const next: (doc: any) => void =
              typeof callbackOrObserver === 'function' ? callbackOrObserver : callbackOrObserver?.next?.bind(callbackOrObserver)
            if (typeof next !== 'function') {
              throw new TypeError('subscribe requires a `next` callback or an Observer with a `next` method')
            }
            entry.subscribers.add(next)
            // Emit current state immediately (async like real SDK)
            queueMicrotask(() => {
              if (entry.subscribers.has(next)) {
                next(entry.doc)
              }
            })
            return {
              unsubscribe: () => entry.subscribers.delete(next),
            }
          },
        },
        getCurrent: () => entry.doc,
        subscribe: (cb: () => void) => {
          entry.subscribers.add(() => cb())
          return () => entry.subscribers.delete(() => cb())
        },
      }
    },

    editDocument: (handle: any, patches: any) => ({
      type: 'document.edit',
      documentId: handle.documentId,
      documentType: handle.documentType,
      patches: [patches],
    }),

    createDocument: (handle: any, content: any) => ({
      type: 'document.create',
      documentId: handle.documentId,
      documentType: handle.documentType,
      initialValue: content,
    }),

    publishDocument: (handle: any) => ({
      type: 'document.publish',
      documentId: handle.documentId,
      documentType: handle.documentType,
    }),

    applyDocumentActions: async (inst: any, options: any) => {
      const transactionId: string =
        options.transactionId ?? `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Track which docs are created in this batch (for create-then-edit in same batch)
      const createdInBatch = new Set<string>()

      for (const action of options.actions ?? []) {
        const docId = action.documentId
        const entry = inst._getOrCreateEntry(docId)

        if (action.type === 'document.edit') {
          // Real SDK: editDocument fails if doc doesn't exist
          const docExists = createdInBatch.has(docId) || entry.doc._id !== undefined
          if (!docExists) {
            throw new Error('Cannot edit document because it does not exist in draft or published form.')
          }
          for (const patch of action.patches ?? []) {
            if (patch.set) {
              Object.assign(entry.doc, patch.set)
              let log = inst._patchLog.get(docId)
              if (!log) {
                log = []
                inst._patchLog.set(docId, log)
              }
              log.push({ ...patch.set })
            }
          }
        } else if (action.type === 'document.create') {
          // Real SDK: createDocument fails if draft already exists
          if (entry.doc._id !== undefined) {
            throw new Error('A draft version of this document already exists.')
          }
          Object.assign(entry.doc, action.initialValue ?? {}, {
            _type: action.documentType,
            _id: docId,
          })
          createdInBatch.add(docId)
        } else if (action.type === 'document.publish') {
          // Publish: copy draft to a published entry (strip drafts. prefix)
          const publishedId = docId.replace(/^drafts\./, '')
          const publishedEntry = inst._getOrCreateEntry(`published:${publishedId}`)
          // Deep-copy draft content, stripping weak ref markers
          const published = JSON.parse(JSON.stringify(entry.doc))
          published._id = publishedId
          delete published._rev
          stripWeakRefs(published)
          publishedEntry.doc = published
          // Notify published subscribers
          for (const subscriber of publishedEntry.subscribers) {
            subscriber(publishedEntry.doc)
          }
        }

        // Set _rev like the real SDK does
        entry.doc._rev = transactionId

        // Notify subscribers (like the real SDK's observable)
        for (const subscriber of entry.subscribers) {
          subscriber(entry.doc)
        }
      }
      return {
        transactionId,
        documents: {},
        previous: {},
        previousRevs: {},
        appeared: [],
        updated: [],
        disappeared: [],
        submitted: async () => {},
      }
    },
  }
}
