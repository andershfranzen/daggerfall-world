// World of Daggerfall reader (client/world/wilderness/data.js): synthetic regression fixtures.
// Fixtures are written here from the Location Loader file format; no author file is copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSiteIds,
  classifyObject,
  composeScene,
  composeSite,
  displayName,
  eulerDegToQuat,
  instanceDimensions,
  isOutOfBounds,
  markerEnemyId,
  markerTeam,
  overlappingSections,
  parseFloat32,
  parseInstanceCsv,
  parseInt32,
  parsePrefabXml,
  parseSiteId,
  parseWildernessId,
  quatToEulerDeg,
  rejectReason,
  siteKind,
  splitCsvLine,
  validateObject,
  wildernessId,
  worldDataTownArea,
} from '../client/world/wilderness/data.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const nearVec = (a, b, eps = 1e-3) => a.forEach((v, i) => near(v, b[i], eps));

const PREFAB = `<?xml version="1.0"?>
<locationPrefab>
  <height>7</height>
  <width>6</width>
  <!-- a camp -->
  <object><type>0</type><objectID>1</objectID><name>41734</name>
    <posX>2</posX><posY>0.5</posY><posZ>3</posZ><scaleX>1</scaleX><scaleY>2</scaleY><scaleZ>1</scaleZ>
    <rotW>0.7071068</rotW><rotX>0</rotX><rotY>0.7071068</rotY><rotZ>0</rotZ></object>
  <object><type>1</type><objectID>2</objectID><name>216.27</name>
    <posX>-1</posX><posY>0</posY><posZ>0</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object>
  <object><type>1</type><objectID>3</objectID><name>210.1</name>
    <posX>0</posX><posY>0</posY><posZ>-1</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object>
  <object><type>2</type><objectID>4</objectID><name>199.16</name>
    <posX>4</posX><posY>0</posY><posZ>0</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ>
    <extraData>{"EnemyId":136,"TeamOverride":0}</extraData></object>
  <object><type>2</type><objectID>5</objectID><name>199.19</name>
    <posX>0</posX><posY>0</posY><posZ>4</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object>
  <object><type>4</type><objectID>6</objectID><name>Assets/Prefabs/WOD_Rock_Flat_m_2C_01.prefab</name>
    <posX>0</posX><posY>0</posY><posZ>0</posZ><scaleX>3</scaleX><scaleY>3</scaleY><scaleZ>3</scaleZ>
    <rotW>1</rotW><rotX>0</rotX><rotY>0</rotY><rotZ>0</rotZ></object>
  <object><type>4</type><objectID>7</objectID><name>52990</name>
    <posX>1</posX><posY>0</posY><posZ>1</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ>
    <rotW>1</rotW><rotX>0</rotX><rotY>0</rotY><rotZ>0</rotZ></object>
  <object><type>0</type><objectID>8</objectID><name>not-a-number</name>
    <posX>0</posX><posY>0</posY><posZ>0</posZ><scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object>
</locationPrefab>`;

test('ids: wilderness and site ids are canonical and bounded', () => {
  assert.deepEqual(parseWildernessId('wilderness:109,159'), { px: 109, py: 159 });
  assert.equal(wildernessId(0, 0), 'wilderness:0,0');
  assert.equal(wildernessId(1000, 0), null);
  for (const bad of ['wilderness:1000,1', 'wilderness:1,500', 'wilderness:01,2', 'wilderness:-1,2', 'wilderness:1, 2', 'town:x/y', 'wilderness:1,2 ', null, 5]) {
    assert.equal(parseWildernessId(bad), null, String(bad));
  }
  assert.deepEqual(parseSiteId('wod:109,160:21,107'), { px: 109, py: 160, tx: 21, ty: 107, n: 1 });
  assert.deepEqual(parseSiteId('wod:109,160:21,107#3'), { px: 109, py: 160, tx: 21, ty: 107, n: 3 });
  for (const bad of ['wod:109,160:21,107#1', 'wod:109,160:129,1', 'wod:1000,1:1,1', 'wod:1,1:1', '../etc/passwd']) assert.equal(parseSiteId(bad), null, bad);
});

test('numbers follow int.Parse / float.Parse(en-US)', () => {
  assert.equal(parseInt32(' 42 '), 42);
  assert.equal(parseInt32('2147483648'), null);
  assert.equal(parseInt32('1.5'), null);
  assert.equal(parseFloat32('-4.360001'), Math.fround(-4.360001));
  assert.equal(parseFloat32('1,5'), null);
  assert.equal(parseFloat32('1e3'), 1000);
});

