// Appearance-accurate 3D Classic Character Figure for other players.
// Drop-in replacement for Avatar in client/render/avatar.js:
//   pose(x, y, z, yaw, moving, dt, time, opts) -> { parts: [{ model: Float32Array(16), color: [r, g, b] }] }
// Origin at the feet, facing -z at yaw 0. Pure ES module; no DOM dependencies.

import * as M from '../lib/mat.js';
import { hashString } from './avatar.js';

export const LABEL_HEIGHT = 2.15;

// Classic Daggerfall race skin & hair palettes (aligned with client/gameplay/character/rules.js).
export const CLASSIC_RACE_PALETTES = Object.freeze({
  Breton: Object.freeze({ skin: Object.freeze([0.906, 0.765, 0.627]), hair: Object.freeze([0.420, 0.290, 0.165]), scale: 1.00 }),
  Redguard: Object.freeze({ skin: Object.freeze([0.541, 0.353, 0.235]), hair: Object.freeze([0.110, 0.078, 0.063]), scale: 1.01 }),
  Nord: Object.freeze({ skin: Object.freeze([0.941, 0.816, 0.706]), hair: Object.freeze([0.788, 0.627, 0.400]), scale: 1.04 }),
  'Dark Elf': Object.freeze({ skin: Object.freeze([0.490, 0.522, 0.565]), hair: Object.freeze([0.165, 0.118, 0.141]), scale: 1.00 }),
  'High Elf': Object.freeze({ skin: Object.freeze([0.910, 0.831, 0.604]), hair: Object.freeze([0.914, 0.882, 0.769]), scale: 1.05 }),
  'Wood Elf': Object.freeze({ skin: Object.freeze([0.722, 0.541, 0.361]), hair: Object.freeze([0.290, 0.204, 0.125]), scale: 0.96 }),
  Khajiit: Object.freeze({ skin: Object.freeze([0.788, 0.596, 0.306]), hair: Object.freeze([0.353, 0.227, 0.094]), scale: 0.99, ears: 'cat' }),
  Argonian: Object.freeze({ skin: Object.freeze([0.435, 0.541, 0.353]), hair: Object.freeze([0.243, 0.306, 0.188]), scale: 1.00, ears: 'crest' }),
});

const RACE_NAMES = Object.freeze(Object.keys(CLASSIC_RACE_PALETTES));
const RACE_ALIASES = Object.freeze({
  breton: 'Breton',
  redguard: 'Redguard',
  nord: 'Nord',
  'dark elf': 'Dark Elf',
  darkelf: 'Dark Elf',
  dunmer: 'Dark Elf',
  'high elf': 'High Elf',
  highelf: 'High Elf',
  altmer: 'High Elf',
  'wood elf': 'Wood Elf',
  woodelf: 'Wood Elf',
  bosmer: 'Wood Elf',
  khajiit: 'Khajiit',
  argonian: 'Argonian',
});

// Classic Daggerfall armor & weapon material RGB palettes (in [0, 1]).
export const MATERIAL_COLORS = Object.freeze({
  leather: Object.freeze([0.46, 0.30, 0.17]),
  chain: Object.freeze([0.48, 0.50, 0.54]),
  iron: Object.freeze([0.41, 0.42, 0.45]),
  steel: Object.freeze([0.59, 0.61, 0.66]),
  silver: Object.freeze([0.82, 0.84, 0.88]),
  elven: Object.freeze([0.85, 0.79, 0.50]),
  dwarven: Object.freeze([0.73, 0.55, 0.24]),
  mithril: Object.freeze([0.52, 0.67, 0.84]),
  adamantium: Object.freeze([0.34, 0.39, 0.50]),
  ebony: Object.freeze([0.16, 0.16, 0.20]),
  orcish: Object.freeze([0.31, 0.46, 0.30]),
  daedric: Object.freeze([0.43, 0.11, 0.13]),
});

