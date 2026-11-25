// Classic gameplay parity regression tests:
//   1. Dungeon opcode-9 caster-only traps grant a free ready-to-cast spell (magic.js + interiors/actions.js)
//   2. Recoverable player arrows embedded in defeated enemies with no duplication (combat.js)
//   3. Dynamic regional faction power, monthly Merchants' power step, and regional holiday pricing (economy.js)
//   4. Multi-region court-faction reputation and persistent pickpocket memory across NPC rebuilds (law.js)

import test from 'node:test';
import assert from 'node:assert/strict';
import { install as installMagic } from '../server/rpg/magic.js';
import { install as installCombat } from '../server/rpg/combat.js';
import { install as installEconomy } from '../server/rpg/economy.js';
import { createShopEconomy } from '../server/rpg/economy/ledger.js';
import {
  REGIONAL_HOLIDAY_RULES, adjustedBuyPrice, merchantsMonthlyDelta, regionalHolidayPrice,
} from '../server/rpg/economy/dynamic.js';
import { install as installLaw } from '../server/rpg/law.js';
import { EFFECTS } from '../server/rpg/magic/effects.js';
import { MERCHANTS_FACTION, priceAdjust, setFactionPowers } from '../client/gameplay/economy/rules.js';
import { MINUTES_PER_DAY } from '../client/gameplay/atmosphere/calendar.js';
import { HOLIDAYS } from '../client/gameplay/atmosphere/holidays.js';

function makeHarness({ now = 1_000_000 } = {}) {
  let clock = now;
  const actions = new Map();
  const listeners = new Map();
  const ticks = [];
  const joins = [];
  const leaves = [];
  const notices = new Map();
  const events = [];
  const worldRows = new Map();
  const players = new Map();
  const entities = new Map();

  const ctx = {
    players,
    entities,
    services: {},
    now: () => clock,
    advance: (ms) => { clock += ms; },
    location: (p) => p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden',
    dirty: () => {},
    touchEntity: () => {},
    afterCommit: (fn) => fn(),
    onRollback: () => {},
    onAction: (name, fn) => actions.set(name, fn),
    onTick: (fn) => ticks.push(fn),
    onJoin: (fn) => joins.push(fn),
    onLeave: (fn) => leaves.push(fn),
    on: (ev, fn) => {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    emit: (ev, payload) => {
      events.push({ ev, payload });
      for (const fn of listeners.get(ev) ?? []) fn(payload);
    },
    notify: (p, msg) => {
      const list = notices.get(p.id) ?? [];
      list.push(msg);
      notices.set(p.id, list);
    },
    nearby: () => {},
    spawnEntity: (e) => { entities.set(e.id, e); return e; },
    despawnEntity: (id) => { entities.delete(id); },
    loadWorld: (prefix) => [...worldRows.entries()].filter(([k]) => k.startsWith(prefix)),
    dirtyWorld: (key, val) => {
      if (val == null) worldRows.delete(key);
      else worldRows.set(key, structuredClone(val));
    },
    worldRows,
    runAtomic: (p, _name, fn) => {
      try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, error: err.message }; }
    },
  };

  function act(p, name, args = {}) {
    const fn = actions.get(name);
    if (!fn) throw new Error(`missing action ${name}`);
    const rollbacks = [];
    const prevRollback = ctx.onRollback;
    ctx.onRollback = (r) => rollbacks.push(r);
    try {
      const value = fn(p, args);
      return { ok: true, value };
    } catch (err) {
      while (rollbacks.length) {
        try { rollbacks.pop()(); } catch {}
      }
      return { ok: false, error: err.message };
    } finally {
      ctx.onRollback = prevRollback;
    }
  }

  return {
    ctx,
    act,
    tick: (dt = 0.1) => { for (const fn of ticks) fn(dt); },
    join: (p) => { players.set(p.id, p); for (const fn of joins) fn(p); },
    noticesOf: (p) => notices.get(p.id) ?? [],
    clearNotices: (p) => notices.set(p.id, []),
    events,
  };
}

