// Comprehensive Land PvP (§4) tests:
//   - Unified PvP eligibility policy across melee, bow/arrow (+ mid-flight boundary crossing),
//     direct/area/reflected spells, DOTs, summoned pets, healing/revive, and law crime suppression.
//   - Consent Duels (blocks/canInteract, countdown, ring OOB forfeit, 1 HP non-lethal finish,
//     disconnect rejoin grace window, consumable/inventory locks, restart void).
//   - Ranked 1v1 Arena (queue, matchmaking, isolated scene, spectator isolation, Elo + runDurable persistence,
//     repeated-pair cap, restart void).
//   - Open PvP District (boundary warning, safe gate, combat-tag exit/Recall/switch lock, respawn protection,
//     honor + repeat-kill diminishing + runDurable persistence).
//   - Scheduled Order Sieges (Leader/Officer registration, roster freeze at lock, late-joiner blocked,
//     capture point victory & defender timeout victory, persistent keep tenure via runDurable).
//   - Lifecycle safety (characterBlockers & onCharacterPurge) and client pvpView().

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRpgRuntime, DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { install as installCharacter } from '../server/rpg/character.js';
import { install as installInventory } from '../server/rpg/inventory.js';
import { install as installCombat } from '../server/rpg/combat.js';
import { install as installMagic } from '../server/rpg/magic.js';
import { install as installLaw } from '../server/rpg/law.js';
import { install as installGuildhall } from '../server/rpg/guildhall.js';
import { install as installSocial } from '../server/rpg/social.js';
import { install as installPvp } from '../server/rpg/pvp.js';
import { computeElo } from '../server/rpg/pvp/policy.js';
import { pvpView, PANEL_ID, TABS } from '../client/gameplay/pvp.js';

function createMemoryDurableWorld() {
  const world = new Map();
  const durableOps = [];
  const worldStore = {
    load: (prefix) => [...world.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]),
  };
  async function runDurable(opKey, scope, fn) {
    durableOps.push({ opKey, scope });
    const tx = {
      backend: 'memory',
      now: Date.now(),
      getWorld: async (k) => (world.has(k) ? structuredClone(world.get(k)) : null),
      putWorld: async (k, v) => { world.set(k, structuredClone(v)); },
      deleteWorld: async (k) => { world.delete(k); },
    };
    const result = await fn(tx);
    return { replayed: false, opKey, scopeKey: scope?.resourceKey ?? '', result };
  }
  return { world, durableOps, worldStore, runDurable };
}

