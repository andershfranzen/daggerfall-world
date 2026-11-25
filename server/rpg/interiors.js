// Interiors and dungeons: validated, shared building and dungeon instances behind real doors.
//
// install(ctx, options?)
//   ctx.dataPath          operator ARENA2 directory (trusted). Without it no door can be validated: portal actions
//                         fail with a readable message and players saved inside an instance are returned outside.
//   options.source        a world source ({townPortals(location), scene(location)}); default: operator ARENA2
//   options.locations     town location ids to survey at startup (default: ctx.defaultLocation and
//                         "town:Daggerfall/Privateer's Hold"); others are surveyed the first time a player is there.
//
// Actions
//   portal.use   {portalId}  enter a building or dungeon door near the player (ids from client/world/interiors)
//   portal.leave {}          leave the current instance through an exit door near the player
// Services (ctx.services)
//   portals      the registry (server/rpg/interiors/portals.js): register/get/into/at/planEnter/planLeave, plus
//                transfer(player, landing) for features that move players between locations themselves.
//   interiors    { ready: Promise, survey(location): Promise, scene(location): Promise<scene>, isInstance(location) }
//   encounterSites(location)  chained combat contract: RDB enemy markers of a dungeon in its player frame
//                ({x,y,z,monsters:[id],key} fixed / {x,y,z,table,count:1,key} random), [] inside buildings,
//                null while surveying, undefined for locations this feature does not own.
// Events
//   ctx.emit('locationChanged', {player, from, to, portal})
//   gameEvent {kind:'teleport', location, x, y, z, yaw, label}  to the mover (clients reset prediction and scene)
//   gameEvent {kind:'portal', playerId, name, text}              to occupants of both locations
//
// Instances are shared: everyone who enters the same building or dungeon is in the same location id and sees the
// others through the runtime's per-location peers and entities.

import { clearDungeonReturn, createPortalRegistry, DEFAULT_REACH } from './interiors/portals.js';
import { createWorldSource } from './interiors/data.js';
import { parseLocation, exteriorOf } from '../../client/world/interiors/index.js';
import { MANTELLAN } from '../../client/world/interiors/dungeonAccess.js';
import { groundFor } from '../../client/lib/ground.js';
import { canResumeSwim, canResumeWaterWalk } from '../../client/lib/locomotion.js';
import { installDungeonActions } from './interiors/actions.js';

export const name = 'interiors';
export const PRIVATEERS_HOLD = "town:Daggerfall/Privateer's Hold";
const COOLDOWN_MS = 800;

