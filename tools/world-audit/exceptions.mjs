// Re-derives the evidence for each census exception from the raw blocks and models and classifies it as a
// genuine source anomaly, a quest-only design, or an implementation failure for its owner. Evidence is counts only.
import { parseRdb, parseRmbFull } from '../../client/world/interiors/blocks.js';
import { hasInterior } from '../../client/world/interiors/layout.js';
import { readDungeon } from '../../client/world/interiors/dungeonMaps.js';
import { readLocationReplaced } from '../../client/world/wilderness/replacements.js';

const TYPES = ['none', 'building', 'dungeonEntrance', 'dungeonExit']; // DOOR_TYPE order (interiors/scene.js)

async function doorCounts(lib, ids) {
  const c = { none: 0, building: 0, dungeonEntrance: 0, dungeonExit: 0 };
  for (const id of ids) for (const d of (await lib.mesh(id)).doors) c[TYPES[d.type]]++;
  return c;
}

/**
 * @param {object} result census() output
 * @param {object} data openWorldData() result used for that census
 * @returns {Promise<Array<{class, owner, reason, places, assets, evidence, action}>>}
 */
export async function classifyExceptions(result, data) {
  const out = [];
  const rows = new Map(result.rows.map(r => [r.key, r]));
  const groups = new Map();
  for (const i of result.issues) {
    const g = groups.get(i.reason + '|' + i.kind) ?? { kind: i.kind, owner: i.owner, reason: i.reason, issues: [] };
    g.issues.push(i);
    groups.set(i.reason + '|' + i.kind, g);
  }
  for (const g of groups.values()) {
    const places = [...new Set(g.issues.map(i => i.place))];
    const assets = [...new Set(g.issues.map(i => i.asset))];
    const base = { kind: g.kind, owner: g.owner, reason: g.reason, count: g.issues.length, places, assets };
    if (g.reason === 'Associated dungeon has no exterior dungeon-door face') {
      out.push({ ...base, ...(await missingEntrance(result, data, places, rows)) });
    } else if (g.reason === 'Dungeon has no exit-door face') {
      out.push({ ...base, ...(await missingExit(data, places)) });
    } else if (g.reason === 'RMB interior has no exterior building-door face') {
      out.push({ ...base, ...(await doorlessInterior(data, assets)) });
    } else {
      out.push({ ...base, class: g.kind === 'optional-dependency' ? 'optional-dependency' : 'implementation', action: 'Owner ' + g.owner + ' to fix and rerun', evidence: {} });
    }
  }
  return out;
}

async function blockModels(data, name) {
  const b = parseRmbFull(await data.blocks.read(data.blocks.indexOfName(name)), name);
  return { b, ids: [...b.subRecords.flatMap(s => s.exterior.models.map(m => m.modelId)), ...b.misc3d.map(m => m.modelId)] };
}

async function missingEntrance(result, data, places, rows) {
  // Every model a failing exterior places, from the full RMB parse (sub-record exteriors and misc 3D objects).
  const blocks = new Map();
  for (const key of places) {
    const [r, i] = key.split('/').map(Number);
    const loc = await readLocationReplaced(data.maps, r, i, data.worldData);
    for (const n of loc.blockNames) blocks.set(n, (blocks.get(n) ?? new Set()).add(key));
  }
  const evidence = { types: [...new Set(places.map(k => rows.get(k)?.type))], blocks: {} };
  for (const [name] of blocks) {
    const { ids } = await blockModels(data, name);
    evidence.blocks[name] = { models: ids.length, doors: await doorCounts(data.lib, ids) };
  }
  // Same blocks elsewhere: which other records use them, and whether any of those has a working entrance.
  const failing = new Set(places);
  let sameBlockDungeons = 0, sameBlockWorking = 0, sameBlockNoDungeon = 0;
  for (const row of result.rows) {
    if (failing.has(row.key) || row.type !== 'graveyard') continue;
    const loc = await readLocationReplaced(data.maps, row.region, row.index, data.worldData);
    if (!loc.blockNames.some(n => blocks.has(n))) continue;
    if (row.expectedDungeon) { sameBlockDungeons++; if (row.dungeon) sameBlockWorking++; } else sameBlockNoDungeon++;
  }
  Object.assign(evidence, { sameBlockDungeons, sameBlockWorking, sameBlockNoDungeon,
    graveyardDungeons: result.rows.filter(r => r.type === 'graveyard' && r.expectedDungeon).length });
  const noDoors = Object.values(evidence.blocks).every(b => !b.doors.dungeonEntrance);
  return {
    class: noDoors ? 'source-anomaly' : 'implementation',
    evidence,
    action: noDoors
      ? 'Authored missing entrance: no model in these blocks has a texture-56/331 door plane, matching DFU MeshReader. G decides whether a synthetic entrance is offered; counted separately, not as a geometry failure.'
      : 'A model carries an entrance face the census missed: G/C to fix the door scan and rerun.',
  };
}

async function missingExit(data, places) {
  const evidence = {};
  let exits = 0;
  for (const key of places) {
    const [r, i] = key.split('/').map(Number);
    const dg = await readDungeon(data.maps, r, i);
    const blocks = {};
    for (const b of dg.blocks) {
      const rdb = parseRdb(await data.blocks.read(data.blocks.indexOfName(b.blockName)), b.blockName);
      const ids = rdb.objects.filter(o => o.model).map(o => rdb.modelReferences[o.model.modelIndex].modelId);
      const c = await doorCounts(data.lib, ids);
      blocks[b.blockName + (b.isStartingBlock ? ' (start)' : '')] = c.dungeonExit;
      exits += c.dungeonExit;
    }
    evidence[key] = { dungeonType: dg.dungeonType, blocks };
  }
  return {
    class: exits ? 'implementation' : 'quest-only',
    evidence,
    action: exits
      ? 'An exit face exists in a non-start block: G to confirm satellite-exit suppression and rerun.'
      : 'No block of this dungeon has a texture-95 exit plane. Entry and exit are quest teleports; G/I treat it as quest-only, not an ordinary dungeon route.',
  };
}

async function doorlessInterior(data, assets) {
  const evidence = {};
  let building = 0, entrance = 0;
  for (const a of assets) {
    const [name, rec] = a.split('#');
    const { b } = await blockModels(data, name);
    const sub = b.subRecords[Number(rec)];
    const outer = await doorCounts(data.lib, sub.exterior.models.map(m => m.modelId));
    const inner = await doorCounts(data.lib, sub.interior.models.map(m => m.modelId));
    evidence[a] = { buildingType: sub.building.buildingType, interior: hasInterior(sub), outerDoors: outer, innerBuildingDoors: inner.building };
    building += outer.building;
    entrance += outer.dungeonEntrance;
  }
  return {
    class: building ? 'implementation' : 'source-anomaly',
    evidence,
    action: building
      ? 'Exterior model has a building door the census missed: F to fix the door scan and rerun.'
      : (entrance ? 'The exterior model\'s only door faces are dungeon entrances (the castle), so DFU enters the dungeon, not this interior. ' : '')
        + 'Unreachable authored interior: F excludes it from building denominators and directions.',
  };
}
