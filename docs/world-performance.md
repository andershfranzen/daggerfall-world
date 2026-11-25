# World performance: measured cost per player

`tools/measure-world.mjs` measures what one Node process pays to host the shared town. It reports download bandwidth per player, by message type, and the server's event-loop delay and utilization, with the production RPG feature manifest (`server/rpg/features.js`) and the operator's `ARENA2_DIR` enabled.

## How the measurement works

- **Server:** for each player count, a fresh server runs in-process through `createGameServer()`. It binds only `127.0.0.1` on a random port and uses a new `mkdtemp` directory for `world.db` and empty `client/` and `site/` roots. The directory is deleted afterwards. The server never touches `server/data/*.db`, the preview or the public service. The script also refuses to continue if the server binds to any address other than `127.0.0.1`.
- **Clients:** the simulated clients run in a `worker_thread`, so parsing their JSON does not count against the server's event loop. Each client joins as a normal (guest) player in the default town (`town:Daggerfall/Gothway Garden`). It sends `input` at 10 Hz, the human cadence from the protocol, and walks forward with smooth random turns and occasional pauses. It also chats about once every 6 s, below the 1/s chat limit. The workload includes no attacks and no flooding.
- **Download:** bytes received per client while measuring, split by the frame's `type`.
- **Upload:** bytes each client sent.
- **Loop delay:** `monitorEventLoopDelay` measured on the server thread. The histogram's own 10 ms timer period is subtracted, so the values are excess delay.
- **ELU and CPU:** `performance.eventLoopUtilization()` and `process.cpuUsage()` for the server process. The worker's CPU is included, so CPU% is an upper bound.
- **`runtime.tick` / `runtime.sync`:** wall time per call. The script wraps these methods on `server.runtime` and does not edit the server.

## Steps

```sh
npm ci
mkdir -p progress/screenshots/agents          # ignored (.gitignore: progress/screenshots/)
ARENA2_DIR=gamedata/DaggerfallGameFiles/arena2 \
  node tools/measure-world.mjs --json progress/screenshots/agents/world-performance.json --svg progress/screenshots/agents/world-performance.svg
rsvg-convert -w 1400 progress/screenshots/agents/world-performance.svg -o progress/screenshots/agents/world-performance.png
# Baseline without RPG features / actors:
node tools/measure-world.mjs --no-actors --json progress/screenshots/agents/world-performance-baseline.json
```

Options: `--counts 2,8,32` (each from 1 to 32, the default `maxPlayers`), `--seconds 15`, `--warmup 3`, `--chat 6` (mean seconds between chat lines per player, `0` turns chat off), `--no-actors`. A full run takes about 1 minute. The script needs no extra dependencies. `rsvg-convert` is optional and only used to make the PNG.

## Results (2026-11-24, Node 26.13.1, i7-14700 with 28 threads, ARENA2 on, 15 s per count)

| Players | Down per player | of which `state` | `rpg` | `chat` | Up per player | Server out total | Loop delay p50 / p99 / max | ELU | `runtime.sync` mean / p99 | `runtime.tick` mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 2.16 KB/s | 2.15 (176 B × 12.5/s) | 0 | 0.01 | 0.51 KB/s | 4.3 KB/s | 0.08 / 1.1 / 6.3 ms | 0.02 | 0.26 / 0.68 ms | 0.10 ms |
| 8 | 7.68 KB/s | 7.60 (625 B × 12.5/s) | 0 | 0.08 | 0.51 KB/s | 61 KB/s | 0.07 / 1.3 / 3.0 ms | 0.02 | 0.71 / 1.4 ms | 0.08 ms |
| 32 | 30.3 KB/s | 30.0 (2462 B × 12.5/s) | 0 | 0.34 | 0.51 KB/s | 970 KB/s (≈7.9 Mbit/s) | 0.08 / 5.2 / 8.0 ms | 0.08 | 3.55 / 7.3 ms | 0.17 ms |

The baseline with `--no-actors` (`features: []`) at 32 players had the same bandwidth (30.5 KB/s per player). `runtime.sync` took 0.24 ms on average there, and ELU was 0.02. The town had 11 server entities (NPCs) when the RPG features were enabled.

Other agents' test suites and servers ran on the same machine during the measurement, with a load average of about 23–29. Treat the maximum and p99 delays as an upper bound. Across repeat runs, sync p99 at 32 players ranged from 5.2 to 7.3 ms.

## Observations

1. **Bandwidth is O(N) per player, and the server's output is O(N²).** About 99% of downstream traffic is the `state` frame. It is the full roster of the location (`id, name, x, z, yaw, moving` as JSON, about 77 B per player), sent at the snapshot rate of 12.5 Hz to every occupant whenever anyone moves. At 32 players that is about 30 KB/s per client and about 1 MB/s from the server. At the same rate, 100 players in one town would cost about 95 KB/s per client and about 9.5 MB/s (≈77 Mbit/s) from the server.
2. **The `rpg` snapshots cost nothing on the wire in this workload.** Peer movement is excluded from their diff key, and town NPCs that stand still never change. The diffing works.
3. **The CPU bottleneck is `runtime.sync`, even though it sends nothing.** Every 80 ms, for every player, it rebuilds that player's private snapshot and runs `JSON.stringify` over the full character (inventory included), the location's entities and the peer list, only to compare the result with the previous key. With the RPG features on, this takes 15× longer than in the baseline at 32 players (3.55 ms against 0.24 ms). It grows with N × (character size + entities + N) and is the largest per-tick cost (≈4.4% of the 80 ms budget). The movement tick and feature ticks cost 0.1–0.2 ms.
4. **The event loop is healthy at 32 players.** ELU is 0.08, and p99 excess delay is about 5 ms against a 40 ms tick. A single process has plenty of CPU headroom for one town. Bandwidth will limit a public host before CPU does.
5. Upload is a constant 0.5 KB/s per player: 10 `input` frames of about 52 B each per second.

