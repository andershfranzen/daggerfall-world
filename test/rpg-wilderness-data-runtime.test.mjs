// Wilderness feature (server/rpg/wilderness.js) over a synthetic Location Loader tree written here:
// two accounts agreeing, stale and invalid routes, encounter/loot hooks, HTTP descriptor, memory bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installWilderness, handleWildernessScene, WILDERNESS_SCENE_PATH, treasureGold } from '../server/rpg/wilderness.js';
import { createWodStore } from '../server/rpg/wilderness/store.js';

const quiet = { error() {}, warn() {}, info() {}, log() {} };
const GOTHWAY = 'town:Daggerfall/Gothway Garden'; // classic starter at map pixel (109, 159)

const obj = (type, id, name, [x, y, z], extra = '') =>
  `<object><type>${type}</type><objectID>${id}</objectID><name>${name}</name><posX>${x}</posX><posY>${y}</posY><posZ>${z}</posZ>` +
  `<scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ>${extra}</object>`;
const prefab = (w, h, objects) => `<locationPrefab><height>${h}</height><width>${w}</width>${objects.join('')}</locationPrefab>`;

function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'wod-fixture-'));
  const loc = join(root, 'Locations');
  for (const d of ['Daggerfall', 'Glenpoint', 'LocationPrefab', 'Development']) mkdirSync(join(loc, d), { recursive: true });
  const header = 'name,type,prefab,worldX,worldY,terrainX,terrainY,locationID\n';
  writeFileSync(
    join(loc, 'Daggerfall', 'Daggerfall_Locations.csv'),
    header +
      'WOD_BanditCamp,0,Test_Camp,109,160,21,107,1\n' +
      'WOD_Ruins,0,Test_Ruin,108,159,64,21,2\n' +
      'WOD_Ruins,0,Test_Ruin,108,159,64,21,3\n' + // same coordinates: second id gets #2
      'WOD_Shrine,0,Test_Shrine,130,159,64,64,4\n' + // beyond the visit radius
      'WOD_Ghost,0,No_Such_Prefab,109,159,30,30,5\n' + // prefab missing: never placed
      'WOD_Edge,0,Test_Camp,109,159,127,64,6\n', // out of bounds for a type 0
  );
  writeFileSync(join(loc, 'Daggerfall', 'Daggerfall_Rocks.csv'), 'name,type,prefab,worldX,worldY,terrainX,terrainY,sink,scale\nRocks,1,Test_Rocks,109,159,126,64,0.5,2\n');
  writeFileSync(join(loc, 'Glenpoint', 'Glenpoint_Locations.csv'), header + 'WOD_Shrine,0,Test_Shrine,110,158,64,64,7\n');
  writeFileSync(join(loc, 'Development', 'Dev.csv'), header + 'WOD_Dev,0,Test_Camp,109,159,64,64,8\n');
  writeFileSync(join(loc, 'WOD_Docks.csv'), header + 'WOD_Dock,2,Test_Ruin,111,160,64,64,9\n');
  writeFileSync(
    join(loc, 'LocationPrefab', 'Test_Camp.txt'),
    prefab(6, 7, [
      obj(0, 1, '41734', [2, 0, 3], '<rotW>1</rotW><rotX>0</rotX><rotY>0</rotY><rotZ>0</rotZ>'),
      obj(1, 2, '216.27', [0, 0, 6]),
      obj(2, 3, '199.16', [4, 0, 0], '<extraData>{"EnemyId":7,"TeamOverride":0}</extraData>'),
      obj(2, 4, '199.16', [-4, 0, 0], '<extraData>{"EnemyId":136,"TeamOverride":1}</extraData>'),
      obj(2, 5, '199.15', [0, 0, -4]),
      obj(2, 6, '199.19', [1, 0, 6]),
    ]),
  );
  writeFileSync(join(loc, 'LocationPrefab', 'Test_Ruin.txt'), prefab(4, 4, [obj(0, 1, '60710', [0, 0, 0])]));
  writeFileSync(join(loc, 'LocationPrefab', 'Test_Shrine.txt'), prefab(2, 2, [obj(1, 1, '210.1', [0, 0, 0])]));
  writeFileSync(join(loc, 'LocationPrefab', 'Test_Rocks.txt'), prefab(8, 8, [obj(0, 1, '60711', [0, -10, 0])]));
  return root;
}

