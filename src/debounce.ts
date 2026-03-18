/**
 * DebouncedFlusher — debounce with maxWait guarantee.
 *
 * Delays flush calls, but guarantees they fire within maxWaitMs
 * even under continuous scheduling. Useful for batching rapid edits
 * while ensuring writes don't stall indefinitely.
 */

export interface DebouncedFlusher {
  timer: ReturnType<typeof setTimeout> | null
  maxWaitTimer: ReturnType<typeof setTimeout> | null
  pending: boolean
}

export function createFlusher(): DebouncedFlusher {
  return { timer: null, maxWaitTimer: null, pending: false }
}

export function clearFlusher(f: DebouncedFlusher): void {
  if (f.timer) clearTimeout(f.timer)
  if (f.maxWaitTimer) clearTimeout(f.maxWaitTimer)
  f.timer = null
  f.maxWaitTimer = null
  f.pending = false
}

export function scheduleFlusher(
  f: DebouncedFlusher,
  flush: () => void,
  debounceMs: number,
  maxWaitMs: number,
): void {
  f.pending = true
  if (f.timer) clearTimeout(f.timer)
  const wrappedFlush = () => {
    clearFlusher(f)
    flush()
  }
  f.timer = setTimeout(wrappedFlush, debounceMs)
  if (!f.maxWaitTimer) {
    f.maxWaitTimer = setTimeout(wrappedFlush, maxWaitMs)
  }
}
