// Solid flats: which billboard flats a body bumps into, and how big that body is.
//
// Daggerfall Unity gives flats no collider (Internal/DaggerfallBillboard.cs builds a quad and a
// material; Terrain/TerrainNature.cs DefaultTerrainNature adds nature to a DaggerfallBillboardBatch
// with no collider; only a MeshReplacement model brings one). CollisionWorld only reads triangles,
// so without this module a player walks through every tree, rock, well and barrel.
//
// Identity: which records are trees, rocks, plants or props comes from Daggerfall Unity's own
// flat catalogue, Assets/Game/Addons/RmbBlockEditor/Editor/Persisted/DefaultFlatsCatalog.json
// (MIT, (c) 2009-2023 Daggerfall Workshop; see THIRD_PARTY_NOTICES.txt). Winter nature archives
// (505, 507, 509, 511) are their summer archive + 1 (ClimateSwaps.ApplyClimate), so they share it.
//
// Shape: a flat turns to face the camera about its base centre, so the only collider that does not
// move with the view is an upright cylinder at that base. Its radius and height are measured from
// the record's own picture (TEXTURE.nnn frame 0, index 0 transparent): the opaque run through the
// base centre, over the rows a walking body meets. A tree is its trunk, never its crown; a record
// whose picture does not stand on the ground at its centre (hanging lamps, a trunk drawn well off
// centre) gets no collider rather than an invisible post in empty air.
//
// Output per collider (CYLINDER_STRIDE floats): x, z, y0, y1, r in the scene frame, metres.

import { FlatArchive } from './flatTextures.js';
import { NPC_ARCHIVES, EDITOR_ARCHIVE, ANIMALS_ARCHIVE, LIGHTS_ARCHIVE, isNatureArchive, parseRmbFlats, layoutTownFlats } from './rmbFlats.js';
import { natureArchive as natureArchiveOf } from './sky.js';

export const CYLINDER_STRIDE = 5;
/** Below this a body steps over the flat anyway (CollisionWorld PLAYER.step), so none is made. */
export const MIN_TOP = 0.75;
/** Rows measured for the radius: legs to head height (CollisionWorld PLAYER.height). */
const BAND_LO = 0.1, BAND_HI = 1.8;
/** The picture must reach the ground at its centre within this height. */
const FOOT_ROWS = 0.35;
/** A trunk is at most this wide (radius); a prop (well, hay rick, statue) at most PROP_MAX. */
export const TRUNK_MAX = 0.5;
export const PROP_MAX = 1.6;
/** Thinner posts (a street lamp's pole) still stop a body: radius at least this. */
const MIN_R = 0.1;
/** A run is the centre's when it reaches this close to the base centre (metres, plus one pixel). */
const PIVOT_TOL = 0.25;

// --- DefaultFlatsCatalog.json, by summer nature archive: "Trees - <climate>" and "Rocks - <climate>".
// Every other record 1-31 of a nature archive is a plant (grass, bush, fern, flower) and passable.
const TREES = {
  500: [3, 12, 13, 14, 15, 16, 18, 25, 30],
  501: [11, 12, 13, 15, 16, 17, 19, 24, 30],
  502: [12, 13, 15, 16, 17, 18, 19, 24, 25, 30],
  503: [5, 11, 12, 13, 28, 30],
  504: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 25, 30, 31],
  506: [5, 10, 11, 12, 13, 14, 15, 16, 19, 20, 24, 25, 30],
  508: [13, 15, 16, 18, 19, 20, 24, 25, 30, 31],
  510: [5, 11, 12, 13, 15, 16, 19, 20, 24, 25, 30],
};
const ROCKS = {
  500: [4, 17, 19, 28],
  501: [3, 4, 5, 6, 10, 23],
  502: [2, 3, 4, 5, 6, 10],
  // The catalogue lists 503.2 twice in a group of nine; 503.21 is in no group (taken as the ninth rock).
  503: [2, 3, 4, 6, 18, 19, 20, 21, 22],
  504: [3, 4, 5, 6],
  506: [1, 3, 4, 6, 17, 18, 28],
  508: [1, 3, 4, 5, 6, 10, 12, 17],
  510: [1, 3, 4, 6, 14, 17, 18, 27, 28, 31],
};
const toSet = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
const TREE_SET = toSet(TREES), ROCK_SET = toSet(ROCKS);

