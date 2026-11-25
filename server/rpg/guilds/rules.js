// Pure guild, temple, knightly-order and faction-standing rules (package 15).
//
// Numbers and conditions follow the Daggerfall Unity guild sources (MIT, (c) 2009-2023 Daggerfall Workshop):
// Guilds/Guild.cs (rank tables, 28-day rank changes, expulsion), FightersGuild.cs, MagesGuild.cs, ThievesGuild.cs,
// DarkBrotherhood.cs, KnightlyOrder.cs, Temple.cs (per-deity rank privileges and skills), GuildManager.cs
// (guild group of a building faction, exact temple/order match), PersistentFactionData.ChangeReputation
// (propagation) and
// DaggerfallGuildServiceCureDisease / DaggerfallGuildServiceDonation. Rank titles and all prose are original.
//
// Nothing here touches player state: callers pass plain objects and get plain results.

import { RANK_REQ_REPUTATION, RANK_REQ_SKILL_HIGH, RANK_REQ_SKILL_LOW } from '../npcs/data.js';
import { freeShipTravel } from '../../../client/gameplay/guilds/perks.js';

export { RANK_REQ_REPUTATION, RANK_REQ_SKILL_HIGH, RANK_REQ_SKILL_LOW };

/** Guild.cs: a rank can change at most once every 28 days. */
export const RANK_CHANGE_DAYS = 28;
/** Guild.defaultTrainingMax and per-level trainer prices (members / non-members). */
export const TRAINING_MAX = 50;
export const MEMBER_TRAINING_COST = 100;
export const NON_MEMBER_TRAINING_COST = 400;
/** FactionFile.FactionIDs used as roots of a propagation. */
export const GENERIC_TEMPLE = 450;
export const GENERIC_KNIGHTLY_ORDER = 844;
export const MERCHANTS_FACTION = 510; // shops are marked as Fighters Guild in the faction data
export const REP_MIN = -100;
export const REP_MAX = 100;

/** FactionFile.GuildGroups numbers in FACTION.TXT `ggroup:` -> this project's guild group key. */
export const GGROUP = Object.freeze({ 3: 'brotherhood', 4: 'thieves', 9: 'knights', 10: 'mages', 11: 'fighters', 17: 'temple' });

/** Guild service ids offered at counters, and the dialogue labels for them. */
export const SERVICE = Object.freeze({
  train: 'Training', quests: 'Work', repair: 'Repairs', identify: 'Identify', donate: 'Donate', cure: 'Cure disease',
  heal: 'Healing', spells: 'Buy spells', makeSpells: 'Spell Maker', magicItems: 'Buy magic items',
  makeItems: 'Item Maker', potions: 'Buy potions', makePotions: 'Potion Maker', soulgems: 'Buy soul gems',
  summon: 'Daedra summoning', teleport: 'Guild teleport', library: 'Library', sellItems: 'Sell magic items',
  spymaster: 'Spymaster', armor: 'Receive armour', house: 'Receive house',
});

const skills = (s) => Object.freeze(s.split(','));

