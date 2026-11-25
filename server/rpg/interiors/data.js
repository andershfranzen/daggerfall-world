// Trusted operator ARENA2 access for interiors: the server derives every door, landing point and exit from the
// operator's own files (ctx.dataPath) with the same shared code the browser renders with, so client-supplied
// coordinates are never trusted. Nothing here is served or sent to players except positions and labels.

import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadTown } from '../../../client/world/town.js';
import {
  openWorldData, locationPortals, portalSpecs, parseLocation, loadInterior, loadDungeon, dungeonDetails,
} from '../../../client/world/interiors/index.js';

const NEEDED = /^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|FACTION\.TXT|NAMEGEN\.DAT|TEXT\.RSC|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3})$/i;

/** File objects for the ARENA2 files the world readers use. */
export async function operatorFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!NEEDED.test(name)) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    out.push(new File([await openAsBlob(full)], name));
  }
  return out;
}

/**
 * Lazily opened world data plus per-town portal specs and per-instance scenes.
 * @param {string} dir operator ARENA2 directory
 */
export function createWorldSource(dir, worldData = null) {
  let filesP = null;
  let dataP = null;
  const towns = new Map(); // town location id -> Promise<specs>
  const scenes = new Map(); // instance location id -> Promise<scene>
  const files = () => (filesP ??= operatorFiles(dir));
  const data = () => (dataP ??= files().then((f) => openWorldData(f, { worldData })));

  /** Portal specs of a `town:` location (loads the town once to fix its output-space origin). */
  function townPortals(location) {
    const p = parseLocation(location);
    if (!p || p.kind !== 'town') return Promise.reject(new Error(`not a town location: ${location}`));
    let job = towns.get(location);
    if (!job) {
      job = (async () => {
        const f = await files();
        const town = await loadTown(f, { region: p.region, location: p.location, worldData });
        const portals = await locationPortals(await data(), { region: town.source.regionIndex, location: town.source.locationIndex }, town.source.spawnLocal);
        return portalSpecs(portals);
      })();
      towns.set(location, job);
      job.catch(() => towns.delete(location));
    }
    return job;
  }

  /** Geometry of an interior or dungeon instance (for server-side collision); cached, small LRU. */
  function scene(location) {
    let job = scenes.get(location);
    if (job) {
      scenes.delete(location);
      scenes.set(location, job);
      return job;
    }
    const p = parseLocation(location);
    if (!p || p.kind === 'town') return Promise.reject(new Error(`not an instance location: ${location}`));
    job = data().then((d) => (p.kind === 'dungeon' ? loadDungeon(d, location) : loadInterior(d, location)));
    scenes.set(location, job);
    job.catch(() => scenes.delete(location));
    while (scenes.size > 8) scenes.delete(scenes.keys().next().value);
    return job;
  }

  return { townPortals, scene, files, dungeonDetails: (id) => data().then((d) => dungeonDetails(d, id)) };
}
