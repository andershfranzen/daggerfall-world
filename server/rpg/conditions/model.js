// Pure condition state machine for one character (no ctx). The feature (server/rpg/conditions.js)
// owns persistence, time sources and side effects; this module turns elapsed character minutes into
// classic outcomes. Rules adapted from Daggerfall Unity (MIT); see ./tables.js for the sources.
//
// rpg.conditions = {
//   version: 1,
//   time,                     the character's own classic-minute clock (see conditions.js)
//   seq,                      record id counter
//   diseases: [{id, type, contractedAt, lastDay, incubationOver, daysLeft, loss:{Attr:n}}]
//   poisons:  [{id, type, state:'waiting'|'active'|'complete', startIn, minutesLeft, mods:{Attr:±n}, positiveRemoved}]
//   infection: null | {kind:'vampirism'|'werewolf'|'wereboar', startDay, clanFactionId, dreamed}
//   vampire:   null | {clanFactionId, lastFed, since}
//   lycanthrope: null | {form:'werewolf'|'wereboar', transformed, lastMorph, lastKill, since}
//   previousClanFactionId: null | number,
//   sun: minutes of sunlight not yet charged, ticks: {quest, cure} last quest ticks announced
// }

import {
  ATTRIBUTES, DISEASES, POISONS, PERMANENT, CLANS, DEFAULT_CLAN, poisonMinute, diseaseOf, poisonOf,
  VAMPIRE_STATS, VAMPIRE_STAT_BONUS, VAMPIRE_SKILLS, BEAST_STATS, BEAST_STAT_BONUS, BEAST_SKILLS,
  SUPERNATURAL_SKILL_BONUS, VAMPIRE_SATED_MINUTES, NEED_TO_KILL_MINUTES, NEED_TO_KILL_LOSS_PER_DAY,
  NEED_TO_KILL_MIN_HEALTH, MORPH_COOLDOWN_MINUTES, INFECTION_DREAM_DAYS, INFECTION_DEPLOY_DAYS,
} from './tables.js';

export const VERSION = 1;
export const MAX_RECORDS = 32;
const DAY = 1440;
const QUEST_PERIOD = 54720; // 38 days (PlayerEntity racial override quest)
const CURE_QUEST_PERIOD = 120960; // 84 days

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const statMap = (raw, signed) => {
  const out = {};
  if (!isObj(raw)) return out;
  for (const a of ATTRIBUTES) {
    const n = int(raw[a]);
    if (n && (signed || n > 0)) out[a] = Math.max(-1000, Math.min(1000, n));
  }
  return out;
};
const SUPER = new Set(['vampirism', 'werewolf', 'wereboar']);

