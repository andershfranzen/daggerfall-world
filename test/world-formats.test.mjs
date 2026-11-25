// Synthetic regression tests for client/world format readers. No game data needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BsaArchive, NAME_RECORD, NUMBER_RECORD } from '../client/world/bsa.js';
import { resolveRmbBlockName, climateAt, climateSettings } from '../client/world/maps.js';
import { parseRmb, resolveBlockIndex, RMB_LAYOUT } from '../client/world/blocks.js';
import { decodeMesh } from '../client/world/arch3d.js';
import { TextureArchive, parsePalette } from '../client/world/textures.js';
import { indexFiles, requireFiles } from '../client/world/files.js';
import { loadTown, applyClimate, groundTileCorners, groundTileRecord, emitTexturedPolygon, WorldDataError } from '../client/world/town.js';

const le = (n, bytes) => {
  const b = new Uint8Array(bytes);
  const v = new DataView(b.buffer);
  if (bytes === 1) b[0] = n & 0xff;
  else if (bytes === 2) v.setInt16(0, n, true);
  else v.setInt32(0, n, true);
  return [...b];
};

function bsa(type, records) {
  const body = records.flatMap((r) => [...r.data]);
  const dir = records.flatMap((r) =>
    type === NAME_RECORD
      ? [...[...r.name].map((c) => c.charCodeAt(0)), ...new Array(14 - r.name.length).fill(0), ...le(r.data.length, 4)]
      : [...le(r.id, 4), ...le(r.data.length, 4)],
  );
  return new Uint8Array([...le(records.length, 2), type & 0xff, type >> 8, ...body, ...dir]);
}
const file = (bytes, name, path) => {
  const f = new File([bytes], name);
  if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};

test('BSA name and number directories, case-insensitive lookup', async () => {
  const n = await BsaArchive.open(file(bsa(NAME_RECORD, [{ name: 'A.RMB', data: [1, 2] }, { name: 'b.rmb', data: [3] }]), 'X'), 'X');
  assert.equal(n.count, 2);
  assert.equal(n.indexOfName('B.RMB'), 1);
  assert.deepEqual([...(await n.read(n.indexOfName('a.rmb')))], [1, 2]);
  const m = await BsaArchive.open(file(bsa(NUMBER_RECORD, [{ id: 129, data: [9, 9, 9] }, { id: 41220, data: [] }]), 'Y'), 'Y', NUMBER_RECORD);
  assert.equal(m.indexOfId(41220), 1);
  assert.deepEqual([...(await m.read(0))], [9, 9, 9]);
});

test('BSA rejects bad headers and overruns', async () => {
  await assert.rejects(BsaArchive.open(file(new Uint8Array([1, 0, 0x33, 0x33, 0, 0, 0, 0]), 'Z'), 'Z'), WorldDataError);
  await assert.rejects(BsaArchive.open(file(new Uint8Array(2), 'Z'), 'Z'), /too small/);
  const good = bsa(NAME_RECORD, [{ name: 'A', data: [1, 2, 3, 4] }]);
  const v = new DataView(good.buffer);
  v.setInt32(good.length - 4, 9999, true); // record size larger than the file
  await assert.rejects(BsaArchive.open(file(good, 'Z'), 'Z'), /overrun/);
  await assert.rejects(BsaArchive.open(file(bsa(NAME_RECORD, [{ name: 'A', data: [1] }]), 'Z'), 'Z', NUMBER_RECORD), /unexpected/);
});

test('file index prefers ARENA2 copies and reports every missing file', () => {
  const a = file(new Uint8Array(1), 'maps.bsa', 'DAGGER/ARENA2/maps.bsa');
  const b = file(new Uint8Array(2), 'MAPS.BSA', 'DAGGER/CD/MAPS.BSA');
  const idx = indexFiles([b, a]);
  assert.equal(idx.get('MAPS.BSA'), a);
  assert.throws(() => requireFiles(idx, ['MAPS.BSA', 'BLOCKS.BSA', 'ARCH3D.BSA']), /BLOCKS\.BSA, ARCH3D\.BSA/);
  assert.throws(() => indexFiles(42), WorldDataError);
  assert.throws(() => indexFiles([{ name: 'x' }]), WorldDataError);
});

