# Single-World Scalability Architecture

Daggerfall World hosts **one shared Iliac Bay world** — there are **no shards, realms, or isolated channels**. Every player who enters Daggerfall, Wayrest, Sentinel, a tavern interior, a dungeon, or a wilderness pixel inhabits the same continuous world with one economy, one social graph, and one live map (`/api/world-map`).

This document describes the vertical and horizontal scaling infrastructure implemented in `server/scale/`, the updated capacity and chat limits, real 500-player AOI benchmark measurements, and the exact minimal hooks to wire these modules into `server/game.js` during integration.

> **What the live server runs (reviewed 2026-11-25 against the real ARENA2 files).**
> - **Running:** `server/scale/spatial-grid.js` only, through `createSceneSpatialIndex` in `server/game.js` `broadcastState()`. It activates per presence scene once more than `aoiThreshold` (64) visible players share it, and keeps `maxVisiblePeers` (64) per viewer within `aoiRadius` (128 m). Until this review, the live wiring crashed the whole process the first time a culled scene had a stale entry (a leave, a scene change or a loading screen): `game.js` called `grid.ids()`, which `SpatialGrid` did not have. Before the fix, every server with more than 64 players in one scene went down. 100 real-data players in Privateer's Hold reproduced it.
> - **Priority tier as wired:** party members and the partner of a pending or open trade (`services.tradePartnerOf`, `server/rpg/social.js`). Until this review only party members were wired. There is no player-versus-player melee, so there are no duel or combat partners to wire. `isPriority` is unused. The `rpg` peer list (`server/rpg/runtime.js`, nearest 64 in a crowd) uses the same two priorities.
> - **Not running:** `server/scale/zone-router.js` and `server/scale/world-bus.js` (including `createPostgresBus`). Only their tests import them. `server/main.js` never creates a bus or a router, so `cfg.worldBus` is always `null`. The live world is one Node process. Sections 2.2, 2.3 and 4 below describe unintegrated code.
> - The 500-player figure in section 3 times `SpatialGrid` alone in a unit test. It is not a server measurement. For measured server capacity with the real files, see `docs/server-capacity-report.md`.

---

## 1. Architecture Overview

Scaling a single shared world to hundreds or thousands of concurrent players requires two complementary layers:

1. **Vertical Scaling (Packed Cities) — `server/scale/spatial-grid.js`**
   - Eliminates worst-case $O(N^2)$ peer visibility and snapshot fan-out when hundreds of players gather in a single town plaza.
   - Replaces full-scene peer iteration with an $O(1)$-cell 2D spatial hash grid and deterministic Area-of-Interest (AOI) culling capped at a configurable peer budget (`maxVisiblePeers = 64` by default).
   - Preserves gameplay-critical relationships via a strict priority tier: party members and active trade/duel/combat partners in the same scene are **always** visible regardless of distance or crowd cap.

2. **Horizontal Scaling (Multi-Core / Multi-Host Single World) — `server/scale/zone-router.js` + `server/scale/world-bus.js`**
   - Partitions Iliac Bay **geographically by region and wilderness/sea sector**, never by player shard.
   - Deterministic Rendezvous (Highest Random Weight) hashing ensures every worker and gateway maps any location to the **exact same authoritative worker**.
   - Entering a building, tavern, or regional dungeon stays co-located on the exterior town's worker — zero cross-worker handoffs for indoor transitions.
   - Cross-worker chat (`global`, `region`, `party`, `whisper`), signed one-time zone handoff tickets, and unified `/api/world-map` presence snapshots flow over a pluggable `WorldBus` (`createMemoryBus` for single-host/tests, `createPostgresBus` using PostgreSQL `LISTEN`/`NOTIFY` for multi-host production).