// =========================================================================
// 1. Dungeon trap ready-to-cast free cast
// =========================================================================

test('opcode-9 caster-only traps grant a free ready-to-cast spell with 0 magicka cost, replacement, and expiry; harmful traps remain immediate', () => {
  const allEffects = [...EFFECTS.values()];
  const levitateTemplate = allEffects.find((e) => e.key === 'Levitate');
  const shieldTemplate = allEffects.find((e) => e.key === 'Shield');
  const dmgTemplate = allEffects.find((e) => e.key === 'Damage-Health');
  assert.ok(levitateTemplate && shieldTemplate && dmgTemplate);

  const levitateSpell = {
    id: 'std:10', index: 10, name: 'Levitate', origin: 'SPELLS.STD', support: 'full',
    element: 'magic', targetType: 'caster', harmful: false, icon: 1, price: 100, schools: ['Thaumaturgy'],
    baseCosts: { magicka: 25, gold: 100 },
    effects: [{ template: levitateTemplate, settings: { durationBase: 2, durationPlus: 1, durationPerLevel: 1 } }],
  };
  const shieldSpell = {
    id: 'std:11', index: 11, name: 'Shield', origin: 'SPELLS.STD', support: 'full',
    element: 'magic', targetType: 'caster', harmful: false, icon: 2, price: 120, schools: ['Alteration'],
    baseCosts: { magicka: 30, gold: 120 },
    effects: [{ template: shieldTemplate, settings: { durationBase: 2, durationPlus: 1, durationPerLevel: 1, magnitudeBaseMin: 10, magnitudeBaseMax: 10, magnitudePlusMin: 0, magnitudePlusMax: 0, magnitudePerLevel: 1 } }],
  };
  const harmSpell = {
    id: 'std:12', index: 12, name: 'Fireball', origin: 'SPELLS.STD', support: 'full',
    element: 'fire', targetType: 'singleAtRange', harmful: true, icon: 3, price: 150, schools: ['Destruction'],
    baseCosts: { magicka: 20, gold: 150 },
    effects: [{ template: dmgTemplate, settings: { magnitudeBaseMin: 8, magnitudeBaseMax: 8, magnitudePlusMin: 0, magnitudePlusMax: 0, magnitudePerLevel: 1 } }],
  };

  const catalogue = {
    source: 'SPELLS.STD',
    coverage: { full: 3, partial: 0, unsupported: 0 },
    spells: new Map([[levitateSpell.id, levitateSpell], [shieldSpell.id, shieldSpell], [harmSpell.id, harmSpell]]),
    byIndex: new Map([[10, levitateSpell], [11, shieldSpell], [12, harmSpell]]),
  };

  const h = makeHarness({ now: 10_000 });
  installMagic(h.ctx, { catalogue, rng: () => 0.99, missileSpeed: Infinity, readySpellMs: 60_000 });

  const p = {
    id: 'p1', name: 'Hero', x: 0, y: 0, z: 0, yaw: 0,
    rpg: {
      location: 'dungeon:Daggerfall/PrivateersHold',
      character: { level: 3, health: 40, maxHealth: 40, magicka: 5, maxMagicka: 50, fatigue: 50, maxFatigue: 50, attributes: { Willpower: 50 }, skills: { Thaumaturgy: 30, Alteration: 30 } },
    },
  };
  h.join(p);
  h.clearNotices(p);

  const trap = { id: 'dungeon:m1', name: 'trap', location: p.rpg.location, x: 1, y: 0, z: 0 };

  // Caster-only trap spell readies a free cast instead of applying immediately.
  const res1 = h.ctx.services.objectCast(trap, 10, p, { level: 3 });
  assert.equal(res1.ok, true);
  assert.equal(res1.ready, true);
  assert.equal(p.rpg.magic.active.length, 0, 'Levitate must NOT apply immediately');
  assert.equal(p.rpg.magic.readySpell.spellId, 'std:10');
  assert.equal(h.noticesOf(p).some((n) => n.kind === 'spellReady' && n.spellId === 'std:10' && n.free === true), true);

  // Replacement: a second caster-only trap cleanly replaces the ready spell.
  const res2 = h.ctx.services.objectCast(trap, 11, p, { level: 3 });
  assert.equal(res2.ready, true);
  assert.equal(p.rpg.magic.readySpell.spellId, 'std:11');

  // Cast at 0 magicka cost even though player only has 5 magicka (Shield costs 30).
  const castRes = h.act(p, 'magic.castFree', {});
  assert.equal(castRes.ok, true);
  assert.equal(p.rpg.character.magicka, 5, 'free ready cast spends 0 magicka');
  assert.equal(p.rpg.magic.readySpell, null, 'readySpell cleared after casting');
  assert.ok(p.rpg.magic.active.some((a) => a.key === 'Shield'), 'Shield effect applied on castFree');

  // Consumed ready spell cannot be cast twice.
  const again = h.act(p, 'magic.castFree', {});
  assert.equal(again.ok, false);
  assert.match(again.error, /no ready free spell/i);

  // Clean expiry after readySpellMs.
  h.ctx.services.objectCast(trap, 10, p, { level: 3 });
  assert.equal(p.rpg.magic.readySpell.spellId, 'std:10');
  h.ctx.advance(60_001);
  const expired = h.act(p, 'magic.castFree', {});
  assert.equal(expired.ok, false);
  assert.equal(p.rpg.magic.readySpell, null);

  // An expired ready spell is dropped by the magic round without a cast attempt, so saved state and the client's
  // FREE chip do not keep offering it.
  h.ctx.services.objectCast(trap, 10, p, { level: 3 });
  h.ctx.advance(60_001);
  h.tick(5);
  assert.equal(p.rpg.magic.readySpell, null, 'expired ready spell cleared by the round');

  // Harmful trap spell still casts immediately and does NOT set readySpell.
  p.rpg.magic.active = [];
  const hpBefore = p.rpg.character.health;
  const harmRes = h.ctx.services.objectCast(trap, 12, p, { level: 3 });
  assert.equal(harmRes.ok, true);
  assert.equal(harmRes.ready, undefined);
  assert.equal(p.rpg.magic.readySpell, null);
  assert.ok(p.rpg.character.health < hpBefore, 'harmful trap spell damages player immediately');
});

