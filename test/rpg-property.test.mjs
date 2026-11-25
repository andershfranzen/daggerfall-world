// Package 13: loans, houses, ships, the wagon and owned storage (server/rpg/property.js).
//
// FIXTURE: the real runtime, real inventory, atmosphere clock, travel, town services, mount and property
// features on a real SQLite file in a private temp directory, with invented bank and house records (the
// counter positions and radii below are test data, not game data). Restarts boot a fresh runtime on the
// same database. The last case reads the operator's ARENA2 directory when it is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureWorld, tempDir, readPersisted, localArena2 } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as atmosphere } from '../server/rpg/atmosphere.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as townServices } from '../server/rpg/townServices.js';
import { install as mount } from '../server/rpg/mount.js';
import { install as property, normalizeProperty } from '../server/rpg/property.js';
import { install as calendar } from '../server/rpg/calendar.js';
import { install as law } from '../server/rpg/law.js';
import {
  housePrice, deedSellPrice, loanRepayment, maxLoan, housesForSale, reminderCrossed, LOAN_TERM_MINUTES, MINUTES_PER_MONTH,
  WAGON_KG_LIMIT,
} from '../client/gameplay/property/rules.js';
import { quoteJourney } from '../client/gameplay/travel/journey.js';

const GG = 'town:Daggerfall/Gothway Garden';
const WR = 'town:Wayrest/Wayrest';
const HOUSE_A = 'interior:Daggerfall/Gothway Garden/1,1/4';
const HOUSE_B = 'interior:Daggerfall/Gothway Garden/1,2/5';
const FIXTURE = {
  [GG]: {
    counters: [{ id: 'b:2,0:15', kind: 'building', type: 'bank', buildingType: 3, regionIndex: 17, services: ['bank'], name: 'The Bank of Daggerfall', quality: 15, interior: null, doors: [{ x: 10, z: 20 }] }],
    houses: [
      { id: 'b:1,1:4', buildingType: 1, interior: HOUSE_A, radius: 12.5, door: { x: 30, z: 0 } },
      { id: 'b:1,2:5', buildingType: 17, interior: HOUSE_B, radius: 9.25, door: { x: 40, z: 0 } },
    ],
    buildingCount: 40, port: true, regionIndex: 17,
  },
  [WR]: {
    counters: [{ id: 'b:0,0:1', kind: 'building', type: 'bank', buildingType: 3, regionIndex: 19, services: ['bank'], name: 'Bank of Wayrest', quality: 10, interior: null, doors: [{ x: 0, z: 5 }] }],
    houses: [], buildingCount: 5, port: false, regionIndex: 19,
  },
};
const FEATURES = [
  { name: 'inventory', install: inventory },
  { name: 'atmosphere', install: atmosphere },
  { name: 'travel', install: travel },
  { name: 'townServices', install: (ctx) => townServices(ctx, { loadCounters: async (town) => FIXTURE[town] ?? { counters: [] } }) },
  { name: 'mount', install: mount },
  { name: 'property', install: property },
];

const BANK = { counterId: 'b:2,0:15' };
let rid = 0;
const req = () => `req-${++rid}-${Date.now().toString(36)}`;

async function makeWorld(t, features = FEATURES) {
  const { dir } = tempDir('dfw-property-');
  const dbPath = join(dir, 'world.db');
  const world = await createFixtureWorld({ dbPath, features });
  t.after(() => {
    world.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(world.installErrors, []);
  return { world, dbPath };
}

async function joinAt(world, account, name, { gold = 0, level = 1, location = GG, x = 10, z = 18 } = {}) {
  const c = world.connect(account, name);
  Object.assign(c.player.rpg, { location, gold });
  c.player.rpg.character = { ...(c.player.rpg.character ?? {}), level, attributes: { Strength: 60, Speed: 50 } };
  c.moveTo(x, z);
  await world.ctx.services.townCountersSettled(location);
  world.tick(100);
  return c;
}
const st = (c) => c.player.rpg.property;
const acct = (world, c, region = 'Daggerfall') => world.ctx.services.bankBalance(c.player, region);
const gameMinutes = (world) => world.ctx.services.worldClock().minutes;

test('rules: classic loan, house, deed and reminder numbers', () => {
  assert.equal(maxLoan(1), 50_000);
  assert.equal(maxLoan(7), 350_000);
  assert.equal(loanRepayment(1000), 1100);
  assert.equal(loanRepayment(155), 170); // (int)(155 + 15.5)
  assert.equal(housePrice(12.5), 16_000);
  assert.equal(deedSellPrice(16_000), 13_600);
  assert.equal(deedSellPrice(100_000), 85_000);
  assert.equal(LOAN_TERM_MINUTES, 360 * 1440);
  const due = 10 * MINUTES_PER_MONTH;
  assert.equal(reminderCrossed(due, due - 6 * MINUTES_PER_MONTH - 1, due - 6 * MINUTES_PER_MONTH + 1), 6);
  assert.equal(reminderCrossed(due, due - 5 * MINUTES_PER_MONTH, due - 5 * MINUTES_PER_MONTH + 5), null);
  const offers = housesForSale(FIXTURE[GG].houses, { town: GG, monthIndex: 3, buildingCount: 40 });
  assert.deepEqual(offers.map((h) => h.id), ['b:1,1:4', 'b:1,2:5']); // 1 HouseForSale + up to 40/10 - 1 others
  assert.equal(housesForSale(FIXTURE[GG].houses, { town: GG, monthIndex: 3, buildingCount: 10 }).length, 1);
  // An owned ship waives sea passage (TravelTimeCalculator.CalculateTripCost).
  const a = { x: 100, y: 100 }, b = { x: 100, y: 160 };
  const sea = () => 223; // CLIMATE.OCEAN on every step
  assert.equal(quoteJourney(a, b, { ship: true }, { climateAt: sea }).cost.passage, 25 * (Math.trunc(60 / 24) + 1));
  assert.equal(quoteJourney(a, b, { ship: true }, { climateAt: sea, ownsShip: true }).cost.passage, 0);
});

test('loan: borrow, partial and full repayment in the issuing region only, replay refused', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'Lender', { gold: 300, level: 2 });
  assert.match(a.act('bank.loan', { ...BANK, amount: 50 }).error, /no less than 100/);
  assert.match(a.act('bank.loan', { ...BANK, amount: 100_001 }).error, /at most 100000/);
  const id = req();
  a.must('bank.loan', { ...BANK, amount: 1000, requestId: id });
  assert.match(a.act('bank.loan', { ...BANK, amount: 1000, requestId: id }).error, /already done/);
  assert.equal(acct(world, a), 1000);
  assert.equal(st(a).loans.daggerfall.total, 1100);
  assert.equal(st(a).loans.daggerfall.due, st(a).loans.daggerfall.checkedAt + LOAN_TERM_MINUTES);
  assert.match(a.act('bank.loan', { ...BANK, amount: 200 }).error, /repay your loan/);

  // Another region's bank knows nothing of it.
  a.player.rpg.location = WR;
  await world.ctx.services.townCountersSettled(WR);
  a.moveTo(0, 4);
  assert.match(a.act('bank.repay', { counterId: 'b:0,0:1', amount: 10 }).error, /owe nothing/);

  a.player.rpg.location = GG;
  a.moveTo(10, 18);
  a.must('bank.repay', { ...BANK, amount: 200 }); // carried gold first
  assert.equal(a.player.rpg.gold, 100);
  assert.equal(st(a).loans.daggerfall.total, 900);
  a.must('bank.repay', { ...BANK, amount: 1000, fromAccount: true }); // OVERPAID_LOAN: capped at the 900 owed
  assert.equal(st(a).loans.daggerfall, undefined);
  assert.equal(acct(world, a), 100);
});

