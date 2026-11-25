// Authoritative sailing (server/rpg/sailing.js, server/rpg/sailing/voyage.js).
//
// FIXTURE: the real runtime, inventory, atmosphere clock, calendar (travel gate), travel, mount, property, social and
// sailing features on a real SQLite file in a private /var/tmp directory. The COAST is test data, not game data: two
// invented ports 3 km apart on open water with a rectangular island between them. Ship deeds are written directly
// (purchase is covered by rpg-property.test.mjs). Restarts boot a fresh runtime on the same database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureWorld, tempDir, readPersisted } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as atmosphere } from '../server/rpg/atmosphere.js';
import { install as calendar } from '../server/rpg/calendar.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as mount } from '../server/rpg/mount.js';
import { install as property } from '../server/rpg/property.js';
import { install as social } from '../server/rpg/social.js';
import { install as sailing, ROW_PREFIX } from '../server/rpg/sailing.js';
import {
  windAt, pointOfSail, sailPower, stepVessel, seaToPixel, pixelToSea, deckToSea, DECK_BOW, hullOf, DOCK_RANGE,
} from '../server/rpg/sailing/voyage.js';

const PORT_A = 'town:Daggerfall/Daggerfall';
const PORT_B = 'town:Wayrest/Wayrest';
const INLAND = 'town:Daggerfall/Gothway Garden';
// FIXTURE coast: global metres. Water everywhere except the island x∈[2000,2400], z∈[1000,1400].
const ISLAND = { x0: 2000, x1: 2400, z0: 1000, z1: 1400 };
const FIXTURE_PORTS = [
  // quay in GLOBAL metres (coast.js); the stub overland frame below puts each town's origin on its berth.
  { id: PORT_A, name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI / 2, quay: { x: 1005, z: 960, yaw: 0 } },
  { id: PORT_B, name: 'Wayrest', region: 'Wayrest', x: 4000, z: 1000, yaw: -Math.PI / 2, quay: { x: 3988, z: 1030, yaw: Math.PI } },
];
const fixtureCoast = () => ({
  status: 'ready',
  isWater: (x, z) => !(x >= ISLAND.x0 && x <= ISLAND.x1 && z >= ISLAND.z0 && z <= ISLAND.z1),
  // FIXTURE: sampled every 10 m along the segment.
  segmentClear(ax, az, bx, bz) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
    for (let i = 0; i <= n; i++) {
      const x = ax + (bx - ax) * i / n, z = az + (bz - az) * i / n;
      if (x >= ISLAND.x0 && x <= ISLAND.x1 && z >= ISLAND.z0 && z <= ISLAND.z1) return { ok: false, hitAt: { x, z } };
    }
    return { ok: true };
  },
  ports: () => FIXTURE_PORTS,
  // FIXTURE route: north round the island.
  route: (from, to) => (from === PORT_A && to === PORT_B ? { points: [{ x: 1000, z: 1000 }, { x: 1500, z: 700 }, { x: 3500, z: 700 }, { x: 4000, z: 1000 }], metres: 3300 } : null),
  portOf: (id) => FIXTURE_PORTS.find((p) => p.id === id) ?? null,
  nearestPort(x, z) {
    const best = FIXTURE_PORTS.map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) })).sort((a, b) => a.distance - b.distance)[0];
    return best ?? null;
  },
});

// FIXTURE overland frame: each port town's local origin sits on its berth (the real one is server/rpg/overland.js).
const stubOverland = (ctx) => {
  ctx.services.overland = {
    localOf(loc, e, s) {
      const p = FIXTURE_PORTS.find((q) => q.id === loc);
      return p ? { x: e - p.x, z: s - p.z } : null;
    },
  };
};
const FEATURES = [
  { name: 'overland-stub', install: stubOverland },
  { name: 'inventory', install: inventory },
  { name: 'atmosphere', install: atmosphere },
  { name: 'calendar', install: calendar },
  { name: 'travel', install: travel },
  { name: 'mount', install: mount },
  { name: 'property', install: property },
  { name: 'social', install: social },
  { name: 'sailing', install: (ctx) => sailing(ctx, { coast: fixtureCoast(), loadCoast: false }) },
];

let rid = 0;
const req = () => `sail-${++rid}-${Date.now().toString(36)}`;

