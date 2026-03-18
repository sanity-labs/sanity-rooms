/**
 * MockSanity — in-memory SdkAdapter for testing without a real Sanity project.
 *
 * Documents stored in a plain Map. External edits trigger subscriber callbacks.
 * Patches are applied as shallow merge (good enough for testing).
 */

import type { SdkAdapter } from '../server/sanity-bridge'

interface DocEntry {
  doc: Record<string, unknown>
  subscribers: Set<(doc: Record<string, unknown> | null) => void>
}

export interface MockSanityInstance {
  adapter: SdkAdapter
  /** Simulate an external edit (as if another user edited in Sanity Studio). */
  simulateExternalEdit(docId: string, doc: Record<string, unknown>): void
  /** Get current document state. */
  getDoc(docId: string): Record<string, unknown> | undefined
  /** Get all patches applied to a document (for assertions). */
  getPatches(docId: string): Array<Record<string, unknown>>
}

export function createMockSanity(
  initialDocs?: Record<string, Record<string, unknown>>,
): MockSanityInstance {
  const docs = new Map<string, DocEntry>()
  const patchLog = new Map<string, Array<Record<string, unknown>>>()

  // Initialize with provided docs
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

  const adapter: SdkAdapter = {
    subscribe(docId, _documentType, callback) {
      const entry = getOrCreateEntry(docId)
      entry.subscribers.add(callback)

      // Emit current state immediately
      queueMicrotask(() => {
        if (entry.subscribers.has(callback)) {
          callback(entry.doc)
        }
      })

      return () => {
        entry.subscribers.delete(callback)
      }
    },

    applyPatches(docId, _documentType, patches) {
      const entry = getOrCreateEntry(docId)
      // Shallow merge patches onto document
      Object.assign(entry.doc, patches)

      // Log the patch for assertions
      let log = patchLog.get(docId)
      if (!log) {
        log = []
        patchLog.set(docId, log)
      }
      log.push({ ...patches })

      // Notify subscribers
      for (const subscriber of entry.subscribers) {
        subscriber(entry.doc)
      }
    },
  }

  return {
    adapter,

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
