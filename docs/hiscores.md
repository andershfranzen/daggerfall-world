# Chronicles of the Iliac Bay (Hiscores) — Technical & API Specification

The **Chronicles of the Iliac Bay** is Daggerfall World's persistent, public leaderboard and character-comparison system. It powers both the in-game Chronicles HUD (via WebSocket actions) and the public Next.js website `/hiscores` page (via read-only HTTP JSON endpoints).

---

## 1. Overview & Design Principles

Inspired by Old School RuneScape's Hiscores, the Chronicles are built around three core invariants:

1. **In-Universe Framing**
   Leaderboards are presented as the *Chronicles of the Iliac Bay*—recording character mastery across all 35 classic Daggerfall skills, guild standing across the six classic factions, cartographic discovery across the 15,251 classic sites of High Rock and Hammerfell, naval renown under the Crown Admiralty, regional infamy, and player-founded Orders.
2. **Zero 25 Hz Tick Impact**
   Ranking and aggregation never run inside the 25 Hz world simulation loop. Live gameplay hooks (`kill`, `questComplete`, `locationChanged`, and a lightweight 5-second milestone reconciliation check) only update `p.rpg.chronicles` and mark the character dirty for normal persistence. Public reads are served exclusively from indexed `hiscores` and `hiscores_orders` projection tables backed by an in-memory **30 s** snapshot cache (`DEFAULT_TTL_MS = 30_000`) with single-flight refresh coalescing.
3. **Strict Privacy & Moderation Boundary**
   Only a safe, frozen public projection of each eligible character is ever stored in `hiscores` or returned by the HTTP/WebSocket APIs. Private account metadata, credentials, live coordinates, current location, inventory contents, and raw `rpg` blobs are never exposed. Banned accounts, uncreated characters, and characters who opt out via `rpg.chronicles.hidden = true` are automatically excluded.

---

## 2. Complete Board Catalog

All board identifiers are resolved canonically (case-insensitively; empty or omitted board defaults to `overall`).

### 2.1 Tie-Breaking & First-to-Milestone Rules

Every character board sorts entries deterministically using the following comparator:

1. **Primary `score`** — descending (`b.score - a.score`).
2. **Secondary tie-breaker (`secondary`)** — descending (`b.secondary - a.secondary`).
3. **First-to-milestone timestamp (`milestoneAt`)** — ascending (`a.milestoneAt - b.milestoneAt`). Missing or `0` timestamps sort after any recorded positive timestamp (`Number.MAX_SAFE_INTEGER`), preserving OSRS-style *first-to-100* / *first-to-level* ordering.
4. **Character ID (`playerId`)** — ascending, guaranteeing a total, stable order.

Milestone timestamps are tracked in `p.rpg.chronicles.skillMilestones[skill]` (updated only when a skill strictly increases, never reset when unchanged) and `p.rpg.chronicles.levelMilestoneAt` (updated only when character level strictly increases).

### 2.2 Core Boards (7)

| Board ID | Label | Unit | Min Score | Primary Score Formula | Secondary Tie-Breaker | Milestone Timestamp | Display Badge |
| :--- | :--- | :--- | :---: | :--- | :--- | :--- | :--- |
| `overall` | Overall | `pts` | `0` | Sum of all 35 classic Daggerfall skills (`totalSkill`, each clamped `0..100`, max `3500`) | Character `level` | `milestoneAt` | `className` |
| `level` | Character Level | `lvl` | `1` | `character.level` (min `1`) | `totalSkill` | `levelMilestoneAt` (fallback `milestoneAt`) | `className` |
| `exploration` | Cartography | `places` | `1` | Unique classic places discovered (`placesDiscovered = min(15251, countFound(travel.found) + unique(travel.discovered))`) | `travel.trips` | `milestoneAt` | Discovery `%` of `15,251` (e.g. `12.4%`) |
| `quests` | Quests Completed | `quests` | `1` | `max(chronicles.questsCompleted, count(quests.done where result in {'success','complete','completed'}))` | Character `level` | `milestoneAt` | `null` |
| `slayer` | Monsters Slain | `slain` | `1` | `chronicles.monstersSlain` (incremented on `kill` events) | Character `level` | `milestoneAt` | `null` |
| `wanted` | Most Wanted | `infamy` | `1` | `sum(max(0, -law.rep[r]) for r with rep < 0) + 50 * count(law.banished[r] == true) + (law.charge ? 25 : 0) + round(max(admiralty.notoriety[r], 0))` | Character `level` | `milestoneAt` | `worstRegion` |
| `admiralty` | Admiralty & High Seas | `prestige` | `1` | `sum(positive admiralty.standing) + max(admiralty.standing) + 5 * pirateSunk + 8 * pirateTaken + 3 * repelled + 10 * contractsDone` | `admiraltyMaxStanding` (DB index: `ships_sunk`) | `milestoneAt` | `admiraltyRankTitle` (from `CROWN_RANKS`) |

