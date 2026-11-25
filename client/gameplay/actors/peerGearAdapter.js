// Adapter between public multiplayer peer payloads (`server/rpg/peerAppearance.js`)
// and the classic paper-doll renderer (`client/gameplay/inventory/images.js`).
//
// Pure ES module: zero DOM, WebGL, or Node-only imports. Reconstructs missing
// classic `doll` art descriptors from compact/legacy peer payloads so every
// equipped armor piece, helm, cloak, robe, tunic, trousers, gauntlets, boots,
// shield, and weapon resolves to its authentic Daggerfall ARENA2 archive,
// record/frame, and metal/clothing dye palette.

import {
  dollFiles,
  dollLayers,
  identity,
  isLowerClothed,
  isUpperClothed,
  itemArt,
  RACE_FILE_INDEX,
} from '../inventory/images.js';
import { CLOTH_DYES, METAL_DYES } from '../inventory/dyes.js';
import { textureFileName } from '../../world/textures.js';

const RACE_BY_NORM = Object.freeze(
  Object.fromEntries(
    Object.keys(RACE_FILE_INDEX).map((race) => [normalizeKey(race), race]),
  ),
);

const SLOT_ALIASES = Object.freeze({
  hands: 'gloves',
  cloak1: 'cloak',
});

const VISIBLE_SLOTS = Object.freeze([
  'head',
  'cloak',
  'cloak2',
  'chestArmor',
  'leftArm',
  'rightArm',
  'gloves',
  'legsArmor',
  'feet',
  'chestClothes',
  'legsClothes',
  'rightHand',
  'leftHand',
]);

// Classic weapon paper-doll table (TEXTURE.234 male / TEXTURE.233 female).
// Mirrors `server/rpg/inventory.js` BASES (note Katana doll record is icon.record - 1 = 9).
const WEAPON_CATALOG = Object.freeze({
  dagger: { record: 5, hands: 'either' },
  tanto: { record: 22, hands: 'either' },
  shortsword: { record: 19, hands: 'either' },
  wakizashi: { record: 26, hands: 'either' },
  broadsword: { record: 2, hands: 'either' },
  saber: { record: 17, hands: 'either' },
  longsword: { record: 12, hands: 'either' },
  katana: { record: 9, hands: 'either' },
  claymore: { record: 4, hands: 'both' },
  'dai-katana': { record: 7, hands: 'both' },
  staff: { record: 21, hands: 'both' },
  mace: { record: 14, hands: 'either' },
  flail: { record: 8, hands: 'both' },
  warhammer: { record: 25, hands: 'both' },
  'battle-axe': { record: 0, hands: 'either' },
  'war-axe': { record: 24, hands: 'both' },
  'short-bow': { record: 16, hands: 'both' },
  'long-bow': { record: 11, hands: 'both' },
});