```
                    ┌────────────────────────────────────────┐
                    │   TLS Reverse Proxy / WS Gateway       │
                    │  (routes /ws via ZoneRouter + tickets) │
                    └──────┬──────────────────────────┬──────┘
                           │                          │
            ┌──────────────▼──────────────┐  ┌────────▼─────────────────────┐
            │  Zone Worker: worker-west   │  │  Zone Worker: worker-east    │
            │  Regions: Daggerfall, ...   │  │  Regions: Wayrest, Sentinel  │
            │  - SpatialGrid AOI (O(N·K)) │  │  - SpatialGrid AOI (O(N·K))  │
            │  - Authoritative RPG tick   │  │  - Authoritative RPG tick    │
            │  - Local /api/world-map     │  │  - Local /api/world-map      │
            └──────────────┬──────────────┘  └────────┬─────────────────────┘
                           │                          │
            ┌──────────────▼──────────────────────────▼──────────────┐
            │            WorldBus (PostgreSQL LISTEN/NOTIFY)         │
            │  • Chat relay (global / region / party / whisper)      │
            │  • HMAC-SHA256 one-time zone handoff tickets           │
            │  • Presence directory heartbeats (/api/world-map)      │
            └──────────────────────────┬─────────────────────────────┘
                                       │
            ┌──────────────────────────▼─────────────────────────────┐
            │         Shared PostgreSQL (Accounts + Characters)      │
            └────────────────────────────────────────────────────────┘
```

---

## 2. Core Modules

### 2.1 Spatial Grid & AOI Culling (`server/scale/spatial-grid.js`)

- **Exports:** `SpatialGrid`, `createSpatialGrid`, `createSceneSpatialIndex`, `DEFAULT_CELL_SIZE` (`32` m), `DEFAULT_VIEW_RADIUS` (`128` m), `DEFAULT_MAX_VISIBLE_PEERS` (`64`).
- **Zero-allocation cell keys:** Encodes 2D integer cell coordinates `(cx, cz)` into a single safe integer key, avoiding per-lookup string allocations.
- **O(1) movement updates:** `grid.upsert(entity, x, z)` checks if the entity crossed a cell boundary; intra-cell movement updates coordinates in place without mutating cell buckets.
- **Deterministic priority ordering (`grid.query(viewer, opts)`):**
  1. **Priority tier:** Any peer in `priorityIds` (party members, active trade partners, duel/combat targets) or matched by `isPriority(peer, viewer)` is included first, sorted by `(distSq, id)` ascending — even if beyond `viewRadius` or when the crowd cap is reached.
  2. **Nearby crowd:** Scans only grid cells intersecting `[vx - viewRadius, vx + viewRadius] × [vz - viewRadius, vz + viewRadius]`, filters by `distSq <= viewRadius^2`, sorts by `(distSq, id)` ascending, and fills remaining slots up to `maxVisiblePeers`.
  3. **Arrival privacy:** Peers with `arriving === true` are excluded automatically unless `includeArriving: true`.

### 2.2 Deterministic Zone Router (`server/scale/zone-router.js`)

- **Exports:** `canonicalZone`, `createZoneRouter`, `DEFAULT_WILDERNESS_SECTOR_SIZE` (`32` px), `DEFAULT_SEA_SECTOR_SIZE` (`64` px).
- **Canonical co-location rules:**
  - `town:Daggerfall/Gothway Garden`, `town:17/197`, `interior:Daggerfall/Gothway Garden/1,2/3`, `building:Daggerfall/Gothway Garden/b:1,2:3`, and `dungeon:Daggerfall/Privateer's Hold` all resolve to `region:daggerfall`.
  - `wilderness:<px>,<py>` groups into `wilderness:<sx>,<sy>` sectors (`Math.floor(px / 32)`).
  - `sea:<px>,<py>` groups into `sea:<sx>,<sy>` sectors (`Math.floor(px / 64)`).
- **Worker assignment:** Supports explicit region pinning (`overrides` or `worker.regions`) for high-population hubs (e.g., dedicating a worker to `Daggerfall` or `Wayrest`) and weighted Rendezvous (HRW) hashing for all other zones so scaling from $K$ to $K+1$ workers remaps only $\sim 1/(K+1)$ of zones.

### 2.3 Cross-Worker Event Bus (`server/scale/world-bus.js`)

