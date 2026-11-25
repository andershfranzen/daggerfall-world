// Pure ES module for the Chronicles of the Iliac Bay (Hiscores) client model.
// Zero DOM dependencies and zero Node-only APIs so it runs identically in browsers and Node tests.

import { SKILLS, SKILL_CATEGORIES, CLASSES, RACES, MAX_SKILL } from '../character/rules.js';

/** Total discoverable classic Daggerfall locations across the Iliac Bay. */
export const TOTAL_CLASSIC_PLACES = 15251;

/** Canonical display order for the 5 Daggerfall skill categories (OSRS-style grid). */
export const SKILL_CATEGORY_ORDER = Object.freeze(['Combat', 'Magic', 'Stealth', 'Body', 'Languages']);

/** Converts a Daggerfall skill name (e.g. 'Long Blade', 'Hand-to-Hand') to a URL/board slug. */
export function skillSlug(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const SKILL_BY_SLUG = Object.freeze(Object.fromEntries(SKILLS.map((s) => [skillSlug(s), s])));
const SKILL_SET = new Set(SKILLS);

const CORE_BOARDS = Object.freeze([
  Object.freeze({ id: 'overall', label: 'Overall', group: 'core' }),
  Object.freeze({ id: 'level', label: 'Level', group: 'core' }),
  Object.freeze({ id: 'exploration', label: 'Exploration', group: 'core' }),
  Object.freeze({ id: 'quests', label: 'Quests', group: 'core' }),
  Object.freeze({ id: 'slayer', label: 'Slayer', group: 'core' }),
  Object.freeze({ id: 'wanted', label: 'Wanted', group: 'core' }),
  Object.freeze({ id: 'admiralty', label: 'Admiralty', group: 'core' }),
]);

const GUILD_BOARDS = Object.freeze([
  Object.freeze({ id: 'guild:fighters', label: 'Fighters Guild', guild: 'fighters', group: 'guilds' }),
  Object.freeze({ id: 'guild:mages', label: 'Mages Guild', guild: 'mages', group: 'guilds' }),
  Object.freeze({ id: 'guild:thieves', label: 'Thieves Guild', guild: 'thieves', group: 'guilds' }),
  Object.freeze({ id: 'guild:brotherhood', label: 'Dark Brotherhood', guild: 'brotherhood', group: 'guilds' }),
  Object.freeze({ id: 'guild:temple', label: 'Temples', guild: 'temple', group: 'guilds' }),
  Object.freeze({ id: 'guild:knights', label: 'Knightly Orders', guild: 'knights', group: 'guilds' }),
]);

const SKILL_BOARDS_BY_CATEGORY = Object.freeze(
  Object.fromEntries(
    SKILL_CATEGORY_ORDER.map((category) => [
      category,
      Object.freeze(
        (SKILL_CATEGORIES[category] ?? []).map((skill) => {
          const slug = skillSlug(skill);
          return Object.freeze({
            id: `skill:${slug}`,
            label: skill,
            skill,
            slug,
            category,
            group: 'skills',
          });
        }),
      ),
    ]),
  ),
);

const ORDER_BOARDS = Object.freeze([
  Object.freeze({ id: 'orders', label: 'Orders', group: 'orders' }),
]);

/**
 * Built-in client fallback catalog matching the server `/api/hiscores/categories` contract:
 * 7 Core boards, 6 Classic Guild boards, all 35 Classic Skill boards grouped by SKILL_CATEGORIES, and Orders.
 */
export const DEFAULT_CATEGORIES = Object.freeze({
  core: CORE_BOARDS,
  guilds: GUILD_BOARDS,
  skills: SKILL_BOARDS_BY_CATEGORY,
  orders: ORDER_BOARDS,
});

/** Filter dropdown options for character classes (18 standard classes + Custom). */
export const CLASS_OPTIONS = Object.freeze([...CLASSES.map((c) => c.name), 'Custom']);

/** Filter dropdown options for character races (8 classic races). */
export const RACE_OPTIONS = Object.freeze(RACES.map((r) => r.name));

// ------------------------------------------------------------------ formatting

function formatInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** Formats a 1-based leaderboard rank as '#1', '#42', or '—' when unranked/null. */
export function formatRank(rank) {
  if (rank == null || rank === '') return '—';
  const n = Number(rank);
  if (!Number.isFinite(n) || n < 1) return '—';
  return `#${Math.floor(n).toLocaleString('en-US')}`;
}

/** Formats discovered classic places as a percentage string '0.0%'..'100.0%'. */
export function formatExplorationPercent(places) {
  const n = Number(places);
  if (!Number.isFinite(n) || n <= 0) return '0.0%';
  const clamped = Math.min(TOTAL_CLASSIC_PLACES, n);
  return `${((clamped / TOTAL_CLASSIC_PLACES) * 100).toFixed(1)}%`;
}

/** Formats a leaderboard score for a given board into a clean human-readable display string. */
export function formatScore(boardId, score, entry = null) {
  if (score == null || score === '') return '—';
  const n = Number(score);
  if (!Number.isFinite(n)) return '—';

  const id = String(boardId ?? '');
  const badge = typeof entry?.badge === 'string' && entry.badge.trim()
    ? entry.badge.trim()
    : (typeof entry?.rankTitle === 'string' && entry.rankTitle.trim() ? entry.rankTitle.trim() : '');

  if (id === 'overall') return `${formatInt(n)} pts`;
  if (id === 'level') return `Lv. ${Math.round(n)}`;
  if (id === 'exploration') {
    return `${formatInt(n)} / ${formatInt(TOTAL_CLASSIC_PLACES)} (${formatExplorationPercent(n)})`;
  }
  if (id === 'quests') {
    const count = Math.round(n);
    return count === 1 ? '1 quest' : `${formatInt(count)} quests`;
  }
  if (id === 'slayer') return `${formatInt(n)} slain`;
  if (id === 'wanted') return `${formatInt(n)} infamy`;
  if (id === 'admiralty') return badge ? `${formatInt(n)} (${badge})` : formatInt(n);
  if (id.startsWith('guild:')) {
    const rankNum = Math.round(n);
    return badge ? `Rank ${rankNum} — ${badge}` : `Rank ${rankNum}`;
  }
  if (id.startsWith('skill:')) return `${Math.round(n)} / ${MAX_SKILL}`;
  return formatInt(n);
}

/** Formats an epoch timestamp (ms) relative to `now` as 'just now', '3m ago', '2h ago', '5d ago', or '—'. */
export function formatRelativeTime(epochMs, now = Date.now()) {
  if (epochMs == null || epochMs === '') return '—';
  const ts = typeof epochMs === 'string' && Number.isNaN(Number(epochMs))
    ? Date.parse(epochMs)
    : Number(epochMs);
  const ref = Number(now);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(ref)) return '—';

  const diffMs = Math.max(0, ref - ts);
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

// ------------------------------------------------------------------ skills grouping

function resolveSkillName(item) {
  if (!item || typeof item !== 'object') return null;
  const direct = item.skill ?? item.name ?? item.label;
  if (typeof direct === 'string' && SKILL_SET.has(direct)) return direct;
  const rawSlug = item.slug
    ?? (typeof item.board === 'string' && item.board.startsWith('skill:') ? item.board.slice(6) : null)
    ?? (typeof direct === 'string' ? skillSlug(direct) : null);
  return rawSlug ? (SKILL_BY_SLUG[rawSlug] ?? null) : null;
}

/**
 * Organizes a player profile's 35 skills (array of skill records or `{ [name]: value }` map)
 * under SKILL_CATEGORIES in canonical order (Combat, Magic, Stealth, Body, Languages).
 */
export function groupSkillsByCategory(skillsList) {
  const byName = new Map();

  if (Array.isArray(skillsList)) {
    for (const item of skillsList) {
      const name = resolveSkillName(item);
      if (!name) continue;
      const rawValue = item.value ?? item.score ?? 0;
      const value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : 0;
      const rawRank = item.rank;
      const rank = rawRank != null && Number.isFinite(Number(rawRank)) && Number(rawRank) >= 1
        ? Math.floor(Number(rawRank))
        : null;
      byName.set(name, { ...item, name, skill: name, value, rank });
    }
  } else if (skillsList && typeof skillsList === 'object') {
    for (const [key, entry] of Object.entries(skillsList)) {
      const name = SKILL_SET.has(key) ? key : (SKILL_BY_SLUG[skillSlug(key)] ?? null);
      if (!name) continue;
      if (entry && typeof entry === 'object') {
        const rawValue = entry.value ?? entry.score ?? 0;
        const value = Number.isFinite(Number(rawValue)) ? Number(rawValue) : 0;
        const rawRank = entry.rank;
        const rank = rawRank != null && Number.isFinite(Number(rawRank)) && Number(rawRank) >= 1
          ? Math.floor(Number(rawRank))
          : null;
        byName.set(name, { ...entry, name, skill: name, value, rank });
      } else {
        const value = Number.isFinite(Number(entry)) ? Number(entry) : 0;
        byName.set(name, { name, skill: name, value, rank: null });
      }
    }
  }

  return SKILL_CATEGORY_ORDER.map((category) => ({
    category,
    skills: (SKILL_CATEGORIES[category] ?? []).map((name) => {
      const slug = skillSlug(name);
      const found = byName.get(name);
      return {
        ...(found ?? {}),
        name,
        skill: name,
        slug,
        board: `skill:${slug}`,
        category,
        value: found ? found.value : 0,
        rank: found ? found.rank : null,
      };
    }),
  }));
}

// ------------------------------------------------------------------ URL builder & HTTP client

/**
 * Builds clean query-encoded URLs for Hiscores endpoints:
 * `/api/hiscores`, `/api/hiscores/categories`, `/api/hiscores/orders`,
 * `/api/hiscores/player/:name`, `/api/hiscores/compare`.
 */
export function buildHiscoresUrl(basePath = '/api/hiscores', route = '', params = {}) {
  const base = String(basePath ?? '/api/hiscores').replace(/\/+$/, '');
  const rawRoute = String(route ?? '').replace(/^\/+|\/+$/g, '');
  const consumed = new Set();

  const resolvedRoute = rawRoute
    ? rawRoute.replace(/:([A-Za-z0-9_]+)/g, (match, key) => {
      if (params && params[key] != null && params[key] !== '') {
        consumed.add(key);
        return encodeURIComponent(String(params[key]));
      }
      return match;
    })
    : '';

  const path = resolvedRoute ? `${base}/${resolvedRoute}` : (base || '/');
  const search = new URLSearchParams();

  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (consumed.has(key)) continue;
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
  }

  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function readErrorMessage(res) {
  try {
    const contentType = typeof res.headers?.get === 'function' ? (res.headers.get('content-type') ?? '') : '';
    if (contentType.includes('application/json') || typeof res.json === 'function') {
      const body = await res.json();
      if (body && typeof body === 'object') {
        if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
        if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
      }
    }
  } catch {
    // Fall through to text / statusText fallback.
  }
  try {
    if (typeof res.text === 'function') {
      const text = (await res.text()).trim();
      if (text) return text;
    }
  } catch {
    // Ignore body read error.
  }
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * Creates a DOM-free HTTP client for the Chronicles of the Iliac Bay API.
 * All methods return `{ ok: true, status, data }` on success or `{ ok: false, status, error }` on failure.
 */
export function createHiscoresClient({ fetchImpl = globalThis.fetch, basePath = '/api/hiscores' } = {}) {
  async function request(route, params = {}) {
    if (typeof fetchImpl !== 'function') {
      return { ok: false, status: 0, error: 'Fetch implementation is unavailable.' };
    }
    const url = buildHiscoresUrl(basePath, route, params);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res || !res.ok) {
        const status = Number(res?.status) || 0;
        const error = res ? await readErrorMessage(res) : 'Empty response from server.';
        return { ok: false, status, error };
      }
      const data = await res.json();
      return { ok: true, status: res.status ?? 200, data };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error && err.message ? err.message : String(err || 'Network error'),
      };
    }
  }

  return {
    fetchCategories() {
      return request('categories');
    },
    fetchBoard({ board, page, limit, className, race, query } = {}) {
      return request('', {
        board,
        page,
        limit,
        class: className,
        race,
        q: query,
      });
    },
    fetchOrders({ sort, page, limit, query } = {}) {
      return request('orders', {
        sort,
        page,
        limit,
        q: query,
      });
    },
    fetchPlayer(name) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) return Promise.resolve({ ok: false, status: 400, error: 'Player name is required.' });
      return request('player/:name', { name: trimmed });
    },
    fetchCompare(a, b) {
      const nameA = String(a ?? '').trim();
      const nameB = String(b ?? '').trim();
      if (!nameA || !nameB) {
        return Promise.resolve({ ok: false, status: 400, error: 'Two player names are required to compare.' });
      }
      return request('compare', { a: nameA, b: nameB });
    },
  };
}

