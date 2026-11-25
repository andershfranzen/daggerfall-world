// World of Daggerfall wilderness sites (docs/wilderness-protocol.md).
//
// Reads the operator-installed World of Daggerfall tree (never served) through server/rpg/wilderness/store.js and
// the shared reader client/world/wilderness/data.js. Owns `rpg.wilderness` and the `wilderness:<px>,<py>` locations
// players reach through `wilderness.visit`. Walking across pixel edges belongs to the overland feature, which calls
// `services.wilderness.onEnter`. Combat asks `services.encounterSites(location)` for the site's enemy markers.
//
// rpg.wilderness = {
//   pack, packNote?, site, returnTo, returnPos?, origin, radius, nearby[], discovered[], looted[]
// }

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  composeScene,
  isPointOfInterest,
  parseSiteId,
  parseWildernessId,
  wildernessId,
} from '../../client/world/wilderness/data.js';
import { parseLocationId } from '../../client/gameplay/travel/catalog.js';
import { classicCatalog } from '../../client/gameplay/travel/classic.js';
import * as monsters from './combat/monsters.js';
import { createWodStore } from './wilderness/store.js';
import { handleWildernessScene, WILDERNESS_SCENE_PATH } from './wilderness/http.js';
import { installWildernessBuildings } from './wilderness/buildings.js';
import { createCoastCache } from './wilderness/coast.js';

export const name = 'wilderness';
export { handleWildernessScene, WILDERNESS_SCENE_PATH };

export const DEFAULT_ROOT = fileURLToPath(new URL('../../gamedata/world-of-daggerfall', import.meta.url));
export const VISIT_RADIUS = 6; // map pixels (~4.9 km)
export const NEARBY_LIMIT = 24;
export const LOOT_REACH = 4; // metres
export const RANDOM_ENEMY_TABLE = 33; // classic wilderness (day) encounter table
const MAX_DISCOVERED = 2000;
const MAX_LOOTED = 2000;
const VISIT_COOLDOWN_MS = 1500;
const SPAWN_CLEAR_RADIUS = 24; // metres
const SCENE_CACHE = 16;
const r3 = (v) => Math.round(v * 1000) / 1000;

const isKnownEnemy = (id) =>
  Number.isInteger(id) && (typeof monsters.isKnownEnemy === 'function' ? monsters.isKnownEnemy(id) : monsters.MONSTER_BY_ID.has(id));

/** Stable small integer from a string (FNV-1a), for deterministic loot. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Gold in a WoD treasure record: deterministic per site and record so every account finds the same pile. */
export const treasureGold = (siteId, objectID) => 10 + (hash32(`${siteId}/${objectID}`) % 41);

function resolveRoot(ctx, opts) {
  if (opts.root !== undefined) return opts.root;
  const configured = ctx.config?.wodPath ?? process.env.WOD_PATH;
  if (configured) return configured;
  return existsSync(DEFAULT_ROOT) ? DEFAULT_ROOT : null;
}

/**
 * @param {object} ctx runtime context
 * @param {object} [opts]
 * @param {string|null} [opts.root] installed WoD tree (default: config.wodPath, $WOD_PATH, gamedata/world-of-daggerfall)
 * @param {object} [opts.store] prebuilt store (tests)
 * @param {number} [opts.radius]
 * @param {number} [opts.maxFolders]
 */
