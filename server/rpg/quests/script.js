// Quest script parser (Daggerfall Unity text format: Quest:/DisplayName:/QRC:/QBN:).
// Block and task rules adapted from Daggerfall Unity Game/Questing/Parser.cs and Task.cs and
// the dfjs port (MIT) — see NOTICE.txt. Scripts are read from operator-supplied files or
// produced by decompileQbn(); nothing is bundled.

import { STATIC_MESSAGES, GLOBAL_BY_NAME } from './tables.js';
import { compileAction } from './actions.js';

export const bare = (s) => String(s ?? '').replace(/^_+|_+$/g, '');
export const key = (s) => bare(s).toLowerCase();

function fieldValue(line) {
  const i = line.indexOf(':');
  return i < 0 ? '' : line.slice(i + 1).trim();
}

/** Splits a script into header fields, QRC lines and QBN lines. */
function sections(text) {
  const out = { name: '', displayName: '', qrc: [], qbn: [], hasQbn: false };
  let mode = 'head';
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    const low = t.toLowerCase();
    if (mode === 'head' || mode === 'qrc') {
      if (low.startsWith('quest:')) { out.name = fieldValue(t); continue; }
      if (low.startsWith('displayname:')) { out.displayName = fieldValue(t); continue; }
    }
    if (low.startsWith('qrc:')) { mode = 'qrc'; continue; }
    if (low.startsWith('qbn:')) { mode = 'qbn'; out.hasQbn = true; continue; }
    if (mode === 'qrc') out.qrc.push(raw.replace(/\r+$/, ''));
    else if (mode === 'qbn' && !t.startsWith('-')) out.qbn.push(raw);
  }
  return out;
}

/** Parses the QRC section of a text script into Map id -> {id, variants}. */
export function parseQrcText(lines) {
  const messages = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.startsWith('-')) continue;
    const m = line.match(/^\s*([A-Za-z]+):\s*(\[\s*(\d+)\s*\]|(\d+))/);
    if (!m) continue;
    const tag = m[1].toLowerCase();
    let id = m[4] ? Number(m[4]) : Number(m[3]);
    if (tag !== 'message' && STATIC_MESSAGES[tag] !== undefined) id = STATIC_MESSAGES[tag];
    const body = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!next.trim()) {
        const after = lines[i + 2];
        if (after === undefined || !after.trim() || after.includes(':') || after.startsWith('-')) break;
        body.push('');
        i++;
        continue;
      }
      if (/^\s*[A-Za-z]+:\s*(\[\s*\d+\s*\]|\d+)/.test(next)) break;
      body.push(next);
      i++;
    }
    const variants = [];
    let cur = [];
    for (const b of body) {
      if (b.trim() === '<--->') {
        variants.push(cur);
        cur = [];
      } else cur.push(b.replace(/<ce>|<rj>|<lj>|<ju>/gi, '').trim());
    }
    variants.push(cur);
    const texts = variants.map((v) => v.join('\n').replace(/^\n+|\n+$/g, '')).filter(Boolean);
    if (texts.length && !messages.has(id)) messages.set(id, { id, variants: texts });
  }
  return messages;
}

const timeRe = /^(?:(\d+)\.)?(\d+):(\d+)$/;
function minutesOf(tok) {
  const m = tok.match(timeRe);
  if (m) return (Number(m[1] || 0) * 1440) + Number(m[2]) * 60 + Number(m[3]);
  if (/^\d+$/.test(tok)) return Number(tok);
  return null;
}

/** Parses one resource declaration line. Returns null for unrecognised lines. */
export function parseResource(line) {
  const t = line.trim().split(/\s+/);
  const kind = t[0].toLowerCase();
  if (!['item', 'person', 'place', 'clock', 'foe'].includes(kind) || t.length < 2) return null;
  const res = { kind, symbol: bare(t[1]), key: key(t[1]), source: line.trim() };
  const rest = t.slice(2);
  const opt = (name) => {
    const i = rest.findIndex((x) => x.toLowerCase() === name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (kind === 'item') {
    res.className = (rest[0] || '').toLowerCase();
    if (res.className === 'gold') {
      const r = line.match(/range\s+(\d+)\s+to\s+(\d+)/i);
      if (r) res.range = [Number(r[1]), Number(r[2])];
    }
    if (res.className === 'artifact' || res.className === 'item') res.detail = rest.slice(1).find((x) => !/^\d+$/.test(x) && !['anyinfo', 'used', 'rumors', 'class', 'subclass'].includes(x.toLowerCase()));
    const used = opt('used');
    if (used) res.usedMessage = Number(used);
    const info = opt('anyinfo');
    if (info) res.infoMessage = Number(info);
  } else if (kind === 'person') {
    const face = opt('face');
    if (face) res.face = Number(face);
    for (const k of ['group', 'faction', 'factiontype', 'named', 'faction_code']) {
      const v = opt(k);
      if (v) { res.by = k; res.value = v; break; }
    }
    // Classic person codes -1.N / -8.N name FACTION.TXT record N (an individual, or a member of that faction).
    const code = res.by === 'faction_code' ? /^-(1|8)\.(\d+)$/.exec(String(res.value)) : null;
    if (code) res.factionId = Number(code[2]);
    res.atHome = rest.some((x) => x.toLowerCase() === 'athome');
    res.remote = rest.some((x) => x.toLowerCase() === 'remote');
    res.questor = res.by === 'group' && String(res.value).toLowerCase() === 'questor';
    const info = opt('anyinfo');
    if (info) res.infoMessage = Number(info);
    const male = rest.some((x) => x.toLowerCase() === 'male');
    const female = rest.some((x) => x.toLowerCase() === 'female');
    if (male || female) res.gender = male ? 'male' : 'female';
  } else if (kind === 'place') {
    res.scope = (rest[0] || '').toLowerCase();
    res.types = (rest[1] || '').toLowerCase().split(',').filter(Boolean);
    if (res.scope === 'permanent') res.site = rest[1] || '';
    res.only = rest.some((x) => x.toLowerCase() === 'only');
  } else if (kind === 'clock') {
    const times = [];
    let flag = 0, rangeMin = 0, rangeMax = 0;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i].toLowerCase();
      if (x === 'flag') { flag = Number(rest[++i]) || 0; continue; }
      if (x === 'range') { rangeMin = Number(rest[++i]) || 0; rangeMax = Number(rest[++i]) || 0; continue; }
      const m = minutesOf(x);
      if (m !== null && times.length < 2) times.push(m);
    }
    Object.assign(res, { times, flag, rangeMin, rangeMax });
  } else if (kind === 'foe') {
    const m = line.match(/\bis\s+(?:(\d+)\s+)?([A-Za-z_]+)/i);
    if (!m) return null;
    res.count = Math.max(1, Number(m[1] || 1));
    res.foeName = m[2];
    const msg = opt('msg');
    if (msg) res.message = Number(msg);
  }
  return res;
}

