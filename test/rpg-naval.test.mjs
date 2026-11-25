// Naval combat (server/rpg/naval.js, rules in server/rpg/sailing/combatRules.js).
//
// 1. Pure rules from the DFO reference (shot kinds, reload, ram, musters, the wreck's prize share).
// 2. FIXTURE (in-process runtime + real SQLite on /var/tmp + real combat with the installed classic data + the real
//    sailing core on invented test water): an NPC raider fights a player ship with authoritative balls; shot kinds;
//    struck colours; grapple and boarding against ordinary melee foes visible only to the boarding crew; raid win,
//    once-only plunder with rollback when the pack refuses; retreat; merchant flight; piracy witnesses; ramming;
//    an ashore owner cannot fight; restart keeps the vessel's combat state.
// 3. LIVE (server/game.js over real WebSockets, real accounts): two captains in one water see the same volleys and
//    hits; peaceful colours and harbours refuse player fire; a wrecked captain's hold goes to her killer once, with no
//    duplicate and nothing of anyone else's hold shown.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import * as R from '../server/rpg/sailing/combatRules.js';
import { features as manifest } from '../server/rpg/features.js';
import { install as combat } from '../server/rpg/combat.js';
import { install as sailing } from '../server/rpg/sailing.js';
import { install as naval } from '../server/rpg/naval.js';
import { makeItem } from '../server/rpg/inventory.js';
import { createFixtureWorld, tempDir, localArena2, startLiveWorld, accountSession } from './support/rpg-session.mjs';

const arena2 = localArena2();
const needsData = { skip: !arena2 && 'installed classic data required' };

// ------------------------------------------------------------------ test water

const PORT_A = 'town:Daggerfall/Daggerfall';
const PORTS = [
  { id: PORT_A, name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI / 2, quay: { x: 0, z: -40, yaw: 0 } },
  { id: 'town:Wayrest/Wayrest', name: 'Wayrest', region: 'Wayrest', x: 9000, z: 1000, yaw: -Math.PI / 2, quay: { x: 0, z: 30, yaw: 0 } },
];
const coast = {
  status: 'ready', isWater: () => true, ports: () => PORTS, portOf: (id) => PORTS.find((p) => p.id === id) ?? null,
  nearestPort: (x, z) => PORTS.map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) })).sort((a, b) => a.distance - b.distance)[0],
};
/** Test-only staging: a deed at the port, a vessel pose out at sea, a hull value, hold goods. */
function fixture(ctx) {
  const S = ctx.services;
  ctx.onAction('fixture.deed', (p, { type, level }) => {
    p.rpg.location = PORT_A;
    if (type) p.rpg.property = { ...(p.rpg.property ?? {}), version: 0, ship: { type, boughtAt: 0 } };
    if (level && p.rpg.character) p.rpg.character.level = level;
    p.x = 0; p.z = -40;
  });
  ctx.onAction('fixture.place', (p, { x, z, yaw = 0, speed = 0 }) => {
    const v = S.sailing.aboard(p) ?? S.sailing.byId(`v${p.id}`);
    if (!v) throw new Error('no vessel');
    Object.assign(v, { x, z, yaw, speed, anchored: speed === 0, sails: 0, oars: 0, rudder: 0, docked: null });
    S.sailing.save(v);
  });
  ctx.onAction('fixture.hull', (p, { hp }) => {
    const v = S.sailing.aboard(p) ?? S.sailing.byId(`v${p.id}`);
    v.hull.hp = hp;
    S.sailing.save(v);
  });
  ctx.onAction('fixture.hold', (p, { items }) => {
    const st = p.rpg.property;
    st.stores ??= {};
    st.stores.ship = items.map(([t, q]) => makeItem(t, q));
  });
  ctx.onAction('fixture.fillPack', (p) => {
    while (p.rpg.inventory.length < 200) p.rpg.inventory.push(makeItem('iron-dagger', 1));
  });
  ctx.onAction('fixture.emptyPack', (p) => {
    p.rpg.inventory = p.rpg.inventory.filter((i) => i.template !== 'iron-dagger' || i.equipped);
  });
}
const pick = (names) => manifest.filter((f) => names.includes(f.name));
const FEATURES = (navalOpts, { yard = false } = {}) => [
  ...pick(['character', 'inventory', 'alchemy', 'travel', 'property', 'social']),
  { name: 'combat', install: (ctx) => combat(ctx, { random: () => 0.18, classicSpawns: false }) },
  { name: 'sailing', install: (ctx) => sailing(ctx, { coast, loadCoast: false }) },
  ...(yard ? pick(['shipyard']) : []),
  { name: 'naval', install: (ctx) => naval(ctx, { spawn: false, sinkS: 1, scuttleS: 2, stateHz: 4, seed: 7, ...navalOpts }) },
  { name: 'fixture', install: fixture },
];

// ------------------------------------------------------------------ 1. rules

