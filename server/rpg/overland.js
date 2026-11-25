// Walking between a classic exterior and the World of Daggerfall wilderness (docs/overland.md).
//
// Owns the authoritative "walk across an edge" transitions:
//   town:Region/Name  --(walk past the town's block-grid edge)-->  wilderness:<px>,<py> or a neighbouring town
//   wilderness:<px>,<py> --(walk past the map-pixel edge)-->        the neighbouring pixel (or a town filling it)
//   wilderness:<px>,<py> --(walk into the classic location rect)--> town:Region/Name at the matching street edge
//
// Every position is converted through one global frame, so the side you leave by is the side you
// arrive on, and a transition can only ever reach the same or an adjacent map pixel.
//
// Frames (all metres, +x east, +z SOUTH i.e. -z north, y up):
//   wilderness:<px>,<py>  origin at the map pixel's centre; the pixel spans x,z in [-409.6, 409.6]
//                         (docs/wilderness-protocol.md "Frame").
//   town:Region/Name      origin at the town's spawn (client/world/README.md). In DFU's left-handed
//                         location space (origin at the SW corner of the block grid, +z north) the
//                         spawn is town.source.spawnLocal, so ux = x + spawnLocal.x, uz = spawnLocal.z - z.
//   global                E = px*819.2 + 409.6 + xw, S = py*819.2 + 409.6 + zw. Map pixel y grows
//                         southward (MapsFile.MapPixelToWorldCoord: worldZ = (499 - py) * 32768), so
//                         S grows south too and pixels tile without flips.
// A classic location sits inside its map pixel at TerrainHelper.GetLocationTerrainTileOrigin
// (centred: (128 - width*16)/2 tiles of 6.4 m; 1x1 "CUST" blocks at tile 72,55), as
// DaggerfallLocation.GetLocationRect does (MIT, (c) 2009-2023 Daggerfall Workshop).
//
// Services used when present: collision (arrival checks and preloading), travel (discover a town you
// walk into), wilderness (isWilderness/parse/onEnter). Fast travel is untouched.
//
// Emits ctx.emit('overland', {player, from, to, side}) and a private {kind:'overland'} game event.

import { arena2Files } from './collision/arena2.js';
import { loadTown } from '../../client/world/town.js';
import { readCatalog, parseLocationId } from '../../client/gameplay/travel/catalog.js';

export const name = 'overland';

import { townFrame, townToWild, wildToTown, toGlobal, fromGlobal, inPixel, HALF } from '../../client/world/exterior/frame.js';
import { parseWildernessId, wildernessId, MAP_PIXELS_X as MAP_W, MAP_PIXELS_Y as MAP_H } from '../../client/world/wilderness/data.js';
export { townFrame, tileOrigin, townToWild, wildToTown, toGlobal, fromGlobal, HALF, PIXEL, TILE, BLOCK } from '../../client/world/exterior/frame.js';
export { parseWildernessId, wildernessId, MAP_W, MAP_H };

/** Float32 mesh bounds and map coordinates can differ by a fraction of a millimetre. */
export const EDGE = 0.0001;
// Check the road beyond the seam before committing. This point is never a spawn.
const PROBE = 2.5;
const PREFETCH = 64;
const ENTER_DEPTH = 6;
const NOTICE_MS = 5000;
const MAX_META = 48;

const PIXEL_BOUNDS = { minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF };
const inRect = (r, x, z) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
const clampIn = (v, lo, hi, inset) => Math.min(Math.max(v, lo + inset), hi - inset);

/** Direction of travel from the player's held input (same formula as server/game.js). */
export function inputDirection(p) {
  const f = Number.isFinite(p.forward) ? p.forward : 0;
  const st = Number.isFinite(p.strafe) ? p.strafe : 0;
  if (f === 0 && st === 0) return null;
  const s = Math.sin(p.yaw || 0), c = Math.cos(p.yaw || 0);
  let vx = s * f + c * st, vz = -c * f + s * st;
  const len = Math.hypot(vx, vz);
  if (len < 1e-6) return null;
  vx /= len;
  vz /= len;
  return { vx, vz };
}