/** Divines (Temple.Divines: value = deity faction id) with Temple.templeData rank thresholds (-1 = never). */
export const DIVINES = Object.freeze({
  26: { name: 'Akatosh', order: 92, ranks: { library: 2, healing: 1, potions: 4, makePotions: 5, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: -1, summon: 7 },
    blessing: 'Speed', skills: skills('Alteration,Daedric,Destruction,Dragonish,Long Blade,Running,Stealth'),
    training: skills('Alteration,Archery,Daedric,Destruction,Dragonish,Long Blade,Running,Stealth,Swimming') },
  21: { name: 'Arkay', order: 82, ranks: { library: 3, healing: 0, potions: 1, makePotions: 4, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: 4, summon: 7 },
    blessing: null, skills: skills('Axe,Backstabbing,Daedric,Destruction,Medical,Restoration,Short Blade'),
    training: skills('Axe,Backstabbing,Climbing,Critical Strike,Daedric,Destruction,Medical,Restoration,Short Blade') },
  29: { name: 'Dibella', order: 98, ranks: { library: 4, healing: 2, potions: 1, makePotions: 5, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: -1, summon: 7 },
    blessing: 'Luck', skills: skills('Daedric,Etiquette,Illusion,Lockpicking,Long Blade,Nymph,Orcish,Restoration'),
    training: skills('Daedric,Etiquette,Harpy,Illusion,Lockpicking,Long Blade,Nymph,Orcish,Restoration,Streetwise') },
  27: { name: 'Julianos', order: 94, ranks: { library: 0, healing: 2, potions: -1, makePotions: -1, magicItems: 3, makeItems: 5, spells: -1, makeSpells: -1, soulgems: -1, summon: 6 },
    blessing: 'Intelligence', skills: skills('Alteration,Daedric,Impish,Lockpicking,Mysticism,Short Blade,Thaumaturgy'),
    training: skills('Alteration,Critical Strike,Daedric,Impish,Lockpicking,Mercantile,Mysticism,Short Blade,Thaumaturgy') },
  35: { name: 'Kynareth', order: 36, ranks: { library: 4, healing: 1, potions: -1, makePotions: -1, magicItems: -1, makeItems: -1, spells: 3, makeSpells: 6, soulgems: -1, summon: 7 },
    blessing: 'Endurance', skills: skills('Archery,Climbing,Daedric,Destruction,Dodging,Dragonish,Harpy,Illusion,Jumping,Running,Stealth'),
    training: skills('Archery,Climbing,Daedric,Destruction,Dodging,Dragonish,Harpy,Illusion,Jumping,Running,Stealth') },
  24: { name: 'Mara', order: 88, ranks: { library: 4, healing: 1, potions: 2, makePotions: 5, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: -1, summon: 7 },
    blessing: 'Personality', skills: skills('Archery,Critical Strike,Daedric,Etiquette,Harpy,Illusion,Medical,Nymph,Restoration,Streetwise'),
    training: skills('Archery,Critical Strike,Daedric,Etiquette,Harpy,Illusion,Medical,Nymph,Restoration,Streetwise') },
  33: { name: 'Stendarr', order: 106, ranks: { library: 4, healing: 0, potions: 2, makePotions: 5, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: -1, summon: 7 },
    blessing: 'legal', skills: skills('Axe,Blunt Weapon,Critical Strike,Daedric,Dodging,Medical,Restoration'),
    training: skills('Axe,Blunt Weapon,Critical Strike,Daedric,Dodging,Medical,Orcish,Restoration,Spriggan') },
  22: { name: 'Zenithar', order: 84, ranks: { library: 4, healing: 1, potions: 1, makePotions: 6, magicItems: -1, makeItems: -1, spells: -1, makeSpells: -1, soulgems: -1, summon: 8 },
    blessing: 'Mercantile', skills: skills('Blunt Weapon,Centaurian,Daedric,Etiquette,Giantish,Harpy,Mercantile,Orcish,Pickpocket,Spriggan,Streetwise,Thaumaturgy'),
    training: skills('Blunt Weapon,Centaurian,Daedric,Etiquette,Giantish,Harpy,Mercantile,Orcish,Pickpocket,Spriggan,Streetwise,Thaumaturgy') },
});
/** Temple order faction -> deity (used when FACTION.TXT is not installed). */
export const ORDER_DIVINE = Object.freeze(Object.fromEntries(Object.entries(DIVINES).map(([d, v]) => [v.order, Number(d)])));

/** KnightlyOrder.Orders (faction id) with their home region index (FACTION.TXT, 0-based). */
export const ORDERS = Object.freeze({
  368: { name: 'Knights of the Dragon', region: 17 }, 408: { name: 'Order of the Candle', region: 20 },
  409: { name: 'Knights of the Rose', region: 23 }, 410: { name: 'Knights of the Flame', region: 21 },
  411: { name: 'Host of the Horn', region: 22 }, 413: { name: 'Knights of the Owl', region: 18 },
  414: { name: 'Order of the Raven', region: 5 }, 415: { name: 'Knights of the Wheel', region: 43 },
  416: { name: 'Order of the Scarab', region: 51 }, 417: { name: 'Knights of the Hawk', region: 54 },
});

