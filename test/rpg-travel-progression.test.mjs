// Travel progression, unlimited compact discovery persistence, duplicate-name place identity,
// classic fast-travel rules, and calendar/holiday arrival consistency.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { install as installAtmosphere } from '../server/rpg/atmosphere.js';
import { install as installCalendar, CITY_CAMPING_ILLEGAL } from '../server/rpg/calendar.js';
import { openStore, MAX_RPG_BYTES } from '../server/db.js';
import { Catalog, CLIMATE, REGION_NAMES, locationId } from '../client/gameplay/travel/catalog.js';
import {
  BITSET_PREFIX, BITSET_THRESHOLD,
  addFound, compactFound, countFound, encodeFoundBitset, hasFound, normalizeFound,
} from '../client/gameplay/travel/identity.js';
import { quoteJourney, travelMinutes, tripCost } from '../client/gameplay/travel/journey.js';
import { AKATOSH } from '../client/gameplay/guilds/perks.js';
import {
  CLASSIC_GAME_START_TIME, MINUTES_PER_DAY, dateFromMinutes, formatDate, formatTime,
} from '../client/gameplay/atmosphere/calendar.js';
import { holidayAt, holidayInfo } from '../client/gameplay/atmosphere/holidays.js';

const EPOCH = Date.UTC(2026, 0, 1);
const minuteOn = (doy, hour = 12) =>
  CLASSIC_GAME_START_TIME - (3 * MINUTES_PER_DAY + 13 * 60 + 30) + (doy - 1) * MINUTES_PER_DAY + hour * 60;

/** Build a synthetic multi-region Iliac Bay catalogue with duplicate names and thousands of hidden records. */
function buildLargeWorld({ hiddenCount = 4200, regions = 8 } = {}) {
  const records = [
    // Classic starters & duplicate-name Alik'r Desert shrines (exact classic coordinates & indices)
    { region: 'Daggerfall', regionIndex: 17, index: 197, name: 'Gothway Garden', type: 'hamlet', discovered: true, x: 109, y: 159, mapId: 1 },
    { region: 'Daggerfall', regionIndex: 17, index: 1231, name: 'Daggerfall', type: 'city', discovered: true, x: 207, y: 213, mapId: 2 },
    { region: 'Wayrest', regionIndex: 23, index: 601, name: 'Wayrest', type: 'city', discovered: true, x: 859, y: 244, mapId: 3 },
    { region: 'Sentinel', regionIndex: 20, index: 6, name: 'Sentinel', type: 'city', discovered: true, x: 397, y: 343, mapId: 4 },
    { region: "Alik'r Desert", regionIndex: 0, index: 139, name: 'Djen Lodge', type: 'cult', discovered: true, x: 310, y: 435, mapId: 5 },
    { region: "Alik'r Desert", regionIndex: 0, index: 272, name: 'Djen Lodge', type: 'cult', discovered: false, x: 319, y: 483, mapId: 6 },
  ];
  const validRegionIndices = REGION_NAMES
    .map((name, idx) => (name ? idx : -1))
    .filter((idx) => idx >= 0 && idx !== 0 && idx !== 17 && idx !== 20 && idx !== 23)
    .slice(0, Math.max(1, regions - 1));
  // Include Daggerfall (17) so at least one region exceeds BITSET_THRESHOLD (512)
  const pool = [17, ...validRegionIndices];
  let created = 0;
  for (let i = 0; created < hiddenCount; i++) {
    const rIdx = pool[i % pool.length];
    const locIdx = 2000 + Math.floor(i / pool.length);
    const x = 10 + (i % 900);
    const y = 10 + (Math.floor(i / 900) % 450);
    records.push({
      region: REGION_NAMES[rIdx],
      regionIndex: rIdx,
      index: locIdx,
      name: `Hidden Site ${rIdx}-${locIdx}`,
      type: i % 2 === 0 ? 'ruin' : 'labyrinth',
      discovered: false,
      x,
      y,
      mapId: 1000 + i,
    });
    created++;
  }
  const catalog = new Catalog(records, 'files');
  // Ocean band in the middle of the Iliac Bay (y in 230..310) so Daggerfall -> Sentinel crosses sea
  const climate = {
    atMapPixel: (_x, y) => (y >= 230 && y <= 310 ? CLIMATE.OCEAN : CLIMATE.WOODLANDS),
  };
  return { catalog, climate, politic: null };
}