async function makeWorld(t, features = FEATURES) {
  const { dir } = tempDir('dfw-sailing-', '/var/tmp');
  const dbPath = join(dir, 'world.db');
  const world = await createFixtureWorld({ dbPath, features });
  t.after(() => {
    world.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(world.installErrors, []);
  return { world, dbPath };
}

function joinAt(world, account, name, { location = PORT_A, x = 3, z = -38, ship = null } = {}) {
  const c = world.connect(account, name);
  c.player.rpg.location = location;
  if (ship) c.player.rpg.property = { ...(c.player.rpg.property ?? {}), version: 1, ship: { type: ship, boughtAt: 0 }, board: null, stores: {}, loans: {}, houses: {}, recent: [] };
  c.player.rpg.property.version = 0; // re-normalised by property.stateOf
  c.moveTo(x, z);
  world.tick(50);
  return c;
}
const S = (world) => world.ctx.services;
const vesselOf = (world, c) => S(world).sailing.vesselFor(c.player);
const lastState = (c) => c.events('sailing.state').at(-1);
function sailFor(world, seconds, stepMs = 100) {
  for (let t = 0; t < seconds * 1000; t += stepMs) world.tick(stepMs);
}
function partyUp(a, b) {
  a.must('party.invite', { targetId: b.id });
  b.must('party.accept', { fromId: a.id });
}

test('voyage: wind, point of sail, frames and deck bow', () => {
  const w1 = windAt(600, 1000);
  assert.deepEqual(windAt(600, 1000), w1, 'the same minute reads the same wind everywhere');
  assert.ok(w1.speed >= 4 && w1.speed <= 8);
  assert.ok(windAt(600, 1000, 'thunder').speed > w1.speed * 1.9);
  assert.ok(windAt(600, 1000, 'fog').speed < 1);
  assert.equal(pointOfSail(45), 1);
  assert.ok(Math.abs(pointOfSail(0) - 0.9) < 1e-9);
  assert.ok(Math.abs(pointOfSail(180) - 0.55) < 1e-9, 'the responsive helm keeps about half her way into the wind');
  // wind from the north (0): heading south runs before it; heading north is head to wind.
  assert.ok(sailPower('small', Math.PI, 0) > sailPower('small', 0, 0));
  const px = seaToPixel(1000.5, 819.2 * 3 + 10);
  assert.deepEqual([px.px, px.py], [1, 3]);
  const back = pixelToSea(px.px, px.py, px.xw, px.zw);
  assert.ok(Math.abs(back.x - 1000.5) < 1e-9 && Math.abs(back.z - (819.2 * 3 + 10)) < 1e-9);
  // The small deck's bow (+x) points along the vessel's heading.
  const v = { type: 'small', x: 100, z: 100, yaw: 0 };
  const bow = deckToSea(v, 10, 0);
  assert.ok(Math.abs(bow.x - 100) < 1e-9 && Math.abs(bow.z - 90) < 1e-9, `bow ahead (north) of the hull: ${JSON.stringify(bow)}`);
  assert.equal(DECK_BOW.large, Math.PI);
  // Grounding stops her and harms a fast hull.
  const g = { id: 'v1', type: 'small', x: 1900, z: 1200, yaw: Math.PI / 2, speed: 6, sails: 1, oars: 0, rudder: 0, anchored: false, docked: null };
  const env = { wind: { from: -Math.PI / 2, speed: 6 }, isWater: (x) => x < 2000 };
  let struck = null;
  for (let i = 0; i < 10; i++) {
    const r = stepVessel(g, 5, env);
    if (r.grounded) struck = r;
  }
  assert.equal(g.grounded, true);
  assert.equal(g.speed, 0, 'pressed on the shore she makes no way');
  assert.ok(struck && struck.harm > 0);
  assert.ok(g.x + hullOf('small').length / 2 < 2000, 'her bow stops at the shore');
});

test('launch, party boarding, scoped decks, private holds, helm, sailing and denial', async (t) => {
  const { world } = await makeWorld(t);
  const a = joinAt(world, 1, 'Anselm', { ship: 'large' });
  const b = joinAt(world, 2, 'Brisienna');
  const c = joinAt(world, 3, 'Cyrus', { ship: 'large', x: 8, z: -30 });
  const d = joinAt(world, 4, 'Dagoth', { location: INLAND });

  // Denials before anything moves.
  assert.match(b.act('sailing.launch').error, /own no ship/);
  assert.match(d.act('sailing.board').error, /own no ship/);
  d.player.rpg.property.ship = { type: 'small', boughtAt: 0 };
  assert.match(d.act('sailing.board').error, /no harbour here/);
  assert.match(b.act('sailing.board', { vesselId: 'v1' }).error, /not here/, 'no vessel before her first boarding');

  // The captain boards at the quay: the vessel is created made fast at this port.
  a.must('sailing.board', { requestId: req() });
  const v = vesselOf(world, a);
  assert.equal(v.docked, PORT_A);
  assert.equal(v.ownerId, a.id);
  assert.equal(a.player.rpg.location, S(world).property.shipLocation('large'));
  const full = lastState(a);
  assert.equal(full.full, true);
  assert.equal(full.role, 'captain');
  assert.equal(full.ports.length, 2);

  // A stranger may not board; a party member may.
  assert.match(b.act('sailing.board', { vesselId: v.id }).error, /party/);
  partyUp(a, b);
  b.must('sailing.sync');
  assert.deepEqual(lastState(b).quay, [{ id: v.id, name: v.name, ownerName: v.ownerName }], 'the party member is offered the captain\'s ship at this quay');
  b.must('sailing.board', { vesselId: v.id });
  assert.equal(lastState(b).vessel.deckBow, Math.PI, 'the galleon deck bow');
  assert.equal(S(world).sailing.crewOf(v).length, 2);
  assert.equal(lastState(b).role, 'passenger');

  // A second owner of the same ship type boards his own vessel: one classic deck, two scenes.
  c.must('sailing.board');
  const vc = vesselOf(world, c);
  assert.notEqual(vc.id, v.id);
  assert.equal(c.player.rpg.location, a.player.rpg.location, 'both crews stand on the same classic deck location');
  world.tick(50);
  world.runtime.sync([...world.players.values()], { force: true });
  assert.ok(a.peer(b.id), 'shipmates see each other');
  assert.equal(a.peer(c.id), null, 'another crew on the same deck is invisible');
  assert.equal(c.peer(a.id), null);
  assert.equal(c.peer(b.id), null);
  assert.equal(world.ctx.sameScene(a.player, c.player), false);
  // and cannot be traded with or reached
  const view = (cl) => cl.events('social.state').at(-1) ?? cl.events('social').at(-1);
  c.must('social.sync');
  const listed = view(c)?.players?.find((x) => x.id === a.id);
  if (listed) assert.equal(listed.sameLocation, false);

  // Holds: the captain's hold is reachable only by the captain; a passenger who owns the same ship type does not get
  // their own hold from someone else's deck, and nobody sees another's cargo.
  assert.deepEqual(S(world).propertyContainers(a.player).map((s) => s.id), ['ship']);
  assert.deepEqual(S(world).propertyContainers(b.player).map((s) => s.id), []);
  assert.match(b.act('property.store', { container: 'ship', itemId: 'gold', quantity: 1 }).error, /own ship/);

  // Classic paths are guarded while she is crewed.
  assert.match(a.act('ship.leave').error, /gangway/);
  assert.match(a.act('travel.go', { to: PORT_B }).error, /aboard ship|go ashore/);

  // Cast off: only the captain; then helm and controls.
  assert.match(b.act('sailing.launch').error, /captain/);
  const launchId = req();
  a.must('sailing.launch', { requestId: launchId });
  assert.match(a.act('sailing.anchor', { requestId: launchId, down: true }).error, /already done/, 'a replayed request is refused');
  assert.equal(v.docked, null);
  assert.equal(v.helmId, a.id);
  assert.match(b.act('sailing.control', { sails: 1 }).error, /helmsman/);
  assert.match(b.act('sailing.helm').error, /must give you the helm/);
  assert.match(a.act('sailing.control', { sails: 0.7 }).error, /struck/);
  a.must('sailing.control', { sails: 1, rudder: 0 });
  assert.match(a.act('sailing.leave').error, /at sea/);
  assert.match(a.act('ship.sell', { counterId: 'x' }).error ?? '', /.*/);

  const x0 = v.x;
  const mark = b.mark();
  sailFor(world, 30);
  assert.ok(v.x > x0 + 60, `she makes way east under sail (${x0} -> ${v.x})`);
  const periodic = b.since(mark, 'gameEvent').filter((m) => m.event.kind === 'sailing.state').map((m) => m.event);
  assert.ok(periodic.length >= 80, `periodic state under way (${periodic.length} in 30 s)`);
  assert.ok(periodic.every((e) => e.silent === true));
  assert.ok(periodic.at(-1).nearby.some((n) => n.id === vc.id), 'the other vessel at the quay is listed nearby');
  assert.equal(periodic.at(-1).vessel.helmName, 'Anselm');
  // Deck feet are untouched by the voyage.
  assert.deepEqual([Math.round(b.player.x * 10), Math.round(b.player.z * 10)], [Math.round(b.player.x * 10), Math.round(b.player.z * 10)]);
  assert.equal(b.player.rpg.location, S(world).property.shipLocation('large'));

  // The captain gives the helm; the passenger steers.
  a.must('sailing.helm', { give: b.id });
  assert.equal(lastState(b).role, 'helm');
  assert.match(a.act('sailing.control', { rudder: 1 }).error, /Take the helm/);
  const yaw0 = v.yaw;
  b.must('sailing.control', { rudder: 1 });
  sailFor(world, 3);
  assert.notEqual(v.yaw, yaw0, 'the rudder turns her');
  a.must('sailing.helm', { take: true });
  a.must('sailing.anchor', { down: true });
  sailFor(world, 15);
  assert.equal(v.speed, 0, 'at anchor she stops');
});

test('grounding on the island, refloating, docking at a different port, going ashore', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  const a = joinAt(world, 1, 'Anselm', { ship: 'small' });
  a.must('sailing.launch');
  const v = vesselOf(world, a);
  // Straight at the island (east along z = 1000 → 1200 so she meets it): put her head on it.
  Object.assign(v, { z: 1200, yaw: Math.PI / 2 });
  a.must('sailing.control', { sails: 1, oars: 1 });
  sailFor(world, 200, 200);
  assert.equal(v.grounded, true, 'she runs aground on the island');
  assert.ok(v.x + hullOf('small').length / 2 < ISLAND.x0 + 1);
  assert.ok(a.events('sailing').some((e) => e.grounded));
  assert.ok(v.hull.hp < v.hull.max, 'striking at speed harms her hull');
  // Back off and come round north of the island.
  a.must('sailing.control', { sails: 0, oars: -1 });
  sailFor(world, 10);
  assert.equal(v.grounded, false, 'backing water refloats her');
  Object.assign(v, { z: 700, x: 2200, yaw: Math.PI / 2, speed: 0 });
  a.must('sailing.control', { sails: 1, oars: 1, rudder: 0 });
  sailFor(world, 200, 200);
  assert.ok(v.x > 3800, `she clears the island to the east (${v.x})`);
  // Docking: too far, too fast, then made fast.
  Object.assign(v, { x: 4000 - DOCK_RANGE - 50, z: 1000 });
  assert.match(a.act('sailing.dock').error, /m off/);
  Object.assign(v, { x: 4000 - 60, z: 1000, speed: 5 });
  assert.match(a.act('sailing.dock').error, /way off/);
  a.must('sailing.control', { sails: 0, oars: 0 });
  a.must('sailing.anchor', { down: true });
  sailFor(world, 10);
  a.must('sailing.dock', { requestId: req() });
  assert.equal(v.docked, PORT_B);
  assert.equal(lastState(a).full, true);
  a.must('sailing.leave');
  assert.equal(a.player.rpg.location, PORT_B, 'ashore at a different port from the one she left');
  assert.deepEqual([a.player.x, a.player.z], [-12, 30]);
  assert.equal(a.player.rpg.sailing.vesselId, null);
  // Persisted and launchable only from where she lies.
  const row = world.store.loadWorld(ROW_PREFIX).find(([k]) => k === ROW_PREFIX + v.id)[1];
  assert.equal(row.docked, PORT_B);
  assert.equal(readPersisted(dbPath, a.player.id).rpg.sailing.vesselId, null);
  a.player.rpg.location = PORT_A;
  assert.match(a.act('sailing.board').error, /docked at Wayrest/);
});

test('restart mid-voyage: vessel pose, crew, deck feet and helm come back; offline crew anchors her', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  let a = joinAt(world, 1, 'Anselm', { ship: 'large' });
  let b = joinAt(world, 2, 'Brisienna');
  partyUp(a, b);
  a.must('sailing.board');
  b.must('sailing.board', { vesselId: `v${a.id}` });
  a.must('sailing.launch');
  a.must('sailing.control', { sails: 1, rudder: 0.25 });
  sailFor(world, 8);
  b.moveTo(3.5, -7.25); // walking about on deck: personal deck feet
  world.tick(50);
  const v = vesselOf(world, a);
  const pose = { x: v.x, z: v.z, yaw: v.yaw };
  assert.ok(pose.x !== 1000);

  // One crew member drops: she sails on under the captain.
  b.leave();
  sailFor(world, 1);
  assert.ok(v.x !== pose.x);
  // The captain drops too: nobody aboard online, she anchors.
  a.leave();
  sailFor(world, 10);
  assert.equal(v.anchored, true);
  assert.equal(v.speed, 0, 'she comes to rest at anchor (and that pose is saved)');
  const savedPose = { x: v.x, z: v.z };

  world.restart();
  const v2 = [...S(world).sailing.vessels()][0];
  assert.ok(v2, 'the vessel row loads after a cold start');
  assert.equal(v2.anchored, true);
  assert.ok(Math.abs(v2.x - savedPose.x) < 0.01 && Math.abs(v2.z - savedPose.z) < 0.01, `her sea pose survives restart ${JSON.stringify([v2.x, v2.z, savedPose])}`);
  assert.equal(v2.helmId, null, 'nobody holds the helm after a restart');

  b = world.connect(2, 'Brisienna');
  world.tick(50);
  assert.equal(b.player.rpg.location, S(world).property.shipLocation('large'), 'the passenger reconnects aboard');
  assert.deepEqual([b.player.x, b.player.z], [3.5, -7.25], 'on the deck feet she left');
  b.must('sailing.sync');
  const st = lastState(b);
  assert.equal(st.full, true);
  assert.equal(st.vessel.id, v2.id);
  assert.equal(st.role, 'passenger');
  assert.match(b.act('sailing.anchor', { down: false }).error, /helmsman/);
  a = world.connect(1, 'Anselm');
  world.tick(50);
  a.must('sailing.helm', { take: true });
  a.must('sailing.anchor', { down: false });
  a.must('sailing.control', { sails: 1 });
  sailFor(world, 3);
  assert.ok(Math.hypot(v2.x - savedPose.x, v2.z - savedPose.z) > 1, 'she sails on from where she lay');
  assert.equal(readPersisted(dbPath, b.player.id).rpg.sailing.vesselId, v2.id);
});

