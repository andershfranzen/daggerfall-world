// Comprehensive tests for §2 Homes and Orders:
//   - Personal Homes: lossless legacy duplicate deed migration, instance isolation, address reservation race,
//     furnishing placement/rotation/floor/door clearance/collision/caps/revision replication,
//     guest permissions & visiting hours & non-leaking services.isBlocked,
//     durable storage chests (SQLite + buffered PostgreSQL mock) with inventory.js eligibility & conservation,
//     house trader hooks for market, sale quote/claims, archive blockers & character purge.
//   - Orders: custom rank permission matrix + delegation, purchasable Order Hall with persistent decor,
//     durable Order Item Vault + audit ledger (concurrent last-item race, mid-request permission revocation,
//     full-pack rejection, bound/stolen rejection, failed commit retry), explicit & deterministic succession,
//     disband rules, archive blockers & purge depositor claim reconciliation.
//   - Client UI registration & character-switch cache isolation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore, DurableConflictError } from '../server/db.js';
import { createBufferedGameStore } from '../server/storage/postgres-game.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import {
  install as installInventory,
  makeItem,
  itemFingerprint,
  MAX_ITEMS,
} from '../server/rpg/inventory.js';
import {
  install as installHomes,
  HOME_PREFIX,
  DEFAULT_CHEST_ID,
  NEUTRAL_VISIT_REFUSAL,
} from '../server/rpg/homes.js';
import {
  install as installGuildhall,
  PGUILD_PREFIX,
  PGUILD_RECONCILE_PREFIX,
  ORDER_PERMISSIONS,
} from '../server/rpg/guildhall.js';
import { install as installHomesClient } from '../client/gameplay/homes.js';
import { install as installGuildsClient } from '../client/gameplay/guilds.js';

/**
 * Builds an async PostgreSQL-style store adapter backed by an in-memory SQLite store,
 * wrapped with the real `createBufferedGameStore` so buffered flush/fencing/worldCache
 * and async `tx.*` Promises are exercised identically to production PostgreSQL.
 */
function createMockPostgresBufferedStore(sqliteStore) {
  let injectFailNext = false;
  const asyncInner = {
    backend: 'postgres',
    pool: null,
    async saveCharacters(players, world = []) {
      sqliteStore.saveCharacters(players, world);
    },
    async loadWorld(prefix = '') {
      return sqliteStore.loadWorld(prefix);
    },
    async runDurable(opKey, scope, fn, tracker = null) {
      return sqliteStore.runDurable(opKey, scope, async (syncTx) => {
        const asyncTx = {
          backend: 'postgres',
          now: syncTx.now,
          async getCharacter(id) { return syncTx.getCharacter(id); },
          async getWorld(k) { return syncTx.getWorld(k); },
          async putWorld(k, v) {
            if (tracker) tracker.world.set(k, v);
            return syncTx.putWorld(k, v);
          },
          async deleteWorld(k) {
            if (tracker) tracker.world.set(k, null);
            return syncTx.deleteWorld(k);
          },
          async saveCharacters(players, world = []) {
            if (injectFailNext) {
              injectFailNext = false;
              throw new Error('simulated postgres commit failure');
            }
            if (tracker) {
              for (const pl of players ?? []) tracker.playerIds.add(Number(pl.id));
              for (const [k, v] of world ?? []) tracker.world.set(k, v);
            }
            return syncTx.saveCharacters(players, world);
          },
          async createEscrow(r) { return syncTx.createEscrow(r); },
          async getEscrow(id) { return syncTx.getEscrow(id); },
          async updateEscrowStatus(...a) { return syncTx.updateEscrowStatus(...a); },
          async listEscrow(f) { return syncTx.listEscrow(f); },
          async createClaim(r) { return syncTx.createClaim(r); },
          async getClaim(id) { return syncTx.getClaim(id); },
          async claimRecord(...a) { return syncTx.claimRecord(...a); },
          async listClaims(f) { return syncTx.listClaims(f); },
        };
        const out = await fn(asyncTx);
        if (injectFailNext) {
          injectFailNext = false;
          throw new Error('simulated postgres commit failure');
        }
        return out;
      });
    },
    getDurableOp: (...a) => sqliteStore.getDurableOp(...a),
    pruneDurableOps: (...a) => sqliteStore.pruneDurableOps(...a),
    listEscrow: (f) => sqliteStore.listEscrow(f),
    listClaims: (f) => sqliteStore.listClaims(f),
    async close() { sqliteStore.close(); },
  };
  const buffered = createBufferedGameStore(asyncInner, { retryMs: 25 });
  buffered.failNextCommit = () => { injectFailNext = true; };
  return buffered;
}

