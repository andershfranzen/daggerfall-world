import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILLS } from '../client/gameplay/character/rules.js';
import {
  createHiscoresEngine,
  skillSlug,
  TOTAL_CLASSIC_PLACES,
  CLASSIC_GUILD_GROUPS,
  CORE_BOARD_DEFS,
} from '../server/hiscores/engine.js';

function makeSkills(overrides = {}, base = 10) {
  const skills = {};
  for (const s of SKILLS) skills[s] = base;
  Object.assign(skills, overrides);
  return skills;
}

function sumSkills(skills) {
  return Object.values(skills).reduce((a, b) => a + b, 0);
}

function makeCharacter(overrides = {}) {
  const skills = overrides.skills ?? makeSkills();
  const totalSkill = overrides.totalSkill ?? sumSkills(skills);
  return {
    playerId: overrides.playerId ?? 1,
    name: overrides.name ?? 'Aldric',
    className: overrides.className ?? 'Warrior',
    race: overrides.race ?? 'Breton',
    level: overrides.level ?? 10,
    totalSkill,
    placesDiscovered: overrides.placesDiscovered ?? 42,
    trips: overrides.trips ?? 12,
    questsCompleted: overrides.questsCompleted ?? 7,
    monstersSlain: overrides.monstersSlain ?? 120,
    infamy: overrides.infamy ?? 0,
    worstRegion: overrides.worstRegion ?? null,
    admiraltyScore: overrides.admiraltyScore ?? 0,
    admiraltyRankTitle: overrides.admiraltyRankTitle ?? null,
    shipsSunk: overrides.shipsSunk ?? 0,
    skills,
    skillMilestones: overrides.skillMilestones ?? {},
    guilds: overrides.guilds ?? {},
    order: overrides.order ?? null,
    milestoneAt: overrides.milestoneAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_500_000,
  };
}

function makeSampleWorld() {
  const characters = [
    makeCharacter({
      playerId: 101,
      name: 'Barenziah',
      className: 'Mage',
      race: 'Dark Elf',
      level: 24,
      skills: makeSkills({ Destruction: 100, Restoration: 85, 'Long Blade': 40 }, 20),
      skillMilestones: { Destruction: 1_700_000_200_000 },
      placesDiscovered: 350,
      trips: 80,
      questsCompleted: 45,
      monstersSlain: 600,
      infamy: 150,
      worstRegion: 'Daggerfall',
      admiraltyScore: 420,
      admiraltyRankTitle: 'Commodore',
      shipsSunk: 9,
      guilds: {
        mages: { rank: 8, title: 'Wizard', reputation: 92, variantName: 'Mages Guild', milestoneAt: 1_700_000_100_000 },
        temple: { rank: 5, title: 'Curate', reputation: 65, variantName: 'Order of Arkay' },
      },
      order: { id: 'ord-1', name: 'Arcane Vanguard', tag: 'ARC' },
      milestoneAt: 1_700_000_200_000,
    }),
    makeCharacter({
      playerId: 102,
      name: 'Cyrus',
      className: 'Warrior',
      race: 'Redguard',
      level: 24,
      skills: makeSkills({ 'Long Blade': 100, Destruction: 100, Archery: 75 }, 20),
      skillMilestones: { Destruction: 1_700_000_100_000, 'Long Blade': 1_700_000_050_000 },
      placesDiscovered: 520,
      trips: 110,
      questsCompleted: 30,
      monstersSlain: 950,
      infamy: 0,
      admiraltyScore: 980,
      admiraltyRankTitle: 'Admiral of the Bay',
      shipsSunk: 22,
      guilds: {
        fighters: { rank: 9, title: 'Master', reputation: 98, variantName: 'Fighters Guild' },
        knights: { rank: 7, title: 'Paladin', reputation: 80, variantName: 'Order of the Dragon' },
      },
      order: { id: 'ord-2', name: 'Redguard Corsairs', tag: 'COR' },
      milestoneAt: 1_700_000_150_000,
    }),
    makeCharacter({
      playerId: 103,
      name: 'Vexia',
      className: 'Thief',
      race: 'Wood Elf',
      level: 18,
      skills: makeSkills({ Stealth: 95, Pickpocket: 92, Lockpicking: 88, 'Short Blade': 70 }, 15),
      placesDiscovered: 210,
      trips: 60,
      questsCompleted: 62,
      monstersSlain: 240,
      infamy: 890,
      worstRegion: 'Wayrest',
      admiraltyScore: 0,
      shipsSunk: 0,
      guilds: {
        thieves: { rank: 9, title: 'Mastermind', reputation: 95, variantName: 'Thieves Guild' },
        brotherhood: { rank: 6, title: 'Executioner', reputation: 70, variantName: 'Dark Brotherhood' },
      },
      order: { id: 'ord-3', name: 'Shadow Syndicate', tag: 'SHD' },
      milestoneAt: 1_700_000_300_000,
    }),
    makeCharacter({
      playerId: 104,
      name: 'Ulfric',
      className: 'Warrior',
      race: 'Nord',
      level: 15,
      skills: makeSkills({ Axe: 90, 'Blunt Weapon': 80, Destruction: 0 }, 12),
      placesDiscovered: 140,
      trips: 35,
      questsCompleted: 15,
      monstersSlain: 410,
      infamy: 50,
      worstRegion: 'Sentinel',
      admiraltyScore: 120,
      admiraltyRankTitle: 'Ensign',
      shipsSunk: 2,
      guilds: {
        fighters: { rank: 6, title: 'Guardian', reputation: 72, variantName: 'Fighters Guild' },
      },
      order: { id: 'ord-2', name: 'Redguard Corsairs', tag: 'COR' },
      milestoneAt: 1_700_000_400_000,
    }),
  ];

  const orders = [
    { id: 'ord-1', name: 'Arcane Vanguard', tag: 'ARC', memberCount: 12, totalLevel: 210, treasury: 50_000, leaderName: 'Barenziah', createdAt: 1_700_000_010_000 },
    { id: 'ord-2', name: 'Redguard Corsairs', tag: 'COR', memberCount: 25, totalLevel: 380, treasury: 120_000, leaderName: 'Cyrus', createdAt: 1_700_000_020_000 },
    { id: 'ord-3', name: 'Shadow Syndicate', tag: 'SHD', memberCount: 18, totalLevel: 440, treasury: 900_000, leaderName: 'Vexia', createdAt: 1_700_000_030_000 },
  ];

  return { characters, orders, generatedAt: 1_700_001_000_000 };
}

