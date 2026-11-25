// Shared locomotion rule (client/lib/locomotion.js) against real CollisionWorld geometry, the server
// consequences feature (server/rpg/locomotion.js) and the authoritative step in server/rpg/collision.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollisionWorld, worldFromTown } from '../client/gameplay/collision/world.js';
import { canResumeSwim, LOCO, maxBreath, newBody, stepBody, normalizeMods, publicBody, speedOf } from '../client/lib/locomotion.js';
import { movementMods, movementView, syncSwimBreath } from '../client/gameplay/movement.js';
import { loadDungeon, loadInterior, openWorldData } from '../client/world/interiors/index.js';
import { createCollision } from '../server/rpg/collision.js';
import { arena2Files } from '../server/rpg/collision/arena2.js';
import { install as installLocomotion } from '../server/rpg/locomotion.js';
import { install as installGuilds } from '../server/rpg/guilds.js';
import { localArena2 } from './support/rpg-session.mjs';

/** Geometry builder: walls, boxes with roofs, floors and an optional ground plane with water volumes. */
function build({ walls = [], boxes = [], floors = [], ground = true, half = 30, water = [] } = {}) {
  const tris = [];
  const quad = (a, b, c, d) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  const wall = ([ax, az], [bx, bz], y0 = 0, y1 = 3) => quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]);
  for (const w of walls) wall(w.a, w.b, w.y0, w.y1);
  for (const { x0, z0, x1, z1, y0 = 0, y1 = 3, roof = true } of boxes) {
    wall([x0, z0], [x1, z0], y0, y1);
    wall([x1, z0], [x1, z1], y0, y1);
    wall([x1, z1], [x0, z1], y0, y1);
    wall([x0, z1], [x0, z0], y0, y1);
    if (roof) quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  }
  for (const { x0, z0, x1, z1, y } of floors) quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
  const groundFirstTriangle = tris.length / 9;
  if (ground) quad([-half, 0, -half], [-half, 0, half], [half, 0, half], [half, 0, -half]);
  return new CollisionWorld({
    positions: new Float32Array(tris), groundFirstTriangle, groundTriangleCount: ground ? 2 : 0,
    walkBounds: { minX: -half, maxX: half, minZ: -half, maxZ: half }, water,
  });
}

/** Run the rule for `seconds` at 25 Hz with a fixed input; returns all events. */
function run(world, body, input, seconds, mods = {}) {
  const events = [];
  const m = normalizeMods(mods);
  for (let t = 0; t < seconds; t += 0.04) events.push(...stepBody(world, body, { yaw: 0, ...input }, 0.04, m));
  return events;
}
const kinds = (evs) => evs.map((e) => e.kind);

test('[stage 1] a standing jump rises about a metre and lands without damage', () => {
  const w = build();
  const b = newBody(0, 0, 0);
  run(w, b, { jumpSeq: 0 }, 0.1); // adopt the counter: no jump on join
  assert.equal(b.mode, 'ground');
  let peak = 0;
  const evs = [];
  const m = normalizeMods({});
  evs.push(...stepBody(w, b, { yaw: 0, jumpSeq: 1 }, 0.04, m));
  for (let i = 0; i < 40; i++) { evs.push(...stepBody(w, b, { yaw: 0, jumpSeq: 1 }, 0.04, m)); peak = Math.max(peak, b.y); }
  assert.deepEqual(kinds(evs).filter((k) => k !== 'exert'), ['jump', 'land']);
  assert.ok(peak > 0.8 && peak < 1.1, `peak ${peak}`);
  assert.equal(b.mode, 'ground');
  assert.equal(evs.find((e) => e.kind === 'land').damage, 0);
  // Holding the same counter does not jump again.
  assert.ok(!kinds(run(w, b, { jumpSeq: 1 }, 1)).includes('jump'));
});

test('[stage 1] jumping clears a ledge too high to step onto', () => {
  // A 0.9 m platform ahead (-z); walking stops at its face, a running jump lands on top.
  const w = build({ boxes: [{ x0: -3, x1: 3, z0: -6, z1: -2, y1: 0.9 }] });
  const walk = newBody(0, 0, 0);
  run(w, walk, { forward: 1 }, 1.5);
  assert.ok(walk.z > -2, `walked into the face: ${walk.z}`);
  assert.equal(walk.y, 0);
  const b = newBody(0, -0.6, 0);
  run(w, b, { jumpSeq: 0 }, 0.04);
  run(w, b, { forward: 1, jumpSeq: 1 }, 1.2);
  assert.ok(b.z < -2.4, `on the platform: z ${b.z}`);
  assert.ok(Math.abs(b.y - 0.9) < 1e-3, `y ${b.y}`);
  assert.equal(b.mode, 'ground');
});

