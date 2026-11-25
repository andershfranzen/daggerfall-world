// Audit one copy of each resolved archive record; aliases and repeated map cells reuse its result.
import { parseRmb } from '../../client/world/blocks.js';
import { parseRmbFull, parseRdb } from '../../client/world/interiors/blocks.js';
import { dungeonLayout, hasInterior, interiorLanding, interiorLayout, isRdbActionDoor, rmbModelMatrix } from '../../client/world/interiors/layout.js';
import { DOOR_TYPE, placedDoors, point } from '../../client/world/interiors/scene.js';
import { resolveRmbBlock, rmbBlockPlacements } from '../../client/world/wilderness/replacements.js';

export function memo(fn) {
  const values = new Map();
  return key => {
    if (!values.has(key)) values.set(key, fn(key));
    return values.get(key);
  };
}

export const issue = (kind, owner, asset, reason, at = '') => ({ kind, owner, asset, reason, at });

// Expand each placed model plane to a triangle fan. Keep just the count after materializing
// its numeric vertices; full texture/atlas/spawn builds use the regular loaders on the routes.
function triangles(mesh, place) {
  let n = 0;
  for (const plane of mesh.planes) {
    const p = plane.points.map(q => place(q.x * 0.025, -q.y * 0.025, q.z * 0.025));
    for (let i = 2; i < p.length; i++) {
      if (![...p[0], ...p[i - 1], ...p[i]].every(Number.isFinite)) throw Error('non-finite triangle vertex');
      n++;
    }
  }
  return n;
}

const asPlacement = m => ({ modelId: m.modelId, matrix: rmbModelMatrix(m) });
const forMatrix = matrix => (x, y, z) => point(matrix, x, y, z);

function switchLink(bytes, block) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objects = new Map(block.objects.map(o => [o.position, o]));
  for (const o of block.objects) {
    if (!o.model || o.model.triggerFlagStartingLock !== 2 || o.model.actionOffset <= 0) continue;
    const ref = block.modelReferences[o.model.modelIndex];
    // Classic lever or wheel. A candidate requires an actual next-object pointer to an action door.
    if (![61028, 61032].includes(ref.modelId)) continue;
    const target = objects.get(v.getInt32(o.model.actionOffset + 5, true));
    if (!target?.model || !isRdbActionDoor(block, target.model.modelIndex)) continue;
    return {
      triggerModel: ref.modelId, triggerOffset: o.position, triggerFlag: o.model.triggerFlagStartingLock,
      doorModel: block.modelReferences[target.model.modelIndex].modelId, doorOffset: target.position,
    };
  }
  return null;
}

