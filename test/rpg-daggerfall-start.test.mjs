// Authentic classic Daggerfall new-character start, starting kit, spells, biography,
// pre-creation guard, level progression and persistence regression tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as character from '../server/rpg/character.js';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as magic } from '../server/rpg/magic.js';
import { STARTING_SPELLS, FALLBACK_STARTING, makeSpell, loadCatalogue } from '../server/rpg/magic/catalogue.js';
import { localArena2 } from './support/rpg-session.mjs';
import { effectTemplate } from '../server/rpg/magic/effects.js';
import * as R from '../client/gameplay/character/rules.js';
import * as K from '../client/gameplay/character/classic.js';
import { CharacterDraft, LevelUpDraft } from '../client/gameplay/character/draft.js';

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

/** Builds a synthetic SPELLS.STD-shaped catalogue containing all classic starter spell indices. */
function makeStdCatalogue() {
  const settings = {
    durationBase: 2, durationPlus: 1, durationPerLevel: 1,
    chanceBase: 100, chancePlus: 0, chancePerLevel: 1,
    magnitudeBaseMin: 4, magnitudeBaseMax: 10, magnitudePlusMin: 1, magnitudePlusMax: 2, magnitudePerLevel: 1,
  };
  const dmg = { template: effectTemplate(4, 0), settings, type: 4, subType: 0 };
  const heal = { template: effectTemplate(10, 8), settings, type: 10, subType: 8 };
  const defs = [
    // Names as in the real SPELLS.STD for these indices.
    [1, "Fenrik's Door Jam", 'magic', 'caster', [heal]],
    [2, 'Buoyancy', 'magic', 'caster', [heal]],
    [8, 'Shock', 'shock', 'touch', [dmg]],
    [37, 'Slowfalling', 'magic', 'caster', [heal]],
    [44, 'Chameleon', 'magic', 'caster', [heal]],
    [97, "Balyna's Balm", 'magic', 'caster', [heal]],
  ];
  const spells = new Map();
  for (const [index, name, element, targetType, effects] of defs) {
    const id = `std:${index}`;
    spells.set(id, makeSpell({ id, name, index, element, targetType, effects, origin: 'SPELLS.STD' }));
  }
  return { spells, source: 'SPELLS.STD', coverage: { total: spells.size, full: spells.size, tracked: 0, partial: 0, unsupported: 0, hidden: 0 } };
}

function textRsc(records) {
  const ids = Object.keys(records).map(Number).sort((a, b) => a - b);
  const bodies = ids.map((id) => {
    const out = [];
    for (const ch of String(records[id])) out.push(ch === '\n' ? 0x00 : ch.charCodeAt(0));
    out.push(0xfe);
    return out;
  });
  const headerLength = (ids.length + 1) * 6;
  const bytes = [];
  const u16 = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  u16(headerLength);
  let offset = 2 + ids.length * 6;
  ids.forEach((id, i) => { u16(id); u32(offset); offset += bodies[i].length; });
  for (const b of bodies) bytes.push(...b);
  return K.parseTextRsc(new Uint8Array(bytes));
}

function ebonyDaggerBiog(classIndex) {
  const q = [];
  q.push('1.\tWhat weapon did you keep?\r\na.\tAn ebony dagger.\r\n\t28 +6\r\n\tIT 3 0 7\r\n\tGP +50\r\nb.\tA dozen arrows.\r\n' + '\tIT 3 18 0\r\n'.repeat(12));
  for (let n = 2; n <= 12; n++) {
    q.push(`${n}.\tQuestion ${n}\r\na.\tYes\r\n\tr0 1\r\nb.\tNo\r\n\tr1 1\r\n`);
  }
  return K.parseBiog(q.join('\r\n'), classIndex);
}