function makeWorld({
  backend = 'sqlite',
  sqliteStore = null,
  worldHour = 12,
  blockedPairs = new Set(), // Set<'a|b'>
  collisionWorld = null,
} = {}) {
  const rawSqlite = sqliteStore ?? openStore(':memory:');
  const store = backend === 'postgres-mock' ? createMockPostgresBufferedStore(rawSqlite) : rawSqlite;
  const players = new Map();
  const sent = [];
  let nowMs = 1_700_000_000_000;
  let minutes = 500 * 1440 + worldHour * 60;

  const isBlocked = (a, b) => {
    const aid = typeof a === 'number' ? a : a?.id;
    const bid = typeof b === 'number' ? b : b?.id;
    return blockedPairs.has(`${aid}|${bid}`) || blockedPairs.has(`${bid}|${aid}`);
  };

  const runtime = createRpgRuntime({
    players,
    now: () => nowMs,
    services: {
      store,
      runDurable: (...args) => store.runDurable(...args),
      worldClock: () => ({ minutes }),
      isBlocked,
      canInteract: (actor, target, kind) => {
        if (isBlocked(actor, target)) {
          return { ok: false, reason: `That traveller is not accepting ${kind} right now.` };
        }
        return { ok: true };
      },
      ...(collisionWorld ? { collision: { instanceWorld: () => collisionWorld } } : {}),
    },
    worldStore: {
      load: (prefix) => rawSqlite.loadWorld(prefix),
    },
    save: (affected, worldRows = []) => {
      rawSqlite.saveCharacters(affected, worldRows);
    },
    send: (p, msg) => sent.push({ to: p.id, msg }),
    features: [
      { name: 'inventory', install: installInventory },
      { name: 'homes', install: installHomes },
      { name: 'guildhall', install: installGuildhall },
    ],
  });

  function joinPlayer(name, {
    accountId = null,
    gold = 2000,
    location = 'town:Daggerfall/Gothway Garden',
    inventory = [],
    property = null,
    activeHome = null,
    strength = 80,
  } = {}) {
    const rpgInit = {
      location,
      gold,
      inventoryVersion: 2,
      inventory: structuredClone(inventory),
      equipment: {},
      character: { level: 5, health: 50, maxHealth: 50, stats: { strength } },
      ...(property ? { property: structuredClone(property) } : {}),
      ...(activeHome ? { activeHome: structuredClone(activeHome) } : {}),
    };
    const { row } = rawSqlite.create(name, rpgInit);
    const p = {
      id: row.id,
      accountId: accountId ?? `acct-${row.id}`,
      name,
      x: 1,
      z: 1,
      yaw: 0,
      rpg: row.rpg,
    };
    players.set(p.id, p);
    runtime.join(p);
    rawSqlite.saveCharacters([p]);
    return p;
  }

  function eventsFor(playerId, kind = null) {
    return sent
      .filter((s) => s.to === playerId && s.msg.type === 'gameEvent' && (!kind || s.msg.event.kind === kind))
      .map((s) => s.msg.event);
  }

  return {
    rawSqlite,
    store,
    runtime,
    players,
    sent,
    joinPlayer,
    eventsFor,
    clearSent: () => { sent.length = 0; },
    setHour: (h) => { minutes = 500 * 1440 + h * 60; },
    advanceMs: (ms) => { nowMs += ms; },
    close: async () => {
      if (typeof store.close === 'function') await store.close();
      else rawSqlite.close();
    },
  };
}

// ============================================================================
// 1. PERSONAL HOMES
// ============================================================================

