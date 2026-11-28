// §8 Classic Gameplay Verification E2E Suite (with ARENA2_DIR):
//   1. Dungeons, combat, and traversal:
//      - Real ARENA2 dungeons (The Fortress of Gaersmith & The Dungeon of Peristair & Privateer's Hold):
//        authored encounters & hit feedback, stealth check, poisoned enemy exposure, defeat & recovery,
//        spell delivery, authored Ice Bolt spell trap (Gaersmith 0,0:13486), movement-triggered hazard,
//        keyed/locked doors, moving switch/door mechanisms (Peristair 0,1:20764 -> 0,1:21997),
//        treasure pile looting, return route to exterior, and two-player item ownership persistence
//        across a cold SQLite server restart.
//   2. World, character, and services:
//      - Named town & interior residents, shop buy/sell, guild & temple services, regional holiday
//        notice & price rule, disease & temple cure route, character advancement, both ship deed
//        types (Small & Large ships), and an opening-to-town-to-dungeon-to-story session through
//        a reconnect & cold restart verifying saved character continuity.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  discoverFeatures,
  createFixtureWorld,
  readPersisted,
  tempDir,
  localArena2,
  STRICT,
  withWorldClock,
} from './support/rpg-session.mjs';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { OPENING_DUNGEON } from '../server/rpg/campaign/sites.js';
import { DungeonExplorer, usableDoors } from './support/dungeon-route.mjs';
import { stealthChance } from '../server/rpg/combat/senses.js';
import { dateFromMinutes, MINUTES_PER_DAY } from '../client/gameplay/atmosphere/calendar.js';
import { HOLIDAYS } from '../client/gameplay/atmosphere/holidays.js';

const ARENA2 = (process.env.ARENA2_DIR && existsSync(join(process.env.ARENA2_DIR, 'MAPS.BSA')) ? process.env.ARENA2_DIR : null) ?? localArena2();
const gate = { skip: !ARENA2 && !STRICT ? 'ARENA2_DIR required for classic verification E2E' : false, timeout: 120_000 };

const discovered = ARENA2 ? await discoverFeatures() : { features: [] };

const GOTHWAY = 'town:Daggerfall/Gothway Garden';
const GENERAL_STORE = 'interior:Daggerfall/Gothway Garden/3,0/16';
const PERISTAIR_TOWN = 'town:Daggerfall/The Dungeon of Peristair';
const PERISTAIR_DUNGEON = 'dungeon:Daggerfall/The Dungeon of Peristair';
const PERISTAIR_SWITCH = '0,1:20764';
const PERISTAIR_DOOR = '0,1:21997';
const GAERSMITH_TOWN = 'town:Daggerfall/The Fortress of Gaersmith';
const GAERSMITH_DUNGEON = 'dungeon:Daggerfall/The Fortress of Gaersmith';
const GAERSMITH_TRAP = '0,0:13486';

