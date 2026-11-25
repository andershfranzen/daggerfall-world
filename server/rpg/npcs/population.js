// Mobile townspeople, following Daggerfall Unity's PopulationManager, CityNavigation, MobilePersonMotor and
// MobilePersonNPC (MIT, (c) 2009-2023 Daggerfall Workshop):
//  - navgrid: 64x64 cells per RMB block (1.6 m), a cell is walkable where the block automap is empty, weighted by
//    its ground tile (water 0, stone 4, dirt 6, grass 12, road 15, other 7);
//  - population: clamp(blocks / 16, 1, 4) * 24 people while it is day (06:00-18:00), each spawned on a walkable cell
//    up to 96 cells from a player, out of that player's 180 degree view or beyond 120 m, recycled beyond 150 m of
//    every player, after 5 failed seeks, or at dusk;
//  - motor: 1.3 m/s from cell to neighbouring cell; keep direction unless blocked, 2.5% random turn, prefer heavier
//    tiles (80% when the next is lighter); idle facing a player within 2.5 m;
//  - person: 1 in 32 is a city guard (male, archive 399); otherwise 50% female, outfit 0-3, race from the climate,
//    name from the region's NameHelper bank.
// Shared world: one pool per town, seeded per town and spawn number so a run is reproducible.

import { dfRandom, fullName, regionBank } from './people.js';
import { rng as mulberry, hash32 } from './rules.js';

export const CELL = 64 * 0.025; // CityNavigation.DaggerfallUnitsPerTile * GlobalScale = 1.6 m
const BLOCK_CELLS = 64;
export const POPULATION_PER_16_BLOCKS = 24;
export const SPAWN_RADIUS = 96; // cells
export const RECYCLE_DISTANCE = 150;
export const VISIBLE_POP_RANGE = 120;
export const SPEED = 1.3;
export const IDLE_DISTANCE = 2.5;
const RANDOM_CHANGE = 0.025;
const DOWNGRADE = 0.2;
export const DAWN = 6, DUSK = 18;

/** MobilePersonBillboard textures by race/gender/outfit; city guard archive. */
export const PEOPLE_TEXTURES = Object.freeze({
  redguard: { male: [381, 382, 383, 384], female: [395, 396, 397, 398] },
  nord: { male: [387, 388, 389, 390], female: [392, 393, 451, 452] },
  breton: { male: [385, 386, 391, 394], female: [453, 454, 455, 456] },
});
export const GUARD_TEXTURE = 399;
/** MobilePersonNPC face record bases (portrait = base[outfit] + 0..23). */
const FACES = {
  redguard: { male: [336, 312, 336, 312], female: [144, 144, 120, 96] },
  nord: { male: [240, 264, 168, 192], female: [72, 0, 48, 0] },
  breton: { male: [192, 216, 288, 240], female: [72, 72, 24, 72] },
};

/** CityNavigation.GetTileWeight on a ground tile record. */
export function tileWeight(record) {
  switch (record) {
    case 0: case 5: case 6: case 20: case 21: case 30: case 31: return 0;
    case 3: return 4;
    case 1: return 6;
    case 2: return 12;
    case 46: case 47: case 55: return 15;
    default: return 7;
  }
}

/**
 * CityNavigation.SetRMBData for every block, in one grid (gx east, gy south from the north-west corner).
 * Output-space centre of cell (gx, gy): x = (gx + .5) * CELL - spawn.x, z = spawn.z - (H*64 - gy - .5) * CELL.
 */
export function buildNavGrid(blocks, width, height, spawnLocal) {
  const W = width * BLOCK_CELLS, H = height * BLOCK_CELLS;
  const weights = new Uint8Array(W * H);
  let walkable = 0, missingAutomap = 0;
  for (const b of blocks) {
    if (!b.automap || !b.groundTiles) {
      missingAutomap++;
      continue;
    }
    for (let y = 0; y < BLOCK_CELLS; y++) {
      for (let x = 0; x < BLOCK_CELLS; x++) {
        if (b.automap[y * BLOCK_CELLS + x] !== 0) continue;
        const w = tileWeight(b.groundTiles[(y >> 2) * 16 + (x >> 2)] & 0x3f);
        if (!w) continue;
        const gx = b.x * BLOCK_CELLS + x;
        const gy = (H - BLOCK_CELLS) - b.y * BLOCK_CELLS + y;
        weights[gy * W + gx] = w;
        walkable++;
      }
    }
  }
  const sx = spawnLocal?.x ?? 0, sz = spawnLocal?.z ?? 0;
  return {
    W, H, weights, walkable, missingAutomap,
    weight: (gx, gy) => (gx >= 0 && gy >= 0 && gx < W && gy < H ? weights[gy * W + gx] : 0),
    toOut: (gx, gy) => ({ x: (gx + 0.5) * CELL - sx, z: sz - (H - gy - 0.5) * CELL }),
    fromOut: (x, z) => ({ gx: Math.floor((x + sx) / CELL), gy: Math.floor(H - (sz - z) / CELL) }),
  };
}