// --- Non-nature records the catalogue files as passable: crops (301), shrubs, hanging plants,
// camp fire, hanging and wall lights, candles, blood, manure. Standing lights stay solid:
// "Street Lamps" 210.28-29, "Standing Lanterns" 210.14-15, "Brazier" 210.0, "Brazier - Pillar" 210.19,
// "Torch - Standing" 210.20, "Standing Candle" 210.21.
const SOLID_LIGHTS = new Set([0, 14, 15, 19, 20, 21, 28, 29]);
const PASSABLE = new Set([
  '213.13', '213.14', // Plants - Hanged
  '213.15', '213.16', '213.17', '198.4', // Shrubs
  '253.21', // Manure
  '206.33', '206.34', '100.0', '100.1', // Blood
]);
/** TextureReader: treasure piles (216) are loot, crops (301) are field plants. */
const PASSABLE_ARCHIVES = new Set([EDITOR_ARCHIVE, ANIMALS_ARCHIVE, 216, 301]);

/** Summer nature archive of a (possibly winter) nature archive. */
export const summerNature = (archive) => (archive >= 505 && archive <= 511 && archive % 2 === 1 ? archive - 1 : archive);

/**
 * How a flat collides: 'tree' (trunk), 'prop' (rock or object, measured footprint) or null (passes).
 * Animals (201) and people are actors and belong to the actor systems.
 */
export function flatSolidity(archive, record, { kind } = {}) {
  if (kind === 'loot' || kind === 'person' || kind === 'animal' || kind === 'editor') return null;
  if (PASSABLE_ARCHIVES.has(archive) || NPC_ARCHIVES.has(archive)) return null;
  if (isNatureArchive(archive)) {
    const base = summerNature(archive);
    if (TREE_SET[base]?.has(record)) return 'tree';
    if (ROCK_SET[base]?.has(record)) return 'prop';
    return null; // plants: grass, bushes, ferns, flowers
  }
  if (archive === LIGHTS_ARCHIVE) return SOLID_LIGHTS.has(record) ? 'prop' : null;
  if (PASSABLE.has(`${archive}.${record}`)) return null;
  return 'prop';
}

/**
 * Measure one record: {radius, top} in metres at scale 1, or null when its picture does not stand
 * solid on the ground at its base centre.
 * @param {{width:number,height:number,data:Uint8Array}} img frame 0, top row first
 * @param {{width:number,height:number}} size world size (FlatArchive.size)
 */
export function measureFlat(img, size, mode) {
  const { width: w, height: h, data } = img;
  if (!(w > 0 && h > 0 && size.width > 0 && size.height > 0)) return null;
  const perCol = size.width / w, perRow = size.height / h;
  const pivot = w / 2; // the quad's base centre, in pixel units
  const tol = PIVOT_TOL / perCol + 1;
  /** Half-width (m) of the opaque run at or next to the pivot in image row y, or 0. */
  const runAt = (y) => {
    const row = y * w;
    let best = null;
    for (let x = 0; x < w; ) {
      if (!data[row + x]) { x++; continue; }
      const a = x;
      while (x < w && data[row + x]) x++;
      const b = x; // run [a, b)
      const gap = pivot < a ? a - pivot : pivot > b ? pivot - b : 0;
      if (gap <= tol && (!best || gap < best.gap)) best = { gap, a, b };
    }
    return best ? ((best.b - best.a) / 2) * perCol : 0;
  };
  const heightOf = (y) => (h - 1 - y + 0.5) * perRow; // metres above the base
  // Grounded: most of the lowest rows have a run at the centre.
  let foot = 0, footHit = 0;
  const radii = [];
  let top = 0, gap = 0;
  for (let y = h - 1; y >= 0; y--) {
    const z = heightOf(y);
    const r = runAt(y);
    if (z <= FOOT_ROWS) { foot++; if (r > 0) footHit++; }
    if (z >= BAND_LO && z <= BAND_HI) radii.push(r);
    // The column rises while the centre stays opaque, bridging gaps up to 0.2 m.
    if (r > 0) { top = z + perRow / 2; gap = 0; } else if ((gap += perRow) > 0.2 && top > 0) break;
  }
  if (!foot || footHit * 2 < foot) return null;
  const hit = radii.filter((r) => r > 0).sort((p, q) => p - q);
  if (!hit.length || hit.length * 5 < radii.length * 3) return null; // the body band must be mostly solid
  const radius = Math.max(MIN_R, Math.min(hit[hit.length >> 1], mode === 'tree' ? TRUNK_MAX : PROP_MAX, size.width / 2));
  if (top < MIN_TOP) return null;
  return { radius, top: Math.min(top, size.height) };
}

/**
 * Collider shapes per record, cached per TEXTURE file object so a scene rebuild or the server's
 * next area reuses them. `index` is files.js indexFiles() output (upper-case name -> File).
 */
export class FlatColliderCache {
  constructor(index) {
    this.index = index;
    this.archives = new Map(); // archive -> Promise<FlatArchive|null>
    this.shapes = new Map(); // "archive:record" -> {radius, top}|null
    this.missing = new Set();
  }

