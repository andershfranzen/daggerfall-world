// Shores, landfalls and harbours seen from the sea. Coasts are published by the geo owner (server/rpg/sailing/
// coast.js, from the operator's own MAPS/WOODS data) as chart rings or as a height sampler; this module only
// shapes them: a beach apron running under the water, a cliff or bank up to the land's height, and the land's
// top. Harbours are built at each port's berth (its chart x/z; yaw points out to sea): a stone mole, a
// lighthouse with a lantern, warehouses on the quay and mooring posts. Nothing here comes from game assets.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hash2 = (x, z) => { const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };
const smoothNoise = (x, z) => {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const SAND = [0.66, 0.6, 0.45], ROCK = [0.42, 0.4, 0.36], GRASS = [0.3, 0.4, 0.22], DARK = [0.24, 0.3, 0.17];
const STONE = [0.62, 0.6, 0.56], WHITE = [0.85, 0.84, 0.8], ROOF = [0.45, 0.22, 0.16], TIMBER = [0.36, 0.25, 0.15];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Signed area (x/z): positive counter-clockwise seen from above with z south. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Drop points closer than `min` metres to the previous kept one. */
export function decimate(ring, min = 25) {
  const out = [];
  for (const p of ring) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= min) out.push(p);
  }
  if (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < min) out.pop();
  return out;
}

/** Ear-clipping triangulation of a simple polygon (x/z). Returns index triples. */
export function triangulate(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const ccw = ringArea(ring) > 0;
  const idx = [...Array(n).keys()];
  const out = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    return ccw ? d1 > 0 && d2 > 0 && d3 > 0 : d1 < 0 && d2 < 0 && d3 < 0;
  };
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      const cr = cross(a, b, c);
      if (ccw ? cr <= 0 : cr >= 0) continue;
      let ok = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inside(ring[j], a, b, c)) { ok = false; break; } }
      if (!ok) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // not simple: leave the rest open rather than spin
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Land meshes from coast rings, in chart metres relative to each ring's anchor (float64 kept on the CPU).
 * Returns {draw(solids, chartToDeck, ownChart, range) -> triangles drawn}.
 */
export function buildLand(rings) {
  const pieces = [];
  for (const c of rings) {
    const ring = decimate(c.ring, c.kind === 'island' ? 12 : 25);
    if (ring.length < 3) continue;
    const ccw = ringArea(ring) > 0;
    const ax = ring[0][0], az = ring[0][1];
    const base = Number.isFinite(c.height) ? c.height : c.kind === 'island' ? 9 : 16;
    const tris = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const top = ring.map((p) => {
      const h = Number.isFinite(p[2]) && p[2] > 0 ? p[2] : base * (0.55 + 0.9 * smoothNoise(p[0] / 180, p[1] / 180));
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
      return [p[0] - ax, h, p[1] - az];
    });
    // Outward normals per vertex (land on the inside of the ring).
    const outward = ring.map((p, i) => {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length];
      let nx = b[1] - a[1], nz = -(b[0] - a[0]);
      if (ccw) { nx = -nx; nz = -nz; }
      const l = Math.hypot(nx, nz) || 1;
      return [nx / l, nz / l];
    });
    const beach = top.map((t, i) => {
      const w = 10 + t[1] * 1.2;
      return [t[0] + outward[i][0] * w, 0.6, t[2] + outward[i][1] * w];
    });
    const under = top.map((t, i) => [t[0] + outward[i][0] * (30 + t[1] * 2), -6, t[2] + outward[i][1] * (30 + t[1] * 2)]);
    // A clipped ring's straight edges along the query window are not shore: no beach or cliff there.
    const w = c.clipped ? c.window : null;
    const onWindow = (p) => w && (Math.abs(Math.abs(p[0] - w.x) - w.r) < 8 || Math.abs(Math.abs(p[1] - w.z) - w.r) < 8);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (onWindow(ring[i]) && onWindow(ring[j])) continue;
      const cliff = (top[i][1] + top[j][1]) / 2 > 14;
      tris.push([under[i], under[j], beach[j], SAND], [under[i], beach[j], beach[i], SAND]);
      tris.push([beach[i], beach[j], top[j], cliff ? ROCK : mix(SAND, GRASS, 0.4)], [beach[i], top[j], top[i], cliff ? ROCK : mix(SAND, GRASS, 0.4)]);
    }
    for (const [a, b, d] of triangulate(ring)) {
      const g = smoothNoise(top[a][0] / 90 + ax / 90, top[a][2] / 90 + az / 90);
      tris.push([top[a], top[b], top[d], mix(GRASS, DARK, g)]);
    }
    pieces.push({ ax, az, tris, box: [minX, maxX, minZ, maxZ] });
  }
  return {
    pieces,
    draw(solids, chartToDeck, own, range) {
      let n = 0;
      for (const p of pieces) {
        const dx = Math.max(p.box[0] - own.x, 0, own.x - p.box[1]), dz = Math.max(p.box[2] - own.z, 0, own.z - p.box[3]);
        if (Math.hypot(dx, dz) > range) continue;
        for (const [a, b, c, col] of p.tris) {
          solids.tri(chartToDeck(a[0] + p.ax, a[1], a[2] + p.az), chartToDeck(b[0] + p.ax, b[1], b[2] + p.az), chartToDeck(c[0] + p.ax, c[1], c[2] + p.az), col);
          n++;
        }
      }
      return n;
    },
  };
}

