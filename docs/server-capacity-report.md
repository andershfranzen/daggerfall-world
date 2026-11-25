# Daggerfall World — Single-Process Server Capacity & Hot-Path Audit

**Date:** 2026-11-25  
**Branch:** `t3/server-perf-audit`  
**Profiler:** [`tools/profile-server-capacity.mjs`](../tools/profile-server-capacity.mjs)  
**Test Host:** Node `v26.12.1` on `darwin/arm64` (Apple M5 Pro, 18 cores, 48 GB RAM)  
**Server Config:** `createGameServer({ host: '127.0.0.1', port: 0, allowGuests: true, maxPlayers: 2000, dbPath: ':memory:' })`, 25 Hz tick (`40.0 ms` budget), 12.5 Hz snapshots (`snapshotEveryTicks: 2`), AOI culling (`aoiThreshold: 64`, `aoiRadius: 128`, `maxVisiblePeers: 64`), `perMessageDeflate: false`.  
**Client Workload:** Real `ws` clients in an isolated child process joining with `delta: true` (matching `client/lib/net.js`) and sending continuous movement inputs at 10 Hz across an 8 s steady-state window (`saveIntervalMs: 3500` so periodic `persist()` fires 2–3 times per run).

---

## 1. Executive Summary — Measured Concurrent Player Ceiling Today

> **Bottom line:** On a fast single core (Apple M5 Pro), the current single-process server **breaks its 40 ms tick budget between 250 and 300 moving players clustered in 1 town** (at 350 players, snapshot ticks average **50.7 ms**, tick rate drops from 25 Hz to 21.9 Hz, event-loop p99 hits **52.4 ms**, and WebSocket egress hits **14.31 MB/s = 114.5 Mbps**). Spread evenly across **8 towns**, the server stays within budget past **350 players** (23.4 ms snapshot tick, 24.9 ms EL p99, 41.8% of 1 core, 8.43 MB/s egress), hitting its ceiling around **~550–600 players** on M5 Pro.
>
> **On a production cloud vCPU (e.g., dreadlode x86_64)** — where single-thread V8 throughput is typically **1.8×–2.5× slower** than an Apple M5 Pro and disk-backed SQLite/network I/O adds real latency — expect the practical ceiling today to be:
> - **Worst-case (all players in 1 town):** **~110–150 concurrent moving players** (CPU + 40 ms tick budget + ~50–65 Mbps egress)
> - **Typical spread (8 Iliac Bay towns):** **~220–300 concurrent moving players**
> - **Under active combat/NPC actions in a packed town:** Significantly lower due to `runtime.js:646` eagerly `structuredClone`ing every occupant's `p.rpg` on every action.

| Topology | Ceiling on M5 Pro (EL p99 < 40 ms) | Projected Cloud vCPU Ceiling (dreadlode) | Primary Limiting Factor |
| --- | --- | --- | --- |
| **1 town (worst-case crowd)** | **~260–280 players** | **~110–150 players** | `broadcastState()` (48%) + `runtime.sync()` (45%) + 114 Mbps egress |
| **8 towns (spread across Iliac Bay)** | **~550–600 players** | **~220–300 players** | `runtime.sync()` (51%) + `broadcastState()` (33%) + `persist()` |

---

## 2. Real Measured Benchmark Data

All measurements below were collected by running `node tools/profile-server-capacity.mjs` with server and clients in separate OS processes (zero event-loop, CPU, or memory cross-contamination).

### 2.1 Event-Loop Delay, CPU, Memory & Network Egress

