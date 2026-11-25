// Scenery: RMB flat records, flat texture frames, SKY files, the terrain apron and the
// browser feature's scene lifetime. Synthetic fixtures only (an invented hamlet,
// "Wrenfold Hollow"); the local-data checks live in rpg-scenery-data.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RMB_LAYOUT } from '../client/world/blocks.js';
import { parseRmbFlats, layoutTownFlats, sceneryRecord, flatKind, BLOCK_SIZE } from '../client/world/scenery/rmbFlats.js';
import { FlatArchive } from '../client/world/scenery/flatTextures.js';
import { readDaySky, skyBase, natureArchive, SKY_FILE_SIZE, SKY_WIDTH, SKY_HEIGHT } from '../client/world/scenery/sky.js';
import { buildSurroundings, readWoodsHeightmap, hash2 } from '../client/world/scenery/terrain.js';
import { packSprites, buildBillboards, BILLBOARD_STRIDE } from '../client/world/scenery/index.js';
import { interleaveTerrain } from '../client/gameplay/scenery/pass.js';
import { install } from '../client/gameplay/scenery.js';
import { arrivalStatus } from '../client/lib/arrival.js';
import { PALETTE } from '../client/render/renderer.js';

// ---------------------------------------------------------------- synthetic RMB

function flatRecord(v, at, { x, y, z, archive, record, faction = 0, flags = 0 }) {
  v.setInt32(at, x, true);
  v.setInt32(at + 4, y, true);
  v.setInt32(at + 8, z, true);
  v.setUint16(at + 12, (archive << 7) | record, true);
  v.setInt16(at + 14, faction, true);
  v.setUint8(at + 16, flags);
}

/** One sub-record with one model and two flats, two misc 3D models, three misc flats, two scenery tiles. */
function wrenfoldBlock() {
  const L = RMB_LAYOUT;
  const subSize = 17 + L.MODEL_RECORD_SIZE + 2 * L.FLAT_RECORD_SIZE + 1; // + padding byte
  const size = L.BLOCK_DATA_AT + subSize + 2 * L.MODEL_RECORD_SIZE + 3 * L.FLAT_RECORD_SIZE;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 1; b[1] = 2; b[2] = 3;
  v.setInt32(L.BLOCK_POSITIONS_AT + 8, 1000, true); // sub-record XPos
  v.setInt32(L.BLOCK_POSITIONS_AT + 12, 2000, true); // ZPos
  v.setInt32(L.BLOCK_SIZES_AT, subSize, true);
  const scenery = L.GROUND_AT + 8 + 256;
  b.fill(255, scenery, scenery + 256);
  b[scenery + 15 * 16 + 0] = (5 + 1) * 4; // file row 15, column 0 = south-west tile, record 5
  b[scenery + 0 * 16 + 3] = (1 + 1) * 4 + 2; // file row 0, column 3, record 1 (low bits are flags)
  b[scenery + 16 + 4] = 4; // record 0: marker, ignored
  let p = L.BLOCK_DATA_AT;
  b[p] = 1; b[p + 1] = 2;
  p += 17 + L.MODEL_RECORD_SIZE;
  flatRecord(v, p, { x: 100, y: 0, z: -300, archive: 210, record: 3 });
  flatRecord(v, p + 17, { x: 50, y: -40, z: -60, archive: 504, record: 7 }); // nature in a sub-record
  p = L.BLOCK_DATA_AT + subSize + 2 * L.MODEL_RECORD_SIZE;
  flatRecord(v, p, { x: 2048, y: 0, z: -2048, archive: 212, record: 2 });
  flatRecord(v, p + 17, { x: 10, y: 0, z: -10, archive: 199, record: 8 }); // editor marker
  flatRecord(v, p + 34, { x: 20, y: 0, z: -20, archive: 182, record: 1, faction: 77 }); // a person
  return b;
}