async function createWorldRuntime({ world, minute = CLASSIC_GAME_START_TIME, store = null, portals = null, ownsBuilding = null, guildCanRest = null } = {}) {
  let wall = EPOCH + (minute - CLASSIC_GAME_START_TIME) * 5000;
  let nowMs = 0;
  const players = new Map();
  const events = [];
  let travelApi;
  const runtime = createRpgRuntime({
    players,
    dataPath: '/synthetic/arena2',
    now: () => nowMs,
    save: (list) => {
      if (store) store.saveCharacters(list);
    },
    send: (p, msg) => {
      if (msg.type === 'gameEvent') events.push({ pid: p.id, ...msg.event });
    },
    log: { info() {}, warn() {}, error() {} },
    features: [
      { name: 'travel', install: (ctx) => { travelApi = installTravel(ctx, { loadWorld: async () => world }); } },
      { name: 'atmosphere', install: (ctx) => installAtmosphere(ctx, { wallNow: () => wall, restSecondsPerHour: 1 }) },
      { name: 'calendar', install: installCalendar },
      {
        name: 'hooks',
        install(ctx) {
          if (portals) ctx.services.portals = portals;
          if (ownsBuilding) ctx.services.ownsBuilding = ownsBuilding;
          if (guildCanRest) ctx.services.guildCanRest = guildCanRest;
        },
      },
    ],
  });
  await travelApi.ready;

  const join = (p) => {
    players.set(p.id, p);
    runtime.join(p);
    return p;
  };
  return {
    runtime,
    players,
    events,
    services: runtime.ctx.services,
    join,
    advanceMs: (ms) => { nowMs += ms; },
    setMinute: (m) => { wall = EPOCH + (m - CLASSIC_GAME_START_TIME) * 5000; },
    of: (kind, pid) => events.filter((e) => e.kind === kind && (pid === undefined || e.pid === pid)),
  };
}