/** Normalizes stored state in place (unknown or malformed entries are dropped). */
export function normalize(rpg, now) {
  const raw = isObj(rpg.conditions) ? rpg.conditions : {};
  const time = Number.isFinite(raw.time) ? Math.trunc(raw.time) : Math.trunc(now);
  const diseases = (Array.isArray(raw.diseases) ? raw.diseases : []).filter((d) => isObj(d) && DISEASES[d.type]).slice(0, MAX_RECORDS).map((d) => ({
    id: int(d.id), type: d.type, contractedAt: int(d.contractedAt, time), lastDay: int(d.lastDay, Math.floor(time / DAY)),
    incubationOver: d.incubationOver === true, daysLeft: int(d.daysLeft, PERMANENT), loss: statMap(d.loss, false),
  }));
  const poisons = (Array.isArray(raw.poisons) ? raw.poisons : []).filter((p) => isObj(p) && POISONS[p.type]).slice(0, MAX_RECORDS).map((p) => ({
    id: int(p.id), type: p.type, state: ['waiting', 'active', 'complete'].includes(p.state) ? p.state : 'complete',
    startIn: Math.max(0, int(p.startIn)), minutesLeft: Math.max(0, int(p.minutesLeft)), mods: statMap(p.mods, true),
    positiveRemoved: p.positiveRemoved === true,
  }));
  const inf = isObj(raw.infection) && SUPER.has(raw.infection.kind) ? raw.infection : null;
  const vam = isObj(raw.vampire) ? raw.vampire : null;
  const lyc = isObj(raw.lycanthrope) && ['werewolf', 'wereboar'].includes(raw.lycanthrope.form) ? raw.lycanthrope : null;
  const clan = (v) => (CLANS[v] ? int(v) : DEFAULT_CLAN);
  rpg.conditions = {
    version: VERSION, time, seq: Math.max(0, int(raw.seq)), diseases, poisons,
    infection: inf ? { kind: inf.kind, startDay: int(inf.startDay, Math.floor(time / DAY)), clanFactionId: clan(inf.clanFactionId), dreamed: inf.dreamed === true } : null,
    vampire: vam ? { clanFactionId: clan(vam.clanFactionId), lastFed: int(vam.lastFed, time), since: int(vam.since, time) } : null,
    lycanthrope: lyc ? { form: lyc.form, transformed: lyc.transformed === true, lastMorph: int(lyc.lastMorph, time - MORPH_COOLDOWN_MINUTES - 1), lastKill: int(lyc.lastKill, time), since: int(lyc.since, time) } : null,
    previousClanFactionId: CLANS[raw.previousClanFactionId] ? int(raw.previousClanFactionId) : null,
    sun: Math.max(0, Math.min(1e6, int(raw.sun))),
    ticks: { quest: int(raw.ticks?.quest, Math.floor(time / QUEST_PERIOD)), cure: int(raw.ticks?.cure, Math.floor(time / CURE_QUEST_PERIOD)) },
  };
  return rpg.conditions;
}

// ------------------------------------------------------------------ immunity and modifiers

export function immuneTo(st, kind) {
  if (kind === 'disease') return !!(st.vampire || st.lycanthrope);
  if (kind === 'paralysis') return !!st.vampire;
  return false;
}

/** Positive = lowers the attribute; negative = supernatural bonus. */
export function attributePenalty(st, attr) {
  let n = 0;
  for (const d of st.diseases) n += d.loss[attr] ?? 0;
  for (const p of st.poisons) n -= p.mods[attr] ?? 0;
  if (st.vampire && (VAMPIRE_STATS.includes(attr) || (attr === 'Intelligence' && st.vampire.clanFactionId === 157))) n -= VAMPIRE_STAT_BONUS;
  if (st.lycanthrope?.transformed && BEAST_STATS.includes(attr)) n -= BEAST_STAT_BONUS;
  return n;
}

export function skillModifier(st, skill) {
  let n = 0;
  if (st.vampire && VAMPIRE_SKILLS.includes(skill)) n += SUPERNATURAL_SKILL_BONUS;
  if (st.lycanthrope?.transformed && BEAST_SKILLS.includes(skill)) n += SUPERNATURAL_SKILL_BONUS;
  return n;
}

export const isSated = (st) => !!st.vampire && st.time - st.vampire.lastFed <= VAMPIRE_SATED_MINUTES;

/** LycanthropyEffect max-health limiter, or null when the urge is satisfied. */
export function healthLimit(st, maxHealth, { hircine = false } = {}) {
  const l = st.lycanthrope;
  if (!l || hircine) return null; // GetNeedToKill: never while Hircine's Ring is worn
  const urge = st.time - l.lastKill - NEED_TO_KILL_MINUTES;
  if (urge <= 0) return null;
  const reduction = Math.round(urge * (NEED_TO_KILL_LOSS_PER_DAY / DAY));
  return Math.max(NEED_TO_KILL_MIN_HEALTH, Math.trunc(maxHealth) - reduction);
}

// ------------------------------------------------------------------ contracting

const nextId = (st) => ++st.seq;

