// Spellbook and multiplayer casting (server/rpg/magic.js) through the real RPG runtime transaction.
// Uses a synthetic SPELLS.STD; the optional last test reads the operator's local gamedata/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installMagic, publicSpell } from '../server/rpg/magic.js';
import { install as installInventory, describeTemplate } from '../server/rpg/inventory.js';
import { normaliseOffer } from '../server/rpg/social/trade.js';
import { CONJURED_EQUIPMENT } from '../server/rpg/magic/conjuration.js';
import { parseSpellsStd, SPELL_RECORD_SIZE } from '../server/rpg/magic/spells-std.js';
import { loadCatalogue, fallbackSpells } from '../server/rpg/magic/catalogue.js';
import { spellCosts, savingThrow, durationRounds, chanceValue } from '../server/rpg/magic/formulas.js';
import { EFFECTS } from '../server/rpg/magic/effects.js';
import { install as installCalendar } from '../server/rpg/calendar.js';
import { holidayInfo } from '../client/gameplay/atmosphere/holidays.js';

const L = 'town:Test/Square';

// ---------------------------------------------------------------- synthetic SPELLS.STD

function record({ index, name, element = 4, range = 0, cost = 0, icon = 1, effects }) {
  const b = new Uint8Array(SPELL_RECORD_SIZE);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < 3; i++) {
    const e = effects[i];
    dv.setInt8(i * 2, e ? e.type : -1);
    dv.setInt8(i * 2 + 1, e ? e.sub ?? -1 : -1);
    const d = e?.d ?? [1, 1, 1];
    const c = e?.c ?? [1, 1, 1];
    const m = e?.m ?? [1, 1, 1, 1, 1];
    b.set(d, 14 + i * 3);
    b.set(c, 23 + i * 3);
    b.set(m, 32 + i * 5);
  }
  b[6] = element;
  b[7] = range;
  dv.setUint16(8, cost, true);
  for (let i = 0; i < name.length; i++) b[47 + i] = name.charCodeAt(i);
  b[72] = icon;
  b[73] = index;
  return b;
}

const fixed = (n) => [n, n, 0, 0, 1]; // magnitude exactly n at any level
const SPELLS = [
  record({ index: 8, name: 'Bolt', element: 3, range: 2, cost: 225, effects: [{ type: 4, sub: 0, m: fixed(10) }] }),
  record({ index: 64, name: 'Mend', range: 0, effects: [{ type: 10, sub: 8, m: fixed(7) }] }),
  record({ index: 51, name: 'Rot', element: 2, range: 1, effects: [{ type: 1, sub: 0, d: [3, 0, 1], m: fixed(2) }, { type: 4, sub: 0, m: fixed(4) }] }),
  record({ index: 14, name: 'Fireball', element: 0, range: 4, effects: [{ type: 4, sub: 0, m: fixed(5) }] }),
  record({ index: 25, name: 'Burst', element: 0, range: 3, effects: [{ type: 4, sub: 0, m: fixed(5) }] }),
  record({ index: 17, name: 'Ward', range: 0, effects: [{ type: 35, sub: -1, d: [2, 0, 1], m: fixed(20) }, { type: 9, sub: 0, d: [2, 0, 1], m: fixed(5) }] }),
  record({ index: 94, name: 'Recall', range: 0, effects: [{ type: 43, sub: -1 }] }),
  record({ index: 33, name: 'Mixed', range: 2, effects: [{ type: 4, sub: 0, m: fixed(3) }, { type: 99 }] }),
  record({ index: 92, name: '!Lycanthropy', range: 0, icon: 10, effects: [{ type: 29, sub: -1 }] }),
  record({ index: 93, name: 'Broken', effects: [{ type: 99 }] }),
  record({ index: 18, name: 'Open', effects: [{ type: 17, c: [100, 0, 1] }] }),
  record({ index: 19, name: 'Lock', effects: [{ type: 16, c: [100, 0, 1] }] }),
  record({ index: 62, name: 'Soul Trap', range: 1, effects: [{ type: 12, d: [4, 0, 1], c: [100, 0, 1] }] }),
  record({ index: 9, name: 'Drain Strength', range: 1, effects: [{ type: 7, sub: 0, m: fixed(9) }] }),
  record({ index: 101, name: 'Restore Strength', effects: [{ type: 10, sub: 0, m: fixed(5) }] }),
  record({ index: 102, name: 'Transfer Strength', range: 1, effects: [{ type: 11, sub: 0, m: fixed(6) }] }),
  record({ index: 61, name: 'Cure Disease', effects: [{ type: 3, sub: 0, c: [100, 0, 1] }] }),
  record({ index: 99, name: 'Tame', range: 1, effects: [{ type: 33, sub: 0, c: [100, 0, 1] }] }),
  record({ index: 71, name: '!Nux Vomica', range: 1, effects: [{ type: 1, sub: 0 }] }),
  record({ index: 40, name: 'Lay Hands', range: 1, effects: [{ type: 10, sub: 8, m: fixed(6) }] }),
  record({ index: 50, name: 'Freeze', range: 1, effects: [{ type: 0, sub: -1, d: [3, 0, 1], c: [100, 0, 1] }] }),
  record({ index: 23, name: 'Hush', range: 1, effects: [{ type: 19, sub: -1, d: [2, 0, 1], c: [100, 0, 1] }] }),
  record({ index: 30, name: 'Spark', range: 2, element: 3, effects: [{ type: 4, sub: 0, m: fixed(100) }] }),
  record({ index: 57, name: 'Banish', range: 1, effects: [{ type: 6, sub: 2, c: [100, 0, 1] }] }),
  record({ index: 59, name: 'Null Magicka', range: 1, effects: [{ type: 6, sub: 0, c: [10, 0, 1] }] }),
  record({ index: 95, name: 'Conjure', effects: [{ type: 2, d: [2, 0, 1] }] }),
  record({ index: 111, name: 'Veil', effects: [{ type: 13, sub: 0, d: [3, 0, 1] }] }),
  record({ index: 112, name: 'Lasting Veil', effects: [{ type: 13, sub: 1, d: [2, 0, 1] }] }),
];
const STD = (() => {
  const out = new Uint8Array(SPELLS.length * SPELL_RECORD_SIZE);
  SPELLS.forEach((r, i) => out.set(r, i * SPELL_RECORD_SIZE));
  return out;
})();

// ---------------------------------------------------------------- harness

function character(extra = {}) {
  return {
    className: 'Mage', level: 1, health: 30, maxHealth: 50, fatigue: 40, maxFatigue: 80, magicka: 1000, maxMagicka: 1000,
    skills: { Destruction: 50, Restoration: 50, Alteration: 50, Mysticism: 50, Illusion: 50, Thaumaturgy: 50 },
    attributes: { Willpower: 50, Strength: 50 },
    ...extra,
  };
}