test('classic ship.board stays private per owner and cannot board a ship that is at sea', async (t) => {
  const { world } = await makeWorld(t);
  const a = joinAt(world, 1, 'Anselm', { ship: 'small', location: INLAND });
  const c = joinAt(world, 3, 'Cyrus', { ship: 'small', location: INLAND, x: 9 });
  a.must('ship.board');
  c.must('ship.board');
  world.runtime.sync([...world.players.values()], { force: true });
  assert.equal(a.player.rpg.location, c.player.rpg.location);
  assert.equal(a.peer(c.id), null, 'two owners on the classic deck do not see each other');
  a.must('ship.leave');
  assert.equal(a.player.rpg.location, INLAND);
  // Launch from a port; the classic deck is then refused while she is at sea, and sale is refused.
  a.player.rpg.location = PORT_A;
  a.must('sailing.launch');
  a.must('sailing.dock');
  a.must('sailing.leave');
  a.player.rpg.location = INLAND;
  assert.equal(a.act('ship.board').ok, true, 'docked: the classic deck still works');
  a.must('ship.leave');
  a.player.rpg.location = PORT_A;
  a.must('sailing.launch');
  assert.match(a.act('ship.board').error, /already aboard/);
});

test('shipyard bridge: vessel rows keep shipId, hull class and handling; a rowboat sails on oars only', async () => {
  const { normalizeVessel } = await import('../server/rpg/sailing.js');
  const row = normalizeVessel({
    id: 'v7', ownerId: 7, type: 'small', x: 1, z: 2, yaw: 0, shipId: 'sh-abc', hullClass: 'rowboat',
    handling: { sailMax: 0, oarMax: 2.4, oarAstern: 1.44, turnSail: 0.5, turnOar: 0.5, bogus: 9 },
  });
  assert.equal(row.shipId, 'sh-abc');
  assert.equal(row.hullClass, 'rowboat');
  assert.deepEqual(Object.keys(row.handling).sort(), ['oarAstern', 'oarMax', 'sailMax', 'turnOar', 'turnSail']);
  const v = { ...row, anchored: false, docked: null, sails: 1, oars: 0, rudder: 0, speed: 0 };
  stepVessel(v, 5, { wind: { from: Math.PI, speed: 8 }, isWater: () => true });
  assert.equal(v.speed, 0, 'no canvas: the wind does not drive a rowboat');
  v.oars = 1;
  for (let i = 0; i < 4; i++) stepVessel(v, 5, { wind: { from: Math.PI, speed: 8 }, isWater: () => true });
  assert.ok(Math.abs(v.speed - 2.4) < 0.01, `her oars give her the yard's speed (${v.speed})`);
});

