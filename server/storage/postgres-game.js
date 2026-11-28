// PostgreSQL game store matching server/db.js's logical contract (multi-slot roster +
// durable transaction/idempotency/escrow/claim ledger), plus a write-behind/write-through
// coordinator (`createBufferedGameStore`) that drains and fences pending buffered saves
// around durable transactions so the synchronous 25 Hz game tick never blocks on DB I/O.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  MAX_RPG_BYTES,
  MAX_CHARACTER_SLOTS,
  ARCHIVE_WINDOW_MS,
  CorruptCharacterError,
  DurableConflictError,
  SlotError,
  hashToken,
  newToken,
  normalizeDisplayNameKey,
  normalizeDurableScope,
  hashParams,
  createKeyedLock,
} from '../db.js';

export {
  SCHEMA_VERSION,
  MAX_RPG_BYTES,
  MAX_CHARACTER_SLOTS,
  ARCHIVE_WINDOW_MS,
  CorruptCharacterError,
  DurableConflictError,
  SlotError,
  hashToken,
  newToken,
  normalizeDisplayNameKey,
};

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
  const pool = new Pool({ connectionString, ...poolOptions });
  // An idle client dropped by the server (restart, failover, pg_terminate_backend) is re-emitted here;
  // unhandled, it would crash the game. The pool discards that client and reconnects on the next query.
  pool.on('error', (err) => console.error('[postgres] idle connection lost:', err.message));
  return pool;
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

function parseJsonOrNull(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return structuredClone(raw);
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

function rosterRowOut(row) {
  if (!row) return null;
  const base = rowOut(row);
  return {
    ...base,
    playerId: base.id,
    accountId: row.account_id != null ? String(row.account_id) : null,
    slot: row.slot != null ? Number(row.slot) : 1,
    username: row.username,
    displayName: row.display_name || base.name,
    grandfathered: Boolean(row.grandfathered),
    status: row.status || 'active',
    draft: Boolean(row.draft),
    linkedAt: row.linked_at != null ? Number(row.linked_at) : null,
    lastPlayedAt: row.last_played_at == null ? null : Number(row.last_played_at),
    lastSelected: Boolean(row.last_selected),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
    purgeAfter: row.purge_after == null ? null : Number(row.purge_after),
  };
}

function escrowRowOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    ownerAccountId: row.owner_account_id ?? null,
    ownerCharacterId: row.owner_character_id == null ? null : Number(row.owner_character_id),
    counterpartyCharacterId: row.counterparty_character_id == null ? null : Number(row.counterparty_character_id),
    sourceRef: row.source_ref ?? null,
    gold: Number(row.gold ?? 0),
    item: parseJsonOrNull(row.item_json),
    status: row.status,
    revision: Number(row.revision ?? 1),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function claimRowOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerCharacterId: Number(row.owner_character_id),
    ownerAccountId: row.owner_account_id ?? null,
    kind: row.kind,
    sourceRef: row.source_ref ?? null,
    gold: Number(row.gold ?? 0),
    item: parseJsonOrNull(row.item_json),
    status: row.status,
    reason: row.reason ?? null,
    revision: Number(row.revision ?? 1),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at),
    claimedAt: row.claimed_at == null ? null : Number(row.claimed_at),
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
const newEscrowId = () => `esc_${randomBytes(8).toString('hex')}`;
const newClaimId = () => `clm_${randomBytes(8).toString('hex')}`;