test('loan default: repaid from the account when it can be, otherwise a single default and refusal', async (t) => {
  const { world } = await makeWorld(t);
  const a = await joinAt(world, 1, 'Debtor', { gold: 5000 });
  a.must('bank.loan', { ...BANK, amount: 1000 });
  a.must('bank.withdraw', { ...BANK, amount: 1000 }); // spend the loan
  a.must('bank.deposit', { ...BANK, amount: 400 });
  const repChanges = []; // FIXTURE stand-in for package 14's law service
  world.ctx.services.law = { changeLegalRep: (pl, region, delta, reason) => repChanges.push([pl.id, region, delta, reason]) };
  const due = st(a).loans.daggerfall.due;
  // Advance the shared clock past the due date (12 game minutes per real second).
  const msToDue = ((due - gameMinutes(world)) + 60) * 5000;
  const reminders = a.mark();
  for (let i = 0; i < 12; i++) world.tick(msToDue / 12);
  assert.ok(gameMinutes(world) > due);
  const loan = st(a).loans.daggerfall;
  assert.equal(acct(world, a), 0, 'the account is emptied towards the debt');
  assert.equal(loan.total, 700);
  assert.equal(loan.defaulted, true);
  assert.equal(loan.reputationLoss, 10);
  assert.deepEqual(repChanges, [[a.player.id, 'Daggerfall', -10, 'loan-default']]);
  const texts = a.since(reminders, 'gameEvent').map((m) => m.event).filter((e) => e.kind === 'property').map((e) => e.text);
  assert.ok(texts.some((x) => /reminder/i.test(x)), texts.join('\n'));
  assert.equal(texts.filter((x) => /defaulted/.test(x)).length, 1);
  world.tick(60_000);
  assert.equal(a.since(reminders, 'gameEvent').filter((m) => /defaulted/.test(m.event.text ?? '')).length, 1, 'defaults once');
  assert.match(a.act('bank.loan', { ...BANK, amount: 100 }).error, /defaulted/);
  a.must('bank.repay', { ...BANK, amount: 700 });
  assert.equal(st(a).loans.daggerfall.total, 0);
  assert.match(a.act('bank.loan', { ...BANK, amount: 100 }).error, /defaulted/, 'a cleared default still bars new loans');
});

