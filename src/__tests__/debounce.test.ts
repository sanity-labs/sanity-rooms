import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFlusher, clearFlusher, scheduleFlusher } from '../debounce'

afterEach(() => { vi.useRealTimers() })

describe('DebouncedFlusher', () => {
  it('calls flush after debounce delay', () => {
    vi.useFakeTimers()
    const f = createFlusher()
    const flush = vi.fn()

    scheduleFlusher(f, flush, 100, 500)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('resets debounce timer on re-schedule', () => {
    vi.useFakeTimers()
    const f = createFlusher()
    const flush = vi.fn()

    scheduleFlusher(f, flush, 100, 500)
    vi.advanceTimersByTime(80)
    scheduleFlusher(f, flush, 100, 500) // reset
    vi.advanceTimersByTime(80)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(20)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('fires at maxWait even under continuous rescheduling', () => {
    vi.useFakeTimers()
    const f = createFlusher()
    const flush = vi.fn()

    // Schedule every 80ms, debounce 100ms, maxWait 300ms
    for (let i = 0; i < 10; i++) {
      scheduleFlusher(f, flush, 100, 300)
      vi.advanceTimersByTime(80)
    }

    // maxWait of 300ms should have fired by now (80*4 = 320 > 300)
    expect(flush).toHaveBeenCalled()
  })

  it('clearFlusher prevents pending flush', () => {
    vi.useFakeTimers()
    const f = createFlusher()
    const flush = vi.fn()

    scheduleFlusher(f, flush, 100, 500)
    clearFlusher(f)
    vi.advanceTimersByTime(200)
    expect(flush).not.toHaveBeenCalled()
    expect(f.pending).toBe(false)
  })

  it('sets pending flag correctly', () => {
    vi.useFakeTimers()
    const f = createFlusher()
    expect(f.pending).toBe(false)

    scheduleFlusher(f, vi.fn(), 100, 500)
    expect(f.pending).toBe(true)

    vi.advanceTimersByTime(100) // flush clears it
    expect(f.pending).toBe(false)
  })
})
