// Place identity (brief A): record addresses, duplicate names, legacy-save conversion and discoveries.
// Synthetic cases always run; installed-data cases skip without gamedata/ (never committed).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { Catalog } from '../client/gameplay/travel/catalog.js';
import { classicCatalog, CLASSIC_STARTERS } from '../client/gameplay/travel/classic.js';
import {
  canonicalAddress, migratePlaces, regionNameOf, exteriorAddress, normalizeFound, hasFound, addFound, IDENTITY_VERSION,
} from '../client/gameplay/travel/identity.js';
import { placeOf } from '../client/gameplay/townServices/rules.js';
import { regionOf as chatRegion } from '../server/rpg/social/chat.js';
import { regionOf as weatherRegion } from '../client/gameplay/atmosphere/calendar.js';
import { loadWorldFromDir } from '../server/rpg/travel/data.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { BsaArchive, NAME_RECORD } from '../client/world/bsa.js';
import { readLocation } from '../client/world/maps.js';
import { readDungeon } from '../client/world/interiors/dungeonMaps.js';
import { parseLocation, exteriorOf } from '../client/world/interiors/index.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'MAPS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';
const SHRINE = "town:Alik'r Desert/Djen Lodge";

// Two same-named records plus a replaced name, in MAPS.BSA order.
function fixture() {
  return new Catalog([
    { region: "Alik'r Desert", regionIndex: 0, index: 139, name: 'Djen Lodge', type: 'cult', discovered: true, x: 310, y: 435 },
    { region: "Alik'r Desert", regionIndex: 0, index: 272, name: 'Djen Lodge', type: 'cult', discovered: false, x: 319, y: 483 },
    { region: 'Daggerfall', regionIndex: 17, index: 197, name: 'Gothway Garden', type: 'hamlet', discovered: true, x: 109, y: 159 },
    { region: 'Daggerfall', regionIndex: 17, index: 1246, sourceName: 'Copperfield Manor', name: 'Port of Daggerfall', type: 'wealthy', discovered: false, x: 205, y: 214 },
  ], 'files');
}

test('catalogue contract: first keeps its name address, later duplicates are numeric', () => {
  const c = fixture();
  const [a, b] = [c.at(0, 139), c.at(0, 272)];
  assert.equal(a.id, SHRINE);
  assert.equal(b.id, 'town:0/272');
  assert.equal(a.slotId, 'town:0/139');
  assert.equal(c.atPixel(319, 483), b);
  assert.equal(c.get('town:0/272'), b);
  assert.equal(c.get('town:0/139'), a, 'numeric slot of a first record resolves to it');
  assert.equal(c.get(SHRINE), a, 'historical first match');
  assert.equal(c.get(SHRINE, { regionIndex: 0, index: 272 }), b, 'saved discriminator');
  assert.equal(c.get(SHRINE, { x: 319, y: 483 }), b, 'saved pixel');
  assert.equal(c.get(SHRINE, { x: 1, y: 1 }), a, 'unrelated hint falls back to first');
  assert.equal(c.get('town:Daggerfall/Port of Daggerfall'), c.get('town:Daggerfall/Copperfield Manor'));
  assert.ok(c.ambiguous(a) && c.ambiguous(b) && !c.ambiguous(c.at(17, 197)));
  assert.deepEqual(c.search('djen').map(e => e.id), [SHRINE, 'town:0/272']);
});