test('[stage 2] walking off a high ledge falls; damage beyond the safe height, none under Slowfall', () => {
  // A 10 m high platform with its edge at z = -2; the ground below is at 0.
  const w = build({ boxes: [{ x0: -5, x1: 5, z0: -2, z1: 6, y1: 10 }] });
  for (const [mods, expect] of [[{}, Math.round((10 - LOCO.safeFall) * LOCO.fallDamagePerMetre)], [{ slowfall: true }, 0]]) {
    const b = newBody(0, 2, 10);
    const evs = run(w, b, { forward: 1 }, 8, mods);
    const land = evs.find((e) => e.kind === 'land');
    assert.ok(land, 'landed');
    assert.ok(Math.abs(land.fall - 10) < 0.05, `fell ${land.fall}`);
    assert.equal(land.damage, expect);
    assert.equal(b.y, 0);
  }
});

test('[stage 3] climbing up and over a 4 m gate wall, landing on the far side', () => {
  // A closed gate: a thick 4 m wall across the path with no roof to stand on (a fence top).
  const w = build({ boxes: [{ x0: -10, x1: 10, z0: -3.2, z1: -3, y1: 4, roof: false }] });
  const low = newBody(0, 0, 0);
  const evLow = run(w, low, { forward: 1 }, 0.5, { climbing: 0 });
  assert.ok(!kinds(evLow).includes('climb'), 'no climb before the delay at skill 0');
  const b = newBody(0, 0, 0);
  const evs = run(w, b, { forward: 1 }, 9, { climbing: 60 });
  const k = kinds(evs);
  assert.ok(k.includes('climb'), 'started climbing');
  assert.ok(evs.some((e) => e.kind === 'climb' && e.top), 'reached the top');
  assert.ok(b.z < -3.2 - LOCO.height * 0 - 0.3, `over the gate: z ${b.z}`);
  assert.equal(b.y, 0);
  assert.equal(b.mode, 'ground');
  assert.ok(evs.some((e) => e.kind === 'exert' && e.skill === 'Climbing'));
  assert.equal(evs.find((e) => e.kind === 'land').damage, 0, 'a 4 m drop is under the safe height');
});

test('[stage 3] an exhausted character cannot climb, run or jump', () => {
  const w = build({ walls: [{ a: [-10, -3], b: [10, -3], y1: 4 }] });
  const b = newBody(0, 0, 0);
  const evs = run(w, b, { forward: 1, run: true, jumpSeq: 0 }, 4, { fatigue: 0, climbing: 100 });
  assert.ok(!kinds(evs).includes('climb'));
  assert.equal(b.running, false);
  run(w, b, { jumpSeq: 1 }, 0.5, { fatigue: 0 });
  assert.equal(b.mode, 'ground');
});

test('[stage 4] running is faster by the classic Running formula and drains fatigue; Alt-slow and crouch are slower', () => {
  const w = build();
  const m = normalizeMods({ running: 50 });
  const b = newBody(0, 0, 0);
  const evs = run(w, b, { forward: 1, run: true }, 1, { running: 50 });
  assert.ok(Math.abs(b.speed - LOCO.walk * (1.35 + 50 / 200)) < 1e-6, `speed ${b.speed}`);
  const fatigue = evs.filter((e) => e.kind === 'exert').reduce((n, e) => n + e.fatigue, 0);
  assert.ok(fatigue > 1.9 && fatigue < 2.2, `fatigue ${fatigue}`);
  assert.equal(publicBody(b).stance, 'run');
  const slow = newBody(0, 0, 0);
  run(w, slow, { forward: 1, slow: true }, 0.2);
  assert.ok(Math.abs(slow.speed - LOCO.walk * LOCO.slowScale) < 1e-9);
  assert.equal(publicBody(slow).stance, 'slow');
  const c = newBody(0, 0, 0);
  run(w, c, { forward: 1, crouch: true }, 0.2);
  assert.ok(Math.abs(c.speed - LOCO.walk * LOCO.crouchScale) < 1e-9);
  assert.equal(speedOf({ mode: 'swim' }, m), LOCO.walk / 4);
});