/**
 * Guild groups. `factionId` null = per-hall variant (temple deity, knightly order). `invite` = joined only through the
 * secret invitation quest. Titles are this project's own.
 */
export const GROUPS = Object.freeze({
  fighters: {
    id: 'fighters', factionId: 41, name: 'Fighters Guild',
    skills: skills('Archery,Axe,Blunt Weapon,Giantish,Long Blade,Orcish,Short Blade'),
    training: skills('Archery,Axe,Blunt Weapon,Critical Strike,Giantish,Jumping,Long Blade,Orcish,Running,Short Blade,Swimming'),
    ranks: ['Recruit', 'Shieldhand', 'Blade', 'Sergeant', 'Banneret', 'Warden', 'Captain', 'Champion', 'Marshal', 'Lord Marshal'],
  },
  mages: {
    id: 'mages', factionId: 40, name: 'Mages Guild',
    skills: skills('Alteration,Destruction,Illusion,Mysticism,Restoration,Thaumaturgy'),
    training: skills('Alteration,Daedric,Destruction,Dragonish,Harpy,Illusion,Impish,Mysticism,Orcish,Restoration,Spriggan,Thaumaturgy'),
    ranks: ['Novice', 'Reader', 'Scribe', 'Lector', 'Arcanist', 'Savant', 'Magister', 'High Magister', 'Loremaster', 'Arch-Lector'],
  },
  thieves: {
    id: 'thieves', factionId: 42, name: 'Thieves Guild', invite: 'O0A0AL00', noExpulsion: true,
    skills: skills('Backstabbing,Climbing,Lockpicking,Pickpocket,Short Blade,Stealth,Streetwise'),
    training: skills('Backstabbing,Blunt Weapon,Climbing,Dodging,Jumping,Lockpicking,Pickpocket,Short Blade,Stealth,Streetwise,Swimming'),
    ranks: ['Lookout', 'Cutpurse', 'Footpad', 'Fence', 'Locksmith', 'Shadow', 'Burglar', 'Prowler', 'Master Thief', 'Guildmaster'],
  },
  brotherhood: {
    id: 'brotherhood', factionId: 108, name: 'Dark Brotherhood', invite: 'L0A01L00', noExpulsion: true,
    skills: skills('Archery,Backstabbing,Climbing,Critical Strike,Daedric,Destruction,Short Blade,Stealth,Streetwise'),
    training: skills('Archery,Backstabbing,Climbing,Critical Strike,Daedric,Destruction,Dodging,Running,Short Blade,Stealth,Streetwise,Swimming'),
    ranks: ['Initiate', 'Shade', 'Knife', 'Whisper', 'Veil', 'Stiletto', 'Nightblade', 'Dusk Hand', 'Silent Voice', 'Night Mother’s Hand'],
  },
  temple: {
    id: 'temple', factionId: null, name: 'Temple', variants: 'divine',
    skills: null, training: null, // per deity (DIVINES)
    ranks: ['Lay Brother', 'Acolyte', 'Votary', 'Deacon', 'Curate', 'Canon', 'Prior', 'Abbot', 'Prelate', 'Patriarch'],
  },
  knights: {
    id: 'knights', factionId: null, name: 'Knightly Order', variants: 'order',
    skills: skills('Archery,Critical Strike,Dragonish,Etiquette,Giantish,Long Blade,Medical'),
    training: Object.freeze([]), // KnightlyOrder.TrainingSkills is null: no trainers
    ranks: ['Squire', 'Gallant', 'Errant', 'Sentinel', 'Bachelor', 'Guardian', 'Knight', 'Knight Banneret', 'Lord Protector', 'Grand Master'],
  },
});

