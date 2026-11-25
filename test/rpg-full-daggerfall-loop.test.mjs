// Full end-to-end "Play Daggerfall" multiplayer integration suite + inventory comparison tests.
//
// Runs against the real HTTP + WebSocket server (server/game.js + server/accounts.js + full
// server/rpg/features.js manifest + real SQLite persistence) on an ephemeral port (0) with
// NO ARENA2 game files required, so it executes on every `npm test`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventoryFeature from '../server/rpg/inventory.js';
import * as invModel from '../client/gameplay/inventory/model.js';
import * as charRules from '../client/gameplay/character/rules.js';
import { repairCost } from '../client/gameplay/townServices/rules.js';
import { features as prodFeatures } from '../server/rpg/features.js';
import {
  startLiveWorld,
  accountSession,
  LiveClient,
  readPersisted,
  tempDir,
} from './support/rpg-session.mjs';

// -------------------------------------------------------------------------------------------------
// Part 1: Inventory search, category filter & before/after equipment comparison view-model
// -------------------------------------------------------------------------------------------------

describe('[unit] inventory search, filter and equipment comparison', () => {
  function samplePlayer() {
    const players = new Map();
    const rt = createRpgRuntime({
      players,
      features: [inventoryFeature],
      save: () => {},
      send: () => {},
      now: () => 0,
      log: { error() {}, warn() {}, info() {} },
    });
    const p = { id: 1, name: 'Torvald', x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
    players.set(1, p);
    rt.join(p);
    return p;
  }

  test('itemsForTab supports "all" category and searches name, material, skill and enchantments', () => {
    const p = samplePlayer();
    const enchantedRing = inventoryFeature.addItem(p.rpg, 'ring', 1, {
      extra: {
        magic: {
          identified: true,
          enchantments: [{ type: 7, param: 1 }, { type: 11, param: -1 }],
        },
      },
    });
    enchantedRing.condition = 40;
    enchantedRing.maxCondition = 50;

    const allItems = invModel.itemsForTab(p.rpg.inventory, 'all');
    assert.equal(allItems.length, p.rpg.inventory.length, 'all tab lists every carried item');

    const byMaterial = invModel.itemsForTab(p.rpg.inventory, 'all', 'steel');
    assert.ok(byMaterial.some((i) => i.template === 'steel-dagger'), 'matches material');

    const bySkill = invModel.itemsForTab(p.rpg.inventory, 'all', 'long blade');
    assert.ok(bySkill.some((i) => i.template === 'iron-longsword'), 'matches weapon skill');

    const byEnchant = invModel.itemsForTab(p.rpg.inventory, 'all', 'feather weight');
    assert.deepEqual(byEnchant.map((i) => i.id), [enchantedRing.id], 'matches enchantment effect');

    const desc = Object.fromEntries(invModel.describe(enchantedRing));
    assert.match(desc.Magic, /Weight Allowance \(\+50%\)/);
    assert.match(desc.Magic, /Feather Weight/);
    assert.equal(desc.Charges, '40 / 50');
  });

  test('compareItem reports AC delta, weapon damage delta, weight, condition, enchantments and charges', () => {
    const p = samplePlayer();
    // Equip a shield in leftHand so a two-handed claymore displaces both hands.
    const buckler = inventoryFeature.addItem(p.rpg, 'buckler');
    inventoryFeature.equip(p.rpg, buckler.id);

    const claymore = inventoryFeature.addItem(p.rpg, 'steel-claymore', 1, {
      extra: {
        magic: {
          identified: true,
          enchantments: [{ type: 4, param: 0 }, { type: 2, param: 50 }],
        },
      },
    });
    claymore.condition = 180;
    claymore.maxCondition = 200;

    const cmp = invModel.compareItem(p.rpg, claymore);
    assert.equal(cmp.mode, 'equip');
    assert.equal(cmp.slot, 'rightHand');
    assert.equal(cmp.replaces.length, 2, 'two-handed weapon replaces both right-hand sword and left-hand buckler');

    const rowMap = Object.fromEntries(cmp.rows.map((r) => [r[0], r]));
    assert.ok(rowMap['Armor (AC)'], 'includes AC delta row when replacing shield');
    assert.equal(rowMap['Armor (AC)'][4], -1, 'losing buckler AC is marked worse');
    assert.ok(rowMap.Damage, 'includes weapon damage delta row');
    assert.equal(rowMap.Damage[4], 1, 'steel claymore improves damage over iron longsword');
    assert.ok(rowMap['Weight worn'], 'includes weight delta row');
    assert.ok(rowMap.Condition, 'includes condition/durability row');
    assert.ok(rowMap.Enchantments, 'includes enchantment comparison row');
    assert.match(rowMap.Enchantments[2], /Potent vs \(Undead\)/);
    assert.equal(rowMap.Enchantments[4], 1, 'gaining enchantments is marked better');
    assert.ok(rowMap.Charges, 'includes magic charges row');
    assert.equal(rowMap.Charges[2], '180/200');

    // Remove mode also reports what removing an equipped item costs.
    const wornCuirass = p.rpg.inventory.find((i) => i.equipped === 'chestArmor');
    const removeCmp = invModel.compareItem(p.rpg, wornCuirass);
    assert.equal(removeCmp.mode, 'remove');
    const rmMap = Object.fromEntries(removeCmp.rows.map((r) => [r[0], r]));
    assert.ok(rmMap['Armor (AC)'] && rmMap['Armor (AC)'][4] === -1);
    assert.ok(rmMap['Weight worn'] && rmMap['Weight worn'][4] === 1);
  });
});

// -------------------------------------------------------------------------------------------------
// Part 2: Full "Play Daggerfall" Two-Player Live Multiplayer Loop
// -------------------------------------------------------------------------------------------------

function spendDraft(draft) {
  const career = draft.career; // the server's class (CLASS*.CFG with real data), never the built-in table
  const attributes = charRules.spendLowest({ ...draft.attributeBase }, charRules.ATTRIBUTES, draft.bonusPool);
  const skills = { ...draft.skillBase };
  for (const [, list] of charRules.groupsOf(career)) {
    charRules.spendLowest(skills, list, charRules.SKILL_GROUP_POOL);
  }
  return { attributes, skills };
}

/** Reads the client's latest authoritative (x, z, yaw) from `{type:'state'}` broadcasts. */
function selfPos(client) {
  const id = client.welcome?.id;
  for (let i = client.messages.length - 1; i >= 0; i--) {
    const m = client.messages[i];
    if (m.type === 'state' && Array.isArray(m.players)) {
      const me = m.players.find((p) => p.id === id);
      if (me) return me;
    }
  }
  return null;
}

/** Walks a live WebSocket client to within `reach` metres of (tx, tz) using real `input` frames. */
async function walkTo(client, tx, tz, reach = 1.8, maxMs = 6000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const me = selfPos(client);
    if (me) {
      const dx = tx - me.x;
      const dz = tz - me.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= reach) {
        client.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(dx, -dz) });
        await new Promise((r) => setTimeout(r, 80));
        return selfPos(client) ?? me;
      }
      // Forward vector in server/game.js is (+sin(yaw), -cos(yaw)).
      const yaw = Math.atan2(dx, -dz);
      client.send({ type: 'input', forward: 1, strafe: 0, yaw, run: true });
    } else {
      client.send({ type: 'input', forward: 0, strafe: 0, yaw: 0 });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  const me = selfPos(client);
  throw new Error(`walkTo(${tx}, ${tz}) timed out at (${me?.x?.toFixed(2)}, ${me?.z?.toFixed(2)})`);
}

