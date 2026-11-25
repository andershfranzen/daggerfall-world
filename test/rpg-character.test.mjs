// Character feature: creation, validation, persistence and progression against a fake gameplay ctx
// that follows docs/gameplay-protocol.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, loadCareers, SKILL_CHECK_MS, REROLL_COOLDOWN_MS } from '../server/rpg/character.js';
import * as R from '../client/gameplay/character/rules.js';
import { encodeClassCfg, parseClassCfg } from '../client/gameplay/character/cfg.js';

function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCtx({ seed = 7, careers } = {}) {
  const join = [], leave = [], tick = [], actions = new Map(), listeners = new Map();
  const ctx = {
    players: new Map(),
    entities: new Map(),
    services: {},
    events: [],
    emitted: [],
    dirtied: new Set(),
    clock: 1000,
    random: seeded(seed),
    careers,
    now: () => ctx.clock,
    onJoin: (fn) => join.push(fn),
    onLeave: (fn) => leave.push(fn),
    onTick: (fn) => tick.push(fn),
    onAction: (verb, fn) => actions.set(verb, fn),
    on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    emit: (name, payload) => {
      ctx.emitted.push({ name, payload });
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    notify: (p, event) => ctx.events.push({ to: p.id, ...event }),
    nearby: () => {},
    dirty: (p) => ctx.dirtied.add(p.id),
  };
  const h = {
    ctx,
    api: install(ctx),
    join(p) { ctx.players.set(p.id, p); for (const fn of join) fn(p); return p; },
    leave(p) { for (const fn of leave) fn(p); ctx.players.delete(p.id); },
    tick(dt) { for (const fn of tick) fn(dt, ctx.clock); },
    /** Mirrors the runtime: an action either fully succeeds or throws a user-readable Error. */
    act(p, verb, args = {}) {
      const fn = actions.get(verb);
      if (!fn) throw new Error(`No action ${verb}`);
      return fn(p, structuredClone(args));
    },
    has: (verb) => actions.has(verb),
  };
  return h;
}

const player = (id = 1, rpg = undefined) => ({ id, name: `Hero${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: rpg ?? { location: 'town:Daggerfall/Gothway Garden' } });

/** Spends a roll's pools the way a careful player would: lowest value first. */
function spendDraft(draft, career) {
  const attributes = R.spendLowest({ ...draft.attributeBase }, R.ATTRIBUTES, draft.bonusPool);
  const skills = { ...draft.skillBase };
  for (const [, list] of R.groupsOf(career)) R.spendLowest(skills, list, R.SKILL_GROUP_POOL);
  return { attributes, skills };
}

function create(h, p, { className = 'Spellsword', race = 'Dark Elf', gender = 'Female', name = 'Vela Ashmoor' } = {}) {
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { className });
  const d = p.rpg.character.draft;
  const career = d.custom ?? R.CLASS_BY_NAME[className];
  const spent = spendDraft(d, career);
  h.act(p, 'character.create', { name, race, gender, reflexes: 'Average', faceIndex: 3, ...spent });
  return p.rpg.character;
}

// ------------------------------------------------------------------ shared defaults

test('new and returning guests get a playable, uncreated default character', () => {
  const h = makeCtx();
  const p = h.join(player(1));
  const ch = p.rpg.character;
  assert.equal(ch.created, false);
  assert.equal(ch.className, 'Warrior');
  assert.equal(ch.race, 'Breton');
  assert.equal(p.rpg.location, 'town:Daggerfall/Gothway Garden', 'location untouched');
  assert.equal(Object.keys(ch.skills).length, 35);
  assert.equal(Object.keys(ch.attributes).length, 8);
  assert.equal(ch.maxHealth, 25 + R.CLASS_BY_NAME.Warrior.hitPointsPerLevel);
  assert.equal(ch.maxFatigue, ch.attributes.Strength + ch.attributes.Endurance);
  assert.equal(ch.health, ch.maxHealth);
  assert.ok(h.ctx.dirtied.has(1), 'default persisted');
  assert.ok(h.ctx.events.some((e) => e.kind === 'characterNeeded'));
  // Services work on default characters, so combat and magic can treat everyone alike.
  assert.equal(h.ctx.services.skillValue(p, 'Long Blade'), ch.skills['Long Blade']);
  assert.ok(ch.skills['Long Blade'] >= 28);
  // JSON-serializable, as the runtime requires.
  assert.deepEqual(JSON.parse(JSON.stringify(p.rpg)), p.rpg);
});

test('old saves without a character, and damaged saves, are repaired without granting extra power', () => {
  const h = makeCtx();
  const legacy = h.join(player(2, { location: 'town:Daggerfall/Gothway Garden' }));
  assert.equal(legacy.rpg.character.created, false);

  const tampered = create(makeCtx(), h.join(player(3)));
  tampered.attributes.Strength = 9999;
  tampered.attributes.Bogus = 50;
  tampered.skills['Long Blade'] = 250;
  tampered.skills.Flying = 90;
  tampered.level = 40;
  tampered.maxHealth = 100000;
  tampered.health = 100000;
  tampered.magicka = -5;
  tampered.bonusPoints = 500;
  const h2 = makeCtx();
  const p = h2.join(player(3, { character: structuredClone(tampered) }));
  const ch = p.rpg.character;
  assert.equal(ch.created, true);
  assert.equal(ch.attributes.Strength, 100);
  assert.ok(!('Bogus' in ch.attributes));
  assert.equal(ch.skills['Long Blade'], 100);
  assert.ok(!('Flying' in ch.skills));
  assert.ok(ch.level < 40, `level clamped to what skills earn (${ch.level})`);
  assert.ok(ch.maxHealth < 1000);
  assert.ok(ch.health <= ch.maxHealth);
  assert.equal(ch.magicka, 0);
  assert.ok(ch.bonusPoints <= (ch.level - 1) * 6);

  const garbage = h2.join(player(4, { character: 'nope' }));
  assert.equal(garbage.rpg.character.created, false);
});

// ------------------------------------------------------------------ creation

test('creation follows the classic rolls and persists exactly once', () => {
  const h = makeCtx({ seed: 42 });
  const p = h.join(player(1));
  h.ctx.clock += REROLL_COOLDOWN_MS;
  const roll = h.act(p, 'character.roll', { className: 'Knight' });
  const career = R.CLASS_BY_NAME.Knight;
  for (const a of R.ATTRIBUTES) {
    assert.ok(roll.attributeBase[a] >= career.attributes[a] && roll.attributeBase[a] <= career.attributes[a] + 10, a);
  }
  assert.ok(roll.bonusPool >= 6 && roll.bonusPool <= 14);
  for (const s of career.primarySkills) assert.ok(roll.skillBase[s] >= 28 && roll.skillBase[s] <= 31, s);
  for (const s of career.majorSkills) assert.ok(roll.skillBase[s] >= 18 && roll.skillBase[s] <= 21, s);
  for (const s of career.minorSkills) assert.ok(roll.skillBase[s] >= 13 && roll.skillBase[s] <= 16, s);
  assert.ok(roll.skillBase.Swimming >= 3 && roll.skillBase.Swimming <= 6);

  const spent = spendDraft(p.rpg.character.draft, career);
  h.act(p, 'character.create', { name: "Sir Aldric O'Neil", race: 'Nord', gender: 'Male', reflexes: 'High', faceIndex: 2, ...spent });
  const ch = p.rpg.character;
  assert.equal(ch.created, true);
  assert.equal(ch.className, 'Knight');
  assert.equal(ch.race, 'Nord');
  assert.equal(ch.reflexes, 'High');
  assert.equal(ch.faceIndex, 2);
  assert.equal(ch.draft, null);
  assert.deepEqual(ch.attributes, spent.attributes);
  assert.equal(ch.maxMagicka, Math.floor(spent.attributes.Intelligence * career.spellPointMultiplier));
  assert.equal(ch.startingLevelUpSkillSum, R.levelUpSkillSum(spent.skills, career));
  assert.ok(h.ctx.emitted.some((e) => e.name === 'characterCreated'));

  // Once only.
  h.ctx.clock += REROLL_COOLDOWN_MS;
  assert.throws(() => h.act(p, 'character.roll', { className: 'Mage' }), /already been created/);
  assert.throws(() => h.act(p, 'character.create', { name: 'X', race: 'Nord', gender: 'Male', ...spent }), /already been created/);

  // Survives a save/load cycle with a new server instance.
  const saved = JSON.parse(JSON.stringify(p.rpg));
  const h2 = makeCtx();
  const again = h2.join(player(1, saved));
  assert.deepEqual(again.rpg.character, ch);
});

test('the server rejects totals, pools and choices it did not roll', () => {
  const h = makeCtx({ seed: 3 });
  const p = h.join(player(1));
  const ok = { name: 'Rin', race: 'Breton', gender: 'Female' };
  assert.throws(() => h.act(p, 'character.create', { ...ok, attributes: {}, skills: {} }), /Roll your attributes first/);
  assert.throws(() => h.act(p, 'character.roll', { className: 'Emperor' }), /Choose a class/);
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { className: 'Thief' });
  assert.throws(() => h.act(p, 'character.roll', { className: 'Thief' }), /Wait a moment/);
  const d = p.rpg.character.draft;
  const career = R.CLASS_BY_NAME.Thief;
  const good = spendDraft(d, career);

  const bad = (patch, re) => assert.throws(() => h.act(p, 'character.create', { ...ok, ...good, ...patch }), re);
  bad({ attributes: { ...good.attributes, Luck: good.attributes.Luck + 1 } }, /Too many bonus points/);
  bad({ attributes: { ...d.attributeBase } }, /Distribute all bonus points/);
  bad({ attributes: { ...good.attributes, Speed: d.attributeBase.Speed - 1, Luck: good.attributes.Luck + (good.attributes.Speed - d.attributeBase.Speed) + 1 } }, /cannot be lowered/);
  bad({ attributes: { ...good.attributes, Strength: 12.5 } }, /whole number/);
  bad({ attributes: { ...good.attributes, Charm: 1 } }, /Unknown attribute/);
  bad({ skills: { ...good.skills, Swimming: d.skillBase.Swimming + 1 } }, /not one of your class skills/);
  bad({ skills: { ...good.skills, [career.primarySkills[0]]: good.skills[career.primarySkills[0]] + 1 } }, /Too many primary/);
  bad({ skills: { ...d.skillBase } }, /Distribute all primary/);
  bad({ skills: { ...good.skills, Flying: 50 } }, /Unknown skill/);
  bad({ race: 'Dwemer' }, /Choose a race/);
  bad({ gender: 'x' }, /Choose a gender/);
  bad({ reflexes: 'Instant' }, /reflexes/);
  bad({ faceIndex: 99 }, /face/);
  bad({ name: '<script>' }, /Enter a name/);
  bad({ name: '' }, /Enter a name/);
  // Client-supplied derived values are ignored entirely.
  h.act(p, 'character.create', { ...ok, ...good, level: 50, maxHealth: 9999, health: 9999, skillUses: { 'Long Blade': 20000 }, created: false });
  const ch = p.rpg.character;
  assert.equal(ch.level, 1);
  assert.equal(ch.maxHealth, 25 + career.hitPointsPerLevel);
  assert.equal(ch.skillUses['Long Blade'], 0);
  assert.equal(ch.created, true);
});

test('there is no client-facing way to grant XP, skills or levels', () => {
  const h = makeCtx();
  for (const verb of ['character.addXp', 'character.setSkill', 'character.advance', 'character.setLevel', 'character.train']) {
    assert.equal(h.has(verb), false, verb);
  }
  const p = h.join(player(1));
  assert.throws(() => h.act(p, 'character.levelUp', { attributes: { ...p.rpg.character.attributes, Strength: 100 } }), /no attribute points/);
});

test('rerolling a different class resets the draft; cancel clears it', () => {
  const h = makeCtx();
  const p = h.join(player(1));
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { className: 'Mage' });
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { className: 'Mage' });
  assert.equal(p.rpg.character.draft.rolls, 2);
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { className: 'Monk' });
  assert.equal(p.rpg.character.draft.rolls, 1);
  assert.equal(p.rpg.character.draft.className, 'Monk');
  h.act(p, 'character.cancel');
  assert.equal(p.rpg.character.draft, null);
});

// ------------------------------------------------------------------ custom classes

const customSpec = (patch = {}) => ({
  name: 'Witchhunter',
  hitPointsPerLevel: 14,
  attributes: { Strength: 55, Intelligence: 45, Willpower: 60, Agility: 50, Endurance: 50, Personality: 40, Speed: 50, Luck: 50 },
  primarySkills: ['Long Blade', 'Destruction', 'Restoration'],
  majorSkills: ['Archery', 'Mysticism', 'Dodging'],
  minorSkills: ['Daedric', 'Running', 'Stealth', 'Medical', 'Axe', 'Streetwise'],
  advantages: [{ key: 'bonusToHit', option: 'Undead' }, { key: 'increasedMagery', option: '1.5x INT' }],
  disadvantages: [{ key: 'forbiddenMaterial', option: 'Steel' }],
  ...patch,
});

test('custom classes are validated and costed like the classic class builder', () => {
  const career = R.buildCustomClass(customSpec());
  // hp 14 → +6; to-hit undead +6; magery 1.5x +4; forbidden steel -10 → 6
  assert.equal(career.difficulty, 6);
  assert.equal(career.advancementMultiplier, Math.round((0.3 + (2.7 * 18) / 52) * 100) / 100);
  assert.equal(career.spellPointMultiplier, 1.5);
  assert.equal(R.customDifficulty(4), -8);

  const reject = (patch, re) => assert.throws(() => R.buildCustomClass(customSpec(patch)), re);
  reject({ name: '' }, /Name your class/);
  reject({ name: 'Warrior' }, /standard class/);
  reject({ hitPointsPerLevel: 31 }, /Hit points per level/);
  reject({ attributes: { ...customSpec().attributes, Luck: 51 } }, /total 400/);
  reject({ attributes: { ...customSpec().attributes, Luck: 80, Speed: 20 } }, /between 10 and 75/);
  reject({ primarySkills: ['Long Blade', 'Long Blade', 'Restoration'] }, /more than once/);
  reject({ minorSkills: ['Daedric'] }, /Choose 6 minor/);
  reject({ majorSkills: ['Archery', 'Mysticism', 'Long Blade'] }, /more than once/);
  reject({ advantages: [{ key: 'flight' }] }, /Unknown special ability/);
  reject({ advantages: [{ key: 'immunity', option: 'Boredom' }] }, /valid option/);
  reject({ advantages: [{ key: 'increasedMagery', option: '3x INT' }, { key: 'increasedMagery', option: '2x INT' }] }, /only one/);
  reject({ hitPointsPerLevel: 30, advantages: [{ key: 'immunity', option: 'Magic' }, { key: 'regenerateHealth', option: 'general' }], disadvantages: [] }, /too powerful/);
  reject({ hitPointsPerLevel: 4, advantages: [], disadvantages: [{ key: 'inabilityToRegen' }] }, /too weak/);
});

test('a custom class can be rolled, created and persisted', () => {
  const h = makeCtx({ seed: 11 });
  const p = h.join(player(1));
  h.ctx.clock += REROLL_COOLDOWN_MS;
  h.act(p, 'character.roll', { custom: customSpec() });
  const d = p.rpg.character.draft;
  assert.equal(d.className, 'Witchhunter');
  assert.ok(d.custom.custom);
  // Tampered custom specs are rejected server-side.
  h.ctx.clock += REROLL_COOLDOWN_MS;
  assert.throws(() => h.act(p, 'character.roll', { custom: customSpec({ hitPointsPerLevel: 99 }) }), /Hit points per level/);
  assert.equal(p.rpg.character.draft.className, 'Witchhunter', 'failed reroll keeps the old draft');

  const spent = spendDraft(d, d.custom);
  h.act(p, 'character.create', { name: 'Mara', race: 'High Elf', gender: 'Female', ...spent });
  const ch = p.rpg.character;
  assert.equal(ch.className, 'Witchhunter');
  assert.equal(ch.custom.difficulty, 6);
  assert.equal(ch.maxMagicka, Math.floor(ch.attributes.Intelligence * 1.5));
  assert.equal(h.ctx.services.hasAbility(p, 'forbiddenMaterial', 'Steel'), true);
  assert.equal(h.ctx.services.hasAbility(p, 'forbiddenMaterial', 'Iron'), false);

  // Reload: the custom career is rebuilt from rules, so a stored difficulty or multiplier cannot be forged.
  const saved = JSON.parse(JSON.stringify(p.rpg));
  saved.character.custom.advancementMultiplier = 0.01;
  saved.character.custom.spellPointMultiplier = 50;
  const h2 = makeCtx();
  const q = h2.join(player(1, saved));
  assert.equal(q.rpg.character.custom.spellPointMultiplier, 1.5);
  assert.notEqual(q.rpg.character.custom.advancementMultiplier, 0.01);
  assert.equal(q.rpg.character.maxMagicka, Math.floor(q.rpg.character.attributes.Intelligence * 1.5));
});

// ------------------------------------------------------------------ progression

test('skills advance only from server-tallied use, throttled like the classic check', () => {
  const h = makeCtx({ seed: 5 });
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Warrior' });
  const before = ch.skills['Long Blade'];
  const need = R.usesForAdvancement(before, 'Long Blade', 1, ch.level);
  const r1 = h.ctx.services.advanceSkill(p, 'Long Blade', need);
  assert.equal(r1.raised, false, 'no raise before the check interval elapses');
  assert.equal(ch.skills['Long Blade'], before);
  h.ctx.clock += SKILL_CHECK_MS;
  const r2 = h.ctx.services.advanceSkill(p, 'Long Blade', 0);
  assert.equal(r2.raised, true);
  assert.equal(ch.skills['Long Blade'], before + 1);
  assert.equal(ch.skillUses['Long Blade'], 0);
  assert.ok(ch.recentlyRaised.includes('Long Blade'));
  assert.ok(h.ctx.events.some((e) => e.kind === 'skillRaised' && e.skill === 'Long Blade'));
  // Per-call amount is capped, and unknown skills are refused.
  h.ctx.services.advanceSkill(p, 'Axe', 1e9);
  assert.equal(ch.skillUses.Axe, 100);
  assert.throws(() => h.ctx.services.advanceSkill(p, 'Flying', 1), /Unknown skill/);
  // Ticks also run the periodic check.
  ch.skillUses.Axe = 20000;
  h.ctx.clock += SKILL_CHECK_MS;
  const axe = ch.skills.Axe;
  h.tick(1);
  assert.equal(ch.skills.Axe, axe + 1);
});

test('reflexes scale effective uses as PlayerEntity.RaiseSkills does', () => {
  assert.equal(R.effectiveUses(100, 'Average'), 100);
  assert.equal(R.effectiveUses(100, 'Very High'), 125);
  assert.equal(R.effectiveUses(100, 'Very Low'), 75);
});

test('levels come from the classic skill sum, roll hit points and grant 4–6 attribute points', () => {
  const h = makeCtx({ seed: 9 });
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Warrior' });
  const career = R.CLASS_BY_NAME.Warrior;
  const hp0 = ch.maxHealth;
  // Raise primaries until the sum earns level 2 (13 points past start with the +28 offset → 2 levels needs 2).
  let guard = 0;
  while (ch.level < 2 && guard++ < 200) {
    for (const s of career.primarySkills) ch.skillUses[s] = 20000;
    h.ctx.clock += SKILL_CHECK_MS;
    h.tick(1);
  }
  assert.equal(ch.level, 2);
  assert.equal(ch.currentLevelUpSkillSum, R.levelUpSkillSum(ch.skills, career));
  assert.equal(R.levelFor(ch.startingLevelUpSkillSum, ch.currentLevelUpSkillSum), 2);
  const gained = ch.maxHealth - hp0;
  const endMod = R.hitPointsModifier(ch.attributes.Endurance);
  assert.ok(gained >= Math.max(1, 11 + endMod) && gained <= 22 + endMod, `hp gained ${gained}`);
  assert.ok(ch.bonusPoints >= 4 && ch.bonusPoints <= 6);
  assert.ok(h.ctx.events.some((e) => e.kind === 'levelUp' && e.level === 2));

  const pool = ch.bonusPoints;
  const a = { ...ch.attributes };
  assert.throws(() => h.act(p, 'character.levelUp', { attributes: { ...a, Strength: a.Strength + pool + 1 } }), /Too many/);
  assert.throws(() => h.act(p, 'character.levelUp', { attributes: { ...a, Luck: a.Luck - 1, Strength: a.Strength + pool + 1 } }), /cannot be lowered/);
  const next = { ...a, Endurance: Math.min(100, a.Endurance + pool) };
  next.Luck += pool - (next.Endurance - a.Endurance);
  h.act(p, 'character.levelUp', { attributes: next });
  assert.equal(ch.bonusPoints, 0);
  assert.deepEqual(ch.attributes, next);
  assert.equal(ch.maxFatigue, next.Strength + next.Endurance);
});

test('mastery: only one primary skill may pass 95 until mastered skills cap', () => {
  const h = makeCtx();
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Warrior' });
  const [a, b] = R.CLASS_BY_NAME.Warrior.primarySkills;
  ch.skills[a] = 100;
  ch.skills[b] = 95;
  ch.skillUses[b] = 20000;
  h.ctx.clock += SKILL_CHECK_MS;
  h.ctx.services.advanceSkill(p, b, 0);
  assert.equal(ch.skills[b], 95);
  assert.equal(ch.skillUses[b], 0, 'uses are still consumed');
});

// ------------------------------------------------------------------ resources

test('resource services spend, restore and regenerate without trusting callers', () => {
  const h = makeCtx();
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Mage', race: 'Breton' });
  const s = h.ctx.services;
  const mk = ch.magicka;
  assert.ok(mk > 0);
  assert.equal(s.spendMagicka(p, mk + 1), false);
  assert.equal(ch.magicka, mk);
  assert.equal(s.spendMagicka(p, 10), true);
  assert.equal(ch.magicka, mk - 10);
  assert.equal(s.spendMagicka(p, -50), true, 'negative costs clamp to zero');
  assert.equal(ch.magicka, mk - 10);
  assert.equal(s.restoreMagicka(p, 1e9), 10);
  assert.equal(s.spendFatigue(p, 5), true);
  const f = ch.fatigue;
  assert.equal(s.spendFatigue(p, f + 10), false);
  assert.equal(ch.fatigue, 0, 'exertion drains to zero');
  s.restoreFatigue(p, f);
  const dmg = s.damagePlayer(p, 10);
  assert.equal(dmg.health, ch.maxHealth - 10);
  assert.equal(s.healPlayer(p, 3), 3);
  const down = s.damagePlayer(p, 10_000);
  assert.equal(down.dead, true);
  assert.ok(h.ctx.emitted.some((e) => e.name === 'playerDowned'));
  h.tick(5);
  assert.equal(ch.health, 0, 'no regeneration while down');
  s.revivePlayer(p, 0.5);
  assert.equal(ch.health, Math.floor(ch.maxHealth * 0.5));
  ch.magicka = 0;
  ch.fatigue = 0;
  h.tick(3);
  assert.ok(ch.magicka > 0 && ch.fatigue > 0, 'regenerates over time');
  const m = s.characterModifiers(p);
  assert.equal(m.toHit, Math.floor(ch.attributes.Agility / 10) - 5);
  assert.equal(m.magicResist, Math.floor(ch.attributes.Willpower / 10));
});

test('sorcerers never regenerate magicka', () => {
  const h = makeCtx();
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Sorcerer' });
  assert.equal(ch.maxMagicka, Math.floor(ch.attributes.Intelligence * 3));
  ch.magicka = 0;
  h.tick(10);
  assert.equal(ch.magicka, 0);
  assert.equal(h.ctx.services.characterRestRecovery(p).magicka, 0);
  assert.ok(h.ctx.services.hasAbility(p, 'spellAbsorption'));
});

test('state is per player and leaving clears transient state only', () => {
  const h = makeCtx();
  const a = h.join(player(1));
  const b = h.join(player(2));
  create(h, a, { className: 'Bard', name: 'Lute' });
  assert.equal(b.rpg.character.created, false);
  h.leave(a);
  assert.equal(a.rpg.character.created, true);
});

// ------------------------------------------------------------------ data

test('every standard class is well formed', () => {
  assert.equal(R.CLASSES.length, 18);
  for (const c of R.CLASSES) {
    const all = [...c.primarySkills, ...c.majorSkills, ...c.minorSkills];
    assert.equal(c.primarySkills.length, 3, c.name);
    assert.equal(c.majorSkills.length, 3, c.name);
    assert.equal(c.minorSkills.length, 6, c.name);
    assert.equal(new Set(all).size, 12, `${c.name} skills unique`);
    for (const s of all) assert.ok(s in R.SKILL_INDEX, `${c.name}: ${s}`);
    for (const a of R.ATTRIBUTES) assert.ok(c.attributes[a] >= 10 && c.attributes[a] <= 90, `${c.name} ${a}`);
  }
  assert.equal(R.RACES.length, 8);
  assert.equal(R.SKILLS.length, 35);
  for (const s of R.SKILLS) {
    assert.ok(R.SKILL_ATTRIBUTE[s], s);
    assert.ok(R.SKILL_ADVANCEMENT[s] > 0, s);
  }
});

test('CLASS*.CFG records round-trip and an operator directory overrides built-in numbers', () => {
  const knight = R.CLASS_BY_NAME.Knight;
  const parsed = parseClassCfg(encodeClassCfg({ ...knight, hitPointsPerLevel: 21, advancementMultiplier: 1.5 }));
  assert.equal(parsed.name, 'Knight');
  assert.equal(parsed.hitPointsPerLevel, 21);
  assert.equal(parsed.advancementMultiplier, 1.5);
  assert.deepEqual([...parsed.primarySkills], [...knight.primarySkills]);
  assert.deepEqual({ ...parsed.attributes }, { ...knight.attributes });
  assert.equal(parsed.spellPointMultiplier, 0.5);
  assert.throws(() => parseClassCfg(new Uint8Array(10)), /Not a CLASS/);

  const dir = mkdtempSync(join(tmpdir(), 'dfw-class-'));
  try {
    writeFileSync(join(dir, 'CLASS17.CFG'), encodeClassCfg({ ...knight, hitPointsPerLevel: 21 }));
    writeFileSync(join(dir, 'class00.cfg'), Buffer.from('garbage'));
    const warnings = [];
    const careers = loadCareers(dir, { warn: (m) => warnings.push(m) });
    assert.equal(careers.Knight.hitPointsPerLevel, 21);
    assert.equal(careers.Mage.hitPointsPerLevel, R.CLASS_BY_NAME.Mage.hitPointsPerLevel);
    assert.equal(warnings.length, 1);
    const h = makeCtx({ careers });
    const p = h.join(player(1));
    const ch = create(h, p, { className: 'Knight' });
    assert.equal(ch.maxHealth, 25 + 21);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLASS*.CFG decodes the installed weapon, armor, shield and material bits in Classic byte order', (t) => {
  const dir = process.env.ARENA2_DIR ?? new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
  if (!existsSync(dir)) return t.skip('No installed ARENA2 folder');
  const careers = loadCareers(dir);
  const { Mage, Knight, Sorcerer, Monk, Warrior } = careers;
  assert.equal(Mage.source, 'cfg');
  assert.deepEqual(Mage.disadvantages.filter((a) => a.key === 'forbiddenWeaponry').map((a) => a.option), ['Long Blade', 'Axe', 'Missile Weapons']);
  assert.deepEqual(Mage.disadvantages.filter((a) => a.key === 'forbiddenArmorType').map((a) => a.option), ['Chain', 'Plate']);
  assert.deepEqual(Mage.disadvantages.filter((a) => a.key === 'forbiddenShieldTypes').map((a) => a.option), ['Round Shield', 'Kite Shield', 'Tower Shield']);
  assert.ok(Knight.disadvantages.some((a) => a.key === 'forbiddenMaterial' && a.option === 'Daedric'));
  assert.ok(Knight.advantages.some((a) => a.key === 'immunity' && a.option === 'Paralysis'));
  assert.ok(Monk.advantages.some((a) => a.key === 'resistance' && a.option === 'Shock'));
  assert.ok(Sorcerer.noRegenMagicka);
  assert.equal(Mage.hitPointsPerLevel, 6);
  assert.equal(Warrior.hitPointsPerLevel, 20);
});

test('six-hour practice and twelve-hour training windows use personal minutes and survive reconnect', () => {
  const h = makeCtx();
  let minutes = 10_000;
  h.ctx.services.worldClock = () => ({ minutes, isNight: false });
  const p = h.join(player(1));
  const ch = create(h, p, { className: 'Mage' });
  const s = h.ctx.services;
  const before = ch.skills.Mysticism;
  ch.skillUses.Mysticism = 100;
  const trainee = s.characterTraining(p, 'Orcish', { commit: true });
  assert.ok(trainee.ok);
  assert.ok(ch.skillUses.Orcish >= 150 && ch.skillUses.Orcish <= 300);
  assert.equal(p.rpg.atmosphere.personalMinutes, 180);
  assert.equal(ch.skills.Mysticism, before);
  minutes += 179;
  h.tick(1);
  assert.equal(ch.skills.Mysticism, before);
  const h2 = makeCtx();
  h2.ctx.services.worldClock = () => ({ minutes, isNight: false });
  const q = h2.join(player(1, structuredClone(p.rpg)));
  const a = h2.ctx.services;
  assert.equal(a.characterTraining(q, 'Orcish').minutesLeft, 361);
  minutes += 1;
  h2.tick(1);
  assert.equal(q.rpg.character.skills.Mysticism, before + 1);
  assert.equal(q.rpg.character.skillUses.Mysticism, 0);
  assert.equal(a.characterTraining(q, 'Orcish').reason, 'cooldown');
  minutes += 360;
  q.rpg.character.skills.Orcish = 50;
  assert.equal(a.characterTraining(q, 'Orcish').ok, true);
  q.rpg.character.skills.Orcish = 51;
  assert.equal(a.characterTraining(q, 'Orcish').reason, 'cap');
});

test('effective stats compose magical and condition modifiers while HP uses permanent Endurance', () => {
  const ability = (key, option) => ({ key, option });
  const careers = { ...R.CLASS_BY_NAME, Mage: {
    ...R.CLASS_BY_NAME.Mage,
    advantages: [ability('spellAbsorption', 'in darkness'), ability('rapidHealing', 'in darkness')],
    disadvantages: [ability('darknessPoweredMagery', 'lower magic ability in daylight')],
  } };
  const h = makeCtx({ careers });
  h.ctx.services.worldClock = () => ({ minutes: 10_000, isNight: false });
  const a = h.join(player(1));
  const mage = create(h, a, { className: 'Mage', race: 'High Elf' });
  const b = h.join(player(2));
  create(h, b, { race: 'Nord', className: 'Warrior' });
  const s = h.ctx.services;
  assert.deepEqual(s.characterSavingThrow(a, 'paralysis'), { immune: true, critical: false, modifier: 0 });
  assert.deepEqual(s.characterSavingThrow(b, 'cold'), { immune: false, critical: false, modifier: 30 });
  assert.ok(mage.maxMagicka < R.spellPoints(mage.attributes.Intelligence, mage.career.spellPointMultiplier));
  a.rpg.location = 'interior:Daggerfall/Gothway Garden/0,0/0';
  assert.deepEqual(s.characterMagery(a), { blocked: false, multiplier: 1, absorbs: true });
  s.magicAttributeModifier = (_, key) => key === 'Intelligence' ? 10 : 0;
  s.conditionAttributePenalty = (_, key) => key === 'Intelligence' ? 5 : key === 'Endurance' ? 45 : 0;
  h.tick(1);
  assert.equal(s.effectiveAttribute(a, 'Intelligence'), s.baseAttribute(a, 'Intelligence') + 5);
  assert.equal(mage.maxMagicka, R.spellPoints(mage.attributes.Intelligence + 5, mage.career.spellPointMultiplier));
  mage.attributes.Personality = b.rpg.character.attributes.Personality = 50;
  mage.skills.Daedric = 30;
  b.rpg.character.skills.Daedric = 5;
  assert.deepEqual(s.languageCheck(a, 'Daedric', { roll: 26 }), { skill: 'Daedric', chance: 45, success: true });
  assert.deepEqual(s.languageCheck(b, 'Daedric', { roll: 26 }), { skill: 'Daedric', chance: 20, success: false });
  a.rpg.readied = true;
  assert.equal(s.languageCheck(a, 'Daedric', { roll: 26 }).success, false);
  mage.attributes.Endurance = 100;
  mage.startingLevelUpSkillSum = R.levelUpSkillSum(mage.skills, mage.career);
  const healthBefore = mage.maxHealth;
  for (const name of mage.career.primarySkills) mage.skillUses[name] = 100;
  h.api.raiseSkills(a, true);
  assert.equal(mage.level, 2);
  assert.ok(mage.maxHealth - healthBefore >= Math.floor(mage.career.hitPointsPerLevel / 2) + 5);
});

test('career health effects depend on sunlight, darkness, holy ground and immersion', () => {
  const careers = { ...R.CLASS_BY_NAME, Warrior: {
    ...R.CLASS_BY_NAME.Warrior,
    advantages: [{ key: 'regenerateHealth', option: 'while immersed' }],
    disadvantages: [{ key: 'damage', option: 'from sunlight' }, { key: 'damage', option: 'from holy places' }],
  } };
  const h = makeCtx({ careers });
  let minutes = 10_000;
  const p = h.join(player(1));
  const s = h.ctx.services;
  s.worldClock = () => ({ minutes, isNight: false });
  const c = create(h, p, { className: 'Warrior' });
  const start = c.health;
  h.tick(1);
  minutes += 4;
  h.tick(1);
  assert.equal(c.health, start - 12);
  p.rpg.location = 'interior:Daggerfall/Daggerfall/1,2/0';
  minutes += 4;
  h.tick(1);
  assert.equal(c.health, start - 12, 'ordinary interiors shelter this career');
  p.rpg.location = 'temple:Daggerfall/Gothway Garden';
  minutes += 4;
  h.tick(1);
  assert.equal(c.health, start - 24);
  p.rpg.location = 'dungeon:Daggerfall/Privateer\'s Hold';
  s.isSwimming = () => true;
  minutes += 4;
  h.tick(1);
  assert.equal(c.health, start - 23);
});