/** DiseaseEffect.Start. Returns the record, or null if already incumbent / immune. */
export function addDisease(st, type, rng) {
  const d = DISEASES[type];
  if (!d || immuneTo(st, 'disease') || st.diseases.some((x) => x.type === type) || st.diseases.length >= MAX_RECORDS) return null;
  const rec = {
    id: nextId(st), type, contractedAt: st.time, lastDay: Math.floor(st.time / DAY), incubationOver: false,
    daysLeft: d.permanent ? PERMANENT : d.minDays + Math.floor(rng() * (d.maxDays - d.minDays + 1)), loss: {},
  };
  st.diseases.push(rec);
  return rec;
}

/** PoisonEffect.Start. */
export function addPoison(st, type, rng) {
  const p = POISONS[type];
  if (!p || st.poisons.some((x) => x.type === type && x.state !== 'complete') || st.poisons.length >= MAX_RECORDS) return null;
  st.poisons = st.poisons.filter((x) => x.type !== type); // a fresh dose replaces a spent one
  const rec = {
    id: nextId(st), type, state: 'waiting',
    startIn: p.minStart + Math.floor(rng() * (p.maxStart - p.minStart + 1)),
    minutesLeft: p.minRounds + Math.floor(rng() * (p.maxRounds - p.minRounds + 1)),
    mods: {}, positiveRemoved: false,
  };
  if (rec.startIn <= 0) rec.state = 'active';
  st.poisons.push(rec);
  return rec;
}

export function startInfection(st, kind, clanFactionId) {
  if (!SUPER.has(kind) || st.infection || st.vampire || st.lycanthrope) return null;
  st.infection = { kind, startDay: Math.floor(st.time / DAY), clanFactionId: CLANS[clanFactionId] ? clanFactionId : DEFAULT_CLAN, dreamed: false };
  return st.infection;
}

export const infectionDue = (infection, minute) => !!infection && Math.floor(minute / DAY) - infection.startDay >= INFECTION_DEPLOY_DAYS;

/** Full curse (DeployFullBlownVampirism / Lycanthropy): cures every other condition. */
export function deploy(st, kind, clanFactionId) {
  st.infection = null;
  st.diseases = [];
  st.poisons = [];
  if (kind === 'vampirism') {
    st.lycanthrope = null;
    st.vampire = { clanFactionId: CLANS[clanFactionId] ? clanFactionId : DEFAULT_CLAN, lastFed: st.time, since: st.time };
  } else {
    st.vampire = null;
    st.lycanthrope = { form: kind, transformed: false, lastMorph: st.time - MORPH_COOLDOWN_MINUTES - 1, lastKill: st.time, since: st.time };
  }
  st.ticks = { quest: Math.floor(st.time / QUEST_PERIOD), cure: Math.floor(st.time / CURE_QUEST_PERIOD) };
}

// ------------------------------------------------------------------ cures

/** Returns the number of records removed. */
export function cure(st, kind) {
  let n = 0;
  if (kind === 'disease' || kind === 'all') {
    n += st.diseases.length;
    st.diseases = [];
    if (st.infection) { st.infection = null; n += 1; }
  }
  if (kind === 'poison' || kind === 'all') {
    n += st.poisons.length;
    st.poisons = [];
  }
  if (kind === 'attributes') {
    for (const d of st.diseases) if (Object.keys(d.loss).length) { d.loss = {}; n += 1; }
    for (const p of st.poisons) {
      const neg = Object.entries(p.mods).filter(([, v]) => v < 0);
      if (!neg.length) continue;
      for (const [a] of neg) delete p.mods[a];
      n += 1;
    }
    st.poisons = st.poisons.filter((p) => p.state !== 'complete' || Object.values(p.mods).some((v) => v < 0));
  }
  if ((kind === 'vampirism' || kind === 'all') && st.vampire) {
    st.previousClanFactionId = st.vampire.clanFactionId;
    st.vampire = null;
    n += 1;
  }
  if ((kind === 'lycanthropy' || kind === 'all') && st.lycanthrope) {
    st.lycanthrope = null;
    n += 1;
  }
  return n;
}