const SEL_PLAYER = 'p.id, p.name, p.x, p.z, p.yaw, p.rpg';
const SEL_ROSTER = `${SEL_PLAYER}, a.account_id, a.slot, a.username, a.display_name, a.display_name_key, a.grandfathered, a.status, a.draft, a.linked_at, a.last_played_at, a.last_selected, a.archived_at, a.purge_after`;

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
  const withLocks = createKeyedLock();
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
      // Serialize concurrent first boots: parallel CREATE ... IF NOT EXISTS races on pg_type.
      await client.query('SELECT pg_advisory_xact_lock(7243911)');
      await client.query(sql);
    });
  }

  if (applySchema) {
    await ensureSchema();
  }

  async function writePlayersAndWorld(client, playersList, worldList, ts) {
    const rows = (playersList ?? []).map((p) => [p.name, p.x, p.z, p.yaw, serializeRpg(p), p.id]);
    const worldRows = serializeWorldEntries(worldList ?? []);
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
  }

  async function queryEscrow(runner, filter = {}) {
    const clauses = [];
    const params = [];
    const add = (expr, val) => { params.push(val); clauses.push(expr.replace('?', `$${params.length}`)); };
    if (filter.ownerCharacterId != null) add('owner_character_id = ?', Number(filter.ownerCharacterId));
    if (filter.counterpartyCharacterId != null) add('counterparty_character_id = ?', Number(filter.counterpartyCharacterId));
    if (filter.involvingCharacterId != null) {
      params.push(Number(filter.involvingCharacterId));
      const idx = params.length;
      clauses.push(`(owner_character_id = $${idx} OR counterparty_character_id = $${idx})`);
    }
    if (filter.ownerAccountId != null) add('owner_account_id = ?', String(filter.ownerAccountId));
    if (filter.status != null) add('status = ?', String(filter.status));
    if (filter.kind != null) add('kind = ?', String(filter.kind));
    if (filter.sourceRef != null) add('source_ref = ?', String(filter.sourceRef));
    if (filter.dueBefore != null) add('expires_at IS NOT NULL AND expires_at <= ?', Number(filter.dueBefore));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(500, filter.limit) : 100;
    params.push(limit);
    const { rows } = await runner.query(
      `SELECT * FROM escrow_records ${where} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map(escrowRowOut);
  }

  async function queryClaims(runner, filter = {}) {
    const clauses = [];
    const params = [];
    const add = (expr, val) => { params.push(val); clauses.push(expr.replace('?', `$${params.length}`)); };
    if (filter.ownerCharacterId != null) add('owner_character_id = ?', Number(filter.ownerCharacterId));
    if (filter.ownerAccountId != null) add('owner_account_id = ?', String(filter.ownerAccountId));
    if (filter.status != null) add('status = ?', String(filter.status));
    if (filter.kind != null) add('kind = ?', String(filter.kind));
    if (filter.sourceRef != null) add('source_ref = ?', String(filter.sourceRef));
    if (filter.dueBefore != null) add('expires_at IS NOT NULL AND expires_at <= ?', Number(filter.dueBefore));
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(500, filter.limit) : 100;
    params.push(limit);
    const { rows } = await runner.query(
      `SELECT * FROM claim_records ${where} ORDER BY created_at ASC, id ASC LIMIT $${params.length}`,
      params,
    );
    return rows.map(claimRowOut);
  }

  function makeTxContext(client, ts, tracker = null) {
    return {
      backend: 'postgres',
      client,
      now: ts,
      async getCharacter(playerId) {
        const { rows } = await client.query(`SELECT ${SEL_PLAYER} FROM players p WHERE p.id = $1 FOR UPDATE`, [Number(playerId)]);
        return rowOut(rows[0]);
      },
      async saveCharacters(playersList, worldList = []) {
        await writePlayersAndWorld(client, playersList, worldList, ts);
        if (tracker) {
          for (const p of playersList ?? []) tracker.playerIds.add(Number(p.id));
          for (const [k, v] of worldList ?? []) tracker.world.set(k, v === undefined ? null : structuredClone(v));
        }
      },
      async getWorld(key) {
        const { rows } = await client.query('SELECT value FROM world_state WHERE key = $1 FOR UPDATE', [String(key)]);
        return rows[0] ? parseJsonOrNull(rows[0].value) : null;
      },
      async putWorld(key, value) {
        await writePlayersAndWorld(client, [], [[key, value]], ts);
        if (tracker) tracker.world.set(key, value === undefined ? null : structuredClone(value));
      },
      async deleteWorld(key) {
        await client.query('DELETE FROM world_state WHERE key = $1', [String(key)]);
        if (tracker) tracker.world.set(key, null);
      },
      async createEscrow(rec) {
        const id = rec.id ? String(rec.id) : newEscrowId();
        const gold = Math.max(0, Math.trunc(Number(rec.gold ?? 0)));
        const itemJson = rec.item == null ? null : JSON.stringify(rec.item);
        const { rows } = await client.query(
          `INSERT INTO escrow_records (
             id, kind, owner_account_id, owner_character_id, counterparty_character_id,
             source_ref, gold, item_json, status, revision, expires_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 1, $10, $11, $12)
           RETURNING *`,
          [
            id,
            String(rec.kind),
            rec.ownerAccountId != null ? String(rec.ownerAccountId) : null,
            rec.ownerCharacterId != null ? Number(rec.ownerCharacterId) : null,
            rec.counterpartyCharacterId != null ? Number(rec.counterpartyCharacterId) : null,
            rec.sourceRef != null ? String(rec.sourceRef) : null,
            gold,
            itemJson,
            rec.status || 'held',
            rec.expiresAt != null ? Number(rec.expiresAt) : null,
            ts,
            ts,
          ],
        );
        return escrowRowOut(rows[0]);
      },
      async getEscrow(id) {
        const { rows } = await client.query('SELECT * FROM escrow_records WHERE id = $1 FOR UPDATE', [String(id)]);
        return escrowRowOut(rows[0]);
      },
      async updateEscrowStatus(id, expectedRev, status, patch = {}) {
        const curRes = await client.query('SELECT * FROM escrow_records WHERE id = $1 FOR UPDATE', [String(id)]);
        const cur = curRes.rows[0];
        if (!cur || Number(cur.revision) !== Number(expectedRev)) {
          throw new DurableConflictError(`escrow ${id} revision mismatch`, 'REVISION_CONFLICT');
        }
        const gold = patch.gold !== undefined ? Math.max(0, Math.trunc(Number(patch.gold))) : Number(cur.gold);
        const itemJson = patch.item !== undefined
          ? (patch.item == null ? null : JSON.stringify(patch.item))
          : (cur.item_json == null ? null : (typeof cur.item_json === 'string' ? cur.item_json : JSON.stringify(cur.item_json)));
        const cp = patch.counterpartyCharacterId !== undefined
          ? (patch.counterpartyCharacterId == null ? null : Number(patch.counterpartyCharacterId))
          : cur.counterparty_character_id;
        const { rows } = await client.query(
          `UPDATE escrow_records
              SET status = $1, gold = $2, item_json = $3::jsonb, counterparty_character_id = $4,
                  revision = revision + 1, updated_at = $5
            WHERE id = $6 AND revision = $7
            RETURNING *`,
          [String(status), gold, itemJson, cp, ts, String(id), Number(expectedRev)],
        );
        if (!rows[0]) {
          throw new DurableConflictError(`escrow ${id} concurrent update`, 'REVISION_CONFLICT');
        }
        return escrowRowOut(rows[0]);
      },
      listEscrow: (filter) => queryEscrow(client, filter),
      async createClaim(rec) {
        const id = rec.id ? String(rec.id) : newClaimId();
        const gold = Math.max(0, Math.trunc(Number(rec.gold ?? 0)));
        const itemJson = rec.item == null ? null : JSON.stringify(rec.item);
        const { rows } = await client.query(
          `INSERT INTO claim_records (
             id, owner_character_id, owner_account_id, kind, source_ref, gold, item_json,
             status, reason, revision, expires_at, created_at, claimed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, 1, $9, $10, NULL)
           RETURNING *`,
          [
            id,
            Number(rec.ownerCharacterId),
            rec.ownerAccountId != null ? String(rec.ownerAccountId) : null,
            String(rec.kind),
            rec.sourceRef != null ? String(rec.sourceRef) : null,
            gold,
            itemJson,
            rec.reason != null ? String(rec.reason) : null,
            rec.expiresAt != null ? Number(rec.expiresAt) : null,
            ts,
          ],
        );
        return claimRowOut(rows[0]);
      },
      async getClaim(id) {
        const { rows } = await client.query('SELECT * FROM claim_records WHERE id = $1 FOR UPDATE', [String(id)]);
        return claimRowOut(rows[0]);
      },
      async claimRecord(id, expectedRev, nextStatus = 'claimed') {
        const { rows } = await client.query(
          `UPDATE claim_records
              SET status = $1, claimed_at = $2, revision = revision + 1
            WHERE id = $3 AND revision = $4 AND status = 'pending'
            RETURNING *`,
          [String(nextStatus), ts, String(id), Number(expectedRev)],
        );
        if (!rows[0]) {
          throw new DurableConflictError(`claim ${id} already settled or revision mismatch`, 'REVISION_CONFLICT');
        }
        return claimRowOut(rows[0]);
      },
      listClaims: (filter) => queryClaims(client, filter),
    };
  }

  async function purgeExpiredForAccountInTx(client, acctKey, ts) {
    const { rows } = await client.query(
      `SELECT player_id, account_id, slot, display_name
         FROM account_characters
        WHERE account_id = $1 AND status = 'archived' AND purge_after IS NOT NULL AND purge_after <= $2
        FOR UPDATE`,
      [acctKey, ts],
    );
    for (const r of rows) {
      await client.query('DELETE FROM account_characters WHERE player_id = $1', [r.player_id]);
      await client.query('DELETE FROM players WHERE id = $1', [r.player_id]);
    }
    return rows.map((r) => ({ accountId: r.account_id, playerId: Number(r.player_id), slot: Number(r.slot), name: r.display_name }));
  }

  async function checkNameAvailableInTx(client, name, ts, excludePlayerId = null) {
    const key = normalizeDisplayNameKey(name);
    if (!key) throw new SlotError('INVALID_NAME', 'Character name is required.', 400);
    const { rows } = await client.query(
      'SELECT player_id, account_id, status, purge_after FROM account_characters WHERE display_name_key = $1 FOR UPDATE',
      [key],
    );
    for (const m of rows) {
      if (excludePlayerId != null && Number(m.player_id) === Number(excludePlayerId)) continue;
      if (m.status === 'archived' && m.purge_after != null && Number(m.purge_after) <= ts) {
        await client.query('DELETE FROM account_characters WHERE player_id = $1', [m.player_id]);
        await client.query('DELETE FROM players WHERE id = $1', [m.player_id]);
        continue;
      }
      throw new SlotError('NAME_TAKEN', `The character name "${name}" is already in use.`, 409);
    }
    return key;
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

    /** Primary (last selected / lowest slot active) character for the account, or null. */
    async findByAccount(accountId) {
      const { rows } = await pool.query(
        `SELECT ${SEL_PLAYER}, a.username
           FROM account_characters a
           JOIN players p ON p.id = a.player_id
          WHERE a.account_id = $1`,
        [accountKey(accountId)],
      );
      if (!rows.length) return null;
      // Preserve single-row compatibility with mock pools while preferring active + last_selected on multi-slot rows.
      const active = rows.filter((r) => (r.status ?? 'active') === 'active');
      if (!active.length) return null;
      active.sort((a, b) => (Number(Boolean(b.last_selected)) - Number(Boolean(a.last_selected))) || (Number(a.slot ?? 1) - Number(b.slot ?? 1)));
      const pick = active[0];
      return { ...rowOut(pick), username: pick.username };
    },

    async listByAccount(accountId, { includeArchived = true } = {}) {
      const key = accountKey(accountId);
      const { rows } = await pool.query(
        includeArchived
          ? `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 ORDER BY a.slot ASC`
          : `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.status = 'active' ORDER BY a.slot ASC`,
        [key],
      );
      return rows.map(rosterRowOut);
    },

    async findAccountCharacter(accountId, characterId) {
      if (!Number.isSafeInteger(Number(characterId))) return null;
      const { rows } = await pool.query(
        `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
        [accountKey(accountId), Number(characterId)],
      );
      return rosterRowOut(rows[0]);
    },

    async isDisplayNameAvailable(name, { excludePlayerId = null } = {}) {
      const key = normalizeDisplayNameKey(name);
      if (!key) return false;
      const ts = now();
      const { rows } = await pool.query(
        'SELECT player_id, status, purge_after FROM account_characters WHERE display_name_key = $1',
        [key],
      );
      for (const m of rows) {
        if (excludePlayerId != null && Number(m.player_id) === Number(excludePlayerId)) continue;
        if (m.status === 'archived' && m.purge_after != null && Number(m.purge_after) <= ts) continue;
        return false;
      }
      return true;
    },

    async createCharacterSlot(accountId, username, opts = {}) {
      const {
        slot: requestedSlot = null,
        name = username,
        maxSlots = MAX_CHARACTER_SLOTS,
        draft = true,
        grandfathered = false,
      } = opts;
      return withLocks([`acct:${accountKey(accountId)}`], () =>
        transaction(async (client) => {
          const key = accountKey(accountId);
          const ts = now();
          await client.query("SELECT pg_advisory_xact_lock(hashtext('acct:' || $1))", [key]);
          await purgeExpiredForAccountInTx(client, key, ts);
          const existingRes = await client.query(
            'SELECT player_id, slot FROM account_characters WHERE account_id = $1 ORDER BY slot ASC FOR UPDATE',
            [key],
          );
          if (existingRes.rows.length >= maxSlots) {
            throw new SlotError('SLOT_CAP_REACHED', `You can have at most ${maxSlots} characters per account.`, 409);
          }
          const usedSlots = new Set(existingRes.rows.map((r) => Number(r.slot)));
          let slot;
          if (requestedSlot !== null && requestedSlot !== undefined) {
            slot = Number(requestedSlot);
            if (!Number.isInteger(slot) || slot < 1 || slot > maxSlots) {
              throw new SlotError('INVALID_SLOT', `Slot must be between 1 and ${maxSlots}.`, 400);
            }
            if (usedSlots.has(slot)) {
              throw new SlotError('SLOT_OCCUPIED', `Character slot ${slot} is already in use.`, 409);
            }
          } else {
            for (let s = 1; s <= maxSlots; s++) {
              if (!usedSlots.has(s)) { slot = s; break; }
            }
            if (!slot) throw new SlotError('SLOT_CAP_REACHED', `You can have at most ${maxSlots} characters per account.`, 409);
          }
          const nameKey = grandfathered ? normalizeDisplayNameKey(name) : await checkNameAvailableInTx(client, name, ts);
          const { rows: pRows } = await client.query(
            `INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg)
             VALUES ($1, $2, 0, 0, 0, $3, $4, '{}'::jsonb)
             RETURNING id, name, x, z, yaw, rpg`,
            [unrevealedHash(), name, ts, ts],
          );
          const id = Number(pRows[0].id);
          await client.query('UPDATE account_characters SET last_selected = FALSE WHERE account_id = $1', [key]);
          await client.query(
            `INSERT INTO account_characters (
               player_id, account_id, slot, username, display_name, display_name_key,
               grandfathered, status, draft, linked_at, last_played_at, last_selected, archived_at, purge_after
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, TRUE, NULL, NULL)`,
            [id, key, slot, username, name, nameKey, Boolean(grandfathered), Boolean(draft), ts, ts],
          );
          const { rows } = await client.query(
            `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
            [key, id],
          );
          return rosterRowOut(rows[0]);
        }),
      );
    },

    /** Creates the account's slot-1 character (no usable token). Throws if slot 1 already exists. */
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

    async selectCharacter(accountId, characterId) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const cur = await client.query('SELECT status FROM account_characters WHERE account_id = $1 AND player_id = $2 FOR UPDATE', [key, id]);
        if (!cur.rows[0]) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (cur.rows[0].status !== 'active') throw new SlotError('INVALID_STATE', 'Archived characters must be restored first.', 409);
        await client.query('UPDATE account_characters SET last_selected = FALSE WHERE account_id = $1', [key]);
        await client.query("UPDATE account_characters SET last_selected = TRUE WHERE account_id = $1 AND player_id = $2 AND status = 'active'", [key, id]);
        const { rows } = await client.query(
          `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
          [key, id],
        );
        return rosterRowOut(rows[0]);
      });
    },

    async touchCharacterPlayed(accountId, characterId, ts = now()) {
      await transaction(async (client) => {
        const key = accountKey(accountId);
        await client.query('UPDATE account_characters SET last_selected = FALSE WHERE account_id = $1', [key]);
        await client.query(
          "UPDATE account_characters SET last_played_at = $1, last_selected = TRUE WHERE account_id = $2 AND player_id = $3 AND status = 'active'",
          [ts, key, Number(characterId)],
        );
      });
    },

    async markCharacterDraftComplete(accountId, characterId, finalName = null) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const curRes = await client.query('SELECT display_name FROM account_characters WHERE account_id = $1 AND player_id = $2 FOR UPDATE', [key, id]);
        if (!curRes.rows[0]) return null;
        if (finalName && finalName !== curRes.rows[0].display_name) {
          const nameKey = await checkNameAvailableInTx(client, finalName, now(), id);
          await client.query(
            'UPDATE account_characters SET display_name = $1, display_name_key = $2, grandfathered = FALSE WHERE account_id = $3 AND player_id = $4',
            [finalName, nameKey, key, id],
          );
          await client.query('UPDATE players SET name = $1 WHERE id = $2', [finalName, id]);
        }
        await client.query('UPDATE account_characters SET draft = FALSE WHERE account_id = $1 AND player_id = $2', [key, id]);
        const { rows } = await client.query(
          `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
          [key, id],
        );
        return rosterRowOut(rows[0]);
      });
    },

    async renameCharacter(accountId, characterId, newName) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const curRes = await client.query('SELECT player_id FROM account_characters WHERE account_id = $1 AND player_id = $2 FOR UPDATE', [key, id]);
        if (!curRes.rows[0]) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        const nameKey = await checkNameAvailableInTx(client, newName, now(), id);
        await client.query(
          'UPDATE account_characters SET display_name = $1, display_name_key = $2, grandfathered = FALSE WHERE account_id = $3 AND player_id = $4',
          [newName, nameKey, key, id],
        );
        await client.query('UPDATE players SET name = $1 WHERE id = $2', [newName, id]);
        const { rows } = await client.query(
          `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
          [key, id],
        );
        return rosterRowOut(rows[0]);
      });
    },

    async archiveCharacter(accountId, characterId, { archiveWindowMs = ARCHIVE_WINDOW_MS, at = now() } = {}) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const curRes = await client.query('SELECT status FROM account_characters WHERE account_id = $1 AND player_id = $2 FOR UPDATE', [key, id]);
        if (!curRes.rows[0]) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (curRes.rows[0].status !== 'active') throw new SlotError('INVALID_STATE', 'Character is already archived.', 409);
        const purgeAfter = at + Math.max(0, Number(archiveWindowMs) || 0);
        await client.query(
          "UPDATE account_characters SET status = 'archived', archived_at = $1, purge_after = $2, last_selected = FALSE WHERE account_id = $3 AND player_id = $4",
          [at, purgeAfter, key, id],
        );
        const rem = await client.query(
          "SELECT player_id FROM account_characters WHERE account_id = $1 AND status = 'active' ORDER BY last_played_at DESC NULLS LAST, slot ASC LIMIT 1",
          [key],
        );
        if (rem.rows[0]) {
          await client.query('UPDATE account_characters SET last_selected = FALSE WHERE account_id = $1', [key]);
          await client.query('UPDATE account_characters SET last_selected = TRUE WHERE account_id = $1 AND player_id = $2', [key, rem.rows[0].player_id]);
        }
        const { rows } = await client.query(
          `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
          [key, id],
        );
        return rosterRowOut(rows[0]);
      });
    },

    async restoreCharacter(accountId, characterId, { at = now() } = {}) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const curRes = await client.query('SELECT status, purge_after FROM account_characters WHERE account_id = $1 AND player_id = $2 FOR UPDATE', [key, id]);
        if (!curRes.rows[0]) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (curRes.rows[0].status !== 'archived') throw new SlotError('INVALID_STATE', 'Character is not archived.', 409);
        if (curRes.rows[0].purge_after != null && Number(curRes.rows[0].purge_after) <= at) {
          await client.query('DELETE FROM account_characters WHERE player_id = $1', [id]);
          await client.query('DELETE FROM players WHERE id = $1', [id]);
          throw new SlotError('ARCHIVE_EXPIRED', 'The restore window for this character has expired.', 410);
        }
        await client.query('UPDATE account_characters SET last_selected = FALSE WHERE account_id = $1', [key]);
        await client.query(
          "UPDATE account_characters SET status = 'active', archived_at = NULL, purge_after = NULL, last_selected = TRUE WHERE account_id = $1 AND player_id = $2",
          [key, id],
        );
        const { rows } = await client.query(
          `SELECT ${SEL_ROSTER} FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1 AND a.player_id = $2`,
          [key, id],
        );
        return rosterRowOut(rows[0]);
      });
    },

    async purgeExpiredArchived({ accountId = null, at = now(), limit = 50 } = {}) {
      return transaction(async (client) => {
        if (accountId !== null && accountId !== undefined) {
          return purgeExpiredForAccountInTx(client, accountKey(accountId), at);
        }
        const { rows } = await client.query(
          `SELECT player_id, account_id, slot, display_name
             FROM account_characters
            WHERE status = 'archived' AND purge_after IS NOT NULL AND purge_after <= $1
            ORDER BY purge_after ASC
            LIMIT $2
            FOR UPDATE`,
          [at, Math.max(1, Math.min(500, Number(limit) || 50))],
        );
        for (const r of rows) {
          await client.query('DELETE FROM account_characters WHERE player_id = $1', [r.player_id]);
          await client.query('DELETE FROM players WHERE id = $1', [r.player_id]);
        }
        return rows.map((r) => ({ accountId: r.account_id, playerId: Number(r.player_id), slot: Number(r.slot), name: r.display_name }));
      });
    },

    /** Deletes ALL character links and linked player rows for an account in one transaction. Returns deleted playerIds. */
    async deleteAllForAccount(accountId) {
      return transaction(async (client) => {
        const key = accountKey(accountId);
        const existing = await client.query(
          'SELECT player_id FROM account_characters WHERE account_id = $1',
          [key],
        );
        if (!existing.rows.length) return [];
        const ids = existing.rows.map((r) => Number(r.player_id));
        await client.query('DELETE FROM account_characters WHERE account_id = $1', [key]);
        for (const id of ids) {
          await client.query('DELETE FROM players WHERE id = $1', [id]);
        }
        return ids;
      });
    },

    /** Deletes an account's characters and returns the first deleted playerId or null. */
    async deleteForAccount(accountId) {
      const ids = await this.deleteAllForAccount(accountId);
      return ids[0] ?? null;
    },

    /**
     * Durable transaction & idempotency runner matching server/db.js's `runDurable(opKey, scope, fn)`.
     * Acquires sorted locks (in-process + PostgreSQL advisory locks) and commits mutations + `durable_ops` atomically.
     */
    async runDurable(opKey, scopeOrFn, maybeFn, _tracker = null) {
      let scope = scopeOrFn;
      let fn = maybeFn;
      if (typeof scopeOrFn === 'function') {
        fn = scopeOrFn;
        scope = {};
      }
      if (typeof fn !== 'function') throw new TypeError('runDurable requires a callback function');
      const normScope = normalizeDurableScope(scope);
      const key = opKey == null ? null : String(opKey).trim();
      if (key !== null && (key.length === 0 || key.length > 128)) {
        throw new Error('opKey must be 1..128 characters');
      }
      const paramsHash = hashParams(normScope.params ?? null);
      return withLocks(normScope.lockKeys, () =>
        transaction(async (client) => {
          for (const lk of normScope.lockKeys) {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lk]);
          }
          const ts = now();
          if (key !== null) {
            const { rows } = await client.query(
              'SELECT params_hash, status, result FROM durable_ops WHERE scope_key = $1 AND op_key = $2 FOR UPDATE',
              [normScope.scopeKey, key],
            );
            if (rows[0]) {
              if (rows[0].params_hash !== paramsHash) {
                throw new DurableConflictError(`operation key "${key}" was already used with different parameters`);
              }
              if (rows[0].status === 'committed') {
                return { replayed: true, opKey: key, scopeKey: normScope.scopeKey, result: parseJsonOrNull(rows[0].result) };
              }
            }
          }
          const tx = makeTxContext(client, ts, _tracker);
          const result = await fn(tx);
          const serialized = result === undefined ? null : JSON.stringify(result);
          if (key !== null) {
            const expiresAt = Number.isFinite(normScope.ttlMs) && normScope.ttlMs > 0 ? ts + Math.trunc(normScope.ttlMs) : null;
            await client.query(
              `INSERT INTO durable_ops (scope_key, op_key, params_hash, status, result, account_id, character_id, resource_key, created_at, updated_at, expires_at)
               VALUES ($1, $2, $3, 'committed', $4::jsonb, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (scope_key, op_key) DO UPDATE SET
                 status = EXCLUDED.status,
                 result = EXCLUDED.result,
                 updated_at = EXCLUDED.updated_at,
                 expires_at = EXCLUDED.expires_at`,
              [
                normScope.scopeKey,
                key,
                paramsHash,
                serialized,
                normScope.accountId,
                normScope.characterId,
                normScope.resourceKey,
                ts,
                ts,
                expiresAt,
              ],
            );
          }
          return { replayed: false, opKey: key, scopeKey: normScope.scopeKey, result };
        }),
      );
    },

    async getDurableOp(opKey, scope = {}) {
      const normScope = normalizeDurableScope(scope);
      const { rows } = await pool.query(
        'SELECT * FROM durable_ops WHERE scope_key = $1 AND op_key = $2',
        [normScope.scopeKey, String(opKey)],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        scopeKey: row.scope_key,
        opKey: row.op_key,
        paramsHash: row.params_hash,
        status: row.status,
        result: parseJsonOrNull(row.result),
        accountId: row.account_id ?? null,
        characterId: row.character_id == null ? null : Number(row.character_id),
        resourceKey: row.resource_key ?? null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      };
    },

    async pruneDurableOps(beforeTs = now()) {
      const res = await pool.query('DELETE FROM durable_ops WHERE expires_at IS NOT NULL AND expires_at <= $1', [Number(beforeTs)]);
      return res.rowCount ?? 0;
    },

    listEscrow: (filter) => queryEscrow(pool, filter),
    listClaims: (filter) => queryClaims(pool, filter),

    /**
     * Saves full rows (name, position, rpg) for all players and the given world-state rows
     * (`[[key, value|null]]`, null deletes) in ONE transaction. Throws on failure.
     */
    async saveCharacters(players, world = []) {
      if (!players.length && !world.length) return;
      const ts = now();
      await transaction((client) => writePlayersAndWorld(client, players, world, ts));
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
 * `runDurable(opKey, scope, fn)` coordinates with the write-behind buffer:
 *  - Acquires sorted locks on affected accounts/characters/resources.
 *  - Drains pending buffered writes before starting the durable transaction.
 *  - Holds conflicting buffered snapshots for affected characters while the
 *    durable transaction settles, and clears superseded buffered snapshots and
 *    updates `worldCache` on commit so stale write-behind rows never overwrite
 *    durable mutations.
 */
export function createBufferedGameStore(pgStore, options = {}) {
  const { onError = null, retryMs = 2000 } = options;

  // Latest un-committed snapshots keyed by player.id / world key.
  const pendingPlayers = new Map(); // id -> { id, name, x, z, yaw, rpg }
  const pendingWorld = new Map(); // key -> value (parsed clone) | null
  // In-memory world_state mirror so synchronous callers (e.g. createRpgRuntime) can loadWorld() without awaiting.
  const worldCache = new Map(); // key -> parsed value
  // Character IDs currently fenced inside an in-flight durable transaction.
  const fencedCharacters = new Set();
  const withLocks = createKeyedLock();

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

  function hasUnfencedPending() {
    if (pendingWorld.size > 0) return true;
    for (const id of pendingPlayers.keys()) {
      if (!fencedCharacters.has(Number(id))) return true;
    }
    return false;
  }

  function hasPending() {
    return pendingPlayers.size > 0 || pendingWorld.size > 0;
  }

  function scheduleDrain() {
    if (inFlight || !hasUnfencedPending()) return;
    inFlight = drainLoop();
  }

  async function drainLoop() {
    try {
      while (hasUnfencedPending()) {
        const batchPlayers = [];
        for (const [id, snap] of pendingPlayers) {
          if (fencedCharacters.has(Number(id))) continue;
          batchPlayers.push(snap);
          pendingPlayers.delete(id);
        }
        const batchWorld = [...pendingWorld.entries()];
        pendingWorld.clear();

        if (!batchPlayers.length && !batchWorld.length) break;

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
          // Callers already cleared their dirty flags; nothing else would retry these rows until close().
          if (!closed) setTimeout(scheduleDrain, retryMs).unref();
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

  const store = {
    backend: 'postgres',
    buffered: true,
    inner: pgStore,
    pool: pgStore.pool,

    create: (...args) => pgStore.create(...args),
    findByToken: (...args) => pgStore.findByToken(...args),
    findByAccount: (...args) => pgStore.findByAccount(...args),
    listByAccount: (...args) => pgStore.listByAccount(...args),
    findAccountCharacter: (...args) => pgStore.findAccountCharacter(...args),
    isDisplayNameAvailable: (...args) => pgStore.isDisplayNameAvailable(...args),
    createCharacterSlot: (...args) => pgStore.createCharacterSlot(...args),
    createForAccount: (...args) => pgStore.createForAccount(...args),
    claimGuest: (...args) => pgStore.claimGuest(...args),
    setAccountUsername: (...args) => pgStore.setAccountUsername(...args),
    selectCharacter: (...args) => pgStore.selectCharacter(...args),
    touchCharacterPlayed: (...args) => pgStore.touchCharacterPlayed(...args),
    markCharacterDraftComplete: (...args) => pgStore.markCharacterDraftComplete(...args),
    renameCharacter: (...args) => pgStore.renameCharacter(...args),
    archiveCharacter: (...args) => pgStore.archiveCharacter(...args),
    restoreCharacter: (...args) => pgStore.restoreCharacter(...args),
    async purgeExpiredArchived(...args) {
      const purged = await pgStore.purgeExpiredArchived(...args);
      for (const p of purged) pendingPlayers.delete(p.playerId);
      return purged;
    },
    async deleteAllForAccount(accountId) {
      const deletedIds = await pgStore.deleteAllForAccount(accountId);
      for (const id of deletedIds) pendingPlayers.delete(id);
      return deletedIds;
    },
    async deleteForAccount(accountId) {
      const deletedId = await pgStore.deleteForAccount(accountId);
      if (deletedId != null) pendingPlayers.delete(deletedId);
      return deletedId;
    },
    async runDurable(opKey, scopeOrFn, maybeFn) {
      let scope = scopeOrFn;
      let fn = maybeFn;
      if (typeof scopeOrFn === 'function') {
        fn = scopeOrFn;
        scope = {};
      }
      const normScope = normalizeDurableScope(scope);
      return withLocks(normScope.lockKeys, async () => {
        // 1. Drain pending buffered saves before entering the durable transaction so DB state is current.
        await store.flush();
        // 2. Fence affected characters so concurrent background drains cannot overwrite committed durable state.
        for (const cid of normScope.characterIds) fencedCharacters.add(cid);
        const tracker = { playerIds: new Set(), world: new Map() };
        try {
          const outcome = await pgStore.runDurable(opKey, scope, fn, tracker);
          // 3. Drop any pre-commit buffered snapshots for characters written durably and mirror world writes into cache.
          for (const cid of tracker.playerIds) pendingPlayers.delete(cid);
          for (const cid of normScope.characterIds) pendingPlayers.delete(cid);
          for (const [k, v] of tracker.world) {
            pendingWorld.delete(k);
            if (v === null) worldCache.delete(k);
            else worldCache.set(k, structuredClone(v));
          }
          return outcome;
        } finally {
          for (const cid of normScope.characterIds) fencedCharacters.delete(cid);
          scheduleDrain();
        }
      });
    },
    getDurableOp: (...args) => pgStore.getDurableOp(...args),
    pruneDurableOps: (...args) => pgStore.pruneDurableOps(...args),
    listEscrow: (...args) => pgStore.listEscrow(...args),
    listClaims: (...args) => pgStore.listClaims(...args),
    async preloadWorld(prefix = '') {
      const rows = await pgStore.loadWorld(prefix);
      for (const [k, v] of rows) {
        if (!pendingWorld.has(k)) {
          worldCache.set(k, structuredClone(v));
        }
      }
      return rows;
    },
    /** Synchronous world_state read from the preloaded/write-through in-memory cache. */
    loadWorld(prefix = '') {
      const pfx = String(prefix ?? '');
      const out = [];
      for (const [k, v] of worldCache) {
        if (k.startsWith(pfx)) {
          out.push([k, structuredClone(v)]);
        }
      }
      out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return out;
    },
    transaction: (...args) => pgStore.transaction(...args),
    ensureSchema: (...args) => pgStore.ensureSchema(...args),

    /** Synchronous write-behind entry point compatible with server/game.js. */
    saveCharacters(players, world = []) {
      if (closed) throw new Error('buffered game store is closed');
      if (!players.length && !world.length) return;
      const pSnaps = snapshotPlayers(players);
      const wSnaps = snapshotWorld(world);
      for (const snap of pSnaps) pendingPlayers.set(snap.id, snap);
      for (const [k, v] of wSnaps) {
        pendingWorld.set(k, v);
        if (v === null) worldCache.delete(k);
        else worldCache.set(k, structuredClone(v));
      }
      scheduleDrain();
    },

    savePositions(players) {
      this.saveCharacters(players);
    },

    /** Waits until all queued writes (including any failed retries) are committed. */
    flush() {
      if (!inFlight && !hasUnfencedPending()) return Promise.resolve();
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
  return store;
}
