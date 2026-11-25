// Package 16: enchantment and artifact power consumers (server/rpg/alchemy/powers.js).
//
// Unit layer: SoulBound forced sets, Item Maker skill entries, affinity and Ring of Namira tables, the
// Hircine Ring lycanthropy rules (conditions model).
// FIXTURE layer: the real runtime with the production character, inventory, alchemy, combat, magic,
// atmosphere and conditions features on a temp SQLite file. Artifacts come from the operator's MAGIC.DEF
// and spells from SPELLS.STD, so these cases skip without gamedata/. Monsters are created through the
// combat owner's createEnemy at FIXTURE positions beside the player; the time of day is the fixture clock.
// Values marked FIXTURE SETUP are set directly to reach a state quickly (low condition, an old recast time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planEnchantment } from '../server/rpg/alchemy.js';
import { FORCED_BY_SOUL, affinityMatches, namiraReflection, HELD_REROLL_MINUTES, creatureGroup } from '../server/rpg/alchemy/powers.js';
import { dateFromMinutes } from '../client/gameplay/atmosphere/calendar.js';
import { successfulHit } from '../server/rpg/combat/formulas.js';
import { classicCastingCost } from '../server/rpg/magic/formulas.js';
import { hearingRadius } from '../client/gameplay/atmosphere/playlists.js';
import { activeDuration } from '../client/gameplay/magic.js';
import { makeItem } from '../server/rpg/inventory.js';
import * as M from '../server/rpg/conditions/model.js';
import { features as production } from '../server/rpg/features.js';
import { createFixtureWorld, readPersisted, tempDir, localArena2 } from './support/rpg-session.mjs';

const ARENA2 = localArena2();
const needData = { skip: ARENA2 ? false : 'operator ARENA2 (MAGIC.DEF, SPELLS.STD) not installed' };

// ---------------------------------------------------------------------------------------------------- unit

test('SoulBound: a Daedra Lord soul forces Potent Vs Daedra, holy-place damage and extra weight', () => {
  const sword = makeItem('daedric-claymore');
  const plan = planEnchantment(sword, [{ type: 15, param: 31 }], { soulAvailable: (id) => id === 31 });
  assert.deepEqual(plan.list.map((o) => [o.type, o.param]), [[15, 31], [4, 1], [17, 1], [23, -1]]);
  assert.deepEqual(plan.list.filter((o) => o.forced === 31).length, 3, 'three forced entries');
  // Costs: soul -8000, Potent Vs Daedra +900 (a power, so it is paid for), holy damage -1000, extra weight -100.
  assert.equal(plan.cost, -8000 + 900 - 1000 - 100);
  assert.equal(plan.gold, 9000);
  assert.deepEqual(plan.powers.map((o) => o.type).sort((a, b) => a - b), [4, 15]);
  // Forced entries count toward the ten-enchantment limit.
  const nine = [{ type: 15, param: 31 }, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ type: 10, param: k }))];
  assert.throws(() => planEnchantment(sword, nine, { soulAvailable: () => true }), /at most 10/);
  // A chosen enchantment the soul would force is not duplicated; an exclusive one is refused.
  const dup = planEnchantment(sword, [{ type: 17, param: 1 }, { type: 15, param: 31 }], { soulAvailable: () => true });
  assert.equal(dup.list.filter((o) => o.type === 17).length, 1);
  assert.throws(() => planEnchantment(sword, [{ type: 20, param: 1 }, { type: 15, param: 31 }], { soulAvailable: () => true }), /same creatures/);
  // Every classic forced set resolves to offered enchantments.
  for (const [soul, set] of Object.entries(FORCED_BY_SOUL)) {
    const p = planEnchantment(makeItem('daedric-claymore'), [{ type: 15, param: Number(soul) }], { soulAvailable: () => true });
    assert.equal(p.list.length, 1 + set.length, `soul ${soul}`);
  }
});

test('Item Maker offers Enhances Skill for each of the 35 skills at 900 points', () => {
  const p = planEnchantment(makeItem('daedric-claymore'), [{ type: 10, param: 29 }]);
  assert.deepEqual([p.list[0].param, p.cost], [29, 900]);
  assert.throws(() => planEnchantment(makeItem('daedric-claymore'), [{ type: 10, param: 35 }]), /not offered/);
});

test('Potent Vs follows MobileAffinity; the Ring of Namira returns damage by team', () => {
  const skeleton = { kind: 'monster', affinity: 'undead', _m: { id: 15, affinity: 'undead' } };
  const knight = { kind: 'monster', affinity: 'human', _m: { id: 136, human: true } };
  const rat = { kind: 'monster', affinity: 'animal', _m: { id: 0, affinity: 'animal' } };
  assert.ok(affinityMatches(skeleton, 0) && !affinityMatches(skeleton, 2));
  assert.ok(affinityMatches(knight, 2), 'class enemies are Human');
  assert.ok(affinityMatches(rat, 3));
  assert.deepEqual([namiraReflection(0, 6), namiraReflection(26, 7), namiraReflection(17, 6), namiraReflection(7, 6)], [0, 3, 12, 6]);
});

test("Hircine's Ring: no full-moon change, no urge to kill, no once-a-day limit", () => {
  const st = M.normalize({ conditions: { time: 10 * 1440, lycanthrope: { form: 'werewolf', transformed: false, lastMorph: 0, lastKill: 0 } } }, 10 * 1440);
  assert.ok(M.healthLimit(st, 100) < 100, 'the urge lowers max health without the ring');
  assert.equal(M.healthLimit(st, 100, { hircine: true }), null);
  st.lycanthrope.lastMorph = st.time - 5;
  assert.equal(M.morph(st).ok, false, 'once a day without the ring');
  assert.equal(M.morph(st, { hircine: true }).ok, true);
  M.morph(st, { hircine: true }); // back to normal form
  const env = { rng: () => 0.5, sunMinutes: 0, fullMoon: true, maxHealth: 100 };
  M.advance(st, 1, { ...env, hircine: true });
  assert.equal(st.lycanthrope.transformed, false, 'the full moon does not force the change');
  M.advance(st, 1, env);
  assert.equal(st.lycanthrope.transformed, true);
});