/**
 * Terrain patch from a height sampler (chart metres -> height above the sea, <= 0 or null for water), 4 km
 * square about (cx, cz). Only cells touching land are kept.
 */
export function landPatch(sampler, cx, cz, { size = 4000, cells = 50 } = {}) {
  const step = size / cells, x0 = cx - size / 2, z0 = cz - size / 2;
  const H = [];
  for (let j = 0; j <= cells; j++) for (let i = 0; i <= cells; i++) {
    const h = sampler(x0 + i * step, z0 + j * step);
    H.push(Number.isFinite(h) ? h : -8);
  }
  const tris = [];
  const at = (i, j) => { const h = H[j * (cells + 1) + i]; return [x0 + i * step - cx, h > 0 ? h : Math.max(-8, h * 2 - 2), z0 + j * step - cz]; };
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    const hs = [H[j * (cells + 1) + i], H[j * (cells + 1) + i + 1], H[(j + 1) * (cells + 1) + i], H[(j + 1) * (cells + 1) + i + 1]];
    if (Math.max(...hs) <= 0) continue;
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    const top = Math.max(...hs);
    const col = top < 3 ? SAND : top > 60 ? ROCK : mix(GRASS, DARK, smoothNoise(a[0] / 120, a[2] / 120));
    tris.push([a, c, b, col], [b, c, d, col]);
  }
  return {
    cx, cz,
    draw(solids, chartToDeck) {
      for (const [a, b, c, col] of tris) solids.tri(chartToDeck(a[0] + cx, a[1], a[2] + cz), chartToDeck(b[0] + cx, b[1], b[2] + cz), chartToDeck(c[0] + cx, c[1], c[2] + cz), col);
      return tris.length;
    },
  };
}

/**
 * A harbour at a port's berth, laid into `solids` (deck frame through chartToDeck). Sets `port.__lamp` to the
 * lantern's chart position for the glow drawn by the fx pass. The quay lies landward of the berth (yaw points
 * out to sea), the mole runs seaward with the lighthouse at its head.
 */
