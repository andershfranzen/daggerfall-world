// The sea model behind server/rpg/sailing/coast.js: sources, tile water, clearance, harbours and lanes.
// Used on the main thread (sync water and clearance queries, bounded cache) and in ./coast-worker.js (harbour floods
// and routes), so both answer the same water. See coast.js for the sources, frames and the comparison with Daggerfall
// Online.

import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PakMap } from '../../../client/gameplay/travel/catalog.js';
import { join } from 'node:path';
import * as terrain from '../../../client/world/wilderness/terrain.js';
import { tileOrigin } from '../../../client/world/exterior/frame.js';
import { CHART_METRES, TILE_METRES, TILES_PER_PIXEL, FALLBACK_SEA, fallbackRelief, yawOf, headingOf } from '../../../client/world/sea/chart.js';

export const WATER_BYTE = 5;
export const OCEAN_CLIMATE = 223;
export const ROADSTEAD_PX = 3;
export const BERTH_CLEAR_M = 9.6;
export const CHANNEL_CLEAR_M = 12.8;
export const LANE_CLEAR_M = 25.6;
export const CLEAR_CAP_M = 63.75;
export const APPROACH_M = 64;
export const SEA_COMPRESSION = 60;
export const SHIP_MINUTES_PER_PIXEL = 51;
export const LEAGUE_M = 4828;
export const LANE_SEARCH = 400000;
export const LANE_RETRIES = 24;
/** Most harbour-flood tiles expanded per port. */
export const HARBOUR_SEARCH = 400000;
/** How far past the best berth found the flood keeps looking for a nearer one (metres from the town). */
export const BERTH_SEARCH_MARGIN_M = 300;
/** The noise term's most (terrain.js generateSamples: GetNoise * GetNoise * EXTRA_NOISE_SCALE, each noise in [0, 1]). */
const NOISE_MAX = 10;

const T = TILES_PER_PIXEL;
const CAP_TILES = 10;
const Q = 4; // clearance quarter metres in a Uint8
const SAMPLE_STEP = TILE_METRES / 2;
const TAU = Math.PI * 2;
export const wrapYaw = (a) => ((a % TAU) + TAU) % TAU;

// ------------------------------------------------------------------------------------------------ sources

export function arena2Dir(dir) {
  const names = readdirSync(dir);
  if (names.some((n) => /^MAPS\.BSA$/i.test(n))) return dir;
  const sub = names.find((n) => /^arena2$/i.test(n) && statSync(join(dir, n)).isDirectory());
  return sub ? join(dir, sub) : dir;
}
const findFile = (dir, name) => {
  const f = readdirSync(dir).find((n) => n.toUpperCase() === name);
  if (!f) throw new Error(`${name} is missing`);
  return join(dir, f);
};

const cubic = (v0, v1, v2, v3, f) => {
  const A = (v3 - v2) - (v0 - v1);
  const B = (v0 - v1) - A;
  return A * f * f * f + B * f * f + (v2 - v0) * f + v1;
};

/** terrain.js getNoise(x, y, frequency, 0.5, 0.5, 1): one octave of the improved Perlin stand-in, clamped. */
const noise = (x, y, f) => Math.min(1, Math.max(0, terrain.perlinNoise(x * f, y * f) * 0.5));

/**
 * The Iliac Bay from the operator's files. `ports: true` also reads MAPS.BSA's catalogue and exteriors.
 */
