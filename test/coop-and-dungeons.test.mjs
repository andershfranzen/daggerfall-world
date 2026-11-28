// Unit & runtime persistence tests for Smaller Dungeons, Dungeon Instances, Party Quests,
// Quest Repair, Repeatable Delves, Living World & Followers, Sea Bounties, Survival,
// Optional DFU Rules / Endgame / Wardrobe / Succession / Expansions, and Coop World Client UI.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createFixtureWorld, tempDir, localArena2 } from './support/rpg-session.mjs';
import { install as installCharacter } from '../server/rpg/character.js';
import { install as installInventory } from '../server/rpg/inventory.js';
import { install as installSocial } from '../server/rpg/social.js';
import { install as installAtmosphere } from '../server/rpg/atmosphere.js';
import { install as installCalendar } from '../server/rpg/calendar.js';
import { install as installContainers, WORLD_PREFIX as CONTAINERS_PREFIX } from '../server/rpg/containers.js';
import { install as installAdmiralty } from '../server/rpg/admiralty.js';

import * as smallerDungeonsMod from '../server/rpg/interiors/smaller-dungeons.js';
import * as instancesMod from '../server/rpg/interiors/instances.js';
import * as partyQuestsMod from '../server/rpg/quests/party-quests.js';
import * as questRepairMod from '../server/rpg/quests/repair.js';
import * as delvesMod from '../server/rpg/delves.js';
import * as livingWorldMod from '../server/rpg/living-world.js';
import * as seaBountiesMod from '../server/rpg/sailing/bounties.js';
import * as survivalMod from '../server/rpg/survival.js';
import * as optionalRulesMod from '../server/rpg/optional-rules.js';
import { install as installCoopClient, coopWorldView, PANEL_ID } from '../client/gameplay/coop-world.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import { openWorldData } from '../client/world/interiors/index.js';
import { readDungeon } from '../client/world/interiors/dungeonMaps.js';
import { operatorFiles } from '../server/rpg/interiors/data.js';

const ARENA2 = (process.env.ARENA2_DIR && existsSync(join(process.env.ARENA2_DIR, 'MAPS.BSA')) ? process.env.ARENA2_DIR : null) ?? localArena2();

const COOP_FEATURES = [
  { name: 'character', install: installCharacter },
  { name: 'inventory', install: installInventory },
  { name: 'atmosphere', install: installAtmosphere },
  { name: 'calendar', install: installCalendar },
  { name: 'containers', install: installContainers },
  { name: 'social', install: installSocial },
  { name: 'admiralty', install: installAdmiralty },
  { name: smallerDungeonsMod.name, install: smallerDungeonsMod.install },
  { name: instancesMod.name, install: instancesMod.install },
  { name: partyQuestsMod.name, install: partyQuestsMod.install },
  { name: questRepairMod.name, install: questRepairMod.install },
  { name: delvesMod.name, install: delvesMod.install },
  { name: livingWorldMod.name, install: livingWorldMod.install },
  { name: seaBountiesMod.name, install: seaBountiesMod.install },
  { name: survivalMod.name, install: survivalMod.install },
  { name: optionalRulesMod.name, install: optionalRulesMod.install },
];

async function makeWorld(t, opts = {}) {
  const tmp = tempDir('dfw-coop-');
  const dbPath = `${tmp.dir}/world.db`;
  const world = await createFixtureWorld({ dbPath, features: COOP_FEATURES, ...opts });
  t.after(() => {
    try { world.close(); } finally { tmp.remove(); }
  });
  return { world, dbPath };
}

