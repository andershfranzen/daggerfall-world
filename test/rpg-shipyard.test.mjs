// Shipyard, fleet, stores, crew hall, port market and harbour board (server/rpg/shipyard.js).
//
// FIXTURE: the real runtime, inventory, atmosphere clock, travel, town services and property features on a
// real SQLite file in a private temp directory. Town records below are invented test data (two port towns and
// one inland town); the sea-port list stands in for the geography service. Restarts boot a fresh runtime on the
// same database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureWorld, tempDir, readPersisted } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as atmosphere } from '../server/rpg/atmosphere.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as townServices } from '../server/rpg/townServices.js';
import { install as property } from '../server/rpg/property.js';
import { install as shipyard } from '../server/rpg/shipyard.js';
import { HULLS, statsOf, refitCost, salePrice } from '../server/rpg/sailing/yard.js';
import { marketAt, boardAt } from '../server/rpg/sailing/yardTrade.js';
import { recruitsAt } from '../server/rpg/sailing/yardCrew.js';

const GG = 'town:Daggerfall/Gothway Garden';
const SENT = 'town:Sentinel/Sentinel';
const WR = 'town:Wayrest/Wayrest';
const FIXTURE = {
  [GG]: { counters: [], houses: [], buildingCount: 40, port: true, regionIndex: 17 },
  [SENT]: { counters: [], houses: [], buildingCount: 40, port: true, regionIndex: 20 },
  [WR]: { counters: [], houses: [], buildingCount: 5, port: false, regionIndex: 19 },
};
const PORTS = [
  { id: GG, name: 'Gothway Garden', px: 200, py: 120 },
  { id: SENT, name: 'Sentinel', px: 140, py: 260 },
];
const FEATURES = [
  { name: 'inventory', install: inventory },
  { name: 'atmosphere', install: atmosphere },
  { name: 'travel', install: travel },
  { name: 'townServices', install: (ctx) => townServices(ctx, { loadCounters: async (town) => FIXTURE[town] ?? { counters: [] } }) },
  { name: 'property', install: property },
  { name: 'seaPorts', install: (ctx) => { ctx.services.seaPorts = () => PORTS; } },
  { name: 'shipyard', install: shipyard },
];

let rid = 0;
const req = () => `sy-${++rid}-${Date.now().toString(36)}`;

async function makeWorld(t) {
  const { dir } = tempDir('dfw-shipyard-', '/var/tmp');
  const dbPath = join(dir, 'world.db');
  const world = await createFixtureWorld({ dbPath, features: FEATURES });
  t.after(() => {
    world.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(world.installErrors, []);
  return { world, dbPath };
}
async function joinAt(world, account, name, { gold = 0, location = GG } = {}) {
  const c = world.connect(account, name);
  Object.assign(c.player.rpg, { location, gold });
  c.player.rpg.character = { ...(c.player.rpg.character ?? {}), level: 1 };
  c.moveTo(0, 0);
  await world.ctx.services.townCountersSettled(location);
  world.tick(100);
  return c;
}
const sy = (c) => c.player.rpg.shipyard;
const last = (c) => c.events('shipyard.status').at(-1);
async function goTo(world, c, town) {
  c.player.rpg.location = town;
  await world.ctx.services.townCountersSettled(town);
  world.tick(100);
}

test('rules: hull ladder, refits, market spread and deterministic offers', () => {
  assert.ok(HULLS.rowboat.price < 1000 && HULLS.rowboat.crewMin === 0, 'an entry craft a new captain can afford and sail alone');
  assert.equal(HULLS.small.price, 100_000);
  assert.equal(HULLS.large.price, 200_000);
  assert.equal(statsOf('cutter', { hold: 2 }).capacity, Math.round(30 * 1.5));
  assert.equal(statsOf('cog', { guns: 1 }).guns, 5);
  assert.equal(refitCost('cutter', 'hold', 0), 480);
  for (const row of marketAt(GG, 3)) assert.ok(row.sell < row.buy, `${row.id}: no same-day buy/sell profit`);
  assert.deepEqual(boardAt(PORTS[0], 5, PORTS).map((o) => o.id), boardAt(PORTS[0], 5, PORTS).map((o) => o.id));
  assert.ok(boardAt(PORTS[0], 5, PORTS).every((o) => o.to === SENT && o.pay > 0));
  assert.equal(recruitsAt(GG, 2).length, 8);
});

test('new captain: inland refusal, rowboat afloat, refused purchase changes nothing, replay refused', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'Newcomer', { gold: 600, location: WR });
  assert.match(a.act('shipyard.buy', { hull: 'rowboat', requestId: req() }).error, /no harbour/);
  await goTo(world, a, GG);
  a.must('shipyard.status');
  assert.equal(last(a).port.id, GG);
  assert.ok(last(a).hulls.some((h) => h.id === 'rowboat'));

  const before = JSON.stringify(a.player.rpg);
  assert.match(a.act('shipyard.buy', { hull: 'cutter', requestId: req() }).error, /costs 6,000 gold/);
  assert.equal(JSON.stringify(a.player.rpg), before, 'a refused purchase leaves the character untouched');

  const id = req();
  a.must('shipyard.buy', { hull: 'rowboat', name: 'Little Dory', expectPrice: 450, requestId: id });
  assert.equal(a.player.rpg.gold, 150);
  assert.match(a.act('shipyard.buy', { hull: 'rowboat', requestId: id }).error, /already done/);
  assert.equal(sy(a).ships.length, 1);
  const boat = sy(a).ships[0];
  assert.equal(boat.name, 'Little Dory');
  assert.equal(boat.port, GG);
  assert.equal(world.ctx.services.shipyard.canSail(a.player, boat.id), null, 'a rowboat needs no crew or provisions');
  assert.equal(world.ctx.services.shipyard.departed(a.player, boat.id), true);
  assert.equal(sy(a).ships[0].at, 'sea');
  assert.match(a.act('shipyard.supply', { shipId: boat.id, store: 'provisions', qty: 2, requestId: req() }).error, /at sea/);
});

