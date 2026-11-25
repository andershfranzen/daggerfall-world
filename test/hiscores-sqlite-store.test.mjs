import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { openSqliteHiscoresStore } from '../server/hiscores/sqlite-store.js';

function makeCharacter(overrides = {}) {
  return {
    playerId: 1,
    name: 'Aelric Stormborn',
    className: 'Spellsword',
    race: 'Breton',
    level: 14,
    totalSkill: 1120,
    placesDiscovered: 42,
    trips: 18,
    questsCompleted: 11,
    monstersSlain: 135,
    infamy: 20,
    worstRegion: 'Daggerfall',
    admiraltyScore: 480,
    admiraltyRankTitle: 'Captain',
    shipsSunk: 6,
    orderId: 'pg_001',
    orderTag: 'BAY',
    orderName: 'Blades of the Bay',
    orderRank: 'Leader',
    skills: { LongBlade: 78, Destruction: 64, Restoration: 55 },
    skillMilestones: { LongBlade: 1700000100000 },
    guilds: { fighters: { rank: 4 }, mages: { rank: 3 } },
    milestoneAt: 1700000200000,
    updatedAt: 1700000300000,
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    orderId: 'pg_001',
    name: 'Blades of the Bay',
    tag: 'BAY',
    leaderName: 'Aelric Stormborn',
    memberCount: 12,
    combinedLevel: 144,
    combinedTotalSkill: 11200,
    treasury: 55000,
    createdAt: 1700000000000,
    updatedAt: 1700000300000,
    ...overrides,
  };
}

test('standalone :memory: store creates idempotent schema and indexes, and closes owned DB', () => {
  const hs = openSqliteHiscoresStore(':memory:');
  assert.equal(hs.engine, 'sqlite');
  assert.equal(hs.db.isOpen, true);

  // Re-attaching to the same DB is idempotent.
  const hs2 = openSqliteHiscoresStore(hs.db);
  assert.equal(hs2.engine, 'sqlite');

  const indexes = new Set(
    hs.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_hiscores%'")
      .all()
      .map((r) => r.name),
  );
  for (const expected of [
    'idx_hiscores_name_key',
    'idx_hiscores_overall',
    'idx_hiscores_level',
    'idx_hiscores_exploration',
    'idx_hiscores_quests',
    'idx_hiscores_slayer',
    'idx_hiscores_wanted',
    'idx_hiscores_admiralty',
    'idx_hiscores_orders_members',
    'idx_hiscores_orders_level',
    'idx_hiscores_orders_treasury',
  ]) {
    assert.ok(indexes.has(expected), `expected index ${expected}`);
  }

  // Verify findByName uses the name_key index (no full table scan).
  const plan = hs.db
    .prepare('EXPLAIN QUERY PLAN SELECT * FROM hiscores WHERE name_key = LOWER(TRIM(?)) LIMIT 1')
    .all('Aelric Stormborn')
    .map((r) => r.detail)
    .join(' ');
  assert.match(plan, /idx_hiscores_name_key/);

  // Closing borrowed handle does not close db; closing owned handle does.
  hs2.close();
  assert.equal(hs.db.isOpen, true);
  hs.close();
  assert.equal(hs.db.isOpen, false);
});

test('upsertCharacter, upsertCharacters, findByName (case-insensitive), removeCharacter, and loadSnapshot round-trip', () => {
  const hs = openSqliteHiscoresStore(':memory:');
  try {
    const first = makeCharacter();
    const inserted = hs.upsertCharacter(first);
    assert.equal(inserted.playerId, 1);
    assert.equal(inserted.nameKey, 'aelric stormborn');
    assert.deepEqual(inserted.skills, first.skills);
    assert.deepEqual(inserted.skillMilestones, first.skillMilestones);
    assert.deepEqual(inserted.guilds, first.guilds);

    // Update existing record in place.
    hs.upsertCharacter(makeCharacter({ level: 19, totalSkill: 1450, monstersSlain: 250 }));
    assert.deepEqual(hs.count(), { characters: 1, orders: 0 });

    // Batch upsert.
    const upsertedCount = hs.upsertCharacters([
      makeCharacter({ playerId: 2, name: 'Brynja Frosthelm', level: 22, totalSkill: 1600, orderId: null, orderTag: null, orderName: null, orderRank: null }),
      makeCharacter({ playerId: 3, name: 'Corvus Nightshade', level: 11, totalSkill: 900, infamy: 420, worstRegion: 'Sentinel' }),
    ]);
    assert.equal(upsertedCount, 2);
    assert.deepEqual(hs.count(), { characters: 3, orders: 0 });

    // Case-insensitive + whitespace-trimmed O(1) lookup.
    const found = hs.findByName('  AELRIC STORMBORN  ');
    assert.ok(found);
    assert.equal(found.playerId, 1);
    assert.equal(found.level, 19);
    assert.equal(found.totalSkill, 1450);
    assert.equal(found.monstersSlain, 250);
    assert.equal(hs.findByName('Nobody Known'), null);
    assert.equal(hs.findByName('   '), null);

    // Removal (hide / ban / delete).
    assert.equal(hs.removeCharacter(3), true);
    assert.equal(hs.removeCharacter(9999), false);
    assert.equal(hs.findByName('Corvus Nightshade'), null);
    assert.deepEqual(hs.count(), { characters: 2, orders: 0 });

    // Snapshot round-trip.
    const snap = hs.loadSnapshot();
    assert.equal(typeof snap.generatedAt, 'number');
    assert.equal(snap.characters.length, 2);
    assert.deepEqual(
      snap.characters.map((c) => c.playerId),
      [2, 1],
    );
    assert.deepEqual(snap.orders, []);

    // Re-upserting canonical snapshot records into a fresh store preserves all fields.
    const hsCopy = openSqliteHiscoresStore(':memory:');
    try {
      hsCopy.upsertCharacters(snap.characters);
      const snap2 = hsCopy.loadSnapshot();
      assert.deepEqual(snap2.characters, snap.characters);
    } finally {
      hsCopy.close();
    }
  } finally {
    hs.close();
  }
});

