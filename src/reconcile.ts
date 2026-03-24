/**
 * Immutable reconciler — preserves referential identity for unchanged subtrees.
 *
 * When a fresh object arrives (e.g. from JSON over a transport), every node
 * gets a new reference even if the data is identical. This breaks React's
 * useMemo/useEffect dependency checks. The reconciler deep-compares old and new
 * trees and reuses old references wherever the data hasn't actually changed.
 */

function isPlainObject(obj: unknown): boolean {
  return obj !== null && typeof obj === 'object' && obj.constructor === Object
}

type ImmutableReconcile<T> = (prev: T | null, curr: T) => T

export interface CreateImmutableReconcileOptions {
  decorator?: <T>(fn: ImmutableReconcile<T>) => ImmutableReconcile<T>
}

function identity<T>(t: T) {
  return t
}

export function createImmutableReconcile({
  decorator = identity,
}: CreateImmutableReconcileOptions = {}): <T>(prev: T | null, curr: T) => T {
  const immutableReconcile = decorator(function _immutableReconcile<T>(prev: T | null, curr: T): T {
    if (prev === curr) return curr
    if (prev === null) return curr
    if (typeof prev !== 'object' || typeof curr !== 'object') return curr

    if (Array.isArray(prev) && Array.isArray(curr)) {
      const reconciled = curr.map((item, index) => (index < prev.length ? immutableReconcile(prev[index], item) : item))
      if (prev.length === curr.length && reconciled.every((item, index) => item === prev[index])) {
        return prev
      }
      return reconciled as T
    }

    if (!isPlainObject(prev) || !isPlainObject(curr)) return curr

    const prevObj = prev as Record<string, unknown>
    const currObj = curr as Record<string, unknown>

    const reconciled: Record<string, unknown> = {}
    let changed = false

    const enumerableKeys = new Set(Object.keys(currObj))

    for (const key of Object.getOwnPropertyNames(currObj)) {
      if (key in prevObj) {
        const reconciledValue = immutableReconcile(prevObj[key], currObj[key])
        if (enumerableKeys.has(key)) {
          reconciled[key] = reconciledValue
        } else {
          Object.defineProperty(reconciled, key, {
            value: reconciledValue,
            enumerable: false,
          })
        }
        changed = changed || reconciledValue !== prevObj[key]
      } else {
        if (enumerableKeys.has(key)) {
          reconciled[key] = currObj[key]
        } else {
          Object.defineProperty(reconciled, key, {
            value: currObj[key],
            enumerable: false,
          })
        }
        changed = true
      }
    }

    for (const key of Object.getOwnPropertyNames(prevObj)) {
      if (!(key in currObj)) {
        changed = true
        break
      }
    }

    return changed ? (reconciled as T) : prev
  })

  return immutableReconcile
}

export const immutableReconcile = createImmutableReconcile()
