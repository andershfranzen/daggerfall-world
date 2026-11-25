// Reads the classic "Your Ship" deck models (the operator's own ARCH3D data, never shipped) for the sailing
// renderer: the hull's extent, waterline and bow, the masts, and the model's own sail cloth, which the
// renderer replaces with a cloth that fills, furls, braces and tears. GL-free; unit tested.
//
// The ship frame used by renderMath.js: origin on the waterline at the hull's centre, bow -z, starboard +x.

import { hullFrame } from './renderMath.js';

/**
 * Bow direction of each installed deck in its own frame (0 = deck -z, clockwise), keyed by MAPS.BSA slot.
 * Large galleon (31/2): measured in Play (renderer probe, top and side views): ram and low prow at deck +z,
 * raised stern decks at -z. Small ship (31/1): +x, as sailing core's DECK_BOW.small (server/rpg/sailing/voyage.js),
 * checked by eye in the renderer's own probe.
 */
export const MEASURED_BOW = Object.freeze({ '31/1': Math.PI / 2, '31/2': Math.PI });
export const BOW_BY_TYPE = Object.freeze({ small: Math.PI / 2, large: Math.PI });

const triArea = (p, o) => {
  const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
  const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

/** Model triangle count of a deck town (its sea-level ground tiles excluded). */
export function modelTriangles(town) {
  const all = Math.floor((town?.positions?.length ?? 0) / 9);
  const g = town?.ground?.firstTriangle;
  return Number.isInteger(g) && g > 0 && g <= all ? g : all;
}

/** MAPS.BSA slot ("31/2") of a deck town, from its source record. */
export function deckSlot(town) {
  const s = town?.source;
  return s && Number.isInteger(s.regionIndex) && Number.isInteger(s.locationIndex) ? `${s.regionIndex}/${s.locationIndex}` : null;
}

/**
 * Analyse a deck model. Returns {bounds, waterY, deckY, bowYaw, hull (renderMath.hullFrame), masts:[{x,z,base,top}],
 * sails:[{tris:[firstTriangle...], corners:[A,B,C,D] deck-frame, mast:{x,z}}], sailTriangles:Set, triangles}.
 */
export function analyseDeck(town, { bowYaw = null } = {}) {
  const p = town.positions;
  const n = modelTriangles(town);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n * 9; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  const alongZ = maxZ - minZ >= maxX - minX;
  const deckY = Number.isFinite(town.spawn?.y) && town.spawn.y > minY ? town.spawn.y : minY + (maxY - minY) * 0.3;
  const waterY = minY + Math.min(1.2, Math.max(0.4, (deckY - minY) * 0.12));

  // Sail cloth: broad triangles high above the deck. Masts and yards are thin and stay in the model.
  const sailLow = deckY + 2.5;
  const sailTris = [];
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    if (Math.min(p[o + 1], p[o + 4], p[o + 7]) < sailLow) continue;
    const area = triArea(p, o);
    if (area < 3) continue;
    // Spars and masts are long and thin; cloth is broad (its width across the longest edge).
    const e = (i, j) => Math.hypot(p[o + i] - p[o + j], p[o + i + 1] - p[o + j + 1], p[o + i + 2] - p[o + j + 2]);
    if ((2 * area) / Math.max(e(0, 3), e(3, 6), e(6, 0)) < 1.5) continue;
    sailTris.push(t);
  }
  // Masts: tall geometry above the deck that is not sail, clustered on the deck plan (2 m cells).
  const cells = new Map();
  const sailSet = new Set(sailTris);
  for (let t = 0; t < n; t++) {
    if (sailSet.has(t)) continue;
    const o = t * 9;
    for (let k = 0; k < 9; k += 3) {
      const y = p[o + k + 1];
      if (y < deckY + 6) continue;
      const key = `${Math.round(p[o + k] / 2)},${Math.round(p[o + k + 2] / 2)}`;
      const c = cells.get(key) ?? { x: 0, z: 0, n: 0, top: -Infinity };
      c.x += p[o + k]; c.z += p[o + k + 2]; c.n++; c.top = Math.max(c.top, y);
      cells.set(key, c);
    }
  }
  const masts = [];
  for (const c of [...cells.values()].sort((a, b) => b.top - a.top)) {
    const x = c.x / c.n, z = c.z / c.n;
    if (masts.some((m) => Math.hypot(m.x - x, m.z - z) < 4)) continue;
    if (c.top < deckY + 8) continue;
    masts.push({ x, z, base: deckY, top: c.top });
  }

  // Bow: measured for the installed decks; otherwise the end without the raised stern castle.
  let bow = bowYaw ?? MEASURED_BOW[deckSlot(town)] ?? null;
  if (bow === null) {
    const prof = (lo, hi) => {
      let s = 0, k = 0;
      for (let i = 0; i < n * 9; i += 3) {
        const a = alongZ ? p[i + 2] : p[i];
        if (a >= lo && a <= hi && p[i + 1] < deckY + 4) { s += p[i + 1]; k++; }
      }
      return k ? s / k : 0;
    };
    const lo = alongZ ? minZ : minX, hi = alongZ ? maxZ : maxX, third = (hi - lo) / 3;
    const sternAtLow = prof(lo, lo + third) > prof(hi - third, hi);
    bow = alongZ ? (sternAtLow ? Math.PI : 0) : (sternAtLow ? -Math.PI / 2 : Math.PI / 2);
  }
  const hull = hullFrame(bounds, { bowYaw: bow, waterY });
  return { bounds, deckY, waterY, bowYaw: bow, hull, masts, sails: sailPatches(p, sailTris, masts), sailTriangles: sailSet, triangles: n };
}

