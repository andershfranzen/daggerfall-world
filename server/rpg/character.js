// Character feature: creation, character sheet state, skill/attribute/level progression and the stat
// resources (health, fatigue, magicka) other features spend. The server owns every number; the browser
// only proposes how to spend pools that the server rolled and remembers.
//
// Rules live in client/gameplay/character/rules.js (shared with the browser wizard; MIT notices for the
// adapted Daggerfall Unity formulas are in client/gameplay/character/NOTICE.txt).
//
// Persistent record: p.rpg.character
//   { version, created, name, gender, race, faceIndex, reflexes, className, custom|null,
//     attributes{8}, skills{35}, skillUses{35}, level, health, maxHealth, fatigue, maxFatigue,
//     magicka, maxMagicka, startingLevelUpSkillSum, currentLevelUpSkillSum, bonusPoints,
//     recentlyRaised[], lastSkillCheck, lastTraining, draft|null }
// `draft` holds the server's rolls during creation: { className, custom, attributeBase, bonusPool,
//   skillBase, rolls }. Clients see it (it is their own) but cannot change it except by rerolling.

import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as R from '../../client/gameplay/character/rules.js';
import { parseClassCfg, CLASS_FILE_RE } from '../../client/gameplay/character/cfg.js';
import * as K from '../../client/gameplay/character/classic.js';
import { isIndoors, recoveryPerHour } from '../../client/gameplay/atmosphere/calendar.js';
import { BASES, MATERIALS, isTemplate, maxEncumbrance, templateForClassic } from './inventory.js';
import { loadCatalogue, STARTING_SPELLS, FALLBACK_STARTING } from './magic/catalogue.js';

const OGHMA_BONUS_POOL = 30; // DaggerfallCharacterSheetWindow.oghmaBonusPool

export const VERSION = 1;
/** Fallback interval for standalone character runtimes without a world clock. */
export const SKILL_CHECK_MS = 60_000;
export const SKILL_CHECK_MINUTES = 360;
export const TRAINING_COOLDOWN_MINUTES = 720;
export const TRAINING_MINUTES = 180;
export const REROLL_COOLDOWN_MS = 250;
export const REGEN_STEP_S = 1;
export const MAX_ADVANCE_PER_CALL = 100;

const cryptoRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;

/**
 * Loads standard careers, replacing the built-in numbers with the operator's CLASS*.CFG records when a
 * directory is supplied. Files that fail to parse are ignored with a warning.
 */
export function loadCareers(dir, log = console) {
  const careers = Object.fromEntries(R.CLASSES.map((c) => [c.name, c]));
  if (!dir) return careers;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (err) {
    log.warn?.(`[character] cannot read class data in ${dir}: ${err.message}`);
    return careers;
  }
  for (const f of names) {
    const m = CLASS_FILE_RE.exec(f);
    if (!m) continue;
    const idx = Number(m[1]);
    const std = R.CLASSES[idx];
    if (!std) continue;
    try {
      const cfg = parseClassCfg(new Uint8Array(readFileSync(join(dir, f))));
      // Keep the stable name and presentation metadata; the installed file supplies the rules.
      careers[std.name] = Object.freeze({ ...std, ...cfg, name: std.name });
    } catch (err) {
      log.warn?.(`[character] ignoring ${f}: ${err.message}`);
    }
  }
  return careers;
}

/**
 * The career as the browser sees it: exactly the lists and numbers this server validates against
 * (built-in ruleset, the operator's CLASS*.CFG, or a validated custom class). Always recomputed by the
 * server; a client copy is never read back.
 */
export function careerView(c) {
  return {
    name: c.name,
    custom: !!c.custom,
    source: c.custom ? 'custom' : c.source === 'cfg' ? 'cfg' : 'ruleset',
    hitPointsPerLevel: c.hitPointsPerLevel,
    spellPointMultiplier: c.spellPointMultiplier,
    advancementMultiplier: c.advancementMultiplier,
    attributes: { ...c.attributes },
    primarySkills: [...c.primarySkills],
    majorSkills: [...c.majorSkills],
    minorSkills: [...c.minorSkills],
    advantages: c.advantages.map((a) => ({ ...a })),
    disadvantages: c.disadvantages.map((a) => ({ ...a })),
    noRegenMagicka: !!c.noRegenMagicka,
    ...(c.custom ? { difficulty: c.difficulty } : {}),
    group: c.group ?? 'Mixed',
    blurb: c.blurb ?? '',
  };
}

/**
 * The operator's classic creation data (TEXT.RSC + BIOGnnT0.TXT) from the ARENA2 directory, or null.
 * Read once; nothing is copied anywhere.
 */
export function loadClassicData(dir, log = console) {
  if (!dir) return null;
  try {
    const rsc = K.parseTextRsc(new Uint8Array(readFileSync(join(dir, findFile(dir, 'TEXT.RSC')))));
    const biogs = new Map();
    for (const f of readdirSync(dir)) {
      const m = K.BIOG_FILE_RE.exec(f);
      if (!m || m[2] !== '0') continue; // classic ships one template (T0) per class
      const ci = Number(m[1]);
      try {
        biogs.set(ci, K.parseBiog(K.decodeLatin1(readFileSync(join(dir, f))), ci));
      } catch (err) {
        log.warn?.(`[character] ignoring ${f}: ${err.message}`);
      }
    }
    return { rsc, biogs };
  } catch (err) {
    log.warn?.(`[character] classic biography data unavailable in ${dir}: ${err.message}`);
    return null;
  }
}

function findFile(dir, name) {
  return readdirSync(dir).find((f) => f.toUpperCase() === name) ?? name;
}

/** BIOG "IT group index material" → an inventory template key, or null when the catalogue has no match. */
export function biogItemTemplate({ group, index, material }) {
  const base = (classicIndex, groupName) => Object.entries(BASES).find(([, b]) => b.index === classicIndex && (!groupName || b.group === groupName))?.[0];
  let key = null;
  if (group === 3) { // ItemGroups.Weapons: Weapons enum starts at template 113; 18 is arrows
    if (index === 18) key = 'arrow';
    else {
      const b = base(113 + index, 'weapon');
      const m = MATERIALS.weapon[material];
      if (b && m) key = `${m}-${b}`;
    }
  } else if (group === 2) { // ItemGroups.Armor: Armor enum starts at template 102 (109+ are shields)
    const b = base(102 + index);
    if (b && BASES[b].group === 'shield') key = b;
    else if (b && MATERIALS.weapon[material]) key = `${MATERIALS.weapon[material]}-${b}`; // WeaponToArmorMaterialType
  } else if (group === 14) { // ItemGroups.Gems
    key = base(index, 'gem') ?? null;
  } else if (group === 9 || group === 18 || group === 19) { // ReligiousItems, Jewellery, MiscItems (incl. lights)
    key = templateForClassic(group, index);
  }
  return key && isTemplate(key) ? key : null;
}