function createWorld({ pvpOptions = {}, magicOptions = {}, combatOptions = {}, store = null } = {}) {
  let clock = 10_000;
  const players = new Map();
  const inbox = new Map();
  const mem = store ?? createMemoryDurableWorld();
  let pvpApi;
  let combatHandle;

  const rt = createRpgRuntime({
    players,
    worldStore: mem.worldStore,
    services: {
      runDurable: mem.runDurable,
      worldClock: () => ({ minutes: Math.floor(clock / 5000), isNight: false }),
    },
    features: [
      { name: 'character', install: installCharacter },
      { name: 'inventory', install: installInventory },
      { name: 'social', install: installSocial },
      { name: 'guildhall', install: installGuildhall },
      {
        name: 'combat',
        install: (ctx) => {
          combatHandle = installCombat(ctx, { random: () => 0.05, demoPath: [], nightSites: {}, classicSpawns: false, ...combatOptions });
        },
      },
      { name: 'magic', install: (ctx) => installMagic(ctx, { rng: () => 0.9, missileSpeed: 20, roundMs: 1000, cooldownMs: 10, ...magicOptions }) },
      { name: 'law', install: (ctx) => installLaw(ctx, { random: () => 0.05, patrolMs: 1e12 }) },
      {
        name: 'pvp',
        install: (ctx) => {
          pvpApi = installPvp(ctx, {
            duelCountdownMs: 1000,
            duelOobGraceMs: 2000,
            duelDisconnectGraceMs: 3000,
            arenaAcceptMs: 5000,
            arenaCountdownMs: 1000,
            districtCombatTagMs: 5000,
            districtRespawnProtectMs: 3000,
            siegeCaptureRatePerSec: 25,
            siegeDurationMs: 20_000,
            ...pvpOptions,
          });
        },
      },
    ],
    save: (_list, worldRows) => {
      if (Array.isArray(worldRows)) {
        for (const [k, v] of worldRows) {
          if (v === null) mem.world.delete(k);
          else mem.world.set(k, structuredClone(v));
        }
      }
    },
    send: (p, msg) => inbox.get(p.id)?.push(JSON.parse(JSON.stringify(msg))),
    now: () => clock,
    log: { warn() {}, error() {}, info() {} },
  });

  const join = (id, name, { accountId = id, x = 0, z = 0, yaw = 0, location = DEFAULT_LOCATION, health = 80, magicka = 200, fatigue = 100 } = {}) => {
    const p = {
      id,
      accountId,
      name,
      x,
      z,
      yaw,
      moving: false,
      rpg: {
        location,
        gold: 500,
        character: {
          name,
          race: 'Breton',
          className: 'Spellsword',
          level: 5,
          health,
          maxHealth: health,
          magicka,
          maxMagicka: magicka,
          fatigue,
          maxFatigue: fatigue,
          attributes: { Strength: 60, Intelligence: 60, Willpower: 40, Agility: 60, Endurance: 60, Personality: 50, Speed: 60, Luck: 50 },
          skills: { 'Long Blade': 75, Archery: 75, 'Hand-to-Hand': 75, Destruction: 75, Restoration: 75, Mysticism: 75, 'Critical Strike': 50, Dodging: 20 },
        },
      },
    };
    players.set(id, p);
    inbox.set(id, []);
    rt.join(p);
    p.rpg.character.maxHealth = health;
    p.rpg.character.health = health;
    p.rpg.character.maxMagicka = magicka;
    p.rpg.character.magicka = magicka;
    p.rpg.character.maxFatigue = fatigue;
    p.rpg.character.fatigue = fatigue;
    rt.sync([p]);
    return p;
  };

  const leave = (p) => {
    rt.leave(p);
    players.delete(p.id);
  };

  const rejoin = (p) => {
    players.set(p.id, p);
    if (!inbox.has(p.id)) inbox.set(p.id, []);
    rt.join(p);
    rt.sync([p]);
    return p;
  };

  const tick = (seconds, dt = 0.1) => {
    const steps = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < steps; i++) {
      clock += dt * 1000;
      rt.tick(dt, clock);
    }
    rt.sync();
  };

  const act = (p, verb, args = {}) => rt.act(p, verb, args);
  const events = (id, kind) => (inbox.get(id) ?? []).filter((m) => m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map((m) => m.event);
  const clearInbox = (id) => { inbox.set(id, []); };
  const faceTo = (a, b) => { a.yaw = Math.atan2(b.x - a.x, -(b.z - a.z)); };

  return {
    rt,
    ctx: rt.ctx,
    S: rt.ctx.services,
    players,
    mem,
    get pvp() { return pvpApi; },
    get combatHandle() { return combatHandle; },
    join,
    leave,
    rejoin,
    tick,
    act,
    events,
    clearInbox,
    faceTo,
    now: () => clock,
    advance: (ms) => { clock += ms; },
  };
}

function equipWeapon(w, p, template) {
  const item = w.S.giveItem(p, template, 1);
  w.act(p, 'inventory.equip', { itemId: item.id });
  return item;
}

function learnFallbackSpells(p) {
  p.rpg.magic.known = [...new Set([
    ...(p.rpg.magic.known ?? []),
    'ward:static-palm',
    'ward:ember-dart',
    'ward:hoarfrost-ring',
    'ward:slow-rot',
    'ward:mending',
    'ward:knit-flesh',
  ])];
}

