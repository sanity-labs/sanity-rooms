# Worked example: a multiplayer Mood Board

This document walks through building a brand-new app on top of `sanity-rooms` end‑to‑end, using a deliberately simple domain — a **Mood Board** — that is *architecturally equivalent* to the morphing‑clock message editor that ships in this repo.

It exists because reading the README leaves a few wrong impressions:

- "I'll just `fetch` the doc, mutate it via REST, and re‑fetch." **No.** That is the anti‑pattern this package exists to replace.
- "I'll embed the image asset directly in the main doc." **No.** Anything that can be edited independently or shared between docs must be a separate Sanity document and reach the frontend through the ref‑following machinery.
- "I'll wire WebSockets, then bolt on REST mutations as a fallback." **No.** Once a room is live, *all* edits flow through `SyncClient.mutate(...)`. REST endpoints are for things that aren't a room: list pages, file uploads, OAuth.

If you skip those rules you lose multiplayer correctness, optimistic UI, debounced sends, echo suppression, ref dereferencing, draft/published handling, and HMR survival — all things this package gives you for free if you wire it up correctly.

The example is a complete blueprint. Read it top to bottom before touching code. Then come back to use it as a checklist while building.

---

## 0. The example: a Mood Board

A **Board** is a single Sanity document a user can collaboratively edit in real time. It has:

- A title.
- A list of **sticky notes** stored *inline* in the board doc (text, position, color, `_key`). Like message *frames* in the clock domain — child rows that belong to one parent and have no independent identity.
- A list of **images** stored as references to a separate `boardImage` document. Each `boardImage` carries a Sanity image asset plus per‑image metadata (caption, tint). Like *custom fonts/palettes/backgrounds* in the clock domain — assets that can be shared, that show up as their own row in Sanity Studio, and that have to publish *before* the board can publish so weak refs can strengthen.

That's it. Two doc types, one inline child array, one ref array. Every concept in `sanity-rooms` is exercised:

| Concept | Where it shows up in the Mood Board |
|---|---|
| `DocumentMapping` | Two of them — one for `board`, one for `boardImage` |
| Inline children | Sticky notes (`note._key`, no Sanity identity of their own) |
| `resolveRefs` | Walk `board.images[]`, return one `RefDescriptor` per ref |
| `fromSanityWithRefs` | Replace `{ _ref: "img-7" }` with the actual `boardImage` doc content |
| `toSanityPatch` returning `refPatches` | Edits to a caption write to the `boardImage` doc, not the board |
| Weak refs + `_strengthenOnPublish` | `board.images[]` entries are weak so drafts can reference draft images |
| `Room.publish` | Publishes all `boardImage` ref docs first, then the `board` |
| App channels | `'publish'` channel for publish requests; `'presence'` channel for cursors |
| Optimistic + debounced replace | User drags a sticky → instant local update, debounced sanityPatch send |
| Echo suppression | `transactionId → _rev` so we don't re‑broadcast our own writes |
| HMR / reconnect | WS reconnects, server re‑sends full state, client rebases unsent edits |
| File uploads | Image upload is a REST endpoint that returns an asset ref; the board edit that *attaches* it is a normal WS mutation |

If you can hold this Mood Board in your head, you can read the morphing‑clock code and understand it. The clock domain only differs in that it has more child types (frames, segments, keyframes) and more ref types (fonts, palettes, backgrounds, audio presets) — same shape, more rows.

---

## 1. The single most important picture

```
┌────────────────────────── Browser ──────────────────────────┐
│                                                             │
│  React UI                                                   │
│    │                                                        │
│    │  setBoard(next)            ← optimistic                │
│    ▼                                                        │
│  useBoardSync (your hook)                                   │
│    │                                                        │
│    ▼                                                        │
│  SyncClient                                                 │
│    │  · localState (optimistic)                             │
│    │  · serverState (last server snapshot)                  │
│    │  · lastSentState (basis for next diff)                 │
│    │  · debounce 500ms / maxWait 1000ms                     │
│    │  · diffValue(lastSent, local) → SanityPatchOperations  │
│    ▼                                                        │
│  WsClientTransport ── ws:// /ws/:boardId ──┐                │
└────────────────────────────────────────────┼────────────────┘
                                             │
┌──────────────────── Server (Node) ─────────┼────────────────┐
│  HTTP + WS                                 │                │
│    │   upgrade /ws/:boardId                ▼                │
│    │   verify JWT, fetch ownership                          │
│    ▼                                                        │
│  RoomManager.getOrCreate(boardId, user)                     │
│    │   factory returns RoomConfig with one or more docs     │
│    ▼                                                        │
│  Room  (one per board)                                      │
│    │  · clients[]            broadcasts state to peers      │
│    │  · ownTxns              echo suppression               │
│    │  · refBridges           one SanityBridge per image ref │
│    │  · DocumentMapping      board ↔ Sanity                 │
│    ▼                                                        │
│  SanityBridge (raw doc + ref bridges)                       │
│    │  · subscribes via @sanity/sdk getDocumentState         │
│    │  · writes via applyDocumentActions(transactionId)      │
│    ▼                                                        │
│  @sanity/sdk ──────────────────────────────────────────────►│
└─────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
                                                  Sanity Content Lake
```

There are exactly **three places state lives** at any moment:

1. The frontend's `localState` inside `SyncClient` (optimistic, source of truth for the UI).
2. The server's `Room.docs[key].state` (the *domain*‑shaped state, mapped from Sanity).
3. The Sanity document (`drafts.<id>` and possibly a published twin).

Everything in this package exists to keep those three things consistent in the face of: many editors, network failures, AI tool calls, hot reloads, and the SDK's own asynchronous nature.

---

## 2. Three shapes you must keep straight

If you take one thing from this doc, take this. The same Mood Board lives in three different shapes and confusing them is the #1 reason apps end up with REST endpoints they don't need.

### Shape A — the Sanity raw doc (what the SDK gives you)

```ts
// drafts.board-abc on the wire
{
  _id: 'drafts.board-abc',
  _type: 'board',
  _rev: 'txn-9f...',
  title: 'Mood for the launch',
  notes: [
    { _key: 'n1', _type: 'note', text: 'Hero copy?', x: 120, y: 80, color: '#fce' },
    { _key: 'n2', _type: 'note', text: 'CTA color',  x: 320, y: 60, color: '#cef' },
  ],
  images: [
    { _key: 'r1', _type: 'reference', _ref: 'img-7',
      _weak: true, _strengthenOnPublish: { type: 'boardImage' } },
    { _key: 'r2', _type: 'reference', _ref: 'img-8',
      _weak: true, _strengthenOnPublish: { type: 'boardImage' } },
  ],
  owner: { _ref: 'user-42', _type: 'reference' },
}
```

The `images[]` entries are **just refs** — they hold no image data. To render the board you need to fetch each `boardImage` document.

### Shape B — what the Sanity Studio schema looks like

```ts
// packages/your-studio-plugin/schema/board.ts
defineType({
  name: 'board',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string' }),
    defineField({
      name: 'notes',
      type: 'array',
      of: [{
        type: 'object',
        name: 'note',
        fields: [
          defineField({ name: 'text',  type: 'string' }),
          defineField({ name: 'x',     type: 'number' }),
          defineField({ name: 'y',     type: 'number' }),
          defineField({ name: 'color', type: 'string' }),
        ],
      }],
    }),
    defineField({
      name: 'images',
      type: 'array',
      of: [{
        type: 'reference',
        to: [{ type: 'boardImage' }],
        weak: true,                           // ← critical
        options: { weak: true },              // ← critical (see §12.5)
      }],
    }),
    defineField({ name: 'owner', type: 'reference', to: [{ type: 'user' }] }),
  ],
})

// boardImage.ts
defineType({
  name: 'boardImage',
  type: 'document',
  fields: [
    defineField({ name: 'caption', type: 'string' }),
    defineField({ name: 'tint',    type: 'string' }),
    defineField({
      name: 'asset',
      type: 'image',
      options: { hotspot: true },
    }),
  ],
})
```

Two top‑level documents. The board references images by ID. **Every Studio field name in this schema is exactly what you'll see on the wire in Shape A.**

### Shape C — the frontend domain shape (what your React code uses)

```ts
// packages/board-core/src/types.ts
export interface Board {
  title: string
  notes: Note[]
  images: BoardImage[]   //  ← inline, not refs
}

export interface Note {
  _key: string
  text: string
  x: number
  y: number
  color: string
}

export interface BoardImage {
  /** Sanity document ID of the boardImage doc. Stable identifier. */
  _id: string
  caption: string
  tint: string
  asset: { _ref: string; url: string }   // resolved from Sanity image asset
}
```

The frontend works with **fully dereferenced data**. It never sees `{ _ref: 'img-7' }`. The `DocumentMapping.fromSanityWithRefs` is what does the dereferencing — it splices the `boardImage` content from the ref bridges into the array slot.

