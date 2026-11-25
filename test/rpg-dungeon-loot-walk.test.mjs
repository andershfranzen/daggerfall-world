// Packages 5 and 7 together: walk from an authored dungeon entrance to a real treasure pile and a spell trap through
// the production feature list, server locomotion and collision. Requires the operator's installed ARENA2.
//
// The Fortress of Gaersmith (Daggerfall) starts in N0000007.RDB. Its starting block holds the walk-on Ice Bolt trap
// (model 67017 at offset 13486, opcode 9, SPELLS.STD 16) and three treasure markers. Every step is
// services.stepPlayer with forward input; the route oracle only decides where to steer. The second player is placed
// at the treasure for the shared-contents checks (fixture positioning, labelled below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { features } from '../server/rpg/features.js';
import { createFixtureWorld, tempDir, localArena2 } from './support/rpg-session.mjs';
import { DungeonExplorer, usableDoors } from './support/dungeon-route.mjs';
import { HAZARD_REPEAT_MS, RESET_GRACE_MS } from '../server/rpg/interiors/actions.js';

const ARENA2 = localArena2();
const asset = { skip: ARENA2 ? false : 'local Daggerfall data not present', timeout: 10 * 60_000 };
const TOWN = 'town:Daggerfall/The Fortress of Gaersmith';
const KEEP = 'dungeon:Daggerfall/The Fortress of Gaersmith';
const TRAP = '0,0:13486'; // N0000007 model 67017: opcode 9 walk-on, SPELLS.STD 16 (Ice Bolt)
const TREASURE = 'N0000007.RDB:14530'; // 199.19 treasure marker on the entrance storey
const DT = 40; // ms, the production 25 Hz tick
// FIXTURE SETUP: the combat feature is left out, as in the Peristair mechanism run, so the Gaersmith spiders cannot
// paralyse the walker on the way. Magic (objectCast and its missiles), containers and the dungeon actions stay real.
const walkFeatures = features.filter((f) => f.name !== 'combat');

async function enter(w, s, ids) {
  await s.interiors.survey(TOWN);
  const portal = s.portals.into(KEEP);
  const entrance = portal.entrances[0];
  const clients = ids.map((id) => {
    const row = w.store.createForAccount(id, id);
    w.store.saveCharacters([{ ...row, ...entrance.exit, rpg: { location: TOWN } }]);
    const c = w.connect(id, id);
    // FIXTURE SETUP: a trained lockpick at level 10: 90 % against door 15088's lock 10 on the way to the treasure.
    c.player.rpg.character.skills = { ...c.player.rpg.character.skills, Lockpicking: 90 };
    c.player.rpg.character.level = 10;
    return c;
  });
  await s.collision.whenSettled(KEEP);
  for (const c of clients) {
    let r = c.act('portal.use', { portalId: portal.id });
    for (let i = 0; i < 100 && !r.ok && /loading|moment/i.test(r.error); i++) {
      await new Promise((res) => setTimeout(res, 100));
      w.tick(100);
      r = c.act('portal.use', { portalId: portal.id });
    }
    assert.equal(r.ok, true, r.error);
    assert.equal(c.character.location, KEEP);
  }
  await s.containers.ready(KEEP);
  w.tick(100);
  return { clients, entrance };
}

/** Steer with forward input through the server's locomotion until within `reach` of each waypoint. */
function walk(w, s, c, path, reach = 0.3, onStep = () => {}) {
  const foot = () => c.player.rpg.portal.footY;
  const p = c.player;
  for (const wp of path) {
    let best = Infinity, still = 0;
    for (let i = 0; i < 2000; i++) {
      const d = Math.hypot(wp.x - p.x, wp.z - p.z);
      // Stacked floors: a waypoint above the body counts only once climbed to. One below it counts horizontally:
      // the body's radius can still rest on a ledge edge, and the next step forward drops it as it would a player.
      if (d <= reach && (!Number.isFinite(wp.y) || foot() - wp.y > -1)) break;
      if (d < best - 0.005) { best = d; still = 0; } else if (++still > 50) throw new Error(`stuck at ${p.x.toFixed(2)},${foot().toFixed(2)},${p.z.toFixed(2)} (body ${s.collision.bodyOf(p)?.mode}, health ${p.rpg.character.health}) short of ${wp.x.toFixed(2)},${wp.y?.toFixed(2)},${wp.z.toFixed(2)}`);
      const yaw = Math.atan2(wp.x - p.x, -(wp.z - p.z));
      const r = s.stepPlayer(p, { forward: 1, strafe: 0, yaw }, DT / 1000);
      p.x = r.x; p.z = r.z; p.yaw = yaw; p.moving = true; p.dirty = true;
      w.tick(DT);
      onStep();
    }
  }
  p.moving = false;
}
const foot = (c) => c.player.rpg.portal.footY;

