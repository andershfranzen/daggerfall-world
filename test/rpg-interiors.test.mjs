// Interiors and dungeons: portal registry and the server feature on the real runtime, with a TEST-ONLY world
// source (two hand-written portals). Real ARENA2 coverage: rpg-interiors-world.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInteriors } from '../server/rpg/interiors.js';
import { createPortalRegistry } from '../server/rpg/interiors/portals.js';
import {
  parseLocation, exteriorOf, interiorLocation, townLocation, yawFacing, portalSpecs,
} from '../client/world/interiors/index.js';
import { townDoors, nearestDoor, sceneExits, install as installClient } from '../client/gameplay/interiors.js';

const TOWN = 'town:Daggerfall/Gothway Garden';
const INSIDE = 'interior:Daggerfall/Gothway Garden/1,2/3';
const DUNGEON = 'dungeon:Daggerfall/Gothway Garden';

/** Test-only specs: a two-door shop and a dungeon entrance. */
const specs = () => [
  {
    id: 'b:1,2:3', from: TOWN, to: INSIDE, kind: 'building', label: 'Armorer',
    entrances: [
      { x: 10, z: 0, enter: { x: 1, z: 1, yaw: 0 }, inner: { x: 0, z: 0 }, exit: { x: 11, z: 0, yaw: 1.5 } },
      { x: 20, z: 0, enter: { x: 9, z: 1, yaw: 0 }, inner: { x: 10, z: 0 }, exit: { x: 21, z: 0, yaw: 1.5 } },
    ],
    exits: [{ x: 0, z: 0 }, { x: 10, z: 0 }],
  },
  {
    id: 'dungeon', from: TOWN, to: DUNGEON, kind: 'dungeon', label: 'The Hold',
    entrances: [{ x: -30, z: 5, enter: { x: 50, y: 39, z: -12, yaw: 0.7 }, exit: { x: -31, z: 6, yaw: 3 } }],
    exits: [{ x: 49, z: -11 }],
    meta: { encounters: [{ x: 48, y: 39, z: -20, monsters: [15], key: 'S0000999.RDB:0/1' }, { x: 40, y: 39, z: -20, table: 2, count: 1, key: 'S0000999.RDB:0/9' }] },
  },
];

describe('location ids', () => {
  test('parse, round-trip and reject', () => {
    assert.deepEqual(parseLocation(INSIDE), { kind: 'interior', region: 'Daggerfall', location: 'Gothway Garden', bx: 1, by: 2, record: 3 });
    assert.equal(interiorLocation('Daggerfall', 'Gothway Garden', 1, 2, 3), INSIDE);
    assert.equal(parseLocation(DUNGEON).kind, 'dungeon');
    assert.equal(exteriorOf(INSIDE), TOWN);
    assert.equal(exteriorOf(DUNGEON), TOWN);
    assert.equal(townLocation("Alik'r Desert", "Alik'ra"), "town:Alik'r Desert/Alik'ra");
    for (const bad of ['', 'town:', 'town:A', 'interior:A/B/1,2', 'interior:A/B/x,2/3', 'house:A/B', 'town:A/B/C', 42, null, 'town:A\u0000/B']) {
      assert.equal(parseLocation(bad), null, String(bad));
    }
    assert.ok(Math.abs(yawFacing(0, -1)) < 1e-9); // facing -z is yaw 0
    assert.ok(Math.abs(yawFacing(1, 0) - Math.PI / 2) < 1e-9); // facing +x
  });
});

