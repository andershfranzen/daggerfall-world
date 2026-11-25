// The navigable coast (server/rpg/sailing/coast.js, sea.js) and its shared chart (client/world/sea/chart.js).
// The practice-sea cases need no game data. The Iliac Bay cases run against the operator's installed ARENA2 files
// when they are present (DAGGERFALL_DATA or gamedata/DaggerfallGameFiles/arena2) and are skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createCoast, quayInTown, BERTH_CLEAR_M, CHART_METRES } from '../server/rpg/sailing/coast.js';
import { realSource, seaModel, straighten, pixelsCrossed } from '../server/rpg/sailing/sea.js';
import { traceLand, simplifyRing, ringArea, fitView, toChart, fromChart, headingOf, yawOf, FALLBACK_SEA } from '../client/world/sea/chart.js';
import { townFrame, townToWild } from '../client/world/exterior/frame.js';

const DATA = process.env.DAGGERFALL_DATA ?? new URL('../gamedata/DaggerfallGameFiles/arena2', import.meta.url).pathname;
const hasData = existsSync(DATA);
const quiet = { info() {}, warn() {} };

test('chart projection keeps axes and yaw: x east, z south, yaw 0 north', () => {
  const c = toChart(819.2 * 3, 819.2 * 5);
  assert.ok(Math.abs(c.u - 3) < 1e-12 && Math.abs(c.v - 5) < 1e-12);
  assert.deepEqual(fromChart(3, 5), { x: 819.2 * 3, z: 819.2 * 5 });
  const n = headingOf(0), e = headingOf(Math.PI / 2);
  assert.ok(Math.abs(n.x) < 1e-12 && n.z === -1);
  assert.ok(Math.abs(e.x - 1) < 1e-12 && Math.abs(e.z) < 1e-12);
  assert.ok(Math.abs(yawOf(1, 0) - Math.PI / 2) < 1e-12);
  assert.equal(yawOf(0, -1), 0);
  const v = fitView({ u0: 0, v0: 0, u1: 10, v1: 5 }, 200, 100, 0);
  assert.deepEqual(v.toScreen(10, 5), [200, 100]);
  assert.deepEqual(v.toChart(100, 50), [5, 2.5]);
});

test('traceLand closes land rings, keeps diagonal islands apart, and simplifies', () => {
  const grid = ['.....', '.##..', '.##..', '...#.', '.....'];
  const land = (x, y) => grid[y]?.[x] === '#';
  const rings = traceLand(land, 0, 0, 5, 5);
  assert.equal(rings.length, 2);
  const areas = rings.map((r) => ringArea(r)).sort((a, b) => a - b);
  assert.deepEqual(areas, [1, 4]); // clockwise on screen: land on the right
  assert.ok(simplifyRing(rings[0], 0.5).length >= 3);
});

test('straighten keeps the first and last point and only joins what holds', () => {
  const pts = [0, 1, 2, 3, 4].map((i) => ({ x: i, z: i === 2 ? 1 : 0 }));
  assert.deepEqual(straighten(pts, () => true), [pts[0], pts[4]]);
  const out = straighten(pts, (p, q) => Math.abs(pts.indexOf(q) - pts.indexOf(p)) <= 2);
  assert.equal(out[0], pts[0]);
  assert.equal(out[out.length - 1], pts[4]);
  const seen = [];
  pixelsCrossed({ x: 100, z: 100 }, { x: 819.2 * 2 + 100, z: 100 }, (x, y) => (seen.push([x, y]), true));
  assert.deepEqual(seen, [[0, 0], [1, 0], [2, 0]]);
});

