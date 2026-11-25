// Chronicles of the Iliac Bay (Hiscores) ranking & query engine.
// Maintains a TTL-cached, O(1)-lookup ranked index across all core, guild, skill, and order boards.

import { SKILLS as DEFAULT_SKILLS } from '../../client/gameplay/character/rules.js';

export const ENGINE_VERSION = 1;
export const DEFAULT_TTL_MS = 30_000;
export const DEFAULT_MAX_PAGE_SIZE = 100;
export const DEFAULT_LIMIT = 25;
export const TOTAL_CLASSIC_PLACES = 15251;

export const CLASSIC_GUILD_GROUPS = Object.freeze([
  Object.freeze({ group: 'fighters', label: 'Fighters Guild', unit: 'Rank', description: 'Standing within the Fighters Guild.' }),
  Object.freeze({ group: 'mages', label: 'Mages Guild', unit: 'Rank', description: 'Standing within the Mages Guild.' }),
  Object.freeze({ group: 'thieves', label: 'Thieves Guild', unit: 'Rank', description: 'Standing within the Thieves Guild.' }),
  Object.freeze({ group: 'brotherhood', label: 'Dark Brotherhood', unit: 'Rank', description: 'Standing within the Dark Brotherhood.' }),
  Object.freeze({ group: 'temple', label: 'Temples', unit: 'Rank', description: 'Standing within the Temples of the Iliac Bay.' }),
  Object.freeze({ group: 'knights', label: 'Knightly Orders', unit: 'Rank', description: 'Standing within the Knightly Orders.' }),
]);

export const CORE_BOARD_DEFS = Object.freeze([
  Object.freeze({ id: 'overall', kind: 'core', label: 'Overall', unit: 'Total Skill', description: 'Combined skill total across all 35 Daggerfall skills.' }),
  Object.freeze({ id: 'level', kind: 'core', label: 'Level', unit: 'Level', description: 'Character experience level.' }),
  Object.freeze({ id: 'exploration', kind: 'core', label: 'Exploration', unit: 'Places', description: 'Distinct classic Iliac Bay locations discovered.' }),
  Object.freeze({ id: 'quests', kind: 'core', label: 'Quests', unit: 'Quests', description: 'Completed quests across guilds, temples, and towns.' }),
  Object.freeze({ id: 'slayer', kind: 'core', label: 'Slayer', unit: 'Slain', description: 'Total monsters and foes defeated.' }),
  Object.freeze({ id: 'wanted', kind: 'core', label: 'Most Wanted', unit: 'Infamy', description: 'Highest regional bounty and criminal infamy.' }),
  Object.freeze({ id: 'admiralty', kind: 'core', label: 'Admiralty', unit: 'Score', description: 'Naval renown and victories at sea.' }),
]);

export const ORDER_SORTS = Object.freeze({
  members: Object.freeze({ id: 'members', label: 'Members', unit: 'Members' }),
  level: Object.freeze({ id: 'level', label: 'Combined Level', unit: 'Total Level' }),
  treasury: Object.freeze({ id: 'treasury', label: 'Treasury', unit: 'Gold' }),
});