export const isGroup = (k) => Object.hasOwn(GROUPS, k);
const clampRep = (v) => Math.max(REP_MIN, Math.min(REP_MAX, Math.trunc(v)));

// ------------------------------------------------------------------------------------------- faction table

/**
 * Faction helper over the parsed FACTION.TXT map (client/gameplay/npcs/factionFile.js) or null. Without game
 * data a small built-in table of guilds, divines, temple orders and knightly orders stands in.
 */
export function factionTable(parsed) {
  const map = new Map();
  if (parsed?.size) for (const [id, f] of parsed) map.set(id, f);
  else {
    const put = (id, name, type, parent, ggroup, region = -1) => map.set(id, { id, name, type, parent, ggroup, region, allies: [], enemies: [] });
    put(40, 'The Mages Guild', 2, null, 10); put(41, 'The Fighters Guild', 2, null, 11); put(42, 'The Thieves Guild', 2, null, 4);
    put(108, 'The Dark Brotherhood', 2, null, 3); put(GENERIC_TEMPLE, 'Generic Temple', 9, null, -1);
    put(GENERIC_KNIGHTLY_ORDER, 'Generic Knightly Order', 2, null, 17); put(MERCHANTS_FACTION, 'The Merchants', 2, null, 11);
    for (const [d, v] of Object.entries(DIVINES)) { put(Number(d), v.name, 1, null, -1); put(v.order, `Temple of ${v.name}`, 9, Number(d), 17); }
    for (const [o, v] of Object.entries(ORDERS)) put(Number(o), `The ${v.name}`, 2, null, 9, v.region);
    put(201, 'Daggerfall', 7, null, 15, 17);
  }
  const children = new Map();
  for (const f of map.values()) if (f.parent != null && map.has(f.parent)) {
    if (!children.has(f.parent)) children.set(f.parent, []);
    children.get(f.parent).push(f.id);
  }
  return { get: (id) => map.get(id) ?? null, has: (id) => map.has(id), children: (id) => children.get(id) ?? [], size: map.size };
}

/** Temple.GetDivine: a deity id, or the deity parent of a temple order / temple service faction. */
export function divineOf(table, factionId) {
  if (DIVINES[factionId]) return factionId;
  if (ORDER_DIVINE[factionId]) return ORDER_DIVINE[factionId];
  let f = table.get(factionId);
  for (let i = 0; f && i < 4; i++) {
    if (DIVINES[f.parent]) return f.parent;
    if (ORDER_DIVINE[f.parent]) return ORDER_DIVINE[f.parent];
    f = table.get(f.parent);
  }
  return null;
}

/** GuildManager.GetGuildGroup for a building (or person) faction: guild group key or null. */
export function groupOfFaction(table, factionId) {
  if (!Number.isInteger(factionId) || factionId <= 0 || factionId === MERCHANTS_FACTION) return null;
  if (ORDERS[factionId]) return 'knights';
  if (divineOf(table, factionId)) return 'temple';
  const f = table.get(factionId);
  return f ? GGROUP[f.ggroup] ?? null : null;
}

/** Variant id of a hall: the deity for temples, the order for knights; null for single-faction guilds. */
export function variantOf(table, group, factionId) {
  if (group === 'temple') return divineOf(table, factionId);
  if (group === 'knights') return ORDERS[factionId] ? factionId : null;
  return null;
}

/** Reputation faction of a membership (Guild.GetFactionId): fixed, or the deity/order variant. */
export const repFaction = (group, variant) => GROUPS[group]?.factionId ?? variant ?? null;

export function groupName(table, group, variant) {
  if (group === 'temple') return variant && DIVINES[variant] ? (table.get(DIVINES[variant].order)?.name ?? `Temple of ${DIVINES[variant].name}`) : 'Temple';
  if (group === 'knights') return variant && ORDERS[variant] ? (table.get(variant)?.name ?? `The ${ORDERS[variant].name}`) : 'Knightly Order';
  return table.get(GROUPS[group]?.factionId)?.name ?? GROUPS[group]?.name ?? group;
}