| Topology | Players (N) | EL p50 (ms) | EL p95 (ms) | EL p99 (ms) | EL max (ms) | Server CPU (ms/s) | RSS (MB) | V8 Heap (MB) | Heap Δ (KB/p) | Egress/Client (KB/s) | Aggregate Egress (MB/s) | Aggregate (Mbps) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **1-town** | 25 | 1.15 | 1.32 | 3.23 | 6.94 | 78.8 | 107.7 | 23.6 | 176 | 27.64 | 0.68 | 5.4 |
| **1-town** | 50 | 1.15 | 1.35 | 6.16 | 11.98 | 132.6 | 119.3 | 36.2 | 347 | 37.12 | 1.81 | 14.5 |
| **1-town** | 100 | 1.16 | 1.45 | 13.59 | 20.14 | 233.3 | 189.9 | 74.4 | 565 | 44.61 | 4.36 | 34.8 |
| **1-town** | 200 | 1.16 | 1.68 | 26.59 | 29.16 | 440.5 | 327.5 | 150.1 | 670 | 43.76 | 8.55 | 68.4 |
| **1-town** | **350** | **1.15** | **3.74** | **52.36** | **68.22** | **708.9** | **590.6** | **249.6** | **674** | **41.86** | **14.31** | **114.5** |
| **8-towns** | 25 | 1.15 | 1.29 | 3.15 | 6.89 | 78.5 | 82.4 | 29.4 | 415 | 4.27 | 0.10 | 0.8 |
| **8-towns** | 50 | 1.15 | 1.36 | 4.61 | 9.68 | 111.1 | 121.8 | 49.6 | 620 | 5.52 | 0.27 | 2.2 |
| **8-towns** | 100 | 1.15 | 1.43 | 8.98 | 18.25 | 182.0 | 174.7 | 57.6 | 392 | 7.60 | 0.74 | 5.9 |
| **8-towns** | 200 | 1.15 | 1.51 | 14.77 | 18.89 | 267.9 | 276.3 | 99.1 | 408 | 14.71 | 2.87 | 23.0 |
| **8-towns** | **350** | **1.16** | **1.72** | **24.90** | **30.54** | **418.2** | **547.0** | **64.4** | **132** | **24.66** | **8.43** | **67.4** |

*Notes:*
- `CPU ms/s` = `user + system` CPU milliseconds per wall second (`1000 ms/s` = 100% of 1 core).
- At **1-town @ 350**, only **175 of 200** expected ticks executed in 8.0 s (**21.9 Hz** — 12.5% tick starvation) because every even-numbered snapshot tick overran the 40 ms budget.
- Per-client egress in 1-town plateaus at **~42–45 KB/s** once `aoiThreshold: 64` activates (`maxVisiblePeers: 64`), whereas 8-towns grows with players-per-town (up to 44 players/town at N=350, still below `aoiThreshold: 64`).
- RSS grows at **~1.45–1.59 MB/player** at N=200–350 (mostly transient GC headroom + WebSocket buffers; actual live V8 heap delta drops to 132 KB/player after major GC, as seen in 8-towns @ 350).

### 2.2 Server Hot-Path Phase Breakdown (ms per execution)

| Topology | N | `stepPlayer` avg / p99 (25 Hz) | `runtime.tick` avg / p99 (25 Hz) | `broadcastState` avg / p99 (12.5 Hz) | `runtime.sync` avg / p99 (12.5 Hz) | Snapshot Tick Total avg (ms) | `persist()` avg / max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **1-town** | 25 | 0.42 / 1.04 | 0.34 / 0.91 | 0.73 / 1.55 | 1.49 / 2.72 | **2.98** | 0.76 / 1.09 |
| **1-town** | 50 | 0.78 / 1.59 | 0.53 / 1.25 | 2.11 / 3.45 | 3.09 / 4.94 | **6.50** | 1.34 / 1.57 |
| **1-town** | 100 | 1.02 / 2.10 | 0.64 / 1.41 | 6.09 / 7.92 | 5.03 / 7.30 | **12.77** | 2.12 / 2.21 |
| **1-town** | 200 | 1.49 / 1.78 | 0.74 / 1.22 | 12.26 / 13.93 | 10.49 / 11.74 | **24.98** | 3.78 / 3.87 |
| **1-town** | **350** | **2.37 / 3.59** | **1.23 / 2.70** | **24.44 / 30.16** | **22.70 / 30.83** | **50.74** | **6.65 / 7.33** |
| **8-towns** | 25 | 0.47 / 0.92 | 0.39 / 1.05 | 0.51 / 0.99 | 1.45 / 2.69 | **2.81** | 1.02 / 1.58 |
| **8-towns** | 50 | 0.82 / 1.56 | 0.54 / 1.31 | 1.04 / 2.08 | 2.41 / 3.83 | **4.81** | 2.06 / 2.20 |
| **8-towns** | 100 | 1.45 / 2.88 | 0.81 / 1.42 | 1.98 / 2.89 | 4.16 / 6.33 | **8.40** | 3.77 / 3.78 |
| **8-towns** | 200 | 1.77 / 2.56 | 0.89 / 1.63 | 3.65 / 4.69 | 7.09 / 8.60 | **13.39** | 5.31 / 6.31 |
| **8-towns** | **350** | **2.46 / 2.94** | **1.16 / 2.00** | **7.78 / 8.91** | **11.98 / 13.25** | **23.38** | **7.32 / 7.38** |