describe('Smaller Dungeons (DFU deterministic 5-block layouts)', () => {
  test('story sites and <=5-block dungeons stay classic; eligible dungeons shrink deterministically to 5 blocks', () => {
    assert.equal(smallerDungeonsMod.isSmallerDungeonEligible("dungeon:Daggerfall/Privateer's Hold").eligible, false);
    assert.equal(smallerDungeonsMod.isSmallerDungeonEligible('dungeon:High Rock sea coast/Mantellan Crux').eligible, false);
    assert.equal(smallerDungeonsMod.isSmallerDungeonEligible('dungeon:Wrothgarian Mountains/Shedungent').eligible, false);
    assert.equal(smallerDungeonsMod.isSmallerDungeonEligible({
      location: 'dungeon:Daggerfall/Small Crypt',
      blocks: [{ x: 0, z: 0, blockName: 'N0000001.RDB', isStartingBlock: true }],
    }).eligible, false);

    const site = 'dungeon:Daggerfall/The Dungeon of Peristair';
    assert.equal(smallerDungeonsMod.isSmallerDungeonEligible(site).eligible, true);
    const a = smallerDungeonsMod.buildSmallerDungeonLayout(site, { mode: 'smaller' });
    const b = smallerDungeonsMod.buildSmallerDungeonLayout(site, { mode: 'smaller' });
    assert.equal(a.mode, 'smaller');
    assert.equal(a.blockCount, 5);
    assert.equal(a.blocks.length, 5);
    assert.equal(a.layoutId, b.layoutId);
    assert.equal(a.collisionHash, b.collisionHash);
    assert.deepEqual(a.blocks, b.blocks);
    assert.equal(a.startBlock.x, 0);
    assert.equal(a.startBlock.z, 0);
    assert.ok(a.automapKey.includes(a.layoutId));
  });

  test('two players get identical 5-block layout, quest pinning holds across preference toggle and restart', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-sd-a', 'Aldora');
    const b = world.connect('acct-sd-b', 'Brannoc');
    const site = 'dungeon:Daggerfall/The Dungeon of Peristair';

    a.must('dungeon.layout.select', { location: site, mode: 'smaller' });
    b.must('dungeon.layout.select', { location: site, mode: 'smaller' });
    const evA = a.events('dungeonLayout').at(-1);
    const evB = b.events('dungeonLayout').at(-1);
    assert.equal(evA.layout.layoutId, evB.layout.layoutId);
    assert.equal(evA.layout.collisionHash, evB.layout.collisionHash);
    assert.equal(evA.layout.blockCount, 5);

    // Pin active quest to the smaller layout, then attempt to switch preference back to classic.
    const pin = world.ctx.services.smallerDungeons.pinQuestLayout(a.player, 'q-101', site, evA.layout);
    assert.equal(pin.layoutId, evA.layout.layoutId);

    a.must('dungeon.layout.select', { location: site, mode: 'classic' });
    const pinnedEv = a.events('dungeonLayout').at(-1);
    assert.equal(pinnedEv.pinned, true);
    assert.equal(pinnedEv.layout.mode, 'smaller');
    assert.equal(pinnedEv.layout.layoutId, evA.layout.layoutId);

    // Survives cold SQLite restart.
    world.restart();
    const a2 = world.connect('acct-sd-a', 'Aldora');
    a2.must('dungeon.layout.info', { location: site });
    const afterRestart = a2.events('dungeonLayout').at(-1);
    assert.equal(afterRestart.pinned, true);
    assert.equal(afterRestart.layout.layoutId, evA.layout.layoutId);
  });

  test('real ARENA2 Peristair dungeon record reduces deterministically to 5 blocks', { skip: !ARENA2 && 'ARENA2_DIR not set' }, async () => {
    const files = await operatorFiles(ARENA2);
    const data = await openWorldData(files);
    const raw = await readDungeon(data.maps, 17, 'The Dungeon of Peristair');
    assert.ok(raw && raw.blocks.length > 5, 'Peristair is a multi-block classic dungeon');
    const smaller = smallerDungeonsMod.buildSmallerDungeonLayout(raw, { mode: 'smaller' });
    assert.equal(smaller.blockCount, 5);
    assert.equal(smaller.mode, 'smaller');
    assert.equal(smaller.startBlock.isStartingBlock, true);
  });
});