// =========================================================================
// 2. Recoverable player arrows
// =========================================================================

test('recoverable player arrows stick in defeated enemies for single-claim corpse loot; misses and conjured arrows never duplicate', () => {
  const h = makeHarness({ now: 50_000 });
  const loc = 'dungeon:Daggerfall/PrivateersHold';
  let wallBlocked = false;
  h.ctx.services.canSee = () => !wallBlocked;

  const bags = new Map();
  let nextItemId = 1;
  const bagOf = (p) => {
    if (!bags.has(p.id)) bags.set(p.id, []);
    return bags.get(p.id);
  };
  h.ctx.services.getEquippedWeapon = () => ({ id: 'bow1', template: 'steel-short-bow', name: 'Steel Short Bow', skill: 'Archery', weaponType: 'Bow', material: 'steel', damage: { min: 4, max: 12 } });
  h.ctx.services.findArrow = (p) => bagOf(p).find((it) => it.template === 'arrow' && it.quantity > 0) ?? null;
  h.ctx.services.takeItem = (p, id, qty) => {
    const bag = bagOf(p);
    const it = bag.find((x) => x.id === id);
    if (!it || it.quantity < qty) throw new Error('missing item');
    it.quantity -= qty;
    if (it.quantity <= 0) bag.splice(bag.indexOf(it), 1);
  };
  h.ctx.services.giveItem = (p, template, quantity = 1, extra = {}) => {
    const bag = bagOf(p);
    if (template === 'arrow' && !extra?.extra?.conjuredUntil) {
      const existing = bag.find((x) => x.template === 'arrow' && x.conjuredUntil == null);
      if (existing) { existing.quantity += quantity; return existing; }
    }
    const item = { id: `it${nextItemId++}`, template, name: template, quantity, ...(extra?.extra?.conjuredUntil ? { conjuredUntil: extra.extra.conjuredUntil } : {}) };
    bag.push(item);
    return item;
  };

  installCombat(h.ctx, { random: () => 0.01 });

  const makePlayer = (id, x = 0, z = 0) => ({
    id, name: id, x, y: 0, z, yaw: 0,
    rpg: {
      location: loc, readied: true,
      character: {
        level: 5, health: 80, maxHealth: 80, fatigue: 100, maxFatigue: 100,
        attributes: { Strength: 60, Agility: 80, Speed: 60, Endurance: 50, Luck: 60 },
        skills: { Archery: 85, 'Critical Strike': 50 },
      },
    },
  });

  const archer = makePlayer('archer', 0, 0);
  const friend = makePlayer('friend', 1, 0);
  h.join(archer);
  h.join(friend);
  bagOf(archer).push({ id: 'arr1', template: 'arrow', name: 'Arrow', quantity: 5 });

  // Spawn a rat right in front of the archer (yaw 0 -> -z direction).
  const rat = h.ctx.services.createEnemy(loc, 0, 0, -3, { y: 0 });
  rat.hp = 100;
  rat.maxHp = 100;

  // Shot 1: hits and wounds the rat (1 arrow stuck).
  assert.equal(h.act(archer, 'combat.attack', { targetId: rat.id }).ok, true);
  h.tick(0.2);
  assert.equal(bagOf(archer).find((x) => x.template === 'arrow').quantity, 4);
  assert.ok(!rat.dead);

  // Shot 2: kills the rat (2 arrows stuck -> added to corpse loot).
  rat.hp = 1;
  h.ctx.advance(2000);
  assert.equal(h.act(archer, 'combat.attack', { targetId: rat.id }).ok, true);
  h.tick(0.2);
  assert.equal(rat.dead, true);
  assert.equal(rat.lootable, true);
  assert.equal(bagOf(archer).find((x) => x.template === 'arrow').quantity, 3);
  const arrowLoot = rat._loot.find((x) => x.template === 'arrow');
  assert.equal(arrowLoot?.quantity, 2, '2 hitting arrows recovered in corpse loot');

  // Loot corpse: archer recovers the 2 arrows (back to 5).
  assert.equal(h.act(archer, 'combat.loot', { targetId: rat.id }).ok, true);
  assert.equal(bagOf(archer).find((x) => x.template === 'arrow').quantity, 5);

  // Multi-claim attempt by archer or friend fails (no duplication).
  assert.equal(h.act(archer, 'combat.loot', { targetId: rat.id }).ok, false);
  assert.equal(h.act(friend, 'combat.loot', { targetId: rat.id }).ok, false);
  assert.equal(bagOf(archer).find((x) => x.template === 'arrow').quantity, 5);

  // Miss into a wall: consumes 1 arrow, produces 0 recoverable arrows anywhere.
  wallBlocked = true;
  h.ctx.advance(2000);
  assert.equal(h.act(archer, 'combat.attack', {}).ok, true);
  h.tick(0.5);
  assert.equal(bagOf(archer).find((x) => x.template === 'arrow').quantity, 4);

  // Conjured arrow hitting and killing a rat does NOT add permanent arrows to corpse loot.
  wallBlocked = false;
  bagOf(archer).length = 0;
  bagOf(archer).push({ id: 'conj1', template: 'arrow', name: 'Conjured Arrow', quantity: 2, conjuredUntil: 999999 });
  const rat2 = h.ctx.services.createEnemy(loc, 0, 0, -3, { y: 0 });
  rat2.hp = 1;
  h.ctx.advance(2000);
  assert.equal(h.act(archer, 'combat.attack', { targetId: rat2.id }).ok, true);
  h.tick(0.2);
  assert.equal(rat2.dead, true);
  assert.equal(rat2._loot.some((x) => x.template === 'arrow'), false, 'conjured arrows never become permanent corpse loot');
});

