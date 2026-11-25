// Source-backed people (server/rpg/npcs/people.js, population.js, places.js): DFU placement, identity, services,
// work rolls, mobile population, active-location cache and legacy-id compatibility. The real-data section runs
// against the operator's ARENA2 when it is installed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  dfRandom, fullName, interiorPeople, exteriorPeople, dungeonPeople, servicesFor, regionFactions, effectiveFaction,
  presentAt, buildingKey, interiorQuestMarkers, isChild, SCALE, BLOCK_SIZE, RDB_SIDE,
} from '../server/rpg/npcs/people.js';
import { buildNavGrid, createPopulation, tileWeight, CELL, GUARD_TEXTURE } from '../server/rpg/npcs/population.js';
import { createPlaces } from '../server/rpg/npcs/places.js';
import { parseFactionText } from '../client/gameplay/npcs/factionFile.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as npcs from '../server/rpg/npcs.js';
import { rosterFor } from '../server/rpg/npcs/rules.js';

const FACTIONS = parseFactionText(`
#504
	type: 15
	name: People of Somewhere
	region: 18
	sgroup: 0
	ggroup: 4
#595
	type: 14
	name: Court of Somewhere
	region: 18
	sgroup: 3
	ggroup: 15
#510
	type: 2
	name: The Merchants
	sgroup: 1
	ggroup: 4
#364
	type: 4
	name: King Someone
	race: 3
	region: 18
	flat: 334 19
#851
	type: 3
	name: Fighter Questers
	sgroup: 0
	ggroup: 11
`);
const BANKS = [[['Al', 'Bo'], ['an', 'er'], ['Ce', 'Di'], ['la', 'na'], ['Ash', 'Oak'], ['by', 'ford']]];
const tables = { factions: FACTIONS, banks: BANKS, flatsCfg: null };

describe('DFU rules', () => {
  test('DFRandom is the classic LCG (srand(1) -> 16838, 5758, 10113)', () => {
    const r = dfRandom(1);
    assert.deepEqual([r.rand(), r.rand(), r.rand()], [16838, 5758, 10113]);
  });

  test('NameHelper: first = sets 0+1 (male) / 2+3 (female), surname = sets 4+5, all from one seed', () => {
    const a = fullName(BANKS, 0, false, dfRandom(1234));
    const b = fullName(BANKS, 0, false, dfRandom(1234));
    assert.equal(a, b, 'same seed, same name');
    assert.match(a, /^(Al|Bo)(an|er) (Ash|Oak)(by|ford)$/);
    assert.match(fullName(BANKS, 0, true, dfRandom(99)), /^(Ce|Di)(la|na) /);
  });

  test('FACTION.TXT regions are 1-based in the file; region people and court resolve per DFU', () => {
    assert.equal(FACTIONS.get(504).region, 17);
    assert.deepEqual(regionFactions(FACTIONS, 17), { people: 504, court: 595 });
    const region = regionFactions(FACTIONS, 17);
    assert.equal(effectiveFaction(FACTIONS, 0, 15, region).id, 504, 'faction 0 in a tavern -> people of the region');
    assert.equal(effectiveFaction(FACTIONS, 0, 16, region).id, 595, 'faction 0 in a palace -> court');
    assert.equal(effectiveFaction(FACTIONS, 242, 17, region).id, 595, 'random noble -> court');
  });

  test('StaticNPCClick services: guild ids, merchants by building type, bank, tavern', () => {
    const merch = FACTIONS.get(510);
    assert.equal(servicesFor(510, merch, { buildingType: 9 }).shop, 'general');
    assert.equal(servicesFor(510, merch, { buildingType: 2 }).repair, true);
    assert.equal(servicesFor(510, merch, { buildingType: 3 }).bank, true);
    assert.deepEqual(servicesFor(510, merch, { buildingType: 15 }).services, ['rest']);
    assert.equal(servicesFor(851, FACTIONS.get(851), { buildingType: 11 }).questGroup, 'FightersGuild');
    assert.deepEqual(servicesFor(849, null, { buildingType: 11 }).services, ['join', 'train']);
    assert.equal(servicesFor(504, FACTIONS.get(504), { buildingType: 17 }).service, 'talk');
  });

  test('opening hours (PlayerActivate) decide whether shop people are present', () => {
    assert.equal(presentAt(9, 12), true);
    assert.equal(presentAt(9, 3), false, 'general store closed at 03:00');
    assert.equal(presentAt(15, 3), true, 'taverns never close');
    assert.equal(buildingKey(0, 0, 0), 1 << 24);
    assert.equal(isChild(182, 4, 0), true);
  });
});

