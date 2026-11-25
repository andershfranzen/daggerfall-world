// PostgreSQL indexed hiscores store (`pg` Pool) matching the contract of
// `server/hiscores/sqlite-store.js` so Chronicles of the Iliac Bay runs
// identically on SQLite and PostgreSQL 17.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = fileURLToPath(new URL('../storage/schema-hiscores.sql', import.meta.url));
let cachedSchemaSql = null;

export function loadHiscoresSchemaSql() {
  if (cachedSchemaSql === null) {
    cachedSchemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  }
  return cachedSchemaSql;
}

function isPgPool(value) {
  return Boolean(value && typeof value === 'object' && typeof value.query === 'function');
}

function normalizeNameKey(name) {
  if (name === undefined || name === null) return '';
  return String(name).trim().toLowerCase();
}

function toInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function requirePlayerId(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`playerId must be a positive safe integer (got ${JSON.stringify(value)})`);
  }
  return n;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function parseJsonObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return structuredClone(value);
  }
  return {};
}

function normalizeCharacterRecord(record, nowFn) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('hiscores character record must be an object');
  }
  const playerId = requirePlayerId(record.playerId ?? record.player_id ?? record.id);
  const name = String(record.name ?? '').trim();
  if (!name) {
    throw new Error(`hiscores character record ${playerId} requires a non-empty name`);
  }
  const nameKey = normalizeNameKey(record.nameKey ?? record.name_key ?? name);
  const className = String(record.className ?? record.class_name ?? '').trim();
  const race = String(record.race ?? '').trim();

  return {
    playerId,
    name,
    nameKey,
    className,
    race,
    level: Math.max(1, toInt(record.level, 1)),
    totalSkill: Math.max(0, toInt(record.totalSkill ?? record.total_skill, 0)),
    placesDiscovered: Math.max(0, toInt(record.placesDiscovered ?? record.places_discovered, 0)),
    trips: Math.max(0, toInt(record.trips, 0)),
    questsCompleted: Math.max(0, toInt(record.questsCompleted ?? record.quests_completed, 0)),
    monstersSlain: Math.max(0, toInt(record.monstersSlain ?? record.monsters_slain, 0)),
    infamy: Math.max(0, toInt(record.infamy, 0)),
    worstRegion: optionalText(record.worstRegion ?? record.worst_region),
    admiraltyScore: Math.max(0, toInt(record.admiraltyScore ?? record.admiralty_score, 0)),
    admiraltyRankTitle:
      String(record.admiraltyRankTitle ?? record.admiralty_rank_title ?? 'Unsworn').trim() || 'Unsworn',
    shipsSunk: Math.max(0, toInt(record.shipsSunk ?? record.ships_sunk, 0)),
    orderId: optionalText(record.orderId ?? record.order_id),
    orderTag: optionalText(record.orderTag ?? record.order_tag),
    orderName: optionalText(record.orderName ?? record.order_name),
    orderRank: optionalText(record.orderRank ?? record.order_rank),
    skills: parseJsonObject(record.skills),
    skillMilestones: parseJsonObject(record.skillMilestones ?? record.skill_milestones),
    guilds: parseJsonObject(record.guilds),
    milestoneAt: Math.max(0, toInt(record.milestoneAt ?? record.milestone_at, 0)),
    updatedAt: Math.max(0, toInt(record.updatedAt ?? record.updated_at, nowFn())),
  };
}

function formatCharacterRow(row) {
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
    admiraltyRankTitle: row.admiralty_rank_title ?? 'Unsworn',
    shipsSunk: Number(row.ships_sunk),
    orderId: row.order_id ?? null,
    orderTag: row.order_tag ?? null,
    orderName: row.order_name ?? null,
    orderRank: row.order_rank ?? null,
    skills: parseJsonObject(row.skills),
    skillMilestones: parseJsonObject(row.skill_milestones),
    guilds: parseJsonObject(row.guilds),
    milestoneAt: Number(row.milestone_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function normalizeOrderRecord(record, nowFn) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('hiscores order record must be an object');
  }
  const orderId = optionalText(record.orderId ?? record.order_id ?? record.id);
  if (!orderId) {
    throw new Error('hiscores order record requires a non-empty orderId');
  }
  const name = String(record.name ?? '').trim();
  if (!name) {
    throw new Error(`hiscores order record ${orderId} requires a non-empty name`);
  }
  const nameKey = normalizeNameKey(record.nameKey ?? record.name_key ?? name);
  const tag = String(record.tag ?? '').trim();
  const leaderName = String(record.leaderName ?? record.leader_name ?? '').trim();

  return {
    orderId,
    name,
    nameKey,
    tag,
    leaderName,
    memberCount: Math.max(0, toInt(record.memberCount ?? record.member_count, 0)),
    combinedLevel: Math.max(0, toInt(record.combinedLevel ?? record.combined_level, 0)),
    combinedTotalSkill: Math.max(0, toInt(record.combinedTotalSkill ?? record.combined_total_skill, 0)),
    treasury: Math.max(0, toInt(record.treasury, 0)),
    createdAt: Math.max(0, toInt(record.createdAt ?? record.created_at, 0)),
    updatedAt: Math.max(0, toInt(record.updatedAt ?? record.updated_at, nowFn())),
  };
}