export function guildSkills(group, variant) {
  if (group === 'temple') return DIVINES[variant]?.skills ?? [];
  return GROUPS[group]?.skills ?? [];
}
export function trainingSkills(group, variant) {
  if (group === 'temple') return DIVINES[variant]?.training ?? [];
  return GROUPS[group]?.training ?? [];
}

// ------------------------------------------------------------------------------------------- ranks

const skillValue = (c, s) => Math.max(0, Math.trunc(Number(c?.skills?.[s]) || 0));

function highLow(character, list, rank) {
  let high = 0, low = 0;
  for (const s of list) {
    const v = skillValue(character, s);
    if (v >= RANK_REQ_SKILL_HIGH[rank]) high++;
    else if (v >= RANK_REQ_SKILL_LOW[rank]) low++;
  }
  return { high, low };
}

/** Guild.IsEligibleToJoin with the reason it fails. */
export function eligibility(character, group, variant, rep) {
  const { high, low } = highLow(character, guildSkills(group, variant), 0);
  if (rep < RANK_REQ_REPUTATION[0]) return { ok: false, reason: 'reputation' };
  if (!(high > 0 && low + high > 1)) return { ok: false, reason: 'skills' };
  return { ok: true, reason: null };
}

/** Guild.CalculateNewRank: -1 = expelled when rep < 0 (Thieves Guild and Dark Brotherhood never expel: 0). */
export function newRank(character, group, variant, rep) {
  if (rep < 0) return GROUPS[group]?.noExpulsion ? 0 : -1;
  const list = guildSkills(group, variant);
  let r;
  for (r = 0; r < RANK_REQ_REPUTATION.length; r++) {
    const { high, low } = highLow(character, list, r);
    if (rep < RANK_REQ_REPUTATION[r] || high < 1 || low + high < 2) break;
  }
  return Math.max(0, r - 1);
}

/**
 * Guild.UpdateRank. `m` = {rank, lastRankChange(day)}; `day` = days since year zero.
 * Returns {change: null|'promotion'|'demotion'|'expulsion', rank, due} without mutating `m`.
 */
export function rankUpdate(m, character, group, rep, day) {
  const due = !Number.isFinite(m.lastRankChange) || day >= m.lastRankChange + RANK_CHANGE_DAYS;
  if (!due) return { change: null, rank: m.rank, due: false, nextDay: m.lastRankChange + RANK_CHANGE_DAYS };
  const r = newRank(character, group, m.variant, rep);
  if (r === m.rank) return { change: null, rank: r, due: true };
  return { change: r > m.rank ? 'promotion' : r < 0 ? 'expulsion' : 'demotion', rank: r, due: true };
}

/** Rank title (DFU gives female titles for a few ranks; here the same title fits everyone). */
export const rankTitle = (group, rank) => (Number.isInteger(rank) && rank >= 0 ? GROUPS[group]?.ranks[rank] ?? null : null);

// ------------------------------------------------------------------------------------------- privileges