describe('unlimited compact discovery persistence (>4,100 & full Iliac Bay scale)', () => {
  test('bitset helpers handle edge indices, auto-compaction, normalization, and backwards compatibility', () => {
    const f = normalizeFound({ 0: [5, 2, 5, -3, 'bad', 70000], 17: [0, 7, 8, 255, 65535], 99: [1] });
    assert.deepEqual(f[0], [2, 5]);
    assert.deepEqual(f[17], [0, 7, 8, 255, 65535]);
    assert.equal(f[99], undefined);
    assert.equal(countFound(f), 7);

    // Explicitly compacting produces base64 bitset strings and preserves every bit
    const compacted = compactFound(f);
    assert.ok(typeof compacted[0] === 'string' && compacted[0].startsWith(BITSET_PREFIX));
    assert.ok(typeof compacted[17] === 'string' && compacted[17].startsWith(BITSET_PREFIX));
    assert.equal(countFound(compacted), 7);
    for (const idx of [0, 7, 8, 255, 65535]) {
      assert.equal(hasFound(compacted, { regionIndex: 17, index: idx }), true, `bit ${idx} set`);
    }
    assert.equal(hasFound(compacted, { regionIndex: 17, index: 1 }), false);
    assert.equal(hasFound(compacted, { regionIndex: 17, index: 65534 }), false);
    assert.equal(addFound(compacted, { regionIndex: 17, index: 65535 }), false, 'duplicate add is a no-op');
    assert.equal(addFound(compacted, { regionIndex: 17, index: 12345 }), true);
    assert.equal(hasFound(compacted, { regionIndex: 17, index: 12345 }), true);
    assert.equal(countFound(compacted), 8);

    // Corrupt bitsets are dropped safely during normalization
    const cleaned = normalizeFound({ 0: 'b:!!!not-base64!!!', 17: encodeFoundBitset([10, 20]) });
    assert.equal(cleaned[0], undefined);
    assert.equal(hasFound(cleaned, { regionIndex: 17, index: 10 }), true);
    assert.equal(hasFound(cleaned, { regionIndex: 17, index: 20 }), true);
  });

  test('4,200+ hidden discoveries persist compactly across SQLite save/reload well within MAX_RPG_BYTES', async () => {
    const world = buildLargeWorld({ hiddenCount: 4200, regions: 4 });
    const store = openStore(':memory:');
    try {
      const { token, row: created } = store.create('Explorer', { gold: 500 });
      const h1 = await createWorldRuntime({ world, store });
      const p = h1.join(created);

      const hidden = world.catalog.locations.filter((e) => !e.discovered);
      assert.ok(hidden.length >= 4201, `expected >4,200 hidden sites, got ${hidden.length}`);

      let added = 0;
      for (const e of hidden) {
        if (h1.services.travel.discover(p, e.id)) added++;
      }
      assert.equal(added, hidden.length);
      // Repeating a discovery does not duplicate
      assert.equal(h1.services.travel.discover(p, hidden[0].id), false);

      // Regions with > BITSET_THRESHOLD entries auto-compacted into base64 bitsets
      assert.ok(
        Object.values(p.rpg.travel.found).some((v) => typeof v === 'string' && v.startsWith(BITSET_PREFIX)),
        'large regions auto-compact to bitsets',
      );
      assert.equal(countFound(p.rpg.travel.found), hidden.length);

      const serialized = JSON.stringify(p.rpg);
      assert.ok(serialized.length < 32 * 1024, `expected compact save < 32 KB, got ${serialized.length} bytes`);
      assert.ok(serialized.length < MAX_RPG_BYTES);

      // Persist through real SQLite store and reload on a fresh runtime
      store.saveCharacters([p]);
      const reloadedRow = store.findByToken(token);
      const h2 = await createWorldRuntime({ world, store });
      const p2 = h2.join(reloadedRow);

      assert.equal(countFound(p2.rpg.travel.found), hidden.length);
      const missing = hidden.filter((e) => !hasFound(p2.rpg.travel.found, e));
      assert.equal(missing.length, 0, 'every discovered location survives reload');

      // Spot-check travel to one of the >4,100th discovered hidden sites
      const lateSite = hidden.at(-1);
      const res = h2.runtime.act(p2, 'travel.go', { to: lateSite.id, options: { speed: 'reckless', lodging: 'camp' } });
      assert.deepEqual(res, { ok: true });
      assert.equal(p2.rpg.location, lateSite.id);
    } finally {
      store.close();
    }
  });

  test('legacy array save with 4,150 string discoveries migrates cleanly without 4,000-entry truncation', async () => {
    const world = buildLargeWorld({ hiddenCount: 4150, regions: 5 });
    const hidden = world.catalog.locations.filter((e) => !e.discovered).slice(0, 4150);
    const h = await createWorldRuntime({ world });
    const legacy = h.join({
      id: 10,
      name: 'Veteran',
      x: 0,
      z: 0,
      yaw: 0,
      rpg: {
        location: 'town:Daggerfall/Gothway Garden',
        travel: {
          discovered: hidden.map((e) => e.id),
        },
      },
    });
    assert.deepEqual(legacy.rpg.travel.discovered, [], 'all legacy ids converted to found');
    assert.equal(countFound(legacy.rpg.travel.found), 4150, 'no truncation at 4,000');
    assert.equal(hidden.filter((e) => !hasFound(legacy.rpg.travel.found, e)).length, 0);
  });

  test('all 15,251 Iliac Bay records fit in a tiny fraction of MAX_RPG_BYTES when compacted', () => {
    const found = {};
    let total = 0;
    for (let r = 0; r < 45; r++) {
      const regionIndex = REGION_NAMES.findIndex((n, i) => n && i >= r);
      const count = r < 44 ? 339 : 335; // 44 * 339 + 335 = 15,251
      found[regionIndex] = Array.from({ length: count }, (_, i) => i);
      total += count;
    }
    assert.equal(total, 15251);
    const compacted = compactFound(found);
    assert.equal(countFound(compacted), 15251);
    const bytes = JSON.stringify({ travel: { found: compacted } }).length;
    assert.ok(bytes < 8 * 1024, `expected < 8 KB for 15,251 compacted records, got ${bytes} bytes`);
    assert.ok(bytes < MAX_RPG_BYTES);
  });
});

