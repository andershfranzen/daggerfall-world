// Travel: journey arithmetic, location ids and the server feature against a
// synthetic catalogue. Real ARENA2 coverage: rpg-travel-data.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { Catalog, PakMap, parseLocationId, locationId, isTownId, mapPixelOf } from '../client/gameplay/travel/catalog.js';
import { hasFreeShipPassage, travelMinutes, tripCost, travelDays, quoteJourney, normalizeOptions } from '../client/gameplay/travel/journey.js';
import { CLASSIC_STARTERS, classicCatalog } from '../client/gameplay/travel/classic.js';
import { decodeImg, regionMapNames, regionMapFor, regionMapScale } from '../client/gameplay/travel/mapimages.js';

describe('location ids', () => {
  test('parse canonical town ids and refuse other prefixes', () => {
    assert.deepEqual(parseLocationId('town:Daggerfall/Gothway Garden'), { region: 'Daggerfall', location: 'Gothway Garden' });
    assert.deepEqual(parseLocationId("town:Alik'r Desert/Alik'ra"), { region: "Alik'r Desert", location: "Alik'ra" });
    assert.equal(parseLocationId('building:Daggerfall/Gothway Garden/12'), null);
    assert.equal(parseLocationId('dungeon:Daggerfall/Privateer\'s Hold'), null);
    assert.equal(parseLocationId('town:Daggerfall'), null);
    assert.equal(parseLocationId('town:/x'), null);
    assert.equal(parseLocationId('town:x/'), null);
    assert.equal(parseLocationId(42), null);
    assert.equal(isTownId('town:A/B'), true);
    assert.equal(locationId('Wayrest', 'Wayrest'), 'town:Wayrest/Wayrest');
  });
  test('map pixel from longitude/latitude', () => {
    assert.deepEqual(mapPixelOf(128 * 109 + 5, (499 - 159) * 128 + 3), { x: 109, y: 159 });
  });
});

describe('journey (TravelTimeCalculator)', () => {
  const W = () => 231; // woodlands everywhere
  test('woodland step costs match the classic integer maths', () => {
    // foot: ((102*256)>>8) * (256-250+256) >> 8 = 104 per step at inns; camping: 300*104>>8 = 121
    assert.equal(travelMinutes({ x: 0, y: 0 }, { x: 10, y: 0 }, { climateAt: W, speed: 'cautious', lodging: 'inn' }).minutes, 1040);
    assert.equal(travelMinutes({ x: 0, y: 0 }, { x: 10, y: 0 }, { climateAt: W, speed: 'cautious', lodging: 'camp' }).minutes, 1210);
    assert.equal(travelMinutes({ x: 0, y: 0 }, { x: 10, y: 0 }, { climateAt: W, speed: 'reckless', lodging: 'camp' }).minutes, 605);
    // A horse halves the base: (102*128>>8)=51, 51*262>>8 = 52
    assert.equal(travelMinutes({ x: 0, y: 0 }, { x: 0, y: 10 }, { climateAt: W, speed: 'cautious', lodging: 'inn', transport: 'horse' }).minutes, 520);
    // No climate map: woodland default
    assert.equal(travelMinutes({ x: 5, y: 5 }, { x: 15, y: 5 }, { speed: 'cautious', lodging: 'inn' }).minutes, 1040);
  });
  test('diagonal paths step along the longer axis', () => {
    const r = travelMinutes({ x: 0, y: 0 }, { x: 7, y: -3 }, { climateAt: W });
    assert.equal(r.steps, 7);
  });
  test('ocean steps: ship passage is faster and charged', () => {
    const sea = (x) => (x >= 2 && x < 26 ? 223 : 231);
    const walk = travelMinutes({ x: 0, y: 0 }, { x: 30, y: 0 }, { climateAt: sea, speed: 'cautious', lodging: 'inn' });
    const sail = travelMinutes({ x: 0, y: 0 }, { x: 30, y: 0 }, { climateAt: sea, speed: 'cautious', lodging: 'inn', ship: true });
    assert.equal(walk.oceanPixels, 24);
    assert.equal(walk.minutes, 24 * 255 + 6 * 104);
    assert.equal(sail.minutes, 24 * 51 + 6 * 104);
    assert.deepEqual(tripCost(sail.minutes, 24, { lodging: 'camp', ship: true }), { inn: 0, passage: 50, total: 50 });
    assert.deepEqual(tripCost(sail.minutes, 24, { lodging: 'camp', ship: true, ownsShip: true }), { inn: 0, passage: 0, total: 0 });
  });
  test('inn cost: five gold a night, always at least one', () => {
    assert.deepEqual(tripCost(60, 0, { lodging: 'inn' }), { inn: 5, passage: 0, total: 5 });
    assert.deepEqual(tripCost(3 * 1440, 0, { lodging: 'inn' }), { inn: 20, passage: 0, total: 20 });
    assert.deepEqual(tripCost(3 * 1440, 0, { lodging: 'camp' }), { inn: 0, passage: 0, total: 0 });
    assert.deepEqual(tripCost(3 * 1440, 0, { lodging: 'inn', freeInnRooms: true }), { inn: 0, passage: 0, total: 0 });
  });
  test('days round up only with a remainder', () => {
    assert.equal(travelDays(0), 0);
    assert.equal(travelDays(1), 1);
    assert.equal(travelDays(1440), 1);
    assert.equal(travelDays(1441), 2);
  });
  test('options are normalized', () => {
    assert.deepEqual(normalizeOptions({ speed: 'warp', lodging: 'inn', ship: 'yes' }), { speed: 'reckless', lodging: 'inn', ship: false });
    const q = quoteJourney({ x: 0, y: 0 }, { x: 10, y: 0 }, { speed: 'cautious', lodging: 'inn' }, { climateAt: W });
    assert.equal(q.minutes, 1040);
    assert.equal(q.days, 1);
    assert.equal(q.cost.total, 5);
    assert.equal(q.shipUseful, false);
  });
});

