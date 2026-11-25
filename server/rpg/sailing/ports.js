// Port records of the operator's MAPS.BSA, read in bulk for the sea chart (server/rpg/sailing/coast.js).
//
// A classic location is a port where its exterior record's `ExteriorData.PortTownAndUnknown` byte is nonzero - the
// byte Daggerfall's bank reads to decide whether it sells ships (Daggerfall Unity DaggerfallBankingWindow.cs, MIT;
// the per-location reader of the same record is client/world/maps.js readLocation). Daggerfall Online (Lattymoy,
// MIT, .ref/dfjs-research-03 src/systems/travel/travelPorts.js) uses Travel Options' hand-written id table instead;
// this module takes the game's own flag so nothing hand-copied is needed and a modded MAPS.BSA is honoured.
//
// The block-grid size and origin (TerrainHelper.GetLocationTerrainTileOrigin, client/world/exterior/frame.js) come
// from the same record, so the chart knows which terrain tiles of the port's pixel the town itself stands on.

import { BsaArchive, NAME_RECORD } from '../../../client/world/bsa.js';
import { REGION_NAMES, resolveRmbBlockName } from '../../../client/world/maps.js';
import { tileOrigin } from '../../../client/world/exterior/frame.js';

/**
 * Exterior facts of every location in MAPS.BSA, keyed `${regionIndex}/${index}`.
 * @param {Blob} mapsBlob
 * @returns {Promise<Map<string, {portTown:number, width:number, height:number, custom:boolean, origin:{x:number,y:number}}>>}
 */
export async function readExteriors(mapsBlob, { yieldEach = false } = {}) {
  const maps = await BsaArchive.open(mapsBlob, 'MAPS.BSA', NAME_RECORD);
  const out = new Map();
  for (let region = 0; region < REGION_NAMES.length; region++) {
    if (yieldEach) await new Promise((r) => setImmediate(r));
    const sfx = String(region).padStart(3, '0');
    const ni = maps.indexOfName(`MAPNAMES.${sfx}`);
    const pi = maps.indexOfName(`MAPPITEM.${sfx}`);
    if (ni < 0 || pi < 0 || maps.entries[ni].size < 4) continue;
    const names = await maps.read(ni);
    const count = new DataView(names.buffer, names.byteOffset).getUint32(0, true);
    const p = await maps.read(pi);
    const pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let i = 0; i < count; i++) {
      try {
        if ((i + 1) * 4 > p.length) break;
        let pos = count * 4 + pv.getUint32(i * 4, true);
        const doors = pv.getUint32(pos, true);
        pos += 4 + doors * 6 + 112;
        const buildings = pv.getUint16(pos, true);
        pos += 7 + buildings * 26 + 32 + 4 + 4;
        if (pos + 2 + 4 + 3 + 192 > p.length) continue;
        const width = p[pos], height = p[pos + 1];
        pos += 6;
        const letter1 = p[pos], portTown = p[pos + 1];
        pos += 3;
        if (width < 1 || height < 1 || width * height > 64) continue;
        let custom = false;
        if (width === 1 && height === 1) custom = /^CUST/i.test(resolveRmbBlockName(p[pos], p[pos + 64], p[pos + 128], letter1));
        out.set(`${region}/${i}`, { portTown, width, height, custom, origin: tileOrigin(width, height, custom) });
      } catch {
        // A damaged record is simply not a port.
      }
    }
  }
  return out;
}

/**
 * The catalogue's port towns: classic locations whose exterior is flagged a port.
 * @param {{locations: object[]}} catalog - client/gameplay/travel/catalog.js Catalog
 * @param {Map<string, object>} exteriors - readExteriors()
 */
export function portTowns(catalog, exteriors) {
  const out = [];
  for (const l of catalog.locations) {
    const ex = exteriors.get(`${l.regionIndex}/${l.index}`);
    if (!ex || !ex.portTown) continue;
    out.push({
      id: l.id,
      name: l.name,
      region: l.region,
      regionIndex: l.regionIndex,
      index: l.index,
      type: l.type,
      px: l.x,
      py: l.y,
      block: { width: ex.width, height: ex.height, origin: ex.origin, custom: ex.custom },
    });
  }
  return out;
}


/**
 * The port index, cheaply: the travel feature's loaded catalogue when it has one (`travel.regionLocations`), else
 * MAPS.BSA's own; and MAPS.BSA's exterior records for the port flag and block grid, a region per turn of the loop.
 * @param {string} mapsPath - MAPS.BSA
 * @param {{source?:string, regionLocations?:(r:number)=>object[]}|null} travel - ctx.services.travel
 */
export async function loadPortIndex(mapsPath, travel = null) {
  const { openAsBlob } = await import('node:fs');
  const blob = new File([await openAsBlob(mapsPath)], 'MAPS.BSA');
  let catalog = null, catalogSource = 'maps';
  if (travel?.source === 'files' && typeof travel.regionLocations === 'function') {
    const locations = [];
    for (let r = 0; r < REGION_NAMES.length; r++) locations.push(...travel.regionLocations(r));
    if (locations.length) { catalog = { locations }; catalogSource = 'travel'; }
  }
  if (!catalog) {
    const { readCatalog } = await import('../../../client/gameplay/travel/catalog.js');
    catalog = await readCatalog(blob);
  }
  const exteriors = await readExteriors(blob, { yieldEach: true });
  return { ports: portTowns(catalog, exteriors), catalogSource };
}