describe('duplicate-name place identity (Alik\'r Desert Djen Lodges)', () => {
  test('both Djen Lodges resolve independently through search, discovery, travel, positions, and SQLite reload', async () => {
    const world = buildLargeWorld({ hiddenCount: 10, regions: 2 });
    const store = openStore(':memory:');
    try {
      const c = world.catalog;
      const first = c.at(0, 139);
      const second = c.at(0, 272);
      assert.equal(first.id, "town:Alik'r Desert/Djen Lodge");
      assert.equal(second.id, 'town:0/272');
      assert.deepEqual([first.x, first.y], [310, 435]);
      assert.deepEqual([second.x, second.y], [319, 483]);
      assert.equal(c.ambiguous(first), true);
      assert.equal(c.ambiguous(second), true);
      assert.equal(c.atPixel(310, 435), first);
      assert.equal(c.atPixel(319, 483), second);

      // Search returns both in deterministic (regionIndex, index) order
      const hits = c.search('Djen Lodge');
      assert.deepEqual(hits.map((e) => [e.regionIndex, e.index, e.id]), [
        [0, 139, "town:Alik'r Desert/Djen Lodge"],
        [0, 272, 'town:0/272'],
      ]);

      const h1 = await createWorldRuntime({ world, store });
      const { token, row } = store.create('Nomad', { gold: 1000 });
      const p = h1.join(row);

      // First Djen Lodge is initially discovered; second is hidden until discovered by its slot id
      assert.equal(h1.runtime.act(p, 'travel.go', { to: 'town:0/272' }).ok, false);
      assert.equal(h1.services.travel.discover(p, 'town:0/272'), true);

      // Travel to first Djen Lodge, stand at (12, -5)
      assert.deepEqual(h1.runtime.act(p, 'travel.go', { to: first.id, options: { lodging: 'camp' } }), { ok: true });
      assert.equal(p.rpg.location, first.id);
      p.x = 12; p.z = -5; p.yaw = 1.25;

      // Travel to second Djen Lodge, stand at (-8, 22)
      h1.advanceMs(2000);
      assert.deepEqual(h1.runtime.act(p, 'travel.go', { to: second.id, options: { lodging: 'camp' } }), { ok: true });
      assert.equal(p.rpg.location, second.id);
      p.x = -8; p.z = 22; p.yaw = -0.5;
      store.saveCharacters([p]);

      // Reload from SQLite on a new runtime and verify both identities and saved positions remain independent
      const h2 = await createWorldRuntime({ world, store });
      const p2 = h2.join(store.findByToken(token));
      assert.equal(p2.rpg.location, second.id);
      assert.deepEqual([p2.x, p2.z], [-8, 22]);
      assert.equal(hasFound(p2.rpg.travel.found, second), true);

      assert.deepEqual(h2.runtime.act(p2, 'travel.go', { to: first.id, options: { lodging: 'camp' } }), { ok: true });
      assert.equal(p2.rpg.location, first.id);
      assert.deepEqual([p2.x, p2.z, p2.yaw], [12, -5, 1.25], 'returned to first shrine position');

      h2.advanceMs(2000);
      assert.deepEqual(h2.runtime.act(p2, 'travel.go', { to: second.id, options: { lodging: 'camp' } }), { ok: true });
      assert.equal(p2.rpg.location, second.id);
      assert.deepEqual([p2.x, p2.z, p2.yaw], [-8, 22, -0.5], 'returned to second shrine position');
    } finally {
      store.close();
    }
  });
});

