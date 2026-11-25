// Builds collision geometry on the server from the operator's ARENA2 directory with the same
// loader the browser renders from (client/world/town.js), so both sides share one layout,
// scale and spawn. Files are opened lazily (fs.openAsBlob) and only the triangle positions
// are kept: the texture atlas, UVs and colours are dropped as soon as the load returns.
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadTown } from '../../../client/world/town.js';
import { worldFromTown } from '../../../client/gameplay/collision/world.js';
import { buildWildernessScene, neighbourLocations } from '../../../client/world/wilderness/scene.js';
import { parseWildernessId } from '../../../client/world/wilderness/data.js';
import { composeTownCollision } from '../../../client/world/exterior/collision.js';
import * as models from '../../../client/world/wilderness/models.js';
import { cityGatesClosed, isCityGateId } from '../../../client/world/cityGates.js';

const NEEDED = /^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|FACTION\.TXT|NAMEGEN\.DAT|TEXT\.RSC|WOODS\.WLD|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3})$/i;

/** `town:Region/Location` → {region, location}; null for other prefixes (interiors, dungeons). */
export function parseTownId(id) {
  if (typeof id !== 'string' || !id.startsWith('town:') || id.length > 120) return null;
  const rest = id.slice(5);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { region: rest.slice(0, slash), location: rest.slice(slash + 1) };
}

/**
 * The town-loader inputs inside `dir` (the ARENA2 folder, or an install folder with an ARENA2
 * child). Returns lazily-read File objects; nothing is read into memory here.
 */
export async function arena2Files(dir) {
  let root = dir;
  const names = readdirSync(root);
  if (!names.some((n) => /^MAPS\.BSA$/i.test(n))) {
    const sub = names.find((n) => /^arena2$/i.test(n) && statSync(join(root, n)).isDirectory());
    if (sub) root = join(root, sub);
  }
  const out = [];
  for (const name of readdirSync(root)) {
    if (!NEEDED.test(name)) continue;
    const full = join(root, name);
    if (!statSync(full).isFile()) continue;
    out.push(new File([await openAsBlob(full)], name));
  }
  return out;
}

/**
 * Loader for AreaCache: resolves `{world, source}` for a town location id or rejects with a
 * readable reason. The file list is read once and reused.
 */
export function arena2Loader(dataPath, services = {}) {
  let files = null;
  const mechanismActive = id => isCityGateId(id) && cityGatesClosed(services.worldClock?.()?.minutes);
  return async (location) => {
    if (!dataPath) throw new Error('no game data is configured on this server');
    if (services.interiors?.isInstance(location)) {
      const scene = await services.interiors.scene(location);
      return { world: worldFromTown(scene, {
        mechanismActive: (id) => services.interiors.mechanismActive(location, id),
      }), source: `ARENA2 ${scene.name}` };
    }
    const pixel = parseWildernessId(location);
    if (pixel) {
      files ??= await arena2Files(dataPath);
      const pack = services.wilderness;
      await pack?.ready;
      const read = pack?.status?.().pack === 'ready' ? id => pack.scene(id) : () => null;
      const neighbours = new Map();
      for (const id of neighbourLocations(pixel.px, pixel.py)) {
        const d = read(id);
        if (d) neighbours.set(`${d.px},${d.py}`, d);
      }
      const mesh = await buildWildernessScene({
        files, location, descriptor: read(location), neighbours, models, geometryOnly: true,
        loadAsset: services.wodAssets?.model, worldData: services.worldData?.ready ?? null,
      });
      const combined = await composeTownCollision(mesh, t => loadTown(files, {
        region: t.regionIndex, location: t.index, worldData: services.worldData?.ready ?? null,
      }));
      const world = worldFromTown(combined, { cell: 6.4, mechanismActive });
      world.datum = mesh.wilderness.datum;
      return { world, source: 'ARENA2 wilderness geometry' };
    }
    const town = parseTownId(location);
    if (!town) throw new Error(`no exterior geometry for ${location}`);
    files ??= await arena2Files(dataPath);
    const t = await loadTown(files, { ...town, worldData: services.worldData?.ready ?? null });
    return { world: worldFromTown(t, { mechanismActive }), source: `ARENA2 ${t.region}/${t.name}` };
  };
}
