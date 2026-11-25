// Read only town footprints here. The streaming and collision callers load meshes
// for the towns they actually need, using the same numeric records and replacements.
import { readCatalog } from '../../gameplay/travel/catalog.js';
import { BsaArchive, NAME_RECORD } from '../bsa.js';
import { readLocationReplaced } from '../wilderness/replacements.js';
import { exteriorObjectKey, tileOrigin } from './frame.js';

const archives = new WeakMap();

export async function townsAround(mapsFile, worldData, px, py, radius = 2) {
  if (!mapsFile) return []; // A standalone wilderness scene can have terrain files only.
  let cached = archives.get(mapsFile);
  if (!cached) {
    cached = Promise.all([readCatalog(mapsFile), BsaArchive.open(mapsFile, 'MAPS.BSA', NAME_RECORD)]);
    archives.set(mapsFile, cached);
    cached.catch(() => archives.delete(mapsFile));
  }
  const [catalog, maps] = await cached;
  const towns = [];
  for (let y = py - radius; y <= py + radius; y++) {
    for (let x = px - radius; x <= px + radius; x++) {
      const entry = catalog.atPixel(x, y);
      if (!entry) continue;
      const loc = await readLocationReplaced(maps, entry.regionIndex, entry.index, worldData);
      const custom = loc.width === 1 && loc.height === 1 && /^CUST/i.test(loc.blockNames[0]);
      towns.push({
        key: exteriorObjectKey(x, y, 'town', loc.region, loc.index), id: entry.id,
        px: x, py: y, regionIndex: loc.region, index: loc.index, name: loc.displayName ?? loc.name,
        width: loc.width, height: loc.height, custom, origin: tileOrigin(loc.width, loc.height, custom),
      });
    }
  }
  return towns;
}
