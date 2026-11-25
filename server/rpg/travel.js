// Server-validated fast travel between original Iliac Bay exteriors.
//
// Owns `rpg.travel` and changes `rpg.location` between `town:Region/Location`
// ids (docs/gameplay-protocol.md). Destinations are checked against the
// operator's MAPS.BSA (ctx.dataPath); without it only the short starter list in
// client/gameplay/travel/classic.js is accepted. `building:` and `dungeon:`
// locations belong to the interiors feature and are never handled here.
//
// Time and cost follow Daggerfall Unity's TravelTimeCalculator (see
// client/gameplay/travel/journey.js). The world clock is shared by everyone, so
// a journey never advances it: the classic duration is reported and recorded on
// the character instead.
//
// rpg.travel = {
//   server: 'files' | 'classic' | 'loading',   what this server validates against (refreshed on join)
//   found: { [regionIndex]: locationIndex[] }  records visited or revealed beyond MAPTABLE's own flag
//   discovered: string[],                      legacy ids not yet converted (kept until MAPS.BSA loads)
//   identity: 1                                place addresses converted (client/gameplay/travel/identity.js)
//   positions: { [id]: {x,z,yaw} },            where the player last stood in each exterior
//   trips, daysOnRoad, lastTrip: {from,to,days,minutes,cost,options,transport,at,
//                                  requestId?, route:{from:{x,y,name,region}, to:{…}}, mounted, showMs}
//
// `travel.go {to, options, expectCost, requestId?}`: a repeated `requestId` (a client retrying
// after a lost answer or a reconnect) succeeds again without a second fare or journey, and the
// `travel` event repeats so the browser can still show the journey. The browser plays a brief map
// journey from `route` (client/gameplay/travel/journeyView.js) only after this event: a refused
// journey never shows one.
//   options: {speed, lodging, ship}             last chosen journey options
// }

import { parseLocationId, mapPixelOf, wildernessOrigin, regionOfPlace, climateOfPlace } from '../../client/gameplay/travel/catalog.js';
import { classicCatalog } from '../../client/gameplay/travel/classic.js';
import { hasFreeShipPassage, quoteJourney, normalizeOptions, presentationMs } from '../../client/gameplay/travel/journey.js';
import { loadWorldFromDir } from './travel/data.js';
import { migratePlaces, normalizeFound, hasFound, addFound } from '../../client/gameplay/travel/identity.js';
import { isMantellan } from '../../client/world/interiors/dungeonAccess.js';
import { fastTravelMinutes, freeTavernRooms } from '../../client/gameplay/guilds/perks.js';

export const name = 'travel';

// Legacy string ids awaiting conversion. Exceeds the entire 15,251-location Iliac Bay catalogue so no
// legacy discovery list is truncated before MAPS.BSA migration converts it to compact `found` storage.
const MAX_DISCOVERED = 16384;
const MAX_POSITIONS = 64;
const TRAVEL_COOLDOWN_MS = 1500;
const r3 = (v) => Math.round(v * 1000) / 1000;

