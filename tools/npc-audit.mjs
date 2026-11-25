#!/usr/bin/env node
// NPC coverage audit (docs/world-expansion-plan.md brief F). Read-only over the operator's installed data.
//
//   node tools/npc-audit.mjs [--mode classic|pack] [--record 17/841] [--out progress/npc-audit] [--strict]
//
// Every person category is walked through the same production code the server uses (server/rpg/npcs/people.js,
// population.js) and counted at each stage:
//   parsed     the source record was read
//   placed     a finite position in the location's output frame (interior/dungeon/town), foot or centre
//   appearance TEXTURE.<archive> exists and holds the record (people) / the mobile archive set exists
//   identity   a non-empty display name (individual faction name, or the DFU NameHelper name)
//   service    a role/service was decided (StaticNPCClick rules); counted per service
//   reachable  the building has a paired exterior/interior door (brief B's block inspector), the dungeon has an
//              entrance, or the town has walkable navgrid cells
// Exceptions are listed with a reason and owner. Writes <out>/<mode>/{summary.json,summary.txt}. Output holds counts
// and record keys only; no original text or art.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { arena2Dir, openSources, ROOT, wodRoot } from './world-audit/sources.mjs';
import { blockInspector } from './world-audit/blocks.mjs';
import { REGION_NAMES, readRegionNames } from '../client/world/maps.js';
import { readLocationReplaced, resolveRmbBlock } from '../client/world/wilderness/replacements.js';
import { readDungeon } from '../client/world/interiors/dungeonMaps.js';
import { parseRmbFull, parseRdb } from '../client/world/interiors/blocks.js';
import { parseRmbFlats } from '../client/world/scenery/rmbFlats.js';
import { readTables, readAutomap, readGroundTiles, locationTypeOf, hasWanderingPeople } from '../server/rpg/npcs/world.js';
import {
  interiorPeople, exteriorPeople, dungeonPeople, interiorQuestMarkers, dungeonQuestMarkers, FACTION_TYPE, NPC_ARCHIVES,
} from '../server/rpg/npcs/people.js';
import { buildNavGrid, PEOPLE_TEXTURES, GUARD_TEXTURE, POPULATION_PER_16_BLOCKS } from '../server/rpg/npcs/population.js';
import { pooledBuildingData, locationBuildingList } from '../server/rpg/townServices/buildings.js';
import { buildingPortalId } from '../client/world/interiors/index.js';
import { readQbn } from '../server/rpg/quests/qbn.js';

const { values: opt } = parseArgs({ options: {
  mode: { type: 'string', default: 'classic' }, record: { type: 'string' }, out: { type: 'string' }, strict: { type: 'boolean' },
  arena2: { type: 'string' }, wod: { type: 'string' },
} });
const arena2 = arena2Dir(opt.arena2);
if (!arena2) { console.error('No ARENA2 data (set ARENA2_DIR or install gamedata/DaggerfallGameFiles/arena2)'); process.exit(2); }
const wod = opt.mode === 'pack' ? wodRoot(opt.wod) : null;
const record = opt.record ? opt.record.split('/').map(Number) : null;
const outDir = resolve(opt.out ?? join(ROOT, 'progress/npc-audit'), opt.mode);

const t0 = performance.now();
const src = await openSources({ arena2, wod });
const { data } = src;
const tables = readTables(arena2);
const inspect = blockInspector(data);

// TEXTURE.nnn record counts (first u16 of the file).
const textureCounts = new Map();
for (const n of readdirSync(arena2)) {
  const m = /^TEXTURE\.(\d{3})$/i.exec(n);
  if (!m) continue;
  const b = readFileSync(join(arena2, n));
  textureCounts.set(Number(m[1]), b.length >= 2 ? b.readUInt16LE(0) : 0);
}
const hasArt = (a, r) => (textureCounts.get(a) ?? 0) > r;

const STAGES = ['parsed', 'placed', 'appearance', 'identity', 'service', 'reachable'];
const cats = {};
const cat = (k) => (cats[k] ??= { ...Object.fromEntries(STAGES.map((s) => [s, 0])), services: {}, unique: new Set(), exceptions: {} });
const exception = (c, reason, owner, at) => {
  const e = (c.exceptions[reason] ??= { owner, count: 0, examples: [] });
  e.count++;
  if (e.examples.length < 5) e.examples.push(at);
};
const finite = (e) => [e.x, e.y, e.z].every(Number.isFinite);