test('RMB flats: sub-record, misc and scenery records parse at DFU offsets', () => {
  const rmb = parseRmbFlats(wrenfoldBlock(), 'WRENAA00.RMB');
  assert.equal(rmb.subRecords.length, 1);
  assert.deepEqual(rmb.subRecords[0].flats.map((f) => [f.archive, f.record]), [[210, 3], [504, 7]]);
  assert.equal(rmb.subRecords[0].xPos, 1000);
  assert.deepEqual(rmb.miscFlats.map((f) => [f.archive, f.record, f.factionId]), [[212, 2, 0], [199, 8, 0], [182, 1, 77]]);
  assert.equal(sceneryRecord(255), -1);
  assert.equal(sceneryRecord(4), 0);
  assert.equal(sceneryRecord(10), 1);
  assert.equal(flatKind(210), 'light');
  assert.equal(flatKind(201), 'animal');
  assert.equal(flatKind(506), 'nature');
  assert.equal(flatKind(182), 'person');
  assert.equal(flatKind(212), 'decoration');
});

test('RMB flats lay out in loadTown output space with people and editor markers excluded', () => {
  const rmb = parseRmbFlats(wrenfoldBlock(), 'WRENAA00.RMB');
  const spawnLocal = { x: 51.2, z: 51.2 };
  const { flats, skipped } = layoutTownFlats([{ x: 0, y: 0, rmb }], spawnLocal, 508);
  assert.deepEqual(skipped, { people: 1, editor: 1 });
  const bySource = (s) => flats.filter((f) => f.source === s);
  // Scenery: tile (0,0) south-west → DFU (0, -2, 256)*0.025 → output (-51.2, -0.05, 51.2-6.4)
  const sc = bySource('scenery');
  assert.equal(sc.length, 2);
  const sw = sc.find((f) => f.record === 5);
  assert.equal(sw.archive, 508);
  assert.ok(Math.abs(sw.x - -51.2) < 1e-9 && Math.abs(sw.y - -0.05) < 1e-9 && Math.abs(sw.z - 44.8) < 1e-9);
  const ne = sc.find((f) => f.record === 1); // file row 0 = north row, column 3
  assert.ok(Math.abs(ne.x - (3 * 6.4 - 51.2)) < 1e-9 && Math.abs(ne.z - (51.2 - 102.4)) < 1e-9);
  // Misc flat at block centre: (2048, -6, -2048+4096)*0.025 → (51.2, -0.15, 51.2) → output (0, -0.15, 0)
  const misc = bySource('misc');
  assert.equal(misc.length, 1);
  assert.ok(Math.abs(misc[0].x) < 1e-9 && Math.abs(misc[0].z) < 1e-9 && Math.abs(misc[0].y + 0.15) < 1e-9);
  // Exterior flats add the sub-record offset (XPos, -ZPos); nature swaps to the climate set.
  const ext = bySource('exterior');
  assert.deepEqual(ext.map((f) => [f.archive, f.kind]), [[210, 'light'], [508, 'nature']]);
  const lamp = ext[0];
  assert.ok(Math.abs(lamp.x - ((100 + 1000) * 0.025 - 51.2)) < 1e-9);
  assert.ok(Math.abs(lamp.z - -((-300 + 4096 - 2000) * 0.025 - 51.2)) < 1e-9);
  assert.ok(Math.abs(ext[1].y - -0.05) < 1e-9);
});

// ---------------------------------------------------------------- flat textures

function textureArchive(records) {
  // records: [{w,h,scaleX,scaleY,rows: Uint8Array[] }] single frame, uncompressed 256 stride
  const headers = 26 + records.length * 20;
  const recHeaders = records.length * 28;
  let at = headers + recHeaders;
  const offsets = records.map((r) => { const o = at; at += r.h * 256; return o; });
  const b = new Uint8Array(at);
  const v = new DataView(b.buffer);
  v.setInt16(0, records.length, true);
  records.forEach((r, i) => {
    const pos = headers + i * 28;
    v.setInt32(26 + i * 20 + 2, pos, true);
    v.setInt16(pos + 4, r.w, true);
    v.setInt16(pos + 6, r.h, true);
    v.setInt16(pos + 8, 0, true);
    v.setUint32(pos + 14, offsets[i] - pos, true);
    v.setUint16(pos + 20, 1, true);
    v.setInt16(pos + 24, r.scaleX, true);
    v.setInt16(pos + 26, r.scaleY, true);
    r.rows.forEach((row, y) => b.set(row, offsets[i] + y * 256));
  });
  return b;
}