**Key takeaway from the phase breakdown:**
- `stepPlayer()` (locomotion) and `runtime.tick()` (all 34 RPG features) are **NOT** the bottleneck today — together they cost only **3.6 ms** at 350 players (~10 µs/player/tick).
- **`broadcastState()` + `runtime.sync()` account for 92.9% of snapshot-tick CPU at 1-town @ 350 (47.14 ms / 50.74 ms)** and **84.5% at 8-towns @ 350 (19.76 ms / 23.38 ms)**.

### 2.3 WebSocket Egress Breakdown by Message Type

| Topology | N | `stateDelta` (KB/s) | `stateDelta` (msg/s) | `rpg` (KB/s) | `rpg` (msg/s) | `rpg` Share of Egress |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **1-town** | 25 | 336.6 | 312 | 354.4 | 312 | **51.3%** |
| **1-town** | 100 | 3,387.4 | 1,250 | 1,073.4 | 1,243 | **24.1%** |
| **1-town** | 200 | 6,868.7 | 2,474 | 1,883.5 | 2,482 | **21.5%** |
| **1-town** | **350** | **11,087.1** | **3,802** | **3,562.8** | **3,684** | **24.3%** |
| **8-towns** | 25 | 60.9 | 312 | 45.8 | 50 | **42.9%** |
| **8-towns** | 100 | 710.0 | 1,237 | 49.9 | 136 | **6.6%** |
| **8-towns** | 200 | 2,729.7 | 2,500 | 212.1 | 312 | **7.2%** |
| **8-towns** | **350** | **8,192.1** | **4,374** | **437.5** | **484** | **5.1%** |

**Why is `rpg` firing at 12.5 Hz to 100% of players in 1-town (3,684 msg/s, 3.56 MB/s) and only ~12.5% of players in 8-towns?**  
In `Gothway Garden` (`server/rpg/combat.js:142-147`), 4 wandering demo monsters move continuously. Because `runtime.sync()` has **no AOI culling on entities** and diffs `parts[1]` globally per location, **every single monster movement triggers a fresh `entityDelta` `{type:'rpg'}` packet to every player in the entire town at 12.5 Hz** — even players hundreds of metres away!

---

## 3. Exact Code Bottlenecks Found

### Bottleneck 1 — `runtime.sync()` Re-Serializes Every Clean Player & All N² Peers Every 80 ms
**Files:** `server/rpg/runtime.js:411-569`  
**Measured Cost:** **22.70 ms/snapshot** (1-town @ 350), **11.98 ms/snapshot** (8-towns @ 350)

1. **`JSON.stringify(p.rpg)` on every clean player every snapshot (`runtime.js:462`):**
   Even when a player is only walking (no RPG state changed), `viewOf()` executes `JSON.stringify(p.rpg)` and `JSON.stringify(locomotion)` (`runtime.js:466`) for every connected player 12.5 times/second (4,375 calls/s at N=350) just to construct a diff key.
2. **Unbounded O(N²) peer list in `runtime.sync()` (`runtime.js:432, 448, 458-464`):**
   While `broadcastState()` activates AOI culling above 64 players (`server/game.js:446`), `runtime.sync()` **does not use `spatialIndex`**. `locationCache()` puts all 350 peers in `c.peers`, and `viewOf()` filters and joins all 349 `q.rest` JSON strings **for each of the 350 viewers** (`350 × 349 = 122,150` string entries/snapshot).
3. **No shared serialization for public `entityDelta` (`runtime.js:484-525`):**
   When any entity in a town moves, `buildEntityDelta()` + `JSON.stringify(msg)` runs separately for all 350 viewers even though the public entity list is identical for every player in the town.
