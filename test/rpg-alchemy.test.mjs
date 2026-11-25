// Package 16: alchemy, enchanting, soul gems and artifacts.
//
// Unit layer: recipe table vs. DFU classic recipe keys, enchantment power and Item Maker rules.
// FIXTURE layer: the real runtime, real inventory and alchemy features and the real SQLite store
// on a temp file. The service NPC is a FIXTURE entity (invented position) carrying the classic
// guild service ids; the live route through a source-placed NPC is exercised separately. Cases
// that need the operator's MAGIC.DEF (artifacts, magic loot) skip when gamedata/ is absent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RECIPES, CLASSIC_RECIPE_KEYS, classicPotion, matchRecipe, recipeHash } from '../server/rpg/alchemy/recipes.js';
import { ENCHANTMENTS } from '../server/rpg/alchemy/enchantments.js';
import { enchantmentPower, planEnchantment, install as alchemy } from '../server/rpg/alchemy.js';
import { install as inventory, makeItem } from '../server/rpg/inventory.js';
import { install as calendar } from '../server/rpg/calendar.js';
import { holidayInfo } from '../client/gameplay/atmosphere/holidays.js';
import { createFixtureWorld, discoverFeatures, readPersisted, tempDir, localArena2 } from './support/rpg-session.mjs';

const ARENA2 = localArena2();
const needData = { skip: ARENA2 ? false : 'operator ARENA2 (MAGIC.DEF) not installed' };

test('the 20 transcribed recipes reproduce every DFU classic recipe key', () => {
  const hashes = new Set(RECIPES.map((r) => recipeHash([...r.ingredients].sort((a, b) => a - b))));
  for (const k of CLASSIC_RECIPE_KEYS) assert.ok(hashes.has(k), `classic key ${k}`);
  assert.equal(RECIPES.length, 20);
  assert.equal(classicPotion(2).key, 'healing');
  assert.equal(matchRecipe([42, 65, 16, 62])?.key, 'healing', 'order-free match');
  assert.equal(matchRecipe([42, 65, 16]), null, 'a missing ingredient is no recipe');
});

test('enchantment power follows template points and material multipliers', () => {
  assert.equal(enchantmentPower(makeItem('steel-dagger')), 200);
  assert.equal(enchantmentPower(makeItem('iron-dagger')), 150);
  assert.equal(enchantmentPower(makeItem('ebony-katana')), 1200);
  assert.equal(enchantmentPower(makeItem('daedric-claymore')), 2100);
  assert.equal(enchantmentPower(makeItem('arrow')), 150, 'arrow template has points, but planEnchantment refuses ammo');
  assert.equal(enchantmentPower(makeItem('potion-of-healing')), 30);
});

test('Item Maker rules: limit, weapon-only, exclusivity, side effects and gold', () => {
  const dagger = makeItem('steel-dagger');
  const shirt = makeItem('white-short-shirt');
  assert.throws(() => planEnchantment(dagger, [{ type: 0, param: 64 }]), /beyond its limit/); // Heal 360 > 200
  const p = planEnchantment(dagger, [{ type: 0, param: 64 }, { type: 16, param: 2 }]); // + deteriorates in holy places -500
  assert.deepEqual([p.cost, p.gold, p.power], [-140, 3600, 200]);
  assert.throws(() => planEnchantment(shirt, [{ type: 4, param: 0 }]), /only be placed on a weapon/);
  assert.throws(() => planEnchantment(dagger, [{ type: 11, param: -1 }, { type: 23, param: -1 }]), /cannot be combined/);
  assert.throws(() => planEnchantment(dagger, [{ type: 4, param: 0 }, { type: 20, param: 0 }]), /same creatures/);
  assert.throws(() => planEnchantment(dagger, [{ type: 14, param: 5 }, { type: 14, param: 0 }]), /"All"/);
  assert.throws(() => planEnchantment(dagger, [{ type: 0, param: 999 }]), /not offered/);
  assert.throws(() => planEnchantment(makeItem('arrow'), [{ type: 11, param: -1 }]), /cannot be enchanted/);
  assert.throws(() => planEnchantment(dagger, [{ type: 15, param: 9 }]), /no soul gem/);
  assert.throws(() => planEnchantment({ ...dagger, conjuredUntil: 99 }, [{ type: 11, param: -1 }]), /conjured/);
  assert.equal(ENCHANTMENTS[0].options.length, 36, 'Cast When Used offers the 36 classic spells');
});

