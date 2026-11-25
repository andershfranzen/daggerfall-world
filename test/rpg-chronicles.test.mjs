import test from 'node:test';
import assert from 'node:assert/strict';

import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as chronicles from '../server/rpg/chronicles.js';
import {
  ensureChronicles,
  syncMilestones,
  MAX_SEEN_DUNGEONS,
  CHRONICLES_BURST,
} from '../server/rpg/chronicles.js';

function makePlayer(id = 1, name = 'Aldric', overrides = {}) {
  return {
    id,
    name,
    x: 0,
    z: 0,
    yaw: 0,
    moving: false,
    dirty: false,
    rpg: {
      location: 'town:Daggerfall/Gothway Garden',
      character: {
        level: 3,
        race: 'Breton',
        className: 'Spellsword',
        skills: {
          'Long Blade': 45,
          Destruction: 32,
          Dodging: 25,
        },
      },
      quests: { v: 1, active: [], done: [], oneTime: [], seq: 0, minutes: 0 },
      ...(overrides.rpg || {}),
    },
    ...overrides,
  };
}

function makeHarness({ hiscores = null, epochStart = 1_700_000_000_000, monoStart = 1_000, saveImpl = null, options = {} } = {}) {
  const players = new Map();
  const sent = [];
  const saved = [];
  let monoMs = monoStart;
  let epochMs = epochStart;

  const runtime = createRpgRuntime({
    players,
    features: [{ name: chronicles.name, install: (ctx) => chronicles.install(ctx, { epochNow: () => epochMs, ...options }) }],
    save: (list) => {
      if (saveImpl) return saveImpl(list);
      saved.push(list.map((p) => ({ id: p.id, chronicles: structuredClone(p.rpg?.chronicles) })));
    },
    send: (p, msg) => sent.push({ playerId: p.id, msg }),
    now: () => monoMs,
    services: hiscores ? { hiscores } : {},
    log: { info() {}, warn() {}, error() {} },
  });

  const addPlayer = (p) => {
    players.set(p.id, p);
    runtime.join(p);
    return p;
  };

  const eventsFor = (playerId, kind = 'chronicles') =>
    sent.filter((s) => s.playerId === playerId && s.msg?.type === 'gameEvent' && s.msg.event?.kind === kind).map((s) => s.msg.event);

  return {
    runtime,
    ctx: runtime.ctx,
    players,
    sent,
    saved,
    addPlayer,
    eventsFor,
    get monoMs() { return monoMs; },
    set monoMs(v) { monoMs = v; },
    get epochMs() { return epochMs; },
    set epochMs(v) { epochMs = v; },
  };
}

test('ensureChronicles initializes defaults, backfills questsCompleted, and preserves first-to-100 milestones', () => {
  const p = makePlayer(1, 'Aldric', {
    rpg: {
      character: {
        level: 5,
        skills: { 'Long Blade': 99, Destruction: 100 },
      },
      quests: {
        done: [
          { uid: 'q1', result: 'success' },
          { uid: 'q2', result: 'failed' },
          { uid: 'q3', result: 'success' },
        ],
      },
    },
  });

  const t1 = 1_700_000_010_000;
  const c1 = ensureChronicles(p, t1);
  assert.equal(c1.v, 1);
  assert.equal(c1.hidden, false);
  assert.equal(c1.monstersSlain, 0);
  assert.equal(c1.questsCompleted, 2);
  assert.equal(c1.dungeonsVisited, 0);
  assert.deepEqual(c1.seenDungeons, []);
  assert.equal(c1.skillSnapshot['Long Blade'], 99);
  assert.equal(c1.skillSnapshot.Destruction, 100);
  assert.equal(c1.skillMilestones['Long Blade'], t1);
  assert.equal(c1.skillMilestones.Destruction, t1);
  assert.equal(c1.lastLevel, 5);
  assert.equal(c1.levelMilestoneAt, t1);

  // Unchanged skills and level must NOT overwrite existing milestone timestamps
  const t2 = t1 + 60_000;
  assert.equal(syncMilestones(p, t2), false);
  assert.equal(p.rpg.chronicles.skillMilestones.Destruction, t1);
  assert.equal(p.rpg.chronicles.skillMilestones['Long Blade'], t1);
  assert.equal(p.rpg.chronicles.levelMilestoneAt, t1);

  // Increasing Long Blade to 100 updates only Long Blade; Destruction stays at t1
  const t3 = t2 + 60_000;
  p.rpg.character.skills['Long Blade'] = 100;
  assert.equal(syncMilestones(p, t3), true);
  assert.equal(p.rpg.chronicles.skillMilestones['Long Blade'], t3);
  assert.equal(p.rpg.chronicles.skillMilestones.Destruction, t1);
  assert.equal(p.rpg.chronicles.levelMilestoneAt, t1);

  // Re-running ensureChronicles later still preserves both first-to-100 timestamps
  const t4 = t3 + 60_000;
  ensureChronicles(p, t4);
  assert.equal(p.rpg.chronicles.skillMilestones['Long Blade'], t3);
  assert.equal(p.rpg.chronicles.skillMilestones.Destruction, t1);

  // Level increase updates levelMilestoneAt and lastLevel
  const t5 = t4 + 60_000;
  p.rpg.character.level = 6;
  assert.equal(syncMilestones(p, t5), true);
  assert.equal(p.rpg.chronicles.lastLevel, 6);
  assert.equal(p.rpg.chronicles.levelMilestoneAt, t5);
  assert.equal(p.rpg.chronicles.updatedAt, t5);
});