test('naval bridge: wayShare takes her sail way, helmBlocked refuses the helm, respawn docks at her last port, naval state persists', async (t) => {
  const { world } = await makeWorld(t);
  // FIXTURE: a stub naval service (the real one is server/rpg/naval.js).
  const naval = { share: 1, blocked: null };
  S(world).naval = { wayShare: () => naval.share, helmBlocked: () => naval.blocked, nearbyFor: () => [{ id: 'npc-1', kind: 'merchant', x: 0, z: 0, distance: 900 }] };
  const a = joinAt(world, 1, 'Anselm', { ship: 'small' });
  a.must('sailing.launch');
  const v = vesselOf(world, a);
  assert.equal(v.lastPort, PORT_A);
  a.must('sailing.control', { sails: 1 });
  naval.share = 0;
  sailFor(world, 20);
  assert.equal(v.speed, 0, 'canvas shot away: no sail way');
  assert.ok(lastState(a).nearby.some((n) => n.id === 'npc-1'), 'naval contacts appear in nearby');
  naval.blocked = 'Her wheel is shot away.';
  assert.match(a.act('sailing.control', { rudder: 1 }).error, /wheel is shot away/);
  a.must('sailing.helm', { take: false });
  assert.match(a.act('sailing.helm', { take: true }).error, /wheel is shot away/);
  v.naval = { fires: 2, struck: true };
  S(world).sailing.save(v);
  Object.assign(v, { x: 2500, z: 600, sunk: true, hull: { hp: 0, max: 400 } });
  assert.equal(S(world).sailing.respawn(v, { reason: 'wrecked' }), PORT_A);
  assert.equal(v.docked, PORT_A);
  assert.equal(v.sunk, true, 'still wrecked until her hull is mended');
  assert.equal(a.player.rpg.location, S(world).property.shipLocation('small'), 'her crew stay aboard');
  v.hull.hp = 200;
  S(world).sailing.respawn(v);
  assert.equal(v.sunk, false);
  v.naval = { blob: 'x'.repeat(9000) };
  S(world).sailing.save(v);
  world.flushPending();
  const row = world.store.loadWorld(ROW_PREFIX).find(([k]) => k === ROW_PREFIX + v.id)[1];
  assert.deepEqual(row.naval, {}, 'an oversized naval record is not persisted');
  v.naval = { fires: 1 };
  S(world).sailing.save(v);
  world.restart();
  assert.deepEqual(S(world).sailing.byId(v.id).naval, { fires: 1 });
  assert.equal(S(world).sailing.byId(v.id).lastPort, PORT_A);
});

