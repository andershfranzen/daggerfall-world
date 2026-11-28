// Operator-managed Mod Management & Content Hooks registry (docs/multiplayer-feature-plan.md §7).
//
// Supports DFU extension categories that map cleanly to the browser/Node authoritative architecture:
//   - assets   (client-side visual override pack descriptors, never overriding server collision)
//   - world    (region/location metadata, weather/landmark hooks)
//   - quests   (versioned quest packs integrated with server/rpg/quests/packs.js & catalog.js)
//   - items    (validated custom item templates: weight, value, slot, stackable, description)
//   - factions (custom faction records & initial reputation bindings)
//   - services (custom town/tavern/guild service definitions)
//   - ui       (declarative client UI panel/badge hints)
//   - rules    (explicitly allow-listed server-safe gameplay tuning rules)
//
// Includes one representative end-to-end sample pack (`SAMPLE_MOD_PACK`: "Iliac Bay Wayfarer Pack").

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSemver, satisfiesRange, resolveQuestPacks } from './quests/packs.js';
import { loadCatalog, catalogReport } from './quests/catalog.js';

export const name = 'mods';
export const MOD_API_VERSION = 1;

export const MOD_CATEGORIES = Object.freeze([
  'assets', 'world', 'quests', 'items', 'factions', 'services', 'ui', 'rules',
]);

