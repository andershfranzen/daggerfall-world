// Chronicles of the Iliac Bay (Hiscores) HUD panel (panel `hiscores`).
// OSRS-inspired multi-board leaderboards, 35-skill adventurer lookup, side-by-side compare,
// Player Orders rankings, and public listing privacy toggle.
// Pure DOM creation (textContent only; zero innerHTML).

import {
  SKILLS,
  SKILL_CATEGORIES,
  CLASSES,
  RACES,
  MAX_SKILL,
} from './character/rules.js';

export const CARTOGRAPHY_TOTAL = 15251;
export const DEFAULT_PAGE_SIZE = 20;
export const STALE_MS = 30_000;

export const SKILL_CATEGORY_ORDER = Object.freeze([
  'Combat',
  'Magic',
  'Stealth',
  'Body',
  'Languages',
]);

export const CORE_BOARDS = Object.freeze([
  { id: 'overall', label: 'Overall', unit: 'Total Skill' },
  { id: 'level', label: 'Level', unit: 'Level' },
  { id: 'cartography', label: 'Cartography', unit: 'Discovered' },
  { id: 'quests', label: 'Quests', unit: 'Completed' },
  { id: 'slayer', label: 'Slayer', unit: 'Slain' },
  { id: 'wanted', label: 'Most Wanted', unit: 'Infamy' },
  { id: 'admiralty', label: 'Admiralty', unit: 'Crown Rank' },
]);

export const GUILD_BOARDS = Object.freeze([
  { id: 'guild:fighters', group: 'fighters', label: 'Fighters Guild' },
  { id: 'guild:mages', group: 'mages', label: 'Mages Guild' },
  { id: 'guild:thieves', group: 'thieves', label: 'Thieves Guild' },
  { id: 'guild:brotherhood', group: 'brotherhood', label: 'Dark Brotherhood' },
  { id: 'guild:temple', group: 'temple', label: 'Temples' },
  { id: 'guild:knights', group: 'knights', label: 'Knightly Orders' },
]);

export const ORDER_SORTS = Object.freeze([
  { id: 'members', label: 'Members' },
  { id: 'combinedLevel', label: 'Combined Level' },
  { id: 'treasury', label: 'Treasury' },
]);

export function skillSlug(skillName) {
  return String(skillName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function skillBoardId(skillName) {
  return `skill:${skillSlug(skillName)}`;
}

export const SKILL_BOARDS = Object.freeze(
  SKILLS.map((name) => Object.freeze({ id: skillBoardId(name), skill: name, label: name })),
);

const BOARD_BY_ID = new Map([
  ...CORE_BOARDS.map((b) => [b.id, b]),
  ...GUILD_BOARDS.map((b) => [b.id, b]),
  ...SKILL_BOARDS.map((b) => [b.id, b]),
  ...SKILLS.map((s) => [`skill:${s}`, { id: skillBoardId(s), skill: s, label: s }]),
]);

export function boardLabel(boardId) {
  return BOARD_BY_ID.get(boardId)?.label ?? String(boardId ?? 'Overall');
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Math.trunc(n).toLocaleString('en-US');
}

export function formatRank(rank) {
  const n = Number(rank);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `#${Math.trunc(n).toLocaleString('en-US')}`;
}

export function rankClass(rank) {
  const n = Number(rank);
  if (n === 1) return 'hs-rank-1';
  if (n === 2) return 'hs-rank-2';
  if (n === 3) return 'hs-rank-3';
  return '';
}

export function formatDelta(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return '=';
  return n > 0 ? `+${formatNumber(n)}` : formatNumber(n);
}

export function deltaClass(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return 'hs-delta-tie';
  return n > 0 ? 'hs-delta-pos' : 'hs-delta-neg';
}

export function skillPercent(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, Math.round((n / MAX_SKILL) * 100));
}

export function normalizeSkillEntry(skillsMap, skillName) {
  if (!skillsMap || typeof skillsMap !== 'object') return { level: 0, rank: null };
  const raw = skillsMap[skillName] ?? skillsMap[skillSlug(skillName)];
  if (raw == null) return { level: 0, rank: null };
  if (typeof raw === 'number') return { level: raw, rank: null };
  return {
    level: Number(raw.level ?? raw.value ?? raw.score ?? 0) || 0,
    rank: raw.rank ?? null,
  };
}

export function computeCompareRows(left, right) {
  const rows = [];
  const coreGetters = [
    { key: 'overall', label: 'Overall (Total Skill)', get: (p) => p?.core?.overall?.score ?? p?.totalSkill ?? 0 },
    { key: 'level', label: 'Level', get: (p) => p?.core?.level?.score ?? p?.level ?? 1 },
    { key: 'cartography', label: 'Cartography', get: (p) => p?.core?.cartography?.score ?? p?.cartography ?? 0 },
    { key: 'quests', label: 'Quests', get: (p) => p?.core?.quests?.score ?? p?.questsCompleted ?? 0 },
    { key: 'slayer', label: 'Slayer', get: (p) => p?.core?.slayer?.score ?? p?.monstersSlain ?? 0 },
    { key: 'wanted', label: 'Most Wanted', get: (p) => p?.core?.wanted?.score ?? p?.infamy ?? 0 },
    { key: 'admiralty', label: 'Admiralty', get: (p) => p?.core?.admiralty?.score ?? p?.admiraltyScore ?? 0 },
  ];

  let winsA = 0;
  let winsB = 0;
  let ties = 0;

  const pushRow = (section, key, label, valA, valB) => {
    const a = Number(valA) || 0;
    const b = Number(valB) || 0;
    const delta = a - b;
    if (delta > 0) winsA += 1;
    else if (delta < 0) winsB += 1;
    else ties += 1;
    rows.push({ section, key, label, a, b, delta });
  };

  for (const c of coreGetters) {
    pushRow('core', c.key, c.label, c.get(left), c.get(right));
  }
  for (const cat of SKILL_CATEGORY_ORDER) {
    for (const skill of SKILL_CATEGORIES[cat] ?? []) {
      const a = normalizeSkillEntry(left?.skills, skill).level;
      const b = normalizeSkillEntry(right?.skills, skill).level;
      pushRow(cat, skillBoardId(skill), skill, a, b);
    }
  }
  return { rows, summary: { winsA, winsB, ties } };
}

export function formatCompareBanner(nameA, nameB, summary) {
  const a = nameA || 'Adventurer A';
  const b = nameB || 'Adventurer B';
  const winsA = Number(summary?.winsA ?? 0);
  const winsB = Number(summary?.winsB ?? 0);
  const ties = Number(summary?.ties ?? 0);
  if (winsA > winsB) return `${a} leads ${winsA}–${winsB} (${ties} tied)`;
  if (winsB > winsA) return `${b} leads ${winsB}–${winsA} (${ties} tied)`;
  return `Tied ${winsA}–${winsB} (${ties} tied)`;
}

// ---------------------------------------------------------------- DOM helper (no innerHTML)
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'value') n.value = String(v);
    else if (k === 'checked') n.checked = Boolean(v);
    else if (k === 'selected') n.selected = Boolean(v);
    else if (k === 'disabled') {
      n.disabled = true;
      n.setAttribute('disabled', '');
    } else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector?.('link[data-feature="hiscores"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./hiscores.css', import.meta.url).href;
  if (link.dataset) link.dataset.feature = 'hiscores';
  link.setAttribute?.('data-feature', 'hiscores');
  document.head?.append?.(link);
}

