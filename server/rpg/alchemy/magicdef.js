// MAGIC.DEF reader and the classic artifact catalogue.
//
// The record layout follows Daggerfall Unity's MagicItemsFile.cs (MIT, (c) 2009-2023 Daggerfall
// Workshop): int32 count, then per record name[32], type u8, group u8, groupIndex u8, 10 × (type i8,
// param i8), uses i16, value i32, material u8. Names and enchantments are read from the operator's
// own ARENA2 copy at start-up; nothing from the file is stored in this repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECORD = 62;

export function parseMagicDef(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 4) throw new Error('MAGIC.DEF is empty');
  const n = b.readInt32LE(0);
  if (n < 0 || 4 + n * RECORD > b.length) throw new Error('MAGIC.DEF is truncated');
  const out = [];
  for (let i = 0, o = 4; i < n; i++, o += RECORD) {
    const enchantments = [];
    for (let k = 0; k < 10; k++) {
      const type = b.readInt8(o + 35 + 2 * k);
      if (type >= 0) enchantments.push({ type, param: b.readInt8(o + 36 + 2 * k) });
    }
    out.push({
      index: i,
      name: b.subarray(o, o + 32).toString('latin1').split('\0')[0],
      type: b[o + 32], // 0 regular magic item, 1 Daedric artifact, 2 other artifact
      group: b[o + 33],
      groupIndex: b[o + 34],
      enchantments,
      uses: b.readInt16LE(o + 55),
      value: b.readInt32LE(o + 57),
      material: b[o + 61],
    });
  }
  return out;
}

function findFile(dir, name) {
  if (!dir || !existsSync(dir)) return null;
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  const hit = readdirSync(dir).find((f) => f.toUpperCase() === name);
  if (hit) return join(dir, hit);
  const sub = readdirSync(dir).find((f) => f.toUpperCase() === 'ARENA2');
  return sub ? findFile(join(dir, sub), name) : null;
}

export function loadMagicDef(arena2Dir) {
  const path = findFile(arena2Dir, 'MAGIC.DEF');
  if (!path) return { records: [], error: 'MAGIC.DEF not found' };
  try {
    return { records: parseMagicDef(readFileSync(path)) };
  } catch (err) {
    return { records: [], error: err.message };
  }
}

/**
 * DFU ArtifactsSubTypes, in MAGIC.DEF artifact order (records of type 1 then 2). The QBN detail
 * strings of `Item … artifact <Name>` use these spellings (plus "Masque_of_Clavicus_Vile").
 */
export const ARTIFACT_SUBTYPES = Object.freeze([
  'Masque_of_Clavicus', 'Mehrunes_Razor', 'Mace_of_Molag_Bal', 'Hircine_Ring', 'Sanguine_Rose', 'Oghma_Infinium',
  'Wabbajack', 'Ring_of_Namira', 'Skull_of_Corruption', 'Azuras_Star', 'Volendrung', 'Warlocks_Ring', 'Auriels_Bow',
  'Necromancers_Amulet', 'Chrysamere', 'Lords_Mail', 'Staff_of_Magnus', 'Ring_of_Khajiit', 'Ebony_Mail',
  'Auriels_Shield', 'Spell_Breaker', 'Skeletons_Key', 'Ebony_Blade',
]);

/** Normalise any spelling of an artifact name to a comparable slug. */
export function artifactSlug(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^the-/, '')
    .replace(/-vile$/, '');
}

export const artifactKey = (subtype) => `artifact-${artifactSlug(ARTIFACT_SUBTYPES[subtype])}`;

export const ARTIFACT_KEYS = Object.freeze(ARTIFACT_SUBTYPES.map((_, index) => artifactKey(index)));

/** Resolve the numeric subtype, quest-script spelling or installed display name to the inventory key. */
export function artifactResolver(artifactDefs) {
  const byName = new Map();
  for (const [i, subtype] of ARTIFACT_SUBTYPES.entries()) {
    byName.set(artifactSlug(subtype), ARTIFACT_KEYS[i]);
    if (artifactDefs[i]) byName.set(artifactSlug(artifactDefs[i].name), ARTIFACT_KEYS[i]);
  }
  byName.set('hircines-ring', ARTIFACT_KEYS[3]);
  byName.set('sanguines-rose', ARTIFACT_KEYS[4]);
  byName.set('ring-of-khajiiti', ARTIFACT_KEYS[17]);
  return function resolve(value) {
    if (Number.isInteger(value)) return ARTIFACT_KEYS[value] ?? null;
    if (typeof value !== 'string') return null;
    if (/^\d+$/.test(value)) return ARTIFACT_KEYS[Number(value)] ?? null;
    if (ARTIFACT_KEYS.includes(value)) return value;
    return byName.get(artifactSlug(value)) ?? null;
  };
}
