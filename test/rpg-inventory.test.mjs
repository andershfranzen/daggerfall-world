import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as model from '../client/gameplay/inventory/model.js';

const { describeTemplate, resolveTemplate, catalogue, STARTER_KIT, STARTER_CLOTHES, STARTER_GOLD } = inventory;

function world() {
  const players = new Map();
  const saved = [];
  const sent = [];
  let clock = 0;
  const rt = createRpgRuntime({
    players,
    features: [inventory],
    save: (list) => saved.push(list.map((p) => p.id)),
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const join = (id, rpg = {}) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const events = (id, kind) => sent.filter(([i, m]) => i === id && m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map(([, m]) => m.event);
  return { rt, players, join, saved, sent, events, advance: (ms) => { clock += ms; rt.tick(ms / 1000, clock); } };
}

const byTemplate = (p, t) => p.rpg.inventory.find((i) => i.template === t);

test('catalogue: iron longsword and classic material multipliers', () => {
  const ls = describeTemplate('iron-longsword');
  assert.equal(ls.name, 'Iron Longsword');
  assert.equal(ls.weaponType, 'LongBlade');
  assert.equal(ls.weaponFile, 'WEAPON04.CIF');
  assert.equal(ls.skill, 'Long Blade');
  assert.deepEqual(ls.damage, { min: 2, max: 16 });
  assert.equal(ls.value, 45); // 15 * 3 * 1
  assert.equal(ls.weight, 4.5); // 18 quarter-kg * 4/4
  assert.equal(ls.maxCondition, 800);
  const dl = describeTemplate('daedric-longsword');
  assert.equal(dl.value, 15 * 3 * 512);
  assert.equal(dl.maxCondition, 800 * 8);
  assert.equal(dl.weight, 5.5); // 18 quarter-kg * 5/4 = 22.5, Mathf.Round -> 22
  assert.equal(describeTemplate('ebony-dagger').weight, 0.25);
  assert.equal(describeTemplate('dagger').template, 'iron-dagger');
  assert.equal(describeTemplate('war-axe').hands, 'both');
  assert.equal(describeTemplate('battle-axe').weaponFile, 'WEAPON08.CIF');
  assert.equal(describeTemplate('short-bow').weaponFile, 'WEAPON09.CIF');
  assert.equal(describeTemplate('staff').weaponFile, 'WEAPON01.CIF');
  assert.equal(describeTemplate('steel-dagger').weaponFile, 'WEAPON02.CIF');
  assert.equal(inventory.UNARMED.weaponFile, 'WEAPON10.CIF');
});

test('catalogue: armour families, shields and invalid keys', () => {
  assert.equal(describeTemplate('leather-cuirass').armorValue, 3);
  assert.equal(describeTemplate('leather-cuirass').weight, 6.25);
  assert.equal(describeTemplate('chain-cuirass').armorValue, 6);
  assert.equal(describeTemplate('chain-cuirass').value, 200);
  assert.equal(describeTemplate('daedric-helm').armorValue, 21);
  assert.equal(describeTemplate('steel-boots').slot, 'feet');
  assert.deepEqual(describeTemplate('tower-shield').covers, ['head', 'leftArm', 'hands', 'legs']);
  assert.equal(describeTemplate('buckler').armorValue, 1);
  assert.equal(resolveTemplate('leather-longsword'), null);
  assert.equal(resolveTemplate('iron-arrow'), null);
  assert.equal(resolveTemplate('nonsense'), null);
  assert.equal(resolveTemplate({}), null);
  for (const key of catalogue()) assert.ok(describeTemplate(key).name, key);
});

test('new character gets the sample kit once with weapon equipped; rejoin does not duplicate', () => {
  const w = world();
  const p = w.join(1);
  const n = STARTER_KIT.length + STARTER_CLOTHES.length;
  assert.equal(p.rpg.inventory.length, n);
  assert.equal(p.rpg.gold, STARTER_GOLD);
  const sword = byTemplate(p, 'iron-longsword');
  assert.equal(p.rpg.equipment.rightHand, sword.id);
  assert.equal(sword.equipped, 'rightHand');
  assert.equal(p.rpg.weaponView.weaponFile, 'WEAPON04.CIF');
  assert.equal(p.rpg.weaponView.template, 'iron-longsword');
  assert.ok(p.rpg.equipment.chestArmor && p.rpg.equipment.head && p.rpg.equipment.feet);
  assert.equal(byTemplate(p, 'arrow').quantity, 24);

  // Persist and rejoin (JSON round-trip like the database).
  const stored = JSON.parse(JSON.stringify(p.rpg));
  w.players.delete(1);
  const again = w.join(1, stored);
  assert.equal(again.rpg.inventory.length, n);
  assert.equal(again.rpg.gold, STARTER_GOLD);
  assert.equal(again.rpg.equipment.rightHand, sword.id);
});

test('legacy or tampered records are normalised', () => {
  const w = world();
  const p = w.join(2, {
    inventoryVersion: inventory.INVENTORY_VERSION,
    gold: -5,
    inventory: [
      { id: 'a', template: 'iron-longsword', name: 'Hacked', weight: 0, value: 1e9, quantity: 7 },
      { id: 'a', template: 'iron-dagger' },
      { id: 'b', template: 'not-a-thing' },
      { id: 'c', template: 'arrow', quantity: 5 },
    ],
    equipment: { rightHand: 'a', head: 'c', leftHand: 'zzz' },
  });
  assert.equal(p.rpg.gold, 0);
  assert.equal(p.rpg.inventory.length, 2);
  const s = p.rpg.inventory[0];
  assert.equal(s.name, 'Iron Longsword');
  assert.equal(s.quantity, 1);
  assert.equal(s.weight, 4.5);
  assert.deepEqual(p.rpg.equipment, { rightHand: 'a' });
});

test('equip, two-handed rules, shields and unequip via actions', () => {
  const w = world();
  const p = w.join(3);
  const axe = inventory.addItem(p.rpg, 'iron-war-axe');
  const buckler = byTemplate(p, 'buckler');
  assert.deepEqual(w.rt.act(p, 'inventory.equip', { itemId: buckler.id }), { ok: true });
  assert.equal(p.rpg.equipment.leftHand, buckler.id);
  assert.deepEqual(w.rt.act(p, 'inventory.equip', { itemId: axe.id }), { ok: true });
  assert.equal(p.rpg.equipment.rightHand, axe.id);
  assert.equal(p.rpg.equipment.leftHand, undefined, 'two-handed weapon frees the shield hand');
  assert.equal(buckler.equipped, undefined);
  assert.equal(p.rpg.weaponView.weaponType, 'Battleaxe');
  // Shield again removes the two-hander.
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: buckler.id }).ok, true);
  assert.equal(p.rpg.equipment.rightHand, undefined);
  assert.equal(p.rpg.weaponView.template, 'unarmed');
  assert.equal(p.rpg.weaponView.weaponFile, 'WEAPON10.CIF');
  // Off-hand one-handed weapon.
  const dagger = byTemplate(p, 'steel-dagger');
  const sword = byTemplate(p, 'iron-longsword');
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: sword.id }).ok, true);
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: dagger.id, slot: 'leftHand' }).ok, true);
  assert.equal(p.rpg.equipment.leftHand, dagger.id);
  // Invalid requests fail with readable errors and leave state alone.
  const before = JSON.stringify(p.rpg);
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: 'nope' }).error, /do not have/);
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: byTemplate(p, 'leather-helm').id, slot: 'feet' }).error, /does not fit/);
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: byTemplate(p, 'arrow').id }).error, /cannot be equipped/);
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: axe.id, slot: 'leftHand' }).error, /does not fit/);
  assert.equal(JSON.stringify(p.rpg), before);
  assert.equal(w.rt.act(p, 'inventory.unequip', { slot: 'leftHand' }).ok, true);
  // Failed actions restore cloned state, so look items up again.
  assert.equal(byTemplate(p, 'steel-dagger').equipped, undefined);
  assert.match(w.rt.act(p, 'inventory.unequip', { slot: 'leftHand' }).error, /Nothing/);
});

