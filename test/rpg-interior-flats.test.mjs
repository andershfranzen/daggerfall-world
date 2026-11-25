// Building interior flats (lamps, candles, decorations): record placement, the scenery feature's interior pass and
// the arrival gate. Synthetic fixtures, plus a check against the local Daggerfall install that skips when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { interiorFlats } from '../client/world/interiors/flats.js';
import { hasInteriorFlats, loadInteriorFlats } from '../client/gameplay/scenery/interiorFlats.js';
import { install } from '../client/gameplay/scenery.js';
import { arrivalStatus } from '../client/lib/arrival.js';
import { BILLBOARD_STRIDE } from '../client/world/scenery/index.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'BLOCKS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';

const ROOM = 'interior:Glenpoint/Wrenfold Hollow/0,0/3'; // invented place

test('interiorFlats: lights and decorations at DFU AddFlats points; editor markers and people are left out', () => {
  const sub = {
    interior: {
      flats: [
        { archive: 210, record: 13, xPos: 400, yPos: -80, zPos: -200 }, // hanging lamp, 2 m up
        { archive: 205, record: 4, xPos: -40, yPos: 0, zPos: 120 }, // decoration on the floor
        { archive: 199, record: 8, xPos: 0, yPos: 0, zPos: 0 }, // enter marker
        { archive: 182, record: 1, xPos: 10, yPos: 0, zPos: 10 }, // a person billboard
      ],
    },
  };
  assert.deepEqual(interiorFlats(sub), [
    { archive: 210, record: 13, kind: 'light', x: 10, y: 2, z: 5 },
    { archive: 205, record: 4, kind: 'decoration', x: -1, y: 0, z: -3 },
  ]);
  assert.deepEqual(interiorFlats({ interior: { flats: [] } }), []);
  assert.deepEqual(interiorFlats(null), []);
});

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
  return { passes: [], contextVersion: 1, addPass(fn) { this.passes.push(fn); return () => { this.passes = this.passes.filter((p) => p !== fn); }; } };
}
const roomData = (count) => ({
  warnings: [], stats: { drawnFlats: count / 6 }, terrain: null, sky: null,
  billboards: { vertices: new Float32Array(count * BILLBOARD_STRIDE), count, flats: count / 6 },
  atlas: { width: 1, height: 1, pixels: new Uint8Array(4) },
});
const tick = () => new Promise((r) => setTimeout(r, 0));

test('scenery feature: an interior scene draws its flats in one pass, without touching the town loader, and leaving clears it', async () => {
  const api = fakeApi();
  const renderer = fakeRenderer();
  const towns = [], rooms = [];
  const h = install(api, {
    load: async (_, town) => { towns.push(town.name); throw new Error('the town loader must not run for a room'); },
    loadInterior: async (files, mesh) => { rooms.push([files.length, mesh.location]); return roomData(12); },
  });
  api.emit('assets', [new File([], 'ART_PAL.COL')]);
  const room = { kind: 'interior', location: ROOM, name: 'The Gilded Lantern, Wrenfold Hollow', source: { block: 'X', record: 3 }, flats: [{}, {}] };
  assert.equal(hasInteriorFlats(room), true);
  api.emit('scene', room);
  await tick();
  assert.deepEqual(rooms, [[1, ROOM]]);
  assert.deepEqual(towns, []);
  assert.equal(h.status, 'ready');
  assert.equal(api.scenery.town, room);
  api.emit('frame', { renderer });
  api.emit('frame', { renderer });
  assert.equal(renderer.passes.length, 1);
  api.emit('scene', room); // same room again: no rebuild
  await tick();
  assert.equal(rooms.length, 1);

  // A room with no flats is ready with nothing to draw.
  const api2 = fakeApi();
  const h2 = install(api2, { loadInterior: async () => roomData(0) });
  api2.emit('assets', [new File([], 'X')]);
  api2.emit('scene', { ...room, flats: [] });
  await tick();
  assert.equal(h2.status, 'ready');
  assert.equal(h2.pass, null);
  h2.dispose();

  // Dungeons and rooms without a flats list are not this feature's.
  api.emit('scene', { kind: 'dungeon', location: 'dungeon:Glenpoint/Wrenfold Hollow', source: { blocks: [] } });
  assert.equal(h.status, 'idle');
  assert.equal(renderer.passes.length, 0);
  h.dispose();
});

test('arrival gate: a room waits for its lamps', async () => {
  const api = fakeApi();
  api.files = [new File([], 'ART_PAL.COL')];
  api.location = ROOM;
  api.state = { character: { location: ROOM } };
  const room = { kind: 'interior', location: ROOM, name: 'The Gilded Lantern', source: { block: 'X', record: 3 }, flats: [{}] };
  let release;
  const feature = install(api, { loadInterior: () => new Promise((r) => { release = r; }) });
  try {
    api.town = room;
    api.emit('scene', room);
    const waiting = arrivalStatus(api, { scene: room });
    assert.equal(waiting.ready, false);
    assert.ok(waiting.waiting.includes('Lighting the lamps…'));
    release(roomData(6));
    await tick();
    assert.equal(arrivalStatus(api, { scene: room }).ready, true);
  } finally {
    feature.dispose();
  }

  // An interior scene without a flats list (older server data) is not gated on scenery.
  const plain = { kind: 'interior', location: ROOM, source: {} };
  assert.equal(arrivalStatus({ location: ROOM, state: { character: { location: ROOM } }, scenery: { status: 'loading', town: null } }, { scene: plain }).ready, true);
});

