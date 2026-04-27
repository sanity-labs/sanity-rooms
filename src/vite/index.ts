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

  return {
    name: 'sanity-rooms-vite',
    configureServer(server: ViteDevServer) {
      const loadManager = async () => {
        try {
          if (manager?.dispose) await manager.dispose()
        } catch (err) {
          console.error(`${prefix} prior dispose failed:`, err)
        }
        const mod = (await server.ssrLoadModule(options.roomManagerPath)) as AppManagerModule
        if (typeof mod.createRoomManager !== 'function') {
          throw new Error(`${prefix} ${options.roomManagerPath} must export createRoomManager()`)
        }
        manager = mod.createRoomManager()
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
        if (!manager) {
          try {
            await loadManager()
          } catch (err) {
            console.error(`${prefix} initial load failed:`, err)
            socket.destroy()
            return
          }
        }
        manager?.handleUpgrade(req, socket, head)
      })
    },
  }
}