const MATERIAL_TRIMS = Object.freeze({
  leather: [0.30, 0.20, 0.12],
  chain: [0.34, 0.36, 0.40],
  iron: [0.28, 0.29, 0.32],
  steel: [0.74, 0.76, 0.80],
  silver: [0.92, 0.93, 0.96],
  elven: [0.94, 0.88, 0.64],
  dwarven: [0.86, 0.70, 0.34],
  mithril: [0.72, 0.84, 0.96],
  adamantium: [0.54, 0.60, 0.72],
  ebony: [0.78, 0.64, 0.24],
  orcish: [0.50, 0.58, 0.32],
  daedric: [0.72, 0.16, 0.16],
});

// Classic clothing dye RGB palettes matching client/gameplay/inventory/dyes.js CLOTH_DYES keys.
export const CLOTH_DYE_COLORS = Object.freeze({
  blue: Object.freeze([0.20, 0.32, 0.58]),
  grey: Object.freeze([0.46, 0.47, 0.50]),
  red: Object.freeze([0.62, 0.17, 0.15]),
  brown: Object.freeze([0.44, 0.29, 0.17]),
  purple: Object.freeze([0.44, 0.22, 0.48]),
  tan: Object.freeze([0.68, 0.56, 0.38]),
  white: Object.freeze([0.84, 0.82, 0.77]),
  aquamarine: Object.freeze([0.18, 0.52, 0.52]),
  yellow: Object.freeze([0.76, 0.62, 0.20]),
  green: Object.freeze([0.22, 0.44, 0.24]),
});

const DYE_NAMES = Object.freeze(Object.keys(CLOTH_DYE_COLORS));
const DEFAULT_LEG = Object.freeze([0.24, 0.20, 0.17]);
const DEFAULT_BOOT = Object.freeze([0.20, 0.14, 0.10]);
const DEFAULT_BELT = Object.freeze([0.18, 0.12, 0.08]);
const WOOD_COLOR = Object.freeze([0.42, 0.27, 0.14]);
const BOWSTRING_COLOR = Object.freeze([0.78, 0.74, 0.64]);
const TUSK_COLOR = Object.freeze([0.88, 0.84, 0.72]);

const BEAST_PALETTES = Object.freeze({
  werewolf: Object.freeze({
    fur: [0.26, 0.23, 0.22],
    underfur: [0.39, 0.35, 0.32],
    accent: [0.16, 0.14, 0.14],
    eye: [0.85, 0.22, 0.14],
    scale: 1.18,
  }),
  wereboar: Object.freeze({
    fur: [0.36, 0.23, 0.17],
    underfur: [0.48, 0.34, 0.25],
    accent: [0.20, 0.13, 0.10],
    eye: [0.82, 0.30, 0.14],
    scale: 1.14,
  }),
});

const VALID_WEAPONS = new Set(['blade', 'axe', 'blunt', 'staff', 'bow', 'dagger', 'none']);
const STRIDE = 1.5; // metres per full walk cycle
const SWING_DURATION = 0.36; // seconds

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function shade(rgb, factor) {
  return [clamp01(rgb[0] * factor), clamp01(rgb[1] * factor), clamp01(rgb[2] * factor)];
}

function mixRgb(a, b, t) {
  return [
    clamp01(a[0] + (b[0] - a[0]) * t),
    clamp01(a[1] + (b[1] - a[1]) * t),
    clamp01(a[2] + (b[2] - a[2]) * t),
  ];
}

function normalizeRace(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && raw >= 1 && raw <= RACE_NAMES.length) {
    return RACE_NAMES[Math.floor(raw) - 1];
  }
  const key = String(raw).trim().toLowerCase();
  return RACE_ALIASES[key] ?? null;
}

function normalizeMaterial(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/[^a-z]/g, '');
  if (Object.hasOwn(MATERIAL_COLORS, key)) return key;
  if (key === 'chainmail') return 'chain';
  if (key === 'plate' || key === 'steelplate') return 'steel';
  if (key === 'gold' || key === 'brass') return 'dwarven';
  return null;
}

function normalizeDye(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === 'gray') return 'grey';
  if (Object.hasOwn(CLOTH_DYE_COLORS, key)) return key;
  return null;
}

function normalizeBeastForm(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (key === 'werewolf' || key === 'wolf') return 'werewolf';
  if (key === 'wereboar' || key === 'boar') return 'wereboar';
  return null;
}

