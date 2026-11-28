// Versioned multiple quest pack workflow (docs/multiplayer-feature-plan.md §7 "Multiple quest packs").
//
// Features:
//   - Manifest validation (`pack.json` or in-memory descriptor): id, semver version, apiVersion,
//     enabled flag, priority, dependencies (semver ranges), declared conflicts, migrations.
//   - Dependency & conflict checking with cycle detection.
//   - Deterministic load order: topological sort on dependencies, tie-broken by (priority ASC, id ASC).
//   - Overlapping quest ID handling with structured overlap/shadowing diagnostics (higher-precedence
//     pack wins deterministically).
//   - Active quest compatibility across pack updates (`reconcileActiveQuests`): stamps pack provenance
//     on active instances, applies declared task/resource migrations, preserves granted rewards and
//     timers, and marks incompatible/removed quests safely without crashing or losing progress.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const QUEST_PACK_API_VERSION = 1;

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/;
const QUEST_NAME_RE = /^[A-Z0-9$_]{1,12}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseSemver(version) {
  const m = SEMVER_RE.exec(String(version ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

/** Supports '*', exact '1.2.3', '^1.2.0', '>=1.0.0', '<2.0.0', or space-separated bounds like '>=1.0.0 <2.0.0'. */
export function satisfiesRange(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = String(range ?? '*').trim();
  if (!r || r === '*') return true;
  const tokens = r.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.startsWith('^')) {
      const base = parseSemver(tok.slice(1));
      if (!base) return false;
      if (compareSemver(v, base) < 0) return false;
      const upper = base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0, pre: '' }
        : { major: 0, minor: base.minor + 1, patch: 0, pre: '' };
      if (compareSemver(v, upper) >= 0) return false;
    } else if (tok.startsWith('>=')) {
      const base = parseSemver(tok.slice(2));
      if (!base || compareSemver(v, base) < 0) return false;
    } else if (tok.startsWith('<=')) {
      const base = parseSemver(tok.slice(2));
      if (!base || compareSemver(v, base) > 0) return false;
    } else if (tok.startsWith('>')) {
      const base = parseSemver(tok.slice(1));
      if (!base || compareSemver(v, base) <= 0) return false;
    } else if (tok.startsWith('<')) {
      const base = parseSemver(tok.slice(1));
      if (!base || compareSemver(v, base) >= 0) return false;
    } else {
      const base = parseSemver(tok.replace(/^=/, ''));
      if (!base || compareSemver(v, base) !== 0) return false;
    }
  }
  return true;
}

function listDirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function normalizeDep(dep) {
  if (typeof dep === 'string') {
    const [id, range = '*'] = dep.split('@');
    return { id: id.trim().toLowerCase(), range: range.trim() || '*' };
  }
  if (dep && typeof dep === 'object' && typeof dep.id === 'string') {
    return { id: dep.id.trim().toLowerCase(), range: String(dep.range ?? dep.version ?? '*').trim() || '*' };
  }
  return null;
}

