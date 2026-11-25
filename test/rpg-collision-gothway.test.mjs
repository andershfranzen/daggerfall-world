// Collision against the real Gothway Garden geometry from the local Daggerfall install
// (gamedata/, never committed), loaded the way the server does it. Skips without the data.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { arena2Loader } from '../server/rpg/collision/arena2.js';
import { createCollision } from '../server/rpg/collision.js';

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const INSTALL = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/', import.meta.url));
const skip = existsSync(join(ARENA2, 'MAPS.BSA')) ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';
const TOWN = 'town:Daggerfall/Gothway Garden';

let world;
before(async () => {
  if (skip) return;
  ({ world } = await arena2Loader(INSTALL)(TOWN)); // install folder: finds arena2/ itself
});

/** Walk in small ticks (4 m/s at 25 Hz) along a heading for `seconds`. */
function walk(w, x, z, yaw, seconds, state = { y: null }) {
  let blocked = false;
  for (let i = 0; i < seconds * 25; i++) {
    const m = w.move(x, z, x + Math.sin(yaw) * 0.16, z - Math.cos(yaw) * 0.16, state);
    x = m.x; z = m.z;
    blocked ||= m.blocked;
  }
  return { x, z, y: state.y, blocked };
}

test('spawn is clear and the documented 12 m corridor north is walkable', { skip }, () => {
  assert.equal(world.isClear(0, 0), true);
  assert.ok(Math.abs(world.standHeight(0, 0) + 0.025) < 1e-3, 'street level');
  const m = world.move(0, 0, 0, -12);
  assert.equal(m.blocked, false);
  assert.ok(Math.abs(m.z + 12) < 1e-9);
});

test('buildings stop walkers: most headings from spawn hit a wall within 70 m', { skip }, () => {
  let stopped = 0;
  for (let i = 0; i < 16; i++) {
    const yaw = (i / 16) * 2 * Math.PI;
    const free = Math.hypot(Math.sin(yaw), Math.cos(yaw)) * 0.16 * 25 * 16; // 64 m unobstructed
    const r = walk(world, 0, 0, yaw, 16);
    if (Math.hypot(r.x, r.z) < free - 0.5) stopped++;
  }
  assert.ok(stopped >= 10, `${stopped}/16 headings blocked`);
});

test('no walker ends inside geometry or crosses a wall, over thousands of random ticks', { skip }, () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  let worst = 0;
  for (let k = 0; k < 24; k++) {
    let x = 0, z = 0;
    const s = { y: null };
    let yaw = rnd() * 2 * Math.PI;
    for (let i = 0; i < 400; i++) {
      if (rnd() < 0.05) yaw = rnd() * 2 * Math.PI;
      const nx = x + Math.sin(yaw) * 0.16, nz = z - Math.cos(yaw) * 0.16;
      const m = world.move(x, z, nx, nz, s);
      // Sight at knee height between consecutive positions must stay unobstructed (no wall crossed).
      assert.ok(world.segmentClear(x, s.y + 1.0, z, m.x, s.y + 1.0, m.z) || Math.hypot(m.x - x, m.z - z) < 1e-6,
        `crossed geometry ${x},${z} -> ${m.x},${m.z}`);
      x = m.x; z = m.z;
      worst = Math.max(worst, world.penetration(x, z, s.y));
    }
  }
  assert.ok(worst <= 0.011, `max penetration ${worst}`);
});

test('line of sight: a building blocks it, an open street does not', { skip }, () => {
  assert.equal(world.canSee(0, 0, 0, -12), true, 'down the spawn street');
  // Walk east until a building stops us, then look through it.
  const r = walk(world, 0, 0, Math.PI / 2, 12);
  assert.ok(r.blocked);
  assert.equal(world.canSee(r.x, r.z, r.x + 6, r.z), false, 'through the wall in front');
});

test('server feature loads Gothway from ctx.dataPath and enforces it', { skip }, async () => {
  const notes = [];
  const ctx = {
    players: new Map(), services: {}, config: { worldHalfExtent: 512 }, dataPath: ARENA2,
    defaultLocation: TOWN, log: console, location: (p) => p.rpg.location,
    notify: (p, e) => notes.push(e), onJoin() {}, onLeave() {}, onTick() {},
  };
  const c = createCollision(ctx);
  const s = await ctx.services.collision.whenSettled(TOWN);
  assert.equal(s.status, 'ready', s.reason ?? '');
  assert.match(s.source, /Gothway Garden/);
  const p = { id: 1, x: 0, z: 0, rpg: { location: TOWN } };
  for (let i = 0; i < 300; i++) {
    const m = ctx.services.movePlayer(p, p.x + 0.16, p.z);
    p.x = m.x; p.z = m.z;
  }
  assert.ok(p.x < 47, `east walk stopped by a building at x=${p.x.toFixed(2)}`);
  assert.ok(c.cache.byteSize < 16e6, `retained ${c.cache.byteSize} bytes`);
});