function normalizeWeaponKind(raw, rightHand) {
  if (raw) {
    const k = String(raw).trim().toLowerCase();
    if (VALID_WEAPONS.has(k)) return k;
    if (k.includes('dagger') || k.includes('short') || k.includes('tanto') || k.includes('wakizashi')) return 'dagger';
    if (k.includes('sword') || k.includes('blade') || k.includes('claymore') || k.includes('katana') || k.includes('saber') || k.includes('dai')) return 'blade';
    if (k.includes('axe')) return 'axe';
    if (k.includes('staff')) return 'staff';
    if (k.includes('bow')) return 'bow';
    if (k.includes('mace') || k.includes('hammer') || k.includes('flail') || k.includes('blunt') || k.includes('club')) return 'blunt';
  }
  if (rightHand) {
    const label = typeof rightHand === 'string'
      ? rightHand
      : (rightHand.weaponKind ?? rightHand.kind ?? rightHand.skill ?? rightHand.name ?? '');
    if (label) {
      const inferred = normalizeWeaponKind(label, null);
      if (inferred !== 'none') return inferred;
    }
    return 'blade';
  }
  return 'none';
}

function slotMaterial(slot, fallbackTier) {
  if (slot && typeof slot === 'object') {
    const m = normalizeMaterial(slot.material ?? slot.armorTier ?? slot.tier);
    if (m) return m;
  }
  return fallbackTier;
}

function slotDye(slot, fallbackDye) {
  if (slot && typeof slot === 'object') {
    const d = normalizeDye(slot.dye ?? slot.color);
    if (d) return d;
  }
  return fallbackDye;
}

/**
 * Derive authentic classic Daggerfall figure colors, silhouette flags, and
 * signature from a peer snapshot (falling back deterministically to `seed`).
 */
export function figureStyleFor(seed, peer = null) {
  const h = hashString(String(seed ?? 'traveller'));
  const race = normalizeRace(peer?.race) ?? RACE_NAMES[h % RACE_NAMES.length];
  const racePal = CLASSIC_RACE_PALETTES[race];

  const primaryDye = normalizeDye(peer?.primaryDye ?? peer?.dye) ?? DYE_NAMES[(h >>> 8) % DYE_NAMES.length];
  const cloth = [...CLOTH_DYE_COLORS[primaryDye]];

  const armorTier = normalizeMaterial(peer?.armorTier ?? peer?.worn?.chest?.material ?? peer?.worn?.armor?.material);
  const armor = armorTier ? [...MATERIAL_COLORS[armorTier]] : null;
  const armorTrim = armorTier ? [...MATERIAL_TRIMS[armorTier]] : [...DEFAULT_BELT];

  const wearingRobes = Boolean(peer?.wearingRobes);
  const worn = peer?.worn && typeof peer.worn === 'object' ? peer.worn : null;
  const hasCloak = Boolean(worn?.cloak || worn?.cloak2 || wearingRobes || peer?.hasCloak);
  const hasHelm = Boolean(worn?.head || peer?.hasHelm);
  const hasShield = Boolean(peer?.hasShield || worn?.leftHand);
  const weaponKind = normalizeWeaponKind(peer?.weaponKind, worn?.rightHand);
  const readied = Boolean(peer?.readied || peer?.inCombat);
  const defeated = Boolean(peer?.defeated);
  const beastForm = normalizeBeastForm(peer?.beastForm);

  const cloakDye = slotDye(worn?.cloak ?? worn?.cloak2, primaryDye);
  const cloakColor = cloakDye ? shade(CLOTH_DYE_COLORS[cloakDye], 0.85) : shade(cloth, 0.80);

  const helmMat = slotMaterial(worn?.head, armorTier) ?? 'steel';
  const helmColor = [...MATERIAL_COLORS[helmMat]];
  const helmTrim = [...MATERIAL_TRIMS[helmMat]];

  const shieldMat = slotMaterial(worn?.leftHand, armorTier) ?? 'steel';
  const shieldColor = [...MATERIAL_COLORS[shieldMat]];
  const shieldTrim = [...MATERIAL_TRIMS[shieldMat]];

  const weaponMat = slotMaterial(worn?.rightHand, normalizeMaterial(peer?.weaponMaterial) ?? armorTier) ?? 'steel';
  const weaponColor = [...MATERIAL_COLORS[weaponMat]];
  const weaponTrim = [...MATERIAL_TRIMS[weaponMat]];

  const primary = wearingRobes ? cloth : (armor ?? cloth);
  const secondary = wearingRobes ? shade(cloth, 0.78) : (armor ? shade(armor, 0.82) : shade(cloth, 0.72));
  const legs = armor && !wearingRobes ? shade(armor, 0.74) : [...DEFAULT_LEG];
  const boots = armor ? shade(armor, 0.55) : [...DEFAULT_BOOT];
  const gauntlets = armor ? shade(armor, 0.88) : null;

  const skin = [...racePal.skin];
  const hair = [...racePal.hair];
  const scale = beastForm ? BEAST_PALETTES[beastForm].scale : (racePal.scale ?? 1.0);

  const signature = [
    race,
    primaryDye,
    armorTier ?? '-',
    wearingRobes ? 'R' : '-',
    hasCloak ? `C:${cloakDye}` : '-',
    hasHelm ? `H:${helmMat}` : '-',
    hasShield ? `S:${shieldMat}` : '-',
    readied ? `W:${weaponKind}:${weaponMat}` : 'W:-',
    defeated ? 'D' : '-',
    beastForm ?? '-',
  ].join('|');

  return {
    race,
    ears: racePal.ears ?? null,
    skin,
    hair,
    cloth,
    primaryDye,
    armorTier,
    armor,
    armorTrim,
    primary,
    secondary,
    legs,
    boots,
    gauntlets,
    cloakColor,
    helmColor,
    helmTrim,
    shieldColor,
    shieldTrim,
    weaponColor,
    weaponTrim,
    hasCloak,
    hasHelm,
    hasShield,
    weaponKind,
    readied,
    wearingRobes,
    defeated,
    beastForm,
    scale,
    signature,
  };
}

