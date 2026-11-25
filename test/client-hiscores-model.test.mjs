// Unit tests for the DOM-free Chronicles of the Iliac Bay (Hiscores) client model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, SKILL_CATEGORIES, CLASSES, RACES, MAX_SKILL } from '../client/gameplay/character/rules.js';
import {
  TOTAL_CLASSIC_PLACES,
  SKILL_CATEGORY_ORDER,
  DEFAULT_CATEGORIES,
  CLASS_OPTIONS,
  RACE_OPTIONS,
  skillSlug,
  formatRank,
  formatScore,
  formatRelativeTime,
  formatExplorationPercent,
  groupSkillsByCategory,
  buildHiscoresUrl,
  createHiscoresClient,
  summarizeComparison,
} from '../client/gameplay/hiscores/model.js';

test('constants, slugs, and default category catalog match Daggerfall rules', () => {
  assert.equal(TOTAL_CLASSIC_PLACES, 15251);
  assert.equal(skillSlug('Long Blade'), 'long-blade');
  assert.equal(skillSlug('Hand-to-Hand'), 'hand-to-hand');
  assert.equal(skillSlug('  Critical Strike  '), 'critical-strike');

  assert.deepEqual(
    DEFAULT_CATEGORIES.core.map((b) => b.id),
    ['overall', 'level', 'exploration', 'quests', 'slayer', 'wanted', 'admiralty'],
  );
  assert.deepEqual(
    DEFAULT_CATEGORIES.guilds.map((b) => b.id),
    ['guild:fighters', 'guild:mages', 'guild:thieves', 'guild:brotherhood', 'guild:temple', 'guild:knights'],
  );
  assert.deepEqual(Object.keys(DEFAULT_CATEGORIES.skills), SKILL_CATEGORY_ORDER);
  const allSkillBoards = Object.values(DEFAULT_CATEGORIES.skills).flat();
  assert.equal(allSkillBoards.length, 35);
  assert.equal(new Set(allSkillBoards.map((b) => b.id)).size, 35);
  for (const s of SKILLS) {
    assert.ok(allSkillBoards.some((b) => b.id === `skill:${skillSlug(s)}` && b.skill === s));
  }
  assert.deepEqual(DEFAULT_CATEGORIES.orders.map((b) => b.id), ['orders']);

  assert.deepEqual(CLASS_OPTIONS, [...CLASSES.map((c) => c.name), 'Custom']);
  assert.deepEqual(RACE_OPTIONS, RACES.map((r) => r.name));
});

test('formatRank handles positive ranks and unranked/invalid values', () => {
  assert.equal(formatRank(1), '#1');
  assert.equal(formatRank(42), '#42');
  assert.equal(formatRank(1234), '#1,234');
  assert.equal(formatRank(null), '—');
  assert.equal(formatRank(undefined), '—');
  assert.equal(formatRank(0), '—');
  assert.equal(formatRank(-3), '—');
  assert.equal(formatRank(Number.NaN), '—');
});

test('formatExplorationPercent clamps and formats to one decimal place', () => {
  assert.equal(formatExplorationPercent(0), '0.0%');
  assert.equal(formatExplorationPercent(-5), '0.0%');
  assert.equal(formatExplorationPercent(342), '2.2%');
  assert.equal(formatExplorationPercent(TOTAL_CLASSIC_PLACES), '100.0%');
  assert.equal(formatExplorationPercent(TOTAL_CLASSIC_PLACES + 500), '100.0%');
  assert.equal(formatExplorationPercent(null), '0.0%');
});

test('formatScore formats all board types cleanly', () => {
  assert.equal(formatScore('overall', 1240), '1,240 pts');
  assert.equal(formatScore('level', 14), 'Lv. 14');
  assert.equal(formatScore('exploration', 342), '342 / 15,251 (2.2%)');
  assert.equal(formatScore('quests', 18), '18 quests');
  assert.equal(formatScore('quests', 1), '1 quest');
  assert.equal(formatScore('quests', 0), '0 quests');
  assert.equal(formatScore('slayer', 412), '412 slain');
  assert.equal(formatScore('wanted', 185), '185 infamy');
  assert.equal(formatScore('admiralty', 250, { badge: 'Admiral' }), '250 (Admiral)');
  assert.equal(formatScore('admiralty', 250), '250');
  assert.equal(formatScore('guild:mages', 7, { badge: 'Archmage' }), 'Rank 7 — Archmage');
  assert.equal(formatScore('guild:fighters', 3), 'Rank 3');
  assert.equal(formatScore('skill:long-blade', 94), `94 / ${MAX_SKILL}`);
  assert.equal(formatScore('overall', null), '—');
  assert.equal(formatScore('unknown', 99), '99');
});