const MOD_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const ITEM_SLOTS = new Set(['weapon', 'shield', 'head', 'chest', 'legs', 'hands', 'feet', 'ring', 'amulet', 'cloak', 'light', 'misc', 'consumable']);
const ALLOWED_RULE_KEYS = new Set([
  'restHealScale', 'shopPriceScale', 'travelEncounterScale', 'questRewardScale', 'carryWeightBonus', 'lampDurationScale',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Representative end-to-end sample mod pack exercising every supported category. */
export const SAMPLE_MOD_PACK = Object.freeze({
  id: 'iliac-wayfarer-pack',
  name: 'Iliac Bay Wayfarer Pack',
  version: '1.0.0',
  apiVersion: 1,
  enabled: true,
  priority: 10,
  author: 'Daggerfall World',
  description: 'Representative end-to-end mod pack adding a Wayfarer courier quest, lantern oil & wayfarer cloak items, Wayfarer Guild faction, cartographer service, and optional client visual tint.',
  dependencies: [],
  conflicts: [],
  hooks: {
    assets: {
      clientPackId: 'wayfarer-hi-contrast',
      textures: { 'atlas:tint': { kind: 'tint', r: 1.04, g: 1.01, b: 0.96, contrast: 1.05 } },
      ui: { 'hud:accent': { cssVar: '--accent', value: '#e2b86b' } },
    },
    world: {
      landmarks: [
        { id: 'wayfarer-post-gothway', location: 'town:Daggerfall/Gothway Garden', label: 'Wayfarer Milestone', description: 'A weathered milestone marking road distances across Daggerfall.' },
      ],
    },
    quests: {
      questListText: 'schema: *name, group, membership, minReq, flag\nW0C00Y01, Commoners, N, 0, 0\n',
      scripts: {
        W0C00Y01: [
          'Quest: W0C00Y01',
          'DisplayName: The Wayfarer Milestone',
          'QRC:',
          'QuestorOffer: [1000]',
          '<ce>A courier needs someone to carry a sealed ledger across town.',
          '<ce>Will you take the ledger for 120 gold?',
          '',
          'RefuseQuest: [1001]',
          '<ce>Perhaps another traveller will take the road.',
          '',
          'AcceptQuest: [1002]',
          '<ce>Take this ledger to _recipient_ in __recipient_.',
          '',
          'QuestComplete: [1004]',
          '<ce>Safe travels, wayfarer. Here is your coin.',
          '',
          'Message: 1010',
          '<ce>You agreed to carry the Wayfarer ledger to _recipient_.',
          '',
          'QBN:',
          'Item _reward_ gold range 120 to 120',
          'Item _ledger_ letter',
          'Person _giver_ group Questor',
          'Person _recipient_ group Resident1',
          'Place _dest_ local tavern',
          'Clock _timer_ 5.00:00',
          '',
          '  start timer _timer_',
          '  get item _ledger_',
          '  place npc _recipient_ at _dest_',
          '  log 1010 step 0',
          '',
          '_deliver_ task:',
          '  toting _ledger_ and _recipient_ clicked',
          '  give pc _reward_',
          '  end quest',
          '',
          '_timer_ task:',
          '  end quest',
        ].join('\n'),
      },
      migrations: {
        W0C00Y01: { fromRange: '>=1.0.0', renameTasks: {}, keepVariables: ['_timer_'], compatible: true },
      },
    },
    items: [
      {
        id: 'wayfarer:cloak',
        name: 'Wayfarer Travelling Cloak',
        slot: 'cloak',
        weight: 1.5,
        value: 85,
        stackable: false,
        description: 'Oilskin cloak sewn for the coastal rains of the Iliac Bay.',
      },
      {
        id: 'wayfarer:lantern-oil',
        name: 'Refined Lantern Oil',
        slot: 'consumable',
        weight: 0.5,
        value: 18,
        stackable: true,
        maxStack: 20,
        description: 'Clean-burning oil that steadies dungeon lanterns.',
      },
    ],
    factions: [
      {
        id: 'wayfarer-guild',
        factionId: 901,
        name: 'Order of the Wayfarers',
        region: 'Daggerfall',
        startingReputation: 0,
        description: 'Roadwardens and couriers mapping the highways of the Iliac Bay.',
      },
    ],
    services: [
      {
        id: 'wayfarer:cartography',
        name: 'Road Charting Desk',
        serviceType: 'information',
        factionId: 901,
        costGold: 25,
        locations: ['town:Daggerfall/Gothway Garden'],
        description: 'Reveals nearby road milestones and regional weather outlooks.',
      },
    ],
    ui: {
      badges: [{ id: 'wayfarer-pack', label: 'Wayfarer Pack v1.0.0' }],
    },
    rules: {
      lampDurationScale: 1.15,
    },
  },
});

function normalizeDep(d) {
  if (typeof d === 'string') {
    const [id, range = '*'] = d.split('@');
    return { id: id.trim().toLowerCase(), range: range.trim() || '*' };
  }
  if (d && typeof d === 'object' && typeof d.id === 'string') {
    return { id: d.id.trim().toLowerCase(), range: String(d.range ?? d.version ?? '*').trim() || '*' };
  }
  return null;
}

/** Validate an operator mod manifest and all of its declared extension category hooks. */
export function validateModManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['mod manifest must be a JSON object'] };
  }

  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!MOD_ID_RE.test(id)) errors.push(`invalid mod id "${raw.id ?? ''}"`);
  const version = String(raw.version ?? '').trim();
  if (!parseSemver(version)) errors.push(`invalid semver version "${raw.version ?? ''}"`);
  const apiVersion = raw.apiVersion === undefined ? MOD_API_VERSION : Number(raw.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1 || apiVersion > MOD_API_VERSION) {
    errors.push(`unsupported mod apiVersion ${raw.apiVersion}`);
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 120) : id;
  const priority = raw.priority === undefined ? 0 : Number(raw.priority);
  if (!Number.isFinite(priority)) errors.push('priority must be a finite number');

  // Explicitly flag Unity-only C#/DLL mods that cannot run unmodified in browser/Node.
  if (raw.unityAssembly || raw.dll || raw.dfmodOnly) {
    errors.push('Unity-dependent C#/DLL mods require a web port and cannot be loaded directly');
  }

  const dependencies = [];
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies)) errors.push('dependencies must be an array');
    else {
      for (const d of raw.dependencies) {
        const nd = normalizeDep(d);
        if (!nd || !MOD_ID_RE.test(nd.id)) errors.push(`invalid dependency: ${JSON.stringify(d)}`);
        else if (nd.id === id) errors.push(`mod "${id}" cannot depend on itself`);
        else dependencies.push(nd);
      }
    }
  }

  const conflicts = [];
  if (raw.conflicts !== undefined) {
    if (!Array.isArray(raw.conflicts)) errors.push('conflicts must be an array');
    else {
      for (const c of raw.conflicts) {
        const cid = String(c ?? '').trim().toLowerCase();
        if (!MOD_ID_RE.test(cid)) errors.push(`invalid conflict id "${c}"`);
        else if (cid !== id) conflicts.push(cid);
      }
    }
  }

  const rawHooks = raw.hooks && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks) ? raw.hooks : {};
  const hooks = {};
  const categories = [];

  for (const k of Object.keys(rawHooks)) {
    if (FORBIDDEN_KEYS.has(k)) { errors.push(`forbidden hook key "${k}"`); continue; }
    if (!MOD_CATEGORIES.includes(k)) { errors.push(`unknown mod category "${k}"`); continue; }
  }

  // Validate assets hook (never permits collision overrides).
  if (rawHooks.assets && typeof rawHooks.assets === 'object') {
    const a = rawHooks.assets;
    if ('colliders' in a || 'collision' in a || 'ground' in a || 'portals' in a) {
      errors.push('assets hook cannot override authoritative collision or portals');
    } else {
      hooks.assets = structuredClone(a);
      categories.push('assets');
    }
  }

  // Validate world hook
  if (rawHooks.world && typeof rawHooks.world === 'object') {
    const w = rawHooks.world;
    const landmarks = Array.isArray(w.landmarks) ? w.landmarks : [];
    for (const lm of landmarks) {
      if (!lm || typeof lm.id !== 'string' || typeof lm.location !== 'string') {
        errors.push('world.landmarks entries require string id and location');
      }
    }
    hooks.world = structuredClone(w);
    categories.push('world');
  }

  // Validate quests hook
  if (rawHooks.quests && typeof rawHooks.quests === 'object') {
    const q = rawHooks.quests;
    if (q.scripts && (typeof q.scripts !== 'object' || Array.isArray(q.scripts))) {
      errors.push('quests.scripts must be an object mapping quest names to script text');
    }
    hooks.quests = structuredClone(q);
    categories.push('quests');
  }

  // Validate items hook
  if (rawHooks.items !== undefined) {
    if (!Array.isArray(rawHooks.items)) {
      errors.push('hooks.items must be an array');
    } else {
      const cleanItems = [];
      for (const it of rawHooks.items) {
        if (!it || typeof it !== 'object') { errors.push('item entry must be an object'); continue; }
        if (typeof it.id !== 'string' || !/^[a-z0-9][a-z0-9:._-]{1,63}$/.test(it.id)) {
          errors.push(`invalid item id "${it.id}"`);
          continue;
        }
        if (typeof it.name !== 'string' || !it.name.trim()) { errors.push(`item "${it.id}" needs a name`); continue; }
        const slot = String(it.slot ?? 'misc').toLowerCase();
        if (!ITEM_SLOTS.has(slot)) { errors.push(`item "${it.id}" has unsupported slot "${slot}"`); continue; }
        const weight = Number(it.weight ?? 0);
        const value = Number(it.value ?? 0);
        if (!Number.isFinite(weight) || weight < 0 || weight > 500) { errors.push(`item "${it.id}" has out-of-range weight`); continue; }
        if (!Number.isFinite(value) || value < 0 || value > 1_000_000) { errors.push(`item "${it.id}" has out-of-range value`); continue; }
        cleanItems.push({
          id: it.id,
          name: it.name.trim().slice(0, 80),
          slot,
          weight,
          value: Math.trunc(value),
          stackable: !!it.stackable,
          maxStack: it.stackable ? Math.max(1, Math.min(999, Math.trunc(Number(it.maxStack) || 20))) : 1,
          description: typeof it.description === 'string' ? it.description.trim().slice(0, 240) : '',
        });
      }
      hooks.items = cleanItems;
      categories.push('items');
    }
  }

  // Validate factions hook
  if (rawHooks.factions !== undefined) {
    if (!Array.isArray(rawHooks.factions)) {
      errors.push('hooks.factions must be an array');
    } else {
      const cleanFactions = [];
      for (const f of rawHooks.factions) {
        if (!f || typeof f !== 'object' || typeof f.id !== 'string' || typeof f.name !== 'string') {
          errors.push('faction entry requires string id and name');
          continue;
        }
        const factionId = Number(f.factionId);
        if (!Number.isInteger(factionId) || factionId < 1 || factionId > 9999) {
          errors.push(`faction "${f.id}" has invalid numeric factionId`);
          continue;
        }
        cleanFactions.push({
          id: f.id.trim().toLowerCase(),
          factionId,
          name: f.name.trim().slice(0, 80),
          region: typeof f.region === 'string' ? f.region.trim().slice(0, 60) : '',
          startingReputation: Math.max(-100, Math.min(100, Math.trunc(Number(f.startingReputation) || 0))),
          description: typeof f.description === 'string' ? f.description.trim().slice(0, 240) : '',
        });
      }
      hooks.factions = cleanFactions;
      categories.push('factions');
    }
  }

  // Validate services hook
  if (rawHooks.services !== undefined) {
    if (!Array.isArray(rawHooks.services)) {
      errors.push('hooks.services must be an array');
    } else {
      const cleanServices = [];
      for (const s of rawHooks.services) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.name !== 'string') {
          errors.push('service entry requires string id and name');
          continue;
        }
        const costGold = Number(s.costGold ?? 0);
        if (!Number.isFinite(costGold) || costGold < 0 || costGold > 100_000) {
          errors.push(`service "${s.id}" has invalid costGold`);
          continue;
        }
        cleanServices.push({
          id: s.id.trim(),
          name: s.name.trim().slice(0, 80),
          serviceType: typeof s.serviceType === 'string' ? s.serviceType.trim().slice(0, 40) : 'custom',
          factionId: Number.isInteger(Number(s.factionId)) ? Number(s.factionId) : null,
          costGold: Math.trunc(costGold),
          locations: Array.isArray(s.locations) ? s.locations.map(String) : [],
          description: typeof s.description === 'string' ? s.description.trim().slice(0, 240) : '',
        });
      }
      hooks.services = cleanServices;
      categories.push('services');
    }
  }

  // Validate ui hook
  if (rawHooks.ui && typeof rawHooks.ui === 'object' && !Array.isArray(rawHooks.ui)) {
    hooks.ui = structuredClone(rawHooks.ui);
    categories.push('ui');
  }

  // Validate rules hook (only allow-listed numeric tuning bounds)
  if (rawHooks.rules && typeof rawHooks.rules === 'object' && !Array.isArray(rawHooks.rules)) {
    const cleanRules = {};
    for (const [rk, rv] of Object.entries(rawHooks.rules)) {
      if (!ALLOWED_RULE_KEYS.has(rk)) {
        errors.push(`unsupported rule hook "${rk}"`);
        continue;
      }
      const n = Number(rv);
      if (!Number.isFinite(n) || n < 0.1 || n > 5) {
        errors.push(`rule "${rk}" value out of safe bounds (0.1..5)`);
        continue;
      }
      cleanRules[rk] = n;
    }
    hooks.rules = cleanRules;
    categories.push('rules');
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
      categories,
      hooks,
    },
  };
}