/** Local Z-axis rotation helper (mat.js exports rotateX & rotateY). */
function rotateZ(out, a, rad) {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  if (out !== a) out.set(a);
  for (let k = 0; k < 4; k++) {
    const a0 = a[k];
    const a1 = a[4 + k];
    out[k] = a0 * c + a1 * s;
    out[4 + k] = a1 * c - a0 * s;
  }
  return out;
}

function addWeaponParts(spec, style) {
  const pivot = [0.33, 1.48, 0];
  const wc = style.weaponColor;
  const trim = style.weaponTrim;
  switch (style.weaponKind) {
    case 'blade':
      // Hilt, crossguard, long blade extending forward (-z) from the right hand.
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.02], size: [0.05, 0.05, 0.18], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.11], size: [0.18, 0.05, 0.04], color: trim });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.52], size: [0.055, 0.03, 0.78], color: wc });
      break;
    case 'dagger':
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.02], size: [0.045, 0.045, 0.14], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.09], size: [0.11, 0.04, 0.03], color: trim });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.27], size: [0.045, 0.025, 0.34], color: wc });
      break;
    case 'axe':
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.32], size: [0.05, 0.05, 0.78], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.71, -0.64], size: [0.04, 0.24, 0.22], color: wc });
      spec.push({ pivot, swing: 'armR', off: [0, -0.58, -0.64], size: [0.05, 0.08, 0.14], color: trim });
      break;
    case 'blunt':
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.28], size: [0.05, 0.05, 0.66], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.62], size: [0.14, 0.14, 0.18], color: wc });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.62], size: [0.17, 0.06, 0.12], color: trim });
      break;
    case 'staff':
      // Tall mage staff held upright in front of the right hand.
      spec.push({ pivot, swing: 'armR', off: [0.02, -0.36, -0.14], size: [0.05, 1.56, 0.05], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0.02, 0.44, -0.14], size: [0.11, 0.12, 0.11], color: wc });
      spec.push({ pivot, swing: 'armR', off: [0.02, 0.54, -0.14], size: [0.08, 0.08, 0.08], color: trim });
      break;
    case 'bow':
      // Classic curved bow limbs + bowstring held in front.
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.16], size: [0.05, 0.28, 0.05], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.34, -0.12], size: [0.045, 0.36, 0.05], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.94, -0.12], size: [0.045, 0.36, 0.05], color: WOOD_COLOR });
      spec.push({ pivot, swing: 'armR', off: [0, -0.64, -0.06], size: [0.015, 0.92, 0.015], color: BOWSTRING_COLOR });
      break;
    default:
      break;
  }
}

