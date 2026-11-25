// Pure classic character figure resolution for remote players (`api.state.peers`).
// Zero DOM or WebGL side effects: maps public peer fields to authentic Daggerfall
// 8-direction TEXTURE.nnn archives, subtle material/dye tint multipliers, corpse
// fallbacks for downed players, and rich classic crosshair target readouts.

import {
  GUARD_ARCHIVE, CORPSE_FALLBACK, mobileFor, corpseForArchive, peopleFor,
} from './tables.js';
import { hash } from './logic.js';
import { CLOTH_DYES, METAL_DYES } from '../inventory/dyes.js';

const DEAD_ANIMS = new Set(['dead', 'corpse']);
const DANGER_PREFIXES = ['dungeon:', 'wilderness:'];

const STEALTH_WEAPONS = new Set(['dagger', 'short_blade', 'shortblade', 'tanto', 'wakizashi', 'knife']);
const CASTER_IDS = new Set([128, 129, 130, 131, 132, 133]);
const NEUTRAL_ARMOR_TIERS = new Set(['', 'none', 'unarmored', 'cloth', 'leather', 'chain', 'iron', 'steel']);

const RACE_LABELS = Object.freeze({
  breton: 'Breton',
  redguard: 'Redguard',
  nord: 'Nord',
  darkelf: 'Dark Elf',
  highelf: 'High Elf',
  woodelf: 'Wood Elf',
  khajiit: 'Khajiit',
  argonian: 'Argonian',
});

// Subtle blend targets toward [1, 1, 1] so two players sharing an archive are
// immediately distinguishable without breaking classic pixel-art readability.
const ARMOR_BLEND = 0.18;
const CLOTH_BLEND = 0.16;

const ARMOR_TARGETS = Object.freeze({
  daedric: [1.25, 0.35, 0.35],    // crimson-iron
  elven: [1.25, 1.05, 0.45],      // warm gold
  dwarven: [1.22, 0.92, 0.40],    // burnished bronze-gold
  mithril: [0.55, 0.95, 1.30],    // cool ice-blue
  ebony: [0.35, 0.38, 0.48],      // charcoal-slate
  orcish: [0.60, 1.05, 0.55],     // bronze-green
  adamantium: [0.65, 0.60, 0.95], // dark violet-steel
  silver: [0.95, 1.02, 1.15],     // pale silver-blue
});

const CLOTH_TARGETS = Object.freeze({
  blue: [0.45, 0.72, 1.25],
  grey: [0.78, 0.80, 0.84],
  red: [1.25, 0.42, 0.42],
  brown: [1.02, 0.72, 0.45],
  purple: [0.95, 0.48, 1.22],
  tan: [1.15, 1.02, 0.72],
  white: [1.12, 1.12, 1.08],
  aquamarine: [0.45, 1.15, 1.12],
  yellow: [1.22, 1.12, 0.42],
  green: [0.48, 1.12, 0.55],
});

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function isFemale(gender, seed) {
  const s = String(gender ?? '').trim().toLowerCase();
  if (s.startsWith('f')) return true;
  if (s.startsWith('m')) return false;
  return (hash(seed) >>> 3) % 2 === 1;
}

function isReadied(peer) {
  return peer?.readied === true || peer?.readied === 'weapon' || !!peer?.readiedWeapon;
}

function isDangerLocation(location) {
  const s = String(location ?? '').trim().toLowerCase();
  return DANGER_PREFIXES.some((prefix) => s.startsWith(prefix));
}

function normalizeWeaponKind(peer) {
  if (peer?.weaponKind != null) {
    return String(peer.weaponKind).trim().toLowerCase().replace(/[\s-]+/g, '_');
  }
  const w = peer?.weapon;
  if (w && typeof w === 'object') {
    const raw = w.kind ?? w.category ?? '';
    if (raw) return String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  }
  return '';
}

function isGuardPeer(peer) {
  const role = norm(peer?.role ?? peer?.disguise);
  if (role === 'guard' || role === 'watch' || role === 'citywatch') return true;
  const cls = norm(peer?.archetype ?? peer?.className ?? peer?.class);
  return cls === 'guard' || cls === 'citywatch';
}

function resolveClassMobile(peer) {
  const candidates = [peer?.archetype, peer?.className, peer?.class];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const m = mobileFor(c);
    if (m && m.humanoid) return m;
  }
  return null;
}

function blendTint(target, weight) {
  const round3 = (n) => Math.round(n * 1000) / 1000;
  return [
    round3(1 + (target[0] - 1) * weight),
    round3(1 + (target[1] - 1) * weight),
    round3(1 + (target[2] - 1) * weight),
  ];
}