// Classic armor & shield paper-doll table (TEXTURE.245-248 female / 249-252 male).
// Family offsets correspond to [leather, chain, plate].
const ARMOR_CATALOG = Object.freeze({
  cuirass: {
    group: 'armor',
    slot: 'chestArmor',
    baseRecord: 3,
    familyOffsets: [0, 4, 1],
    familyVariants: [[0], [4], [1, 2, 3]],
    drawOrder: 50,
  },
  gauntlets: {
    group: 'armor',
    slot: 'gloves',
    baseRecord: 8,
    familyOffsets: [0, 1, 1],
    familyVariants: [[0], [1], [1]],
    drawOrder: 70,
  },
  greaves: {
    group: 'armor',
    slot: 'legsArmor',
    baseRecord: 10,
    familyOffsets: [0, 6, 2],
    familyVariants: [[0, 1], [6], [2, 3, 4, 5]],
    drawOrder: 30,
  },
  'left-pauldron': {
    group: 'armor',
    slot: 'leftArm',
    baseRecord: 17,
    familyOffsets: [0, 4, 1],
    familyVariants: [[0], [4], [1, 2, 3]],
    drawOrder: 60,
  },
  'right-pauldron': {
    group: 'armor',
    slot: 'rightArm',
    baseRecord: 22,
    familyOffsets: [0, 4, 1],
    familyVariants: [[0], [4], [1, 2, 3]],
    drawOrder: 60,
  },
  helm: {
    group: 'armor',
    slot: 'head',
    baseRecord: 27,
    familyOffsets: [0, 1, 2],
    familyVariants: [
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
      [0, 1, 2, 3, 4, 5],
    ],
    drawOrder: 0,
  },
  boots: {
    group: 'armor',
    slot: 'feet',
    baseRecord: 0,
    familyOffsets: [0, 1, 1],
    familyVariants: [[0], [1, 2], [1, 2]],
    drawOrder: 20,
  },
  buckler: {
    group: 'shield',
    slot: 'leftHand',
    baseRecord: 33,
    familyOffsets: [0, 0, 0],
    familyVariants: [[0], [0], [0]],
    drawOrder: 110,
  },
  'round-shield': {
    group: 'shield',
    slot: 'leftHand',
    baseRecord: 34,
    familyOffsets: [0, 0, 0],
    familyVariants: [[0], [0], [0]],
    drawOrder: 110,
  },
  'kite-shield': {
    group: 'shield',
    slot: 'leftHand',
    baseRecord: 35,
    familyOffsets: [0, 0, 0],
    familyVariants: [[0], [0], [0]],
    drawOrder: 110,
  },
  'tower-shield': {
    group: 'shield',
    slot: 'leftHand',
    baseRecord: 36,
    familyOffsets: [0, 0, 0],
    familyVariants: [[0], [0], [0]],
    drawOrder: 110,
  },
});

// Classic clothing paper-doll table (TEXTURE.235-238 female / 239-242 male).
const CLOTHING_CATALOG = Object.freeze({
  shoes: { slot: 'feet', male: 10, female: 10, maleVariants: 1, femaleVariants: 1, drawOrder: 20, dye: 'brown', cloak: false },
  'tall-boots': { slot: 'feet', male: 11, female: 11, maleVariants: 1, femaleVariants: 1, drawOrder: 18, dye: 'brown', cloak: false },
  sandals: { slot: 'feet', male: 15, female: 15, maleVariants: 1, femaleVariants: 1, drawOrder: 20, dye: 'tan', cloak: false },
  'casual-pants': { slot: 'legsClothes', male: 16, female: 16, maleVariants: 4, femaleVariants: 5, drawOrder: 10, dye: 'brown', cloak: false },
  breeches: { slot: 'legsClothes', male: 18, female: null, maleVariants: 2, femaleVariants: 2, drawOrder: 19, dye: 'grey', cloak: false },
  loincloth: { slot: 'legsClothes', male: 44, female: 44, maleVariants: 3, femaleVariants: 3, drawOrder: 10, dye: 'tan', cloak: false },
  'long-skirt': { slot: 'legsClothes', male: 102, female: 102, maleVariants: 2, femaleVariants: 2, drawOrder: 35, dye: 'purple', cloak: false },
  'short-shirt': { slot: 'chestClothes', male: 50, female: 50, maleVariants: 5, femaleVariants: 5, drawOrder: 40, dye: 'white', cloak: false },
  'long-shirt': { slot: 'chestClothes', male: 63, female: 63, maleVariants: 5, femaleVariants: 5, drawOrder: 40, dye: 'white', cloak: false },
  vest: { slot: 'chestClothes', male: 109, female: 109, maleVariants: 1, femaleVariants: 2, drawOrder: 40, dye: 'brown', cloak: false },
  'open-tunic': { slot: 'chestClothes', male: 100, female: 100, maleVariants: 1, femaleVariants: 1, drawOrder: 40, dye: 'green', cloak: false },
  'short-tunic': { slot: 'chestClothes', male: 35, female: null, maleVariants: 2, femaleVariants: 2, drawOrder: 40, dye: 'red', cloak: false },
  'plain-robes': { slot: 'chestClothes', male: 47, female: 47, maleVariants: 2, femaleVariants: 2, drawOrder: 80, dye: 'grey', cloak: false },
  'priest-robes': { slot: 'chestClothes', male: 49, female: 49, maleVariants: 1, femaleVariants: 1, drawOrder: 80, dye: 'white', cloak: false },
  'casual-cloak': { slot: 'cloak', male: 21, female: 21, maleVariants: 6, femaleVariants: 6, drawOrder: 90, dye: 'blue', cloak: true },
  'formal-cloak': { slot: 'cloak', male: 30, female: 30, maleVariants: 2, femaleVariants: 2, drawOrder: 90, dye: 'red', cloak: true },
});

