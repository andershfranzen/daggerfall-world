// Dungeon water surfaces (package 21 presentation).
//
// Source: Daggerfall Unity RDBLayout.AddWater places one DungeonWater plane per RDB block at
// `nativeBlockWaterLevel * -1 * MeshReader.GlobalScale`, scaled to the block's footprint, whenever the block's start
// marker carries a water level (10000 = none). The collision volumes in client/world/interiors/layout.js
// (`water`) use the same level and footprint, so swimming and the drawn surface agree.
//
// Project choice: a whole-block plane would also run through rock and through rooms whose floor lies above or whose
// ceiling lies below the water level. The plane is therefore clipped to the columns where the block's own geometry
// has open water at that height: a walkable floor below the surface and nothing solid between that floor and the
// surface. Kept cells are dilated by one cell so the sheet meets the walls (the walls occlude the overhang). Like
// collision, any near-horizontal face counts as a floor, so the top of a submerged room's ceiling can carry sheet
// cells inside closed geometry, where nothing can see them.

/** Grid step (metres) for the open-water test. */
export const WATER_CELL = 0.5;
/** Height above the surface that must also be open (a ceiling flush with the water hides it anyway). */
const AIR = 0.05;

/**
 * Triangles (Float32Array, 9 floats each, y up) of the visible water surface of every volume.
 * @param {{heightsAt(x:number,z:number):number[], segmentClear(...a:number[]):boolean}} world collision world of the scene
 * @param {Array<{minX:number,maxX:number,minZ:number,maxZ:number,y:number}>} volumes `scene.water`
 */
export function waterSurfaceTriangles(world, volumes, { cell = WATER_CELL } = {}) {
  const out = [];
  const stats = [];
  for (const v of volumes ?? []) {
    if (![v.minX, v.maxX, v.minZ, v.maxZ, v.y].every(Number.isFinite)) continue;
    const nx = Math.max(1, Math.round((v.maxX - v.minX) / cell)), nz = Math.max(1, Math.round((v.maxZ - v.minZ) / cell));
    const sx = (v.maxX - v.minX) / nx, sz = (v.maxZ - v.minZ) / nz;
    const open = new Uint8Array(nx * nz);
    let wet = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = v.minX + (i + 0.5) * sx, z = v.minZ + (j + 0.5) * sz;
      if (openWater(world, x, z, v.y)) { open[j * nx + i] = 1; wet++; }
    }
    // Dilate by one cell (8-neighbourhood).
    const keep = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (!open[j * nx + i]) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < nx && b < nz) keep[b * nx + a] = 1;
      }
    }
    // Merge kept cells into row runs to keep the triangle count low.
    let quads = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx;) {
        if (!keep[j * nx + i]) { i++; continue; }
        let e = i;
        while (e < nx && keep[j * nx + e]) e++;
        const x0 = v.minX + i * sx, x1 = v.minX + e * sx, z0 = v.minZ + j * sz, z1 = v.minZ + (j + 1) * sz, y = v.y;
        out.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
        quads++;
        i = e;
      }
    }
    stats.push({ block: v.block ?? null, y: v.y, cells: nx * nz, wet, quads });
  }
  return { positions: new Float32Array(out), stats };
}

/** Open water at (x, z): a floor below the surface y and a clear column from it to just above the surface. */
export function openWater(world, x, z, y) {
  let floor = null;
  for (const h of world.heightsAt(x, z)) if (h < y && (floor === null || h > floor)) floor = h;
  if (floor === null) return false;
  return world.segmentClear(x, floor + 0.02, z, x, y + AIR, z);
}
