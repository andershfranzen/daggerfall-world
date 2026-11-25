// World of Daggerfall model support on the server: release audit, ARCH3D mesh loading for the
// mod's placed pieces, and collision triangles for stretched rock/mountain pebbles.
//
// Everything is read from operator-supplied local data (ARENA2 and the ignored
// gamedata/world-of-daggerfall clone) at runtime. Nothing from the mod is copied or served.
// The shared geometry lives in client/world/wilderness/models.js so the browser draws the
// same surfaces the server collides with.
//
// Release audit (docs/world-of-daggerfall.md): WorldOfDaggerfall.dfmod.json lists what the mod
// ships. Its CSVs place layouts (Locations/LocationPrefab/*.txt). A layout object of type 0 is an
// ARCH3D model, type 3 an embedded layout, type 4 a mod Unity prefab by name (numeric type-4
// names are ARCH3D models). At 3bf8837, 47 distinct mod prefabs (WOD_Rock_*, Mountain_*) are
// placed ~1.1M times besides ~180k stretched ARCH3D rock pebbles. Custom prefabs are converted
// on demand by the shared loader (client/world/wilderness/models.js) from the operator's pack.
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, basename, resolve, sep } from 'node:path';
import { BsaArchive, NUMBER_RECORD } from '../../../client/world/bsa.js';
import { decodeMesh, patchRecord } from '../../../client/world/arch3d.js';
import { indexFiles, requireFiles } from '../../../client/world/files.js';
import {
  WOD_ROCK_MODELS,
  modelPlanesToMetres,
  pieceCollisionPositions,
  pieceStretch,
  buildWodPackIndex,
  loadCustomPrefab,
  customCollisionPositions,
  prefabMatrix,
} from '../../../client/world/wilderness/models.js';

export * from '../../../client/world/wilderness/models.js';

// ---------------------------------------------------------------------------------------------
// Placement matrix (same convention as the renderer's scene.js modelMatrix):
//   scene = T(position + [0, lift, 0]) * R(quaternion) * S(scale) * Zflip
// position/rotation/scale are already in the right-handed scene frame (north = -z); town.js
// model metres are left-handed, so z is negated before R.
// ---------------------------------------------------------------------------------------------
export function composeModelMatrix(object, lift = 0) {
  const [px, py, pz] = object.position ?? [0, 0, 0];
  const [qx, qy, qz, qw] = object.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = object.scale ?? [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  const r = [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)];
  return [
    r[0] * sx, r[1] * sx, r[2] * sx, 0,
    r[3] * sy, r[4] * sy, r[5] * sy, 0,
    -r[6] * sz, -r[7] * sz, -r[8] * sz, 0,
    px, py + lift, pz, 1,
  ];
}

// ---------------------------------------------------------------------------------------------
// ARCH3D meshes
// ---------------------------------------------------------------------------------------------

/**
 * Decode the given ARCH3D model ids from the operator's files (File/Blob list, as for loadTown),
 * converted to model metres. Missing ids are reported, not thrown.
 * @returns {Promise<{meshes: Map<number, {id, planes}>, missing: number[]}>}
 */
export async function loadArch3dMeshes(files, ids) {
  const [archF] = requireFiles(indexFiles(files), ['ARCH3D.BSA']);
  const arch = await BsaArchive.open(archF, 'ARCH3D.BSA', NUMBER_RECORD);
  const meshes = new Map();
  const missing = [];
  for (const id of new Set(ids)) {
    const k = arch.indexOfId(id);
    if (k < 0) {
      missing.push(id);
      continue;
    }
    const bytes = await arch.read(k);
    patchRecord(bytes, arch.entries[k].position);
    meshes.set(id, modelPlanesToMetres(decodeMesh(bytes, id)));
  }
  return { meshes, missing };
}

// ---------------------------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------------------------

/**
 * Collision triangles for a site's model pieces, to be concatenated with its terrain triangles
 * and passed to `new CollisionWorld({positions})`.
 * @param {Array<{kind?:string, model?:number, modelId?:number, matrix?:ArrayLike<number>, position?, rotation?, scale?}>} objects
 * @param {Map<number, {id, planes}>} meshes  model metres (loadArch3dMeshes)
 * @param {{lift?: number, matrixOf?: (object, lift:number) => ArrayLike<number>, maxExtent?: number}} [opts]
 *   maxExtent: pieces stretched past this many metres on an axis are skipped and counted (a
 *   piece larger than the playable area would only put the player inside a solid).
 * @returns {{positions: Float32Array, pieces: number, rockPieces: number, skipped: Array<{model, reason}>}}
 */
