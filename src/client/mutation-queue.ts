/**
 * MutationQueue — tracks pending (unconfirmed) mutations for one document.
 *
 * When the client sends a mutation to the server, it's added to the queue.
 * The queue can rebase all pending mutations on top of a new server state
 * (when an external edit arrives), ack individual mutations (server confirmed),
 * or reject them (server refused, rollback).
 */

import type { Mutation } from '../mutation'

export interface PendingMutation {
  mutationId: string
  mutation: Mutation
}

export class MutationQueue {
  private queue: PendingMutation[] = []

  enqueue(mutationId: string, mutation: Mutation): void {
    this.queue.push({ mutationId, mutation })
  }

  ack(mutationId: string): boolean {
    const idx = this.queue.findIndex((m) => m.mutationId === mutationId)
    if (idx === -1) return false
    this.queue.splice(idx, 1)
    return true
  }

  reject(mutationId: string): boolean {
    const idx = this.queue.findIndex((m) => m.mutationId === mutationId)
    if (idx === -1) return false
    this.queue.splice(idx, 1)
    return true
  }

  /**
   * Re-apply all pending mutations on top of a new server state.
   * Returns the final state after all pending mutations are replayed.
   * Mutations that fail to apply (return null) are silently dropped.
   */
  rebase<T>(serverState: T, applyMutation: (state: T, mutation: Mutation) => T | null): T {
    let state = serverState
    const surviving: PendingMutation[] = []

    for (const pending of this.queue) {
      const result = applyMutation(state, pending.mutation)
      if (result !== null) {
        state = result
        surviving.push(pending)
      }
    }

    this.queue = surviving
    return state
  }

  hasPending(): boolean {
    return this.queue.length > 0
  }

  get pendingCount(): number {
    return this.queue.length
  }

  getPending(): readonly PendingMutation[] {
    return this.queue
  }

  clear(): void {
    this.queue = []
  }
}
