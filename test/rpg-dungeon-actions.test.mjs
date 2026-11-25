import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installCollision } from '../server/rpg/collision.js';
import { install as installInteriors } from '../server/rpg/interiors.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { MANTELLAN } from '../client/world/interiors/dungeonAccess.js';

const ARENA2 = process.env.ARENA2_DIR ?? new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const skip = existsSync(join(ARENA2, 'MAPS.BSA')) ? false : 'installed ARENA2 required';
const PERISTAIR = 'dungeon:Daggerfall/The Dungeon of Peristair';
const HOLD = "dungeon:Daggerfall/Privateer's Hold";
const STUVAM = "town:Alik'r Desert/The Stuvam Graveyard";
const SWITCH = '0,1:20764';
const DOOR = '0,1:21997';

function session() {
  let clock = 10_000;
  let rejectSave = false;
  const players = new Map();
  const messages = [];
  const globals = [];
  const runtime = createRpgRuntime({
    players, dataPath: ARENA2,
    features: [
      { name: 'collision', install: installCollision },
      { name: 'travel', install: installTravel },
      { name: 'interiors', install: (ctx) => {
        installInteriors(ctx, { graceMs: 5000, locations: [] });
        ctx.on('questGlobal', (e) => globals.push(e.index));
        ctx.onAction('fixture.questTransfer', (p) => ctx.services.interiors.questTransfer(p, p.rpg.quests.active[0]));
      } },
    ],
    now: () => clock,
    save: () => { if (rejectSave) throw new Error('fixture disk error'); },
    send: (p, m) => messages.push([p.id, m]),
    log: { info() {}, warn() {}, error() {} },
  });
  const { services } = runtime.ctx;
  const place = (id, location, x, y, z, rpg = {}) => {
    const from = location.replace(/^dungeon:/, 'town:');
    const portal = location.startsWith('dungeon:') ? { from, to: location, footY: y } : undefined;
    const p = { id, name: `Fixture ${id}`, x, yaw: 0, z, rpg: { location, gold: 100_000, portal, ...rpg } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const leave = (p) => { runtime.leave(p); players.delete(p.id); };
  const wait = async (location) => {
    await services.interiors.survey(location);
    assert.equal((await services.collision.whenSettled(location)).status, 'ready');
  };
  return { runtime, services, wait, place, leave, messages, globals,
    act: runtime.act, advance: (ms) => { clock += ms; runtime.tick(ms / 1000); }, failSaves: (value) => { rejectSave = value; } };
}

test('Peristair opens for both players, closes on the authored switch, and resets after vacancy', { skip }, async () => {
  const s = session();
  await s.wait(PERISTAIR);
  const scene = await s.services.interiors.scene(PERISTAIR);
  const lever = scene.mechanisms.find((m) => m.id === SWITCH);
  const door = scene.mechanisms.find((m) => m.id === DOOR);
  assert.equal(lever.modelId, 61028);
  assert.equal(lever.link, door.id);
  assert.equal(door.modelId, 55001);
  assert.equal(door.action.opcode, 20);
  const a = s.place(1, PERISTAIR, 20.925, 44.8, -72);
  const b = s.place(2, PERISTAIR, 30.8, 44.8, -79.6);
  await Promise.resolve(); // Both players share the loaded scene.
  const use = (p, id) => s.act(p, 'dungeon.use', { id });
  const isActive = (id) => s.services.interiors.mechanismActive(PERISTAIR, id);
  const move = (p) => s.services.movePlayer(p, 32.6, -79.6).x;
  const blocked = move(b);
  assert.ok(blocked < 31.5);
  s.failSaves(true);
  assert.match(use(b, DOOR).error, /could not save/);
  assert.equal(isActive(DOOR), false);
  assert.ok(move(b) < 31.5);
  s.failSaves(false);
  assert.deepEqual(use(b, DOOR), { ok: true });
  assert.ok(isActive(DOOR));
  assert.ok(move(b) > 32);
  assert.ok(s.messages.some(([id, m]) => id === a.id && m.event?.active?.includes(DOOR)));

  a.rpg.portal.footY -= 12; // Same XZ with the wrong authoritative height.
  assert.match(use(a, SWITCH).error, /out of reach/);
  a.rpg.portal.footY = 44.8;
  assert.deepEqual(use(a, SWITCH), { ok: true });
  assert.equal(isActive(DOOR), false);
  assert.ok(isActive(SWITCH));
  assert.ok(move(b) < 31.5);
  // The lever rotates for 18 / 20 s (DaggerfallAction.Duration); DFU ignores activations while it plays.
  assert.deepEqual(use(a, SWITCH), { ok: true });
  assert.ok(isActive(SWITCH));
  assert.ok(s.messages.some(([id, m]) => id === a.id && /still moving/.test(m.event?.text ?? '')));
  s.advance(1000);
  assert.deepEqual(use(a, SWITCH), { ok: true });
  assert.equal(isActive(SWITCH), false);
  assert.equal(isActive(DOOR), false);
  assert.deepEqual(use(b, DOOR), { ok: true });

  s.leave(b);
  s.advance(10_000); // The other player keeps the instance alive.
  const resumed = s.place(2, PERISTAIR, b.x, 44.8, b.z, structuredClone(b.rpg));
  assert.ok(isActive(DOOR));
  assert.ok(s.messages.some(([id, m]) => id === resumed.id && m.event?.active?.includes(DOOR)));
  s.leave(a);
  s.leave(resumed);
  s.advance(2000);
  const early = s.place(2, PERISTAIR, b.x, 44.8, b.z);
  s.advance(4000);
  assert.ok(isActive(DOOR), 'an early return cancels the vacancy timer');
  s.leave(early);
  s.advance(5000);
  assert.equal(isActive(DOOR), false);
});

test("Privateer's Hold rejects the wrong exit floor and reconnect preserves authored floor and return", { skip }, async () => {
  const s = session();
  const town = HOLD.replace(/^dungeon:/, 'town:');
  await s.wait(town);
  await s.wait(HOLD);
  const portal = s.services.portals.into(HOLD);
  const entrance = portal.entrances[0];
  const a = s.place(1, town, entrance.exit.x, 0, entrance.exit.z);
  assert.deepEqual(s.act(a, 'portal.use', { portalId: 'dungeon' }), { ok: true });
  const save = structuredClone(a.rpg);
  s.leave(a);
  s.advance(1200);
  const b = s.place(1, HOLD, a.x, 0, a.z, save);
  assert.equal(b.rpg.portal.footY, a.rpg.portal.footY);
  assert.ok(b.rpg.portal.footY > 38);
  const markers = await s.services.interiors.questMarkers(HOLD);
  assert.ok(markers.some((m) => m.floor > b.rpg.portal.footY + 5));
  assert.equal(new Set(markers.map((m) => m.id)).size, markers.length);
  assert.deepEqual(await s.services.interiors.questMarkers(HOLD), markers);
  b.rpg.portal.footY = 5;
  assert.match(s.act(b, 'portal.leave', {}).error, /stand at the exit/);
  b.rpg.portal.footY = a.rpg.portal.footY;
  assert.deepEqual(s.act(b, 'portal.leave', {}), { ok: true });
  assert.deepEqual([b.rpg.location, b.x, b.z, b.yaw], [town, entrance.exit.x, entrance.exit.z, entrance.exit.yaw]);
});

test('Stuvam compatibility portal and Mantellan Crux quest gates use production landing geometry', { skip }, async () => {
  const s = session();
  const stuvam = STUVAM.replace(/^town:/, 'dungeon:');
  await s.wait(STUVAM);
  await s.wait(stuvam);
  const a = s.place(1, STUVAM, 0, 0, 0);
  assert.equal(s.services.portals.into(stuvam).meta.access, 'graveyard-compatibility');
  assert.deepEqual(s.act(a, 'portal.use', { portalId: 'dungeon' }), { ok: true });
  s.advance(1000);
  assert.deepEqual(s.act(a, 'portal.leave', {}), { ok: true });
  assert.equal(a.rpg.location, STUVAM);

  await s.services.interiors.prepareQuestTransfer();
  await s.wait(MANTELLAN.dungeon);
  await s.wait(MANTELLAN.returnDungeon);
  s.services.travel.discover(a, MANTELLAN.town);
  assert.match(s.act(a, 'travel.go', { to: 'town:31/0' }).error, /Nulfaga/);
  const outsideCrux = s.place(2, MANTELLAN.town, 0, 0, 0);
  assert.match(s.act(outsideCrux, 'portal.use', { portalId: 'dungeon' }).error, /no such door/);
  const inst = { name: MANTELLAN.quest, uid: 'fixture-story' };
  const c = s.place(3, MANTELLAN.returnDungeon, 30, 19, -18, { quests: { active: [] } });
  assert.match(s.act(c, 'fixture.questTransfer', {}).error, /requires Journey to Aetherius/);
  c.rpg.quests.active.push(inst);
  assert.deepEqual(s.act(c, 'fixture.questTransfer', {}), { ok: true });
  assert.equal(c.rpg.location, MANTELLAN.dungeon);
  assert.deepEqual([c.x.toFixed(2), c.z.toFixed(2)], ['30.20', '-27.95']);
  assert.match(s.act(c, 'portal.leave', {}).error, /no exit door/);

  const scene = await s.services.interiors.scene(MANTELLAN.dungeon);
  const jewel = scene.mechanisms.find((m) => m.mantella);
  assert.equal(jewel.offset, 13737);
  const world = s.services.collision.instanceWorld(MANTELLAN.dungeon);
  const x = jewel.x + 1.5, z = jewel.z;
  const y = world.heightAt(x, z, jewel.y);
  c.x = x; c.z = z; c.rpg.portal.footY = y; // Quest-completion fixture starts at the authored crystal.
  await Promise.resolve();
  assert.deepEqual(s.act(c, 'dungeon.use', { id: jewel.id }), { ok: true });
  assert.equal(c.rpg.location, MANTELLAN.returnDungeon);
  assert.deepEqual([c.x.toFixed(2), c.z.toFixed(2)], ['30.45', '-17.95']);
  assert.deepEqual(s.globals, [36]);
  assert.equal(c.rpg.mantellan.stage, 'finished');
  assert.match(s.act(c, 'fixture.questTransfer', {}).error, /already sent/);
});
