// Daggerfall Unity WorldData replacements (World of Daggerfall's WorldData/*.json): synthetic unit tests, plus checks
// against the local ARENA2 and the operator-installed pack (gamedata/, never committed), which skip without them.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  WORLDDATA_LIMITS, WORLDDATA_PATH, classifyWorldDataFile, parseDfuJson, normalizeBlock, normalizeLocation, hydrateBlock,
  memoryWorldData, emptyWorldData, resolveRmbBlock, readLocationReplaced, rmbModelLocal, rmbBlockPlacements,
  setDefaultWorldData, defaultWorldData, remoteWorldData,
} from '../client/world/wilderness/replacements.js';
import { serverWorldData, handleWorldDataHttp, install, resolveWodRoot } from '../server/rpg/wilderness/replacements.js';
import { WorldDataError } from '../client/world/errors.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const WOD = new URL('../gamedata/world-of-daggerfall/', import.meta.url).pathname;
const hasArena = existsSync(join(ARENA2, 'MAPS.BSA'));
const hasPack = existsSync(join(WOD, 'WorldData'));
const skipReal = hasArena && hasPack ? false : 'local ARENA2 and World of Daggerfall pack not present in gamedata/';

// ------------------------------------------------------------------------------------------------ fixtures

const tile = (rec, rot = false, flip = false) => ({ TileBitfield: rec | (rot ? 0x40 : 0) | (flip ? 0x80 : 0), TextureRecord: rec, IsRotated: rot, IsFlipped: flip });
const mdl = (id, x = 0, y = 0, z = 0, yr = 0, extra = {}) => ({ ModelId: String(id), ModelIdNum: id, ObjectType: 0, XPos: x, YPos: y, ZPos: z, XScale: 1, YScale: 1, ZScale: 1, XRotation: 0, YRotation: yr, ZRotation: 0, ...extra });
const flatRec = (a, r, x = 0) => ({ Position: 0, XPos: x, YPos: 0, ZPos: 0, TextureArchive: a, TextureRecord: r, FactionID: 0, Flags: 0 });
function dfBlock(name, { subs = [], misc = [], flats = [], tiles = null } = {}) {
  return {
    Position: 1, Index: 7, Name: name, Type: 'Rmb',
    RmbBlock: {
      FldHeader: {
        NumBlockDataRecords: 99, NumMisc3dObjectRecords: 0, NumMiscFlatObjectRecords: 0, // stale on purpose
        BlockPositions: [], BuildingDataList: subs.map((s) => s.building), BlockDataSizes: [],
        GroundData: {
          Header: [0, 0, 0, 0, 0, 0, 0, 0],
          GroundTiles: tiles ?? Array.from({ length: 256 }, (_, i) => tile(i % 56, i % 3 === 0, i % 5 === 0)),
          GroundScenery: Array.from({ length: 256 }, (_, i) => ({ TextureRecord: i === 17 ? 4 : -1 })),
        },
        AutoMapData: [], Name: `${name}\u0000x`, OtherNames: [],
      },
      SubRecords: subs.map((s) => s.rec),
      Misc3dObjectRecords: misc,
      MiscFlatObjectRecords: flats,
    },
    RdbBlock: { ModelReferenceList: null, ObjectRootList: null }, RdiBlock: { Data: null },
  };
}
const sub = (x, z, yr, models, doors = [], building = { NameSeed: 3, FactionId: 0, Sector: 0, LocationId: 0, BuildingType: 'House2', Quality: 10 }) => ({
  building,
  rec: {
    XPos: x, ZPos: z, YRotation: yr,
    Exterior: { Header: {}, Block3dObjectRecords: models, BlockFlatObjectRecords: [flatRec(210, 1)], BlockSection3Records: [], BlockPeopleRecords: [], BlockDoorRecords: doors },
    Interior: { Header: {}, Block3dObjectRecords: [mdl(31020)], BlockFlatObjectRecords: [], BlockSection3Records: [{ XPos: 1, YPos: 2, ZPos: 3 }], BlockPeopleRecords: [flatRec(184, 4)], BlockDoorRecords: [] },
  },
});
const locJson = (region, index, extra = {}) => ({
  Loaded: true, Name: 'Port of Test', RegionName: 'Daggerfall', HasDungeon: false,
  MapTableData: { MapId: 123, Latitude: 36520, Longitude: 26536, LocationType: 'TownCity', Discovered: true, Key: 0 },
  Exterior: { RecordElement: { Header: {} }, BuildingCount: 0, Buildings: [], ExteriorData: { AnotherName: 'Port of Test', MapId: 1, LocationId: 0, Width: 2, Height: 1, PortTownAndUnknown: 0, BlockNames: ['FOO.RMB', 'GENRAL03.RMB'] } },
  Dungeon: { Blocks: null }, RegionIndex: region, LocationIndex: index, ...extra,
});