test('house and ship: purchase from purse and account, storage, isolation and restart', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  let a = await joinAt(world, 1, 'Owner', { gold: 20_000 });
  let b = await joinAt(world, 2, 'Visitor', { gold: 500 });
  const pid = a.player.id;
  a.must('property.status');
  const status = a.events('property.status').at(-1);
  assert.equal(status.offers.port, true);
  const offer = status.offers.houses.find((h) => h.id === 'b:1,1:4');
  assert.equal(offer.price, 16_000);

  assert.match(a.act('house.buy', { ...BANK, houseId: 'b:9,9:9' }).error, /not for sale/);
  a.must('bank.deposit', { ...BANK, amount: 6000 });
  a.must('house.buy', { ...BANK, houseId: offer.id, expectPrice: 16_000 });
  assert.equal(a.player.rpg.gold, 0); // DeductGoldAmount: 14,000 carried first, then 2,000 from the account
  assert.equal(acct(world, a), 4000);
  assert.match(a.act('house.buy', { ...BANK, houseId: 'b:1,2:5' }).error, /already own a house/);
  assert.equal(world.ctx.services.ownsBuilding(a.player, { to: HOUSE_A }), true);
  assert.equal(world.ctx.services.ownsBuilding(b.player, { to: HOUSE_A }), false);

  // Ship needs 100,000: not affordable, nothing changes.
  const before = JSON.stringify(a.player.rpg);
  assert.match(a.act('ship.buy', { ...BANK, type: 'small' }).error, /costs 100000/);
  assert.equal(JSON.stringify(a.player.rpg), before);

  // A loan pays for it (level 2 lends 100,000), then the ship is bought.
  a.player.rpg.character.level = 2;
  a.must('bank.loan', { ...BANK, amount: 100_000 });
  a.must('ship.buy', { ...BANK, type: 'small', expectPrice: 100_000 });
  assert.equal(st(a).ship.type, 'small');
  assert.equal(acct(world, a), 4000);

  // Store goods inside the house (FIXTURE: the interior location is set directly, interiors are not installed).
  world.ctx.services.giveItem(a.player, 'ruby', 3);
  world.ctx.services.giveItem(a.player, 'iron-longsword', 1);
  const sword = a.player.rpg.inventory.find((i) => i.template === 'iron-longsword');
  if (sword.equipped) a.must('inventory.unequip', { itemId: sword.id });
  a.player.rpg.location = HOUSE_A;
  b.player.rpg.location = HOUSE_A;
  world.tick(100);
  a.must('property.store', { container: 'house:daggerfall', itemId: sword.id });
  a.must('property.store', { container: 'house:daggerfall', itemId: a.player.rpg.inventory.find((i) => i.template === 'ruby').id, quantity: 2 });
  assert.match(b.act('property.take', { container: 'house:daggerfall', itemId: sword.id }).error, /own house/);
  assert.deepEqual(world.ctx.services.propertyContainers(b.player), []);

  // Board the ship and load cargo; the visitor cannot board or fast travel onto the deck.
  a.player.rpg.location = GG;
  a.moveTo(12, -3);
  world.tick(100);
  a.must('ship.board');
  const deck = a.player.rpg.location;
  assert.equal(deck, 'town:31/1');
  world.ctx.services.giveItem(a.player, 'arrow', 30);
  const arrows = a.player.rpg.inventory.find((i) => i.template === 'arrow');
  a.must('property.store', { container: 'ship', itemId: arrows.id, quantity: 30 });
  assert.match(b.act('ship.board').error, /own no ship/);
  b.player.rpg.location = GG;
  assert.ok(!b.act('travel.go', { to: deck }).ok);

  // Restart: same database, fresh runtime.
  world.restart();
  a = await joinAt(world, 1, 'Owner', { gold: a.player.rpg.gold, location: deck, x: 0, z: 0 });
  b = await joinAt(world, 2, 'Visitor', { gold: 500, location: deck, x: 0, z: 0 });
  assert.equal(a.player.id, pid);
  const saved = readPersisted(dbPath, pid).rpg.property;
  assert.equal(saved.ship.type, 'small');
  assert.equal(saved.houses.daggerfall.interior, HOUSE_A);
  assert.equal(saved.stores.ship.find((r) => r.template === 'arrow').quantity, 30);
  assert.equal(saved.stores['house:daggerfall'].find((r) => r.template === 'iron-longsword').id, sword.id);
  assert.equal(saved.loans.daggerfall.total, 110_000);
  assert.deepEqual(world.ctx.services.propertyContainers(b.player), [], 'the visitor sees no hold on the same deck');
  const hold = world.ctx.services.propertyContainers(a.player).find((s) => s.id === 'ship');
  assert.equal(hold.items.find((r) => r.template === 'arrow').quantity, 30);

  // Return trip: leave the ship where it was boarded, then into the house for the sword (same id).
  a.must('ship.leave');
  assert.equal(a.player.rpg.location, GG);
  assert.deepEqual([a.player.x, a.player.z], [12, -3]);
  a.player.rpg.location = HOUSE_A;
  a.must('property.take', { container: 'house:daggerfall', itemId: sword.id });
  assert.ok(a.player.rpg.inventory.some((i) => i.id === sword.id));

  // Selling: belongings must be taken out first; the deed sells at 85% into the account.
  a.player.rpg.location = GG;
  a.moveTo(10, 18);
  await world.ctx.services.townCountersSettled(GG);
  assert.match(a.act('house.sell', BANK).error, /still holds belongings/);
  a.player.rpg.location = HOUSE_A;
  const ruby = st(a).stores['house:daggerfall'].find((r) => r.template === 'ruby');
  a.must('property.take', { container: 'house:daggerfall', itemId: ruby.id });
  a.player.rpg.location = GG;
  const balance = acct(world, a);
  a.must('house.sell', BANK);
  assert.equal(acct(world, a), balance + 13_600);
  assert.equal(world.ctx.services.ownsBuilding(a.player, { to: HOUSE_A }), false);
});

