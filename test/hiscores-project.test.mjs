import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS, MAX_SKILL } from '../client/gameplay/character/rules.js';
import { encodeFoundBitset } from '../client/gameplay/travel/identity.js';
import {
  TOTAL_CLASSIC_PLACES,
  skillSlug,
  SKILL_BY_SLUG,
  SLUG_BY_SKILL,
  CORE_BOARDS,
  GUILD_BOARDS,
  SKILL_BOARDS,
  ORDERS_BOARD,
  ALL_BOARDS,
  BOARD_BY_ID,
  resolveBoard,
  publicCategoriesPayload,
} from '../server/hiscores/categories.js';
import {
  projectCharacter,
  projectOrders,
  scoreForBoard,
} from '../server/hiscores/project.js';

function makeCreatedRow(overrides = {}) {
  return {
    id: 42,
    name: '  Cyndal  ',
    accountId: 'acc_100',
    tokenHash: 'secret-token-hash',
    x: 123.4,
    z: -567.8,
    yaw: 1.5,
    updatedAt: 1_700_000_000_000,
    lastSeen: 1_700_000_123_000,
    rpg: {
      location: 'town:Daggerfall/Daggerfall',
      gold: 99999,
      inventory: [{ id: 'secret-sword' }],
      character: {
        created: true,
        className: 'Spellsword',
        race: 'Breton',
        level: 14,
        skills: {
          'Long Blade': 78,
          Destruction: 64,
          'Hand-to-Hand': 31,
          Restoration: 55,
        },
      },
      travel: {
        trips: 19,
        found: { 17: [0, 1, 2, 3, 4] },
        discovered: ['town:Daggerfall/Gothway Garden', 'town:Daggerfall/Gothway Garden', 'town:Wayrest/Wayrest'],
      },
      quests: {
        done: [
          { uid: 'q1', result: 'success' },
          { uid: 'q2', result: 'failed' },
          { uid: 'q3', result: 'complete' },
          { uid: 'q4', result: 'completed' },
        ],
      },
      chronicles: {
        questsCompleted: 2,
        monstersSlain: 87,
        levelMilestoneAt: 1_700_000_050_000,
        skillMilestones: {
          'Long Blade': 1_700_000_010_000,
        },
      },
      law: {
        rep: { Daggerfall: -35, Wayrest: 12, Sentinel: -60 },
        banished: { Sentinel: true, Wayrest: false },
        charge: { id: 'c1', region: 'Daggerfall', crime: 'theft' },
      },
      admiralty: {
        standing: { Daggerfall: 130, Wayrest: 40, Sentinel: -15 },
        notoriety: { Betony: 32.4, Sentinel: 10 },
        log: {
          sunk: { pirate: 4, merchant: 1, navy: 0 },
          taken: { pirate: 2, merchant: 0, navy: 0 },
          repelled: 3,
          contracts: { bounty: 2, hunt: 1, survey: 1, salvage: 0 },
        },
      },
      guilds: {
        fighters: { rank: 6 },
        temple: { rank: 4, variant: 26 },
        knights: { rank: 7, variant: 368 },
        bogus: { rank: 5 },
        mages: { rank: -1 },
      },
      factions: {
        41: 68,
        26: 44,
        368: 82,
      },
      playerGuild: {
        id: 'pg_abc123',
        name: 'Blades of the Bay',
        tag: 'BOTB',
        rank: 'Leader',
        secretInternalNote: 'do-not-leak',
      },
    },
    ...overrides,
  };
}