test('loadTown with no game data throws instead of generating a town', async () => {
  await assert.rejects(loadTown([]), (e) => e instanceof WorldDataError && /MAPS\.BSA/.test(e.message));
  await assert.rejects(loadTown(null), WorldDataError);
});

test('RMB block names resolve like MapsFile.ResolveRmbBlockName', () => {
  assert.equal(resolveRmbBlockName(13, 0, 0x07, 0), 'TEMPAAH0.RMB'); // temple: letter + number
  assert.equal(resolveRmbBlockName(39, 2, 0x00, 0), 'FIGHAA02.RMB');
  assert.equal(resolveRmbBlockName(6, 2, 0x40, 0), 'BANKAM02.RMB');
  assert.equal(resolveRmbBlockName(2, 6, 0x20, 0), 'RESIAL06.RMB');
  assert.equal(resolveRmbBlockName(2, 5, 0x50, 'B'.charCodeAt(0)), 'RESIBM05.RMB');
  assert.throws(() => resolveRmbBlockName(99, 0, 0, 0), WorldDataError);
});

test('CLIMATE.PAK run-length rows and climate settings', () => {
  // 500 row offsets, every row: 1001 cells of 231 except row 499-(lat/128) which has a 230 run at x=10.
  const rows = [];
  const offs = [];
  let at = 500 * 4;
  for (let y = 0; y < 500; y++) {
    const row = y === 499 - 3 ? [...le(10, 2), 231, ...le(1, 2), 230, ...le(990, 2), 231] : [...le(1001, 2), 231];
    offs.push(...le(at, 4));
    rows.push(...row);
    at += row.length;
  }
  const pak = new Uint8Array([...offs, ...rows]);
  assert.equal(climateAt(pak, 10 * 128, 3 * 128), 230);
  assert.equal(climateAt(pak, 11 * 128, 3 * 128), 231);
  assert.deepEqual(climateSettings(231), { climateBase: 300, groundArchive: 302, label: 'Woodlands' });
  assert.equal(climateSettings(226).groundArchive, 102);
});

test('climate swaps follow ClimateSwaps.ApplyClimate (summer)', () => {
  assert.equal(applyClimate(12, 0, 300), 312); // CityA -> temperate
  assert.equal(applyClimate(112, 3, 300), 312);
  assert.equal(applyClimate(74, 0, 300), 374); // doors swap ...
  assert.equal(applyClimate(74, 3, 300), 74); // ... except door 3
  assert.equal(applyClimate(67, 2, 300), 67); // wood planks: no climate set
  assert.equal(applyClimate(79, 0, 300), 79); // suppressed CitySpec
  assert.equal(applyClimate(41, 0, 400), 41); // swamp has no marble floors
  assert.equal(applyClimate(504, 0, 300), 504);
});

test('winter swaps the bridge tile, ground and snowy nature archives where the climate supports them', () => {
  assert.equal(applyClimate(135, 2, 300, true), 336);
  assert.equal(applyClimate(135, 2, 400, true), 435);
  assert.equal(applyClimate(135, 2, 0, true), 35);
  assert.equal(applyClimate(102, 0, 100, true), 103);
  assert.equal(applyClimate(506, 0, 300, true), 507);
  assert.equal(applyClimate(67, 4, 300, true), 67);
});