// A minimal TEXTURE.nnn with single-frame, uncompressed records (FlatArchive's format).
function textureArchive(records) {
  const headers = 26 + records.length * 20;
  let at = headers + records.length * 28;
  const offsets = records.map((r) => { const o = at; at += r.h * 256; return o; });
  const b = new Uint8Array(at);
  const v = new DataView(b.buffer);
  v.setInt16(0, records.length, true);
  records.forEach((r, i) => {
    const pos = headers + i * 28;
    v.setInt32(26 + i * 20 + 2, pos, true);
    v.setInt16(pos + 4, r.w, true);
    v.setInt16(pos + 6, r.h, true);
    v.setUint32(pos + 14, offsets[i] - pos, true);
    v.setUint16(pos + 20, 1, true);
    for (let y = 0; y < r.h; y++) b.fill(5, offsets[i] + y * 256, offsets[i] + y * 256 + r.w);
  });
  return b;
}

test('a room whose classic lamp art cannot be read fails arrival, and Try again (assets re-sent) rebuilds it', async () => {
  const lamps = textureArchive([{ w: 8, h: 16 }, { w: 4, h: 4 }]);
  let reads = 0;
  // The first read of the archive fails (a transient disk or browser error); later reads succeed.
  class FlakyFile extends File {
    arrayBuffer() { return ++reads === 1 ? Promise.reject(new Error('TEXTURE.210: read failed')) : super.arrayBuffer(); }
  }
  const once = new FlakyFile([lamps], 'TEXTURE.210');
  const files = [new File([new Uint8Array(768)], 'ART_PAL.COL'), once];
  const room = {
    kind: 'interior', location: ROOM, name: 'The Gilded Lantern', source: { block: 'X', record: 3 },
    flats: [{ archive: 210, record: 0, kind: 'light', x: 1, y: 2, z: 3 }, { archive: 210, record: 1, kind: 'light', x: -1, y: 0.8, z: 0 }],
  };
  const api = fakeApi();
  api.files = files;
  api.location = ROOM;
  api.state = { character: { location: ROOM } };
  const warn = console.warn;
  console.warn = () => {};
  const feature = install(api);
  try {
    api.town = room;
    api.emit('scene', room);
    for (let i = 0; i < 20 && feature.status === 'loading'; i++) await tick();
    const failed = arrivalStatus(api, { scene: room });
    assert.equal(failed.ready, false);
    assert.deepEqual(failed.failed, { part: 'scenery', message: 'TEXTURE.210: read failed' });

    api.emit('assets', files); // the shell's Try again
    for (let i = 0; i < 20 && feature.status !== 'ready'; i++) await tick();
    assert.equal(feature.status, 'ready');
    assert.equal(feature.data.stats.drawnFlats, 2);
    assert.equal(feature.data.billboards.count, 12);
    assert.equal(arrivalStatus(api, { scene: room }).ready, true);
    assert.equal(reads, 2);
  } finally {
    feature.dispose();
    console.warn = warn;
  }
});

test('a room whose flat archive is absent fails rather than drawing without it', async () => {
  const room = { kind: 'interior', location: ROOM, flats: [{ archive: 210, record: 0, kind: 'light', x: 0, y: 0, z: 0 }] };
  await assert.rejects(loadInteriorFlats([new File([new Uint8Array(768)], 'ART_PAL.COL')], room), /TEXTURE\.210/);
  const empty = await loadInteriorFlats([], { ...room, flats: [] });
  assert.equal(empty.billboards.count, 0);
});

test("The Devil's Dagger (Blackidge Hamlet 0,0/11): its 20 classic lamps are placed and drawn", { skip }, async () => {
  const NEEDED = /^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3})$/i;
  const files = [];
  for (const n of readdirSync(ARENA2)) if (NEEDED.test(n)) files.push(new File([await openAsBlob(join(ARENA2, n))], n));
  const { openWorldData, loadInterior } = await import('../client/world/interiors/index.js');
  const data = await openWorldData(files);
  const mesh = await loadInterior(data, 'interior:Daggerfall/Blackidge Hamlet/0,0/11');
  // Data facts of TVRNAS07.RMB record 11: 17 hanging lamps (210.13) and 3 candles (210.27); no other flats.
  const counts = {};
  for (const f of mesh.flats) counts[`${f.archive}.${f.record}`] = (counts[`${f.archive}.${f.record}`] ?? 0) + 1;
  assert.deepEqual(counts, { '210.27': 3, '210.13': 17 });
  assert.ok(mesh.flats.every((f) => f.kind === 'light'));
  assert.ok(mesh.flats.some((f) => f.x === 9.4 && f.y === 2 && f.z === -1.6), 'a ground-floor lamp at its record point');
  const s = await loadInteriorFlats(files, mesh);
  assert.equal(s.stats.drawnFlats, 20);
  assert.equal(s.billboards.count, 20 * 6);
  // Each billboard stands on its record point and rises above it.
  const v = s.billboards.vertices;
  for (let i = 0; i < s.billboards.count; i += 6) {
    const o = i * BILLBOARD_STRIDE;
    const y0 = v[o + 1], h = Math.max(v[o + 4], v[o + 4 + 2 * BILLBOARD_STRIDE]);
    assert.ok(y0 >= 0 && y0 < 6.5 && h > 0.2 && h < 2, `lamp ${i / 6} at ${y0} m, ${h} m tall`);
  }
});
