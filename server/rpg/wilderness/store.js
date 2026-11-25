// Operator-installed World of Daggerfall tree -> placed wilderness sites.
//
// Memory: one startup scan builds a compact pixel -> source-folder index (1000x500 bytes) and then forgets the rows.
// Full instance rows are held only for the folders (regions) recently asked about, in an LRU, as Location Loader
// holds only the regions the player has entered. Prefabs are parsed on demand into their own LRU. Nothing here is
// served: callers get composed scene records (client/world/wilderness/data.js).
//
// Which files count, in order of authority:
//   1. WorldOfDaggerfall.dfmod.json `Files` (the published bundle) when present: its Locations/*.csv and
//      Locations/<Region>/*.csv plus Locations/LocationPrefab/*.txt.
//   2. Otherwise every Locations/<Region>/*.csv whose folder names a Daggerfall region (or index), plus the root
//      Locations/*.csv. `Development/` is never read.
//   3. If that yields no instance files, CombinedCSVs/*.csv (the GIS kit's concatenation of the same rows).
// File order is ordinal by path relative to the tree root; rows stay in file order.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  MAP_PIXELS_X,
  MAP_PIXELS_Y,
  TERRAIN_SIZE,
  assignSiteIds,
  composeSite,
  isMapPixel,
  isPointOfInterest,
  ordinal,
  overlappingSections,
  parseInstanceCsv,
  parsePrefabXml,
  regionIndexOf,
  regionNameOf,
  rejectReason,
  siteKind,
  displayName,
  worldDataTownArea,
} from '../../../client/world/wilderness/data.js';

const BUNDLE_PREFIX = 'Assets/Game/Mods/world-of-daggerfall/';
const MULTI = 255;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const toPosix = (p) => p.split(sep).join('/');

class Lru {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  has(k) {
    return this.map.has(k);
  }
  get size() {
    return this.map.size;
  }
}

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Finds the tree's instance files and prefabs. Returns {folders, prefabs, bundle, source}. */
export async function discoverTree(root) {
  const locDir = join(root, 'Locations');
  let bundle = null;
  const dfmod = join(root, 'WorldOfDaggerfall.dfmod.json');
  if (existsSync(dfmod)) {
    try {
      const files = JSON.parse(await readFile(dfmod, 'utf8')).Files;
      if (Array.isArray(files)) {
        bundle = new Set(files.filter((f) => typeof f === 'string' && f.startsWith(BUNDLE_PREFIX)).map((f) => f.slice(BUNDLE_PREFIX.length)));
      }
    } catch {
      bundle = null;
    }
  }
  const inBundle = (rel) => !bundle || bundle.has(rel);

  const folders = []; // {key, region, regionIndex, files: [{rel, path}]}
  const addFolder = (key, region, files) => {
    if (!files.length) return;
    files.sort((a, b) => ordinal(a.rel, b.rel));
    folders.push({ key, region, regionIndex: region ? regionIndexOf(region) : -1, files });
  };

  const top = await listDir(locDir);
  const rootFiles = [];
  for (const e of top) {
    const rel = `Locations/${e.name}`;
    if (e.isFile() && /\.csv$/i.test(e.name) && inBundle(rel)) rootFiles.push({ rel, path: join(locDir, e.name) });
  }
  for (const e of top.filter((x) => x.isDirectory()).sort((a, b) => ordinal(a.name, b.name))) {
    if (e.name === 'LocationPrefab' || regionIndexOf(e.name) < 0) continue; // Development, tools, unknown
    const files = [];
    for (const f of await listDir(join(locDir, e.name))) {
      const rel = `Locations/${e.name}/${f.name}`;
      if (f.isFile() && /\.csv$/i.test(f.name) && inBundle(rel)) files.push({ rel, path: join(locDir, e.name, f.name) });
    }
    addFolder(rel0(e.name), regionNameOf(e.name), files);
  }
  // Root files load for every region in Location Loader; one folder each keeps their memory separate.
  for (const f of rootFiles.sort((a, b) => ordinal(a.rel, b.rel))) addFolder(f.rel, null, [f]);

  let source = bundle ? 'bundle' : 'tree';
  if (!folders.length) {
    const combined = join(root, 'CombinedCSVs');
    for (const f of (await listDir(combined)).sort((a, b) => ordinal(a.name, b.name))) {
      if (f.isFile() && /\.csv$/i.test(f.name)) addFolder(`CombinedCSVs/${f.name}`, null, [{ rel: `CombinedCSVs/${f.name}`, path: join(combined, f.name) }]);
    }
    if (folders.length) source = 'combined';
  }
  folders.sort((a, b) => ordinal(a.key, b.key));

  // Prefabs are found by file name anywhere under LocationPrefab/ (Rocks/, Mountains/ subfolders included), as
  // Location Loader indexes mod assets by name. The first path in ordinal order wins a duplicated name.
  const prefabs = new Map(); // lower-case name -> path
  const found = [];
  const walkPrefabs = async (dir, rel, depth) => {
    for (const f of await listDir(dir)) {
      const r = `${rel}/${f.name}`;
      if (f.isDirectory() && depth < 4) await walkPrefabs(join(dir, f.name), r, depth + 1);
      else if (f.isFile() && /\.txt$/i.test(f.name) && inBundle(r)) found.push({ rel: r, name: f.name, path: join(dir, f.name) });
    }
  };
  await walkPrefabs(join(locDir, 'LocationPrefab'), 'Locations/LocationPrefab', 0);
  for (const f of found.sort((a, b) => ordinal(a.rel, b.rel))) {
    const name = f.name.replace(/\.txt$/i, '').toLowerCase();
    if (!prefabs.has(name)) prefabs.set(name, f.path);
  }

  const towns = [];
  const wd = join(root, 'WorldData');
  for (const f of await listDir(wd)) {
    if (!f.isFile() || !/^location-\d+-\d+\.json$/i.test(f.name)) continue;
    try {
      const d = JSON.parse(await readFile(join(wd, f.name), 'utf8'));
      const lon = d?.MapTableData?.Longitude, lat = d?.MapTableData?.Latitude;
      const area = worldDataTownArea(d?.Exterior?.ExteriorData?.Width, d?.Exterior?.ExteriorData?.Height);
      if (!Number.isInteger(lon) || !Number.isInteger(lat) || !area) continue;
      towns.push({ px: Math.trunc(lon / 128), py: MAP_PIXELS_Y - 1 - Math.trunc(lat / 128), area, name: String(d.Name ?? f.name) });
    } catch {
      /* not a location replacement */
    }
  }
  return { folders, prefabs, towns, bundle: !!bundle, source };
}