// ---------------------------------------------------------------------------------------------------- fixture

const NAMES = ['character', 'inventory', 'alchemy', 'combat', 'magic', 'atmosphere', 'conditions'];

async function fixture(t) {
  const tmp = tempDir('dfw-powers-');
  t.after(() => tmp.remove());
  const dbPath = join(tmp.dir, 'game.db');
  const extra = [{
    name: 'fixture-holy',
    // FIXTURE: holy ground is decided by the temple owner; this stand-in marks a test flag as holy.
    install: (ctx) => { ctx.services.isHolyPlace = (p) => !!p.fixtureHoly; },
  }];
  const world = await createFixtureWorld({ dbPath, features: [...production.filter((f) => NAMES.includes(f.name)), ...extra], dataPath: ARENA2 });
  t.after(() => world.close());
  assert.deepEqual(world.installErrors, []);
  const s = world.ctx.services;
  const connect = (acct = 'acct-1', name = 'Wielder') => world.connect(acct, name);
  const round = (n = 1) => { for (let i = 0; i < n; i++) world.tick(5000); };
  return { world, dbPath, s, connect, round };
}
const held = (s, p, id) => s.itemEffects(p, id);
const item = (p, id) => p.rpg.inventory.find((i) => i.id === id);

test("Cast When Held: equip casts once, never duplicates, survives a restart, recasts free, ends on unequip and break", needData, async (t) => {
  const { world, dbPath, s, connect, round } = await fixture(t);
  let c = connect();
  let p = c.player;
  const ring = s.giveItem(p, 'artifact-warlocks-ring', 1); // CastWhenHeld 86 Feet of Notorgo, CastWhenUsed 64 / 30
  const full = ring.condition;
  // Classic equip charge (FormulaHelper.CalculateCastingCost(spell, false)): Feet of Notorgo is one Fortify Speed
  // effect (type 9/6, coefficients 7/25/10/30, settings type 6; duration 5+1/1, magnitude 1-10 + 3-3/1) cast on
  // self: 7*5 + 25*1/1 + 5*10 + 30/1*3 = 200 points, scaled by the wearer's live Restoration.
  const restoration = s.skillValue(p, 'Restoration');
  const cost = Math.max(5, Math.trunc(200 * (110 - restoration) / 100));
  assert.equal(s.heldSpellCharge(p, 86), cost, 'hand-derived classic cost');
  c.must('inventory.equip', { itemId: ring.id });
  assert.match(ring.equipped, /^ring[01]$/, 'rings go on a ring slot');
  assert.equal(held(s, p, ring.id).length, 1, 'Feet of Notorgo is active');
  assert.equal(ring.condition, full - cost, 'equipping pays the casting cost from the charges');
  const speed = s.effectiveAttribute(p, 'Speed');
  assert.ok(speed > p.rpg.character.attributes.Speed, 'the held Fortify Speed counts');
  // Rounds keep exactly one bundle; it never expires while worn; durability drops 1 per 4 rounds.
  round(8);
  assert.equal(held(s, p, ring.id).length, 1);
  assert.equal(item(p, ring.id).condition, full - cost - 2);
  // Re-sync and re-equip in place do not re-pay or stack.
  s.syncHeldEnchantments(p);
  assert.match(c.act('inventory.equip', { itemId: ring.id }).ok ? 'ok' : 'no', /ok/);
  assert.equal(held(s, p, ring.id).length, 1);
  assert.equal(item(p, ring.id).condition, full - cost - 2);
  // Restart while worn: the bundle and the charges are what they were.
  const id = ring.id;
  const firstEffectId = held(s, p, id)[0].uid;
  world.restart();
  c = connect();
  p = c.player;
  assert.equal(item(p, id).equipped !== undefined, true, 'still worn after restart');
  assert.equal(held(s, p, id).length, 1, 'no duplicate after restart');
  assert.equal(held(s, p, id)[0].uid, firstEffectId);
  assert.equal(item(p, id).condition, full - cost - 2, 'no second charge after restart');
  // Six game hours later the spell is recast for free (EntityEffectManager reroll).
  item(p, id).magic.held.at -= HELD_REROLL_MINUTES; // FIXTURE SETUP: an old cast time
  const stale = item(p, id).magic.held.at;
  round(1);
  assert.ok(item(p, id).magic.held.at >= stale + HELD_REROLL_MINUTES, 'recast');
  assert.equal(held(s, p, id).length, 1);
  assert.notEqual(held(s, p, id)[0].uid, firstEffectId, 'the new cast gets a fresh effect id across restart');
  assert.equal(item(p, id).condition, full - cost - 2, 'the reroll is free (the round did not reach the 4th)');
  // Unequip: the effect ends at once, nothing lingers, and the next equip pays again.
  c.must('inventory.unequip', { itemId: id });
  assert.equal(held(s, p, id).length, 0);
  assert.equal(item(p, id).magic.held, undefined);
  assert.equal(s.effectiveAttribute(p, 'Speed'), speed - (speed - p.rpg.character.attributes.Speed));
  world.restart();
  c = connect();
  p = c.player;
  assert.equal(held(s, p, id).length, 0, 'no bundle comes back after a restart');
  const persisted = readPersisted(dbPath, p.id).rpg;
  assert.equal(persisted.magic.active.filter((a) => a.bundleType === 'held').length, 0);
  // Break: a nearly spent ring breaks on the next durability step and takes its bundle with it.
  c.must('inventory.equip', { itemId: id });
  assert.equal(held(s, p, id).length, 1);
  item(p, id).condition = 1; // FIXTURE SETUP: one charge left
  round(4);
  assert.equal(item(p, id), undefined, 'a spent magic item is destroyed');
  assert.equal(held(s, p).length, 0, 'no lingering effect after it breaks');
});

