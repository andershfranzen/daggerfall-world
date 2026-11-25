// Aggregates a census, its classified exceptions, the WoD sweep and the route builds into the coverage matrix.
// Every column carries its own numerator and denominator (docs/world-expansion-plan.md "How to call the milestone
// complete"). Columns the audit cannot establish on its own are reported as pending with their owners.
import { REGION_NAMES } from '../../client/world/maps.js';
import { PREREQUISITE } from './routes.mjs';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const col = (n, d, note) => ({ n, d, pct: pct(n, d), ...(note ? { note } : {}) });

export function summarize({ mode, result, catalog, exceptions, wod, routes, record }) {
  const rows = result.rows;
  const byClass = {};
  for (const e of exceptions) {
    byClass[e.class] ??= { issues: 0, places: 0 };
    byClass[e.class].issues += e.count;
    byClass[e.class].places += e.places.length;
  }
  const implementation = exceptions.filter(e => e.class === 'implementation');
  const reconcile = {
    records: rows.length, catalogue: record ? 1 : catalog.size, archiveNames: result.archiveNames,
    regions: new Set(rows.map(r => r.region)).size,
    distinctPixels: new Set(rows.map(r => r.x + ',' + r.y)).size,
    duplicateGroups: result.duplicates.length, duplicateRecords: result.duplicates.reduce((a, g) => a + g.length, 0),
    // A duplicate name hides nothing: each member is its own row with its own verdict.
    duplicateRowsAudited: result.duplicates.flat().filter(k => rows.some(r => r.key === k)).length,
  };
  reconcile.ok = reconcile.records === reconcile.archiveNames && (record || reconcile.records === catalog.size);
  const byType = {};
  for (const r of rows) {
    const t = byType[r.type] ??= { records: 0, catalogued: 0, geometry: 0, complete: 0, regions: new Set() };
    t.records++; t.catalogued += +r.catalogued; t.geometry += +r.geometry; t.complete += +r.complete; t.regions.add(r.region);
  }
  for (const t of Object.values(byType)) t.regions = t.regions.size;
  const built = routes.filter(r => !r.skipped && !r.alias);
  const strata = routes.filter(r => r.stratum);
    const regionTypes = new Set(rows.map(r => r.region + '/' + r.type));
  const reachedStrata = new Set(strata.filter(r => r.ok && !r.prerequisite).map(r => r.stratum));
  const t = result.totals;
  const coverage = {
    catalogued: {
      classic: col(rows.filter(r => r.catalogued).length, rows.length),
      ...(wod ? { wodRows: col(wod.accepted, wod.rows, 'Placement rows the production loader accepts') } : {}),
    },
    geometry: {
      records: col(rows.filter(r => r.geometry).length, rows.length),
      rmbBlocks: col(result.inspect.stats.rmbComplete, result.inspect.stats.rmb),
      rdbBlocks: col(result.inspect.stats.rdbComplete, result.inspect.stats.rdb),
      models: col(result.inspect.stats.models - result.inspect.stats.modelFailures, result.inspect.stats.models),
      rmbReferences: col(t.rmbResolved ?? 0, t.rmbReferences ?? 0),
      rdbReferences: col(t.rdbResolved ?? 0, t.rdbReferences ?? 0),
      routeScenes: col(built.filter(r => r.ok).length, built.length, 'Complete scenes assembled for the route sample'),
    },
    reachable: {
      strata: col(reachedStrata.size, record ? 1 : regionTypes.size, 'Region × type strata whose sample record built entry and return with the production loaders'),
      buildingInteriors: col(t.enterable ?? 0, t.interiors ?? 0, 'RMB interiors with a paired outside door and a return door'),
      dungeons: col(rows.filter(r => r.dungeon).length, t.associatedDungeons ?? 0, 'Associated dungeons with entrance face, start marker and exit face'),
      ships: rows.filter(r => r.type === 'ships').map(r => ({ key: r.key, buildings: r.buildings, prerequisite: 'ship ownership' })),
      note: 'Loader-level automated sweep. Production travel, portal-service and collision walks belong to the owning briefs.',
    },
    interactable: { status: 'pending', owners: ['F', 'G', 'H', 'I'], candidates: routes.filter(r => ['G', 'H', 'I', 'F'].some(o => r.owners?.includes(o))).map(r => r.id) },
    multiplayerVerified: { status: 'pending', owners: ['E', 'integration'], automated: 0, liveBrowser: 0 },
  };
  return {
    mode, record: record?.join('/') ?? null, generated: new Date().toISOString(), reconcile, coverage,
    totals: result.totals, stats: result.inspect.stats, mapReads: result.mapReads,
    failures: {
      implementation: implementation.reduce((a, e) => a + e.count, 0) + routes.filter(r => !r.alias).flatMap(r => r.issues ?? []).filter(i => !PREREQUISITE.has(i.kind)).length,
      prerequisite: routes.filter(r => !r.alias && r.prerequisite).map(r => r.key), byClass },
    exceptions: exceptions.map(({ places, assets, ...e }) => ({ ...e, places: places.slice(0, 40), assets: assets.slice(0, 12) })),
    wod: wod && { status: wod.status, pixels: wod.pixels, rows: wod.rows, accepted: wod.accepted, rejected: wod.rejected, rejectedSample: wod.sample,
      kinds: wod.kinds, objects: wod.objects, dependencies: wod.dependencies,
      unresolved: Object.fromEntries(Object.entries(wod.unresolved).map(([k, v]) => [k, { refs: Object.keys(v).length, uses: Object.values(v).reduce((a, e) => a + e.uses, 0), ids: Object.keys(v).slice(0, 80) }])) },
    routes: routes.map(r => ({ id: r.id, key: r.key, site: r.site, ok: r.ok, skipped: r.skipped, stratum: r.stratum, issues: r.issues?.length ?? 0, knownExceptions: r.knownExceptions })),
    routeFailures: routes.filter(r => !r.alias).flatMap(r => r.issues ?? []),
    byType,
    byRegion: Object.fromEntries(Object.entries(result.matrix).map(([r, types]) => [r + ' ' + REGION_NAMES[r], types])),
  };
}