/** Minimal BsaArchive stand-in: names only (resolveRmbBlock never reads bytes). */
const fakeBsa = (names) => ({
  count: names.length,
  entries: names.map((name) => ({ name })),
  indexOfName: (n) => names.indexOf(n),
});

// ------------------------------------------------------------------------------------------------ formats

describe('WorldData file names and JSON', () => {
  test('only DFU replacement names are recognised', () => {
    assert.deepEqual(classifyWorldDataFile('ALCHAS00.RMB.json'), { kind: 'block', name: 'ALCHAS00.RMB' });
    assert.deepEqual(classifyWorldDataFile('x/WorldData/wodfarmaa00.rmb.json'), { kind: 'block', name: 'WODFARMAA00.RMB' });
    assert.deepEqual(classifyWorldDataFile('location-17-1246.json'), { kind: 'location', region: 17, index: 1246, key: '17-1246' });
    for (const n of ['Lighthouse.json', 'BigLighthouse.json', 'WoodenDocks.json', 'ALCHAS00.RMB.json.meta', 'location-99-1.json', 'region-17.json', 'BLOCK.RDB.json', '../ALCHAS00.RMB']) {
      assert.equal(classifyWorldDataFile(n), null, n);
    }
  });

  test('FullSerializer \\0 escapes parse; size and syntax are enforced', () => {
    assert.equal(parseDfuJson('{"Name":"FOO.RMB\\0.RMB","q":"a\\\\0b"}').Name, 'FOO.RMB\u0000.RMB');
    assert.equal(parseDfuJson('{"q":"a\\\\0b"}').q, 'a\\0b'); // an escaped backslash before 0 is not a NUL
    assert.throws(() => parseDfuJson('{'), WorldDataError);
    assert.throws(() => parseDfuJson(' '.repeat(WORLDDATA_LIMITS.fileBytes + 1)), /larger than/);
  });

  test('a DFBlock becomes the existing loader shapes; arrays win over stale header counts', () => {
    const raw = dfBlock('TEST.RMB', {
      subs: [sub(3200, 3328, 512, [mdl(642, 0, 2, 0, 0, { ObjectType: 4 })], [{ XPos: 1, YPos: 2, ZPos: 3, YRotation: -512, OpenRotation: 90, DoorModelIndex: 0 }])],
      misc: [mdl(41242, 2175, -93, -1364, 0, { ZRotation: -1820 }), mdl('53142', 1, 2, 3, 4)],
      flats: [flatRec(210, 19, 5)],
    });
    const d = normalizeBlock(JSON.parse(JSON.stringify(raw)), 'test.rmb');
    assert.equal(d.name, 'TEST.RMB');
    assert.equal(d.subRecords.length, 1);
    assert.equal(d.misc3d.length, 2);
    assert.equal(d.misc3d[0].zRotation, -1820);
    assert.equal(d.misc3d[1].modelId, 53142);
    assert.equal(d.misc3d[1].zRotation, undefined);
    const s = d.subRecords[0];
    assert.deepEqual([s.xPos, s.zPos, s.yRotation], [3200, 3328, 512]);
    assert.equal(s.building.buildingType, 18); // House2
    assert.equal(s.exterior.doors[0].openRotation, 90);
    assert.equal(s.interior.section3, 1);
    // Ground: row-major file order, bitfield rebuilt from TextureRecord/IsRotated/IsFlipped (what DFU reads).
    assert.equal(d.groundTiles[3], 3 | 0x40);
    assert.equal(d.groundTiles[5], 5 | 0x80);
    assert.equal(d.scenery[17], 20);
    assert.equal(d.scenery[0], 255);
    const h = hydrateBlock(JSON.parse(JSON.stringify(d)), 420);
    assert.ok(h.groundTiles instanceof Uint8Array && h.scenery instanceof Uint8Array);
    assert.equal(h.subRecords[0].models[0].modelId, 642); // parseRmb shape
    assert.equal(h.subRecords[0].flats[0].archive, 210); // parseRmbFlats shape
    assert.equal(h.subRecords[0].interior.models[0].modelId, 31020); // parseRmbFull shape
    assert.equal(h.blockIndex, 420);
  });

  test('malformed or oversized blocks are refused', () => {
    assert.throws(() => normalizeBlock({}, 'A.RMB'), /RmbBlock/);
    assert.throws(() => normalizeBlock(dfBlock('A.RMB'), '../A.RMB'), /not an RMB block name/);
    assert.throws(() => normalizeBlock({ ...dfBlock('A.RMB'), Type: 'Rdb' }, 'A.RMB'), /not RMB/);
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { misc: [mdl(1, 1 << 22)] }), 'A.RMB'), /XPos/);
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { misc: [mdl(123456)] }), 'A.RMB'), /model id/);
    const big = Array.from({ length: WORLDDATA_LIMITS.models + 1 }, () => mdl(1));
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { misc: big }), 'A.RMB'), /limit/);
    const subs = Array.from({ length: 33 }, () => sub(0, 0, 0, []));
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { subs }), 'A.RMB'), /sub-records/);
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { tiles: [tile(1)] }), 'A.RMB'), /256 entries/);
    assert.throws(() => normalizeBlock(dfBlock('A.RMB', { subs: [sub(0, 0, 0, [], [], { BuildingType: 'Castle' })] }), 'A.RMB'), /building type/);
  });

  test('a DFLocation becomes a block layout bound to its file name', () => {
    const d = normalizeLocation(locJson(17, 1246), 17, 1246);
    assert.deepEqual({ name: d.name, w: d.width, h: d.height, b: d.blockNames, lon: d.longitude }, { name: 'Port of Test', w: 2, h: 1, b: ['FOO.RMB', 'GENRAL03.RMB'], lon: 26536 });
    assert.throws(() => normalizeLocation(locJson(17, 1), 17, 1246), /LocationIndex/);
    const bad = locJson(17, 1246);
    bad.Exterior.ExteriorData.BlockNames = ['FOO.RMB'];
    assert.throws(() => normalizeLocation(bad, 17, 1246), /block names/);
    bad.Exterior.ExteriorData.BlockNames = ['../../X', 'Y.RMB'];
    assert.throws(() => normalizeLocation(bad, 17, 1246), /not an RMB block/);
    bad.Exterior.ExteriorData.Width = 9;
    assert.throws(() => normalizeLocation(bad, 17, 1246), /width/);
  });
});

