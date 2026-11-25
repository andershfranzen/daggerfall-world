// Coastal placement of World of Daggerfall sea-level sites (Location Loader instance type 2).
//
// Pure and shared by the browser renderer and server collision (client/world/wilderness/scene.js), so a dock is drawn
// and collides at the same tile. This is an independent implementation of the behaviour of Location Loader's
// `FindNearestCoast` (KABoissonneault/DFU-LocationLoader, which ships no license file; no code is copied):
//
//  - A type-2 row that starts on water walks outward one tile at a time, testing north, east, south and west in that
//    order, and stops on the last water tile before the first land tile. When the pixel has no land in those four
//    lines it tries the facing edge row or column of the loaded neighbour pixel (north, east, south, west) and
//    snaps to this pixel's border tile.
//  - A row that starts on land walks outward the same way and stops on the first water tile.
//  - Otherwise the row keeps its authored tile.
//
// Tiles are DFU tilemap bytes, `tilemap[x + y * 128]` with x east and y north (terrain.js generateTilemap). Location
// Loader treats only the byte 0 (four water corners) as water. The root height of a type-2 site is the ocean elevation
// whether or not it moved (terrain.js siteRootHeight). A dock that finds no coast therefore stands at sea level
// under the hill it was authored on; `coastStatus` reports that case so callers can say why a dock is not walkable.

export const COAST_TDIM = 128;
const TILE = 6.4; // metres per terrain tile

const isWater = (tilemap, x, y) => tilemap[x + y * COAST_TDIM] === 0;

/**
 * Location Loader's coast search for one tile.
 * @param {Uint8Array} tilemap - the site's own pixel tilemap
 * @param {number} tx - terrain tile x (east)
 * @param {number} ty - terrain tile y (north)
 * @param {{north?:Uint8Array, east?:Uint8Array, south?:Uint8Array, west?:Uint8Array}} [neighbours] - loaded neighbour
 *   pixel tilemaps (north is map row py - 1)
 * @returns {{found:boolean, tx:number, ty:number, start:'water'|'land'}}
 */
export function findNearestCoast(tilemap, tx, ty, neighbours = {}) {
  const N = COAST_TDIM;
  const inside = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
  if (!inside(tx, ty)) return { found: false, tx, ty, start: 'land' };
  const startWater = isWater(tilemap, tx, ty);
  // Steps north, east, south, west.
  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  for (let i = 1; ; i++) {
    let any = false;
    for (const [dx, dy] of dirs) {
      const x = tx + dx * i, y = ty + dy * i;
      if (!inside(x, y)) continue;
      any = true;
      const water = isWater(tilemap, x, y);
      if (startWater && !water) return { found: true, tx: x - dx, ty: y - dy, start: 'water' };
      if (!startWater && water) return { found: true, tx: x, ty: y, start: 'land' };
    }
    if (!any) break;
  }
  if (startWater) {
    const { north, east, south, west } = neighbours;
    if (north && !isWater(north, tx, 0)) return { found: true, tx, ty: N - 1, start: 'water' };
    if (east && !isWater(east, 0, ty)) return { found: true, tx: N - 1, ty, start: 'water' };
    if (south && !isWater(south, tx, N - 1)) return { found: true, tx, ty: 0, start: 'water' };
    if (west && !isWater(west, N - 1, ty)) return { found: true, tx: 0, ty, start: 'water' };
  }
  return { found: false, tx, ty, start: startWater ? 'water' : 'land' };
}

/**
 * A copy of a scene-descriptor site moved by whole terrain tiles (descriptor frame: east +x, north -z). Objects,
 * markers, matrices, anchor, rect and tile all move together; nothing else changes.
 */
export function shiftSite(site, dtx, dty) {
  if (!dtx && !dty) return site;
  const dx = dtx * TILE, dz = -dty * TILE;
  const move = (p) => (Array.isArray(p) ? [p[0] + dx, p[1], p[2] + dz] : p);
  const moveMatrix = (m) => {
    if (!Array.isArray(m) || m.length !== 16) return m;
    const out = m.slice();
    out[12] += dx;
    out[14] += dz;
    return out;
  };
  return {
    ...site,
    tile: site.tile ? { x: site.tile.x + dtx, y: site.tile.y + dty } : site.tile,
    anchor: move(site.anchor),
    rect: site.rect ? { ...site.rect, x: site.rect.x + dx, z: site.rect.z + dz } : site.rect,
    objects: (site.objects ?? []).map((o) => ({ ...o, position: move(o.position), ...(o.matrix ? { matrix: moveMatrix(o.matrix) } : {}) })),
    markers: (site.markers ?? []).map((m) => ({ ...m, position: move(m.position) })),
    coast: { ...(site.coast ?? {}), from: site.tile ? { x: site.tile.x, y: site.tile.y } : null },
  };
}