- **Exports:** `createMemoryHub`, `createMemoryBus`, `createPostgresBus`, `createWorldBus`, `DEFAULT_TICKET_TTL_MS` (`15_000` ms), `DEFAULT_PRESENCE_TTL_MS` (`30_000` ms), `DEFAULT_PG_CHANNEL` (`'dfw_world_bus'`), `PG_NOTIFY_MAX_BYTES` (`7800`).
- **Chat relay:** `publishChat({ channel, fromId, fromName, text, region?, partyId?, targetId?, targetName? })` and `onChat(fn)` relay `global`, `region`, `party`, and `whisper` messages across workers without self-echo.
- **One-time zone handoff tickets:**
  1. Origin worker persists the player's character state and calls `bus.issueHandoff({ playerId, accountId, name, toWorkerId, targetLocation, state })`.
  2. Returns a signed `base64url(payload).hmacSha256` token with a 128-bit random nonce and short TTL (`15 s`), and announces the nonce on the bus.
  3. Client reconnects to the target worker's WebSocket URL and presents the handoff token.
  4. Target worker calls `bus.redeemHandoff(token)`: verifies HMAC with `timingSafeEqual`, validates expiry and `toWorkerId`, burns the nonce locally, and broadcasts `handoff.consumed` so replay attempts fail everywhere.
- **Unified presence directory:** `publishPresence(snapshot)`, `getClusterPresence()`, `getRemoteSnapshots()`, and `startHeartbeat(getSnapshot, intervalMs)` keep every worker's `/api/world-map` synchronized within seconds and automatically expire stale workers after `presenceTtlMs`.

### 2.4 Unified Public World Map (`server/public-world-map.js`)

- `publicWorldMap(players, lookup, now, sailing, extra)` and `handlePublicWorldMap(req, res, players, travel, sailing, extra)` accept an optional `extra` parameter (`worldBus`, an array of remote snapshots, or `{ worldBus, remoteSnapshots }`).
- Also exports `mergeWorldMapSnapshots(snapshots, now)` and `projectOnlineWorldMap({ players, lookup, now, sailing, worldBus, remoteSnapshots })`.
- Merges pixel counts with the exact same precedence as single-process mode (`town` > `sea` > `wilderness`), sums `online`, `count`, and `inside`, recomputes `unplaced`, and remains 100% backwards-compatible when `extra` is omitted.

### 2.5 World Capacity & Chat Rate Limits (`server/main.js`, `server/rpg/social/chat.js`)

- **`server/main.js`:**
  - Removes the low `1000` clamp on `MAX_PLAYERS` and raises the default cap from `32` to `2000`.
  - Supports `MAX_PLAYERS=0` (translated to `Number.POSITIVE_INFINITY` for uncapped single-world capacity) and any positive integer up to `1,000,000`.
  - Passes comfortable local chat defaults (`CHAT_RATE_PER_SEC`, `CHAT_BURST`) from `CHAT_LIMITS.local` to `createGameServer()`.
- **`server/rpg/social/chat.js`:**
  - Adds per-channel human-conversation budgets (`CHAT_LIMITS`) and `createChatLimiter(now, overrides)` with independent token buckets per channel:
    | Channel | Sustained Rate | Burst | Purpose |
    | --- | --- | --- | --- |
    | `local` | 4 lines / sec | 12 | Natural town/tavern conversation |
    | `party` | 5 lines / sec | 15 | Fast tactical callouts in dungeons/combat |
    | `whisper` | 5 lines / sec | 15 | Private 1-on-1 conversation |
    | `region` | 3 lines / sec | 10 | Regional trade and LFG |
    | `global` | 2 lines / sec | 5 | World-wide shout (anti-spam protection) |

---

## 3. Measured 500-Player Single-City AOI Benchmark

Measured via `node --test test/scalability-single-world.test.mjs` (Node.js on Apple Silicon macOS, 500 concurrent players scattered across a 600 m × 600 m city plaza, 5-player parties exercising the priority tier, `cellSize = 32 m`, `viewRadius = 128 m`, `maxVisiblePeers = 64`):