function formatRace(race) {
  const raw = String(race ?? '').trim();
  if (!raw) return '';
  const key = norm(raw);
  if (Object.hasOwn(RACE_LABELS, key)) return RACE_LABELS[key];
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatTitle(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === raw.toLowerCase()) {
    return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }
  return raw;
}

function buildKey(a) {
  const base = `${a.archive}:${a.layout}:${a.record}:${a.personLike ? 1 : 0}`;
  const parts = [base];
  if (a.defeated) parts.push('d');
  if (a.tint) parts.push(`t${a.tint[0]},${a.tint[1]},${a.tint[2]}`);
  return parts.join(':');
}

/**
 * True when a remote player is downed/defeated and should lie as a corpse.
 */
export function isPeerDefeated(peer) {
  if (!peer || typeof peer !== 'object') return false;
  if (peer.defeated === true) return true;
  const anim = String(peer.animation ?? '').trim().toLowerCase();
  return DEAD_ANIMS.has(anim);
}

/**
 * Subtle RGB tint multiplier `[r, g, b]` near `[1, 1, 1]` derived from the
 * player's `armorTier` material hue or `primaryDye` cloth hue, or `null` for
 * neutral/default steel/iron/unarmored peers and beast forms.
 */
export function peerFigureTint(peer) {
  if (!peer || typeof peer !== 'object') return null;
  const form = String(peer.form ?? '').trim().toLowerCase();
  if (form === 'werewolf' || form === 'wereboar') return null;

  const tier = norm(peer.armorTier);
  const dye = norm(peer.primaryDye);

  const hasMaterialTint = Object.hasOwn(METAL_DYES, tier) && !NEUTRAL_ARMOR_TIERS.has(tier) && Object.hasOwn(ARMOR_TARGETS, tier);
  const hasClothTint = Object.hasOwn(CLOTH_DYES, dye) && Object.hasOwn(CLOTH_TARGETS, dye);

  // Robed unarmored casters show their robe dye first; otherwise distinctive armor metal leads.
  if (peer.wearingRobes === true && peer.wearingHeavyArmor !== true && hasClothTint) {
    return blendTint(CLOTH_TARGETS[dye], CLOTH_BLEND);
  }
  if (hasMaterialTint) {
    return blendTint(ARMOR_TARGETS[tier], ARMOR_BLEND);
  }
  if (hasClothTint) {
    return blendTint(CLOTH_TARGETS[dye], CLOTH_BLEND);
  }
  return null;
}

/**
 * Resolve a remote player (`api.state.peers`) into a classic Daggerfall
 * 8-direction billboard appearance compatible with `actors.js`.
 *
 * Returns `{ archive, layout, record, mobile, guard, personLike, corpse, readied, defeated, tint, figureLabel, key }`.
 */