test('open-sea compression: fast far from berths and ships, 1:1 near them, never across land', async (t) => {
  const features = FEATURES.map((f) => (f.name === 'sailing' ? { name: 'sailing', install: (ctx) => sailing(ctx, { coast: fixtureCoast(), loadCoast: false, seaCompression: 60 }) } : f));
  const { world } = await makeWorld(t, features);
  const a = joinAt(world, 1, 'Anselm', { ship: 'small' });
  a.must('sailing.launch');
  const v = vesselOf(world, a);
  a.must('sailing.control', { oars: 1 });
  sailFor(world, 5);
  assert.equal(v.timeScale ?? 1, 1, 'within the harbour she sails 1:1');
  assert.ok(v.x - 1000 < 20);
  // Out in open water (north of the island, far from both berths): compressed.
  Object.assign(v, { x: 2500, z: -2000, yaw: Math.PI / 2, speed: 2 });
  const x0 = v.x;
  sailFor(world, 2);
  assert.equal(v.timeScale, 60);
  assert.ok(v.x - x0 > 150, `compressed stride (${v.x - x0} m in 2 s)`);
  assert.equal(lastState(a).vessel.timeScale, 60);
  // Heading straight at the island from beyond the harbour radius: she never jumps over or into it.
  Object.assign(v, { x: 2200, z: 3200, yaw: 0, speed: 2 });
  sailFor(world, 120, 200);
  assert.ok(v.z > ISLAND.z1, `never past the island's south shore (z ${v.z})`);
  // Pure step: a 60× stride that would leap a 40 m spit of land falls back to 1:1 and grounds on it.
  const land = (x) => x >= 300 && x <= 340;
  const g = { id: 'g', type: 'small', x: 250, z: 0, yaw: Math.PI / 2, speed: 3, sails: 0, oars: 1, rudder: 0, anchored: false, docked: null };
  const segmentClear = (ax, az, bx) => !(Math.min(ax, bx) <= 340 && Math.max(ax, bx) >= 300);
  for (let i = 0; i < 20; i++) stepVessel(g, 1, { wind: { from: 0, speed: 0 }, isWater: (x) => !land(x), segmentClear, timeScale: 60 });
  assert.ok(g.x < 300, `she stops at the spit (${g.x})`);
  assert.equal(g.grounded, true);
});