function synthRmb({ groundBits = 0x2e, subModel = { id1: 1, id2: 29, x: 10, y: -20, z: 30, rot: 512 } } = {}) {
  const L = RMB_LAYOUT;
  const subSize = 17 + L.MODEL_RECORD_SIZE;
  const total = L.BLOCK_DATA_AT + subSize * 2 + L.MODEL_RECORD_SIZE;
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  b[0] = 1; // one sub-record
  b[1] = 1; // one misc 3D object
  b[2] = 0;
  v.setInt32(L.BLOCK_POSITIONS_AT + 8, 704, true);
  v.setInt32(L.BLOCK_POSITIONS_AT + 12, 2880, true);
  v.setInt32(L.BLOCK_POSITIONS_AT + 16, -256, true);
  v.setInt32(L.BLOCK_SIZES_AT, subSize * 2, true); // exterior + interior
  b.fill(groundBits, L.GROUND_AT + 8, L.GROUND_AT + 8 + 256);
  const model = (at, m) => {
    v.setInt16(at, m.id1, true);
    b[at + 2] = m.id2;
    v.setInt32(at + 36, m.x, true);
    v.setInt32(at + 40, m.y, true);
    v.setInt32(at + 44, m.z, true);
    v.setInt16(at + 52, m.rot, true);
  };
  b[L.BLOCK_DATA_AT] = 1; // exterior: one 3D object
  model(L.BLOCK_DATA_AT + 17, subModel);
  model(L.BLOCK_DATA_AT + subSize * 2, { id1: 412, id2: 20, x: 2138, y: -27, z: -2415, rot: 0 });
  return b;
}

test('RMB parser reads sub-record placement, exterior models, misc models and ground', () => {
  const r = parseRmb(synthRmb(), 'TEST.RMB');
  assert.equal(r.groundTiles.length, 256);
  assert.equal(r.groundTiles[0], 0x2e);
  assert.deepEqual(r.subRecords.map(({ xPos, zPos, yRotation }) => ({ xPos, zPos, yRotation })), [{ xPos: 704, zPos: 2880, yRotation: -256 }]);
  assert.deepEqual(r.subRecords[0].models[0], { modelId: 129, objectType: 0, xPos: 10, yPos: -20, zPos: 30, yRotation: 512 });
  assert.equal(r.misc3d[0].modelId, 41220);
  assert.equal(r.misc3d[0].zPos, -2415);
  assert.throws(() => parseRmb(synthRmb().slice(0, 100), 'SHORT.RMB'), /too short/);
  assert.throws(() => parseRmb(synthRmb().slice(0, RMB_LAYOUT.BLOCK_DATA_AT + 30), 'CUT.RMB'), WorldDataError);
});

test('block name fallback mirrors BlocksFile.CheckName', async () => {
  const blocks = await BsaArchive.open(
    file(bsa(NAME_RECORD, [{ name: 'RESIAM05.RMB', data: [0] }, { name: 'RESIBM05.RMB', data: [0] }]), 'B'),
    'B',
  );
  assert.equal(resolveBlockIndex(blocks, 'RESIBM05.RMB'), 1);
  assert.equal(resolveBlockIndex(blocks, 'RESIXM05.RMB'), 1); // last prefix+suffix match
  assert.equal(resolveBlockIndex(blocks, 'GENRAM00.RMB'), -1);
});

function synthMesh(planes, version = 'v2.7') {
  // header 64 bytes; points list; normals; planes; plane data
  const pts = [];
  const key = (p) => p.join(',');
  const index = new Map();
  for (const pl of planes) for (const p of pl.points) if (!index.has(key(p.xyz))) { index.set(key(p.xyz), pts.length); pts.push(p.xyz); }
  const pointList = 64;
  const normalList = pointList + pts.length * 12;
  const planeList = normalList + planes.length * 12;
  const planeBytes = planes.reduce((a, pl) => a + 8 + pl.points.length * 8, 0);
  const planeData = planeList + planeBytes;
  const b = new Uint8Array(planeData + planes.length * 24);
  const v = new DataView(b.buffer);
  [...version].forEach((c, i) => (b[i] = c.charCodeAt(0)));
  v.setInt32(4, pts.length, true);
  v.setInt32(8, planes.length, true);
  v.setInt32(24, planeData, true);
  v.setInt32(48, pointList, true);
  v.setInt32(52, normalList, true);
  v.setInt32(60, planeList, true);
  pts.forEach((p, i) => p.forEach((c, k) => v.setInt32(pointList + i * 12 + k * 4, c, true)));
  let at = planeList;
  planes.forEach((pl, i) => {
    pl.normal.forEach((c, k) => v.setInt32(normalList + i * 12 + k * 4, c, true));
    b[at] = pl.points.length;
    v.setUint16(at + 2, (pl.archive << 7) | pl.record, true);
    at += 8;
    for (const p of pl.points) {
      const off = index.get(key(p.xyz)) * 12;
      v.setInt32(at, version === 'v2.5' ? off / 3 : off, true);
      v.setInt16(at + 4, p.u, true);
      v.setInt16(at + 6, p.v, true);
      at += 8;
    }
  });
  return b;
}