function setup({ root, features = [], radius } = {}) {
  const players = new Map();
  const sent = [];
  let wild;
  const rt = createRpgRuntime({
    players,
    features: [...features, (ctx) => (wild = installWilderness(ctx, { root, radius }))],
    save: () => {},
    send: (p, msg) => sent.push([p.id, msg]),
    log: quiet,
  });
  const add = (id) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const events = (id, kind) => sent.filter(([pid, m]) => pid === id && m.type === 'gameEvent' && m.event.kind === kind).map(([, m]) => m.event);
  return { rt, players, sent, add, events, get wild() { return wild; } };
}

test('pack missing: readable state, empty list, actions refuse', async () => {
  const s = setup({ root: join(tmpdir(), 'no-such-wod-tree-xyz') });
  await s.wild.ready;
  const p = s.add(1);
  assert.equal(p.rpg.wilderness.pack, 'missing');
  assert.match(p.rpg.wilderness.packNote, /not installed/);
  assert.deepEqual(p.rpg.wilderness.nearby, []);
  const r = s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed/);
  assert.equal(s.rt.ctx.services.encounterSites('wilderness:109,160'), undefined, 'falls through to combat');
});

test('two accounts agree on the nearby list, site ids, scene and spawn', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root });
  await s.wild.ready;
  const a = s.add(1), b = s.add(2);
  const wa = a.rpg.wilderness, wb = b.rpg.wilderness;
  assert.equal(wa.pack, 'ready');
  assert.deepEqual(wa.origin, { px: 109, py: 159, region: 'Daggerfall' });
  assert.deepEqual(wa.nearby, wb.nearby);
  const ids = wa.nearby.map((n) => n.id);
  // Placed points of interest only: scenery, missing prefabs, out-of-bounds, Development and far rows are absent.
  assert.deepEqual(ids.sort(), ['wod:108,159:64,21', 'wod:108,159:64,21#2', 'wod:109,160:21,107', 'wod:110,158:64,64', 'wod:111,160:64,64'].sort());
  assert.ok(wa.nearby.every((n, i, l) => i === 0 || l[i - 1].distance <= n.distance), 'nearest first');
  const camp = wa.nearby.find((n) => n.id === 'wod:109,160:21,107');
  assert.equal(camp.kind, 'camp');
  assert.equal(camp.name, 'Bandit Camp');

  assert.deepEqual(s.rt.act(a, 'wilderness.visit', { site: camp.id }), { ok: true });
  assert.deepEqual(s.rt.act(b, 'wilderness.visit', { site: camp.id }), { ok: true });
  assert.equal(a.rpg.location, 'wilderness:109,160');
  assert.equal(b.rpg.location, a.rpg.location);
  assert.deepEqual([a.x, a.z, a.yaw], [b.x, b.z, b.yaw]);
  const [sa] = s.events(1, 'wildernessScene'), [sb] = s.events(2, 'wildernessScene');
  assert.equal(JSON.stringify(sa.scene), JSON.stringify(sb.scene), 'byte-identical descriptors');
  assert.equal(sa.scene.id, 'wilderness:109,160');
  const site = sa.scene.sites.find((x) => x.id === camp.id);
  // Anchor: terrain (21, 107) -> scene (21*6.4-409.6, 0, 409.6-107*6.4).
  assert.deepEqual(site.anchor, [-275.2, 0, -275.2]);
  assert.equal(a.z, sa.scene.spawn.z);
  assert.ok(a.z > site.rect.z + site.rect.depth, 'spawned south of the camp');
  assert.equal(a.rpg.wilderness.site, camp.id);
  assert.ok(a.rpg.wilderness.discovered.includes(camp.id));
  // Peers see each other at the site (same location in the shared snapshot).
  const msg = s.rt.rpgMessage(a);
  assert.deepEqual(msg.peers.map((q) => q.id), [2]);
});

