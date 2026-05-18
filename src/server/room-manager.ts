/**
 * RoomManager — manages Room lifecycle with per-key SanityInstance pooling.
 *
 * Every room declares an `instanceKey` (on `RoomConfig`) that names the
 * SDK instance pool it belongs to. Rooms with the same key share a
 * SanityInstance and benefit from the SDK's shared-listener
 * multiplexing. Rooms with different keys get isolated instances — a
 * chain-rot on one key only recreates that key's instance; rooms on
 * other keys are untouched.
 *
 * This is a deliberate breaking change from the prior "one instance per
 * RoomManager" design. That design made a chain-rot in any one room's
 * docs cascade across every room sharing the machine, which is exactly
 * how the 2026-05-16 finale disaster produced cross-tenant data loss.
 * The new design forces every consumer to declare the tenancy boundary
 * explicitly and the API helps catch missed declarations at compile
 * time (`RoomConfig.instanceKey` is required) rather than silently
 * defaulting to "share with everyone."
 *
 * Construct with `instanceFactory` — the manager calls it once per
 * unique `instanceKey` it sees. The literal `instance` constructor
 * option is gone: per-key pooling requires the manager to be able to
 * mint fresh instances for new keys + on chain-rot recovery, which
 * needs a factory.
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
  /**
   * Required. Called once per unique `RoomConfig.instanceKey` the
   * manager encounters — the returned instance is shared across every
   * room with that key, then disposed when the last room using it goes
   * away (or when chain-rot triggers a recreate for that key).
   */
  instanceFactory: () => SanityInstance
  resource: SanityResource
  factory: RoomFactory
  /** Timeout (ms) waiting for room.ready on creation. Default: 15000. */
  readyTimeoutMs?: number
  /** Custom logger. Defaults to console. */
  logger?: Logger
}

/** Per-instance-key bookkeeping. */
interface InstanceEntry {
  instance: SanityInstance
  /** Number of live Rooms holding this instance. When it hits 0, the
   *  instance is disposed and the entry removed. */
  refCount: number
}

/** Per-instance-key chain-rot recovery state. Tracked separately so a
 *  rotted instance for key A doesn't block recovery for key B. */
interface ChainRotState {
  inProgress: boolean
  cooldownUntilMs: number
}

export class RoomManager {
  private rooms = new Map<string, Room>()
  private pending = new Map<string, Promise<Room | null>>()
  /** instanceKey → InstanceEntry. Each key resolves to at most one
   *  SanityInstance at any time. */
  private instances = new Map<string, InstanceEntry>()
  /** Map from roomId → instanceKey for fast reverse lookup during
   *  chain-rot recovery (we need to walk only rooms with the affected
   *  key, not every room in the manager). */
  private roomToKey = new Map<string, string>()
  /** Per-key chain-rot state. Lazily created. */
  private chainRotByKey = new Map<string, ChainRotState>()
  private readonly instanceFactory: () => SanityInstance
  private resource: SanityResource
  private factory: RoomFactory
  private readyTimeoutMs: number
  private logger: Logger
  private disposed = false

  constructor(options: RoomManagerOptions) {
    if (!options.instanceFactory) {
      throw new Error(
        'RoomManager requires `instanceFactory`. The literal `instance` option was removed: per-key instance pooling needs the manager to mint instances on demand. Pass `instanceFactory: () => createSanityInstance(...)` instead.',
      )
    }
    this.instanceFactory = options.instanceFactory
    this.resource = options.resource
    this.factory = options.factory
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000
    this.logger = options.logger ?? consoleLogger
  }

  /**
   * Get an existing room or create one via the factory. Deduplicates
   * concurrent create calls for the same roomId. Returns null if the
   * factory rejects or the room fails to first-emit within
   * `readyTimeoutMs`.
   *
   * After `dispose()` has been called, returns null without attempting
   * a new create — the SDK instances are already torn down and any
   * fresh Room would leak SDK subscriptions.
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

  /**
   * Snapshot of the current instance pool — for diagnostics / metrics.
   * Each entry is `[instanceKey, refCount]`. The instance itself isn't
   * exposed; consumers shouldn't need to reach in. Order is insertion
   * order (Map iteration semantics), which roughly matches creation
   * order.
   */
  getInstanceKeys(): Array<{ key: string; refCount: number }> {
    return [...this.instances.entries()].map(([key, entry]) => ({ key, refCount: entry.refCount }))
  }