/**
 * Which edges of `b` a walker at (x,z) moving along `dir` is pushing through.
 * @returns {{ox:number, oz:number}|null} outward unit steps (-1, 0, +1) per axis
 */
export function pushedEdges(b, x, z, dir, edge = EDGE) {
  let ox = 0, oz = 0;
  if (x <= b.minX + edge && (x < b.minX - EDGE || (dir && dir.vx < -1e-6))) ox = -1;
  else if (x >= b.maxX - edge && (x > b.maxX + EDGE || (dir && dir.vx > 1e-6))) ox = 1;
  if (z <= b.minZ + edge && (z < b.minZ - EDGE || (dir && dir.vz < -1e-6))) oz = -1;
  else if (z >= b.maxZ - edge && (z > b.maxZ + EDGE || (dir && dir.vz > 1e-6))) oz = 1;
  return ox || oz ? { ox, oz } : null;
}

const SIDES = { '0,-1': 'north', '0,1': 'south', '-1,0': 'west', '1,0': 'east', '-1,-1': 'north-west', '1,-1': 'north-east', '-1,1': 'south-west', '1,1': 'south-east' };
export const sideName = (ox, oz) => SIDES[`${Math.sign(ox)},${Math.sign(oz)}`] ?? '';

// ---------------------------------------------------------------------------- data loaders

/** Default: every MAPS.BSA location with its map pixel, from the operator's ARENA2. */
function arena2CatalogLoader(dataPath, worldData) {
  return async () => {
    const files = await arena2Files(dataPath);
    const maps = files.find((f) => /^MAPS\.BSA$/i.test(f.name));
    if (!maps) throw new Error('MAPS.BSA is not in the server data directory');
    return (await readCatalog(maps, worldData)).locations;
  };
}

/** Default: town placement from the same loader the browser and collision use. Only `source` is kept. */
function arena2MetaLoader(dataPath, worldData = null) {
  let files = null;
  return async (entry) => {
    files ??= await arena2Files(dataPath);
    const t = await loadTown(files, { region: entry.regionIndex, location: entry.index, worldData });
    const s = t.source;
    return {
      width: s.width,
      height: s.height,
      spawnLocal: { x: s.spawnLocal.x, z: s.spawnLocal.z },
      custom: s.width === 1 && s.height === 1 && /^CUST/i.test(s.blocks?.[0]?.name ?? ''),
    };
  };
}

// ---------------------------------------------------------------------------- feature

/**
 * @param {object} ctx
 * @param {object} [opts]
 * @param {() => Promise<object[]>} [opts.loadCatalog]  [{id, region, name, x, y}] map-pixel catalogue
 * @param {(entry) => Promise<{width,height,spawnLocal,custom?}>} [opts.loadMeta]  town placement
 */