describe('placement in each frame', () => {
  test('interior people stand on (x, -y, z)*scale of the building frame, z mirrored; ids and names are stable', () => {
    const sub = {
      index: 3, building: { buildingType: 15, factionId: 510, quality: 7 },
      interior: {
        people: [
          { position: 4000, xPos: 24, yPos: 0, zPos: -24, archive: 182, record: 2, factionId: 510, flags: 0 },
          { position: 4017, xPos: -200, yPos: -129, zPos: 80, archive: 184, record: 12, factionId: 0, flags: 32 },
        ],
        flats: [{ archive: 199, record: 11, xPos: 40, yPos: 0, zPos: 40 }, { archive: 199, record: 18, xPos: 0, yPos: 0, zPos: 0 }],
      },
    };
    const loc = 'interior:Somewhere/Town/1,2/3';
    const ps = interiorPeople({ location: loc, sub, bx: 1, by: 2, regionIndex: 17, locationIndex: 5, ...tables });
    assert.equal(ps.length, 2);
    assert.deepEqual([ps[0].x, ps[0].y, ps[0].z], [0.6, 0, 0.6]);
    assert.deepEqual([ps[1].x, ps[1].y, ps[1].z], [-5, 129 * SCALE, -2], 'upper floor: foot at -yPos*scale');
    assert.equal(ps[0].role, 'innkeeper');
    assert.equal(ps[1].gender, 'female');
    assert.equal(ps[1].faction, 504);
    assert.equal(ps[0]._source.nameSeed, (4000 ^ (buildingKey(1, 2, 3) + 5)) | 0, 'nameSeed = Position ^ (buildingKey + locationIndex)');
    assert.deepEqual(interiorPeople({ location: loc, sub, bx: 1, by: 2, regionIndex: 17, locationIndex: 5, ...tables }).map((e) => [e.id, e.name]), ps.map((e) => [e.id, e.name]));
    const m = interiorQuestMarkers(sub);
    assert.equal(m.spawn.length, 1);
    assert.equal(m.item.length, 1);
  });

  test('exterior flats: base at (-y-6)*scale with block and sub-record offsets, no sub yaw; lights and editor markers are scenery', () => {
    const spawnLocal = { x: 50, z: 60 };
    const rmb = {
      miscFlats: [
        { xPos: 1000, yPos: 0, zPos: -2000, archive: 179, record: 1, factionId: 420, flags: 0 },
        { xPos: 0, yPos: 0, zPos: 0, archive: 210, record: 1, factionId: 7, flags: 0 },
        { xPos: 0, yPos: 0, zPos: 0, archive: 199, record: 8, factionId: 3, flags: 0 },
      ],
      subRecords: [{ xPos: 400, zPos: 800, yRotation: 512, flats: [{ xPos: 10, yPos: -40, zPos: 20, archive: 334, record: 19, factionId: 364, flags: 0 }] }],
    };
    const ps = exteriorPeople({ location: 'town:Somewhere/Town', blocks: [{ x: 1, y: 0, name: 'TEST.RMB', rmb }], spawnLocal, regionIndex: 17, locationIndex: 5, ...tables });
    assert.equal(ps.length, 2, 'only the coven person and the individual');
    const ux = BLOCK_SIZE + 1000 * SCALE, uz = (-2000 + 4096) * SCALE;
    assert.deepEqual([ps[0].x, ps[0].y, ps[0].z], [ux - 50, -6 * SCALE, -(uz - 60)].map((v) => Math.round(v * 1000) / 1000));
    const vx = BLOCK_SIZE + (10 + 400) * SCALE, vz = (20 + 4096 - 800) * SCALE;
    assert.deepEqual([ps[1].x, ps[1].y, ps[1].z], [vx - 50, (40 - 6) * SCALE, -(vz - 60)].map((v) => Math.round(v * 1000) / 1000), 'the sub-record yRotation does not move flats (RMBLayout.AddExteriorBlockFlats)');
    assert.equal(ps[1].name, 'King Someone');
    assert.equal(ps[1].individual, true);
  });

  test('dungeon NPC flats are centred at (x,-y,z) in their RDB block; castle blocks roll castle questors', () => {
    const rdb = {
      name: 'S0000001.RDB',
      objects: [
        { type: 3, root: 0, index: 0, position: 100, xPos: 0, yPos: 0, zPos: 0, flat: { archive: 199, record: 10, magnitude: 1, soundIndex: 0, flags: 0 } },
        { type: 3, root: 0, index: 1, position: 200, xPos: 400, yPos: -1000, zPos: 800, flat: { position: 300, archive: 334, record: 19, magnitude: 364 & 0xff, soundIndex: 364 >> 8, flags: 0 } },
        { type: 3, root: 0, index: 2, position: 220, xPos: 80, yPos: 0, zPos: 80, flat: { position: 320, archive: 334, record: 7, magnitude: 0, soundIndex: 0, flags: 0 } },
      ],
    };
    const ps = dungeonPeople({ location: 'dungeon:Somewhere/Town', blocks: [{ x: 1, z: -1, rdb }], regionIndex: 17, locationIndex: 5, ...tables });
    assert.equal(ps.length, 2);
    assert.deepEqual([ps[0].x, ps[0].y, ps[0].z], [RDB_SIDE + 10, 25, 31.2]);
    assert.equal(ps[0].anchor, 'centre');
    assert.equal(ps[0].name, 'King Someone');
    assert.equal(ps[1]._castleGroup, 'Commoners');
  });
});

