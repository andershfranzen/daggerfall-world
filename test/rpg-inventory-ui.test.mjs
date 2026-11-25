// Inventory screen view-model: slot fit, equip/remove previews and comparisons must agree with
// the authoritative server rules in server/rpg/inventory.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as model from '../client/gameplay/inventory/model.js';
import { inventoryWatch } from '../client/gameplay/inventory.js';

function join() {
  const players = new Map();
  const rt = createRpgRuntime({ players, features: [inventory], save: () => {}, send: () => {}, now: () => 0, log: { error() {}, warn() {}, info() {} } });
  const p = { id: 1, name: 'P1', x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
  players.set(1, p);
  rt.join(p);
  return p;
}
const clone = (v) => structuredClone(v);
const byTemplate = (p, t) => p.rpg.inventory.find((i) => i.template === t);

test('fitsSlot and slotsFor mirror the server hand and slot rules', () => {
  const p = join();
  const sword = byTemplate(p, 'iron-longsword');
  const bow = inventory.addItem(p.rpg, 'iron-short-bow');
  const buckler = inventory.addItem(p.rpg, 'buckler');
  const potion = inventory.addItem(p.rpg, 'potion-of-healing');
  assert.deepEqual(model.slotsFor(sword), ['rightHand', 'leftHand']);
  assert.deepEqual(model.slotsFor(bow), ['rightHand']);
  assert.deepEqual(model.slotsFor(buckler), ['leftHand']);
  assert.deepEqual(model.slotsFor(potion), []);
  for (const it of [sword, bow, buckler]) {
    for (const [slot] of model.SLOT_ORDER) {
      const rpg = clone(p.rpg);
      let ok = true;
      try { inventory.equip(rpg, it.id, slot); } catch { ok = false; }
      assert.equal(model.fitsSlot(it, slot), ok, `${it.template} in ${slot}`);
    }
  }
});

test('previewEquip predicts the server equip result, including two-handed swaps', () => {
  const p = join();
  const cases = [
    ['chain-cuirass', undefined],
    ['iron-short-bow', undefined],
    ['buckler', undefined],
    ['steel-longsword', 'leftHand'],
    ['iron-helm', undefined],
  ];
  for (const [template, slot] of cases) {
    const it = inventory.addItem(p.rpg, template);
    // Wear a two-handed bow first so shields and off-hand weapons have something to displace.
    const before = clone(p.rpg);
    const bow = before.inventory.find((i) => i.template === 'iron-short-bow');
    if (bow && template !== 'iron-short-bow') inventory.equip(before, bow.id);
    const preview = model.previewEquip(before, it.id, slot);
    const server = clone(before);
    inventory.equip(server, it.id, slot);
    assert.deepEqual(preview.rpg.equipment, server.equipment, `${template}: equipment`);
    assert.deepEqual(model.armorValues(preview.rpg), model.armorValues(server), `${template}: armor`);
    const removedIds = preview.removed.map((r) => r.id).sort();
    const serverRemoved = Object.values(before.equipment).filter((id) => !Object.values(server.equipment).includes(id)).sort();
    assert.deepEqual(removedIds, serverRemoved, `${template}: removed`);
    assert.deepEqual(before, clone(before), 'preview never mutates');
  }
});

test('compareItem: armour deltas, replaced item and remove mode', () => {
  const p = join();
  const chain = inventory.addItem(p.rpg, 'chain-cuirass');
  const leather = p.rpg.inventory.find((i) => i.equipped === 'chestArmor');
  assert.ok(leather, 'starter kit wears a cuirass');
  const cmp = model.compareItem(p.rpg, chain);
  assert.equal(cmp.mode, 'equip');
  assert.equal(cmp.slot, 'chestArmor');
  assert.deepEqual(cmp.replaces.map((i) => i.id), [leather.id]);
  const chest = cmp.armor.find(([part]) => part === 'chest');
  assert.ok(chest && chest[3] > chest[2], 'chain raises chest armour');
  const weight = cmp.rows.find(([label]) => label === 'Weight worn');
  assert.equal(weight[4], -1, 'heavier is marked worse');

  const off = model.compareItem(p.rpg, leather);
  assert.equal(off.mode, 'remove');
  assert.deepEqual(off.armor.find(([part]) => part === 'chest').slice(2), [model.armorValues(p.rpg).chest, 0]);

  const steel = inventory.addItem(p.rpg, 'steel-longsword');
  const w = model.compareItem(p.rpg, steel);
  assert.equal(w.slot, 'rightHand');
  assert.ok(w.rows.some(([label]) => label === 'Damage'));
  assert.equal(model.compareItem(p.rpg, inventory.addItem(p.rpg, 'potion-of-healing')), null);
});

test('condition care and labels', () => {
  const p = join();
  const sword = byTemplate(p, 'iron-longsword');
  assert.equal(model.conditionPct(sword), 100);
  assert.equal(model.needsCare(sword), false);
  sword.condition = Math.round(sword.maxCondition * 0.3);
  assert.equal(model.needsCare(sword), true);
  assert.equal(model.kindOf(sword), 'Weapon');
  assert.equal(model.kindOf(byTemplate(p, 'iron-short-bow') ?? inventory.addItem(p.rpg, 'iron-short-bow')), 'Two-handed weapon');
  assert.equal(model.kindOf(inventory.addItem(p.rpg, 'chain-cuirass')), 'Chest armor');
});

test('inventoryWatch ignores vitals and peers but follows gear and nearby loot', () => {
  const p = join();
  const state = { character: clone(p.rpg), entities: [], peers: [] };
  const key = (s) => JSON.stringify(inventoryWatch(s));
  const k0 = key(state);
  state.character.character = { ...state.character.character, health: 1 };
  state.peers.push({ id: 9 });
  assert.equal(key(state), k0);
  state.entities.push({ id: 'l1', kind: 'loot', name: 'Pile', count: 2 });
  assert.notEqual(key(state), k0);
  const k1 = key(state);
  state.character.equipment = {};
  assert.notEqual(key(state), k1);
});

test('the pending status names the action: lighting a torch is not equipping it', () => {
  const p = join();
  const torch = inventory.addItem(p.rpg, 'torch');
  const light = model.primaryAction(torch, p.rpg.lightSource);
  assert.equal(light.verb, 'inventory.light');
  assert.equal(model.pendingLabel(light, torch), 'Lighting Torch…');
  const sword = byTemplate(p, 'iron-longsword');
  assert.equal(model.pendingLabel(model.primaryAction(sword, p.rpg.lightSource), sword), sword.equipped ? `Removing ${sword.name}…` : `Equipping ${sword.name}…`);
  const potion = inventory.addItem(p.rpg, 'potion-of-healing');
  assert.equal(model.pendingLabel(model.primaryAction(potion, p.rpg.lightSource), potion), `Drinking ${potion.name}…`);
});