describe('Public, Personal, and Party Dungeon Instances', () => {
  test('isolates party/personal instances from public scene, preserves Recall, wipe recovery, and restart', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-inst-a', 'Aldora');
    const b = world.connect('acct-inst-b', 'Brannoc');
    const c = world.connect('acct-inst-c', 'Caelum');
    const site = 'dungeon:Daggerfall/The Dungeon of Peristair';

    // A and B form a party; C stays solo public.
    a.must('party.invite', { targetId: b.id });
    b.must('party.accept', { fromId: a.id });

    a.must('instance.enter', { location: site, mode: 'party', layoutMode: 'smaller' });
    b.must('instance.enter', { location: site, mode: 'party', layoutMode: 'smaller' });
    c.must('instance.enter', { location: site, mode: 'public', layoutMode: 'classic' });

    // Presence scope isolation: A & B share the party instance; C is isolated in public.
    assert.equal(world.ctx.sameScene(a.player, b.player), true);
    assert.equal(world.ctx.sameScene(a.player, c.player), false);
    assert.equal(a.character.dungeonInstance.active.instanceId, b.character.dungeonInstance.active.instanceId);
    assert.ok(a.character.dungeonInstance.active.layoutId.startsWith('smaller:'));

    // Instance-scoped mechanism toggle does not leak to public player C.
    a.must('instance.toggleMechanism', { mechanismId: '0,0:lever-1' });
    assert.ok(b.events('instanceMechanism').some((e) => e.mechanismId === '0,0:lever-1' && e.active === true));
    assert.equal(c.events('instanceMechanism').length, 0);

    // Instance Recall anchor set, leave, and return to exact instance & layoutId.
    a.player.x = 14;
    a.player.z = -9;
    a.must('instance.recallSet', {});
    a.must('instance.leave', {});
    assert.ok(a.character.location.startsWith('town:'));
    a.must('instance.recallReturn', {});
    assert.equal(a.character.location, site);
    assert.equal(a.character.dungeonInstance.active.layoutId, b.character.dungeonInstance.active.layoutId);
    assert.equal(a.player.x, 14);

    // Wipe recovery revives defeated party members at entrance while preserving opened mechanisms.
    a.player.rpg.defeated = true;
    b.player.rpg.defeated = true;
    a.must('instance.recover', {});
    assert.equal(a.player.rpg.defeated, false);
    assert.equal(b.player.rpg.defeated, false);
    const inst = world.ctx.services.dungeonInstances.getInstance(a.character.dungeonInstance.active.instanceId);
    assert.equal(inst.wipes, 1);
    assert.ok(inst.mechanisms.active.includes('0,0:lever-1'));

    // Cold SQLite restart preserves party instance, layoutId, and mechanisms.
    const savedInstId = inst.instanceId;
    world.restart();
    const a2 = world.connect('acct-inst-a', 'Aldora');
    assert.equal(a2.character.dungeonInstance.active.instanceId, savedInstId);
    const reloaded = world.ctx.services.dungeonInstances.getInstance(savedInstId);
    assert.ok(reloaded.mechanisms.active.includes('0,0:lever-1'));
  });
});

