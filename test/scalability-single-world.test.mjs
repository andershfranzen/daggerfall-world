// Single-world scalability tests & benchmarks:
//   1. 500-player packed-city SpatialGrid AOI culling (priority ordering, crowd cap, latency benchmark).
//   2. Deterministic single-world ZoneRouter (zero shards, interior co-location, HRW stability).
//   3. Multi-worker WorldBus (MemoryBus + PostgresBus mock): cross-worker chat relay, signed one-time
//      handoff tickets, and unified public-world-map aggregation across workers.
//   4. Comfortable human-conversation chat rate limits & server/main.js uncapped MAX_PLAYERS=0 support.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SpatialGrid,
  createSpatialGrid,
  createSceneSpatialIndex,
  DEFAULT_CELL_SIZE,
  DEFAULT_VIEW_RADIUS,
  DEFAULT_MAX_VISIBLE_PEERS,
} from '../server/scale/spatial-grid.js';
import { canonicalZone, createZoneRouter } from '../server/scale/zone-router.js';
import {
  createMemoryHub,
  createMemoryBus,
  createPostgresBus,
  PG_NOTIFY_MAX_BYTES,
} from '../server/scale/world-bus.js';
import {
  publicWorldMap,
  mergeWorldMapSnapshots,
  projectOnlineWorldMap,
} from '../server/public-world-map.js';
import {
  CHAT_LIMITS,
  CHAT_RATE_PER_SEC,
  CHAT_BURST,
  chatLimitFor,
  createChatLimiter,
} from '../server/rpg/social/chat.js';