test('wagon: needs a cart, 750 kg limit, dungeon exit reach, persists after restart', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  let a = await joinAt(world, 1, 'Carter', { gold: 1000 });
  const pid = a.player.id;
  world.ctx.services.giveItem(a.player, 'iron-claymore', 1);
  const blade = a.player.rpg.inventory.find((i) => i.template === 'iron-claymore');
  assert.match(a.act('property.store', { container: 'wagon', itemId: blade.id }).error, /no wagon/);
  world.ctx.services.giveItem(a.player, 'small-cart', 1);
  a.must('property.store', { container: 'wagon', itemId: blade.id });
  a.must('property.store', { container: 'wagon', itemId: 'gold', quantity: 400 });
  assert.equal(a.player.rpg.gold, 600);
  // Weight limit: invented heavy record (FIXTURE).
  a.player.rpg.property.stores.wagon.push({ id: 'heavy-1', template: 'iron-claymore', name: 'Anvil (fixture)', weight: WAGON_KG_LIMIT - 5, quantity: 1 });
  world.ctx.services.giveItem(a.player, 'iron-claymore', 1);
  const second = a.player.rpg.inventory.find((i) => i.template === 'iron-claymore');
  assert.match(a.act('property.store', { container: 'wagon', itemId: second.id }).error, /750 kg/);
  a.player.rpg.property.stores.wagon.pop();
  // Inside a dungeon only near an exit (portal registry stub: FIXTURE).
  a.player.rpg.location = 'dungeon:Daggerfall/Privateer\'s Hold';
  world.ctx.services.portals = { into: () => ({ exits: [{ x: 0, z: 0 }] }) };
  a.moveTo(20, 20);
  assert.match(a.act('property.take', { container: 'wagon', itemId: blade.id }).error, /outside/);
  a.moveTo(3, 3);
  a.must('property.take', { container: 'wagon', itemId: blade.id });
  delete world.ctx.services.portals;
  a.player.rpg.location = GG;
  world.restart();
  a = await joinAt(world, 1, 'Carter', { gold: 600 });
  assert.equal(a.player.id, pid);
  const wagon = readPersisted(dbPath, pid).rpg.property.stores.wagon;
  assert.deepEqual(wagon.map((r) => [r.template, r.quantity]), [['gold', 400]]);
  a.must('property.take', { container: 'wagon', itemId: 'gold' });
  assert.equal(a.player.rpg.gold, 1000);
});

test('a refused journey preserves a loan; a completed journey past its due date defaults only the traveller, once', async (t) => {
  const { world, dbPath } = await makeWorld(t, [...FEATURES, { name: 'calendar', install: calendar }, { name: 'law', install: law }]);
  const a = await joinAt(world, 1, 'Traveller', { gold: 500 });
  const b = await joinAt(world, 2, 'Waker', { gold: 500, x: 9, z: 18 });
  a.must('bank.loan', { ...BANK, amount: 1000 });
  b.must('bank.loan', { ...BANK, amount: 1000 });
  a.must('bank.withdraw', { ...BANK, amount: 1000 });
  b.must('property.status');
  const listing = JSON.stringify(b.events('property.status').at(-1).offers.houses);
  const bLoan = { ...st(b).loans.daggerfall };
  const sharedMinute = gameMinutes(world);
  // Stage A one minute before the due date, then use the same travel action as the map.
  const services = world.ctx.services;
  services.spendTime(a.player, st(a).loans.daggerfall.due - services.playerMinutes(a.player) - 1, 'rest');
  const departure = services.playerMinutes(a.player);
  const trip = { to: 'town:Daggerfall/Daggerfall', options: { lodging: 'camp' }, requestId: 'property-trip-1' };
  world.ctx.entities.set('fixture-orc', { kind: 'monster', location: GG, x: a.player.x, z: a.player.z, hp: 5 });
  assert.match(a.act('travel.go', trip).error, /enemies nearby/);
  assert.equal(services.playerMinutes(a.player), departure);
  assert.equal(a.player.rpg.location, GG);
  assert.equal(st(a).loans.daggerfall.defaulted, false);
  world.ctx.entities.delete('fixture-orc');
  a.must('travel.go', trip);
  const arrived = services.playerMinutes(a.player);
  assert.equal(arrived, departure + a.player.rpg.travel.lastTrip.minutes);
  assert.ok(arrived > st(a).loans.daggerfall.due);
  assert.equal(st(a).loans.daggerfall.defaulted, true);
  assert.equal(st(a).loans.daggerfall.total, 1100, 'nothing in A’s account to take');
  assert.equal(services.law.legalRep(a.player, 'Daggerfall'), -10);
  assert.equal(services.law.legalRep(a.player, 'Wayrest'), 0);
  assert.equal(services.law.legalRep(b.player, 'Daggerfall'), 0);
  assert.deepEqual(st(b).loans.daggerfall, bLoan);
  assert.equal(gameMinutes(world), sharedMinute);
  b.must('property.status');
  assert.equal(JSON.stringify(b.events('property.status').at(-1).offers.houses), listing, 'house listings follow the shared clock');
  const saved = readPersisted(dbPath, a.player.id).rpg;
  assert.equal(saved.location, trip.to);
  assert.equal(saved.property.loans.daggerfall.defaulted, true);
  world.restart();
  const back = world.connect(1, 'Traveller');
  back.must('travel.go', trip);
  assert.equal(world.ctx.services.playerMinutes(back.player), arrived);
  assert.equal(back.player.rpg.travel.trips, 1);
  assert.equal(world.ctx.services.law.legalRep(back.player, 'Daggerfall'), -10);
  assert.deepEqual(st(back).loans.daggerfall, saved.property.loans.daggerfall);
});

test('normalizeProperty drops malformed and prototype keys', () => {
  const rpg = { property: { loans: { __proto__x: 1, daggerfall: { region: 'Daggerfall', total: 5, due: 9 }, bad: { region: 'Wayrest', total: 3 } },
    houses: { daggerfall: { region: 'Daggerfall', town: GG, interior: HOUSE_A, price: 9 } }, ship: { type: 'raft' },
    stores: { wagon: [{ id: 'a', template: 'ruby', quantity: 2, equipped: 'x' }, { template: 'gold', quantity: 0 }], evil: [{ id: 'b', template: 'ruby' }] } } };
  const p = normalizeProperty(rpg);
  assert.deepEqual(Object.keys(p.loans), ['daggerfall']);
  assert.equal(p.ship, null);
  assert.deepEqual(Object.keys(p.stores), ['wagon']);
  assert.equal(p.stores.wagon.length, 1);
  assert.equal(p.stores.wagon[0].equipped, undefined);
});