test('ARCH3D triangle planes accumulate UV deltas; quads get FaceUVTool UVs and corners', () => {
  const S = 256 * 4; // 4 native units
  const tri = { archive: 112, record: 3, normal: [0, 0, -256], points: [
    { xyz: [0, 0, 0], u: 0, v: 0 },
    { xyz: [S, 0, 0], u: 64 * 16, v: 0 },
    { xyz: [S, -S, 0], u: 0, v: -64 * 16 },
  ] };
  // Quad with a redundant collinear midpoint on the bottom edge (corner detection must drop it).
  const quad = { archive: 69, record: 3, normal: [0, -256, 0], points: [
    { xyz: [0, 0, 0], u: 0, v: 0 },
    { xyz: [S, 0, 0], u: 32 * 16, v: 0 },
    { xyz: [S, 0, S], u: 0, v: 32 * 16 },
    { xyz: [S / 2, 0, S], u: 0, v: 0 },
    { xyz: [0, 0, S], u: 0, v: 0 },
  ] };
  for (const version of ['v2.7', 'v2.5']) {
    const m = decodeMesh(synthMesh([tri, quad], version), 2000);
    assert.equal(m.planes.length, 2);
    const [t, q] = m.planes;
    assert.deepEqual([t.archive, t.record], [112, 3]);
    assert.deepEqual(t.points.map((p) => [p.u, p.v]), [[0, 0], [64, 0], [64, -64]]);
    assert.deepEqual(t.points[1], { x: 4, y: 0, z: 0, u: 64, v: 0 });
    assert.deepEqual(t.normal, { x: 0, y: 0, z: -1 });
    assert.equal(q.points.length, 4, 'collinear point removed');
    assert.deepEqual(q.points.map((p) => [p.x, p.z]), [[4, 0], [4, 4], [0, 4], [0, 0]]);
    // UV plane: u grows 32 texels along x, v grows 32 along z.
    for (const p of q.points) {
      assert.ok(Math.abs(p.u - p.x * 8) <= 1 / 16 + 1e-9, `u ${p.u} at x ${p.x}`);
      assert.ok(Math.abs(p.v - p.z * 8) <= 1 / 16 + 1e-9, `v ${p.v} at z ${p.z}`);
    }
  }
  assert.throws(() => decodeMesh(new Uint8Array(64).fill(1), 5), /version/);
  const bad = synthMesh([tri]);
  new DataView(bad.buffer).setInt32(64 + 3 * 12 + 12 + 8, 1e6, true); // first point offset out of range
  assert.throws(() => decodeMesh(bad, 5), /out of range/);
});

function synthTexture(records) {
  const head = 26 + records.length * 20;
  const parts = [];
  let at = head;
  const headers = new Uint8Array(head);
  const hv = new DataView(headers.buffer);
  hv.setInt16(0, records.length, true);
  records.forEach((r, i) => {
    hv.setInt32(26 + i * 20 + 2, at, true);
    parts.push(r);
    at += r.length;
  });
  const out = new Uint8Array(at);
  out.set(headers);
  let p = head;
  for (const r of parts) { out.set(r, p); p += r.length; }
  return out;
}
function texRecord(w, h, { compression = 0, frameCount = 1, data }) {
  const b = new Uint8Array(28 + data.length);
  const v = new DataView(b.buffer);
  v.setInt16(4, w, true);
  v.setInt16(6, h, true);
  v.setInt16(8, compression, true);
  v.setUint32(14, 28, true);
  v.setUint16(20, frameCount, true);
  b.set(data, 28);
  return b;
}

