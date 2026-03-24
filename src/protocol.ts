/**
 * Wire protocol messages between client and server.
 * Transport-agnostic — these are the shapes that flow through Transport.send().
 */

import type { Mutation } from './mutation'

// ── Client → Server ─────────────────────────────────────────────────────────

export interface ClientMutateMsg {
  channel: string
  type: 'mutate'
  mutationId: string
  mutation: Mutation
}

export interface ClientSubscribeMsg {
  channel: string
  type: 'subscribe'
}

export interface ClientUnsubscribeMsg {
  channel: string
  type: 'unsubscribe'
}

export interface ClientAppMsg {
  channel: string
  type: 'app'
  payload: unknown
}

export type ClientMsg = ClientMutateMsg | ClientSubscribeMsg | ClientUnsubscribeMsg | ClientAppMsg

// ── Server → Client ─────────────────────────────────────────────────────────

export interface ServerStateMsg {
  channel: string
  type: 'state'
  state: unknown
  rev?: string
}

export interface ServerAckMsg {
  channel: string
  type: 'ack'
  mutationId: string
  rev?: string
}

export interface ServerRejectMsg {
  channel: string
  type: 'reject'
  mutationId: string
  reason: string
}

export interface ServerQueryResultMsg {
  channel: string
  type: 'query-result'
  result: unknown
}

export interface ServerAppMsg {
  channel: string
  type: 'app'
  payload: unknown
}

export interface ServerErrorMsg {
  type: 'error'
  message: string
}

export type ServerMsg =
  | ServerStateMsg
  | ServerAckMsg
  | ServerRejectMsg
  | ServerQueryResultMsg
  | ServerAppMsg
  | ServerErrorMsg

// ── Type guards ──────────────────────────────────────────────────────────────

/** Type guard for client-to-server messages (must have `type` and `channel` string fields). */
export function isClientMsg(msg: unknown): msg is ClientMsg {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  return typeof obj.type === 'string' && typeof obj.channel === 'string'
}

/** Type guard for server-to-client messages (must have a `type` string field). */
export function isServerMsg(msg: unknown): msg is ServerMsg {
  if (typeof msg !== 'object' || msg === null) return false
  return typeof (msg as Record<string, unknown>).type === 'string'
}