test('installed data: Gothway Garden residences price from their models, port flag read', { skip: !localArena2() && 'ARENA2 is not installed' }, async () => {
  const { arena2ServiceLoader } = await import('../server/rpg/townServices/buildings.js');
  const load = arena2ServiceLoader(localArena2());
  const gg = await load(GG);
  assert.ok(gg.houses.length > 0, 'residences found');
  for (const h of gg.houses) assert.ok(h.radius > 0 && housePrice(h.radius) > 0 && h.interior.startsWith('interior:'));
  const offers = housesForSale(gg.houses, { town: GG, monthIndex: 0, buildingCount: gg.buildingCount });
  assert.ok(offers.length >= 1 && offers.length <= 20);
  assert.equal(typeof gg.port, 'boolean');
  const df = await load('town:Daggerfall/Daggerfall');
  assert.equal(df.port, true, 'the city of Daggerfall is a port');
});

test('installed data: both "Your Ship" decks load with an arrival point (no street spawn)', { skip: !localArena2() && 'ARENA2 is not installed' }, async () => {
  const { arena2Files } = await import('../server/rpg/collision/arena2.js');
  const { loadTown } = await import('../client/world/town.js');
  const files = await arena2Files(localArena2());
  for (const location of [1, 2]) {
    const t = await loadTown(files, { region: 31, location, worldData: null, flatColliders: false });
    assert.equal(t.name, 'Your Ship');
    assert.ok(t.positions.length > 0 && t.bounds.maxY > 20, 'the ship model is drawn');
  }
});

// The two original decks: the arrival stands on the deck, and the walked way down to the cabin door (ARENA2 coordinates
// measured from the installed SHIPAA00/SHIPAA01 blocks) leads into the ship's interior for its owner only.
const SHIP_ROUTES = {
  small: { deckY: 9.075, route: [[14, -3], [28, -3], [28, 0], [18.3, -0.2]], doorFloor: 2.6 },
  large: { deckY: 10.6, route: [[1, 1], [1, 16.5], [1, 8], [0.85, -6], [0.85, -12.6]], doorFloor: 3.42 },
};
test('installed data: both ships land on deck, keep it across restart, and the walked way reaches the cabin for the owner only',
  { skip: !localArena2() && 'ARENA2 is not installed', timeout: 240_000 }, async (t) => {
    const { install: collision } = await import('../server/rpg/collision.js');
    const { install: interiors } = await import('../server/rpg/interiors.js');
    const { install: automap } = await import('../server/rpg/automap.js');
    const features = [FEATURES[0], { name: 'collision', install: collision }, FEATURES[2], { name: 'interiors', install: interiors },
      FEATURES[1], ...FEATURES.slice(3), { name: 'automap', install: automap }];
    const { dir } = tempDir('dfw-property-ship-');
    const dbPath = join(dir, 'world.db');
    const world = await createFixtureWorld({ dbPath, features, dataPath: localArena2() });
    t.after(() => { world.close(); rmSync(dir, { recursive: true, force: true }); });
    assert.deepEqual(world.installErrors, []);
    const S = () => world.ctx.services;
    const join2 = async (account, name, type) => {
      const c = await joinAt(world, account, name, { x: 12, z: -3 });
      if (type) c.player.rpg.property.ship = { type, boughtAt: 0 }; // FIXTURE: the deed (purchase is covered above)
      return c;
    };
    const walk = (c, route) => {
      const p = c.player;
      for (const [tx, tz] of route) {
        for (let i = 0; i < 300 && Math.hypot(tx - p.x, tz - p.z) >= 0.2; i++) {
          const yaw = Math.atan2(tx - p.x, -(tz - p.z));
          const r = S().stepPlayer(p, { forward: 1, strafe: 0, yaw }, 0.05);
          Object.assign(p, { x: r.x, z: r.z, yaw });
        }
      }
      return S().collision.bodyOf(p);
    };
    const footY = (c) => { S().stepPlayer(c.player, { forward: 0, strafe: 0, yaw: c.player.yaw }, 0.05); return S().collision.bodyOf(c.player).y; };

    let a = await join2(1, 'Sailor', 'small');
    let b = await join2(2, 'Captain', 'large');
    await new Promise((r) => setTimeout(r, 300)); // travel catalogue names the decks
    world.tick(100);
    const deckA = S().property.shipLocation('small'), deckB = S().property.shipLocation('large');
    assert.notEqual(deckA, deckB);
    await Promise.all([GG, deckA, deckB].map((l) => S().collision.whenSettled(l)));
    for (const [c, type, deck] of [[a, 'small', deckA], [b, 'large', deckB]]) {
      c.must('ship.board');
      assert.equal(c.player.rpg.location, deck);
      const tp = c.events('teleport').at(-1);
      assert.ok(Math.abs(tp.y - SHIP_ROUTES[type].deckY) < 0.01, `${type}: teleport onto the deck (${tp.y})`);
      world.tick(100);
      assert.ok(Math.abs(footY(c) - SHIP_ROUTES[type].deckY) < 0.01, `${type}: the server body stands on the deck`);
    }

    // Normal reconnect and a cold restart both put the body back on the deck, not in the water.
    world.restart();
    a = await joinAt(world, 1, 'Sailor', { location: deckA, x: 0, z: 0 });
    b = await joinAt(world, 2, 'Captain', { location: deckB, x: 0, z: 0 });
    await Promise.all([deckA, deckB].map((l) => S().collision.whenSettled(l)));
    assert.ok(Math.abs(footY(a) - SHIP_ROUTES.small.deckY) < 0.01);
    assert.ok(Math.abs(footY(b) - SHIP_ROUTES.large.deckY) < 0.01);
    assert.equal(st(a).ship.type, 'small');
    assert.deepEqual([st(a).board.x, st(a).board.z], [12, -3]);

    // Walk the original way down to each cabin door and go in (PlayerActivate: a ship door opens for its owner).
    for (const [c, type, deck] of [[a, 'small', deckA], [b, 'large', deckB]]) {
      const body = walk(c, SHIP_ROUTES[type].route);
      assert.ok(Math.abs(body.y - SHIP_ROUTES[type].doorFloor) < 0.05, `${type}: reached the cabin door floor (${body.y})`);
      await S().interiors.survey(deck);
      c.must('portal.use', { portalId: 'b:0,0:0' });
      assert.match(c.player.rpg.location, /^interior:/);
      assert.deepEqual(S().propertyContainers(c.player).map((s) => s.id), ['ship']);
    }
    // Cargo is per owner: the small ship's cabin is not the captain's, and the hold is private.
    S().giveItem(a.player, 'ruby', 2);
    a.must('property.store', { container: 'ship', itemId: a.player.rpg.inventory.find((i) => i.template === 'ruby').id, quantity: 2 });
    assert.equal(S().ownsBuilding(b.player, { to: a.player.rpg.location, meta: { buildingType: 24 } }), false);
    assert.equal(S().ownsBuilding(a.player, { to: a.player.rpg.location, meta: { buildingType: 24 } }), true);
    assert.equal(S().propertyContainers(b.player).find((s) => s.id === 'ship').items.length, 0);

    // Back out of the cabin onto the lower deck, then ashore where they boarded.
    world.tick(1100);
    for (const [c, type] of [[a, 'small'], [b, 'large']]) {
      c.must('portal.leave');
      await S().collision.whenSettled(c.player.rpg.location);
      assert.ok(Math.abs(footY(c) - SHIP_ROUTES[type].doorFloor) < 0.05, `${type}: out of the cabin on the floor by its door`);
      c.must('ship.leave');
      assert.equal(c.player.rpg.location, GG);
      assert.deepEqual([c.player.x, c.player.z], [12, -3]);
    }
    assert.equal(readPersisted(dbPath, a.player.id).rpg.property.stores.ship[0].quantity, 2);
  });