test('armour values follow equipped pieces', () => {
  const w = world();
  const p = w.join(4);
  let av = inventory.armorValues(p.rpg);
  assert.equal(av.chest, 3);
  assert.equal(av.head, 3);
  assert.equal(av.feet, 3);
  const plate = inventory.addItem(p.rpg, 'dwarven-cuirass');
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: plate.id }).ok, true);
  av = inventory.armorValues(p.rpg);
  assert.equal(av.chest, 13);
  const shield = inventory.addItem(p.rpg, 'kite-shield');
  w.rt.act(p, 'inventory.equip', { itemId: shield.id });
  av = inventory.armorValues(p.rpg);
  assert.equal(av.legs, 3);
  assert.equal(av.leftArm, 3);
  assert.deepEqual(model.armorValues(p.rpg), av, 'client model agrees with server');
});

test('potions heal, consume one from the stack and refuse at full', () => {
  const w = world();
  const p = w.join(5, { character: { health: 10, maxHealth: 100, fatigue: 5, maxFatigue: 5 } });
  const potion = byTemplate(p, 'potion-of-healing');
  assert.equal(w.rt.act(p, 'inventory.use', { itemId: potion.id }).ok, true);
  assert.equal(p.rpg.character.health, 40);
  assert.equal(potion.quantity, 2);
  assert.ok(w.events(5, 'inventory').some((e) => /drink/i.test(e.text)));
  assert.equal(w.events(5, 'heal').at(-1)?.amount, 30, 'the drinker is told how much was restored');
  const stamina = byTemplate(p, 'potion-of-stamina');
  assert.match(w.rt.act(p, 'inventory.use', { itemId: stamina.id }).error, /already full/);
  assert.equal(stamina.quantity, 1);
  const id = byTemplate(p, 'potion-of-healing').id;
  assert.equal(w.rt.act(p, 'inventory.use', { itemId: id }).ok, true);
  assert.equal(w.rt.act(p, 'inventory.use', { itemId: id }).ok, true);
  assert.equal(byTemplate(p, 'potion-of-healing'), undefined, 'empty stack removed');
  assert.equal(p.rpg.character.health, 100);
  assert.match(w.rt.act(p, 'inventory.use', { itemId: id }).error, /do not have/);
});