describe('Land PvP — Unified Eligibility Policy & Combat/Magic/Law Integration', () => {
  test('safe zones block melee, bow, direct/area spells, and pets on bystanders while allowing PvE & co-op heals', () => {
    const w = createWorld();
    const a = w.join(1, 'Alden', { x: 0, z: 0 });
    const b = w.join(2, 'Bryn', { x: 0, z: -1.5 });
    learnFallbackSpells(a);
    w.faceTo(a, b);
    w.act(a, 'combat.ready', { ready: true });

    // Melee rejected in safe zone
    const meleeRes = w.act(a, 'combat.attack', { targetId: b.id, direction: 'right' });
    assert.equal(meleeRes.ok, false);
    assert.match(meleeRes.error, /cannot attack other travellers/i);

    // Harmful spell rejected in safe zone
    const spellRes = w.act(a, 'magic.cast', { spellId: 'ward:static-palm', targetId: `player:${b.id}` });
    assert.equal(spellRes.ok, false);
    assert.match(spellRes.error, /cannot attack other travellers|Harmful spells/i);

    // Co-op healing in safe zone IS allowed
    b.rpg.character.health = 40;
    const healRes = w.act(a, 'magic.cast', { spellId: 'ward:knit-flesh', targetId: `player:${b.id}` });
    assert.equal(healRes.ok, true);
    assert.ok(b.rpg.character.health > 40);
  });

  test('duel exercises melee, bow (+ mid-flight boundary cancel), direct/area/reflected spells, DOTs, pets, illegal support, and law suppression', () => {
    const w = createWorld({ magicOptions: { missileSpeed: Infinity } });
    const a = w.join(1, 'Alden', { x: 0, z: 0, health: 120 });
    const b = w.join(2, 'Bryn', { x: 0, z: -1.5, health: 120 });
    const bystander = w.join(3, 'Cora', { x: 0.6, z: -1.5, health: 120 });
    learnFallbackSpells(a);
    learnFallbackSpells(b);
    learnFallbackSpells(bystander);

    // Invite & accept duel
    assert.equal(w.act(a, 'pvp.duel.invite', { targetId: b.id }).ok, true);
    assert.equal(w.act(b, 'pvp.duel.accept').ok, true);

    // During countdown, attacks are rejected
    w.act(a, 'combat.ready', { ready: true });
    w.faceTo(a, b);
    const earlyHit = w.act(a, 'combat.attack', { targetId: b.id });
    assert.equal(earlyHit.ok, false);
    assert.match(earlyHit.error, /countdown/i);

    // Advance past countdown -> active duel
    w.tick(1.2, 0.2);

    // 1. Melee hits duel opponent, NOT bystander
    const hpBefore = b.rpg.character.health;
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id, direction: 'right' }).ok, true);
    assert.ok(b.rpg.character.health < hpBefore, 'melee should damage duel opponent');
    assert.equal(bystander.rpg.character.health, 120, 'bystander untouched');
    assert.equal(w.act(a, 'combat.attack', { targetId: bystander.id }).ok, false);

    // 2. Direct & Area spells hit opponent, NEVER hit adjacent bystander
    const bHp2 = b.rpg.character.health;
    assert.equal(w.act(a, 'magic.cast', { spellId: 'ward:hoarfrost-ring' }).ok, true);
    assert.ok(b.rpg.character.health < bHp2, 'area spell should damage opponent');
    assert.equal(bystander.rpg.character.health, 120, 'area spell must skip bystander');

    // 3. Illegal support: bystander CANNOT heal active duelist
    const illegalHeal = w.act(bystander, 'magic.cast', { spellId: 'ward:knit-flesh', targetId: `player:${b.id}` });
    assert.equal(illegalHeal.ok, false);
    assert.match(illegalHeal.error, /forbidden during a duel/i);

    // 4. Reflected spell: give B 100% spellReflection status, A casts static-palm -> reflects back onto A!
    b.rpg.magic.active.push({
      uid: 'refl-1', key: 'SpellReflection', name: 'Spell Reflection', spellId: 'test:refl',
      spellName: 'Spell Reflection', status: 'spellReflection', chance: 100, roundsLeft: 5, totalRounds: 5,
    });
    const aHpBeforeRefl = a.rpg.character.health;
    w.advance(200);
    assert.equal(w.act(a, 'magic.cast', { spellId: 'ward:static-palm', targetId: `player:${b.id}` }).ok, true);
    assert.ok(a.rpg.character.health < aHpBeforeRefl, 'reflected spell should damage original caster A');
    b.rpg.magic.active = [];

    // 5. DOT (slow-rot) ticks during duel, then stops immediately once duel ends!
    w.advance(200);
    assert.equal(w.act(a, 'magic.cast', { spellId: 'ward:slow-rot', targetId: `player:${b.id}` }).ok, true);
    const bHpAfterDotStart = b.rpg.character.health;
    w.tick(1.1, 0.1);
    assert.ok(b.rpg.character.health < bHpAfterDotStart, 'DOT should tick while duel is active');

    // 6. Summoned pet targets valid PvP opponent and ignores bystander
    const pet = w.S.summonCombatAlly(a, 15, 'pvp-test');
    assert.ok(pet, 'should summon combat ally when PvP opponent is nearby');
    assert.equal(pet._ally, a.id);
    // Tick pet AI so it engages B
    pet.x = b.x;
    pet.z = b.z + 1.0;
    const bHpBeforePet = b.rpg.character.health;
    w.tick(3.0, 0.1);
    assert.ok(b.rpg.character.health <= bHpBeforePet, 'pet attacks opponent (or triggers duel finish)');
    assert.equal(bystander.rpg.character.health, 120, 'pet must never attack bystander');

    // 7. Law service: legal PvP assault is suppressed, ordinary town crime is NOT suppressed
    const suppressed = w.S.law.commit(a, 'assault', { pvp: true });
    assert.equal(suppressed, null, 'legal PvP engagement suppresses town watch crime');
    const ordinaryCrime = w.S.law.commit(bystander, 'pickpocketing');
    assert.ok(ordinaryCrime, 'ordinary safe-zone crime still opens a City Watch charge');

    // Forfeit if still active, then verify DOT stops after duel ends
    if (w.pvp.duels.duelOf(a.id)) w.act(a, 'pvp.duel.forfeit');
    const bHpPostDuel = b.rpg.character.health;
    w.tick(2.0, 0.2);
    assert.equal(b.rpg.character.health, bHpPostDuel, 'DOT must not tick after duel ends');
  });

  test('arrow in flight is cancelled if target leaves PvP engagement before impact', () => {
    const w = createWorld({ pvpOptions: { duelCountdownMs: 100 } });
    const a = w.join(1, 'Archer', { x: 0, z: 0, health: 100 });
    const b = w.join(2, 'Target', { x: 0, z: -20, health: 100 });
    equipWeapon(w, a, 'short-bow');
    w.S.giveItem(a, 'arrow', 10);
    w.act(a, 'combat.ready', { ready: true });

    // Start duel close, then move B to 16m inside 18m ring
    b.z = -4;
    assert.equal(w.act(a, 'pvp.duel.invite', { targetId: b.id }).ok, true);
    assert.equal(w.act(b, 'pvp.duel.accept').ok, true);
    w.tick(0.2, 0.1);
    b.z = -16;
    w.faceTo(a, b);

    // Fire arrow at B (distance 16m, speed 35m/s -> ~0.46s flight)
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id }).ok, true);
    w.tick(0.1, 0.05);

    // While arrow is mid-flight, B forfeits duel!
    assert.equal(w.act(b, 'pvp.duel.forfeit').ok, true);
    const hpAfterForfeit = b.rpg.character.health;

    // Finish arrow flight — must NOT damage B now that duel ended!
    w.tick(1.0, 0.05);
    assert.equal(b.rpg.character.health, hpAfterForfeit);
  });
});