// The cabin door is under walkable decks. Standing on the deck straight above it must not open it: the server and
// the Play prompt compare the foot height with the doorway's bottom edge (measured 2.6 m small, 3.425 m large).
// Two owners of the same ship type share the deck and cabin (one DFU scene per type) but not cargo or shore return.
test('installed data: a cabin door opens from its own deck only, and two owners of one ship type stay private',
  { skip: !localArena2() && 'ARENA2 is not installed', timeout: 240_000 }, async (t) => {
    const { install: collision } = await import('../server/rpg/collision.js');
    const { install: interiors } = await import('../server/rpg/interiors.js');
    const { install: automap } = await import('../server/rpg/automap.js');
    const { townDoors, nearestDoor } = await import('../client/gameplay/interiors.js');
    const { locationPortals, openWorldData } = await import('../client/world/interiors/index.js');
    const { operatorFiles } = await import('../server/rpg/interiors/data.js');
    const { loadTown } = await import('../client/world/town.js');
    const files = await operatorFiles(localArena2());
    const data = await openWorldData(files);
    const playDoors = async (location) => {
      const town = await loadTown(files, { region: 31, location, worldData: null, flatColliders: false });
      return townDoors(await locationPortals(data, { region: town.source.regionIndex, location: town.source.locationIndex }, town.source.spawnLocal));
    };
    const features = [FEATURES[0], { name: 'collision', install: collision }, FEATURES[2], { name: 'interiors', install: interiors },
      FEATURES[1], ...FEATURES.slice(3), { name: 'automap', install: automap }];
    const { dir } = tempDir('dfw-property-cabin-');
    const dbPath = join(dir, 'world.db');
    const world = await createFixtureWorld({ dbPath, features, dataPath: localArena2() });
    t.after(() => { world.close(); rmSync(dir, { recursive: true, force: true }); });
    assert.deepEqual(world.installErrors, []);
    const S = () => world.ctx.services;
    const DOOR = 'b:0,0:0';
    const walk = (c, route) => {
      const p = c.player;
      for (const [tx, tz] of route) {
        for (let i = 0; i < 400 && Math.hypot(tx - p.x, tz - p.z) >= 0.2; i++) {
          const yaw = Math.atan2(tx - p.x, -(tz - p.z));
          const r = S().stepPlayer(p, { forward: 1, strafe: 0, yaw }, 0.05);
          Object.assign(p, { x: r.x, z: r.z, yaw });
        }
      }
      return S().collision.bodyOf(p).y;
    };
    const owner = async (account, name, type, x) => {
      const c = await joinAt(world, account, name, { x, z: -3 });
      c.player.rpg.property.ship = { type, boughtAt: 0 }; // FIXTURE: the deed (purchase is covered above)
      return c;
    };
    // Two large-ship owners boarding from different shore points, and a small-ship owner.
    let a = await owner(1, 'Mara', 'large', 12);
    let b = await owner(2, 'Oswin', 'large', 14);
    let s = await owner(3, 'Tamsin', 'small', 16);
    await new Promise((r) => setTimeout(r, 300)); // travel catalogue names the decks
    world.tick(100);
    const LARGE = S().property.shipLocation('large'), SMALL = S().property.shipLocation('small');
    await Promise.all([GG, LARGE, SMALL].map((l) => S().collision.whenSettled(l)));
    for (const c of [a, b, s]) c.must('ship.board');
    assert.equal(a.player.rpg.location, LARGE);
    assert.equal(b.player.rpg.location, LARGE, 'one deck per ship type (DFU has no per-owner ship scene)');
    world.tick(100);
    await Promise.all([LARGE, SMALL].map((l) => S().interiors.survey(l)));

    // The deck above the door: x/z are in reach (the measured fault opened it), the foot height is not.
    for (const [c, deck, over] of [[a, LARGE, [[0.85, -13.5]]], [s, SMALL, [[16.99, -3], [16.99, -0.3]]]]) {
      const y = walk(c, over);
      const door = S().portals.get(deck, DOOR).entrances[0];
      assert.ok(y - door.floor > 2.5, `${deck}: standing on a deck above the door (${y} over ${door.floor})`);
      assert.ok(Math.hypot(door.x - c.player.x, door.z - c.player.z) <= S().portals.reach);
      assert.throws(() => S().portals.planEnter(deck, { x: c.player.x, z: c.player.z }, DOOR), /too far/, 'no foot height: refused');
      assert.match(c.act('portal.use', { portalId: DOOR }).error, /too far/);
      assert.equal(c.player.rpg.location, deck);
      // The Play prompt reads the same door from the player's files and offers nothing at this eye height.
      const doors = await playDoors(deck === LARGE ? 2 : 1);
      assert.equal(nearestDoor(doors, door.x, door.z, 2.4, y + 1.6), null, `${deck}: no prompt on the deck above`);
      assert.equal(nearestDoor(doors, door.x, door.z, 2.4, door.floor + 1.6)?.portalId, DOOR, `${deck}: prompt at the door floor`);
    }
    // The mid deck on the large ship's approach is also refused.
    world.tick(1100);
    assert.ok(Math.abs(walk(b, [[1, 1], [1, 16.5], [1, 8], [0.85, -6], [0.85, -10]]) - 4.85) < 0.05);
    assert.match(b.act('portal.use', { portalId: DOOR }).error, /too far/);

    // The normal approach down to the cabin door opens it for each owner at once.
    for (const [c, route] of [
      [a, [[1, 1], [1, 16.5], [1, 8], [0.85, -6], [0.85, -12.6]]],
      [b, [[0.85, -12.6]]],
      [s, [[28, -3], [28, 0], [18.3, -0.2]]],
    ]) {
      const y = walk(c, route);
      const deck = c.player.rpg.location;
      assert.ok(Math.abs(y - S().portals.get(deck, DOOR).entrances[0].floor) < 0.05, `${c.player.name}: at the cabin door floor (${y})`);
      world.tick(1100);
      c.must('portal.use', { portalId: DOOR });
    }
    const cabin = a.player.rpg.location;
    assert.match(cabin, /^interior:/);
    assert.equal(b.player.rpg.location, cabin, 'the two large-ship owners share one cabin instance');
    assert.notEqual(s.player.rpg.location, cabin);

    // Cargo stays with its owner even in the shared cabin.
    S().giveItem(a.player, 'ruby', 2);
    S().giveItem(b.player, 'ruby', 5);
    const rubyOf = (c) => c.player.rpg.inventory.find((i) => i.template === 'ruby').id;
    a.must('property.store', { container: 'ship', itemId: rubyOf(a), quantity: 2 });
    b.must('property.store', { container: 'ship', itemId: rubyOf(b), quantity: 5 });
    const hold = (c) => S().propertyContainers(c.player).find((x) => x.id === 'ship').items.map((i) => i.quantity);
    assert.deepEqual(hold(a), [2]);
    assert.deepEqual(hold(b), [5]);
    assert.equal(b.act('property.take', { container: 'ship', itemId: st(a).stores.ship[0].id, quantity: 2 }).ok, false);
    assert.deepEqual(hold(a), [2]);

    // Each owner returns to their own shore point, and it survives a restart.
    world.tick(1100);
    for (const c of [a, b]) {
      c.must('portal.leave');
      await S().collision.whenSettled(c.player.rpg.location);
      assert.equal(c.player.rpg.location, LARGE);
    }
    world.restart();
    a = await joinAt(world, 1, 'Mara', { location: LARGE, x: 0.85, z: -12.6 });
    b = await joinAt(world, 2, 'Oswin', { location: LARGE, x: 0.85, z: -12.6 });
    await S().collision.whenSettled(LARGE);
    a.must('ship.leave');
    b.must('ship.leave');
    assert.deepEqual([a.player.rpg.location, a.player.x, a.player.z], [GG, 12, -3]);
    assert.deepEqual([b.player.rpg.location, b.player.x, b.player.z], [GG, 14, -3]);
    assert.deepEqual(readPersisted(dbPath, a.player.id).rpg.property.stores.ship.map((i) => i.quantity), [2]);
    assert.deepEqual(readPersisted(dbPath, b.player.id).rpg.property.stores.ship.map((i) => i.quantity), [5]);
  });

