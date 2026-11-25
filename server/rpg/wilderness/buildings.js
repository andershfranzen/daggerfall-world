// Doors of World of Daggerfall RMB buildings (farmhouses and other type-5 block pieces) in wilderness pixels.
//
// Registers an interior source with the interiors feature (server/rpg/interiors.js `interiors.addSource`) so the
// buildings use the shared portal registry, `portal.use` / `portal.leave`, server collision and reconnect rules
// exactly as town buildings do. Door positions, landings and interior geometry come from the operator's ARENA2 files
// and the installed pack descriptor through client/world/wilderness/buildings.js, the same code the browser uses.
//
//   exterior   wilderness:<px>,<py>                    (doors of every RMB piece standing on that pixel)
//   instance   interior:wod:<px>,<py>:<tx>,<ty>/<objectID>/<record>
//
// Nothing here is served. Players receive only positions, labels and the usual teleport events.

import { openWorldData } from '../../../client/world/interiors/index.js';
import { parseWildernessId } from '../../../client/world/wilderness/data.js';
import { parseSiteId } from '../../../client/world/wilderness/data.js';
import {
  parseSiteInterior, siteBuildingPortals, siteBuildingSpecs, loadSiteInterior,
} from '../../../client/world/wilderness/buildings.js';
import { operatorFiles } from '../interiors/data.js';

/**
 * @param {object} ctx runtime context (needs ctx.services.interiors and ctx.services.wilderness)
 * @param {object} [opts]
 * @param {() => Promise<object>} [opts.data] openWorldData() result (tests)
 */
export function installWildernessBuildings(ctx, opts = {}) {
  const log = ctx.log ?? console;
  const interiors = ctx.services.interiors;
  if (typeof interiors?.addSource !== 'function') {
    log.warn?.('[wilderness] the interiors feature has no addSource hook; wilderness buildings stay closed');
    return null;
  }
  let dataP = null;
  const data = () => {
    if (opts.data) return (dataP ??= Promise.resolve(opts.data()));
    if (!ctx.dataPath) return Promise.reject(new Error('This server has no game data for buildings.'));
    dataP ??= operatorFiles(ctx.dataPath).then((f) => openWorldData(f, { worldData: ctx.services.worldData?.ready ?? null }));
    dataP.catch(() => { dataP = null; });
    return dataP;
  };
  const scenes = new Map(); // instance -> Promise<scene> (small LRU)
  const reports = new Map(); // exterior -> {buildings, skipped}

  const pack = () => ctx.services.wilderness;

  /** The descriptor of a pixel once the pack is ready; null when the pack is missing or errored. */
  async function descriptor(location) {
    const w = pack();
    if (!w) return null;
    await w.ready;
    if (w.status().pack !== 'ready') return null;
    return w.scene(location);
  }

  const source = {
    owns(location) {
      if (parseWildernessId(location)) return 'exterior';
      return parseSiteInterior(location) ? 'instance' : null;
    },
    exteriorOf(location) {
      const p = parseSiteInterior(location);
      const s = p && parseSiteId(p.site);
      return s ? `wilderness:${s.px},${s.py}` : null;
    },
    async portals(location) {
      const d = await descriptor(location);
      if (!d) return [];
      const res = await siteBuildingPortals(await data(), d);
      reports.set(location, { buildings: res.buildings.length, skipped: res.skipped });
      for (const s of res.skipped) log.info?.(`[wilderness] ${location}: ${s.site} ${s.block}${s.record !== undefined ? `#${s.record}` : ''} not enterable (${s.reason})`);
      return siteBuildingSpecs(res);
    },
    scene(location) {
      let job = scenes.get(location);
      if (job) {
        scenes.delete(location);
        scenes.set(location, job);
        return job;
      }
      job = (async () => {
        const p = parseSiteInterior(location);
        if (!p) throw new Error(`not a wilderness building: ${location}`);
        const exterior = source.exteriorOf(location);
        const d = await descriptor(exterior);
        const site = d?.sites.find((s) => s.id === p.site) ?? null;
        return loadSiteInterior(await data(), location, site);
      })();
      scenes.set(location, job);
      job.catch(() => scenes.delete(location));
      while (scenes.size > 8) scenes.delete(scenes.keys().next().value);
      return job;
    },
  };
  const remove = interiors.addSource(source);

  // Survey a pixel as soon as someone stands in it, so the first press of the door key already works.
  const warm = (location) => {
    if (parseWildernessId(location)) interiors.survey(location).catch((err) => log.warn?.(`[wilderness] doors of ${location}: ${err?.message ?? err}`));
  };
  ctx.on('overland', ({ to } = {}) => warm(to));
  ctx.on('wilderness', ({ to } = {}) => warm(to));
  ctx.on('travel', ({ player } = {}) => player && warm(ctx.location(player)));
  ctx.onJoin((p) => warm(ctx.location(p)));

  return { source, remove, reports, warm };
}