// ------------------------------------------------------------------ comparison summary

function readSideScore(row, side) {
  const upper = side.toUpperCase();
  const candidates = [
    row[`score${upper}`],
    row[`value${upper}`],
    row[side]?.score,
    row[side]?.value,
    typeof row[side] === 'number' ? row[side] : undefined,
  ];
  for (const c of candidates) {
    if (c != null && Number.isFinite(Number(c))) return Number(c);
  }
  return 0;
}

function isSkillRow(row) {
  const board = String(row?.board ?? row?.id ?? '');
  if (board.startsWith('skill:')) return true;
  return resolveSkillName(row) !== null;
}

function rowWinner(row, valA, valB) {
  if (row?.winner === 'a' || row?.winner === 'b' || row?.winner === 'tie') return row.winner;
  if (valA > valB) return 'a';
  if (valB > valA) return 'b';
  return 'tie';
}

/**
 * Computes a concise headline summary and biggest skill advantages for a player comparison payload.
 */
export function summarizeComparison(comparison) {
  const nameA = comparison?.a?.name
    ?? comparison?.playerA?.name
    ?? comparison?.left?.name
    ?? (typeof comparison?.a === 'string' ? comparison.a : 'Player A');
  const nameB = comparison?.b?.name
    ?? comparison?.playerB?.name
    ?? comparison?.right?.name
    ?? (typeof comparison?.b === 'string' ? comparison.b : 'Player B');

  const boardRows = Array.isArray(comparison?.boards)
    ? comparison.boards
    : (Array.isArray(comparison?.rows) ? comparison.rows : []);
  const explicitSkills = Array.isArray(comparison?.skills) ? comparison.skills : null;

  // Combine board rows + separate skills array (deduping if skills are already included in boards).
  const seenBoardIds = new Set(boardRows.map((r) => String(r?.board ?? r?.id ?? r?.skill ?? r?.name ?? '')));
  const allRows = [...boardRows];
  if (explicitSkills) {
    for (const s of explicitSkills) {
      const key = String(s?.board ?? s?.id ?? (resolveSkillName(s) ? `skill:${skillSlug(resolveSkillName(s))}` : ''));
      if (!key || !seenBoardIds.has(key)) {
        allRows.push(s);
        if (key) seenBoardIds.add(key);
      }
    }
  }

  let winsA = 0;
  let winsB = 0;
  let ties = 0;

  if (allRows.length > 0) {
    for (const row of allRows) {
      const valA = readSideScore(row, 'a');
      const valB = readSideScore(row, 'b');
      const w = rowWinner(row, valA, valB);
      if (w === 'a') winsA += 1;
      else if (w === 'b') winsB += 1;
      else ties += 1;
    }
  } else if (comparison?.summary && typeof comparison.summary === 'object') {
    winsA = Number(comparison.summary.winsA) || 0;
    winsB = Number(comparison.summary.winsB) || 0;
    ties = Number(comparison.summary.ties) || 0;
  }

  // Extract skill advantages from explicit skills list, skill rows in boards, or player a/b skill maps.
  const skillEntries = [];
  const skillSource = explicitSkills ?? boardRows.filter(isSkillRow);
  if (skillSource.length > 0) {
    for (const row of skillSource) {
      const skill = resolveSkillName(row) ?? row?.label ?? row?.name ?? row?.board ?? 'Unknown';
      const slug = skillSlug(skill);
      const valueA = readSideScore(row, 'a');
      const valueB = readSideScore(row, 'b');
      skillEntries.push({
        skill,
        slug,
        board: `skill:${slug}`,
        valueA,
        valueB,
        diff: valueA - valueB,
      });
    }
  } else if (comparison?.a?.skills && comparison?.b?.skills) {
    const mapA = new Map(groupSkillsByCategory(comparison.a.skills).flatMap((g) => g.skills.map((s) => [s.name, s.value])));
    const mapB = new Map(groupSkillsByCategory(comparison.b.skills).flatMap((g) => g.skills.map((s) => [s.name, s.value])));
    for (const skill of SKILLS) {
      const slug = skillSlug(skill);
      const valueA = mapA.get(skill) ?? 0;
      const valueB = mapB.get(skill) ?? 0;
      skillEntries.push({ skill, slug, board: `skill:${slug}`, valueA, valueB, diff: valueA - valueB });
    }
  }

  const advantagesA = skillEntries
    .filter((s) => s.diff > 0)
    .sort((x, y) => y.diff - x.diff || x.skill.localeCompare(y.skill));

  const advantagesB = skillEntries
    .filter((s) => s.diff < 0)
    .map((s) => ({ ...s, diff: s.valueB - s.valueA }))
    .sort((x, y) => y.diff - x.diff || x.skill.localeCompare(y.skill));

  const total = winsA + winsB + ties;
  let leader = 'tie';
  let headline;
  if (total === 0) {
    headline = `${nameA} vs ${nameB} — no comparable boards`;
  } else if (winsA > winsB) {
    leader = 'a';
    headline = `${nameA} leads ${winsA}–${winsB} (${ties} tied)`;
  } else if (winsB > winsA) {
    leader = 'b';
    headline = `${nameB} leads ${winsB}–${winsA} (${ties} tied)`;
  } else {
    headline = `Tied ${winsA}–${winsB} (${ties} tied)`;
  }

  return {
    nameA,
    nameB,
    winsA,
    winsB,
    ties,
    total,
    leader,
    headline,
    biggestAdvantageA: advantagesA[0] ?? null,
    biggestAdvantageB: advantagesB[0] ?? null,
    topAdvantagesA: advantagesA.slice(0, 3),
    topAdvantagesB: advantagesB.slice(0, 3),
  };
}