export async function realSource(dataPath, { ports: withPorts = true, filterNames = null, yieldEach = false } = {}) {
  const tick = () => (yieldEach ? new Promise((r) => setImmediate(r)) : null);
  const dir = arena2Dir(dataPath);
  // The main thread needs only the climate; the catalogue (MAPS.BSA) is the worker's, for the ports.
  let world;
  if (withPorts) world = await (await import('../travel/data.js')).loadWorldFromDir(dir);
  else world = { climate: new PakMap(new Uint8Array(await readFile(findFile(dir, 'CLIMATE.PAK'))), 'CLIMATE.PAK') };
  const woodsBytes = new Uint8Array(await readFile(findFile(dir, 'WOODS.WLD')));
  await tick();
  const woods = await terrain.WoodsFile.fromBytes(woodsBytes);
  await tick();
  const W = terrain.MAP_WIDTH, H = terrain.MAP_HEIGHT;
  const seaGrid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    if (y % 100 === 99) await tick();
    for (let x = 0; x < W; x++) {
      seaGrid[y * W + x] = woods.heightMap[y * W + x] <= WATER_BYTE && world.climate.atMapPixel(x, y) === OCEAN_CLIMATE ? 1 : 0;
    }
  }
  const ensureLarge = (px, py) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -2; dy <= 0; dy++) {
      const i = terrain.WoodsFile.clampY(py + dy) * W + terrain.WoodsFile.clampX(px + dx);
      if (woods.large.has(i)) continue;
      const at = woods.offsets[i] + 22;
      woods.large.set(i, woodsBytes.slice(at, at + 25));
    }
    // Large-map records are 25 bytes each; keep the memo bounded.
    if (woods.large.size > 60000) woods.large.clear();
  };
  let ports = [];
  if (withPorts) {
    const { readExteriors, portTowns } = await import('./ports.js');
    const exteriors = await readExteriors(new File([await openAsBlob(findFile(dir, 'MAPS.BSA'))], 'MAPS.BSA'));
    ports = portTowns(world.catalog, exteriors);
    if (filterNames) ports = ports.filter((p) => filterNames.includes(p.name) || filterNames.includes(p.id));
  }
  const HD = terrain.HDIM;
  return {
    world: { id: 'iliac-bay', label: 'The Iliac Bay', fallback: false },
    W, H,
    sea: (px, py) => px >= 0 && py >= 0 && px < W && py < H && seaGrid[py * W + px] === 1,
    climate: (px, py) => world.climate.atMapPixel(px, py),
    /** Ground heights at the 129 x 129 tile corners of a pixel, h[c + r*129], r = 0 its north edge (metres / 1.25). */
    corners(px, py) {
      ensureLarge(px, py);
      const s = terrain.generateSamples(woods, px, py);
      const out = new Float32Array(129 * 129);
      for (let x = 0; x < 129; x++) for (let y = 0; y < 129; y++) {
        out[x + (128 - y) * 129] = Math.fround(s[y + x * HD] * terrain.MAX_TERRAIN_HEIGHT);
      }
      return out;
    },
    /**
     * The pixel's tile water, w[c + r*128] (r = 0 its north row): a tile is water where its four corner samples lie
     * at or under the ocean elevation. The same numbers as generateSamples (its two bicubic terms, its noise term and
     * its float32 storage), except that the noise is only evaluated where it could lift a corner over the ocean
     * (the noise term lies in [0, NOISE_MAX]); the far cheaper path for open water. Returns the land tile count too.
     */
    waterMask(px, py) {
      ensureLarge(px, py);
      const shm = woods.smallRange(px - 2, py - 2, 4);
      const lhm = woods.largeRange(px - 1, py, 3);
      const S = (r, c) => shm[r + c * 4], L = (r, c) => lhm[r + c * 9];
      const div = (HD - 1) / 3;
      const ocean = terrain.SCALED_OCEAN_ELEVATION, MAXH = terrain.MAX_TERRAIN_HEIGHT;
      const wet = new Uint8Array(129 * 129); // corner water, south-down rows
      for (let x = 0; x < HD; x++) {
        const sfx = x / (HD - 1), ix = Math.floor(x / div), fx = (x - ix * div) / div;
        const s1 = cubic(S(0, 3), S(1, 3), S(2, 3), S(3, 3), sfx), s2 = cubic(S(0, 2), S(1, 2), S(2, 2), S(3, 2), sfx);
        const s3 = cubic(S(0, 1), S(1, 1), S(2, 1), S(3, 1), sfx), s4 = cubic(S(0, 0), S(1, 0), S(2, 0), S(3, 0), sfx);
        for (let y = 0; y < HD; y++) {
          const iy = Math.floor(y / div), fy = (y - iy * div) / div;
          let h = 0;
          h += cubic(s1, s2, s3, s4, y / (HD - 1)) * 8;
          const a = cubic(L(ix, iy), L(ix + 1, iy), L(ix + 2, iy), L(ix + 3, iy), fx);
          const b = cubic(L(ix, iy + 1), L(ix + 1, iy + 1), L(ix + 2, iy + 1), L(ix + 3, iy + 1), fx);
          const c = cubic(L(ix, iy + 2), L(ix + 1, iy + 2), L(ix + 2, iy + 2), L(ix + 3, iy + 2), fx);
          const d = cubic(L(ix, iy + 3), L(ix + 1, iy + 3), L(ix + 2, iy + 3), L(ix + 3, iy + 3), fx);
          h += cubic(a, b, c, d, fy) * 4;
          let w;
          if (h + NOISE_MAX < ocean - 1e-3) w = 1;
          else {
            const nx = px * (HD - 1) + x, ny = (terrain.MAP_HEIGHT - py) * (HD - 1) + y;
            h += noise(nx, ny, 0.3) * noise(nx, ny, 0.9) * NOISE_MAX;
            if (h < ocean) h = ocean;
            const stored = Math.fround(Math.min(1, Math.max(0, h / MAXH)));
            w = Math.fround(stored * MAXH) <= ocean ? 1 : 0;
          }
          wet[x + (128 - y) * 129] = w;
        }
      }
      const water = new Uint8Array(T * T);
      let land = 0;
      for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
        const i = c + r * 129;
        const v = wet[i] & wet[i + 1] & wet[i + 129] & wet[i + 130];
        water[c + r * T] = v;
        if (!v) land++;
      }
      return { water, land };
    },
    ocean: terrain.SCALED_OCEAN_ELEVATION,
    beach: terrain.SCALED_BEACH_ELEVATION,
    ports,
  };
}