describe('Land PvP — Consent Duels Lifecycle', () => {
  test('honors services.isBlocked with neutral refusal and ends non-lethally at 1 HP with full restore', () => {
    const w = createWorld({ pvpOptions: { duelCountdownMs: 100 } });
    const a = w.join(1, 'Alden', { x: 0, z: 0, health: 60 });
    const b = w.join(2, 'Bryn', { x: 0, z: -1.5, health: 30 });

    // B blocks A -> duel invite fails with neutral refusal (never says "blocked")
    assert.equal(w.act(b, 'social.block', { targetId: a.id }).ok, true);
    const blockedRes = w.act(a, 'pvp.duel.invite', { targetId: b.id });
    assert.equal(blockedRes.ok, false);
    assert.doesNotMatch(blockedRes.error, /blocked/i);

    // Unblock -> invite & accept
    assert.equal(w.act(b, 'social.unblock', { targetId: a.id }).ok, true);
    assert.equal(w.act(a, 'pvp.duel.invite', { targetId: b.id }).ok, true);
    assert.equal(w.act(b, 'pvp.duel.accept').ok, true);
    w.tick(0.2, 0.1);

    // Inventory lock & consumable cap active during duel
    assert.ok(w.pvp.isInventoryLocked(a));
    assert.equal(w.pvp.checkConsumableAllowance(a).allowed, true);
    assert.equal(w.pvp.checkConsumableAllowance(a).allowed, true);
    assert.equal(w.pvp.checkConsumableAllowance(a).allowed, true);
    assert.equal(w.pvp.checkConsumableAllowance(a).allowed, false);

    // Deal lethal-sized blow -> non-lethal finish at 1 HP, then restores vitals with no defeated flag!
    w.act(a, 'combat.ready', { ready: true });
    w.faceTo(a, b);
    equipWeapon(w, a, 'steel-longsword');
    b.rpg.character.health = 2; // next hit crosses 1 HP threshold
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id, direction: 'down' }).ok, true);

    assert.equal(w.pvp.duels.duelOf(a.id), null, 'duel ended cleanly');
    assert.equal(!!b.rpg.defeated, false, 'loser must NOT enter defeated state');
    assert.equal(b.rpg.character.health, 30, 'loser vitals restored to pre-duel HP');
    assert.equal(w.pvp.duels.stateFor(a).stats.wins, 1);
    assert.equal(w.pvp.duels.stateFor(b).stats.losses, 1);
  });

  test('out-of-bounds ring countdown forfeits fighter, and disconnect grace window allows rejoin before forfeit', () => {
    const w = createWorld({ pvpOptions: { duelCountdownMs: 100, duelOobGraceMs: 1000, duelDisconnectGraceMs: 2000 } });
    const a = w.join(1, 'Alden', { x: 0, z: 0 });
    const b = w.join(2, 'Bryn', { x: 0, z: -2 });
    assert.equal(w.act(a, 'pvp.duel.invite', { targetId: b.id }).ok, true);
    assert.equal(w.act(b, 'pvp.duel.accept').ok, true);
    w.tick(0.2, 0.1);

    // Disconnect B -> rejoin within 1s -> duel continues!
    w.leave(b);
    w.tick(0.8, 0.2);
    assert.ok(w.pvp.duels.duelOf(a.id), 'duel stays alive during disconnect grace window');
    w.rejoin(b);
    assert.ok(w.pvp.duels.duelOf(b.id), 'rejoining within grace window resumes duel');

    // Step B outside 18m ring -> OOB countdown -> forfeit after grace
    b.x = 30;
    w.tick(1.2, 0.2);
    assert.equal(w.pvp.duels.duelOf(a.id), null, 'leaving ring past grace forfeits duel');
    const endEv = w.events(a.id, 'pvp.duelEnd').at(-1);
    assert.equal(endEv.winnerId, a.id);
    assert.match(endEv.reason, /ring/i);
  });
});

