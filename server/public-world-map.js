// Public projection of joined sessions for the website map (website/app/map/).
// Only catalogue identities, labels, map pixels and aggregate counts cross this boundary.
// Account ids, character names and sheets, portal labels, quests and local positions stay
// on the game connection.
import { classicCatalog } from '../client/gameplay/travel/classic.js';
import { exteriorOf } from '../client/world/interiors/index.js';
import { isMapPixel, parseWildernessId } from '../client/world/wilderness/data.js';
import { fromGlobal } from '../client/world/exterior/frame.js';

export const PUBLIC_MAP_PATH = '/api/world-map';
const starters = classicCatalog();

const INSTANCE_RE = /^(building|interior|dungeon):/;

/**
 * Exterior map place of one session, or null when it cannot be placed without guessing.
 * `lookup(id)` is the travel service's catalogue lookup (Catalog#get): it resolves both a
 * historic `town:Region/Name` address and the numeric `town:<regionIndex>/<index>` slot used
 * for later records sharing a name. Without the operator's MAPS.BSA, the starter list answers.
 * Returns { id, kind: 'town'|'wilderness', x, y, name, region, inside }.
 */
export function publicMapLocation(rpg, lookup) {
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
    return { id: `wilderness:${pixel.px},${pixel.py}`, kind: 'wilderness', x: pixel.px, y: pixel.py, name: 'Wilderness', region: null, inside };
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

/**
 * Aggregates sessions by occupied map pixel. A town and wilderness at the same pixel merge
 * under the town. `online` counts players who have entered the world, including those without a known map pixel.
 */
export function publicWorldMap(players, lookup, now = Date.now(), sailing) {
  const byPixel = new Map();
  let online = 0;
  for (const player of players) {
    if (player?.arriving) continue;
    online++;
    const vessel = sailing?.aboard(player);
    let place;
    if (vessel) {
      const { px, py } = fromGlobal(vessel.x, vessel.z);
      if (!isMapPixel(px, py)) continue;
      place = { id: `sea:${px},${py}`, kind: 'sea', name: 'Iliac Bay', region: null, x: px, y: py, inside: INSTANCE_RE.test(player.rpg?.location) };
    } else {
      place = publicMapLocation(player?.rpg, lookup);
    }
    if (!place) continue;
    const key = place.y * 1000 + place.x;
    let entry = byPixel.get(key);
    if (!entry) {
      entry = { id: place.id, kind: place.kind, name: place.name, region: place.region, x: place.x, y: place.y, count: 0, inside: 0 };
      byPixel.set(key, entry);
    } else if (entry.kind !== 'town' && place.kind === 'town') {
      Object.assign(entry, { id: place.id, kind: 'town', name: place.name, region: place.region });
    } else if (entry.kind === 'wilderness' && place.kind === 'sea') {
      Object.assign(entry, { id: place.id, kind: 'sea', name: place.name, region: place.region });
    }
    entry.count++;
    if (place.inside) entry.inside++;
  }
  const locations = [...byPixel.values()].sort((a, b) =>
    b.count - a.count || a.name.localeCompare(b.name) || a.y - b.y || a.x - b.x);
  const placed = locations.reduce((n, l) => n + l.count, 0);
  return { version: 1, generatedAt: new Date(now).toISOString(), online, unplaced: online - placed, locations };
}

export function handlePublicWorldMap(req, res, players, travel, sailing) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"error":"method not allowed"}');
  }
  let body;
  try {
    body = JSON.stringify(publicWorldMap(players.values(), travel?.lookup, Date.now(), sailing));
  } catch (err) {
    console.error('[game] world map projection failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end('{"error":"unavailable"}');
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