describe('PAK and IMG decoding', () => {
  test('PakMap decodes RLE rows and applies the +1 x offset', () => {
    const H = 500;
    const rows = [];
    for (let y = 0; y < H; y++) rows.push(y === 7 ? [[10, 231], [991, 223]] : [[1001, 223]]);
    const body = [];
    const offsets = [];
    let at = H * 4;
    for (const r of rows) {
      offsets.push(at);
      for (const [n, v] of r) { body.push(n & 255, n >> 8, v); at += 3; }
    }
    const bytes = new Uint8Array(H * 4 + body.length);
    const dv = new DataView(bytes.buffer);
    offsets.forEach((o, i) => dv.setUint32(i * 4, o, true));
    bytes.set(body, H * 4);
    const pak = new PakMap(bytes, 'TEST.PAK');
    assert.equal(pak.value(9, 7), 231);
    assert.equal(pak.value(10, 7), 223);
    assert.equal(pak.atMapPixel(8, 7), 231);
    assert.equal(pak.atMapPixel(9, 7), 223);
    assert.throws(() => new PakMap(new Uint8Array(10), 'BAD.PAK'), /truncated/);
  });
  test('IMG header and headerless forms', () => {
    const raw = new Uint8Array(64000);
    assert.deepEqual([decodeImg(raw, 'A').width, decodeImg(raw, 'A').height], [320, 200]);
    const h = new Uint8Array(12 + 4 * 2);
    const dv = new DataView(h.buffer);
    dv.setInt16(4, 4, true);
    dv.setInt16(6, 2, true);
    h[12] = 9;
    const img = decodeImg(h, 'B');
    assert.equal(img.width, 4);
    assert.equal(img.indices[0], 9);
    dv.setUint16(8, 2, true);
    assert.throws(() => decodeImg(h, 'C'), /compressed/);
  });
  test('region map naming, scale and multi-part lookup', () => {
    assert.deepEqual(regionMapNames(17), ['FMAP0I17.IMG']);
    assert.equal(regionMapNames(1).length, 4);
    assert.equal(regionMapScale(19), 4);
    assert.equal(regionMapFor(17, 109, 159), 0);
    assert.equal(regionMapFor(0, 540, 345), 1);
    assert.equal(regionMapFor(17, 999, 499), -1);
    assert.equal(regionMapFor(19, 114, 255), 0, 'Betony dots use the scaled corner');
  });
});

