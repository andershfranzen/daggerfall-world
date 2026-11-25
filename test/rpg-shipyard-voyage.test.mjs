// Shipyard × sailing core × naval combat, end to end (server/rpg/shipyard.js, sailing.js, naval.js).
//
// FIXTURE: the real runtime with the production features in manifest order (inventory, atmosphere, calendar, travel,
// town services, mount, property, social, sailing, shipyard, naval) on a real SQLite file in a private /var/tmp
// directory. Test data, not game data: the town records (both ports flagged as harbours) and the COAST (two invented
// ports 3 km apart on open water). STAGED: the vessel is moved next to the far quay instead of sailing the whole 3 km,
// and the voyage clock is wound back two days; the docking itself is the real `sailing.dock` action. Naval NPC spawns
// are off so no pirate interferes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureWorld, tempDir, readPersisted } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as atmosphere } from '../server/rpg/atmosphere.js';
import { install as calendar } from '../server/rpg/calendar.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as townServices } from '../server/rpg/townServices.js';
import { install as mount } from '../server/rpg/mount.js';
import { install as property } from '../server/rpg/property.js';
import { install as social } from '../server/rpg/social.js';
import { install as sailing } from '../server/rpg/sailing.js';
import { install as shipyard } from '../server/rpg/shipyard.js';
import { install as naval } from '../server/rpg/naval.js';
import { statsOf } from '../server/rpg/sailing/yard.js';

const PORT_A = 'town:Daggerfall/Daggerfall';
const PORT_B = 'town:Wayrest/Wayrest';
const PORTS = [
  { id: PORT_A, name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI / 2, quay: { x: 5, z: -40, yaw: 0 } },
  { id: PORT_B, name: 'Wayrest', region: 'Wayrest', x: 4000, z: 1000, yaw: -Math.PI / 2, quay: { x: -12, z: 30, yaw: Math.PI } },
];
const coast = () => ({
  status: 'ready',
  isWater: () => true,
  ports: () => PORTS,
  portOf: (id) => PORTS.find((p) => p.id === id) ?? null,
  route: (a, b) => (a !== b && PORTS.some((p) => p.id === a) && PORTS.some((p) => p.id === b) ? { leagues: 4, days: 1 } : null),
  nearestPort: (x, z) => PORTS.map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) })).sort((a, b) => a.distance - b.distance)[0] ?? null,
});
const TOWNS = {
  [PORT_A]: { counters: [], houses: [], buildingCount: 40, port: true, regionIndex: 17 },
  [PORT_B]: { counters: [], houses: [], buildingCount: 40, port: true, regionIndex: 19 },
};
const FEATURES = [
  { name: 'inventory', install: inventory },
  { name: 'atmosphere', install: atmosphere },
  { name: 'calendar', install: calendar },
  { name: 'travel', install: travel },
  { name: 'townServices', install: (ctx) => townServices(ctx, { loadCounters: async (t) => TOWNS[t] ?? { counters: [] } }) },
  { name: 'mount', install: mount },
  { name: 'property', install: property },
  { name: 'social', install: social },
  { name: 'sailing', install: (ctx) => sailing(ctx, { coast: coast(), loadCoast: false }) },
  { name: 'shipyard', install: shipyard },
  { name: 'naval', install: (ctx) => naval(ctx, { spawn: false }) },
];

let rid = 0;
const req = () => `voy-${++rid}-${Date.now().toString(36)}`;
const S = (world) => world.ctx.services;

