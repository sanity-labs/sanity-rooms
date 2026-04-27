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
   */
  async getOrCreate(roomId: string, context?: unknown): Promise<Room | null> {
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
   *  owns it (i.e. was constructed with `instanceFactory`). */
  async dispose(): Promise<void> {
    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    this.pending.clear()
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

    const room = new Room(config, this.instance, this.resource)
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
}
