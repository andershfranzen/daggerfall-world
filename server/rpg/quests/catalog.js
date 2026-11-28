// Quest catalogue: finds quests in operator-supplied files and reports what can run.
//
// Sources, in order of precedence for a quest name:
//   1. scripts — Daggerfall Unity text scripts in `scriptsDir` (e.g. the operator's copy of
//      StreamingAssets/Quests). Only used when the operator configures the directory.
//   2. classic — ARENA2/<NAME>.QBN decompiled by qbn.js.
// Message text always comes from ARENA2/<NAME>.QRC when present (original words); a script's
// own QRC section is only used when the classic file is missing.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readQbn, decompileQbn, SECTION } from './qbn.js';
import { readQrc } from './qrc.js';
import { parseQuest } from './script.js';
import { analyseQuest } from './engine.js';
import { GROUP_BY_PREFIX } from './tables.js';
import { CORRECTIONS } from './corrections.js';
import { SPECIAL_QUESTS } from '../special/quests.js';
import { resolveQuestPacks } from './packs.js';

const NAME_RE = /^[A-Z0-9$_]{1,12}$/;

/** Classic temple quest filename prefix, QuestList membership letter and FACTION.TXT deity id. */
export const DEITY_PREFIX = Object.freeze({
  0: ['J', 27], D: ['T', 26], E: ['A', 21], F: ['D', 29], G: ['K', 35], H: ['R', 24], I: ['S', 33], J: ['Z', 22],
});
const DEITY_BY_MEMBERSHIP = new Map(Object.values(DEITY_PREFIX));

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Parses Daggerfall Unity's QuestList table format (name, group, membership, minReq, flag). */
export function parseQuestList(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('-') || line.startsWith('schema')) continue;
    const [name, group, membership, minReq, flag] = line.split(',').map((x) => x.trim());
    if (!name || !group) continue;
    const deity = group === 'HolyOrder' ? DEITY_BY_MEMBERSHIP.get(membership) : undefined;
    out.set(name.toUpperCase(), {
      group, membership: membership || 'N', minReq: Number(minReq) || 0,
      oneTime: flag === '1', adult: flag === 'X', ...(deity !== undefined ? { deity } : {}),
    });
  }
  return out;
}

/** Group and requirements encoded in a classic quest file name, e.g. A0C01Y09. */
export function metaFromName(name) {
  const n = name.toUpperCase();
  const deity = n[1] === '0' && n[2] === 'B' ? DEITY_PREFIX[n[0]] : null;
  if (deity) {
    const minReq = /\d/.test(n[3]) ? Number(n[3]) : 0;
    return { group: 'HolyOrder', membership: deity[0], deity: deity[1], minReq, oneTime: n[4] === '1', adult: n[4] === 'X' };
  }
  const group = GROUP_BY_PREFIX[n[0]] ?? null;
  const kind = n[2];
  const minReq = /\d/.test(n[3]) ? Number(n[3]) : 0;
  return {
    group,
    membership: kind === 'B' ? 'M' : kind === 'A' ? 'P' : 'N',
    minReq,
    oneTime: n[4] === '1',
    adult: n[4] === 'X',
  };
}

function findFile(dir, base, ext) {
  const files = listDir(dir);
  const want = `${base}${ext}`.toLowerCase();
  const f = files.find((x) => x.toLowerCase() === want);
  return f ? join(dir, f) : null;
}

/**
 * @param {object} opts
 * @param {string|null} opts.dataPath      ARENA2 directory
 * @param {string|null} [opts.scriptsDir]  directory of *.txt quest scripts
 * @param {string|null} [opts.questList]   QuestList table file (optional)
 * @param {Array} [opts.packs]             versioned quest pack dirs or descriptors (quests/packs.js)
 * @param {string|null} [opts.packsDir]    directory containing versioned quest pack subdirectories
 * @param {(msg:string)=>void} [opts.warn]
 */