test('flat archive: frames decode and billboard size follows GetScaledBillboardSize', () => {
  const fa = new FlatArchive(textureArchive([
    { w: 4, h: 2, scaleX: 0, scaleY: 0, rows: [Uint8Array.of(0, 1, 2, 3), Uint8Array.of(4, 5, 6, 7)] },
    { w: 40, h: 80, scaleX: -128, scaleY: 256, rows: [] },
  ]), 212);
  assert.deepEqual([...fa.decode(0).data], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(fa.size(0), { width: 0.1, height: 0.05 });
  const s = fa.size(1); // 40 + trunc(40 * -0.5) = 20; 80 + 80 = 160
  assert.ok(Math.abs(s.width - 0.5) < 1e-9 && Math.abs(s.height - 4) < 1e-9);
  assert.throws(() => fa.decode(5), /record 5 does not exist/);
});

test('sprite atlas keeps palette index 0 transparent and lays frames in strips', () => {
  const palette = new Uint8Array(768).map((_, i) => i % 256);
  const frame = (fill) => ({ width: 3, height: 2, data: Uint8Array.of(0, fill, fill, fill, fill, 0) });
  const { atlas, rects } = packSprites([{ key: '212:2', size: { width: 1, height: 2 }, frames: [frame(9), frame(10)] }], palette);
  const r = rects.get('212:2');
  assert.equal(r.frames, 2);
  const px = (x, y) => atlas.pixels[(y * atlas.width + x) * 4 + 3];
  const x0 = Math.round(r.u0 * atlas.width), y0 = Math.round(r.v0 * atlas.height);
  assert.equal(px(x0, y0), 0);
  assert.equal(px(x0 + 1, y0), 255);
  assert.equal(atlas.pixels[(y0 * atlas.width + x0 + 1) * 4], palette[27]);
  const x1 = Math.round((r.u0 + r.stride) * atlas.width);
  assert.equal(atlas.pixels[(y0 * atlas.width + x1 + 1) * 4], palette[30]);
  const bb = buildBillboards([{ x: 1, y: 2, z: 3, sprite: { key: '212:2' } }], rects, { mapId: 9 });
  assert.equal(bb.count, 6);
  assert.equal(bb.vertices.length, 6 * BILLBOARD_STRIDE);
  // First vertex: bottom-left corner, base at y offset 0, width 1 m → -0.5.
  assert.deepEqual([...bb.vertices.subarray(0, 5)], [1, 2, 3, -0.5, 0]);
});

// ---------------------------------------------------------------- sky

test('SKY file: frame palette, east/west halves, afternoon swap and horizon colour', async () => {
  const bytes = new Uint8Array(SKY_FILE_SIZE);
  // Frame 5 palette: index 1 = (10,20,30), index 2 = (200,100,50)
  const pal = 776 * 5 + 8;
  bytes.set([10, 20, 30], pal + 3);
  bytes.set([200, 100, 50], pal + 6);
  const F = SKY_WIDTH * SKY_HEIGHT;
  bytes.fill(1, 549120 + F * 5, 549120 + F * 6); // east frame 5
  bytes.fill(2, 549120 + F * 37, 549120 + F * 38); // west frame 5
  const read = async (o, n) => bytes.subarray(o, o + n);
  const am = await readDaySky(read, bytes.length, 5);
  assert.equal(am.width, 1024);
  assert.deepEqual([...am.pixels.subarray(0, 3)], [10, 20, 30]); // left = east
  assert.deepEqual([...am.pixels.subarray(600 * 4, 600 * 4 + 3)], [200, 100, 50]); // right = west
  assert.deepEqual(am.horizon.map((c) => Math.round(c * 255)), [200, 100, 50]);
  const pm = await readDaySky(read, bytes.length, 58); // 63 - 58 = 5, halves swapped
  assert.deepEqual([...pm.pixels.subarray(0, 3)], [200, 100, 50]);
  assert.deepEqual(pm.horizon.map((c) => Math.round(c * 255)), [10, 20, 30]);
  await assert.rejects(readDaySky(read, 1000, 5), /truncated/);
  assert.equal(skyBase(231), 16);
  assert.equal(skyBase(225), 8);
  assert.equal(skyBase(226), 0);
  assert.equal(skyBase(228), 24);
  assert.equal(natureArchive(231), 504);
  assert.equal(natureArchive(230), 506);
  assert.equal(natureArchive(224), 503);
});

// ---------------------------------------------------------------- terrain

const wrenfoldRect = { minX: -40, maxX: 62.4, minZ: -62.4, maxZ: 40 };

test('surroundings are deterministic, leave the town area to the town and keep nature off it', () => {
  const a = buildSurroundings({ townRect: wrenfoldRect, heightmap: null, mapPixel: { x: 10, y: 10 }, pixelOffset: { x: 11.2, z: -11.2 }, seed: 77, extent: 200, maxNature: 500, natureRange: 150 });
  const b = buildSurroundings({ townRect: wrenfoldRect, heightmap: null, mapPixel: { x: 10, y: 10 }, pixelOffset: { x: 11.2, z: -11.2 }, seed: 77, extent: 200, maxNature: 500, natureRange: 150 });
  assert.deepEqual(a.positions, b.positions);
  assert.deepEqual(a.nature, b.nature);
  assert.ok(a.positions.length > 0 && a.nature.length > 0 && a.nature.length <= 500);
  for (let i = 0; i < a.positions.length; i += 18) {
    const cx = (a.positions[i] + a.positions[i + 3] + a.positions[i + 6]) / 3;
    const cz = (a.positions[i + 2] + a.positions[i + 5] + a.positions[i + 8]) / 3;
    const inside = cx > wrenfoldRect.minX && cx < wrenfoldRect.maxX && cz > wrenfoldRect.minZ && cz < wrenfoldRect.maxZ;
    assert.ok(!inside, `terrain triangle inside the town at ${cx},${cz}`);
  }
  for (const n of a.nature) {
    const dx = Math.max(wrenfoldRect.minX - n.x, 0, n.x - wrenfoldRect.maxX);
    const dz = Math.max(wrenfoldRect.minZ - n.z, 0, n.z - wrenfoldRect.maxZ);
    assert.ok(Math.hypot(dx, dz) >= 4 * 6.4 - 1e-9);
    assert.ok(n.record >= 1 && n.record <= 31);
  }
  // Near the town the apron meets the town ground (y ≈ -0.045).
  let nearMax = 0;
  for (let i = 0; i < a.positions.length; i += 3) {
    const x = a.positions[i], z = a.positions[i + 2];
    const d = Math.hypot(Math.max(wrenfoldRect.minX - x, 0, x - wrenfoldRect.maxX), Math.max(wrenfoldRect.minZ - z, 0, z - wrenfoldRect.maxZ));
    if (d < 20) nearMax = Math.max(nearMax, Math.abs(a.positions[i + 1] + 0.045));
  }
  assert.ok(nearMax < 0.01, `apron edge is ${nearMax} m off the town ground`);
  // Every terrain triangle faces up (counter-clockwise from above).
  for (let i = 0; i < a.positions.length; i += 9) {
    const ux = a.positions[i + 3] - a.positions[i], uz = a.positions[i + 5] - a.positions[i + 2];
    const vx = a.positions[i + 6] - a.positions[i], vz = a.positions[i + 8] - a.positions[i + 2];
    assert.ok(uz * vx - ux * vz > 0);
  }
  const c = buildSurroundings({ townRect: wrenfoldRect, heightmap: null, mapPixel: { x: 10, y: 10 }, pixelOffset: { x: 0, z: 0 }, seed: 78, extent: 200, maxNature: 500, natureRange: 150 });
  assert.notDeepEqual(a.nature, c.nature);
  assert.notEqual(hash2(1, 2, 3), hash2(2, 1, 3));
});

test('a WOODS.WLD heightmap raises hills away from the town and floods below sea level', async () => {
  const map = new Uint8Array(1000 * 500).fill(40);
  for (let x = 0; x < 1000; x++) map[11 * 1000 + x] = 90; // a ridge one map pixel south
  for (let x = 0; x < 1000; x++) map[9 * 1000 + x] = 0; // the sea one pixel north
  const s = buildSurroundings({ townRect: wrenfoldRect, heightmap: map, mapPixel: { x: 10, y: 10 }, pixelOffset: { x: 11.2, z: -11.2 }, seed: 5, extent: 900, maxNature: 100, natureRange: 200 });
  let maxY = -Infinity, minY = Infinity;
  for (let i = 1; i < s.positions.length; i += 3) { maxY = Math.max(maxY, s.positions[i]); minY = Math.min(minY, s.positions[i]); }
  assert.ok(maxY > 150, `ridge only reaches ${maxY}`);
  assert.ok(s.stats.water > 0);
  assert.ok(minY < s.oceanY + 1e-3);
  let flooded = 0;
  for (let i = 0; i < s.records.length; i += 6) if (s.records[i] === 0) { flooded++; for (let k = 0; k < 6; k++) assert.ok(Math.abs(s.positions[(i + k) * 3 + 1] - s.oceanY) < 1e-3); }
  assert.equal(flooded, s.stats.water);
  // Header reader: offsets per WoodsFile.ReadHeader.
  const file = new Uint8Array(144 + 500000);
  const v = new DataView(file.buffer);
  v.setUint32(4, 1000, true); v.setUint32(8, 500, true); v.setUint32(28, 144, true);
  file[144 + 3] = 9;
  const hm = await readWoodsHeightmap(async (o, n) => file.subarray(o, o + n), file.length);
  assert.equal(hm[3], 9);
  v.setUint32(8, 499, true);
  await assert.rejects(readWoodsHeightmap(async (o, n) => file.subarray(o, o + n), file.length), /invalid map size/);
});

test('terrain interleave carries each cell\'s ground tile rectangle', () => {
  const t = {
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 0, 1), normals: Float32Array.of(0, 1, 0, 0, 1, 0, 0, 1, 0),
    tiles: Float32Array.of(0, 0, 1, 0, 1, 1), records: Uint8Array.of(2, 2, 2),
    rects: [null, null, { u0: 0.5, v0: 0.1, du: 0.25, dv: 0.8 }, null],
  };
  const out = interleaveTerrain(t);
  assert.equal(out.length, 36);
  assert.deepEqual([...out.subarray(12, 24)].map((x) => +x.toFixed(3)), [1, 0, 0, 0, 1, 0, 1, 0, 0.5, 0.1, 0.25, 0.8]);
});

