# Public hosting

How to run daggerfallworld as a public online server: one Node process behind a TLS reverse proxy, with persistent SQLite state on a volume and the operator's own game data mounted read-only. Nothing here provisions or pays for a host. Bring a Linux machine with Docker (or Node ≥ 22.13), a domain name and open ports 80/443.

## Shape

```
browser ──https/wss──▶ Caddy (TLS, :443) ──http──▶ node server/main.js (:8080)
                                                     ├─ /            game launcher or optional static site
                                                     ├─ /play.html   game client (client/)
                                                     ├─ /api/*       accounts (server/accounts.js)
                                                     └─ /ws          game socket (session cookie required)
                                                    /data      SQLite: daggerfallworld.db, accounts.db (volume)
                                                    /gamedata  operator ARENA2 folder (read-only)
```

- **One origin.** The site, the game, the API and the WebSocket share one host. The client always uses the page's own origin. It is never pointed at another server.
- **Accounts are the way in.** Players create an account (name + password) or sign in on `/play.html`. The game socket only accepts upgrades that carry a valid session cookie for an account that is not banned. Guest entry exists only as a development escape hatch (`ALLOW_GUESTS=1`, accepted only with `npm run dev`).

## Accounts and sessions

| Item | Behaviour |
| --- | --- |
| Account names | 3–20 ASCII letters, digits, `_` and `-`, starting with a letter. Case-insensitively unique. Staff-like names (`admin`, `gm`, …) are reserved. |
| Passwords | 10–256 characters, must not contain the account name. Hashed with scrypt (N=2¹⁵, r=8, p=1, 16-byte salt). Login timing is the same for unknown names. |
| Session | 256-bit random token in cookie `__Host-dfw_session`: `HttpOnly; Secure; SameSite=Strict; Path=/`, no `Domain`. Only its SHA-256 is stored. 30-day sliding expiry, renewed at most daily, up to 10 sessions per account (oldest dropped). |
| CSRF | POSTs must be `application/json` and same-origin (`Origin` matches `Host`, or equals `PUBLIC_ORIGIN` if set; `Sec-Fetch-Site` must not be cross-site). |
| Rate limits | Per client IP: 120 API requests/min, 10 login attempts/5 min, 5 registrations/hour. Per account name: 8 failed logins/15 min. Answers `429` with `Retry-After`. |

API (JSON, same origin):

| Request | Result |
| --- | --- |
| `GET /api/me` | `{user: {id, username} \| null, muted?: {until \| null}}`. The client calls this at startup. |
| `POST /api/register` `{username, password}` | `201 {user}` and sets the cookie; `400 {error, field}`, `409` name taken. |
| `POST /api/login` `{username, password}` | `200 {user}` and sets the cookie; `401` wrong name or password, `403` banned. |
| `POST /api/logout` | Deletes the server session and clears the cookie. |