// Deterministic PRNG (Mulberry32) so 500-player benchmarks & assertions are 100% reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SpatialGrid AOI culling (500-player single-city benchmark)', () => {
  test('priority peers (party/trade/duel/combat) always appear first regardless of distance or crowd cap', () => {
    const grid = createSpatialGrid({ cellSize: 32, viewRadius: 64, maxVisiblePeers: 8 });
    const viewer = { id: 1, x: 0, z: 0 };
    grid.upsert(viewer);

    // 40 crowded bystanders right around the viewer (within 5..25 m).
    for (let i = 2; i <= 41; i++) {
      const angle = (i / 40) * Math.PI * 2;
      const r = 5 + (i % 20);
      grid.upsert({ id: i, x: Math.cos(angle) * r, z: Math.sin(angle) * r });
    }

    // 3 priority partners: one far away (250 m, outside viewRadius!), one mid-range, one close.
    const partyFar = { id: 901, x: 250, z: 0 };
    const tradePartner = { id: 902, x: 40, z: 0 };
    const duelOpponent = { id: 903, x: 10, z: 0 };
    grid.upsert(partyFar);
    grid.upsert(tradePartner);
    grid.upsert(duelOpponent);

    // An arriving player should be hidden from others by default.
    grid.upsert({ id: 999, x: 1, z: 1, arriving: true });

    const visible = grid.query(viewer, { priorityIds: [partyFar.id, tradePartner.id, duelOpponent.id] });
    assert.equal(visible.length, 8, 'total peers capped at maxVisiblePeers');
    assert.deepEqual(
      visible.slice(0, 3).map((p) => p.id),
      [903, 902, 901],
      'priority peers come first, ordered by distance ascending (including out-of-radius party member)',
    );
    assert.ok(!visible.some((p) => p.id === 999), 'arriving player is hidden');

    // Remaining 5 crowd slots must be strictly sorted by distance ascending, then id ascending.
    const crowd = visible.slice(3);
    assert.equal(crowd.length, 5);
    for (let i = 1; i < crowd.length; i++) {
      const dPrev = crowd[i - 1].x ** 2 + crowd[i - 1].z ** 2;
      const dCurr = crowd[i].x ** 2 + crowd[i].z ** 2;
      assert.ok(dPrev < dCurr || (dPrev === dCurr && crowd[i - 1].id < crowd[i].id));
    }

    // If priority count exceeds maxVisiblePeers, ALL priority peers are still included.
    const tight = grid.query(viewer, { maxVisiblePeers: 2, priorityIds: [901, 902, 903] });
    assert.deepEqual(tight.map((p) => p.id), [903, 902, 901]);
  });

  test('incremental movement across cell boundaries, removal, and SceneSpatialIndex scene transitions', () => {
    const index = createSceneSpatialIndex({ cellSize: 32, viewRadius: 64, maxVisiblePeers: 32 });
    const a = { id: 1, x: 0, z: 0 };
    const b = { id: 2, x: 10, z: 0 };
    index.upsert('town:Daggerfall/Daggerfall', a);
    index.upsert('town:Daggerfall/Daggerfall', b);
    assert.deepEqual(index.query('town:Daggerfall/Daggerfall', a).map((p) => p.id), [2]);

    // Move B far outside viewRadius across multiple cells.
    b.x = 200;
    b.z = 200;
    index.upsert('town:Daggerfall/Daggerfall', b);
    assert.deepEqual(index.query('town:Daggerfall/Daggerfall', a), []);

    // Move B into a tavern interior: removed from town grid automatically.
    b.x = 2;
    b.z = 2;
    index.upsert('interior:Daggerfall/Daggerfall/1,2/3', b);
    assert.equal(index.sceneCount(), 2);
    assert.equal(index.gridOf('town:Daggerfall/Daggerfall').size, 1);
    assert.equal(index.gridOf('interior:Daggerfall/Daggerfall/1,2/3').size, 1);

    // Removing last player in interior cleans up the empty scene grid.
    index.remove(b);
    assert.equal(index.sceneCount(), 1);
    assert.equal(index.size(), 1);
  });

  test('500 players in one packed city: AOI queries stay fast, bounded, and deterministic', () => {
    const N = 500;
    const rng = mulberry32(0xdf00500);
    const grid = new SpatialGrid({
      cellSize: DEFAULT_CELL_SIZE,
      viewRadius: DEFAULT_VIEW_RADIUS,
      maxVisiblePeers: DEFAULT_MAX_VISIBLE_PEERS,
    });

    // Scatter 500 players across a 600 m x 600 m Daggerfall city plaza.
    const players = [];
    for (let i = 1; i <= N; i++) {
      const p = {
        id: i,
        name: `Hero${i}`,
        x: (rng() - 0.5) * 600,
        z: (rng() - 0.5) * 600,
      };
      players.push(p);
      grid.upsert(p);
    }
    assert.equal(grid.size, N);

    // Assign 5-player parties so every viewer exercises the priority path too.
    const partyOf = (id) => {
      const base = Math.floor((id - 1) / 5) * 5 + 1;
      return [base, base + 1, base + 2, base + 3, base + 4];
    };

    // Warm up JIT once.
    for (let i = 0; i < 20; i++) grid.query(players[i], { priorityIds: partyOf(players[i].id) });

    // Measure full tick: move all 500 players + query AOI for all 500 viewers.
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const p = players[i];
      p.x += (rng() - 0.5) * 2;
      p.z += (rng() - 0.5) * 2;
      grid.upsert(p);
    }
    const tUpdateDone = performance.now();

    let totalPeersReturned = 0;
    let maxReturned = 0;
    for (let i = 0; i < N; i++) {
      const viewer = players[i];
      const party = partyOf(viewer.id);
      const visible = grid.query(viewer, { priorityIds: party });
      totalPeersReturned += visible.length;
      if (visible.length > maxReturned) maxReturned = visible.length;

      // Every other party member must be visible in the leading slots.
      const visibleIds = new Set(visible.map((v) => v.id));
      for (const mid of party) {
        if (mid !== viewer.id) assert.ok(visibleIds.has(mid), `party member ${mid} visible to ${viewer.id}`);
      }
      assert.ok(visible.length <= DEFAULT_MAX_VISIBLE_PEERS, `capped at ${DEFAULT_MAX_VISIBLE_PEERS}`);
    }
    const tQueryDone = performance.now();

    const updateMs = tUpdateDone - t0;
    const queryMs = tQueryDone - tUpdateDone;
    const totalMs = tQueryDone - t0;
    const avgVisible = totalPeersReturned / N;

    // Emit clear benchmark metrics for test logs & architecture docs.
    console.log(
      `[bench] 500-player single-city AOI: update=${updateMs.toFixed(2)}ms, queryAll500=${queryMs.toFixed(2)}ms, total=${totalMs.toFixed(2)}ms, avgVisible=${avgVisible.toFixed(1)}, maxVisible=${maxReturned}, cells=${grid.cellCount}`,
    );

    assert.ok(totalMs < 250, `500-player AOI tick should stay well within budget, got ${totalMs.toFixed(2)}ms`);
    assert.ok(maxReturned <= DEFAULT_MAX_VISIBLE_PEERS);
    assert.ok(avgVisible > 10 && avgVisible <= DEFAULT_MAX_VISIBLE_PEERS);
  });
});

