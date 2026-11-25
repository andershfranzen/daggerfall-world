// World of Daggerfall against the operator-installed source tree (gamedata/world-of-daggerfall or $WOD_PATH).
// Skipped when the tree is not installed. Nothing from the tree is copied into the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWodStore } from '../server/rpg/wilderness/store.js';
import { composeScene, headingOf, parseInstanceCsv } from '../client/world/wilderness/data.js';

const ROOT = process.env.WOD_PATH || fileURLToPath(new URL('../gamedata/world-of-daggerfall', import.meta.url));
const installed = existsSync(join(ROOT, 'Locations')) && existsSync(join(ROOT, 'WorldOfDaggerfall.dfmod.json'));
const skip = installed ? false : 'World of Daggerfall is not installed (gamedata/world-of-daggerfall or WOD_PATH)';
const quiet = { info() {}, warn() {}, error() {} };
const PREFIX = 'Assets/Game/Mods/world-of-daggerfall/';

let shared;
async function store() {
  if (!shared) {
    shared = createWodStore({ root: ROOT, maxFolders: 4, log: quiet });
    await shared.init();
  }
  return shared;
}

const bundled = () => JSON.parse(readFileSync(join(ROOT, 'WorldOfDaggerfall.dfmod.json'), 'utf8')).Files.filter((f) => f.startsWith(PREFIX)).map((f) => f.slice(PREFIX.length));