export function buildHarbour(solids, fx, port, chartToDeck, { d = 0 } = {}) {
  const yaw = Number.isFinite(port.yaw) ? port.yaw : 0;
  const out = [Math.sin(yaw), -Math.cos(yaw)], side = [-out[1], out[0]];
  const P = (along, across, y) => chartToDeck(port.x + out[0] * along + side[0] * across, y, port.z + out[1] * along + side[1] * across);
  const box = (along, across, y, la, wa, h, col) => {
    const c = P(along, across, y + h / 2);
    const ax = sub(P(along + la / 2, across, y + h / 2), c), az = sub(P(along, across + wa / 2, y + h / 2), c), ay = sub(P(along, across, y + h), c);
    solids.box(c, ax, ay, az, col);
  };
  // Quay along the shore behind the berth, and the land rising behind it.
  box(-70, 0, -3, 30, 260, 5.5, STONE);
  box(-140, 0, -3, 110, 320, 9, mix(GRASS, SAND, 0.3));
  // Mole running out to sea on the berth's flank; the berth itself stays open water.
  box(10, 55, -3, 170, 12, 5.5, STONE);
  if (d < 2600) {
    for (let k = -100; k <= 100; k += 40) box(-50, k, 2.5, 4, 4, 1.6, TIMBER); // mooring posts on the quay
    const r = (s) => hash2(port.x + s, port.z - s);
    for (let i = 0; i < 6; i++) {
      const across = -110 + i * 42 + r(i) * 8, w = 18 + r(i + 9) * 10, h = 8 + r(i + 3) * 7;
      box(-88 - r(i + 5) * 10, across, 2.5, 14 + r(i + 7) * 6, w, h, i % 2 ? [0.58, 0.52, 0.42] : [0.5, 0.46, 0.4]);
      box(-88 - r(i + 5) * 10, across, 2.5 + h, 10, w * 0.9, 3, ROOF);
    }
  }
  // Lighthouse at the mole's head.
  box(92, 55, 2.5, 8, 8, 6, STONE);
  box(92, 55, 8.5, 6, 6, 18, WHITE);
  box(92, 55, 26.5, 7.5, 7.5, 1.2, STONE);
  box(92, 55, 27.7, 4, 4, 3, [0.95, 0.8, 0.45]);
  box(92, 55, 30.7, 6, 6, 1.6, ROOF);
  port.__lamp = [port.x + out[0] * 92 + side[0] * 55, 29.2, port.z + out[1] * 92 + side[1] * 55];
  void fx;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const _internal = { clamp };

/**
 * The real Iliac Bay seen from the sea: a land sampler over the operator's own WOODS.WLD through Daggerfall
 * Unity's terrain sampler (client/world/wilderness/terrain.js), the ground the player walks ashore. Chart metres in
 * (x east, z south; map pixel (px, py) spans [px, px+1) x 819.2 m by [py, py+1) x 819.2 m), height above the sea
 * out (m; 0 at the ocean elevation). Pixels are read on demand (8-tile resolution) and cached; an unread pixel
 * answers null (drawn as sea) until `ensure` has fetched it, then `version` increases.
 */
export async function woodsLandSampler(files) {
  const [{ WoodsFile, generateSamples, HDIM, HEIGHT_MAX, OCEAN_Y, PIXEL_SIZE, TDIM, MAP_WIDTH, MAP_HEIGHT }, { readBlob }, { indexFiles }] = await Promise.all([
    import('../../world/wilderness/terrain.js'), import('../../world/bsa.js'), import('../../world/files.js'),
  ]);
  const file = indexFiles(files).get?.('WOODS.WLD') ?? [...files].find((f) => /(^|\/)WOODS\.WLD$/i.test(f.webkitRelativePath || f.name));
  if (!file) throw new Error('WOODS.WLD is not among the game files');
  const woods = await WoodsFile.open((o, n) => readBlob(file, o, n), file.size);
  const STEP = 8, rows = TDIM / STEP + 1;
  const cache = new Map(), pending = new Map();
  const sampler = {
    version: 0,
    heightAt(x, z) {
      const px = Math.floor(x / PIXEL_SIZE), py = Math.floor(z / PIXEL_SIZE);
      if (px < 0 || py < 0 || px >= MAP_WIDTH || py >= MAP_HEIGHT) return null;
      const s = cache.get(py * MAP_WIDTH + px);
      if (!s) return null;
      // Tile coordinates inside the pixel: x east, y north (the sampler's frame).
      const tx = (x - px * PIXEL_SIZE) / (PIXEL_SIZE / TDIM) / STEP, ty = ((py + 1) * PIXEL_SIZE - z) / (PIXEL_SIZE / TDIM) / STEP;
      const ix = Math.min(rows - 2, Math.max(0, Math.floor(tx))), iy = Math.min(rows - 2, Math.max(0, Math.floor(ty)));
      const fx = Math.min(1, Math.max(0, tx - ix)), fy = Math.min(1, Math.max(0, ty - iy));
      const at = (a, b) => s[b + a * rows];
      const h = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
      return h * HEIGHT_MAX - OCEAN_Y;
    },
    /** Fetch every pixel within `radius` metres of (x, z). Resolves once they are cached. */
    async ensure(x, z, radius = 2500) {
      const jobs = [];
      for (let py = Math.floor((z - radius) / PIXEL_SIZE); py <= Math.floor((z + radius) / PIXEL_SIZE); py++) {
        for (let px = Math.floor((x - radius) / PIXEL_SIZE); px <= Math.floor((x + radius) / PIXEL_SIZE); px++) {
          if (px < 0 || py < 0 || px >= MAP_WIDTH || py >= MAP_HEIGHT) continue;
          const i = py * MAP_WIDTH + px;
          if (cache.has(i)) continue;
          if (!pending.has(i)) {
            pending.set(i, woods.prefetch([{ px, py }]).then(() => {
              cache.set(i, generateSamples(woods, px, py, STEP, STEP));
              sampler.version++;
            }).finally(() => pending.delete(i)));
          }
          jobs.push(pending.get(i));
        }
      }
      await Promise.all(jobs);
    },
  };
  void HDIM;
  return sampler;
}
