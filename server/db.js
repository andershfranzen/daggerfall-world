// Persistent characters, account-to-multi-slot roster, world state, and durable transaction/escrow/claim ledger in node:sqlite.
// Guest tokens are stored only as SHA-256 hashes.
//
// Schema (additive migrations; existing character rows are preserved losslessly):
//   players(id, token_hash, name, x, z, yaw, created_at, last_seen, rpg)
//     rpg: JSON text of the private RPG state (`player.rpg`), default '{}'  [v2]
//   account_characters(player_id PK -> players.id, account_id, slot, username, display_name,
//                      display_name_key, grandfathered, status, draft, linked_at,
//                      last_played_at, last_selected, archived_at, purge_after)  [v3]
//     Up to MAX_CHARACTER_SLOTS active/archived-in-window characters per account.
//     Existing v2 single-slot mappings migrate losslessly to slot 1 with grandfathered=1.
//   world_state(key PK, value, updated_at)  [v2]
//   durable_ops(scope_key, op_key, params_hash, status, result, account_id, character_id,
//               resource_key, created_at, updated_at, expires_at)  [v3]
//   escrow_records(id PK, kind, owner_account_id, owner_character_id, counterparty_character_id,
//                  source_ref, gold, item_json, status, revision, expires_at, created_at, updated_at)  [v3]
//   claim_records(id PK, owner_character_id, owner_account_id, kind, source_ref, gold, item_json,
//                 status, reason, revision, expires_at, created_at, claimed_at)  [v3]
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 3;
export const MAX_RPG_BYTES = 256 * 1024;
export const MAX_CHARACTER_SLOTS = 3;
export const ARCHIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url'); // 43 chars
}

export function normalizeDisplayNameKey(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function hashParams(params) {
  return createHash('sha256').update(canonicalJson(params ?? null)).digest('hex');
}

export function normalizeDurableScope(scope = {}) {
  const s = typeof scope === 'string' ? { resourceKey: scope } : (scope && typeof scope === 'object' ? scope : {});
  const accountId = s.accountId != null ? String(s.accountId) : null;
  const characterId = s.characterId != null && Number.isSafeInteger(Number(s.characterId)) ? Number(s.characterId) : null;
  const resourceKey = typeof s.resourceKey === 'string' && s.resourceKey.trim() ? s.resourceKey.trim().slice(0, 160) : null;
  const scopeKey = typeof s.scopeKey === 'string' && s.scopeKey.trim()
    ? s.scopeKey.trim().slice(0, 200)
    : `a:${accountId ?? '-'}|c:${characterId ?? '-'}|r:${resourceKey ?? '-'}`;

  const lockKeys = [];
  if (accountId !== null) lockKeys.push(`acct:${accountId}`);
  if (characterId !== null) lockKeys.push(`char:${characterId}`);
  if (Array.isArray(s.characterIds)) {
    for (const id of s.characterIds) {
      if (id != null && Number.isSafeInteger(Number(id))) lockKeys.push(`char:${Number(id)}`);
    }
  }
  if (resourceKey !== null) lockKeys.push(`res:${resourceKey}`);
  if (Array.isArray(s.resourceKeys)) {
    for (const rk of s.resourceKeys) {
      if (typeof rk === 'string' && rk.trim()) lockKeys.push(`res:${rk.trim()}`);
    }
  }
  const uniqueLocks = [...new Set(lockKeys)].sort();
  const characterIds = [...new Set([
    ...(characterId !== null ? [characterId] : []),
    ...(Array.isArray(s.characterIds) ? s.characterIds.map(Number).filter(Number.isSafeInteger) : []),
  ])].sort((a, b) => a - b);

  return {
    accountId,
    characterId,
    characterIds,
    resourceKey,
    scopeKey,
    lockKeys: uniqueLocks,
    params: s.params ?? null,
    ttlMs: s.ttlMs ?? null,
  };
}

/** Deadlock-free sorted multi-key async mutex. */
export function createKeyedLock() {
  const tails = new Map();
  return async function withLocks(keys, fn) {
    const sorted = [...new Set((keys ?? []).filter((k) => typeof k === 'string' && k))].sort();
    if (!sorted.length) return fn();
    const releases = [];
    for (const key of sorted) {
      const prev = tails.get(key) ?? Promise.resolve();
      let release;
      const cur = new Promise((r) => { release = r; });
      const tail = prev.then(() => cur);
      tails.set(key, tail);
      await prev;
      releases.push(() => {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      });
    }
    try {
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    }
  };
}

export class CorruptCharacterError extends Error {}

export class DurableConflictError extends Error {
  constructor(message = 'operation key already used with different parameters', code = 'DURABLE_KEY_CONFLICT') {
    super(message);
    this.name = 'DurableConflictError';
    this.code = code;
    this.status = 409;
  }
}

export class SlotError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'SlotError';
    this.code = code;
    this.status = status;
  }
}