/** Convert a canonical skill name (e.g. "Short Blade") into its board slug ("short-blade"). */
export function skillSlug(skillName) {
  return String(skillName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMilestone(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

function comparePlayerId(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === String(a) && String(nb) === String(b)) {
    return na - nb;
  }
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function compareRankedEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.secondary !== a.secondary) return b.secondary - a.secondary;
  const ma = normalizeMilestone(a.milestoneAt);
  const mb = normalizeMilestone(b.milestoneAt);
  if (ma !== mb) return ma - mb;
  return comparePlayerId(a.playerId, b.playerId);
}

function defaultProjectCharacter(raw, skillsList) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim();
  if (!name) return null;

  const skills = {};
  let computedTotal = 0;
  const rawSkills = raw.skills && typeof raw.skills === 'object' ? raw.skills : {};
  for (const skill of skillsList) {
    const val = Math.max(0, toFiniteNumber(rawSkills[skill], 0));
    skills[skill] = val;
    computedTotal += val;
  }

  const totalSkill = raw.totalSkill != null && Number.isFinite(Number(raw.totalSkill))
    ? Number(raw.totalSkill)
    : computedTotal;

  const order = raw.order && typeof raw.order === 'object'
    ? {
        id: raw.order.id ?? raw.order.orderId ?? null,
        name: raw.order.name ?? null,
        tag: raw.order.tag ?? raw.orderTag ?? null,
      }
    : (raw.orderTag ? { id: raw.orderId ?? null, name: raw.orderName ?? null, tag: String(raw.orderTag) } : null);

  return {
    playerId: raw.playerId ?? raw.id ?? name,
    name,
    className: String(raw.className ?? raw.class ?? ''),
    race: String(raw.race ?? ''),
    level: Math.max(1, toFiniteNumber(raw.level, 1)),
    totalSkill,
    placesDiscovered: Math.max(0, toFiniteNumber(raw.placesDiscovered, 0)),
    trips: Math.max(0, toFiniteNumber(raw.trips, 0)),
    questsCompleted: Math.max(0, toFiniteNumber(raw.questsCompleted, 0)),
    monstersSlain: Math.max(0, toFiniteNumber(raw.monstersSlain, 0)),
    infamy: Math.max(0, toFiniteNumber(raw.infamy, 0)),
    worstRegion: raw.worstRegion ?? null,
    admiraltyScore: Math.max(0, toFiniteNumber(raw.admiraltyScore, 0)),
    admiraltyRankTitle: raw.admiraltyRankTitle ?? null,
    shipsSunk: Math.max(0, toFiniteNumber(raw.shipsSunk, 0)),
    skills,
    skillMilestones: raw.skillMilestones && typeof raw.skillMilestones === 'object' ? { ...raw.skillMilestones } : {},
    guilds: raw.guilds && typeof raw.guilds === 'object' ? { ...raw.guilds } : {},
    order,
    orderTag: order?.tag ?? (raw.orderTag ? String(raw.orderTag) : null),
    milestoneAt: toFiniteNumber(raw.milestoneAt, 0),
    updatedAt: toFiniteNumber(raw.updatedAt, 0),
  };
}

function defaultProjectOrders(rawOrders) {
  if (!Array.isArray(rawOrders)) return [];
  const out = [];
  for (const raw of rawOrders) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    out.push({
      id: raw.id ?? raw.orderId ?? name,
      name,
      tag: String(raw.tag ?? raw.orderTag ?? '').trim(),
      memberCount: Math.max(0, toFiniteNumber(raw.memberCount ?? raw.members, 0)),
      totalLevel: Math.max(0, toFiniteNumber(raw.totalLevel ?? raw.level ?? raw.combinedLevel, 0)),
      treasury: Math.max(0, toFiniteNumber(raw.treasury ?? raw.treasuryGold ?? raw.gold, 0)),
      leaderName: raw.leaderName ?? null,
      createdAt: toFiniteNumber(raw.createdAt ?? raw.foundedAt ?? raw.milestoneAt, 0),
    });
  }
  return out;
}