/** The invented practice sea (client/world/sea/chart.js FALLBACK_SEA). */
export function fallbackSource() {
  const F = FALLBACK_SEA;
  const relief = fallbackRelief;
  const sea = (px, py) => px >= 0 && py >= 0 && px < F.width && py < F.height && relief((px + 0.5) * CHART_METRES, (py + 0.5) * CHART_METRES) < 0;
  const ports = F.ports.map((p) => ({
    id: `fallback:${p.name}`, name: p.name, region: 'Practice Sound', regionIndex: -1, index: -1, type: 'city',
    px: p.px, py: p.py, fallback: true,
    block: { width: 2, height: 2, origin: tileOrigin(2, 2), custom: false },
  }));
  const OCEAN = 27.2;
  return {
    world: { id: F.id, label: F.label, fallback: true },
    W: F.width, H: F.height,
    sea,
    climate: () => 231,
    corners(px, py) {
      const out = new Float32Array(129 * 129);
      for (let r = 0; r < 129; r++) for (let c = 0; c < 129; c++) {
        out[c + r * 129] = OCEAN + relief((px * T + c) * TILE_METRES, (py * T + r) * TILE_METRES);
      }
      return out;
    },
    waterMask(px, py) {
      const water = new Uint8Array(T * T);
      let land = 0;
      const at = (c, r) => relief((px * T + c) * TILE_METRES, (py * T + r) * TILE_METRES) <= 0;
      for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
        const v = at(c, r) && at(c + 1, r) && at(c, r + 1) && at(c + 1, r + 1) ? 1 : 0;
        water[c + r * T] = v;
        if (!v) land++;
      }
      return { water, land };
    },
    ocean: OCEAN, beach: 40,
    ports,
  };
}

// ------------------------------------------------------------------------------------------------ the sea model

const LAND = 0, CLEAN = 1, FINE = 2;

/**
 * Water and clearance over a source. `maxPixels` bounds the tile cache (each pixel 16 KB water + 16 KB clearance).
 */