/** Guild.CanRest: only the Fighters Guild lets members sleep in the hall. */
export const canRest = (group, rank) => group === 'fighters' && rank >= 0;
/** Guild.HallAccessAnytime. */
export function hallAccessAnytime(group, rank) {
  if (!(rank >= 0)) return false;
  if (group === 'fighters' || group === 'mages') return rank >= 6;
  return group === 'thieves' || group === 'brotherhood';
}
/** Temple.FreeHealing (other guilds never heal for free). */
export const freeHealing = (group, variant, rank) => group === 'temple' && rank >= 0 && DIVINES[variant] != null && DIVINES[variant].ranks.healing <= rank;
/** Guild.CanAccessLibrary. */
export function canAccessLibrary(group, variant, rank) {
  if (!(rank >= 0)) return false;
  if (group === 'mages') return rank >= 2;
  if (group === 'temple') return DIVINES[variant] != null && DIVINES[variant].ranks.library <= rank;
  return false;
}
/** FightersGuild.ReducedRepairCost / Temple(Arkay).ReducedCureCost: (10-rank)/10 in 8.8 fixed point. */
export const rankDiscount = (price, rank) => (((10 - rank) << 8) / 10 * price) >> 8;
export const reducedRepairCost = (group, rank, price) => (group === 'fighters' && rank >= 0 ? rankDiscount(price, rank) : price);
export const reducedCureCost = (group, variant, rank, price) => (group === 'temple' && variant === 21 && rank >= 0 ? rankDiscount(price, rank) : price);
/** FightersGuild.AlterReward: (10+rank)/10. */
export const alterReward = (group, rank, reward) => (group === 'fighters' && rank >= 0 ? (((10 + rank) << 8) / 10 * reward) >> 8 : reward);
/** KnightlyOrder.FreeTavernRooms (rank 4+, or in the order's home region) and FreeShipTravel (rank 6+). */
export const freeTavernRooms = (variant, rank, regionIndex) => rank >= 4 || (rank >= 0 && ORDERS[variant]?.region === regionIndex);
export { freeShipTravel };

/**
 * Guild.CanAccessService and its overrides. `rank` null = not a member of this hall's guild (or another temple /
 * order). Returns {ok, reason:null|'members'|'rank'|'none', minRank}.
 */
export function serviceAccess(group, variant, rank, service) {
  const member = Number.isInteger(rank) && rank >= 0;
  const gate = (min) => (min < 0 ? { ok: false, reason: 'none', minRank: null }
    : member && rank >= min ? { ok: true, reason: null, minRank: min }
      : { ok: false, reason: member ? 'rank' : 'members', minRank: min });
  const open = { ok: true, reason: null, minRank: null };
  const members = gate(0);
  switch (group) {
    case 'fighters':
      return { train: members, quests: open, repair: members, identify: open, donate: open, cure: open }[service] ?? gate(-1);
    case 'mages':
      return { train: members, quests: open, identify: open, spells: open, makeSpells: members, magicItems: gate(3), makeItems: gate(5),
        teleport: gate(8), summon: gate(6), soulgems: gate(4), library: gate(2) }[service] ?? gate(-1);
    case 'thieves':
      return { train: members, quests: open, sellItems: gate(2), spymaster: gate(4) }[service] ?? gate(-1);
    case 'brotherhood':
      return { train: members, quests: open, potions: gate(1), makePotions: gate(3), soulgems: gate(5), spymaster: gate(7) }[service] ?? gate(-1);
    case 'knights':
      return { quests: open, armor: members, house: open }[service] ?? gate(-1);
    case 'temple': {
      const t = DIVINES[variant]?.ranks;
      if (['train', 'quests', 'donate', 'cure', 'heal'].includes(service)) return open;
      if (!t) return gate(-1);
      if (service in t) return gate(t[service]);
      return gate(-1);
    }
    default:
      return { quests: open }[service] ?? gate(-1);
  }
}

/** Every rank-gated privilege a membership grants, for the character sheet and hand-offs. */
export function privileges(group, variant, rank) {
  const out = [];
  if (!(rank >= 0)) return out;
  for (const s of Object.keys(SERVICE)) {
    const a = serviceAccess(group, variant, rank, s);
    if (a.ok && a.minRank !== null) out.push(s);
  }
  if (canRest(group, rank)) out.push('rest');
  if (hallAccessAnytime(group, rank)) out.push('hallAnytime');
  if (freeHealing(group, variant, rank)) out.push('freeHealing');
  if (group === 'knights' && rank >= 4) out.push('freeRooms');
  if (group === 'knights' && freeShipTravel(rank)) out.push('freeShips');
  if (group === 'knights' && rank >= 9) out.push('house');
  return [...new Set(out)];
}

/** Lowest rank at which `service` opens for this guild, or null. */
export function rankFor(group, variant, service) {
  for (let r = 0; r < 10; r++) if (serviceAccess(group, variant, r, service).ok) return r;
  return null;
}