// ---------------------------------------------------------------------------------------------------- fixture

const NPC = (services, extra = {}) => ({ id: 'npc-fixture-1', kind: 'npc', name: 'Fixture Alchemist', location: 'town:Daggerfall/Gothway Garden', x: 1, z: 0, yaw: 0, services, quality: 10, ...extra });

async function fixture(t, { data = null } = {}) {
  const tmp = tempDir('dfw-alchemy-');
  t.after(() => tmp.remove());
  const dbPath = join(tmp.dir, 'game.db');
  const ranks = new Map(); // FIXTURE guild ranks by player id, kept across restarts
  const features = [
    { name: 'inventory', install: inventory },
    { name: 'alchemy', install: alchemy },
    {
      name: 'fixture-services',
      install: (ctx) => {
        // FIXTURE guild rank (no guilds feature here): the test sets ranks per player id.
        ctx.services.guildRank = (p) => ranks.get(p.id) ?? null;
        ctx.fixtureRanks = ranks;
      },
    },
  ];
  const world = await createFixtureWorld({ dbPath, features, dataPath: data });
  t.after(() => world.close());
  assert.deepEqual(world.installErrors, []);
  const connect = (acct = 'acct-1', name = 'Alchemist') => {
    const c = world.connect(acct, name);
    c.player.rpg.character ??= { level: 5, health: 20, maxHealth: 60, fatigue: 50, maxFatigue: 80, magicka: 10, maxMagicka: 40, attributes: { Strength: 60 }, bonusPoints: 0 };
    return c;
  };
  const npc = (services, extra) => { const e = NPC(services, extra); world.ctx.entities.set(e.id, e); return e; };
  return { world, dbPath, connect, npc };
}

const give = (world, c, template, qty = 1, appearance) => world.ctx.services.giveItem(c.player, template, qty, appearance);
const byTemplate = (c, t) => c.player.rpg.inventory.find((i) => i.template === t);