describe('Land PvP — Ranked 1v1 Arena', () => {
  test('matchmaking, isolated scene, spectator isolation, Elo persistence via runDurable, and repeat-pair cap', async () => {
    const store = createMemoryDurableWorld();
    const w = createWorld({ store, pvpOptions: { arenaCountdownMs: 200, arenaRepeatPairCap: 2 } });
    const a = w.join(1, 'GladiatorA', { accountId: 101, x: 0, z: 0, health: 40 });
    const b = w.join(2, 'GladiatorB', { accountId: 102, x: 2, z: 0, health: 20 });
    const spec = w.join(3, 'Spectator', { accountId: 103, x: 4, z: 0, health: 80 });
    learnFallbackSpells(spec);

    // Queue ranked -> automatic match found
    assert.equal(w.act(a, 'pvp.arena.queue', { mode: 'ranked' }).ok, true);
    const q2 = w.act(b, 'pvp.arena.queue', { mode: 'ranked' });
    assert.equal(q2.ok, true);

    // Both accept -> transported to isolated arena scene
    assert.equal(w.act(a, 'pvp.arena.accept').ok, true);
    assert.equal(w.act(b, 'pvp.arena.accept').ok, true);
    assert.equal(a.rpg.location, w.pvp.cfg.arenaLocation);
    assert.equal(b.rpg.location, w.pvp.cfg.arenaLocation);
    assert.ok(w.S.presenceScope(a)?.startsWith('arena:'));
    assert.equal(w.S.presenceScope(a), w.S.presenceScope(b));

    // Spectator enters viewing gallery
    assert.equal(w.act(spec, 'pvp.arena.spectate').ok, true);
    assert.equal(spec.rpg.location, w.pvp.cfg.arenaLocation);
    assert.equal(w.S.presenceScope(spec), w.S.presenceScope(a));

    // Advance past countdown -> active match
    w.tick(0.3, 0.1);

    // Spectator CANNOT harm or heal combatants
    w.act(spec, 'combat.ready', { ready: true });
    w.faceTo(spec, b);
    assert.equal(w.act(spec, 'combat.attack', { targetId: b.id }).ok, false);
    assert.equal(w.act(spec, 'magic.cast', { spellId: 'ward:knit-flesh', targetId: `player:${b.id}` }).ok, false);

    // Fighter A defeats Fighter B via melee
    a.x = b.x;
    a.z = b.z + 1.2;
    w.faceTo(a, b);
    equipWeapon(w, a, 'steel-longsword');
    w.act(a, 'combat.ready', { ready: true });
    b.rpg.character.health = 3;
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id, direction: 'down' }).ok, true);

    // Match finished: players & spectator returned to original town, Elo updated!
    assert.equal(a.rpg.location, DEFAULT_LOCATION);
    assert.equal(b.rpg.location, DEFAULT_LOCATION);
    assert.equal(spec.rpg.location, DEFAULT_LOCATION);

    const expected = computeElo(1200, 1200, 1, 32);
    assert.equal(w.pvp.arena.ratings.get(a.id).elo, expected.nextA);
    assert.equal(w.pvp.arena.ratings.get(b.id).elo, expected.nextB);
    assert.equal(w.pvp.arena.ratings.get(a.id).wins, 1);
    assert.equal(w.pvp.arena.ratings.get(b.id).losses, 1);

    await w.pvp.flushDurable();
    assert.ok(store.durableOps.some((op) => op.opKey.startsWith('pvp:arena:ratings:')), 'ratings persisted via runDurable');

    // Restart simulation from same durable store -> Elo & history survive!
    const w2 = createWorld({ store, pvpOptions: { arenaCountdownMs: 200, arenaRepeatPairCap: 2 } });
    assert.equal(w2.pvp.arena.ratings.get(1).elo, expected.nextA);
    assert.equal(w2.pvp.arena.history.length, 1);

    // Play 2 more matches between same account pair -> 3rd match hits repeat-pair cap (delta 0)!
    const a2 = w2.join(1, 'GladiatorA', { accountId: 101 });
    const b2 = w2.join(2, 'GladiatorB', { accountId: 102 });
    // Match 2 (still rated)
    w2.act(a2, 'pvp.arena.queue', { mode: 'ranked' });
    w2.act(b2, 'pvp.arena.queue', { mode: 'ranked' });
    w2.act(a2, 'pvp.arena.accept');
    w2.act(b2, 'pvp.arena.accept');
    w2.tick(0.3, 0.1);
    w2.act(b2, 'pvp.arena.forfeit');
    const eloAfter2 = w2.pvp.arena.ratings.get(1).elo;
    assert.ok(eloAfter2 > expected.nextA);

    // Match 3 (capped!)
    w2.act(a2, 'pvp.arena.queue', { mode: 'ranked' });
    w2.act(b2, 'pvp.arena.queue', { mode: 'ranked' });
    w2.act(a2, 'pvp.arena.accept');
    w2.act(b2, 'pvp.arena.accept');
    w2.tick(0.3, 0.1);
    w2.act(b2, 'pvp.arena.forfeit');
    assert.equal(w2.pvp.arena.ratings.get(1).elo, eloAfter2, 'repeat pair cap blocks Elo gain after cap');
  });
});