function formatOrderRow(row) {
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
    treasury: Number(row.treasury ?? 0),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function defaultProjectCharacter(playerRow, nowFn) {
  const rpg = parseJsonObject(playerRow.rpg);
  const skills = parseJsonObject(rpg.skills);
  let totalSkill = 0;
  for (const val of Object.values(skills)) {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) totalSkill += Math.trunc(n);
  }
  return {
    playerId: Number(playerRow.id),
    name: playerRow.name,
    nameKey: normalizeNameKey(playerRow.name),
    className: String(rpg.className ?? rpg.class ?? 'Adventurer'),
    race: String(rpg.race ?? 'Breton'),
    level: Math.max(1, toInt(rpg.level, 1)),
    totalSkill,
    placesDiscovered: Array.isArray(rpg.discoveredPlaces) ? rpg.discoveredPlaces.length : toInt(rpg.placesDiscovered, 0),
    trips: toInt(rpg.trips, 0),
    questsCompleted: toInt(rpg.questsCompleted, 0),
    monstersSlain: toInt(rpg.monstersSlain, 0),
    infamy: toInt(rpg.infamy, 0),
    worstRegion: optionalText(rpg.worstRegion),
    admiraltyScore: toInt(rpg.admiraltyScore, 0),
    admiraltyRankTitle: String(rpg.admiraltyRankTitle ?? 'Unsworn'),
    shipsSunk: toInt(rpg.shipsSunk, 0),
    orderId: optionalText(rpg.orderId),
    orderTag: optionalText(rpg.orderTag),
    orderName: optionalText(rpg.orderName),
    orderRank: optionalText(rpg.orderRank),
    skills,
    skillMilestones: parseJsonObject(rpg.skillMilestones),
    guilds: parseJsonObject(rpg.guilds),
    milestoneAt: toInt(rpg.milestoneAt ?? playerRow.lastSeen ?? playerRow.createdAt, 0),
    updatedAt: nowFn(),
  };
}

function defaultProjectOrders(rawOrders, projectedCharacters, nowFn) {
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
  for (const entry of rawOrders) {
    const data = entry.value ?? {};
    const orderId = optionalText(data.id ?? data.orderId ?? entry.orderId);
    const name = String(data.name ?? '').trim();
    if (!orderId || !name) continue;
    const agg = byOrder.get(orderId);
    const memberCount = agg
      ? agg.memberCount
      : Array.isArray(data.members)
        ? data.members.length
        : toInt(data.memberCount, 0);
    out.push({
      orderId,
      name,
      nameKey: normalizeNameKey(name),
      tag: String(data.tag ?? '').trim(),
      leaderName: String(data.leaderName ?? data.leader ?? '').trim(),
      memberCount,
      combinedLevel: agg ? agg.combinedLevel : toInt(data.combinedLevel, 0),
      combinedTotalSkill: agg ? agg.combinedTotalSkill : toInt(data.combinedTotalSkill, 0),
      treasury: toInt(data.treasury, 0),
      createdAt: toInt(data.createdAt ?? entry.updatedAt, 0),
      updatedAt: toInt(entry.updatedAt, nowFn()),
    });
  }
  return out;
}

const CHARACTER_COLUMNS = `
  player_id, name, name_key, class_name, race,
  level, total_skill, places_discovered, trips,
  quests_completed, monsters_slain, infamy, worst_region,
  admiralty_score, admiralty_rank_title, ships_sunk,
  order_id, order_tag, order_name, order_rank,
  skills, skill_milestones, guilds, milestone_at, updated_at
`;

