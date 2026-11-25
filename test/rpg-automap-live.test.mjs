// [asset][live] Exploration memory in the real Privateer's Hold over two real account sockets (package 6).
// Real HTTP/WebSocket server, account service, SQLite, collision line of sight and ARENA2 dungeon. Every move is real
// input over the socket; the walking route is only an oracle. Skips without the local Daggerfall install.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  discoverFeatures, tempDir, startLiveWorld, accountSession, LiveClient, localArena2,
} from './support/rpg-session.mjs';
import { walkingRoute } from './support/walking-route.mjs';
import { unpackCells, cellIndexMap, isExplored, CELL } from '../client/gameplay/automap/memory.js';

const ARENA2 = localArena2();
const gate = { skip: ARENA2 ? false : 'local Daggerfall data not present', timeout: 600_000 };
const HOLD = "town:Daggerfall/Privateer's Hold";
const DUNGEON = "dungeon:Daggerfall/Privateer's Hold";

describe("[asset][live] automap memory in Privateer's Hold", () => {
  let tmp, world, features;
  const open = [];
  before(async () => {
    if (!ARENA2) return;
    tmp = tempDir('dfw-automap-live-');
    features = (await discoverFeatures()).features;
    world = await startLiveWorld({ dir: tmp.dir, features, arena2Dir: ARENA2 });
  });
  after(async () => {
    try {
      await Promise.all(open.map((c) => c.close().catch(() => {})));
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  const svc = () => world.server.runtime.ctx.services;
  const join = async (jar) => {
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    open.push(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    c.welcome = await c.next((m) => m.type === 'welcome', 'welcome', 20000);
    await c.next((m) => m.type === 'rpg', 'first snapshot', 20000);
    return c;
  };
  const where = (c) => c.messages.filter((m) => m.type === 'rpg').at(-1)?.character?.location;
  const selfPos = (c) => {
    const me = c.state?.selfId;
    return c.messages.filter((m) => m.type === 'state').at(-1)?.players?.find((p) => p.id === me) ?? null;
  };
  async function walkTo(c, x, z, reach, steps = 2000) {
    for (let i = 0; i < steps; i++) {
      const pos = selfPos(c) ?? { x: 0, z: 0 };
      const yaw = Math.atan2(x - pos.x, -(z - pos.z));
      if (selfPos(c) && Math.hypot(x - pos.x, z - pos.z) <= reach) {
        c.send({ type: 'input', forward: 0, strafe: 0, yaw });
        return pos;
      }
      c.send({ type: 'input', forward: 1, strafe: 0, yaw });
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'movement snapshot', 20000);
    }
    throw new Error(`could not walk to (${x}, ${z})`);
  }
  async function settle(c, loc) {
    await svc().collision.whenSettled(loc);
    for (let i = 0; i < 3; i++) {
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state' && (m.location === undefined || m.location === loc), 'fresh movement snapshot', 20000);
    }
  }
  function footOf(c, loc, at, col) {
    const portal = c.state?.character?.portal;
    return /^(interior|dungeon):/.test(loc) && portal?.to === loc && Number.isFinite(portal.footY) ? portal.footY : col.standHeight(at.x, at.z);
  }
  async function walkRoute(c, x, z, reach, targetY) {
    const loc = where(c);
    await settle(c, loc);
    const at = selfPos(c);
    const col = svc().collision.instanceWorld(loc);
    const indoors = /^(interior|dungeon):/.test(loc);
    const path = walkingRoute(col, { x: at.x, y: footOf(c, loc, at, col), z: at.z }, { x, y: targetY, z }, Math.max(0.2, reach - 0.3), indoors);
    assert.ok(path, `no walking route in ${loc}`);
    for (const w of path) await walkTo(c, w.x, w.z, indoors ? 0.24 : 0.5);
    return path;
  }
  async function useDoor(c, verb, args, done) {
    for (let i = 0; i < 60; i++) {
      const r = await c.act(verb, args);
      if (r.ok) return c.stateWhere((m) => done(m.character.location), `${verb} done`);
      if (!/loading|moment|Wait/i.test(r.error)) throw new Error(`${verb}: ${r.error}`);
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'state while a door loads', 20000);
    }
    throw new Error(`${verb} never succeeded`);
  }
  async function enterDungeon(c) {
    // Setup only: this character has heard of the Hold (travel now needs a known destination).
    for (let i = 0; i < 600 && svc().travel.source !== 'files'; i++) await new Promise((r) => setTimeout(r, 100));
    const live = [...world.server.runtime.ctx.players.values()].find((q) => q.id === c.welcome.id);
    assert.ok(live, 'live character');
    svc().travel.discover(live, HOLD);
    live.dirty = true;
    let r = await c.act('travel.go', { to: HOLD });
    for (let i = 0; i < 400 && !r.ok && /Catch your breath|Wait|moment/.test(r.error); i++) {
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'travel cooldown', 20000);
      if (i % 5 === 4) r = await c.act('travel.go', { to: HOLD });
    }
    assert.equal(r.ok, true, r.error);
    await c.stateWhere((m) => m.character.location === HOLD, 'arrived at the Hold');
    await svc().interiors.survey(HOLD);
    const spec = svc().portals.at(HOLD).find((sp) => sp.to === DUNGEON);
    await walkRoute(c, spec.entrances[0].exit.x, spec.entrances[0].exit.z, 0.6);
    await useDoor(c, 'portal.use', { portalId: spec.id }, (loc) => loc === DUNGEON);
  }
  /** Full private memory of the current place, as the browser asks for it. */
  async function memory(c) {
    const from = c.messages.length;
    assert.equal((await c.act('automap.sync', {})).ok, true);
    c.cursor = from;
    const ev = await c.next((m) => m.type === 'gameEvent' && m.event.kind === 'automap' && m.event.full, 'automap memory', 20000);
    return { location: ev.event.location, cells: unpackCells(ev.event.cells) };
  }
  /** Walkable 2 m cells of the whole dungeon from the server's own scene (denominator for "half explored"). */
  async function dungeonCells() {
    const scene = await svc().interiors.scene(DUNGEON);
    const P = scene.positions;
    const set = new Set();
    for (let o = 0; o < P.length; o += 9) {
      const ux = P[o + 3] - P[o], uy = P[o + 4] - P[o + 1], uz = P[o + 5] - P[o + 2];
      const vx = P[o + 6] - P[o], vy = P[o + 7] - P[o + 1], vz = P[o + 8] - P[o + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-9) || Math.abs(ny) / len < 0.55) continue;
      const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
      set.add(`${Math.floor(cx / CELL)},${Math.floor(cz / CELL)}`);
    }
    return set;
  }

  test('half-explore, reconnect and restart with the map intact, retrace it to the exit; a second player has their own map', gate, async (t) => {
    const ja = await accountSession(world.base, 'MapperAva');
    const jb = await accountSession(world.base, 'MapperBram');
    let a = await join(ja);
    await enterDungeon(a);
    await settle(a, DUNGEON);
    const start = selfPos(a);
    const col = svc().collision.instanceWorld(DUNGEON);
    const startY = footOf(a, DUNGEON, start, col);

    // A walks to the far end of the entrance level, 12–19 m in (the level reachable on foot without mechanisms ends
    // about 18 m from the door); the oracle picks a point with a walkable route.
    let route = null, target = null;
    // Oracle: flood-fill the ground reachable on foot from the door, then aim for its far end.
    const reach = new Map();
    const keyOf = (n) => `${Math.round(n.x * 2)},${Math.round(n.z * 2)},${Math.round(n.y * 2)}`;
    const queue = [{ x: start.x, z: start.z, y: startY }];
    reach.set(keyOf(queue[0]), queue[0]);
    while (queue.length && reach.size < 30000) {
      const c = queue.shift();
      for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
        const e = col.move(c.x, c.z, c.x + dx, c.z + dz, { y: c.y });
        if (Math.hypot(e.x - c.x - dx, e.z - c.z - dz) > 0.001 || !col.isClear(c.x + dx, c.z + dz, e.y)) continue;
        const n = { x: c.x + dx, z: c.z + dz, y: e.y };
        if (!reach.has(keyOf(n))) { reach.set(keyOf(n), n); queue.push(n); }
      }
    }
    const candidates = [...reach.values()].map((n) => ({ ...n, d: Math.hypot(n.x - start.x, n.z - start.z) }))
      .filter((n) => n.d >= 12).sort((p, q) => q.d - p.d);
    let tries = 0;
    for (const p of candidates) {
      if (++tries > 20) break;
      const path = walkingRoute(col, { x: start.x, y: startY, z: start.z }, { x: p.x, y: p.y, z: p.z }, 0.6, true);
      if (path?.length >= 1) { route = path; target = p; break; }
    }
    // A second leg toward the reachable point farthest from both the door and the first stop.
    if (route) {
      const second = [...reach.values()].map((n) => ({ ...n, d: Math.min(Math.hypot(n.x - start.x, n.z - start.z), Math.hypot(n.x - target.x, n.z - target.z)) }))
        .sort((p, q) => q.d - p.d).slice(0, 20);
      const end = route.at(-1);
      for (const p of second) {
        const leg = walkingRoute(col, end, { x: p.x, y: p.y, z: p.z }, 0.6, true);
        if (leg?.length) { route = route.concat(leg); break; }
      }
    }
    t.diagnostic(`entrance (${start.x}, ${startY}, ${start.z}); ${reach.size} reachable 0.5 m steps; target ${target ? Math.round(target.d) : '-'} m in after ${tries} tries`);
    assert.ok(route, 'a walkable target 12–19 m into the dungeon');
    for (const w of route) await walkTo(a, w.x, w.z, 0.24);
    const farthest = selfPos(a);

    const mem1 = await memory(a);
    assert.equal(mem1.location, DUNGEON);
    const index = cellIndexMap(mem1.cells);
    const visited = [start, ...route];
    const unseen = visited.filter((w) => !isExplored(index, w.x, w.z));
    assert.deepEqual(unseen, [], 'every point A walked through is on A\'s map');
    const total = await dungeonCells();
    const explored = new Set(mem1.cells.map(([ix, iz]) => `${ix},${iz}`));
    const share = [...explored].filter((k) => total.has(k)).length / total.size;
    t.diagnostic(`walked ${route.length} waypoints, ${Math.round(Math.hypot(farthest.x - start.x, farthest.z - start.z))} m from the entrance; explored ${explored.size} of ${total.size} floor cells (${(share * 100).toFixed(1)}%)`);
    assert.ok(share > 0.005 && share < 0.5, 'the dungeon is only partly explored');

    // A pins a note where they stopped, and writes in the notebook.
    assert.equal((await a.act('automap.note', { x: farthest.x, z: farthest.z, text: 'Turned back here' })).ok, true);
    assert.equal((await a.act('notebook.write', { text: 'Privateer\'s Hold: the passage beyond the note is unexplored.' })).ok, true);

    // Reconnect: same memory, same notes.
    await a.close();
    a = await join(ja);
    assert.equal(where(a), DUNGEON);
    const mem2 = await memory(a);
    assert.ok(mem2.cells.length >= mem1.cells.length, 'reconnect keeps the explored area');
    assert.equal(a.state.character.automap.notes[DUNGEON][0].text, 'Turned back here');

    // Server restart on the same databases (graceful shutdown saves pending exploration rows).
    await Promise.all(open.splice(0).map((c) => c.close().catch(() => {})));
    await world.close();
    world = await startLiveWorld({ dir: tmp.dir, features, arena2Dir: ARENA2 });
    a = await join(ja);
    assert.equal(where(a), DUNGEON);
    const mem3 = await memory(a);
    const after = new Set(mem3.cells.map(([ix, iz, iy]) => `${ix},${iz},${iy}`));
    assert.ok(mem2.cells.every(([ix, iz, iy]) => after.has(`${ix},${iz},${iy}`)), 'every explored cell survived the restart');
    assert.equal(a.state.character.automap.notebook.at(-1).text.startsWith('Privateer\'s Hold'), true);

    // Retrace: walk the remembered route back to the entrance using only explored ground, then leave.
    const back = [...route].reverse().slice(1).concat([start]);
    const idx3 = cellIndexMap(mem3.cells);
    assert.ok(back.every((w) => isExplored(idx3, w.x, w.z)), 'the way back lies entirely on the remembered map');
    await settle(a, DUNGEON);
    for (const w of back) await walkTo(a, w.x, w.z, 0.24);
    const door = svc().portals.into(DUNGEON);
    await walkRoute(a, door.entrances[0].inner.x, door.entrances[0].inner.z, 1.2, door.entrances[0].enter.y);
    await useDoor(a, 'portal.leave', {}, (loc) => loc === HOLD);

    // B enters separately: B's map shows only B's own surroundings, never A's far end or notes.
    const b = await join(jb);
    await enterDungeon(b);
    await settle(b, DUNGEON);
    const memB = await memory(b);
    const bKeys = new Set(memB.cells.map(([ix, iz]) => `${ix},${iz}`));
    const farKey = `${Math.floor(farthest.x / CELL)},${Math.floor(farthest.z / CELL)}`;
    assert.ok(memB.cells.length > 0, 'B explores the entrance');
    assert.equal(bKeys.has(farKey), false, 'A\'s far end is not on B\'s map');
    assert.ok(memB.cells.length < mem3.cells.length, 'B knows less than A');
    assert.equal(b.state.character.automap?.notes?.[DUNGEON], undefined, 'A\'s notes are private');
    const bSaw = JSON.stringify(b.messages);
    assert.ok(!bSaw.includes('Turned back here'), 'B never received A\'s note text');
    t.diagnostic(`B explored ${memB.cells.length} cells at the entrance; A ${mem3.cells.length}`);
  });
});