function score(c, e, reachable, at, uniqueKey) {
  c.parsed++;
  c.unique.add(uniqueKey);
  if (finite(e) && Math.abs(e.y) < 200) c.placed++; else exception(c, 'non-finite or out-of-range position', 'F', at);
  if (hasArt(e.sprite.archive, e.sprite.record)) c.appearance++; else exception(c, `missing art ${e.sprite.archive}/${e.sprite.record}`, 'source', at);
  if (e.name && e.name.trim()) c.identity++; else exception(c, 'no name', 'F', at);
  if (e.role) {
    c.service++;
    const k = e.service + (e.questGroup ? `+${e.questGroup}` : e._workGroup ? `+work:${e._workGroup}` : e._castleGroup ? `+castle:${e._castleGroup}` : '');
    c.services[k] = (c.services[k] ?? 0) + 1;
  }
  if (reachable === true) c.reachable++;
  else exception(c, reachable || 'unreachable', reachable?.startsWith?.('castle') ? 'source' : 'F', at);
}

const individuals = new Map(); // faction id -> [location keys]
const counts = { locations: 0, locationsWithPeople: 0, towns: 0, dungeons: 0, mobileCapacity: 0, questSpawnInterior: 0, questItemInterior: 0, questSpawnDungeon: 0, questItemDungeon: 0, errors: [] };
const dungeonEntrances = new Map(); // from brief B's inspector: block -> entrances

