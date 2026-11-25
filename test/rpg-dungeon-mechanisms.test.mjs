// Dungeon mechanism opcodes, triggers and the shared lock ledger (package 5).
// Rules tests run everywhere; scene tests use the installed ARENA2 and real authored records.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installCollision } from '../server/rpg/collision.js';
import { install as installInteriors } from '../server/rpg/interiors.js';
import {
  OP, CAUSE, TRIGGER, accepts, triggerFlag, hazardAmount, doorTextRecord, answerMatches, textInputRecord, opcodeFamily,
  actionRecord, directAction,
} from '../client/world/interiors/dungeonActions.js';
import { RDB_TYPE } from '../client/world/interiors/blocks.js';

const ARENA2 = process.env.ARENA2_DIR ?? new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const skip = existsSync(join(ARENA2, 'MAPS.BSA')) ? false : 'installed ARENA2 required';
const CASTLE = 'dungeon:Daggerfall/Daggerfall';
const GUARD = '0,0:29318'; // S0000160 flat 183.3: opcode 12, prompt 5464, next is the foyer door
const FOYER = '0,0:22866'; // door 55004, starting lock 255, opcode 18
const SECOND_FOYER_DOOR = '0,0:22818';
const PERISTAIR = 'dungeon:Daggerfall/The Dungeon of Peristair';
const LOCKED = '0,0:19670'; // N0000034 door 55004, starting lock 4
const DRAIN = '0,0:24384'; // N0000034 model 58002, opcode 28 walk-on, axis 3

test('trigger flags, hazards, door text and answers follow the DFU action tables', () => {
  assert.equal(triggerFlag(240), TRIGGER.NONE); // lock bits on a door are not a trigger
  assert.ok(accepts(2, CAUSE.DIRECT) && !accepts(2, CAUSE.WALK_ON) && accepts(0, CAUSE.CHAIN));
  assert.ok(accepts(8, CAUSE.ATTACK) && accepts(8, CAUSE.WALK_INTO) && !accepts(8, CAUSE.WALK_ON));
  assert.ok(accepts(9, CAUSE.DIRECT) && !accepts(9, CAUSE.ATTACK) && accepts(10, CAUSE.DOOR) && accepts(5, CAUSE.ATTACK));
  assert.ok(directAction(6) && !directAction(1));
  // 22-25: models use the axis byte, flats their magnitude, times player level.
  assert.deepEqual(hazardAmount({ opcode: 24, axis: 2, flat: false }, { level: 7 }), { pool: 'health', amount: 14 });
  assert.deepEqual(hazardAmount({ opcode: 23, magnitude: 3, axis: 3, flat: true }, { level: 2 }), { pool: 'health', amount: 6 });
  // 21 acts on every 20th activation with Random.Range(max(1, magnitude), max(1, index)) * level.
  assert.equal(hazardAmount({ opcode: 21, magnitude: 0, index: 97 }, { count: 19 }), null);
  assert.deepEqual(hazardAmount({ opcode: 21, magnitude: 0, index: 97 }, { count: 20, level: 3, random: (lo) => lo }), { pool: 'health', amount: 3 });
  assert.deepEqual(hazardAmount({ opcode: 28, axis: 0, flat: false }), { pool: 'magicka', amount: 1 });
  assert.equal(doorTextRecord({ index: 0 }), null);
  assert.equal(doorTextRecord({ index: 3 }), 7705);
  assert.equal(doorTextRecord({ index: 20 }), null); // absent from TEXT.RSC
  assert.equal(doorTextRecord({ index: 9 }), 7709);
  assert.equal(textInputRecord({ index: 64 }), 5464);
  assert.ok(answerMatches({ index: 64 }, ' YES ') && !answerMatches({ index: 64 }, 'no') && answerMatches({ index: 6 }, '1'));
  for (const op of [9, 11, 12, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 50, 99, 100]) assert.ok(opcodeFamily(op));
  assert.equal(opcodeFamily(OP.UNKNOWN_32), 'chain');
  const flat = actionRecord({ type: RDB_TYPE.Flat, flat: { action: 23, flags: 8, nextOffset: 0, magnitude: 4, soundIndex: 39 } });
  assert.deepEqual([flat.opcode, flat.magnitude, flat.axis, flat.index, flat.flat], [23, 4, 4, 39, true]);
});