describe('naval rules (DFO reference numbers)', () => {
  test('shot kinds scale the gun from its natural load', () => {
    const round = R.shotGun('long', 'round');
    const grape = R.shotGun('long', 'grape');
    const chain = R.shotGun('long', 'chain');
    const heated = R.shotGun('long', 'heated');
    assert.equal(round.hull, 14);
    assert.equal(grape.crew, 4);
    assert.ok(Math.abs(grape.hull - 2.8) < 1e-9);
    assert.equal(chain.sail, 12);
    assert.equal(heated.reload, 9 * 1.6);
    // a bow chaser's natural load is chain: loaded with round it throws a long gun's kind of ball
    assert.equal(R.shotGun('chain', 'chain').sail, 16);
    assert.ok(Math.abs(R.shotGun('chain', 'round').hull - 3 / 0.22) < 1e-9);
    assert.equal(R.shotFireChance('heated'), 0.45);
    assert.equal(R.shotReach('grape', 3), 0.5);
  });
  test('reload slows with a thinned crew; a ball lands where the lay says', () => {
    assert.equal(R.reloadSeconds('long', 1, true), 9);
    assert.ok(Math.abs(R.reloadSeconds('long', 0.5, true) - 9 * 1.4) < 1e-9);
    assert.ok(Math.abs(R.reloadSeconds('swivel', 1, false) - 4 * 1.4) < 1e-9);
    const el = R.elevationForRange(150, 62, 3, -8 * Math.PI / 180, 15 * Math.PI / 180);
    const v0 = R.launchVelocity([1, 0, 0], el, 62);
    const t = R.timeToHeight(3, v0[1], 0);
    const p = R.shotPosition([0, 3, 0], v0, t);
    assert.ok(Math.abs(p[0] - 150) < 0.5, `lands at ${p[0]}`);
    assert.ok(R.maxRange(62, 2.24, 15 * Math.PI / 180) > 190);
  });
  test('ram blow, recoil, muster and the wreck prize share', () => {
    assert.equal(R.ramBlow({ closing: 1, side: true, mine: 900, hers: 600 }), 0);
    assert.equal(R.ramBlow({ closing: 8, side: true, mine: 900, hers: 600 }), 90);
    assert.equal(R.ramBlow({ closing: 8, side: false, mine: 900, hers: 600 }), 36);
    assert.equal(R.ramBlow({ closing: 8, side: true, mine: 900, hers: 600, galley: true }), 180);
    assert.ok(Math.abs(R.recoilShare(true) - 0.1) < 1e-12);
    const m = R.musterOf(R.classById('pirateBrig'), 1);
    assert.equal(m.captain, R.MOBILE.Spellsword);
    assert.equal(m.men.length + 1, 12);
    assert.equal(R.musterOf(R.classById('merchantCoaster'), 0.1).men.length + 1, R.MUSTER_MIN);
    assert.ok(R.boardingWon({ captainDown: true, down: 7, total: 10 }));
    assert.ok(!R.boardingWon({ captainDown: false, down: 9, total: 10 }));
    // a third of the hold's worth, best piece always, eight at most
    assert.deepEqual(R.seaPrizePlaces([{ worth: 10 }, { worth: 500 }, { worth: 30 }, { worth: 100 }]), [1]);
    assert.deepEqual(R.seaPrizePlaces([{ worth: 10 }, { worth: 10 }, { worth: 10 }]), [0]);
    assert.equal(R.seaPrizePlaces(Array.from({ length: 40 }, () => ({ worth: 1 }))).length, R.SEA_PRIZE_PIECES_MAX);
  });
  test('frames: yaw 0 is north, starboard is east', () => {
    const pose = { x: 100, z: 100, yaw: 0 };
    assert.deepEqual(R.toWorld(pose, [10, 0, 0]).map(Math.round), [110, 0, 100]);
    assert.deepEqual(R.toWorld(pose, [0, 0, 10]).map(Math.round), [100, 0, 90]);
    assert.equal(R.sideForBearing(R.bearingOf(pose, 200, 100)), 'starboard');
    assert.equal(R.sideForBearing(R.bearingOf(pose, 0, 100)), 'port');
    assert.equal(R.sideForBearing(R.bearingOf(pose, 100, 0)), 'bow');
  });
});

// ------------------------------------------------------------------ 2. fixture world

async function fixtureWorld(t, navalOpts = {}, opts = {}) {
  const tmp = tempDir('dfw-naval-', '/var/tmp');
  const world = await createFixtureWorld({ dbPath: join(tmp.dir, 'world.db'), features: FEATURES(navalOpts, opts), dataPath: arena2 });
  t.after(() => { world.close(); tmp.remove(); });
  assert.deepEqual(world.installErrors, []);
  const N = () => world.ctx.services.naval;
  const tick = (ms, step = 40) => { for (let i = 0; i < ms; i += step) world.tick(step); };
  const must = (c, verb, args = {}) => { const r = c.act(verb, args); assert.ok(r.ok, `${verb}: ${r.error}`); return r; };
  const ready = (c) => {
    must(c, 'character.create', { name: c.player.name, race: 'Breton', gender: 'Female', className: 'Warrior' });
  };
  return { world, N, tick, must, ready, tmp };
}
async function captain(fx, account, name, type, at) {
  const c = fx.world.connect(account, name);
  const r = c.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
  if (!r.ok && !/already/i.test(r.error)) { /* some fixtures create the character elsewhere */ }
  fx.must(c, 'fixture.deed', { type });
  fx.must(c, 'sailing.board');
  fx.must(c, 'sailing.launch');
  if (at) fx.must(c, 'fixture.place', at);
  return c;
}