describe('Party Quests & Quest Repair', () => {
  test('party quests track shared progress, contributions, once-per-member rewards across membership change & restart', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-pq-a', 'Aldora');
    const b = world.connect('acct-pq-b', 'Brannoc');
    a.must('party.invite', { targetId: b.id });
    b.must('party.accept', { fromId: a.id });

    a.must('partyQuest.accept', { templateId: 'pq-peristair-purge', layoutMode: 'smaller' });
    const pq = a.events('partyQuest').at(-1).quest;
    assert.equal(pq.goal, 4);
    assert.ok(pq.layoutId.startsWith('smaller:'));

    // Both contribute toward the shared goal.
    a.must('partyQuest.contribute', { uid: pq.uid, amount: 2 });
    b.must('partyQuest.contribute', { uid: pq.uid, amount: 2 });
    const readyEv = b.events('partyQuest').at(-1).quest;
    assert.equal(readyEv.status, 'ready');
    assert.equal(readyEv.contributions[a.id], 2);
    assert.equal(readyEv.contributions[b.id], 2);

    const goldA0 = a.character.gold;
    const goldB0 = b.character.gold;
    a.must('partyQuest.handIn', { uid: pq.uid });
    assert.equal(a.character.gold, goldA0 + 250);
    // Double-claim strictly rejected.
    assert.equal(a.act('partyQuest.handIn', { uid: pq.uid }).ok, false);

    // B leaves party, restarts server, and still receives their single earned payout once.
    b.must('party.leave', {});
    world.restart();
    const b2 = world.connect('acct-pq-b', 'Brannoc');
    b2.must('partyQuest.handIn', { uid: pq.uid });
    assert.equal(b2.character.gold, goldB0 + 250);
    assert.equal(b2.act('partyQuest.handIn', { uid: pq.uid }).ok, false);
  });

  test('Quest Repair reconciles outstanding markers, lost collected items, and preserves already-paid quests', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-qr-a', 'Aldora');
    const goldBefore = a.character.gold;

    // Seed three quest scenarios: (1) outstanding item missing marker, (2) collected item lost from pack, (3) paid/done quest.
    a.player.rpg.quests = {
      active: [
        {
          uid: 'q-outstanding',
          name: 'K0C00Y08',
          title: 'A Rare Book',
          payoutOwnerId: a.id,
          places: { 'l.00': { interior: 'dungeon:Daggerfall/The Dungeon of Peristair' } },
          items: { 'i.00': { name: 'Rare Tome', template: 'rare-book', placedAt: 'dungeon:Daggerfall/The Dungeon of Peristair', markerMissing: true, given: false, handedOver: false } },
        },
        {
          uid: 'q-collected-lost',
          name: 'Q_LOST',
          title: 'Stolen Signet',
          payoutOwnerId: a.id,
          items: { 'i.01': { name: 'Baron’s Signet', template: 'signet-ring', inventoryItemId: 'signet-1', given: true, handedOver: false } },
        },
        {
          uid: 'q-paid',
          name: 'Q_PAID',
          title: 'Settled Contract',
          paid: true,
          payoutOwnerId: a.id,
          items: { 'i.02': { name: 'Delivered Ledger', given: true, handedOver: true } },
        },
      ],
      done: [{ uid: 'q-done-1', name: 'Q_OLD', title: 'Completed Deed', payoutOwnerId: a.id }],
    };

    a.must('quest.repair.scan', {});
    const scan = a.events('questRepair').at(-1);
    assert.ok(scan.actionableCount >= 3);

    a.must('quest.repair.run', {});
    const run = a.events('questRepair').at(-1);
    assert.ok(run.repaired.some((r) => r.action === 'reconciled-item-marker' && r.questUid === 'q-outstanding'));
    assert.ok(run.repaired.some((r) => r.action === 'restored-collected-item' && r.questUid === 'q-collected-lost'));
    assert.ok(run.repaired.some((r) => r.action === 'pinned-dungeon-layout' && r.questUid === 'q-outstanding'));

    // Outstanding item was NOT prematurely granted; collected item WAS restored exactly once; paid quest did NOT duplicate gold.
    const outstandingItem = a.character.quests.active[0].items['i.00'];
    assert.equal(outstandingItem.given, false);
    assert.ok(outstandingItem.markerId);
    assert.equal(a.character.inventory.filter((it) => it.id === 'signet-1').length, 1);
    assert.equal(a.character.gold, goldBefore);

    // Running repair a second time is idempotent (0 new repairs, no duplicate item).
    a.must('quest.repair.run', {});
    const secondRun = a.events('questRepair').at(-1);
    assert.equal(secondRun.repaired.length, 0);
    assert.equal(a.character.inventory.filter((it) => it.id === 'signet-1').length, 1);
  });
});