function buildBeastSpec(style) {
  const bp = BEAST_PALETTES[style.beastForm];
  const isBoar = style.beastForm === 'wereboar';
  const fur = bp.fur;
  const under = bp.underfur;
  const acc = bp.accent;
  const spec = [
    // Powerful beast legs
    { pivot: [-0.14, 0.92, 0.02], swing: 'legL', off: [0, -0.44, 0], size: [0.22, 0.88, 0.24], color: fur },
    { pivot: [0.14, 0.92, 0.02], swing: 'legR', off: [0, -0.44, 0], size: [0.22, 0.88, 0.24], color: fur },
    { pivot: [-0.14, 0.92, 0.02], swing: 'legL', off: [0, -0.84, -0.06], size: [0.21, 0.14, 0.30], color: acc },
    { pivot: [0.14, 0.92, 0.02], swing: 'legR', off: [0, -0.84, -0.06], size: [0.21, 0.14, 0.30], color: acc },
    // Broad hunched torso & lighter chest/belly
    { pivot: [0, 0.92, 0], swing: null, off: [0, 0.10, 0], size: [isBoar ? 0.56 : 0.48, 0.34, 0.34], color: fur },
    { pivot: [0, 0.92, 0], swing: null, off: [0, 0.44, -0.03], size: [isBoar ? 0.64 : 0.58, 0.48, 0.38], color: fur },
    { pivot: [0, 0.92, 0], swing: null, off: [0, 0.40, -0.20], size: [0.34, 0.42, 0.08], color: under },
    // Mane / dorsal bristle ridge
    { pivot: [0, 0.92, 0], swing: null, off: [0, 0.58, 0.16], size: [0.22, 0.34, 0.12], color: acc },
    // Long clawed arms
    { pivot: [-0.39, 1.52, -0.02], swing: 'armL', off: [0, -0.34, -0.03], size: [0.18, 0.72, 0.19], color: fur },
    { pivot: [0.39, 1.52, -0.02], swing: 'armR', off: [0, -0.34, -0.03], size: [0.18, 0.72, 0.19], color: fur },
    { pivot: [-0.39, 1.52, -0.02], swing: 'armL', off: [0, -0.74, -0.06], size: [0.16, 0.14, 0.18], color: acc },
    { pivot: [0.39, 1.52, -0.02], swing: 'armR', off: [0, -0.74, -0.06], size: [0.16, 0.14, 0.18], color: acc },
    // Beast head & elongated muzzle
    { pivot: [0, 1.58, -0.06], swing: null, off: [0, 0.20, -0.02], size: [isBoar ? 0.34 : 0.30, 0.30, 0.32], color: fur },
    { pivot: [0, 1.58, -0.06], swing: null, off: [0, 0.14, -0.24], size: [isBoar ? 0.22 : 0.17, 0.15, 0.22], color: under },
    // Glowing eyes
    { pivot: [0, 1.58, -0.06], swing: null, off: [-0.08, 0.24, -0.18], size: [0.05, 0.04, 0.04], color: bp.eye },
    { pivot: [0, 1.58, -0.06], swing: null, off: [0.08, 0.24, -0.18], size: [0.05, 0.04, 0.04], color: bp.eye },
    // Pointed ears
    { pivot: [0, 1.58, -0.06], swing: null, off: [-0.11, 0.40, 0.02], size: [0.08, 0.15, 0.08], color: acc },
    { pivot: [0, 1.58, -0.06], swing: null, off: [0.11, 0.40, 0.02], size: [0.08, 0.15, 0.08], color: acc },
    // Tail
    { pivot: [0, 0.96, 0.18], swing: 'cloak', off: [0, isBoar ? -0.10 : -0.24, isBoar ? 0.08 : 0.16], size: [0.11, isBoar ? 0.22 : 0.46, 0.12], color: acc },
  ];

  if (isBoar) {
    // Twin ivory tusks on the boar snout
    spec.push({ pivot: [0, 1.58, -0.06], swing: null, off: [-0.11, 0.15, -0.32], size: [0.04, 0.12, 0.05], color: TUSK_COLOR });
    spec.push({ pivot: [0, 1.58, -0.06], swing: null, off: [0.11, 0.15, -0.32], size: [0.04, 0.12, 0.05], color: TUSK_COLOR });
  }
  return spec;
}