function session({ random = () => 0.5, services = {} } = {}) {
  let clock = 10_000;
  const players = new Map();
  const messages = [];
  const runtime = createRpgRuntime({
    players, dataPath: ARENA2,
    features: [
      { name: 'collision', install: installCollision },
      { name: 'interiors', install: (ctx) => {
        Object.assign(ctx.services, services);
        installInteriors(ctx, { graceMs: 5000, locations: [], random: () => random() });
      } },
    ],
    now: () => clock,
    save: () => {},
    send: (p, m) => messages.push([p.id, m]),
    log: { info() {}, warn() {}, error() {} },
  });
  const s = runtime.ctx.services;
  const place = (id, location, x, y, z, rpg = {}) => {
    const portal = { from: location.replace(/^dungeon:/, 'town:'), to: location, footY: y };
    const p = { id, name: `Fixture ${id}`, x, yaw: 0, z, rpg: { location, gold: 0, portal, character: { level: 5, health: 80, maxHealth: 80, magicka: 40, maxMagicka: 40, skills: { Lockpicking: 30 } }, ...rpg } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const leave = (p) => { runtime.leave(p); players.delete(p.id); };
  const wait = async (location) => {
    await s.interiors.survey(location);
    assert.equal((await s.collision.whenSettled(location)).status, 'ready');
  };
  const events = (p, kind) => messages.filter(([id, m]) => id === p.id && m.event?.kind === kind).map(([, m]) => m.event);
  return { runtime, s, wait, place, leave, messages, events, act: runtime.act,
    advance: (ms) => { clock += ms; runtime.tick(ms / 1000); } };
}

test('Castle Daggerfall: the entrance guard asks, the right answer opens the held foyer door for everyone', { skip }, async () => {
  const t = session();
  await t.wait(CASTLE);
  const scene = await t.s.interiors.scene(CASTLE);
  const guard = scene.mechanisms.find((m) => m.id === GUARD);
  const door = scene.mechanisms.find((m) => m.id === FOYER);
  assert.deepEqual([guard.action.opcode, guard.action.index, guard.link], [OP.TEXT_INPUT, 64, FOYER]);
  assert.deepEqual([door.door, door.lock, door.action.opcode], [true, 255, OP.OPEN]);
  const spawn = scene.spawn;
  const a = t.place(1, CASTLE, 46.6, spawn.y, -26.3);
  const b = t.place(2, CASTLE, 47.4, spawn.y, -25.6);
  await Promise.resolve();
  const open = () => t.s.interiors.mechanismActive(CASTLE, FOYER);
  const pastDoor = (p) => t.s.movePlayer(p, door.x - 2.5, door.z).x;
  assert.match(t.act(a, 'dungeon.use', { id: FOYER }).error, /magically held/);
  assert.deepEqual(t.act(a, 'dungeon.pick', { id: FOYER }), { ok: true });
  assert.ok(t.events(a, 'dungeonText').some((e) => /magically held/.test(e.text)));
  assert.match(t.act(a, 'dungeon.answer', { id: GUARD, text: 'yes' }).error, /Nobody is waiting/);

  assert.deepEqual(t.act(a, 'dungeon.use', { id: GUARD }), { ok: true });
  assert.deepEqual(t.events(a, 'dungeonPrompt').at(-1), { kind: 'dungeonPrompt', id: GUARD, record: 5464 });
  assert.equal(open(), false, 'the prompt gates its chain');
  assert.deepEqual(t.act(a, 'dungeon.answer', { id: GUARD, text: 'no thanks' }), { ok: true });
  assert.equal(open(), false);
  assert.match(t.act(b, 'dungeon.answer', { id: GUARD, text: 'yes' }).error, /Nobody is waiting/, 'each prompt belongs to its reader');
  const before = pastDoor(b);
  t.act(a, 'dungeon.use', { id: GUARD });
  assert.deepEqual(t.act(a, 'dungeon.answer', { id: GUARD, text: 'Yes' }), { ok: true });
  assert.ok(open());
  assert.ok(t.events(b, 'dungeonState').at(-1).active.includes(FOYER), 'the other player receives the pose');
  assert.ok(pastDoor(b) < before - 1, 'collision follows the shared door');

  const saved = structuredClone(b.rpg);
  t.leave(b);
  t.advance(3000);
  const back = t.place(2, CASTLE, b.x, saved.portal.footY, b.z, saved);
  assert.ok(t.events(back, 'dungeonState').at(-1).active.includes(FOYER), 'reconnect sees the open foyer');
  t.leave(a);
  t.leave(back);
  t.advance(6000);
  assert.equal(open(), false, 'the instance resets after the grace period');
});

test('Castle Daggerfall restores a saved foyer release for both occupants after a cold resume', { skip }, async () => {
  const city = 'town:Daggerfall/Daggerfall';
  const first = session();
  await first.wait(CASTLE);
  const entrance = first.s.portals.into(CASTLE).entrances[0];
  const visit = () => ({
    portal: { id: 'dungeon', from: city, to: CASTLE, footY: 25.6, returnTo: { location: city, ...entrance.exit } },
  });
  const owner = first.place(1, CASTLE, 46.6, 25.6, -26.3, visit());
  const companion = first.place(2, CASTLE, 47.4, 25.6, -25.6, visit());
  await Promise.resolve();
  assert.match(first.act(owner, 'dungeon.use', { id: FOYER }).error, /magically held/);
  assert.ok(first.act(owner, 'dungeon.use', { id: GUARD }).ok);
  assert.ok(first.act(owner, 'dungeon.answer', { id: GUARD, text: 'yes' }).ok);
  assert.deepEqual(first.events(companion, 'dungeonState').at(-1).active.filter((id) => [FOYER, SECOND_FOYER_DOOR].includes(id)).sort(), [SECOND_FOYER_DOOR, FOYER]);
  assert.ok(first.act(owner, 'dungeon.use', { id: FOYER }).ok, 'a visitor closes the unlocked door');
  first.leave(owner);
  const saved = structuredClone(owner.rpg);
  assert.deepEqual(saved.portal.daggerfallFoyer, [
    { id: FOYER, open: false, lock: 0 },
    { id: SECOND_FOYER_DOOR, open: true, lock: 0 },
  ]);

  const cold = session();
  await cold.wait(CASTLE);
  const newcomer = cold.place(2, CASTLE, 47.4, 25.6, -25.6, visit());
  await Promise.resolve();
  assert.match(cold.act(newcomer, 'dungeon.use', { id: FOYER }).error, /magically held/, 'a fresh entrant gets the stock puzzle');

  // FIXTURE POSITION: the saved visitor reconnects from the court side of the foyer.
  const court = { x: 44.186, y: 25.6, z: -26.182 };
  const resumed = cold.place(1, CASTLE, court.x, court.y, court.z, saved);
  const shared = cold.events(newcomer, 'dungeonState').at(-1);
  assert.deepEqual(shared.active, [SECOND_FOYER_DOOR]);
  assert.equal(shared.locks[FOYER], 0);
  assert.equal(shared.locks[SECOND_FOYER_DOOR], 0);
  assert.deepEqual(cold.events(resumed, 'dungeonState').at(-1), shared);
  assert.ok(cold.act(resumed, 'dungeon.use', { id: FOYER }).ok, 'the saved visitor opens the unlocked door from the court side');
  const moved = cold.s.movePlayer(resumed, 49.8, -25.6);
  assert.ok(moved.x > 48, 'collision allows the return through the foyer');
  await cold.s.collision.whenSettled(city);
  Object.assign(resumed, moved); // FIXTURE POSITION: at the authored exit after the collision-checked route.
  assert.deepEqual(cold.act(resumed, 'portal.leave', {}), { ok: true });
  assert.equal(resumed.rpg.location, city);

  cold.leave(resumed);
  cold.leave(newcomer);
  cold.advance(6000);
  const legacy = cold.place(1, CASTLE, court.x, court.y, court.z, visit());
  const legacyState = cold.events(legacy, 'dungeonState').at(-1);
  assert.ok(legacyState.active.includes(FOYER) && legacyState.active.includes(SECOND_FOYER_DOOR), 'pre-fix court saves can leave too');
});

test('Peristair locked door: pick, retry rule, bash and armed Open/Lock share one ledger', { skip }, async () => {
  let roll = 0.99;
  let armed = null;
  const skills = [];
  const t = session({
    random: () => roll,
    services: {
      takeDoorMagic: () => { const m = armed; armed = null; return m; },
      advanceSkill: (p, name) => skills.push(name),
    },
  });
  await t.wait(PERISTAIR);
  const scene = await t.s.interiors.scene(PERISTAIR);
  const door = scene.mechanisms.find((m) => m.id === LOCKED);
  assert.equal(door.lock, 4);
  const a = t.place(1, PERISTAIR, door.x - 1.2, 12.8, door.z);
  const b = t.place(2, PERISTAIR, door.x - 1.6, 12.8, door.z + 0.6);
  await Promise.resolve();
  const L = t.s.dungeonLocks;
  const isOpen = () => L.isOpen(PERISTAIR, LOCKED);
  assert.match(t.act(a, 'dungeon.use', { id: LOCKED }).error, /locked/);

  // Chance = clamp(5 * (level 5 - lock 4) + skill 30, 5, 95) = 35; a d100 of 100 fails and blocks a retry at this skill.
  assert.deepEqual(t.act(a, 'dungeon.pick', { id: LOCKED }), { ok: true });
  assert.equal(isOpen(), false);
  assert.ok(t.events(a, 'dungeonText').some((e) => /fail to pick/.test(e.text)));
  assert.deepEqual(skills, ['Lockpicking']);
  roll = 0;
  t.act(a, 'dungeon.pick', { id: LOCKED });
  assert.ok(t.events(a, 'dungeonText').some((e) => /already failed/.test(e.text)));
  assert.equal(isOpen(), false);
  // Another player has their own attempt; success unlocks and opens for both.
  assert.deepEqual(t.act(b, 'dungeon.pick', { id: LOCKED }), { ok: true });
  assert.ok(isOpen());
  assert.equal(L.lockOf(PERISTAIR, LOCKED), 0);
  assert.ok(t.events(a, 'dungeonState').at(-1).active.includes(LOCKED));

  // Armed Lock on the open door: lock = caster level, and the door swings shut (Lock.cs).
  armed = { operation: 'lock', level: 9 };
  t.act(a, 'dungeon.use', { id: LOCKED });
  assert.equal(L.lockOf(PERISTAIR, LOCKED), 9);
  assert.equal(isOpen(), false);
  assert.match(t.act(a, 'dungeon.use', { id: LOCKED }).error, /locked/);
  // Open at a lower level is consumed with feedback; at level >= lock it opens.
  armed = { operation: 'open', level: 3 };
  assert.deepEqual(t.act(a, 'dungeon.use', { id: LOCKED }), { ok: true });
  assert.equal(armed, null);
  assert.equal(isOpen(), false);
  assert.ok(t.events(a, 'dungeonText').some((e) => /resists/.test(e.text)));
  armed = { operation: 'open', level: 9 };
  t.act(a, 'dungeon.use', { id: LOCKED });
  assert.ok(isOpen());
  assert.equal(L.lockOf(PERISTAIR, LOCKED), 0);

  // Bash: an open door is bashed shut; a closed one opens on d100 <= 20 - lock.
  L.bash(a, LOCKED);
  assert.equal(isOpen(), false);
  t.act(a, 'dungeon.use', { id: LOCKED }); // unlocked now
  t.act(a, 'dungeon.use', { id: LOCKED });
  armed = { operation: 'lock', level: 12 };
  t.act(a, 'dungeon.use', { id: LOCKED });
  roll = 0.5; // 51 > 8
  L.bash(a, LOCKED);
  assert.equal(isOpen(), false);
  roll = 0.05; // 6 <= 8
  L.bash(a, LOCKED);
  assert.ok(isOpen());
  assert.equal(L.lockOf(PERISTAIR, LOCKED), 0);
});

test('Peristair drain pit: walking on the authored model drains magicka, standing still does not repeat', { skip }, async () => {
  const t = session();
  await t.wait(PERISTAIR);
  const scene = await t.s.interiors.scene(PERISTAIR);
  const pit = scene.mechanisms.find((m) => m.id === DRAIN);
  assert.deepEqual([pit.action.opcode, triggerFlag(pit.action.trigger)], [OP.DRAIN_MAGICKA, TRIGGER.WALK_ON]);
  const world = t.s.collision.instanceWorld(PERISTAIR);
  // The top of the authored model: find a clear standing point where the floor is the model's own top surface.
  const P = scene.positions;
  let top = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = pit.firstTriangle * 9; i < (pit.firstTriangle + pit.triangleCount) * 9; i += 3) {
    top = Math.max(top, P[i + 1]); minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]); minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]);
  }
  let spot = null;
  for (let fx = 0.2; fx <= 0.8 && !spot; fx += 0.1) for (let fz = 0.2; fz <= 0.8 && !spot; fz += 0.1) {
    const x = minX + (maxX - minX) * fx, z = minZ + (maxZ - minZ) * fz;
    const y = world.heightAt(x, z, top + 0.5);
    if (y != null && Math.abs(y - top) < 0.35 && world.isClear(x, z, y)) spot = { x, y, z };
  }
  assert.ok(spot, 'a standing point on the drain model');
  const a = t.place(1, PERISTAIR, spot.x - 3, spot.y, spot.z);
  await Promise.resolve();
  t.advance(100);
  const magicka = () => a.rpg.character.magicka;
  assert.equal(magicka(), 40);
  a.x = spot.x; a.z = spot.z;
  t.advance(100);
  assert.equal(magicka(), 37, 'axis 3 drains 3 points');
  assert.deepEqual(t.events(a, 'dungeonHazard').at(-1), { kind: 'dungeonHazard', id: DRAIN, pool: 'magicka', amount: 3 });
  t.advance(1500);
  assert.equal(magicka(), 37, 'no repeat while standing still');
  a.x += 0.05;
  t.advance(100);
  assert.equal(magicka(), 34, 'moving on the pit drains again after the repeat interval');
});

