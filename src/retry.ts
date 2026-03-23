/**
 * Retry an async operation with exponential backoff.
 *
 * Caller decides what's retryable via `shouldRetry`. Between retries,
 * `onRetry` fires so the caller can refresh state (e.g. re-read a rev).
 */
export async function retry<T>(
  operation: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  onRetry: (attempt: number) => Promise<void>,
  maxAttempts = 5,
  baseDelayMs = 100,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (err) {
      if (attempt < maxAttempts && shouldRetry(err)) {
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)))
        await onRetry(attempt)
        continue
      }
      throw err
    }
  }
}