describe('§2 Personal Homes', () => {
  test('lossless migration of duplicate legacy deeds creates isolated instances and marks address claimed', async () => {
    const w = makeWorld();
    try {
      const sharedInterior = 'interior:Daggerfall/Gothway Garden/1,1/5';
      const swordA = makeItem('steel-longsword', 1, 'it-sword-a', {
        magic: { name: 'Blade of Dawn', identified: true, uses: 40, enchantments: [{ type: 0, param: 1 }] },
      });
      const gemB = makeItem('ruby', 5, 'it-ruby-b');

      const legacyPropA = {
        version: 1,
        houses: {
          daggerfall: {
            region: 'Daggerfall',
            town: 'town:Daggerfall/Gothway Garden',
            buildingId: 'bldg-5',
            interior: sharedInterior,
            buildingType: 1,
            radius: 10,
            price: 12000,
            boughtAt: 100,
          },
        },
        stores: {
          'house:daggerfall': [swordA, { template: 'gold', name: 'Gold pieces', quantity: 350 }],
        },
      };
      const legacyPropB = {
        version: 1,
        houses: {
          daggerfall: {
            region: 'Daggerfall',
            town: 'town:Daggerfall/Gothway Garden',
            buildingId: 'bldg-5',
            interior: sharedInterior,
            buildingType: 1,
            radius: 10,
            price: 12000,
            boughtAt: 200,
          },
        },
        stores: {
          'house:daggerfall': [gemB],
        },
      };

      const alice = w.joinPlayer('Alice', { property: legacyPropA });
      const bob = w.joinPlayer('Bob', { property: legacyPropB });

      const homesSvc = w.runtime.ctx.services.homes;
      const aliceHomes = homesSvc.homesOf(alice.id);
      const bobHomes = homesSvc.homesOf(bob.id);
      assert.equal(aliceHomes.length, 1);
      assert.equal(bobHomes.length, 1);
      assert.notEqual(aliceHomes[0].id, bobHomes[0].id, 'duplicate legacy deeds become separate home instances');
      assert.equal(aliceHomes[0].legacy, true);
      assert.equal(bobHomes[0].legacy, true);

      // Legacy items preserved losslessly with exact IDs & enchantments & gold
      const chestA = aliceHomes[0].containers[DEFAULT_CHEST_ID].items;
      const chestB = bobHomes[0].containers[DEFAULT_CHEST_ID].items;
      const migratedSword = chestA.find((i) => i.id === 'it-sword-a');
      assert.ok(migratedSword, 'Alice kept her exact sword ID');
      assert.equal(migratedSword.magic.name, 'Blade of Dawn');
      assert.equal(chestA.find((i) => i.template === 'gold')?.quantity, 350);
      assert.equal(chestB.find((i) => i.id === 'it-ruby-b')?.quantity, 5);

      // Address is marked claimed in the new-house catalogue so new buyers cannot claim it
      assert.equal(homesSvc.isAddressAvailable(sharedInterior), false);
      assert.equal(homesSvc.filterAvailableOffers([{ interior: sharedInterior }, { interior: 'interior:Daggerfall/Gothway Garden/2,2/9' }]).length, 1);

      // Both enter the same building interior -> isolated presenceScope & furnishings!
      assert.equal(w.runtime.act(alice, 'home.enter', { homeId: aliceHomes[0].id }).ok, true);
      assert.equal(w.runtime.act(bob, 'home.enter', { homeId: bobHomes[0].id }).ok, true);
      assert.equal(w.runtime.ctx.sameScene(alice, bob), false, 'duplicate legacy owners are in isolated home scenes');
      assert.equal(w.runtime.ctx.services.presenceScope(alice), `home:${aliceHomes[0].id}`);
      assert.equal(w.runtime.ctx.services.presenceScope(bob), `home:${bobHomes[0].id}`);

      // Alice places a table; Bob does NOT see Alice's furniture
      assert.equal(w.runtime.act(alice, 'home.furnishPlace', { homeId: aliceHomes[0].id, catalogId: 'oak-table', x: 3.5, z: 3.5, floor: 0 }).ok, true);
      assert.equal(aliceHomes[0].furnishings.length, 1);
      assert.equal(bobHomes[0].furnishings.length, 0);

      // Migration is idempotent
      assert.equal(homesSvc.migrateLegacyDeeds(alice).length, 0);
      assert.equal(aliceHomes[0].containers[DEFAULT_CHEST_ID].items.length, 2);
    } finally {
      await w.close();
    }
  });

  test('racing two buyers for the last new house offer commits exactly one winner (SQLite & PG mock)', async () => {
    for (const backend of ['sqlite', 'postgres-mock']) {
      const w = makeWorld({ backend });
      try {
        const alice = w.joinPlayer('Alice', { gold: 5000 });
        const bob = w.joinPlayer('Bob', { gold: 5000 });
        const offer = {
          region: 'Wayrest',
          town: 'town:Wayrest/Wayrest',
          buildingId: 'bldg-99',
          interior: 'interior:Wayrest/Wayrest/2,3/9',
          price: 1500,
        };
        const homesSvc = w.runtime.ctx.services.homes;
        const results = await Promise.allSettled([
          homesSvc.buyHome(alice, offer),
          homesSvc.buyHome(bob, offer),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        assert.equal(fulfilled.length, 1, `${backend}: exactly one buyer wins the race`);
        assert.equal(rejected.length, 1, `${backend}: second buyer fails cleanly`);
        assert.equal(rejected[0].reason.code, 'ADDRESS_CLAIMED');

        const winner = alice.rpg.gold === 3500 ? alice : bob;
        const loser = winner === alice ? bob : alice;
        assert.equal(winner.rpg.gold, 3500);
        assert.equal(loser.rpg.gold, 5000);
        assert.equal(homesSvc.homesOf(winner.id).length, 1);
        assert.equal(homesSvc.homesOf(loser.id).length, 0);

        // Winner cannot buy a second home in the same region (classic per-region limit)
        await assert.rejects(
          () => homesSvc.buyHome(winner, { ...offer, interior: 'interior:Wayrest/Wayrest/4,4/11' }),
          (err) => err.code === 'REGION_LIMIT',
        );
      } finally {
        await w.close();
      }
    }
  });

  test('furnishing placement enforces door clearance, overlap, bounds, floor, collision, caps & replicates by revision', async () => {
    const mockCollision = {
      bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8 },
      heightAt: (x, z, refY) => (x > 6 ? null : Math.round(refY / 3.2) * 3.2),
      isClear: (x, z) => !(x < -5 && z < -5),
    };
    const w = makeWorld({ collisionWorld: mockCollision });
    try {
      const owner = w.joinPlayer('Owner', { gold: 10000 });
      const guest = w.joinPlayer('Guest', { gold: 500 });
      const homesSvc = w.runtime.ctx.services.homes;
      const { home } = await homesSvc.buyHome(owner, {
        region: 'Daggerfall',
        town: 'town:Daggerfall/Gothway Garden',
        interior: 'interior:Daggerfall/Gothway Garden/1,2/3',
        price: 1000,
      });

      // Invite guest & enter
      assert.equal(w.runtime.act(owner, 'home.inviteGuest', { homeId: home.id, targetId: guest.id }).ok, true);
      assert.equal(w.runtime.act(owner, 'home.enter', { homeId: home.id }).ok, true);
      assert.equal(w.runtime.act(guest, 'home.enter', { homeId: home.id }).ok, true);
      w.clearSent();

      // Door clearance rejection (too close to 0,0)
      const doorRes = w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'oak-table', x: 0.5, z: 0.5, floor: 0 });
      assert.equal(doorRes.ok, false);
      assert.match(doorRes.error, /doorway/i);

      // Out-of-bounds rejection
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'oak-table', x: 10, z: 0, floor: 0 }).ok, false);

      // Collision wall rejection
      const colRes = w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'oak-table', x: -6, z: -6, floor: 0 });
      assert.equal(colRes.ok, false);
      assert.match(colRes.error, /geometry|walls/i);

      // No floor rejection (x > 6)
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'brass-lamp', x: 6.5, z: 2, floor: 0 }).ok, false);

      // Valid table placement -> replicates to guest by revision!
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'oak-table', x: 3, z: 3, yaw: Math.PI / 2, floor: 0 }).ok, true);
      const guestFurnEvs = w.eventsFor(guest.id, 'home.furnishings');
      assert.equal(guestFurnEvs.length, 1);
      assert.equal(guestFurnEvs[0].furnishingRev, 2);
      assert.equal(guestFurnEvs[0].furnishings.length, 1);

      // Overlapping another solid furnishing rejected
      const ovRes = w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'dining-chair', x: 3.1, z: 3.1, floor: 0 });
      assert.equal(ovRes.ok, false);
      assert.match(ovRes.error, /overlaps/i);

      // Hearth rug (allowOverlap: true) CAN be placed under the table
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'hearth-rug', x: 3, z: 3, floor: 0 }).ok, true);

      // Guest CANNOT place or remove furniture or open storage
      assert.equal(w.runtime.act(guest, 'home.furnishPlace', { homeId: home.id, catalogId: 'brass-lamp', x: -2, z: 3, floor: 0 }).ok, false);
      assert.equal(w.runtime.ctx.services.ownsInterior(guest, home.interior), false);
      assert.equal(w.runtime.ctx.services.ownsInterior(owner, home.interior), true);

      // House trader per-home cap = 1
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'house-trader', x: -3, z: 3, floor: 0 }).ok, true);
      const capRes = w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'house-trader', x: 3, z: -3, floor: 0 });
      assert.equal(capRes.ok, false);
      assert.match(capRes.error, /at most 1/i);

      // Rotate/move placed table increments furnishingRev
      const liveHome = homesSvc.homeById(home.id);
      const tableId = liveHome.furnishings.find((f) => f.catalogId === 'oak-table').id;
      assert.equal(w.runtime.act(owner, 'home.furnishMove', { homeId: home.id, furnishingId: tableId, x: 3.5, z: 3.5, yaw: Math.PI }).ok, true);
      assert.equal(homesSvc.homeById(home.id).furnishings.find((f) => f.id === tableId).x, 3.5);
    } finally {
      await w.close();
    }
  });

  test('guest permissions, visiting hours, non-leaking blocks, reconnect ejection & archive blockers', async () => {
    const blockedPairs = new Set();
    const w = makeWorld({ worldHour: 14, blockedPairs });
    try {
      const owner = w.joinPlayer('Owner', { gold: 5000 });
      const guest = w.joinPlayer('Guest', { gold: 500 });
      const blocked = w.joinPlayer('BlockedGuy', { gold: 500 });
      blockedPairs.add(`${owner.id}|${blocked.id}`);

      const homesSvc = w.runtime.ctx.services.homes;
      const { home } = await homesSvc.buyHome(owner, {
        region: 'Daggerfall',
        town: 'town:Daggerfall/Gothway Garden',
        interior: 'interior:Daggerfall/Gothway Garden/1,3/7',
        price: 1000,
      });

      // Default mode is private: uninvited guest and blocked user get IDENTICAL neutral refusal
      const rPrivate = w.runtime.act(guest, 'home.enter', { homeId: home.id });
      const rBlockedPrivate = w.runtime.act(blocked, 'home.enter', { homeId: home.id });
      assert.equal(rPrivate.ok, false);
      assert.equal(rBlockedPrivate.ok, false);
      assert.equal(rPrivate.error, NEUTRAL_VISIT_REFUSAL);
      assert.equal(rBlockedPrivate.error, NEUTRAL_VISIT_REFUSAL);

      // Even under open visiting hours, blocked user gets the EXACT SAME non-leaking refusal
      assert.equal(w.runtime.act(owner, 'home.setAccess', { homeId: home.id, mode: 'hours', visitingHours: { open: 8, close: 20 } }).ok, true);
      assert.equal(w.runtime.act(guest, 'home.enter', { homeId: home.id }).ok, true);
      const rBlockedHours = w.runtime.act(blocked, 'home.enter', { homeId: home.id });
      assert.equal(rBlockedHours.ok, false);
      assert.equal(rBlockedHours.error, NEUTRAL_VISIT_REFUSAL);

      // Inviting a blocked player fails neutrally
      const invBlocked = w.runtime.act(owner, 'home.inviteGuest', { homeId: home.id, targetId: blocked.id });
      assert.equal(invBlocked.ok, false);
      assert.equal(invBlocked.error, NEUTRAL_VISIT_REFUSAL);

      // Active visitor inside home triggers ARCHIVE BLOCKER on ctx.services.characterBlockers!
      const blockers = w.runtime.ctx.services.characterBlockers.flatMap((fn) => fn(owner.accountId, owner.id, 'archive'));
      assert.ok(blockers.some((b) => b.code === 'ACTIVE_HOME_VISITORS'));

      // Switching back to private ejects visitor to valid exterior landing
      assert.equal(w.runtime.act(owner, 'home.setAccess', { homeId: home.id, mode: 'private' }).ok, true);
      assert.equal(guest.rpg.location, 'town:Daggerfall/Gothway Garden');
      assert.equal(guest.rpg.activeHome, undefined);

      // After ejection, archive visitor blocker clears
      const blockersAfter = w.runtime.ctx.services.characterBlockers.flatMap((fn) => fn(owner.accountId, owner.id, 'archive'));
      assert.equal(blockersAfter.some((b) => b.code === 'ACTIVE_HOME_VISITORS'), false);

      // Reconnect check: guest saved inside home whose invite was revoked is returned outside on join
      assert.equal(w.runtime.act(owner, 'home.inviteGuest', { homeId: home.id, targetId: guest.id }).ok, true);
      assert.equal(w.runtime.act(guest, 'home.enter', { homeId: home.id }).ok, true);
      // Simulate disconnect, revoke while offline, then reconnect
      w.runtime.leave(guest);
      assert.equal(w.runtime.act(owner, 'home.revokeGuest', { homeId: home.id, targetId: guest.id }).ok, true);
      w.runtime.join(guest);
      assert.equal(guest.rpg.location, 'town:Daggerfall/Gothway Garden', 'revoked guest is relocated outside on reconnect');
    } finally {
      await w.close();
    }
  });

  test('durable home storage chests enforce eligibility, conservation, replay/conflict, and rollback (SQLite & PG mock)', async () => {
    for (const backend of ['sqlite', 'postgres-mock']) {
      const w = makeWorld({ backend });
      try {
        const arrows = makeItem('arrow', 20, 'it-arrows-1');
        const enchanted = makeItem('steel-dagger', 1, 'it-ench-1', {
          magic: { name: 'Frostbite', identified: true, uses: 30, enchantments: [{ type: 0, param: 2 }] },
          crafted: { maker: 'Owner', quality: 'fine' },
        });
        const questItem = makeItem('ruby', 1, 'it-quest-1', { quest: { uid: 'q1', symbol: 'gem' } });
        const conjured = makeItem('iron-longsword', 1, 'it-conj-1', { conjuredUntil: 999999 });
        const equippedSword = makeItem('iron-longsword', 1, 'it-eq-1');

        const owner = w.joinPlayer('Owner', {
          gold: 3000,
          inventory: [arrows, enchanted, questItem, conjured, equippedSword],
        });
        assert.equal(w.runtime.act(owner, 'inventory.equip', { itemId: 'it-eq-1' }).ok, true);

        const homesSvc = w.runtime.ctx.services.homes;
        const { home } = await homesSvc.buyHome(owner, {
          region: 'Daggerfall',
          town: 'town:Daggerfall/Gothway Garden',
          interior: 'interior:Daggerfall/Gothway Garden/2,2/4',
          price: 500,
        });

        // Ineligible items rejected cleanly
        await assert.rejects(() => homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-eq-1' }), (e) => e.code === 'EQUIPPED_ITEM');
        await assert.rejects(() => homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-quest-1' }), (e) => e.code === 'QUEST_ITEM');
        await assert.rejects(() => homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-conj-1' }), (e) => e.code === 'CONJURED_ITEM');

        // Partial stack deposit (8 of 20 arrows) -> remaining keeps original ID, split gets new ID
        const fpBefore = itemFingerprint(enchanted);
        const dep1 = await homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-arrows-1', quantity: 8, opKey: 'dep-arrows-8' });
        assert.equal(dep1.replayed, false);
        assert.equal(owner.rpg.inventory.find((i) => i.id === 'it-arrows-1').quantity, 12);
        const storedArrows = homesSvc.homeById(home.id).containers[DEFAULT_CHEST_ID].items.find((i) => i.template === 'arrow');
        assert.equal(storedArrows.quantity, 8);
        assert.notEqual(storedArrows.id, 'it-arrows-1');

        // Idempotent replay returns replayed:true without duplicating items
        const replay = await homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-arrows-1', quantity: 8, opKey: 'dep-arrows-8' });
        assert.equal(replay.replayed, true);
        assert.equal(owner.rpg.inventory.find((i) => i.id === 'it-arrows-1').quantity, 12);

        // Reusing opKey with different params throws DurableConflictError
        await assert.rejects(
          () => homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-arrows-1', quantity: 4, opKey: 'dep-arrows-8' }),
          (e) => e instanceof DurableConflictError || e.code === 'DURABLE_KEY_CONFLICT',
        );

        // Full enchanted/crafted item deposit preserves exact ID & fingerprint
        await homesSvc.storageDeposit(owner, { homeId: home.id, itemId: 'it-ench-1', opKey: 'dep-ench-1' });
        const storedEnch = homesSvc.homeById(home.id).containers[DEFAULT_CHEST_ID].items.find((i) => i.id === 'it-ench-1');
        assert.ok(storedEnch);
        assert.equal(itemFingerprint(storedEnch), fpBefore);
        assert.deepEqual(storedEnch.crafted, { maker: 'Owner', quality: 'fine' });

        // Failed commit on PG mock rolls back cleanly and preserves exact item identity for retry
        if (backend === 'postgres-mock') {
          w.store.failNextCommit();
          await assert.rejects(
            () => homesSvc.storageWithdraw(owner, { homeId: home.id, itemId: 'it-ench-1', opKey: 'wd-ench-retry' }),
            /simulated postgres commit failure/,
          );
          assert.ok(homesSvc.homeById(home.id).containers[DEFAULT_CHEST_ID].items.some((i) => i.id === 'it-ench-1'));
          assert.equal(owner.rpg.inventory.some((i) => i.id === 'it-ench-1'), false);
        }

        // Withdraw restores exact item identity & fingerprint
        await homesSvc.storageWithdraw(owner, { homeId: home.id, itemId: 'it-ench-1', opKey: 'wd-ench-retry' });
        const restored = owner.rpg.inventory.find((i) => i.id === 'it-ench-1');
        assert.ok(restored);
        assert.equal(itemFingerprint(restored), fpBefore);
      } finally {
        await w.close();
      }
    }
  });

  test('house trader hooks, sale quote/claims, and forced character purge cleanup', async () => {
    const blockedPairs = new Set();
    const w = makeWorld({ blockedPairs });
    try {
      const owner = w.joinPlayer('Merchant', { gold: 5000 });
      const shopper = w.joinPlayer('Shopper', { gold: 500 });
      const blocked = w.joinPlayer('BlockedShopper', { gold: 500 });
      blockedPairs.add(`${owner.id}|${blocked.id}`);

      const homesSvc = w.runtime.ctx.services.homes;
      const { home } = await homesSvc.buyHome(owner, {
        region: 'Sentinel',
        town: 'town:Sentinel/Sentinel',
        interior: 'interior:Sentinel/Sentinel/1,1/2',
        price: 2000,
      });
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'house-trader', x: 3, z: 3, floor: 0 }).ok, true);
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home.id, catalogId: 'oak-table', x: -3, z: 3, floor: 0 }).ok, true);
      assert.equal(w.runtime.act(owner, 'home.setAccess', { homeId: home.id, mode: 'hours', visitingHours: { open: 0, close: 24 } }).ok, true);

      // House trader access verification
      assert.equal(homesSvc.verifyTraderAccess(owner, home.id).canManage, true);
      assert.equal(homesSvc.verifyTraderAccess(shopper, home.id).canBrowse, true);
      assert.equal(homesSvc.verifyTraderAccess(shopper, home.id).canManage, false);
      assert.equal(homesSvc.verifyTraderAccess(blocked, home.id).ok, false);

      // Attaching market listing blocks home sale & triggers archive blocker
      homesSvc.attachTraderListing(home.id, owner.id, 'mkt-listing-1');
      assert.equal(homesSvc.canSellHome(home.id).canSell, false);
      const blockers = w.runtime.ctx.services.characterBlockers.flatMap((fn) => fn(owner.accountId, owner.id, 'archive'));
      assert.ok(blockers.some((b) => b.code === 'ACTIVE_HOUSE_TRADER'));

      // Detaching allows sale and returns removable furniture via durable claim_records
      homesSvc.detachTraderListing(home.id, owner.id, 'mkt-listing-1');
      assert.equal(homesSvc.canSellHome(home.id).canSell, true);
      const sale = await homesSvc.sellHome(owner, { homeId: home.id, includeFurnishingsInQuote: false });
      assert.equal(sale.proceeds, Math.trunc(2000 * 0.85));
      assert.equal(sale.returnedClaims.length, 2, 'removable furnishings returned as durable claims');
      const claims = w.rawSqlite.listClaims({ ownerCharacterId: owner.id, kind: 'home_furnishing_return' });
      assert.equal(claims.length, 2);

      // Buy another home, bring a visitor inside, and verify onCharacterPurge relinquishes & notifies market
      const { home: home2 } = await homesSvc.buyHome(owner, {
        region: 'Sentinel',
        town: 'town:Sentinel/Sentinel',
        interior: 'interior:Sentinel/Sentinel/1,1/2',
        price: 1000,
      });
      assert.equal(w.runtime.act(owner, 'home.furnishPlace', { homeId: home2.id, catalogId: 'house-trader', x: 3, z: 3, floor: 0 }).ok, true);
      assert.equal(w.runtime.act(owner, 'home.inviteGuest', { homeId: home2.id, targetId: shopper.id }).ok, true);
      assert.equal(w.runtime.act(shopper, 'home.enter', { homeId: home2.id }).ok, true);

      let marketNotified = null;
      w.runtime.ctx.services.market = { onHomeRelinquished: (h) => { marketNotified = h.id; } };
      for (const hook of w.runtime.ctx.services.onCharacterPurge) {
        await hook({ characterId: owner.id, accountId: owner.accountId });
      }
      assert.equal(homesSvc.homesOf(owner.id).length, 0);
      assert.equal(shopper.rpg.location, 'town:Sentinel/Sentinel', 'visitor ejected on owner purge');
      assert.equal(marketNotified, home2.id);
      assert.equal(w.rawSqlite.loadWorld(`${HOME_PREFIX}${home2.id}`).length, 0);
    } finally {
      await w.close();
    }
  });
});