const ARMOR_MATERIALS = new Set(['leather', 'chain', ...Object.keys(METAL_DYES)]);

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeSlug(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

function normalizeRace(race) {
  const key = normalizeKey(race);
  return RACE_BY_NORM[key] ?? 'Breton';
}

function normalizeGender(gender) {
  return /^f/i.test(String(gender ?? '').trim()) ? 'Female' : 'Male';
}

function normalizeFaceIndex(faceIndex) {
  if (!Number.isFinite(faceIndex)) return 0;
  const n = Math.trunc(faceIndex);
  return n >= 0 && n < 10 ? n : Math.max(0, Math.min(9, n));
}

function normalizeSlot(slot) {
  if (typeof slot !== 'string') return null;
  const trimmed = slot.trim();
  if (!trimmed) return null;
  return SLOT_ALIASES[trimmed] ?? trimmed;
}

function metalDyeOf(material) {
  if (!material || material === 'leather' || material === 'chain') return 'silver';
  return Object.hasOwn(METAL_DYES, material) ? material : 'silver';
}

function parseTemplateString(template) {
  const slug = normalizeSlug(template);
  if (!slug || slug === 'unarmed') return null;

  if (Object.hasOwn(WEAPON_CATALOG, slug)) {
    return { template: `iron-${slug}`, base: slug, group: 'weapon', material: 'iron', dye: null };
  }
  if (Object.hasOwn(ARMOR_CATALOG, slug)) {
    const entry = ARMOR_CATALOG[slug];
    if (entry.group === 'shield') {
      return { template: slug, base: slug, group: 'shield', material: null, dye: null };
    }
    return { template: `leather-${slug}`, base: slug, group: 'armor', material: 'leather', dye: null };
  }
  if (Object.hasOwn(CLOTHING_CATALOG, slug)) {
    const entry = CLOTHING_CATALOG[slug];
    return { template: `${entry.dye}-${slug}`, base: slug, group: 'clothing', material: null, dye: entry.dye };
  }

  const dash = slug.indexOf('-');
  if (dash > 0) {
    const prefix = slug.slice(0, dash);
    const rest = slug.slice(dash + 1);
    if (Object.hasOwn(WEAPON_CATALOG, rest) && Object.hasOwn(METAL_DYES, prefix)) {
      return { template: slug, base: rest, group: 'weapon', material: prefix, dye: null };
    }
    if (Object.hasOwn(ARMOR_CATALOG, rest)) {
      const entry = ARMOR_CATALOG[rest];
      if (entry.group === 'armor' && ARMOR_MATERIALS.has(prefix)) {
        return { template: slug, base: rest, group: 'armor', material: prefix, dye: null };
      }
      if (entry.group === 'shield' && Object.hasOwn(METAL_DYES, prefix)) {
        return { template: slug, base: rest, group: 'shield', material: prefix, dye: null };
      }
    }
    if (Object.hasOwn(CLOTHING_CATALOG, rest) && Object.hasOwn(CLOTH_DYES, prefix)) {
      return { template: slug, base: rest, group: 'clothing', material: null, dye: prefix };
    }
  }
  return null;
}

function resolveCatalogItem(rawItem, slot) {
  if (!rawItem) return null;
  const src = typeof rawItem === 'string' ? { template: rawItem } : rawItem;
  if (typeof src !== 'object') return null;

  const parsedFromTemplate = typeof src.template === 'string' ? parseTemplateString(src.template) : null;
  const rawBase = normalizeSlug(src.base ?? parsedFromTemplate?.base ?? '');
  const parsedFromBase = !parsedFromTemplate && rawBase ? parseTemplateString(rawBase) : null;
  const parsed = parsedFromTemplate ?? parsedFromBase;

  const base = rawBase || parsed?.base || null;
  const group = src.group ?? parsed?.group ?? inferGroupFromDoll(src.doll) ?? inferGroupFromBase(base);
  const material = normalizeOptionalLower(src.material ?? parsed?.material ?? null);
  const dye = normalizeOptionalLower(src.dye ?? parsed?.dye ?? null);
  const template = src.template ?? parsed?.template ?? (base ? buildTemplateKey(group, base, material, dye) : null);

  if (template === 'unarmed' || base === 'unarmed') return null;

  const variant = Number.isInteger(src.variant)
    ? src.variant
    : (Number.isInteger(src.doll?.variant) ? src.doll.variant : undefined);

  let doll = null;
  let hands = src.hands;

  if (base && Object.hasOwn(WEAPON_CATALOG, base)) {
    const spec = WEAPON_CATALOG[base];
    const resolvedMaterial = Object.hasOwn(METAL_DYES, material) ? material : (src.doll?.dye ?? 'iron');
    hands = hands ?? spec.hands;
    doll = {
      set: 'weapon',
      record: Number.isInteger(src.doll?.record) ? src.doll.record : spec.record,
      drawOrder: Number.isInteger(src.doll?.drawOrder) ? src.doll.drawOrder : 100,
      dye: normalizeOptionalLower(src.doll?.dye) ?? resolvedMaterial,
    };
  } else if (base && Object.hasOwn(ARMOR_CATALOG, base)) {
    const spec = ARMOR_CATALOG[base];
    const isShield = spec.group === 'shield';
    const resolvedMaterial = isShield
      ? (Object.hasOwn(METAL_DYES, material) ? material : null)
      : (ARMOR_MATERIALS.has(material) ? material : 'leather');
    const family = isShield
      ? 0
      : (resolvedMaterial === 'leather' ? 0 : resolvedMaterial === 'chain' ? 1 : 2);
    const familyVariants = spec.familyVariants[family] ?? [0];
    const defaultRecord = spec.baseRecord + (spec.familyOffsets[family] ?? 0);
    const record = Number.isInteger(src.doll?.record) ? src.doll.record : defaultRecord;
    if (isShield && !hands) hands = 'left';
    doll = {
      set: 'armor',
      baseRecord: Number.isInteger(src.doll?.baseRecord) ? src.doll.baseRecord : spec.baseRecord,
      record,
      variants: Array.isArray(src.doll?.variants) ? src.doll.variants : familyVariants,
      drawOrder: Number.isInteger(src.doll?.drawOrder) ? src.doll.drawOrder : spec.drawOrder,
      dye: normalizeOptionalLower(src.doll?.dye) ?? metalDyeOf(resolvedMaterial),
    };
  } else if (base && Object.hasOwn(CLOTHING_CATALOG, base)) {
    const spec = CLOTHING_CATALOG[base];
    const resolvedDye = normalizeOptionalLower(src.doll?.dye) ?? dye ?? spec.dye;
    doll = {
      set: 'clothing',
      male: Number.isInteger(src.doll?.male) ? src.doll.male : spec.male,
      female: Number.isInteger(src.doll?.female) ? src.doll.female : spec.female,
      maleVariants: Number.isInteger(src.doll?.maleVariants) ? src.doll.maleVariants : spec.maleVariants,
      femaleVariants: Number.isInteger(src.doll?.femaleVariants) ? src.doll.femaleVariants : spec.femaleVariants,
      variants: Number.isInteger(src.doll?.variants) ? src.doll.variants : Math.max(spec.maleVariants, spec.femaleVariants),
      drawOrder: Number.isInteger(src.doll?.drawOrder) ? src.doll.drawOrder : spec.drawOrder,
      dye: resolvedDye,
      cloak: src.doll?.cloak === true || spec.cloak,
    };
  } else if (src.doll && typeof src.doll === 'object' && typeof src.doll.set === 'string') {
    doll = { ...src.doll };
    if (doll.set === 'weapon' && !hands) {
      hands = 'either';
    }
  }

  if (!doll) return null;

  const out = {
    id: `peer-${slot}`,
    template: template ?? `${slot}-item`,
    base: base ?? null,
    group: group ?? (doll.set === 'clothing' ? 'clothing' : doll.set === 'weapon' ? 'weapon' : 'armor'),
    material: material ?? (doll.set === 'weapon' ? doll.dye ?? null : null),
    dye: dye ?? (doll.set === 'clothing' ? doll.dye ?? null : null),
    slot,
    equipped: slot,
    doll,
  };
  if (hands) out.hands = hands;
  if (Number.isInteger(variant)) out.variant = variant;
  if (typeof src.name === 'string' && src.name.trim()) out.name = src.name.trim();
  return out;
}

function normalizeOptionalLower(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return s || null;
}

function inferGroupFromDoll(doll) {
  if (!doll || typeof doll !== 'object') return null;
  if (doll.set === 'weapon' || doll.set === 'armor' || doll.set === 'clothing') return doll.set;
  return null;
}

function inferGroupFromBase(base) {
  if (!base) return null;
  if (Object.hasOwn(WEAPON_CATALOG, base)) return 'weapon';
  if (Object.hasOwn(ARMOR_CATALOG, base)) return ARMOR_CATALOG[base].group;
  if (Object.hasOwn(CLOTHING_CATALOG, base)) return 'clothing';
  return null;
}

function buildTemplateKey(group, base, material, dye) {
  if (group === 'weapon') return `${material || 'iron'}-${base}`;
  if (group === 'armor') return `${material || 'leather'}-${base}`;
  if (group === 'clothing') return `${dye || CLOTHING_CATALOG[base]?.dye || 'blue'}-${base}`;
  return base;
}

function collectRawWorn(peer) {
  const merged = Object.create(null);
  const sources = [peer?.figure?.worn, peer?.worn];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [rawSlot, item] of Object.entries(src)) {
      const slot = normalizeSlot(rawSlot);
      if (!slot || !item) continue;
      merged[slot] = item;
    }
  }
  return merged;
}