test('stale and invalid routes are refused without changing state', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root });
  await s.wild.ready;
  const p = s.add(1);
  const before = JSON.stringify(p.rpg);
  const cases = [
    [{ site: 'wod:109,160:1,1' }, /no longer there/], // valid shape, nothing there (stale)
    [{ site: 'wod:109,159:30,30' }, /no longer there/], // prefab missing: never placed
    [{ site: 'wod:109,159:127,64' }, /no longer there/], // out of bounds
    [{ site: 'wod:109,159:64,64' }, /no longer there/], // Development folder is not read
    [{ site: 'wod:130,159:64,64' }, /too far/],
    [{ site: '../../etc/passwd' }, /not a wilderness site/],
    [{ site: 42 }, /Choose a site/],
    [{}, /Choose a site/],
  ];
  for (const [args, re] of cases) {
    const r = s.rt.act(p, 'wilderness.visit', args);
    assert.equal(r.ok, false, JSON.stringify(args));
    assert.match(r.error, re, JSON.stringify(args));
  }
  assert.equal(JSON.stringify(p.rpg), before, 'no state change');
  assert.match(s.rt.act(p, 'wilderness.leave', {}).error, /not in the wilderness/);
  // Indoors: must step outside even for a near site.
  p.rpg.location = 'building:Daggerfall/Gothway Garden/3';
  assert.match(s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' }).error, /Step outside/);
  p.rpg.location = GOTHWAY;
  assert.equal(s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' }).ok, true);
  assert.match(s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' }).error, /already at/);
});

test('visit from the actual position: radius moves with the player', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root, radius: 1.5 });
  await s.wild.ready;
  const p = s.add(1);
  // From Gothway (109,159) the Glenpoint shrine at (110,158) is ~1.4 px away; the docks at (111,160) are not.
  assert.equal(s.rt.act(p, 'wilderness.visit', { site: 'wod:111,160:64,64' }).ok, false);
  assert.equal(s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' }).ok, true);
  // Now standing at (109,160): the docks at (111,160) are ~1.9 px... still too far, but the ruin list moved.
  assert.deepEqual(p.rpg.wilderness.origin, { px: 109, py: 160, region: 'Daggerfall' });
  assert.ok(p.rpg.wilderness.nearby.some((n) => n.id === 'wod:109,160:21,107'));
});

test('leave returns to the town and saved position; travel and overland events', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root });
  await s.wild.ready;
  const p = s.add(1);
  p.x = 12.5;
  p.z = -3;
  p.yaw = 1;
  assert.equal(s.rt.act(p, 'wilderness.visit', { site: 'wod:108,159:64,21' }).ok, true);
  assert.equal(p.rpg.wilderness.returnTo, GOTHWAY);
  assert.equal(s.rt.act(p, 'wilderness.leave', {}).ok, true);
  assert.equal(p.rpg.location, GOTHWAY);
  assert.deepEqual([p.x, p.z, p.yaw], [12.5, -3, 1]);
  assert.equal(p.rpg.wilderness.site, null);
  assert.ok(s.events(1, 'wilderness').some((e) => /return to Gothway Garden/.test(e.text)));
  // Overland walk-out: the overland feature moves the player and emits; we record returnTo and send the scene.
  s.rt.ctx.dirty(p);
  p.rpg.location = 'wilderness:109,160';
  s.rt.ctx.emit('overland', { player: p, from: GOTHWAY, to: 'wilderness:109,160', via: 'walk' });
  s.rt.ctx.services.wilderness.onEnter(p, 'wilderness:109,160');
  assert.equal(p.rpg.wilderness.returnTo, GOTHWAY);
  assert.deepEqual(p.rpg.wilderness.origin, { px: 109, py: 160, region: 'Daggerfall' });
  assert.equal(s.events(1, 'wildernessScene').at(-1).location, 'wilderness:109,160');
});