export function blockInspector(data) {
  const { lib, blocks, worldData } = data;
  const stats = { rmb: 0, rdb: 0, rmbComplete: 0, rdbComplete: 0, models: 0, modelFailures: 0,
    exteriorTriangles: 0, interiorTriangles: 0, dungeonTriangles: 0 };
  const mesh = memo(async id => {
    stats.models++;
    try { return await lib.mesh(id); }
    catch (error) { stats.modelFailures++; throw error; }
  });

  async function geometry(placements, issues, owner, at, optional, exteriorModels = null) {
    let total = 0;
    for (const p of placements) {
      try {
        const m = await mesh(p.modelId);
        total += triangles(m, p.place ?? forMatrix(p.matrix));
        exteriorModels?.push(p.modelId);
      } catch (err) {
        const kind = optional && lib.arch.indexOfId(p.modelId) < 0 ? 'optional-dependency' : 'geometry';
        issues.push(issue(kind, owner, 'ARCH3D:' + p.modelId, err.message, at));
      }
    }
    return total;
  }

  async function inspectRmb(r) {
    stats.rmb++;
    const bytes = r.block ? null : await blocks.read(r.index);
    const outer = r.block ?? parseRmb(bytes, r.name);
    const full = r.block ?? parseRmbFull(bytes, r.name);
    const issues = [], exteriorModels = [];
    stats.exteriorTriangles += await geometry(rmbBlockPlacements(outer), issues, r.block ? 'H' : 'C', r.name, !!r.block, exteriorModels);
    if (outer.groundTiles.length !== 256) issues.push(issue('geometry', 'C', r.name, 'Missing 16×16 ground tiles'));
    let entrances = 0, interiors = 0, enterable = 0, exteriorDoors = 0, pairedDoors = 0, exitDoors = 0;
    const entranceModels = Object.create(null);
    const portals = [];
    for (const id of exteriorModels) {
      const n = (await mesh(id)).doors.filter(d => d.type === DOOR_TYPE.DUNGEON_ENTRANCE).length;
      entrances += n;
      if (n) entranceModels[id] = n;
    }
    for (const sub of full.subRecords) {
      const at = r.name + '#' + sub.index;
      const outerDoors = [];
      for (const m of sub.exterior.models) {
        if (!exteriorModels.includes(m.modelId)) continue;
        outerDoors.push(...(await placedDoors({ mesh }, [asPlacement(m)])).filter(d => d.type === DOOR_TYPE.BUILDING));
      }
      exteriorDoors += outerDoors.length;
      if (!hasInterior(sub)) continue;
      interiors++;
      let layout;
      try { layout = await interiorLayout({ mesh }, sub, r.index, sub.index); }
      catch (error) { issues.push(issue('geometry', 'F', at, error.message)); continue; }
      stats.interiorTriangles += await geometry(layout.placements, issues, 'F', at, !!r.block);
      const inner = [];
      for (const p of layout.placements.filter(p => !p.actionDoor)) {
        try { inner.push(...await placedDoors({ mesh }, [p])); }
        catch { /* Model-specific failure already recorded by geometry(). */ }
      }
      const exits = inner.filter(d => d.type === DOOR_TYPE.BUILDING).length;
      if (!outerDoors.length) {
        issues.push(issue('source-portal', 'F', at, 'RMB interior has no exterior building-door face'));
        continue;
      }
      let paired = 0;
      for (const d of outerDoors) {
        try {
          const land = interiorLanding(d.centre, inner, layout.enterMarkers);
          if (!land.position.every(Number.isFinite)) throw Error('Non-finite interior landing');
          if (exits) paired++;
        } catch (err) { issues.push(issue('building-portal', 'F', at, err.message)); }
      }
      if (!exits) issues.push(issue('source-portal', 'F', at, 'RMB interior has no return door face'));
      pairedDoors += paired;
      exitDoors += exits;
      if (paired) {
        enterable++;
        portals.push({ record: sub.index, type: sub.building.buildingType, doors: paired });
      }
    }
    if (!issues.some(i => ['geometry', 'optional-dependency'].includes(i.kind))) stats.rmbComplete++;
    return { name: r.name, entrances, entranceModels, interiors, enterable, exteriorDoors, pairedDoors, exitDoors, portals, issues };
  }

  const byRmb = new Map();
  const rmb = memo(async name => {
    const r = await resolveRmbBlock(blocks, name, worldData);
    if (r.index < 0) throw Error('BLOCKS.BSA has no exact or classic fallback RMB');
    if (!byRmb.has(r.index)) byRmb.set(r.index, inspectRmb(r));
    return byRmb.get(r.index);
  });

  const rdb = memo(async name => {
    const i = blocks.indexOfName(name);
    if (i < 0) throw Error('BLOCKS.BSA has no matching RDB');
    stats.rdb++;
    const bytes = await blocks.read(i);
    const block = parseRdb(bytes, name, i);
    const layout = dungeonLayout([{ x: 0, z: 0, isStartingBlock: true, rdb: block }]);
    const issues = [];
    stats.dungeonTriangles += await geometry(layout.placements, issues, 'G', name, false);
    let startExits = 0, regularExits = 0;
    for (const p of layout.placements.filter(p => !p.actionDoor)) {
      let m;
      try { m = await mesh(p.modelId); } catch { continue; }
      const n = m.doors.filter(d => d.type === DOOR_TYPE.DUNGEON_EXIT).length;
      startExits += n;
      if (p.modelId !== 70300) regularExits += n; // production suppresses this exit model in satellite blocks
    }
    if (!issues.length) stats.rdbComplete++;
    return { issues, starts: layout.startMarkers.length, startExits, regularExits, link: switchLink(bytes, block),
      questItems: block.objects.filter(o => o.flat?.archive === 199 && o.flat.record === 18).length };
  });
  return { mesh, rmb, rdb, stats };
}
