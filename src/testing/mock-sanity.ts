/**
 * MockSanity — in-memory mock for testing without a real Sanity project.
 *
 * Creates a mock SanityInstance and intercepts @sanity/sdk calls.
 * Documents stored in a plain Map. External edits trigger subscriber callbacks.
 */

import type { SanityInstance } from '@sanity/sdk'

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
export function createMockSanity(
  initialDocs?: Record<string, Record<string, unknown>>,
): MockSanityInstance {
  const docs = new Map<string, DocEntry>()
  const patchLog = new Map<string, Array<Record<string, unknown>>>()

  if (initialDocs) {
    for (const [id, doc] of Object.entries(initialDocs)) {
      docs.set(id, { doc: { ...doc }, subscribers: new Set() })
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
          subscribe: (callback: (doc: any) => void) => {
            entry.subscribers.add(callback)
            // Emit current state immediately (async like real SDK)
            queueMicrotask(() => {
              if (entry.subscribers.has(callback)) {
                callback(entry.doc)
              }
            })
            return {
              unsubscribe: () => entry.subscribers.delete(callback),
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

    applyDocumentActions: async (inst: any, options: any) => {
      const transactionId: string = options.transactionId ?? `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      for (const action of options.actions ?? []) {
        const docId = action.documentId
        const entry = inst._getOrCreateEntry(docId)

        if (action.type === 'document.edit') {
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
          Object.assign(entry.doc, action.initialValue ?? {}, {
            _type: action.documentType,
            _id: docId,
          })
        }

        // Set _rev like the real SDK does
        entry.doc._rev = transactionId

        // Notify subscribers (like the real SDK's observable)
        for (const subscriber of entry.subscribers) {
          subscriber(entry.doc)
        }
      }
      return { transactionId, documents: {}, previous: {}, previousRevs: {}, appeared: [], updated: [], disappeared: [], submitted: async () => {} }
    },
  }
}