test('Potion Maker: a recipe brews a real potion from real ingredients and consumes one of each', async (t) => {
  const { world, dbPath, connect, npc } = await fixture(t);
  const a = connect();
  const e = npc(['makePotions']);
  for (const k of ['elixir-vitae', 'red-berries', 'mercury', 'trolls-blood']) give(world, a, k, 2);
  const healingBefore = byTemplate(a, 'potion-of-healing')?.quantity ?? 0;
  // Too far from the maker.
  a.moveTo(30, 30);
  assert.match(a.act('alchemy.brew', { targetId: e.id, recipe: 'healing' }).error, /too far/);
  a.moveTo(0, 0);
  assert.match(a.act('alchemy.brew', { targetId: e.id, recipe: 'healing' }).error, /do not know that recipe/);
  const ids = ['elixir-vitae', 'red-berries', 'mercury', 'trolls-blood'].map((k) => byTemplate(a, k).id);
  a.must('alchemy.brew', { targetId: e.id, itemIds: ids });
  assert.equal(byTemplate(a, 'potion-of-healing').quantity, healingBefore + 1);
  for (const k of ['elixir-vitae', 'red-berries', 'mercury', 'trolls-blood']) assert.equal(byTemplate(a, k).quantity, 1, `${k} consumed once`);
  assert.deepEqual(a.player.rpg.alchemy.known, ['healing'], 'brewing discovers the recipe');
  // Now the recipe button fills the cauldron itself.
  a.must('alchemy.brew', { targetId: e.id, recipe: 'healing' });
  assert.equal(byTemplate(a, 'potion-of-healing').quantity, healingBefore + 2);
  assert.equal(byTemplate(a, 'mercury'), undefined, 'last mercury used');
  // Drinking one restores health and tells the drinker how much (the private `heal` event).
  const hpBefore = a.player.rpg.character.health;
  a.must('inventory.use', { itemId: byTemplate(a, 'potion-of-healing').id });
  const restored = a.player.rpg.character.health - hpBefore;
  assert.ok(restored > 0, 'the potion healed');
  assert.deepEqual(a.events('heal').map((ev) => ev.amount), [restored], 'one heal event, with the amount restored');
  // A wrong mixture is lost.
  give(world, a, 'twigs'); give(world, a, 'aloe');
  a.must('alchemy.brew', { targetId: e.id, itemIds: [byTemplate(a, 'twigs').id, byTemplate(a, 'aloe').id] });
  assert.equal(byTemplate(a, 'twigs'), undefined);
  assert.ok(a.events('alchemy').some((ev) => /fail to mix/.test(ev.text)));
  // Orc Strength is a recipe-only potion: brewing then drinking fortifies Strength and spends it.
  for (const k of ['orcs-blood', 'iron', 'pure-water']) give(world, a, k);
  a.must('alchemy.brew', { targetId: e.id, itemIds: ['orcs-blood', 'iron', 'pure-water'].map((k) => byTemplate(a, k).id) });
  const orc = byTemplate(a, 'potion-of-orc-strength');
  assert.ok(orc, 'Potion of Orc Strength in the pack');
  a.must('inventory.use', { itemId: orc.id }); // the ordinary inventory action delegates to alchemy (no double charge)
  const fx = a.player.rpg.magic.active.find((x) => x.key === 'Fortify-Strength');
  assert.ok(fx && fx.amount === 1 + 14 * 5, `fortify ${fx?.amount}`);
  assert.equal(byTemplate(a, 'potion-of-orc-strength'), undefined, 'drunk');
  // Persisted through the real store.
  a.leave();
  const row = readPersisted(dbPath, a.player.id);
  assert.deepEqual(row.rpg.alchemy.known.sort(), ['healing', 'orcStrength']);
});

test('Potion recipes: reading one teaches it; the merchant sells classic potions for gold', async (t) => {
  const { world, connect, npc } = await fixture(t);
  const a = connect();
  world.ctx.services.giveRecipe(a.player, 'invisibility');
  const rec = byTemplate(a, 'potion-recipe');
  assert.equal(rec.recipe.key, 'invisibility');
  a.must('alchemy.use', { itemId: rec.id });
  assert.ok(a.player.rpg.alchemy.known.includes('invisibility'));
  assert.ok(a.events('alchemy').some((ev) => /Rain Water/i.test(ev.text) && /Diamond/i.test(ev.text)), 'ingredient names from the catalogue');
  const e = npc(['potions']);
  a.must('alchemy.open', { targetId: e.id, service: 'potions' });
  const panel = a.events('alchemyPanel').at(-1);
  assert.equal(panel.offers.length, 11, 'quality 10 → 11 offers (GetMerchantPotions)');
  const offer = panel.offers[0];
  a.player.rpg.gold = offer.price - 1;
  assert.match(a.act('alchemy.buy', { targetId: e.id, service: 'potions', offerId: offer.offerId }).error, /costs/);
  a.player.rpg.gold = 10_000;
  a.must('alchemy.buy', { targetId: e.id, service: 'potions', offerId: offer.offerId });
  assert.equal(a.player.rpg.gold, 10_000 - offer.price);
  assert.ok(byTemplate(a, offer.template));
});

