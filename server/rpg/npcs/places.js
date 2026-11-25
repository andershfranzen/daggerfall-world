// Active-location cache for source-backed people: loads a location's people when a player is there, keeps them
// in ctx.entities while it is occupied (and for a grace period after), applies opening hours, the daily work roll
// and per-player individual hiding, steps the town's mobile population, and evicts idle locations with a bound.

import { parseLocation, exteriorOf } from '../../../client/world/interiors/index.js';
import { BUILDING, isShop, presentAt } from './people.js';
import { createPopulation } from './population.js';
import { hash32 } from './rules.js';

export const IDLE_MS = 30_000;
export const MAX_PLACES = 24;
const POP_HZ = 10; // PopulationManager.ticksPerSecond

const hourOf = (clock) => {
  const m = clock?.minutes;
  return Number.isFinite(m) ? Math.floor(m / 60) % 24 : 12;
};
const dayOf = (clock) => (Number.isFinite(clock?.minutes) ? Math.floor(clock.minutes / 1440) : 0);
const offersWork = (id, day) => hash32(`${id}#work#${day}`) % 4 === 0;

/**
 * @param {object} ctx runtime ctx (entities, players, location, now, services, log)
 * @param {object} source createPeopleSource() result
 * @param {(e) => void} onAdd called when an entity is inserted (shops, faction flats)
 */