// ------------------------------------------------------------------------------------ server

function syntheticWorld() {
  const L = (region, regionIndex, name, type, x, y, discovered = true) => ({
    id: locationId(region, name), region, regionIndex, name, type, discovered, x, y, index: 0, mapId: 1,
  });
  const catalog = new Catalog([
    L('Daggerfall', 17, 'Gothway Garden', 'hamlet', 109, 159),
    L('Daggerfall', 17, 'Daggerfall', 'city', 207, 213),
    L('Daggerfall', 17, 'Hidden Hollow', 'village', 120, 160, false),
    L('Wayrest', 23, 'Wayrest', 'city', 859, 244),
  ], 'files');
  const climate = { atMapPixel: () => 231 };
  return { catalog, climate, politic: null };
}

async function setup({ dataPath = '/fake/arena2', loadWorld = async () => syntheticWorld(), players = [] } = {}) {
  const map = new Map();
  const sent = [];
  const saves = [];
  const emitted = [];
  let failSave = false;
  let travelApi;
  let clock = 0;
  const runtime = createRpgRuntime({
    players: map,
    features: [{ name: 'travel', install: (ctx) => { travelApi = installTravel(ctx, { loadWorld }); ctx.on('travel', (e) => emitted.push(e)); } }],
    save: (list) => { if (failSave) throw new Error('disk full'); saves.push(list.map((p) => p.id)); },
    send: (p, msg) => sent.push([p.id, msg]),
    dataPath,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  });
  await travelApi.ready;
  const join = (id, rpg = {}) => {
    const p = { id, name: `P${id}`, x: 3, z: 4, yaw: 0.5, moving: false, rpg };
    map.set(id, p);
    runtime.join(p);
    return p;
  };
  for (const [id, rpg] of players) join(id, rpg);
  return {
    runtime, sent, saves, emitted, join, services: runtime.ctx.services,
    advance: (ms) => { clock += ms; },
    failSaves: (v) => { failSave = v; },
  };
}