async function makeWorld(t) {
  const { dir } = tempDir('dfw-shipyard-voyage-', '/var/tmp');
  const dbPath = join(dir, 'world.db');
  const world = await createFixtureWorld({ dbPath, features: FEATURES });
  t.after(() => {
    world.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(world.installErrors, []);
  return { world, dbPath };
}
async function joinAt(world, account, name, { gold = 0, location = PORT_A } = {}) {
  const c = world.connect(account, name);
  Object.assign(c.player.rpg, { location, gold });
  c.moveTo(3, -38);
  await S(world).townCountersSettled(location);
  world.tick(50);
  return c;
}
const sy = (c) => c.player.rpg.shipyard;
const status = (c) => {
  c.must('shipyard.status');
  return c.events('shipyard.status').at(-1);
};
const vessel = (world, c) => S(world).sailing.byId(`v${c.player.id}`);
async function stageAndDock(world, c, port) {
  const v = vessel(world, c);
  c.must('sailing.control', { sails: 0, oars: 0, rudder: 0 });
  Object.assign(v, { x: port.x - 40, z: port.z, speed: 0 }); // STAGED position next to the quay
  world.tick(50);
  c.must('sailing.dock', { requestId: req() });
}

test('entry craft: a new captain buys a rowboat, launches it with the real sailing core and docks at another port', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'Newcomer', { gold: 600 });
  assert.match(a.act('sailing.launch').error, /own no ship/);
  a.must('shipyard.buy', { hull: 'rowboat', name: 'Little Dory', expectPrice: 450, requestId: req() });
  const shipId = sy(a).active;
  a.must('sailing.launch', { requestId: req() });
  const v = vessel(world, a);
  assert.equal(v.shipId, shipId);
  assert.equal(v.hullClass, 'rowboat');
  assert.equal(v.name, 'Little Dory');
  assert.deepEqual(v.hull, { hp: 40, max: 40 });
  assert.equal(v.docked, null);
  assert.equal(sy(a).ships[0].at, 'sea', 'the shipyard saw the launch');
  assert.equal(S(world).shipyard.statsOf(v).guns, 0);

  await stageAndDock(world, a, PORTS[1]);
  assert.equal(vessel(world, a).docked, PORT_B);
  assert.equal(sy(a).ships[0].port, PORT_B);
  assert.equal(sy(a).ships[0].at, 'port');
  a.must('sailing.leave', { requestId: req() });
  assert.equal(a.player.rpg.location, PORT_B);
  await S(world).townCountersSettled(PORT_B);
  assert.equal(status(a).fleet[0].here, true, 'the yard at Wayrest serves the rowboat that sailed in');
});