test('Item Maker: rank, gold and power checked; enchanted dagger keeps its powers across a restart', async (t) => {
  const { world, dbPath, connect, npc } = await fixture(t);
  const a = connect();
  const e = npc(['makeItems'], { guild: 'mages', faction: 40 });
  const dagger = byTemplate(a, 'steel-dagger');
  const order = { targetId: e.id, itemId: dagger.id, enchantments: [{ type: 0, param: 64 }, { type: 16, param: 2 }], name: 'Mending Fang' };
  assert.match(a.act('alchemy.enchant', order).error, /Only members of the Mages Guild/);
  world.ctx.fixtureRanks.set(a.player.id, 4);
  assert.match(a.act('alchemy.enchant', order).error, /rank 5/);
  world.ctx.fixtureRanks.set(a.player.id, 5);
  a.player.rpg.gold = 3599;
  assert.match(a.act('alchemy.enchant', order).error, /gold/);
  assert.equal(byTemplate(a, 'steel-dagger').magic, undefined, 'nothing changed on refusal');
  a.player.rpg.gold = 4000;
  a.must('alchemy.enchant', order);
  assert.equal(a.player.rpg.gold, 400);
  const made = a.player.rpg.inventory.find((i) => i.name === 'Mending Fang');
  assert.deepEqual(made.magic.enchantments, [{ type: 0, param: 64 }, { type: 16, param: 2 }]);
  assert.match(a.act('alchemy.enchant', { ...order, itemId: made.id }).error, /already enchanted/);
  const id = made.id;
  world.restart();
  const b = connect();
  const again = b.player.rpg.inventory.find((i) => i.id === id);
  assert.equal(again.name, 'Mending Fang');
  assert.deepEqual(again.magic.enchantments, [{ type: 0, param: 64 }, { type: 16, param: 2 }]);
  assert.equal(readPersisted(dbPath, b.player.id).rpg.inventory.find((i) => i.id === id).magic.name, 'Mending Fang');
});

test('Identify: unidentified magic loot is identified for gold through the shared inventory service', needData, async (t) => {
  const { world, connect, npc } = await fixture(t, { data: ARENA2 });
  calendar(world.ctx);
  const a = connect();
  let s = 7;
  const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const d = world.ctx.services.randomMagicLoot(5, random);
  assert.ok(d && d.appearance.extra.magic.enchantments.length, 'MAGIC.DEF regular item');
  const it = give(world, a, d.template, 1, d.appearance);
  assert.equal(it.magic.identified, false);
  assert.notEqual(it.name, d.appearance.extra.magic.name, 'name hidden until identified');
  const e = npc(['identify'], { guild: 'mages' });
  a.player.rpg.gold = 100_000;
  a.must('alchemy.open', { service: 'identify', targetId: e.id });
  const normalCost = a.events('alchemyPanel').at(-1).items.find(i => i.id === it.id).price;
  assert.ok(normalCost > 0);
  a.must('alchemy.identify', { targetId: e.id, itemId: it.id });
  const now = a.player.rpg.inventory.find((i) => i.id === it.id);
  assert.equal(now.magic.identified, true);
  assert.equal(now.name, d.appearance.extra.magic.name);
  assert.equal(a.player.rpg.gold, 100_000 - normalCost);

  const second = give(world, a, d.template, 1, d.appearance);
  const festival = (holidayInfo('witches-festival').dayOfYear - 1) * 1440;
  let minutes = festival;
  world.ctx.services.worldClock = () => ({ minutes });
  const identifyArgs = { targetId: e.id, itemId: second.id, expectCost: 0 };
  const quotedPrice = () => a.events('alchemyPanel').at(-1).items.find(i => i.id === second.id).price;
  a.must('alchemy.open', { service: 'identify', targetId: e.id });
  assert.equal(quotedPrice(), 0);
  minutes += 1440;
  a.must('alchemy.identify', identifyArgs);
  assert.equal(quotedPrice(), normalCost, 'midnight changes the quote before any charge');
  assert.equal(second.magic.identified, false);
  assert.equal(a.player.rpg.gold, 100_000 - normalCost);
  minutes = festival;
  a.player.rpg.gold = 0;
  a.must('alchemy.identify', identifyArgs);
  assert.equal(second.magic.identified, true);
  assert.equal(a.player.rpg.gold, 0, 'the guild identifies the item for free');
});

