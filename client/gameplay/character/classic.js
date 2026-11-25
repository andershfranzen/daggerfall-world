// Readers for the classic creation data in the player's or operator's own ARENA2 folder, and the rules that
// use them: the class questionnaire (TEXT.RSC 9000 + CLASSES.DAT), class descriptions (TEXT.RSC 2100+),
// and the biography questionnaire with its effects and backstory (BIOGnnT0.TXT + TEXT.RSC 4116+).
// Pure ES module, shared by the browser wizard and the authoritative server. No game text ships here: every
// question, answer and story is read from the installation at runtime.
//
// Adapted from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), see NOTICE.txt:
//   API/TextFile.cs (record layout), Game/UserInterfaceWindows/CreateCharClassQuestions.cs (question pick,
//   answer table, CLASSES.DAT results lookup), API/BiogFile.cs + BiogFileMCP.cs (BIOG parsing, effects,
//   reputation digest, backstory macros), DaggerfallStartNewGameWizard.cs (random answers, class affinity).

import { CLASSES, SKILLS } from './rules.js';

// ------------------------------------------------------------------ TEXT.RSC

const RSC = { NewLine: 0x00, EndOfPage: 0xf6, Font: 0xf9, Position: 0xfb, Left: 0xfc, Center: 0xfd, End: 0xfe, Sub: 0xff };

/** TEXT.RSC: u16 header length; (u16 id, u32 offset) × (len/6 − 1); records end with 0xFE. */
export function parseTextRsc(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) throw new Error('Not a TEXT.RSC file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = v.getUint16(0, true);
  const count = headerLength / 6 - 1;
  if (!Number.isInteger(count) || count < 1 || headerLength > bytes.length) throw new Error('Not a TEXT.RSC file.');
  const offsets = new Map();
  for (let i = 0; i < count; i++) offsets.set(v.getUint16(2 + i * 6, true), v.getUint32(4 + i * 6, true));
  const cache = new Map();
  const variants = (id) => {
    if (cache.has(id)) return cache.get(id);
    const o = offsets.get(id);
    if (o === undefined || o >= bytes.length) return null;
    const out = [];
    let s = '';
    for (let p = o; p < bytes.length; p++) {
      const c = bytes[p];
      if (c === RSC.End) break;
      if (c === RSC.Sub) { out.push(s); s = ''; continue; }
      if (c >= 0x20 && c <= 0x7f) s += String.fromCharCode(c);
      else if (c === RSC.NewLine || c === RSC.Left || c === RSC.Center || c === RSC.EndOfPage) s += '\n';
      else if (c === RSC.Font || c === RSC.Position) p++; // operand byte
    }
    out.push(s);
    cache.set(id, out);
    return out;
  };
  return {
    has: (id) => offsets.has(id),
    variants,
    /** One variant's text (`pick` in [0,1) chooses among sub-records, as GetRSCTokens does). */
    text: (id, pick = 0) => {
      const all = variants(id);
      if (!all) return null;
      return all[Math.min(all.length - 1, Math.floor(pick * all.length))];
    },
    get size() { return offsets.size; },
  };
}

// ------------------------------------------------------------------ class questionnaire

export const CLASS_QUESTIONS_RECORD = 9000;
export const CLASS_DESCRIPTIONS_RECORD = 2100;
export const CLASS_QUESTION_COUNT = 10; // asked per questionnaire
const WEIGHT_PATHS = ['warrior', 'rogue', 'mage'];

// CreateCharClassQuestions.answerTable: for question q (0-based) and answer a/b/c, the path it adds to
// (0 warrior, 1 rogue, 2 mage).
const ANSWER_TABLE = Object.freeze([
  0, 2, 1, 0, 2, 1, 0, 1, 2, 2, 0, 1, 0, 1, 2, 1, 0, 2, 0, 1, 2, 2, 0, 1, 0, 2, 1, 0, 1, 2,
  0, 1, 2, 0, 1, 2, 0, 2, 1, 0, 1, 2, 1, 0, 2, 1, 2, 0, 2, 0, 1, 1, 0, 2, 0, 1, 2, 2, 0, 1,
  1, 0, 2, 0, 1, 2, 0, 2, 1, 2, 1, 0, 1, 0, 2, 0, 2, 1, 2, 1, 0, 2, 0, 1, 2, 1, 0, 2, 1, 0,
  2, 0, 1, 1, 0, 2, 0, 2, 1, 2, 1, 0, 1, 2, 0, 2, 0, 1, 2, 0, 1, 1, 2, 0, 0, 1, 2, 1, 2, 0,
]);

/**
 * Splits TEXT.RSC record 9000 into its numbered questions:
 * [{ number, prompt, answers: [{ letter, text }] }]. Lines are re-flowed; nothing is reworded.
 */
