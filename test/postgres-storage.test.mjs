import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openStore } from '../server/db.js';
import { openAccountStore, hashPassword } from '../server/accounts.js';
import {
  openPostgresGameStore,
  createBufferedGameStore,
  loadSchemaSql,
  CorruptCharacterError,
  MAX_RPG_BYTES,
} from '../server/storage/postgres-game.js';
import {
  openPostgresAccountStore,
  MODERATION_CHANNEL,
} from '../server/storage/postgres-accounts.js';
import {
  isPostgresUrl,
  detectBackend,
  openGameStorage,
  openAccountStorage,
} from '../server/storage/index.js';
import { migrateSqliteToPostgres, parseArgs } from '../tools/migrate-to-postgres.mjs';

/**
 * In-memory mock PostgreSQL Pool + Client supporting:
 * - BEGIN / COMMIT / ROLLBACK with transactional state rollback
 * - Parameterized queries ($1, $2, ...) for all game, account, and migration SQL
 * - Unique constraint enforcement (code 23505)
 * - LISTEN / UNLISTEN and pg_notify() fan-out on COMMIT
 * - Sequence tracking + setval()
 * - Optional failNextQuery / delayQuery hooks for concurrency & fault-injection tests
 */
function createMockPgPool() {
  let state = {
    schemaApplied: 0,
    migrations: new Map(),
    players: new Map(), // id -> row
    accountCharacters: new Map(), // account_id -> row
    worldState: new Map(), // key -> row
    accounts: new Map(), // id -> row
    sessions: new Map(), // id -> row
    moderationLog: new Map(), // id -> row
    seqs: { players: 0, accounts: 0, sessions: 0, moderation_log: 0 },
  };

  const listeners = new Map(); // channel -> Set<client>
  const queryLog = [];
  let failNextQuery = null;
  let queryHook = null;
  let ended = false;

  function cloneState(s) {
    return {
      schemaApplied: s.schemaApplied,
      migrations: new Map(s.migrations),
      players: new Map([...s.players].map(([k, v]) => [k, structuredClone(v)])),
      accountCharacters: new Map([...s.accountCharacters].map(([k, v]) => [k, structuredClone(v)])),
      worldState: new Map([...s.worldState].map(([k, v]) => [k, structuredClone(v)])),
      accounts: new Map([...s.accounts].map(([k, v]) => [k, structuredClone(v)])),
      sessions: new Map([...s.sessions].map(([k, v]) => [k, structuredClone(v)])),
      moderationLog: new Map([...s.moderationLog].map(([k, v]) => [k, structuredClone(v)])),
      seqs: { ...s.seqs },
    };
  }

  function uniqueError(constraint) {
    const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
    err.code = '23505';
    return err;
  }

  function deliverNotifications(notifications) {
    for (const { channel, payload } of notifications) {
      const set = listeners.get(channel);
      if (!set) continue;
      for (const client of set) {
        client.emit('notification', { channel, payload });
      }
    }
  }

  async function executeSql(rawSql, params = [], clientCtx = null) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    queryLog.push({ sql, params });

    if (queryHook) {
      await queryHook(sql, params);
    }
    if (failNextQuery && !/^ROLLBACK$/i.test(sql)) {
      const err = failNextQuery;
      failNextQuery = null;
      throw err;
    }

    // Transaction control
    if (/^BEGIN$/i.test(sql)) {
      clientCtx.txSnapshot = cloneState(state);
      clientCtx.pendingNotifications = [];
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql)) {
      const pending = clientCtx.pendingNotifications ?? [];
      clientCtx.txSnapshot = null;
      clientCtx.pendingNotifications = [];
      deliverNotifications(pending);
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(sql)) {
      if (clientCtx.txSnapshot) {
        state = clientCtx.txSnapshot;
        clientCtx.txSnapshot = null;
      }
      clientCtx.pendingNotifications = [];
      return { rows: [], rowCount: 0 };
    }

    // Schema DDL
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      state.schemaApplied += 1;
      state.migrations.set(2, { version: 2, name: 'initial_postgres_schema' });
      return { rows: [], rowCount: 0 };
    }

    // LISTEN / UNLISTEN
    const listenMatch = /^LISTEN\s+([a-zA-Z0-9_]+)$/i.exec(sql);
    if (listenMatch) {
      const ch = listenMatch[1];
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch).add(clientCtx.client);
      return { rows: [], rowCount: 0 };
    }
    const unlistenMatch = /^UNLISTEN\s+([a-zA-Z0-9_]+)$/i.exec(sql);
    if (unlistenMatch) {
      const ch = unlistenMatch[1];
      listeners.get(ch)?.delete(clientCtx.client);
      return { rows: [], rowCount: 0 };
    }

    // pg_notify
    if (/^SELECT pg_notify\(\$1, \$2\)$/i.test(sql)) {
      const note = { channel: params[0], payload: params[1] };
      if (clientCtx?.txSnapshot) {
        clientCtx.pendingNotifications.push(note);
      } else {
        deliverNotifications([note]);
      }
      return { rows: [{ pg_notify: '' }], rowCount: 1 };
    }

    // setval(pg_get_serial_sequence(...))
    if (sql.startsWith('SELECT setval( pg_get_serial_sequence($1, $2)')) {
      const table = params[0];
      const map = {
        players: state.players,
        accounts: state.accounts,
        sessions: state.sessions,
        moderation_log: state.moderationLog,
      }[table];
      let maxId = 0;
      for (const k of map.keys()) if (k > maxId) maxId = k;
      state.seqs[table] = maxId;
      return { rows: [{ setval: String(maxId || 1) }], rowCount: 1 };
    }

    // ---- players ----

    // Migration upsert into players (with explicit id)
    if (sql.startsWith('INSERT INTO players (id, token_hash, name, x, z, yaw, created_at, last_seen, rpg)')) {
      const [id, token_hash, name, x, z, yaw, created_at, last_seen, rpg] = params;
      state.players.set(Number(id), {
        id: String(id),
        token_hash,
        name,
        x: Number(x),
        z: Number(z),
        yaw: Number(yaw),
        created_at: String(created_at),
        last_seen: String(last_seen),
        rpg: typeof rpg === 'string' ? JSON.parse(rpg) : rpg,
      });
      return { rows: [], rowCount: 1 };
    }

    // Standard insert into players (create / createForAccount)
    if (sql.startsWith('INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg)')) {
      const hasRpgParam = params.length === 5;
      const [token_hash, name, created_at, last_seen] = params;
      const rpg = hasRpgParam ? JSON.parse(params[4]) : {};
      for (const p of state.players.values()) {
        if (p.token_hash === token_hash) throw uniqueError('players_token_hash_key');
      }
      const id = ++state.seqs.players;
      const row = {
        id: String(id),
        token_hash,
        name,
        x: 0,
        z: 0,
        yaw: 0,
        created_at: String(created_at),
        last_seen: String(last_seen),
        rpg,
      };
      state.players.set(id, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    // findByToken / claimGuest guest lookup
    if (sql.includes('FROM players p WHERE p.token_hash = $1 AND NOT EXISTS')) {
      const [tokenHash] = params;
      const linkedIds = new Set([...state.accountCharacters.values()].map((a) => Number(a.player_id)));
      for (const p of state.players.values()) {
        if (p.token_hash === tokenHash && !linkedIds.has(Number(p.id))) {
          return { rows: [structuredClone(p)], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // findByAccount
    if (sql.includes('FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1')) {
      const link = state.accountCharacters.get(String(params[0]));
      if (!link) return { rows: [], rowCount: 0 };
      const p = state.players.get(Number(link.player_id));
      if (!p) return { rows: [], rowCount: 0 };
      return { rows: [{ ...structuredClone(p), username: link.username }], rowCount: 1 };
    }

    // Check existing account_characters
    if (sql === 'SELECT player_id FROM account_characters WHERE account_id = $1') {
      const link = state.accountCharacters.get(String(params[0]));
      return { rows: link ? [{ player_id: String(link.player_id) }] : [], rowCount: link ? 1 : 0 };
    }

    // Insert / upsert account_characters
    if (sql.startsWith('INSERT INTO account_characters (account_id, player_id, username, linked_at)')) {
      const [account_id, player_id, username, linked_at] = params;
      const isUpsert = sql.includes('ON CONFLICT');
      if (!isUpsert && state.accountCharacters.has(String(account_id))) {
        throw uniqueError('account_characters_pkey');
      }
      for (const [k, v] of state.accountCharacters) {
        if (Number(v.player_id) === Number(player_id) && k !== String(account_id)) {
          throw uniqueError('account_characters_player_id_key');
        }
      }
      state.accountCharacters.set(String(account_id), {
        account_id: String(account_id),
        player_id: String(player_id),
        username,
        linked_at: String(linked_at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql === 'UPDATE account_characters SET username = $1 WHERE account_id = $2') {
      const link = state.accountCharacters.get(String(params[1]));
      if (link) link.username = params[0];
      return { rows: [], rowCount: link ? 1 : 0 };
    }

    if (sql === 'UPDATE players SET token_hash = $1, name = $2 WHERE id = $3') {
      const p = state.players.get(Number(params[2]));
      if (p) {
        p.token_hash = params[0];
        p.name = params[1];
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE players SET name = $1, x = $2, z = $3, yaw = $4, rpg = $5::jsonb, last_seen = $6 WHERE id = $7')) {
      const [name, x, z, yaw, rpgText, last_seen, id] = params;
      const p = state.players.get(Number(id));
      if (p) {
        p.name = name;
        p.x = Number(x);
        p.z = Number(z);
        p.yaw = Number(yaw);
        p.rpg = JSON.parse(rpgText);
        p.last_seen = String(last_seen);
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    // ---- world_state ----

    if (sql.startsWith('INSERT INTO world_state (key, value, updated_at)')) {
      const [key, valueText, updated_at] = params;
      state.worldState.set(key, {
        key,
        value: JSON.parse(valueText),
        updated_at: String(updated_at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql === 'DELETE FROM world_state WHERE key = $1') {
      const existed = state.worldState.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql.startsWith('SELECT key, value FROM world_state WHERE starts_with(key, $1) ORDER BY key')) {
      const prefix = params[0];
      const rows = [...state.worldState.values()]
        .filter((r) => r.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((r) => ({ key: r.key, value: structuredClone(r.value) }));
      return { rows, rowCount: rows.length };
    }

    // ---- accounts ----

    if (sql.startsWith('INSERT INTO accounts ( id, username, username_key, password_hash')) {
      const [id, username, username_key, password_hash, created_at, last_login_at, muted_until, mute_reason, banned_at, ban_reason] = params;
      state.accounts.set(Number(id), {
        id: String(id),
        username,
        username_key,
        password_hash,
        created_at: String(created_at),
        last_login_at: last_login_at == null ? null : String(last_login_at),
        muted_until: muted_until == null ? null : String(muted_until),
        mute_reason,
        banned_at: banned_at == null ? null : String(banned_at),
        ban_reason,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO accounts (username, username_key, password_hash, created_at)')) {
      const [username, username_key, password_hash, created_at] = params;
      for (const a of state.accounts.values()) {
        if (a.username_key === username_key) throw uniqueError('accounts_username_key_key');
      }
      const id = ++state.seqs.accounts;
      const row = {
        id: String(id),
        username,
        username_key,
        password_hash,
        created_at: String(created_at),
        last_login_at: null,
        muted_until: null,
        mute_reason: null,
        banned_at: null,
        ban_reason: null,
      };
      state.accounts.set(id, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    if (sql === 'SELECT * FROM accounts WHERE username_key = $1') {
      for (const a of state.accounts.values()) {
        if (a.username_key === params[0]) return { rows: [structuredClone(a)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'SELECT * FROM accounts WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      return { rows: a ? [structuredClone(a)] : [], rowCount: a ? 1 : 0 };
    }

    if (sql.startsWith('SELECT a.*, (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > $1) AS sessions')) {
      const now = Number(params[0]);
      const rows = [...state.accounts.values()]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((a) => {
          let count = 0;
          for (const s of state.sessions.values()) {
            if (Number(s.account_id) === Number(a.id) && Number(s.expires_at) > now) count += 1;
          }
          return { ...structuredClone(a), sessions: String(count) };
        });
      return { rows, rowCount: rows.length };
    }

    if (sql === 'UPDATE accounts SET last_login_at = $1 WHERE id = $2') {
      const a = state.accounts.get(Number(params[1]));
      if (a) a.last_login_at = String(params[0]);
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'SELECT muted_until FROM accounts WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      return { rows: a ? [{ muted_until: a.muted_until }] : [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET muted_until = $1, mute_reason = $2 WHERE id = $3') {
      const a = state.accounts.get(Number(params[2]));
      if (a) {
        a.muted_until = params[0] == null ? null : String(params[0]);
        a.mute_reason = params[1];
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET muted_until = NULL, mute_reason = NULL WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      if (a) {
        a.muted_until = null;
        a.mute_reason = null;
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET banned_at = $1, ban_reason = $2 WHERE id = $3') {
      const a = state.accounts.get(Number(params[2]));
      if (a) {
        a.banned_at = String(params[0]);
        a.ban_reason = params[1];
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET banned_at = NULL, ban_reason = NULL WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      if (a) {
        a.banned_at = null;
        a.ban_reason = null;
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    // ---- sessions ----

    if (sql.startsWith('INSERT INTO sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at)')) {
      const [id, token_hash, account_id, created_at, last_seen_at, expires_at] = params;
      state.sessions.set(Number(id), {
        id: String(id),
        token_hash,
        account_id: String(account_id),
        created_at: String(created_at),
        last_seen_at: String(last_seen_at),
        expires_at: String(expires_at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at)')) {
      const [token_hash, account_id, created_at, last_seen_at, expires_at] = params;
      for (const s of state.sessions.values()) {
        if (s.token_hash === token_hash) throw uniqueError('sessions_token_hash_key');
      }
      const id = ++state.seqs.sessions;
      const row = {
        id: String(id),
        token_hash,
        account_id: String(account_id),
        created_at: String(created_at),
        last_seen_at: String(last_seen_at),
        expires_at: String(expires_at),
      };
      state.sessions.set(id, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE account_id = $1 AND id NOT IN')) {
      const [accountId, limit] = params;
      const owned = [...state.sessions.values()]
        .filter((s) => Number(s.account_id) === Number(accountId))
        .sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at) || Number(b.id) - Number(a.id));
      const keep = new Set(owned.slice(0, Number(limit)).map((s) => Number(s.id)));
      let deleted = 0;
      for (const s of owned) {
        if (!keep.has(Number(s.id))) {
          state.sessions.delete(Number(s.id));
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql.includes('FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1')) {
      for (const s of state.sessions.values()) {
        if (s.token_hash === params[0]) {
          const a = state.accounts.get(Number(s.account_id));
          if (!a) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                sid: s.id,
                last_seen_at: s.last_seen_at,
                expires_at: s.expires_at,
                id: a.id,
                username: a.username,
                banned_at: a.banned_at,
              },
            ],
            rowCount: 1,
          };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'UPDATE sessions SET last_seen_at = $1, expires_at = $2 WHERE id = $3') {
      const s = state.sessions.get(Number(params[2]));
      if (s) {
        s.last_seen_at = String(params[0]);
        s.expires_at = String(params[1]);
      }
      return { rows: [], rowCount: s ? 1 : 0 };
    }

    if (sql === 'DELETE FROM sessions WHERE token_hash = $1') {
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (s.token_hash === params[0]) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql === 'DELETE FROM sessions WHERE id = $1') {
      const existed = state.sessions.delete(Number(params[0]));
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql === 'DELETE FROM sessions WHERE account_id = $1') {
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (Number(s.account_id) === Number(params[0])) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql === 'DELETE FROM sessions WHERE expires_at <= $1') {
      const ts = Number(params[0]);
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (Number(s.expires_at) <= ts) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    // ---- moderation_log ----

    if (sql.startsWith('INSERT INTO moderation_log (id, account_id, action, reason, until, actor, at)')) {
      const [id, account_id, action, reason, until, actor, at] = params;
      state.moderationLog.set(Number(id), {
        id: String(id),
        account_id: String(account_id),
        action,
        reason,
        until: until == null ? null : String(until),
        actor,
        at: String(at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO moderation_log (account_id, action, reason, until, actor, at)')) {
      const id = ++state.seqs.moderation_log;
      let row;
      if (sql.includes("'mute'")) {
        const [account_id, reason, until, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'mute', reason, until: until == null ? null : String(until), actor, at: String(at) };
      } else if (sql.includes("'unmute'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'unmute', reason: null, until: null, actor, at: String(at) };
      } else if (sql.includes("'ban'")) {
        const [account_id, reason, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'ban', reason, until: null, actor, at: String(at) };
      } else if (sql.includes("'unban'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'unban', reason: null, until: null, actor, at: String(at) };
      } else if (sql.includes("'revoke'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'revoke', reason: null, until: null, actor, at: String(at) };
      } else {
        throw new Error(`Unhandled moderation_log SQL: ${sql}`);
      }
      state.moderationLog.set(id, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql === 'SELECT id, account_id, action, reason, until, actor, at FROM moderation_log WHERE id > $1 ORDER BY id') {
      const lastId = Number(params[0]);
      const rows = [...state.moderationLog.values()]
        .filter((m) => Number(m.id) > lastId)
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((m) => structuredClone(m));
      return { rows, rowCount: rows.length };
    }

    if (sql === 'SELECT id, account_id, action, reason, until, actor, at FROM moderation_log WHERE account_id = $1 ORDER BY id DESC LIMIT $2') {
      const [accountId, limit] = params;
      const rows = [...state.moderationLog.values()]
        .filter((m) => Number(m.account_id) === Number(accountId))
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, Number(limit))
        .map((m) => structuredClone(m));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`MockPgPool: unhandled SQL: ${sql}`);
  }

  return {
    get state() {
      return state;
    },
    get queryLog() {
      return queryLog;
    },
    get ended() {
      return ended;
    },
    get listenerCount() {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
    failNext(err) {
      failNextQuery = err;
    },
    setQueryHook(fn) {
      queryHook = fn;
    },
    async query(sql, params = []) {
      return executeSql(sql, params, null);
    },
    async connect() {
      const client = new EventEmitter();
      const ctx = { client, txSnapshot: null, pendingNotifications: [] };
      client.query = (sql, params = []) => executeSql(sql, params, ctx);
      client.release = () => {
        for (const set of listeners.values()) set.delete(client);
      };
      return client;
    },
    async end() {
      ended = true;
    },
  };
}

describe('PostgreSQL schema & storage factory', () => {
  it('schema.sql defines all required tables, JSONB columns, indexes, and schema_migrations', () => {
    const sql = loadSchemaSql();
    for (const token of [
      'CREATE TABLE IF NOT EXISTS schema_migrations',
      'CREATE TABLE IF NOT EXISTS players',
      'rpg JSONB NOT NULL',
      'USING GIN (rpg jsonb_path_ops)',
      'CREATE TABLE IF NOT EXISTS account_characters',
      'CREATE TABLE IF NOT EXISTS world_state',
      'value JSONB NOT NULL',
      'text_pattern_ops',
      'CREATE TABLE IF NOT EXISTS accounts',
      'CREATE TABLE IF NOT EXISTS sessions',
      'CREATE TABLE IF NOT EXISTS moderation_log',
    ]) {
      assert.ok(sql.includes(token), `expected schema.sql to include ${token}`);
    }
  });

  it('detectBackend and isPostgresUrl select SQLite by default and PostgreSQL for postgres(ql):// URLs', () => {
    assert.equal(isPostgresUrl('postgres://user:pass@localhost:5432/dfw'), true);
    assert.equal(isPostgresUrl('postgresql://localhost/dfw'), true);
    assert.equal(isPostgresUrl('POSTGRES://localhost/dfw'), true);
    assert.equal(isPostgresUrl(''), false);
    assert.equal(isPostgresUrl(undefined), false);
    assert.equal(isPostgresUrl('sqlite:///tmp/test.db'), false);

    assert.equal(detectBackend({ env: {} }), 'sqlite');
    assert.equal(detectBackend({ env: { DATABASE_URL: 'postgresql://localhost/dfw' } }), 'postgres');
    assert.equal(detectBackend({ pool: {} }), 'postgres');
  });

  it('openGameStorage and openAccountStorage default to SQLite and switch to PostgreSQL with injected pool', async () => {
    const sqliteGame = await openGameStorage({ dbPath: ':memory:', env: {} });
    assert.equal(sqliteGame.backend, 'sqlite');
    const created = sqliteGame.create('WayrestHero');
    assert.equal(sqliteGame.findByToken(created.token).name, 'WayrestHero');
    sqliteGame.close();

    const sqliteAcc = await openAccountStorage({ dbPath: ':memory:', env: {} });
    assert.equal(sqliteAcc.backend, 'sqlite');
    sqliteAcc.close();

    const pool = createMockPgPool();
    const pgGame = await openGameStorage({ pool, env: {} });
    assert.equal(pgGame.backend, 'postgres');
    assert.equal(pgGame.buffered, true);
    await pgGame.close();

    const pgAcc = await openAccountStorage({ pool, env: {} });
    assert.equal(pgAcc.backend, 'postgres');
    await pgAcc.close();
  });

  it('throws a clear error when DATABASE_URL is set and pg is absent or unreachable', async () => {
    let hasPg = true;
    try { await import('pg'); } catch { hasPg = false; }
    await assert.rejects(
      () => openGameStorage({ databaseUrl: 'postgresql://127.0.0.1:1/dfw', env: {} }),
      (err) => {
        if (!hasPg) {
          assert.equal(err.code, 'PG_DRIVER_MISSING');
          assert.match(err.message, /npm install pg/);
        } else {
          assert.ok(err instanceof Error);
        }
        return true;
      },
    );
  });
});

describe('postgres-game store contract', () => {
  it('supports guest create/findByToken, account createForAccount/findByAccount, claimGuest, and setAccountUsername', async () => {
    const pool = createMockPgPool();
    let clock = 1_700_000_000_000;
    const store = await openPostgresGameStore({ pool, now: () => ++clock });

    assert.equal(pool.state.schemaApplied, 1);
    assert.equal(pool.state.migrations.get(2)?.name, 'initial_postgres_schema');

    // Guest character lifecycle
    const guest = await store.create('Nerevar', { level: 3, gold: 45 });
    assert.equal(guest.row.id, 1);
    assert.equal(guest.row.name, 'Nerevar');
    assert.deepEqual(guest.row.rpg, { level: 3, gold: 45 });

    const foundGuest = await store.findByToken(guest.token);
    assert.deepEqual(foundGuest, guest.row);
    assert.equal(await store.findByToken('wrong-token'), null);

    // Account character creation
    const accChar = await store.createForAccount(10, 'Barenziah');
    assert.equal(accChar.id, 2);
    assert.equal(accChar.name, 'Barenziah');
    assert.equal((await store.findByAccount(10)).username, 'Barenziah');

    // Duplicate createForAccount rolls back cleanly and leaves no orphan player row
    const playersBefore = pool.state.players.size;
    await assert.rejects(() => store.createForAccount(10, 'Barenziah'), /duplicate key/);
    assert.equal(pool.state.players.size, playersBefore);

    // Claiming guest into an account that already has a character returns null
    assert.equal(await store.claimGuest(10, 'Barenziah', guest.token), null);

    // Claiming guest into a fresh account succeeds and revokes guest token
    const claimed = await store.claimGuest(20, 'Cyrus', guest.token, 'Cyrus');
    assert.equal(claimed.id, guest.row.id);
    assert.equal(claimed.name, 'Cyrus');
    assert.deepEqual(claimed.rpg, { level: 3, gold: 45 });
    assert.equal(await store.findByToken(guest.token), null);
    assert.equal((await store.findByAccount(20)).id, guest.row.id);

    // Updating account username
    await store.setAccountUsername(20, 'CyrusTheRedguard');
    assert.equal((await store.findByAccount(20)).username, 'CyrusTheRedguard');

    await store.close();
  });

  it('saves players and world_state atomically and rolls back on mid-transaction failure', async () => {
    const pool = createMockPgPool();
    const store = await openPostgresGameStore({ pool });
    const g = await store.create('Gothryd', { hp: 20 });

    await store.saveCharacters(
      [{ ...g.row, x: 12.5, z: -4.25, yaw: 1.5, rpg: { hp: 35, gold: 100 } }],
      [
        ['shop:daggerfall:alchemist', { stock: ['potion_hp'] }],
        ['shop:wayrest:armorer', { stock: ['iron_helm'] }],
        ['guild:mages', { rank: 2 }],
      ],
    );

    const reloaded = await store.findByToken(g.token);
    assert.equal(reloaded.x, 12.5);
    assert.equal(reloaded.z, -4.25);
    assert.deepEqual(reloaded.rpg, { hp: 35, gold: 100 });

    const shops = await store.loadWorld('shop:');
    assert.deepEqual(shops, [
      ['shop:daggerfall:alchemist', { stock: ['potion_hp'] }],
      ['shop:wayrest:armorer', { stock: ['iron_helm'] }],
    ]);

    // Delete a world key and update another
    await store.saveCharacters([], [
      ['shop:wayrest:armorer', null],
      ['shop:daggerfall:alchemist', { stock: ['potion_hp', 'potion_mp'] }],
    ]);
    assert.deepEqual(await store.loadWorld('shop:'), [
      ['shop:daggerfall:alchemist', { stock: ['potion_hp', 'potion_mp'] }],
    ]);

    // Mid-transaction failure rolls back BOTH player and world_state updates
    let seenUpdate = false;
    pool.setQueryHook((sql) => {
      if (sql.startsWith('INSERT INTO world_state')) {
        seenUpdate = true;
        throw new Error('simulated disk full');
      }
    });
    await assert.rejects(
      () =>
        store.saveCharacters(
          [{ ...g.row, x: 999, z: 999, yaw: 0, rpg: { hp: 1 } }],
          [['shop:daggerfall:alchemist', { stock: [] }]],
        ),
      /simulated disk full/,
    );
    pool.setQueryHook(null);
    assert.equal(seenUpdate, true);
    assert.equal((await store.findByToken(g.token)).x, 12.5);
    assert.deepEqual(await store.loadWorld('shop:'), [
      ['shop:daggerfall:alchemist', { stock: ['potion_hp', 'potion_mp'] }],
    ]);

    // Oversize RPG payload rejected before touching DB
    await assert.rejects(
      () => store.saveCharacters([{ ...g.row, rpg: { blob: 'x'.repeat(MAX_RPG_BYTES + 10) } }]),
      /too large to save/,
    );

    // Corrupt RPG row surfaces CorruptCharacterError
    pool.state.players.get(g.row.id).rpg = '[not-an-object]';
    await assert.rejects(() => store.findByToken(g.token), CorruptCharacterError);

    await store.close();
  });
});

describe('createBufferedGameStore write-behind coordinator', () => {
  it('serializes commits, coalesces rapid updates, flushes cleanly, and recovers after transient errors', async () => {
    const pool = createMockPgPool();
    const pgStore = await openPostgresGameStore({ pool });
    const g = await pgStore.create('BufferedHero', { gold: 0 });

    const errors = [];
    const buffered = createBufferedGameStore(pgStore, {
      onError: (err, batch) => errors.push({ message: err.message, players: batch.players.length }),
    });

    // Track concurrent transactions to prove strict serialization
    let activeTx = 0;
    let maxConcurrentTx = 0;
    pool.setQueryHook(async (sql) => {
      if (sql === 'BEGIN') {
        activeTx += 1;
        maxConcurrentTx = Math.max(maxConcurrentTx, activeTx);
      } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        activeTx -= 1;
      } else if (sql.startsWith('UPDATE players')) {
        await new Promise((r) => setTimeout(r, 15));
      }
    });

    // Fire 3 synchronous saveCharacters calls rapidly (mutating the caller object in-between)
    const livePlayer = { ...g.row, x: 1, z: 0, yaw: 0, rpg: { gold: 10 } };
    buffered.saveCharacters([livePlayer], [['k:1', { v: 1 }]]);
    livePlayer.x = 2;
    livePlayer.rpg.gold = 20;
    buffered.saveCharacters([livePlayer], [['k:1', { v: 2 }], ['k:2', { v: 1 }]]);
    livePlayer.x = 3;
    livePlayer.rpg.gold = 30;
    buffered.saveCharacters([livePlayer]);

    assert.equal(buffered.inFlight, true);
    await buffered.flush();

    assert.equal(maxConcurrentTx, 1);
    assert.equal(buffered.pendingCount, 0);
    assert.equal(buffered.stats().committedBatches >= 1, true);

    const saved = await buffered.findByToken(g.token);
    assert.equal(saved.x, 3);
    assert.deepEqual(saved.rpg, { gold: 30 });
    assert.deepEqual(await buffered.loadWorld('k:'), [
      ['k:1', { v: 2 }],
      ['k:2', { v: 1 }],
    ]);

    // Simulate a transient DB outage: flush rejects, onError fires, entries remain queued for retry
    pool.setQueryHook(null);
    pool.failNext(new Error('connection reset'));
    buffered.saveCharacters([{ ...livePlayer, x: 42, rpg: { gold: 99 } }], [['k:3', { ok: true }]]);
    await assert.rejects(() => buffered.flush(), /connection reset/);
    assert.equal(errors.length, 1);
    assert.equal(buffered.lastError.message, 'connection reset');
    assert.equal(buffered.pendingCount, 2); // 1 player + 1 world key re-queued

    // Next flush succeeds and commits the re-queued state
    await buffered.flush();
    assert.equal(buffered.lastError, null);
    assert.equal(buffered.pendingCount, 0);
    assert.equal((await buffered.findByToken(g.token)).x, 42);
    assert.deepEqual(await buffered.loadWorld('k:3'), [['k:3', { ok: true }]]);

    // close() flushes remaining pending writes before closing
    buffered.saveCharacters([{ ...livePlayer, x: 77, rpg: { gold: 123 } }]);
    await buffered.close();
    assert.equal((await pgStore.findByToken(g.token)).x, 77);
  });
});

describe('postgres-accounts store & LISTEN/NOTIFY moderation', () => {
  it('manages accounts, sessions, trimming, expiry, and delivers LISTEN/NOTIFY moderation events', async () => {
    const pool = createMockPgPool();
    let clock = 1_700_000_000_000;
    const store = await openPostgresAccountStore({ pool, now: () => clock });

    const pwHash = await hashPassword('hunter2-secret-pass', { N: 1024, r: 8, p: 1, keyLen: 32 });
    const acc = await store.createAccount('Morgiah', pwHash);
    assert.equal(acc.id, 1);
    assert.equal(acc.username, 'Morgiah');
    assert.equal((await store.find('morgiah')).id, 1);

    // Duplicate username_key throws PG unique violation 23505
    await assert.rejects(() => store.createAccount('MORGIAH', pwHash), (err) => err.code === '23505');

    // Sessions + maxSessions trimming
    await store.createSession(acc.id, 'tok-1', { ts: clock, ttlMs: 10_000, maxSessions: 2 });
    clock += 100;
    await store.createSession(acc.id, 'tok-2', { ts: clock, ttlMs: 10_000, maxSessions: 2 });
    clock += 100;
    await store.createSession(acc.id, 'tok-3', { ts: clock, ttlMs: 10_000, maxSessions: 2 });

    assert.equal(await store.getSession('tok-1'), null); // trimmed
    const s2 = await store.getSession('tok-2');
    assert.equal(s2.username, 'Morgiah');
    assert.equal((await store.list(clock))[0].sessions, 2);

    // Subscribe to LISTEN dfw_moderation
    const received = [];
    const unsubscribe = await store.listenModeration((ev) => received.push(ev));
    assert.equal(pool.listenerCount, 1);

    // Mute -> NOTIFY
    const muted = await store.mute('Morgiah', { minutes: 15, reason: 'spam', actor: 'cli:op' });
    assert.equal(muted.id, acc.id);
    assert.equal(await store.isMuted(acc.id, clock), true);
    assert.equal(await store.isMuted(acc.id, clock + 20 * 60_000), false);

    // Revoke sessions -> deletes sessions + NOTIFY
    const rev = await store.revokeSessions('Morgiah', { actor: 'cli:op' });
    assert.equal(rev.revoked, 2);
    assert.equal(await store.getSession('tok-2'), null);

    // Ban -> sets banned_at + NOTIFY
    await store.createSession(acc.id, 'tok-4', { ts: clock, ttlMs: 10_000, maxSessions: 5 });
    await store.ban('Morgiah', { reason: 'cheating', actor: 'cli:op' });
    assert.equal(await store.getSession('tok-4'), null);
    assert.equal((await store.get(acc.id)).ban_reason, 'cheating');

    // Unban + Unmute
    await store.unban('Morgiah', { actor: 'cli:op' });
    await store.unmute('Morgiah', { actor: 'cli:op' });
    assert.equal((await store.get(acc.id)).banned_at, null);
    assert.equal(await store.isMuted(acc.id, clock), false);

    // Verify all 5 moderation events arrived via LISTEN/NOTIFY on dfw_moderation
    assert.deepEqual(
      received.map((e) => e.action),
      ['mute', 'revoke', 'ban', 'unban', 'unmute'],
    );
    assert.ok(received.every((e) => e.accountId === acc.id));
    assert.equal(store.channel, MODERATION_CHANNEL);

    // Moderation log queries
    const log = await store.recentModerationLog(acc.id, 10);
    assert.equal(log.length, 5);
    assert.equal((await store.moderationLogSince(2)).length, 3);

    await unsubscribe();
    assert.equal(pool.listenerCount, 0);
    await store.close();
  });
});

describe('tools/migrate-to-postgres.mjs SQLite -> PostgreSQL migration', () => {
  it('validates synthetic SQLite DBs in --dry-run (API + CLI) and migrates idempotently into PostgreSQL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-pg-migrate-'));
    const gameDbPath = join(dir, 'daggerfallworld.db');
    const accountsDbPath = join(dir, 'accounts.db');

    try {
      // Populate synthetic SQLite game DB
      const gameSqlite = openStore(gameDbPath);
      const guest = gameSqlite.create('GuestTraveler', { gold: 55, location: 'daggerfall' });
      const accChar = gameSqlite.createForAccount(1, 'Helseth', 'Helseth');
      gameSqlite.saveCharacters(
        [{ ...accChar, x: 14, z: -8, yaw: 0.5, rpg: { gold: 250, level: 4 } }],
        [
          ['shop:daggerfall:inn', { rooms: 3 }],
          ['calendar:clock', { day: 12 }],
        ],
      );
      gameSqlite.close();

      // Populate synthetic SQLite accounts DB
      const accSqlite = openAccountStore(accountsDbPath);
      const now = 1_700_000_000_000;
      const pw = await hashPassword('a-strong-password-123', { N: 1024, r: 8, p: 1, keyLen: 32 });
      const { lastInsertRowid: accId } = accSqlite.q.insert.run('Helseth', 'helseth', pw, now);
      accSqlite.q.sessInsert.run('sess-hash-1', Number(accId), now, now, now + 86_400_000);
      accSqlite.q.log.run(Number(accId), 'mute', 'test', now + 60_000, 'cli:admin', now);
      accSqlite.close();

      // 1. Programmatic --dry-run (no pg Pool or DATABASE_URL needed)
      const dryLogs = [];
      const drySummary = await migrateSqliteToPostgres({
        gameDbPath,
        accountsDbPath,
        dryRun: true,
        log: (m) => dryLogs.push(m),
      });
      assert.equal(drySummary.dryRun, true);
      assert.deepEqual(drySummary.game, { skipped: false, players: 2, accountCharacters: 1, worldState: 2 });
      assert.deepEqual(drySummary.accounts, { skipped: false, accounts: 1, sessions: 1, moderationLog: 1 });

      // 2. CLI --dry-run invocation
      const scriptPath = fileURLToPath(new URL('../tools/migrate-to-postgres.mjs', import.meta.url));
      const cliOut = execFileSync(
        process.execPath,
        [scriptPath, '--game-db', gameDbPath, '--accounts-db', accountsDbPath, '--dry-run'],
        { encoding: 'utf8' },
      );
      assert.match(cliOut, /dry-run complete: game\(players=2, account_characters=1, world_state=2\)/);
      assert.match(cliOut, /accounts\(accounts=1, sessions=1, moderation_log=1\)/);

      // 3. Full idempotent migration into mock pg Pool (run twice, verify no duplicates & preserved IDs)
      const pool = createMockPgPool();
      const run1 = await migrateSqliteToPostgres({
        gameDbPath,
        accountsDbPath,
        gamePool: pool,
        accountsPool: pool,
        log: () => {},
      });
      const run2 = await migrateSqliteToPostgres({
        gameDbPath,
        accountsDbPath,
        gamePool: pool,
        accountsPool: pool,
        log: () => {},
      });
      assert.deepEqual(run1.game, run2.game);
      assert.equal(pool.state.players.size, 2);
      assert.equal(pool.state.accountCharacters.size, 1);
      assert.equal(pool.state.worldState.size, 2);
      assert.equal(pool.state.accounts.size, 1);
      assert.equal(pool.state.sessions.size, 1);
      assert.equal(pool.state.moderationLog.size, 1);

      // Verify migrated data is readable through PostgreSQL stores & sequences were advanced
      const pgGame = await openPostgresGameStore({ pool, applySchema: false });
      assert.equal((await pgGame.findByToken(guest.token)).name, 'GuestTraveler');
      const migratedAccChar = await pgGame.findByAccount(1);
      assert.equal(migratedAccChar.x, 14);
      assert.deepEqual(migratedAccChar.rpg, { gold: 250, level: 4 });
      assert.deepEqual(await pgGame.loadWorld('shop:'), [['shop:daggerfall:inn', { rooms: 3 }]]);

      // New insert after migration gets id=3 (sequence was synced via setval)
      const nextGuest = await pgGame.create('AfterMigration');
      assert.equal(nextGuest.row.id, 3);
      await pgGame.close();

      const pgAcc = await openPostgresAccountStore({ pool, applySchema: false });
      assert.equal((await pgAcc.find('helseth')).username, 'Helseth');
      assert.equal((await pgAcc.getSession('sess-hash-1')).username, 'Helseth');
      assert.equal((await pgAcc.recentModerationLog(1)).length, 1);
      await pgAcc.close();

      // parseArgs sanity check
      const parsed = parseArgs(
        ['--game-db', gameDbPath, '--database-url', 'postgres://localhost/dfw', '--dry-run'],
        {},
      );
      assert.equal(parsed.dryRun, true);
      assert.equal(parsed.accountsDatabaseUrl, 'postgres://localhost/dfw');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