test('formatRelativeTime formats seconds, minutes, hours, days, and invalid inputs', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelativeTime(now - 5_000, now), 'just now');
  assert.equal(formatRelativeTime(now + 2_000, now), 'just now');
  assert.equal(formatRelativeTime(now - 3 * 60_000, now), '3m ago');
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), '2h ago');
  assert.equal(formatRelativeTime(now - 5 * 86_400_000, now), '5d ago');
  assert.equal(formatRelativeTime(null, now), '—');
  assert.equal(formatRelativeTime(0, now), '—');
  assert.equal(formatRelativeTime('not-a-date', now), '—');
});

test('groupSkillsByCategory organizes 35 skills under canonical OSRS-style categories', () => {
  const profileSkills = [
    { skill: 'Long Blade', value: 88, rank: 2 },
    { board: 'skill:hand-to-hand', score: 61, rank: 15 },
    { name: 'Destruction', value: 95, rank: 1 },
    { slug: 'lockpicking', value: 54, rank: 9 },
    { skill: 'Running', value: 72, rank: 4 },
    { skill: 'Daedric', value: 40, rank: 12 },
  ];

  const grouped = groupSkillsByCategory(profileSkills);
  assert.deepEqual(grouped.map((g) => g.category), ['Combat', 'Magic', 'Stealth', 'Body', 'Languages']);

  const totalCount = grouped.reduce((sum, g) => sum + g.skills.length, 0);
  assert.equal(totalCount, 35);

  for (const g of grouped) {
    assert.deepEqual(g.skills.map((s) => s.name), SKILL_CATEGORIES[g.category]);
  }

  const combat = grouped[0].skills;
  const longBlade = combat.find((s) => s.name === 'Long Blade');
  assert.equal(longBlade.value, 88);
  assert.equal(longBlade.rank, 2);
  assert.equal(longBlade.board, 'skill:long-blade');

  const h2h = combat.find((s) => s.name === 'Hand-to-Hand');
  assert.equal(h2h.value, 61);
  assert.equal(h2h.rank, 15);

  const magic = grouped[1].skills;
  assert.equal(magic.find((s) => s.name === 'Destruction').value, 95);
  assert.equal(magic.find((s) => s.name === 'Illusion').value, 0);
  assert.equal(magic.find((s) => s.name === 'Illusion').rank, null);

  // Also supports plain map input
  const fromMap = groupSkillsByCategory({ 'Long Blade': 77, Destruction: { value: 66, rank: 5 } });
  assert.equal(fromMap[0].skills.find((s) => s.name === 'Long Blade').value, 77);
  assert.equal(fromMap[1].skills.find((s) => s.name === 'Destruction').value, 66);
  assert.equal(fromMap[1].skills.find((s) => s.name === 'Destruction').rank, 5);
});

test('buildHiscoresUrl builds query-encoded URLs including special characters in player names', () => {
  assert.equal(buildHiscoresUrl('/api/hiscores', ''), '/api/hiscores');
  assert.equal(buildHiscoresUrl('/api/hiscores/', '/categories'), '/api/hiscores/categories');
  assert.equal(
    buildHiscoresUrl('/api/hiscores', '', { board: 'skill:hand-to-hand', page: 2, limit: 25, class: 'Spellsword', race: '', q: null }),
    '/api/hiscores?board=skill%3Ahand-to-hand&page=2&limit=25&class=Spellsword',
  );
  assert.equal(
    buildHiscoresUrl('/api/hiscores', 'orders', { sort: 'members', page: 1, q: 'Order of the Candle' }),
    '/api/hiscores/orders?sort=members&page=1&q=Order+of+the+Candle',
  );
  assert.equal(
    buildHiscoresUrl('/api/hiscores', 'player/:name', { name: "Sir Aldric O'Neil / #1 & Co." }),
    "/api/hiscores/player/Sir%20Aldric%20O'Neil%20%2F%20%231%20%26%20Co.",
  );
  assert.equal(
    buildHiscoresUrl('/api/hiscores', 'compare', { a: 'Barenziah', b: 'Lysandus & Guard' }),
    '/api/hiscores/compare?a=Barenziah&b=Lysandus+%26+Guard',
  );
});