test('captain: crew, stores, refit, repair, trade, delivery paid once on arrival, restart', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  let a = await joinAt(world, 1, 'Captain', { gold: 20_000 });
  const pid = a.player.id;
  const Y = world.ctx.services.shipyard;
  a.must('shipyard.buy', { hull: 'cutter', expectPrice: 6000, requestId: req() });
  const shipId = sy(a).active;
  assert.match(Y.canSail(a.player, shipId), /at least 2 hands/);
  assert.throws(() => Y.departed(a.player, shipId), /at least 2 hands/);

  // Crew hall: two hands, one reassigned.
  a.must('shipyard.status');
  const [r1, r2] = last(a).recruits;
  a.must('shipyard.hire', { shipId, recruitId: r1.id, requestId: req() });
  a.must('shipyard.hire', { shipId, recruitId: r2.id, requestId: req() });
  assert.match(a.act('shipyard.hire', { shipId, recruitId: r1.id, requestId: req() }).error, /already signed/);
  a.must('shipyard.assign', { shipId, handId: r2.id, role: 'Gunner', requestId: req() });
  assert.equal(sy(a).ships[0].crew.find((h) => h.id === r2.id).role, 'Gunner');
  assert.match(Y.canSail(a.player, shipId), /no provisions/);

  // Stores and gun ammunition, capped by the hull.
  a.must('shipyard.supply', { shipId, store: 'provisions', qty: 30, requestId: req() });
  a.must('shipyard.supply', { shipId, store: 'shot', qty: 20, requestId: req() });
  assert.match(a.act('shipyard.supply', { shipId, store: 'shot', qty: 999, requestId: req() }).error, /only 20 more/);
  assert.equal(Y.canSail(a.player, shipId), null);

  // Refit the hold, then combat damage and spending through the naval services, then a yard repair.
  const g0 = a.player.rpg.gold;
  a.must('shipyard.refit', { shipId, line: 'hold', expectPrice: refitCost('cutter', 'hold', 0), requestId: req() });
  assert.equal(a.player.rpg.gold, g0 - 480);
  assert.equal(Y.stats(a.player, shipId).capacity, 38);
  assert.deepEqual(Y.spend(a.player, shipId, { shot: 2 }), { shot: 2, provisions: 0, timber: 0 });
  assert.equal(Y.damage(a.player, shipId, { hull: 50, sail: 10 }).hullHp, 70);
  a.must('shipyard.status');
  assert.equal(last(a).fleet[0].repair.hull.gold, 200);
  a.must('shipyard.repair', { shipId, part: 'all', expectPrice: 220, requestId: req() });
  assert.equal(sy(a).ships[0].hullHp, 120);

  // Market: buy grain, refuse over capacity.
  a.must('shipyard.status');
  const grain = last(a).market.find((r) => r.id === 'grain');
  a.must('shipyard.trade', { shipId, good: 'grain', qty: 10, side: 'buy', expectPrice: grain.buy, requestId: req() });
  assert.match(a.act('shipyard.trade', { shipId, good: 'grain', qty: 40, side: 'buy', requestId: req() }).error, /room for 28|only \d+ grain/);

  // Harbour board: a consignment to Sentinel.
  const offer = last(a).board.find((o) => o.units <= 28);
  assert.ok(offer, 'an offer that fits');
  a.must('shipyard.contract.take', { shipId, offerId: offer.id, requestId: req() });
  assert.match(a.act('shipyard.contract.take', { shipId, offerId: offer.id, requestId: req() }).error, /taken down/);
  assert.equal(sy(a).contracts.length, 1);

  // Voyage: depart, two days pass, arrive at the real destination.
  assert.equal(Y.departed(a.player, shipId), true);
  sy(a).ships[0].departedAt -= 2 * 1440;
  const crewWages = sy(a).ships[0].crew.reduce((n, h) => n + h.wage, 0);
  await goTo(world, a, SENT);
  const before = a.player.rpg.gold;
  Y.arrived(a.player, shipId, SENT);
  assert.equal(a.player.rpg.gold, before - crewWages * 2 + offer.pay);
  assert.equal(sy(a).contracts.length, 0);
  assert.ok(sy(a).done.includes(offer.id));
  assert.equal(sy(a).ships[0].stores.provisions, 30 - 6);
  assert.ok(!sy(a).ships[0].cargo.some((c) => c.contractId));
  // A second arrival report never pays again.
  Y.departed(a.player, shipId);
  Y.arrived(a.player, shipId, SENT);
  assert.ok(a.player.rpg.gold <= before - crewWages * 2 + offer.pay);

  // Sell the grain in Sentinel.
  a.must('shipyard.status');
  const sell = last(a).market.find((r) => r.id === 'grain');
  const g1 = a.player.rpg.gold;
  const n = Math.min(10, sell.demand); // Sentinel's own goods sell poorly there: demand caps the day's sales
  assert.ok(n > 0);
  if (n < 10) assert.match(a.act('shipyard.trade', { shipId, good: 'grain', qty: 10, side: 'sell', requestId: req() }).error, /only \d+ more today/);
  a.must('shipyard.trade', { shipId, good: 'grain', qty: n, side: 'sell', requestId: req() });
  assert.equal(a.player.rpg.gold, g1 + n * sell.sell);

  // Restart: same database, fresh runtime; everything durable.
  const snapshot = structuredClone(sy(a));
  world.restart();
  a = await joinAt(world, 1, 'Captain', { gold: a.player.rpg.gold, location: SENT });
  assert.equal(a.player.id, pid);
  const saved = readPersisted(dbPath, pid).rpg.shipyard;
  assert.equal(saved.ships[0].port, SENT);
  assert.deepEqual(sy(a).ships, snapshot.ships);
  assert.deepEqual(sy(a).done, snapshot.done);
  a.must('shipyard.status');
  assert.equal(last(a).fleet[0].here, true);
  assert.equal(last(a).fleet[0].salePrice, salePrice(snapshot.ships[0]));
});