export function resolvePeerAppearance(peer, opts = {}) {
  const p = peer && typeof peer === 'object' ? peer : {};
  const seed = p.id ?? p.name ?? '';
  const female = isFemale(p.gender, seed);
  const readied = isReadied(p);
  const defeated = isPeerDefeated(p);

  // 1. Beast form always takes precedence (Werewolf 264, Wereboar 269).
  const form = String(p.form ?? '').trim().toLowerCase();
  if (form === 'werewolf' || form === 'wereboar') {
    const m = mobileFor(form === 'werewolf' ? 9 : 14);
    const app = {
      archive: m.male,
      layout: 'enemy',
      record: 0,
      mobile: m,
      guard: false,
      personLike: false,
      corpse: m.corpse ?? CORPSE_FALLBACK,
      readied,
      defeated,
      tint: null,
      figureLabel: m.name,
    };
    app.key = buildKey(app);
    return app;
  }

  const tint = peerFigureTint(p);

  // 2. Guard disguise / role -> City Watch (TEXTURE.399).
  if (isGuardPeer(p)) {
    const m = mobileFor(146);
    const app = {
      archive: GUARD_ARCHIVE,
      layout: 'enemy',
      record: 0,
      mobile: m,
      guard: true,
      personLike: false,
      corpse: m?.corpse ?? CORPSE_FALLBACK,
      readied,
      defeated,
      tint,
      figureLabel: m?.name ?? 'City Watch',
    };
    app.key = buildKey(app);
    return app;
  }

  const weaponKind = normalizeWeaponKind(p);
  const hasWeapon = weaponKind !== '' && weaponKind !== 'none' && weaponKind !== 'unarmed' && weaponKind !== 'hand';
  const wearingRobes = p.wearingRobes === true;
  const wearingHeavyArmor = p.wearingHeavyArmor === true;
  const location = typeof opts.location === 'string' ? opts.location : (typeof p.location === 'string' ? p.location : '');
  const inDangerZone = typeof opts.inDangerZone === 'boolean' ? opts.inDangerZone : isDangerLocation(location);

  const useArmedFigure = readied || wearingHeavyArmor || wearingRobes || hasWeapon || inDangerZone;

  // 3. Armed / class / dungeon / gear-bearing classic humanoid (TEXTURE.475–490).
  if (useArmedFigure) {
    const cls = resolveClassMobile(p);
    let m = null;

    if (weaponKind === 'bow') {
      m = cls && (cls.id === 141 || cls.id === 142) ? cls : mobileFor(141);
    } else if (wearingRobes || weaponKind === 'staff') {
      if (wearingHeavyArmor) {
        m = cls && (cls.id === 130 || cls.id === 133) ? cls : mobileFor(130);
      } else if (cls && (cls.id === 128 || cls.id === 132)) {
        m = cls;
      } else if (cls && (cls.id === 130 || cls.id === 133)) {
        m = cls;
      } else {
        m = mobileFor(128);
      }
    } else if (cls) {
      if (wearingHeavyArmor && (cls.id === 128 || cls.id === 132)) {
        m = mobileFor(130);
      } else {
        m = cls;
      }
    } else if (wearingHeavyArmor) {
      m = mobileFor(144);
    } else if (STEALTH_WEAPONS.has(weaponKind)) {
      m = mobileFor(138);
    } else {
      m = mobileFor(144);
    }

    const archive = female ? m.female : m.male;
    const app = {
      archive,
      layout: 'enemy',
      record: 0,
      mobile: m,
      guard: archive === GUARD_ARCHIVE,
      personLike: false,
      corpse: m.corpse ?? corpseForArchive(archive),
      readied,
      defeated,
      tint,
      figureLabel: m.name,
    };
    app.key = buildKey(app);
    return app;
  }

  // 4. Peaceful town-walker civilian figure (PEOPLE[race][gender]), deterministic by variant/faceIndex/seed.
  const set = peopleFor(p.race);
  const list = female ? set.female : set.male;
  const rawVariant = Number.isInteger(p.variant)
    ? p.variant
    : Number.isInteger(p.faceIndex)
      ? p.faceIndex
      : hash(seed);
  const archive = list[((rawVariant % list.length) + list.length) % list.length];
  const cls = resolveClassMobile(p);
  const corpse = cls?.corpse ?? corpseForArchive(archive) ?? CORPSE_FALLBACK;
  const raceLabel = formatRace(p.race);

  const app = {
    archive,
    layout: 'person',
    record: 0,
    mobile: null,
    guard: false,
    personLike: true,
    corpse,
    readied: false,
    defeated,
    tint,
    figureLabel: raceLabel ? `${raceLabel} Townsperson` : 'Townsperson',
  };
  app.key = buildKey(app);
  return app;
}

/**
 * Rich classic crosshair readout for targeting another player.
 * Examples:
 *   'Barenziah — Lv. 12 High Elf Mage [ARC] · weapon readied'
 *   'Gothryd — Lv. 8 Breton Knight (Defeated)'
 */
export function describePeerTarget(peer, appearance = null) {
  const p = peer && typeof peer === 'object' ? peer : {};
  const name = String(p.name ?? '').trim() || 'Traveller';

  const details = [];
  if (typeof p.level === 'number' && Number.isFinite(p.level) && p.level > 0) {
    details.push(`Lv. ${Math.floor(p.level)}`);
  }
  const race = formatRace(p.race);
  if (race) details.push(race);

  const classLabel = formatTitle(p.className ?? p.class ?? p.archetype);
  if (classLabel) details.push(classLabel);

  const rawTag = String(p.guildTag ?? p.guild?.tag ?? '').trim();
  if (rawTag) {
    const tag = rawTag.startsWith('[') && rawTag.endsWith(']') ? rawTag : `[${rawTag}]`;
    details.push(tag);
  }

  const form = String(p.form ?? '').trim().toLowerCase();
  if ((form === 'werewolf' || form === 'wereboar') && !details.some((d) => d.toLowerCase() === form)) {
    details.push(form === 'werewolf' ? 'Werewolf' : 'Wereboar');
  }

  const head = details.length > 0 ? `${name} — ${details.join(' ')}` : name;
  const defeated = appearance?.defeated === true || isPeerDefeated(p);
  if (defeated) return `${head} (Defeated)`;

  const readied = appearance?.readied === true || (appearance == null && isReadied(p));
  if (readied) return `${head} · weapon readied`;

  return head;
}

export { CASTER_IDS };