test('[stage 4] crouching passes under a low beam; standing up waits for head room', () => {
  // A 1.2 m opening under a beam across the path at z -2..-4.
  // The beam has an underside, as real model geometry does.
  const w = build({ boxes: [{ x0: -10, x1: 10, z0: -4, z1: -2, y0: 1.2, y1: 3 }], floors: [{ x0: -10, x1: 10, z0: -4, z1: -2, y: 1.2 }] });
  const stand = newBody(0, 0, 0);
  run(w, stand, { forward: 1 }, 1);
  assert.ok(stand.z > -2, `standing body stopped: ${stand.z}`);
  const c = newBody(0, 0, 0);
  run(w, c, { forward: 1, crouch: true }, 1.4);
  assert.ok(c.z < -2.5 && c.z > -4, `crouched under the beam: ${c.z}`);
  run(w, c, { crouch: false }, 0.2);
  assert.equal(c.crouch, true, 'cannot stand under the beam');
  run(w, c, { forward: 1, crouch: true }, 2);
  run(w, c, { crouch: false }, 0.1);
  assert.equal(c.crouch, false, 'stands once clear');
});

test('private swim snapshots correct a slow browser’s breath and preserve submersion with Water Breathing', () => {
  const loc = 'dungeon:Daggerfall/Castle Necromoghan';
  const body = newBody(0, 0, 0);
  const mods = normalizeMods({ endurance: 70 });
  const pool = { waterAt: () => 5 };
  body.breath = 18;
  const saved = { to: loc, swimming: true, breath: 8 };
  syncSwimBreath(body, saved, 'town:Daggerfall/Daggerfall');
  assert.equal(body.breath, 18);
  syncSwimBreath(body, saved, loc);
  assert.equal(body.breath, 8);
  assert.equal(movementView(body, pool, mods).lowBreath, true);
  syncSwimBreath(body, { ...saved, breath: 0 }, loc);
  assert.equal(movementView(body, pool, mods).breath, 0);
  const magic = movementView(body, pool, { ...mods, waterBreath: true });
  assert.equal(magic.underwater, true);
  assert.equal(magic.waterBreathing, true);
});

test('[stage 5] swimming, diving, breath, drowning and climbing out at the edge', () => {
  // A flooded pit: floor 4 m down between z -2 and -12, water surface at 0. Ground elsewhere at 0.
  const w = build({
    ground: false,
    floors: [{ x0: -10, x1: 10, z0: 10, z1: -2, y: 0 }, { x0: -10, x1: 10, z0: -12, z1: -2, y: -4 }, { x0: -10, x1: 10, z0: -30, z1: -12, y: 0.3 }],
    walls: [{ a: [-10, -2], b: [10, -2], y0: -4, y1: 0 }, { a: [-10, -12], b: [10, -12], y0: -4, y1: 0.3 }],
    water: [{ minX: -10, maxX: 10, minZ: -12, maxZ: -2, y: 0 }],
  });
  const b = newBody(0, 0, 0);
  const evs = run(w, b, { forward: 1 }, 1.2, { swimming: 40, endurance: 40 });
  assert.ok(kinds(evs).includes('swim'), 'entered the water');
  assert.equal(b.mode, 'swim');
  assert.ok(b.y < 0 && b.y > -2.5, `floating y ${b.y}`);
  // Dive to the bottom and stay under: breath runs out, then drowning damage each second.
  const under = run(w, b, { rise: -1 }, 4, { swimming: 40, endurance: 40 });
  assert.ok(Math.abs(b.y + 4) < 0.05, `at the bottom: ${b.y}`);
  assert.ok(kinds(under).includes('submerge'));
  const full = LOCO.breathBase + 10;
  const drown = run(w, b, {}, 0, {});
  assert.equal(drown.length, 0);
  const hold = [];
  const m = normalizeMods({ endurance: 40 });
  for (let i = 0; i < (full + 2.5) / 0.04; i++) hold.push(...stepBody(w, b, { yaw: 0, rise: -1 }, 0.04, m));
  assert.ok(hold.filter((e) => e.kind === 'drown').length >= 1, 'drowning after breath runs out');
  // Water Breathing: no drowning.
  const wb = Object.assign(newBody(0, -5, -4), { mode: 'swim' });
  const protectedDive = run(w, wb, { rise: -1 }, full + 3, { waterBreath: true });
  assert.equal(protectedDive.filter((e) => e.kind === 'drown').length, 0);
  assert.equal(protectedDive.filter((e) => e.kind === 'submerge').length, 1);
  const protectedRise = run(w, wb, { rise: 1 }, 4, { waterBreath: true });
  assert.equal(protectedRise.filter((e) => e.kind === 'surface').length, 1);
  // Surface and swim to the far edge (a ledge 0.3 m above the surface): climb out onto it.
  const out = run(w, b, { forward: 1 }, 8, { swimming: 40 });
  assert.ok(kinds(out).includes('surface'));
  assert.equal(b.mode, 'ground', `mode ${b.mode} at z ${b.z} y ${b.y}`);
  assert.ok(b.z < -12 && Math.abs(b.y - 0.3) < 1e-3, `out on the ledge: z ${b.z} y ${b.y}`);
});