// ------------------------------------------------------------------------------------------------ providers and loader hooks

describe('providers and block/location resolution', () => {
  test('files are read lazily, once, and a broken file falls back to vanilla', async () => {
    const reads = [];
    const errors = [];
    const wd = memoryWorldData([
      { name: 'ALCHAS00.RMB.json', text: async () => (reads.push('A'), JSON.stringify(dfBlock('ALCHAS00.RMB'))) },
      { name: 'BROKEN.RMB.json', text: async () => (reads.push('B'), '{nope') },
      { name: 'Lighthouse.json', text: async () => (reads.push('L'), '{}') },
    ], { onError: (e) => errors.push(e.message) });
    assert.deepEqual((await wd.index()).blocks, ['ALCHAS00.RMB', 'BROKEN.RMB']);
    assert.deepEqual(reads, []); // the index of blocks needs no reads
    assert.ok(await wd.block('alchas00.rmb'));
    await wd.block('ALCHAS00.RMB');
    assert.equal(await wd.block('BROKEN.RMB'), null);
    assert.equal(await wd.block('GENRAL03.RMB'), null);
    assert.deepEqual(reads, ['A', 'B']);
    assert.equal(errors.length, 1);
  });

  test('resolveRmbBlock follows BlocksFile: exact name, JSON-only block, prefix/suffix alternate, then vanilla', async () => {
    const bsa = fakeBsa(['GENRAL03.RMB', 'ALCHAS00.RMB', 'TVRNAL00.RMB']);
    const wd = memoryWorldData([
      { name: 'ALCHAS00.RMB.json', text: JSON.stringify(dfBlock('ALCHAS00.RMB')) },
      { name: 'FOO.RMB.json', text: JSON.stringify(dfBlock('FOO.RMB')) },
    ]);
    const a = await resolveRmbBlock(bsa, 'ALCHAS00.RMB', wd);
    assert.equal(a.index, 1);
    assert.equal(a.block.replaced, true);
    const foo = await resolveRmbBlock(bsa, 'FOO.RMB', wd);
    assert.equal(foo.index, 3); // after the BSA, like WorldDataReplacement.AssignNewIndex
    assert.ok(foo.block);
    const alt = await resolveRmbBlock(bsa, 'TVRNBL00.RMB', wd); // CheckName: same 4-char prefix and 6-char suffix
    assert.deepEqual([alt.index, alt.name, alt.block], [2, 'TVRNAL00.RMB', null]);
    assert.deepEqual(await resolveRmbBlock(bsa, 'GENRAL03.RMB', wd), { index: 0, name: 'GENRAL03.RMB', block: null });
    assert.deepEqual(await resolveRmbBlock(bsa, 'ALCHAS00.RMB', null), { index: 1, name: 'ALCHAS00.RMB', block: null });
    assert.equal((await resolveRmbBlock(bsa, 'NOPE.RMB', wd)).index, -1);
  });

  test('Node loaders default to vanilla until the server registers a provider', async () => {
    assert.equal(await defaultWorldData([]), null);
    const wd = emptyWorldData('x');
    setDefaultWorldData(wd);
    try {
      assert.equal(await defaultWorldData([]), wd);
    } finally {
      setDefaultWorldData(null);
    }
  });

  test('model-local transform: yaw-only records keep the fast path; Z rotation and scale match Unity TRS', () => {
    assert.equal(rmbModelLocal({ yRotation: 512 }), null);
    // ZRotation -512 native = +90 degrees about z (DFU negates): (1,0,0) -> (0,1,0).
    const f = rmbModelLocal({ zRotation: -512, yRotation: 0 });
    const [x, y, z] = f(1, 0, 0);
    assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 1) < 1e-9 && Math.abs(z) < 1e-9);
    const s = rmbModelLocal({ yRotation: 0, scale: [2, 3, 4] });
    assert.deepEqual(s(1, 1, 1), [2, 3, 4]);
    // Pure yaw through the general path equals town.js rotY (x*c + z*s, -x*s + z*c).
    const g = rmbModelLocal({ yRotation: -512, scale: [1, 1, 1.0000001] });
    const [gx, , gz] = g(1, 0, 0);
    assert.ok(Math.abs(gx) < 1e-6 && Math.abs(gz + 1) < 1e-6);
  });

  test('rmbBlockPlacements lays sub-record and misc models out like town.js', () => {
    const h = hydrateBlock(normalizeBlock(dfBlock('T.RMB', { subs: [sub(2048, 2048, 0, [mdl(1, 40, -80, 0)])], misc: [mdl(2, 0, 0, -4096)] }), 'T.RMB'));
    const [b, m] = rmbBlockPlacements(h);
    assert.deepEqual(b.place(0, 0, 0).map((v) => +v.toFixed(3)), [52.2, 2, 51.2]);
    assert.deepEqual(m.place(0, 0, 0).map((v) => +v.toFixed(3)), [0, -0.1, 0]);
  });
});

