import { describe, expect, it, vi } from 'vitest'
import { retry } from '../retry'

describe('retry', () => {
  it('returns on first success', async () => {
    const result = await retry(
      () => Promise.resolve(42),
      () => true,
      vi.fn(),
    )
    expect(result).toBe(42)
  })

  it('retries when shouldRetry returns true', async () => {
    let calls = 0
    const result = await retry(
      () => {
        calls++
        if (calls < 3) throw new Error('fail')
        return Promise.resolve('ok')
      },
      () => true,
      vi.fn(),
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })

  it('throws immediately when shouldRetry returns false', async () => {
    await expect(
      retry(
        () => Promise.reject(new Error('fatal')),
        () => false,
        vi.fn(),
      ),
    ).rejects.toThrow('fatal')
  })

  it('calls onRetry between attempts', async () => {
    const onRetry = vi.fn()
    let calls = 0
    await retry(
      () => {
        calls++
        if (calls < 3) throw new Error('fail')
        return Promise.resolve('ok')
      },
      () => true,
      onRetry,
    )
    expect(onRetry).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(0)
    expect(onRetry).toHaveBeenCalledWith(1)
  })

  it('throws after maxAttempts exhausted', async () => {
    await expect(
      retry(
        () => Promise.reject(new Error('fail')),
        () => true,
        vi.fn(),
        2,
      ),
    ).rejects.toThrow('fail')
  })
})