/** Discover mod manifests (`mod.json`) in a directory. */
export function discoverModDirs(modsDir) {
  if (!modsDir || !existsSync(modsDir)) return [];
  const out = [];
  for (const name of readdirSync(modsDir).sort()) {
    const full = join(modsDir, name);
    try {
      const mf = join(full, 'mod.json');
      if (statSync(full).isDirectory() && existsSync(mf)) {
        out.push({ dirPath: full, raw: JSON.parse(readFileSync(mf, 'utf8')) });
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Operator-managed Mod Registry.
 * Resolves enablement, dependencies, conflicts, deterministic load order, and unified content hooks
 * across assets, world, quests, items, factions, services, UI, and rules.
 */
export function createModRegistry({ mods = [], modsDir = null, includeSample = false, dataPath = null, warn = () => {} } = {}) {
  const registered = new Map(); // id -> validated manifest
  const loadErrors = [];

  function register(raw) {
    const v = validateModManifest(raw);
    if (!v.ok) {
      loadErrors.push({ modId: raw?.id ?? '*', errors: v.errors });
      return { ok: false, errors: v.errors };
    }
    registered.set(v.manifest.id, v.manifest);
    return { ok: true, manifest: v.manifest };
  }

  if (includeSample) register(SAMPLE_MOD_PACK);
  if (modsDir) {
    for (const d of discoverModDirs(modsDir)) register(d.raw);
  }
  for (const m of Array.isArray(mods) ? mods : []) register(m);

  let resolvedCache = null;

  function resolve() {
    const errors = [...loadErrors];
    const conflicts = [];
    const enabled = new Map();
    for (const [id, m] of registered.entries()) {
      if (m.enabled) enabled.set(id, m);
    }

    const invalid = new Set();
    for (const [id, m] of enabled.entries()) {
      for (const cid of m.conflicts) {
        if (enabled.has(cid)) {
          conflicts.push({ modId: id, conflictsWith: cid, message: `Mod "${id}" conflicts with enabled mod "${cid}".` });
          invalid.add(id);
          invalid.add(cid);
        }
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, m] of enabled.entries()) {
        if (invalid.has(id)) continue;
        for (const dep of m.dependencies) {
          const target = enabled.get(dep.id);
          if (!target) {
            errors.push({ modId: id, errors: [`missing dependency "${dep.id}" (${dep.range})`] });
            invalid.add(id);
            changed = true;
            break;
          }
          if (invalid.has(dep.id)) {
            errors.push({ modId: id, errors: [`dependency "${dep.id}" is invalid or conflicted`] });
            invalid.add(id);
            changed = true;
            break;
          }
          if (!satisfiesRange(target.version, dep.range)) {
            errors.push({ modId: id, errors: [`dependency "${dep.id}" requires ${dep.range}, found ${target.version}`] });
            invalid.add(id);
            changed = true;
            break;
          }
        }
      }
    }

    const valid = [...enabled.values()].filter((m) => !invalid.has(m.id));
    const validById = new Map(valid.map((m) => [m.id, m]));
    const inDeg = new Map();
    const dependents = new Map();
    for (const m of valid) {
      inDeg.set(m.id, m.dependencies.length);
      if (!dependents.has(m.id)) dependents.set(m.id, []);
      for (const dep of m.dependencies) {
        if (!dependents.has(dep.id)) dependents.set(dep.id, []);
        dependents.get(dep.id).push(m.id);
      }
    }

    const cmp = (a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id);
    const ready = valid.filter((m) => inDeg.get(m.id) === 0).sort(cmp);
    const ordered = [];
    while (ready.length) {
      const next = ready.shift();
      ordered.push(next);
      for (const depId of dependents.get(next.id) ?? []) {
        const rem = inDeg.get(depId) - 1;
        inDeg.set(depId, rem);
        if (rem === 0) {
          ready.push(validById.get(depId));
          ready.sort(cmp);
        }
      }
    }
    if (ordered.length < valid.length) {
      const cyc = valid.filter((m) => !ordered.includes(m)).map((m) => m.id).sort();
      errors.push({ modId: cyc.join(','), errors: [`mod dependency cycle: ${cyc.join(', ')}`] });
    }

    // Aggregate content hooks in deterministic load order (later wins on same id, recording overlaps).
    const items = new Map();
    const factions = new Map();
    const services = new Map();
    const landmarks = new Map();
    const assets = [];
    const uiBadges = [];
    const rules = {};
    const questPackDescriptors = [];
    const hookOverlaps = [];

    for (const m of ordered) {
      const h = m.hooks;
      if (h.items) {
        for (const it of h.items) {
          if (items.has(it.id)) hookOverlaps.push({ category: 'items', id: it.id, winner: m.id, shadowed: items.get(it.id).modId });
          items.set(it.id, { ...it, modId: m.id, modVersion: m.version });
        }
      }
      if (h.factions) {
        for (const f of h.factions) {
          if (factions.has(f.id)) hookOverlaps.push({ category: 'factions', id: f.id, winner: m.id, shadowed: factions.get(f.id).modId });
          factions.set(f.id, { ...f, modId: m.id, modVersion: m.version });
        }
      }
      if (h.services) {
        for (const s of h.services) {
          if (services.has(s.id)) hookOverlaps.push({ category: 'services', id: s.id, winner: m.id, shadowed: services.get(s.id).modId });
          services.set(s.id, { ...s, modId: m.id, modVersion: m.version });
        }
      }
      if (h.world?.landmarks) {
        for (const lm of h.world.landmarks) {
          landmarks.set(lm.id, { ...lm, modId: m.id });
        }
      }
      if (h.assets) {
        assets.push({ modId: m.id, version: m.version, priority: m.priority, ...h.assets });
      }
      if (h.ui?.badges) {
        for (const b of h.ui.badges) uiBadges.push({ ...b, modId: m.id });
      }
      if (h.rules) {
        for (const [rk, rv] of Object.entries(h.rules)) rules[rk] = rv;
      }
      if (h.quests) {
        questPackDescriptors.push({
          manifest: {
            id: m.id,
            name: m.name,
            version: m.version,
            apiVersion: 1,
            enabled: true,
            priority: m.priority,
            dependencies: m.dependencies.filter((d) => validById.get(d.id)?.hooks?.quests),
            conflicts: m.conflicts,
            migrations: h.quests.migrations ?? {},
          },
          scripts: h.quests.scripts ?? {},
          questListText: h.quests.questListText ?? null,
        });
      }
    }

    const questPacks = questPackDescriptors.length ? resolveQuestPacks(questPackDescriptors) : null;
    const questCatalog = questPackDescriptors.length
      ? loadCatalog({ dataPath, packs: questPackDescriptors, warn })
      : null;

    resolvedCache = {
      ordered,
      loadOrder: ordered.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        priority: m.priority,
        categories: m.categories,
      })),
      items,
      factions,
      services,
      landmarks,
      assets,
      uiBadges,
      rules,
      questPacks,
      questCatalog,
      hookOverlaps,
      conflicts,
      errors,
    };
    return resolvedCache;
  }

  function ensureResolved() {
    return resolvedCache ?? resolve();
  }

  return {
    register(raw) {
      const res = register(raw);
      resolvedCache = null;
      return res;
    },
    setEnabled(modId, flag) {
      const m = registered.get(String(modId).toLowerCase());
      if (!m) return false;
      m.enabled = !!flag;
      resolvedCache = null;
      return true;
    },
    unregister(modId) {
      const ok = registered.delete(String(modId).toLowerCase());
      if (ok) resolvedCache = null;
      return ok;
    },
    list() {
      return [...registered.values()]
        .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id))
        .map((m) => ({
          id: m.id,
          name: m.name,
          version: m.version,
          enabled: m.enabled,
          priority: m.priority,
          author: m.author,
          description: m.description,
          categories: m.categories,
          dependencies: m.dependencies,
          conflicts: m.conflicts,
        }));
    },
    resolve,
    getHooks() {
      const r = ensureResolved();
      return {
        items: r.items,
        factions: r.factions,
        services: r.services,
        landmarks: r.landmarks,
        assets: r.assets,
        uiBadges: r.uiBadges,
        rules: r.rules,
        questPacks: r.questPacks,
        questCatalog: r.questCatalog,
      };
    },
    report() {
      const r = ensureResolved();
      return {
        apiVersion: MOD_API_VERSION,
        registered: this.list(),
        loadOrder: r.loadOrder,
        counts: {
          items: r.items.size,
          factions: r.factions.size,
          services: r.services.size,
          landmarks: r.landmarks.size,
          assets: r.assets.length,
          quests: r.questPacks ? r.questPacks.scripts.size : 0,
        },
        questCatalog: r.questCatalog ? catalogReport(r.questCatalog) : null,
        hookOverlaps: r.hookOverlaps,
        conflicts: r.conflicts,
        errors: r.errors,
        rules: r.rules,
      };
    },
  };
}