test('CSV: header case and separators, quotes, BOM, optional columns, bad rows skipped', () => {
  assert.deepEqual(splitCsvLine('a,"b,""c""",,d'), ['a', 'b,"c"', '', 'd']);
  const csv = '﻿Name;TYPE;prefab;worldX;worldY;terrainX;terrainY;rotYAxis;sink;scale;extraData\n' +
    'Tower,0,WOD_T,90,163,91,101,180,,,\n' +
    'Rock,1,WOD_R,90,163,10,20,,0.5,2.5,"{""a"":1}"\n' +
    'Bad,x,WOD_R,90,163,10,20,,,,\n' +
    'Short,0,WOD_R\n';
  const { instances, skipped, error } = parseInstanceCsv(csv);
  assert.equal(error, null);
  assert.equal(skipped, 2);
  assert.equal(instances.length, 2);
  const [a, b] = instances;
  assert.equal(a.name, 'Tower');
  nearVec(quatToEulerDeg(a.rot), [0, 180, 0]);
  assert.equal(b.sink, 0.5);
  assert.equal(b.scale, 2.5);
  assert.equal(b.extraData, '{"a":1}');
  assert.equal(parseInstanceCsv('name,type\nx,0').error, 'missing column prefab');
});

test('XML prefab: structure, entities, type-4 fixups and validation', () => {
  const p = parsePrefabXml(PREFAB);
  assert.equal(p.width, 6);
  assert.equal(p.height, 7);
  assert.equal(p.obj.length, 8);
  assert.equal(p.obj[5].type, 4);
  assert.equal(p.obj[5].name, 'WOD_Rock_Flat_m_2C_01');
  assert.equal(p.obj[6].type, 0, 'numeric type-4 names are models');
  assert.equal(validateObject(0, 'not-a-number'), false);
  assert.equal(validateObject(2, '198.16'), false);
  assert.equal(validateObject(1, '216.27'), true);
  assert.equal(parsePrefabXml('<other/>'), null);
  assert.throws(() => parsePrefabXml('<locationPrefab><a></b></locationPrefab>'));
  assert.equal(parsePrefabXml('<locationPrefab><height>1</height><width>1</width><winterPrefab>W &amp; X</winterPrefab></locationPrefab>').winterPrefab, 'W & X');
});

test('classification: kinds, names, markers', () => {
  assert.equal(siteKind('WOD_OrcCamp', 'WOD_OrcCamp_Medium_01'), 'camp');
  assert.equal(siteKind('WOD_BanditFort', 'x'), 'fort');
  assert.equal(siteKind('Logging Camp', 'x'), 'logging');
  assert.equal(siteKind('Daggerfall Border Tower', 'WOD_Daggerfall_BorderTower_01'), 'tower');
  assert.equal(siteKind('x', 'WOD_Rocks_Large_01'), 'rocks');
  assert.equal(siteKind('Foo', 'Bar', 'Locations/Daggerfall/Daggerfall_Mountains.csv'), 'mountain');
  assert.equal(displayName('WOD_OrcCamp'), 'Orc Camp');
  assert.equal(markerEnemyId('{"EnemyId":136,"TeamOverride":0}'), 136);
  assert.equal(markerEnemyId('7'), 7);
  assert.equal(markerEnemyId('{bad'), null);
  assert.equal(markerTeam('{"EnemyId":1,"TeamOverride":1}'), 1);
  assert.equal(markerTeam('{"EnemyId":1,"TeamOverride":0}'), 0);
  assert.deepEqual(classifyObject({ type: 1, name: '216.3' }), { kind: 'flat', archive: 216, record: 3, loot: true });
  assert.deepEqual(classifyObject({ type: 2, name: '199.19' }), { kind: 'marker', marker: 19, loot: true });
  assert.deepEqual(classifyObject({ type: 5, name: 'FARMAA00.RMB' }), { kind: 'block', block: 'FARMAA00.RMB' });
});