const rowsOf = (paths) => {
  const counts = new Map();
  for (const p of paths) {
    for (const i of parseInstanceCsv(readFileSync(join(ROOT, p), 'utf8')).instances) {
      const k = [i.prefab, i.worldX, i.worldY, i.terrainX, i.terrainY].join('|');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
};

test('bundle authority: every published location file and prefab, nothing else', { skip }, async () => {
  const s = await store();
  const st = s.status();
  const files = bundled();
  const csvs = files.filter((f) => /^Locations\/.*\.csv$/i.test(f));
  const prefabs = files.filter((f) => /^Locations\/LocationPrefab\/.*\.txt$/i.test(f));
  assert.equal(st.pack, 'ready');
  assert.equal(st.source, 'bundle');
  assert.equal(st.files, csvs.length);
  assert.equal(st.prefabs, prefabs.length);
  assert.equal(st.skippedRows, 0);
  let rows = 0;
  for (const f of csvs) rows += parseInstanceCsv(readFileSync(join(ROOT, f), 'utf8')).instances.length;
  assert.equal(st.instances, rows);
  assert.ok(!csvs.some((f) => f.includes('/Development/')), 'Development is not published');
});

test('CombinedCSVs: scenery families equal the bundled region rows; Locations is a different generation', { skip }, async () => {
  const files = bundled();
  for (const fam of ['Rocks', 'BorderTowers', 'BannerPosts', 'Mountains', 'Mountains_Foothills', 'Mountains_Small']) {
    const region = files.filter((f) => new RegExp(`^Locations/[^/]+/[^/]+_${fam}\\.csv$`).test(f));
    assert.ok(region.length > 0, fam);
    assert.deepEqual(rowsOf([`CombinedCSVs/${fam}.csv`]), rowsOf(region), fam);
  }
  // The combined Locations.csv predates the published placements: most of its rows are not in the bundle.
  const combined = rowsOf(['CombinedCSVs/Locations.csv']);
  const published = rowsOf(files.filter((f) => /^Locations\/[^/]+\/[^/]+_Locations\.csv$/.test(f)));
  let shared = 0;
  for (const k of combined.keys()) if (published.has(k)) shared++;
  assert.ok(shared < combined.size / 10, `only ${shared} of ${combined.size} combined rows are published`);
});

test('a published border tower: exact pixel, anchor and 180 degree rotation', { skip }, async () => {
  const s = await store();
  const [row] = parseInstanceCsv(readFileSync(join(ROOT, 'Locations/Daggerfall/Daggerfall_BorderTowers.csv'), 'utf8')).instances;
  const sites = s.sceneSites(row.worldX, row.worldY);
  const site = sites.find((x) => x.tile.x === row.terrainX && x.tile.y === row.terrainY && x.prefab === row.prefab);
  assert.ok(site, 'placed');
  assert.equal(site.id, `wod:${row.worldX},${row.worldY}:${row.terrainX},${row.terrainY}`);
  assert.deepEqual(site.pixel, [row.worldX, row.worldY]);
  assert.deepEqual(site.anchor, [Math.round((row.terrainX * 6.4 - 409.6) * 1e4) / 1e4, 0, Math.round((409.6 - row.terrainY * 6.4) * 1e4) / 1e4]);
  assert.ok(Math.abs(Math.abs(headingOf(row.rot)) - Math.PI) < 1e-6, 'rotYaxis 180 faces south');
  assert.ok(Math.abs(Math.abs(site.yaw) - Math.PI) < 1e-6);
  assert.ok(site.objects.length > 0);
  for (const o of site.objects) assert.ok([...o.position, ...(o.matrix ?? [])].every(Number.isFinite));
});

test('Gothway Garden: nearby points of interest in Daggerfall, deterministic across stores', { skip }, async () => {
  const s = await store();
  const near = s.nearby(109, 159, 6);
  assert.ok(near.length >= 5, `found ${near.length}`);
  assert.ok(near.every((n) => n.poi && n.distance <= 6));
  assert.ok(near.some((n) => n.region === 'Daggerfall'));
  const other = createWodStore({ root: ROOT, maxFolders: 1, log: quiet });
  await other.init();
  assert.deepEqual(other.nearby(109, 159, 6), near);
  const pick = near[0];
  const a = composeScene({ px: pick.px, py: pick.py, region: s.regionAt(pick.px, pick.py), sites: s.sceneSites(pick.px, pick.py), focus: pick.id });
  const b = composeScene({ px: pick.px, py: pick.py, region: other.regionAt(pick.px, pick.py), sites: other.sceneSites(pick.px, pick.py), focus: pick.id });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(other.status().residentFolders <= 1, 'active-region memory');
});

test('placement verdicts over every published row', { skip, timeout: 120_000 }, async () => {
  const s = createWodStore({ root: ROOT, maxFolders: 64, log: quiet });
  await s.init();
  const pixels = new Set();
  for (const f of bundled().filter((x) => /^Locations\/.*\.csv$/i.test(x))) {
    for (const i of parseInstanceCsv(readFileSync(join(ROOT, f), 'utf8')).instances) pixels.add(i.worldY * 1000 + i.worldX);
  }
  const reasons = {};
  let placed = 0;
  for (const k of pixels) {
    for (const r of s.rowsAt(k % 1000, Math.trunc(k / 1000))) {
      if (r.reject) reasons[r.reject] = (reasons[r.reject] ?? 0) + 1;
      else placed++;
    }
  }
  // Every prefab resolves; Location Loader's own refusals remain (rows on the Port of Daggerfall replacement,
  // type-0 footprints crossing the pixel edge).
  assert.equal(reasons['prefab missing'] ?? 0, 0);
  assert.equal(placed + (reasons['on a town'] ?? 0) + (reasons['out of bounds'] ?? 0), s.status().instances);
  assert.ok(placed > 0.99 * s.status().instances);
});

test('every placed site expands its nested type-3 layouts completely', { skip, timeout: 120_000 }, async () => {
  const s = createWodStore({ root: ROOT, maxFolders: 64, log: quiet });
  await s.init();
  const used = new Set();
  for (const f of bundled().filter((x) => /^Locations\/.*\.csv$/i.test(x))) {
    for (const i of parseInstanceCsv(readFileSync(join(ROOT, f), 'utf8')).instances) used.add(i.prefab.toLowerCase());
  }
  // Prefabs that hold type-3 references: compose one placed row of each and require nothing missing.
  const hosts = new Set();
  for (const f of bundled().filter((x) => /^Locations\/LocationPrefab\/.*\.txt$/i.test(x))) {
    const name = f.replace(/^.*\//, '').replace(/\.txt$/i, '').toLowerCase();
    if (used.has(name) && /<type>\s*3\s*<\/type>/.test(readFileSync(join(ROOT, f), 'utf8'))) hosts.add(name);
  }
  assert.ok(hosts.size > 0);
  const seen = new Set();
  for (const f of bundled().filter((x) => /^Locations\/.*\.csv$/i.test(x))) {
    for (const i of parseInstanceCsv(readFileSync(join(ROOT, f), 'utf8')).instances) {
      const key = i.prefab.toLowerCase();
      if (!hosts.has(key) || seen.has(key)) continue;
      const site = s.sceneSites(i.worldX, i.worldY).find((x) => x.prefab.toLowerCase() === key);
      if (!site) continue; // refused row (town / bounds)
      seen.add(key);
      assert.equal(site.missing, undefined, `${i.prefab}: ${site.missing}`);
    }
  }
  assert.equal(seen.size, hosts.size);
});