function world({ rng = () => 0.999, failSave = () => false, magicOpts = {}, services = {}, inventory = false } = {}) {
  const players = new Map();
  const sent = [];
  const saves = [];
  const calls = { damage: [], skill: [], kill: [] };
  let clock = 1000;
  const stub = (ctx) => {
    ctx.services.advanceSkill = (p, name, n) => calls.skill.push([p.id, name, n]);
    // Shaped like server/rpg/combat.js: only its own monsters (`_m`) can be harmed.
    ctx.services.monstersIn = (loc) => [...ctx.entities.values()].filter((e) => e.kind === 'monster' && e._m && !e.dead && e.location === loc);
    ctx.services.damageEntity = (p, e, n) => {
      if (!e?._m || e.dead) throw new Error('That cannot be harmed.');
      calls.damage.push([p?.id ?? null, e.id, n]);
      const floor = n >= e.hp && ctx.services.onMonsterLethalHit?.(p, e) === false ? 1 : 0;
      const damage = Math.min(e.hp - floor, n);
      e.hp -= damage;
      if (e.hp === 0) { e.dead = true; ctx.emit('kill', { player: p, entity: e }); }
      return { damage, hp: e.hp, killed: e.hp === 0 };
    };
    ctx.services.goldOf = (p) => p.rpg.gold;
    ctx.services.takeGold = (p, n) => {
      if (p.rpg.gold < n) throw new Error('You do not have enough gold.');
      p.rpg.gold -= n;
    };
    ctx.on('kill', (ev) => calls.kill.push(ev.entity.id));
    Object.assign(ctx.services, services);
  };
  let magic;
  const rt = createRpgRuntime({
    players,
    features: [
      { name: 'stub', install: stub },
      ...(inventory ? [{ name: 'inventory', install: installInventory }] : []),
      { name: 'magic', install: (ctx) => (magic = installMagic(ctx, { spellsStd: STD, rng, ...magicOpts })) },
    ],
    save: (list) => {
      if (failSave()) throw new Error('disk full');
      saves.push(list.map((p) => p.id));
    },
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => clock,
    log: { error() {}, warn() {}, log() {} },
  });
  const add = (id, name, x = 0, z = 0, yaw = 0, ch = character()) => {
    const p = { id, name, x, z, yaw, moving: false, rpg: { location: L, character: ch, gold: 5000 } };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const monster = (id, x, z, hp = 50, extra = {}) => {
    const e = { id, kind: 'monster', name: id, location: L, x, z, yaw: 0, hp, maxHp: hp, _m: { id: 1 }, ...extra };
    rt.entities.set(id, e);
    return e;
  };
  const events = (pid, kind) => sent.filter(([id, m]) => id === pid && m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map(([, m]) => m.event);
  const advance = (ms) => { clock += ms; };
  const clear = () => { sent.length = 0; saves.length = 0; calls.damage.length = 0; calls.skill.length = 0; calls.kill.length = 0; };
  return { rt, players, sent, saves, calls, add, monster, events, advance, clear, get magic() { return magic; } };
}

const ok = (r) => assert.deepEqual(r, { ok: true });
const fails = (r, re) => { assert.equal(r.ok, false); assert.match(r.error, re); };

// ---------------------------------------------------------------- data + formulas

test('SPELLS.STD records parse into spells with classic ids, targets, elements and support levels', () => {
  const cat = loadCatalogue({ spellsStd: STD });
  assert.equal(cat.source, 'SPELLS.STD');
  assert.equal(cat.spells.size, SPELLS.length);
  const bolt = cat.spells.get('std:8');
  assert.equal(bolt.name, 'Bolt');
  assert.equal(bolt.element, 'shock');
  assert.equal(bolt.targetType, 'singleAtRange');
  assert.equal(bolt.price, 225, 'list price comes from the record');
  assert.equal(bolt.support, 'full');
  assert.equal(cat.spells.get('std:17').support, 'tracked');
  assert.equal(cat.spells.get('std:33').support, 'partial');
  assert.equal(cat.spells.get('std:94').support, 'full');
  assert.equal(cat.spells.get('std:71').hidden, true);
  assert.equal(cat.spells.get('std:71').name, 'Nux Vomica');
  assert.deepEqual(cat.spells.get('std:51').effects.map((e) => e.template.key), ['ContinuousDamage-Health', 'Damage-Health']);
  assert.equal(cat.coverage.unsupported, 1);
  // Effect table covers every classic spell family with an explicit support level (0 unsupported).
  const supports = new Set([...EFFECTS.values()].map((e) => e.support));
  assert.deepEqual([...supports].sort(), ['applied', 'tracked']);
  assert.equal(cat.spells.get('std:92').support, 'full');
  assert.equal(cat.spells.get('std:92').hidden, true);
  assert.equal(cat.spells.get('std:92').name, 'Lycanthropy');
});

test('costs follow the DFU spellmaker formula: skill discount, target multiplier and 5-point floor', () => {
  const bolt = loadCatalogue({ spellsStd: STD }).spells.get('std:8');
  // Damage-Health magnitude costs (20, 28): gold = 20*10 + 28*0 = 200; singleAtRange x1.5.
  assert.deepEqual(spellCosts(bolt, () => 0), { gold: 300, magicka: 82 });
  assert.deepEqual(spellCosts(bolt, () => 50), { gold: 300, magicka: 45 });
  assert.equal(spellCosts(bolt, () => 100).magicka, 7);
  const cheap = fallbackSpells().find((s) => s.id === 'ward:second-wind');
  assert.ok(spellCosts(cheap, () => 100).magicka >= 5, 'cast cost floor');
  assert.equal(durationRounds({ durationBase: 2, durationPlus: 1, durationPerLevel: 3 }, 7), 4);
  assert.equal(chanceValue({ chanceBase: 20, chancePlus: 5, chancePerLevel: 2 }, 5), 30);
});

test('saving throws: low roll saves fully, near miss prorates, immunity always saves', () => {
  const target = { willpower: 50 };
  assert.equal(savingThrow({ element: 'fire', target, rng: () => 0 }), 0); // roll 1 vs 55
  assert.equal(savingThrow({ element: 'fire', target, rng: () => 0.5 }), 80); // roll 51 within 20 of 55: 100-5*(55-51)
  assert.equal(savingThrow({ element: 'fire', target, rng: () => 0.99 }), 100);
  assert.equal(savingThrow({ element: 'fire', target: { willpower: 50, tolerance: () => 'immune' }, rng: () => 0.99 }), 0);
  assert.equal(savingThrow({ element: 'fire', paralysis: true, target: {
    willpower: 50, immune: (kind) => kind === 'paralysis', tolerance: () => 'critical',
  }, rng: () => 0.99 }), 0, 'element weakness cannot remove paralysis immunity');
});

test('without SPELLS.STD the built-in original spells are used', () => {
  const cat = loadCatalogue({ arena2Dir: '/nonexistent' });
  assert.equal(cat.source, 'built-in');
  assert.ok(cat.spells.size >= 8);
  for (const s of cat.spells.values()) assert.notEqual(s.support, 'unsupported');
});

// ---------------------------------------------------------------- join, spellbook actions

test('joining grants class starting spells, selects one and sends the catalogue without hidden spells', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  assert.deepEqual(p.rpg.magic.known, ['std:8']);
  assert.equal(p.rpg.magic.selected, 'std:8');
  const [cat] = w.events(1, 'spellCatalogue');
  assert.equal(cat.source, 'SPELLS.STD');
  assert.ok(!cat.spells.some((s) => s.id === 'std:71'), 'hidden spells are not listed');
  assert.ok(cat.spells.find((s) => s.id === 'std:93').effects[0].reason);
  JSON.parse(JSON.stringify(p.rpg.magic));
  // A warrior has no starting spells but is still marked as granted.
  const q = w.add(2, 'Bo', 0, 0, 0, character({ className: 'Warrior' }));
  assert.deepEqual(q.rpg.magic.known, []);
  assert.equal(q.rpg.magic.granted, true);
});

test('a standard spell seller quotes and charges the festival price and refreshes a stale quote', () => {
  const seller = { npcId: 'guild-seller', quality: 14, session: 'fixture-session' };
  const festival = (holidayInfo('witches-festival').dayOfYear - 1) * 1440;
  let minutes = festival;
  const w = world({ services: {
    worldClock: () => ({ minutes }),
    requireNpcService(p, args, id) {
      if (p.id !== 1 || id !== 'spells' || args.targetId !== seller.npcId || args.session !== seller.session) {
        throw new Error('Talk to the spell seller first.');
      }
      return seller;
    },
  } });
  installCalendar(w.rt.ctx);
  const p = w.add(1, 'Buyer', 0, 0, 0, character({ className: 'Warrior' }));
  const peer = w.add(2, 'Observer', 0, 0, 0, character({ className: 'Warrior' }));
  const spellId = 'std:8';
  const quote = () => w.events(p.id, 'spellCatalogue').at(-1).spells.find(s => s.id === spellId).price;
  assert.equal(w.events(p.id, 'spellCatalogue')[0].requiresSeller, true);
  fails(w.rt.act(p, 'magic.learn', { spellId }), /spell seller/);
  w.rt.ctx.services.npcServiceHandlers.spells(p, seller);
  const counter = w.events(p.id, 'spellShop').at(-1).counter;
  assert.equal(quote(), 71, '45 casting points × 4, halved, then haggled at quality 14');
  fails(w.rt.act(peer, 'magic.learn', { ...counter, spellId }), /spell seller/);
  minutes += 1440;
  ok(w.rt.act(p, 'magic.learn', { ...counter, spellId, expectCost: 71 }));
  assert.equal(quote(), 142);
  assert.equal(p.rpg.gold, 5000);
  assert.ok(!p.rpg.magic.known.includes(spellId));
  minutes = festival;
  p.rpg.gold = 71;
  ok(w.rt.act(p, 'magic.learn', { ...counter, spellId, expectCost: 71 }));
  assert.equal(p.rpg.gold, 0);
  assert.ok(p.rpg.magic.known.includes(spellId));
  assert.ok(!peer.rpg.magic.known.includes(spellId));
});

test('learn spends gold once; select, forget and every rejection leave state unchanged', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  ok(w.rt.act(p, 'magic.learn', { spellId: 'std:64' }));
  assert.equal(p.rpg.gold, 5000 - loadCatalogue({ spellsStd: STD }).spells.get('std:64').price);
  assert.ok(p.rpg.magic.known.includes('std:64'));
  const gold = p.rpg.gold;
  fails(w.rt.act(p, 'magic.learn', { spellId: 'std:64' }), /already know/);
  fails(w.rt.act(p, 'magic.learn', { spellId: 'std:71' }), /No such spell/);
  fails(w.rt.act(p, 'magic.learn', { spellId: 'std:93' }), /cannot be cast in this world/);
  fails(w.rt.act(p, 'magic.learn', { spellId: 'nope' }), /No such spell/);
  p.rpg.gold = 1;
  fails(w.rt.act(p, 'magic.learn', { spellId: 'std:51' }), /costs \d+ gold/);
  assert.equal(p.rpg.gold, 1);
  assert.ok(!p.rpg.magic.known.includes('std:51'));
  p.rpg.gold = gold;
  ok(w.rt.act(p, 'magic.select', { spellId: 'std:64' }));
  assert.equal(p.rpg.magic.selected, 'std:64');
  fails(w.rt.act(p, 'magic.select', { spellId: 'std:25' }), /not in your spellbook/);
  ok(w.rt.act(p, 'magic.forget', { spellId: 'std:64' }));
  assert.equal(p.rpg.magic.selected, null);
  assert.ok(!p.rpg.magic.known.includes('std:64'));
});

