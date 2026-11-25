// Initial Play loading barrier: the server reports when a place's people are published, and the browser's arrival
// gate (client/lib/arrival.js) holds the loading screen until the scene, the occupants, local collision and their
// sprites are ready. The roster and sprite decode are delayed on purpose so a regression that reveals the world
// before them fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as npcs from '../server/rpg/npcs.js';
import * as quests from '../server/rpg/quests.js';
import { arrivalStatus, crossesDoor, sceneLocation } from '../client/lib/arrival.js';
import { ActorController } from '../client/gameplay/actors.js';
import { createGameplayApi } from '../client/gameplay/api.js';

const INN = 'interior:Daggerfall/Blackidge Hamlet/0,0/10';
const CRYPT = 'dungeon:Daggerfall/Empty Crypt';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const innPeople = Array.from({ length: 8 }, (_, i) => ({
  id: `npc:inn:${i}`, kind: 'npc', name: i === 0 ? 'Innkeeper' : `Patron ${i}`, role: i === 0 ? 'innkeeper' : 'commoner',
  location: INN, x: i, z: 2, yaw: 0, sprite: { archive: 182, record: i % 4 },
}));

function world(jobs) {
  const sent = [];
  const players = new Map();
  const source = {
    tables: { banks: [] },
    interior: (loc) => jobs[loc].promise,
    dungeon: (loc) => jobs[loc].promise,
    town: (loc) => jobs[loc].promise,
    evict() {},
  };
  const runtime = createRpgRuntime({
    players, save() {}, send: (p, msg) => sent.push([p.id, msg]), log: { warn() {}, info() {}, error() {} },
    features: [{ name: 'npcs', install: (ctx) => npcs.install(ctx, { peopleSource: source, statePath: null }) }],
  });
  const join = (id, location) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, rpg: { location } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const last = (id) => sent.filter(([pid, m]) => pid === id && m.type === 'rpg').at(-1)?.[1];
  const step = () => { runtime.tick(0.2); runtime.sync(); };
  return { runtime, join, last, step, sent };
}

test('server: readiness says loading until the occupants are published, then ready in the same snapshot', async () => {
  const jobs = { [INN]: deferred() };
  const w = world(jobs);
  w.join(1, INN);
  w.step();
  let msg = w.last(1);
  assert.equal(msg.readiness.location, INN);
  assert.equal(msg.readiness.npcs.status, 'loading', 'a join must not report an unloaded place as ready');
  assert.equal(msg.entities.filter((e) => e.kind === 'npc').length, 0);
  w.step();
  assert.equal(w.last(1).readiness.npcs.status, 'loading');

  jobs[INN].resolve({ building: { buildingType: 0x0f }, people: innPeople }); // tavern: always open
  await jobs[INN].promise;
  await null;
  w.step();
  msg = w.last(1);
  assert.equal(msg.readiness.npcs.status, 'ready');
  assert.equal(msg.readiness.npcs.people, 8);
  const occupants = msg.entities.filter((e) => e.kind === 'npc');
  assert.equal(occupants.length, 8, 'the ready snapshot carries every occupant');
  assert.equal(occupants.filter((e) => e.role === 'innkeeper').length, 1);
});

test('server: a genuinely empty place is ready with no people; a failed load is reported, not hung', async () => {
  const jobs = { [CRYPT]: deferred(), 'dungeon:Daggerfall/Broken': deferred() };
  const w = world(jobs);
  w.join(1, CRYPT);
  w.join(2, 'dungeon:Daggerfall/Broken');
  w.step();
  assert.equal(w.last(1).readiness.npcs.status, 'loading');
  jobs[CRYPT].resolve({ people: [] });
  jobs['dungeon:Daggerfall/Broken'].reject(new Error('BLOCKS.BSA is missing'));
  await Promise.allSettled([jobs[CRYPT].promise, jobs['dungeon:Daggerfall/Broken'].promise]);
  await null;
  w.step();
  assert.deepEqual(w.last(1).readiness.npcs, { status: 'ready', people: 0 });
  assert.equal(w.last(2).readiness.npcs.status, 'failed');
  assert.match(w.last(2).readiness.npcs.error, /BLOCKS\.BSA/);
});