export function seaModel(src, { maxPixels = 256 } = {}) {
  const { W, H } = src;
  const inGrid = (px, py) => px >= 0 && py >= 0 && px < W && py < H;
  const openGrid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    openGrid[y * W + x] = src.sea(x, y) && src.sea(x - 1, y) && src.sea(x, y - 1) && src.sea(x - 1, y - 1) ? 1 : 0;
  }
  const isOpen = (px, py) => inGrid(px, py) && openGrid[py * W + px] === 1;
  const deepGrid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let d = 1;
    for (let j = -1; j <= 1 && d; j++) for (let i = -1; i <= 1; i++) if (!isOpen(x + i, y + j)) { d = 0; break; }
    deepGrid[y * W + x] = d;
  }
  const isDeep = (px, py) => inGrid(px, py) && deepGrid[py * W + px] === 1;
  const landlocked = (px, py) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (src.sea(px + i, py + j)) return false;
    return true;
  };
  const fine = new Map(); // pixel key -> {water, clear}
  const remember = (k, v) => {
    fine.set(k, v);
    while (fine.size > maxPixels) fine.delete(fine.keys().next().value);
    return v;
  };
  const stateGrid = new Uint8Array(W * H).fill(255); // 255 unknown
  const stats = { generated: 0, clears: 0 };
  function state(px, py) {
    if (!inGrid(px, py)) return LAND;
    const k = py * W + px;
    let s = stateGrid[k];
    if (s !== 255) return s;
    if (landlocked(px, py)) s = LAND;
    else {
      // Every other pixel is sounded once: all water is CLEAN (no tiles kept), otherwise its tiles are kept.
      const m = src.waterMask(px, py);
      stats.generated++;
      s = m.land === 0 ? CLEAN : m.land === T * T ? LAND : FINE;
      if (s === FINE) remember(k, { water: m.water, clear: null });
    }
    stateGrid[k] = s;
    return s;
  }
  const calm = (px, py) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (state(px + i, py + j) !== CLEAN) return false;
    return true;
  };

  function fineOf(px, py) {
    const k = py * W + px;
    const hit = fine.get(k);
    if (hit?.water) return hit;
    const m = src.waterMask(px, py);
    stats.generated++;
    if (hit) { hit.water = m.water; return hit; }
    return remember(k, { water: m.water, clear: null });
  }
  /** Ground height at a tile corner (for the shore's material); regenerates the pixel's samples. */
  function cornerHeight(px, py, c, r) {
    return src.corners(px, py)[Math.min(128, Math.max(0, c)) + Math.min(128, Math.max(0, r)) * 129];
  }
  function waterTile(gx, gz) {
    const px = Math.floor(gx / T), py = Math.floor(gz / T);
    const s = state(px, py);
    if (s === LAND) return 0;
    if (s === CLEAN) return 1;
    return fineOf(px, py).water[(gx - px * T) + (gz - py * T) * T];
  }
  function clearOf(px, py) {
    const f = state(px, py) === FINE ? fineOf(px, py) : null;
    const k = py * W + px;
    const holder = f ?? (fine.get(k) || remember(k, { water: null, clear: null }));
    if (holder.clear) return holder.clear;
    stats.clears++;
    const N = T + 2 * CAP_TILES, gx0 = px * T - CAP_TILES, gz0 = py * T - CAP_TILES;
    const d = new Float32Array(N * N);
    // Fill from the nine pixels' water.
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const qx = px + i, qy = py + j, s = state(qx, qy);
      const c0 = Math.max(0, qx * T - gx0), c1 = Math.min(N, (qx + 1) * T - gx0);
      const r0 = Math.max(0, qy * T - gz0), r1 = Math.min(N, (qy + 1) * T - gz0);
      if (c0 >= c1 || r0 >= r1) continue;
      const wat = s === FINE ? fineOf(qx, qy).water : null;
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
        const w = s === CLEAN ? 1 : s === LAND ? 0 : wat[(gx0 + c - qx * T) + (gz0 + r - qy * T) * T];
        d[c + r * N] = w ? 1e9 : 0;
      }
    }
    const R2 = Math.SQRT2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k2 = i + j * N;
      let v = d[k2];
      if (!v) continue;
      if (i > 0) v = Math.min(v, d[k2 - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k2 - N] + 1);
        if (i > 0) v = Math.min(v, d[k2 - N - 1] + R2);
        if (i < N - 1) v = Math.min(v, d[k2 - N + 1] + R2);
      }
      d[k2] = v;
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
      const k2 = i + j * N;
      let v = d[k2];
      if (!v) continue;
      if (i < N - 1) v = Math.min(v, d[k2 + 1] + 1);
      if (j < N - 1) {
        v = Math.min(v, d[k2 + N] + 1);
        if (i < N - 1) v = Math.min(v, d[k2 + N + 1] + R2);
        if (i > 0) v = Math.min(v, d[k2 + N - 1] + R2);
      }
      d[k2] = v;
    }
    const clear = new Uint8Array(T * T);
    for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
      const v = d[(c + CAP_TILES) + (r + CAP_TILES) * N];
      clear[c + r * T] = v ? Math.min(255, Math.round(Math.max(0, v * TILE_METRES - TILE_METRES / 2) * Q)) : 0;
    }
    holder.clear = clear;
    return clear;
  }
  function isWater(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    return waterTile(Math.floor(x / TILE_METRES), Math.floor(z / TILE_METRES)) === 1;
  }
  function clearanceAt(x, z) {
    if (!isWater(x, z)) return 0;
    const gx = Math.floor(x / TILE_METRES), gz = Math.floor(z / TILE_METRES);
    const px = Math.floor(gx / T), py = Math.floor(gz / T);
    if (calm(px, py)) return CLEAR_CAP_M;
    return clearOf(px, py)[(gx - px * T) + (gz - py * T) * T] / Q;
  }
  function segmentClear(ax, az, bx, bz, { clearance = 0 } = {}) {
    if (![ax, az, bx, bz].every(Number.isFinite)) return { ok: false, hitAt: { x: ax, z: az } };
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
    let calmKey = -1;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const px = Math.floor(x / CHART_METRES), pz = Math.floor(z / CHART_METRES);
      const k = pz * W + px;
      if (k === calmKey) continue;
      if (inGrid(px, pz) && clearance <= CLEAR_CAP_M && calm(px, pz)) { calmKey = k; continue; }
      calmKey = -1;
      const ok = clearance > 0 ? clearanceAt(x, z) >= clearance : isWater(x, z);
      if (!ok) return { ok: false, hitAt: { x, z } };
    }
    return { ok: true };
  }
  const known = (px, py) => inGrid(px, py) && stateGrid[py * W + px] !== 255;
  return { W, H, src, inGrid, isOpen, isDeep, state, known, calm, fineOf, cornerHeight, waterTile, clearOf, isWater, clearanceAt, segmentClear, stats, fine };
}