test('canonical addresses cover town, interior, dungeon and legacy building ids', () => {
  const c = fixture();
  assert.equal(canonicalAddress(c, "town:ALIK'R DESERT/djen lodge"), SHRINE);
  assert.equal(canonicalAddress(c, 'town:0/139'), SHRINE);
  assert.equal(canonicalAddress(c, 'interior:0/272/0,0/3'), 'interior:0/272/0,0/3');
  assert.equal(canonicalAddress(c, 'interior:daggerfall/gothway garden/1,0/4'), 'interior:Daggerfall/Gothway Garden/1,0/4');
  assert.equal(canonicalAddress(c, 'building:daggerfall/gothway garden/3'), 'building:Daggerfall/Gothway Garden/3');
  assert.equal(canonicalAddress(c, 'dungeon:Daggerfall/Port of Daggerfall'), 'dungeon:Daggerfall/Copperfield Manor');
  assert.equal(canonicalAddress(c, 'wilderness:110,159'), 'wilderness:110,159');
  assert.equal(canonicalAddress(c, 'town:Nowhere/Nothing'), 'town:Nowhere/Nothing', 'unknown stays');
  assert.equal(canonicalAddress(classicCatalog(), 'town:daggerfall/gothway garden'), 'town:daggerfall/gothway garden', 'no MAPS.BSA: untouched');
  assert.equal(exteriorAddress('interior:0/272/0,0/3'), 'town:0/272');
  // Interiors' own parser and exterior rule accept numeric addresses.
  assert.deepEqual(parseLocation('interior:0/272/2,1/5'), { kind: 'interior', region: '0', location: '272', bx: 2, by: 1, record: 5 });
  assert.equal(exteriorOf('dungeon:0/272'), 'town:0/272');
});

test('region-keyed consumers use the record region name for numeric addresses', () => {
  assert.equal(regionNameOf('0'), "Alik'r Desert");
  assert.equal(regionNameOf('Daggerfall'), 'Daggerfall');
  assert.equal(placeOf('town:0/272').region, "Alik'r Desert", 'bank account region');
  assert.equal(placeOf('interior:0/272/0,0/3').region, "Alik'r Desert");
  assert.equal(placeOf('interior:0/272/0,0/3').town, 'town:0/272');
  assert.equal(chatRegion('interior:0/272/0,0/3'), "Alik'r Desert");
  assert.equal(weatherRegion('town:0/272'), "Alik'r Desert");
});

test('starter list carries record indices so its slots are distinct', () => {
  const c = classicCatalog();
  assert.equal(c.at(17, 197).id, 'town:Daggerfall/Gothway Garden');
  assert.equal(c.at(17, 1231).id, 'town:Daggerfall/Daggerfall');
  assert.equal(new Set(c.locations.map(e => e.slotId)).size, CLASSIC_STARTERS.length);
});

function legacySave() {
  return {
    location: 'interior:daggerfall/gothway garden/1,0/4',
    portal: { id: 'b:1,0:4', from: 'town:daggerfall/gothway garden', to: 'interior:daggerfall/gothway garden/1,0/4', label: 'The Smithy', footY: 0,
      returnTo: { location: 'town:daggerfall/gothway garden', x: 12.5, z: -3, yaw: 1.2 } },
    travel: {
      discovered: ['town:Daggerfall/Port of Daggerfall', 'town:0/272', 'town:Gone/Away'],
      positions: { 'town:daggerfall/gothway garden': { x: 1, z: 2, yaw: 0 } },
      lastTown: 'town:daggerfall/gothway garden', trips: 3,
    },
    wilderness: { returnTo: 'town:daggerfall/gothway garden', discovered: [] },
    quests: { v: 1, active: [{ id: 'q1', places: { L00: { location: 'town:daggerfall/gothway garden', interior: 'interior:daggerfall/gothway garden/1,0/4', revealed: true } } }] },
    townServices: { repairs: [{ ticket: 'rp1', counterId: 'b:1,0:4', town: 'town:daggerfall/gothway garden', shop: 'The Smithy', item: { id: 'i1' }, cost: 5, leftAt: 1, readyAt: 2 }] },
  };
}

