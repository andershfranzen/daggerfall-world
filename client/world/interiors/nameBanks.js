// Shared by classic NPC and building naming. DFRandom and NAMEGEN.DAT, adapted from DFU (MIT).
/** DFRandom: classic LCG; rand() returns 15 bits. */
export function dfRandom(seed) {
  let next = seed >>> 0;
  return {
    rand() {
      next = (Math.imul(next, 1103515245) + 12345) >>> 0;
      return (next >>> 16) & 0x7fff;
    },
  };
}

/** NAMEGEN.DAT with every set kept in place (empty sets stay as []), so set indices match NameHelper. */
export function readNameBanks(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const banks = [];
  for (let k = 0; k < 11; k++) {
    const base = k * 48;
    if (base + 48 > buf.length) break;
    const sets = [];
    for (let s = 0; s < 6; s++) {
      const off = v.getUint32(base + s * 4, true);
      const n = v.getUint32(base + 24 + s * 4, true);
      const parts = [];
      for (let j = 0; j < n; j++) {
        const at = off + j * 10;
        if (at + 10 > buf.length) throw new Error('NAMEGEN.DAT is truncated');
        const raw = buf.subarray(at, at + 10);
        const z = raw.indexOf(0);
        parts.push(String.fromCharCode(...raw.subarray(0, z < 0 ? 10 : z)));
      }
      sets.push(parts);
    }
    banks.push(sets);
  }
  if (!banks[0]?.[0]?.length) throw new Error('NAMEGEN.DAT has no Breton name bank');
  return banks;
}
