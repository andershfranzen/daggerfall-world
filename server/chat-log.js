#!/usr/bin/env node
// Persistent server-side in-game chat logging for moderation and player safety.
//
// Supports both SQLite (`node:sqlite`, sharing server/db.js's DatabaseSync or a dedicated file)
// and PostgreSQL (via a `pg` Pool or connection URL). Every valid in-game chat message across
// all channels is persisted; logs are never discarded.
//
// Operator CLI:
//   node server/chat-log.js tail [limit] [--db <path>] [--json]
//   node server/chat-log.js search [--user <name>] [--account <id>] [--player <id>]
//       [--channel <ch>] [--location <loc>] [--group <id>] [--contains <text>]
//       [--since <iso|ms>] [--until <iso|ms>] [--limit <n>] [--offset <n>]
//       [--asc] [--db <path>] [--json]
//   node server/chat-log.js count [--db <path>]
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAT_CHANNELS = Object.freeze([
  'say',
  'shout',
  'party',
  'region',
  'global',
  'whisper',
  'emote',
  'guild',
  'order',
  'location',
]);

const CHANNEL_SET = new Set(CHAT_CHANNELS);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
// Same file server/game.js DEFAULTS.dbPath writes; the CLI must read the live log by default.
export const CLI_DEFAULT_DB_PATH = fileURLToPath(new URL('./data/daggerfallworld.db', import.meta.url));
const DEFAULT_DB_PATH = CLI_DEFAULT_DB_PATH;

export const SQLITE_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    channel TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    sender_player_id INTEGER,
    sender_account_id TEXT,
    sender_name TEXT NOT NULL,
    target_player_id INTEGER,
    target_name TEXT,
    group_id TEXT,
    body TEXT NOT NULL,
    recipient_ids TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_account_created ON chat_messages (sender_account_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_name_created ON chat_messages (lower(sender_name), created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages (channel, created_at DESC)`,
]);

export const POSTGRES_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    created_at BIGINT NOT NULL,
    channel TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    sender_player_id BIGINT,
    sender_account_id TEXT,
    sender_name TEXT NOT NULL,
    target_player_id BIGINT,
    target_name TEXT,
    group_id TEXT,
    body TEXT NOT NULL,
    recipient_ids TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_account_created ON chat_messages (sender_account_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_name_created ON chat_messages (LOWER(sender_name), created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created ON chat_messages (channel, created_at DESC)`,
  // Tables created before recipient_ids existed.
  `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_ids TEXT`,
]);

function isSqliteDb(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.prepare === 'function' &&
      typeof value.exec === 'function'
  );
}

function isPgPool(value) {
  return Boolean(value && typeof value === 'object' && typeof value.query === 'function');
}