describe('[live] full "Play Daggerfall" two-player multiplayer loop + restart persistence', () => {
  const GOTHWAY = 'town:Daggerfall/Gothway Garden';
  const DAGGERFALL = 'town:Daggerfall/Daggerfall';

  let tmp;
  let world;
  let jarWarrior;
  let jarMage;
  let warrior;
  let mage;
  const openClients = new Set();

  // Controllable wall clock for deterministic daytime shops, repair wait, and guild training cooldowns.
  // Start at 3E405 4 Morning Star 13:30 (daytime).
  let fakeNowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const buildFeatures = () => prodFeatures.map((f) => {
    if (f.name === 'atmosphere') {
      return {
        name: 'atmosphere',
        install: (ctx) => f.install(ctx, {
          epochMs: Date.UTC(2026, 0, 1, 12, 0, 0),
          wallNow: () => fakeNowMs,
          restSecondsPerHour: 0.02,
        }),
      };
    }
    if (f.name === 'combat') {
      return {
        name: 'combat',
        // Keep the classic Rat encounter close enough to reach quickly via real WS movement.
        install: (ctx) => f.install(ctx, {
          demoPath: [{ x: 2, z: -10, monsters: [0] }],
        }),
      };
    }
    return f;
  });

  async function connectAccount(jar) {
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    openClients.add(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    const welcome = await c.next((m) => m.type === 'welcome' || m.type === 'error', 'welcome');
    assert.equal(welcome.type, 'welcome', welcome.message);
    c.welcome = welcome;
    // Wait for initial RPG snapshot.
    await c.stateWhere((m) => m.selfId === welcome.id && !!m.character, 'initial rpg snapshot');
    return c;
  }

  async function closeAllClients() {
    await Promise.all([...openClients].map((c) => c.close()));
    openClients.clear();
  }

  before(async () => {
    tmp = tempDir('dfw-full-loop-');
    world = await startLiveWorld({ dir: tmp.dir, port: 0, features: buildFeatures() });
    jarWarrior = await accountSession(world.base, 'torvald');
    jarMage = await accountSession(world.base, 'lyra');
    assert.equal(jarWarrior.status, 201, JSON.stringify(jarWarrior.json));
    assert.equal(jarMage.status, 201, JSON.stringify(jarMage.json));
  });

  after(async () => {
    try {
      await closeAllClients();
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  test('1. Register, connect, create contrasting Warrior & Mage, verify starting state, presence & chat', async () => {
    warrior = await connectAccount(jarWarrior);
    mage = await connectAccount(jarMage);
    assert.notEqual(warrior.welcome.id, mage.welcome.id);

    // Roll & create Nord Male Warrior
    assert.equal((await warrior.act('character.roll', { className: 'Warrior' })).ok, true);
    const wDraft = (await warrior.stateWhere((m) => m.character.character?.draft?.className === 'Warrior', 'warrior draft')).character.character.draft;
    const wSpent = spendDraft(wDraft);
    const wCreate = await warrior.act('character.create', {
      name: 'Torvald Ironhand',
      race: 'Nord',
      gender: 'Male',
      reflexes: 'Average',
      faceIndex: 1,
      ...wSpent,
    });
    assert.equal(wCreate.ok, true, wCreate.error);

    // Roll & create High Elf Female Mage
    assert.equal((await mage.act('character.roll', { className: 'Mage' })).ok, true);
    const mDraft = (await mage.stateWhere((m) => m.character.character?.draft?.className === 'Mage', 'mage draft')).character.character.draft;
    const mSpent = spendDraft(mDraft);
    const mCreate = await mage.act('character.create', {
      name: 'Lyra Starweaver',
      race: 'High Elf',
      gender: 'Female',
      reflexes: 'Average',
      faceIndex: 2,
      ...mSpent,
    });
    assert.equal(mCreate.ok, true, mCreate.error);

    const ws = await warrior.stateWhere((m) => m.character.character?.created === true && m.peers.some((p) => p.id === mage.welcome.id), 'warrior created & sees mage');
    const ms = await mage.stateWhere((m) => m.character.character?.created === true && m.peers.some((p) => p.id === warrior.welcome.id), 'mage created & sees warrior');

    // Contrasting classic classes, races, vitals, and authentic starter kit
    assert.equal(ws.character.character.className, 'Warrior');
    assert.equal(ws.character.character.race, 'Nord');
    assert.equal(ms.character.character.className, 'Mage');
    assert.equal(ms.character.character.race, 'High Elf');
    assert.ok(ws.character.character.maxHealth > 0 && ms.character.character.maxMagicka > ws.character.character.maxMagicka, 'Mage has higher starting magicka than Warrior');
    assert.equal(ws.character.gold, 100);
    assert.equal(ms.character.gold, 100);
    assert.equal(ws.character.location, GOTHWAY);
    assert.ok(ws.character.inventory.some((i) => i.template === 'iron-longsword' && i.equipped === 'rightHand'), 'Warrior starts with equipped iron longsword');

    // Public peer isolation
    const peerMage = ws.peers.find((p) => p.id === mage.welcome.id);
    assert.ok(peerMage, 'Warrior sees Mage as peer');
    assert.ok(!('inventory' in peerMage) && !('gold' in peerMage), 'peer state leaks no private fields');

    // Two-player region chat crosses WebSockets
    const chatMark = mage.messages.length;
    const chatRes = await warrior.act('chat.send', { channel: 'region', text: 'Well met in Gothway Garden, Lyra!' });
    assert.equal(chatRes.ok, true, chatRes.error);
    mage.cursor = chatMark;
    const chatEv = await mage.next((m) => m.type === 'gameEvent' && m.event.kind === 'chat' && m.event.fromId === warrior.welcome.id, 'region chat received by mage');
    assert.equal(chatEv.event.text, 'Well met in Gothway Garden, Lyra!');
  });

  test('2. Combat encounter: shared hits, skill practice, kill & single-claim corpse loot race', async () => {
    // Wait for the seeded Rat monster in Gothway Garden.
    const snap = await warrior.stateWhere((m) => m.entities.some((e) => e.kind === 'monster' && !e.dead), 'seeded monster');
    const rat = snap.entities.find((e) => e.kind === 'monster' && !e.dead);
    assert.ok(rat, 'seeded Rat exists');

    // Walk both players within melee range of the Rat over real WebSocket input.
    await Promise.all([
      walkTo(warrior, rat.x, rat.z + 1.1, 1.8),
      walkTo(mage, rat.x + 0.9, rat.z + 1.1, 2.0),
    ]);

    assert.equal((await warrior.act('combat.ready', { ready: true })).ok, true);
    assert.equal((await mage.act('combat.ready', { ready: true })).ok, true);

    const wSkillBefore = warrior.state.character.character.skillUses['Long Blade'] ?? 0;
    let sawHit = false;
    let corpse = null;

    // Both swing until the Rat falls (handling misses and swing cooldowns).
    for (let attempt = 0; attempt < 35; attempt++) {
      const liveRat = warrior.state?.entities?.find((e) => e.id === rat.id);
      if (liveRat?.dead) {
        corpse = liveRat;
        break;
      }
      if (!liveRat) break;
      const wPos = selfPos(warrior);
      const mPos = selfPos(mage);
      if (wPos) warrior.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(liveRat.x - wPos.x, -(liveRat.z - wPos.z)) });
      if (mPos) mage.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(liveRat.x - mPos.x, -(liveRat.z - mPos.z)) });

      const hitMark = mage.messages.length;
      await warrior.act('combat.attack', { targetId: rat.id, direction: 'down' });
      await mage.act('combat.attack', { targetId: rat.id, direction: 'down' });
      if (mage.messages.slice(hitMark).some((m) => m.type === 'gameEvent' && m.event.kind === 'hit' && m.event.entityId === rat.id)) {
        sawHit = true;
      }
      await new Promise((r) => setTimeout(r, 260));
    }

    corpse = (await warrior.stateWhere((m) => m.entities.some((e) => e.id === rat.id && e.dead), 'rat corpse')).entities.find((e) => e.id === rat.id);
    assert.ok(corpse && corpse.dead, 'Rat defeated into a corpse');
    assert.ok(sawHit || warrior.messages.some((m) => m.type === 'gameEvent' && m.event.kind === 'hit' && m.event.entityId === rat.id), 'shared hit event observed');

    const wSkillAfter = warrior.state.character.character.skillUses['Long Blade'] ?? 0;
    assert.ok(wSkillAfter > wSkillBefore, 'combat practiced Long Blade skill');

    // Race both sockets to claim the same corpse: single-claim guarantee.
    await Promise.all([
      walkTo(warrior, corpse.x, corpse.z, 2.2),
      walkTo(mage, corpse.x, corpse.z, 2.2),
    ]);
    const [lootW, lootM] = await Promise.all([
      warrior.act('combat.loot', { targetId: corpse.id }),
      mage.act('combat.loot', { targetId: corpse.id }),
    ]);
    assert.equal([lootW.ok, lootM.ok].filter(Boolean).length, 1, `corpse claimed exactly once (W:${lootW.error ?? 'ok'} M:${lootM.error ?? 'ok'})`);

    // Sheathe weapons so resting is allowed later.
    assert.equal((await warrior.act('combat.ready', { ready: false })).ok, true);
    assert.equal((await mage.act('combat.ready', { ready: false })).ok, true);
  });

  test('3. Shop buy/sell, inventory equip/unequip (with peer weapon broadcast), and smith repair', async () => {
    const merchant = warrior.state.entities.find((e) => e.kind === 'npc' && e.role === 'merchant');
    assert.ok(merchant, 'merchant present in Gothway Garden');
    await walkTo(warrior, merchant.x, merchant.z + 1.0, 2.2);

    let talkMark = warrior.messages.length;
    assert.equal((await warrior.act('npc.talk', { targetId: merchant.id })).ok, true);
    warrior.cursor = talkMark;
    const dlg = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue' && m.event.entityId === merchant.id, 'merchant dialogue');
    const session = dlg.event.session;
    assert.ok(session, 'dialogue session established');

    // Open the trade screen via npc.topic { topic: 'trade' }.
    talkMark = warrior.messages.length;
    assert.equal((await warrior.act('npc.topic', { targetId: merchant.id, session, topic: 'trade' })).ok, true);
    warrior.cursor = talkMark;
    const tradeDlg = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue' && m.event.entityId === merchant.id && !!m.event.shop, 'merchant trade dialogue');
    assert.ok(tradeDlg.event.shop.items.length > 0, 'merchant offers stocked goods');

    // Buy the cheapest affordable item from stock.
    const affordable = tradeDlg.event.shop.items
      .filter((s) => s.price > 0 && s.price <= warrior.state.character.gold)
      .sort((a, b) => a.price - b.price)[0];
    assert.ok(affordable, 'at least one affordable shop item');
    const goldBeforeBuy = warrior.state.character.gold;
    const buyRes = await warrior.act('npc.buy', { targetId: merchant.id, session, key: affordable.key, quantity: 1, price: affordable.price });
    assert.equal(buyRes.ok, true, buyRes.error);
    const afterBuy = await warrior.stateWhere((m) => m.character.gold === goldBeforeBuy - affordable.price, 'gold updated after buy');
    assert.equal(afterBuy.character.gold, goldBeforeBuy - affordable.price);

    // Sell unequipped surplus items to the merchant to earn gold for guild training & travel.
    const sellCandidates = tradeDlg.event.shop.sellable.filter((s) => s.name !== 'Iron Mace' && s.price > 0);
    assert.ok(sellCandidates.length > 0, 'carries sellable items');
    const goldBeforeSell = afterBuy.character.gold;
    let soldCount = 0;
    for (const offer of sellCandidates) {
      if (warrior.state.character.gold >= 450 && soldCount >= 1) break;
      const gNow = warrior.state.character.gold;
      const sellRes = await warrior.act('npc.sell', { targetId: merchant.id, session, itemId: offer.itemId, quantity: 1, price: offer.price });
      if (sellRes.ok) {
        soldCount++;
        await warrior.stateWhere((m) => m.character.gold > gNow, 'gold increased after item sale');
      }
    }
    assert.ok(soldCount >= 1, 'sold at least one item');
    const afterSell = await warrior.stateWhere((m) => m.character.gold > goldBeforeSell, 'gold increased after sale');
    assert.ok(afterSell.character.gold > goldBeforeSell, 'gold increased after sale');
    await warrior.act('npc.leave', {});

    // Equip/unequip cycle: equip iron-mace, verify Mage sees updated public weapon, then re-equip longsword.
    const mace = afterSell.character.inventory.find((i) => i.template === 'iron-mace');
    const sword = afterSell.character.inventory.find((i) => i.template === 'iron-longsword');
    assert.ok(mace && sword);
    assert.equal((await warrior.act('inventory.equip', { itemId: mace.id })).ok, true);
    await mage.stateWhere((m) => m.peers.find((p) => p.id === warrior.welcome.id)?.weapon?.template === 'iron-mace', 'Mage sees Warrior equip mace');
    assert.equal((await warrior.act('inventory.unequip', { itemId: mace.id })).ok, true);
    await warrior.stateWhere((m) => !m.character.equipment.rightHand, 'Warrior right hand empty after unequip');
    assert.equal((await warrior.act('inventory.equip', { itemId: sword.id })).ok, true);
    await warrior.stateWhere((m) => m.character.equipment.rightHand === sword.id, 'Warrior re-equipped longsword');

    // Travel to Daggerfall city to test Smith repair if the sword took combat wear (and verify repair flow).
    const travelToCity = await warrior.act('travel.go', { to: DAGGERFALL });
    assert.equal(travelToCity.ok, true, travelToCity.error);
    const inCity = await warrior.stateWhere(
      (m) => m.character.location === DAGGERFALL && m.entities.some((e) => e.kind === 'npc' && e.role === 'smith'),
      'arrived in Daggerfall with smith'
    );
    const smith = inCity.entities.find((e) => e.kind === 'npc' && e.role === 'smith');
    assert.ok(smith, 'smith present in Daggerfall');
    await walkTo(warrior, smith.x, smith.z + 1.0, 2.2);

    const svcMark = warrior.messages.length;
    assert.equal((await warrior.act('town.services', {})).ok, true);
    warrior.cursor = svcMark;
    const svcEv = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'townServices.counters', 'townServices counters');
    const repairCounter = svcEv.event.counters?.find((c) => c.services?.includes('repair'));
    assert.ok(repairCounter, 'repair counter available at Daggerfall smith');

    const wornItem = warrior.state.character.inventory.find((i) => i.condition < i.maxCondition && ['weapon', 'armor', 'shield'].includes(i.group));
    if (wornItem) {
      const rank = warrior.state.character.guilds?.fighters?.rank ?? null;
      const cost = repairCost(wornItem, repairCounter.quality, rank, {
        ...svcEv.event.trade,
        ...(svcEv.event.market ? { adjust: svcEv.event.market.adjust } : {}),
      });
      if (cost > 0 && warrior.state.character.gold >= cost) {
        const leaveRes = await warrior.act('repair.leave', { counterId: repairCounter.id, itemId: wornItem.id, cost });
        assert.equal(leaveRes.ok, true, leaveRes.error);
        const withTicket = await warrior.stateWhere((m) => m.character.townServices?.repairs?.length > 0, 'repair ticket issued');
        const ticket = withTicket.character.townServices.repairs[0];
        // Advance shared world clock by 25 in-game hours (25 * 60 / 12 = 125 real minutes in 12x timescale).
        fakeNowMs += 130 * 60 * 1000;
        const collectRes = await warrior.act('repair.collect', { counterId: repairCounter.id, ticket: ticket.ticket });
        assert.equal(collectRes.ok, true, collectRes.error);
        const repairedState = await warrior.stateWhere((m) => m.character.inventory.some((i) => i.id === wornItem.id && i.condition === i.maxCondition), 'repaired item returned at full condition');
        assert.equal(repairedState.character.inventory.find((i) => i.id === wornItem.id).condition, wornItem.maxCondition);
      }
    }

    // Return Warrior to Gothway Garden for guilds & party.
    await new Promise((r) => setTimeout(r, 1600)); // travel cooldown
    const backRes = await warrior.act('travel.go', { to: GOTHWAY });
    assert.equal(backRes.ok, true, backRes.error);
    await warrior.stateWhere(
      (m) => m.character.location === GOTHWAY && m.entities.some((e) => e.kind === 'npc' && e.role === 'fighters'),
      'Warrior returned to Gothway Garden'
    );
  });

  test('4. Guild join & training, rest/calendar advancement, skill raises and level-up', async () => {
    // Warrior joins Fighters Guild and trains.
    const fightersNpc = warrior.state.entities.find((e) => e.kind === 'npc' && e.role === 'fighters');
    assert.ok(fightersNpc, 'Fighters Guild representative in Gothway Garden');
    await walkTo(warrior, fightersNpc.x, fightersNpc.z + 1.0, 2.2);
    let mark = warrior.messages.length;
    assert.equal((await warrior.act('npc.talk', { targetId: fightersNpc.id })).ok, true);
    warrior.cursor = mark;
    const fDlg = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue' && m.event.entityId === fightersNpc.id, 'fighters dialogue');
    const fSession = fDlg.event.session;

    assert.equal((await warrior.act('npc.service', { targetId: fightersNpc.id, session: fSession, service: 'join' })).ok, true);
    const wGuildState = await warrior.stateWhere((m) => m.character.guilds?.fighters != null, 'Warrior joined Fighters Guild');
    assert.equal(typeof wGuildState.character.guilds.fighters.rank, 'number');

    // Train a Warrior primary skill (Long Blade) in the Fighters Guild.
    const train1 = await warrior.act('npc.service', { targetId: fightersNpc.id, session: fSession, service: 'train', skill: 'Long Blade' });
    assert.equal(train1.ok, true, train1.error);
    await warrior.act('npc.leave', {});

    // Mage joins Mages Guild and trains.
    const magesNpc = mage.state.entities.find((e) => e.kind === 'npc' && e.role === 'mages');
    assert.ok(magesNpc, 'Mages Guild representative in Gothway Garden');
    await walkTo(mage, magesNpc.x, magesNpc.z + 1.0, 2.2);
    mark = mage.messages.length;
    assert.equal((await mage.act('npc.talk', { targetId: magesNpc.id })).ok, true);
    mage.cursor = mark;
    const mDlg = await mage.next((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue' && m.event.entityId === magesNpc.id, 'mages dialogue');
    const mSession = mDlg.event.session;

    assert.equal((await mage.act('npc.service', { targetId: magesNpc.id, session: mSession, service: 'join' })).ok, true);
    const mGuildState = await mage.stateWhere((m) => m.character.guilds?.mages != null, 'Mage joined Mages Guild');
    assert.equal(typeof mGuildState.character.guilds.mages.rank, 'number');

    const mTrain = await mage.act('npc.service', { targetId: magesNpc.id, session: mSession, service: 'train', skill: 'Destruction' });
    assert.equal(mTrain.ok, true, mTrain.error);
    await mage.act('npc.leave', {});

    // Rest & calendar advancement: loiter 10 hours so personal time advances past the 6h skill check
    // and 12h training cooldown (3h training + 10h rest = 13h > 12h).
    const personalBefore = warrior.state.character.atmosphere?.personalMinutes ?? 0;
    const restMark = warrior.messages.length;
    const rest1Res = await warrior.act('rest.start', { mode: 'loiter', hours: 10 });
    assert.equal(rest1Res.ok, true, rest1Res.error);
    warrior.cursor = restMark;
    await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'rest' && m.event.state === 'done', 'Warrior finished first rest');
    const afterRest1 = await warrior.stateWhere((m) => (m.character.atmosphere?.personalMinutes ?? 0) >= personalBefore + 600, 'personalMinutes advanced by 10 hours');
    assert.ok(afterRest1.character.atmosphere.personalMinutes >= personalBefore + 600, 'calendar personal clock advanced by 10 hours');

    // Train additional Fighters Guild skills (resting 10h between sessions) to push Warrior to Level 2!
    const lbBefore = afterRest1.character.character.skills['Long Blade'];
    let leveledUp = afterRest1.character.character.level >= 2;
    const trainQueue = ['Critical Strike', 'Long Blade', 'Blunt Weapon', 'Axe'];
    for (let round = 0; round < trainQueue.length && !leveledUp; round++) {
      const tMark = warrior.messages.length;
      assert.equal((await warrior.act('npc.talk', { targetId: fightersNpc.id })).ok, true);
      warrior.cursor = tMark;
      const d = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue' && m.event.entityId === fightersNpc.id, 'fighters dialogue');
      const tr = await warrior.act('npc.service', { targetId: fightersNpc.id, session: d.event.session, service: 'train', skill: trainQueue[round] });
      await warrior.act('npc.leave', {});
      if (tr.ok) {
        const rMark = warrior.messages.length;
        const rest1Res = await warrior.act('rest.start', { mode: 'loiter', hours: 10 });
    assert.equal(rest1Res.ok, true, rest1Res.error);
        warrior.cursor = rMark;
        await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'rest' && m.event.state === 'done', 'rest done');
        const st = await warrior.stateWhere(() => true);
        if (st.character.character.level >= 2) leveledUp = true;
      }
    }

    const levelSnap = await warrior.stateWhere(() => true);
    assert.ok(levelSnap.character.character.skills['Long Blade'] >= lbBefore, 'trained skill raised');
    assert.ok(levelSnap.character.character.level >= 2, `Warrior reached level 2 (got ${levelSnap.character.character.level})`);
    assert.ok(levelSnap.character.character.bonusPoints > 0, 'level-up granted attribute bonus points');

    // Distribute all level-up attribute bonus points via character.levelUp.
    const attrs = { ...levelSnap.character.character.attributes };
    attrs.Strength = Math.min(100, attrs.Strength + levelSnap.character.character.bonusPoints);
    const lvlRes = await warrior.act('character.levelUp', { attributes: attrs });
    assert.equal(lvlRes.ok, true, lvlRes.error);
    const afterLvl = await warrior.stateWhere((m) => m.character.character.bonusPoints === 0, 'bonus points spent');
    assert.equal(afterLvl.character.character.attributes.Strength, attrs.Strength);
  });

  test('5. Party formation, travel, discoveries, and full server restart persistence', async () => {
    // Party formation + party chat.
    assert.equal((await warrior.act('party.invite', { targetId: mage.welcome.id })).ok, true);
    assert.equal((await mage.act('party.accept', { fromId: warrior.welcome.id })).ok, true);
    const pW = await warrior.stateWhere((m) => m.character.party?.members?.length === 2, 'Warrior in party of 2');
    const pM = await mage.stateWhere((m) => m.character.party?.members?.length === 2, 'Mage in party of 2');
    assert.equal(pW.character.party.id, pM.character.party.id);

    const pChatMark = warrior.messages.length;
    assert.equal((await mage.act('chat.send', { channel: 'party', text: 'Onward to Daggerfall!' })).ok, true);
    warrior.cursor = pChatMark;
    const pChatEv = await warrior.next((m) => m.type === 'gameEvent' && m.event.kind === 'chat' && m.event.channel === 'party', 'party chat');
    assert.equal(pChatEv.event.text, 'Onward to Daggerfall!');

    // Both travel to Daggerfall city, recording discoveries & reuniting as peers.
    await new Promise((r) => setTimeout(r, 1600)); // travel cooldown
    const tW = await warrior.act('travel.go', { to: DAGGERFALL });
    assert.equal(tW.ok, true, tW.error);
    const tM = await mage.act('travel.go', { to: DAGGERFALL });
    assert.equal(tM.ok, true, tM.error);

    const beforeW = (await warrior.stateWhere((m) => m.character.location === DAGGERFALL && m.peers.some((p) => p.id === mage.welcome.id), 'Warrior in Daggerfall with Mage')).character;
    const beforeM = (await mage.stateWhere((m) => m.character.location === DAGGERFALL && m.peers.some((p) => p.id === warrior.welcome.id), 'Mage in Daggerfall with Warrior')).character;
    // Walk to distinct coordinates in Daggerfall so restart proves exact position persistence too.
    await Promise.all([
      walkTo(warrior, 2.5, -2.5, 0.8),
      walkTo(mage, -2.5, -2.5, 0.8),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const beforeWPos = { ...selfPos(warrior) };
    const beforeMPos = { ...selfPos(mage) };

    // Full server shutdown + cold restart on the exact same SQLite database files!
    const wId = warrior.welcome.id;
    const mId = mage.welcome.id;
    await closeAllClients();
    await world.close();
    world = await startLiveWorld({ dir: tmp.dir, port: 0, features: buildFeatures() });

    // Reconnect both accounts with their existing session cookies.
    const warrior2 = await connectAccount(jarWarrior);
    const mage2 = await connectAccount(jarMage);
    assert.equal(warrior2.welcome.id, wId);
    assert.equal(mage2.welcome.id, mId);

    const afterWState = await warrior2.stateWhere((m) => m.peers.some((p) => p.id === mId), 'Warrior sees Mage after restart');
    const afterMState = await mage2.stateWhere((m) => m.peers.some((p) => p.id === wId), 'Mage sees Warrior after restart');
    const afterW = afterWState.character;
    const afterM = afterMState.character;
    const afterWPos = selfPos(warrior2);
    const afterMPos = selfPos(mage2);

    // Verify complete persistence for Warrior and Mage:
    // position/location, inventory, equipment, gold, guild rank, skills, level, attributes, party, discoveries.
    for (const [label, before, after, bPos, aPos, id] of [
      ['Warrior', beforeW, afterW, beforeWPos, afterWPos, wId],
      ['Mage', beforeM, afterM, beforeMPos, afterMPos, mId],
    ]) {
      assert.equal(after.location, before.location, `${label}: location persisted`);
      assert.ok(Math.abs(aPos.x - bPos.x) < 0.05 && Math.abs(aPos.z - bPos.z) < 0.05, `${label}: position persisted`);
      assert.deepEqual(
        after.inventory.map((i) => ({ id: i.id, template: i.template, qty: i.quantity, cond: i.condition })).sort((a, b) => a.id.localeCompare(b.id)),
        before.inventory.map((i) => ({ id: i.id, template: i.template, qty: i.quantity, cond: i.condition })).sort((a, b) => a.id.localeCompare(b.id)),
        `${label}: inventory persisted identically`
      );
      assert.deepEqual(after.equipment, before.equipment, `${label}: equipment persisted`);
      assert.equal(after.gold, before.gold, `${label}: gold persisted`);
      assert.deepEqual(after.guilds, before.guilds, `${label}: guild membership and rank persisted`);
      assert.deepEqual(after.character.skills, before.character.skills, `${label}: skills persisted`);
      assert.equal(after.character.level, before.character.level, `${label}: level persisted`);
      assert.deepEqual(after.character.attributes, before.character.attributes, `${label}: attributes persisted`);
      assert.equal(after.party?.id, before.party?.id, `${label}: party persisted`);
      assert.deepEqual(after.travel?.discovered, before.travel?.discovered, `${label}: travel discoveries persisted`);
      assert.equal(readPersisted(world.dbPath, id).rpg.gold, before.gold, `${label}: SQLite matches live state`);
    }
  });
});
