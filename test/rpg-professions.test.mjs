// Comprehensive tests for §3 Professions:
//   - Gathering nodes (Mining, Woodcutting, Herbalism, Fishing), reach/floor/LOS/collision/tool/rank/timer/interrupt
//   - Persistent depletion, UTC respawn across restarts, double-harvest race & opKey idempotency via runDurable
//   - Crafting stations (Smithing, Carpentry + furniture, Cooking + vitals), overweight rollback, crafted metadata
//   - Compatibility with inventory.js eligibility, stack split/merge, fingerprint, transfer & repair
//   - Classic Potion Maker (Alchemy) & Item Maker (Enchanting) XP/metadata hooks
//   - Account-scoped Daily Crafting Writs (UTC reset, multi-slot race prevention, replay)
//   - Economy anti-exploit audit (material buy -> craft -> NPC sell never yields infinite gold)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, DurableConflictError } from '../server/db.js';
import { createBufferedGameStore } from '../server/storage/postgres-game.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as professions from '../server/rpg/professions.js';

function createTestEnv(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-prof-'));
  const dbPath = join(dir, 'game.db');
  let utcMs = opts.startUtc ?? Date.UTC(2026, 10, 26, 12, 0, 0);
  let monoMs = opts.startMono ?? 10_000;

  const rawStore = openStore(dbPath, { now: () => utcMs });
  const store = opts.buffered
    ? createBufferedGameStore({
      backend: 'postgres',
      loadAllWorld: () => rawStore.loadWorld(''),
      loadWorld: (p) => rawStore.loadWorld(p),
      saveCharacters: (players, world) => rawStore.saveCharacters(players, world),
      close: () => rawStore.close(),
      async runDurable(opKey, scope, fn, tracker) {
        return rawStore.runDurable(opKey, scope, async (tx) => {
          const trackedTx = {
            ...tx,
            async saveCharacters(list, world) {
              for (const p of list || []) tracker?.recordCharacter?.(p.id);
              return tx.saveCharacters(list, world);
            },
            async putWorld(k, v) {
              tracker?.recordWorld?.(k, v);
              return tx.putWorld(k, v);
            },
          };
          return fn(trackedTx);
        });
      },
      getDurableOp: (k, s) => rawStore.getDurableOp(k, s),
    })
    : rawStore;

  const players = new Map();
  const sent = new Map(); // playerId -> msg[]
  const collisionState = {
    status: opts.collisionStatus ?? 'ready',
    canSee: opts.canSee ?? (() => true),
    footY: opts.footY ?? ((p) => p.y ?? 0),
  };
  let inCombatFn = opts.inCombat ?? (() => false);

  function buildRuntime() {
    const rt = createRpgRuntime({
      players,
      features: [
        { name: 'inventory', install: inventory.install },
        {
          name: 'professions',
          install: (ctx) => professions.install(ctx, {
            utcNow: () => utcMs,
            now: () => monoMs,
            rng: opts.rng ?? (() => 0.25),
          }),
        },
      ],
      save: (affected, world) => {
        rawStore.saveCharacters(affected, world);
      },
      send: (p, msg) => {
        if (!sent.has(p.id)) sent.set(p.id, []);
        sent.get(p.id).push(msg);
      },
      worldStore: {
        load: (prefix) => rawStore.loadWorld(prefix),
      },
      now: () => monoMs,
      services: {
        store,
        runDurable: (...a) => store.runDurable(...a),
        collision: {
          status: () => ({ status: collisionState.status }),
          footY: (p) => collisionState.footY(p),
        },
        canSee: (...a) => collisionState.canSee(...a),
        inCombat: (p) => inCombatFn(p),
      },
    });
    return rt;
  }

  let runtime = buildRuntime();

  function addPlayer(id, overrides = {}) {
    const p = {
      id,
      accountId: overrides.accountId ?? id,
      name: overrides.name ?? `Hero${id}`,
      x: overrides.x ?? 0,
      y: overrides.y ?? 0,
      z: overrides.z ?? 0,
      yaw: 0,
      rpg: {
        location: overrides.location ?? 'town:Daggerfall/Gothway Garden',
        character: {
          name: overrides.name ?? `Hero${id}`,
          health: 60,
          maxHealth: 100,
          fatigue: 50,
          maxFatigue: 100,
          magicka: 40,
          maxMagicka: 100,
          attributes: { Strength: 60 },
        },
        ...(overrides.rpg ?? {}),
      },
    };
    players.set(id, p);
    runtime.join(p);
    // Persist initial character row in SQLite so tx.saveCharacters / durable ops can operate cleanly.
    rawStore.saveCharacters([p], []);
    return p;
  }

  function eventsOf(playerId, kind = null) {
    const list = (sent.get(playerId) ?? []).filter((m) => m.type === 'gameEvent').map((m) => m.event);
    return kind ? list.filter((e) => e.kind === kind) : list;
  }

  function clearEvents(playerId) {
    if (playerId != null) sent.set(playerId, []);
    else sent.clear();
  }

  return {
    dir,
    dbPath,
    store,
    rawStore,
    players,
    get runtime() { return runtime; },
    get ctx() { return runtime.ctx; },
    get utcMs() { return utcMs; },
    get monoMs() { return monoMs; },
    advanceUtc(ms) { utcMs += ms; },
    advanceMono(ms) { monoMs += ms; },
    setCollisionStatus(s) { collisionState.status = s; },
    setCanSee(fn) { collisionState.canSee = fn; },
    setFootY(fn) { collisionState.footY = fn; },
    setInCombat(fn) { inCombatFn = fn; },
    addPlayer,
    eventsOf,
    clearEvents,
    restart() {
      // Simulate full server restart preserving SQLite database only.
      players.clear();
      sent.clear();
      runtime = buildRuntime();
      return runtime;
    },
    cleanup() {
      try { rawStore.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function equipTool(env, player, template) {
  const it = env.ctx.services.giveItem(player, template, 1);
  const res = env.runtime.act(player, 'inventory.equip', { itemId: it.id });
  assert.equal(res.ok, true, res.error);
  return it;
}

describe('1. Gathering Nodes: Spatial, Visibility, Tool, Rank & Interruption Validation', () => {
  test('enforces collision readiness, reach, floor, LOS, tool, condition, rank, and timer checks', () => {
    const env = createTestEnv();
    try {
      const p = env.addPlayer(1, { x: 0, z: 0 });
      const nodes = env.ctx.services.professions.nodesAt('town:Daggerfall/Gothway Garden');
      assert.ok(nodes.length >= 8, 'Gothway Garden should have multiple nodes across all 4 gathering tracks');
      for (const track of ['mining', 'woodcutting', 'herbalism', 'fishing']) {
        assert.ok(nodes.filter((n) => n.profession === track).length >= 2, `Expected >=2 nodes for ${track}`);
      }

      const ironNode = nodes.find((n) => n.id === 'node:gothway:iron-1');
      assert.ok(ironNode);

      // Collision loading blocks interaction
      env.setCollisionStatus('loading');
      let res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /loading/i);
      env.setCollisionStatus('ready');

      // Out of reach
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /closer/i);

      // Move within reach, but wrong floor
      p.x = ironNode.x + 1;
      p.z = ironNode.z;
      p.y = 5.0;
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /different floor/i);
      p.y = 0;

      // Line of sight blocked
      env.setCanSee(() => false);
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /line of sight/i);
      env.setCanSee(() => true);

      // Missing tool names required tool & rank
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /Pickaxe/i);
      assert.match(res.error, /Rank 1/i);

      // Equip broken pickaxe -> rejected
      const pick = equipTool(env, p, 'iron-pickaxe');
      const livePick = p.rpg.inventory.find((i) => i.id === pick.id);
      livePick.condition = 0;
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /broken/i);
      livePick.condition = livePick.maxCondition;

      // Rank-gated node (Rank 2 Oak Stand) rejected at Rank 1
      const oakNode = nodes.find((n) => n.id === 'node:gothway:timber-2');
      p.x = oakNode.x;
      p.z = oakNode.z;
      equipTool(env, p, 'iron-hatchet');
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: oakNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /Rank 2/i);

      // Valid start at Iron Vein
      p.x = ironNode.x;
      p.z = ironNode.z;
      equipTool(env, p, 'iron-pickaxe');
      res = env.runtime.act(p, 'profession.gatherStart', { nodeId: ironNode.id });
      assert.equal(res.ok, true, res.error);

      // Completing too early fails
      res = env.runtime.act(p, 'profession.gatherComplete', { nodeId: ironNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /Still gathering/i);

      // Advance monotonic clock past gather duration -> succeeds!
      env.advanceMono(ironNode.gatherDurationMs + 50);
      const equippedPickId = p.rpg.equipment.rightHand;
      const condBefore = p.rpg.inventory.find((i) => i.id === equippedPickId).condition;
      res = env.runtime.act(p, 'profession.gatherComplete', { nodeId: ironNode.id, opKey: 'mine-1' });
      assert.equal(res.ok, true, res.error);

      assert.ok(env.ctx.services.countItem(p, 'iron-ore') >= 1, 'Iron Ore should be granted');
      const condAfter = p.rpg.inventory.find((i) => i.id === equippedPickId).condition;
      assert.ok(condAfter < condBefore, 'Tool wear should advance on harvest');
      assert.ok(p.rpg.professions.tracks.mining.xp > 0, 'Mining XP should increase');
    } finally {
      env.cleanup();
    }
  });

  test('interrupts active gathering on movement, combat damage, weapon swing, and defeat', () => {
    const env = createTestEnv();
    try {
      const p = env.addPlayer(1);
      const herbNode = professions.findNodeDefinition('node:gothway:herb-1');
      p.x = herbNode.x;
      p.z = herbNode.z;
      equipTool(env, p, 'iron-sickle');

      // 1) Movement interrupts on tick
      assert.equal(env.runtime.act(p, 'profession.gatherStart', { nodeId: herbNode.id }).ok, true);
      p.x += 1.2;
      env.runtime.tick(0.1, env.monoMs + 100);
      assert.equal(env.ctx.services.professions.activeGatherOf(p.id), null);
      assert.ok(env.eventsOf(p.id, 'profession.gatherInterrupted').some((e) => e.reason === 'moved'));

      // 2) Combat damage interrupts immediately
      p.x = herbNode.x;
      env.clearEvents(p.id);
      assert.equal(env.runtime.act(p, 'profession.gatherStart', { nodeId: herbNode.id }).ok, true);
      env.ctx.emit('damage', { target: p, amount: 5, source: 'rat' });
      assert.equal(env.ctx.services.professions.activeGatherOf(p.id), null);
      assert.ok(env.eventsOf(p.id, 'profession.gatherInterrupted').some((e) => e.reason === 'combat'));

      // 3) Weapon swing interrupts immediately
      env.clearEvents(p.id);
      assert.equal(env.runtime.act(p, 'profession.gatherStart', { nodeId: herbNode.id }).ok, true);
      env.ctx.emit('swing', { player: p, direction: 'left' });
      assert.equal(env.ctx.services.professions.activeGatherOf(p.id), null);
      assert.ok(env.eventsOf(p.id, 'profession.gatherInterrupted').some((e) => e.reason === 'combat'));

      // 4) Trying to gather while flagged in combat is refused
      env.setInCombat(() => true);
      const res = env.runtime.act(p, 'profession.gatherStart', { nodeId: herbNode.id });
      assert.equal(res.ok, false);
      assert.match(res.error, /combat/i);
    } finally {
      env.cleanup();
    }
  });

  test('covers all 4 gathering tracks (Mining, Woodcutting, Herbalism, Fishing) and wilderness fallback nodes', () => {
    const env = createTestEnv();
    try {
      const p = env.addPlayer(1);
      const tracks = [
        ['node:gothway:iron-1', 'iron-pickaxe', 'iron-ore', 'mining'],
        ['node:gothway:timber-1', 'iron-hatchet', 'rough-timber', 'woodcutting'],
        ['node:gothway:herb-1', 'iron-sickle', 'wild-sage', 'herbalism'],
        ['node:gothway:fish-1', 'iron-fishing-rod', 'river-trout', 'fishing'],
      ];
      for (const [nodeId, toolTpl, expectedYield, prof] of tracks) {
        const node = professions.findNodeDefinition(nodeId);
        p.x = node.x;
        p.z = node.z;
        equipTool(env, p, toolTpl);
        assert.equal(env.runtime.act(p, 'profession.gatherStart', { nodeId }).ok, true);
        env.advanceMono(node.gatherDurationMs + 50);
        const res = env.runtime.act(p, 'profession.gatherComplete', { nodeId });
        assert.equal(res.ok, true, res.error);
        assert.ok(env.ctx.services.countItem(p, expectedYield) >= 1, `Expected ${expectedYield} from ${prof}`);
        assert.ok(p.rpg.professions.tracks[prof].xp > 0);
      }

      // Deterministic procedural nodes for wilderness locations
      const wildA = professions.nodesForLocation('wilderness:Wrothgarian Mountains/12:8');
      const wildB = professions.nodesForLocation('wilderness:Wrothgarian Mountains/12:8');
      assert.equal(wildA.length, 5);
      assert.deepEqual(wildA.map((n) => n.id), wildB.map((n) => n.id));
    } finally {
      env.cleanup();
    }
  });
});