describe('server travel feature', () => {
  test('the map fare matches the charged sea passage for owners, knights and ordinary travellers', async () => {
    const world = syntheticWorld();
    const climateAt = () => 223; // Ocean for the whole crossing.
    world.climate.atMapPixel = climateAt;
    const t = await setup({ loadWorld: async () => world });
    const from = world.catalog.get('town:Daggerfall/Gothway Garden');
    const to = world.catalog.get('town:Daggerfall/Daggerfall');
    const options = { lodging: 'camp', ship: true };
    const fullFare = quoteJourney(from, to, options, { climateAt }).cost.passage;
    assert.ok(fullFare > 0);
    const cases = [
      [{}, fullFare],
      [{ guilds: { knights: { rank: 5 } } }, fullFare],
      [{ guilds: { knights: { rank: 6 } } }, 0],
      [{ property: { ship: { type: 'small' } } }, 0],
      [{ property: { ship: { type: 'large' } } }, 0],
      [{ travel: { ownsShip: true } }, 0],
    ];
    for (const [i, [rpg, expectedFare]] of cases.entries()) {
      const p = t.join(i + 1, { ...rpg, gold: fullFare });
      const offer = quoteJourney(from, to, options, { climateAt, freePassage: hasFreeShipPassage(p.rpg) });
      assert.equal(offer.cost.total, expectedFare);
      assert.deepEqual(t.runtime.act(p, 'travel.go', { to: to.id, options, expectCost: offer.cost.total }), { ok: true });
      assert.equal(p.rpg.gold, fullFare - expectedFare);
    }
  });
  test('join prepares travel state and validates the stored location', async () => {
    const t = await setup();
    const p = t.join(1);
    assert.equal(p.rpg.location, 'town:Daggerfall/Gothway Garden');
    assert.equal(p.rpg.travel.server, 'files');
    const q = t.join(2, { location: 'town:Nowhere/Atlantis' });
    assert.equal(q.rpg.location, 'town:Daggerfall/Gothway Garden');
    assert.deepEqual([q.x, q.z], [0, 0]);
    const r = t.join(3, { location: 'town:daggerfall/daggerfall' });
    assert.equal(r.rpg.location, 'town:Daggerfall/Daggerfall', 'canonical spelling restored');
    const s = t.join(4, { location: 'building:Daggerfall/Gothway Garden/3' });
    assert.equal(s.rpg.location, 'building:Daggerfall/Gothway Garden/3', 'interiors are left alone');
  });

  test('travel.go moves, charges, records, emits and restores positions', async () => {
    const t = await setup();
    const p = t.join(1, { gold: 100 });
    const watcher = t.join(2);
    let r = t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall', options: { speed: 'cautious', lodging: 'inn' } });
    assert.deepEqual(r, { ok: true });
    assert.equal(p.rpg.location, 'town:Daggerfall/Daggerfall');
    assert.deepEqual([p.x, p.z, p.yaw], [0, 0, 0]);
    assert.deepEqual(p.rpg.travel.positions['town:Daggerfall/Gothway Garden'], { x: 3, z: 4, yaw: 0.5 });
    const expected = quoteJourney({ x: 109, y: 159 }, { x: 207, y: 213 }, { speed: 'cautious', lodging: 'inn' }, { climateAt: () => 231 });
    assert.equal(p.rpg.gold, 100 - expected.cost.total);
    assert.equal(p.rpg.travel.lastTrip.days, expected.days);
    assert.equal(p.rpg.travel.trips, 1);
    assert.equal(t.emitted.length, 1);
    assert.equal(t.emitted[0].player, p);
    assert.equal(t.emitted[0].from, 'town:Daggerfall/Gothway Garden');
    assert.equal(t.emitted[0].to, 'town:Daggerfall/Daggerfall');
    const ev = t.sent.find(([id, m]) => id === 1 && m.type === 'gameEvent' && m.event.kind === 'travel');
    assert.ok(ev, 'private travel event');
    assert.match(ev[1].event.text, /arrive in Daggerfall/);
    assert.ok(!t.sent.some(([id, m]) => id === watcher.id && m.type === 'gameEvent'), 'others get no private event');
    assert.deepEqual(t.saves.at(-1), [1]);

    p.x = 10; p.z = -2;
    t.advance(2000);
    r = t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Gothway Garden', options: { lodging: 'camp' } });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual([p.x, p.z, p.yaw], [3, 4, 0.5], 'back where they left Gothway Garden');
  });

  test('invalid destinations fail with readable errors and change nothing', async () => {
    const t = await setup();
    const p = t.join(1, { gold: 3 });
    const before = structuredClone(p.rpg);
    const cases = [
      [{}, /Choose a destination/],
      [{ to: 'dungeon:Daggerfall/Somewhere' }, /not a place on the travel map/],
      [{ to: 'town:Daggerfall/Atlantis' }, /no such place/],
      [{ to: 'town:Daggerfall/Hidden Hollow' }, /not yet heard of Hidden Hollow/],
      [{ to: 'town:Daggerfall/Gothway Garden' }, /already in Gothway Garden/],
      [{ to: 'town:Wayrest/Wayrest', options: { lodging: 'inn' } }, /need \d+ gold/],
      [{ to: 'town:Daggerfall/Daggerfall', options: { lodging: 'camp' }, expectCost: 99 }, /price has changed to 0 gold/],
    ];
    for (const [args, re] of cases) {
      const r = t.runtime.act(p, 'travel.go', args);
      assert.equal(r.ok, false, JSON.stringify(args));
      assert.match(r.error, re);
    }
    assert.deepEqual(p.rpg, before);
    assert.deepEqual([p.x, p.z], [3, 4]);
  });

  test('discovered places become reachable; indoors travel is refused', async () => {
    const t = await setup();
    const p = t.join(1);
    assert.equal(t.services.travel.discover(p, 'town:Daggerfall/Hidden Hollow'), true);
    assert.equal(t.services.travel.discover(p, 'town:Daggerfall/Hidden Hollow'), false);
    assert.deepEqual(t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Hidden Hollow' }), { ok: true });
    p.rpg.location = 'building:Daggerfall/Hidden Hollow/2';
    t.advance(5000);
    const r = t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall' });
    assert.match(r.error, /Step outside/);
  });

  test('a wilderness journey is quoted from the current pixel and preserves town return positions', async () => {
    const t = await setup();
    const p = t.join(1);
    p.rpg.location = 'wilderness:207,212';
    p.rpg.travel.positions['town:Daggerfall/Gothway Garden'] = { x: 9, z: 4, yaw: 1 };
    const to = 'town:Daggerfall/Daggerfall';
    const options = { lodging: 'camp', speed: 'reckless', ship: false };
    const q = t.services.travel.quote(p, to, options);
    assert.equal(q.steps, 1);
    assert.deepEqual(t.runtime.act(p, 'travel.go', { to, options, expectCost: q.cost.total }), { ok: true });
    assert.equal(p.rpg.location, to);
    assert.deepEqual(p.rpg.travel.positions, { 'town:Daggerfall/Gothway Garden': { x: 9, z: 4, yaw: 1 } });
  });

  test('cooldown and save failure', async () => {
    const t = await setup();
    const p = t.join(1, { gold: 50 });
    assert.equal(t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall' }).ok, true);
    const r = t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Gothway Garden' });
    assert.match(r.error, /only just arrived/);
    t.advance(2000);
    t.failSaves(true);
    const before = structuredClone(p.rpg);
    const r2 = t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Gothway Garden' });
    assert.equal(r2.ok, false);
    assert.deepEqual(p.rpg, before, 'rpg rolled back when the save fails');
  });

  test('cautious journeys arrive rested', async () => {
    const t = await setup();
    const p = t.join(1, { gold: 0, character: { health: 3, maxHealth: 30, fatigue: 1, maxFatigue: 90, magicka: 0, maxMagicka: 20 } });
    assert.equal(t.runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall', options: { speed: 'cautious', lodging: 'camp' } }).ok, true);
    assert.deepEqual([p.rpg.character.health, p.rpg.character.fatigue, p.rpg.character.magicka], [30, 90, 20]);
  });

  test('without server data only the classic starters are accepted', async () => {
    const t = await setup({ dataPath: null });
    const p = t.join(1, { gold: 1000 });
    assert.equal(p.rpg.travel.server, 'classic');
    assert.equal(t.runtime.act(p, 'travel.go', { to: 'town:Wayrest/Wayrest' }).ok, true);
    t.advance(2000);
    const r = t.runtime.act(p, 'travel.go', { to: 'town:Wayrest/Merwark Hollow' });
    assert.match(r.error, /only knows the starter towns/);
  });

  test('a failed world load falls back to the starters and says so', async () => {
    const t = await setup({ loadWorld: async () => { throw new Error('MAPS.BSA missing'); } });
    const p = t.join(1);
    assert.equal(p.rpg.travel.server, 'classic');
    assert.match(t.services.travel.loadError, /MAPS\.BSA/);
  });

  test('players present while the catalogue loads are revalidated afterwards', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const map = new Map();
    let api;
    const runtime = createRpgRuntime({
      players: map, save() {}, send() {}, dataPath: '/x', log: { info() {}, warn() {}, error() {} },
      features: [(ctx) => { api = installTravel(ctx, { loadWorld: async () => { await gate; return syntheticWorld(); } }); }],
    });
    const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { location: 'town:Nowhere/Gone' } };
    map.set(1, p);
    runtime.join(p);
    assert.equal(p.rpg.travel.server, 'loading');
    assert.match(runtime.act(p, 'travel.go', { to: 'town:Daggerfall/Daggerfall' }).error, /still being read/);
    release();
    await api.ready;
    assert.equal(p.rpg.travel.server, 'files');
    assert.equal(p.rpg.location, 'town:Daggerfall/Gothway Garden');
    assert.equal(p.dirty, true);
  });

  test('classic starters form a valid catalogue', () => {
    const c = classicCatalog();
    assert.equal(c.source, 'classic');
    assert.ok(c.get('town:Daggerfall/Gothway Garden'));
    assert.equal(c.size, CLASSIC_STARTERS.length);
    assert.deepEqual(c.search('way').map((l) => l.name), ['Wayrest', 'Gothway Garden'], 'prefix before substring');
  });
});