function optionalInt(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${fieldName} must be a safe integer`);
  }
  return n;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

export function parseTimestamp(value, fieldName = 'timestamp') {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) throw new Error(`${fieldName} must be a valid Date`);
    return Math.trunc(ms);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${fieldName} must be a non-negative finite number`);
    }
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n)) return n;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${fieldName} must be epoch milliseconds or an ISO-8601 date string`);
    }
    return Math.trunc(parsed);
  }
  throw new Error(`${fieldName} must be epoch milliseconds, a Date, or an ISO-8601 string`);
}

export function normalizeChatEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('chat log entry must be an object');
  }
  const rawChannel = entry.channel;
  if (typeof rawChannel !== 'string') {
    throw new Error('chat log entry requires a channel');
  }
  const channel = rawChannel.trim().toLowerCase();
  if (!CHANNEL_SET.has(channel)) {
    throw new Error(`unsupported chat channel: ${JSON.stringify(rawChannel)}`);
  }

  const rawSenderName = entry.senderName ?? entry.sender_name ?? entry.name;
  if (typeof rawSenderName !== 'string' || rawSenderName.trim().length === 0) {
    throw new Error('chat log entry requires a non-empty senderName');
  }
  const senderName = rawSenderName.trim();

  const rawBody = entry.body ?? entry.text ?? entry.message;
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) {
    throw new Error('chat log entry requires a non-empty body');
  }
  const body = rawBody.trim();

  const rawCreatedAt = entry.createdAt ?? entry.created_at ?? entry.timestamp;
  const createdAt = rawCreatedAt === undefined || rawCreatedAt === null
    ? Date.now()
    : parseTimestamp(rawCreatedAt, 'createdAt');

  const rawLocation = entry.location;
  const location = rawLocation === undefined || rawLocation === null ? '' : String(rawLocation).trim();

  const senderPlayerId = optionalInt(
    entry.senderPlayerId ?? entry.sender_player_id ?? entry.playerId ?? entry.fromId,
    'senderPlayerId'
  );
  const senderAccountId = optionalText(
    entry.senderAccountId ?? entry.sender_account_id ?? entry.accountId
  );
  const targetPlayerId = optionalInt(
    entry.targetPlayerId ?? entry.target_player_id ?? entry.toId,
    'targetPlayerId'
  );
  const targetName = optionalText(
    entry.targetName ?? entry.target_name ?? entry.toName
  );
  const groupId = optionalText(
    entry.groupId ?? entry.group_id ?? entry.partyId ?? entry.guildId ?? entry.orderId
  );

  // Who heard it (player ids, sender excluded): the audience of a say/shout depends on where everyone stood.
  const rawRecipients = entry.recipientIds ?? entry.recipient_ids ?? null;
  const recipientIds = Array.isArray(rawRecipients)
    ? rawRecipients.map((id) => optionalInt(id, 'recipientIds')).filter((id) => id !== null)
    : null;

  return {
    createdAt,
    channel,
    location,
    senderPlayerId,
    senderAccountId,
    senderName,
    targetPlayerId,
    targetName,
    groupId,
    body,
    recipientIds,
  };
}

function formatRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: Number(row.created_at),
    channel: row.channel,
    location: row.location ?? '',
    senderPlayerId: row.sender_player_id == null ? null : Number(row.sender_player_id),
    senderAccountId: row.sender_account_id ?? null,
    senderName: row.sender_name,
    targetPlayerId: row.target_player_id == null ? null : Number(row.target_player_id),
    targetName: row.target_name ?? null,
    groupId: row.group_id ?? null,
    body: row.body,
    recipientIds: row.recipient_ids ? JSON.parse(row.recipient_ids) : null,
  };
}

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, '\\$&');
}

function clampLimit(limit, fallback = DEFAULT_LIMIT) {
  if (limit === undefined || limit === null || limit === '') return fallback;
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

function clampOffset(offset) {
  if (offset === undefined || offset === null || offset === '') return 0;
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function normalizeChannelsFilter(channel) {
  if (channel === undefined || channel === null || channel === '') return null;
  const list = Array.isArray(channel) ? channel : [channel];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') throw new Error('channel filter must be a string');
    const c = item.trim().toLowerCase();
    if (!c) continue;
    if (!CHANNEL_SET.has(c)) throw new Error(`unsupported chat channel filter: ${JSON.stringify(item)}`);
    out.push(c);
  }
  return out.length ? out : null;
}

function buildWhere(filters = {}, dialect = 'sqlite') {
  const clauses = [];
  const params = [];
  const placeholder = () => (dialect === 'postgres' ? `$${params.length + 1}` : '?');
  const push = (value) => {
    const ph = placeholder();
    params.push(value);
    return ph;
  };

  if (filters.accountId !== undefined && filters.accountId !== null && String(filters.accountId).trim() !== '') {
    clauses.push(`sender_account_id = ${push(String(filters.accountId).trim())}`);
  }
  if (filters.senderName !== undefined && filters.senderName !== null && String(filters.senderName).trim() !== '') {
    const fn = dialect === 'postgres' ? 'LOWER' : 'lower';
    clauses.push(`${fn}(sender_name) = ${fn}(${push(String(filters.senderName).trim())})`);
  }
  if (filters.playerId !== undefined && filters.playerId !== null && filters.playerId !== '') {
    const pid = optionalInt(filters.playerId, 'playerId');
    clauses.push(`sender_player_id = ${push(pid)}`);
  }
  if (filters.targetPlayerId !== undefined && filters.targetPlayerId !== null && filters.targetPlayerId !== '') {
    const tid = optionalInt(filters.targetPlayerId, 'targetPlayerId');
    clauses.push(`target_player_id = ${push(tid)}`);
  }
  const channels = normalizeChannelsFilter(filters.channel);
  if (channels) {
    if (channels.length === 1) {
      clauses.push(`channel = ${push(channels[0])}`);
    } else {
      const phs = channels.map((c) => push(c)).join(', ');
      clauses.push(`channel IN (${phs})`);
    }
  }
  if (filters.location !== undefined && filters.location !== null && String(filters.location).trim() !== '') {
    clauses.push(`location = ${push(String(filters.location).trim())}`);
  }
  if (filters.groupId !== undefined && filters.groupId !== null && String(filters.groupId).trim() !== '') {
    clauses.push(`group_id = ${push(String(filters.groupId).trim())}`);
  }
  if (filters.contains !== undefined && filters.contains !== null && String(filters.contains).length > 0) {
    const pattern = `%${escapeLike(String(filters.contains).toLowerCase())}%`;
    const fn = dialect === 'postgres' ? 'LOWER' : 'lower';
    clauses.push(`${fn}(body) LIKE ${push(pattern)} ESCAPE '\\'`);
  }
  const since = parseTimestamp(filters.since, 'since');
  if (since !== null) {
    clauses.push(`created_at >= ${push(since)}`);
  }
  const until = parseTimestamp(filters.until, 'until');
  if (until !== null) {
    clauses.push(`created_at <= ${push(until)}`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * Open a SQLite-backed chat log store.
 * Accepts either an existing `node:sqlite` `DatabaseSync` instance (shared with server/db.js)
 * or a filesystem path / `':memory:'`.
 */
export function openSqliteChatLog(dbOrPath, options = {}) {
  const logger = options.logger ?? console;
  const defaultSafe = Boolean(options.safe);
  let db;
  let ownsDb = false;

  if (isSqliteDb(dbOrPath)) {
    db = dbOrPath;
  } else if (typeof dbOrPath === 'string' && dbOrPath.trim().length > 0) {
    const dbPath = dbOrPath.trim();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    db = new DatabaseSync(dbPath);
    ownsDb = true;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  } else {
    throw new Error('openSqliteChatLog requires a node:sqlite DatabaseSync instance or a database path');
  }

  for (const ddl of SQLITE_DDL) {
    db.exec(ddl);
  }
  // Tables created before recipient_ids existed (SQLite has no ADD COLUMN IF NOT EXISTS).
  if (!db.prepare('PRAGMA table_info(chat_messages)').all().some((c) => c.name === 'recipient_ids')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN recipient_ids TEXT');
  }

  const insertStmt = db.prepare(`
    INSERT INTO chat_messages (
      created_at, channel, location,
      sender_player_id, sender_account_id, sender_name,
      target_player_id, target_name, group_id, body, recipient_ids
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countAllStmt = db.prepare('SELECT COUNT(*) AS total FROM chat_messages');

  function record(entry, opts = {}) {
    const data = normalizeChatEntry(entry);
    const safe = opts.safe ?? defaultSafe;
    try {
      const info = insertStmt.run(
        data.createdAt,
        data.channel,
        data.location,
        data.senderPlayerId,
        data.senderAccountId,
        data.senderName,
        data.targetPlayerId,
        data.targetName,
        data.groupId,
        data.body,
        data.recipientIds ? JSON.stringify(data.recipientIds) : null
      );
      return { id: Number(info.lastInsertRowid), ...data };
    } catch (err) {
      if (safe) {
        logger?.error?.('[chat-log] failed to persist SQLite chat message:', err?.message ?? err);
        return null;
      }
      throw err;
    }
  }

  function query(filters = {}) {
    const limit = clampLimit(filters.limit, DEFAULT_LIMIT);
    const offset = clampOffset(filters.offset);
    const dir = filters.order === 'asc' ? 'ASC' : 'DESC';
    const { whereSql, params } = buildWhere(filters, 'sqlite');

    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM chat_messages ${whereSql}`).get(...params);
    const total = Number(totalRow?.total ?? 0);

    const rows = db
      .prepare(
        `SELECT id, created_at, channel, location,
                sender_player_id, sender_account_id, sender_name,
                target_player_id, target_name, group_id, body, recipient_ids
           FROM chat_messages
           ${whereSql}
          ORDER BY created_at ${dir}, id ${dir}
          LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map(formatRow);

    return { total, rows, limit, offset };
  }

  function recent(limit = 50) {
    return query({ limit: clampLimit(limit, 50), offset: 0, order: 'desc' }).rows;
  }

  function count() {
    return Number(countAllStmt.get()?.total ?? 0);
  }

  function close() {
    if (ownsDb) db.close();
  }

  return {
    engine: 'sqlite',
    db,
    record,
    query,
    recent,
    count,
    close,
  };
}

