// Daggerfall Unity WorldData replacements from the operator-installed World of Daggerfall pack.
//
// Source: <root>/WorldData/*.json, where root is config.wodPath, then $WOD_PATH, then gamedata/world-of-daggerfall
// (the same root server/rpg/wilderness.js uses). The pack is git-ignored and never served or bundled: only the
// normalized, bounded descriptors from client/world/wilderness/replacements.js leave this module, through
// GET /api/wilderness/worlddata[/block|/location]. Files are read lazily, on first use, and only if DFU would read
// them (WorldDataReplacement file names, inside the published bundle when WorldOfDaggerfall.dfmod.json exists).
//
// World of Daggerfall Project (Nexus mod 249): KABoissonneault, Cliffworms, Kamer, carademono, contributors.
// Replacement semantics: Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop). See the client module header.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORLDDATA_LIMITS,
  WORLDDATA_PATH,
  classifyWorldDataFile,
  emptyWorldData,
  memoryWorldData,
  setDefaultWorldData,
} from '../../../client/world/wilderness/replacements.js';

export { WORLDDATA_PATH };
export const name = 'worldData';
export const DEFAULT_ROOT = fileURLToPath(new URL('../../../gamedata/world-of-daggerfall', import.meta.url));
const BUNDLE_PREFIX = 'Assets/Game/Mods/world-of-daggerfall/WorldData/';

/** Same order as server/rpg/wilderness.js resolveRoot. */
export function resolveWodRoot(config = {}, env = process.env) {
  if (config.wodPath) return config.wodPath;
  if (env.WOD_PATH) return env.WOD_PATH;
  return existsSync(DEFAULT_ROOT) ? DEFAULT_ROOT : null;
}

/** WorldData file names the published bundle ships, or null when the tree has no manifest. */
function bundleNames(root) {
  const manifest = join(root, 'WorldOfDaggerfall.dfmod.json');
  try {
    if (!statSync(manifest).isFile() || statSync(manifest).size > 8 * 1024 * 1024) return null;
    const files = JSON.parse(readFileSync(manifest, 'utf8')).Files;
    if (!Array.isArray(files)) return null;
    return new Set(files.filter((f) => typeof f === 'string' && f.startsWith(BUNDLE_PREFIX)).map((f) => f.slice(BUNDLE_PREFIX.length).toLowerCase()));
  } catch {
    return null;
  }
}

/**
 * Provider over `<root>/WorldData`. Resolves to an empty provider (vanilla) when the folder is absent.
 * @param {string|null} root
 * @param {{log?: object}} [opts]
 */
export async function serverWorldData(root, { log = console } = {}) {
  if (!root) return emptyWorldData('no pack');
  const dir = join(resolve(root), 'WorldData');
  let names;
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return emptyWorldData('no WorldData');
  }
  const bundle = bundleNames(root);
  const entries = [];
  const skipped = [];
  for (const n of names.sort()) {
    const c = classifyWorldDataFile(n);
    if (!c) continue;
    if (bundle && !bundle.has(n.toLowerCase())) {
      skipped.push(n);
      continue;
    }
    entries.push({
      name: n,
      text: async () => {
        const full = join(dir, n);
        const st = await stat(full);
        if (st.size > WORLDDATA_LIMITS.fileBytes) throw new Error(`WorldData ${n}: ${st.size} bytes is over the limit`);
        return readFile(full, 'utf8');
      },
    });
  }
  const provider = memoryWorldData(entries, {
    source: 'World of Daggerfall WorldData',
    onError: (err) => log.warn?.(`[worlddata] ${err.message}; using the vanilla data instead`),
  });
  provider.skipped = skipped;
  return provider;
}

// ---------------------------------------------------------------------------------------------- HTTP

function json(req, res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : text);
}

/**
 * GET /api/wilderness/worlddata                          -> {v, blocks: [name], locations: [{region,index,name}]}
 * GET /api/wilderness/worlddata/block?name=ALCHAS00.RMB    -> normalized block descriptor
 * GET /api/wilderness/worlddata/location?region=17&index=1246 -> normalized location descriptor
 * Only names in the index resolve. Never a file, path or raw JSON.
 * @param {Promise<object>|object|null} provider
 * @returns {boolean} whether the request was for this route
 */
export function handleWorldDataHttp(provider, req, res) {
  const url = new URL(req.url, 'http://local');
  const path = url.pathname;
  if (path !== WORLDDATA_PATH && !path.startsWith(`${WORLDDATA_PATH}/`)) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  (async () => {
    const p = await provider;
    if (!p) return json(req, res, 503, { error: 'World of Daggerfall WorldData is not available', pack: 'missing' });
    const index = await p.index();
    if (path === WORLDDATA_PATH) return json(req, res, 200, index);
    if (path === `${WORLDDATA_PATH}/block`) {
      const n = String(url.searchParams.get('name') ?? '').toUpperCase();
      if (!index.blocks.includes(n)) return json(req, res, 404, { error: 'no such replacement block' });
      const d = await p.block(n);
      return d ? json(req, res, 200, d) : json(req, res, 422, { error: 'replacement block could not be read' });
    }
    if (path === `${WORLDDATA_PATH}/location`) {
      const region = Number(url.searchParams.get('region')), index2 = Number(url.searchParams.get('index'));
      if (!index.locations.some((l) => l.region === region && l.index === index2)) return json(req, res, 404, { error: 'no such replacement location' });
      const d = await p.location(region, index2);
      return d ? json(req, res, 200, d) : json(req, res, 422, { error: 'replacement location could not be read' });
    }
    return json(req, res, 404, { error: 'not found' });
  })().catch(() => {
    if (!res.headersSent) json(req, res, 500, { error: 'internal error' });
    else res.end();
  });
  return true;
}

// ---------------------------------------------------------------------------------------------- feature

/**
 * RPG feature: opens the pack's WorldData once, makes it the default for every server-side loadTown/openWorldData
 * (collision, doors, town services) and exposes it as ctx.services.worldData for the HTTP route.
 * The browser asks the same route, so both sides lay towns out from the same data.
 */
export function install(ctx, opts = {}) {
  const log = ctx.log ?? console;
  const root = opts.root !== undefined ? opts.root : resolveWodRoot(ctx.config ?? {});
  const ready = (opts.provider ? Promise.resolve(opts.provider) : serverWorldData(root, { log })).then(async (p) => {
    setDefaultWorldData(p);
    const idx = await p.index();
    if (idx.blocks.length || idx.locations.length) {
      log.info?.(`[worlddata] ${idx.blocks.length} block and ${idx.locations.length} location replacements from ${p.source}`);
    }
    return p;
  });
  // Until ready, loaders see the pending provider, never vanilla, so the first town load cannot disagree.
  const pending = { source: 'loading', index: async () => (await ready).index(), block: async (n) => (await ready).block(n), location: async (r, i) => (await ready).location(r, i) };
  setDefaultWorldData(pending);
  ready.catch((err) => {
    log.warn?.(`[worlddata] ${err.message}; towns use the vanilla data`);
    setDefaultWorldData(null);
  });
  ctx.services ??= {};
  ctx.services.worldData = { ready, handle: (req, res) => handleWorldDataHttp(ready.catch(() => null), req, res) };
  return { name, ready };
}
