// Multi-system shared-world integration: two independent accounts, two sessions, one world.
//
// Layers (see docs/gameplay-coverage.md for the run matrix):
//   [fixture] real runtime + real server/rpg feature modules + real SQLite file; in-process clients.
//   [live]    real server/game.js + server/accounts.js on loopback, two registered accounts, two
//             real WebSockets, restart on the same database files.
// Cases whose feature has not landed run anyway and are reported as TODO with the missing piece
// (node:test `todo`). RPG_INTEGRATION_STRICT=1 makes every gap a failure for final integration.
// No art, text or audio from game archives is used: assets are not needed for server state.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { walkingRoute } from './support/walking-route.mjs';
import {
  discoverFeatures,
  createFixtureWorld,
  readPersisted,
  startLiveWorld,
  accountSession,
  LiveClient,
  withSeededRandom,
  tempDir,
  gap,
  STRICT,
  localArena2,
  withWorldClock,
  featuresWithQuestCatalog,
} from './support/rpg-session.mjs';

const discovered = await discoverFeatures();
const featureNames = discovered.features.map((f) => f.name);
const has = (name) => featureNames.some((n) => n === name || n.endsWith(`/${name}`) || n.startsWith(`${name}/`));

// Verbs are only known after install; probe once with a throwaway world.
const probeDir = tempDir();
const probe = await createFixtureWorld({ dbPath: `${probeDir.dir}/probe.db`, features: discovered.features });
const VERBS = new Map(probe.verbs);
const EVENTS = new Set(probe.eventNames);
const SERVICES = new Set(Object.keys(probe.ctx.services));
const INSTALL_ERRORS = [...probe.installErrors];
probe.close();
probeDir.remove();

const verb = (...candidates) => candidates.find((v) => VERBS.has(v)) ?? null;
const verbsWith = (re) => [...VERBS.keys()].filter((v) => re.test(v));
const needVerb = (...c) => (verb(...c) ? null : `no ${c.join('/')} action registered`);
const needService = (s) => (SERVICES.has(s) ? null : `ctx.services.${s} not provided`);

function report() {
  return {
    source: discovered.source,
    features: featureNames,
    verbs: Object.fromEntries(VERBS),
    events: [...EVENTS],
    services: [...SERVICES].sort(),
    importErrors: discovered.errors,
    installErrors: INSTALL_ERRORS,
  };
}