function buildHumanoidSpec(style) {
  const spec = [];

  // Lower body: full-length robe skirt OR classic trouser/armored legs + boots
  if (style.wearingRobes) {
    const robeMain = style.cloth;
    const robeHem = shade(style.cloth, 0.76);
    spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, -0.36, 0], size: [0.46, 0.72, 0.30], color: robeMain });
    spec.push({ pivot: [-0.09, 0.90, 0], swing: 'legL', off: [0, -0.74, -0.02], size: [0.22, 0.24, 0.28], color: robeHem });
    spec.push({ pivot: [0.09, 0.90, 0], swing: 'legR', off: [0, -0.74, -0.02], size: [0.22, 0.24, 0.28], color: robeHem });
    spec.push({ pivot: [-0.10, 0.90, 0], swing: 'legL', off: [0, -0.84, -0.05], size: [0.13, 0.10, 0.20], color: style.boots });
    spec.push({ pivot: [0.10, 0.90, 0], swing: 'legR', off: [0, -0.84, -0.05], size: [0.13, 0.10, 0.20], color: style.boots });
  } else {
    spec.push({ pivot: [-0.11, 0.90, 0], swing: 'legL', off: [0, -0.34, 0], size: [0.17, 0.68, 0.20], color: style.legs });
    spec.push({ pivot: [0.11, 0.90, 0], swing: 'legR', off: [0, -0.34, 0], size: [0.17, 0.68, 0.20], color: style.legs });
    spec.push({ pivot: [-0.11, 0.90, 0], swing: 'legL', off: [0, -0.76, -0.02], size: [0.18, 0.26, 0.23], color: style.boots });
    spec.push({ pivot: [0.11, 0.90, 0], swing: 'legR', off: [0, -0.76, -0.02], size: [0.18, 0.26, 0.23], color: style.boots });
  }

  // Pelvis / lower tunic, belt & buckle, torso / cuirass
  spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, 0.02, 0], size: [0.46, 0.34, 0.30], color: style.secondary });
  spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, 0.20, 0], size: [0.48, 0.06, 0.32], color: style.armor ? style.armorTrim : DEFAULT_BELT });
  spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, 0.20, -0.165], size: [0.10, 0.07, 0.03], color: style.armorTrim });
  spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, 0.42, 0], size: [0.48, 0.42, 0.28], color: style.primary });

  // Armored pauldrons & chest trim when wearing armor
  if (style.armor && !style.wearingRobes) {
    spec.push({ pivot: [-0.32, 1.50, 0], swing: 'armL', off: [-0.02, 0.02, 0], size: [0.20, 0.16, 0.24], color: style.armor });
    spec.push({ pivot: [0.32, 1.50, 0], swing: 'armR', off: [0.02, 0.02, 0], size: [0.20, 0.16, 0.24], color: style.armor });
    spec.push({ pivot: [0, 0.90, 0], swing: null, off: [0, 0.48, -0.145], size: [0.34, 0.08, 0.03], color: style.armorTrim });
  }

  // Arms & hands/gauntlets
  const sleeveColor = style.wearingRobes ? style.cloth : (style.armor ?? style.cloth);
  const handColor = style.gauntlets ?? style.skin;
  spec.push({ pivot: [-0.33, 1.48, 0], swing: 'armL', off: [0, -0.29, 0], size: [0.14, 0.60, 0.16], color: sleeveColor });
  spec.push({ pivot: [0.33, 1.48, 0], swing: 'armR', off: [0, -0.29, 0], size: [0.14, 0.60, 0.16], color: sleeveColor });
  spec.push({ pivot: [-0.33, 1.48, 0], swing: 'armL', off: [0, -0.64, 0], size: [0.12, 0.11, 0.13], color: handColor });
  spec.push({ pivot: [0.33, 1.48, 0], swing: 'armR', off: [0, -0.64, 0], size: [0.12, 0.11, 0.13], color: handColor });

  // Neck & head
  spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.03, 0], size: [0.12, 0.08, 0.12], color: style.skin });
  spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.20, 0], size: [0.26, 0.28, 0.26], color: style.skin });

  // Helm OR classic hair / beastfolk silhouette
  if (style.hasHelm) {
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.34, 0], size: [0.30, 0.12, 0.30], color: style.helmColor });
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.21, 0.11], size: [0.29, 0.24, 0.10], color: style.helmColor });
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.26, -0.14], size: [0.28, 0.07, 0.05], color: style.helmTrim });
    // Classic helm crest
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.43, 0.01], size: [0.06, 0.09, 0.24], color: style.helmTrim });
  } else {
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.35, 0.02], size: [0.28, 0.07, 0.30], color: style.hair });
    spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.20, 0.10], size: [0.28, 0.26, 0.09], color: style.hair });
    if (style.ears === 'cat') {
      spec.push({ pivot: [0, 1.56, 0], swing: null, off: [-0.10, 0.41, 0], size: [0.06, 0.09, 0.06], color: style.skin });
      spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0.10, 0.41, 0], size: [0.06, 0.09, 0.06], color: style.skin });
    } else if (style.ears === 'crest') {
      spec.push({ pivot: [0, 1.56, 0], swing: null, off: [0, 0.41, 0.04], size: [0.06, 0.09, 0.22], color: style.hair });
    }
  }

  // Trailing cloak / cape on the back
  if (style.hasCloak) {
    const collar = mixRgb(style.cloakColor, style.armorTrim, 0.25);
    spec.push({ pivot: [0, 1.48, 0.14], swing: null, off: [0, 0.02, 0.01], size: [0.50, 0.10, 0.10], color: collar });
    spec.push({ pivot: [0, 1.48, 0.14], swing: 'cloak', off: [0, -0.56, 0.04], size: [0.46, 1.12, 0.06], color: style.cloakColor });
  }

  // Heater / round shield on the left arm
  if (style.hasShield) {
    spec.push({ pivot: [-0.33, 1.48, 0], swing: 'armL', off: [-0.12, -0.40, -0.08], size: [0.06, 0.56, 0.44], color: style.shieldColor });
    spec.push({ pivot: [-0.33, 1.48, 0], swing: 'armL', off: [-0.155, -0.40, -0.08], size: [0.03, 0.16, 0.16], color: style.shieldTrim });
  }

  // Readied weapon in the right hand
  if (style.readied && style.weaponKind !== 'none') {
    addWeaponParts(spec, style);
  }

  return spec;
}