describe('ship combat against NPC ships (fixture world)', needsData, () => {
  test('a raider and a player trade broadsides; grape, chain, struck, boarding, plunder once, rollback', async (t) => {
    const fx = await fixtureWorld(t);
    const { world, N, tick, must } = fx;
    const a = await captain(fx, 'naval-a', 'Anselm', 'large', { x: 1000, z: 6000, yaw: 0 });
    const vA = world.ctx.services.sailing.aboard(a.player);
    assert.ok(vA, 'Anselm is aboard at sea');

    // A pirate sloop lies 140 m off the starboard beam, heading north with her guns toward us.
    const pid = N().spawn('pirateSloop', 1140, 6000, 0);
    const pirate = N().record(pid);
    assert.equal(pirate.faction, 'pirate');
    const m0 = a.mark();
    tick(12_000);
    const shots = a.since(m0, 'gameEvent').map((m) => m.event).filter((e) => e.kind === 'naval.shot' && e.from.id === pid);
    assert.ok(shots.length > 0, 'the raider fires');
    assert.ok(shots.every((s) => s.balls.every((b) => b.p0.length === 3 && b.v0.length === 3 && Number.isFinite(b.t0))), 'balls are closed-form launches');
    const hitsOnMe = a.since(m0, 'gameEvent').map((m) => m.event).filter((e) => e.kind === 'naval.hit' && e.target?.id === vA.id);
    assert.ok(hitsOnMe.length > 0, 'her balls strike our hull or rig');
    assert.ok(vA.hull.hp < vA.hull.max || vA.naval.d.sail < vA.naval.d.maxSail || vA.naval.d.crew < vA.naval.d.maxCrew, 'damage is applied to the canonical vessel');
    const st = a.events('naval.state').at(-1);
    assert.equal(st.silent, true);
    assert.ok(st.contacts.some((c) => c.id === pid && c.faction === 'pirate'), 'naval.state lists the raider');

    // Shot kinds: grape into the broadside, chain into the bow chasers.
    must(a, 'naval.load', { group: 'broadside', shot: 'grape' });
    must(a, 'naval.load', { group: 'bow', shot: 'chain' });
    assert.equal(a.events('naval.state').at(-1).self.loads.broadside, 'grape');
    assert.ok(a.events('naval.state').at(-1).self.ready.starboard > 0, 'a loaded battery is drawn and loaded again');
    assert.equal(a.act('naval.fire', { side: 'starboard' }).ok, false, 'not ready while it reloads');
    tick(6000);
    pirate.x = vA.x + 120; pirate.z = vA.z; pirate.yaw = 0; pirate.speed = 0;
    const crewBefore = pirate.d.crew;
    const shotBefore = vA.naval.shot;
    const m1 = a.mark();
    must(a, 'naval.fire', { side: 'starboard', targetId: pid });
    assert.equal(vA.naval.shot, shotBefore - 5, 'one shot per gun');
    tick(4000);
    const myHits = a.since(m1, 'gameEvent').map((m) => m.event).filter((e) => e.kind === 'naval.hit' && e.target?.id === pid);
    assert.ok(myHits.length > 0, 'grape strikes the raider');
    assert.ok(pirate.d.crew < crewBefore, 'grape thins her crew');

    // Bring her to strike: her hull is battered down past the line.
    pirate.d.hull = Math.ceil(pirate.d.maxHull * 0.27);
    tick(10_000);
    must(a, 'naval.load', { group: 'broadside', shot: 'round' });
    tick(6000);
    pirate.x = vA.x + 120; pirate.z = vA.z; pirate.speed = 0;
    if (pirate.d.state === 'afloat') { must(a, 'naval.fire', { side: 'starboard', targetId: pid }); tick(4000); }
    assert.equal(pirate.d.state, 'struck', 'she strikes her colours');
    assert.ok(a.events('naval.news').some((e) => e.what === 'struck' && e.shipId === pid));

    // Grapple: too far, then alongside.
    pirate.x = vA.x + 120;
    assert.match(a.act('naval.grapple', { targetId: pid }).error, /close within 32 m/);
    pirate.x = vA.x + 30; pirate.z = vA.z;
    must(a, 'naval.grapple', { targetId: pid });
    assert.equal(N().wayShare(vA), 0, 'grappled ships make no way');
    assert.match(N().helmBlocked(vA), /grappled/);

    // A second crew on the same classic deck (another galleon at sea) sees none of this boarding.
    const c = await captain(fx, 'naval-c', 'Cyrus', 'large', { x: 5000, z: 6000, yaw: 0 });
    assert.equal(world.runtime.locationOf(c.player), world.runtime.locationOf(a.player), 'one classic deck location');

    must(a, 'naval.board', { targetId: pid });
    const foes = [...world.ctx.entities.values()].filter((e) => e.naval === `board:${pid}`);
    assert.ok(foes.length >= 3, `the muster stands on deck (${foes.length})`);
    world.tick(40);
    assert.ok(foes.every((e) => a.entity(e.id)), 'the boarders see every foe');
    assert.ok(foes.every((e) => !c.entity(e.id)), 'another crew on the same deck sees none');
    assert.equal(a.act('naval.plunder', { targetId: pid }).ok, false, 'no plunder while her crew fight');

    // Cut them down with the ordinary melee rules' damage service.
    // the captain first: with her down and 70% of the muster, the rest throw down their arms (and leave the deck)
    for (const e of foes) if (world.ctx.entities.get(e.id) === e && !e.dead) world.ctx.services.damageEntity(a.player, e, 100_000);
    assert.ok(foes.filter((e) => e.dead).length >= Math.ceil(foes.length * R.SURRENDER_SHARE), 'surrender at 70% with the captain down');
    world.tick(40);
    assert.ok(pirate.prize, 'the raid is won: she is our prize');
    assert.ok(a.events('naval.news').some((e) => e.what === 'boardWon'));

    // Plunder when the pack refuses (the inventory service throws): the action fails and nothing changes.
    const S = world.ctx.services;
    const give = S.giveItem;
    S.giveItem = () => { throw new Error('Your pack cannot hold any more items.'); };
    const goldBefore = a.player.rpg.gold;
    const r1 = a.act('naval.plunder', { targetId: pid });
    S.giveItem = give;
    assert.equal(r1.ok, false, 'a refusing pack refuses the hold');
    assert.match(r1.error, /pack cannot hold/);
    assert.equal(pirate.plundered ?? null, null, 'rolled back: still unplundered');
    assert.ok(!pirate.scuttleAt, 'rolled back: not marked for scuttling');
    assert.equal(a.player.rpg.gold, goldBefore);
    must(a, 'naval.plunder', { targetId: pid });
    assert.ok(a.player.rpg.gold > goldBefore || a.player.rpg.inventory.length > 0, 'the hold is in the pack');
    const once = a.act('naval.plunder', { targetId: pid });
    assert.equal(once.ok, false);
    assert.match(once.error, /already been stripped/);
    tick(4000);
    assert.equal(N().record(pid), null, 'the stripped prize is scuttled');
  });

  test('retreat from a boarding; merchant flight; piracy witnesses; ramming; ashore owner refused', async (t) => {
    const fx = await fixtureWorld(t);
    const { world, N, tick, must } = fx;
    const a = await captain(fx, 'naval-r', 'Riona', 'small', { x: 1000, z: 6000, yaw: 0 });
    const vA = world.ctx.services.sailing.aboard(a.player);
    const lawful = [];
    world.ctx.on('naval.lawful', (e) => lawful.push(e));

    // A merchant galleon off the starboard beam and a navy cutter within witness range.
    const mid = N().spawn('merchantGalleon', 1120, 6000, 0);
    const nid = N().spawn('navyCutter', 1000, 6500, Math.PI);
    const merchant = N().record(mid), navy = N().record(nid);
    must(a, 'naval.fire', { side: 'starboard', targetId: mid });
    tick(3000);
    assert.ok(merchant.d.hull < merchant.d.maxHull, 'the merchant is hit');
    assert.equal(lawful.length, 1, 'a first strike on a lawful ship is piracy (once)');
    assert.ok(navy.hostileTo.has(vA.id), 'the navy witnessed it and turns on us');
    tick(1000);
    assert.equal(merchant.ai.mode, 'flee', 'the merchant runs');

    // Strike her, grapple, board, then retreat: the boarders vanish and the grapples are cut.
    merchant.d.state = 'struck';
    merchant.x = vA.x + 20; merchant.z = vA.z; merchant.speed = 0;
    N().despawn(nid);
    must(a, 'naval.grapple', { targetId: mid });
    must(a, 'naval.board', { targetId: mid });
    const foes = [...world.ctx.entities.values()].filter((e) => e.naval === `board:${mid}`);
    assert.ok(foes.length >= 3);
    must(a, 'naval.retreat');
    assert.ok(foes.every((e) => !world.ctx.entities.has(e.id) || e.dead), 'the muster is gone');
    assert.equal(N().record(mid).grappledTo, null);
    assert.ok(a.events('naval.news').some((e) => e.what === 'retreat'));
    N().despawn(mid);

    // Ramming: a corsair galley drives her ram into our side at speed.
    const gid = N().spawn('pirateGalley', vA.x + 60, vA.z, -Math.PI / 2);
    const galley = N().record(gid);
    galley.x = vA.x + 6 + 51; galley.speed = 7; galley.ai.next = 99; galley.ai.heading = -Math.PI / 2; galley.ai.sails = 1;
    const hullBefore = vA.hull.hp;
    const m = a.mark();
    tick(1500);
    const ram = a.since(m, 'gameEvent').map((x) => x.event).find((e) => e.kind === 'naval.ram' && e.targetId === vA.id);
    assert.ok(ram, 'naval.ram reaches the crew');
    assert.ok(vA.hull.hp < hullBefore, 'the ram stove in her planking');
    assert.ok(vA.hull.hp >= Math.floor(vA.hull.max * R.STRUCK_AT) - 1, 'a ram never takes her under her line');
    N().despawn(gid);

    // Admiralty hooks: end events carry a lasting uid, the waters and the acting vessel; quarries spawn once.
    const ends = [];
    for (const k of ['naval.struck', 'naval.sunk']) world.ctx.on(k, (e) => ends.push({ k, ...e }));
    const qid = N().spawnQuarry({ key: 'bounty:test', classId: 'pirateSloop', x: vA.x + 140, z: vA.z, name: 'The Red Gull' });
    assert.equal(N().spawnQuarry({ key: 'bounty:test', classId: 'pirateSloop', x: 0, z: 0 }), qid, 'idempotent per key');
    const q = N().record(qid);
    q.d.hull = 1; q.speed = 0; q.ai.next = 99; q.ai.fire = null;
    tick(9000);
    must(a, 'naval.load', { group: 'broadside', shot: 'round' });
    tick(6000);
    q.x = vA.x + 120; q.z = vA.z; q.yaw = 0;
    must(a, 'naval.fire', { side: 'starboard', targetId: qid });
    tick(3000);
    const sunk = ends.find((e) => e.k === 'naval.sunk' && e.target.id === qid);
    assert.ok(sunk, 'the quarry goes down');
    assert.equal(sunk.target.quarry, 'bounty:test');
    assert.equal(sunk.vessel, vA.id);
    assert.equal(sunk.player?.id, a.id);
    assert.ok(typeof sunk.target.uid === 'string' && sunk.target.uid !== qid && Number.isFinite(sunk.target.x));
    tick(2000);
    assert.equal(N().spawnQuarry({ key: 'bounty:test', classId: 'pirateSloop', x: vA.x, z: vA.z }), null, 'a sunk quarry never returns');
    // a navy patrol engages a player only when the admiralty says so
    world.ctx.services.admiralty = { hostileTo: (p) => p.id === a.id };
    const nav2 = N().spawn('navyCutter', vA.x + 400, vA.z, 0);
    tick(600);
    assert.equal(N().record(nav2).ai.mode, 'engage', 'admiralty hostility sends the navy in');
    world.ctx.services.admiralty = { hostileTo: () => false };
    N().despawn(nav2);
    const nav3 = N().spawn('navyCutter', vA.x + 400, vA.z, 0);
    tick(600);
    assert.notEqual(N().record(nav3).ai.mode, 'engage');
    N().despawn(nav3);
    delete world.ctx.services.admiralty;

    // An owner ashore with her ship berthed cannot fight and gets no sea-only battle state.
    const d = world.connect('naval-d', 'Dagny');
    d.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    must(d, 'fixture.deed', { type: 'small' });
    must(d, 'sailing.board');
    must(d, 'sailing.leave');
    assert.ok(world.ctx.services.sailing.vesselFor(d.player), 'vesselFor still names her docked ship');
    assert.equal(world.ctx.services.sailing.aboard(d.player), null);
    const dm = d.mark();
    const r = d.act('naval.fire', { side: 'starboard' });
    assert.equal(r.ok, false);
    assert.match(r.error, /not aboard/);
    assert.equal(d.act('naval.colours', { hostile: true }).ok, false);
    tick(2000);
    assert.equal(d.since(dm, 'gameEvent').filter((x) => /^naval\./.test(x.event.kind)).length, 0, 'no naval events ashore');
  });

  test('the shipyard record supplies shot, takes the hull and sail damage and loses the hands', async (t) => {
    const fx = await fixtureWorld(t, {}, { yard: true });
    const { world, N, tick, must } = fx;
    const a = await captain(fx, 'naval-y', 'Ysolda', 'small', { x: 1000, z: 6000, yaw: 0 });
    const S = world.ctx.services;
    const v = S.sailing.aboard(a.player);
    const link = S.shipyard.shipOfVessel(v);
    assert.ok(link, 'the classic deed sails as a shipyard ship');
    const ship = () => S.shipyard.ship(link.player, link.shipId);
    const shot0 = ship().stores.shot, hull0 = ship().hullHp, crew0 = ship().crew.length;
    must(a, 'naval.sync');
    const self = a.events('naval.state').at(-1).self;
    assert.equal(self.ammo.shot, shot0, 'naval.state reports the shipyard\'s shot');
    assert.equal(self.maxCrew, S.shipyard.stats(link.player, link.shipId).crewMax);
    const guns = self.guns.starboard.count;
    must(a, 'naval.fire', { side: 'starboard' });
    assert.equal(ship().stores.shot, shot0 - guns, 'one shot per gun from the shipyard stores');
    assert.equal(N().inCombat(a.player, link.shipId), true, 'firing puts her in combat for the yard');
    assert.equal(N().inCombat(a.player, 'sh-other'), false);
    // a raider with grape rakes her: the yard's hull and hands go down with the vessel's
    const pid = N().spawn('pirateBrig', 1130, 6000, 0);
    N().record(pid).deck.loads.broadside = 'grape';
    tick(15_000);
    assert.ok(ship().hullHp < hull0 || ship().crew.length < crew0 || ship().sailHp < S.shipyard.stats(link.player, link.shipId).sailMax, 'shipyard record took the harm');
    assert.equal(v.naval.d.crew, ship().crew.length, 'naval crew is the shipyard\'s hands');
    // the carpenter mends with the shipyard's timber; shot is bought at the yard, not through naval.restock
    must(a, 'fixture.hull', { hp: 100 });
    const timber0 = ship().stores.timber;
    assert.ok(timber0 > 0, 'the deed came with carpenter\'s stores');
    must(a, 'naval.repair');
    assert.equal(ship().stores.timber, timber0 - 1);
    assert.equal(v.hull.hp, 125, 'the vessel\'s hull is mended too');
    assert.match(a.act('naval.restock', {}).error, /shipwright|port/);
    // empty lockers: no fire
    S.shipyard.spend(link.player, link.shipId, { shot: 9999 });
    tick(10_000);
    const r = a.act('naval.fire', { side: 'port' });
    assert.equal(r.ok, false);
    assert.match(r.error, /shot locker is empty/);
  });

  test('with the shipyard, a wrecked captain loses trade goods once and never her private item hold', async (t) => {
    const fx = await fixtureWorld(t, {}, { yard: true });
    const { world, N, tick, must } = fx;
    const S = world.ctx.services;
    const a = await captain(fx, 'naval-g1', 'Gareth', 'large', { x: 1000, z: 6000, yaw: 0 });
    const b = await captain(fx, 'naval-g2', 'Helga', 'small', { x: 1000, z: 5920, yaw: Math.PI / 2 });
    const vA = S.sailing.aboard(a.player), vB = S.sailing.aboard(b.player);
    const la = S.shipyard.shipOfVessel(vA), lb = S.shipyard.shipOfVessel(vB);
    S.shipyard.addCargo(lb.player, lb.shipId, [{ good: 'spices', qty: 6 }, { good: 'grain', qty: 20 }]);
    must(b, 'fixture.hold', { items: [['ruby', 3]] });
    const units = (l) => S.shipyard.ship(l.player, l.shipId).cargo.reduce((n, c) => n + c.qty, 0);
    const a0 = units(la), b0 = units(lb);
    must(a, 'naval.colours', { hostile: true });
    must(b, 'naval.colours', { hostile: true });
    must(b, 'fixture.hull', { hp: 2 });
    must(a, 'naval.fire', { side: 'bow', targetId: vB.id });
    tick(4000);
    assert.ok(vB.sunk, 'she is wrecked and towed to port');
    must(a, 'naval.plunder', { targetId: vB.id });
    const moved = units(la) - a0;
    assert.ok(moved > 0 && moved <= 8, `moved ${moved} units`);
    assert.equal(b0 - units(lb), moved, 'no goods made or lost');
    assert.deepEqual(b.player.rpg.property.stores.ship.map((i) => [i.template, i.quantity]), [['ruby', 3]], 'her private item hold is untouched');
    assert.equal(a.act('naval.plunder', { targetId: vB.id }).ok, false, 'once');
  });

  test('the director places NPC ships only on charted water and clears them when no ship is near', async (t) => {
    const fx = await fixtureWorld(t, { spawn: true, rollS: 1, spawnChance: 1, maxNear: 2 });
    const { world, N, tick } = fx;
    const a = await captain(fx, 'naval-dir', 'Ione', 'small', { x: 1000, z: 6000, yaw: 0 });
    const S = world.ctx.services;
    const real = S.sailing.isWater;
    S.sailing.isWater = () => null; // the chart still loading
    tick(3000);
    assert.equal(N().stats().npcs, 0, 'nothing is placed on an unknown chart');
    S.sailing.isWater = real;
    tick(3000);
    const n = N().stats().npcs;
    assert.ok(n >= 1 && n <= 2, `ships sighted (${n}), never more than maxNear`);
    assert.ok(a.events('naval.news').some((e) => e.what === 'sighted'));
    for (const r of N().actors()) { const d = Math.hypot(r.x - 1000, r.z - 6000); assert.ok(d >= R.SPAWN_CLEAR - 1 && d <= R.DESPAWN_BEYOND, `spawned ${Math.round(d)} m off`); }
    // she sails far away: every NPC beyond 1900 m is cleared
    world.ctx.services.naval.record(S.sailing.aboard(a.player).id);
    a.act('fixture.place', { x: 50_000, z: 6000, yaw: 0 });
    S.sailing.isWater = () => false; // and no new ones are placed on land
    tick(1500);
    assert.equal(N().stats().npcs, 0);
    S.sailing.isWater = real;
  });

  test('merchants follow the chart\'s sea lane; a core collision is a ram once', async (t) => {
    const fx = await fixtureWorld(t);
    const { world, N, tick } = fx;
    const a = await captain(fx, 'naval-lane', 'Jory', 'small', { x: 3000, z: 6000, yaw: 0 });
    const asked = [];
    const lane = [{ x: 1000, z: 1000 }, { x: 2500, z: 3000 }, { x: 6000, z: 3200 }, { x: 9000, z: 1000 }];
    coast.route = (from, to) => { asked.push([from, to]); return { points: lane }; };
    t.after(() => { delete coast.route; });
    const mid = N().spawn('merchantGalleon', 1100, 1500, 0);
    tick(1000);
    const m = N().record(mid);
    assert.ok(asked.some(([f, to]) => f === PORT_A && to === 'town:Wayrest/Wayrest'), 'she asks the chart for her lane');
    assert.deepEqual([m.ai.waypoint.x, m.ai.waypoint.z], [2500, 3000], 'she steers for the lane\'s next point, not straight at the port');
    N().despawn(mid);
    // the sailing core stops a vessel short of a pirate: counted as one ram, then the cooldown
    const vA = world.ctx.services.sailing.aboard(a.player);
    const pid = N().spawn('pirateSloop', vA.x + 15, vA.z, 0);
    const p0 = N().record(pid).d.hull;
    const mark = a.mark();
    world.ctx.emit('sailingCollision', { vessel: vA, other: { id: pid }, speed: 6 });
    world.ctx.emit('sailingCollision', { vessel: vA, other: { id: pid }, speed: 6 });
    assert.ok(N().record(pid).d.hull < p0, 'the pirate takes the ram');
    assert.equal(a.since(mark, 'gameEvent').filter((x) => x.event.kind === 'naval.ram').length, 1, 'once per cooldown');
    assert.equal(N().actors().find((r) => r.id === pid).type, 'small', 'NPC rows carry a deck type the core sizes obstacles by');
  });

  test('a vessel\'s combat state survives a restart', async (t) => {
    const fx = await fixtureWorld(t);
    const { world, must } = fx;
    const a = await captain(fx, 'naval-p', 'Perrin', 'small', { x: 1000, z: 6000, yaw: 0 });
    must(a, 'naval.load', { group: 'broadside', shot: 'chain' });
    must(a, 'naval.colours', { hostile: true });
    must(a, 'fixture.hull', { hp: 200 });
    world.tick(40);
    must(a, 'naval.sync');
    const before = a.events('naval.state').at(-1).self;
    assert.equal(before.hullHp, 200);
    world.restart();
    const a2 = world.connect('naval-p', 'Perrin');
    world.tick(40);
    must(a2, 'naval.sync');
    const after = a2.events('naval.state').at(-1).self;
    assert.equal(after.hullHp, 200);
    assert.equal(after.loads.broadside, 'chain');
    assert.equal(after.colours, 'hostile');
  });
});