// ============================================================================
// 2. ORDERS (PERMISSIONS, ORDER HALL, VAULT & AUDIT, SUCCESSION & PURGE)
// ============================================================================

describe('§2 Orders: Permissions Matrix, Order Hall, Durable Vault & Succession', () => {
  test('custom rank permission matrix, per-member delegation, and siegeOfficer hook', async () => {
    const w = makeWorld();
    try {
      const leader = w.joinPlayer('Leader', { gold: 10000 });
      const officer = w.joinPlayer('Officer', { gold: 1000 });
      const member = w.joinPlayer('Member', { gold: 1000 });
      const recruit = w.joinPlayer('Recruit', { gold: 1000 });

      assert.equal(w.runtime.act(leader, 'order.create', { name: 'Verdigris Guard', tag: 'VERD' }).ok, true);
      const ordId = leader.rpg.playerGuild.id;
      assert.equal(w.runtime.act(leader, 'order.invite', { targetId: officer.id }).ok, true);
      assert.equal(w.runtime.act(officer, 'order.accept', { orderId: ordId }).ok, true);
      assert.equal(w.runtime.act(leader, 'order.promote', { targetId: officer.id }).ok, true);
      assert.equal(w.runtime.act(leader, 'order.invite', { targetId: member.id }).ok, true);
      assert.equal(w.runtime.act(member, 'order.accept', { orderId: ordId }).ok, true);

      const gh = w.runtime.ctx.services.guildhall;
      assert.equal(ORDER_PERMISSIONS.includes('siegeOfficer'), true);
      assert.equal(gh.hasOrderPermission(leader, 'siegeOfficer'), true);
      assert.equal(gh.hasOrderPermission(officer, 'siegeOfficer'), true);
      assert.equal(gh.hasOrderPermission(member, 'siegeOfficer'), false);

      // Revoke invite & withdrawTreasury from Officer rank -> Officer immediately blocked
      assert.equal(w.runtime.act(leader, 'order.setPermissions', { rank: 'Officer', permissions: { invite: false, withdrawTreasury: false } }).ok, true);
      assert.equal(w.runtime.act(officer, 'order.invite', { targetId: recruit.id }).ok, false);
      assert.equal(w.runtime.act(leader, 'order.deposit', { amount: 500 }).ok, true);
      assert.equal(w.runtime.act(officer, 'order.withdraw', { amount: 100 }).ok, false);

      // Delegate invite & siegeOfficer individually to Member -> Member can now invite & act as siege officer
      assert.equal(w.runtime.act(leader, 'order.setPermissions', { targetId: member.id, permissions: { invite: true, siegeOfficer: true } }).ok, true);
      assert.equal(gh.hasOrderPermission(member, 'siegeOfficer'), true);
      assert.equal(w.runtime.act(member, 'order.invite', { targetId: recruit.id }).ok, true);

      // Non-leader cannot edit permissions matrix
      assert.equal(w.runtime.act(officer, 'order.setPermissions', { rank: 'Officer', permissions: { invite: true } }).ok, false);
    } finally {
      await w.close();
    }
  });

  test('purchasable Order Hall funded from treasury, persistent decor, access scope & restart persistence', async () => {
    const sqliteStore = openStore(':memory:');
    const w1 = makeWorld({ sqliteStore });
    let orderId;
    let leaderId;
    try {
      const leader = w1.joinPlayer('Leader', { gold: 20000 });
      const member = w1.joinPlayer('Member', { gold: 1000 });
      leaderId = leader.id;

      assert.equal(w1.runtime.act(leader, 'order.create', { name: 'Iron Bastion', tag: 'IRON' }).ok, true);
      orderId = leader.rpg.playerGuild.id;
      assert.equal(w1.runtime.act(leader, 'order.invite', { targetId: member.id }).ok, true);
      assert.equal(w1.runtime.act(member, 'order.accept', { orderId }).ok, true);
      assert.equal(w1.runtime.act(leader, 'order.deposit', { amount: 8000 }).ok, true);

      // Quote shows price before confirmation
      assert.equal(w1.runtime.act(leader, 'order.hallQuote', { hallId: 'daggerfall-chapterhouse' }).ok, true);
      const quoteEv = w1.eventsFor(leader.id, 'guild').find((e) => e.action === 'order.hallQuote');
      assert.equal(quoteEv.quote.price, 5000);
      assert.equal(quoteEv.quote.canAfford, true);

      // Unconfirmed buy rejected
      assert.equal(w1.runtime.act(leader, 'order.hallBuy', { hallId: 'daggerfall-chapterhouse' }).ok, false);

      // Durable confirmed hall purchase debits treasury
      await w1.runtime.ctx.services.guildhall.buyHall(leader, { hallId: 'daggerfall-chapterhouse', confirm: true, opKey: 'buy-hall-1' });
      const ord = w1.runtime.ctx.services.guildhall.orders.get(orderId);
      assert.equal(ord.treasury, 3000);
      assert.equal(ord.hall.name, 'Daggerfall Chapterhouse');

      // Enter hall & decorate (house-trader rejected in hall; banner accepted)
      assert.equal(w1.runtime.act(leader, 'order.hallEnter', {}).ok, true);
      assert.equal(w1.runtime.act(member, 'order.hallEnter', {}).ok, true);
      assert.equal(w1.runtime.ctx.sameScene(leader, member), true);
      assert.equal(w1.runtime.ctx.services.presenceScope(leader), `orderhall:${orderId}`);

      assert.equal(w1.runtime.act(member, 'order.hallFurnishPlace', { catalogId: 'order-banner', x: 4, z: 4, floor: 0 }).ok, false, 'Member lacks decorateHall');
      assert.equal(w1.runtime.act(leader, 'order.hallFurnishPlace', { catalogId: 'house-trader', x: 4, z: 4, floor: 0 }).ok, false, 'house-trader is home-only');
      assert.equal(w1.runtime.act(leader, 'order.hallFurnishPlace', { catalogId: 'order-banner', x: 4, z: 4, floor: 0, payFrom: 'treasury' }).ok, true);
      assert.equal(w1.runtime.ctx.services.guildhall.orders.get(orderId).hall.furnishings.length, 1);
    } finally {
      // keep sqliteStore open for restart check
    }

    // Boot fresh runtime on same SQLite DB -> hall and decor persist!
    const w2 = makeWorld({ sqliteStore });
    try {
      const ord2 = w2.runtime.ctx.services.guildhall.orders.get(orderId);
      assert.ok(ord2);
      assert.equal(ord2.leaderId, leaderId);
      assert.equal(ord2.hall.name, 'Daggerfall Chapterhouse');
      assert.equal(ord2.hall.furnishings.length, 1);
      assert.equal(ord2.hall.furnishings[0].catalogId, 'order-banner');
    } finally {
      await w2.close();
    }
  });

  test('durable Order Item Vault: eligibility, concurrent last-item race, mid-request revocation, full pack & audit ledger (SQLite & PG mock)', async () => {
    for (const backend of ['sqlite', 'postgres-mock']) {
      const w = makeWorld({ backend });
      try {
        const relic = makeItem('ebony-longsword', 1, 'it-relic-1', {
          magic: { name: 'Oathkeeper', identified: true, uses: 50, enchantments: [{ type: 0, param: 3 }] },
          crafted: { maker: 'Alden', quality: 'masterwork' },
        });
        const boundItem = makeItem('ruby', 1, 'it-bound-1', { bound: { scope: 'character', ownerId: 1 } });
        const stolenItem = makeItem('diamond', 1, 'it-stolen-1', { stolen: { from: 'shop', at: 10 } });

        const leader = w.joinPlayer('Leader', { gold: 2000, inventory: [relic, boundItem, stolenItem] });
        const officerA = w.joinPlayer('OfficerA', { gold: 500 });
        const officerB = w.joinPlayer('OfficerB', { gold: 500 });

        assert.equal(w.runtime.act(leader, 'order.create', { name: 'Vault Keepers', tag: 'VLT' }).ok, true);
        const ordId = leader.rpg.playerGuild.id;
        for (const q of [officerA, officerB]) {
          assert.equal(w.runtime.act(leader, 'order.invite', { targetId: q.id }).ok, true);
          assert.equal(w.runtime.act(q, 'order.accept', { orderId: ordId }).ok, true);
          assert.equal(w.runtime.act(leader, 'order.promote', { targetId: q.id }).ok, true);
        }

        const gh = w.runtime.ctx.services.guildhall;

        // Shared storage rejects bound & stolen items via inventory.js
        await assert.rejects(() => gh.vaultDeposit(leader, { itemId: 'it-bound-1' }), (e) => e.code === 'BOUND_ITEM');
        await assert.rejects(() => gh.vaultDeposit(leader, { itemId: 'it-stolen-1' }), (e) => e.code === 'STOLEN_ITEM');

        // Deposit relic & verify audit ledger
        const fp = itemFingerprint(relic);
        await gh.vaultDeposit(leader, { itemId: 'it-relic-1', opKey: 'vdep-relic' });
        const ord = gh.orders.get(ordId);
        assert.equal(ord.vault.length, 1);
        assert.equal(ord.vault[0].depositedBy, leader.id);
        assert.equal(ord.vaultLedger.at(-1).action, 'vault_deposit');
        assert.equal(ord.vaultLedger.at(-1).fingerprint, fp);

        // Full-pack rejection preserves exact item identity in vault
        for (let i = 0; i < MAX_ITEMS; i++) {
          officerA.rpg.inventory.push(makeItem('iron-dagger', 1, `it-fill-${i}`));
        }
        await assert.rejects(
          () => gh.vaultWithdraw(officerA, { itemId: 'it-relic-1', opKey: 'vwd-fullpack' }),
          (e) => e.code === 'PACK_FULL' || e.code === 'OVER_ENCUMBERED',
        );
        assert.equal(gh.orders.get(ordId).vault.length, 1, 'vault item untouched after full-pack rejection');
        officerA.rpg.inventory = [];

        // Mid-request permission revocation check: revoke withdrawVault in persisted order before tx executes
        const ordBeforeRevoke = gh.orders.get(ordId);
        ordBeforeRevoke.permissions.Officer.withdrawVault = false;
        w.rawSqlite.saveCharacters([], [[`${PGUILD_PREFIX}${ordId}`, structuredClone(ordBeforeRevoke)]]);
        await assert.rejects(
          () => gh.vaultWithdraw(officerA, { itemId: 'it-relic-1', opKey: 'vwd-revoked' }),
          (e) => e.code === 'PERMISSION_DENIED',
        );
        // Restore Officer withdrawVault permission
        ordBeforeRevoke.permissions.Officer.withdrawVault = true;
        w.rawSqlite.saveCharacters([], [[`${PGUILD_PREFIX}${ordId}`, structuredClone(ordBeforeRevoke)]]);

        // Race OfficerA and OfficerB concurrently for the LAST vault item!
        const race = await Promise.allSettled([
          gh.vaultWithdraw(officerA, { itemId: 'it-relic-1', opKey: 'vwd-race-a' }),
          gh.vaultWithdraw(officerB, { itemId: 'it-relic-1', opKey: 'vwd-race-b' }),
        ]);
        const wins = race.filter((r) => r.status === 'fulfilled');
        const losses = race.filter((r) => r.status === 'rejected');
        assert.equal(wins.length, 1, `${backend}: exactly one concurrent withdrawal succeeds`);
        assert.equal(losses.length, 1, `${backend}: second concurrent withdrawal fails cleanly`);
        assert.equal(losses[0].reason.code, 'ITEM_NOT_FOUND');

        const holder = officerA.rpg.inventory.some((i) => i.id === 'it-relic-1') ? officerA : officerB;
        const other = holder === officerA ? officerB : officerA;
        assert.equal(itemFingerprint(holder.rpg.inventory.find((i) => i.id === 'it-relic-1')), fp);
        assert.equal(other.rpg.inventory.some((i) => i.id === 'it-relic-1'), false);
        assert.equal(gh.orders.get(ordId).vault.length, 0);
        assert.equal(gh.orders.get(ordId).vaultLedger.at(-1).action, 'vault_withdraw');
      } finally {
        await w.close();
      }
    }
  });

  test('succession, disband with vault guard, archive blocker, and forced purge reconciliation claims', async () => {
    const w = makeWorld();
    try {
      const sword = makeItem('steel-longsword', 1, 'it-dep-sword');
      const leader = w.joinPlayer('Leader', { gold: 10000 });
      const officerEarly = w.joinPlayer('OfficerEarly', { gold: 500, inventory: [sword] });
      const officerLate = w.joinPlayer('OfficerLate', { gold: 500 });
      const member = w.joinPlayer('Member', { gold: 500 });

      assert.equal(w.runtime.act(leader, 'order.create', { name: 'Order of Stone', tag: 'STN' }).ok, true);
      const ordId = leader.rpg.playerGuild.id;
      for (const q of [officerEarly, officerLate, member]) {
        assert.equal(w.runtime.act(leader, 'order.invite', { targetId: q.id }).ok, true);
        assert.equal(w.runtime.act(q, 'order.accept', { orderId: ordId }).ok, true);
      }
      assert.equal(w.runtime.act(leader, 'order.promote', { targetId: officerEarly.id }).ok, true);
      assert.equal(w.runtime.act(leader, 'order.promote', { targetId: officerLate.id }).ok, true);

      const gh = w.runtime.ctx.services.guildhall;
      const ord = gh.orders.get(ordId);
      // Force deterministic join timestamps
      ord.members[String(officerEarly.id)].joinedAt = '2026-01-01T00:00:00.000Z';
      ord.members[String(officerLate.id)].joinedAt = '2026-02-01T00:00:00.000Z';
      ord.members[String(member.id)].joinedAt = '2025-12-01T00:00:00.000Z';

      // Fund hall & deposit item by OfficerEarly into vault
      assert.equal(w.runtime.act(leader, 'order.deposit', { amount: 6000 }).ok, true);
      await gh.buyHall(leader, { hallId: 'daggerfall-chapterhouse', confirm: true, opKey: 'hall-stn' });
      await gh.vaultDeposit(officerEarly, { itemId: 'it-dep-sword', opKey: 'vdep-stn' });

      // Archive blocker refuses archiving leader while order has members/hall/vault/treasury
      const blockers = w.runtime.ctx.services.characterBlockers.flatMap((fn) => fn(leader.accountId, leader.id, 'archive'));
      assert.ok(blockers.some((b) => b.code === 'SOLE_ORDER_LEADER'));

      // Ordinary disband refused while vault still has items
      const disbandBlocked = w.runtime.act(leader, 'order.disband', {});
      assert.equal(disbandBlocked.ok, false);
      assert.match(disbandBlocked.error, /vault/i);

      // Forced purge of Leader elects longest-serving eligible Officer (officerEarly) and preserves hall & vault!
      const res1 = await gh.handleCharacterPurge({ characterId: leader.id });
      assert.equal(res1.action, 'succeeded');
      assert.equal(res1.successorId, officerEarly.id);
      assert.equal(gh.orders.get(ordId).leaderId, officerEarly.id);
      assert.ok(gh.orders.get(ordId).hall);
      assert.equal(gh.orders.get(ordId).vault.length, 1);

      // Ordinary leave with explicit successor picks member directly
      assert.equal(w.runtime.act(officerEarly, 'order.leave', { successorId: member.id }).ok, true);
      assert.equal(gh.orders.get(ordId).leaderId, member.id);

      // Remove officerLate, leaving member as sole member with OfficerEarly's deposited sword still in vault
      assert.equal(w.runtime.act(member, 'order.kick', { targetId: officerLate.id }).ok, true);

      // Forced purge of final member returns eligible vault item to original depositor (officerEarly) via claim_records
      // and writes operator reconciliation record BEFORE deleting hall and order!
      const resFinal = await gh.handleCharacterPurge({ characterId: member.id });
      assert.equal(resFinal.action, 'dissolved');
      assert.equal(gh.orders.has(ordId), false);
      const claims = w.rawSqlite.listClaims({ ownerCharacterId: officerEarly.id, kind: 'order_vault_return' });
      assert.equal(claims.length, 1);
      assert.equal(claims[0].item.id, 'it-dep-sword');

      const reconcileRows = w.rawSqlite.loadWorld(`${PGUILD_RECONCILE_PREFIX}${ordId}`);
      assert.equal(reconcileRows.length, 1);
      assert.equal(reconcileRows[0][1].vaultDestinations[0].destination, 'depositor_claim');
      assert.equal(reconcileRows[0][1].vaultDestinations[0].depositorId, officerEarly.id);
      assert.equal(w.rawSqlite.loadWorld(`${PGUILD_PREFIX}${ordId}`).length, 0);
    } finally {
      await w.close();
    }
  });
});

