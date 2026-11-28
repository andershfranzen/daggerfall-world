// Public projection of joined sessions for the website map (website/app/map/).
// Only catalogue identities, labels, map pixels and aggregate counts cross this boundary.
// Account ids, character names and sheets, portal labels, quests and local positions stay
// on the game connection.
import { classicCatalog } from '../client/gameplay/travel/classic.js';
import { LOCATION_TYPES, REGION_NAMES } from '../client/gameplay/travel/catalog.js';
import { exteriorOf } from '../client/world/interiors/index.js';
import { isMapPixel, parseWildernessId } from '../client/world/wilderness/data.js';
import { fromGlobal } from '../client/world/exterior/frame.js';
import { dateFromMinutes, formatDate, formatTime } from '../client/gameplay/atmosphere/calendar.js';
import { isMantellan } from '../client/world/interiors/dungeonAccess.js';

export const PUBLIC_MAP_PATH = '/api/world-map';
export const PUBLIC_MAP_POIS_PATH = '/api/world-map/pois';
const starters = classicCatalog();
const POI_TYPES = LOCATION_TYPES.filter((t) => t.id !== 'ships').map((t) => t.id);
const POI_TYPE_INDEX = new Map(POI_TYPES.map((id, i) => [id, i]));
const REGION_INDEX = new Map(REGION_NAMES.map((name, i) => [name, i]));
let cachedPois = null;

const INSTANCE_RE = /^(building|interior|dungeon):/;

/**
 * Exterior map place of one session, or null when it cannot be placed without guessing.
 * `lookup(id)` is the travel service's catalogue lookup (Catalog#get): it resolves both a
 * historic `town:Region/Name` address and the numeric `town:<regionIndex>/<index>` slot used
 * for later records sharing a name. Without the operator's MAPS.BSA, the starter list answers.
 * Optional `regionOf(location)` resolves a wilderness pixel's political region via POLITIC.PAK.
 * Returns { id, kind: 'town'|'wilderness', x, y, name, region, inside }.
 */
export function publicMapLocation(rpg, lookup, regionOf = null) {
  const location = rpg?.location;
  if (typeof location !== 'string') return null;
  let exterior = location;
  const inside = INSTANCE_RE.test(location);
  if (inside) {
    const portal = rpg.portal?.to === location ? rpg.portal : null;
    // The active entrance wins, including an entrance out in the wilderness. Older saves
    // retain the town in the instance address even if they lack a portal record.
    exterior = portal?.returnTo?.location ?? portal?.from ?? exteriorOf(location);
    if (!exterior && location.startsWith('building:')) {
      const legacy = /^building:([^/]+\/[^/]+)\/.+$/.exec(location);
      if (legacy) exterior = 'town:' + legacy[1];
    }
  }
  if (typeof exterior !== 'string') return null;
  const pixel = parseWildernessId(exterior);
  if (pixel) {
    const region = safeRegionOf(regionOf, exterior);
    return { id: `wilderness:${pixel.px},${pixel.py}`, kind: 'wilderness', x: pixel.px, y: pixel.py, name: 'Wilderness', region, inside };
  }
  if (!exterior.startsWith('town:')) return null;
  const place = safeLookup(lookup, exterior) ?? starters.get(exterior);
  if (!place || !isMapPixel(place.x, place.y)) return null;
  const name = String(place.name ?? '').trim();
  if (!name) return null;
  return { id: place.id, kind: 'town', x: place.x, y: place.y, name, region: place.region ?? null, inside };
}

function safeLookup(lookup, id) {
  try {
    return typeof lookup === 'function' ? lookup(id) : null;
  } catch {
    return null;
  }
}

function safeRegionOf(regionOf, id) {
  try {
    const r = typeof regionOf === 'function' ? regionOf(id) : null;
    return typeof r === 'string' && r.trim() ? r.trim() : null;
  } catch {
    return null;
  }
}

function projectWorldTime(worldClock) {
  if (typeof worldClock !== 'function') return null;
  try {
    const raw = worldClock();
    if (!raw || typeof raw !== 'object') return null;
    const d = Number.isFinite(raw.year) && raw.monthName && raw.dayName
      ? raw
      : Number.isFinite(raw.minutes)
        ? dateFromMinutes(raw.minutes)
        : null;
    if (!d) return null;
    return {
      year: d.year,
      month: d.month,
      day: d.day,
      hour: d.hour,
      minute: d.minute,
      dayName: d.dayName,
      monthName: d.monthName,
      season: d.season,
      isNight: Boolean(d.isNight),
      dateLabel: formatDate(d),
      timeLabel: formatTime(d),
    };
  } catch {
    return null;
  }
}

