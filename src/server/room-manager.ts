/**
 * RoomManager — manages Room lifecycle with deduplication.
 *
 * Construct with `instanceFactory` to let the manager own the SDK
 * lifecycle (it's disposed in `dispose()`); or pass a literal
 * `instance` if the caller manages it.
 */

import type { SanityInstance } from '@sanity/sdk'
import { consoleLogger, type Logger } from '../logger'
import { Room, type RoomConfig } from './room'
import type { SanityResource } from './sanity-bridge'

export interface RoomFactory {
  /** Create a RoomConfig for the given roomId. Return null to reject. */
  create(roomId: string, context: unknown): Promise<RoomConfig | null>
}

export interface RoomManagerOptions {
  /** Pass either a literal SDK instance OR a factory; the factory
   *  form makes the manager own the SDK lifecycle (disposed on
   *  `manager.dispose()`). */
  instance?: SanityInstance
  instanceFactory?: () => SanityInstance
  resource: SanityResource
  factory: RoomFactory
  /** Timeout (ms) waiting for room.ready on creation. Default: 15000. */
  readyTimeoutMs?: number
  /** Custom logger. Defaults to console. */
  logger?: Logger
}

export class RoomManager {
  private rooms = new Map<string, Room>()
  private pending = new Map<string, Promise<Room | null>>()
  private instance: SanityInstance
  private readonly instanceFactory: (() => SanityInstance) | null
  private resource: SanityResource
  private factory: RoomFactory
  private readyTimeoutMs: number
  private logger: Logger
  private disposed = false

  constructor(options: RoomManagerOptions)
  /** @deprecated Use options object instead. */
  constructor(instance: SanityInstance, resource: SanityResource, factory: RoomFactory)
  constructor(
    instanceOrOptions: SanityInstance | RoomManagerOptions,
    resource?: SanityResource,
    factory?: RoomFactory,
  ) {
    if (resource !== undefined && factory !== undefined) {
      this.instance = instanceOrOptions as SanityInstance
      this.instanceFactory = null
      this.resource = resource
      this.factory = factory
      this.readyTimeoutMs = 15_000
      this.logger = consoleLogger
    } else {
      const opts = instanceOrOptions as RoomManagerOptions
      if (!opts.instance && !opts.instanceFactory) {
        throw new Error('RoomManager requires either `instance` or `instanceFactory`')
      }
      this.instanceFactory = opts.instanceFactory ?? null
      this.instance = opts.instance ?? opts.instanceFactory!()
      this.resource = opts.resource
      this.factory = opts.factory
      this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000
      this.logger = opts.logger ?? consoleLogger
    }
  }

  /**
   * Get an existing room or create one via the factory. Deduplicates
   * concurrent create calls for the same roomId. Returns null if the
   * factory rejects or the room fails to first-emit within
   * `readyTimeoutMs`.
   *
   * After `dispose()` has been called, returns null without attempting
   * a new create — the SDK instance is already torn down and any new
   * Room would leak SDK subscriptions. Hot-reload paths rely on this
   * to ensure upgrade events arriving mid-dispose don't spawn rooms
   * on the dying manager.
   */
  async getOrCreate(roomId: string, context?: unknown): Promise<Room | null> {
    if (this.disposed) return null

    const existing = this.rooms.get(roomId)
    if (existing) return existing

    const pendingPromise = this.pending.get(roomId)
    if (pendingPromise) return pendingPromise

    const promise = this.createRoom(roomId, context)
    this.pending.set(roomId, promise)

    try {
      return await promise
    } finally {
      this.pending.delete(roomId)
    }
  }