// ------------------------------------------------------------------------------------------------ HTTP

function fakeRes() {
  const r = { status: 0, headers: {}, body: '', headersSent: false };
  r.writeHead = (s, h = {}) => { r.status = s; r.headers = h; r.headersSent = true; return r; };
  r.end = (b) => { r.body = b ?? ''; r.done?.(); };
  r.wait = () => new Promise((ok) => { r.done = ok; if (r.headersSent && r.body !== undefined && r.status) ok(); });
  return r;
}
async function get(provider, url, method = 'GET') {
  const res = fakeRes();
  const p = res.wait();
  const handled = handleWorldDataHttp(provider, { url, method }, res);
  if (!handled) return { handled };
  await p;
  return { handled, status: res.status, json: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

describe('same-origin descriptor route', () => {
  const provider = memoryWorldData([
    { name: 'ALCHAS00.RMB.json', text: JSON.stringify(dfBlock('ALCHAS00.RMB')) },
    { name: 'location-17-1246.json', text: JSON.stringify(locJson(17, 1246)) },
  ]);
  test('serves the index and normalized descriptors only', async () => {
    const i = await get(provider, WORLDDATA_PATH);
    assert.equal(i.status, 200);
    assert.deepEqual(i.json.blocks, ['ALCHAS00.RMB']);
    assert.deepEqual(i.json.locations, [{ region: 17, index: 1246, name: 'Port of Test' }]);
    const b = await get(provider, `${WORLDDATA_PATH}/block?name=alchas00.rmb`);
    assert.equal(b.status, 200);
    assert.equal(b.json.kind, 'rmb');
    assert.equal(b.json.RmbBlock, undefined); // never the raw file
    assert.equal(b.headers['X-Content-Type-Options'], 'nosniff');
    const l = await get(provider, `${WORLDDATA_PATH}/location?region=17&index=1246`);
    assert.deepEqual(l.json.blockNames, ['FOO.RMB', 'GENRAL03.RMB']);
  });
  test('unknown names, traversal and other methods are refused', async () => {
    assert.equal((await get(provider, `${WORLDDATA_PATH}/block?name=../../WorldOfDaggerfall.dfmod.json`)).status, 404);
    assert.equal((await get(provider, `${WORLDDATA_PATH}/block?name=GENRAL03.RMB`)).status, 404);
    assert.equal((await get(provider, `${WORLDDATA_PATH}/location?region=17&index=1`)).status, 404);
    assert.equal((await get(provider, `${WORLDDATA_PATH}/raw`)).status, 404);
    assert.equal((await get(null, WORLDDATA_PATH)).status, 503);
    const res = fakeRes();
    handleWorldDataHttp(provider, { url: WORLDDATA_PATH, method: 'POST' }, res);
    assert.equal(res.status, 405);
    assert.equal((await get(provider, '/api/wilderness/scene')).handled, false);
  });
  test('the browser client reads it through fetch and asks only for what it needs', async () => {
    const asked = [];
    const fetchFn = async (url) => {
      asked.push(url);
      const r = await get(provider, url);
      return { status: r.status, ok: r.status === 200, json: async () => r.json };
    };
    const wd = await remoteWorldData({ fetchFn });
    assert.equal(await wd.block('GENRAL03.RMB'), null);
    assert.equal((await wd.block('ALCHAS00.RMB')).name, 'ALCHAS00.RMB');
    await wd.block('ALCHAS00.RMB');
    assert.deepEqual(asked, [WORLDDATA_PATH, `${WORLDDATA_PATH}/block?name=ALCHAS00.RMB`]);
    assert.equal(await remoteWorldData({ fetchFn: async () => ({ status: 404, ok: false }) }), null);
  });
});

// ------------------------------------------------------------------------------------------------ real data

describe('World of Daggerfall 0.4.0 WorldData against the local install', { skip: skipReal }, () => {
  let files, wd, vanilla, replaced;
  before(async () => {
    if (skipReal) return;
    const { arena2Files } = await import('../server/rpg/collision/arena2.js');
    const { loadTown } = await import('../client/world/town.js');
    files = await arena2Files(ARENA2);
    wd = await serverWorldData(WOD, { log: { warn: (m) => assert.fail(m) } });
    vanilla = await loadTown(files, { region: 'Daggerfall', location: 'Copperfield Manor', worldData: null });
    replaced = await loadTown(files, { region: 'Daggerfall', location: 'Copperfield Manor', worldData: wd });
  });

  test('coverage: the bundle-listed replacements are indexed; unlisted and non-DFU files are not', async () => {
    const idx = await wd.index();
    assert.deepEqual(idx.locations, [{ region: 17, index: 1246, name: 'Port of Daggerfall' }]);
    for (const n of ['ALCHAS00', 'ALCHAS01', 'ALCHAS02', 'ALCHAS03', 'ALCHBS00', 'ALCHBS01', 'BANKAS00', 'BANKAS01', 'BANKAS02', 'BANKBS00', 'BANKBS01', 'FOO']) {
      assert.ok(idx.blocks.includes(`${n}.RMB`), n);
    }
    assert.ok(!idx.blocks.includes('FOOBAR.RMB') && !idx.blocks.includes('FOOBGR.RMB')); // not in WorldOfDaggerfall.dfmod.json
    assert.deepEqual(wd.skipped.sort(), ['FOOBAR.RMB.json', 'FOOBGR.RMB.json']);
    assert.equal(resolveWodRoot({}, { WOD_PATH: '/x' }), '/x');
  });

  test('every block replacement parses; farms use classic models, docks also need the RMB Resource Pack', async () => {
    const { BsaArchive, NUMBER_RECORD } = await import('../client/world/bsa.js');
    const arch = await BsaArchive.open(files.find((f) => f.name === 'ARCH3D.BSA'), 'ARCH3D.BSA', NUMBER_RECORD);
    for (const name of (await wd.index()).blocks) {
      const d = await wd.block(name);
      assert.ok(d, name);
      const ids = new Set([...d.misc3d, ...d.subRecords.flatMap((s) => [...s.exterior.models, ...s.interior.models])].map((m) => m.modelId));
      const missing = [...ids].filter((id) => arch.indexOfId(id) < 0);
      if (/^BANK/.test(name)) assert.deepEqual(missing, [], name);
      // The rest come from the optional "rmb resource pack" dependency (custom ids 45179+ and 52xxx/53xxx).
      for (const id of missing) assert.ok(id >= 45000, `${name}: model ${id}`);
      assert.ok(missing.length < ids.size, `${name} has classic models too`);
    }
  });

  test('location-17-1246.json turns Copperfield Manor into the 3x3 Port of Daggerfall; vanilla is untouched', () => {
    assert.equal(vanilla.source.width * vanilla.source.height, 1);
    assert.deepEqual(vanilla.source.blocks.map((b) => b.name), ['MANRAS00.RMB']);
    assert.equal(vanilla.displayName, undefined);
    assert.equal(replaced.name, 'Copperfield Manor'); // the location id stays the MAPNAMES entry
    assert.equal(replaced.displayName, 'Port of Daggerfall');
    assert.deepEqual([replaced.source.width, replaced.source.height], [3, 3]);
    assert.deepEqual(replaced.source.blocks.map((b) => b.name), ['TVRNAL00.RMB', 'TVRNAL03.RMB', 'TEMPAAH0.RMB', 'MARKAA01.RMB', 'PALAAA02.RMB', 'KDRAAL00.RMB', 'FARMAA02.RMB', 'GENRAL03.RMB', 'FARMAA07.RMB']);
    assert.equal(replaced.source.worldData.file, 'location-17-1246.json');
    assert.ok(replaced.stats.triangles > vanilla.stats.triangles * 4);
  });

  test('the replacement name also resolves, to the same layout', async () => {
    const { BsaArchive, NAME_RECORD } = await import('../client/world/bsa.js');
    const maps = await BsaArchive.open(files.find((f) => f.name === 'MAPS.BSA'), 'MAPS.BSA', NAME_RECORD);
    const a = await readLocationReplaced(maps, 17, 'Port of Daggerfall', wd);
    const b = await readLocationReplaced(maps, 17, 'copperfield manor', wd);
    assert.deepEqual([a.index, a.width, a.name], [1246, 3, 'Copperfield Manor']);
    assert.deepEqual(a.blockNames, b.blockNames);
    const gothway = await readLocationReplaced(maps, 17, 'Gothway Garden', wd);
    assert.equal(gothway.replaced, undefined);
  });

  test('server doors, collision and town services agree with the browser layout through ctx.services.worldData', async () => {
    const { openWorldData, locationPortals, loadInterior } = await import('../client/world/interiors/index.js');
    const { arena2Loader } = await import('../server/rpg/collision/arena2.js');
    const ctx = { config: { wodPath: WOD }, log: { info() {}, warn: (m) => assert.fail(m) }, services: {} };
    const feature = install(ctx);
    await feature.ready;
    try {
      // Server path: features take ctx.services.worldData.ready (collision.js, interiors.js, townServices.js).
      const served = ctx.services.worldData.ready;
      const { readCatalog } = await import('../client/gameplay/travel/catalog.js');
      const catalogue = await readCatalog(files.find(f => f.name.toUpperCase() === 'MAPS.BSA'), served);
      const port = catalogue.get('town:Daggerfall/Copperfield Manor');
      assert.equal(port.name, 'Port of Daggerfall');
      assert.equal(catalogue.search('Port of Daggerfall')[0], port);
      assert.equal(catalogue.search('Copperfield Manor', { filter: l => l.region === 'Daggerfall' })[0], port);
      const data = await openWorldData(files, { worldData: served });
      const portals = await locationPortals(data, { region: 'Daggerfall', location: 'Copperfield Manor' }, replaced.source.spawnLocal);
      assert.ok(portals.buildings.length > 50, `${portals.buildings.length} buildings`);
      const browserData = await openWorldData(files, { worldData: wd });
      const browserPortals = await locationPortals(browserData, { region: 'Daggerfall', location: 'Copperfield Manor' }, replaced.source.spawnLocal);
      assert.deepEqual(portals, browserPortals);
      const clothier = browserPortals.buildings.find(b => b.name === "Port of Daggerfall's Best Clothes");
      assert.ok(clothier?.target.startsWith('interior:Daggerfall/Copperfield Manor/'));
      assert.equal((await loadInterior(browserData, clothier.target)).name, "Port of Daggerfall's Best Clothes, Port of Daggerfall");
      // Every door stands inside the replaced town's bounds, not in the 1x1 manor's.
      for (const b of portals.buildings) for (const d of b.doors) {
        assert.ok(d.x >= replaced.bounds.minX - 1 && d.x <= replaced.bounds.maxX + 1 && d.z >= replaced.bounds.minZ - 1 && d.z <= replaced.bounds.maxZ + 1, `${b.portalId}`);
      }
      const area = await arena2Loader(ARENA2, ctx.services)('town:Daggerfall/Copperfield Manor');
      assert.match(area.source, /Copperfield Manor/);
      assert.ok(area.world, 'collision world');
      // Same triangle count as the browser's replaced load (loadTown is the shared source of both).
      const { loadTown } = await import('../client/world/town.js');
      const serverTown = await loadTown(files, { region: 'Daggerfall', location: 'Copperfield Manor', worldData: served });
      assert.equal(serverTown.stats.triangles, replaced.stats.triangles);
      assert.deepEqual(serverTown.source.spawnLocal, replaced.source.spawnLocal);
      // Town services read the replacement's own building list (96 entries) and 3x3 layout.
      const { arena2ServiceLoader } = await import('../server/rpg/townServices/buildings.js');
      const svc = await arena2ServiceLoader(ARENA2, served)('town:Daggerfall/Copperfield Manor');
      assert.ok(svc.counters.length >= 5, `${svc.counters.length} service counters`);
      assert.ok(svc.counters.every((c) => /^b:[0-2],[0-2]:\d+$/.test(c.id)));
      // The HTTP route the browser uses is served from the same provider.
      const r = await get(ctx.services.worldData.ready, `${WORLDDATA_PATH}/location?region=17&index=1246`);
      assert.equal(r.json.width, 3);
    } finally {
      setDefaultWorldData(null);
    }
  });

  test('a missing pack keeps everything vanilla', async () => {
    const none = await serverWorldData(join(WOD, 'does-not-exist'));
    assert.deepEqual(await none.index(), { v: 1, blocks: [], locations: [] });
    const { loadTown } = await import('../client/world/town.js');
    const t = await loadTown(files, { region: 'Daggerfall', location: 'Copperfield Manor', worldData: none });
    assert.equal(t.stats.triangles, vanilla.stats.triangles);
  });
});

after(() => setDefaultWorldData(null));