test('syncOrders upserts active orders and prunes disbanded orders transactionally', () => {
  const hs = openSqliteHiscoresStore(':memory:');
  try {
    const firstSync = hs.syncOrders([
      makeOrder({ orderId: 'pg_001', name: 'Blades of the Bay', tag: 'BAY', memberCount: 12, treasury: 50000 }),
      makeOrder({ orderId: 'pg_002', name: 'Sentinel Corsairs', tag: 'CORS', memberCount: 8, treasury: 80000 }),
      makeOrder({ orderId: 'pg_003', name: 'Wayrest Wardens', tag: 'WARD', memberCount: 4, treasury: 12000 }),
    ]);
    assert.deepEqual(firstSync, { upserted: 3, deleted: 0 });
    assert.deepEqual(hs.count(), { characters: 0, orders: 3 });

    // Disband pg_002 and update pg_001, add pg_004.
    const secondSync = hs.syncOrders([
      makeOrder({ orderId: 'pg_001', name: 'Blades of the Bay', tag: 'BAY', memberCount: 15, treasury: 62000 }),
      makeOrder({ orderId: 'pg_003', name: 'Wayrest Wardens', tag: 'WARD', memberCount: 4, treasury: 12000 }),
      makeOrder({ orderId: 'pg_004', name: 'Alik’r Nomads', tag: 'SAND', memberCount: 9, treasury: 31000 }),
    ]);
    assert.deepEqual(secondSync, { upserted: 3, deleted: 1 });

    const snap = hs.loadSnapshot();
    assert.deepEqual(
      snap.orders.map((o) => ({ id: o.orderId, members: o.memberCount, treasury: o.treasury })),
      [
        { id: 'pg_001', members: 15, treasury: 62000 },
        { id: 'pg_004', members: 9, treasury: 31000 },
        { id: 'pg_003', members: 4, treasury: 12000 },
      ],
    );

    // Syncing empty array clears all orders.
    const clearSync = hs.syncOrders([]);
    assert.deepEqual(clearSync, { upserted: 0, deleted: 3 });
    assert.deepEqual(hs.count(), { characters: 0, orders: 0 });
  } finally {
    hs.close();
  }
});