const DIRS = [[0, -1], [0, 1], [1, 0], [-1, 0]]; // North, South, East, West (MobileDirection)

/**
 * Pool for one town.
 * @param {object} o
 * @param {string} o.location
 * @param {ReturnType<typeof buildNavGrid>} o.nav
 * @param {number} o.blocks block count
 * @param {string} o.race climate people ('breton' | 'redguard' | 'nord')
 * @param {number} o.regionIndex
 * @param {Array} o.banks NAMEGEN banks (null: names fall back to the title)
 * @param {(x,z,tx,tz) => boolean} [o.clear] segment test (collision); default: always clear
 */
export function createPopulation({ location, nav, blocks, race, regionIndex, banks, clear = () => true }) {
  const max = Math.max(1, Math.min(4, Math.floor(blocks / 16))) * POPULATION_PER_16_BLOCKS;
  const seed = hash32(`pop:${location}`);
  const tag = (seed >>> 0).toString(36);
  const random = mulberry(seed);
  const pool = []; // {slot, active, entity, gx, gy, tx, ty, dir, seek, moves}
  let spawned = 0;

  function person(slot) {
    const n = ++spawned;
    const r = mulberry(hash32(`${location}#${n}`));
    const guard = Math.floor(r() * 32) === 0;
    const female = guard ? false : Math.floor(r() * 2) === 1;
    const outfit = guard ? 0 : Math.floor(r() * 4);
    const set = PEOPLE_TEXTURES[race] ?? PEOPLE_TEXTURES.breton;
    const g = female ? 'female' : 'male';
    const archive = guard ? GUARD_TEXTURE : set[g][outfit];
    const face = (FACES[race] ?? FACES.breton)[g][outfit] + Math.floor(r() * 24);
    const name = banks ? fullName(banks, regionBank(regionIndex), female, dfRandom(Math.floor(r() * 0x7fffffff))) : null;
    return {
      id: `npc:m:${tag}:${slot}`,
      kind: 'npc',
      role: guard ? 'guard' : 'townsfolk',
      title: guard ? 'City Watch' : 'Resident',
      name: name || (guard ? 'City Watch' : 'Resident'),
      location,
      x: 0, z: 0, yaw: 0,
      sprite: { archive, record: 0 },
      gender: g,
      race,
      variant: outfit,
      face,
      mobile: true,
      reach: 6.4,
      moving: false,
      faction: null,
      _spawn: n,
    };
  }

  function seeAngleOk(p, x, z) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > VISIBLE_POP_RANGE) return true;
    // yaw 0 faces -z; the mobile is outside the 180 degree view when it is behind the player.
    const fx = Math.sin(p.yaw || 0), fz = -Math.cos(p.yaw || 0);
    return (x - p.x) * fx + (z - p.z) * fz < 0;
  }

  function trySpawn(players) {
    if (!players.length) return null;
    let item = pool.find((it) => !it.active);
    if (!item) {
      if (pool.length >= max) return null;
      item = { slot: pool.length, active: false };
      pool.push(item);
    }
    const p = players[Math.floor(random() * players.length)];
    const c = nav.fromOut(p.x, p.z);
    for (let attempt = 0; attempt <= 10; attempt++) {
      const gx = c.gx + Math.floor(random() * (2 * SPAWN_RADIUS + 1)) - SPAWN_RADIUS;
      const gy = c.gy + Math.floor(random() * (2 * SPAWN_RADIUS + 1)) - SPAWN_RADIUS;
      if (nav.weight(gx, gy) <= 0) continue;
      const at = nav.toOut(gx, gy);
      if (!players.every((q) => seeAngleOk(q, at.x, at.z))) continue;
      const e = person(item.slot);
      e.x = at.x;
      e.z = at.z;
      const dir = Math.floor(random() * 4);
      e.yaw = facing(dir);
      Object.assign(item, { active: true, entity: e, gx, gy, tx: gx, ty: gy, dir, seek: 0, moves: 0, moving: false });
      return item;
    }
    return null;
  }

  function seekTile(it) {
    it.seek++;
    const w = DIRS.map(([dx, dy]) => nav.weight(it.gx + dx, it.gy + dy));
    const cur = nav.weight(it.gx, it.gy);
    const clearDir = (d) => {
      const a = nav.toOut(it.gx, it.gy), b = nav.toOut(it.gx + DIRS[d][0], it.gy + DIRS[d][1]);
      return clear(a.x, a.z, b.x, b.z);
    };
    let target = clearDir(it.dir) ? w[it.dir] : 0;
    if (random() < RANDOM_CHANGE) target = 0;
    if (target === 0) {
      const d = Math.floor(random() * 4);
      if (w[d] === 0 || !clearDir(d)) return;
      it.dir = d;
    } else if (target < cur && random() > DOWNGRADE) {
      let best = target, bestDir = it.dir;
      for (const i of [0, 1, 2].sort(() => random() - 0.5)) {
        if (w[i] > best && clearDir(i)) { best = w[i]; bestDir = i; }
      }
      it.dir = bestDir;
    }
    it.tx = it.gx + DIRS[it.dir][0];
    it.ty = it.gy + DIRS[it.dir][1];
    it.moving = true;
    it.seek = 0;
    it.entity.yaw = facing(it.dir);
  }

  /**
   * Advance the pool. `players`: players in this town ({x,z,yaw}). `hour`: shared clock hour.
   * Returns {added:[entity], removed:[id]} so the caller can update ctx.entities.
   */
  function step(dt, players, hour, busy = new Set()) {
    const added = [], removed = [];
    const day = hour >= DAWN && hour < DUSK;
    if (day && players.length) {
      const it = trySpawn(players);
      if (it) added.push(it.entity);
    }
    for (const it of pool) {
      if (!it.active) continue;
      const e = it.entity;
      const near = players.map((p) => Math.hypot(p.x - e.x, p.z - e.z));
      const nearest = near.length ? Math.min(...near) : Infinity;
      const recycle = it.seek > 4 || nearest > RECYCLE_DISTANCE || !day;
      if (recycle && players.every((p) => seeAngleOk(p, e.x, e.z))) {
        it.active = false;
        removed.push(e.id);
        continue;
      }
      if (busy.has(e.id) || nearest < IDLE_DISTANCE) {
        // Idle facing the closest player (MobilePersonMotor idle state).
        const p = players[near.indexOf(nearest)];
        if (p) e.yaw = Math.atan2(p.x - e.x, -(p.z - e.z));
        e.moving = false;
        continue;
      }
      if (!it.moving) {
        seekTile(it);
        e.moving = it.moving;
        continue;
      }
      const t = nav.toOut(it.tx, it.ty);
      const dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz);
      const stepLen = SPEED * dt;
      if (d <= stepLen || d < 0.1) {
        e.x = t.x;
        e.z = t.z;
        it.gx = it.tx;
        it.gy = it.ty;
        it.moving = false;
        it.moves++;
      } else {
        e.x += (dx / d) * stepLen;
        e.z += (dz / d) * stepLen;
      }
      e.x = Math.round(e.x * 1000) / 1000;
      e.z = Math.round(e.z * 1000) / 1000;
      e.moving = true;
    }
    return { added, removed };
  }

  return {
    max,
    pool,
    step,
    get active() {
      return pool.filter((it) => it.active).map((it) => it.entity);
    },
    clearAll() {
      const ids = pool.filter((it) => it.active).map((it) => it.entity.id);
      for (const it of pool) it.active = false;
      return ids;
    },
  };
}

/** Server yaw (0 = -z, +x clockwise) for a navgrid direction (gy grows south = +z). */
export function facing(dir) {
  const [dx, dy] = DIRS[dir];
  return Math.atan2(dx, -dy);
}