test('deterministic tie-breaking: score DESC, secondary DESC, earliest milestoneAt ASC, playerId ASC', async () => {
  const sameSkills = makeSkills({ Destruction: 100 }, 20);
  const totalSkill = sumSkills(sameSkills);

  const characters = [
    // Same score (100), same secondary (totalSkill), missing milestoneAt -> loses to verified milestones
    makeCharacter({ playerId: 1, name: 'NoMilestone', skills: sameSkills, totalSkill, skillMilestones: {}, milestoneAt: 0 }),
    // Same score (100), same secondary (totalSkill), later milestone -> 3rd
    makeCharacter({ playerId: 2, name: 'LaterHundred', skills: sameSkills, totalSkill, skillMilestones: { Destruction: 2000 } }),
    // Same score (100), same secondary (totalSkill), earliest milestone, higher playerId -> 2nd
    makeCharacter({ playerId: 50, name: 'FirstHundredB', skills: sameSkills, totalSkill, skillMilestones: { Destruction: 1000 } }),
    // Same score (100), same secondary (totalSkill), earliest milestone, lower playerId -> 1st!
    makeCharacter({ playerId: 10, name: 'FirstHundredA', skills: sameSkills, totalSkill, skillMilestones: { Destruction: 1000 } }),
    // Same score (100), HIGHER secondary (totalSkill + 10) -> beats everyone on secondary!
    makeCharacter({
      playerId: 99,
      name: 'HigherSecondary',
      skills: makeSkills({ Destruction: 100, Alteration: 30 }, 20),
      skillMilestones: { Destruction: 9999 },
    }),
  ];

  const engine = createHiscoresEngine({
    loadSnapshot: () => ({ characters, orders: [], generatedAt: 12345 }),
  });

  const board = await engine.getBoard({ board: 'skill:destruction' });
  assert.deepEqual(
    board.entries.map((e) => e.name),
    ['HigherSecondary', 'FirstHundredA', 'FirstHundredB', 'LaterHundred', 'NoMilestone'],
  );
  assert.deepEqual(board.entries.map((e) => e.globalRank), [1, 2, 3, 4, 5]);
});