test('classic owners: a small-ship deed joins the fleet with a skeleton crew and can be sold at the yard', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'OldSalt', { gold: 50 });
  a.player.rpg.property = { ...(a.player.rpg.property ?? {}), ship: { type: 'small', boughtAt: 0 } };
  a.must('shipyard.status');
  const fleet = last(a).fleet;
  assert.equal(fleet.length, 1);
  assert.equal(fleet[0].id, 'legacy-small');
  assert.equal(fleet[0].crew.length, HULLS.small.crewMin);
  assert.equal(fleet[0].here, true, 'a classic ship answers at the port its owner stands in');
  assert.equal(world.ctx.services.shipyard.canSail(a.player, 'legacy-small'), null);
  a.must('shipyard.sell', { shipId: 'legacy-small', requestId: req() });
  assert.equal(a.player.rpg.property.ship, null);
  assert.equal(a.player.rpg.gold, 50 + 85_000);
  a.must('shipyard.status');
  assert.equal(last(a).fleet.length, 0);
});

test('sailing core: a classic vessel docking settles wages and pays its consignment once; at sea the yard refuses', async (t) => {
  // FIXTURE: a stand-in for services.sailing (server/rpg/sailing.js contract: byId, vessels, ports, refusal) so the
  // shipyard's event wiring is exercised without coast data; events carry the core's documented payloads.
  const vessels = new Map();
  const sailingStub = { name: 'sailingStub', install: (ctx) => {
    ctx.services.sailing = { byId: (id) => vessels.get(id) ?? null, vessels: () => vessels.values(), ports: () => [], refusal: () => null };
  } };
  const { dir } = tempDir('dfw-shipyard-', '/var/tmp');
  const world = await createFixtureWorld({ dbPath: join(dir, 'world.db'), features: [...FEATURES.slice(0, -1), sailingStub, FEATURES.at(-1)] });
  t.after(() => { world.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(world.installErrors, []);
  const a = await joinAt(world, 1, 'Galleon', { gold: 5000 });
  a.player.rpg.property = { ...(a.player.rpg.property ?? {}), ship: { type: 'small', boughtAt: 0 } };
  const v = { id: `v${a.player.id}`, ownerId: a.player.id, type: 'small', docked: GG, launchedAt: null, sunk: false };
  vessels.set(v.id, v);
  a.must('shipyard.status');
  assert.equal(last(a).fleet[0].here, true);
  const offer = last(a).board[0];
  a.must('shipyard.contract.take', { shipId: 'legacy-small', offerId: offer.id, requestId: req() });

  // Cast off: the core's vessel is at sea; the shipyard will not serve her.
  Object.assign(v, { docked: null, launchedAt: world.ctx.services.worldClock().minutes - 1440 });
  world.ctx.emit('sailingLaunched', { vessel: v, port: GG, player: a.player });
  assert.equal(sy(a).ships[0].at, 'sea');
  assert.match(a.act('shipyard.supply', { shipId: 'legacy-small', store: 'shot', qty: 1, requestId: req() }).error, /at sea/);

  // Make fast at Sentinel.
  await goTo(world, a, SENT);
  sy(a).ships[0].departedAt -= 1440;
  const wages = sy(a).ships[0].crew.reduce((n, h) => n + h.wage, 0);
  const before = a.player.rpg.gold;
  v.docked = SENT;
  world.ctx.emit('sailingDocked', { vessel: v, port: SENT, player: a.player });
  assert.equal(a.player.rpg.gold, before - wages + offer.pay);
  assert.ok(a.events('shipyard').some((e) => /makes fast at Sentinel/.test(e.text)));
  world.ctx.emit('sailingDocked', { vessel: v, port: SENT, player: a.player });
  assert.equal(a.player.rpg.gold, before - wages + offer.pay, 'a repeated dock report never pays twice');
  assert.equal(readPersisted(join(dir, 'world.db'), a.player.id).rpg.shipyard.done.includes(offer.id), true, 'the payment was saved');
});

test('prize law: goods move between two captains atomically, capped by pieces, value and room', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'Loser', { gold: 9000 });
  const b = await joinAt(world, 2, 'Winner', { gold: 9000 });
  const Y = world.ctx.services.shipyard;
  a.must('shipyard.buy', { hull: 'cutter', requestId: req() });
  b.must('shipyard.buy', { hull: 'cutter', requestId: req() });
  const [ia, ib] = [sy(a).active, sy(b).active];
  Y.addCargo(a.player, ia, [{ good: 'silk', qty: 6 }, { good: 'grain', qty: 20 }]);
  assert.deepEqual(Y.shipOfVessel({ ownerId: a.player.id, shipId: ia }), { player: a.player, shipId: ia });
  const moved = Y.transferCargo(a.player, ia, b.player, ib, { maxPieces: 8, share: 1 / 3 });
  const total = moved.reduce((n, m) => n + m.qty, 0);
  assert.ok(total > 0 && total <= 8);
  const after = (c, id, good) => sy(c).ships.find((s) => s.id === id).cargo.find((x) => x.good === good)?.qty ?? 0;
  for (const m of moved) assert.equal(after(b, ib, m.good), m.qty);
  assert.equal(after(a, ia, 'silk') + after(b, ib, 'silk'), 6, 'nothing duplicated or lost');
  assert.deepEqual(Y.loseCrew(a.player, ia, 1), []);
});