test('[stage 5] Water Walking keeps the body on the surface', () => {
  const w = build({ ground: false, floors: [{ x0: -10, x1: 10, z0: -10, z1: 10, y: -4 }], water: [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10, y: 0 }] });
  const b = newBody(0, 0, 0);
  b.mode = 'air'; b.peak = 0;
  run(w, b, { forward: 1 }, 1, { waterWalk: true });
  assert.equal(b.mode, 'ground');
  assert.ok(Math.abs(b.y) < 1e-6, `on the surface ${b.y}`);
});

test('[stage 5] a heavy pack sinks through Rise, Water Breathing, and ordinary buoyancy', () => {
  const w = build({ ground: false, floors: [{ x0: -10, x1: 10, z0: -10, z1: 10, y: -4 }], water: [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10, y: 0 }] });
  const b = Object.assign(newBody(0, 0, -LOCO.floatDepth), { mode: 'swim' });
  const heavy = { sinks: true, swimming: 40 };
  run(w, b, { rise: 1, forward: 1 }, 3, heavy);
  assert.equal(b.y, -4);
  assert.ok(b.z < -1 && b.underwater && b.breath < maxBreath(normalizeMods(heavy)));
  const protectedBreath = b.breath;
  run(w, b, { rise: 1 }, 3, { ...heavy, waterBreath: true });
  assert.equal(b.y, -4);
  assert.equal(b.breath, protectedBreath);
  run(w, b, { rise: 1 }, 1, { ...heavy, levitate: true });
  assert.equal(b.mode, 'levitate');
  assert.ok(Math.abs(b.y) < 1e-6);
  run(w, b, { rise: 1 }, 4, heavy);
  assert.equal(b.y, -4);
  run(w, b, { rise: 1 }, 0.5, { ...heavy, waterWalk: true });
  assert.ok(b.y > -4 && b.underwater && b.breath < protectedBreath);
  run(w, b, { rise: 1 }, 1, { ...heavy, waterWalk: true });
  assert.equal(b.y, 0);
  assert.equal(b.mode, 'ground');
  run(w, b, { forward: 1 }, 0.5, { ...heavy, waterWalk: true });
  assert.equal(b.y, 0);
  run(w, b, {}, 4, heavy);
  assert.equal(b.y, -4, 'expiry removes support even while standing still');
  run(w, b, { rise: 1 }, 3, { ...heavy, sinks: false });
  assert.equal(b.y, -LOCO.floatDepth);
  assert.equal(b.underwater, false);
});

test('the private snapshot gives prediction the same live skills and pack status as authority', () => {
  const ctx = { onLeave() {}, services: {
    skillValue: (_p, name) => ({ Running: 45, Jumping: 32, Climbing: 60, Swimming: 85 })[name],
    encumbrance: () => ({ carried: 62.51, max: 100, sinks: true }),
  } };
  installLocomotion(ctx);
  const character = { skills: { Running: 30, Jumping: 30, Climbing: 30, Swimming: 30 } };
  const server = ctx.services.locomotionMods({ rpg: { character } });
  const prediction = movementMods({ character: { character }, locomotion: JSON.parse(JSON.stringify(server)) });
  assert.deepEqual(prediction, normalizeMods(server));
  assert.deepEqual([prediction.running, prediction.jumping, prediction.climbing, prediction.swimming, prediction.sinks], [45, 32, 60, 85, true]);
});

test('[stage 5] swimmers cannot rise through a ceiling', () => {
  const floors = [-4, -1].map((y) => ({ x0: -10, z0: -10, x1: 10, z1: 10, y }));
  const w = build({ ground: false, floors, water: [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10, y: 0 }] });
  const b = Object.assign(newBody(0, 0, -4), { mode: 'swim' });
  run(w, b, { rise: 1 }, 4, { swimming: 60 });
  assert.ok(b.y > -4 && b.y + LOCO.height <= -1 + 0.05);
});

