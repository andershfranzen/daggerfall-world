// Server-side coast snap of sea-level World of Daggerfall sites, for spawn points only.
//
// The scene builder (client/world/wilderness/scene.js) moves type-2 sites to their coast with
// client/world/wilderness/coast.js for drawing and collision. The descriptor itself stays as authored (it is height
// free and synchronous), so a visit to a dock that moved would otherwise put the player at the authored tile. This
// cache answers the same tile shift from the operator's WOODS.WLD so `wilderness.visit` lands next to the dock.

import { arena2Files } from '../collision/arena2.js';
import * as terrain from '../../../client/world/wilderness/terrain.js';
import { snapWithWoods } from '../../../client/world/wilderness/coast.js';

const TILE = 6.4;

export function createCoastCache({ dataPath, log = console, max = 512 } = {}) {
  const shifts = new Map(); // siteId -> pending promise, resolved shift, or read error
  let woodsP = null;
  const woods = () => {
    if (!dataPath) return Promise.reject(new Error('no game data'));
    woodsP ??= arena2Files(dataPath).then((files) => {
      const f = files.find((x) => /^WOODS\.WLD$/i.test(x.name));
      if (!f) throw new Error('WOODS.WLD is missing');
      return terrain.WoodsFile.open(async (o, n) => new Uint8Array(await f.slice(o, o + n).arrayBuffer()), f.size);
    });
    woodsP.catch(() => { woodsP = null; });
    return woodsP;
  };

  /** Start resolving a type-2 site (descriptor entry). Harmless to call repeatedly. */
  function prepare(site) {
    if (!site || site.instanceType !== 2 || shifts.has(site.id) || !dataPath) return;
    const job = woods()
      .then((w) => snapWithWoods(w, terrain, new Map([[site.pixel.join(','), { sites: [site] }]])))
      .then(({ report }) => {
        const r = report.find((x) => x.id === site.id);
        shifts.set(site.id, r ? { snapped: r.snapped, dtx: r.dtx, dty: r.dty } : { snapped: false, dtx: 0, dty: 0 });
      })
      .catch((err) => {
        shifts.set(site.id, new Error(`Could not load the shoreline: ${err?.message ?? err}`));
        log.warn?.(`[wilderness] coast of ${site.id}: ${err?.message ?? err}`);
      })
      .finally(() => {
        while (shifts.size > max) shifts.delete(shifts.keys().next().value);
      });
    shifts.set(site.id, job);
  }

  /** Resolved shift of a site, or null while unknown. */
  function shiftOf(id) {
    const v = shifts.get(id);
    return v && !(v instanceof Promise) && !(v instanceof Error) ? v : null;
  }

  /** The descriptor spawn moved with its focus site (scene metres: east +x, north -z). */
  function spawnFor(id, spawn) {
    const s = shifts.get(id);
    if (s instanceof Promise) throw new Error('The shoreline is still loading. Try visiting again in a moment.');
    if (s instanceof Error) {
      shifts.delete(id); // start a fresh lookup on the next visit
      throw s;
    }
    if (!s || (!s.dtx && !s.dty)) return spawn;
    return { ...spawn, x: spawn.x + s.dtx * TILE, z: spawn.z - s.dty * TILE };
  }

  const whenReady = (id) => Promise.resolve(shifts.get(id)).then(() => shiftOf(id));
  return { prepare, shiftOf, spawnFor, whenReady };
}