const CUSTOM_SCHOOL_STARTER_SPELLS = Object.freeze({
  Destruction: [8],
  Restoration: [97],
  Illusion: [37, 44],
  Alteration: [1, 2],
  Thaumaturgy: [2],
  Mysticism: [1],
});
const ROBE_CLASSES = new Set(['Mage', 'Sorcerer', 'Healer']);
const STAFF_CLASSES = new Set(['Mage', 'Sorcerer', 'Healer', 'Monk']);

/** True when a standard or custom career starts with spellcasting capability. */
export function isSpellcastingCareer(career) {
  if (!career) return false;
  if (!career.custom && Object.hasOwn(STARTING_SPELLS, career.name)) return true;
  if ((career.spellPointMultiplier ?? 0) >= 1) return true;
  const core = [...(career.primarySkills ?? []), ...(career.majorSkills ?? [])];
  return core.some((s) => R.MAGIC_SKILLS.includes(s));
}

/** Starting spell ids for any standard or custom career against the active spell catalogue. */
export function startingSpellIdsForCareer(catalogue, career) {
  if (!catalogue?.spells || !career) return [];
  if (!career.custom) {
    const std = STARTING_SPELLS[career.name];
    if (!std?.length) return [];
    if (catalogue.source !== 'SPELLS.STD') return FALLBACK_STARTING.filter((id) => catalogue.spells.has(id));
    return std.map((i) => `std:${i}`).filter((id) => catalogue.spells.has(id));
  }
  if (!isSpellcastingCareer(career)) return [];
  if (catalogue.source !== 'SPELLS.STD') return FALLBACK_STARTING.filter((id) => catalogue.spells.has(id));
  const indices = new Set();
  for (const skill of [...(career.primarySkills ?? []), ...(career.majorSkills ?? [])]) {
    for (const idx of CUSTOM_SCHOOL_STARTER_SPELLS[skill] ?? []) indices.add(idx);
  }
  if (!indices.size) {
    indices.add(37); // Light
    indices.add(8); // Shock
  }
  return [...indices].map((i) => `std:${i}`).filter((id) => catalogue.spells.has(id));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt);

