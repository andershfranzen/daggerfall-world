// Conversation rules for information requests (work package 3): speaking tone, the speaker's reaction
// (Etiquette for a polite tone, Streetwise for a blunt one), what a speaker knows, and local news and rumours
// built from the town's real buildings and people. DOM-free and deterministic, so it is unit tested directly.
//
// The rules follow the shape of the classic talk window: three tones, a social group per speaker that prefers
// one of them, and skill-based acceptance. The numbers, groups and every line below are this project's own.

import { hash32, skillValue } from './rules.js';

export const TONES = Object.freeze(['polite', 'normal', 'blunt']);
export const TONE_LABELS = Object.freeze({ polite: 'Polite', normal: 'Normal', blunt: 'Blunt' });
/** Skill each tone leans on; a normal tone uses the better of the two at half weight. */
export const TONE_SKILL = Object.freeze({ polite: 'Etiquette', blunt: 'Streetwise' });

/** How each social group takes each tone (added to the acceptance chance, percent). */
export const TONE_FIT = Object.freeze({
  nobility: { polite: 20, normal: 0, blunt: -30 },
  learned: { polite: 10, normal: 0, blunt: -15 },
  merchants: { polite: 5, normal: 5, blunt: -10 },
  commoners: { polite: -5, normal: 5, blunt: 5 },
  underworld: { polite: -20, normal: 0, blunt: 20 },
});
const ATTITUDE_BONUS = { friendly: 25, neutral: 0, cold: -20, hostile: -100 };
/** Refusals in one conversation before the speaker stops answering questions. */
export const PATIENCE = 3;

const NOBLE_TITLE = /\b(king|queen|prince|princess|lord|lady|baron|baroness|duke|duchess|count|countess|knight|squire|marquis|chancellor|steward)\b/i;

/** The speaker's social group, from the fields the people reader publishes. */
export function socialGroup(e) {
  if (!e) return 'commoners';
  if (e.guild === 'thieves' || e.guild === 'brotherhood' || e.role === 'thieves' || e.role === 'brotherhood' || e.role === 'witch') return 'underworld';
  const g = e._castleGroup ?? e._workGroup;
  if (g === 'Nobility' || e.role === 'noble' || NOBLE_TITLE.test(e.title ?? '')) return 'nobility';
  if (e.guild || e.role === 'priest' || e.role === 'mages' || e.role === 'knights') return 'learned';
  if (g === 'Merchants' || e.shop || e.bank || e.role === 'merchant' || e.role === 'shopkeeper' || e.role === 'banker' || e.role === 'innkeeper') return 'merchants';
  return 'commoners';
}

/** The tone that suits a group best (shown as a hint after a refusal). */
export const preferredTone = (group) => Object.entries(TONE_FIT[group] ?? TONE_FIT.commoners).sort((a, b) => b[1] - a[1])[0][0];

/** Acceptance chance (5..95 %) for this player, speaker and tone. */
export function reactionChance(character, e, tone, attitude = 'neutral') {
  const t = TONES.includes(tone) ? tone : 'normal';
  const group = socialGroup(e);
  const skill = t === 'normal'
    ? Math.max(skillValue(character, 'Etiquette'), skillValue(character, 'Streetwise')) / 2
    : skillValue(character, TONE_SKILL[t]);
  const per = Number(character?.attributes?.personality ?? character?.attributes?.Personality ?? 50);
  const raw = 45 + skill / 2 + (TONE_FIT[group]?.[t] ?? 0) + (ATTITUDE_BONUS[attitude] ?? 0) + (Number.isFinite(per) ? (per - 50) / 4 : 0);
  return Math.max(5, Math.min(95, Math.round(raw)));
}

/**
 * One reaction roll. `seed` must change per question (session counter) so a refusal is not permanent, and
 * stays stable for the same question so a replayed request gets the same answer.
 * @returns {{ok:boolean, chance:number, roll:number, group:string, tone:string, skill:string|null}}
 */
export function react(character, e, tone, attitude, seed) {
  const t = TONES.includes(tone) ? tone : 'normal';
  const chance = reactionChance(character, e, t, attitude);
  const roll = hash32(String(seed)) % 100;
  return { ok: roll < chance, chance, roll, group: socialGroup(e), tone: t, skill: TONE_SKILL[t] ?? null };
}