export function createPlaces(ctx, source, { onAdd = () => {}, onRemove = () => {} } = {}) {
  const log = ctx.log ?? console;
  const places = new Map(); // location -> {status, kind, data, entities: Map(id->e), population, usedAt, error, day}
  const away = new Map(); // individual faction id -> Set(player id) for whom the individual is elsewhere
  const awayById = new Map(); // source person id -> Set(player id): a questor a quest has hidden (`hide npc`) for them
  let popClock = 0;
  // Town directories ("Where is …?" people and secret halls) outlive the town's active-location entry, so people
  // indoors can still be asked after the street has been evicted. Small, bounded, filled from source.town().
  const directories = new Map(); // town -> {residents, secretHalls}
  const DIRECTORIES = 32;
  function remember(town, data) {
    directories.delete(town);
    directories.set(town, { residents: data.residents ?? [], secretHalls: new Set(data.secretHalls ?? []) });
    while (directories.size > DIRECTORIES) directories.delete(directories.keys().next().value);
  }
  function ensureDirectory(town) {
    if (!town || directories.has(town) || typeof source.town !== 'function') return;
    // Never in the way of the interior's own load: a missing or failing street only leaves directions closed.
    Promise.resolve().then(() => source.town(town)).then((d) => { if (d) remember(town, d); }, () => {});
  }

  const clock = () => (typeof ctx.services.worldClock === 'function' ? ctx.services.worldClock() : null);

  /** `retry`: a place whose load failed is dropped and loaded again (a player joining or entering asks again). */
  function load(location, { retry = false } = {}) {
    let pl = places.get(location);
    if (pl && retry && pl.status === 'failed') {
      drop(location, pl);
      pl = null;
    }
    if (pl) {
      pl.usedAt = ctx.now();
      return pl;
    }
    const p = parseLocation(location);
    if (!p) return null;
    pl = { location, kind: p.kind, status: 'loading', data: null, entities: new Map(), population: null, usedAt: ctx.now(), error: null, day: null };
    places.set(location, pl);
    const job = p.kind === 'interior' ? source.interior(location) : p.kind === 'dungeon' ? source.dungeon(location) : source.town(location);
    if (p.kind === 'interior') ensureDirectory(exteriorOf(location));
    pl.promise = job.then(
      (data) => {
        if (places.get(location) !== pl) return;
        pl.data = data;
        pl.status = 'ready';
        if (p.kind === 'town') remember(location, data);
        if (p.kind === 'town' && data.nav?.walkable && data.wandering !== false) {
          const collision = ctx.services.collision;
          const clear = typeof collision?.canWalkSegment === 'function'
            ? (x, z, tx, tz) => {
              try {
                return collision.canWalkSegment(location, x, z, tx, tz) !== false;
              } catch {
                return true;
              }
            }
            : undefined;
          pl.population = createPopulation({
            location, nav: data.nav, blocks: data.blocks, race: data.climatePeople, regionIndex: data.regionIndex,
            banks: source.tables.banks, clear,
          });
        }
      },
      (err) => {
        if (places.get(location) !== pl) return;
        pl.status = 'failed';
        pl.error = err?.message ?? String(err);
        log.warn?.(`[npcs] ${location}: ${pl.error}`);
      },
    );
    evict();
    return pl;
  }

  function evict(force = false) {
    const occupied = occupiedLocations();
    const now = ctx.now();
    for (const [loc, pl] of places) {
      if (occupied.has(loc)) continue;
      if (force || now - pl.usedAt > IDLE_MS || places.size > MAX_PLACES) drop(loc, pl);
    }
  }

  function drop(loc, pl) {
    for (const id of pl.entities.keys()) {
      if (ctx.entities.get(id) === pl.entities.get(id)) ctx.entities.delete(id);
      onRemove(id);
    }
    if (pl.population) pl.population.clearAll();
    places.delete(loc);
    source.evict?.(loc);
  }

  function occupiedLocations() {
    const s = new Set();
    for (const q of ctx.players.values()) s.add(ctx.location(q));
    return s;
  }

  /** Daily TalkManager.GetBuildingList roll: 1 in 4 eligible building people offer work, shared by all players. */
  function rollWork(pl, day) {
    if (pl.kind === 'town') return;
    for (const e of pl.entities.values()) {
      const group = e._workGroup ?? e._castleGroup;
      if (!group || e._guildQuests) continue;
      if (offersWork(e.id, day)) {
        e.questGiver = true;
        e.questGroup = group;
      } else {
        delete e.questGiver;
        delete e.questGroup;
      }
    }
  }

  function syncStatic(pl, clk, playersHere) {
    const hour = hourOf(clk);
    const { buildingType: type, factionId } = pl.data.building ?? {};
    const portal = pl.kind === 'interior' && ctx.services.portals?.into?.(pl.location);
    const shopOpen = !isShop(type) || ctx.services.buildingAccess?.publicOpen(type, portal?.meta?.regionIndex, clk?.minutes) !== false;
    const privateHall = type === BUILDING.House2 && factionId > 0;
    const open = pl.kind !== 'interior' || (!privateHall && shopOpen && presentAt(type, hour));
    const guildGuests = !open && portal && (type === BUILDING.GuildHall || privateHall)
      ? playersHere.filter(p => ctx.services.guildHallAccess?.(p, portal)) : null;
    const day = dayOf(clk);
    const want = open || guildGuests?.length ? pl.data.people : [];
    const ids = new Set(want.map((e) => e.id));
    for (const [id, e] of pl.entities) {
      if (ids.has(id) || e.mobile) continue; // mobiles belong to the population step
      if (ctx.entities.get(id) === e) ctx.entities.delete(id);
      pl.entities.delete(id);
      onRemove(id);
    }
    let added = false;
    for (const proto of want) {
      if (pl.entities.has(proto.id)) continue;
      const e = { ...proto };
      if (e.questGroup) e._guildQuests = true;
      ground(pl.location, e);
      pl.entities.set(e.id, e);
      if (!ctx.entities.has(e.id)) ctx.entities.set(e.id, e);
      onAdd(e);
      added = true;
    }
    if (added || pl.day !== day) {
      pl.day = day;
      rollWork(pl, day);
    }
    // DFU QuestMachine.SetupIndividualStaticNPC: an individual placed elsewhere by a quest is absent at home.
    for (const e of pl.entities.values()) {
      const hiddenFor = e.individual && away.get(e.faction);
      const hiddenById = awayById.get(e.id);
      const hidden = hiddenById?.size ? new Set([...(hiddenFor ?? []), ...hiddenById]) : hiddenFor;
      if (!hidden?.size && !guildGuests) delete e.visibleTo;
      else e.visibleTo = new Set((guildGuests ?? playersHere).filter(q => !hidden?.has(q.id)).map(q => q.id));
    }
  }

  /** Dungeon flats are centred on their record; stand them on the floor below with the collision service. */
  function ground(location, e) {
    if (e.anchor !== 'centre') return;
    const groundAt = ctx.services.collision?.groundAt;
    if (typeof groundAt !== 'function') return;
    try {
      const g = groundAt(location, e.x, e.z, e.y);
      if (Number.isFinite(g) && g <= e.y + 0.05 && e.y - g < 3) {
        e.y = Math.round(g * 1000) / 1000;
        e.anchor = 'base';
        e._grounded = 'collision';
      }
    } catch { /* collision for this instance not ready: the client centres the billboard */ }
  }

  function tick(dt) {
    const clk = clock();
    const byLoc = new Map();
    for (const q of ctx.players.values()) {
      const loc = ctx.location(q);
      if (!byLoc.has(loc)) byLoc.set(loc, []);
      byLoc.get(loc).push(q);
    }
    popClock += dt;
    const popStep = popClock >= 1 / POP_HZ;
    const popDt = popClock;
    if (popStep) popClock = 0;
    for (const [loc, here] of byLoc) {
      const pl = load(loc);
      if (!pl || pl.status !== 'ready') continue;
      pl.usedAt = ctx.now();
      if (pl.kind === 'town') {
        syncStatic(pl, clk, here);
        if (pl.population && popStep) {
          const busy = new Set([...ctx.services.npcSessions?.() ?? []]);
          const { added, removed } = pl.population.step(popDt, here, hourOf(clk), busy);
          for (const id of removed) {
            if (ctx.entities.get(id) === pl.entities.get(id)) ctx.entities.delete(id);
            pl.entities.delete(id);
            onRemove(id);
          }
          for (const e of added) {
            pl.entities.set(e.id, e);
            ctx.entities.set(e.id, e);
          }
        }
      } else {
        syncStatic(pl, clk, here);
      }
    }
    evict();
  }

  return {
    places,
    load,
    tick,
    evict,
    /** Resolves when a location's people are known (tests, warm-up). */
    ready: (location) => Promise.resolve(load(location)?.promise),
    workAt(town, playerId) {
      const candidates = places.get(town)?.data?.work ?? [];
      const clk = clock();
      const hour = hourOf(clk), day = dayOf(clk);
      return candidates.filter((w) => presentAt(w.buildingType, hour)
        && (!isShop(w.buildingType) || ctx.services.buildingAccess?.publicOpen(w.buildingType, undefined, clk?.minutes) !== false)
        && offersWork(w.id, day)
        && !away.get(w.individual)?.has(playerId));
    },
    /**
     * Public "Where is …?" directory of a town for one player: named adults of the named buildings (not underworld
     * people, not an individual a quest has placed elsewhere for this player) and the interiors kept secret.
     */
    directoryAt(town, playerId) {
      const data = directories.get(town);
      if (!data) return null;
      const people = data.residents.filter((r) => !r.secret && !(r.individual != null && away.get(r.individual)?.has(playerId)));
      return { people, secretHalls: data.secretHalls };
    },
    setIndividualAway(factionId, playerId, isAway = true) {
      if (!Number.isInteger(factionId)) return;
      let s = away.get(factionId);
      if (!s) away.set(factionId, (s = new Set()));
      if (isAway) s.add(playerId);
      else s.delete(playerId);
    },
    /** QuestMachine `hide npc` on a questor who is not an individual: absent for that player only (Person.IsHidden). */
    setPersonAway(entityId, playerId, isAway = true) {
      if (typeof entityId !== 'string') return;
      let s = awayById.get(entityId);
      if (!s && !isAway) return;
      if (!s) awayById.set(entityId, (s = new Set()));
      if (isAway) s.add(playerId);
      else s.delete(playerId);
      if (!s.size) awayById.delete(entityId);
      const e = ctx.entities.get(entityId);
      if (e && isAway) e.visibleTo = new Set([...(e.visibleTo ?? ctx.players.values())].map((q) => q.id ?? q).filter((id) => id !== playerId));
    },
    isPersonAway: (entityId, playerId) => !!awayById.get(entityId)?.has(playerId),
    status(location) {
      const pl = places.get(location);
      return pl ? {
        status: pl.status, error: pl.error, people: pl.data?.people?.length ?? 0, active: pl.entities.size,
        ...(pl.population ? { population: { max: pl.population.max, active: pl.population.active.length, pool: pl.population.pool.length, walkable: pl.data.nav.walkable } } : {}),
      } : { status: 'none' };
    },
    exteriorOf,
  };
}
