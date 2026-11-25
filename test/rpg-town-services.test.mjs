// Town services: classic regional banking, letters of credit and item repair.
// Real runtime (atomic actions, rollback), real inventory, real shared clock (atmosphere with a
// controlled wall clock), real NPC rosters and a FIXTURE counter loader. The last case reads the
// operator's ARENA2 directory when it is present and is skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as atmosphere } from '../server/rpg/atmosphere.js';
import { install as npcs, rosterFor } from '../server/rpg/npcs.js';
import { install as townServices, normalizeState } from '../server/rpg/townServices.js';
import { countersFromPortals, arena2ServiceLoader } from '../server/rpg/townServices/buildings.js';
import {
  repairCost, repairMinutes, letterCost, shopCost, fightersDiscount, placeOf, DOOR_REACH,
} from '../client/gameplay/townServices/rules.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GG = 'town:Daggerfall/Gothway Garden';
const WR = 'town:Wayrest/Wayrest';
const DF = 'town:Daggerfall/Daggerfall';

// FIXTURE counters (positions are invented for the test, not game data).
const FIXTURE = {
  [GG]: [
    { id: 'b:2,0:15', kind: 'building', type: 'bank', buildingType: 3, services: ['bank'], name: 'Bank', quality: 15, interior: 'interior:Daggerfall/Gothway Garden/2,0/15', doors: [{ x: 10, z: 20 }] },
    { id: 'b:2,1:15', kind: 'building', type: 'general', buildingType: 9, services: ['repair'], name: 'General Store', quality: 19, interior: null, doors: [{ x: -10, z: 20 }] },
    { id: 'b:3,0:14', kind: 'building', type: 'general', buildingType: 9, services: ['repair'], name: 'General Store II', quality: 3, interior: null, doors: [{ x: 40, z: 40 }] },
  ],
  [WR]: [{ id: 'b:0,0:1', kind: 'building', type: 'bank', buildingType: 3, services: ['bank'], name: 'Bank', quality: 10, interior: null, doors: [{ x: 0, z: 5 }] }],
};

function world({ failSave = () => false } = {}) {
  let wall = Date.UTC(2026, 5, 1);
  let mono = 0;
  const players = new Map();
  const sent = [];
  const saves = [];
  const rt = createRpgRuntime({
    players,
    features: [
      { name: 'inventory', install: inventory },
      { name: 'atmosphere', install: (ctx) => atmosphere(ctx, { wallNow: () => wall }) },
      { name: 'npcs', install: npcs },
      { name: 'townServices', install: (ctx) => townServices(ctx, { loadCounters: async (town) => ({ counters: FIXTURE[town] ?? [], source: 'fixture' }) }) },
    ],
    save: (list) => {
      if (failSave()) throw new Error('disk full');
      saves.push(list.map((p) => JSON.parse(JSON.stringify(p.rpg))));
    },
    send: (p, msg) => sent.push({ to: p.id, msg: JSON.parse(JSON.stringify(msg)) }),
    now: () => mono,
    log: { info() {}, warn() {}, error() {} },
  });
  const join = (id, location = GG, rpg = {}) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: { location, ...rpg } };
    players.set(id, p);
    rt.join(p);
    rt.tick(0.1, mono);
    return p;
  };
  const events = (p, kind) => sent.filter((s) => s.to === p.id && s.msg.type === 'gameEvent' && s.msg.event.kind === kind).map((s) => s.msg.event);
  return {
    rt, players, sent, saves, join, events,
    act: (p, verb, args) => rt.act(p, verb, args),
    advanceGameMinutes: (m) => { wall += (m * 60 * 1000) / 12; },
    settle: async (town) => rt.ctx.services.townCountersSettled(town),
  };
}

const at = (p, x, z) => Object.assign(p, { x, z });
const bal = (w, p, region) => w.rt.ctx.services.bankBalance(p, region);