test('server: a place with no source-backed people (wilderness) does not wait', () => {
  const w = world({});
  w.join(1, 'wilderness:110,150');
  w.step();
  assert.equal(w.last(1).readiness.npcs.status, 'ready');
});

// ------------------------------------------------------------------ browser gate

/** An actor controller whose sprite decode is held until the test releases it. */
function delayedActors(api) {
  const ctl = new ActorController(api, { clock: () => 0 });
  const holds = new Map();
  ctl.library.index = new Map([['TEXTURE.182', {}]]);
  ctl.library.load = function (archive) {
    const d = deferred();
    holds.set(archive, d);
    return d.promise.then((err) => {
      this.pending.delete(archive);
      if (err) { this.failed.set(archive, err); return null; }
      const entry = { archive, sprite: { recordCount: 5, records: [] }, atlas: null };
      this.entries.set(archive, entry);
      return entry;
    });
  };
  api.actors = ctl.publicApi();
  api.on('state', (s) => ctl.syncState(s));
  return { ctl, holds };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('browser: the gate waits for the right scene, the server roster, collision and occupant sprites', async () => {
  const api = createGameplayApi({});
  const { holds } = delayedActors(api);
  let collision = 'loading';
  api.collisionLocal = () => collision;
  const defaultTown = { source: { townId: 'town:Daggerfall/Gothway Garden', region: 'Daggerfall' }, name: 'Gothway Garden' };
  const inn = { kind: 'interior', location: INN };

  // Joined: the character is in the inn, the shell still holds its bootstrap town, people are loading.
  api._receiveRpg({ character: { location: INN }, entities: [], peers: [], readiness: { location: INN, npcs: { status: 'loading' } } });
  let st = arrivalStatus(api, { scene: defaultTown });
  assert.equal(st.ready, false);
  assert.equal(st.parts.scene, 'loading', 'another place on screen is not this place');
  assert.equal(st.parts.people.status, 'loading');

  // The inn mesh arrives before its people (out of order): still held.
  st = arrivalStatus(api, { scene: inn });
  assert.equal(st.parts.scene, 'ready');
  assert.equal(st.ready, false);
  assert.deepEqual(st.waiting.includes('Gathering the people here…'), true);

  // A stale readiness for some other place does not count.
  api._receiveRpg({ readiness: { location: 'town:Daggerfall/Gothway Garden', npcs: { status: 'ready', people: 3 } } });
  assert.equal(arrivalStatus(api, { scene: inn }).parts.people.status, 'loading');

  // The roster is published; sprite decode is still held.
  api._receiveRpg({ entities: innPeople, readiness: { location: INN, npcs: { status: 'ready', people: 8 } } });
  collision = 'ready';
  st = arrivalStatus(api, { scene: inn, at: { x: 0, z: 0 } });
  assert.equal(st.parts.people.status, 'ready');
  assert.equal(st.parts.sprites.actors, 8);
  assert.equal(st.parts.sprites.pending, 1);
  assert.equal(st.ready, false, 'occupants without decoded sprites would be invisible on the first frame');
  assert.ok(holds.has(182), 'the gate starts the decode itself');

  holds.get(182).resolve(null);
  await flush();
  st = arrivalStatus(api, { scene: inn, at: { x: 0, z: 0 } });
  assert.equal(st.ready, true);
  assert.deepEqual(st.warnings, []);
});

test('a distant resident’s distinct sprite archive holds the initial reveal', async () => {
  const api = createGameplayApi({});
  const { holds } = delayedActors(api);
  const town = 'town:Daggerfall/Daggerfall';
  const near = { ...innPeople[0], location: town };
  const far = { ...innPeople[1], location: town, x: 330, sprite: { archive: 184, record: 1 } };
  api._receiveRpg({ character: { location: town }, entities: [near, far], readiness: { location: town, npcs: { status: 'ready', people: 2 } } });
  const status = () => arrivalStatus(api, { scene: { location: town }, at: { x: 0, z: 0 } });
  assert.equal(status().parts.sprites.archives, 2);
  holds.get(182).resolve(null);
  await flush();
  assert.equal(status().ready, false);
  holds.get(184).resolve(null);
  await flush();
  assert.equal(status().ready, true);
});

test('browser: local collision still building holds the reveal', () => {
  const api = createGameplayApi({});
  let collision = 'loading';
  api.collisionLocal = () => collision;
  api._receiveRpg({ character: { location: CRYPT }, entities: [], readiness: { location: CRYPT, npcs: { status: 'ready', people: 0 } } });
  const crypt = { kind: 'dungeon', location: CRYPT };
  assert.equal(arrivalStatus(api, { scene: crypt }).ready, false);
  collision = 'ready';
  const st = arrivalStatus(api, { scene: crypt });
  assert.equal(st.ready, true, 'a genuinely empty place is revealed without waiting for anyone');
  assert.deepEqual(st.parts.people, { status: 'ready', people: 0 });
});

test('browser: a failed required part stops entry with its reason; nothing is shown partially', async () => {
  const inn = { kind: 'interior', location: INN };
  // The scene could not be built for this location.
  let api = createGameplayApi({});
  api._receiveRpg({ character: { location: INN }, entities: [], readiness: { location: INN, npcs: { status: 'loading' } } });
  let st = arrivalStatus(api, { scene: null, sceneError: { location: INN, message: 'BLOCKS.BSA is not in the selected folder' } });
  assert.equal(st.ready, false);
  assert.equal(st.failed.part, 'scene');
  assert.match(st.failed.message, /BLOCKS\.BSA/);
  // A stale scene error for somewhere else is ignored.
  assert.equal(arrivalStatus(api, { scene: null, sceneError: { location: CRYPT, message: 'x' } }).failed, null);

  // The server could not load the people.
  api._receiveRpg({ readiness: { location: INN, npcs: { status: 'failed', error: 'no BLOCKS.BSA on the server' } } });
  st = arrivalStatus(api, { scene: inn });
  assert.equal(st.ready, false);
  assert.equal(st.failed.part, 'people');

  // Combat (authored enemies) still placing: wait; failed: stop.
  api._receiveRpg({ readiness: { location: INN, npcs: { status: 'ready', people: 0 }, combat: { status: 'loading' } } });
  st = arrivalStatus(api, { scene: inn });
  assert.equal(st.ready, false);
  assert.ok(st.waiting.includes('Placing the creatures here…'));
  api._receiveRpg({ readiness: { location: INN, npcs: { status: 'ready', people: 0 }, combat: { status: 'failed', error: 'no markers' } } });
  assert.equal(arrivalStatus(api, { scene: inn }).failed.part, 'combat');

  // Local collision failed.
  api._receiveRpg({ readiness: { location: INN, npcs: { status: 'ready', people: 0 }, combat: { status: 'ready', monsters: 0 } } });
  api.collisionLocal = () => 'failed';
  assert.equal(arrivalStatus(api, { scene: inn }).failed.part, 'collision');

  // An occupant's sprite file is missing: entry stops and names the file.
  api = createGameplayApi({});
  const { holds } = delayedActors(api);
  api.collisionLocal = () => 'ready';
  api._receiveRpg({ character: { location: INN }, entities: innPeople, readiness: { location: INN, npcs: { status: 'ready', people: 8 } } });
  assert.equal(arrivalStatus(api, { scene: inn }).ready, false);
  holds.get(182).resolve('TEXTURE.182 is not in the selected folder');
  await flush();
  st = arrivalStatus(api, { scene: inn });
  assert.equal(st.ready, false);
  assert.equal(st.failed.part, 'sprites');
  assert.match(st.failed.message, /TEXTURE\.182/);

  // Town scenery failed.
  api = createGameplayApi({});
  const town = { source: { townId: 'town:Daggerfall/Gothway Garden', region: 'Daggerfall' }, name: 'Gothway Garden' };
  api._receiveRpg({ character: { location: 'town:Daggerfall/Gothway Garden' }, entities: [], readiness: { location: 'town:Daggerfall/Gothway Garden', npcs: { status: 'ready', people: 0 } } });
  api.scenery = { status: 'failed', town, error: new Error('SKY01.DAT is missing') };
  assert.equal(arrivalStatus(api, { scene: town }).failed.part, 'scenery');
  api.scenery = { status: 'loading', town, error: null };
  assert.equal(arrivalStatus(api, { scene: town }).ready, false);
});

test('server: a rejoin retries a place whose people failed to load', async () => {
  let attempt = 0;
  const jobs = {};
  const w = world(new Proxy(jobs, { get: (_, loc) => {
    attempt++;
    return attempt === 1 ? { promise: Promise.reject(new Error('transient read error')) } : { promise: Promise.resolve({ people: [] }) };
  } }));
  const p = w.join(1, CRYPT);
  await null; await null;
  w.step();
  assert.equal(w.last(1).readiness.npcs.status, 'failed');
  // Ticks alone do not hammer a failed place.
  w.step();
  assert.equal(attempt, 1);
  // Try again: the client leaves and joins again.
  w.runtime.leave(p);
  w.runtime.ctx.players.delete(1);
  w.join(1, CRYPT);
  await null; await null;
  w.step();
  assert.equal(attempt, 2);
  assert.deepEqual(w.last(1).readiness.npcs, { status: 'ready', people: 0 });
});

test('server: readiness providers are generic and isolated', () => {
  const players = new Map();
  const sent = [];
  let combat = 'loading';
  const runtime = createRpgRuntime({
    players, save() {}, send: (p, m) => sent.push(m), log: { warn() {}, info() {}, error() {} },
    features: [
      { name: 'combat', install: (ctx) => ctx.readiness('combat', () => ({ status: combat })) },
      { name: 'broken', install: (ctx) => ctx.readiness('broken', () => { throw new Error('boom'); }) },
    ],
  });
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { location: CRYPT } };
  players.set(1, p);
  runtime.join(p);
  runtime.sync();
  assert.deepEqual(sent.at(-1).readiness, { location: CRYPT, combat: { status: 'loading' }, broken: { status: 'failed', error: 'boom' } });
  combat = 'ready';
  runtime.sync();
  assert.equal(sent.at(-1).readiness.combat.status, 'ready', 'a readiness change alone resends the snapshot');
});