test('concurrent refresh() deduplication shares a single in-flight snapshot load', async () => {
  let loadCalls = 0;
  let resolveSnapshot;
  const engine = createHiscoresEngine({
    loadSnapshot: () => {
      loadCalls += 1;
      return new Promise((resolve) => {
        resolveSnapshot = () => resolve(makeSampleWorld());
      });
    },
  });

  const p1 = engine.refresh({ force: true });
  const p2 = engine.refresh({ force: true });
  const p3 = engine.getBoard({ board: 'overall' });

  assert.equal(loadCalls, 1, 'concurrent callers must share one in-flight loadSnapshot');
  resolveSnapshot();

  const [s1, s2, board] = await Promise.all([p1, p2, p3]);
  assert.equal(loadCalls, 1);
  assert.equal(s1.refreshCount, 1);
  assert.equal(s2.refreshCount, 1);
  assert.equal(board.total, 4);
});

test('TTL expiry, invalidate(), ttlMs=0, and store.loadSnapshot support', async () => {
  let clock = 10_000;
  let loadCalls = 0;
  const store = {
    loadSnapshot: async () => {
      loadCalls += 1;
      return makeSampleWorld();
    },
  };

  const engine = createHiscoresEngine({
    store,
    ttlMs: 5_000,
    now: () => clock,
  });

  assert.equal(engine.getStats().stale, true);
  assert.equal(engine.getStats().refreshCount, 0);

  await engine.getBoard({ board: 'overall' });
  assert.equal(loadCalls, 1);
  assert.equal(engine.getStats().stale, false);
  assert.equal(engine.getStats().characterCount, 4);
  assert.equal(engine.getStats().orderCount, 3);

  // Within TTL -> cached
  clock += 4_999;
  await engine.getBoard({ board: 'level' });
  assert.equal(loadCalls, 1);

  // Past TTL -> refreshes
  clock += 1;
  assert.equal(engine.getStats().stale, true);
  await engine.getBoard({ board: 'level' });
  assert.equal(loadCalls, 2);

  // Manual invalidate() -> refreshes immediately
  engine.invalidate();
  assert.equal(engine.getStats().stale, true);
  await engine.getBoard({ board: 'overall' });
  assert.equal(loadCalls, 3);

  // ttlMs = 0 -> always fresh
  let alwaysFreshCalls = 0;
  const freshEngine = createHiscoresEngine({
    ttlMs: 0,
    loadSnapshot: () => {
      alwaysFreshCalls += 1;
      return makeSampleWorld();
    },
  });
  await freshEngine.getBoard({ board: 'overall' });
  await freshEngine.getBoard({ board: 'overall' });
  assert.equal(alwaysFreshCalls, 2);
  assert.equal(freshEngine.getStats().stale, true);
});

test('filtering by className, race, and query preserves globalRank and computes filteredRank', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  const full = await engine.getBoard({ board: 'overall' });
  const cyrusGlobal = full.entries.find((e) => e.name === 'Cyrus').globalRank;
  const ulfricGlobal = full.entries.find((e) => e.name === 'Ulfric').globalRank;

  // Case-insensitive className filter
  const warriors = await engine.getBoard({ board: 'overall', className: 'wArRiOr' });
  assert.equal(warriors.total, 2);
  assert.deepEqual(warriors.entries.map((e) => e.name), ['Cyrus', 'Ulfric']);
  assert.deepEqual(warriors.entries.map((e) => e.globalRank), [cyrusGlobal, ulfricGlobal]);
  assert.deepEqual(warriors.entries.map((e) => e.filteredRank), [1, 2]);
  assert.equal(warriors.filters.className, 'wArRiOr');

  // Case-insensitive race filter
  const nords = await engine.getBoard({ board: 'overall', race: 'nord' });
  assert.equal(nords.total, 1);
  assert.equal(nords.entries[0].name, 'Ulfric');
  assert.equal(nords.entries[0].globalRank, ulfricGlobal);
  assert.equal(nords.entries[0].filteredRank, 1);

  // Query substring matching orderTag ("cor" -> Cyrus & Ulfric)
  const byTag = await engine.getBoard({ board: 'overall', query: 'cor' });
  assert.equal(byTag.total, 2);
  assert.deepEqual(byTag.entries.map((e) => e.name), ['Cyrus', 'Ulfric']);
  assert.deepEqual(byTag.entries.map((e) => e.globalRank), [cyrusGlobal, ulfricGlobal]);
  assert.deepEqual(byTag.entries.map((e) => e.filteredRank), [1, 2]);

  // Query substring matching character name ("vex")
  const byName = await engine.getBoard({ board: 'overall', query: 'VEX' });
  assert.equal(byName.total, 1);
  assert.equal(byName.entries[0].name, 'Vexia');
  assert.equal(byName.entries[0].filteredRank, 1);
});

