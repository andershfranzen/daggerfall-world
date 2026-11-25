// Minimal reader for the operator's FACTION.TXT (ARENA2). Only the fields the
// NPC feature uses are kept: id, parent id, type, name, flats, ally/enemy ids.
// The file format is documented by Daggerfall Unity's FactionFile.cs
// (MIT, (c) 2009-2023 Daggerfall Workshop); this parser is original.

/**
 * @returns {Map<number,{id,parent,type,name,face,race,sgroup,ggroup,region,flags,flats:Array<[number,number]>,allies:number[],enemies:number[]}>}
 * `type` 4 is an individual (FactionFile.FactionTypes.Individual); `sgroup` 1 is merchants; `ggroup` is the guild group.
 * `power` (when the record has one) feeds the regional price walk (package 12).
 */
export function parseFactionText(text) {
  const out = new Map();
  const stack = []; // [{indent, rec}]
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith(';')) continue;
    const indent = raw.match(/^\s*/)[0].replace(/ {4}/g, '\t').length;
    const line = raw.trim();
    const head = line.match(/^#(\d+)/);
    if (head) {
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].rec.id : null;
      cur = { id: Number(head[1]), parent, type: null, name: '', face: null, race: -1, sgroup: -1, ggroup: -1, region: -1, flags: 0, flats: [], allies: [], enemies: [] };
      out.set(cur.id, cur);
      stack.push({ indent, rec: cur });
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, tag, value] = m;
    const key = tag.toLowerCase();
    if (key === 'name') cur.name = value.trim().slice(0, 64);
    else if (key === 'type') cur.type = Number(value);
    else if (key === 'face' && /^-?\d+\s*$/.test(value)) cur.face = Number(value);
    else if (key === 'race' || key === 'sgroup' || key === 'ggroup' || key === 'ruler' || key === 'region' || key === 'flags' || key === 'power') {
      const n = Number.parseInt(value, 10);
      // FactionFile: regions are 1-based in the file and 0-based in game (classic converts them too).
      if (Number.isFinite(n)) cur[key] = key === 'region' && n !== -1 ? n - 1 : n;
    } else if (key === 'flat') {
      const [a, r] = value.trim().split(/\s+/).map(Number);
      if (Number.isInteger(a) && Number.isInteger(r) && a > 0 && r >= 0) cur.flats.push([a, r]);
    } else if (key === 'ally') cur.allies.push(Number(value));
    else if (key === 'enemy') cur.enemies.push(Number(value));
  }
  return out;
}