const arena2 = localArena2();
test('[asset] the Daggerfall general store partition is solid at the floor seam and open at the doorway', { skip: !arena2 && 'local ARENA2 unavailable' }, async () => {
  const data = await openWorldData(await arena2Files(arena2));
  const w = worldFromTown(await loadInterior(data, 'interior:Daggerfall/Daggerfall/5,1/11'));
  assert.equal(w.heightAt(-1, 0, 0), null);
  assert.equal(w.heightAt(-1, 0.16, 0), 0);
  assert.equal(w.heightAt(-1, -0.16, 0), 0);
  assert.equal(w.segmentClear(-1, 1.6, 0.6, -1, 1.6, -0.6), false, 'the partition intersects the capsule at chest height');
  assert.equal(w.move(-1, 0.6, -1, -0.6, { y: 0 }).blocked, true);
  assert.equal(w.segmentClear(-3.25, 1.6, 0.6, -3.25, 1.6, -0.6), true);
  const doorway = w.move(-3.25, 0.6, -3.25, -0.6, { y: 0 });
  assert.equal(doorway.blocked, false);
  assert.equal(doorway.y, 0);
  assert.ok(doorway.z < -0.59);
});

test('[asset] The Troglobith Web has two pools linked beneath an authored stone crossing', { skip: !arena2 && 'local ARENA2 unavailable' }, async () => {
  const data = await openWorldData(await arena2Files(arena2));
  const w = worldFromTown(await loadDungeon(data, "dungeon:Alik'r Desert/The Troglobith Web"));
  const b = newBody(6.8, -39.6, 5.35);
  const mods = { swimming: 60, endurance: 70 };
  assert.equal(w.move(b.x, b.z, b.x, -43.6, { y: b.y, fly: true }).blocked, true);
  run(w, b, { rise: -1 }, 0.7, mods);
  assert.equal(b.underwater, true);
  run(w, b, { forward: 1 }, 1.84, mods);
  assert.ok(b.z < -43.5 && b.underwater);
  run(w, b, { rise: 1 }, 1, mods);
  assert.equal(b.underwater, false);
  assert.equal(b.mode, 'swim');
});

test('[asset] the Scourg Barrow coffin rim blocks a ground sweep but can be climbed with its lid open', { skip: !arena2 && 'local ARENA2 unavailable' }, async () => {
  const data = await openWorldData(await arena2Files(arena2));
  const scene = await loadDungeon(data, 'dungeon:Dragontail Mountains/Scourg Barrow');
  let lidOpen = true;
  const w = worldFromTown(scene, { mechanismActive: id => id === '0,0:12113' && lidOpen });
  const x = 23.269, y = 44.8, z = -27.492323;
  for (const distance of [0.08, 0.2, 0.4, 0.8, 1.5]) {
    const move = w.move(x, z, x, z - distance, { y });
    assert.ok(move.blocked, `a ${distance} m sweep meets the same rim`);
    assert.ok(Math.abs(move.y - y) < 0.001 && Math.abs(move.z - z) < 0.001);
  }
  for (const open of [false, true]) {
    lidOpen = open;
    const body = newBody(21.43, -26.85, y);
    const events = run(w, body, { forward: 1, slow: true }, 3.6, { climbing: 20 });
    assert.equal(events.some(e => e.kind === 'climb' && e.top), open);
    const falls = events.filter(e => e.kind === 'land' && e.damage > 0);
    assert.equal(falls.length, Number(open));
    assert.ok(open ? Math.abs(body.y - 38.4) < 0.001 : body.y >= y - 0.001);
    assert.equal(body.mode, 'ground');
  }
});

test('[asset] Castle Necromoghan swimmers rise off the sloped pool bottom and can resume above it', { skip: !arena2 && 'local ARENA2 unavailable' }, async () => {
  const data = await openWorldData(await arena2Files(arena2));
  const w = worldFromTown(await loadDungeon(data, 'dungeon:Daggerfall/Castle Necromoghan'));
  const x = 31.65, z = -35.2, bottom = 6.49;
  assert.equal(w.fits(x, z, bottom), false, 'the normal body rim touches the slope here');
  assert.equal(canResumeSwim(w, x, z, { footY: bottom, swimming: true }), true);
  assert.equal(canResumeSwim(w, x, z, { footY: bottom }), false, 'legacy saves on the floor retain floor recovery');
  assert.equal(canResumeSwim(w, x, z, { footY: 15 }), false, 'a dry saved foot height remains subject to floor recovery');
  for (const rise of [0, 1]) {
    const swimmer = Object.assign(newBody(x, z, bottom), { mode: 'swim' });
    run(w, swimmer, { rise }, 5, { swimming: 40 });
    assert.equal(swimmer.mode, 'swim');
    assert.equal(swimmer.underwater, false);
    assert.ok(swimmer.y - bottom > 2, `swimmer reached ${swimmer.y}`);
    assert.equal(canResumeSwim(w, x, z, { footY: swimmer.y }), true, 'legacy floating saves are restored in place');
  }
  const levitating = Object.assign(newBody(x, z, bottom), { mode: 'swim' });
  run(w, levitating, { rise: 1 }, 1, { sinks: true, levitate: true });
  assert.equal(levitating.mode, 'levitate');
  assert.ok(levitating.y - bottom > 2 && !levitating.underwater);
});