describe('mobile townspeople (PopulationManager)', () => {
  const block = (x, y, tile) => ({ x, y, automap: new Uint8Array(4096), groundTiles: new Uint8Array(256).fill(tile) });
  test('navgrid: inverse automap times tile weight, 1.6 m cells', () => {
    const b = block(0, 0, 46);
    b.automap[0] = 1;
    const nav = buildNavGrid([b, block(1, 0, 0)], 2, 1, { x: 0, z: 0 });
    assert.equal(nav.walkable, 4095, 'water tiles and covered cells are excluded');
    assert.equal(nav.weight(1, 0), 15);
    assert.equal(nav.weight(0, 0), 0);
    assert.equal(tileWeight(2), 12);
    const c = nav.toOut(10, 5);
    assert.deepEqual(nav.fromOut(c.x, c.z), { gx: 10, gy: 5 });
    assert.equal(CELL, 1.6);
  });

  test('pool: 24 per 16 blocks, day only, reproducible, recycled away from players, 1 in 32 guards', () => {
    const blocks = Array.from({ length: 16 }, (_, i) => block(i % 4, Math.floor(i / 4), 46));
    const nav = buildNavGrid(blocks, 4, 4, { x: 200, z: 200 });
    const make = () => createPopulation({ location: 'town:Somewhere/Town', nav, blocks: 16, race: 'breton', regionIndex: 17, banks: BANKS });
    const a = make(), b = make();
    const players = [{ x: 0, z: 0, yaw: 0 }];
    assert.equal(a.max, 24);
    for (let i = 0; i < 200; i++) { a.step(0.1, players, 12); b.step(0.1, players, 12); }
    assert.equal(a.active.length, 24);
    assert.deepEqual(a.active.map((e) => [e.id, e.name, e.x, e.z]), b.active.map((e) => [e.id, e.name, e.x, e.z]), 'same seed, same town');
    assert.ok(a.active.every((e) => e.kind === 'npc' && e.mobile && Number.isFinite(e.x)));
    const night = a.step(0.1, [{ x: 0, z: 0, yaw: Math.PI }], 20);
    assert.ok(night.removed.length > 0, 'dusk recycles people out of view');
    const many = make();
    let guards = 0, total = 0;
    for (let n = 0; n < 4000; n++) {
      const r = many.step(0.1, players, 12);
      total += r.added.length;
      guards += r.added.filter((e) => e.sprite.archive === GUARD_TEXTURE).length;
      many.clearAll();
    }
    assert.ok(total > 3000 && guards / total > 0.015 && guards / total < 0.06, `guards ${guards}/${total}`);
  });
});