test('categories: all 35 classic skills have unique, reversible slugs and boards', () => {
  assert.equal(TOTAL_CLASSIC_PLACES, 15251);
  assert.equal(SKILLS.length, 35);
  assert.equal(SKILL_BOARDS.length, 35);
  assert.equal(skillSlug('Long Blade'), 'long-blade');
  assert.equal(skillSlug('Hand-to-Hand'), 'hand-to-hand');
  assert.equal(skillSlug('Critical Strike'), 'critical-strike');

  const seenSlugs = new Set();
  for (const skill of SKILLS) {
    const slug = SLUG_BY_SKILL[skill];
    assert.ok(slug && /^[a-z0-9-]+$/.test(slug), `invalid slug for ${skill}: ${slug}`);
    assert.equal(seenSlugs.has(slug), false, `duplicate slug ${slug}`);
    seenSlugs.add(slug);
    assert.equal(SKILL_BY_SLUG[slug], skill);

    const board = BOARD_BY_ID[`skill:${slug}`];
    assert.ok(board, `missing board for skill:${slug}`);
    assert.equal(board.skill, skill);
    assert.equal(board.group, 'skills');
    assert.equal(board.unit, 'lvl');
    assert.equal(board.minScore, 1);
    assert.equal(board.maxScore, MAX_SKILL);
    assert.ok(typeof board.category === 'string' && board.category.length > 0);
  }
});

test('categories: core, guild, orders boards, resolveBoard, and publicCategoriesPayload', () => {
  assert.deepEqual(
    CORE_BOARDS.map((b) => b.id),
    ['overall', 'level', 'exploration', 'quests', 'slayer', 'wanted', 'admiralty'],
  );
  assert.deepEqual(
    GUILD_BOARDS.map((b) => b.id),
    ['guild:fighters', 'guild:mages', 'guild:thieves', 'guild:brotherhood', 'guild:temple', 'guild:knights'],
  );
  for (const g of GUILD_BOARDS) {
    assert.equal(g.group, 'guilds');
    assert.equal(g.unit, 'rank');
    assert.equal(g.minScore, 0);
    assert.equal(g.requiresMembership, true);
  }
  assert.equal(ORDERS_BOARD.id, 'orders');
  assert.equal(ORDERS_BOARD.group, 'orders');
  assert.equal(ALL_BOARDS.length, 7 + 6 + 35 + 1);

  assert.equal(resolveBoard('').id, 'overall');
  assert.equal(resolveBoard(null).id, 'overall');
  assert.equal(resolveBoard(undefined).id, 'overall');
  assert.equal(resolveBoard('overall').id, 'overall');
  assert.equal(resolveBoard('exploration').id, 'exploration');
  assert.equal(resolveBoard('guild:fighters').id, 'guild:fighters');
  assert.equal(resolveBoard('skill:long-blade').id, 'skill:long-blade');
  assert.equal(resolveBoard('long-blade').id, 'skill:long-blade');
  assert.equal(resolveBoard('Long Blade').id, 'skill:long-blade');
  assert.equal(resolveBoard('Hand-to-Hand').id, 'skill:hand-to-hand');
  assert.equal(resolveBoard('skill:Hand-to-Hand').id, 'skill:hand-to-hand');
  assert.equal(resolveBoard('orders').id, 'orders');
  assert.equal(resolveBoard('nonexistent-board'), null);
  assert.equal(resolveBoard('skill:not-a-skill'), null);

  const payload = publicCategoriesPayload();
  assert.equal(payload.version, 1);
  assert.equal(payload.totalClassicPlaces, TOTAL_CLASSIC_PLACES);
  assert.deepEqual(
    payload.groups.map((g) => g.id),
    ['core', 'guilds', 'skills', 'orders'],
  );
  assert.equal(payload.groups[0].boards.length, 7);
  assert.equal(payload.groups[1].boards.length, 6);
  assert.equal(payload.groups[2].boards.length, 35);
  assert.equal(payload.groups[3].boards.length, 1);
});

