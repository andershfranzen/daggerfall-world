import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadHiscoresSchemaSql,
  openPostgresHiscoresStore,
} from '../server/hiscores/postgres-store.js';

/**
 * In-memory mock PostgreSQL Pool + Client supporting:
 * - BEGIN / COMMIT / ROLLBACK with transactional state rollback
 * - Optional connect() omission to exercise sequential fallback
 * - hiscores & hiscores_orders CRUD + ON CONFLICT DO UPDATE + ANY($1) pruning
 * - players, account_characters, world_state, and optional accounts tables for rebuildFromTables
 * - Fault injection (`failNextQuery`) and query logging
 */
function createMockPgPool({
  withConnect = true,
  hasAccountsTable = true,
  players = [],
  accountCharacters = [],
  worldState = [],
  accounts = [],
} = {}) {
  let state = {
    hiscores: new Map(), // player_id -> row
    hiscoresOrders: new Map(), // order_id -> row
    players: new Map(players.map((p) => [Number(p.id), structuredClone(p)])),
    accountCharacters: new Map(accountCharacters.map((ac) => [Number(ac.player_id), structuredClone(ac)])),
    worldState: new Map(worldState.map((ws) => [String(ws.key), structuredClone(ws)])),
    accounts: new Map(accounts.map((a) => [Number(a.id), structuredClone(a)])),
  };

  const queryLog = [];
  let schemaApplications = 0;
  let endCalls = 0;
  let failOnCall = null;

  function cloneState(s) {
    return {
      hiscores: new Map([...s.hiscores].map(([k, v]) => [k, structuredClone(v)])),
      hiscoresOrders: new Map([...s.hiscoresOrders].map(([k, v]) => [k, structuredClone(v)])),
      players: new Map([...s.players].map(([k, v]) => [k, structuredClone(v)])),
      accountCharacters: new Map([...s.accountCharacters].map(([k, v]) => [k, structuredClone(v)])),
      worldState: new Map([...s.worldState].map(([k, v]) => [k, structuredClone(v)])),
      accounts: new Map([...s.accounts].map(([k, v]) => [k, structuredClone(v)])),
    };
  }

  async function executeSql(rawSql, params = [], clientCtx = null) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    queryLog.push({ sql, params });

    if (failOnCall && !/^ROLLBACK$/i.test(sql)) {
      if (failOnCall.remaining <= 1) {
        const err = failOnCall.error;
        failOnCall = null;
        throw err;
      }
      failOnCall.remaining -= 1;
    }

    // Transaction control
    if (/^BEGIN$/i.test(sql)) {
      if (clientCtx) clientCtx.txSnapshot = cloneState(state);
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql)) {
      if (clientCtx) clientCtx.txSnapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(sql)) {
      if (clientCtx?.txSnapshot) {
        state = clientCtx.txSnapshot;
        clientCtx.txSnapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }

    // DDL schema application
    if (/CREATE TABLE IF NOT EXISTS hiscores\b/i.test(sql)) {
      schemaApplications += 1;
      return { rows: [], rowCount: 0 };
    }

    // UPSERT hiscores
    if (/^INSERT INTO hiscores\s*\(/i.test(sql)) {
      const [
        player_id,
        name,
        name_key,
        class_name,
        race,
        level,
        total_skill,
        places_discovered,
        trips,
        quests_completed,
        monsters_slain,
        infamy,
        worst_region,
        admiralty_score,
        admiralty_rank_title,
        ships_sunk,
        order_id,
        order_tag,
        order_name,
        order_rank,
        skills,
        skill_milestones,
        guilds,
        milestone_at,
        updated_at,
      ] = params;
      state.hiscores.set(Number(player_id), {
        player_id: String(player_id), // simulate pg BIGINT string return
        name,
        name_key,
        class_name,
        race,
        level,
        total_skill,
        places_discovered,
        trips,
        quests_completed,
        monsters_slain,
        infamy,
        worst_region,
        admiralty_score,
        admiralty_rank_title,
        ships_sunk,
        order_id,
        order_tag,
        order_name,
        order_rank,
        skills: typeof skills === 'string' ? JSON.parse(skills) : skills,
        skill_milestones: typeof skill_milestones === 'string' ? JSON.parse(skill_milestones) : skill_milestones,
        guilds: typeof guilds === 'string' ? JSON.parse(guilds) : guilds,
        milestone_at: String(milestone_at),
        updated_at: String(updated_at),
      });
      return { rows: [], rowCount: 1 };
    }

    // DELETE single hiscores character
    if (/^DELETE FROM hiscores WHERE player_id = \$1$/i.test(sql)) {
      const id = Number(params[0]);
      const existed = state.hiscores.delete(id);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    // DELETE all hiscores
    if (/^DELETE FROM hiscores$/i.test(sql)) {
      const n = state.hiscores.size;
      state.hiscores.clear();
      return { rows: [], rowCount: n };
    }

    // DELETE stale hiscores
    if (/^DELETE FROM hiscores WHERE NOT \(player_id = ANY\(\$1::bigint\[\]\)\)$/i.test(sql)) {
      const keep = new Set((params[0] ?? []).map(Number));
      let removed = 0;
      for (const id of [...state.hiscores.keys()]) {
        if (!keep.has(id)) {
          state.hiscores.delete(id);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }

    // UPSERT hiscores_orders
    if (/^INSERT INTO hiscores_orders\s*\(/i.test(sql)) {
      const [
        order_id,
        name,
        name_key,
        tag,
        leader_name,
        member_count,
        combined_level,
        combined_total_skill,
        treasury,
        created_at,
        updated_at,
      ] = params;
      state.hiscoresOrders.set(String(order_id), {
        order_id: String(order_id),
        name,
        name_key,
        tag,
        leader_name,
        member_count,
        combined_level,
        combined_total_skill,
        treasury: String(treasury), // simulate pg BIGINT string return
        created_at: String(created_at),
        updated_at: String(updated_at),
      });
      return { rows: [], rowCount: 1 };
    }

    // DELETE all hiscores_orders
    if (/^DELETE FROM hiscores_orders$/i.test(sql)) {
      const n = state.hiscoresOrders.size;
      state.hiscoresOrders.clear();
      return { rows: [], rowCount: n };
    }

    // DELETE stale hiscores_orders
    if (/^DELETE FROM hiscores_orders WHERE NOT \(order_id = ANY\(\$1::text\[\]\)\)$/i.test(sql)) {
      const keep = new Set((params[0] ?? []).map(String));
      let removed = 0;
      for (const id of [...state.hiscoresOrders.keys()]) {
        if (!keep.has(id)) {
          state.hiscoresOrders.delete(id);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }

    // SELECT banned accounts
    if (/^SELECT id FROM accounts WHERE banned_at IS NOT NULL$/i.test(sql)) {
      if (!hasAccountsTable) {
        const err = new Error('relation "accounts" does not exist');
        err.code = '42P01';
        throw err;
      }
      const rows = [...state.accounts.values()]
        .filter((a) => a.banned_at !== null && a.banned_at !== undefined)
        .map((a) => ({ id: String(a.id) }));
      return { rows, rowCount: rows.length };
    }

    // SELECT players LEFT JOIN account_characters
    if (/^SELECT p\.id, p\.name, p\.created_at, p\.last_seen, p\.rpg,/i.test(sql)) {
      const rows = [...state.players.values()]
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((p) => {
          const ac = state.accountCharacters.get(Number(p.id));
          return {
            id: String(p.id),
            name: p.name,
            created_at: String(p.created_at ?? 0),
            last_seen: String(p.last_seen ?? 0),
            rpg: structuredClone(p.rpg ?? {}),
            account_id: ac ? String(ac.account_id) : null,
            account_username: ac ? ac.username : null,
            linked_at: ac ? String(ac.linked_at ?? 0) : null,
          };
        });
      return { rows, rowCount: rows.length };
    }

    // SELECT world_state pguild:%
    if (/^SELECT key, value, updated_at FROM world_state WHERE key LIKE 'pguild:%'/i.test(sql)) {
      const rows = [...state.worldState.values()]
        .filter((ws) => String(ws.key).startsWith('pguild:'))
        .sort((a, b) => String(a.key).localeCompare(String(b.key)))
        .map((ws) => ({
          key: ws.key,
          value: structuredClone(ws.value),
          updated_at: String(ws.updated_at ?? 0),
        }));
      return { rows, rowCount: rows.length };
    }

    // SELECT hiscores findByName
    if (/^SELECT .* FROM hiscores WHERE name_key = \$1/i.test(sql)) {
      const key = String(params[0]);
      const rows = [...state.hiscores.values()]
        .filter((r) => r.name_key === key)
        .sort(
          (a, b) =>
            b.total_skill - a.total_skill ||
            b.level - a.level ||
            Number(a.player_id) - Number(b.player_id)
        )
        .slice(0, 1)
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }

    // SELECT hiscores snapshot
    if (/^SELECT .* FROM hiscores ORDER BY/i.test(sql)) {
      const rows = [...state.hiscores.values()]
        .sort(
          (a, b) =>
            b.total_skill - a.total_skill ||
            b.level - a.level ||
            Number(a.milestone_at) - Number(b.milestone_at) ||
            Number(a.player_id) - Number(b.player_id)
        )
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }

    // SELECT hiscores_orders snapshot
    if (/^SELECT .* FROM hiscores_orders ORDER BY/i.test(sql)) {
      const rows = [...state.hiscoresOrders.values()]
        .sort(
          (a, b) =>
            b.member_count - a.member_count ||
            b.combined_level - a.combined_level ||
            Number(a.created_at) - Number(b.created_at) ||
            String(a.order_id).localeCompare(String(b.order_id))
        )
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }

    // COUNT(*)
    if (/^SELECT COUNT\(\*\) AS total FROM hiscores$/i.test(sql)) {
      return { rows: [{ total: String(state.hiscores.size) }], rowCount: 1 };
    }
    if (/^SELECT COUNT\(\*\) AS total FROM hiscores_orders$/i.test(sql)) {
      return { rows: [{ total: String(state.hiscoresOrders.size) }], rowCount: 1 };
    }

    throw new Error(`Mock PG pool received unhandled SQL: ${sql}`);
  }

  const pool = {
    query(sql, params) {
      return executeSql(sql, params, null);
    },
    async end() {
      endCalls += 1;
    },
    // Test helpers
    _queryLog: queryLog,
    _getSchemaApplications: () => schemaApplications,
    _getEndCalls: () => endCalls,
    _failAfter: (count, error) => {
      failOnCall = { remaining: count, error };
    },
    _state: () => state,
  };

  if (withConnect) {
    pool.connect = async () => {
      const clientCtx = { txSnapshot: null };
      return {
        query(sql, params) {
          return executeSql(sql, params, clientCtx);
        },
        release() {},
      };
    };
  }

  return pool;
}

describe('schema-hiscores.sql DDL', () => {
  it('loads additive idempotent PostgreSQL DDL with all required tables and indexes', () => {
    const sql = loadHiscoresSchemaSql();
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS hiscores'));
    assert.ok(sql.includes('player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE'));
    assert.ok(sql.includes('skills JSONB NOT NULL DEFAULT \'{}\'::jsonb'));
    assert.ok(sql.includes('skill_milestones JSONB NOT NULL DEFAULT \'{}\'::jsonb'));
    assert.ok(sql.includes('guilds JSONB NOT NULL DEFAULT \'{}\'::jsonb'));

    for (const idx of [
      'idx_hiscores_name_key',
      'idx_hiscores_overall',
      'idx_hiscores_level',
      'idx_hiscores_exploration',
      'idx_hiscores_quests',
      'idx_hiscores_slayer',
      'idx_hiscores_wanted',
      'idx_hiscores_admiralty',
      'USING GIN (guilds)',
    ]) {
      assert.ok(sql.includes(idx), `expected schema to contain ${idx}`);
    }

    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS hiscores_orders'));
    assert.ok(sql.includes('order_id TEXT PRIMARY KEY'));
    assert.ok(sql.includes('treasury BIGINT NOT NULL DEFAULT 0'));
    assert.ok(sql.includes('member_count DESC'));
    assert.ok(sql.includes('combined_level DESC'));
    assert.ok(sql.includes('treasury DESC'));
  });
});

describe('openPostgresHiscoresStore', () => {
  it('applies schema by default and can skip schema with applySchema: false', async () => {
    const poolA = createMockPgPool();
    const storeA = await openPostgresHiscoresStore(poolA);
    assert.equal(storeA.engine, 'postgres');
    assert.equal(storeA.pool, poolA);
    assert.equal(poolA._getSchemaApplications(), 1);

    const poolB = createMockPgPool();
    const storeB = await openPostgresHiscoresStore(poolB, { applySchema: false });
    assert.equal(storeB.engine, 'postgres');
    assert.equal(poolB._getSchemaApplications(), 0);
  });

  it('rejects invalid poolOrUrl values', async () => {
    await assert.rejects(() => openPostgresHiscoresStore(null), /requires a pg Pool/);
    await assert.rejects(() => openPostgresHiscoresStore('   '), /requires a pg Pool/);
  });

  it('upserts, updates, finds by name, counts, removes, and snapshots characters', async () => {
    let clock = 1700000000000;
    const pool = createMockPgPool();
    const store = await openPostgresHiscoresStore(pool, { now: () => clock });

    const alaric = await store.upsertCharacter({
      playerId: 101,
      name: 'Alaric of Daggerfall',
      className: 'Spellsword',
      race: 'Breton',
      level: 14,
      totalSkill: 420,
      placesDiscovered: 18,
      trips: 32,
      questsCompleted: 9,
      monstersSlain: 87,
      infamy: 12,
      worstRegion: 'Wayrest',
      admiraltyScore: 250,
      admiraltyRankTitle: 'Lieutenant',
      shipsSunk: 4,
      orderId: 'iron-circle',
      orderTag: 'IRC',
      orderName: 'Iron Circle',
      orderRank: 'Captain',
      skills: { LongBlade: 65, Destruction: 58 },
      skillMilestones: { LongBlade: 1699999000000 },
      guilds: { fightersGuild: { rank: 4 }, magesGuild: { rank: 3 } },
      milestoneAt: 1699999500000,
    });

    assert.equal(alaric.playerId, 101);
    assert.equal(alaric.nameKey, 'alaric of daggerfall');
    assert.equal(alaric.updatedAt, clock);

    // Update existing record on conflict
    clock += 5000;
    await store.upsertCharacter({
      ...alaric,
      level: 15,
      totalSkill: 455,
      updatedAt: clock,
    });

    assert.deepEqual(await store.count(), { characters: 1, orders: 0 });

    const found = await store.findByName('  ALARIC OF DAGGERFALL  ');
    assert.ok(found);
    assert.equal(found.playerId, 101);
    assert.equal(found.level, 15);
    assert.equal(found.totalSkill, 455);
    assert.deepEqual(found.skills, { LongBlade: 65, Destruction: 58 });
    assert.deepEqual(found.guilds, { fightersGuild: { rank: 4 }, magesGuild: { rank: 3 } });
    assert.equal(found.admiraltyRankTitle, 'Lieutenant');
    assert.equal(found.worstRegion, 'Wayrest');

    assert.equal(await store.findByName('Unknown Hero'), null);
    assert.equal(await store.findByName('   '), null);

    const snap = await store.loadSnapshot();
    assert.equal(snap.generatedAt, clock);
    assert.equal(snap.characters.length, 1);
    assert.equal(snap.orders.length, 0);
    assert.equal(snap.characters[0].name, 'Alaric of Daggerfall');

    assert.equal(await store.removeCharacter(101), true);
    assert.equal(await store.removeCharacter(101), false);
    assert.equal(await store.removeCharacter(null), false);
    assert.deepEqual(await store.count(), { characters: 0, orders: 0 });
  });

  it('upsertCharacters uses a transaction when pool.connect exists and rolls back on failure', async () => {
    const pool = createMockPgPool({ withConnect: true });
    const store = await openPostgresHiscoresStore(pool);

    const countInserted = await store.upsertCharacters([
      { playerId: 1, name: 'Bryn', className: 'Knight', race: 'Nord', level: 8, totalSkill: 200 },
      { playerId: 2, name: 'Caelia', className: 'Mage', race: 'High Elf', level: 10, totalSkill: 260 },
    ]);
    assert.equal(countInserted, 2);
    assert.ok(pool._queryLog.some((q) => q.sql === 'BEGIN'));
    assert.ok(pool._queryLog.some((q) => q.sql === 'COMMIT'));
    assert.deepEqual(await store.count(), { characters: 2, orders: 0 });

    // Inject failure on 2nd insert inside transaction -> should rollback both writes in this batch
    pool._failAfter(3, new Error('simulated pg write error')); // 1=BEGIN, 2=first insert, 3=second insert
    await assert.rejects(
      () =>
        store.upsertCharacters([
          { playerId: 3, name: 'Dorian', className: 'Rogue', race: 'Khajiit', level: 5, totalSkill: 120 },
          { playerId: 4, name: 'Elowen', className: 'Archer', race: 'Wood Elf', level: 6, totalSkill: 150 },
        ]),
      /simulated pg write error/
    );
    assert.ok(pool._queryLog.some((q) => q.sql === 'ROLLBACK'));
    assert.deepEqual(await store.count(), { characters: 2, orders: 0 });
    assert.equal(await store.findByName('Dorian'), null);

    // Empty batch is a no-op
    assert.equal(await store.upsertCharacters([]), 0);
  });

  it('upsertCharacters falls back sequentially when pool.connect is unavailable', async () => {
    const pool = createMockPgPool({ withConnect: false });
    const store = await openPostgresHiscoresStore(pool);

    const n = await store.upsertCharacters([
      { playerId: 10, name: 'Faelan', className: 'Ranger', race: 'Redguard', level: 7, totalSkill: 190 },
      { playerId: 11, name: 'Gwen', className: 'Healer', race: 'Breton', level: 9, totalSkill: 240 },
    ]);
    assert.equal(n, 2);
    assert.equal(pool._queryLog.some((q) => q.sql === 'BEGIN'), false);
    assert.deepEqual(await store.count(), { characters: 2, orders: 0 });
  });

  it('syncOrders upserts active orders and prunes stale ones', async () => {
    const pool = createMockPgPool();
    const store = await openPostgresHiscoresStore(pool, { now: () => 1700000001000 });

    const r1 = await store.syncOrders([
      {
        orderId: 'iron-circle',
        name: 'Iron Circle',
        tag: 'IRC',
        leaderName: 'Alaric',
        memberCount: 5,
        combinedLevel: 60,
        combinedTotalSkill: 1800,
        treasury: 25000,
        createdAt: 1690000000000,
      },
      {
        orderId: 'silver-dawn',
        name: 'Silver Dawn',
        tag: 'SLV',
        leaderName: 'Bryn',
        memberCount: 3,
        combinedLevel: 30,
        combinedTotalSkill: 900,
        treasury: 10000,
        createdAt: 1695000000000,
      },
    ]);
    assert.deepEqual(r1, { upserted: 2, removed: 0 });
    assert.deepEqual(await store.count(), { characters: 0, orders: 2 });

    // Remove silver-dawn, update iron-circle, add golden-oath
    const r2 = await store.syncOrders([
      {
        orderId: 'iron-circle',
        name: 'Iron Circle',
        tag: 'IRC',
        leaderName: 'Alaric',
        memberCount: 6,
        combinedLevel: 72,
        combinedTotalSkill: 2100,
        treasury: 32000,
        createdAt: 1690000000000,
      },
      {
        orderId: 'golden-oath',
        name: 'Golden Oath',
        tag: 'GLD',
        leaderName: 'Caelia',
        memberCount: 8,
        combinedLevel: 90,
        combinedTotalSkill: 2800,
        treasury: 50000,
        createdAt: 1698000000000,
      },
    ]);
    assert.deepEqual(r2, { upserted: 2, removed: 1 });

    const snap = await store.loadSnapshot();
    assert.deepEqual(
      snap.orders.map((o) => o.orderId),
      ['golden-oath', 'iron-circle']
    );
    assert.equal(snap.orders[0].treasury, 50000);
    assert.equal(snap.orders[1].memberCount, 6);

    // Syncing empty array clears all orders
    const r3 = await store.syncOrders([]);
    assert.deepEqual(r3, { upserted: 0, removed: 2 });
    assert.deepEqual(await store.count(), { characters: 0, orders: 0 });
  });

  it('rebuildFromTables excludes banned accounts (DB + option), enforces filters, and prunes stale entries', async () => {
    const pool = createMockPgPool({
      hasAccountsTable: true,
      accounts: [
        { id: 1, banned_at: null },
        { id: 2, banned_at: 1700000000000 }, // banned in DB
        { id: 3, banned_at: null }, // will be passed via bannedAccountIds
        { id: 4, banned_at: null },
      ],
      players: [
        {
          id: 10,
          name: 'ValidHero',
          created_at: 1690000000000,
          last_seen: 1700000000000,
          rpg: {
            created: true,
            className: 'Knight',
            race: 'Breton',
            level: 12,
            skills: { LongBlade: 70, CriticalStrike: 50 },
            orderId: 'iron-circle',
          },
        },
        {
          id: 11,
          name: 'DbBannedHero',
          created_at: 1690000000000,
          last_seen: 1700000000000,
          rpg: { created: true, className: 'Thief', race: 'Khajiit', level: 20, skills: { Stealth: 90 } },
        },
        {
          id: 12,
          name: 'OptBannedHero',
          created_at: 1690000000000,
          last_seen: 1700000000000,
          rpg: { created: true, className: 'Mage', race: 'High Elf', level: 18, skills: { Destruction: 85 } },
        },
        {
          id: 13,
          name: 'UncreatedHero',
          created_at: 1690000000000,
          last_seen: 1700000000000,
          rpg: { created: false, className: 'Bard', race: 'Nord', level: 1, skills: {} },
        },
        {
          id: 14,
          name: 'UnlinkedHero',
          created_at: 1690000000000,
          last_seen: 1700000000000,
          rpg: { created: true, className: 'Warrior', race: 'Redguard', level: 9, skills: { Axe: 55 } },
        },
      ],
      accountCharacters: [
        { player_id: 10, account_id: '1', username: 'valid_user', linked_at: 1690000000000 },
        { player_id: 11, account_id: '2', username: 'db_banned', linked_at: 1690000000000 },
        { player_id: 12, account_id: '3', username: 'opt_banned', linked_at: 1690000000000 },
        { player_id: 13, account_id: '4', username: 'uncreated', linked_at: 1690000000000 },
        // player 14 intentionally unlinked
      ],
      worldState: [
        {
          key: 'pguild:iron-circle',
          value: {
            id: 'iron-circle',
            name: 'Iron Circle',
            tag: 'IRC',
            leaderName: 'ValidHero',
            treasury: 12000,
            createdAt: 1691000000000,
          },
          updated_at: 1700000000000,
        },
        {
          key: 'other:ignored',
          value: { foo: 'bar' },
          updated_at: 1700000000000,
        },
      ],
    });

    const store = await openPostgresHiscoresStore(pool, { now: () => 1700000005000 });

    // Seed a stale character and stale order to verify rebuild prunes them
    await store.upsertCharacter({
      playerId: 999,
      name: 'StaleGhost',
      className: 'Mage',
      race: 'Breton',
      level: 50,
      totalSkill: 999,
    });
    await store.syncOrders([
      {
        orderId: 'stale-order',
        name: 'Stale Order',
        tag: 'STL',
        leaderName: 'Ghost',
        memberCount: 1,
      },
    ]);

    const result = await store.rebuildFromTables({
      bannedAccountIds: ['3'],
      requireCreated: true,
      requireLinked: true,
    });

    assert.deepEqual(result, { characters: 1, orders: 1, skipped: 4 });
    assert.deepEqual(await store.count(), { characters: 1, orders: 1 });

    const snap = await store.loadSnapshot();
    assert.equal(snap.characters[0].playerId, 10);
    assert.equal(snap.characters[0].name, 'ValidHero');
    assert.equal(snap.characters[0].totalSkill, 120);
    assert.equal(await store.findByName('StaleGhost'), null);
    assert.equal(await store.findByName('DbBannedHero'), null);
    assert.equal(await store.findByName('OptBannedHero'), null);

    assert.equal(snap.orders.length, 1);
    assert.equal(snap.orders[0].orderId, 'iron-circle');
    assert.equal(snap.orders[0].memberCount, 1);
    assert.equal(snap.orders[0].combinedLevel, 12);
    assert.equal(snap.orders[0].combinedTotalSkill, 120);
    assert.equal(snap.orders[0].treasury, 12000);
  });

  it('rebuildFromTables gracefully handles missing accounts table and custom projectors', async () => {
    const pool = createMockPgPool({
      hasAccountsTable: false,
      players: [
        { id: 20, name: 'Alden', created_at: 100, last_seen: 200, rpg: { created: true, level: 5 } },
        { id: 21, name: 'SkipMe', created_at: 100, last_seen: 200, rpg: { created: true, level: 2 } },
        { id: 22, name: 'BannedByOption', created_at: 100, last_seen: 200, rpg: { created: true, level: 9 } },
      ],
      accountCharacters: [
        { player_id: 22, account_id: '77', username: 'banned77', linked_at: 100 },
      ],
      worldState: [
        { key: 'pguild:wayrest-guard', value: { name: 'Wayrest Guard', tag: 'WRG', leaderName: 'Alden' }, updated_at: 300 },
      ],
    });

    const store = await openPostgresHiscoresStore(pool);
    const result = await store.rebuildFromTables({
      bannedAccountIds: new Set([77]),
      projectCharacter(player) {
        if (player.name === 'SkipMe') return null;
        return {
          playerId: player.id,
          name: player.name,
          className: 'CustomClass',
          race: 'CustomRace',
          level: player.rpg.level,
          totalSkill: 333,
        };
      },
      projectOrders(rawOrders, chars) {
        return rawOrders.map((o) => ({
          orderId: o.orderId,
          name: o.value.name,
          tag: o.value.tag,
          leaderName: o.value.leaderName,
          memberCount: chars.length,
          combinedLevel: chars.reduce((s, c) => s + c.level, 0),
          combinedTotalSkill: chars.reduce((s, c) => s + c.totalSkill, 0),
          treasury: 500,
        }));
      },
    });

    assert.deepEqual(result, { characters: 1, orders: 1, skipped: 2 });
    const alden = await store.findByName('alden');
    assert.equal(alden.className, 'CustomClass');
    assert.equal(alden.totalSkill, 333);
  });

  it('close() only calls pool.end() when the store owns the pool', async () => {
    // External injected pool -> ownsPool = false
    const externalPool = createMockPgPool();
    const externalStore = await openPostgresHiscoresStore(externalPool);
    await externalStore.close();
    assert.equal(externalPool._getEndCalls(), 0);

    // URL-created pool -> ownsPool = true
    const ownedPool = createMockPgPool();
    let receivedUrl = null;
    const ownedStore = await openPostgresHiscoresStore('postgres://user:pass@localhost:5432/daggerfall', {
      createPool: (url) => {
        receivedUrl = url;
        return ownedPool;
      },
    });
    assert.equal(receivedUrl, 'postgres://user:pass@localhost:5432/daggerfall');
    await ownedStore.close();
    await ownedStore.close(); // idempotent
    assert.equal(ownedPool._getEndCalls(), 1);
  });
});