test('pagination bounds and clamping', async () => {
  const characters = Array.from({ length: 12 }, (_, i) =>
    makeCharacter({
      playerId: i + 1,
      name: `Hero${String(i + 1).padStart(2, '0')}`,
      level: 30 - i,
      totalSkill: 1000 - i * 10,
    }),
  );

  const engine = createHiscoresEngine({
    loadSnapshot: () => ({ characters, orders: [] }),
    maxPageSize: 5,
    limit: 4,
  });

  // Page < 1 clamps to 1; limit > maxPageSize clamps to maxPageSize (5)
  const p1 = await engine.getBoard({ board: 'overall', page: -3, limit: 999 });
  assert.equal(p1.page, 1);
  assert.equal(p1.limit, 5);
  assert.equal(p1.total, 12);
  assert.equal(p1.pages, 3);
  assert.equal(p1.entries.length, 5);
  assert.deepEqual(p1.entries.map((e) => e.globalRank), [1, 2, 3, 4, 5]);

  // Last partial page
  const p3 = await engine.getBoard({ board: 'overall', page: 3, limit: 5 });
  assert.equal(p3.entries.length, 2);
  assert.deepEqual(p3.entries.map((e) => e.globalRank), [11, 12]);
  assert.deepEqual(p3.entries.map((e) => e.filteredRank), [11, 12]);

  // Out-of-range page returns empty entries
  const p9 = await engine.getBoard({ board: 'overall', page: 9, limit: 5 });
  assert.equal(p9.entries.length, 0);
  assert.equal(p9.total, 12);
  assert.equal(p9.pages, 3);
});

test('unknown board throws error with code UNKNOWN_BOARD', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  await assert.rejects(
    () => engine.getBoard({ board: 'nonexistent' }),
    (err) => err && err.code === 'UNKNOWN_BOARD',
  );
  await assert.rejects(
    () => engine.getBoard({ board: 'skill:alchemy-fake' }),
    (err) => err && err.code === 'UNKNOWN_BOARD',
  );
  await assert.rejects(
    () => engine.getBoard({ board: 'guild:bards' }),
    (err) => err && err.code === 'UNKNOWN_BOARD',
  );
});

test('all 35 skill boards, 6 guild boards, and core eligibility rules (wanted/admiralty > 0)', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  // Categories metadata
  const cats = await engine.getCategories();
  assert.equal(cats.version, 1);
  assert.equal(cats.core.length, CORE_BOARD_DEFS.length);
  assert.equal(cats.guilds.length, 6);
  assert.equal(cats.skills.length, 35);

  // All 35 skill boards work and exclude value <= 0
  assert.equal(SKILLS.length, 35);
  for (const skill of SKILLS) {
    const slug = skillSlug(skill);
    const board = await engine.getBoard({ board: `skill:${slug}` });
    assert.equal(board.board, `skill:${slug}`);
    assert.equal(board.label, skill);
    if (skill === 'Destruction') {
      // Ulfric has Destruction = 0, so excluded (3 ranked)
      assert.equal(board.total, 3);
      assert.equal(board.entries.some((e) => e.name === 'Ulfric'), false);
      // Cyrus vs Barenziah: both 100 Destruction, Cyrus has higher totalSkill (secondary)
      assert.equal(board.entries[0].name, 'Cyrus');
      assert.equal(board.entries[1].name, 'Barenziah');
    } else {
      assert.equal(board.total, 4);
    }
  }

  // All 6 guild boards only include members of that guild
  for (const g of CLASSIC_GUILD_GROUPS) {
    const board = await engine.getBoard({ board: `guild:${g.group}` });
    assert.equal(board.board, `guild:${g.group}`);
    assert.ok(board.total >= 1, `guild:${g.group} should have members`);
  }
  const fighters = await engine.getBoard({ board: 'guild:fighters' });
  assert.deepEqual(fighters.entries.map((e) => e.name), ['Cyrus', 'Ulfric']);

  // Wanted board excludes infamy === 0 (Cyrus)
  const wanted = await engine.getBoard({ board: 'wanted' });
  assert.deepEqual(wanted.entries.map((e) => e.name), ['Vexia', 'Barenziah', 'Ulfric']);

  // Admiralty board excludes admiraltyScore === 0 (Vexia)
  const admiralty = await engine.getBoard({ board: 'admiralty' });
  assert.deepEqual(admiralty.entries.map((e) => e.name), ['Cyrus', 'Barenziah', 'Ulfric']);
});