Password change, sign-out everywhere, recovery codes, account deletion, `GET /api/account` and `GET /api/stats` are listed in [server/README.md](../server/README.md#account-request-flow).

Browsers accept `Secure` cookies from `http://localhost` and `http://127.0.0.1`, so local development over loopback uses the same cookie as production. If a browser refuses the cookie on another plain-HTTP dev host, use `COOKIE_SECURE=0 npm run dev` (dev only).

## Moderation

The operator CLI works against the live database while the server runs. Bans and session revocations reach the running server within about 2 seconds and disconnect the player's live sockets.

```sh
# Docker:
docker compose -f deploy/compose.yaml exec game node server/accounts.js list
# Bare Node (same ACCOUNTS_DB_PATH as the server):
node server/accounts.js list
node server/accounts.js show <name>
node server/accounts.js mute <name> [minutes] [reason]   # chat only; no minutes = until unmuted
node server/accounts.js unmute <name>
node server/accounts.js ban <name> [reason]              # refuses login and /ws, ends all sessions
node server/accounts.js unban <name>
node server/accounts.js revoke <name>                    # sign out everywhere (e.g. after a password leak)
```

Every action is recorded in `moderation_log` with the operator's user name.

## Configuration

| Variable | Default | Public deployment |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | `0.0.0.0` / `8080` inside the container. Do not publish the port. Only the proxy reaches it. |
| `DB_PATH` | `server/data/daggerfallworld.db` | `/data/daggerfallworld.db` (game state) |
| `ACCOUNTS_DB_PATH` | `server/data/accounts.db` | `/data/accounts.db` (identity, kept in a separate file) |
| `ARENA2_DIR` | unset | `/gamedata/arena2`. The operator's ARENA2 folder, mounted read-only. Startup fails if it is missing or inside `client/` or `website/out/`. |
| `PUBLIC_ORIGIN` | unset | `https://<your domain>`. Exact origin required on account POSTs. |
| `TRUST_PROXY` | `0` | `1`. Use `X-Forwarded-For` (right-most entry) for rate limits and `X-Forwarded-Proto` for HTTPS. Enable it **only** when a proxy you control is the sole way in. |
| `REQUIRE_HTTPS` | `0` | `1`. Refuse login/register that did not arrive over HTTPS. |
| `COOKIE_SECURE` | `1` | Leave at `1`. `0` is only accepted with `--dev`. |
| `ALLOW_GUESTS` | `0` | Leave at `0`. `1` is only accepted with `--dev`, for local testing without accounts. |
| `MAX_PLAYERS` | `2000` | Size to your machine. `0` removes the cap. |

The Dockerfile sets these defaults. `deploy/compose.yaml` adds `PUBLIC_ORIGIN` from `DFW_DOMAIN`.

## Game data

The game needs the operator's own legally obtained Daggerfall ARENA2 folder. It is never part of the image, the repository or anything the web server serves.

- Put it on the host outside the checkout, for example `/srv/daggerfall/arena2` (owned by root, mode `0755`/`0644`).
- Set `ARENA2_HOST_DIR` in `deploy/.env`. Compose mounts it read-only at `/gamedata/arena2`.
- The static handler serves only `client/` and `website/out/`, so the mount is not reachable over HTTP. `.dockerignore` keeps `gamedata/` and `.ref/` out of the build context.

## Deploying with Docker Compose

1. Point DNS `A`/`AAAA` records for your domain at the machine.
2. Configure:
   ```sh
   cp deploy/env.example deploy/.env
   $EDITOR deploy/.env        # DFW_DOMAIN, ARENA2_HOST_DIR, optional ACME_EMAIL, MAX_PLAYERS
   ```
3. Start:
   ```sh
   docker compose -f deploy/compose.yaml --env-file deploy/.env up -d --build
   docker compose -f deploy/compose.yaml logs -f game
   ```
   Caddy obtains and renews the certificate, redirects HTTP to HTTPS, adds HSTS and proxies `/ws` upgrades.
4. Check: `https://<domain>/api/me` returns `{"user":null}`. Create an account on `/play.html` and enter the town.

The game container runs as the unprivileged `node` user with a read-only root filesystem and no capabilities. Only `/data` (named volume `dfw-data`) is writable.

Updating: `git pull`, then rerun the `up -d --build` command. `SIGTERM` saves positions, closes sockets with code 1001, and checkpoints and closes both databases. Compose waits up to 20 s.

### Without Docker

Run `npm ci`, then run `node server/main.js` under a service manager (systemd `Restart=on-failure`, `KillSignal=SIGTERM`) with the variables above. Point any TLS reverse proxy at `127.0.0.1:8080`. It must pass WebSocket upgrades on `/ws`, overwrite (not append to) `X-Forwarded-For` with the client address, and set `X-Forwarded-Proto`. Keep `HOST=127.0.0.1` in that setup.

## Backups

Both databases use WAL mode. Do not copy the `.db` files of a running server with `cp`. Use one of these:

- `deploy/backup.sh [dir]` takes a consistent online copy of both databases (`VACUUM INTO`) from the running container into `dir` (default `./backups`), mode `0600`, and keeps the newest 14 sets. Schedule it with cron, for example `17 3 * * * cd /srv/daggerfallworld && deploy/backup.sh /var/backups/dfw`.
- Or stop the stack and snapshot the `dfw-data` volume.

Copy backups off the machine. `accounts.db` holds password hashes and session hashes, so encrypt it at rest and limit who can read it. To restore, stop the stack, put the files back into the volume as `daggerfallworld.db` / `accounts.db` (delete any stale `-wal`/`-shm`) and start it again. Restoring an older `accounts.db` revives sessions that existed at the time. Run `node server/accounts.js revoke <name>` for affected accounts if that matters.

## Before opening to the public

- Publish a privacy notice and terms. You store account names, password hashes, IP addresses in memory for rate limiting, and a moderation log of chat messages with their recipients. See the checklist in [research/04-legal-and-licences.md](research/04-legal-and-licences.md#6-running-an-online-service-accounts--chat-euuk-users-checklist).
- Decide who moderates and how players report abuse.
- No e-mail is collected. A forgotten password is reset with the recovery code shown once at registration (`POST /api/recover`). An operator cannot reset a password, only revoke sessions or ban.
- The server is a single process with in-memory world state. Scale vertically and keep `MAX_PLAYERS` realistic.