test('Artifacts: the three Totem rewards resolve, grant once and keep their MAGIC.DEF powers', needData, async (t) => {
  const { world, connect } = await fixture(t, { data: ARENA2 });
  const s = world.ctx.services;
  const a = connect();
  const totem = { Warlocks_Ring: 'ring', Necromancers_Amulet: 'amulet', Chrysamere: 'claymore' };
  for (const [detail, base] of Object.entries(totem)) {
    const key = s.artifactTemplate(detail);
    assert.match(key, /^artifact-/);
    const info = s.artifactInfo(key);
    assert.ok(info.available && info.base.endsWith(base), `${detail} -> ${info.base}`);
    s.giveItem(a.player, key, 1);
    assert.equal(s.countItem(a.player, key), 1);
    assert.throws(() => s.giveItem(a.player, key, 1), /already possess/);
    assert.ok(s.findItem(a.player, key).magic.enchantments.length >= 2);
    assert.ok(a.player.rpg.artifacts[key]);
  }
  assert.equal(s.artifactTemplate('Masque_of_Clavicus_Vile'), 'artifact-masque-of-clavicus');
  assert.equal(s.artifactTemplate(22), 'artifact-ebony-blade');
  assert.equal(s.artifactInfo('artifact-ebony-blade').base, 'ebony-katana');
  assert.equal(s.artifactTemplate("The Mace of Molag Bal"), 'artifact-mace-of-molag-bal');
});

test("Azura's Star traps a soul, binds it in the Item Maker, stays reusable and survives a restart", needData, async (t) => {
  const { world, dbPath, connect, npc } = await fixture(t, { data: ARENA2 });
  const s = world.ctx.services;
  const a = connect();
  assert.deepEqual(s.captureSoul(a.player, { id: 18, name: 'Ghost' }), { captured: false, reason: 'no empty soul gem' });
  s.giveItem(a.player, 'artifact-azuras-star', 1);
  const r = s.captureSoul(a.player, { id: 18, name: 'Ghost', points: 30000 });
  assert.equal(r.captured, true);
  const starId = r.itemId;
  world.restart();
  const b = connect();
  const star = b.player.rpg.inventory.find((i) => i.id === starId);
  assert.deepEqual(star.magic.soul, { id: 18, name: 'Ghost', points: 30000 });
  assert.equal(star.magic.artifact, 'artifact-azuras-star');
  assert.ok(readPersisted(dbPath, b.player.id).rpg.artifacts['artifact-azuras-star']);
  // Bind the ghost into a sword: the soul (-300) pays for Featherweight (+100) and more.
  const e = npc(['makeItems'], { guild: 'mages' });
  world.ctx.fixtureRanks.set(b.player.id, 5);
  b.player.rpg.gold = 2000;
  const sword = byTemplate(b, 'iron-longsword');
  if (sword.equipped) b.must('inventory.unequip', { itemId: sword.id });
  b.must('alchemy.enchant', { targetId: e.id, itemId: sword.id, enchantments: [{ type: 15, param: 18 }, { type: 11, param: -1 }] });
  const bound = b.player.rpg.inventory.find((i) => i.id === sword.id);
  // A Ghost soul also forces Featherweight (already chosen), Item Deteriorates in holy places and Low Damage Vs
  // Undead (SoulBound.MobileForcedEnchantmentSets); the side effects cost no gold.
  assert.deepEqual(bound.magic.enchantments, [{ type: 15, param: 18 }, { type: 11, param: -1 }, { type: 16, param: 2 }, { type: 20, param: 0 }]);
  assert.equal(bound.weight, 0.25, 'Featherweight');
  assert.equal(b.player.rpg.gold, 1000, '10 × the Featherweight power');
  const starAfter = b.player.rpg.inventory.find((i) => i.id === starId);
  assert.ok(starAfter && !starAfter.magic.soul, 'the Star is emptied, not consumed');
  assert.equal(s.captureSoul(b.player, { id: 1, name: 'Imp', points: 1000 }).captured, true, 'and fills again');
});

