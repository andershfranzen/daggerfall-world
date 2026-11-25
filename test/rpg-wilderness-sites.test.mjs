// Brief H (docs/world-expansion-plan.md): wilderness farm, coastal dock, camp and empty-pixel routes.
//
//   * coast.js: Location Loader's FindNearestCoast on synthetic tilemaps (water start, land start, no coast,
//     neighbour edge) and the tile shift of a whole site
//   * the interiors source hook: another feature's instances go through portal.use / portal.leave / reconnect
//   * installed ARENA2 + World of Daggerfall (skipped without them): the farm wod:110,159:107,54 has real RMB doors
//     whose outside is clear and whose wall blocks, two players enter the same farmhouse, leave by its door and
//     resume inside after a restart; the camp wod:109,158:21,21 has one shared fight and one corpse search; the
//     coastal dock is drawn on the sea-level ground, the inland audit dock wod:98,162:63,53 is reported as having
//     no coast; the camp pixel and an empty pixel stay traversable with the pack disabled (classic only)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNearestCoast, shiftSite, snapCoastalSites, COAST_TDIM } from '../client/world/wilderness/coast.js';
import {
  parseSiteInterior, siteInteriorLocation, siteBuildingPortalId,
} from '../client/world/wilderness/buildings.js';
import { parseLocation } from '../client/world/interiors/index.js';
import { installWildernessBuildings, wildernessDoors, nearestDoor } from '../client/gameplay/wilderness/buildings.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import { arrivalStatus } from '../client/lib/arrival.js';
import { createCoastCache } from '../server/rpg/wilderness/coast.js';
import { install as installWilderness } from '../server/rpg/wilderness.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInteriors } from '../server/rpg/interiors.js';
import { createFixtureWorld } from './support/rpg-session.mjs';
import realFeatures from '../server/rpg/features.js';

const quiet = { error() {}, warn() {}, info() {}, log() {} };
const root = fileURLToPath(new URL('..', import.meta.url));
const ARENA2 = ['gamedata/DaggerfallGameFiles/arena2', 'gamedata/DaggerfallGameFiles/ARENA2'].map((d) => root + d).find((d) => existsSync(join(d, 'MAPS.BSA')));
const WOD = root + 'gamedata/world-of-daggerfall';
const HAVE_WOD = existsSync(join(WOD, 'Locations'));
const installedSkip = (!ARENA2 || !HAVE_WOD) && 'ARENA2 or the World of Daggerfall pack is not installed';

const FARM = 'wod:110,159:107,54';
const FARM_PIXEL = 'wilderness:110,159';
const CAMP = 'wod:109,158:21,21';
const CAMP_PIXEL = 'wilderness:109,158';
const INLAND_DOCK = 'wod:98,162:63,53';
const COAST_DOCK = 'wod:160,221:63,123'; // Fontborne Docks: authored on the water's edge
const EMPTY_PIXEL = 'wilderness:105,156'; // no pack site and no classic town in it or its neighbours

// ------------------------------------------------------------------------------------------------ coast

/** 128x128 tilemap: water (0) where `water(x, y)`, else grass (2). */
const tilemap = (water) => {
  const t = new Uint8Array(COAST_TDIM * COAST_TDIM).fill(2);
  for (let y = 0; y < COAST_TDIM; y++) for (let x = 0; x < COAST_TDIM; x++) if (water(x, y)) t[x + y * COAST_TDIM] = 0;
  return t;
};