export function parseClassQuestions(recordText) {
  if (typeof recordText !== 'string') return [];
  const out = [];
  let q = null;
  let part = null;
  const flush = () => { if (q) out.push(q); };
  // A few records start an answer mid-line ("...inclined to: a)  Ask..."): split there, but only at the
  // letter that is due next, so ordinary text is never cut.
  const segments = [];
  let due = 'a';
  for (const raw of recordText.split('\n')) {
    let rest = raw.replace(/^\s*\{/, '');
    if (/^\s*\d+\.\s/.test(rest)) due = 'a';
    for (;;) {
      const lead = new RegExp(`^\\s*${due}\\)\\s`).test(rest);
      if (lead) due = String.fromCharCode(due.charCodeAt(0) + 1);
      const m = new RegExp(`\\s(${due})\\)\\s`).exec(rest.slice(1));
      if (!m || due > 'c') break;
      segments.push(rest.slice(0, m.index + 1));
      rest = rest.slice(m.index + 1);
    }
    segments.push(rest);
  }
  for (const raw of segments) {
    const line = raw.trimEnd();
    const qm = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const am = /^\s*([abc])\)\s+(.*)$/.exec(line);
    if (qm && (!q || Number(qm[1]) === q.number + 1)) {
      flush();
      q = { number: Number(qm[1]), prompt: qm[2].trim(), answers: [] };
      part = 'prompt';
    } else if (am && q) {
      q.answers.push({ letter: am[1], text: am[2].trim() });
      part = 'answer';
    } else if (q && line.trim()) {
      if (part === 'prompt') q.prompt += ` ${line.trim()}`;
      else if (part === 'answer') q.answers[q.answers.length - 1].text += ` ${line.trim()}`;
    }
  }
  flush();
  return out.filter((x) => x.answers.length === 3);
}

/** GetQuestions: ten distinct questions; a collision steps to the next free index. */
export function pickClassQuestions(total, rng, count = CLASS_QUESTION_COUNT) {
  const picked = new Set();
  const out = [];
  for (let i = 0; i < Math.min(count, total); i++) {
    let idx = Math.min(total - 1, Math.floor(rng() * total));
    while (picked.has(idx)) idx = (idx + 1) % total;
    picked.add(idx);
    out.push(idx);
  }
  return out;
}

/** Weights [warrior, rogue, mage] from (question index, answer 0..2) pairs. */
export function classQuizWeights(pairs) {
  const w = [0, 0, 0];
  for (const [qi, a] of pairs) {
    const path = ANSWER_TABLE[qi * 3 + a];
    if (path === undefined) throw new Error('Invalid questionnaire answer.');
    w[path]++;
  }
  return w;
}

export const weightPathName = (i) => WEIGHT_PATHS[i];

/**
 * CLASSES.DAT results lookup (GetHeaderIndex + GetClassIndex): find the weight triple in the results table
 * starting at offset 18; its slot / 4 indexes the header byte that holds the class (0..17).
 */
export function classIndexFromClassesDat(data, weights) {
  if (!(data instanceof Uint8Array) || data.length < 18 + 3) throw new Error('Not a CLASSES.DAT file.');
  let offset = 18;
  for (let i = 0; i < 18 + 48 && offset + 2 < data.length; i++, offset += 3) {
    if (data[offset] === weights[0] && data[offset + 1] === weights[1] && data[offset + 2] === weights[2]) {
      const header = Math.floor(i / 4);
      let r = data[header];
      if (header > 3) r &= 0x0f;
      return r < CLASSES.length ? r : -1;
    }
  }
  return -1;
}

// ------------------------------------------------------------------ biography (BIOGnnT0.TXT)

export const BIOG_QUESTION_COUNT = 12;
export const DEFAULT_BACKSTORY_RECORD = 4116; // + class index
export const REPUTATION_RECORD = 35;
export const SOCIAL_GROUPS = Object.freeze(['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld']);
export const biogFileName = (classIndex, template = 0) => `BIOG${String(classIndex).padStart(2, '0')}T${template}.TXT`;
export const BIOG_FILE_RE = /^BIOG(\d\d)T(\d+)\.TXT$/i;

/** Decodes a BIOG file's bytes (classic files are 8-bit text). */
export function decodeLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * BiogFile constructor: 12 questions of up to two text lines, then lettered answers ("a.<tab>Text") each
 * followed by effect lines until the next answer or a blank line. An optional leading "#id" line overrides
 * the backstory record.
 */