const UPSERT_CHARACTER_SQL = `
  INSERT INTO hiscores (
    player_id, name, name_key, class_name, race,
    level, total_skill, places_discovered, trips,
    quests_completed, monsters_slain, infamy, worst_region,
    admiralty_score, admiralty_rank_title, ships_sunk,
    order_id, order_tag, order_name, order_rank,
    skills, skill_milestones, guilds, milestone_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11, $12, $13,
    $14, $15, $16,
    $17, $18, $19, $20,
    $21::jsonb, $22::jsonb, $23::jsonb, $24, $25
  )
  ON CONFLICT (player_id) DO UPDATE SET
    name = EXCLUDED.name,
    name_key = EXCLUDED.name_key,
    class_name = EXCLUDED.class_name,
    race = EXCLUDED.race,
    level = EXCLUDED.level,
    total_skill = EXCLUDED.total_skill,
    places_discovered = EXCLUDED.places_discovered,
    trips = EXCLUDED.trips,
    quests_completed = EXCLUDED.quests_completed,
    monsters_slain = EXCLUDED.monsters_slain,
    infamy = EXCLUDED.infamy,
    worst_region = EXCLUDED.worst_region,
    admiralty_score = EXCLUDED.admiralty_score,
    admiralty_rank_title = EXCLUDED.admiralty_rank_title,
    ships_sunk = EXCLUDED.ships_sunk,
    order_id = EXCLUDED.order_id,
    order_tag = EXCLUDED.order_tag,
    order_name = EXCLUDED.order_name,
    order_rank = EXCLUDED.order_rank,
    skills = EXCLUDED.skills,
    skill_milestones = EXCLUDED.skill_milestones,
    guilds = EXCLUDED.guilds,
    milestone_at = EXCLUDED.milestone_at,
    updated_at = EXCLUDED.updated_at
`;

const ORDER_COLUMNS = `
  order_id, name, name_key, tag, leader_name,
  member_count, combined_level, combined_total_skill, treasury,
  created_at, updated_at
`;

const UPSERT_ORDER_SQL = `
  INSERT INTO hiscores_orders (
    order_id, name, name_key, tag, leader_name,
    member_count, combined_level, combined_total_skill, treasury,
    created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11
  )
  ON CONFLICT (order_id) DO UPDATE SET
    name = EXCLUDED.name,
    name_key = EXCLUDED.name_key,
    tag = EXCLUDED.tag,
    leader_name = EXCLUDED.leader_name,
    member_count = EXCLUDED.member_count,
    combined_level = EXCLUDED.combined_level,
    combined_total_skill = EXCLUDED.combined_total_skill,
    treasury = EXCLUDED.treasury,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at
`;

function characterParams(rec) {
  return [
    rec.playerId,
    rec.name,
    rec.nameKey,
    rec.className,
    rec.race,
    rec.level,
    rec.totalSkill,
    rec.placesDiscovered,
    rec.trips,
    rec.questsCompleted,
    rec.monstersSlain,
    rec.infamy,
    rec.worstRegion,
    rec.admiraltyScore,
    rec.admiraltyRankTitle,
    rec.shipsSunk,
    rec.orderId,
    rec.orderTag,
    rec.orderName,
    rec.orderRank,
    JSON.stringify(rec.skills),
    JSON.stringify(rec.skillMilestones),
    JSON.stringify(rec.guilds),
    rec.milestoneAt,
    rec.updatedAt,
  ];
}

function orderParams(rec) {
  return [
    rec.orderId,
    rec.name,
    rec.nameKey,
    rec.tag,
    rec.leaderName,
    rec.memberCount,
    rec.combinedLevel,
    rec.combinedTotalSkill,
    rec.treasury,
    rec.createdAt,
    rec.updatedAt,
  ];
}

/**
 * Open a PostgreSQL-backed hiscores store.
 * Accepts either an existing `pg` Pool (`ownsPool = false`) or a PostgreSQL
 * connection string (`ownsPool = true`, lazily importing `pg`).
 */