/** Builds a fresh world with two account-backed characters standing next to each other. */
async function twoPlayerWorld(t, { seed } = {}) {
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/world.db`;
  const world = await createFixtureWorld({ dbPath, features: discovered.features, ...(seed != null ? { seed: Number(process.env.RPG_FIGHT_SEED ?? seed) } : {}) });
  t.after(() => {
    try {
      world.close();
    } finally {
      tmp.remove();
    }
  });
  const a = world.connect('acct-a', 'Aldora');
  const b = world.connect('acct-b', 'Brannoc');
  // Collision geometry loads asynchronously (an open plane without operator data); combat line of
  // sight and movement wait for it, exactly as on the live server.
  await world.ctx.services.collision?.whenSettled?.(a.character.location);
  a.moveTo(0, 0);
  b.moveTo(1, 0);
  world.tick(40);
  return { world, a, b, dbPath };
}

const gold = (c) => c.character.gold;
const itemsOf = (c, template) => c.character.inventory.filter((i) => i.template === template);
const countOf = (c, template) => itemsOf(c, template).reduce((n, i) => n + i.quantity, 0);
const allIds = (c) => c.character.inventory.map((i) => i.id);

// -------------------------------------------------------------------------------------------------

describe('[fixture] feature surface', () => {
  test('every server/rpg feature module imports and installs without error', (t) => {
    t.diagnostic(JSON.stringify(report()));
    assert.deepEqual(discovered.errors, [], 'feature modules failed to import');
    assert.deepEqual(INSTALL_ERRORS, [], 'feature install(ctx) threw');
    assert.ok(featureNames.length > 0, 'no RPG feature exports install(ctx)');
  });

  test('production manifest lists the installed features', { todo: gap([discovered.source === 'manifest' ? null : 'server/rpg/features.js manifest is empty; features were discovered by directory scan']) }, () => {
    assert.equal(discovered.source, 'manifest');
  });
});

describe('[fixture] accounts, characters and ownership', () => {
  test('two accounts get separate persistent characters with one starter kit each', { todo: gap([has('inventory') ? null : 'inventory feature missing']) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    assert.notEqual(a.id, b.id);
    for (const c of [a, b]) {
      assert.equal(c.state.selfId, c.id);
      assert.equal(c.character.location, 'town:Daggerfall/Gothway Garden');
      assert.equal(countOf(c, 'iron-longsword'), 1, 'starter longsword');
      assert.equal(gold(c), 100, 'starter gold');
      const sword = itemsOf(c, 'iron-longsword')[0];
      assert.equal(c.character.equipment.rightHand, sword.id, 'longsword readied in right hand');
    }
    // Item ids are unique across both characters: no shared object references.
    const ids = [...allIds(a), ...allIds(b)];
    assert.equal(new Set(ids).size, ids.length, 'item ids collide between characters');

    // Each sees the other only through public peer fields; private state never leaks.
    const peerB = a.peer(b.id);
    assert.ok(peerB, 'A sees B as a peer');
    for (const k of ['inventory', 'gold', 'equipment', 'quests', 'character', 'rpg']) assert.ok(!(k in peerB), `peer leaks ${k}`);
    assert.equal(peerB.weapon?.template, 'iron-longsword', 'peer shows readied weapon');

    // Cold restart: kit is not granted twice; ids and gold survive bit-for-bit.
    const before = { a: structuredClone(a.character), b: structuredClone(b.character) };
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    const b2 = world.connect('acct-b', 'Brannoc');
    assert.equal(a2.id, a.id);
    assert.equal(b2.id, b.id);
    assert.deepEqual(allIds(a2).sort(), before.a.inventory.map((i) => i.id).sort());
    assert.deepEqual(allIds(b2).sort(), before.b.inventory.map((i) => i.id).sort());
    assert.equal(gold(a2), 100);
    assert.equal(countOf(b2, 'iron-longsword'), 1);
    assert.equal(readPersisted(dbPath, a.id).rpg.gold, 100);
  });

  test("one player cannot act on another player's items", { todo: gap([needVerb('inventory.equip'), needVerb('inventory.drop')]) }, async (t) => {
    const { a, b } = await twoPlayerWorld(t);
    const bDagger = itemsOf(b, 'steel-dagger')[0];
    const bInv = structuredClone(b.character.inventory);
    for (const [v, args] of [
      ['inventory.equip', { itemId: bDagger.id }],
      ['inventory.use', { itemId: bDagger.id }],
      ['inventory.drop', { itemId: bDagger.id }],
      ['inventory.unequip', { itemId: b.character.equipment.rightHand }],
    ]) {
      if (!VERBS.has(v)) continue;
      const r = a.act(v, args);
      assert.equal(r.ok, false, `${v} on B's item must fail`);
    }
    assert.deepEqual(b.character.inventory, bInv, "B's inventory untouched");
    assert.equal(a.character.inventory.some((i) => i.id === bDagger.id), false);
  });

  test('equipment change is private state + public peer view, and persists', { todo: gap([needVerb('inventory.equip')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    const mace = itemsOf(a, 'iron-mace')[0];
    a.must('inventory.equip', { itemId: mace.id });
    assert.equal(a.character.equipment.rightHand, mace.id);
    assert.equal(a.item(mace.id).equipped, 'rightHand');
    assert.equal(itemsOf(a, 'iron-longsword')[0].equipped, undefined, 'previous weapon unequipped');
    assert.equal(b.peer(a.id).weapon.template, 'iron-mace', "B sees A's new weapon");
    assert.equal(readPersisted(dbPath, a.id).rpg.equipment.rightHand, mace.id, 'saved in the action transaction');
    // Equipped items cannot be dropped (no dupe-by-drop of worn gear).
    if (VERBS.has('inventory.drop')) assert.equal(a.act('inventory.drop', { itemId: mace.id }).ok, false);
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    assert.equal(a2.character.equipment.rightHand, mace.id);
  });

  test('a rejected action rolls back every change and is not persisted', { todo: gap([needVerb('inventory.loot')]) }, async (t) => {
    const { a, dbPath } = await twoPlayerWorld(t);
    const saved = JSON.stringify(readPersisted(dbPath, a.id).rpg);
    const live = JSON.stringify(a.character);
    const r = a.act('inventory.loot', { targetId: 'loot-does-not-exist' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.equal(JSON.stringify(a.world.players.get(a.id).rpg), live);
    assert.equal(JSON.stringify(readPersisted(dbPath, a.id).rpg), saved);
  });
});

describe('[fixture] shared loot is claimed exactly once', () => {
  test('both players race for one pile: one owner, gold conserved, pile gone for both', { todo: gap([needService('spawnLoot'), needVerb('inventory.loot')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    const loc = a.character.location;
    const pileId = world.ctx.services.spawnLoot(loc, 0.5, 0, [
      { template: 'gold', quantity: 37 },
      { template: 'ruby', quantity: 1 },
    ]);
    world.tick(40);
    assert.ok(a.entity(pileId) && b.entity(pileId), 'both see the pile');
    const totalGold = gold(a) + gold(b);

    a.must('inventory.loot', { targetId: pileId });
    const second = b.act('inventory.loot', { targetId: pileId });
    assert.equal(second.ok, false, 'second looter gets nothing');
    assert.equal(gold(a) + gold(b), totalGold + 37, 'exactly 37 gold entered the world');
    assert.equal(gold(a), 137);
    assert.equal(countOf(a, 'ruby'), 1);
    assert.equal(countOf(b, 'ruby'), 0);
    assert.equal(a.entity(pileId), null, 'pile removed for A');
    assert.equal(b.entity(pileId), null, 'pile removed for B');
    assert.equal(readPersisted(dbPath, a.id).rpg.gold, 137);
    assert.equal(readPersisted(dbPath, b.id).rpg.gold, 100);
    // Retrying after restart cannot re-claim it (loot is not resurrected).
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    assert.equal(a2.act('inventory.loot', { targetId: pileId }).ok, false);
    assert.equal(gold(a2), 137);
  });

  test('loot is out of reach from a distance and from another location', { todo: gap([needService('spawnLoot'), needVerb('inventory.loot')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    const pileId = world.ctx.services.spawnLoot(a.character.location, 0, 0, [{ template: 'gold', quantity: 5 }]);
    b.moveTo(40, 40);
    assert.equal(b.act('inventory.loot', { targetId: pileId }).ok, false, 'too far');
    b.moveTo(0, 0);
    world.players.get(b.id).rpg.location = 'town:Daggerfall/Elsewhere';
    world.tick(40);
    assert.equal(b.entity(pileId), null, 'pile not visible in another location');
    assert.equal(b.act('inventory.loot', { targetId: pileId }).ok, false, 'other location');
    assert.equal(gold(b), 100);
  });

  test('dropping an item hands it over exactly once', { todo: gap([needVerb('inventory.drop'), needVerb('inventory.loot')]) }, async (t) => {
    const { a, b } = await twoPlayerWorld(t);
    const axe = itemsOf(a, 'iron-battle-axe')[0];
    a.must('inventory.drop', { itemId: axe.id });
    const pile = b.state.entities.find((e) => e.kind === 'loot');
    assert.ok(pile, 'B sees the dropped pile');
    b.must('inventory.loot', { targetId: pile.id });
    assert.equal(countOf(a, 'iron-battle-axe'), 0);
    assert.equal(countOf(b, 'iron-battle-axe'), 2);
    const got = itemsOf(b, 'iron-battle-axe').find((i) => i.id === axe.id);
    assert.ok(got, 'the same item record (id, condition) changed owner');
    assert.equal(a.act('inventory.loot', { targetId: pile.id }).ok, false);
  });
});

// ---- character -----------------------------------------------------------------------------

const R = await import('../client/gameplay/character/rules.js');

/** Rolls and creates a classic character with a valid point spend. Returns the created record. */
function createCharacter(c, { className = 'Spellsword', race = 'Breton', gender = 'Female' } = {}) {
  c.must('character.roll', { className });
  const d = c.character.character.draft;
  assert.ok(d, 'roll stored a draft on the character');
  const attributes = { ...d.attributeBase };
  let pool = d.bonusPool;
  for (const a of R.ATTRIBUTES) {
    const add = Math.min(pool, R.MAX_STAT - attributes[a]);
    attributes[a] += add;
    pool -= add;
  }
  const career = R.CLASSES.find((k) => k.name === d.className);
  const skills = {};
  for (const g of ['primary', 'major', 'minor']) {
    const first = R.SKILLS.find((s) => R.skillGroupOf(career, s) === g);
    skills[first] = d.skillBase[first] + R.SKILL_GROUP_POOL;
  }
  c.must('character.create', { race, gender, attributes, skills });
  return c.character.character;
}

describe('[fixture] character', () => {
  test('roll + create sets classic attributes, skills and vitals for its owner only', { todo: gap([needVerb('character.roll'), needVerb('character.create')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    const bBefore = structuredClone(b.character.character);
    const ch = createCharacter(a);
    assert.equal(ch.race, 'Breton');
    assert.equal(ch.className, 'Spellsword');
    assert.equal(ch.created, true);
    for (const attr of R.ATTRIBUTES) assert.ok(Number.isInteger(ch.attributes[attr]), `attribute ${attr}`);
    assert.ok(Object.keys(ch.skills).length >= 30, 'classic skill list');
    for (const [v, m] of [['health', 'maxHealth'], ['fatigue', 'maxFatigue'], ['magicka', 'maxMagicka']]) {
      assert.ok(ch[m] > 0 && ch[v] <= ch[m], `${v}/${m}`);
    }
    assert.equal(a.act('character.create', { race: 'Nord', gender: 'Male' }).ok, false, 'cannot re-create');
    assert.deepEqual(b.character.character, bBefore, "B's character unchanged");
    assert.deepEqual(readPersisted(dbPath, a.id).rpg.character, ch);
    // A dishonest spend (extra bonus points) is refused by the server.
    b.must('character.roll', { className: 'Warrior' });
    const d = b.character.character.draft;
    const cheat = Object.fromEntries(R.ATTRIBUTES.map((k) => [k, Math.min(R.MAX_STAT, d.attributeBase[k] + d.bonusPool)]));
    assert.equal(b.act('character.create', { race: 'Nord', gender: 'Male', attributes: cheat, skills: {} }).ok, false);
    world.restart();
    assert.deepEqual(world.connect('acct-a', 'Aldora').character.character, ch);
  });

  test('drinking a potion heals its drinker once and consumes one potion', { todo: gap([needVerb('inventory.use')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    const ch = world.players.get(a.id).rpg.character;
    assert.ok(ch && Number.isFinite(ch.health), 'no character vitals to heal');
    ch.health = 1;
    world.tick(40);
    const potions = countOf(a, 'potion-of-healing');
    const bPotions = countOf(b, 'potion-of-healing');
    a.must('inventory.use', { itemId: itemsOf(a, 'potion-of-healing')[0].id });
    assert.ok(a.character.character.health > 1);
    assert.equal(countOf(a, 'potion-of-healing'), potions - 1);
    assert.equal(countOf(b, 'potion-of-healing'), bPotions);
  });
});

// ---- combat, kill and loot -------------------------------------------------------------------

const combatGap = gap([needVerb('combat.attack'), needVerb('combat.ready'), needVerb('combat.loot')]);
const MONSTER = { RAT: 0, ORC: 7 };
const FIGHT_SEED = 1;

/** Spawns one monster through the combat feature and stands both players beside it, facing it. */
function stageMonster(world, a, b, monsterId = MONSTER.RAT) {
  const loc = a.character.location;
  assert.equal(typeof world.apis.combat?.spawnMonster, 'function', 'combat install() exposes spawnMonster');
  const m = world.apis.combat.spawnMonster(loc, monsterId, 0, -8);
  assert.ok(m, 'monster placed');
  const face = (c, x, z) => {
    const p = world.players.get(c.id);
    p.x = x;
    p.z = z;
    p.yaw = Math.atan2(m.x - x, -(m.z - z));
  };
  face(a, m.x + 1.2, m.z + 0.6);
  face(b, m.x - 1.2, m.z + 0.6);
  world.tick(40);
  return m.id;
}

/**
 * Keeps the fighters on their feet and turned toward the (moving) monster, as a player's client
 * would, so the scenario measures shared monster state rather than the dice of a player's defeat.
 */
function topUp(world, mid, ...clients) {
  const m = world.ctx.entities.get(mid);
  for (const c of clients) {
    const p = world.players.get(c.id);
    const ch = p.rpg.character;
    ch.health = ch.maxHealth;
    ch.fatigue = ch.maxFatigue;
    if (Math.hypot(m.x - p.x, m.z - p.z) > 1.8) {
      const side = c === clients[0] ? 1 : -1;
      p.x = m.x + 1.2 * side;
      p.z = m.z + 0.6;
    }
    p.yaw = Math.atan2(m.x - p.x, -(m.z - p.z));
  }
}

describe('[fixture] two players fight the same monster', () => {
  test('one shared hp, both hit, one death, corpse searched exactly once', { todo: combatGap }, async (t) => {
    // Pinned seed: a fight where both players land blows (override with RPG_FIGHT_SEED to explore).
    const { world, a, b, dbPath } = await twoPlayerWorld(t, { seed: FIGHT_SEED });
    const kills = [];
    world.ctx.on('kill', (e) => kills.push(e));
    const mid = stageMonster(world, a, b, MONSTER.ORC);
    a.must('combat.ready', { ready: true });
    b.must('combat.ready', { ready: true });
    assert.equal(a.peer(b.id).readied, true, "B's readied weapon is public to A");
    assert.equal(a.entity(mid).hp, b.entity(mid).hp, 'both see one hp');
    const swingMark = b.mark();
    let hp = world.ctx.entities.get(mid).hp;
    const hitters = new Set();
    const log = [];
    let attacker = a;
    for (let i = 0; i < 400 && !world.ctx.entities.get(mid).dead; i++) {
      topUp(world, mid, a, b);
      const r = attacker.act('combat.attack', { targetId: mid, direction: 'down' });
      const now = world.ctx.entities.get(mid).hp;
      assert.ok(now <= hp, 'monster hp never rises');
      log.push(`${attacker === a ? 'A' : 'B'}:${r.ok ? hp - now : r.error}`);
      if (r.ok && now < hp) {
        hitters.add(attacker.id);
        attacker = attacker === a ? b : a; // Hand over after a landed blow so both can contribute.
      }
      hp = now;
      world.tick(1600);
      assert.equal(a.entity(mid)?.hp, b.entity(mid)?.hp, 'both clients see the same hp');
    }
    const m = world.ctx.entities.get(mid);
    assert.equal(m.dead, true, 'monster died within 400 swings');
    assert.equal(hitters.size, 2, `both players dealt damage: ${log.join(' ')}`);
    assert.equal(kills.length, 1, 'kill emitted exactly once');
    assert.ok(b.since(swingMark, 'gameEvent').some((x) => x.event.kind === 'swing' && x.event.playerId === a.id), "B saw A's swing");
    assert.ok(a.since(swingMark, 'gameEvent').some((x) => x.event.kind === 'death' && x.event.entityId === mid), 'A saw the death');
    assert.equal(a.act('combat.attack', { targetId: mid }).ok, false, 'corpse cannot be attacked');
    assert.equal(kills.length, 1);

    const total = gold(a) + gold(b);
    a.must('combat.loot', { targetId: mid });
    const found = gold(a) + gold(b) - total;
    const second = b.act('combat.loot', { targetId: mid });
    assert.equal(second.ok, false, 'second search refused');
    assert.match(second.error, /already been searched/);
    assert.equal(gold(a) + gold(b) - total, found, 'no gold created by the second search');
    assert.equal(readPersisted(dbPath, a.id).rpg.gold, gold(a), 'loot persisted with the action');
    t.diagnostic(`orc fight: ${found} gold found by A; hitters ${[...hitters].join(',')}`);
  });

  test('a corpse is reserved for those who fought it; damage practice advances only the hitter', { todo: gap([combatGap && 'combat missing', needService('advanceSkill')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    const mid = stageMonster(world, a, b, MONSTER.RAT);
    a.must('combat.ready', { ready: true });
    const usesB = structuredClone(b.character.character.skillUses ?? {});
    const before = structuredClone(a.character.character.skillUses ?? {});
    const skillsBefore = structuredClone(a.character.character.skills);
    for (let i = 0; i < 200 && !world.ctx.entities.get(mid).dead; i++) {
      topUp(world, mid, a, b);
      a.act('combat.attack', { targetId: mid });
      world.tick(1600);
    }
    assert.equal(world.ctx.entities.get(mid).dead, true);
    const after = a.character.character.skillUses;
    const practised = Object.keys(after).filter((k) => (after[k] ?? 0) > (before[k] ?? 0));
    assert.ok(practised.includes('Long Blade'), `A practised Long Blade with the longsword (got ${practised.join(', ')})`);
    for (const k of Object.keys(skillsBefore)) assert.ok(a.character.character.skills[k] >= skillsBefore[k], `${k} never drops`);
    // B may practise Dodging when the rat turns on them; B never practises A's weapon skills.
    for (const k of ['Long Blade', 'Critical Strike', 'Backstabbing']) assert.equal(b.character.character.skillUses?.[k] ?? 0, usesB[k] ?? 0, `B's ${k} unchanged`);
    const r = b.act('combat.loot', { targetId: mid });
    assert.equal(r.ok, false, 'B did not fight it and cannot search it yet');
    assert.match(r.error, /Only those who fought/);
    a.must('combat.loot', { targetId: mid });
  });
});

// ---- quest -----------------------------------------------------------------------------------

describe('[fixture] NPCs, shops and quests', () => {
  test('a shared merchant: stock and purse are one world state; gold moves exactly once', { todo: gap([needVerb('npc.talk'), needVerb('npc.buy')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    let shopView = null;
    let merchant = null;
    for (const npc of a.state.entities.filter((e) => e.kind === 'npc')) {
      for (const c of [a, b]) world.players.get(c.id).x = npc.x, world.players.get(c.id).z = npc.z + 1;
      if (!a.act('npc.talk', { targetId: npc.id }).ok) continue;
      const d = a.events('dialogue').at(-1);
      if (!d.topics.some((x) => x.id === 'trade')) continue;
      a.must('npc.topic', { targetId: npc.id, session: d.session, topic: 'trade' });
      shopView = a.events('dialogue').at(-1);
      if (shopView.shop?.items?.length) {
        merchant = npc;
        break;
      }
    }
    assert.ok(merchant, 'a merchant with stock stands in the starting town');
    b.must('npc.talk', { targetId: merchant.id });
    const bd = b.events('dialogue').at(-1);
    b.must('npc.topic', { targetId: merchant.id, session: bd.session, topic: 'trade' });
    const bShop = b.events('dialogue').at(-1).shop;
    const item = shopView.shop.items.find((i) => i.price <= gold(a)) ?? assert.fail('nothing affordable');
    const qty = item.quantity;
    const goldA = gold(a);
    const purse = shopView.shop.purse;
    // A buys the merchant's whole stack of that item (affordable quantity).
    const n = Math.min(qty, Math.floor(goldA / item.price));
    a.must('npc.buy', { targetId: merchant.id, session: shopView.session, key: item.key, quantity: n, price: item.price });
    assert.equal(gold(a), goldA - n * item.price, 'A paid exactly once');
    const after = a.events('dialogue').at(-1).shop;
    assert.equal(after.purse, purse + n * item.price, 'merchant purse received it');
    const left = after.items.find((i) => i.key === item.key)?.quantity ?? 0;
    assert.equal(left, qty - n, 'shared stock decreased');
    const refreshed = b.events('dialogue').at(-1).shop;
    assert.equal(refreshed.items.find((i) => i.key === item.key)?.quantity ?? 0, left, 'B was pushed the new stock');
    if (left === 0) {
      const r = b.act('npc.buy', { targetId: merchant.id, session: bd.session, key: item.key, quantity: 1, price: bShop.items.find((i) => i.key === item.key).price });
      assert.equal(r.ok, false, 'sold-out item cannot be bought again');
      assert.equal(gold(b), 100);
    }
    // A session token cannot be replayed by another player.
    assert.equal(b.act('npc.buy', { targetId: merchant.id, session: shopView.session, key: item.key, quantity: 1, price: item.price }).ok, false);
  });

  test('without operator quest files the quest giver offers nothing and no journal entry appears', { todo: gap([needVerb('quest.request')]) }, async (t) => {
    const { world, a } = await twoPlayerWorld(t);
    const crier = a.state.entities.find((e) => e.kind === 'npc' && e.questGiver && e.role === 'crier');
    assert.ok(crier, 'the starting town has a quest-giving town crier');
    world.players.get(a.id).x = crier.x;
    world.players.get(a.id).z = crier.z + 1;
    const r = a.act('quest.request', { targetId: crier.id });
    assert.equal(r.ok, false, 'no quests installed: no offer');
    assert.match(r.error, /no work/);
    assert.equal(a.character.quests?.active?.length ?? 0, 0);
    assert.equal(a.act('quest.accept', { offerId: 'A0C00Y21-1-x' }).ok, false, 'an invented offer id is refused');
  });
});

// ---- magic -----------------------------------------------------------------------------------

describe('[fixture] magic', () => {
  test('learn a spell (gold once), cast it at the shared monster: magicka and hp change for the right owners', { todo: gap([needVerb('magic.learn'), needVerb('magic.cast'), needService('damageEntity')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    createCharacter(a, { className: 'Mage' });
    a.must('magic.catalogue');
    const cat = a.events('spellCatalogue').at(-1);
    assert.ok(cat?.spells?.length, 'spell catalogue delivered');
    const known = new Set(world.ctx.services.knownSpells(world.players.get(a.id)));
    const spell =
      cat.spells.find((s) => s.harmful && s.support !== 'unsupported' && ['touch', 'singleAtRange'].includes(s.targetType) && !known.has(s.id) && s.price <= gold(a)) ??
      cat.spells.find((s) => s.harmful && s.support !== 'unsupported' && ['touch', 'singleAtRange'].includes(s.targetType) && known.has(s.id));
    assert.ok(spell, 'a castable harmful spell exists');
    const g0 = gold(a);
    const bKnown = structuredClone(b.character.magic?.known ?? []);
    if (!known.has(spell.id)) {
      a.must('magic.learn', { spellId: spell.id });
      assert.equal(gold(a), g0 - spell.price, 'paid the spell price once');
      assert.equal(a.act('magic.learn', { spellId: spell.id }).ok, false, 'cannot learn twice');
      assert.equal(gold(a), g0 - spell.price);
    }
    assert.ok(a.character.magic.known.includes(spell.id), 'spell in A’s persistent spellbook');
    assert.deepEqual(b.character.magic?.known ?? [], bKnown, "B's spellbook unchanged");
    const mid = stageMonster(world, a, b, MONSTER.ORC);
    const mk = a.character.character.magicka;
    const hp = world.ctx.entities.get(mid).hp;
    const bMk = b.character.character.magicka;
    const mark = b.mark();
    a.must('magic.cast', { spellId: spell.id, targetId: mid });
    assert.ok(a.character.character.magicka < mk, 'magicka spent');
    assert.equal(b.character.character.magicka, bMk, 'B magicka untouched');
    const cast = b.since(mark, 'gameEvent').find((x) => x.event.kind === 'spellCast');
    assert.ok(cast && cast.event.casterId === a.id, 'B saw A cast');
    let impact = cast.event;
    if (impact.missile) {
      const missileId = impact.missile.id;
      assert.equal(world.ctx.entities.get(mid).hp, hp, 'a missile spends magicka on launch');
      for (let tick = 0; tick < 25 && impact.kind !== 'spellImpact'; tick++) {
        world.tick(40);
        impact = b.events('spellImpact').find(e => e.missileId === missileId) ?? impact;
      }
      assert.equal(impact.kind, 'spellImpact', 'the second player saw the missile arrive');
      assert.deepEqual(a.events('spellImpact').find(e => e.missileId === missileId)?.hits, impact.hits);
    }
    const hpNow = world.ctx.entities.get(mid).hp;
    const hit = impact.hits.find(h => h.targetId === mid && h.pool === 'health');
    assert.ok(hit?.amount > 0, 'the spell actually hurt the intended monster');
    assert.equal(hp - hpNow, hit.amount);
    assert.equal(a.entity(mid).hp, b.entity(mid).hp);
    t.diagnostic(`${spell.name}: magicka ${mk}->${a.character.character.magicka}, orc hp ${hp}->${hpNow}`);
    assert.equal(a.act('magic.cast', { spellId: spell.id, targetId: mid }).ok, false, 'cast cooldown enforced');
    assert.equal(b.act('magic.cast', { spellId: spell.id, targetId: mid }).ok, false, 'B cannot cast A’s spell');
    world.tick(1300);
    world.players.get(a.id).rpg.character.magicka = 0;
    assert.equal(a.act('magic.cast', { spellId: spell.id, targetId: mid }).ok, false, 'no magicka, no cast');
  });
});

// ---- trade -----------------------------------------------------------------------------------

describe('[fixture] trade', () => {
  test('settle(): atomic two-sided swap through real inventory services', { todo: gap([needService('takeItem'), needService('giveItem')]) }, async (t) => {
    const { settle, normaliseOffer } = await import('../server/rpg/social/trade.js');
    const { world, a, b } = await twoPlayerWorld(t);
    const pa = world.players.get(a.id);
    const pb = world.players.get(b.id);
    const dagger = pa.rpg.inventory.find((i) => i.template === 'steel-dagger');
    const arrows = pb.rpg.inventory.find((i) => i.template === 'arrow');
    const offerA = normaliseOffer(pa.rpg, { items: [{ id: dagger.id }], gold: 30 });
    const offerB = normaliseOffer(pb.rpg, { items: [{ id: arrows.id, quantity: 10 }], gold: 0 });
    const total = pa.rpg.gold + pb.rpg.gold;
    settle(world.ctx.services, { player: pa, offer: offerA }, { player: pb, offer: offerB });
    assert.equal(pa.rpg.gold, 70);
    assert.equal(pb.rpg.gold, 130);
    assert.equal(pa.rpg.gold + pb.rpg.gold, total);
    assert.equal(pa.rpg.inventory.filter((i) => i.template === 'steel-dagger').length, 0);
    assert.equal(pb.rpg.inventory.filter((i) => i.template === 'steel-dagger').length, 2);
    assert.equal(pa.rpg.inventory.find((i) => i.template === 'arrow').quantity, 34);
    assert.equal(pb.rpg.inventory.find((i) => i.template === 'arrow').quantity, 14);
    const snapA = JSON.stringify(pa.rpg);
    const snapB = JSON.stringify(pb.rpg);
    assert.throws(() => settle(world.ctx.services, { player: pa, offer: offerA }, { player: pb, offer: offerB }));
    assert.equal(JSON.stringify(pa.rpg), snapA, 'stale offer: A unchanged');
    assert.equal(JSON.stringify(pb.rpg), snapB, 'stale offer: B unchanged');
    assert.throws(() => normaliseOffer(pa.rpg, { items: [{ id: pa.rpg.equipment.rightHand }] }), /Unequip/);
  });

  test('trade actions: request, accept, offers, both confirm the same revision, one atomic save', { todo: gap([needVerb('trade.request'), needVerb('trade.confirm')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    const tradeOf = (c) => c.events('social').at(-1)?.social?.trade;
    a.must('trade.request', { targetId: b.id });
    const tid = tradeOf(b).id;
    assert.equal(tradeOf(b).state, 'pending');
    assert.equal(a.act('trade.accept', { tradeId: tid }).ok, false, 'the requester cannot accept for B');
    b.must('trade.accept', { tradeId: tid });
    const dagger = itemsOf(a, 'steel-dagger')[0];
    const bArrows = itemsOf(b, 'arrow')[0];
    a.must('trade.offer', { tradeId: tid, items: [{ id: dagger.id, quantity: 1 }], gold: 25 });
    assert.equal(b.act('trade.offer', { tradeId: tid, items: [{ id: dagger.id, quantity: 1 }] }).ok, false, "B cannot offer A's dagger");
    b.must('trade.offer', { tradeId: tid, items: [{ id: bArrows.id, quantity: 5 }], gold: 0 });
    const rev = tradeOf(a).revision;
    a.must('trade.confirm', { tradeId: tid, revision: rev });
    assert.equal(countOf(b, 'steel-dagger'), 1, 'nothing moves on one confirmation');
    // A changing the offer after confirming invalidates the old revision.
    a.must('trade.offer', { tradeId: tid, items: [{ id: dagger.id, quantity: 1 }], gold: 20 });
    assert.equal(b.act('trade.confirm', { tradeId: tid, revision: rev }).ok, false, 'stale revision refused');
    const rev2 = tradeOf(b).revision;
    b.must('trade.confirm', { tradeId: tid, revision: rev2 });
    a.must('trade.confirm', { tradeId: tid, revision: rev2 });
    assert.equal(gold(a), 80);
    assert.equal(gold(b), 120);
    assert.equal(countOf(a, 'steel-dagger'), 0);
    assert.equal(countOf(b, 'steel-dagger'), 2);
    assert.equal(countOf(a, 'arrow'), 29);
    assert.equal(countOf(b, 'arrow'), 19);
    assert.equal(readPersisted(dbPath, a.id).rpg.gold, 80);
    assert.equal(readPersisted(dbPath, b.id).rpg.gold, 120);
    assert.equal(a.act('trade.confirm', { tradeId: tid, revision: rev2 }).ok, false, 'a settled trade cannot settle again');
    assert.equal(gold(a) + gold(b), 200);
    void world;
  });

  test('trade requires both players in range and in the same location', { todo: gap([needVerb('trade.request')]) }, async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    b.moveTo(60, 60);
    assert.equal(a.act('trade.request', { targetId: b.id }).ok, false);
    b.moveTo(1, 0);
    world.players.get(b.id).rpg.location = 'town:Daggerfall/Daggerfall';
    assert.equal(a.act('trade.request', { targetId: b.id }).ok, false);
  });
});

// ---- party -----------------------------------------------------------------------------------

describe('[fixture] party', () => {
  test('invite + accept forms one persistent party; leaving dissolves it for both', { todo: gap([needVerb('party.invite'), needVerb('party.accept'), needVerb('party.leave')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    assert.equal(b.act('party.accept', { fromId: a.id }).ok, false, 'no invitation yet');
    a.must('party.invite', { targetId: b.id });
    b.must('party.accept', { fromId: a.id });
    const pa = a.character.party;
    const pb = b.character.party;
    assert.ok(pa?.id && pa.id === pb?.id, 'same party id');
    assert.equal(pa.leaderId, a.id);
    assert.deepEqual(pa.members.map((m) => m.id).sort(), [a.id, b.id].sort());
    assert.equal(readPersisted(dbPath, b.id).rpg.party.id, pa.id, 'membership persisted');
    assert.equal(b.act('party.invite', { targetId: a.id }).ok, false, 'members cannot re-invite each other');
    assert.equal(b.act('party.kick', { targetId: a.id }).ok, false, 'only the leader can remove members');
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    const b2 = world.connect('acct-b', 'Brannoc');
    assert.equal(a2.character.party?.id, pa.id, 'party survives restart');
    assert.equal(b2.character.party?.id, pa.id);
    b2.must('party.leave');
    assert.ok(!b2.character.party, 'B left');
    world.tick(40);
    const rest = a2.character.party;
    assert.ok(!rest || rest.members.every((m) => m.id !== b.id), "A's party no longer lists B");
  });
});

// ---- visibility and travel -------------------------------------------------------------------

describe('[fixture] location visibility', () => {
  test('peers and entities are scoped to the viewer’s location', async (t) => {
    const { world, a, b } = await twoPlayerWorld(t);
    assert.ok(a.peer(b.id));
    world.ctx.entities.set('test-marker', { id: 'test-marker', kind: 'marker', name: 'm', location: a.character.location, x: 0, z: 0, yaw: 0, _secret: 1, visibleTo: [a.id] });
    world.players.get(b.id).rpg.location = 'town:Daggerfall/Elsewhere';
    world.tick(40);
    assert.equal(a.peer(b.id), null, 'A no longer sees B');
    assert.equal(b.peer(a.id), null, 'B no longer sees A');
    const m = a.entity('test-marker');
    assert.ok(m, 'A sees the marker');
    assert.ok(!('_secret' in m) && !('visibleTo' in m), 'private entity fields are stripped');
    assert.equal(b.entity('test-marker'), null);
    world.players.get(b.id).rpg.location = a.character.location;
    world.tick(40);
    assert.equal(b.entity('test-marker'), null, 'visibleTo restricts within a location');
    assert.ok(a.peer(b.id));
  });

  test('travel.go moves only the traveller, charges once, persists, and changes who they see', { todo: gap([needVerb('travel.go')]) }, async (t) => {
    const { world, a, b, dbPath } = await twoPlayerWorld(t);
    const from = a.character.location;
    const to = 'town:Daggerfall/Daggerfall';
    const g0 = gold(a);
    a.must('travel.go', { to });
    assert.equal(a.character.location, to);
    assert.equal(b.character.location, from, 'B stays');
    assert.equal(a.peer(b.id), null);
    assert.equal(b.peer(a.id), null);
    const cost = g0 - gold(a);
    assert.ok(cost >= 0);
    assert.equal(a.character.travel.lastTrip?.to, to);
    assert.equal(a.act('travel.go', { to: 'town:Nowhere/Fabricated' }).ok, false, 'unknown destination refused');
    assert.equal(readPersisted(dbPath, a.id).rpg.location, to);
    // Same location again: they see each other.
    world.clock.advance(2000);
    b.must('travel.go', { to });
    assert.ok(a.peer(b.id) && b.peer(a.id), 'reunited in the destination');
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    assert.equal(a2.character.location, to);
    assert.equal(gold(a2), g0 - cost, 'fare charged exactly once');
  });
});

// ---- live: real server, real accounts, two WebSockets ------------------------------------------

describe('[live] two accounts over real WebSockets', () => {
  let tmp;
  let world;
  let jarA;
  let jarB;
  const clients = new Set();
  const named = {};
  const open = async (jar) => {
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    clients.add(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    const welcome = await c.next((m) => m.type === 'welcome' || m.type === 'error', 'welcome');
    assert.equal(welcome.type, 'welcome', welcome.message);
    c.welcome = welcome;
    return c;
  };
  const closeAll = async () => {
    await Promise.all([...clients].map((c) => c.close()));
    clients.clear();
  };

  before(async () => {
    tmp = tempDir('dfw-rpg-live-');
    world = await startLiveWorld({ dir: tmp.dir, features: discovered.features });
    jarA = await accountSession(world.base, 'aldora');
    jarB = await accountSession(world.base, 'brannoc');
  });
  after(async () => {
    try {
      await closeAll();
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  test('registration issues two distinct sessions; anonymous sockets are refused', async () => {
    assert.equal(jarA.status, 201, JSON.stringify(jarA.json));
    assert.equal(jarB.status, 201, JSON.stringify(jarB.json));
    assert.notEqual(jarA.user.id, jarB.user.id);
    assert.ok(jarA.cookie && jarB.cookie && jarA.cookie !== jarB.cookie);
    const anon = new LiveClient(world.port);
    await assert.rejects(anon.opened, /401/);
    await anon.closed;
  });

  test('each socket gets its own character; peers and starter kits are correct', { todo: gap([has('inventory') ? null : 'inventory feature missing']) }, async () => {
    const a = (named.a = await open(jarA));
    const b = (named.b = await open(jarB));
    assert.notEqual(a.welcome.id, b.welcome.id);
    const sa = await a.stateWhere((m) => m.peers.some((p) => p.id === b.welcome.id), 'A sees B');
    const sb = await b.stateWhere((m) => m.peers.some((p) => p.id === a.welcome.id), 'B sees A');
    assert.equal(sa.selfId, a.welcome.id);
    assert.equal(sb.selfId, b.welcome.id);
    assert.equal(sa.character.gold, 100);
    assert.equal(sb.character.gold, 100);
    assert.ok(!('inventory' in sa.peers[0]), 'peer is public only');
    const ids = [...sa.character.inventory, ...sb.character.inventory].map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("cross-account item use is rejected; own equip is broadcast as a public weapon", { todo: gap([needVerb('inventory.equip')]) }, async () => {
    const { a, b } = named;
    const aId = a.welcome.id;
    const bState = b.state;
    const bMace = bState.character.inventory.find((i) => i.template === 'iron-mace');
    const r1 = await a.act('inventory.equip', { itemId: bMace.id });
    assert.equal(r1.ok, false, "A cannot equip B's mace");
    const aMace = a.state.character.inventory.find((i) => i.template === 'iron-mace');
    const r2 = await a.act('inventory.equip', { itemId: aMace.id });
    assert.equal(r2.ok, true, r2.error);
    await b.stateWhere((m) => m.peers.find((p) => p.id === aId)?.weapon?.template === 'iron-mace', "B sees A's mace");
    const sa = await a.stateWhere((m) => m.character.equipment.rightHand === aMace.id, 'A state shows mace');
    assert.equal(sa.character.equipment.rightHand, aMace.id);
    assert.equal(b.state.character.equipment.rightHand, bState.character.equipment.rightHand, "B's equipment unchanged");
  });

  test('reconnecting the same account replaces the old socket without duplicating the character', async () => {
    const { a } = named;
    const a2 = (named.a = await open(jarA));
    const closed = await a.closed;
    assert.equal(closed.code, 4000);
    clients.delete(a);
    assert.equal(a2.welcome.id, a.welcome.id);
    const s = await a2.stateWhere((m) => m.selfId === a.welcome.id, 'resynced snapshot');
    assert.equal(s.character.inventory.filter((i) => i.template === 'iron-longsword').length, 1);
  });

  test('server restart on the same databases keeps sessions, characters and equipment', { todo: gap([needVerb('inventory.equip')]) }, async () => {
    const { a } = named;
    const aId = a.welcome.id;
    const before = (await a.stateWhere(() => true)).character;
    await closeAll();
    const port = world.port;
    await world.server.close();
    world.accounts.close();
    world = await startLiveWorld({ dir: tmp.dir, port, features: discovered.features });
    const a2 = (named.a = await open(jarA)); // the same cookie still authenticates after restart
    const b2 = (named.b = await open(jarB));
    assert.equal(a2.welcome.id, aId);
    const s = await a2.stateWhere((m) => m.peers.some((p) => p.id === b2.welcome.id), 'A sees B after restart');
    assert.deepEqual(s.character.inventory.map((i) => i.id).sort(), before.inventory.map((i) => i.id).sort());
    assert.deepEqual(s.character.equipment, before.equipment);
    assert.equal(s.character.gold, before.gold);
    assert.equal(readPersisted(world.dbPath, aId).rpg.gold, before.gold);
  });

  test('dropped item race over two sockets: exactly one account receives it', { todo: gap([needVerb('inventory.drop'), needVerb('inventory.loot')]) }, async () => {
    const { a, b } = named;
    const sa = await a.stateWhere(() => true);
    const sb = await b.stateWhere(() => true);
    const axe = sa.character.inventory.find((i) => i.template === 'iron-battle-axe');
    const r = await a.act('inventory.drop', { itemId: axe.id });
    assert.equal(r.ok, true, r.error);
    const seen = await b.stateWhere((m) => m.entities.some((e) => e.kind === 'loot'), 'B sees the dropped pile');
    const pile = seen.entities.find((e) => e.kind === 'loot');
    // Both sockets ask for it; the server orders them and only one claim succeeds.
    const [ra, rb] = await Promise.all([a.act('inventory.loot', { targetId: pile.id }), b.act('inventory.loot', { targetId: pile.id })]);
    assert.equal([ra.ok, rb.ok].filter(Boolean).length, 1, `exactly one claim succeeds (A:${ra.error ?? 'ok'} B:${rb.error ?? 'ok'})`);
    const winner = ra.ok ? a : b;
    const fa = await a.stateWhere((m) => !m.entities.some((e) => e.id === pile.id), 'pile gone for A');
    const fb = await b.stateWhere((m) => !m.entities.some((e) => e.id === pile.id), 'pile gone for B');
    const axes = (m) => m.character.inventory.filter((i) => i.template === 'iron-battle-axe').length;
    assert.equal(axes(fa) + axes(fb), 2, 'two axes exist in the world, as before the drop');
    assert.equal(axes(fa) + axes(fb), axes(sa) + axes(sb));
    const db = readPersisted(world.dbPath, winner.welcome.id).rpg;
    assert.ok(db.inventory.some((i) => i.id === axe.id), 'the winner owns the same item record in SQLite');
  });

  test('party invitation crosses sockets and membership is visible to both accounts', { todo: gap([needVerb('party.invite'), needVerb('party.accept')]) }, async () => {
    const { a, b } = named;
    const r1 = await a.act('party.invite', { targetId: b.welcome.id });
    assert.equal(r1.ok, true, r1.error);
    const inv = await b.next((m) => m.type === 'gameEvent' && m.event.kind === 'social' && m.event.invite?.fromId === a.welcome.id, 'invite event on B');
    assert.equal(inv.event.invite.fromName, 'aldora');
    const r2 = await b.act('party.accept', { fromId: a.welcome.id });
    assert.equal(r2.ok, true, r2.error);
    const pa = await a.stateWhere((m) => m.character.party?.members?.length === 2, 'A party of two');
    const pb = await b.stateWhere((m) => m.character.party?.members?.length === 2, 'B party of two');
    assert.equal(pa.character.party.id, pb.character.party.id);
    assert.equal(readPersisted(world.dbPath, b.welcome.id).rpg.party.id, pa.character.party.id);
  });
});

// ---- asset: original quests from the operator's ARENA2 ------------------------------------------
//
// These cases need the operator's own game files (gitignored gamedata/). Without them they are
// skipped with that reason, except under RPG_INTEGRATION_STRICT=1, where a missing ARENA2 fails.
// The quest catalogue is narrowed to one original quest (read and decompiled from ARENA2 by
// server/rpg/quests/catalog.js) so the offer is deterministic; everything else is the production
// manifest running on the same ARENA2 (real collision, NPC rosters, quest text).

const ARENA2 = localArena2();
const assetGate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const needArena2 = () => assert.ok(ARENA2, 'RPG_INTEGRATION_STRICT=1 requires gamedata/…/arena2');

/** A0C00Y21 (Commoners, town crier): fetch an item from a house in Daggerfall, bring it back, get gold. */
const QUEST = 'A0C00Y21';
const DAGGERFALL = 'town:Daggerfall/Daggerfall';

async function questWorld(t, names = [QUEST]) {
  needArena2();
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/world.db`;
  const features = await featuresWithQuestCatalog(discovered.features, ARENA2, names);
  const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
  t.after(() => {
    try {
      world.close();
    } finally {
      tmp.remove();
    }
  });
  const a = world.connect('acct-a', 'Aldora');
  const b = world.connect('acct-b', 'Brannoc');
  const home = a.character.location;
  await world.ctx.services.collision.whenSettled(home);
  world.tick(40);
  return { world, a, b, dbPath, home };
}

const standBy = (world, c, e, dz = 1) => {
  const p = world.players.get(c.id);
  p.x = e.x;
  p.z = e.z + dz;
};
const crierOf = (c) => c.state.entities.find((e) => e.kind === 'npc' && e.questGiver && (e.role === 'crier' || e.questGroup === 'Commoners'));

/**
 * With installed data there is no street crier: Commoners work comes from authored building people (DFU
 * TalkManager.GetBuildingList, 1 in 4 per day). Walk `c` through the real door of the first building whose
 * person offers Commoners work today and return that person.
 */
async function commonerGiver(world, c, town, group = 'Commoners') {
  const s = world.ctx.services;
  await s.interiors.survey(town);
  const p = world.players.get(c.id);
  const specs = s.portals.at(town);
  const work = await s.npcs.workAt(town, p.id);
  for (const w of work.filter((x) => x.group === group)) {
    const spec = specs.find((sp) => sp.to === w.interior);
    if (!spec) continue;
    if (world.ctx.location(p) !== town) s.portals.transfer(p, { location: town, x: 0, z: 0, yaw: 0 }, { label: 'outside' });
    const door = spec.entrances[0];
    p.x = door.x;
    p.z = door.z;
    world.clock.advance(1000);
    c.must('portal.use', { portalId: spec.id });
    await s.npcs.ready(w.interior);
    await s.collision?.whenSettled?.(w.interior);
    world.tick(200);
    const e = c.state.entities.find((x) => x.id === w.id && x.questGiver && x.questGroup === group);
    if (e) return e;
  }
  return null;
}

/** Leaves a building through its own door (portal.leave), as a player must before travelling. */
async function outside(world, c) {
  const loc = c.character.location;
  if (!/^(interior|dungeon):/.test(loc)) return;
  await world.ctx.services.interiors.survey(loc); // after a restart the doors are surveyed again first
  const door = world.ctx.services.portals.into(loc);
  const p = world.players.get(c.id);
  p.x = door.entrances[0].inner.x;
  p.z = door.entrances[0].inner.z;
  world.clock.advance(1000);
  c.must('portal.leave', {});
}

/**
 * Goes where the quest really put its item: the remote town the server rolled, and the building the item was
 * bound to there (read from the owner's instance, never assumed).
 */
async function toQuestTarget(world, c, owner, uid, key) {
  const inst = () => owner.character.quests.active.find((q) => q.uid === uid);
  const town = inst().items[key].location;
  await go(world, c, town);
  await world.ctx.services.interiors.survey(town);
  world.tick(1100); // quest tick binds the place to a surveyed building
  const pl = inst().places[inst().items[key].place];
  if (pl?.interior) {
    const spec = world.ctx.services.portals.at(town).find((sp) => sp.to === pl.interior);
    const p = world.players.get(c.id);
    p.x = spec.entrances[0].x;
    p.z = spec.entrances[0].z;
    world.clock.advance(1000);
    c.must('portal.use', { portalId: spec.id });
    await world.ctx.services.collision.whenSettled(pl.interior);
    world.tick(1100);
  }
  return pl?.interior ?? town;
}

/** Travels and waits for the destination's geometry, as a returning player would. */
async function go(world, c, to) {
  await outside(world, c);
  world.clock.advance(2000); // travel cooldown
  c.must('travel.go', { to });
  await world.ctx.services.collision.whenSettled(to);
  world.tick(1100); // quest tick places the player's private quest entities
}

describe('[asset] original quest A0C00Y21 with two accounts', () => {
  test('offer → accept → objective → reward once → replay refused → survives restart mid-quest', assetGate, async (t) => {
    const { world, a, b, dbPath, home } = await questWorld(t);
    const crier = crierOf(a) ?? (await commonerGiver(world, a, home));
    assert.ok(crier, 'a Commoners quest giver in a named building');
    if (crier.location !== home) await commonerGiver(world, b, home).then((e) => assert.equal(e?.id, crier.id, 'both accounts meet the same giver'));
    standBy(world, a, crier);
    standBy(world, b, crier, -1);
    world.tick(40);

    // Offer and accept (original QRC text, decompiled QBN).
    a.must('quest.request', { targetId: crier.id });
    const offer = a.events('questOffer').at(-1);
    assert.ok(offer.text.length > 40, 'original offer text');
    assert.equal(b.act('quest.accept', { offerId: offer.offerId }).ok, false, "B cannot accept A's offer");
    a.must('quest.accept', { offerId: offer.offerId });
    assert.equal(a.act('quest.accept', { offerId: offer.offerId }).ok, false, 'an offer is accepted once');
    const inst = a.character.quests.active.find((q) => q.name === QUEST);
    assert.ok(inst, 'quest in A’s journal');
    assert.equal(inst.giver.id, crier.id);
    assert.ok(inst.log.length >= 1, 'journal entry logged');
    const reward = Object.values(inst.items).find((i) => i.className === 'gold')?.gold;
    const fetchKey = Object.keys(inst.items).find((k) => inst.items[k].className !== 'gold');
    assert.ok(reward > 0 && fetchKey, 'gold reward and a fetch item');
    const target = inst.items[fetchKey].location;
    assert.ok(world.ctx.services.travel.lookup(target), `item waits in a catalogued town (${target})`);
    assert.equal(target.split('/')[0], home.split('/')[0], 'remote town in the giver’s region (Place.SelectRemoteTownSite)');
    assert.ok(!b.character.quests?.active?.length, 'B has no quest');

    // Objective not met yet: returning to the giver pays nothing.
    const g0 = gold(a);
    a.must('npc.talk', { targetId: crier.id });
    assert.equal(gold(a), g0, 'no reward before the objective');
    assert.equal(a.character.quests.active.length, 1);

    // Travel to the rolled target; the quest item is A's private entity.
    const itemAt = await toQuestTarget(world, a, a, inst.uid, fetchKey);
    await toQuestTarget(world, b, a, inst.uid, fetchKey);
    const item = a.state.entities.find((e) => e.kind === 'questItem');
    assert.ok(item, 'A sees the quest item');
    assert.equal(b.entity(item.id), null, 'B cannot see A’s quest item');
    standBy(world, b, item, 0.5);
    assert.equal(b.act('quest.click', { targetId: item.id }).ok, false, 'B cannot take A’s quest item');
    standBy(world, a, item, 0.5);
    a.must('quest.click', { targetId: item.id });
    assert.equal(a.character.quests.active[0].items[fetchKey].held, true, 'A holds the item');
    assert.equal(a.entity(item.id), null, 'item left the world');
    assert.equal(a.act('quest.click', { targetId: item.id }).ok, false, 'cannot take it twice');

    // Restart mid-quest: journal, held item and progress come back from SQLite.
    const persisted = readPersisted(dbPath, a.id).rpg.quests.active[0];
    assert.equal(persisted.items[fetchKey].held, true);
    world.restart();
    const a2 = world.connect('acct-a', 'Aldora');
    const b2 = world.connect('acct-b', 'Brannoc');
    await world.ctx.services.collision.whenSettled(itemAt);
    world.tick(1100);
    assert.equal(a2.character.location, itemAt, 'A resumes where they left');
    assert.equal(a2.character.quests.active[0].uid, inst.uid, 'same quest instance after restart');
    assert.equal(a2.character.quests.active[0].items[fetchKey].held, true);
    assert.ok(!a2.state.entities.some((e) => e.kind === 'questItem'), 'taken item is not respawned');

    // Return and hand it in: reward exactly once, to A only.
    await go(world, a2, home);
    await go(world, b2, home);
    const c2 = crierOf(a2) ?? (await commonerGiver(world, a2, home), await commonerGiver(world, b2, home), world.tick(40), a2.state.entities.find((e) => e.id === crier.id));
    assert.equal(c2?.id, crier.id, 'the same source giver (stable id) after restart');
    standBy(world, a2, c2);
    standBy(world, b2, c2, -1);
    world.tick(40);
    const ga = gold(a2);
    const gb = gold(b2);
    b2.act('npc.talk', { targetId: c2.id });
    assert.equal(gold(b2), gb, 'B talking to the giver earns nothing');
    a2.must('npc.talk', { targetId: c2.id });
    assert.equal(gold(a2), ga + reward, `paid ${reward} gold once`);
    assert.equal(a2.character.quests.active.length, 0);
    assert.equal(a2.character.quests.done[0].uid, inst.uid);
    assert.equal(a2.character.quests.done[0].result, 'success');
    assert.ok(a2.events('questEnd').some((e) => e.uid === inst.uid && e.result === 'success'));

    // Replay: further talking, clicking, re-accepting the old offer and ticking pay nothing.
    a2.must('npc.talk', { targetId: c2.id });
    assert.equal(a2.act('quest.accept', { offerId: offer.offerId }).ok, false, 'old offer cannot be replayed');
    assert.equal(a2.act('quest.click', { targetId: item.id }).ok, false);
    world.tick(5000);
    assert.equal(gold(a2), ga + reward, 'no double credit');
    assert.equal(gold(b2), gb);
    const dbA = readPersisted(dbPath, a.id).rpg;
    assert.equal(dbA.gold, ga + reward, 'reward persisted');
    assert.equal(dbA.quests.done.filter((d) => d.uid === inst.uid).length, 1, 'one completion record');
    assert.equal(readPersisted(dbPath, b.id).rpg.gold, gb);
    world.restart();
    assert.equal(gold(world.connect('acct-a', 'Aldora')), ga + reward, 'still paid once after restart');
    t.diagnostic(`${QUEST}: reward ${reward} gold; ${offer.text.replace(/\s+/g, ' ').slice(0, 80)}…`);
  });

  test('A0C00Y20: the reward requires killing the foe first (talking to the giver at once must not pay)', assetGate, async (t) => {
    const { world, a, home } = await questWorld(t, ['A0C00Y20']);
    const crier = crierOf(a) ?? (await commonerGiver(world, a, home));
    standBy(world, a, crier);
    world.tick(40);
    a.must('quest.request', { targetId: crier.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    const g0 = gold(a);
    a.act('npc.talk', { targetId: crier.id });
    assert.equal(gold(a), g0, 'no gold before the objective');
    assert.equal(a.character.quests.active.length, 1, 'quest still active');
  });

  test('original quest text has every symbol expanded', assetGate, async (t) => {
    const { world, a, home } = await questWorld(t, ['A0C00Y20']);
    const crier = crierOf(a) ?? (await commonerGiver(world, a, home));
    standBy(world, a, crier);
    world.tick(40);
    a.must('quest.request', { targetId: crier.id });
    const text = a.events('questOffer').at(-1).text;
    assert.doesNotMatch(text, /(^|\s)[_=%]\w+/, `unexpanded symbol in: ${text.slice(0, 120)}`);
  });
});

describe('[asset][live] original quest over two real account sockets', () => {
  let tmp;
  let world;
  const open = [];
  const join = async (jar) => {
    const c = new LiveClient(world.port, { cookie: jar.cookie });
    open.push(c);
    await c.opened;
    c.send({ type: 'join', name: jar.user.username, account: true });
    c.welcome = await c.next((m) => m.type === 'welcome', 'welcome');
    return c;
  };
  const ev = (c, kind) => c.next((m) => m.type === 'gameEvent' && m.event.kind === kind, `${kind} event`);
  /** Walks with real input until the server reports the player within `reach` of (x, z). */
  async function walkTo(c, x, z, reach, steps = 200, run = false) {
    for (let i = 0; i < steps; i++) {
      const me = c.state?.selfId;
      const st = c.messages.filter((m) => m.type === 'state').at(-1)?.players?.find((p) => p.id === me) ?? null;
      const pos = st ?? { x: 0, z: 0 };
      const d = Math.hypot(x - pos.x, z - pos.z);
      if (st && d <= reach) {
        c.send({ type: 'input', forward: 0, strafe: 0, yaw: Math.atan2(x - pos.x, -(z - pos.z)) });
        return pos;
      }
      c.send({ type: 'input', forward: 1, strafe: 0, run, yaw: Math.atan2(x - pos.x, -(z - pos.z)) });
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'movement snapshot');
    }
    throw new Error(`could not walk to (${x}, ${z})`);
  }

  before(async () => {
    if (!ARENA2) return;
    tmp = tempDir('dfw-rpg-live-quest-');
    const features = await featuresWithQuestCatalog(discovered.features, ARENA2, [QUEST]);
    // Begin at 13:30 on the classic start date. The shared town clock still runs during the walk.
    world = await startLiveWorld({ dir: tmp.dir, features: withWorldClock(features, { epochMs: Date.now() }), arena2Dir: ARENA2 });
  });
  after(async () => {
    try {
      await Promise.all(open.map((c) => c.close()));
      await world?.close();
    } finally {
      tmp?.remove();
    }
  });

  // Oracle only: which building's person offers Commoners work today and where doors are. Every move below is
  // real input over the socket; doors are used with portal.use / portal.leave like the browser does.
  const svc = () => world.server.runtime.ctx.services;
  const where = (c) => c.messages.filter((m) => m.type === 'rpg').at(-1)?.character?.location;
  async function useDoor(c, verb, args, loc) {
    for (let i = 0; i < 60; i++) {
      const r = await c.act(verb, args);
      if (r.ok) return c.stateWhere((m) => m.character.location === loc || (verb === 'portal.leave' && !/^(interior|dungeon):/.test(m.character.location)), `${verb} done`);
      if (!/loading|moment|Wait/i.test(r.error)) throw new Error(`${verb}: ${r.error}`);
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'state while a door loads');
    }
    throw new Error(`${verb} never succeeded`);
  }
  const selfPos = (c) => {
    const me = c.state?.selfId;
    return c.messages.filter((m) => m.type === 'state').at(-1)?.players?.find((p) => p.id === me) ?? null;
  };
  /** Move over the network along real collision until the object is within use range on its floor. */
  async function walkRoute(c, x, z, reach, targetY) {
    const loc = where(c);
    await svc().collision.whenSettled(loc);
    // Plan from a snapshot taken after any door transfer (earlier ones carry the old location's position).
    // Packets stamped with the viewer's location must match; unstamped ones are taken only after a few fresh ticks.
    for (let i = 0; i < 3; i++) {
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state' && (m.location === undefined || m.location === loc), 'fresh movement snapshot');
    }
    const at = selfPos(c) ?? { x: 0, z: 0 };
    const col = svc().collision.instanceWorld(loc);
    const indoors = /^(interior|dungeon):/.test(loc);
    const savedPortal = c.state?.character?.portal;
    const y = indoors && savedPortal?.to === loc && Number.isFinite(savedPortal.footY)
      ? savedPortal.footY : col.standHeight(at.x, at.z);
    const path = walkingRoute(col, { x: at.x, y, z: at.z }, { x, y: targetY, z }, Math.max(0.2, reach - 0.3), indoors);
    assert.ok(path, 'no walking route in ' + loc + ' from ' + JSON.stringify([at.x, y, at.z]) + ' to ' + JSON.stringify([x, targetY, z]));
    for (const w of path) await walkTo(c, w.x, w.z, indoors ? 0.24 : 0.5, 2000);
  }
  async function enter(c, town, interior) {
    await svc().interiors.survey(town);
    const spec = svc().portals.at(town).find((sp) => sp.to === interior);
    // The door's own exit landing is clear ground in front of it, within use reach.
    await walkRoute(c, spec.entrances[0].exit.x, spec.entrances[0].exit.z, 0.6);
    await useDoor(c, 'portal.use', { portalId: spec.id }, interior);
  }
  async function leave(c) {
    const loc = where(c);
    if (!/^(interior|dungeon):/.test(loc ?? '')) return;
    const door = svc().portals.into(loc);
    await walkRoute(c, door.entrances[0].inner.x, door.entrances[0].inner.z, 1.2, door.entrances[0].enter.y);
    await useDoor(c, 'portal.leave', {}, null);
  }
  async function travel(c, to, t) {
    await leave(c);
    let r = await c.act('travel.go', { to });
    // A0C00Y21 can send a Battlemage after the carrier. Run through the streets to a clear
    // departure point; the normal travel action still checks the actual enemies there.
    if (!r.ok && /enemies nearby/i.test(r.error)) {
      const loc = where(c);
      const actor = world.server.runtime.ctx.players.get(c.welcome.id);
      const threat = svc().enemiesNearby(actor);
      assert.ok(threat, 'the travel refusal has a nearby hostile');
      if (threat._quest) assert.equal(threat._quest.owner, actor.id, 'a private quest foe can block only its owner');
      const col = svc().collision.instanceWorld(loc);
      const from = { x: actor.x, y: col.standHeight(actor.x, actor.z), z: actor.z };
      const doors = svc().portals.at(loc).flatMap(sp => sp.entrances).map(e => e.exit).filter(Boolean)
        .filter(p => Math.hypot(p.x - threat.x, p.z - threat.z) >= 70)
        .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
      let escape;
      for (const door of doors) {
        escape = walkingRoute(col, from, door, 0.9, false);
        if (escape) break;
      }
      assert.ok(escape, `a walkable street away from ${threat.name} in ${loc}`);
      for (const point of escape) await walkTo(c, point.x, point.z, 0.5, 600, true);
      r = await c.act('travel.go', { to });
      if (r.ok) t.diagnostic(`Escaped ${threat.name} on foot in ${loc} before departing for ${to}.`);
    }
    for (let i = 0; i < 40 && !r.ok && /Catch your breath|Wait/.test(r.error); i++) {
      c.cursor = c.messages.length;
      await c.next((m) => m.type === 'state', 'state while waiting for travel cooldown');
      if (i % 5 === 4) r = await c.act('travel.go', { to });
    }
    assert.equal(r.ok, true, r.error);
    return c.stateWhere((m) => m.character.location === to, `arrived in ${to}`);
  }
  async function commonersBuilding(town, playerId) {
    const work = await svc().npcs.workAt(town, playerId);
    await svc().interiors.survey(town);
    return work.find((w) => w.group === 'Commoners' && svc().portals.at(town).some((sp) => sp.to === w.interior))?.interior ?? null;
  }

  test('another account cannot accept, take or cash A’s quest; A is paid exactly once', assetGate, async (t) => {
    needArena2();
    const jarA = await accountSession(world.base, 'cassia');
    const jarB = await accountSession(world.base, 'dorran');
    const a = await join(jarA);
    const b = await join(jarB);
    const sa0 = await a.stateWhere(() => true);
    const homeTown = sa0.character.location;
    const building = await commonersBuilding(homeTown, a.state?.selfId);
    assert.ok(building, 'a named building whose person offers Commoners work today');
    await enter(a, homeTown, building);
    await enter(b, homeTown, building);
    const sa = await a.stateWhere((m) => m.entities.some((e) => e.questGiver && e.questGroup === 'Commoners'), 'A sees the authored giver');
    const giver = sa.entities.find((e) => e.questGiver && e.questGroup === 'Commoners');
    const goldA0 = sa.character.gold;
    const goldB0 = (await b.stateWhere(() => true)).character.gold;
    await walkRoute(a, giver.x, giver.z, 3.5, giver.y);
    await walkRoute(b, giver.x, giver.z, 3.5, giver.y);

    let r = await a.act('quest.request', { targetId: giver.id });
    assert.equal(r.ok, true, r.error);
    const offer = (await ev(a, 'questOffer')).event;
    r = await b.act('quest.accept', { offerId: offer.offerId });
    assert.equal(r.ok, false, "B cannot accept A's offer");
    r = await a.act('quest.accept', { offerId: offer.offerId });
    assert.equal(r.ok, true, r.error);
    const accepted = await a.stateWhere((m) => m.character.quests?.active?.length === 1, 'quest in A journal');
    const inst = accepted.character.quests.active[0];
    const reward = Object.values(inst.items).find((i) => i.className === 'gold').gold;
    const fetchKey = Object.keys(inst.items).find((k) => inst.items[k].className !== 'gold');
    const target = inst.items[fetchKey].location; // the town the server rolled (any legitimate destination)

    for (const c of [a, b]) await travel(c, target, t);
    await svc().interiors.survey(target);
    const bound = await a.stateWhere((m) => m.character.quests.active[0].places[inst.items[fetchKey].place]?.interior || m.character.quests.active[0].places[inst.items[fetchKey].place]?.noBuilding, 'place bound');
    const pl = bound.character.quests.active[0].places[inst.items[fetchKey].place];
    if (pl.interior) for (const c of [a, b]) await enter(c, target, pl.interior);
    const itemLoc = pl.interior ?? target;
    const sItem = await a.stateWhere((m) => m.character.location === itemLoc && m.entities.some((e) => e.kind === 'questItem'), 'A sees the quest item');
    const item = sItem.entities.find((e) => e.kind === 'questItem');
    const sb = await b.stateWhere((m) => m.character.location === itemLoc, 'B there too');
    assert.ok(!sb.entities.some((e) => e.id === item.id), 'B never receives A’s quest item');
    await walkRoute(b, item.x, item.z, 3.5, item.y);
    r = await b.act('quest.click', { targetId: item.id });
    assert.equal(r.ok, false, 'B cannot take it');
    await walkRoute(a, item.x, item.z, 3.5, item.y);
    r = await a.act('quest.click', { targetId: item.id });
    assert.equal(r.ok, true, r.error);

    // A reconnects mid-quest on a new socket: same journal, item still held.
    const a2 = await join(jarA);
    await a.closed;
    const back = await a2.stateWhere((m) => m.character.quests?.active?.[0]?.uid === inst.uid, 'journal after reconnect');
    assert.ok(Object.values(back.character.quests.active[0].items).some((i) => i.className !== 'gold' && i.held));

    for (const c of [a2, b]) await travel(c, homeTown, t);
    for (const c of [a2, b]) await enter(c, homeTown, building);
    const home = await a2.stateWhere((m) => m.entities.some((e) => e.id === giver.id), 'A back with the same giver');
    const c2 = home.entities.find((e) => e.id === giver.id);
    await walkRoute(a2, c2.x, c2.z, 3.5, c2.y);
    await walkRoute(b, c2.x, c2.z, 3.5, c2.y);
    const goldB = (await b.stateWhere(() => true)).character.gold;
    r = await b.act('npc.talk', { targetId: c2.id });
    const goldA = (await a2.stateWhere(() => true)).character.gold;
    r = await a2.act('npc.talk', { targetId: c2.id });
    assert.equal(r.ok, true, r.error);
    const paid = await a2.stateWhere((m) => m.character.quests?.done?.[0]?.uid === inst.uid, 'quest completed');
    assert.equal(paid.character.gold, goldA + reward, 'A paid once');
    for (let i = 0; i < 2; i++) assert.equal((await a2.act('npc.talk', { targetId: c2.id })).ok, true);
    assert.equal((await a2.act('quest.accept', { offerId: offer.offerId })).ok, false, 'offer replay refused');
    assert.equal(a2.state.character.gold, goldA + reward, 'no double credit');
    assert.equal(b.state.character.gold, goldB, 'B gained nothing');
    const dbA = readPersisted(world.dbPath, a2.welcome.id).rpg;
    const dbB = readPersisted(world.dbPath, b.welcome.id).rpg;
    assert.equal(dbA.gold, goldA + reward);
    assert.equal(dbA.quests.done.filter((d) => d.uid === inst.uid).length, 1);
    assert.equal(dbB.gold, goldB);
    assert.ok(!(dbB.quests?.done ?? []).some((d) => d.uid === inst.uid));
    t.diagnostic(`live ${QUEST}: giver ${giver.name} in ${building}; target ${itemLoc}; A ${goldA0}→${dbA.gold} (reward ${reward}), B ${goldB0}→${dbB.gold}`);
  });
});