function createBoardCatalog(skillsList) {
  const coreBoards = CORE_BOARD_DEFS.map((b) => ({ ...b }));
  const guildBoards = CLASSIC_GUILD_GROUPS.map((g) => ({
    id: `guild:${g.group}`,
    kind: 'guild',
    group: g.group,
    label: g.label,
    unit: g.unit,
    description: g.description,
  }));
  const skillBoards = skillsList.map((skill) => {
    const slug = skillSlug(skill);
    return {
      id: `skill:${slug}`,
      kind: 'skill',
      skill,
      slug,
      label: skill,
      unit: 'Skill',
    };
  });

  const allCharacterBoards = [...coreBoards, ...guildBoards, ...skillBoards];
  const byId = new Map();
  for (const board of allCharacterBoards) {
    byId.set(board.id, board);
  }

  function defaultResolveBoard(boardId) {
    if (typeof boardId !== 'string') return null;
    const key = boardId.trim().toLowerCase();
    return byId.get(key) ?? null;
  }

  function defaultScoreForBoard(record, boardOrId) {
    const board = typeof boardOrId === 'string' ? defaultResolveBoard(boardOrId) : boardOrId;
    if (!board || !record) return null;

    if (board.kind === 'core') {
      switch (board.id) {
        case 'overall':
          return {
            eligible: true,
            score: toFiniteNumber(record.totalSkill, 0),
            secondary: toFiniteNumber(record.level, 0),
            milestoneAt: record.milestoneAt,
          };
        case 'level':
          return {
            eligible: true,
            score: toFiniteNumber(record.level, 0),
            secondary: toFiniteNumber(record.totalSkill, 0),
            milestoneAt: record.levelMilestoneAt ?? record.milestoneAt,
          };
        case 'exploration':
          return {
            eligible: true,
            score: toFiniteNumber(record.placesDiscovered, 0),
            secondary: toFiniteNumber(record.trips, 0),
            milestoneAt: record.explorationMilestoneAt ?? record.milestoneAt,
          };
        case 'quests':
          return {
            eligible: true,
            score: toFiniteNumber(record.questsCompleted, 0),
            secondary: toFiniteNumber(record.level, 0),
            milestoneAt: record.questsMilestoneAt ?? record.milestoneAt,
          };
        case 'slayer':
          return {
            eligible: true,
            score: toFiniteNumber(record.monstersSlain, 0),
            secondary: toFiniteNumber(record.level, 0),
            milestoneAt: record.slayerMilestoneAt ?? record.milestoneAt,
          };
        case 'wanted': {
          const infamy = toFiniteNumber(record.infamy, 0);
          if (infamy <= 0) return null;
          return {
            eligible: true,
            score: infamy,
            secondary: toFiniteNumber(record.level, 0),
            milestoneAt: record.wantedMilestoneAt ?? record.milestoneAt,
          };
        }
        case 'admiralty': {
          const admiraltyScore = toFiniteNumber(record.admiraltyScore, 0);
          if (admiraltyScore <= 0) return null;
          return {
            eligible: true,
            score: admiraltyScore,
            secondary: toFiniteNumber(record.shipsSunk, 0),
            milestoneAt: record.admiraltyMilestoneAt ?? record.milestoneAt,
          };
        }
        default:
          return null;
      }
    }

    if (board.kind === 'guild') {
      const entry = record.guilds?.[board.group];
      if (!entry || typeof entry !== 'object') return null;
      const rank = Math.max(0, Math.min(9, toFiniteNumber(entry.rank, 0)));
      const secondary = Number.isFinite(Number(entry.reputation))
        ? Number(entry.reputation)
        : toFiniteNumber(record.totalSkill, 0);
      return {
        eligible: true,
        score: rank,
        secondary,
        milestoneAt: entry.milestoneAt ?? entry.joinedAt ?? record.milestoneAt,
        meta: {
          guildGroup: board.group,
          guildTitle: entry.title ?? null,
          variantName: entry.variantName ?? null,
        },
      };
    }

    if (board.kind === 'skill') {
      const value = toFiniteNumber(record.skills?.[board.skill], 0);
      if (value <= 0) return null;
      const skillMilestone = record.skillMilestones?.[board.skill] ?? record.skillMilestones?.[board.slug];
      return {
        eligible: true,
        score: value,
        secondary: toFiniteNumber(record.totalSkill, 0),
        milestoneAt: skillMilestone ?? record.milestoneAt,
      };
    }

    return null;
  }

  function defaultPublicCategoriesPayload() {
    return {
      version: ENGINE_VERSION,
      core: coreBoards.map(({ id, kind, label, unit, description }) => ({ id, kind, label, unit, description })),
      guilds: guildBoards.map(({ id, kind, group, label, unit, description }) => ({ id, kind, group, label, unit, description })),
      skills: skillBoards.map(({ id, kind, skill, slug, label, unit }) => ({ id, kind, skill, slug, label, unit })),
      orders: {
        id: 'orders',
        kind: 'orders',
        label: 'Player Orders',
        sorts: Object.values(ORDER_SORTS).map((s) => ({ ...s })),
      },
    };
  }

  return {
    coreBoards,
    guildBoards,
    skillBoards,
    allCharacterBoards,
    defaultResolveBoard,
    defaultScoreForBoard,
    defaultPublicCategoriesPayload,
  };
}

