// Classic compiled quest logic (QBN) reader and decompiler.
//
// The layout below was worked out from the operator's own ARENA2/*.QBN files (all 306
// classic files satisfy it: header + section sizes add up to the file length):
//
//   0x00  16 bytes   unused by this reader
//   0x10  u16[10]    record counts per section
//   0x24  u16[11]    section offsets; [10] = optional symbol-name section
//   sections: 0 items (19 B), 3 people (20 B), 4 places (24 B), 6 clocks (33 B),
//             7 foes (14 B), 8 opcodes (87 B), 9 states (8 B), names (27 B each)
//
// Every resource carries a 32-bit hash of its script name (h = h*2 + charCode over the
// bare name, e.g. "monster" -> 13988), which is how QRC text macros such as =monster_
// find their resource. An opcode is { u16 code, u16 flags, u16 argCount, 5 x 15-byte
// args, u16 messageId at +81 }; an arg is { u8 not, u32 packed, u16 section, i32 value,
// u32 unused }. Arg 0 is always the owning state (-1 = quest start-up): conditions set it,
// actions run once it is set — the same task model Daggerfall Unity's text scripts use,
// so decompileQbn() emits that text syntax and the one engine runs both sources.

export const SECTION = Object.freeze({ ITEM: 0, PERSON: 3, PLACE: 4, CLOCK: 6, FOE: 7, OP: 8, STATE: 9 });
const RECORD = { 0: 19, 3: 20, 4: 24, 6: 33, 7: 14, 8: 87, 9: 8 };
const HEADER = 60;
const NAME_RECORD = 27;

import { buildingTypeName, dungeonTypeName, itemClassName, factionGroupName, FOE_NAME_BY_ID, permanentPlaceName, globalName } from './tables.js';