test('gameplay hooks track kill, questComplete, locationChanged dungeon dedup, and 5s tick milestones', () => {
  const synced = [];
  const hiscores = {
    syncPlayer: (player) => synced.push({ id: player.id, kills: player.rpg.chronicles.monstersSlain, quests: player.rpg.chronicles.questsCompleted }),
  };
  const h = makeHarness({ hiscores });
  const p = h.addPlayer(makePlayer(1, 'Bryn'));
  p.dirty = false;

  // kill event
  h.epochMs += 1_000;
  h.ctx.emit('kill', { player: p, entity: { id: 'rat-1' } });
  assert.equal(p.rpg.chronicles.monstersSlain, 1);
  assert.equal(p.rpg.chronicles.updatedAt, h.epochMs);
  assert.equal(p.dirty, true);
  assert.equal(synced.length, 1);

  // questComplete event (including when quests.done already has the completed quest pushed)
  p.dirty = false;
  h.epochMs += 1_000;
  p.rpg.quests.done.unshift({ uid: 'q-100', result: 'success' });
  h.ctx.emit('questComplete', { player: p, quest: { uid: 'q-100' } });
  assert.equal(p.rpg.chronicles.questsCompleted, 1);
  assert.equal(p.dirty, true);
  assert.equal(synced.length, 2);

  // locationChanged: ignores non-dungeons, records unique dungeons, deduplicates revisits
  p.dirty = false;
  h.ctx.emit('locationChanged', { player: p, from: 'town:Daggerfall/Gothway Garden', to: 'interior:Daggerfall/Tavern' });
  assert.equal(p.rpg.chronicles.dungeonsVisited, 0);
  assert.equal(p.dirty, false);

  h.epochMs += 1_000;
  h.ctx.emit('locationChanged', { player: p, from: 'town:Daggerfall/Gothway Garden', to: 'dungeon:Privateer Hold' });
  assert.equal(p.rpg.chronicles.dungeonsVisited, 1);
  assert.deepEqual(p.rpg.chronicles.seenDungeons, ['dungeon:Privateer Hold']);
  assert.equal(p.dirty, true);

  p.dirty = false;
  h.ctx.emit('locationChanged', { player: p, from: 'town:Daggerfall/Gothway Garden', to: 'dungeon:Privateer Hold' });
  assert.equal(p.rpg.chronicles.dungeonsVisited, 1);
  assert.equal(p.dirty, false);

  h.ctx.emit('locationChanged', { player: p, from: 'dungeon:Privateer Hold', to: 'dungeon:Shedungent' });
  assert.equal(p.rpg.chronicles.dungeonsVisited, 2);
  assert.deepEqual(p.rpg.chronicles.seenDungeons, ['dungeon:Privateer Hold', 'dungeon:Shedungent']);

  // Dungeon seen list caps at 256 unique ids
  for (let i = 0; i < MAX_SEEN_DUNGEONS + 10; i++) {
    h.ctx.emit('locationChanged', { player: p, to: `dungeon:Crypt-${i}` });
  }
  assert.equal(p.rpg.chronicles.seenDungeons.length, MAX_SEEN_DUNGEONS);
  assert.equal(p.rpg.chronicles.dungeonsVisited, MAX_SEEN_DUNGEONS);

  // Periodic tick throttled at 5s reconciles skill & level increases
  p.dirty = false;
  const syncCountBefore = synced.length;
  p.rpg.character.skills['Long Blade'] = 50;
  p.rpg.character.level = 4;

  h.monoMs += 2_000; // < 5s: throttled
  h.epochMs += 2_000;
  h.runtime.tick(2, h.monoMs);
  assert.equal(p.rpg.chronicles.skillSnapshot['Long Blade'], 45);
  assert.equal(p.dirty, false);

  h.monoMs += 3_000; // 5s total: reconciles
  h.epochMs += 3_000;
  h.runtime.tick(3, h.monoMs);
  assert.equal(p.rpg.chronicles.skillSnapshot['Long Blade'], 50);
  assert.equal(p.rpg.chronicles.skillMilestones['Long Blade'], h.epochMs);
  assert.equal(p.rpg.chronicles.lastLevel, 4);
  assert.equal(p.rpg.chronicles.levelMilestoneAt, h.epochMs);
  assert.equal(p.dirty, true);
  assert.equal(synced.length, syncCountBefore + 1);
});

