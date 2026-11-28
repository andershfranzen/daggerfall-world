// Independent automap preferences (DFU-style): view mode (2D/3D), dungeon minimap,
// remembered slice level per location, exterior default zoom and reset behavior.
// Stored separately from character-private exploration memory and notes. DOM-free.

export const AUTOMAP_PREFS_KEY = 'dfw.automap.prefs';
export const MIN_EXTERIOR_ZOOM = 0.5;
export const MAX_EXTERIOR_ZOOM = 16;
export const MIN_SLICE_OFFSET = -6;
export const MAX_SLICE_OFFSET = 6;
export const DEFAULT_ORBIT_YAW = 0.65;
export const DEFAULT_ORBIT_PITCH = 0.72;
export const MIN_ORBIT_PITCH = 0.18;
export const MAX_ORBIT_PITCH = 1.48;

export const MINIMAP_CORNERS = Object.freeze(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
export const MINIMAP_SIZES = Object.freeze(['compact', 'medium', 'large']);

export const DEFAULT_AUTOMAP_PREFS = Object.freeze({
  viewMode: '2d',
  orbitYaw: DEFAULT_ORBIT_YAW,
  orbitPitch: DEFAULT_ORBIT_PITCH,
  minimapEnabled: false,
  minimapCorner: 'top-right',
  minimapSize: 'medium',
  rememberSlice: true,
  exteriorDefaultZoom: 2.5,
  exteriorResetOnOpen: false,
  savedSlices: Object.freeze({}),
});

const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

function normalizeSavedSlices(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let count = 0;
  for (const [loc, entry] of Object.entries(raw)) {
    if (count >= 64 || typeof loc !== 'string' || !loc || loc.length > 150) continue;
    if (!entry || typeof entry !== 'object') continue;
    const floor = entry.floor === null ? null : (Number.isInteger(entry.floor) && entry.floor >= 0 && entry.floor < 32 ? entry.floor : null);
    const sliceOffset = clamp(entry.sliceOffset, MIN_SLICE_OFFSET, MAX_SLICE_OFFSET, 0);
    out[loc] = { floor, sliceOffset };
    count++;
  }
  return out;
}

export function normalizeAutomapPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const wrapYaw = (v) => (!Number.isFinite(v) ? DEFAULT_ORBIT_YAW : (v >= -Math.PI && v <= Math.PI ? v : Math.atan2(Math.sin(v), Math.cos(v))));
  return {
    viewMode: src.viewMode === '3d' ? '3d' : '2d',
    orbitYaw: wrapYaw(src.orbitYaw),
    orbitPitch: clamp(src.orbitPitch, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH, DEFAULT_ORBIT_PITCH),
    minimapEnabled: src.minimapEnabled === true,
    minimapCorner: MINIMAP_CORNERS.includes(src.minimapCorner) ? src.minimapCorner : 'top-right',
    minimapSize: MINIMAP_SIZES.includes(src.minimapSize) ? src.minimapSize : 'medium',
    rememberSlice: src.rememberSlice !== false,
    exteriorDefaultZoom: clamp(src.exteriorDefaultZoom, MIN_EXTERIOR_ZOOM, MAX_EXTERIOR_ZOOM, 2.5),
    exteriorResetOnOpen: src.exteriorResetOnOpen === true,
    savedSlices: normalizeSavedSlices(src.savedSlices),
  };
}

export function loadAutomapPrefs(storage = globalThis.localStorage) {
  let raw = {};
  try { raw = JSON.parse(storage?.getItem(AUTOMAP_PREFS_KEY) ?? '{}') || {}; } catch { raw = {}; }
  return normalizeAutomapPrefs(raw);
}

export function saveAutomapPrefs(prefs, storage = globalThis.localStorage) {
  const normalized = normalizeAutomapPrefs(prefs);
  try { storage?.setItem(AUTOMAP_PREFS_KEY, JSON.stringify(normalized)); } catch { /* storage disabled */ }
  return normalized;
}

export function resetAutomapPrefs(storage = globalThis.localStorage) {
  const fresh = normalizeAutomapPrefs({});
  return saveAutomapPrefs(fresh, storage);
}