test('giveItem/takeItem services: stacks, gold, validation and equipped protection', () => {
  const w = world();
  const p = w.join(6);
  const s = w.rt.ctx.services;
  const arrows = s.giveItem(p, 'arrow', 6);
  assert.equal(arrows.quantity, 30);
  assert.equal(s.giveItem(p, 'gold', 50).quantity, 50);
  assert.equal(p.rpg.gold, 150);
  const two = s.giveItem(p, 'iron-mace', 2);
  assert.equal(p.rpg.inventory.filter((i) => i.template === 'iron-mace').length, 3);
  assert.equal(two.quantity, 1);
  assert.throws(() => s.giveItem(p, 'bogus'), /Unknown item/);
  assert.throws(() => s.giveItem(p, 'arrow', 0), /Invalid quantity/);
  const part = s.takeItem(p, arrows.id, 10);
  assert.equal(part.quantity, 10);
  assert.notEqual(part.id, arrows.id);
  assert.equal(arrows.quantity, 20);
  assert.throws(() => s.takeItem(p, arrows.id, 21), /only have 20/);
  assert.throws(() => s.takeItem(p, 'gold', 1000), /enough gold/);
  assert.equal(s.takeGold(p, 40).quantity, 40);
  assert.equal(p.rpg.gold, 110);
  const sword = byTemplate(p, 'iron-longsword');
  assert.throws(() => s.takeItem(p, sword.id), /Unequip/);
  assert.equal(p.rpg.equipment.rightHand, sword.id);
  assert.equal(s.countItem(p, 'arrow'), 20);
  assert.equal(s.countItem(p, 'mace'), 3);
  assert.equal(s.getEquippedWeapon(p).template, 'iron-longsword');
});