// =========================================================================
// 3. Dynamic regional economy & regional holiday pricing
// =========================================================================

test('dynamic faction power, monthly Merchants power step (persisted), and regional holiday trade pricing', () => {
  const h = makeHarness({ now: 100_000 });
  let worldMinutes = 12 * 60; // Year 1, Month 0, Day 1
  h.ctx.services.worldClock = () => ({ minutes: worldMinutes });
  installEconomy(h.ctx);

  try {
    // Seed Merchants (510) and Daggerfall province (region 17) + fallback province (-1).
    h.ctx.services.setFactionPower(MERCHANTS_FACTION, 50);
    h.ctx.services.setFactionPower(201, 50, { type: 7, region: 17 });
    h.ctx.services.setFactionPower(852, 50, { type: 7, region: -1 });
    const day180 = 180 * MINUTES_PER_DAY;
    const neutralAdj = priceAdjust(17, day180);

    // Live faction power change immediately updates regional price adjustment and persists in world state.
    h.ctx.services.setFactionPower(MERCHANTS_FACTION, 95);
    assert.equal(h.ctx.services.factionPower(MERCHANTS_FACTION), 95);
    const highMerchAdj = priceAdjust(17, day180);
    assert.notEqual(highMerchAdj, neutralAdj, 'live faction power immediately shifts regional price curve');
    assert.equal(h.ctx.worldRows.get('economy:state').powers[MERCHANTS_FACTION], 95);

    // Cold reload restores persisted faction powers from world state.
    setFactionPowers(new Map());
    const h2 = makeHarness({ now: 100_000 });
    h2.ctx.services.worldClock = () => ({ minutes: worldMinutes });
    for (const [k, v] of h.ctx.worldRows) h2.ctx.worldRows.set(k, structuredClone(v));
    installEconomy(h2.ctx);
    assert.equal(h2.ctx.services.factionPower(MERCHANTS_FACTION), 95);

    // Monthly Merchants' power step pure rule (>= 3 PricesHigh -> +1, >= 3 PricesLow -> -1).
    assert.equal(merchantsMonthlyDelta({ highCount: 2, lowCount: 0 }), 0);
    assert.equal(merchantsMonthlyDelta({ highCount: 3, lowCount: 0 }), 1);
    assert.equal(merchantsMonthlyDelta({ highCount: 0, lowCount: 3 }), -1);
    assert.equal(merchantsMonthlyDelta({ highCount: 3, lowCount: 3 }), 0);

    // Monthly update runs once per month and persists monthKey.
    h.ctx.services.setFactionPower(MERCHANTS_FACTION, 300);
    h.ctx.services.setFactionPower(852, 0, { type: 7, region: -1 });
    worldMinutes = 250 * MINUTES_PER_DAY; // Month 8, high Merchants power drives >=3 regions > 2000
    const step1 = h.ctx.services.updateMonthlyEconomy(worldMinutes);
    assert.equal(step1.stepped, true);
    assert.ok(step1.highCount >= 3, `expected >=3 PricesHigh regions, got ${step1.highCount}`);
    assert.equal(step1.delta, 1);
    assert.equal(h.ctx.services.factionPower(MERCHANTS_FACTION), 301);
    // Calling again in the same month is a no-op.
    const stepRepeat = h.ctx.services.updateMonthlyEconomy(worldMinutes + MINUTES_PER_DAY);
    assert.equal(stepRepeat.stepped, false);
    assert.equal(h.ctx.services.factionPower(MERCHANTS_FACTION), 301);

    // Regional holiday pricing beyond the 3 global trade holidays.
    assert.ok(REGIONAL_HOLIDAY_RULES.saturalia);
    assert.equal(regionalHolidayPrice(200, 'saturalia').price, 100);
    assert.equal(regionalHolidayPrice(200, 'saturalia', { guildFaction: 40 }).price, 200, 'guild shops exempt');
    assert.equal(regionalHolidayPrice(200, 'festival-of-blades', { itemGroup: 'Weapons' }).price, 100);
    assert.equal(regionalHolidayPrice(200, 'festival-of-blades', { itemGroup: 'Books' }).price, 200);
    assert.equal(regionalHolidayPrice(200, 'dancing-day', { itemGroup: 'MensClothing' }).price, 100);
    assert.equal(regionalHolidayPrice(200, 'broken-diamonds', { itemGroup: 'Gems' }).price, 100);

    // Shop ledger buyUnit applies regional holiday discounts on Saturalia in Wayrest (region 23, day 355).
    const saturalia = HOLIDAYS.find((x) => x.key === 'saturalia');
    worldMinutes = (saturalia.dayOfYear - 1) * MINUTES_PER_DAY + 12 * 60;
    const econ = createShopEconomy(h.ctx, { describe: () => ({ name: 'Sword', value: 100, group: 'weapon' }) });
    const keeper = { id: 'k1', location: 'interior:23/Wayrest/shop1', sourced: true, shop: 'general', building: { type: 9, quality: 10 } };
    const shop = { building: { type: 9, quality: 10, regionIndex: 23, shelves: [1] } };
    const player = { rpg: { character: { skills: { Mercantile: 50 }, attributes: { Personality: 50 } } } };
    const satPrice = econ.buyUnit(player, keeper, { value: 100, group: 'Books' }, shop);
    const plainCtx = { quality: 10, adjust: priceAdjust(23, worldMinutes), mercantile: 50, personality: 50, holiday: null, guildFaction: null };
    const normalPrice = adjustedBuyPrice(100, 1, plainCtx, 'Books');
    assert.ok(satPrice < normalPrice, `Saturalia price (${satPrice}) should be lower than normal (${normalPrice})`);
  } finally {
    setFactionPowers(new Map());
  }
});

