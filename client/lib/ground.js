// Ground height lookup over the town's walkable (upward-facing) triangles.
// The server only simulates x/z, so the client derives eye height locally: the highest
// walkable surface under a point that is no more than a step above the current height
// (so we climb stairs and kerbs but do not pop onto roofs).

export const MAX_STEP = 0.75;

/** Floor to resume in a stacked interior. Older saves use the original scene's entry marker. */
export function indoorFloor(scene, portal) {
  // A town without streets (the "Your Ship" decks) is entered on its deck, not at sea level.
  if (scene?.spawn?.deck && Number.isFinite(scene.spawn.y) && !scene.kind) return scene.spawn.y;
  if (scene?.kind !== 'interior' && scene?.kind !== 'dungeon') return null;
  if (portal?.to === scene.location && Number.isFinite(portal.footY)) return portal.footY;
  return Number.isFinite(scene.spawn?.y) ? scene.spawn.y : null;
}

export class Ground {
  constructor(positions, { cell = 4, minNormalY = 0.55, terrainHeightAt = null, skip = null } = {}) {
    this.cell = cell;
    this.terrainHeightAt = terrainHeightAt;
    this.positions = positions;
    this.cells = new Map();
    const p = positions;
    const triCount = Math.floor(p.length / 9);
    // Triangles that terrainHeightAt already answers exactly (a scene's own terrain).
    const skipFrom = skip ? skip.first : -1, skipTo = skip ? skip.first + skip.count : -1;
    for (let t = 0; t < triCount; t++) {
      if (t >= skipFrom && t < skipTo) { t = skipTo - 1; continue; }
      const o = t * 9;
      const ax = p[o], ay = p[o + 1], az = p[o + 2];
      const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
      const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!len || Math.abs(ny) / len < minNormalY) continue; // walls, ceilings handled by |ny|
      const x0 = Math.floor(Math.min(ax, bx, cx) / cell), x1 = Math.floor(Math.max(ax, bx, cx) / cell);
      const z0 = Math.floor(Math.min(az, bz, cz) / cell), z1 = Math.floor(Math.max(az, bz, cz) / cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) continue; // absurdly large: ignore
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const key = ix * 73856093 ^ iz * 19349663;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(t);
        }
      }
    }
  }

  /** All surface heights under (x, z). */
  heightsAt(x, z) {
    const key = Math.floor(x / this.cell) * 73856093 ^ Math.floor(z / this.cell) * 19349663;
    const list = this.cells.get(key);
    const out = [];
    if (!list) return out;
    const p = this.positions;
    for (const t of list) {
      const o = t * 9;
      const ax = p[o], az = p[o + 2], bx = p[o + 3], bz = p[o + 5], cx = p[o + 6], cz = p[o + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
      out.push(w1 * p[o + 1] + w2 * p[o + 4] + w3 * p[o + 7]);
    }
    return out;
  }

  /**
   * Height to stand on at (x, z) given current foot height `refY` (null = initial placement,
   * which picks the lowest surface so we start in the street rather than on a roof).
   * Returns null when there is no surface under the point.
   */
  heightAt(x, z, refY = null) {
    const hs = this.heightsAt(x, z);
    const terrain = this.terrainHeightAt?.(x, z);
    if (Number.isFinite(terrain)) {
      // Mountains and boulders extend below the landscape. Spawn on the terrain
      // and allow steps onto the part of those meshes above the ground.
      const ceiling = Math.max(refY ?? terrain, terrain) + MAX_STEP;
      let top = terrain;
      for (const h of hs) if (h > top && h <= ceiling) top = h;
      return top;
    }
    if (!hs.length) return null;
    if (refY === null) return Math.min(...hs);
    let best = null;
    for (const h of hs) if (h <= refY + MAX_STEP && (best === null || h > best)) best = h;
    return best ?? refY; // everything is a wall-height above us: stay level
  }
}

const grounds = new WeakMap();

/**
 * The shared Ground for a scene mesh, built once per mesh object. A wilderness scene's terrain
 * triangles are left to its exact terrain sampler; indexing them took over a second per scene.
 */
export function groundFor(mesh) {
  if (!mesh?.positions?.length) return null;
  let g = grounds.get(mesh);
  if (!g) {
    const terrainHeightAt = mesh.wilderness?.heightAt ?? null;
    const t = mesh.ground;
    const skip = terrainHeightAt && t?.included && Number.isInteger(t.firstTriangle) && Number.isInteger(t.triangleCount)
      ? { first: t.firstTriangle, count: t.triangleCount } : null;
    g = new Ground(mesh.positions, { terrainHeightAt, skip });
    grounds.set(mesh, g);
  }
  return g;
}

/** `ground` seen from a frame translated by `offset` (a crossing whose destination is still loading). */
export function offsetGround(ground, offset) {
  if (!ground) return null;
  const [ox, oy, oz] = offset;
  return {
    base: ground,
    heightAt(x, z, refY = null) {
      const h = ground.heightAt(x - ox, z - oz, refY === null ? null : refY - oy);
      return h === null || h === undefined ? h : h + oy;
    },
    heightsAt(x, z) { return ground.heightsAt(x - ox, z - oz).map((h) => h + oy); },
  };
}

/**
 * Terrain height outside a scene's own ground, from the surrounding exterior layers the stream
 * draws (renderer.layers: [{mesh, offset}], wilderness meshes with their exact terrain sampler).
 * A player seen across a town or map-pixel edge then stands on the hillside, not inside it.
 */
export function layersHeightAt(layers, x, z) {
  for (const l of layers ?? []) {
    const sample = l?.mesh?.wilderness?.heightAt;
    if (typeof sample !== 'function' || !l.offset) continue;
    const [ox, oy, oz] = l.offset;
    const lx = x - ox, lz = z - oz;
    if (Math.abs(lx) > 409.6 || Math.abs(lz) > 409.6) continue; // outside this layer's map pixel
    const h = sample(lx, lz);
    if (Number.isFinite(h)) return h + oy;
  }
  return null;
}
