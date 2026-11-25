import { climateAt, climateSettings, REGION_NAMES, readRegionNames } from '../../client/world/maps.js';
import { mapPixelOf } from '../../client/gameplay/travel/catalog.js';
import { readLocationReplaced } from '../../client/world/wilderness/replacements.js';
import { readDungeon } from '../../client/world/interiors/dungeonMaps.js';
import { blockInspector, issue, memo } from './blocks.mjs';

export const add = (obj, key, count = 1) => { obj[key] = (obj[key] ?? 0) + count; };
const slot = (region, index) => region + '/' + index;
const suffix = region => String(region).padStart(3, '0');

export async function census(data, catalog, { record = null } = {}) {
  // Byte cache is scoped to this invocation. BSA.read returns fresh bytes; MAPS readers only read them.
  let mapReads = 0;
  const maps = Object.create(data.maps);
  maps.read = memo(i => { mapReads++; return data.maps.read(i); });
  const inspect = blockInspector(data);
  const climate = new Uint8Array(await data.index.get('CLIMATE.PAK').arrayBuffer());
  const rows = [], issues = [], matrix = {}, totals = {}, groups = new Map(), mapCounts = {};
  let archiveNames = 0, dungeonHeaders = 0;
  for (let r = 0; r < REGION_NAMES.length; r++) {
    if (record && record[0] !== r) continue;
    if (maps.indexOfName('MAPNAMES.' + suffix(r)) < 0) continue;
    const names = await readRegionNames(maps, r);
    if (!names.length) continue;
    archiveNames += names.length;
    const raw = await maps.read(maps.indexOfName('MAPTABLE.' + suffix(r)));
    const table = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const d = await maps.read(maps.indexOfName('MAPDITEM.' + suffix(r)));
    const headers = d.length >= 4 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(0, true) : 0;
    dungeonHeaders += headers;
    const associations = new Set();
    mapCounts[r] = { names: names.length, dungeonHeaders: headers };
    for (let index = 0; index < names.length; index++) {
      if (record && record[1] !== index) continue;
      const key = slot(r, index), asset = 'MAPPITEM.' + suffix(r) + '#' + index;
      const local = [], entry = catalog.at(r, index);
      const duplicateKey = r + '/' + names[index].toLowerCase();
      if (!groups.has(duplicateKey)) groups.set(duplicateKey, []);
      groups.get(duplicateKey).push(key);
      const wantedDungeon = table.getUint8(index * 17 + 12) !== 255;
      const row = { key, region: r, index, name: entry?.name ?? names[index], type: entry?.type ?? 'unknown',
        x: entry?.x, y: entry?.y, expectedDungeon: wantedDungeon, buildings: 0, dungeon: false };
      const error = (kind, owner, ref, reason, at = '') => local.push(issue(kind, owner, ref, reason, at));
      let loc, exteriorRead = true, entrances = 0;
      try {
        if (!entry || catalog.get('town:' + key) !== entry || catalog.atPixel(entry.x, entry.y) !== entry)
          error('identity', 'A', asset, 'Key or pixel does not return this record');
        loc = await readLocationReplaced(maps, r, index, data.worldData);
        const pixel = mapPixelOf(loc.longitude, loc.latitude);
        if (loc.index !== index || loc.name !== names[index] || pixel.x !== entry?.x || pixel.y !== entry?.y)
          error('identity', 'A', asset, 'Decoded exterior disagrees with indexed name, slot or pixel');
        row.size = [loc.width, loc.height];
        row.climate = climateSettings(climateAt(climate, loc.longitude, loc.latitude)).label;
        if (loc.replaced) row.replaced = loc.replaced.file;
        if (loc.blockNames.length !== loc.width * loc.height) throw Error('Grid length disagrees with exterior dimensions');
        for (const [i, block] of loc.blockNames.entries()) {
          add(totals, 'rmbReferences');
          const cell = (i % loc.width) + ',' + Math.floor(i / loc.width);
          try {
            const result = await inspect.rmb(block);
            add(totals, 'rmbResolved');
            if (result.name !== block) add(totals, 'rmbFallbacks');
            for (const e of result.issues) local.push({ ...e, at: cell + '/' + (e.at || result.name) });
            entrances += result.entrances;
            row.buildings += result.enterable;
            for (const k of ['interiors','enterable','exteriorDoors','pairedDoors','exitDoors']) add(totals, k, result[k]);
            if (!row.portal && result.portals.length) row.portal = { cell, block: result.name, ...result.portals[0] };
          } catch (err) {
            exteriorRead = false;
            error('geometry', 'C', block, err.message, cell);
          }
        }
      } catch (err) { exteriorRead = false; error('geometry', 'A', asset, err.message); }
      try {
        const dg = await readDungeon(maps, r, index);
        if (!!dg !== wantedDungeon) error('association', 'A', 'MAPDITEM.' + suffix(r), 'MAPTABLE dungeon type and MAPDITEM association disagree');
        if (dg) {
          add(totals, 'associatedDungeons');
          if (associations.has(dg.locationId)) error('association', 'A', 'MAPDITEM.' + suffix(r), 'Two exteriors resolve the same dungeon header');
          associations.add(dg.locationId);
          let starts = 0, exits = 0, rdbRead = true, startBlocks = 0;
          const starting = [];
          for (const b of dg.blocks) {
            add(totals, 'rdbReferences');
            if (b.isStartingBlock) { startBlocks++; starting.push(b.blockName); }
            try {
              const res = await inspect.rdb(b.blockName);
              add(totals, 'rdbResolved');
              for (const e of res.issues) local.push({ ...e, at: b.x + ',' + b.z + '/' + b.blockName });
              if (b.isStartingBlock) starts += res.starts;
              exits += b.isStartingBlock ? res.startExits : res.regularExits;
              if (res.link && (!row.link || res.link.triggerModel === 61028)) row.link = { block: b.blockName, x: b.x, z: b.z, ...res.link };
            } catch (err) {
              rdbRead = false;
              error('geometry', 'G', b.blockName, err.message, b.x + ',' + b.z);
            }
          }
          const ref = starting.join(',') || 'MAPDITEM.' + suffix(r);
          if (startBlocks !== 1) error('dungeon-portal', 'G', ref, 'Expected one starting block; found ' + startBlocks);
          if (rdbRead && !starts) error('source-portal', 'G', ref, 'Starting block has no 199.10 start marker');
          if (rdbRead && !exits) error('source-portal', 'G', ref, 'Dungeon has no exit-door face');
          if (exteriorRead && !entrances) error('source-portal', 'G', loc.blockNames.join(','), 'Associated dungeon has no exterior dungeon-door face');
          if (starts) add(totals, 'withStart');
          if (exits) add(totals, 'withExit');
          if (entrances) add(totals, 'withDungeonEntrance');
          row.dungeon = !!(rdbRead && starts && exits && entrances);
          row.startBlock = ref;
        }
      } catch (err) { error('association', 'A', 'MAPDITEM.' + suffix(r), err.message); }
      const unique = [...new Map(local.map(e => [JSON.stringify(e), e])).values()];
      issues.push(...unique.map(e => ({ place: key, ...e })));
      row.catalogued = !!entry && !unique.some(i => i.kind === 'identity');
      row.geometry = !unique.some(i => ['identity','geometry','association','optional-dependency'].includes(i.kind));
      row.complete = !unique.length;
      rows.push(row);
      matrix[r] ??= {};
      const c = matrix[r][row.type] ??= { records: 0, catalogued: 0, geometry: 0, complete: 0 };
      c.records++; c.catalogued += +row.catalogued; c.geometry += +row.geometry; c.complete += +row.complete;
    }
    if (!record && headers !== associations.size)
      issues.push({ place: r + '/*', ...issue('association', 'A', 'MAPDITEM.' + suffix(r), 'Unique linked headers ' + associations.size + ' of ' + headers) });
  }
  if (record && !rows.length) throw Error('No record ' + record.join('/'));
  return { rows, issues, matrix, totals, archiveNames, dungeonHeaders, mapCounts, mapReads, inspect,
    duplicates: [...groups.values()].filter(g => g.length > 1) };
}