test('transferItem is atomic and keeps condition', () => {
  const w = world();
  const a = w.join(7);
  const b = w.join(8);
  const s = w.rt.ctx.services;
  const axe = byTemplate(a, 'iron-battle-axe');
  axe.condition = 100;
  const moved = s.transferItem(a, b, axe.id);
  assert.equal(byTemplate(a, 'iron-battle-axe'), undefined);
  const got = b.rpg.inventory.find((i) => i.id === moved.id || (i.template === 'iron-battle-axe' && i.condition === 100));
  assert.equal(got.condition, 100);
  b.rpg.inventory.length = inventory.MAX_ITEMS; // full pack (sparse is fine for the check)
  b.rpg.inventory.fill(byTemplate(b, 'iron-mace') ?? b.rpg.inventory[0]);
  const mace = byTemplate(a, 'iron-mace');
  assert.throws(() => s.transferItem(a, b, mace.id), /cannot hold/);
  assert.ok(byTemplate(a, 'iron-mace'), 'rolled back on failure');
});

test('durability: wear, breakage unequips, broken gear cannot be equipped', () => {
  const w = world();
  const p = w.join(9);
  const s = w.rt.ctx.services;
  const sword = byTemplate(p, 'iron-longsword');
  assert.equal(s.damageItem(p, 'weapon', 10), false);
  assert.equal(sword.condition, 790);
  assert.equal(model.conditionLabel(sword), 'New');
  assert.equal(s.damageItem(p, sword.id, 5000), true);
  assert.equal(sword.condition, 0);
  assert.equal(p.rpg.equipment.rightHand, undefined);
  assert.equal(p.rpg.weaponView.template, 'unarmed');
  assert.ok(w.events(9, 'inventory').some((e) => /broken/.test(e.text)));
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: sword.id }).error, /broken/);
  assert.equal(model.primaryAction(sword), null);
  assert.equal(s.damageArmor(p, 1, 'head'), false);
  assert.equal(byTemplate(p, 'leather-helm').condition, describeTemplate('leather-helm').maxCondition - 1);
});

test('drop, inspect and loot piles with reach, partial takes and expiry', () => {
  const w = world();
  const p = w.join(10);
  const q = w.join(11);
  const mace = byTemplate(p, 'iron-mace');
  assert.equal(w.rt.act(p, 'inventory.drop', { itemId: mace.id }).ok, true);
  assert.equal(byTemplate(p, 'iron-mace'), undefined);
  assert.equal(w.rt.act(p, 'inventory.drop', { itemId: 'gold', quantity: 30 }).ok, true);
  assert.equal(p.rpg.gold, STARTER_GOLD - 30);
  const piles = [...w.rt.entities.values()].filter((e) => e.kind === 'loot');
  assert.equal(piles.length, 2);
  const [macePile, goldPile] = piles;
  // Visible to others in the location.
  const msg = w.rt.rpgMessage(q);
  assert.ok(msg.entities.some((e) => e.id === macePile.id));
  // Out of reach.
  q.x = 10;
  assert.match(w.rt.act(q, 'inventory.loot', { targetId: macePile.id }).error, /too far/);
  q.x = 1;
  assert.equal(w.rt.act(q, 'inventory.inspectLoot', { targetId: macePile.id }).ok, true);
  const look = w.events(11, 'loot').at(-1);
  assert.equal(look.items[0].template, 'iron-mace');
  assert.equal(w.rt.act(q, 'inventory.loot', { targetId: macePile.id }).ok, true);
  assert.ok(byTemplate(q, 'iron-mace').equipped === undefined);
  assert.equal(w.rt.entities.has(macePile.id), false, 'empty pile removed');
  assert.equal(w.rt.act(q, 'inventory.loot', { targetId: goldPile.id, itemId: 'gold' }).ok, true);
  assert.equal(q.rpg.gold, STARTER_GOLD + 30);
  // Equipped items cannot be dropped.
  assert.match(w.rt.act(p, 'inventory.drop', { itemId: p.rpg.equipment.rightHand }).error, /Unequip/);
  // Partial take keeps the pile and refreshes the loot view; expiry cleans up.
  const id = w.rt.ctx.services.spawnLoot(w.rt.locationOf(p), 0, 0, [{ template: 'arrow', quantity: 4 }, { template: 'ruby' }]);
  const contents = w.rt.ctx.services.lootContents(id);
  assert.equal(w.rt.act(p, 'inventory.loot', { targetId: id, itemId: contents[1].id }).ok, true);
  assert.equal(w.rt.entities.get(id).count, 1);
  assert.equal(w.events(10, 'loot').at(-1).items.length, 1);
  w.advance(inventory.LOOT_LIFETIME_MS + 1);
  assert.equal(w.rt.entities.has(id), false);
});