/** Validate a quest pack manifest. Returns `{ ok, manifest?, errors }`. */
export function validateQuestPackManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!PACK_ID_RE.test(id)) errors.push(`invalid pack id "${raw.id ?? ''}"`);
  const version = String(raw.version ?? '').trim();
  if (!parseSemver(version)) errors.push(`invalid semver version "${raw.version ?? ''}"`);
  const apiVersion = raw.apiVersion === undefined ? QUEST_PACK_API_VERSION : Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1 || apiVersion > QUEST_PACK_API_VERSION) {
    errors.push(`unsupported apiVersion ${raw.apiVersion} (supported: 1..${QUEST_PACK_API_VERSION})`);
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : id;
  const priority = raw.priority === undefined ? 0 : Number(raw.priority);
  if (!Number.isFinite(priority)) errors.push('priority must be a finite number');

  const dependencies = [];
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies)) {
      errors.push('dependencies must be an array');
    } else {
      for (const d of raw.dependencies) {
        const nd = normalizeDep(d);
        if (!nd || !PACK_ID_RE.test(nd.id)) errors.push(`invalid dependency entry: ${JSON.stringify(d)}`);
        else if (nd.id === id) errors.push(`pack "${id}" cannot depend on itself`);
        else dependencies.push(nd);
      }
    }
  }

  const conflicts = [];
  if (raw.conflicts !== undefined) {
    if (!Array.isArray(raw.conflicts)) {
      errors.push('conflicts must be an array');
    } else {
      for (const c of raw.conflicts) {
        const cid = String(c ?? '').trim().toLowerCase();
        if (!PACK_ID_RE.test(cid)) errors.push(`invalid conflict pack id "${c}"`);
        else if (cid !== id) conflicts.push(cid);
      }
    }
  }

  const migrations = {};
  if (raw.migrations && typeof raw.migrations === 'object' && !Array.isArray(raw.migrations)) {
    for (const [qName, spec] of Object.entries(raw.migrations)) {
      if (FORBIDDEN_KEYS.has(qName) || !spec || typeof spec !== 'object') continue;
      migrations[qName.toUpperCase()] = {
        fromRange: typeof spec.fromRange === 'string' ? spec.fromRange : '*',
        renameTasks: spec.renameTasks && typeof spec.renameTasks === 'object' ? { ...spec.renameTasks } : {},
        keepVariables: Array.isArray(spec.keepVariables) ? spec.keepVariables.map(String) : [],
        compatible: spec.compatible !== false,
        note: typeof spec.note === 'string' ? spec.note.slice(0, 200) : '',
      };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      id,
      name,
      version,
      apiVersion,
      enabled: raw.enabled !== false,
      priority: Math.trunc(priority),
      author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 100) : '',
      description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 300) : '',
      dependencies,
      conflicts,
      questsDir: typeof raw.questsDir === 'string' && raw.questsDir.trim() ? raw.questsDir.trim() : 'quests',
      questList: typeof raw.questList === 'string' && raw.questList.trim() ? raw.questList.trim() : null,
      migrations,
    },
  };
}

/** Load a single quest pack from a filesystem directory containing `pack.json` and quest `.txt` files. */
export function readQuestPackDir(dirPath) {
  const manifestPath = join(dirPath, 'pack.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, dirPath, errors: [`missing pack.json in ${dirPath}`] };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, dirPath, errors: [`invalid JSON in ${manifestPath}: ${err.message}`] };
  }
  const validated = validateQuestPackManifest(raw);
  if (!validated.ok) return { ok: false, dirPath, errors: validated.errors };
  const m = validated.manifest;
  const qDir = join(dirPath, m.questsDir);
  const scripts = {};
  if (existsSync(qDir)) {
    for (const f of listDirSafe(qDir).sort()) {
      if (!/\.txt$/i.test(f)) continue;
      const qName = f.slice(0, -4).toUpperCase();
      if (!QUEST_NAME_RE.test(qName)) continue;
      scripts[qName] = readFileSync(join(qDir, f), 'latin1');
    }
  }
  let questListText = null;
  if (m.questList) {
    const lp = join(dirPath, m.questList);
    if (existsSync(lp)) questListText = readFileSync(lp, 'utf8');
  }
  return {
    ok: true,
    dirPath,
    manifest: m,
    scripts,
    questListText,
  };
}

/** Normalize an in-memory pack descriptor or filesystem directory path into a loaded pack record. */
function normalizePackInput(entry) {
  if (typeof entry === 'string') return readQuestPackDir(entry);
  if (!entry || typeof entry !== 'object') return { ok: false, errors: ['pack entry must be a path or object'] };
  const manifestRaw = entry.manifest ?? entry;
  const validated = validateQuestPackManifest(manifestRaw);
  if (!validated.ok) return { ok: false, id: manifestRaw?.id ?? null, errors: validated.errors };
  const scripts = {};
  if (entry.scripts && typeof entry.scripts === 'object') {
    for (const [k, v] of Object.entries(entry.scripts)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const qName = k.toUpperCase();
      if (!QUEST_NAME_RE.test(qName) || typeof v !== 'string') continue;
      scripts[qName] = v;
    }
  }
  return {
    ok: true,
    dirPath: entry.dirPath ?? null,
    manifest: validated.manifest,
    scripts,
    questListText: typeof entry.questListText === 'string' ? entry.questListText : null,
  };
}