function isPeerReadied(peer) {
  if (!peer || typeof peer !== 'object') return false;
  if (peer.readied === true || peer.readied === 'weapon') return true;
  if (peer.readiedWeapon) return true;
  return false;
}

function isRobeEntry(item) {
  if (!item || typeof item !== 'object') return false;
  const base = String(item.base ?? '').toLowerCase();
  const template = String(item.template ?? '').toLowerCase();
  const name = String(item.name ?? '').toLowerCase();
  return base.includes('robe') || template.includes('robe') || name.includes('robe');
}

/**
 * Converts a public peer payload (`peer.worn`, `peer.figure?.worn`, `peer.weapon`,
 * `peer.race`, `peer.gender`, `peer.faceIndex`, `peer.className`) into a classic
 * `{ character, equipment, inventory }` structure accepted directly by
 * `dollFiles(character)` and `dollLayers(rpg)`.
 */
export function peerToClassicDollInput(peer) {
  const p = peer && typeof peer === 'object' ? peer : {};
  const chSrc = p.character && typeof p.character === 'object' ? p.character : {};

  const character = {
    race: normalizeRace(p.race ?? chSrc.race),
    gender: normalizeGender(p.gender ?? p.sex ?? chSrc.gender ?? chSrc.sex),
    faceIndex: normalizeFaceIndex(p.faceIndex ?? chSrc.faceIndex),
  };
  const className = p.className ?? p.class ?? chSrc.className ?? null;
  if (typeof className === 'string' && className.trim()) {
    character.className = className.trim();
  }

  const rawWorn = collectRawWorn(p);

  // Fallback weapon from compact/legacy peer payloads (`peer.weapon` / `peer.readiedWeapon`).
  if (!rawWorn.rightHand) {
    const fallbackWeapon = p.readiedWeapon ?? p.weapon ?? p.weaponView ?? null;
    if (fallbackWeapon && p.readied !== false) {
      rawWorn.rightHand = fallbackWeapon;
    }
  }

  // Fallback offhand/shield from legacy payloads if present.
  if (!rawWorn.leftHand && p.shield) {
    rawWorn.leftHand = p.shield;
  }

  const equipment = {};
  const inventory = [];

  for (const slot of VISIBLE_SLOTS) {
    const raw = rawWorn[slot];
    if (!raw) continue;
    const item = resolveCatalogItem(raw, slot);
    if (!item) continue;
    equipment[slot] = item.id;
    inventory.push(item);
  }

  // Classic two-handed rule: a two-handed weapon in rightHand occupies both hands.
  const rh = inventory.find((it) => it.id === equipment.rightHand);
  if (rh && rh.hands === 'both' && equipment.leftHand) {
    const lhId = equipment.leftHand;
    delete equipment.leftHand;
    const idx = inventory.findIndex((it) => it.id === lhId);
    if (idx >= 0) inventory.splice(idx, 1);
  }

  return { character, equipment, inventory };
}