// ------------------------------------------------------------------------------------------- prices

/** FormulaHelper.CalculateCost without the regional adjustment: 2 * (cost * (quality - 10)/100 + cost). */
export function qualityCost(base, quality) {
  const c = Math.max(1, Math.trunc(base));
  const q = Number.isFinite(quality) ? Math.trunc(quality) : 10;
  return 2 * (Math.trunc(c * (q - 10) / 100) + c);
}

/** DaggerfallGuildServiceCureDisease: 250 per condition, Arkay rank discount, then hall quality. */
export const cureCost = (count, group, variant, rank, quality) => (count > 0 ? qualityCost(reducedCureCost(group, variant, rank, 250 * count), quality) : 0);

/** Guild.GetTrainingPrice: 100 (member) or 400 (non-member) gold per character level. */
export const trainingPrice = (member, level) => (member ? MEMBER_TRAINING_COST : NON_MEMBER_TRAINING_COST) * Math.max(1, Math.trunc(level) || 1);

/**
 * DaggerfallGuildServiceDonation: the deity's standing rises by 1 with chance (2*amount/max(|rep|,1) + 1) percent.
 * `roll` is a number in [0,100).
 */
export const donationRaises = (amount, rep, roll) => roll < Math.trunc((2 * amount) / Math.max(Math.abs(rep), 1)) + 1;

// ------------------------------------------------------------------------------------------- politics

/**
 * PersistentFactionData.ChangeReputation(id, amount, propagate) as a list of [factionId, delta] changes.
 * Without propagation only `id` changes. With it: allies +amount/2 and enemies -amount/2 (unpropagated); knightly
 * orders change themselves and the generic order hierarchy; others change their whole root hierarchy (full for the
 * faction, the root and questors, half for the rest), with deities also moving the generic temple hierarchy.
 */
export function reputationChanges(table, id, amount, propagate = false, questors = QUESTORS) {
  const out = new Map();
  const add = (fid, d) => {
    if (!table.has(fid) || !d) return;
    out.set(fid, (out.get(fid) ?? 0) + d);
  };
  const half = (n) => Math.trunc(n / 2);
  const f = table.get(id);
  if (!f) return [];
  if (!propagate) {
    add(id, amount);
    return [...out];
  }
  for (const a of f.allies ?? []) add(a, half(amount));
  for (const e of f.enemies ?? []) add(e, -half(amount));
  const hierarchy = (root, origin, depth = 0) => {
    if (depth > 6) return;
    add(root.id, root.id === origin || root.parent == null || questors.has(root.id) ? amount : half(amount));
    for (const c of table.children(root.id)) { const cf = table.get(c); if (cf) hierarchy(cf, origin, depth + 1); }
  };
  if (GGROUP[f.ggroup] === 'knights' && ORDERS[id]) {
    add(id, amount);
    const g = table.get(GENERIC_KNIGHTLY_ORDER);
    if (g) hierarchy(g, GENERIC_KNIGHTLY_ORDER);
    return [...out];
  }
  let root = f;
  for (let i = 0; i < 8 && root.parent != null && table.has(root.parent) && root.id !== 108; i++) root = table.get(root.parent);
  if (table.children(root.id).length) hierarchy(root, id);
  else add(id, amount);
  if (root.type === 1) { const g = table.get(GENERIC_TEMPLE); if (g) hierarchy(g, GENERIC_TEMPLE); }
  return [...out];
}

/** Services.GuildNpcServices questor ids (full reputation change during propagation). */
export const QUESTORS = new Set([63, 851, 804, 807, 240, 846, 488, 470, 475, 456, 482, 498, 492, 464]);

export const applyReputation = (factions, changes) => {
  for (const [fid, d] of changes) {
    const v = clampRep((factions[fid] ?? 0) + d);
    if (v === 0) delete factions[fid];
    else factions[fid] = v;
  }
  return factions;
};