test('[stage 6] Levitate rises to a ceiling, and ending it falls', () => {
  const w = build({ floors: [{ x0: -5, x1: 5, z0: -5, z1: 5, y: 6 }] });
  const b = newBody(0, 0, 0);
  run(w, b, { rise: 1 }, 3, { levitate: true });
  assert.equal(b.mode, 'levitate');
  assert.ok(b.y > 3.5 && b.y + LOCO.height <= 6.01, `under the ceiling: ${b.y}`);
  const evs = run(w, b, {}, 2, {});
  const land = evs.find((e) => e.kind === 'land');
  assert.ok(land && land.fall > 3.5);
  assert.equal(b.mode, 'ground');
});

test('[stage 7] paralysis stops voluntary movement in the air, in water and on a wall; gravity and buoyancy still act', () => {
  const open = build();
  const air = Object.assign(newBody(0, 0, 2), { mode: 'air', peak: 2 });
  const evAir = stepBody(open, air, { yaw: 0, forward: 1 }, 0.1, normalizeMods({ paralyzed: true }));
  assert.equal(air.z, 0, 'no air control');
  assert.equal(air.moving, false);
  assert.equal(air.speed, 0);
  assert.ok(air.y < 2, 'still falls');
  run(open, air, { forward: 1 }, 1, { paralyzed: true });
  assert.equal(air.mode, 'ground');
  assert.equal(air.z, 0);
  assert.ok(!kinds(evAir).includes('jump'));
  const w = build({ ground: false, floors: [{ x0: -10, x1: 10, z0: -10, z1: 10, y: -4 }], water: [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10, y: 0 }] });
  const swim = Object.assign(newBody(0, 0, -3), { mode: 'swim' });
  run(w, swim, { forward: 1, rise: -1 }, 1, { paralyzed: true });
  assert.equal(swim.z, 0, 'no swimming strokes');
  assert.ok(swim.y > -3, `floats up: ${swim.y}`);
  assert.equal(swim.speed, 0);
  const g = build({ walls: [{ a: [-10, -3], b: [10, -3], y1: 6 }] });
  const climber = newBody(0, -2.6, 0);
  run(g, climber, { forward: 1 }, 2, { climbing: 100 });
  assert.equal(climber.mode, 'climb');
  const evC = run(g, climber, { forward: 1 }, 2, { paralyzed: true, climbing: 100 });
  assert.ok(evC.some((e) => e.kind === 'climb' && e.stop), 'lets go of the wall');
  assert.equal(climber.mode, 'ground');
  assert.equal(climber.y, 0);
});

test('[stage 7] paralysis holds a walking body; mounted riders cannot crouch, jump or climb', () => {
  const w = build({ walls: [{ a: [-10, -3], b: [10, -3], y1: 4 }] });
  const p = newBody(0, 0, 0);
  run(w, p, { forward: 1 }, 1, { paralyzed: true });
  assert.equal(p.z, 0);
  const r = newBody(0, 0, 0);
  const evs = run(w, r, { forward: 1, crouch: true, jumpSeq: 0 }, 3, { mounted: true, baseSpeed: 8, climbing: 100 });
  run(w, r, { jumpSeq: 1 }, 0.2, { mounted: true, baseSpeed: 8 });
  assert.equal(r.crouch, false);
  assert.equal(r.mode, 'ground');
  assert.ok(!kinds(evs).includes('climb'));
});

// ---------------------------------------------------------------- server

function fakeCtx(world, loc = 'dungeon:Test/Flooded') {
  const ticks = [], notes = [];
  const ctx = {
    players: new Map(), services: {}, config: { worldHalfExtent: 100 }, dataPath: null, defaultLocation: loc,
    log: { warn() {}, error() {} },
    location: (p) => p.rpg?.location ?? loc,
    notify: (p, ev) => notes.push([p.id, ev]),
    onJoin() {}, onLeave() {}, onTick: (f) => ticks.push(f),
    emit() {},
  };
  return { ctx, notes, loc };
}