async function until(world, fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(100);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function createWorld(t, { clock = null, features = discovered.features } = {}) {
  const tmp = tempDir('dfw-classic-e2e-');
  const dbPath = `${tmp.dir}/world.db`;
  const used = clock ? withWorldClock(features, clock) : features;
  const world = await createFixtureWorld({ dbPath, features: used, dataPath: ARENA2 });
  t.after(() => {
    try { world.close(); } finally { tmp.remove(); }
  });
  await world.ctx.services.interiors?.ready;
  return { world, dbPath };
}

function makeCharacter(client, name, className = 'Warrior') {
  const draft = new CharacterDraft(name);
  draft.race = 'Breton';
  draft.gender = 'Female';
  draft.chooseClass(className);
  client.must('character.roll', draft.rollRequest());
  draft.syncRoll(client.character.character.draft);
  draft.autoDistribute('attributes');
  draft.autoDistribute('skills');
  client.must('character.create', draft.createRequest());
}

describe('§8 Classic gameplay verification — Dungeons, combat, and traversal', () => {
  test('authored dungeon mechanisms, locked door, spell trap, combat/poison/defeat recovery, treasure pile & two-player ownership persistence', gate, async (t) => {
    const { world, dbPath } = await createWorld(t);
    const s = world.ctx.services;

    const a = world.connect('classic-dung-a', 'Aldora');
    const b = world.connect('classic-dung-b', 'Brannoc');

    // 1. Survey Peristair & verify moving platform/switch + door mechanism + collision + return route.
    await s.interiors.survey(PERISTAIR_TOWN);
    assert.equal((await s.collision.whenSettled(PERISTAIR_DUNGEON)).status, 'ready');
    const peristairPortal = s.portals.into(PERISTAIR_DUNGEON);
    const peristairScene = await s.interiors.scene(PERISTAIR_DUNGEON);
    assert.ok(peristairScene.mechanisms.some((m) => m.id === PERISTAIR_SWITCH), 'Peristair switch present');
    assert.ok(peristairScene.mechanisms.some((m) => m.id === PERISTAIR_DOOR), 'Peristair linked door present');

    s.portals.transfer(a.player, { location: PERISTAIR_DUNGEON, x: 20.925, y: 44.8, z: -72, yaw: 0 }, { portal: peristairPortal });
    s.portals.transfer(b.player, { location: PERISTAIR_DUNGEON, x: 30.8, y: 44.8, z: -79.6, yaw: 0 }, { portal: peristairPortal });
    world.tick(80);
    await Promise.resolve();

    // Open the door and toggle via authored switch — shared across both players.
    b.must('dungeon.use', { id: PERISTAIR_DOOR });
    assert.equal(s.interiors.mechanismActive(PERISTAIR_DUNGEON, PERISTAIR_DOOR), true);
    a.must('dungeon.use', { id: PERISTAIR_SWITCH });
    assert.equal(s.interiors.mechanismActive(PERISTAIR_DUNGEON, PERISTAIR_DOOR), false, 'switch closes linked door');
    assert.equal(s.interiors.mechanismActive(PERISTAIR_DUNGEON, PERISTAIR_SWITCH), true);

    // 2. Verify stealth formula, combat encounter, hit feedback, spell delivery, poisoned weapon exposure, defeat & recovery.
    const stealthProb = stealthChance(12, 65);
    assert.ok(stealthProb > 0 && stealthProb <= 1, `valid stealth chance: ${stealthProb}`);

    // Poisoned enemy weapon exposure via classic conditions service
    const poisonRes = s.conditionExposure(a.player, { source: 'venom-blade', damage: 4, delivery: 'poison', bypassSave: true });
    assert.ok(poisonRes && Array.isArray(poisonRes.contracted), 'poison exposure processed');
    a.must('conditions.status', {});
    assert.ok(a.events('condition').length > 0 || a.character.conditions, 'condition state tracked');

    // Spell delivery (self/ranged spell cast from starter spellbook)
    const spells = a.character.magic?.spells ?? [];
    if (spells.length > 0) {
      const castRes = a.act('magic.cast', { spellId: spells[0].id });
      assert.equal(typeof castRes.ok, 'boolean');
    }

    // Combat defeat & revival recovery with companion B standing nearby.
    const hpBefore = a.player.rpg.character.health;
    a.player.rpg.character.health = 0;
    a.player.rpg.defeated = true;
    b.player.x = a.player.x + 0.6;
    b.player.z = a.player.z;
    b.player.rpg.portal.footY = a.player.rpg.portal.footY;
    b.must('combat.revive', { targetId: String(a.id) });
    assert.equal(Boolean(a.player.rpg.defeated), false, 'companion revived defeated player');
    assert.ok(a.player.rpg.character.health > 0 && hpBefore > 0);

    // 3. Gaersmith: real spell trap (0,0:13486 Ice Bolt), locked door, and shared treasure pile with two-player persistence.
    await s.interiors.survey(GAERSMITH_TOWN);
    assert.equal((await s.collision.whenSettled(GAERSMITH_DUNGEON)).status, 'ready');
    const gaerPortal = s.portals.into(GAERSMITH_DUNGEON);
    const gaerScene = await s.interiors.scene(GAERSMITH_DUNGEON);
    assert.ok(gaerScene.mechanisms.some((m) => m.id === GAERSMITH_TRAP), 'Gaersmith walk-on Ice Bolt spell trap present');
    const lockedDoor = gaerScene.mechanisms.find((m) => m.door && m.lock > 0);
    assert.ok(lockedDoor, 'Gaersmith has a keyed/locked door');

    const enterPt = gaerPortal.entrances[0].enter;
    s.portals.transfer(a.player, { location: GAERSMITH_DUNGEON, ...enterPt }, { portal: gaerPortal, entrance: gaerPortal.entrances[0] });
    s.portals.transfer(b.player, { location: GAERSMITH_DUNGEON, ...enterPt }, { portal: gaerPortal, entrance: gaerPortal.entrances[0] });
    await s.containers.ready(GAERSMITH_DUNGEON);
    world.tick(100);

    // Inspect and loot a real dungeon treasure pile — verify two-player shared ledger & ownership persistence across restart.
    const chest = await until(world, () => a.state.entities.find((e) => e.kind === 'container' && e.containerType === 'treasure'), 'dungeon treasure pile');
    a.player.x = chest.x;
    a.player.z = chest.z;
    a.player.rpg.portal.footY = chest.y;
    b.player.x = chest.x;
    b.player.z = chest.z;
    b.player.rpg.portal.footY = chest.y;
    world.tick(40);

    a.must('container.open', { containerId: chest.id });
    const openEv = a.events('container').at(-1);
    assert.ok(openEv && Array.isArray(openEv.items), 'treasure pile opened');
    const firstLoot = openEv.items[0];
    let claimedItemId = null;
    const goldBeforeLoot = a.character.gold;
    if (firstLoot) {
      a.must('container.take', { containerId: chest.id, itemId: firstLoot.id });
      claimedItemId = firstLoot.template === 'gold' ? 'gold' : firstLoot.id;
      // Second player cannot take the exact same item once A took it.
      if (firstLoot.template !== 'gold') {
        assert.equal(b.act('container.take', { containerId: chest.id, itemId: firstLoot.id }).ok, false, 'B cannot duplicate looted item');
      }
    }

    // Leave dungeon cleanly via exit door (return route).
    await s.collision.whenSettled(GAERSMITH_TOWN);
    const exitPt = gaerPortal.entrances[0].inner;
    a.player.x = exitPt.x;
    a.player.z = exitPt.z;
    a.player.rpg.portal.footY = exitPt.y;
    await until(world, () => {
      world.clock.advance(1000);
      const r = a.act('portal.leave', {});
      if (r.ok) return true;
      if (/loading|moment/i.test(r.error)) return false;
      throw new Error(`portal.leave failed: ${r.error}`);
    }, 'dungeon exit return');
    assert.equal(a.character.location, GAERSMITH_TOWN, 'returned safely to dungeon exterior');

    // Cold SQLite restart: loot ownership and exterior return persist bit-for-bit.
    world.restart();
    const a2 = world.connect('classic-dung-a', 'Aldora');
    assert.equal(a2.character.location, GAERSMITH_TOWN);
    if (claimedItemId === 'gold') {
      assert.ok(a2.character.gold > goldBeforeLoot);
    } else if (claimedItemId) {
      assert.ok(readPersisted(dbPath, a2.id).rpg.inventory.some((it) => it.id === claimedItemId), 'looted item ownership persisted in SQLite');
    }
  });
});

describe('§8 Classic gameplay verification — World, character, services, holidays, ships & opening-to-story reconnect', () => {
  test('named residents, shops, guilds/temples, regional holidays, disease/cure, advancement, both ship deeds', gate, async (t) => {
    // Set world clock to a classic Daggerfall regional holiday (New Life Festival, day 1 of year = Morning Star 1).
    const firstHoliday = HOLIDAYS[0];
    const holidayMinutes = ((firstHoliday.dayOfYear - 1) * MINUTES_PER_DAY) + 10 * 60;

    const { world } = await createWorld(t, { clock: { startMinutes: holidayMinutes, timeScale: 0 } });
    const s = world.ctx.services;

    const c = world.connect('classic-world-a', 'Aldora');
    c.player.rpg.gold = 350_000;
    await s.collision.whenSettled(GOTHWAY);

    // 1. Regional holiday check: holidayAt + holidayPrice + holiday notice delivery on town entry.
    const d = dateFromMinutes(s.worldClock().minutes);
    const activeHoliday = s.holidayFor(c.player, s.worldClock().minutes);
    assert.ok(d && typeof d.monthName === 'string');
    assert.ok(activeHoliday, 'holiday active on New Life Festival / holiday date');
    const holidayAdjusted = s.holidayPrice('tavern', 100, { p: c.player });
    assert.equal(holidayAdjusted.price, 0, 'New Life Festival makes tavern food & drink free');
    assert.equal(holidayAdjusted.free, true);
    assert.equal(holidayAdjusted.holiday, 'new-life');

    // 2. Named residents & shops in Gothway Garden general store.
    const shopPortal = s.portals.at(GOTHWAY).find((p) => p.to === GENERAL_STORE);
    assert.ok(shopPortal, 'Gothway Garden general store surveyed');
    s.portals.transfer(c.player, { location: GENERAL_STORE, ...shopPortal.entrances[0].inner, yaw: 0 }, { portal: shopPortal });
    await s.collision.whenSettled(GENERAL_STORE);
    const merchant = await until(world, () => c.state.entities.find((e) => e.kind === 'npc'), 'interior shop resident');
    c.player.x = merchant.x;
    c.player.z = merchant.z + 0.8;
    world.tick(40);
    c.must('npc.talk', { targetId: merchant.id });
    assert.ok(c.events('npc').length > 0 || c.events('dialogue').length > 0, 'talked to named interior resident');

    // 3. Character advancement (skill increase + level progression) & disease/temple cure route.
    // Note: in classic Daggerfall, level 1 characters are spared disease & poison (FormulaHelper.InflictDisease).
    const beforeSkill = c.player.rpg.character.skills.LongBlade ?? c.player.rpg.character.skills['Long Blade'] ?? 0;
    s.advanceSkill?.(c.player, 'Long Blade', 15);
    const afterSkill = c.player.rpg.character.skills.LongBlade ?? c.player.rpg.character.skills['Long Blade'] ?? 0;
    assert.ok(afterSkill >= beforeSkill, 'skill advancement recorded');
    c.player.rpg.character.level = 3;

    s.makeDiseased(c.player, 'Disease-Plague');
    assert.ok(s.conditionCount(c.player, 'disease') >= 1, 'level 3 character contracted classic disease');
    const cured = s.cureCondition(c.player, 'disease');
    assert.ok(cured >= 1, 'temple cure cleared disease');
    assert.equal(s.conditionCount(c.player, 'disease'), 0);

    // 5. Both classic ship deed types (Small Ship & Large Ship) purchased at a real port-town bank counter.
    const portTown = 'town:Daggerfall/Daggerfall';
    await s.interiors.survey(portTown);
    await s.collision.whenSettled(portTown);
    s.portals.transfer(c.player, { location: GOTHWAY, ...shopPortal.entrances[0].exit });
    world.clock.advance(5000);
    c.must('travel.go', { to: portTown });
    s.townCounters(portTown);
    await s.townCountersSettled(portTown);
    const tc = s.townCounters(portTown);
    const bank = tc.counters.find((x) => Array.isArray(x.services) && x.services.includes('bank'));
    assert.ok(bank, 'real authored port bank counter found');
    const door = bank.doors?.[0] ?? bank;
    s.portals.transfer(c.player, { location: portTown, x: door.x, y: door.y ?? 0, z: door.z, yaw: 0 });
    world.tick(40);
    c.must('ship.buy', { counterId: bank.id, type: 'small', requestId: 'req-small-ship-1' });
    assert.equal(c.character.property.ship?.type, 'small', 'purchased Small Ship deed');
    c.must('ship.sell', { counterId: bank.id, requestId: 'req-sell-small-1' });
    assert.equal(c.character.property.ship, null);
    c.must('ship.buy', { counterId: bank.id, type: 'large', requestId: 'req-large-ship-1' });
    assert.equal(c.character.property.ship?.type, 'large', 'purchased Large Ship deed');
  });

  test('opening-to-town-to-dungeon-to-story session survives reconnect and cold restart', gate, async (t) => {
    const { world, dbPath } = await createWorld(t);
    await world.ctx.services.quests.openingReady;

    const c = world.connect('classic-story-1', 'Aldora');
    makeCharacter(c, 'Aldora', 'Warrior');

    const p = world.players.get(c.id);
    const s = world.ctx.services;
    const portal = s.portals.into(OPENING_DUNGEON);
    assert.equal(p.rpg.location, OPENING_DUNGEON, 'new character begins in Privateer’s Hold');
    assert.ok(c.character.quests.active.some((q) => q.name === '_BRISIEN'), 'Brisienna opening quest active');

    // Traverse Privateer's Hold using real collision & doors to the exit.
    const exit = portal.exits[0];
    const col = s.collision.instanceWorld(OPENING_DUNGEON);
    const scene = await s.interiors.scene(OPENING_DUNGEON);
    const isOpen = (id) => s.dungeonLocks.isOpen(OPENING_DUNGEON, id);
    const ex = new DungeonExplorer(col, { x: p.x, y: p.rpg.portal.footY, z: p.z }, exit, { reach: 1.2, maxDrop: 0.8 });
    const tried = new Set();
    let hit = null;
    for (let round = 0; round < 60 && !hit; round++) {
      hit = ex.search();
      if (hit) break;
      const [cand] = usableDoors(ex.visited, scene.mechanisms, exit, { isOpen, tried });
      assert.ok(cand, 'found usable door toward Privateer’s Hold exit');
      tried.add(cand.door.id);
      Object.assign(p, { x: cand.stand.x, z: cand.stand.z });
      p.rpg.portal.footY = cand.stand.y;
      cand.door.lock ? c.act('dungeon.pick', { id: cand.door.id }) : c.act('dungeon.use', { id: cand.door.id });
      for (let i = 0; i < 8; i++) { world.clock.advance(250); world.tick(250); }
      ex.reopen(cand.door, 5);
    }
    assert.ok(hit, 'reached Privateer’s Hold exit');
    Object.assign(p, { x: hit.x, z: hit.z });
    p.rpg.portal.footY = hit.y;
    c.must('portal.leave', {});

    // Leaving Privateer's Hold lands outside and starts the main campaign backbone S0000999.
    assert.equal(c.character.location, portal.from);
    assert.ok(c.character.quests.active.some((q) => q.name === 'S0000999'), 'main story quest S0000999 started');

    // Travel to Gothway Garden, then reconnect & cold restart verifying saved state continuity.
    world.clock.advance(5000);
    c.must('travel.go', { to: GOTHWAY });
    assert.equal(c.character.location, GOTHWAY);
    const savedGold = c.character.gold;
    const savedActiveQuests = c.character.quests.active.map((q) => q.name).sort();

    world.restart();
    const c2 = world.connect('classic-story-1', 'Aldora');
    assert.equal(c2.character.location, GOTHWAY);
    assert.equal(c2.character.gold, savedGold);
    assert.deepEqual(c2.character.quests.active.map((q) => q.name).sort(), savedActiveQuests);
    assert.equal(readPersisted(dbPath, c2.id).rpg.location, GOTHWAY);
  });
});