### 2.3 Classic Guild Boards (6)

Membership in the guild (`rpg.guilds[group]` with numeric `rank >= 0`) is required (`requiresMembership: true`, `minScore: 0`). Ranks span `0..9`.

- **Primary score**: `guild.rank` (`0..9`, descending).
- **Secondary tie-breaker**: `guild.reputation` (resolved from `rpg.guilds[group].reputation` or `rpg.factions[factionId]`, descending).
- **Milestone**: `milestoneAt` (ascending), then `playerId` (ascending).
- **Display badge**: Rank title (and ` · <variantName>` for `temple` and `knights` when a specific Divine temple or Knightly Order variant is sworn).

| Board ID | Guild Group | Label | Unit |
| :--- | :--- | :--- | :--- |
| `guild:fighters` | `fighters` | Fighters Guild | `rank` |
| `guild:mages` | `mages` | Mages Guild | `rank` |
| `guild:thieves` | `thieves` | Thieves Guild | `rank` |
| `guild:brotherhood` | `brotherhood` | Dark Brotherhood | `rank` |
| `guild:temple` | `temple` | Temples | `rank` |
| `guild:knights` | `knights` | Knightly Orders | `rank` |

### 2.4 Classic Daggerfall Skill Boards (35)

Derived directly from `SKILLS` in `client/gameplay/character/rules.js`. Each skill has a canonical board ID of `skill:<slug>` where `<slug>` is the lowercase hyphenated form of the skill name.

- **Eligibility**: `skillValue >= 1` (`minScore: 1`, `maxScore: 100`).
- **Primary score**: Skill level (`0..100`, descending).
- **Secondary tie-breaker**: `totalSkill` (descending).
- **Milestone**: `skillMilestones[skill]` (ascending — preserves first-to-100 order), then `playerId` (ascending).
- **Display badge**: `'Master'` when `score >= 100`, otherwise `null`.

| # | Skill Name (`SKILLS`) | Board ID | Category |
| :-: | :--- | :--- | :--- |
| 1 | Medical | `skill:medical` | Body |
| 2 | Etiquette | `skill:etiquette` | Languages |
| 3 | Streetwise | `skill:streetwise` | Languages |
| 4 | Jumping | `skill:jumping` | Body |
| 5 | Orcish | `skill:orcish` | Languages |
| 6 | Harpy | `skill:harpy` | Languages |
| 7 | Giantish | `skill:giantish` | Languages |
| 8 | Dragonish | `skill:dragonish` | Languages |
| 9 | Nymph | `skill:nymph` | Languages |
| 10 | Daedric | `skill:daedric` | Languages |
| 11 | Spriggan | `skill:spriggan` | Languages |
| 12 | Centaurian | `skill:centaurian` | Languages |
| 13 | Impish | `skill:impish` | Languages |
| 14 | Lockpicking | `skill:lockpicking` | Stealth |
| 15 | Mercantile | `skill:mercantile` | Stealth |
| 16 | Pickpocket | `skill:pickpocket` | Stealth |
| 17 | Stealth | `skill:stealth` | Stealth |
| 18 | Swimming | `skill:swimming` | Body |
| 19 | Climbing | `skill:climbing` | Body |
| 20 | Backstabbing | `skill:backstabbing` | Combat |
| 21 | Dodging | `skill:dodging` | Combat |
| 22 | Running | `skill:running` | Body |
| 23 | Destruction | `skill:destruction` | Magic |
| 24 | Restoration | `skill:restoration` | Magic |
| 25 | Illusion | `skill:illusion` | Magic |
| 26 | Alteration | `skill:alteration` | Magic |
| 27 | Thaumaturgy | `skill:thaumaturgy` | Magic |
| 28 | Mysticism | `skill:mysticism` | Magic |
| 29 | Short Blade | `skill:short-blade` | Combat |
| 30 | Long Blade | `skill:long-blade` | Combat |
| 31 | Hand-to-Hand | `skill:hand-to-hand` | Combat |
| 32 | Axe | `skill:axe` | Combat |
| 33 | Blunt Weapon | `skill:blunt-weapon` | Combat |
| 34 | Archery | `skill:archery` | Combat |
| 35 | Critical Strike | `skill:critical-strike` | Combat |