function compareOrders(sort) {
  return (a, b) => {
    if (sort === 'level') {
      if (b.totalLevel !== a.totalLevel) return b.totalLevel - a.totalLevel;
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      if (b.treasury !== a.treasury) return b.treasury - a.treasury;
    } else if (sort === 'treasury') {
      if (b.treasury !== a.treasury) return b.treasury - a.treasury;
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      if (b.totalLevel !== a.totalLevel) return b.totalLevel - a.totalLevel;
    } else {
      if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
      if (b.totalLevel !== a.totalLevel) return b.totalLevel - a.totalLevel;
      if (b.treasury !== a.treasury) return b.treasury - a.treasury;
    }
    const ca = normalizeMilestone(a.createdAt);
    const cb = normalizeMilestone(b.createdAt);
    if (ca !== cb) return ca - cb;
    const na = a.name.toLowerCase();
    const nb = b.name.toLowerCase();
    if (na < nb) return -1;
    if (na > nb) return 1;
    return comparePlayerId(a.id, b.id);
  };
}

function clampPagination(page, limit, defaultLimit, maxPageSize) {
  const safePage = Math.max(1, Math.floor(toFiniteNumber(page, 1)) || 1);
  const rawLimit = Math.floor(toFiniteNumber(limit, defaultLimit)) || defaultLimit;
  const safeLimit = Math.min(maxPageSize, Math.max(1, rawLimit));
  return { page: safePage, limit: safeLimit };
}

function unknownBoardError(boardId) {
  const err = new Error(`Unknown hiscores board: ${String(boardId)}`);
  err.code = 'UNKNOWN_BOARD';
  err.board = boardId;
  return err;
}

/**
 * Create the Chronicles of the Iliac Bay ranking & query engine.
 *
 * @param {object} [options]
 * @param {Function} [options.loadSnapshot] Async or sync () => ({ characters, orders, generatedAt? })
 * @param {object} [options.store] Alternative snapshot source exposing store.loadSnapshot()
 * @param {number} [options.ttlMs=30000] Cache TTL in ms (0 = always fresh)
 * @param {number} [options.maxPageSize=100] Maximum page size
 * @param {number} [options.limit=25] Default page size
 * @param {Function} [options.projectCharacter] Optional character projector (composes with server/hiscores/project.js)
 * @param {Function} [options.projectOrders] Optional orders projector (composes with server/hiscores/project.js)
 * @param {Function} [options.resolveBoard] Optional board resolver (composes with server/hiscores/categories.js)
 * @param {Function} [options.scoreForBoard] Optional scorer (composes with server/hiscores/categories.js)
 * @param {Function} [options.publicCategoriesPayload] Optional categories metadata provider
 * @param {readonly string[]} [options.SKILLS] Skill list (defaults to canonical 35 Daggerfall skills)
 * @param {Function} [options.now] Optional clock function () => epochMs
 */
