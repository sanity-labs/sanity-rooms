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

export type ClientMsg =
  | ClientMutateMsg
  | ClientSubscribeMsg
  | ClientUnsubscribeMsg
  | ClientAppMsg

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

export function isClientMsg(msg: unknown): msg is ClientMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    'channel' in msg &&
    typeof (msg as any).channel === 'string'
  )
}

export function isServerMsg(msg: unknown): msg is ServerMsg {
  return typeof msg === 'object' && msg !== null && 'type' in msg
}
