// Brief C acceptance on the operator's installed data (docs/world-expansion-plan.md):
// one exterior surface shared by a town, its map pixel and the neighbouring pixels.
//
//   * town -> pixel -> global -> town round trips (ordinary Gothway Garden, 8x8 Daggerfall,
//     the 3x3 Port of Daggerfall replacement with the pack on and the classic 1x1 with it off)
//   * a diagonal pixel corner has one height and one owner from all four pixels
//   * the browser's wilderness ground and the server's collision surface agree within 0.1 m,
//     and the native town street sits on that same surface
//   * gates are walkable and the walls beside them block from both sides of the town edge,
//     in the town's own collision world and in the pixel worlds on either side of a seam
//
// Skipped when ARENA2 is not installed. The Port cases also need the World of Daggerfall pack.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from '../server/game.js';
import { fileURLToPath } from 'node:url';
import { arena2Files, arena2Loader } from '../server/rpg/collision/arena2.js';
import { serverWorldData } from '../server/rpg/wilderness/replacements.js';
import { loadTown } from '../client/world/town.js';
import { worldFromTown } from '../client/gameplay/collision/world.js';
import { buildWildernessScene } from '../client/world/wilderness/scene.js';
import { readCatalog } from '../client/gameplay/travel/catalog.js';
import * as models from '../client/world/wilderness/models.js';
import {
  HALF, PIXEL, townFrame, townToWild, wildToTown, toGlobal, fromGlobal, inPixel, townMeshOffset, exteriorObjectKey,
} from '../client/world/exterior/frame.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const ARENA2 = ['gamedata/DaggerfallGameFiles/arena2', 'gamedata/DaggerfallGameFiles/ARENA2'].map((d) => root + d).find((d) => existsSync(d));
const WOD = root + 'gamedata/world-of-daggerfall';
const HAVE_WOD = existsSync(WOD);

const GOTHWAY = { region: 17, index: 197, px: 109, py: 159, width: 4, height: 3 };
const DAGGERFALL = { region: 17, index: 1231, px: 207, py: 213, width: 8, height: 8 };
const PORT = { region: 17, index: 1246, px: 207, py: 214, width: 3, height: 3 };

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

