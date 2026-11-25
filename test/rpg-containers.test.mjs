// Package 7: ordinary items, books, lights, charges, identification, classic loot tables and shared containers.
// Pure rules run everywhere; the [asset] cases read the operator's installed ARENA2 (books, MAGIC-free furniture and
// treasure sites) through the production feature list and skip without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import {
  addItem, normalizeRpg, toggleLight, burnLight, refuelLantern, identify, identifyCost, maxEncumbrance, carriedWeight,
  templateForClassic, templateForIndex, classicGroupTemplates, registerBases, describeTemplate, makeItem,
} from '../server/rpg/inventory.js';
import { parseBook, createBookLibrary, bookFileName } from '../server/rpg/items/books.js';
import {
  generateRandomLoot, dungeonTreasure, stockHouseContainer, privatePropertyList, randomMaterial, shelfBookCount, stockedDate,
} from '../server/rpg/items/loot.js';
import { seeded } from '../server/rpg/containers.js';
import { furnitureKind } from '../client/world/interiors/containers.js';
import { features } from '../server/rpg/features.js';
import { createFixtureWorld, tempDir, localArena2 } from './support/rpg-session.mjs';

const ARENA2 = localArena2();
const asset = { skip: ARENA2 ? false : 'local Daggerfall data not present' };
const fresh = () => normalizeRpg({ inventory: [], equipment: {}, gold: 0 });

test('classic ordinary templates resolve by group and index', () => {
  assert.equal(templateForClassic(7, 0), 'book');
  assert.equal(templateForClassic(9, 0), 'torch');
  assert.equal(templateForClassic(9, 5), 'parchment');
  assert.equal(templateForIndex(74), 'gold-ingredient', 'the metal Gold never collides with currency');
  assert.equal(templateForIndex(0), 'ruby', 'hand-made gem keys are kept');
  assert.deepEqual(classicGroupTemplates('Jewellery'), ['amulet', 'bracer', 'ring', 'bracelet', 'mark', 'torc', 'cloth-amulet', 'wand']);
  const torch = describeTemplate('torch');
  assert.deepEqual([torch.group, torch.weight, torch.maxCondition, torch.light.radius], ['light', 0.5, 50, 14]);
  assert.deepEqual(describeTemplate('red-flowers').stackable, true);
  assert.deepEqual(registerBases({ 'test-relic': { index: 900, name: 'Test Relic', group: 'misc', weight: 1, price: 5, hp: 10 } }), ['test-relic']);
  assert.deepEqual(registerBases({ torch: { name: 'x', group: 'misc' } }), [], 'existing keys are never replaced');
  assert.equal(makeItem('test-relic').name, 'Test Relic');
});

test('per-item state survives normalisation; enchanted items stay single and hide their name until identified', () => {
  const rpg = fresh();
  addItem(rpg, 'amulet', 2, { extra: { magic: { enchantments: [{ type: 0, param: 5 }], identified: false, name: 'Amulet of Flame', uses: 300, value: 1200 } } });
  addItem(rpg, 'parchment', 1, { extra: { letter: { title: 'A letter from Lady Brisienna', lines: ['Meet me.'] } } });
  const raw = JSON.parse(JSON.stringify(rpg));
  normalizeRpg(raw);
  const amulets = raw.inventory.filter((i) => i.template === 'amulet');
  assert.equal(amulets.length, 2);
  assert.deepEqual(amulets.map((a) => [a.name, a.quantity, a.condition, a.maxCondition, a.value]), [['Amulet', 1, 300, 300, 1200], ['Amulet', 1, 300, 300, 1200]]);
  assert.equal(identifyCost(amulets[0]), (25 * 1200) >> 8);
  assert.deepEqual(identify(raw, amulets[0].id), { ok: true, name: 'Amulet of Flame', already: false });
  amulets[0].condition = 290;
  normalizeRpg(raw);
  const again = raw.inventory.find((i) => i.id === amulets[0].id);
  assert.deepEqual([again.name, again.condition, again.magic.identified], ['Amulet of Flame', 290, true]);
  assert.equal(raw.inventory.find((i) => i.template === 'parchment').name, 'A letter from Lady Brisienna');
});