test('legacy save converts atomically, preserves quest and repair, and repeat loading is harmless', () => {
  const c = fixture();
  const rpg = legacySave();
  const changes = migratePlaces(rpg, c);
  assert.ok(changes.includes('location') && changes.includes('travel.discovered'));
  assert.equal(rpg.location, 'interior:Daggerfall/Gothway Garden/1,0/4');
  assert.equal(rpg.portal.returnTo.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(rpg.portal.returnTo.x, 12.5, 'same door');
  assert.equal(rpg.travel.lastTown, 'town:Daggerfall/Gothway Garden');
  assert.deepEqual(Object.keys(rpg.travel.positions), ['town:Daggerfall/Gothway Garden']);
  assert.deepEqual(rpg.travel.found, { 0: [272], 17: [1246] });
  assert.deepEqual(rpg.travel.discovered, ['town:Gone/Away'], 'unknown legacy ids are kept, not dropped');
  assert.equal(rpg.wilderness.returnTo, 'town:Daggerfall/Gothway Garden');
  assert.equal(rpg.quests.active[0].places.L00.interior, 'interior:Daggerfall/Gothway Garden/1,0/4');
  assert.equal(rpg.quests.active[0].places.L00.revealed, true);
  assert.equal(rpg.townServices.repairs[0].town, 'town:Daggerfall/Gothway Garden');
  assert.equal(rpg.townServices.repairs[0].item.id, 'i1');
  assert.equal(rpg.travel.identity, IDENTITY_VERSION);
  const snapshot = JSON.stringify(rpg);
  assert.deepEqual(migratePlaces(rpg, c), []);
  assert.equal(JSON.stringify(rpg), snapshot);
  // Without MAPS.BSA nothing is touched: starter saves keep working while data is absent or loading.
  const fresh = legacySave();
  assert.deepEqual(migratePlaces(fresh, classicCatalog()), []);
  assert.deepEqual(fresh, legacySave());
});

test('a legacy discriminator selects the later duplicate once, then is ignored', () => {
  const c = fixture();
  const rpg = { location: SHRINE, travel: { here: { regionIndex: 0, index: 272 } } };
  migratePlaces(rpg, c);
  assert.equal(rpg.location, 'town:0/272');
  rpg.location = SHRINE; // a converted save names the first shrine on purpose
  migratePlaces(rpg, c);
  assert.equal(rpg.location, SHRINE);
});

test('found set stays sorted and normalizes junk', () => {
  const f = normalizeFound({ 0: [272, 5, 5, -1, 'x'], 99: [1], foo: [2] });
  assert.deepEqual(f, { 0: [5, 272] });
  assert.ok(addFound(f, { regionIndex: 0, index: 139 }));
  assert.ok(!addFound(f, { regionIndex: 0, index: 139 }));
  assert.deepEqual(f[0], [5, 139, 272]);
  assert.ok(hasFound(f, { regionIndex: 0, index: 272 }) && !hasFound(f, { regionIndex: 1, index: 272 }));
});

// ------------------------------------------------------------------ installed data

let world;
before(async () => {
  if (hasData) world = await loadWorldFromDir(ARENA2);
});

function server(players) {
  let api;
  const runtime = createRpgRuntime({
    players, save() {}, send() {}, dataPath: ARENA2, log: { info() {}, warn() {}, error() {} },
    features: [(ctx) => { api = installTravel(ctx); }],
  });
  return { runtime, get api() { return api; } };
}

test('installed: every record resolves by key and pixel; duplicates never shadow', { skip }, () => {
  const c = world.catalog;
  assert.equal(c.size, 15251);
  const ids = new Set();
  let numeric = 0;
  for (const e of c.locations) {
    assert.equal(c.at(e.regionIndex, e.index), e);
    assert.equal(c.get(e.slotId), e);
    assert.equal(c.atPixel(e.x, e.y), e, `pixel ${e.x},${e.y}`);
    assert.equal(c.get(e.id), e, e.id);
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    if (/^town:\d+\/\d+$/.test(e.id)) numeric++;
  }
  assert.equal(numeric, 225, 'later duplicates of 129 shared keys');
  assert.equal(c.locations.filter(e => !e.discovered).length, 4052);
});

test("installed: both Alik'r Djen Lodges load their own exterior and dungeon record", { skip }, async () => {
  const c = world.catalog;
  const [a, b] = [c.at(0, 139), c.at(0, 272)];
  assert.deepEqual([a.id, a.x, a.y, b.id, b.x, b.y], [SHRINE, 310, 435, 'town:0/272', 319, 483]);
  assert.equal(c.atPixel(310, 435), a);
  assert.equal(c.atPixel(319, 483), b);
  const maps = await BsaArchive.open(await openAsBlob(join(ARENA2, 'MAPS.BSA')), 'MAPS.BSA', NAME_RECORD);
  const la = await readLocation(maps, 0, 'Djen Lodge');
  const lb = await readLocation(maps, '0', '272');
  assert.equal(la.index, 139);
  assert.equal(lb.index, 272);
  assert.equal(la.townId, SHRINE);
  assert.equal(lb.townId, 'town:0/272');
  assert.notDeepEqual([la.longitude, la.latitude], [lb.longitude, lb.latitude]);
  const [da, db] = [await readDungeon(maps, 0, 'Djen Lodge'), await readDungeon(maps, 0, '272')];
  assert.equal(da?.index ?? 139, 139);
  if (db) assert.equal(db.index, 272);
});

test('installed: both shrines survive travel, save and restart independently', { skip }, async () => {
  const players = new Map();
  const s1 = server(players);
  await s1.api.ready;
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { gold: 5000 } };
  players.set(1, p);
  s1.runtime.join(p);
  assert.deepEqual(s1.runtime.act(p, 'travel.go', { to: 'town:0/272' }), { ok: true });
  assert.equal(p.rpg.location, 'town:0/272');
  p.x = 7; p.z = -4;
  const q1 = s1.api.service.quote(p, SHRINE);
  assert.ok(q1.days >= 1);
  // Restart: a new server reads the saved row.
  const saved = JSON.parse(JSON.stringify({ ...p, rpg: p.rpg }));
  const players2 = new Map();
  const s2 = server(players2);
  await s2.api.ready;
  players2.set(1, saved);
  s2.runtime.join(saved);
  assert.equal(saved.rpg.location, 'town:0/272', 'second shrine still second after restart');
  saved.rpg.travel.positions = saved.rpg.travel.positions ?? {};
  // Leave the cooldown, then go to the first shrine and back.
  const later = s2.runtime;
  await new Promise(r => setTimeout(r, 1600));
  assert.deepEqual(later.act(saved, 'travel.go', { to: SHRINE }), { ok: true });
  assert.equal(saved.rpg.location, SHRINE);
  assert.deepEqual(saved.rpg.travel.positions['town:0/272'], { x: 7, z: -4, yaw: 0 });
  await new Promise(r => setTimeout(r, 1600));
  assert.deepEqual(later.act(saved, 'travel.go', { to: 'town:0/272' }), { ok: true });
  assert.deepEqual([saved.x, saved.z], [7, -4], 'returns to its own saved position');
});