test('invalid saved wilderness locations are repaired on join', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root });
  await s.wild.ready;
  const p = { id: 9, name: 'P9', x: 5, z: 5, yaw: 0, rpg: { location: 'wilderness:9999,1', wilderness: { returnTo: GOTHWAY, returnPos: { x: 1, z: 2, yaw: 0 } } } };
  s.players.set(9, p);
  s.rt.join(p);
  assert.equal(p.rpg.location, GOTHWAY);
  assert.deepEqual([p.x, p.z], [1, 2]);
});

test('discover marks nearby sites; loot is authoritative, once per character, deterministic', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let gold = [];
  const inv = (ctx) => (ctx.services.giveItem = (p, template, n) => gold.push([p.id, template, n]));
  const s = setup({ root, features: [inv] });
  await s.wild.ready;
  const a = s.add(1), b = s.add(2);
  assert.equal(s.rt.act(a, 'wilderness.discover', { site: 'wod:110,158:64,64' }).ok, true);
  assert.equal(a.rpg.wilderness.nearby.find((n) => n.id === 'wod:110,158:64,64').discovered, true);
  assert.equal(b.rpg.wilderness.nearby.find((n) => n.id === 'wod:110,158:64,64').discovered, false, 'per character');
  assert.match(s.rt.act(a, 'wilderness.discover', { site: 'wod:130,159:64,64' }).error, /too far/);

  const camp = 'wod:109,160:21,107';
  for (const p of [a, b]) assert.equal(s.rt.act(p, 'wilderness.visit', { site: camp }).ok, true);
  const scene = s.wild.service.scene('wilderness:109,160');
  const pile = scene.sites.find((x) => x.id === camp).objects.find((o) => o.loot);
  assert.match(s.rt.act(a, 'wilderness.loot', { site: camp, object: pile.objectID }).error, /closer/);
  for (const p of [a, b]) {
    p.x = pile.position[0];
    p.z = pile.position[2];
    assert.deepEqual(s.rt.act(p, 'wilderness.loot', { site: camp, object: pile.objectID }), { ok: true });
  }
  assert.match(s.rt.act(a, 'wilderness.loot', { site: camp, object: pile.objectID }).error, /already searched/);
  assert.match(s.rt.act(a, 'wilderness.loot', { site: camp, object: 999 }).error, /nothing to search/);
  assert.match(s.rt.act(a, 'wilderness.loot', { site: 'wod:108,159:64,21', object: 1 }).error, /not at that site/);
  const g = treasureGold(camp, pile.objectID);
  assert.deepEqual(gold, [[1, 'gold', g], [2, 'gold', g]], 'same pile, same gold for both accounts');
  assert.ok(a.rpg.wilderness.looted.includes(`${camp}/${pile.objectID}`));
});

test('encounter hook: contract for combat (undefined / null / authoritative array)', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prev = (ctx) => (ctx.services.encounterSites = (loc) => (loc === 'dungeon:x' ? [{ x: 1, z: 1, table: 4, count: 1 }] : undefined));
  const s = setup({ root, features: [prev] });
  const hook = s.rt.ctx.services.encounterSites;
  assert.equal(hook('wilderness:109,160'), null, 'loading: not ready');
  await s.wild.ready;
  assert.equal(hook(GOTHWAY), undefined);
  assert.deepEqual(hook('dungeon:x'), [{ x: 1, z: 1, table: 4, count: 1 }], 'chained');
  assert.deepEqual(hook('wilderness:5,5'), [], 'authoritative and empty where no markers stand');
  const sites = hook('wilderness:109,160');
  const byKey = Object.fromEntries(sites.map((e) => [e.key, e]));
  assert.deepEqual(Object.keys(byKey).sort(), ['wod:109,160:21,107#3', 'wod:109,160:21,107#4', 'wod:109,160:21,107#5']);
  assert.deepEqual(byKey['wod:109,160:21,107#3'].monsters, [7]); // Orc: known monster
  assert.equal(byKey['wod:109,160:21,107#5'].table, 33); // 199.15 random monster
  assert.equal(byKey['wod:109,160:21,107#4'].team, 1); // TeamOverride carried through
  // Marker (4,0,0) relative to the anchor (-275.2, 0, -275.2).
  assert.deepEqual([byKey['wod:109,160:21,107#3'].x, byKey['wod:109,160:21,107#3'].z], [-271.2, -275.2]);
});