/** Group sail triangles into connected sheets and give each a quad outline (yard edge first). */
export function sailPatches(p, tris, masts = []) {
  const groups = [];
  const key = (o) => `${p[o].toFixed(2)},${p[o + 1].toFixed(2)},${p[o + 2].toFixed(2)}`;
  const owner = new Map();
  for (const t of tris) {
    const o = t * 9;
    const ks = [key(o), key(o + 3), key(o + 6)];
    let g = null;
    for (const k of ks) if (owner.has(k)) { const h = owner.get(k); if (!g) g = h; else if (h !== g) { for (const t2 of h.tris) g.tris.push(t2); for (const k2 of h.keys) { g.keys.add(k2); owner.set(k2, g); } h.dead = true; } }
    if (!g) { g = { tris: [], keys: new Set() }; groups.push(g); }
    g.tris.push(t);
    for (const k of ks) { g.keys.add(k); owner.set(k, g); }
  }
  const out = [];
  for (const g of groups) {
    if (g.dead) continue;
    const pts = [...g.keys].map((k) => k.split(',').map(Number));
    const corners = quadOutline(pts);
    if (!corners) continue;
    const cx = (corners[0][0] + corners[1][0]) / 2, cz = (corners[0][2] + corners[1][2]) / 2;
    const mast = masts.reduce((best, m) => (!best || Math.hypot(m.x - cx, m.z - cz) < Math.hypot(best.x - cx, best.z - cz) ? m : best), null);
    out.push({ tris: g.tris, corners, mast: mast ? { x: mast.x, z: mast.z } : { x: cx, z: cz } });
  }
  return out;
}

/** Four outline corners [A, B, C, D] of a planar point set, A-B the highest edge (the yard). */
export function quadOutline(pts) {
  if (pts.length < 3) return null;
  const c = [0, 0, 0];
  for (const q of pts) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; }
  c[0] /= pts.length; c[1] /= pts.length; c[2] /= pts.length;
  // Plane axes: the horizontal spread (u) and the most vertical in-plane direction (v).
  let ux = 0, uz = 0;
  for (const q of pts) { const dx = q[0] - c[0], dz = q[2] - c[2]; if (dx * ux + dz * uz < 0) { ux -= dx; uz -= dz; } else { ux += dx; uz += dz; } }
  const ul = Math.hypot(ux, uz) || 1;
  ux /= ul; uz /= ul;
  const uv = pts.map((q) => [(q[0] - c[0]) * ux + (q[2] - c[2]) * uz, q[1] - c[1], q]);
  const hull = convexHull(uv);
  if (hull.length < 3) return null;
  // Reduce to 4 by keeping the extremes along the diagonals and axes.
  const pick = (fx, fy) => hull.reduce((b, h) => (h[0] * fx + h[1] * fy > b[0] * fx + b[1] * fy ? h : b));
  let quad = [pick(-1, 1), pick(1, 1), pick(1, -1), pick(-1, -1)];
  // A degenerate (triangular) sheet repeats a corner: that is fine for a bilinear patch.
  let best = 0, bestMean = -Infinity;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const m = (a[1] + b[1]) / 2 + (a === b ? -1e3 : 0);
    if (m > bestMean) { bestMean = m; best = i; }
  }
  quad = [0, 1, 2, 3].map((k) => quad[(best + k) % 4]);
  return quad.map((h) => [h[2][0], h[2][1], h[2][2]]);
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop(); lower.push(q); }
  for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * Positions with the listed triangles collapsed (zero area, so neither drawn nor hit) and everything from
 * `keep` triangles on removed: the hull a renderer draws without its static sail and sea tiles.
 */
export function stripTriangles(positions, tris, keep) {
  const out = positions.slice(0, keep * 9);
  for (const t of tris) {
    if (t >= keep) continue;
    const o = t * 9;
    for (let k = 3; k < 9; k += 3) { out[o + k] = out[o]; out[o + k + 1] = out[o + 1]; out[o + k + 2] = out[o + 2]; }
  }
  return out;
}

/** Contiguous runs [first, count] of a sorted triangle list (for bufferSubData). */
export function triangleRuns(tris) {
  const s = [...tris].sort((a, b) => a - b);
  const runs = [];
  for (const t of s) {
    const r = runs[runs.length - 1];
    if (r && r[0] + r[1] === t) r[1]++;
    else runs.push([t, 1]);
  }
  return runs;
}