// ---------------------------------------------------------------- casting

test('a missile spends magicka, damages the aimed monster once, advances the school and is seen once by every occupant', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  w.add(2, 'Bo', 5, 5);
  const rat = w.monster('rat', 0, -10);
  w.monster('behind', 0, 10);
  w.clear();
  ok(w.rt.act(p, 'magic.cast', {}));
  assert.equal(p.rpg.character.magicka, 1000 - 45);
  assert.equal(rat.hp, 50, 'launch spends magicka before applying damage');
  w.rt.tick(0.2);
  assert.equal(rat.hp, 50);
  w.rt.tick(0.2);
  assert.equal(rat.hp, 40);
  assert.deepEqual(w.calls.damage, [[1, 'rat', 10]]);
  assert.deepEqual(w.calls.skill, [[1, 'Destruction', 1]]);
  assert.deepEqual(w.saves, [[1], [1]], 'launch and impact each save atomically');
  for (const pid of [1, 2]) {
    const casts = w.events(pid, 'spellCast');
    assert.equal(casts.length, 1);
    assert.equal(casts[0].casterId, 1);
    assert.deepEqual(casts[0].targetIds, []);
    const [impact] = w.events(pid, 'spellImpact');
    assert.equal(impact.missileId, casts[0].missile.id);
    assert.deepEqual(impact.targetIds, ['rat']);
    assert.deepEqual(impact.hits, [{ targetId: 'rat', effect: 'Damage-Health', pool: 'health', amount: 10, killed: undefined, status: undefined }]);
  }
  assert.equal(w.events(1, 'spellResult').length, 1);
  assert.equal(w.events(2, 'spellResult').length, 0, 'results are private');
});

test('another player’s private quest foe is not there for a caster: not aimed at, not auto-targeted', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const owner = w.add(2, 'Bo', 0, -2);
  const foe = w.monster('quest:2:x:foe:a:0', 0, -10, 50, { visibleTo: [2] });
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: foe.id }), /not here/);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:8' })); // an aimed missile with nothing visible ahead: a miss
  w.rt.tick(8.1);
  assert.equal(foe.hp, 50);
  assert.equal(w.events(1, 'spellImpact')[0].missed, true);
  ok(w.rt.act(owner, 'magic.cast', { spellId: 'std:8', targetId: foe.id }));
  assert.equal(foe.hp, 50, 'launch has no damage');
  assert.deepEqual(w.events(1, 'spellCast').at(-1).targetIds, []);
  w.rt.tick(0.4);
  assert.equal(foe.hp, 40, 'its owner still can');
  assert.deepEqual(w.events(2, 'spellImpact').at(-1).targetIds, [foe.id]);
  assert.deepEqual(w.events(1, 'spellImpact').at(-1).targetIds, []);
  assert.deepEqual(w.events(1, 'spellImpact').at(-1).hits, []);
});

test('rejections spend nothing: magicka, cooldown, range, facing, target kind, silence, death, unknown and unsupported spells', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo', 0, -2);
  w.monster('far', 0, -240);
  w.monster('behind', 0, 10);
  const near = w.monster('near', 0, -10);
  for (const id of ['std:93', 'std:33', 'std:40', 'std:23', 'std:57']) p.rpg.magic.known.push(id);
  const before = () => JSON.stringify([p.rpg.character, near.hp]);
  const snapshot = before();
  w.clear();

  p.rpg.character.magicka = 44;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8' }), /need 45 magicka/);
  p.rpg.character.magicka = 1000;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'far' }), /out of range/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'behind' }), /not facing/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'player:2' }), /Harmful spells cannot be cast at other players/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'ghost' }), /not here/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:25' }), /not in your spellbook/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:93' }), /Broken cannot be cast in this world yet/);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:40', targetId: 'near' }), /would only help/);
  p.rpg.character.health = 0;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8' }), /dead/);
  p.rpg.character.health = 30;
  assert.equal(before(), snapshot);
  assert.equal(w.events(1, 'spellCast').length + w.events(2, 'spellCast').length, 0);
  assert.equal(w.calls.skill.length, 0);

  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'near' }));
  const mana = p.rpg.character.magicka;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'near' }), /still recovering/);
  assert.equal(p.rpg.character.magicka, mana);
  w.advance(1300);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'near' }));

  // Touch with nobody in reach is refused before spending.
  w.advance(1300);
  const m2 = p.rpg.character.magicka;
  q.x = 50;
  p.rpg.magic.known.push('std:51');
  near.z = -10;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:51' }), /nothing within reach/);
  assert.equal(p.rpg.character.magicka, m2);

  // Silence (tracked status) blocks the silenced player's own casting.
  p.rpg.magic.active.push({ uid: 99, key: 'Silence', status: 'silenced', roundsLeft: 2, totalRounds: 2 });
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8', targetId: 'near' }), /silenced/);
});