test('Soul gems: the guild sells empty and filled gems; a capture fills an empty gem', needData, async (t) => {
  const { world, connect, npc } = await fixture(t, { data: ARENA2 });
  const a = connect();
  const e = npc(['soulgems']);
  a.must('alchemy.open', { targetId: e.id, service: 'soulgems' });
  const offers = a.events('alchemyPanel').at(-1).offers;
  const empty = offers.find((o) => !o.soul);
  a.player.rpg.gold = 6000;
  a.must('alchemy.buy', { targetId: e.id, service: 'soulgems', offerId: empty.offerId });
  assert.equal(a.player.rpg.gold, 1000);
  const gem = byTemplate(a, 'soul-trap');
  assert.ok(gem && !gem.magic?.soul);
  const r = world.ctx.services.captureSoul(a.player, { id: 2, name: 'Spriggan', points: 1000 });
  assert.equal(r.itemId, gem.id);
  assert.equal(a.player.rpg.inventory.find((i) => i.id === gem.id).magic.soul.name, 'Spriggan');
  assert.match(a.act('alchemy.buy', { targetId: e.id, service: 'soulgems', offerId: empty.offerId }).error, /no longer for sale/);
});

test('Oghma Infinium grants a 30-point attribute award and disappears; ownership is kept', needData, async (t) => {
  const { world, dbPath, connect } = await fixture(t, { data: ARENA2 });
  const s = world.ctx.services;
  const a = connect();
  const book = s.giveItem(a.player, 'artifact-oghma-infinium', 1);
  a.must('alchemy.use', { itemId: book.id });
  assert.equal(a.player.rpg.character.bonusPoints, 30);
  assert.equal(s.countItem(a.player, 'artifact-oghma-infinium'), 0);
  a.leave();
  assert.ok(readPersisted(dbPath, a.player.id).rpg.artifacts['artifact-oghma-infinium'], 'the grant record persists');
});

test('loot descriptors for combat are deterministic for a given random source', needData, async (t) => {
  const { world } = await fixture(t, { data: ARENA2 });
  const s = world.ctx.services;
  const seq = (seed) => { let x = seed; return () => ((x = (x * 48271) % 2147483647) / 2147483647); };
  assert.deepEqual(s.randomPotionLoot(seq(3)), s.randomPotionLoot(seq(3)));
  assert.deepEqual(s.randomMagicLoot(4, seq(9)), s.randomMagicLoot(4, seq(9)));
  assert.equal(s.randomPotionRecipeLoot(seq(5)).template, 'potion-recipe');
  const mi = s.randomMagicItem(seq(9));
  assert.ok(mi.template && mi.extra.magic.enchantments.length && mi.extra.magic.identified === false, 'container magic item descriptor');
});

// ------------------------------------------------------------------------------------------------ [asset]