describe('Single-world ZoneRouter (deterministic partitioning, zero shards)', () => {
  test('same town, numeric slot, interior, building, and regional dungeon always land on the same worker', () => {
    const router = createZoneRouter({
      workers: [
        { id: 'zone-west', url: 'wss://west.iliac.test/ws' },
        { id: 'zone-east', url: 'wss://east.iliac.test/ws' },
        { id: 'zone-south', url: 'wss://south.iliac.test/ws' },
      ],
    });

    const daggerfallPlaces = [
      'town:Daggerfall/Gothway Garden',
      'town:Daggerfall/Daggerfall',
      'town:17/197',
      'interior:Daggerfall/Gothway Garden/1,2/3',
      'interior:17/197/1,2/3',
      'building:Daggerfall/Gothway Garden/b:1,2:3',
      "dungeon:Daggerfall/Privateer's Hold",
    ];
    const routes = daggerfallPlaces.map((loc) => router.route(loc));
    const owner = routes[0].workerId;
    for (const r of routes) {
      assert.equal(r.zoneKey, 'region:daggerfall');
      assert.equal(r.workerId, owner, `${r.kind} must co-locate with Daggerfall town`);
      assert.equal(router.owns(owner, daggerfallPlaces[0]), true);
    }

    // Wilderness & sea pixels group into contiguous sectors deterministically.
    const w1 = canonicalZone('wilderness:100,150');
    const w2 = canonicalZone('wilderness:105,155');
    const wFar = canonicalZone('wilderness:400,450');
    assert.equal(w1.zoneKey, w2.zoneKey, 'adjacent wilderness pixels share a sector');
    assert.notEqual(w1.zoneKey, wFar.zoneKey, 'distant wilderness pixels use distinct sectors');

    const s1 = canonicalZone('sea:215,245');
    const s2 = canonicalZone('sea:220,250');
    assert.equal(s1.zoneKey, s2.zoneKey, 'adjacent sea pixels share a sea sector');
  });

  test('explicit region overrides & HRW minimal disruption when scaling workers', () => {
    const r2 = createZoneRouter({
      workers: ['w0', 'w1'],
      overrides: { Daggerfall: 'w0', Wayrest: 'w1' },
    });
    assert.equal(r2.route('town:Daggerfall/Daggerfall').workerId, 'w0');
    assert.equal(r2.route('town:Wayrest/Wayrest').workerId, 'w1');
    const handoff = r2.needsHandoff('w0', 'town:Wayrest/Wayrest');
    assert.equal(handoff.required, true);
    assert.equal(handoff.fromWorkerId, 'w0');
    assert.equal(handoff.toWorkerId, 'w1');

    // Adding a 3rd worker should preserve roughly 2/3 of zone assignments (HRW stability).
    const before = createZoneRouter({ workers: ['w0', 'w1'] });
    const after = createZoneRouter({ workers: ['w0', 'w1', 'w2'] });
    let unchanged = 0;
    for (let i = 0; i < 120; i++) {
      const loc = `wilderness:${(i * 32) % 990},${Math.floor(i / 10) * 32}`;
      if (before.route(loc).workerId === after.route(loc).workerId) unchanged++;
    }
    assert.ok(unchanged >= 60 && unchanged <= 105, `HRW should keep ~67% of zones stable, kept ${unchanged}/120`);
  });
});