export function wildernessCollisionTriangles(objects, meshes, opts = {}) {
  const lift = opts.lift ?? 0;
  const matrixOf = opts.matrixOf ?? composeModelMatrix;
  const maxExtent = opts.maxExtent ?? 8192;
  const customs = opts.customs ?? new Map();
  const out = [];
  const skipped = [];
  let pieces = 0, rockPieces = 0, assetPieces = 0;
  for (const o of objects) {
    const kind = o.kind ?? (typeof (o.modelId ?? o.model) === 'number' ? 'model' : 'asset');
    if (kind === 'asset' || kind === 'prefab') {
      const custom = customs.get(o.asset ?? o.name);
      if (!custom) {
        skipped.push({ asset: o.asset ?? o.name, reason: 'custom prefab not loaded' });
        continue;
      }
      if (!custom.meshCollider) continue; // Unity: no collider, walk through
      const m = prefabMatrix(o.matrix ?? matrixOf(o, lift), custom);
      if (pieceStretch(m) * Math.max(...custom.bounds.max.map((v, k) => v - custom.bounds.min[k])) > maxExtent) {
        skipped.push({ asset: o.asset ?? o.name, reason: `larger than ${maxExtent} m` });
        continue;
      }
      customCollisionPositions(custom, m, out);
      assetPieces++;
      continue;
    }
    if (kind !== 'model') continue;
    const id = o.modelId ?? o.model;
    const mesh = meshes.get(id);
    if (!mesh) {
      skipped.push({ model: id, reason: 'mesh not loaded' });
      continue;
    }
    const m = o.matrix ?? matrixOf(o, lift);
    if (pieceStretch(m) * 6 > maxExtent) {
      skipped.push({ model: id, reason: `stretched past ${maxExtent} m` });
      continue;
    }
    pieceCollisionPositions(mesh, m, out);
    pieces++;
    if (WOD_ROCK_MODELS.has(id)) rockPieces++;
  }
  return { positions: new Float32Array(out), pieces, rockPieces, assetPieces, skipped };
}

// ---------------------------------------------------------------------------------------------
// Release audit (Node, operator pack on disk)
// ---------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Objects of a Location Loader layout (.txt XML): [{type, name, scale:[x,y,z]}]. */
export function parseLayoutObjects(text) {
  const objs = [];
  for (const m of text.matchAll(/<object>([\s\S]*?)<\/object>/g)) {
    const get = (tag) => new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(m[1])?.[1];
    objs.push({
      type: Number(get('type') ?? 0),
      name: get('name') ?? '',
      scale: ['scaleX', 'scaleY', 'scaleZ'].map((k) => Number(get(k) ?? 1)),
    });
  }
  return objs;
}

/**
 * What the release actually places. Reads the manifest, its CSVs and the layouts they name;
 * nothing else in the pack is opened.
 * @param {string} root  pack root (contains WorldOfDaggerfall.dfmod.json)
 */