test('lights burn in 20 s ticks, die at zero, and lanterns take oil', () => {
  const rpg = fresh();
  const candle = addItem(rpg, 'candle', 1);
  assert.match(toggleLight(rpg, candle.id), /light your Candle/);
  assert.deepEqual(rpg.lightSource, { itemId: candle.id, template: 'candle', name: 'Candle', radius: 8, condition: 16, maxCondition: 16 });
  for (let i = 0; i < 15; i++) assert.equal(burnLight(rpg).burnedOut, false);
  assert.deepEqual(burnLight(rpg), { burnedOut: true, name: 'Candle' });
  assert.equal(rpg.lightSource, null);
  assert.equal(rpg.inventory.some((i) => i.id === candle.id), false, 'a spent candle is gone');
  const lantern = addItem(rpg, 'lantern', 1);
  lantern.condition = 10;
  addItem(rpg, 'oil', 3);
  assert.match(refuelLantern(rpg, rpg.inventory.find((i) => i.template === 'oil').id), /refuel/);
  assert.equal(lantern.condition, 35);
  assert.equal(rpg.inventory.find((i) => i.template === 'oil').quantity, 2);
  lantern.condition = 90;
  assert.throws(() => refuelLantern(rpg, rpg.inventory.find((i) => i.template === 'oil').id), /full/);
});

test('encumbrance uses floor(Strength × 1.5) and gold weighs 1 kg per 400', () => {
  const rpg = fresh();
  rpg.character = { attributes: { Strength: 47 } };
  assert.equal(maxEncumbrance(rpg), 70);
  rpg.gold = 400;
  assert.equal(carriedWeight(rpg), 1);
});

test('classic loot tables, private property and shelf counts', () => {
  const r = seeded(7);
  const out = generateRandomLoot('T', { level: 5, rand: r });
  assert.ok(out.items[0].template === 'gold' && out.items[0].quantity >= 20 * 5 && out.items[0].quantity <= 80 * 5);
  assert.ok(out.items.some((i) => /-/.test(i.template)), 'table T always has armour and weapons');
  assert.equal(dungeonTreasure(14, { rand: seeded(1) }).key, 'S');
  assert.deepEqual(privatePropertyList(15, 1), [6, 12]);
  assert.deepEqual(privatePropertyList(4, 3), [9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 25]);
  const house = stockHouseContainer(15, 18, { rand: seeded(3) });
  assert.ok(house.items.length >= 1);
  assert.equal(randomMaterial(1, () => 0), 'iron');
  assert.equal(randomMaterial(30, () => 0.999), 'daedric');
  assert.equal(randomMaterial(1, () => 0.3), 'iron');
  assert.deepEqual([0, 2, 7, 12, 17, 20].map(shelfBookCount), [2, 3, 4, 5, 5, 5]);
  assert.equal(stockedDate({ year: 405, dayOfYear: 17 }), 405017);
  assert.equal(furnitureKind(41018, 15), 'ownedShelf');
  assert.equal(furnitureKind(41018, 10), 'bookshelf');
  assert.equal(furnitureKind(41018, 9), 'shelf');
  assert.equal(furnitureKind(41811, 15), 'house');
});

test('[asset] installed books: header, DFU price rule and readable pages', asset, () => {
  const lib = createBookLibrary(ARENA2);
  assert.ok(lib.count >= 80, `${lib.count} books`);
  const b0 = parseBook(readFileSync(join(ARENA2, 'books', bookFileName(0))));
  assert.equal(b0.title, 'The First Scroll of Baan Dar');
  assert.ok(b0.price >= 300 && b0.price <= 800);
  assert.ok(b0.pages.length >= 2);
  assert.match(b0.pages.flat().join(' '), /translation of the/);
  assert.equal(lib.title(0), 'The First Scroll of Baan Dar');
});

