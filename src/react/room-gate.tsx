/**
 * RoomGate — gates rendering on a sanity-rooms hydration state.
 *
 * Most app routes share the same shape: render a loader until the room
 * is ready, render the content once hydrated, optionally render a
 * "lost connection" affordance when the WS drops. RoomGate ships that
 * shape so callers don't reimplement it on every screen.
 *
 *   <RoomGate
 *     status={room.status}
 *     ready={room.ready}
 *     loading={<Loading/>}
 *     disconnected={<ReconnectingMessage/>}
 *   >
 *     <Content {...room.state} />
 *   </RoomGate>
 *
 * `disconnected` is optional — if omitted, the gate falls back to the
 * `loading` slot when the transport drops mid-session.
 */

import type { ReactNode } from 'react'
import type { SyncClientStatus } from '../client/sync-client'

export interface RoomGateProps {
  status: SyncClientStatus
  ready: boolean
  loading: ReactNode
  /** Optional override rendered when the transport closed before
   *  hydration OR after hydration was lost. Falls back to `loading`. */
  disconnected?: ReactNode
  children: ReactNode
}

export function RoomGate({ status, ready, loading, disconnected, children }: RoomGateProps): ReactNode {
  if (!ready) {
    if (status === 'disconnected' && disconnected) return disconnected
    return loading
  }
  if (status === 'disconnected' && disconnected) return disconnected
  return children
}