/** Discover pack subdirectories inside `packsDir` (each containing `pack.json`), sorted by folder name. */
export function discoverQuestPackDirs(packsDir) {
  if (!packsDir || !existsSync(packsDir)) return [];
  const out = [];
  for (const name of listDirSafe(packsDir).sort()) {
    const full = join(packsDir, name);
    try {
      if (statSync(full).isDirectory() && existsSync(join(full, 'pack.json'))) out.push(full);
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Resolve multiple versioned quest packs:
 *   1. Validates manifests and detects duplicate pack IDs.
 *   2. Checks enabled packs' dependencies (presence + semver range) and declared conflicts.
 *   3. Computes deterministic load order: topological sort by dependencies, tie-broken by (priority ASC, id ASC).
 *   4. Merges quest scripts and QuestList entries in load order, recording overlapping quest IDs.
 */
export function resolveQuestPacks(packInputs = [], { packsDir = null } = {}) {
  const rawInputs = [
    ...(packsDir ? discoverQuestPackDirs(packsDir) : []),
    ...(Array.isArray(packInputs) ? packInputs : []),
  ];

  const errors = [];
  const warnings = [];
  const conflicts = [];
  const allPacks = new Map(); // id -> pack record

  for (const input of rawInputs) {
    const loaded = normalizePackInput(input);
    if (!loaded.ok) {
      errors.push({ packId: loaded.id ?? loaded.dirPath ?? '*', errors: loaded.errors });
      continue;
    }
    const id = loaded.manifest.id;
    if (allPacks.has(id)) {
      errors.push({ packId: id, errors: [`duplicate quest pack id "${id}"`] });
      continue;
    }
    allPacks.set(id, loaded);
  }

  // Filter enabled packs and validate dependencies & declared conflicts.
  const enabled = new Map();
  for (const [id, pack] of allPacks.entries()) {
    if (pack.manifest.enabled) enabled.set(id, pack);
  }

  const invalidEnabled = new Set();

  // Check declared conflicts between enabled packs.
  for (const [id, pack] of enabled.entries()) {
    for (const cid of pack.manifest.conflicts) {
      if (enabled.has(cid)) {
        conflicts.push({
          type: 'declared-conflict',
          packId: id,
          conflictsWith: cid,
          message: `Quest pack "${id}" declares conflict with enabled pack "${cid}".`,
        });
        invalidEnabled.add(id);
        invalidEnabled.add(cid);
      }
    }
  }

  // Iteratively verify dependencies (cascade if a dependency is missing, wrong version, or invalid).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, pack] of enabled.entries()) {
      if (invalidEnabled.has(id)) continue;
      for (const dep of pack.manifest.dependencies) {
        const target = enabled.get(dep.id);
        if (!target) {
          const disabled = allPacks.has(dep.id);
          errors.push({
            packId: id,
            errors: [`missing dependency "${dep.id}" (${dep.range})${disabled ? ' — pack is installed but disabled' : ''}`],
          });
          invalidEnabled.add(id);
          changed = true;
          break;
        }
        if (invalidEnabled.has(dep.id)) {
          errors.push({ packId: id, errors: [`dependency "${dep.id}" failed validation or conflicted`] });
          invalidEnabled.add(id);
          changed = true;
          break;
        }
        if (!satisfiesRange(target.manifest.version, dep.range)) {
          errors.push({
            packId: id,
            errors: [`dependency "${dep.id}" requires ${dep.range}, found ${target.manifest.version}`],
          });
          invalidEnabled.add(id);
          changed = true;
          break;
        }
      }
    }
  }

  const valid = [...enabled.values()].filter((p) => !invalidEnabled.has(p.manifest.id));
  const validById = new Map(valid.map((p) => [p.manifest.id, p]));

  // Deterministic topological sort (Kahn's algorithm with priority ASC, id ASC tie-breaking).
  const inDegree = new Map();
  const dependents = new Map();
  for (const p of valid) {
    const id = p.manifest.id;
    inDegree.set(id, p.manifest.dependencies.length);
    if (!dependents.has(id)) dependents.set(id, []);
    for (const dep of p.manifest.dependencies) {
      if (!dependents.has(dep.id)) dependents.set(dep.id, []);
      dependents.get(dep.id).push(id);
    }
  }

  const cmpPack = (a, b) => (a.manifest.priority - b.manifest.priority) || a.manifest.id.localeCompare(b.manifest.id);
  const ready = valid.filter((p) => inDegree.get(p.manifest.id) === 0).sort(cmpPack);
  const ordered = [];
  while (ready.length) {
    const next = ready.shift();
    ordered.push(next);
    for (const depId of dependents.get(next.manifest.id) ?? []) {
      const rem = inDegree.get(depId) - 1;
      inDegree.set(depId, rem);
      if (rem === 0) {
        ready.push(validById.get(depId));
        ready.sort(cmpPack);
      }
    }
  }

  if (ordered.length < valid.length) {
    const cyclic = valid.filter((p) => !ordered.includes(p)).map((p) => p.manifest.id).sort();
    errors.push({ packId: cyclic.join(','), errors: [`dependency cycle detected among packs: ${cyclic.join(', ')}`] });
  }

  // Merge scripts in deterministic load order (later pack overrides earlier pack on overlapping quest ID).
  const scripts = new Map(); // questName -> { text, packId, packVersion, priority, hash }
  const overlaps = []; // { questName, winner: {packId,version,priority}, shadowed: [...] }
  const providersByQuest = new Map();
  const questLists = [];

  for (const pack of ordered) {
    const m = pack.manifest;
    if (pack.questListText) {
      questLists.push({ packId: m.id, version: m.version, text: pack.questListText });
    }
    for (const [qName, text] of Object.entries(pack.scripts).sort(([a], [b]) => a.localeCompare(b))) {
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
      const prov = { packId: m.id, version: m.version, priority: m.priority, hash };
      if (!providersByQuest.has(qName)) providersByQuest.set(qName, []);
      providersByQuest.get(qName).push(prov);
      scripts.set(qName, { text, ...prov });
    }
  }

  for (const [qName, provs] of providersByQuest.entries()) {
    if (provs.length > 1) {
      const winner = provs[provs.length - 1];
      const shadowed = provs.slice(0, -1);
      overlaps.push({ questName: qName, winner, shadowed });
      warnings.push(
        `Quest ${qName} defined in multiple packs (${provs.map((p) => `${p.packId}@${p.version}`).join(', ')}); using ${winner.packId}@${winner.version}.`,
      );
    }
  }

  return {
    ordered,
    loadOrder: ordered.map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      priority: p.manifest.priority,
      questCount: Object.keys(p.scripts).length,
    })),
    byId: new Map(ordered.map((p) => [p.manifest.id, p])),
    allIds: [...allPacks.keys()].sort(),
    scripts,
    questLists,
    overlaps,
    conflicts,
    errors,
    warnings,
  };
}