test('cart: ride the small cart at the classic cart speed; wagon gold and letters of credit pay; the deed is in the notebook', async (t) => {
  const { install: automap } = await import('../server/rpg/automap.js');
  const { rideSpeed, WALK_SPEED } = await import('../client/gameplay/mount/rules.js');
  const { world } = await makeWorld(t, [...FEATURES, { name: 'automap', install: automap }]);
  const a = await joinAt(world, 1, 'Carter', { gold: 100 });
  const S = world.ctx.services;
  assert.match(a.act('mount.ride', { mode: 'cart' }).error, /no cart/);
  S.giveItem(a.player, 'small-cart', 1);
  a.must('mount.ride', {}); // ToggleMount: no horse, so the cart
  assert.equal(S.mount.mode(a.player), 'cart');
  assert.equal(S.moveSpeed(a.player), rideSpeed(a.player.rpg.character, WALK_SPEED, 'cart'));
  assert.equal(rideSpeed({ attributes: { Speed: 50 } }, 4, 'cart'), 6); // (50 + dfCartBase 250) / (50 + 150) of the walk
  world.tick(100);
  assert.equal(a.events('mount').at(-1).mode, 'cart');
  a.must('mount.ride', { on: false });
  assert.equal(S.moveSpeed(a.player), null);
  a.must('mount.ride', { on: true, mode: 'cart' });
  a.player.rpg.location = HOUSE_A; // indoors: the cart waits outside
  world.tick(100);
  assert.equal(S.mount.isRiding(a.player), false);
  a.player.rpg.location = GG;

  // DepositGold: the purse first, then the wagon's gold.
  S.giveItem(a.player, 'gold', 900);
  a.must('property.store', { container: 'wagon', itemId: 'gold', quantity: 800 });
  assert.equal(a.player.rpg.gold, 200);
  assert.match(a.act('bank.deposit', { ...BANK, amount: 1001 }).error, /200 gold and 800 in your wagon/);
  a.must('bank.deposit', { ...BANK, amount: 900 });
  assert.equal(a.player.rpg.gold, 0);
  assert.equal(S.property.wagonGold(a.player), 100);
  assert.equal(acct(world, a), 900);

  // A house paid with a letter of credit (GetGoldAmount counts it), the rest from the account.
  S.bankAdjust(a.player, 'Daggerfall', 20_000);
  a.must('bank.letter', { ...BANK, amount: 10_000 });
  assert.equal(acct(world, a), 20_900 - 10_100);
  a.must('house.buy', { ...BANK, houseId: 'b:1,1:4', expectPrice: 16_000 });
  assert.equal(a.player.rpg.inventory.filter((i) => i.template === 'letter-of-credit').length, 0);
  assert.equal(acct(world, a), 10_800 - 6000);
  const book = a.player.rpg.automap.notebook;
  assert.match(book.at(-1).text, /Deed: you own a house in Gothway Garden, Daggerfall/);
  assert.equal(a.player.rpg.automap.names[GG]['b:1,1:4'], "Carter's house");
  a.must('house.sell', BANK);
  assert.equal(a.player.rpg.automap.names[GG]?.['b:1,1:4'], undefined);
});