test('held armour, skill and absorption modifiers apply only while worn and never stack', needData, async (t) => {
  const { s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const mail = s.giveItem(p, 'artifact-ebony-mail', 1); // StrengthensArmor
  const shield = s.giveItem(p, 'artifact-auriels-shield', 1); // StrengthensArmor + CastWhenHeld 46
  const blade = s.giveItem(p, 'artifact-chrysamere', 1); // EnhancesSkill 29 (Long Blade)
  const amulet = s.giveItem(p, 'artifact-necromancers-amulet', 1); // AbsorbsSpells
  const long = s.skillValue(p, 'Long Blade');
  for (const it of [mail, shield, blade, amulet]) c.must('inventory.equip', { itemId: it.id });
  const m = s.enchantmentModifiers(p);
  assert.equal(m.armor, 5, 'two Strengthens Armor items give one -5 armour modifier');
  assert.equal(m.absorbSpells, true);
  assert.equal(s.skillValue(p, 'Long Blade'), long + 15);
  assert.equal(amulet.equipped, 'amulet0');
  // Weakens Armor cancels; unequipping removes everything.
  const cursed = s.giveItem(p, 'iron-helm', 1, { extra: { magic: { enchantments: [{ type: 24, param: -1 }], identified: true, name: 'Rusted Helm' } } });
  c.must('inventory.equip', { itemId: cursed.id });
  assert.equal(s.enchantmentModifiers(p).armor, 0);
  for (const it of [mail, shield, blade, amulet, cursed]) if (it.equipped) c.must('inventory.unequip', { itemId: it.id });
  const off = s.enchantmentModifiers(p);
  assert.deepEqual([off.armor, off.absorbSpells, s.skillValue(p, 'Long Blade')], [0, false, long]);
  assert.equal(s.itemEffects(p).length, 0, "Auriel's Shield bundle ended with the shield");
});

test('regeneration, user damage and decay follow sunlight, darkness and holy places', needData, async (t) => {
  const { s, connect, round } = await fixture(t);
  const c = connect();
  const p = c.player;
  const ch = p.rpg.character;
  const give = (name, enchantments, template = 'iron-helm') => s.giveItem(p, template, 1, { extra: { magic: { enchantments, identified: true, name } } });
  /** Health gained over four magic rounds from a wounded start, natural regeneration included. */
  const gain = () => { ch.health = ch.maxHealth - 20; const h = ch.health; round(4); return ch.health - h; }; // FIXTURE SETUP: wounded
  assert.equal(s.worldClock().isNight, false, 'fixture clock: daytime');
  const natural = gain();
  const dark = give('Night Band', [{ type: 5, param: 2 }], 'ring'); // RegensHealth in darkness
  const sun = give('Sun Band', [{ type: 5, param: 1 }], 'ring'); // RegensHealth in sunlight
  c.must('inventory.equip', { itemId: dark.id });
  c.must('inventory.equip', { itemId: sun.id });
  assert.equal(gain(), natural + 1, 'one point per four rounds, once, even with two matching rings');
  c.must('inventory.unequip', { itemId: sun.id });
  assert.equal(gain(), natural, 'outdoors by day the darkness ring does nothing');
  p.rpg.location = 'interior:Daggerfall/Daggerfall/1,2/0'; // FIXTURE SETUP: indoors (no sunlight)
  const indoors = gain();
  c.must('inventory.unequip', { itemId: dark.id });
  assert.equal(indoors, gain() + 1, 'indoors the darkness ring regenerates');
  // Holy places: User Takes Damage and Item Deteriorates (the Daedra Seducer side effects).
  const cursed = give('Seducer Helm', [{ type: 17, param: 1 }, { type: 16, param: 2 }]);
  c.must('inventory.equip', { itemId: cursed.id });
  const cond = cursed.condition;
  const plain = gain();
  assert.equal(cursed.condition, cond, 'not holy: no decay');
  p.fixtureHoly = true;
  assert.equal(gain(), plain - 1, 'holy ground: one point of damage per four rounds');
  assert.equal(cursed.condition, cond - 1, 'holy ground: one point of decay');
  p.fixtureHoly = false;
  // Repairs Objects mends one damaged ordinary item, never an enchanted one.
  const fixer = give('Mender', [{ type: 8, param: -1 }], 'ring');
  c.must('inventory.equip', { itemId: fixer.id });
  const dagger = p.rpg.inventory.find((i) => i.template === 'steel-dagger');
  dagger.condition -= 5; // FIXTURE SETUP: worn dagger
  const before = dagger.condition;
  round(4);
  assert.equal(dagger.condition, before + 1);
  assert.equal(cursed.condition, cond - 1, 'the enchanted helm is not repaired');
});

test("Daedric strikes through combat: Potent Vs, Mehrunes' Razor, Wabbajack, Mace of Molag Bal", needData, async (t) => {
  const { world, s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const loc = p.rpg.location;
  const foe = (id) => s.createEnemy(loc, id, p.x, p.z - 1.2, { yaw: Math.PI }); // FIXTURE position: in reach, ahead (yaw 0 faces -z)
  // Potent Vs Undead on a real weapon, through the strike service combat calls on every landed hit.
  const sword = s.giveItem(p, 'steel-longsword', 1, { extra: { magic: { enchantments: [{ type: 4, param: 0 }, { type: 20, param: 3 }], identified: true, name: 'Bane' } } });
  c.must('inventory.equip', { itemId: sword.id });
  const skel = foe(15);
  const rat = foe(0);
  assert.equal(s.enchantmentStrike(p, skel, { itemId: sword.id, damage: 4 }).damage, 9);
  assert.equal(s.enchantmentStrike(p, rat, { itemId: sword.id, damage: 4 }).damage, -1, 'Low Damage Vs Animals');
  s.banishMonster(skel);
  s.banishMonster(rat);
  // Mehrunes' Razor through combat.attack: a failed save slays outright and wears the blade by the health removed.
  const razor = s.giveItem(p, 'artifact-mehrunes-razor', 1);
  c.must('inventory.equip', { itemId: razor.id });
  p.yaw = 0;
  const giant = foe(16);
  const hp0 = giant.hp;
  c.must('combat.ready', { ready: true });
  let landed = false;
  for (let i = 0; i < 40 && !giant.dead; i++) {
    p.rpg.character.health = p.rpg.character.maxHealth; // FIXTURE SETUP: the level-1 wielder outlasts the giant
    const r = c.act('combat.attack', { targetId: giant.id, direction: 'right' });
    for (let k = 0; k < 4; k++) { p.rpg.character.health = p.rpg.character.maxHealth; world.tick(300); }
    if (giant.hp < hp0 || giant.dead) landed = true;
    if (!r.ok && !/recovering/.test(r.error)) throw new Error(r.error);
  }
  assert.ok(landed, 'a swing landed');
  assert.ok(giant.dead, 'the giant was slain');
  assert.ok(c.events('alchemy').some((e) => /Mehrunes' Razor slays/.test(e.text)), 'by the Razor power, not by wear and tear');
  assert.ok(item(p, razor.id).condition < item(p, razor.id).maxCondition - 1, 'worn by the health it removed');
  // Wabbajack: a hit that does not kill turns the creature into another one, carrying the damage, once.
  const staff = s.giveItem(p, 'artifact-wabbajack', 1);
  c.must('inventory.equip', { itemId: staff.id });
  const ogre = foe(16);
  ogre.hp -= 10; // FIXTURE SETUP: earlier damage
  const strike = s.enchantmentStrike(p, ogre, { itemId: staff.id, damage: 3 });
  strike.after({ killed: false, damage: 3 });
  assert.equal(world.ctx.entities.get(ogre.id), undefined, 'the giant is gone');
  const changed = [...world.ctx.entities.values()].find((e) => e._wabbajack);
  assert.ok(changed && changed._m.id !== 16, `became ${changed?.name}`);
  assert.equal(changed.hp, Math.max(1, changed.maxHp - 10));
  s.enchantmentStrike(p, changed, { itemId: staff.id, damage: 3 })?.after({ killed: false });
  assert.ok(world.ctx.entities.get(changed.id), 'a Wabbajacked creature is not changed again');
  // Mace of Molag Bal: drained Strength moves to the wielder for 12 minutes, then fades.
  const mace = s.giveItem(p, 'artifact-mace-of-molag-bal', 1);
  c.must('inventory.equip', { itemId: mace.id });
  const str = s.effectiveAttribute(p, 'Strength');
  const zombie = foe(17);
  const save = s.magicSavingThrow;
  s.magicSavingThrow = () => 100; // FIXTURE: the creature fails its save this time
  try { s.enchantmentStrike(p, zombie, { itemId: mace.id, damage: 5 }).after({ killed: false }); } finally { s.magicSavingThrow = save; }
  assert.ok(s.effectiveAttribute(p, 'Strength') > str, 'Strength drained into the wielder');
  item(p, mace.id).magic.lastStrike -= 13; // FIXTURE SETUP: thirteen minutes later
  world.tick(5000);
  assert.equal(s.effectiveAttribute(p, 'Strength'), str, 'the borrowed Strength fades');
});

test('Ring of Namira, Masque of Clavicus, Sanguine Rose and Skull of Corruption', needData, async (t) => {
  const { world, s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const loc = p.rpg.location;
  const ring = s.giveItem(p, 'artifact-ring-of-namira', 1);
  c.must('inventory.equip', { itemId: ring.id });
  const undead = s.createEnemy(loc, 15, p.x + 1, p.z, {});
  const hp = undead.hp;
  assert.equal(s.enchantmentStruck(p, undead, 4), Math.min(8, hp), 'undead take double');
  const rat = s.createEnemy(loc, 0, p.x + 1, p.z, {});
  assert.equal(s.enchantmentStruck(p, rat, 4), 0, 'vermin take nothing back');
  c.must('inventory.unequip', { itemId: ring.id });
  assert.equal(s.enchantmentStruck(p, undead, 4), 0, 'only while worn');
  // Masque: Personality / 5 to every social group while worn.
  const masque = s.giveItem(p, 'artifact-masque-of-clavicus', 1);
  assert.equal(s.socialReactionModifier(p, 'nobility'), 0);
  c.must('inventory.equip', { itemId: masque.id });
  const per = s.effectiveAttribute(p, 'Personality');
  for (const g of ['commoners', 'merchants', 'learned', 'nobility', 'underworld']) assert.equal(s.socialReactionModifier(p, g), Math.trunc(per / 5));
  c.must('inventory.unequip', { itemId: masque.id });
  assert.equal(s.socialReactionModifier(p, 'nobility'), 0);
  // Rose and Skull need a hostile monster within 12 m; the call is free when none is near.
  for (const e of s.monstersIn(loc)) s.banishMonster(e);
  const rose = s.giveItem(p, 'artifact-sanguine-rose', 1);
  const skull = s.giveItem(p, 'artifact-skull-of-corruption', 1);
  c.must('inventory.use', { itemId: rose.id });
  assert.match(c.events('inventory').at(-1).text, /no monsters nearby/);
  assert.equal(item(p, rose.id).condition, item(p, rose.id).maxCondition);
  const orc = s.createEnemy(loc, 7, p.x + 4, p.z, {});
  c.must('inventory.use', { itemId: rose.id });
  const daedroth = s.monstersIn(loc).find((e) => e._m.id === 27);
  assert.ok(daedroth && daedroth.hostile === false && daedroth._ally === p.id, 'an allied Daedroth');
  assert.equal(item(p, rose.id).condition, item(p, rose.id).maxCondition - 100);
  c.must('inventory.use', { itemId: skull.id }); // the amulet is used, not equipped
  assert.equal(item(p, skull.id).equipped, undefined);
  const copy = s.monstersIn(loc).filter((e) => e._m.id === orc._m.id && e._ally === p.id);
  assert.equal(copy.length, 1, 'an allied copy of the nearest enemy');
  world.tick(250);
});

test('Oghma Infinium: 30 unspent points survive normalization and restart at level 1, then spend', needData, async (t) => {
  const { world, dbPath, s, connect } = await fixture(t);
  let c = connect('acct-o', 'Reader');
  let p = c.player;
  assert.equal(p.rpg.character.level, 1);
  const book = s.giveItem(p, 'artifact-oghma-infinium', 1);
  c.must('inventory.use', { itemId: book.id });
  assert.equal(p.rpg.character.bonusPoints, 30);
  world.restart();
  c = connect('acct-o', 'Reader');
  p = c.player;
  assert.equal(p.rpg.character.bonusPoints, 30, 'kept by normalization at level 1');
  assert.equal(readPersisted(dbPath, p.id).rpg.character.oghmaBonus, 30);
  const next = { ...p.rpg.character.attributes };
  next.Strength += 15; next.Luck += 15;
  c.must('character.levelUp', { attributes: next });
  assert.deepEqual([p.rpg.character.bonusPoints, p.rpg.character.oghmaBonus], [0, 0]);
  world.restart();
  c = connect('acct-o', 'Reader');
  assert.equal(c.player.rpg.character.attributes.Strength, next.Strength);
  assert.equal(c.player.rpg.character.bonusPoints, 0, 'no second award');
});

test('SoulBound: the bound creature appears when the item breaks', needData, async (t) => {
  const { world, s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const axe = s.giveItem(p, 'iron-war-axe', 1, { extra: { magic: { enchantments: [{ type: 15, param: 17 }, { type: 4, param: 0 }], identified: true, name: 'Grave Axe' } } });
  c.must('inventory.equip', { itemId: axe.id });
  axe.condition = 1; // FIXTURE SETUP: about to break
  s.damageItem(p, axe.id, 1);
  const zombie = [...world.ctx.entities.values()].find((e) => e.kind === 'monster' && e._m?.id === 17);
  assert.ok(zombie, 'a Zombie is released');
  assert.ok(c.events('alchemy').some((e) => /is released/.test(e.text)));
});

test('every artifact: required MAGIC.DEF effects have a consumer', needData, async (t) => {
  const { s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  // Consumer per enchantment type (server/rpg/alchemy/powers.js unless noted).
  const HANDLED = new Set([0, 1, 2, 4, 5, 8, 9, 10, 12, 20]);
  const SPECIALS = { 0: 'masque', 1: 'razor', 2: 'mace', 3: 'hircine', 4: 'rose', 5: 'oghma', 6: 'wabbajack', 7: 'namira', 8: 'skull', 9: 'azura' };
  const rows = [];
  for (let i = 0; i < 23; i++) {
    const key = s.artifactTemplate(i);
    const info = s.artifactInfo(key);
    assert.ok(info.available, key);
    const it = s.giveItem(p, key, 1);
    const missing = info.enchantments.filter((e) => !(HANDLED.has(e.type) || (e.type === 26 && SPECIALS[e.param])));
    rows.push([key, info.enchantments.map((e) => `${e.type}:${e.param}`).join(' '), missing.length]);
    assert.deepEqual(missing, [], `${key} has an unhandled power`);
    if (it.group !== 'book' && it.group !== 'ingredient' && it.group !== 'plant' && s.describeItem(it.template)) {
      const r = c.act('inventory.equip', { itemId: it.id });
      if (r.ok) c.must('inventory.unequip', { itemId: it.id });
    }
    if (it && p.rpg.inventory.includes(it)) s.takeItem(p, it.id, 1, { allowEquipped: true });
  }
  assert.equal(rows.length, 23);
  assert.equal(s.itemEffects(p).length, 0, 'no bundle left after equipping and removing every artifact');
});

// ------------------------------------------------------------------------- Item Maker powers (remaining consumers)

/** FIXTURE: a Mages Guild Item Maker beside the player, and rank 5 (no guilds feature in this world). */
function itemMaker(world, s, p) {
  s.guildRank = () => 5;
  const e = { id: 'npc-fixture-maker', kind: 'npc', name: 'Fixture Enchanter', location: p.rpg.location, x: p.x + 1, z: p.z, yaw: 0,
    services: ['makeItems'], guild: 'mages', faction: 40, quality: 10 };
  world.ctx.entities.set(e.id, e);
  return e;
}
/** The game minute powers.js reads (personal calendar, else the world clock). */
const minuteOf = (s, p) => Math.floor(s.playerMinutes?.(p) ?? s.worldClock().minutes);
const enchant = (c, maker, template, enchantments, name) => {
  const p = c.player;
  p.rpg.gold = 200_000; // FIXTURE SETUP: enough gold for any order
  const base = c.player.rpg.inventory.find((i) => i.template === template && !i.magic && !i.equipped)
    ?? c.world.ctx.services.giveItem(p, template, 1);
  c.must('alchemy.enchant', { targetId: maker.id, itemId: base.id, enchantments, name });
  return p.rpg.inventory.find((i) => i.name === name);
};

test('Vampiric Effect and Health Leech: made at the Item Maker, then drained, healed and leeched in play', needData, async (t) => {
  const { world, dbPath, s, connect, round } = await fixture(t);
  let c = connect();
  let p = c.player;
  const ch = () => p.rpg.character;
  const maker = itemMaker(world, s, p);
  // Vampiric when strikes + Health Leech whenever used (1000 - 4000 points) on the starting dagger.
  const fang = enchant(c, maker, 'steel-dagger', [{ type: 6, param: 1 }, { type: 21, param: 0 }], 'Thirsty Fang');
  assert.deepEqual(fang.magic.enchantments, [{ type: 6, param: 1 }, { type: 21, param: 0 }]);
  assert.equal(fang.magic.leechAt, minuteOf(s, p), 'the Enchanted payload starts the leech clock');
  c.must('inventory.equip', { itemId: fang.id });
  const loc = p.rpg.location;
  const rat = s.createEnemy(loc, 0, p.x, p.z - 1.2, { yaw: Math.PI });
  // A strike that lands: the wielder gains the strike's damage and loses 8 to the leech (net -2 for 6 damage).
  ch().health = ch().maxHealth - 30; // FIXTURE SETUP: wounded
  let h = ch().health;
  const strike = s.enchantmentStrike(p, rat, { itemId: fang.id, damage: 6 });
  assert.equal(strike.damage, 6, 'neither power changes the damage');
  strike.after({ killed: false, damage: 6 });
  assert.equal(ch().health, h + 6 - 8);
  // A real swing through combat.attack: hit or miss, the swing reaches the rat and the leech takes 8.
  p.yaw = 0;
  c.must('combat.ready', { ready: true });
  fang.magic.leechAt -= 60; // FIXTURE SETUP: an hour since the last use
  h = ch().health;
  const ratHp = rat.hp;
  c.must('combat.attack', { targetId: rat.id, direction: 'right' });
  const landed = rat.hp < ratHp || rat.dead;
  assert.equal(item(p, fang.id).magic.leechAt, minuteOf(s, p), 'the strike restarts the clock');
  if (landed) assert.ok(ch().health > h - 8, 'a landed swing heals some of the leech back');
  else assert.equal(ch().health, h - 8, 'a missed swing still leeches 8');
  // Vampiric at range + Health Leech unless used daily on a claymore (2000 - 500 points).
  const claymore = s.giveItem(p, 'daedric-claymore', 1);
  const thirst = enchant(c, maker, 'daedric-claymore', [{ type: 6, param: 0 }, { type: 21, param: 1 }], 'Night Thirst');
  assert.equal(thirst.id, claymore.id);
  c.must('inventory.unequip', { itemId: fang.id });
  c.must('inventory.equip', { itemId: thirst.id });
  for (const e of s.monstersIn(loc)) s.banishMonster(e);
  const near = s.createEnemy(loc, 7, p.x + 2, p.z, {}); // 2 m: inside the 2.25 m drain range
  const far = s.createEnemy(loc, 7, p.x + 4, p.z, {});
  near.hostile = far.hostile = false; // FIXTURE SETUP: keep the orcs from swinging during the rounds
  ch().health = ch().maxHealth - 30;
  const [nearHp, farHp] = [near.hp, far.hp];
  const before = ch().health;
  round(4);
  assert.equal(near.hp, nearHp - 1, 'one point drained from the orc in reach');
  assert.equal(far.hp, farHp, 'nothing from the orc 4 m away');
  assert.ok(ch().health >= before + 1, 'the wearer gains it');
  // Daily leech: nothing while used within a day, 1 HP per 4 rounds once a day passes unused.
  const steady = () => { ch().health = ch().maxHealth - 30; const x = ch().health; round(4); return ch().health - x; };
  s.banishMonster(near);
  const used = steady();
  thirst.magic.leechAt -= 1441; // FIXTURE SETUP: a day and a minute unused
  assert.equal(steady(), used - 1, 'a day unused: one point every four rounds');
  // The leech clock is saved with the item.
  const id = thirst.id;
  const clock = thirst.magic.leechAt;
  world.restart();
  c = connect();
  p = c.player;
  assert.equal(item(p, id).magic.leechAt, clock);
  assert.equal(readPersisted(dbPath, p.id).rpg.inventory.find((i) => i.id === id).magic.leechAt, clock);
});

test('Health Leech whenever used: casting from the item costs 16 health; old items start their clock on first sight', needData, async (t) => {
  const { world, s, connect, round } = await fixture(t);
  const c = connect();
  const p = c.player;
  const maker = itemMaker(world, s, p);
  // Cast When Used Heal (64) with a leech side effect pays for itself on a dagger.
  const wand = enchant(c, maker, 'steel-dagger', [{ type: 0, param: 64 }, { type: 21, param: 0 }], 'Blood Price');
  assert.ok(s.enemySpellInfo(64), 'Heal is in SPELLS.STD');
  // FIXTURE SETUP: one point short, so any Heal roll fills health and the leech is the only loss left.
  p.rpg.character.health = p.rpg.character.maxHealth - 1;
  c.must('inventory.use', { itemId: wand.id });
  assert.equal(p.rpg.character.health, p.rpg.character.maxHealth - 16, 'healed to full, then leeched 16');
  assert.equal(wand.magic.leechAt, minuteOf(s, p));
  // The same cast from an item without the leech leaves the wielder at full health.
  const plain = enchant(c, maker, 'steel-dagger', [{ type: 0, param: 64 }, { type: 16, param: 2 }], 'Clean Price');
  p.rpg.character.health = p.rpg.character.maxHealth - 1;
  c.must('inventory.use', { itemId: plain.id });
  assert.equal(p.rpg.character.health, p.rpg.character.maxHealth);
  // An item enchanted before the leech clock existed (no leechAt) starts counting when first worn, not at minute 0.
  const legacy = s.giveItem(p, 'ring', 1, { extra: { magic: { enchantments: [{ type: 21, param: 2 }], identified: true, name: 'Old Band' } } });
  assert.equal(legacy.magic.leechAt, undefined);
  c.must('inventory.equip', { itemId: legacy.id });
  const m0 = minuteOf(s, p);
  const hp = p.rpg.character.health = p.rpg.character.maxHealth - 30;
  round(4);
  assert.ok(legacy.magic.leechAt >= m0 && legacy.magic.leechAt <= minuteOf(s, p), 'clock starts on first sight');
  assert.ok(p.rpg.character.health >= hp, 'no weekly leech on the first day');
});

test('unit: classic casting cost floor and range, creature groups, to-hit modifiers, improved hearing, held label', () => {
  // FormulaHelper.CalculateCastingCost: Item Maker skill 50, range modifier (x3 >> 1 for a single target at range).
  const fireball = { rangeType: 2, effects: [{ type: 4, subType: 0, durationBase: 0, durationMod: 0, durationPerLevel: 1, chanceBase: 0, chanceMod: 0,
    chancePerLevel: 1, magnitudeBaseLow: 1, magnitudeBaseHigh: 10, magnitudeLevelBase: 1, magnitudeLevelHigh: 10, magnitudePerLevel: 1 }] };
  // Damage Health: index 7 -> [5, 7, 0, 0], settings type 5: 5*((10+1)/2) + (1+10)/2/1*7 = 25 + 35 = 60; *(110-50)/100 = 36; *3>>1 = 54.
  assert.equal(classicCastingCost(fireball), 54);
  assert.equal(classicCastingCost({ rangeType: 0, effects: [{ ...fireball.effects[0], magnitudeBaseLow: 0, magnitudeBaseHigh: 0, magnitudeLevelBase: 0, magnitudeLevelHigh: 0 }] }), 5, '5 point floor');
  // PlayerGPS groups (EnemyGroups by monster career); class enemies and walking civilians are Humanoid.
  assert.deepEqual([0, 1, 15, 27, 35, 41].map((id) => creatureGroup({ kind: 'monster', _m: { id } })), ['animal', 'human', 'undead', 'daedra', null, 'human']);
  assert.equal(creatureGroup({ kind: 'monster', _m: { id: 128, human: true } }), 'human');
  assert.equal(creatureGroup({ kind: 'npc', mobile: true }), 'human');
  assert.equal(creatureGroup({ kind: 'npc' }), null, 'building residents are not mobile civilians');
  // CalculateSuccessfulHit: the attacker's ChanceToHitModifier and the target's adrenaline lower the chance.
  const view = { agility: 50, luck: 50, criticalStrike: 0, dodging: 0, armor: Array(7).fill(100), monster: false }; // a 50% base chance
  const chance = (attacker, target) => { let n = 0; for (let r = 0; r < 100; r++) if (successfulHit(attacker, target, 0, 0, () => r / 100)) n++; return n; };
  assert.equal(chance({ ...view, chanceToHit: -5 }, view), chance(view, view) - 5);
  assert.equal(chance(view, { ...view, adrenaline: 8 }), chance(view, view) - 8);
  // DaggerfallEnemy hearing: x1.25 with Acute Hearing, x1.5 with the improved talent, nothing without the advantage.
  assert.deepEqual([hearingRadius([]), hearingRadius(['acuteHearing']), hearingRadius(['acuteHearing'], ['acuteHearing']), hearingRadius([], ['acuteHearing'])], [16, 20, 24, 16]);
  assert.equal(activeDuration({ bundleType: 'held', source: { itemId: 'x', itemName: "Warlock's Ring" }, roundsLeft: 1 }), "while Warlock's Ring is worn");
  assert.equal(activeDuration({ roundsLeft: 3 }), '3 rounds');
});

test('Extra Spell Points, Improves Talents and Bad Reactions From follow the season and nearby creatures', needData, async (t) => {
  const { world, s, connect, round } = await fixture(t);
  const c = connect();
  const p = c.player;
  const ch = p.rpg.character;
  const maker = itemMaker(world, s, p);
  const loc = p.rpg.location;
  for (const e of s.monstersIn(loc)) s.banishMonster(e);
  for (const e of [...world.ctx.entities.values()]) if (e.kind === 'npc' && e.mobile) world.ctx.entities.delete(e.id); // FIXTURE: no passers-by
  const base = ch.maxMagicka;
  // Extra Spell Points during the current season (+75) and during another season (nothing).
  const season = ['Winter', 'Spring', 'Summer', 'Fall'].indexOf(dateFromMinutes(minuteOf(s, p)).season);
  const ring = enchant(c, maker, 'ring', [{ type: 3, param: season }, { type: 3, param: (season + 1) % 4 }], 'Season Band');
  c.must('inventory.equip', { itemId: ring.id });
  assert.equal(ch.maxMagicka, base + 75, 'one +75 for the matching season');
  // Near Undead: a skeleton inside 18 m adds another 75 while it is there.
  const amulet = enchant(c, maker, 'amulet', [{ type: 3, param: 7 }], 'Grave Charm');
  c.must('inventory.equip', { itemId: amulet.id });
  assert.equal(ch.maxMagicka, base + 75, 'no undead yet');
  const skel = s.createEnemy(loc, 15, p.x + 10, p.z, {});
  skel.hostile = false; // FIXTURE SETUP: stands still
  world.tick(1000);
  assert.equal(ch.maxMagicka, base + 150, 'skeleton at 10 m');
  skel.x = p.x + 20;
  world.tick(1000);
  assert.equal(ch.maxMagicka, base + 75, 'skeleton at 20 m');
  s.banishMonster(skel); // it would wander back to its spawn point
  ch.magicka = ch.maxMagicka;
  c.must('inventory.unequip', { itemId: ring.id });
  assert.equal(ch.maxMagicka, base);
  assert.equal(ch.magicka, base, 'spell points above the plain maximum are lost with the item');
  // Bad Reactions From Humanoids: -5 to hit while one is within 8 m; armour is unchanged.
  const hood = enchant(c, maker, 'leather-helm', [{ type: 22, param: 0 }, { type: 10, param: 18 }], 'Glaring Hood');
  c.must('inventory.equip', { itemId: hood.id });
  assert.equal(s.enchantmentChanceToHit(p), 0, 'nobody near');
  const orc = s.createEnemy(loc, 7, p.x + 5, p.z, {});
  orc.hostile = false;
  assert.equal(s.enchantmentChanceToHit(p), -5, 'an orc at 5 m');
  assert.equal(s.enchantmentModifiers(p).armor, 0, 'the armour part is a no-op in the reference');
  orc.x = p.x + 9;
  assert.equal(s.enchantmentChanceToHit(p), 0, 'an orc at 9 m');
  s.banishMonster(orc);
  const walker = { id: 'npc:m:fixture:0', kind: 'npc', mobile: true, location: loc, x: p.x + 3, z: p.z, name: 'Resident' };
  world.ctx.entities.set(walker.id, walker); // FIXTURE: a walking civilian
  assert.equal(s.enchantmentChanceToHit(p), -5, 'a walking civilian counts as Humanoid');
  world.ctx.entities.delete(walker.id);
  // Improves Talents: only strengthens advantages the career has.
  c.must('inventory.unequip', { itemId: hood.id });
  const boots = enchant(c, maker, 'daedric-helm', [{ type: 13, param: 0 }, { type: 13, param: 1 }, { type: 13, param: 2 }], 'Keen Helm');
  c.must('inventory.equip', { itemId: boots.id });
  assert.equal(ch.improvedTalents, undefined, 'the class has none of the three advantages');
  assert.deepEqual([ch.traversal.exertionMultiplier, ch.traversal.jumpMultiplier], [1, 1]);
  const career = s.careerOf(p);
  ch.custom = { ...career, advantages: [...career.advantages, { key: 'acuteHearing' }, { key: 'athleticism' }, { key: 'adrenalineRush' }] }; // FIXTURE SETUP
  world.tick(1000);
  assert.deepEqual(ch.improvedTalents, ['acuteHearing', 'athleticism', 'adrenalineRush']);
  assert.deepEqual([ch.traversal.exertionMultiplier, ch.traversal.jumpMultiplier], [0.8, 1.2]);
  assert.deepEqual(s.characterTraversal(p), ch.traversal, 'the server locomotion sees the same traits');
  c.must('inventory.unequip', { itemId: boots.id });
  assert.equal(ch.improvedTalents, undefined);
  assert.deepEqual([ch.traversal.exertionMultiplier, ch.traversal.jumpMultiplier], [0.9, 1.1]);
  void round;
});

test('Mace of Molag Bal: spell points drained past the maximum raise it for 12 minutes; not offered to Dispel', needData, async (t) => {
  const { world, s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const ch = p.rpg.character;
  const loc = p.rpg.location;
  const mace = s.giveItem(p, 'artifact-mace-of-molag-bal', 1);
  c.must('inventory.equip', { itemId: mace.id });
  const base = ch.maxMagicka;
  ch.magicka = base - 4; // FIXTURE SETUP: 4 below the maximum
  const mage = s.createEnemy(loc, 128, p.x, p.z - 1.2, { yaw: Math.PI }); // class enemy Mage
  mage.magicka = 30; // FIXTURE SETUP: a known pool
  const save = s.magicSavingThrow;
  s.magicSavingThrow = () => 100; // FIXTURE: the target fails its save
  try { s.enchantmentStrike(p, mage, { itemId: mace.id, damage: 10 }).after({ killed: false }); } finally { s.magicSavingThrow = save; }
  assert.equal(mage.magicka, 20, 'drained by the damage');
  assert.equal(ch.magicka, base + 6, 'the wielder gains all 10');
  assert.equal(ch.maxMagicka, base + 6, 'the maximum rises by the 6 overflow');
  world.tick(1000);
  assert.equal(ch.maxMagicka, base + 6, 'the regeneration step keeps the raised maximum');
  const entry = p.rpg.magic.active.find((a) => a.key === 'MaceOfMolagBal');
  assert.deepEqual([entry.maxMagicka, entry.showSpellIcon], [6, false]);
  // Dispel Magic does not list the Mace effect (MaceOfMolagBalEffect ShowSpellIcon = false).
  p.rpg.magic.known.push('std:59');
  const keep = [ch.magicka, ch.maxMagicka];
  ch.magicka = ch.maxMagicka = 1000; // FIXTURE SETUP: afford Null Magicka at level 1
  c.must('magic.cast', { spellId: 'std:59' });
  [ch.magicka, ch.maxMagicka] = keep;
  const picker = c.events('spellEffectChoice').at(-1);
  assert.ok(!picker || !picker.options.some((o) => /Molag/.test(o.name)), 'not offered');
  item(p, mace.id).magic.lastStrike -= 13; // FIXTURE SETUP: thirteen minutes later
  world.tick(5000);
  assert.equal(ch.maxMagicka, base);
  assert.ok(ch.magicka <= base);
  assert.equal(p.rpg.magic.active.some((a) => a.key === 'MaceOfMolagBal'), false);
});

test('Ring of Namira returns an archer’s arrow damage as well as melee', needData, async (t) => {
  const { world, s, connect } = await fixture(t);
  const c = connect();
  const p = c.player;
  const loc = p.rpg.location;
  for (const e of s.monstersIn(loc)) s.banishMonster(e);
  const ring = s.giveItem(p, 'artifact-ring-of-namira', 1);
  c.must('inventory.equip', { itemId: ring.id });
  const archer = s.createEnemy(loc, 141, p.x, p.z - 12, { yaw: Math.PI }); // FIXTURE position: 12 m ahead, open ground
  archer.hp = archer.maxHp = 500; // FIXTURE SETUP: survives the reflections
  s.provokeEnemy(archer, p);
  let shot = null;
  for (let i = 0; i < 400 && !shot; i++) {
    p.rpg.character.health = p.rpg.character.maxHealth; // FIXTURE SETUP: the wearer outlasts the archer
    world.tick(100);
    shot = c.events('monsterAttack').find((e) => e.ranged && e.hit && e.entityId === archer.id);
  }
  assert.ok(shot, 'an arrow struck the wearer');
  assert.ok(Math.hypot(archer.x - p.x, archer.z - p.z) > 3, 'from range, not melee');
  assert.ok(c.events('alchemy').some((e) => /Ring of Namira returns \d+ damage to the Archer/.test(e.text)), 'returned to the archer');
  assert.ok(archer.hp < 500);
});

test('Dispel Magic ends a worn item’s held spell until it is equipped again: no regrowth on reconnect or reroll', needData, async (t) => {
  const { world, s, connect, round } = await fixture(t);
  let c = connect();
  let p = c.player;
  const ring = s.giveItem(p, 'artifact-warlocks-ring', 1); // CastWhenHeld 86 Feet of Notorgo
  c.must('inventory.equip', { itemId: ring.id });
  assert.equal(held(s, p, ring.id).length, 1);
  p.rpg.magic.known.push('std:59');
  p.rpg.character.magicka = p.rpg.character.maxMagicka = 500; // FIXTURE SETUP: enough spell points
  c.must('magic.cast', { spellId: 'std:59' });
  const picker = c.events('spellEffectChoice').at(-1);
  const index = picker.options.findIndex((o) => /Notorgo/.test(o.name));
  assert.ok(index >= 0, 'the held bundle is offered');
  c.must('magic.choose', { token: picker.token, index });
  assert.equal(held(s, p, ring.id).length, 0, 'dispelled');
  assert.equal(item(p, ring.id).magic.held.dispelled, true);
  const id = ring.id;
  const cond = item(p, id).condition;
  round(8);
  assert.equal(held(s, p, id).length, 0, 'not recast by the next rounds');
  assert.equal(item(p, id).condition, cond, 'no Cast When Held wear without a live bundle');
  world.restart();
  c = connect();
  p = c.player;
  assert.equal(held(s, p, id).length, 0, 'not regrown on reconnect');
  item(p, id).magic.held.at -= HELD_REROLL_MINUTES; // FIXTURE SETUP: six hours later
  round(1);
  assert.equal(held(s, p, id).length, 0, 'not regrown by the six-hour reroll');
  // Re-equipping casts it again and pays the classic charge.
  c.must('inventory.unequip', { itemId: id });
  const before = item(p, id).condition;
  c.must('inventory.equip', { itemId: id });
  assert.equal(held(s, p, id).length, 1);
  assert.equal(item(p, id).condition, before - s.heldSpellCharge(p, 86));
});