export function install(ctx, options = {}) {
  const registry = createPortalRegistry({ reach: options.reach ?? DEFAULT_REACH });
  const source = options.source ?? (ctx.dataPath ? createWorldSource(ctx.dataPath, ctx.services?.worldData?.ready) : null);
  const log = ctx.log ?? console;
  const surveyed = new Map(); // town id -> 'pending' | 'ready' | Error
  const sites = new Map(); // instance location -> encounter sites (combat's encounterSites contract)
  const lastUse = new Map(); // player id -> ms
  const questDestinations = new Map();
  const floorChecks = new WeakMap();

  // Other features' instances behind portal doors (e.g. wilderness farm buildings, server/rpg/wilderness/buildings.js):
  // {owns(location) -> 'exterior'|'instance'|null, exteriorOf(instance), portals(exterior) -> Promise<specs>,
  //  scene(instance) -> Promise<scene>}. Their exteriors are surveyed like towns and their instances behave as
  // building interiors (portal.use / portal.leave, collision, reconnect).
  const sources = [];
  const sourceOf = (location) => {
    for (const s of sources) {
      const kind = s.owns(location);
      if (kind) return { source: s, kind };
    }
    return null;
  };
  const exteriorFor = (location) => {
    const o = sourceOf(location);
    if (o) return o.kind === 'exterior' ? location : o.source.exteriorOf(location);
    return exteriorOf(location);
  };

  const isInstance = (location) => {
    const p = parseLocation(location);
    if (p) return p.kind !== 'town';
    return sourceOf(location)?.kind === 'instance';
  };

  function survey(location) {
    const external = sourceOf(location)?.source ?? null;
    if (!source && !external) return Promise.reject(new Error('This server has no game data for interiors.'));
    const town = exteriorFor(location);
    if (!town) return Promise.reject(new Error(`unknown location ${location}`));
    const state = surveyed.get(town);
    if (state === 'ready') return Promise.resolve();
    if (state instanceof Promise) return state;
    const job = Promise.resolve()
      .then(() => (external ? external.portals(town) : source.townPortals(town)))
      .then((specs) => {
        for (const s of specs) {
          registry.register(s);
          sites.set(s.to, Object.freeze((s.meta?.encounters ?? []).map((e) => Object.freeze({ ...e }))));
        }
        surveyed.set(town, 'ready');
        reconcileAll();
      })
      .catch((err) => {
        surveyed.set(town, err instanceof Error ? err : new Error(String(err)));
        log.error?.(`[interiors] could not survey ${town}:`, err?.message ?? err);
        reconcileAll();
        throw err;
      });
    surveyed.set(town, job);
    return job;
  }

  /** Readiness of a location's town: 'ready', 'pending', 'failed' or 'none'. */
  function status(location) {
    const s = surveyed.get(exteriorFor(location));
    if (s === 'ready') return 'ready';
    if (s instanceof Promise) return 'pending';
    if (s instanceof Error) return 'failed';
    return 'none';
  }

  function ensure(location) {
    const st = status(location);
    if (st === 'ready') return;
    if (!source && !sourceOf(location)) throw new Error('Doors cannot be opened: this server has no game data for interiors.');
    if (st === 'none') survey(location).catch(() => {});
    if (st === 'failed') throw new Error('The doors of this place could not be read from the game data.');
    throw new Error('This place is still being surveyed. Try again in a moment.');
  }

  function prepareQuestTransfer() {
    if (!source?.dungeonDetails) return Promise.reject(new Error('This server has no quest dungeon data.'));
    return Promise.all([MANTELLAN.dungeon, MANTELLAN.returnDungeon].map(async (id) => {
      if (questDestinations.has(id)) return;
      await survey(id);
      const details = await source.dungeonDetails(id);
      if (!details.questSpawns.length || details.sourceLocationId !== (id === MANTELLAN.dungeon ? MANTELLAN.place : MANTELLAN.returnPlace - 1)) {
        throw new Error(`Missing authored quest destination for ${id}`);
      }
      const status = await ctx.services.collision?.whenSettled(id);
      if (status && status.status !== 'ready') throw new Error(`Collision is unavailable for ${id}`);
      questDestinations.set(id, details.questSpawns[0]);
    }));
  }

  function clearLanding(location, marker, world) {
    const reference = marker.y ?? 0;
    const y = world.heightAt(marker.x, marker.z, reference);
    if (y == null || Math.abs(reference - y) > 3 || !world.isClear(marker.x, marker.z, y)) return null;
    return { location, x: marker.x, y, z: marker.z, yaw: marker.yaw ?? 0 };
  }

  function landOnFloor(location, marker, world) {
    const landing = clearLanding(location, marker, world);
    if (!landing) throw new Error('The destination has no clear landing.');
    return landing;
  }

  function resurrectAtEntry(p) {
    const location = ctx.location(p);
    const entry = registry.into(location)?.entrances[0];
    const marker = entry?.enter ?? entry?.inner;
    const world = ctx.services.collision?.instanceWorld(location);
    if (!marker || !world) return;
    const landing = clearLanding(location, marker, world);
    if (landing) transfer(p, landing, { keepPortal: true, label: 'the entrance' });
  }

  function questTransfer(p, instance) {
    const active = p.rpg.quests?.active;
    if (instance?.name !== MANTELLAN.quest || !instance.uid || !active?.some((q) => q.uid === instance.uid && q.name === MANTELLAN.quest)) {
      throw new Error('This transfer requires Journey to Aetherius.');
    }
    if (p.rpg.mantellan?.uid === instance.uid) throw new Error('Nulfaga has already sent you.');
    if (ctx.location(p) !== MANTELLAN.returnDungeon) throw new Error('Nulfaga must send you from Shedungent.');
    commitQuestTransfer(p, MANTELLAN.dungeon, { uid: instance.uid, stage: 'inside' });
  }

  function commitQuestTransfer(p, target, progress) {
    const marker = questDestinations.get(target);
    const world = ctx.services.collision?.instanceWorld(target);
    const portal = registry.into(target);
    if (!marker || !world || !portal) {
      prepareQuestTransfer().catch(() => {});
      throw new Error('The quest destination is still loading. Try again in a moment.');
    }
    const landing = landOnFloor(target, marker, world);
    const returnTo = portal.entrances.length ? { location: portal.from, ...portal.entrances[0].exit } : null;
    ctx.dirty(p);
    p.rpg.mantellan = progress;
    transfer(p, landing, { portal, returnTo });
  }

  function finishMantella(p) {
    const progress = p.rpg.mantellan;
    if (ctx.location(p) !== MANTELLAN.dungeon || progress?.stage !== 'inside' ||
      !p.rpg.quests?.active?.some((q) => q.uid === progress.uid && q.name === MANTELLAN.quest)) {
      throw new Error('Nulfaga’s quest is required to touch the Mantella.');
    }
    commitQuestTransfer(p, MANTELLAN.returnDungeon, { ...progress, stage: 'finished' });
    ctx.emit('questGlobal', { player: p, index: 36, value: true });
  }

  const dungeons = installDungeonActions(ctx, {
    source, graceMs: options.graceMs, finishMantella, random: options.random,
    localTeleport(p, marker, world) {
      const location = ctx.location(p);
      transfer(p, landOnFloor(location, marker, world), { keepPortal: true, label: 'a dungeon transport' });
    },
  });

  /** Move a player to a landing. Call only after every check has passed: nothing here throws. */
  function transfer(p, landing, { portal = null, entrance = null, label = null, returnTo = null, keepPortal = false } = {}) {
    const from = ctx.location(p);
    const to = landing.location;
    ctx.dirty(p);
    const { forward, strafe, arrival } = p;
    ctx.onRollback(() => Object.assign(p, { forward, strafe, arrival }));
    p.rpg.location = to;
    if (keepPortal && from === to && p.rpg.portal?.to === to) {
      p.rpg.portal.footY = landing.y ?? 0;
      delete p.rpg.portal.swimming;
      delete p.rpg.portal.breath;
    } else if (isInstance(to)) {
      p.rpg.portal = {
        id: portal?.id ?? null,
        from: portal?.from ?? from,
        to,
        label: portal?.label ?? label,
        footY: landing.y ?? 0,
        returnTo: returnTo ?? (entrance ? {
          location: portal.from, x: entrance.exit.x, z: entrance.exit.z, yaw: entrance.exit.yaw,
          ...(portal.kind === 'dungeon' ? { y: entrance.exit.y } : {}),
        } : null),
      };
    } else {
      delete p.rpg.portal;
    }
    p.x = landing.x;
    p.z = landing.z;
    p.yaw = landing.yaw;
    // A raised exterior landing keeps its floor both on the next step and across a reconnect.
    p.arrival = Number.isFinite(landing.y) ? { location: to, x: p.x, z: p.z, y: landing.y } : null;
    ctx.services.collision?.rememberTownFloor?.(p, to, p.x, p.z, landing.y);
    p.moving = false;
    p.forward = 0;
    p.strafe = 0;
    const text = label ?? portal?.label ?? 'a door';
    ctx.notify(p, { kind: 'teleport', location: to, x: landing.x, y: landing.y ?? 0, z: landing.z, yaw: landing.yaw, label: text });
    if (from !== to) {
      // Occupants other than the mover (they get the teleport event instead).
      for (const q of ctx.players.values()) {
        if (q === p) continue;
        // Another crew's scene on a shared ship deck hears nothing of this one (server/rpg/sailing.js).
        const qs = ctx.services.presenceScope?.(q);
        if (qs && qs !== ctx.services.presenceScope?.(p)) continue;
        const at = ctx.location(q);
        if (at === from) ctx.notify(q, { kind: 'portal', playerId: p.id, name: p.name, text: `${p.name} left.` });
        else if (at === to) ctx.notify(q, { kind: 'portal', playerId: p.id, name: p.name, text: `${p.name} arrived.` });
      }
    }
    ctx.emit('locationChanged', { player: p, from, to, portal });
    ctx.afterCommit(() => {
      ctx.services.collision?.resetBody(p);
      if (from === to) return;
      dungeons.depart(p, from);
      dungeons.occupy(p, to);
    });
  }

  function cooldown(p) {
    const t = ctx.now();
    if (t - (lastUse.get(p.id) ?? -Infinity) < COOLDOWN_MS) throw new Error('Wait a moment.');
    ctx.afterCommit(() => lastUse.set(p.id, t));
  }

  ctx.onAction('portal.use', (p, args) => {
    const custody = ctx.services.law?.custody?.(p);
    if (custody) throw new Error(custody);
    const location = ctx.location(p);
    ensure(location);
    // A door with a required floor (a ship's cabin under its decks) is used from that floor only. Other
    // exterior doors keep horizontal reach, so raised doorways and old saved landings work as before.
    const floorBound = registry.get(location, args?.portalId)?.entrances.some((e) => Number.isFinite(e.floor));
    const footY = floorBound ? ctx.services.collision?.footY?.(p) : undefined;
    const plan = registry.planEnter(location, { x: p.x, z: p.z, ...(Number.isFinite(footY) ? { y: footY } : {}) }, args?.portalId);
    if (ctx.services.buildingAccess?.entry(p, plan.portal) === false) return;
    if (plan.portal.kind === 'dungeon' && ctx.services.collision) {
      const collision = ctx.services.collision;
      const world = collision.instanceWorld(plan.landing.location);
      const outside = collision.instanceWorld(location);
      if (!world || !outside) throw new Error('The dungeon entrance is still loading. Try again in a moment.');
      plan.landing = landOnFloor(plan.landing.location, plan.landing, world);
      plan.returnTo = clearDungeonReturn(outside, { location, ...plan.entrance.exit });
      if (!plan.returnTo) throw new Error('There is no clear return point outside this entrance.');
    }
    cooldown(p);
    transfer(p, plan.landing, plan);
  });

  ctx.onAction('portal.leave', (p) => {
    const custody = ctx.services.law?.custody?.(p);
    if (custody) throw new Error(custody);
    const location = ctx.location(p);
    if (!isInstance(location)) throw new Error('You are already outside.');
    ensure(location);
    const body = ctx.services.collision?.bodyOf?.(p);
    const y = body?.y ?? p.rpg.portal?.footY;
    const position = { x: p.x, y, z: p.z };
    const portal = registry.into(location);
    if (portal?.kind === 'dungeon' && ctx.services.collision) {
      const world = ctx.services.collision.instanceWorld(location);
      if (!world) throw new Error('The dungeon is still loading. Try again in a moment.');
      if (!body) position.y = Number.isFinite(y) ? world.heightAt(p.x, p.z, y) : null;
      position.visible = (exit) => Number.isFinite(position.y) &&
        world.segmentClear(p.x, position.y + 1.6, p.z, exit.x + (exit.nx ?? 0) * 0.06, exit.y, exit.z + (exit.nz ?? 0) * 0.06);
    }
    const back = p.rpg.portal?.returnTo;
    const saved = back?.location === portal?.from && [back?.x, back?.z, back?.yaw].every(Number.isFinite) ? back : null;
    const plan = registry.planLeave(location, position, saved);
    if (portal.kind === 'dungeon' && ctx.services.collision) {
      const outside = ctx.services.collision.instanceWorld(plan.landing.location);
      if (!outside) throw new Error('The exterior is still loading. Try again in a moment.');
      const clear = clearDungeonReturn(outside, plan.landing);
      if (!clear) throw new Error('There is no clear landing outside this entrance.');
      plan.landing = clear;
    }
    cooldown(p);
    transfer(p, plan.landing, plan);
  });

  function reconcileDungeonFloor(p, portal) {
    const collision = ctx.services.collision;
    const location = portal.to;
    if (!collision || floorChecks.get(p) === location) return;
    floorChecks.set(p, location);
    const { x, z } = p;
    collision.whenSettled(location).then(async () => {
      const world = collision.instanceWorld(location);
      if (!world || ctx.players.get(p.id) !== p || ctx.location(p) !== location || p.x !== x || p.z !== z) return;
      const entry = portal.entrances[0]?.enter ?? (await source.scene(location)).spawn;
      if (ctx.players.get(p.id) !== p || ctx.location(p) !== location || p.x !== x || p.z !== z || !entry) return;
      const saved = p.rpg.portal;
      if (saved?.to === location && (canResumeSwim(world, x, z, saved)
        || (ctx.services.magicStatus?.(p)?.waterWalking && canResumeWaterWalk(world, x, z, saved)))) return;
      const ref = saved?.to === location && Number.isFinite(saved.footY) ? saved.footY : entry.y;
      const y = world.heightAt(x, z, ref);
      const nearby = y == null || Math.abs(y - ref) > 2 ? null : world.nearestClear(x, z, { y, maxDist: 1.5 });
      const landing = nearby ? { location, ...nearby, y: world.heightAt(nearby.x, nearby.z, y), yaw: p.yaw }
        : landOnFloor(location, entry, world);
      if (saved?.to !== location || !Number.isFinite(saved.footY) || Math.abs(saved.footY - landing.y) > 0.1 ||
          landing.x !== x || landing.z !== z) {
        transfer(p, landing, { portal, keepPortal: saved?.to === location, entrance: portal.entrances[0] });
      }
    }).catch((err) => log.warn?.('[interiors] could not restore dungeon floor:', err.message));
  }

  /**
   * Reconnect/restart rule: a player saved inside an instance stays there when the instance still exists in the
   * operator data; otherwise they are returned outside (the saved return point, else the town's own spawn).
   */
  function reconcile(p) {
    const loc = ctx.location(p);
    if (!isInstance(loc)) {
      if (p.rpg.portal) {
        ctx.dirty(p);
        delete p.rpg.portal;
      }
      if ((source || sourceOf(loc)) && status(loc) === 'none') survey(loc).catch(() => {});
      return;
    }
    const st = source || sourceOf(loc) ? status(loc) : 'failed';
    if (st === 'none') {
      survey(loc).catch(() => {});
      return;
    }
    if (st === 'pending') return;
    if (st === 'ready' && registry.into(loc)) {
      if (loc === MANTELLAN.dungeon && p.rpg.mantellan?.stage === 'inside') prepareQuestTransfer().catch(() => {});
      if (parseLocation(loc)?.kind === 'dungeon') reconcileDungeonFloor(p, registry.into(loc));
      return;
    }
    const back = p.rpg.portal?.returnTo;
    const landing = back && typeof back.location === 'string' && !isInstance(back.location) && [back.x, back.z, back.yaw].every(Number.isFinite)
      ? { location: back.location, x: back.x, y: back.y, z: back.z, yaw: back.yaw }
      : { location: exteriorFor(loc) ?? ctx.defaultLocation, x: 0, z: 0, yaw: 0 };
    transfer(p, landing, { label: 'the way out' });
  }

  function reconcileAll() {
    for (const p of ctx.players.values()) {
      try {
        reconcile(p);
      } catch (err) {
        log.error?.('[interiors] reconcile failed:', err);
      }
    }
  }

  ctx.onJoin((p) => {
    reconcile(p);
    dungeons.occupy(p, ctx.location(p), { resume: true });
  });
  ctx.onLeave((p) => {
    dungeons.depart(p, ctx.location(p));
    lastUse.delete(p.id);
  });

  const startup = source
    ? Promise.allSettled([...new Set(options.locations ?? [ctx.defaultLocation, PRIVATEERS_HOLD])].map((l) => survey(l)))
    : Promise.resolve([]);

  /**
   * Combat contract: undefined = not an interiors location (falls through to the previous handler), null = ours but
   * still being surveyed, array = authoritative sites from the RDB enemy markers (empty for building interiors and
   * for instances the operator data cannot provide).
   */
  const previousSites = ctx.services.encounterSites;
  ctx.services.encounterSites = (location) => {
    if (!isInstance(location)) return typeof previousSites === 'function' ? previousSites(location) : undefined;
    if (sites.has(location)) return sites.get(location);
    const st = source || sourceOf(location) ? status(location) : 'failed';
    if (st === 'none') {
      survey(location).catch(() => {});
      return null;
    }
    if (st === 'pending') return null;
    return [];
  };

  registry.transfer = transfer;
  ctx.services.portals = registry;
  ctx.services.interiors = {
    ready: startup,
    survey,
    status,
    isInstance,
    resurrectAtEntry,
    mechanismActive: dungeons.active,
    async cemeteryEntry(exterior) {
      await survey(exterior);
      const portal = registry.at(exterior).find((p) => p.kind === 'dungeon' && p.meta?.dungeonType === 18 && p.meta.blocks <= 5);
      if (!portal) return null;
      const entrance = portal.entrances[0];
      await ctx.services.collision?.whenSettled(portal.to);
      const world = ctx.services.collision?.instanceWorld(portal.to);
      const landing = world && clearLanding(portal.to, entrance.enter, world);
      return landing ? { landing, portal, entrance } : null;
    },
    prepareQuestTransfer,
    questTransfer,
    async questMarkers(location) {
      const scene = await source?.scene(location);
      if (scene?.kind !== 'dungeon') return [];
      // Record the authored floor so choosing a marker gives the same result
      // after a switch moves nearby geometry, or after an instance reset.
      const ground = groundFor(scene);
      return scene.questMarkers.map((m) => ({
        ...m, floor: ground?.heightAt(m.x, m.z, m.y) ?? m.y,
      }));
    },
    scene(location) {
      const external = sourceOf(location);
      if (external?.kind === 'instance') return external.source.scene(location);
      return source ? source.scene(location) : Promise.reject(new Error('no game data'));
    },
    /** Register another feature's portal instances (see `sources` above). Returns an unregister function. */
    addSource(spec) {
      if (!spec || typeof spec.owns !== 'function' || typeof spec.portals !== 'function' ||
        typeof spec.scene !== 'function' || typeof spec.exteriorOf !== 'function') throw new TypeError('invalid interior source');
      sources.push(spec);
      return () => {
        const i = sources.indexOf(spec);
        if (i >= 0) sources.splice(i, 1);
      };
    },
    exteriorOf: exteriorFor,
  };
}

export default install;