async function world() {
  const tmp = tempDir('dfw-containers-');
  const w = await createFixtureWorld({ dbPath: join(tmp.dir, 'c.db'), dataPath: ARENA2, features });
  return { w, tmp, s: w.ctx.services };
}
async function enter(w, s, town, interior, ids) {
  await s.interiors.survey(town);
  const portal = s.portals.into(interior);
  const entrance = portal.entrances[0];
  const clients = ids.map((id) => {
    const row = w.store.createForAccount(id, id);
    w.store.saveCharacters([{ ...row, ...entrance.exit, rpg: { location: town } }]);
    return w.connect(id, id);
  });
  if (interior.startsWith('dungeon:')) await s.collision?.whenSettled?.(interior);
  for (const c of clients) {
    let r = c.act('portal.use', { portalId: portal.id });
    for (let i = 0; i < 100 && !r.ok && /loading|moment/i.test(r.error); i++) {
      await new Promise((res) => setTimeout(res, 100));
      w.tick(100);
      r = c.act('portal.use', { portalId: portal.id });
    }
    assert.equal(r.ok, true, r.error);
    assert.equal(c.character.location, interior);
  }
  await s.containers.ready(interior);
  w.tick(100);
  return clients;
}
const standAt = (c, site) => { c.player.x = site.x; c.player.z = site.z; c.player.y = site.y; c.player.dirty = true; };

test('[asset] a Daggerfall Lyceum bookshelf lists installed books and reads one in place', asset, async (t) => {
  const { w, tmp, s } = await world();
  t.after(() => { w.close(); tmp.remove(); });
  const LYCEUM = 'interior:Daggerfall/Daggerfall/4,2/3';
  const [a] = await enter(w, s, 'town:Daggerfall/Daggerfall', LYCEUM, ['reader']);
  const shelf = s.containers.sites(LYCEUM).find((x) => x.kind === 'bookshelf');
  assert.ok(shelf, 'the Lyceum has bookshelves');
  const id = `ct:${shelf.id}@${LYCEUM}`;
  assert.equal(a.entity(id)?.containerType, 'bookshelf');
  standAt(a, shelf);
  a.must('container.open', { containerId: id });
  const open = a.events('container').at(-1);
  assert.equal(open.books.length, 10);
  const pick = open.books[0];
  a.must('container.read', { containerId: id, bookId: pick.id });
  const book = a.events('book').at(-1);
  assert.equal(book.title, pick.title);
  assert.ok(book.pages.length > 0 && book.pages[0].length > 0);
  assert.match(a.act('container.take', { containerId: id }).error, /stay on the shelf/);
});

test('[asset] Devil\'s Dagger private furniture: confirm, one owner per item, stolen marker and saved weight', asset, async (t) => {
  const { w, tmp, s } = await world();
  t.after(() => { w.close(); tmp.remove(); });
  const INN = 'interior:Daggerfall/Blackidge Hamlet/0,0/11';
  const [a, b] = await enter(w, s, 'town:Daggerfall/Blackidge Hamlet', INN, ['ava', 'bram']);
  const stolen = [];
  w.ctx.on('itemStolen', (e) => stolen.push(e));
  const furniture = s.containers.sites(INN).filter((x) => x.kind === 'house');
  assert.equal(furniture.length, 2);
  // Find a piece with contents today (StockHouseContainer can draw a group that yields nothing on this table).
  let site = null, items = null;
  for (const f of furniture) {
    const id = `ct:${f.id}@${INN}`;
    standAt(a, f);
    a.must('container.open', { containerId: id });
    assert.equal(a.events('container').at(-1).prompt, 'private');
    a.must('container.open', { containerId: id, confirm: true });
    const ev = a.events('container').at(-1);
    if (ev?.containerId === id && ev.items?.length) { site = f; items = ev.items; break; }
  }
  assert.ok(site, 'one piece of furniture holds something');
  const id = `ct:${site.id}@${INN}`;
  standAt(b, site);
  b.must('container.open', { containerId: id, confirm: true });
  assert.deepEqual(b.events('container').at(-1).items.map((i) => i.id), items.map((i) => i.id), 'both see the same contents');
  const first = items.find((i) => i.template !== 'gold') ?? items[0];
  const before = carriedWeight(a.player.rpg);
  assert.equal(a.act('container.take', { containerId: id, itemId: first.id }).ok, true);
  assert.match(b.act('container.take', { containerId: id, itemId: first.id }).error, /no longer there|empty/);
  const got = a.character.inventory.find((i) => i.id === first.id);
  if (first.template !== 'gold') {
    assert.ok(got?.stolen, 'taken private property is marked stolen');
    assert.ok(carriedWeight(a.player.rpg) > before);
  }
  assert.equal(stolen.length, 1);
  assert.equal(b.events('container').at(-1).refreshed, true, 'the other searcher sees the item go');
  w.tick(10);
  a.leave();
  const back = w.connect('ava', 'ava');
  if (first.template !== 'gold') assert.equal(back.character.inventory.find((i) => i.id === first.id)?.name, first.name);
});