function readBlock(lines, i) {
  const out = [lines[i].replace(/^\t+|\t+$/g, '').trim()];
  while (i + 1 < lines.length && lines[i + 1].trim()) out.push(lines[++i].trim());
  return { block: out, end: i };
}

/**
 * Parses quest text into a definition. `messages` may be supplied (e.g. from a classic QRC
 * file) to replace the script's own QRC section — that keeps the original words.
 */
export function parseQuest(text, { name, displayName, messages } = {}) {
  const s = sections(text);
  const def = {
    name: (name || s.name || '').toUpperCase(),
    displayName: displayName || s.displayName || '',
    messages: messages ?? parseQrcText(s.qrc),
    resources: new Map(),
    tasks: [],
    problems: [], // structural lines that could not be read
  };
  const qbn = s.hasQbn ? s.qbn : String(text).split(/\r?\n/).filter((l) => !l.trim().startsWith('-'));
  let headless = false;
  for (let i = 0; i < qbn.length; i++) {
    const line = qbn[i];
    const t = line.trim();
    if (!t) continue;
    const low = t.toLowerCase();
    const first = low.split(/\s+/)[0];
    const placement = /^place\s+(?:item|npc|foe)\s+\S+\s+at\b/i.test(t);
    if (!placement && ['item', 'person', 'place', 'clock', 'foe'].includes(first)) {
      const r = parseResource(t);
      if (r) def.resources.set(r.key, r);
      else def.problems.push(`unreadable resource: ${t}`);
      continue;
    }
    if (first === 'variable') {
      def.tasks.push({ symbol: bare(t.split(/\s+/)[1]), type: 'variable', actions: [] });
      continue;
    }
    let m;
    // Global-variable link: "<GlobalName> _symbol_" then (optionally) the task's lines (Parser.GetGlobalReference).
    if ((m = t.match(/^([A-Za-z][A-Za-z0-9]*)\s+(_[A-Za-z0-9_.]+_)$/)) && GLOBAL_BY_NAME.has(m[1].toLowerCase())) {
      const { block, end } = readBlock(qbn, i);
      i = end;
      const actions = block.slice(1).map(compileAction);
      def.tasks.push({ symbol: bare(m[2]), type: actions.length ? 'standard' : 'variable', global: GLOBAL_BY_NAME.get(m[1].toLowerCase()), globalName: m[1], actions });
      continue;
    }
    if ((m = t.match(/^([A-Za-z0-9_.]+)\s+task:/))) {
      const { block, end } = readBlock(qbn, i);
      i = end;
      def.tasks.push({ symbol: bare(m[1]), type: 'standard', actions: block.slice(1).map(compileAction) });
      continue;
    }
    if ((m = t.match(/^until\s+([A-Za-z0-9_.]+)\s+performed:/i))) {
      const { block, end } = readBlock(qbn, i);
      i = end;
      def.tasks.push({ symbol: `until.${bare(m[1])}`, type: 'persist', target: bare(m[1]), actions: block.slice(1).map(compileAction) });
      continue;
    }
    if (!headless) {
      const { block, end } = readBlock(qbn, i);
      i = end;
      headless = true;
      def.tasks.unshift({ symbol: '__startup', type: 'headless', actions: block.map(compileAction) });
      continue;
    }
    // A second unlabelled block is a global-variable link or an unknown construct.
    const { block, end } = readBlock(qbn, i);
    i = end;
    def.problems.push(`unrecognised block: ${block[0]}`);
  }
  if (!def.name) def.problems.push('quest has no name');
  return def;
}