export function createHiscoresEngine(options = {}) {
  const skillsList = Array.isArray(options.SKILLS) && options.SKILLS.length > 0
    ? [...options.SKILLS]
    : [...DEFAULT_SKILLS];

  const ttlMs = options.ttlMs != null ? Math.max(0, Number(options.ttlMs)) : DEFAULT_TTL_MS;
  const maxPageSize = Math.max(1, Math.floor(toFiniteNumber(options.maxPageSize, DEFAULT_MAX_PAGE_SIZE)));
  const defaultLimit = Math.min(maxPageSize, Math.max(1, Math.floor(toFiniteNumber(options.limit, DEFAULT_LIMIT))));
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const snapshotLoader = typeof options.loadSnapshot === 'function'
    ? options.loadSnapshot
    : (options.store && typeof options.store.loadSnapshot === 'function'
        ? () => options.store.loadSnapshot()
        : () => ({ characters: [], orders: [], generatedAt: now() }));

  const catalog = createBoardCatalog(skillsList);
  const resolveBoardFn = typeof options.resolveBoard === 'function'
    ? options.resolveBoard
    : catalog.defaultResolveBoard;
  const scoreForBoardFn = typeof options.scoreForBoard === 'function'
    ? options.scoreForBoard
    : catalog.defaultScoreForBoard;
  const publicCategoriesFn = typeof options.publicCategoriesPayload === 'function'
    ? options.publicCategoriesPayload
    : catalog.defaultPublicCategoriesPayload;
  const projectCharacterFn = typeof options.projectCharacter === 'function'
    ? options.projectCharacter
    : (rec) => defaultProjectCharacter(rec, skillsList);
  const projectOrdersFn = typeof options.projectOrders === 'function'
    ? options.projectOrders
    : defaultProjectOrders;

  let cache = null;
  let dirty = true;
  let refreshCount = 0;
  let invalidationEpoch = 0;
  let inFlightRefresh = null;

  function isStale() {
    if (!cache || dirty) return true;
    if (ttlMs <= 0) return true;
    return (now() - cache.cachedAt) >= ttlMs;
  }

  function buildIndex(snapshot, cachedAt) {
    const rawCharacters = Array.isArray(snapshot?.characters) ? snapshot.characters : [];
    const rawOrders = Array.isArray(snapshot?.orders) ? snapshot.orders : [];

    const characters = [];
    for (const raw of rawCharacters) {
      const projected = projectCharacterFn(raw);
      if (projected) characters.push(projected);
    }

    const orders = projectOrdersFn(rawOrders) ?? [];
    const generatedAt = Number.isFinite(Number(snapshot?.generatedAt))
      ? Number(snapshot.generatedAt)
      : cachedAt;

    const byName = new Map();
    const byId = new Map();
    const playerRanks = new Map();

    for (const rec of characters) {
      const nameKey = String(rec.name ?? '').trim().toLowerCase();
      if (nameKey && !byName.has(nameKey)) {
        byName.set(nameKey, rec);
      }
      const idKey = String(rec.playerId);
      if (!byId.has(idKey)) {
        byId.set(idKey, rec);
      }
      if (!playerRanks.has(idKey)) {
        playerRanks.set(idKey, new Map());
      }
    }

    const boards = new Map();
    for (const boardDef of catalog.allCharacterBoards) {
      const resolved = resolveBoardFn(boardDef.id) ?? boardDef;
      const scored = [];
      for (const rec of characters) {
        const res = scoreForBoardFn(rec, resolved);
        if (!res || res.eligible === false) continue;
        if (typeof res.score !== 'number' || !Number.isFinite(res.score)) continue;
        scored.push({
          record: rec,
          playerId: rec.playerId,
          score: res.score,
          secondary: Number.isFinite(res.secondary) ? res.secondary : 0,
          milestoneAt: toFiniteNumber(res.milestoneAt ?? rec.milestoneAt, 0),
          meta: res.meta ?? null,
        });
      }

      scored.sort(compareRankedEntries);

      const entries = scored.map((item, idx) => {
        const globalRank = idx + 1;
        const idKey = String(item.playerId);
        const rankMap = playerRanks.get(idKey);
        if (rankMap) rankMap.set(resolved.id, globalRank);

        const rec = item.record;
        return {
          rank: globalRank,
          globalRank,
          playerId: rec.playerId,
          name: rec.name,
          className: rec.className,
          race: rec.race,
          level: rec.level,
          totalSkill: rec.totalSkill,
          order: rec.order ?? null,
          orderTag: rec.order?.tag ?? rec.orderTag ?? null,
          score: item.score,
          secondary: item.secondary,
          milestoneAt: item.milestoneAt,
          updatedAt: rec.updatedAt,
          ...(item.meta ? item.meta : {}),
        };
      });

      boards.set(resolved.id, { def: resolved, entries });
    }

    const ordersBySort = new Map();
    for (const sortKey of Object.keys(ORDER_SORTS)) {
      const sorted = [...orders].sort(compareOrders(sortKey));
      const ranked = sorted.map((order, idx) => {
        const globalRank = idx + 1;
        return {
          rank: globalRank,
          globalRank,
          ...order,
        };
      });
      ordersBySort.set(sortKey, ranked);
    }

    return {
      cachedAt,
      generatedAt,
      characters,
      orders,
      byName,
      byId,
      playerRanks,
      boards,
      ordersBySort,
    };
  }

  async function refresh({ force = false } = {}) {
    if (!force && !isStale()) {
      return getStats();
    }

    if (inFlightRefresh) {
      return inFlightRefresh;
    }

    const startEpoch = invalidationEpoch;
    inFlightRefresh = (async () => {
      try {
        const snapshot = await snapshotLoader();
        const cachedAt = now();
        cache = buildIndex(snapshot, cachedAt);
        refreshCount += 1;
        dirty = invalidationEpoch !== startEpoch;
        return getStats();
      } finally {
        inFlightRefresh = null;
      }
    })();

    return inFlightRefresh;
  }

  async function ensureFresh() {
    if (isStale()) {
      await refresh({ force: true });
    }
    return cache;
  }

  function invalidate() {
    dirty = true;
    invalidationEpoch += 1;
  }

  function getStats() {
    return {
      cachedAt: cache ? cache.cachedAt : null,
      characterCount: cache ? cache.characters.length : 0,
      orderCount: cache ? cache.orders.length : 0,
      refreshCount,
      stale: isStale(),
    };
  }

  async function getCategories() {
    return publicCategoriesFn();
  }

  async function getOrders({ sort = 'members', page = 1, limit = defaultLimit, query = '' } = {}) {
    const state = await ensureFresh();
    const sortKey = typeof sort === 'string' && Object.prototype.hasOwnProperty.call(ORDER_SORTS, sort.toLowerCase())
      ? sort.toLowerCase()
      : 'members';
    const sortMeta = ORDER_SORTS[sortKey];
    const allEntries = state.ordersBySort.get(sortKey) ?? [];

    const normQuery = typeof query === 'string' ? query.trim() : '';
    const queryLower = normQuery.toLowerCase();

    const filtered = queryLower
      ? allEntries.filter((entry) =>
          entry.name.toLowerCase().includes(queryLower) ||
          (entry.tag && entry.tag.toLowerCase().includes(queryLower)))
      : allEntries;

    const { page: safePage, limit: safeLimit } = clampPagination(page, limit, defaultLimit, maxPageSize);
    const total = filtered.length;
    const pages = total === 0 ? 0 : Math.ceil(total / safeLimit);
    const offset = (safePage - 1) * safeLimit;

    const entries = filtered.slice(offset, offset + safeLimit).map((entry, i) => ({
      ...entry,
      filteredRank: offset + i + 1,
    }));

    return {
      version: ENGINE_VERSION,
      board: 'orders',
      sort: sortKey,
      label: 'Player Orders',
      unit: sortMeta.unit,
      generatedAt: state.generatedAt,
      total,
      page: safePage,
      pages,
      limit: safeLimit,
      filters: {
        query: normQuery || null,
      },
      entries,
    };
  }

  async function getBoard(params = {}) {
    const {
      board = 'overall',
      page = 1,
      limit = defaultLimit,
      className = '',
      race = '',
      query = '',
      sort,
    } = params ?? {};

    const resolved = resolveBoardFn(board);
    if (!resolved) {
      throw unknownBoardError(board);
    }

    if (resolved.kind === 'orders' || resolved.id === 'orders') {
      return getOrders({ sort, page, limit, query });
    }

    const state = await ensureFresh();
    let boardBucket = state.boards.get(resolved.id);

    // Support custom injected boards that weren't in the default catalog
    if (!boardBucket) {
      const scored = [];
      for (const rec of state.characters) {
        const res = scoreForBoardFn(rec, resolved);
        if (!res || res.eligible === false) continue;
        if (typeof res.score !== 'number' || !Number.isFinite(res.score)) continue;
        scored.push({
          record: rec,
          playerId: rec.playerId,
          score: res.score,
          secondary: Number.isFinite(res.secondary) ? res.secondary : 0,
          milestoneAt: toFiniteNumber(res.milestoneAt ?? rec.milestoneAt, 0),
          meta: res.meta ?? null,
        });
      }
      scored.sort(compareRankedEntries);
      boardBucket = {
        def: resolved,
        entries: scored.map((item, idx) => ({
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
          ...(item.meta ? item.meta : {}),
        })),
      };
      state.boards.set(resolved.id, boardBucket);
    }

    const normClass = typeof className === 'string' ? className.trim() : '';
    const normRace = typeof race === 'string' ? race.trim() : '';
    const normQuery = typeof query === 'string' ? query.trim() : '';

    const classLower = normClass.toLowerCase();
    const raceLower = normRace.toLowerCase();
    const queryLower = normQuery.toLowerCase();

    const hasFilters = Boolean(classLower || raceLower || queryLower);
    const filtered = hasFilters
      ? boardBucket.entries.filter((entry) => {
          if (classLower && entry.className.toLowerCase() !== classLower) return false;
          if (raceLower && entry.race.toLowerCase() !== raceLower) return false;
          if (queryLower) {
            const nameMatch = entry.name.toLowerCase().includes(queryLower);
            const tagMatch = entry.orderTag ? entry.orderTag.toLowerCase().includes(queryLower) : false;
            if (!nameMatch && !tagMatch) return false;
          }
          return true;
        })
      : boardBucket.entries;

    const { page: safePage, limit: safeLimit } = clampPagination(page, limit, defaultLimit, maxPageSize);
    const total = filtered.length;
    const pages = total === 0 ? 0 : Math.ceil(total / safeLimit);
    const offset = (safePage - 1) * safeLimit;

    const entries = filtered.slice(offset, offset + safeLimit).map((entry, i) => ({
      ...entry,
      filteredRank: offset + i + 1,
    }));

    return {
      version: ENGINE_VERSION,
      board: resolved.id,
      label: resolved.label,
      unit: resolved.unit,
      generatedAt: state.generatedAt,
      total,
      page: safePage,
      pages,
      limit: safeLimit,
      filters: {
        className: normClass || null,
        race: normRace || null,
        query: normQuery || null,
      },
      entries,
    };
  }

  function findRecord(state, nameOrId) {
    if (nameOrId == null) return null;
    if (typeof nameOrId === 'number') {
      return state.byId.get(String(nameOrId)) ?? null;
    }
    const raw = String(nameOrId).trim();
    if (!raw) return null;
    const byNameMatch = state.byName.get(raw.toLowerCase());
    if (byNameMatch) return byNameMatch;
    return state.byId.get(raw) ?? null;
  }

  function buildPlayerProfile(state, rec) {
    const rankMap = state.playerRanks.get(String(rec.playerId)) ?? new Map();

    const skills = catalog.skillBoards.map((sb) => {
      const value = toFiniteNumber(rec.skills?.[sb.skill], 0);
      const boardBucket = state.boards.get(sb.id);
      const milestoneAt = rec.skillMilestones?.[sb.skill] ?? rec.skillMilestones?.[sb.slug] ?? null;
      return {
        skill: sb.skill,
        slug: sb.slug,
        value,
        rank: rankMap.get(sb.id) ?? null,
        totalRanked: boardBucket ? boardBucket.entries.length : 0,
        milestoneAt: milestoneAt != null && Number.isFinite(Number(milestoneAt)) && Number(milestoneAt) > 0
          ? Number(milestoneAt)
          : null,
      };
    });

    const guilds = [];
    const seenGroups = new Set();
    for (const gb of catalog.guildBoards) {
      const entry = rec.guilds?.[gb.group];
      if (!entry || typeof entry !== 'object') continue;
      seenGroups.add(gb.group);
      guilds.push({
        group: gb.group,
        rank: Math.max(0, Math.min(9, toFiniteNumber(entry.rank, 0))),
        title: entry.title ?? null,
        variantName: entry.variantName ?? null,
        boardRank: rankMap.get(gb.id) ?? null,
      });
    }
    // Preserve any non-standard guild groups if present on the record
    for (const [group, entry] of Object.entries(rec.guilds ?? {})) {
      if (seenGroups.has(group) || !entry || typeof entry !== 'object') continue;
      guilds.push({
        group,
        rank: Math.max(0, Math.min(9, toFiniteNumber(entry.rank, 0))),
        title: entry.title ?? null,
        variantName: entry.variantName ?? null,
        boardRank: rankMap.get(`guild:${group}`) ?? null,
      });
    }

    return {
      version: ENGINE_VERSION,
      generatedAt: state.generatedAt,
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
        overallRank: rankMap.get('overall') ?? null,
        levelRank: rankMap.get('level') ?? null,
        explorationRank: rankMap.get('exploration') ?? null,
        questsRank: rankMap.get('quests') ?? null,
        slayerRank: rankMap.get('slayer') ?? null,
        wantedRank: rankMap.get('wanted') ?? null,
        admiraltyRank: rankMap.get('admiralty') ?? null,
        placesDiscovered: rec.placesDiscovered,
        totalClassicPlaces: TOTAL_CLASSIC_PLACES,
        questsCompleted: rec.questsCompleted,
        monstersSlain: rec.monstersSlain,
        infamy: rec.infamy,
        worstRegion: rec.worstRegion ?? null,
        admiraltyScore: rec.admiraltyScore,
        admiraltyRankTitle: rec.admiraltyRankTitle ?? null,
        shipsSunk: rec.shipsSunk,
      },
      skills,
      guilds,
    };
  }

  async function getPlayer(nameOrId) {
    const state = await ensureFresh();
    const rec = findRecord(state, nameOrId);
    if (!rec) return null;
    return buildPlayerProfile(state, rec);
  }

  async function comparePlayers(nameA, nameB) {
    const state = await ensureFresh();
    const recA = findRecord(state, nameA);
    const recB = findRecord(state, nameB);

    const missing = [];
    if (!recA) missing.push(nameA);
    if (!recB) missing.push(nameB);
    if (missing.length > 0) {
      return { ok: false, missing };
    }

    const profileA = buildPlayerProfile(state, recA);
    const profileB = buildPlayerProfile(state, recB);
    const ranksA = state.playerRanks.get(String(recA.playerId)) ?? new Map();
    const ranksB = state.playerRanks.get(String(recB.playerId)) ?? new Map();

    let winsA = 0;
    let winsB = 0;
    let ties = 0;

    const tally = (delta) => {
      if (delta > 0) {
        winsA += 1;
        return 'a';
      }
      if (delta < 0) {
        winsB += 1;
        return 'b';
      }
      ties += 1;
      return 'tie';
    };

    const coreScoreOf = (rec, id) => {
      switch (id) {
        case 'overall': return rec.totalSkill;
        case 'level': return rec.level;
        case 'exploration': return rec.placesDiscovered;
        case 'quests': return rec.questsCompleted;
        case 'slayer': return rec.monstersSlain;
        case 'wanted': return rec.infamy;
        case 'admiralty': return rec.admiraltyScore;
        default: return 0;
      }
    };

    const core = catalog.coreBoards.map((board) => {
      const aScore = coreScoreOf(recA, board.id);
      const bScore = coreScoreOf(recB, board.id);
      const delta = aScore - bScore;
      return {
        id: board.id,
        label: board.label,
        aScore,
        bScore,
        aRank: ranksA.get(board.id) ?? null,
        bRank: ranksB.get(board.id) ?? null,
        delta,
        winner: tally(delta),
      };
    });

    const skills = catalog.skillBoards.map((sb) => {
      const aValue = toFiniteNumber(recA.skills?.[sb.skill], 0);
      const bValue = toFiniteNumber(recB.skills?.[sb.skill], 0);
      const delta = aValue - bValue;
      return {
        skill: sb.skill,
        slug: sb.slug,
        aValue,
        bValue,
        aRank: ranksA.get(sb.id) ?? null,
        bRank: ranksB.get(sb.id) ?? null,
        delta,
        winner: tally(delta),
      };
    });

    return {
      ok: true,
      version: ENGINE_VERSION,
      generatedAt: state.generatedAt,
      a: profileA,
      b: profileB,
      core,
      skills,
      wins: { a: winsA, b: winsB, ties },
    };
  }

  return {
    refresh,
    invalidate,
    getCategories,
    getBoard,
    getOrders,
    getPlayer,
    comparePlayers,
    getStats,
  };
}