export function parseBiog(text, classIndex = 0) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let i = 0;
  const next = () => (i < lines.length ? lines[i++] : null);
  let cur = next();
  const skipBlank = () => { while (cur !== null && cur.trim().length <= 0) cur = next(); };
  let backstoryId = DEFAULT_BACKSTORY_RECORD + classIndex;
  const questions = [];
  for (let qn = 0; qn < BIOG_QUESTION_COUNT; qn++) {
    skipBlank();
    if (cur === null) break;
    if (qn === 0 && cur.trim().startsWith('#')) {
      const id = Number.parseInt(cur.trim().slice(1), 10);
      if (Number.isInteger(id)) backstoryId = id;
      cur = next();
      skipBlank();
    }
    const q = { text: [], answers: [] };
    const first = cur.split('.');
    if (first.length < 2) throw new Error(`BIOG question ${qn + 1} is malformed.`);
    q.text.push(cur.slice(cur.indexOf('.') + 1).trim());
    cur = next();
    if (cur !== null && cur.trim() && !isAnswerLine(cur) && !/^\s*\d+\./.test(cur)) {
      q.text.push(cur.trim());
      cur = next();
    }
    while (cur !== null && isAnswerLine(cur)) {
      const ans = { text: cur.slice(cur.indexOf('.') + 1).trim(), effects: [] };
      cur = next();
      while (cur !== null && !isAnswerLine(cur) && cur.trim().length > 0) {
        ans.effects.push(cur.trim().replace(/\s+/g, ' '));
        cur = next();
      }
      q.answers.push(ans);
    }
    if (!q.answers.length) throw new Error(`BIOG question ${qn + 1} has no answers.`);
    questions.push(q);
  }
  if (questions.length !== BIOG_QUESTION_COUNT) throw new Error('BIOG file does not have twelve questions.');
  return { classIndex, backstoryId, questions };
}

const isAnswerLine = (l) => /^[A-Za-z]\./.test(l);

/** Answers chosen at random, as "let the game choose" does. */
export function randomBiogAnswers(biog, rng) {
  return biog.questions.map((q) => Math.min(q.answers.length - 1, Math.floor(rng() * q.answers.length)));
}

/** Validates answer indices against the file. Returns a clean array. */
export function checkBiogAnswers(biog, answers) {
  if (!Array.isArray(answers) || answers.length !== biog.questions.length) throw new Error('Answer every biography question.');
  return answers.map((a, qi) => {
    if (!Number.isInteger(a) || a < 0 || a >= biog.questions[qi].answers.length) throw new Error(`Choose an answer for biography question ${qi + 1}.`);
    return a;
  });
}