/** Tree path between explored nodes, hop by hop, so the body keeps the oracle's storey. */
const hops = (ex, a, b) => ex.between(a, b, { shortcuts: false });

/**
 * Walk like a player: plan over what is reachable now; when closed doors are in the way, walk to the one nearest the
 * goal, open (or pick) it with dungeon.use / dungeon.pick from reach, and continue (the Rare Book walk's method).
 */
function cross(w, s, c, scene, target, reach) {
  const opened = [];
  const tried = new Set();
  const isOpen = (id) => s.dungeonLocks.isOpen(KEEP, id);
  for (let attempt = 0; attempt < 6; attempt++) {
    // A swinging leaf or a body that rounds a corner can leave the walker off the oracle's lattice: plan again from here.
    // Stairs only: see DungeonExplorer maxDrop.
    const ex = new DungeonExplorer(s.collision.instanceWorld(KEEP), { x: c.player.x, y: foot(c), z: c.player.z }, target, { reach, dy: 2.5, maxDrop: 0.8 });
    let cur = ex.root;
    try {
      for (let round = 0; round < 40; round++) {
        const hit = ex.search();
        if (hit) { walk(w, s, c, hops(ex, cur, hit)); return opened; }
        const cands = usableDoors(ex.visited, scene.mechanisms, target, { isOpen, tried, reach: 2.5 });
        assert.ok(cands.length, `no usable door from ${ex.visited.length} reachable spots (opened ${opened.join(" ")}; tried ${[...tried].join(" ")}; at ${c.player.x.toFixed(2)},${foot(c)},${c.player.z.toFixed(2)})`);
        const { door, stand } = cands[0];
        tried.add(door.id);
        walk(w, s, c, hops(ex, cur, stand));
        cur = stand;
        c.player.yaw = Math.atan2(door.x - c.player.x, -(door.z - c.player.z));
        // A failed pick bars a retry until Lockpicking rises (one attempt per skill level). FIXTURE SETUP: after a
        // failure the walker's skill is raised by one, standing in for the practice a player would put in.
        let r = c.act(door.lock ? 'dungeon.pick' : 'dungeon.use', { id: door.id });
        for (let k = 0; door.lock && !isOpen(door.id) && k < 8; k++) {
          c.player.rpg.character.skills.Lockpicking += 1;
          r = c.act('dungeon.pick', { id: door.id });
        }
        if (r.ok && isOpen(door.id)) opened.push(door.id);
        for (let i = 0; i < 40; i++) w.tick(DT); // the leaf swings
        ex.reopen(door, 5);
      }
    } catch (err) {
      if (!/^stuck/.test(err.message) || attempt === 5) throw err;
      for (let i = 0; i < 10; i++) w.tick(DT);
    }
  }
  throw new Error('no route');
}

