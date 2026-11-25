// PostgreSQL game store matching server/db.js's logical contract, plus a
// write-behind/write-through coordinator (`createBufferedGameStore`) so the
// synchronous 25 Hz game tick never blocks on database I/O.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  MAX_RPG_BYTES,
  CorruptCharacterError,
  hashToken,
  newToken,
} from '../db.js';

export { SCHEMA_VERSION, MAX_RPG_BYTES, CorruptCharacterError, hashToken, newToken };

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
let cachedSchemaSql = null;

export function loadSchemaSql() {
  if (cachedSchemaSql === null) {
    cachedSchemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  }
  return cachedSchemaSql;
}

export async function createPgPool(connectionString, poolOptions = {}) {
  let pgMod;
  try {
    pgMod = await import('pg');
  } catch (err) {
    const wrapped = new Error(
      "PostgreSQL backend requires the 'pg' package. Install it with: npm install pg",
      { cause: err },
    );
    wrapped.code = 'PG_DRIVER_MISSING';
    throw wrapped;
  }
  const Pool = pgMod.Pool ?? pgMod.default?.Pool;
  if (typeof Pool !== 'function') {
    throw new Error("Loaded 'pg' module does not export Pool");
  }
  return new Pool({ connectionString, ...poolOptions });
}

function parseRpg(raw, id) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new CorruptCharacterError(`character ${id} has unreadable RPG data`);
    }
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptCharacterError(`character ${id} has invalid RPG data`);
  }
  return structuredClone(value);
}

function rowOut(row) {
  if (!row) return null;
  const id = Number(row.id);
  return {
    id,
    name: row.name,
    x: Number(row.x),
    z: Number(row.z),
    yaw: Number(row.yaw),
    rpg: parseRpg(row.rpg, id),
  };
}

function serializeRpg(player) {
  const text = JSON.stringify(player.rpg ?? {});
  if (typeof text !== 'string') throw new Error('character data is not serializable');
  if (Buffer.byteLength(text, 'utf8') > MAX_RPG_BYTES) {
    throw new Error('character data too large to save');
  }
  return text;
}

function serializeWorldEntries(world) {
  return world.map(([key, value]) => {
    if (typeof key !== 'string' || !key || key.length > 200) {
      throw new Error('invalid world state key');
    }
    if (value === null || value === undefined) return [key, null];
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new Error('world state is not serializable');
    if (Buffer.byteLength(text, 'utf8') > MAX_RPG_BYTES) {
      throw new Error('world state too large to save');
    }
    return [key, text];
  });
}

const unrevealedHash = () => hashToken(newToken());
const accountKey = (id) => String(id);

const SEL_PLAYER = 'p.id, p.name, p.x, p.z, p.yaw, p.rpg';

/**
 * Opens a PostgreSQL-backed game store.
 * Accepts either an injected `pool` (for tests or shared pools) or a `connectionString`.
 */