describe('portal registry', () => {
  test('validates specs', () => {
    const r = createPortalRegistry();
    assert.throws(() => r.register({ ...specs()[0], id: 'bad id!' }), /id/);
    assert.throws(() => r.register({ ...specs()[0], to: TOWN }), /two different/);
    assert.throws(() => r.register({ ...specs()[0], entrances: [] }), /entrance/);
    assert.throws(() => r.register({ ...specs()[0], exits: [] }), /exit/);
    assert.throws(() => r.register({ ...specs()[0], entrances: [{ x: NaN, z: 0, enter: { x: 0, z: 0, yaw: 0 }, exit: { x: 0, z: 0, yaw: 0 } }] }), /finite/);
    r.register(specs()[0]);
    assert.throws(() => r.register({ ...specs()[0], id: 'other' }), /already has a portal/);
    r.register(specs()[0]); // same key replaces
    assert.equal(r.size, 1);
  });

  test('enter needs the right location, a known door and reach', () => {
    const r = createPortalRegistry({ reach: 3 });
    for (const s of specs()) r.register(s);
    assert.throws(() => r.planEnter('town:Daggerfall/Elsewhere', { x: 10, z: 0 }, 'b:1,2:3'), /no such door/);
    assert.throws(() => r.planEnter(TOWN, { x: 10, z: 0 }, 'b:9,9:9'), /no such door/);
    assert.throws(() => r.planEnter(TOWN, { x: 10, z: 0 }, '../etc'), /not a door/);
    assert.throws(() => r.planEnter(TOWN, { x: 14, z: 0 }, 'b:1,2:3'), /too far/);
    const plan = r.planEnter(TOWN, { x: 19, z: 1 }, 'b:1,2:3');
    assert.deepEqual(plan.landing, { location: INSIDE, x: 9, y: 0, z: 1, yaw: 0 }); // the nearer (second) door
  });

  test('leave picks the exterior door matching the exit used', () => {
    const r = createPortalRegistry({ reach: 3 });
    for (const s of specs()) r.register(s);
    assert.throws(() => r.planLeave(TOWN, { x: 0, z: 0 }), /no way out/);
    assert.throws(() => r.planLeave(INSIDE, { x: 5, z: 5 }), /stand at the exit/);
    assert.deepEqual(r.planLeave(INSIDE, { x: 0.5, z: 0 }).landing, { location: TOWN, x: 11, y: 0, z: 0, yaw: 1.5 });
    assert.deepEqual(r.planLeave(INSIDE, { x: 9.5, z: 0 }).landing, { location: TOWN, x: 21, y: 0, z: 0, yaw: 1.5 });
    assert.equal(r.planLeave(DUNGEON, { x: 49, z: -12 }).landing.location, TOWN);
  });
});

/** Runtime with the interiors feature on a test-only source. */
async function session({ source = { townPortals: async () => specs(), scene: async () => ({}) }, dataPath = '/nonexistent', players = [], awaitReady = true } = {}) {
  const map = new Map();
  const sent = [];
  const saves = [];
  const emitted = [];
  let failSave = false;
  let clock = 1000;
  let services;
  const runtime = createRpgRuntime({
    players: map,
    features: [{ name: 'interiors', install: (ctx) => { installInteriors(ctx, { source: source ?? undefined }); services = ctx.services; ctx.on('locationChanged', (e) => emitted.push(e)); } }],
    save: (list) => { if (failSave) throw new Error('disk full'); saves.push(list.map((p) => p.id)); },
    send: (p, msg) => sent.push([p.id, msg]),
    dataPath: source ? dataPath : null,
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  });
  if (awaitReady) await services.interiors.ready;
  const join = (id, rpg = {}, pos = { x: 10, z: 0 }) => {
    const p = { id, name: `P${id}`, yaw: 0, moving: false, rpg, ...pos };
    map.set(id, p);
    runtime.join(p);
    return p;
  };
  for (const [id, rpg, pos] of players) join(id, rpg, pos);
  return { runtime, map, sent, saves, emitted, services, join, advance: (ms) => { clock += ms; }, failSaves: (v) => { failSave = v; } };
}

const events = (s, id, kind) => s.sent.filter(([pid, m]) => pid === id && m.type === 'gameEvent' && m.event.kind === kind).map(([, m]) => m.event);