test('encumbrance blocks oversized loot', () => {
  const w = world();
  const p = w.join(12, { character: { attributes: { Strength: 20 } } });
  assert.equal(inventory.maxEncumbrance(p.rpg), 30);
  const id = w.rt.ctx.services.spawnLoot(w.rt.locationOf(p), 0, 0, [{ template: 'daedric-cuirass' }, { template: 'iron-claymore' }]);
  assert.match(w.rt.act(p, 'inventory.loot', { targetId: id }).error, /cannot carry/);
  assert.equal(w.rt.entities.get(id).count, 2);
});

test('swimming weight permits exactly 62.5 kg and sinks with one extra gold piece', () => {
  const w = world();
  const gear = Array.from({ length: 5 }, () => inventory.makeItem('iron-cuirass'));
  const p = w.join(19, { inventory: gear, inventoryVersion: inventory.INVENTORY_VERSION, gold: 0, character: { attributes: { Strength: 80 } } });
  const s = w.rt.ctx.services;
  assert.deepEqual(s.encumbrance(p), { carried: 62.5, max: 120, over: false, sinks: false });
  s.addGold(p, 1);
  assert.deepEqual(s.encumbrance(p), { carried: 62.5, max: 120, over: false, sinks: true });
});

test('the pack, loot and carry checks agree at the enchanted weight limit', () => {
  const w = world();
  const p = w.join(17, { character: { attributes: { Strength: 47 }, effectiveAttributes: { Strength: 49 } } });
  const s = w.rt.ctx.services;
  const helm = s.giveItem(p, 'iron-helm', 1, { extra: { magic: { enchantments: [{ type: 7, param: 0 }] } } });
  const boots = s.giveItem(p, 'iron-boots', 1, { extra: { magic: { enchantments: [{ type: 7, param: 1 }] } } });
  const capacity = (expected) => {
    assert.equal(model.maxEncumbrance(p.rpg), expected);
    assert.equal(s.maxEncumbrance(p), expected);
    assert.equal(s.encumbrance(p).max, expected);
  };
  capacity(73);
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: helm.id }).ok, true);
  capacity(91);
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: boots.id }).ok, true);
  capacity(109);
  p.rpg.gold = 0;
  p.rpg.gold = Math.round((108 - s.carriedWeight(p)) * inventory.GOLD_PER_KG);
  const loot = (quantity) => s.spawnLoot(w.rt.locationOf(p), 0, 0, [{ template: 'gold', quantity }]);
  assert.equal(s.canCarry(p, 1), true);
  assert.equal(w.rt.act(p, 'inventory.loot', { targetId: loot(400) }).ok, true);
  assert.equal(s.carriedWeight(p), 109);
  assert.equal(s.canCarry(p, 1), false);
  assert.match(w.rt.act(p, 'inventory.loot', { targetId: loot(400) }).error, /cannot carry/);
  s.damageItem(p, boots.id, boots.maxCondition);
  capacity(91);
  assert.equal(w.rt.act(p, 'inventory.unequip', { itemId: helm.id }).ok, true);
  capacity(73);
});

test('monster kills leave loot unless combat opts out', () => {
  const w = world();
  const p = w.join(13);
  const loc = w.rt.locationOf(p);
  w.rt.ctx.emit('kill', { player: p, entity: { id: 'm1', kind: 'monster', name: 'Rat', location: loc, x: 1, z: 1, maxHp: 10 } });
  const piles = [...w.rt.entities.values()].filter((e) => e.kind === 'loot');
  assert.equal(piles.length, 1);
  assert.ok(w.rt.ctx.services.lootContents(piles[0].id).some((r) => r.template === 'gold' && r.quantity >= 1));
  w.rt.ctx.emit('kill', { player: p, entity: { id: 'm2', kind: 'monster', location: loc, x: 1, z: 1 }, noLoot: true });
  assert.equal([...w.rt.entities.values()].filter((e) => e.kind === 'loot').length, 1);
});