export function loadCatalog({ dataPath = null, scriptsDir = null, questList = null, packs = null, packsDir = null, warn = () => {}, artifact = null } = {}) {
  const quests = new Map();
  const failures = [];
  let list = null;
  const listPath = questList || (scriptsDir ? join(dirname(scriptsDir), 'Tables', 'QuestList-Classic.txt') : null);
  if (listPath && existsSync(listPath)) {
    try {
      list = parseQuestList(readFileSync(listPath, 'utf8'));
    } catch (err) {
      warn(`quest list ${listPath}: ${err.message}`);
    }
  }

  const scriptTitles = new Map();
  const scripts = new Map();
  const scriptMeta = new Map(); // questName -> { source, packId?, packVersion?, packHash? }
  if (scriptsDir) {
    for (const f of listDir(scriptsDir)) {
      if (!/\.txt$/i.test(f)) continue;
      const name = f.slice(0, -4).toUpperCase();
      if (!NAME_RE.test(name)) continue;
      try {
        const text = readFileSync(join(scriptsDir, f), 'latin1');
        scripts.set(name, text);
        scriptMeta.set(name, { source: 'script' });
        const m = text.match(/^\s*DisplayName:\s*(.+)$/im);
        if (m) scriptTitles.set(name, m[1].trim());
      } catch (err) {
        failures.push({ name, source: 'script', error: err.message });
      }
    }
  }

  // Versioned quest packs override legacy scriptsDir & classic ARENA2 in deterministic load order.
  const hasPacks = (Array.isArray(packs) && packs.length > 0) || !!packsDir;
  const resolvedPacks = hasPacks ? resolveQuestPacks(packs ?? [], { packsDir }) : null;
  if (resolvedPacks) {
    for (const w of resolvedPacks.warnings) warn(w);
    for (const e of resolvedPacks.errors) warn(`quest pack ${e.packId}: ${e.errors.join('; ')}`);
    for (const c of resolvedPacks.conflicts) warn(c.message);
    for (const ql of resolvedPacks.questLists) {
      try {
        const parsed = parseQuestList(ql.text);
        if (!list) list = new Map();
        for (const [k, v] of parsed.entries()) list.set(k, v);
      } catch (err) {
        warn(`quest pack ${ql.packId} quest list: ${err.message}`);
      }
    }
    for (const [name, entry] of resolvedPacks.scripts.entries()) {
      scripts.set(name, entry.text);
      scriptMeta.set(name, {
        source: `pack:${entry.packId}`,
        packId: entry.packId,
        packVersion: entry.version,
        packHash: entry.hash,
      });
      const m = entry.text.match(/^\s*DisplayName:\s*(.+)$/im);
      if (m) scriptTitles.set(name, m[1].trim());
    }
  }

  const classicNames = new Set();
  if (dataPath) for (const f of listDir(dataPath)) if (/\.qbn$/i.test(f)) classicNames.add(f.slice(0, -4).toUpperCase());

  const names = new Set([...scripts.keys(), ...classicNames]);
  for (const name of names) {
    try {
      let messages = null;
      const qrcPath = dataPath ? findFile(dataPath, name, '.QRC') : null;
      if (qrcPath) messages = readQrc(readFileSync(qrcPath));
      let def;
      let source;
      let packInfo = null;
      if (scripts.has(name)) {
        const sm = scriptMeta.get(name);
        // Pack scripts carry their own QRC section so custom/updated pack text takes precedence when QRC is absent or pack-authored.
        const useClassicQrc = sm?.packId ? null : messages;
        def = parseQuest(scripts.get(name), { name, messages: useClassicQrc ?? undefined });
        if (sm?.packId && messages && def.messages.size === 0) {
          def = parseQuest(scripts.get(name), { name, messages });
        }
        source = sm?.source ?? 'script';
        if (sm?.packId) packInfo = { packId: sm.packId, packVersion: sm.packVersion, packHash: sm.packHash };
      } else {
        if (!messages) throw new Error('classic QRC text file is missing');
        const qbn = readQbn(readFileSync(findFile(dataPath, name, '.QBN')));
        const dec = decompileQbn(qbn);
        const fix = CORRECTIONS[name] ?? SPECIAL_QUESTS[name];
        const lines = fix?.adapt?.(dec.lines) ?? dec.lines;
        def = parseQuest([...lines, ...(fix?.lines ?? [])].join('\n'), { name, messages });
        if (fix) def.corrections = [fix.note];
        for (const s of dec.symbols) {
          const r = def.resources.get(s.symbol.replace(/^_+|_+$/g, '').toLowerCase());
          if (!r) continue;
          r.hash = s.hash;
          if (s.section === SECTION.ITEM) {
            const item = qbn.items.find((it) => it.index === s.index);
            if (item) r.classicItem = { group: item.group, index: item.subIndex };
          }
        }
        source = 'classic';
      }
      const special = SPECIAL_QUESTS[name];
      for (const r of def.resources.values()) {
        if (special?.homes?.[r.key]) r.homeBuilding = special.homes[r.key];
        if (special?.items?.[r.key]) r.label = special.items[r.key];
        if (special?.firstPlaceClock === r.key) r.firstPlaceClock = true;
        if (special?.ownsArtifacts?.includes(r.key)) r.checkInventory = true;
      }
      def.displayName = scriptTitles.get(name) || def.displayName || special?.name || '';
      const meta = list?.get(name) ?? metaFromName(name);
      const analysis = analyseQuest(def, { artifact });
      if (def.corrections) analysis.approximations.push(...def.corrections.map((c) => `correction: ${c}`));
      if (!def.messages.has(1000)) analysis.unsupported.push('no offer text (message 1000)');
      // An operator quest list is the whole offer pool, as in Daggerfall Unity (lines starting with '-' are disabled).
      if (list && !list.has(name) && !packInfo) analysis.unsupported.push('not in the operator quest list');
      if (!meta.group) analysis.unsupported.push('not a guild or social quest (main quest, cures and special quests are started by the story, not offered)');
      analysis.offerable = analysis.unsupported.length === 0;
      quests.set(name, {
        name, source, def, meta, analysis,
        textSource: packInfo ? `pack:${packInfo.packId}` : qrcPath ? 'classic' : 'script',
        ...(packInfo ?? {}),
      });
    } catch (err) {
      failures.push({ name, source: scripts.has(name) ? (scriptMeta.get(name)?.source ?? 'script') : 'classic', error: err.message });
    }
  }
  return {
    quests, failures,
    listSource: list ? (listPath || 'quest-packs') : 'file names',
    scriptsDir, dataPath,
    packs: resolvedPacks,
  };
}

/** Summary used by the operator report and `quest.catalog`. */
export function catalogReport(cat) {
  const rows = [...cat.quests.values()].sort((a, b) => a.name.localeCompare(b.name));
  const offerable = rows.filter((r) => r.analysis.offerable);
  const reasons = new Map();
  for (const r of rows) {
    for (const u of r.analysis.unsupported) {
      const k = u.replace(/^[^:]*:\s*/, '').replace(/_[A-Za-z0-9.]+_/g, '_x_').replace(/\d+/g, 'N').slice(0, 80);
      reasons.set(k, (reasons.get(k) || 0) + 1);
    }
  }
  return {
    total: rows.length,
    offerable: offerable.map((r) => ({ name: r.name, group: r.meta.group, source: r.source, ...(r.packId ? { packId: r.packId, packVersion: r.packVersion } : {}) })),
    failures: cat.failures,
    topBlockers: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([reason, quests]) => ({ reason, quests })),
    ...(cat.packs ? {
      packs: {
        loadOrder: cat.packs.loadOrder,
        overlaps: cat.packs.overlaps,
        conflicts: cat.packs.conflicts,
        errors: cat.packs.errors,
      },
    } : {}),
  };
}
