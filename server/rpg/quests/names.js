// Reads classic NAMEGEN.DAT from the operator's ARENA2 directory and builds Breton names the
// way Daggerfall Unity's NameHelper does (first = A+B from the gender's two sets,
// surname = sets 4+5). Layout: 11 banks x 48 bytes {u32 offset[6], u32 count[6]} followed
// by 10-byte zero-padded name parts. No name data is bundled.

export function readNameGen(buf) {
  const banks = [];
  for (let k = 0; k < 11; k++) {
    const base = k * 48;
    if (base + 48 > buf.length) break;
    const sets = [];
    for (let s = 0; s < 6; s++) {
      const off = buf.readUInt32LE(base + s * 4);
      const n = buf.readUInt32LE(base + 24 + s * 4);
      if (!n) continue;
      const parts = [];
      for (let j = 0; j < n; j++) {
        const at = off + j * 10;
        if (at + 10 > buf.length) throw new Error('NAMEGEN.DAT is truncated');
        const raw = buf.subarray(at, at + 10);
        const z = raw.indexOf(0);
        parts.push(raw.subarray(0, z < 0 ? 10 : z).toString('latin1'));
      }
      sets.push(parts);
    }
    banks.push(sets);
  }
  if (!banks[0] || banks[0].length < 6) throw new Error('NAMEGEN.DAT has no Breton name bank');
  return banks;
}

/** Breton full name from bank 0. `rand()` returns [0,1). */
export function bretonName(banks, gender, rand) {
  const sets = banks[0];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)] ?? '';
  const female = String(gender).toLowerCase().startsWith('f');
  const first = female ? pick(sets[2]) + pick(sets[3]) : pick(sets[0]) + pick(sets[1]);
  const last = pick(sets[4]) + pick(sets[5]);
  return `${first} ${last}`.trim();
}