describe('2. Persistent Depletion, Respawn Across Restarts & Double-Harvest Race (runDurable)', () => {
  test('persists depletion across restart, recovers on UTC deadline, and prevents double-harvest race via runDurable', async () => {
    const env = createTestEnv({ buffered: false });
    try {
      const node = professions.findNodeDefinition('node:gothway:iron-1'); // maxCharges = 3
      const p1 = env.addPlayer(1, { x: node.x, z: node.z });
      const p2 = env.addPlayer(2, { x: node.x + 0.5, z: node.z });
      equipTool(env, p1, 'iron-pickaxe');
      equipTool(env, p2, 'iron-pickaxe');

      // Deplete 2 of 3 charges via durable completion
      for (let i = 1; i <= 2; i++) {
        assert.equal(env.runtime.act(p1, 'profession.gatherStart', { nodeId: node.id }).ok, true);
        env.advanceMono(node.gatherDurationMs + 10);
        const r = await env.ctx.services.professions.completeGatherDurable(p1, { nodeId: node.id, opKey: `pre-${i}` });
        assert.equal(r.replayed, false);
        assert.equal(r.result.chargesRemaining, 3 - i);
      }

      // Now 1 charge remains! Both p1 and p2 start gathering before it depletes, then race for the last charge!
      assert.equal(env.runtime.act(p1, 'profession.gatherStart', { nodeId: node.id }).ok, true);
      assert.equal(env.runtime.act(p2, 'profession.gatherStart', { nodeId: node.id }).ok, true);
      env.advanceMono(node.gatherDurationMs + 10);

      const oreBeforeP1 = env.ctx.services.countItem(p1, 'iron-ore');
      const oreBeforeP2 = env.ctx.services.countItem(p2, 'iron-ore');
      const toolCondP2Before = p2.rpg.inventory.find((i) => i.template === 'iron-pickaxe').condition;

      const settled = await Promise.allSettled([
        env.ctx.services.professions.completeGatherDurable(p1, { nodeId: node.id, opKey: 'race-p1' }),
        env.ctx.services.professions.completeGatherDurable(p2, { nodeId: node.id, opKey: 'race-p2' }),
      ]);

      const winners = settled.filter((s) => s.status === 'fulfilled');
      const losers = settled.filter((s) => s.status === 'rejected');
      assert.equal(winners.length, 1, 'Exactly one gatherer must win the final charge');
      assert.equal(losers.length, 1, 'Second gatherer must be rejected cleanly');
      assert.equal(losers[0].reason.code, 'NODE_DEPLETED');
      assert.equal(winners[0].value.result.depleted, true);
      assert.equal(winners[0].value.result.chargesRemaining, 0);

      // Verify loser got no ore and suffered no tool wear
      const winnerIsP1 = settled[0].status === 'fulfilled';
      if (winnerIsP1) {
        assert.ok(env.ctx.services.countItem(p1, 'iron-ore') > oreBeforeP1);
        assert.equal(env.ctx.services.countItem(p2, 'iron-ore'), oreBeforeP2);
        assert.equal(p2.rpg.inventory.find((i) => i.template === 'iron-pickaxe').condition, toolCondP2Before);
      }

      // Idempotency replay: retrying winner's opKey returns replayed:true without extra ore/XP
      const winnerPlayer = winnerIsP1 ? p1 : p2;
      const winnerKey = winnerIsP1 ? 'race-p1' : 'race-p2';
      const oreSnap = env.ctx.services.countItem(winnerPlayer, 'iron-ore');
      const xpSnap = winnerPlayer.rpg.professions.tracks.mining.xp;
      const replay = await env.ctx.services.professions.completeGatherDurable(winnerPlayer, { nodeId: node.id, opKey: winnerKey });
      assert.equal(replay.replayed, true);
      assert.equal(env.ctx.services.countItem(winnerPlayer, 'iron-ore'), oreSnap);
      assert.equal(winnerPlayer.rpg.professions.tracks.mining.xp, xpSnap);

      // Conflict check: reusing opKey with different nodeId throws DurableConflictError
      await assert.rejects(
        () => env.ctx.services.professions.completeGatherDurable(winnerPlayer, { nodeId: 'node:gothway:iron-2', opKey: winnerKey, skipSessionCheck: true }),
        (err) => err instanceof DurableConflictError || err.code === 'DURABLE_KEY_CONFLICT',
      );

      // Simulate server restart while node is depleted -> depletion persists!
      env.restart();
      const p3 = env.addPlayer(3, { x: node.x, z: node.z });
      equipTool(env, p3, 'iron-pickaxe');
      const depletedView = env.ctx.services.professions.nodesAt(node.location).find((n) => n.id === node.id);
      assert.equal(depletedView.depleted, true);
      assert.equal(depletedView.charges, 0);
      assert.ok(depletedView.respawnRemainingMs > 0);

      const startDepleted = env.runtime.act(p3, 'profession.gatherStart', { nodeId: node.id });
      assert.equal(startDepleted.ok, false);
      assert.match(startDepleted.error, /depleted/i);

      // Advance UTC clock past respawn deadline -> lazy recovery restores full charges!
      env.advanceUtc(node.respawnMs + 1000);
      const recoveredView = env.ctx.services.professions.nodesAt(node.location).find((n) => n.id === node.id);
      assert.equal(recoveredView.depleted, false);
      assert.equal(recoveredView.charges, node.maxCharges);
      assert.equal(env.runtime.act(p3, 'profession.gatherStart', { nodeId: node.id }).ok, true);
    } finally {
      env.cleanup();
    }
  });

  test('works seamlessly through createBufferedGameStore wrapper', async () => {
    const env = createTestEnv({ buffered: true });
    try {
      const node = professions.findNodeDefinition('node:gothway:timber-1');
      const p = env.addPlayer(1, { x: node.x, z: node.z });
      equipTool(env, p, 'iron-hatchet');
      assert.equal(env.runtime.act(p, 'profession.gatherStart', { nodeId: node.id }).ok, true);
      env.advanceMono(node.gatherDurationMs + 10);
      const out = await env.ctx.services.professions.completeGatherDurable(p, { nodeId: node.id, opKey: 'buf-harvest-1' });
      assert.equal(out.replayed, false);
      assert.equal(out.result.chargesRemaining, node.maxCharges - 1);
      assert.ok(env.ctx.services.countItem(p, 'rough-timber') >= 1);
    } finally {
      env.cleanup();
    }
  });
});