  /**
   * Dispose all rooms and all SDK instances. Idempotent.
   *
   * Safe to call concurrently with `getOrCreate` — once the `disposed`
   * flag is set, new `getOrCreate` calls short-circuit to null. We
   * still have to wait for in-flight creates to settle before disposing
   * rooms: `createRoom` does `new Room(...)` (which subscribes to SDK
   * observables in its bridge constructors) BEFORE registering into
   * `this.rooms`. If we cleared rooms without awaiting pending creates,
   * an in-flight Room would finish after, register into the cleared
   * map, and leak — bridges holding SDK subscriptions, transport
   * sockets open, no reference left to dispose it.
   *
   * This was the dominant leak across hot-reloads in Vite-based dev
   * setups: every server-source edit fired a manager rebuild while
   * voter rooms were mid-`createRoom`, and the leftover Rooms
   * accumulated until ephemeral ports ran out.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Snapshot pending creates and wait for them to settle.
    const inflight = [...this.pending.values()]
    this.pending.clear()
    if (inflight.length > 0) {
      await Promise.allSettled(inflight)
    }

    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    this.roomToKey.clear()
    await Promise.all(rooms.map((r) => r.dispose()))

    // Dispose every instance. The room.dispose() calls above should
    // have driven all refCounts to 0 via the onDispose hook, but we
    // sweep here defensively in case of races.
    for (const [key, entry] of this.instances) {
      try {
        ;(entry.instance as { dispose?: () => void }).dispose?.()
      } catch (err) {
        this.logger.error(`[room-manager] SDK dispose failed for key='${key}':`, err)
      }
    }
    this.instances.clear()
    this.chainRotByKey.clear()
  }

  private async createRoom(roomId: string, context: unknown): Promise<Room | null> {
    const config = await this.factory.create(roomId, context)
    if (!config) return null

    const key = config.instanceKey
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(
        `[room-manager] RoomConfig.instanceKey must be a non-empty string. ` +
          `roomId='${roomId}' got instanceKey=${JSON.stringify(key)}. ` +
          `Set instanceKey on the RoomConfig returned by your factory — it identifies the SanityInstance pool this room shares (e.g. 'group:abc123', 'message:msg-456').`,
      )
    }
    const instance = this.acquireInstance(key)

    // Wire chain-rot signal: it carries the room's instanceKey so
    // recovery is scoped to just this key's instance.
    const augmentedConfig: RoomConfig = {
      ...config,
      onChainRot: () => {
        void this.handleChainRot(key)
      },
    }

    const room = new Room(augmentedConfig, instance, this.resource)
    try {
      await Promise.race([
        room.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Room ready timeout for ${roomId}`)), this.readyTimeoutMs),
        ),
      ])
    } catch (err: any) {
      this.logger.error(`[room-manager] ${err.message}`)
      this.releaseInstance(key)
      room.dispose()
      return null
    }
    room.onDispose(() => {
      this.rooms.delete(roomId)
      this.roomToKey.delete(roomId)
      this.releaseInstance(key)
    })
    this.rooms.set(roomId, room)
    this.roomToKey.set(roomId, key)

    return room
  }

  /** Acquire (or create) the SanityInstance for an instanceKey. The
   *  caller is responsible for `releaseInstance(key)` exactly once
   *  when its room disposes. */
  private acquireInstance(key: string): SanityInstance {
    let entry = this.instances.get(key)
    if (!entry) {
      entry = { instance: this.instanceFactory(), refCount: 0 }
      this.instances.set(key, entry)
      this.logger.warn(`[room-manager] created SanityInstance for key='${key}'`)
    }
    entry.refCount += 1
    return entry.instance
  }

  /** Drop a reference. When refCount hits 0, dispose the instance and
   *  remove the entry. */
  private releaseInstance(key: string): void {
    const entry = this.instances.get(key)
    if (!entry) return
    entry.refCount -= 1
    if (entry.refCount > 0) return
    this.instances.delete(key)
    this.chainRotByKey.delete(key)
    try {
      ;(entry.instance as { dispose?: () => void }).dispose?.()
    } catch (err) {
      this.logger.error(`[room-manager] SDK dispose failed for key='${key}':`, err)
    }
    this.logger.warn(`[room-manager] disposed SanityInstance for key='${key}' (refCount=0)`)
  }

  /**
   * Handle a chain-rot signal scoped to a specific instanceKey.
   *
   * The affected SanityInstance is permanently poisoned for the doc
   * that signaled. Recovery: throw it away, mint a fresh one via the
   * factory, walk every Room currently using this key and have it
   * swap to the new instance. Rooms on OTHER keys are untouched —
   * their SDK state stays healthy regardless of this key's churn.
   *
   * Per-key serialization + per-key cooldown means a permanently-
   * broken upstream for one key can't starve recoveries for others.
   */
  private static readonly CHAIN_ROT_COOLDOWN_MS = 5_000

  private async handleChainRot(key: string): Promise<void> {
    if (this.disposed) return

    let state = this.chainRotByKey.get(key)
    if (!state) {
      state = { inProgress: false, cooldownUntilMs: 0 }
      this.chainRotByKey.set(key, state)
    }

    if (state.inProgress) return
    if (Date.now() < state.cooldownUntilMs) {
      this.logger.warn(
        `[room-manager] chain-rot signal for key='${key}' ignored — within cooldown window`,
      )
      return
    }

    const entry = this.instances.get(key)
    if (!entry) {
      this.logger.warn(`[room-manager] chain-rot for key='${key}' but no live instance — already disposed?`)
      return
    }

    state.inProgress = true
    try {
      this.logger.warn(`[room-manager] chain-rot recovery starting for key='${key}'`)
      const oldInstance = entry.instance
      const newInstance = this.instanceFactory()
      entry.instance = newInstance

      // Walk only rooms that share the affected key.
      const affectedRoomIds = [...this.roomToKey.entries()]
        .filter(([, k]) => k === key)
        .map(([roomId]) => roomId)

      for (const roomId of affectedRoomIds) {
        const room = this.rooms.get(roomId)
        if (!room) continue
        try {
          await room.recreateBridges(newInstance)
        } catch (err) {
          this.logger.error(
            `[room-manager] recreateBridges threw for room='${roomId}' key='${key}': ${(err as Error)?.message ?? err}`,
          )
        }
      }

      // Dispose old instance after every room has swapped, so any
      // lingering subscriptions on it don't fail mid-teardown.
      try {
        ;(oldInstance as { dispose?: () => void }).dispose?.()
      } catch (err) {
        this.logger.error(
          `[room-manager] old SDK dispose failed for key='${key}': ${(err as Error)?.message ?? err}`,
        )
      }
      this.logger.warn(
        `[room-manager] chain-rot recovery complete for key='${key}' — ${affectedRoomIds.length} room(s) now on fresh SanityInstance`,
      )
    } finally {
      state.inProgress = false
      state.cooldownUntilMs = Date.now() + RoomManager.CHAIN_ROT_COOLDOWN_MS
    }
  }
}
