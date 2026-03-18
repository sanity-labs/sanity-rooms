/**
 * Channel naming and parsing utilities.
 *
 * Every message on the wire is tagged with a channel string:
 * - `doc:<docId>` — document state + mutations (built-in)
 * - `query:<queryId>` — GROQ query results (future)
 * - anything else — app-defined channels (chat, presence, etc.)
 */

export function docChannel(docId: string): string {
  return `doc:${docId}`
}

export function queryChannel(queryId: string): string {
  return `query:${queryId}`
}

export interface ParsedChannel {
  type: 'doc' | 'query' | 'app'
  id: string
}

export function parseChannel(channel: string): ParsedChannel {
  if (channel.startsWith('doc:')) {
    return { type: 'doc', id: channel.slice(4) }
  }
  if (channel.startsWith('query:')) {
    return { type: 'query', id: channel.slice(6) }
  }
  return { type: 'app', id: channel }
}
