// Deterministic single-world zone router for Iliac Bay.
//
// Zero shards, zero isolated realms: every location in Iliac Bay maps deterministically to a
// canonical zone key, and Rendezvous (Highest Random Weight) hashing assigns each zone to one
// authoritative worker. Everyone in the same town, interior, dungeon, or wilderness sector
// always lands on the SAME worker, while different regions/sectors scale horizontally across
// CPU cores or hosts.

import { createHash } from 'node:crypto';
import { regionNameOf, splitAddress } from '../../client/gameplay/travel/identity.js';
import { parseWildernessId } from '../../client/world/wilderness/data.js';

export const DEFAULT_WILDERNESS_SECTOR_SIZE = 32; // 32x32 map pixels (~26 km x 26 km) per sector
export const DEFAULT_SEA_SECTOR_SIZE = 64; // 64x64 map pixels per open-sea sector

const SEA_RE = /^sea:(\d+),(\d+)$/;

function foldKey(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * Resolve any Iliac Bay location string to its canonical zone descriptor.
 *
 * Co-location invariants:
 *   - `town:Daggerfall/Gothway Garden`, `town:17/197`, `interior:Daggerfall/Gothway Garden/1,2/3`,
 *     `interior:17/197/1,2/3`, `building:Daggerfall/Gothway Garden/b:1,2:3`, and
 *     `dungeon:Daggerfall/Privateer's Hold` all resolve to `region:daggerfall`.
 *   - `wilderness:<px>,<py>` groups into `wilderness:<sx>,<sy>` sectors.
 *   - `sea:<px>,<py>` groups into `sea:<sx>,<sy>` sectors.
 */
export function canonicalZone(location, options = {}) {
  const sectorSize = options.sectorSize ?? DEFAULT_WILDERNESS_SECTOR_SIZE;
  const seaSectorSize = options.seaSectorSize ?? DEFAULT_SEA_SECTOR_SIZE;

  if (typeof location !== 'string' || !location.trim()) {
    return { zoneKey: 'region:unknown', kind: 'unknown', region: null, sector: null };
  }
  const loc = location.trim();

  // 1. Wilderness pixel: `wilderness:<px>,<py>`
  const wild = parseWildernessId(loc);
  if (wild) {
    const sx = Math.floor(wild.px / sectorSize);
    const sy = Math.floor(wild.py / sectorSize);
    return { zoneKey: `wilderness:${sx},${sy}`, kind: 'wilderness', region: null, sector: { sx, sy } };
  }

  // 2. Open sea pixel: `sea:<px>,<py>`
  const seaMatch = SEA_RE.exec(loc);
  if (seaMatch) {
    const px = Number(seaMatch[1]);
    const py = Number(seaMatch[2]);
    const sx = Math.floor(px / seaSectorSize);
    const sy = Math.floor(py / seaSectorSize);
    return { zoneKey: `sea:${sx},${sy}`, kind: 'sea', region: null, sector: { sx, sy } };
  }

  // 3. Structured classic addresses: town, interior, building, dungeon (`<kind>:<region>/<location>...`)
  const parsed = splitAddress(loc);
  if (parsed) {
    const region = regionNameOf(parsed.region);
    return { zoneKey: `region:${foldKey(region)}`, kind: parsed.kind, region, sector: null };
  }

  // 4. Legacy single-segment dungeon address (e.g. `dungeon:Privateer's Hold` or `dungeon:Crypt`)
  if (loc.startsWith('dungeon:')) {
    const name = loc.slice('dungeon:'.length);
    return { zoneKey: `dungeon:${foldKey(name)}`, kind: 'dungeon', region: null, sector: null };
  }

  // 5. Fallback for any other custom/test location string (still deterministic across all workers).
  const body = loc.includes(':') ? loc.slice(loc.indexOf(':') + 1) : loc;
  const head = body.split('/')[0];
  const region = regionNameOf(head);
  return { zoneKey: `misc:${foldKey(region || loc)}`, kind: 'misc', region: region || null, sector: null };
}

/** Deterministic 64-bit score for Rendezvous (HRW) hashing. */
function hrwScore(workerId, zoneKey, weight = 1) {
  const digest = createHash('sha256').update(`${workerId}\0${zoneKey}`).digest();
  // Read top 53 bits as a uniform float in (0, 1] for weighted rendezvous hashing.
  const hi = digest.readUInt32BE(0);
  const lo = digest.readUInt32BE(4) >>> 11; // 21 bits
  const u = (hi * 2097152 + lo + 1) / 9007199254740993; // strictly in (0, 1)
  // Weighted HRW: -weight / ln(u) maximizes probability proportional to `weight`.
  return -weight / Math.log(u);
}

function normalizeWorker(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    if (!id) throw new TypeError('ZoneRouter worker id must be a non-empty string');
    return Object.freeze({ id, url: null, weight: 1, regions: [] });
  }
  if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim()) {
    throw new TypeError('ZoneRouter worker entry must be a string or { id, url?, weight?, regions? }');
  }
  const weight = entry.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new RangeError(`ZoneRouter worker weight must be positive, got ${entry.weight}`);
  }
  const regions = Array.isArray(entry.regions) ? entry.regions.map((r) => `region:${foldKey(regionNameOf(r))}`) : [];
  return Object.freeze({
    id: entry.id.trim(),
    url: typeof entry.url === 'string' ? entry.url : null,
    weight,
    regions: Object.freeze(regions),
  });
}

