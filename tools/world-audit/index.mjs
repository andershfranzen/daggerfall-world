#!/usr/bin/env node
// World coverage audit (docs/world-expansion-plan.md, brief B). Read-only over the operator's installed data.
//
//   node tools/world-audit/index.mjs [--mode classic|pack|both] [--record 17/197] [--out progress/world-audit]
//                                    [--baseline FILE] [--no-routes] [--strict]
//
// classic  vanilla ARENA2 only (WorldData off, no WoD rows)
// pack     ARENA2 plus the installed World of Daggerfall (WorldData replacements and placement rows)
// Writes <out>/<mode>/{census,summary,routes}.json. Output holds counts, record keys, block/model names and short
// reasons only, and goes to an ignored directory. --strict exits 1 when an implementation failure remains.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { arena2Dir, openSources, ROOT, wodRoot } from './sources.mjs';
import { census } from './census.mjs';
import { classifyExceptions } from './exceptions.mjs';
import { wodSweep } from './wod.mjs';
import { buildRoute, NAMED_ROUTES, stratify } from './routes.mjs';
import { summarize, compareBaseline, formatSummary } from './report.mjs';

const { values: opt } = parseArgs({ options: {
  mode: { type: 'string', default: 'both' }, record: { type: 'string' }, out: { type: 'string' },
  baseline: { type: 'string' }, 'no-routes': { type: 'boolean' }, strict: { type: 'boolean' },
  arena2: { type: 'string' }, wod: { type: 'string' },
} });

const arena2 = arena2Dir(opt.arena2);
if (!arena2) { console.error('No ARENA2 data (set ARENA2_DIR or install gamedata/DaggerfallGameFiles/arena2)'); process.exit(2); }
const wod = wodRoot(opt.wod);
const modes = opt.mode === 'both' ? ['classic', 'pack'] : [opt.mode];
if (modes.includes('pack') && !wod) console.warn('World of Daggerfall is not installed; the pack sweep is skipped');
const outDir = resolve(opt.out ?? join(ROOT, 'progress/world-audit'));
const record = opt.record ? opt.record.split('/').map(Number) : null;

async function runMode(mode, { record = null, routes = true } = {}) {
  const t0 = performance.now();
  const src = await openSources({ arena2, wod: mode === 'pack' ? wod : null });
  const result = await census(src.data, src.catalog, { record });
  const exceptions = await classifyExceptions(result, src.data);
  const wodResult = mode === 'pack' && !record ? await wodSweep(wod, src.data) : null;
  let routeResults = [];
  if (routes) {
    const registry = record ? NAMED_ROUTES.filter(r => r.key === record.join('/')) : [...NAMED_ROUTES, ...stratify(result, src.catalog)];
    const ctx = { ...src, census: result, wod: wodResult && { store: wodResult.store } };
    const built = new Map();
    for (const route of registry) {
      if (route.alias && built.has(route.alias)) { routeResults.push({ ...built.get(route.alias), id: route.id, alias: route.alias, stratum: route.stratum }); continue; }
      if (route.pack === 'on' && mode !== 'pack') { routeResults.push({ id: route.id, kind: route.kind, site: route.site, mode, skipped: 'pack off', ok: true }); continue; }
      const r = { ...await buildRoute(route, ctx), owners: route.owners, stratum: route.stratum, why: route.why };
      built.set(route.id, r);
      routeResults.push(r);
    }
  }
  const summary = summarize({ mode, result, catalog: src.catalog, exceptions, wod: wodResult, routes: routeResults, record });
  summary.seconds = Math.round((performance.now() - t0) / 100) / 10;
  return { src, result, exceptions, wod: wodResult, routes: routeResults, summary };
}

let failed = false;
for (const mode of modes) {
  if (mode === 'pack' && !wod) continue;
  const run = await runMode(mode, { record, routes: !opt['no-routes'] });
  const dir = join(outDir, record ? mode + '-' + record.join('-') : mode);
  mkdirSync(dir, { recursive: true });
  const { inspect, ...census } = run.result;
  const { store, ...wodOut } = run.wod ?? {};
  writeFileSync(join(dir, 'census.json'), JSON.stringify({ ...census, stats: inspect.stats, exceptions: run.exceptions, wod: run.wod ? wodOut : null }));
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(run.routes, null, 1));
  const baselineFile = opt.baseline ?? join(outDir, 'first-census.' + mode + '.json');
  if (!record && existsSync(baselineFile)) run.summary.baseline = compareBaseline(JSON.parse(readFileSync(baselineFile, 'utf8')), run.result);
  else if (!record) { writeFileSync(baselineFile, JSON.stringify({ ...census, stats: inspect.stats })); run.summary.baseline = { saved: baselineFile }; }
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(run.summary, null, 1));
  console.log(formatSummary(run.summary));
  console.log('  output ' + dir);
  if (run.summary.failures.implementation) failed = true;
}
if (opt.strict && failed) process.exit(1);