export function install(ctx, opts = {}) {
  const log = ctx.log ?? console;
  const radius = Number.isFinite(opts.radius) && opts.radius > 0 ? opts.radius : VISIT_RADIUS;
  const store = opts.store ?? createWodStore({ root: resolveRoot(ctx, opts), maxFolders: opts.maxFolders ?? 6, log });
  const lastVisitAt = new Map();
  const sceneCache = new Map(); // location -> sites (LRU)
  const starters = classicCatalog();
  // Sea-level docks snap to their coast in the scene builder; the visit spawn follows them (wilderness/coast.js).
  const coast = opts.coast ?? createCoastCache({ dataPath: ctx.dataPath, log });

  const ready = Promise.resolve()
    .then(() => (store.ready ? store.status() : store.init()))
    .catch((err) => log.error?.(`[wilderness] ${err.message}`))
    .then(() => {
      for (const p of ctx.players.values()) {
        refresh(p);
        ctx.dirty(p);
      }
    });

  // ---------------------------------------------------------------------------------- state

  function ensure(p) {
    const rpg = p.rpg;
    const w = rpg.wilderness && typeof rpg.wilderness === 'object' && !Array.isArray(rpg.wilderness) ? rpg.wilderness : {};
    w.discovered = Array.isArray(w.discovered) ? w.discovered.filter((s) => parseSiteId(s)).slice(-MAX_DISCOVERED) : [];
    w.looted = Array.isArray(w.looted) ? w.looted.filter((s) => typeof s === 'string' && s.length < 80).slice(-MAX_LOOTED) : [];
    if (typeof w.site !== 'string' || !parseSiteId(w.site)) w.site = null;
    if (typeof w.returnTo !== 'string' || !parseLocationId(w.returnTo)) w.returnTo = null;
    if (!w.returnPos || typeof w.returnPos !== 'object') delete w.returnPos;
    if (!Array.isArray(w.nearby)) w.nearby = [];
    w.radius = radius;
    const st = store.status();
    w.pack = st.pack;
    if (st.pack === 'ready') delete w.packNote;
    else w.packNote = st.note;
    rpg.wilderness = w;
    return w;
  }

  /** Map pixel and region the player is actually at, or null (indoors / unknown). */
  function originOf(p) {
    const loc = ctx.location(p);
    const wild = parseWildernessId(loc);
    if (wild) return { ...wild, region: store.regionAt?.(wild.px, wild.py) ?? null, outside: true };
    const town = parseLocationId(loc) ? loc : null;
    const ref = town ?? p.rpg.travel?.lastTown ?? null;
    if (!ref) return null;
    const entry = ctx.services.travel?.lookup?.(ref) ?? starters.get(ref);
    if (!entry || !Number.isInteger(entry.x) || !Number.isInteger(entry.y)) return null;
    return { px: entry.x, py: entry.y, region: entry.region ?? null, outside: !!town };
  }

  function refresh(p) {
    const w = ensure(p);
    const o = originOf(p);
    w.origin = o ? { px: o.px, py: o.py, region: o.region } : null;
    if (!store.ready || !o) {
      w.nearby = [];
      return w;
    }
    const known = new Set(w.discovered);
    w.nearby = store.nearby(o.px, o.py, radius, NEARBY_LIMIT).map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      prefab: s.prefab,
      px: s.px,
      py: s.py,
      region: s.region,
      distance: s.distance,
      discovered: known.has(s.id),
    }));
    for (const s of w.nearby) {
      if (s.kind !== 'dock') continue;
      const site = sitesFor(wildernessId(s.px, s.py))?.find((x) => x.id === s.id);
      if (site) coast.prepare(site);
    }
    return w;
  }

  function addCapped(list, value, max) {
    if (list.includes(value)) return false;
    list.push(value);
    if (list.length > max) list.splice(0, list.length - max);
    return true;
  }

  // ---------------------------------------------------------------------------------- scenes

  function sitesFor(location) {
    const pix = parseWildernessId(location);
    if (!pix || !store.ready) return null;
    let sites = sceneCache.get(location);
    if (sites) {
      sceneCache.delete(location);
    } else {
      sites = store.sceneSites(pix.px, pix.py);
    }
    sceneCache.set(location, sites);
    while (sceneCache.size > SCENE_CACHE) sceneCache.delete(sceneCache.keys().next().value);
    return sites;
  }

  function scene(location, focus = null) {
    const pix = parseWildernessId(location);
    if (!pix) throw new Error('That is not a wilderness location.');
    if (!store.ready) throw new Error(store.status().note || 'World of Daggerfall is not available on this server.');
    const sites = sitesFor(location);
    return composeScene({ px: pix.px, py: pix.py, region: store.regionAt(pix.px, pix.py), sites, focus });
  }

  /** Requirements every site action shares. Returns the placed site summary. */
  function requireSite(raw) {
    if (!store.ready) throw new Error(store.status().note || 'World of Daggerfall is not available on this server.');
    if (typeof raw !== 'string' || !raw) throw new Error('Choose a site.');
    const parsed = parseSiteId(raw);
    if (!parsed) throw new Error('That is not a wilderness site.');
    const s = store.site(raw, parsed);
    if (!s) throw new Error('That site is no longer there. Refresh the list of nearby places.');
    return s;
  }

  function distanceTo(o, s) {
    const sx = s.px + s.tx / 128, sy = s.py + 1 - s.ty / 128;
    return Math.hypot(sx - (o.px + 0.5), sy - (o.py + 0.5));
  }

  function requireNear(p, s) {
    const o = originOf(p);
    if (!o) throw new Error('Step outside first.');
    if (!o.outside) throw new Error('Step outside first.');
    if (distanceTo(o, s) > radius) throw new Error(`${s.name} is too far from here.`);
    return o;
  }

  /**
   * The descriptor's spawn ignores terrain and solid meshes. Once collision for the scene has loaded (players are held
   * while it loads), a player still on the spawn inside a solid is moved to the nearest clear spot. The result is the
   * same for every account because the geometry is the same.
   */
  function settleSpawn(p, location, spawn) {
    const col = ctx.services.collision;
    if (typeof col?.whenSettled !== 'function' || typeof col.isClear !== 'function') return;
    col.preload?.(location);
    col
      .whenSettled(location)
      .then(() => {
        if (ctx.players.get(p.id) !== p || ctx.location(p) !== location) return;
        if (Math.hypot(p.x - spawn.x, p.z - spawn.z) > 0.01 || col.isClear(location, p.x, p.z)) return;
        const c = col.nearestClear?.(location, p.x, p.z, SPAWN_CLEAR_RADIUS);
        if (!c) return;
        ctx.dirty(p);
        p.x = r3(c.x);
        p.z = r3(c.z);
      })
      .catch((err) => log.warn?.(`[wilderness] spawn check for ${location}: ${err?.message}`));
  }

  function sendScene(p, location, focus) {
    try {
      ctx.notify(p, { kind: 'wildernessScene', location, scene: scene(location, focus) });
    } catch (err) {
      log.warn?.(`[wilderness] scene for ${location}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------------- lifecycle

  ctx.onJoin((p) => {
    const w = ensure(p);
    const loc = ctx.location(p);
    if (typeof loc === 'string' && loc.startsWith('wilderness:') && !parseWildernessId(loc)) {
      log.warn?.(`[wilderness] ${p.name}: invalid saved location ${JSON.stringify(loc)}`);
      p.rpg.location = w.returnTo ?? ctx.defaultLocation;
      p.x = w.returnPos?.x ?? 0;
      p.z = w.returnPos?.z ?? 0;
      p.yaw = w.returnPos?.yaw ?? 0;
      w.site = null;
    }
    refresh(p);
  });

  ctx.onLeave((p) => lastVisitAt.delete(p.id));

  ctx.on('travel', ({ player } = {}) => {
    if (!player?.rpg) return;
    const w = ensure(player);
    w.site = null;
    w.returnTo = null;
    delete w.returnPos;
    refresh(player);
  });

  ctx.on('overland', ({ player, from, to } = {}) => {
    if (!player?.rpg) return;
    const w = ensure(player);
    if (parseLocationId(from) && parseWildernessId(to)) {
      w.returnTo = from;
      delete w.returnPos;
    }
    if (parseLocationId(to)) {
      w.returnTo = null;
      delete w.returnPos;
    }
    w.site = null;
    refresh(player);
  });

  // ---------------------------------------------------------------------------------- actions

  ctx.onAction('wilderness.nearby', (p) => {
    refresh(p);
  });

  ctx.onAction('wilderness.discover', (p, args) => {
    const s = requireSite(args.site);
    requireNear(p, s);
    const w = ensure(p);
    const fresh = addCapped(w.discovered, s.id, MAX_DISCOVERED);
    refresh(p);
    if (fresh) ctx.notify(p, { kind: 'wilderness', text: `You mark ${s.name} on your map.`, site: s.id });
  });

  ctx.onAction('wilderness.visit', (p, args) => {
    const s = requireSite(args.site);
    const w = ensure(p);
    const from = ctx.location(p);
    const target = wildernessId(s.px, s.py);
    if (from === target && w.site === s.id) throw new Error(`You are already at ${s.name}.`);
    requireNear(p, s);
    const now = ctx.now();
    const last = lastVisitAt.get(p.id);
    if (last !== undefined && now - last < VISIT_COOLDOWN_MS) throw new Error('You have only just arrived. Catch your breath first.');
    if (typeof ctx.services.isDefeated === 'function' && ctx.services.isDefeated(p)) throw new Error('You cannot travel while defeated.');

    const sc = scene(target, s.id);
    const focus = sc.sites.find((x) => x.id === s.id);
    if (focus?.instanceType === 2) {
      coast.prepare(focus);
      sc.spawn = coast.spawnFor(s.id, sc.spawn);
    }
    if (parseLocationId(from)) {
      w.returnTo = from;
      w.returnPos = { x: r3(p.x), z: r3(p.z), yaw: r3(p.yaw) };
    }
    p.rpg.location = target;
    p.x = sc.spawn.x;
    p.z = sc.spawn.z;
    p.yaw = sc.spawn.yaw;
    p.forward = 0;
    p.strafe = 0;
    p.moving = false;
    w.site = s.id;
    addCapped(w.discovered, s.id, MAX_DISCOVERED);
    lastVisitAt.set(p.id, now);
    refresh(p);
    ctx.notify(p, { kind: 'wilderness', text: `You make your way to ${s.name}.`, site: s.id, location: target });
    ctx.notify(p, { kind: 'wildernessScene', location: target, scene: sc });
    ctx.emit('wilderness', { player: p, from, to: target, site: s.id });
    const spawn = { x: p.x, z: p.z };
    ctx.afterCommit(() => settleSpawn(p, target, spawn));
  });

  ctx.onAction('wilderness.leave', (p) => {
    const w = ensure(p);
    const from = ctx.location(p);
    if (!parseWildernessId(from)) throw new Error('You are not in the wilderness.');
    const back = w.returnTo ?? p.rpg.travel?.lastTown ?? ctx.defaultLocation;
    const pos = w.returnTo ? w.returnPos : null;
    p.rpg.location = back;
    p.x = pos?.x ?? 0;
    p.z = pos?.z ?? 0;
    p.yaw = pos?.yaw ?? 0;
    p.forward = 0;
    p.strafe = 0;
    p.moving = false;
    w.site = null;
    w.returnTo = null;
    delete w.returnPos;
    refresh(p);
    const town = parseLocationId(back);
    ctx.notify(p, { kind: 'wilderness', text: `You return to ${town ? town.location : 'town'}.`, location: back });
    ctx.emit('wilderness', { player: p, from, to: back, site: null });
  });

  ctx.onAction('wilderness.loot', (p, args) => {
    const s = requireSite(args.site);
    const loc = ctx.location(p);
    const pix = parseWildernessId(loc);
    if (!pix) throw new Error('You are not at that site.');
    const site = sitesFor(loc).find((x) => x.id === s.id);
    if (!site) throw new Error('You are not at that site.');
    const oid = args.object;
    if (!(typeof oid === 'number' || typeof oid === 'string') || String(oid).length > 24) throw new Error('Choose something to search.');
    const rec =
      site.objects.find((o) => o.loot && String(o.objectID) === String(oid)) ??
      site.markers.find((m) => m.loot && String(m.objectID) === String(oid));
    if (!rec) throw new Error('There is nothing to search there.');
    const [x, , z] = rec.position;
    if (Math.hypot(p.x - x, p.z - z) > LOOT_REACH) throw new Error('You need to be closer to search that.');
    const w = ensure(p);
    const key = `${s.id}/${rec.objectID}`;
    if (w.looted.includes(key)) throw new Error('You have already searched that.');
    const gold = treasureGold(s.id, rec.objectID);
    if (typeof ctx.services.giveItem === 'function') ctx.services.giveItem(p, 'gold', gold);
    else p.rpg.gold = (Number.isFinite(p.rpg.gold) ? p.rpg.gold : 0) + gold;
    addCapped(w.looted, key, MAX_LOOTED);
    ctx.notify(p, { kind: 'wilderness', text: `You find ${gold} gold.`, site: s.id, gold });
  });

  // ---------------------------------------------------------------------------------- hooks

  /** Combat encounter sites (contract in docs/wilderness-protocol.md, "Server hooks"). */
  const previousEncounters = ctx.services.encounterSites;
  ctx.services.encounterSites = (location) => {
    if (!parseWildernessId(location)) return typeof previousEncounters === 'function' ? previousEncounters(location) : undefined;
    const st = store.status().pack;
    if (st === 'loading') return null;
    if (st !== 'ready') return typeof previousEncounters === 'function' ? previousEncounters(location) : undefined;
    const out = [];
    for (const site of sitesFor(location)) {
      for (const m of site.markers) {
        const key = `${site.id}#${m.objectID}`;
        const [x, , z] = m.position;
        if (m.marker === 16 && m.enemy !== undefined) {
          const e = { x, z, key, yaw: site.yaw };
          if (isKnownEnemy(m.enemy)) e.monsters = [m.enemy];
          else Object.assign(e, { table: RANDOM_ENEMY_TABLE, count: 1 });
          if (m.team) e.team = m.team;
          out.push(e);
        } else if (m.marker === 15) {
          out.push({ x, z, key, table: RANDOM_ENEMY_TABLE, count: 1 });
        }
      }
    }
    return out;
  };

  const service = {
    status: () => store.status(),
    get ready() {
      return ready;
    },
    isWilderness: (id) => parseWildernessId(id) !== null,
    parse: (id) => parseWildernessId(id),
    scene,
    siteById: (id) => {
      const parsed = parseSiteId(id);
      return parsed && store.ready ? store.site(id, parsed) : null;
    },
    nearbyFor: (p) => refresh(p).nearby,
    /** Overland: a player now stands in `id`. Refreshes the nearby list and sends the scene. */
    onEnter(p, id) {
      if (!parseWildernessId(id) || !p?.rpg) return;
      ctx.dirty(p);
      refresh(p);
      if (store.ready) sendScene(p, id, null);
    },
    isPointOfInterest,
    store,
  };
  ctx.services.wilderness = service;
  // Farmhouses and other RMB buildings of the pack: doors through the shared portal service.
  const buildings = opts.buildings === false ? null : installWildernessBuildings(ctx, opts.buildings ?? {});
  return { ready, service, store, buildings };
}