### 2.5 Player-Founded Orders Board (`orders`)

Projected from `world_state` entries with key prefix `pguild:`. Orders with at least one valid member are eligible. `combinedLevel` and `combinedTotalSkill` count only members who are publicly listed, `leaderName` is `"Unknown"` when the leader is hidden, banned or not listed, and `createdAt` is epoch milliseconds.

| Sort Key (`sort`) | Primary Metric | Secondary Tie-Breaker | Further Tie-Breakers |
| :--- | :--- | :--- | :--- |
| `members` *(default)* | `memberCount` DESC | `combinedLevel` DESC | `treasury` DESC, `createdAt` ASC, name, `id` |
| `level` | `combinedLevel` DESC | `memberCount` DESC | `treasury` DESC, `createdAt` ASC, name, `id` |
| `treasury` | `treasury` (gold) DESC | `memberCount` DESC | `combinedLevel` DESC, `createdAt` ASC, name, `id` |

---

## 3. Public HTTP API Reference

Designed for direct consumption by the Next.js `/hiscores` web page and external read-only clients. All endpoints accept only `GET` and `HEAD`.

### 3.1 Common Headers, Caching & Rate Limiting

- **Content-Type**: `application/json; charset=utf-8`
- **Security**: `X-Content-Type-Options: nosniff`
- **Caching**:
  - `200 OK`: `Cache-Control: public, max-age=15, stale-while-revalidate=30`
  - All error responses (`4xx`, `5xx`): `Cache-Control: no-store`
- **CORS**: Optional `Access-Control-Allow-Origin` when `corsOrigin` is configured (`Vary: Origin` is added for non-wildcard origins).
- **Rate Limiting**: Per-IP sliding-window limiter defaulting to **120 requests per 60 seconds** (`120 req/min`). Exceeding the limit returns `429 Too Many Requests` with a `Retry-After` header (in seconds) and `{ "error": "rate limit exceeded", "retryAfter": <seconds> }`. Proxy IP extraction via `X-Forwarded-For` is opt-in (`trustProxy: true`).
- **Input Limits**: Query/filter strings (`q`, `class`, `race`) are trimmed and capped at 64 characters; character names are trimmed and capped at 64 Unicode code points; `limit` is clamped to `1..100` (default `25`); `page` is clamped to `>= 1` (default `1`).

### 3.2 Status Codes

| Status | Meaning | Example Body |
| :---: | :--- | :--- |
| `200` | Success (JSON payload; empty body for `HEAD`) | Endpoint-specific JSON |
| `400` | Invalid URL, unknown board, invalid `sort`, malformed percent-encoding, or missing/invalid character name(s) | `{ "error": "unknown board", "board": "foo" }` |
| `404` | Character not found (including hidden/banned/uncreated characters), unknown subpath, or missing compare participant(s) | `{ "error": "character not found" }` |
| `405` | HTTP method other than `GET` or `HEAD` (includes `Allow: GET, HEAD`) | `{ "error": "method not allowed" }` |
| `429` | Per-IP rate limit exceeded (includes `Retry-After` header) | `{ "error": "rate limit exceeded", "retryAfter": 12 }` |
| `500` | Internal engine/store failure (internal details masked) | `{ "error": "hiscores unavailable" }` |

