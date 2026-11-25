// Fast, indexed SQLite hiscores storage layer (Chronicles of the Iliac Bay).
//
// Attaches cleanly to an existing node:sqlite DatabaseSync handle (e.g. from server/db.js)
// or opens a standalone SQLite database path (including ':memory:').
// Reads hit only the indexed `hiscores` and `hiscores_orders` tables and never scan `players.rpg`.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PGUILD_PREFIX = 'pguild:';

export const HISCORES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hiscores (
  player_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  class_name TEXT NOT NULL,
  race TEXT NOT NULL,
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
  skills_json TEXT NOT NULL DEFAULT '{}',
  skill_milestones_json TEXT NOT NULL DEFAULT '{}',
  guilds_json TEXT NOT NULL DEFAULT '{}',
  milestone_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hiscores_name_key
  ON hiscores (name_key);
CREATE INDEX IF NOT EXISTS idx_hiscores_overall
  ON hiscores (total_skill DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_level
  ON hiscores (level DESC, total_skill DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_exploration
  ON hiscores (places_discovered DESC, trips DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_quests
  ON hiscores (quests_completed DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_slayer
  ON hiscores (monsters_slain DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_wanted
  ON hiscores (infamy DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_admiralty
  ON hiscores (admiralty_score DESC, ships_sunk DESC, milestone_at ASC, player_id ASC);

CREATE TABLE IF NOT EXISTS hiscores_orders (
  order_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  leader_name TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  combined_level INTEGER NOT NULL DEFAULT 0,
  combined_total_skill INTEGER NOT NULL DEFAULT 0,
  treasury INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hiscores_orders_name_key
  ON hiscores_orders (name_key);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_members
  ON hiscores_orders (member_count DESC, combined_level DESC, created_at ASC, order_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_level
  ON hiscores_orders (combined_level DESC, combined_total_skill DESC, created_at ASC, order_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_treasury
  ON hiscores_orders (treasury DESC, member_count DESC, created_at ASC, order_id ASC);
`;

export function normalizeNameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function nullableString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function serializeJsonObject(value, rawJson) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof rawJson === 'string') {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
    } catch {
      /* fall through to '{}' */
    }
  }
  return '{}';
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || !text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isCharacterCreated(rpg) {
  if (!isPlainObject(rpg)) return false;
  if (isPlainObject(rpg.character)) return true;
  return rpg.created === true;
}

function isHiddenFromHiscores(rpg) {
  if (!isPlainObject(rpg)) return false;
  if (rpg.hiscoresHidden === true || rpg.hideFromHiscores === true) return true;
  if (isPlainObject(rpg.hiscores) && (rpg.hiscores.hidden === true || rpg.hiscores.optOut === true)) return true;
  if (isPlainObject(rpg.privacy) && rpg.privacy.hideHiscores === true) return true;
  return false;
}

function normalizeCharacterInput(record, now = Date.now()) {
  if (!isPlainObject(record)) {
    throw new TypeError('hiscores character record must be an object');
  }
  const playerId = toInt(record.playerId ?? record.player_id ?? record.id, NaN);
  if (!Number.isSafeInteger(playerId) || playerId <= 0) {
    throw new TypeError(`invalid hiscores player_id: ${record.playerId ?? record.player_id ?? record.id}`);
  }
  const name = String(record.name ?? '').trim();
  if (!name) {
    throw new TypeError(`hiscores character ${playerId} requires a non-empty name`);
  }
  const nameKey = normalizeNameKey(record.nameKey ?? record.name_key ?? name);
  const className = String(record.className ?? record.class_name ?? 'Adventurer').trim() || 'Adventurer';
  const race = String(record.race ?? 'Breton').trim() || 'Breton';
  const orderObj = isPlainObject(record.order) ? record.order : null;

  const skillsJson = serializeJsonObject(record.skills, record.skillsJson ?? record.skills_json);
  const skillMilestonesJson = serializeJsonObject(
    record.skillMilestones ?? record.skill_milestones,
    record.skillMilestonesJson ?? record.skill_milestones_json,
  );
  const guildsJson = serializeJsonObject(record.guilds, record.guildsJson ?? record.guilds_json);

  return {
    player_id: playerId,
    name,
    name_key: nameKey,
    class_name: className,
    race,
    level: Math.max(1, toInt(record.level, 1)),
    total_skill: Math.max(0, toInt(record.totalSkill ?? record.total_skill, 0)),
    places_discovered: Math.max(0, toInt(record.placesDiscovered ?? record.places_discovered, 0)),
    trips: Math.max(0, toInt(record.trips, 0)),
    quests_completed: Math.max(0, toInt(record.questsCompleted ?? record.quests_completed, 0)),
    monsters_slain: Math.max(0, toInt(record.monstersSlain ?? record.monsters_slain, 0)),
    infamy: Math.max(0, toInt(record.infamy, 0)),
    worst_region: nullableString(record.worstRegion ?? record.worst_region),
    admiralty_score: Math.max(0, toInt(record.admiraltyScore ?? record.admiralty_score, 0)),
    admiralty_rank_title: String(record.admiraltyRankTitle ?? record.admiralty_rank_title ?? 'Unsworn').trim() || 'Unsworn',
    ships_sunk: Math.max(0, toInt(record.shipsSunk ?? record.ships_sunk, 0)),
    order_id: nullableString(record.orderId ?? record.order_id ?? orderObj?.id ?? orderObj?.orderId),
    order_tag: nullableString(record.orderTag ?? record.order_tag ?? orderObj?.tag),
    order_name: nullableString(record.orderName ?? record.order_name ?? orderObj?.name),
    order_rank: nullableString(record.orderRank ?? record.order_rank ?? orderObj?.rank),
    skills_json: skillsJson,
    skill_milestones_json: skillMilestonesJson,
    guilds_json: guildsJson,
    milestone_at: Math.max(0, toInt(record.milestoneAt ?? record.milestone_at, 0)),
    updated_at: Math.max(0, toInt(record.updatedAt ?? record.updated_at, now)),
  };
}

function characterRowToCanonical(row) {
  if (!row) return null;
  return {
    playerId: Number(row.player_id),
    name: row.name,
    nameKey: row.name_key,
    className: row.class_name,
    race: row.race,
    level: Number(row.level),
    totalSkill: Number(row.total_skill),
    placesDiscovered: Number(row.places_discovered),
    trips: Number(row.trips),
    questsCompleted: Number(row.quests_completed),
    monstersSlain: Number(row.monsters_slain),
    infamy: Number(row.infamy),
    worstRegion: row.worst_region ?? null,
    admiraltyScore: Number(row.admiralty_score),
    admiraltyRankTitle: row.admiralty_rank_title,
    shipsSunk: Number(row.ships_sunk),
    orderId: row.order_id ?? null,
    orderTag: row.order_tag ?? null,
    orderName: row.order_name ?? null,
    orderRank: row.order_rank ?? null,
    skills: parseJsonObject(row.skills_json),
    skillMilestones: parseJsonObject(row.skill_milestones_json),
    guilds: parseJsonObject(row.guilds_json),
    milestoneAt: Number(row.milestone_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeOrderInput(order, now = Date.now()) {
  if (!isPlainObject(order)) {
    throw new TypeError('hiscores order record must be an object');
  }
  const orderId = nullableString(order.orderId ?? order.order_id ?? order.id);
  if (!orderId) {
    throw new TypeError('hiscores order record requires a non-empty orderId');
  }
  const name = String(order.name ?? '').trim();
  if (!name) {
    throw new TypeError(`hiscores order ${orderId} requires a non-empty name`);
  }
  const tag = String(order.tag ?? '').trim();
  const leaderName = String(order.leaderName ?? order.leader_name ?? '').trim();

  return {
    order_id: orderId,
    name,
    name_key: normalizeNameKey(order.nameKey ?? order.name_key ?? name),
    tag,
    leader_name: leaderName,
    member_count: Math.max(0, toInt(order.memberCount ?? order.member_count, 0)),
    combined_level: Math.max(0, toInt(order.combinedLevel ?? order.combined_level, 0)),
    combined_total_skill: Math.max(0, toInt(order.combinedTotalSkill ?? order.combined_total_skill, 0)),
    treasury: Math.max(0, toInt(order.treasury, 0)),
    created_at: Math.max(0, toInt(order.createdAt ?? order.created_at, 0)),
    updated_at: Math.max(0, toInt(order.updatedAt ?? order.updated_at, now)),
  };
}

function orderRowToCanonical(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    name: row.name,
    nameKey: row.name_key,
    tag: row.tag,
    leaderName: row.leader_name,
    memberCount: Number(row.member_count),
    combinedLevel: Number(row.combined_level),
    combinedTotalSkill: Number(row.combined_total_skill),
    treasury: Number(row.treasury),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function defaultProjectCharacter(player, ctx) {
  const rpg = isPlainObject(player.rpg) ? player.rpg : {};
  const ch = isPlainObject(rpg.character) ? rpg.character : {};
  const skills = {};
  let totalSkill = 0;
  if (isPlainObject(ch.skills)) {
    for (const [skill, rawVal] of Object.entries(ch.skills)) {
      const v = Math.max(0, toInt(rawVal, 0));
      skills[skill] = v;
      totalSkill += v;
    }
  }
  const pg = isPlainObject(rpg.playerGuild) ? rpg.playerGuild : null;
  return {
    playerId: player.id,
    name: player.name,
    className: ch.className ?? ch.class ?? 'Adventurer',
    race: ch.race ?? 'Breton',
    level: Math.max(1, toInt(ch.level, 1)),
    totalSkill,
    placesDiscovered: Math.max(0, toInt(rpg.stats?.placesDiscovered ?? rpg.placesDiscovered, 0)),
    trips: Math.max(0, toInt(rpg.stats?.trips ?? rpg.trips, 0)),
    questsCompleted: Math.max(0, toInt(rpg.stats?.questsCompleted ?? rpg.questsCompleted, 0)),
    monstersSlain: Math.max(0, toInt(rpg.stats?.monstersSlain ?? rpg.monstersSlain, 0)),
    infamy: Math.max(0, toInt(rpg.stats?.infamy ?? rpg.infamy, 0)),
    worstRegion: nullableString(rpg.stats?.worstRegion ?? rpg.worstRegion),
    admiraltyScore: Math.max(0, toInt(rpg.admiralty?.score ?? rpg.admiraltyScore, 0)),
    admiraltyRankTitle: String(rpg.admiralty?.rankTitle ?? rpg.admiraltyRankTitle ?? 'Unsworn'),
    shipsSunk: Math.max(0, toInt(rpg.admiralty?.shipsSunk ?? rpg.shipsSunk, 0)),
    orderId: nullableString(pg?.id),
    orderTag: nullableString(pg?.tag),
    orderName: nullableString(pg?.name),
    orderRank: nullableString(pg?.rank),
    skills,
    skillMilestones: isPlainObject(rpg.skillMilestones) ? rpg.skillMilestones : {},
    guilds: isPlainObject(rpg.guilds) ? rpg.guilds : {},
    milestoneAt: Math.max(0, toInt(rpg.milestoneAt ?? player.lastSeen ?? player.createdAt, 0)),
    updatedAt: ctx.now,
  };
}

function defaultProjectOrders(rawOrders, projectedCharacters, ctx) {
  const statsByOrder = new Map();
  for (const ch of projectedCharacters) {
    if (!ch.orderId) continue;
    let agg = statsByOrder.get(ch.orderId);
    if (!agg) {
      agg = { combinedLevel: 0, combinedTotalSkill: 0, memberCount: 0 };
      statsByOrder.set(ch.orderId, agg);
    }
    agg.combinedLevel += ch.level;
    agg.combinedTotalSkill += ch.totalSkill;
    agg.memberCount += 1;
  }

  const out = [];
  for (const raw of rawOrders) {
    if (!isPlainObject(raw)) continue;
    const orderId = nullableString(raw.orderId ?? raw.id);
    const name = String(raw.name ?? '').trim();
    if (!orderId || !name) continue;

    let leaderName = String(raw.leaderName ?? raw.leader_name ?? '').trim();
    const members = isPlainObject(raw.members) ? Object.values(raw.members) : [];
    if (!leaderName) {
      const leader = members.find((m) => isPlainObject(m) && m.rank === 'Leader');
      if (leader && leader.name) leaderName = String(leader.name).trim();
    }
    const agg = statsByOrder.get(orderId);
    const memberCount = members.length > 0 ? members.length : (agg?.memberCount ?? toInt(raw.memberCount ?? raw.member_count, 0));

    out.push({
      orderId,
      name,
      nameKey: normalizeNameKey(name),
      tag: String(raw.tag ?? '').trim(),
      leaderName,
      memberCount,
      combinedLevel: agg?.combinedLevel ?? toInt(raw.combinedLevel ?? raw.combined_level, 0),
      combinedTotalSkill: agg?.combinedTotalSkill ?? toInt(raw.combinedTotalSkill ?? raw.combined_total_skill, 0),
      treasury: Math.max(0, toInt(raw.treasury, 0)),
      createdAt: Math.max(0, toInt(raw.createdAt ?? raw.created_at, 0)),
      updatedAt: Math.max(0, toInt(raw.updatedAt ?? raw.updated_at, ctx.now)),
    });
  }
  return out;
}

function resolveDatabaseHandle(dbOrPath, opts) {
  if (typeof dbOrPath === 'string') {
    if (dbOrPath !== ':memory:') {
      mkdirSync(dirname(dbOrPath), { recursive: true });
    }
    const db = new DatabaseSync(dbOrPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
    `);
    return { db, owns: opts.ownsDb ?? true };
  }
  if (dbOrPath && typeof dbOrPath === 'object') {
    if (typeof dbOrPath.prepare === 'function' && typeof dbOrPath.exec === 'function') {
      return { db: dbOrPath, owns: opts.ownsDb ?? false };
    }
    if (dbOrPath.db && typeof dbOrPath.db.prepare === 'function' && typeof dbOrPath.db.exec === 'function') {
      return { db: dbOrPath.db, owns: opts.ownsDb ?? false };
    }
  }
  throw new TypeError('openSqliteHiscoresStore requires a database path or DatabaseSync instance');
}

export function openSqliteHiscoresStore(dbOrPath, opts = {}) {
  const { db, owns } = resolveDatabaseHandle(dbOrPath, opts);
  db.exec(HISCORES_SCHEMA_SQL);

  let savepointSeq = 0;

  function runInTransaction(fn) {
    if (db.isTransaction) {
      const sp = `hiscores_sp_${++savepointSeq}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          db.exec(`RELEASE SAVEPOINT ${sp}`);
        } catch {}
        throw err;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  const stmtUpsertChar = db.prepare(`
    INSERT INTO hiscores (
      player_id, name, name_key, class_name, race,
      level, total_skill, places_discovered, trips, quests_completed,
      monsters_slain, infamy, worst_region, admiralty_score, admiralty_rank_title,
      ships_sunk, order_id, order_tag, order_name, order_rank,
      skills_json, skill_milestones_json, guilds_json, milestone_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT(player_id) DO UPDATE SET
      name = excluded.name,
      name_key = excluded.name_key,
      class_name = excluded.class_name,
      race = excluded.race,
      level = excluded.level,
      total_skill = excluded.total_skill,
      places_discovered = excluded.places_discovered,
      trips = excluded.trips,
      quests_completed = excluded.quests_completed,
      monsters_slain = excluded.monsters_slain,
      infamy = excluded.infamy,
      worst_region = excluded.worst_region,
      admiralty_score = excluded.admiralty_score,
      admiralty_rank_title = excluded.admiralty_rank_title,
      ships_sunk = excluded.ships_sunk,
      order_id = excluded.order_id,
      order_tag = excluded.order_tag,
      order_name = excluded.order_name,
      order_rank = excluded.order_rank,
      skills_json = excluded.skills_json,
      skill_milestones_json = excluded.skill_milestones_json,
      guilds_json = excluded.guilds_json,
      milestone_at = excluded.milestone_at,
      updated_at = excluded.updated_at
  `);

  const stmtDeleteChar = db.prepare('DELETE FROM hiscores WHERE player_id = ?');
  const stmtAllCharIds = db.prepare('SELECT player_id FROM hiscores');
  const stmtSelectAllChars = db.prepare(`
    SELECT * FROM hiscores
    ORDER BY total_skill DESC, level DESC, milestone_at ASC, player_id ASC
  `);
  const stmtFindByName = db.prepare(`
    SELECT * FROM hiscores
    WHERE name_key = LOWER(TRIM(?))
    ORDER BY total_skill DESC, level DESC, milestone_at ASC, player_id ASC
    LIMIT 1
  `);
  const stmtCountChars = db.prepare('SELECT COUNT(*) AS count FROM hiscores');

  const stmtUpsertOrder = db.prepare(`
    INSERT INTO hiscores_orders (
      order_id, name, name_key, tag, leader_name,
      member_count, combined_level, combined_total_skill, treasury,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      name = excluded.name,
      name_key = excluded.name_key,
      tag = excluded.tag,
      leader_name = excluded.leader_name,
      member_count = excluded.member_count,
      combined_level = excluded.combined_level,
      combined_total_skill = excluded.combined_total_skill,
      treasury = excluded.treasury,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);

  const stmtDeleteOrder = db.prepare('DELETE FROM hiscores_orders WHERE order_id = ?');
  const stmtAllOrderIds = db.prepare('SELECT order_id FROM hiscores_orders');
  const stmtSelectAllOrders = db.prepare(`
    SELECT * FROM hiscores_orders
    ORDER BY member_count DESC, combined_level DESC, created_at ASC, order_id ASC
  `);
  const stmtCountOrders = db.prepare('SELECT COUNT(*) AS count FROM hiscores_orders');
  const stmtTableExists = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?");

  function tableExists(tableName) {
    return Boolean(stmtTableExists.get(tableName));
  }

  function runUpsertChar(row) {
    stmtUpsertChar.run(
      row.player_id,
      row.name,
      row.name_key,
      row.class_name,
      row.race,
      row.level,
      row.total_skill,
      row.places_discovered,
      row.trips,
      row.quests_completed,
      row.monsters_slain,
      row.infamy,
      row.worst_region,
      row.admiralty_score,
      row.admiralty_rank_title,
      row.ships_sunk,
      row.order_id,
      row.order_tag,
      row.order_name,
      row.order_rank,
      row.skills_json,
      row.skill_milestones_json,
      row.guilds_json,
      row.milestone_at,
      row.updated_at,
    );
  }

  function runUpsertOrder(row) {
    stmtUpsertOrder.run(
      row.order_id,
      row.name,
      row.name_key,
      row.tag,
      row.leader_name,
      row.member_count,
      row.combined_level,
      row.combined_total_skill,
      row.treasury,
      row.created_at,
      row.updated_at,
    );
  }

  function syncOrdersInTx(orders, now) {
    const activeIds = new Set();
    let upserted = 0;
    for (const order of orders ?? []) {
      if (!order) continue;
      const row = normalizeOrderInput(order, now);
      runUpsertOrder(row);
      activeIds.add(row.order_id);
      upserted += 1;
    }
    let deleted = 0;
    for (const existing of stmtAllOrderIds.all()) {
      if (!activeIds.has(existing.order_id)) {
        stmtDeleteOrder.run(existing.order_id);
        deleted += 1;
      }
    }
    return { upserted, deleted };
  }

  return {
    engine: 'sqlite',
    db,

    upsertCharacter(record) {
      const row = normalizeCharacterInput(record, Date.now());
      runUpsertChar(row);
      return characterRowToCanonical(row);
    },

    upsertCharacters(records) {
      if (!records) return 0;
      const list = Array.from(records);
      if (list.length === 0) return 0;
      const now = Date.now();
      return runInTransaction(() => {
        let count = 0;
        for (const record of list) {
          if (!record) continue;
          runUpsertChar(normalizeCharacterInput(record, now));
          count += 1;
        }
        return count;
      });
    },

    removeCharacter(playerId) {
      const id = toInt(playerId, NaN);
      if (!Number.isSafeInteger(id)) return false;
      const res = stmtDeleteChar.run(id);
      return Number(res.changes) > 0;
    },

    syncOrders(orders) {
      const list = orders ? Array.from(orders) : [];
      const now = Date.now();
      return runInTransaction(() => syncOrdersInTx(list, now));
    },

    rebuildFromTables({
      projectCharacter,
      projectOrders,
      bannedAccountIds,
      requireCreated = false,
      requireLinked = false,
    } = {}) {
      const bannedSet = new Set();
      if (bannedAccountIds) {
        for (const id of bannedAccountIds) {
          if (id !== null && id !== undefined) bannedSet.add(String(id));
        }
      }
      const now = Date.now();
      const charProjector = typeof projectCharacter === 'function' ? projectCharacter : defaultProjectCharacter;
      const orderProjector = typeof projectOrders === 'function' ? projectOrders : defaultProjectOrders;

      return runInTransaction(() => {
        const hasPlayers = tableExists('players');
        const hasAccountChars = tableExists('account_characters');
        const hasWorldState = tableExists('world_state');

        const rawOrders = [];
        const ordersById = new Map();
        if (hasWorldState) {
          const wsRows = db
            .prepare("SELECT key, value, updated_at FROM world_state WHERE substr(key, 1, length(?)) = ? ORDER BY key ASC")
            .all(PGUILD_PREFIX, PGUILD_PREFIX);
          for (const ws of wsRows) {
            let parsed;
            try {
              parsed = JSON.parse(ws.value);
            } catch {
              continue;
            }
            if (!isPlainObject(parsed)) continue;
            const orderId = nullableString(parsed.id ?? parsed.orderId ?? ws.key.slice(PGUILD_PREFIX.length));
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

        const ctx = {
          ordersById,
          rawOrders,
          bannedAccountIds: bannedSet,
          requireCreated: Boolean(requireCreated),
          requireLinked: Boolean(requireLinked),
          now,
        };

        let playerRows = [];
        if (hasPlayers) {
          if (hasAccountChars) {
            playerRows = db.prepare(`
              SELECT p.id, p.name, p.created_at, p.last_seen, p.rpg,
                     a.account_id, a.username, a.linked_at
              FROM players p
              LEFT JOIN account_characters a ON a.player_id = p.id
              ORDER BY p.id ASC
            `).all();
          } else {
            playerRows = db.prepare(`
              SELECT p.id, p.name, p.created_at, p.last_seen, p.rpg,
                     NULL AS account_id, NULL AS username, NULL AS linked_at
              FROM players p
              ORDER BY p.id ASC
            `).all();
          }
        }

        const keptIds = new Set();
        const projectedCharacters = [];
        let skipped = 0;

        for (const row of playerRows) {
          let rpg;
          try {
            rpg = JSON.parse(row.rpg ?? '{}');
          } catch {
            skipped += 1;
            continue;
          }
          if (!isPlainObject(rpg)) {
            skipped += 1;
            continue;
          }
          if (row.account_id !== null && row.account_id !== undefined && bannedSet.has(String(row.account_id))) {
            skipped += 1;
            continue;
          }
          if (requireLinked && (row.account_id === null || row.account_id === undefined)) {
            skipped += 1;
            continue;
          }
          if (requireCreated && !isCharacterCreated(rpg)) {
            skipped += 1;
            continue;
          }
          if (isHiddenFromHiscores(rpg)) {
            skipped += 1;
            continue;
          }

          const playerInput = {
            id: Number(row.id),
            playerId: Number(row.id),
            name: row.name,
            createdAt: Number(row.created_at ?? 0),
            lastSeen: Number(row.last_seen ?? 0),
            accountId: row.account_id ?? null,
            username: row.username ?? null,
            linkedAt: row.linked_at !== null && row.linked_at !== undefined ? Number(row.linked_at) : null,
            rpg,
          };

          const projected = charProjector(playerInput, ctx);
          if (!projected) {
            skipped += 1;
            continue;
          }

          const normalized = normalizeCharacterInput(projected, now);
          runUpsertChar(normalized);
          keptIds.add(normalized.player_id);
          projectedCharacters.push(characterRowToCanonical(normalized));
        }

        for (const existing of stmtAllCharIds.all()) {
          const existingId = Number(existing.player_id);
          if (!keptIds.has(existingId)) {
            stmtDeleteChar.run(existingId);
          }
        }

        const projectedOrders = orderProjector(rawOrders, projectedCharacters, ctx) ?? [];
        const { upserted: orderCount } = syncOrdersInTx(projectedOrders, now);

        return {
          characters: projectedCharacters.length,
          orders: orderCount,
          skipped,
        };
      });
    },

    loadSnapshot() {
      const characters = stmtSelectAllChars.all().map(characterRowToCanonical);
      const orders = stmtSelectAllOrders.all().map(orderRowToCanonical);
      return {
        characters,
        orders,
        generatedAt: Date.now(),
      };
    },

    findByName(name) {
      if (typeof name !== 'string' || !name.trim()) return null;
      return characterRowToCanonical(stmtFindByName.get(name));
    },

    count() {
      const c = stmtCountChars.get();
      const o = stmtCountOrders.get();
      return {
        characters: Number(c?.count ?? 0),
        orders: Number(o?.count ?? 0),
      };
    },

    close() {
      if (owns && db.isOpen) {
        db.close();
      }
    },
  };
}