/** Classic symbol hash over a bare name ("_monster_" and "monster" hash alike). */
export function symbolHash(name) {
  let h = 0;
  for (const ch of String(name).replace(/^[_=#]+|_+$/g, '')) h = (h * 2 + ch.charCodeAt(0)) >>> 0;
  return h;
}

export function readQbn(buf) {
  if (!buf || buf.length < HEADER) throw new Error('QBN file is too short');
  const counts = [];
  const offsets = [];
  for (let i = 0; i < 10; i++) counts.push(buf.readUInt16LE(16 + i * 2));
  for (let i = 0; i < 11; i++) offsets.push(buf.readUInt16LE(36 + i * 2));
  let expected = HEADER;
  for (const [s, size] of Object.entries(RECORD)) {
    const n = counts[s];
    if (!n) continue;
    if (offsets[s] + n * size > buf.length) throw new Error(`QBN section ${s} runs past the end of the file`);
    expected += n * size;
  }
  if (counts[1] || counts[2] || counts[5]) throw new Error('QBN uses an unknown section');
  const namesAt = offsets[10];
  if (namesAt ? namesAt !== expected || (buf.length - namesAt) % NAME_RECORD : expected !== buf.length) {
    throw new Error('QBN section sizes do not match the file length');
  }
  const recs = (s, fn) => Array.from({ length: counts[s] }, (_, i) => fn(offsets[s] + i * RECORD[s], i));
  const s16 = (o) => buf.readInt16LE(o);
  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);
  const msgOf = (v) => (v === 0xffff || v === 0 ? 0 : v);

  const items = recs(0, (o) => ({
    index: u16(o), kind: buf[o + 2], group: s16(o + 3), subIndex: s16(o + 5), hash: u32(o + 7),
    infoMessage: msgOf(u16(o + 15)), usedMessage: msgOf(u16(o + 17)),
  }));
  const people = recs(3, (o) => ({
    index: u16(o), remote: buf[o + 2] === 1, face: buf[o + 3], p2: s16(o + 4), p3: s16(o + 6), hash: u32(o + 8),
    infoMessage: msgOf(u16(o + 16)), rumorMessage: msgOf(u16(o + 18)),
  }));
  const places = recs(4, (o) => ({
    // Local/remote places keep their class in the low byte; permanent sites use the whole u16 (MAPS LocationId).
    index: u16(o), scope: buf[o + 3], p1: buf[o + 3] === 0 ? u16(o + 4) : buf[o + 4], p2: s16(o + 6), hash: u32(o + 12),
  }));
  const clocks = recs(6, (o) => ({
    index: u16(o), flags: u16(o + 2), type: buf[o + 4], minMinutes: buf.readInt32LE(o + 5), maxMinutes: buf.readInt32LE(o + 9),
    hash: u32(o + 29),
  }));
  const foes = recs(7, (o) => ({ index: u16(o), mobile: buf[o + 3], count: buf[o + 4] || 1, hash: u32(o + 6) }));
  const states = recs(9, (o) => ({ index: u16(o), global: buf[o + 2], globalIndex: buf[o + 3], hash: u32(o + 4) }));
  const ops = recs(8, (o) => {
    const argc = Math.min(5, u16(o + 4));
    const args = [];
    for (let a = 0; a < argc; a++) {
      const p = o + 6 + a * 15;
      args.push({ not: buf[p] !== 0, section: u16(p + 5), value: buf.readInt32LE(p + 7) });
    }
    return { code: u16(o), flags: u16(o + 2), args, message: msgOf(u16(o + 81)) };
  });
  const names = [];
  if (namesAt) {
    for (let o = namesAt; o + NAME_RECORD <= buf.length; o += NAME_RECORD) {
      const raw = buf.subarray(o, o + 20);
      const end = raw.indexOf(0);
      const name = raw.subarray(0, end < 0 ? 20 : end).toString('latin1');
      if (name) names.push({ name, section: buf[o + 20], index: u16(o + 21) });
    }
  }
  return { counts, offsets, items, people, places, clocks, foes, states, ops, names };
}

const pad2 = (n) => String(n).padStart(2, '0');
function dhm(minutes) {
  const m = Math.max(0, minutes | 0);
  return `${Math.floor(m / 1440)}.${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`;
}
const hhmm = (m) => `${pad2(Math.floor((m % 1440) / 60))}:${pad2(m % 60)}`;

/** Opcodes this decompiler understands; anything else becomes an `unknown opcode` line. */
export const OPCODE_NAMES = Object.freeze({
  0x00: 'place item', 0x01: 'toting item and clicked npc', 0x02: 'killed foe', 0x03: 'clicked item', 0x04: 'give pc',
  0x05: 'dropped item at', 0x06: 'end quest', 0x07: 'clear', 0x08: 'start quest', 0x09: 'create foe', 0x0a: 'add dialog',
  0x0b: 'dialog link', 0x0c: 'start timer', 0x0d: 'stop timer', 0x13: 'reveal', 0x15: 'injured foe', 0x16: 'place foe',
  0x17: 'log', 0x18: 'remove log', 0x1a: 'get item', 0x1c: 'clicked npc', 0x1d: 'prompt', 0x1e: 'place npc',
  0x1f: 'daily from', 0x22: 'pick one of', 0x23: 'start task', 0x24: 'take item', 0x25: 'repute with', 0x26: 'rumor mill',
  0x27: 'give item to foe', 0x2b: 'pc at', 0x2c: 'destroy npc', 0x2e: 'hide npc', 0x30: 'restore npc', 0x33: 'say',
  0x34: 'when (and)', 0x35: 'when (or)', 0x36: 'make permanent', 0x37: 'add face', 0x38: 'drop face', 0x39: 'item used do',
  0x3d: 'change repute', 0x41: 'legal repute', 0x44: 'restrain foe', 0x45: 'cast spell on foe', 0x46: 'have item set',
  0x4c: 'give pc notify', 0x4e: 'clicked individual', 0x51: 'create npc at', 0x55: 'add as questor', 0x56: 'drop as questor',
  0x32: 'play video', 0x53: 'transfer pc inside',
  // Identified from the operands across all 306 installed QBN files and the matching Daggerfall Unity translations.
  0x11: 'location marker', 0x1b: 'reveal in province', 0x31: 'cure disease', 0x3a: 'cure vampirism',
  0x3b: 'cure lycanthropy', 0x3f: 'add foe face', 0x40: 'drop foe face', 0x47: 'clicked npc and at least gold',
  0x48: 'make pc ill', 0x49: 'cast spell do', 0x4d: 'level completed', 0x4f: 'when repute with faction',
  0x52: 'npc at home', 0x54: 'play sound', 0x57: 'send foe',
});

/**
 * Turns a parsed QBN into quest script text (Daggerfall Unity syntax, QBN section only) plus
 * a symbol table. Message text is not included: it comes from the matching QRC file.
 * @returns {{lines:string[], symbols:object[], unknownOpcodes:number[]}}
 */
export function decompileQbn(q) {
  const named = new Map(); // `${section}:${index}` -> name from the optional name section
  for (const n of q.names) if (!named.has(`${n.section}:${n.index}`)) named.set(`${n.section}:${n.index}`, n.name);
  const symbols = [];
  const sym = (section, index, fallback, hash) => {
    const nm = named.get(`${section}:${index}`);
    const s = `_${(nm || fallback).replace(/[^A-Za-z0-9_.]/g, '')}_`;
    symbols.push({ section, index, symbol: s, hash });
    return s;
  };
  const stateSym = new Map(q.states.map((s) => [s.index, sym(SECTION.STATE, s.index, `S.${pad2(s.index)}`, s.hash)]));
  const stateByHash = new Map(q.states.map((s) => [s.hash, s.index]));
  const itemSym = q.items.map((r) => sym(SECTION.ITEM, r.index, `I.${pad2(r.index)}`, r.hash));
  const personSym = q.people.map((r) => sym(SECTION.PERSON, r.index, `P.${pad2(r.index)}`, r.hash));
  const placeSym = q.places.map((r) => sym(SECTION.PLACE, r.index, `L.${pad2(r.index)}`, r.hash));
  const foeSym = q.foes.map((r) => sym(SECTION.FOE, r.index, `F.${pad2(r.index)}`, r.hash));
  // A clock fires the state with the same hash, so it takes that state's name.
  const clockSym = q.clocks.map((r) =>
    stateByHash.has(r.hash) ? stateSym.get(stateByHash.get(r.hash)) : sym(SECTION.CLOCK, r.index, `C.${pad2(r.index)}`, r.hash),
  );

  const lines = [];
  for (const [i, r] of q.items.entries()) {
    let cls;
    if (r.kind === 2 || r.group === -1) cls = 'gold';
    else cls = itemClassName(r.group, r.subIndex) ?? `item_class_${r.group}_${r.subIndex}`;
    let line = `Item ${itemSym[i]} ${cls}`;
    // Gold with an amount: group/subIndex hold the bounds (K0C00Y08 advance 50/5 = DFU "range 5 to 50";
    // S0000008 rewards 25000/25000). -1 is the level-scaled reward.
    if (cls === 'gold' && r.group > 0 && r.subIndex > 0) line += ` range ${Math.min(r.group, r.subIndex)} to ${Math.max(r.group, r.subIndex)}`;
    // Specific item classes keep their record index for item art (book 7/2 = DFU "book2").
    if (r.usedMessage) line += ` used ${r.usedMessage}`;
    if (r.infoMessage) line += ` anyInfo ${r.infoMessage}`;
    lines.push(line);
  }
  for (const [i, r] of q.people.entries()) {
    const group = factionGroupName(r.p2, r.p3);
    let line = `Person ${personSym[i]}`;
    if (r.face && r.face !== 0xff) line += ` face ${r.face}`;
    line += group ? ` group ${group}` : ` faction_code ${r.p2}.${r.p3}`;
    if (r.remote) line += ' remote';
    if (r.infoMessage) line += ` anyInfo ${r.infoMessage}`;
    lines.push(line);
  }
  for (const [i, r] of q.places.entries()) {
    const scope = r.scope === 1 ? 'local' : r.scope === 2 ? 'remote' : 'permanent';
    let type;
    if (scope === 'permanent') type = permanentPlaceName(r.p1, r.p2) ?? `site_0x${(r.p1 & 0xffff).toString(16)}_0x${(r.p2 & 0xffff).toString(16)}`;
    else if (r.p1 === 0) type = buildingTypeName(r.p2) ?? `building_${r.p2}`;
    else if (r.p1 === 1) type = dungeonTypeName(r.p2);
    else type = `location_${r.p1}_${r.p2}`;
    lines.push(`Place ${placeSym[i]} ${scope} ${type}`);
  }
  for (const [i, r] of q.clocks.entries()) {
    lines.push(`Clock ${clockSym[i]} ${dhm(r.minMinutes)} ${dhm(r.maxMinutes)} flag ${r.flags & 0xff} range ${r.flags >> 8} ${r.type}`);
  }
  for (const [i, r] of q.foes.entries()) {
    const name = FOE_NAME_BY_ID.get(r.mobile) ?? `mobile_${r.mobile}`;
    lines.push(`Foe ${foeSym[i]} is ${r.count > 1 ? `${r.count} ` : ''}${name}`);
  }

  const unknownOpcodes = new Set();
  const st = (a) => (a && a.value >= 0 ? stateSym.get(a.value) : null);
  const ref = (list, a) => (a && a.value >= 0 && a.value < list.length ? list[a.value] : `_missing${a?.value}_`);
  const it = (a) => ref(itemSym, a);
  const np = (a) => ref(personSym, a);
  const pl = (a) => ref(placeSym, a);
  const fo = (a) => ref(foeSym, a);
  const tm = (a) => ref(clockSym, a);
  const v = (a) => (a ? a.value : 0);
  const saying = (m) => (m ? ` saying ${m}` : '');
  const tasks = (args) => args.slice(1).filter((a) => a.value >= 0 && stateSym.has(a.value)).map((a) => stateSym.get(a.value));

  const render = (op) => {
    const [, a1, a2, a3, a4] = op.args;
    const m = op.message;
    switch (op.code) {
      case 0x00: return [`place item ${it(a1)} at ${pl(a2)}`];
      case 0x01: return [`toting ${it(a1)} and ${np(a2)} clicked${saying(m)}`];
      case 0x02: return [`killed ${Math.max(1, v(a2))} ${fo(a1)}${saying(m)}`];
      case 0x03: return [`clicked item ${it(a1)}${m ? ` say ${m}` : ''}`];
      case 0x04: {
        const given = [a1, a2, a3, a4].filter((a) => a && a.value >= 0).map((a) => `give pc ${it(a)}`);
        return given.length ? given : ['give pc nothing'];
      }
      case 0x05: return [`dropped ${it(a1)} at ${pl(a2)}${saying(m)}`];
      case 0x06: return [`end quest${saying(m)}`];
      case 0x07: return [`clear ${tasks(op.args).join(' ')}`];
      case 0x08: return [`start quest ${v(a1)} ${v(a2)}`];
      case 0x09: return [`create foe ${fo(a1)} every ${v(a2)} minutes ${v(a4) > 0 ? `${v(a4)} times` : 'indefinitely'} with ${v(a3)}% success${m ? ` msg ${m}` : ''}`];
      case 0x0a: return [`add dialog for location ${pl(a1)} person ${np(a2)}`];
      case 0x0b: return [`dialog link for location ${pl(a1)} person ${np(a2)}`];
      case 0x0c: return [`start timer ${tm(a1)}`];
      case 0x0d: return [`stop timer ${tm(a1)}`];
      case 0x13: return [`reveal ${pl(a1)}`];
      case 0x15: return [`injured ${fo(a1)}${saying(m)}`];
      case 0x16: return [`place foe ${fo(a1)} at ${pl(a2)}`];
      case 0x17: return [`log ${v(a1)} step ${v(a2)}`];
      case 0x18: return [`remove log step ${v(a1)}`];
      case 0x1a: return [`get item ${it(a1)}${saying(m)}`];
      case 0x1c: return [`clicked npc ${np(a1)}${m ? ` say ${m}` : ''}`];
      case 0x1d: return [`prompt ${v(a3)} yes ${st(a1)} no ${st(a2)}`];
      // Person -1 is the player: Daggerfall Unity's translations read it as "teleport pc to" (A0C00Y06, N0B00Y17).
      case 0x1e: return a1 && a1.value === -1 ? [`teleport pc to ${pl(a2)}`] : [`place npc ${np(a1)} at ${pl(a2)}`];
      case 0x1f: return [`daily from ${hhmm(v(a1))} to ${hhmm(v(a2))}`];
      case 0x22: return [`pick one of ${tasks(op.args).join(' ')}`];
      case 0x23: return tasks(op.args).map((t) => `start task ${t}`);
      case 0x24: return [`take ${it(a1)} from pc${saying(m)}`];
      case 0x25: return [`repute with ${np(a2)} exceeds ${v(a3)} do ${st(a1)}`];
      case 0x26: return [`rumor mill ${v(a1)}`];
      case 0x27: return [`give item ${it(a1)} to ${fo(a2)}`];
      case 0x2b: return [`pc at ${pl(a2)} set ${st(a1)}${saying(m)}`];
      case 0x2c: return [`destroy npc ${np(a1)}`];
      case 0x2e: return [`hide npc ${np(a1)}`];
      case 0x30: return [`restore npc ${np(a1)}`];
      case 0x33: return m ? [`say ${m}`] : [];
      case 0x34:
      case 0x35: {
        const join = op.code === 0x34 ? 'and' : 'or';
        const parts = op.args.slice(1).filter((a) => a.value >= 0 && stateSym.has(a.value));
        if (!parts.length) return [];
        return [parts.map((a, i) => `${i ? join : 'when'}${a.not ? ' not' : ''} ${stateSym.get(a.value)}`).join(' ')];
      }
      case 0x36: return [`make ${it(a1)} permanent`];
      case 0x37: return [`add ${np(a1)} face`];
      case 0x38: return [`drop ${np(a1)} face`];
      case 0x39: return [`${it(a2)} used do ${st(a1)}${saying(m)}`];
      case 0x3d: return [`change repute with ${np(a1)} by ${v(a2) >= 0 ? '+' : ''}${v(a2)}`];
      case 0x41: return [`legal repute ${v(a1) >= 0 ? '+' : ''}${v(a1)}`];
      case 0x44: return [`restrain foe ${fo(a1)}`];
      case 0x45: return [`cast spell ${v(a2)} on ${fo(a1)}`];
      case 0x46: return [`have ${it(a2)} set ${st(a1)}`];
      case 0x4c: return [`give pc ${it(a1)}${m ? ` notify ${m}` : ''}`];
      case 0x51: {
        if (a2 && a2.value >= 0 && a1 && a1.value >= 0) return [`place npc ${np(a2)} at ${pl(a1)}`];
        if (a2 && a2.value >= 0) return [`create npc ${np(a2)}`];
        // No person: the questor goes to that place and must be met there (A0C00Y20, A0C00Y22, A0C01Y01).
        const questor = q.people.findIndex((r) => r.p2 === 21);
        if (questor >= 0 && a1 && a1.value >= 0) return [`place npc ${personSym[questor]} at ${pl(a1)}`];
        return [`create npc at ${pl(a1)}`];
      }
      case 0x55: return [`add ${np(a1)} as questor`];
      case 0x56: return [`drop ${np(a1)} as questor`];
      // Classic "individual available" (S0000008 _S.39_, faction 303 Nulfaga). Daggerfall Unity's script replaces
      // it with "clicked npc _nulfaga_"; this server uses that reading: set once the player talks to the individual.
      case 0x4e: return [`clicked individual ${v(a1)}`];
      case 0x32: return [`play video ${v(a1)}`];
      // S0000016: arg 2/3 are the classic site codes; Daggerfall Unity reads both transfers as marker 0.
      case 0x53: return [`transfer pc inside ${pl(a1)} marker 0`];
      // A0C10Y05/B0C00Y13/K0C10Y11/S0000007: a top-level place reference with no effect in play.
      case 0x11: return [`location marker ${pl(a1)}`];
      // Operands: place, region index, MAPS mapId (low 20 bits), e.g. R0C60Y24 -> Dak'fron/Kykos Coven.
      case 0x1b: return [`reveal ${pl(a1)} in province ${v(a2)} at ${v(a3)}`];
      case 0x31: return [`cure disease ${v(a1)}`];
      case 0x3a: return ['cure vampirism'];
      case 0x3b: return ['cure lycanthropy'];
      case 0x3f: return [`add foe ${fo(a1)} face`];
      case 0x40: return [`drop foe ${fo(a1)} face`];
      // Operands: otherwise-task, gold, person (A0C00Y11: "clicked _healer_ and at least 20 gold otherwise do _S.10_").
      case 0x47: return [`clicked ${np(a3)} and at least ${v(a2)} gold otherwise do ${st(a1)}`];
      case 0x48: return [`make pc ill with disease ${v(a1)}${saying(m)}`];
      // Operands: task, spell (N0B00Y08: casting Sleep, spell 51, completes the job).
      case 0x49: return [`cast spell ${v(a2)} do ${st(a1)}`];
      case 0x4d: return [`level ${v(a1)} completed`];
      case 0x4f: return [`when repute with faction ${v(a1)} is at least ${v(a2)}`];
      case 0x52: return [`npc ${np(a1)} at home`];
      case 0x54: return [`play sound ${v(a1)} every ${v(a2)} minutes ${v(a3)} times`];
      // Operands: foe, minutes, chance, times (-1 = indefinitely); K0C30Y03 "send _F.01_ every 80 minutes 30 times with 15% success".
      case 0x57: return [`send ${fo(a1)} every ${v(a2)} minutes ${v(a4) > 0 ? `${v(a4)} times` : 'indefinitely'} with ${v(a3)}% success`];
      default:
        unknownOpcodes.add(op.code);
        return [`unknown opcode 0x${op.code.toString(16).padStart(2, '0')}`];
    }
  };

  const byOwner = new Map();
  for (const op of q.ops) {
    const owner = op.args[0] && op.args[0].value >= 0 ? op.args[0].value : -1;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(...render(op));
  }
  if (byOwner.get(-1)?.length) {
    lines.push('');
    lines.push(...byOwner.get(-1).map((l) => `\t${l}`));
  }
  for (const s of q.states) {
    const body = byOwner.get(s.index);
    lines.push('');
    if (s.global) {
      // Global-variable link (Daggerfall Unity syntax "<GlobalName> _symbol_" followed by its actions).
      lines.push(`${globalName(s.globalIndex)} ${stateSym.get(s.index)}`);
      if (body?.length) lines.push(...body.map((l) => `\t${l}`));
    } else if (body?.length) {
      lines.push(`${stateSym.get(s.index)} task:`);
      lines.push(...body.map((l) => `\t${l}`));
    } else {
      lines.push(`variable ${stateSym.get(s.index)}`);
    }
  }
  return { lines, symbols, unknownOpcodes: [...unknownOpcodes].sort((a, b) => a - b) };
}