### 3.3 Endpoints

#### `GET /api/hiscores/categories`

Returns the grouped catalog of all Core, Classic Guild, Classic Skill, and Player Order boards.

```json
{
  "version": 1,
  "totalClassicPlaces": 15251,
  "groups": [
    {
      "id": "core",
      "label": "Core Chronicles",
      "boards": [
        {
          "id": "overall",
          "label": "Overall",
          "group": "core",
          "unit": "pts",
          "description": "Total skill level summed across all 35 classic Daggerfall skills.",
          "minScore": 0
        }
      ]
    },
    { "id": "guilds", "label": "Classic Guilds", "boards": ["..."] },
    { "id": "skills", "label": "Classic Skills", "boards": ["..."] },
    { "id": "orders", "label": "Player Orders", "boards": ["..."] }
  ]
}
```

#### `GET /api/hiscores?board=overall&page=1&limit=25&class=&race=&q=`
#### `GET /api/hiscores/board/:board`

Returns a paginated, optionally filtered leaderboard. Both routes accept the same query parameters (`page`, `limit`, `class` / `className`, `race`, `q`). When `board=orders`, delegates to the Orders board response.

- `rank` / `globalRank`: Character's unfiltered rank on the board.
- `filteredRank`: Character's 1-based position within the currently filtered result set.
- `q` matches case-insensitively against character `name` or `orderTag`.

```json
{
  "version": 1,
  "board": "overall",
  "label": "Overall",
  "unit": "pts",
  "generatedAt": "2026-11-25T14:00:00.000Z",
  "total": 412,
  "page": 1,
  "pages": 17,
  "limit": 25,
  "filters": {
    "className": null,
    "race": null,
    "query": null
  },
  "entries": [
    {
      "rank": 1,
      "globalRank": 1,
      "filteredRank": 1,
      "playerId": 42,
      "name": "Barenziah",
      "className": "Spellsword",
      "race": "Dark Elf",
      "level": 24,
      "score": 2140,
      "secondary": 24,
      "orderTag": "BAY",
      "badge": "Spellsword",
      "milestoneAt": 1764000000000
    }
  ]
}
```

#### `GET /api/hiscores/orders?sort=members&page=1&limit=25&q=`

Returns paginated player-founded Orders. `sort` must be one of `members` (default), `level`, or `treasury`; any other non-empty value returns `400` with `{ "error": "invalid sort", "allowed": ["members", "level", "treasury"] }`. `q` matches Order `name` or `tag`.

```json
{
  "version": 1,
  "board": "orders",
  "sort": "members",
  "label": "Player Orders",
  "unit": "Members",
  "generatedAt": "2026-11-25T14:00:00.000Z",
  "total": 18,
  "page": 1,
  "pages": 1,
  "limit": 25,
  "filters": { "query": null },
  "entries": [
    {
      "rank": 1,
      "globalRank": 1,
      "filteredRank": 1,
      "id": "ord-1",
      "name": "Knights of the Dragon",
      "tag": "DRG",
      "leaderName": "Lysandus",
      "memberCount": 14,
      "combinedLevel": 196,
      "combinedTotalSkill": 18420,
      "treasury": 45000,
      "createdAt": 1763000000000
    }
  ]
}
```

#### `GET /api/hiscores/player/:name` (and `GET /api/hiscores/player?name=:name`)

Returns a single character's complete public Chronicles profile—including all core board ranks, all 35 skills with individual ranks and milestone timestamps, and classic guild standings. Lookup is case-insensitive. Hidden, banned, uncreated, or non-existent characters return `404`.

