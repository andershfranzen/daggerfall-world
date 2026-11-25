// Route registry and route builds. A route is a source record the playable checks start from; building it runs
// the production loaders (travel catalogue, loadTown, locationPortals, loadInterior, loadDungeon, WoD scene sites)
// on that record and records what a player could reach there. Only ids, counts and short reasons are kept.
import { loadTown } from '../../client/world/town.js';
import { dungeonLocation, locationPortals, loadDungeon, loadInterior, parseLocation } from '../../client/world/interiors/index.js';
import { composeScene, parseSiteId } from '../../client/world/wilderness/data.js';
import { issue } from './blocks.mjs';

/**
 * Named routes from docs/world-expansion-plan.md. Registry contract, one object per route:
 *   { id, kind, owners: [brief letters], key?: 'region/index', site?: 'wod:…', pixel?: [x, y], pack?: 'on'|'off'|'both', why }
 * `key` addresses a classic MAPS record by numeric region/location index (catalog.at). `site` is a WoD site id.
 * Derived routes (stratify) add `stratum: 'region/type'` and pick the lowest index that the census found complete.
 */
export const NAMED_ROUTES = Object.freeze([
  { id: 'gothway-garden', kind: 'town', owners: ['C', 'D', 'E', 'F'], key: '17/197', pixel: [109, 159], why: 'First playable checkpoint and north-road walk' },
  { id: 'gothway-north-pixel', kind: 'wilderness', owners: ['C', 'D', 'E'], pixel: [109, 158], why: 'Neighbouring pixel for continuous walking (Privateer\'s Hold pixel)' },
  { id: 'daggerfall-city', kind: 'town', owners: ['C', 'F'], key: '17/1231', pixel: [207, 213], why: '8×8 city' },
  { id: 'privateers-hold', kind: 'dungeon', owners: ['G'], key: '17/179', pixel: [109, 158], why: 'Stacked-floor entry and exit' },
  { id: 'peristair-switch', kind: 'dungeon', owners: ['G'], key: '17/201', why: 'Linked switch and action door in N0000051.RDB' },
  { id: 'alikr-djen-lodge-a', kind: 'identity', owners: ['A'], key: '0/139', pixel: [310, 435], why: 'Duplicate-name identity (first match)' },
  { id: 'alikr-djen-lodge-b', kind: 'identity', owners: ['A'], key: '0/272', pixel: [319, 483], why: 'Duplicate-name identity (later duplicate)' },
  { id: 'port-of-daggerfall', kind: 'replacement', owners: ['A', 'C'], key: '17/1246', pixel: [207, 214], pack: 'both', why: 'Copperfield Manor with the pack off, Port of Daggerfall with it on' },
  { id: 'ship-a', kind: 'ship', owners: ['A', 'F'], key: '31/1', why: 'Ship record; needs ship ownership' },
  { id: 'ship-b', kind: 'ship', owners: ['A', 'F'], key: '31/2', why: 'Ship record; needs ship ownership' },
  { id: 'mantellan-crux', kind: 'dungeon', owners: ['G', 'I'], key: '31/0', why: 'Quest-only dungeon without an ordinary exit' },
  { id: 'wod-camp', kind: 'site', owners: ['H'], site: 'wod:109,158:21,21', pack: 'on', why: 'Camp encounter' },
  { id: 'wod-farm', kind: 'site', owners: ['H'], site: 'wod:110,159:107,54', pack: 'on', why: 'Farm building' },
  { id: 'wod-dock', kind: 'site', owners: ['H'], site: 'wod:98,162:63,53', pack: 'on', why: 'Sea-level dock' },
]);

const CLIMATE_SAMPLE = ['Desert', 'Woodlands', 'Mountain'];

/**
 * Stratified sample: for every populated region and every location type it contains, the lowest-index record the
 * census found complete (else the lowest index, so a failing stratum is still built and reported). Adds a farm,
 * an empty classic pixel near Gothway Garden, and one exterior of each climate in CLIMATE_SAMPLE if missing.
 */