/**
 * Resolves the complete manifest of classic ARENA2 files (`BODY*`, `FACE*`,
 * `TEXTURE.*` records, dyes, cloak interior lining, and waist-split clothing flags)
 * needed to render a peer's equipped-gear character figure.
 */
export function resolvePeerDollManifest(peer) {
  const rpg = peerToClassicDollInput(peer);
  const files = dollFiles(rpg.character);
  const id = identity(rpg.character);
  const orderedLayers = dollLayers(rpg);

  const layers = [];
  for (const { slot, item, drawOrder } of orderedLayers) {
    const art = itemArt(item, rpg.character, { doll: true, slot });
    if (!art) continue;
    layers.push({
      slot,
      file: textureFileName(art.archive),
      archive: art.archive,
      record: art.record,
      frame: art.record,
      dye: art.dye?.name ?? item.dye ?? null,
      dyeKind: art.dye?.kind ?? null,
      material: item.material ?? null,
      template: item.template ?? null,
      base: item.base ?? null,
      group: item.group ?? null,
      drawOrder,
    });
  }

  // Cloak interior lining wraps behind the body just like classic Daggerfall.
  const cloakLayer = orderedLayers.find(
    ({ slot, item }) => (slot === 'cloak' || slot === 'cloak2' || item.doll?.cloak === true) && item.doll?.cloak === true,
  );
  let cloakInterior = null;
  if (cloakLayer) {
    const interiorArt = itemArt(cloakLayer.item, rpg.character, {
      doll: true,
      slot: cloakLayer.slot,
      interior: true,
    });
    if (interiorArt) {
      cloakInterior = {
        slot: cloakLayer.slot,
        file: textureFileName(interiorArt.archive),
        archive: interiorArt.archive,
        record: interiorArt.record,
        frame: interiorArt.record,
        dye: interiorArt.dye?.name ?? cloakLayer.item.dye ?? null,
        dyeKind: interiorArt.dye?.kind ?? null,
        material: cloakLayer.item.material ?? null,
        template: cloakLayer.item.template ?? null,
        base: cloakLayer.item.base ?? null,
      };
    }
  }

  const upperClothed = isUpperClothed(layers);
  const lowerClothed = isLowerClothed(layers);

  return {
    background: files.background,
    bodyUnclothed: files.bodyUnclothed,
    bodyClothed: files.bodyClothed,
    heads: files.heads,
    faceIndex: files.faceIndex,
    character: {
      race: id.race,
      gender: id.female ? 'Female' : 'Male',
      faceIndex: id.faceIndex,
      ...(rpg.character.className ? { className: rpg.character.className } : {}),
    },
    upperClothed,
    lowerClothed,
    readied: isPeerReadied(peer) || Boolean(rpg.equipment.rightHand),
    layers,
    cloakInterior,
  };
}

/**
 * True when the peer has visible worn armor, robes, cloak, helm, shield, or weapon,
 * signaling the hybrid renderer to prioritize the equipped-gear figure.
 */
export function hasDistinctEquipment(peer) {
  if (!peer || typeof peer !== 'object') return false;

  const rpg = peerToClassicDollInput(peer);
  for (const [slot, id] of Object.entries(rpg.equipment)) {
    const item = rpg.inventory.find((it) => it.id === id);
    if (!item) continue;
    if (item.group === 'armor' || item.group === 'shield' || item.group === 'weapon') return true;
    if (slot === 'head' || slot === 'cloak' || slot === 'cloak2' || item.doll?.cloak === true) return true;
    if (isRobeEntry(item)) return true;
  }

  // Also honor compact figure summary flags when `worn` was omitted.
  const fig = peer.figure && typeof peer.figure === 'object' ? peer.figure : null;
  if (fig) {
    if (fig.wearingHeavyArmor || fig.wearingRobes || fig.hasShield) return true;
    if (fig.armorTier && fig.armorTier !== 'none') return true;
    if (fig.weaponKind && fig.weaponKind !== 'none') return true;
  }

  return false;
}