export function auditWodModels(root) {
  const manifestPath = join(root, 'WorldOfDaggerfall.dfmod.json');
  if (!existsSync(manifestPath)) throw new Error(`no WorldOfDaggerfall.dfmod.json in ${root}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bundled = new Set((manifest.Files ?? []).map((f) => basename(f)));
  const files = walk(root);
  const bundledPath = new Map();
  // Location Loader / DFU asset lookups are case-insensitive (WOD_Prop_ScoutTower vs wod_prop_scouttower).
  for (const f of files) if (bundled.has(basename(f))) bundledPath.set(basename(f).toLowerCase(), f);

  const layoutUses = new Map(); // layout name -> CSV placements
  let placements = 0;
  for (const [name, f] of bundledPath) {
    if (!name.toLowerCase().endsWith('.csv')) continue;
    const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    const head = splitCsvLine(lines[0]).map((h) => h.trim());
    const pi = head.indexOf('prefab');
    if (pi < 0) continue;
    for (const l of lines.slice(1)) {
      const n = splitCsvLine(l)[pi]?.trim();
      if (!n) continue;
      placements++;
      layoutUses.set(n, (layoutUses.get(n) ?? 0) + 1);
    }
  }

  const customPrefabs = new Set([...bundled].filter((b) => b.endsWith('.prefab')).map((b) => b.slice(0, -7).toLowerCase()));
  const models = new Map(); // id -> {instances, maxScale}
  const custom = new Map(); // name -> {instances, layouts:Set, bundledPrefab}
  const missingLayouts = [];
  const visit = (layout, uses, depth) => {
    const f = bundledPath.get(`${layout}.txt`.toLowerCase());
    if (!f) {
      if (!missingLayouts.includes(layout)) missingLayouts.push(layout);
      return;
    }
    for (const o of parseLayoutObjects(readFileSync(f, 'utf8'))) {
      if (o.type === 3 && depth < 4) visit(o.name, uses, depth + 1);
      if (o.type !== 0 && o.type !== 4) continue;
      const name = o.type === 4 ? o.name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '') : o.name;
      if (/^\d+$/.test(name)) {
        const id = Number(name);
        const e = models.get(id) ?? { instances: 0, maxScale: 0 };
        e.instances += uses;
        e.maxScale = Math.max(e.maxScale, ...o.scale.map(Math.abs));
        models.set(id, e);
      } else if (o.type === 4) {
        const e = custom.get(name) ?? { instances: 0, layouts: new Set(), bundledPrefab: customPrefabs.has(name.toLowerCase()), maxScale: 0 };
        e.instances += uses;
        e.layouts.add(layout);
        e.maxScale = Math.max(e.maxScale, ...o.scale.map(Math.abs));
        custom.set(name, e);
      }
    }
  };
  for (const [layout, uses] of layoutUses) visit(layout, uses, 0);
  const rock = [...models].filter(([id]) => WOD_ROCK_MODELS.has(id));
  return {
    title: manifest.ModTitle,
    version: manifest.ModVersion,
    bundledFiles: bundled.size,
    bundledPrefabs: customPrefabs.size,
    bundledCsvs: [...bundled].filter((b) => b.toLowerCase().endsWith('.csv')).length,
    placements,
    layouts: layoutUses.size,
    missingLayouts,
    arch3dModels: models.size,
    rockPebbles: Object.fromEntries(rock.map(([id, e]) => [id, e])),
    rockPebbleInstances: rock.reduce((s, [, e]) => s + e.instances, 0),
    referencedCustom: [...custom]
      .sort((a, b) => b[1].instances - a[1].instances)
      .map(([name, e]) => ({ name, instances: e.instances, layouts: e.layouts.size, maxScale: e.maxScale, bundledPrefab: e.bundledPrefab })),
    customInstances: [...custom.values()].reduce((s, e) => s + e.instances, 0),
  };
}

/** Pack-relative paths ('/'-separated) of regular files under root (no symlinks, no .git). */
export function listPackPaths(root) {
  const out = [];
  const rec = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  rec(root, '');
  return out;
}

/** read(path) for the shared loader: only listed pack files, never outside root. */
export function packReader(root, paths) {
  const base = resolve(root);
  const allowed = new Set(paths);
  return async (rel) => {
    if (!allowed.has(rel)) return null;
    const full = resolve(base, rel);
    if (!full.startsWith(base + sep)) return null;
    try {
      if (lstatSync(full).isSymbolicLink()) return null;
      return new Uint8Array(await readFile(full));
    } catch {
      return null;
    }
  };
}

/**
 * Server-side cache of the operator's pack index and converted custom prefabs (for collision and
 * status). Bounded: at most `max` prefabs are kept (the release references 47).
 */
export function createWodModelStore({ root, max = 128 } = {}) {
  let ready = null;
  const customs = new Map();
  const init = () =>
    (ready ??= (async () => {
      const paths = listPackPaths(root);
      const read = packReader(root, paths);
      const index = await buildWodPackIndex(paths, read);
      return { paths, read, index };
    })());
  return {
    root,
    index: async () => (await init()).index,
    reader: async () => (await init()).read,
    /** Converted custom prefab or null (not in the pack). Cached. */
    async custom(name) {
      if (customs.has(name)) return customs.get(name);
      const { index, read } = await init();
      const p = loadCustomPrefab(index, read, name).catch((err) => {
        customs.delete(name);
        throw err;
      });
      customs.set(name, p);
      if (customs.size > max) customs.delete(customs.keys().next().value);
      return p;
    },
    /** Map(name -> custom) for every asset object of a scene that the pack provides. */
    async customsFor(objects) {
      const names = [...new Set(objects.filter((o) => o.kind === 'asset' || o.kind === 'prefab').map((o) => o.asset ?? o.name))];
      const out = new Map();
      for (const n of names) {
        const c = await this.custom(n);
        if (c) out.set(n, c);
      }
      return out;
    },
  };
}

/** Is `dir` a usable pack root? (cheap; for status reporting) */
export function isWodPack(dir) {
  try {
    return statSync(join(dir, 'WorldOfDaggerfall.dfmod.json')).isFile();
  } catch {
    return false;
  }
}