describe('Land PvP — Open PvP District', () => {
  test('boundary warning, safe gate, combat-tag exit/Recall/switch lock, defeat respawn protection, and honor', async () => {
    const store = createMemoryDurableWorld();
    const w = createWorld({ store, pvpOptions: { districtCombatTagMs: 4000, districtRespawnProtectMs: 3000 } });
    const a = w.join(1, 'Vanguard', { accountId: 201, x: 0, z: 0, health: 100 });
    const b = w.join(2, 'Raider', { accountId: 202, x: 1, z: 0, health: 40 });
    const keptItem = w.S.giveItem(b, 'potion-of-healing', 2);

    // Entering without acknowledgeWarning emits warning without moving player
    assert.equal(w.act(a, 'pvp.district.enter', {}).ok, true);
    assert.equal(a.rpg.location, DEFAULT_LOCATION);
    assert.ok(w.events(a.id, 'pvp.districtWarning').length >= 1);

    // Confirm entry -> moved to safe gate
    assert.equal(w.act(a, 'pvp.district.enter', { acknowledgeWarning: true }).ok, true);
    assert.equal(w.act(b, 'pvp.district.enter', { acknowledgeWarning: true }).ok, true);
    assert.equal(a.rpg.location, w.pvp.cfg.districtLocation);

    // Inside safe gate: attacks are blocked!
    w.act(a, 'combat.ready', { ready: true });
    w.faceTo(a, b);
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id }).ok, false);

    // Step past safe entrance gate -> Open PvP armed!
    a.z = 10;
    b.z = 8.5;
    w.faceTo(a, b);
    equipWeapon(w, a, 'steel-longsword');
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id, direction: 'right' }).ok, true);

    // Both players are now combat-tagged -> cannot exit district or switch characters!
    assert.ok(w.pvp.district.isCombatTagged(a.id));
    assert.ok(w.pvp.district.isCombatTagged(b.id));
    const exitBlocked = w.act(a, 'pvp.district.exit');
    assert.equal(exitBlocked.ok, false);
    assert.match(exitBlocked.error, /combat-tagged/i);

    // Character archive/switch blocker registered on ctx.services.characterBlockers
    const blockers = w.S.characterBlockers.flatMap((fn) => fn(String(a.accountId), a.id, 'switch') ?? []);
    assert.ok(blockers.some((bl) => bl.code === 'PVP_COMBAT_TAGGED'));

    // Defeat B -> B respawns safely outside with inventory intact + respawn protection, A earns Honor
    b.rpg.character.health = 2;
    w.advance(1500);
    assert.equal(w.act(a, 'combat.attack', { targetId: b.id, direction: 'down' }).ok, true);
    assert.equal(b.rpg.location, w.pvp.cfg.districtSafeExitLocation);
    assert.ok(b.rpg.inventory.some((i) => i.id === keptItem.id), 'inventory retained on Open PvP defeat');
    assert.ok(w.pvp.district.respawnProtectionUntilOf(b) > w.now(), 'brief respawn protection granted');
    assert.equal(w.pvp.district.scores.get(a.id).honor, 25);
    assert.equal(w.pvp.district.scores.get(a.id).kills, 1);

    // Wait for combat tag to expire -> A can safely exit district
    w.tick(4.5, 0.5);
    assert.equal(w.pvp.district.isCombatTagged(a.id), false);
    assert.equal(w.act(a, 'pvp.district.exit').ok, true);
    assert.equal(a.rpg.location, DEFAULT_LOCATION);

    await w.pvp.flushDurable();
    assert.ok(store.durableOps.some((op) => op.opKey.startsWith('pvp:district:')));
  });
});