/** Differences from the preserved first census: totals, block stats and issue identities. */
export function compareBaseline(base, result) {
  const diff = {};
  for (const k of new Set([...Object.keys(base.totals ?? {}), ...Object.keys(result.totals)])) {
    if (base.totals?.[k] !== result.totals[k]) diff[k] = [base.totals?.[k] ?? null, result.totals[k] ?? null];
  }
  for (const k of Object.keys(base.stats ?? {})) {
    if (base.stats[k] !== result.inspect.stats[k]) diff['stats.' + k] = [base.stats[k], result.inspect.stats[k]];
  }
  const id = i => [i.place, i.kind, i.asset, i.reason].join('|');
  const before = new Set((base.issues ?? []).map(id)), after = new Set(result.issues.map(id));
  return {
    records: [base.rows?.length ?? null, result.rows.length], issues: [before.size, after.size], totals: diff,
    fixed: [...before].filter(i => !after.has(i)).slice(0, 40), added: [...after].filter(i => !before.has(i)).slice(0, 40),
    identical: !Object.keys(diff).length && before.size === after.size && [...before].every(i => after.has(i)),
  };
}

export function formatSummary(s) {
  const c = s.coverage, f = x => `${x.n}/${x.d} (${x.pct}%)`;
  const lines = [
    `World audit — ${s.mode}${s.record ? ' ' + s.record : ''} — ${s.seconds ?? '?'} s`,
    `  records ${s.reconcile.records} of ${s.reconcile.catalogue} catalogue, ${s.reconcile.regions} regions, ${s.reconcile.distinctPixels} pixels, ${s.reconcile.duplicateRecords} in ${s.reconcile.duplicateGroups} duplicate-name groups (all audited) ${s.reconcile.ok ? 'OK' : 'MISMATCH'}`,
    `  catalogued ${f(c.catalogued.classic)}${c.catalogued.wodRows ? '   WoD rows ' + f(c.catalogued.wodRows) : ''}`,
    `  geometry   records ${f(c.geometry.records)}  RMB ${f(c.geometry.rmbBlocks)}  RDB ${f(c.geometry.rdbBlocks)}  models ${f(c.geometry.models)}  route scenes ${f(c.geometry.routeScenes)}`,
    `  reachable  strata ${f(c.reachable.strata)}  interiors ${f(c.reachable.buildingInteriors)}  dungeons ${f(c.reachable.dungeons)}`,
    `  failures   implementation ${s.failures.implementation}; ` + Object.entries(s.failures.byClass).map(([k, v]) => `${k} ${v.issues} (${v.places} places)`).join(', ')
      + (s.failures.prerequisite.length ? `; ownership prerequisite ${s.failures.prerequisite.join(', ')}` : ''),
  ];
  for (const e of s.exceptions) lines.push(`    [${e.class}] ${e.owner} ${e.count}× ${e.reason} — ${e.places.slice(0, 3).join(', ')}${e.places.length > 3 ? ', …' : ''}`);
  if (s.wod) lines.push(`  WoD        rows ${s.wod.accepted}/${s.wod.rows} accepted, rejected ${JSON.stringify(s.wod.rejected)}, unresolved ` + Object.entries(s.wod.unresolved).map(([k, v]) => `${k} ${v.refs} refs placed ${v.uses} times`).join(', '));
  for (const r of s.routeFailures.slice(0, 10)) lines.push(`    route ${r.place} [${r.owner}] ${r.asset}: ${r.reason}`);
  if (s.baseline) lines.push(`  baseline   ${s.baseline.saved ? 'saved ' + s.baseline.saved : s.baseline.identical ? 'identical to first census' : 'changed ' + JSON.stringify(s.baseline.totals) + ' fixed ' + s.baseline.fixed.length + ' added ' + s.baseline.added.length}`);
  return lines.join('\n');
}