test('all 6 chronicles.* actions work with sync and async hiscores service and expose ctx.services.chronicles', async () => {
  const calls = [];
  let invalidated = 0;
  let synced = 0;

  const hiscores = {
    getCategories: () => [{ id: 'overall', label: 'Overall' }, { id: 'slayer', label: 'Monsters Slain' }],
    getBoard: async (params) => {
      calls.push(['getBoard', params]);
      return { board: params.board ?? 'overall', page: params.page ?? 1, rows: [{ rank: 1, name: 'Aldric', score: 1200 }] };
    },
    getOrders: async (params) => {
      calls.push(['getOrders', params]);
      return { sort: params.sort ?? 'members', rows: [{ rank: 1, name: 'Knights of the Dragon', tag: 'KOD' }] };
    },
    getPlayer: async (nameOrId) => {
      calls.push(['getPlayer', nameOrId]);
      return { name: nameOrId, overallRank: 1, level: 3 };
    },
    comparePlayers: async (a, b) => {
      calls.push(['comparePlayers', a, b]);
      return { a: { name: a }, b: { name: b }, diffs: [] };
    },
    syncPlayer: () => { synced += 1; },
    invalidate: () => { invalidated += 1; },
  };

  const h = makeHarness({ hiscores });
  const p = h.addPlayer(makePlayer(7, 'Aldric'));

  // Exposed service API
  assert.equal(typeof h.ctx.services.chronicles.ensure, 'function');
  assert.equal(typeof h.ctx.services.chronicles.syncMilestones, 'function');
  assert.equal(h.ctx.services.chronicles.isHidden(p), false);

  // 1. chronicles.categories (sync)
  assert.deepEqual(h.runtime.act(p, 'chronicles.categories', {}), { ok: true });
  let evs = h.eventsFor(7);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].view, 'categories');
  assert.equal(evs[0].categories.length, 2);
  assert.deepEqual(evs[0].selfPrivacy, { hidden: false });

  // 2. chronicles.board (async + validation)
  assert.deepEqual(
    h.runtime.act(p, 'chronicles.board', { board: 'slayer', page: 2, limit: 25, className: 'Spellsword', race: 'Breton', query: 'Ald' }),
    { ok: true },
  );
  // Invalid page rejected
  const badPage = h.runtime.act(p, 'chronicles.board', { page: 0 });
  assert.equal(badPage.ok, false);

  // 3. chronicles.orders (async)
  assert.deepEqual(h.runtime.act(p, 'chronicles.orders', { sort: 'treasury', page: 1, limit: 10, query: 'Dragon' }), { ok: true });

  // 4. chronicles.player (default self + explicit other)
  assert.deepEqual(h.runtime.act(p, 'chronicles.player', {}), { ok: true });
  assert.deepEqual(h.runtime.act(p, 'chronicles.player', { name: 'Lyris' }), { ok: true });

  // 5. chronicles.compare (default a=p.name; missing b fails)
  assert.deepEqual(h.runtime.act(p, 'chronicles.compare', { b: 'Lyris' }), { ok: true });
  const missingB = h.runtime.act(p, 'chronicles.compare', {});
  assert.equal(missingB.ok, false);

  await new Promise((r) => setImmediate(r));

  evs = h.eventsFor(7);
  const byView = Object.fromEntries(evs.map((e, i) => [`${e.view}#${i}`, e]));
  const boardEv = evs.find((e) => e.view === 'board');
  assert.equal(boardEv.selfName, 'Aldric');
  assert.deepEqual(boardEv.selfPrivacy, { hidden: false });
  assert.equal(boardEv.data.board, 'slayer');

  const ordersEv = evs.find((e) => e.view === 'orders');
  assert.equal(ordersEv.data.rows[0].tag, 'KOD');

  const playerEvs = evs.filter((e) => e.view === 'player');
  assert.equal(playerEvs.length, 2);
  assert.equal(playerEvs[0].name, 'Aldric');
  assert.equal(playerEvs[0].isSelf, true);
  assert.equal(playerEvs[1].name, 'Lyris');
  assert.equal(playerEvs[1].isSelf, false);

  const compareEv = evs.find((e) => e.view === 'compare');
  assert.equal(compareEv.comparison.a.name, 'Aldric');
  assert.equal(compareEv.comparison.b.name, 'Lyris');
  assert.ok(byView['categories#0']);

  // 6. chronicles.privacy toggle on and off
  assert.deepEqual(h.runtime.act(p, 'chronicles.privacy', { hidden: true }), { ok: true });
  assert.equal(p.rpg.chronicles.hidden, true);
  assert.equal(h.ctx.services.chronicles.isHidden(p), true);
  assert.equal(synced, 1);
  assert.equal(invalidated, 1);
  const privOn = h.eventsFor(7).at(-1);
  assert.equal(privOn.view, 'privacy');
  assert.equal(privOn.hidden, true);
  assert.equal(privOn.text, 'Your character is now hidden from the public Chronicles.');

  assert.deepEqual(h.runtime.act(p, 'chronicles.privacy', { hidden: false }), { ok: true });
  assert.equal(p.rpg.chronicles.hidden, false);
  assert.equal(h.ctx.services.chronicles.isHidden(p), false);
  assert.equal(synced, 2);
  assert.equal(invalidated, 2);
  const privOff = h.eventsFor(7).at(-1);
  assert.equal(privOff.hidden, false);
  assert.equal(privOff.text, 'Your character is now listed in the public Chronicles.');
});