test('only monsters the combat feature manages can be targeted', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const prop = w.monster('scarecrow', 0, -5, 30, { _m: undefined });
  fails(w.rt.act(p, 'magic.cast', { targetId: 'scarecrow' }), /cannot cast spells at scarecrow/);
  ok(w.rt.act(p, 'magic.cast', {}));
  w.rt.tick(8.1);
  assert.equal(prop.hp, 30);
  assert.equal(w.events(1, 'spellImpact')[0].missed, true, 'projectiles ignore it');
});

test('equipment that forbids casting is honoured', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  w.monster('near', 0, -5);
  p.rpg.inventory = [{ id: 'i1', template: 'cursed-ring', name: 'Ring of Quiet', quantity: 1, noSpellcasting: true }];
  p.rpg.equipment = { ring: 'i1' };
  fails(w.rt.act(p, 'magic.cast', {}), /Ring of Quiet prevents spellcasting/);
});

test('a two-effect touch spell applies both effects once, then damage-over-time ticks once per magic round and expires', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -2, 50);
  p.rpg.magic.known.push('std:51');
  w.clear();
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:51', targetId: 'rat' }));
  // First DoT round (2) lands on cast, plus the direct damage (4).
  assert.equal(rat.hp, 44);
  assert.deepEqual(w.calls.damage.map((c) => c[2]), [2, 4]);
  assert.deepEqual(w.calls.skill, [[1, 'Destruction', 1], [1, 'Destruction', 1]]);
  assert.equal(w.magic.entityEffects.get('rat').length, 1);
  w.clear();
  w.rt.tick(4.9);
  assert.equal(rat.hp, 44, 'nothing before a full round');
  w.rt.tick(0.1);
  assert.equal(rat.hp, 42);
  assert.equal(w.events(1, 'magicEffect').length, 1);
  w.rt.tick(5);
  assert.equal(rat.hp, 40);
  assert.equal(w.events(1, 'magicExpired').length, 1);
  assert.equal(w.magic.entityEffects.has('rat'), false);
  w.rt.tick(5);
  assert.equal(rat.hp, 40, 'expired effects never apply again');
  assert.equal(w.calls.damage.length, 2);
});

test('healing: self heal clamps to max, touch heal can help another player, area spells pick monsters within the radius', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo', 0, -2, 0, character({ health: 10 }));
  p.rpg.magic.known.push('std:64', 'std:40', 'std:25');
  p.rpg.character.health = 47;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:64' }));
  assert.equal(p.rpg.character.health, 50);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:40', targetId: 'player:2' }));
  assert.equal(q.rpg.character.health, 16);
  assert.deepEqual(w.saves.at(-1).sort(), [1, 2], 'healed player saved in the same transaction');

  const a = w.monster('a', 2, 0, 20);
  const b = w.monster('b', -3, 1, 20);
  const c = w.monster('c', 6, 0, 20);
  w.advance(2000);
  w.clear();
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:25' }));
  assert.deepEqual([a.hp, b.hp, c.hp], [15, 15, 20]);
  assert.equal(q.rpg.character.health, 16, 'area damage never touches players');
  assert.equal(w.events(1, 'spellCast')[0].area, true);
});

test('shield and fortify are timed, exposed to other features and absorb damage', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  p.rpg.magic.known.push('std:17');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:17' }));
  const svc = w.rt.ctx.services;
  assert.deepEqual(svc.magicModifiers(p), { attributes: { Strength: 5 }, shield: 20 });
  assert.equal(svc.magicStatus(p).shielded, 2);
  assert.equal(svc.absorbDamage(p, 15), 0);
  assert.equal(svc.absorbDamage(p, 15), 10);
  assert.equal(svc.magicModifiers(p).shield, 0);
  w.rt.tick(5);
  w.rt.tick(5);
  assert.deepEqual(svc.magicModifiers(p), { attributes: {}, shield: 0 });
  assert.deepEqual(p.rpg.magic.active, []);
});

test('chance effects: paralysis and silence become tracked statuses on monsters; banish only works on its group', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -2, 30);
  const imp = w.monster('imp', 1, -2, 30, { affinity: 'daedra' });
  p.rpg.magic.known.push('std:50', 'std:23', 'std:57');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:50', targetId: 'rat' }));
  assert.equal(w.rt.ctx.services.magicStatus(rat).paralyzed, 3);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:23', targetId: 'rat' }));
  assert.equal(w.rt.ctx.services.magicStatus(rat).silenced, 2);
  w.advance(2000);
  w.clear();
  p.rpg.character.magicka = p.rpg.character.maxMagicka = 10000; // a certain banish is expensive
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:57', targetId: 'rat' }));
  assert.equal(rat.hp, 30);
  assert.match(w.events(1, 'spellResult')[0].text, /not daedric/);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:57', targetId: 'imp' }));
  assert.equal(imp.hp, 30);
  assert.equal(w.rt.entities.has(imp.id), false);
  assert.deepEqual(w.calls.kill, []);
  assert.deepEqual(w.calls.damage, []);
  assert.equal(w.events(1, 'spellCast').at(-1).hits[0].banished, true);
  assert.equal(w.events(1, 'spellCast').at(-1).hits[0].killed, undefined);
});

test('banishment leaves quest defeat and Soul Trap alone, and rolls back if the cast cannot be saved', () => {
  let failSave = false;
  const w = world({ failSave: () => failSave });
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo');
  const objective = w.monster('required', 0, -2, 30, { monsterId: 25, visibleTo: [1], _quest: { owner: 1, foe: 'Required' } });
  const ordinary = w.monster('ordinary', 0, -2, 30, { monsterId: 25, visibleTo: [1] });
  p.rpg.character.magicka = 10000;
  p.rpg.magic.known.push('std:57');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:57', targetId: objective.id }));
  assert.equal(objective.hp, 30);
  assert.equal(w.rt.entities.get(objective.id), objective);
  assert.ok(!w.events(q.id, 'spellCast').at(-1).targetIds.includes(objective.id));
  w.advance(2000);
  w.magic.entityEffects.set(ordinary.id, [{ key: 'SoulTrap', status: 'soulTrapped', roundsLeft: 5 }]);
  failSave = true;
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:57', targetId: ordinary.id }), /save|disk/i);
  assert.equal(w.rt.entities.get(ordinary.id), ordinary);
  assert.equal(w.rt.ctx.services.magicStatus(ordinary).soulTrapped, 5);
  failSave = false;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:57', targetId: ordinary.id }));
  assert.ok(!w.rt.entities.has(ordinary.id));
  assert.ok(!w.magic.entityEffects.has(ordinary.id));
  assert.deepEqual(w.calls.kill, []);
  assert.deepEqual(w.calls.damage, []);
  assert.deepEqual(w.events(q.id, 'spellCast').at(-1).hits, []);
});