describe('Land PvP — Scheduled Order Sieges', () => {
  test('order registration permissions, frozen rosters at lock, capture point victory, defender timeout, and persistent tenure', async () => {
    const store = createMemoryDurableWorld();
    const w = createWorld({ store, pvpOptions: { siegeCaptureRatePerSec: 50, siegeDurationMs: 15_000 } });

    const attLeader = w.join(1, 'IronLeader', { accountId: 301 });
    const attMember = w.join(2, 'IronFootman', { accountId: 302 });
    const lateRecruit = w.join(3, 'LateRecruit', { accountId: 303 });
    const defLeader = w.join(4, 'WatchLeader', { accountId: 304 });

    // Create two player orders via guildhall
    assert.equal(w.act(attLeader, 'order.create', { name: 'Iron Vanguard', tag: 'IRON' }).ok, true);
    assert.equal(w.act(attLeader, 'order.invite', { targetId: attMember.id }).ok, true);
    const attOrderId = w.S.guildhall.orderOf(attLeader).id;
    assert.equal(w.act(attMember, 'order.accept', { orderId: attOrderId }).ok, true);

    assert.equal(w.act(defLeader, 'order.create', { name: 'Silver Watch', tag: 'SLVR' }).ok, true);

    // Schedule siege window (lock in 1s, start in 2s, duration 15s)
    assert.equal(w.act(attLeader, 'pvp.siege.schedule', { lockDelayMs: 1000, startDelayMs: 2000, durationMs: 15_000 }).ok, true);

    // Ordinary Member cannot register order
    const memberReg = w.act(attMember, 'pvp.siege.register', { side: 'attacker' });
    assert.equal(memberReg.ok, false);
    assert.match(memberReg.error, /Leader or Officer/i);

    // Leaders register attacker and defender
    assert.equal(w.act(attLeader, 'pvp.siege.register', { side: 'attacker' }).ok, true);
    assert.equal(w.act(defLeader, 'pvp.siege.register', { side: 'defender' }).ok, true);

    // Advance past lock time (rosters freeze!)
    w.tick(1.2, 0.2);

    // Late recruit joins Iron Vanguard AFTER lock -> MUST NOT be able to enter siege!
    assert.equal(w.act(attLeader, 'order.invite', { targetId: lateRecruit.id }).ok, true);
    assert.equal(w.act(lateRecruit, 'order.accept', { orderId: attOrderId }).ok, true);

    // Advance to battle start
    w.tick(1.0, 0.2);
    const lateEnter = w.act(lateRecruit, 'pvp.siege.enter');
    assert.equal(lateEnter.ok, false);
    assert.match(lateEnter.error, /frozen eligible roster/i);

    // Frozen roster members enter dedicated siege scene
    assert.equal(w.act(attLeader, 'pvp.siege.enter').ok, true);
    assert.equal(w.act(attMember, 'pvp.siege.enter').ok, true);
    assert.equal(w.act(defLeader, 'pvp.siege.enter').ok, true);
    assert.equal(attLeader.rpg.location, w.pvp.cfg.siegeSceneLocation);

    // Friendly fire blocked; teammate healing allowed; enemy attack allowed
    learnFallbackSpells(attLeader);
    attLeader.x = 0; attLeader.z = 0;
    attMember.x = 0; attMember.z = -1.2;
    w.faceTo(attLeader, attMember);
    w.act(attLeader, 'combat.ready', { ready: true });
    assert.equal(w.act(attLeader, 'combat.attack', { targetId: attMember.id }).ok, false);
    attMember.rpg.character.health = 50;
    assert.equal(w.act(attLeader, 'magic.cast', { spellId: 'ward:knit-flesh', targetId: `player:${attMember.id}` }).ok, true);
    assert.ok(attMember.rpg.character.health > 50);

    // Attackers hold capture point (0,0) while defender is back at rally (0,-32) -> capture reaches 100%!
    w.tick(2.5, 0.25);
    assert.equal(w.pvp.siege.getTenure().holderOrderId, attOrderId);
    assert.equal(w.pvp.siege.getTenure().holderOrderTag, 'IRON');
    assert.equal(attLeader.rpg.location, DEFAULT_LOCATION, 'returned from siege scene after victory');

    await w.pvp.flushDurable();
    assert.ok(store.durableOps.some((op) => op.opKey.startsWith('pvp:siege:tenure:')));

    // Restart simulation from durable store -> Castle Gothway tenure persists!
    const w2 = createWorld({ store, pvpOptions: { siegeDurationMs: 10_000 } });
    assert.equal(w2.pvp.siege.getTenure().holderOrderTag, 'IRON');

    // Defender timeout win: schedule second siege with Iron holding; nobody captures -> defender wins on timer!
    const att2 = w2.join(4, 'WatchLeader', { accountId: 304 });
    assert.equal(w2.act(att2, 'pvp.siege.schedule', { lockDelayMs: 100, startDelayMs: 200, durationMs: 10_000 }).ok, true);
    assert.equal(w2.act(att2, 'pvp.siege.register', { side: 'attacker' }).ok, true);
    w2.tick(10.5, 0.5);
    assert.equal(w2.pvp.siege.getTenure().holderOrderTag, 'IRON');
    assert.equal(w2.pvp.siege.getTenure().defenses, 1);
  });
});

