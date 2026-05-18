/**
 * gracefulShutdown — drain a sanity-rooms `RoomManager` cleanly on process
 * signals (SIGTERM, SIGINT, etc.).
 *
 * Without a drain, Node exits the moment a signal arrives: every in-flight
 * `bridge.write()` HTTP request to Sanity dies mid-flight, every connected
 * WebSocket client gets dropped without a `disconnect` frame, every
 * pending mutation is silently lost. That is the failure mode that caused
 * the 2026-05-16 Eurovision finale data loss in the consumer of this
 * library — see post-mortem docs in the consumer repo.
 *
 * The library can dispose its rooms cleanly (it already does, via
 * `RoomManager.dispose()`); what consumers always had to write themselves
 * was the wrapper: signal registration, a hard deadline so a stuck
 * dispose doesn't outrun the platform's SIGKILL grace window, and an
 * optional hook to close the consumer's own HTTP server (which the
 * library doesn't own) BEFORE the dispose so no new connections arrive
 * mid-drain.
 *
 * This helper provides the wrapper. Consumers call it once per signal:
 *
 *   import { createServer } from 'node:http'
 *   import { gracefulShutdown, RoomManager } from 'sanity-rooms/server'
 *
 *   const manager = new RoomManager({ ... })
 *   const server  = createServer(...)
 *
 *   for (const sig of ['SIGTERM', 'SIGINT'] as const) {
 *     process.on(sig, () => {
 *       void gracefulShutdown({
 *         manager,
 *         signal: sig,
 *         beforeManagerDispose: () => new Promise((r) => server.close(() => r())),
 *       }).finally(() => process.exit(0))
 *     })
 *   }
 *
 * Idempotent: a second call while the first is in progress is a no-op.
 * The first call's promise is the canonical one.
 */

/**
 * Minimal interface gracefulShutdown needs — anything with a `dispose`
 * method that returns void or a Promise. The sanity-rooms `RoomManager`
 * satisfies this directly; consumers that wrap it (e.g. an app-level
 * manager that adds metrics or HTTP routes) also satisfy it as long as
 * they expose a `dispose()` that drains the underlying RoomManager.
 *
 * We use this structural type instead of `import('./room-manager').RoomManager`
 * so consumers don't need to pierce their wrapper to call this helper.
 */
export interface ShutdownTarget {
  dispose(): void | Promise<void>
}

export interface GracefulShutdownOptions {
  /** The manager (or any object with `dispose()`) to drain. */
  manager: ShutdownTarget

  /**
   * Hard deadline in milliseconds. If `manager.dispose()` (and any
   * `beforeManagerDispose` step) haven't completed by this point, the
   * helper resolves anyway so the caller can force-exit. The internal
   * timer is `.unref()`d so it doesn't keep the event loop alive in
   * normal shutdown.
   *
   * Tune for your platform's SIGKILL grace window:
   *   - Fly.io gives 30s before SIGKILL → use 25_000 (5s buffer)
   *   - Kubernetes default is 30s → use 25_000
   *   - Vercel/Render typically 10s → use 7_000
   *
   * Default: 25_000.
   */
  hardDeadlineMs?: number

  /**
   * The signal name, used purely for the log line. No semantic effect —
   * if you want signal-specific behavior, register multiple `process.on`
   * handlers, each calling `gracefulShutdown` with the right signal.
   *
   * Default: 'SIGTERM'.
   */
  signal?: NodeJS.Signals | string

  /**
   * Called BEFORE `manager.dispose()`. Use it to stop accepting new
   * connections / requests before the room teardown begins. Typical
   * implementation:
   *
   *   beforeManagerDispose: () =>
   *     new Promise<void>((r) => server.close(() => r()))
   *
   * Errors thrown here are logged but do not abort the drain — the
   * library still attempts `manager.dispose()` afterwards so rooms get
   * a chance to clean up.
   */
  beforeManagerDispose?: () => void | Promise<void>

  /**
   * Called AFTER `manager.dispose()` (or after the hard deadline). Use
   * for any final non-room cleanup (e.g. flushing a metrics buffer).
   * Errors here are logged but not rethrown.
   */
  afterManagerDispose?: () => void | Promise<void>

  /**
   * Logger override. Defaults to the global `console`. Pass a custom
   * logger when the consumer already routes app logs through a
   * structured logger (pino, bunyan, etc.) and you want the drain
   * messages to flow through the same sink.
   */
  logger?: {
    log?: (msg: string) => void
    warn?: (msg: string) => void
    error?: (msg: string, err?: unknown) => void
  }
}

export interface GracefulShutdownResult {
  /**
   * Whether the drain completed cleanly within the hard deadline.
   * `true` on a normal drain; `false` when the hard-deadline timer
   * fired first (in which case some bridges/Rooms may still be
   * mid-teardown — the caller should still process.exit, the platform's
   * SIGKILL will clean up).
   */
  completed: boolean
  /** Total drain duration in ms. */
  elapsedMs: number
}

// Module-level guard so concurrent signal arrivals share one drain.
// Cleared on the resolved value, so a second drain attempt AFTER a
// completed one (e.g. SIGINT during shutdown re-handling) becomes a
// no-op rather than re-running.
let inFlight: Promise<GracefulShutdownResult> | null = null

export function gracefulShutdown(options: GracefulShutdownOptions): Promise<GracefulShutdownResult> {
  if (inFlight) return inFlight

  const startedAt = Date.now()
  const hardDeadlineMs = options.hardDeadlineMs ?? 25_000
  const signal = options.signal ?? 'SIGTERM'
  const log = options.logger?.log ?? ((m) => console.log(m))
  const warn = options.logger?.warn ?? ((m) => console.warn(m))
  const error = options.logger?.error ?? ((m, e) => console.error(m, e))

  log(`[graceful-shutdown] received ${signal} — draining (max ${hardDeadlineMs}ms)`)

  inFlight = (async (): Promise<GracefulShutdownResult> => {
    let hardTimerFired = false
    let hardTimer: ReturnType<typeof setTimeout> | null = null

    const hardDeadline = new Promise<'hard-deadline'>((resolve) => {
      hardTimer = setTimeout(() => {
        hardTimerFired = true
        error(`[graceful-shutdown] drain exceeded ${hardDeadlineMs}ms — forcing return`)
        resolve('hard-deadline')
      }, hardDeadlineMs)
      hardTimer.unref()
    })

    const drainSteps = async (): Promise<'drained'> => {
      if (options.beforeManagerDispose) {
        try {
          await options.beforeManagerDispose()
        } catch (err) {
          error(`[graceful-shutdown] beforeManagerDispose threw:`, err)
        }
      }
      try {
        await options.manager.dispose()
      } catch (err) {
        error(`[graceful-shutdown] manager.dispose threw:`, err)
      }
      if (options.afterManagerDispose) {
        try {
          await options.afterManagerDispose()
        } catch (err) {
          error(`[graceful-shutdown] afterManagerDispose threw:`, err)
        }
      }
      return 'drained'
    }

    const outcome = await Promise.race([drainSteps(), hardDeadline])
    if (hardTimer) clearTimeout(hardTimer)
    const elapsedMs = Date.now() - startedAt
    const completed = outcome === 'drained' && !hardTimerFired
    if (completed) {
      log(`[graceful-shutdown] drain complete (${elapsedMs}ms)`)
    } else {
      warn(`[graceful-shutdown] drain did NOT complete cleanly within deadline (${elapsedMs}ms)`)
    }
    return { completed, elapsedMs }
  })()

  return inFlight
}