test('Create Item charges once, blocks transfers, survives reconnect and expires from the equipment slot', () => {
  let minute = 100;
  const w = world({ inventory: true, services: { playerMinutes: () => minute } });
  let p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo');
  const s = w.rt.ctx.services;
  p.rpg.magic.known.push('std:95');
  const mana = p.rpg.character.magicka;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:95' }));
  const picker = w.events(p.id, 'spellEffectChoice').at(-1);
  const paid = p.rpg.character.magicka;
  assert.ok(paid < mana);
  assert.equal(picker.options.length, 29);
  for (const template of CONJURED_EQUIPMENT.keys()) assert.ok(describeTemplate(template));
  assert.deepEqual(w.events(q.id, 'spellEffectChoice'), []);
  const index = picker.options.find((x) => x.name === 'Steel Dagger').index;
  fails(w.rt.act(q, 'magic.choose', { token: picker.token, index }), /expired/);
  fails(w.rt.act(p, 'magic.choose', { token: picker.token, cancel: true }), /Choose an item/);
  ok(w.rt.act(p, 'magic.choose', { token: picker.token, index }));
  fails(w.rt.act(p, 'magic.choose', { token: picker.token, index }), /expired/);
  assert.equal(p.rpg.character.magicka, paid);
  const item = p.rpg.inventory.find((it) => it.conjuredUntil);
  assert.equal(item.conjuredUntil, 102);
  fails(w.rt.act(p, 'inventory.drop', { itemId: item.id }), /cannot leave/);
  assert.throws(() => normaliseOffer(p.rpg, { items: [{ id: item.id }] }), /cannot be traded/);
  assert.throws(() => s.transferItem(p, q, item.id), /cannot leave/);
  ok(w.rt.act(p, 'inventory.equip', { itemId: item.id }));
  w.rt.leave(p);
  p = { ...p, rpg: structuredClone(p.rpg) };
  w.players.set(p.id, p);
  minute = 102;
  w.rt.join(p);
  assert.equal(s.getEquippedWeapon(p).id, item.id);
  minute = 103;
  w.rt.ctx.emit('timeSpent', { player: p });
  assert.ok(!p.rpg.inventory.some((it) => it.id === item.id));
  assert.equal(s.getEquippedWeapon(p).template, 'unarmed');
  const ordinary = s.giveItem(p, 'arrow', 2);
  const ordinaryQuantity = ordinary.quantity;
  const later = s.giveItem(p, 'arrow', 4, { extra: { conjuredUntil: 110 } });
  const sooner = s.giveItem(p, 'arrow', 1, { extra: { conjuredUntil: 105 } });
  assert.equal(s.findArrow(p).id, sooner.id);
  s.takeItem(p, sooner.id, 1, { consumeConjured: true });
  assert.equal(s.findArrow(p).id, later.id);
  minute = 111;
  w.advance(500);
  w.rt.tick(0.5);
  assert.equal(s.findArrow(p).id, ordinary.id);
  assert.equal(ordinary.quantity, ordinaryQuantity);
});

test('Dispel Magic spends on opening, removes only the selected eligible bundle and rolls on foreign spells', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo');
  p.rpg.character.magicka = 10000;
  p.rpg.magic.known.push('std:17', 'std:59');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:17' }));
  const m = p.rpg.magic;
  assert.equal(new Set(m.active.map((a) => a.bundleId)).size, 1);
  m.active.push(
    { spellId: 'potion:sleep', spellName: 'Potion', key: 'Paralyze', roundsLeft: 3 },
    { spellId: 'std:18', spellName: 'Open', key: 'Open', roundsLeft: 3 },
    { spellId: 'std:18', spellName: 'Foreign spell', key: 'Light', casterId: q.id, roundsLeft: 3 },
  );
  m.door = { open: 1 };
  const open = () => {
    w.advance(2000);
    const before = p.rpg.character.magicka;
    ok(w.rt.act(p, 'magic.cast', { spellId: 'std:59', targetId: `player:${q.id}` }));
    assert.ok(p.rpg.character.magicka < before);
    return w.events(p.id, 'spellEffectChoice').at(-1);
  };
  let picker = open();
  assert.deepEqual(picker.options.map((o) => o.name), ['Ward', 'Foreign spell']);
  const paid = p.rpg.character.magicka;
  ok(w.rt.act(p, 'magic.choose', { token: picker.token, cancel: true }));
  assert.equal(p.rpg.character.magicka, paid);
  assert.equal(m.active.length, 5);
  picker = open();
  ok(w.rt.act(p, 'magic.choose', { token: picker.token, index: 1 }));
  assert.match(w.events(p.id, 'spellResult').at(-1).text, /fail to dispel/);
  assert.equal(m.active.length, 5);
  picker = open();
  ok(w.rt.act(p, 'magic.choose', { token: picker.token, index: 0 }));
  assert.deepEqual(m.active.map((a) => a.spellName), ['Potion', 'Open', 'Foreign spell']);
  assert.deepEqual(m.door, { open: 1 });
  assert.deepEqual(w.events(q.id, 'spellEffectChoice'), []);
});

test('peer concealment reports current appearance after a break and overlapping expiry', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo');
  const snap = () => w.rt.rpgMessage(q).peers.find((peer) => peer.id === p.id);
  p.rpg.magic.known.push('std:111', 'std:112');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:111' }));
  assert.equal(snap().concealment, 'invisible');
  w.rt.ctx.services.breakMagicConcealment(p);
  assert.equal(snap().concealment, undefined);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:112' }));
  w.rt.ctx.services.breakMagicConcealment(p);
  assert.equal(snap().concealment, 'invisible');
  assert.equal(snap().magic, undefined);
  w.rt.tick(5);
  assert.equal(snap().concealment, 'invisible');
  w.rt.tick(5);
  assert.equal(snap().concealment, undefined);
  assert.deepEqual(w.events(q.id, 'magicExpired'), []);
});

test('a killing spell reports the kill once and clears effects on the corpse', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -2, 5);
  p.rpg.magic.known.push('std:51');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:51', targetId: 'rat' }));
  assert.equal(rat.hp, 0);
  assert.deepEqual(w.calls.kill, ['rat']);
  w.rt.tick(5);
  w.rt.tick(5);
  assert.deepEqual(w.calls.kill, ['rat']);
  assert.equal(w.magic.entityEffects.has('rat'), false);
  w.advance(2000);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:51', targetId: 'rat' }), /already dead|not here/);
});

test('a missile at nothing is spent and reported as a miss', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  w.monster('behind', 0, 10);
  ok(w.rt.act(p, 'magic.cast', {}));
  assert.equal(p.rpg.character.magicka, 955);
  w.rt.tick(8.1);
  const [ev] = w.events(1, 'spellImpact');
  assert.equal(ev.missed, true);
  assert.match(w.events(1, 'spellResult')[0].text, /hits nothing/);
});

test('partial spells apply what is supported and name what is not', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -5, 30);
  p.rpg.magic.known.push('std:33');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:33' }));
  w.rt.tick(0.3);
  assert.equal(rat.hp, 27);
  assert.match(w.events(1, 'spellResult')[0].text, /Unknown effect 99\/-1.*not supported/);
});

test('a failed save rolls back magicka, entity damage, effects and the cooldown', () => {
  let fail = true;
  const w = world({ failSave: () => fail });
  fail = false;
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -2, 50);
  p.rpg.magic.known.push('std:51');
  fail = true;
  const r = w.rt.act(p, 'magic.cast', { spellId: 'std:51', targetId: 'rat' });
  assert.equal(r.ok, false);
  assert.equal(p.rpg.character.magicka, 1000);
  assert.equal(rat.hp, 50);
  assert.equal(w.magic.entityEffects.has('rat'), false);
  assert.equal(w.events(1, 'spellCast').length, 0);
  fail = false;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:51', targetId: 'rat' }));
});

