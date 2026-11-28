// Client-side local asset replacement manager (textures, models, UI, animations).
//
// Design principles (docs/multiplayer-feature-plan.md §7 "Local asset replacement"):
//   - Strictly client-local presentation overrides (import, export, enable/disable, priority, reset).
//   - Deterministic pack precedence: enabled packs are ordered by (priority ASC, id ASC);
//     later packs override earlier ones, with explicit conflict/shadowing reporting.
//   - Authoritative collision preservation: overrides may NEVER alter collision geometry,
//     ground heights, portals, bounds, or server interaction state. Attempting to import
//     collision/physics fields is rejected at validation time, and mesh application verifies
//     the collision fingerprint before and after applying visual overrides.

export const ASSET_OVERRIDES_STORAGE_KEY = 'daggerfallworld.assetOverrides.v1';

export const ASSET_CATEGORIES = Object.freeze(['textures', 'models', 'ui', 'animations']);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const COLLISION_FORBIDDEN = new Set([
  'colliders', 'collision', 'collisionMesh', 'ground', 'portals', 'bounds',
  'triggers', 'hitboxes', 'walkable', 'physics', 'sight', 'serverState',
]);
const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const MAX_PACK_JSON_BYTES = 8 * 1024 * 1024;

export const SAMPLE_OVERRIDE_PACK = Object.freeze({
  id: 'wayfarer-hi-contrast',
  name: 'Wayfarer Classic Visual Pack (Sample)',
  version: '1.0.0',
  priority: 10,
  enabled: false,
  author: 'Daggerfall World',
  description: 'Client-side gilded stone texture tint, compass UI accent, and smooth weapon swing cadence override.',
  assets: {
    textures: {
      'atlas:tint': { kind: 'tint', r: 1.06, g: 1.02, b: 0.94, contrast: 1.08, label: 'Warm stone atlas tint' },
      'TEXTURE.002:46': { kind: 'solid', rgba: [134, 126, 114, 255], label: 'Cobbled street stone' },
    },
    models: {
      '41000': { kind: 'visual-scale', tint: [1.05, 1.0, 0.92], label: 'Lantern warm brass tint' },
    },
    ui: {
      'hud:accent': { cssVar: '--accent', value: '#e2b86b', label: 'Warm gold HUD accent' },
      'hud:accent-hi': { cssVar: '--accent-hi', value: '#f7dca4', label: 'Warm gold highlight' },
    },
    animations: {
      'weapon:swing': { frameRateScale: 1.15, label: 'Crisper weapon swing cadence (visual only)' },
    },
  },
});

function hasForbiddenCollisionKey(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) return `forbidden property "${k}"`;
    if (COLLISION_FORBIDDEN.has(k)) return `authoritative collision/physics field "${k}" cannot be overridden`;
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) {
      const nested = hasForbiddenCollisionKey(v, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Validate and normalize a local asset replacement pack manifest. Throws on invalid/unsafe packs. */
export function validateOverridePack(raw) {
  if (typeof raw === 'string') {
    if (raw.length > MAX_PACK_JSON_BYTES) throw new Error('Asset override pack exceeds maximum size (8 MB).');
    raw = JSON.parse(raw);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Asset override pack must be a JSON object.');
  }
  const collisionErr = hasForbiddenCollisionKey(raw);
  if (collisionErr) {
    throw new Error(`Invalid asset override pack: ${collisionErr}.`);
  }
  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!PACK_ID_RE.test(id)) {
    throw new Error(`Invalid pack id "${raw.id ?? ''}": use 2-64 lowercase letters, digits, ".", "_" or "-".`);
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : id;
  const version = typeof raw.version === 'string' && SEMVER_RE.test(raw.version.trim())
    ? raw.version.trim()
    : '1.0.0';
  const priority = Number.isFinite(Number(raw.priority)) ? Math.trunc(Number(raw.priority)) : 0;
  const enabled = raw.enabled !== false;
  const rawAssets = raw.assets && typeof raw.assets === 'object' && !Array.isArray(raw.assets) ? raw.assets : {};

  const assets = { textures: {}, models: {}, ui: {}, animations: {} };
  for (const cat of ASSET_CATEGORIES) {
    const bucket = rawAssets[cat];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const [k, v] of Object.entries(bucket)) {
      if (FORBIDDEN_KEYS.has(k) || !k || k.length > 128) continue;
      if (v === null || v === undefined) continue;
      assets[cat][k] = structuredClone(v);
    }
  }

  return {
    id,
    name,
    version,
    priority,
    enabled,
    author: typeof raw.author === 'string' ? raw.author.trim().slice(0, 80) : '',
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 240) : '',
    assets,
  };
}