export async function openPostgresGameStore(options = {}) {
  const {
    connectionString,
    pool: injectedPool = null,
    poolOptions = {},
    applySchema = true,
    schemaSql = null,
    now = () => Date.now(),
  } = options;

  if (!injectedPool && !connectionString) {
    throw new Error('openPostgresGameStore requires either pool or connectionString');
  }

  const ownsPool = !injectedPool;
  const pool = injectedPool ?? (await createPgPool(connectionString, poolOptions));
  let closed = false;

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function ensureSchema() {
    const sql = schemaSql ?? loadSchemaSql();
    await transaction(async (client) => {
      await client.query(sql);
    });
  }

  if (applySchema) {
    await ensureSchema();
  }

  return {
    backend: 'postgres',
    pool,
    transaction,
    ensureSchema,

    /** New guest character. Returns the plaintext token once. */
    async create(name, rpg = {}) {
      const token = newToken();
      const ts = now();
      const rpgText = serializeRpg({ rpg });
      const { rows } = await pool.query(
        `INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg)
         VALUES ($1, $2, 0, 0, 0, $3, $4, $5::jsonb)
         RETURNING id, name, x, z, yaw, rpg`,
        [hashToken(token), name, ts, ts, rpgText],
      );
      return { token, row: rowOut(rows[0]) };
    },

    /** Unclaimed guest character for a token, or null. Account-linked characters never match. */
    async findByToken(token) {
      const { rows } = await pool.query(
        `SELECT ${SEL_PLAYER}
           FROM players p
          WHERE p.token_hash = $1
            AND NOT EXISTS (SELECT 1 FROM account_characters a WHERE a.player_id = p.id)`,
        [hashToken(token)],
      );
      return rowOut(rows[0]);
    },

    /** `{id,name,x,z,yaw,rpg,username}` for the account's character, or null. */
    async findByAccount(accountId) {
      const { rows } = await pool.query(
        `SELECT ${SEL_PLAYER}, a.username
           FROM account_characters a
           JOIN players p ON p.id = a.player_id
          WHERE a.account_id = $1`,
        [accountKey(accountId)],
      );
      if (!rows[0]) return null;
      return { ...rowOut(rows[0]), username: rows[0].username };
    },

    /** Creates the account's character (no usable token). Throws if the account already has one. */
    async createForAccount(accountId, username, name = username) {
      return transaction(async (client) => {
        const ts = now();
        const { rows } = await client.query(
          `INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg)
           VALUES ($1, $2, 0, 0, 0, $3, $4, '{}'::jsonb)
           RETURNING id, name, x, z, yaw, rpg`,
          [unrevealedHash(), name, ts, ts],
        );
        const row = rowOut(rows[0]);
        await client.query(
          `INSERT INTO account_characters (account_id, player_id, username, linked_at)
           VALUES ($1, $2, $3, $4)`,
          [accountKey(accountId), row.id, username, ts],
        );
        return row;
      });
    },

    /**
     * Moves an unclaimed guest character into an account that has none yet, and revokes the guest
     * token. Returns the row, or null if the token is unknown/already claimed or the account has one.
     */
    async claimGuest(accountId, username, token, name = username) {
      return transaction(async (client) => {
        const existing = await client.query(
          'SELECT player_id FROM account_characters WHERE account_id = $1',
          [accountKey(accountId)],
        );
        if (existing.rows.length > 0) return null;

        const guestRes = await client.query(
          `SELECT ${SEL_PLAYER}
             FROM players p
            WHERE p.token_hash = $1
              AND NOT EXISTS (SELECT 1 FROM account_characters a WHERE a.player_id = p.id)
            FOR UPDATE`,
          [hashToken(token)],
        );
        const row = rowOut(guestRes.rows[0]);
        if (!row) return null;

        await client.query(
          `INSERT INTO account_characters (account_id, player_id, username, linked_at)
           VALUES ($1, $2, $3, $4)`,
          [accountKey(accountId), row.id, username, now()],
        );
        await client.query(
          'UPDATE players SET token_hash = $1, name = $2 WHERE id = $3',
          [unrevealedHash(), name, row.id],
        );
        return { ...row, name };
      });
    },

    async setAccountUsername(accountId, username) {
      await pool.query(
        'UPDATE account_characters SET username = $1 WHERE account_id = $2',
        [username, accountKey(accountId)],
      );
    },

    /**
     * Saves full rows (name, position, rpg) for all players and the given world-state rows
     * (`[[key, value|null]]`, null deletes) in ONE transaction. Throws on failure.
     */
    async saveCharacters(players, world = []) {
      if (!players.length && !world.length) return;
      const rows = players.map((p) => [p.name, p.x, p.z, p.yaw, serializeRpg(p), p.id]);
      const worldRows = serializeWorldEntries(world);
      const ts = now();

      await transaction(async (client) => {
        for (const [name, x, z, yaw, rpgText, id] of rows) {
          await client.query(
            `UPDATE players
                SET name = $1, x = $2, z = $3, yaw = $4, rpg = $5::jsonb, last_seen = $6
              WHERE id = $7`,
            [name, x, z, yaw, rpgText, ts, id],
          );
        }
        for (const [key, text] of worldRows) {
          if (text === null) {
            await client.query('DELETE FROM world_state WHERE key = $1', [key]);
          } else {
            await client.query(
              `INSERT INTO world_state (key, value, updated_at)
               VALUES ($1, $2::jsonb, $3)
               ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
              [key, text, ts],
            );
          }
        }
      });
    },

    /** World-state rows whose key starts with `prefix`: [[key, parsedValue]]. */
    async loadWorld(prefix = '') {
      const { rows } = await pool.query(
        `SELECT key, value
           FROM world_state
          WHERE starts_with(key, $1)
          ORDER BY key`,
        [prefix],
      );
      const out = [];
      for (const r of rows) {
        try {
          const val = typeof r.value === 'string' ? JSON.parse(r.value) : structuredClone(r.value);
          out.push([r.key, val]);
        } catch {
          /* skip a corrupt row; the feature rebuilds it */
        }
      }
      return out;
    },

    async savePositions(players) {
      return this.saveCharacters(players);
    },

    async close() {
      if (closed) return;
      closed = true;
      if (ownsPool && typeof pool.end === 'function') {
        await pool.end();
      }
    },
  };
}

/**
 * Write-behind / write-through coordinator for PostgreSQL game stores.
 *
 * `saveCharacters(players, world)` is synchronous from the caller's perspective:
 * it validates and snapshots the rows immediately, merges them into a pending
 * batch, and schedules serialized atomic PostgreSQL transactions so the 25 Hz
 * game tick loop never blocks on network I/O.
 *
 * If a commit fails:
 *  - `onError(err, batch)` is invoked and `lastError` is recorded.
 *  - Any player/world entry from the failed batch that has NOT been superseded
 *    by a newer snapshot is placed back in the pending buffer so the next save
 *    or explicit `flush()` retries it automatically.
 *  - Pending `flush()` callers reject with that error, while future writes and
 *    subsequent `flush()` calls can recover cleanly once PostgreSQL is back.
 */
export function createBufferedGameStore(pgStore, options = {}) {
  const { onError = null } = options;

  // Latest un-committed snapshots keyed by player.id / world key.
  const pendingPlayers = new Map(); // id -> { id, name, x, z, yaw, rpg }
  const pendingWorld = new Map(); // key -> value (parsed clone) | null

  let inFlight = null; // Promise for the currently running commit batch
  let lastError = null;
  let committedBatches = 0;
  let failedBatches = 0;
  let closed = false;

  // Waiters attached to flush() calls.
  const flushWaiters = [];

  function resolveWaiters(err = null) {
    while (flushWaiters.length) {
      const w = flushWaiters.shift();
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  function snapshotPlayers(players) {
    return players.map((p) => {
      // Validate synchronously so oversized / unserializable state throws immediately.
      const rpgText = serializeRpg(p);
      return {
        id: p.id,
        name: p.name,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        rpg: JSON.parse(rpgText),
      };
    });
  }

  function snapshotWorld(world) {
    const serialized = serializeWorldEntries(world);
    return serialized.map(([key, text]) => [key, text === null ? null : JSON.parse(text)]);
  }

  function hasPending() {
    return pendingPlayers.size > 0 || pendingWorld.size > 0;
  }

  function scheduleDrain() {
    if (inFlight || !hasPending()) return;
    inFlight = drainLoop();
  }

  async function drainLoop() {
    try {
      while (hasPending()) {
        const batchPlayers = [...pendingPlayers.values()];
        const batchWorld = [...pendingWorld.entries()];
        pendingPlayers.clear();
        pendingWorld.clear();

        try {
          await pgStore.saveCharacters(batchPlayers, batchWorld);
          committedBatches += 1;
          lastError = null;
        } catch (err) {
          failedBatches += 1;
          lastError = err;
          // Re-queue entries that were not overwritten by a newer snapshot while in flight.
          for (const p of batchPlayers) {
            if (!pendingPlayers.has(p.id)) pendingPlayers.set(p.id, p);
          }
          for (const [k, v] of batchWorld) {
            if (!pendingWorld.has(k)) pendingWorld.set(k, v);
          }
          if (typeof onError === 'function') {
            try {
              onError(err, { players: batchPlayers, world: batchWorld });
            } catch {}
          }
          inFlight = null;
          resolveWaiters(err);
          return;
        }
      }
      inFlight = null;
      resolveWaiters(null);
    } catch (err) {
      inFlight = null;
      resolveWaiters(err);
    }
  }

  return {
    backend: 'postgres',
    buffered: true,
    inner: pgStore,

    create: (...args) => pgStore.create(...args),
    findByToken: (...args) => pgStore.findByToken(...args),
    findByAccount: (...args) => pgStore.findByAccount(...args),
    createForAccount: (...args) => pgStore.createForAccount(...args),
    claimGuest: (...args) => pgStore.claimGuest(...args),
    setAccountUsername: (...args) => pgStore.setAccountUsername(...args),
    loadWorld: (...args) => pgStore.loadWorld(...args),
    transaction: (...args) => pgStore.transaction(...args),
    ensureSchema: (...args) => pgStore.ensureSchema(...args),

    /** Synchronous write-behind entry point compatible with server/game.js. */
    saveCharacters(players, world = []) {
      if (closed) throw new Error('buffered game store is closed');
      if (!players.length && !world.length) return;
      const pSnaps = snapshotPlayers(players);
      const wSnaps = snapshotWorld(world);
      for (const snap of pSnaps) pendingPlayers.set(snap.id, snap);
      for (const [k, v] of wSnaps) pendingWorld.set(k, v);
      scheduleDrain();
    },

    savePositions(players) {
      this.saveCharacters(players);
    },

    /** Waits until all queued writes (including any failed retries) are committed. */
    flush() {
      if (!inFlight && !hasPending()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
        scheduleDrain();
      });
    },

    get pendingCount() {
      return pendingPlayers.size + pendingWorld.size;
    },

    get inFlight() {
      return inFlight !== null;
    },

    get lastError() {
      return lastError;
    },

    stats() {
      return {
        pendingPlayers: pendingPlayers.size,
        pendingWorld: pendingWorld.size,
        inFlight: inFlight !== null,
        committedBatches,
        failedBatches,
        lastError,
      };
    },

    /** Flushes pending commits before closing the underlying PostgreSQL store. */
    async close() {
      if (closed) return;
      let flushErr = null;
      try {
        await this.flush();
      } catch (err) {
        flushErr = err;
      } finally {
        closed = true;
        await pgStore.close();
      }
      if (flushErr) throw flushErr;
    },
  };
}