test('getOrders sorts by members, level, treasury and supports query filtering', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  const byMembers = await engine.getOrders({ sort: 'members' });
  assert.equal(byMembers.sort, 'members');
  assert.deepEqual(byMembers.entries.map((o) => o.tag), ['COR', 'SHD', 'ARC']);

  const byLevel = await engine.getOrders({ sort: 'level' });
  assert.equal(byLevel.sort, 'level');
  assert.deepEqual(byLevel.entries.map((o) => o.tag), ['SHD', 'COR', 'ARC']);

  const byTreasury = await engine.getOrders({ sort: 'treasury' });
  assert.equal(byTreasury.sort, 'treasury');
  assert.deepEqual(byTreasury.entries.map((o) => o.tag), ['SHD', 'COR', 'ARC']);

  // Query preserves globalRank and computes filteredRank
  const filtered = await engine.getOrders({ sort: 'members', query: 'arc' });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.entries[0].name, 'Arcane Vanguard');
  assert.equal(filtered.entries[0].globalRank, 3);
  assert.equal(filtered.entries[0].filteredRank, 1);
});

test('getPlayer returns full OSRS-style Chronicles profile by name (case-insensitive) or numeric playerId', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  const byName = await engine.getPlayer('  barenziah  ');
  const byId = await engine.getPlayer(101);
  assert.deepEqual(byName, byId);

  assert.equal(byName.version, 1);
  assert.equal(byName.player.playerId, 101);
  assert.equal(byName.player.name, 'Barenziah');
  assert.equal(byName.player.className, 'Mage');
  assert.equal(byName.player.race, 'Dark Elf');
  assert.equal(byName.player.order.tag, 'ARC');

  assert.equal(byName.summary.totalClassicPlaces, TOTAL_CLASSIC_PLACES);
  assert.equal(byName.summary.overallRank, 2);
  assert.equal(byName.summary.wantedRank, 2);
  assert.equal(byName.summary.admiraltyRank, 2);
  assert.equal(byName.summary.worstRegion, 'Daggerfall');
  assert.equal(byName.summary.admiraltyRankTitle, 'Commodore');
  assert.equal(byName.summary.shipsSunk, 9);

  assert.equal(byName.skills.length, 35);
  const dest = byName.skills.find((s) => s.skill === 'Destruction');
  assert.equal(dest.slug, 'destruction');
  assert.equal(dest.value, 100);
  assert.equal(dest.rank, 2);
  assert.equal(dest.totalRanked, 3);
  assert.equal(dest.milestoneAt, 1_700_000_200_000);

  assert.equal(byName.guilds.length, 2);
  assert.deepEqual(byName.guilds.map((g) => g.group), ['mages', 'temple']);
  assert.equal(byName.guilds[0].boardRank, 1);
  assert.equal(byName.guilds[0].title, 'Wizard');

  // Unranked wanted player has wantedRank === null
  const cyrus = await engine.getPlayer('Cyrus');
  assert.equal(cyrus.summary.wantedRank, null);
  assert.equal(cyrus.summary.admiraltyRank, 1);

  // Missing player returns null
  assert.equal(await engine.getPlayer('NobodyHere'), null);
  assert.equal(await engine.getPlayer(99999), null);
});

