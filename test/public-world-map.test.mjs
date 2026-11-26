// Public website map (server/public-world-map.js, website/app/map/): the projection and the
// real HTTP route on the game server with two real WebSocket clients.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { publicMapLocation, publicWorldMap, publicWorldPois, PUBLIC_MAP_PATH, PUBLIC_MAP_POIS_PATH } from '../server/public-world-map.js';
import { Catalog } from '../client/gameplay/travel/catalog.js';
import { discoverFeatures, startLiveWorld, accountSession, LiveClient, tempDir, localArena2, withWorldClock } from './support/rpg-session.mjs';
import { walkingRoute } from './support/walking-route.mjs';
import { BUILDING } from '../server/rpg/npcs/people.js';

const GOTHWAY = 'town:Daggerfall/Gothway Garden';
const DAGGERFALL = 'town:Daggerfall/Daggerfall';
const ARENA2 = localArena2();

// Two records with one name in one region, as in MAPS.BSA (Alik'r Desert's two Djen Lodges).
const twins = new Catalog([
  { region: "Alik'r Desert", regionIndex: 0, index: 4, name: 'Djen Lodge', type: 'temple', x: 310, y: 435 },
  { region: "Alik'r Desert", regionIndex: 0, index: 9, name: 'Djen Lodge', type: 'temple', x: 319, y: 483 },
  { region: 'Daggerfall', regionIndex: 17, index: 197, name: 'Gothway Garden', type: 'hamlet', x: 109, y: 159 },
], 'files');
const lookup = (id) => twins.get(id);