for (let r = 0; r < REGION_NAMES.length; r++) {
  if (record && record[0] !== r) continue;
  if (data.maps.indexOfName(`MAPNAMES.${String(r).padStart(3, '0')}`) < 0) continue;
  const names = await readRegionNames(data.maps, r);
  for (let index = 0; index < names.length; index++) {
    if (record && record[1] !== index) continue;
    counts.locations++;
    const key = `${r}/${index}`;
    let loc;
    try {
      loc = await readLocationReplaced(data.maps, r, index, data.worldData);
    } catch (err) {
      counts.errors.push({ key, reason: err.message });
      continue;
    }
    const town = loc.townId;
    const [, rn, ln] = /^town:([^/]+)\/(.+)$/.exec(town) ?? [];
    const blocks = [];
    let entrances = 0;
    let anyPeople = false;
    for (let by = 0; by < loc.height; by++) {
      for (let bx = 0; bx < loc.width; bx++) {
        const name = loc.blockNames[by * loc.width + bx];
        const res = await resolveRmbBlock(data.blocks, name, data.worldData);
        if (res.index < 0) { counts.errors.push({ key, reason: `missing block ${name}` }); continue; }
        let full, flats, automap = null, groundTiles = null;
        if (res.block) {
          full = { subRecords: res.block.subRecords };
          flats = res.block;
          groundTiles = res.block.groundTiles;
          const v = data.blocks.indexOfName(res.name);
          if (v >= 0 && v < data.blocks.count) automap = readAutomap(await data.blocks.read(v));
        } else {
          const bytes = await data.blocks.read(res.index);
          full = parseRmbFull(bytes, res.name);
          flats = parseRmbFlats(bytes, res.name);
          automap = readAutomap(bytes);
          groundTiles = readGroundTiles(bytes);
        }
        let insp = null;
        try { insp = await inspect.rmb(name); } catch { insp = null; }
        entrances += insp?.entrances ?? 0;
        blocks.push({ x: bx, y: by, name: res.name, full, flats, automap, groundTiles, enterable: new Set((insp?.portals ?? []).map((p) => p.record)) });
      }
    }
    let pooled = new Map();
    try { pooled = await pooledBuildingData({ blocks: data.blocks, worldData: data.worldData }, loc, loc.buildings ?? (await locationBuildingList(data.maps, r, loc.index))); } catch { /* sub-record data */ }
    const ctx = { regionIndex: r, locationIndex: loc.index, ...tables };

    // Interior people.
    const ci = cat('rmb-interior');
    for (const b of blocks) {
      for (const sub of b.full.subRecords) {
        if (!sub.interior.people.length && !sub.interior.flats.length) continue;
        const location = `interior:${rn}/${ln}/${b.x},${b.y}/${sub.index}`;
        const building = { ...sub.building, ...(pooled.get(buildingPortalId(b.x, b.y, sub.index)) ?? {}) };
        const people = interiorPeople({ location, sub, bx: b.x, by: b.y, building, ...ctx });
        const m = interiorQuestMarkers(sub);
        counts.questSpawnInterior += m.spawn.length;
        counts.questItemInterior += m.item.length;
        const enterable = b.enterable.has(sub.index);
        const why = enterable ? true : (sub.interior.models.length ? (/^CUST/i.test(b.name) ? 'castle/custom building without its own door' : 'building has no paired door') : 'no interior');
        people.forEach((e, k) => {
          anyPeople = true;
          score(ci, e, why, `${key} ${b.name}#${sub.index}.${k}`, `${b.name}#${sub.index}.${k}`);
          if (e.individual) (individuals.get(e.faction) ?? individuals.set(e.faction, []).get(e.faction)).push(`${key}:interior`);
        });
      }
    }
    // Exterior authored people.
    const ce = cat('rmb-exterior');
    const ext = exteriorPeople({ location: town, blocks: blocks.map((b) => ({ x: b.x, y: b.y, name: b.name, rmb: b.flats })), spawnLocal: { x: 0, z: 0 }, ...ctx });
    for (const e of ext) {
      anyPeople = true;
      score(ce, e, true, `${key} ${e._source.block}:${e._source.tag}`, `${e._source.block}:${e._source.tag}`);
      if (e.individual) (individuals.get(e.faction) ?? individuals.set(e.faction, []).get(e.faction)).push(`${key}:exterior`);
    }
    // Mobile population (DFU PopulationManager capacity) where the town has walkable navgrid.
    const wandering = hasWanderingPeople(await locationTypeOf(data.maps, r, loc.index));
    const cm = cat('mobile-townspeople');
    const nav = buildNavGrid(blocks, loc.width, loc.height, { x: 0, z: 0 });
    const capacity = Math.max(1, Math.min(4, Math.floor((loc.width * loc.height) / 16))) * POPULATION_PER_16_BLOCKS;
    counts.towns++;
    if (!wandering) { counts.noWandering = (counts.noWandering ?? 0) + 1; }
    else {
    counts.mobileCapacity += capacity;
    cm.parsed++;
    cm.unique.add(key);
    if (nav.walkable > 0) { cm.placed++; cm.reachable++; } else exception(cm, nav.missingAutomap ? 'replacement block without automap' : 'no walkable navgrid cell', 'source', key);
    const archivesOk = Object.values(PEOPLE_TEXTURES).every((g) => [...g.male, ...g.female].every((a) => hasArt(a, 0))) && hasArt(GUARD_TEXTURE, 0);
    if (archivesOk) cm.appearance++; else exception(cm, 'mobile person archive missing', 'source', key);
    if (tables.banks) cm.identity++; else exception(cm, 'NAMEGEN.DAT missing', 'source', key);
    cm.service++;
    cm.services.mobile = (cm.services.mobile ?? 0) + capacity;
    }

    // Dungeon people.
    let dungeon = null;
    try { dungeon = await readDungeon(data.maps, r, loc.index); } catch { dungeon = null; }
    if (dungeon) {
      counts.dungeons++;
      const cd = cat('rdb-dungeon');
      const rdbBlocks = [];
      for (const b of dungeon.blocks) {
        const bi = data.blocks.indexOfName(b.blockName);
        if (bi < 0) { counts.errors.push({ key, reason: `missing RDB ${b.blockName}` }); continue; }
        rdbBlocks.push({ x: b.x, z: b.z, rdb: parseRdb(await data.blocks.read(bi), data.blocks.entries[bi].name, bi) });
      }
      const location = `dungeon:${rn}/${ln}`;
      const people = dungeonPeople({ location, blocks: rdbBlocks, ...ctx });
      const m = dungeonQuestMarkers(rdbBlocks);
      counts.questSpawnDungeon += m.spawn.length;
      counts.questItemDungeon += m.item.length;
      for (const e of people) {
        anyPeople = true;
        score(cd, e, entrances > 0 ? true : 'dungeon has no exterior entrance', `${key} ${e._source.block}:${e._source.root}.${e._source.index}`, `${e._source.block}:${e._source.root}.${e._source.index}`);
        if (e.individual) (individuals.get(e.faction) ?? individuals.set(e.faction, []).get(e.faction)).push(`${key}:dungeon`);
      }
    }
    if (anyPeople) counts.locationsWithPeople++;
  }
}