function mergePlace(byPixel, place, count = 1, insideCount = place.inside ? 1 : 0) {
  if (!place || !isMapPixel(place.x, place.y)) return;
  const key = place.y * 1000 + place.x;
  let entry = byPixel.get(key);
  if (!entry) {
    entry = {
      id: place.id,
      kind: place.kind,
      name: place.name,
      region: place.region ?? null,
      x: place.x,
      y: place.y,
      count: 0,
      inside: 0,
    };
    byPixel.set(key, entry);
  } else if (entry.kind !== 'town' && place.kind === 'town') {
    Object.assign(entry, { id: place.id, kind: 'town', name: place.name, region: place.region ?? null });
  } else if (entry.kind === 'wilderness' && place.kind === 'sea') {
    Object.assign(entry, { id: place.id, kind: 'sea', name: place.name, region: place.region ?? null });
  }
  entry.count += count;
  entry.inside += insideCount;
}

function resolveRemoteSnapshots(extra) {
  if (!extra) return [];
  if (Array.isArray(extra)) return extra;
  if (typeof extra.getRemoteSnapshots === 'function') return extra.getRemoteSnapshots();
  if (typeof extra.worldBus?.getRemoteSnapshots === 'function') return extra.worldBus.getRemoteSnapshots();
  if (Array.isArray(extra.remoteSnapshots)) return extra.remoteSnapshots;
  return [];
}

/**
 * Merge multiple world-map snapshots (e.g. from zone workers of the same Iliac Bay world)
 * into a single unified world-map projection.
 */
export function mergeWorldMapSnapshots(snapshots, now = Date.now()) {
  const byPixel = new Map();
  let online = 0;
  let vessels = 0;
  for (const snap of snapshots) {
    if (!snap || typeof snap !== 'object') continue;
    if (Number.isFinite(snap.online) && snap.online > 0) online += snap.online;
    if (Number.isFinite(snap.vessels) && snap.vessels > 0) vessels += snap.vessels;
    for (const loc of Array.isArray(snap.locations) ? snap.locations : []) {
      const count = Number.isFinite(loc?.count) && loc.count > 0 ? loc.count : 0;
      if (!count) continue;
      const inside = Number.isFinite(loc?.inside) && loc.inside > 0 ? loc.inside : 0;
      mergePlace(byPixel, loc, count, inside);
    }
  }
  const locations = [...byPixel.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name) || a.y - b.y || a.x - b.x);
  const placed = locations.reduce((n, l) => n + l.count, 0);
  return { version: 1, generatedAt: new Date(now).toISOString(), online, unplaced: Math.max(0, online - placed), vessels, locations };
}

/**
 * Aggregates sessions by occupied map pixel. A town and wilderness at the same pixel merge
 * under the town. `online` counts players who have entered the world, including those without a known map pixel.
 * Optional `extra` accepts a `worldBus` (with `getRemoteSnapshots()`), an array of remote zone
 * snapshots, or `{ worldBus, remoteSnapshots }` so `/api/world-map` reflects the entire single world.
 */
export function publicWorldMap(players, lookup, now = Date.now(), sailing, extra = null) {
  const byPixel = new Map();
  const seenVessels = new Set();
  const regionOf = extra && !Array.isArray(extra) ? extra.regionOf : null;
  const worldClock = extra && !Array.isArray(extra) ? extra.worldClock : null;
  let online = 0;
  let remoteVessels = 0;
  for (const player of players) {
    if (player?.arriving) continue;
    online++;
    const vessel = sailing?.aboard(player);
    let place;
    if (vessel) {
      seenVessels.add(vessel);
      const { px, py } = fromGlobal(vessel.x, vessel.z);
      if (!isMapPixel(px, py)) continue;
      place = { id: `sea:${px},${py}`, kind: 'sea', name: 'Iliac Bay', region: null, x: px, y: py, inside: INSTANCE_RE.test(player.rpg?.location) };
    } else {
      place = publicMapLocation(player?.rpg, lookup, regionOf);
    }
    if (!place) continue;
    mergePlace(byPixel, place, 1, place.inside ? 1 : 0);
  }
  const remoteSnapshots = resolveRemoteSnapshots(extra);
  for (const snap of remoteSnapshots) {
    if (!snap || typeof snap !== 'object') continue;
    if (Number.isFinite(snap.online) && snap.online > 0) online += snap.online;
    if (Number.isFinite(snap.vessels) && snap.vessels > 0) remoteVessels += snap.vessels;
    for (const loc of Array.isArray(snap.locations) ? snap.locations : []) {
      const count = Number.isFinite(loc?.count) && loc.count > 0 ? loc.count : 0;
      if (!count) continue;
      const inside = Number.isFinite(loc?.inside) && loc.inside > 0 ? loc.inside : 0;
      mergePlace(byPixel, loc, count, inside);
    }
  }
  const locations = [...byPixel.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name) || a.y - b.y || a.x - b.x);
  const placed = locations.reduce((n, l) => n + l.count, 0);
  const worldTime = projectWorldTime(worldClock);
  const vessels = seenVessels.size + remoteVessels;
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    online,
    unplaced: Math.max(0, online - placed),
    vessels,
    ...(worldTime ? { worldTime } : {}),
    locations,
  };
}