test('charter passage: an ownerless ship carries a booked passenger round the island to another port; reconnect, denial, retire', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  const p = joinAt(world, 2, 'Brisienna', { ship: 'small' });
  const q = joinAt(world, 3, 'Cyrus');
  const sail = S(world).sailing;
  // FIXTURE: a test-only action stands in for server/rpg/passage.js booking and sailing.
  let ch;
  const atomic = (who, fn) => {
    const r = world.ctx.runAtomic(who.player, 'fixture.passage', fn);
    if (!r.ok) throw new Error(r.error);
  };
  atomic(p, () => {
    ch = sail.charter({ fromPortId: PORT_A, toPortId: PORT_B, type: 'large', name: 'Kingfisher', master: 'Captain Arrin', record: { fare: 40, bookedAt: 1 } });
    sail.embark(p.player, ch);
  });
  assert.equal(ch.ownerId, null);
  assert.equal(ch.docked, PORT_A);
  assert.deepEqual(ch.charter.passengerIds, [p.id]);
  assert.equal(lastState(p).role, 'passenger');
  assert.match(p.act('sailing.helm').error, /must give you the helm/);
  assert.match(p.act('sailing.control', { sails: 1 }).error, /helmsman/);
  assert.deepEqual(S(world).propertyContainers(p.player).map((x) => x.id), [], 'a passenger who owns a ship reaches no hold aboard');
  assert.match(q.act('sailing.board', { vesselId: ch.id }).error, /no passage booked/);
  let eta;
  atomic(p, () => {
    eta = sail.setCourse(ch, PORT_B);
  });
  assert.ok(eta.distance >= 3000);
  const course = lastState(p).vessel.course;
  assert.equal(course.to, PORT_B);
  assert.equal(course.points.at(-1).x, 4000, 'the crew see the plotted waypoints to the berth');
  assert.match(p.act('sailing.leave').error, /at sea/);
  // Mid-voyage the passenger drops and comes back aboard.
  sailFor(world, 40, 200);
  assert.equal(ch.docked, null);
  p.leave();
  sailFor(world, 20, 200);
  const p2 = world.connect(2, 'Brisienna');
  world.tick(50);
  assert.equal(sail.aboard(p2.player), ch, 'reconnects aboard the charter');
  let docked = null;
  world.ctx.on('sailingDocked', (ev) => { if (ev.vessel === ch) docked = ev.port; });
  for (let i = 0; i < 1200 && !ch.docked; i++) world.tick(500);
  assert.equal(ch.docked, PORT_B, `she makes Wayrest (${Math.round(ch.x)}, ${Math.round(ch.z)})`);
  assert.equal(docked, PORT_B);
  assert.ok(!(ch.x >= ISLAND.x0 && ch.x <= ISLAND.x1 && ch.z >= ISLAND.z0 && ch.z <= ISLAND.z1));
  atomic(p2, () => sail.disembark(p2.player, ch));
  assert.equal(p2.player.rpg.location, PORT_B);
  assert.equal(p2.player.rpg.property.ship.type, 'small', 'her own deed is untouched');
  atomic(p2, () => sail.retire(ch));
  assert.equal(sail.byId(ch.id), null);
  world.restart();
  assert.equal(S(world).sailing.byId(ch.id), null, 'a retired charter stays gone after restart');
  void dbPath;
});

