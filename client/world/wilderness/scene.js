// buildWildernessScene(): one World of Daggerfall map pixel as a drawable scene, from the player's own ARENA2 files
// and the server's scene descriptor (docs/wilderness-protocol.md). Nothing is bundled and nothing is invented: the
// ground is WOODS.WLD through Daggerfall Unity's sampler and tile rules (terrain.js), the ground tiles are the climate's
// TEXTURE.nnn tileset, and every site object is the exact ARCH3D model, TEXTURE flat or BLOCKS.BSA block the mod names,
// at the transform the descriptor composed from the mod's own files.
//
// Output is the scene-mesh contract of client/world/README.md (flat triangle arrays, one RGBA atlas, CCW fronts) plus:
//   kind: 'wilderness', wilderness: { px, py, datum, climate, sites, heightAt(x, z) }, flats: { billboards, atlas },
//   sky (classic SKYnn.DAT day panorama for the pixel's climate), stats, warnings.
// The frame is the protocol's: right-handed metres, +y up, east +x, north -z, origin at the visited pixel's centre,
// y = 0 at the site ground (terrain.js "Datum").
//
// Site objects: descriptor transforms are final in the scene frame for flat ground. Each site is lifted by its Location
// Loader root height minus the datum (terrain.js Ground.siteLift), which is the one thing the v1 descriptor leaves out.
// Model vertices follow town.js (Unity metres: x*s, -y*s, z*s); modelMatrix() adds the z mirror into the right-handed
// frame, so collision code can share it.
//
// Adapted pieces (MIT): model and block placement and the RMB ground plane follow this repo's town.js / RMBLayout port;
// Location Loader object semantics follow .ref/dfjs-research-03/src/world/worldOfDaggerfall (MIT, (c) 2026 Lattymoy):
// flats ignore rotation and stand on their base, editor markers are never drawn.

import { BsaArchive, NAME_RECORD, NUMBER_RECORD, readBlob } from '../bsa.js';
import { parseRmb, resolveBlockIndex } from '../blocks.js';
import { decodeMesh, patchRecord } from '../arch3d.js';
import { TextureArchive, parsePalette, textureFileName } from '../textures.js';
import { indexFiles, requireFiles } from '../files.js';
import { WorldDataError } from '../errors.js';
import { climateAt, climateSettings, REGION_NAMES } from '../maps.js';
import { applyClimate, emitTexturedPolygon, groundTileCorners, groundTileRecord, SCALE } from '../town.js';
import { townsAround } from '../exterior/locations.js';
import { snapWithWoods } from './coast.js';
import * as terrainModule from './terrain.js';
import { defaultWorldData } from './replacements.js';
import { FlatArchive } from '../scenery/flatTextures.js';
import { packSprites, BILLBOARD_STRIDE } from '../scenery/index.js';
import { parseRmbFlats, layoutTownFlats, EDITOR_ARCHIVE } from '../scenery/rmbFlats.js';
import { flatCylinders } from '../scenery/colliders.js';
import { readDaySky, skyBase, skyFileName, natureArchive as natureArchiveOf, SEASONS, DEFAULT_SKY_FRAME } from '../scenery/sky.js';
import {
  WoodsFile, buildGround, generateSamples, layoutNature, pixelOffset, HDIM, TDIM, TILE_SIZE, HALF_PIXEL, PIXEL_SIZE, HEIGHT_MAX, MAP_WIDTH, MAP_HEIGHT, OCEAN_Y,
} from './terrain.js';

export { WorldDataError };

/** Neighbour ground drawn around the visited pixel, metres beyond its edge (40 tiles). */
export const RING_METRES = 256;
/** Tiles per side of a distant terrain quad. */
const COARSE = 4;
const RMB_DIMENSION = 4096;
const BLOCK_SIZE = RMB_DIMENSION * SCALE;
const ROTATION_DIVISOR = 5.68888888888889;
const PROPS_OFFSET_Y = -4;
const ATLAS_WIDTH = 2048;
const MAX_ATLAS_HEIGHT = 4096;
const ATLAS_PAD = 2;
const MAX_FRAMES = 16;

/** `wilderness:<px>,<py>` -> {px, py}, else null. */
export function parseWildernessLocation(id) {
  const m = /^wilderness:(\d{1,4}),(\d{1,3})$/.exec(String(id ?? ''));
  if (!m) return null;
  const px = Number(m[1]), py = Number(m[2]);
  return px < 1000 && py < 500 ? { px, py } : null;
}
export const wildernessLocation = (px, py) => `wilderness:${px},${py}`;

/** The eight neighbour locations of a pixel that lie on the map. */
export function neighbourLocations(px, py) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const x = px + dx, y = py + dy;
    if (x >= 0 && y >= 0 && x < 1000 && y < 500) out.push(wildernessLocation(x, y));
  }
  return out;
}

class Cancelled extends Error {
  constructor() { super('The wilderness load was cancelled.'); this.name = 'AbortError'; }
}
const check = (signal) => { if (signal?.aborted) throw new Cancelled(); };
// A build runs beside the game loop: give the browser a frame whenever one step has run for 8 ms.
const clock = () => globalThis.performance?.now?.() ?? Date.now();
let lastYield = 0;
async function pause(signal) {
  check(signal);
  if (clock() - lastYield < 8) return;
  await new Promise((r) => setTimeout(r, 0));
  lastYield = clock();
  check(signal);
}

// ------------------------------------------------------------------------------------------------ transforms