export class ClassicFigure {
  constructor(seed, peer = null) {
    this.seed = seed;
    this.peer = peer;
    this.phase = 0;
    this.moveAmt = 0;
    this.lastX = null;
    this.lastZ = null;
    this.swingAt = -Infinity;
    this.base = new Float32Array(16);
    this.style = null;
    this.spec = [];
    this.parts = [];
    this._applyStyle(figureStyleFor(seed, peer));
  }

  _applyStyle(style) {
    this.style = style;
    this.look = { cloth: style.cloth, skin: style.skin, hair: style.hair };
    this.spec = style.beastForm ? buildBeastSpec(style) : buildHumanoidSpec(style);
    this.parts = this.spec.map((s) => ({ model: new Float32Array(16), color: s.color }));
  }

  /**
   * Update appearance from a new peer snapshot. Rebuilds part geometry only
   * when the visual signature actually changes. Returns true if rebuilt.
   */
  setPeer(peer) {
    this.peer = peer;
    const next = figureStyleFor(this.seed, peer);
    if (this.style && next.signature === this.style.signature) {
      return false;
    }
    this._applyStyle(next);
    return true;
  }

  /** Trigger a right-arm weapon / claw swing pulse at `now` (seconds). */
  triggerSwing(now) {
    if (Number.isFinite(now)) this.swingAt = now;
  }