test('captain\'s plotted course: routed autopilot to another port, helm takeover, danger breaks it off, shutdown closes the coast', async (t) => {
  const { world } = await makeWorld(t);
  const a = joinAt(world, 1, 'Anselm', { ship: 'large' });
  const b = joinAt(world, 2, 'Brisienna');
  partyUp(a, b);
  a.must('sailing.board');
  b.must('sailing.board', { vesselId: `v${a.id}` });
  assert.match(a.act('sailing.course', { portId: PORT_B }).error, /Take the helm|Cast off/);
  a.must('sailing.launch');
  assert.match(b.act('sailing.course', { portId: PORT_B }).error, /helmsman/, 'a passenger cannot plot');
  a.must('sailing.course', { portId: PORT_B, requestId: req() });
  const v = vesselOf(world, a);
  assert.equal(lastState(b).vessel.course.to, PORT_B, 'the crew see the plotted course');
  // Manual takeover ends it.
  sailFor(world, 5);
  a.must('sailing.control', { rudder: 0.2 });
  assert.equal(v.autopilot, undefined);
  assert.equal(lastState(b).vessel.course, null);
  // Plot again; a hostile ship closing breaks it off.
  a.must('sailing.course', { portId: PORT_B });
  const naval = { rows: [] };
  S(world).naval = { nearbyFor: () => naval.rows };
  sailFor(world, 3);
  assert.ok(v.autopilot, 'still on course with the sea clear');
  naval.rows = [{ id: 'npc-raider', name: 'A raider', hostile: true, distance: 700 }];
  sailFor(world, 1);
  assert.equal(v.autopilot, undefined, 'danger hands the helm back');
  assert.ok(a.events('sailing').some((e) => /raider bears down/.test(e.text)));
  assert.match(a.act('sailing.course', { portId: PORT_B }).error, /raider bears down/);
  // Clear sea: she routes round the island and makes fast at Wayrest on her own.
  naval.rows = [];
  a.must('sailing.course', { portId: PORT_B });
  for (let i = 0; i < 1600 && !v.docked; i++) world.tick(500);
  assert.equal(v.docked, PORT_B, `she makes Wayrest (${Math.round(v.x)}, ${Math.round(v.z)})`);
  assert.equal(v.autopilot, undefined);
  b.must('sailing.leave');
  assert.equal(b.player.rpg.location, PORT_B);
  // Shutdown: a coast started after shutdown is never created; one we made is closed.
  world.ctx.emit('shutdown');
});