test('rules: classic cost, time and letter formulas', () => {
  assert.equal(shopCost(9, 10), 18); // quality 10 doubles
  assert.equal(shopCost(9, 20), 18); // 2 * (90/100 + 9), integer division as in C#
  assert.equal(shopCost(100, 20), 220);
  assert.equal(shopCost(100, 1), 2 * (-9 + 100));
  // longsword value 90 (cost base 9) at quality 15: 2*(9*5/100 + 9) = 18
  assert.equal(repairCost({ value: 90, condition: 10, maxCondition: 100 }, 15), 18);
  assert.equal(repairCost({ value: 90, condition: 100, maxCondition: 100 }, 15), 0);
  assert.equal(repairCost({ value: 5, condition: 1, maxCondition: 10 }, 10), 2); // minimum base 1
  assert.equal(fightersDiscount(100, 0), 100);
  assert.equal(fightersDiscount(100, 9), 9); // ((1 << 8) / 10 * 100) >> 8, integer maths
  assert.equal(repairMinutes({ condition: 999, maxCondition: 1000 }), 1440); // at least a day
  assert.equal(repairMinutes({ condition: 0, maxCondition: 2000 }), 2880);
  assert.equal(letterCost(100), 101);
  assert.equal(letterCost(250), 252);
  assert.deepEqual(placeOf('interior:Daggerfall/Gothway Garden/2,0/15'), {
    kind: 'interior', region: 'Daggerfall', location: 'Gothway Garden', town: GG, counterId: 'b:2,0:15',
  });
});

test('bank: deposit and withdraw only at the bank door, validated against gold and balance', async () => {
  const w = world();
  const p = w.join(1);
  await w.settle(GG);
  const start = p.rpg.gold;
  assert.ok(start > 0, 'starter gold');

  // Far away: refused, nothing changes.
  let r = w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /must be at Bank/);
  // A repair counter does not bank.
  at(p, -10, 19);
  r = w.act(p, 'bank.deposit', { counterId: 'b:2,1:15', amount: 10 });
  assert.match(r.error, /does not offer/);

  at(p, 10, 20 - DOOR_REACH + 0.5);
  r = w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: start + 1 });
  assert.match(r.error, /only have/);
  for (const bad of [0, -5, 1.5, '10', null]) assert.equal(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: bad }).ok, false);
  assert.equal(p.rpg.gold, start);

  assert.deepEqual(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 20 }), { ok: true });
  assert.equal(p.rpg.gold, start - 20);
  assert.equal(bal(w, p, 'Daggerfall'), 20);
  assert.equal(w.saves.at(-1)[0].townServices.accounts.daggerfall.gold, 20, 'balance saved in the same transaction');
  assert.equal(w.saves.at(-1)[0].gold, start - 20);

  r = w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 21 });
  assert.match(r.error, /holds only 20/);
  assert.equal(w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 5 }).ok, true);
  assert.equal(p.rpg.gold, start - 15);
  assert.equal(bal(w, p, 'Daggerfall'), 15);

  // Inside the bank's own interior counts as at the bank; another building's interior does not.
  at(p, 500, 500);
  p.rpg.location = 'interior:Daggerfall/Gothway Garden/2,0/15';
  assert.equal(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 1 }).ok, true);
  p.rpg.location = 'interior:Daggerfall/Gothway Garden/2,1/15';
  assert.match(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 1 }).error, /must be at Bank/);
});

test('bank: accounts are per region; letters of credit carry gold between regions', async () => {
  const w = world();
  const p = w.join(1);
  await w.settle(GG);
  at(p, 10, 19);
  p.rpg.gold = 1000;
  assert.equal(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 600 }).ok, true);

  assert.match(w.act(p, 'bank.letter', { counterId: 'b:2,0:15', amount: 99 }).error, /at least 100/);
  assert.match(w.act(p, 'bank.letter', { counterId: 'b:2,0:15', amount: 600 }).error, /costs 606/);
  assert.equal(w.act(p, 'bank.letter', { counterId: 'b:2,0:15', amount: 500 }).ok, true);
  assert.equal(bal(w, p, 'Daggerfall'), 95); // 600 - 505
  // A physical Letter of Credit (ItemTemplates 275) in the pack, worth its amount.
  const letters = () => p.rpg.inventory.filter((i) => i.template === 'letter-of-credit');
  assert.equal(letters().length, 1);
  assert.equal(letters()[0].credit.amount, 500);
  assert.equal(letters()[0].value, 500);
  assert.equal(letters()[0].credit.region, 'Daggerfall');
  assert.equal(p.rpg.townServices.letters.length, 0);

  // Travel to Wayrest: the Daggerfall account is not there; the letter is.
  p.rpg.location = WR;
  at(p, 0, 4);
  w.rt.tick(0.1, 0);
  await w.settle(WR);
  assert.match(w.act(p, 'bank.withdraw', { counterId: 'b:0,0:1', amount: 1 }).error, /holds only 0/);
  assert.match(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 1 }).error, /no such counter/);
  assert.equal(w.act(p, 'bank.redeem', { counterId: 'b:0,0:1' }).ok, true);
  assert.equal(bal(w, p, 'Wayrest'), 500);
  assert.equal(bal(w, p, 'Daggerfall'), 95);
  assert.equal(letters().length, 0);
  assert.match(w.act(p, 'bank.redeem', { counterId: 'b:0,0:1' }).error, /no letters/);
});