function harness({ stdCatalogue = false, catalogue = null, classicData = null, careers, seed = 17 } = {}) {
  const players = new Map();
  const saved = new Map();
  const sent = [];
  let clock = 10_000;
  let worldMinutes = 0;
  const cat = catalogue ?? (stdCatalogue ? makeStdCatalogue() : undefined);
  const rng = seeded(seed);
  const rt = createRpgRuntime({
    players,
    features: [
      {
        name: 'character',
        install: (ctx) => {
          ctx.random = rng;
          ctx.careers = careers;
          ctx.classicData = classicData;
          if (cat) ctx.spellCatalogue = cat;
          ctx.services.worldClock = () => ({ minutes: worldMinutes, isNight: false });
          return character.install(ctx);
        },
      },
      { name: 'inventory', install: inventory },
      { name: 'magic', install: (ctx) => magic(ctx, cat ? { catalogue: cat } : {}) },
    ],
    save: (list) => { for (const p of list) saved.set(p.id, JSON.parse(JSON.stringify(p.rpg))); },
    send: (p, msg) => sent.push({ to: p.id, msg }),
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  return {
    rt, players, saved, sent,
    advanceMs(ms) { clock += ms; },
    advanceMinutes(min) { worldMinutes += min; },
    join(id, rpg, name = `Hero${id}`) {
      const p = { id, name, x: 0, z: 0, yaw: 0, moving: false, rpg: rpg ? structuredClone(rpg) : {} };
      players.set(id, p);
      rt.join(p);
      return p;
    },
  };
}

function createCharacter(h, p, { className = 'Warrior', custom = null, race = 'Breton', gender = 'Male', name = p.name, reflexes = 'Average', biography } = {}) {
  const d = new CharacterDraft(name);
  d.race = race; d.next();
  d.gender = gender; d.next();
  if (custom) {
    d.setMode('custom');
    d.custom = structuredClone(custom);
  } else {
    d.chooseClass(className);
  }
  assert.equal(d.stepProblem(), null, `class step valid for ${custom?.name ?? className}`);
  d.next();
  assert.equal(d.step, 'biography');
  d.next();
  d.name = name; d.next();
  d.faceIndex = 1; d.next();
  h.advanceMs(character.REROLL_COOLDOWN_MS + 10);
  const rolled = h.rt.act(p, 'character.roll', d.rollRequest());
  assert.deepEqual(rolled, { ok: true });
  d.syncRoll(p.rpg.character.draft);
  d.autoDistribute('attributes'); d.next();
  d.autoDistribute('skills'); d.next();
  d.reflexes = reflexes; d.next();
  assert.equal(d.step, 'summary');
  assert.equal(d.finalProblem(), null);
  const req = d.createRequest();
  if (biography !== undefined) req.biography = biography;
  const res = h.rt.act(p, 'character.create', req);
  assert.deepEqual(res, { ok: true });
  return p.rpg.character;
}

// ------------------------------------------------------------------ 1. Starting kit & spells across classic & custom classes

test('contrasting classic classes receive authentic starting gear, torch, potions and SPELLS.STD starting spells', () => {
  const h = harness({ stdCatalogue: true });

  const warrior = h.join(1, null, 'Boric');
  createCharacter(h, warrior, { className: 'Warrior', race: 'Nord', gender: 'Male', reflexes: 'Average' });
  assert.ok(warrior.rpg.inventory.some((i) => i.group === 'light' && i.template === 'torch'), 'Warrior starts with a torch');
  assert.ok(warrior.rpg.equipment.rightHand, 'Warrior has an equipped weapon');
  assert.equal(warrior.rpg.gold, 100);
  assert.deepEqual(warrior.rpg.magic.known, [], 'Warrior starts with no spells');

  const mage = h.join(2, null, 'Sera');
  createCharacter(h, mage, { className: 'Mage', race: 'High Elf', gender: 'Female', reflexes: 'High' });
  assert.ok(mage.rpg.inventory.some((i) => i.template === 'torch'), 'Mage starts with a torch');
  assert.ok(mage.rpg.inventory.some((i) => i.template === 'potion-of-magicka' && i.quantity >= 2), 'Mage starts with magicka potions');
  assert.ok(mage.rpg.inventory.some((i) => i.base === 'plain-robes'), 'Mage starts with plain robes');
  assert.ok(mage.rpg.inventory.some((i) => i.base === 'staff'), 'Mage starts with a staff');
  assert.deepEqual(mage.rpg.magic.known, STARTING_SPELLS.Mage.map((i) => `std:${i}`));
  assert.equal(mage.rpg.magic.selected, 'std:1');

  const spellsword = h.join(3, null, 'Kael');
  createCharacter(h, spellsword, { className: 'Spellsword', race: 'Dark Elf', gender: 'Male', reflexes: 'Average' });
  assert.ok(spellsword.rpg.inventory.some((i) => i.template === 'torch'));
  assert.ok(spellsword.rpg.inventory.some((i) => i.template === 'potion-of-magicka'));
  assert.deepEqual(spellsword.rpg.magic.known, STARTING_SPELLS.Spellsword.map((i) => `std:${i}`));
  assert.equal(spellsword.rpg.magic.selected, 'std:8');

  const thief = h.join(4, null, 'Vex');
  createCharacter(h, thief, { className: 'Thief', race: 'Khajiit', gender: 'Female', reflexes: 'Very High' });
  assert.ok(thief.rpg.inventory.some((i) => i.template === 'torch'));
  assert.deepEqual(thief.rpg.magic.known, [], 'Thief starts with no spells');

  const nightblade = h.join(5, null, 'Nyx');
  createCharacter(h, nightblade, { className: 'Nightblade', race: 'Wood Elf', gender: 'Female', reflexes: 'High' });
  assert.ok(nightblade.rpg.inventory.some((i) => i.template === 'torch'));
  assert.ok(nightblade.rpg.inventory.some((i) => i.template === 'potion-of-magicka'));
  assert.deepEqual(nightblade.rpg.magic.known, STARTING_SPELLS.Nightblade.map((i) => `std:${i}`));
  assert.equal(nightblade.rpg.magic.selected, 'std:44');

  // DFU StartGameBehaviour.AssignStartingSpells: a custom class with a magic primary or major skill gets the Spellsword set.
  const customCaster = h.join(6, null, 'Auren');
  createCharacter(h, customCaster, {
    custom: {
      name: 'Hexblade',
      hitPointsPerLevel: 12,
      attributes: { Strength: 50, Intelligence: 55, Willpower: 55, Agility: 50, Endurance: 50, Personality: 40, Speed: 50, Luck: 50 },
      primarySkills: ['Short Blade', 'Destruction', 'Restoration'],
      majorSkills: ['Illusion', 'Dodging', 'Stealth'],
      minorSkills: ['Climbing', 'Running', 'Swimming', 'Medical', 'Lockpicking', 'Streetwise'],
      advantages: [{ key: 'increasedMagery', option: '1.5x INT' }],
      disadvantages: [],
    },
    race: 'Breton',
    gender: 'Male',
  });
  assert.deepEqual(customCaster.rpg.magic.known, STARTING_SPELLS.Spellsword.map((i) => `std:${i}`));
  assert.ok(customCaster.rpg.inventory.some((i) => i.template === 'potion-of-magicka'));
  assert.ok(customCaster.rpg.inventory.some((i) => i.template === 'torch'));

  const customFighter = h.join(7, null, 'Brann');
  createCharacter(h, customFighter, {
    custom: {
      name: 'Bulwark',
      hitPointsPerLevel: 12,
      attributes: { Strength: 55, Intelligence: 50, Willpower: 50, Agility: 50, Endurance: 55, Personality: 40, Speed: 50, Luck: 50 },
      primarySkills: ['Long Blade', 'Axe', 'Blunt Weapon'],
      majorSkills: ['Dodging', 'Stealth', 'Climbing'],
      minorSkills: ['Running', 'Swimming', 'Medical', 'Lockpicking', 'Streetwise', 'Destruction'],
      advantages: [{ key: 'increasedMagery', option: '1.5x INT' }],
      disadvantages: [],
    },
    race: 'Nord',
    gender: 'Male',
  });
  assert.deepEqual(customFighter.rpg.magic.known, [], 'no magic primary or major skill: no starting spells');
});

test('fallback catalogue grants starting spells to casters and none to non-casters', () => {
  const h = harness({ stdCatalogue: false });
  const warrior = h.join(1, null, 'Garrick');
  createCharacter(h, warrior, { className: 'Warrior', race: 'Redguard' });
  assert.deepEqual(warrior.rpg.magic.known, []);

  const mage = h.join(2, null, 'Elara');
  createCharacter(h, mage, { className: 'Mage', race: 'Breton' });
  assert.deepEqual(mage.rpg.magic.known, FALLBACK_STARTING);
  assert.equal(mage.rpg.magic.selected, FALLBACK_STARTING[0]);
});

test('restricted class without legal starter weapons receives a legal backup weapon', () => {
  const careers = {
    ...R.CLASS_BY_NAME,
    Mage: {
      ...R.CLASS_BY_NAME.Mage,
      disadvantages: [
        { key: 'forbiddenWeaponry', option: 'Long Blade' },
        { key: 'forbiddenWeaponry', option: 'Axe' },
        { key: 'forbiddenWeaponry', option: 'Blunt Weapon' },
        { key: 'forbiddenWeaponry', option: 'Missile Weapons' },
        { key: 'forbiddenMaterial', option: 'Steel' },
      ],
    },
  };
  const h = harness({ careers, stdCatalogue: true });
  const mage = h.join(1, null, 'Alaric');
  createCharacter(h, mage, { className: 'Mage', race: 'High Elf' });
  const dagger = mage.rpg.inventory.find((i) => i.template === 'iron-dagger');
  assert.ok(dagger, 'received legal iron-dagger fallback weapon');
  assert.deepEqual(h.rt.act(mage, 'inventory.equip', { itemId: dagger.id }), { ok: true });
});

// ------------------------------------------------------------------ 2. Biography Ebony Dagger & resilience without ARENA2

test('classic biography grants Ebony Dagger, gold, a dozen arrows, and works with fate fallback', () => {
  const rsc = textRsc({ 4132: 'Born in %hpn, you carry your past.' });
  const biogs = new Map([[16, ebonyDaggerBiog(16)]]);
  const h = harness({ stdCatalogue: true, classicData: { rsc, biogs } });

  const p1 = h.join(1, null, 'Darian');
  createCharacter(h, p1, {
    className: 'Warrior', race: 'Breton',
    biography: { answers: [0, ...Array(11).fill(0)] },
  });
  assert.ok(p1.rpg.inventory.some((i) => i.template === 'ebony-dagger'), 'Ebony Dagger granted from biography');
  assert.equal(p1.rpg.gold, 150, 'starter gold + 50 biography gold');
  assert.equal(p1.rpg.character.biography.gold, 50);

  // Answer b on Q1 lists twelve arrow IT lines, like BIOG12T0.TXT "A dozen arrows": one arrow each.
  const p2 = h.join(2, null, 'Lyra');
  const arrowsBefore = p2.rpg.inventory.filter((i) => i.template === 'arrow').reduce((n, i) => n + i.quantity, 0);
  createCharacter(h, p2, {
    className: 'Warrior', race: 'Wood Elf',
    biography: { answers: [1, ...Array(11).fill(0)] },
  });
  const arrowsAfter = p2.rpg.inventory.filter((i) => i.template === 'arrow').reduce((n, i) => n + i.quantity, 0);
  assert.equal(arrowsAfter - arrowsBefore, 12, 'one arrow per biography IT line');

  // Client without local BIOG files sends { biography: { random: true } } when server has biography data.
  const d = new CharacterDraft('Fate');
  d.serverBiography = true;
  d.race = 'Nord'; d.next(); d.gender = 'Male'; d.next(); d.chooseClass('Warrior'); d.next();
  assert.equal(d.stepProblem('biography'), null);
  d.next(); d.name = 'Fate'; d.next(); d.next();
  const p3 = h.join(3, null, 'Fate');
  h.advanceMs(character.REROLL_COOLDOWN_MS + 10);
  h.rt.act(p3, 'character.roll', d.rollRequest());
  d.syncRoll(p3.rpg.character.draft);
  d.autoDistribute(); d.next(); d.next(); d.next();
  const req = d.createRequest();
  assert.deepEqual(req.biography, { random: true });
  assert.deepEqual(h.rt.act(p3, 'character.create', req), { ok: true });
  assert.equal(p3.rpg.character.biography.answers.length, 12);
});

const ARENA2 = localArena2();

test('real CLASS*.CFG, BIOG and SPELLS.STD: all 18 classes start with legal grants, their DFU spells and biography items as listed', { skip: !ARENA2 && 'needs gamedata/ARENA2' }, () => {
  const careers = character.loadCareers(ARENA2, { warn() {} });
  const classicData = character.loadClassicData(ARENA2, { warn() {} });
  const catalogue = loadCatalogue({ arena2Dir: ARENA2 });
  assert.equal(catalogue.source, 'SPELLS.STD');
  const h = harness({ careers, classicData, catalogue });
  const count = (p, t) => p.rpg.inventory.filter((i) => i.template === t).reduce((n, i) => n + i.quantity, 0);
  R.CLASSES.forEach((std, ci) => {
    assert.equal(careers[std.name].source, 'cfg', `${std.name} comes from CLASS${String(ci).padStart(2, '0')}.CFG`);
    const biog = classicData.biogs.get(ci);
    // Pick, for every question, the answer that lists the most arrows (classic lists one IT line per arrow).
    const arrowsIn = (a) => a.effects.filter((e) => /^IT\s+3\s+18\b/.test(e)).length;
    const answers = biog.questions.map((q) => q.answers.reduce((best, a, i) => (arrowsIn(a) > arrowsIn(q.answers[best]) ? i : best), 0));
    const listed = biog.questions.reduce((n, q, i) => n + arrowsIn(q.answers[answers[i]]), 0);
    const p = h.join(100 + ci, null, `Real ${String.fromCharCode(65 + ci)}`);
    const before = count(p, 'arrow');
    createCharacter(h, p, { className: std.name, biography: { answers } });
    assert.equal(count(p, 'arrow') - before, listed, `${std.name}: one arrow per biography IT line`);
    const expected = (STARTING_SPELLS[std.name] ?? []).map((i) => `std:${i}`);
    assert.deepEqual(p.rpg.magic.known, expected, `${std.name}: DFU starting spells, all present in SPELLS.STD`);
    const staff = p.rpg.inventory.find((i) => i.template === 'iron-staff');
    if (staff) assert.deepEqual(h.rt.act(p, 'inventory.equip', { itemId: staff.id }), { ok: true }, `${std.name} may wield its starter staff`);
  });
});

// ------------------------------------------------------------------ 3. Level-up formula, 6-hour rest check, caps, persistence

test('classic progression: reflexes, 6h rest check, level-up formula, HP & 4-6 bonus rolls, caps, and reload persistence', () => {
  // Verify effectiveUses across all 5 reflexes + invalid fallback to Average (not Very High).
  assert.equal(R.effectiveUses(100, 'Very High'), 125);
  assert.equal(R.effectiveUses(100, 'High'), 112);
  assert.equal(R.effectiveUses(100, 'Average'), 100);
  assert.equal(R.effectiveUses(100, 'Low'), 87);
  assert.equal(R.effectiveUses(100, 'Very Low'), 75);
  assert.equal(R.effectiveUses(100, undefined), 100, 'missing reflexes defaults to Average');
  assert.equal(R.effectiveUses(100, 'Bogus'), 100, 'unknown reflexes defaults to Average');

  const h = harness({ stdCatalogue: true, seed: 29 });
  const p = h.join(1, null, 'Rowan');
  const ch = createCharacter(h, p, { className: 'Spellsword', race: 'Redguard', reflexes: 'High' });
  const career = R.CLASS_BY_NAME.Spellsword;
  const startSum = ch.startingLevelUpSkillSum;
  const hpLevel1 = ch.maxHealth;
  assert.equal(R.levelFor(startSum, startSum), 1);
  assert.equal(R.levelFor(startSum, startSum + 1), 1);
  assert.equal(R.levelFor(startSum, startSum + 2), 2);
  assert.equal(R.levelFor(startSum, startSum + 17), 3);

  // Practice primary skills; 5 hours (< 360 min) does NOT trigger a skill increase.
  const [p0, p1] = career.primarySkills;
  const need0 = R.usesForAdvancement(ch.skills[p0], p0, career.advancementMultiplier, ch.level);
  const need1 = R.usesForAdvancement(ch.skills[p1], p1, career.advancementMultiplier, ch.level);
  h.rt.ctx.services.advanceSkill(p, p0, Math.min(100, need0));
  h.rt.ctx.services.advanceSkill(p, p1, Math.min(100, need1));
  if (ch.skillUses[p0] < need0) ch.skillUses[p0] = need0;
  if (ch.skillUses[p1] < need1) ch.skillUses[p1] = need1;

  h.advanceMinutes(300); // 5 hours
  h.rt.ctx.emit('timeSpent', { player: p, minutes: 300 });
  assert.equal(ch.level, 1, 'no skill check before 6 hours');

  // 1 more hour (total 6 hours = 360 min) triggers both primary increases (+2 sum -> Level 2!).
  h.advanceMinutes(60);
  h.rt.ctx.emit('timeSpent', { player: p, minutes: 60 });
  assert.equal(ch.level, 2, 'level 2 reached at +2 level-up skill sum');
  assert.equal(ch.currentLevelUpSkillSum, startSum + 2);
  assert.ok(ch.bonusPoints >= 4 && ch.bonusPoints <= 6, `4-6 bonus points rolled (got ${ch.bonusPoints})`);
  const endMod = R.hitPointsModifier(ch.attributes.Endurance);
  const hpGain = ch.maxHealth - hpLevel1;
  assert.ok(hpGain >= Math.max(1, Math.trunc(career.hitPointsPerLevel / 2) + endMod));
  assert.ok(hpGain <= Math.max(1, career.hitPointsPerLevel + endMod));

  // Allocate attribute points via LevelUpDraft and verify unknown keys are rejected.
  const lv = new LevelUpDraft(ch.attributes, ch.bonusPoints);
  while (lv.left() > 0) lv.up('Intelligence');
  assert.equal(lv.problem(), null);
  assert.equal(h.rt.act(p, 'character.levelUp', { attributes: { ...lv.attributes, Bogus: 1 } }).ok, false);
  assert.deepEqual(h.rt.act(p, 'character.levelUp', { attributes: lv.attributes }), { ok: true });
  assert.equal(p.rpg.character.bonusPoints, 0);
  assert.equal(p.rpg.character.attributes.Intelligence, lv.attributes.Intelligence);

  // Headroom edge case: when total remaining room to 100 is smaller than bonus pool, spending to 100 succeeds.
  const nearMax = Object.fromEntries(R.ATTRIBUTES.map((a) => [a, 100]));
  nearMax.Luck = 98;
  const lvCap = new LevelUpDraft(nearMax, 6);
  assert.equal(lvCap.left(), 2);
  assert.ok(lvCap.up('Luck'));
  assert.ok(lvCap.up('Luck'));
  assert.equal(lvCap.left(), 0);
  assert.equal(lvCap.problem(), null);
  assert.deepEqual(R.validateLevelSpend(nearMax, 6, lvCap.attributes).Luck, 100);

  // Skill mastery cap: once one primary reaches 100, other skills cap at 95.
  assert.equal(R.skillCeiling({ ...ch.skills, [p0]: 100, [p1]: 95 }, career, p1), 95);
  assert.equal(R.skillCeiling({ ...ch.skills, [p0]: 99, [p1]: 95 }, career, p1), 100);

  // Persistence across server reload preserves character, level, torch, and starting spells.
  const savedRow = h.saved.get(1);
  const h2 = harness({ stdCatalogue: true, seed: 99 });
  const reloaded = h2.join(1, savedRow, 'Rowan');
  assert.equal(reloaded.rpg.character.created, true);
  assert.equal(reloaded.rpg.character.level, 2);
  assert.equal(reloaded.rpg.character.attributes.Intelligence, p.rpg.character.attributes.Intelligence);
  assert.deepEqual(reloaded.rpg.magic.known, STARTING_SPELLS.Spellsword.map((i) => `std:${i}`));
  assert.ok(reloaded.rpg.inventory.some((i) => i.template === 'torch'));
});

// ------------------------------------------------------------------ 4. Pre-creation guard in client/gameplay/character.js

test('client pre-creation guard guides uncreated characters into the wizard and scopes prompt per character', async () => {
  const storage = new Map();
  const prevStorage = globalThis.sessionStorage;
  globalThis.sessionStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  try {
    const { install: installClient } = await import('../client/gameplay/character.js');
    const listeners = new Map();
    const opened = [];
    const api = {
      panel: null,
      state: { character: { character: { created: false, name: 'Guest1', classicData: { biography: false } } } },
      registerPanel: () => {},
      openPanel: (p) => { api.panel = p; opened.push(p); },
      on: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
      act: () => {},
    };
    installClient(api);
    assert.deepEqual(opened, ['character'], 'uncreated character auto-opens wizard');

    // A second distinct uncreated character in the same browser tab also gets prompted (not blocked by Guest1's key).
    api.panel = null;
    api.state = { character: { character: { created: false, name: 'Guest2', classicData: { biography: false } } } };
    for (const fn of listeners.get('state') ?? []) fn();
    assert.deepEqual(opened, ['character', 'character'], 'second uncreated character is not skipped');
  } finally {
    if (prevStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = prevStorage;
  }
});