// ------------------------------------------------------------------------------------------------ harbours

/** The roadstead: the nearest open pixel within ROADSTEAD_PX of the town, ring by ring, deep and roomy first (DFO). */
export function roadsteadOf(port, isOpen, isDeep) {
  for (let r = 1; r <= ROADSTEAD_PX; r++) {
    let best = null, score = -Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = port.px + dx, y = port.py + dy;
      if (!isOpen(x, y)) continue;
      let room = isDeep(x, y) ? 100 : 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (isOpen(x + i, y + j)) room++;
      const s = room * 1000 - (dx * dx + dy * dy);
      if (s > score) { score = s; best = { px: x, py: y }; }
    }
    if (best) return best;
  }
  return null;
}

/** The town's block grid in global tiles (gx east, gz south), half-open. */
export function townTiles(port) {
  const { width, height, origin } = port.block;
  const gx0 = port.px * T + origin.x;
  const gz1 = port.py * T + T - origin.y;
  return { gx0, gx1: gx0 + width * 16, gz0: gz1 - height * 16, gz1 };
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) {
    const a = this.a;
    a.push(n);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A port's harbour: roadstead, berth, approach, quay, shore and the channel from berth to roadstead.
 * A best-first flood from the roadstead toward the town's block grid through water CHANNEL_CLEAR_M off the land (its
 * last tiles closing to BERTH_CLEAR_M beside the shore); the berth is the first tile it reaches that lies beside the
 * shore with at least BERTH_CLEAR_M of water about it.
 */