test('active effects on players persist as rounds and resume after a reload', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  p.rpg.magic.known.push('std:17');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:17' }));
  const stored = JSON.parse(JSON.stringify(p.rpg));
  const w2 = world();
  const again = { id: 7, name: 'Ana', x: 0, z: 0, yaw: 0, moving: false, rpg: stored };
  w2.players.set(7, again);
  w2.rt.join(again);
  assert.equal(w2.rt.ctx.services.magicModifiers(again).shield, 20);
  w2.rt.tick(5);
  assert.equal(again.rpg.magic.active[0].roundsLeft, 1);
});

test('publicSpell is JSON-safe and describes every effect', () => {
  const cat = loadCatalogue({ spellsStd: STD });
  for (const s of cat.spells.values()) {
    const pub = JSON.parse(JSON.stringify(publicSpell(s)));
    assert.equal(pub.effects.length, s.effects.length);
  }
});

test('a projectile obeys wall collision and fails to track a target that moves', () => {
  let wall = true;
  const w = world({ services: {
    collision: { instanceWorld: () => ({ segmentClear: (_x1, _y1, z1, _x2, _y2, z2) => !wall || z1 <= -4 || z2 > -4 }) },
  } });
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -10);
  ok(w.rt.act(p, 'magic.cast', { targetId: rat.id }));
  w.rt.tick(0.5);
  assert.equal(rat.hp, 50);
  const [impact] = w.events(1, 'spellImpact');
  assert.equal(impact.reason, 'wall');
  assert.ok(Math.abs(impact.center.z + 4) < 0.05);
  wall = false;
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { targetId: rat.id }));
  rat.x = 3;
  w.rt.tick(8.1);
  assert.equal(rat.hp, 50);
  assert.equal(w.events(1, 'spellImpact').at(-1).reason, 'range');
});

test('ranged area damage lands at impact without reaching behind geometry', () => {
  const w = world({ services: {
    collision: { instanceWorld: () => ({ segmentClear: (x1, _y1, _z1, x2) => x1 < 1 && x2 < 1 }) },
  } });
  const p = w.add(1, 'Ana');
  const center = w.monster('center', 0, -10);
  const near = w.monster('near', -2, -10);
  const blocked = w.monster('blocked', 2, -10);
  const far = w.monster('far', 0, -15);
  p.rpg.magic.known.push('std:14');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:14', targetId: center.id }));
  assert.equal(center.hp, 50);
  w.rt.tick(0.5);
  assert.equal(center.hp, 45);
  assert.equal(near.hp, 45);
  assert.equal(blocked.hp, 50);
  assert.equal(far.hp, 50);
  assert.deepEqual(w.events(1, 'spellImpact')[0].targetIds, ['center', 'near']);
});

test('detection markers are private and clear when the effect expires', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  w.add(2, 'Bo');
  w.monster('near', -3, 2);
  w.monster('far', -20, 4);
  w.monster('other-floor', 1, 1, 50, { y: 4 });
  w.monster('invisible-quest-foe', -5, 0, 50, { visibleTo: [2] });
  p.rpg.magic.active.push({ status: 'detectEnemy', roundsLeft: 1 });
  w.rt.tick(0.5);
  assert.deepEqual(w.events(1, 'spellDetection')[0].markers.map((m) => m.id), ['near']);
  assert.deepEqual(w.events(2, 'spellDetection'), []);
  w.rt.tick(5);
  w.rt.tick(0.5);
  assert.deepEqual(w.events(1, 'spellDetection').at(-1).markers, []);
});

test('private enemy missile events and damage stay with its quest owner', () => {
  const w = world();
  const p = w.add(1, 'Ana', 0, -1);
  const q = w.add(2, 'Bo', 0, 0);
  const foe = w.monster('quest-foe', 0, -10, 50, { visibleTo: [2], magicka: 1000 });
  assert.equal(w.rt.ctx.services.enemyCast(foe, 8, p), null);
  assert.ok(w.rt.ctx.services.enemyCast(foe, 8, q).pending);
  assert.equal(w.events(1, 'spellCast').length, 0);
  assert.equal(w.events(2, 'spellCast').length, 1);
  w.rt.tick(0.5);
  assert.equal(p.rpg.character.health, 30);
  assert.equal(q.rpg.character.health, 20);
  assert.equal(w.events(1, 'spellImpact').length, 0);
  assert.equal(w.events(2, 'spellImpact').length, 1);
});

test('Recall keeps its floor and entry data across reload and consumes the anchor on return', () => {
  const transfers = [];
  const services = { portals: { transfer(p, at, options) { transfers.push([at, options]); Object.assign(p, { x: at.x, z: at.z, yaw: at.yaw }); p.rpg.location = at.location; } } };
  const w = world({ services });
  const p = w.add(1, 'Ana', 3, -4, 0.25);
  p.rpg.magic.known.push('std:94');
  p.rpg.portal = { id: 'door', from: 'town:Test/Exit', to: L, footY: 7, returnTo: { location: 'town:Test/Exit', x: 2, z: 0, yaw: 0 } };
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:94' }));
  assert.equal(w.events(1, 'spellRecallChoice')[0].hasAnchor, false);
  assert.equal(p.rpg.character.magicka, 1000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:94', recall: 'anchor' }));
  const stored = structuredClone(p.rpg);
  const restarted = world({ services });
  const rejoined = restarted.add(5, 'Ana', 8, 12);
  rejoined.rpg = stored;
  rejoined.rpg.location = 'town:Test/Other';
  ok(restarted.rt.act(rejoined, 'magic.cast', { spellId: 'std:94', recall: 'return' }));
  assert.deepEqual([rejoined.rpg.location, rejoined.x, rejoined.z, rejoined.yaw], [L, 3, -4, 0.25]);
  assert.equal(transfers[0][0].y, 7);
  assert.deepEqual(transfers[0][1].returnTo, stored.portal.returnTo);
  assert.equal(rejoined.rpg.magic.anchor, undefined);
});

test('Open and Lock arm one eligible door interaction and survive magic rounds', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  p.rpg.magic.known.push('std:18', 'std:19');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:19' }));
  w.rt.tick(20);
  assert.equal(w.rt.ctx.services.takeDoorMagic(p, 'open'), null, 'an exterior door leaves Lock waiting');
  assert.deepEqual(w.rt.ctx.services.takeDoorMagic(p), { operation: 'lock', level: 1 });
  assert.equal(w.rt.ctx.services.takeDoorMagic(p), null);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:18' }));
  w.advance(2000);
  p.rpg.character.magicka = p.rpg.character.maxMagicka;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:19' }));
  assert.deepEqual(w.rt.ctx.services.takeDoorMagic(p), { operation: 'lock', level: 1 });
  assert.deepEqual(w.rt.ctx.services.takeDoorMagic(p, 'open'), { operation: 'open', level: 1 });
});

test('Soul Trap checks at death, preserves a creature without a gem and fills only the caster’s gem', () => {
  const captures = [];
  const w = world({ services: { captureSoul(p, soul) { captures.push([p.id, soul]); return { captured: !!p.rpg.emptyGem }; } } });
  const caster = w.add(1, 'Ana');
  const ally = w.add(2, 'Bo');
  const imp = w.monster('imp', 0, -2, 5, { monsterId: 1 });
  caster.rpg.magic.known.push('std:62');
  ok(w.rt.act(caster, 'magic.cast', { spellId: 'std:62', targetId: imp.id }));
  assert.deepEqual(captures, []);
  assert.ok(w.rt.ctx.services.magicStatus(imp).soulTrapped);
  ok(w.rt.act(ally, 'magic.cast', { spellId: 'std:8', targetId: imp.id }));
  w.rt.tick(0.2);
  assert.equal(imp.hp, 1);
  assert.equal(imp.dead, undefined);
  caster.rpg.emptyGem = true;
  w.advance(2000);
  ok(w.rt.act(ally, 'magic.cast', { spellId: 'std:8', targetId: imp.id }));
  w.rt.tick(0.2);
  assert.equal(imp.dead, true);
  assert.deepEqual(captures, Array(2).fill([caster.id, { id: 1, name: 'imp', points: 1000 }]));
});