test('shared openStore(":memory:") integration, rebuildFromTables filtering, and close() safety', () => {
  const gameStore = openStore(':memory:');
  const hs = openSqliteHiscoresStore(gameStore.db);

  try {
    // 1. Linked & created eligible character in an order.
    const p1 = gameStore.createForAccount('acc-1', 'aelric', 'Aelric');
    p1.rpg = {
      character: {
        className: 'Knight',
        race: 'Breton',
        level: 16,
        skills: { LongBlade: 82, CriticalStrike: 70 },
      },
      stats: { placesDiscovered: 24, trips: 9, questsCompleted: 7, monstersSlain: 88, infamy: 0 },
      admiralty: { score: 210, rankTitle: 'Lieutenant', shipsSunk: 3 },
      playerGuild: { id: 'pg_bay', name: 'Knights of the Bay', tag: 'BAY', rank: 'Leader' },
    };

    // 2. Linked & created character on a BANNED account.
    const p2 = gameStore.createForAccount('acc-banned', 'cheater', 'DarkCheater');
    p2.rpg = {
      character: { className: 'Rogue', race: 'Dark Elf', level: 30, skills: { ShortBlade: 100 } },
    };

    // 3. Linked & created character who opted out / hid from hiscores.
    const p3 = gameStore.createForAccount('acc-hidden', 'shyhero', 'ShyHero');
    p3.rpg = {
      character: { className: 'Mage', race: 'High Elf', level: 18, skills: { Destruction: 90 } },
      hiscoresHidden: true,
    };

    // 4. Linked but UNCREATED character (no rpg.character).
    const p4 = gameStore.createForAccount('acc-new', 'fresh', 'FreshArrival');
    p4.rpg = {};

    // 5. Unlinked guest character (created).
    const { row: p5 } = gameStore.create('GuestWanderer', {
      character: { className: 'Ranger', race: 'Wood Elf', level: 8, skills: { Archery: 55 } },
    });

    gameStore.saveCharacters(
      [p1, p2, p3, p4, p5],
      [
        [
          'pguild:pg_bay',
          {
            id: 'pg_bay',
            name: 'Knights of the Bay',
            tag: 'BAY',
            treasury: 14500,
            createdAt: 1700000000000,
            members: {
              [p1.id]: { name: 'Aelric', rank: 'Leader' },
            },
          },
        ],
        [
          'shop:daggerfall_weapons',
          { gold: 9999 }, // Non-pguild world_state row must be ignored.
        ],
      ],
    );

    // Pre-populate stale rows that should be evicted during rebuild.
    hs.upsertCharacter(makeCharacter({ playerId: 999, name: 'StaleGhost' }));
    hs.syncOrders([makeOrder({ orderId: 'pg_disbanded', name: 'Old Disbanded Order', tag: 'OLD' })]);

    const res = hs.rebuildFromTables({
      bannedAccountIds: new Set(['acc-banned']),
      requireCreated: true,
      requireLinked: true,
    });

    assert.deepEqual(res, { characters: 1, orders: 1, skipped: 4 });
    assert.deepEqual(hs.count(), { characters: 1, orders: 1 });
    assert.equal(hs.findByName('StaleGhost'), null);
    assert.equal(hs.findByName('DarkCheater'), null);
    assert.equal(hs.findByName('ShyHero'), null);
    assert.equal(hs.findByName('FreshArrival'), null);
    assert.equal(hs.findByName('GuestWanderer'), null);

    const aelric = hs.findByName('aelric');
    assert.ok(aelric);
    assert.equal(aelric.playerId, p1.id);
    assert.equal(aelric.className, 'Knight');
    assert.equal(aelric.level, 16);
    assert.equal(aelric.totalSkill, 152);
    assert.equal(aelric.orderId, 'pg_bay');
    assert.equal(aelric.admiraltyRankTitle, 'Lieutenant');

    const snap = hs.loadSnapshot();
    assert.equal(snap.orders.length, 1);
    assert.equal(snap.orders[0].orderId, 'pg_bay');
    assert.equal(snap.orders[0].leaderName, 'Aelric');
    assert.equal(snap.orders[0].combinedLevel, 16);
    assert.equal(snap.orders[0].combinedTotalSkill, 152);
    assert.equal(snap.orders[0].treasury, 14500);

    // Now rebuild with requireLinked: false and custom projectors.
    const res2 = hs.rebuildFromTables({
      bannedAccountIds: ['acc-banned'],
      requireCreated: true,
      requireLinked: false,
      projectCharacter(player) {
        return {
          playerId: player.id,
          name: player.name,
          className: player.rpg.character.className,
          race: player.rpg.character.race,
          level: player.rpg.character.level,
          totalSkill: Object.values(player.rpg.character.skills ?? {}).reduce((a, b) => a + b, 0),
          skills: player.rpg.character.skills ?? {},
        };
      },
      projectOrders(rawOrders, chars) {
        return rawOrders.map((o) => ({
          orderId: o.id,
          name: o.name,
          tag: o.tag,
          leaderName: 'Custom Leader',
          memberCount: Object.keys(o.members ?? {}).length,
          combinedLevel: chars.reduce((s, c) => s + c.level, 0),
          combinedTotalSkill: chars.reduce((s, c) => s + c.totalSkill, 0),
          treasury: o.treasury,
        }));
      },
    });
    assert.deepEqual(res2, { characters: 2, orders: 1, skipped: 3 });
    assert.ok(hs.findByName('GuestWanderer'));
    assert.equal(hs.loadSnapshot().orders[0].leaderName, 'Custom Leader');

    // close() on a borrowed DB handle must NOT close gameStore.db.
    hs.close();
    assert.equal(gameStore.db.isOpen, true);
    assert.ok(gameStore.findByAccount('acc-1'));
  } finally {
    gameStore.close();
  }
});

test('transactional rollback on invalid batch upsert and file-backed persistence across reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-hiscores-sqlite-'));
  const dbPath = join(dir, 'nested', 'hiscores.sqlite');
  try {
    const hs1 = openSqliteHiscoresStore(dbPath);
    try {
      hs1.upsertCharacter(makeCharacter({ playerId: 10, name: 'PersistentHero', level: 25, totalSkill: 1800 }));
      assert.throws(() => {
        hs1.upsertCharacters([
          makeCharacter({ playerId: 11, name: 'ShouldRollback' }),
          { playerId: 'not-a-number', name: 'Broken' },
        ]);
      });
      // Batch rolled back atomically: player 11 was not committed.
      assert.equal(hs1.findByName('ShouldRollback'), null);
      assert.deepEqual(hs1.count(), { characters: 1, orders: 0 });
    } finally {
      hs1.close();
    }

    const hs2 = openSqliteHiscoresStore(dbPath);
    try {
      const hero = hs2.findByName('persistenthero');
      assert.ok(hero);
      assert.equal(hero.playerId, 10);
      assert.equal(hero.level, 25);
      assert.equal(hero.totalSkill, 1800);
    } finally {
      hs2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