export function install(ctx, { loadWorld = loadWorldFromDir } = {}) {
  const log = ctx.log ?? console;
  let world = null; // { catalog, climate, politic }
  let source = ctx.dataPath ? 'loading' : 'classic';
  let loadError = null;
  const lastTravelAt = new Map(); // player id -> ms
  let ready = Promise.resolve();

  if (!ctx.dataPath) {
    world = { catalog: classicCatalog(), climate: null, politic: null };
  } else {
    ready = Promise.resolve()
      .then(() => loadWorld(ctx.dataPath, ctx.services.worldData?.ready))
      .then(
        (w) => {
          world = w;
          source = 'files';
          log.info?.(`[travel] ${w.catalog.size} locations in ${w.catalog.regions.length} regions`);
        },
        (err) => {
          loadError = err;
          world = { catalog: classicCatalog(), climate: null, politic: null };
          source = 'classic';
          log.error?.(`[travel] could not read the world map from ${ctx.dataPath}: ${err.message}. Only the starter towns can be visited.`);
        },
      )
      .then(() => {
        for (const p of ctx.players.values()) {
          prepare(p);
          ctx.dirty(p);
        }
      });
  }

  const ensure = (p) => {
    const rpg = p.rpg;
    const t = rpg.travel && typeof rpg.travel === 'object' && !Array.isArray(rpg.travel) ? rpg.travel : {};
    t.discovered = Array.isArray(t.discovered) ? t.discovered.filter((s) => typeof s === 'string').slice(-MAX_DISCOVERED) : [];
    t.found = normalizeFound(t.found);
    if (!t.positions || typeof t.positions !== 'object' || Array.isArray(t.positions)) t.positions = {};
    t.trips = Number.isInteger(t.trips) && t.trips >= 0 ? t.trips : 0;
    t.daysOnRoad = Number.isInteger(t.daysOnRoad) && t.daysOnRoad >= 0 ? t.daysOnRoad : 0;
    t.options = normalizeOptions(t.options);
    t.server = source;
    rpg.travel = t;
    return t;
  };

  /** Validate a stored location on join and once the catalogue has loaded. */
  function prepare(p) {
    ensure(p);
    if (!world || source !== 'files') return;
    const changed = migratePlaces(p.rpg, world.catalog);
    if (changed.length > 1 || (changed.length && changed[0] !== 'travel.identity')) {
      log.info?.(`[travel] ${p.name}: converted place addresses (${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ', …' : ''})`);
    }
    const t = ensure(p);
    const loc = p.rpg.location;
    if (!parseLocationId(loc)) return;
    const entry = world.catalog.get(loc);
    if (!entry) {
      log.warn?.(`[travel] ${p.name}: unknown saved location ${JSON.stringify(loc)}; returning to ${ctx.defaultLocation}`);
      p.rpg.location = ctx.defaultLocation;
      p.x = 0;
      p.z = 0;
      p.yaw = 0;
    } else {
      if (entry.id !== loc) p.rpg.location = entry.id; // canonical spelling
      discover(t, entry);
    }
  }

  function discover(t, entry) {
    if (isVisible(t, entry)) return false;
    if (Number.isInteger(entry.index)) return addFound(t.found, entry);
    t.discovered.push(entry.id);
    if (t.discovered.length > MAX_DISCOVERED) t.discovered.splice(0, t.discovered.length - MAX_DISCOVERED);
    return true;
  }

  const isVisible = (t, entry) => entry.discovered || hasFound(t.found, entry) || t.discovered.includes(entry.id);

  function transportOf(p) {
    const inv = Array.isArray(p.rpg.inventory) ? p.rpg.inventory : [];
    const has = (re) => inv.some((it) => it && typeof it.template === 'string' && re.test(it.template));
    if (has(/^horse$/)) return 'horse';
    if (has(/^(small-)?cart$/)) return 'cart';
    return 'foot';
  }

  function quote(p, entryFrom, entryTo, options, { questClock = false } = {}) {
    const climateAt = world.climate ? (x, y) => world.climate.atMapPixel(x, y) : null;
    if (questClock) {
      // Clock.cs: CalculateTravelTime(endPos, speedCautious: true, sleepModeInn: false, travelShip: false,
      // hasHorse: false, hasCart: true), with no Akatosh shortening and whatever the player carries.
      return quoteJourney(entryFrom, entryTo, { speed: 'cautious', lodging: 'camp', ship: false }, { climateAt, transport: 'cart' });
    }
    return quoteJourney(entryFrom, entryTo, options, {
      climateAt,
      transport: transportOf(p),
      freePassage: hasFreeShipPassage(p.rpg) || ctx.services.property?.ownsShip?.(p) === true,
      // Guild perks (package 15, client/gameplay/guilds/perks.js): Akatosh journey time, knightly free inn rooms.
      fastTravel: (m) => fastTravelMinutes(m, p.rpg.guilds),
      freeInnRooms: freeTavernRooms(p.rpg.guilds, entryFrom?.regionIndex),
    });
  }

  /** Where a player's current location sits on the world map (towns, or the town a building belongs to). */
  function originOf(p) {
    const loc = p.rpg.location;
    const direct = world.catalog.get(loc) ?? wildernessOrigin(loc, world.politic);
    if (direct) return direct;
    const t = p.rpg.travel;
    if (t?.lastTown) return world.catalog.get(t.lastTown);
    return world.catalog.get(ctx.defaultLocation);
  }

  function resolveDestination(p, raw) {
    if (typeof raw !== 'string' || !raw) throw new Error('Choose a destination.');
    if (!parseLocationId(raw)) throw new Error('That is not a place on the travel map.');
    if (!world) throw new Error('The world map is still being read on the server. Try again in a moment.');
    const entry = world.catalog.get(raw);
    if (!entry) {
      if (source === 'classic') throw new Error('This server only knows the starter towns; that place is not one of them.');
      throw new Error('There is no such place in the Iliac Bay.');
    }
    if (isMantellan(entry.regionIndex, entry.index)) throw new Error('The Mantellan Crux is reached through Nulfaga’s quest.');
    // The two "Your Ship" records are decks: their owner boards with ship.board (server/rpg/property.js).
    if (entry.type === 'ships' || ctx.services.property?.isShipLocation?.(entry.id)) throw new Error('Only a ship’s owner can go aboard, from the Property panel.');
    if (!isVisible(p.rpg.travel, entry)) throw new Error(`You have not yet heard of ${entry.name.trim()}.`);
    return entry;
  }

  ctx.onJoin((p) => {
    prepare(p);
    const loc = p.rpg.location;
    if (parseLocationId(loc)) p.rpg.travel.lastTown = loc;
  });

  ctx.onLeave((p) => {
    lastTravelAt.delete(p.id);
  });

  const REQUEST_RE = /^[\w-]{6,64}$/;
  const tripEvent = (trip, entry) => ({
    kind: 'travel',
    from: trip.from, to: trip.to, name: entry.name.trim(), region: entry.region,
    days: trip.days, minutes: trip.minutes, cost: trip.cost, transport: trip.transport,
    options: trip.options, mounted: trip.mounted, route: trip.route, showMs: trip.showMs,
    requestId: trip.requestId ?? null, trip: trip.n,
    // With a route the browser's journey view tells the arrival when it lands (client/gameplay/journey.js).
    silent: !!trip.route,
    text: `After ${trip.days} day${trip.days === 1 ? '' : 's'} on the road you arrive in ${entry.name.trim()}${trip.cost ? ` (${trip.cost} gold spent)` : ''}.`,
  });

  ctx.onAction('travel.go', (p, args) => {
    const t = ensure(p);
    const requestId = typeof args.requestId === 'string' && REQUEST_RE.test(args.requestId) ? args.requestId : null;
    if (requestId && t.lastTrip?.requestId === requestId) {
      // A retry of the journey that already happened: answer it again, charge nothing.
      const entry = world?.catalog.get(t.lastTrip.to);
      if (entry) ctx.notify(p, { ...tripEvent(t.lastTrip, entry), repeat: true });
      return;
    }
    const from = p.rpg.location;
    if (ctx.services.sailing?.aboard(p)) throw new Error('Make port and go ashore before starting an overland journey.');
    const fromTown = parseLocationId(from);
    if (!fromTown && !wildernessOrigin(from)) throw new Error('Step outside before you set off on a journey.');
    // DaggerfallUI dfuiOpenTravelMapWindow: no journey with enemies about, nor while a condition forbids it
    // (sunlight careers by day, jail). Package 20: docs/calendar-rest-protocol.md.
    if (ctx.services.enemiesNearby?.(p)) throw new Error('You cannot travel with enemies nearby.');
    const blocked = ctx.services.travelPrevented?.(p);
    if (blocked) throw new Error(blocked);
    const entry = resolveDestination(p, args.to);
    if (entry.id === from) throw new Error(`You are already in ${entry.name.trim()}.`);
    const now = ctx.now();
    const last = lastTravelAt.get(p.id);
    if (last !== undefined && now - last < TRAVEL_COOLDOWN_MS) throw new Error('You have only just arrived. Catch your breath first.');

    const origin = originOf(p) ?? entry;
    const q = quote(p, origin, entry, args.options ?? t.options);
    if (args.expectCost !== undefined && args.expectCost !== q.cost.total) {
      throw new Error(`The price has changed to ${q.cost.total} gold. Check the journey and confirm again.`);
    }
    const gold = Number.isFinite(p.rpg.gold) ? p.rpg.gold : 0;
    if (q.cost.total > gold) throw new Error(`You need ${q.cost.total} gold for this journey and have ${gold}.`);

    // All checks passed: commit.
    if (q.cost.total > 0) {
      if (typeof ctx.services.takeItem === 'function') ctx.services.takeItem(p, 'gold', q.cost.total);
      else p.rpg.gold = gold - q.cost.total;
    }
    if (fromTown) {
      const keys = Object.keys(t.positions);
      if (keys.length >= MAX_POSITIONS && !(from in t.positions)) delete t.positions[keys[0]];
      t.positions[from] = { x: r3(p.x), z: r3(p.z), yaw: r3(p.yaw) };
    }
    const back = t.positions[entry.id];
    p.rpg.location = entry.id;
    t.lastTown = entry.id;
    discover(t, entry);
    t.options = q.options;
    t.trips += 1;
    t.daysOnRoad += q.days;
    const place = (e) => ({ x: e.x | 0, y: e.y | 0, name: String(e.name ?? '').trim().slice(0, 64), region: String(e.region ?? '').slice(0, 64) });
    t.lastTrip = {
      from, to: entry.id, days: q.days, minutes: q.minutes, cost: q.cost.total,
      options: q.options, transport: q.transport, at: Date.now(),
      n: t.trips, requestId, route: { from: place(origin), to: place(entry) },
      mounted: ctx.services.mount?.isRiding?.(p) === true,
      showMs: presentationMs(q.days),
    };
    if (q.options.speed === 'cautious') {
      // Classic: a cautious journey arrives rested (DaggerfallTravelPopUp.PerformFastTravel).
      const c = p.rpg.character;
      if (c && typeof c === 'object') {
        for (const [cur, max] of [['health', 'maxHealth'], ['fatigue', 'maxFatigue'], ['magicka', 'maxMagicka']]) {
          if (Number.isFinite(c[max]) && Number.isFinite(c[cur])) c[cur] = c[max];
        }
      }
    }
    p.x = back ? back.x : 0;
    p.z = back ? back.z : 0;
    p.yaw = back ? back.yaw : 0;
    p.forward = 0;
    p.strafe = 0;
    p.moving = false;
    lastTravelAt.set(p.id, now);

    ctx.notify(p, tripEvent(t.lastTrip, entry));
    // The journey's days belong to this traveller only; the shared clock does not move.
    ctx.services.spendTime?.(p, q.minutes, 'travel');
    ctx.emit('travel', { player: p, from, to: entry.id });
  });

  const service = {
    /** Catalogue entry for a `town:` id, or null. */
    lookup: (id) => (world ? world.catalog.get(id) : null),
    /** Catalogue entries of one region (by MAPS region index), for quest site selection. [] while loading. */
    regionLocations: (regionIndex) => (world?.catalog.source === 'files' ? world.catalog.locations.filter((l) => l.regionIndex === regionIndex) : []),
    get source() { return source; },
    get loadError() { return loadError?.message ?? null; },
    /** Reveal a location on a player's map (quests, rumours). Returns true when newly revealed. */
    discover(p, id) {
      const entry = world?.catalog.get(id);
      if (!entry) return false;
      const added = discover(ensure(p), entry);
      if (added) ctx.dirty(p);
      return added;
    },
    /** Journey quote to any catalogued place, revealed or not (quest clocks; never used to move a player). */
    estimate(p, id, options) {
      const entry = world?.catalog.get(id);
      return entry ? quote(p, originOf(p), entry, options ?? ensure(p).options) : null;
    },
    /** One-way quest clock leg to a catalogued place from where the player stands (Clock.cs travel settings). */
    questClockMinutes(p, id) {
      const entry = world?.catalog.get(id);
      return entry ? quote(p, originOf(p), entry, null, { questClock: true }).minutes : null;
    },
    quote(p, id, options) {
      const entry = resolveDestination(p, id);
      return quote(p, originOf(p), entry, options);
    },
    /**
     * PlayerGPS.DiscoverRandomLocation: reveal one random place of the player's current region that neither MAPTABLE
     * nor this character already knows, on this character's own map. Shared by map items (server/rpg/items/mapItem.js)
     * and the guild secrets that use the same selection (ThievesGuild/DarkBrotherhood, package 15). Call inside an
     * action so a refused or unsaved action rolls the discovery back with everything else.
     *   {status:'revealed', entry} | {status:'exhausted', region} | {status:'unavailable', reason}
     * `unavailable`: the installed world map is not (yet) read, or the player's region cannot be told; nothing changed.
     * `filter(entry)` narrows the candidates further (e.g. a guild that only reveals dungeons).
     */
    discoverRandomLocation(p, { random = Math.random, filter = null } = {}) {
      if (!world || source !== 'files') {
        return { status: 'unavailable', reason: source === 'loading' ? 'loading' : 'no-world-data' };
      }
      const t = ensure(p);
      const regionName = regionOfPlace(p.rpg.location, world) ?? (t.lastTown ? regionOfPlace(t.lastTown, world) : null);
      const key = String(regionName ?? '').toLowerCase();
      const region = key ? world.catalog.regions.find((r) => String(r).toLowerCase() === key) : null;
      if (!region) return { status: 'unavailable', reason: 'no-region' };
      const candidates = world.catalog.locations.filter((e) => e.region === region
        && !isVisible(t, e)
        // Places this server never lets anyone travel to are not a reward.
        && e.type !== 'ships' && !ctx.services.property?.isShipLocation?.(e.id) && !isMantellan(e.regionIndex, e.index)
        && (typeof filter !== 'function' || filter(e)));
      if (!candidates.length) return { status: 'exhausted', region };
      const r = Number(random());
      const entry = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * candidates.length)))];
      discover(t, entry);
      ctx.dirty(p);
      return { status: 'revealed', entry };
    },
    /**
     * Guild teleport (Mages Guild rank 8, package 15; DaggerfallTeleportPopUp.TeleportAway): instantly and for free
     * to any place this character can see on the travel map, from wherever they stand (indoors included). The
     * caller checks the service and its rank. Returns the catalogue entry. Throws the travel map's refusals.
     */
    teleport(p, id) {
      const t = ensure(p);
      const entry = resolveDestination(p, id);
      if (entry.id === p.rpg.location) throw new Error(`You are already in ${entry.name.trim()}.`);
      const from = p.rpg.location;
      const back = t.positions[entry.id];
      const landing = { location: entry.id, x: back ? back.x : 0, z: back ? back.z : 0, yaw: back ? back.yaw : 0 };
      if (typeof ctx.services.portals?.transfer === 'function') ctx.services.portals.transfer(p, landing, { label: 'a guild teleport' });
      else {
        p.rpg.location = entry.id;
        delete p.rpg.portal;
        Object.assign(p, { x: landing.x, z: landing.z, yaw: landing.yaw, moving: false, forward: 0, strafe: 0 });
        ctx.emit('locationChanged', { player: p, from, to: entry.id });
      }
      t.lastTown = entry.id;
      discover(t, entry);
      lastTravelAt.set(p.id, ctx.now());
      ctx.dirty(p);
      ctx.emit('travel', { player: p, from, to: entry.id, teleport: true });
      return entry;
    },
    mapPixelOf,
    /** Political region of a place address (wilderness pixels via POLITIC.PAK), or null while MAPS.BSA loads. */
    regionOf: (location) => (world && source === 'files' ? regionOfPlace(location, world) : null),
    climateOf: (location) => climateOfPlace(location, world),
  };
  ctx.services.travel = service;

  return { get ready() { return ready; }, service };
}