export function install(ctx) {
  const rng = typeof ctx.random === 'function' ? ctx.random : cryptoRandom;
  const careers = ctx.careers ?? loadCareers(ctx.dataPath ?? ctx.config?.arena2Dir ?? process.env.DFW_ARENA2 ?? null, ctx.log ?? console);
  const classic = ctx.classicData !== undefined ? ctx.classicData : loadClassicData(ctx.dataPath ?? ctx.config?.arena2Dir ?? process.env.DFW_ARENA2 ?? null, ctx.log ?? console);
  const hasBiography = !!classic?.biogs.size;
  const live = new Map();
  const services = (ctx.services ??= {});

  const liveOf = (p) => {
    let s = live.get(p.id);
    if (!s) {
      s = { lastRoll: -Infinity, regenAcc: 0, healAcc: 0, lastHazard: null };
      live.set(p.id, s);
    }
    return s;
  };

  // ---------------------------------------------------------------- careers & records

  function careerOf(ch) {
    if (ch?.custom) return ch.custom;
    return careers[ch?.className] ?? careers[R.DEFAULT_CLASS];
  }

  function personalMinutes(p) {
    if (services.playerMinutes) return services.playerMinutes(p);
    const clock = services.worldClock?.()?.minutes ?? ctx.now() * SKILL_CHECK_MINUTES / SKILL_CHECK_MS;
    return Math.floor(clock) + Math.max(0, Math.trunc(p.rpg?.atmosphere?.personalMinutes || 0));
  }

  function freshRecord(p, career, { attributes, skills, name, race, gender, faceIndex, reflexes, created }) {
    const maxHealth = R.maxHealthAtLevel1(career);
    const { maxFatigue, maxMagicka } = R.derivedMaxima(attributes, career);
    const sum = R.levelUpSkillSum(skills, career);
    return {
      version: VERSION,
      created,
      name: name ?? p.name,
      gender: gender ?? 'Male',
      race: race ?? R.DEFAULT_RACE,
      faceIndex: faceIndex ?? 0,
      reflexes: reflexes ?? 'Average',
      className: career.name,
      custom: career.custom ? career : null,
      career: careerView(career),
      traversal: traversalTraits(race ?? R.DEFAULT_RACE, career),
      attributes: { ...attributes },
      skills: { ...skills },
      skillUses: Object.fromEntries(R.SKILLS.map((s) => [s, 0])),
      level: 1,
      health: maxHealth,
      maxHealth,
      fatigue: maxFatigue,
      maxFatigue,
      magicka: maxMagicka,
      maxMagicka,
      startingLevelUpSkillSum: sum,
      currentLevelUpSkillSum: sum,
      bonusPoints: 0,
      oghmaBonus: 0,
      recentlyRaised: [],
      lastSkillCheck: personalMinutes(p),
      lastTraining: null,
      biography: null,
      classicData: { biography: hasBiography },
      draft: null,
    };
  }

  function defaultRecord(p) {
    const career = careers[R.DEFAULT_CLASS];
    return freshRecord(p, career, { ...R.defaultBuild(career), created: false });
  }

  /** Repairs records from older builds or a damaged database. Never grants anything beyond the rules. */
  function normalize(p) {
    p.rpg ??= {};
    let ch = p.rpg.character;
    if (!isPlainObject(ch) || !isPlainObject(ch.attributes) || !isPlainObject(ch.skills)) {
      p.rpg.character = defaultRecord(p);
      return p.rpg.character;
    }
    if (ch.custom) {
      try {
        ch.custom = R.buildCustomClass(ch.custom);
      } catch {
        ch.custom = null;
        ch.className = R.DEFAULT_CLASS;
      }
    } else if (!careers[ch.className]) ch.className = R.DEFAULT_CLASS;
    const career = careerOf(ch);
    for (const a of R.ATTRIBUTES) ch.attributes[a] = clampInt(ch.attributes[a], 1, R.MAX_STAT, career.attributes[a]);
    for (const k of Object.keys(ch.attributes)) if (!R.ATTRIBUTES.includes(k)) delete ch.attributes[k];
    ch.skillUses = isPlainObject(ch.skillUses) ? ch.skillUses : {};
    for (const s of R.SKILLS) {
      ch.skills[s] = clampInt(ch.skills[s], 0, R.MAX_SKILL, 5);
      ch.skillUses[s] = clampInt(ch.skillUses[s], 0, R.SKILL_USES_CAP, 0);
    }
    for (const k of Object.keys(ch.skills)) if (!(k in R.SKILL_INDEX)) delete ch.skills[k];
    for (const k of Object.keys(ch.skillUses)) if (!(k in R.SKILL_INDEX)) delete ch.skillUses[k];
    ch.version = VERSION;
    ch.created = ch.created === true;
    ch.name = R.cleanCharacterName(ch.name) ?? p.name;
    if (!R.RACE_BY_NAME[ch.race]) ch.race = R.DEFAULT_RACE;
    if (!R.GENDERS.includes(ch.gender)) ch.gender = 'Male';
    if (!R.REFLEXES.includes(ch.reflexes)) ch.reflexes = 'Average';
    ch.faceIndex = clampInt(ch.faceIndex, 0, R.FACE_COUNT - 1, 0);
    ch.level = clampInt(ch.level, 1, 100, 1);
    const sum = R.levelUpSkillSum(ch.skills, career);
    ch.currentLevelUpSkillSum = sum;
    ch.startingLevelUpSkillSum = clampInt(ch.startingLevelUpSkillSum, 0, 1000, sum);
    // A level can never exceed what the skills earn (protects against edited saves).
    const earned = Math.max(1, R.levelFor(ch.startingLevelUpSkillSum, sum));
    if (ch.level > earned) ch.level = earned;
    const hpCeil = R.maxHealthAtLevel1(career) + (ch.level - 1) * (career.hitPointsPerLevel + 5);
    ch.maxHealth = clampInt(ch.maxHealth, 1, hpCeil, R.maxHealthAtLevel1(career));
    // Unspent Oghma Infinium points (package 16, DaggerfallCharacterSheetWindow.oghmaBonusPool = 30 per reading) sit
    // on top of the level-up pool until spent, so normalization and restarts keep them.
    ch.oghmaBonus = clampInt(ch.oghmaBonus, 0, 3 * OGHMA_BONUS_POOL, 0);
    ch.bonusPoints = clampInt(ch.bonusPoints, 0, (ch.level - 1) * R.LEVEL_BONUS_POOL[1] + ch.oghmaBonus, 0);
    if (ch.oghmaBonus > ch.bonusPoints) ch.oghmaBonus = ch.bonusPoints;
    ch.recentlyRaised = Array.isArray(ch.recentlyRaised) ? ch.recentlyRaised.filter((s) => s in R.SKILL_INDEX).slice(0, 35) : [];
    ch.biography = sanitizeBiography(ch.biography);
    ch.classicData = { biography: hasBiography };
    if (ch.draft && !validDraft(ch.draft)) ch.draft = null;
    ch.draft ??= null;
    ch.lastSkillCheck = clampInt(ch.lastSkillCheck, 0, Number.MAX_SAFE_INTEGER, personalMinutes(p));
    ch.lastTraining = clampInt(ch.lastTraining, 0, Number.MAX_SAFE_INTEGER, null);
    recomputeMaxima(p);
    return ch;
  }

  function sanitizeBiography(b) {
    if (!isPlainObject(b)) return null;
    const int = (v, lo, hi) => clampInt(v, lo, hi, 0);
    return {
      classIndex: int(b.classIndex, 0, 17),
      answers: Array.isArray(b.answers) ? b.answers.slice(0, K.BIOG_QUESTION_COUNT).map((a) => int(a, 0, 20)) : [],
      skills: isPlainObject(b.skills) ? Object.fromEntries(Object.entries(b.skills).filter(([k, v]) => k in R.SKILL_INDEX && Number.isFinite(v)).map(([k, v]) => [k, int(v, -100, 100)])) : {},
      socialGroups: K.SOCIAL_GROUPS.map((_, i) => int(b.socialGroups?.[i], -100, 100)),
      mods: isPlainObject(b.mods) ? Object.fromEntries(Object.entries(b.mods).filter(([k, v]) => ['resistPoison', 'fatigue', 'reaction', 'resistDisease', 'resistMagic', 'avoidHit'].includes(k) && Number.isFinite(v)).map(([k, v]) => [k, int(v, -100, 100)])) : {},
      factions: isPlainObject(b.factions) ? Object.fromEntries(Object.entries(b.factions).filter(([k, v]) => /^\d+$/.test(k) && Number.isFinite(v)).map(([k, v]) => [k, int(v, -100, 100)])) : {},
      gold: int(b.gold, 0, 100000),
      items: Array.isArray(b.items) ? b.items.slice(0, 40).filter(isPlainObject).map((it) => ({ template: typeof it.template === 'string' ? it.template.slice(0, 64) : null, group: int(it.group, 0, 40), index: int(it.index, 0, 255), material: int(it.material, 0, 20) })) : [],
      backstory: Array.isArray(b.backstory) ? b.backstory.slice(0, 40).map((l) => String(l).slice(0, 4000)) : [], // paragraphs
    };
  }

  /** Server-side biography: validate answers against the operator's BIOG file and digest the effects. */
  function resolveBiography(p, career, raceName, request) {
    if (!hasBiography) return null;
    const careerList = R.CLASSES.map((c) => careers[c.name]);
    const classIndex = K.biogClassIndex(career, careerList);
    const biog = classic.biogs.get(classIndex);
    if (!biog) return null;
    let answers;
    if (request == null || request.random === true) answers = K.randomBiogAnswers(biog, rng);
    else if (isPlainObject(request)) answers = K.checkBiogAnswers(biog, request.answers);
    else throw new Error('Answer the biography questions or let fate decide.');
    const digest = K.digestBiogEffects(K.biogEffects(biog, answers));
    const backstory = K.backstoryLines(classic.rsc, biog, digest, { race: raceName, pick: ((r) => (n) => Math.floor(r() * n))(K.seededRandom(`${raceName}:${answers.join('')}`)) });
    return { classIndex, answers, digest, backstory };
  }

  function validDraft(d) {
    if (!isPlainObject(d) || !isPlainObject(d.attributeBase) || !isPlainObject(d.skillBase)) return false;
    if (d.custom) {
      try { d.custom = R.buildCustomClass(d.custom); } catch { return false; }
    } else if (!careers[d.className]) return false;
    d.career = careerView(d.custom ?? careers[d.className]);
    return Number.isInteger(d.bonusPool) && d.bonusPool >= R.STAT_BONUS_POOL[0] && d.bonusPool <= R.STAT_BONUS_POOL[1];
  }

  function recomputeMaxima(p, refreshCareer = true) {
    const ch = p.rpg.character;
    const career = careerOf(ch);
    if (refreshCareer) ch.career = careerView(career);
    // ImprovesTalents (package 16): equipped items raise the career's own Acute Hearing, Athleticism and
    // Adrenaline Rush. The traversal traits follow whatever is worn now.
    const improved = improvedTalents(p, career);
    const traversal = traversalTraits(ch.race, career, improved);
    let talentsChanged = JSON.stringify(ch.traversal) !== JSON.stringify(traversal);
    ch.traversal = traversal;
    if (improved.length) {
      talentsChanged ||= String(ch.improvedTalents) !== String(improved);
      ch.improvedTalents = improved;
    } else if (ch.improvedTalents) {
      delete ch.improvedTalents;
      talentsChanged = true;
    }
    const attributes = {};
    for (const key of R.ATTRIBUTES) {
      const value = effectiveAttribute(p, key);
      if (value !== ch.attributes[key]) attributes[key] = value;
    }
    const changed = talentsChanged || R.ATTRIBUTES.some((key) => ch.effectiveAttributes?.[key] !== attributes[key]);
    if (Object.keys(attributes).length) ch.effectiveAttributes = attributes;
    else delete ch.effectiveAttributes;
    const { maxFatigue, maxMagicka: rawMagicka } = R.derivedMaxima({ ...ch.attributes, ...attributes }, career);
    const magery = characterMagery(p);
    // DaggerfallEntity.GetMaxMagicka: raw maximum + MaxMagickaModifier (ExtraSpellPts, Mace of Molag Bal overflow).
    const bonus = Math.max(0, Math.trunc(Number(services.maxMagickaModifier?.(p)) || 0));
    const maxMagicka = magery.blocked ? 0 : rawMagicka - (magery.multiplier < 1 ? Math.trunc(rawMagicka * 33 / 100) : 0) + bonus;
    ch.maxFatigue = maxFatigue;
    ch.maxMagicka = maxMagicka;
    ch.health = clampInt(ch.health, 0, ch.maxHealth, ch.maxHealth);
    ch.fatigue = clampInt(ch.fatigue, 0, maxFatigue, maxFatigue);
    ch.magicka = clampInt(ch.magicka, 0, maxMagicka, maxMagicka);
    return changed;
  }

  function requireCharacter(p) {
    const ch = p.rpg?.character;
    if (!ch) throw new Error('Your character is not ready yet.');
    return ch;
  }

  // ---------------------------------------------------------------- progression

  /** Original six-hour skill check. The clock and tallies are kept with the character. */
  function raiseSkills(p, force = false) {
    const ch = p.rpg?.character;
    if (!ch || ch.health <= 0) return [];
    const now = personalMinutes(p);
    if (!force && now - ch.lastSkillCheck < SKILL_CHECK_MINUTES) return [];
    ch.lastSkillCheck = now;
    ctx.dirty(p);
    const career = careerOf(ch);
    const raised = [];
    for (const skill of R.SKILLS) {
      const value = ch.skills[skill];
      const needed = R.usesForAdvancement(value, skill, career.advancementMultiplier, ch.level);
      if (R.effectiveUses(ch.skillUses[skill], ch.reflexes) < needed) continue;
      ch.skillUses[skill] = 0;
      if (value < R.skillCeiling(ch.skills, career, skill)) {
        ch.skills[skill] = value + 1;
        raised.push(skill);
        if (!ch.recentlyRaised.includes(skill)) ch.recentlyRaised.push(skill);
      }
    }
    if (!raised.length) return raised;
    ch.currentLevelUpSkillSum = R.levelUpSkillSum(ch.skills, career);
    for (const skill of raised) {
      ctx.notify(p, { kind: 'skillRaised', skill, value: ch.skills[skill], text: `Your ${skill} skill has improved to ${ch.skills[skill]}.` });
      if (ch.skills[skill] === R.MAX_SKILL && career.primarySkills.includes(skill)) {
        ctx.notify(p, { kind: 'skillMastered', skill, text: `You have become a master of ${skill}.` });
      }
      ctx.emit('skillRaised', { player: p, skill, value: ch.skills[skill] });
    }
    checkLevelUp(p);
    return raised;
  }

  /** PlayerEntity.CheckForLevelUp + the character sheet's level-up step (HP roll, 4–6 bonus points). */
  function checkLevelUp(p) {
    const ch = p.rpg.character;
    const career = careerOf(ch);
    const target = R.levelFor(ch.startingLevelUpSkillSum, ch.currentLevelUpSkillSum);
    while (ch.level < target && ch.level < 100) {
      ch.level += 1;
      const hp = R.hitPointsPerLevelUp(career, ch.attributes.Endurance, rng);
      ch.maxHealth += hp;
      ch.health = Math.min(ch.maxHealth, ch.health + hp);
      const pool = R.rangeInclusive(rng, ...R.LEVEL_BONUS_POOL);
      ch.bonusPoints += pool;
      ctx.notify(p, { kind: 'levelUp', level: ch.level, hitPoints: hp, bonusPoints: pool, text: `You are now level ${ch.level}. Distribute ${ch.bonusPoints} attribute points on your character sheet.` });
      ctx.emit('levelUp', { player: p, level: ch.level });
    }
  }

  function tallySkill(p, name, amount) {
    if (!Object.hasOwn(R.SKILL_INDEX, name)) throw new Error(`Unknown skill "${name}".`);
    const ch = p.rpg?.character;
    if (!ch) return null;
    if (amount > 0) {
      ch.skillUses[name] = Math.min(R.SKILL_USES_CAP, (ch.skillUses[name] ?? 0) + amount);
      ctx.dirty(p);
    }
    return ch;
  }

  function advanceSkill(p, name, amount = 1) {
    const ch = tallySkill(p, name, clampInt(amount, 0, MAX_ADVANCE_PER_CALL, 0));
    if (!ch) return null;
    const raised = raiseSkills(p);
    return { skill: name, value: ch.skills[name], uses: ch.skillUses[name], raised: raised.includes(name) };
  }

  function characterTraining(p, skill, { max = 50, commit = false } = {}) {
    const ch = p.rpg?.character;
    if (!ch || !Object.hasOwn(R.SKILL_INDEX, skill) || ch.health <= 0) {
      return { ok: false, reason: 'unavailable', value: 0, max, minutesLeft: 0 };
    }
    const now = personalMinutes(p);
    const value = ch.skills[skill];
    const minutesLeft = ch.lastTraining == null ? 0 : Math.max(0, ch.lastTraining + TRAINING_COOLDOWN_MINUTES - now);
    const ceiling = R.skillCeiling(ch.skills, careerOf(ch), skill);
    max = Math.min(max, ceiling - 1);
    const reason = value > max ? 'cap' : minutesLeft ? 'cooldown' : null;
    if (!reason && commit) {
      ch.lastTraining = now;
      tallySkill(p, skill, R.rangeInclusive(rng, 10, 20) * R.SKILL_ADVANCEMENT[skill]);
      services.spendFatigue(p, Math.floor(11 * TRAINING_MINUTES / 64));
      if (services.spendTime) services.spendTime(p, TRAINING_MINUTES, 'training');
      else {
        p.rpg.atmosphere ??= {};
        p.rpg.atmosphere.personalMinutes = (p.rpg.atmosphere.personalMinutes ?? 0) + TRAINING_MINUTES;
      }
      ctx.dirty(p);
      raiseSkills(p);
    }
    return { ok: !reason, reason, value, max, minutesLeft };
  }

  // ---------------------------------------------------------------- resources

  function spend(p, field, cost) {
    const ch = p.rpg?.character;
    const n = clampInt(cost, 0, 1e6, 0);
    if (!ch || ch[field] < n) return false;
    if (n === 0) return true;
    ch[field] -= n;
    ctx.dirty(p);
    return true;
  }

  function restore(p, field, maxField, amount) {
    const ch = p.rpg?.character;
    if (!ch) return 0;
    const n = clampInt(amount, 0, 1e6, 0);
    const before = ch[field];
    ch[field] = Math.min(ch[maxField], before + n);
    if (ch[field] !== before) ctx.dirty(p);
    return ch[field] - before;
  }

  function damagePlayer(p, amount, source = null) {
    const ch = p.rpg?.character;
    if (!ch) return null;
    const n = clampInt(amount, 0, 1e6, 0);
    if (ch.health <= 0) return { health: 0, damage: 0, dead: true };
    ch.health = Math.max(0, ch.health - n);
    ctx.dirty(p);
    // PlayerEntity.SetHealth: a guild benefit (Temple of Stendarr, package 15) may leave the player on 10 % health.
    if (ch.health === 0 && services.avoidDeath?.(p, source) === true) ch.health = Math.max(1, Math.trunc(ch.maxHealth * 0.1));
    const dead = ch.health === 0;
    if (dead) ctx.emit('playerDowned', { player: p, source });
    return { health: ch.health, damage: n, dead };
  }

  function revive(p, fraction = 1) {
    const ch = p.rpg?.character;
    if (!ch) return;
    const f = Math.min(1, Math.max(0.01, Number(fraction) || 1));
    ch.health = Math.max(1, Math.floor(ch.maxHealth * f));
    ch.fatigue = Math.max(ch.fatigue, Math.floor(ch.maxFatigue * f));
    ctx.dirty(p);
  }

  // ---------------------------------------------------------------- live scores and career rules

  const baseAttribute = (actor, name) => {
    if (!Object.hasOwn(R.ATTRIBUTE_ABBR, name)) return 0;
    const attributes = actor?.rpg?.character?.attributes ?? actor?.attributes ?? actor?._career?.attributes ?? actor?._mcareer?.attributes;
    return attributes?.[name] ?? actor?.[name.toLowerCase()] ?? 0;
  };

  function effectiveAttribute(actor, name) {
    const base = baseAttribute(actor, name);
    if (!base) return base;
    const magic = Number(services.magicAttributeModifier?.(actor, name)) || 0;
    const penalty = Number(services.conditionAttributePenalty?.(actor, name)) || 0;
    const blessing = Number(services.blessingModifier?.(actor, name)) || 0; // package 15: temple blessings
    return clampInt(base + magic - penalty + blessing, 1, 200, base);
  }

  function hasAbility(p, key, option) {
    const ch = p.rpg?.character;
    if (!ch) return false;
    const c = careerOf(ch);
    const matches = (a) => a.key === key && (option == null || a.option === option);
    return c.advantages.some(matches) || c.disadvantages.some(matches);
  }

  function weaponRestriction(p, skill) {
    const group = skill === 'Archery' ? 'Missile Weapons' : skill;
    return !!group && hasAbility(p, 'forbiddenWeaponry', group) ? `Your class forbids ${group}.` : null;
  }

  function equipmentRestriction(p, item) {
    const { group, material } = item ?? {};
    if (group !== 'weapon' && group !== 'armor' && group !== 'shield') return null;
    const materialName = material ? material[0].toUpperCase() + material.slice(1) : null;
    if (materialName && hasAbility(p, 'forbiddenMaterial', materialName)) return `Your class forbids ${materialName} equipment.`;
    if (group === 'weapon') return weaponRestriction(p, item.skill);
    if (group === 'shield') {
      const shield = BASES[item.base]?.name ?? item.name;
      return hasAbility(p, 'forbiddenShieldTypes', shield) ? `Your class forbids ${shield}s.` : null;
    }
    const armor = material === 'chain' || material === 'leather' ? materialName : 'Plate';
    return hasAbility(p, 'forbiddenArmorType', armor) ? `Your class forbids ${armor} armor.` : null;
  }

  function characterSavingThrow(p, kind) {
    const key = String(kind).toLowerCase();
    const option = { cold: 'Frost', frost: 'Frost', magicka: 'Magic', magic: 'Magic', disease: 'Disease', poison: 'Poison',
      fire: 'Fire', shock: 'Shock', paralysis: 'Paralysis' }[key];
    if (!option) return { immune: false, critical: false, modifier: 0 };
    const ch = p.rpg?.character;
    const race = R.RACE_BY_NAME[ch?.race];
    const bio = { Disease: 'resistDisease', Poison: 'resistPoison', Magic: 'resistMagic' }[option];
    const immune = !!race?.immune?.includes(option) || hasAbility(p, 'immunity', option);
    const critical = !immune && hasAbility(p, 'criticalWeakness', option);
    let modifier = ch?.biography?.mods?.[bio] ?? 0;
    if (race?.resist?.includes(option)) modifier += 30;
    if (hasAbility(p, 'resistance', option)) modifier += 25;
    if (hasAbility(p, 'lowTolerance', option)) modifier -= 25;
    return { immune, critical, modifier };
  }

  function environment(p) {
    const location = p.rpg?.location;
    const indoors = isIndoors(location);
    const isNight = services.worldClock?.()?.isNight ?? false;
    return { light: !indoors && !isNight, indoors, dungeon: location?.startsWith('dungeon:'), isNight };
  }

  function characterMagery(p) {
    const light = environment(p).light;
    const power = light ? 'darknessPoweredMagery' : 'lightPoweredMagery';
    const place = light ? 'daylight' : 'darkness';
    return {
      blocked: hasAbility(p, power, `unable to use magic in ${place}`),
      multiplier: hasAbility(p, power, `lower magic ability in ${place}`) ? 0.67 : 1,
      absorbs: hasAbility(p, 'spellAbsorption', 'general') || hasAbility(p, 'spellAbsorption', light ? 'in light' : 'in darkness'),
    };
  }

  function characterAttackModifiers(p, { skill, group, armed = skill !== 'Hand-to-Hand' } = {}) {
    const ch = p.rpg?.character;
    const level = ch?.level ?? 1;
    let racial = 0;
    if (armed && ch?.race === 'Dark Elf') racial = Math.floor(level / 4);
    if (armed && ((ch?.race === 'Wood Elf' && skill === 'Archery') || (ch?.race === 'Redguard' && skill !== 'Archery'))) {
      racial = Math.floor(level / 3);
    }
    const expertise = hasAbility(p, 'expertiseIn', skill === 'Archery' ? 'Missile Weapons' : skill);
    const enemy = group && hasAbility(p, 'bonusToHit', group) ? level : group && hasAbility(p, 'phobia', group) ? -level : 0;
    return { toHit: racial + (expertise ? level : 0), damage: racial + enemy + (expertise ? Math.floor(level / 3) + 1 : 0) };
  }

  function languageCheck(p, skill, { roll = Math.floor(rng() * 200), bonus = 0 } = {}) {
    if (!R.SKILL_CATEGORIES.Languages.includes(skill)) return null;
    const value = services.skillValue(p, skill);
    const personality = effectiveAttribute(p, 'Personality');
    const human = skill === 'Etiquette' || skill === 'Streetwise';
    const skillChance = human ? Math.floor(value / 10) + Math.floor(personality / 5) : value + Math.floor(personality / 10);
    const chance = Math.max(0, Math.min(200, skillChance + (p.rpg?.readied ? -25 : 10) + bonus));
    return { skill, chance, success: roll < chance };
  }

  function characterTraversal(p) {
    const ch = p.rpg?.character;
    const career = careerOf(ch);
    return traversalTraits(ch?.race, career, p.rpg ? improvedTalents(p, career) : []);
  }

  /**
   * ImprovesTalents only strengthens an advantage the career already has (PlayerEntity fatigue loss, AcrobatMotor
   * jump, FormulaHelper.CalculateAdrenalineRushToHit and DaggerfallEnemy hearing all check the career first).
   */
  function improvedTalents(p, career) {
    if (!p?.rpg?.character) return [];
    career ??= careerOf(p.rpg.character);
    const worn = services.enchantmentModifiers?.(p)?.talents ?? [];
    return ['acuteHearing', 'athleticism', 'adrenalineRush'].filter((key) => worn.includes(key) && career.advantages.some((a) => a.key === key));
  }

  function traversalTraits(race, career, improved = []) {
    const athletic = career.advantages.some((a) => a.key === 'athleticism');
    const better = athletic && improved.includes('athleticism');
    return {
      climbingBonus: race === 'Khajiit' ? 30 : 0,
      swimmingBonus: race === 'Argonian' ? 100 : 0,
      exertionMultiplier: athletic ? (better ? 0.8 : 0.9) : 1,
      jumpMultiplier: athletic ? (better ? 1.2 : 1.1) : 1,
    };
  }

  function characterRestRecovery(p) {
    const ch = p.rpg.character;
    const rapid = hasAbility(p, 'rapidHealing', 'general') || hasAbility(p, 'rapidHealing', environment(p).light ? 'in light' : 'in darkness');
    return recoveryPerHour(ch, { endurance: effectiveAttribute(p, 'Endurance'), rapid, noMagicka: careerOf(ch).noRegenMagicka });
  }

  const baseSkillValue = (p, name) => Object.hasOwn(R.SKILL_INDEX, name) ? p.rpg?.character?.skills?.[name] ?? 0 : 0;

  function skillValue(p, name) {
    if (!Object.hasOwn(R.SKILL_INDEX, name)) return 0;
    const base = baseSkillValue(p, name);
    const modifier = (Number(services.conditionSkillModifier?.(p, name)) || 0) + (Number(services.blessingModifier?.(p, name)) || 0)
      + (Number(services.enchantmentSkillModifier?.(p, name)) || 0); // EnhancesSkill (package 16)
    return clampInt(base + modifier, 0, 200, base);
  }

  function modifiers(p) {
    if (!p.rpg?.character) return null;
    return {
      toHit: R.attributeModifier(effectiveAttribute(p, 'Agility')),
      damage: R.attributeModifier(effectiveAttribute(p, 'Strength')),
      magicResist: Math.floor(effectiveAttribute(p, 'Willpower') / 10) + (p.rpg.character.biography?.mods?.resistMagic ?? 0),
      avoidHit: p.rpg.character.biography?.mods?.avoidHit ?? 0, // BiographyAvoidHitMod (lowers attackers' to-hit)
      hitPoints: R.hitPointsModifier(effectiveAttribute(p, 'Endurance')),
      encumbrance: maxEncumbrance(p.rpg, effectiveAttribute(p, 'Strength')),
    };
  }

  Object.assign(services, {
    advanceSkill,
    characterTraining,
    equipmentRestriction,
    weaponRestriction,
    characterSavingThrow,
    characterMagery,
    characterAttackModifiers,
    characterTraversal,
    improvedTalents: (p) => improvedTalents(p),
    /** Re-derive maxima and traversal now (equipment or enchantment modifiers changed). */
    refreshCharacterMaxima: (p) => {
      if (!p?.rpg?.character) return false;
      const changed = recomputeMaxima(p, false);
      ctx.dirty(p);
      return changed;
    },
    characterRestRecovery,
    languageCheck,
    characterOf: (p) => p.rpg?.character ?? null,
    careerOf: (p) => (p.rpg?.character ? careerOf(p.rpg.character) : null),
    skillValue,
    attributeValue: effectiveAttribute,
    baseAttribute,
    effectiveAttribute,
    baseSkillValue,
    characterModifiers: modifiers,
    /** Biography modifiers (resistPoison, fatigue, reaction, resistDisease, resistMagic, avoidHit). */
    biographyModifiers: (p) => ({ ...(p.rpg?.character?.biography?.mods ?? {}) }),
    /** Standing with a classic social group (0 Commoners … 4 Underworld) from the biography. */
    socialReputation: (p, group) => p.rpg?.character?.biography?.socialGroups?.[group] ?? 0,
    spendMagicka: (p, cost) => spend(p, 'magicka', cost),
    /** Exertion always drains (to zero at worst); returns whether the character had enough. */
    spendFatigue: (p, cost) => {
      if (spend(p, 'fatigue', cost)) return true;
      const ch = p.rpg?.character;
      if (ch && ch.fatigue > 0) { ch.fatigue = 0; ctx.dirty(p); }
      return false;
    },
    restoreMagicka: (p, n) => restore(p, 'magicka', 'maxMagicka', n),
    restoreFatigue: (p, n) => restore(p, 'fatigue', 'maxFatigue', n),
    healPlayer: (p, n) => restore(p, 'health', 'maxHealth', n),
    damagePlayer,
    revivePlayer: revive,
    hasAbility,
  });

  // ---------------------------------------------------------------- lifecycle

  ctx.onJoin((p) => {
    const before = JSON.stringify(p.rpg?.character ?? null);
    normalize(p);
    liveOf(p);
    if (JSON.stringify(p.rpg.character) !== before) ctx.dirty(p);
    if (!p.rpg.character.created) {
      ctx.notify(p, { kind: 'characterNeeded', text: 'Create your character to begin your own story. You can play with a default warrior until then.' });
    }
  });

  ctx.onLeave((p) => {
    live.delete(p.id);
  });

  ctx.on?.('timeSpent', ({ player }) => raiseSkills(player));
  ctx.on?.('restHour', ({ player }) => tallySkill(player, 'Medical', 1));

  ctx.onTick((dt) => {
    for (const p of ctx.players.values()) {
      const ch = p.rpg?.character;
      if (!ch) continue;
      const s = liveOf(p);
      s.regenAcc += dt;
      if (s.regenAcc < REGEN_STEP_S) continue;
      const steps = Math.floor(s.regenAcc / REGEN_STEP_S);
      s.regenAcc -= steps * REGEN_STEP_S;
      const career = careerOf(ch);
      const previousMaxFatigue = ch.maxFatigue;
      const previousMaxMagicka = ch.maxMagicka;
      let changed = recomputeMaxima(p, false);
      changed ||= ch.maxFatigue !== previousMaxFatigue || ch.maxMagicka !== previousMaxMagicka;
      const gameMinutes = services.worldClock?.()?.minutes;
      if (gameMinutes != null) {
        const hazardRound = Math.floor(gameMinutes / 4);
        if (s.lastHazard != null && hazardRound > s.lastHazard && ch.health > 0) {
          const env = environment(p);
          const location = p.rpg.location;
          const holy = services.isHolyPlace?.(p) ?? (location?.startsWith('temple:') || services.portals?.into?.(location)?.meta?.buildingType === 14);
          const source = env.light && hasAbility(p, 'damage', 'from sunlight') ? 'sunlight'
            : holy && hasAbility(p, 'damage', 'from holy places') ? 'holy ground' : null;
          if (source) {
            if (services.hurtPlayerBy) services.hurtPlayerBy(p, 12, { name: source, source });
            else damagePlayer(p, 12, source);
          }
          const regenerates = hasAbility(p, 'regenerateHealth', 'general')
            || hasAbility(p, 'regenerateHealth', env.isNight || env.dungeon ? 'in darkness' : 'in light')
            || (services.isSwimming?.(p) && hasAbility(p, 'regenerateHealth', 'while immersed'));
          if (regenerates && ch.health > 0) restore(p, 'health', 'maxHealth', 1);
        }
        s.lastHazard = hazardRound;
      }
      if (ch.health > 0) {
        if (!p.moving && !services.isResting?.(p) && ch.fatigue < ch.maxFatigue) {
          const per = Math.max(1, Math.floor(ch.maxFatigue / 40));
          ch.fatigue = Math.min(ch.maxFatigue, ch.fatigue + per * steps);
          changed = true;
        }
        if (!career.noRegenMagicka && !services.isResting?.(p) && ch.magicka < ch.maxMagicka) {
          const per = Math.max(1, Math.floor(ch.maxMagicka / 120));
          ch.magicka = Math.min(ch.maxMagicka, ch.magicka + per * steps);
          changed = true;
        }
        if (!services.isResting?.(p) && ch.health < ch.maxHealth) {
          s.healAcc += steps * Math.max(0.1, 0.2 + R.hitPointsModifier(effectiveAttribute(p, 'Endurance')) * 0.04);
          const whole = Math.floor(s.healAcc);
          if (whole > 0) {
            s.healAcc -= whole;
            ch.health = Math.min(ch.maxHealth, ch.health + whole);
            changed = true;
          }
        }
      }
      if (raiseSkills(p).length) changed = true;
      if (changed) ctx.dirty(p);
    }
  });

  // ---------------------------------------------------------------- actions

  ctx.onAction('character.roll', (p, args = {}) => {
    const ch = requireCharacter(p);
    if (ch.created) throw new Error('Your character has already been created.');
    const s = liveOf(p);
    const now = ctx.now();
    if (now - s.lastRoll < REROLL_COOLDOWN_MS) throw new Error('Wait a moment before rolling again.');
    let career;
    if (args.custom != null) {
      career = R.buildCustomClass(args.custom);
    } else {
      career = careers[args.className];
      if (!career) throw new Error('Choose a class.');
    }
    s.lastRoll = now;
    const { base: attributeBase, bonusPool } = R.rollAttributes(career, rng);
    const { base: skillBase } = R.rollSkills(career, rng);
    ch.draft = {
      className: career.name,
      custom: career.custom ? career : null,
      career: careerView(career),
      attributeBase,
      bonusPool,
      skillBase,
      rolls: (ch.draft?.className === career.name ? ch.draft.rolls : 0) + 1,
    };
    return { attributeBase, bonusPool, skillBase };
  });

  ctx.onAction('character.cancel', (p) => {
    const ch = requireCharacter(p);
    ch.draft = null;
  });

  ctx.onAction('character.create', (p, args = {}) => {
    const ch = requireCharacter(p);
    if (ch.created) throw new Error('Your character has already been created.');
    const d = ch.draft;
    if (!d) throw new Error('Roll your attributes first.');
    const career = d.custom ?? careers[d.className];
    if (!career) throw new Error('Your class is no longer available. Choose again.');
    if (!isPlainObject(args)) throw new Error('Invalid character.');
    const name = args.name == null ? R.cleanCharacterName(p.name) : R.cleanCharacterName(args.name);
    if (!name) throw new Error('Enter a name using letters, spaces, apostrophes or hyphens (up to 24).');
    if (!R.RACE_BY_NAME[args.race]) throw new Error('Choose a race.');
    if (!R.GENDERS.includes(args.gender)) throw new Error('Choose a gender.');
    const reflexes = args.reflexes ?? 'Average';
    if (!R.REFLEXES.includes(reflexes)) throw new Error('Choose your reflexes.');
    const faceIndex = args.faceIndex ?? 0;
    if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= R.FACE_COUNT) throw new Error('Choose a face.');
    const attributes = R.validateAttributeSpend(d.attributeBase, d.bonusPool, args.attributes);
    const skills = R.validateSkillSpend(d.skillBase, career, args.skills);
    const bio = resolveBiography(p, career, args.race, args.biography);
    if (bio) {
      // CreateCharAddBonusSkills: biography skill effects are added on top of the distributed values.
      for (const [skill, mod] of Object.entries(bio.digest.skills)) skills[skill] = Math.max(0, Math.min(R.MAX_SKILL, skills[skill] + mod));
    }
    p.rpg.character = freshRecord(p, career, { attributes, skills, name, race: args.race, gender: args.gender, faceIndex, reflexes, created: true });
    if (bio) p.rpg.character.biography = applyBiography(p, bio);
    grantStartingEquipment(p, career);
    grantStartingSpells(p, career);
    recomputeMaxima(p);
    ctx.notify(p, { kind: 'characterCreated', text: `${name} the ${args.race} ${career.name} begins a new life.` });
    ctx.emit('characterCreated', { player: p, character: p.rpg.character });
    return { created: true };
  });

  let spellCatalogue = null;
  function getSpellCatalogue() {
    if (!spellCatalogue) {
      spellCatalogue = ctx.spellCatalogue ?? ctx.catalogue ?? loadCatalogue({
        arena2Dir: ctx.dataPath ?? ctx.config?.arena2Dir ?? process.env.DFW_ARENA2 ?? null,
        spellsStd: ctx.spellsStd ?? null,
      });
    }
    return spellCatalogue;
  }

  /**
   * Classic starting supplies on creation (when inventory is installed): a torch for Privateer's Hold,
   * magicka potions/robes/staff for casters, and a legal fallback weapon when class restrictions forbid
   * the default starter weaponry.
   */
  function grantStartingEquipment(p, career) {
    const S = ctx.services;
    if (!Array.isArray(p.rpg?.inventory) || typeof S.giveItem !== 'function') return;
    const inv = p.rpg.inventory;
    const has = (pred) => inv.some(pred);
    const giveSafe = (template, qty = 1) => {
      if (!isTemplate(template)) return;
      try {
        S.giveItem(p, template, qty);
      } catch (err) {
        ctx.log?.warn?.(`[character] starter item ${template} not given: ${err.message}`);
      }
    };
    if (!has((i) => i.group === 'light')) giveSafe('torch', 1);
    if (isSpellcastingCareer(career)) {
      if (!has((i) => i.template === 'potion-of-magicka')) giveSafe('potion-of-magicka', 2);
      if (ROBE_CLASSES.has(career.name) && !has((i) => i.base === 'plain-robes')) giveSafe('plain-robes', 1);
    }
    const wantsStaff = STAFF_CLASSES.has(career.name)
      || career.primarySkills.includes('Blunt Weapon')
      || career.majorSkills.includes('Blunt Weapon');
    if (wantsStaff && !has((i) => i.base === 'staff')
      && !equipmentRestriction(p, { group: 'weapon', material: 'iron', skill: 'Blunt Weapon' })) {
      giveSafe('iron-staff', 1);
    }
    const hasLegalWeapon = has((i) => i.group === 'weapon' && !equipmentRestriction(p, i));
    if (!hasLegalWeapon) {
      for (const [template, skill] of [['iron-dagger', 'Short Blade'], ['iron-staff', 'Blunt Weapon'], ['iron-mace', 'Blunt Weapon'], ['iron-longsword', 'Long Blade']]) {
        if (!equipmentRestriction(p, { group: 'weapon', material: 'iron', skill })) {
          giveSafe(template, 1);
          break;
        }
      }
    }
  }

  /**
   * Grant class starting spells on character creation (magic.js runs grantStarting on join while the
   * player is still the default uncreated Warrior, so spellcasters would otherwise start with none).
   */
  function grantStartingSpells(p, career) {
    const m = p.rpg?.magic;
    if (!m || !Array.isArray(m.known)) return;
    const cat = getSpellCatalogue();
    const ids = startingSpellIdsForCareer(cat, career);
    m.known = [...new Set(ids)];
    m.granted = true;
    m.selected = m.known.find((id) => cat.spells.get(id)?.support !== 'unsupported') ?? null;
    ctx.dirty(p);
  }

  /** Gold, items and faction standing go through their owning features; the rest is kept on the sheet. */
  function applyBiography(p, bio) {
    const { digest } = bio;
    const S = ctx.services;
    let gold = 0;
    if (digest.gold > 0 && typeof S.giveItem === 'function') {
      S.giveItem(p, 'gold', digest.gold);
      gold = digest.gold;
    }
    const items = digest.items.map((it) => {
      const template = biogItemTemplate(it);
      let given = null;
      if (template && typeof S.giveItem === 'function') {
        try {
          S.giveItem(p, template, template === 'arrow' ? 20 : 1);
          given = template;
        } catch (err) {
          ctx.log?.warn?.(`[character] biography item ${template} not given: ${err.message}`);
        }
      }
      return { template: given, ...it };
    });
    const factions = {};
    for (const [id, delta] of Object.entries(digest.factions)) {
      if (typeof S.adjustReputation !== 'function') continue;
      const before = S.reputation?.(p, Number(id));
      const after = S.adjustReputation(p, Number(id), delta);
      if (before === undefined || after !== before) factions[id] = delta;
    }
    return sanitizeBiography({
      classIndex: bio.classIndex, answers: bio.answers, skills: digest.skills, socialGroups: digest.socialGroups,
      mods: digest.mods, factions, gold, items, backstory: bio.backstory,
    });
  }

  ctx.onAction('character.levelUp', (p, args = {}) => {
    const ch = requireCharacter(p);
    if (!ch.bonusPoints) throw new Error('You have no attribute points to distribute.');
    const next = R.validateLevelSpend(ch.attributes, ch.bonusPoints, args.attributes);
    ch.attributes = next;
    ch.bonusPoints = 0;
    ch.oghmaBonus = 0;
    recomputeMaxima(p);
    ctx.notify(p, { kind: 'attributesRaised', text: 'Your attributes have improved.' });
  });

  ctx.onAction('character.clearRecent', (p) => {
    const ch = requireCharacter(p);
    ch.recentlyRaised = [];
  });

  return { careers, normalize, raiseSkills, careerOf };
}