/** Column-major rotation matrix of a unit quaternion [x, y, z, w] (right-handed scene frame). */
function quatColumns(q) {
  let [x, y, z, w] = Array.isArray(q) && q.length === 4 ? q.map(Number) : [0, 0, 0, 1];
  const n = Math.hypot(x, y, z, w);
  if (!(n > 0)) { x = 0; y = 0; z = 0; w = 1; } else { x /= n; y /= n; z /= n; w /= n; }
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/**
 * Column-major 4x4 from town.js model metres (Unity, left-handed: x*s, -y*s, z*s) to scene metres:
 * T(position + [0, lift, 0] + offset) * R(rotation) * S(scale) * Mirror(z).
 * @param {{position:number[], rotation?:number[], scale?:number[]}} obj - a descriptor object
 * @param {number} [lift] - the site's ground lift (metres)
 * @param {{x:number, z:number}} [offset] - pixel offset for a neighbour pixel's object
 */
export function modelMatrix(obj, lift = 0, offset = { x: 0, z: 0 }) {
  if (obj.matrix?.length === 16) {
    const m = new Float64Array(obj.matrix);
    m[12] += offset.x;
    m[13] += lift;
    m[14] += offset.z;
    return m;
  }
  const [c0, c1, c2] = quatColumns(obj.rotation);
  const s = Array.isArray(obj.scale) ? obj.scale.map((v) => (Number.isFinite(v) ? v : 1)) : [1, 1, 1];
  const p = obj.position ?? [0, 0, 0];
  return new Float64Array([
    c0[0] * s[0], c0[1] * s[0], c0[2] * s[0], 0,
    c1[0] * s[1], c1[1] * s[1], c1[2] * s[1], 0,
    -c2[0] * s[2], -c2[1] * s[2], -c2[2] * s[2], 0,
    p[0] + offset.x, p[1] + lift, p[2] + offset.z, 1,
  ]);
}
const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

/** Unity-space placements of an RMB block's models, block SW corner at the origin (town.js loadTown). */
function blockModelPlacements(rmb) {
  const yaw = (deg) => { const r = (deg * Math.PI) / 180; return { c: Math.cos(r), s: Math.sin(r) }; };
  const rotY = (m, x, z) => [x * m.c + z * m.s, -x * m.s + z * m.c];
  const out = [];
  for (const sub of rmb.subRecords) {
    const sm = yaw(-sub.yRotation / ROTATION_DIVISOR);
    const sx = sub.xPos * SCALE, sz = (RMB_DIMENSION - sub.zPos) * SCALE;
    for (const m of sub.models) {
      const mm = yaw(-m.yRotation / ROTATION_DIVISOR);
      const mx = m.xPos * SCALE, my = -m.yPos * SCALE, mz = m.zPos * SCALE;
      out.push({ modelId: m.modelId, place: (x, y, z) => { const [ax, az] = rotY(mm, x, z); const [bx, bz] = rotY(sm, ax + mx, az + mz); return [sx + bx, y + my, sz + bz]; } });
    }
  }
  for (const m of rmb.misc3d) {
    const mm = yaw(-m.yRotation / ROTATION_DIVISOR);
    const mx = m.xPos * SCALE, my = (-m.yPos + PROPS_OFFSET_Y) * SCALE, mz = (m.zPos + RMB_DIMENSION) * SCALE;
    out.push({ modelId: m.modelId, place: (x, y, z) => { const [ax, az] = rotY(mm, x, z); return [mx + ax, y + my, mz + az]; } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ buffers and atlas

class Grow {
  constructor(n = 1 << 16) { this.a = new Float32Array(n); this.n = 0; }
  push(...v) {
    if (this.n + v.length > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length)); b.set(this.a); this.a = b; }
    for (const x of v) this.a[this.n++] = x;
  }
  done() { return this.a.slice(0, this.n); }
}

/** Shelf-pack palette-indexed textures into one RGBA atlas (town.js buildAtlas, wrap padding). */
async function packAtlas(images, palette, signal) {
  const order = images.map((_, i) => i).sort((a, b) => images[b].height - images[a].height || images[b].width - images[a].width);
  let x = 0, y = 0, shelf = 0;
  const place = new Array(images.length);
  for (const i of order) {
    const w = images[i].width + ATLAS_PAD * 2, h = images[i].height + ATLAS_PAD * 2;
    if (x + w > ATLAS_WIDTH) { x = 0; y += shelf; shelf = 0; }
    place[i] = { x, y };
    x += w;
    shelf = Math.max(shelf, h);
  }
  let height = 1;
  while (height < y + shelf) height *= 2;
  if (height > MAX_ATLAS_HEIGHT) throw new WorldDataError(`the wilderness texture atlas would be ${height} pixels tall`);
  const width = ATLAS_WIDTH;
  const pixels = new Uint8Array(width * height * 4);
  const rects = new Map();
  for (let i = 0; i < images.length; i++) {
    await pause(signal);
    const img = images[i];
    const { width: w, height: h, data, key, rgba, tint } = img;
    const { x: px, y: py } = place[i];
    for (let yy = -ATLAS_PAD; yy < h + ATLAS_PAD; yy++) {
      const sy = ((yy % h) + h) % h;
      for (let xx = -ATLAS_PAD; xx < w + ATLAS_PAD; xx++) {
        const sx = ((xx % w) + w) % w;
        const o = ((py + ATLAS_PAD + yy) * width + (px + ATLAS_PAD + xx)) * 4;
        if (rgba) {
          const s = (sy * w + sx) * 4;
          pixels[o] = (rgba[s] * (tint?.[0] ?? 255)) / 255;
          pixels[o + 1] = (rgba[s + 1] * (tint?.[1] ?? 255)) / 255;
          pixels[o + 2] = (rgba[s + 2] * (tint?.[2] ?? 255)) / 255;
          pixels[o + 3] = rgba[s + 3] < 128 ? 0 : 255;
          continue;
        }
        const idx = data[sy * w + sx];
        pixels[o] = palette[idx * 3];
        pixels[o + 1] = palette[idx * 3 + 1];
        pixels[o + 2] = palette[idx * 3 + 2];
        pixels[o + 3] = !key.opaque && idx === 0 ? 0 : 255;
      }
    }
    rects.set(key.id, { u0: (px + ATLAS_PAD) / width, v0: (py + ATLAS_PAD) / height, du: w / width, dv: h / height, width: w, height: h });
  }
  return { atlas: { width, height, pixels }, rects };
}

/** Largest side of a mod (PNG) texture in the atlas. */
export const PACK_TEXTURE_MAX = 512;

/** Box-filter an RGBA image down so neither side exceeds `max` (power-of-two steps keep repeats seamless). */
export function shrinkRgba(tex, max) {
  let { width: w, height: h, rgba } = tex;
  while (w > max || h > max) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy);
            sum += rgba[(sy * w + sx) * 4 + c];
          }
          out[(y * nw + x) * 4 + c] = sum / 4;
        }
      }
    }
    w = nw; h = nh; rgba = out;
  }
  return { width: w, height: h, rgba };
}

