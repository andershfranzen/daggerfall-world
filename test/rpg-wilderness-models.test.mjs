// World of Daggerfall model pieces: scale-aware UV unfold, triangle output, collision, and the
// release audit. Real-data cases run only when the operator's ARENA2 and the ignored
// gamedata/world-of-daggerfall clone are present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  WOD_ROCK_MODELS,
  needsUnfold,
  pieceStretch,
  linearDeterminant,
  unfoldPlaneUvs,
  pieceTriangles,
  modelPlanesToMetres,
  composeModelMatrix,
  wildernessCollisionTriangles,
  parseLayoutObjects,
  auditWodModels,
  loadArch3dMeshes,
  parseUnityPrefab,
  parseUnityMaterial,
  unityMeshFromFbx,
  triangulatePolygon,
  selectRuntimeMaterials,
  customPieceTriangles,
  prefabMatrix,
  createWodModelStore,
  resolveCustomMaterials,
  serializeCustomPrefab,
  deserializeCustomPrefab,
  CLIMATE,
} from '../server/rpg/wilderness/models.js';
import { parseFbx, fbxGeometries } from '../client/world/wilderness/fbx.js';
import { deflateSync } from 'node:zlib';
import { CollisionWorld } from '../client/gameplay/collision/world.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PACK = process.env.WOD_PACK ?? join(ROOT, 'gamedata/world-of-daggerfall');
const ARENA2 = process.env.DF_DATA ?? join(ROOT, 'gamedata/DaggerfallGameFiles');
const hasPack = existsSync(join(PACK, 'WorldOfDaggerfall.dfmod.json'));
const hasArena2 = existsSync(join(ARENA2, 'arena2')) || existsSync(join(ARENA2, 'ARCH3D.BSA'));

const scaleM = (sx, sy, sz, t = [0, 0, 0]) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, t[0], t[1], t[2], 1];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// A 1 m x 1 m wall plane in x/y with a 64-texel texture spanning it once: 64 texels per metre.
const wall = {
  archive: 141,
  record: 2,
  points: [
    { x: 0, y: 0, z: 0, u: 0, v: 64 },
    { x: 1, y: 0, z: 0, u: 64, v: 64 },
    { x: 1, y: 1, z: 0, u: 64, v: 0 },
    { x: 0, y: 1, z: 0, u: 0, v: 0 },
  ],
};
// A simple closed pebble: a unit cube (6 quads), model id of a real WoD rock pebble.
function cube(id = 60711) {
  const q = (pts) => ({ archive: 141, record: 2, points: pts.map(([x, y, z, u, v]) => ({ x, y, z, u, v })) });
  return {
    id,
    planes: [
      q([[0, 0, 0, 0, 0], [1, 0, 0, 64, 0], [1, 0, 1, 64, 64], [0, 0, 1, 0, 64]]), // bottom
      q([[0, 1, 0, 0, 0], [0, 1, 1, 0, 64], [1, 1, 1, 64, 64], [1, 1, 0, 64, 0]]), // top
      q([[0, 0, 0, 0, 64], [0, 1, 0, 0, 0], [1, 1, 0, 64, 0], [1, 0, 0, 64, 64]]),
      q([[0, 0, 1, 0, 64], [1, 0, 1, 64, 64], [1, 1, 1, 64, 0], [0, 1, 1, 0, 0]]),
      q([[0, 0, 0, 0, 64], [0, 0, 1, 64, 64], [0, 1, 1, 64, 0], [0, 1, 0, 0, 0]]),
      q([[1, 0, 0, 0, 64], [1, 1, 0, 0, 0], [1, 1, 1, 64, 0], [1, 0, 1, 64, 64]]),
    ],
  };
}

test('stretch and unfold thresholds follow the pebble set', () => {
  assert.equal(pieceStretch(scaleM(2, 30, 1)), 30);
  assert.ok(WOD_ROCK_MODELS.has(60717));
  assert.equal(needsUnfold(60717, scaleM(1, 1, 1)), false);
  assert.equal(needsUnfold(60717, scaleM(1.1, 1, 1)), true); // any real stretch of a pebble
  assert.equal(needsUnfold(43001, scaleM(3.9, 1, 1)), false); // a palisade below 4 keeps its UVs
  assert.equal(needsUnfold(43001, scaleM(4, 1, 1)), true);
  assert.ok(linearDeterminant(composeModelMatrix({ scale: [1, 1, 1] })) < 0, 'LH model -> RH scene mirrors');
});

