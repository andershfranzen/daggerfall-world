// Seasonal and weather look of outdoor scenes (classic packages 20/21, renderer part).
//
// What changes, after Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), which
// follows classic Daggerfall here:
//   * Ground, building and nature textures have two looks: summer and winter
//     (DaggerfallLocation.ApplyTimeAndSpace, StreamingWorld's RMB blocks and
//     TerrainMaterialProvider.GetClimateInfo all pick ClimateSeason.Winter only in the
//     Winter season, Summer otherwise). Spring and Fall use the summer textures. Rain
//     variants (archive + 2) exist in ARENA2 but neither engine draws them.
//   * The winter swap is per climate, not per weather: desert-based climates (Desert,
//     Desert2, Subtropical: climate base 0) keep their ground and buildings
//     (TerrainMaterialProvider skips ClimateBaseType.Desert; ClimateSwaps has no snow
//     set for base 0). Nature flats change only for the woodland, hills, haunted and
//     mountain sets (ClimateSwaps.GetNatureArchive). town.js applyClimate() already
//     encodes these per-archive rules; a scene only needs the one `winter` flag.
//   * The day sky is SkyBase + season for clear, cloudy and overcast weather, SkyBase + 4/5
//     (Rain1/Rain2) for fog, rain and thunder, SkyBase + 6/7 (Snow1/Snow2) for snow
//     (DaggerfallSky.ApplyTimeAndSpace, WeatherManager.SetWeather). DFU picks 1 or 2 at
//     random; here it is a stable choice per region and weather period so every player sees
//     the same sky.
//
// DOM-free so Node tests drive it.
import { skyBase, SEASONS } from '../scenery/sky.js';

/** The look a scene is built with: only winter versus not changes textures. */
export function lookFor(season) {
  return { winter: String(season ?? '').toLowerCase() === 'winter' };
}

/** The look a built mesh carries (meshes from before this module count as summer). */
export const lookOf = (mesh) => ({ winter: !!mesh?.look?.winter });
export const sameLook = (a, b) => !!a?.winter === !!b?.winter;

const RAIN_SKY = new Set(['fog', 'rain', 'thunder']);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * SKYnn.DAT index for a CLIMATE.PAK value, season and weather type.
 * @param {number} climateValue
 * @param {string} season - 'Fall' | 'Spring' | 'Summer' | 'Winter' (any case)
 * @param {string} [weather] - calendar weather type
 * @param {string|number} [variant] - seed for the 1-or-2 choice of rain and snow skies
 */
export function skyIndexFor(climateValue, season, weather = 'sunny', variant = 0) {
  const base = skyBase(climateValue);
  const second = hash(String(variant)) & 1;
  if (RAIN_SKY.has(weather)) return base + 4 + second;
  if (weather === 'snow') return base + 6 + second;
  return base + (SEASONS[String(season ?? 'summer').toLowerCase()] ?? SEASONS.summer);
}

/** Climate value whose sky the player sees in an exterior scene (town or wilderness centre pixel). */
export function sceneClimate(mesh) {
  if (!mesh) return null;
  const v = mesh.kind === 'wilderness' ? mesh.wilderness?.climate?.value : mesh.source?.climate?.value;
  return Number.isInteger(v) ? v : null;
}

const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Give an existing scene mesh the textures of `fresh`, the same place built with another look.
 * Geometry must be identical (the look changes only texture archives); the mesh object, its
 * positions, collision and every reference to it stay as they are. Returns what changed, or
 * null (and leaves `target` untouched) when the geometry differs.
 */
export function reskinMesh(target, fresh) {
  if (!target || !fresh || !same(target.positions, fresh.positions)) return null;
  const changed = { uv: false, atlas: false, flats: false, mechanisms: 0 };
  if (!same(target.uv, fresh.uv)) { target.uv = fresh.uv; changed.uv = true; }
  if (fresh.atlas && !(target.atlas && same(target.atlas.pixels, fresh.atlas.pixels) && target.atlas.width === fresh.atlas.width)) {
    target.atlas = fresh.atlas;
    changed.atlas = true;
  }
  // City gates swap their UVs with their pose (renderer.updateDungeonPoses).
  const byId = new Map((fresh.mechanisms ?? []).map((m) => [m.id, m]));
  for (const m of target.mechanisms ?? []) {
    const f = byId.get(m.id);
    if (f?.alternateUv && !same(m.alternateUv, f.alternateUv)) { m.alternateUv = f.alternateUv; changed.mechanisms++; }
  }
  if (target.kind === 'wilderness' && fresh.flats !== undefined) {
    const a = target.flats, b = fresh.flats;
    if (!a || !b || !same(a.atlas?.pixels, b.atlas?.pixels) || !same(a.billboards?.vertices, b.billboards?.vertices)) {
      target.flats = b;
      changed.flats = true;
    }
  }
  if (target.wilderness?.climate && fresh.wilderness?.climate) target.wilderness.climate = fresh.wilderness.climate;
  if (fresh.sky !== undefined) target.sky = fresh.sky;
  if (target.stats && fresh.stats) target.stats = { ...target.stats, climateSwapFallbacks: fresh.stats.climateSwapFallbacks ?? target.stats.climateSwapFallbacks };
  target.look = { ...lookOf(fresh) };
  return changed;
}