describe('coast snap (Location Loader FindNearestCoast)', () => {
  test('a dock on land moves to the first water tile, testing north, east, south, west', () => {
    const sea = tilemap((x) => x >= 80); // sea to the east
    assert.deepEqual(findNearestCoast(sea, 60, 50), { found: true, tx: 80, ty: 50, start: 'land' });
    const north = tilemap((x, y) => y >= 70 || x >= 80); // north water is nearer than east
    assert.deepEqual(findNearestCoast(north, 60, 50), { found: true, tx: 60, ty: 70, start: 'land' });
    // Ties break in Location Loader's order: north before east.
    const tie = tilemap((x, y) => y >= 60 || x >= 70);
    assert.deepEqual(findNearestCoast(tie, 60, 50), { found: true, tx: 60, ty: 60, start: 'land' });
  });

  test('a dock in the water moves back to the last water tile before land', () => {
    const sea = tilemap((x) => x <= 40); // land to the east of x = 40
    assert.deepEqual(findNearestCoast(sea, 20, 64), { found: true, tx: 40, ty: 64, start: 'water' });
  });

  test('open sea snaps to the edge facing a loaded neighbour with land; otherwise stays', () => {
    const open = tilemap(() => true);
    const land = tilemap(() => false);
    assert.deepEqual(findNearestCoast(open, 30, 64), { found: false, tx: 30, ty: 64, start: 'water' });
    assert.deepEqual(findNearestCoast(open, 30, 64, { east: land }), { found: true, tx: 127, ty: 64, start: 'water' });
    assert.deepEqual(findNearestCoast(open, 30, 64, { north: land, east: land }), { found: true, tx: 30, ty: 127, start: 'water' });
  });

  test('inland with no water in the pixel: no coast, the authored tile is kept', () => {
    assert.deepEqual(findNearestCoast(tilemap(() => false), 63, 53), { found: false, tx: 63, ty: 53, start: 'land' });
  });

  test('a snapped site moves objects, markers, matrices, anchor and rect together (north is -z)', () => {
    const site = {
      id: 'wod:1,1:10,10', instanceType: 2, pixel: [1, 1], tile: { x: 10, y: 10 }, anchor: [0, 0, 0],
      rect: { x: -1, z: -1, width: 2, depth: 2 },
      objects: [{ objectID: 0, kind: 'block', position: [1, 0, 1], matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 1, 0, 1, 1] }],
      markers: [{ objectID: 1, marker: 19, position: [2, 0, 2] }],
    };
    const s = shiftSite(site, 2, 3);
    assert.deepEqual(s.tile, { x: 12, y: 13 });
    const r = (v) => (Array.isArray(v) ? v.map(r) : Math.round(v * 1e6) / 1e6);
    assert.deepEqual(r(s.anchor), [12.8, 0, -19.2]);
    assert.deepEqual(r([s.rect.x, s.rect.z, s.rect.width, s.rect.depth]), [11.8, -20.2, 2, 2]);
    assert.deepEqual(r(s.objects[0].position), [13.8, 0, -18.2]);
    assert.deepEqual(r([s.objects[0].matrix[12], s.objects[0].matrix[14]]), [13.8, -18.2]);
    assert.deepEqual(r(s.markers[0].position), [14.8, 0, -17.2]);
    assert.deepEqual(site.anchor, [0, 0, 0], 'input untouched');
    const sea = tilemap((x) => x >= 15);
    const { descriptors, report } = snapCoastalSites(new Map([['1,1', { sites: [site, { id: 'x', instanceType: 0 }] }]]), () => sea);
    assert.deepEqual(report.map((r) => [r.id, r.snapped, r.dtx, r.dty]), [['wod:1,1:10,10', true, 5, 0]]);
    assert.equal(descriptors.get('1,1').sites[0].tile.x, 15);
    assert.equal(descriptors.get('1,1').sites[1].id, 'x');
  });
});

// ------------------------------------------------------------------------------------------------ ids

test('wilderness building ids cannot collide with classic town interiors', () => {
  const id = siteInteriorLocation(FARM, 0, 0);
  assert.equal(id, 'interior:wod:110,159:107,54/0/0');
  assert.deepEqual(parseSiteInterior(id), { site: FARM, objectID: '0', record: 0 });
  assert.equal(parseLocation(id), null, 'the classic parser refuses it');
  assert.equal(parseSiteInterior('interior:Daggerfall/Gothway Garden/1,2/3'), null);
  assert.equal(parseSiteInterior('interior:wod:110,159:107,54/0/0/../x'), null);
  assert.equal(siteBuildingPortalId(FARM, 0, 0), 'wb:107,54:0:0');
  assert.equal(siteBuildingPortalId('wod:108,159:64,21#2', '9.1', 3), 'wb:64,21.2:9.1:3');
  const doors = wildernessDoors({ buildings: [{ portalId: 'wb:1,1:0:0', buildingType: 18, site: 's', siteName: 'Farm', doors: [{ x: 3, z: 4 }, { x: 30, z: 4 }] }] });
  assert.deepEqual(nearestDoor(doors, 0, 0, 5), { portalId: 'wb:1,1:0:0', label: 'House', x: 3, z: 4, site: 's', siteName: 'Farm' });
  assert.equal(nearestDoor(doors, 0, 0, 2), null);
});