test('[stage 8] the server step applies modifiers from other owners and turns events into consequences', async () => {
  const w = build({ boxes: [{ x0: -5, x1: 5, z0: -2, z1: 6, y1: 10 }] });
  const { ctx, notes, loc } = fakeCtx(w);
  const { service, stepPlayer } = createCollision(ctx, { fixtures: { [loc]: w }, preloadDefault: false });
  await service.whenSettled(loc);
  const ch = { fatigue: 50, health: 60, skills: { Running: 40, Jumping: 10, Climbing: 5, Swimming: 5 } };
  const spent = [], damage = [], practised = [];
  Object.assign(ctx.services, {
    characterOf: (p) => p.rpg.character,
    skillValue: (p, n) => p.rpg.character.skills[n],
    effectiveAttribute: (p, k) => (k === 'Endurance' ? 60 : 50),
    magicStatus: () => ({}),
    characterTraversal: () => ({ exertionMultiplier: 2, jumpMultiplier: 1, climbingBonus: 0, swimmingBonus: 0 }),
    spendFatigue: (p, n) => { spent.push(n); p.rpg.character.fatigue -= n; return true; },
    damagePlayer: (p, n, src) => { damage.push([n, src.kind]); return { dead: false }; },
    advanceSkill: (p, s) => practised.push(s),
  });
  installLocomotion(ctx);
  const p = { id: 1, x: 0, z: 2, yaw: 0, rpg: { location: loc, character: ch, portal: { to: loc, footY: 10 } } };
  ctx.players.set(1, p);
  // Run across the platform and off its edge.
  const step = (input) => { const m = stepPlayer(p, { strafe: 0, yaw: 0, forward: 0, ...input }, 0.04); p.x = m.x; p.z = m.z; };
  for (let i = 0; i < 100; i++) step({ forward: 1, run: true });
  assert.ok(p.z < -2, 'left the platform');
  assert.equal(p.footY, 0);
  assert.ok(Number.isFinite(p.motionSpeed));
  assert.deepEqual(damage, [[25, 'fall']]);
  assert.ok(notes.some(([, ev]) => ev.kind === 'locomotion' && ev.event === 'fall'));
  assert.ok(spent.reduce((a, b) => a + b, 0) >= 4, `running fatigue with exertion x2: ${spent}`);
  // Jump: Jumping practice tallied once per jump, from the activity handler only.
  step({ jumpSeq: 0 });
  step({ jumpSeq: 1 });
  assert.equal(practised.filter((s) => s === 'Jumping').length, 1);
  step({ jumpSeq: 1 });
  const st = ctx.services.locomotion.stateOf(p);
  assert.equal(st.mode, 'air');
  assert.equal(ctx.services.isSwimming(p), false);
  const view = ctx.services.bodyView(p);
  assert.equal(view.stance, 'air');
  assert.ok(view.y > 0);
});

test('[stage 8] old saves without a foot height stand on the entry floor of a stacked dungeon', async () => {
  const loc = 'dungeon:Test/Stacked';
  const w = new CollisionWorld({
    positions: new Float32Array([
      -8, 4, -8, -8, 4, 8, 8, 4, 8, -8, 4, -8, 8, 4, 8, 8, 4, -8,
      -8, 8, -8, -8, 8, 8, 8, 8, 8, -8, 8, -8, 8, 8, 8, 8, 8, -8,
    ]),
    entryHeight: 8.2,
  });
  const { ctx } = fakeCtx(w, loc);
  const { service, stepPlayer } = createCollision(ctx, { fixtures: { [loc]: w }, preloadDefault: false });
  await service.whenSettled(loc);
  const legacy = { id: 2, x: 0, z: 0, yaw: 0, rpg: { location: loc, portal: { to: loc } } };
  stepPlayer(legacy, { forward: 1, strafe: 0, yaw: 0 }, 0.04);
  assert.equal(legacy.footY, 8);
  assert.equal(legacy.rpg.portal.footY, 8);
  const lower = { id: 3, x: 0, z: 0, yaw: 0, rpg: { location: loc, portal: { to: loc, footY: 4 } } };
  for (let i = 0; i < 5; i++) stepPlayer(lower, { forward: 0, strafe: 0, yaw: 0 }, 0.04);
  assert.equal(lower.footY, 4, 'a saved lower floor stays put (no fall through to a floor below, no snap up)');
});