/**
 * Deterministic fingerprint of a scene mesh's authoritative collision & navigation structures.
 * Must remain identical before and after applying any client-side visual asset override.
 */
export function collisionFingerprint(mesh) {
  if (!mesh || typeof mesh !== 'object') return 'empty';
  const colliders = Array.isArray(mesh.colliders) ? mesh.colliders : [];
  const portals = Array.isArray(mesh.portals) ? mesh.portals : [];
  const bounds = mesh.bounds ?? null;
  let hash = 2166136261;
  const mix = (n) => {
    hash ^= (Math.round((Number(n) || 0) * 1000) | 0);
    hash = Math.imul(hash, 16777619);
  };
  mix(colliders.length);
  for (const c of colliders) {
    if (!c) continue;
    mix(c.minX ?? c.x ?? 0);
    mix(c.maxX ?? c.w ?? 0);
    mix(c.minY ?? c.y ?? 0);
    mix(c.maxY ?? c.h ?? 0);
    mix(c.minZ ?? c.z ?? 0);
    mix(c.maxZ ?? c.d ?? 0);
  }
  mix(portals.length);
  for (const p of portals) {
    if (!p) continue;
    mix(p.x ?? 0);
    mix(p.y ?? 0);
    mix(p.z ?? 0);
  }
  if (bounds) {
    mix(bounds.minX); mix(bounds.maxX); mix(bounds.minZ); mix(bounds.maxZ);
  }
  mix(mesh.ground?.length ?? 0);
  return `col:${colliders.length}:${portals.length}:${(hash >>> 0).toString(16)}`;
}

/**
 * Manages client-side local asset replacement packs with deterministic precedence,
 * import/export/reset, conflict diagnostics, and collision-safe visual application.
 */
export class AssetOverrideManager {
  constructor({ storage = null, preloadSample = false } = {}) {
    this.storage = storage ?? (() => { try { return globalThis.localStorage; } catch { return null; } })();
    this.packs = new Map(); // id -> validated pack
    this._listeners = new Set();
    this._appliedCssVars = new Map(); // cssVar -> original inline value
    this._load();
    if (preloadSample && !this.packs.has(SAMPLE_OVERRIDE_PACK.id)) {
      this.packs.set(SAMPLE_OVERRIDE_PACK.id, validateOverridePack(SAMPLE_OVERRIDE_PACK));
    }
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snap = this.summary();
    for (const fn of this._listeners) {
      try { fn(snap); } catch { /* ignore listener failure */ }
    }
  }