export function install(ctx, opts = {}) {
  const log = ctx.log ?? console;
  const loadCatalog = opts.loadCatalog ?? (ctx.dataPath ? arena2CatalogLoader(ctx.dataPath, ctx.services?.worldData?.ready) : null);
  const loadMeta = opts.loadMeta ?? (ctx.dataPath ? arena2MetaLoader(ctx.dataPath, ctx.services?.worldData?.ready) : null);
  const ext = Number.isFinite(ctx.config?.worldHalfExtent) ? ctx.config.worldHalfExtent : Infinity;

  let status = loadCatalog ? 'loading' : 'missing';
  let statusNote = loadCatalog ? null : 'No Daggerfall data is configured on this server, so towns have no surrounding wilderness.';
  const byId = new Map(); // town id -> {id, region, name, px, py}
  const byPixel = new Map(); // px*1000+py... -> entry
  const metas = new Map(); // town id -> {status:'loading'|'ready'|'error', frame?, error?, promise}
  const notices = new Map(); // player id -> {key, at}
  const warnedExtent = new Set();

  const pixelKey = (px, py) => py * MAP_W + px;
  let tickNow = null; // rate-limit notices on the tick clock
  const clock = () => tickNow ?? ctx.now();

  const ready = !loadCatalog
    ? Promise.resolve()
    : Promise.resolve()
        .then(loadCatalog)
        .then(
          (locations) => {
            for (const l of locations) {
              const entry = { id: l.id, region: l.region, regionIndex: l.regionIndex, index: l.index, name: l.name, px: l.x, py: l.y };
              if (!byId.has(entry.id)) byId.set(entry.id, entry);
              const k = pixelKey(entry.px, entry.py);
              if (!byPixel.has(k)) byPixel.set(k, entry); // MAPS.BSA has one location per pixel; keep the first
            }
            status = 'ready';
            log.info?.(`[overland] ${byId.size} classic locations placed on the map`);
            for (const p of ctx.players.values()) warm(p);
          },
          (err) => {
            status = 'error';
            statusNote = `The world map could not be read (${err.message}); walking out of town is disabled.`;
            log.error?.(`[overland] ${statusNote}`);
          },
        );

  /** Placement of a town, or null while it loads / when it cannot be placed. Starts loading on demand. */
  function frameOf(id) {
    const entry = byId.get(id);
    if (!entry || !loadMeta) return null;
    let m = metas.get(id);
    if (!m) {
      if (metas.size >= MAX_META) {
        for (const [k, v] of metas) if (v.status !== 'loading') { metas.delete(k); break; }
      }
      m = { status: 'loading', frame: null };
      metas.set(id, m);
      m.promise = Promise.resolve()
        .then(() => loadMeta(entry))
        .then(
          (meta) => {
            m.frame = townFrame({ id, px: entry.px, py: entry.py, ...meta });
            m.status = 'ready';
            const w = m.frame.walk;
            if (Math.max(-w.minX, w.maxX, -w.minZ, w.maxZ) > ext - EDGE && !warnedExtent.has(id)) {
              warnedExtent.add(id);
              log.warn?.(`[overland] ${id}: the town reaches past worldHalfExtent (${ext} m); raise WORLD_HALF_EXTENT to at least 820 so its far edge can be walked out of`);
            }
          },
          (err) => {
            m.status = 'error';
            m.error = err.message;
            log.warn?.(`[overland] ${id}: cannot place the town on the map: ${err.message}`);
          },
        );
    }
    return m.status === 'ready' ? m.frame : null;
  }

  const townAt = (px, py) => px >= 0 && px < MAP_W && py >= 0 && py < MAP_H ? byPixel.get(pixelKey(px, py)) ?? null : null;

  /** Load placements for the player's town and the classic locations in the 3x3 pixels around them. */
  function warm(p) {
    if (status !== 'ready') return;
    const here = pixelOf(p);
    if (!here) return;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = townAt(here.px + dx, here.py + dy);
        if (t) frameOf(t.id);
      }
    }
    // Someone in the wilderness around a town may walk into it: have its collision ready.
    const home = parseWilderness(p.rpg?.location) ? townAt(here.px, here.py) : null;
    if (home) ctx.services.collision?.preload?.(home.id);
    // Every crossing is swept on the surrounding pixel surface; have it ready before the edge.
    else ctx.services.collision?.preload?.(wildernessId(here.px, here.py));
  }

  function pixelOf(p) {
    const loc = p.rpg?.location;
    const w = parseWilderness(loc);
    if (w) return w;
    const t = byId.get(loc);
    return t ? { px: t.px, py: t.py } : null;
  }

  const parseWilderness = (id) => ctx.services.wilderness?.parse?.(id) ?? parseWildernessId(id);

  function notice(p, key, text) {
    const now = clock();
    const last = notices.get(p.id);
    if (last && last.key === key && now - last.at < NOTICE_MS) return;
    notices.set(p.id, { key, at: now });
    ctx.notify(p, { kind: 'overland', status: key, text });
  }

  const collision = () => ctx.services.collision;

  /**
   * Resolve a global point to a destination. Returns
   *   {kind:'town', id, frame, x, z} | {kind:'wild', id, px, py, x, z} | {kind:'pending'} | {kind:'edge'}
   */
  function destinationAt(e, s) {
    const g = fromGlobal(e, s);
    if (g.px < 0 || g.py < 0 || g.px >= MAP_W || g.py >= MAP_H) return { kind: 'edge' };
    const t = townAt(g.px, g.py);
    if (t) {
      const f = frameOf(t.id);
      if (!f) return { kind: 'pending', id: t.id };
      if (inRect(f.rect, g.x, g.z)) {
        const local = wildToTown(f, g.x, g.z);
        const w = f.walk;
        return { kind: 'town', id: t.id, name: t.name, frame: f, x: clampIn(local.x, w.minX, w.maxX, PROBE), z: clampIn(local.z, w.minZ, w.maxZ, PROBE) };
      }
    }
    return wildDest(g);
  }

  const wildDest = (g) => ({ kind: 'wild', id: wildernessId(g.px, g.py), px: g.px, py: g.py, x: clampIn(g.x, -HALF, HALF, 0.05), z: clampIn(g.z, -HALF, HALF, 0.05) });

  /** Sweep the whole handoff in a pixel scene containing the models on both
   * sides. A clear endpoint alone can sit just beyond a thin wall. */
  function arrivalPoint(p, dest) {
    const c = collision();
    if (!c) return null;
    const from = p.rpg.location;
    const pixel = parseWilderness(from) ?? parseWilderness(dest.id) ?? dest.frame;
    const surface = wildernessId(pixel.px, pixel.py);
    for (const id of new Set([from, dest.id, surface])) {
      const state = c.status(id).status;
      if (state === 'loading') return 'pending';
      if (state !== 'ready') return null;
    }
    if (!c.isClear(dest.id, dest.x, dest.z)) return null;
    const start = service.globalOf(from, p.x, p.z);
    const end = service.globalOf(dest.id, dest.x, dest.z);
    const a = inPixel(pixel.px, pixel.py, start.e, start.s);
    const b = inPixel(pixel.px, pixel.py, end.e, end.s);
    if (!c.canWalkSegment(surface, a.x, a.z, b.x, b.z)) return null;
    const local = service.localOf(dest.id, start.e, start.s);
    return local && c.isClear(dest.id, local.x, local.z) ? local : null;
  }

  function commit(p, from, dest, at, side) {
    const prevPx = pixelOf(p);
    const next = dest.kind === 'town' ? { px: dest.frame.px, py: dest.frame.py } : { px: dest.px, py: dest.py };
    if (!prevPx || Math.abs(prevPx.px - next.px) > 1 || Math.abs(prevPx.py - next.py) > 1) {
      log.warn?.(`[overland] refused a non-adjacent step ${from} -> ${dest.id}`);
      return false;
    }
    // The client may still be loading the destination's native town origin.
    const shift = { x: at.x - p.x, z: at.z - p.z };
    p.rpg.location = dest.id;
    p.x = at.x;
    p.z = at.z;
    const t = p.rpg.travel;
    if (dest.kind === 'town') {
      if (t && typeof t === 'object') t.lastTown = dest.id;
      ctx.services.travel?.discover?.(p, dest.id);
    } else {
      try {
        ctx.services.wilderness?.onEnter?.(p, dest.id);
      } catch (err) {
        log.warn?.(`[overland] wilderness.onEnter failed: ${err.message}`);
      }
    }
    collision()?.preload?.(dest.id);
    ctx.dirty(p);
    const fromTown = byId.get(from);
    const name = dest.kind === 'town' ? dest.name.trim() : null;
    const text = dest.kind === 'town'
      ? `You walk into ${name}.`
      : fromTown
        ? `You leave ${fromTown.name.trim()} by the ${side} road and walk into the wilderness.`
        : `You walk ${side} into the next stretch of wilderness.`;
    ctx.notify(p, { kind: 'overland', status: 'moved', from, to: dest.id, side, shift, px: next.px, py: next.py, text });
    ctx.emit('overland', { player: p, from, to: dest.id, side });
    warm(p);
    return true;
  }

  /** One walker per tick. Returns true when the player changed location. */
  function step(p) {
    const loc = p.rpg?.location;
    if (typeof loc !== 'string') return false;
    const dir = inputDirection(p);
    if (!dir) return false;
    // Start the next collision load while there is still walking time left.
    const herePixel = pixelOf(p);
    if (herePixel) {
      const f = byId.has(loc) && frameOf(loc);
      const pos = f ? townToWild(f, p.x, p.z) : p;
      const near = pushedEdges(PIXEL_BOUNDS, pos.x, pos.z, dir, PREFETCH);
      if (near) {
        const px = herePixel.px + near.ox, py = herePixel.py + near.oz;
        if (px >= 0 && py >= 0 && px < MAP_W && py < MAP_H) {
          collision()?.preload?.(wildernessId(px, py));
          const town = townAt(px, py);
          if (town && town.id !== loc) collision()?.preload?.(town.id);
        }
      }
    }

    // -------- in a classic exterior
    if (parseLocationId(loc)) {
      if (!byId.has(loc)) return false;
      const f = frameOf(loc);
      if (!f) return false;
      const push = pushedEdges(f.walk, p.x, p.z, dir);
      if (!push) return false;
      const w = f.walk;
      // Snap only the sub-millimetre difference between map and float32 mesh bounds.
      p.x = clampIn(p.x, w.minX, w.maxX, 0);
      p.z = clampIn(p.z, w.minZ, w.maxZ, 0);
      const tx = push.ox < 0 ? w.minX - PROBE : push.ox > 0 ? w.maxX + PROBE : p.x;
      const tz = push.oz < 0 ? w.minZ - PROBE : push.oz > 0 ? w.maxZ + PROBE : p.z;
      const wpos = townToWild(f, tx, tz);
      const g = toGlobal(f.px, f.py, wpos.x, wpos.z);
      const dest = destinationAt(g.e, g.s);
      const side = sideName(push.ox, push.oz);
      if (dest.kind === 'edge') return notice(p, 'edge', 'Beyond here the map of the Iliac Bay ends.'), false;
      if (dest.kind === 'pending') return false; // neighbour still loading; the wall of the town holds them a moment
      if (dest.id === loc) return false;
      const at = arrivalPoint(p, dest);
      if (at === 'pending') return false;
      if (!at) return notice(p, 'blocked', `The way ${side} out of ${byId.get(loc).name.trim()} is blocked here.`), false;
      return commit(p, loc, dest, at, side);
    }

    // -------- in the wilderness
    const here = parseWilderness(loc);
    if (!here) return false;
    if (status !== 'ready') return false;

    // Walking into the classic location that stands in this pixel.
    const t = townAt(here.px, here.py);
    if (t) {
      const f = frameOf(t.id);
      if (f && inRect(f.rect, p.x, p.z)) {
        const r = f.rect;
        const depths = [p.x - r.minX, r.maxX - p.x, p.z - r.minZ, r.maxZ - p.z];
        const depth = Math.min(...depths);
        const k = depths.indexOf(depth);
        const ox = k === 0 ? -1 : k === 1 ? 1 : 0, oz = k === 2 ? -1 : k === 3 ? 1 : 0; // the side of the rect crossed
        // Only someone walking in through that side is taken into the town (not someone leaving it).
        const inward = dir && (ox ? -ox * dir.vx : -oz * dir.vz) > 1e-6;
        if (depth <= ENTER_DEPTH && inward) {
          const local = wildToTown(f, p.x, p.z);
          const w = f.walk;
          const dest = { kind: 'town', id: t.id, name: t.name, frame: f, x: clampIn(local.x, w.minX, w.maxX, PROBE), z: clampIn(local.z, w.minZ, w.maxZ, PROBE) };
          const at = arrivalPoint(p, dest);
          const holdOut = () => {
            // Keep them on the wilderness side of the threshold they crossed.
            if (ox < 0) p.x = r.minX;
            else if (ox > 0) p.x = r.maxX;
            else if (oz < 0) p.z = r.minZ;
            else p.z = r.maxZ;
            ctx.dirty(p);
          };
          if (at === 'pending') return holdOut(), false;
          if (!at) {
            holdOut();
            return notice(p, 'blocked', `The walls of ${t.name.trim()} block the way. Follow them to a gate or road.`), false;
          }
          return commit(p, loc, dest, at, sideName(-ox, -oz));
        }
      }
    }

    // Walking off the pixel into its neighbour.
    const push = pushedEdges(PIXEL_BOUNDS, p.x, p.z, dir);
    if (!push) return false;
    const tx = push.ox < 0 ? -HALF - PROBE : push.ox > 0 ? HALF + PROBE : p.x;
    const tz = push.oz < 0 ? -HALF - PROBE : push.oz > 0 ? HALF + PROBE : p.z;
    const g = toGlobal(here.px, here.py, tx, tz);
    const dest = destinationAt(g.e, g.s);
    const side = sideName(push.ox, push.oz);
    if (dest.kind === 'edge') {
      p.x = clampIn(p.x, -HALF, HALF, 0);
      p.z = clampIn(p.z, -HALF, HALF, 0);
      ctx.dirty(p);
      return notice(p, 'edge', 'Beyond here the map of the Iliac Bay ends.'), false;
    }
    if (dest.kind === 'pending') return false;
    const at = arrivalPoint(p, dest);
    if (at === 'pending') return false;
    if (!at) return notice(p, 'blocked', 'The way is blocked here.'), false;
    return commit(p, loc, dest, at, side);
  }

  ctx.onJoin((p) => {
    const loc = p.rpg?.location;
    // A saved wilderness location must still be a real map pixel.
    if (typeof loc === 'string' && loc.startsWith('wilderness:') && !parseWilderness(loc)) {
      log.warn?.(`[overland] ${p.name}: invalid saved location ${JSON.stringify(loc)}; returning to ${ctx.defaultLocation}`);
      p.rpg.location = ctx.defaultLocation;
      p.x = 0;
      p.z = 0;
    }
    warm(p);
  });
  ctx.onLeave((p) => {
    notices.delete(p.id);
  });

  ctx.onTick((_dt, now) => {
    if (status !== 'ready') return;
    tickNow = now;
    try {
      for (const p of ctx.players.values()) {
        try {
          step(p);
        } catch (err) {
          log.error?.(`[overland] ${p.name}: ${err.stack || err.message}`);
        }
      }
    } finally {
      tickNow = null;
    }
  });

  const service = {
    get status() { return status; },
    get note() { return statusNote; },
    /** Town placement (walk bounds, rect in its pixel), or null while loading. */
    townFrame: (id) => frameOf(id),
    /** Classic location standing in a map pixel, or null. */
    townAt,
    /** Resolve where a point in `location` (x,z) lies on the global grid. */
    globalOf(location, x, z) {
      const w = parseWilderness(location);
      if (w) return toGlobal(w.px, w.py, x, z);
      const f = frameOf(location);
      if (!f) return null;
      const q = townToWild(f, x, z);
      return toGlobal(f.px, f.py, q.x, q.z);
    },
    localOf(location, e, s) {
      const w = parseWilderness(location);
      if (w) return inPixel(w.px, w.py, e, s);
      const f = frameOf(location);
      if (!f) return null;
      const q = inPixel(f.px, f.py, e, s);
      return wildToTown(f, q.x, q.z);
    },
    whenReady: () => ready,
    /** Resolves once a town's placement is known (tests, warm-up). */
    whenPlaced: (id) => (frameOf(id), metas.get(id)?.promise ?? Promise.resolve()),
  };
  ctx.services.overland = service;
  return { service, ready, step };
}