test('bank: letters of credit are spent like gold and legacy letter records become items', async () => {
  const w = world();
  const p = w.join(1);
  await w.settle(GG);
  at(p, 10, 19);
  p.rpg.gold = 2000;
  assert.equal(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 2000 }).ok, true);
  assert.equal(w.act(p, 'bank.letter', { counterId: 'b:2,0:15', amount: 300 }).ok, true);
  assert.equal(w.act(p, 'bank.letter', { counterId: 'b:2,0:15', amount: 200 }).ok, true);
  const svc = w.rt.ctx.services;
  p.rpg.gold = 50;
  assert.equal(svc.spendableGold(p), 550);
  // PlayerEntity.DeductGoldAmount: gold covers it -> gold only.
  assert.deepEqual(svc.spendGold(p, 40), { gold: 40, credit: 0 });
  assert.equal(p.rpg.gold, 10);
  // More than the purse: letters first (the second keeps its remainder), then no gold needed.
  assert.deepEqual(svc.spendGold(p, 350), { gold: 0, credit: 350 });
  const left = p.rpg.inventory.filter((i) => i.template === 'letter-of-credit');
  assert.equal(left.length, 1);
  assert.equal(left[0].credit.amount, 150);
  assert.equal(p.rpg.gold, 10);
  assert.throws(() => svc.spendGold(p, 1000), /need 1000/);
  assert.equal(svc.spendableGold(p), 160);

  // A character saved with the earlier letter records gets the same letters as items on join.
  const q = w.join(2, GG, { townServices: { letters: [{ id: 'locx', amount: 700, region: 'Wayrest', issuedAt: 5 }] } });
  const got = q.rpg.inventory.filter((i) => i.template === 'letter-of-credit');
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].credit, { amount: 700, region: 'Wayrest', issuedAt: 5 });
  assert.equal(q.rpg.townServices.letters.length, 0);
});

test('bank: retries with the same request id and failed saves never move gold twice', async () => {
  let failNext = false;
  const w = world({ failSave: () => (failNext ? ((failNext = false), true) : false) });
  const p = w.join(1);
  await w.settle(GG);
  at(p, 10, 19);
  p.rpg.gold = 300;

  assert.equal(w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 100, requestId: 'dep-0001' }).ok, true);
  const again = w.act(p, 'bank.deposit', { counterId: 'b:2,0:15', amount: 100, requestId: 'dep-0001' });
  assert.equal(again.ok, false);
  assert.match(again.error, /already done/);
  assert.equal(p.rpg.gold, 200);
  assert.equal(bal(w, p, 'Daggerfall'), 100);

  // The save fails: the whole action is rolled back, including the request id, so a retry works once.
  failNext = true;
  const lost = w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 50, requestId: 'wd-0002' });
  assert.equal(lost.ok, false);
  assert.equal(p.rpg.gold, 200);
  assert.equal(bal(w, p, 'Daggerfall'), 100);
  assert.equal(w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 50, requestId: 'wd-0002' }).ok, true);
  assert.equal(w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 50, requestId: 'wd-0002' }).ok, false);
  assert.equal(p.rpg.gold, 250);
  assert.equal(bal(w, p, 'Daggerfall'), 50);

  // Too heavy to carry: refused.
  p.rpg.townServices.accounts.daggerfall.gold = 1_000_000;
  assert.match(w.act(p, 'bank.withdraw', { counterId: 'b:2,0:15', amount: 1_000_000 }).error, /cannot carry/);
});