test("Privateer's Hold lift: the lever raises the platform and the player standing on it rides up", { skip }, async () => {
  const HOLD = "dungeon:Daggerfall/Privateer's Hold";
  const LEVER = '0,0:32273', LIFT = '0,0:32083';
  const t = session();
  await t.wait(HOLD);
  const scene = await t.s.interiors.scene(HOLD);
  const lever = scene.mechanisms.find((m) => m.id === LEVER);
  const lift = scene.mechanisms.find((m) => m.id === LIFT);
  assert.deepEqual([lever.link, lift.action.opcode, lift.action.axis, triggerFlag(lift.action.trigger)], [LIFT, OP.MOVE, 4, TRIGGER.NONE]);
  const world = t.s.collision.instanceWorld(HOLD);
  const P = scene.positions;
  let top = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = lift.firstTriangle * 9; i < (lift.firstTriangle + lift.triangleCount) * 9; i += 3) {
    top = Math.max(top, P[i + 1]); minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]); minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]);
  }
  let spot = null;
  for (let fx = 0.15; fx <= 0.85 && !spot; fx += 0.05) for (let fz = 0.15; fz <= 0.85 && !spot; fz += 0.05) {
    const x = minX + (maxX - minX) * fx, z = minZ + (maxZ - minZ) * fz;
    const y = world.heightAt(x, z, top + 0.3);
    if (y != null && Math.abs(y - top) < 0.3 && world.isClear(x, z, y) && Math.hypot(x - lever.x, z - lever.z) < 2.2) spot = { x, y, z };
  }
  assert.ok(spot, 'a standing point on the lift within reach of its lever');
  const a = t.place(1, HOLD, spot.x, spot.y, spot.z);
  const b = t.place(2, HOLD, spot.x + 30, 38.975, spot.z); // elsewhere in the hold
  await Promise.resolve();
  const y0 = a.rpg.portal.footY;
  assert.deepEqual(t.act(a, 'dungeon.use', { id: LEVER }), { ok: true });
  assert.ok(t.s.interiors.mechanismActive(HOLD, LIFT));
  assert.ok(a.rpg.portal.footY > y0 + 5, `rider lifted from ${y0} to ${a.rpg.portal.footY}`);
  assert.ok(world.isClear(a.x, a.z, a.rpg.portal.footY));
  assert.ok(Math.abs(b.rpg.portal.footY - 38.975) < 0.01, 'players off the platform stay put');
});

