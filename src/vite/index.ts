/**
 * Vite plugin — mounts a sanity-rooms RoomManager onto the dev server's
 * HTTP upgrade event AND auto-rebuilds it when server source files
 * change (so server-code edits hot-reload without bouncing the browser
 * tab connection).
 *
 * Replaces the ~50 lines of `configureServer` + `ssrLoadModule` +
 * `httpServer.on('upgrade')` plumbing every consuming app was rolling.
 *
 * The plugin's only assumption: the file at `roomManagerPath` exports a
 * `createRoomManager(): { handleUpgrade(req, socket, head): void; dispose(): void | Promise<void> }`.
 * Anything matching that interface — including the lib's own
 * `bridgeHttpUpgrade` wrapped in a tiny factory — works.
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Plugin, ViteDevServer } from 'vite'

interface AppManager {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  dispose?(): void | Promise<void>
}

interface AppManagerModule {
  createRoomManager(): AppManager
}

export interface SanityRoomsPluginOptions {
  /**
   * Absolute path to the file exporting `createRoomManager()`. Most
   * apps point this at `<repo>/apps/server/src/rooms/room-manager.ts`.
   */
  roomManagerPath: string
  /**
   * Watch globs that should trigger a manager reload. Defaults to any
   * change under `apps/server/src/` or `packages/sanity-rooms/src/`.
   * Pass an array of substrings — files whose path includes any of
   * these substrings reload.
   */
  watchPaths?: string[]
  /**
   * Custom logger label. Defaults to `[sanity-rooms]`.
   */
  logPrefix?: string
}

const DEFAULT_WATCH_SUBSTRINGS = ['/server/src/', '/sanity-rooms/src/']

export function sanityRoomsPlugin(options: SanityRoomsPluginOptions): Plugin {
  const watchSubstrings = options.watchPaths ?? DEFAULT_WATCH_SUBSTRINGS
  const prefix = options.logPrefix ?? '[sanity-rooms]'
  let manager: AppManager | null = null
  /** Single in-flight `loadManager()` promise. Coalesces concurrent
   *  callers (initial-load + hot-reload + upgrade-arrives-mid-reload)
   *  so we never spawn two managers in parallel. Cleared once the
   *  load resolves. */
  let loading: Promise<AppManager> | null = null

  return {
    name: 'sanity-rooms-vite',
    configureServer(server: ViteDevServer) {
      const loadManager = (): Promise<AppManager> => {
        // Coalesce concurrent loads. Without this, an upgrade arriving
        // during a watcher-triggered reload would kick off a parallel
        // ssrLoadModule + createRoomManager — racing two SDK
        // instances and two WSS layers.
        if (loading) return loading

        // Null `manager` BEFORE awaiting the previous dispose so any
        // upgrade event that fires during the dispose window doesn't
        // route into the dying manager. The upgrade handler below
        // waits on `loading` instead and gets the new instance.
        const previous = manager
        manager = null

        loading = (async () => {
          if (previous?.dispose) {
            try {
              await previous.dispose()
            } catch (err) {
              console.error(`${prefix} prior dispose failed:`, err)
            }
          }
          const mod = (await server.ssrLoadModule(options.roomManagerPath)) as AppManagerModule
          if (typeof mod.createRoomManager !== 'function') {
            throw new Error(`${prefix} ${options.roomManagerPath} must export createRoomManager()`)
          }
          const next = mod.createRoomManager()
          manager = next
          return next
        })().finally(() => {
          loading = null
        })

        return loading
      }

      server.watcher.on('change', async (file) => {
        if (!watchSubstrings.some((s) => file.includes(s))) return
        console.log(`${prefix} reloading room manager:`, file)
        try {
          await loadManager()
        } catch (err) {
          console.error(`${prefix} reload failed:`, err)
        }
      })

      server.httpServer?.on('upgrade', async (req, socket, head) => {
        const url = req.url ?? ''
        if (!url.startsWith('/ws/')) return
        // Wait for any in-flight load (initial or reload) before
        // routing. If neither manager nor loader is present, kick
        // off a fresh load.
        const m = manager ?? (await loadManager().catch((err) => {
          console.error(`${prefix} load failed during upgrade:`, err)
          return null
        }))
        if (!m) {
          socket.destroy()
          return
        }
        m.handleUpgrade(req, socket, head)
      })
    },
  }
}