test('TEXTURE records: uncompressed stride-256, RLE rows, solid archives', () => {
  const W = 4, H = 2;
  const raw = new Uint8Array(256 + W);
  raw.set([1, 2, 3, 4], 0);
  raw.set([5, 6, 7, 8], 256);
  // RLE: row headers (offset from record start, encoding) then rows.
  const rows = 28 + H * 4;
  const row0 = [...le(4, 2), ...le(-3, 2), 9, ...le(1, 2), 10]; // run 9,9,9 then literal 10
  const row1 = [11, 12, 13, 14]; // plain row
  const rleData = [...le(rows, 2), 0x00, 0x80, ...le(rows + row0.length, 2), 0, 0, ...row0, ...row1];
  const arch = new TextureArchive(synthTexture([texRecord(W, H, { data: raw }), texRecord(W, H, { compression: 0x1108, data: rleData })]), 302);
  assert.deepEqual([...arch.decode(0).data], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...arch.decode(1).data], [9, 9, 9, 10, 11, 12, 13, 14]);
  assert.throws(() => arch.decode(2), /does not exist/);
  const solid = new TextureArchive(synthTexture([new Uint8Array(28), new Uint8Array(28)]), 1);
  assert.ok(solid.decode(1).data.every((i) => i === 129));
  assert.throws(() => new TextureArchive(new Uint8Array(10), 5), WorldDataError);
  assert.equal(parsePalette(new Uint8Array(776).fill(3)).length, 768);
  assert.throws(() => parsePalette(new Uint8Array(100)), /768 or 776/);
});

test('ground tile variants: rotate = 90° CCW, flip = 180°', () => {
  // Image space (s right, t down) for world corners SW, SE, NE, NW.
  assert.deepEqual(groundTileCorners(0x00), [[0, 1], [1, 1], [1, 0], [0, 0]]);
  assert.deepEqual(groundTileCorners(0x80), [[1, 0], [0, 0], [0, 1], [1, 1]]);
  assert.deepEqual(groundTileCorners(0x40), [[0, 0], [0, 1], [1, 1], [1, 0]]);
  assert.deepEqual(groundTileCorners(0xc0), [[1, 1], [1, 0], [0, 0], [0, 1]]);
  assert.equal(groundTileRecord(0x2e | 0xc0), 46);
  assert.equal(groundTileRecord(60), 2); // >= 56 drawn as grass
});

test('textured polygons are split at texture repeats so uv stays inside the atlas rect', () => {
  const rect = { u0: 0.25, v0: 0.5, du: 0.125, dv: 0.25 };
  const tris = [];
  const sink = { tri: (a, b, c, ua, ub, uc) => tris.push({ p: [a, b, c], uv: [ua, ub, uc] }) };
  // 5 m x 2 m quad, texture repeats 2.5 times along s and once along t.
  const poly = [
    { p: [0, 0, 0], s: 0, t: 0 },
    { p: [5, 0, 0], s: 2.5, t: 0 },
    { p: [5, 2, 0], s: 2.5, t: 1 },
    { p: [0, 2, 0], s: 0, t: 1 },
  ];
  emitTexturedPolygon(sink, poly, rect);
  assert.equal(tris.length, 6); // three cells, two triangles each
  let area = 0;
  for (const { p, uv } of tris) {
    for (const [u, v] of uv) {
      assert.ok(u >= rect.u0 - 1e-12 && u <= rect.u0 + rect.du + 1e-12);
      assert.ok(v >= rect.v0 - 1e-12 && v <= rect.v0 + rect.dv + 1e-12);
    }
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1]];
    const z = e1[0] * e2[1] - e1[1] * e2[0];
    assert.ok(z > 0, 'polygon order preserved (counter-clockwise in xy here)');
    area += z / 2;
  }
  assert.ok(Math.abs(area - 10) < 1e-9, `area preserved: ${area}`);
  // The half repeat maps onto the left half of the rect.
  const last = tris.filter((t) => t.p.some((q) => q[0] === 5));
  assert.ok(last.every((t) => t.uv.every(([u]) => u <= rect.u0 + rect.du / 2 + 1e-12)));
  assert.throws(() => emitTexturedPolygon(sink, poly.map((q) => ({ ...q, s: q.s * 10000 })), rect), /repeats/);
});
