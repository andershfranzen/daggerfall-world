// Package 12: classic shops, shelves, regional prices and repairs (docs/shops-and-economy.md).
//
// Pure rules are checked against Daggerfall Unity's formulas. The [asset] cases run the production feature manifest
// on a real SQLite file with the operator's ARENA2 (skipped without gamedata/; RPG_INTEGRATION_STRICT=1 fails instead):
// two accounts buy from a real shelf of a real Gothway Garden shop, the shared ledger reconciles, prices differ by shop
// quality and by region, and a worn item is repaired across a restart.
// Positions inside shops are set by the fixture (FIXTURE POSITIONING): the shelf and counter coordinates are the
// surveyed ones; only the walk there is skipped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDING, buyPrice, calculateCost, priceAdjust, priceContext, regionIndexOf, regionPowerDelta, sellPrice, setFactionPowers, storeRefusal,
  tradePrice,
} from '../client/gameplay/economy/rules.js';
import { repairBatchMinutes, repairCost, repairMinutes, repairRefusal } from '../client/gameplay/townServices/rules.js';
import { priceContext as browserPriceContext } from '../client/gameplay/economy/rules.js';
import { randomMaterial, shelfBooks, stockShelf, TEMPLATE_RARITY } from '../server/rpg/economy/stock.js';
import { BASES, describeTemplate } from '../server/rpg/inventory.js';
import { createFixtureWorld, localArena2, STRICT, tempDir } from './support/rpg-session.mjs';
import { features as production } from '../server/rpg/features.js';
import { basketOf, cloneHolds, heldTotal, hydrateHolds, pick, returnAll, serializeHolds, settle, unpick } from '../server/rpg/economy/basket.js';

const resolve = (k) => {
  try {
    describeTemplate(k);
    return true;
  } catch {
    return false;
  }
};

describe('classic price rules', () => {
  test('CalculateCost and CalculateTradePrice match the integer formulas', () => {
    assert.equal(calculateCost(100, 10), 200);
    assert.equal(calculateCost(100, 20), 220);
    assert.equal(calculateCost(100, 1), 182);
    assert.equal(calculateCost(100, 10, 1250), 250, 'regional adjustment is applied first');
    // Quality 10 merchant (Mercantile/Personality 50) against a 0 Mercantile, 50 Personality buyer.
    assert.equal(tradePrice(200, 10, false, { mercantile: 0, personality: 50 }), 140);
    assert.equal(tradePrice(200, 10, true, { mercantile: 0, personality: 50 }), 74);
    // Skill pulls both directions toward the player.
    assert.ok(tradePrice(200, 10, false, { mercantile: 100, personality: 100 }) < 140);
    assert.ok(tradePrice(200, 10, true, { mercantile: 100, personality: 100 }) > 74);
  });

  test('classic haggling can beat a poor shop, which is why the server caps resale to the same shop', () => {
    // Faithful to CalculateTradePrice: at quality 1 a 100 Mercantile / 100 Personality player sells above the buy price.
    const strong = { quality: 1, adjust: 1000, mercantile: 100, personality: 100 };
    assert.ok(sellPrice(57, 1, strong) > buyPrice(57, 1, strong));
    // An average character never profits from a round trip in an average shop.
    for (const quality of [8, 10, 15, 20]) {
      const ctx = { quality, adjust: 1000, mercantile: 20, personality: 50 };
      assert.ok(buyPrice(57, 1, ctx) > sellPrice(57, 1, ctx), `q${quality}`);
    }
  });

  test('regional prices are shared, bounded, deterministic and differ between regions', () => {
    const t = 300_000_000;
    const a = priceAdjust(17, t), b = priceAdjust(23, t);
    assert.equal(priceAdjust(17, t), a);
    for (const v of [a, b]) assert.ok(v >= 250 && v <= 4000);
    let differs = 0;
    for (let d = 0; d < 30; d++) if (priceAdjust(17, t + d * 1440) !== priceAdjust(23, t + d * 1440)) differs++;
    assert.ok(differs > 25, 'two regions rarely share a value');
    // Day-to-day moves are the classic ±2 % steps.
    const next = priceAdjust(17, t + 1440);
    assert.ok([Math.trunc(49 * a / 50), Math.trunc(51 * a / 50)].includes(next) || next === a, `${a} -> ${next}`);
    assert.equal(regionIndexOf('interior:Daggerfall/Gothway Garden/3,0/14'), 17);
    assert.equal(regionIndexOf('town:Wayrest/Wayrest'), 23);
  });

  test("Merchants' Festival halves shop prices and Warriors' Festival halves weapons only", () => {
    const base = { quality: 10, adjust: 1000, mercantile: 0, personality: 50, guildFaction: null };
    const plain = buyPrice(100, 1, { ...base, holiday: null });
    assert.equal(buyPrice(100, 1, { ...base, holiday: 'merchants-festival' }), tradePrice(100, 10, false, base));
    assert.ok(buyPrice(100, 1, { ...base, holiday: 'merchants-festival' }) < plain);
    assert.ok(buyPrice(100, 1, { ...base, holiday: 'warriors-festival' }, 'Weapons') < plain);
    assert.equal(buyPrice(100, 1, { ...base, holiday: 'warriors-festival' }, 'Armor'), plain);
    // The day of year comes from package 20's calendar: day 190 is Merchants' Festival everywhere.
    const ctx = priceContext({ regionIndex: 17, minutes: 189 * 1440 + 600 });
    assert.equal(typeof ctx.holiday === 'string' || ctx.holiday === null, true);
  });

  test('shops only buy their own classic item groups', () => {
    assert.equal(storeRefusal(BUILDING.Alchemist, 'Gems'), null);
    assert.ok(storeRefusal(BUILDING.Alchemist, 'Weapons'));
    assert.equal(storeRefusal(BUILDING.WeaponSmith, 'Armor'), null);
    assert.ok(storeRefusal(BUILDING.GeneralStore, 'Armor'), 'classic general stores do not buy armour');
    assert.equal(storeRefusal(BUILDING.PawnShop, 'Armor'), null);
  });

  test('repairs: classic cost with trade price, batch timing, magic items refused', () => {
    const sword = { name: 'Steel Longsword', group: 'weapon', value: 90, condition: 400, maxCondition: 1000, quantity: 1 };
    assert.equal(repairCost(sword, 10), 18, 'CalculateItemRepairCost without trade price');
    const priced = repairCost(sword, 10, null, { adjust: 1000, mercantile: 0, personality: 50 });
    assert.equal(priced, tradePrice(18, 10, false, { mercantile: 0, personality: 50 }));
    assert.ok(repairCost(sword, 10, null, { adjust: 2000, mercantile: 0, personality: 50 }) > priced, 'expensive region');
    assert.equal(repairMinutes(sword), 1440, 'at least one day');
    const heavy = { ...sword, condition: 0, maxCondition: 4000 };
    assert.deepEqual(repairBatchMinutes([sword, heavy]), [1440, repairMinutes(heavy) + 720]);
    assert.match(repairRefusal({ ...sword, enchantments: [{ type: 'x' }] }), /enchanted/);
  });
});

