// CollisionWorld: spatial index over renderer triangles (client/world/town.js output) for
// capsule-style horizontal movement, walkable ground and line-of-sight queries.
// DOM-free and Node-free: the browser predicts with it and the server enforces with it,
// so both sides resolve the same geometry with the same rules.
//
// Model: the player is an upright cylinder (radius, height) standing at foot height y.
// A triangle blocks horizontally where it overlaps the slab [y + step, y + height]: the
// triangle is clipped to that slab and its XZ projection is tested against the circle.
// Ground is the highest upward-facing surface at most `step` above the current foot
// height (stairs and kerbs climb, roofs do not). Movement is sub-stepped (< radius / 2 per
// step) and every step is also checked for crossing an obstacle edge, so thin walls cannot
// be tunnelled through at any speed.
//
// Solid flats (trees, rocks, wells, lamp posts: client/world/scenery/colliders.js) arrive as
// upright cylinders in geo.cylinders and follow the same slab, step and sight rules (posts.js).

export const PLAYER = Object.freeze({ radius: 0.35, height: 1.8, step: 0.75, eye: 1.6 });
/** Minimum |normal.y| of a walkable (upward) surface; matches client/lib/ground.js. */
export const WALKABLE_NY = 0.55;
const TOL = 0.01; // accepted residual penetration (m)
const MAX_SUBSTEPS = 256;
const MAX_CELLS_PER_TRI = 20000;
/** Slab floor of an airborne body: anything solid higher than this above the feet blocks it. */
export const FLY_STEP = 0.2;

import { PostIndex } from './posts.js';

const F_WALK = 1; // upward-facing, may be stood on
const F_SOLID = 2; // blocks movement and sight (everything except the ground plane)
const F_GROUND = 4; // ground / terrain triangles (block rays & projectiles, not horizontal body slides)

export class CollisionWorld {
  /**
   * @param {object} geo
   * @param {Float32Array} geo.positions  9 floats per triangle, metres, +y up (town.positions)
   * @param {number} [geo.groundFirstTriangle]  first triangle of the flat ground plane (town.ground.firstTriangle)
   * @param {number} [geo.groundTriangleCount]
   * @param {{minX,maxX,minZ,maxZ}} [geo.walkBounds]  walkable rectangle; defaults to the ground plane's extent
   * @param {string} [geo.name]
   * @param {Float32Array} [geo.cylinders]  solid flats as upright cylinders, 5 floats each: x, z, y0, y1, r
   *   (client/world/scenery/colliders.js); they block movement and sight like solid triangles
   * @param {object} [opts] {cell, player}
   */
  constructor(geo, opts = {}) {
    const P = geo.positions;
    if (!(P instanceof Float32Array) && !Array.isArray(P)) throw new TypeError('positions must be a Float32Array');
    this.name = geo.name ?? '';
    this.positions = P;
    this.entryHeight = geo.entryHeight ?? 0;
    this.player = { ...PLAYER, ...(opts.player || {}) };
    // Town ground ends at a map seam, where a body can straddle both scenes.
    // Its radius still applies to every wall, post and other obstacle.
    this.openEdges = !!geo.openEdges;
    const T = (this.triangleCount = Math.floor(P.length / 9));
    const g0 = geo.groundFirstTriangle ?? T;
    const g1 = g0 + (geo.groundTriangleCount ?? 0);
    const walkGroundEnd = g0 + (geo.walkTriangleCount ?? geo.groundTriangleCount ?? 0);
    this.terrainRange = geo.outdoorTerrain ? [g0, walkGroundEnd] : null;
    this.triangleEnabled = geo.triangleEnabled;
    // Solid flats (client/world/scenery/colliders.js); also when the triangle index came from a worker.
    this.posts = geo.cylinders?.length >= 5 ? new PostIndex(geo.cylinders) : null;
    // Water volumes (dungeon blocks with a start-marker water level): [{minX,maxX,minZ,maxZ,y}], y = surface.
    this.water = Array.isArray(geo.water) ? geo.water.filter((w) => [w.minX, w.maxX, w.minZ, w.maxZ, w.y].every(Number.isFinite)) : [];
    // Body slab overrides used by move()/clearance queries for stances (crouch) and airborne bodies.
    this.slabStep = null;
    this.slabHeight = null;
    if (opts.spatialIndex) Object.assign(this, opts.spatialIndex);
    else this.#indexTriangles(geo, opts.cell ?? 2, g0, g1, walkGroundEnd);
    this.stamp = new Uint32Array(T);
    this.stampId = 0;
    this.cand = new Int32Array(1024);
    this.poly = new Float64Array(16); // clipped XZ polygon scratch (x,z pairs)
  }