const REFUSALS = {
  nobility: {
    polite: ['I have no leisure for idle questions today.', 'Another time, perhaps. I am expected elsewhere.'],
    normal: ['You will address me properly, or not at all.', 'I do not discuss such things with strangers.'],
    blunt: ['Mind your tongue. I do not answer to that manner.', 'Such insolence. Leave me.'],
  },
  learned: {
    polite: ['Forgive me, my thoughts are on other matters.', 'I cannot help you just now.'],
    normal: ['I would rather not say.', 'Ask someone less occupied than I am.'],
    blunt: ['Courtesy costs nothing, traveller. Try it.', 'I will not be barked at.'],
  },
  merchants: {
    polite: ['Busy, busy. Come back when I have a moment.', 'Not now, friend. Customers waiting.'],
    normal: ['I am here to sell, not to gossip.', 'Time is money, and that question is neither.'],
    blunt: ['Talk to me like that and you can shop elsewhere.', 'Not with that tone.'],
  },
  commoners: {
    polite: ['Ooh, listen to you. Not my business, my lord.', 'All that bowing makes me nervous. Ask someone else.'],
    normal: ['Couldn\'t say.', 'Don\'t know, don\'t care.'],
    blunt: ['Oi, who do you think you\'re talking to?', 'Push someone else around.'],
  },
  underworld: {
    polite: ['Save the pretty words for the court.', 'You talk like a magistrate. I\'ve nothing for you.'],
    normal: ['Who\'s asking?', 'Never seen you before. Move along.'],
    blunt: ['Easy. Ask nicer than that and I might hear you.', 'Hah. Not today.'],
  },
};
export const WEARY = 'I have answered enough of your questions for one day.';

export function refusalLine(r, seed) {
  const lines = REFUSALS[r.group]?.[r.tone] ?? REFUSALS.commoners.normal;
  return lines[hash32(`refuse:${seed}`) % lines.length];
}

// ------------------------------------------------------------------------------------------------ knowledge

/** Building types everybody in town can point to: guild halls, temples, taverns, palaces and banks. */
export const LANDMARK_TYPES = new Set([3, 11, 14, 15, 16]);
const NEAR_DOOR_M = 60;

/**
 * Does this speaker know where a subject is? Deterministic per speaker and subject, so two locals can differ
 * and asking the same person again gives the same answer.
 * @param {object} e speaker
 * @param {{id:string, kind:'place'|'person', type?:number|null, person?:object, spec:object}} subj
 * @param {{distance?:number, homeInterior?:string|null}} o distance from the speaker's door to the subject's
 */
export function knows(e, subj, { distance = Infinity, homeInterior = null } = {}) {
  if (subj.kind === 'person' && subj.person?.id === e.id) return true;
  if (homeInterior && subj.spec?.to === homeInterior) return true; // own building and its people
  const landmark = subj.type != null && LANDMARK_TYPES.has(subj.type);
  if (subj.kind === 'place' && landmark) return true;
  let chance = subj.kind === 'place' ? 70 : landmark ? 65 : 40;
  if (distance <= NEAR_DOOR_M) chance += 25;
  if (e.mobile || e.role === 'noble') chance += 10; // walkers and courtiers get about
  return hash32(`knows:${e.id}:${subj.id}`) % 100 < chance;
}

const UNKNOWN = {
  person: ['I couldn\'t tell you where {name} is. Try someone else.', 'Never heard of {name}, sorry.', '{name}? The name means nothing to me.'],
  place: ['I don\'t know where {name} is. Someone else might.', 'I can\'t place {name}. Ask around.'],
};
export function unknownLine(e, subj, name) {
  const lines = UNKNOWN[subj.kind] ?? UNKNOWN.place;
  return lines[hash32(`unknown:${e.id}:${subj.id}`) % lines.length].replace('{name}', name);
}

// ------------------------------------------------------------------------------------------------ news and rumours