```json
{
  "version": 1,
  "generatedAt": "2026-11-25T14:00:00.000Z",
  "player": {
    "playerId": 42,
    "name": "Barenziah",
    "className": "Spellsword",
    "race": "Dark Elf",
    "level": 24,
    "totalSkill": 2140,
    "order": { "id": "ord-1", "name": "Knights of the Dragon", "tag": "DRG", "rank": "Leader" },
    "updatedAt": 1764000000000
  },
  "summary": {
    "overallRank": 1,
    "levelRank": 2,
    "explorationRank": 5,
    "questsRank": 3,
    "slayerRank": 4,
    "wantedRank": null,
    "admiraltyRank": 1,
    "placesDiscovered": 312,
    "totalClassicPlaces": 15251,
    "questsCompleted": 48,
    "monstersSlain": 920,
    "infamy": 0,
    "worstRegion": null,
    "admiraltyScore": 640,
    "admiraltyRankTitle": "Commodore",
    "shipsSunk": 19
  },
  "skills": [
    {
      "skill": "Long Blade",
      "slug": "long-blade",
      "value": 100,
      "rank": 1,
      "totalRanked": 412,
      "milestoneAt": 1763950000000
    }
  ],
  "guilds": [
    {
      "group": "fighters",
      "rank": 7,
      "title": "Guardian",
      "variantName": null,
      "boardRank": 2
    }
  ]
}
```

#### `GET /api/hiscores/compare?a=HeroA&b=HeroB`

Returns a side-by-side comparison of two characters across all 7 core boards and all 35 classic skills, with per-row `delta` (`a - b`), `winner` (`"a"`, `"b"`, or `"tie"`), and aggregate `wins` tally. Returns `400` if either `a` or `b` is missing/invalid, and `404` with `{ "error": "character not found: ...", "missing": [...] }` if either character cannot be found or is hidden.

```json
{
  "ok": true,
  "version": 1,
  "generatedAt": "2026-11-25T14:00:00.000Z",
  "a": { "...": "PlayerProfile" },
  "b": { "...": "PlayerProfile" },
  "core": [
    {
      "id": "overall",
      "label": "Overall",
      "aScore": 2140,
      "bScore": 1980,
      "aRank": 1,
      "bRank": 4,
      "delta": 160,
      "winner": "a"
    }
  ],
  "skills": [
    {
      "skill": "Long Blade",
      "slug": "long-blade",
      "aValue": 100,
      "bValue": 88,
      "aRank": 1,
      "bRank": 9,
      "delta": 12,
      "winner": "a"
    }
  ],
  "wins": { "a": 28, "b": 11, "ties": 3 }
}
```

---

## 4. In-Game WebSocket Actions & Events

Registered by the `chronicles` RPG feature (`server/rpg/chronicles.js`). All actions share a per-player token-bucket rate limiter (**2 req/sec**, burst **10**). Every response is delivered to the requesting player as a notification with `{ kind: 'chronicles', view, ... }`; asynchronous query failures deliver `{ kind: 'chronicles', view, error }`.

| Action Verb | Client Args | Server Notification Payload (`kind: 'chronicles'`) |
| :--- | :--- | :--- |
| `chronicles.categories` | `{}` | `{ kind: 'chronicles', view: 'categories', categories, selfPrivacy: { hidden } }` |
| `chronicles.board` | `{ board?, page?, limit?, className?, race?, query? }` | `{ kind: 'chronicles', view: 'board', data, selfName, selfPrivacy: { hidden } }` |
| `chronicles.orders` | `{ sort?, page?, limit?, query? }` | `{ kind: 'chronicles', view: 'orders', data }` |
| `chronicles.player` | `{ name? }` *(defaults to self)* | `{ kind: 'chronicles', view: 'player', name, profile, isSelf, selfPrivacy: { hidden } }` |
| `chronicles.compare` | `{ a?, b }` *(`a` defaults to self)* | `{ kind: 'chronicles', view: 'compare', comparison }` |
| `chronicles.privacy` | `{ hidden: boolean }` | `{ kind: 'chronicles', view: 'privacy', hidden, text }` |