describe('3. Crafting Stations, Overweight Safety, Crafted Metadata & Classic Hooks', () => {
  test('crafts across Smithing, Carpentry (incl. furniture), and Cooking (with vitals restore)', async () => {
    const env = createTestEnv();
    try {
      const p = env.addPlayer(1, { name: 'Aelric' });
      const anvil = professions.findStationDefinition('station:gothway:anvil');
      const bench = professions.findStationDefinition('station:gothway:workbench');
      const hearth = professions.findStationDefinition('station:gothway:hearth');

      // ---- Smithing at Anvil ----
      p.x = anvil.x;
      p.z = anvil.z;
      env.ctx.services.giveItem(p, 'iron-ore', 4);
      env.ctx.services.giveItem(p, 'coal-lump', 2);
      env.ctx.services.giveItem(p, 'rough-timber', 2);

      // Wrong station rejected
      const wrongSt = env.runtime.act(p, 'profession.craft', { stationId: anvil.id, recipeId: 'saw-oak-plank' });
      assert.equal(wrongSt.ok, false);
      assert.match(wrongSt.error, /Workbench/i);

      // Smelt 2 iron ingots via durable craft
      const smelt = await env.ctx.services.professions.craftDurable(p, {
        stationId: anvil.id, recipeId: 'smelt-iron-ingot', quantity: 2, opKey: 'craft-ingot-1',
      });
      assert.equal(smelt.replayed, false);
      assert.equal(smelt.result.outputQuantity, 2);
      assert.equal(env.ctx.services.countItem(p, 'iron-ingot'), 2);
      assert.equal(env.ctx.services.countItem(p, 'iron-ore'), 0);

      // Forge iron nails & field repair kit
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: anvil.id, recipeId: 'forge-iron-nails' }).ok, true);
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: anvil.id, recipeId: 'craft-field-repair-kit' }).ok, true);
      assert.equal(env.ctx.services.countItem(p, 'iron-nails'), 4);
      assert.equal(env.ctx.services.countItem(p, 'field-repair-kit'), 1);

      // ---- Carpentry at Workbench (including home/hall furniture!) ----
      p.x = bench.x;
      p.z = bench.z;
      env.ctx.services.giveItem(p, 'rough-timber', 4);
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: bench.id, recipeId: 'saw-oak-plank', quantity: 2 }).ok, true);
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: bench.id, recipeId: 'craft-oak-chair' }).ok, true);

      const chair = p.rpg.inventory.find((i) => i.template === 'crafted-oak-chair');
      assert.ok(chair, 'Crafted Oak Chair furniture must exist in pack');
      assert.equal(chair.group, 'furniture');
      assert.equal(chair.crafted.makerId, p.id);
      assert.equal(chair.crafted.makerName, 'Aelric');
      assert.equal(chair.crafted.profession, 'carpentry');
      assert.equal(chair.crafted.quality, 'Standard');
      assert.deepEqual(chair.crafted.furniture, { category: 'seating', footprint: { w: 0.7, d: 0.7 }, decorative: true });

      // ---- Cooking at Hearth + vitals recovery ----
      p.x = hearth.x;
      p.z = hearth.z;
      env.ctx.services.giveItem(p, 'river-trout', 1);
      env.ctx.services.giveItem(p, 'wild-sage', 1);
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: hearth.id, recipeId: 'cook-grilled-trout' }).ok, true);
      const trout = p.rpg.inventory.find((i) => i.template === 'grilled-trout');
      assert.ok(trout);
      const hpBefore = p.rpg.character.health;
      const ftBefore = p.rpg.character.fatigue;
      assert.equal(env.runtime.act(p, 'profession.eat', { itemId: trout.id }).ok, true);
      assert.equal(p.rpg.character.health, hpBefore + 8);
      assert.equal(p.rpg.character.fatigue, ftBefore + 18);
      assert.equal(env.ctx.services.countItem(p, 'grilled-trout'), 0);
    } finally {
      env.cleanup();
    }
  });

  test('enforces overweight protection without consuming inputs, rejects ineligible inputs, and preserves crafted metadata across transfer/stack/repair', () => {
    const env = createTestEnv();
    try {
      const p1 = env.addPlayer(1, { name: 'SmithOne' });
      const p2 = env.addPlayer(2, { name: 'SmithTwo' });
      const bench = professions.findStationDefinition('station:gothway:workbench');
      p1.x = bench.x;
      p1.z = bench.z;

      // 1) Overweight check leaves inputs & gold completely intact
      p1.rpg.character.attributes.Strength = 20; // maxEncumbrance = 30 kg
      // Fill inventory close to limit using heavy armor
      env.ctx.services.giveItem(p1, 'iron-cuirass', 1); // 12.5 kg
      env.ctx.services.giveItem(p1, 'oak-plank', 2); // 2.5 kg
      env.ctx.services.giveItem(p1, 'iron-nails', 2); // 0.2 kg
      // Reduce Strength so crafted-oak-chair (4.0 kg, net +1.3 kg) exceeds carry cap
      const curKg = inventory.carriedWeight(p1.rpg);
      p1.rpg.character.attributes.Strength = Math.floor((curKg + 0.5) / 1.5); // max < curKg + 1.3
      const goldBefore = p1.rpg.gold;
      const planksBefore = env.ctx.services.countItem(p1, 'oak-plank');
      const nailsBefore = env.ctx.services.countItem(p1, 'iron-nails');

      const overRes = env.runtime.act(p1, 'profession.craft', { stationId: bench.id, recipeId: 'craft-oak-chair' });
      assert.equal(overRes.ok, false);
      assert.match(overRes.error, /carry limit/i);
      assert.equal(p1.rpg.gold, goldBefore, 'Gold must remain untouched on overweight failure');
      assert.equal(env.ctx.services.countItem(p1, 'oak-plank'), planksBefore, 'Inputs must remain untouched');
      assert.equal(env.ctx.services.countItem(p1, 'iron-nails'), nailsBefore, 'Inputs must remain untouched');

      // 2) Stolen crafting inputs are rejected by inventory.checkItemEligibility('craft')
      p1.rpg.character.attributes.Strength = 80;
      p1.rpg.inventory = p1.rpg.inventory.filter((i) => i.template !== 'oak-plank');
      inventory.addItem(p1.rpg, 'oak-plank', 2, { extra: { stolen: { from: 'shop', at: 1 } } });
      const stolenRes = env.runtime.act(p1, 'profession.craft', { stationId: bench.id, recipeId: 'craft-oak-chair' });
      assert.equal(stolenRes.ok, false);
      assert.match(stolenRes.error, /stolen/i);

      // 3) Crafted metadata, quality scaling, inventory.js eligibility, stacking, transfer, and repair
      const anvil = professions.findStationDefinition('station:gothway:anvil');
      p1.x = anvil.x; p1.z = anvil.z;
      p2.x = anvil.x; p2.z = anvil.z;

      // Boost p1 to Rank 5 Smithing -> Rank 1 recipes yield Superior quality (delta = 4)
      professions.awardProfessionXp(p1.rpg, 'smithing', 900);
      assert.equal(p1.rpg.professions.tracks.smithing.rank, 5);

      env.ctx.services.giveItem(p1, 'iron-ore', 4);
      env.ctx.services.giveItem(p1, 'coal-lump', 2);
      env.ctx.services.giveItem(p2, 'iron-ore', 2);
      env.ctx.services.giveItem(p2, 'coal-lump', 1);

      assert.equal(env.runtime.act(p1, 'profession.craft', { stationId: anvil.id, recipeId: 'smelt-iron-ingot' }).ok, true);
      assert.equal(env.runtime.act(p1, 'profession.craft', { stationId: anvil.id, recipeId: 'smelt-iron-ingot' }).ok, true);
      assert.equal(env.runtime.act(p2, 'profession.craft', { stationId: anvil.id, recipeId: 'smelt-iron-ingot' }).ok, true);

      const p1Ingot = p1.rpg.inventory.find((i) => i.template === 'iron-ingot');
      const p2Ingot = p2.rpg.inventory.find((i) => i.template === 'iron-ingot');
      assert.equal(p1Ingot.quantity, 2, 'Two identical crafted ingots from same maker & quality merge cleanly');
      assert.equal(p1Ingot.crafted.quality, 'Superior');
      assert.equal(p2Ingot.crafted.quality, 'Standard');
      assert.equal(inventory.canMergeStacks(p1Ingot, p2Ingot), false, 'Different maker/quality stacks must not merge');
      assert.notEqual(inventory.itemFingerprint(p1Ingot), inventory.itemFingerprint(p2Ingot));

      // Eligible for trade, storage, market, auction
      for (const tt of ['trade', 'storage', 'market', 'auction']) {
        const chk = inventory.checkItemEligibility(p1Ingot, tt, tt === 'auction' ? { quantity: 1 } : {});
        assert.equal(chk.ok, true, `Crafted item should be eligible for ${tt}`);
      }

      // Partial split + transfer to p2 preserves crafted metadata and keeps distinct from p2's stack
      const moved = env.ctx.services.transferItem(p1, p2, p1Ingot.id, 1, { transferType: 'trade' });
      assert.equal(moved.crafted.makerId, p1.id);
      assert.equal(moved.crafted.quality, 'Superior');
      const p2Ingots = p2.rpg.inventory.filter((i) => i.template === 'iron-ingot');
      assert.equal(p2Ingots.length, 2, 'Transferred crafted stack from p1 stays separate from p2 stack');

      // Crafted weapon repaired with crafted field-repair-kit preserves ID & crafted metadata
      env.ctx.services.giveItem(p1, 'iron-ingot', 1);
      env.ctx.services.giveItem(p1, 'rough-timber', 2);
      assert.equal(env.runtime.act(p1, 'profession.craft', { stationId: anvil.id, recipeId: 'forge-iron-dagger' }).ok, true);
      assert.equal(env.runtime.act(p1, 'profession.craft', { stationId: anvil.id, recipeId: 'craft-field-repair-kit' }).ok, true);
      const dagger = p1.rpg.inventory.find((i) => i.template === 'iron-dagger' && i.crafted);
      const kit = p1.rpg.inventory.find((i) => i.template === 'field-repair-kit');
      assert.ok(dagger && kit);
      const origId = dagger.id;
      const origCrafted = structuredClone(dagger.crafted);
      dagger.condition = 10;

      assert.equal(env.runtime.act(p1, 'profession.repairWithKit', { kitItemId: kit.id, targetItemId: dagger.id }).ok, true);
      inventory.normalizeRpg(p1.rpg);
      const afterRepair = p1.rpg.inventory.find((i) => i.id === origId);
      assert.ok(afterRepair);
      assert.ok(afterRepair.condition > 10);
      assert.deepEqual(afterRepair.crafted, origCrafted, 'Crafted metadata must survive repair and normalization');
    } finally {
      env.cleanup();
    }
  });

  test('awards Alchemy and Enchanting profession XP from classic Potion Maker and Item Maker events', () => {
    const env = createTestEnv();
    try {
      const p = env.addPlayer(1, { name: 'MageCrafter' });
      const anvil = professions.findStationDefinition('station:gothway:anvil');
      p.x = anvil.x; p.z = anvil.z;
      env.ctx.services.giveItem(p, 'iron-ingot', 1);
      env.ctx.services.giveItem(p, 'rough-timber', 1);
      assert.equal(env.runtime.act(p, 'profession.craft', { stationId: anvil.id, recipeId: 'forge-iron-dagger' }).ok, true);
      const dagger = p.rpg.inventory.find((i) => i.template === 'iron-dagger' && i.crafted);
      assert.ok(dagger);

      // Simulate classic alchemy.js events
      env.ctx.emit('recipeLearned', { player: p, recipe: 'healing', how: 'scroll' });
      env.ctx.emit('potionBrewed', { player: p, recipe: 'healing' });
      assert.equal(p.rpg.professions.tracks.alchemy.xp, 15 + 24);
      assert.equal(p.rpg.professions.tracks.alchemy.actions, 2);

      // Simulate classic Item Maker enchanting on a player-smithed dagger
      env.ctx.emit('itemEnchanted', {
        player: p,
        itemId: dagger.id,
        enchantments: [{ type: 1, param: 0 }, { type: 10, param: 5 }],
        gold: 500,
      });
      assert.equal(p.rpg.professions.tracks.enchanting.xp, 22 + 24);
      assert.equal(dagger.crafted.makerId, p.id, 'Original smith makerId preserved');
      assert.equal(dagger.crafted.profession, 'smithing', 'Original smithing profession preserved');
      assert.equal(dagger.crafted.enchantedById, p.id, 'Enchanting metadata appended');
    } finally {
      env.cleanup();
    }
  });
});