// ---------------------------------------------------------------- browser feature lifetime

function fakeApi() {
  const listeners = new Map();
  return {
    files: [], renderer: null, town: null, location: null, state: null, frame: null,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, d) { for (const fn of [...(listeners.get(name) ?? [])]) fn(d); },
    count(name) { return listeners.get(name)?.size ?? 0; },
  };
}
function fakeRenderer() {
  return {
    passes: [], far: 400, contextVersion: 1,
    addPass(fn) { this.passes.push(fn); return () => { this.passes = this.passes.filter((p) => p !== fn); }; },
  };
}
const fakeData = (name) => ({
  town: { name }, warnings: [], stats: { drawnFlats: 1 },
  billboards: { vertices: new Float32Array(0), count: 0, flats: 0 },
  atlas: { width: 1, height: 1, pixels: new Uint8Array(4) },
  terrain: { positions: new Float32Array(0), normals: new Float32Array(0), tiles: new Float32Array(0), records: new Uint8Array(0), rects: [] },
  sky: { width: 1, height: 1, pixels: new Uint8Array(4), horizon: [0.1, 0.2, 0.3], zenith: [0.4, 0.5, 0.6] },
});
const tick = () => new Promise((r) => setTimeout(r, 0));

test('install(api): builds for the scene, attaches one pass, cleans up on travel and dispose', async () => {
  const api = fakeApi();
  const renderer = fakeRenderer();
  const calls = [];
  const savedHorizon = [...PALETTE.horizon];
  const h = install(api, { load: async (files, town) => { calls.push([files.length, town.name]); return fakeData(town.name); } });
  assert.equal(h.status, 'idle');
  const wrenfold = { name: 'Wrenfold Hollow', source: {} };
  api.emit('scene', wrenfold); // no files yet
  assert.equal(h.status, 'waiting');
  api.emit('assets', [new File([], 'BLOCKS.BSA')]);
  await tick();
  assert.deepEqual(calls, [[1, 'Wrenfold Hollow']]);
  assert.equal(h.status, 'ready');
  api.emit('frame', { renderer, now: 1 });
  api.emit('frame', { renderer, now: 2 });
  assert.equal(renderer.passes.length, 1);
  assert.equal(renderer.far, 400, 'the draw pass leaves the camera clip plane alone');
  assert.deepEqual(PALETTE.horizon, [0.1, 0.2, 0.3]);
  api.emit('scene', wrenfold); // same town again: no rebuild
  await tick();
  assert.equal(calls.length, 1);

  api.emit('location', { location: 'town:Glenpoint/Wrenfold Hollow' });
  api.emit('location', { location: 'town:Glenpoint/Ashcombe Rise' }); // travel
  assert.equal(renderer.passes.length, 0);
  assert.equal(renderer.far, 400);
  assert.deepEqual(PALETTE.horizon, savedHorizon);
  assert.equal(h.data, null);

  // A slow build for an old town is dropped when a newer scene arrives.
  let release;
  const slow = new Promise((r) => { release = r; });
  const api2 = fakeApi();
  const h2 = install(api2, { load: async (f, town) => (town.name === 'Old' ? slow : fakeData(town.name)) });
  api2.emit('assets', [new File([], 'X')]);
  api2.emit('scene', { name: 'Old', source: {} });
  api2.emit('scene', { name: 'New', source: {} });
  await tick();
  release(fakeData('Old'));
  await tick();
  assert.equal(h2.data.town.name, 'New');
  h2.dispose();

  h.dispose();
  assert.equal(api.count('scene'), 0);
  assert.equal(api.count('frame'), 0);
  assert.equal(h.status, 'disposed');
  assert.deepEqual(PALETTE.horizon, savedHorizon);
});