test('projectCharacter: enforces privacy exclusions and never leaks private fields', () => {
  assert.equal(projectCharacter(null), null);
  assert.equal(projectCharacter({ id: null, name: 'Test', rpg: { character: { created: true } } }), null);
  assert.equal(projectCharacter({ id: 1, name: '   ', rpg: { character: { created: true } } }), null);

  // Uncreated excluded by default, allowed when requireCreated is false
  const uncreated = makeCreatedRow();
  uncreated.rpg.character.created = false;
  assert.equal(projectCharacter(uncreated), null);
  assert.ok(projectCharacter(uncreated, { requireCreated: false }));

  // Unlinked excluded when requireLinked is true
  const unlinked = makeCreatedRow({ accountId: null });
  assert.ok(projectCharacter(unlinked));
  assert.equal(projectCharacter(unlinked, { requireLinked: true }), null);

  // Banned accounts excluded
  const bannedRow = makeCreatedRow({ accountId: 'acc_banned' });
  assert.equal(projectCharacter(bannedRow, { bannedAccountIds: new Set(['acc_banned']) }), null);
  assert.equal(projectCharacter(makeCreatedRow({ accountId: 77 }), { bannedAccountIds: new Set(['77']) }), null);

  // Opt-out privacy toggle
  const hiddenRow = makeCreatedRow();
  hiddenRow.rpg.chronicles.hidden = true;
  assert.equal(projectCharacter(hiddenRow), null);

  // Privacy invariant: zero private fields leaked
  const projected = projectCharacter(makeCreatedRow());
  assert.ok(projected);
  const forbiddenKeys = ['accountId', 'tokenHash', 'x', 'z', 'yaw', 'location', 'inventory', 'gold', 'rpg'];
  for (const key of forbiddenKeys) {
    assert.equal(Object.hasOwn(projected, key), false, `leaked forbidden field: ${key}`);
  }
  assert.equal(Object.hasOwn(projected.order, 'secretInternalNote'), false);
  assert.deepEqual(projected.order, {
    id: 'pg_abc123',
    name: 'Blades of the Bay',
    tag: 'BOTB',
    rank: 'Leader',
  });
});

test('projectCharacter: computes skills, bitset exploration, quests, infamy, admiralty, guilds, and milestones', () => {
  const row = makeCreatedRow();
  // Mix bitset region (600 places) + array region (5 places) + 2 unique legacy strings = 607
  const indices = Array.from({ length: 600 }, (_, i) => i);
  row.rpg.travel.found = {
    17: [0, 1, 2, 3, 4],
    20: encodeFoundBitset(indices),
  };

  const rec = projectCharacter(row);
  assert.equal(rec.playerId, 42);
  assert.equal(rec.name, 'Cyndal');
  assert.equal(rec.className, 'Spellsword');
  assert.equal(rec.race, 'Breton');
  assert.equal(rec.level, 14);

  // Skills & totalSkill
  assert.equal(Object.keys(rec.skills).length, 35);
  assert.equal(rec.skills['Long Blade'], 78);
  assert.equal(rec.skills.Destruction, 64);
  assert.equal(rec.skills['Hand-to-Hand'], 31);
  assert.equal(rec.skills.Restoration, 55);
  assert.equal(rec.skills.Orcish, 0);
  assert.equal(rec.totalSkill, 78 + 64 + 31 + 55);

  // Skill milestones: explicit milestone kept, others fall back to updatedAt (lastSeen)
  assert.equal(rec.updatedAt, 1_700_000_123_000);
  assert.equal(rec.milestoneAt, 1_700_000_050_000);
  assert.equal(rec.skillMilestones['Long Blade'], 1_700_000_010_000);
  assert.equal(rec.skillMilestones.Destruction, 1_700_000_123_000);

  // Exploration
  assert.equal(rec.placesDiscovered, 607);
  assert.equal(rec.trips, 19);

  // Quests (max of chronicles.questsCompleted=2 and 3 successful done entries)
  assert.equal(rec.questsCompleted, 3);
  assert.equal(rec.monstersSlain, 87);

  // Infamy: (-35 -> 35) + (-60 -> 60) + banished Sentinel (50) + open charge (25) + max notoriety (round(32.4)=32) = 202
  assert.equal(rec.infamy, 202);
  assert.equal(rec.worstRegion, 'Sentinel');

  // Admiralty: positive standings sum (130 + 40 = 170) + maxStanding (130) + pirateSunk (4*5=20) + pirateTaken (2*8=16) + repelled (3*3=9) + contracts (4*10=40) = 385
  assert.equal(rec.admiraltyMaxStanding, 130);
  assert.equal(rec.admiraltyRankTitle, 'Commodore');
  assert.equal(rec.shipsSunk, 5);
  assert.equal(rec.admiraltyScore, 385);

  // Guilds: valid groups only, negative rank excluded, variants resolved
  assert.deepEqual(Object.keys(rec.guilds).sort(), ['fighters', 'knights', 'temple']);
  assert.deepEqual(rec.guilds.fighters, {
    rank: 6,
    title: 'Captain',
    variant: null,
    variantName: null,
    reputation: 68,
  });
  assert.deepEqual(rec.guilds.temple, {
    rank: 4,
    title: 'Curate',
    variant: 26,
    variantName: 'Temple of Akatosh',
    reputation: 44,
  });
  assert.deepEqual(rec.guilds.knights, {
    rank: 7,
    title: 'Knight Banneret',
    variant: 368,
    variantName: 'Knights of the Dragon',
    reputation: 82,
  });
});

