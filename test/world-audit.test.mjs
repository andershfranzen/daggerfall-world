// World audit (tools/world-audit, docs/world-coverage.md). Synthetic cases always run. Installed-data cases run
// against the operator's ARENA2 (ARENA2_DIR or gamedata/) and optionally World of Daggerfall, and are skipped when
// absent. Broken-source fixtures hide blocks in an in-memory view of BLOCKS.BSA; the installed files are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arena2Dir, openSources, withoutBlocks, wodRoot } from '../tools/world-audit/sources.mjs';
import { census } from '../tools/world-audit/census.mjs';
import { classifyExceptions } from '../tools/world-audit/exceptions.mjs';
import { buildRoute, NAMED_ROUTES, stratify } from '../tools/world-audit/routes.mjs';
import { compareBaseline, summarize } from '../tools/world-audit/report.mjs';
import { readLocation } from '../client/world/maps.js';

const ARENA2 = arena2Dir();
const WOD = wodRoot();
const skip = ARENA2 ? false : 'Daggerfall ARENA2 data is not installed (ARENA2_DIR or gamedata/DaggerfallGameFiles)';

// ------------------------------------------------------------------------------------------------ synthetic

test('route registry contract: unique ids, owners, numeric keys or site ids, plan records', () => {
  const ids = new Set();
  for (const r of NAMED_ROUTES) {
    assert.ok(!ids.has(r.id), r.id);
    ids.add(r.id);
    assert.ok(r.owners.length && r.owners.every(o => /^[A-I]$/.test(o)), r.id);
    assert.ok(r.key || r.site || r.pixel, r.id);
    if (r.key) assert.match(r.key, /^\d+\/\d+$/);
    if (r.site) assert.match(r.site, /^wod:\d+,\d+:\d+,\d+$/);
    assert.ok(typeof r.why === 'string' && r.why);
  }
  const key = id => NAMED_ROUTES.find(r => r.id === id).key;
  assert.equal(key('gothway-garden'), '17/197');
  assert.equal(key('daggerfall-city'), '17/1231');
  assert.equal(key('privateers-hold'), '17/179');
  assert.equal(key('peristair-switch'), '17/201');
  assert.deepEqual(['wod-camp', 'wod-farm', 'wod-dock'].map(id => NAMED_ROUTES.find(r => r.id === id).site),
    ['wod:109,158:21,21', 'wod:110,159:107,54', 'wod:98,162:63,53']);
});

const fakeRow = (key, type, extra = {}) => {
  const [region, index] = key.split('/').map(Number);
  return { key, region, index, type, x: index, y: region, climate: 'Woodlands', catalogued: true, geometry: true, complete: true, buildings: 1, ...extra };
};

test('stratify: one record per region × type, prefers a complete record, names an empty pixel', () => {
  const rows = [fakeRow('0/0', 'farm', { complete: false }), fakeRow('0/1', 'farm'), fakeRow('0/2', 'city'), fakeRow('1/0', 'farm', { climate: 'Desert' })];
  const catalog = { atPixel: (x, y) => (x === 109 && y === 159 ? {} : null) };
  const routes = stratify({ rows }, catalog);
  const strata = routes.filter(r => r.stratum);
  assert.deepEqual(strata.map(r => [r.stratum, r.key]), [['0/farm', '0/1'], ['0/city', '0/2'], ['1/farm', '1/0']]);
  assert.ok(routes.find(r => r.id === 'empty-pixel'));
});

test('report: a duplicate-name group cannot hide a failing member; baseline comparison names what changed', () => {
  const rows = [fakeRow('0/139', 'cult'), fakeRow('0/272', 'cult', { geometry: false, complete: false })];
  const issue = { place: '0/272', kind: 'geometry', owner: 'C', asset: 'X.RMB', reason: 'missing', at: '0,0' };
  const result = { rows, issues: [issue], duplicates: [['0/139', '0/272']], matrix: {}, totals: { rmbReferences: 2 }, archiveNames: 2,
    inspect: { stats: { rmb: 1, rmbComplete: 0, rdb: 0, rdbComplete: 0, models: 1, modelFailures: 0 } } };
  const exceptions = [{ class: 'implementation', kind: 'geometry', owner: 'C', reason: 'missing', count: 1, places: ['0/272'], assets: ['X.RMB'] }];
  const s = summarize({ mode: 'classic', result, catalog: { size: 2 }, exceptions, routes: [] });
  assert.equal(s.reconcile.duplicateRowsAudited, 2);
  assert.equal(s.coverage.geometry.records.n, 1);
  assert.equal(s.failures.implementation, 1);
  const cmp = compareBaseline({ rows, issues: [], totals: { rmbReferences: 2 } }, result);
  assert.equal(cmp.identical, false);
  assert.deepEqual(cmp.added, ['0/272|geometry|X.RMB|missing']);
});

// ------------------------------------------------------------------------------------------- installed data

let classic;
const sources = async () => (classic ??= await openSources({ arena2: ARENA2 }));

test('installed: every record reconciles and only classified source exceptions remain', { skip, timeout: 300000 }, async () => {
  const src = await sources();
  const r = await census(src.data, src.catalog);
  assert.equal(r.rows.length, src.catalog.size);
  assert.equal(r.rows.length, r.archiveNames);
  assert.equal(new Set(r.rows.map(x => x.key)).size, r.rows.length);
  assert.equal(r.totals.rmbResolved, r.totals.rmbReferences);
  assert.equal(r.totals.rdbResolved, r.totals.rdbReferences);
  assert.equal(r.inspect.stats.modelFailures, 0);
  for (const g of r.duplicates) for (const k of g) assert.ok(r.rows.some(x => x.key === k), 'duplicate member audited: ' + k);
  const ex = await classifyExceptions(r, src.data);
  assert.deepEqual(ex.filter(e => e.class === 'implementation'), [], 'implementation failures');
  for (const e of r.issues) assert.ok(e.place && e.asset && e.reason && /^[A-I]$/.test(e.owner), JSON.stringify(e));
  const crux = ex.find(e => e.reason === 'Dungeon has no exit-door face');
  if (crux) assert.equal(crux.class, 'quest-only');
});

