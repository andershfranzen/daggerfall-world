// Interiors and dungeons against the local Daggerfall install (gamedata/, never committed). Skips without it.
// INTERIORS_SWEEP=1 widens the sweep to every location with a dungeon in region Daggerfall.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTown } from '../client/world/town.js';
import { readRegionNames } from '../client/world/maps.js';
import { readDungeon } from '../client/world/interiors/dungeonMaps.js';
import {
  openWorldData, locationPortals, loadInterior, loadDungeon, portalSpecs, DOOR_TYPE,
} from '../client/world/interiors/index.js';
import { operatorFiles } from '../server/rpg/interiors/data.js';
import { townDoors } from '../client/gameplay/interiors.js';
import { countersFromPortals } from '../server/rpg/townServices/buildings.js';
import { worldFromTown } from '../client/gameplay/collision/world.js';
import { walkingRoute } from './support/walking-route.mjs';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInteriors } from '../server/rpg/interiors.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'MAPS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';
const TOWN = 'town:Daggerfall/Gothway Garden';
const HOLD = "town:Daggerfall/Privateer's Hold";

let files, data, gothway, gothwayPortals, hold, holdPortals;
before(async () => {
  if (!hasData) return;
  files = await operatorFiles(ARENA2);
  data = await openWorldData(files);
  gothway = await loadTown(files);
  gothwayPortals = await locationPortals(data, { region: 'Daggerfall', location: 'Gothway Garden' }, gothway.source.spawnLocal);
  hold = await loadTown(files, { location: "Privateer's Hold" });
  holdPortals = await locationPortals(data, { region: 'Daggerfall', location: "Privateer's Hold" }, hold.source.spawnLocal);
});

/** Heights of every triangle under (x, z) (vertical ray), in a scene's output positions. */
function heightsAt(P, x, z) {
  const out = [];
  for (let o = 0; o < P.length; o += 9) {
    const ax = P[o], az = P[o + 2], bx = P[o + 3], bz = P[o + 5], cx = P[o + 6], cz = P[o + 8];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
    out.push(w1 * P[o + 1] + w2 * P[o + 4] + w3 * P[o + 7]);
  }
  return out;
}

/** Floor under a landing: the highest surface at most `up` above and `down` below the reference height. */
function floorUnder(P, x, y, z, { up = 0.8, down = 2.5 } = {}) {
  const hs = heightsAt(P, x, z).filter((h) => h <= y + up && h >= y - down);
  return hs.length ? Math.max(...hs) : null;
}

