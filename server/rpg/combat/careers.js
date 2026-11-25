// Monster careers (ENEMYnnn.CFG records inside MONSTER.BSA) read from the operator's ARENA2.
//
// Adapted from Daggerfall Unity (MIT License, Copyright (C) 2009-2023 Daggerfall Workshop):
//   API/MonsterFile.cs (LoadMonster: "ENEMY%03d.CFG" in a name-record BSA), API/ClassFile.cs and
//   API/DFCareer.cs (tolerance flags: Paralysis 1, Magic 2, Poison 4, Fire 8, Frost 16, Shock 32, Disease 64).
// Full licence text: ./THIRD_PARTY_NOTICES.txt. No career data ships here; without MONSTER.BSA a monster's
// career is `null` and callers say so (no invented attributes).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ATTRS = ['Strength', 'Intelligence', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck'];
const EFFECTS = [['paralysis', 1], ['magic', 2], ['poison', 4], ['fire', 8], ['cold', 16], ['shock', 32], ['disease', 64]];

/** Read a name-record BSA into Map(upper-case name -> Uint8Array). */
export function readNameBsa(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = v.getInt16(0, true);
  const type = v.getUint16(2, true);
  if (type !== 0x0100 || count < 0 || 4 + count * 18 > bytes.length) throw new Error('MONSTER.BSA: not a name-record BSA');
  const dir = bytes.length - count * 18;
  const out = new Map();
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const at = dir + i * 18;
    let name = '';
    for (let k = 0; k < 14 && bytes[at + k]; k++) name += String.fromCharCode(bytes[at + k]);
    const size = v.getInt32(at + 14, true);
    if (size < 0 || pos + size > dir) throw new Error(`MONSTER.BSA: record ${name} overruns`);
    out.set(name.toUpperCase(), bytes.subarray(pos, pos + size));
    pos += size;
  }
  return out;
}

/** ENEMYnnn.CFG (ClassFile layout, 74 bytes): attributes, tolerances, name. */
export function parseMonsterCfg(b) {
  if (!b || b.length < 74) throw new Error('ENEMY*.CFG record is truncated');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const [resist, immune, low, critical] = [b[0], b[1], b[2], b[3]];
  let name = '';
  for (let i = 0; i < 16 && b[28 + i]; i++) name += String.fromCharCode(b[28 + i]);
  const attributes = {};
  ATTRS.forEach((a, i) => { attributes[a] = v.getUint16(58 + i * 2, true); });
  const tolerances = {};
  for (const [k, bit] of EFFECTS) {
    // DFCareer.GetTolerance precedence: immune, resistant, low tolerance, critical weakness.
    if (immune & bit) tolerances[k] = 'immune';
    else if (resist & bit) tolerances[k] = 'resistant';
    else if (low & bit) tolerances[k] = 'low';
    else if (critical & bit) tolerances[k] = 'critical';
  }
  return Object.freeze({ name: name.trim(), attributes: Object.freeze(attributes), tolerances: Object.freeze(tolerances), hitPointsPerLevel: v.getUint16(52, true) });
}

/** Resolver: monster id -> career from MONSTER.BSA, or null. Cached per data path. */
export function monsterCareerResolver(dataPath, log) {
  let records;
  const load = () => {
    if (records !== undefined) return records;
    records = null;
    if (!dataPath) return records;
    try {
      const f = readdirSync(dataPath).find((n) => n.toUpperCase() === 'MONSTER.BSA');
      if (f) records = readNameBsa(new Uint8Array(readFileSync(join(dataPath, f))));
    } catch (err) {
      log?.warn?.(`[combat] MONSTER.BSA unreadable: ${err.message}`);
    }
    return records;
  };
  const cache = new Map();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const rec = load()?.get(`ENEMY${String(id).padStart(3, '0')}.CFG`);
    let c = null;
    try {
      c = rec ? parseMonsterCfg(rec) : null;
    } catch (err) {
      log?.warn?.(`[combat] ENEMY${id}.CFG: ${err.message}`);
    }
    cache.set(id, c);
    return c;
  };
}