// ------------------------------------------------------------------------------------------------ hook

test('a failed farmhouse scene blocks arrival with a reason and can be retried in the same place', async () => {
  const location = siteInteriorLocation(FARM, 0, 0);
  const api = createGameplayApi({});
  const errors = [];
  api.on('sceneError', event => errors.push(event));
  const attempts = [];
  installWildernessBuildings(api, {
    loadScene: () => new Promise((resolve, reject) => attempts.push({ resolve, reject })),
  });
  const join = () => api._receiveRpg({ type: 'rpg', character: { location } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  join();
  await settle();
  api._reset();
  join();
  await settle();
  attempts[0].reject(new Error('previous connection'));
  await settle();
  assert.equal(errors.length, 0);
  attempts[1].reject(new Error('Farm layout unavailable'));
  await settle();
  const failed = arrivalStatus(api, { sceneError: errors[0] });
  assert.deepEqual(failed.failed, { part: 'scene', message: 'Farm layout unavailable' });
  assert.equal(failed.ready, false);
  api._reset();
  join();
  await settle();
  attempts[2].resolve({ kind: 'interior', location });
  await settle();
  assert.equal(arrivalStatus(api, { scene: api.town }).ready, true);
});

test('interiors.addSource: another feature’s instances use portal.use, portal.leave and reconnect', async () => {
  const players = new Map();
  const PIX = 'wilderness:5,5';
  const INSIDE = 'interior:wod:5,5:10,10/0/0';
  const spec = {
    id: 'wb:10,10:0:0', from: PIX, to: INSIDE, kind: 'building', label: 'House',
    entrances: [{ x: 10, y: 0, z: 10, enter: { x: 0, y: 0, z: 1, yaw: 0 }, inner: { x: 0, z: 0 }, exit: { x: 10, y: 0, z: 11, yaw: 3 } }],
    exits: [{ x: 0, y: 0, z: 0 }],
  };
  let surveys = 0;
  const rt = createRpgRuntime({
    players, save: () => {}, send: () => {}, log: quiet,
    features: [
      (ctx) => installInteriors(ctx, { source: { townPortals: async () => [], scene: async () => ({}) }, locations: [] }),
      (ctx) => ctx.services.interiors.addSource({
        owns: (l) => (l === PIX ? 'exterior' : l === INSIDE ? 'instance' : null),
        exteriorOf: () => PIX,
        portals: async () => (surveys++, [spec]),
        scene: async () => ({ kind: 'interior' }),
      }),
    ],
  });
  const s = rt.ctx.services;
  assert.equal(s.interiors.isInstance(INSIDE), true);
  assert.equal(s.interiors.isInstance(PIX), false);
  assert.equal(s.interiors.exteriorOf(INSIDE), PIX);
  const p = { id: 1, name: 'A', x: 10, z: 11, yaw: 0, rpg: { location: PIX } };
  players.set(1, p);
  rt.join(p);
  await s.interiors.survey(PIX);
  assert.equal(surveys, 1);
  assert.deepEqual(rt.act(p, 'portal.use', { portalId: spec.id }), { ok: true });
  assert.equal(p.rpg.location, INSIDE);
  assert.equal(p.rpg.portal.returnTo.location, PIX);
  assert.deepEqual(s.encounterSites(INSIDE), [], 'no monsters inside a farmhouse');
  rt.leave(p);
  // Rejoin inside: the instance still exists, so the player stays.
  rt.join(p);
  assert.equal(p.rpg.location, INSIDE);
  p.x = 0;
  p.z = 0.5;
  rt.tick(1);
  assert.deepEqual(rt.act(p, 'portal.leave', {}), { ok: true });
  assert.equal(p.rpg.location, PIX);
  assert.deepEqual([p.x, p.z], [10, 11]);
  assert.equal(surveys, 1, 'surveyed once');
});

// ------------------------------------------------------------------------------------------------ installed data

/** A fixture world (real runtime, features, SQLite) on the installed data, with or without the pack. */
async function installedWorld(t, { pack = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wilderness-sites-'));
  const empty = mkdtempSync(join(tmpdir(), 'no-wod-'));
  const features = realFeatures.map((f) => ({ name: f.name, install: f.install }));
  const world = await createFixtureWorld({ dbPath: join(dir, 'world.db'), features, dataPath: ARENA2, config: { wodPath: pack ? WOD : empty, worldHalfExtent: 1024 } });
  t.after(() => {
    try {
      world.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
  await world.ctx.services.wilderness.ready;
  return world;
}

/** Hold a heading through the authoritative per-tick movement (0.16 m per 40 ms tick). */
function walk(s, location, x, z, vx, vz, ticks) {
  const p = { id: `probe${x},${z}`, x, z, rpg: { location } };
  for (let i = 0; i < ticks; i++) {
    const m = s.movePlayer(p, p.x + vx * 0.16, p.z + vz * 0.16);
    p.x = m.x;
    p.z = m.z;
  }
  return p;
}

describe('installed data: farm building doors (wod:110,159:107,54)', { skip: installedSkip }, () => {
  test('two players enter the authored farmhouse, see each other, leave by its door and resume inside after a restart', { timeout: 240_000 }, async (t) => {
    const world = await installedWorld(t);
    const s = world.ctx.services;
    assert.equal(s.wilderness.status().pack, 'ready');
    const a = world.connect('acct-a', 'Aldora');
    const b = world.connect('acct-b', 'Brannoc');
    a.must('wilderness.visit', { site: FARM });
    world.clock.advance(2000);
    b.must('wilderness.visit', { site: FARM });
    assert.equal(a.character.location, FARM_PIXEL);
    await s.interiors.survey(FARM_PIXEL);
    assert.equal((await s.collision.whenSettled(FARM_PIXEL)).status, 'ready');

    const portals = s.portals.at(FARM_PIXEL);
    assert.deepEqual(portals.map((p) => p.id).sort(), ['wb:107,54:0:0', 'wb:21,54:0:0'], 'both farms of the pixel have one enterable house');
    const house = s.portals.get(FARM_PIXEL, 'wb:107,54:0:0');
    assert.equal(house.label, 'House');
    assert.equal(house.meta.block, 'FARMAA03.RMB');
    assert.equal(house.entrances.length, 2, 'the farmhouse has a front and a back door');

    // The doors are on the drawn walls: standing outside is clear, walking through the closed door is not.
    for (const e of house.entrances) {
      assert.ok(s.collision.isClear(FARM_PIXEL, e.exit.x, e.exit.z), `outside door (${e.x}, ${e.z}) is clear`);
      const inward = { x: e.x - (e.exit.x - e.x) * 1.5, z: e.z - (e.exit.z - e.z) * 1.5 };
      assert.equal(s.collision.canWalkSegment(FARM_PIXEL, e.exit.x, e.exit.z, inward.x, inward.z), false, 'the wall with the door blocks');
    }

    const front = house.entrances[0];
    a.moveTo(front.exit.x, front.exit.z);
    b.moveTo(front.exit.x + 0.4, front.exit.z);
    world.tick(40);
    a.must('portal.use', { portalId: house.id });
    b.must('portal.use', { portalId: house.id });
    const INSIDE = 'interior:wod:110,159:107,54/0/0';
    assert.equal(a.character.location, INSIDE);
    assert.equal(b.character.location, INSIDE);
    const coll = await s.collision.whenSettled(INSIDE);
    assert.equal(coll.status, 'ready');
    assert.match(coll.source, /ARENA2 House, Farm A/);
    const farmhouse = await s.interiors.scene(INSIDE);
    assert.deepEqual(farmhouse.flats.map(f => [f.archive, f.record]), [[210, 26], [210, 13], [210, 13]]);
    world.tick(40);
    assert.ok(a.peer(b.id), 'A sees B inside the same farmhouse');
    const pa = world.players.get(a.id);
    assert.ok(s.collision.isClear(INSIDE, pa.x, pa.z), 'the landing inside is clear');
    assert.ok(Number.isFinite(s.collision.groundAt(INSIDE, pa.x, pa.z)), 'the landing stands on the floor');

    // B disconnects inside; the world restarts on the same database; B resumes inside the farmhouse.
    b.leave();
    world.restart();
    await world.ctx.services.wilderness.ready;
    const b2 = world.connect('acct-b', 'Brannoc');
    await world.ctx.services.interiors.survey(INSIDE);
    world.tick(40);
    assert.equal(b2.character.location, INSIDE, 'resumes inside after the restart');

    // Walk back to the exit door and leave: B lands outside the door it entered by.
    const s2 = world.ctx.services;
    await s2.collision.whenSettled(INSIDE);
    const portal = s2.portals.into(INSIDE);
    const exit = portal.exits.reduce((best, e) => (Math.hypot(e.x - pa.x, e.z - pa.z) < Math.hypot(best.x - pa.x, best.z - pa.z) ? e : best));
    b2.moveTo(exit.x + (pa.x - exit.x) * 0.3, exit.z + (pa.z - exit.z) * 0.3);
    world.tick(40);
    b2.must('portal.leave', {});
    assert.equal(b2.character.location, FARM_PIXEL);
    const pb = world.players.get(b2.id);
    assert.ok(Math.hypot(pb.x - front.exit.x, pb.z - front.exit.z) < 0.01, 'back outside the front door');
  });
});

describe('installed data: camp encounter (wod:109,158:21,21)', { skip: installedSkip }, () => {
  test('two players fight one authored camp bandit and its corpse is searched exactly once', { timeout: 240_000 }, async (t) => {
    const world = await installedWorld(t);
    const s = world.ctx.services;
    const a = world.connect('acct-a', 'Aldora');
    const b = world.connect('acct-b', 'Brannoc');
    a.must('wilderness.visit', { site: CAMP });
    world.clock.advance(2000);
    b.must('wilderness.visit', { site: CAMP });
    await s.collision.whenSettled(CAMP_PIXEL);
    world.tick(40);
    world.tick(40);
    const sites = s.encounterSites(CAMP_PIXEL).filter((e) => e.key.startsWith(`${CAMP}#`));
    assert.equal(sites.length, 2, 'two authored 199.16 markers');
    const monsters = [...world.ctx.entities.values()].filter((e) => e.location === CAMP_PIXEL && e.kind === 'monster' && String(e.key ?? e._key ?? '').startsWith(CAMP));
    const mobs = monsters.length ? monsters : [...world.ctx.entities.values()].filter((e) => e.location === CAMP_PIXEL && e.kind === 'monster');
    assert.ok(mobs.length >= 2, `camp monsters spawned (${mobs.length})`);
    const target = mobs.reduce((m, e) => (Math.hypot(e.x - sites[0].x, e.z - sites[0].z) < Math.hypot(m.x - sites[0].x, m.z - sites[0].z) ? e : m));
    assert.equal(a.entity(target.id)?.hp, b.entity(target.id)?.hp, 'both see one hp');
    // Keep the others out of the way so the fight measures shared state.
    for (const e of mobs) if (e !== target) world.ctx.entities.delete(e.id);
    a.must('combat.ready', { ready: true });
    b.must('combat.ready', { ready: true });
    // Fixture: a sturdier bandit so the pinned dice let both players land blows before it falls.
    target.maxHp = target.hp = Math.max(target.hp, 80);
    const hitters = new Set();
    for (let i = 0; i < 800 && !target.dead; i++) {
      const c = i % 2 ? b : a;
      for (const [k, side] of [[a, 1], [b, -1]]) {
        const p = world.players.get(k.id);
        const ch = p.rpg.character;
        ch.health = ch.maxHealth;
        ch.fatigue = ch.maxFatigue;
        if (Math.hypot(target.x - p.x, target.z - p.z) > 1.6) {
          p.x = target.x + 1.1 * side;
          p.z = target.z + 0.5;
        }
        p.yaw = Math.atan2(target.x - p.x, -(target.z - p.z));
      }
      const hp = target.hp;
      const r = c.act('combat.attack', { targetId: target.id, direction: 'down' });
      if (r.ok && target.hp < hp) hitters.add(c.id);
      world.tick(1600);
    }
    assert.equal(target.dead, true, 'the bandit died');
    assert.equal(hitters.size, 2, 'both players dealt damage');
    world.clock.advance(60_000);
    world.tick(40);
    if (target.lootable) {
      a.must('combat.loot', { targetId: target.id });
      const second = b.act('combat.loot', { targetId: target.id });
      assert.equal(second.ok, false);
      assert.match(second.error, /already been searched|nothing/i);
    } else {
      assert.equal(a.act('combat.loot', { targetId: target.id }).ok, false, 'an empty corpse cannot be searched');
    }
    // The camp's 199.19 treasure is searched once per character.
    const treasure = s.wilderness.scene(CAMP_PIXEL).sites.find((x) => x.id === CAMP).markers.find((m) => m.loot);
    a.moveTo(treasure.position[0], treasure.position[2] + 1);
    world.tick(40);
    a.must('wilderness.loot', { site: CAMP, object: treasure.objectID });
    assert.equal(a.act('wilderness.loot', { site: CAMP, object: treasure.objectID }).ok, false);
  });
});

describe('installed data: docks against the water', { skip: installedSkip }, () => {
  let server, s, dir;
  before(async () => {
    const { createGameServer } = await import('../server/game.js');
    dir = mkdtempSync(join(tmpdir(), 'wilderness-dock-'));
    server = createGameServer({ arena2Dir: ARENA2, wodPath: WOD, host: '127.0.0.1', port: 0, dbPath: join(dir, 'game.db'), worldHalfExtent: 1024 });
    s = server.runtime.ctx.services;
    await s.wilderness.ready;
  });
  after(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the coastal dock stands at sea level beside water; the shore and its available models collide', { timeout: 120_000 }, async () => {
    const { arena2Files } = await import('../server/rpg/collision/arena2.js');
    const { buildWildernessScene, neighbourLocations } = await import('../client/world/wilderness/scene.js');
    const { OCEAN_Y } = await import('../client/world/wilderness/terrain.js');
    const files = await arena2Files(ARENA2);
    const loc = 'wilderness:160,221';
    const neighbours = new Map();
    for (const id of neighbourLocations(160, 221)) { const d = s.wilderness.scene(id); neighbours.set(`${d.px},${d.py}`, d); }
    const mesh = await buildWildernessScene({ files, location: loc, descriptor: s.wilderness.scene(loc), neighbours, geometryOnly: true, worldData: s.worldData.ready });
    const coast = mesh.wilderness.coast.find((c) => c.id === COAST_DOCK);
    assert.deepEqual(coast, { id: COAST_DOCK, snapped: true, start: 'water', tile: [63, 123], moved: [0, 0] });
    assert.ok(Math.abs(mesh.wilderness.datum - OCEAN_Y) < 1e-6, 'the dock root is the ocean elevation');
    const site = s.wilderness.scene(loc).sites.find((x) => x.id === COAST_DOCK);
    const [ax, , az] = site.anchor;
    const ground = mesh.wilderness.heightAt(ax, az);
    assert.ok(ground >= 0 && ground < 3, `the dock anchor is on the waterline (ground ${ground.toFixed(2)} m above sea level)`);
    // North of the anchor (into the sea) the ground is the sea-level floor.
    assert.ok(Math.abs(mesh.wilderness.heightAt(ax, az - 30)) < 0.01, 'sea at the dock’s seaward side');
    assert.equal((await s.collision.whenSettled(loc)).status, 'ready');
    assert.ok(s.collision.isClear(loc, site.anchor[0], site.anchor[2] + 10), 'the shore beside the dock is walkable');
    // Missing optional dock deck models are reported, never substituted.
    const missing = mesh.warnings.filter((w) => /ARCH3D\.BSA: model 5\d{4} is missing/.test(w));
    console.log(`# ${COAST_DOCK}: ground ${ground.toFixed(2)} m above sea level; ${missing.length} dock deck models missing from ARCH3D (RMB Resource Pack): ${missing.map((w) => w.match(/model (\d+)/)[1]).join(' ')}`);
  });

  test('the audit dock wod:98,162:63,53 has no coast in its pixel and is reported, not moved', { timeout: 120_000 }, async () => {
    const { arena2Files } = await import('../server/rpg/collision/arena2.js');
    const { buildWildernessScene } = await import('../client/world/wilderness/scene.js');
    const files = await arena2Files(ARENA2);
    const loc = 'wilderness:98,162';
    const mesh = await buildWildernessScene({ files, location: loc, descriptor: s.wilderness.scene(loc), geometryOnly: true, worldData: s.worldData.ready });
    assert.deepEqual(mesh.wilderness.coast.find((c) => c.id === INLAND_DOCK), { id: INLAND_DOCK, snapped: false, start: 'land', tile: [63, 53], moved: [0, 0] });
    assert.ok(mesh.warnings.some((w) => w.includes(`${INLAND_DOCK}: no coast`)));
  });

  test('a cold Westhead Moor landing is usable only after the dock moves to the shoreline', async () => {
    const site = 'wod:207,223:63,73', target = 'wilderness:207,223', origin = 'wilderness:207,222';
    const coast = createCoastCache({ dataPath: ARENA2 });
    const p = { id: 'walker', x: 1, z: 2, yaw: 0, rpg: { location: origin } };
    const rt = createRpgRuntime({
      players: new Map([[p.id, p]]), log: quiet, send() {}, save() {},
      features: [ctx => installWilderness(ctx, { store: s.wilderness.store, coast, buildings: false })],
    });
    await rt.ctx.services.wilderness.ready;
    rt.join(p);
    const first = rt.act(p, 'wilderness.visit', { site });
    assert.equal(first.ok, false);
    assert.match(first.error, /shoreline is still loading/);
    assert.deepEqual([p.rpg.location, p.x, p.z], [origin, 1, 2]);
    assert.ok(!p.rpg.wilderness.discovered.includes(site));
    await coast.whenReady(site);
    const { spawn } = s.wilderness.scene(target, site);
    assert.deepEqual(rt.act(p, 'wilderness.visit', { site }), { ok: true });
    assert.deepEqual([p.rpg.location, p.x, p.z], [target, spawn.x, spawn.z - 17 * 6.4]);
  });
});

describe('installed data: classic only (pack disabled)', { skip: !ARENA2 && 'ARENA2 is not installed' }, () => {
  test('the camp pixel and an empty pixel are traversable with classic geometry only; no wilderness doors', { timeout: 240_000 }, async (t) => {
    const world = await installedWorld(t, { pack: false });
    const s = world.ctx.services;
    assert.equal(s.wilderness.status().pack, 'missing');
    for (const loc of [CAMP_PIXEL, EMPTY_PIXEL]) {
      const st = await s.collision.whenSettled(loc);
      assert.equal(st.status, 'ready', `${loc} collision`);
      assert.equal(st.source, 'ARENA2 wilderness geometry');
      await s.interiors.survey(loc);
      assert.deepEqual(s.portals.at(loc), [], `${loc}: no pack, no wilderness buildings`);
      // A long straight walk across open ground (no pack models to stop it).
      const from = { x: -200, z: 300 };
      const p = walk(s, loc, from.x, from.z, 1, 0, 250);
      assert.ok(p.x - from.x > 30, `${loc}: walked ${(p.x - from.x).toFixed(1)} m east on classic ground`);
    }
    assert.deepEqual(s.encounterSites(CAMP_PIXEL) ?? [], [], 'no pack camp markers with the pack disabled');
  });

  test('an empty pixel with the pack enabled has no sites and is traversable', { skip: installedSkip, timeout: 240_000 }, async (t) => {
    const world = await installedWorld(t);
    const s = world.ctx.services;
    assert.deepEqual(s.wilderness.scene(EMPTY_PIXEL).sites, [], `${EMPTY_PIXEL} has no pack sites`);
    assert.equal((await s.collision.whenSettled(EMPTY_PIXEL)).status, 'ready');
    const p = walk(s, EMPTY_PIXEL, -300, 0, 1, 0, 400);
    assert.ok(p.x + 300 > 50, `walked ${(p.x + 300).toFixed(1)} m`);
  });
});