describe('exterior surface on installed data', { skip: !ARENA2 && 'operator ARENA2 is not installed' }, () => {
  let files, wd, catalog, load;
  const worlds = new Map();
  const towns = new Map();
  /** The server's collision world for a location, loaded once. */
  const surface = (id) => {
    if (!worlds.has(id)) worlds.set(id, load(id).then((r) => r.world));
    return worlds.get(id);
  };
  /** Native town (the same mesh a town player walks on) and its frame. */
  const town = (t, pack = true) => {
    const key = `${t.region}/${t.index}/${pack}`;
    if (!towns.has(key)) {
      towns.set(key, loadTown(files, { region: t.region, location: t.index, worldData: pack ? wd : null }).then((mesh) => {
        const s = mesh.source;
        const custom = s.width === 1 && s.height === 1 && /^CUST/i.test(s.blocks?.[0]?.name ?? '');
        const frame = townFrame({ id: key, px: t.px, py: t.py, width: s.width, height: s.height, spawnLocal: s.spawnLocal, custom });
        return { mesh, frame, world: worldFromTown(mesh) };
      }));
    }
    return towns.get(key);
  };
  /** A straight walk the server would accept: reaches its end and ends clear. */
  const walks = (w, x0, z0, x1, z1) => {
    const m = w.move(x0, z0, x1, z1);
    return Math.hypot(m.x - x1, m.z - z1) < 0.001 && w.isClear(x1, z1, m.y);
  };
  const absolute = (w, x, z) => w.standHeight(x, z) + w.datum;
  /** Walls and gates only: solid flats (client/world/scenery/colliders.js) are set aside for the lane checks. */
  const wallsOnly = (w, fn) => {
    const posts = w.posts;
    w.posts = null;
    try { return fn(); } finally { w.posts = posts; }
  };

  before(async () => {
    files = await arena2Files(ARENA2);
    wd = HAVE_WOD ? await serverWorldData(WOD, { log: { warn() {} } }) : null;
    catalog = await readCatalog(files.find((f) => /^MAPS\.BSA$/i.test(f.name)), wd);
    load = arena2Loader(ARENA2, { worldData: { ready: Promise.resolve(wd) } });
  });

  test('catalogue records sit on the expected pixels', () => {
    for (const t of [GOTHWAY, DAGGERFALL, PORT]) {
      const e = catalog.at(t.region, t.index);
      assert.deepEqual([e.x, e.y], [t.px, t.py], `${t.region}/${t.index}`);
      assert.equal(catalog.atPixel(t.px, t.py).index, t.index);
    }
    // Stable object keys name the owning pixel and source record, whichever pixel looks at them.
    assert.equal(exteriorObjectKey(207, 214, 'town', 17, 1246), 'pixel:207,214/town/17/1246');
  });

  for (const [label, t, pack] of [
    ['ordinary Gothway Garden', GOTHWAY, true],
    ['8x8 Daggerfall', DAGGERFALL, true],
    ['3x3 Port of Daggerfall replacement', PORT, true],
    ['classic Copperfield Manor (pack off)', PORT, false],
  ]) {
    test(`${label}: town -> pixel -> global -> town round trip`, { skip: pack && t === PORT && !HAVE_WOD && 'pack not installed' }, async () => {
      const { frame: f } = await town(t, pack);
      if (t === PORT) assert.deepEqual([f.width, f.height], pack ? [3, 3] : [1, 1]);
      else assert.deepEqual([f.width, f.height], [t.width, t.height]);
      // The block grid is centred in its pixel and lies inside it.
      assert.ok(f.rect.minX >= -HALF - 1e-9 && f.rect.maxX <= HALF + 1e-9 && f.rect.minZ >= -HALF - 1e-9 && f.rect.maxZ <= HALF + 1e-9);
      if (!f.custom) near(f.rect.minX + f.rect.maxX, 0, 1e-9, 'centred east-west');
      const w = f.walk;
      for (const [x, z] of [[0, 0], [w.minX, w.minZ], [w.maxX, w.maxZ], [w.minX, w.maxZ], [w.maxX - 0.001, w.minZ + 0.001], [12.345, -67.891]]) {
        const q = townToWild(f, x, z);
        const g = toGlobal(f.px, f.py, q.x, q.z);
        const back = fromGlobal(g.e, g.s);
        // A point exactly on the far pixel edge belongs to the next pixel; convert it through its own owner.
        const r = inPixel(f.px, f.py, g.e, g.s);
        const local = wildToTown(f, r.x, r.z);
        near(local.x, x, 1e-6, 'x');
        near(local.z, z, 1e-6, 'z');
        assert.ok(Math.abs(back.px - f.px) <= 1 && Math.abs(back.py - f.py) <= 1);
        const again = toGlobal(back.px, back.py, back.x, back.z);
        near(again.e, g.e, 1e-6, 'e');
        near(again.s, g.s, 1e-6, 's');
      }
    });
  }

  test('a diagonal pixel corner has one owner and one height from all four pixels', async () => {
    // North-west corner of Gothway Garden's pixel.
    const c = toGlobal(GOTHWAY.px, GOTHWAY.py, -HALF, -HALF);
    assert.deepEqual(fromGlobal(c.e, c.s), { px: GOTHWAY.px, py: GOTHWAY.py, x: -HALF, z: -HALF });
    const o = fromGlobal(c.e - 1e-6, c.s - 1e-6);
    assert.deepEqual([o.px, o.py], [GOTHWAY.px - 1, GOTHWAY.py - 1]);
    const pixels = [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([dx, dy]) => [GOTHWAY.px + dx, GOTHWAY.py + dy]);
    const loaded = await Promise.all(pixels.map(([x, y]) => surface(`wilderness:${x},${y}`)));
    const samples = [[0, 0], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7], [-3.2, 1.1], [2.5, -4.0]];
    let worst = 0;
    for (const [de, ds] of samples) {
      const hs = loaded.map((w, i) => {
        const l = inPixel(pixels[i][0], pixels[i][1], c.e + de, c.s + ds);
        return absolute(w, l.x, l.z);
      });
      for (const h of hs) worst = Math.max(worst, Math.abs(h - hs[0]));
    }
    assert.ok(worst < 0.01, `corner heights differ by ${worst} m`);
  });

  test('browser ground and server collision agree within 0.1 m; the town street sits on it', async () => {
    let checked = 0, worst = 0;
    for (const t of [GOTHWAY, DAGGERFALL]) {
      const id = `wilderness:${t.px},${t.py}`;
      const [server, browser, { frame: f, world: tw, mesh }] = await Promise.all([
        surface(id),
        buildWildernessScene({ files, location: id, models, worldData: wd, nature: false }),
        town(t),
      ]);
      const placed = browser.wilderness.towns.find((p) => p.px === t.px && p.py === t.py);
      assert.ok(placed, 'the scene lists the town in its pixel');
      assert.equal(placed.key, exteriorObjectKey(t.px, t.py, 'town', t.region, t.index));
      const off = townMeshOffset(placed, mesh.source, browser.wilderness);
      for (let x = -HALF + 3; x < HALF; x += 37.3) {
        for (let z = -HALF + 3; z < HALF; z += 41.9) {
          if (!server.isClear(x, z)) continue; // inside a building: no open surface to compare
          const b = browser.wilderness.absoluteHeightAt(x, z);
          const s = absolute(server, x, z);
          worst = Math.max(worst, Math.abs(b - s));
          near(s, b, 0.1, `${id} (${x.toFixed(1)}, ${z.toFixed(1)})`);
          checked++;
          // Inside the town rect, the native street (town frame) is the same surface.
          const l = wildToTown(f, x, z), w = f.walk;
          if (l.x > w.minX + 1 && l.x < w.maxX - 1 && l.z > w.minZ + 1 && l.z < w.maxZ - 1 && tw.isClear(l.x, l.z)) {
            near(tw.standHeight(l.x, l.z) + off.y + browser.wilderness.datum, s, 0.1, `${t.index} street`);
          }
        }
      }
    }
    assert.ok(checked > 300, `only ${checked} open samples`);
    console.log(`# height parity: ${checked} samples, worst ${worst.toFixed(4)} m`);
  });

  /** For each lane along a town's north edge: [townX, fromInside, outFromPixel, inFromPixel, outFromNeighbour?, inFromNeighbour?]. */
  async function northLanes(t, depth) {
    const { frame: f, world: tw } = await town(t);
    const here = await surface(`wilderness:${t.px},${t.py}`);
    const seam = f.rect.minZ <= -HALF + 1e-6;
    const north = seam ? await surface(`wilderness:${t.px},${t.py - 1}`) : null;
    // A tree standing on the town edge is a real obstacle for the lane that crosses it; these
    // lanes compare walls and gates, so flats are set aside here and checked by their own test.
    return wallsOnly(tw, () => wallsOnly(here, () => (north ? wallsOnly(north, () => lanesOf(t, f, tw, here, north, depth)) : lanesOf(t, f, tw, here, north, depth))));
  }

  function lanesOf(t, f, tw, here, north, depth) {
    const w = f.walk, out = [];
    for (let x = w.minX + 1; x < w.maxX - 1; x += 2) {
      const lane = [x, walks(tw, x, w.minZ + depth, x, w.minZ + 0.5)];
      const A = townToWild(f, x, w.minZ + depth), B = townToWild(f, x, w.minZ - 8);
      lane.push(walks(here, A.x, A.z, B.x, B.z), walks(here, B.x, B.z, A.x, A.z));
      if (north) {
        const ga = toGlobal(t.px, t.py, A.x, A.z), gb = toGlobal(t.px, t.py, B.x, B.z);
        const a = inPixel(t.px, t.py - 1, ga.e, ga.s), b = inPixel(t.px, t.py - 1, gb.e, gb.s);
        lane.push(walks(north, a.x, a.z, b.x, b.z), walks(north, b.x, b.z, a.x, a.z));
      }
      out.push(lane);
    }
    return out;
  }

  /** Every lane agrees from every side; returns an open lane next to a blocked one. */
  function gateBesideWall(lanes, label) {
    for (const [x, ...ways] of lanes) assert.ok(ways.every((v) => v === ways[0]), `${label} lane x=${x.toFixed(1)} disagrees: ${ways}`);
    for (let i = 1; i < lanes.length; i++) {
      const [x0, a] = lanes[i - 1], [x1, b] = lanes[i];
      if (a !== b) return { gate: a ? x0 : x1, wall: a ? x1 : x0 };
    }
    assert.fail(`${label}: no gate beside a wall on the north edge`);
  }

  test("Gothway Garden's solid flats stand at the same place in the town and in its pixel", async () => {
    const { mesh, world: tw } = await town(GOTHWAY);
    const here = await surface(`wilderness:${GOTHWAY.px},${GOTHWAY.py}`);
    assert.ok(tw.posts?.count > 100, `town posts: ${tw.posts?.count}`);
    const browser = await buildWildernessScene({ files, location: `wilderness:${GOTHWAY.px},${GOTHWAY.py}`, models, worldData: wd, geometryOnly: true });
    const p = browser.wilderness.towns.find((q) => q.px === GOTHWAY.px && q.py === GOTHWAY.py);
    const off = townMeshOffset(p, mesh.source, browser.wilderness);
    const c = mesh.colliders.cylinders;
    let found = 0;
    for (let i = 0; i < c.length; i += 5) {
      const x = c[i] + off.x, z = c[i + 1] + off.z;
      const n = here.posts.gather(x - 0.01, z - 0.01, x + 0.01, z + 0.01);
      for (let k = 0; k < n; k++) {
        const o = here.posts.cand[k] * 5;
        if (Math.abs(here.posts.c[o] - x) < 1e-3 && Math.abs(here.posts.c[o + 1] - z) < 1e-3 && Math.abs(here.posts.c[o + 4] - c[i + 4]) < 1e-6) { found++; break; }
      }
    }
    assert.equal(found, c.length / 5, 'every town post is in the pixel world');
  });

  test('ordinary Gothway Garden: north lanes open and blocked the same from town and wilderness', async () => {
    const lanes = await northLanes(GOTHWAY, 30);
    const { gate, wall } = gateBesideWall(lanes, 'Gothway');
    assert.ok(Math.abs(gate - wall) <= 2);
    assert.ok(lanes.filter((l) => l[1]).length >= 20, 'several open lanes');
  });

  test('8x8 Daggerfall: the north gate opens through the wall from the city, its pixel and the pixel north', async () => {
    const lanes = await northLanes(DAGGERFALL, 100);
    assert.equal(lanes[0].length, 6, 'the city edge is the pixel seam, so both pixel worlds are checked');
    gateBesideWall(lanes, 'Daggerfall');
    // The wall runs most of the edge; the gate is a short opening between the open corner strips.
    const open = lanes.map((l) => l[1]);
    const runs = [];
    for (let i = 0; i < open.length; i++) if (open[i] && !open[i - 1]) runs.push(i);
    assert.ok(runs.length >= 3, `corners plus at least one gate (${runs.length} open runs)`);
    const blocked = open.filter((v) => !v).length;
    assert.ok(blocked > open.length / 2, 'the city wall blocks most of the edge');
  });

  test('3x3 Port of Daggerfall: lanes agree from the port and from its pixel', { skip: !HAVE_WOD && 'pack not installed' }, async () => {
    const lanes = await northLanes(PORT, 30);
    gateBesideWall(lanes, 'Port');
  });
});

