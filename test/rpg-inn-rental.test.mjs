import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/db.js';
import { features } from '../server/rpg/features.js';
import { arena2Loader } from '../server/rpg/collision/arena2.js';
import { buildingAccess } from '../server/rpg/townServices/access.js';
import { arena2Dir } from '../tools/world-audit/sources.mjs';
import { accountSession, LiveClient, startLiveWorld, STRICT, tempDir } from './support/rpg-session.mjs';

const data = arena2Dir();
const installed = { skip: !data && !STRICT };
const town = 'town:Daggerfall/Blackidge Hamlet';
const innId = 'interior:Daggerfall/Blackidge Hamlet/0,0/10';

test('closed public doors honor the exact character’s hall, property or quest permission', () => {
  let minutes = 23 * 60, magic;
  const player = { id: 1 }, stranger = { id: 2 }, notices = [];
  const doors = [3, 9, 11, 14, 15, 16, 18, 19].map(type => ({
    kind: 'building', label: `Building ${type}`, to: `interior:${type}`, meta: { buildingType: type, quality: 16 },
  }));
  const [bank, shop, hall, temple, inn, palace, privateHall, quest] = doors;
  privateHall.meta.factionId = 34;
  const services = {
    worldClock: () => ({ minutes }),
    guildHallAccess: (p, door) => p === player && (door === hall || door === privateHall),
    ownsBuilding: (p, door) => p === player && door === palace,
    quests: { active: p => p === player ? [{ places: { home: { interior: quest.to } } }] : [] },
    takeDoorMagic(p, operation) {
      if (operation !== 'open') return null;
      const queued = magic;
      magic = null;
      return queued;
    },
    law: { openDoor: (p, door, how) => notices.push({ p, door, how }) },
  };
  const access = buildingAccess({ services, notify: (p, event) => notices.push(event) });
  assert.match(access.lockedReason(player, bank), /opens at 08:00/);
  assert.match(access.lockedReason(player, shop), /opens at 06:00/);
  for (const door of [hall, temple, inn, palace, privateHall, quest]) assert.equal(access.entry(player, door), true);
  for (const door of [hall, palace, privateHall, quest]) assert.throws(() => access.entry(stranger, door), /locked/);
  magic = { operation: 'open', level: 7 };
  assert.equal(access.entry(player, shop), false);
  assert.match(notices.pop().text, /fails to open/);
  assert.throws(() => access.entry(player, shop), /locked/);
  magic = { operation: 'open', level: 8 };
  assert.equal(access.entry(player, shop), true);
  assert.deepEqual(notices.pop(), { p: player, door: shop, how: 'spell' });
  minutes = (200 - 1) * 1440 + 12 * 60;
  assert.throws(() => access.entry(player, shop), /Sun’s Rest/);
  assert.equal(access.entry(player, bank), true);
});

test('the same native city gate blocks movement at 18:00 and reopens at 06:00', installed, async () => {
  assert.ok(data);
  let minutes = 17 * 60 + 59;
  const load = arena2Loader(data, { worldClock: () => ({ minutes }) });
  const { world } = await load('town:Daggerfall/Daggerfall');
  const crosses = () => {
    const end = world.move(-212.8, 298.2, -212.8, 309.8, { y: 0 });
    return Math.abs(end.z - 309.8) < 0.01;
  };
  assert.ok(crosses(), 'the authored south gate is open before dusk');
  minutes++;
  assert.equal(crosses(), false, 'same collision world uses the closed model at dusk');
  minutes = 1440 + 6 * 60;
  assert.ok(crosses(), 'gate opens at dawn');
});