test('broken fixture: a missing core RMB fails its place with the block, reason and owner', { skip }, async () => {
  const src = await sources();
  const loc = await readLocation(src.data.maps, 17, 197);
  const block = loc.blockNames[0];
  const r = await census(withoutBlocks(src.data, [block]), src.catalog, { record: [17, 197] });
  const row = r.rows[0];
  assert.equal(row.key, '17/197');
  assert.equal(row.geometry, false);
  const hit = r.issues.find(i => i.asset === block);
  assert.ok(hit, 'missing block reported');
  assert.deepEqual([hit.place, hit.kind, hit.owner], ['17/197', 'geometry', 'C']);
  assert.match(hit.reason, /no exact or classic fallback RMB/);
  const ex = await classifyExceptions(r, src.data);
  assert.equal(ex.find(e => e.assets.includes(block)).class, 'implementation');
});

test('broken fixture: a missing dungeon RDB fails the dungeon with owner G', { skip }, async () => {
  const src = await sources();
  const r = await census(withoutBlocks(src.data, ['N0000051.RDB']), src.catalog, { record: [17, 201] });
  const hit = r.issues.find(i => i.asset === 'N0000051.RDB');
  assert.deepEqual([hit?.place, hit?.kind, hit?.owner], ['17/201', 'geometry', 'G']);
  assert.equal(r.rows[0].dungeon, false);
});

test('duplicate names: each Djen Lodge and each Your Ship is its own record; a later duplicate\'s failure is not hidden', { skip }, async () => {
  const src = await sources();
  const lodges = await Promise.all([[0, 139], [0, 272]].map(k => census(src.data, src.catalog, { record: k })));
  assert.deepEqual(lodges.map(r => [r.rows[0].key, r.rows[0].x, r.rows[0].y]), [['0/139', 310, 435], ['0/272', 319, 483]]);
  assert.ok(lodges.every(r => r.rows[0].catalogued));
  // The two ships share a name but not a block: break only the second ship's block.
  const [a, b] = await Promise.all([1, 2].map(i => readLocation(src.data.maps, 31, i)));
  const only = b.blockNames.filter(n => !a.blockNames.includes(n));
  assert.ok(only.length, 'second ship has its own block');
  const broken = withoutBlocks(src.data, only);
  const [first, second] = await Promise.all([[31, 1], [31, 2]].map(k => census(broken, src.catalog, { record: k })));
  assert.equal(first.rows[0].geometry, true);
  assert.equal(second.rows[0].geometry, false);
  assert.ok(second.issues.some(i => i.place === '31/2' && only.includes(i.asset)));
});

test('routes: named classic routes build with the production loaders', { skip, timeout: 300000 }, async () => {
  const src = await sources();
  const ids = ['gothway-garden', 'privateers-hold', 'peristair-switch', 'alikr-djen-lodge-b'];
  for (const id of ids) {
    const route = NAMED_ROUTES.find(r => r.id === id);
    const [region, index] = route.key.split('/').map(Number);
    const c = await census(src.data, src.catalog, { record: [region, index] });
    const out = await buildRoute(route, { ...src, census: c });
    assert.equal(out.ok, true, id + ': ' + JSON.stringify(out.issues));
    assert.equal(out.checks.loaded, route.key);
  }
  for (const route of NAMED_ROUTES.filter(r => r.kind === 'ship')) {
    const ship = await buildRoute(route, { ...src, census: null });
    assert.equal(ship.ok, true, route.id + ': ' + JSON.stringify(ship.issues));
    assert.equal(ship.checks.loaded, route.key);
    assert.equal(ship.checks.requiresOwnership, true);
    assert.equal(ship.prerequisite, false, 'both ship records can be built for their owners');
  }
});

test('a ship loader error fails its route audit', async () => {
  const route = NAMED_ROUTES.find(r => r.id === 'ship-b');
  const catalog = { at() { throw new Error('unreadable ship record'); } };
  const ship = await buildRoute(route, { catalog });
  assert.equal(ship.ok, false);
  assert.equal(ship.prerequisite, false);
  assert.equal(ship.issues[0].reason, 'unreadable ship record');
});

test('pack: WoD sweep classifies every published row and the named sites build', { skip: skip || (!WOD && 'World of Daggerfall is not installed'), timeout: 600000 }, async () => {
  const { wodSweep } = await import('../tools/world-audit/wod.mjs');
  const src = await openSources({ arena2: ARENA2, wod: WOD });
  const w = await wodSweep(WOD, src.data);
  assert.equal(w.rows, w.status.instances);
  assert.equal(w.accepted + Object.values(w.rejected).reduce((a, n) => a + n, 0), w.rows);
  assert.ok(w.issues.every(i => i.kind === 'optional-dependency' && i.owner === 'H'));
  for (const id of ['wod-camp', 'wod-farm', 'wod-dock']) {
    const out = await buildRoute(NAMED_ROUTES.find(r => r.id === id), { ...src, census: null, wod: { store: w.store } });
    assert.equal(out.ok, true, id + ': ' + JSON.stringify(out.issues));
  }
});