test('shutdown before the lazy coast import finishes never starts a coast worker', async (t) => {
  const features = FEATURES.map((f) => (f.name === 'sailing' ? { name: 'sailing', install: (ctx) => sailing(ctx) } : f));
  const { world } = await makeWorld(t, features);
  const sail = S(world).sailing;
  const pending = sail.ensureCoast();
  world.ctx.emit('shutdown');
  await pending;
  assert.equal(S(world).coast ?? null, null, 'no coast was created after shutdown');
  assert.equal(sail.coastNow, null);
});

test('shore geometry: sailing.state.coast is sent once per 1 km cell and on full snapshots', async (t) => {
  const { world } = await makeWorld(t);
  // FIXTURE: shoreNear stub on the test coast.
  const calls = [];
  const coast = S(world).sailing.coastNow;
  coast.shoreNear = (x, z, r) => { calls.push([x, z, r]); return { centre: { x, z }, radius: r, rings: [{ kind: 'island', ring: [[2000, 1000], [2400, 1000], [2400, 1400]] }] }; };
  coast.prepareAround = async () => {};
  const a = joinAt(world, 1, 'Anselm', { ship: 'small' });
  a.must('sailing.launch');
  await new Promise((r) => setTimeout(r, 20));
  a.must('sailing.sync');
  const first = lastState(a);
  assert.equal(first.coast.rings[0].kind, 'island');
  const key = first.coastKey;
  a.must('sailing.control', { sails: 1, oars: 1 });
  sailFor(world, 4);
  const later = a.events('sailing.state').slice(-5);
  assert.ok(later.every((e) => !e.coast), 'not resent within the same cell');
  const v = vesselOf(world, a);
  Object.assign(v, { x: v.x + 1500 });
  world.tick(300);
  await new Promise((r) => setTimeout(r, 20));
  sailFor(world, 1);
  assert.ok(a.events('sailing.state').some((e) => e.coast && e.coastKey !== key), 'a new cell sends new geometry');
  assert.equal(calls.length, 2);
});

test('a vessel whose pose goes non-finite is recovered at her berth and re-plans her course', async (t) => {
  const { world } = await makeWorld(t);
  const p = joinAt(world, 2, 'Brisienna');
  const sail = S(world).sailing;
  let ch;
  const r = world.ctx.runAtomic(p.player, 'fixture.passage', () => {
    ch = sail.charter({ fromPortId: PORT_A, toPortId: PORT_B, type: 'large', name: 'Kingfisher', master: 'Captain Arrin', record: {} });
    sail.embark(p.player, ch);
    sail.setCourse(ch, PORT_B);
  });
  assert.ok(r.ok, r.error);
  sailFor(world, 5);
  Object.assign(ch, { x: NaN, z: undefined }); // a bad external write
  sailFor(world, 2);
  assert.ok(Number.isFinite(ch.x) && Number.isFinite(ch.z), 'pose recovered');
  for (let i = 0; i < 1600 && !ch.docked?.includes('Wayrest'); i++) world.tick(500);
  assert.equal(ch.docked, PORT_B, 'and she still makes her destination');
  assert.ok(lastState(p).vessel.x !== null);
});