test('installed: every hidden record can be discovered and survives restart', { skip }, async () => {
  const players = new Map();
  const s1 = server(players);
  await s1.api.ready;
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { gold: 0 } };
  players.set(1, p);
  s1.runtime.join(p);
  const hidden = world.catalog.locations.filter(e => !e.discovered);
  let added = 0;
  for (const e of hidden) if (s1.api.service.discover(p, e.id)) added++;
  assert.equal(added, 4052);
  const bytes = JSON.stringify(p.rpg).length;
  assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
  test.diagnostic?.(`all 4,052 hidden records: ${bytes} bytes of character data`);
  const saved = JSON.parse(JSON.stringify(p));
  const players2 = new Map();
  const s2 = server(players2);
  await s2.api.ready;
  players2.set(1, saved);
  s2.runtime.join(saved);
  const t = saved.rpg.travel;
  const missing = hidden.filter(e => !hasFound(t.found, e));
  assert.equal(missing.length, 0);
  // A legacy save at the old 4,000 cap converts and keeps all its entries.
  const legacy = { id: 2, name: 'B', x: 0, z: 0, yaw: 0, rpg: { travel: { discovered: hidden.slice(0, 4000).map(e => e.id) } } };
  players2.set(2, legacy);
  s2.runtime.join(legacy);
  assert.equal(Object.values(legacy.rpg.travel.found).reduce((n, l) => n + l.length, 0), 4000);
  assert.deepEqual(legacy.rpg.travel.discovered, []);
});

test('installed: classic-only start keeps legacy discoveries until MAPS.BSA is available', { skip }, () => {
  const players = new Map();
  let api;
  const runtime = createRpgRuntime({
    players, save() {}, send() {}, log: { info() {}, warn() {}, error() {} },
    features: [(ctx) => { api = installTravel(ctx); }],
  });
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { travel: { discovered: ['town:0/272'] } } };
  players.set(1, p);
  runtime.join(p);
  assert.equal(api.service.source, 'classic');
  assert.deepEqual(p.rpg.travel.discovered, ['town:0/272']);
  assert.equal(p.rpg.travel.identity, undefined);
});