export function buildHarbour(port, sea) {
  const road = roadsteadOf(port, sea.isOpen, sea.isDeep);
  if (!road) return { ok: false, reason: 'no open sea within 3 map pixels' };
  const clearAt = (gx, gz) => sea.clearanceAt((gx + 0.5) * TILE_METRES, (gz + 0.5) * TILE_METRES);
  // Bound the flood to the town's and the roadstead's pixels and a pixel about them.
  const gxMin = (Math.min(port.px, road.px) - 1) * T, gxMax = (Math.max(port.px, road.px) + 2) * T;
  const gzMin = (Math.min(port.py, road.py) - 1) * T, gzMax = (Math.max(port.py, road.py) + 2) * T;
  let sx = road.px * T + T / 2, sz = road.py * T + T / 2;
  if (clearAt(sx, sz) < CHANNEL_CLEAR_M) {
    let best = null, bd = Infinity;
    for (let r = 0; r < T; r += 2) for (let c = 0; c < T; c += 2) {
      const gx = road.px * T + c, gz = road.py * T + r;
      const d = (c - T / 2) ** 2 + (r - T / 2) ** 2;
      if (d >= bd || clearAt(gx, gz) < CHANNEL_CLEAR_M) continue;
      bd = d;
      best = [gx, gz];
    }
    if (!best) return { ok: false, reason: 'the roadstead has no clear water' };
    [sx, sz] = best;
  }
  const town = townTiles(port);
  const distTown = (gx, gz) => {
    const dx = Math.max(town.gx0 - (gx + 0.5), 0, gx + 0.5 - town.gx1);
    const dz = Math.max(town.gz0 - (gz + 0.5), 0, gz + 0.5 - town.gz1);
    return Math.hypot(dx, dz) * TILE_METRES;
  };
  const NX = gxMax - gxMin;
  const key = (gx, gz) => (gx - gxMin) + (gz - gzMin) * NX;
  const parent = new Map([[key(sx, sz), -1]]);
  const clr = new Map();
  const cOf = (gx, gz) => {
    const k = key(gx, gz);
    let v = clr.get(k);
    if (v === undefined) { v = clearAt(gx, gz); clr.set(k, v); }
    return v;
  };
  const heap = new Heap();
  heap.push([distTown(sx, sz), sx, sz]);
  let berth = null, bestDt = Infinity, nearest = null, nd = Infinity, expanded = 0;
  const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (heap.size && expanded++ < HARBOUR_SEARCH) {
    const [dt, gx, gz] = heap.pop();
    // Best-first toward the town: once the frontier lies BERTH_SEARCH_MARGIN_M past the best berth, stop.
    if (dt > bestDt + BERTH_SEARCH_MARGIN_M) break;
    const c = cOf(gx, gz);
    if (dt < nd) { nd = dt; nearest = [gx, gz]; }
    if (c >= BERTH_CLEAR_M && c <= CHANNEL_CLEAR_M + 2 * TILE_METRES && dt < bestDt) { berth = [gx, gz]; bestDt = dt; }
    for (const [dx, dz] of D8) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < gxMin || nz < gzMin || nx >= gxMax || nz >= gzMax) continue;
      const nk = key(nx, nz);
      if (parent.has(nk)) continue;
      const nc = cOf(nx, nz);
      if (nc < BERTH_CLEAR_M) continue;
      if (nc < CHANNEL_CLEAR_M && c < CHANNEL_CLEAR_M) continue;
      if (dx && dz && (cOf(gx + dx, gz) < BERTH_CLEAR_M || cOf(gx, gz + dz) < BERTH_CLEAR_M)) continue;
      parent.set(nk, key(gx, gz));
      heap.push([distTown(nx, nz), nx, nz]);
    }
  }
  const pick = berth ?? nearest;
  const centreOfKey = (k) => ({ x: (gxMin + (k % NX) + 0.5) * TILE_METRES, z: (gzMin + Math.floor(k / NX) + 0.5) * TILE_METRES });
  const chain = [];
  for (let k = key(pick[0], pick[1]); k !== -1 && k !== undefined; k = parent.get(k)) chain.push(k);
  const raw = chain.map(centreOfKey);
  const b = raw[0];
  // Out to sea: toward where the water opens about her.
  let nx = 0, nz = 0;
  for (let a = 0; a < 16; a++) {
    const dx = Math.sin((a / 16) * TAU), dz = -Math.cos((a / 16) * TAU);
    const w = sea.clearanceAt(b.x + dx * 3 * TILE_METRES, b.z + dz * 3 * TILE_METRES);
    nx += dx * w;
    nz += dz * w;
  }
  let approach = b, run = 0;
  for (let i = 1; i < raw.length; i++) {
    run += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
    approach = raw[i];
    if (run >= APPROACH_M) break;
  }
  let seaward = Math.hypot(nx, nz) > 1e-6 ? yawOf(nx, nz) : approach !== b ? yawOf(approach.x - b.x, approach.z - b.z) : 0;
  // Quay: walk landward to the first dry ground, then a tile onto it.
  let quay = null;
  const land = headingOf(seaward + Math.PI);
  for (let s = 1; s <= 40 && !quay; s++) {
    const x = b.x + (land.x * s * TILE_METRES) / 2, z = b.z + (land.z * s * TILE_METRES) / 2;
    if (!sea.isWater(x, z)) {
      const qx = x + land.x * TILE_METRES, qz = z + land.z * TILE_METRES;
      if (!sea.isWater(qx, qz)) quay = { x: qx, z: qz };
    }
  }
  if (!quay) {
    const bgx = Math.floor(b.x / TILE_METRES), bgz = Math.floor(b.z / TILE_METRES);
    let bd = Infinity;
    for (let r = -16; r <= 16; r++) for (let c = -16; c <= 16; c++) {
      if (sea.waterTile(bgx + c, bgz + r)) continue;
      const d = c * c + r * r;
      if (d < bd) { bd = d; quay = { x: (bgx + c + 0.5) * TILE_METRES, z: (bgz + r + 0.5) * TILE_METRES }; }
    }
    if (quay) seaward = yawOf(b.x - quay.x, b.z - quay.z);
  }
  if (!quay) return { ok: false, reason: 'no dry quay beside the berth' };
  const path = straighten(raw, (p, q) => sea.segmentClear(p.x, p.z, q.x, q.z, { clearance: BERTH_CLEAR_M }).ok);
  return {
    ok: true,
    besideShore: berth != null,
    road,
    berth: { x: b.x, z: b.z, yaw: wrapYaw(seaward) },
    approach,
    roadstead: raw[raw.length - 1],
    quay: { x: quay.x, z: quay.z, yaw: wrapYaw(seaward + Math.PI) },
    shore: shoreOf(quay, sea),
    path,
  };
}