/**
 * Stamp pack provenance onto a newly created quest instance so future pack updates can reconcile it.
 */
export function stampQuestPackMeta(instance, catalogEntry) {
  if (!instance || !catalogEntry) return instance;
  if (catalogEntry.packId) {
    instance.packId = catalogEntry.packId;
    instance.packVersion = catalogEntry.packVersion ?? '1.0.0';
    if (catalogEntry.packHash) instance.packHash = catalogEntry.packHash;
  }
  return instance;
}

/**
 * Reconcile a player's active quests after one or more quest packs are updated, reordered, or removed.
 * Never drops player progress or revokes `granted` reward idempotency keys.
 *
 * Returns `{ migrated: [], preserved: [], unchanged: [], warnings: [] }`.
 */
export function reconcileActiveQuests(activeInstances, resolvedPacks, catalog) {
  const report = { migrated: [], preserved: [], unchanged: [], warnings: [] };
  if (!Array.isArray(activeInstances)) return report;

  for (const inst of activeInstances) {
    if (!inst || typeof inst !== 'object' || !inst.name) continue;
    const qName = String(inst.name).toUpperCase();
    const entry = catalog?.quests?.get?.(qName) ?? null;
    const prevPackId = inst.packId ?? null;
    const prevVersion = inst.packVersion ?? null;

    if (!entry) {
      // Quest was removed or its pack disabled — keep active instance frozen/preserved so player save doesn't crash.
      inst.packCompat = 'preserved-missing';
      report.preserved.push({ uid: inst.uid, name: qName, from: prevVersion, reason: 'quest no longer in active catalog' });
      report.warnings.push(`Active quest ${qName} (${inst.uid}) preserved in legacy state because its pack was removed or disabled.`);
      continue;
    }

    const nextPackId = entry.packId ?? null;
    const nextVersion = entry.packVersion ?? null;
    if (!prevPackId && nextPackId) {
      stampQuestPackMeta(inst, entry);
      report.unchanged.push({ uid: inst.uid, name: qName, version: nextVersion });
      continue;
    }
    if (prevPackId === nextPackId && prevVersion === nextVersion && (!inst.packHash || !entry.packHash || inst.packHash === entry.packHash)) {
      report.unchanged.push({ uid: inst.uid, name: qName, version: nextVersion });
      continue;
    }

    // Pack updated or overridden: check migration metadata on winning pack.
    const pack = nextPackId ? resolvedPacks?.byId?.get?.(nextPackId) : null;
    const mig = pack?.manifest?.migrations?.[qName] ?? null;

    if (mig && mig.compatible === false) {
      inst.packCompat = 'preserved-incompatible';
      report.preserved.push({
        uid: inst.uid, name: qName, from: prevVersion, to: nextVersion,
        reason: mig.note || 'pack marked update incompatible with in-progress saves',
      });
      report.warnings.push(`Active quest ${qName} (${inst.uid}) pinned to legacy state across ${prevVersion} -> ${nextVersion}.`);
      continue;
    }

    // Apply declared task renames cleanly while preserving task active/triggered state.
    const renamedTasks = [];
    if (mig?.renameTasks && inst.tasks && typeof inst.tasks === 'object') {
      const rangeOk = !prevVersion || satisfiesRange(prevVersion, mig.fromRange);
      if (rangeOk) {
        for (const [oldKey, newKey] of Object.entries(mig.renameTasks)) {
          const ok = oldKey.toLowerCase();
          const nk = newKey.toLowerCase();
          if (Object.hasOwn(inst.tasks, ok) && !Object.hasOwn(inst.tasks, nk)) {
            inst.tasks[nk] = inst.tasks[ok];
            delete inst.tasks[ok];
            renamedTasks.push(`${ok}->${nk}`);
          }
        }
      }
    }

    // Ensure any newly added tasks in the updated definition exist in `inst.tasks` without resetting existing ones.
    if (entry.def?.tasks && inst.tasks && typeof inst.tasks === 'object') {
      for (const task of entry.def.tasks) {
        const tk = task.key;
        if (!Object.hasOwn(inst.tasks, tk)) {
          inst.tasks[tk] = { a: false, t: false };
        }
      }
    }

    // Ensure reward idempotency ledger (`granted`) is preserved intact.
    if (!Array.isArray(inst.granted)) inst.granted = [];

    inst.packId = nextPackId;
    inst.packVersion = nextVersion;
    if (entry.packHash) inst.packHash = entry.packHash;
    inst.packCompat = 'migrated';
    inst.migratedFrom = prevVersion ? `${prevPackId}@${prevVersion}` : 'classic';
    report.migrated.push({
      uid: inst.uid,
      name: qName,
      from: prevVersion ? `${prevPackId}@${prevVersion}` : 'classic',
      to: nextPackId ? `${nextPackId}@${nextVersion}` : 'classic',
      renamedTasks,
    });
  }

  return report;
}