/** Quest `cure <disease>`: removes one named disease (and its attribute damage). Returns 0 or 1. */
export function cureDisease(st, type) {
  const before = st.diseases.length;
  st.diseases = st.diseases.filter((d) => d.type !== type);
  return before - st.diseases.length;
}

/** Heal-Attribute: restores up to `amount` points of condition damage to one attribute. */
export function healAttribute(st, attr, amount) {
  let left = Math.max(0, Math.trunc(amount));
  const start = left;
  for (const d of st.diseases) {
    const v = d.loss[attr] ?? 0;
    const k = Math.min(v, left);
    if (k > 0) { d.loss[attr] = v - k; left -= k; if (!d.loss[attr]) delete d.loss[attr]; }
  }
  for (const p of st.poisons) {
    const v = -(p.mods[attr] ?? 0);
    const k = Math.min(v, left);
    if (k > 0) { p.mods[attr] += k; left -= k; if (!p.mods[attr]) delete p.mods[attr]; }
  }
  // PoisonEffect.CompletePoison: a spent poison ends once every attribute is healed.
  st.poisons = st.poisons.filter((p) => p.state !== 'complete' || Object.values(p.mods).some((v) => v < 0));
  return start - left;
}

// ------------------------------------------------------------------ time

/**
 * Advance the character clock by `minutes`. `env`:
 *   rng()                      [0,1)
 *   sunMinutes: number         minutes of this stretch spent outdoors in shared daylight
 *   fullMoon: boolean          either moon full on the shared calendar now
 *   maxHealth: number
 * Returns a list of outcome objects the feature turns into vitals changes and messages:
 *   {type:'vitals', health, fatigue, magicka, cause}   positive = loss (negative fatigue/magicka = gain)
 *   {type:'symptoms', disease}  {type:'diseaseEnded', disease}  {type:'poisonActive'|'poisonSpent', poison}
 *   {type:'dream', kind}  {type:'deploy', kind, clanFactionId}  {type:'fullMoon'}  {type:'quest', cure}
 */