/** Named-options helper for projecting the unified single-world online map. */
export function projectOnlineWorldMap({ players = [], lookup, now = Date.now(), sailing, worldBus, remoteSnapshots, regionOf, worldClock } = {}) {
  const hasExtra = Boolean(worldBus || remoteSnapshots || regionOf || worldClock);
  return publicWorldMap(players, lookup, now, sailing, hasExtra ? { worldBus, remoteSnapshots, regionOf, worldClock } : null);
}

export function handlePublicWorldMap(req, res, players, travel, sailing, extra = null) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"error":"method not allowed"}');
  }
  let body;
  try {
    const mergedExtra = {
      ...(extra && !Array.isArray(extra) ? extra : Array.isArray(extra) ? { remoteSnapshots: extra } : {}),
      ...(travel?.regionOf ? { regionOf: travel.regionOf } : {}),
    };
    body = JSON.stringify(publicWorldMap(players.values(), travel?.lookup, Date.now(), sailing, mergedExtra));
  } catch (err) {
    console.error('[game] world map projection failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"error":"unavailable"}');
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * Compact public Iliac Bay gazetteer (every non-ship, non-Mantellan location in the active catalogue).
 * Format: { version: 1, source, regions: string[], types: string[], pois: [regionIdx, name, typeIdx, x, y, id][] }.
 */
export function publicWorldPois(travel) {
  const source = travel?.source === 'files' ? 'files' : 'classic';
  const raw = Array.isArray(travel?.locations) && travel.locations.length ? travel.locations : starters.locations;
  const pois = [];
  for (const entry of raw) {
    if (!entry || entry.type === 'ships') continue;
    if (Number.isInteger(entry.regionIndex) && Number.isInteger(entry.index) && isMantellan(entry.regionIndex, entry.index)) continue;
    if (!isMapPixel(entry.x, entry.y)) continue;
    const name = String(entry.name ?? '').trim();
    if (!name) continue;
    const regionIdx = Number.isInteger(entry.regionIndex) ? entry.regionIndex : (REGION_INDEX.get(entry.region) ?? -1);
    const typeIdx = POI_TYPE_INDEX.get(entry.type) ?? -1;
    if (regionIdx < 0 || typeIdx < 0) continue;
    pois.push([regionIdx, name, typeIdx, entry.x, entry.y, entry.id]);
  }
  return { version: 1, source, regions: REGION_NAMES, types: POI_TYPES, pois };
}

export function handlePublicWorldPois(req, res, travel) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"error":"method not allowed"}');
  }
  try {
    const source = travel?.source === 'files' ? 'files' : 'classic';
    const rawCount = Array.isArray(travel?.locations) ? travel.locations.length : 0;
    const key = `${source}:${rawCount}`;
    if (!cachedPois || cachedPois.key !== key) {
      const json = JSON.stringify(publicWorldPois(travel));
      const buf = Buffer.from(json, 'utf8');
      const etag = `"pois-${source}-${rawCount}-${buf.length}"`;
      cachedPois = { key, buf, etag };
    }
    res.setHeader('Cache-Control', source === 'files' ? 'public, max-age=300' : 'no-store');
    res.setHeader('ETag', cachedPois.etag);
    if (req.headers['if-none-match'] === cachedPois.etag) {
      res.writeHead(304);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': cachedPois.buf.length });
    res.end(req.method === 'HEAD' ? undefined : cachedPois.buf);
  } catch (err) {
    console.error('[game] world map POIs failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end('{"error":"unavailable"}');
  }
}