test('comparePlayers computes deltas, ranks, winners, and missing player errors', async () => {
  const engine = createHiscoresEngine({ loadSnapshot: makeSampleWorld });

  const missingOne = await engine.comparePlayers('Barenziah', 'Ghost');
  assert.deepEqual(missingOne, { ok: false, missing: ['Ghost'] });

  const missingBoth = await engine.comparePlayers('GhostA', 'GhostB');
  assert.deepEqual(missingBoth, { ok: false, missing: ['GhostA', 'GhostB'] });

  const cmp = await engine.comparePlayers('barenziah', 'CYRUS');
  assert.equal(cmp.ok, true);
  assert.equal(cmp.version, 1);
  assert.equal(cmp.a.player.name, 'Barenziah');
  assert.equal(cmp.b.player.name, 'Cyrus');
  assert.equal(cmp.core.length, 7);
  assert.equal(cmp.skills.length, 35);

  const levelRow = cmp.core.find((r) => r.id === 'level');
  assert.equal(levelRow.aScore, 24);
  assert.equal(levelRow.bScore, 24);
  assert.equal(levelRow.delta, 0);
  assert.equal(levelRow.winner, 'tie');

  const questsRow = cmp.core.find((r) => r.id === 'quests');
  assert.equal(questsRow.delta, 15);
  assert.equal(questsRow.winner, 'a');

  const slayerRow = cmp.core.find((r) => r.id === 'slayer');
  assert.equal(slayerRow.delta, -350);
  assert.equal(slayerRow.winner, 'b');

  const longBladeRow = cmp.skills.find((s) => s.skill === 'Long Blade');
  assert.equal(longBladeRow.aValue, 40);
  assert.equal(longBladeRow.bValue, 100);
  assert.equal(longBladeRow.delta, -60);
  assert.equal(longBladeRow.winner, 'b');

  const destRow = cmp.skills.find((s) => s.skill === 'Destruction');
  assert.equal(destRow.delta, 0);
  assert.equal(destRow.winner, 'tie');

  assert.equal(cmp.wins.a + cmp.wins.b + cmp.wins.ties, cmp.core.length + cmp.skills.length);
  assert.ok(cmp.wins.a > 0 && cmp.wins.b > 0 && cmp.wins.ties > 0);
});

test('empty-world edge cases behave cleanly without throwing', async () => {
  const engine = createHiscoresEngine({
    loadSnapshot: () => ({ characters: [], orders: [], generatedAt: 0 }),
  });

  const board = await engine.getBoard({ board: 'overall' });
  assert.equal(board.total, 0);
  assert.equal(board.pages, 0);
  assert.deepEqual(board.entries, []);

  const orders = await engine.getOrders();
  assert.equal(orders.total, 0);
  assert.equal(orders.pages, 0);
  assert.deepEqual(orders.entries, []);

  assert.equal(await engine.getPlayer('Anyone'), null);
  assert.deepEqual(await engine.comparePlayers('A', 'B'), { ok: false, missing: ['A', 'B'] });

  const stats = engine.getStats();
  assert.equal(stats.characterCount, 0);
  assert.equal(stats.orderCount, 0);
  assert.equal(stats.refreshCount, 1);
});

test('composes cleanly with injected projectCharacter, projectOrders, resolveBoard, scoreForBoard, publicCategoriesPayload', async () => {
  const customCategories = { version: 1, custom: true, core: [{ id: 'custom-board', label: 'Custom', unit: 'Pts' }] };
  const engine = createHiscoresEngine({
    loadSnapshot: () => ({
      characters: [{ id: 7, heroName: 'InjectedHero', customPoints: 777 }],
      orders: [{ orderId: 'o9', title: 'Injected Order', tag: 'INJ', members: 5, level: 99, gold: 1000 }],
      generatedAt: 5555,
    }),
    projectCharacter: (raw) => makeCharacter({
      playerId: raw.id,
      name: raw.heroName,
      totalSkill: raw.customPoints,
    }),
    projectOrders: (list) => list.map((o) => ({
      id: o.orderId,
      name: o.title,
      tag: o.tag,
      memberCount: o.members,
      totalLevel: o.level,
      treasury: o.gold,
      leaderName: null,
      createdAt: 100,
    })),
    resolveBoard: (id) => (id === 'custom-board' ? { id: 'custom-board', kind: 'core', label: 'Custom', unit: 'Pts' } : null),
    scoreForBoard: (rec, board) => (board.id === 'custom-board' ? { eligible: true, score: rec.totalSkill, secondary: rec.level, milestoneAt: 1 } : null),
    publicCategoriesPayload: () => customCategories,
  });

  assert.deepEqual(await engine.getCategories(), customCategories);
  const board = await engine.getBoard({ board: 'custom-board' });
  assert.equal(board.total, 1);
  assert.equal(board.entries[0].name, 'InjectedHero');
  assert.equal(board.entries[0].score, 777);

  const orders = await engine.getOrders({ sort: 'treasury' });
  assert.equal(orders.entries[0].name, 'Injected Order');
  assert.equal(orders.entries[0].treasury, 1000);
});
