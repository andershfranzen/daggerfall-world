// Chronicles of the Iliac Bay (Hiscores) RPG feature.
//
// Owns per-character persistent progression & privacy metadata in `p.rpg.chronicles`,
// automatic gameplay hooks (kills, quests, dungeon visits, skill/level milestone timestamps),
// and rate-limited `chronicles.*` actions backed by `ctx.services.hiscores`.

import { tokenBucket } from './social/chat.js';

export const name = 'chronicles';

export const CHRONICLES_VERSION = 1;
export const MAX_SEEN_DUNGEONS = 256;
export const MILESTONE_TICK_MS = 5_000;
export const CHRONICLES_RATE_PER_SEC = 2;
export const CHRONICLES_BURST = 10;

const MAX_PARAM_TEXT = 64;
const MAX_PAGE = 10_000;
const MAX_LIMIT = 100;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanText(raw, maxLen = MAX_PARAM_TEXT) {
  return String(raw ?? '').normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toNonNegInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function toNonNegNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function skillNumericValue(raw) {
  const v = typeof raw === 'number' ? raw : isObj(raw) ? raw.value : NaN;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function countCompletedQuests(done) {
  if (!Array.isArray(done)) return 0;
  let count = 0;
  for (const entry of done) {
    if (!entry || typeof entry !== 'object') {
      count += 1;
      continue;
    }
    if (entry.result === undefined || entry.result === 'success' || entry.result === 'completed') {
      count += 1;
    }
  }
  return count;
}

function safeErrorMessage(err) {
  if (err instanceof Error && (err.constructor === Error || err.expose === true) && typeof err.message === 'string') {
    const msg = cleanText(err.message, 200);
    if (msg) return msg;
  }
  return 'Could not read the Chronicles right now.';
}

/**
 * Reconciles `p.rpg.chronicles.skillSnapshot` / `skillMilestones` / `lastLevel` / `levelMilestoneAt`
 * against `p.rpg.character`. Never resets an existing milestone timestamp when a skill or level is
 * unchanged, preserving first-to-100 timestamps.
 *
 * Returns `true` when any chronicle milestone or snapshot field changed.
 */
export function syncMilestones(p, now = Date.now()) {
  if (!p || typeof p !== 'object') return false;
  const c = p.rpg?.chronicles;
  if (!isObj(c)) return false;

  const ch = isObj(p.rpg?.character) ? p.rpg.character : null;
  if (!ch) return false;

  const ts = toNonNegNum(now, Date.now());
  let changed = false;

  if (isObj(ch.skills)) {
    for (const [skill, rawVal] of Object.entries(ch.skills)) {
      const val = skillNumericValue(rawVal);
      if (val === null) continue;
      const hasPrev = Object.hasOwn(c.skillSnapshot, skill) && Number.isFinite(c.skillSnapshot[skill]);
      const prev = hasPrev ? c.skillSnapshot[skill] : null;
      if (!hasPrev) {
        c.skillSnapshot[skill] = val;
        if (!Number.isFinite(c.skillMilestones[skill]) || c.skillMilestones[skill] <= 0) {
          c.skillMilestones[skill] = ts;
        }
        changed = true;
      } else if (val > prev) {
        c.skillSnapshot[skill] = val;
        c.skillMilestones[skill] = ts;
        changed = true;
      } else if (val < prev) {
        c.skillSnapshot[skill] = val;
        changed = true;
      }
    }
  }

  if (Number.isFinite(Number(ch.level))) {
    const level = Math.max(1, Math.trunc(Number(ch.level)));
    if (level > c.lastLevel) {
      c.lastLevel = level;
      c.levelMilestoneAt = ts;
      changed = true;
    } else if (c.levelMilestoneAt <= 0) {
      c.lastLevel = Math.max(c.lastLevel, level);
      c.levelMilestoneAt = ts;
      changed = true;
    }
  }

  if (changed) c.updatedAt = ts;
  return changed;
}

/**
 * Initializes and normalizes `p.rpg.chronicles`, backfills `questsCompleted` from `p.rpg.quests?.done`
 * when higher, and reconciles skill/level milestones.
 */
export function ensureChronicles(p, now = Date.now(), { backfillQuests = true } = {}) {
  if (!p || typeof p !== 'object') return null;
  if (!isObj(p.rpg)) p.rpg = {};

  const raw = isObj(p.rpg.chronicles) ? p.rpg.chronicles : {};
  const seenDungeons = [];
  const seenSet = new Set();
  if (Array.isArray(raw.seenDungeons)) {
    for (const id of raw.seenDungeons) {
      if (typeof id !== 'string' || !id || seenSet.has(id)) continue;
      seenSet.add(id);
      seenDungeons.push(id);
      if (seenDungeons.length >= MAX_SEEN_DUNGEONS) break;
    }
  }

  const skillMilestones = {};
  if (isObj(raw.skillMilestones)) {
    for (const [k, v] of Object.entries(raw.skillMilestones)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) skillMilestones[k] = n;
    }
  }

  const skillSnapshot = {};
  if (isObj(raw.skillSnapshot)) {
    for (const [k, v] of Object.entries(raw.skillSnapshot)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 0) skillSnapshot[k] = n;
    }
  }

  const c = {
    v: CHRONICLES_VERSION,
    hidden: Boolean(raw.hidden),
    monstersSlain: toNonNegInt(raw.monstersSlain, 0),
    questsCompleted: toNonNegInt(raw.questsCompleted, 0),
    dungeonsVisited: Math.max(toNonNegInt(raw.dungeonsVisited, 0), seenDungeons.length),
    seenDungeons,
    skillMilestones,
    skillSnapshot,
    levelMilestoneAt: toNonNegNum(raw.levelMilestoneAt, 0),
    lastLevel: Math.max(1, toNonNegInt(raw.lastLevel, 1)),
    updatedAt: toNonNegNum(raw.updatedAt, 0),
  };

  p.rpg.chronicles = c;

  if (backfillQuests) {
    const doneCount = countCompletedQuests(p.rpg.quests?.done);
    if (doneCount > c.questsCompleted) c.questsCompleted = doneCount;
  }

  syncMilestones(p, now);
  return c;
}

