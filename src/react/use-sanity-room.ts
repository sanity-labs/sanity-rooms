/**
 * useSanityRoom — one-call React hook for joining a sanity-rooms room.
 *
 * Owns the full SyncClient lifecycle: WebSocket transport, hydration,
 * subscription wiring, status tracking, cleanup. Apps that previously
 * rolled per-room hooks (~50–100 lines each) collapse to:
 *
 *   const { state, status, mutate } = useSanityRoom<MyState>({
 *     url: '/ws/group/abc/vote',
 *     documents: { main: { applyMutation: replaceApply } },
 *   })
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocConfig, SyncClientStatus } from '../client/sync-client'
import { SyncClient } from '../client/sync-client'
import type { Mutation } from '../mutation'
import type { Transport } from '../transport'
import { WsClientTransport } from '../transport/ws-client-transport'

export interface UseSanityRoomOptions {
  /**
   * WebSocket URL OR a function returning one. A function lets callers
   * derive the URL from runtime state (window.location, the current
   * route param, etc) without re-creating the hook on every render.
   *
   * Pass `null` / `undefined` to disable the connection (e.g. while a
   * route param is missing) — the hook returns inert state.
   */
  url: string | (() => string) | null | undefined
  /** Per-document config — same shape as `SyncClient`'s `documents`. */
  documents: Record<string, DocConfig>
  /** Optional transport override. When provided, `url` is ignored. */
  transport?: Transport
  /** Override the default debounce (500ms / 1000ms maxWait). */
  sendDebounce?: { ms: number; maxWaitMs: number }
}

export interface UseSanityRoomResult<TStates extends Record<string, unknown> = Record<string, unknown>> {
  /** Hydrated state per doc key — null per slot until hydration arrives. */
  state: { [K in keyof TStates]: TStates[K] | null }
  /** `'connecting' | 'connected' | 'disconnected'` — see SyncClient docs. */
  status: SyncClientStatus
  /** Apply a mutation to a document. No-op when the room is idle / not hydrated. */
  mutate(docId: keyof TStates & string, mutation: Mutation): void
  /** Send on an app channel (no-op when idle). */
  sendApp(channel: string, payload: unknown): void
  /** Subscribe to an app channel. Returns an unsubscribe function. */
  onApp(channel: string, handler: (payload: unknown) => void): () => void
  /** True once every doc has hydrated at least once. */
  ready: boolean
  /** `true` after `ready` has flipped — useful for "did this ever connect". */
  hasConnected: boolean
}

/**
 * Resolve the URL into a stable string per render. `null` / `undefined`
 * disables the connection.
 */
function resolveUrl(url: UseSanityRoomOptions['url']): string | null {
  if (!url) return null
  return typeof url === 'function' ? url() : url
}

export function useSanityRoom<TStates extends Record<string, unknown> = Record<string, unknown>>(
  options: UseSanityRoomOptions,
): UseSanityRoomResult<TStates> {
  const { documents, transport, sendDebounce } = options
  const url = resolveUrl(options.url)

  const docKeys = useMemo(() => Object.keys(documents), [documents])

  const [state, setState] = useState<{ [K in keyof TStates]: TStates[K] | null }>(() => {
    const init: Record<string, unknown> = {}
    for (const k of docKeys) init[k] = null
    return init as { [K in keyof TStates]: TStates[K] | null }
  })
  const [status, setStatus] = useState<SyncClientStatus>('connecting')
  const [ready, setReady] = useState(false)
  const [hasConnected, setHasConnected] = useState(false)
  const clientRef = useRef<SyncClient | null>(null)

  // Stash documents+transport on a ref so the effect's identity only
  // tracks `url` — apps that pass an inline `documents` object won't
  // tear down + reconnect on every render.
  const cfgRef = useRef({ documents, transport, sendDebounce })
  cfgRef.current = { documents, transport, sendDebounce }

  useEffect(() => {
    if (!url && !transport) {
      // Disabled — keep refs null so calls fall through to no-ops.
      return
    }
    const cfg = cfgRef.current
    const wsTransport = cfg.transport ?? new WsClientTransport(url!)
    const client = new SyncClient({
      transport: wsTransport,
      documents: cfg.documents,
      sendDebounce: cfg.sendDebounce,
    })
    clientRef.current = client
    setStatus(client.status)

    const subs: Array<() => void> = []
    for (const key of Object.keys(cfg.documents)) {
      subs.push(
        client.subscribeDoc(key, () => {
          if (!client.isDocHydrated(key)) return
          setState((prev) => ({ ...prev, [key]: client.getDocState(key) }))
        }),
      )
    }
    subs.push(client.onStatus(setStatus))
    client.ready
      .then(() => {
        setReady(true)
        setHasConnected(true)
      })
      .catch(() => {
        // ready rejection is non-fatal — status listener already shows
        // 'disconnected' to the UI. Caller can read `status` to act.
      })

    return () => {
      for (const off of subs) off()
      client.dispose()
      clientRef.current = null
      setReady(false)
      setStatus('connecting')
      setState((prev) => {
        const cleared: Record<string, unknown> = {}
        for (const k of Object.keys(prev)) cleared[k] = null
        return cleared as typeof prev
      })
    }
  }, [url, transport])

  // Public API — these all dereference clientRef so a stale closure
  // never points at a disposed client.
  const mutate = useMemoizedCallback((docId: string, mutation: Mutation) => {
    const client = clientRef.current
    if (!client) return
    try {
      client.mutate(docId, mutation)
    } catch {
      // SyncClient throws if not hydrated. The hook is permissive: a
      // mutate() before hydration is dropped (caller can guard via
      // `ready` if they care).
    }
  })
  const sendApp = useMemoizedCallback((channel: string, payload: unknown) => {
    clientRef.current?.sendApp(channel, payload)
  })
  const onApp = useMemoizedCallback((channel: string, handler: (payload: unknown) => void) => {
    return clientRef.current?.onApp(channel, handler) ?? (() => {})
  })

  return {
    state,
    status,
    ready,
    hasConnected,
    mutate: mutate as UseSanityRoomResult<TStates>['mutate'],
    sendApp,
    onApp,
  }
}

function useMemoizedCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn)
  ref.current = fn
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable identity intentional
  const stable = useMemo(() => ((...args: Parameters<T>) => ref.current(...args)) as T, [])
  return stable
}