describe('Multi-worker WorldBus & unified public-world-map aggregation', () => {
  test('2 zone workers share chat (global/region/party/whisper), one-time handoff tickets, and unified map', async () => {
    let clock = Date.UTC(2026, 10, 25, 12, 0, 0);
    const now = () => clock;
    const secret = 'shared-cluster-hmac-secret-for-iliac-bay';
    const hub = createMemoryHub();

    const router = createZoneRouter({
      workers: [
        { id: 'worker-west', url: 'wss://west.iliac.test/ws', regions: ['Daggerfall'] },
        { id: 'worker-east', url: 'wss://east.iliac.test/ws', regions: ['Wayrest'] },
      ],
    });

    const busWest = createMemoryBus({ hub, workerId: 'worker-west', secret, now, ticketTtlMs: 10_000, presenceTtlMs: 30_000 });
    const busEast = createMemoryBus({ hub, workerId: 'worker-east', secret, now, ticketTtlMs: 10_000, presenceTtlMs: 30_000 });

    const eastInbox = [];
    const westInbox = [];
    busEast.onChat((msg) => eastInbox.push(msg));
    busWest.onChat((msg) => westInbox.push(msg));

    // 1. Cross-worker chat relay (global, party, whisper, region) without self-echo.
    await busWest.publishChat({ channel: 'global', fromId: 1, fromName: 'Ada', text: 'Greetings Iliac Bay!' });
    await busWest.publishChat({ channel: 'party', fromId: 1, fromName: 'Ada', partyId: 'party_1', text: 'Meet at Wayrest' });
    await busWest.publishChat({ channel: 'whisper', fromId: 1, fromName: 'Ada', targetId: 2, targetName: 'Bram', text: 'Psst' });
    await busEast.publishChat({ channel: 'region', fromId: 2, fromName: 'Bram', region: 'Wayrest', text: 'Market open' });

    assert.equal(eastInbox.length, 3);
    assert.deepEqual(eastInbox.map((m) => m.channel), ['global', 'party', 'whisper']);
    assert.equal(westInbox.length, 1);
    assert.equal(westInbox[0].channel, 'region');
    assert.equal(westInbox[0].region, 'Wayrest');

    // 2. Seamless zone handoff ticket when Ada travels from Daggerfall (worker-west) to Wayrest (worker-east).
    const dest = router.needsHandoff('worker-west', 'town:Wayrest/Wayrest');
    assert.equal(dest.required, true);
    assert.equal(dest.toWorkerId, 'worker-east');

    const issued = await busWest.issueHandoff({
      playerId: 1,
      accountId: 42,
      name: 'Ada',
      toWorkerId: dest.toWorkerId,
      targetLocation: 'town:Wayrest/Wayrest',
      state: { hp: 85, gold: 250 },
    });

    // Wrong destination worker cannot redeem.
    await assert.rejects(() => busWest.redeemHandoff(issued.token), /targets worker "worker-east"/);

    // Tampered token fails HMAC verification.
    const tampered = issued.token.slice(0, -2) + (issued.token.endsWith('aa') ? 'bb' : 'aa');
    await assert.rejects(() => busEast.redeemHandoff(tampered), /signature/);

    // Valid destination worker redeems cleanly once.
    const redeemed = await busEast.redeemHandoff(issued.token);
    assert.equal(redeemed.playerId, 1);
    assert.equal(redeemed.accountId, 42);
    assert.equal(redeemed.fromWorkerId, 'worker-west');
    assert.equal(redeemed.toWorkerId, 'worker-east');
    assert.equal(redeemed.targetLocation, 'town:Wayrest/Wayrest');
    assert.deepEqual(redeemed.state, { hp: 85, gold: 250 });

    // Replay is rejected on BOTH workers (nonce burned across the bus).
    await assert.rejects(() => busEast.redeemHandoff(issued.token), /already redeemed/);

    // Expired ticket is rejected.
    const expiring = await busWest.issueHandoff({
      playerId: 3,
      name: 'Cyra',
      toWorkerId: 'worker-east',
      targetLocation: 'town:Wayrest/Wayrest',
      ttlMs: 5_000,
    });
    clock += 6_000;
    await assert.rejects(() => busEast.redeemHandoff(expiring.token), /expired/);

    // 3. Unified single-world public-world-map aggregation across both workers.
    const westPlayers = [
      { id: 1, name: 'Ada', rpg: { location: 'town:Daggerfall/Daggerfall' } },
      { id: 2, name: 'Bram', rpg: { location: 'interior:Daggerfall/Daggerfall/1,2/3' } },
      { id: 3, name: 'Cyra', rpg: { location: 'town:Daggerfall/Gothway Garden' } },
    ];
    const eastPlayers = [
      { id: 4, name: 'Dorran', rpg: { location: 'town:Wayrest/Wayrest' } },
      { id: 5, name: 'Eskel', rpg: { location: 'wilderness:207,213' } }, // same pixel as Daggerfall town!
      { id: 6, name: 'Fen', rpg: { location: 'town:Nowhere/Unplaced' } },
    ];

    const westLocal = publicWorldMap(westPlayers, null, clock);
    const eastLocal = publicWorldMap(eastPlayers, null, clock);
    await busWest.publishPresence(westLocal);
    await busEast.publishPresence(eastLocal);

    // West worker projects the unified world map using its local players + busWest remote snapshots.
    const unifiedFromWest = publicWorldMap(westPlayers, null, clock, null, busWest);
    const unifiedFromEast = projectOnlineWorldMap({ players: eastPlayers, now: clock, worldBus: busEast });
    const unifiedDirect = mergeWorldMapSnapshots([westLocal, eastLocal], clock);

    assert.deepEqual(unifiedFromWest, unifiedFromEast, 'every worker serves the exact same unified world map');
    assert.deepEqual(unifiedFromWest, unifiedDirect);
    assert.equal(unifiedFromWest.online, 6);
    assert.equal(unifiedFromWest.unplaced, 1);

    // Daggerfall pixel (207, 213) merges 2 west players (1 inside) + 1 east wilderness player -> count 3, inside 1, kind town!
    const dfLoc = unifiedFromWest.locations.find((l) => l.id === 'town:Daggerfall/Daggerfall');
    assert.ok(dfLoc);
    assert.equal(dfLoc.kind, 'town');
    assert.equal(dfLoc.count, 3);
    assert.equal(dfLoc.inside, 1);

    // Wayrest & Gothway Garden both present in the unified map.
    assert.equal(unifiedFromWest.locations.find((l) => l.id === 'town:Wayrest/Wayrest')?.count, 1);
    assert.equal(unifiedFromWest.locations.find((l) => l.id === 'town:Daggerfall/Gothway Garden')?.count, 1);

    // Privacy invariant: zero player names leak into the public map payload.
    const serialized = JSON.stringify(unifiedFromWest);
    for (const secretName of ['Ada', 'Bram', 'Cyra', 'Dorran', 'Eskel', 'Fen']) {
      assert.ok(!serialized.includes(secretName));
    }

    // Stale presence expires cleanly after presenceTtlMs.
    clock += 31_000;
    assert.equal(busWest.getRemoteSnapshots().length, 0);

    await busWest.close();
    await busEast.close();
  });

  test('createPostgresBus uses LISTEN/pg_notify, validates channel, and enforces payload size limit', async () => {
    // Minimal mock PostgreSQL client implementing query() + EventEmitter 'notification'.
    class MockPgClient extends EventEmitter {
      constructor(peers) {
        super();
        this.peers = peers;
        this.queries = [];
        this.listening = new Set();
      }
      async query(sql, params) {
        this.queries.push({ sql, params });
        if (sql.startsWith('LISTEN ')) {
          this.listening.add(sql.slice('LISTEN '.length).trim());
        } else if (sql.startsWith('UNLISTEN ')) {
          this.listening.delete(sql.slice('UNLISTEN '.length).trim());
        } else if (sql.includes('pg_notify')) {
          const [ch, payload] = params;
          for (const peer of this.peers) {
            if (peer.listening.has(ch)) peer.emit('notification', { channel: ch, payload });
          }
        }
      }
    }

    const peers = [];
    const pgA = new MockPgClient(peers);
    const pgB = new MockPgClient(peers);
    peers.push(pgA, pgB);

    assert.throws(() => createPostgresBus({ client: pgA, channel: 'bad; DROP TABLE users;' }), /Invalid PostgreSQL/);

    const busA = await createPostgresBus({ client: pgA, workerId: 'pg-a', secret: 'pg-secret', channel: 'iliac_bus' }).connect();
    const busB = await createPostgresBus({ client: pgB, workerId: 'pg-b', secret: 'pg-secret', channel: 'iliac_bus' }).connect();

    const received = [];
    busB.onChat((m) => received.push(m));
    await busA.publishChat({ channel: 'global', fromId: 7, fromName: 'Tiber', text: 'Over Postgres LISTEN/NOTIFY!' });

    assert.equal(received.length, 1);
    assert.equal(received[0].text, 'Over Postgres LISTEN/NOTIFY!');

    // Guard against exceeding PostgreSQL 8000-byte NOTIFY payload limit.
    await assert.rejects(
      () => busA.publishChat({ channel: 'global', fromId: 7, fromName: 'Tiber', text: 'x'.repeat(PG_NOTIFY_MAX_BYTES + 100) }),
      /too large/,
    );

    await busA.close();
    await busB.close();
    assert.ok(pgA.queries.some((q) => q.sql === 'UNLISTEN iliac_bus'));
  });
});