/** Closest horizontal distance from (x, z) to triangles that overlap the body slab [y0, y1]. */
function clearance(P, x, y0, y1, z, limit = 1) {
  let best = limit;
  const segDist = (ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    const L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
    return Math.hypot(ax + dx * t - x, az + dz * t - z);
  };
  for (let o = 0; o < P.length; o += 9) {
    const ys = [P[o + 1], P[o + 4], P[o + 7]];
    if (Math.max(...ys) < y0 || Math.min(...ys) > y1) continue;
    const xs = [P[o], P[o + 3], P[o + 6]], zs = [P[o + 2], P[o + 5], P[o + 8]];
    if (Math.min(...xs) > x + limit || Math.max(...xs) < x - limit || Math.min(...zs) > z + limit || Math.max(...zs) < z - limit) continue;
    // Is the point inside the triangle's XZ projection (a wall seen edge-on is not)?
    const d = (zs[1] - zs[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (zs[0] - zs[2]);
    if (Math.abs(d) > 1e-6) {
      const w1 = ((zs[1] - zs[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (z - zs[2])) / d;
      const w2 = ((zs[2] - zs[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (z - zs[2])) / d;
      if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) {
        // A sloped face over the slab: only blocking if its height at this point is inside the slab.
        const h = w1 * ys[0] + w2 * ys[1] + (1 - w1 - w2) * ys[2];
        if (h >= y0 && h <= y1) return 0;
        continue;
      }
    }
    best = Math.min(best, segDist(xs[0], zs[0], xs[1], zs[1]), segDist(xs[1], zs[1], xs[2], zs[2]), segDist(xs[2], zs[2], xs[0], zs[0]));
  }
  return best;
}

function checkMeshContract(scene, label) {
  const P = scene.positions;
  assert.ok(P instanceof Float32Array && P.length > 0 && P.length % 9 === 0, `${label}: positions`);
  assert.equal(scene.uv.length, (P.length / 3) * 2, `${label}: uv per vertex`);
  assert.equal(scene.colors.length, P.length, `${label}: colors`);
  assert.equal(scene.uvConvention, 'atlas-v-down');
  assert.equal(scene.frontFace, 'ccw');
  assert.equal(scene.atlas.pixels.length, scene.atlas.width * scene.atlas.height * 4);
  for (let i = 0; i < scene.uv.length; i++) assert.ok(scene.uv[i] >= 0 && scene.uv[i] <= 1, `${label}: uv in atlas`);
  for (const v of P) assert.ok(Number.isFinite(v), `${label}: finite`);
}

describe('Gothway Garden building interiors (local ARENA2)', { skip }, () => {
  test('doors, service counters and interior scenes use the name for the actual building record', async () => {
    const specs = portalSpecs(gothwayPortals);
    const prompts = townDoors(gothwayPortals);
    const counters = countersFromPortals(gothwayPortals);
    for (const [id, name] of [
      ['b:2,1:15', 'The Superior General Store'],
      ['b:3,0:16', "Doctor Mordistyr's Gear"],
    ]) {
      const spec = specs.find(p => p.id === id);
      assert.equal(spec.label, name);
      assert.equal(spec.meta.buildingName, name);
      assert.deepEqual(prompts.filter(d => d.portalId === id).map(d => d.label), spec.entrances.map(() => name));
      assert.equal(counters.find(c => c.id === id).name, name);
      assert.equal((await loadInterior(data, spec.to)).name, name + ', Gothway Garden');
    }
    assert.equal(counters.find(c => c.buildingType === 3).name, 'The Bank of Daggerfall');
  });

  test('every door of every enterable building lands on a floor inside, clear of walls', async (t) => {
    const specs = portalSpecs(gothwayPortals);
    const buildings = gothwayPortals.buildings.filter((b) => b.exits.length);
    assert.ok(buildings.length >= 100, `found ${buildings.length} enterable buildings`);
    assert.equal(specs.length, buildings.length);
    let doors = 0, triangles = 0;
    const types = new Map();
    for (const b of buildings) {
      const scene = await loadInterior(data, b.target);
      checkMeshContract(scene, b.target);
      triangles += scene.stats.triangles;
      types.set(scene.source.buildingType, (types.get(scene.source.buildingType) ?? 0) + 1);
      for (const d of b.doors) {
        doors++;
        const floor = floorUnder(scene.positions, d.enter.x, d.enter.y, d.enter.z);
        assert.notEqual(floor, null, `${b.target}: no floor under the landing`);
        assert.ok(d.enter.y - floor < 2.5, `${b.target}: landing ${d.enter.y - floor} m above floor`);
        const clear = clearance(scene.positions, d.enter.x, floor + 0.4, floor + 1.7, d.enter.z, 0.5);
        assert.ok(clear >= 0.2, `${b.target}: landing ${clear} m from a wall`);
        // The way out is an exit door within the server's reach of where the player arrives.
        const exit = Math.min(...b.exits.map((e) => Math.hypot(e.x - d.enter.x, e.z - d.enter.z)));
        assert.ok(exit <= 2.4, `${b.target}: nearest exit ${exit} m away`);
      }
    }
    t.diagnostic(`${buildings.length} interiors, ${doors} doors, ${triangles} triangles, building types ${JSON.stringify(Object.fromEntries(types))}`);
  });

  test('leaving puts the player outside the door, on the street, clear of the building', () => {
    let checked = 0;
    for (const b of gothwayPortals.buildings) {
      for (const d of b.doors) {
        const g = floorUnder(gothway.positions, d.exit.x, 0.5, d.exit.z, { up: 1.2, down: 1.5 });
        assert.notEqual(g, null, `${b.portalId}: no ground outside`);
        const clear = clearance(gothway.positions, d.exit.x, g + 0.4, g + 1.7, d.exit.z, 0.5);
        assert.ok(clear >= 0.25, `${b.portalId}: exit ${clear} m from geometry`);
        // Facing away from the door: one step forward moves further from it.
        const fx = d.exit.x + Math.sin(d.exit.yaw), fz = d.exit.z - Math.cos(d.exit.yaw);
        assert.ok(Math.hypot(fx - d.x, fz - d.z) > Math.hypot(d.exit.x - d.x, d.exit.z - d.z));
        checked++;
      }
    }
    assert.ok(checked >= 100);
  });
});

test('the live quest walker can pass the narrow counter in the Daggerfall market block', { skip }, async () => {
  const room = await loadInterior(data, 'interior:Daggerfall/Daggerfall/4,4/4');
  assert.equal(room.source.block, 'MARKAA00.RMB');
  const collision = worldFromTown(room);
  const entrance = { x: 5.5, y: 1.125, z: 0.625 };
  const marker = { x: -1.2, y: 0, z: -6.8 }; // this room's authored 199/18 item marker
  const path = walkingRoute(collision, entrance, marker, 3.2, true);
  assert.ok(path?.length, 'a walkable approach to the marker');
  let at = entrance;
  for (const p of path) {
    at = collision.move(at.x, at.z, p.x, p.z, { y: at.y });
    assert.ok(Math.hypot(at.x - p.x, at.z - p.z) < 0.001);
    assert.equal(at.y, p.y);
  }
  assert.ok(Math.hypot(at.x - marker.x, at.z - marker.z) <= 3.2);
  assert.equal(at.y, marker.y);
});

describe("Privateer's Hold dungeon (local ARENA2, MAPS + RDB)", { skip }, () => {
  test('MAPDITEM lists the five RDB blocks with one starting block', async () => {
    const d = await readDungeon(data.maps, 17, "Privateer's Hold");
    assert.equal(d.blocks.length, 5);
    assert.equal(d.blocks.filter((b) => b.isStartingBlock).length, 1);
    for (const b of d.blocks) assert.match(b.blockName, /^[NWLSBM]\d{7}\.RDB$/);
  });

  test('the exterior entrance leads to the start marker, next to a real exit door', async () => {
    const p = holdPortals.dungeon;
    assert.ok(p, 'dungeon entrance found among the block models');
    assert.equal(p.doors.length >= 1, true);
    const scene = await loadDungeon(data, p.target);
    checkMeshContract(scene, p.target);
    assert.equal(scene.source.blocks.length, 5);
    assert.ok(scene.stats.triangles > 20000);
    assert.deepEqual(scene.spawn, p.doors[0].enter);
    const floor = floorUnder(scene.positions, scene.spawn.x, scene.spawn.y, scene.spawn.z);
    assert.notEqual(floor, null, 'floor under the start');
    assert.ok(scene.spawn.y - floor < 2, `start ${scene.spawn.y - floor} m above the floor`);
    const exits = scene.doors.filter((d) => d.type === DOOR_TYPE.DUNGEON_EXIT);
    assert.ok(exits.length >= 1);
    const near = Math.min(...exits.map((e) => Math.hypot(e.x - scene.spawn.x, e.z - scene.spawn.z)));
    assert.ok(near <= 3, `exit ${near} m from the start`);
    assert.ok(scene.actionDoors.length > 0, 'action doors placed (open)');
    // Enemy markers for combat: HumanStronghold table, fixed mobiles in 0-42 / 128-145, all on a floor.
    assert.equal(p.dungeonType, 2);
    assert.ok(p.encounters.length >= 30, `${p.encounters.length} enemy sites`);
    assert.equal(new Set(p.encounters.map((e) => e.key)).size, p.encounters.length);
    for (const e of p.encounters) {
      if (e.monsters) assert.ok(e.monsters.every((m) => (m >= 0 && m <= 42) || (m >= 128 && m <= 145)), JSON.stringify(e));
      else assert.equal(e.table, 2);
      assert.notEqual(floorUnder(scene.positions, e.x, e.y, e.z, { up: 0.5, down: 3 }), null, `floor under ${e.key}`);
    }
    // Leaving lands on the ground outside the entrance.
    const ex = p.doors[0].exit;
    const g = floorUnder(hold.positions, ex.x, 0.5, ex.z, { up: 1.5, down: 1.5 });
    assert.notEqual(g, null);
  });
});

describe('server feature on real operator data', { skip }, () => {
  test('enter a Gothway Garden building, meet another player inside, leave by the same door; enter and leave the Hold', async () => {
    const map = new Map();
    const sent = [];
    let services;
    let clock = 0;
    const runtime = createRpgRuntime({
      players: map,
      features: [{ name: 'interiors', install: (ctx) => { installInteriors(ctx); services = ctx.services; } }],
      save: () => {},
      send: (p, m) => sent.push([p.id, m]),
      dataPath: ARENA2,
      now: () => clock,
      log: { info() {}, warn() {}, error() {} },
    });
    const results = await services.interiors.ready;
    assert.ok(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)));
    const b = gothwayPortals.buildings.find((x) => x.buildingType === 15 && x.exits.length) ?? gothwayPortals.buildings.find((x) => x.exits.length);
    const door = b.doors[0];
    const join = (id, rpg, pos) => {
      const p = { id, name: `P${id}`, yaw: 0, moving: false, rpg, ...pos };
      map.set(id, p);
      runtime.join(p);
      return p;
    };
    const a = join(1, { location: TOWN }, { x: door.exit.x, z: door.exit.z });
    const c = join(2, { location: TOWN }, { x: door.x + 0.5, z: door.z + 0.5 });
    assert.deepEqual(runtime.act(a, 'portal.use', { portalId: b.portalId }), { ok: true });
    assert.deepEqual(runtime.act(c, 'portal.use', { portalId: b.portalId }), { ok: true });
    assert.equal(a.rpg.location, b.target);
    assert.deepEqual([a.x, a.z], [door.enter.x, door.enter.z]);
    assert.deepEqual(runtime.rpgMessage(a).peers.map((q) => q.id), [2]);
    clock += 2000;
    assert.deepEqual(runtime.act(a, 'portal.leave', {}), { ok: true });
    assert.equal(a.rpg.location, TOWN);
    assert.deepEqual([a.x, a.z, a.yaw], [door.exit.x, door.exit.z, door.exit.yaw]);

    // Travel is another feature; place the player at the Hold as travel would.
    const h = holdPortals.dungeon.doors[0];
    const d = join(3, { location: HOLD }, { x: h.exit.x, z: h.exit.z });
    assert.deepEqual(runtime.act(d, 'portal.use', { portalId: 'dungeon' }), { ok: true });
    assert.equal(d.rpg.location, holdPortals.dungeon.target);
    assert.deepEqual([d.x, d.z], [h.enter.x, h.enter.z]);
    clock += 2000;
    assert.deepEqual(runtime.act(d, 'portal.leave', {}), { ok: true }, 'the start marker is within reach of the exit');
    assert.equal(d.rpg.location, HOLD);

    // A scene for server-side collision of an occupied instance.
    const scene = await services.interiors.scene(b.target);
    assert.equal(scene.kind, 'interior');
    assert.ok(scene.positions.length > 0);
  });
});

describe('wider sweep (local ARENA2)', { skip }, () => {
  test('dungeon locations of region Daggerfall: entrance found, every block parses, start marker and exit exist', async (t) => {
    const names = await readRegionNames(data.maps, 17);
    const withDungeon = [];
    for (const n of names) if (await readDungeon(data.maps, 17, n)) withDungeon.push(n);
    const sample = process.env.INTERIORS_SWEEP ? withDungeon : withDungeon.filter((_, i) => i % 20 === 0);
    const failures = [];
    const noEntrance = [];
    let blocks = 0;
    for (const n of sample) {
      try {
        const town = await loadTown(files, { location: n });
        const portals = await locationPortals(data, { region: 'Daggerfall', location: n }, town.source.spawnLocal);
        if (!portals.dungeon) {
          // Classic data gap (e.g. "THe Crypts of Wickfield", GRVEAS10.RMB): the exterior carries no door plane at
          // all, so there is nothing real to link; it is reported, not invented.
          if (portals.buildings.length === 0) {
            noEntrance.push(n);
            continue;
          }
          throw new Error('no dungeon entrance door');
        }
        if (!portals.dungeon.exits.length) throw new Error('no exit door');
        blocks += portals.dungeon.blocks;
      } catch (err) {
        failures.push(`${n}: ${err.message}`);
      }
    }
    t.diagnostic(`${sample.length}/${withDungeon.length} dungeon locations checked, ${blocks} RDB blocks, ${failures.length} failures, no entrance in data: ${JSON.stringify(noEntrance)}`);
    assert.ok(noEntrance.length <= Math.max(1, sample.length * 0.01));
    for (const f of failures) t.diagnostic(f);
    assert.deepEqual(failures, []);
  });

  test('cities and towns: every enterable interior lays out with an exit near each landing', async (t) => {
    const towns = [
      ['Daggerfall', 'Daggerfall'], ['Daggerfall', 'Gothway Garden'], ['Daggerfall', 'Ripwych'], ['Daggerfall', 'Charing'],
      ['Daggerfall', 'Singmoth'], ['Wayrest', 'Wayrest'], ['Sentinel', 'Sentinel'],
    ];
    let interiors = 0;
    const failures = [];
    for (const [region, n] of towns) {
      const town = await loadTown(files, { region, location: n });
      const portals = await locationPortals(data, { region, location: n }, town.source.spawnLocal);
      for (const b of portals.buildings) {
        if (!b.exits.length) continue;
        interiors++;
        for (const d of b.doors) {
          const exit = Math.min(...b.exits.map((e) => Math.hypot(e.x - d.enter.x, e.z - d.enter.z)));
          if (!(exit <= 3)) failures.push(`${b.target}: exit ${exit.toFixed(2)} m from landing`);
        }
      }
    }
    t.diagnostic(`${interiors} interiors across ${towns.length} towns, ${failures.length} landings beyond reach of an exit`);
    for (const f of failures.slice(0, 20)) t.diagnostic(f);
    assert.ok(failures.length <= interiors * 0.02, 'nearly every landing has an exit within reach');
  });
});