describe('Repeatable Delves, Living World & Followers, Sea Bounties', () => {
  test('Delves scale with participants, pay contributors once, survive restart, and keep classic treasure ledger separate', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-dlv-a', 'Aldora');
    const b = world.connect('acct-dlv-b', 'Brannoc');
    const c = world.connect('acct-dlv-c', 'Caelum');

    // Write a classic container treasure ledger row to prove delve reset never touches `containers/`.
    world.ctx.dirtyWorld(`${CONTAINERS_PREFIX}classic-chest-1`, { stocked: 1, items: [] });
    a.must('delve.join', { delveId: 'delve-peristair-crypt' });
    const run1 = world.ctx.services.delves.getRun('delve-peristair-crypt');
    const soloHp = run1.bossMaxHp;

    b.must('delve.join', { delveId: 'delve-peristair-crypt' });
    assert.ok(run1.bossMaxHp > soloHp, 'joining second player scales boss HP');
    assert.equal(run1.ledgerNamespace, 'delves');

    // Both contribute; C never contributes.
    a.must('delve.engage', { delveId: 'delve-peristair-crypt', damage: 150 });
    world.restart();
    const a2 = world.connect('acct-dlv-a', 'Aldora');
    const b2 = world.connect('acct-dlv-b', 'Brannoc');
    const c2 = world.connect('acct-dlv-c', 'Caelum');

    const resumed = world.ctx.services.delves.getRun('delve-peristair-crypt');
    assert.equal(resumed.contributions[a2.id], 150, 'contribution survives server restart');
    b2.must('delve.engage', { delveId: 'delve-peristair-crypt', damage: resumed.bossHp });
    assert.equal(resumed.status, 'defeated');

    const gA = a2.character.gold;
    a2.must('delve.claim', { delveId: 'delve-peristair-crypt' });
    assert.ok(a2.character.gold > gA);
    assert.equal(a2.act('delve.claim', { delveId: 'delve-peristair-crypt' }).ok, false, 'claim once per run');
    assert.equal(c2.act('delve.claim', { delveId: 'delve-peristair-crypt' }).ok, false, 'non-contributor rejected');

    const oldRunId = resumed.runId;
    a2.must('delve.reset', { delveId: 'delve-peristair-crypt' });
    const resetRun = world.ctx.services.delves.getRun('delve-peristair-crypt');
    assert.notEqual(resetRun.runId, oldRunId);
    assert.equal(resetRun.status, 'open');
  });

  test('Living World residents follow schedules, caravan crosses towns, relationships & follower persist across doors and restart', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-lw-a', 'Aldora');

    const maren = livingWorldMod.SCHEDULED_RESIDENTS[0];
    const dawn = livingWorldMod.residentScheduleAt(maren, 9);
    const eve = livingWorldMod.residentScheduleAt(maren, 19);
    assert.notEqual(dawn.location, eve.location, 'resident moves between buildings by hour');

    const route = livingWorldMod.CARAVAN_ROUTES[0];
    const stop0 = livingWorldMod.caravanStateAt(route, 0);
    const stop1 = livingWorldMod.caravanStateAt(route, route.legMinutes);
    assert.notEqual(stop0.location, stop1.location, 'caravan crosses town scenes');
    assert.equal(stop0.actors[0].id, stop1.actors[0].id, 'stable caravan actor id across scenes');

    a.must('living.talk', { residentId: 'res-aldric-thorne' });
    a.must('living.gift', { residentId: 'res-aldric-thorne', gold: 15 });
    a.must('follower.recruit', { residentId: 'res-aldric-thorne' });
    assert.equal(a.character.livingWorld.follower.active, true);
    assert.equal(a.character.livingWorld.follower.isQuestEscort, false);
    assert.equal(a.character.livingWorld.follower.isArtifactAlly, false);

    // Cross a door: follower follows automatically.
    world.ctx.emit('locationChanged', { player: a.player, from: livingWorldMod.PILOT_TOWN, to: 'interior:Daggerfall/Gothway Garden/3,0/16' });
    assert.equal(a.player.rpg.livingWorld.follower.location, 'interior:Daggerfall/Gothway Garden/3,0/16');

    // Dismiss then recall across doors.
    a.must('follower.dismiss', {});
    assert.equal(a.character.livingWorld.follower.active, false);
    a.must('follower.recall', {});
    assert.equal(a.character.livingWorld.follower.active, true);
    assert.equal(a.character.livingWorld.follower.location, a.character.location);

    // Relationships and follower survive restart.
    world.restart();
    const a2 = world.connect('acct-lw-a', 'Aldora');
    assert.ok(a2.character.livingWorld.relationships['res-aldric-thorne'].affinity >= 8);
    assert.equal(a2.character.livingWorld.follower.active, true);
  });

  test('Player-funded Sea Bounties escrow gold, validate naval PvP, and settle durably across disconnect & restart', async (t) => {
    const { world } = await makeWorld(t);
    const poster = world.connect('acct-sb-poster', 'Veyra');
    const target = world.connect('acct-sb-target', 'Blackhand');
    const hunter = world.connect('acct-sb-hunter', 'Hawke');
    poster.player.rpg.gold = 1000;

    assert.equal(poster.act('seaBounty.post', { targetId: poster.id, amount: 200 }).ok, false, 'cannot self-bounty');

    poster.must('seaBounty.post', { targetId: target.id, amount: 300, reason: 'Sank our merchant brig' });
    const bounty = poster.events('seaBounty').at(-1).bounty;
    assert.equal(poster.character.gold, 1000 - 300 - 15, 'principal + 5% fee escrowed');

    hunter.must('seaBounty.accept', { bountyId: bounty.id });
    assert.equal(target.act('seaBounty.accept', { bountyId: bounty.id }).ok, false, 'target cannot accept own bounty');

    // Non-PvP / NPC sink must NOT settle the bounty.
    world.ctx.emit('naval.sunk', { player: hunter.player, vessel: 'v1', target: { kind: 'npc', ownerId: target.id, pvp: false } });
    assert.equal(world.ctx.services.seaBounties.getBounty(bounty.id).status, 'open');

    // Validated naval PvP sink settles into durable claim.
    world.ctx.emit('naval.sunk', { player: hunter.player, vessel: 'v1', target: { kind: 'player', ownerId: target.id, pvp: true, id: 'v2' } });
    assert.equal(world.ctx.services.seaBounties.getBounty(bounty.id).status, 'settled');

    // Hunter disconnects and server restarts before claiming.
    const hunterGoldBefore = hunter.character.gold;
    world.restart();
    const hunter2 = world.connect('acct-sb-hunter', 'Hawke');
    hunter2.must('seaBounty.claim', { bountyId: bounty.id });
    assert.equal(hunter2.character.gold, hunterGoldBefore + 300);
    assert.equal(hunter2.act('seaBounty.claim', { bountyId: bounty.id }).ok, false, 'payout paid strictly once');
  });
});