test('async disconnected-player guard prevents notify after player leaves and handles promise rejection safely', async () => {
  let resolveBoard;
  let rejectOrders;
  const hiscores = {
    getBoard: () => new Promise((resolve) => { resolveBoard = resolve; }),
    getOrders: () => new Promise((_resolve, reject) => { rejectOrders = reject; }),
  };

  const h = makeHarness({ hiscores });
  const p1 = h.addPlayer(makePlayer(1, 'Departing'));
  const p2 = h.addPlayer(makePlayer(2, 'Staying'));

  assert.deepEqual(h.runtime.act(p1, 'chronicles.board', { board: 'overall' }), { ok: true });
  assert.deepEqual(h.runtime.act(p2, 'chronicles.orders', {}), { ok: true });

  // Disconnect p1 before promise resolves
  h.players.delete(p1.id);
  resolveBoard({ board: 'overall', rows: [] });
  rejectOrders(new Error('Chronicles database temporarily busy'));

  await new Promise((r) => setImmediate(r));

  // Disconnected player must NOT receive notification
  assert.equal(h.eventsFor(p1.id).length, 0);

  // Connected player receives safe error notification
  const p2Events = h.eventsFor(p2.id);
  assert.equal(p2Events.length, 1);
  assert.equal(p2Events[0].view, 'orders');
  assert.equal(p2Events[0].error, 'Chronicles database temporarily busy');
});

test('chronicles actions enforce per-player token-bucket rate limiting and refill over time', () => {
  const hiscores = {
    getCategories: () => [{ id: 'overall', label: 'Overall' }],
  };
  const h = makeHarness({ hiscores });
  const p1 = h.addPlayer(makePlayer(1, 'FastClicker'));
  const p2 = h.addPlayer(makePlayer(2, 'OtherPlayer'));

  // Exhaust burst (10)
  for (let i = 0; i < CHRONICLES_BURST; i++) {
    assert.deepEqual(h.runtime.act(p1, 'chronicles.categories', {}), { ok: true });
  }
  // 11th call immediately is rate-limited
  const blocked = h.runtime.act(p1, 'chronicles.categories', {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /slow down/i);

  // Another player has an independent bucket
  assert.deepEqual(h.runtime.act(p2, 'chronicles.categories', {}), { ok: true });

  // After 500ms at 2/s, 1 token has refilled
  h.monoMs += 500;
  assert.deepEqual(h.runtime.act(p1, 'chronicles.categories', {}), { ok: true });
});
