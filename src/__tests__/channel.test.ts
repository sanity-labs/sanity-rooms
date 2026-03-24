import { describe, expect, it } from 'vitest'
import { docChannel, parseChannel, queryChannel } from '../channel'

describe('channel helpers', () => {
  it('docChannel produces doc: prefix', () => {
    expect(docChannel('abc-123')).toBe('doc:abc-123')
  })

  it('queryChannel produces query: prefix', () => {
    expect(queryChannel('my-query')).toBe('query:my-query')
  })

  it('parseChannel parses doc channels', () => {
    expect(parseChannel('doc:abc')).toEqual({ type: 'doc', id: 'abc' })
  })

  it('parseChannel parses query channels', () => {
    expect(parseChannel('query:foo')).toEqual({ type: 'query', id: 'foo' })
  })

  it('parseChannel treats unknown prefixes as app channels', () => {
    expect(parseChannel('chat')).toEqual({ type: 'app', id: 'chat' })
    expect(parseChannel('presence')).toEqual({ type: 'app', id: 'presence' })
  })
})