test('grantHouse: a knight\'s free house is allocated like a purchase at price 0, once per region', async (t) => {
  const { install: automap } = await import('../server/rpg/automap.js');
  const { world } = await makeWorld(t, [...FEATURES, { name: 'automap', install: automap }]);
  const a = await joinAt(world, 1, 'Knight', { gold: 50 });
  const S = world.ctx.services;
  const before = acct(world, a);
  const r = S.property.grantHouse(a.player, { town: GG, random: () => 0 });
  assert.equal(r.status, 'granted');
  assert.equal(r.house.price, 0);
  assert.equal(r.house.interior, HOUSE_A);
  assert.equal(a.player.rpg.gold, 50);
  assert.equal(acct(world, a), before);
  assert.equal(S.ownsBuilding(a.player, { to: HOUSE_A }), true);
  assert.match(a.player.rpg.automap.notebook.at(-1).text, /Deed: you own a house in Gothway Garden/);
  assert.equal(S.property.grantHouse(a.player, { town: GG }).status, 'owned');
  const b = await joinAt(world, 2, 'Squire', { location: WR, x: 0, z: 4 });
  assert.equal(S.property.grantHouse(b.player, { town: WR }).status, 'none');
});

test('ship.board waits for the deck: no landing without a foot height (Play stood beside the hull at y 0)', async (t) => {
  // FIXTURE collision: the deck area is still loading (no ground), then settles at the small ship's 9.075 m deck.
  let deckY = null;
  const preloads = [];
  const stub = { name: 'collision-stub', install: (ctx) => { ctx.services.collision = { groundAt: (loc) => (loc === 'town:31/1' ? deckY : 0), preload: (loc) => preloads.push(loc) }; } };
  const { world } = await makeWorld(t, [stub, ...FEATURES]);
  const a = await joinAt(world, 1, 'Sailor', { location: GG, x: 12, z: -3 });
  a.player.rpg.property.ship = { type: 'small', boughtAt: 0 }; // FIXTURE: the deed (purchase is covered above)
  const requestId = req();
  assert.match(a.act('ship.board', { requestId }).error, /being made ready/);
  assert.equal(a.player.rpg.location, GG, 'still ashore');
  assert.equal(st(a).board ?? null, null, 'no boarding point kept');
  assert.equal(a.events('teleport').length, 0, 'no landing was sent');
  assert.ok(preloads.includes('town:31/1'), 'the deck load was started');
  deckY = 9.075;
  a.must('ship.board', { requestId }); // the refused claim was rolled back, so the same request now boards
  assert.equal(a.player.rpg.location, 'town:31/1');
  assert.equal(a.events('teleport').at(-1).y, 9.075, 'the landing names the deck');
});
