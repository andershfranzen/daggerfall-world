# PostgreSQL Backend & Migration Guide

Daggerfall World ships with **SQLite (`node:sqlite`)** as its zero-config default for local development, single-node deployments, and fast automated tests. For production deployments that need concurrent multi-process writers (game server, website, operator CLI), managed backups/PITR, JSONB indexing, or future horizontal sharding, you can switch to **PostgreSQL 17+**.

## SQLite vs PostgreSQL

| Capability | SQLite (`node:sqlite`, default) | PostgreSQL (`server/storage/`) |
| --- | --- | --- |
| Setup & local dev | Zero-config single file (`DB_PATH`, `ACCOUNTS_DB_PATH`) | Enabled when `DATABASE_URL` / `ACCOUNTS_DATABASE_URL` starts with `postgres://` or `postgresql://` |
| Concurrent writers | Single writer lock (WAL mode) | MVCC concurrent writers across game server, website, and CLI |
| Cross-process moderation | 2-second `PRAGMA data_version` polling | Instant push via `LISTEN/NOTIFY` on channel `dfw_moderation` |
| Character RPG storage | `TEXT` JSON blob | `JSONB` with `jsonb_path_ops` GIN index (`players_rpg_gin_idx`) |
| World-state prefix queries | `substr(key, ...)` scan | `starts_with(key, $1)` backed by `text_pattern_ops` B-tree index |
| Backups & recovery | Online `VACUUM INTO` (`deploy/backup.sh`) | `pg_dump -Fc`, streaming replication, and WAL-based PITR |
| Horizontal sharding | Single host filesystem | Shared networked DB, read replicas, and sharded world services |

## Architecture

### Storage Modules

- `server/storage/schema.sql` — Additive PostgreSQL DDL defining `schema_migrations`, `players`, `account_characters`, `world_state`, `accounts`, `sessions`, and `moderation_log`, along with constraints and indexes.
- `server/storage/postgres-game.js` — Async PostgreSQL game store matching `server/db.js`'s contract (`create`, `findByToken`, `findByAccount`, `createForAccount`, `claimGuest`, `setAccountUsername`, `saveCharacters`, `loadWorld`, `close`) plus `createBufferedGameStore(pgStore)`.
- `server/storage/postgres-accounts.js` — Async PostgreSQL account store matching `server/accounts.js`'s storage and moderation contract with `LISTEN/NOTIFY` on `dfw_moderation`.
- `server/storage/index.js` — Backend factory (`openGameStorage`, `openAccountStorage`) that keeps SQLite as the default when `DATABASE_URL` is unset.

`pg` is a regular dependency in `package.json` (installed by `npm ci` and in the Docker image); the PostgreSQL modules import it only when PostgreSQL is selected.

### Async Write-Behind Boundary (Protecting the 25 Hz Tick)

`server/rpg/runtime.js` executes gameplay actions synchronously in memory on a 25 Hz tick loop. Waiting on network round-trips to PostgreSQL inside `saveCharacters()` would stall ticks and cause rubber-banding.

`createBufferedGameStore(pgStore, { onError })` bridges synchronous game-loop saves to asynchronous PostgreSQL transactions:

1. **Synchronous validation & snapshotting:** `saveCharacters(players, world)` validates payload size (`MAX_RPG_BYTES`) and serializability immediately and snapshots each dirty player and world-state entry so later tick mutations cannot race with in-flight SQL writes.
2. **Coalesced, serialized commits:** At most one PostgreSQL transaction is in flight at a time. While a transaction is committing, subsequent saves merge into a pending map keyed by `player.id` and world `key` (keeping the latest state) and commit atomically in the next batch.
3. **Error surfacing & automatic retry:** If a commit fails, `onError(err, batch)` is called, `lastError` is updated, and any entry not superseded by a newer snapshot is re-queued and retried automatically every 2 seconds (and by every later save or `flush()`). `server/main.js` logs each failed commit. A dropped connection (PostgreSQL restart, failover, `pg_terminate_backend`) is logged and replaced; it does not stop the server. Queries have no timeout: while PostgreSQL is unreachable but not refusing connections, sign-ins and shutdown wait for it.
4. **Graceful shutdown:** `await store.flush()` (also called automatically by `await store.close()`) drains all pending commits before the process exits.

### Instant Cross-Process Moderation (`LISTEN/NOTIFY`)