describe('classic fast-travel modes, transport speeds, costs & guild/ship discounts', () => {
  test('cautious vs reckless, camp vs inns, foot vs cart vs horse, ship passage & guild perks', async () => {
    const world = buildLargeWorld({ hiddenCount: 5, regions: 2 });
    const h = await createWorldRuntime({ world });
    const from = world.catalog.get('town:Daggerfall/Gothway Garden');
    const toDaggerfall = world.catalog.get('town:Daggerfall/Daggerfall');
    const toSentinel = world.catalog.get('town:Sentinel/Sentinel');
    const climateAt = (x, y) => world.climate.atMapPixel(x, y);

    // Transport speed ordering: horse < cart < foot
    const mFoot = travelMinutes(from, toDaggerfall, { climateAt, speed: 'cautious', lodging: 'inn', transport: 'foot' }).minutes;
    const mCart = travelMinutes(from, toDaggerfall, { climateAt, speed: 'cautious', lodging: 'inn', transport: 'cart' }).minutes;
    const mHorse = travelMinutes(from, toDaggerfall, { climateAt, speed: 'cautious', lodging: 'inn', transport: 'horse' }).minutes;
    assert.ok(mHorse < mCart && mCart < mFoot, `expected horse(${mHorse}) < cart(${mCart}) < foot(${mFoot})`);

    // Camp takes longer than inns (300/256 per step), but costs 0 gold
    const qInn = quoteJourney(from, toDaggerfall, { speed: 'cautious', lodging: 'inn' }, { climateAt });
    const qCamp = quoteJourney(from, toDaggerfall, { speed: 'cautious', lodging: 'camp' }, { climateAt });
    assert.ok(qCamp.minutes > qInn.minutes);
    assert.equal(qCamp.cost.total, 0);
    assert.ok(qInn.cost.inn >= 5);

    // Reckless halves travel time relative to cautious
    const qReckless = quoteJourney(from, toDaggerfall, { speed: 'reckless', lodging: 'camp' }, { climateAt });
    assert.equal(qReckless.minutes, qCamp.minutes >> 1);

    // Sea crossing to Sentinel: ship is faster than wading and charges passage unless owned or Knight rank >= 6
    const qSeaShip = quoteJourney(from, toSentinel, { speed: 'cautious', lodging: 'inn', ship: true }, { climateAt });
    const qSeaNoShip = quoteJourney(from, toSentinel, { speed: 'cautious', lodging: 'inn', ship: false }, { climateAt });
    assert.ok(qSeaShip.oceanPixels > 0 && qSeaShip.shipUseful);
    assert.ok(qSeaShip.minutes < qSeaNoShip.minutes);
    assert.ok(qSeaShip.cost.passage > 0);
    assert.equal(tripCost(qSeaShip.minutes, qSeaShip.oceanPixels, { lodging: 'inn', ship: true, freePassage: true }).passage, 0);

    // Server enforces cautious rest vs reckless non-rest, horse inventory speed, and Knight/Akatosh discounts
    const recklessTraveller = h.join({
      id: 1, name: 'Reckless', x: 0, z: 0, yaw: 0,
      rpg: {
        gold: 500,
        location: from.id,
        character: { health: 5, maxHealth: 40, fatigue: 10, maxFatigue: 100, magicka: 2, maxMagicka: 30 },
      },
    });
    assert.deepEqual(
      h.runtime.act(recklessTraveller, 'travel.go', { to: toDaggerfall.id, options: { speed: 'reckless', lodging: 'camp' } }),
      { ok: true },
    );
    assert.equal(recklessTraveller.rpg.character.health, 5, 'reckless travel does not restore vitals');

    const cautiousHorse = h.join({
      id: 2, name: 'Rider', x: 0, z: 0, yaw: 0,
      rpg: {
        gold: 500,
        location: from.id,
        inventory: [{ id: 'h1', template: 'horse' }],
        character: { health: 5, maxHealth: 40, fatigue: 10, maxFatigue: 100, magicka: 2, maxMagicka: 30 },
      },
    });
    assert.deepEqual(
      h.runtime.act(cautiousHorse, 'travel.go', { to: toDaggerfall.id, options: { speed: 'cautious', lodging: 'inn' } }),
      { ok: true },
    );
    assert.equal(cautiousHorse.rpg.travel.lastTrip.transport, 'horse');
    assert.equal(cautiousHorse.rpg.travel.lastTrip.minutes, mHorse);
    assert.deepEqual(
      [cautiousHorse.rpg.character.health, cautiousHorse.rpg.character.fatigue, cautiousHorse.rpg.character.magicka],
      [40, 100, 30],
      'cautious travel arrives fully rested',
    );

    // Knight rank 6 + Akatosh rank 5 + ship owner: free passage, free inns, shortened travel time
    const knightAkatosh = h.join({
      id: 3, name: 'Paladin', x: 0, z: 0, yaw: 0,
      rpg: {
        gold: 100,
        location: from.id,
        guilds: { knights: { rank: 6, variant: 368 }, temple: { rank: 5, variant: AKATOSH } },
        property: { ship: { type: 'large' } },
      },
    });
    const qPerk = h.services.travel.quote(knightAkatosh, toSentinel.id, { speed: 'cautious', lodging: 'inn', ship: true });
    assert.equal(qPerk.cost.total, 0, 'free passage and free inn rooms');
    assert.equal(qPerk.minutes, Math.trunc(0.9 * qSeaShip.minutes), 'Akatosh rank 5 gives 90% travel duration');
    assert.deepEqual(
      h.runtime.act(knightAkatosh, 'travel.go', { to: toSentinel.id, options: { speed: 'cautious', lodging: 'inn', ship: true }, expectCost: 0 }),
      { ok: true },
    );
    assert.equal(knightAkatosh.rpg.gold, 100);
  });
});