test('[asset] Privateer\'s Hold treasure: one owner, restart keeps the removed item gone; torch burn and charges are saved', asset, async (t) => {
  const { w, tmp, s } = await world();
  t.after(() => { w.close(); tmp.remove(); });
  const TOWN = "town:Daggerfall/Privateer's Hold";
  const HOLD = "dungeon:Daggerfall/Privateer's Hold";
  const [a, b] = await enter(w, s, TOWN, HOLD, ['finder', 'second']);
  const sites = s.containers.sites(HOLD).filter((x) => x.kind === 'treasure');
  assert.equal(sites.length, 8, 'the Hold has eight authored treasure markers');
  // Fixture positioning: both characters stand at the treasure nearest the entrance (walking is covered live).
  const start = { x: a.player.x, z: a.player.z };
  const site = sites.slice().sort((p, q) => Math.hypot(p.x - start.x, p.z - start.z) - Math.hypot(q.x - start.x, q.z - start.z))[0];
  const id = `ct:${site.id}@${HOLD}`;
  assert.equal(a.entity(id)?.kind, 'container');
  assert.equal(a.entity(id)?.sprite?.archive, 216, 'treasure is drawn from TEXTURE.216');
  standAt(a, site); standAt(b, site);
  a.must('container.open', { containerId: id });
  const contents = a.events('container').at(-1).items;
  assert.ok(contents.length > 0, 'treasure was stocked from the dungeon loot table');
  b.must('container.open', { containerId: id });
  assert.deepEqual(b.events('container').at(-1).items, contents, 'shared contents');
  const target = contents.at(-1);
  // Both send the same take in the same tick: exactly one succeeds.
  const results = [a.act('container.take', { containerId: id, itemId: target.id }), b.act('container.take', { containerId: id, itemId: target.id })];
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  const winner = results[0].ok ? a : b;
  const loser = results[0].ok ? b : a;
  const owned = (c) => (target.template === 'gold' ? c.character.gold : c.character.inventory.filter((i) => i.id === target.id).length);
  assert.ok(owned(winner) > 0);
  if (target.template !== 'gold') assert.equal(owned(loser), 0);

  // Setup: a torch and an enchanted amulet with charges (given by the test, then used through actions).
  const pa = a.player;
  const torch = s.giveItem(pa, 'torch', 1);
  const amulet = s.giveItem(pa, 'amulet', 1, { extra: { magic: { enchantments: [{ type: 0, param: 2 }], identified: false, name: 'Amulet of Testing', uses: 50 } } });
  a.must('inventory.light', { itemId: torch.id });
  w.tick(20_000); w.tick(20_000);
  assert.equal(a.item(torch.id).condition, 48, 'two 20 s burn ticks');
  const spent = s.useItemCharge(pa, amulet.id, 10);
  assert.equal(spent.remaining, 40);
  assert.equal(s.identifyItem(pa, amulet.id).name, 'Amulet of Testing');
  const weight = carriedWeight(pa.rpg);
  w.tick(10);

  w.restart();
  const back = w.connect('finder', 'finder');
  const again = w.connect('second', 'second');
  await w.ctx.services.containers.ready(HOLD);
  w.tick(100);
  assert.equal(back.item(torch.id).condition, 48);
  assert.equal(back.character.lightSource?.itemId, torch.id, 'the torch is still lit after restart');
  assert.deepEqual([back.item(amulet.id).condition, back.item(amulet.id).maxCondition, back.item(amulet.id).name], [40, 50, 'Amulet of Testing']);
  assert.equal(carriedWeight(back.player.rpg), weight);
  standAt(again, site);
  again.must('container.open', { containerId: id });
  const reopened = again.events('container').at(-1).items;
  assert.equal(reopened.some((i) => i.id === target.id && (target.template !== 'gold' || i.quantity === target.quantity)), false, 'the removed item stays gone');
  assert.equal(reopened.length, contents.length - 1);
});