describe('projection', () => {
  test('duplicate names resolve through stable catalogue records', () => {
    const first = publicMapLocation({ location: "town:Alik'r Desert/Djen Lodge" }, lookup);
    const second = publicMapLocation({ location: 'town:0/9' }, lookup);
    assert.deepEqual([first.x, first.y, first.id], [310, 435, "town:Alik'r Desert/Djen Lodge"]);
    assert.deepEqual([second.x, second.y, second.id], [319, 483, 'town:0/9']);
    // An instance inside the second lodge is shown at the second lodge's exterior.
    const inside = publicMapLocation({ location: 'interior:0/9/0,0/2' }, lookup);
    assert.deepEqual([inside.x, inside.y, inside.inside], [319, 483, true]);
  });

  test('indoor players appear at their entrance; wilderness uses the occupied pixel', () => {
    const portal = { to: 'interior:Daggerfall/Gothway Garden/1,2/3', from: GOTHWAY, label: 'The private name of a door', returnTo: { location: GOTHWAY, x: 1, z: 2 } };
    const a = publicMapLocation({ location: portal.to, portal }, lookup);
    assert.deepEqual(a, { id: GOTHWAY, kind: 'town', x: 109, y: 159, name: 'Gothway Garden', region: 'Daggerfall', inside: true });
    // A dungeon entered from the wilderness returns to that pixel.
    const cave = { to: 'dungeon:0/9', from: 'wilderness:120,170', returnTo: { location: 'wilderness:120,170' } };
    assert.equal(publicMapLocation({ location: 'dungeon:0/9', portal: cave }, lookup).id, 'wilderness:120,170');
    // A stale portal record for another instance is ignored in favour of the address.
    assert.equal(publicMapLocation({ location: 'dungeon:0/9', portal: { ...cave, to: 'dungeon:0/4' } }, lookup).id, 'town:0/9');
    assert.deepEqual(publicMapLocation({ location: 'wilderness:5,6' }, lookup), { id: 'wilderness:5,6', kind: 'wilderness', x: 5, y: 6, name: 'Wilderness', region: null, inside: false });
    // Legacy building address.
    assert.equal(publicMapLocation({ location: 'building:Daggerfall/Gothway Garden/b:1,2:3' }, lookup).id, GOTHWAY);
  });

  test('without the operator catalogue the starter towns still resolve; unknowns are not guessed', () => {
    assert.equal(publicMapLocation({ location: DAGGERFALL }, () => null).name, 'Daggerfall');
    assert.equal(publicMapLocation({ location: DAGGERFALL }, () => { throw new Error('loading'); }).name, 'Daggerfall');
    for (const location of ['town:Nowhere/Fabricated', 'wilderness:5000,1', 'quest:secret', 42, undefined]) {
      assert.equal(publicMapLocation({ location }, lookup), null, String(location));
    }
  });

  test('aggregates by pixel, counts unplaced sessions and publishes nothing private', () => {
    const players = [
      { id: 'p1', accountId: 7, name: 'Aldora', rpg: { location: GOTHWAY, character: { gold: 999 }, quests: { active: ['K0C00Y08'] } } },
      { id: 'p2', accountId: 8, name: 'Brannoc', rpg: { location: 'interior:Daggerfall/Gothway Garden/1,2/3' } },
      { id: 'p3', name: 'Cassia', rpg: { location: 'wilderness:109,159' } }, // same pixel as the town
      { id: 'p4', name: 'Dorran', rpg: { location: 'town:0/9' } },
      { id: 'p5', name: 'Eskel', rpg: { location: 'town:Nowhere/Fabricated' } },
      { id: 'p6', name: 'Fen' },
      { id: 'joining', arriving: true, rpg: { location: GOTHWAY } },
    ];
    const map = publicWorldMap(players, lookup, Date.UTC(2026, 10, 24));
    assert.equal(map.online, 6);
    assert.equal(map.unplaced, 2);
    assert.equal(map.generatedAt, '2026-11-24T00:00:00.000Z');
    assert.deepEqual(map.locations, [
      { id: GOTHWAY, kind: 'town', name: 'Gothway Garden', region: 'Daggerfall', x: 109, y: 159, count: 3, inside: 1 },
      { id: 'town:0/9', kind: 'town', name: 'Djen Lodge', region: "Alik'r Desert", x: 319, y: 483, count: 1, inside: 0 },
    ]);
    const text = JSON.stringify(map);
    for (const secret of ['Aldora', 'Brannoc', 'accountId', '999', 'K0C00Y08', 'p1', 'private name']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual(publicWorldMap([], lookup).locations, []);
  });

  test('the installed catalogue separates the two Djen Lodges', { skip: !ARENA2 && 'no local ARENA2' }, async () => {
    const { loadWorldFromDir } = await import('../server/rpg/travel/data.js');
    const { catalog } = await loadWorldFromDir(ARENA2);
    const lodges = catalog.search('Djen Lodge', { limit: 10 }).filter((l) => l.region === "Alik'r Desert");
    assert.equal(lodges.length, 2);
    const shown = lodges.map((l) => publicMapLocation({ location: l.id }, (id) => catalog.get(id)));
    assert.deepEqual(shown.map((s) => [s.x, s.y]).sort((a, b) => a[0] - b[0]), [[310, 435], [319, 483]]);
    assert.notEqual(shown[0].id, shown[1].id);
  });

  test('a crew on deck and in a cabin shares one anonymous sea pixel', () => {
    const crew = [{ rpg: { location: 'town:31/2' } }, { rpg: { location: 'interior:31/2/0,0/0' } }];
    const vessel = { id: 'private-vessel', ownerId: 9, x: 215.25 * 819.2, z: 245.75 * 819.2 };
    const map = publicWorldMap(crew, lookup, 0, { aboard: () => vessel });
    assert.deepEqual(map.locations, [{ id: 'sea:215,245', kind: 'sea', name: 'Iliac Bay', region: null, x: 215, y: 245, count: 2, inside: 1 }]);
    assert.equal(map.unplaced, 0);
    assert.equal(map.vessels, 1);
  });

  test('publishes optional Tamrielic worldTime and wilderness region without leaking private fields', () => {
    const players = [{ id: 'p1', name: 'SecretName', rpg: { location: 'wilderness:109,159' } }];
    const map = publicWorldMap(players, lookup, 0, null, {
      regionOf: () => 'Daggerfall',
      worldClock: () => ({ minutes: 523530 }),
    });
    assert.equal(map.locations[0].region, 'Daggerfall');
    assert.equal(map.vessels, 0);
    assert.equal(map.worldTime.year, 405);
    assert.equal(map.worldTime.monthName, 'Morning Star');
    assert.equal(map.worldTime.timeLabel, '13:30');
    assert.ok(!JSON.stringify(map).includes('SecretName'));
  });

  test('publicWorldPois exports compact public tuples and skips ships', () => {
    const gaz = publicWorldPois({
      source: 'files',
      locations: [
        { id: GOTHWAY, region: 'Daggerfall', regionIndex: 17, index: 197, name: 'Gothway Garden', type: 'hamlet', x: 109, y: 159 },
        { id: 'town:Daggerfall/Ship', region: 'Daggerfall', regionIndex: 17, index: 999, name: 'Ship', type: 'ships', x: 207, y: 213 },
      ],
    });
    assert.equal(gaz.source, 'files');
    assert.equal(gaz.pois.length, 1);
    assert.deepEqual(gaz.pois[0], [17, 'Gothway Garden', gaz.types.indexOf('hamlet'), 109, 159, GOTHWAY]);
  });
});

// ---- live: the real game server, accounts and two sockets ---------------------------------------

const discovered = await discoverFeatures();

describe('live HTTP route with two connected clients', () => {
  let tmp, world;
  const clients = new Set();
  const open = async (jar) => {
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    clients.add(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    c.welcome = await c.next((m) => m.type === 'welcome' || m.type === 'error', 'welcome');
    assert.equal(c.welcome.type, 'welcome', c.welcome.message);
    await c.stateWhere(() => true, 'first snapshot');
    return c;
  };
  const map = async () => {
    const res = await fetch(world.base + PUBLIC_MAP_PATH);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /application\/json/);
    return res.json();
  };
  /** Polls the public endpoint until it satisfies `pred` (the server applies changes on its tick). */
  const mapWhere = async (pred, what) => {
    let last;
    for (let i = 0; i < 100; i++) {
      last = await map();
      if (pred(last)) return last;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`${what}: ${JSON.stringify(last)}`);
  };
  const at = (m, id) => m.locations.find((l) => l.id === id);

  before(async () => {
    tmp = tempDir('dfw-public-map-');
    const features = withWorldClock(discovered.features, { epochMs: Date.now() });
    world = await startLiveWorld({ dir: tmp.dir, features, ...(ARENA2 ? { arena2Dir: ARENA2 } : {}) });
  });
  after(async () => {
    try {
      await Promise.all([...clients].map((c) => c.close()));
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  test('join, travel, enter a building, disconnect', async (t) => {
    let m = await map();
    assert.deepEqual([m.online, m.unplaced, m.locations], [0, 0, []], 'empty world');
    const head = await fetch(world.base + PUBLIC_MAP_PATH, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(world.base + PUBLIC_MAP_PATH, { method: 'POST' })).status, 405);

    const jarA = await accountSession(world.base, 'mapaldora');
    const jarB = await accountSession(world.base, 'mapbrannoc');
    const a = await open(jarA);
    const b = await open(jarB);
    m = await mapWhere((x) => x.online === 2, 'two joined');
    assert.deepEqual(m.locations, [{ id: GOTHWAY, kind: 'town', name: 'Gothway Garden', region: 'Daggerfall', x: 109, y: 159, count: 2, inside: 0 }]);
    const text = JSON.stringify(m);
    for (const secret of ['mapaldora', 'mapbrannoc', 'account', 'character', 'quest']) assert.ok(!text.includes(secret), secret);

    const travel = world.server.runtime.ctx.services.travel;
    for (let i = 0; i < 400 && travel.source === 'loading'; i++) await new Promise((r) => setTimeout(r, 25));
    const r = await b.act('travel.go', { to: DAGGERFALL });
    assert.equal(r.ok, true, r.error);
    m = await mapWhere((x) => x.locations.length === 2, 'travel separates the markers');
    assert.deepEqual(m.locations.map((l) => [l.name, l.x, l.y, l.count]), [['Daggerfall', 207, 213, 1], ['Gothway Garden', 109, 159, 1]]);

    await t.test('entering a building keeps the player at its exterior', { skip: !ARENA2 && 'no local ARENA2' }, async () => {
      const services = world.server.runtime.ctx.services;
      await services.interiors.ready;
      await services.interiors.survey(GOTHWAY);
      await services.collision.whenSettled(GOTHWAY);
      const city = services.collision.instanceWorld(GOTHWAY);
      const me = a.messages.filter((x) => x.type === 'state').at(-1)?.players?.find((p) => p.id === a.state.selfId);
      assert.ok(me, 'received the outdoor position');
      const start = { ...me, y: city.standHeight(me.x, me.z) };
      const doors = services.portals.at(GOTHWAY).filter((p) => p.meta?.buildingType === BUILDING.Tavern)
        .flatMap((p) => p.entrances.map((e) => ({ p, e, d: Math.hypot(e.x - me.x, e.z - me.z) })))
        .sort((x, y) => x.d - y.d);
      // Use a public inn and its clear street landing. The player walks around obstacles over the socket.
      let route, entered;
      for (const { p, e } of doors) {
        route = walkingRoute(city, start, e.exit, 0.6, false);
        if (route) { entered = p; break; }
      }
      assert.ok(entered, 'a public inn has a reachable street door');
      for (const at of route) assert.ok(await walkTo(a, at.x, at.z, 0.45), 'walked to the next waypoint');
      const entry = await a.act('portal.use', { portalId: entered.id });
      assert.equal(entry.ok, true, entry.error);
      const inside = await mapWhere((x) => at(x, GOTHWAY)?.inside === 1, 'indoor player at the entrance');
      assert.equal(at(inside, GOTHWAY).count, 1);
      assert.ok(!JSON.stringify(inside).includes(entered.to), 'instance address is private');
      assert.ok(!JSON.stringify(inside).includes(entered.label ?? '\u0000'), 'door label is private');
    });

    await b.close();
    m = await mapWhere((x) => x.online === 1, 'B disconnected');
    assert.equal(at(m, DAGGERFALL), undefined, 'last player left Daggerfall');
    assert.equal(at(m, GOTHWAY).count, 1);
    await a.close();
    m = await mapWhere((x) => x.online === 0, 'A disconnected');
    assert.deepEqual(m.locations, []);
  });
});

/** Walks with real input; resolves false when the route is blocked. */
async function walkTo(c, x, z, reach) {
  let best = Infinity, stuck = 0;
  for (let i = 0; i < 400; i++) {
    const me = c.messages.filter((m) => m.type === 'state').at(-1)?.players?.find((p) => p.id === c.state?.selfId);
    const pos = me ?? { x: 0, z: 0 };
    const d = Math.hypot(x - pos.x, z - pos.z);
    const yaw = Math.atan2(x - pos.x, -(z - pos.z));
    if (me && d <= reach) {
      c.send({ type: 'input', forward: 0, strafe: 0, yaw });
      return true;
    }
    if (d < best - 0.05) { best = d; stuck = 0; } else if (++stuck > 40) {
      c.send({ type: 'input', forward: 0, strafe: 0, yaw });
      return false;
    }
    c.send({ type: 'input', forward: 1, strafe: 0, yaw });
    c.cursor = c.messages.length;
    await c.next((m) => m.type === 'state', 'movement snapshot');
  }
  return false;
}