/** Billboards with each flat's own scale (LoadStaticObject multiplies the billboard size by scale.x / scale.y). */
function buildBillboards(placed, rects) {
  const out = new Float32Array(placed.length * 6 * BILLBOARD_STRIDE);
  let o = 0;
  placed.forEach((f, i) => {
    const r = rects.get(f.key);
    const hw = (r.size.width * (f.sx ?? 1)) / 2, h = r.size.height * (f.sy ?? 1);
    const phase = r.frames > 1 ? (Math.imul(i + 1, 2654435761) >>> 0) % r.frames : 0;
    for (const [cx, cy, s, t] of [[-hw, 0, 0, 1], [hw, 0, 1, 1], [hw, h, 1, 0], [-hw, 0, 0, 1], [hw, h, 1, 0], [-hw, h, 0, 0]]) {
      out[o++] = f.x; out[o++] = f.y; out[o++] = f.z;
      out[o++] = cx; out[o++] = cy;
      out[o++] = r.u0 + s * r.du; out[o++] = r.v0 + t * r.dv;
      out[o++] = r.frames; out[o++] = r.stride; out[o++] = phase;
    }
  });
  return { vertices: out, count: placed.length * 6, flats: placed.length };
}

// ------------------------------------------------------------------------------------------------ file access

const woodsCache = new WeakMap(); // File -> Promise<WoodsFile>
function openWoods(file) {
  let p = woodsCache.get(file);
  if (!p) {
    p = WoodsFile.open((o, n) => readBlob(file, o, n), file.size);
    p.catch(() => woodsCache.delete(file));
    woodsCache.set(file, p);
  }
  return p;
}

// ------------------------------------------------------------------------------------------------ the scene

// Only terrain is streamed beyond the neighbouring gameplay cells. Sample the same
// WOODS field sparsely. Along the shared edge, keep the inner terrain's vertex spacing
// and copy its flattened elevations so a coast or a site cannot leave a crack.
async function horizonPixels(woods, ground, signal) {
  const pixels = [];
  for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) continue;
    const px = ground.px + dx, py = ground.py + dz;
    if (px < 0 || py < 0 || px >= MAP_WIDTH || py >= MAP_HEIGHT) continue;
    pixels.push({ px, py, dx, dz });
  }
  await woods.prefetch(pixels);
  const edge = HALF_PIXEL + PIXEL_SIZE;
  for (const p of pixels) {
    await pause(signal);
    p.stepX = Math.abs(p.dx) <= 1 ? COARSE : 16;
    p.stepY = Math.abs(p.dz) <= 1 ? COARSE : 16;
    p.samples = generateSamples(woods, p.px, p.py, p.stepX, p.stepY);
    p.rows = TDIM / p.stepY + 1;
    const cols = TDIM / p.stepX + 1;
    for (let i = 0; i < cols; i++) for (let j = 0; j < p.rows; j++) {
      const x = (p.dx - 0.5) * PIXEL_SIZE + i * p.stepX * TILE_SIZE;
      const z = (p.dz + 0.5) * PIXEL_SIZE - j * p.stepY * TILE_SIZE;
      if (Math.max(Math.abs(x), Math.abs(z)) > edge + 0.001) continue;
      const inset = v => Math.max(-edge + 0.0001, Math.min(edge - 0.0001, v));
      const h = ground.absoluteHeightAt(inset(x), inset(z));
      if (h !== null) p.samples[i * p.rows + j] = h / HEIGHT_MAX;
    }
  }
  return pixels;
}

/**
 * @param {object} o
 * @param {Iterable<File>} o.files - the player's ARENA2 files
 * @param {object|null} o.descriptor - GET /api/wilderness/scene result for the visited pixel, or null (no WoD site)
 * @param {string} [o.location] - `wilderness:<px>,<py>` (required when descriptor is null)
 * @param {Map<string, object>} [o.neighbours] - `${px},${py}` -> descriptor of a neighbouring pixel
 * @param {{aborted:boolean}} [o.signal] - cancels between steps (AbortError)
 * @param {object} [o.models] - optional client/world/wilderness/models.js namespace (scale-aware rock UVs)
 * @param {boolean} [o.geometryOnly] - return ground and solid triangles for server collision
 * @param {boolean} [o.vertexColors] - return a colour per vertex (default), or a single uniformColor for the renderer
 * @param {boolean} [o.nature] - DFU nature flats on the terrain (default true)
 * @param {string} [o.season] - sky season (default summer)
 * @param {boolean} [o.winter] - winter ground, nature and building textures (client/world/exterior/season.js)
 * @param {number} [o.skyIndex] - SKYnn.DAT to draw instead of the season's (weather skies)
 */
