import { describe, it, expect } from 'vitest'
import { MutationQueue } from '../client/mutation-queue'
import type { Mutation } from '../mutation'

const replace = (value: number): Mutation => ({ kind: 'replace', state: value })

function applyAdd(state: unknown, mutation: Mutation): unknown | null {
  if (mutation.kind !== 'replace') return null
  return (state as number) + (mutation.state as number)
}

describe('MutationQueue', () => {
  it('enqueues and reports pending', () => {
    const q = new MutationQueue()
    expect(q.hasPending()).toBe(false)

    q.enqueue('m1', replace(10))
    expect(q.hasPending()).toBe(true)
    expect(q.getPending()).toHaveLength(1)
  })

  it('ack removes the mutation', () => {
    const q = new MutationQueue()
    q.enqueue('m1', replace(10))
    q.enqueue('m2', replace(20))

    expect(q.ack('m1')).toBe(true)
    expect(q.getPending()).toHaveLength(1)
    expect(q.getPending()[0].mutationId).toBe('m2')
  })

  it('ack returns false for unknown id', () => {
    const q = new MutationQueue()
    expect(q.ack('nonexistent')).toBe(false)
  })

  it('reject removes the mutation', () => {
    const q = new MutationQueue()
    q.enqueue('m1', replace(10))
    q.enqueue('m2', replace(20))

    expect(q.reject('m1')).toBe(true)
    expect(q.getPending()).toHaveLength(1)
    expect(q.getPending()[0].mutationId).toBe('m2')
  })

  it('rebase replays mutations on new server state', () => {
    const q = new MutationQueue()
    q.enqueue('m1', replace(5))
    q.enqueue('m2', replace(3))

    // Server state is 100, pending adds are +5 and +3
    const result = q.rebase(100, applyAdd)
    expect(result).toBe(108) // 100 + 5 + 3
    expect(q.hasPending()).toBe(true)
    expect(q.getPending()).toHaveLength(2)
  })

  it('rebase drops mutations that return null', () => {
    const q = new MutationQueue()
    q.enqueue('m1', replace(5))
    q.enqueue('m2', { kind: 'named', name: 'bad', input: {} }) // will return null

    const result = q.rebase(100, applyAdd)
    expect(result).toBe(105)
    expect(q.getPending()).toHaveLength(1)
    expect(q.getPending()[0].mutationId).toBe('m1')
  })

  it('rebase with empty queue returns server state', () => {
    const q = new MutationQueue()
    const result = q.rebase(42, applyAdd)
    expect(result).toBe(42)
  })

  it('clear removes all mutations', () => {
    const q = new MutationQueue()
    q.enqueue('m1', replace(1))
    q.enqueue('m2', replace(2))
    q.clear()
    expect(q.hasPending()).toBe(false)
  })
})
