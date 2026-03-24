/**
 * RoomManager — manages Room lifecycle with deduplication.
 *
 * Prevents concurrent creation of the same room (pending promise pattern).
 * Rooms auto-remove themselves from the manager when they empty + grace period expires.
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
  instance: SanityInstance
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
      // Legacy 3-arg constructor
      this.instance = instanceOrOptions as SanityInstance
      this.resource = resource
      this.factory = factory
      this.readyTimeoutMs = 15_000
      this.logger = consoleLogger
    } else {
      const opts = instanceOrOptions as RoomManagerOptions
      this.instance = opts.instance
      this.resource = opts.resource
      this.factory = opts.factory
      this.readyTimeoutMs = opts.readyTimeoutMs ?? 15_000
      this.logger = opts.logger ?? consoleLogger
    }
  }

  /**
   * Get an existing room or create one via the factory. Deduplicates concurrent
   * create calls for the same roomId. Returns null if the factory rejects.
   * Pass `context` (e.g. authenticated user) to the factory for auth checks.
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

  /** Dispose all rooms and clear the manager. */
  async dispose(): Promise<void> {
    const rooms = [...this.rooms.values()]
    this.rooms.clear()
    this.pending.clear()
    await Promise.all(rooms.map((r) => r.dispose()))
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