test('[asset] Gaersmith: walk from the entrance to real treasure and the Ice Bolt trap; shared, private and once', asset, async (t) => {
  const tmp = tempDir('dfw-loot-walk-');
  const w = await createFixtureWorld({ dbPath: join(tmp.dir, 'w.db'), dataPath: ARENA2, features: walkFeatures });
  t.after(() => { w.close(); tmp.remove(); });
  const s = w.ctx.services;
  const { clients: [a, b] } = await enter(w, s, ['walker', 'second']);
  const scene = await s.interiors.scene(KEEP);
  const trap = scene.mechanisms.find((m) => m.id === TRAP);
  assert.deepEqual([trap.action.opcode, trap.action.index, trap.action.trigger], [9, 16, 1]);
  const site = s.containers.sites(KEEP).find((x) => x.id === TREASURE);
  assert.equal(site?.kind, 'treasure');
  const cid = `ct:${TREASURE}@${KEEP}`;

  // Walked: entrance landing -> treasure.
  const start = { x: a.player.x, z: a.player.z, y: foot(a) };
  const doors = cross(w, s, a, scene, { x: site.x, y: site.y, z: site.z }, 2.4);
  const walked = Math.hypot(a.player.x - start.x, a.player.z - start.z);
  assert.ok(walked > 15, `walked ${walked.toFixed(1)} m from the landing`);
  a.must('container.open', { containerId: cid });
  const contents = a.events('container').at(-1).items;
  assert.ok(contents.length > 0, 'stocked from the dungeon loot table');
  const first = contents.find((i) => i.template !== 'gold') ?? contents[0];
  a.must('container.take', { containerId: cid, itemId: first.id });

  // Fixture positioning: the second player stands at the same pile.
  b.player.x = site.x; b.player.z = site.z; b.player.y = site.y; b.player.dirty = true;
  b.must('container.open', { containerId: cid });
  assert.equal(b.events('container').at(-1).items.some((i) => i.id === first.id), false, 'the second joiner sees it gone');
  assert.match(b.act('container.take', { containerId: cid, itemId: first.id }).error, /no longer there|empty/);

  // The plate is the top of model 67017, a 3.2 m high span over the lower floor: a walk-on trigger fires only for a
  // body standing on that top surface (DaggerfallActionCollision: hit point beneath the player), not for one walking
  // under it. It lies 9.6 m below the entrance storey behind several doors and a stair shaft that the route oracle
  // cannot follow reliably. FIXTURE POSITIONING: the walker is placed on the adjoining upper floor, 2-4 m from the plate
  // and off its footprint, then walks onto it with forward input (the contact is the real walk-on trigger).
  const hp0 = a.player.rpg.character.health;
  const spellEvents = (c) => c.events('dungeonHazard').filter((e) => e.pool === 'spell');
  const col = s.collision.instanceWorld(KEEP);
  const P = scene.positions;
  const top = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, y: -Infinity };
  for (let i = trap.firstTriangle * 9; i < (trap.firstTriangle + trap.triangleCount) * 9; i += 3) {
    top.minX = Math.min(top.minX, P[i]); top.maxX = Math.max(top.maxX, P[i]); top.y = Math.max(top.y, P[i + 1]);
    top.minZ = Math.min(top.minZ, P[i + 2]); top.maxZ = Math.max(top.maxZ, P[i + 2]);
  }
  const plate = { x: (top.minX + top.maxX) / 2, y: top.y, z: (top.minZ + top.maxZ) / 2 };
  assert.equal(col.heightAt(plate.x, plate.z, top.y + 0.3), top.y, 'the plate top is a standing surface');
  // The only footing onto the plate is a 1 m wide ramp (34.3-34.7 m) from the upper floor to its north, beside a
  // shaft down to 22.4 m. Start 1.5 m beyond the plate's edge on that floor, cross the ramp, stop at the centre.
  const bridgeX = trap.x; // the ramp runs at x 34.6-35.8 m, the authored origin's x
  const set = { x: bridgeX, z: top.maxZ + 1.5 };
  set.y = col.heightAt(set.x, set.z, top.y + 0.3);
  assert.ok(Math.abs(set.y - top.y) < 0.05 && col.isClear(set.x, set.z, set.y), 'the upper floor next to the ramp');
  const ramp = { x: bridgeX, z: top.maxZ - 0.6 };
  ramp.y = col.heightAt(ramp.x, ramp.z, top.y + 0.3);
  assert.ok(ramp.y > top.y - 1 && col.isClear(ramp.x, ramp.z, ramp.y), 'the ramp is walkable');
  s.collision.resetBody(a.player);
  Object.assign(a.player, { x: set.x, z: set.z });
  a.player.rpg.portal.footY = set.y;
  w.tick(DT);
  const trapFloor = { x: plate.x, y: top.y, z: plate.z };
  const markA = a.mark(), markB = b.mark();
  let movingMs = 0; // time spent moving on the plate after the first cast (contact activations happen only then)
  walk(w, s, a, [ramp, trapFloor], 0.3, () => { if (spellEvents(a).length) movingMs += DT; });
  for (let i = 0; i < 100 && !spellEvents(a).length; i++) { w.tick(DT); }
  assert.equal(spellEvents(a).length, 1, 'the trap fired once on contact');
  assert.deepEqual(spellEvents(a)[0], { kind: 'dungeonHazard', id: TRAP, pool: 'spell', spell: 16 });
  for (let i = 0; i < 100; i++) w.tick(DT); // missile flight
  const results = a.since(markA).filter((m) => m.type === 'gameEvent' && m.event.kind === 'spellResult').map((m) => m.event);
  assert.ok(results.length >= 1, 'the Ice Bolt missile reached the walker (services.objectCast)');
  assert.match(results[0].text, /Ice Bolt/);
  const hit = results[0].results.find((r) => r.outcome === 'applied');
  if (hit) assert.ok(a.player.rpg.character.health < hp0, 'Ice Bolt damage applied');
  assert.equal(b.since(markB).filter((m) => m.type === 'gameEvent' && (m.event.kind === 'spellResult' || m.event.kind === 'dungeonHazard')).length, 0,
    'the other player gets no result or hazard text');

  // Cooldown: keep moving on the plate. Contact re-fires every HAZARD_REPEAT_MS (DFU 0.12 s) while moving; DFU casts
  // again only when Cooldown (1000, minus 45.45 per activation) is spent: 22 activations, about 2.6 s of walking.
  const fired = () => spellEvents(a).length;
  const on = { x: a.player.x, z: a.player.z };
  for (let i = 0; i < 400 && fired() < 2; i++) {
    a.player.x = on.x + (i % 2 ? 0.02 : -0.02); // shuffling on the plate keeps the contact "moving"
    w.tick(DT);
    movingMs += DT;
  }
  assert.equal(fired(), 2, 'a second cast after the cooldown');
  const activations = Math.round(movingMs / HAZARD_REPEAT_MS);
  assert.ok(activations >= 21 && activations <= 23, `the second cast came after ~22 contact activations (${activations})`);
  t.diagnostic(`doors opened ${doors.join(', ') || 'none'}`);
  t.diagnostic(`walked ${walked.toFixed(1)} m; took ${first.name}; Ice Bolt ${hit ? `hit for ${hp0 - a.player.rpg.character.health}` : 'resisted'}`);
});

