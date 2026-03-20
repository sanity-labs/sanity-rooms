/**
 * RoomManager — manages Room lifecycle with deduplication.
 *
 * Prevents concurrent creation of the same room (pending promise pattern).
 * Rooms auto-remove themselves from the manager when they empty + grace period expires.
 */

import type { SanityInstance } from '@sanity/sdk'
import type { SanityResource } from './sanity-bridge'
import { Room, type RoomConfig } from './room'

export interface RoomFactory {
  /** Create a RoomConfig for the given roomId. Return null to reject. */
  create(roomId: string, context: unknown): Promise<RoomConfig | null>
}

export class RoomManager {
  private rooms = new Map<string, Room>()
  private pending = new Map<string, Promise<Room | null>>()
  private instance: SanityInstance
  private resource: SanityResource
  private factory: RoomFactory

  constructor(instance: SanityInstance, resource: SanityResource, factory: RoomFactory) {
    this.instance = instance
    this.resource = resource
    this.factory = factory
  }

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

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

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
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Room ready timeout for ${roomId}`)), 15000)),
      ])
    } catch (err: any) {
      console.error(`[room-manager] ${err.message}`)
      room.dispose()
      return null
    }
    room.onEmpty = () => { this.rooms.delete(roomId) }
    this.rooms.set(roomId, room)

    return room
  }
}
