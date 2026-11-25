// Persistent characters in node:sqlite. Guest tokens are stored only as SHA-256 hashes.
//
// Schema (additive migrations only; existing rows and columns are never rewritten):
//   players(id, token_hash, name, x, z, yaw, created_at, last_seen, rpg)
//     rpg: JSON text of the private RPG state (`player.rpg`), default '{}'  [v2]
//   account_characters(account_id TEXT PK, player_id UNIQUE -> players.id, username, linked_at)  [v2]
//     One character per account. Account-linked rows get a random token hash that is never
//     revealed, and token lookups exclude linked rows, so guest credentials never open them.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 2;
export const MAX_RPG_BYTES = 256 * 1024;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url'); // 43 chars
}

export class CorruptCharacterError extends Error {}

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

function rowOut(row) {
  if (!row) return null;
  const id = Number(row.id);
  return { id, name: row.name, x: row.x, z: row.z, yaw: row.yaw, rpg: parseRpg(row.rpg, id) };
}

function serializeRpg(p) {
  const text = JSON.stringify(p.rpg ?? {});
  if (typeof text !== 'string') throw new Error('character data is not serializable');
  if (text.length > MAX_RPG_BYTES) throw new Error('character data too large to save');
  return text;
}

export function openStore(dbPath) {
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_characters (
      account_id TEXT PRIMARY KEY,
      player_id INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      linked_at INTEGER NOT NULL
    );
  `);
  // Shared world state written by features (e.g. shop ledgers), saved in the same transaction as characters.
  db.exec(`
    CREATE TABLE IF NOT EXISTS world_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (db.prepare('PRAGMA user_version').get().user_version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const SEL = 'p.id, p.name, p.x, p.z, p.yaw, p.rpg';
  const insert = db.prepare(
    'INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg) VALUES (?, ?, 0, 0, 0, ?, ?, ?)'
  );
  const byHash = db.prepare(
    `SELECT ${SEL} FROM players p WHERE p.token_hash = ?
       AND NOT EXISTS (SELECT 1 FROM account_characters a WHERE a.player_id = p.id)`
  );
  const byAccount = db.prepare(
    `SELECT ${SEL}, a.username FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = ?`
  );
  const link = db.prepare('INSERT INTO account_characters (account_id, player_id, username, linked_at) VALUES (?, ?, ?, ?)');
  const setLinkName = db.prepare('UPDATE account_characters SET username = ? WHERE account_id = ?');
  const setTokenHash = db.prepare('UPDATE players SET token_hash = ?, name = ? WHERE id = ?');
  const save = db.prepare('UPDATE players SET name = ?, x = ?, z = ?, yaw = ?, rpg = ?, last_seen = ? WHERE id = ?');
  const putWorld = db.prepare('INSERT INTO world_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
  const delWorld = db.prepare('DELETE FROM world_state WHERE key = ?');
  const worldByPrefix = db.prepare("SELECT key, value FROM world_state WHERE substr(key, 1, length(?)) = ? ORDER BY key");

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

  const unrevealedHash = () => hashToken(newToken()); // nobody ever learns the preimage
  const accountKey = (id) => String(id);

  return {
    db,
    transaction,
    /** New guest character. Returns the plaintext token once. */
    create(name, rpg = {}) {
      const token = newToken();
      const now = Date.now();
      const { lastInsertRowid } = insert.run(hashToken(token), name, now, now, JSON.stringify(rpg));
      return { token, row: { id: Number(lastInsertRowid), name, x: 0, z: 0, yaw: 0, rpg: structuredClone(rpg) } };
    },
    /** Unclaimed guest character for a token, or null. Account-linked characters never match. */
    findByToken(token) {
      return rowOut(byHash.get(hashToken(token)));
    },
    /** `{id,name,x,z,yaw,rpg,username}` for the account's character, or null. */
    findByAccount(accountId) {
      const row = byAccount.get(accountKey(accountId));
      return row ? { ...rowOut(row), username: row.username } : null;
    },
    /** Creates the account's character (no usable token). Throws if the account already has one. */
    createForAccount(accountId, username, name = username) {
      return transaction(() => {
        const now = Date.now();
        const { lastInsertRowid } = insert.run(unrevealedHash(), name, now, now, '{}');
        const id = Number(lastInsertRowid);
        link.run(accountKey(accountId), id, username, now);
        return { id, name, x: 0, z: 0, yaw: 0, rpg: {} };
      });
    },
    /**
     * Moves an unclaimed guest character into an account that has none yet, and revokes the guest
     * token. Returns the row, or null if the token is unknown/already claimed or the account has one.
     */
    claimGuest(accountId, username, token, name = username) {
      return transaction(() => {
        if (byAccount.get(accountKey(accountId))) return null;
        const row = rowOut(byHash.get(hashToken(token)));
        if (!row) return null;
        link.run(accountKey(accountId), row.id, username, Date.now());
        setTokenHash.run(unrevealedHash(), name, row.id);
        return { ...row, name };
      });
    },
    setAccountUsername(accountId, username) {
      setLinkName.run(username, accountKey(accountId));
    },
    /**
     * Saves full rows (name, position, rpg) for all players and the given world-state rows
     * (`[[key, value|null]]`, null deletes) in ONE transaction. Throws on failure.
     */
    saveCharacters(players, world = []) {
      if (!players.length && !world.length) return;
      const rows = players.map((p) => [p.name, p.x, p.z, p.yaw, serializeRpg(p), p.id]);
      const worldRows = world.map(([key, value]) => {
        if (typeof key !== 'string' || !key || key.length > 200) throw new Error('invalid world state key');
        if (value === null || value === undefined) return [key, null];
        const text = JSON.stringify(value);
        if (text.length > MAX_RPG_BYTES) throw new Error('world state too large to save');
        return [key, text];
      });
      const now = Date.now();
      transaction(() => {
        for (const [name, x, z, yaw, rpg, id] of rows) save.run(name, x, z, yaw, rpg, now, id);
        for (const [key, text] of worldRows) {
          if (text === null) delWorld.run(key);
          else putWorld.run(key, text, now);
        }
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
