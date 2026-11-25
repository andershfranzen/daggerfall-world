// Installed-data check for the production travel, portal and dungeon loaders.
// Prints aggregate counts and record identifiers. Never exports assets.
import assert from 'node:assert/strict';
import { loadTown } from '../../client/world/town.js';
import { readLocationReplaced, resolveRmbBlock } from '../../client/world/wilderness/replacements.js';
import { worldFromTown } from '../../client/gameplay/collision/world.js';
import { createRpgRuntime } from '../../server/rpg/runtime.js';
import { install as installTravel } from '../../server/rpg/travel.js';
import { clearDungeonReturn, createPortalRegistry } from '../../server/rpg/interiors/portals.js';
import { buildDungeonBlockScene, loadDungeon, locationPortals, portalSpecs } from '../../client/world/interiors/index.js';
import { RDB_SIDE } from '../../client/world/interiors/layout.js';
import { actionRecord, opcodeFamily } from '../../client/world/interiors/dungeonActions.js';
import { MANTELLAN } from '../../client/world/interiors/dungeonAccess.js';
import { arena2Dir, openSources } from './sources.mjs';

const dir = arena2Dir();
if (!dir) throw new Error('Set ARENA2_DIR to the installed classic data.');
const { data, files, catalog, worldData } = await openSources({ arena2: dir });
const mapBytes = new Map();
const read = data.maps.read.bind(data.maps);
data.maps.read = (i) => {
  if (!mapBytes.has(i)) mapBytes.set(i, read(i));
  return mapBytes.get(i);
};

const defaultLocation = 'town:Daggerfall/Gothway Garden';
const runtime = createRpgRuntime({
  players: new Map(), defaultLocation, dataPath: dir, save: () => {}, send: () => {},
  features: [{ name: 'travel', install: (ctx) => installTravel(ctx, { loadWorld: async () => ({ catalog }) }) }],
  log: { info() {}, warn() {}, error() {} },
});
const travel = runtime.ctx.services.travel;
await new Promise((res) => setImmediate(res));

const exterior = new Map();
const starts = new Map();
const blockScenes = new Map();
const resolvedRmb = new Map();
const wideCoordinates = [];
const failures = [];
const counts = { records: 0, exteriorTravel: 0, authoredPortals: 0, compatibilityPortals: 0, questOnly: 0, questItemMarkers: 0, placedRdbBlocks: 0, composedSampleScenes: 0 };
const compatibility = [];
const returnsNeedingClearance = [];
let maxReturnFromDoor = 0;

function cached(map, key, load) {
  if (!map.has(key)) map.set(key, Promise.resolve().then(load));
  return map.get(key);
}