  /** Read-only triangle index buffers can be built in a worker. Movement scratch stays per world. */
  spatialIndex() {
    const { bounds, walkBounds, flags, minY, maxY, cell, ox, oz, nx, nz, solid, walk, ground } = this;
    return { bounds, walkBounds, flags, minY, maxY, cell, ox, oz, nx, nz, solid, walk, ground };
  }

  #indexTriangles(geo, cell, g0, g1, walkGroundEnd) {
    const P = this.positions, T = this.triangleCount;
    this.flags = new Uint8Array(T);
    this.minY = new Float32Array(T);
    this.maxY = new Float32Array(T);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let gMinX = Infinity, gMaxX = -Infinity, gMinZ = Infinity, gMaxZ = -Infinity;
    for (let t = 0; t < T; t++) {
      // The render-only horizon has no walkable surface or solids on the server.
      // Leave it out of both spatial indexes and their bounds on the client.
      if (t >= walkGroundEnd && t < g1) continue;
      const o = t * 9;
      const ax = P[o], ay = P[o + 1], az = P[o + 2];
      const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
      const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-9)) continue; // degenerate
      const ground = t >= g0 && t < g1;
      // Winding is not reliable for walkability (single-sided props, flipped planes), so any
      // near-horizontal face can be stood on, as in client/lib/ground.js.
      let f = Math.abs(ny) / len >= WALKABLE_NY ? F_WALK : 0;
      if (ground) f |= F_GROUND;
      else f |= F_SOLID;
      this.flags[t] = f;
      this.minY[t] = Math.min(ay, by, cy);
      this.maxY[t] = Math.max(ay, by, cy);
      const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx);
      const z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
      if (x0 < minX) minX = x0;
      if (x1 > maxX) maxX = x1;
      if (z0 < minZ) minZ = z0;
      if (z1 > maxZ) maxZ = z1;
      if (ground) {
        if (x0 < gMinX) gMinX = x0;
        if (x1 > gMaxX) gMaxX = x1;
        if (z0 < gMinZ) gMinZ = z0;
        if (z1 > gMaxZ) gMaxZ = z1;
      }
    }
    if (!Number.isFinite(minX)) minX = maxX = minZ = maxZ = 0;
    this.bounds = { minX, maxX, minZ, maxZ };
    this.walkBounds = geo.walkBounds
      ? { ...geo.walkBounds }
      : Number.isFinite(gMinX)
        ? { minX: gMinX, maxX: gMaxX, minZ: gMinZ, maxZ: gMaxZ }
        : { ...this.bounds };

    this.cell = cell;
    this.ox = Math.floor(minX / cell) * cell;
    this.oz = Math.floor(minZ / cell) * cell;
    this.nx = Math.max(1, Math.ceil((maxX - this.ox) / cell) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ - this.oz) / cell) + 1);
    this.solid = this.#buildGrid(F_SOLID);
    this.walk = this.#buildGrid(F_WALK);
    this.ground = this.#buildGrid(F_GROUND);
  }

  /** CSR grid of triangles with any of `mask` flags. Oversized triangles go to `big`. */
  #buildGrid(mask) {
    const { cell, ox, oz, nx, nz, positions: P, flags } = this;
    const T = this.triangleCount;
    const counts = new Uint32Array(nx * nz + 1);
    const big = [];
    const range = (t) => {
      const o = t * 9;
      const cx0 = Math.max(0, Math.floor((Math.min(P[o], P[o + 3], P[o + 6]) - ox) / cell));
      const cx1 = Math.min(nx - 1, Math.floor((Math.max(P[o], P[o + 3], P[o + 6]) - ox) / cell));
      const cz0 = Math.max(0, Math.floor((Math.min(P[o + 2], P[o + 5], P[o + 8]) - oz) / cell));
      const cz1 = Math.min(nz - 1, Math.floor((Math.max(P[o + 2], P[o + 5], P[o + 8]) - oz) / cell));
      return [cx0, cx1, cz0, cz1];
    };
    for (let t = 0; t < T; t++) {
      if (!(flags[t] & mask)) continue;
      const [cx0, cx1, cz0, cz1] = range(t);
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_CELLS_PER_TRI) {
        big.push(t);
        continue;
      }
      for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) counts[z * nx + x + 1]++;
    }
    for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
    const items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, nx * nz);
    const bigSet = new Set(big);
    for (let t = 0; t < T; t++) {
      if (!(flags[t] & mask) || bigSet.has(t)) continue;
      const [cx0, cx1, cz0, cz1] = range(t);
      for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) items[fill[z * nx + x]++] = t;
    }
    return { start: counts, items, big: Int32Array.from(big) };
  }

  // ---- candidate gathering ------------------------------------------------------------------

  #push(t, n) {
    if (this.stamp[t] === this.stampId || this.triangleEnabled?.(t) === false) return n;
    this.stamp[t] = this.stampId;
    if (n >= this.cand.length) {
      const c = new Int32Array(this.cand.length * 2);
      c.set(this.cand);
      this.cand = c;
    }
    this.cand[n] = t;
    return n + 1;
  }

  #nextStamp() {
    if (++this.stampId === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
  }

  /** Unique triangle ids of `grid` overlapping the XZ rectangle; returns count in this.cand. */
  #gather(grid, x0, z0, x1, z1) {
    this.#nextStamp();
    const { cell, ox, oz, nx, nz } = this;
    let n = 0;
    const cx0 = Math.max(0, Math.floor((x0 - ox) / cell)), cx1 = Math.min(nx - 1, Math.floor((x1 - ox) / cell));
    const cz0 = Math.max(0, Math.floor((z0 - oz) / cell)), cz1 = Math.min(nz - 1, Math.floor((z1 - oz) / cell));
    for (let z = cz0; z <= cz1; z++) {
      for (let x = cx0; x <= cx1; x++) {
        const c = z * nx + x;
        for (let i = grid.start[c], e = grid.start[c + 1]; i < e; i++) n = this.#push(grid.items[i], n);
      }
    }
    for (let i = 0; i < grid.big.length; i++) n = this.#push(grid.big[i], n);
    return n;
  }

  // ---- ground ------------------------------------------------------------------------------

  /** Heights of every walkable surface under (x, z). */
  heightsAt(x, z, triangleRange = null) {
    // Point query: one cell, so no dedupe is needed and the shared candidate buffer
    // (in use by move()) is left alone.
    const out = [];
    const P = this.positions;
    const { cell, ox, oz, nx, nz, walk } = this;
    const gx = Math.floor((x - ox) / cell), gz = Math.floor((z - oz) / cell);
    const ids = [];
    if (gx >= 0 && gz >= 0 && gx < nx && gz < nz) {
      const c = gz * nx + gx;
      for (let i = walk.start[c], e = walk.start[c + 1]; i < e; i++) ids.push(walk.items[i]);
    }
    for (let i = 0; i < walk.big.length; i++) ids.push(walk.big[i]);
    for (const t of ids) {
      if (this.triangleEnabled?.(t) === false) continue;
      if (triangleRange && (t < triangleRange[0] || t >= triangleRange[1])) continue;
      const o = t * 9;
      const ax = P[o], az = P[o + 2], bx = P[o + 3], bz = P[o + 5], cx = P[o + 6], cz = P[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
      out.push(w1 * P[o + 1] + w2 * P[o + 4] + w3 * P[o + 7]);
    }
    return out;
  }

  /**
   * Foot height at (x, z) for a body currently at `refY` (null: initial placement, lowest
   * surface). Returns null when nothing walkable is under the point.
   */
  heightAt(x, z, refY = null) {
    const hs = this.heightsAt(x, z);
    if (!hs.length) return null;
    if (refY === null || refY === undefined) return Math.min(...hs);
    let best = null;
    for (const h of hs) if (h <= refY + this.player.step && (best === null || h > best)) best = h;
    return best;
  }

  #movementHeight(x, z, y, waterWalk) {
    const floor = this.heightAt(x, z, y);
    const surface = waterWalk ? this.waterAt(x, z) : null;
    if (surface === null || surface > y + 0.05) return floor;
    return floor === null ? surface : Math.max(floor, surface);
  }

  /** Foot height for a new body, using the terrain or the instance's entry floor as its reference. */
  standHeight(x, z) {
    if (this.terrainRange) {
      const [terrain] = this.heightsAt(x, z, this.terrainRange);
      if (Number.isFinite(terrain)) return this.heightAt(x, z, terrain) ?? terrain;
    }
    return this.heightAt(x, z, this.entryHeight) ?? this.heightAt(x, z, null) ?? this.entryHeight;
  }

  inBounds(x, z, r = this.player.radius) {
    const b = this.walkBounds;
    if (this.openEdges) r = -0.0001; // float32 ground vertices against the map frame
    return x >= b.minX + r && x <= b.maxX - r && z >= b.minZ + r && z <= b.maxZ - r;
  }

  // ---- horizontal collision ----------------------------------------------------------------

  /** Clip triangle t to the slab lo < y < hi; writes its XZ outline to this.poly; returns vertex count. */
  #clip(t, lo, hi) {
    const P = this.positions;
    const o = t * 9;
    const poly = this.poly;
    if (this.minY[t] >= lo && this.maxY[t] <= hi) {
      poly[0] = P[o]; poly[1] = P[o + 2];
      poly[2] = P[o + 3]; poly[3] = P[o + 5];
      poly[4] = P[o + 6]; poly[5] = P[o + 8];
      return 3;
    }
    // Sutherland–Hodgman against y >= lo then y <= hi, on 3D points.
    let a = [[P[o], P[o + 1], P[o + 2]], [P[o + 3], P[o + 4], P[o + 5]], [P[o + 6], P[o + 7], P[o + 8]]];
    const cut = (input, keep, edge) => {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        const p = input[i], q = input[(i + 1) % input.length];
        const pin = keep(p[1]), qin = keep(q[1]);
        if (pin) out.push(p);
        if (pin !== qin) {
          const k = (edge - p[1]) / (q[1] - p[1]);
          out.push([p[0] + (q[0] - p[0]) * k, edge, p[2] + (q[2] - p[2]) * k]);
        }
      }
      return out;
    };
    a = cut(a, (y) => y >= lo, lo);
    if (a.length >= 2) a = cut(a, (y) => y <= hi, hi);
    for (let i = 0; i < a.length && i < 8; i++) {
      poly[i * 2] = a[i][0];
      poly[i * 2 + 1] = a[i][2];
    }
    return Math.min(a.length, 8);
  }

  /**
   * Penetration of a circle (x, z, r) into the clipped polygon (n points in this.poly).
   * Returns null when separated, else {depth, nx, nz} (push direction, unit).
   * prevX/prevZ disambiguate the side when the centre lies on or inside the outline.
   */
  #contact(n, x, z, r, prevX, prevZ) {
    const poly = this.poly;
    if (n === 0) return null;
    // Signed area to detect a real 2D footprint (vs a vertical wall seen edge-on).
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
    }
    let best = Infinity, bx = 0, bz = 0;
    const edges = n <= 2 ? 1 : n;
    for (let i = 0; i < edges; i++) {
      const j = n === 1 ? 0 : (i + 1) % n;
      const ax = poly[i * 2], az = poly[i * 2 + 1], ex = poly[j * 2] - ax, ez = poly[j * 2 + 1] - az;
      const ll = ex * ex + ez * ez;
      let k = ll > 0 ? ((x - ax) * ex + (z - az) * ez) / ll : 0;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const px = ax + ex * k, pz = az + ez * k;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d;
        bx = px;
        bz = pz;
      }
    }
    const inside = Math.abs(area2) > 1e-6 && pointInPoly(poly, n, x, z);
    const dist = Math.sqrt(best);
    if (!inside && dist >= r) return null;
    let nx, nz;
    if (inside) {
      // Leave through the edge nearest the previous position when that lies outside, else the nearest edge.
      const prevInside = pointInPoly(poly, n, prevX, prevZ);
      if (!prevInside) {
        let bd = Infinity;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = poly[i * 2], az = poly[i * 2 + 1];
          if (!segIntersect(x, z, prevX, prevZ, ax, az, poly[j * 2], poly[j * 2 + 1])) continue;
          const ex = poly[j * 2] - ax, ez = poly[j * 2 + 1] - az;
          const ll = Math.hypot(ex, ez) || 1;
          // outward normal (sign by orientation)
          let ox = ez / ll, oz = -ex / ll;
          if (area2 < 0) { ox = -ox; oz = -oz; }
          const d = (x - ax) * -ox + (z - az) * -oz; // distance inside along normal
          if (d < bd) { bd = d; nx = ox; nz = oz; }
        }
        if (nx !== undefined) return { depth: bd + r, nx, nz };
      }
      nx = bx - x;
      nz = bz - z;
      const l = Math.hypot(nx, nz) || 1;
      return { depth: dist + r, nx: nx / l, nz: nz / l };
    }
    if (dist > 1e-7) {
      nx = (x - bx) / dist;
      nz = (z - bz) / dist;
    } else {
      nx = prevX - x;
      nz = prevZ - z;
      let l = Math.hypot(nx, nz);
      if (l < 1e-9 && n >= 2) {
        nx = -(poly[3] - poly[1]);
        nz = poly[2] - poly[0];
        l = Math.hypot(nx, nz);
      }
      if (l < 1e-9) { nx = 1; nz = 0; l = 1; }
      nx /= l;
      nz /= l;
    }
    return { depth: r - dist, nx, nz };
  }

  /** Deepest penetration at (x, z) for foot height y among `n` gathered candidates. */
  #deepest(n, x, z, y, r, prevX, prevZ) {
    const lo = y + (this.slabStep ?? this.player.step), hi = y + (this.slabHeight ?? this.player.height);
    let best = null;
    for (let i = 0; i < n; i++) {
      const t = this.cand[i];
      if (this.maxY[t] <= lo || this.minY[t] >= hi) continue;
      const m = this.#clip(t, lo, hi);
      if (m === 0) continue;
      const c = this.#contact(m, x, z, r, prevX, prevZ);
      if (c && (!best || c.depth > best.depth)) best = c;
    }
    if (this.posts) {
      const c = this.posts.deepest(x, z, r, lo, hi, prevX, prevZ);
      if (c && (!best || c.depth > best.depth)) best = c;
    }
    return best;
  }

  #stepContact(n, x, z, targetY, r, prevX, prevZ, fromY) {
    const contact = this.#deepest(n, x, z, targetY, r, prevX, prevZ);
    if (fromY - targetY <= (this.slabStep ?? this.player.step)) return contact;
    // A drop can put the destination floor below a wall's base. Clear the body's
    // footprint at the takeoff height before letting its feet leave the ledge.
    const ledge = this.#deepest(n, x, z, fromY, r, prevX, prevZ);
    return ledge && (!contact || ledge.depth > contact.depth) ? ledge : contact;
  }

  /** True when the segment a→b crosses an obstacle outline at foot height y (anti-tunnelling). */
  #crosses(n, ax, az, bx, bz, y) {
    const lo = y + (this.slabStep ?? this.player.step), hi = y + (this.slabHeight ?? this.player.height);
    const poly = this.poly;
    for (let i = 0; i < n; i++) {
      const t = this.cand[i];
      if (this.maxY[t] <= lo || this.minY[t] >= hi) continue;
      const m = this.#clip(t, lo, hi);
      if (m < 2) continue;
      if (m >= 3 && pointInPoly(poly, m, ax, az)) continue; // escaping from inside a footprint is allowed
      const edges = m === 2 ? 1 : m;
      for (let k = 0; k < edges; k++) {
        const j = (k + 1) % m;
        if (segIntersect(ax, az, bx, bz, poly[k * 2], poly[k * 2 + 1], poly[j * 2], poly[j * 2 + 1])) return true;
      }
    }
    return !!this.posts?.crosses(ax, az, bx, bz, lo, hi);
  }

  /** Penetration depth (m) of a body at (x, z, y); 0 when clear. */
  penetration(x, z, y, r = this.player.radius) {
    const n = this.#gather(this.solid, x - r, z - r, x + r, z + r);
    const c = this.#deepest(n, x, z, y, r, x, z);
    return c ? Math.max(0, c.depth) : 0;
  }

  /** A body of radius r can stand at (x, z) near height y: inside bounds, on a surface, not overlapping. */
  isClear(x, z, y = null, r = this.player.radius) {
    if (!this.inBounds(x, z, r)) return false;
    const h = y === null ? this.standHeight(x, z) : this.heightAt(x, z, y);
    if (h === null) return false;
    return this.penetration(x, z, h, r) <= TOL;
  }

  /** Nearest clear point within maxDist (ring search), or null. */
  nearestClear(x, z, { y = null, maxDist = 8, r = this.player.radius, step = 0.25 } = {}) {
    if (this.isClear(x, z, y, r)) return { x, z };
    for (let d = step; d <= maxDist; d += step) {
      const k = Math.max(8, Math.ceil((2 * Math.PI * d) / step));
      for (let i = 0; i < k; i++) {
        const a = (i / k) * 2 * Math.PI;
        const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
        if (this.isClear(px, pz, y, r)) return { x: px, z: pz };
      }
    }
    return null;
  }

  /**
   * Move a body from (x0, z0) toward (x1, z1), sliding along walls.
   * @param {{y?: number|null}} [state] foot height; updated in place
   * @returns {{x:number, z:number, y:number, blocked:boolean}}
   */
  // ---- vertical queries (client/lib/locomotion.js) -------------------------------------------

  /** Highest walkable surface at or below foot height y (+ a small tolerance), or null. */
  floorBelow(x, z, y, tol = 0.05) {
    let best = null;
    for (const h of this.heightsAt(x, z)) if (h <= y + tol && (best === null || h > best)) best = h;
    return best;
  }

  /** A body of `height` fits at (x, z) with its feet at y: nothing solid overlaps [y + step, y + height]. */
  fits(x, z, y, { height = this.player.height, step = FLY_STEP, r = this.player.radius } = {}) {
    const ps = this.slabStep, ph = this.slabHeight;
    this.slabStep = step; this.slabHeight = height;
    try {
      return this.penetration(x, z, y, r) <= TOL;
    } finally {
      this.slabStep = ps; this.slabHeight = ph;
    }
  }

  /** Water surface height over (x, z), or null when the point is not in a water volume. */
  waterAt(x, z) {
    let best = null;
    for (const w of this.water) {
      if (x < w.minX || x > w.maxX || z < w.minZ || z > w.maxZ) continue;
      if (best === null || w.y > best) best = w.y;
    }
    return best;
  }

  /**
   * Horizontal sweep. `state.y` is the foot height (updated). Optional body overrides:
   * `state.height` (crouching), `state.step` (climbable rise), and `state.fly` (airborne, swimming,
   * climbing or levitating: the body keeps its height instead of following the ground, and the
   * whole slab above `step` blocks), and `state.waterWalk` (surface support for Water Walking).
   */
  move(x0, z0, x1, z1, state = {}) {
    if (state.height == null && state.step == null && !state.fly) return this.#move(x0, z0, x1, z1, state);
    const ps = this.slabStep, ph = this.slabHeight;
    this.slabStep = Number.isFinite(state.step) ? state.step : state.fly ? FLY_STEP : null;
    this.slabHeight = Number.isFinite(state.height) ? state.height : null;
    try {
      return this.#move(x0, z0, x1, z1, state);
    } finally {
      this.slabStep = ps;
      this.slabHeight = ph;
    }
  }

  #move(x0, z0, x1, z1, state) {
    const r = this.player.radius;
    const fly = !!state.fly;
    let y = state.y;
    if (y === null || y === undefined || !Number.isFinite(y)) y = this.standHeight(x0, z0);
    const dx = x1 - x0, dz = z1 - z0;
    const dist = Math.hypot(dx, dz);
    let cx = x0, cz = z0;
    let blocked = false;
    if (dist > 1e-9) {
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dist / (r * 0.5))));
      const sx = dx / steps, sz = dz / steps;
      const reach = r * 3 + Math.hypot(sx, sz);
      let pen = this.penetration(cx, cz, y, r);
      const b = this.walkBounds;
      const inset = this.openEdges ? 0 : r;
      for (let i = 0; i < steps; i++) {
        // From the origin while unobstructed so a clear move lands exactly on its target.
        let tx = blocked ? cx + sx : x0 + (dx * (i + 1)) / steps;
        let tz = blocked ? cz + sz : z0 + (dz * (i + 1)) / steps;
        // Bounds never pull a body in from outside; they only stop it from going further out.
        tx = clampOut(tx, cx, b.minX + inset, b.maxX - inset);
        tz = clampOut(tz, cz, b.minZ + inset, b.maxZ - inset);
        const n = this.#gather(this.solid, Math.min(cx, tx) - reach, Math.min(cz, tz) - reach, Math.max(cx, tx) + reach, Math.max(cz, tz) + reach);
        let ty = fly ? y : this.#movementHeight(tx, tz, y, state.waterWalk);
        if (ty === null) { blocked = true; break; }
        let floorless = false;
        for (let it = 0; it < 4; it++) {
          const c = this.#stepContact(n, tx, tz, ty, r, cx, cz, y);
          if (!c || c.depth <= 1e-5) break;
          tx += c.nx * (c.depth + 1e-4);
          tz += c.nz * (c.depth + 1e-4);
          blocked = true;
          tx = clampOut(tx, cx, b.minX + inset, b.maxX - inset);
          tz = clampOut(tz, cz, b.minZ + inset, b.maxZ - inset);
          const h = fly ? y : this.#movementHeight(tx, tz, y, state.waterWalk);
          if (h === null) { floorless = true; break; }
          ty = h;
        }
        if (floorless) { blocked = true; break; }
        const np = this.#stepContact(n, tx, tz, ty, r, cx, cz, y);
        const npen = np ? Math.max(0, np.depth) : 0;
        if (npen > Math.max(TOL, pen + 1e-6) || this.#crosses(n, cx, cz, tx, tz, y)) {
          blocked = true;
          break;
        }
        if (tx === cx && tz === cz) break;
        cx = tx;
        cz = tz;
        y = ty;
        pen = npen;
      }
    }
    state.y = y;
    return { x: cx, z: cz, y, blocked };
  }

  // ---- line of sight -----------------------------------------------------------------------

  /** True when no solid or ground triangle intersects the open segment between two 3D points. */
  segmentClear(x1, y1, z1, x2, y2, z2, ignoreTriangle) {
    if (this.posts?.blocksSegment(x1, y1, z1, x2, y2, z2)) return false;
    const P = this.positions;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    this.#nextStamp();
    const test = (t) => {
      if (this.stamp[t] === this.stampId || this.triangleEnabled?.(t) === false || ignoreTriangle?.(t)) return false;
      this.stamp[t] = this.stampId;
      const o = t * 9;
      return segTri(x1, y1, z1, dx, dy, dz, P, o);
    };
    const ground = this.ground;
    for (let i = 0; i < this.solid.big.length; i++) if (test(this.solid.big[i])) return false;
    if (ground) for (let i = 0; i < ground.big.length; i++) if (test(ground.big[i])) return false;
    const testCell = (c) => {
      for (let i = this.solid.start[c], e = this.solid.start[c + 1]; i < e; i++) if (test(this.solid.items[i])) return true;
      if (ground) for (let i = ground.start[c], e = ground.start[c + 1]; i < e; i++) if (test(ground.items[i])) return true;
      return false;
    };
    // Amanatides–Woo traversal of the XZ grid.
    const { cell, ox, oz, nx, nz } = this;
    let cx = Math.floor((x1 - ox) / cell), cz = Math.floor((z1 - oz) / cell);
    const ex = Math.floor((x2 - ox) / cell), ez = Math.floor((z2 - oz) / cell);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX ? Math.abs(cell / dx) : Infinity, tDeltaZ = stepZ ? Math.abs(cell / dz) : Infinity;
    let tMaxX = stepX ? ((ox + (cx + (stepX > 0 ? 1 : 0)) * cell - x1) / dx) : Infinity;
    let tMaxZ = stepZ ? ((oz + (cz + (stepZ > 0 ? 1 : 0)) * cell - z1) / dz) : Infinity;
    for (let guard = 0; guard < 100000; guard++) {
      if (cx >= 0 && cz >= 0 && cx < nx && cz < nz && testCell(cz * nx + cx)) return false;
      if (cx === ex && cz === ez) break;
      if (tMaxX > 1 && tMaxZ > 1) break;
      if (tMaxX < tMaxZ) { cx += stepX; tMaxX += tDeltaX; }
      else if (tMaxZ < tMaxX) { cz += stepZ; tMaxZ += tDeltaZ; }
      else {
        // Exactly through a corner: visit both side cells (supercover).
        for (const [qx, qz] of [[cx + stepX, cz], [cx, cz + stepZ]]) {
          if (qx >= 0 && qz >= 0 && qx < nx && qz < nz && testCell(qz * nx + qx)) return false;
        }
        cx += stepX; cz += stepZ; tMaxX += tDeltaX; tMaxZ += tDeltaZ;
      }
    }
    return true;
  }

  /**
   * Eye-to-eye visibility between two ground positions.
   * @param {{y1?:number, y2?:number, eye?:number, eye2?:number}} [o] foot heights (default: street level) and eye height
   */
  canSee(x1, z1, x2, z2, o = {}) {
    const eye = o.eye ?? this.player.eye;
    const y1 = (o.y1 ?? this.standHeight(x1, z1)) + eye;
    const y2 = (o.y2 ?? this.standHeight(x2, z2)) + (o.eye2 ?? eye);
    return this.segmentClear(x1, y1, z1, x2, y2, z2);
  }

  /** Approximate retained memory (bytes) of the index and geometry. */
  get byteSize() {
    const g = (q) => q.start.byteLength + q.items.byteLength + q.big.byteLength;
    return this.positions.byteLength + this.flags.byteLength + this.minY.byteLength * 2 + this.stamp.byteLength + g(this.solid) + g(this.walk) + (this.ground ? g(this.ground) : 0) + (this.posts?.byteSize ?? 0);
  }
}

