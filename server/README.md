# daggerfallworld server

The authoritative server for the shared world. One Node process serves the website, the game client, the account API and the game WebSocket on one origin. It owns accounts, characters, movement, chat and every gameplay rule. Players only open the public address; this file is for operators and contributors.

- `node:http` serves the game client from `client/` and the exported Next.js website from `website/out/`. It answers `/api/*` through [accounts.js](accounts.js) and upgrades `/ws` to a WebSocket (`ws` package) for signed-in accounts.
- `node:sqlite` stores characters and their game state in `DB_PATH`, and accounts and sessions in a separate `ACCOUNTS_DB_PATH`.
- Gameplay features in [rpg/](rpg/) are listed in [rpg/features.js](rpg/features.js). They read world data from the operator's own `ARENA2_DIR`, which is never served.
- Node ≥ 22.13 (developed on Node 26).

## Commands

From a clean checkout:

```sh
npm ci             # or npm install
ARENA2_DIR=/srv/daggerfall/arena2 npm start
                   # http://127.0.0.1:8080/ site, /play.html game, /api accounts, /ws multiplayer
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the standalone game in development mode. Reload the browser after editing game modules. |
| `npm start` | Serves the launcher, game and account APIs. Set `SITE_DIR` to serve an optional static landing site. |
| `npm test` | `node --test test/*.test.mjs` uses a temp DB, a temp client dir and a fake export. It needs no build. |

`npm run dev` and `npm start` read the same environment variables. Both bind `127.0.0.1:8080` by default, so run one at a time or set `PORT`.

## Options (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARENA2_DIR` | unset | The operator's ARENA2 folder, read-only and never served. Features read world data from it: the map of towns for travel, building collision and the doors into interiors and dungeons. Without it, travel offers only a starter list, collision falls back to an open plane and doors cannot be used. Startup fails if it is unreadable or inside `client/` or `website/out/`. |
| `WOD_PATH` | `gamedata/world-of-daggerfall/` | Extracted World of Daggerfall source tree used for named sites, scenery and author placements. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback behind a reverse proxy on the same machine. A non-loopback bind without `TRUST_PROXY` prints a warning. |
| `PORT` | `8080` | TCP port (`0` = random free port). |
| `DB_PATH` | `server/data/daggerfallworld.db` | Characters and game state (SQLite). `*.db` files are git-ignored. |
| `ACCOUNTS_DB_PATH` | `server/data/accounts.db` | Accounts, sessions and the moderation log, in a separate SQLite file. |
| `PUBLIC_ORIGIN` | unset | Public `https://` origin. When set, account POSTs must come from exactly this origin. |
| `TRUST_PROXY` | `0` | `1` takes the client address from `X-Forwarded-For` (right-most) and the scheme from `X-Forwarded-Proto`. Only when your proxy is the sole way in. |
| `REQUIRE_HTTPS` | `0` | `1` refuses login and registration that did not arrive over HTTPS. |
| `COOKIE_SECURE` | `1` | `0` uses a non-`__Host-` cookie for plain-HTTP dev hosts. Accepted only with `--dev`. |
| `ALLOW_GUESTS` | `0` | `1` lets `/ws` admit unauthenticated guests for local testing. Accepted only with `--dev`. |
| `LOCAL_ASSETS` | on when eligible | `0` turns off the loopback-only ARENA2 preselection described below. |
| `MAX_PLAYERS` | `32` | Concurrent joined players. |
| `WORLD_HALF_EXTENT` | `512` | Positions are clamped to `[-N, N]` metres on x and z. |

**Localhost game files.** On a loopback address (`localhost`, `127.0.0.1` or `[::1]`), `/play.html` offers the server's installed ARENA2 folder automatically, so a local tester does not have to choose it. It uses `ARENA2_DIR`, or `gamedata/DaggerfallGameFiles/arena2/` in the checkout. This convenience turns itself off behind a proxy, with `PUBLIC_ORIGIN`, `REQUIRE_HTTPS` or `NODE_ENV=production`, on a non-loopback `HOST`, or with `LOCAL_ASSETS=0`. Public players always choose their own folder. The routes live under `/local-assets/` ([local-assets.js](local-assets.js), [client/lib/local-assets.js](../client/lib/local-assets.js)). Every request must arrive on a loopback socket with a loopback `Host`, no forwarding headers and a custom header; file reads also need a per-process token. Only allow-listed top-level Daggerfall file names are readable.

Example: `ARENA2_DIR=$HOME/daggerfall/ARENA2 PORT=9000 npm start`. Stop with Ctrl+C or `SIGTERM`. The server saves all characters, closes sockets with code 1001 and closes both databases. In dev mode it also stops Next.js. For a public deployment (TLS proxy, Docker Compose, backups, moderation) see [docs/public-hosting.md](../docs/public-hosting.md).

Everything else (tick rate, timeouts, rate limits) lives in `DEFAULTS` in [game.js](game.js) and can be overridden through `createGameServer(options)`. Options for the website are `clientDir`, `siteDir` (default `website/out/`) and `website`. `website` is dev-only: `{ handle(req, res), upgrade(req, socket, head) }`, wired to Next's `getRequestHandler()` / `getUpgradeHandler()` by `main.js --dev`.

## Routing (one origin)

The standalone server opens the launcher at `/play.html` when visiting `/`. The account API, world map and game socket share that origin. Operators can supply an independent static site using `SITE_DIR`; its index then serves the homepage. Game files in `client/` have priority at their exact paths.

## Static delivery (security)

- Files come only from `client/` and `website/out/`. Nothing else is reachable: not `ARENA2_DIR`, `gamedata/`, `.ref/`, `server/`, `website/app/`, `node_modules/` or either database.
- Only allow-listed extensions are served, with an explicit MIME type, `nosniff` and `Cross-Origin-Resource-Policy: same-origin`: `.html .js .mjs .css .json .map .svg .png .jpg .jpeg .webp .avif .gif .ico .wasm .txt .woff2 .webmanifest .xml`. This keeps `.md` files out, such as `client/hud-contract.md` and `website/public/images/CREDITS.md`.
- Any path segment starting with `.` gets 404, as do `..`, empty segments (`//x`), backslashes, NUL bytes and symlinks whose real path leaves the root. Only GET and HEAD are allowed (405 otherwise) in production.
- The request target is parsed as a path only, so `//evil.example/` is a 404, not a redirect.

## Account request flow

The browser never sees a session token. [client/auth/account.js](../client/auth/account.js) mounts the sign-in panel on `/play.html` and talks to the same origin only:

1. `GET /api/me` at startup returns `{user: {id, username} | null, muted?}`.
2. `POST /api/register` or `POST /api/login` with `{username, password}` as `application/json`. Success sets the `HttpOnly` session cookie (`__Host-dfw_session`). Errors are `{error, field?}`: `400` invalid input, `401` wrong name or password, `403` banned (with the reason), `409` name taken, `429` rate limited with `Retry-After`.
3. The client opens `/ws`. The upgrade carries the cookie, and the server resolves it to an account that is not banned, or refuses with 401.
4. `{type:'join'}` loads or creates the account's character. The display name is the account username.
5. `POST /api/logout` deletes the session on the server and clears the cookie.

Account and password rules, session lifetime, CSRF checks, rate limits and the moderation CLI (`node server/accounts.js list|show|mute|unmute|ban|unban|revoke`) are documented in [docs/public-hosting.md](../docs/public-hosting.md#accounts-and-sessions). Bans and revocations close live sockets with code 4004 within about two seconds; mutes refuse chat.

## Wire protocol (JSON text frames on `ws(s)://<same origin>/ws`)

Client → server:

| Message | Notes |
| --- | --- |
| `{type:'join', claimToken?}` | Must be the first message, sent within 10 s. For an account, the server finds its character or creates one. `claimToken` optionally links an existing dev guest character to the account once. Dev guests (`ALLOW_GUESTS=1`) send `{type:'join', name, token?}` instead. |
| `{type:'input', forward, strafe, yaw}` | `forward`/`strafe` are clamped to -1..1, and the combined vector is normalised to length ≤ 1. Speed is at most 4 m/s. `yaw` is in radians: 0 looks down -z, positive turns right (toward +x). Send about every 100 ms while a key is held; input older than 400 ms counts as idle. Optional traversal fields: `run`, `slow` (walk slowly), `crouch` (booleans; crouch persists), `rise` (-1..1, swim or levitate up/down) and `jump` (a press counter: a changed value is one jump; the first value seen is adopted silently). With the collision feature the server steps the body with the shared rule in `client/lib/locomotion.js` (gravity, jumping, falling damage, crouching, climbing, swimming, breath, levitation). |
| `{type:'chat', text}` | Trimmed, control characters stripped, 1–200 chars, at most 1/s with a burst of 5. Reaches players in the speaker's location. Refused while the account is muted. |
| `{type:'action', verb, args, seq?}` | Gameplay intent such as `inventory.equip` or `npc.talk`, at most 10/s with a burst of 20. With `seq`, the server replies `{type:'actionResult', seq, verb, ok, error?}`. See [docs/gameplay-protocol.md](../docs/gameplay-protocol.md). |

Server → client:

| Message | Notes |
| --- | --- |
| `{type:'welcome', id, token, account?, player}` | `token` is `null` for accounts; guests store theirs to rejoin. |
| `{type:'state', location, players:[{id,name,x,z,yaw,moving,across?,y?,stance?,speed?}]}` | Positions in the viewer’s `location` coordinate system, including visible players across an outdoor boundary. Sent at 12.5 Hz when positions change and at least once a second. Metres, rounded to mm. `y` is the foot height; `stance` is `run`, `slow`, `crouch`, `air`, `climb`, `swim` or `levitate` (absent while walking); `speed` is the horizontal m/s actually covered while moving. |
| `{type:'rpg', selfId, character, entities, peers}` | Your private character state plus the public entities and peers in your location, sent on change. |
| `{type:'gameEvent', event}` | A private or nearby gameplay event. |
| `{type:'chat', name, text}` | Location chat, the sender included. |
| `{type:'error', message}` | Non-fatal (bad JSON, bad input, chat too long or fast, muted…). Also sent right before a fatal close. |

Movement is server-authoritative. The server integrates on a monotonic clock at 25 Hz and clamps `dt` after stalls. Clients render or interpolate the snapshots instead of trusting local prediction.

Fatal close codes (an `error` message with the same text is sent first):

| Code | Reason | Client action |
| --- | --- | --- |
| 1001 | server shutting down | retry later |
| 1013 | server full | retry later |
| 4000 | signed in from another session | the same character joined elsewhere; the newer session wins |
| 4001 | join timeout or protocol error | reconnect and join promptly |
| 4002 | rate limit exceeded | message flood (budget 40 msg/s, burst 80) |
| 4003 | invalid token | dev guests only: forget the stored token and join again |
| 4004 | account access revoked | banned, signed out by an operator, or unusable account name; sign in again |

Other guards:
- Max frame 4 KB (larger frames close with 1009).
- Binary frames are rejected.
- A browser `Origin` header must match `Host` (no cross-site WebSocket). Clients without an Origin header, such as Node tools, are allowed.
- Ping/pong every 15 s drops dead sockets.

## Persistence

- `DB_PATH`: table `players(id, token_hash, name, x, z, yaw, created_at, last_seen, rpg)`, where `rpg` is the JSON character state owned by the features, and `account_characters(account_id, player_id, username, linked_at)` linking each account to one character. Characters are saved every 5 s, on each successful action, on disconnect and on shutdown. Each shop’s stock and purse are stored in the same database in `world_state`. Buying or selling writes the character and shop in one transaction.
- `ACCOUNTS_DB_PATH`: accounts with scrypt password hashes, sessions stored as SHA-256 hashes, mutes, bans and `moderation_log`.
- Both use WAL mode. Back them up with `deploy/backup.sh` or `VACUUM INTO`, not by copying a live file.

## Further reading

- [docs/public-hosting.md](../docs/public-hosting.md): deployment, accounts and sessions, moderation, backups.
- [docs/gameplay-protocol.md](../docs/gameplay-protocol.md): how server (`server/rpg/<feature>.js`) and browser (`client/gameplay/<feature>.js`) features plug in.
- [docs/gameplay-coverage.md](../docs/gameplay-coverage.md): which gameplay the integration tests verify, at which layer, and the known gaps.
- [client/hud-contract.md](../client/hud-contract.md): the markup contract for `play.html` and the in-game HUD.
- [docs/browser-architecture.md](../docs/browser-architecture.md): the client design and loading pipeline.

## Limitations

- A single process with in-memory sessions and world state. No horizontal scaling; updates are scoped by location rather than by distance.
- The client is trusted for `yaw`. Parity with the original game is incomplete in every feature; see the coverage document for what is verified.
- No password reset, because no e-mail is collected. Operators can only revoke sessions or ban.
- Rate limits on `/ws` are per connection; account API limits are per client IP and per account name.
- Static files are read fully into memory per request (64 MB cap), with no caching or compression.