/**
 * Open a PostgreSQL-backed chat log store.
 * Accepts either a `pg` Pool/Client instance (anything with `.query(sql, params)`)
 * or a PostgreSQL connection string (dynamically imports `pg`).
 */
export async function openPostgresChatLog(poolOrUrl, options = {}) {
  const logger = options.logger ?? console;
  const defaultSafe = Boolean(options.safe);
  let pool;
  let ownsPool = false;

  if (isPgPool(poolOrUrl)) {
    pool = poolOrUrl;
  } else if (typeof poolOrUrl === 'string' && poolOrUrl.trim().length > 0) {
    let pgMod;
    try {
      pgMod = await import('pg');
    } catch (err) {
      throw new Error(`PostgreSQL support requires the "pg" package: ${err.message}`);
    }
    const Pool = pgMod.Pool ?? pgMod.default?.Pool;
    if (typeof Pool !== 'function') {
      throw new Error('Loaded "pg" module does not export Pool');
    }
    pool = new Pool({ connectionString: poolOrUrl.trim() });
    ownsPool = true;
  } else {
    throw new Error('openPostgresChatLog requires a pg Pool instance or a PostgreSQL connection string');
  }

  for (const ddl of POSTGRES_DDL) {
    await pool.query(ddl);
  }

  async function record(entry, opts = {}) {
    const data = normalizeChatEntry(entry);
    const safe = opts.safe ?? defaultSafe;
    const sql = `
      INSERT INTO chat_messages (
        created_at, channel, location,
        sender_player_id, sender_account_id, sender_name,
        target_player_id, target_name, group_id, body, recipient_ids
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, created_at, channel, location,
                sender_player_id, sender_account_id, sender_name,
                target_player_id, target_name, group_id, body, recipient_ids
    `;
    const params = [
      data.createdAt,
      data.channel,
      data.location,
      data.senderPlayerId,
      data.senderAccountId,
      data.senderName,
      data.targetPlayerId,
      data.targetName,
      data.groupId,
      data.body,
      data.recipientIds ? JSON.stringify(data.recipientIds) : null,
    ];
    try {
      const res = await pool.query(sql, params);
      const row = res?.rows?.[0];
      return row ? formatRow(row) : { id: null, ...data };
    } catch (err) {
      if (safe) {
        logger?.error?.('[chat-log] failed to persist PostgreSQL chat message:', err?.message ?? err);
        return null;
      }
      throw err;
    }
  }

  async function query(filters = {}) {
    const limit = clampLimit(filters.limit, DEFAULT_LIMIT);
    const offset = clampOffset(filters.offset);
    const dir = filters.order === 'asc' ? 'ASC' : 'DESC';
    const { whereSql, params } = buildWhere(filters, 'postgres');

    const countRes = await pool.query(
      `SELECT COUNT(*) AS total FROM chat_messages ${whereSql}`,
      params
    );
    const total = Number(countRes?.rows?.[0]?.total ?? 0);

    const limitPh = `$${params.length + 1}`;
    const offsetPh = `$${params.length + 2}`;
    const dataRes = await pool.query(
      `SELECT id, created_at, channel, location,
              sender_player_id, sender_account_id, sender_name,
              target_player_id, target_name, group_id, body, recipient_ids
         FROM chat_messages
         ${whereSql}
        ORDER BY created_at ${dir}, id ${dir}
        LIMIT ${limitPh} OFFSET ${offsetPh}`,
      [...params, limit, offset]
    );

    const rows = (dataRes?.rows ?? []).map(formatRow);
    return { total, rows, limit, offset };
  }

  async function recent(limit = 50) {
    const res = await query({ limit: clampLimit(limit, 50), offset: 0, order: 'desc' });
    return res.rows;
  }

  async function count() {
    const res = await pool.query('SELECT COUNT(*) AS total FROM chat_messages');
    return Number(res?.rows?.[0]?.total ?? 0);
  }

  async function close() {
    if (ownsPool && typeof pool.end === 'function') {
      await pool.end();
    }
  }

  return {
    engine: 'postgres',
    pool,
    record,
    query,
    recent,
    count,
    close,
  };
}