  async #archive(archive) {
    let p = this.archives.get(archive);
    if (!p) {
      const file = this.index.get(`TEXTURE.${String(archive).padStart(3, '0')}`);
      p = file ? archiveOf(file, archive) : Promise.resolve(null);
      this.archives.set(archive, p);
    }
    const fa = await p;
    if (!fa) this.missing.add(archive);
    return fa;
  }

  /** {radius, top} at scale 1, or null. */
  async shape(archive, record, mode) {
    const key = `${archive}:${record}`;
    if (this.shapes.has(key)) return this.shapes.get(key);
    let s = null;
    const fa = await this.#archive(archive);
    if (fa) {
      try { s = measureFlat(fa.decode(record, 0), fa.size(record), mode); } catch { s = null; }
    }
    this.shapes.set(key, s);
    return s;
  }
}

const archiveCache = new WeakMap(); // File -> Map(archive -> Promise<FlatArchive|null>)
function archiveOf(file, archive) {
  let m = archiveCache.get(file);
  if (!m) archiveCache.set(file, (m = new Map()));
  let p = m.get(archive);
  if (!p) {
    p = file.arrayBuffer().then((b) => new FlatArchive(new Uint8Array(b), archive)).catch(() => null);
    m.set(archive, p);
  }
  return p;
}

/**
 * Cylinders for placed flats.
 * @param {Map<string, File>} index - indexFiles() of the player's / operator's files
 * @param {Iterable<{archive:number, record:number, x:number, y:number, z:number, sx?:number, sy?:number, kind?:string}>} flats
 *   x/y/z is the billboard's base centre in the scene frame; sx/sy its own scale (World of Daggerfall)
 * @returns {Promise<{cylinders: Float32Array, stats: object}>}
 */
export async function flatCylinders(index, flats, { cache = new FlatColliderCache(index) } = {}) {
  const out = [];
  const stats = { flats: 0, trees: 0, props: 0, passable: 0, unmeasured: 0, missingArchives: [] };
  for (const f of flats) {
    stats.flats++;
    const mode = flatSolidity(f.archive, f.record, f);
    if (!mode) { stats.passable++; continue; }
    const s = await cache.shape(f.archive, f.record, mode);
    if (!s) { stats.unmeasured++; continue; }
    const sx = Math.abs(f.sx ?? 1) || 1, sy = Math.abs(f.sy ?? 1) || 1;
    if (s.top * sy < MIN_TOP) { stats.unmeasured++; continue; }
    out.push(f.x, f.z, f.y, f.y + s.top * sy, s.radius * sx);
    if (mode === 'tree') stats.trees++; else stats.props++;
  }
  stats.missingArchives = [...cache.missing].sort((a, b) => a - b);
  return { cylinders: Float32Array.from(out), stats };
}

/** Concatenate cylinder arrays, translating each by its offset {x, y, z}. */
export function joinCylinders(parts) {
  let n = 0;
  for (const p of parts) n += p.cylinders?.length ?? 0;
  const out = new Float32Array(n);
  let o = 0;
  for (const { cylinders: c, offset = { x: 0, y: 0, z: 0 } } of parts) {
    if (!c) continue;
    for (let i = 0; i + 4 < c.length; i += CYLINDER_STRIDE) {
      out[o++] = c[i] + offset.x; out[o++] = c[i + 1] + offset.z;
      out[o++] = c[i + 2] + offset.y; out[o++] = c[i + 3] + offset.y; out[o++] = c[i + 4];
    }
  }
  return out;
}

/**
 * A town's solid flats, from the same RMB flat layout loadScenery draws (rmbFlats.js layoutTownFlats),
 * in loadTown's output frame. `blocks`: [{x, y, rmb}] where rmb has parseRmbFlats fields (a World of
 * Daggerfall replacement block carries them) or `bytes` the BLOCKS.BSA record to parse.
 */
export async function townFlatColliders(index, blocks, spawnLocal, climateValue, opts = {}) {
  const parsed = [];
  const warnings = [];
  for (const b of blocks) {
    let rmb = b.rmb?.scenery ? b.rmb : null;
    if (!rmb && b.bytes) {
      try { rmb = parseRmbFlats(b.bytes, b.name); } catch (err) { warnings.push(err.message); }
    }
    if (rmb) parsed.push({ x: b.x, y: b.y, rmb });
  }
  const { flats } = layoutTownFlats(parsed, spawnLocal, natureArchiveOf(climateValue));
  const out = await flatCylinders(index, flats, opts);
  if (warnings.length) out.stats.warnings = warnings;
  return out;
}