> **The bridge between A and C is `DocumentMapping`.** The mapping never needs to be exposed to React, the schema, or the URL. It's a server‑side translation layer that runs every time Sanity (or a client) emits a change, and again every time the client serializes a write.

A common mistake is to design the React state to mirror Shape A (carrying around `_ref` objects). Don't. The React tree should look exactly like Shape C — the kind of object you'd hand to a render function or pass to `JSON.stringify` for export. The conversion happens at the `Room` layer, not in the UI.

---

## 3. Project layout

A real implementation typically looks like this:

```
your-app/
├─ packages/
│   ├─ board-core/                 ← framework-free types + mutations
│   │    src/
│   │      types.ts                ← Shape C above
│   │      mutations.ts            ← named mutations (optional, for AI tools)
│   │
│   ├─ board-sanity-bridge/        ← pure converters (Shape A ↔ Shape C)
│   │    src/
│   │      sanity-types.ts         ← Shape A as TS
│   │      config-to-sanity.ts     ← Board → { board, imageDocs }
│   │      sanity-to-config.ts     ← raw doc + ref docs → Board
│   │
│   └─ sanity-plugin-board/        ← Studio schema
│        src/schema/
│          board.ts
│          boardImage.ts
│
├─ apps/
│   ├─ server/                     ← Hono / Express / whatever
│   │    src/
│   │      app.ts                  ← HTTP routes, WS upgrade
│   │      auth.ts                 ← JWT, OAuth
│   │      rooms/
│   │        room-manager.ts       ← wraps sanity-rooms RoomManager + WS upgrade
│   │        board-room.ts         ← wraps Room, adds 'publish' / 'presence' channels
│   │        board-mapping.ts      ← the DocumentMapping<Board>
│   │      transport/
│   │        ws-server-transport.ts (or import from sanity-rooms)
│   │      routes/
│   │        boards.ts             ← REST: list, create, delete, upload-image
│   │
│   └─ web/                        ← React / Vite
│        src/
│          useBoardSync.ts         ← the React hook
│          BoardEditor.tsx
│          transport/
│            ws-client-transport.ts (or import from sanity-rooms)
```

Three rules for splitting concerns:

- **`board-core`** has zero deps. Types and pure mutation functions only. No `@sanity/sdk`, no React, no WebSocket.
- **`board-sanity-bridge`** has one dep: nothing runtime. Just `@sanity/types` for type imports if you want. It is the *only* place that knows about Shape A — both the server's `DocumentMapping` and any GROQ‑based code path import its converters.
- **`sanity-rooms`** is *not* in the dependency graph of `board-core` or `board-sanity-bridge`. It only shows up in `apps/server` and `apps/web`.

Why? Because the Sanity Studio plugin will eventually want to render previews (Studio runs in a browser, no `sanity-rooms`), the same converters power the public read‑only viewer (server‑side fetch, no `sanity-rooms`), and *nothing* downstream of `board-core` needs to know about the sync layer at all.

---

## 4. The DocumentMapping — the heart of the integration

This is what most people get wrong. The `DocumentMapping` is a *plain object* with five methods (one optional). It sits on the server. It carries no state. It is called by `Room` at well‑defined moments:

| Method | Called when | Purpose |
|---|---|---|
| `fromSanity(rawDoc)` | The doc has no refs to follow | Convert Shape A → Shape C |
| `fromSanityWithRefs(rawDoc, refDocs)` | Doc has refs and they're loaded | Convert Shape A + ref doc map → Shape C |
| `toSanityPatch(state)` | After every mutation | Convert Shape C → `{ patch, refPatches }` |
| `applyMutation(state, mutation)` | A `mutate` message arrives | Apply a logical mutation, return new Shape C state |
| `resolveRefs(rawDoc)` | Doc changes | List the refs the room should subscribe to |

Here's the full mapping for our Mood Board:

```ts
// apps/server/src/rooms/board-mapping.ts
import type { DocumentMapping, Mutation, RefDescriptor } from 'sanity-rooms'
import type { Board } from 'board-core'
import { configToSanity, sanityToConfig } from 'board-sanity-bridge'

// ── A small helper mapping for the boardImage doc type ─────────────────────
// Ref docs need a mapping too — but it can be the identity mapping.
// `documentType` MUST match the real Sanity schema name (`boardImage`),
// because createDocumentHandle stamps it as the new draft's _type.
const imageMapping: DocumentMapping<Record<string, unknown>> = {
  documentType: 'boardImage',
  fromSanity: (doc) => doc,
  toSanityPatch: (state) => ({ patch: state }),
  applyMutation: (_state, m) =>
    m.kind === 'replace' ? (m.state as Record<string, unknown>) : null,
}

export const boardMapping: DocumentMapping<Board> = {
  documentType: 'board',

  // ── Read paths ──────────────────────────────────────────────────────────

  fromSanity(doc) {
    // Used by Room only when the mapping has no resolveRefs (or no refs exist).
    // For the Board, we always have a fromSanityWithRefs path, but defining
    // this is required by the interface and used by tests / fallback paths.
    return sanityToConfig(doc as any, new Map())
  },

  fromSanityWithRefs(doc, refDocs) {
    // refDocs is a Map<refKey, rawSanityDoc>.
    // The KEY is the same string we returned from resolveRefs() — see below.
    // Splice the actual boardImage docs into the images array, then convert.
    return sanityToConfig(doc as any, refDocs)
  },

  // ── Write path ──────────────────────────────────────────────────────────

  toSanityPatch(state) {
    // Convert the whole Board back to a Sanity-shaped object plus the set
    // of boardImage docs we want to write alongside it.
    const { board, imageDocs } = configToSanity(state)

    // refPatches: one entry per ref doc we want to upsert. The KEY MUST match
    // what resolveRefs would return for that same ref. If the keys don't
    // line up, Room.buildRefDocWrites can't connect the patch to the docId
    // and the ref doc never gets written.
    const refPatches: Record<string, Record<string, unknown>> = {}
    for (const img of imageDocs) {
      refPatches[`img-${img._id}`] = img
    }

    return {
      patch: board,
      ...(Object.keys(refPatches).length ? { refPatches } : {}),
    }
  },

  // ── Apply a mutation ────────────────────────────────────────────────────

  applyMutation(state, mutation: Mutation): Board | null {
    // For most apps you only need 'replace'.
    if (mutation.kind === 'replace') return mutation.state as Board
    if (mutation.kind === 'merge')   return { ...state, ...mutation.partial } as Board

    // 'sanityPatch' is handled by Room itself before applyMutation is called,
    // via @sanity/mutator. You don't need a branch for it.

    // 'named' is for intent-based mutations (e.g. AI tools): "addNote",
    // "moveNote", etc. Implement only if you need it. Return null to reject.
    if (mutation.kind === 'named') {
      // example skeleton:
      // return runNamedMutation(state, mutation.name, mutation.input)
      return null
    }
    return null
  },

  // ── Discover refs ───────────────────────────────────────────────────────

  resolveRefs(rawDoc): RefDescriptor[] {
    const images = (rawDoc as any).images
    if (!Array.isArray(images)) return []
    return images
      .map((r: any) => r?._ref as string | undefined)
      .filter((id): id is string => !!id)
      .map((id) => ({
        key: `img-${id}`,        // ← MUST equal the key used in refPatches above
        docId: id,
        mapping: imageMapping,
      }))
  },
}
```

A few things to internalize:

- The **`key`** in `RefDescriptor` is used three places: (1) returned from `resolveRefs`, (2) as the key in the `refDocs` Map passed to `fromSanityWithRefs`, (3) as the key in `refPatches` returned by `toSanityPatch`. They MUST be the same string. Use a prefix (`img-`, `cf-`, etc.) so collisions across types are impossible.
- `documentType` on each mapping MUST match the schema name. The SDK uses it to create new ref docs (`createDocumentHandle({ documentType, ... })`) — pass the wrong string and Sanity rejects the create with a schema validation error.
- `toSanityPatch` should return the *full* shape of the doc you want stored, not a delta. The `SyncClient` does the diffing on the way out (using `@sanity/diff-patch`); the mapping just declares "this is the full Sanity shape for this state."

### What the converters look like

The converters in `board-sanity-bridge` are pure functions. Here's a sketch:

```ts
// packages/board-sanity-bridge/src/sanity-to-config.ts
import type { Board, Note, BoardImage } from 'board-core'

export function sanityToConfig(
  raw: any,
  refDocs: Map<string, Record<string, unknown>>,
): Board {
  return {
    title: raw.title ?? '',
    notes: (raw.notes ?? []).map(toNote),
    images: (raw.images ?? []).map((slot: any) => {
      const refKey = slot?._ref ? `img-${slot._ref}` : null
      const doc = refKey ? refDocs.get(refKey) : null
      // doc may be undefined if the ref bridge hasn't loaded yet; the Room
      // defers calling this method until all refs are loaded (see §6).
      return toBoardImage(slot._ref, doc)
    }),
  }
}
function toNote(n: any): Note {
  return { _key: n._key, text: n.text ?? '', x: n.x ?? 0, y: n.y ?? 0, color: n.color ?? '#fff' }
}
function toBoardImage(id: string, doc: any): BoardImage {
  return {
    _id: id,
    caption: doc?.caption ?? '',
    tint:    doc?.tint    ?? '',
    asset:   doc?.asset   ?? { _ref: '', url: '' },
  }
}
```

```ts
// packages/board-sanity-bridge/src/config-to-sanity.ts
import type { Board } from 'board-core'

export function configToSanity(state: Board): {
  board: Record<string, unknown>           // Shape A for the main doc
  imageDocs: Array<{ _id: string } & Record<string, unknown>>  // ref doc payloads
} {
  const imageDocs = state.images.map((img) => ({
    _id: img._id,
    caption: img.caption,
    tint: img.tint,
    asset: img.asset,
  }))

  const board = {
    title: state.title,
    notes: state.notes.map((n) => ({
      _key: n._key,
      _type: 'note',
      text: n.text, x: n.x, y: n.y, color: n.color,
    })),
    images: state.images.map((img, i) => ({
      _key: `r${i}`,
      _type: 'reference',
      _ref: img._id,
      _weak: true,
      _strengthenOnPublish: { type: 'boardImage' },
    })),
  }

  return { board, imageDocs }
}
```

These converters are the *only* place that knows the mapping between the Sanity shape and the domain shape. If you need to fetch the same data from a public read endpoint, write a GROQ query that returns the dereferenced shape and reuse the same `sanityToConfig` (passing in a Map you build from the GROQ result). That's how the morphing‑clock public viewer works.

---

## 5. Server wiring

Three files. That's it.

### 5.1 The room manager (server‑side)

```ts
// apps/server/src/rooms/room-manager.ts
import { createSanityInstance, type SanityInstance } from '@sanity/sdk'
import { RoomManager, type SanityResource } from 'sanity-rooms/server'
import { WsServerTransport } from 'sanity-rooms/transport/ws-server'
import { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { boardMapping } from './board-mapping'
import { BoardRoom } from './board-room'
import { sanityClient } from '../sanity'
import { verifySessionToken, type SessionUser } from '../auth'

const BOARD_ID_RE = /^[A-Za-z0-9_-]{4,32}$/

export class BoardRoomManager {
  private syncManager: RoomManager
  private rooms = new Map<string, BoardRoom>()
  private wss = new WebSocketServer({ noServer: true })

  constructor(instance: SanityInstance, resource: SanityResource) {
    this.syncManager = new RoomManager({
      instance, resource,
      factory: {
        async create(roomId, context) {
          const user = context as SessionUser
          if (!BOARD_ID_RE.test(roomId)) return null

          // Ownership check via Sanity. Always query 'drafts' perspective
          // because a brand-new board may not be published yet.
          const doc = await sanityClient.fetch<{ _id: string; owner?: { _ref: string } } | null>(
            `*[_type == "board" && shortId == $shortId][0]{ _id, owner }`,
            { shortId: roomId },
            { perspective: 'drafts' as any },
          )
          if (!doc || doc.owner?._ref !== user.id) return null

          return {
            documents: {
              // 'config' is just a key — name it whatever your client expects.
              // The clock app calls it 'config' too.
              config: { docId: doc._id, mapping: boardMapping },
            },
          }
        },
      },
    })
  }

  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? '', `http://${req.headers.host}`)
    const m   = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{4,32})$/)
    if (!m) return socket.destroy()
    const shortId = m[1]

    // Cookie-based session OR ?token=… (for embeds that can't send cookies).
    const tokenFromCookie = (req.headers.cookie ?? '').match(/(?:^|;\s*)session=([^;]+)/)?.[1]
    const token = url.searchParams.get('token') ?? tokenFromCookie ?? null
    const user  = token ? await verifySessionToken(token) : null
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return socket.destroy()
    }

    const boardRoom = await this.getOrCreateBoardRoom(shortId, user)
    if (!boardRoom) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      return socket.destroy()
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
      const transport = new WsServerTransport(crypto.randomUUID(), ws)
      boardRoom.addClient(transport)
    })
  }

  async getOrCreateBoardRoom(shortId: string, user: SessionUser) {
    const existing = this.rooms.get(shortId)
    if (existing) return existing.ownerId === user.id ? existing : null

    const room = await this.syncManager.getOrCreate(shortId, user)
    if (!room) return null

    const boardRoom = new BoardRoom(room, shortId, user.id)
    this.rooms.set(shortId, boardRoom)

    // CRITICAL: register an additional onDispose. RoomManager already registers
    // its own; both must run when the room dies, otherwise the next connection
    // gets a dead room (this was a real bug in clock — see rooms/CLAUDE.md).
    room.onDispose(() => { this.rooms.delete(shortId) })

    return boardRoom
  }
}
```

### 5.2 The room wrapper (`BoardRoom`)

`Room` is generic — it sync state, broadcasts, manages refs, publishes. Anything app‑specific lives in a thin wrapper. For the Mood Board we'll add two app channels: `publish` and `presence`.

```ts
// apps/server/src/rooms/board-room.ts
import type { Room } from 'sanity-rooms/server'

export class BoardRoom {
  publishing = false
  // Mutation counter used to detect "did edits sneak in during a publish?"
  private dirtyCounter = 0
  private publishedAtCounter = 0

  constructor(
    private readonly room: Room,
    public readonly shortId: string,
    public readonly ownerId: string,
  ) {
    // Bump dirty counter on every mutation, broadcast a small status message.
    this.room.onMutation((docKey) => {
      if (docKey !== 'config') return
      this.dirtyCounter++
      this.room.broadcastApp('publish', {
        type: 'publish-status',
        hasUnpublishedChanges: this.dirtyCounter > this.publishedAtCounter,
      })
    })

    this.room.registerAppChannel('publish', {
      onMessage: async (clientId, payload) => {
        const msg = payload as { type: string }
        if (msg.type !== 'publish-request') return
        if (this.publishing) return       // simple debounce
        this.publishing = true
        const counter = this.dirtyCounter
        this.room.broadcastApp('publish', { type: 'publish-started' })
        const result = await this.room.publish('config')
        this.publishing = false
        if (result.success) {
          this.publishedAtCounter = counter
          this.room.broadcastApp('publish', {
            type: 'publish-success',
            hasUnpublishedChanges: this.dirtyCounter > counter,
          })
        } else {
          this.room.broadcastApp('publish', { type: 'publish-failed', error: result.error })
        }
      },
      onClientJoin: (clientId) => {
        // Send fresh publish-status so newly-connected clients know where we are.
        this.room.sendApp(clientId, 'publish', {
          type: 'publish-status',
          hasUnpublishedChanges: this.dirtyCounter > this.publishedAtCounter,
        })
      },
    })

    // Presence is fire-and-forget: just rebroadcast every payload to peers.
    // No persistence, no Sanity write.
    this.room.registerAppChannel('presence', {
      onMessage: (clientId, payload) => {
        this.room.broadcastApp('presence', { from: clientId, ...(payload as object) }, clientId)
      },
    })
  }

  addClient(t: any) { return this.room.addClient(t) }
  dispose()         { return this.room.dispose() }
}
```

App channels are how you keep the package clean while still doing app‑specific things. Anything that isn't "edit a Sanity doc" — chat streaming, presence cursors, publish, undo broadcasts — should be a channel. The package neither knows nor cares what the payloads are.

### 5.3 The HTTP server

```ts
// apps/server/src/app.ts
import { createServer } from 'node:http'
import { Hono } from 'hono'
import { boardRoutes } from './routes/boards'
import { authRoutes }  from './routes/auth'
import { BoardRoomManager } from './rooms/room-manager'
import { sanityInstance, sanityResource } from './sanity'

const app = new Hono()
app.route('/api', boardRoutes)
app.route('/api/auth', authRoutes)

const server = createServer(/* hono adapter */)
const rooms  = new BoardRoomManager(sanityInstance, sanityResource)

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws/')) rooms.handleUpgrade(req, socket, head)
  else socket.destroy()
})

server.listen(3000)
```

That is the entire server‑side surface area for sync. The REST routes you'll need (`POST /boards`, `DELETE /boards/:id`, `POST /boards/:id/upload-image`, OAuth callbacks) are *not* part of the sync layer — they're the orthogonal "stuff that doesn't belong in a room" concerns.

---

## 6. Client wiring

The frontend has two pieces: a transport, and a hook.

### 6.1 The hook

```ts
// apps/web/src/useBoardSync.ts
import { useEffect, useRef, useState } from 'react'
import { SyncClient, type Mutation } from 'sanity-rooms/client'
import { WsClientTransport } from 'sanity-rooms/transport/ws-client'
import { immutableReconcile } from 'sanity-rooms'
import type { Board } from 'board-core'