test('Euler: Unity ZXY order and round trip', () => {
  const q = eulerDegToQuat(30, 45, 60);
  nearVec(quatToEulerDeg(q), [30, 45, 60]);
  nearVec(eulerDegToQuat(0, 90, 0), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
});

test('placement: unrotated instance equals the tile formula, mapped to the scene frame', () => {
  const prefab = parsePrefabXml(PREFAB);
  const inst = { name: 'WOD_BanditCamp', type: 0, prefab: 'WOD_BanditCamp_05', worldX: 109, worldY: 160, terrainX: 21, terrainY: 107, rot: [0, 0, 0, 1], sink: 0, scale: 1 };
  const site = composeSite(inst, prefab, { id: 'wod:109,160:21,107' });
  // root: (21*6.4, 0, 107*6.4) tile-local -> (x-409.6, y, 409.6-z)
  nearVec(site.anchor, [21 * 6.4 - 409.6, 0, 409.6 - 107 * 6.4]);
  assert.deepEqual(site.tile, { x: 21, y: 107 });
  assert.equal(site.width, 6);
  assert.equal(site.height, 7);
  const model = site.objects.find((o) => o.objectID === 1);
  nearVec(model.position, [21 * 6.4 + 2 - 409.6, 0.5, 409.6 - (107 * 6.4 + 3)]);
  assert.equal(model.rotation, undefined, 'matrix objects carry no redundant rotation');
  // matrix: model +z (north in Unity, after rotY 90 -> east) maps to scene +x; model +y scaled by 2.
  const m = model.matrix;
  nearVec([m[8], m[9], m[10]], [1, 0, 0]);
  nearVec([m[4], m[5], m[6]], [0, 2, 0]);
  nearVec([m[12], m[13], m[14]], model.position);
  const flat = site.objects.find((o) => o.objectID === 2);
  assert.equal(flat.kind, 'flat');
  assert.equal(flat.loot, true);
  assert.equal(flat.align, 'base');
  nearVec(flat.scale, [1, 1, 1]);
  assert.equal(site.objects.find((o) => o.objectID === 3).light, true);
  assert.equal(site.objects.find((o) => o.objectID === 6).kind, 'prefab');
  assert.equal(site.objects.find((o) => o.objectID === 7).kind, 'model');
  assert.ok(!site.objects.some((o) => o.objectID === 8), 'invalid objects are dropped');
  assert.deepEqual(site.markers.map((m) => [m.objectID, m.marker, m.enemy ?? null, !!m.loot]), [[4, 16, 136, false], [5, 19, null, true]]);
});

test('placement: rotYAxis 180 and scale turn the layout about the anchor; pixel offsets shift scenes', () => {
  const prefab = parsePrefabXml(PREFAB);
  const inst = { name: 'T', type: 1, prefab: 'P', worldX: 10, worldY: 10, terrainX: 64, terrainY: 64, rot: eulerDegToQuat(0, 180, 0), sink: 0, scale: 2 };
  const site = composeSite(inst, prefab, { id: 'x' });
  const marker = site.markers.find((m) => m.objectID === 4); // local (4,0,0) -> Unity (-8,0,0)
  nearVec(marker.position, [64 * 6.4 - 8 - 409.6, 0, 409.6 - 64 * 6.4]);
  near(site.yaw, Math.PI);
  // Seen from the pixel to the north (py-1), the same site sits one pixel further south (+z).
  const fromNorth = composeSite(inst, prefab, { id: 'x', offsetPx: [0, 1] });
  near(fromNorth.anchor[2] - site.anchor[2], 819.2);
});

test('nested type-3 layouts compose transforms and guard against cycles', () => {
  const inner = parsePrefabXml(`<locationPrefab><height>1</height><width>1</width>
    <object><type>0</type><objectID>1</objectID><name>100</name><posX>1</posX><posY>0</posY><posZ>0</posZ>
    <scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ><rotW>1</rotW><rotX>0</rotX><rotY>0</rotY><rotZ>0</rotZ></object>
    <object><type>3</type><objectID>2</objectID><name>Outer</name><posX>0</posX><posY>0</posY><posZ>0</posZ>
    <scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object></locationPrefab>`);
  const outer = parsePrefabXml(`<locationPrefab><height>2</height><width>2</width>
    <object><type>3</type><objectID>9</objectID><name>Inner</name><posX>0</posX><posY>0</posY><posZ>5</posZ>
    <scaleX>2</scaleX><scaleY>2</scaleY><scaleZ>2</scaleZ><rotW>0.7071068</rotW><rotX>0</rotX><rotY>0.7071068</rotY><rotZ>0</rotZ></object>
    <object><type>3</type><objectID>10</objectID><name>Missing</name><posX>0</posX><posY>0</posY><posZ>0</posZ>
    <scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ></object></locationPrefab>`);
  const lib = { inner, outer };
  const inst = { name: 'B', type: 0, prefab: 'Outer', worldX: 5, worldY: 5, terrainX: 64, terrainY: 64, rot: [0, 0, 0, 1], sink: 0, scale: 1 };
  const site = composeSite(inst, outer, { id: 'b', getPrefab: (n) => lib[n.toLowerCase()] ?? null });
  assert.equal(site.objects.length, 1);
  const o = site.objects[0];
  assert.equal(o.objectID, '9.1');
  // Inner origin at Unity (0,0,5); child (1,0,0) * scale 2, rotY 90 -> (0,0,-2): Unity (0,0,3) -> scene z = -3.
  nearVec(o.position, [0, 0, -3]);
  // Column 0 (model +x): rotY 90 sends Unity +x to Unity -z = scene +z, scaled by 2.
  nearVec([o.matrix[0], o.matrix[1], o.matrix[2]], [0, 0, 2]);
  assert.deepEqual(site.missing, ['Missing', 'Outer'], 'unresolved and cyclic layouts are reported, not expanded');
});

test('footprint, bounds, overlap sections and town pruning follow Location Loader', () => {
  const prefab = { width: 6, height: 7, obj: [] };
  const base = { type: 0, worldX: 50, worldY: 50, terrainX: 64, terrainY: 64, rot: [0, 0, 0, 1], scale: 1 };
  assert.deepEqual(instanceDimensions(base, prefab), { width: 6, height: 7, halfWidth: 3, halfHeight: 4 });
  assert.deepEqual(instanceDimensions({ ...base, rot: eulerDegToQuat(0, 90, 0) }, prefab), { width: 7, height: 6, halfWidth: 4, halfHeight: 3 });
  assert.equal(isOutOfBounds({ ...base, terrainX: 126 }, prefab), true);
  assert.equal(isOutOfBounds({ ...base, type: 1, terrainX: 126 }, prefab), false);
  const sections = overlappingSections({ ...base, type: 1, terrainX: 126, terrainY: 126 }, prefab);
  // East (px+1) and north (py-1) neighbours: terrainY grows north while pixel y grows south.
  assert.deepEqual(sections.map((s) => [s.px, s.py]).sort(), [[50, 49], [50, 50], [51, 49], [51, 50]]);
  const town = worldDataTownArea(3, 3);
  assert.deepEqual(town, { x: 40, y: 40, width: 48, height: 48 });
  assert.equal(rejectReason(base, prefab, (px, py) => (px === 50 && py === 50 ? town : null)), 'on a town');
  assert.equal(rejectReason({ ...base, terrainX: 10, terrainY: 10 }, prefab, () => town), null);
  assert.equal(rejectReason(base, null), 'prefab missing');
});

test('site ids are stable and disambiguate rows sharing coordinates in load order', () => {
  const rows = [
    { worldX: 1, worldY: 2, terrainX: 3, terrainY: 4 },
    { worldX: 1, worldY: 2, terrainX: 5, terrainY: 6 },
    { worldX: 1, worldY: 2, terrainX: 3, terrainY: 4 },
  ];
  assert.deepEqual(assignSiteIds(rows), ['wod:1,2:3,4', 'wod:1,2:5,6', 'wod:1,2:3,4#2']);
});

test('scene: frame, spawn south of the focus facing north, region index', () => {
  const prefab = parsePrefabXml(PREFAB);
  const inst = { name: 'WOD_Ruins', type: 0, prefab: 'P', worldX: 109, worldY: 160, terrainX: 64, terrainY: 64, rot: [0, 0, 0, 1], sink: 0, scale: 1 };
  const site = composeSite(inst, prefab, { id: 'wod:109,160:64,64' });
  const scene = composeScene({ px: 109, py: 160, region: 'Daggerfall', sites: [site], focus: site.id });
  assert.equal(scene.id, 'wilderness:109,160');
  assert.equal(scene.regionIndex, 17);
  assert.equal(scene.frame, 'rh-y-up-north-negz-metres-origin-pixel-centre');
  assert.deepEqual(scene.tile, { size: 819.2, origin: [-409.6, 0, 409.6] });
  assert.equal(scene.spawn.yaw, 0);
  assert.ok(scene.spawn.z > site.rect.z + site.rect.depth, 'spawn south of the ground rect');
  assert.deepEqual(composeScene({ px: 1, py: 1 }).spawn, { x: 0, y: 0, z: 0, yaw: 0 });
  assert.equal(JSON.stringify(scene), JSON.stringify(JSON.parse(JSON.stringify(scene))), 'plain JSON');
});