test('GenerateItems extras: keys J-O roll a map, potion and recipe; descriptors keep their per-item state', async () => {
  const { generateItems } = await import('../server/rpg/items/loot.js');
  const always = () => 0; // every Dice100 roll succeeds
  const none = generateItems('K', { rand: always });
  for (const name of ['map', 'potion', 'recipe']) assert.ok(none.skipped.includes(name), `${name} reported without a supplier`);
  const extras = { map: () => ({ template: 'map' }), potion: () => ({ template: 'potion-of-healing' }), recipe: () => ({ template: 'parchment', appearance: { extra: { recipe: { key: 'x', name: 'Recipe for X' } } } }) };
  const got = generateItems('K', { rand: always, extras });
  assert.ok(['map', 'potion-of-healing', 'parchment'].every((t) => got.items.some((i) => i.template === t)));
  assert.equal(generateItems('A', { rand: always, extras }).items.some((i) => i.template === 'map'), false, 'only keys J-O');
  assert.equal(dungeonTreasure(0, { rand: always, extras }).key, 'K');

  // Through the containers feature: a stocked pile turns the descriptors into records and keeps the recipe state.
  const { createRpgRuntime } = await import('../server/rpg/runtime.js');
  const inventoryFeature = await import('../server/rpg/inventory.js');
  const containers = await import('../server/rpg/containers.js');
  const players = new Map();
  const rt = createRpgRuntime({
    players, save: () => {}, send: () => {}, now: () => 0, log: { error() {}, warn() {}, info() {} },
    features: [inventoryFeature, { name: 'loot-suppliers', install: (ctx) => {
      ctx.services.randomPotionLoot = () => ({ template: 'potion-of-healing', quantity: 1 });
      ctx.services.randomPotionRecipeLoot = () => extras.recipe();
    } }, { name: 'containers', install: (ctx) => containers.install(ctx, { scene: async () => ({ kind: 'dungeon', dungeonType: 0, containers: [{ id: 'chest', kind: 'treasure', x: 0, y: 0, z: 0 }] }) }) }],
  });
  const p = { id: 1, name: 'P', x: 0, z: 0, yaw: 0, rpg: { location: 'dungeon:Test/Vault0', character: { level: 1, attributes: { Strength: 100 } } } };
  players.set(1, p);
  rt.join(p);
  // Stock is seeded by the container's key: search vaults (2 % recipe chance per pile) for one with a recipe.
  let items = null;
  for (let i = 0; i < 1000 && !items?.some((it) => it.template === 'parchment'); i++) {
    const L = `dungeon:Test/Vault${i}`;
    p.rpg.location = L;
    await rt.ctx.services.containers.ready(L);
    const r = rt.act(p, 'container.open', { containerId: `ct:chest@${L}` });
    assert.equal(r.ok, true, r.error);
    items = rt.ctx.services.containers.contents(`ct:chest@${L}`);
  }
  assert.ok(items.some((it) => it.template === 'parchment'), 'a treasure pile with the recipe roll');
  for (const it of items.filter((i) => i.template === 'parchment')) assert.deepEqual(it.recipe, { key: 'x', name: 'Recipe for X' });
});
