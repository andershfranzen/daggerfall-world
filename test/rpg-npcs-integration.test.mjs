// NPC commerce against the real runtime transaction and the real equipment feature.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as npcs from '../server/rpg/npcs.js';
import { itemArt } from '../client/gameplay/inventory/images.js';

function world() {
  const players = new Map();
  const sent = [];
  let clock = 0;
  let failSave = false;
  const rt = createRpgRuntime({
    players,
    features: [inventory, npcs],
    save: () => { if (failSave) throw new Error('disk full'); },
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const join = (id) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
    players.set(id, p);
    rt.join(p);
    p.rpg.character = { skills: { Mercantile: 10 }, health: 10, maxHealth: 20 };
    p.rpg.gold = 300;
    return p;
  };
  const dialogue = (id) => sent.filter(([i, m]) => i === id && m.type === 'gameEvent' && m.event.kind === 'dialogue').map(([, m]) => m.event).at(-1);
  const npc = (role) => [...rt.entities.values()].find((e) => e.kind === 'npc' && e.role === role);
  const talkTo = (p, e) => {
    p.x = e.x; p.z = e.z + 1;
    assert.deepEqual(rt.act(p, 'npc.talk', { targetId: e.id }), { ok: true });
    return dialogue(p.id);
  };
  return { rt, join, dialogue, npc, talkTo, sent, setFailSave: (v) => { failSave = v; }, advance: (ms) => { clock += ms; rt.tick(ms / 1000, clock); } };
}

const wealth = (p) => p.rpg.gold;
const count = (p, t) => p.rpg.inventory.filter((i) => i.template === t).reduce((n, i) => n + i.quantity, 0);

test('stock uses real catalogue items and every trade conserves gold and goods', () => {
  const w = world();
  const p = w.join(1);
  const smith = w.npc('merchant');
  const v = w.talkTo(p, smith);
  assert.equal(v.kind, 'dialogue');
  w.rt.act(p, 'npc.topic', { targetId: smith.id, session: v.session, topic: 'trade' });
  let shop = w.dialogue(p.id).shop;
  for (const it of shop.items) assert.doesNotThrow(() => inventory.describeTemplate(it.key), it.key);
  const potion = shop.items.find((i) => i.key === 'potion-of-healing');
  assert.ok(potion.price >= inventory.describeTemplate('potion-of-healing').value);

  const startGold = wealth(p) + shop.purse;
  const startPotions = count(p, 'potion-of-healing') + potion.quantity;
  // Many small round trips: totals never drift, and the player never profits.
  for (let i = 0; i < 3; i++) {
    shop = w.dialogue(p.id).shop;
    const unit = shop.items.find((x) => x.key === 'potion-of-healing').price;
    assert.deepEqual(w.rt.act(p, 'npc.buy', { targetId: smith.id, session: v.session, key: 'potion-of-healing', quantity: 1, price: unit }), { ok: true });
    shop = w.dialogue(p.id).shop;
    const offer = shop.sellable.find((s) => p.rpg.inventory.find((it) => it.id === s.itemId)?.template === 'potion-of-healing');
    assert.ok(offer.price < unit);
    assert.deepEqual(w.rt.act(p, 'npc.sell', { targetId: smith.id, session: v.session, itemId: offer.itemId, quantity: 1, price: offer.price }), { ok: true });
    shop = w.dialogue(p.id).shop;
    assert.equal(wealth(p) + shop.purse, startGold, 'gold conserved');
    assert.equal(count(p, 'potion-of-healing') + shop.items.find((x) => x.key === 'potion-of-healing').quantity, startPotions, 'goods conserved');
  }
  assert.ok(wealth(p) < 300, 'round trips cost the player');
});

test('a failed save rolls back merchant purse and stock together with the player', () => {
  const w = world();
  const p = w.join(1);
  const m = w.npc('merchant');
  const v = w.talkTo(p, m);
  w.rt.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const before = w.dialogue(p.id).shop;
  const item = before.items.find((i) => i.key === 'arrow');
  const gold0 = p.rpg.gold;
  const arrows0 = count(p, 'arrow');
  w.setFailSave(true);
  const r = w.rt.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'arrow', quantity: 5, price: item.price });
  assert.equal(r.ok, false);
  w.setFailSave(false);
  assert.equal(p.rpg.gold, gold0);
  assert.equal(count(p, 'arrow'), arrows0);
  w.rt.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const after = w.dialogue(p.id).shop;
  assert.equal(after.purse, before.purse);
  assert.equal(after.items.find((i) => i.key === 'arrow').quantity, item.quantity);
});

test('merchant keeps a sold armour variant distinct in stock and gives it back intact', () => {
  const w = world();
  const p = w.join(1);
  p.rpg.gold = 1000;
  const item = w.rt.ctx.services.giveItem(p, 'steel-helm', 1, { variant: 0 });
  const merchant = w.npc('merchant');
  const v = w.talkTo(p, merchant);
  const session = { targetId: merchant.id, session: v.session };
  assert.equal(w.rt.act(p, 'npc.topic', { ...session, topic: 'trade' }).ok, true);
  const row = w.dialogue(p.id).shop.sellable.find((r) => r.itemId === item.id);
  const original = itemArt(item, { gender: 'Female', race: 'Redguard' });
  assert.equal(original.record, 27);
  assert.deepEqual(itemArt(row, { gender: 'Female', race: 'Redguard' }), original);
  assert.equal(w.rt.act(p, 'npc.sell', { ...session, itemId: item.id, price: row.price }).ok, true);
  const stock = w.dialogue(p.id).shop.items.find((r) => r.key === 'steel-helm:0');
  assert.deepEqual(itemArt(stock, { gender: 'Female', race: 'Redguard' }), original);
  assert.equal(w.rt.act(p, 'npc.buy', { ...session, key: stock.key, price: stock.price }).ok, true);
  assert.equal(p.rpg.inventory.find((i) => i.template === 'steel-helm').variant, 0);
});

test('equipped starter gear cannot be sold; rejected actions report readable errors', () => {
  const w = world();
  const p = w.join(1);
  const m = w.npc('merchant');
  const v = w.talkTo(p, m);
  w.rt.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const equipped = p.rpg.inventory.find((i) => i.equipped);
  if (equipped) {
    assert.ok(!w.dialogue(p.id).shop.sellable.some((s) => s.itemId === equipped.id));
    const r = w.rt.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: equipped.id, quantity: 1, price: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /Unequip/);
  }
  p.z += 30;
  const far = w.rt.act(p, 'npc.talk', { targetId: m.id });
  assert.equal(far.ok, false);
  assert.match(far.error, /too far/);
});