describe('Comfortable chat rate limits & uncapped MAX_PLAYERS support', () => {
  test('per-channel chat limiter allows comfortable human bursts while keeping global shout anti-spam', () => {
    let t = 0;
    const allow = createChatLimiter(() => t);

    // Local chat: generous burst (12) + 4/sec refill.
    assert.equal(chatLimitFor('local').burst, CHAT_LIMITS.local.burst);
    for (let i = 0; i < CHAT_LIMITS.local.burst; i++) {
      assert.equal(allow('local'), true, `local burst line ${i + 1}`);
    }
    assert.equal(allow('local'), false, 'local throttles only after full burst');

    // Party & whisper have independent buckets (15 burst) — never blocked by local or global!
    for (let i = 0; i < CHAT_LIMITS.party.burst; i++) {
      assert.equal(allow('party'), true, `party burst line ${i + 1}`);
    }
    assert.equal(allow('party'), false);

    for (let i = 0; i < CHAT_LIMITS.whisper.burst; i++) {
      assert.equal(allow('whisper'), true, `whisper burst line ${i + 1}`);
    }
    assert.equal(allow('whisper'), false);

    // Global shout is tighter (burst 5, 2/sec sustained) to stop world-wide spam bots.
    assert.equal(CHAT_BURST, 5);
    assert.ok(CHAT_RATE_PER_SEC >= 2);
    for (let i = 0; i < CHAT_BURST; i++) assert.equal(allow('global'), true);
    assert.equal(allow('global'), false);

    // After 500 ms, local (4/s -> +2 tokens) and global (2/s -> +1 token) have already refilled.
    t += 500;
    assert.equal(allow('local'), true);
    assert.equal(allow('local'), true);
    assert.equal(allow('global'), true);
    assert.equal(allow('global'), false);
  });

  test('server/main.js removes the 1000 cap, supports MAX_PLAYERS=0 (uncapped), and passes comfortable chat defaults', () => {
    const mainSrc = readFileSync(fileURLToPath(new URL('../server/main.js', import.meta.url)), 'utf8');
    assert.ok(!mainSrc.includes("intEnv('MAX_PLAYERS', DEFAULTS.maxPlayers, 1, 1000)"), 'old 1000 clamp removed');
    assert.match(mainSrc, /MAX_PLAYERS/);
    assert.match(mainSrc, /Number\.POSITIVE_INFINITY/, 'MAX_PLAYERS=0 maps to Infinity for uncapped single-world capacity');
    assert.match(mainSrc, /CHAT_LIMITS\.local\.ratePerSec/);
    assert.match(mainSrc, /CHAT_LIMITS\.local\.burst/);
  });
});