describe('Survival, Optional DFU Rules, Endgame Builds, Wardrobe, Succession, Expansions & Client UI', () => {
  test('Survival tracks food/water/exposure/camping and respects town camping prohibition', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-surv-a', 'Aldora');

    a.must('survival.toggle', { enabled: true });
    assert.equal(a.character.survival.enabled, true);
    // In Gothway Garden (town), pitching camp must be forbidden.
    assert.equal(a.act('survival.camp', { action: 'pitch' }).ok, false);

    // Move to wilderness, advance 8 hours, eat/drink, and pitch/rest/pack camp.
    a.player.rpg.location = 'wilderness:Daggerfall/0,0';
    world.ctx.services.survival.advance(a.player, 480);
    assert.ok(a.player.rpg.survival.food < 70);
    assert.ok(a.player.rpg.survival.water < 60);

    a.must('survival.eat', {});
    a.must('survival.drink', {});
    a.must('survival.camp', { action: 'pitch' });
    assert.equal(a.character.survival.camp.active, true);
    a.must('survival.camp', { action: 'rest', hours: 2 });
    a.must('survival.camp', { action: 'pack' });
    assert.equal(a.character.survival.camp, null);
  });

  test('Optional DFU rules, magic-item repair, quest debugger, endgame build comparison, wardrobe, succession, expansions', async (t) => {
    const { world } = await makeWorld(t);
    const a = world.connect('acct-opt-a', 'Aldora');
    a.player.rpg.gold = 2000;

    // DFU Enemy Infighting, Enhanced AI, Advanced Climbing
    assert.equal(optionalRulesMod.resolveEnemyInfighting({ id: 1, group: 'undead' }, { id: 2, group: 'orc' }, true).hostile, true);
    assert.equal(optionalRulesMod.resolveEnemyInfighting({ id: 1, group: 'orc' }, { id: 2, group: 'orc' }, true).hostile, false);
    assert.equal(optionalRulesMod.evaluateEnhancedAI({ id: 2, hp: 10, maxHp: 100 }, {}, true).action, 'retreat-and-recover');
    assert.equal(optionalRulesMod.climbingParams(a.player, true).strafeClimb, true);

    // Magic item repair gated by magicItemRepairs & instantRepairs
    a.player.rpg.inventory.push({ id: 'magic-blade-1', template: 'iron-longsword', name: 'Flamebrand', magic: true, condition: 40, maxCondition: 100 });
    assert.equal(a.act('rules.repairItem', { itemId: 'magic-blade-1' }).ok, false, 'magic repair blocked when rule OFF');
    a.must('rules.set', { rule: 'magicItemRepairs', value: true });
    a.must('rules.set', { rule: 'instantRepairs', value: true });
    a.must('rules.repairItem', { itemId: 'magic-blade-1' });
    assert.equal(a.character.inventory.find((i) => i.id === 'magic-blade-1').condition, 100);

    // Quest debugger is character-scoped & read-only
    a.must('rules.questDebug', {});
    const dbg = a.events('questDebug').at(-1).report;
    assert.equal(dbg.ownerId, a.id);
    assert.equal(dbg.scope, 'character-scoped-readonly');

    // Endgame build comparison (Renown + Firmament + Specialization + Equipment Sets)
    a.must('endgame.selectFirmament', { signId: 'mage' });
    a.must('endgame.selectSpec', { specId: 'battlemage' });
    a.must('endgame.compareBuilds', {
      buildA: { renownPoints: 200, firmamentId: 'warrior', specId: 'vanguard', setId: 'set-sentinel-guard', setPieces: 4 },
      buildB: { renownPoints: 200, firmamentId: 'mage', specId: 'arcanist', setId: 'set-direnni-weave', setPieces: 4 },
    });
    const cmp = a.events('buildComparison').at(-1).comparison;
    assert.ok(cmp.delta.spellpower > 0, 'Arcanist + Direnni Spellweave increases spellpower');
    assert.ok(cmp.delta.mitigation < 0, 'Vanguard + Sentinel Guard has higher mitigation');

    // Wardrobe cosmetics (zero stat changes)
    a.must('wardrobe.unlock', { cosmeticId: 'cloak-sentinel-gold' });
    a.must('wardrobe.equip', { slot: 'cloak', cosmeticId: 'cloak-sentinel-gold' });
    assert.equal(a.character.wardrobe.equipped.cloak, 'cloak-sentinel-gold');

    // Family succession
    a.must('succession.designate', { lineageName: 'House Aldora', heirName: 'Seraphina', heirCharacterId: 42 });
    a.must('succession.tagHeirloom', { itemId: 'magic-blade-1' });
    assert.equal(a.character.succession.heirName, 'Seraphina');
    assert.ok(a.character.succession.heirloomItemIds.includes('magic-blade-1'));

    // Beyond-Iliac-Bay expansion hooks
    world.ctx.services.optionalRules.registerExpansion({
      id: 'morrowind-velothi-pass',
      province: 'Morrowind',
      region: 'Velothi Pass',
      manifestVersion: '0.1.0',
      gateLocation: 'town:Wayrest/Wayrest',
      requiredRenownRank: 4,
    });
    a.must('expansion.list', {});
    const exp = a.events('expansions').at(-1).provinces;
    assert.ok(exp.some((p) => p.id === 'skyrim-western-reach'));
    assert.ok(exp.some((p) => p.id === 'morrowind-velothi-pass'));
  });

  test('Client coop-world module installs cleanly and produces DOM-free view models', () => {
    const api = createGameplayApi({ send: () => true });
    installCoopClient(api);
    assert.ok(api.getPanel(PANEL_ID), 'coopWorld panel registered');
    const view = coopWorldView({ character: { location: 'town:Daggerfall/Gothway Garden', survival: { enabled: true, food: 80, water: 70, warmth: 90 } } }, {});
    assert.equal(view.survival.enabled, true);
    assert.equal(view.delves.length, 3);
    assert.equal(view.living.residents.length, 3);
  });
});