async function checkDungeon(entry) {
  const { regionIndex: region, index: location } = entry;
  const loc = await readLocationReplaced(data.maps, region, location, worldData);
  const names = await Promise.all(loc.blockNames.map((name) => cached(resolvedRmb, name, async () => (await resolveRmbBlock(data.blocks, name, worldData)).name)));
  const layout = `${loc.width}x${loc.height}:${names.join(',')}`;
  const { spawn, world: exteriorWorld } = await cached(exterior, layout, async () => {
    const town = await loadTown(files, { region, location, worldData });
    return { spawn: town.source.spawnLocal, world: worldFromTown(town) };
  });
  const { dungeon } = await locationPortals(data, { region, location }, spawn, { dungeonOnly: true });
  assert.ok(dungeon);
  assert.equal(`town:${dungeon.target.slice(8)}`, entry.id);
  const placed = new Set(dungeon.blockRefs.map((b) => `${b.x},${b.z}`));
  assert.equal(placed.size, dungeon.blockRefs.length, 'overlapping RDB placements');
  counts.placedRdbBlocks += placed.size;
  counts.questItemMarkers += dungeon.questMarkers.length;
  assert.equal(new Set(dungeon.questMarkers.map((m) => m.id)).size, dungeon.questMarkers.length);
  for (const block of dungeon.blockRefs) {
    const key = `${block.blockName}:${block.isStartingBlock}`;
    const stats = await cached(blockScenes, key, async () => {
      const scene = await buildDungeonBlockScene(data, block);
      assert.ok(scene.positions.length && scene.atlas.width && scene.atlas.height);
      for (const v of scene.positions) assert.ok(Number.isFinite(v));
      if (block.isStartingBlock) starts.set(key, worldFromTown(scene));
      return { bounds: scene.bounds, triangles: scene.stats.triangles, textures: scene.stats.textures };
    });
    if (Math.max(Math.abs(block.x * RDB_SIDE + stats.bounds.minX), Math.abs(block.x * RDB_SIDE + stats.bounds.maxX),
      Math.abs(-block.z * RDB_SIDE + stats.bounds.minZ), Math.abs(-block.z * RDB_SIDE + stats.bounds.maxZ)) > 512) {
      wideCoordinates.push(entry.slotId);
    }
    if (block.isStartingBlock) {
      const world = starts.get(key);
      const x = dungeon.start.x - block.x * RDB_SIDE, z = dungeon.start.z + block.z * RDB_SIDE;
      const y = world.heightAt(x, z, dungeon.start.y);
      assert.ok(Number.isFinite(y) && Math.abs(y - dungeon.start.y) <= 3 && world.isClear(x, z, y), 'entry floor or clearance');
    }
  }
  const registry = createPortalRegistry();
  const spec = portalSpecs({ location: entry.id, buildings: [], dungeon })[0];
  assert.ok(spec);
  registry.register(spec);
  const p = { id: counts.records, name: 'Coverage fixture', x: 0, z: 0, yaw: 0, rpg: { location: defaultLocation, gold: 100_000 } };
  travel.discover(p, entry.slotId);
  const journey = runtime.act(p, 'travel.go', { to: entry.slotId, options: { speed: 'reckless', lodging: 'camp' } });
  if (dungeon.access === 'quest-only') {
    assert.equal(entry.id, MANTELLAN.town);
    assert.match(journey.error, /Nulfaga/);
    assert.throws(() => registry.planEnter(entry.id, { x: 0, z: 0 }, 'dungeon'), /no such door/);
    assert.throws(() => registry.planLeave(dungeon.target, dungeon.start), /no exit door/);
    assert.ok(dungeon.questSpawns[0]);
    counts.questOnly++;
    return;
  }
  if (p.rpg.location !== entry.id) assert.deepEqual(journey, { ok: true });
  counts.exteriorTravel++;
  for (const e of spec.entrances) {
    if (!exteriorWorld.isClear(e.exit.x, e.exit.z, e.exit.y)) returnsNeedingClearance.push(entry.slotId.slice(5));
    const returnTo = clearDungeonReturn(exteriorWorld, { location: spec.from, ...e.exit });
    assert.ok(returnTo, 'exterior return clearance');
    maxReturnFromDoor = Math.max(maxReturnFromDoor, Math.hypot(returnTo.x - e.x, returnTo.z - e.z));
    const plan = registry.planEnter(p.rpg.location, { x: returnTo.x, z: returnTo.z }, spec.id);
    assert.equal(plan.landing.location, dungeon.target);
    for (const exit of spec.exits) {
      assert.deepEqual(registry.planLeave(spec.to, { ...exit, y: exit.floor }, returnTo).landing, returnTo);
      assert.throws(() => registry.planLeave(spec.to, { ...exit, y: exit.floor + 20 }), /stand at the exit/);
    }
  }
  if (dungeon.access === 'authored') counts.authoredPortals++;
  else { counts.compatibilityPortals++; compatibility.push(entry.slotId.slice(5)); }
  runtime.leave(p);
}

const opcodeCounts = {};
const unsupported = {};
// Every opcode has an executor family (server/rpg/interiors/actions.js). Records whose opcode DFU leaves unexplained
// pass the activation on, as DaggerfallAction.Play does; tools/world-audit/mechanisms.mjs lists them with evidence.
const families = {};
for (const entry of catalog.locations) {
  const table = await data.maps.read(data.maps.indexOfName(`MAPTABLE.${String(entry.regionIndex).padStart(3, '0')}`));
  if (table[entry.index * 17 + 12] === 255) continue;
  counts.records++;
  try { await checkDungeon(entry); }
  catch (err) { failures.push({ record: entry.slotId.slice(5), reason: err.message }); }
}
for (const rdb of data.rdb.values()) {
  for (const obj of rdb.objects) {
    const action = actionRecord(obj);
    if (!action) continue;
    opcodeCounts[action.opcode] = (opcodeCounts[action.opcode] ?? 0) + 1;
    const family = opcodeFamily(action.opcode);
    families[family] = (families[family] ?? 0) + 1;
    if (!family) unsupported[action.opcode] = (unsupported[action.opcode] ?? 0) + 1;
  }
}
for (const id of ["dungeon:Daggerfall/Privateer's Hold", 'dungeon:Daggerfall/The Dungeon of Peristair', MANTELLAN.dungeon, MANTELLAN.returnDungeon, "dungeon:Alik'r Desert/The Stuvam Graveyard", 'dungeon:Daggerfall/THe Crypts of Wickfield']) {
  const scene = await loadDungeon(data, id);
  assert.ok(scene.positions.length && scene.uv.length && scene.atlas.pixels.length);
  counts.composedSampleScenes++;
}

console.log(JSON.stringify({
  ...counts, distinctRdb: data.rdb.size, renderedBlockVariants: blockScenes.size, exteriorLayouts: exterior.size,
  wideRecords: [...new Set(wideCoordinates)], maxReturnFromDoor, returnsNeedingClearance: [...new Set(returnsNeedingClearance)],
  opcodeCounts, families, unsupported, compatibility, failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