| Metric | Measured Result | Budget / Target |
| --- | --- | --- |
| Players in single city | **500** | 500+ |
| Move & re-index all 500 players (`grid.upsert`) | **0.07 ms** | < 2 ms |
| Priority-ordered AOI query for all 500 viewers (`grid.query`) | **7.40 ms** | < 20 ms |
| **Total AOI pass (update + 500 queries)** | **7.47 ms** | **80 ms snapshot interval (< 10% budget)** |
| Average visible peers per viewer | **57.4** | ≤ 64 (`maxVisiblePeers`) |
| Max visible peers returned | **64** | 64 (party members guaranteed) |
| Active spatial grid cells | **263** | 32 m × 32 m cells |

Without spatial AOI culling, 500 players in one city produces $500 \times 499 = 249{,}500$ peer evaluations per snapshot (12.5 Hz → >3.1 million peer pairs/sec). With `SpatialGrid`, peer fan-out is bounded to $500 \times 57.4 \approx 28{,}700$ pairs (~8.7× fewer serialized peers per snapshot, and $O(N \cdot K)$ scaling as cities grow beyond 500 players).

---

## 4. Minimal Integration Hooks for `server/game.js`

When the integration owner wires `server/scale/*` into `server/game.js`, only five small touchpoints are needed:

1. **Server options (`createGameServer(options)`):**
   - Accept optional `spatial: { cellSize, viewRadius, maxVisiblePeers }`, `zoneRouter`, and `worldBus` on `options`.
   - Instantiate `const spatialIndex = createSceneSpatialIndex(cfg.spatial);`.

2. **Spatial index maintenance (`tick()`, `admit()`, `leave()`):**
   - On `admit(p)` and whenever `p.moving` or scene changes in `tick()`: `spatialIndex.upsert(sceneOf(p), p)`.
   - On `leave(p)`: `spatialIndex.remove(p)`.

3. **AOI-culled `broadcastState()` (`server/game.js:320-369`):**
   - For each viewer `p` in `group`:
     - Build `priorityIds` from `services.partyOf?.(p)?.memberIds` plus any active trade/duel/combat partner ids.
     - Replace the full-group `local` slice with:
       ```js
       const visible = spatialIndex.query(scene, p, { priorityIds, includeSelf: true });
       const mine = visible.map(publicOf);
       ```
     - Existing `deltaData()` logic works unchanged: peers moving out of `viewRadius` or crowd budget are automatically emitted in `gone`, and peers entering are emitted in `players`.

4. **Unified `/api/world-map` (`server/game.js:218`):**
   - Pass `worldBus` as the 6th argument to `handlePublicWorldMap`:
     ```js
     if (path === PUBLIC_MAP_PATH) {
       return handlePublicWorldMap(req, res, players, services.travel, services.sailing, cfg.worldBus);
     }
     ```
   - In `start()`, if `cfg.worldBus` is configured, start periodic presence publishing:
     ```js
     cfg.worldBus?.startHeartbeat(() => publicWorldMap(players.values(), services.travel?.lookup, Date.now(), services.sailing));
     ```
   - In `close()`, call `await cfg.worldBus?.close()`.

5. **Cross-worker chat & travel handoff (`handleChat`, `server/rpg/social.js`, `travel.go`):**
   - When `cfg.worldBus` is present, subscribe `cfg.worldBus.onChat(...)` to deliver remote `global`, `region`, `party`, and `whisper` messages to matching local players, and call `cfg.worldBus.publishChat(...)` when a local player sends on those channels.
   - On `travel.go` or overland sector crossing, check `cfg.zoneRouter.needsHandoff(workerId, targetLocation)`. If `required === true`, persist the character, call `cfg.worldBus.issueHandoff(...)`, and send `{ type: 'handoff', url: handoff.toWorker.url, token: issued.token, location: targetLocation }` to the client so it seamlessly reconnects to the owning worker without dropping its session.