/**
 * Service wrapper ready to plug into `server/game.js` and `ctx.services.logChat`.
 *
 * Accepts either:
 *   logChat({ player, channel, text|body, location?, target?, targetPlayerId?, targetName?, groupId?, createdAt? })
 *   logChat(player, { channel, text|body, location?, target?, targetPlayerId?, targetName?, groupId?, createdAt? })
 */
export function createChatLogService(store, options = {}) {
  if (!store || typeof store.record !== 'function' || typeof store.query !== 'function') {
    throw new Error('createChatLogService requires a valid chat log store');
  }
  const logger = options.logger ?? console;
  const safe = options.safe ?? true;

  function toEntry(playerOrEntry, maybeEntry) {
    let player = null;
    let payload = null;
    if (maybeEntry && typeof maybeEntry === 'object') {
      player = playerOrEntry ?? null;
      payload = maybeEntry;
    } else if (playerOrEntry && typeof playerOrEntry === 'object') {
      payload = playerOrEntry;
      player = payload.player ?? null;
    } else {
      throw new Error('logChat requires an entry object');
    }

    const target = payload.target ?? null;
    return {
      createdAt: payload.createdAt ?? payload.created_at ?? payload.timestamp,
      channel: payload.channel,
      location: payload.location ?? player?.rpg?.location ?? '',
      senderPlayerId: payload.senderPlayerId ?? payload.sender_player_id ?? payload.playerId ?? player?.id ?? null,
      senderAccountId:
        payload.senderAccountId ??
        payload.sender_account_id ??
        payload.accountId ??
        player?.accountId ??
        player?.account?.id ??
        null,
      senderName: payload.senderName ?? payload.sender_name ?? payload.name ?? player?.name,
      targetPlayerId: payload.targetPlayerId ?? payload.target_player_id ?? payload.toId ?? target?.id ?? null,
      targetName: payload.targetName ?? payload.target_name ?? payload.toName ?? target?.name ?? null,
      groupId: payload.groupId ?? payload.group_id ?? payload.partyId ?? payload.guildId ?? payload.orderId ?? null,
      body: payload.body ?? payload.text ?? payload.message,
      recipientIds: payload.recipientIds ?? payload.recipient_ids ?? null,
    };
  }

  function logChat(playerOrEntry, maybeEntry) {
    let entry;
    try {
      entry = toEntry(playerOrEntry, maybeEntry);
    } catch (err) {
      if (safe) {
        logger?.error?.('[chat-log] invalid chat log payload:', err?.message ?? err);
        return null;
      }
      throw err;
    }

    try {
      const result = store.record(entry, { safe });
      if (result && typeof result.then === 'function' && safe) {
        return result.catch((err) => {
          logger?.error?.('[chat-log] async chat log write failed:', err?.message ?? err);
          return null;
        });
      }
      return result;
    } catch (err) {
      if (safe) {
        logger?.error?.('[chat-log] chat log write failed:', err?.message ?? err);
        return null;
      }
      throw err;
    }
  }

  function queryChat(filters = {}) {
    return store.query(filters);
  }

  function recentChat(limit = 50) {
    return store.recent(limit);
  }

  function countChat() {
    return store.count();
  }

  return {
    logChat,
    queryChat,
    recentChat,
    countChat,
    store,
  };
}