test('unfold keeps the pebble texel density on a stretched face (non-rock, no cap)', () => {
  const m = scaleM(10, 3, 1);
  const uv = unfoldPlaneUvs(wall, m, { texW: 64, texH: 64 });
  // Scaled wall is 10 m x 3 m: 640 x 192 texels at the original 64 texels/m.
  close(Math.abs(uv[1].u - uv[0].u), 640);
  close(Math.abs(uv[3].v - uv[0].v), 192);
  close(uv[1].v - uv[0].v, 0); // rows stay along the stretched edge
  for (const q of uv) assert.ok(q.u >= 0 && q.v >= 0 && q.u < 64 * 11 && q.v < 64 * 4);
});

test('rock faces are capped at one repeat per 8 m and shifted by whole repeats', () => {
  const m = scaleM(400, 200, 1, [5000, 0, 0]);
  const uv = unfoldPlaneUvs(wall, m, { texW: 64, texH: 64, rock: true });
  close(Math.abs(uv[1].u - uv[0].u), (400 / 8) * 64, 1e-6); // 50 repeats over 400 m
  close(Math.abs(uv[3].v - uv[0].v), (200 / 8) * 64, 1e-6);
  const mu = Math.min(...uv.map((q) => q.u)), mv = Math.min(...uv.map((q) => q.v));
  assert.ok(mu >= 0 && mu < 64 && mv >= 0 && mv < 64);
});