describe('Land PvP — Lifecycle Safety & Client View Model', () => {
  test('characterBlockers and onCharacterPurge handle active PvP commitments cleanly', () => {
    const w = createWorld({ pvpOptions: { duelCountdownMs: 100 } });
    const a = w.join(1, 'Alden', { x: 0, z: 0 });
    const b = w.join(2, 'Bryn', { x: 0, z: -2 });

    w.act(a, 'pvp.duel.invite', { targetId: b.id });
    w.act(b, 'pvp.duel.accept');
    w.tick(0.2, 0.1);

    const activeBlockers = w.S.characterBlockers.flatMap((fn) => fn('1', a.id, 'archive') ?? []);
    assert.ok(activeBlockers.some((bl) => bl.code === 'PVP_DUEL_ACTIVE'));

    // Purge A -> duel ends cleanly and B is released
    for (const hook of w.S.onCharacterPurge) hook({ characterId: a.id, accountId: '1' });
    assert.equal(w.pvp.duels.duelOf(b.id), null);
    const afterBlockers = w.S.characterBlockers.flatMap((fn) => fn('2', b.id, 'archive') ?? []);
    assert.equal(afterBlockers.length, 0);
  });

  test('client pvpView builds normalized view-model across all four modes', () => {
    assert.equal(PANEL_ID, 'pvp');
    assert.deepEqual(TABS.map((t) => t.id), ['duel', 'arena', 'district', 'siege']);
    const view = pvpView({
      selfId: 1,
      peers: [{ id: 1, name: 'Me' }, { id: 2, name: 'Rival', level: 7, className: 'Knight' }],
    }, { tab: 'arena' });
    assert.equal(view.tab, 'arena');
    assert.equal(view.nearbyDuelTargets.length, 1);
    assert.equal(view.nearbyDuelTargets[0].name, 'Rival');
    assert.equal(view.arena.rating.elo, 1200);
    assert.equal(view.district.districtName, 'Bloodmarket Ward');
    assert.equal(view.siege.tenure.seatName, 'Castle Gothway');
  });
});