export async function openPostgresHiscoresStore(poolOrUrl, opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  let pool;
  let ownsPool = false;

  if (isPgPool(poolOrUrl)) {
    pool = poolOrUrl;
  } else if (typeof poolOrUrl === 'string' && poolOrUrl.trim().length > 0) {
    if (typeof opts.createPool === 'function') {
      pool = await opts.createPool(poolOrUrl.trim(), opts.poolOptions ?? {});
    } else {
      let pgMod;
      try {
        pgMod = await import('pg');
      } catch (err) {
        const wrapped = new Error(
          `PostgreSQL support requires the "pg" package: ${err.message}`,
          { cause: err }
        );
        wrapped.code = 'PG_DRIVER_MISSING';
        throw wrapped;
      }
      const Pool = pgMod.Pool ?? pgMod.default?.Pool;
      if (typeof Pool !== 'function') {
        throw new Error('Loaded "pg" module does not export Pool');
      }
      pool = new Pool({ connectionString: poolOrUrl.trim(), ...(opts.poolOptions ?? {}) });
    }
    ownsPool = true;
  } else {
    throw new Error('openPostgresHiscoresStore requires a pg Pool instance or a PostgreSQL connection string');
  }

  let closed = false;

  async function withTransaction(fn) {
    if (typeof pool.connect === 'function') {
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
        if (typeof client.release === 'function') {
          client.release();
        }
      }
    }
    return fn(pool);
  }

  if (opts.applySchema !== false) {
    const ddl = opts.schemaSql ?? loadHiscoresSchemaSql();
    await pool.query(ddl);
  }

  async function upsertCharacterWith(client, record) {
    const normalized = normalizeCharacterRecord(record, nowFn);
    await client.query(UPSERT_CHARACTER_SQL, characterParams(normalized));
    return normalized;
  }

  async function upsertCharacter(record) {
    return upsertCharacterWith(pool, record);
  }

  async function upsertCharacters(records = []) {
    const list = [];
    for (const record of records ?? []) {
      if (!record) continue;
      list.push(normalizeCharacterRecord(record, nowFn));
    }
    if (list.length === 0) return 0;

    await withTransaction(async (client) => {
      for (const rec of list) {
        await client.query(UPSERT_CHARACTER_SQL, characterParams(rec));
      }
    });
    return list.length;
  }

  async function removeCharacter(playerId) {
    if (playerId === undefined || playerId === null || playerId === '') return false;
    const id = requirePlayerId(playerId);
    const res = await pool.query('DELETE FROM hiscores WHERE player_id = $1', [id]);
    return (res?.rowCount ?? 0) > 0;
  }

  async function syncOrdersWith(client, orders = []) {
    const normalized = [];
    for (const order of orders ?? []) {
      if (!order) continue;
      normalized.push(normalizeOrderRecord(order, nowFn));
    }

    for (const rec of normalized) {
      await client.query(UPSERT_ORDER_SQL, orderParams(rec));
    }

    let delRes;
    if (normalized.length === 0) {
      delRes = await client.query('DELETE FROM hiscores_orders');
    } else {
      const activeIds = normalized.map((o) => o.orderId);
      delRes = await client.query(
        'DELETE FROM hiscores_orders WHERE NOT (order_id = ANY($1::text[]))',
        [activeIds]
      );
    }

    return {
      upserted: normalized.length,
      removed: Number(delRes?.rowCount ?? 0),
    };
  }

  async function syncOrders(orders = []) {
    return withTransaction((client) => syncOrdersWith(client, orders));
  }

  async function detectBannedAccountIds(extraBanned) {
    const banned = new Set();
    if (extraBanned) {
      for (const id of extraBanned) {
        if (id !== undefined && id !== null && String(id).trim() !== '') {
          banned.add(String(id).trim());
        }
      }
    }
    try {
      const res = await pool.query('SELECT id FROM accounts WHERE banned_at IS NOT NULL');
      for (const row of res?.rows ?? []) {
        if (row?.id !== undefined && row?.id !== null) {
          banned.add(String(row.id));
        }
      }
    } catch {
      // `accounts` table may live in a separate database; gracefully rely on `bannedAccountIds`.
    }
    return banned;
  }

  async function rebuildFromTables({
    projectCharacter,
    projectOrders,
    bannedAccountIds,
    requireCreated = false,
    requireLinked = false,
  } = {}) {
    const bannedSet = await detectBannedAccountIds(bannedAccountIds);

    const playersRes = await pool.query(
      `SELECT p.id, p.name, p.created_at, p.last_seen, p.rpg,
              ac.account_id, ac.username AS account_username, ac.linked_at
         FROM players p
         LEFT JOIN account_characters ac ON ac.player_id = p.id
        ORDER BY p.id ASC`
    );

    const worldRes = await pool.query(
      `SELECT key, value, updated_at
         FROM world_state
        WHERE key LIKE 'pguild:%'
        ORDER BY key ASC`
    );

    const rawOrders = (worldRes?.rows ?? []).map((row) => {
      const key = String(row.key ?? '');
      const value = parseJsonObject(row.value);
      return {
        key,
        orderId: key.startsWith('pguild:') ? key.slice('pguild:'.length) : key,
        value,
        updatedAt: Number(row.updated_at ?? 0),
      };
    });

    const projectedCharacters = [];
    let skipped = 0;

    for (const row of playersRes?.rows ?? []) {
      const accountId = row.account_id !== undefined && row.account_id !== null
        ? String(row.account_id)
        : null;

      if (accountId && bannedSet.has(accountId)) {
        skipped += 1;
        continue;
      }
      if (requireLinked && !accountId) {
        skipped += 1;
        continue;
      }

      const rpg = parseJsonObject(row.rpg);
      if (requireCreated && !rpg.created) {
        skipped += 1;
        continue;
      }

      const playerInput = {
        id: Number(row.id),
        playerId: Number(row.id),
        name: row.name,
        createdAt: Number(row.created_at ?? 0),
        lastSeen: Number(row.last_seen ?? 0),
        rpg,
        accountId,
        username: row.account_username ?? null,
        linkedAt: row.linked_at != null ? Number(row.linked_at) : null,
      };

      const projected = typeof projectCharacter === 'function'
        ? projectCharacter(playerInput, { orders: rawOrders, bannedAccountIds: bannedSet })
        : defaultProjectCharacter(playerInput, nowFn);

      if (!projected) {
        skipped += 1;
        continue;
      }
      projectedCharacters.push(normalizeCharacterRecord(projected, nowFn));
    }

    const rawProjectedOrders = typeof projectOrders === 'function'
      ? projectOrders(rawOrders, projectedCharacters)
      : defaultProjectOrders(rawOrders, projectedCharacters, nowFn);

    const projectedOrders = [];
    for (const order of rawProjectedOrders ?? []) {
      if (!order) continue;
      projectedOrders.push(normalizeOrderRecord(order, nowFn));
    }

    await withTransaction(async (client) => {
      for (const rec of projectedCharacters) {
        await client.query(UPSERT_CHARACTER_SQL, characterParams(rec));
      }

      if (projectedCharacters.length === 0) {
        await client.query('DELETE FROM hiscores');
      } else {
        const activePlayerIds = projectedCharacters.map((c) => c.playerId);
        await client.query(
          'DELETE FROM hiscores WHERE NOT (player_id = ANY($1::bigint[]))',
          [activePlayerIds]
        );
      }

      await syncOrdersWith(client, projectedOrders);
    });

    return {
      characters: projectedCharacters.length,
      orders: projectedOrders.length,
      skipped,
    };
  }

  async function loadSnapshot() {
    const [charRes, orderRes] = await Promise.all([
      pool.query(
        `SELECT ${CHARACTER_COLUMNS}
           FROM hiscores
          ORDER BY total_skill DESC, level DESC, milestone_at ASC, player_id ASC`
      ),
      pool.query(
        `SELECT ${ORDER_COLUMNS}
           FROM hiscores_orders
          ORDER BY member_count DESC, combined_level DESC, created_at ASC, order_id ASC`
      ),
    ]);

    return {
      characters: (charRes?.rows ?? []).map(formatCharacterRow),
      orders: (orderRes?.rows ?? []).map(formatOrderRow),
      generatedAt: nowFn(),
    };
  }

  async function findByName(name) {
    const key = normalizeNameKey(name);
    if (!key) return null;
    const res = await pool.query(
      `SELECT ${CHARACTER_COLUMNS}
         FROM hiscores
        WHERE name_key = $1
        ORDER BY total_skill DESC, level DESC, player_id ASC
        LIMIT 1`,
      [key]
    );
    const row = res?.rows?.[0];
    return row ? formatCharacterRow(row) : null;
  }

  async function count() {
    const [charRes, orderRes] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM hiscores'),
      pool.query('SELECT COUNT(*) AS total FROM hiscores_orders'),
    ]);
    return {
      characters: Number(charRes?.rows?.[0]?.total ?? 0),
      orders: Number(orderRes?.rows?.[0]?.total ?? 0),
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (ownsPool && typeof pool.end === 'function') {
      await pool.end();
    }
  }

  return {
    engine: 'postgres',
    pool,
    upsertCharacter,
    upsertCharacters,
    removeCharacter,
    syncOrders,
    rebuildFromTables,
    loadSnapshot,
    findByName,
    count,
    close,
  };
}