describe('server feature with a source', () => {
  function fakeSource() {
    const interior = 'interior:Somewhere/Town/0,0/1';
    const keeper = interiorPeople({
      location: interior, bx: 0, by: 0, regionIndex: 17, locationIndex: 5, ...tables,
      sub: { index: 1, building: { buildingType: 9, factionId: 0, quality: 10 }, interior: { people: [{ position: 50, xPos: 0, yPos: 0, zPos: -80, archive: 182, record: 26, factionId: 510, flags: 0 }], flats: [] } },
    });
    const nav = buildNavGrid([{ x: 0, y: 0, automap: new Uint8Array(4096), groundTiles: new Uint8Array(256).fill(46) }], 1, 1, { x: 50, z: 50 });
    return {
      tables,
      interior: async () => ({ location: interior, building: { buildingType: 9, key: 1 }, people: keeper, markers: { spawn: [{ key: 'f0', x: 1, y: 0, z: 1 }], item: [] } }),
      dungeon: async () => { throw new Error('none'); },
      town: async (location) => ({ location, people: [], nav, blocks: 1, climatePeople: 'breton', regionIndex: 17, work: [], buildings: [] }),
      evict() {},
    };
  }
  function world() {
    const players = new Map();
    const sent = [];
    let clock = 0;
    const rt = createRpgRuntime({
      players, features: [{ name: 'npcs', install: (ctx) => npcs.install(ctx, { peopleSource: fakeSource() }) }],
      save() {}, send: (p, m) => sent.push([p.id, m]), now: () => clock, log: { error() {}, warn() {}, info() {} },
    });
    return { rt, players, sent, tick: (ms) => { clock += ms; rt.tick(ms / 1000, clock); } };
  }

  test('no roster stand-ins in a sourced town; the shop person serves from one building stock; legacy ids alias', async () => {
    const w = world();
    const town = 'town:Somewhere/Town';
    const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, moving: false, rpg: { location: town, gold: 500 } };
    w.players.set(1, p);
    w.rt.join(p);
    await w.rt.ctx.services.npcs.ready(town);
    w.tick(100);
    const legacy = rosterFor(town).map((n) => n.id);
    assert.ok(!legacy.some((id) => w.rt.entities.has(id)), 'no spawn-lane roster in a town with source data');
    const loc = 'interior:Somewhere/Town/0,0/1';
    p.rpg.location = loc;
    await w.rt.ctx.services.npcs.ready(loc);
    w.tick(100);
    const keeper = [...w.rt.entities.values()].find((e) => e.location === loc && e.shop);
    assert.ok(keeper, 'shopkeeper present');
    p.x = keeper.x; p.z = keeper.z + 4;
    assert.equal(w.rt.act(p, 'npc.talk', { targetId: keeper.id }).ok, true, 'DFU static reach is 6.4 m');
    p.z = keeper.z + 7;
    assert.equal(w.rt.act(p, 'npc.talk', { targetId: keeper.id }).ok, false);
    p.rpg.portal = { to: loc, footY: 3.2 };
    p.z = keeper.z + 1;
    assert.match(w.rt.act(p, 'npc.talk', { targetId: keeper.id }).error, /another floor/);
    assert.deepEqual(await w.rt.ctx.services.npcs.questSpawn(loc), [{ key: 'f0', x: 1, y: 0, z: 1 }]);
    const merchantSlot = rosterFor(town).find((n) => n.role === 'merchant');
    if (merchantSlot) {
      const r = await w.rt.ctx.services.npcs.resolve(merchantSlot.id, town);
      assert.equal(r?.id ?? null, null, 'the fake town lists no buildings, so nothing is invented');
    }
  });
});

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
describe('with the operator’s ARENA2', { skip: !existsSync(`${ARENA2}BLOCKS.BSA`) && 'no local ARENA2' }, async () => {
  const { createPeopleSource } = await import('../server/rpg/npcs/world.js');
  const src = createPeopleSource(ARENA2, null, { spawnLocal: async () => ({ x: 0, z: 0 }) });

  test('Blackidge Hamlet tavern (17/841 0,0/10): the eight authored records with their DFU names', async () => {
    const i = await src.interior('interior:Daggerfall/Blackidge Hamlet/0,0/10');
    assert.equal(i.building.buildingType, 15);
    assert.equal(i.people.length, 8);
    const keeper = i.people[0];
    assert.equal(keeper.role, 'innkeeper');
    assert.equal(keeper.name, 'Mordynak Masterhart');
    assert.equal(keeper.building.name, 'The Rat and Scorpion');
    const nextInn = await src.interior('interior:Daggerfall/Blackidge Hamlet/0,0/11');
    assert.equal(nextInn.people[0].building.name, "The Devil's Dagger");
    assert.deepEqual([keeper.x, keeper.y, keeper.z], [0.6, 0, -0.6]);
    assert.ok(i.people.every((e) => e.y === 0 && e.name && e.sprite.archive === 182));
  });

  test('"Where is …?" residents are the same people, ids, names and floors the interiors publish', async () => {
    const t = await src.town('town:Daggerfall/Daggerfall');
    assert.ok(t.residents.length > 100, 'a large town lists its named adults');
    assert.ok(t.residents.every((r) => r.name && (r.secret || !t.secretHalls.includes(r.interior))), 'everyone in a secret hall is secret');
    const sample = t.residents.filter((r, i) => i % 23 === 0 || r.y > 2).slice(0, 12);
    for (const r of sample) {
      const i = await src.interior(r.interior);
      const e = i.people.find((x) => x.id === r.id);
      assert.ok(e, r.id);
      assert.deepEqual([e.name, e.title, e.x, e.y, e.z], [r.name, r.title, r.x, r.y, r.z]);
    }
    assert.ok(t.residents.some((r) => r.y > 3), 'some live upstairs');
  });

  test('the KRAVE01 house record in Tunhead identifies the Order of the Raven', async () => {
    const hall = await src.interior('interior:Dwynnen/Tunhead/6,2/18');
    assert.equal(hall.building.buildingType, 11);
    assert.equal(hall.building.factionId, 414);
    assert.equal(hall.building.name, 'The Order of the Raven');
    assert.equal(hall.people.length, 8);
    assert.ok(hall.people.every(p => p.building.name === hall.building.name));
  });

  test('Castle Daggerfall: King Gothryd and the court are authored RDB individuals', async () => {
    const d = await src.dungeon('dungeon:Daggerfall/Daggerfall');
    const king = d.people.find((e) => e.name === 'King Gothryd');
    assert.ok(king?.individual);
    assert.equal(king.faction, 364);
    assert.ok(d.people.filter((e) => e.individual).length >= 7);
  });

  test('Gothway Garden work directions match the people actually offering work, including when shops reopen', async () => {
    const town = 'town:Daggerfall/Gothway Garden';
    const { work } = await src.town(town);
    const venues = [9, 15].map((type) => work.find((w) => w.buildingType === type).interior);
    const players = new Map([town, ...venues].map((location, id) => [id, { id, location, x: 0, z: 0 }]));
    const entities = new Map();
    let minutes = 0;
    const places = createPlaces({
      players, entities, location: (p) => p.location, now: () => 0, services: { worldClock: () => ({ minutes }) },
    }, src);
    await Promise.all([town, ...venues].map((loc) => places.ready(loc)));
    let shopOffers = 0;
    for (let day = 0; day < 8; day++) {
      for (const hour of [3, 12, 23]) {
        minutes = (day * 24 + hour) * 60;
        places.tick(0.1);
        const expected = [...entities.values()].filter((e) => venues.includes(e.location) && e._workGroup && e.questGiver)
          .map((e) => [e.id, e.name, e.location, e.questGroup]).sort();
        const actual = places.workAt(town, 0).filter((w) => venues.includes(w.interior));
        assert.deepEqual(actual.map((w) => [w.id, w.name, w.interior, w.group]).sort(), expected, `day ${day}, hour ${hour}`);
        const n = actual.filter((w) => w.buildingType === 9).length;
        if (hour === 12) shopOffers += n;
        else assert.equal(n, 0, 'closed shops have no leads');
      }
    }
    assert.ok(shopOffers > 0, 'at least one daily giver appeared when the store opened');
  });
});