/** Keep `t` inside [lo, hi] unless the body is already outside on that side, then only forbid moving further out. */
function clampOut(t, c, lo, hi) {
  if (t < lo) return Math.max(t, Math.min(c, lo));
  if (t > hi) return Math.min(t, Math.max(c, hi));
  return t;
}

function pointInPoly(poly, n, x, z) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], zi = poly[i * 2 + 1], xj = poly[j * 2], zj = poly[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Proper or touching intersection of segments ab and cd in 2D. */
function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = orient(cx, cz, dx, dz, ax, az), d2 = orient(cx, cz, dx, dz, bx, bz);
  const d3 = orient(ax, az, bx, bz, cx, cz), d4 = orient(ax, az, bx, bz, dx, dz);
  const e = 1e-12;
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

const orient = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);

/** Möller–Trumbore for the open segment o + s·d, s ∈ (0, 1), against triangle at P[o9]. Two-sided. */
function segTri(ox, oy, oz, dx, dy, dz, P, k) {
  const ax = P[k], ay = P[k + 1], az = P[k + 2];
  const e1x = P[k + 3] - ax, e1y = P[k + 4] - ay, e1z = P[k + 5] - az;
  const e2x = P[k + 6] - ax, e2y = P[k + 7] - ay, e2z = P[k + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return s > 1e-6 && s < 1 - 1e-6;
}

/** Build a world from loadTown() output, keeping only geometry (no atlas, uv or colours). */
export function worldFromTown(town, opts = {}) {
  const { mechanismActive, ...worldOptions } = opts;
  const dynamic = town.mechanisms?.filter((m) => m.alternate?.length);
  let positions = town.positions;
  let triangleEnabled;
  let mechanismAt;
  if (mechanismActive && dynamic?.length) {
    const length = dynamic.reduce((n, m) => n + (m.door || m.linkedDoor ? 0 : m.alternate.length), positions.length);
    positions = new Float32Array(length);
    positions.set(town.positions);
    const state = new Int32Array(length / 9);
    let offset = town.positions.length;
    for (const [i, m] of dynamic.entries()) {
      state.fill(-i - 1, m.firstTriangle, m.firstTriangle + m.triangleCount);
      // In DFU open hinged doors are trigger-only. Moving geometry remains solid.
      if (!m.door && !m.linkedDoor) {
        positions.set(m.alternate, offset);
        state.fill(i + 1, offset / 9, (offset + m.alternate.length) / 9);
        offset += m.alternate.length;
      }
    }
    triangleEnabled = (t) => {
      const index = state[t];
      if (!index) return true;
      return !!mechanismActive(dynamic[Math.abs(index) - 1].id) === (index > 0);
    };
    mechanismAt = (t) => dynamic[Math.abs(state[t]) - 1]?.id;
  }
  const world = new CollisionWorld(
    {
      name: town.name,
      positions,
      triangleEnabled,
      outdoorTerrain: town.kind === 'wilderness',
      openEdges: !!town.source?.townId && (!town.kind || town.kind === 'town' || town.kind === 'exterior'),
      entryHeight: town.kind === 'dungeon' || town.kind === 'interior' || town.spawn?.deck ? town.spawn?.y : undefined,
      groundFirstTriangle: town.ground?.included ? town.ground.firstTriangle : undefined,
      groundTriangleCount: town.ground?.included ? town.ground.triangleCount : 0,
      walkTriangleCount: town.ground?.walkTriangleCount,
      cylinders: town.colliders?.cylinders,
      water: town.water,
    },
    town.kind === 'wilderness' ? { cell: 6.4, ...worldOptions } : worldOptions,
  );
  world.mechanismAt = mechanismAt;
  // A town without streets (the "Your Ship" decks): an arrival's own foot height picks its storey.
  if (town.spawn?.deck) world.deck = true;
  return world;
}

/**
 * Flat open world used when no operator data is available: a ground plane of half-extent
 * `half` with no obstacles. Movement is bounded, sight is always clear.
 */
export function openPlaneWorld(half = 512, name = 'open plane') {
  const y = 0;
  const positions = new Float32Array([
    -half, y, -half, -half, y, half, half, y, half,
    -half, y, -half, half, y, half, half, y, -half,
  ]);
  return new CollisionWorld({ name, positions, groundFirstTriangle: 0, groundTriangleCount: 2 }, { cell: 64 });
}