describe('server interiors feature', () => {
  test('enter and leave a building through validated doors', async () => {
    const s = await session();
    const p = s.join(1);
    assert.equal(s.services.interiors.status(TOWN), 'ready');
    let r = s.runtime.act(p, 'portal.use', { portalId: 'b:1,2:3' });
    assert.deepEqual(r, { ok: true });
    assert.equal(p.rpg.location, INSIDE);
    assert.deepEqual([p.x, p.z, p.yaw], [1, 1, 0]);
    assert.deepEqual(p.rpg.portal.returnTo, { location: TOWN, x: 11, z: 0, yaw: 1.5 });
    assert.deepEqual(events(s, 1, 'teleport').at(-1), { kind: 'teleport', location: INSIDE, x: 1, y: 0, z: 1, yaw: 0, label: 'Armorer' });
    assert.equal(s.emitted.at(-1).to, INSIDE);
    assert.deepEqual(s.saves.at(-1), [1]);

    r = s.runtime.act(p, 'portal.leave', {});
    assert.match(r.error, /Wait a moment/); // per-player cooldown
    s.advance(1000);
    p.x = 6; // walked away from the exits
    assert.match(s.runtime.act(p, 'portal.leave', {}).error, /stand at the exit/);
    p.x = 9.6;
    assert.deepEqual(s.runtime.act(p, 'portal.leave', {}), { ok: true });
    assert.equal(p.rpg.location, TOWN);
    assert.deepEqual([p.x, p.z, p.yaw], [21, 0, 1.5]); // outside the second door
    assert.equal(p.rpg.portal, undefined);
  });

  test('refuses doors that are far, unknown or on another location', async () => {
    const s = await session();
    const p = s.join(1, {}, { x: 100, z: 100 });
    assert.match(s.runtime.act(p, 'portal.use', { portalId: 'b:1,2:3' }).error, /too far/);
    assert.match(s.runtime.act(p, 'portal.use', { portalId: 'b:0,0:0' }).error, /no such door/);
    assert.match(s.runtime.act(p, 'portal.use', {}).error, /not a door/);
    assert.match(s.runtime.act(p, 'portal.leave', {}).error, /already outside/);
    assert.equal(p.rpg.location, TOWN);
    assert.deepEqual([p.x, p.z], [100, 100]);
  });

  test('players share an instance and see each other there', async () => {
    const s = await session();
    const a = s.join(1);
    const b = s.join(2, {}, { x: 20, z: 1 });
    const c = s.join(3, {}, { x: -30, z: 5 });
    s.runtime.act(a, 'portal.use', { portalId: 'b:1,2:3' });
    s.runtime.act(b, 'portal.use', { portalId: 'b:1,2:3' });
    s.runtime.act(c, 'portal.use', { portalId: 'dungeon' });
    assert.equal(a.rpg.location, b.rpg.location);
    assert.equal(c.rpg.location, DUNGEON);
    assert.deepEqual([c.x, c.z, c.yaw], [50, -12, 0.7]);
    const msg = s.runtime.rpgMessage(a);
    assert.deepEqual(msg.peers.map((q) => q.id), [2]);
    assert.ok(events(s, 1, 'portal').some((e) => e.text === 'P2 arrived.'));
    assert.ok(!events(s, 2, 'portal').some((e) => e.playerId === 2), 'the mover gets a teleport event, not its own arrival');
    assert.deepEqual(s.runtime.rpgMessage(c).peers, []);
  });

  test('reconnect keeps a player inside a known instance and returns them from a vanished one', async () => {
    const s = await session();
    const inside = s.join(1, { location: INSIDE, portal: { id: 'b:1,2:3', from: TOWN, to: INSIDE, returnTo: { location: TOWN, x: 11, z: 0, yaw: 1.5 } } }, { x: 2, z: 3 });
    assert.equal(inside.rpg.location, INSIDE);
    assert.deepEqual([inside.x, inside.z], [2, 3]);
    const gone = 'interior:Daggerfall/Gothway Garden/7,7/7';
    const stray = s.join(2, { location: gone, portal: { id: 'b:7,7:7', from: TOWN, to: gone, returnTo: { location: TOWN, x: 11, z: 0, yaw: 1.5 } } }, { x: 2, z: 3 });
    assert.equal(stray.rpg.location, TOWN);
    assert.deepEqual([stray.x, stray.z, stray.yaw], [11, 0, 1.5]);
    assert.equal(stray.rpg.portal, undefined);
    const noReturn = s.join(3, { location: gone }, { x: 2, z: 3 });
    assert.equal(noReturn.rpg.location, TOWN);
    assert.deepEqual([noReturn.x, noReturn.z], [0, 0]);
  });

  test('a player saved inside waits while the town is surveyed, then is placed correctly', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const s = await session({ awaitReady: false, source: { townPortals: async () => { await gate; return specs(); }, scene: async () => ({}) } });
    assert.equal(s.services.interiors.status(TOWN), 'pending');
    const p = s.join(1, { location: 'interior:Daggerfall/Gothway Garden/7,7/7', portal: { returnTo: { location: TOWN, x: 11, z: 0, yaw: 1.5 } } }, { x: 2, z: 3 });
    assert.equal(p.rpg.location, 'interior:Daggerfall/Gothway Garden/7,7/7');
    assert.match(s.runtime.act(p, 'portal.leave', {}).error, /still being surveyed/);
    release();
    await s.services.interiors.survey(TOWN);
    assert.equal(p.rpg.location, TOWN);
    assert.equal(events(s, 1, 'teleport').at(-1).location, TOWN);
  });

  test('a failed save rolls the position back with the location', async () => {
    const s = await session();
    const p = s.join(1);
    s.failSaves(true);
    const r = s.runtime.act(p, 'portal.use', { portalId: 'b:1,2:3' });
    assert.match(r.error, /could not save/);
    assert.equal(p.rpg.location, TOWN);
    s.runtime.tick(0.04);
    assert.deepEqual([p.x, p.z], [10, 0]);
  });

  test('without operator game data doors are refused and stored instances are left', async () => {
    const s = await session({ source: null });
    const p = s.join(1, { location: INSIDE, portal: { returnTo: { location: TOWN, x: 11, z: 0, yaw: 1.5 } } }, { x: 1, z: 1 });
    assert.equal(p.rpg.location, TOWN);
    assert.match(s.runtime.act(p, 'portal.use', { portalId: 'b:1,2:3' }).error, /no game data/);
  });

  test('encounterSites: dungeon markers, none in buildings, null while surveying, chained otherwise', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const s = await session({ awaitReady: false, source: { townPortals: async () => { await gate; return specs(); }, scene: async () => ({}) } });
    assert.equal(s.services.encounterSites(DUNGEON), null);
    assert.equal(s.services.encounterSites(TOWN), undefined);
    release();
    await s.services.interiors.survey(TOWN);
    assert.deepEqual(s.services.encounterSites(DUNGEON).map((e) => e.key), ['S0000999.RDB:0/1', 'S0000999.RDB:0/9']);
    assert.deepEqual(s.services.encounterSites(INSIDE), []);
    assert.deepEqual(s.services.encounterSites('interior:Daggerfall/Gothway Garden/7,7/7'), []);
  });

  test('other features can register portals and transfer players', async () => {
    const s = await session();
    const p = s.join(1, {}, { x: 0, z: 40 });
    s.services.portals.register({
      id: 'q:cellar', from: TOWN, to: 'interior:Daggerfall/Gothway Garden/0,0/9', label: 'Cellar',
      entrances: [{ x: 0, z: 40, enter: { x: 0, z: 0, yaw: 0 }, exit: { x: 0, z: 41, yaw: 0 } }],
      exits: [{ x: 0, z: 0 }],
    });
    assert.deepEqual(s.runtime.act(p, 'portal.use', { portalId: 'q:cellar' }), { ok: true });
    assert.equal(p.rpg.location, 'interior:Daggerfall/Gothway Garden/0,0/9');
  });
});