test('[stage 8] a saved Water Walking pose resumes on the surface while the spell is active', async () => {
  const w = build({ ground: false, floors: [{ x0: -10, x1: 10, z0: -10, z1: 10, y: -4 }], water: [{ minX: -10, maxX: 10, minZ: -10, maxZ: 10, y: 0 }] });
  const { ctx, loc } = fakeCtx(w);
  const { service, stepPlayer } = createCollision(ctx, { fixtures: { [loc]: w }, preloadDefault: false });
  await service.whenSettled(loc);
  installLocomotion(ctx);
  ctx.services.magicStatus = (p) => ({ waterWalking: p.waterWalking });
  const player = { id: 1, x: 0, z: 0, waterWalking: true, rpg: { location: loc, portal: { to: loc, footY: 0 } } };
  assert.equal(stepPlayer(player, { forward: 1 }, 0.04).y, 0);
  assert.equal(service.bodyOf(player).mode, 'ground');
  assert.equal(player.rpg.portal.footY, 0);

  service.resetBody(player);
  player.waterWalking = false;
  assert.equal(service.footY(player), -4);
  stepPlayer(player, { forward: 1 }, 0.04);
  assert.equal(service.bodyOf(player).mode, 'swim');
});

test('a raised town doorway retains its authored return floor while walking and after rejoin', async () => {
  const location = 'town:Test/Stacked';
  const world = build({ floors: [{ x0: -8, z0: -8, x1: 8, z1: 8, y: 3.2 }] });
  const { ctx } = fakeCtx(world, location);
  const { service, stepPlayer } = createCollision(ctx, { fixtures: { [location]: world }, preloadDefault: false });
  await service.whenSettled(location);
  const player = { id: 1, x: 0, z: 0, yaw: 0, rpg: { location } };
  const input = { forward: 1, strafe: 0, yaw: 0 };
  assert.equal(stepPlayer(player, input, 0.04).y, 0, 'the ordinary town spawn uses the ground level');

  // LANDING FIXTURE: a portal has just committed a return to the upper platform.
  service.rememberTownFloor(player, location, player.x, player.z, 3.2);
  service.resetBody(player);
  const moved = stepPlayer(player, input, 0.04);
  assert.ok(Math.abs(moved.y - 3.2) < 0.001);
  const saved = { id: 1, x: moved.x, z: moved.z, yaw: 0, rpg: JSON.parse(JSON.stringify(player.rpg)) };
  assert.ok(Math.abs(stepPlayer(saved, input, 0.04).y - 3.2) < 0.001, 'the upper floor survives a fresh body');
  const relocated = { ...saved, x: saved.x + 1 };
  assert.equal(stepPlayer(relocated, input, 0.04).y, 0, 'an unrelated position ignores the saved landing');
});

test('[stage 8] a saved swimmer stays below a higher dry floor, with the same Kynareth breath limit on both sides', async () => {
  const w = build({
    ground: false,
    floors: [{ x0: -10, z0: -10, x1: 10, z1: 10, y: -4 }, { x0: -10, z0: -10, x1: 10, z1: 10, y: 2 }],
    water: [{ minX: -10, minZ: -10, maxX: 10, maxZ: 10, y: 0 }],
  });
  const { ctx, loc } = fakeCtx(w);
  const { service, stepPlayer } = createCollision(ctx, { fixtures: { [loc]: w }, preloadDefault: false });
  await service.whenSettled(loc);
  installGuilds(ctx);
  installLocomotion(ctx);
  const rpg = {
    location: loc,
    portal: { to: loc, footY: -2, swimming: true, breath: 12 },
    character: { attributes: { Endurance: 56 } },
    guilds: { temple: { variant: 35, rank: 4 } },
  };
  ctx.services.effectiveAttribute = () => 56;
  const swimmer = { id: 1, x: 0, z: 0, rpg };
  stepPlayer(swimmer, { yaw: 0 }, 0.04);
  const initial = ctx.services.locomotion.stateOf(swimmer);
  assert.equal(initial.mode, 'swim');
  assert.equal(initial.underwater, true);
  assert.ok(initial.y > -2 && initial.y < -1.9);
  assert.ok(initial.breath > 11.9 && initial.breath < 12);
  assert.equal(swimmer.rpg.portal.footY, Math.round(initial.y * 1000) / 1000);
  assert.equal(swimmer.dirty, true);
  assert.equal(initial.maxBreath, 33);
  assert.equal(maxBreath(movementMods({ character: rpg })), initial.maxBreath);
});