// The World of Daggerfall Bandit Camp in Privateer's Hold's pixel (site wod:109,158:21,21), through the
// production game server: pack descriptors and ARENA2 models feed the server's wilderness collision.
describe('WoD camp models are solid on the server (wilderness:109,158)', { skip: (!ARENA2 || !HAVE_WOD) && 'ARENA2 or the pack is not installed' }, () => {
  const ID = 'wilderness:109,158';
  let server, s, dir;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exterior-camp-'));
    server = createGameServer({ arena2Dir: ARENA2, host: '127.0.0.1', port: 0, dbPath: join(dir, 'game.db'), worldHalfExtent: 1024 });
    s = server.runtime.ctx.services;
    await s.wilderness.ready;
    assert.equal(s.wilderness.status().pack, 'ready');
    assert.equal((await s.collision.whenSettled(ID)).status, 'ready');
  });
  after(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Hold a heading through the authoritative per-tick movement (0.16 m per 40 ms tick). */
  const hold = (x, z, vx, vz, ticks = 250) => {
    const p = { id: `probe${x},${z}`, x, z, rpg: { location: ID } };
    for (let i = 0; i < ticks; i++) {
      const m = s.movePlayer(p, p.x + vx * 0.16, p.z + vz * 0.16);
      p.x = m.x;
      p.z = m.z;
    }
    return p;
  };

  test('the camp descriptor places its rocks and models in the pixel frame', () => {
    const sc = s.wilderness.scene(ID);
    const camp = sc.sites.find((site) => site.id === 'wod:109,158:21,21');
    assert.ok(camp, 'Bandit Camp site');
    const rock = camp.objects.find((o) => o.objectID === 9);
    assert.equal(rock.kind, 'model');
    assert.equal(rock.model, 60710);
    assert.deepEqual(rock.position.map((v) => Math.round(v * 100) / 100), [-261.98, 4.79, 276.69]);
  });

  test('walking into a camp rock from either side stops at its face, never through it', () => {
    const [ox, oz] = [-261.98, 276.69];
    const east = hold(ox + 20, oz, -1, 0);
    const west = hold(ox - 20, oz, 1, 0);
    assert.ok(east.x > ox + 2, `held east of the rock (x ${east.x.toFixed(2)})`);
    assert.ok(west.x < ox - 2, `held west of the rock (x ${west.x.toFixed(2)})`);
    // Sliding along the face is allowed; ending inside the rock is not.
    assert.ok(s.collision.isClear(ID, east.x, east.z) && s.collision.isClear(ID, west.x, west.z));
    console.log(`# camp rock 60710 at (${ox}, ${oz}): east approach held at (${east.x.toFixed(2)}, ${east.z.toFixed(2)}), west at (${west.x.toFixed(2)}, ${west.z.toFixed(2)})`);
  });

  test('most of the camp models block a straight walk across their origin', () => {
    const camp = s.wilderness.scene(ID).sites.find((site) => site.id === 'wod:109,158:21,21');
    let blocked = 0, total = 0;
    for (const o of camp.objects) {
      if (o.kind !== 'model') continue;
      const [x, , z] = o.position;
      total++;
      if (!s.collision.canWalkSegment(ID, x - 4, z, x + 4, z)) blocked++;
    }
    assert.ok(total >= 20 && blocked === total, `${blocked}/${total} camp models block`);
  });
});