// =========================================================================
// 4. Multi-region court rep & persistent pickpocket memory
// =========================================================================

test('law adjusts court-faction reputation across all Iliac Bay regions and persists pickpocket memory across NPC rebuilds with TTL', () => {
  const repCalls = [];
  const courtByRegion = { 17: 201, 23: 202, 20: 203 }; // Daggerfall, Wayrest, Sentinel
  const h = makeHarness({ now: 200_000 });
  h.ctx.services.regionCourt = (idx) => courtByRegion[idx] ?? null;
  h.ctx.services.adjustReputation = (p, fid, delta) => {
    repCalls.push({ playerId: p.id, fid, delta });
    p.rpg.factions = p.rpg.factions ?? {};
    p.rpg.factions[fid] = (p.rpg.factions[fid] ?? 0) + delta;
  };
  h.ctx.services.createEnemy = (location, id, x, z) => h.ctx.spawnEntity({
    id: `guard:${h.ctx.entities.size + 1}`, kind: 'monster', name: 'City Watch', hp: 50, maxHp: 50,
    dead: false, location, x, z,
  });

  installLaw(h.ctx, { random: () => 0.99, pickpocketMemoryMs: 60_000 });

  assert.equal(h.ctx.services.law.courtFactionFor('Daggerfall'), 201);
  assert.equal(h.ctx.services.law.courtFactionFor('Wayrest'), 202);
  assert.equal(h.ctx.services.law.courtFactionFor('Sentinel'), 203);

  const thief = {
    id: 'thief1', name: 'Shadow', x: 0, y: 0, z: 0, yaw: 0,
    rpg: {
      location: 'town:Wayrest/Wayrest',
      gold: 500,
      character: { level: 3, skills: { Pickpocket: 10, Etiquette: 20, Streetwise: 20 }, attributes: { Personality: 40 } },
    },
  };
  h.join(thief);

  const npc = h.ctx.spawnEntity({ id: 'npc:wayrest:1', kind: 'npc', role: 'townsperson', name: 'Bryn', location: thief.rpg.location, x: 1, z: 0 });

  // Caught pickpocketing in Wayrest opens a charge and records npc:wayrest:1 in p.rpg.law.pickpockets.
  assert.equal(h.act(thief, 'law.pickpocket', { targetId: npc.id }).ok, true);
  assert.ok(Number.isFinite(thief.rpg.law.pickpockets['npc:wayrest:1']));

  // Advance a tick so the guard halts the thief and lowers legal + Wayrest court (202) reputation!
  for (const e of h.ctx.entities.values()) if (e.kind === 'monster') { e.x = 0; e.z = 0; }
  h.tick(0.1);
  assert.equal(thief.rpg.law.rep.Wayrest, -2);
  assert.equal(thief.rpg.factions[202], -1, 'Wayrest court faction (202) reputation lowered');

  // Clear active charge so thief is free to attempt pickpocketing again.
  thief.rpg.law.charge = null;

  // Simulate an NPC population rebuild: despawn old entity object and spawn a brand-new object with the same stable ID.
  h.ctx.despawnEntity(npc.id);
  h.ctx.spawnEntity({ id: 'npc:wayrest:1', kind: 'npc', role: 'townsperson', name: 'Bryn', location: thief.rpg.location, x: 1, z: 0 });
  const retryAfterRebuild = h.act(thief, 'law.pickpocket', { targetId: 'npc:wayrest:1' });
  assert.equal(retryAfterRebuild.ok, false);
  assert.match(retryAfterRebuild.error, /watching you closely/);

  // Simulate a server restart with persisted p.rpg.law: still remembers npc:wayrest:1!
  const h2 = makeHarness({ now: 210_000 });
  h2.ctx.services.regionCourt = (idx) => courtByRegion[idx] ?? null;
  h2.ctx.services.adjustReputation = h.ctx.services.adjustReputation;
  installLaw(h2.ctx, { random: () => 0.01, pickpocketMemoryMs: 60_000 });
  h2.join(thief);
  h2.ctx.spawnEntity({ id: 'npc:wayrest:1', kind: 'npc', role: 'townsperson', name: 'Bryn', location: thief.rpg.location, x: 1, z: 0 });
  const retryAfterRestart = h2.act(thief, 'law.pickpocket', { targetId: 'npc:wayrest:1' });
  assert.equal(retryAfterRestart.ok, false);
  assert.match(retryAfterRestart.error, /watching you closely/);

  // After TTL expires, pickpocketing is allowed again.
  h2.ctx.advance(60_001);
  const afterTtl = h2.act(thief, 'law.pickpocket', { targetId: 'npc:wayrest:1' });
  assert.equal(afterTtl.ok, true);

  // Also verify Sentinel (region 20 -> court faction 203) works when committing a crime there.
  thief.rpg.location = 'town:Sentinel/Sentinel';
  thief.rpg.law.charge = null;
  h.ctx.services.law.commit(thief, 'assault', { location: 'town:Sentinel/Sentinel', witnessed: true });
  for (const e of h.ctx.entities.values()) if (e.kind === 'monster' && e.location === 'town:Sentinel/Sentinel') { e.x = 0; e.z = 0; }
  h.tick(0.1);
  assert.equal(thief.rpg.law.rep.Sentinel, -8);
  assert.equal(thief.rpg.factions[203], -4, 'Sentinel court faction (203) reputation lowered');
});