export function stratify(result, catalog, { emptyNear = [109, 159] } = {}) {
  const pick = new Map();
  for (const row of result.rows) {
    const s = row.region + '/' + row.type;
    const cur = pick.get(s);
    if (!cur || (row.complete && !cur.complete)) pick.set(s, row);
  }
  const named = new Set(NAMED_ROUTES.map(r => r.key));
  const routes = [...pick.entries()].map(([stratum, row]) => ({
    id: 'stratum-' + stratum.replace('/', '-'), kind: row.expectedDungeon ? 'dungeon' : 'town', owners: ['B'],
    key: row.key, stratum, climate: row.climate, why: 'Stratified sample',
  }));
  // A named route that is also its stratum's sample is built once, under its name, and still counts for the stratum.
  for (const r of routes) if (named.has(r.key)) r.alias = NAMED_ROUTES.find(n => n.key === r.key).id;
  for (const c of CLIMATE_SAMPLE) {
    if (routes.some(r => r.climate === c)) continue;
    const row = result.rows.find(r => r.climate === c && r.complete);
    if (row) routes.push({ id: 'climate-' + c.toLowerCase(), kind: 'town', owners: ['B'], key: row.key, climate: c, why: 'Climate sample' });
  }
  // Nearest classic pixel without a record, by ring around `emptyNear` (H decides whether WoD rows stand there).
  for (let r = 1; r < 50; r++) {
    let found = null;
    for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = emptyNear[0] + dx, y = emptyNear[1] + dy;
      if (!catalog.atPixel(x, y)) found = [x, y];
    }
    if (found) { routes.push({ id: 'empty-pixel', kind: 'wilderness', owners: ['H'], pixel: found, why: 'Pixel with no classic record' }); break; }
  }
  return routes;
}

export const PREREQUISITE = new Set(['ownership-prerequisite']);
const finite = p => p && [p.x, p.y, p.z].every(Number.isFinite);

/**
 * Builds one route with the production loaders. Never throws: failures are issues with an owner.
 * @param {object} route registry entry
 * @param {object} ctx {data, files, catalog, worldData, mode, census (result), wod?: {store}}
 */
export async function buildRoute(route, ctx) {
  const out = { id: route.id, kind: route.kind, key: route.key, site: route.site, mode: ctx.mode, checks: {}, issues: [] };
  const fail = (kind, owner, asset, reason) => out.issues.push({ place: route.key ?? route.site ?? String(route.pixel), ...issue(kind, owner, asset, reason) });
  const known = new Set((ctx.census?.issues ?? []).filter(i => i.place === route.key && i.kind === 'source-portal').map(i => i.reason));
  out.knownExceptions = [...known];
  try {
    if (route.site) await buildSite(route, ctx, out, fail);
    else if (route.key) await buildRecord(route, ctx, out, fail, known);
    else if (route.pixel) {
      const entry = ctx.catalog.atPixel(...route.pixel);
      out.checks.classicRecord = entry ? entry.slotId : null;
      if (ctx.wod?.store) out.checks.wodRows = ctx.wod.store.rowsAt(...route.pixel).length;
    }
  } catch (err) {
    fail('route', route.owners?.[0] ?? 'B', route.key ?? route.site ?? 'route', err.message);
  }
  out.ok = !out.issues.some(i => !PREREQUISITE.has(i.kind));
  out.prerequisite = out.issues.some(i => PREREQUISITE.has(i.kind));
  return out;
}