const rel0 = (name) => `Locations/${name}`;

/**
 * @param {object} opts
 * @param {string} opts.root  installed tree (contains Locations/)
 * @param {number} [opts.maxFolders=6]  folders (regions) whose rows stay in memory
 * @param {number} [opts.maxPrefabs=512]
 * @param {object} [opts.log]
 */
export function createWodStore({ root, maxFolders = 6, maxPrefabs = 512, log = console } = {}) {
  const absRoot = root ? resolve(root) : null;
  let state = absRoot ? 'loading' : 'missing';
  let note = absRoot ? 'The World of Daggerfall data is being read on the server.' : 'World of Daggerfall is not installed on this server.';
  let tree = null;
  let pixelSlots = null; // Uint8Array, 0 = none, 1..254 = folder slot + 1, 255 = several
  const multi = new Map(); // pixel -> slots[]
  const folderCache = new Lru(maxFolders);
  const prefabCache = new Lru(maxPrefabs);
  const townsByPixel = new Map();
  const stats = { files: 0, instances: 0, skippedRows: 0, folderLoads: 0, prefabLoads: 0 };
  const pk = (px, py) => py * MAP_PIXELS_X + px;

  function readText(path) {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${path} is too large`);
    return readFileSync(path, 'utf8');
  }

  async function init() {
    if (!absRoot) return status();
    try {
      if (!existsSync(join(absRoot, 'Locations')) && !existsSync(join(absRoot, 'CombinedCSVs'))) {
        state = 'missing';
        note = 'World of Daggerfall is not installed on this server.';
        return status();
      }
      tree = await discoverTree(absRoot);
      if (tree.folders.length > 254) throw new Error('too many location folders');
      if (!tree.folders.length) throw new Error('no location files found under Locations/');
      if (!tree.prefabs.size) throw new Error('no prefabs found under Locations/LocationPrefab/');
      for (const t of tree.towns) townsByPixel.set(pk(t.px, t.py), t.area);
      pixelSlots = new Uint8Array(MAP_PIXELS_X * MAP_PIXELS_Y);
      for (let slot = 0; slot < tree.folders.length; slot++) {
        for (const f of tree.folders[slot].files) {
          const { instances, skipped, error } = parseInstanceCsv(await readFile(f.path, 'utf8'));
          stats.files++;
          if (error) {
            log.warn?.(`[wilderness] ${f.rel}: ${error}`);
            continue;
          }
          stats.instances += instances.length;
          stats.skippedRows += skipped;
          for (const inst of instances) {
            // Type 1/3 rows also mark the neighbouring pixels they reach (cheap bound: one pixel).
            const reach = inst.type === 1 || inst.type === 3 ? 1 : 0;
            for (let dx = -reach; dx <= reach; dx++) {
              for (let dy = -reach; dy <= reach; dy++) {
                const px = inst.worldX + dx, py = inst.worldY + dy;
                if (isMapPixel(px, py)) mark(pk(px, py), slot);
              }
            }
          }
        }
      }
      state = 'ready';
      note = '';
      log.info?.(
        `[wilderness] World of Daggerfall: ${stats.instances} instances in ${stats.files} files (${tree.folders.length} folders, ${tree.source}), ${tree.prefabs.size} prefabs`,
      );
    } catch (err) {
      state = 'error';
      note = 'The World of Daggerfall data on this server could not be read.';
      log.error?.(`[wilderness] could not read ${absRoot}: ${err.message}`);
    }
    return status();
  }

  function mark(p, slot) {
    const cur = pixelSlots[p];
    if (cur === 0) pixelSlots[p] = slot + 1;
    else if (cur !== MULTI) {
      if (cur !== slot + 1) {
        pixelSlots[p] = MULTI;
        multi.set(p, [cur - 1, slot]);
      }
    } else {
      const list = multi.get(p);
      if (!list.includes(slot)) list.push(slot);
    }
  }

  function slotsAt(px, py) {
    if (!pixelSlots || !isMapPixel(px, py)) return [];
    const v = pixelSlots[pk(px, py)];
    if (v === 0) return [];
    if (v !== MULTI) return [v - 1];
    return [...multi.get(pk(px, py))].sort((a, b) => a - b);
  }

  /** Loads one folder's rows (sync; small files) into the LRU. */
  function folder(slot) {
    let f = folderCache.get(slot);
    if (f) return f;
    const def = tree.folders[slot];
    const byPixel = new Map();
    for (const file of def.files) {
      const { instances, error } = parseInstanceCsv(readText(file.path));
      if (error) continue;
      for (const inst of instances) {
        inst.file = file.rel;
        const p = pk(inst.worldX, inst.worldY);
        if (!isMapPixel(inst.worldX, inst.worldY)) continue;
        let list = byPixel.get(p);
        if (!list) byPixel.set(p, (list = []));
        list.push(inst);
      }
    }
    f = { slot, region: def.region, byPixel };
    folderCache.set(slot, f);
    stats.folderLoads++;
    return f;
  }

  function prefab(name) {
    const key = String(name).toLowerCase();
    if (prefabCache.has(key)) return prefabCache.get(key);
    const path = tree?.prefabs.get(key);
    let p = null;
    if (path) {
      try {
        p = parsePrefabXml(readText(path));
      } catch (err) {
        log.warn?.(`[wilderness] prefab ${name}: ${err.message}`);
      }
    }
    prefabCache.set(key, p);
    stats.prefabLoads++;
    return p;
  }

  const townAreaAt = (px, py) => townsByPixel.get(pk(px, py)) ?? null;

  /**
   * Every row whose own pixel is (px, py), in load order, with site ids, region and placement verdict.
   * @returns {Array<{id, inst, prefab, region, reject}>}
   */
  function rowsAt(px, py) {
    if (state !== 'ready') return [];
    const rows = [];
    for (const slot of slotsAt(px, py)) {
      const f = folder(slot);
      const list = f.byPixel.get(pk(px, py));
      if (list) for (const inst of list) rows.push({ inst, region: f.region ?? inst.region ?? null });
    }
    const ids = assignSiteIds(rows.map((r) => r.inst));
    return rows.map((r, i) => {
      const pf = prefab(r.inst.prefab);
      return { id: ids[i], inst: r.inst, prefab: pf, region: r.region, reject: rejectReason(r.inst, pf, townAreaAt) };
    });
  }

  /** Placed sites standing on (px, py): its own rows plus neighbours' type 1/3 rows that reach into it. */
  function placedAt(px, py) {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = px + dx, ny = py + dy;
        if (!isMapPixel(nx, ny)) continue;
        for (const r of rowsAt(nx, ny)) {
          if (r.reject) continue;
          if (dx || dy) {
            if (r.inst.type !== 1 && r.inst.type !== 3) continue;
            const reaches = overlappingSections(r.inst, r.prefab).some((s) => s.px === px && s.py === py);
            if (!reaches) continue;
          }
          out.push({ ...r, offsetPx: [dx, dy] });
        }
      }
    }
    return out;
  }

  /** Composed scene sites for a pixel (frame of that pixel). */
  function sceneSites(px, py) {
    return placedAt(px, py).map((r) =>
      composeSite(r.inst, r.prefab, { id: r.id, file: r.inst.file, region: r.region ?? undefined, offsetPx: r.offsetPx, getPrefab: prefab }),
    );
  }

  /** Lightweight summary of a placed site row. */
  function summary(r) {
    const kind = siteKind(r.inst.name, r.inst.prefab, r.inst.file);
    return {
      id: r.id,
      name: displayName(r.inst.name, r.inst.prefab),
      kind,
      prefab: r.inst.prefab,
      px: r.inst.worldX,
      py: r.inst.worldY,
      tx: r.inst.terrainX,
      ty: r.inst.terrainY,
      region: r.region,
      poi: isPointOfInterest(kind),
    };
  }

  /** A placed site by id, or null (unknown, stale or not placed). */
  function site(id, parsed) {
    if (!parsed) return null;
    const r = rowsAt(parsed.px, parsed.py).find((x) => x.id === id);
    return r && !r.reject ? summary(r) : null;
  }

  /** Points of interest whose own pixel is within `radius` map pixels of (px, py), nearest first. */
  function nearby(px, py, radius, limit = 24) {
    const out = [];
    const R = Math.ceil(radius);
    const cx = px + 0.5, cy = py + 0.5;
    for (let y = py - R; y <= py + R; y++) {
      for (let x = px - R; x <= px + R; x++) {
        if (!slotsAt(x, y).length) continue;
        for (const r of rowsAt(x, y)) {
          if (r.reject) continue;
          const s = summary(r);
          if (!s.poi) continue;
          // Position inside the pixel: terrainX east, terrainY north (pixel y grows south).
          const sx = x + r.inst.terrainX / TERRAIN_SIZE, sy = y + 1 - r.inst.terrainY / TERRAIN_SIZE;
          const d = Math.hypot(sx - cx, sy - cy);
          if (d > radius) continue;
          out.push({ ...s, distance: Math.round(d * 100) / 100 });
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance || ordinal(a.id, b.id));
    return out.slice(0, limit);
  }

  function status() {
    return {
      pack: state,
      note,
      source: tree?.source ?? null,
      files: stats.files,
      instances: stats.instances,
      skippedRows: stats.skippedRows,
      folders: tree?.folders.length ?? 0,
      prefabs: tree?.prefabs.size ?? 0,
      residentFolders: folderCache.size,
      maxFolders,
      residentPrefabs: prefabCache.size,
      folderLoads: stats.folderLoads,
      prefabLoads: stats.prefabLoads,
    };
  }

  /** Region name for a pixel from the source folders standing there (null when only root files or none). */
  function regionAt(px, py) {
    for (const slot of slotsAt(px, py)) if (tree.folders[slot].region) return tree.folders[slot].region;
    return null;
  }

  return {
    init,
    status,
    get ready() {
      return state === 'ready';
    },
    rowsAt,
    placedAt,
    sceneSites,
    site,
    nearby,
    regionAt,
    hasRows: (px, py) => slotsAt(px, py).length > 0,
    root: absRoot,
    _relative: (p) => (absRoot ? toPosix(relative(absRoot, p)) : p),
  };
}
