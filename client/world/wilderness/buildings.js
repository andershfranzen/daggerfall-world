// Enterable buildings of World of Daggerfall RMB block pieces (Location Loader type 5) in a wilderness pixel.
//
// One module serves the browser and the server so door ids, landing points and exits agree exactly:
//  - siteBuildingPortals(data, descriptor): every building door of the pixel's own RMB pieces, in the pixel's scene
//    frame, with the interior landing and the interior exits (server/rpg/interiors/portals.js register() specs).
//  - loadSiteInterior(data, location, site): the renderer-ready interior scene, in the output contract of
//    client/world/interiors/index.js loadInterior().
//
// The exterior doors use the same transforms the wilderness renderer draws the block with
// (descriptor object matrix ∘ replacements.js rmbBlockPlacements), and the interiors use the town interior layout
// (client/world/interiors/layout.js), so a farmhouse door, its inside and its way back out line up with what is drawn.
//
// Location ids: `interior:<siteId>/<objectID>/<record>`, e.g. `interior:wod:110,159:107,54/0/0`. The classic
// `interior:<Region>/<Location>/<bx>,<by>/<rec>` parser (client/world/interiors/index.js parseLocation) does not
// accept these, so the two address spaces cannot collide. Portal ids: `wb:<tx>,<ty>[.<n>]:<objectID>:<record>`.
//
// The site descriptor is height-free: y = 0 is the site ground. Door heights here are relative to the site ground and
// are informational only; the server checks reach horizontally and the terrain supplies the standing height outside.

import { WorldDataError } from '../errors.js';
import { climateAt, climateSettings } from '../maps.js';
import { readBlob } from '../bsa.js';
import { parseRmbFull } from '../interiors/blocks.js';
import { interiorFlats } from '../interiors/flats.js';
import { buildScene, placedDoors, placeDoor, DOOR_TYPE } from '../interiors/scene.js';
import { interiorLayout, interiorLanding, hasInterior, rmbModelMatrix, EXTERIOR_LANDING } from '../interiors/layout.js';
import { buildingTypeName, yawFacing } from '../interiors/index.js';
import { resolveRmbBlock, rmbBlockPlacements } from './replacements.js';
import { parseSiteId } from './data.js';

const r3 = (v) => Math.round(v * 1000) / 1000;

export const SITE_INTERIOR_PREFIX = 'interior:wod:';

/** `interior:<siteId>/<objectID>/<record>` for a building of a wilderness site. */
export function siteInteriorLocation(siteId, objectID, record) {
  return `interior:${siteId}/${objectID}/${record}`;
}

/** Parse a wilderness site interior id. Returns {site, objectID, record} or null. */
export function parseSiteInterior(id) {
  if (typeof id !== 'string' || !id.startsWith(SITE_INTERIOR_PREFIX) || id.length > 120) return null;
  const m = /^interior:(wod:[^/]+)\/(\d{1,4}(?:\.\d{1,4}){0,3})\/(\d{1,2})$/.exec(id);
  if (!m || !parseSiteId(m[1])) return null;
  return { site: m[1], objectID: m[2], record: +m[3] };
}

/** Portal id (portals.js ID_RE) of a building door in its pixel. */
export function siteBuildingPortalId(siteId, objectID, record) {
  const p = parseSiteId(siteId);
  if (!p) throw new TypeError(`not a site id: ${siteId}`);
  const n = /#(\d+)$/.exec(siteId);
  return `wb:${p.tx},${p.ty}${n ? `.${n[1]}` : ''}:${objectID}:${record}`;
}

/** Column-major 4x4 point and direction transforms (descriptor `matrix`). */
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const applyDir = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];

/** Parsed RMB block (classic BLOCKS.BSA or its WorldData replacement), cached on `data.rmb` like interiors/index.js. */
export async function siteRmbBlock(data, name) {
  const r = await resolveRmbBlock(data.blocks, name, data.worldData);
  if (r.index < 0 && !r.block) throw new WorldDataError(`BLOCKS.BSA: block ${name} is missing`);
  const key = r.block ? `wd:${r.name}` : r.index;
  let b = data.rmb.get(key);
  if (!b) {
    b = r.block ?? parseRmbFull(await data.blocks.read(r.index), r.name);
    if (!b.subRecords?.every((s) => s.exterior && s.interior)) {
      // A replacement normalised without the interior split cannot provide doors.
      b = { ...b, subRecords: [] };
    }
    b.blockIndex = r.index;
    data.rmb.set(key, b);
  }
  return b;
}