export function advance(st, minutes, env) {
  const out = [];
  const m = Math.max(0, Math.trunc(minutes));
  const wasVampire = !!st.vampire;
  const vit = { health: 0, fatigue: 0, magicka: 0 };
  const roll = (a, b) => a + Math.floor(env.rng() * (b - a)); // UnityEngine.Random.Range(int,int)

  // Poisons run per game minute (one magic round).
  for (let i = 0; i < m && st.poisons.some((p) => p.state !== 'complete'); i++) {
    for (const p of st.poisons) {
      if (p.state === 'complete') continue;
      if (p.state === 'waiting') {
        if (--p.startIn > 0) continue;
        p.state = 'active';
        out.push({ type: 'poisonActive', poison: p });
      }
      const e = poisonMinute(p.type, roll);
      for (const [a, v] of Object.entries(e.stats)) p.mods[a] = (p.mods[a] ?? 0) + v;
      vit.health += e.health;
      vit.fatigue += e.fatigue;
      vit.magicka += e.magicka;
      if (--p.minutesLeft <= 0) {
        p.state = 'complete';
        out.push({ type: 'poisonSpent', poison: p });
      }
    }
  }
  for (const p of st.poisons) {
    if (p.state !== 'complete') continue;
    if (POISONS[p.type].drug && !p.positiveRemoved) {
      for (const [a, v] of Object.entries(p.mods)) if (v > 0) delete p.mods[a];
      p.positiveRemoved = true;
    }
  }
  st.poisons = st.poisons.filter((p) => p.state !== 'complete' || Object.values(p.mods).some((v) => v < 0));

  const before = st.time;
  st.time += m;
  const today = Math.floor(st.time / DAY);

  // Diseases: daily (DiseaseEffect.UpdateDisease).
  for (const d of [...st.diseases]) {
    const days = today - d.lastDay;
    if (days <= 0) continue;
    const t = DISEASES[d.type];
    if (!d.incubationOver) {
      d.incubationOver = true;
      out.push({ type: 'symptoms', disease: d });
    }
    for (let i = 0; i < days; i++) {
      const dmg = roll(t.minDamage, t.maxDamage + 1);
      for (const a of ATTRIBUTES) if (t.stats[a]) d.loss[a] = (d.loss[a] ?? 0) + t.stats[a] * dmg;
      vit.health += t.health * dmg;
      vit.fatigue += t.fatigue * dmg;
      vit.magicka += t.magicka * dmg;
    }
    d.lastDay = today;
    if (!t.permanent && (d.daysLeft -= days) <= 0) {
      st.diseases.splice(st.diseases.indexOf(d), 1);
      out.push({ type: 'diseaseEnded', disease: d });
    }
  }

  // Supernatural infection: dream after a day, curse after more than three.
  if (st.infection) {
    const days = today - st.infection.startDay;
    if (days >= INFECTION_DREAM_DAYS && !st.infection.dreamed) {
      st.infection.dreamed = true;
      out.push({ type: 'dream', kind: st.infection.kind });
    }
    if (infectionDue(st.infection, st.time) && st.infection.dreamed && !(st.infection.kind === 'vampirism' && env.deferVampire)) {
      const { kind, clanFactionId } = st.infection;
      deploy(st, kind, clanFactionId);
      out.push({ type: 'deploy', kind, clanFactionId });
    }
  }

  // Vampire sunlight (PassiveSpecialsEffect.DamageFromSunlight: 12 health / 4 minutes).
  const sunMinutes = Math.min(m, Math.max(0, Math.trunc(env.sunMinutes ?? 0)));
  if (wasVampire && sunMinutes > 0) {
    st.sun += sunMinutes;
    const hits = Math.floor(st.sun / 4);
    st.sun -= hits * 4;
    if (hits) vit.health += hits * 12;
    if (hits) out.push({ type: 'sunlight', damage: hits * 12 });
  } else st.sun = 0;

  // ForceTransformDuringFullMoon does not happen while Hircine's Ring is worn.
  if (st.lycanthrope && env.fullMoon && !env.hircine && !st.lycanthrope.transformed) {
    st.lycanthrope.transformed = true;
    st.lycanthrope.lastMorph = st.time;
    out.push({ type: 'fullMoon' });
  }

  // Racial override quests (PlayerEntity: every 38 and 84 days of the classic minute counter).
  if (st.vampire || st.lycanthrope) {
    const q = Math.floor(st.time / QUEST_PERIOD), c = Math.floor(st.time / CURE_QUEST_PERIOD);
    if (q > st.ticks.quest) out.push({ type: 'quest', cure: false });
    if (c > st.ticks.cure) out.push({ type: 'quest', cure: true });
    st.ticks = { quest: q, cure: c };
  }

  if (vit.health || vit.fatigue || vit.magicka) out.unshift({ type: 'vitals', ...vit, from: before });
  return out;
}

/** LycanthropyEffect.MorphSelf. */
export function morph(st, { force = false, hircine = false } = {}) {
  const l = st.lycanthrope;
  if (!l) return { ok: false, transformed: false, reason: 'You are not a lycanthrope.' };
  // CanCastMorphSelf: Hircine's Ring lifts the once-a-day limit.
  if (!l.transformed && !force && !hircine && st.time - l.lastMorph <= MORPH_COOLDOWN_MINUTES) {
    return { ok: false, transformed: false, reason: 'You can only do this once per day.' };
  }
  l.transformed = !l.transformed;
  l.lastMorph = st.time;
  return { ok: true, transformed: l.transformed };
}

export { diseaseOf, poisonOf };