test('repair: hand in, wait on the shared clock, collect the same item', async () => {
  const w = world();
  const p = w.join(1);
  await w.settle(GG);
  const svc = w.rt.ctx.services;
  const sword = p.rpg.inventory.find((i) => i.group === 'weapon');
  assert.ok(sword, 'starter weapon');
  if (sword.equipped) assert.equal(w.act(p, 'inventory.unequip', { itemId: sword.id }).ok, true);
  svc.damageItem(p, sword.id, Math.floor(sword.maxCondition / 2));
  const damaged = p.rpg.inventory.find((i) => i.id === sword.id);
  const before = damaged.condition;
  assert.ok(before < damaged.maxCondition);
  p.rpg.gold = 500;

  at(p, -10, 19); // General Store (quality 19)
  const cost = repairCost(damaged, 19);
  assert.ok(cost > 0);
  assert.match(w.act(p, 'repair.leave', { counterId: 'b:2,1:15', itemId: sword.id, cost: cost + 1 }).error, /price has changed/);
  assert.match(w.act(p, 'repair.leave', { counterId: 'b:2,0:15', itemId: sword.id, cost }).error, /does not offer|must be at/);
  assert.equal(w.act(p, 'repair.leave', { counterId: 'b:2,1:15', itemId: sword.id, cost, requestId: 'rep-0001' }).ok, true);
  assert.equal(p.rpg.gold, 500 - cost);
  assert.equal(p.rpg.inventory.some((i) => i.id === sword.id), false, 'the item is with the smith');
  const [ticket] = p.rpg.townServices.repairs;
  assert.equal(ticket.item.id, sword.id);
  assert.equal(ticket.readyAt - ticket.leftAt, repairMinutes(damaged));
  assert.equal(w.act(p, 'repair.leave', { counterId: 'b:2,1:15', itemId: sword.id, cost, requestId: 'rep-0001' }).ok, false);

  // Not ready yet; another shop does not have it.
  assert.match(w.act(p, 'repair.collect', { counterId: 'b:2,1:15', ticket: ticket.ticket }).error, /ready in/);
  at(p, 40, 39);
  assert.match(w.act(p, 'repair.collect', { counterId: 'b:3,0:14', ticket: ticket.ticket }).error, /is with General Store/);

  // Disconnect and come back: the ticket and item survive a JSON round trip (the DB row).
  const saved = JSON.parse(JSON.stringify(p.rpg));
  w.rt.leave(p);
  w.players.delete(1);
  const q = w.join(1, GG, saved);
  assert.equal(q.rpg.townServices.repairs.length, 1);
  assert.equal(q.rpg.inventory.some((i) => i.id === sword.id), false);

  w.advanceGameMinutes(ticket.readyAt - ticket.leftAt + 1);
  at(q, -10, 19);
  assert.equal(w.act(q, 'repair.collect', { counterId: 'b:2,1:15', ticket: ticket.ticket, requestId: 'col-0001' }).ok, true);
  const back = q.rpg.inventory.filter((i) => i.id === sword.id);
  assert.equal(back.length, 1, 'exactly one copy');
  assert.equal(back[0].condition, back[0].maxCondition);
  assert.equal(q.rpg.townServices.repairs.length, 0);
  assert.equal(w.act(q, 'repair.collect', { counterId: 'b:2,1:15', ticket: ticket.ticket, requestId: 'col-0001' }).ok, false);
  assert.equal(w.act(q, 'repair.collect', { counterId: 'b:2,1:15', ticket: ticket.ticket }).ok, false);
  assert.equal(q.rpg.inventory.filter((i) => i.id === sword.id).length, 1);
  assert.match(w.act(q, 'repair.leave', { counterId: 'b:2,1:15', itemId: sword.id, cost: 0 }).error, /does not need/);
});

test('repair: interrupting returns the item unrepaired; no refund; broken pack/encumbrance guarded', async () => {
  const w = world();
  const p = w.join(1);
  await w.settle(GG);
  const sword = p.rpg.inventory.find((i) => i.group === 'weapon');
  if (sword.equipped) w.act(p, 'inventory.unequip', { itemId: sword.id });
  w.rt.ctx.services.damageItem(p, sword.id, 3);
  const cond = p.rpg.inventory.find((i) => i.id === sword.id).condition;
  p.rpg.gold = 100;
  at(p, -10, 19);
  const cost = repairCost(p.rpg.inventory.find((i) => i.id === sword.id), 19);
  assert.equal(w.act(p, 'repair.leave', { counterId: 'b:2,1:15', itemId: sword.id, cost }).ok, true);
  const t = p.rpg.townServices.repairs[0].ticket;
  assert.equal(w.act(p, 'repair.collect', { counterId: 'b:2,1:15', ticket: t, interrupt: true }).ok, true);
  const it = p.rpg.inventory.find((i) => i.id === sword.id);
  assert.equal(it.condition, cond);
  assert.equal(p.rpg.gold, 100 - cost);

  // Equipped items must be unequipped; an undamaged item is refused.
  const armour = p.rpg.inventory.find((i) => i.equipped && i.group !== 'weapon');
  if (armour) {
    w.rt.ctx.services.damageItem(p, armour.id, 1);
    const a2 = p.rpg.inventory.find((i) => i.id === armour.id);
    if (a2.equipped) assert.match(w.act(p, 'repair.leave', { counterId: 'b:2,1:15', itemId: armour.id, cost: repairCost(a2, 19) }).error, /Unequip/);
  }
});