test('Castle Daggerfall guard is an action, not a conversation: npc.talk is refused, dungeon.use asks', { skip }, async (t) => {
  const { features } = await import('../server/rpg/features.js');
  const { createFixtureWorld, tempDir } = await import('./support/rpg-session.mjs');
  const tmp = tempDir('dfw-guard-');
  const w = await createFixtureWorld({ dbPath: join(tmp.dir, 'g.db'), dataPath: ARENA2, features });
  t.after(() => { w.close(); tmp.remove(); });
  const s = w.ctx.services;
  await s.interiors.survey('town:Daggerfall/Daggerfall');
  const portal = s.portals.into(CASTLE);
  const row = w.store.createForAccount('guest', 'guest');
  w.store.saveCharacters([{ ...row, ...portal.entrances[0].exit, rpg: { location: 'town:Daggerfall/Daggerfall' } }]);
  const c = w.connect('guest', 'guest');
  await s.collision.whenSettled(CASTLE);
  let r = c.act('portal.use', { portalId: portal.id });
  for (let i = 0; i < 100 && !r.ok && /loading|moment/i.test(r.error); i++) { await new Promise((res) => setTimeout(res, 100)); w.tick(100); r = c.act('portal.use', { portalId: portal.id }); }
  assert.equal(r.ok, true, r.error);
  let guard = null;
  for (let i = 0; i < 100 && !guard; i++) {
    await new Promise((res) => setTimeout(res, 50));
    w.tick(50);
    guard = [...w.ctx.entities.values()].find((e) => e.kind === 'npc' && e.location === CASTLE && e.mechanism === GUARD);
  }
  assert.ok(guard, 'the guard flat is a person entity linked to its mechanism');
  assert.equal(guard.actionOnly, true);
  // Fixture positioning: in front of the guard (the walk from the entrance is in the Castle case above).
  c.player.x = 46.6; c.player.z = -26.3;
  assert.match(c.act('npc.talk', { targetId: guard.id }).error, /nothing to say/);
  // Package 3: the same shared guard (npcs.nearNpc) refuses every ordinary conversation route, not only npc.talk.
  for (const [verb, args] of [
    ['npc.ask', { targetId: guard.id, session: 'x', query: '' }],
    ['npc.topic', { targetId: guard.id, session: 'x', topic: 'news' }],
    ['npc.tone', { targetId: guard.id, session: 'x', tone: 'polite' }],
    ['npc.service', { targetId: guard.id, session: 'x', service: 'join' }],
    ['quest.request', { targetId: guard.id }],
  ]) assert.match(c.act(verb, args).error ?? '', /nothing to say/, verb);
  assert.ok(!c.events('dialogue').some((ev) => ev.entityId === guard.id), 'no dialogue view for the guard');
  assert.deepEqual(c.act('dungeon.use', { id: GUARD }), { ok: true });
  assert.equal(c.events('dungeonPrompt').at(-1).record, 5464);
});
