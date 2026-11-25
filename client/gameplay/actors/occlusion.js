// Line-of-sight test against the town mesh, used so the crosshair never
// targets an actor hidden behind a building. Triangles are bucketed on an xz
// grid; a segment walks the cells it crosses and tests only those triangles.

export class Occluder {
  /** @param {Float32Array|number[]} positions non-indexed triangle list (x,y,z per vertex) */
  constructor(positions, cell = 4) {
    this.p = positions;
    this.cell = cell;
    this.cells = new Map();
    const p = positions;
    const n = Math.floor(p.length / 9);
    this.stamp = new Uint32Array(n);
    this.tick = 0;
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const x0 = Math.floor(Math.min(p[o], p[o + 3], p[o + 6]) / cell), x1 = Math.floor(Math.max(p[o], p[o + 3], p[o + 6]) / cell);
      const z0 = Math.floor(Math.min(p[o + 2], p[o + 5], p[o + 8]) / cell), z1 = Math.floor(Math.max(p[o + 2], p[o + 5], p[o + 8]) / cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) continue;
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(t);
      }
    }
  }

  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }

  /** True when a triangle crosses the open segment a→b (endpoints excluded by `margin` metres). */
  blocked(a, b, margin = 0.15) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len <= margin * 2) return false;
    const tMin = margin / len, tMax = 1 - margin / len;
    if (++this.tick === 0xffffffff) { this.stamp.fill(0); this.tick = 1; }
    const c = this.cell;
    // Amanatides-Woo walk over xz cells.
    let ix = Math.floor(a[0] / c), iz = Math.floor(a[2] / c);
    const ex = Math.floor(b[0] / c), ez = Math.floor(b[2] / c);
    const sx = Math.sign(dx), sz = Math.sign(dz);
    const tdx = sx ? Math.abs(c / dx) : Infinity, tdz = sz ? Math.abs(c / dz) : Infinity;
    let tx = sx ? ((sx > 0 ? (ix + 1) * c : ix * c) - a[0]) / dx : Infinity;
    let tz = sz ? ((sz > 0 ? (iz + 1) * c : iz * c) - a[2]) / dz : Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      const list = this.cells.get(this.key(ix, iz));
      if (list && this.#hitList(list, a, dx, dy, dz, tMin, tMax)) return true;
      if ((ix === ex && iz === ez) || Math.min(tx, tz) > 1) break;
      if (tx < tz) { ix += sx; tx += tdx; } else { iz += sz; tz += tdz; }
    }
    return false;
  }

  #hitList(list, a, dx, dy, dz, tMin, tMax) {
    const p = this.p;
    for (const t of list) {
      if (this.stamp[t] === this.tick) continue;
      this.stamp[t] = this.tick;
      const o = t * 9;
      // Möller–Trumbore, two-sided.
      const e1x = p[o + 3] - p[o], e1y = p[o + 4] - p[o + 1], e1z = p[o + 5] - p[o + 2];
      const e2x = p[o + 6] - p[o], e2y = p[o + 7] - p[o + 1], e2z = p[o + 8] - p[o + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = a[0] - p[o], ty = a[1] - p[o + 1], tz = a[2] - p[o + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt > tMin && tt < tMax) return true;
    }
    return false;
  }
}