Toggling `chronicles.privacy` updates `p.rpg.chronicles.hidden`, marks the player dirty, synchronizes the `hiscores` table (deleting the row when `hidden: true`, upserting when `hidden: false`), and invalidates the engine cache after commit.

---

## 5. Privacy & Moderation Contract

### 5.1 Fields NEVER Exposed

Neither the `hiscores` / `hiscores_orders` projection tables nor any HTTP or WebSocket response may ever include:

- `accountId` (or account username, email, or recovery hashes)
- `tokenHash` (or session tokens)
- `x`, `z`, `yaw` (live or last-known world coordinates / facing)
- Live `location` (current town, dungeon, tavern, or ship coordinates)
- `inventory` (items, gold on hand, bank balances, equipped gear, or spellbook contents)
- Raw `rpg` JSON blob

### 5.2 Automatic Exclusions

A character is automatically omitted from all boards, player lookups, and comparisons (returning `404` on direct HTTP lookup) whenever any of the following holds:

1. **Banned account**: The linked account has a non-null `banned_at` timestamp (passed via `bannedAccountIds`).
2. **Uncreated character**: `rpg.character.created` is falsy (characters still in creation or blank slots).
3. **Player opt-out**: `rpg.chronicles.hidden === true` (set via `chronicles.privacy`).

---

## 6. Storage & Operations

### 6.1 Indexed Projection Tables (SQLite & PostgreSQL)

Both SQLite (`server/hiscores/sqlite-store.js`) and PostgreSQL (`server/storage/schema.sql` / `server/hiscores/postgres-store.js`) maintain two dedicated, read-optimized projection tables so leaderboard queries never scan `players.rpg`:

- **`hiscores`**: Keyed by `player_id` (foreign key to `players(id) ON DELETE CASCADE` in PostgreSQL), storing projected scalar metrics (`level`, `total_skill`, `places_discovered`, `trips`, `quests_completed`, `monsters_slain`, `infamy`, `worst_region`, `admiralty_score`, `admiralty_rank_title`, `ships_sunk`), order tag/name/rank, `skills` / `skill_milestones` / `guilds` JSON columns (`JSONB` + GIN index on `guilds` in PostgreSQL; `*_json TEXT` in SQLite), `milestone_at`, and `updated_at`. Composite B-tree indexes cover `name_key` and every core board sort order (`overall`, `level`, `exploration`, `quests`, `slayer`, `wanted`, `admiralty`).
- **`hiscores_orders`**: Keyed by `order_id`, storing `name`, `name_key`, `tag`, `leader_name`, `member_count`, `combined_level`, `combined_total_skill`, `treasury`, `created_at`, and `updated_at`, with composite indexes on `name_key`, `member_count`, `combined_level`, and `treasury`.

### 6.2 Snapshot Cache

`server/hiscores/engine.js` caches the ranked in-memory index across all boards for **30 s** (`DEFAULT_TTL_MS = 30_000`), providing O(1) lookup by character name/ID and O(1) rank retrieval. Concurrent cache misses coalesce onto a single in-flight snapshot load; privacy toggles and rebuilds call `engine.invalidate()` to mark the cache dirty immediately. Every periodic save that changes a character (every 5 s while players are online) also invalidates it, so on a live server the next request rebuilds at most once per save interval (about 175 ms for 10,000 characters on a laptop).

### 6.3 Operator CLI (`tools/hiscores.mjs`)

Operators can inspect and rebuild the projection tables offline or against a running database using:

```bash
node tools/hiscores.mjs rebuild   # Full transactional rebuild of hiscores & hiscores_orders from players/world_state
node tools/hiscores.mjs top       # Display top-ranked characters for a board (default: overall)
node tools/hiscores.mjs player    # Inspect a character's public Chronicles profile & ranks
node tools/hiscores.mjs orders    # Display top Player Orders by members, level, or treasury
node tools/hiscores.mjs stats     # Show indexed character count, order count, and cache/table freshness
```
