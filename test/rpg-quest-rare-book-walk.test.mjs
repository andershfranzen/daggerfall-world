// K0C00Y08 "A Rare Book", played end to end over two real account sockets (package 17).
//
// Every move is normal `input` over the WebSocket, through the server's authoritative locomotion and collision.
// Doors are the production portal.use / portal.leave, dungeon doors are opened with dungeon.use from within reach,
// and the book is taken with quest.click. Route planning reads the server's collision world and door state as an
// ORACLE only: it decides where to steer, and never moves a player. Between pickup and return the server is shut
// down and started again on the same world and account databases, and the dungeon's doors reset with it.
//
// Requires gamedata/…/arena2; skipped without it (RPG_INTEGRATION_STRICT=1 makes that a failure). It takes several
// minutes because the walk happens in real time. DFW_WALK_TRACE=<file> writes the walked positions for a capture.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  discoverFeatures, startLiveWorld, accountSession, LiveClient, readPersisted, tempDir, STRICT, localArena2, featuresWithQuestCatalog, withWorldClock,
} from './support/rpg-session.mjs';
import { DungeonExplorer, usableDoors, dungeonRoute } from './support/dungeon-route.mjs';
import { walkingRoute } from './support/walking-route.mjs';
import { CLASSIC_GAME_START_TIME } from '../client/gameplay/atmosphere/calendar.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? { timeout: 30 * 60_000 } : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const discovered = ARENA2 ? await discoverFeatures() : { features: [] };
const SHOP = 'interior:Daggerfall/Gothway Garden/3,0/16';
const HOME = 'town:Daggerfall/Gothway Garden';
const PASSWORD = 'integration-pass-phrase';

