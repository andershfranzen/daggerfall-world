// Pure NPC rules: deterministic rosters, pricing, reputation and guild ranks.
// Guild rank evaluation follows Guild.cs in Daggerfall Unity
// (MIT, (c) 2009-2023 Daggerfall Workshop).

import {
  DEFAULT_DISTRICT, DISTRICTS, GUILDS, NAME_PARTS, RANK_REQ_REPUTATION, RANK_REQ_SKILL_HIGH,
  RANK_REQ_SKILL_LOW, REP_MAX, REP_MIN, ROLES, SLOTS,
} from './data.js';

/** FNV-1a 32-bit. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG returning [0,1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "town:Daggerfall/Gothway Garden" -> {region:'Daggerfall', place:'Gothway Garden'}. */
export function parseLocation(location) {
  const s = String(location || '');
  const body = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  const slash = body.indexOf('/');
  if (slash < 0) return { region: '', place: body };
  return { region: body.slice(0, slash), place: body.slice(slash + 1) };
}

export function districtFor(location) {
  const { place } = parseLocation(location);
  return DISTRICTS.find((d) => d.match.test(place)) || DEFAULT_DISTRICT;
}

/** True for locations that get a town roster (town:* only; dungeons and wilderness get none). */
export function hasRoster(location) {
  return typeof location === 'string' && location.startsWith('town:');
}

/**
 * Deterministic roster for a location. Same location string -> same ids,
 * names, roles, sprites and positions on every server instance.
 */
export function rosterFor(location) {
  if (!hasRoster(location)) return [];
  const district = districtFor(location);
  const base = hash32(location);
  const used = new Set();
  return district.roles.slice(0, SLOTS.length).map((role, slot) => {
    const def = ROLES[role];
    const r = rng(hash32(`${location}#${slot}`));
    let first, last, name;
    for (let tries = 0; tries < 8; tries++) {
      first = NAME_PARTS.first[Math.floor(r() * NAME_PARTS.first.length)];
      last = NAME_PARTS.last[Math.floor(r() * NAME_PARTS.last.length)];
      name = `${first} ${last}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    const [archive, record] = def.sprites[Math.floor(r() * def.sprites.length)];
    const spot = SLOTS[slot];
    return {
      id: `npc:${base.toString(36)}:${slot}`,
      kind: 'npc',
      role,
      title: def.title,
      name,
      location,
      x: spot.x,
      z: spot.z,
      yaw: Math.PI, // facing +z, toward the arrival point
      sprite: { archive, record },
      faction: def.faction,
      ...(def.guild ? { guild: def.guild } : {}),
      ...(def.shop ? { shop: def.shop } : {}),
      ...(def.questGiver ? { questGiver: true } : {}),
    };
  });
}

export const clampRep = (v) => Math.max(REP_MIN, Math.min(REP_MAX, Math.round(v)));

export function skillValue(character, name) {
  const v = character?.skills?.[name];
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && typeof v.value === 'number') return v.value;
  return 0;
}

function highLow(character, guild, rank) {
  let high = 0, low = 0;
  for (const s of guild.skills) {
    const v = skillValue(character, s);
    if (v >= RANK_REQ_SKILL_HIGH[rank]) high++;
    else if (v >= RANK_REQ_SKILL_LOW[rank]) low++;
  }
  return { high, low };
}

/** DFU Guild.IsEligibleToJoin: rep >= 0, one guild skill high and another at least low. */
export function eligibleToJoin(character, guild, rep) {
  const { high, low } = highLow(character, guild, 0);
  return { ok: rep >= RANK_REQ_REPUTATION[0] && high > 0 && low + high > 1, badRep: rep < RANK_REQ_REPUTATION[0] };
}

/** DFU Guild.CalculateNewRank: highest rank whose reputation and skill requirements are all met (0..9). */
export function rankFor(character, guild, rep) {
  let r;
  for (r = 0; r < RANK_REQ_REPUTATION.length; r++) {
    const { high, low } = highLow(character, guild, r);
    if (rep < RANK_REQ_REPUTATION[r] || high < 1 || low + high < 2) break;
  }
  return Math.max(0, r - 1);
}

/** Highest-valued guild skills to name when a candidate is turned away. */
export function suggestSkills(character, guild) {
  return [...guild.skills].sort((a, b) => skillValue(character, b) - skillValue(character, a)).slice(0, 2);
}

/**
 * Buy price per unit. Always >= base value so selling back can never profit.
 * Mercantile skill and good standing shave the markup (max 40% -> min 0%).
 */
export function buyPrice(value, mercantile, rep) {
  const markup = 0.4 - Math.min(0.25, Math.max(0, mercantile) * 0.0025) - Math.min(0.15, Math.max(0, rep) * 0.003);
  return Math.max(1, Math.ceil(value * (1 + Math.max(0, markup))));
}

/** Sale price per unit. Always <= 60% of base value. */
export function sellPrice(value, mercantile, rep) {
  const share = 0.35 + Math.min(0.15, Math.max(0, mercantile) * 0.0015) + Math.min(0.1, Math.max(0, rep) * 0.002);
  return Math.max(0, Math.floor(value * Math.min(0.6, share)));
}

export const guildById = (id) => GUILDS[id] || null;

/** Unit vector bearing from (x,z) to (tx,tz) as a compass word, yaw 0 = north (-z), clockwise. */
export function compassWord(x, z, tx, tz) {
  const ang = Math.atan2(tx - x, -(tz - z));
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return words[((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
}