export function useBoardSync(boardId: string | null) {
  const [board,  setBoard]  = useState<Board | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting')
  const clientRef = useRef<SyncClient | null>(null)

  useEffect(() => {
    if (!boardId) return

    const url       = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${boardId}`
    const transport = new WsClientTransport(url)

    const client = new SyncClient({
      transport,
      documents: {
        config: {
          // No initialState — hydrate from the server's first state message.
          applyMutation: (state, mutation: Mutation) => {
            if (mutation.kind === 'replace') return mutation.state
            if (mutation.kind === 'merge')   return { ...(state as object), ...mutation.partial }
            return null
          },
          reconcile: immutableReconcile,    // preserves object identity for React
        },
      },
      sendDebounce: { ms: 500, maxWaitMs: 1000 },
    })
    clientRef.current = client

    client.subscribeDoc('config', () => {
      if (!client.isDocHydrated('config')) return
      setBoard(client.getDocState<Board>('config'))
    })

    client.onStatus((s) => setStatus(s === 'connected' ? 'connected' : 'reconnecting'))

    return () => {
      clientRef.current = null
      client.dispose()
    }
  }, [boardId])

  // The mutation entry point. The UI calls this with the WHOLE next state.
  // SyncClient handles diffing and debouncing.
  const setNextBoard = (next: Board) => {
    clientRef.current?.mutate('config', { kind: 'replace', state: next })
  }

  // App-channel helpers. Same shape for chat, presence, publish, etc.
  const requestPublish = () => clientRef.current?.sendApp('publish', { type: 'publish-request' })
  const sendPresence   = (cursor: { x: number; y: number }) =>
    clientRef.current?.sendApp('presence', { type: 'cursor', cursor })

  return { board, status, setNextBoard, requestPublish, sendPresence, clientRef }
}
```

That's the entire client integration. ~30 meaningful lines.

### 6.2 The editor

```tsx
// apps/web/src/BoardEditor.tsx
import { useBoardSync } from './useBoardSync'
import type { Board, Note } from 'board-core'

export function BoardEditor({ boardId }: { boardId: string }) {
  const { board, status, setNextBoard, requestPublish } = useBoardSync(boardId)

  if (!board) return <div>{status === 'connected' ? 'Loading...' : 'Connecting...'}</div>

  const moveNote = (key: string, x: number, y: number) => {
    setNextBoard({
      ...board,
      notes: board.notes.map((n) => (n._key === key ? { ...n, x, y } : n)),
    })
  }

  const addNote = (text: string) => {
    setNextBoard({
      ...board,
      notes: [...board.notes, { _key: crypto.randomUUID(), text, x: 0, y: 0, color: '#fff' }],
    })
  }

  return (
    <div>
      <header>
        <h1>{board.title}</h1>
        <span data-status={status}>{status}</span>
        <button onClick={requestPublish}>Publish</button>
      </header>

      {board.notes.map((n) => (
        <Sticky key={n._key} note={n}
                onMove={(x, y) => moveNote(n._key, x, y)} />
      ))}

      {board.images.map((img) => (
        <img key={img._id} src={img.asset.url} alt={img.caption} />
      ))}
    </div>
  )
}
```

Two things to notice:

- The **only place writes happen** is inside `setNextBoard`, which is a thin wrapper around `client.mutate('config', { kind: 'replace', state: nextBoard })`. There's no fetch, no `axios.patch`, no `sanityClient.patch`. The server is the only thing allowed to talk to Sanity.
- The UI passes the **entire next board** every time, even for a one‑pixel move. SyncClient diffs at flush time and only sends the changed fields over the wire. This is what "diff‑at‑flush" means and it is the single most important sync property — see §8 for why.

---

## 7. Image uploads — the only place REST is involved

Image data can't fit in a JSON WebSocket message and shouldn't anyway — Sanity has a proper asset pipeline. So uploads work like this:

1. The client picks a file and POSTs it to a regular HTTP endpoint that proxies to Sanity's asset upload API.
2. The endpoint returns the asset reference (`{ _ref: "image-abc123" }`) plus a CDN URL.
3. The client builds a new `BoardImage` object using that reference and calls `setNextBoard({ ...board, images: [...board.images, newImage] })`.
4. The mutation flows through the normal WS path. The mapping's `toSanityPatch` produces a new `boardImage` ref doc *and* a board edit. Both write atomically.

```ts
// apps/server/src/routes/boards.ts (relevant route)
boardRoutes.post('/:id/upload-image', requireAuth, requireOwnership, async (c) => {
  const formFile = (await c.req.formData()).get('file') as File
  const buffer   = Buffer.from(await formFile.arrayBuffer())
  const asset    = await sanityClient.assets.upload('image', buffer, {
    filename: formFile.name,
    contentType: formFile.type,
  })
  return c.json({
    asset: { _ref: asset._id, url: asset.url },
  })
})
```

```ts
// apps/web/src/upload.ts
export async function uploadImage(boardId: string, file: File) {
  const fd = new FormData(); fd.set('file', file)
  const res = await fetch(`/api/boards/${boardId}/upload-image`, { method: 'POST', body: fd })
  return (await res.json()) as { asset: { _ref: string; url: string } }
}

// usage in the component:
async function attachImage(file: File) {
  const { asset } = await uploadImage(boardId, file)
  setNextBoard({
    ...board,
    images: [
      ...board.images,
      {
        _id: crypto.randomUUID(),     // we choose the boardImage doc ID client-side
        caption: '', tint: '',
        asset,
      },
    ],
  })
}
```

When this `setNextBoard` flushes, here's what happens server‑side:

- `applyMutation('replace', nextBoard)` updates the in‑memory state.
- `toSanityPatch(nextBoard)` returns `{ patch: <board shape>, refPatches: { 'img-<newId>': <imageDoc shape> } }`.
- `Room.buildRefDocWrites` matches `'img-<newId>'` against `resolveRefs(patch)` to find the docId + documentType.
- `SanityBridge.write` issues a single `applyDocumentActions` call containing:
  - `createDocument(boardImage <newId>)` (because the bridge has never seen this ID — first write *creates* the doc)
  - `editDocument(boardImage <newId>, { set: <imageDoc shape> })`
  - `editDocument(board <existing>, { set: <board shape> })`
  - all under the same `transactionId`.

The board now has a weak ref pointing at a brand‑new draft `boardImage`. Both are drafts. The publish flow (§9) is what makes them live.

> **Common mistake:** trying to do all of this through HTTP — upload, then `PATCH /boards/:id` to attach. If you do that, the WS room either has stale state or you have to write extra plumbing to invalidate it. Use the WS for *every* edit. The HTTP endpoint exists only because file bytes don't go through JSON.

---

## 8. The mutation flow, end to end

Trace one drag of a sticky note, all the way through. This is the canonical example.

```
User drags note n1 from (120,80) to (240,160)
  │
  │  React onPointerMove event
  ▼
moveNote('n1', 240, 160)                             [BoardEditor.tsx]
  │
  ▼
setNextBoard({ ...board, notes: board.notes.map(...) })
  │
  ▼
client.mutate('config', { kind: 'replace', state: nextBoard })
  │  [SyncClient]
  │    docs.config.localState = nextBoard         (optimistic; React re-renders now)
  │    docs.config.dirty       = true
  │    listeners fire
  │    scheduleFlusher(500ms / 1000ms)
  │
  ▼  (debounce window: many drag events coalesce)
  │
flush() at t+500ms (or earlier if maxWait hit)
  │  diffValue(lastSentState, localState)
  │    → [{ patch: { id: 'drafts.board-abc',
  │                  set: { 'notes[_key=="n1"].x': 240,
  │                         'notes[_key=="n1"].y': 160 } } }]
  │  build mutationId 'm_42_<ts>'
  │  transport.send({ channel: 'doc:config', type: 'mutate', mutationId,
  │                   mutation: { kind: 'sanityPatch', operations: [...] } })
  │  lastSentState = localState
  │  dirty = false
  │
  ▼  WebSocket frame to /ws/board-abc
  │
Server receives                                     [Room.handleClientMsg]
  │  parseChannel('doc:config') → { type: 'doc', id: 'config' }
  │  msg.mutation.kind === 'sanityPatch'
  │    → applySanityPatches(doc.state, ops) using @sanity/mutator
  │  doc.state = newState
  │
  │  txnId = randomUUID()
  │  recordOwnTxn(doc, txnId)         (so we ignore the SDK echo of THIS write)
  │  toSanityPatch(newState) → { patch, refPatches? }
  │  buildRefDocWrites(...)
  │  bridge.write(patch, refDocs, txnId)
  │
  │  broadcastExcept(senderClientId, { type: 'state', state: newState })
  │  sendTo(senderClientId,         { type: 'ack',   mutationId })
  │
  ▼
SanityBridge.write
  │  actions = [
  │    editDocument(board <id>, { set: patch })
  │  ]
  │  applyDocumentActions(instance, { actions, transactionId: txnId })
  │
  ▼
@sanity/sdk → Content Lake → emits new doc with _rev = txnId
  │
  ▼
SanityBridge subscription fires onChange(rawDoc)
  │  Room.handleSanityChange('config', rawDoc)
  │    rawDoc._rev === txnId → SKIP (it's our own echo)
```

Now the same drag from a *second* user's perspective (someone else has the same board open):

```
That client receives a 'state' message on doc:config
  │  serverState = received
  │  Is dirty? (Did this user have unsent local edits?)
  │    No  → localState = received; React re-renders.
  │    Yes → diff(lastSentState, localState) = our pending edits
  │           localState = applySanityPatches(received, ourEdits)
  │           That is: our optimistic edits get RE-APPLIED on top of the
  │           fresh server state. We see the other user's note move
  │           AND our own in-progress drag, both correctly placed.
  │  Listeners fire → setBoard → React renders.
```

That last step is the *whole reason* this package exists. With dumb "client owns truth" approaches, two simultaneous editors would clobber each other. With "server owns truth, no optimism," every drag would feel laggy. With diff‑at‑flush + rebase, you get instant local feedback *and* convergence under contention.

### What happens when an AI tool writes the doc

The morphing‑clock app has an AI that calls tools like `addFrame`. Those run *server‑side*, inside the room:

```ts
// inside the AI tool runner, server-side
room.mutateDoc('config', { kind: 'named', name: 'addNote', input: { text: 'idea!' } })
```

`Room.mutateDoc` does the exact same thing as a client `mutate`: applies, writes, broadcasts. Every connected client receives a `state` message and rebases their local edits on top. The user's in‑flight drag does not get clobbered.

---

## 9. Publishing & weak refs

Publishing makes a draft live (visible at the published perspective for non‑authenticated read endpoints). The contract:

- All edits go to **drafts only** — `editDocument` always targets `drafts.<id>`.
- Refs from a draft to a draft are illegal *unless* they're weak. So the converters set `_weak: true` on every `images[]` entry and record `_strengthenOnPublish: { type: 'boardImage' }` so Sanity automatically removes those flags when the published doc lands.
- `Room.publish('config')` publishes ref docs first so their published versions exist by the time the main doc publishes — otherwise strengthening would fail.
- `Room.publish` checks each ref bridge's `hasDraft()` (does a `drafts.<id>` row exist right now?) and skips ones with nothing to publish, which can happen if a ref hasn't been edited since the last publish. Real Sanity throws "no draft version was found" if you try to publish a doc with no draft, which would abort the whole transaction.

The flow:

```
Client → sendApp('publish', { type: 'publish-request' })
  ▼
BoardRoom 'publish' handler
  ▼
Room.publish('config')
  ├─ for each ref bridge in refBridges.config.values():
  │     if (refBridge.hasDraft()) actions.push(publishDocument(handle))
  ├─ if (mainBridge.hasDraft())   actions.push(publishDocument(mainHandle))
  ├─ applyDocumentActions(instance, { actions })
  └─ result.submitted()                         ← await server confirmation
  ▼
BoardRoom broadcasts publish-success / publish-failed
```

After a successful publish, ref docs are strong (`_weak: true` + `_strengthenOnPublish` removed) and the main doc points at the published `boardImage` IDs. A REST endpoint that fetches `perspective: 'published'` will see a fully consistent published board.

The dirty tracker (`Room.onMutation`) lets you tell the user "you have unpublished changes." It fires on *every* mutation — own writes, peer writes, AI tool writes — so the tracker is global and accurate.

---

## 10. Drafts, published, and assets — the lifecycle nobody explains

Sanity has a two-version model that is mostly invisible until it isn't, and the asset pipeline is a *third* concept that often gets conflated with the first two. Get this picture right once and a lot of confusing behavior stops being confusing.

### 10.1 Two versions per doc, never both

For any document `X`, Sanity may have:

- A **draft** at `drafts.X` — editable, mutable, only visible to authenticated readers.
- A **published** version at `X` — immutable until the next publish, visible to everyone with `perspective: 'published'`.

Both can exist simultaneously (you've published, then started editing again). Or only one — a brand-new doc has only a draft; a published doc that nobody has touched since has no draft.

`@sanity/sdk`'s `getDocumentState` observable always emits **whichever currently exists, preferring the draft**. Your `SanityBridge` therefore sees:

| State of doc | What `bridge.rawDoc._id` looks like | `bridge.hasDraft()` |
|---|---|---|
| Brand-new, never published | `drafts.X` | `true` |
| Published, no current draft | `X` | `false` |
| Published, with edits in flight | `drafts.X` | `true` |

**The room always shows the draft** (or the published, when no draft exists). The user editing the board is *always* editing the draft. Public viewers (unauthenticated, `perspective: 'published'`) see the last published snapshot, which is some prior point in time.

> Practical consequence: don't show the user a "live preview" that uses your public-viewer code path. The viewer reads the published version; the editor reads the draft. They can be wildly out of sync until publish. Either render the draft directly (use the `Board` from `useBoardSync`) or be explicit that the preview shows "what will be public after you publish."

### 10.2 What `Room.publish` actually does

`Room.publish('config')` is just a Sanity transaction containing one or more `publishDocument` actions. Three subtle behaviors:

1. **Empty publish is success.** If there's no draft (`bridge.hasDraft()` returns false everywhere — main + all refs), `Room.publish` returns `{ success: true }` without issuing any actions. The published state already matches what the user wants. *Don't* show a "Published!" toast unconditionally on success — check whether anything actually changed.

2. **Refs publish first, in the same transaction.** If you have ten `boardImage` refs and only two have drafts, only those two get a `publishDocument` action. Refs without drafts are silently skipped — without that guard, the real SDK throws `"no draft version was found"` and **aborts the whole transaction**, including the main doc's publish.

3. **Edits during a publish are not blocked.** A user can keep editing while `room.publish` is awaiting `result.submitted()`. The dirty counter keeps advancing. `BoardRoom` in §5.2 captures the dirty counter *before* publish and compares after — if it's still increasing when the publish finishes, `hasUnpublishedChanges` stays true. Don't lock the UI during publish; just show a spinner.

### 10.3 Discarding drafts and unpublishing

`Room` exposes neither. If you need them:

- **Discard draft** — call `discardVersion` from `@sanity/sdk` directly, then nudge the room (it'll re-emit and broadcast). This is destructive across all editors; gate it behind a confirmation.
- **Unpublish** — call `unpublishDocument` directly. Same caveat. After unpublish, the public viewer will 404. Decide whether to also clean up `boardImage` refs (they keep their published versions until separately unpublished).

If multiple users are connected when you discard or unpublish, the room broadcasts the resulting state via the normal SDK observable. There's no special "your work was just thrown away" message — design the UI so that doesn't surprise people.

### 10.4 Image assets are a third thing

Three distinct Sanity concepts get conflated:

| Thing | Document type | Lifecycle | Where it lives |
|---|---|---|---|
| **Image asset** | `sanity.imageAsset` (built-in) | Created on upload. Immutable. Deduplicated by hash. Shared across the project. | Sanity CDN |
| **Image *field*** | inline value `{ _type: 'image', asset: { _ref: 'image-…' }, hotspot, crop }` | Lives inside another doc; editable as part of that doc | Whatever doc field holds it |
| **Image-bearing custom doc** | `boardImage` (yours) | Created by your code. Editable. Refs an image asset via an image field. | A document, referenced from the board |

In our example, `boardImage.asset` is the *image field* (concept 2), which contains a reference to an *image asset* (concept 1), and the whole `boardImage` doc (concept 3) is referenced from `board.images[]`. Three layers, each with its own ID space:

```
board (your doc)
  └─ images[]
      └─ ref → boardImage (your doc, type 3)
          └─ asset (image field, type 2)
              └─ asset._ref → "image-abc123-200x200-png"  (asset, type 1)
```

Why structure it this way instead of jamming the image field directly on the board?
- **Sharing** — two boards can ref the same `boardImage` and edits to its caption affect both.
- **Studio-editable metadata** — the `boardImage` doc can have its own permissions, validation, custom previews.
- **Smaller patches** — editing one caption diffs one ref doc, not the whole board.

If you don't need any of those, you *can* put an image field directly on the board: `defineField({ name: 'cover', type: 'image' })`. Then the asset ref lives on the board itself; no second document; no `resolveRefs` needed for it. Use whichever fits — the Mood Board picks the ref-doc structure because that's what the morphing-clock domain does and what this package's machinery is designed around.

### 10.5 Assets are never garbage-collected

Removing an image from `board.images[]` does **not** delete the underlying `boardImage` document. Removing the `boardImage` document does **not** delete the underlying asset. Sanity's asset pipeline keeps every uploaded asset forever unless something explicitly deletes it.

This is by design (deduplication + sharing) but it's a footgun for storage costs and data hygiene. If you care:

- Periodic GC job: GROQ-query for `boardImage` docs not referenced by any `board`, delete them; then GROQ-query for asset IDs not referenced by any doc, delete them. Run weekly.
- Or: use Sanity's asset usage API (`/v1/assets/<projectId>/<dataset>?usage=true`) and only delete assets with `references: 0`.
- Or: ignore it and pay the storage. For most apps, image storage is a rounding error.

The package gives you nothing here — asset lifecycle is outside the room's concerns.

### 10.6 Image upload races and rollback

The upload flow in §7 has two non-atomic steps: (1) HTTP upload returns an asset ref; (2) WS mutation attaches it to the board. If step 1 succeeds but step 2 never happens (user closes tab, network dies, validation fails), you've created an orphan asset *and* an orphan `boardImage` if your endpoint pre-creates one.

Two designs work, pick one and stick with it:

- **Lazy doc creation (recommended for our example).** The HTTP endpoint uploads only the asset and returns the bare asset ref. The `boardImage` doc only gets created when the user's WS mutation flushes (because `toSanityPatch` produces the new ref doc + board edit atomically). Orphans are limited to the asset itself, which the GC job cleans up.
- **Eager doc creation.** The HTTP endpoint uploads the asset *and* creates the `boardImage` doc, returning the doc ID. Faster perceived response (the image shows up before the WS round-trip), but you have to handle the abandonment case explicitly.

Either way, do not roll your own "attach via REST" path — the WS attach is what keeps the room consistent.

### 10.7 The published-perspective public viewer is a separate code path

The room serves the editor (drafts). The public viewer serves anonymous readers (published). They share *converters* (`sanityToConfig`) but not the runtime — the public viewer is typically a plain HTTP route doing a GROQ fetch with `perspective: 'published'`, dereferencing refs in the query:

```ts
// apps/server/src/routes/boards.ts
boardRoutes.get('/:shortId', async (c) => {
  const doc = await sanityClient.fetch(`
    *[_type == "board" && shortId == $s][0]{
      ...,
      "images": images[]->{ _id, caption, tint, asset }
    }
  `, { s: c.req.param('shortId') }, { perspective: 'published' as any })
  if (!doc) return c.notFound()
  // Build the same Map<refKey, refDoc> shape resolveRefs would produce,
  // then run sanityToConfig — same converter as the room uses.
  const refDocs = new Map(doc.images.map((img: any) => [`img-${img._id}`, img]))
  return c.json(sanityToConfig({ ...doc, images: doc.images.map((i: any) => ({ _ref: i._id })) }, refDocs))
})
```

Two reasons to keep `sanityToConfig` as the single converter for both paths: schema changes only land in one place, and the editor preview matches the published viewer pixel-for-pixel.

---

## 11. Subtle gotchas (the rest of the bear traps)

These are things you can't reason about from the README and that the test suite doesn't cover. Most of them have bitten morphing-clock at some point.

### 11.1 The package is single-server. Horizontal scaling needs a plan.

A `Room` lives in one Node process. If you run two server instances behind a load balancer, you'll have **two rooms for the same board**, each holding its own truth, each writing to Sanity separately. They'll see each other's writes via the SDK observable (no matching txnId → broadcast as external) but the broadcasts are *redundant* — every write fans out twice — and clients see momentary inconsistencies as the two rooms reconcile through Sanity.

Three options when you outgrow one process:

- **Sticky sessions** by `shortId` (load balancer routes all WS for a board to the same process). Easiest if your infra supports it.
- **Pub/sub fan-out** (Redis, NATS) so all server processes share the broadcast channel and converge on a single writer per room. Requires custom code; not provided.
- **Use Sanity's own real-time as the bus** — drop your broadcast, let every server simply write to Sanity and let every client subscribe via the SDK directly. Slower (each broadcast becomes a Sanity round-trip) but correct.

Until you're at >1000 concurrent rooms or >50 collaborators per room, single-server with vertical scaling and quick failover is fine.

### 11.2 The doc must already exist for the factory to succeed

`Room` subscribes to a Sanity doc the moment it's created. If the doc doesn't exist, `getDocumentState` never emits and `room.ready` hangs until `readyTimeoutMs` (default 15s), then `RoomManager` rejects with `null`.

Two fixes:

- Pre-create the doc in your "create board" REST endpoint — the user clicks "New board," your handler runs `sanityClient.create({ _type: 'board', shortId, owner: ... })`, *then* redirects to the editor.
- Or, in the factory, call `createIfNotExists` before returning the `RoomConfig`. Slower (extra round-trip per first connection) but lazier.

The morphing-clock takes the first approach — the message doc is created HTTP-side before the editor opens.

### 11.3 Studio editing the same doc can silently drop fields

If a user opens Sanity Studio AND your editor at the same time, Studio writes raw Sanity shapes through its own SDK. The room sees those writes as external (no matching txnId), runs them through `mapping.fromSanityWithRefs`, broadcasts the resulting state.

Then on the next user edit, your `mapping.toSanityPatch` reserializes only the fields the converter knows about. **Anything Studio wrote that your converter doesn't read is silently dropped on the next write.** This is real data loss, and it's silent.

Three ways to avoid it:

- **Round-trip-safe converters.** `fromSanity(toSanityPatch(state).patch)` should equal `state`, and the reverse should preserve unknown fields by passing them through. Test this with a property-based test.
- **Lock Studio out of editing this doc type** — set `__experimental_actions: ['publish']` or hide the doc from Studio's structure menu. Use Studio for asset management only.
- **Schema versioning** — every doc carries a `schemaVersion` field; refuse to load older or newer ones in the editor; gate Studio writes through a Sanity action that bumps the version. Heavyweight; only do it if the data really matters.

For most apps option 2 is cleanest. The morphing-clock relies on a mix of 1 and "users who edit in Studio are advanced and accept the risk."

### 11.4 Converters must round-trip, or every external change re-broadcasts

If `fromSanity(toSanityPatch(state).patch)` ≠ `state`, then every time Sanity emits a change, `Room.handleSanityChange` will produce a domain state that differs from the current state, `immutableReconcile` won't preserve identity, and **every connected client gets a state broadcast for no real change**.

In the worst case, this can become a feedback loop: client edits → server applies → server writes to Sanity → SDK emits → server maps → state differs → server broadcasts → client rebases → client edits again. Usually the diff is empty and the loop dies, but bad converters can produce non-empty diffs forever.

Test it: take a representative `Board`, push it through `toSanityPatch` then `fromSanity(WithRefs)`, assert deep equality. If it fails, fix the converter — don't paper over with reconciliation tweaks.

### 11.5 Echo suppression has a 60-second window

`Room.recordOwnTxn` keeps each write's `transactionId` in `ownTxns: Map<string, number>`, pruning entries older than 60s when the map exceeds 50 entries (`packages/sanity-rooms/src/server/room.ts:351-362`). This is comfortably above the SDK's ~1s write throttle, so in practice you'll never lose a txn.

But in pathological cases — a network stall that blocks the SDK observable for over a minute, then a flood of buffered emits — an echo with `_rev` matching a *pruned* txn will be treated as external and re-broadcast. Clients would then see the change twice.

Mitigations:
- Don't bump the prune threshold past 60s in app code (you'd just delay the bug).
- If you suspect this in production, log every `handleSanityChange` and watch for `_rev`s that match recent writes you can correlate. The fix is usually upstream — find what's stalling the SDK.

### 11.6 JWT expiry causes silent reconnect failure

Browser `WebSocket` does not expose HTTP status codes from the upgrade response. If the upgrade rejects with 401 (expired session), `onclose` fires with no useful info, and `WsClientTransport.scheduleReconnect` tries again — and gets 401 again, forever.

The morphing-clock works around this with an HTTP ownership check on page load (`apps/clock/src/CLAUDE.md` notes this explicitly). Pattern:

- HTTP `GET /api/auth/session` on app start → if expired, redirect to login *before* opening the WS.
- After session refresh, allow the WS to reconnect.
- In the UI, surface "reconnecting…" if the transport stays disconnected for more than ~5s, with a "log in again" affordance.

There's no clean fix at the transport layer; this is browser API limitation.

### 11.7 Don't put high-frequency state in the synced doc

The 500ms debounce + diff-at-flush is great for editor state but bad for cursor position broadcasts at 60fps. If you put presence cursors in `Board`, every cursor twitch becomes a Sanity write. Storage costs aside, your room broadcasts will saturate.

Use an **app channel** (§5.2) for presence. App messages bypass the debouncer, are not persisted, and don't go through Sanity at all. The clock uses one for AI chat streaming for the same reason.

Anything that should survive a refresh → in the doc. Anything that's purely "current session, this user" → app channel.

### 11.8 `getDocState` throws before hydration

A common React mistake: derive state from `client.getDocState('config')` outside an effect, before `client.ready` resolves. The call throws `"Document … not hydrated — await client.ready"`, the component crashes, and the user sees a blank screen.

Always gate via `isDocHydrated('config')` inside `subscribeDoc`, or by checking the `board` from `useBoardSync` for `null` (see the hook in §6.1). The hook intentionally returns `null` until hydration to make this hard to get wrong.

### 11.9 Reconnect drops unsent local edits — by design

When the WS reconnects, the client takes the server state as authoritative and discards `lastSentState`, the dirty flag, and the named-mutation queue. Edits made *while disconnected* are lost.

This is correct: the client doesn't know whether unsent edits made it before the disconnect (so re-sending could double-apply) or were lost (so dropping them loses work). The library picks "lose them" because double-application is silent and dropping is at least visible.

If your app needs offline editing, build it on top:
- Persist `client.getDocState('config')` to IndexedDB on every change (debounced).
- On reconnect, compare local persisted state to fresh server state; if they diverge, prompt the user to resolve.
- `client.hasPendingWrites()` lets you show a "you have unsaved changes" warning while disconnected.

The morphing-clock does not do offline editing. It shows "Reconnecting…" and accepts that mid-disconnect edits are best-effort.

### 11.10 Don't write Sanity from outside the room while the room is live

Tempting in cron jobs, webhooks, admin tools: "I'll just `sanityClient.patch` to flip a flag." But if a room is open for that doc, the room sees the SDK echo with no matching txnId → treats it as external → broadcasts → clients rebase. That's actually fine *if* your `fromSanityWithRefs` produces a state your `applyMutation` would have produced. But it's brittle: any field your converter doesn't know about gets dropped on the next user edit (§11.3).

Safer pattern: route admin/cron writes through the room when one exists.

```ts
const room = manager.get(shortId)
if (room) room.mutateDoc('config', { kind: 'merge', partial: { archived: true } })
else      await sanityClient.patch(docId).set({ archived: true }).commit()
```

`merge` is the right kind for "set a field, leave everything else alone." `replace` would clobber any in-flight optimistic edits.

### 11.11 The `documentType` + draft-prefix interaction

`createDocumentHandle` takes a bare doc ID and a documentType. The SDK manages `drafts.` prefixes internally — you never write `drafts.X` in your code. But the bridge stores `docId` *without* the prefix and strips it on input (`packages/sanity-rooms/src/server/sanity-bridge.ts:58`). If you bypass the bridge and write to Sanity yourself, remember to use bare IDs everywhere.

The `markRefDocKnown` / `knownRefDocs` set also strips the prefix on both sides — without that fix, the second write of an existing ref doc would call `createDocument` again and get `"draft already exists"`, aborting the whole transaction. Don't reach into bridge internals.

### 11.12 `Room.onDispose` and `Room.onMutation` are additive

Both are *lists* of listeners, not single callbacks. The library registers its own listeners (e.g. `RoomManager` registers an `onDispose` that removes the room from its map). If your app registers a listener that *replaces* the slot instead of appending, the library's cleanup never runs and the next connection gets a dead room.

Always *call* `room.onDispose(cb)`. Never reach into the room's internal listener arrays.

The clock had this exact bug and the fix is documented in `apps/server/src/rooms/CLAUDE.md` ("Room reclaim data loss").

### 11.13 First-time `createDocument` only happens once per bridge lifetime

The bridge's `knownRefDocs` set tracks which ref docs have been created in *this process's lifetime*. If the server restarts and a client immediately writes a ref that was created in a previous process, the bridge will issue `createDocument` again — which fails with `"draft already exists"`.

The bridge handles this by listening to ref bridges' first emit and calling `markRefDocKnown` on the parent (`packages/sanity-rooms/src/server/room.ts:483`). So the order is: ref bridge subscribes → SDK emits the existing draft → `onChange` fires → parent bridge marks known → next write of that ref skips `createDocument`. This is correct *iff* the ref bridge has had a chance to load before the next write. Since `Room.ready` waits for all initial ref bridges to load, and `updateRefs` adds new bridges synchronously, this is the case in practice.

The edge: if you call `room.mutateDoc` *before* `room.ready` resolves with a state that introduces a new ref doc, the parent doesn't yet know the ref's existence; first write will try `createDocument`. For new-ref-doc-introductions this is correct (the ref is genuinely new). For ref-docs-that-already-exist-in-Sanity-but-we-haven't-subscribed-to-yet, it'll fail. Don't mutate before `ready`.

---

## 12. Multiplayer correctness — the things you must not break

The package guarantees a few invariants. Your code must not break them.

### 12.1 The frontend never bypasses `SyncClient`

Once a room is connected, *every* edit goes through `client.mutate('config', ...)`. No `fetch('/api/boards/x', { method: 'PATCH' })`. No `sanityClient.patch` from the browser. If you do this, the room will eventually emit a `state` message that overwrites your REST edit (or worse, your REST edit will overwrite a peer's in‑flight WS edit because it bypassed the optimistic queue).

### 12.2 The backend never writes Sanity outside `Room`

Same rule, mirrored. Inside a room's lifetime, only `Room.mutateDoc` and `bridge.write` (which the Room calls for you) should write. If you have to write from a cron job or webhook, do it via `room.mutateDoc` if a room exists, or via the Sanity client *only* if you're certain no room is open for that doc. Otherwise echo suppression goes wrong and the room broadcasts your write *back* to itself.

### 12.3 Inline children must have stable `_key`s

Sanity diffing uses `_key` for array identity. If you regenerate `_key` on every render (or omit it), the diff explodes into "remove all + add all" and concurrent edits clobber each other. Always use `crypto.randomUUID()` (or any stable string) once when the child is created and keep it through every render and mutation.

### 12.4 Ref keys are app‑scoped

`resolveRefs` returns `{ key, docId, mapping }`. The `key` is *your* identifier — `Room` uses it to diff which subscriptions to keep, drop, or add when refs change. Two requirements:

- It must be stable (don't compose it from random IDs).
- It must match what `toSanityPatch` puts in `refPatches`.

Use a type prefix (`img-`, `cf-`, `cp-`) so two ref types can never collide on the same Sanity doc ID.

### 12.5 Don't forget `_weak: true` AND `_strengthenOnPublish`

Both. Drop `_weak` and Sanity blocks the publish (drafts can't reference drafts). Drop `_strengthenOnPublish` and the published doc keeps the weak ref forever (silent data‑integrity bug — the next time someone deletes the ref target, the parent doc is left dangling). Set both on every ref entry, every time.

### 12.6 `documentType` MUST match the schema

Each `DocumentMapping.documentType` becomes the `_type` of new docs. The clock used to have a generic `'customAsset'` type that didn't exist in the schema; Studio rejected it and the Agent Actions API blew up. If your schema has `boardImage`, the mapping says `documentType: 'boardImage'`. No abstractions.

---

## 13. Reconnect and HMR

### Reconnect

`WsClientTransport` reconnects automatically with exponential backoff (1s × 1.5ⁿ, capped at 10s). On a successful reconnect:

- The server sends a fresh full `state` message for every doc the client is subscribed to.
- The client sees `_status === 'disconnected'` and goes through the **reconnect branch** of `handleServerMsg`: it discards `lastSentState`, accepts the server state, and clears the dirty flag plus the named‑mutation queue.
- Unsent local edits made while the connection was down are **dropped**. This is intentional — the client has no way to know if those edits made it before the disconnect or not, and rebasing on top of a state from before they were applied would silently re‑apply them as new edits, which is worse.

If you need stronger guarantees (e.g. queue local edits while offline), build it on top: the SyncClient exposes `hasPendingWrites()` so you can show a warning, and you can serialize the local board to `localStorage` if the user actively edits while offline.

### HMR

In dev, the morphing‑clock app loads its server in‑process via Vite's `ssrLoadModule`. When you edit server code, Vite reloads the module — but **the WebSocket connection stays open** (Vite's HMR pipeline doesn't tear down node sockets). The room's `Room` instance survives, the client never sees a disconnect, and the next edit just works.

When you edit *client* code, Vite HMR replaces the React tree but the `useEffect` cleanup runs — `client.dispose()` closes the WS, the new effect creates a new `WsClientTransport` and a new `SyncClient`. The server sees a brief disconnect, the new client hydrates from the room's current state, and editing resumes. You'll see `status` flicker `'connecting' → 'connected'`. Total latency under 200ms in practice.

If you bypass `useDocumentSync` and call `new SyncClient` somewhere with no cleanup, HMR will leak — the old client will stay subscribed. Always create the SyncClient inside an effect with a `dispose()` cleanup.

---

## 14. Testing

The package ships with `sanity-rooms/testing`:

- `createMemoryTransportPair()` returns a `{ client, server }` pair of in‑process `Transport`s. Send a message on one, the other receives it. Zero network. Zero ports.
- `createMockSanity()` returns a fake `SanityInstance` that intercepts `getDocumentState`, `editDocument`, `createDocument`, `publishDocument`, and `applyDocumentActions`. It stores docs in memory, simulates publish (copy draft → published, strip weak markers), and emits the document subject when a write lands.

A typical full‑stack test:

```ts
import { describe, it, expect } from 'vitest'
import { Room } from 'sanity-rooms/server'
import { SyncClient } from 'sanity-rooms/client'
import { createMemoryTransportPair, createMockSanity } from 'sanity-rooms/testing'
import { boardMapping } from '../src/rooms/board-mapping'

it('roundtrips a sticky-note move between two clients', async () => {
  const { instance, resource } = createMockSanity({ docs: [{ _id: 'b1', _type: 'board', title: 'T', notes: [], images: [] }] })
  const room = new Room({ documents: { config: { docId: 'b1', mapping: boardMapping } } }, instance, resource)
  await room.ready

  const a = createMemoryTransportPair(); room.addClient(a.server)
  const b = createMemoryTransportPair(); room.addClient(b.server)

  const clientA = new SyncClient({ transport: a.client, documents: { config: { applyMutation: (s, m) => m.kind === 'replace' ? m.state : null } } })
  const clientB = new SyncClient({ transport: b.client, documents: { config: { applyMutation: (s, m) => m.kind === 'replace' ? m.state : null } } })
  await Promise.all([clientA.ready, clientB.ready])

  clientA.mutate('config', { kind: 'replace', state: {
    title: 'T', notes: [{ _key: 'n1', text: 'hi', x: 10, y: 10, color: '#fff' }], images: [],
  }})
  // … wait for debounce flush + WS round-trip …

  expect(clientB.getDocState<any>('config').notes).toHaveLength(1)
})
```

Use the same pattern for: ref creation (assert that a `boardImage` doc shows up), publish (assert that a published doc exists, with weak markers stripped), and reconnect (close `a.client`, open a new one, assert state hydrates).

The morphing‑clock test suite lives at `packages/sanity-rooms/src/__tests__/` and is the best source of "what does a real test of this look like?" reading material.

---

## 15. Common mistakes (the things the previous agent did)

If you're an AI agent reading this to scaffold a new app, these are the failure modes that come up over and over. Each one ends with a "instead, do this" pointer.

### "I'll just use REST mutations and re‑fetch"

Symptom: every edit is a `PATCH /api/boards/:id` followed by a `GET /api/boards/:id` to refresh.

Why it's wrong: you've thrown away optimism, multi‑user broadcast, debouncing, echo suppression, ref following, and HMR support. You also race against the room — if anyone else has the board open, your REST write gets immediately broadcast back over their WS, and your own client doesn't know whether to trust the WS or the REST response.

Instead: open the WS first. Once the room is live, do *every* edit through `client.mutate('config', { kind: 'replace', state: next })`. The HTTP endpoints are for things that aren't a doc edit — list, create, delete, upload.

### "I'll embed the image bytes / asset in the main doc"

Symptom: the board doc has `images: [{ data: 'data:image/...;base64,...' }]` or `images: [{ asset: { _ref, url } }]` directly inline.

Why it's wrong: you can't share the image between boards, you can't edit per‑image metadata in Studio, and you've made the main doc enormous (every keystroke patches a megabyte of base64). And if someone else creates the same image, you've duplicated the asset.

Instead: each image is its own document type (`boardImage`) with a `reference` from the board. The `DocumentMapping.resolveRefs` and `fromSanityWithRefs` machinery makes them appear as inline data on the frontend even though they're separate Sanity docs.

### "I'll wire WS but skip `SyncClient` and write my own protocol"

Symptom: a custom WS message type like `{ type: 'edit', path: 'notes.0.x', value: 240 }`.

Why it's wrong: you're rebuilding `@sanity/diff-patch` and Sanity's array‑keyed diffs, badly. Mosaic concurrent edits will clobber each other. You won't get echo suppression. You won't get rebase. You'll spend a month debugging.

Instead: use `SyncClient`. Send the whole next state. Let it diff.

### "I'll use Sanity Studio's collaboration plugin and skip `sanity-rooms`"

Symptom: trying to embed the Sanity Studio collaboration cursor into a custom UI.

Why it's wrong: Studio's collaboration is for Studio. It doesn't give you control over how docs are mapped, doesn't let you add app channels, and doesn't run in a headless Node context. `sanity-rooms` is for *your* app, with your domain shape, your auth, your transports.

### "I'll forget `_weak` and `_strengthenOnPublish`"

Symptom: publish blows up with "Cannot publish document because it references documents that are not published."

Instead: every ref entry in the main doc must include `_weak: true` and `_strengthenOnPublish: { type: '<refTargetType>' }`. Use the `configToSanity` converter to put them there centrally, not by hand at each call site.

### "I'll register `Room.onDispose` once"

Symptom: connections after the first room dispose hang or get a dead room.

Why it's wrong: `Room.onDispose` is *additive* (multi‑listener). The library registers its own listener in `RoomManager`. If your app overwrites a slot or replaces the listener, the library's cleanup never runs. The clock had this exact bug.

Instead: always *call* `room.onDispose(() => ...)`. Never reach into the Room internals to replace listeners.

### "I'll mutate Sanity directly from the AI tool without going through the room"

Symptom: AI tool calls `sanityClient.patch(...)` directly, then sends a "state" message manually.

Why it's wrong: echo suppression breaks. The room sees the SDK echo, doesn't recognize the txn, broadcasts it as an external change *while* your manually‑broadcast state is also in flight. Clients see the same edit twice, sometimes in the wrong order.

Instead: use `room.mutateDoc('config', { kind: 'named', name: '...', input: { ... } })`. The room handles everything else.

### "I'll skip `reconcile: immutableReconcile` and just `setState(client.getDocState())`"

Symptom: React re‑renders the entire tree on every state message because object identity changes even when the data didn't.

Instead: pass `reconcile: immutableReconcile` to your doc config in the SyncClient. It does a deep compare and reuses prior object references for unchanged subtrees, so React's prop‑identity heuristics work correctly.

---

## 16. Reading order for the source

If you want to confirm anything in this doc against the real code, read in this order:

1. `packages/sanity-rooms/src/mapping.ts` — the `DocumentMapping` interface (~60 lines).
2. `packages/sanity-rooms/src/protocol.ts` — wire messages (~100 lines).
3. `packages/sanity-rooms/src/server/sanity-bridge.ts` — the SDK adapter (~180 lines).
4. `packages/sanity-rooms/src/server/room.ts` — the meat (~620 lines). Read top to bottom; everything is documented.
5. `packages/sanity-rooms/src/server/room-manager.ts` — factory + dedup (~120 lines).
6. `packages/sanity-rooms/src/client/sync-client.ts` — optimistic state + diff‑at‑flush (~400 lines).
7. `packages/sanity-rooms/src/transport/ws-client-transport.ts` and `ws-server-transport.ts` — the trivial transports.

Then for the reference implementation:

8. `apps/server/src/rooms/room-manager.ts` — how the clock wires WS upgrades.
9. `apps/server/src/rooms/message-mapping.ts` — the real `DocumentMapping` for a richer domain.
10. `apps/server/src/rooms/message-room.ts` — the real `BoardRoom`‑equivalent, with chat + publish + presence.
11. `apps/clock/src/useDocumentSync.ts` — the real `useBoardSync` hook.
12. `packages/morphing-clock-sanity-bridge/` — the real converters.

If you've internalized the Mood Board, the clock code reads as "same shape, more rows."

---

## TL;DR for the impatient

- **One doc per editable thing.** `board` is the main doc; `boardImage` is a ref doc. Both are real Sanity types.
- **One `DocumentMapping` per type.** Five methods. The whole integration sits in this one object.
- **Frontend uses dereferenced shapes.** Convert refs → inline objects in `fromSanityWithRefs`. The React tree never sees `_ref`.
- **WS for every edit. REST only for non‑doc concerns (auth, file upload, list).**
- **`SyncClient.mutate('config', { kind: 'replace', state: nextWholeState })`** is the single edit primitive. It diffs, debounces, and reconciles for you.
- **App channels** for app‑specific concerns (`publish`, `presence`, chat).
- **Always weak refs + `_strengthenOnPublish`** on draft‑to‑draft references.
- **Trust the library** — `Room` handles broadcast, echo suppression, ref following, publish ordering, and reconnects. Don't reimplement them.