test('peers expose readied weapon template; successful actions save', () => {
  const w = world();
  const p = w.join(14);
  const q = w.join(15);
  const peer = w.rt.rpgMessage(q).peers.find((x) => x.id === 14);
  assert.equal(peer.weapon.template, 'iron-longsword');
  w.saved.length = 0;
  w.rt.act(p, 'inventory.unequip', { slot: 'rightHand' });
  assert.deepEqual(w.saved, [[14]]);
});

test('client model: tabs, filter, weight and actions', () => {
  const w = world();
  const p = w.join(16);
  const weapons = model.itemsForTab(p.rpg.inventory, 'weapons');
  assert.ok(weapons[0].equipped, 'equipped items sort first');
  assert.ok(weapons.some((i) => i.template === 'arrow'));
  assert.equal(model.itemsForTab(p.rpg.inventory, 'magic').length, 2);
  assert.deepEqual(model.itemsForTab(p.rpg.inventory, 'weapons', 'BOW').map((i) => i.template), ['iron-short-bow']);
  assert.equal(model.carriedWeight(p.rpg), inventory.carriedWeight(p.rpg));
  assert.equal(model.primaryAction(byTemplate(p, 'iron-longsword')).verb, 'inventory.unequip');
  assert.equal(model.primaryAction(byTemplate(p, 'iron-mace')).verb, 'inventory.equip');
  assert.equal(model.primaryAction(byTemplate(p, 'potion-of-healing')).label, 'Drink');
  assert.equal(model.primaryAction(byTemplate(p, 'arrow')), null);
  const rows = Object.fromEntries(model.describe(byTemplate(p, 'iron-longsword')));
  assert.equal(rows.Damage, '2–16 −1');
  assert.equal(rows.Skill, 'Long Blade');
  assert.equal(rows.Equipped, 'Right hand');
});

test('jewellery follows ItemEquipTable.GetFirstSlot: the open slot of its pair, else slot 0; saves keep it worn', () => {
  const rpg = inventory.normalizeRpg({ inventory: [], equipment: {}, gold: 0 });
  const rings = [1, 2, 3].map(() => inventory.addItem(rpg, 'ring'));
  inventory.equip(rpg, rings[0].id);
  inventory.equip(rpg, rings[1].id);
  assert.deepEqual([rings[0].equipped, rings[1].equipped], ['ring0', 'ring1']);
  inventory.equip(rpg, rings[2].id);
  assert.deepEqual([rings[0].equipped, rings[1].equipped, rings[2].equipped], [undefined, 'ring1', 'ring0'], 'both full: slot 0 is replaced');
  const torc = inventory.addItem(rpg, 'torc');
  inventory.equip(rpg, torc.id);
  assert.equal(torc.equipped, 'amulet0', 'torcs and cloth amulets share the amulet pair');
  const wand = inventory.addItem(rpg, 'wand');
  assert.throws(() => inventory.equip(rpg, wand.id), /cannot be equipped/, 'wands have no equip slot (GetJewellerySlot default)');
  assert.throws(() => inventory.equip(rpg, torc.id, 'ring1'), /does not fit/);
  // A saved character (JSON round trip) keeps its jewellery worn; an older save without these slots loads unchanged.
  const saved = inventory.normalizeRpg(JSON.parse(JSON.stringify(rpg)));
  assert.deepEqual([saved.equipment.ring0, saved.equipment.ring1, saved.equipment.amulet0], [rings[2].id, rings[1].id, torc.id]);
  const old = inventory.normalizeRpg({ inventory: [{ ...rings[0], equipped: undefined }], equipment: { rightHand: 'missing' }, gold: 5 });
  assert.deepEqual(old.equipment, {});
  assert.equal(old.inventory[0].template, 'ring');
});
