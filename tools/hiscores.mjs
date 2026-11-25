#!/usr/bin/env node
// Operator CLI for Chronicles of the Iliac Bay (Daggerfall World Hiscores).
// Supports SQLite (--db / DB_PATH) and PostgreSQL (--database-url / DATABASE_URL),
// with dynamic loading of server/hiscores/* modules and a standalone SQLite fallback.
//
// Usage:
//   node tools/hiscores.mjs rebuild [--db <path> | --database-url <url>] [--accounts-db <path>] [--json]
//   node tools/hiscores.mjs top [--board overall] [--limit 25] [--class Mage] [--race Breton] [--json]
//   node tools/hiscores.mjs player <name> [--json]
//   node tools/hiscores.mjs orders [--sort members|level|treasury] [--limit 25] [--json]
//   node tools/hiscores.mjs stats [--json]
//   node tools/hiscores.mjs help

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_GAME_DB = fileURLToPath(new URL('../server/data/daggerfallworld.db', import.meta.url));
const DEFAULT_ACCOUNTS_DB = fileURLToPath(new URL('../server/data/accounts.db', import.meta.url));
const TOTAL_CLASSIC_PLACES = 15251;
const PGUILD_PREFIX = 'pguild:';

const VALID_ORDER_SORTS = new Set(['members', 'level', 'treasury']);

const CORE_BOARDS = Object.freeze({
  overall: { id: 'overall', label: 'Overall', unit: 'Total Skill' },
  level: { id: 'level', label: 'Level', unit: 'Level' },
  exploration: { id: 'exploration', label: 'Exploration', unit: 'Places' },
  quests: { id: 'quests', label: 'Quests', unit: 'Quests' },
  slayer: { id: 'slayer', label: 'Slayer', unit: 'Monsters Slain' },
  wanted: { id: 'wanted', label: 'Wanted', unit: 'Infamy' },
  admiralty: { id: 'admiralty', label: 'Admiralty', unit: 'Admiralty Score' },
});