4. **Full `entities.values()` and `players.values()` scans per location (`runtime.js:427, 432`):**
   Across L occupied towns, `locationCache()` scans the entire global `entities` and `players` maps L times (`O(L × (E + P))`).
5. **Linear inventory scan per peer (`runtime.js:401`):**
   `publicPeer()` runs `rpg.inventory.find((it) => it && it.id === weaponId)` on every snapshot tick for every player.

---

### Bottleneck 2 — `broadcastState()` Per-Client `JSON.stringify`, Map Churn, and Full-Bucket Sort in `SpatialGrid`
**Files:** `server/game.js:424-522`, `server/scale/spatial-grid.js:210-255`  
**Measured Cost:** **24.44 ms/snapshot** (1-town @ 350), **7.78 ms/snapshot** (8-towns @ 350)

1. **Per-client `deltaData()` + `JSON.stringify()` + `new Map()` every 80 ms (`server/game.js:475-485, 498-522`):**
   For every `delta: true` client, `broadcastState()` calls `deltaData()` which allocates a `Set`, `changed[]`, per-peer delta objects, calls `JSON.stringify(...)` individually (4,375 times/s at N=350), and rebuilds `new Map(list.map((o) => [o.id, o]))` (350 Maps + 22,750 tuple arrays per snapshot).
   - Even when `useAoi` is `false` (all 8-towns scenarios, where every player in a town sees the exact same roster!), `deltaData()` still builds and stringifies an identical `stateDelta` separately for every player in the town instead of sharing one serialized delta per scene!
2. **`SpatialGrid.query()` sorts all N-1 candidates per viewer (`server/scale/spatial-grid.js:216-253`):**
   In a crowded town where 350 players are within the 128 m `viewRadius`, `query()` pushes all 349 `{ entry, distSq }` objects into `nearbyCandidates` and runs `Array.prototype.sort(compareCandidate)` on all 349 items **for every one of the 350 viewers** (`350 × 349 log 349` comparisons + 122,000 temp objects per snapshot) just to keep the top 64.
3. **Unnecessary `lastState` full scan (`server/game.js:441`):**
   Iterates every entry in `lastState` every snapshot instead of cleaning up in `leave(p)`.
4. **O(N²) Join/Leave Storm Amplification (`server/game.js:750, 794, 878, 918`):**
   `leave()`, `handleArrived()`, and `admit()` all call `broadcastState(true)` + `runtime.sync()` **globally across all towns with `force = true`**. Every single player joining or leaving forces a full `state` snapshot to all N connected players instead of letting the next 80 ms tick (or a single-scene dirty flag) deliver the delta.

---

### Bottleneck 3 — Zero `ws.bufferedAmount` Slow-Consumer Backpressure
**Files:** `server/game.js:394-396, 484, 490, 967`  
**Impact:** Unbounded memory growth & tail-latency collapse under WAN packet loss

`p.ws.send(data)` is called unconditionally whenever `ws.readyState === ws.OPEN`. There is no check on `ws.bufferedAmount`. On the public internet (dreadlode), a handful of mobile or high-latency clients stalling at 44 KB/s will silently queue tens of megabytes in Node's native socket buffers, driving up RSS, GC pauses, and kernel write pressure without dropping stale position snapshots or disconnecting dead consumers.

---

### Bottleneck 4 — Synchronous SQLite `persist()` & Per-Action Saves Blocking the Event Loop
**Files:** `server/game.js:524-542, 740, 913`, `server/db.js:176-194`, `server/rpg/runtime.js:655`  
**Measured Cost:** **6.65–7.32 ms** in `:memory:` SQLite at N=350 (**projected 25–80+ ms on disk WAL SSD**)

1. Every `saveIntervalMs` (5 s), `persist()` synchronously serializes `JSON.stringify(p.rpg)` for all dirty players (100% of moving players) and executes N synchronous `UPDATE players` statements in one `BEGIN IMMEDIATE ... COMMIT` transaction on the main thread.
2. In `:memory:` SQLite this already takes 7.3 ms at N=350; on real disk storage (dreadlode) it will stall the event loop for 1–2+ full ticks every 5 seconds.
3. Movement (`p.x, p.z, p.yaw`) sets the same `p.dirty = true` flag as RPG mutations (`server/game.js:606, 652`), forcing full multi-KB `rpg` JSON serialization and writes for players whose RPG state never changed.