/** The shore under a quay: the climate's (marsh, desert sand, mountain rock), else the ground's height. */
export function shoreOf(q, sea) {
  const px = Math.floor(q.x / CHART_METRES), py = Math.floor(q.z / CHART_METRES);
  const cl = sea.src.climate(px, py);
  if (cl === 228) return 'marsh';
  if (cl === 224 || cl === 225) return 'sand';
  if (cl === 226) return 'rock';
  const h = sea.cornerHeight(px, py, Math.round(q.x / TILE_METRES - px * T), Math.round(q.z / TILE_METRES - py * T));
  return h <= sea.src.beach ? 'sand' : h > sea.src.beach * 4 ? 'rock' : 'grass';
}

/** Greedy straightening (DFO's gallop): from each point on to the farthest the water holds a line to. */
export function straighten(pts, holds) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  const last = pts.length - 1;
  for (let i = 0; i < last;) {
    let good = i + 1;
    if (holds(pts[i], pts[last])) good = last;
    else {
      let step = 1;
      while (good + step < last && holds(pts[i], pts[good + step])) { good += step; step *= 2; }
      let bad = Math.min(good + step, last);
      while (bad - good > 1) {
        const mid = (good + bad) >> 1;
        if (holds(pts[i], pts[mid])) good = mid;
        else bad = mid;
      }
    }
    out.push(pts[good]);
    i = good;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ lanes and routes

export function lanePixels(from, to, sea, blocked) {
  const { W } = sea;
  const ok = (x, y) => sea.isOpen(x, y) && !blocked.has(y * W + x);
  if (!ok(from.px, from.py) || !ok(to.px, to.py)) return null;
  const g = new Map([[from.py * W + from.px, 0]]);
  const came = new Map();
  const shut = new Set();
  const h = (x, y) => Math.hypot(x - to.px, y - to.py);
  const heap = new Heap();
  heap.push([h(from.px, from.py), from.px, from.py]);
  let expanded = 0;
  while (heap.size && expanded < LANE_SEARCH) {
    const [, x, y] = heap.pop();
    const k = y * W + x;
    if (shut.has(k)) continue;
    shut.add(k);
    if (x === to.px && y === to.py) {
      const path = [{ px: x, py: y }];
      for (let c = came.get(k); c != null; c = came.get(c)) path.push({ px: c % W, py: Math.floor(c / W) });
      return path.reverse();
    }
    expanded++;
    const gk = g.get(k);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (!ok(nx, ny)) continue;
      if (dx && dy && (!ok(x + dx, y) || !ok(x, y + dy))) continue;
      const ng = gk + (dx && dy ? Math.SQRT2 : 1) * (sea.isDeep(nx, ny) ? 1 : 3);
      const nk = ny * W + nx;
      if (ng >= (g.get(nk) ?? Infinity)) continue;
      g.set(nk, ng);
      came.set(nk, k);
      heap.push([ng + h(nx, ny), nx, ny]);
    }
  }
  return null;
}

const r2 = (v) => Math.round(v * 100) / 100;
const xz = (p) => ({ x: r2(p.x), z: r2(p.z) });

/** Every map pixel a straight line crosses (a grid walk; through a corner both pixels beside it). */
export function pixelsCrossed(p, q, visit) {
  const P = CHART_METRES;
  const dx = q.x - p.x, dz = q.z - p.z, sx = Math.sign(dx), sz = Math.sign(dz);
  let cx = Math.floor(p.x / P), cz = Math.floor(p.z / P);
  const ex = Math.floor(q.x / P), ez = Math.floor(q.z / P);
  const tdx = sx ? P / Math.abs(dx) : Infinity, tdz = sz ? P / Math.abs(dz) : Infinity;
  let tx = sx ? (sx > 0 ? (cx + 1) * P - p.x : p.x - cx * P) / Math.abs(dx) : Infinity;
  let tz = sz ? (sz > 0 ? (cz + 1) * P - p.z : p.z - cz * P) / Math.abs(dz) : Infinity;
  if (!visit(cx, cz)) return false;
  for (let left = Math.abs(ex - cx) + Math.abs(ez - cz) + 2; left > 0 && (cx !== ex || cz !== ez); left--) {
    if (Math.abs(tx - tz) < 1e-12) {
      if (!visit(cx + sx, cz) || !visit(cx, cz + sz)) return false;
      cx += sx; cz += sz; tx += tdx; tz += tdz;
    } else if (tx < tz) { cx += sx; tx += tdx; } else { cz += sz; tz += tdz; }
    if (!visit(cx, cz)) return false;
  }
  return true;
}