describe('[asset][live] K0C00Y08 A Rare Book: uninterrupted walk through the dungeon', () => {
  const tmp = ARENA2 ? tempDir('dfw-rare-book-walk-') : null;
  let world = null;
  const open = [];
  const trace = [];
  let lastBlock = null; // where the last walk stalled (failure diagnostics)
  after(async () => {
    try {
      await Promise.all(open.map((c) => c.close().catch(() => {})));
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  // FIXTURE CLOCK: the shared day starts at 08:00 on the classic start date when the test begins (the shop keeps
  // classic hours), and the same epoch carries over the restart so world time continues instead of resetting.
  const epochMs = Date.now();
  const startMinutes = CLASSIC_GAME_START_TIME - (CLASSIC_GAME_START_TIME % 1440) + 8 * 60;
  const boot = async () => {
    const base = await featuresWithQuestCatalog(discovered.features, ARENA2, ['K0C00Y08']);
    const features = withWorldClock(base, { epochMs, startMinutes });
    world = await startLiveWorld({ dir: tmp.dir, features, arena2Dir: ARENA2 });
    await world.server.runtime.ctx.services.interiors.ready;
  };
  const svc = () => world.server.runtime.ctx.services;
  const join = async (username, path) => {
    const jar = await accountSession(world.base, username, PASSWORD, path);
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    open.push(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    c.welcome = await c.next((m) => m.type === 'welcome', 'welcome', 20000);
    c.label = username;
    return c;
  };
  const where = (c) => c.state?.character?.location;
  // Positions come from the latest `state` stamped with the player's current location (older ones carry the
  // coordinates of the place they just left).
  const selfPos = (c) => {
    const me = c.state?.selfId ?? c.welcome?.id;
    const loc = where(c);
    for (let i = c.messages.length - 1; i >= 0; i--) {
      const m = c.messages[i];
      if (m.type === 'state' && (m.location === undefined || m.location === loc)) return m.players?.find((p) => p.id === me) ?? null;
    }
    return null;
  };
  const tick = async (c, n = 1) => {
    for (let i = 0; i < n; i++) {
      c.cursor = c.messages.length;
      const loc = where(c);
      await c.next((m) => m.type === 'state' && (m.location === undefined || m.location === loc), 'state', 20000);
    }
  };
  const footY = (c) => {
    const loc = where(c);
    const portal = c.state?.character?.portal;
    const pos = selfPos(c);
    if (Number.isFinite(pos?.y)) return pos.y; // the body's own foot height (publicBody)
    if (portal?.to === loc && Number.isFinite(portal.footY)) return portal.footY;
    return svc().collision.groundAt(loc, pos.x, pos.z) ?? 0;
  };

  /** Steers with real input until the server reports the player within `reach` of (x, z). */
  async function walkTo(c, x, z, reach, y = NaN) {
    let best = Infinity, still = 0;
    for (let i = 0; i < 3000; i++) {
      const pos = selfPos(c);
      const d = pos ? Math.hypot(x - pos.x, z - pos.z) : Infinity;
      if (pos && c.label === 'aldora') trace.push({ t: Date.now(), loc: where(c), x: pos.x, z: pos.z, y: footY(c) });
      const yaw = pos ? Math.atan2(x - pos.x, -(z - pos.z)) : 0;
      // Stacked floors: a waypoint above the body counts only once climbed to (a stair can pass under it).
      if (pos && d <= reach && !(footY(c) - y < -1)) {
        c.send({ type: 'input', forward: 0, strafe: 0, yaw });
        return true;
      }
      // Pushing into a wall for 1.2 s starts a climb (client/lib/locomotion.js), which leaves the planned floor:
      // give up after about a second without progress and let the caller plan again from where the body is.
      if (d < best - 0.01) { best = d; still = 0; } else if (++still > 12) {
        lastBlock = { at: { x: pos?.x, z: pos?.z, y: footY(c) }, toward: { x, z }, loc: where(c), hp: c.state?.character?.health,
          mode: (() => { const q = world.server.runtime.ctx.players.get(c.welcome.id); return q && svc().collision.bodyOf(q)?.mode; })(),
          heard: c.messages.filter((m) => m.type === 'gameEvent' && /spellResult|monsterAttack|dungeonHazard|dungeonText/.test(m.event.kind)).slice(-3).map((m) => m.event.text ?? m.event.kind) };
        c.send({ type: 'input', forward: 0, strafe: 0, yaw });
        return false; // blocked (a door leaf swung into the way); the caller plans again
      }
      // Walk slowly and ease off near the waypoint so the body does not overshoot into walls between snapshots.
      c.send({ type: 'input', forward: Math.min(1, Math.max(0.35, d / 0.8)), strafe: 0, yaw, slow: true });
      await tick(c);
    }
    return false;
  }
  async function walkPath(c, path) {
    for (const w of path) if (!(await walkTo(c, w.x, w.z, 0.3, w.y))) return false;
    return true;
  }
  /** Short approach on one level with the stock oracle (towns and shops). */
  async function approach(c, x, z, reach, targetY) {
    const loc = where(c);
    await svc().collision.whenSettled(loc);
    await tick(c, 3);
    const at = selfPos(c);
    const col = svc().collision.instanceWorld(loc);
    const indoors = /^(interior|dungeon):/.test(loc);
    const from = { x: at.x, y: indoors ? footY(c) : col.standHeight(at.x, at.z), z: at.z };
    const path = walkingRoute(col, from, { x, y: targetY, z }, Math.max(0.2, reach - 0.3), indoors)
      ?? dungeonRoute(col, from, { x, y: targetY, z }, { reach: Math.max(0.2, reach - 0.3), dy: 2.5, step: 0.25 }).path; // narrow counter gaps
    assert.ok(path, `walking route in ${loc} from ${JSON.stringify(from)} to ${JSON.stringify({ x, y: targetY, z })}`);
    assert.ok(await walkPath(c, path), `walked to (${x}, ${z}) in ${loc}`);
  }

  /**
   * Walks through a dungeon to `target` like a player: plan over what is reachable now; when closed doors are in
   * the way, walk to the one nearest the goal, open it with dungeon.use, and continue. Returns what was opened.
   */
  async function crossDungeon(c, target, reach, what) {
    const loc = where(c);
    const s = svc();
    await s.collision.whenSettled(loc);
    // The landing is settled once the server reports a clear spot (a dungeon re-seats a body on its floor).
    for (let i = 0; i < 100; i++) {
      await tick(c);
      const p = selfPos(c);
      if (p && s.collision.isClear(loc, p.x, p.z, footY(c))) break;
    }
    const scene = await s.interiors.scene(loc);
    const isOpen = (id) => s.dungeonLocks.isOpen(loc, id);
    const opened = [];
    const tried = new Set();
    const note = (...m) => process.stderr.write(`[walk] ${what}: ${m.join(' ')}\n`);
    for (let attempt = 0; attempt < 12; attempt++) {
      const pos = selfPos(c);
      const col = s.collision.instanceWorld(loc);
      // Stairs only, replayed hop by hop: free falls and long shortcuts land the server body off the planned floor.
      const ex = new DungeonExplorer(col, { x: pos.x, y: footY(c), z: pos.z }, target, { reach, maxDrop: 0.8 });
      let cur = ex.root;
      let blocked = false;
      for (let round = 0; round < 80; round++) {
        const hit = ex.search();
        if (hit) {
          const leg = ex.between(cur, hit, { shortcuts: false });
          note(`attempt ${attempt} round ${round}: route found (${leg.length} waypoints, ${ex.expanded} expanded)`);
          if (await walkPath(c, leg)) return { opened, expanded: ex.expanded };
          note(`blocked on the final leg at ${JSON.stringify(selfPos(c))}`);
          blocked = true;
          break;
        }
        const cands = usableDoors(ex.visited, scene.mechanisms, target, { isOpen, tried });
        assert.ok(cands.length, `${what}: no usable door from ${ex.visited.length} reachable spots (${loc} start ${JSON.stringify(ex.start)}, clear ${col.isClear(ex.start.x, ex.start.z, ex.start.y)}, server ${JSON.stringify((() => { const q = world.server.runtime.ctx.players.get(c.welcome.id); return q && { x: q.x, z: q.z, foot: q.rpg?.portal?.footY }; })())}, landing ${JSON.stringify(s.portals.into(loc)?.entrances?.[0]?.enter)})`);
        const { door, stand } = cands[0];
        tried.add(door.id);
        note(`attempt ${attempt} round ${round}: ${ex.visited.length} reachable, door ${door.id} lock ${door.lock}`);
        if (!(await walkPath(c, ex.between(cur, stand, { shortcuts: false })))) { note(`blocked walking to door ${door.id} at ${JSON.stringify(selfPos(c))}`); blocked = true; break; }
        cur = stand;
        const face = selfPos(c);
        c.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(door.x - face.x, -(door.z - face.z)) });
        const r = await c.act(door.lock ? 'dungeon.pick' : 'dungeon.use', { id: door.id });
        if (r.ok && isOpen(door.id)) opened.push(door.id);
        note(`door ${door.id}: ${r.ok ? 'used' : r.error}, open ${isOpen(door.id)}`);
        await tick(c, 25); // let the leaf finish swinging
        ex.reopen(door, 5);
      }
      if (!blocked) break;
    }
    assert.fail(`${what}: could not reach (${target.x}, ${target.z}) after opening ${opened.length} doors; last stall ${JSON.stringify(lastBlock)}`);
  }

  async function useDoor(c, verb, args, done) {
    for (let i = 0; i < 80; i++) {
      const r = await c.act(verb, args);
      if (r.ok) return c.stateWhere((m) => done(m.character.location), `${verb} done`);
      if (!/loading|moment|Wait|breath/i.test(r.error)) throw new Error(`${verb}: ${r.error}`);
      await tick(c, 5);
    }
    throw new Error(`${verb} never succeeded`);
  }
  async function enterBuilding(c, town, interior) {
    await svc().interiors.survey(town);
    const spec = svc().portals.at(town).find((sp) => sp.to === interior);
    await approach(c, spec.entrances[0].exit.x, spec.entrances[0].exit.z, 0.6);
    await useDoor(c, 'portal.use', { portalId: spec.id }, (l) => l === interior);
  }
  async function leaveBuilding(c) {
    const loc = where(c);
    const door = svc().portals.into(loc);
    await approach(c, door.entrances[0].inner.x, door.entrances[0].inner.z, 2.0, door.entrances[0].enter?.y); // doors are used within 3 m
    await useDoor(c, 'portal.leave', {}, (l) => !/^(interior|dungeon):/.test(l));
  }
  async function travel(c, to) {
    for (let i = 0; i < 60; i++) {
      const r = await c.act('travel.go', { to });
      if (r.ok) return c.stateWhere((m) => m.character.location === to, `arrived in ${to}`);
      if (!/Catch your breath|Wait/i.test(r.error)) throw new Error(`travel.go: ${r.error}`);
      await tick(c, 10);
    }
    throw new Error('travel never allowed');
  }
  async function enterDungeon(c, town) {
    await svc().interiors.survey(town);
    const door = svc().portals.at(town).find((x) => x.kind === 'dungeon');
    await approach(c, door.entrances[0].exit?.x ?? door.entrances[0].x, door.entrances[0].exit?.z ?? door.entrances[0].z, 1.0);
    await svc().collision.whenSettled(door.to);
    await useDoor(c, 'portal.use', { portalId: door.id }, (l) => l === door.to);
    return door;
  }
  // Entities (people, quest items) arrive in `rpg` snapshots; `state` messages carry player positions.
  const entities = (c) => c.state?.entities ?? [];
  const merchantOf = (c) => entities(c).find((e) => e.kind === 'npc' && e.questGroup === 'Merchants');
  async function toMerchant(c) {
    let m = null;
    for (let i = 0; i < 200 && !m; i++) { await tick(c); m = merchantOf(c); }
    assert.ok(m, 'the Merchants questor is in the shop');
    await approach(c, m.x, m.z, 2.5, m.y);
    return m;
  }

  test('offer → advance → reveal → walk in, open doors, take the book → restart → walk out → paid once', gate, async (t) => {
    const t0 = Date.now();
    await boot();
    let a = await join('aldora');
    // FIXTURE SETUP: extra health for the walker. Combat stays on, and the Conclave's residents attack a new level-1
    // character; without this the walker is defeated mid-route and respawns at the entrance. The character feature
    // recomputes maximum health on join, so it is applied again after the restart.
    const sturdy = (c) => Object.assign(world.server.runtime.ctx.players.get(c.welcome.id).rpg.character, { maxHealth: 5000, health: 5000 });
    sturdy(a);
    let b = await join('brannoc');
    await a.stateWhere((m) => m.character?.location === HOME, 'A in Gothway Garden');
    await b.stateWhere((m) => m.character?.location === HOME, 'B in Gothway Garden');
    assert.equal((await a.act('party.invite', { targetId: b.welcome.id })).ok, true);
    assert.equal((await b.act('party.accept', { fromId: a.welcome.id })).ok, true);

    // Both walk into the general store and up to the merchant.
    await enterBuilding(a, HOME, SHOP);
    await enterBuilding(b, HOME, SHOP);
    const merchant = await toMerchant(a);
    await toMerchant(b);
    const g0 = a.state.character.gold;
    let r = await a.act('quest.request', { targetId: merchant.id });
    assert.equal(r.ok, true, r.error);
    const offer = (await a.next((m) => m.type === 'gameEvent' && m.event.kind === 'questOffer', 'offer', 10000)).event;
    assert.match(offer.text, /book/i, 'original QRC offer text');
    assert.equal((await b.act('quest.accept', { offerId: offer.offerId })).ok, false, "B cannot accept A's offer");
    assert.equal((await a.act('quest.accept', { offerId: offer.offerId })).ok, true);
    const accepted = await a.stateWhere((m) => m.character.quests?.active?.[0]?.name === 'K0C00Y08', 'quest accepted');
    const inst = accepted.character.quests.active[0];
    const advance = inst.items['i.01'].gold;
    const reward = inst.items['i.00'].gold;
    assert.equal(accepted.character.gold, g0 + advance, 'advance paid on acceptance');
    const place = inst.places['l.00'];
    assert.match(place.interior, /^dungeon:Daggerfall\//, 'a remote dungeon in the giver’s region');
    const marked = await a.stateWhere((m) => m.character.quests.active[0].items['i.02'].markerAt, 'book bound to a marker');
    const marker = marked.character.quests.active[0].items['i.02'].markerAt;

    // Out through the shop door, travel to the revealed site, and in through its entrance.
    for (const c of [a, b]) await leaveBuilding(c);
    for (const c of [a, b]) await travel(c, place.location);
    const entrance = await enterDungeon(a, place.location);
    await enterDungeon(b, place.location);
    const seen = await a.stateWhere((m) => m.entities?.some?.((e) => e.kind === 'questItem'), 'A sees the book');
    const book = seen.entities.find((e) => e.kind === 'questItem');
    await tick(b, 5);
    assert.ok(!entities(b).some((e) => e.kind === 'questItem'), 'B never receives A’s book');

    // The uninterrupted walk: entrance → book, opening doors on the way.
    const inwardMark = a.messages.length;
    const inward = await crossDungeon(a, { x: marker.x, y: marker.y, z: marker.z }, 2.2, 'entrance to the book');
    assert.deepEqual(a.messages.slice(inwardMark).filter((m) => m.type === 'gameEvent' && (m.event.kind === 'teleport' ||
      (['defeat', 'resurrect'].includes(m.event.kind) && String(m.event.playerId) === String(a.welcome.id)))).map((m) => m.event.kind), [],
    'no defeat, resurrection or teleport on the way in');
    const near = entities(a).find((e) => e.kind === 'questItem');
    assert.ok(near, 'the book is in view');
    assert.equal(near.marker, marker.id, 'on its authored quest item marker');
    assert.equal(near.id, book.id);
    r = await b.act('quest.click', { targetId: near.id });
    assert.equal(r.ok, false, 'B cannot take A’s book');
    r = await a.act('quest.click', { targetId: near.id });
    assert.equal(r.ok, true, r.error);
    const holding = await a.stateWhere((m) => m.character.quests.active[0].items['i.02'].held, 'book held');
    assert.equal(holding.character.gold, g0 + advance, 'pickup pays nothing');

    // Graceful restart on the same databases while A is still deep in the dungeon.
    const inside = selfPos(a);
    await Promise.all(open.splice(0).map((c) => c.close()));
    await world.close();
    assert.equal(readPersisted(world.dbPath, a.welcome.id).rpg.quests.active[0].items['i.02'].held, true, 'held book saved');
    await boot();
    a = await join('aldora', '/api/login');
    sturdy(a);
    b = await join('brannoc', '/api/login');
    const resumed = await a.stateWhere((m) => m.character.location === place.interior, 'A resumes inside the dungeon');
    assert.equal(resumed.character.quests.active[0].uid, inst.uid, 'same instance after restart');
    await tick(a, 5);
    const back = selfPos(a);
    assert.ok(Math.hypot(back.x - inside.x, back.z - inside.z) < 1.5, 'resumes where A stood');
    assert.ok(!entities(a).some((e) => e.kind === 'questItem'), 'taken book is not respawned');

    // Walk back to the entrance (the doors closed again with the restart) and out.
    const exit = entrance.entrances[0].inner ?? entrance.entrances[0].enter;
    const returnFrom = trace.length;
    const returnMark = a.messages.length;
    const outward = await crossDungeon(a, { x: exit.x, y: entrance.entrances[0].enter?.y, z: exit.z }, 1.0, 'book to the exit');
    // The retrace is physical: no defeat, resurrection or teleport, and no position jump between snapshots
    // (4 m/s at most, 12.5 snapshots a second; 2 m allows a few dropped snapshots).
    const relocations = a.messages.slice(returnMark).filter((m) => m.type === 'gameEvent' && ['defeat', 'resurrect', 'teleport'].includes(m.event.kind)
      && (m.event.kind === 'teleport' || String(m.event.playerId) === String(a.welcome.id))).map((m) => m.event.kind);
    assert.deepEqual(relocations, [], 'no defeat, resurrection or teleport on the way out');
    const jumps = [];
    const leg = trace.slice(returnFrom);
    for (let i = 1; i < leg.length; i++) {
      const p = leg[i - 1], q = leg[i];
      if (p.loc === q.loc && Math.hypot(q.x - p.x, q.z - p.z) > 2) jumps.push({ from: p, to: q });
    }
    assert.deepEqual(jumps, [], 'the retrace has no position discontinuity');
    const retraced = leg.reduce((m, q, i) => (i ? m + Math.hypot(q.x - leg[i - 1].x, q.z - leg[i - 1].z) : 0), 0);
    await useDoor(a, 'portal.leave', {}, (l) => !/^(interior|dungeon):/.test(l));
    if (/^dungeon:/.test(where(b) ?? '')) await leaveBuilding(b);

    // Home, into the shop, and the turn-in: paid exactly once, to A only.
    for (const c of [a, b]) await travel(c, HOME);
    for (const c of [a, b]) await enterBuilding(c, HOME, SHOP);
    const m2 = await toMerchant(a);
    await toMerchant(b);
    const gb = b.state.character.gold;
    await b.act('npc.talk', { targetId: m2.id });
    const ga = a.state.character.gold;
    r = await a.act('npc.talk', { targetId: m2.id });
    assert.equal(r.ok, true, r.error);
    const paid = await a.stateWhere((m) => m.character.quests?.done?.[0]?.uid === inst.uid, 'quest completed');
    assert.equal(paid.character.gold, ga + reward, `reward ${reward} paid`);
    assert.equal(paid.character.quests.done[0].result, 'success');
    await a.act('npc.talk', { targetId: m2.id });
    await tick(a, 10);
    assert.equal(a.state.character.gold, ga + reward, 'a second turn-in pays nothing');
    assert.equal(b.state.character.gold, gb, 'B is paid nothing');
    const dbA = readPersisted(world.dbPath, a.welcome.id).rpg;
    assert.equal(dbA.quests.done.filter((d) => d.uid === inst.uid).length, 1);
    assert.equal(dbA.gold, ga + reward);
    assert.ok(!(readPersisted(world.dbPath, b.welcome.id).rpg.quests?.done ?? []).length, 'B never had the quest');

    const summary = {
      quest: 'K0C00Y08', dungeon: place.interior, marker, advance, reward, doorsIn: inward.opened.length, doorsOut: outward.opened.length, retracedMetres: Math.round(retraced), returnSamples: leg.length,
      seconds: Math.round((Date.now() - t0) / 1000), steps: trace.length,
    };
    if (process.env.DFW_WALK_TRACE) writeFileSync(process.env.DFW_WALK_TRACE, JSON.stringify({ ...summary, entrance: entrance.entrances[0], trace }));
    t.diagnostic(JSON.stringify(summary));
  });
});