function selfHiddenFromState(api) {
  const h = api.state?.self?.rpg?.chronicles?.hidden
    ?? api.state?.character?.chronicles?.hidden
    ?? api.character?.chronicles?.hidden;
  return typeof h === 'boolean' ? h : null;
}

function selfNameFromApi(api) {
  return String(
    api.state?.self?.name
    ?? api.state?.character?.name
    ?? api.character?.name
    ?? api.account?.characterName
    ?? '',
  ).trim();
}

function selfIdFromApi(api) {
  const id = api.selfId ?? api.state?.selfId ?? api.state?.self?.id ?? api.state?.character?.id;
  return id != null ? String(id) : null;
}

export function install(api, opts = {}) {
  loadStyles();

  const now = opts.now ?? (() => Date.now());
  const ui = {
    tab: 'board', // 'board' | 'player' | 'compare' | 'orders'
    // Rankings state
    board: 'overall',
    boardPage: 1,
    boardPageSize: DEFAULT_PAGE_SIZE,
    boardSearch: '',
    boardClass: '',
    boardRace: '',
    boardData: null,
    // Adventurer lookup state
    playerQuery: '',
    playerData: null,
    playerError: '',
    // Compare state
    compareA: '',
    compareB: '',
    compareData: null,
    compareError: '',
    // Player Orders state
    ordersSort: 'members', // 'members' | 'combinedLevel' | 'treasury'
    ordersPage: 1,
    ordersPageSize: DEFAULT_PAGE_SIZE,
    ordersSearch: '',
    ordersData: null,
    // Privacy state
    hidden: selfHiddenFromState(api) ?? false,
    privacyPending: false,
    // Loading & freshness
    loading: { board: false, player: false, compare: false, orders: false },
    loadedAt: { board: 0, player: 0, compare: 0, orders: 0 },
    status: '',
  };

  let container = null;

  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === 'hiscores') api.refreshPanel?.('hiscores');
  };

  const act = (verb, args = {}) => {
    try {
      return api.act(verb, args);
    } catch (e) {
      api.message(e?.message || String(e), { kind: 'error' });
      return false;
    }
  };

  const say = (text) => {
    ui.status = String(text ?? '');
    const live = container?.querySelector?.('.hs-live');
    if (live) live.textContent = ui.status;
  };

  const isStale = (tabId) => !ui.loadedAt[tabId] || (now() - ui.loadedAt[tabId] > STALE_MS);

  const isSelfEntry = (entry) => {
    if (!entry) return false;
    if (entry.self || entry.isSelf) return true;
    const sid = selfIdFromApi(api);
    if (sid && (String(entry.id ?? '') === sid || String(entry.characterId ?? '') === sid)) return true;
    const sname = selfNameFromApi(api);
    if (sname && entry.name && entry.name.toLowerCase() === sname.toLowerCase()) return true;
    return false;
  };

  // ---------------------------------------------------------------- fetchers
  function fetchBoard({ resetPage = false } = {}) {
    if (resetPage) ui.boardPage = 1;
    ui.loading.board = true;
    const args = {
      board: ui.board,
      page: ui.boardPage,
      pageSize: ui.boardPageSize,
    };
    const q = ui.boardSearch.trim();
    if (q) args.search = q;
    if (ui.boardClass) args.className = ui.boardClass;
    if (ui.boardRace) args.race = ui.boardRace;
    act('chronicles.board', args);
    rerender();
  }

  function fetchPlayer(name) {
    const target = String(name ?? ui.playerQuery ?? '').trim();
    if (!target) {
      say('Enter an adventurer name to look up.');
      rerender();
      return;
    }
    ui.playerQuery = target;
    ui.playerError = '';
    ui.loading.player = true;
    act('chronicles.player', { name: target });
    rerender();
  }

  function fetchCompare(nameA, nameB) {
    const a = String(nameA ?? ui.compareA ?? '').trim();
    const b = String(nameB ?? ui.compareB ?? '').trim();
    ui.compareA = a;
    ui.compareB = b;
    if (!a || !b) {
      say('Enter both adventurer names to compare.');
      rerender();
      return;
    }
    ui.compareError = '';
    ui.loading.compare = true;
    act('chronicles.compare', { a, b });
    rerender();
  }

  function fetchOrders({ resetPage = false } = {}) {
    if (resetPage) ui.ordersPage = 1;
    ui.loading.orders = true;
    const args = {
      sort: ui.ordersSort,
      page: ui.ordersPage,
      pageSize: ui.ordersPageSize,
    };
    const q = ui.ordersSearch.trim();
    if (q) args.search = q;
    act('chronicles.orders', args);
    rerender();
  }

  function ensureActiveTabLoaded({ force = false } = {}) {
    const tab = ui.tab;
    if (!force && !isStale(tab)) return;
    if (tab === 'board') {
      fetchBoard();
    } else if (tab === 'player') {
      const target = ui.playerQuery.trim() || selfNameFromApi(api);
      if (target) fetchPlayer(target);
    } else if (tab === 'compare') {
      if (!ui.compareA) ui.compareA = selfNameFromApi(api);
      if (ui.compareA.trim() && ui.compareB.trim()) fetchCompare();
    } else if (tab === 'orders') {
      fetchOrders();
    }
  }

  function openPlayerProfile(name) {
    ui.tab = 'player';
    fetchPlayer(name);
  }

  function openSkillBoard(boardId) {
    ui.tab = 'board';
    ui.board = boardId;
    ui.boardPage = 1;
    fetchBoard();
  }

  function openCompareWith(otherName) {
    ui.tab = 'compare';
    ui.compareA = selfNameFromApi(api) || ui.compareA;
    ui.compareB = String(otherName ?? '').trim();
    if (ui.compareA && ui.compareB) fetchCompare(ui.compareA, ui.compareB);
    else rerender();
  }

  function togglePrivacy(listedPublicly) {
    const hidden = !listedPublicly;
    ui.hidden = hidden;
    ui.privacyPending = true;
    say(hidden ? 'Hiding character from public Chronicles…' : 'Listing character in public Chronicles…');
    act('chronicles.privacy', { hidden });
    rerender();
  }

  // ---------------------------------------------------------------- server events
  api.on('event', (ev) => {
    if (!ev || ev.kind !== 'chronicles') return;
    const sub = ev.subkind ?? ev.action ?? ev.view ?? null;

    const isOrders = sub === 'orders' || (!sub && 'orders' in ev);
    const isPlayer = sub === 'player' || (!sub && ('player' in ev || 'profile' in ev));
    const isCompare = sub === 'compare' || (!sub && (ev.compare || (ev.a && ev.b) || (ev.left && ev.right)));
    const isPrivacy = sub === 'privacy' || (!sub && (typeof ev.hidden === 'boolean' || ev.privacy));
    const isBoard = sub === 'board' || (!sub && (ev.entries || ev.rows));

    if (isBoard) {
      const entries = Array.isArray(ev.entries) ? ev.entries : (Array.isArray(ev.rows) ? ev.rows : []);
      const pageSize = Number(ev.pageSize ?? ui.boardPageSize) || DEFAULT_PAGE_SIZE;
      const total = Number(ev.total ?? ev.count ?? entries.length) || 0;
      const page = Math.max(1, Number(ev.page ?? ui.boardPage) || 1);
      const totalPages = Math.max(1, Number(ev.totalPages ?? Math.ceil(total / pageSize)) || 1);
      ui.board = ev.board ?? ui.board;
      ui.boardPage = page;
      ui.boardPageSize = pageSize;
      ui.boardData = { board: ui.board, page, pageSize, total, totalPages, entries };
      ui.loading.board = false;
      ui.loadedAt.board = now();
    } else if (isPlayer) {
      const profile = ev.player ?? ev.profile ?? null;
      ui.loading.player = false;
      ui.loadedAt.player = now();
      if (!profile || ev.notFound || ev.error) {
        ui.playerData = null;
        ui.playerError = ev.error || `No chronicle found for "${ev.name ?? ui.playerQuery}".`;
        say(ui.playerError);
      } else {
        ui.playerData = profile;
        ui.playerError = '';
        if (profile.name) ui.playerQuery = profile.name;
      }
    } else if (isCompare) {
      const cmp = ev.compare ?? ev;
      ui.loading.compare = false;
      ui.loadedAt.compare = now();
      if (ev.error || (!cmp.a && !cmp.left) || (!cmp.b && !cmp.right)) {
        ui.compareData = null;
        ui.compareError = ev.error || 'Could not compare those adventurers.';
        say(ui.compareError);
      } else {
        const left = cmp.a ?? cmp.left;
        const right = cmp.b ?? cmp.right;
        const computed = computeCompareRows(left, right);
        ui.compareData = {
          left,
          right,
          rows: Array.isArray(cmp.rows) ? cmp.rows : computed.rows,
          summary: cmp.summary ?? computed.summary,
        };
        ui.compareError = '';
      }
    } else if (isOrders) {
      const src = Array.isArray(ev.orders) ? { entries: ev.orders } : (ev.orders ?? ev);
      const entries = Array.isArray(src.entries) ? src.entries : (Array.isArray(ev.entries) ? ev.entries : []);
      const pageSize = Number(ev.pageSize ?? src.pageSize ?? ui.ordersPageSize) || DEFAULT_PAGE_SIZE;
      const total = Number(ev.total ?? src.total ?? ev.count ?? entries.length) || 0;
      const page = Math.max(1, Number(ev.page ?? src.page ?? ui.ordersPage) || 1);
      const totalPages = Math.max(1, Number(ev.totalPages ?? src.totalPages ?? Math.ceil(total / pageSize)) || 1);
      ui.ordersSort = ev.sort ?? src.sort ?? ui.ordersSort;
      ui.ordersPage = page;
      ui.ordersPageSize = pageSize;
      ui.ordersData = { sort: ui.ordersSort, page, pageSize, total, totalPages, entries };
      ui.loading.orders = false;
      ui.loadedAt.orders = now();
    } else if (isPrivacy) {
      ui.hidden = Boolean(ev.privacy?.hidden ?? ev.hidden);
      ui.privacyPending = false;
      say(ev.text || (ui.hidden ? 'Your character is hidden from public Chronicles.' : 'Your character is listed in public Chronicles.'));
    }

    if (ev.text) {
      ev.silent = true;
      say(ev.text);
    }
    rerender();
  });

  api.on('state', () => {
    const h = selfHiddenFromState(api);
    if (h !== null && !ui.privacyPending) ui.hidden = h;
    if (!ui.compareA) {
      const selfName = selfNameFromApi(api);
      if (selfName) ui.compareA = selfName;
    }
  });

  api.on('screen', (s) => {
    if (s !== 'game') {
      ui.boardData = null;
      ui.playerData = null;
      ui.compareData = null;
      ui.ordersData = null;
      ui.loadedAt = { board: 0, player: 0, compare: 0, orders: 0 };
    }
  });

  api.on('panel', (p) => {
    const opened = typeof p === 'string'
      ? p === 'hiscores'
      : (p?.id === 'hiscores' && p.open !== false);
    if (opened) {
      const h = selfHiddenFromState(api);
      if (h !== null && !ui.privacyPending) ui.hidden = h;
      if (!ui.compareA) ui.compareA = selfNameFromApi(api);
      ensureActiveTabLoaded();
    }
  });

  // ---------------------------------------------------------------- shared UI pieces
  function stopKey(e) {
    e?.stopPropagation?.();
  }

  function renderTabs() {
    const tabs = [
      { id: 'board', label: 'Rankings' },
      { id: 'player', label: 'Adventurer' },
      { id: 'compare', label: 'Compare' },
      { id: 'orders', label: 'Player Orders' },
    ];
    return el('div', { class: 'hs-tabs', role: 'tablist', 'aria-label': 'Chronicles sections' },
      tabs.map((t) => el('button', {
        type: 'button',
        role: 'tab',
        class: `btn btn-small hs-tab${ui.tab === t.id ? ' is-active' : ''}`,
        'aria-selected': ui.tab === t.id ? 'true' : 'false',
        'data-tab': t.id,
        onclick: () => {
          ui.tab = t.id;
          ensureActiveTabLoaded();
          rerender();
        },
      }, t.label)),
    );
  }

  function renderPagination(page, totalPages, total, noun, onPage) {
    return el('div', { class: 'hs-pagination' },
      el('button', {
        type: 'button',
        class: 'btn btn-small hs-page-prev',
        disabled: page <= 1,
        onclick: () => { if (page > 1) onPage(page - 1); },
      }, 'Prev'),
      el('span', {
        class: 'hs-page-info',
        text: `Page ${page} of ${totalPages} (${formatNumber(total)} ${noun})`,
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-small hs-page-next',
        disabled: page >= totalPages,
        onclick: () => { if (page < totalPages) onPage(page + 1); },
      }, 'Next'),
    );
  }

  // ---------------------------------------------------------------- Tab 1: Rankings (board)
  function renderBoardSelector() {
    const makeOpt = (value, label) => el('option', { value, selected: ui.board === value, text: label });

    const groups = [
      el('optgroup', { label: 'Core Chronicles' }, CORE_BOARDS.map((b) => makeOpt(b.id, b.label))),
      el('optgroup', { label: 'Classic Guilds' }, GUILD_BOARDS.map((b) => makeOpt(b.id, b.label))),
      ...SKILL_CATEGORY_ORDER.map((cat) =>
        el('optgroup', { label: `Skills — ${cat}` },
          (SKILL_CATEGORIES[cat] ?? []).map((skill) => makeOpt(skillBoardId(skill), skill)))),
    ];

    return el('label', { class: 'hs-board-picker' },
      el('span', { class: 'hs-label', text: 'Chronicle' }),
      el('select', {
        class: 'hs-select hs-board-select',
        'aria-label': 'Select chronicle board',
        value: ui.board,
        onchange: (e) => {
          ui.board = e.target.value;
          fetchBoard({ resetPage: true });
        },
      }, groups),
    );
  }

  function formatScoreCell(boardId, entry) {
    const rawScore = entry.score ?? entry.value ?? 0;
    const isWanted = boardId === 'wanted';
    const primary = boardId === 'cartography'
      ? `${formatNumber(rawScore)} / ${formatNumber(entry.total ?? CARTOGRAPHY_TOTAL)}`
      : formatNumber(rawScore);

    const secondaryParts = [];
    if (entry.secondary) secondaryParts.push(String(entry.secondary));
    else if (entry.rankTitle) secondaryParts.push(String(entry.rankTitle));
    else if (boardId === 'overall' && entry.level != null) secondaryParts.push(`Lv. ${formatNumber(entry.level)}`);
    else if (boardId === 'level' && entry.totalSkill != null) secondaryParts.push(`Skill ${formatNumber(entry.totalSkill)}`);

    return el('td', { class: 'hs-score' },
      el('span', { class: 'hs-score-val', text: primary }),
      isWanted
        ? el('span', { class: 'hs-badge hs-badge-wanted', text: entry.bountyLabel ?? 'Wanted' })
        : null,
      secondaryParts.length
        ? el('span', { class: 'hs-badge', text: secondaryParts.join(' · ') })
        : null,
    );
  }

  function renderBoardTab() {
    const classOpts = [
      el('option', { value: '', selected: ui.boardClass === '', text: 'All Classes' }),
      ...CLASSES.map((c) => el('option', { value: c.name, selected: ui.boardClass === c.name, text: c.name })),
    ];
    const raceOpts = [
      el('option', { value: '', selected: ui.boardRace === '', text: 'All Races' }),
      ...RACES.map((r) => el('option', { value: r.name, selected: ui.boardRace === r.name, text: r.name })),
    ];

    const controls = el('div', { class: 'hs-controls' },
      renderBoardSelector(),
      el('form', {
        class: 'hs-filters',
        onsubmit: (e) => {
          e?.preventDefault?.();
          fetchBoard({ resetPage: true });
        },
      },
      el('input', {
        type: 'search',
        class: 'hs-input hs-search',
        placeholder: 'Search adventurer…',
        'aria-label': 'Search adventurer name',
        value: ui.boardSearch,
        oninput: (e) => { ui.boardSearch = e.target.value; },
        onkeydown: (e) => {
          stopKey(e);
          if (e.key === 'Enter') {
            e.preventDefault?.();
            fetchBoard({ resetPage: true });
          }
        },
      }),
      el('select', {
        class: 'hs-select hs-filter-class',
        'aria-label': 'Filter by class',
        value: ui.boardClass,
        onchange: (e) => {
          ui.boardClass = e.target.value;
          fetchBoard({ resetPage: true });
        },
      }, classOpts),
      el('select', {
        class: 'hs-select hs-filter-race',
        'aria-label': 'Filter by race',
        value: ui.boardRace,
        onchange: (e) => {
          ui.boardRace = e.target.value;
          fetchBoard({ resetPage: true });
        },
      }, raceOpts),
      el('button', {
        type: 'button',
        class: 'btn btn-small hs-refresh',
        onclick: () => fetchBoard(),
      }, 'Refresh')),
    );

    const data = ui.boardData;
    let content;
    if (ui.loading.board && !data) {
      content = el('p', { class: 'hs-note', text: `Loading ${boardLabel(ui.board)} rankings…` });
    } else if (!data || !data.entries.length) {
      content = el('p', { class: 'hs-note', text: `No adventurers ranked on ${boardLabel(ui.board)} yet.` });
    } else {
      const table = el('table', { class: 'hs-table' },
        el('thead', {},
          el('tr', {},
            el('th', { scope: 'col', text: 'Rank' }),
            el('th', { scope: 'col', text: 'Adventurer' }),
            el('th', { scope: 'col', text: 'Class & Race' }),
            el('th', { scope: 'col', text: 'Score' }),
          )),
        el('tbody', {}, data.entries.map((entry) => {
          const self = isSelfEntry(entry);
          const rCls = rankClass(entry.rank);
          const tag = entry.orderTag ?? entry.order?.tag ?? '';
          const classRace = [entry.className ?? entry.class, entry.race].filter(Boolean).join(' · ') || '—';
          return el('tr', { class: `hs-row${self ? ' hs-row-self' : ''}` },
            el('td', { class: `hs-rank${rCls ? ` ${rCls}` : ''}`, text: formatRank(entry.rank) }),
            el('td', { class: 'hs-player-cell' },
              el('button', {
                type: 'button',
                class: 'hs-player-btn',
                onclick: () => openPlayerProfile(entry.name),
              }, entry.name),
              tag ? el('span', { class: 'hs-order-tag', text: `[${tag}]` }) : null,
              self ? el('span', { class: 'hs-badge', text: 'You' }) : null,
            ),
            el('td', { class: 'hs-meta-cell', text: classRace }),
            formatScoreCell(data.board ?? ui.board, entry),
          );
        })),
      );
      content = el('div', { class: 'hs-table-wrap' },
        table,
        renderPagination(data.page, data.totalPages, data.total, 'ranked', (p) => {
          ui.boardPage = p;
          fetchBoard();
        }),
      );
    }

    return el('div', { class: 'hs-stack' }, controls, content);
  }

  // ---------------------------------------------------------------- Tab 2: Adventurer (player)
  function renderPlayerTab() {
    const selfName = selfNameFromApi(api);
    const searchBar = el('form', {
      class: 'hs-filters hs-player-form',
      onsubmit: (e) => {
        e?.preventDefault?.();
        fetchPlayer(ui.playerQuery);
      },
    },
    el('input', {
      type: 'search',
      class: 'hs-input hs-player-search',
      placeholder: 'Adventurer name…',
      'aria-label': 'Look up adventurer',
      value: ui.playerQuery,
      oninput: (e) => { ui.playerQuery = e.target.value; },
      onkeydown: (e) => {
        stopKey(e);
        if (e.key === 'Enter') {
          e.preventDefault?.();
          fetchPlayer(ui.playerQuery);
        }
      },
    }),
    el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Lookup'),
    el('button', {
      type: 'button',
      class: 'btn btn-small hs-my-chronicles',
      onclick: () => {
        const me = selfNameFromApi(api);
        if (!me) {
          say('Sign in with a character to view your Chronicles.');
          rerender();
          return;
        }
        fetchPlayer(me);
      },
    }, 'My Chronicles'),
    );

    const p = ui.playerData;
    if (ui.loading.player && !p) {
      return el('div', { class: 'hs-stack' },
        searchBar,
        el('p', { class: 'hs-note', text: `Searching the Chronicles for ${ui.playerQuery}…` }));
    }
    if (ui.playerError && !p) {
      return el('div', { class: 'hs-stack' },
        searchBar,
        el('p', { class: 'hs-note', text: ui.playerError }));
    }
    if (!p) {
      return el('div', { class: 'hs-stack' },
        searchBar,
        el('p', { class: 'hs-note', text: 'Search for an adventurer or select "My Chronicles" to inspect their full record.' }));
    }

    const viewingSelf = isSelfEntry(p) || (selfName && p.name && p.name.toLowerCase() === selfName.toLowerCase());
    const orderTag = p.orderTag ?? p.order?.tag ?? '';
    const totalSkill = p.totalSkill ?? p.core?.overall?.score
      ?? SKILLS.reduce((sum, s) => sum + normalizeSkillEntry(p.skills, s).level, 0);
    const level = p.level ?? p.core?.level?.score ?? 1;

    const head = el('section', { class: 'hs-profile-head' },
      el('div', { class: 'hs-profile-title' },
        el('h3', { class: 'hs-h', text: p.name }),
        orderTag ? el('span', { class: 'hs-order-tag', text: `[${orderTag}]` }) : null,
        el('p', {
          class: 'hs-meta',
          text: `${p.className ?? p.class ?? 'Adventurer'} · ${p.race ?? 'Unknown'} · Lv. ${formatNumber(level)} · Total Skill ${formatNumber(totalSkill)}`,
        }),
      ),
      !viewingSelf
        ? el('button', {
          type: 'button',
          class: 'btn btn-small btn-primary hs-compare-me-btn',
          onclick: () => openCompareWith(p.name),
        }, 'Compare with Me')
        : null,
    );

    const core = p.core ?? {};
    const statCard = (label, value, rank, extraClass = '') =>
      el('article', { class: `hs-stat-card${extraClass ? ` ${extraClass}` : ''}` },
        el('span', { class: 'hs-label', text: label }),
        el('strong', { class: 'hs-stat-val', text: value }),
        el('span', { class: `hs-stat-rank ${rankClass(rank)}`.trim(), text: formatRank(rank) }),
      );

    const cartoScore = core.cartography?.score ?? p.cartography ?? 0;
    const cartoTotal = core.cartography?.total ?? CARTOGRAPHY_TOTAL;
    const wantedScore = core.wanted?.score ?? p.infamy ?? 0;
    const admiraltyVal = core.admiralty?.title ?? core.admiralty?.rankTitle ?? formatNumber(core.admiralty?.score ?? p.admiraltyScore ?? 0);

    const summaryGrid = el('section', { class: 'hs-summary-grid' },
      statCard('Overall Rank', formatNumber(totalSkill), core.overall?.rank ?? p.overallRank),
      statCard('Level Rank', `Lv. ${formatNumber(level)}`, core.level?.rank ?? p.levelRank),
      statCard('Cartography', `${formatNumber(cartoScore)} / ${formatNumber(cartoTotal)}`, core.cartography?.rank),
      statCard('Quests', formatNumber(core.quests?.score ?? p.questsCompleted ?? 0), core.quests?.rank),
      statCard('Slayer', formatNumber(core.slayer?.score ?? p.monstersSlain ?? 0), core.slayer?.rank),
      statCard('Most Wanted', formatNumber(wantedScore), core.wanted?.rank, wantedScore > 0 ? 'hs-badge-wanted' : ''),
      statCard('Admiralty', String(admiraltyVal), core.admiralty?.rank),
    );

    // Classic Guild Standing
    const guildMap = p.guilds ?? {};
    const guildSection = el('section', { class: 'hs-card hs-guilds-section' },
      el('h4', { class: 'hs-h', text: 'Classic Guild Standing' }),
      el('ul', { class: 'hs-guild-list' }, GUILD_BOARDS.map((g) => {
        const entry = guildMap[g.group] ?? guildMap[g.id] ?? null;
        const title = entry?.rankTitle ?? (entry?.rank != null ? `Rank ${entry.rank}` : 'Unaffiliated');
        const boardRank = entry?.boardRank ?? entry?.leaderboardRank ?? null;
        return el('li', { class: 'hs-guild-row' },
          el('button', {
            type: 'button',
            class: 'hs-link-btn',
            onclick: () => openSkillBoard(g.id),
          }, g.label),
          el('span', { class: 'hs-badge', text: title }),
          el('span', { class: `hs-rank ${rankClass(boardRank)}`.trim(), text: formatRank(boardRank) }),
        );
      })),
    );

    // 35-Skill OSRS Grid grouped by category
    const skillGroups = el('section', { class: 'hs-skill-groups' },
      SKILL_CATEGORY_ORDER.map((cat) => {
        const skills = SKILL_CATEGORIES[cat] ?? [];
        return el('div', { class: 'hs-skill-group' },
          el('h4', { class: 'hs-label hs-skill-cat', text: cat }),
          el('div', { class: 'hs-skill-grid' }, skills.map((skill) => {
            const info = normalizeSkillEntry(p.skills, skill);
            const pct = skillPercent(info.level);
            const maxed = info.level >= MAX_SKILL;
            const fill = el('span', { class: 'hs-skill-fill', style: `width: ${pct}%` });
            return el('button', {
              type: 'button',
              class: `hs-skill-cell${maxed ? ' hs-skill-max' : ''}`,
              'data-skill': skill,
              title: `View ${skill} leaderboard`,
              onclick: () => openSkillBoard(skillBoardId(skill)),
            },
            el('div', { class: 'hs-skill-top' },
              el('span', { class: 'hs-skill-name', text: skill }),
              el('span', { class: 'hs-skill-val', text: String(info.level) }),
            ),
            el('div', { class: 'hs-skill-bar' }, fill),
            el('div', { class: 'hs-skill-foot' },
              el('span', { class: `hs-skill-rank ${rankClass(info.rank)}`.trim(), text: formatRank(info.rank) }),
            ));
          })),
        );
      }),
    );

    return el('div', { class: 'hs-stack' }, searchBar, head, summaryGrid, guildSection, skillGroups);
  }

  // ---------------------------------------------------------------- Tab 3: Compare (compare)
  function renderCompareTab() {
    if (!ui.compareA) ui.compareA = selfNameFromApi(api);

    const form = el('form', {
      class: 'hs-filters hs-compare-form',
      onsubmit: (e) => {
        e?.preventDefault?.();
        fetchCompare();
      },
    },
    el('input', {
      type: 'search',
      class: 'hs-input hs-compare-a',
      placeholder: 'Adventurer A',
      'aria-label': 'Adventurer A',
      value: ui.compareA,
      oninput: (e) => { ui.compareA = e.target.value; },
      onkeydown: (e) => {
        stopKey(e);
        if (e.key === 'Enter') {
          e.preventDefault?.();
          fetchCompare();
        }
      },
    }),
    el('input', {
      type: 'search',
      class: 'hs-input hs-compare-b',
      placeholder: 'Adventurer B',
      'aria-label': 'Adventurer B',
      value: ui.compareB,
      oninput: (e) => { ui.compareB = e.target.value; },
      onkeydown: (e) => {
        stopKey(e);
        if (e.key === 'Enter') {
          e.preventDefault?.();
          fetchCompare();
        }
      },
    }),
    el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Compare'),
    );

    const cmp = ui.compareData;
    if (ui.loading.compare && !cmp) {
      return el('div', { class: 'hs-stack' },
        form,
        el('p', { class: 'hs-note', text: `Comparing ${ui.compareA} and ${ui.compareB}…` }));
    }
    if (ui.compareError && !cmp) {
      return el('div', { class: 'hs-stack' },
        form,
        el('p', { class: 'hs-note', text: ui.compareError }));
    }
    if (!cmp) {
      return el('div', { class: 'hs-stack' },
        form,
        el('p', { class: 'hs-note', text: 'Enter two adventurers to compare their Core Chronicles and all 35 classic skills.' }));
    }

    const nameA = cmp.left?.name ?? ui.compareA;
    const nameB = cmp.right?.name ?? ui.compareB;
    const banner = el('div', {
      class: 'hs-compare-banner',
      text: formatCompareBanner(nameA, nameB, cmp.summary),
    });

    const table = el('table', { class: 'hs-table hs-compare-table' },
      el('thead', {},
        el('tr', {},
          el('th', { scope: 'col', text: 'Chronicle / Skill' }),
          el('th', { scope: 'col', text: nameA }),
          el('th', { scope: 'col', text: 'Delta' }),
          el('th', { scope: 'col', text: nameB }),
        )),
      el('tbody', {}, cmp.rows.map((row) =>
        el('tr', { class: 'hs-row' },
          el('td', { text: row.label }),
          el('td', { text: formatNumber(row.a) }),
          el('td', { class: deltaClass(row.delta), text: formatDelta(row.delta) }),
          el('td', { text: formatNumber(row.b) }),
        ))),
    );

    return el('div', { class: 'hs-stack' }, form, banner, el('div', { class: 'hs-table-wrap' }, table));
  }

  // ---------------------------------------------------------------- Tab 4: Player Orders (orders)
  function renderOrdersTab() {
    const controls = el('div', { class: 'hs-controls' },
      el('div', { class: 'hs-sort-group', role: 'group', 'aria-label': 'Sort player orders' },
        ORDER_SORTS.map((s) => el('button', {
          type: 'button',
          class: `btn btn-small hs-sort-btn${ui.ordersSort === s.id ? ' is-active' : ''}`,
          'aria-pressed': ui.ordersSort === s.id ? 'true' : 'false',
          'data-sort': s.id,
          onclick: () => {
            ui.ordersSort = s.id;
            fetchOrders({ resetPage: true });
          },
        }, s.label))),
      el('form', {
        class: 'hs-filters',
        onsubmit: (e) => {
          e?.preventDefault?.();
          fetchOrders({ resetPage: true });
        },
      },
      el('input', {
        type: 'search',
        class: 'hs-input hs-orders-search',
        placeholder: 'Search orders…',
        'aria-label': 'Search player orders',
        value: ui.ordersSearch,
        oninput: (e) => { ui.ordersSearch = e.target.value; },
        onkeydown: (e) => {
          stopKey(e);
          if (e.key === 'Enter') {
            e.preventDefault?.();
            fetchOrders({ resetPage: true });
          }
        },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn-small hs-refresh',
        onclick: () => fetchOrders(),
      }, 'Refresh')),
    );

    const data = ui.ordersData;
    let content;
    if (ui.loading.orders && !data) {
      content = el('p', { class: 'hs-note', text: 'Loading Player Orders…' });
    } else if (!data || !data.entries.length) {
      content = el('p', { class: 'hs-note', text: 'No Player Orders founded yet.' });
    } else {
      const table = el('table', { class: 'hs-table hs-orders-table' },
        el('thead', {},
          el('tr', {},
            el('th', { scope: 'col', text: 'Rank' }),
            el('th', { scope: 'col', text: 'Order' }),
            el('th', { scope: 'col', text: 'Leader' }),
            el('th', { scope: 'col', text: 'Members' }),
            el('th', { scope: 'col', text: 'Combined Lv.' }),
            el('th', { scope: 'col', text: 'Treasury' }),
          )),
        el('tbody', {}, data.entries.map((ord) => {
          const rCls = rankClass(ord.rank);
          const tag = ord.tag ? `[${ord.tag}]` : '';
          return el('tr', { class: 'hs-row' },
            el('td', { class: `hs-rank${rCls ? ` ${rCls}` : ''}`, text: formatRank(ord.rank) }),
            el('td', { class: 'hs-order-cell' },
              tag ? el('span', { class: 'hs-order-tag', text: tag }) : null,
              tag ? ' ' : null,
              el('span', { class: 'hs-order-name', text: ord.name ?? 'Unnamed Order' }),
            ),
            el('td', {},
              ord.leaderName
                ? el('button', {
                  type: 'button',
                  class: 'hs-player-btn',
                  onclick: () => openPlayerProfile(ord.leaderName),
                }, ord.leaderName)
                : '—'),
            el('td', { text: formatNumber(ord.memberCount ?? ord.members ?? 0) }),
            el('td', { text: formatNumber(ord.combinedLevel ?? 0) }),
            el('td', { text: `${formatNumber(ord.treasury ?? 0)}g` }),
          );
        })),
      );
      content = el('div', { class: 'hs-table-wrap' },
        table,
        renderPagination(data.page, data.totalPages, data.total, 'orders', (p) => {
          ui.ordersPage = p;
          fetchOrders();
        }),
      );
    }

    return el('div', { class: 'hs-stack' }, controls, content);
  }

  // ---------------------------------------------------------------- Footer: Privacy Toggle
  function renderPrivacyBar() {
    const listed = !ui.hidden;
    return el('footer', { class: 'hs-privacy-bar' },
      el('label', { class: 'hs-privacy-label' },
        el('input', {
          type: 'checkbox',
          class: 'hs-privacy-toggle',
          checked: listed,
          onchange: (e) => togglePrivacy(Boolean(e.target.checked)),
        }),
        el('span', { text: 'List my character in public Chronicles' }),
      ),
    );
  }

  // ---------------------------------------------------------------- Root Render
  function render(root) {
    container = root;
    root.classList?.add?.('hs-root');
    const body = [
      renderTabs(),
      el('p', { class: 'hs-live', role: 'status', 'aria-live': 'polite', text: ui.status }),
    ];
    if (ui.tab === 'board') body.push(renderBoardTab());
    else if (ui.tab === 'player') body.push(renderPlayerTab());
    else if (ui.tab === 'compare') body.push(renderCompareTab());
    else body.push(renderOrdersTab());
    body.push(renderPrivacyBar());
    root.replaceChildren(...body.filter(Boolean));
  }

  api.registerPanel('hiscores', 'Chronicles', render);
  return { ui, render, fetchBoard, fetchPlayer, fetchCompare, fetchOrders };
}

export default install;