const RING = Array.from({ length: 8 }, (_, i) => [Math.sin((i / 8) * TAU), -Math.cos((i / 8) * TAU)]);
/**
 * A lane leg at tile level: every half tile on water, with water `clear` metres off it in eight directions (and at
 * half that) - the islets an open pixel may hold are found here.
 */
export function laneClear(sea, p, q, clear) {
  const len = Math.hypot(q.x - p.x, q.z - p.z);
  const n = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  for (let i = 0; i <= n; i++) {
    const x = p.x + ((q.x - p.x) * i) / n, z = p.z + ((q.z - p.z) * i) / n;
    if (!sea.isWater(x, z)) return { ok: false, hitAt: { x, z } };
    for (const [ux, uz] of RING) {
      if (!sea.isWater(x + ux * clear, z + uz * clear) || !sea.isWater(x + (ux * clear) / 2, z + (uz * clear) / 2)) return { ok: false, hitAt: { x, z } };
    }
  }
  return { ok: true };
}

/**
 * The water-bound way from harbour A's berth to harbour B's: A's channel out, the open-sea lane between the
 * roadsteads, B's channel in. The lane (DFO seaLanes.js in behaviour): an A* over open map pixels, deep water
 * preferred; straightened wherever every pixel a line crosses is deep (or on the A* way); then each leg sounded at
 * tile level (laneClear: LANE_CLEAR_M off the land, CHANNEL_CLEAR_M on the legs from and to a roadstead). A leg the
 * tiles refuse blocks the pixel it fails in and the lane is searched again (LANE_RETRIES).
 */
export function buildRoute(A, B, sea) {
  const ra = A.roadstead, rb = B.roadstead;
  const blocked = new Set();
  let open = null;
  for (let tries = 0; tries <= LANE_RETRIES && !open; tries++) {
    let pts, onWay;
    if (A.road.px === B.road.px && A.road.py === B.road.py) {
      pts = [ra, rb];
      onWay = new Set([A.road.py * sea.W + A.road.px]);
    } else {
      const pix = lanePixels(A.road, B.road, sea, blocked);
      if (!pix) return null;
      onWay = new Set(pix.map((p) => p.py * sea.W + p.px));
      pts = pix.map((p) => ({ x: (p.px + 0.5) * CHART_METRES, z: (p.py + 0.5) * CHART_METRES }));
      pts[0] = ra;
      pts[pts.length - 1] = rb;
    }
    const coarse = (p, q) => pixelsCrossed(p, q, (x, y) => {
      const k = y * sea.W + x;
      return !blocked.has(k) && (onWay.has(k) || sea.isDeep(x, y));
    });
    const legs = straighten(pts, coarse);
    let bad = null;
    for (let i = 1; i < legs.length && !bad; i++) {
      const clear = i === 1 || i === legs.length - 1 ? CHANNEL_CLEAR_M : LANE_CLEAR_M;
      const s = laneClear(sea, legs[i - 1], legs[i], clear);
      if (!s.ok) bad = s.hitAt;
    }
    if (bad) {
      const bx = Math.floor(bad.x / CHART_METRES), bz = Math.floor(bad.z / CHART_METRES);
      const k = bz * sea.W + bx;
      if ((bx === A.road.px && bz === A.road.py) || (bx === B.road.px && bz === B.road.py) || blocked.has(k)) return null;
      blocked.add(k);
      continue;
    }
    open = legs;
  }
  if (!open) return null;
  const tag = (list, side) => list.map((p) => ({ x: p.x, z: p.z, side }));
  const all = [...tag(A.path, 'A'), ...tag(open.slice(1, -1), 'open'), ...tag(B.path.slice().reverse(), 'B')];
  const points = [];
  for (const p of all) {
    const q = points[points.length - 1];
    if (q && Math.hypot(q.x - p.x, q.z - p.z) < 0.01) continue;
    points.push(p);
  }
  const legs = [];
  let metres = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const m = Math.hypot(b.x - a.x, b.z - a.z);
    metres += m;
    // A harbour leg runs within one port's channel; everything between the two roadsteads is open sea.
    const kind = a.side !== 'open' && a.side === b.side ? 'harbour' : 'open';
    legs.push({ kind, a: xz(a), b: xz(b), metres: r2(m) });
  }
  return {
    from: A.id, to: B.id,
    points: points.map(xz), legs,
    metres: r2(metres), leagues: r2(metres / LEAGUE_M),
    days: r2(((metres / CHART_METRES) * SHIP_MINUTES_PER_PIXEL) / 1440),
  };
}