test('practice sea: labelled fallback with berths on water, dry quays and water-bound routes', async (t) => {
  const coast = createCoast({ log: quiet });
  t.after(() => coast.close());
  assert.equal(coast.status, 'loading');
  await coast.ready;
  assert.equal(coast.status, 'ready');
  assert.equal(coast.world.fallback, true);
  assert.match(coast.world.label, /not Daggerfall/);
  const listed = coast.ports();
  assert.equal(listed.length, FALLBACK_SEA.ports.length);
  assert.ok(listed.every((p) => p.berthReady === false), 'nothing planned until asked');
  const ports = await coast.allHarbours();
  assert.ok(ports.every((p) => p && p.berthReady === true));
  for (const p of ports) {
    assert.ok(p.id.startsWith('fallback:') && p.fallback === true, p.id);
    assert.ok(coast.isWater(p.x, p.z), `${p.name} berth on water`);
    assert.ok(coast.clearanceAt(p.x, p.z) >= BERTH_CLEAR_M, `${p.name} berth clear of land`);
    assert.ok(!coast.isWater(p.quay.x, p.quay.z), `${p.name} quay ashore`);
    assert.ok(coast.isWater(p.approach.x, p.approach.z));
    assert.ok(Math.hypot(p.quay.x - p.x, p.quay.z - p.z) < 80, 'quay beside the berth');
    // The berth's yaw looks out to sea.
    const h = headingOf(p.yaw);
    assert.ok(coast.clearanceAt(p.x + h.x * 12.8, p.z + h.z * 12.8) >= coast.clearanceAt(p.x - h.x * 6.4, p.z - h.z * 6.4));
  }
  const [a, b] = [ports[0].id, ports[1].id];
  const [r1, r2] = await Promise.all([coast.routeAsync(a, b), coast.routeAsync(a, b)]);
  assert.ok(r1 && r1 === r2, 'one computation for concurrent requests');
  assert.equal(coast.route(a, b), r1, 'cached route answers synchronously');
  assert.deepEqual(r1.points[0], { x: ports[0].x, z: ports[0].z });
  assert.deepEqual(r1.points.at(-1), { x: ports[1].x, z: ports[1].z });
  assert.ok(r1.legs.some((l) => l.kind === 'open') && r1.legs.some((l) => l.kind === 'harbour'));
  for (const l of r1.legs) assert.ok(coast.segmentClear(l.a.x, l.a.z, l.b.x, l.b.z).ok, 'every leg on water');
  assert.ok(r1.days > 0 && r1.leagues > 0);
  assert.equal(await coast.routeAsync(a, 'fallback:Nowhere'), null);
  assert.equal(coast.reachable(a, b), true);
  assert.equal(coast.reachable(a, a), false);
  const chart = await coast.chartAsync();
  assert.equal(chart.world.fallback, true);
  assert.equal(chart.projection.metresPerUnit, CHART_METRES);
  assert.ok(chart.coast.length >= 3, 'both shores and an island');
  assert.equal(chart.ports.length, ports.length);
  assert.ok(JSON.stringify(chart).length < 20000);
  assert.ok((await coast.outlinesNearAsync(ports[0].x, ports[0].z, 5000)).length >= 1);
  const near = await coast.shoreNear(ports[0].x, ports[0].z, 2500);
  assert.ok(near.rings.length >= 1 && near.rings.every((r) => r.ring.length >= 3 && ['land', 'island'].includes(r.kind)));
  assert.ok(near.ports.some((q) => q.id === ports[0].id && q.kind === 'harbor'));
  assert.equal(await coast.shoreNear(ports[0].x + 10, ports[0].z, 2500), near, 'cached per window cell');
});

test('practice sea: segmentClear refuses land and reports where', async (t) => {
  const coast = createCoast({ log: quiet });
  t.after(() => coast.close());
  await coast.ready;
  // Straight north from mid-sound runs onto the northern shore.
  const x = 24 * CHART_METRES, z = 16 * CHART_METRES;
  assert.ok(coast.isWater(x, z));
  const r = coast.segmentClear(x, z, x, 2 * CHART_METRES);
  assert.equal(r.ok, false);
  assert.ok(r.hitAt.z < z && r.hitAt.z > 2 * CHART_METRES);
  assert.equal(coast.isWater(NaN, 0), false);
  assert.equal(coast.segmentClear(0, 0, NaN, 0).ok, false);
});

test('quayInTown converts a global quay into the town frame', () => {
  const port = { px: 10, py: 20, block: { width: 2, height: 2, custom: false }, quay: { x: 10 * 819.2 + 500, z: 20 * 819.2 + 300, yaw: 1 } };
  const spawnLocal = { x: 40, z: 60 };
  const q = quayInTown(port, spawnLocal);
  const f = townFrame({ px: 10, py: 20, width: 2, height: 2, spawnLocal });
  const w = townToWild(f, q.x, q.z);
  assert.ok(Math.abs(w.x - (500 - 409.6)) < 1e-9 && Math.abs(w.z - (300 - 409.6)) < 1e-9);
  assert.equal(q.yaw, 1);
});