/** AddEffect for every chosen answer: text-macro effects are tagged with their question index. */
export function biogEffects(biog, answers) {
  const out = [];
  answers.forEach((a, qi) => {
    for (const e of biog.questions[qi].answers[a].effects) out.push(/^[#!?]/.test(e) ? `${e} ${qi}` : e);
  });
  return out;
}

const SKILL_BY_ID = SKILLS;
const MOD_KEYS = { RP: 'resistPoison', FT: 'fatigue', RR: 'reaction', RD: 'resistDisease', MR: 'resistMagic', TH: 'avoidHit' };

/**
 * ApplyPlayerEffect / DigestRepChanges / GetSkillEffects as data: what the chosen answers do.
 * { skills:{name:mod}, gold, items:[{group,index,material}], socialGroups:[5], factions:{id:delta},
 *   mods:{...}, tokens: number[][] (per question, for %qN macros), ignored:[] }
 */
export function digestBiogEffects(effects) {
  const d = { skills: {}, gold: 0, items: [], socialGroups: [0, 0, 0, 0, 0], factions: {}, mods: {}, tokens: Array.from({ length: BIOG_QUESTION_COUNT }, () => []), ignored: [] };
  for (const effect of effects) {
    const t = effect.split(/\s+/);
    const n = Number.parseInt(t[0], 10);
    if (/^\d+$/.test(t[0]) && n >= 0 && n < SKILL_BY_ID.length) {
      const mod = Number.parseInt(t[1], 10);
      if (Number.isFinite(mod)) d.skills[SKILL_BY_ID[n]] = (d.skills[SKILL_BY_ID[n]] ?? 0) + mod;
    } else if (t[0] === 'GP') {
      const v = Number.parseInt(t.length > 2 ? t[1] + t[2] : t[1], 10);
      if (Number.isFinite(v)) d.gold += v;
    } else if (t[0] === 'IT') {
      const [group, index, material] = t.slice(1, 4).map((x) => Number.parseInt(x, 10));
      if ([group, index, material].every(Number.isInteger)) d.items.push({ group, index, material });
    } else if (/^rf\d+$/.test(t[0])) {
      const id = Number(t[0].slice(2));
      const v = Number.parseInt(t[1], 10);
      if (Number.isFinite(v)) d.factions[id] = (d.factions[id] ?? 0) + v;
    } else if (/^r\d+$/.test(t[0])) {
      const id = Number(t[0].slice(1));
      const v = Number.parseInt(t[1], 10);
      if (id < 5 && Number.isFinite(v)) d.socialGroups[id] += v;
    } else if (MOD_KEYS[t[0]]) {
      const v = Number.parseInt(t[1], 10);
      if (Number.isFinite(v)) d.mods[MOD_KEYS[t[0]]] = v; // classic keeps the last value
    } else if (/^[#!?]\d+$/.test(t[0]) && /^\d+$/.test(t[1] ?? '')) {
      const qi = Number(t[1]);
      if (qi < BIOG_QUESTION_COUNT) d.tokens[qi].push(Number(t[0].slice(1)));
    } else {
      d.ignored.push(effect); // AE/AF/AO and stray lines: classic ignores them too
    }
  }
  if (d.gold < 0) d.gold = 0;
  return d;
}

const HOME = {
  Argonian: ['Black Marsh', 'swamps'], Breton: ['High Rock', 'rolling hills'], 'Dark Elf': ['Morrowind', 'mountains'],
  'High Elf': ['Summerset Isle', 'shores'], Khajiit: ['Elsweyr', 'desert land'], Nord: ['Skyrim', 'mountains'],
  Redguard: ['Hammerfell', 'desert land'], 'Wood Elf': ['Valenwood', 'forests'],
};
const changeWord = (v) => (v === 0 ? 'unchanged' : v < 0 ? 'lower' : 'higher');

/**
 * Expands a biography text record (backstory or reputation notice). `pick(n)` chooses a variant index for
 * multi-variant records; pass a seeded function for a stable story. Name macros (%bn %fn %mn %imp) need the
 * name generator, which is not read yet; they become neutral words.
 */
export function expandBiogText(rsc, id, digest, { race = 'Breton', pick = () => 0 } = {}) {
  const variants = rsc.variants(id);
  if (!variants) return null;
  const pickText = (rid) => {
    const v = rsc.variants(rid);
    if (!v) return '';
    return (v[Math.min(v.length - 1, Math.max(0, pick(v.length)))] ?? '').split('\n')[0].trim();
  };
  const tok = (q, k) => {
    const list = digest.tokens[q - 1] ?? [];
    return list.length > k ? pickText(list[k]) : '';
  };
  const text = variants[Math.min(variants.length - 1, Math.max(0, pick(variants.length)))];
  return text.replace(/%(q(\d+)([ab])?|r([1-5])|hpn|hpw|ra|bn|fn|mn|imp)/g, (m, all, qn, suf, rn) => {
    if (qn) return tok(Number(qn), suf === 'a' ? 1 : suf === 'b' ? 2 : 0);
    if (rn) return changeWord(digest.socialGroups[Number(rn) - 1]);
    switch (all) {
      case 'hpn': return HOME[race]?.[0] ?? '';
      case 'hpw': return HOME[race]?.[1] ?? '';
      case 'ra': return race;
      case 'bn': return 'a stranger';
      case 'fn': return 'a woman';
      case 'mn': return 'a man';
      case 'imp': return "the Emperor's son";
      default: return m;
    }
  });
}

/** Backstory as paragraphs: the file's hard-wrapped lines joined, blank lines separating paragraphs. */
export function backstoryLines(rsc, biog, digest, opts) {
  const text = expandBiogText(rsc, biog.backstoryId, digest, opts);
  if (text == null) return [];
  const paras = [];
  let cur = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l) cur.push(l);
    else if (cur.length) { paras.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras;
}

/** GetClassAffinityIndex: the standard class sharing most skills with a custom class. */
export function classAffinityIndex(custom, careers) {
  let best = 0;
  let bestIndex = 0;
  const mine = [...custom.primarySkills, ...custom.majorSkills, ...custom.minorSkills];
  careers.forEach((c, i) => {
    const theirs = new Set([...c.primarySkills, ...c.majorSkills, ...c.minorSkills]);
    const n = mine.filter((s) => theirs.has(s)).length;
    if (n > best) { best = n; bestIndex = i; }
  });
  return bestIndex;
}

/** Classic class index (CLASS00..17 order) for a career name, or the affinity index for a custom class. */
export function biogClassIndex(career, careers = CLASSES) {
  if (career?.custom) return classAffinityIndex(career, careers);
  const i = CLASSES.findIndex((c) => c.name === career?.name);
  return i < 0 ? 0 : i;
}

/** A small seeded generator (stable backstory variants per character). */
export function seededRandom(seedText) {
  let x = 2166136261;
  for (const ch of String(seedText)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