## Changes after this measurement (2026-11-25)

Both bottlenecks above are addressed. The wire protocol is backward-compatible. A client that sends `delta: true` in its `join` (the browser client does, in `client/lib/net.js`) opts in. Raw WebSocket clients and tests without the flag still get full `state` and `rpg` frames.

- **`server/rpg/runtime.js` → `sync`:** the diff key is built from JSON that is cached once per location per sync. Each entity is copied and serialized once, each public peer once, and readiness once, no matter how many viewers share them. The full snapshot is only assembled when the key changed. A key is still computed from the complete content, so features that mutate `p.rpg` or entities directly cannot leave a stale snapshot. The owner's character is still serialized once per sync. It is the remaining per-player cost, and a dirty counter would need every feature to report its mutations. For `delta` clients, a changed snapshot carries only the top-level fields that changed (`character`, `entities`, `peers`, `readiness`, `locomotion`). `mergeRpg` (`client/gameplay/api.js`) already merges partial snapshots. `force`, `resetSync` and `join` always send the full snapshot.
- **`server/game.js` → `broadcastState`:** each player's public entry is built once per broadcast. The legacy shared string is only serialized when a legacy viewer needs it. `delta` clients get `stateDelta` frames, `{type:'stateDelta', location, players, gone?}`. `players` holds new entries in full and, for known ids, only the fields that changed (positions keep the same 1 mm quantization as `state`). `gone` lists ids that left. An id that appears in both `gone` and `players` is replaced, for example when a field such as `stance` disappears. A full `state` still starts every new socket and location, and is sent on `force` (join, leave, arrival) and on the idle heartbeat. Interest culling is not implemented: towns are at most about 1 km across, and culling would change who sees whom. Add a configurable radius when one location holds well over 32 players.

### Before and after (2026-11-25, Node 26.12.1, 18 threads, ARENA2 **off**, 10 s per count)

`node tools/measure-peers.mjs --scenarios town --counts 2,8,32 --seconds 10 [--delta]`. "Before" is the same tool run against the previous commit. Without ARENA2 the town has wandering monsters and no NPCs, so their positions change every sync. Before this change, every client then received its full private snapshot (17–24 KB, mostly its own unchanged character) at 12.5 Hz. That is why the `rpg` column here is large, unlike the ARENA2 table above, where nothing moved.

| Players | Run | Down per player | `state` / `stateDelta` | `rpg` | `runtime.sync` mean / p99 | Loop delay p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | before | 180 KB/s | 3.0 (248 B frames) | 177 (17.8 KB frames) | 0.81 / 1.67 ms | 1.8 ms |
| 2 | after, legacy client | 217 KB/s | 3.0 | 214 | 0.78 / 1.61 ms | 1.9 ms |
| 2 | after, `delta` client | **34 KB/s** | 1.7 (145 B) | 32 (3.5 KB) | 0.47 / 1.22 ms | 2.0 ms |
| 8 | before | 184 KB/s | 9.4 (785 B) | 175 (19.0 KB) | 2.98 / 4.81 ms | 5.0 ms |
| 8 | after, legacy client | 237 KB/s | 9.4 | 228 | 1.11 / 2.20 ms | 2.2 ms |
| 8 | after, `delta` client | **47 KB/s** | 4.5 (371 B) | 42 (3.6 KB) | 1.27 / 2.30 ms | 3.4 ms |
| 32 | before | 327 KB/s | 35.6 (2966 B) | 291 (24.1 KB) | 9.07 / 12.86 ms | 12.0 ms |
| 32 | after, legacy client | 327 KB/s | 35.6 | 291 | 7.15 / 9.34 ms | 9.4 ms |
| 32 | after, `delta` client | **59 KB/s** | 15.1 (1255 B) | 43 (3.6 KB) | **3.25 / 5.35 ms** | 7.7 ms |

At 32 players, server output drops from about 10.4 MB/s to 1.9 MB/s with `delta` clients (−82%). `state` traffic drops 58%, even though every walker moves almost all the time: frames leave out names and unchanged fields. Idle players cost nothing. `runtime.sync` takes 64% less time. Legacy clients get byte-identical frames. Their sync time also falls at 8 and 32 players, because peers and entities are serialized once per location. The legacy `rpg` rate varies between runs (177 against 214 KB/s at 2 players) with monster spawn timing. The ARENA2 workload of the first table was not re-measured on this machine, which has no game data. There, `state` is 99% of the traffic, so the `stateDelta` reduction applies directly.

## Current limitations

- Only one town and one location are exercised. With all players in the same place, broadcast cost is at its worst. Travel, interiors, combat, magic and monster AI are not exercised, so `rpg` and `gameEvent` traffic during fights is not measured.
- Clients join as guests (`accounts: null`). Account checks run once, at upgrade time, and are not part of steady-state cost. Login and registration cost (scrypt) is not measured.
- The maximum is 32 players, the server default `maxPlayers`. The tool does not change server limits or apply stress beyond normal play.
- Loopback only: there is no network latency, no TLS and no proxy. Bytes are WebSocket payload sizes, not counting frame or TCP/IP overhead (about 2–8 B of framing per message).
- The clients share the machine with the server, and the machine was shared with other workloads, so absolute delay numbers are noisy. Bandwidth numbers are deterministic.
- Collision can stop walkers at walls. They still send input, and the `state` rate stays at 12.5 Hz because at least one player is always moving.