function parseOptionalPositiveInt(raw, label, max) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${label}.`);
  return Math.min(max, n);
}

function parseOptionalString(raw, maxLen = MAX_PARAM_TEXT) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('Invalid query parameter.');
  const s = cleanText(raw, maxLen);
  return s || undefined;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const monoNow = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const epochNow = typeof options.epochNow === 'function' ? options.epochNow : () => Date.now();
  const milestoneTickMs = Number.isFinite(options.milestoneTickMs) && options.milestoneTickMs >= 0
    ? options.milestoneTickMs
    : MILESTONE_TICK_MS;
  const ratePerSec = Number.isFinite(options.ratePerSec) && options.ratePerSec > 0
    ? options.ratePerSec
    : CHRONICLES_RATE_PER_SEC;
  const burst = Number.isFinite(options.burst) && options.burst >= 1
    ? options.burst
    : CHRONICLES_BURST;

  const limits = new WeakMap();
  let lastMilestoneCheckMs = monoNow();

  function limiter(p) {
    let check = limits.get(p);
    if (!check) {
      check = tokenBucket(ratePerSec, burst, monoNow);
      limits.set(p, check);
    }
    return check;
  }

  function enforceRateLimit(p) {
    if (!limiter(p)()) throw new Error('Slow down a little before consulting the Chronicles again.');
  }

  function isPlayerOnline(p) {
    if (!p) return false;
    if (!ctx.players || typeof ctx.players.get !== 'function') return true;
    return ctx.players.get(p.id) === p;
  }

  function hiscoresService() {
    const svc = ctx.services?.hiscores;
    if (!svc || typeof svc !== 'object') {
      throw new Error('The Chronicles of the Iliac Bay are currently unavailable.');
    }
    return svc;
  }

  function safeSyncPlayer(player) {
    const fn = ctx.services?.hiscores?.syncPlayer;
    if (typeof fn !== 'function') return;
    try {
      const res = fn.call(ctx.services.hiscores, player);
      if (res && typeof res.then === 'function') {
        res.catch((err) => ctx.log?.warn?.('[chronicles] hiscores.syncPlayer failed:', err));
      }
    } catch (err) {
      ctx.log?.warn?.('[chronicles] hiscores.syncPlayer failed:', err);
    }
  }

  function safeInvalidate() {
    const fn = ctx.services?.hiscores?.invalidate;
    if (typeof fn !== 'function') return;
    try {
      const res = fn.call(ctx.services.hiscores);
      if (res && typeof res.then === 'function') {
        res.catch((err) => ctx.log?.warn?.('[chronicles] hiscores.invalidate failed:', err));
      }
    } catch (err) {
      ctx.log?.warn?.('[chronicles] hiscores.invalidate failed:', err);
    }
  }

  function runAfterCommit(fn) {
    if (typeof ctx.afterCommit === 'function') ctx.afterCommit(fn);
    else fn();
  }

  function reconcileForAction(p) {
    const hadChronicles = isObj(p?.rpg?.chronicles);
    const prevUpdatedAt = hadChronicles ? p.rpg.chronicles.updatedAt : -1;
    const c = ensureChronicles(p, epochNow());
    if (!hadChronicles || (c && c.updatedAt !== prevUpdatedAt)) {
      ctx.dirty?.(p);
    }
    return c;
  }

  /**
   * Executes a hiscores service call that may return a value synchronously or a Promise.
   * Delivers `{ kind: 'chronicles', ... }` when resolved, guarding that `p` is still online.
   */
  function dispatchQuery(p, view, invoke, formatPayload) {
    let result;
    try {
      result = invoke();
    } catch (err) {
      throw new Error(safeErrorMessage(err));
    }

    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(
        (value) => {
          if (!isPlayerOnline(p)) return;
          ctx.notify(p, formatPayload(value));
        },
        (err) => {
          ctx.log?.error?.(`[chronicles] ${view} query failed:`, err);
          if (!isPlayerOnline(p)) return;
          ctx.notify(p, { kind: 'chronicles', view, error: safeErrorMessage(err) });
        },
      );
      return;
    }

    if (isPlayerOnline(p)) {
      ctx.notify(p, formatPayload(result));
    }
  }

  const registerAction = (verb, fn) => {
    if (typeof ctx.onAction === 'function') ctx.onAction(verb, fn);
    else if (typeof ctx.action === 'function') ctx.action(verb, fn);
    else throw new TypeError('ctx must provide onAction or action');
  };

  // ---------------------------------------------------------------- lifecycle & gameplay hooks

  const handleJoin = (p) => {
    ensureChronicles(p, epochNow());
  };
  if (typeof ctx.onJoin === 'function') ctx.onJoin(handleJoin);
  else ctx.on?.('join', handleJoin);

  const handleTick = (_dtSeconds, nowMs) => {
    const tNow = Number.isFinite(nowMs) ? nowMs : monoNow();
    if (tNow - lastMilestoneCheckMs < milestoneTickMs) return;
    lastMilestoneCheckMs = tNow;
    const ts = epochNow();
    for (const p of ctx.players?.values?.() ?? []) {
      if (!isObj(p?.rpg?.chronicles)) ensureChronicles(p, ts);
      if (syncMilestones(p, ts)) {
        ctx.dirty?.(p);
        safeSyncPlayer(p);
      }
    }
  };
  if (typeof ctx.onTick === 'function') ctx.onTick(handleTick);
  else ctx.on?.('tick', handleTick);

  ctx.on?.('kill', ({ player } = {}) => {
    if (!player || typeof player !== 'object') return;
    const ts = epochNow();
    const c = ensureChronicles(player, ts);
    c.monstersSlain += 1;
    c.updatedAt = ts;
    ctx.dirty?.(player);
    safeSyncPlayer(player);
  });

  ctx.on?.('questComplete', ({ player } = {}) => {
    if (!player || typeof player !== 'object') return;
    const ts = epochNow();
    const c = ensureChronicles(player, ts, { backfillQuests: false });
    c.questsCompleted = Math.max(c.questsCompleted + 1, countCompletedQuests(player.rpg?.quests?.done));
    c.updatedAt = ts;
    ctx.dirty?.(player);
    safeSyncPlayer(player);
  });

  ctx.on?.('locationChanged', ({ player, to } = {}) => {
    if (!player || typeof player !== 'object') return;
    if (typeof to !== 'string' || !to.startsWith('dungeon:')) return;
    const ts = epochNow();
    const c = ensureChronicles(player, ts);
    if (c.seenDungeons.includes(to)) return;
    if (c.seenDungeons.length >= MAX_SEEN_DUNGEONS) return;
    c.seenDungeons.push(to);
    c.dungeonsVisited += 1;
    c.updatedAt = ts;
    ctx.dirty?.(player);
    safeSyncPlayer(player);
  });

  // ---------------------------------------------------------------- actions

  registerAction('chronicles.categories', (p) => {
    enforceRateLimit(p);
    const c = reconcileForAction(p);
    const svc = hiscoresService();
    if (typeof svc.getCategories !== 'function') {
      throw new Error('The Chronicles categories are currently unavailable.');
    }
    dispatchQuery(
      p,
      'categories',
      () => svc.getCategories(),
      (categories) => ({
        kind: 'chronicles',
        view: 'categories',
        categories,
        selfPrivacy: { hidden: !!c.hidden },
      }),
    );
  });

  registerAction('chronicles.board', (p, args = {}) => {
    enforceRateLimit(p);
    const c = reconcileForAction(p);
    const svc = hiscoresService();
    if (typeof svc.getBoard !== 'function') {
      throw new Error('The Chronicles leaderboards are currently unavailable.');
    }

    const params = {};
    const board = parseOptionalString(args.board, MAX_PARAM_TEXT);
    const page = parseOptionalPositiveInt(args.page, 'page', MAX_PAGE);
    const limit = parseOptionalPositiveInt(args.limit, 'limit', MAX_LIMIT);
    const className = parseOptionalString(args.className, MAX_PARAM_TEXT);
    const race = parseOptionalString(args.race, MAX_PARAM_TEXT);
    const query = parseOptionalString(args.query, MAX_PARAM_TEXT);
    if (board !== undefined) params.board = board;
    if (page !== undefined) params.page = page;
    if (limit !== undefined) params.limit = limit;
    if (className !== undefined) params.className = className;
    if (race !== undefined) params.race = race;
    if (query !== undefined) params.query = query;

    dispatchQuery(
      p,
      'board',
      () => svc.getBoard(params),
      (data) => ({
        kind: 'chronicles',
        view: 'board',
        data,
        selfName: p.name,
        selfPrivacy: { hidden: !!c.hidden },
      }),
    );
  });

  registerAction('chronicles.orders', (p, args = {}) => {
    enforceRateLimit(p);
    reconcileForAction(p);
    const svc = hiscoresService();
    if (typeof svc.getOrders !== 'function') {
      throw new Error('The Chronicles orders board is currently unavailable.');
    }

    const params = {};
    const sort = parseOptionalString(args.sort, 40);
    const page = parseOptionalPositiveInt(args.page, 'page', MAX_PAGE);
    const limit = parseOptionalPositiveInt(args.limit, 'limit', MAX_LIMIT);
    const query = parseOptionalString(args.query, MAX_PARAM_TEXT);
    if (sort !== undefined) params.sort = sort;
    if (page !== undefined) params.page = page;
    if (limit !== undefined) params.limit = limit;
    if (query !== undefined) params.query = query;

    dispatchQuery(
      p,
      'orders',
      () => svc.getOrders(params),
      (data) => ({
        kind: 'chronicles',
        view: 'orders',
        data,
      }),
    );
  });

  registerAction('chronicles.player', (p, args = {}) => {
    enforceRateLimit(p);
    const c = reconcileForAction(p);
    const svc = hiscoresService();
    if (typeof svc.getPlayer !== 'function') {
      throw new Error('Chronicles character profiles are currently unavailable.');
    }

    const requested = parseOptionalString(args.name, MAX_PARAM_TEXT);
    const targetName = requested ?? cleanText(p.name, MAX_PARAM_TEXT);
    if (!targetName) throw new Error('Specify a character name.');
    const isSelf = targetName.toLowerCase() === cleanText(p.name, MAX_PARAM_TEXT).toLowerCase();

    dispatchQuery(
      p,
      'player',
      () => svc.getPlayer(targetName),
      (profile) => ({
        kind: 'chronicles',
        view: 'player',
        name: targetName,
        profile,
        isSelf,
        selfPrivacy: { hidden: !!c.hidden },
      }),
    );
  });

  registerAction('chronicles.compare', (p, args = {}) => {
    enforceRateLimit(p);
    reconcileForAction(p);
    const svc = hiscoresService();
    if (typeof svc.comparePlayers !== 'function') {
      throw new Error('Chronicles comparison is currently unavailable.');
    }

    const a = parseOptionalString(args.a, MAX_PARAM_TEXT) ?? cleanText(p.name, MAX_PARAM_TEXT);
    const b = parseOptionalString(args.b, MAX_PARAM_TEXT);
    if (!a) throw new Error('Specify the first character to compare.');
    if (!b) throw new Error('Choose a character to compare against.');

    dispatchQuery(
      p,
      'compare',
      () => svc.comparePlayers(a, b),
      (comparison) => ({
        kind: 'chronicles',
        view: 'compare',
        comparison,
      }),
    );
  });

  registerAction('chronicles.privacy', (p, args = {}) => {
    enforceRateLimit(p);
    const ts = epochNow();
    const c = ensureChronicles(p, ts);
    const hidden = !!args.hidden;
    c.hidden = hidden;
    c.updatedAt = ts;
    ctx.dirty?.(p);
    runAfterCommit(() => {
      safeSyncPlayer(p);
      safeInvalidate();
    });
    ctx.notify(p, {
      kind: 'chronicles',
      view: 'privacy',
      hidden,
      text: hidden
        ? 'Your character is now hidden from the public Chronicles.'
        : 'Your character is now listed in the public Chronicles.',
    });
  });

  const api = {
    ensure: ensureChronicles,
    syncMilestones,
    isHidden: (p) => !!p?.rpg?.chronicles?.hidden,
  };
  services.chronicles = api;
  return api;
}

export default install;
