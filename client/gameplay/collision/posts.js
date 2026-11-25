// Upright cylinders ("posts") for CollisionWorld: the solid flats of client/world/scenery/colliders.js
// (tree trunks, rocks, wells, barrels, lamp posts). A flat is a camera-facing sprite, so its body is
// a vertical cylinder about its base rather than triangles. Posts block movement and sight exactly
// like a solid triangle: only where they overlap the body's slab above the step height. They have
// no top surface, so nobody stands on them.
//
// Layout: CYLINDER_STRIDE floats per post (x, z, y0, y1, r), indexed in a uniform CSR grid.

export const POST_STRIDE = 5;
/** sin of the half-angle (20°) within which a walk into a post counts as head-on and stops. */
const HEAD_ON = Math.sin((20 * Math.PI) / 180);

export class PostIndex {
  /** @param {Float32Array} c x, z, y0, y1, r per post */
  constructor(c, cell = 8) {
    const n = (this.count = Math.floor(c.length / POST_STRIDE));
    this.c = c;
    this.cell = cell;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, maxR = 0;
    for (let i = 0; i < n; i++) {
      const o = i * POST_STRIDE, r = c[o + 4];
      minX = Math.min(minX, c[o] - r); maxX = Math.max(maxX, c[o] + r);
      minZ = Math.min(minZ, c[o + 1] - r); maxZ = Math.max(maxZ, c[o + 1] + r);
      maxR = Math.max(maxR, r);
    }
    if (!n) minX = maxX = minZ = maxZ = 0;
    this.maxR = maxR;
    this.ox = Math.floor(minX / cell) * cell;
    this.oz = Math.floor(minZ / cell) * cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.ox) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - this.oz) / cell) + 1);
    const cells = this.nx * this.nz;
    const start = new Uint32Array(cells + 1);
    const each = (fn) => {
      for (let i = 0; i < n; i++) {
        const o = i * POST_STRIDE, r = c[o + 4];
        const x0 = this.#cx(c[o] - r), x1 = this.#cx(c[o] + r), z0 = this.#cz(c[o + 1] - r), z1 = this.#cz(c[o + 1] + r);
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(z * this.nx + x, i);
      }
    };
    each((k) => start[k + 1]++);
    for (let k = 1; k <= cells; k++) start[k] += start[k - 1];
    const items = new Int32Array(start[cells]);
    const fill = start.slice(0, cells);
    each((k, i) => { items[fill[k]++] = i; });
    this.start = start;
    this.items = items;
    this.stamp = new Uint32Array(n);
    this.stampId = 0;
    this.cand = new Int32Array(64);
  }

  #cx(x) { return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.ox) / this.cell))); }
  #cz(z) { return Math.max(0, Math.min(this.nz - 1, Math.floor((z - this.oz) / this.cell))); }

  /** Unique post ids overlapping the XZ rectangle; returns the count in this.cand. */
  gather(x0, z0, x1, z1) {
    if (!this.count) return 0;
    if (++this.stampId === 0xffffffff) { this.stamp.fill(0); this.stampId = 1; }
    let n = 0;
    const cx0 = this.#cx(x0), cx1 = this.#cx(x1), cz0 = this.#cz(z0), cz1 = this.#cz(z1);
    for (let z = cz0; z <= cz1; z++) {
      for (let x = cx0; x <= cx1; x++) {
        const k = z * this.nx + x;
        for (let j = this.start[k], e = this.start[k + 1]; j < e; j++) {
          const i = this.items[j];
          if (this.stamp[i] === this.stampId) continue;
          this.stamp[i] = this.stampId;
          if (n >= this.cand.length) { const g = new Int32Array(n * 2); g.set(this.cand); this.cand = g; }
          this.cand[n++] = i;
        }
      }
    }
    return n;
  }

  /** Deepest overlap of a circle (x, z, r) with posts crossing the slab (lo, hi); null when clear. */
  deepest(x, z, r, lo, hi, prevX, prevZ) {
    const n = this.gather(x - r, z - r, x + r, z + r);
    const c = this.c;
    let best = null;
    for (let k = 0; k < n; k++) {
      const o = this.cand[k] * POST_STRIDE;
      if (c[o + 3] <= lo || c[o + 2] >= hi) continue;
      const dx = x - c[o], dz = z - c[o + 1], R = c[o + 4] + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      const d = Math.sqrt(d2);
      // Head-on (within HEAD_ON of the centre line): push straight back along the motion so a
      // walker stops at the trunk instead of the radial normal steering it round the circle.
      const mx = x - prevX, mz = z - prevZ, ml = Math.hypot(mx, mz);
      if (ml > 1e-9) {
        const ux = mx / ml, uz = mz / ml, pu = dx * ux + dz * uz;
        if (pu < 0 && Math.abs(dx * uz - dz * ux) < HEAD_ON * R) {
          const depth = pu + Math.sqrt(Math.max(0, pu * pu - d2 + R * R));
          if (!best || depth > best.depth) best = { depth, nx: -ux, nz: -uz };
          continue;
        }
      }
      let nx, nz;
      if (d > 1e-7) { nx = dx / d; nz = dz / d; }
      else {
        nx = prevX - c[o]; nz = prevZ - c[o + 1];
        const l = Math.hypot(nx, nz);
        if (l > 1e-9) { nx /= l; nz /= l; } else { nx = 1; nz = 0; }
      }
      const depth = R - d;
      if (!best || depth > best.depth) best = { depth, nx, nz };
    }
    return best;
  }

  /** True when the segment a→b enters a post's disc (centre line, not inflated) in the slab (lo, hi). */
  crosses(ax, az, bx, bz, lo, hi) {
    const n = this.gather(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
    const c = this.c;
    for (let k = 0; k < n; k++) {
      const o = this.cand[k] * POST_STRIDE;
      if (c[o + 3] <= lo || c[o + 2] >= hi) continue;
      const R2 = c[o + 4] * c[o + 4];
      const px = ax - c[o], pz = az - c[o + 1];
      if (px * px + pz * pz <= R2) continue; // escaping from inside is allowed
      const ex = bx - ax, ez = bz - az, ll = ex * ex + ez * ez;
      let t = ll > 0 ? -(px * ex + pz * ez) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px + ex * t, qz = pz + ez * t;
      if (qx * qx + qz * qz < R2) return true;
    }
    return false;
  }

  /** True when the open 3D segment passes through a post. */
  blocksSegment(x1, y1, z1, x2, y2, z2) {
    if (!this.count) return false;
    const n = this.gather(Math.min(x1, x2), Math.min(z1, z2), Math.max(x1, x2), Math.max(z1, z2));
    const c = this.c;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const a = dx * dx + dz * dz;
    for (let k = 0; k < n; k++) {
      const o = this.cand[k] * POST_STRIDE;
      const px = x1 - c[o], pz = z1 - c[o + 1], R = c[o + 4];
      const cc = px * px + pz * pz - R * R;
      let t0, t1;
      if (a < 1e-12) {
        if (cc >= 0) continue;
        t0 = 0; t1 = 1;
      } else {
        const b = 2 * (px * dx + pz * dz);
        const disc = b * b - 4 * a * cc;
        if (disc <= 0) continue;
        const s = Math.sqrt(disc);
        t0 = Math.max(1e-6, (-b - s) / (2 * a));
        t1 = Math.min(1 - 1e-6, (-b + s) / (2 * a));
        if (t0 >= t1) continue;
      }
      const ya = y1 + dy * t0, yb = y1 + dy * t1;
      if (Math.max(ya, yb) > c[o + 2] && Math.min(ya, yb) < c[o + 3]) return true;
    }
    return false;
  }

  get byteSize() {
    return this.c.byteLength + this.start.byteLength + this.items.byteLength + this.stamp.byteLength;
  }
}