test('Iliac Bay: Daggerfall, Wayrest and Sentinel harbours and their sea routes', { skip: !hasData && 'no installed game data', timeout: 120000 }, async (t) => {
  const names = ['Daggerfall', 'Wayrest', 'Sentinel'];
  const coast = createCoast({ dataPath: DATA, filterNames: names, log: quiet });
  t.after(() => coast.close());
  await coast.ready;
  assert.equal(coast.world.id, 'iliac-bay');
  assert.equal(coast.world.fallback, false);
  const id = (n) => `town:${n}/${n}`;
  const ports = await Promise.all(names.map((n) => coast.whenPort(id(n))));
  const src = await realSource(DATA, { ports: false });
  const exact = seaModel(src, { maxPixels: 64 }); // a second model: the same tiles, an independent cache
  for (const p of ports) {
    assert.ok(p, 'a harbour');
    assert.ok(p.besideShore);
    assert.ok(exact.isWater(p.x, p.z) && exact.clearanceAt(p.x, p.z) >= BERTH_CLEAR_M, `${p.name} berth`);
    assert.ok(!exact.isWater(p.quay.x, p.quay.z), `${p.name} quay ashore`);
    // Within two map pixels of the town.
    assert.ok(Math.abs(Math.floor(p.x / CHART_METRES) - p.px) <= 2 && Math.abs(Math.floor(p.z / CHART_METRES) - p.py) <= 2);
  }
  const dryTiles = (route) => {
    let dry = 0;
    for (const l of route.legs) {
      const n = Math.max(1, Math.ceil(l.metres / 3.2));
      for (let k = 0; k <= n; k++) if (!exact.isWater(l.a.x + ((l.b.x - l.a.x) * k) / n, l.a.z + ((l.b.z - l.a.z) * k) / n)) dry++;
    }
    return dry;
  };
  assert.equal(coast.reachable(id('Daggerfall'), id('Wayrest')), true);
  assert.equal(coast.reachable(id('Daggerfall'), 'town:Nowhere/Nowhere'), false);
  assert.equal(coast.portOf('town:Nowhere/Nowhere'), null);
  const ds = await coast.routeAsync(id('Daggerfall'), id('Sentinel'));
  assert.ok(ds, 'Daggerfall to Sentinel');
  assert.equal(dryTiles(ds), 0);
  assert.ok(ds.metres > 150000 && ds.metres < 260000, `${ds.metres}`);
  const sw = await coast.routeAsync(id('Sentinel'), id('Wayrest'));
  assert.ok(sw && dryTiles(sw) === 0);
  assert.ok(sw.metres > ds.metres);
  // Real chart: the Bay's coasts and islands, light enough to send.
  const chart = await coast.chartAsync({ view: { u0: 180, v0: 180, u1: 900, v1: 380 } });
  assert.ok(chart.coast.length > 10);
  assert.ok(JSON.stringify(chart).length < 120000);
});

// Shutdown: run in a child process so a coast that held the event loop open shows up as a timeout.
import { spawnSync } from 'node:child_process';
const runChild = (body) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { createCoast } from ${JSON.stringify(new URL('../server/rpg/sailing/coast.js', import.meta.url).href)};
  ${body}
`], { encoding: 'utf8', timeout: 30000 });

test('close settles outstanding work at once and the process exits (worker thread)', () => {
  const r = runChild(`
    const coast = createCoast({ worker: true, log: { info() {}, warn() {} } });
    await coast.ready;
    const ids = coast.ports().map((p) => p.id);
    const work = [coast.whenPort(ids[0]), coast.routeAsync(ids[0], ids[1]), coast.shoreNear(0, 0), coast.chartAsync()];
    coast.close();
    const out = await Promise.all(work);
    const after = await Promise.all([coast.whenPort(ids[2]), coast.routeAsync(ids[1], ids[2])]);
    console.log(JSON.stringify({ closed: coast.closed, port: out[0], route: out[1], after, water: typeof coast.isWater(0, 0) }));
  `);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.trim().split('\\n').pop());
  assert.equal(o.closed, true);
  assert.equal(o.port, null);
  assert.equal(o.route, null);
  assert.deepEqual(o.after, [null, null]);
  assert.equal(o.water, 'boolean');
});

test('an idle coast with a live worker does not keep the process alive', () => {
  const r = runChild(`
    const coast = createCoast({ worker: true, log: { info() {}, warn() {} } });
    await coast.ready;
    const p = await coast.whenPort(coast.ports()[0].id);
    console.log(p.berthReady);
  `);
  assert.equal(r.status, 0, r.stderr || 'timed out: the worker held the process');
  assert.equal(r.stdout.trim(), 'true');
});