test('createHiscoresClient handles success, 404, validation, and network errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/hiscores/categories') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ core: ['overall'] }),
      };
    }
    if (url.startsWith('/api/hiscores?')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ board: 'overall', entries: [{ name: 'Aldric', score: 1240, rank: 1 }] }),
      };
    }
    if (url.startsWith('/api/hiscores/orders')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ orders: [{ name: 'Knights of the Dragon', score: 4200 }] }),
      };
    }
    if (url === '/api/hiscores/player/Sir%20Aldric') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ name: 'Sir Aldric', level: 14 }),
      };
    }
    if (url === '/api/hiscores/player/Missing%20Hero') {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Character not found in Chronicles' }),
      };
    }
    if (url.startsWith('/api/hiscores/compare?')) {
      throw new TypeError('Failed to fetch');
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const client = createHiscoresClient({ fetchImpl, basePath: '/api/hiscores' });

  const cats = await client.fetchCategories();
  assert.equal(cats.ok, true);
  assert.equal(cats.status, 200);
  assert.deepEqual(cats.data, { core: ['overall'] });

  const board = await client.fetchBoard({ board: 'overall', page: 1, limit: 25, className: 'Knight', race: 'Breton', query: 'Ald' });
  assert.equal(board.ok, true);
  assert.equal(board.data.entries[0].name, 'Aldric');
  assert.equal(
    calls[1].url,
    '/api/hiscores?board=overall&page=1&limit=25&class=Knight&race=Breton&q=Ald',
  );

  const orders = await client.fetchOrders({ sort: 'score', page: 1, limit: 10, query: 'Dragon' });
  assert.equal(orders.ok, true);
  assert.equal(orders.data.orders[0].name, 'Knights of the Dragon');

  const player = await client.fetchPlayer('Sir Aldric');
  assert.equal(player.ok, true);
  assert.equal(player.data.level, 14);

  const missing = await client.fetchPlayer('Missing Hero');
  assert.deepEqual(missing, {
    ok: false,
    status: 404,
    error: 'Character not found in Chronicles',
  });

  const networkErr = await client.fetchCompare('Aldric', 'Gortwog');
  assert.deepEqual(networkErr, {
    ok: false,
    status: 0,
    error: 'Failed to fetch',
  });

  const emptyName = await client.fetchPlayer('   ');
  assert.equal(emptyName.ok, false);
  assert.equal(emptyName.status, 400);
});

test('summarizeComparison computes headline and biggest skill advantages for both players', () => {
  const comparison = {
    a: { name: 'Aldric' },
    b: { name: 'Morgiah' },
    boards: [
      { board: 'overall', scoreA: 1500, scoreB: 1420 },
      { board: 'level', scoreA: 15, scoreB: 15 },
      { board: 'quests', scoreA: 20, scoreB: 12 },
      { board: 'skill:long-blade', skill: 'Long Blade', scoreA: 92, scoreB: 55 },
      { board: 'skill:destruction', skill: 'Destruction', scoreA: 40, scoreB: 96 },
      { board: 'skill:running', skill: 'Running', scoreA: 70, scoreB: 60 },
      { board: 'skill:illusion', skill: 'Illusion', scoreA: 30, scoreB: 55 },
    ],
  };

  const summary = summarizeComparison(comparison);
  assert.equal(summary.nameA, 'Aldric');
  assert.equal(summary.nameB, 'Morgiah');
  assert.equal(summary.winsA, 4);
  assert.equal(summary.winsB, 2);
  assert.equal(summary.ties, 1);
  assert.equal(summary.leader, 'a');
  assert.equal(summary.headline, 'Aldric leads 4–2 (1 tied)');
  assert.equal(summary.biggestAdvantageA.skill, 'Long Blade');
  assert.equal(summary.biggestAdvantageA.diff, 37);
  assert.equal(summary.biggestAdvantageB.skill, 'Destruction');
  assert.equal(summary.biggestAdvantageB.diff, 56);

  // Tied comparison
  const tied = summarizeComparison({
    a: { name: 'A' },
    b: { name: 'B' },
    boards: [
      { board: 'overall', scoreA: 100, scoreB: 90 },
      { board: 'slayer', scoreA: 10, scoreB: 20 },
      { board: 'level', scoreA: 5, scoreB: 5 },
    ],
  });
  assert.equal(tied.leader, 'tie');
  assert.equal(tied.headline, 'Tied 1–1 (1 tied)');
  assert.equal(tied.biggestAdvantageA, null);
  assert.equal(tied.biggestAdvantageB, null);
});