test('projectCharacter: handles malformed/partial rpg blobs, custom class name, and caps', () => {
  const row = {
    id: '9',
    name: 'Wanderer',
    updatedAt: 5000,
    rpg: JSON.stringify({
      character: {
        created: true,
        custom: { name: 'Shadowblade' },
        level: -5,
        skills: { 'Long Blade': 999, Archery: -10, Stealth: 'NaN' },
      },
      travel: {
        found: { 17: encodeFoundBitset(Array.from({ length: 16000 }, (_, i) => i)) },
        discovered: ['town:A/B'],
      },
      admiralty: { standing: { Daggerfall: 250 } },
    }),
  };

  const rec = projectCharacter(row);
  assert.equal(rec.playerId, 9);
  assert.equal(rec.className, 'Shadowblade');
  assert.equal(rec.race, 'Unknown');
  assert.equal(rec.level, 1);
  assert.equal(rec.skills['Long Blade'], MAX_SKILL);
  assert.equal(rec.skills.Archery, 0);
  assert.equal(rec.skills.Stealth, 0);
  assert.equal(rec.placesDiscovered, TOTAL_CLASSIC_PLACES);
  assert.equal(rec.admiraltyRankTitle, 'Admiral');
});

test('projectOrders: parses pguild: rows and aggregates member levels and skills', () => {
  const c1 = projectCharacter(makeCreatedRow({ id: 1, name: 'Aldric' }));
  const c2Row = makeCreatedRow({ id: 2, name: 'Bryn' });
  c2Row.rpg.character.level = 20;
  c2Row.rpg.character.skills = { 'Long Blade': 100 };
  const c2 = projectCharacter(c2Row);

  const charById = new Map([
    [1, c1],
    [2, c2],
  ]);

  const worldRows = [
    ['admiralty:quarry:123', { ended: true }],
    ['pguild:pg_one', {
      id: 'pg_one',
      name: 'Iliac Vanguard',
      tag: 'ILVG',
      motd: 'Private MOTD',
      treasury: 12500,
      createdAt: '2026-01-15T00:00:00.000Z',
      leaderId: 1,
      members: {
        1: { id: 1, name: 'Aldric', rank: 'Leader' },
        2: { id: 2, name: 'Bryn', rank: 'Officer' },
        3: { id: 3, name: 'MissingChar', rank: 'Member' },
      },
      ledger: [{ kind: 'deposit', amount: 12500 }],
    }],
    {
      key: 'pguild:pg_two',
      value: JSON.stringify({
        id: 'pg_two',
        name: 'Wayrest Corsairs',
        tag: 'CORS',
        treasury: 500,
        createdAt: '2026-02-01T12:00:00.000Z',
        members: {
          2: { id: 2, name: 'Bryn', rank: 'Leader' },
        },
      }),
    },
    ['pguild:empty', { id: 'empty', name: 'Ghost Order', tag: 'GHST', members: {} }],
  ];

  const orders = projectOrders(worldRows, charById);
  assert.equal(orders.length, 2);

  const first = orders[0];
  assert.deepEqual(first, {
    id: 'pg_one',
    name: 'Iliac Vanguard',
    tag: 'ILVG',
    leaderName: 'Aldric',
    memberCount: 3,
    combinedLevel: c1.level + c2.level,
    combinedTotalSkill: c1.totalSkill + c2.totalSkill,
    treasury: 12500,
    createdAt: '2026-01-15T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(first, 'ledger'), false);
  assert.equal(Object.hasOwn(first, 'motd'), false);

  assert.equal(orders[1].id, 'pg_two');
  assert.equal(orders[1].memberCount, 1);
  assert.equal(orders[1].combinedLevel, 20);
  assert.equal(orders[1].combinedTotalSkill, 100);
});

test('scoreForBoard: computes eligibility, score, secondary, milestoneAt, and badge across all boards', () => {
  const row = makeCreatedRow();
  row.rpg.character.skills['Long Blade'] = 100;
  const rec = projectCharacter(row);

  const overall = scoreForBoard(rec, 'overall');
  assert.equal(overall.eligible, true);
  assert.equal(overall.score, rec.totalSkill);
  assert.equal(overall.secondary, 14);
  assert.equal(overall.milestoneAt, 1_700_000_050_000);
  assert.equal(overall.badge, 'Spellsword');

  const level = scoreForBoard(rec, 'level');
  assert.equal(level.eligible, true);
  assert.equal(level.score, 14);
  assert.equal(level.secondary, rec.totalSkill);

  const exploration = scoreForBoard(rec, 'exploration');
  assert.equal(exploration.eligible, true);
  assert.equal(exploration.score, 7);
  assert.equal(exploration.secondary, 19);
  assert.equal(exploration.badge, '0.0%');

  const wanted = scoreForBoard(rec, 'wanted');
  assert.equal(wanted.eligible, true);
  assert.equal(wanted.score, 202);
  assert.equal(wanted.badge, 'Sentinel');

  const admiralty = scoreForBoard(rec, 'admiralty');
  assert.equal(admiralty.eligible, true);
  assert.equal(admiralty.score, 385);
  assert.equal(admiralty.secondary, 130);
  assert.equal(admiralty.badge, 'Commodore');

  const fighters = scoreForBoard(rec, 'guild:fighters');
  assert.equal(fighters.eligible, true);
  assert.equal(fighters.score, 6);
  assert.equal(fighters.secondary, 68);
  assert.equal(fighters.badge, 'Captain');

  const temple = scoreForBoard(rec, 'guild:temple');
  assert.equal(temple.eligible, true);
  assert.equal(temple.score, 4);
  assert.equal(temple.badge, 'Curate · Temple of Akatosh');

  // Non-member is ineligible on guild board
  const mages = scoreForBoard(rec, 'guild:mages');
  assert.equal(mages.eligible, false);
  assert.equal(mages.score, 0);

  // Skill board with milestone tie-breaker & Master badge at 100
  const longBlade = scoreForBoard(rec, 'Long Blade');
  assert.equal(longBlade.eligible, true);
  assert.equal(longBlade.score, 100);
  assert.equal(longBlade.secondary, rec.totalSkill);
  assert.equal(longBlade.milestoneAt, 1_700_000_010_000);
  assert.equal(longBlade.badge, 'Master');

  // Zero-level skill is ineligible (minScore 1)
  const orcish = scoreForBoard(rec, 'skill:orcish');
  assert.equal(orcish.eligible, false);
  assert.equal(orcish.score, 0);

  // Orders board scoring
  const orderScore = scoreForBoard(
    { id: 'pg_1', tag: 'ILVG', memberCount: 5, combinedTotalSkill: 2500, createdAt: '2026-01-15T00:00:00.000Z' },
    'orders',
  );
  assert.equal(orderScore.eligible, true);
  assert.equal(orderScore.score, 5);
  assert.equal(orderScore.secondary, 2500);
  assert.equal(orderScore.badge, '[ILVG]');
  assert.equal(orderScore.milestoneAt, Date.parse('2026-01-15T00:00:00.000Z'));

  // Unknown board returns ineligible empty score
  assert.equal(scoreForBoard(rec, 'does-not-exist').eligible, false);
});
