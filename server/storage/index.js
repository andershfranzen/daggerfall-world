// Storage backend selector: defaults to zero-config SQLite (node:sqlite) and
// switches to PostgreSQL when DATABASE_URL (or ACCOUNTS_DATABASE_URL) starts
// with postgres:// or postgresql://, or when a pg Pool is explicitly injected.
import { openStore } from '../db.js';
import { openAccountStore, ACCOUNT_DEFAULTS } from '../accounts.js';
import {
  openPostgresGameStore,
  createBufferedGameStore,
  loadSchemaSql,
} from './postgres-game.js';
import {
  openPostgresAccountStore,
  MODERATION_CHANNEL,
} from './postgres-accounts.js';

export {
  openPostgresGameStore,
  createBufferedGameStore,
  openPostgresAccountStore,
  MODERATION_CHANNEL,
  loadSchemaSql,
};

export function isPostgresUrl(value) {
  return typeof value === 'string' && /^postgres(?:ql)?:\/\//i.test(value.trim());
}

export function detectBackend({ databaseUrl, pool = null, env = process.env, envVar = 'DATABASE_URL' } = {}) {
  if (pool) return 'postgres';
  const url = databaseUrl ?? env?.[envVar];
  return isPostgresUrl(url) ? 'postgres' : 'sqlite';
}

/**
 * Opens the game storage backend.
 * - SQLite (default): uses `dbPath` (defaults to `:memory:` only if passed, otherwise caller's path).
 * - PostgreSQL: selected when `databaseUrl` / `DATABASE_URL` is a postgres(ql):// URL or `pool` is passed.
 *   Set `buffered: true` (default for PostgreSQL) to wrap with `createBufferedGameStore`.
 */
export async function openGameStorage(options = {}) {
  const {
    dbPath,
    databaseUrl,
    pool = null,
    poolOptions,
    applySchema = true,
    buffered = true,
    onError = null,
    env = process.env,
    now,
  } = options;

  const url = databaseUrl ?? env?.DATABASE_URL;
  if (pool || isPostgresUrl(url)) {
    const pgStore = await openPostgresGameStore({
      connectionString: url,
      pool,
      poolOptions,
      applySchema,
      ...(now ? { now } : {}),
    });
    return buffered ? createBufferedGameStore(pgStore, { onError }) : pgStore;
  }

  if (!dbPath) {
    throw new Error('openGameStorage requires dbPath when using the SQLite backend');
  }
  const sqliteStore = openStore(dbPath);
  return Object.assign(sqliteStore, { backend: 'sqlite' });
}

/**
 * Opens the account storage backend.
 * - SQLite (default): uses `dbPath` (defaults to `ACCOUNT_DEFAULTS.dbPath`).
 * - PostgreSQL: selected when `databaseUrl` / `ACCOUNTS_DATABASE_URL` / `DATABASE_URL`
 *   is a postgres(ql):// URL or `pool` is passed.
 */
export async function openAccountStorage(options = {}) {
  const {
    dbPath = ACCOUNT_DEFAULTS.dbPath,
    databaseUrl,
    pool = null,
    poolOptions,
    applySchema = true,
    env = process.env,
    now,
  } = options;

  const url = databaseUrl ?? env?.ACCOUNTS_DATABASE_URL ?? env?.DATABASE_URL;
  if (pool || isPostgresUrl(url)) {
    return openPostgresAccountStore({
      connectionString: url,
      pool,
      poolOptions,
      applySchema,
      ...(now ? { now } : {}),
    });
  }

  const sqliteStore = openAccountStore(dbPath);
  return Object.assign(sqliteStore, { backend: 'sqlite' });
}