test('repair at a smith NPC requires conversation range', async () => {
  const w = world();
  const p = w.join(1, DF);
  await w.settle(DF);
  const smith = rosterFor(DF).find((n) => n.role === 'smith');
  assert.ok(smith, 'the default district has a smith');
  const sword = p.rpg.inventory.find((i) => i.group === 'weapon');
  if (sword.equipped) w.act(p, 'inventory.unequip', { itemId: sword.id });
  w.rt.ctx.services.damageItem(p, sword.id, 5);
  const item = p.rpg.inventory.find((i) => i.id === sword.id);
  const cost = repairCost(item, 10);
  at(p, smith.x + 10, smith.z);
  assert.match(w.act(p, 'repair.leave', { counterId: `npc:${smith.id}`, itemId: sword.id, cost }).error, /must be at/);
  at(p, smith.x + 1, smith.z);
  assert.equal(w.act(p, 'repair.leave', { counterId: `npc:${smith.id}`, itemId: sword.id, cost }).ok, true);

  // Talking to the smith points the player at the controls.
  assert.equal(w.act(p, 'npc.talk', { targetId: smith.id }).ok, true);
  assert.equal(w.events(p, 'townServices.offer').at(-1).counterId, `npc:${smith.id}`);
  // Counters are announced on arrival.
  const ann = w.events(p, 'townServices.counters').at(-1);
  assert.equal(ann.location, DF);
});

test('state normalization drops malformed records', () => {
  const rpg = { townServices: { accounts: { daggerfall: { region: 'Daggerfall', gold: 5.7 }, x: { region: 'Y', gold: 1 }, __bad: 3 }, letters: [{ id: 'a', amount: -1 }, { id: 'b', amount: 200 }], repairs: [{ ticket: 't' }], recent: ['ok-123456', 'x'] } };
  const s = normalizeState(rpg);
  assert.deepEqual(s.accounts, { daggerfall: { region: 'Daggerfall', gold: 5 } });
  assert.equal(s.letters.length, 1);
  assert.equal(s.repairs.length, 0);
  assert.deepEqual(s.recent, ['ok-123456']);
});

test('countersFromPortals keeps only banks and repair shops with doors', () => {
  const c = countersFromPortals({
    buildings: [
      { portalId: 'b:0,0:1', buildingType: 3, quality: 8, doors: [{ x: 1.234, z: 2 }], target: 'interior:A/B/0,0/1' },
      { portalId: 'b:0,0:2', buildingType: 15, quality: 8, doors: [{ x: 0, z: 0 }] },
      { portalId: 'b:0,0:3', buildingType: 13, quality: 8, doors: [] },
      { portalId: 'b:0,0:4', buildingType: 2, quality: 8, doors: [{ x: 0, z: 0 }] },
    ],
  }, new Map([['b:0,0:4', { quality: 17 }]]));
  assert.deepEqual(c.map((k) => [k.id, k.type, k.quality]), [['b:0,0:1', 'bank', 8], ['b:0,0:4', 'armorer', 17]]);
  assert.deepEqual(c[0].doors, [{ x: 1.23, z: 2 }]);
});

const ARENA2 = process.env.ARENA2_DIR || join(ROOT, 'gamedata', 'DaggerfallGameFiles', 'arena2');
test('operator ARENA2: Gothway Garden has a real bank and repair shops', { skip: !existsSync(join(ARENA2, 'MAPS.BSA')) && 'no operator ARENA2 data' }, async () => {
  const load = arena2ServiceLoader(ARENA2);
  const { counters, source } = await load(GG);
  assert.match(source, /ARENA2 Daggerfall\/Gothway Garden/);
  const banks = counters.filter((c) => c.type === 'bank');
  const shops = counters.filter((c) => c.services.includes('repair'));
  assert.ok(banks.length >= 1, 'a bank');
  assert.ok(shops.length >= 1, 'a repair shop');
  for (const c of counters) {
    assert.ok(c.quality >= 1 && c.quality <= 20);
    assert.ok(c.doors.length >= 1 && c.doors.every((d) => Number.isFinite(d.x) && Number.isFinite(d.z)));
  }
});