function parseRpg(text, id) {
  let v;
  try {
    v = JSON.parse(text ?? '{}');
  } catch {
    throw new CorruptCharacterError(`character ${id} has unreadable RPG data`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new CorruptCharacterError(`character ${id} has invalid RPG data`);
  return v;
}

function parseJsonOrNull(text) {
  if (text == null) return null;
  if (typeof text !== 'string') return structuredClone(text);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function rowOut(row) {
  if (!row) return null;
  const id = Number(row.id);
  return { id, name: row.name, x: row.x, z: row.z, yaw: row.yaw, rpg: parseRpg(row.rpg, id) };
}

function rosterRowOut(row) {
  if (!row) return null;
  const base = rowOut(row);
  return {
    ...base,
    playerId: base.id,
    accountId: String(row.account_id),
    slot: Number(row.slot),
    username: row.username,
    displayName: row.display_name || base.name,
    grandfathered: Boolean(row.grandfathered),
    status: row.status || 'active',
    draft: Boolean(row.draft),
    linkedAt: Number(row.linked_at),
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

function serializeRpg(p) {
  const text = JSON.stringify(p.rpg ?? {});
  if (typeof text !== 'string') throw new Error('character data is not serializable');
  if (text.length > MAX_RPG_BYTES) throw new Error('character data too large to save');
  return text;
}

const newEscrowId = () => `esc_${randomBytes(8).toString('hex')}`;
const newClaimId = () => `clm_${randomBytes(8).toString('hex')}`;

export function openStore(dbPath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      z REAL NOT NULL DEFAULT 0,
      yaw REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
  `);
  // v2: additive migration.
  const cols = new Set(db.prepare('PRAGMA table_info(players)').all().map((c) => c.name));
  if (!cols.has('rpg')) db.exec(`ALTER TABLE players ADD COLUMN rpg TEXT NOT NULL DEFAULT '{}'`);

  // v3: account_characters many-per-account roster with lossless v2 -> v3 migration.
  const acTableExists = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_characters'").get();
  if (!acTableExists) {
    db.exec(`
      CREATE TABLE account_characters (
        player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        slot INTEGER NOT NULL CHECK (slot >= 1),
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        display_name_key TEXT NOT NULL,
        grandfathered INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        draft INTEGER NOT NULL DEFAULT 0,
        linked_at INTEGER NOT NULL,
        last_played_at INTEGER,
        last_selected INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        purge_after INTEGER,
        UNIQUE (account_id, slot)
      );
    `);
  } else {
    const acCols = new Set(db.prepare('PRAGMA table_info(account_characters)').all().map((c) => c.name));
    if (!acCols.has('slot')) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE account_characters_v3 (
            player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
            account_id TEXT NOT NULL,
            slot INTEGER NOT NULL CHECK (slot >= 1),
            username TEXT NOT NULL,
            display_name TEXT NOT NULL,
            display_name_key TEXT NOT NULL,
            grandfathered INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
            draft INTEGER NOT NULL DEFAULT 0,
            linked_at INTEGER NOT NULL,
            last_played_at INTEGER,
            last_selected INTEGER NOT NULL DEFAULT 0,
            archived_at INTEGER,
            purge_after INTEGER,
            UNIQUE (account_id, slot)
          );
          INSERT INTO account_characters_v3 (
            player_id, account_id, slot, username, display_name, display_name_key,
            grandfathered, status, draft, linked_at, last_played_at, last_selected, archived_at, purge_after
          )
          SELECT
            a.player_id,
            a.account_id,
            1,
            a.username,
            p.name,
            lower(trim(p.name)),
            1,
            'active',
            0,
            a.linked_at,
            p.last_seen,
            1,
            NULL,
            NULL
          FROM account_characters a
          JOIN players p ON p.id = a.player_id;
          DROP TABLE account_characters;
          ALTER TABLE account_characters_v3 RENAME TO account_characters;
        `);
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_characters_account
      ON account_characters (account_id, slot);
    CREATE INDEX IF NOT EXISTS idx_account_characters_name_key
      ON account_characters (display_name_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_characters_name_unique
      ON account_characters (display_name_key) WHERE grandfathered = 0;
    CREATE INDEX IF NOT EXISTS idx_account_characters_purge
      ON account_characters (status, purge_after) WHERE status = 'archived';
  `);

  // Shared world state written by features (e.g. shop ledgers), saved in the same transaction as characters.
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // v3: Durable idempotency, escrow, and claim ledger tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_ops (
      scope_key TEXT NOT NULL,
      op_key TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'committed',
      result TEXT,
      account_id TEXT,
      character_id INTEGER,
      resource_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      PRIMARY KEY (scope_key, op_key)
    );
    CREATE INDEX IF NOT EXISTS idx_durable_ops_account
      ON durable_ops (account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_durable_ops_expires
      ON durable_ops (expires_at) WHERE expires_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS escrow_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner_account_id TEXT,
      owner_character_id INTEGER,
      counterparty_character_id INTEGER,
      source_ref TEXT,
      gold INTEGER NOT NULL DEFAULT 0,
      item_json TEXT,
      status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'settled', 'refunded', 'expired')),
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_escrow_owner_status
      ON escrow_records (owner_character_id, status);
    CREATE INDEX IF NOT EXISTS idx_escrow_counterparty_status
      ON escrow_records (counterparty_character_id, status);
    CREATE INDEX IF NOT EXISTS idx_escrow_due
      ON escrow_records (status, expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_escrow_source
      ON escrow_records (source_ref) WHERE source_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS claim_records (
      id TEXT PRIMARY KEY,
      owner_character_id INTEGER NOT NULL,
      owner_account_id TEXT,
      kind TEXT NOT NULL,
      source_ref TEXT,
      gold INTEGER NOT NULL DEFAULT 0,
      item_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired', 'forfeited')),
      reason TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_claims_owner_status
      ON claim_records (owner_character_id, status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_claims_due
      ON claim_records (status, expires_at) WHERE expires_at IS NOT NULL;
  `);

  if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  const SEL = 'p.id, p.name, p.x, p.z, p.yaw, p.rpg';
  const SEL_ROSTER = `${SEL}, a.account_id, a.slot, a.username, a.display_name, a.display_name_key,
    a.grandfathered, a.status, a.draft, a.linked_at, a.last_played_at, a.last_selected, a.archived_at, a.purge_after`;

  const insert = db.prepare(
    'INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg) VALUES (?, ?, 0, 0, 0, ?, ?, ?)'
  );
  const byId = db.prepare(`SELECT ${SEL} FROM players p WHERE p.id = ?`);
  const byHash = db.prepare(
    `SELECT ${SEL} FROM players p WHERE p.token_hash = ?
       AND NOT EXISTS (SELECT 1 FROM account_characters a WHERE a.player_id = p.id)`
  );
  const byAccountPrimary = db.prepare(
    `SELECT ${SEL_ROSTER}
       FROM account_characters a
       JOIN players p ON p.id = a.player_id
      WHERE a.account_id = ? AND a.status = 'active'
      ORDER BY a.last_selected DESC, a.slot ASC
      LIMIT 1`
  );
  const listAccountAll = db.prepare(
    `SELECT ${SEL_ROSTER}
       FROM account_characters a
       JOIN players p ON p.id = a.player_id
      WHERE a.account_id = ?
      ORDER BY a.slot ASC`
  );
  const listAccountActive = db.prepare(
    `SELECT ${SEL_ROSTER}
       FROM account_characters a
       JOIN players p ON p.id = a.player_id
      WHERE a.account_id = ? AND a.status = 'active'
      ORDER BY a.slot ASC`
  );
  const byAccountChar = db.prepare(
    `SELECT ${SEL_ROSTER}
       FROM account_characters a
       JOIN players p ON p.id = a.player_id
      WHERE a.account_id = ? AND a.player_id = ?`
  );
  const accountRowsOnly = db.prepare('SELECT player_id, slot, status, purge_after FROM account_characters WHERE account_id = ? ORDER BY slot ASC');
  const nameTakenStmt = db.prepare('SELECT player_id, account_id, status, purge_after FROM account_characters WHERE display_name_key = ?');
  const linkSlot = db.prepare(
    `INSERT INTO account_characters (
       player_id, account_id, slot, username, display_name, display_name_key,
       grandfathered, status, draft, linked_at, last_played_at, last_selected, archived_at, purge_after
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)`
  );
  const clearSelected = db.prepare('UPDATE account_characters SET last_selected = 0 WHERE account_id = ?');
  const setSelected = db.prepare("UPDATE account_characters SET last_selected = 1 WHERE account_id = ? AND player_id = ? AND status = 'active'");
  const touchPlayed = db.prepare("UPDATE account_characters SET last_played_at = ?, last_selected = 1 WHERE account_id = ? AND player_id = ? AND status = 'active'");
  const setDraftDone = db.prepare('UPDATE account_characters SET draft = 0 WHERE account_id = ? AND player_id = ?');
  const updateDisplayNameLink = db.prepare(
    'UPDATE account_characters SET display_name = ?, display_name_key = ?, grandfathered = 0 WHERE account_id = ? AND player_id = ?'
  );
  const updatePlayerName = db.prepare('UPDATE players SET name = ? WHERE id = ?');
  const archiveStmt = db.prepare(
    `UPDATE account_characters
        SET status = 'archived', archived_at = ?, purge_after = ?, last_selected = 0
      WHERE account_id = ? AND player_id = ? AND status = 'active'`
  );
  const restoreStmt = db.prepare(
    `UPDATE account_characters
        SET status = 'active', archived_at = NULL, purge_after = NULL, last_selected = 1
      WHERE account_id = ? AND player_id = ? AND status = 'archived'`
  );
  const expiredForAccount = db.prepare(
    `SELECT player_id, account_id, slot, display_name
       FROM account_characters
      WHERE account_id = ? AND status = 'archived' AND purge_after IS NOT NULL AND purge_after <= ?`
  );
  const expiredGlobal = db.prepare(
    `SELECT player_id, account_id, slot, display_name
       FROM account_characters
      WHERE status = 'archived' AND purge_after IS NOT NULL AND purge_after <= ?
      ORDER BY purge_after ASC
      LIMIT ?`
  );
  const delAccountCharById = db.prepare('DELETE FROM account_characters WHERE player_id = ?');
  const delAccountCharsByAcct = db.prepare('DELETE FROM account_characters WHERE account_id = ?');
  const delPlayerById = db.prepare('DELETE FROM players WHERE id = ?');
  const setLinkName = db.prepare('UPDATE account_characters SET username = ? WHERE account_id = ?');
  const setTokenHash = db.prepare('UPDATE players SET token_hash = ?, name = ? WHERE id = ?');
  const save = db.prepare('UPDATE players SET name = ?, x = ?, z = ?, yaw = ?, rpg = ?, last_seen = ? WHERE id = ?');
  const getWorldStmt = db.prepare('SELECT value FROM world_state WHERE key = ?');
  const putWorld = db.prepare('INSERT INTO world_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const delWorld = db.prepare('DELETE FROM world_state WHERE key = ?');
  const worldByPrefix = db.prepare("SELECT key, value FROM world_state WHERE substr(key, 1, length(?)) = ? ORDER BY key");

  // Durable ops statements
  const getDurableOpStmt = db.prepare(
    'SELECT scope_key, op_key, params_hash, status, result, account_id, character_id, resource_key, created_at, updated_at, expires_at FROM durable_ops WHERE scope_key = ? AND op_key = ?'
  );
  const putDurableOpStmt = db.prepare(
    `INSERT INTO durable_ops (scope_key, op_key, params_hash, status, result, account_id, character_id, resource_key, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_key, op_key) DO UPDATE SET
       status = excluded.status,
       result = excluded.result,
       updated_at = excluded.updated_at,
       expires_at = excluded.expires_at`
  );
  const pruneDurableOpsStmt = db.prepare('DELETE FROM durable_ops WHERE expires_at IS NOT NULL AND expires_at <= ?');

  // Escrow statements
  const insertEscrowStmt = db.prepare(
    `INSERT INTO escrow_records (
       id, kind, owner_account_id, owner_character_id, counterparty_character_id,
       source_ref, gold, item_json, status, revision, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  );
  const getEscrowStmt = db.prepare('SELECT * FROM escrow_records WHERE id = ?');
  const updateEscrowStatusStmt = db.prepare(
    `UPDATE escrow_records
        SET status = ?, gold = ?, item_json = ?, counterparty_character_id = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?`
  );

  // Claim statements
  const insertClaimStmt = db.prepare(
    `INSERT INTO claim_records (
       id, owner_character_id, owner_account_id, kind, source_ref, gold, item_json,
       status, reason, revision, expires_at, created_at, claimed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, NULL)`
  );
  const getClaimStmt = db.prepare('SELECT * FROM claim_records WHERE id = ?');
  const updateClaimStmt = db.prepare(
    `UPDATE claim_records
        SET status = ?, claimed_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND status = 'pending'`
  );

  const withLocks = createKeyedLock();

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  function writePlayersAndWorld(playersList, worldList, ts) {
    const rows = (playersList ?? []).map((p) => [p.name, p.x, p.z, p.yaw, serializeRpg(p), p.id]);
    const worldRows = (worldList ?? []).map(([key, value]) => {
      if (typeof key !== 'string' || !key || key.length > 200) throw new Error('invalid world state key');
      if (value === null || value === undefined) return [key, null];
      const text = JSON.stringify(value);
      if (text.length > MAX_RPG_BYTES) throw new Error('world state too large to save');
      return [key, text];
    });
    for (const [name, x, z, yaw, rpg, id] of rows) save.run(name, x, z, yaw, rpg, ts, id);
    for (const [key, text] of worldRows) {
      if (text === null) delWorld.run(key);
      else putWorld.run(key, text, ts);
    }
  }

  function queryEscrow(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.ownerCharacterId != null) { clauses.push('owner_character_id = ?'); params.push(Number(filter.ownerCharacterId)); }
    if (filter.counterpartyCharacterId != null) { clauses.push('counterparty_character_id = ?'); params.push(Number(filter.counterpartyCharacterId)); }
    if (filter.involvingCharacterId != null) {
      clauses.push('(owner_character_id = ? OR counterparty_character_id = ?)');
      params.push(Number(filter.involvingCharacterId), Number(filter.involvingCharacterId));
    }
    if (filter.ownerAccountId != null) { clauses.push('owner_account_id = ?'); params.push(String(filter.ownerAccountId)); }
    if (filter.status != null) { clauses.push('status = ?'); params.push(String(filter.status)); }
    if (filter.kind != null) { clauses.push('kind = ?'); params.push(String(filter.kind)); }
    if (filter.sourceRef != null) { clauses.push('source_ref = ?'); params.push(String(filter.sourceRef)); }
    if (filter.dueBefore != null) { clauses.push('expires_at IS NOT NULL AND expires_at <= ?'); params.push(Number(filter.dueBefore)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(500, filter.limit) : 100;
    const rows = db.prepare(`SELECT * FROM escrow_records ${where} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params, limit);
    return rows.map(escrowRowOut);
  }

  function queryClaims(filter = {}) {
    const clauses = [];
    const params = [];
    if (filter.ownerCharacterId != null) { clauses.push('owner_character_id = ?'); params.push(Number(filter.ownerCharacterId)); }
    if (filter.ownerAccountId != null) { clauses.push('owner_account_id = ?'); params.push(String(filter.ownerAccountId)); }
    if (filter.status != null) { clauses.push('status = ?'); params.push(String(filter.status)); }
    if (filter.kind != null) { clauses.push('kind = ?'); params.push(String(filter.kind)); }
    if (filter.sourceRef != null) { clauses.push('source_ref = ?'); params.push(String(filter.sourceRef)); }
    if (filter.dueBefore != null) { clauses.push('expires_at IS NOT NULL AND expires_at <= ?'); params.push(Number(filter.dueBefore)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(500, filter.limit) : 100;
    const rows = db.prepare(`SELECT * FROM claim_records ${where} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params, limit);
    return rows.map(claimRowOut);
  }

  function makeTxContext(ts) {
    return {
      backend: 'sqlite',
      db,
      now: ts,
      getCharacter(playerId) {
        return rowOut(byId.get(Number(playerId)));
      },
      saveCharacters(playersList, worldList = []) {
        writePlayersAndWorld(playersList, worldList, ts);
      },
      getWorld(key) {
        const r = getWorldStmt.get(String(key));
        return r ? parseJsonOrNull(r.value) : null;
      },
      putWorld(key, value) {
        writePlayersAndWorld([], [[key, value]], ts);
      },
      deleteWorld(key) {
        delWorld.run(String(key));
      },
      createEscrow(rec) {
        const id = rec.id ? String(rec.id) : newEscrowId();
        const gold = Math.max(0, Math.trunc(Number(rec.gold ?? 0)));
        const itemJson = rec.item == null ? null : JSON.stringify(rec.item);
        insertEscrowStmt.run(
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
        );
        return escrowRowOut(getEscrowStmt.get(id));
      },
      getEscrow(id) {
        return escrowRowOut(getEscrowStmt.get(String(id)));
      },
      updateEscrowStatus(id, expectedRev, status, patch = {}) {
        const cur = getEscrowStmt.get(String(id));
        if (!cur || Number(cur.revision) !== Number(expectedRev)) {
          throw new DurableConflictError(`escrow ${id} revision mismatch`, 'REVISION_CONFLICT');
        }
        const gold = patch.gold !== undefined ? Math.max(0, Math.trunc(Number(patch.gold))) : Number(cur.gold);
        const itemJson = patch.item !== undefined ? (patch.item == null ? null : JSON.stringify(patch.item)) : cur.item_json;
        const cp = patch.counterpartyCharacterId !== undefined
          ? (patch.counterpartyCharacterId == null ? null : Number(patch.counterpartyCharacterId))
          : cur.counterparty_character_id;
        const res = updateEscrowStatusStmt.run(String(status), gold, itemJson, cp, ts, String(id), Number(expectedRev));
        if (res.changes !== 1) {
          throw new DurableConflictError(`escrow ${id} concurrent update`, 'REVISION_CONFLICT');
        }
        return escrowRowOut(getEscrowStmt.get(String(id)));
      },
      listEscrow: queryEscrow,
      createClaim(rec) {
        const id = rec.id ? String(rec.id) : newClaimId();
        const gold = Math.max(0, Math.trunc(Number(rec.gold ?? 0)));
        const itemJson = rec.item == null ? null : JSON.stringify(rec.item);
        insertClaimStmt.run(
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
        );
        return claimRowOut(getClaimStmt.get(id));
      },
      getClaim(id) {
        return claimRowOut(getClaimStmt.get(String(id)));
      },
      claimRecord(id, expectedRev, nextStatus = 'claimed') {
        const res = updateClaimStmt.run(String(nextStatus), ts, String(id), Number(expectedRev));
        if (res.changes !== 1) {
          throw new DurableConflictError(`claim ${id} already settled or revision mismatch`, 'REVISION_CONFLICT');
        }
        return claimRowOut(getClaimStmt.get(String(id)));
      },
      listClaims: queryClaims,
    };
  }

  function purgeExpiredForAccountInTx(acctKey, ts) {
    const due = expiredForAccount.all(acctKey, ts);
    for (const r of due) {
      delAccountCharById.run(r.player_id);
      delPlayerById.run(r.player_id);
    }
    return due.map((r) => ({ accountId: r.account_id, playerId: Number(r.player_id), slot: Number(r.slot), name: r.display_name }));
  }

  function checkNameAvailableInTx(name, ts, excludePlayerId = null) {
    const key = normalizeDisplayNameKey(name);
    if (!key) throw new SlotError('INVALID_NAME', 'Character name is required.', 400);
    const matches = nameTakenStmt.all(key);
    for (const m of matches) {
      if (excludePlayerId != null && Number(m.player_id) === Number(excludePlayerId)) continue;
      // Expired archived names are released immediately.
      if (m.status === 'archived' && m.purge_after != null && Number(m.purge_after) <= ts) {
        delAccountCharById.run(m.player_id);
        delPlayerById.run(m.player_id);
        continue;
      }
      throw new SlotError('NAME_TAKEN', `The character name "${name}" is already in use.`, 409);
    }
    return key;
  }

  const unrevealedHash = () => hashToken(newToken()); // nobody ever learns the preimage
  const accountKey = (id) => String(id);

  return {
    backend: 'sqlite',
    db,
    transaction,
    /** New guest character. Returns the plaintext token once. */
    create(name, rpg = {}) {
      const token = newToken();
      const ts = now();
      const { lastInsertRowid } = insert.run(hashToken(token), name, ts, ts, JSON.stringify(rpg));
      return { token, row: { id: Number(lastInsertRowid), name, x: 0, z: 0, yaw: 0, rpg: structuredClone(rpg) } };
    },
    /** Unclaimed guest character for a token, or null. Account-linked characters never match. */
    findByToken(token) {
      return rowOut(byHash.get(hashToken(token)));
    },
    /** Primary (last selected / lowest slot active) character for the account, or null. */
    findByAccount(accountId) {
      const row = byAccountPrimary.get(accountKey(accountId));
      return rosterRowOut(row);
    },
    /** All characters for an account ordered by slot ASC (active + optionally archived). */
    listByAccount(accountId, { includeArchived = true } = {}) {
      const key = accountKey(accountId);
      const rows = includeArchived ? listAccountAll.all(key) : listAccountActive.all(key);
      return rows.map(rosterRowOut);
    },
    /** Find a specific character owned by an account, or null. */
    findAccountCharacter(accountId, characterId) {
      if (!Number.isSafeInteger(Number(characterId))) return null;
      return rosterRowOut(byAccountChar.get(accountKey(accountId), Number(characterId)));
    },
    /** Check whether a character display name is available (case-insensitive). */
    isDisplayNameAvailable(name, { excludePlayerId = null } = {}) {
      const key = normalizeDisplayNameKey(name);
      if (!key) return false;
      const ts = now();
      const matches = nameTakenStmt.all(key);
      for (const m of matches) {
        if (excludePlayerId != null && Number(m.player_id) === Number(excludePlayerId)) continue;
        if (m.status === 'archived' && m.purge_after != null && Number(m.purge_after) <= ts) continue;
        return false;
      }
      return true;
    },
    /**
     * Creates a new character slot for an account (up to maxSlots, default 3).
     * Enforces slot uniqueness, slot cap, and case-insensitive display name reservation transactionally.
     */
    createCharacterSlot(accountId, username, opts = {}) {
      const {
        slot: requestedSlot = null,
        name = username,
        maxSlots = MAX_CHARACTER_SLOTS,
        draft = true,
        grandfathered = false,
      } = opts;
      return transaction(() => {
        const key = accountKey(accountId);
        const ts = now();
        purgeExpiredForAccountInTx(key, ts);
        const existing = accountRowsOnly.all(key);
        if (existing.length >= maxSlots) {
          throw new SlotError('SLOT_CAP_REACHED', `You can have at most ${maxSlots} characters per account.`, 409);
        }
        const usedSlots = new Set(existing.map((r) => Number(r.slot)));
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
        const nameKey = grandfathered ? normalizeDisplayNameKey(name) : checkNameAvailableInTx(name, ts);
        const { lastInsertRowid } = insert.run(unrevealedHash(), name, ts, ts, '{}');
        const id = Number(lastInsertRowid);
        clearSelected.run(key);
        linkSlot.run(id, key, slot, username, name, nameKey, grandfathered ? 1 : 0, draft ? 1 : 0, ts, ts, 1);
        return rosterRowOut(byAccountChar.get(key, id));
      });
    },
    /** Legacy single-slot creation (creates slot 1; throws if slot 1 already exists unless opts.slot is given). */
    createForAccount(accountId, username, name = username, opts = {}) {
      const slot = opts.slot ?? 1;
      const maxSlots = opts.maxSlots ?? MAX_CHARACTER_SLOTS;
      return this.createCharacterSlot(accountId, username, {
        slot,
        name,
        maxSlots,
        draft: opts.draft ?? false,
        grandfathered: opts.grandfathered ?? true,
      });
    },
    /**
     * Moves an unclaimed guest character into an account that has an empty roster (slot 1),
     * revoking the guest token and keeping that character's ID.
     */
    claimGuest(accountId, username, token, name = username) {
      return transaction(() => {
        const key = accountKey(accountId);
        const ts = now();
        purgeExpiredForAccountInTx(key, ts);
        if (accountRowsOnly.all(key).length > 0) return null;
        const row = rowOut(byHash.get(hashToken(token)));
        if (!row) return null;
        const nameKey = normalizeDisplayNameKey(name);
        linkSlot.run(row.id, key, 1, username, name, nameKey, 1, 0, ts, ts, 1);
        setTokenHash.run(unrevealedHash(), name, row.id);
        return rosterRowOut(byAccountChar.get(key, row.id));
      });
    },
    setAccountUsername(accountId, username) {
      setLinkName.run(username, accountKey(accountId));
    },
    selectCharacter(accountId, characterId) {
      return transaction(() => {
        const key = accountKey(accountId);
        const row = byAccountChar.get(key, Number(characterId));
        if (!row) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (row.status !== 'active') throw new SlotError('INVALID_STATE', 'Archived characters must be restored first.', 409);
        clearSelected.run(key);
        setSelected.run(key, Number(characterId));
        return rosterRowOut(byAccountChar.get(key, Number(characterId)));
      });
    },
    touchCharacterPlayed(accountId, characterId, ts = now()) {
      return transaction(() => {
        const key = accountKey(accountId);
        clearSelected.run(key);
        touchPlayed.run(ts, key, Number(characterId));
      });
    },
    markCharacterDraftComplete(accountId, characterId, finalName = null) {
      return transaction(() => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const cur = byAccountChar.get(key, id);
        if (!cur) return null;
        if (finalName && finalName !== cur.display_name) {
          const ts = now();
          const nameKey = checkNameAvailableInTx(finalName, ts, id);
          updateDisplayNameLink.run(finalName, nameKey, key, id);
          updatePlayerName.run(finalName, id);
        }
        setDraftDone.run(key, id);
        return rosterRowOut(byAccountChar.get(key, id));
      });
    },
    renameCharacter(accountId, characterId, newName) {
      return transaction(() => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const cur = byAccountChar.get(key, id);
        if (!cur) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        const nameKey = checkNameAvailableInTx(newName, now(), id);
        updateDisplayNameLink.run(newName, nameKey, key, id);
        updatePlayerName.run(newName, id);
        return rosterRowOut(byAccountChar.get(key, id));
      });
    },
    archiveCharacter(accountId, characterId, { archiveWindowMs = ARCHIVE_WINDOW_MS, at = now() } = {}) {
      return transaction(() => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const cur = byAccountChar.get(key, id);
        if (!cur) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (cur.status !== 'active') throw new SlotError('INVALID_STATE', 'Character is already archived.', 409);
        const purgeAfter = at + Math.max(0, Number(archiveWindowMs) || 0);
        archiveStmt.run(at, purgeAfter, key, id);
        const remaining = listAccountActive.all(key);
        if (remaining.length) {
          remaining.sort((a, b) => (Number(b.last_played_at ?? 0) - Number(a.last_played_at ?? 0)) || (Number(a.slot) - Number(b.slot)));
          clearSelected.run(key);
          setSelected.run(key, Number(remaining[0].id));
        }
        return rosterRowOut(byAccountChar.get(key, id));
      });
    },
    restoreCharacter(accountId, characterId, { at = now() } = {}) {
      return transaction(() => {
        const key = accountKey(accountId);
        const id = Number(characterId);
        const cur = byAccountChar.get(key, id);
        if (!cur) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (cur.status !== 'archived') throw new SlotError('INVALID_STATE', 'Character is not archived.', 409);
        if (cur.purge_after != null && Number(cur.purge_after) <= at) {
          delAccountCharById.run(id);
          delPlayerById.run(id);
          throw new SlotError('ARCHIVE_EXPIRED', 'The restore window for this character has expired.', 410);
        }
        clearSelected.run(key);
        restoreStmt.run(key, id);
        return rosterRowOut(byAccountChar.get(key, id));
      });
    },
    purgeExpiredArchived({ accountId = null, at = now(), limit = 50 } = {}) {
      return transaction(() => {
        if (accountId !== null && accountId !== undefined) {
          return purgeExpiredForAccountInTx(accountKey(accountId), at);
        }
        const due = expiredGlobal.all(at, Math.max(1, Math.min(500, Number(limit) || 50)));
        for (const r of due) {
          delAccountCharById.run(r.player_id);
          delPlayerById.run(r.player_id);
        }
        return due.map((r) => ({ accountId: r.account_id, playerId: Number(r.player_id), slot: Number(r.slot), name: r.display_name }));
      });
    },
    /** Deletes ALL character links and linked player rows for an account in one transaction. Returns deleted playerIds. */
    deleteAllForAccount(accountId) {
      return transaction(() => {
        const key = accountKey(accountId);
        const rows = accountRowsOnly.all(key);
        const ids = rows.map((r) => Number(r.player_id));
        if (!ids.length) return [];
        delAccountCharsByAcct.run(key);
        for (const id of ids) delPlayerById.run(id);
        return ids;
      });
    },
    /** Deletes an account's characters; returns the first deleted playerId or null for backward compatibility. */
    deleteForAccount(accountId) {
      const ids = this.deleteAllForAccount(accountId);
      return ids[0] ?? null;
    },
    /**
     * Durable transaction & idempotency runner for Wave 2 features (Homes/Orders, Professions, Market, Land PvP).
     * Serializes overlapping operations by sorted lock keys (account/character/resource), enforces idempotency
     * by `(scopeKey, opKey)` + `params_hash`, and commits mutations atomically with `durable_ops`.
     */
    async runDurable(opKey, scopeOrFn, maybeFn) {
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
      // Include a SQLite tx serialization key so async callbacks cannot interleave BEGIN/COMMIT.
      const lockKeys = ['__sqlite_tx__', ...normScope.lockKeys];
      return withLocks(lockKeys, async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const ts = now();
          if (key !== null) {
            const existing = getDurableOpStmt.get(normScope.scopeKey, key);
            if (existing) {
              if (existing.params_hash !== paramsHash) {
                throw new DurableConflictError(`operation key "${key}" was already used with different parameters`);
              }
              if (existing.status === 'committed') {
                db.exec('COMMIT');
                return { replayed: true, opKey: key, scopeKey: normScope.scopeKey, result: parseJsonOrNull(existing.result) };
              }
            }
          }
          const tx = makeTxContext(ts);
          const result = await fn(tx);
          const serialized = result === undefined ? null : JSON.stringify(result);
          if (key !== null) {
            const expiresAt = Number.isFinite(normScope.ttlMs) && normScope.ttlMs > 0 ? ts + Math.trunc(normScope.ttlMs) : null;
            putDurableOpStmt.run(
              normScope.scopeKey,
              key,
              paramsHash,
              'committed',
              serialized,
              normScope.accountId,
              normScope.characterId,
              normScope.resourceKey,
              ts,
              ts,
              expiresAt,
            );
          }
          db.exec('COMMIT');
          return { replayed: false, opKey: key, scopeKey: normScope.scopeKey, result };
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      });
    },
    getDurableOp(opKey, scope = {}) {
      const normScope = normalizeDurableScope(scope);
      const row = getDurableOpStmt.get(normScope.scopeKey, String(opKey));
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
    pruneDurableOps(beforeTs = now()) {
      return pruneDurableOpsStmt.run(Number(beforeTs)).changes;
    },
    listEscrow: queryEscrow,
    listClaims: queryClaims,
    /**
     * Saves full rows (name, position, rpg) for all players and the given world-state rows
     * (`[[key, value|null]]`, null deletes) in ONE transaction. Throws on failure.
     */
    saveCharacters(players, world = []) {
      if (!players.length && !world.length) return;
      const ts = now();
      transaction(() => {
        writePlayersAndWorld(players, world, ts);
      });
    },
    /** World-state rows whose key starts with `prefix`: [[key, parsedValue]]. Malformed rows are skipped. */
    loadWorld(prefix = '') {
      const out = [];
      for (const r of worldByPrefix.all(prefix, prefix)) {
        try {
          out.push([r.key, JSON.parse(r.value)]);
        } catch {
          /* skip a corrupt row; the feature rebuilds it */
        }
      }
      return out;
    },
    savePositions(players) {
      this.saveCharacters(players);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
