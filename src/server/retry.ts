/**
 * Exponential backoff retry for Sanity write conflicts (HTTP 409).
 *
 * Detects conflicts by status code or message, calls `onConflict` between
 * retries so the caller can refresh revisions or re-read state.
 */

export interface RetryOptions {
  /** Max number of retry attempts after the initial try. Default: 5. */
  maxRetries?: number
  /** Base delay in ms before first retry (doubles each attempt). Default: 100. */
  baseDelayMs?: number
  /** Label for log messages. */
  label?: string
}

export async function retryOnConflict<T>(
  operation: () => Promise<T>,
  onConflict: (attempt: number) => Promise<void>,
  options: RetryOptions = {},
): Promise<T | undefined> {
  const maxRetries = options.maxRetries ?? 5
  const baseDelayMs = options.baseDelayMs ?? 100
  const label = options.label ?? 'operation'

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (err: any) {
      const is409 = err?.statusCode === 409 || err?.message?.includes('conflict')
      if (is409 && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt)
        console.warn(`[sanity-rooms] ${label} conflict (attempt ${attempt + 1}), retrying in ${delay}ms`)
        await new Promise(resolve => setTimeout(resolve, delay))
        await onConflict(attempt)
        continue
      }
      console.error(`[sanity-rooms] ${label} failed:`, err)
      return undefined
    }
  }
  return undefined
}