  /** Update animation and part matrices. Compatible with Avatar.pose(). */
  pose(x, y, z, yaw, moving, dt, time, opts = null) {
    const px = Number.isFinite(x) ? x : 0;
    const py = Number.isFinite(y) ? y : 0;
    const pz = Number.isFinite(z) ? z : 0;
    const pyaw = Number.isFinite(yaw) ? yaw : 0;
    const pdt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const ptime = Number.isFinite(time) ? time : 0;

    if (opts?.peer && opts.peer !== this.peer) {
      this.setPeer(opts.peer);
    }

    const defeated = opts?.defeated != null ? Boolean(opts.defeated) : this.style.defeated;
    const readied = opts?.readied != null ? Boolean(opts.readied) : this.style.readied;

    if (this.lastX !== null && !defeated) {
      const d = Math.hypot(px - this.lastX, pz - this.lastZ);
      if (d < 3) this.phase += (d / STRIDE) * Math.PI * 2;
    }
    this.lastX = px;
    this.lastZ = pz;

    const target = moving && !defeated ? 1 : 0;
    this.moveAmt += (target - this.moveAmt) * Math.min(1, pdt * 8);
    const k = defeated ? 0 : this.moveAmt;
    const s = Math.sin(this.phase);
    const idle = defeated ? 0 : Math.sin(ptime * 1.7) * 0.03 * (1 - k);

    // Attack swing pulse
    let swingAngle = 0;
    const sinceSwing = ptime - this.swingAt;
    if (!defeated && sinceSwing >= 0 && sinceSwing < SWING_DURATION) {
      const u = sinceSwing / SWING_DURATION;
      // Quick windup then crisp downward/forward slash
      swingAngle = u < 0.25
        ? -0.45 * (u / 0.25)
        : -0.45 + 1.55 * Math.sin(((u - 0.25) / 0.75) * Math.PI);
    }

    const readyArmR = !defeated && readied
      ? (this.style.weaponKind === 'bow' ? 1.05 : this.style.weaponKind === 'staff' ? 0.55 : 0.92)
      : 0;
    const readyArmL = !defeated && readied
      ? (this.style.hasShield ? 0.45 : this.style.weaponKind === 'bow' ? 0.85 : 0.18)
      : 0;

    const cloakSway = defeated
      ? 0
      : -(0.10 + 0.30 * k + Math.sin(this.phase * 2) * 0.06 * k + Math.sin(ptime * 2.1) * 0.035);

    const anglesX = {
      legL: defeated ? 0.05 : s * 0.55 * k,
      legR: defeated ? -0.04 : -s * 0.55 * k,
      armL: defeated ? 0.12 : -s * 0.45 * k * (readied ? 0.35 : 1) + idle + readyArmL,
      armR: defeated ? -0.10 : s * 0.45 * k * (readied ? 0.3 : 1) - idle + readyArmR - swingAngle,
      cloak: cloakSway,
    };

    const anglesZ = defeated
      ? { legL: -0.09, legR: 0.09, armL: -0.28, armR: 0.28, cloak: 0 }
      : null;

    const bob = defeated ? 0 : Math.abs(Math.cos(this.phase)) * 0.045 * k;
    const sc = this.style.scale;

    M.identity(this.base);
    if (defeated) {
      // Supine downed pose resting cleanly on the ground at y + 0.16, face up (+Y).
      M.translate(this.base, this.base, px, py + 0.16, pz);
      M.rotateY(this.base, this.base, -pyaw);
      M.rotateX(this.base, this.base, Math.PI / 2);
      M.translate(this.base, this.base, 0, -0.85 * sc, 0);
    } else {
      M.translate(this.base, this.base, px, py + bob, pz);
      M.rotateY(this.base, this.base, -pyaw);
    }
    if (sc !== 1) {
      M.scale(this.base, this.base, sc, sc, sc);
    }

    for (let i = 0; i < this.spec.length; i++) {
      const sp = this.spec[i];
      const m = this.parts[i].model;
      m.set(this.base);
      M.translate(m, m, sp.pivot[0], sp.pivot[1], sp.pivot[2]);
      if (sp.swing) {
        const rx = anglesX[sp.swing];
        if (rx) M.rotateX(m, m, rx);
        if (anglesZ && anglesZ[sp.swing]) rotateZ(m, m, anglesZ[sp.swing]);
      }
      M.translate(m, m, sp.off[0], sp.off[1], sp.off[2]);
      M.scale(m, m, sp.size[0], sp.size[1], sp.size[2]);
    }
    return this;
  }
}