// ------------------------------------------------------------------ 3. live sockets: two captains

class Client {
  constructor(port, cookie) {
    this.messages = [];
    this.waiters = [];
    this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    this.opened = new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    this.closed = new Promise((resolve) => this.ws.on('close', resolve));
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  next(pred, timeout = 6000, what = 'message') {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeout);
      this.waiters.push((msg) => { if (!pred(msg)) return false; clearTimeout(t); resolve(msg); return true; });
    });
  }
  async join(name) {
    await this.opened;
    const w = this.next((m) => m.type === 'welcome' || m.type === 'error', 6000, 'welcome');
    this.send({ type: 'join', name, account: true });
    const msg = await w;
    if (msg.type !== 'welcome') throw new Error(msg.message);
    this.id = msg.id;
    return msg;
  }
  async act(verb, args = {}) {
    const seq = ++this.seq;
    const w = this.next((m) => m.type === 'actionResult' && m.seq === seq, 6000, `result of ${verb}`);
    this.send({ type: 'action', seq, verb, args });
    return w;
  }
  async must(verb, args = {}) { const r = await this.act(verb, args); if (!r.ok) throw new Error(`${verb}: ${r.error}`); return r; }
  events(kind) { return this.messages.filter((m) => m.type === 'gameEvent' && m.event.kind === kind).map((m) => m.event); }
  event(kind, pred = () => true, timeout = 6000) { return this.next((m) => m.type === 'gameEvent' && m.event.kind === kind && pred(m.event), timeout, kind).then((m) => m.event); }
  close() { this.ws.close(); return this.closed; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('live: two captains share one sea fight; peaceful colours and harbours refuse; a wreck\'s hold goes once to her killer', needsData, async () => {
  const tmp = mkdtempSync('/var/tmp/dfw-naval-ws-');
  for (const d of ['client', 'site']) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, 'client', 'play.html'), '<!doctype html><title>play</title>');
  const live = await startLiveWorld({ dir: tmp, features: FEATURES({}), arena2Dir: arena2 });
  try {
    const jars = {};
    for (const n of ['anselm', 'brisienna']) {
      jars[n] = await accountSession(live.base, n);
      assert.ok(jars[n].cookie, `account ${n}: ${jars[n].status}`);
    }
    const a = new Client(live.port, jars.anselm.cookie), b = new Client(live.port, jars.brisienna.cookie);
    await a.join('anselm');
    await b.join('brisienna');
    for (const c of [a, b]) await c.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    await a.must('fixture.deed', { type: 'large' });
    await b.must('fixture.deed', { type: 'small' });
    for (const c of [a, b]) { await c.must('sailing.board'); await c.must('sailing.launch'); }

    // In harbour: no player fire.
    await b.must('fixture.place', { x: 1100, z: 1000, yaw: 0 });
    await a.must('naval.colours', { hostile: true });
    await b.must('naval.colours', { hostile: true });
    const harbour = await a.act('naval.fire', { side: 'starboard', targetId: `v${b.id}` });
    assert.equal(harbour.ok, false);
    assert.match(harbour.error, /harbour/);

    // Out at sea, Brisienna 120 m off Anselm's starboard beam. Peaceful colours: the gunner is refused.
    await a.must('fixture.place', { x: 1000, z: 6000, yaw: 0 });
    await b.must('fixture.place', { x: 1120, z: 6000, yaw: 0 });
    await b.must('naval.colours', { hostile: false });
    const peace = await a.act('naval.fire', { side: 'starboard', targetId: `v${b.id}` });
    assert.equal(peace.ok, false);
    assert.match(peace.error, /peaceful colours/);
    // Fired blind at her anyway, the balls pass her planks harmlessly.
    const hullB0 = (await (async () => { await b.must('naval.sync'); return (await b.event('naval.state')).self.hullHp; })());
    const blind = b.event('naval.shot');
    await a.must('naval.fire', { side: 'starboard' });
    const seenB = await blind;
    await sleep(2500);
    assert.equal(b.events('naval.hit').filter((h) => h.target?.id === `v${b.id}`).length, 0, 'no harm to a peaceful captain');
    assert.equal(seenB.from.id, `v${a.id}`, 'she still sees the volley');

    // Both fighting colours: Anselm's port battery into Brisienna on his port beam.
    await b.must('naval.colours', { hostile: true });
    await b.must('fixture.place', { x: 880, z: 6000, yaw: 0 });
    const shotA = a.event('naval.shot', (e) => e.side === 'port');
    const shotB = b.event('naval.shot', (e) => e.side === 'port');
    await a.must('naval.fire', { side: 'port', targetId: `v${b.id}` });
    const [sa, sb] = await Promise.all([shotA, shotB]);
    assert.equal(sa.volleyId, sb.volleyId);
    assert.deepEqual(sa.balls, sb.balls, 'both accounts fly the identical balls');
    await sleep(3000);
    const hitsA = a.events('naval.hit').filter((h) => h.volleyId === sa.volleyId && h.target?.id === `v${b.id}`);
    const hitsB = b.events('naval.hit').filter((h) => h.volleyId === sa.volleyId && h.target?.id === `v${b.id}`);
    assert.ok(hitsA.length > 0, 'the broadside strikes her');
    assert.deepEqual(hitsA.map((h) => h.ballId), hitsB.map((h) => h.ballId), 'both see the same hits');
    await b.must('naval.sync');
    const hullB1 = (await b.event('naval.state', (e) => e.self?.hullHp < hullB0)).self.hullHp;
    assert.ok(hullB1 < hullB0, `her hull ${hullB0} -> ${hullB1}`);
    // persisted in the vessel's world row
    await sleep(300);
    const db = new DatabaseSync(join(tmp, 'world.db'), { readOnly: true });
    const row = JSON.parse(db.prepare('SELECT value FROM world_state WHERE key = ?').get(`sailing:vessel:v${b.id}`).value);
    db.close();
    assert.ok(row.hull.hp <= hullB0 && row.naval?.d, 'the vessel row carries her damage');

    // Brisienna's hold, then her ship is battered under and wrecked by Anselm's bow chasers.
    await b.must('fixture.hold', { items: [['ruby', 3], ['iron-longsword', 1], ['jade', 2], ['diamond', 1]] });
    await b.must('fixture.place', { x: 1000, z: 5920, yaw: Math.PI / 2 });
    await b.must('fixture.hull', { hp: 2 });
    const sinking = a.event('naval.news', (e) => e.what === 'sinking' && e.shipId === `v${b.id}`, 8000);
    await a.must('naval.fire', { side: 'bow', targetId: `v${b.id}` });
    await sinking;
    await b.event('naval.news', (e) => e.what === 'respawn', 8000);
    await sleep(300);
    // Her holdings before the prize, and Anselm's.
    const fresh = async (c) => { await c.must('naval.sync'); await sleep(150); return c.messages.filter((m) => m.type === 'rpg').at(-1).character; };
    const holdB0 = (await fresh(b)).property?.stores?.ship ?? [];
    const holdA0 = (await fresh(a)).property?.stores?.ship ?? [];
    assert.equal(holdB0.length, 4);
    const prize = await a.act('naval.plunder', { targetId: `v${b.id}` });
    assert.ok(prize.ok, prize.error);
    const lostMsg = await b.event('naval', (e) => Array.isArray(e.lost));
    const again = await a.act('naval.plunder', { targetId: `v${b.id}` });
    assert.equal(again.ok, false, 'a wreck is plundered once');
    const holdB1 = (await fresh(b)).property?.stores?.ship ?? [];
    const holdA1 = (await fresh(a)).property?.stores?.ship ?? [];
    const count = (list) => list.reduce((n, i) => n + i.quantity, 0);
    assert.equal(count(holdA1) - count(holdA0), count(holdB0) - count(holdB1), 'what she lost is exactly what he gained');
    assert.ok(holdB1.length >= 1 && holdB1.length < 4, 'a third of her hold\'s worth, never all of it');
    const worth = (i) => (Number(i.price) || 0) * i.quantity;
    const best = holdB0.reduce((m, i) => (worth(i) > worth(m) ? i : m), holdB0[0]);
    assert.ok(holdA1.some((i) => i.template === best.template), `her best piece first (${best.template})`);
    assert.ok(lostMsg.lost.length === holdA1.length - holdA0.length);
    // No naval event ever carried another captain's hold.
    for (const m of [...a.messages, ...b.messages]) if (m.type === 'gameEvent' && /^naval\./.test(m.event.kind)) assert.ok(!JSON.stringify(m.event).includes('"stores"'));
    await Promise.all([a.close(), b.close()]);
  } finally {
    await live.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