/**
 * Runtime feature installer (`server/rpg/runtime.js` compatible).
 * Exposes `ctx.services.mods` and read-only `mods.list` / `mods.inspect` actions.
 */
export function install(ctx, opts = {}) {
  const cfg = ctx.config ?? {};
  const registry = opts.registry ?? createModRegistry({
    mods: opts.mods ?? cfg.mods ?? [],
    modsDir: opts.modsDir ?? cfg.modsDir ?? process.env.DFW_MODS_DIR ?? null,
    includeSample: opts.includeSample ?? cfg.includeSampleMod ?? true,
    dataPath: ctx.dataPath ?? null,
    warn: (m) => ctx.log?.warn?.(`[mods] ${m}`),
  });
  const resolved = registry.resolve();
  ctx.services.mods = registry;

  ctx.onAction('mods.list', (p) => {
    const rep = registry.report();
    ctx.notify(p, {
      kind: 'modsList',
      apiVersion: rep.apiVersion,
      loadOrder: rep.loadOrder,
      counts: rep.counts,
      rules: rep.rules,
      conflicts: rep.conflicts,
      errors: rep.errors,
      registered: rep.registered,
    });
    return rep;
  });

  ctx.onAction('mods.inspect', (p, args = {}) => {
    const modId = String(args.modId ?? '').trim().toLowerCase();
    const found = registry.list().find((m) => m.id === modId) ?? null;
    if (!found) throw new Error(`Mod "${modId}" is not installed on this server.`);
    const rep = { kind: 'modInspect', mod: found, active: resolved.loadOrder.some((x) => x.id === modId) };
    ctx.notify(p, rep);
    return rep;
  });

  return registry;
}