test('type 1 rows reach into neighbouring scenes; memory stays within the folder budget', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createWodStore({ root, maxFolders: 1, log: quiet });
  await store.init();
  // Rocks at (109,159) terrain (126,64), scale 2, 8x8: reaches the east pixel (110,159).
  const east = store.sceneSites(110, 159).find((x) => x.prefab === 'Test_Rocks');
  assert.ok(east, 'overlapping rock field drawn from the neighbour');
  assert.equal(east.pixel.join(), '109,159');
  assert.ok(east.anchor[0] < -409.6 + 20, 'anchored just across the west edge');
  assert.equal(east.sink, 0.5);
  assert.equal(east.scale, 2);
  store.nearby(109, 159, 6);
  store.nearby(110, 158, 6);
  assert.ok(store.status().residentFolders <= 1, 'only the most recent folder stays resident');
  assert.ok(store.status().folderLoads >= 2);
});

test('HTTP: public scene descriptor only; invalid ids and missing data are refused', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = setup({ root });
  await s.wild.ready;
  const svc = s.rt.ctx.services.wilderness;
  const server = createServer((req, res) => {
    if (!handleWildernessScene(req.url.includes('nosvc') ? null : svc, req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}${WILDERNESS_SCENE_PATH}`;
  const ok = await fetch(`${base}?location=wilderness:109,160`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /application\/json/);
  const body = await ok.json();
  assert.equal(body.id, 'wilderness:109,160');
  assert.equal(JSON.stringify(body), JSON.stringify(svc.scene('wilderness:109,160')));
  assert.ok(!JSON.stringify(body).includes(root), 'no server paths leak');
  assert.equal((await fetch(`${base}?location=wilderness:5,5`)).status, 200, 'empty pixels render too');
  for (const bad of ['wilderness:1000,1', '../../Locations/Daggerfall/Daggerfall_Locations.csv', '', 'town:Daggerfall/Daggerfall']) {
    assert.equal((await fetch(`${base}?location=${encodeURIComponent(bad)}`)).status, 400, bad);
  }
  assert.equal((await fetch(`${base}?location=wilderness:1,1&nosvc=1`)).status, 503);
  assert.equal((await fetch(`${base}?location=wilderness:1,1`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base.replace('/scene', '/Locations')}`)).status, 404, 'no other paths are handled');
});

test('spawn inside solid geometry moves to the nearest clear spot once collision settles', async (t) => {
  const root = fixtureTree();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let settle;
  const settled = new Promise((r) => (settle = r));
  const collision = (ctx) => {
    ctx.services.collision = {
      preload() {},
      whenSettled: () => settled,
      isClear: (loc, x, z) => z > -200, // the spawn (z ~ -232) is inside a solid
      nearestClear: (loc, x, z) => ({ x, z: -199.5 }),
    };
  };
  const s = setup({ root, features: [collision] });
  await s.wild.ready;
  const a = s.add(1), b = s.add(2);
  for (const p of [a, b]) assert.equal(s.rt.act(p, 'wilderness.visit', { site: 'wod:109,160:21,107' }).ok, true);
  b.x += 1; // b already walked away: left alone
  const bx = b.x, bz = b.z;
  settle({ status: 'ready' });
  await settled;
  await new Promise((r) => setImmediate(r));
  assert.equal(a.z, -199.5);
  assert.deepEqual([b.x, b.z], [bx, bz]);
});