test('install(api): a failed build reports and leaves the renderer untouched', async () => {
  const api = fakeApi();
  const renderer = fakeRenderer();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const h = install(api, { load: async () => { throw new Error('BLOCKS.BSA is missing'); } });
    api.emit('assets', [new File([], 'X')]);
    api.emit('scene', { name: 'Wrenfold Hollow', source: {} });
    await tick();
    api.emit('frame', { renderer, now: 1 });
    assert.equal(h.status, 'failed');
    assert.match(h.error.message, /BLOCKS\.BSA/);
    assert.equal(renderer.passes.length, 0);
    assert.equal(renderer.far, 400);
    h.dispose();
  } finally {
    console.warn = warn;
  }
});

test('block size constant matches the town loader', () => {
  assert.equal(BLOCK_SIZE, 102.4);
});

test('joining a town waits for its own scenery, including when its mesh arrives before its location', async () => {
  const api = fakeApi();
  api.files = [new File([], 'BLOCKS.BSA')];
  api.location = 'town:Glenpoint/Ashcombe Rise';
  api.state = { character: { location: api.location } };
  const shown = { name: 'Wrenfold Hollow', source: { townId: 'town:Glenpoint/Wrenfold Hollow' } };
  const feature = install(api, { load: async (_, town) => fakeData(town.name) });
  try {
    api.town = shown;
    api.location = shown.source.townId;
    assert.equal(arrivalStatus(api, { scene: shown }).ready, false, 'no scenery for this mesh yet');
    api.emit('scene', shown);
    api.emit('location', { location: api.location });
    assert.equal(arrivalStatus(api, { scene: shown }).ready, false, 'still building the matching pass');
    await tick();
    assert.equal(arrivalStatus(api, { scene: shown }).ready, true);
  } finally {
    feature.dispose();
  }
});