test('drain changes effective attribute state, pacify changes hostility and cure removes a condition', () => {
  const w = world({ services: { cureCondition(p, kind) {
    assert.equal(kind, 'disease');
    const count = p.rpg.diseases.length;
    p.rpg.diseases = [];
    return count;
  } } });
  const p = w.add(1, 'Ana');
  const rat = w.monster('rat', 0, -2, 30, { monsterId: 0, hostile: true, _targetId: p.id, _pending: [{ targetId: p.id }] });
  p.rpg.magic.known.push('std:9', 'std:61', 'std:99');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:9', targetId: rat.id }));
  assert.equal(w.rt.ctx.services.magicAttributeModifier(rat, 'Strength'), -9);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:99', targetId: rat.id }));
  assert.equal(rat.hostile, false);
  assert.equal(rat._targetId, null);
  assert.deepEqual(rat._pending, []);
  w.advance(2000);
  p.rpg.diseases = ['witch-pox'];
  p.rpg.character.magicka = 1000;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:61' }));
  assert.deepEqual(p.rpg.diseases, []);
});

test('attribute transfer heals the caster’s drain by the roll and Heal restores the remainder', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  p.rpg.magic.known.push('std:101', 'std:102');
  const foe = w.monster('enemy mage', 0, -2, 50, { magicka: 1000 });
  assert.ok(w.rt.ctx.services.enemyCast(foe, 9, p));
  assert.equal(w.rt.ctx.services.magicAttributeModifier(p, 'Strength'), -9);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:102', targetId: foe.id }));
  assert.equal(w.rt.ctx.services.magicAttributeModifier(p, 'Strength'), -3);
  assert.equal(w.rt.ctx.services.magicAttributeModifier(foe, 'Strength'), -6);
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:101' }));
  assert.equal(w.rt.ctx.services.magicAttributeModifier(p, 'Strength'), 0);
  assert.equal(p.rpg.character.attributes.Strength, 50);
});

test('Spell Maker validates rank and effect compatibility, then saves a private spell that casts after reload', () => {
  const services = { requireNpcService(p, args, service) {
    assert.equal(service, 'makeSpells');
    if (args.session !== 'live' || args.targetId !== 'maker') throw new Error('That conversation has ended.');
    return { guild: 'temple', factionId: 497, rank: p.rpg.testRank };
  } };
  const w = world({ services });
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo');
  const draft = { targetId: 'maker', session: 'live', name: 'Night Cure', targetType: 'caster',
    element: 'magic', icon: 12, effects: [{ key: 'Heal-Health', settings: { magnitudeBaseMin: 3, magnitudeBaseMax: 3 } }] };
  p.rpg.testRank = 5;
  fails(w.rt.act(p, 'magic.make', draft), /requires rank 6/);
  p.rpg.testRank = 6;
  fails(w.rt.act(p, 'magic.make', { ...draft, session: 'other' }), /has ended/);
  fails(w.rt.act(p, 'magic.make', { ...draft, element: 'fire' }), /cannot use that element/);
  fails(w.rt.act(p, 'magic.make', { ...draft, effects: [...draft.effects, ...draft.effects] }), /only once/);
  assert.equal(p.rpg.gold, 5000);
  ok(w.rt.act(p, 'magic.make', draft));
  const [spell] = p.rpg.magic.custom;
  assert.equal(p.rpg.magic.selected, spell.id);
  assert.equal(p.rpg.gold, 4912);
  assert.ok(w.events(1, 'spellCatalogue').at(-1).spells.some((s) => s.id === spell.id));
  assert.ok(!w.events(2, 'spellCatalogue').at(-1).spells.some((s) => s.id === spell.id));
  fails(w.rt.act(q, 'magic.cast', { spellId: spell.id }), /not in your spellbook/);
  const next = world();
  const rejoined = next.add(7, 'Ana');
  rejoined.rpg = JSON.parse(JSON.stringify(p.rpg));
  ok(next.rt.act(rejoined, 'magic.cast', { spellId: spell.id }));
  assert.equal(rejoined.rpg.character.health, 34);
  ok(next.rt.act(rejoined, 'magic.forget', { spellId: spell.id }));
  assert.equal(rejoined.rpg.magic.custom.length, 0);
});

const REAL_DIR = process.env.ARENA2_DIR && existsSync(`${process.env.ARENA2_DIR}/SPELLS.STD`)
  ? process.env.ARENA2_DIR
  : 'gamedata/DaggerfallGameFiles/arena2';
const REAL = `${REAL_DIR}/SPELLS.STD`;
test('operator SPELLS.STD (local only)', { skip: !existsSync(REAL) && 'no local game data' }, () => {
  const records = parseSpellsStd(readFileSync(REAL));
  assert.equal(records.length, 89);
  const cat = loadCatalogue({ arena2Dir: REAL_DIR });
  assert.equal(cat.source, 'SPELLS.STD');
  assert.deepEqual(cat.coverage, { total: 89, full: 45, tracked: 44, partial: 0, unsupported: 0, hidden: 12 });
  const effectCounts = Object.groupBy(EFFECTS.values(), (t) => t.support);
  assert.deepEqual(Object.fromEntries(Object.entries(effectCounts).map(([support, list]) => [support, list.length])),
    { tracked: 40, applied: 51 });
  const lyc = cat.spells.get('std:92');
  assert.equal(lyc.name, 'Lycanthropy');
  assert.equal(lyc.support, 'full');
  assert.equal(lyc.hidden, true);
  assert.equal(lyc.effects[0].template.key, 'MorphSelf');
  assert.equal(lyc.effects[0].template.spellMaker, false);
  const shock = cat.spells.get('std:8');
  assert.equal(shock.targetType, 'touch');
  assert.equal(shock.support, 'full');
  assert.equal(cat.spells.get('std:10').effects[0].template.key, 'FreeAction', 'DFU Free Action data fix');
  assert.ok(cat.spells.has('std:58') && cat.spells.has('std:58.1'), 'duplicate indices stay distinct');
});

test('feedback: healing sends a private heal with the amount applied; enemy spells report hurt as a spell', () => {
  const w = world();
  const p = w.add(1, 'Ana');
  const q = w.add(2, 'Bo', 0, -2, 0, character({ health: 10 }));
  p.rpg.magic.known.push('std:64', 'std:40');
  p.rpg.character.health = 47;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:64' }));
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:40', targetId: 'player:2' }));
  assert.deepEqual(w.events(1, 'heal'), [{ kind: 'heal', amount: 3 }], 'clamped to what was restored');
  assert.deepEqual(w.events(2, 'heal'), [{ kind: 'heal', amount: 6 }]);

  const foe = w.monster('foe', 0, -10, 50, { magicka: 1000 });
  w.clear();
  assert.ok(w.rt.ctx.services.enemyCast(foe, 8, q).pending);
  w.rt.tick(0.5);
  assert.deepEqual(w.events(2, 'hurt'), [{ kind: 'hurt', damage: 10, cause: 'spell' }]);
  assert.equal(w.events(1, 'hurt').length, 0);

  const causes = [];
  const w2 = world({ services: { hurtPlayerBy: (pl, n, src, cause) => { causes.push(cause); return n; } } });
  const r = w2.add(1, 'Cy');
  assert.ok(w2.rt.ctx.services.enemyCast(w2.monster('foe', 0, -10, 50, { magicka: 1000 }), 8, r).pending);
  w2.rt.tick(0.5);
  assert.deepEqual(causes, ['spell']);
});

