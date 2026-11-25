// Reader for the classic SPELLS.STD standard spell table (89-byte records).
// Record layout adapted from Daggerfall Unity's DaggerfallSpellReader / SpellRecord
// (MIT License, Copyright (c) 2009-2023 Daggerfall Workshop). No game data is bundled;
// the file is read from the operator-supplied ARENA2 folder at runtime.

export const SPELL_RECORD_SIZE = 0x59;

/** Range type index → target type (EntityEffectBroker.ClassicTargetIndexToTargetType). */
export const TARGET_TYPES = ['caster', 'touch', 'singleAtRange', 'areaAroundCaster', 'areaAtRange'];
/** Element index → element (ClassicElementIndexToElementType). */
export const ELEMENTS = ['fire', 'cold', 'poison', 'shock', 'magic'];

function cString(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
  return s.trim();
}

/**
 * Parse one record. Returns null for records without any effect.
 * @param {Uint8Array} b record bytes (at least 89)
 */
export function parseSpellRecord(b) {
  if (!b || b.length < SPELL_RECORD_SIZE) throw new Error('SPELLS.STD: truncated spell record');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const s8 = (o) => dv.getInt8(o);
  const effects = [];
  for (let i = 0; i < 3; i++) {
    effects.push({
      type: s8(i * 2),
      subType: s8(i * 2 + 1),
      durationBase: b[14 + i * 3], durationMod: b[15 + i * 3], durationPerLevel: b[16 + i * 3],
      chanceBase: b[23 + i * 3], chanceMod: b[24 + i * 3], chancePerLevel: b[25 + i * 3],
      magnitudeBaseLow: b[32 + i * 5], magnitudeBaseHigh: b[33 + i * 5],
      magnitudeLevelBase: b[34 + i * 5], magnitudeLevelHigh: b[35 + i * 5], magnitudePerLevel: b[36 + i * 5],
    });
  }
  if (!effects.some((e) => e.type > -1)) return null;
  return {
    element: b[6],
    rangeType: b[7],
    cost: dv.getUint16(8, true),
    name: cString(b, 47, 25),
    icon: b[72],
    index: b[73],
    effects,
  };
}

/** Parse a whole SPELLS.STD buffer into raw records (in file order). */
export function parseSpellsStd(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  for (let off = 0; off + SPELL_RECORD_SIZE <= b.length; off += SPELL_RECORD_SIZE) {
    const rec = parseSpellRecord(b.subarray(off, off + SPELL_RECORD_SIZE));
    if (rec) out.push(rec);
  }
  return out;
}