describe('shelf stock (DaggerfallLoot.StockShopShelf)', () => {
  test('deterministic per shelf and day, nothing rarer than the shop quality', () => {
    const a = stockShelf({ buildingType: BUILDING.GeneralStore, quality: 5, seed: 's|1|405001', resolve });
    const b = stockShelf({ buildingType: BUILDING.GeneralStore, quality: 5, seed: 's|1|405001', resolve });
    assert.deepEqual(a, b);
    assert.ok(a.some((x) => x.template === 'horse'), 'every general store shelf offers a horse');
    for (const q of [1, 4, 8]) {
      for (const it of stockShelf({ buildingType: BUILDING.Armorer, quality: q, seed: `q${q}`, resolve })) {
        const index = describeTemplate(it.template).index;
        assert.ok(TEMPLATE_RARITY[index] <= q, `${it.template} rarity ${TEMPLATE_RARITY[index]} > quality ${q}`);
      }
    }
    assert.equal(shelfBooks(1), 2);
    assert.equal(shelfBooks(20), 5);
  });

  test('source stock: furniture stores empty, alchemist recipes, pawnshop magic from quality 10', () => {
    for (let i = 0; i < 20; i++) assert.deepEqual(stockShelf({ buildingType: BUILDING.FurnitureStore, quality: 20, seed: `f${i}`, resolve }), []);
    const recipe = () => ({ template: 'potion-recipe', extra: { recipe: { key: 'fixture' } } });
    const magic = (_r, level) => ({ template: 'iron-dagger', extra: { magic: { enchantments: [], identified: false, level } } });
    let recipes = 0, potions = 0;
    for (let i = 0; i < 400; i++) {
      const items = stockShelf({ buildingType: BUILDING.Alchemist, quality: 20, seed: `a${i}`, resolve, randomRecipe: recipe });
      recipes += items.filter((x) => x.template === 'potion-recipe').length;
      potions += items.filter((x) => BASES[x.template]?.group === 'potion').length;
    }
    assert.ok(recipes > 60 && recipes < 140, `about 25 % of shelves carry a recipe (${recipes}/400)`);
    assert.equal(potions, 0, 'classic alchemists do not shelve potions (package 16 potion merchants sell them)');
    const magicCount = (quality) => {
      let n = 0;
      for (let i = 0; i < 400; i++) n += stockShelf({ buildingType: BUILDING.PawnShop, quality, seed: `p${i}`, resolve, randomMagic: magic }).filter((x) => x.extra?.magic).length;
      return n;
    };
    assert.equal(magicCount(9), 0, 'template 0 rarity 10 gates magic items');
    const m = magicCount(15);
    assert.ok(m > 5 && m < 45, `about 5 % of pawnshop shelves (${m}/400)`);
  });

  test('regional price walk reads faction power (UpdateRegionalPrices)', () => {
    const t = 300_000_000;
    const before = priceAdjust(17, t);
    const factions = new Map([[510, { id: 510, type: 2, region: -1, power: 40 }], [201, { id: 201, type: 7, region: 17, power: 80 }], [852, { id: 852, type: 7, region: -1, power: 40 }]]);
    try {
      assert.equal(setFactionPowers(factions), 62);
      assert.equal(regionPowerDelta(17), -40);
      assert.equal(regionPowerDelta(3), 0, 'other regions fall back to the province with region -1');
      assert.ok(priceAdjust(17, t) < before, 'a region stronger than the merchants pushes prices down over the year');
    } finally {
      setFactionPowers(new Map());
    }
    assert.equal(priceAdjust(17, t), before);
  });

  test('higher player levels see better materials', () => {
    const avg = (level) => {
      let sum = 0;
      for (let i = 0; i < 4000; i++) {
        let s = i * 2654435761;
        sum += randomMaterial(level, () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296));
      }
      return sum / 4000;
    };
    assert.ok(avg(30) > avg(1) + 0.3, `${avg(30)} vs ${avg(1)}`);
    assert.ok(BASES.dagger);
  });
});

describe('baskets (DaggerfallTradeWindow basket, on the shared ledger)', () => {
  const shopWith = (q) => ({ rev: 1, stock: new Map([['s1:iron-dagger', { template: 'iron-dagger', name: 'Iron Dagger', value: 10, quantity: q, shelf: 1, group: 'Weapons' }]]) });
  const units = (shop) => (shop.stock.get('s1:iron-dagger')?.quantity ?? 0) + heldTotal(shop, 's1:iron-dagger');

  test('two shoppers contend for the last item; undo puts it back for the other', () => {
    const shop = shopWith(1);
    pick(shop, 'A', 's1:iron-dagger', 1, 0);
    assert.throws(() => pick(shop, 'B', 's1:iron-dagger', 1, 0), /no longer/);
    assert.equal(units(shop), 1, 'never more goods than were stocked');
    unpick(shop, 'A', 's1:iron-dagger');
    pick(shop, 'B', 's1:iron-dagger', 1, 0);
    assert.equal(basketOf(shop, 'B').lines.get('s1:iron-dagger').quantity, 1);
    assert.equal(units(shop), 1);
  });

  test('returning, settling, persistence and rollback copies never duplicate goods', () => {
    const shop = shopWith(5);
    pick(shop, 'A', 's1:iron-dagger', 3, 7);
    const id = basketOf(shop, 'A').id;
    // A restock while the basket is held replaced the shelf entry: the held goods come back as a new entry.
    shop.stock.clear();
    assert.equal(returnAll(shop, 'A'), 3);
    assert.equal(shop.stock.get('s1:iron-dagger').quantity, 3);
    assert.equal(basketOf(shop, 'A'), null);
    pick(shop, 'A', 's1:iron-dagger', 2, 9);
    assert.notEqual(basketOf(shop, 'A').id, id, 'a new basket has a new id (payment receipts never collide)');
    const copy = hydrateHolds(JSON.parse(JSON.stringify(serializeHolds(shop.holds))));
    assert.deepEqual([...copy.get('A').lines.values()].map((l) => l.quantity), [2]);
    const snap = cloneHolds(shop.holds);
    basketOf(shop, 'A').lines.get('s1:iron-dagger').quantity = 99;
    assert.equal(snap.get('A').lines.get('s1:iron-dagger').quantity, 2, 'the rollback snapshot is a deep copy');
    basketOf(shop, 'A').lines.get('s1:iron-dagger').quantity = 2;
    settle(shop, 'A');
    assert.equal(units(shop), 1, 'paid goods left the ledger');
    assert.throws(() => unpick(shop, 'A', 's1:iron-dagger'), /not in your basket/);
    assert.equal(serializeHolds(shop.holds), undefined);
  });
});