/**
 * Create a deterministic single-world zone router.
 *
 * @param {object} [options]
 * @param {Array<string|{id:string, url?:string, weight?:number, regions?:string[]}>} [options.workers=['world-0']]
 * @param {number} [options.sectorSize=32]
 * @param {number} [options.seaSectorSize=64]
 * @param {Record<string, string>} [options.overrides] Map of zoneKey (or region name) -> workerId.
 */
export function createZoneRouter(options = {}) {
  const sectorSize = options.sectorSize ?? DEFAULT_WILDERNESS_SECTOR_SIZE;
  const seaSectorSize = options.seaSectorSize ?? DEFAULT_SEA_SECTOR_SIZE;
  const rawWorkers = options.workers?.length ? options.workers : ['world-0'];
  const workerList = rawWorkers.map(normalizeWorker);
  const byId = new Map();
  for (const w of workerList) {
    if (byId.has(w.id)) throw new Error(`ZoneRouter duplicate worker id "${w.id}"`);
    byId.set(w.id, w);
  }

  // Build explicit zone overrides (both from `worker.regions` and `options.overrides`).
  const pinned = new Map();
  for (const w of workerList) {
    for (const rk of w.regions) pinned.set(rk, w);
  }
  if (options.overrides && typeof options.overrides === 'object') {
    for (const [rawKey, wid] of Object.entries(options.overrides)) {
      const target = byId.get(wid);
      if (!target) throw new Error(`ZoneRouter override references unknown worker "${wid}"`);
      const key = rawKey.includes(':') ? rawKey.toLowerCase() : `region:${foldKey(regionNameOf(rawKey))}`;
      pinned.set(key, target);
    }
  }

  const cache = new Map(); // zoneKey -> worker

  function workerForZone(zoneKey) {
    const hit = cache.get(zoneKey);
    if (hit) return hit;

    let chosen = pinned.get(zoneKey) ?? null;
    if (!chosen) {
      if (workerList.length === 1) {
        chosen = workerList[0];
      } else {
        let bestScore = -Infinity;
        for (const w of workerList) {
          const score = hrwScore(w.id, zoneKey, w.weight);
          if (score > bestScore || (score === bestScore && w.id < chosen.id)) {
            bestScore = score;
            chosen = w;
          }
        }
      }
    }
    cache.set(zoneKey, chosen);
    return chosen;
  }

  function route(location) {
    const zone = canonicalZone(location, { sectorSize, seaSectorSize });
    const worker = workerForZone(zone.zoneKey);
    return {
      ...zone,
      workerId: worker.id,
      worker,
    };
  }

  function owns(workerId, location) {
    return route(location).workerId === workerId;
  }

  function needsHandoff(currentWorkerId, targetLocation) {
    const dest = route(targetLocation);
    return {
      required: dest.workerId !== currentWorkerId,
      fromWorkerId: currentWorkerId,
      toWorkerId: dest.workerId,
      toWorker: dest.worker,
      zoneKey: dest.zoneKey,
      kind: dest.kind,
      region: dest.region,
    };
  }

  return Object.freeze({
    route,
    owns,
    needsHandoff,
    canonicalZone: (location) => canonicalZone(location, { sectorSize, seaSectorSize }),
    workerById: (id) => byId.get(id) ?? null,
    workers: () => workerList.slice(),
  });
}
