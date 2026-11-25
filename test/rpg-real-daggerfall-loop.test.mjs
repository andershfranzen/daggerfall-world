// [asset][live] The Daggerfall opening on the operator's real ARENA2, over two real account sockets: character creation
// from CLASS*.CFG, the Privateer's Hold start, the first real door and monster, and a cold restart on the same databases.
// Leaving the Hold, the journey to Daggerfall, its shops and guilds are not yet covered here (review handoff).
//
// Real HTTP/WebSocket server (server/game.js), account service, SQLite and the production feature list. The two
// players send only what the browser sends: join/arrived/input messages and `action` verbs. Server services are read
// as an oracle only (where the exit door and the doors are; a walking route through the collision world).
// Every step and the server's answer is written to $DFW_LOOP_REPORT when set (the review summary image).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { OPENING_DUNGEON } from '../server/rpg/campaign/sites.js';
import { accountSession, LiveClient, localArena2, startLiveWorld, tempDir } from './support/rpg-session.mjs';
import { DungeonExplorer, usableDoors } from './support/dungeon-route.mjs';

const ARENA2 = localArena2();
const gate = { skip: ARENA2 ? false : 'local Daggerfall data not present', timeout: 5 * 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('[asset][live] real Daggerfall opening: create, Privateer’s Hold start, first door and fight, cold restart', gate, async (t) => {
  const tmp = tempDir('dfw-real-loop-');
  const steps = [];
  const note = (step, answer, detail = '') => { steps.push({ step, answer, detail }); t.diagnostic(`${step}: ${answer}${detail ? ` (${detail})` : ''}`); };
  let live = await startLiveWorld({ dir: tmp.dir, port: Number(process.env.DFW_LOOP_PORT) || 0, arena2Dir: ARENA2 });
  const open = [];
  t.after(async () => {
    await Promise.all(open.map((c) => c.close().catch(() => {})));
    await live?.close().catch(() => {});
    tmp.remove();
    if (process.env.DFW_LOOP_REPORT) writeFileSync(process.env.DFW_LOOP_REPORT, JSON.stringify(steps, null, 2));
  });
  const svc = () => live.server.runtime.ctx.services;

  // ---- a player, as the browser drives one ------------------------------------------------------------------------
  async function connect(jar) {
    const c = new LiveClient(live.port, { cookie: jar.cookie, origin: live.base });
    open.push(c);
    await c.opened;
    // The browser acknowledges every scene change; until then the player is hidden from others.
    c.ws.on('message', (d) => {
      try {
        const m = JSON.parse(d);
        if (m.type === 'gameEvent' && m.event?.kind === 'teleport') c.send({ type: 'arrived' });
      } catch {}
    });
    c.send({ type: 'join', name: jar.user.username, account: true });
    c.welcome = await c.next((m) => m.type === 'welcome', 'welcome', 20_000);
    c.send({ type: 'arrived' });
    await c.next((m) => m.type === 'rpg' && !!m.character, 'first snapshot', 20_000);
    return c;
  }
  const me = (c) => c.messages.findLast((m) => m.type === 'state' && m.players?.some((p) => p.id === c.welcome.id))?.players.find((p) => p.id === c.welcome.id);
  const where = (c) => c.state.character.location;
  const foot = (c) => {
    const portal = c.state.character.portal;
    return portal?.to === where(c) && Number.isFinite(portal.footY) ? portal.footY : 0;
  };
  async function nextState(c) {
    c.cursor = c.messages.length;
    await c.next((m) => m.type === 'state', 'movement snapshot', 20_000);
  }
  /** Retries an action the way a player clicks again while the server says "a moment". */
  async function patient(c, verb, args, re = /loading|moment|Wait|Catch your breath/i) {
    for (let i = 0; ; i++) {
      const r = await c.act(verb, args);
      if (r.ok || !re.test(r.error ?? '') || i > 80) return r;
      await sleep(250);
    }
  }
  async function walkTo(c, x, z, reach = 0.3, { run = true, halt = true } = {}) {
    let best = Infinity, still = 0;
    for (;;) {
      const p = me(c);
      const d = p ? Math.hypot(x - p.x, z - p.z) : Infinity;
      const yaw = p ? Math.atan2(x - p.x, -(z - p.z)) : 0;
      if (d <= reach) { if (halt) c.send({ type: 'input', forward: 0, strafe: 0, yaw }); return; }
      if (c.state.character.character.health <= 0) throw new Error(`${c.welcome.id} was defeated at ${p?.x.toFixed(1)},${p?.z.toFixed(1)}`);
      if (d < best - 0.005) { best = d; still = 0; } else if (++still > 60) throw new Error(`${c.welcome.name ?? c.welcome.id} stuck at ${p?.x.toFixed(2)},${p?.z.toFixed(2)} short of ${x.toFixed(2)},${z.toFixed(2)}`);
      c.send({ type: 'input', forward: 1, strafe: 0, yaw, run: run && d > 1 });
      await nextState(c);
    }
  }
  async function stop(c) {
    c.send({ type: 'input', forward: 0, strafe: 0, yaw: me(c)?.yaw ?? 0 });
    await nextState(c);
  }

  // ---- 1. two accounts create characters from the real class data ------------------------------------------------
  async function create(username, className, race, gender) {
    const jar = await accountSession(live.base, username);
    assert.ok(jar.cookie, `${username}: account ${jar.status}`);
    const c = await connect(jar);
    c.jar = jar;
    assert.equal(c.state.character.character.created, false);
    const draft = new CharacterDraft(username);
    draft.race = race;
    draft.gender = gender;
    draft.chooseClass(className);
    assert.equal((await c.act('character.roll', draft.rollRequest())).ok, true);
    const rolled = await c.stateWhere((m) => m.character.character.draft, 'attribute roll');
    assert.ok(rolled.character.character.draft.career, 'the server sends the class it rolled against');
    draft.syncRoll(rolled.character.character.draft); // spends against draft.career (CLASS*.CFG here)
    draft.autoDistribute('attributes');
    draft.autoDistribute('skills');
    let refusals = 0;
    let r;
    for (;;) {
      r = await c.act('character.create', draft.createRequest());
      if (r.ok || !/starting dungeon is loading/.test(r.error ?? '') || refusals > 120) break;
      refusals++;
      await sleep(250);
    }
    assert.equal(r.ok, true, r.error);
    c.send({ type: 'arrived' });
    const made = await c.stateWhere((m) => m.character.character.created && m.character.location === OPENING_DUNGEON, 'opening room');
    note(`create ${username} (${className})`, 'ok', `${refusals} × "The starting dungeon is loading" first; career from ${rolled.character.character.draft.career.name ?? className}; ${made.character.gold} gold`);
    return c;
  }
  const a = await create('Aldora', 'Warrior', 'Breton', 'Female');
  const b = await create('Brannoc', 'Knight', 'Nord', 'Male');

  // ---- 2. both at the Privateer's Hold start, each sees the other --------------------------------------------------
  const opening = svc().portals.into(OPENING_DUNGEON);
  const startMark = opening.meta.newCharacterStart;
  for (const [c, other] of [[a, b], [b, a]]) {
    await c.stateWhere((m) => m.peers?.some((p) => p.id === other.welcome.id), 'the other player as a peer');
    await nextState(c);
    const p = me(c);
    assert.ok(Math.hypot(p.x - startMark.x, p.z - startMark.z) < 0.5, `${c.welcome.id} at the authored start marker`);
  }
  assert.ok(a.state.character.quests.active.some((q) => q.name === '_TUTOR__'), 'the tutorial prompt runs');
  const leaveEarly = await a.act('portal.leave');
  assert.equal(leaveEarly.ok, false);
  note('both at the start', `${where(a)}; peers both ways`, `start marker ${startMark.x},${startMark.z}; portal.leave from the cell: "${leaveEarly.error}"`);

  // ---- 3+4. walk to the real exit through real doors, fighting what comes ------------------------------------------
  for (const c of [a, b]) assert.equal((await c.act('combat.ready', { ready: true })).ok, true);
  const liveMonsters = (c) => c.state.entities.filter((e) => e.kind === 'monster' && !e.dead && !(e.hp <= 0));
  const kills = [];
  const gone = new Set(); // killed by the other player since the last snapshot
  const alive = (c) => assert.ok(c.state.character.character.health > 0, `${c.welcome.id} was defeated at ${me(c)?.x.toFixed(1)},${foot(c).toFixed(1)},${me(c)?.z.toFixed(1)}`);
  async function fight(c, sight = 6) {
    // Close with and strike any monster within `sight` on this storey until none is left close by.
    for (let n = 0; n < 600; n++) {
      alive(c);
      const p = me(c);
      const f = foot(c);
      const foe = liveMonsters(c).filter((e) => !gone.has(e.id) && Math.abs((e.y ?? f) - f) < 2 && Math.hypot(e.x - p.x, e.z - p.z) < sight)
        .sort((x, y) => Math.hypot(x.x - p.x, x.z - p.z) - Math.hypot(y.x - p.x, y.z - p.z))[0];
      if (!foe) return;
      const d = Math.hypot(foe.x - p.x, foe.z - p.z);
      c.send({ type: 'input', forward: d > 1.6 ? 1 : 0, strafe: 0, yaw: Math.atan2(foe.x - p.x, -(foe.z - p.z)) });
      await nextState(c);
      if (d > 2.2) continue;
      const r = await c.act('combat.attack', { targetId: foe.id, direction: 'down' });
      if (!r.ok && /nothing there/.test(r.error)) { gone.add(foe.id); continue; }
      if (!r.ok && !/recovering/.test(r.error)) throw new Error(`attack: ${r.error}`);
      await nextState(c);
      const after = c.state.entities.find((e) => e.id === foe.id);
      if (!after || after.dead || after.hp <= 0) gone.add(foe.id), kills.push({ by: c.welcome.id, name: foe.name, at: f });
    }
  }

  const t0 = Date.now();
  const L = OPENING_DUNGEON;
  const scene = await svc().interiors.scene(L);
  const exitDoor = opening.entrances[0].enter;
  const isOpen = (id) => svc().dungeonLocks.isOpen(L, id);
  const doorsUsed = [];
  /** Walks `leader` to `target`, opening the doors in the way; `follower` walks the same waypoints. */
  async function cross(target, reach, done = () => false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await nextState(a);
      const p = me(a);
      const ex = new DungeonExplorer(svc().collision.instanceWorld(L), { x: p.x, y: foot(a), z: p.z }, target, { reach, dy: 2.5, maxDrop: 0.8 });
      let cur = ex.root;
      const tried = new Set();
      try {
        for (let round = 0; round < 40; round++) {
          const hit = ex.search();
          const cands = hit ? [] : usableDoors(ex.visited, scene.mechanisms, target, { isOpen, tried, reach: 2.5 });
          if (!hit) assert.ok(cands.length, `no usable door from ${ex.visited.length} reachable spots`);
          const goal = hit ?? cands[0].stand;
          const path = ex.between(cur, goal);
          if (process.env.DFW_LOOP_TRACE) console.log(`[loop] ${((Date.now() - t0) / 1000).toFixed(0)} s at ${me(a).x.toFixed(1)},${foot(a).toFixed(1)},${me(a).z.toFixed(1)} → ${path.length} hops to ${hit ? 'exit' : cands[0].door.id}; kills ${kills.length}`);
          await Promise.all([a, b].map(async (c) => { for (const [i, w] of path.entries()) { await fight(c); await walkTo(c, w.x, w.z, i === path.length - 1 ? 0.24 : 0.6, { halt: i === path.length - 1 }); } }));
          if (hit || done()) return;
          const { door } = cands[0];
          tried.add(door.id);
          cur = goal;
          a.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(door.x - me(a).x, -(door.z - me(a).z)) });
          await nextState(a);
          const r = await a.act(door.lock ? 'dungeon.pick' : 'dungeon.use', { id: door.id });
          doorsUsed.push(`${door.id}${door.lock ? ` (lock ${door.lock})` : ''}: ${r.ok ? 'ok' : r.error}`);
          for (let i = 0; i < 40; i++) await nextState(a); // the leaf swings
          ex.reopen(door, 5);
        }
      } catch (err) {
        if (!/stuck/.test(err.message) || attempt === 5) throw err;
      }
    }
    throw new Error('no route to the exit');
  }
  // Toward the real exit until the first real monster on the way is down (the full climb: see the review report).
  await cross(exitDoor, 1.2, () => kills.length > 0);
  await Promise.all([a, b].map((c) => fight(c)));
  assert.ok(kills.length > 0, 'a real monster was killed near the start');
  note('first door and a real fight', kills.map((k) => `${k.by === a.welcome.id ? 'Aldora' : 'Brannoc'} killed the ${k.name}`).join('; '),
    `${((Date.now() - t0) / 1000).toFixed(0)} s from the start marker to ${me(a).x.toFixed(1)},${foot(a).toFixed(1)},${me(a).z.toFixed(1)}; doors: ${doorsUsed.join('; ')}`);

  // ---- 8. cold restart on the same databases ---------------------------------------------------------------------
  const before = new Map();
  for (const c of [a, b]) {
    await stop(c);
    const ch = c.state.character;
    before.set(c.jar.user.username, { location: ch.location, gold: ch.gold, items: ch.inventory.map((i) => i.id).sort(), pos: me(c), guilds: ch.guilds });
  }
  await Promise.all([a, b].map((c) => c.close()));
  open.length = 0;
  await live.close();
  const port = live.port;
  live = null;
  live = await startLiveWorld({ dir: tmp.dir, port, arena2Dir: ARENA2 });
  for (const c of [a, b]) {
    const name = c.jar.user.username;
    const again = await connect(c.jar);
    const ch = again.state.character;
    const was = before.get(name);
    assert.equal(ch.character.created, true, `${name} kept the created character`);
    assert.equal(ch.location, was.location);
    assert.equal(ch.gold, was.gold);
    assert.deepEqual(ch.inventory.map((i) => i.id).sort(), was.items);
    assert.deepEqual(ch.guilds, was.guilds);
    await nextState(again);
    const p = me(again);
    assert.ok(Math.hypot(p.x - was.pos.x, p.z - was.pos.z) < 0.5, `${name} rejoined where they stood`);
    note(`cold restart: ${name}`, 'restored', `${ch.location}, ${ch.gold} gold, ${ch.inventory.length} items, at ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
  }
});