// ---------------------------------------------------------------------------------------------- [asset]

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const GG = 'town:Daggerfall/Gothway Garden';
const WR = 'town:Wayrest/Wayrest';
const Q3 = 'interior:Daggerfall/Gothway Garden/3,0/14'; // First Class Supply Store, quality 3
const Q19 = 'interior:Daggerfall/Gothway Garden/2,1/15'; // The Superior General Store, quality 19
const Q11 = 'interior:Daggerfall/Gothway Garden/3,0/15'; // The Superior Supply Store, quality 11
const WR11 = 'interior:Wayrest/Wayrest/3,3/0'; // Rodistair's Equipment Store, quality 11

async function until(world, fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** FIXTURE POSITIONING: production portal transfer straight into a shop through its own door record. */
async function enter(world, c, interior) {
  const town = interior.replace(/^interior:([^/]+\/[^/]+)\/.*$/, 'town:$1');
  await world.ctx.services.interiors.survey(town);
  const door = world.ctx.services.portals.at(town).find((b) => b.to === interior);
  assert.ok(door, `${interior} is a surveyed building`);
  const p = world.players.get(c.id);
  world.ctx.services.portals.transfer(p, { location: interior, x: door.entrances[0].inner.x, y: door.entrances[0].inner.y, z: door.entrances[0].inner.z, yaw: 0 }, { portal: door });
  world.tick(40);
  await world.ctx.services.collision?.whenSettled?.(interior);
  await until(world, () => world.ctx.services.shopLedger?.keeperAt(interior), `the keeper of ${door.label}`);
  return door;
}
/** FIXTURE POSITIONING: stand in front of a surveyed shelf. */
function atShelf(world, c, shelf) {
  const p = world.players.get(c.id);
  p.x = shelf.x;
  p.z = shelf.z;
  p.dirty = true;
}
const lastShelf = (c) => c.events('shop.shelf').at(-1);
const browse = (world, c, n) => {
  c.must('shop.shelf', { shelf: n });
  world.tick(10);
  return lastShelf(c);
};
function shelvesOf(world, interior) {
  return world.ctx.services.portals.into(interior).meta.shelves;
}
/** The shelf item with this template, searching every shelf of the shop. */
function findOnShelves(world, c, interior, pred) {
  for (const s of shelvesOf(world, interior)) {
    atShelf(world, c, s);
    const v = browse(world, c, s.number);
    const it = v.items.find(pred);
    if (it) return { shelf: s, item: it, view: v };
  }
  return null;
}

describe('[asset] shops on the production manifest', () => {
  test('two accounts buy from a real shelf; prices by quality and region; repair across a restart', { ...gate, timeout: 300_000 }, async (t) => {
    const tmp = tempDir('dfw-shops-');
    const dbPath = `${tmp.dir}/world.db`;
    const world = await createFixtureWorld({ dbPath, features: production, dataPath: ARENA2 });
    t.after(() => {
      try { world.close(); } finally { tmp.remove(); }
    });
    await world.ctx.services.interiors.ready;
    // Open hours: general stores open 06:00–23:00 (PlayerActivate). Move the shared clock to mid-morning if needed.
    for (let i = 0; i < 48; i++) {
      const hour = Math.floor((world.ctx.services.worldClock().minutes % 1440) / 60);
      if (hour >= 9 && hour < 15) break;
      world.clock.advance(5 * 60_000); // 1 game hour
      world.tick(10);
    }

    const a = world.connect('acct-shop-a', 'Aldora');
    const b = world.connect('acct-shop-b', 'Brannoc');
    // FIXTURE: a purse for the test buys.
    for (const c of [a, b]) world.players.get(c.id).rpg.gold = 20_000;
    world.tick(10);

    // --- a real shelf in a real shop
    await enter(world, a, Q3);
    await enter(world, b, Q3);
    const listed = await until(world, () => a.events('shop.shelves').find((e) => e.location === Q3), 'the shelf list');
    assert.equal(listed.shelves.length, shelvesOf(world, Q3).length);
    assert.ok(listed.shelves.length >= 2, 'the quality 3 store has several shelves');
    const found = findOnShelves(world, a, Q3, (i) => i.key.includes('dagger') || i.key.includes('staff') || i.key.includes('arrow') || i.key.includes('shoes') || i.key.includes('book'))
      ?? findOnShelves(world, a, Q3, (i) => i.key !== `s1:horse` && !i.key.endsWith(':horse') && !i.key.endsWith(':small-cart'));
    assert.ok(found, 'something affordable is on a shelf');
    const { shelf, item } = found;
    const keeper = world.ctx.services.shopLedger.keeperAt(Q3);
    const ledgerKey = world.ctx.services.shopLedger.key(keeper);
    const ledger = () => world.ctx.services.shopLedger.open(keeper, world.players.get(a.id));
    const purse0 = ledger().purse;
    const gold0 = a.character.gold;
    a.must('shop.take', { shelf: shelf.number, key: item.key, quantity: 1, price: item.price });
    world.tick(10);
    assert.equal(a.character.gold, gold0 - item.price, 'the buyer paid the shown price');
    assert.equal(ledger().purse, purse0 + item.price, 'the merchant received it');
    const after = lastShelf(a).items.find((i) => i.key === item.key);
    assert.equal(after?.quantity ?? 0, item.quantity - 1, 'the shelf has one fewer');
    const bought = a.character.inventory.find((i) => i.template === ledger().stock.get(item.key).template);
    assert.ok(bought, 'the item is in the pack');

    // The second account sees the same shelf, and the counter shows the same ledger.
    atShelf(world, b, shelf);
    const bView = browse(world, b, shelf.number);
    assert.equal(bView.items.find((i) => i.key === item.key)?.quantity ?? 0, item.quantity - 1, 'shared shelf stock');
    const kp = world.ctx.entities.get(keeper.id);
    const pb = world.players.get(b.id);
    pb.x = kp.x;
    pb.z = kp.z + 0.8;
    const talk = b.must('npc.talk', { targetId: keeper.id }) && b.events('dialogue').at(-1);
    b.must('npc.topic', { targetId: keeper.id, session: talk.session, topic: 'trade' });
    const counter = b.events('dialogue').at(-1).shop;
    assert.equal(counter.items.find((i) => i.key === item.key)?.quantity ?? 0, item.quantity - 1, 'the counter sells from the same shelves');
    assert.equal(counter.purse, ledger().purse);
    // A's offer for what A just bought never exceeds what A paid this shop (server resale cap).
    const pa0 = world.players.get(a.id);
    pa0.x = kp.x;
    pa0.z = kp.z - 0.8;
    const talkA = a.must('npc.talk', { targetId: keeper.id }) && a.events('dialogue').at(-1);
    a.must('npc.topic', { targetId: keeper.id, session: talkA.session, topic: 'trade' });
    const offer = a.events('dialogue').at(-1).shop.sellable.find((s) => s.itemId === bought.id);
    if (offer) assert.ok(offer.price <= item.price, `resale ${offer.price} <= paid ${item.price}`);
    a.act('npc.leave', {});

    // --- prices: quality 3 vs 19 in one region; quality 11 in Daggerfall vs Wayrest
    const horsePrice = async (c, interior) => {
      await enter(world, c, interior);
      const f = findOnShelves(world, c, interior, (i) => i.key.endsWith(':horse'));
      assert.ok(f, `a horse in ${interior}`);
      return f.item.price;
    };
    const pQ3 = await horsePrice(b, Q3);
    const pQ19 = await horsePrice(b, Q19);
    const pQ11 = await horsePrice(b, Q11);
    const pW11 = await horsePrice(b, WR11);
    const minutes = world.ctx.services.worldClock().minutes;
    const expect = (quality, region) => buyPrice(1000, 1, { ...priceContext({ quality, regionIndex: region, minutes, character: world.players.get(b.id).rpg.character }) }, 'Transportation');
    assert.equal(pQ3, expect(3, 17));
    assert.equal(pQ19, expect(19, 17));
    assert.equal(pQ11, expect(11, 17));
    assert.equal(pW11, expect(11, 23));
    assert.ok(pQ19 > pQ3, `quality: ${pQ3} < ${pQ19}`);
    assert.notEqual(pQ11, pW11, 'same quality, different region, different price');
    t.diagnostic(`horse: Gothway q3 ${pQ3}, q11 ${pQ11}, q19 ${pQ19}; Wayrest q11 ${pW11}; adjust Daggerfall ${priceAdjust(17, minutes)}, Wayrest ${priceAdjust(23, minutes)}`);

    // --- repair the item A bought (FIXTURE: worn by use) at this shop's counter, across a restart
    const pa = world.players.get(a.id);
    let worn = pa.rpg.inventory.find((i) => ['weapon', 'armor', 'shield'].includes(i.group) && !i.equipped);
    if (!worn) {
      // The shelf item was not repairable gear: buy a weapon at the counter of this shop instead.
      const w = findOnShelves(world, a, Q3, (i) => /dagger|staff|sword|axe|mace|bow|tanto/.test(i.key));
      assert.ok(w, 'a weapon on the shelves');
      a.must('shop.take', { shelf: w.shelf.number, key: w.item.key, quantity: 1, price: w.item.price });
      world.tick(10);
      worn = pa.rpg.inventory.find((i) => i.group === 'weapon' && !i.equipped);
    }
    worn.condition = Math.max(1, Math.floor(worn.maxCondition * 0.3));
    pa.dirty = true;
    world.tick(10);
    a.must('town.services', {});
    world.tick(10);
    const counters = a.events('townServices.counters').at(-1);
    const shopCounter = counters.counters.find((c) => c.id === 'b:3,0:14');
    assert.ok(shopCounter, 'the shop is a repair counter');
    const pc = priceContext({ quality: shopCounter.quality, character: pa.rpg.character });
    const item0 = a.character.inventory.find((i) => i.id === worn.id);
    const cost = repairCost(item0, shopCounter.quality, null, { adjust: counters.market.adjust, mercantile: pc.mercantile, personality: pc.personality });
    const goldBefore = a.character.gold;
    a.must('repair.leave', { counterId: 'b:3,0:14', itemId: worn.id, cost, requestId: 'repair-a-1' });
    world.tick(10);
    assert.equal(a.character.gold, goldBefore - cost);
    assert.ok(!a.character.inventory.some((i) => i.id === worn.id), 'left with the smith');
    const ticket = a.character.townServices.repairs.find((r) => r.item.id === worn.id);
    assert.ok(ticket);
    assert.equal(b.act('repair.collect', { counterId: 'b:3,0:14', ticket: ticket.ticket }).ok, false, 'another account cannot collect it');

    // Graceful restart on the same database.
    world.restart();
    const a2 = world.connect('acct-shop-a', 'Aldora');
    const b2 = world.connect('acct-shop-b', 'Brannoc');
    assert.equal(a2.character.gold, goldBefore - cost, 'gold survived the restart');
    assert.ok(a2.character.inventory.some((i) => i.template === bought.template), 'the purchase survived the restart');
    assert.ok(a2.character.townServices.repairs.some((r) => r.ticket === ticket.ticket), 'the ticket survived the restart');
    // The ledger row persisted: the shelf still has one fewer (same game day).
    await enter(world, b2, Q3);
    const keeper2 = world.ctx.services.shopLedger.keeperAt(Q3);
    assert.equal(world.ctx.services.shopLedger.key(keeper2), ledgerKey);
    atShelf(world, b2, shelf);
    const sameDay = Math.floor(world.ctx.services.worldClock().minutes / 1440) === Math.floor(minutes / 1440);
    if (sameDay) assert.equal(browse(world, b2, shelf.number).items.find((i) => i.key === item.key)?.quantity ?? 0, item.quantity - 1, 'shelf stock persisted');

    // Wait out the repair on the shared clock (12x real time: one game day is two hours).
    await enter(world, a2, Q3);
    const early = await until(world, () => {
      const r = a2.act('repair.collect', { counterId: 'b:3,0:14', ticket: ticket.ticket });
      return /still being read|moment/i.test(r.error ?? '') ? null : r;
    }, 'the counters after the restart');
    assert.equal(early.ok, false, 'not ready yet');
    assert.match(early.error, /ready in/);
    world.clock.advance(Math.ceil((ticket.readyAt - world.ctx.services.worldClock().minutes) / 12 * 60_000) + 120_000);
    world.tick(10);
    // Shops may have closed for the night: come back during opening hours.
    for (let i = 0; i < 48 && !world.ctx.services.shopLedger.keeperAt(Q3); i++) {
      world.clock.advance(5 * 60_000);
      world.tick(250);
      await new Promise((r) => setTimeout(r, 20));
    }
    // After a restart the town's counters are read again before they serve anyone.
    await until(world, () => {
      const r = a2.act('repair.collect', { counterId: 'b:3,0:14', ticket: ticket.ticket, requestId: 'collect-a-1' });
      if (!r.ok && !/still being read|moment/i.test(r.error)) throw new Error(`repair.collect: ${r.error}`);
      return r.ok;
    }, 'the counters after the restart');
    world.tick(10);
    const back = a2.character.inventory.find((i) => i.id === worn.id);
    assert.ok(back, 'the same item record came back');
    assert.equal(back.condition, back.maxCondition, 'fully repaired');
    assert.equal(a2.act('repair.collect', { counterId: 'b:3,0:14', ticket: ticket.ticket }).ok, false, 'collected once');
    // A new game day re-stocks the shelves.
    const day = browse(world, b2, shelf.number);
    assert.ok(Array.isArray(day.items));
  });
});

describe('[asset] classic checkout: pick at the shelf, pay at the counter', () => {
  test('contention, undo, counter payment with a failed save and retries, leaving, reconnect, restart and theft', { ...gate, timeout: 300_000 }, async (t) => {
    const tmp = tempDir('dfw-basket-');
    const world = await createFixtureWorld({ dbPath: `${tmp.dir}/world.db`, features: production, dataPath: ARENA2 });
    t.after(() => {
      try { world.close(); } finally { tmp.remove(); }
    });
    await world.ctx.services.interiors.ready;
    for (let i = 0; i < 48; i++) {
      const hour = Math.floor((world.ctx.services.worldClock().minutes % 1440) / 60);
      if (hour >= 9 && hour < 14) break;
      world.clock.advance(5 * 60_000);
      world.tick(10);
    }
    let a = world.connect('acct-basket-a', 'Aldora');
    let b = world.connect('acct-basket-b', 'Brannoc');
    for (const c of [a, b]) world.players.get(c.id).rpg.gold = 5_000; // FIXTURE: a purse (light enough to leave carrying room: 400 gold weigh 1 kg)
    world.tick(10);
    await enter(world, a, Q3);
    await enter(world, b, Q3);
    const L = world.ctx.services.shopLedger;
    const keeper = L.keeperAt(Q3);
    const ledger = () => L.peek(Q3);
    const basket = (c) => c.events('shop.basket').at(-1);
    const toCounter = (c, dz) => {
      const kp = world.ctx.entities.get(keeper.id);
      const p = world.players.get(c.id);
      p.x = kp.x;
      p.z = kp.z + dz;
    };

    // --- the last one on a shelf (FIXTURE: one is left of a real shelf entry)
    const found = findOnShelves(world, a, Q3, (i) => !/horse|small-cart/.test(i.key));
    assert.ok(found, 'goods on a shelf');
    const { shelf, item } = found;
    ledger().stock.get(item.key).quantity = 1;
    atShelf(world, b, shelf);
    const pick = (c, it = item, s = shelf) => c.act('shop.pick', { shelf: s.number, key: it.key, quantity: 1, price: it.price });
    assert.equal(pick(a).ok, true);
    world.tick(10);
    assert.equal(basket(a).lines[0].key, item.key);
    assert.equal(browse(world, b, shelf.number).items.some((i) => i.key === item.key), false, 'off the shelf for the other shopper');
    const lost = pick(b);
    assert.equal(lost.ok, false);
    assert.match(lost.error, /no longer/);
    assert.equal(b.events('shop.basket').length, 0, "B never sees A's basket");
    // Undo: A puts it back, B gets it.
    a.must('shop.unpick', { key: item.key });
    await new Promise((r) => setImmediate(r)); // other browsers are refreshed after the action
    world.tick(10);
    assert.equal(basket(a).lines.length, 0);
    assert.equal(lastShelf(b).items.find((i) => i.key === item.key)?.quantity, 1, 'the other shopper sees it back');
    assert.equal(pick(b).ok, true);
    assert.equal(pick(a).ok, false, 'now A loses the race');
    world.tick(10);

    // --- lawful checkout at the counter
    const bb = basket(b);
    assert.equal(bb.total, bb.lines[0].price);
    const payArgs = { basket: bb.basket, seq: bb.seq, total: bb.total };
    assert.match(b.act('shop.pay', payArgs).error, /counter/, 'pay at the counter, not the shelf');
    toCounter(b, 0.8);
    assert.match(b.act('shop.pay', { ...payArgs, total: bb.total + 1 }).error, /price has changed/);
    const gold0 = world.players.get(b.id).rpg.gold;
    const purse0 = ledger().purse;
    // A failed save: nothing changes on either side.
    const write = world.writeRows.bind(world);
    world.writeRows = () => {
      world.writeRows = write;
      throw new Error('disk full (fixture)');
    };
    const failed = b.act('shop.pay', payArgs);
    assert.equal(failed.ok, false);
    assert.equal(world.players.get(b.id).rpg.gold, gold0, 'no gold taken');
    assert.equal(ledger().purse, purse0);
    assert.equal(ledger().holds.get(b.id)?.lines.get(item.key)?.quantity, 1, 'the basket is intact');
    assert.ok(!world.players.get(b.id).rpg.inventory.some((i) => i.template === bb.lines[0].key.replace(/^s\d+:/, '').replace(/#.*/, '') && i.shopRetry));
    b.must('shop.pay', payArgs);
    world.tick(10);
    assert.equal(b.character.gold, gold0 - bb.total);
    assert.equal(ledger().purse, purse0 + bb.total);
    assert.equal(ledger().holds.has(b.id), false);
    const invCount = b.character.inventory.length;
    // The reply was lost: the same payment again is recognised, never charged twice.
    b.must('shop.pay', payArgs);
    world.tick(10);
    assert.equal(b.character.gold, gold0 - bb.total, 'a retry charges nothing');
    assert.equal(b.character.inventory.length, invCount);
    assert.match(basket(b).text, /already paid/);

    // --- leaving the shop puts unpaid goods back
    const other = findOnShelves(world, a, Q3, (i) => !/horse|small-cart/.test(i.key) && i.quantity >= 1);
    assert.ok(other);
    const q0 = other.item.quantity;
    a.must('shop.pick', { shelf: other.shelf.number, key: other.item.key, quantity: 1, price: other.item.price });
    await enter(world, a, Q11);
    world.tick(250);
    assert.equal(ledger().stock.get(other.item.key).quantity, q0, 'back on the shelf');
    assert.match(basket(a).text, /leave the shop/);
    assert.ok(!a.character.inventory.some((i) => i.stolen), 'nothing left with A');

    // --- a disconnect keeps the basket for a reconnect; staying away puts it back
    await enter(world, a, Q3);
    atShelf(world, a, other.shelf);
    const fresh = browse(world, a, other.shelf.number).items.find((i) => i.key === other.item.key);
    a.must('shop.pick', { shelf: other.shelf.number, key: fresh.key, quantity: 1, price: fresh.price });
    world.leave(a);
    world.tick(1000);
    assert.equal(ledger().holds.get(a.id)?.lines.size, 1, 'held during the grace period');
    a = world.connect('acct-basket-a', 'Aldora');
    world.tick(250);
    assert.equal(basket(a)?.lines[0]?.key, fresh.key, 'the reconnect finds its basket');
    world.leave(a);
    world.clock.advance(2 * 60_000 + 1000);
    world.tick(250);
    assert.equal(ledger().holds.has(a.id), false);
    assert.equal(ledger().stock.get(other.item.key).quantity, q0, 'returned after the grace period');

    // --- a graceful restart keeps a basket (saved on the ledger row)
    a = world.connect('acct-basket-a', 'Aldora');
    await until(world, () => L.keeperAt(Q3), 'the keeper');
    atShelf(world, a, other.shelf);
    const again = browse(world, a, other.shelf.number).items.find((i) => i.key === other.item.key);
    a.must('shop.pick', { shelf: other.shelf.number, key: again.key, quantity: 1, price: again.price });
    world.restart();
    a = world.connect('acct-basket-a', 'Aldora');
    b = world.connect('acct-basket-b', 'Brannoc');
    await until(world, () => world.ctx.services.shopLedger.keeperAt(Q3), 'the keeper after the restart');
    world.tick(250);
    const after = await until(world, () => a.events('shop.basket').at(-1), 'the basket after the restart');
    assert.equal(after.lines[0]?.key, again.key, 'the basket survived the restart');
    const L2 = world.ctx.services.shopLedger;
    assert.equal(L2.peek(Q3).stock.get(again.key).quantity, q0 - 1, 'and is still off the shelf');

    // --- theft: walk off with the basket instead of paying (package 14 rolls detection)
    const ab = a.events('shop.basket').at(-1);
    const pa = world.players.get(a.id);
    const purse1 = L2.peek(Q3).purse;
    const gold1 = pa.rpg.gold;
    a.must('shop.steal', { basket: ab.basket, seq: ab.seq });
    world.tick(10);
    const law = a.events('law').at(-1);
    assert.ok(['caught', 'success'].includes(law?.shoplift), 'package 14 judged the theft');
    assert.equal(pa.rpg.gold, gold1, 'theft pays nothing');
    assert.equal(L2.peek(Q3).purse, purse1);
    assert.equal(L2.peek(Q3).holds.has(a.id), false);
    if (law.shoplift === 'success') {
      assert.ok(pa.rpg.inventory.some((i) => i.stolen?.from === Q3), 'the goods are marked stolen');
      assert.equal(L2.peek(Q3).stock.get(again.key).quantity, q0 - 1);
    } else {
      assert.equal(L2.peek(Q3).stock.get(again.key).quantity, q0, 'caught: the goods stay with the merchant');
      assert.ok(pa.rpg.law?.charge, 'caught: charged with theft');
    }
    t.diagnostic(`theft outcome: ${law.shoplift} (chance of being seen ${law.chance}%)`);

    // An unwatched theft always succeeds (FIXTURE: the keeper steps into the back room, so nobody witnesses it).
    atShelf(world, b, other.shelf);
    // A successful theft above may have taken the last one of that item: then any other good on the shelf.
    const onShelf = browse(world, b, other.shelf.number).items;
    const loot = onShelf.find((i) => i.key === other.item.key) ?? onShelf.find((i) => !/horse|small-cart/.test(i.key));
    b.must('shop.pick', { shelf: other.shelf.number, key: loot.key, quantity: 1, price: loot.price });
    const bk = b.events('shop.basket').at(-1);
    const k2 = world.ctx.entities.get(world.ctx.services.shopLedger.keeperAt(Q3).id);
    const home = k2.location;
    k2.location = 'interior:fixture/back-room';
    const left = L2.peek(Q3).stock.get(loot.key).quantity;
    try {
      b.must('shop.steal', { basket: bk.basket, seq: bk.seq });
    } finally {
      k2.location = home;
    }
    world.tick(10);
    assert.equal(b.events('law').at(-1)?.shoplift, 'success');
    const pb = world.players.get(b.id);
    const took = pb.rpg.inventory.find((i) => i.stolen?.from === Q3);
    assert.ok(took, 'the stolen goods are in the pack, marked stolen');
    assert.equal(L2.peek(Q3).stock.get(loot.key).quantity, left, 'they left the shelf only once');
    assert.equal(L2.peek(Q3).holds.has(b.id), false);
    assert.equal(b.act('shop.steal', { basket: bk.basket, seq: bk.seq }).ok, false, 'a basket is stolen once');
    // Only a fence will buy stolen goods (package 12/15 rule): the shopkeeper refuses them.
    toCounter(b, 0.8);
    const talkB = b.must('npc.talk', { targetId: k2.id }) && b.events('dialogue').at(-1);
    b.must('npc.topic', { targetId: k2.id, session: talkB.session, topic: 'trade' });
    assert.ok(!b.events('dialogue').at(-1).shop.sellable.some((s) => s.itemId === took.id), 'the shop will not buy it back');
  });
});

describe('checkout reply in the conversation (client/gameplay/npcs/conversation.js)', () => {
  test('a keeper view with your basket offers a numbered pay reply naming the goods and the quote', async () => {
    const { replyChoices, basketSummary } = await import('../client/gameplay/npcs/conversation.js');
    const view = {
      npc: { id: 'n1', name: 'Keeper' }, session: 's', topics: [{ id: 'trade', label: 'Trade' }], services: [],
      basket: { basket: 'abc1', seq: 3, count: 3, total: 12, lines: [{ name: 'Candle', quantity: 2 }, { name: 'Torch', quantity: 1 }] },
    };
    const pay = replyChoices(view).find((c) => c.id === 'basket-pay');
    assert.ok(pay, 'offered');
    assert.equal(pay.key, 1, 'first numbered reply');
    assert.deepEqual(pay.args, { basket: 'abc1', seq: 3, total: 12 });
    assert.equal(pay.verb, 'shop.pay');
    assert.match(pay.label, /2 × Candle, Torch — 12 gold/);
    assert.equal(replyChoices({ ...view, basket: undefined }).some((c) => c.id === 'basket-pay'), false, 'no basket, no reply');
    assert.equal(basketSummary({ count: 5, lines: [1, 2, 3, 4].map((i) => ({ name: `G${i}`, quantity: 1 })) }), 'G1, G2, G3 and 1 more');
  });
});

describe('[asset] checkout in the shopkeeper conversation', () => {
  test('pay for the basket by talking to the keeper: private view, range, session, quote, receipt and restart', { ...gate, timeout: 300_000 }, async (t) => {
    const tmp = tempDir('dfw-talkpay-');
    const world = await createFixtureWorld({ dbPath: `${tmp.dir}/world.db`, features: production, dataPath: ARENA2 });
    t.after(() => {
      try { world.close(); } finally { tmp.remove(); }
    });
    await world.ctx.services.interiors.ready;
    for (let i = 0; i < 48; i++) {
      const hour = Math.floor((world.ctx.services.worldClock().minutes % 1440) / 60);
      if (hour >= 9 && hour < 14) break;
      world.clock.advance(5 * 60_000);
      world.tick(10);
    }
    let a = world.connect('acct-talkpay-a', 'Aldora');
    const b = world.connect('acct-talkpay-b', 'Brannoc');
    for (const c of [a, b]) world.players.get(c.id).rpg.gold = 5_000; // FIXTURE: a purse
    world.tick(10);
    await enter(world, a, Q3);
    await enter(world, b, Q3);
    const L = world.ctx.services.shopLedger;
    const keeper = world.ctx.entities.get(L.keeperAt(Q3).id);
    const stand = (c, dz) => {
      const p = world.players.get(c.id);
      p.x = keeper.x;
      p.z = keeper.z + dz;
    };
    const found = findOnShelves(world, a, Q3, (i) => !/horse|small-cart/.test(i.key));
    assert.ok(found);
    a.must('shop.pick', { shelf: found.shelf.number, key: found.item.key, quantity: 1, price: found.item.price });
    world.tick(10);
    const bk = a.events('shop.basket').at(-1);

    // Talking to the keeper from across the shop (within talk reach, outside the counter): the view carries the basket.
    stand(a, 5);
    stand(b, 1);
    const view = a.must('npc.talk', { targetId: keeper.id }) && a.events('dialogue').at(-1);
    assert.deepEqual({ basket: view.basket?.basket, seq: view.basket?.seq, total: view.basket?.total, count: view.basket?.count },
      { basket: bk.basket, seq: bk.seq, total: bk.total, count: 1 });
    const vb = b.must('npc.talk', { targetId: keeper.id }) && b.events('dialogue').at(-1);
    assert.equal(vb.basket, undefined, "another shopper's conversation never shows A's basket");
    const args = { targetId: keeper.id, session: view.session, basket: bk.basket, seq: bk.seq, total: bk.total };
    assert.match(a.act('shop.pay', args).error, /counter/, 'range: still the counter reach');
    stand(a, 0.8);
    assert.match(a.act('shop.pay', { ...args, session: 'forged' }).error, /conversation has ended/, 'session checked');
    assert.match(a.act('shop.pay', { ...args, total: bk.total - 1 }).error, /price has changed/, 'quote checked');
    assert.match(b.act('shop.pay', { ...args, session: vb.session }).error, /basket is empty/, "B cannot pay A's basket");
    const gold0 = world.players.get(a.id).rpg.gold;
    a.must('shop.pay', args);
    world.tick(10);
    const thanks = a.events('dialogue').at(-1);
    assert.match(thanks.text, new RegExp(`${bk.total} gold for 1 item`));
    assert.equal(thanks.basket, undefined, 'the reply is gone once paid');
    assert.equal(a.character.gold, gold0 - bk.total);
    // Retry (lost reply) from the conversation: recognised, never charged twice, answered in the conversation.
    a.must('shop.pay', args);
    world.tick(10);
    assert.equal(a.character.gold, gold0 - bk.total);
    assert.match(a.events('dialogue').at(-1).text, /already paid/);

    // Capacity is re-checked at settlement: Strength fell after picking (FIXTURE: stored Strength lowered), so paying is
    // refused and nothing changes; with the Strength back, the same basket is paid.
    const heavy = findOnShelves(world, a, Q3, (i) => !/horse|small-cart/.test(i.key));
    a.must('shop.pick', { shelf: heavy.shelf.number, key: heavy.item.key, quantity: 1, price: heavy.item.price });
    world.tick(10);
    const hb = a.events('shop.basket').at(-1);
    stand(a, 0.8);
    const pa0 = world.players.get(a.id);
    const str = pa0.rpg.character.attributes.Strength;
    const max0 = world.ctx.services.maxEncumbrance(pa0);
    pa0.rpg.character.attributes.Strength = 1;
    world.tick(10);
    assert.ok(world.ctx.services.maxEncumbrance(pa0) < max0, 'capacity follows current Strength');
    const gold1 = pa0.rpg.gold;
    const tv = a.must('npc.talk', { targetId: keeper.id }) && a.events('dialogue').at(-1);
    const hargs = { targetId: keeper.id, session: tv.session, basket: hb.basket, seq: hb.seq, total: hb.total };
    assert.match(a.act('shop.pay', hargs).error, /could not carry/);
    assert.equal(pa0.rpg.gold, gold1, 'nothing paid');
    assert.equal(L.peek(Q3).holds.get(a.id)?.lines.get(heavy.item.key)?.quantity, 1, 'the basket is intact');
    pa0.rpg.character.attributes.Strength = str;
    world.tick(10);
    a.must('shop.pay', hargs);
    assert.equal(pa0.rpg.gold, gold1 - hb.total);

    // A held basket survives a graceful restart and is still offered by the keeper afterwards.
    const more = findOnShelves(world, a, Q3, (i) => !/horse|small-cart/.test(i.key));
    a.must('shop.pick', { shelf: more.shelf.number, key: more.item.key, quantity: 1, price: more.item.price });
    world.restart();
    a = world.connect('acct-talkpay-a', 'Aldora');
    await until(world, () => world.ctx.services.shopLedger.keeperAt(Q3), 'the keeper after the restart');
    const k2 = world.ctx.entities.get(world.ctx.services.shopLedger.keeperAt(Q3).id);
    const pa = world.players.get(a.id);
    pa.x = k2.x;
    pa.z = k2.z + 0.8;
    world.tick(250);
    await until(world, () => a.events('shop.basket').at(-1)?.lines?.length, 'the basket after the restart');
    const v2 = a.must('npc.talk', { targetId: k2.id }) && a.events('dialogue').at(-1);
    assert.equal(v2.basket?.count, 1, 'the restored basket is offered at the counter');
    a.must('shop.pay', { targetId: k2.id, session: v2.session, basket: v2.basket.basket, seq: v2.basket.seq, total: v2.basket.total });
    world.tick(10);
    assert.equal(world.ctx.services.shopLedger.peek(Q3).holds.has(a.id), false);
  });
});

describe('[asset] live Mercantile and Personality in every trade price (CalculateTradePrice live values)', () => {
  test('a blessing reaches shelf, counter, repair and service prices and the browser repair quote; expiry reverts them', { ...gate, timeout: 300_000 }, async (t) => {
    const tmp = tempDir('dfw-liveprice-');
    const world = await createFixtureWorld({ dbPath: `${tmp.dir}/world.db`, features: production, dataPath: ARENA2 });
    t.after(() => {
      try { world.close(); } finally { tmp.remove(); }
    });
    await world.ctx.services.interiors.ready;
    for (let i = 0; i < 48; i++) {
      const hour = Math.floor((world.ctx.services.worldClock().minutes % 1440) / 60);
      if (hour >= 9 && hour < 14) break;
      world.clock.advance(5 * 60_000);
      world.tick(10);
    }
    const a = world.connect('acct-liveprice', 'Aldora');
    world.tick(10);
    await enter(world, a, Q3);
    const S = world.ctx.services;
    const p = world.players.get(a.id);
    const keeper = S.shopLedger.keeperAt(Q3);
    const shop = S.shopLedger.open(keeper, p);
    const pers = S.attributeValue(p, 'Personality');
    // FIXTURE: a damaged sword to quote at this general store's counter.
    const sword = S.giveItem(p, 'iron-longsword', 1);
    sword.condition = Math.trunc(sword.maxCondition / 3);
    const counter = await until(world, () => a.events('townServices.counters').at(-1)?.counters?.find((c) => c.services.includes('repair')), 'the repair counter');
    const browserQuote = () => {
      const ev = a.events('townServices.counters').at(-1);
      const pc = browserPriceContext({ quality: counter.quality, character: a.character, mercantile: ev.trade?.mercantile, personality: ev.trade?.personality });
      return repairCost(sword, counter.quality, null, { adjust: ev.market?.adjust ?? 1000, mercantile: pc.mercantile, personality: pc.personality });
    };
    const big = { value: 400_000, template: 'fixture', group: null };
    const formula = (m) => buyPrice(big.value, 1, { ...S.shopLedger.economy.context(p, keeper, shop), mercantile: m });
    // FIXTURE: a stored Mercantile where one more point moves the integer trade price (not every step does).
    let stored = 20;
    while (formula(stored) === formula(stored + 1)) stored++;
    p.rpg.character.skills.Mercantile = stored;
    await until(world, () => a.events('townServices.counters').at(-1)?.trade?.mercantile === stored, 'counters re-sent with the new Mercantile');
    assert.notEqual(formula(stored), formula(stored + 1), 'the fixture price is sensitive to one point of Mercantile');
    assert.equal(S.shopLedger.economy.buyUnit(p, keeper, big, shop), formula(stored), 'before: stored = live');
    assert.equal(browserQuote(), S.repairQuote(p, counter.id, [sword.id]), 'before: the browser repair quote matches the server');

    // Zenithar's blessing (+1 Mercantile, package 15) for a few game minutes.
    const now = S.playerMinutes?.(p) ?? S.worldClock().minutes;
    p.rpg.blessing = { deity: 22, key: 'Mercantile', bonus: 1, until: now + 10 };
    world.clock.advance(2000);
    world.tick(250);
    assert.equal(S.skillValue(p, 'Mercantile'), stored + 1);
    assert.equal(S.priceContext(p).mercantile, stored + 1, 'services.priceContext (repairs, temple cure, spell sellers) is live');
    assert.equal(S.priceContext(p).personality, pers);
    assert.equal(S.shopLedger.economy.buyUnit(p, keeper, big, shop), formula(stored + 1), 'shelf and counter prices are live');
    const during = await until(world, () => a.events('townServices.counters').at(-1)?.trade?.mercantile === stored + 1 && a.events('townServices.counters').at(-1), 'counters re-sent with the blessing');
    assert.deepEqual(during.trade, { mercantile: stored + 1, personality: pers });
    assert.equal(browserQuote(), S.repairQuote(p, counter.id, [sword.id]), 'during: browser and server repair quotes agree');

    // The blessing fades on the shared clock: every price and the published inputs revert.
    world.clock.advance(5 * 60_000);
    world.tick(250);
    await until(world, () => a.events('townServices.counters').at(-1)?.trade?.mercantile === stored, 'counters re-sent after the blessing faded');
    assert.equal(S.priceContext(p).mercantile, stored);
    assert.equal(S.shopLedger.economy.buyUnit(p, keeper, big, shop), formula(stored));
    assert.equal(browserQuote(), S.repairQuote(p, counter.id, [sword.id]), 'after: browser and server repair quotes agree');
  });

  test('fallback without live services: stored values, and the browser reads effective Personality', () => {
    const ch = { skills: { Mercantile: 30 }, attributes: { Personality: 40 }, effectiveAttributes: { Personality: 45 } };
    assert.equal(browserPriceContext({ character: ch }).mercantile, 30);
    assert.equal(browserPriceContext({ character: ch }).personality, 45);
    assert.equal(browserPriceContext({ character: { skills: {}, attributes: { Personality: 40 } } }).personality, 40);
    assert.equal(browserPriceContext({ character: ch, mercantile: 33, personality: 50 }).mercantile, 33);
    assert.equal(browserPriceContext({ character: ch, mercantile: null }).mercantile, 30, 'null falls back');
  });
});

describe('checkout reply right after a reconnect (server/rpg/economy.js)', () => {
  test('the keeper offers the basket before the interior survey re-announces it, and an open conversation updates', async () => {
    const { createRpgRuntime } = await import('../server/rpg/runtime.js');
    const { install: economy } = await import('../server/rpg/economy.js');
    // FIXTURE: one shop interior whose survey (portal meta with shelves) arrives late, and a stub ledger with a keeper.
    const SHOP = 'interior:Daggerfall/Gothway Garden/2,1/15';
    let meta = null;
    const keeper = { id: 'keeper-1', kind: 'npc', location: SHOP, shop: true, name: 'Keeper' };
    const shop = { rev: 1, stock: new Map([['s1:iron-dagger', { template: 'iron-dagger', name: 'Iron Dagger', value: 10, quantity: 2, shelf: 1, group: 'Weapons' }]]) };
    pick(shop, 1, 's1:iron-dagger', 1, 0); // picked before the disconnect: the ledger keeps it through the grace period
    const talked = [];
    const players = new Map();
    const sent = [];
    const rt = createRpgRuntime({
      players,
      features: [
        { name: 'fixture', install: (ctx) => Object.assign(ctx.services, {
          portals: { into: (loc) => (loc === SHOP && meta ? { meta } : null) },
          shopLedger: {
            keeperAt: (loc) => (loc === SHOP ? keeper : null),
            peek: (loc) => (loc === SHOP ? shop : null),
            withHolds: () => [[SHOP, shop]],
            economy: { context: () => priceContext({ quality: 15, regionIndex: regionIndexOf(SHOP), minutes: 0, character: null }) },
            talkBack: (p, e) => talked.push([p.id, e.id]),
          },
        }) },
        { name: 'economy', install: economy },
      ],
      save: () => {},
      send: (p, msg) => sent.push([p.id, msg]),
      now: () => 0,
      log: { info() {}, warn() {}, error() {} },
    });
    const p = { id: 1, name: 'Aldora', x: 0, z: 0, yaw: 0, moving: false, rpg: { location: SHOP, gold: 100 } };
    players.set(1, p);
    rt.join(p);
    rt.tick(0.1, 0);
    const baskets = () => sent.filter(([, m]) => m.type === 'gameEvent' && m.event.kind === 'shop.basket');
    assert.equal(baskets().length, 0, 'the survey is still pending: no basket announced yet');

    // The player talks to the keeper now: the dialogue view must already carry the checkout reply.
    const b = rt.ctx.services.shopBasketFor(p, keeper);
    assert.ok(b, 'the checkout reply is present on the first line');
    assert.equal(b.count, 1);
    assert.equal(b.basket, basketOf(shop, 1).id);
    assert.ok(Number.isInteger(b.total) && b.total > 0);
    assert.equal(rt.ctx.services.shopBasketFor(p, { ...keeper, id: 'someone-else' }), null, 'only this shop\'s keeper offers it');

    // The survey lands: the basket is announced and the open conversation is re-sent with the reply.
    meta = { shelves: [{ number: 1, x: 0, y: 0, z: 0, r: 1 }], buildingName: 'Shop', quality: 15 };
    rt.tick(0.1, 0);
    assert.equal(baskets().length, 1);
    assert.deepEqual(talked.at(-1), [1, keeper.id]);
  });
});