const NEWS = [
  ['work', 'Word is {person} at {place} needs a hand. Ask there if your purse is light.'],
  ['tavern', '{place} has had a full common room every night this week. Mind your purse in the crowd.'],
  ['shop', '{place} has new goods in, so I hear. Get there before the prices climb.'],
  ['temple', 'The priests at {place} have been tending fever cases since the last rains.'],
  ['bank', 'Folk are queuing at {place}. Some say the rate on letters of credit went up again.'],
  ['guild', 'There was a row at {place} last night. Raised voices, nothing more.'],
  ['palace', 'Riders came and went from {place} all morning. Nobody says what they carried.'],
];
const RUMOURS = [
  ['person', 'They say {person} at {place} knows more about this town than the magistrate does.'],
  ['person', 'I heard {person} at {place} owes money to half the street. Don\'t lend them anything.'],
  ['tavern', 'Someone at {place} won a fortune at dice and lost it again before dawn.'],
  ['shop', 'Between us, the scales at {place} are a touch generous to the house.'],
  ['temple', 'A pilgrim at {place} swore the candles lit themselves at midnight.'],
  ['palace', 'There are passages under {place}, they say, older than the walls themselves.'],
];
const KIND_OF_TYPE = (t) => (t === 15 ? 'tavern' : t === 14 ? 'temple' : t === 3 ? 'bank' : t === 11 ? 'guild' : t === 16 ? 'palace' : t != null && t <= 13 ? 'shop' : null);

/**
 * News or a rumour naming a real public building (and person) of this town, or null to fall back to the
 * general lines. Rotates per speaker and per game day, so different locals tell different things.
 * @param {'news'|'rumours'} topic
 * @param {object} e speaker
 * @param {{places:object[], people:object[], work:object[]}} town public subjects only (no private or secret ones)
 * @param {number} day game day
 * @returns {{text:string, place:object}|null}
 */
export function localTale(topic, e, town, day) {
  const table = topic === 'news' ? NEWS : RUMOURS;
  const seed = hash32(`${topic}:${e.id}:${day}`);
  // Every third tale is a general one (the caller's pool), so the old lines still turn up.
  if (seed % 3 === 0) return null;
  for (let i = 0; i < table.length; i++) {
    const [kind, line] = table[(seed + i) % table.length];
    let place = null, person = null;
    if (kind === 'work' || kind === 'person') {
      const pool = kind === 'work' ? town.work : town.people;
      if (!pool?.length) continue;
      person = pool[hash32(`${seed}:${i}:p`) % pool.length];
      place = town.places.find((p) => p.spec.to === (person.interior ?? person.person?.interior));
      if (!place) continue;
    } else {
      const pool = town.places.filter((p) => KIND_OF_TYPE(p.type) === kind);
      if (!pool.length) continue;
      place = pool[hash32(`${seed}:${i}:b`) % pool.length];
    }
    const text = line.replace('{place}', place.label).replace('{person}', person?.name ?? person?.label ?? '');
    return { text: text[0].toUpperCase() + text.slice(1), place };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ learned places

export const MAX_LEARNED_PER_TOWN = 200;
export const MAX_LEARNED_TOWNS = 64;

/** Normalise `rpg.learnedPlaces` = { [town]: [{id, name, type, x, z}] } in place. */
export function cleanLearned(rpg) {
  const v = rpg.learnedPlaces;
  if (!v || typeof v !== 'object' || Array.isArray(v)) { rpg.learnedPlaces = {}; return rpg.learnedPlaces; }
  const towns = Object.keys(v).filter((k) => /^town:[^/]+\/.+$/.test(k) && Array.isArray(v[k]));
  for (const k of Object.keys(v)) if (!towns.includes(k)) delete v[k];
  for (const k of towns.slice(0, Math.max(0, towns.length - MAX_LEARNED_TOWNS))) delete v[k];
  for (const k of Object.keys(v)) {
    v[k] = v[k].filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && Number.isFinite(x.x) && Number.isFinite(x.z))
      .slice(-MAX_LEARNED_PER_TOWN);
  }
  return v;
}

/** Record a building as known on this player's map. Returns the entry when it is new, else null. */
export function learnPlace(rpg, town, entry) {
  const all = cleanLearned(rpg);
  const list = (all[town] ||= []);
  if (list.some((x) => x.id === entry.id)) return null;
  list.push(entry);
  if (list.length > MAX_LEARNED_PER_TOWN) list.splice(0, list.length - MAX_LEARNED_PER_TOWN);
  const towns = Object.keys(all);
  if (towns.length > MAX_LEARNED_TOWNS) delete all[towns[0] === town ? towns[1] : towns[0]];
  return entry;
}