---

### Bottleneck 5 — `runtime.act()` (`transact()`) Eagerly `structuredClone`s Every Player in the Same Town
**Files:** `server/rpg/runtime.js:645-648, 185-190`  
**Impact:** **Catastrophic stall under combat/NPC activity in crowded towns**

```js
// server/rpg/runtime.js:645-647
snap(p);
for (const q of players.values()) if (q !== p && locationOf(q) === loc) snap(q);
for (const e of entities.values()) if (e && e.location === loc) snapEntity(e);
```
Every single player action (`combat.attack`, `inventory.equip`, `npc.talk`, etc.) calls `structuredClone(q.rpg)` on **every other player in the same location** before running the handler — even though `ctx.dirty(q)` (`runtime.js:334`) already calls `snap(q)` lazily! In a 350-player town, **one player swinging a sword triggers 350 `structuredClone` calls** on the main thread.

---

### Bottleneck 6 — `peers.js` TTL Expires Mid-Tick & Allocates String Keys
**Files:** `server/rpg/peers.js:29, 44, 77-84, 98-110, 125`  
1. `TTL_MS = 15` is shorter than `broadcastState()` at N ≥ 200 (12–24 ms), so `peerView.across(p)` rebuilds its global spatial index **twice per snapshot tick** (once in `broadcastState`, once in `runtime.sync`).
2. `cellKey(cx, cz)` allocates `${cx},${cz}` strings 9× per viewer per call (18× per snapshot = 78,750 string allocations/s at N=350), unlike `SpatialGrid`'s integer keys.

---

### Bottleneck 7 — Secondary Linear Scans in `combat.js`, `npcs.js`, and `collision.js`
1. **`server/rpg/combat.js:1412-1421`:** Each monster scans all `occupants` in the town every 62.5 ms (`O(M × N)`).
2. **`server/rpg/combat.js:1573`:** `onLeave` iterates all global `ctx.entities.values()` to delete stealth entries.
3. **`server/rpg/npcs.js:603-625`:** `onTick` scans all `ctx.players.values()` and all `shops` at 25 Hz.
4. **`server/rpg/collision.js:98-105, 196-198`:** `rememberTownFloor()` mutates `p.rpg.townFloor = { location, x, z, y }` on every ground step after exiting a town doorway when ARENA2 collision is loaded — which invalidates `JSON.stringify(p.rpg)` and forces a full `msg.character` resend at **12.5 Hz** for that player!

---

## 4. Ranked Optimization Roadmap (Ready for dreadlode)

Ordered by **impact-to-effort ratio** for maximizing single-process concurrency and eliminating tail-latency spikes:

| Rank | Optimization | Target Files | Est. Phase Speedup | Est. Concurrency Multiplier | Egress Impact |
| :---: | --- | --- | --- | :---: | --- |
| **1** | **Dirty-revision tracking for `p.rpg` & `locomotion` + AOI-bounded peers & shared `entityDelta` in `runtime.sync()`** — Bump a monotonic `p._rpgRev` only when `p.rpg` mutates (never stringify clean players), share pre-serialized public `entityDelta` per scene/AOI cell, maintain per-location entity/player indexes, and move `townFloor` out of synced `p.rpg`. | `server/rpg/runtime.js`, `server/rpg/collision.js` | **`runtime.sync()` 5×–8× faster** (22.7 ms → ~3 ms) | **+1.6×** | **-20% to -25%** (cuts 3.56 MB/s `rpg` flood) |
| **2** | **Shared per-scene `stateDelta` + pre-serialized per-peer fragments in `broadcastState()`** — When `!useAoi` (all towns ≤ 64 players), serialize one shared `stateDelta` per scene instead of N copies. When `useAoi`, pre-serialize each moving peer's compact delta fragment once per tick and assemble viewer frames by string concatenation (zero per-client `JSON.stringify` or `new Map` churn). | `server/game.js` | **`broadcastState()` 4×–6× faster** (24.4 ms → ~4–5 ms) | **+1.8×** | — (0% to -30% with 2-decimal quantization) |
| **3** | **Lazy `snap(q)` in `runtime.act()` (`transact`)** — Remove the eager `for (const q of players.values()) if (locationOf(q) === loc) snap(q)` loop at `runtime.js:646`; rely on `ctx.dirty(q)` (already calls `snap(q)`) for the rare multi-player actions (trade, revive, party). | `server/rpg/runtime.js:646` | **Action latency 50×–100× faster** in crowded towns | **Prevents collapse under combat** | — |
| **4** | **Add `ws.bufferedAmount` backpressure & drop stale snapshots** — Skip `state`/`stateDelta` sends when `ws.bufferedAmount > 64 KB` (force full resync when drained); close zombie sockets exceeding `1 MB` for >5 s. | `server/game.js:394, 484, 490` | Protects p99 & RSS on WAN | **Required for dreadlode stability** | Caps slow-consumer bloat |
| **5** | **Fix `SpatialGrid.query()` top-K selection + `peers.js` TTL/integer keys** — Use bounded insertion / quickselect or progressive ring expansion (radius 32 → 64 → 128 m) to stop once `maxVisiblePeers` (64) are found instead of sorting all 349 peers. Raise `peers.js` `TTL_MS` to `40` (or tie to tick counter) and use integer cell keys. | `server/scale/spatial-grid.js`, `server/rpg/peers.js` | **AOI query 3×–4× faster** | **+1.2×** in 1-town crowds | — |
| **6** | **Eliminate `broadcastState(true)` on join/leave/arrived** — Mark the affected scene dirty and let the next 80 ms snapshot tick emit a normal delta instead of forcing a full-world broadcast on every join/leave. | `server/game.js:750, 794, 878, 918` | **Eliminates O(N²) join storms** | **Critical for launch spikes** | Prevents burst spikes |
| **7** | **Async batched Postgres / staggered `persist()` + separate position-only writes** — Separate `posDirty` (`x, z, yaw`) from `rpgDirty` (`rpg` JSON), stagger saves across 1 s buckets (`N/5` players per second), and flush asynchronously on Postgres (`UNNEST` batch upsert). | `server/game.js:529`, `server/db.js`, PG store | **Event-loop stall from persist: 25–80 ms → <1 ms** | **Eliminates 5 s hitching** | — |
| **8** | **Compact wire encoding & adaptive snapshot rate for distant peers** — Send 12.5 Hz updates for peers within 32 m and 6.25 Hz (or 4 Hz) for peers 32–128 m away; switch `stateDelta` peer records to compact arrays `[id, x, z, yaw, flags]` or 2-decimal rounding. | `server/game.js`, `client/lib/net.js` | `-30%` WS write sys CPU | **+1.4×** | **-55% to -70% egress** (14.3 MB/s → ~4–5 MB/s) |

### Projected Combined Result (After Ranks 1–6 + 7)

Applying **Ranks 1–7** (all server-side, zero wire-protocol breaking changes for existing clients):
- **1-town @ 350 snapshot tick:** `50.7 ms` → **~11–14 ms** (**~4× speedup**)
- **Single-process 1-town ceiling:** **~270 → ~900–1,100 players** on M5 Pro (**~400–550 players** on a single dreadlode cloud vCPU)
- **Single-process 8-town ceiling:** **~575 → ~1,500–2,000 players** on M5 Pro (**~750–1,000 players** on a single dreadlode cloud vCPU)
- Adding **Rank 8** (adaptive AOI rate + compact delta wire format) brings aggregate egress at 1,000 players under **~10–15 MB/s** (~100 Mbps).

---

## 5. Reproducing This Benchmark

```bash
# Quick smoke verification (25, 50 players x 1-town & 8-towns, ~15s)
node tools/profile-server-capacity.mjs --quick

# Full capacity matrix (25, 50, 100, 200, 350 players x 1-town & 8-towns, ~2 min)
node tools/profile-server-capacity.mjs

# Custom run with raw JSON export
node tools/profile-server-capacity.mjs --counts=25,50,100,200,350 --duration=8000 --json=/tmp/capacity.json
```