test('cutter voyage: crew, stores and refit gate the launch; naval spends the yard\'s shot; delivery and cargo pay only on arrival; restart', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  let a = await joinAt(world, 1, 'Captain', { gold: 20_000 });
  const pid = a.player.id;
  a.must('shipyard.buy', { hull: 'cutter', name: 'Kingfisher', expectPrice: 6000, requestId: req() });
  const shipId = sy(a).active;
  assert.match(a.act('sailing.launch', { requestId: req() }).error, /at least 2 hands/);
  assert.equal(vessel(world, a)?.docked ?? PORT_A, PORT_A, 'a refused launch leaves her at the quay');

  let st = status(a);
  for (const r of st.recruits.slice(0, 3)) a.must('shipyard.hire', { shipId, recruitId: r.id, requestId: req() });
  assert.match(a.act('sailing.launch', { requestId: req() }).error, /no provisions/);
  a.must('shipyard.supply', { shipId, store: 'provisions', qty: 40, requestId: req() });
  a.must('shipyard.supply', { shipId, store: 'shot', qty: 20, requestId: req() });
  a.must('shipyard.refit', { shipId, line: 'guns', requestId: req() });
  assert.equal(statsOf('cutter', { guns: 1 }).guns, 3);

  st = status(a);
  const good = st.market.find((m) => m.stand === 'made') ?? st.market[0];
  a.must('shipyard.trade', { shipId, good: good.id, qty: 10, side: 'buy', expectPrice: good.buy, requestId: req() });
  const offer = st.board.find((o) => o.to === PORT_B);
  assert.ok(offer, 'the harbour board posts a consignment to the other real port');
  a.must('shipyard.contract.take', { shipId, offerId: offer.id, requestId: req() });
  const goldAtSea = a.player.rpg.gold;

  a.must('sailing.launch', { requestId: req() });
  const v = vessel(world, a);
  assert.equal(v.shipId, shipId);
  assert.equal(v.hullClass, 'cutter');
  assert.equal(v.crew.length, 3, 'the vessel carries the yard\'s crew');
  assert.equal(v.stores.shot, 20);
  assert.equal(S(world).shipyard.statsOf(v).guns, 3);
  assert.equal(JSON.stringify(v).includes('"stores"'), false, 'stores never enter the vessel row');

  // Naval combat: away from the quay, a broadside spends the yard's own shot.
  Object.assign(v, { x: 2500, z: 1000, speed: 0 }); // STAGED: open water, outside the harbour radius
  world.tick(100);
  a.must('naval.fire', { side: 'starboard' });
  const left = sy(a).ships[0].stores.shot;
  assert.ok(left < 20 && left >= 20 - 3, `the broadside cost shot from the record (${left} left)`);
  assert.equal(a.player.rpg.gold, goldAtSea, 'nothing paid while at sea');
  assert.equal(S(world).naval.inCombat(a.player, shipId), true, 'a ship that has just fired is in a fight');
  for (let i = 0; i < 31; i++) world.tick(1000); // the gun smoke clears before she makes port

  // Two days at sea, then the real dock at Wayrest.
  sy(a).ships[0].departedAt -= 2 * 1440; // STAGED time
  const wages = sy(a).ships[0].crew.reduce((n, h) => n + h.wage, 0);
  await stageAndDock(world, a, PORTS[1]);
  const wagesPaid = goldAtSea + offer.pay - a.player.rpg.gold; // the consignment's pay less the voyage's wages
  assert.ok(wagesPaid >= wages * 2 && wagesPaid <= wages * 2 + Math.ceil(wages / 10), `wages for two days and the half-minute at sea (${wagesPaid})`);
  assert.ok(sy(a).done.includes(offer.id));
  assert.equal(sy(a).ships[0].port, PORT_B);

  // Ashore at Wayrest: sell the cargo there.
  a.must('sailing.leave', { requestId: req() });
  await S(world).townCountersSettled(PORT_B);
  st = status(a);
  const sell = st.market.find((m) => m.id === good.id);
  const n = Math.min(10, sell.demand);
  const g = a.player.rpg.gold;
  a.must('shipyard.trade', { shipId, good: good.id, qty: n, side: 'sell', expectPrice: sell.sell, requestId: req() });
  assert.equal(a.player.rpg.gold, g + n * sell.sell);

  // Restart: the record, the vessel binding and the delivery stay; no second payment.
  const before = structuredClone(sy(a));
  world.restart();
  a = await joinAt(world, 1, 'Captain', { gold: a.player.rpg.gold, location: PORT_B });
  world.tick(1100);
  assert.equal(a.player.id, pid);
  assert.deepEqual(sy(a).ships, before.ships);
  const v2 = vessel(world, a);
  assert.equal(v2.shipId, shipId);
  assert.equal(v2.docked, PORT_B);
  assert.equal(v2.stores?.shot, before.ships[0].stores.shot, 'relinked after restart');
  const saved = readPersisted(dbPath, pid).rpg.shipyard;
  assert.equal(saved.done.includes(offer.id), true);
  const g2 = a.player.rpg.gold;
  world.ctx.emit('sailingDocked', { vessel: v2, port: PORT_B, player: a.player });
  assert.equal(a.player.rpg.gold, g2, 'a repeated dock report after restart never pays again');
});

test('classic owner: the property deed sails as legacy-small with its skeleton crew, and the flagship can switch at port', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'OldSalt', { gold: 2000 });
  a.player.rpg.property = { ...(a.player.rpg.property ?? {}), ship: { type: 'small', boughtAt: 0 } };
  a.player.rpg.property.version = 0;
  world.tick(50);
  a.must('sailing.launch', { requestId: req() });
  let v = vessel(world, a);
  assert.equal(v.shipId, 'legacy-small');
  assert.equal(v.type, 'small');
  assert.equal(v.crew.length, statsOf('small').crewMin);
  assert.equal(S(world).shipyard.statsOf(v).guns, 10);
  // Cannot change flagship at sea.
  await stageAndDock(world, a, PORTS[0]);
  a.must('sailing.leave', { requestId: req() });
  a.must('shipyard.buy', { hull: 'rowboat', requestId: req() });
  const row = sy(a).active;
  a.must('sailing.board', { requestId: req() });
  v = vessel(world, a);
  assert.equal(v.shipId, row, 'the vessel now sails the new flagship');
  assert.equal(v.hullClass, 'rowboat');
  assert.equal(sy(a).ships.find((s) => s.id === 'legacy-small').port, PORT_A, 'the galleon keeps her berth');
});