// ============================================================================
// 3. CLIENT UI REGISTRATION & CHARACTER-SWITCH ISOLATION
// ============================================================================

describe('§2 Client Homes & Orders UI hooks', () => {
  test('homes and guilds client modules register panels and clear caches on character switch', () => {
    const makeMockApi = () => {
      const listeners = new Map();
      const panels = new Map();
      const actions = [];
      const messages = [];
      return {
        listeners,
        panels,
        actions,
        messages,
        api: {
          state: { selfId: 1, character: { gold: 500, inventory: [] } },
          selfId: 1,
          panel: null,
          on: (ev, fn) => {
            if (!listeners.has(ev)) listeners.set(ev, []);
            listeners.get(ev).push(fn);
          },
          act: (verb, args) => actions.push({ verb, args }),
          message: (text) => messages.push(text),
          registerPanel: (id, title, render) => panels.set(id, { id, title, render }),
          refreshPanel: () => {},
        },
        emit(ev, payload) {
          for (const fn of listeners.get(ev) ?? []) fn(payload);
        },
      };
    };

    const h = makeMockApi();
    const homesClient = installHomesClient(h.api);
    assert.ok(h.panels.has('homes'));
    h.emit('event', { kind: 'home', action: 'overview', overview: { gold: 500, owned: [{ id: 'hm_1', furnishings: [], containers: [] }], invitations: [], activeHome: null, catalog: [] } });
    assert.equal(homesClient.ui.overview.owned.length, 1);
    // Character switch clears private cache
    h.api.selfId = 2;
    h.api.state.selfId = 2;
    h.emit('state', {});
    assert.equal(homesClient.ui.overview, null);

    const g = makeMockApi();
    const guildsClient = installGuildsClient(g.api);
    assert.ok(g.panels.has('guilds'));
    g.emit('event', { kind: 'guild', action: 'overview', overview: { day: 1, gold: 500, foundingFee: 0, memberships: [], order: { id: 'pg_1', name: 'Test', tag: 'TST', members: [], vault: [], ledger: [], vaultLedger: [] }, orderInvites: [], onlinePlayers: [] } });
    assert.equal(guildsClient.ui.overview.order.id, 'pg_1');
    g.api.selfId = 2;
    g.api.state.selfId = 2;
    g.emit('state', {});
    assert.equal(guildsClient.ui.overview, null);
  });
});