// ---------------------------------------------------------------------------
// Operator CLI
// ---------------------------------------------------------------------------

export function formatChatLine(row) {
  const ts = new Date(row.createdAt).toISOString();
  const chan = row.channel.toUpperCase();
  const acct = row.senderAccountId ? ` acct=${row.senderAccountId}` : '';
  const pid = row.senderPlayerId != null ? `#${row.senderPlayerId}` : '';
  const target = row.targetName ? ` -> ${row.targetName}` : '';
  const group = row.groupId ? ` [${row.groupId}]` : '';
  const loc = row.location ? ` @${row.location}` : '';
  return `[${ts}] [${chan}]${group}${loc} ${row.senderName}${pid}${acct}${target}: ${row.body}`;
}

function usageText() {
  return [
    'Usage:',
    '  node server/chat-log.js tail [limit] [--db <path>] [--json]',
    '  node server/chat-log.js search [--user <name>] [--account <id>] [--player <id>]',
    '      [--channel <ch>] [--location <loc>] [--group <id>] [--contains <text>]',
    '      [--since <iso|ms>] [--until <iso|ms>] [--limit <n>] [--offset <n>]',
    '      [--asc] [--db <path>] [--json]',
    '  node server/chat-log.js count [--db <path>]',
    '',
    'Environment:',
    '  CHAT_LOG_DB_PATH or DB_PATH (default: server/data/daggerfallworld.db)',
    '  DATABASE_URL=postgres://... reads the PostgreSQL chat log instead',
  ].join('\n');
}

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--asc') {
      flags.asc = true;
    } else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`option --${key} requires a value`);
        }
        flags[key] = next;
        i += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? null, args: positionals.slice(1), flags };
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n${usageText()}\n`);
    return 2;
  }

  if (parsed.flags.help || !parsed.command) {
    stdout.write(`${usageText()}\n`);
    return parsed.flags.help ? 0 : 2;
  }

  const dbPath = parsed.flags.db
    ? resolve(parsed.flags.db)
    : env.CHAT_LOG_DB_PATH
      ? resolve(env.CHAT_LOG_DB_PATH)
      : env.DB_PATH
        ? resolve(env.DB_PATH)
        : DEFAULT_DB_PATH;

  // A PostgreSQL deployment (server/main.js DATABASE_URL) keeps chat there, not in SQLite.
  const pgUrl = !parsed.flags.db && !env.CHAT_LOG_DB_PATH && /^postgres(ql)?:\/\//i.test(env.DATABASE_URL ?? '')
    ? env.DATABASE_URL.trim()
    : null;
  let store;
  try {
    store = pgUrl ? await openPostgresChatLog(pgUrl) : openSqliteChatLog(dbPath);
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  try {
    if (parsed.command === 'tail') {
      const limit = parsed.flags.limit ?? parsed.args[0] ?? 50;
      const rows = await store.recent(limit);
      if (parsed.flags.json) {
        stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const row of rows) stdout.write(`${formatChatLine(row)}\n`);
      }
      return 0;
    }

    if (parsed.command === 'search') {
      const res = await store.query({
        senderName: parsed.flags.user,
        accountId: parsed.flags.account,
        playerId: parsed.flags.player,
        channel: parsed.flags.channel,
        location: parsed.flags.location,
        groupId: parsed.flags.group,
        contains: parsed.flags.contains,
        since: parsed.flags.since,
        until: parsed.flags.until,
        limit: parsed.flags.limit ?? 100,
        offset: parsed.flags.offset ?? 0,
        order: parsed.flags.asc ? 'asc' : 'desc',
      });
      if (parsed.flags.json) {
        stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } else {
        stdout.write(`Found ${res.total} matching message(s) (showing ${res.rows.length}, offset ${res.offset}):\n`);
        for (const row of res.rows) stdout.write(`${formatChatLine(row)}\n`);
      }
      return 0;
    }

    if (parsed.command === 'count') {
      const total = await store.count();
      if (parsed.flags.json) {
        stdout.write(`${JSON.stringify({ total })}\n`);
      } else {
        stdout.write(`${total}\n`);
      }
      return 0;
    }

    stderr.write(`error: unknown command ${JSON.stringify(parsed.command)}\n${usageText()}\n`);
    return 2;
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return 1;
  } finally {
    await store.close();
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const code = await runCli();
  process.exit(code);
}