/**
 * Coast status of a type-2 site against built terrain, without moving it.
 * @returns {{snapped:boolean, tx:number, ty:number, start:'water'|'land', dtx:number, dty:number}|null} null for
 *   other instance types or sites without tile coordinates
 */
export function coastStatus(site, tilemapOf) {
  if (site?.instanceType !== 2 || !site.tile || !Array.isArray(site.pixel)) return null;
  const [px, py] = site.pixel;
  const own = tilemapOf(px, py);
  if (!own) return null;
  const r = findNearestCoast(own, site.tile.x, site.tile.y, {
    north: tilemapOf(px, py - 1), east: tilemapOf(px + 1, py), south: tilemapOf(px, py + 1), west: tilemapOf(px - 1, py),
  });
  return { snapped: r.found, tx: r.tx, ty: r.ty, start: r.start, dtx: r.tx - site.tile.x, dty: r.ty - site.tile.y };
}

/**
 * Snap every type-2 site of the given descriptors to its coast. `tilemapOf(px, py)` answers a built pixel's tilemap
 * or null. Returns new descriptor objects (inputs are not mutated) and a per-site report.
 * @param {Map<string, object>} descriptors - `${px},${py}` -> scene descriptor
 */
export function snapCoastalSites(descriptors, tilemapOf) {
  const report = [];
  const out = new Map();
  for (const [k, d] of descriptors) {
    if (!d || !Array.isArray(d.sites) || !d.sites.some((s) => s.instanceType === 2)) {
      out.set(k, d);
      continue;
    }
    const sites = d.sites.map((s) => {
      const st = coastStatus(s, tilemapOf);
      if (!st) return s;
      report.push({ id: s.id, pixel: k, ...st });
      const moved = shiftSite(s, st.dtx, st.dty);
      return { ...moved, coast: { ...(moved.coast ?? {}), snapped: st.snapped, start: st.start } };
    });
    out.set(k, { ...d, sites });
  }
  return { descriptors: out, report };
}

/**
 * Raw DFU tilemaps (before Location Loader blending, as Location Loader reads them) for the pixels a coast search of
 * these descriptors needs: each type-2 site's own pixel and its four neighbours.
 * @param {{prefetch(list):Promise, heightAt?:Function}} woods - terrain.js WoodsFile
 * @param {{generateSamples:Function, generateTilemap:Function}} terrain - terrain.js namespace (avoids an import cycle)
 */
export async function coastTilemaps(woods, terrain, descriptors) {
  const need = new Map();
  for (const d of descriptors.values()) {
    for (const s of d?.sites ?? []) {
      if (s.instanceType !== 2 || s.coast || !Array.isArray(s.pixel)) continue;
      const [px, py] = s.pixel;
      for (const [x, y] of [[px, py], [px, py - 1], [px + 1, py], [px, py + 1], [px - 1, py]]) {
        if (x >= 0 && y >= 0 && x < 1000 && y < 500) need.set(`${x},${y}`, { px: x, py: y });
      }
    }
  }
  const maps = new Map();
  if (!need.size) return maps;
  await woods.prefetch([...need.values()]);
  for (const [k, p] of need) maps.set(k, terrain.generateTilemap(terrain.generateSamples(woods, p.px, p.py), p.px, p.py));
  return maps;
}

/** snapCoastalSites over terrain read from WOODS.WLD. Sites that already carry `coast` are left as they are. */
export async function snapWithWoods(woods, terrain, descriptors) {
  const maps = await coastTilemaps(woods, terrain, descriptors);
  if (!maps.size) return { descriptors, report: [] };
  const pending = new Map();
  for (const [k, d] of descriptors) {
    pending.set(k, d && Array.isArray(d.sites) ? { ...d, sites: d.sites.filter((s) => !s.coast || s.instanceType !== 2) } : d);
  }
  const { descriptors: snapped, report } = snapCoastalSites(pending, (x, y) => maps.get(`${x},${y}`) ?? null);
  // Put back sites that were already snapped, in their original order.
  const out = new Map();
  for (const [k, d] of descriptors) {
    if (!d || !Array.isArray(d.sites)) { out.set(k, d); continue; }
    const fresh = new Map(snapped.get(k).sites.map((s) => [s.id, s]));
    out.set(k, { ...d, sites: d.sites.map((s) => fresh.get(s.id) ?? s) });
  }
  return { descriptors: out, report };
}