test('unfolded map is isometric under rotation and shear-free scaling', () => {
  const a = Math.PI / 5;
  const c = Math.cos(a), s = Math.sin(a);
  // Rotate about y, stretch 7x along model x: lengths in the face must stay metric.
  const m = [7 * c, 0, -7 * s, 0, 0, 2, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  const uv = unfoldPlaneUvs(wall, m, { texW: 64, texH: 64 });
  close(Math.hypot(uv[1].u - uv[0].u, uv[1].v - uv[0].v), 7 * 64, 1e-6);
  close(Math.hypot(uv[3].u - uv[0].u, uv[3].v - uv[0].v), 2 * 64, 1e-6);
  // Opposite corners agree with the parallelogram: one affine map per plane, no seam.
  close(uv[2].u, uv[1].u + uv[3].u - uv[0].u, 1e-6);
  close(uv[2].v, uv[1].v + uv[3].v - uv[0].v, 1e-6);
});

test('degenerate texture spans keep their own UVs', () => {
  const flat = { ...wall, points: wall.points.map((p) => ({ ...p, u: 5, v: 5 })) };
  assert.deepEqual(unfoldPlaneUvs(flat, scaleM(50, 50, 50)), flat.points.map(() => ({ u: 5, v: 5 })));
});

test('pieceTriangles: unscaled pieces keep model UVs; mirrored matrices keep outward faces', () => {
  const plain = pieceTriangles(cube(), scaleM(1, 1, 1));
  assert.equal(plain.unfolded, false);
  assert.equal(plain.groups.length, 1);
  assert.equal(plain.groups[0].positions.length, 6 * 2 * 9);
  assert.deepEqual([...plain.groups[0].uvs.slice(0, 6)], [0, 0, 64, 0, 64, 64]);
  const before = plain.groups[0].normals.slice(0, 3);
  const flipped = pieceTriangles(cube(), composeModelMatrix({ scale: [1, 1, 1] }));
  assert.equal(flipped.mirrored, true);
  // Bottom face normal points the same way (y) after the z mirror because winding is swapped.
  close(flipped.groups[0].normals[1], before[1]);
  const big = pieceTriangles(cube(), scaleM(40, 120, 40), { textureSize: () => ({ w: 64, h: 64 }) });
  assert.equal(big.unfolded, true);
  const uvs = big.groups[0].uvs;
  let maxUv = 0;
  for (let i = 0; i < uvs.length; i++) maxUv = Math.max(maxUv, uvs[i]);
  // The 120 m side tiles 15 times (8 m a repeat), plus under one repeat of whole-repeat shift.
  assert.ok(maxUv >= 15 * 64 && maxUv < 16 * 64, `max uv ${maxUv}`);
});

test('collision: a stretched pebble is a walkable, blocking surface', () => {
  const meshes = new Map([[60711, cube(60711)]]);
  const objs = [{ kind: 'model', model: 60711, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [20, 3, 20] }];
  const { positions, pieces, rockPieces, skipped } = wildernessCollisionTriangles(objs, meshes);
  assert.equal(pieces, 1);
  assert.equal(rockPieces, 1);
  assert.equal(skipped.length, 0);
  const ground = [-100, 0, -100, -100, 0, 100, 100, 0, 100, -100, 0, -100, 100, 0, 100, 100, 0, -100];
  const all = new Float32Array([...ground, ...positions]);
  const world = new CollisionWorld({ positions: all, groundFirstTriangle: 0, groundTriangleCount: 2 });
  // The cube spans x 0..20, z -20..0 (z mirrored), 3 m tall: standing on top, blocked from the side.
  close(world.heightAt(10, -10, 3.2), 3, 1e-4);
  const moved = world.move(-5, -10, 15, -10, { y: 0 });
  assert.ok(moved.x < 0, `blocked at the rock face, got x=${moved.x}`);
  const far = wildernessCollisionTriangles([{ model: 60711, scale: [1e6, 1, 1] }], meshes);
  assert.equal(far.pieces, 0);
  assert.match(far.skipped[0].reason, /stretched past/);
});

test('layout XML objects parse type, name and scale', () => {
  const objs = parseLayoutObjects(
    '<locationPrefab><object><type>0</type><objectID>0</objectID><name>60717</name><scaleX>30</scaleX><scaleY>2.5</scaleY><scaleZ>30</scaleZ></object>' +
      '<object><type>1</type><name>210.3</name></object></locationPrefab>',
  );
  assert.deepEqual(objs, [
    { type: 0, name: '60717', scale: [30, 2.5, 30] },
    { type: 1, name: '210.3', scale: [1, 1, 1] },
  ]);
});

// ---- custom prefabs (Location Loader type 4) ----

// A tiny binary FBX 7400 writer for fixtures (original test code, not mod data).
function fbxNode(name, props = [], children = []) {
  const enc = (p) => {
    if (typeof p === 'string') {
      const b = Buffer.from(p, 'utf8');
      const h = Buffer.alloc(5); h.write('S', 0, 'latin1'); h.writeUInt32LE(b.length, 1);
      return Buffer.concat([h, b]);
    }
    if (typeof p === 'bigint') { const b = Buffer.alloc(9); b.write('L', 0, 'latin1'); b.writeBigInt64LE(p, 1); return b; }
    if (typeof p === 'number') { const b = Buffer.alloc(9); b.write('D', 0, 'latin1'); b.writeDoubleLE(p, 1); return b; }
    if (p.t) {
      const raw = Buffer.from(p.arr.buffer, p.arr.byteOffset, p.arr.byteLength);
      const data = p.zip ? deflateSync(raw) : raw;
      const h = Buffer.alloc(13); h.write(p.t, 0, 'latin1'); h.writeUInt32LE(p.arr.length, 1); h.writeUInt32LE(p.zip ? 1 : 0, 5); h.writeUInt32LE(data.length, 9);
      return Buffer.concat([h, data]);
    }
    throw new Error('bad prop');
  };
  return { name, props: props.map(enc), children };
}
function fbxBytes(top) {
  const parts = [];
  let off = 27;
  const header = Buffer.alloc(27); header.write('Kaydara FBX Binary  \0', 0, 'latin1'); header[21] = 0x1a; header.writeUInt32LE(7400, 23);
  parts.push(header);
  const write = (n) => {
    const props = Buffer.concat(n.props);
    const start = off;
    const head = Buffer.alloc(13 + n.name.length);
    off += head.length + props.length;
    parts.push(head, props);
    for (const c of n.children) write(c);
    if (n.children.length) { parts.push(Buffer.alloc(13)); off += 13; }
    head.writeUInt32LE(off, 0); head.writeUInt32LE(n.props.length / 1 && n.props.length, 4); head.writeUInt32LE(props.length, 8);
    head[12] = n.name.length; head.write(n.name, 13, 'latin1');
    void start;
  };
  top.forEach(write);
  parts.push(Buffer.alloc(13));
  return new Uint8Array(Buffer.concat(parts));
}
const P70 = (entries) => fbxNode('Properties70', [], entries.map(([k, ...v]) => fbxNode('P', [k, '', '', '', ...v])));
function fixtureFbx() {
  // An L-shaped (concave) hexagon on y = 0 using material 1, plus one triangle using material 0.
  // Units: cm (UnitScaleFactor 1). UVs ByPolygonVertex/IndexToDirect, normals ByPolygonVertex/Direct.
  const verts = new Float64Array([0, 0, 0, 200, 0, 0, 200, 0, 100, 100, 0, 100, 100, 0, 200, 0, 0, 200, 0, 100, 0]);
  const pvi = new Int32Array([0, 1, 2, 3, 4, ~5, 0, 5, ~6]);
  const uv = new Float64Array([0, 0, 1, 0, 1, 0.5, 0.5, 0.5, 0.5, 1, 0, 1, 0, 0.25]);
  const uvIndex = new Int32Array([0, 1, 2, 3, 4, 5, 0, 5, 6]);
  const normals = new Float64Array(9 * 3).fill(0);
  for (let i = 0; i < 6; i++) normals[i * 3 + 1] = 1;
  for (let i = 6; i < 9; i++) normals[i * 3] = 1;
  const geom = fbxNode('Geometry', [1000n, 'Fixture\u0000\u0001Geometry', 'Mesh'], [
    fbxNode('Vertices', [{ t: 'd', arr: verts, zip: true }]),
    fbxNode('PolygonVertexIndex', [{ t: 'i', arr: pvi }]),
    fbxNode('LayerElementUV', [0], [
      fbxNode('MappingInformationType', ['ByPolygonVertex']), fbxNode('ReferenceInformationType', ['IndexToDirect']),
      fbxNode('UV', [{ t: 'd', arr: uv }]), fbxNode('UVIndex', [{ t: 'i', arr: uvIndex }]),
    ]),
    fbxNode('LayerElementNormal', [0], [
      fbxNode('MappingInformationType', ['ByPolygonVertex']), fbxNode('ReferenceInformationType', ['Direct']),
      fbxNode('Normals', [{ t: 'd', arr: normals, zip: true }]),
    ]),
    fbxNode('LayerElementMaterial', [0], [
      fbxNode('MappingInformationType', ['ByPolygon']), fbxNode('ReferenceInformationType', ['IndexToDirect']),
      fbxNode('Materials', [{ t: 'i', arr: new Int32Array([1, 0]) }]),
    ]),
  ]);
  const model = fbxNode('Model', [2000n, 'Fixture\u0000\u0001Model', 'Mesh'], [P70([['Lcl Scaling', 100, 100, 100]])]);
  return fbxBytes([
    fbxNode('GlobalSettings', [], [P70([['UnitScaleFactor', 1], ['UpAxis', 1]])]),
    fbxNode('Objects', [], [geom, model]),
    fbxNode('Connections', [], [fbxNode('C', ['OO', 1000n, 2000n])]),
  ]);
}

test('binary FBX: tree, zlib arrays and layer elements read losslessly', async () => {
  const tree = await parseFbx(fixtureFbx());
  assert.equal(tree.version, 7400);
  const fbx = fbxGeometries(tree);
  assert.equal(fbx.unitScale, 1);
  const g = fbx.geometries[0];
  assert.equal(g.name, 'Fixture');
  assert.deepEqual(Array.from(g.vertices.slice(0, 6)), [0, 0, 0, 200, 0, 0]);
  assert.equal(g.uv.reference, 'IndexToDirect');
  assert.deepEqual(Array.from(g.material.data), [1, 0]);
  assert.deepEqual(g.model.scaling, [100, 100, 100]);
  await assert.rejects(parseFbx(new Uint8Array(40)), /not a binary FBX/);
});

test('Unity import: cm -> m, x mirrored, winding kept, submeshes by material, concave n-gon ear-clipped', async () => {
  const mesh = unityMeshFromFbx(fbxGeometries(await parseFbx(fixtureFbx())));
  assert.equal(mesh.scale, 0.01);
  assert.equal(mesh.submeshes.length, 2);
  assert.equal(mesh.submeshes[0].fbxMaterial, 0);
  assert.equal(mesh.submeshes[0].positions.length, 9); // the triangle
  assert.equal(mesh.submeshes[1].positions.length, 4 * 9); // hexagon -> 4 triangles
  close(mesh.bounds.min[0], -2, 1e-9); // x negated: 0..200 cm -> -2..0 m
  close(mesh.bounds.max[0], 0, 1e-9);
  close(mesh.bounds.max[2], 2, 1e-9);
  // Ear clipping covers exactly the L area (3 m^2) with no triangle outside it.
  const P = mesh.submeshes[1].positions;
  let area = 0;
  for (let i = 0; i < P.length; i += 9) {
    const ax = P[i + 3] - P[i], az = P[i + 5] - P[i + 2], bx = P[i + 6] - P[i], bz = P[i + 8] - P[i + 2];
    area += Math.abs(ax * bz - az * bx) / 2;
    const cx = (P[i] + P[i + 3] + P[i + 6]) / 3, cz = (P[i + 2] + P[i + 5] + P[i + 8]) / 3;
    assert.ok(!(cx < -1 && cz > 1), 'triangle in the L notch');
  }
  close(area, 3, 1e-9);
  // Normals mirrored with x; the triangle's +x normal becomes -x.
  close(mesh.submeshes[0].normals[0], -1);
  assert.deepEqual(triangulatePolygon([[0, 0, 0], [1, 0, 0], [1, 0, 1]]), [[0, 1, 2]]);
});

const PREFAB_YAML = `%YAML 1.1
--- !u!1 &1
GameObject:
  m_Name: Fixture_Rock
--- !u!4 &2
Transform:
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 1, y: 2, z: 3}
  m_LocalScale: {x: 2, y: 2, z: 2}
  m_Children: []
  m_Father: {fileID: 0}
--- !u!33 &3
MeshFilter:
  m_Mesh: {fileID: 4300000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
--- !u!23 &4
MeshRenderer:
  m_Materials:
  - {fileID: 2100000, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 2}
  - {fileID: 2100000, guid: cccccccccccccccccccccccccccccccc, type: 2}
  m_StaticBatchInfo:
--- !u!64 &5
MeshCollider:
  m_Mesh: {fileID: 4300000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 3}
--- !u!114 &6
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: 426f76434556e931a830bf5c83c73b54, type: 3}
`;

test('Unity prefab and material YAML', () => {
  const p = parseUnityPrefab(PREFAB_YAML);
  assert.equal(p.name, 'Fixture_Rock');
  assert.deepEqual(p.scale, [2, 2, 2]);
  assert.equal(p.meshGuid, 'a'.repeat(32));
  assert.deepEqual(p.materialGuids, ['b'.repeat(32), 'c'.repeat(32)]);
  assert.equal(p.meshCollider, true);
  assert.equal(p.wodRocksMaterials, true);
  const m = parseUnityMaterial(`  m_Name: Fixture\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: ${'d'.repeat(32)}, type: 3}\n        m_Scale: {x: 2, y: 3}\n        m_Offset: {x: 0.5, y: 0}\n    - _Color: {r: 1, g: 0.5, b: 1, a: 1}\n`);
  assert.equal(m.textureGuid, 'd'.repeat(32));
  assert.deepEqual(m.tiling, [2, 3]);
  assert.deepEqual(m.offset, [0.5, 0]);
  assert.deepEqual(m.color, [1, 0.5, 1, 1]);
  const scaled = prefabMatrix(scaleM(3, 3, 3), { root: { scale: [2, 2, 2] } });
  assert.equal(pieceStretch(scaled), 6);
});

test('WODRocksMaterials climate/season selection', () => {
  const d = (a) => [{ archive: a, record: 0, frame: 0 }, { archive: a, record: 1, frame: 0 }];
  const settings = {
    desert: { defaultMaterials: d(10), winterMaterials: d(11) },
    mountain: { defaultMaterials: d(20), winterMaterials: d(21) },
    mountainBalfiera: { defaultMaterials: d(30), winterMaterials: d(31) },
    mountainHammerfell: { defaultMaterials: d(40), winterMaterials: d(41) },
    rainforest: { defaultMaterials: d(50), winterMaterials: d(51) },
    woodlands: { defaultMaterials: d(60), winterMaterials: d(61) },
    swamp: {}, subtropical: {}, mountainWoods: {}, hauntedWoodlands: {}, ocean: {},
  };
  const a = (ctx) => selectRuntimeMaterials(settings, ctx)?.[0].archive;
  assert.equal(a({ climate: CLIMATE.Woodlands }), 60);
  assert.equal(a({ climate: CLIMATE.Woodlands, winter: true }), 61);
  assert.equal(a({ climate: CLIMATE.Desert, winter: true }), 10); // deserts never snow
  assert.equal(a({ climate: CLIMATE.Swamp }), 50); // falls back to rainforest
  assert.equal(a({ climate: CLIMATE.Subtropical, winter: true }), 10); // -> desert, no winter
  assert.equal(a({ climate: CLIMATE.MountainWoods }), 20);
  assert.equal(a({ climate: CLIMATE.HauntedWoodlands }), 60);
  assert.equal(a({ climate: CLIMATE.Ocean }), 60);
  assert.equal(a({ climate: CLIMATE.Mountain, region: 'Isle of Balfiera' }), 30);
  assert.equal(a({ climate: CLIMATE.Mountain, region: 'Dragontail Mountains' }), 30); // no Biomes mod
  assert.equal(a({ climate: CLIMATE.Mountain, region: 'Dragontail Mountains', biomesMod: true }), 40);
  assert.equal(a({ climate: CLIMATE.Mountain, region: 'Wrothgarian Mountains', winter: true }), 21);
  assert.equal(selectRuntimeMaterials({ woodlands: {} }, { climate: CLIMATE.Woodlands }), null);
});

test('custom piece triangles: REPEAT uvs in top-left space, tiling applied, untextured slots dropped', async () => {
  const mesh = unityMeshFromFbx(fbxGeometries(await parseFbx(fixtureFbx())));
  const custom = { ...mesh, materials: [] };
  const tri = customPieceTriangles(custom, composeModelMatrix({ scale: [10, 10, 10] }), [null, { kind: 'pack', path: 'x.png', tiling: [2, 1], offset: [0, 0] }]);
  assert.equal(tri.groups.length, 1);
  assert.equal(tri.groups[0].slot, 1);
  const uv = tri.groups[0].uvs;
  for (let i = 0; i < uv.length; i += 2) assert.ok(uv[i] >= 0 && uv[i] <= 2 && uv[i + 1] >= 0 && uv[i + 1] <= 1);
  // All normals of the floor polygon point up after the z mirror and the x mirror.
  for (let i = 1; i < tri.groups[0].normals.length; i += 3) close(tri.groups[0].normals[i], 1, 1e-6);
  const json = JSON.parse(JSON.stringify(serializeCustomPrefab({ name: 'f', ...custom })));
  assert.equal(deserializeCustomPrefab(json).submeshes[1].positions.length, custom.submeshes[1].positions.length);
  assert.throws(() => deserializeCustomPrefab({ name: 'f', materials: [], submeshes: [{ positions: [1, 2], uvs: [], normals: [] }] }));
});

test('real pack: shipped layouts place custom prefabs and stretched pebbles; every prefab converts', { skip: !hasPack && 'gamedata/world-of-daggerfall not present' }, async () => {
  const a = auditWodModels(PACK);
  assert.equal(a.title, 'World of Daggerfall');
  assert.ok(a.placements > 100000, `placements ${a.placements}`);
  assert.ok(a.rockPebbleInstances > 100000);
  assert.ok(a.referencedCustom.length >= 40, `custom ${a.referencedCustom.length}`);
  assert.ok(a.referencedCustom.every((c) => c.bundledPrefab), 'a referenced prefab is missing from the bundle');
  assert.deepEqual(a.missingLayouts, [], 'layout names resolve case-insensitively (wod_prop_scouttower -> WOD_Prop_ScoutTower.txt)');
  assert.equal((await createWodModelStore({ root: PACK }).custom('mountain_01'))?.name, 'Mountain_01');
  const store = createWodModelStore({ root: PACK });
  const index = await store.index();
  const read = await store.reader();
  assert.equal(await read('../package.json'), null);
  assert.equal(await store.custom('No_Such_Prefab'), null);
  for (const c of a.referencedCustom) {
    const custom = await store.custom(c.name);
    assert.ok(custom, c.name);
    assert.deepEqual(custom.notes, [], `${c.name}: ${custom.notes}`);
    assert.ok(custom.submeshes.length >= 1);
    for (const sm of custom.submeshes) for (const x of sm.positions) assert.ok(Number.isFinite(x));
    const tex = await resolveCustomMaterials(custom, index, read, { climate: CLIMATE.Woodlands, region: 'Daggerfall', climateBase: 300, applyClimate: (x) => x });
    assert.ok(tex.some(Boolean), `${c.name} has no drawable slot`);
    for (const t of tex) if (t?.kind === 'pack') assert.ok(/\.png$/i.test(t.path) && index.guids && Object.values(index.guids).includes(t.path));
  }
  // A mountain is a walkable, blocking surface at its placed scale.
  const mountain = await store.custom('Mountain_01');
  const obj = { kind: 'asset', asset: 'Mountain_01', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [10, 10, 10] };
  const col = wildernessCollisionTriangles([obj], new Map(), { customs: new Map([['Mountain_01', mountain]]) });
  assert.equal(col.assetPieces, 1);
  const world = new CollisionWorld({ positions: col.positions });
  const top = world.heightAt(0, 0, null);
  assert.ok(top !== null, 'ground under the mountain centre');
});

test('real ARENA2: rock pebbles decode, unfold and collide', { skip: !hasArena2 && 'operator ARENA2 not present' }, async () => {
  const { arena2Files } = await import('../server/rpg/collision/arena2.js');
  const files = await arena2Files(ARENA2);
  const { meshes, missing } = await loadArch3dMeshes(files, [...WOD_ROCK_MODELS]);
  assert.deepEqual(missing, []);
  const m = meshes.get(60717);
  assert.ok(m.planes.length > 10);
  const piece = { model: 60717, position: [0, -2, 0], rotation: [0, 0.38268343, 0, 0.92387953], scale: [74.66796, 20, 60] };
  const mat = composeModelMatrix(piece);
  assert.ok(needsUnfold(60717, mat));
  const tri = pieceTriangles(m, mat, { textureSize: () => ({ w: 64, h: 64 }) });
  for (const g of tri.groups) {
    for (const x of g.uvs) assert.ok(Number.isFinite(x));
    // Density capped: no triangle maps more than 8 texels per metre on its longest edge.
    for (let i = 0; i < g.positions.length; i += 9) {
      const j = (i / 9) * 6;
      const e = Math.hypot(g.positions[i + 3] - g.positions[i], g.positions[i + 4] - g.positions[i + 1], g.positions[i + 5] - g.positions[i + 2]);
      const t = Math.hypot(g.uvs[j + 2] - g.uvs[j], g.uvs[j + 3] - g.uvs[j + 1]);
      if (e > 1) assert.ok(t / e <= 8 + 1e-3, `density ${t / e} texels/m`);
    }
  }
  const col = wildernessCollisionTriangles([piece], meshes);
  assert.equal(col.pieces, 1);
  assert.ok(col.positions.length >= 9 * m.planes.length);
});
