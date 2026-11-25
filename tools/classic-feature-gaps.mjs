// Record-level evidence for docs/classic-feature-backlog.md, from an unmodified classic installation.
// Room totals describe the authored data. The quest and spell flags come from the production loaders.
import { resolve } from 'node:path';
import { openSources, ROOT } from './world-audit/sources.mjs';
import { memo } from './world-audit/blocks.mjs';
import { readLocation } from '../client/world/maps.js';
import { parseRmbFull } from '../client/world/interiors/blocks.js';
import { buildingTypeName } from '../client/world/interiors/index.js';
import { roomBeds } from '../client/world/interiors/layout.js';
import { buildingDirectory } from '../client/world/interiors/buildingDirectory.js';
import { resolveRmbBlock } from '../client/world/wilderness/replacements.js';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { loadCatalogue } from '../server/rpg/magic/catalogue.js';
import { EFFECTS } from '../server/rpg/magic/effects.js';
import { artifactResolver, loadMagicDef } from '../server/rpg/alchemy/magicdef.js';

const dir = resolve(process.env.ARENA2_DIR || resolve(ROOT, 'gamedata/DaggerfallGameFiles/arena2'));
const { data, catalog } = await openSources({ arena2: dir });
const maps = Object.create(data.maps);
maps.read = memo(i => data.maps.read(i));
const directoryData = { ...data, maps };

// A named building's MAPS entry supplies quality, faction and name seed. Its type and its
// number of authored people come from the RMB subrecord, so repeated blocks can be counted once.
const buildingsInBlock = memo(async name => {
  const block = await resolveRmbBlock(data.blocks, name, data.worldData);
  if (block.index < 0) throw new Error('Missing block ' + name);
  const { subRecords } = parseRmbFull(await data.blocks.read(block.index), block.name);
  return { subRecords: subRecords.map(sub => ({ building: sub.building, houseFile: sub.houseFile, index: sub.index,
    people: sub.interior.people.length, beds: sub.building.buildingType === 15 ? roomBeds(sub).length : 0 })) };
});
const taverns = { buildings: 0, people: 0, histogram: {}, empty: [], beds: 0, bedHistogram: {}, withoutBedMarkers: [] };
const buildings = { total: 0, withoutFixedPeople: 0, people: 0, byType: {} };
const buildingNames = {};
for (const entry of catalog.locations) {
  const place = await readLocation(maps, entry.regionIndex, entry.index);
  const directory = await buildingDirectory(directoryData, entry.regionIndex, place, buildingsInBlock);
  for (const b of directory.values()) {
    const row = buildingNames[b.buildingType] ??= { type: buildingTypeName(b.buildingType), named: 0, generic: 0 };
    if (b.name) row.named++;
    else row.generic++;
  }
  for (const [cell, name] of place.blockNames.entries()) {
    for (const room of (await buildingsInBlock(name)).subRecords) {
      const code = room.building.buildingType;
      const type = buildings.byType[code] ??= { name: buildingTypeName(code), total: 0, withoutFixedPeople: 0, people: 0 };
      type.total++;
      buildings.total++;
      type.people += room.people;
      buildings.people += room.people;
      if (!room.people) {
        type.withoutFixedPeople++;
        buildings.withoutFixedPeople++;
      }
      if (code !== 15) continue;
      taverns.buildings++;
      taverns.people += room.people;
      taverns.beds += room.beds;
      taverns.bedHistogram[room.beds] = (taverns.bedHistogram[room.beds] ?? 0) + 1;
      if (!room.beds) taverns.withoutBedMarkers.push({
        place: entry.slotId, bx: cell % place.width, by: Math.floor(cell / place.width), block: name, record: room.index,
      });
      taverns.histogram[room.people] = (taverns.histogram[room.people] ?? 0) + 1;
      if (!room.people) taverns.empty.push({
        place: entry.slotId, bx: cell % place.width, by: Math.floor(cell / place.width), block: name, record: room.index,
      });
    }
  }
}

const magicItems = loadMagicDef(dir);
const artifactTemplate = artifactResolver(magicItems.records.filter(r => r.type === 1 || r.type === 2));
const quests = loadCatalog({
  dataPath: dir,
  artifact: magicItems.error ? null : r => !!artifactTemplate(r.detail ?? r.classicItem?.index),
});
const spells = loadCatalogue({ arena2Dir: dir });
if (spells.source !== 'SPELLS.STD') throw new Error(spells.error ?? 'Missing SPELLS.STD');
const blocked = [...quests.quests.values()].filter(q => !q.analysis.offerable);
const effects = [...EFFECTS.values()].map(({ key, type, subType, support, reason }) => ({ key, type, subType, support, reason }));
const effectCounts = {};
for (const { support } of effects) effectCounts[support] = (effectCounts[support] ?? 0) + 1;
const spellRecords = [...spells.spells.values()].map(s => ({
  id: s.id, index: s.index, name: s.name, support: s.support, hidden: s.hidden, targetType: s.targetType, element: s.element,
  effects: s.effects.map(e => ({ key: e.template.key, support: e.template.support })),
}));
console.log(JSON.stringify({
  world: { locations: catalog.locations.length, buildings, taverns, buildingNames },
  quests: {
    parsed: quests.quests.size, offerable: quests.quests.size - blocked.length,
    ...(magicItems.error ? { artifactCatalogueError: magicItems.error } : {}),
    readFailures: quests.failures,
    blocked: blocked.map(q => ({ id: q.name, group: q.meta.group, reasons: [...new Set(q.analysis.unsupported)] })),
  },
  magic: {
    spells: spells.coverage, spellRecords, effectCounts, effects,
    outstandingSpells: spellRecords.filter(s => s.support !== 'full'),
  },
}, null, 2));