test('[asset] Gaersmith revisit: emptied treasure stays empty after vacancy, reset of mechanisms, reconnect and restart', asset, async (t) => {
  const tmp = tempDir('dfw-loot-revisit-');
  const w = await createFixtureWorld({ dbPath: join(tmp.dir, 'w.db'), dataPath: ARENA2, features: walkFeatures });
  t.after(() => { w.close(); tmp.remove(); });
  const s = w.ctx.services;
  const { clients: [a], entrance } = await enter(w, s, ['finder']);
  const site = s.containers.sites(KEEP).find((x) => x.id === TREASURE);
  const cid = `ct:${TREASURE}@${KEEP}`;
  a.player.x = site.x; a.player.z = site.z; a.player.y = site.y; // fixture positioning (the walk is the case above)
  a.must('container.open', { containerId: cid });
  const n = a.events('container').at(-1).items.length;
  a.must('container.take', { containerId: cid });
  assert.equal(a.entity(cid)?.empty, true);
  a.leave();
  w.tick(RESET_GRACE_MS + 1000); // the instance's doors and counters reset after the grace period

  const { clients: [late] } = await enter(w, s, ['latecomer']);
  late.player.x = site.x; late.player.z = site.z; late.player.y = site.y;
  late.must('container.open', { containerId: cid });
  assert.deepEqual(late.events('container').at(-1).items, [], `a later joiner finds the ${n} items gone, not a new stock`);
  late.leave();
  w.restart();
  await s.containers?.ready?.(KEEP);
  const again = w.connect('latecomer', 'latecomer');
  await w.ctx.services.containers.ready(KEEP);
  w.tick(100);
  again.player.x = site.x; again.player.z = site.z; again.player.y = site.y;
  again.must('container.open', { containerId: cid });
  assert.deepEqual(again.events('container').at(-1).items, [], 'restart keeps it empty');
  assert.ok(entrance);
});