test('personal sleep releases a persistent booking on the shared inn ledger exactly once', { ...installed, timeout: 90_000 }, async t => {
  assert.ok(data);
  const tmp = tempDir('dfw-inn-rental-');
  let wall = 0, world;
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map(c => c.close()));
    await world?.close();
    tmp.remove();
  });
  const timed = features.map(f => f.name === 'atmosphere'
    ? { ...f, install: ctx => f.install(ctx, { epochMs: 0, wallNow: () => wall, restSecondsPerHour: 0.1 }) }
    : f);
  const boot = async () => {
    world = await startLiveWorld({ dir: tmp.dir, features: timed, arena2Dir: data });
    const services = world.server.runtime.ctx.services;
    await services.interiors.survey(town);
    return services;
  };
  let services = await boot();
  let inn = services.portals.into(innId);
  assert.equal(inn.label, 'The Rat and Scorpion');
  assert.equal(inn.meta.beds.length, 2);
  const users = [];
  for (const name of ['edrin', 'malarra', 'rodwyn']) {
    const registered = await accountSession(world.base, name);
    assert.equal(registered.status, 201);
    users.push(registered);
  }
  const store = openStore(world.dbPath);
  const ids = users.map(({ user }) => {
    const row = store.createForAccount(user.id, user.username);
    const { x, z, yaw } = inn.entrances[0].exit;
    store.saveCharacters([{ ...row, x, z, yaw, rpg: { location: town, gold: 100, character: { created: true } } }]);
    return row.id;
  });
  store.close();

  async function connect(i) {
    const jar = await accountSession(world.base, users[i].user.username, 'integration-pass-phrase', '/api/login');
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    clients.add(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    await c.next(m => m.type === 'welcome', 'account welcome');
    await c.stateWhere(m => m.selfId === ids[i], 'correct account character');
    return c;
  }
  async function action(c, verb, args = {}) {
    const r = await c.act(verb, args);
    assert.ok(r.ok, `${verb}: ${r.error}`);
  }
  const player = c => world.server.runtime.ctx.players.get(c.state.selfId);
  function checkpoint(c, spot) {
    const p = player(c);
    p.x = spot.x;
    p.z = spot.z;
    p.rpg.portal.footY = spot.y ?? 0;
    services.collision.resetBody(p);
  }
  async function keeper(c) {
    const s = await c.stateWhere(m => m.entities.some(e => e.role === 'innkeeper'), 'authored innkeeper');
    const npc = s.entities.find(e => e.role === 'innkeeper');
    checkpoint(c, npc);
    const mark = c.messages.length;
    await action(c, 'npc.talk', { targetId: npc.id });
    const dialogue = c.messages.slice(mark).find(m => m.event?.kind === 'dialogue')?.event;
    assert.ok(dialogue?.session);
    return { targetId: npc.id, session: dialogue.session, service: 'rest' };
  }
  async function enter(c) {
    await action(c, 'portal.use', { portalId: inn.id });
    await c.stateWhere(m => m.character.location === innId, 'inside the same inn');
    assert.equal((await services.collision.whenSettled(innId)).status, 'ready');
  }

  let a = await connect(0), b = await connect(1);
  await enter(a);
  const reply = await keeper(a);
  const purse = player(a).rpg.gold;
  await action(a, 'npc.service', { ...reply, days: 2, cost: 14 });
  const booked = player(a).rpg.tavern.rooms[innId];
  assert.equal(booked.bed, 1);
  assert.equal(player(a).rpg.gold, purse - 14);
  assert.match((await a.act('npc.service', { ...reply, days: 2, cost: 14 })).error, /booking has changed/i);
  assert.match((await a.act('rest.start', { hours: 1 })).error, /rented bed 1/i);
  const character = player(a).rpg.character;
  character.health -= 8;
  await action(a, 'npc.service', { ...reply, menuItem: 10, cost: 3 });
  assert.equal(character.health, character.maxHealth - 2);
  assert.match((await a.act('npc.service', { ...reply, menuItem: 0, cost: 1 })).error, /four hours/i);
  await action(a, 'npc.service', { ...reply, days: 1, cost: 7, rentalExpiresAt: booked.expiresAt });
  const extended = player(a).rpg.tavern.rooms[innId];
  assert.equal(extended.expiresAt, booked.expiresAt + 1440);
  assert.equal(player(a).rpg.gold, purse - 24);

  // Hard restart of the server. Both accounts and the shared bed ledger use the same temporary SQLite files.
  await Promise.all([...clients].map(c => c.close()));
  clients.clear();
  await world.close();
  wall += 6 * 60 * 5000;
  services = await boot();
  assert.equal(services.worldClock().hour, 19);
  inn = services.portals.into(innId);
  b = await connect(1);
  await enter(b);
  assert.match((await b.act('rest.start', { hours: 1 })).error, /need a current room rental/i);
  const c = await connect(2);
  await enter(c);
  const guest = await keeper(c);
  await action(c, 'npc.service', { ...guest, days: 1, cost: 7 });
  assert.equal(player(c).rpg.tavern.rooms[innId].bed, 2);
  checkpoint(c, inn.meta.beds[0]);
  assert.match((await c.act('rest.start', { hours: 1 })).error, /rented bed 2/i);
  const nextGuest = { ...(await keeper(b)), days: 1, cost: 7 };
  assert.match((await b.act('npc.service', nextGuest)).error, /all beds are taken/i);

  a = await connect(0);
  assert.deepEqual(player(a).rpg.tavern.rooms[innId], extended);
  checkpoint(a, inn.meta.beds[0]);
  const sharedTime = services.worldClock().minutes;
  const nextGuestTime = services.playerMinutes(player(b));
  const otherRental = player(c).rpg.tavern.rooms[innId];
  await action(a, 'rest.start', { hours: 99 });
  const ended = await a.next(m => m.event?.kind === 'rest' && m.event.reason === 'rentExpired', 'personal sleep until expiry', 20_000);
  assert.equal(ended.event.hoursDone, 66);
  assert.equal(services.worldClock().minutes, sharedTime);
  assert.equal(services.playerMinutes(player(b)), nextGuestTime);
  assert.deepEqual(player(c).rpg.tavern.rooms[innId], otherRental);
  assert.match((await a.act('rest.start', { hours: 1 })).error, /need a current room rental/i);
  const nextGuestPurse = player(b).rpg.gold;
  await action(b, 'npc.service', nextGuest);
  assert.equal(player(b).rpg.tavern.rooms[innId].bed, 1);
  assert.match((await b.act('npc.service', nextGuest)).error, /booking has changed/i);
  assert.equal(player(b).rpg.gold, nextGuestPurse - 7);

  checkpoint(c, inn.entrances[0].enter);
  await action(c, 'portal.leave');
  await c.stateWhere(m => m.character.location === town, 'back in the hamlet');
  await action(c, 'travel.go', { to: 'town:Daggerfall/Gothway Garden', options: { speed: 'reckless', lodging: 'camp', ship: 'land' } });
  assert.ok(services.playerMinutes(player(c)) - sharedTime >= 1440);
  assert.equal(player(c).rpg.tavern.rooms[innId], undefined);
  const reassigned = await keeper(a);
  await action(a, 'npc.service', { ...reassigned, days: 1, cost: 7 });
  assert.equal(player(a).rpg.tavern.rooms[innId].bed, 2);
});