const FALLBACK_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS hiscores (
  player_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT 'Adventurer',
  race TEXT NOT NULL DEFAULT 'Breton',
  level INTEGER NOT NULL DEFAULT 1,
  total_skill INTEGER NOT NULL DEFAULT 0,
  places_discovered INTEGER NOT NULL DEFAULT 0,
  trips INTEGER NOT NULL DEFAULT 0,
  quests_completed INTEGER NOT NULL DEFAULT 0,
  monsters_slain INTEGER NOT NULL DEFAULT 0,
  infamy INTEGER NOT NULL DEFAULT 0,
  worst_region TEXT,
  admiralty_score INTEGER NOT NULL DEFAULT 0,
  admiralty_rank_title TEXT NOT NULL DEFAULT 'Unsworn',
  ships_sunk INTEGER NOT NULL DEFAULT 0,
  order_id TEXT,
  order_tag TEXT,
  order_name TEXT,
  order_rank TEXT,
  skills TEXT NOT NULL DEFAULT '{}',
  skill_milestones TEXT NOT NULL DEFAULT '{}',
  guilds TEXT NOT NULL DEFAULT '{}',
  milestone_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hiscores_name_key ON hiscores (name_key);
CREATE INDEX IF NOT EXISTS idx_hiscores_overall ON hiscores (total_skill DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE TABLE IF NOT EXISTS hiscores_orders (
  order_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  leader_name TEXT NOT NULL DEFAULT '',
  member_count INTEGER NOT NULL DEFAULT 0,
  combined_level INTEGER NOT NULL DEFAULT 0,
  combined_total_skill INTEGER NOT NULL DEFAULT 0,
  treasury INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_name_key ON hiscores_orders (name_key);
`;

export const USAGE = [
  'Chronicles of the Iliac Bay — Daggerfall World Hiscores CLI',
  '',
  'Usage:',
  '  node tools/hiscores.mjs rebuild [options]',
  '  node tools/hiscores.mjs top [--board <id>] [--limit <n>] [--page <n>] [--class <name>] [--race <name>] [--query <text>] [--json]',
  '  node tools/hiscores.mjs player <name> [--json]',
  '  node tools/hiscores.mjs orders [--sort members|level|treasury] [--limit <n>] [--page <n>] [--query <text>] [--json]',
  '  node tools/hiscores.mjs stats [--json]',
  '  node tools/hiscores.mjs help',
  '',
  'Boards:',
  '  overall, level, exploration, quests, slayer, wanted, admiralty, guild:<group>, skill:<skill>',
  '',
  'Database Options:',
  '  --db <path>              SQLite game database (default: DB_PATH or server/data/daggerfallworld.db)',
  '  --accounts-db <path>     SQLite accounts database for banned-account exclusion (default: ACCOUNTS_DB_PATH or server/data/accounts.db)',
  '  --database-url <url>     PostgreSQL connection URL (default: DATABASE_URL)',
  '  --json                   Output machine-readable JSON',
  '  -h, --help               Show this help guide',
].join('\n');

// ---------------------------------------------------------------------------
// Formatting & Redaction Utilities
// ---------------------------------------------------------------------------

/**
 * Redacts embedded credentials (passwords, password query params, libpq password tokens)
 * from a database connection URL or connection string. Local file paths are returned unchanged.
 */
export function redactDbUrl(raw) {
  if (raw === null || raw === undefined) return '';
  const str = String(raw).trim();
  if (!str) return '';

  // Handle URL-style connection strings (postgres://, postgresql://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str)) {
    try {
      const parsed = new URL(str);
      let hadPassword = false;
      if (parsed.password) {
        parsed.password = 'REDACTED_PW_TOKEN';
        hadPassword = true;
      }
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (/^(password|pass|pwd)$/i.test(key)) {
          parsed.searchParams.set(key, 'REDACTED_PW_TOKEN');
        }
      }
      let out = parsed.toString().replace(/REDACTED_PW_TOKEN/g, '***');
      if (hadPassword && !out.includes(':***@')) {
        out = out.replace(/:\/\/([^:@/\s]*):[^@/\s]*@/, '://$1:***@');
      }
      return out;
    } catch {
      // Fallback for malformed URLs (e.g. unescaped special characters in password)
      return str
        .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/@\s]*):[^@\s]+@/g, '$1:***@')
        .replace(/([?&](?:password|pass|pwd)=)[^&\s]+/gi, '$1***');
    }
  }

  // Handle libpq key=value connection strings (e.g. "host=localhost user=dfw password=secret dbname=dfw")
  if (/\bpassword\s*=/i.test(str)) {
    return str.replace(/(\bpassword\s*=\s*)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1***');
  }

  return str;
}

function isNumericDisplay(val) {
  if (val === '' || val === '-') return true;
  return /^[#+-]?\d[\d,]*(?:\.\d+)?%?$/.test(val);
}

function formatNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Math.trunc(n).toLocaleString('en-US');
}

/**
 * Formats headers and rows into an aligned ASCII table.
 * Numeric columns are automatically right-aligned unless overridden via `opts.align`.
 */
export function formatTable(headers, rows, opts = {}) {
  const cols = Array.isArray(headers) ? headers.map((h) => String(h)) : [];
  if (cols.length === 0) return '';

  const strRows = (Array.isArray(rows) ? rows : []).map((row) =>
    cols.map((_, idx) => {
      const cell = row?.[idx];
      if (cell === null || cell === undefined || cell === '') return '-';
      return String(cell);
    }),
  );

  const widths = cols.map((h, idx) => {
    let max = h.length;
    for (const r of strRows) {
      if (r[idx].length > max) max = r[idx].length;
    }
    return max;
  });

  const align = cols.map((_, idx) => {
    const explicit = opts.align?.[idx];
    if (explicit === 'left' || explicit === 'right') return explicit;
    if (strRows.length === 0) return 'left';
    const hasData = strRows.some((r) => r[idx] !== '-');
    if (!hasData) return 'left';
    return strRows.every((r) => isNumericDisplay(r[idx])) ? 'right' : 'left';
  });

  const padCell = (text, idx) =>
    align[idx] === 'right' ? text.padStart(widths[idx], ' ') : text.padEnd(widths[idx], ' ');

  const headerLine = cols.map((h, idx) => padCell(h, idx)).join(' | ');
  const sepLine = widths.map((w) => '-'.repeat(w)).join('-+-');
  const bodyLines = strRows.map((r) => r.map((cell, idx) => padCell(cell, idx)).join(' | '));

  return [headerLine, sepLine, ...bodyLines].join('\n');
}

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------

function parsePositiveInt(raw, flagName) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flagName} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Parses CLI argv and environment variables into a normalized options object.
 */
export function parseArgs(argv = [], env = process.env) {
  const positionals = [];
  let explicitDb = null;
  let explicitAccountsDb = null;
  let explicitDatabaseUrl = null;

  const opts = {
    command: null,
    args: [],
    board: 'overall',
    limit: 25,
    page: 1,
    className: null,
    race: null,
    query: null,
    sort: 'members',
    json: false,
    help: false,
    requireCreated: false,
    requireLinked: false,
    dbPath: env.DB_PATH ? resolve(env.DB_PATH) : DEFAULT_GAME_DB,
    accountsDbPath: env.ACCOUNTS_DB_PATH ? resolve(env.ACCOUNTS_DB_PATH) : DEFAULT_ACCOUNTS_DB,
    databaseUrl: env.DATABASE_URL || null,
    backend: 'sqlite',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--require-created') {
      opts.requireCreated = true;
      continue;
    }
    if (arg === '--require-linked') {
      opts.requireLinked = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
      const VALUE_OPTIONS = new Set([
        'db',
        'accounts-db',
        'database-url',
        'board',
        'limit',
        'page',
        'class',
        'race',
        'query',
        'sort',
      ]);
      if (!VALUE_OPTIONS.has(key)) {
        throw new Error(`unknown option: --${key}`);
      }
      let val;
      if (eq !== -1) {
        val = arg.slice(eq + 1);
      } else {
        val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) {
          throw new Error(`option --${key} requires a value`);
        }
        i += 1;
      }

      switch (key) {
        case 'db':
          explicitDb = resolve(val);
          opts.dbPath = explicitDb;
          break;
        case 'accounts-db':
          explicitAccountsDb = resolve(val);
          opts.accountsDbPath = explicitAccountsDb;
          break;
        case 'database-url':
          explicitDatabaseUrl = val;
          opts.databaseUrl = val;
          break;
        case 'board':
          opts.board = val.trim();
          break;
        case 'limit':
          opts.limit = parsePositiveInt(val, '--limit');
          break;
        case 'page':
          opts.page = parsePositiveInt(val, '--page');
          break;
        case 'class':
          opts.className = val.trim() || null;
          break;
        case 'race':
          opts.race = val.trim() || null;
          break;
        case 'query':
          opts.query = val.trim() || null;
          break;
        case 'sort':
          opts.sort = val.trim().toLowerCase();
          break;
        default:
          throw new Error(`unknown option: --${key}`);
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      throw new Error(`unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  opts.command = positionals[0] ? positionals[0].toLowerCase() : null;
  opts.args = positionals.slice(1);

  if (explicitDatabaseUrl) {
    opts.backend = 'postgres';
  } else if (explicitDb) {
    opts.backend = 'sqlite';
    opts.databaseUrl = null;
  } else if (opts.databaseUrl) {
    opts.backend = 'postgres';
  } else {
    opts.backend = 'sqlite';
  }

  if (explicitAccountsDb) {
    opts.accountsDbPath = explicitAccountsDb;
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Standalone Fallback Helpers (used if server/hiscores/* modules aren't present)
// ---------------------------------------------------------------------------

function normalizeNameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function slugifySkill(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function safeJsonParse(raw, fallback = {}) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toInt(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function hasSqliteTable(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row?.ok);
}

function collectBannedAccountIdsFromSqlite(gameDb, accountsDbPath) {
  const banned = new Set();

  if (gameDb && hasSqliteTable(gameDb, 'accounts')) {
    try {
      const rows = gameDb
        .prepare('SELECT id FROM accounts WHERE banned_at IS NOT NULL')
        .all();
      for (const r of rows) {
        if (r.id !== null && r.id !== undefined) banned.add(String(r.id));
      }
    } catch {
      /* ignore if schema differs */
    }
  }

  if (accountsDbPath && accountsDbPath !== ':memory:' && existsSync(accountsDbPath)) {
    let accDb = null;
    try {
      accDb = new DatabaseSync(accountsDbPath, { readOnly: true });
      if (hasSqliteTable(accDb, 'accounts')) {
        const rows = accDb
          .prepare('SELECT id FROM accounts WHERE banned_at IS NOT NULL')
          .all();
        for (const r of rows) {
          if (r.id !== null && r.id !== undefined) banned.add(String(r.id));
        }
      }
    } catch {
      /* ignore unreadable external accounts db */
    } finally {
      if (accDb?.isOpen) accDb.close();
    }
  }

  return banned;
}

function fallbackProjectCharacter(row, ctx = {}) {
  const rpg = safeJsonParse(row.rpg, null);
  if (!rpg) return null;

  const skills = {};
  let totalSkill = 0;
  if (rpg.skills && typeof rpg.skills === 'object' && !Array.isArray(rpg.skills)) {
    for (const [k, v] of Object.entries(rpg.skills)) {
      const val = Math.max(0, toInt(v, 0));
      skills[k] = val;
      totalSkill += val;
    }
  }

  const skillMilestones = safeJsonParse(rpg.skillMilestones ?? rpg.skill_milestones, {});
  const guilds = {};
  if (rpg.guilds && typeof rpg.guilds === 'object' && !Array.isArray(rpg.guilds)) {
    for (const [group, entry] of Object.entries(rpg.guilds)) {
      if (!entry || typeof entry !== 'object') continue;
      guilds[group] = {
        rank: Math.max(0, Math.min(9, toInt(entry.rank, 0))),
        title: entry.title ?? null,
        variantName: entry.variantName ?? entry.name ?? null,
      };
    }
  }

  // Infamy / legal
  let infamy = toInt(rpg.infamy, 0);
  let worstRegion = rpg.worstRegion ?? null;
  if (rpg.legal && typeof rpg.legal === 'object') {
    for (const [region, info] of Object.entries(rpg.legal)) {
      const score = toInt(typeof info === 'object' ? (info?.infamy ?? info?.bounty ?? 0) : info, 0);
      if (score > infamy) {
        infamy = score;
        worstRegion = region;
      }
    }
  }

  // Exploration
  const discovered = rpg.travel?.discovered ?? rpg.discoveredPlaces ?? rpg.placesDiscovered;
  const placesDiscovered = Array.isArray(discovered)
    ? discovered.length
    : toInt(discovered, 0);
  const trips = toInt(rpg.travel?.trips ?? rpg.trips, 0);

  // Quests & Slayer
  const questsCompleted = Array.isArray(rpg.questsCompleted)
    ? rpg.questsCompleted.length
    : toInt(rpg.questsCompleted ?? rpg.stats?.questsCompleted ?? rpg.chronicles?.questsCompleted, 0);
  const monstersSlain = toInt(
    rpg.monstersSlain ?? rpg.stats?.monstersSlain ?? rpg.chronicles?.monstersSlain,
    0,
  );

  // Admiralty
  const admiraltyScore = toInt(rpg.admiralty?.score ?? rpg.admiraltyScore, 0);
  const admiraltyRankTitle = String(
    rpg.admiralty?.rankTitle ?? rpg.admiralty?.title ?? rpg.admiraltyRankTitle ?? 'Unsworn',
  );
  const shipsSunk = toInt(rpg.admiralty?.shipsSunk ?? rpg.shipsSunk, 0);

  // Player-founded order membership
  const pg = rpg.playerGuild ?? rpg.order ?? null;
  let orderId = pg?.id ?? pg?.orderId ?? rpg.orderId ?? null;
  let orderTag = pg?.tag ?? rpg.orderTag ?? null;
  let orderName = pg?.name ?? rpg.orderName ?? null;
  let orderRank = pg?.rank ?? rpg.orderRank ?? null;

  if (orderId && ctx.ordersById?.has(String(orderId))) {
    const o = ctx.ordersById.get(String(orderId));
    orderTag = orderTag ?? o.tag ?? null;
    orderName = orderName ?? o.name ?? null;
  }

  const now = ctx.now ?? Date.now();
  const updatedAt = toInt(row.last_seen ?? row.updated_at ?? now, now);
  const milestoneAt = toInt(rpg.milestoneAt ?? rpg.chronicles?.milestoneAt ?? updatedAt, updatedAt);

  return {
    playerId: toInt(row.id ?? row.playerId, 0),
    name: String(row.name ?? 'Adventurer').trim() || 'Adventurer',
    nameKey: normalizeNameKey(row.name ?? 'Adventurer'),
    className: String(rpg.className ?? rpg.class ?? 'Adventurer'),
    race: String(rpg.race ?? 'Breton'),
    level: Math.max(1, toInt(rpg.level, 1)),
    totalSkill,
    placesDiscovered,
    trips,
    questsCompleted,
    monstersSlain,
    infamy,
    worstRegion: worstRegion ? String(worstRegion) : null,
    admiraltyScore,
    admiraltyRankTitle,
    shipsSunk,
    orderId: orderId ? String(orderId) : null,
    orderTag: orderTag ? String(orderTag) : null,
    orderName: orderName ? String(orderName) : null,
    orderRank: orderRank ? String(orderRank) : null,
    skills,
    skillMilestones,
    guilds,
    milestoneAt,
    updatedAt,
  };
}

function fallbackProjectOrders(rawOrders, projectedCharacters) {
  const byOrder = new Map();
  for (const ch of projectedCharacters) {
    if (!ch.orderId) continue;
    let agg = byOrder.get(ch.orderId);
    if (!agg) {
      agg = { memberCount: 0, combinedLevel: 0, combinedTotalSkill: 0 };
      byOrder.set(ch.orderId, agg);
    }
    agg.memberCount += 1;
    agg.combinedLevel += ch.level;
    agg.combinedTotalSkill += ch.totalSkill;
  }

  const out = [];
  for (const raw of rawOrders) {
    const orderId = String(raw.id ?? raw.orderId ?? '');
    if (!orderId) continue;
    const agg = byOrder.get(orderId) ?? {
      memberCount: Array.isArray(raw.members) ? raw.members.length : toInt(raw.memberCount, 0),
      combinedLevel: toInt(raw.combinedLevel, 0),
      combinedTotalSkill: toInt(raw.combinedTotalSkill, 0),
    };
    const name = String(raw.name ?? orderId);
    out.push({
      orderId,
      name,
      nameKey: normalizeNameKey(name),
      tag: String(raw.tag ?? ''),
      leaderName: String(raw.leaderName ?? raw.leader ?? ''),
      memberCount: agg.memberCount,
      combinedLevel: agg.combinedLevel,
      combinedTotalSkill: agg.combinedTotalSkill,
      treasury: toInt(raw.treasury ?? raw.gold ?? 0, 0),
      createdAt: toInt(raw.createdAt ?? raw.created_at ?? 0, 0),
      updatedAt: toInt(raw.updatedAt ?? raw.updated_at ?? Date.now(), Date.now()),
    });
  }
  return out;
}

function openFallbackSqliteStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(FALLBACK_SQLITE_SCHEMA);

  function rowToCharacter(r) {
    const order = r.order_id
      ? {
          id: r.order_id,
          tag: r.order_tag ?? null,
          name: r.order_name ?? null,
          rank: r.order_rank ?? null,
        }
      : null;
    return {
      playerId: Number(r.player_id),
      name: r.name,
      nameKey: r.name_key,
      className: r.class_name,
      race: r.race,
      level: Number(r.level),
      totalSkill: Number(r.total_skill),
      placesDiscovered: Number(r.places_discovered),
      trips: Number(r.trips),
      questsCompleted: Number(r.quests_completed),
      monstersSlain: Number(r.monsters_slain),
      infamy: Number(r.infamy),
      worstRegion: r.worst_region ?? null,
      admiraltyScore: Number(r.admiralty_score),
      admiraltyRankTitle: r.admiralty_rank_title,
      shipsSunk: Number(r.ships_sunk),
      orderId: r.order_id ?? null,
      orderTag: r.order_tag ?? null,
      orderName: r.order_name ?? null,
      orderRank: r.order_rank ?? null,
      order,
      skills: safeJsonParse(r.skills, {}),
      skillMilestones: safeJsonParse(r.skill_milestones, {}),
      guilds: safeJsonParse(r.guilds, {}),
      milestoneAt: Number(r.milestone_at),
      updatedAt: Number(r.updated_at),
    };
  }

  function rowToOrder(r) {
    return {
      orderId: r.order_id,
      name: r.name,
      nameKey: r.name_key,
      tag: r.tag,
      leaderName: r.leader_name,
      memberCount: Number(r.member_count),
      combinedLevel: Number(r.combined_level),
      combinedTotalSkill: Number(r.combined_total_skill),
      treasury: Number(r.treasury),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  return {
    db,
    rebuildFromTables({
      projectCharacter = fallbackProjectCharacter,
      projectOrders = null,
      bannedAccountIds = null,
      requireCreated = false,
      requireLinked = false,
    } = {}) {
      const bannedSet = new Set();
      if (bannedAccountIds) {
        for (const id of bannedAccountIds) {
          if (id !== null && id !== undefined) bannedSet.add(String(id));
        }
      }
      // Also check inline accounts table if present
      if (hasSqliteTable(db, 'accounts')) {
        for (const r of db.prepare('SELECT id FROM accounts WHERE banned_at IS NOT NULL').all()) {
          if (r.id !== null && r.id !== undefined) bannedSet.add(String(r.id));
        }
      }

      const now = Date.now();
      const rawOrders = [];
      const ordersById = new Map();
      if (hasSqliteTable(db, 'world_state')) {
        const wsRows = db
          .prepare("SELECT key, value, updated_at FROM world_state WHERE substr(key, 1, length(?)) = ? ORDER BY key ASC")
          .all(PGUILD_PREFIX, PGUILD_PREFIX);
        for (const ws of wsRows) {
          const parsed = safeJsonParse(ws.value, null);
          if (!parsed) continue;
          const orderId = String(parsed.id ?? parsed.orderId ?? ws.key.slice(PGUILD_PREFIX.length));
          if (!orderId) continue;
          const entry = {
            ...parsed,
            id: orderId,
            updatedAt: parsed.updatedAt ?? parsed.updated_at ?? Number(ws.updated_at ?? now),
          };
          rawOrders.push(entry);
          ordersById.set(orderId, entry);
        }
      }

      let playerRows = [];
      if (hasSqliteTable(db, 'players')) {
        if (hasSqliteTable(db, 'account_characters')) {
          playerRows = db
            .prepare(`
              SELECT p.id, p.name, p.created_at, p.last_seen, p.rpg,
                     a.account_id, a.username, a.linked_at
              FROM players p
              LEFT JOIN account_characters a ON a.player_id = p.id
              ORDER BY p.id ASC
            `)
            .all();
        } else {
          playerRows = db
            .prepare(`
              SELECT p.id, p.name, p.created_at, p.last_seen, p.rpg,
                     NULL AS account_id, NULL AS username, NULL AS linked_at
              FROM players p
              ORDER BY p.id ASC
            `)
            .all();
        }
      }

      const projectedCharacters = [];
      let skipped = 0;

      for (const row of playerRows) {
        const accountId = row.account_id !== null && row.account_id !== undefined ? String(row.account_id) : null;
        if (accountId && bannedSet.has(accountId)) {
          skipped += 1;
          continue;
        }
        if (requireLinked && !accountId) {
          skipped += 1;
          continue;
        }
        const parsedRpg = safeJsonParse(row.rpg, null);
        if (!parsedRpg) {
          skipped += 1;
          continue;
        }
        if (requireCreated && !parsedRpg.created) {
          skipped += 1;
          continue;
        }

        const projected = projectCharacter(row, { ordersById, rawOrders, now });
        if (!projected) {
          skipped += 1;
          continue;
        }
        projectedCharacters.push(projected);
      }

      const projectedOrders = typeof projectOrders === 'function'
        ? projectOrders(
            rawOrders.map((o) => [`${PGUILD_PREFIX}${o.id}`, o]),
            new Map(projectedCharacters.map((c) => [c.playerId, c])),
          )
        : fallbackProjectOrders(rawOrders, projectedCharacters);

      const upsertChar = db.prepare(`
        INSERT INTO hiscores (
          player_id, name, name_key, class_name, race, level, total_skill,
          places_discovered, trips, quests_completed, monsters_slain,
          infamy, worst_region, admiralty_score, admiralty_rank_title, ships_sunk,
          order_id, order_tag, order_name, order_rank,
          skills, skill_milestones, guilds, milestone_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `);

      const upsertOrder = db.prepare(`
        INSERT INTO hiscores_orders (
          order_id, name, name_key, tag, leader_name,
          member_count, combined_level, combined_total_skill,
          treasury, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM hiscores');
        db.exec('DELETE FROM hiscores_orders');

        for (const c of projectedCharacters) {
          upsertChar.run(
            c.playerId,
            c.name,
            c.nameKey ?? normalizeNameKey(c.name),
            c.className ?? 'Adventurer',
            c.race ?? 'Breton',
            toInt(c.level, 1),
            toInt(c.totalSkill, 0),
            toInt(c.placesDiscovered, 0),
            toInt(c.trips, 0),
            toInt(c.questsCompleted, 0),
            toInt(c.monstersSlain, 0),
            toInt(c.infamy, 0),
            c.worstRegion ?? null,
            toInt(c.admiraltyScore, 0),
            c.admiraltyRankTitle ?? 'Unsworn',
            toInt(c.shipsSunk, 0),
            c.orderId ?? c.order?.id ?? null,
            c.orderTag ?? c.order?.tag ?? null,
            c.orderName ?? c.order?.name ?? null,
            c.orderRank ?? c.order?.rank ?? null,
            JSON.stringify(c.skills ?? {}),
            JSON.stringify(c.skillMilestones ?? {}),
            JSON.stringify(c.guilds ?? {}),
            toInt(c.milestoneAt, now),
            toInt(c.updatedAt, now),
          );
        }

        for (const o of projectedOrders) {
          upsertOrder.run(
            o.orderId,
            o.name,
            o.nameKey ?? normalizeNameKey(o.name),
            o.tag ?? '',
            o.leaderName ?? '',
            toInt(o.memberCount, 0),
            toInt(o.combinedLevel, 0),
            toInt(o.combinedTotalSkill, 0),
            toInt(o.treasury, 0),
            toInt(o.createdAt, 0),
            toInt(o.updatedAt, now),
          );
        }

        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        throw err;
      }

      return {
        characters: projectedCharacters.length,
        orders: projectedOrders.length,
        skipped,
      };
    },
    listAll() {
      const characters = db.prepare('SELECT * FROM hiscores ORDER BY player_id ASC').all().map(rowToCharacter);
      const orders = db.prepare('SELECT * FROM hiscores_orders ORDER BY order_id ASC').all().map(rowToOrder);
      return { characters, orders };
    },
    count() {
      const c = db.prepare('SELECT COUNT(*) AS count FROM hiscores').get();
      const o = db.prepare('SELECT COUNT(*) AS count FROM hiscores_orders').get();
      return {
        characters: Number(c?.count ?? 0),
        orders: Number(o?.count ?? 0),
      };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}

function createFallbackEngine({ store }) {
  function resolveBoard(boardId) {
    const raw = String(boardId ?? 'overall').trim();
    const lower = raw.toLowerCase();
    if (CORE_BOARDS[lower]) return { ...CORE_BOARDS[lower], kind: 'core' };
    if (lower.startsWith('guild:')) {
      const group = raw.slice('guild:'.length).trim();
      if (!group) return null;
      return { id: `guild:${group}`, kind: 'guild', group, label: `Guild: ${group}`, unit: 'Rank' };
    }
    if (lower.startsWith('skill:')) {
      const skill = raw.slice('skill:'.length).trim();
      if (!skill) return null;
      return {
        id: `skill:${slugifySkill(skill)}`,
        kind: 'skill',
        skill,
        slug: slugifySkill(skill),
        label: `Skill: ${skill}`,
        unit: 'Skill',
      };
    }
    return null;
  }

  function scoreRecord(rec, def) {
    if (def.kind === 'core') {
      switch (def.id) {
        case 'overall':
          return { eligible: true, score: rec.totalSkill, secondary: rec.level, milestoneAt: rec.milestoneAt };
        case 'level':
          return { eligible: true, score: rec.level, secondary: rec.totalSkill, milestoneAt: rec.milestoneAt };
        case 'exploration':
          return { eligible: true, score: rec.placesDiscovered, secondary: rec.trips, milestoneAt: rec.milestoneAt };
        case 'quests':
          return { eligible: true, score: rec.questsCompleted, secondary: rec.level, milestoneAt: rec.milestoneAt };
        case 'slayer':
          return { eligible: true, score: rec.monstersSlain, secondary: rec.level, milestoneAt: rec.milestoneAt };
        case 'wanted':
          return { eligible: rec.infamy > 0, score: rec.infamy, secondary: rec.level, milestoneAt: rec.milestoneAt };
        case 'admiralty':
          return { eligible: true, score: rec.admiraltyScore, secondary: rec.shipsSunk, milestoneAt: rec.milestoneAt };
        default:
          return { eligible: false };
      }
    }
    if (def.kind === 'guild') {
      const guilds = rec.guilds ?? {};
      const matchKey = Object.keys(guilds).find((k) => k.toLowerCase() === def.group.toLowerCase());
      if (!matchKey) return { eligible: false };
      const g = guilds[matchKey];
      return {
        eligible: true,
        score: toInt(g?.rank, 0),
        secondary: rec.level,
        milestoneAt: rec.milestoneAt,
        meta: { guildTitle: g?.title ?? null },
      };
    }
    if (def.kind === 'skill') {
      const skills = rec.skills ?? {};
      const matchKey = Object.keys(skills).find(
        (k) => k.toLowerCase() === def.skill.toLowerCase() || slugifySkill(k) === def.slug,
      );
      if (!matchKey) return { eligible: false };
      const val = toInt(skills[matchKey], 0);
      const ms = rec.skillMilestones?.[matchKey] ?? rec.skillMilestones?.[def.slug] ?? rec.milestoneAt;
      return { eligible: true, score: val, secondary: rec.level, milestoneAt: toInt(ms, rec.milestoneAt) };
    }
    return { eligible: false };
  }

  function compareEntries(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.secondary !== a.secondary) return b.secondary - a.secondary;
    if (a.milestoneAt !== b.milestoneAt) return a.milestoneAt - b.milestoneAt;
    return Number(a.playerId) - Number(b.playerId);
  }

  async function loadAll() {
    const res = await store.listAll();
    return {
      characters: res?.characters ?? [],
      orders: res?.orders ?? [],
    };
  }

  function rankBoard(characters, def) {
    const scored = [];
    for (const rec of characters) {
      const s = scoreRecord(rec, def);
      if (!s || !s.eligible) continue;
      scored.push({
        record: rec,
        playerId: rec.playerId,
        score: s.score,
        secondary: s.secondary ?? 0,
        milestoneAt: s.milestoneAt ?? 0,
        meta: s.meta ?? null,
      });
    }
    scored.sort(compareEntries);
    return scored.map((item, idx) => ({
      rank: idx + 1,
      globalRank: idx + 1,
      playerId: item.record.playerId,
      name: item.record.name,
      className: item.record.className,
      race: item.record.race,
      level: item.record.level,
      totalSkill: item.record.totalSkill,
      order: item.record.order ?? null,
      orderTag: item.record.order?.tag ?? item.record.orderTag ?? null,
      score: item.score,
      secondary: item.secondary,
      milestoneAt: item.milestoneAt,
      updatedAt: item.record.updatedAt,
      ...(item.meta ?? {}),
    }));
  }

  return {
    async getBoard({ board = 'overall', page = 1, limit = 25, className = '', race = '', query = '' } = {}) {
      const def = resolveBoard(board);
      if (!def) throw new Error(`unknown board: ${board}`);
      const { characters } = await loadAll();
      let entries = rankBoard(characters, def);

      const cLow = String(className || '').trim().toLowerCase();
      const rLow = String(race || '').trim().toLowerCase();
      const qLow = String(query || '').trim().toLowerCase();
      if (cLow || rLow || qLow) {
        entries = entries.filter((e) => {
          if (cLow && String(e.className).toLowerCase() !== cLow) return false;
          if (rLow && String(e.race).toLowerCase() !== rLow) return false;
          if (qLow) {
            const nameMatch = String(e.name).toLowerCase().includes(qLow);
            const tagMatch = e.orderTag ? String(e.orderTag).toLowerCase().includes(qLow) : false;
            if (!nameMatch && !tagMatch) return false;
          }
          return true;
        });
      }

      const total = entries.length;
      const pages = total === 0 ? 0 : Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      const sliced = entries.slice(offset, offset + limit).map((e, i) => ({
        ...e,
        filteredRank: offset + i + 1,
      }));

      return {
        version: 1,
        board: def.id,
        label: def.label,
        unit: def.unit,
        generatedAt: Date.now(),
        total,
        page,
        pages,
        limit,
        filters: {
          className: className || null,
          race: race || null,
          query: query || null,
        },
        entries: sliced,
      };
    },

    async getOrders({ sort = 'members', page = 1, limit = 25, query = '' } = {}) {
      const normSort = String(sort || 'members').toLowerCase();
      if (!VALID_ORDER_SORTS.has(normSort)) {
        throw new Error(`invalid orders sort: ${sort} (expected members, level, or treasury)`);
      }
      const { orders } = await loadAll();
      let list = orders.slice();
      if (normSort === 'level') {
        list.sort(
          (a, b) =>
            b.combinedLevel - a.combinedLevel ||
            b.combinedTotalSkill - a.combinedTotalSkill ||
            a.createdAt - b.createdAt,
        );
      } else if (normSort === 'treasury') {
        list.sort(
          (a, b) =>
            b.treasury - a.treasury || b.memberCount - a.memberCount || a.createdAt - b.createdAt,
        );
      } else {
        list.sort(
          (a, b) =>
            b.memberCount - a.memberCount ||
            b.combinedLevel - a.combinedLevel ||
            a.createdAt - b.createdAt,
        );
      }

      let ranked = list.map((o, idx) => ({ rank: idx + 1, ...o }));
      const qLow = String(query || '').trim().toLowerCase();
      if (qLow) {
        ranked = ranked.filter(
          (o) =>
            String(o.name).toLowerCase().includes(qLow) ||
            String(o.tag).toLowerCase().includes(qLow) ||
            String(o.leaderName).toLowerCase().includes(qLow),
        );
      }

      const total = ranked.length;
      const pages = total === 0 ? 0 : Math.ceil(total / limit);
      const offset = (page - 1) * limit;
      return {
        version: 1,
        sort: normSort,
        generatedAt: Date.now(),
        total,
        page,
        pages,
        limit,
        entries: ranked.slice(offset, offset + limit),
      };
    },

    async getPlayer(nameOrId) {
      const { characters } = await loadAll();
      const target = String(nameOrId ?? '').trim().toLowerCase();
      if (!target) return null;
      const rec = characters.find(
        (c) => normalizeNameKey(c.name) === target || String(c.playerId) === target,
      );
      if (!rec) return null;

      const findRank = (boardId) => {
        const def = resolveBoard(boardId);
        if (!def) return null;
        const ranked = rankBoard(characters, def);
        const hit = ranked.find((e) => e.playerId === rec.playerId);
        return hit ? hit.rank : null;
      };

      const skillNames = new Set();
      for (const c of characters) {
        for (const k of Object.keys(c.skills ?? {})) skillNames.add(k);
      }
      const skills = Array.from(skillNames)
        .sort()
        .map((skill) => {
          const def = resolveBoard(`skill:${skill}`);
          const ranked = def ? rankBoard(characters, def) : [];
          const hit = ranked.find((e) => e.playerId === rec.playerId);
          return {
            skill,
            slug: slugifySkill(skill),
            value: toInt(rec.skills?.[skill], 0),
            rank: hit ? hit.rank : null,
            totalRanked: ranked.length,
            milestoneAt: rec.skillMilestones?.[skill] ?? null,
          };
        });

      const guilds = Object.entries(rec.guilds ?? {}).map(([group, entry]) => ({
        group,
        rank: toInt(entry?.rank, 0),
        title: entry?.title ?? null,
        variantName: entry?.variantName ?? null,
        boardRank: findRank(`guild:${group}`),
      }));

      return {
        version: 1,
        generatedAt: Date.now(),
        player: {
          playerId: rec.playerId,
          name: rec.name,
          className: rec.className,
          race: rec.race,
          level: rec.level,
          totalSkill: rec.totalSkill,
          order: rec.order ?? null,
          updatedAt: rec.updatedAt,
        },
        summary: {
          overallRank: findRank('overall'),
          levelRank: findRank('level'),
          explorationRank: findRank('exploration'),
          questsRank: findRank('quests'),
          slayerRank: findRank('slayer'),
          wantedRank: findRank('wanted'),
          admiraltyRank: findRank('admiralty'),
          placesDiscovered: rec.placesDiscovered,
          totalClassicPlaces: TOTAL_CLASSIC_PLACES,
          questsCompleted: rec.questsCompleted,
          monstersSlain: rec.monstersSlain,
          infamy: rec.infamy,
          worstRegion: rec.worstRegion ?? null,
          admiraltyScore: rec.admiraltyScore,
          admiraltyRankTitle: rec.admiraltyRankTitle ?? 'Unsworn',
          shipsSunk: rec.shipsSunk,
        },
        skills,
        guilds,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Dynamic Dependency Loader
// ---------------------------------------------------------------------------

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

async function resolveDependencies(injected = {}) {
  const [sqliteMod, pgMod, projectMod, engineMod] = await Promise.all([
    injected.openSqliteHiscoresStore ? null : tryImport('../server/hiscores/sqlite-store.js'),
    injected.openPostgresHiscoresStore ? null : tryImport('../server/hiscores/postgres-store.js'),
    injected.projectCharacter && injected.projectOrders ? null : tryImport('../server/hiscores/project.js'),
    injected.createHiscoresEngine ? null : tryImport('../server/hiscores/engine.js'),
  ]);

  return {
    openSqliteHiscoresStore:
      injected.openSqliteHiscoresStore ?? sqliteMod?.openSqliteHiscoresStore ?? openFallbackSqliteStore,
    openPostgresHiscoresStore:
      injected.openPostgresHiscoresStore ?? pgMod?.openPostgresHiscoresStore ?? null,
    projectCharacter: injected.projectCharacter ?? projectMod?.projectCharacter ?? undefined,
    projectOrders: injected.projectOrders ?? projectMod?.projectOrders ?? undefined,
    scoreForBoard: injected.scoreForBoard ?? projectMod?.scoreForBoard ?? undefined,
    createHiscoresEngine:
      injected.createHiscoresEngine ?? engineMod?.createHiscoresEngine ?? createFallbackEngine,
  };
}

// ---------------------------------------------------------------------------
// Output Renderers
// ---------------------------------------------------------------------------

function formatRank(rank) {
  return rank != null ? `#${rank}` : '-';
}

function renderTopText(result) {
  const lines = [];
  const filterParts = [];
  if (result.filters?.className) filterParts.push(`class=${result.filters.className}`);
  if (result.filters?.race) filterParts.push(`race=${result.filters.race}`);
  if (result.filters?.query) filterParts.push(`query=${result.filters.query}`);
  const filterSuffix = filterParts.length ? ` [${filterParts.join(', ')}]` : '';

  lines.push(
    `${result.label ?? result.board} — showing ${result.entries.length} of ${result.total} (page ${result.page}/${Math.max(1, result.pages ?? 1)})${filterSuffix}`,
  );

  if (result.entries.length === 0) {
    lines.push('(no matching entries)');
    return lines.join('\n');
  }

  const unitLabel = result.unit || 'Score';
  const headers = ['Rank', 'Name', 'Class', 'Race', 'Level', unitLabel, 'Order'];
  const rows = result.entries.map((e) => [
    formatRank(e.rank ?? e.globalRank),
    e.name,
    e.className ?? '-',
    e.race ?? '-',
    formatNum(e.level),
    formatNum(e.score),
    e.orderTag ? `[${e.orderTag}]` : '-',
  ]);

  lines.push(formatTable(headers, rows));
  return lines.join('\n');
}

function renderPlayerText(profile) {
  const p = profile.player ?? {};
  const s = profile.summary ?? {};
  const lines = [];

  const orderTag = p.order?.tag ? ` [${p.order.tag}]` : '';
  lines.push(`=== ${p.name}${orderTag} ===`);
  lines.push(
    `Class: ${p.className ?? '-'}  |  Race: ${p.race ?? '-'}  |  Level: ${formatNum(p.level)}  |  Total Skill: ${formatNum(p.totalSkill)}`,
  );
  if (p.order?.name) {
    const rankStr = p.order.rank ? ` (${p.order.rank})` : '';
    lines.push(`Order: ${p.order.name}${orderTag}${rankStr}`);
  }

  lines.push('');
  lines.push('Chronicle Standings:');
  lines.push(
    formatTable(
      ['Board', 'Rank', 'Metric'],
      [
        ['Overall', formatRank(s.overallRank), `${formatNum(p.totalSkill)} Total Skill`],
        ['Level', formatRank(s.levelRank), `Lv ${formatNum(p.level)}`],
        [
          'Exploration',
          formatRank(s.explorationRank),
          `${formatNum(s.placesDiscovered)} / ${formatNum(s.totalClassicPlaces ?? TOTAL_CLASSIC_PLACES)} places`,
        ],
        ['Quests', formatRank(s.questsRank), `${formatNum(s.questsCompleted)} completed`],
        ['Slayer', formatRank(s.slayerRank), `${formatNum(s.monstersSlain)} slain`],
        [
          'Wanted',
          formatRank(s.wantedRank),
          `${formatNum(s.infamy)} infamy${s.worstRegion ? ` (${s.worstRegion})` : ''}`,
        ],
        [
          'Admiralty',
          formatRank(s.admiraltyRank),
          `${formatNum(s.admiraltyScore)} (${s.admiraltyRankTitle ?? 'Unsworn'}, ${formatNum(s.shipsSunk)} sunk)`,
        ],
      ],
      { align: ['left', 'right', 'left'] },
    ),
  );

  const guilds = Array.isArray(profile.guilds) ? profile.guilds : [];
  if (guilds.length > 0) {
    lines.push('');
    lines.push('Guilds:');
    lines.push(
      formatTable(
        ['Guild', 'Rank', 'Title', 'Board Rank'],
        guilds.map((g) => [
          g.variantName || g.group,
          String(g.rank ?? 0),
          g.title ?? '-',
          formatRank(g.boardRank),
        ]),
        { align: ['left', 'right', 'left', 'right'] },
      ),
    );
  }

  const skills = (Array.isArray(profile.skills) ? profile.skills : [])
    .filter((sk) => Number(sk.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value) || String(a.skill).localeCompare(String(b.skill)));

  if (skills.length > 0) {
    lines.push('');
    lines.push('Skills:');
    lines.push(
      formatTable(
        ['Skill', 'Value', 'Rank'],
        skills.map((sk) => [sk.skill, formatNum(sk.value), formatRank(sk.rank)]),
        { align: ['left', 'right', 'right'] },
      ),
    );
  }

  return lines.join('\n');
}

function renderOrdersText(result) {
  const lines = [];
  lines.push(
    `Player-Founded Orders (sort=${result.sort ?? 'members'}) — showing ${result.entries.length} of ${result.total} (page ${result.page}/${Math.max(1, result.pages ?? 1)})`,
  );

  if (result.entries.length === 0) {
    lines.push('(no orders indexed)');
    return lines.join('\n');
  }

  const headers = ['Rank', 'Tag', 'Order', 'Leader', 'Members', 'Combined Lv', 'Total Skill', 'Treasury'];
  const rows = result.entries.map((o) => [
    formatRank(o.rank),
    o.tag ? `[${o.tag}]` : '-',
    o.name,
    o.leaderName || '-',
    formatNum(o.memberCount),
    formatNum(o.combinedLevel),
    formatNum(o.combinedTotalSkill),
    `${formatNum(o.treasury)} gp`,
  ]);

  lines.push(formatTable(headers, rows));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main CLI Runner
// ---------------------------------------------------------------------------

/**
 * Executes the hiscores CLI with the given argv and IO streams.
 * Returns a numeric process exit code (0 = success, 1 = runtime/not-found error, 2 = usage error).
 */
export async function runHiscoresCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  let opts;
  try {
    opts = parseArgs(argv, env);
  } catch (err) {
    stderr.write(`error: ${err.message}\n${USAGE}\n`);
    return 2;
  }

  if (opts.help || opts.command === 'help') {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (!opts.command) {
    stderr.write(`error: missing subcommand\n${USAGE}\n`);
    return 2;
  }

  const knownCommands = new Set(['rebuild', 'top', 'player', 'orders', 'stats']);
  if (!knownCommands.has(opts.command)) {
    stderr.write(`error: unknown subcommand ${JSON.stringify(opts.command)}\n${USAGE}\n`);
    return 2;
  }

  if (opts.command === 'player' && !opts.args[0]) {
    stderr.write(`error: player subcommand requires a <name> argument\n${USAGE}\n`);
    return 2;
  }

  if (opts.command === 'orders' && !VALID_ORDER_SORTS.has(opts.sort)) {
    stderr.write(
      `error: invalid --sort ${JSON.stringify(opts.sort)} (expected members, level, or treasury)\n`,
    );
    return 2;
  }

  let store = null;
  try {
    const deps = await resolveDependencies(io.deps);
    const targetRaw = opts.backend === 'postgres' ? opts.databaseUrl : opts.dbPath;
    const redactedTarget = redactDbUrl(targetRaw);

    if (opts.backend === 'postgres') {
      if (typeof deps.openPostgresHiscoresStore !== 'function') {
        throw new Error(
          'PostgreSQL hiscores store module (server/hiscores/postgres-store.js) is not available in this checkout',
        );
      }
      store = await deps.openPostgresHiscoresStore(opts.databaseUrl);
    } else {
      store = await deps.openSqliteHiscoresStore(opts.dbPath);
    }

    if (opts.command === 'rebuild') {
      const bannedAccountIds =
        opts.backend === 'sqlite'
          ? collectBannedAccountIdsFromSqlite(store.db ?? null, opts.accountsDbPath)
          : undefined;

      const summary = await store.rebuildFromTables({
        projectCharacter: deps.projectCharacter,
        projectOrders: deps.projectOrders,
        bannedAccountIds,
        requireCreated: opts.requireCreated,
        requireLinked: opts.requireLinked,
      });

      const characters = Number(summary?.characters ?? 0);
      const orders = Number(summary?.orders ?? 0);
      const skipped = Number(summary?.skipped ?? 0);

      if (opts.json) {
        stdout.write(
          `${JSON.stringify(
            {
              characters,
              orders,
              skipped,
              backend: opts.backend,
              target: redactedTarget,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        stdout.write(`rebuilt ${characters} characters, ${orders} orders, ${skipped} skipped\n`);
      }
      return 0;
    }

    if (opts.command === 'stats') {
      const counts = await store.count();
      const payload = {
        characters: Number(counts?.characters ?? 0),
        orders: Number(counts?.orders ?? 0),
        backend: opts.backend,
        target: redactedTarget,
      };
      if (opts.json) {
        stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        stdout.write(
          `${formatTable(
            ['Metric', 'Value'],
            [
              ['Backend', payload.backend],
              ['Target', payload.target],
              ['Indexed Characters', formatNum(payload.characters)],
              ['Indexed Orders', formatNum(payload.orders)],
            ],
            { align: ['left', 'left'] },
          )}\n`,
        );
      }
      return 0;
    }

    const engine = deps.createHiscoresEngine({
      store,
      scoreForBoard: deps.scoreForBoard,
      ttlMs: 0,
    });

    if (opts.command === 'top') {
      const result = await engine.getBoard({
        board: opts.board,
        limit: opts.limit,
        page: opts.page,
        className: opts.className ?? '',
        race: opts.race ?? '',
        query: opts.query ?? '',
      });
      if (opts.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(`${renderTopText(result)}\n`);
      }
      return 0;
    }

    if (opts.command === 'player') {
      const name = opts.args.join(' ');
      const profile = await engine.getPlayer(name);
      if (!profile) {
        stderr.write(`error: player ${JSON.stringify(name)} not found in hiscores\n`);
        return 1;
      }
      if (opts.json) {
        stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
      } else {
        stdout.write(`${renderPlayerText(profile)}\n`);
      }
      return 0;
    }

    if (opts.command === 'orders') {
      const result = await engine.getOrders({
        sort: opts.sort,
        limit: opts.limit,
        page: opts.page,
        query: opts.query ?? '',
      });
      if (opts.json) {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        stdout.write(`${renderOrdersText(result)}\n`);
      }
      return 0;
    }

    return 2;
  } catch (err) {
    stderr.write(`error: ${err?.message ?? String(err)}\n`);
    return 1;
  } finally {
    if (store && typeof store.close === 'function') {
      await Promise.resolve(store.close()).catch(() => {});
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await runHiscoresCli(process.argv.slice(2));
  process.exit(code);
}