test('a saved quest contact holds only its owner’s arrival until the marker is read and the person is published', async () => {
  const town = 'town:Daggerfall/Blackidge Hamlet';
  const saved = {
    uid: 'quest-1', name: 'saved-quest', title: 'A visitor', people: { contact: { name: 'Visitor', location: town, place: 'inn' } },
    places: { inn: { location: town, interior: INN } }, items: {}, foes: {},
  };
  let request = deferred();
  const players = new Map();
  const latest = new Map();
  const runtime = createRpgRuntime({
    players, save() {}, send(p, m) { if (m.type === 'rpg') latest.set(p.id, m); },
    features: [{ name: 'quests', install(ctx) {
      ctx.services.npcs = { questSpawn: () => request.promise };
      quests.install(ctx, { catalog: { quests: new Map() } });
    } }],
  });
  const owner = { id: 1, rpg: { location: INN, quests: { v: 1, active: [saved] } } };
  const visitor = { id: 2, rpg: { location: INN } };
  for (const p of [owner, visitor]) {
    players.set(p.id, p);
    runtime.join(p);
  }
  runtime.sync();
  assert.equal(latest.get(1).readiness.quests.status, 'loading');
  assert.equal(latest.get(2).readiness.quests, undefined);
  const api = createGameplayApi({});
  api._receiveRpg(latest.get(1));
  assert.ok(arrivalStatus(api, { scene: { location: INN } }).waiting.some(line => line.includes('journal')));

  request.reject(new Error('quest marker data unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  runtime.tick(1);
  runtime.sync();
  assert.equal(latest.get(1).readiness.quests.status, 'failed');
  runtime.leave(owner);
  request = deferred();
  runtime.join(owner);
  runtime.sync();
  assert.equal(latest.get(1).readiness.quests.status, 'loading');
  request.resolve([{ key: 'upstairs', x: 1, floor: 3.2, z: -2 }]);
  await new Promise(resolve => setImmediate(resolve));
  runtime.sync();
  assert.equal(latest.get(1).readiness.quests.status, 'loading', 'the marker is read but the person is still unpublished');
  runtime.tick(1);
  runtime.sync();
  assert.equal(latest.get(1).readiness.quests, undefined);
  assert.equal(latest.get(1).entities.find(e => e.name === 'Visitor')?.y, 3.2);
  assert.deepEqual(latest.get(2).entities, []);
});

test('browser: servers without readiness and scene ids from every scene owner', () => {
  const api = createGameplayApi({});
  api._receiveRpg({ character: { location: 'town:Daggerfall/Gothway Garden' }, entities: [] });
  const town = { source: { townId: 'town:Daggerfall/Gothway Garden', region: 'Daggerfall' }, name: 'Gothway Garden' };
  assert.equal(arrivalStatus(api, { scene: town }).ready, true);
  assert.equal(arrivalStatus(api, { scene: town, requireRoster: true }).failed.part, 'people');
  api._receiveRpg({ readiness: { location: town.source.townId, npcs: { status: 'ready', people: 0 } } });
  assert.equal(arrivalStatus(api, { scene: town, requireRoster: true }).ready, false, 'enemy placement has not been reported');
  api._receiveRpg({ readiness: { location: town.source.townId, npcs: { status: 'ready', people: 0 }, combat: { status: 'ready', monsters: 0 } } });
  assert.equal(arrivalStatus(api, { scene: town, requireRoster: true }).ready, true, 'the server confirmed this town is empty');
  assert.equal(sceneLocation({ kind: 'wilderness', location: 'wilderness:1,2' }), 'wilderness:1,2');
  assert.equal(sceneLocation({ name: 'Old Town', region: 'Daggerfall' }), 'town:Daggerfall/Old Town');
  assert.equal(sceneLocation(null), null);
  // No state yet: waiting for the server.
  assert.equal(arrivalStatus(createGameplayApi({}), { scene: town }).ready, false);
});

test('door transfers wait for their destination mesh in both directions, including two different rooms', () => {
  const town = { source: { townId: 'town:Daggerfall/Gothway Garden' } };
  const room = { location: 'interior:Daggerfall/Gothway Garden/3,0/15' };
  const farm = { location: 'interior:wod:110,159:107,54/0/0' };
  assert.equal(crossesDoor(town.source.townId, room.location), true);
  assert.equal(crossesDoor(room.location, town.source.townId), true);
  assert.equal(crossesDoor(room.location, 'dungeon:Wrothgarian Mountains/Shedungent'), true);
  assert.equal(crossesDoor(farm.location, 'wilderness:110,159'), true);
  assert.equal(crossesDoor(room.location, room.location), false);
  assert.equal(crossesDoor(town.source.townId, 'wilderness:109,159'), false);
});

test('outdoor arrival also waits for the surrounding landscape, and reports a failed build', () => {
  const location = 'town:Daggerfall/Gothway Garden';
  const scene = { source: { townId: location } };
  const api = createGameplayApi({});
  api._receiveRpg({ character: { location }, entities: [] });
  let status = 'loading';
  api.exterior = { arrival: (id) => {
    assert.equal(id, location);
    return { status, error: 'The landscape file could not be read' };
  } };
  assert.equal(arrivalStatus(api, { scene }).ready, false);
  status = 'failed';
  assert.deepEqual(arrivalStatus(api, { scene }).failed, { part: 'exterior', message: 'The landscape file could not be read' });
  status = 'ready';
  assert.equal(arrivalStatus(api, { scene }).ready, true);
});