/** World climate base for a pixel (scene.js climateOf). */
async function pixelClimateBase(data, px, py) {
  const pak = data.index.get('CLIMATE.PAK');
  if (!pak) return null;
  data.climateBytes ??= readBlob(pak, 0, pak.size);
  return climateSettings(climateAt(await data.climateBytes, px * 128 + 64, (499 - py) * 128 + 64)).climateBase;
}

/** Block objects (type 5) of the descriptor's own sites, in its frame. */
function ownBlockObjects(descriptor) {
  const out = [];
  const key = `${descriptor.px},${descriptor.py}`;
  for (const site of descriptor.sites ?? []) {
    if (Array.isArray(site.pixel) && site.pixel.join(',') !== key) continue;
    for (const obj of site.objects ?? []) {
      if (obj.kind !== 'block' || typeof obj.block !== 'string' || !Array.isArray(obj.matrix) || obj.matrix.length !== 16) continue;
      out.push({ site, obj });
    }
  }
  return out;
}

/**
 * Building portals of a wilderness pixel's own RMB pieces.
 * @param {object} data - openWorldData() result (client/world/interiors/index.js)
 * @param {object} descriptor - scene descriptor of `wilderness:<px>,<py>` (docs/wilderness-protocol.md)
 * @returns {Promise<{location:string, buildings:Array, skipped:Array<{site, objectID, block, record?, reason}>}>}
 */
export async function siteBuildingPortals(data, descriptor) {
  const location = `wilderness:${descriptor.px},${descriptor.py}`;
  const buildings = [];
  const skipped = [];
  for (const { site, obj } of ownBlockObjects(descriptor)) {
    let block;
    try {
      block = await siteRmbBlock(data, obj.block);
    } catch (err) {
      skipped.push({ site: site.id, objectID: obj.objectID, block: obj.block, reason: err.message });
      continue;
    }
    const placements = rmbBlockPlacements(block);
    let k = 0;
    for (const sub of block.subRecords) {
      const models = sub.exterior.models;
      const subPlacements = placements.slice(k, k + models.length);
      k += models.length;
      const ext = [];
      for (let i = 0; i < models.length; i++) {
        const mesh = await data.lib.mesh(models[i].modelId);
        for (const d of mesh.doors) {
          if (d.type !== DOOR_TYPE.BUILDING) continue;
          ext.push({ door: d, place: subPlacements[i].place, model: models[i] });
        }
      }
      if (!ext.length) continue;
      if (!hasInterior(sub)) {
        skipped.push({ site: site.id, objectID: obj.objectID, block: block.name, record: sub.index, reason: 'no interior' });
        continue;
      }
      const lay = await interiorLayout(data.lib, sub, block.blockIndex, sub.index);
      const inner = await placedDoors(data.lib, lay.placements.filter((p) => !p.actionDoor));
      const exits = inner.filter((d) => d.type === DOOR_TYPE.BUILDING);
      if (!exits.length) {
        skipped.push({ site: site.id, objectID: obj.objectID, block: block.name, record: sub.index, reason: 'no exit door inside' });
        continue;
      }
      const doors = ext.map(({ door, place, model }) => {
        // Block-local Unity metres (what the renderer draws), then the site object's matrix into the scene frame.
        const c = place(...door.centre);
        const tip = place(door.centre[0] + door.normal[0], door.centre[1] + door.normal[1], door.centre[2] + door.normal[2]);
        const [x, y, z] = apply(obj.matrix, c);
        const n = applyDir(obj.matrix, [tip[0] - c[0], tip[1] - c[1], tip[2] - c[2]]);
        const h = Math.hypot(n[0], n[2]) || 1;
        const nx = n[0] / h, nz = n[2] / h;
        // Sub-record frame centre of the same door (interior space before the z mirror), for the landing inside.
        const local = placeDoor(door, rmbModelMatrix(model)).centre;
        const land = interiorLanding(local, inner, lay.enterMarkers);
        const facing = land.facing ?? [-door.normal[0], 0, -door.normal[2]];
        return {
          x: r3(x), y: r3(y), z: r3(z), nx: r3(nx), nz: r3(nz),
          local: local.map(r3),
          enter: { x: r3(land.position[0]), y: r3(land.position[1]), z: r3(-land.position[2]), yaw: r3(yawFacing(facing[0], -facing[2])) },
          exit: { x: r3(x + nx * EXTERIOR_LANDING), y: r3(y - door.size.height / 2), z: r3(z + nz * EXTERIOR_LANDING), yaw: r3(yawFacing(nx, nz)) },
        };
      });
      buildings.push({
        portalId: siteBuildingPortalId(site.id, obj.objectID, sub.index),
        target: siteInteriorLocation(site.id, obj.objectID, sub.index),
        site: site.id,
        siteName: site.name,
        objectID: obj.objectID,
        block: block.name,
        record: sub.index,
        buildingType: sub.building?.buildingType ?? 4,
        doors,
        exits: exits.map((d) => ({ x: r3(d.centre[0]), y: r3(d.centre[1]), z: r3(-d.centre[2]) })),
      });
    }
  }
  return { location, buildings, skipped };
}