describe('[asset] real Mages Guild of Daggerfall: Item Maker route, Cast When Used, saved ownership', () => {
  test('talk → Item Maker → enchant → use heals → restart keeps the item', needData, async (t) => {
    const { features } = await discoverFeatures();
    const tmp = tempDir('dfw-alchemy-live-');
    const dbPath = join(tmp.dir, 'world.db');
    const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
    t.after(() => { try { world.close(); } finally { tmp.remove(); } });
    assert.deepEqual(world.installErrors, []);
    const s = world.ctx.services;
    await s.interiors.ready;
    const c = world.connect('acct-maker', 'Enchantress');
    const p = world.players.get(c.id);
    // FIXTURE SETUP: rank 5 (the Item Maker rank), promoted today so the monthly rank review is not due yet.
    p.rpg.guilds = { mages: { rank: 5, joinedAt: '2026-11-25T00:00:00Z', lastRankChange: Math.floor(s.worldClock().minutes / 1440) } };
    const maker = await visit(world, c, 'town:Daggerfall/Daggerfall', MAGES, (e) => e.faction === 802, 'the Item Maker of the Daggerfall Mages Guild');
    c.must('npc.talk', { targetId: maker.id });
    const session = c.events('dialogue').at(-1).session;
    assert.ok(session, 'conversation session');
    c.must('npc.service', { targetId: maker.id, session, service: 'makeItems' });
    const panel = c.events('alchemyPanel').at(-1);
    assert.equal(panel.service, 'makeItems');
    assert.equal(panel.npcId, maker.id);
    const dagger = p.rpg.inventory.find((i) => i.template === 'steel-dagger');
    assert.ok(panel.items.some((i) => i.id === dagger.id && i.power === 200), 'the starter steel dagger is offered with 200 points');
    for (let left = 3600; left > 0; left -= 9999) s.addGold(p, Math.min(9999, left)); // FIXTURE SETUP: the fee
    const goldBefore = p.rpg.gold;
    c.must('alchemy.enchant', { targetId: maker.id, session, itemId: dagger.id, enchantments: [{ type: 0, param: 64 }, { type: 16, param: 2 }], name: 'Mending Fang' });
    assert.equal(p.rpg.gold, goldBefore - 3600, '10 × the 360-point Heal power');
    const made = p.rpg.inventory.find((i) => i.id === dagger.id);
    assert.equal(made.name, 'Mending Fang');
    // Use it: Cast When Used Heal (SPELLS.STD 64) through the shared spell owner, 10 charges spent.
    p.rpg.character.health = Math.max(1, p.rpg.character.maxHealth - 40);
    const hp = p.rpg.character.health;
    const cond = made.condition;
    c.must('alchemy.use', { itemId: made.id });
    world.tick(250);
    assert.ok(p.rpg.character.health > hp, `healed ${hp} → ${p.rpg.character.health}`);
    assert.equal(p.rpg.inventory.find((i) => i.id === made.id).condition, cond - 10);
    world.restart();
    const again = world.connect('acct-maker', 'Enchantress');
    const kept = world.players.get(again.id).rpg.inventory.find((i) => i.id === made.id);
    assert.equal(kept.name, 'Mending Fang');
    assert.deepEqual(kept.magic.enchantments, [{ type: 0, param: 64 }, { type: 16, param: 2 }]);
    assert.equal(kept.condition, cond - 10);
    assert.equal(readPersisted(dbPath, again.id).rpg.inventory.find((i) => i.id === made.id).magic.name, 'Mending Fang');
  });
});

const MAGES = 'interior:Daggerfall/Daggerfall/1,2/0';

async function until(world, fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** FIXTURE POSITIONING: production portal transfer to the building's door landing, then beside the NPC. */
async function visit(world, c, town, interior, pick, what) {
  const s = world.ctx.services;
  const p = world.players.get(c.id);
  if (world.ctx.location(p) !== town) s.portals.transfer(p, { location: town, x: 0, z: 0, yaw: 0 }, { label: 'outside' });
  await s.interiors.survey(town);
  const spec = s.portals.at(town).find((sp) => sp.to === interior);
  assert.ok(spec, `${interior} is a surveyed door of ${town}`);
  s.portals.transfer(p, { location: interior, x: spec.entrances[0].inner.x, y: spec.entrances[0].inner.y ?? 0, z: spec.entrances[0].inner.z, yaw: 0 }, { portal: spec });
  await s.collision.whenSettled(interior);
  const e = await until(world, () => c.state?.entities?.find((x) => x.kind === 'npc' && x.location === interior && pick(x)), what);
  p.x = e.x;
  p.z = e.z + 0.8;
  if (p.rpg.portal && Number.isFinite(e.y)) p.rpg.portal.footY = e.y;
  world.tick(40);
  return e;
}