test('legacy built-in spells remain castable and receive SPELLS.STD class starting spells on migration', () => {
  const w = world();
  // Simulate a character saved before ARENA2_DIR was enabled (with ward:* spells).
  const p = {
    id: 9, name: 'Anders', x: 0, z: 0, yaw: 0, dirty: false,
    rpg: {
      location: 'town',
      gold: 100,
      character: character({ className: 'Mage', magicka: 90, maxMagicka: 90 }),
      magic: { known: ['ward:ember-dart', 'ward:mending'], active: [], custom: [], selected: 'ward:ember-dart', readySpell: null, granted: true },
    },
  };
  w.players.set(9, p);
  w.rt.join(p);
  const catEv = w.events(9, 'spellCatalogue').at(-1);
  assert.ok(catEv.spells.some((s) => s.id === 'ward:ember-dart'), 'legacy known ward:ember-dart is included in catalogue');
  assert.ok(catEv.spells.some((s) => s.id === 'ward:mending'), 'legacy known ward:mending is included in catalogue');
  assert.ok(!catEv.spells.some((s) => s.id === 'ward:static-palm'), 'unknown legacy spells stay hidden');
  assert.equal(p.rpg.magic.selected, 'ward:ember-dart', 'valid legacy selection is preserved');
  assert.ok(p.rpg.magic.known.includes('std:8'), 'Mage also receives SPELLS.STD starting spell');
  // Casting the legacy ranged spell succeeds and launches a missile.
  ok(w.rt.act(p, 'magic.cast', { spellId: 'ward:ember-dart', yaw: 0, pitch: 0 }));
  assert.ok(w.events(9, 'spellCast').some((e) => e.spellId === 'ward:ember-dart' && e.missile), 'legacy Ember Dart launches');
  // A fresh player on the SPELLS.STD server does not see legacy ward:* spells in their catalogue.
  const fresh = w.add(10, 'Fresh');
  const freshCat = w.events(10, 'spellCatalogue').at(-1);
  assert.ok(!freshCat.spells.some((s) => s.id.startsWith('ward:')), 'fresh SPELLS.STD players do not see legacy spells');
});

test('stale or missing selected spell reconciles on join, including fallback without SPELLS.STD', () => {
  const w = world({ magicOpts: { spellsStd: null } });
  const p = {
    id: 11, name: 'Traveller', x: 0, z: 0, yaw: 0, dirty: false,
    rpg: {
      location: 'town',
      gold: 100,
      character: character({ className: 'Mage', magicka: 100, maxMagicka: 100 }),
      magic: { known: ['std:1', 'std:8'], active: [], custom: [], selected: 'std:1', readySpell: null, granted: true },
    },
  };
  w.players.set(11, p);
  w.rt.join(p);
  assert.ok(p.rpg.magic.known.includes('ward:ember-dart'), 'grants built-in fallback spells when SPELLS.STD is absent');
  assert.equal(p.rpg.magic.selected, 'ward:ember-dart', 'auto-selects a castable fallback spell');
  ok(w.rt.act(p, 'magic.cast', { spellId: p.rpg.magic.selected, yaw: 0, pitch: 0 }));
});

test('MorphSelf (Lycanthropy std:92) transforms lycanthropes at 0 magicka, reverts from beast form, and stays out of Spell Maker', () => {
  let transformed = false;
  let cooldownUsed = false;
  const services = {
    conditionBeastForm: (pl) => (pl.rpg?.conditions?.lycanthrope && transformed ? pl.rpg.conditions.lycanthrope.form : null),
    conditionMorphSelf: (pl) => {
      if (!pl.rpg?.conditions?.lycanthrope) return { ok: false, transformed: false, reason: 'You are not a lycanthrope.' };
      if (!transformed && cooldownUsed) return { ok: false, transformed: false, reason: 'You can only do this once per day.' };
      transformed = !transformed;
      if (transformed) cooldownUsed = true;
      return { ok: true, transformed };
    },
    requireNpcService: () => ({ guild: 'mages', factionId: 40, rank: 1 }),
  };
  const w = world({ services });
  const p = w.add(1, 'Ana');
  assert.ok(!p.rpg.magic.known.includes('std:92'), 'non-lycanthrope does not start with Lycanthropy');
  // Excluded from Spell Maker even though MorphSelf is supported.
  fails(w.rt.act(p, 'magic.make', {
    targetId: 'maker', session: 'live', name: 'Bad Morph', targetType: 'caster', element: 'magic', icon: 10,
    effects: [{ key: 'MorphSelf', settings: {} }],
  }), /unavailable in the Spell Maker/);

  // Non-lycanthrope manually taught std:92 gets a clean no-effect message.
  p.rpg.magic.known.push('std:92');
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:92' }));
  assert.match(w.events(1, 'spellResult').at(-1).text, /You are not a lycanthrope/);
  p.rpg.magic.known = p.rpg.magic.known.filter((id) => id !== 'std:92');

  // Contracting lycanthropy grants std:92 automatically as an innate 0-mp unremovable spell.
  p.rpg.conditions = { lycanthrope: { form: 'werewolf', transformed: false } };
  w.rt.ctx.emit('conditionChanged', { player: p, change: 'deployed', kind: 'lycanthropy', key: 'werewolf' });
  assert.ok(p.rpg.magic.known.includes('std:92'));
  const cat = w.events(1, 'spellCatalogue').at(-1);
  const lyc = cat.spells.find((s) => s.id === 'std:92');
  assert.equal(lyc.innate, 'lycanthrope');
  assert.equal(lyc.baseCosts.magicka, 0);
  fails(w.rt.act(p, 'magic.forget', { spellId: 'std:92' }), /cannot forget your lycanthropy spell/);

  // Casting Lycanthropy costs 0 magicka and shifts into beast form.
  w.advance(2000);
  const manaBefore = p.rpg.character.magicka;
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:92' }));
  assert.equal(p.rpg.character.magicka, manaBefore, 'innate Lycanthropy costs 0 magicka');
  assert.equal(transformed, true);
  assert.match(w.events(1, 'spellResult').at(-1).text, /shift into beast form/);

  // Other spells are still blocked in beast form, but Lycanthropy can revert to human form.
  w.advance(2000);
  fails(w.rt.act(p, 'magic.cast', { spellId: 'std:8' }), /cannot cast spells in beast form/);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:92' }));
  assert.equal(transformed, false);
  assert.match(w.events(1, 'spellResult').at(-1).text, /return to your normal form/);

  // Once-per-day cooldown is honoured on second shift.
  w.advance(2000);
  ok(w.rt.act(p, 'magic.cast', { spellId: 'std:92' }));
  assert.equal(transformed, false);
  assert.match(w.events(1, 'spellResult').at(-1).text, /once per day/);

  // Curing lycanthropy removes the auto-granted std:92 spell.
  p.rpg.conditions.lycanthrope = null;
  w.rt.ctx.emit('conditionChanged', { player: p, change: 'cured', kind: 'lycanthropy', key: 'werewolf' });
  assert.ok(!p.rpg.magic.known.includes('std:92'));
});