When an operator runs `mute`, `unmute`, `ban`, `unban`, or `revokeSessions` through `server/storage/postgres-accounts.js`, the transaction updates the database, appends a `moderation_log` entry, and emits:

```sql
SELECT pg_notify('dfw_moderation', '{"id":...,"accountId":...,"action":"ban",...}');
```

Game server processes subscribe via `await accountStore.listenModeration(fn)`, which holds a dedicated `LISTEN dfw_moderation` connection and invokes `fn(event)` immediately when a ban or session revocation commits from any process. Calling `await accountStore.close()` runs `UNLISTEN dfw_moderation` and releases the connection cleanly.

## Running PostgreSQL with Docker Compose

The default Compose stack (`deploy/compose.yaml`) continues to run SQLite with zero changes. To enable PostgreSQL:

1. Copy `deploy/env.example` to `deploy/.env` and uncomment the PostgreSQL variables:

   ```dotenv
   POSTGRES_DB=daggerfallworld
   POSTGRES_USER=dfw
   POSTGRES_PASSWORD=replace-with-a-strong-random-password
   DATABASE_URL=postgresql://dfw:replace-with-a-strong-random-password@postgres:5432/daggerfallworld
   ```

2. Start the stack with the `postgres` profile:

   ```sh
   docker compose -f deploy/compose.yaml --env-file deploy/.env --profile postgres up -d --build
   ```

## Step-by-Step Migration from SQLite

`tools/migrate-to-postgres.mjs` reads your existing SQLite `daggerfallworld.db` and `accounts.db` files via `node:sqlite` and upserts every row of `players`, `account_characters`, `world_state`, `chat_messages`, `accounts` (including `recovery_hash`), `sessions` and `moderation_log` into PostgreSQL inside transactions, preserving primary keys and advancing PostgreSQL sequences (`setval`). It is idempotent and safe to re-run. Chronicles (`hiscores`) are not copied: the server rebuilds them from `players` on first use.

1. **Dry-run first** (validates all JSON payloads and prints row counts without touching PostgreSQL):

   ```sh
   node tools/migrate-to-postgres.mjs \
     --game-db server/data/daggerfallworld.db \
     --accounts-db server/data/accounts.db \
     --dry-run
   ```

2. **Stop writes to SQLite** (stop the game server cleanly so the SQLite WAL is checkpointed and no in-flight character state is lost).

3. **Run the migration:**

   ```sh
   DATABASE_URL=postgresql://dfw:password@localhost:5432/daggerfallworld \
     node tools/migrate-to-postgres.mjs \
       --game-db server/data/daggerfallworld.db \
       --accounts-db server/data/accounts.db
   ```

   If you store accounts in a separate PostgreSQL database, pass `--accounts-database-url` (or `ACCOUNTS_DATABASE_URL`).

4. **Verify row counts in PostgreSQL:**

   ```sh
   psql "$DATABASE_URL" -c "
     SELECT 'players' AS tbl, COUNT(*) FROM players
     UNION ALL SELECT 'account_characters', COUNT(*) FROM account_characters
     UNION ALL SELECT 'world_state', COUNT(*) FROM world_state
     UNION ALL SELECT 'chat_messages', COUNT(*) FROM chat_messages
     UNION ALL SELECT 'accounts', COUNT(*) FROM accounts
     UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
     UNION ALL SELECT 'moderation_log', COUNT(*) FROM moderation_log;
   "
   ```

5. **Cut over:** Set `DATABASE_URL` (and optionally `ACCOUNTS_DATABASE_URL`) in `deploy/.env`, keep the SQLite backup archived safely, and start the server.

## Backups & Point-in-Time Recovery (PITR)

### Logical Backups (`pg_dump`)

Run scheduled compressed custom-format dumps (equivalent to `deploy/backup.sh` for SQLite):

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f deploy/compose.yaml --profile postgres exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-dfw}" -d "${POSTGRES_DB:-daggerfallworld}" -Fc \
  > "./backups/daggerfallworld-$stamp.dump"
chmod 600 "./backups/daggerfallworld-$stamp.dump"
```

Restore into a clean database with:

```sh
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "./backups/daggerfallworld-$stamp.dump"
```

### Continuous Archiving / PITR

For managed PostgreSQL (RDS, Cloud SQL, Neon, Supabase) or self-hosted `pgBackRest` / `WAL-G`:

- Enable continuous WAL archiving (`archive_mode = on`) and automated daily base backups.
- Retain at least 7–14 days of WAL segments so you can recover to any second prior to an operator error or bad release.