  /** Peek at an existing room without creating one. */
  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  /** Dispose all rooms. Disposes the SDK instance too if the manager
   *  owns it (i.e. was constructed with `instanceFactory`).
   *
   *  Idempotent. Safe to call concurrently with `getOrCreate` — once
   *  the `disposed` flag is set, new `getOrCreate` calls short-circuit
   *  to null, so we know nothing fresh will land in `this.pending`
   *  after the snapshot below. We DO have to wait for in-flight
   *  creates to settle before disposing rooms, though: `createRoom`
   *  does `new Room(...)` (which subscribes to SDK observables in its
   *  bridge constructors) BEFORE registering into `this.rooms`. If we
   *  cleared rooms without awaiting pending creates, an in-flight
   *  Room would finish after, register into the cleared map, and
   *  leak — bridges holding SDK subscriptions, transport sockets
   *  open, no reference left to dispose it.
   *
   *  This was the dominant leak across hot-reloads in Vite-based dev
   *  setups: every server-source edit fired a manager rebuild while
   *  voter rooms were mid-`createRoom`, and the leftover Rooms
   *  accumulated until ephemeral ports ran out. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Snapshot pending creates and wait for them to settle. Their
    // `createRoom` bodies will register into `this.rooms` (or
    // `room.dispose()` on factory failure) before resolving.
    const inflight = [...this.pending.values()]
    this.pending.clear()
    if (inflight.length > 0) {
      await Promise.allSettled(inflight)
    }

    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    await Promise.all(rooms.map((r) => r.dispose()))

    if (this.instanceFactory) {
      try {
        ;(this.instance as { dispose?: () => void }).dispose?.()
      } catch (err) {
        this.logger.error('[room-manager] SDK dispose failed:', err)
      }
    }
  }

  private async createRoom(roomId: string, context: unknown): Promise<Room | null> {
    const config = await this.factory.create(roomId, context)
    if (!config) return null

    // Wire chain-rot signal: if ANY bridge in this room rots, kick off
    // a recreate of the shared SanityInstance.
    const augmentedConfig: RoomConfig = {
      ...config,
      onChainRot: () => {
        void this.handleChainRot()
      },
    }

    const room = new Room(augmentedConfig, this.instance, this.resource)
    try {
      await Promise.race([
        room.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Room ready timeout for ${roomId}`)), this.readyTimeoutMs),
        ),
      ])
    } catch (err: any) {
      this.logger.error(`[room-manager] ${err.message}`)
      room.dispose()
      return null
    }
    room.onDispose(() => {
      this.rooms.delete(roomId)
    })
    this.rooms.set(roomId, room)

    return room
  }

  /**
   * Handle a chain-rot signal from any room's bridge. The current
   * `SanityInstance` is permanently poisoned for the affected doc
   * (and per scenario K, this can cascade or recur) — the only
   * recovery is to throw it away and construct a fresh instance,
   * then re-subscribe every Room's bridges.
   *
   * Debounced + serialized: many bridges may fire chain-rot in
   * quick succession; we only recreate once per burst.
   */
  /** Synchronous flag — set BEFORE any work begins so re-entrant
   *  chain-rot signals (e.g. fresh bridges in recreateBridges
   *  immediately firing chain-rot from a still-poisoned listener)
   *  see the guard and return without recursing into a new recovery. */
  private chainRotInProgress = false
  /** Backoff so a permanently-broken SDK doesn't get re-recreated in a
   *  hot loop. After a recovery completes we ignore further chain-rot
   *  signals for this window. */
  private chainRotCooldownUntilMs = 0
  private static readonly CHAIN_ROT_COOLDOWN_MS = 5_000

  private async handleChainRot(): Promise<void> {
    if (this.disposed) return
    if (!this.instanceFactory) {
      this.logger.error(
        '[room-manager] chain-rot detected but no instanceFactory configured — cannot recreate; pass `instanceFactory` to RoomManager to enable recovery',
      )
      return
    }
    // Re-entrant guard: any signal fired while we're mid-recovery
    // (including signals from the NEW bridges if they also rot) is a
    // no-op. The single in-flight recovery already swapped them in;
    // if they keep failing, the cooldown will throttle further attempts.
    if (this.chainRotInProgress) return
    if (Date.now() < this.chainRotCooldownUntilMs) {
      this.logger.warn('[room-manager] chain-rot signal ignored — within cooldown window after a recent recovery')
      return
    }
    this.chainRotInProgress = true

    try {
      this.logger.warn('[room-manager] chain-rot recovery starting — disposing rotted SanityInstance')
      const oldInstance = this.instance
      const newInstance = this.instanceFactory!()
      this.instance = newInstance

      // Tell every active room to swap its bridges to the new instance.
      // Each room's recreateBridges is awaited sequentially to keep
      // backpressure on the SDK construction (parallel recreates
      // would spike network + memory).
      const snapshot = [...this.rooms.values()]
      for (const room of snapshot) {
        try {
          await room.recreateBridges(newInstance)
        } catch (err) {
          this.logger.error(`[room-manager] recreateBridges threw: ${(err as Error)?.message ?? err}`)
        }
      }

      // Dispose the old instance last so any lingering ref-bridge
      // subscriptions don't fail mid-tear-down.
      try {
        ;(oldInstance as { dispose?: () => void }).dispose?.()
      } catch (err) {
        this.logger.error(`[room-manager] old SDK dispose failed: ${(err as Error)?.message ?? err}`)
      }
      this.logger.warn('[room-manager] chain-rot recovery complete — rooms now using fresh SanityInstance')
    } finally {
      this.chainRotInProgress = false
      this.chainRotCooldownUntilMs = Date.now() + RoomManager.CHAIN_ROT_COOLDOWN_MS
    }
  }
}