describe('browser interiors helpers', () => {
  const portals = {
    location: TOWN,
    buildings: [
      { portalId: 'b:1,2:3', target: INSIDE, buildingType: 2, doors: [{ x: 10, y: 1, z: 0, local: [0, 1, 0], enter: { x: 1, y: 1, z: 1, yaw: 0 }, exit: { x: 11, y: 0, z: 0, yaw: 1 } }], exits: [{ x: 0, y: 1, z: 0 }] },
      { portalId: 'b:1,2:4', target: 'interior:Daggerfall/Gothway Garden/1,2/4', buildingType: 17, doors: [{ x: 50, y: 1, z: 0, local: [0, 1, 0], enter: { x: 0, y: 0, z: 0, yaw: 0 }, exit: { x: 0, y: 0, z: 0, yaw: 0 } }], exits: [] },
    ],
    dungeon: { portalId: 'dungeon', target: DUNGEON, name: 'The Hold', blocks: 5, doors: [{ x: -30, y: 0, z: 5, enter: { x: 1, y: 2, z: 3, yaw: 0 }, exit: { x: -31, y: 0, z: 6, yaw: 0 } }], exits: [{ x: 1, y: 2, z: 3 }] },
  };
  test('town doors skip exitless buildings, match the server specs and pick the nearest', () => {
    const doors = townDoors(portals);
    assert.deepEqual(doors.map((d) => [d.portalId, d.label]), [['b:1,2:3', 'Armorer'], ['dungeon', 'The Hold']]);
    assert.deepEqual(portalSpecs(portals).map((s) => s.id), doors.map((d) => d.portalId));
    assert.equal(nearestDoor(doors, 11, 1).portalId, 'b:1,2:3');
    assert.equal(nearestDoor(doors, 15, 0), null);
    assert.deepEqual(sceneExits({ kind: 'dungeon', doors: [{ type: 3, x: 1, y: 2, z: 3 }, { type: 1, x: 0, y: 0, z: 0 }] }), [{ x: 1, y: 2, z: 3, label: 'Leave' }]);
  });

  test('install: doors in reach drive portal.use / portal.leave and instance scenes load through setScene', async () => {
    const listeners = new Map();
    const acts = [];
    const scenes = [];
    const panels = new Map();
    const api = {
      files: [], location: TOWN, town: null, modalOpen: false,
      on(n, fn) { if (!listeners.has(n)) listeners.set(n, []); listeners.get(n).push(fn); },
      emit(n, d) { for (const fn of listeners.get(n) ?? []) fn(d); },
      act(verb, args) { acts.push([verb, args]); return true; },
      message() {}, refreshPanel() {},
      registerPanel(id, title, render) { panels.set(id, { title, render }); return true; },
      async setScene(p, o) { const mesh = await p; scenes.push([o.location, mesh.kind]); api.emit('scene', mesh); return true; },
    };
    const interior = { kind: 'interior', location: INSIDE, name: 'Armorer, Gothway Garden', doors: [{ type: 1, x: 0, y: 1, z: 0 }] };
    installClient(api, { portalsFor: async () => portals, loadScene: async (loc) => { assert.equal(loc, INSIDE); return interior; } });
    assert.equal(panels.get('places').title, 'Places');
    const surveyed = new Promise((r) => api.on('interiors:doors', r));
    api.emit('scene', { name: 'Gothway Garden', region: 'Daggerfall', source: { region: 'Daggerfall', spawnLocal: { x: 0, z: 0 } } });
    const got = await surveyed;
    assert.equal(got.location, TOWN);
    const intent = () => { const d = { handled: false, entity: null, preventDefault() { this.handled = true; } }; api.emit('interactIntent', d); return d.handled; };
    api.emit('frame', { camera: { x: 30, z: 0, yaw: 0 } });
    assert.equal(intent(), false); // nothing in reach
    api.emit('frame', { camera: { x: 10.5, z: 0.5, yaw: 0 } });
    assert.equal(intent(), true);
    assert.deepEqual(acts.at(-1), ['portal.use', { portalId: 'b:1,2:3' }]);
    // An NPC in the crosshair keeps the interact key.
    const d = { handled: false, entity: { id: 'n1', kind: 'npc' }, preventDefault() { this.handled = true; } };
    api.emit('interactIntent', d);
    assert.equal(d.handled, false);
    // The server moved us inside: the scene is requested for that location and the exit becomes usable.
    api.location = INSIDE;
    api.emit('location', { location: INSIDE, previous: TOWN });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(scenes, [[INSIDE, 'interior']]);
    api.emit('frame', { camera: { x: 0.4, z: 0.6, yaw: 0 } });
    assert.equal(intent(), true);
    assert.deepEqual(acts.at(-1), ['portal.leave', {}]);

    // BROWSER HARNESS: a door panel reaches the floor but the authored hinge is near its top.
    api.location = DUNGEON;
    api.emit('scene', {
      kind: 'dungeon', location: DUNGEON, exits: [],
      positions: new Float32Array([0, 25.6, -1, 0, 28.4, -1, 0, 25.6, 1]),
      mechanisms: [{ id: 'top-hinged-door', door: true, x: 0, y: 28.4, z: -1, firstTriangle: 0, triangleCount: 1 }],
    });
    api.emit('frame', { camera: { x: 1.4, y: 27.2, z: 0, yaw: -Math.PI / 2 } });
    assert.equal(intent(), true);
    assert.deepEqual(acts.at(-1), ['dungeon.use', { id: 'top-hinged-door' }]);
    api.emit('frame', { camera: { x: 1.4, y: 24, z: 0, yaw: -Math.PI / 2 } });
    assert.equal(intent(), false, 'a player on a lower floor cannot target the panel');
  });
});