/** Portal specs (portals.js register()) for a siteBuildingPortals() result. */
export function siteBuildingSpecs(result) {
  return result.buildings.map((b) => ({
    id: b.portalId,
    from: result.location,
    to: b.target,
    kind: 'building',
    label: buildingTypeName(b.buildingType),
    entrances: b.doors.map((d) => ({
      x: d.x, y: d.y, z: d.z, enter: d.enter, inner: { x: d.local[0], y: d.local[1], z: -d.local[2] }, exit: d.exit,
    })),
    exits: b.exits,
    meta: { site: b.site, block: b.block, record: b.record, objectID: b.objectID, buildingType: b.buildingType, encounters: [] },
  }));
}

/**
 * The interior scene of a wilderness building.
 * @param {object} data - openWorldData() result
 * @param {string} location - `interior:<siteId>/<objectID>/<record>`
 * @param {object} site - the site's descriptor entry (from the scene of its own pixel)
 */
export async function loadSiteInterior(data, location, site) {
  const p = parseSiteInterior(location);
  if (!p) throw new WorldDataError(`"${location}" is not a wilderness building`);
  if (!site || site.id !== p.site) throw new WorldDataError(`${p.site} is not in the World of Daggerfall data`);
  const obj = (site.objects ?? []).find((o) => o.kind === 'block' && String(o.objectID) === p.objectID);
  if (!obj) throw new WorldDataError(`${site.name} has no building block ${p.objectID}`);
  const block = await siteRmbBlock(data, obj.block);
  const sub = block.subRecords[p.record];
  if (!sub) throw new WorldDataError(`${block.name} has no building record ${p.record}`);
  const lay = await interiorLayout(data.lib, sub, block.blockIndex, p.record);
  const [px, py] = site.pixel;
  const climateBase = await pixelClimateBase(data, px, py);
  const label = `${buildingTypeName(sub.building?.buildingType)}, ${site.name}`;
  const scene = await buildScene(data.lib, lay.placements, { climateBase, label });
  const actionDoors = lay.actionDoorPlacements.map((i) => ({ modelId: lay.placements[i].modelId, ...scene.ranges[i], open: true }));
  const doors = scene.doors
    .filter((d) => !lay.placements[d.placement].actionDoor)
    .map((d) => ({ type: d.type, x: r3(d.centre[0]), y: r3(d.centre[1]), z: r3(-d.centre[2]), nx: r3(d.normal[0]), nz: r3(-d.normal[2]) }));
  const { ranges: _r, doors: _d, ...rest } = scene;
  return {
    kind: 'interior',
    location,
    name: label,
    region: site.region ?? null,
    source: { site: site.id, block: block.name, blockIndex: block.blockIndex, record: p.record, buildingType: sub.building?.buildingType ?? null, wilderness: `wilderness:${px},${py}` },
    ...rest,
    doors,
    actionDoors,
    flats: interiorFlats(sub),
    mechanisms: [],
    ground: { included: false },
  };
}