describe('4. Account-Scoped Daily Crafting Writs (UTC Reset, Multi-Slot Isolation & Replay)', () => {
  test('enforces deterministic UTC writs, account-wide single completion across slots, replay safety, and UTC day reset', async () => {
    const env = createTestEnv({ startUtc: Date.UTC(2026, 10, 26, 23, 50, 0) }); // 10 min before UTC midnight
    try {
      // Two character slots belonging to the SAME account (accountId: 42)
      const slot1 = env.addPlayer(101, { accountId: 42, name: 'SlotOne' });
      const slot2 = env.addPlayer(102, { accountId: 42, name: 'SlotTwo' });

      const day1 = professions.utcDayKey(env.utcMs);
      const writsA = professions.getDailyWrits(day1);
      const writsB = professions.getDailyWrits(day1);
      assert.equal(writsA.length, 3);
      assert.deepEqual(writsA.map((w) => w.writId), writsB.map((w) => w.writId));

      const targetWrit = writsA[0]; // Smithing writ
      // Give both slots enough goods to attempt turning in the same writ concurrently
      for (const p of [slot1, slot2]) {
        for (const req of targetWrit.requirements) {
          env.ctx.services.giveItem(p, req.template, req.quantity);
        }
      }

      const gold1Before = slot1.rpg.gold;
      const gold2Before = slot2.rpg.gold;

      // Race both character slots of the same account via Promise.all!
      const race = await Promise.allSettled([
        env.ctx.services.professions.turnInWritDurable(slot1, { writId: targetWrit.writId, opKey: 'writ-s1' }),
        env.ctx.services.professions.turnInWritDurable(slot2, { writId: targetWrit.writId, opKey: 'writ-s2' }),
      ]);

      const won = race.filter((r) => r.status === 'fulfilled');
      const lost = race.filter((r) => r.status === 'rejected');
      assert.equal(won.length, 1, 'Exactly one character slot on the account can claim a daily writ');
      assert.equal(lost.length, 1);
      assert.equal(lost[0].reason.code, 'WRIT_ALREADY_COMPLETED');

      const winner = race[0].status === 'fulfilled' ? slot1 : slot2;
      const loser = race[0].status === 'fulfilled' ? slot2 : slot1;
      const winnerBefore = winner === slot1 ? gold1Before : gold2Before;
      const loserBefore = loser === slot1 ? gold1Before : gold2Before;

      assert.equal(winner.rpg.gold, winnerBefore + targetWrit.reward.gold);
      assert.equal(winner.rpg.professions.tracks[targetWrit.profession].xp, targetWrit.reward.xp);
      // Loser must have received zero gold, zero XP, and kept its items!
      assert.equal(loser.rpg.gold, loserBefore);
      assert.equal(loser.rpg.professions.tracks[targetWrit.profession].xp, 0);
      for (const req of targetWrit.requirements) {
        assert.equal(env.ctx.services.countItem(loser, req.template), req.quantity);
      }

      // Replay winner's opKey -> returns replayed:true without double payout
      const winnerKey = winner === slot1 ? 'writ-s1' : 'writ-s2';
      const replay = await env.ctx.services.professions.turnInWritDurable(winner, { writId: targetWrit.writId, opKey: winnerKey });
      assert.equal(replay.replayed, true);
      assert.equal(winner.rpg.gold, winnerBefore + targetWrit.reward.gold);

      // Restart server -> today's completion persists for the account!
      env.restart();
      const slot2Reloaded = env.addPlayer(102, { accountId: 42, name: 'SlotTwo' });
      const boardAfterRestart = env.ctx.services.professions.writBoardFor(slot2Reloaded);
      const completedEntry = boardAfterRestart.writs.find((w) => w.writId === targetWrit.writId);
      assert.equal(completedEntry.completed, true);
      assert.equal(completedEntry.completedBy.characterId, winner.id);

      // Advance UTC clock past midnight (+15 minutes) -> fresh UTC day resets writs!
      env.advanceUtc(15 * 60 * 1000);
      const day2 = professions.utcDayKey(env.utcMs);
      assert.notEqual(day2, day1);
      const nextBoard = env.ctx.services.professions.writBoardFor(slot2Reloaded);
      assert.equal(nextBoard.utcDay, day2);
      assert.equal(nextBoard.completedCount, 0);
      assert.ok(nextBoard.writs.every((w) => !w.completed));
    } finally {
      env.cleanup();
    }
  });
});

describe('5. Economy Anti-Exploit Pricing Verification', () => {
  test('verifies no crafting recipe allows a vendor-buy -> craft -> NPC-sell infinite gold loop across all price extremes', () => {
    const audit = professions.auditAllRecipes();
    assert.ok(audit.checked >= professions.RECIPES.length * 8, 'Expected full scenario matrix');
    assert.deepEqual(audit.violations, [], `Found economy exploit(s): ${JSON.stringify(audit.violations)}`);
    assert.equal(audit.ok, true);
  });

  test('npcSellPriceForCrafted caps crafted buyback while leaving non-crafted items unchanged', () => {
    const plain = { value: 100, quantity: 1 };
    const crafted = { value: 100, quantity: 1, crafted: { makerId: 1, quality: 'Masterwork' } };
    assert.equal(professions.npcSellPriceForCrafted(plain, 134), 134);
    assert.equal(professions.npcSellPriceForCrafted(crafted, 134), Math.floor(100 * professions.NPC_CRAFTED_BUYBACK_RATE));
    assert.equal(professions.npcSellPriceForCrafted(crafted, 12), 12);
  });
});