export async function buildWildernessScene(o) {
  const { files, descriptor = null, neighbours = new Map(), signal = null, models = null } = o;
  const where = descriptor ? { px: descriptor.px, py: descriptor.py } : parseWildernessLocation(o.location);
  if (!where || !Number.isInteger(where.px) || !Number.isInteger(where.py)) throw new WorldDataError(`not a wilderness location: ${o.location ?? descriptor?.id}`);
  const { px, py } = where;
  const location = wildernessLocation(px, py);
  const warnings = [];
  const index = indexFiles(files);
  const [woodsF, climateF, palF] = requireFiles(index, ['WOODS.WLD', 'CLIMATE.PAK', 'ART_PAL.COL']);
  const palette = parsePalette(await readBlob(palF, 0, palF.size), 'ART_PAL.COL');
  const pak = await readBlob(climateF, 0, climateF.size);
  await pause(signal);

  // --- sites by pixel (the visited pixel and any neighbour descriptors) ---
  const sitesByPixel = new Map();
  const descriptors = new Map();
  if (descriptor) descriptors.set(`${px},${py}`, descriptor);
  for (const [k, d] of neighbours) if (d && Array.isArray(d.sites) && !descriptors.has(k)) descriptors.set(k, d);

  // --- ground ---
  let woods;
  try {
    woods = await openWoods(woodsF);
  } catch (err) {
    throw new WorldDataError(`WOODS.WLD could not be read: ${err.message}`);
  }
  await pause(signal);
  // Sea-level (type 2) sites move to their coast as Location Loader's FindNearestCoast does (coast.js).
  const coast = await snapWithWoods(woods, terrainModule, descriptors);
  for (const [k, d] of coast.descriptors) descriptors.set(k, d);
  for (const r of coast.report) if (!r.snapped) warnings.push(`${r.id}: no coast within its pixel; the sea-level site stays at its authored tile.`);
  for (const [k, d] of descriptors) {
    // Sites that overlap another pixel already appear in that pixel's descriptor.
    // Sample each site's root on the pixel that owns its tile coordinates.
    sitesByPixel.set(k, d.sites.filter(s => !s.pixel || s.pixel.join(',') === k));
  }
  const spawn = descriptor?.spawn ?? { x: 0, y: 0, z: 0, yaw: 0 };
  const worldData = o.worldData === undefined ? defaultWorldData(files) : o.worldData;
  const towns = await townsAround(index.get('MAPS.BSA'), worldData, px, py);
  const ground = await buildGround(woods, { px, py, sitesByPixel, towns, ring: 1, spawn, yieldWork: () => pause(signal) });
  await pause(signal);

  const climateOf = (x, y) => climateAt(pak, x * 128 + 64, (499 - y) * 128 + 64);
  const pixelClimate = new Map();
  for (const p of ground.pixels.values()) {
    const value = climateOf(p.px, p.py);
    const climate = climateSettings(value);
    const groundArchive = applyClimate(climate.groundArchive, 0, climate.groundArchive - 2, o.winter);
    const nature = applyClimate(natureArchiveOf(value), 0, climate.climateBase, o.winter);
    pixelClimate.set(p.key, { value, ...climate, groundArchive, nature });
  }
  const centreClimate = pixelClimate.get(`${px},${py}`);

  // --- placed objects ---
  const keyMap = new Map();
  const keyFor = (archive, record, opaque) => {
    const id = `${opaque ? 'g' : 'm'}${archive}:${record}`;
    if (!keyMap.has(id)) keyMap.set(id, { id, archive, record, opaque });
    return id;
  };
  const modelUses = []; // { modelId, matrix, climateBase|null, site }
  const flatUses = []; // { archive, record, x, y, z, sx, sy, kind, site }
  const blockUses = []; // { name, matrix, climate, groundPlane, site }
  const assetUses = []; // { name, matrix, site } - the mod's own Unity prefabs (type 4), drawn when loadAsset can supply them
  const drawnSites = [];
  const seenSites = new Set();
  const unsupported = new Map();
  const near = (x, z) => Math.abs(x) <= HALF_PIXEL + RING_METRES && Math.abs(z) <= HALF_PIXEL + RING_METRES;
  const inBuilt = (x, z) => Math.abs(x) <= HALF_PIXEL + PIXEL_SIZE && Math.abs(z) <= HALF_PIXEL + PIXEL_SIZE;
  for (const [k, d] of descriptors) {
    const [dpx, dpy] = k.split(',').map(Number);
    const off = pixelOffset(dpx, dpy, px, py);
    const climate = pixelClimate.get(k) ?? centreClimate;
    for (const site of d.sites ?? []) {
      const lift = ground.siteLift(site.id) ?? 0;
      const a = site.anchor ?? [0, 0, 0];
      if (!inBuilt(a[0] + off.x, a[2] + off.z)) continue;
      if (seenSites.has(site.id)) continue;
      seenSites.add(site.id);
      let drawn = 0;
      for (const obj of site.objects ?? []) {
        if (!Array.isArray(obj.position)) continue;
        if (obj.kind === 'model' && Number.isInteger(obj.model)) {
          modelUses.push({ modelId: obj.model, matrix: modelMatrix(obj, lift, off), site: site.id });
          drawn++;
        } else if (obj.kind === 'flat' && Number.isInteger(obj.archive) && Number.isInteger(obj.record)) {
          if (obj.archive === EDITOR_ARCHIVE) continue;
          const sc = Array.isArray(obj.scale) ? obj.scale : [1, 1, 1];
          flatUses.push({ archive: obj.archive, record: obj.record, x: obj.position[0] + off.x, y: obj.position[1] + lift, z: obj.position[2] + off.z, sx: sc[0] ?? 1, sy: sc[1] ?? 1, kind: obj.loot ? 'loot' : obj.light ? 'light' : 'flat', site: site.id });
          drawn++;
        } else if (obj.kind === 'block' && typeof obj.block === 'string') {
          blockUses.push({ name: obj.block, matrix: modelMatrix(obj, lift, off), climate, groundPlane: obj.groundPlane === true, site: site.id, obj, lift, off });
          drawn++;
        } else if ((obj.kind === 'asset' || obj.kind === 'prefab') && typeof (obj.asset ?? obj.name) === 'string') {
          assetUses.push({ name: obj.asset ?? obj.name, matrix: modelMatrix(obj, lift, off), site: site.id, pixel: k, region: site.region ?? d.region ?? '' });
        } else {
          const what = obj.asset ?? obj.kind;
          unsupported.set(what, (unsupported.get(what) ?? 0) + 1);
        }
      }
      drawnSites.push({ id: site.id, name: site.name, kind: site.kind, prefab: site.prefab, instanceType: site.instanceType, pixel: k, lift, objects: drawn });
    }
  }
  if (unsupported.size) {
    warnings.push(`Not drawn (unknown object kind): ${[...unsupported].map(([n, c]) => `${n} x${c}`).join(', ')}.`);
  }

  // --- the mod's custom prefabs (type 4): loadAsset(name, {climate, region, winter}) supplies the converted mesh
  // with its materials resolved for this climate (client/world/wilderness/localPack.js in the browser, the pack
  // reader on the server); models.js turns it into textured groups or collision triangles. ---
  const assetGroups = []; // customPieceTriangles groups, each with an atlas key
  const assetCollision = []; // geometryOnly: Float32-ready triangle lists
  const packTextures = new Map(); // atlas id -> { path, color }
  const assetCache = new Map(); // `${name}|${climate}` -> custom prefab | null
  const M = models;
  if (assetUses.length && typeof o.loadAsset === 'function' && typeof M?.customPieceTriangles === 'function') {
    for (const a of assetUses) {
      const cl = pixelClimate.get(a.pixel) ?? centreClimate;
      const ck = `${a.name}|${cl.value}|${a.region}`;
      if (!assetCache.has(ck)) {
        let m = null;
        try {
          m = await o.loadAsset(a.name, { climate: cl.value, region: a.region || descriptor?.region || '', winter: !!o.winter });
          if (m && typeof M.deserializeCustomPrefab === 'function' && !(m.submeshes?.[0]?.positions instanceof Float32Array)) {
            m = { ...M.deserializeCustomPrefab(m), textures: m.textures };
          }
        } catch (err) {
          m = null;
          warnings.push(`custom prefab ${a.name}: ${err.message}`);
        }
        assetCache.set(ck, m);
        await pause(signal);
      }
      const custom = assetCache.get(ck);
      if (!custom) continue;
      a.drawn = true;
      const matrix = typeof M.prefabMatrix === 'function' ? M.prefabMatrix(a.matrix, custom) : a.matrix;
      if (o.geometryOnly) {
        if (typeof M.customCollisionPositions === 'function') assetCollision.push(M.customCollisionPositions(custom, matrix));
        continue;
      }
      const textures = Array.isArray(custom.textures) ? custom.textures : null;
      for (const group of M.customPieceTriangles(custom, matrix, textures).groups ?? []) {
        const t = group.texture;
        if (t?.kind === 'arena2' && Number.isInteger(t.archive) && Number.isInteger(t.record)) {
          group.key = keyFor(t.archive, t.record, false);
        } else if (t?.kind === 'pack' && typeof t.path === 'string') {
          const color = Array.isArray(t.color) ? t.color.slice(0, 3).map((c) => Math.round(Math.min(1, Math.max(0, +c || 0)) * 255)) : [255, 255, 255];
          group.key = `p${t.path}|${color.join(',')}`;
          packTextures.set(group.key, { path: t.path, color });
        } else continue;
        assetGroups.push(group);
      }
    }
  }
  const pendingAssets = assetUses.filter((a) => !a.drawn);
  if (pendingAssets.length) {
    const names = new Map();
    for (const a of pendingAssets) names.set(a.name, (names.get(a.name) ?? 0) + 1);
    warnings.push(`Custom World of Daggerfall prefabs not drawn yet (mod meshes): ${[...names].slice(0, 8).map(([n, c]) => `${n} x${c}`).join(', ')}${names.size > 8 ? ', …' : ''}.`);
  }

  // --- blocks: expand into model and flat uses ---
  if (blockUses.length) {
    const blocksF = index.get('BLOCKS.BSA');
    if (!blocksF) throw new WorldDataError('BLOCKS.BSA is missing from the selected Daggerfall data (needed by a World of Daggerfall farm or block)');
    const bsa = await BsaArchive.open(blocksF, 'BLOCKS.BSA', NAME_RECORD);
    // The pack's WorldData/*.RMB.json replaces a BLOCKS.BSA block (client/world/wilderness/replacements.js, when
    // that module is present): resolveRmbBlock -> {index, name, block}; block carries parseRmb's and parseRmbFlats'
    // fields, else BSA record `index` is parsed here. rmbBlockPlacements adds WorldData's X/Z rotation and scale.
    let rep = o.replacements ?? null;
    if (rep === null) { try { rep = await import('./replacements.js'); } catch { rep = false; } }
    for (const b of blockUses) {
      let rmb = null, flatsRmb = null;
      let r = null;
      if (rep && typeof rep.resolveRmbBlock === 'function') {
        try { r = await rep.resolveRmbBlock(bsa, b.name, worldData); } catch (err) { warnings.push(`block ${b.name} replacement: ${err.message}`); }
      }
      if (!r) { const i = resolveBlockIndex(bsa, b.name); r = { index: i, name: i >= 0 ? bsa.entries[i].name : b.name, block: null }; }
      if (r.index < 0 && !r.block) { warnings.push(`BLOCKS.BSA: block ${b.name} is missing; not drawn.`); continue; }
      const bytes = r.block ? null : await bsa.read(r.index);
      rmb = r.block ?? parseRmb(bytes, r.name);
      flatsRmb = r.block ?? parseRmbFlats(bytes, r.name);
      b.replaced = !!r.block;
      for (const pl of (rep && typeof rep.rmbBlockPlacements === 'function' ? rep.rmbBlockPlacements(rmb) : blockModelPlacements(rmb))) {
        // Compose: block-local Unity metres -> object Unity frame (mirror handled by b.matrix).
        modelUses.push({ modelId: pl.modelId, matrix: b.matrix, place: pl.place, climateBase: b.climate.climateBase, site: b.site });
      }
      b.rmb = rmb;
      if (!flatsRmb) continue; // flats also feed the solid-flat colliders in geometryOnly
      const flats = layoutTownFlats([{ x: 0, y: 0, rmb: flatsRmb }], { x: 0, z: 0 }, b.climate.nature);
      for (const f of flats.flats) {
        // layoutTownFlats output is block-local right-handed (x, y, -uz); undo the mirror and use the object matrix.
        const [x, y, z] = apply(b.matrix, f.x, f.y, -f.z);
        flatUses.push({ archive: f.archive, record: f.record, x, y, z, sx: 1, sy: 1, kind: f.kind, site: b.site });
      }
    }
    await pause(signal);
  }

  // --- meshes ---
  const meshes = new Map();
  if (modelUses.length) {
    const archF = index.get('ARCH3D.BSA');
    if (!archF) throw new WorldDataError('ARCH3D.BSA is missing from the selected Daggerfall data');
    const arch = await BsaArchive.open(archF, 'ARCH3D.BSA', NUMBER_RECORD);
    for (const u of modelUses) {
      if (meshes.has(u.modelId)) continue;
      const k = arch.indexOfId(u.modelId);
      if (k < 0) { meshes.set(u.modelId, null); warnings.push(`ARCH3D.BSA: model ${u.modelId} is missing; not drawn.`); continue; }
      const bytes = await arch.read(k);
      patchRecord(bytes, arch.entries[k].position);
      meshes.set(u.modelId, decodeMesh(bytes, u.modelId));
    }
    await pause(signal);
  }
  for (const u of modelUses) {
    const mesh = meshes.get(u.modelId);
    if (!mesh) continue;
    u.keys = mesh.planes.map((p) => {
      let archive = u.climateBase !== undefined ? applyClimate(p.archive, p.record, u.climateBase, o.winter) : p.archive;
      if (archive !== p.archive && !index.has(textureFileName(archive))) archive = p.archive;
      return keyFor(archive, p.record, false);
    });
  }

  // --- terrain tiles: full 6.4 m tiles within RING_METRES of the visited pixel, then the rest of the 3x3 pixels as
  // 25.6 m quads (4x4 tiles, the block's first tile texture) out to ~1.2 km, so distant sites stand on ground. ---
  const terrainTiles = [];
  for (const p of ground.pixels.values()) {
    const ga = pixelClimate.get(p.key).groundArchive;
    for (let by = 0; by < TDIM; by += COARSE) {
      for (let bx = 0; bx < TDIM; bx += COARSE) {
        const bx0 = p.offset.x - HALF_PIXEL + bx * TILE_SIZE, bz0 = p.offset.z + HALF_PIXEL - by * TILE_SIZE;
        const span = COARSE * TILE_SIZE;
        // Fine when any part of the block reaches into the near square.
        const fine = Math.min(Math.abs(bx0), Math.abs(bx0 + span)) <= HALF_PIXEL + RING_METRES && Math.min(Math.abs(bz0), Math.abs(bz0 - span)) <= HALF_PIXEL + RING_METRES;
        if (!fine) {
          const bits = p.tilemap[bx + by * TDIM];
          terrainTiles.push({ p, tx: bx, ty: by, x0: bx0, z0: bz0, bits, step: COARSE, key: keyFor(ga, groundTileRecord(bits), true) });
          continue;
        }
        for (let ty = by; ty < by + COARSE; ty++) {
          for (let tx = bx; tx < bx + COARSE; tx++) {
            const x0 = p.offset.x - HALF_PIXEL + tx * TILE_SIZE, z0 = p.offset.z + HALF_PIXEL - ty * TILE_SIZE;
            const bits = p.tilemap[tx + ty * TDIM];
            terrainTiles.push({ p, tx, ty, x0, z0, bits, step: 1, key: keyFor(ga, groundTileRecord(bits), true) });
          }
        }
      }
    }
  }
  for (const b of blockUses) {
    if (!b.rmb || !b.groundPlane) continue;
    for (const bits of b.rmb.groundTiles) keyFor(b.climate.groundArchive, groundTileRecord(bits), true);
  }

  const horizon = o.geometryOnly ? [] : await horizonPixels(woods, ground, signal);
  for (const p of horizon) {
    const archive = climateSettings(climateOf(p.px, p.py)).groundArchive;
    const tiles = applyClimate(archive, 0, archive - 2, o.winter);
    p.water = keyFor(tiles, 0, true);
    p.land = keyFor(tiles, 2, true);
  }

  // --- atlas ---
  const archives = new Map();
  const images = [];
  for (const key of o.geometryOnly ? [] : keyMap.values()) {
    let ta = archives.get(key.archive);
    if (ta === undefined) {
      const f = index.get(textureFileName(key.archive));
      ta = f ? new TextureArchive(new Uint8Array(await f.arrayBuffer()), key.archive) : null;
      if (!f) warnings.push(`${textureFileName(key.archive)} is missing; its surfaces are untextured.`);
      archives.set(key.archive, ta);
    }
    let img;
    try {
      img = ta ? ta.decode(key.record) : null;
    } catch (err) {
      if (!(err instanceof WorldDataError)) throw err;
      warnings.push(err.message);
    }
    images.push({ key, ...(img ?? { width: 1, height: 1, data: new Uint8Array([key.opaque ? 1 : 0]) }) });
  }
  // The mod's own textures (PNG, up to 4096 px) enter the atlas box-filtered to PACK_TEXTURE_MAX, tinted by the
  // material colour as Unity's standard shader multiplies it.
  if (!o.geometryOnly && packTextures.size) {
    const loaded = new Map();
    for (const [id, t] of packTextures) {
      let tex = loaded.get(t.path);
      if (tex === undefined) {
        tex = null;
        if (typeof o.loadTexture === 'function') {
          try { tex = await o.loadTexture(t.path); } catch (err) { warnings.push(`texture ${t.path}: ${err.message}`); }
        }
        if (tex && !(tex.width > 0 && tex.height > 0 && tex.rgba?.length >= tex.width * tex.height * 4)) tex = null;
        if (tex) tex = shrinkRgba(tex, PACK_TEXTURE_MAX);
        loaded.set(t.path, tex);
        await pause(signal);
      }
      if (!tex) { warnings.push(`${t.path}: the mod texture could not be read; those surfaces are not drawn.`); continue; }
      images.push({ key: { id, opaque: false }, width: tex.width, height: tex.height, rgba: tex.rgba, tint: t.color });
    }
  }
  await pause(signal);
  const { atlas, rects } = o.geometryOnly ? { atlas: null, rects: null } : await packAtlas(images, palette, signal);
  const unitRect = { u0: 0, v0: 0, du: 1, dv: 1, width: 1, height: 1 };
  const rectFor = (id) => o.geometryOnly ? unitRect : rects.get(id);

  // --- emit triangles ---
  const pos = new Grow(1 << 20), uvs = new Grow(1 << 19);
  const sink = {
    tri(a, b, c, ua, ub, uc) {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      if (!o.geometryOnly) uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    },
  };
  const datum = ground.datum;
  let emitted = 0;
  for (const t of terrainTiles) {
    if ((++emitted & 2047) === 0) await pause(signal);
    const s = t.p.samples;
    const h = (x, y) => s[y + x * HDIM] * HEIGHT_MAX - datum;
    const r = rectFor(t.key);
    const c = groundTileCorners(t.bits).map(([u, v]) => [r.u0 + u * r.du, r.v0 + v * r.dv]);
    const d = t.step ?? 1;
    const x1 = t.x0 + TILE_SIZE * d, z1 = t.z0 - TILE_SIZE * d;
    const sw = [t.x0, h(t.tx, t.ty), t.z0], se = [x1, h(t.tx + d, t.ty), t.z0];
    const ne = [x1, h(t.tx + d, t.ty + d), z1], nw = [t.x0, h(t.tx, t.ty + d), z1];
    sink.tri(sw, se, ne, c[0], c[1], c[2]);
    sink.tri(sw, ne, nw, c[0], c[2], c[3]);
  }
  for (const p of horizon) {
    await pause(signal);
    const vertex = (i, j) => [
      (p.dx - 0.5) * PIXEL_SIZE + i * p.stepX * TILE_SIZE,
      p.samples[i * p.rows + j] * HEIGHT_MAX - datum,
      (p.dz + 0.5) * PIXEL_SIZE - j * p.stepY * TILE_SIZE,
    ];
    for (let i = 0; i < TDIM / p.stepX; i++) for (let j = 0; j < p.rows - 1; j++) {
      const sw = vertex(i, j), se = vertex(i + 1, j), ne = vertex(i + 1, j + 1), nw = vertex(i, j + 1);
      const water = Math.max(sw[1], se[1], ne[1], nw[1]) + datum <= OCEAN_Y + 0.001;
      const r = rectFor(water ? p.water : p.land);
      const uv = groundTileCorners(0).map(([u, v]) => [r.u0 + u * r.du, r.v0 + v * r.dv]);
      sink.tri(sw, se, ne, uv[0], uv[1], uv[2]);
      sink.tri(sw, ne, nw, uv[0], uv[2], uv[3]);
    }
  }
  const groundTriangles = pos.n / 9;

  // RMB ground planes of blocks (LL groundPlane), 2.5 cm under the block's own floor (DFU GroundOffset).
  for (const b of blockUses) {
    if (!b.rmb || !b.groundPlane) continue;
    for (let tz = 0; tz < 16; tz++) {
      for (let tx = 0; tx < 16; tx++) {
        const bits = b.rmb.groundTiles[(15 - tz) * 16 + tx];
        const r = rectFor(`g${b.climate.groundArchive}:${groundTileRecord(bits)}`);
        const c = groundTileCorners(bits).map(([u, v]) => [r.u0 + u * r.du, r.v0 + v * r.dv]);
        const ux0 = tx * TILE_SIZE, uz0 = tz * TILE_SIZE, y = -SCALE;
        const P = (ux, uz) => apply(b.matrix, ux, y, uz);
        const sw = P(ux0, uz0), se = P(ux0 + TILE_SIZE, uz0), ne = P(ux0 + TILE_SIZE, uz0 + TILE_SIZE), nw = P(ux0, uz0 + TILE_SIZE);
        sink.tri(sw, se, ne, c[0], c[1], c[2]);
        sink.tri(sw, ne, nw, c[0], c[2], c[3]);
      }
    }
  }

  let unfolded = 0;
  const metresOf = (mesh) => mesh.planes.map((pl) => ({ ...pl, points: pl.points.map((q) => ({ x: q.x * SCALE, y: -q.y * SCALE, z: q.z * SCALE, u: q.u, v: q.v })) }));
  const metresCache = new Map();
  for (const u of modelUses) {
    if ((++emitted & 63) === 0) await pause(signal);
    const mesh = meshes.get(u.modelId);
    if (!mesh) continue;
    let planes = metresCache.get(u.modelId);
    if (!planes) metresCache.set(u.modelId, (planes = metresOf(mesh)));
    const unfold = !o.geometryOnly && !u.place && models?.needsUnfold && models?.unfoldPlaneUvs ? !!models.needsUnfold(u.modelId, u.matrix) : false;
    for (let i = 0; i < planes.length; i++) {
      if ((i & 15) === 0) await pause(signal);
      const pl = planes[i];
      const r = rectFor(u.keys[i]);
      let texels = null;
      if (unfold) {
        try {
          texels = models.unfoldPlaneUvs(pl, u.matrix, { texW: r.width, texH: r.height });
        } catch (err) {
          texels = null;
          warnings.push(`rock UVs: ${err.message}`);
        }
      }
      const poly = pl.points.map((q, k) => {
        const local = u.place ? u.place(q.x, q.y, q.z) : [q.x, q.y, q.z];
        const uv = texels?.[k] ?? q;
        return { p: apply(u.matrix, local[0], local[1], local[2]), s: uv.u / r.width, t: uv.v / r.height };
      });
      if (o.geometryOnly) {
        // Texture wrapping subdivides a face without changing its surface.
        for (let k = 2; k < poly.length; k++) sink.tri(poly[0].p, poly[k - 1].p, poly[k].p);
        continue;
      }
      try {
        emitTexturedPolygon(sink, poly, r);
      } catch (err) {
        if (!(err instanceof WorldDataError)) throw err;
        warnings.push(`model ${u.modelId}: ${err.message}`);
      }
    }
    if (unfold) unfolded++;
  }
  const modelEnd = pos.n / 9;
  let assetTriangles = 0;
  for (const g of assetGroups) {
    const r = g.key ? rects.get(g.key) : null;
    if (!r) continue; // texture unreadable: warned above, the surface is not drawn
    const P = g.positions, U = g.uvs;
    for (let triangle = 0; triangle < Math.floor(P.length / 9); triangle++) {
      if ((triangle & 63) === 0) await pause(signal);
      const i = triangle * 9, j = triangle * 6;
      const poly = [0, 1, 2].map((k) => ({ p: [P[i + k * 3], P[i + k * 3 + 1], P[i + k * 3 + 2]], s: U[j + k * 2], t: U[j + k * 2 + 1] }));
      try { emitTexturedPolygon(sink, poly, r); } catch (err) { if (!(err instanceof WorldDataError)) throw err; }
    }
  }
  for (const list of assetCollision) {
    for (let i = 0; i + 8 < list.length; i += 9) {
      sink.tri([list[i], list[i + 1], list[i + 2]], [list[i + 3], list[i + 4], list[i + 5]], [list[i + 6], list[i + 7], list[i + 8]]);
    }
  }
  assetTriangles = pos.n / 9 - modelEnd;
  await pause(signal);

  // --- flats: site flats + DFU nature on the terrain (drawn, and solid ones collide) ---
  const natureFlats = [];
  if (o.nature !== false) {
    for (const p of ground.pixels.values()) {
      await pause(signal);
      const cl = pixelClimate.get(p.key);
      for (const n of layoutNature(ground, p, cl.value)) {
        if (!near(n.x, n.z)) continue;
        natureFlats.push({ archive: cl.nature, record: n.record, x: n.x, y: n.y, z: n.z, sx: 1, sy: 1, kind: 'nature' });
      }
    }
  }
  const allFlats = [...flatUses, ...natureFlats];
  const colliders = await flatCylinders(index, allFlats);
  await pause(signal);

  if (o.geometryOnly) return {
    kind: 'wilderness',
    colliders,
    name: location,
    positions: pos.done(),
    ground: { included: true, firstTriangle: 0, triangleCount: groundTriangles },
    // The exterior frame contract (client/world/exterior/frame.js) shared with the browser scene.
    wilderness: {
      px, py, datum,
      towns: [...ground.pixels.values()].map(p => p.town).filter(Boolean),
      pixels: [...ground.pixels.keys()],
      absoluteHeightAt: (x, z) => ground.absoluteHeightAt(x, z),
      heightAt: (x, z) => ground.heightAt(x, z),
      sites: drawnSites,
      coast: coast.report.map((r) => ({ id: r.id, snapped: r.snapped, start: r.start, tile: [r.tx, r.ty], moved: [r.dtx, r.dty] })),
    },
    warnings,
  };

  const sprites = new Map();
  const flatArchives = new Map();
  const placed = [];
  for (const f of allFlats) {
    const key = `${f.archive}:${f.record}`;
    if (!sprites.has(key)) {
      let fa = flatArchives.get(f.archive);
      if (fa === undefined) {
        const file = index.get(textureFileName(f.archive));
        fa = null;
        if (file) {
          try { fa = new FlatArchive(new Uint8Array(await file.arrayBuffer()), f.archive); } catch (err) { if (!(err instanceof WorldDataError)) throw err; warnings.push(err.message); }
        } else warnings.push(`${textureFileName(f.archive)} is missing; its flats are not drawn.`);
        flatArchives.set(f.archive, fa);
      }
      let sprite = null;
      if (fa) {
        try {
          const n = Math.min(fa.frameCount(f.record), MAX_FRAMES);
          const frames = [];
          for (let k = 0; k < n; k++) frames.push(fa.decode(f.record, k));
          sprite = { key, size: fa.size(f.record), frames };
        } catch (err) {
          if (!(err instanceof WorldDataError)) throw err;
          warnings.push(err.message);
        }
      }
      sprites.set(key, sprite);
    }
    if (sprites.get(key)) placed.push({ ...f, key });
  }
  await pause(signal);
  const packed = placed.length ? packSprites([...sprites.values()].filter(Boolean), palette) : null;
  const flats = packed ? { billboards: buildBillboards(placed, packed.rects), atlas: packed.atlas } : null;

  // --- sky ---
  let sky = null;
  const skyIndex = Number.isInteger(o.skyIndex) ? o.skyIndex : skyBase(centreClimate.value) + (SEASONS[o.season ?? 'summer'] ?? SEASONS.summer);
  const skyName = skyFileName(skyIndex);
  const skyF = index.get(skyName);
  if (skyF) {
    try {
      sky = { ...(await readDaySky((a, n) => readBlob(skyF, a, n), skyF.size, DEFAULT_SKY_FRAME, skyName)), index: skyIndex, file: skyName };
    } catch (err) {
      if (!(err instanceof WorldDataError)) throw err;
      warnings.push(err.message);
    }
  } else warnings.push(`${skyName} is missing; the default sky is kept.`);
  await pause(signal);

  // --- assemble ---
  const positions = pos.done();
  const uv = uvs.done();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const triangles = positions.length / 9;
  const spawnY = ground.heightAt(spawn.x ?? 0, spawn.z ?? 0) ?? 0;
  const regionIndex = Number.isInteger(descriptor?.regionIndex) ? descriptor.regionIndex : null;
  const firstSite = drawnSites.find((s) => s.pixel === `${px},${py}`);
  const name = firstSite?.name ?? `Wilderness ${px},${py}`;
  return {
    kind: 'wilderness',
    name,
    region: descriptor?.region ?? (regionIndex !== null ? REGION_NAMES[regionIndex] : null) ?? '',
    location,
    positions,
    ...(o.vertexColors === false ? { uniformColor: [1, 1, 1] } : { colors: new Float32Array(positions.length).fill(1) }),
    uv,
    atlas,
    uvConvention: 'atlas-v-down',
    frontFace: 'ccw',
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    spawn: { x: spawn.x ?? 0, y: Math.max(spawn.y ?? 0, spawnY), z: spawn.z ?? 0, yaw: spawn.yaw ?? 0, forward: [Math.sin(spawn.yaw ?? 0), 0, -Math.cos(spawn.yaw ?? 0)] },
    ground: { included: true, firstTriangle: 0, triangleCount: groundTriangles, walkTriangleCount: terrainTiles.length * 2, walkY: 0 },
    wilderness: {
      px, py, datum,
      towns: [...ground.pixels.values()].map(p => p.town).filter(Boolean),
      absoluteHeightAt: (x, z) => ground.absoluteHeightAt(x, z),
      climate: { value: centreClimate.value, label: centreClimate.label, groundArchive: centreClimate.groundArchive, natureArchive: centreClimate.nature },
      sites: drawnSites,
      coast: coast.report.map((r) => ({ id: r.id, snapped: r.snapped, start: r.start, tile: [r.tx, r.ty], moved: [r.dtx, r.dty] })),
      treasure: (descriptor?.sites ?? []).flatMap(site =>
        [...(site.objects ?? []), ...(site.markers ?? [])]
          .filter(obj => obj.loot && Array.isArray(obj.position))
          .map(obj => ({ site: site.id, object: obj.objectID, x: obj.position[0], z: obj.position[2] }))),
      pixels: [...ground.pixels.keys()],
      heightAt: (x, z) => ground.heightAt(x, z),
      descriptor: descriptor ? { v: descriptor.v, id: descriptor.id } : null,
      assets: pendingAssets.map((a) => ({ name: a.name, site: a.site, matrix: Array.from(a.matrix) })),
    },
    flats,
    colliders,
    look: { winter: !!o.winter },
    sky,
    warnings,
    stats: {
      triangles,
      horizonPixels: horizon.length,
      groundTriangles,
      modelTriangles: triangles - groundTriangles,
      modelInstances: modelUses.filter((u) => meshes.get(u.modelId)).length,
      uniqueModels: [...meshes.values()].filter(Boolean).length,
      unfoldedModels: unfolded,
      siteFlats: flatUses.length,
      natureFlats: natureFlats.length,
      drawnFlats: placed.length,
      solidFlats: colliders.stats.trees + colliders.stats.props,
      blocks: blockUses.filter((b) => b.rmb).length,
      assetsDrawn: assetUses.length - pendingAssets.length,
      assetTriangles,
      assetsPending: pendingAssets.length,
      sites: drawnSites.length,
      textures: rects.size,
      atlas: { width: atlas.width, height: atlas.height },
      pixelSpan: PIXEL_SIZE,
    },
  };
}