async function buildRecord(route, ctx, out, fail, known) {
  const [region, index] = route.key.split('/').map(Number);
  const entry = ctx.catalog.at(region, index);
  if (!entry) return fail('identity', 'A', 'MAPS:' + route.key, 'catalog.at() has no record');
  const c = out.checks;
  if (entry.type === 'ships') c.requiresOwnership = true;
  c.address = entry.id;
  c.pixel = [entry.x, entry.y];
  c.identity = ctx.catalog.get(entry.id) === entry && ctx.catalog.get(entry.slotId) === entry && ctx.catalog.atPixel(entry.x, entry.y) === entry;
  if (!c.identity) fail('identity', 'A', entry.id, 'Address, slot or pixel resolves another record');
  if (route.pixel && (route.pixel[0] !== entry.x || route.pixel[1] !== entry.y)) fail('identity', 'A', entry.id, 'Pixel differs from the plan: ' + c.pixel);

  // Exterior exactly as the browser and server load it, by the record's own address.
  const p = parseLocation(entry.id);
  const town = await loadTown(ctx.files, { region: p.region, location: p.location, worldData: ctx.worldData });
  c.loaded = [town.source.regionIndex, town.source.locationIndex].join('/');
  if (c.loaded !== route.key) return fail('identity', 'A', entry.id, 'Exterior loader returned ' + c.loaded);
  c.size = [town.source.width, town.source.height];
  c.climate = town.source.climate.label;
  c.replaced = town.source.worldData ?? null;
  c.triangles = town.stats.triangles;
  if (town.stats.droppedPlanes) c.droppedPlanes = town.stats.droppedPlanes;
  if (!(town.stats.triangles > 0)) fail('geometry', 'C', entry.id, 'Exterior has no triangles');

  const portals = await locationPortals(ctx.data, { region: p.region, location: p.location }, town.source.spawnLocal);
  c.buildings = portals.buildings.length;
  c.buildingDoors = portals.buildings.reduce((a, b) => a + b.doors.length, 0);
  const row = ctx.census?.rows.find(r => r.key === route.key);
  if (row && row.buildings !== c.buildings) fail('building-portal', 'F', entry.id, 'Portal service lists ' + c.buildings + ' buildings; census found ' + row.buildings);
  for (const b of portals.buildings) {
    for (const d of b.doors) if (!finite(d.enter) || !finite(d.exit)) fail('building-portal', 'F', b.target, 'Non-finite door landing');
  }
  if (portals.buildings.length) {
    // One complete interior: the census portal record if there is one, else the first building.
    const want = row?.portal;
    const b = portals.buildings.find(x => want && x.block === want.block && x.record === want.record) ?? portals.buildings[0];
    const scene = await loadInterior(ctx.data, b.target);
    const exits = scene.doors.filter(d => d.type === 1).length;
    c.interior = { target: b.target, buildingType: b.buildingType, triangles: scene.positions.length / 9, exits, actionDoors: scene.actionDoors.length };
    if (!exits) fail('building-portal', 'F', b.target, 'Interior scene has no exit door');
  }

  if (row?.expectedDungeon || portals.dungeon) {
    const target = dungeonLocation(p.region, p.location);
    c.dungeonEntrance = !!portals.dungeon?.doors.length;
    c.dungeonAccess = portals.dungeon?.access ?? null;
    if (!portals.dungeon && !known.has('Associated dungeon has no exterior dungeon-door face')) fail('dungeon-portal', 'G', target, 'No dungeon portal');
    const scene = await loadDungeon(ctx.data, target);
    const exits = scene.doors.filter(d => d.type === 3).length;
    c.dungeon = { target, blocks: scene.source.blocks.length, triangles: scene.positions.length / 9, exits, actionDoors: scene.actionDoors.length, spawn: finite(scene.spawn) };
    if (!c.dungeon.spawn) fail('dungeon-portal', 'G', target, 'No finite start');
    if (!exits && !known.has('Dungeon has no exit-door face')) fail('dungeon-portal', 'G', target, 'Dungeon scene has no exit door');
    if (row?.link) c.link = row.link;
  }
}

async function buildSite(route, ctx, out, fail) {
  const store = ctx.wod?.store;
  if (!store) { out.checks.skipped = 'pack off'; return; }
  const parsed = parseSiteId(route.site);
  const summary = store.site(route.site, parsed);
  if (!summary) return fail('wod-placement', 'H', route.site, 'Site is not placed by the loader');
  const sites = store.sceneSites(parsed.px, parsed.py);
  const scene = composeScene({ px: parsed.px, py: parsed.py, region: store.regionAt(parsed.px, parsed.py), sites, focus: route.site });
  const site = sites.find(s => s.id === route.site);
  const models = site.objects.filter(o => o.kind === 'model');
  const missing = [...new Set(models.filter(o => ctx.data.lib.arch.indexOfId(o.model) < 0).map(o => o.model))];
  out.checks = {
    kind: summary.kind, prefab: summary.prefab, ground: site.ground, objects: site.objects.length, markers: site.markers.length,
    monsters: site.markers.filter(m => m.marker === 16 || m.marker === 15).length, blocks: site.objects.filter(o => o.kind === 'block').length,
    sceneSites: scene.sites.length, spawn: [scene.spawn.x, scene.spawn.z], classicRecord: ctx.catalog.atPixel(parsed.px, parsed.py)?.slotId ?? null,
  };
  if (missing.length) out.checks.omittedModels = missing; // optional pieces; the site stays usable (brief H)
}