describe('classic world date, personal calendar, rest legality & holiday arrival notices', () => {
  test('classic starting date (3E 405 Morning Star), personal calendar advances & rest legality', async () => {
    // Classic Daggerfall epoch: Morning Star 1, 3E 405 is day 1 (New Life Festival),
    // and new-game start (CLASSIC_GAME_START_TIME) is 4th of Morning Star, 3E 405 at 13:30.
    const day1 = dateFromMinutes(minuteOn(1, 0));
    assert.equal(day1.year, 405);
    assert.equal(day1.monthName, 'Morning Star');
    assert.equal(day1.day, 1);
    assert.equal(holidayAt(minuteOn(1, 0), 17), 'new-life');

    const start = dateFromMinutes(CLASSIC_GAME_START_TIME);
    assert.equal(start.year, 405);
    assert.equal(start.monthName, 'Morning Star');
    assert.equal(start.day, 4);
    assert.equal(formatTime(start), '13:30');
    assert.match(formatDate(start), /4th of Morning Star, 3E405$/);

    const world = buildLargeWorld({ hiddenCount: 5, regions: 2 });
    const h = await createWorldRuntime({
      world,
      minute: CLASSIC_GAME_START_TIME,
      portals: { into: (loc) => ({ meta: { buildingType: loc.endsWith('/15') ? 15 : 17 } }) },
      ownsBuilding: (p) => p.id === 2,
    });

    const pTown = h.join({
      id: 1, name: 'Walker', x: 0, z: 0, yaw: 0,
      rpg: { location: 'town:Daggerfall/Gothway Garden', gold: 200 },
    });
    const pHome = h.join({
      id: 2, name: 'Owner', x: 0, z: 0, yaw: 0,
      rpg: { location: 'interior:Daggerfall/Gothway Garden/0,0/10', gold: 200 },
    });

    // CanRest: town street = vagrancy (17); loitering legal; cult shrine exterior (Djen Lodge) = legal with encounters;
    // owned house = legal without encounters; unrented tavern = refused; wilderness & dungeon = legal with encounters.
    const townRest = h.services.restPermission(pTown, 'town:Daggerfall/Gothway Garden', 'hours');
    assert.equal(townRest.ok, false);
    assert.equal(townRest.crime, 'vagrancy');
    assert.equal(townRest.textId, CITY_CAMPING_ILLEGAL);
    assert.deepEqual(h.services.restPermission(pTown, 'town:Daggerfall/Gothway Garden', 'loiter'), { ok: true, encounters: true });
    assert.deepEqual(h.services.restPermission(pTown, "town:Alik'r Desert/Djen Lodge", 'hours'), { ok: true, encounters: true });
    assert.deepEqual(h.services.restPermission(pTown, 'wilderness:109,159', 'hours'), { ok: true, encounters: true });
    assert.deepEqual(h.services.restPermission(pTown, "dungeon:Daggerfall/Privateer's Hold", 'hours'), { ok: true, encounters: true });
    assert.deepEqual(h.services.restPermission(pHome, 'interior:Daggerfall/Gothway Garden/0,0/10', 'hours'), { ok: true, encounters: false });
    assert.equal(h.services.restPermission(pTown, 'interior:Daggerfall/Gothway Garden/0,0/15', 'hours').ok, false);

    // Personal time advances (travel + prison) never move the shared world clock
    const worldBefore = h.services.worldClock().minutes;
    assert.deepEqual(h.runtime.act(pTown, 'travel.go', { to: 'town:Daggerfall/Daggerfall', options: { lodging: 'camp' } }), { ok: true });
    const tripMins = pTown.rpg.travel.lastTrip.minutes;
    h.services.spendTime(pTown, 3 * MINUTES_PER_DAY, 'prison');
    assert.equal(h.services.worldClock().minutes, worldBefore);
    assert.equal(h.services.playerMinutes(pTown), worldBefore + tripMins + 3 * MINUTES_PER_DAY);
    assert.equal(h.services.playerMinutes(pHome), worldBefore);
  });

  test('arriving in a town on a regional or universal holiday announces it immediately without duplicating', async () => {
    const world = buildLargeWorld({ hiddenCount: 5, regions: 2 });

    // Day 103: Day of the Dead (regional holiday in Daggerfall = region 17 only, NOT Wayrest = region 23)
    const h = await createWorldRuntime({ world, minute: minuteOn(103, 10) });
    const p = h.join({
      id: 1, name: 'Pilgrim', x: 0, z: 0, yaw: 0,
      rpg: { location: 'town:Wayrest/Wayrest', gold: 1000 },
    });
    h.runtime.tick(0.1);
    assert.equal(h.of('holiday', 1).length, 0, 'Wayrest has no holiday on day 103');

    // Travel to Daggerfall: regional holiday notice fires immediately on arrival (no tick required!)
    assert.deepEqual(h.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall', options: { lodging: 'camp' } }), { ok: true });
    const notices = h.of('holiday', 1);
    assert.equal(notices.length, 1, 'Day of the Dead announced immediately on arrival');
    assert.equal(notices[0].key, 'day-of-the-dead');
    assert.equal(notices[0].textId, holidayInfo('day-of-the-dead').textId);

    // Subsequent ticks do not repeat the same holiday notice
    h.runtime.tick(0.1);
    h.runtime.tick(0.1);
    assert.equal(h.of('holiday', 1).length, 1);

    // Day 12: Ovanka (regional holiday in Alik'r Desert = region 0) at duplicate-name numeric address town:0/272
    h.setMinute(minuteOn(12, 9));
    h.services.travel.discover(p, 'town:0/272');
    h.advanceMs(2000);
    assert.deepEqual(h.runtime.act(p, 'travel.go', { to: 'town:0/272', options: { lodging: 'camp' } }), { ok: true });
    const alikrNotice = h.of('holiday', 1).at(-1);
    assert.equal(alikrNotice.key, 'ovanka');
    assert.equal(alikrNotice.regionIndex, 0);

    // Day 200: Sun's Rest (universal holiday) on arrival in Wayrest
    h.setMinute(minuteOn(200, 11));
    h.advanceMs(2000);
    assert.deepEqual(h.runtime.act(p, 'travel.go', { to: 'town:Wayrest/Wayrest', options: { lodging: 'camp' } }), { ok: true });
    const universal = h.of('holiday', 1).at(-1);
    assert.equal(universal.key, 'suns-rest');
    assert.match(universal.text, /shops are closed/);
  });
});