  _load() {
    try {
      const raw = this.storage?.getItem?.(ASSET_OVERRIDES_STORAGE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      for (const item of list) {
        try {
          const pack = validateOverridePack(item);
          this.packs.set(pack.id, pack);
        } catch { /* skip corrupt saved pack */ }
      }
    } catch { /* storage unavailable */ }
  }

  _save() {
    try {
      const list = [...this.packs.values()];
      this.storage?.setItem?.(ASSET_OVERRIDES_STORAGE_KEY, JSON.stringify(list));
    } catch { /* quota or private mode */ }
  }

  /** Enabled packs in deterministic load order: (priority ASC, id ASC). Later wins. */
  orderedEnabledPacks() {
    return [...this.packs.values()]
      .filter((p) => p.enabled)
      .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id));
  }

  /** All registered packs sorted by (priority ASC, id ASC). */
  listPacks() {
    return [...this.packs.values()]
      .sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        priority: p.priority,
        enabled: p.enabled,
        author: p.author,
        description: p.description,
        counts: Object.fromEntries(ASSET_CATEGORIES.map((c) => [c, Object.keys(p.assets[c]).length])),
      }));
  }

  importPack(input) {
    const pack = validateOverridePack(input);
    this.packs.set(pack.id, pack);
    this._save();
    this._emit();
    return pack;
  }

  importBundle(jsonOrObj) {
    const data = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
    const list = Array.isArray(data) ? data : Array.isArray(data?.packs) ? data.packs : [data];
    const imported = [];
    for (const item of list) imported.push(this.importPack(item));
    return imported;
  }

  exportPack(packId) {
    const p = this.packs.get(String(packId).toLowerCase());
    if (!p) throw new Error(`Unknown asset override pack: ${packId}`);
    return JSON.stringify(p, null, 2);
  }

  exportAll() {
    return JSON.stringify({
      format: 'dfw-asset-overrides',
      version: 1,
      packs: [...this.packs.values()].sort((a, b) => (a.priority - b.priority) || a.id.localeCompare(b.id)),
    }, null, 2);
  }

  setPackEnabled(packId, enabled) {
    const p = this.packs.get(String(packId).toLowerCase());
    if (!p) return false;
    p.enabled = !!enabled;
    this._save();
    this._emit();
    return true;
  }

  setPackPriority(packId, priority) {
    const p = this.packs.get(String(packId).toLowerCase());
    if (!p || !Number.isFinite(Number(priority))) return false;
    p.priority = Math.trunc(Number(priority));
    this._save();
    this._emit();
    return true;
  }

  /** Remove a single override pack and emit change. */
  resetPack(packId) {
    const existed = this.packs.delete(String(packId).toLowerCase());
    if (existed) {
      this._save();
      this._emit();
    }
    return existed;
  }

  /** Clear all custom asset overrides (restoring classic originals). */
  resetAll({ keepSampleDisabled = false } = {}) {
    this.packs.clear();
    if (keepSampleDisabled) {
      this.packs.set(SAMPLE_OVERRIDE_PACK.id, validateOverridePack({ ...SAMPLE_OVERRIDE_PACK, enabled: false }));
    }
    this._save();
    this._emit();
  }

  /** Resolve one asset override across enabled packs using deterministic precedence. */
  resolve(category, key) {
    if (!ASSET_CATEGORIES.includes(category)) return { found: false, value: null, packId: null, shadowed: [] };
    const ordered = this.orderedEnabledPacks();
    let winner = null;
    const shadowed = [];
    for (const p of ordered) {
      if (Object.hasOwn(p.assets[category], key)) {
        if (winner) shadowed.push({ packId: winner.packId, version: winner.version, priority: winner.priority });
        winner = { packId: p.id, version: p.version, priority: p.priority, value: p.assets[category][key] };
      }
    }
    if (!winner) return { found: false, value: null, packId: null, shadowed: [] };
    return { found: true, ...winner, shadowed };
  }

  /** Return all keys where multiple enabled packs define the same asset (showing deterministic winner). */
  conflicts() {
    const ordered = this.orderedEnabledPacks();
    const seen = new Map();
    for (const p of ordered) {
      for (const cat of ASSET_CATEGORIES) {
        for (const key of Object.keys(p.assets[cat])) {
          const full = `${cat}:${key}`;
          if (!seen.has(full)) seen.set(full, { category: cat, key, providers: [] });
          seen.get(full).providers.push({ packId: p.id, version: p.version, priority: p.priority });
        }
      }
    }
    const out = [];
    for (const entry of seen.values()) {
      if (entry.providers.length > 1) {
        const winner = entry.providers[entry.providers.length - 1];
        const shadowed = entry.providers.slice(0, -1);
        out.push({ category: entry.category, key: entry.key, winner, shadowed });
      }
    }
    return out;
  }

  /**
   * Apply active texture overrides to a town/dungeon/interior mesh atlas visually,
   * preserving original pixels for clean reset and verifying authoritative collision is untouched.
   */
  applyToMesh(mesh, renderer = null) {
    if (!mesh?.atlas?.pixels) return { applied: false, collisionIntact: true };
    const beforeFp = collisionFingerprint(mesh);
    const px = mesh.atlas.pixels instanceof Uint8Array
      ? mesh.atlas.pixels
      : new Uint8Array(mesh.atlas.pixels.buffer, mesh.atlas.pixels.byteOffset, mesh.atlas.pixels.byteLength);

    if (!mesh._origAtlasPixels) {
      mesh._origAtlasPixels = new Uint8Array(px);
    }
    // Always rebuild from original classic pixels so disabling/resetting a pack restores bit-exact art.
    px.set(mesh._origAtlasPixels);

    let modified = false;
    const tintOverride = this.resolve('textures', 'atlas:tint');
    if (tintOverride.found && tintOverride.value) {
      const { r = 1, g = 1, b = 1, contrast = 1 } = tintOverride.value;
      const rc = Math.min(2, Math.max(0.2, Number(r) || 1));
      const gc = Math.min(2, Math.max(0.2, Number(g) || 1));
      const bc = Math.min(2, Math.max(0.2, Number(b) || 1));
      const ct = Math.min(2, Math.max(0.5, Number(contrast) || 1));
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        px[i] = Math.min(255, Math.max(0, Math.round(((px[i] - 128) * ct + 128) * rc)));
        px[i + 1] = Math.min(255, Math.max(0, Math.round(((px[i + 1] - 128) * ct + 128) * gc)));
        px[i + 2] = Math.min(255, Math.max(0, Math.round(((px[i + 2] - 128) * ct + 128) * bc)));
      }
      modified = true;
    }

    // Apply per-texture-key solid/RGBA overrides when the mesh exposes atlas region rects.
    if (mesh.atlas.rects && typeof mesh.atlas.rects === 'object') {
      const entries = mesh.atlas.rects instanceof Map ? [...mesh.atlas.rects.entries()] : Object.entries(mesh.atlas.rects);
      for (const [key, rect] of entries) {
        const ov = this.resolve('textures', key);
        if (!ov.found || !ov.value || !rect) continue;
        const x0 = Math.max(0, Math.floor(rect.x ?? 0));
        const y0 = Math.max(0, Math.floor(rect.y ?? 0));
        const rw = Math.min(mesh.atlas.width - x0, Math.floor(rect.width ?? rect.w ?? 0));
        const rh = Math.min(mesh.atlas.height - y0, Math.floor(rect.height ?? rect.h ?? 0));
        if (ov.value.kind === 'solid' && Array.isArray(ov.value.rgba) && ov.value.rgba.length >= 4) {
          const [sr, sg, sb, sa] = ov.value.rgba;
          for (let y = y0; y < y0 + rh; y++) {
            for (let x = x0; x < x0 + rw; x++) {
              const o = (y * mesh.atlas.width + x) * 4;
              px[o] = sr & 255; px[o + 1] = sg & 255; px[o + 2] = sb & 255; px[o + 3] = sa & 255;
            }
          }
          modified = true;
        }
      }
    }

    mesh.atlas.pixels = px;
    if (renderer && typeof renderer.reskin === 'function') {
      renderer.reskin(mesh, { uv: false, atlas: true });
    }
    const afterFp = collisionFingerprint(mesh);
    return {
      applied: modified,
      restored: !modified,
      collisionIntact: beforeFp === afterFp,
      beforeFp,
      afterFp,
    };
  }

  /**
   * Resolve a visual-only model override, returning a shallow visual clone while guaranteeing
   * original authoritative collision fields (colliders, bounds, portals, ground) are preserved.
   */
  applyToModel(modelId, originalModel) {
    if (!originalModel || typeof originalModel !== 'object') return originalModel;
    const ov = this.resolve('models', String(modelId));
    if (!ov.found || !ov.value) return originalModel;
    const beforeFp = collisionFingerprint(originalModel);
    const visual = {
      ...originalModel,
      visualOverridePack: ov.packId,
      ...(Array.isArray(ov.value.tint) && ov.value.tint.length >= 3 ? { uniformColor: ov.value.tint.slice(0, 3) } : {}),
      ...(ov.value.positions ? { positions: ov.value.positions } : {}),
      ...(ov.value.uv ? { uv: ov.value.uv } : {}),
      // Authoritative collision references always stay pinned to the original model.
      colliders: originalModel.colliders,
      bounds: originalModel.bounds,
      portals: originalModel.portals,
      ground: originalModel.ground,
    };
    const afterFp = collisionFingerprint(visual);
    if (beforeFp !== afterFp) {
      throw new Error('Model override attempted to alter authoritative collision geometry.');
    }
    return visual;
  }

  /** Apply UI CSS variable overrides to the document root and restore originals when disabled/reset. */
  applyUiOverrides(doc = globalThis.document) {
    const root = doc?.documentElement;
    if (!root?.style) return { applied: 0 };
    // Restore previous overrides first so disabling/resetting cleanly reverts every variable.
    for (const [cssVar, prevVal] of this._appliedCssVars.entries()) {
      if (prevVal) root.style.setProperty(cssVar, prevVal);
      else root.style.removeProperty(cssVar);
    }
    this._appliedCssVars.clear();

    const ordered = this.orderedEnabledPacks();
    const vars = new Map();
    for (const p of ordered) {
      for (const entry of Object.values(p.assets.ui)) {
        if (entry && typeof entry.cssVar === 'string' && /^--[a-z0-9-]+$/i.test(entry.cssVar) && typeof entry.value === 'string') {
          vars.set(entry.cssVar, entry.value.slice(0, 80));
        }
      }
    }
    for (const [cssVar, value] of vars.entries()) {
      this._appliedCssVars.set(cssVar, root.style.getPropertyValue(cssVar));
      root.style.setProperty(cssVar, value);
    }
    return { applied: vars.size };
  }

  summary() {
    const packs = this.listPacks();
    const enabled = packs.filter((p) => p.enabled);
    const conflicts = this.conflicts();
    return {
      totalPacks: packs.length,
      enabledPacks: enabled.length,
      loadOrder: enabled.map((p) => `${p.id}@${p.version}`),
      conflictCount: conflicts.length,
      conflicts,
      packs,
    };
  }
}