// Individuals (FACTION.TXT type 4): authored somewhere, or only placed by quests (DFU "atHome"/quest placement).
const ind = cat('faction-individuals');
const individualRows = [];
for (const f of tables.factions?.values() ?? []) {
  if (f.type !== FACTION_TYPE.Individual) continue;
  ind.parsed++;
  ind.unique.add(String(f.id));
  const homes = individuals.get(f.id) ?? [];
  const flat = f.flats[0];
  if (flat && hasArt(flat[0], flat[1])) ind.appearance++; else exception(ind, flat ? `missing art ${flat[0]}/${flat[1]}` : 'no FACTION.TXT flat', 'source', `#${f.id}`);
  if (f.name) ind.identity++;
  if (homes.length) { ind.placed++; ind.reachable++; ind.service++; } else exception(ind, 'no authored record: placed only by quests (DFU Person/atHome)', 'quests', `#${f.id}`);
  individualRows.push({ id: f.id, homes: homes.length, first: homes[0] ?? null });
}

// Quest people: Person resources of every QBN in the install. Generic people are placed by the quest engine at
// quest spawn markers (services.npcs.questSpawn) or played by the giver; individuals need their authored home.
const qp = cat('quest-people');
let qbnFiles = 0, qbnErrors = 0;
const questIndividuals = new Map();
for (const n of readdirSync(arena2)) {
  if (!/\.QBN$/i.test(n)) continue;
  qbnFiles++;
  let q;
  try { q = readQbn(readFileSync(join(arena2, n))); } catch { qbnErrors++; continue; }
  q.people.forEach((r, i) => {
    const f = tables.factions?.get(r.p3);
    const indiv = f?.type === FACTION_TYPE.Individual;
    qp.parsed++;
    qp.unique.add(`${n}#${i}`);
    qp.identity++;
    qp.service++;
    const kind = indiv ? 'individual' : r.p2 === 0 && r.p3 === 0 ? 'questor' : 'generic';
    qp.services[kind] = (qp.services[kind] ?? 0) + 1;
    if (indiv) {
      questIndividuals.set(f.id, f.name);
      const homes = individuals.get(f.id) ?? [];
      if (homes.length) { qp.placed++; qp.appearance++; qp.reachable++; }
      else {
        if (f.flats[0] && hasArt(f.flats[0][0], f.flats[0][1])) qp.appearance++;
        exception(qp, 'individual without authored home: quest places them (DFU Place/atHome)', 'quests', `${n} #${f.id}`);
      }
    } else {
      // Generic quest people spawn at 199/11 markers of the chosen building/dungeon; questors are the giver.
      qp.placed++;
      qp.appearance++;
      qp.reachable++;
    }
  });
}

const summary = {
  mode: opt.mode,
  record: opt.record ?? null,
  generated: new Date().toISOString(),
  seconds: Math.round((performance.now() - t0) / 100) / 10,
  counts: { ...counts, errors: counts.errors.length, errorExamples: counts.errors.slice(0, 10), qbnFiles, qbnErrors, questIndividuals: questIndividuals.size },
  categories: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, {
    ...Object.fromEntries(STAGES.map((s) => [s, c[s]])), uniqueRecords: c.unique.size, services: c.services,
    exceptions: c.exceptions,
  }])),
  individuals: { total: individualRows.length, authored: individualRows.filter((x) => x.homes).length, rows: individualRows.slice(0, 400) },
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
const lines = [`NPC audit (${opt.mode}${opt.record ? ` ${opt.record}` : ''}) — ${counts.locations} locations, ${counts.locationsWithPeople} with authored people, ${summary.seconds}s`];
for (const [k, c] of Object.entries(summary.categories)) {
  lines.push(`${k.padEnd(20)} ${STAGES.map((s) => `${s} ${c[s]}`).join(' · ')} · unique ${c.uniqueRecords}`);
  for (const [reason, e] of Object.entries(c.exceptions)) lines.push(`    exception [${e.owner}] ${reason}: ${e.count}  e.g. ${e.examples.slice(0, 3).join(', ')}`);
  const svc = Object.entries(c.services).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([s, n]) => `${s} ${n}`).join(', ');
  if (svc) lines.push(`    services: ${svc}`);
}
lines.push(`quest markers: interior spawn ${counts.questSpawnInterior}, item ${counts.questItemInterior}; dungeon spawn ${counts.questSpawnDungeon}, item ${counts.questItemDungeon}`);
lines.push(`mobile capacity (sum of per-town pools): ${counts.mobileCapacity}; ${counts.noWandering ?? 0} locations have no wandering people by DFU location type (dungeons, shrines, cottages, covens, graveyards, ships)`);
writeFileSync(join(outDir, 'summary.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
const implementationFailures = Object.values(summary.categories).flatMap((c) => Object.values(c.exceptions)).filter((e) => e.owner === 'F').reduce((n, e) => n + e.count, 0);
if (opt.strict && (implementationFailures || counts.errors.length)) process.exitCode = 1;
void existsSync; void NPC_ARCHIVES;
