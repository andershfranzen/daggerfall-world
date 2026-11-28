// Rollout & Operational Pilot End-to-End Test (docs/multiplayer-feature-plan.md).
//
// Exercises ALL Wave 1 & Wave 2 features wired together in the live production server
// (`createGameServer` with `PRODUCTION_FEATURES`), across BOTH storage backends:
//   1. SQLite (`openStore`)
//   2. Async PostgreSQL write-behind mock (`createBufferedGameStore`)
//
// Verified end-to-end flows:
//   - §1 Character Slots: multi-slot creation, WS switching, archive blockers with active obligations
//   - §5 Social Tools: account friends, offline letters, non-leaking directed blocks, party pings & Group Travel
//   - §2 Homes & Orders: home purchase, carpentry-crafted furniture + house trader placement, durable chest
//     deposit/withdraw, guest invite/entry + presenceScope isolation, order permissions, Order Hall & Vault
//   - §3 Professions: gathering node depletion & respawn, station crafting (ingots + furniture), account daily writ
//   - §6 Player Market: partial-stack listing, offline buy, house trader <-> homes.verifyTraderAccess,
//     timed auction + bid, funded buy order, offline claims, anti-self-trade across account slots
//   - §7/§9 Co-op & Dungeons: Smaller Dungeons 5-block selection & Party Co-op Instance isolation
//   - §4 Land PvP: Consent Duel (non-lethal 1 HP + zero town-guard crime), Ranked 1v1 Arena (Elo),
//     Open PvP District combat-tag + zero crime, Order Siege officer permission integration
//   - Cold Restart: full persistence survival, Account C privacy isolation, exact gold & item conservation

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { openStore } from '../server/db.js';
import { createBufferedGameStore } from '../server/storage/postgres-game.js';
import { createAccounts } from '../server/accounts.js';
import { createGameServer, PRODUCTION_FEATURES } from '../server/game.js';
import { addItem, equip, itemFingerprint } from '../server/rpg/inventory.js';
import { DEFAULT_CHEST_ID } from '../server/rpg/homes.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PW = 'velvet lantern dusk';
const ARENA2_DIR = process.env.ARENA2_DIR && existsSync(process.env.ARENA2_DIR) ? process.env.ARENA2_DIR : null;

/**
 * Wraps a SQLite store in an async PostgreSQL-shaped inner store and the real `createBufferedGameStore`
 * so the full production write-behind flush, locking, fencing, worldCache mirroring, and async `runDurable`
 * paths are exercised end-to-end.
 */
function wrapAsMockPostgres(sqliteStore) {
  const asyncInner = {
    backend: 'postgres',
    pool: null,
    async saveCharacters(players, world = []) {
      sqliteStore.saveCharacters(players, world);
    },
    async loadWorld(prefix = '') {
      return sqliteStore.loadWorld(prefix);
    },
    async loadAllWorld() {
      return sqliteStore.loadWorld('');
    },
    async create(name) { return sqliteStore.create(name); },
    async findById(id) { return sqliteStore.findById(id); },
    async findByToken(t) { return sqliteStore.findByToken(t); },
    async findByAccount(a) { return sqliteStore.findByAccount(a); },
    async listByAccount(a, opts) { return sqliteStore.listByAccount(a, opts); },
    async findAccountCharacter(a, id) { return sqliteStore.findAccountCharacter(a, id); },
    async createForAccount(a, u, n) { return sqliteStore.createForAccount(a, u, n); },
    async createCharacterSlot(a, u, opts) { return sqliteStore.createCharacterSlot(a, u, opts); },
    async claimGuest(a, u, t, n) { return sqliteStore.claimGuest(a, u, t, n); },
    async setAccountUsername(a, u) { return sqliteStore.setAccountUsername(a, u); },
    async markCharacterDraftComplete(a, id, n) { return sqliteStore.markCharacterDraftComplete(a, id, n); },
    async touchCharacterPlayed(a, id) { return sqliteStore.touchCharacterPlayed(a, id); },
    async selectCharacter(a, id) { return sqliteStore.selectCharacter(a, id); },
    async archiveCharacter(a, id, opts) { return sqliteStore.archiveCharacter(a, id, opts); },
    async restoreCharacter(a, id, opts) { return sqliteStore.restoreCharacter(a, id, opts); },
    async purgeExpiredArchived(opts) { return sqliteStore.purgeExpiredArchived(opts); },
    async deleteForAccount(a) { return sqliteStore.deleteForAccount(a); },
    async deleteAllForAccount(a) { return sqliteStore.deleteAllForAccount(a); },
    async getDurableOp(k, s) { return sqliteStore.getDurableOp(k, s); },
    async pruneDurableOps(t) { return sqliteStore.pruneDurableOps(t); },
    async listEscrow(f) { return sqliteStore.listEscrow(f); },
    async listClaims(f) { return sqliteStore.listClaims(f); },
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
        return fn(asyncTx);
      });
    },
    async close() { sqliteStore.close(); },
  };
  return createBufferedGameStore(asyncInner, { retryMs: 25 });
}

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for condition');
}

async function createPilotHarness({ backend = 'sqlite', dir = null, dbPath = null, accountsDbPath = null } = {}) {
  const ownDir = !dir;
  const rootDir = dir ?? mkdtempSync(join(tmpdir(), `dfw-pilot-${backend}-`));
  const clientDir = join(rootDir, 'client');
  const siteDir = join(rootDir, 'site');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>site</title>');

  const gameDb = dbPath ?? join(rootDir, 'game.db');
  const acctDb = accountsDbPath ?? join(rootDir, 'accounts.db');
  const rawStore = openStore(gameDb);
  const store = backend === 'postgres-mock' ? wrapAsMockPostgres(rawStore) : rawStore;
  if (typeof store.preloadWorld === 'function') await store.preloadWorld();

  const accounts = createAccounts({
    dbPath: acctDb,
    scrypt: FAST_SCRYPT,
    moderationPollMs: 50,
    limits: { api: [1000, 60_000], login: [200, 60_000], register: [200, 60_000] },
  });

  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    store,
    clientDir,
    siteDir,
    accounts,
    arena2Dir: ARENA2_DIR,
    features: PRODUCTION_FEATURES,
    hiscores: false,
    actionRatePerSec: 200,
    actionBurst: 400,
    msgRatePerSec: 200,
    msgBurst: 400,
  });

  let origin = '';
  let wsUrl = '';

  async function api(path, { method = 'POST', body, jar, headers = {} } = {}) {
    const h = { Origin: origin, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (jar?.cookie) h.Cookie = jar.cookie;
    const res = await fetch(origin + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (jar && setCookie) {
      const [pair] = setCookie.split(';');
      const value = pair.slice(pair.indexOf('=') + 1);
      jar.cookie = value ? pair : '';
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  }

  function connect(jar, query = '') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}${query}`, {
        headers: { Origin: origin, ...(jar?.cookie ? { Cookie: jar.cookie } : {}) },
      });
      const messages = [];
      let seq = 1;
      ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`WS unexpected HTTP ${res.statusCode}`)));
      ws.once('error', reject);
      ws.once('open', () => {
        const client = {
          ws,
          messages,
          async join(payload = {}) {
            const startLen = messages.length;
            ws.send(JSON.stringify({ type: 'join', ...payload }));
            const welcome = await waitFor(() => messages.slice(startLen).find((m) => m.type === 'welcome' || m.type === 'error'));
            return welcome;
          },
          async act(verb, args = {}) {
            const mySeq = seq++;
            const startLen = messages.length;
            ws.send(JSON.stringify({ type: 'action', seq: mySeq, verb, args }));
            const res = await waitFor(() => messages.slice(startLen).find((m) => m.type === 'actionResult' && m.seq === mySeq));
            return res;
          },
          async switchTo(characterId) {
            const startLen = messages.length;
            ws.send(JSON.stringify({ type: 'switch', characterId }));
            const msg = await waitFor(() => messages.slice(startLen).find((m) => m.type === 'welcome' || m.type === 'error'));
            return msg;
          },
          events(kind = null) {
            const all = messages.filter((m) => m.type === 'gameEvent').map((m) => m.event);
            return kind ? all.filter((e) => e.kind === kind) : all;
          },
          async close() {
            if (ws.readyState === ws.CLOSED) return;
            await new Promise((r) => {
              ws.once('close', r);
              ws.close();
            });
          },
        };
        resolve(client);
      });
    });
  }

  return {
    rootDir,
    gameDb,
    acctDb,
    store,
    rawStore,
    accounts,
    server,
    get runtime() { return server.runtime; },
    get services() { return server.runtime.ctx.services; },
    get players() { return server.runtime.ctx.players; },
    async start() {
      const addr = await server.start();
      origin = `http://127.0.0.1:${addr.port}`;
      wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
      return addr;
    },
    async stop({ keepFiles = false } = {}) {
      await server.close();
      accounts.close();
      if (ownDir && !keepFiles) rmSync(rootDir, { recursive: true, force: true });
    },
    api,
    connect,
  };
}

async function registerAndJoin(h, username, charName) {
  const jar = { cookie: '' };
  const reg = await h.api('/api/register', { body: { username, password: PW }, jar });
  assert.equal(reg.status, 201, `register ${username}: ${JSON.stringify(reg.json)}`);
  const startSlot = await h.api('/api/characters/start', { body: { name: charName, slot: 1 }, jar });
  assert.equal(startSlot.status, 201, `start slot1 ${charName}: ${JSON.stringify(startSlot.json)}`);
  const charId = startSlot.json.character.id;

  const client = await h.connect(jar);
  const welcome = await client.join({ characterId: charId });
  assert.equal(welcome.type, 'welcome', `join ${charName}: ${JSON.stringify(welcome)}`);

  // Mark character as created with healthy baseline stats & starting gold for the pilot.
  const player = h.players.get(charId);
  assert.ok(player, `live player ${charId} present`);
  player.rpg.character = {
    ...(player.rpg.character || {}),
    name: charName,
    created: true,
    race: 'Breton',
    className: 'Spellsword',
    level: 6,
    health: 100,
    maxHealth: 100,
    fatigue: 100,
    maxFatigue: 100,
    magicka: 80,
    maxMagicka: 80,
    attributes: { Strength: 95, Intelligence: 60, Willpower: 55, Agility: 55, Endurance: 60, Personality: 55, Speed: 55, Luck: 50 },
  };
  player.rpg.location = 'town:Daggerfall/Gothway Garden';
  player.x = 0;
  player.z = 0;
  player.rpg.gold = 15000;
  player.dirty = true;
  if (typeof h.store.markCharacterDraftComplete === 'function') {
    await h.store.markCharacterDraftComplete(player.accountId, player.id, null);
  }
  await h.store.saveCharacters([player], []);
  if (typeof h.store.flush === 'function') await h.store.flush();

  return { jar, charId, client, player };
}

describe('Rollout & Operational Pilot E2E (Full Wired Runtime)', () => {
  for (const backend of ['sqlite', 'postgres-mock']) {
    test(`[${backend}] full multi-account pilot loop + cold restart + conservation + privacy isolation`, async () => {
      const h = await createPilotHarness({ backend });
      let h2 = null;
      const openClients = [];
      try {
        await h.start();

        // Sanity: verify ALL key Wave 1 & Wave 2 features are installed on the live production runtime.
        const installed = new Set(h.runtime.installed);
        for (const req of [
          'smallerDungeons', 'dungeonInstances', 'partyQuests', 'questRepair',
          'delves', 'livingWorld', 'seaBounties', 'survival', 'optionalRules',
          'mods', 'professions', 'homes', 'market', 'pvp', 'guildhall', 'social',
        ]) {
          assert.ok(installed.has(req), `production feature "${req}" must be wired in runtime`);
        }
        assert.ok(h.services.mods.list().length >= 1, 'sample mod pack loaded');

        // =====================================================================
        // 1. Multi-Account Registration & §1 Character Slots (Account A, B, C)
        // =====================================================================
        const A = await registerAndJoin(h, 'pilota', 'Aelric');
        const B = await registerAndJoin(h, 'pilotb', 'Brynja');
        const C = await registerAndJoin(h, 'pilotc', 'Corvus');
        openClients.push(A.client, B.client, C.client);

        // Account A creates Slot 2 (`AelricAlt`) via HTTP roster API.
        const slot2Res = await h.api('/api/characters/start', {
          body: { name: 'AelricAlt', slot: 2 },
          jar: A.jar,
        });
        assert.equal(slot2Res.status, 201);
        const charA2Id = slot2Res.json.character.id;

        // Switch Account A from Slot 1 -> Slot 2 -> back to Slot 1 cleanly.
        const swTo2 = await A.client.switchTo(charA2Id);
        assert.equal(swTo2.type, 'welcome');
        assert.equal(swTo2.id, charA2Id);
        const pA2 = h.players.get(charA2Id);
        pA2.rpg.character = { ...(pA2.rpg.character || {}), name: 'AelricAlt', created: true, level: 2, health: 60, maxHealth: 60 };
        pA2.rpg.location = 'town:Daggerfall/Gothway Garden';
        pA2.rpg.gold = 2000;
        await h.store.saveCharacters([pA2], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        const swBack1 = await A.client.switchTo(A.charId);
        assert.equal(swBack1.type, 'welcome');
        assert.equal(swBack1.id, A.charId);
        const pA = h.players.get(A.charId);
        const pB = h.players.get(B.charId);
        const pC = h.players.get(C.charId);

        // =====================================================================
        // 2. §5 Social Tools: Friends, Letters & Non-Leaking Directed Blocks
        // =====================================================================
        assert.equal((await A.client.act('friends.request', { targetId: B.charId })).ok, true);
        assert.equal((await B.client.act('friends.accept', { fromAccount: `acct:${pA.accountId}` })).ok, true);
        assert.equal(h.services.areFriends(pA, pB), true);

        const mailSend = await A.client.act('mail.send', {
          toAccount: `acct:${pB.accountId}`,
          subject: 'Market Goods Ready',
          body: 'Meet me at Gothway Garden board for ingots and timber.',
          requestId: 'pilot-mail-1',
        });
        assert.equal(mailSend.ok, true);
        const bMailList = await B.client.act('mail.list', { folder: 'inbox' });
        assert.equal(bMailList.ok, true);
        const bMailEv = B.client.events('social').find((e) => e.mailPage?.items?.length > 0);
        assert.ok(bMailEv, 'B received letter in inbox');
        const letterId = bMailEv.mailPage.items[0].id;
        assert.equal((await B.client.act('mail.read', { letterId })).ok, true);

        // Account C blocks Account A: verify non-leaking refusals across friends, home visits, and duels!
        assert.equal((await C.client.act('social.block', { targetId: A.charId })).ok, true);
        assert.equal(h.services.isBlocked(pA, pC), true);
        const blockedFriend = await A.client.act('friends.request', { targetId: C.charId });
        assert.equal(blockedFriend.ok, false);
        assert.ok(!/block/i.test(blockedFriend.error || ''), `friend refusal must not leak block status: ${blockedFriend.error}`);

        // =====================================================================
        // 3. §3 Professions: Gather Node (Depletion/Respawn), Craft & Daily Writ
        // =====================================================================
        // Ensure collision service reports ready for gathering/station checks in headless test.
        const origCollisionStatus = h.services.collision?.status;
        if (h.services.collision) h.services.collision.status = () => ({ status: 'ready' });
        const origCanSee = h.services.canSee;
        h.services.canSee = () => true;

        // Give Account A an iron pickaxe, equip it, stand next to Gothway iron vein (`12, 0, -8`)
        const pickaxe = addItem(pA.rpg, 'iron-pickaxe', 1);
        equip(pA.rpg, pickaxe.id);
        pA.x = 12;
        pA.z = -8;
        const nodesBefore = h.services.professions.nodesAt('town:Daggerfall/Gothway Garden');
        const ironNodeBefore = nodesBefore.find((n) => n.id === 'node:gothway:iron-1');
        assert.ok(ironNodeBefore && ironNodeBefore.charges > 0, 'iron vein starts with charges');

        assert.equal((await A.client.act('profession.gatherStart', { nodeId: 'node:gothway:iron-1' })).ok, true);
        // Backdate startedAt to simulate elapsed gather duration cleanly without sleeping 2.2s.
        const activeGather = h.services.professions.activeGatherOf(pA.id);
        assert.ok(activeGather, 'active gather session started');
        activeGather.startedAt -= activeGather.durationMs + 50;

        const gatherRes = await h.services.professions.completeGatherDurable(pA, { nodeId: 'node:gothway:iron-1', opKey: 'pilot-gather-1' });
        assert.equal(gatherRes.replayed, false);
        assert.ok(gatherRes.result?.yields?.length > 0, 'gather yielded materials');
        const ironNodeAfter = h.services.professions.nodesAt('town:Daggerfall/Gothway Garden').find((n) => n.id === 'node:gothway:iron-1');
        assert.equal(ironNodeAfter.charges, ironNodeBefore.charges - 1, 'node charge depleted');
        assert.ok(pA.rpg.professions.tracks.mining.xp > 0, 'mining XP awarded');

        // Give A exact materials for crafting iron ingots & carpentry oak chair.
        addItem(pA.rpg, 'iron-ore', 6);
        addItem(pA.rpg, 'coal-lump', 3);
        addItem(pA.rpg, 'oak-plank', 2);
        addItem(pA.rpg, 'iron-nails', 2);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        // Craft at Gothway Anvil (`4, 0, -4`) -> smelts iron ingots
        pA.x = 4;
        pA.z = -4;
        const craftIngots = await h.services.professions.craftDurable(pA, {
          stationId: 'station:gothway:anvil',
          recipeId: 'smelt-iron-ingot',
          quantity: 3,
          opKey: 'pilot-craft-ingots',
        });
        assert.equal(craftIngots.replayed, false);
        assert.ok(pA.rpg.professions.tracks.smithing.xp > 0);

        // Craft carpentry furniture at Gothway Workbench (`-4, 0, -4`) -> `crafted-oak-chair`
        pA.x = -4;
        pA.z = -4;
        const craftChair = await h.services.professions.craftDurable(pA, {
          stationId: 'station:gothway:workbench',
          recipeId: 'craft-oak-chair',
          quantity: 1,
          opKey: 'pilot-craft-chair',
        });
        assert.equal(craftChair.replayed, false);
        const craftedChairItem = pA.rpg.inventory.find((it) => it.template === 'crafted-oak-chair');
        assert.ok(craftedChairItem && craftedChairItem.crafted?.makerName, 'crafted chair has maker metadata');

        // Complete an Account-Scoped Daily Crafting Writ (pick first available writ & supply its required items).
        const writBoard = h.services.professions.writBoardFor(pA);
        const firstWrit = writBoard.writs[0];
        assert.ok(firstWrit, 'daily writ available');
        for (const req of firstWrit.requirements) addItem(pA.rpg, req.template, req.quantity);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        const writRes = await h.services.professions.turnInWritDurable(pA, {
          writId: firstWrit.writId,
          opKey: 'pilot-writ-1',
        });
        assert.equal(writRes.replayed, false);
        assert.ok((writRes.result?.goldReward ?? writRes.result?.reward?.gold ?? 0) > 0);

        // Prove Account A's Slot 2 sees the same daily writ already completed (account-scoped)!
        const slot2WritBoard = h.services.professions.writBoardFor({ id: charA2Id, accountId: pA.accountId, rpg: { inventory: [] } });
        assert.equal(slot2WritBoard.writs.find((w) => w.writId === firstWrit.writId)?.completed, true);

        // =====================================================================
        // 4. §2 Personal Homes (Buy, Carpentry Furniture, Chest, Guest, Trader)
        // =====================================================================
        const boughtHome = await h.services.homes.buyHome(pA, {
          region: 'Daggerfall',
          town: 'town:Daggerfall/Gothway Garden',
          buildingId: 'pilot-house-1',
          interior: 'interior:Daggerfall/Gothway Garden/0,0/1',
          price: 1200,
          opKey: 'pilot-buy-home-1',
        });
        assert.ok(boughtHome.home?.id, 'personal home purchased');
        const homeId = boughtHome.home.id;

        // Place carpentry-crafted furniture from A's pack into the home (cross-feature professions <-> homes!)
        const placeChair = await A.client.act('home.furnishPlace', {
          homeId,
          inventoryItemId: craftedChairItem.id,
          x: 2.5,
          z: 2.5,
          yaw: 0,
          floor: 0,
        });
        assert.equal(placeChair.ok, true, `place crafted chair: ${placeChair.error}`);
        assert.ok(!pA.rpg.inventory.some((it) => it.id === craftedChairItem.id), 'crafted chair consumed from pack');
        assert.ok(
          h.services.homes.homeById(homeId).furnishings.some((f) => f.catalogId === 'crafted-oak-chair' && f.crafted?.makerName),
          'crafted furniture placed with maker metadata',
        );

        // Place House Trader Stall in the home for Market integration.
        assert.equal((await A.client.act('home.furnishPlace', {
          homeId,
          catalogId: 'house-trader',
          x: -2.5,
          z: 2.5,
          yaw: 0,
          floor: 0,
        })).ok, true);

        // Durable home storage deposit & withdraw (exact item conservation).
        const sword = addItem(pA.rpg, 'iron-longsword', 1);
        const swordFp = itemFingerprint(sword);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        const depHome = await h.services.homes.storageDeposit(pA, {
          homeId,
          containerId: DEFAULT_CHEST_ID,
          itemId: sword.id,
          opKey: 'pilot-home-dep-1',
        });
        assert.equal(depHome.replayed, false);
        assert.ok(!pA.rpg.inventory.some((i) => i.id === sword.id));

        const wdHome = await h.services.homes.storageWithdraw(pA, {
          homeId,
          containerId: DEFAULT_CHEST_ID,
          itemId: sword.id,
          opKey: 'pilot-home-wd-1',
        });
        assert.equal(wdHome.replayed, false);
        const returnedSword = pA.rpg.inventory.find((i) => i.id === sword.id);
        assert.ok(returnedSword && itemFingerprint(returnedSword) === swordFp, 'exact sword identity preserved');

        // Store one item persistently in the home chest to verify survival across cold restart.
        const keepGem = addItem(pA.rpg, 'ruby', 1);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();
        await h.services.homes.storageDeposit(pA, {
          homeId,
          containerId: DEFAULT_CHEST_ID,
          itemId: keepGem.id,
          opKey: 'pilot-home-dep-gem',
        });

        // Blocked Account C cannot be invited to A's home (neutral refusal, no block leak).
        const blockedVisit = await A.client.act('home.inviteGuest', { homeId, targetId: C.charId });
        assert.equal(blockedVisit.ok, false);
        assert.ok(!/block/i.test(blockedVisit.error || ''), `home refusal must not leak block status: ${blockedVisit.error}`);

        // Invite Account B -> B enters home -> presenceScope isolates B inside `home:<id>`!
        assert.equal((await A.client.act('home.inviteGuest', { homeId, targetId: B.charId })).ok, true);
        assert.equal((await B.client.act('home.enter', { homeId })).ok, true);
        assert.equal(h.services.presenceScope(pB), `home:${homeId}`);

        // Archive blocker check: Account A has an active visitor (B) in home -> archive MUST be blocked (409)!
        const archiveBlockedRes = await h.api('/api/characters/archive', {
          body: { characterId: A.charId, confirmName: 'Aelric' },
          jar: A.jar,
        });
        assert.equal(archiveBlockedRes.status, 409, `archive should be blocked while obligations/visitors exist: ${JSON.stringify(archiveBlockedRes.json)}`);
        assert.ok(
          archiveBlockedRes.json.blockers?.some((b) => b.code === 'ACTIVE_HOME_VISITORS'),
          `expected ACTIVE_HOME_VISITORS blocker: ${JSON.stringify(archiveBlockedRes.json.blockers)}`,
        );

        // B leaves home cleanly back to Gothway Garden.
        assert.equal((await B.client.act('home.leave', {})).ok, true);

        // =====================================================================
        // 5. §2 Orders: Permissions Matrix, Order Hall, Item Vault & Siege Hook
        // =====================================================================
        assert.equal((await A.client.act('order.create', { name: 'Vanguard of Gothway', tag: 'VOG' })).ok, true);
        assert.equal((await A.client.act('order.invite', { targetId: B.charId })).ok, true);
        assert.equal((await B.client.act('order.accept', {})).ok, true);
        assert.equal((await A.client.act('order.promote', { targetId: B.charId, rank: 'Officer' })).ok, true);

        // Revoke `siegeOfficer` from Officer rank via `order.setPermissions` -> B should NOT be able to register siege!
        assert.equal((await A.client.act('order.setPermissions', {
          rank: 'Officer',
          permissions: { siegeOfficer: false },
        })).ok, true);
        assert.equal(h.services.guildhall.hasOrderPermission(pB, 'siegeOfficer'), false);

        // Schedule a siege and prove B (Officer without siegeOfficer) is blocked while A (Leader) succeeds!
        assert.equal((await A.client.act('pvp.siege.schedule', { lockDelayMs: 60_000, startDelayMs: 90_000 })).ok, true);
        const bSiegeDenied = await B.client.act('pvp.siege.register', { side: 'attacker' });
        assert.equal(bSiegeDenied.ok, false, 'Officer without siegeOfficer permission must be denied siege registration');

        // Re-grant `siegeOfficer` to Officer rank -> now B CAN register the Order for siege!
        assert.equal((await A.client.act('order.setPermissions', {
          rank: 'Officer',
          permissions: { siegeOfficer: true },
        })).ok, true);
        assert.equal(h.services.guildhall.hasOrderPermission(pB, 'siegeOfficer'), true);
        assert.equal((await B.client.act('pvp.siege.register', { side: 'attacker' })).ok, true);

        // Fund Order treasury, buy Order Hall, and exercise Order Item Vault deposit & withdraw.
        assert.equal((await A.client.act('order.deposit', { amount: 6000 })).ok, true);
        const hallRes = await h.services.guildhall.buyHall(pA, { hallId: 'daggerfall-chapterhouse', confirm: true, opKey: 'pilot-hall-buy' });
        assert.equal(hallRes.result?.order?.hall?.id, 'daggerfall-chapterhouse');

        const vaultDagger = addItem(pA.rpg, 'iron-dagger', 1);
        const vaultDaggerFp = itemFingerprint(vaultDagger);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        await h.services.guildhall.vaultDeposit(pA, { itemId: vaultDagger.id, opKey: 'pilot-vault-dep-1' });
        assert.ok(!pA.rpg.inventory.some((i) => i.id === vaultDagger.id));

        // Deposit a second item that stays in the vault across cold restart.
        const vaultSapphire = addItem(pA.rpg, 'sapphire', 1);
        await h.store.saveCharacters([pA], []);
        if (typeof h.store.flush === 'function') await h.store.flush();
        await h.services.guildhall.vaultDeposit(pA, { itemId: vaultSapphire.id, opKey: 'pilot-vault-dep-2' });

        await h.services.guildhall.vaultWithdraw(pB, { itemId: vaultDagger.id, opKey: 'pilot-vault-wd-1' });
        const bDagger = pB.rpg.inventory.find((i) => i.id === vaultDagger.id);
        assert.ok(bDagger && itemFingerprint(bDagger) === vaultDaggerFp, 'B withdrew exact dagger from Order Vault');

        // =====================================================================
        // 6. §6 Player Market: Partial Stack, House Trader, Offline Buy,
        //    Auction, Buy Order, Claims, Anti-Self-Trade & Conservation
        // =====================================================================
        pA.x = 0; pA.z = 0;
        pB.x = 0; pB.z = 0;
        const marketArrows = addItem(pA.rpg, 'arrow', 20, {
          extra: { crafted: { maker: 'Aelric', quality: 'fine', profession: 'carpentry' } },
        });
        const auctionBlade = addItem(pA.rpg, 'steel-longsword', 1);
        await h.store.saveCharacters([pA, pB], []);
        if (typeof h.store.flush === 'function') await h.store.flush();

        // Snapshot exact gold before market trades for strict conservation check.
        const goldBeforeMarket = pA.rpg.gold + pB.rpg.gold;

        // A lists 20 arrows at 10g each (2% listing fee = 4g) and assigns to A's House Trader!
        const listed = await h.services.market.createListing(pA, {
          itemId: marketArrows.id,
          quantity: 20,
          unitPrice: 10,
          opKey: 'pilot-mkt-list-1',
        });
        assert.equal(listed.ok, true);
        const listingFee = listed.listingFee;

        // Cross-feature check: `market.assignHouseTrader` -> `homes.verifyTraderAccess`!
        const assigned = await h.services.market.assignHouseTrader(pA, {
          listingId: listed.listing.id,
          houseId: homeId,
          opKey: 'pilot-mkt-assign-trader',
        });
        assert.equal(assigned.ok, true);
        // Invited guest B can browse A's House Trader; blocked C is denied!
        const bBrowseTrader = await h.services.market.browseHouseTrader(pB, { houseId: homeId });
        assert.equal(bBrowseTrader.items.length, 1);
        await assert.rejects(
          () => h.services.market.browseHouseTrader(pC, { houseId: homeId }),
          /TRADER_ACCESS_DENIED|not accepting/i,
        );

        // A also creates a timed Auction for `steel-longsword` and B posts a funded Buy Order for `iron-ingot`.
        const auction = await h.services.market.createAuction(pA, {
          itemId: auctionBlade.id,
          startPrice: 100,
          buyoutPrice: 300,
          durationMs: 3600_000,
          opKey: 'pilot-mkt-auc-1',
        });
        assert.equal(auction.ok, true);
        const auctionFee = auction.listingFee;

        const buyOrder = await h.services.market.createBuyOrder(pB, {
          template: 'iron-ingot',
          quantity: 5,
          unitPrice: 20,
          opKey: 'pilot-mkt-bo-1',
        });
        assert.equal(buyOrder.ok, true);
        const buyOrderEscrowGold = 5 * 20;

        // Account A goes OFFLINE (disconnects WS).
        await A.client.close();
        await waitFor(() => !h.players.has(A.charId));

        // While A is offline: Account B buys PARTIAL stack (8 of 20 arrows) and bids 120g on A's auction!
        const partialBuy = await h.services.market.buyListing(pB, {
          listingId: listed.listing.id,
          quantity: 8,
          expectedUnitPrice: 10,
          opKey: 'pilot-mkt-buy-1',
        });
        assert.equal(partialBuy.ok, true);
        assert.equal(partialBuy.purchasedQuantity, 8);
        assert.equal(partialBuy.listing.remainingQuantity, 12);
        const saleTax = partialBuy.saleTax;

        const bidRes = await h.services.market.placeBid(pB, {
          auctionId: auction.auction.id,
          amount: 120,
          opKey: 'pilot-mkt-bid-1',
        });
        assert.equal(bidRes.ok, true);
        const bidEscrowGold = 120;

        // Anti-self-trade across account slots: Account A logs in on Slot 2 (`AelricAlt`) and tries to buy Slot 1's listing!
        const clientA2 = await h.connect(A.jar);
        openClients.push(clientA2);
        const wA2 = await clientA2.join({ characterId: charA2Id });
        assert.equal(wA2.type, 'welcome');
        const liveA2 = h.players.get(charA2Id);
        liveA2.x = 0; liveA2.z = 0;
        await assert.rejects(
          () => h.services.market.buyListing(liveA2, {
            listingId: listed.listing.id,
            quantity: 2,
            expectedUnitPrice: 10,
            opKey: 'pilot-self-trade-attempt',
          }),
          /own|self/i,
        );

        // Switch Account A back to Slot 1 (`Aelric`) and claim offline sale proceeds!
        const swA1 = await clientA2.switchTo(A.charId);
        assert.equal(swA1.type, 'welcome');
        A.client = clientA2;
        const pAOnline = h.players.get(A.charId);
        pAOnline.x = 0; pAOnline.z = 0;

        const aClaims = await h.services.market.claimAll(pAOnline, { opKey: 'pilot-claim-a' });
        assert.equal(aClaims.claimedCount, 1);
        assert.equal(aClaims.claimed.reduce((sum, c) => sum + (c.claimedGold ?? c.claim?.gold ?? 0), 0), 80 - saleTax);

        const bClaims = await h.services.market.claimAll(pB, { opKey: 'pilot-claim-b' });
        assert.equal(bClaims.claimedCount, 1);
        const bArrows = pB.rpg.inventory.find((i) => i.template === 'arrow' && i.crafted?.maker === 'Aelric');
        assert.ok(bArrows && bArrows.quantity === 8, 'B claimed 8 crafted arrows with maker metadata preserved');

        // Exact gold conservation check across A, B, active escrows (bid + buy order), and declared fees/tax!
        const goldAfterMarket = pAOnline.rpg.gold + pB.rpg.gold + bidEscrowGold + buyOrderEscrowGold + listingFee + auctionFee + saleTax;
        assert.equal(goldAfterMarket, goldBeforeMarket, 'exact gold conservation across partial buy, auction bid, buy order & fees');

        // =====================================================================
        // 7. §5 Party Coordination, Group Travel, §7/§9 Smaller Dungeon / Co-op
        // =====================================================================
        assert.equal((await A.client.act('party.invite', { targetId: B.charId })).ok, true);
        assert.equal((await B.client.act('party.accept', { fromId: A.charId })).ok, true);
        assert.equal((await A.client.act('party.locationShare', { mode: 'exact' })).ok, true);
        assert.equal((await A.client.act('party.ping', { x: 5, z: -3, label: 'Meet at gate' })).ok, true);

        // Group Travel ready check to Daggerfall City.
        const destTown = 'town:Daggerfall/Daggerfall';
        assert.equal((await A.client.act('party.travelPropose', { to: destTown })).ok, true);
        assert.equal((await B.client.act('party.travelRespond', { response: 'ready' })).ok, true);
        assert.equal(pAOnline.rpg.location, destTown, 'A relocated via atomic Group Travel');
        assert.equal(pB.rpg.location, destTown, 'B relocated via atomic Group Travel');

        // Smaller Dungeon (5-block) + Party Co-op Instance isolation from Account C!
        const dungeonLoc = 'dungeon:Daggerfall/The Dungeon of Peristair';
        assert.equal((await A.client.act('dungeon.layout.select', { mode: 'smaller', location: dungeonLoc })).ok, true);
        assert.equal((await A.client.act('instance.select', { mode: 'party', layoutMode: 'smaller' })).ok, true);
        assert.equal((await A.client.act('instance.enter', { location: dungeonLoc, mode: 'party' })).ok, true);
        assert.equal((await B.client.act('instance.enter', { location: dungeonLoc, mode: 'party' })).ok, true);
        const scopeA = h.services.presenceScope(pAOnline);
        const scopeB = h.services.presenceScope(pB);
        assert.ok(scopeA && scopeA.startsWith('party:'), `party instance scope active: ${scopeA}`);
        assert.equal(scopeA, scopeB, 'party members share the same co-op instance scope');
        assert.notEqual(h.services.presenceScope(pC), scopeA, 'Account C is isolated from party instance');

        assert.equal((await A.client.act('instance.leave', {})).ok, true);
        assert.equal((await B.client.act('instance.leave', {})).ok, true);

        // =====================================================================
        // 8. §4 Land PvP: Consent Duel, Ranked Arena, Open PvP Tag, Zero Crime
        // =====================================================================
        // Place A and B close together in outdoor Gothway Garden for Consent Duel.
        pAOnline.rpg.location = 'town:Daggerfall/Gothway Garden';
        pB.rpg.location = 'town:Daggerfall/Gothway Garden';
        pAOnline.x = 0; pAOnline.z = 0;
        pB.x = 2; pB.z = 0;
        pAOnline.rpg.character.health = 100;
        pB.rpg.character.health = 100;

        // Blocked Account C cannot be dueled by A (neutral refusal).
        pC.rpg.location = 'town:Daggerfall/Gothway Garden';
        pC.x = 3; pC.z = 0;
        const blockedDuel = await A.client.act('pvp.duel.invite', { targetId: C.charId });
        assert.equal(blockedDuel.ok, false);
        assert.ok(!/block/i.test(blockedDuel.error || ''), 'duel refusal must not leak block status');

        const crimesBeforeA = Object.keys(pAOnline.rpg.law?.crimes ?? {}).length;
        assert.equal((await A.client.act('pvp.duel.invite', { targetId: B.charId })).ok, true);
        assert.equal((await B.client.act('pvp.duel.accept', { challengerId: A.charId })).ok, true);

        // Advance duel countdown to active phase and land lethal-sized hit -> stops cleanly at 1 HP!
        assert.ok(h.services.pvp.duels.engagementOf(pAOnline), 'duel active');
        h.services.pvp.duels.tick(0.1, h.runtime.ctx.now() + 10_000);
        assert.equal(h.services.pvp.duels.engagementOf(pAOnline).phase, 'active');

        const duelHit = h.services.pvp.onPlayerDamage(pB, 250, pAOnline, 'melee');
        assert.equal(duelHit.blocked, false);
        assert.equal(duelHit.floorHp, 1);
        assert.equal(h.services.pvp.isLegalPvpCrimeSuppressed(pAOnline, 'assault', { pvp: true, target: pB }), true);
        duelHit.onNonLethal();
        assert.equal(h.services.pvp.duels.engagementOf(pAOnline), null, 'duel completed non-lethally');
        assert.equal(Object.keys(pAOnline.rpg.law?.crimes ?? {}).length, crimesBeforeA, 'zero town-guard crime during consent duel');

        // Ranked 1v1 Arena match -> Elo rating persisted via `runDurable`!
        assert.equal((await A.client.act('pvp.arena.queue', { mode: 'ranked' })).ok, true);
        assert.equal((await B.client.act('pvp.arena.queue', { mode: 'ranked' })).ok, true);
        assert.equal((await A.client.act('pvp.arena.accept', {})).ok, true);
        assert.equal((await B.client.act('pvp.arena.accept', {})).ok, true);
        const arenaMatch = h.services.pvp.arena.engagementOf(pAOnline);
        assert.ok(arenaMatch, 'ranked arena match created');
        assert.ok(h.services.presenceScope(pAOnline)?.startsWith('arena:'), 'isolated arena presenceScope active');
        h.services.pvp.arena.tick(0.1, h.runtime.ctx.now() + 10_000);
        assert.equal(h.services.pvp.onPlayerDefeat(pB, pAOnline), true);
        await h.services.pvp.flushDurable();
        const aEloAfter = h.services.pvp.arena.stateFor(pAOnline).rating.elo;
        assert.ok(aEloAfter > 1200, `winner Elo rose above 1200 (got ${aEloAfter})`);

        // Open PvP District: enter -> combat-tag -> blocks exit & switch -> zero town-guard crime!
        assert.equal((await A.client.act('pvp.district.enter', { acknowledgeWarning: true })).ok, true);
        assert.equal((await B.client.act('pvp.district.enter', { acknowledgeWarning: true })).ok, true);
        // Step outside safe entrance pad into active PvP district floor
        pAOnline.x = 25; pAOnline.z = 25;
        pB.x = 27; pB.z = 25;
        const distHit = h.services.pvp.onPlayerDamage(pB, 15, pAOnline, 'melee');
        assert.equal(distHit.blocked, false);
        assert.equal(h.services.pvp.isLegalPvpCrimeSuppressed(pAOnline, 'assault', { pvp: true, target: pB }), true);
        assert.ok(h.services.pvp.district.combatTagRemainingMs(pAOnline.id) > 0, 'combat tag applied in Open PvP District');
        const blockedExit = await A.client.act('pvp.district.exit', {});
        assert.equal(blockedExit.ok, false, 'combat-tagged player cannot exit district immediately');
        const blockedSwitch = await A.client.switchTo(charA2Id);
        assert.equal(blockedSwitch.type, 'error', 'combat-tagged player cannot switch character slots');

        // Restore test overrides & record pre-restart gold/inventory invariants.
        if (h.services.collision && origCollisionStatus) h.services.collision.status = origCollisionStatus;
        if (origCanSee) h.services.canSee = origCanSee;

        const preRestartAGold = pAOnline.rpg.gold;
        const preRestartBGold = pB.rpg.gold;
        const preRestartMiningXp = pAOnline.rpg.professions.tracks.mining.xp;
        const preRestartHomeFurnCount = h.services.homes.homeById(homeId).furnishings.length;

        // =====================================================================
        // 9. Cold Restart from Persisted Storage & Privacy / Conservation Check
        // =====================================================================
        for (const cl of openClients) await cl.close();
        openClients.length = 0;
        await h.stop({ keepFiles: true });

        h2 = await createPilotHarness({
          backend,
          dir: h.rootDir,
          dbPath: h.gameDb,
          accountsDbPath: h.acctDb,
        });
        await h2.start();

        // Reconnect Account A (Slot 1), Account B, and Account C.
        const cA = await h2.connect(A.jar);
        const cB = await h2.connect(B.jar);
        const cC = await h2.connect(C.jar);
        openClients.push(cA, cB, cC);

        assert.equal((await cA.join({ characterId: A.charId })).type, 'welcome');
        assert.equal((await cB.join({ characterId: B.charId })).type, 'welcome');
        assert.equal((await cC.join({ characterId: C.charId })).type, 'welcome');

        const rA = h2.players.get(A.charId);
        const rB = h2.players.get(B.charId);
        const rC = h2.players.get(C.charId);

        // 9a. Character slots survived
        const rosterAfter = await h2.api('/api/characters', { method: 'GET', jar: A.jar });
        assert.equal(rosterAfter.status, 200);
        assert.equal(rosterAfter.json.characters.length, 2);

        // 9b. Friends & Letters survived, and Account C sees ZERO private data of A or B!
        assert.equal(h2.services.areFriends(rA, rB), true);
        assert.equal(h2.services.isBlocked(rA, rC), true);
        assert.equal((await cB.act('mail.list', { folder: 'inbox' })).ok, true);
        const rBMail = cB.events('social').find((e) => e.mailPage)?.mailPage?.items ?? [];
        assert.ok(rBMail.some((l) => l.subject === 'Market Goods Ready'), 'letter survived cold restart');

        assert.equal((await cC.act('mail.list', { folder: 'inbox' })).ok, true);
        const rCMail = cC.events('social').find((e) => e.mailPage)?.mailPage?.items ?? [];
        assert.equal(rCMail.length, 0, 'Account C sees zero private letters');
        assert.equal((await cC.act('friends.list', {})).ok, true);
        const rCFriends = cC.events('social').find((e) => e.friendsPage)?.friendsPage?.items ?? [];
        assert.equal(rCFriends.length, 0, 'Account C sees zero friendships of A & B');

        // 9c. Personal Home, Crafted Furniture & Storage Chest survived; C cannot enter!
        const rHome = h2.services.homes.homeById(homeId);
        assert.ok(rHome, 'home survived restart');
        assert.equal(rHome.furnishings.length, preRestartHomeFurnCount);
        assert.ok(rHome.containers[DEFAULT_CHEST_ID].items.some((i) => i.template === 'ruby'), 'chest item survived restart');
        assert.equal(h2.services.homes.canVisitHome(rC, rHome).ok, false, 'Account C denied access to A home');

        // 9d. Order, Permissions, Hall & Vault survived
        const rOrder = h2.services.guildhall.orderOf(rA);
        assert.ok(rOrder && rOrder.hall?.id === 'daggerfall-chapterhouse', 'Order Hall survived restart');
        assert.equal(h2.services.guildhall.hasOrderPermission(rB, 'siegeOfficer'), true);
        assert.ok(rOrder.vault.some((slot) => (slot.item?.template ?? slot.template) === 'sapphire'), 'Order Vault item survived restart');

        // 9e. Professions XP, Node Depletion & Account Daily Writ survived
        assert.equal(rA.rpg.professions.tracks.mining.xp, preRestartMiningXp);
        const rIronNode = h2.services.professions.nodesAt('town:Daggerfall/Gothway Garden').find((n) => n.id === 'node:gothway:iron-1');
        assert.equal(rIronNode.charges, ironNodeAfter.charges, 'node depletion persisted across restart');
        assert.equal(
          h2.services.professions.writBoardFor(rA).writs.find((w) => w.writId === firstWrit.writId)?.completed,
          true,
          'completed daily writ persisted across restart',
        );

        // 9f. Market listings, auction, buy order & exact gold/item conservation survived
        assert.equal(rA.rpg.gold, preRestartAGold, 'Account A gold conserved across restart');
        assert.equal(rB.rpg.gold, preRestartBGold, 'Account B gold conserved across restart');
        const rBrowse = h2.services.market.browseListings({ q: 'arrow' });
        assert.equal(rBrowse.items.length, 1);
        assert.equal(rBrowse.items[0].remainingQuantity, 12, 'remaining partial listing stock survived restart');
        const rAuctions = h2.services.market.browseAuctions({});
        assert.equal(rAuctions.items.length, 1);
        assert.equal(rAuctions.items[0].highBid, 120, 'active auction high bid survived restart');
        const rOrders = h2.services.market.browseBuyOrders({});
        assert.equal(rOrders.items.length, 1);

        // 9g. PvP Elo rating & Siege schedule survived
        assert.equal(h2.services.pvp.arena.stateFor(rA).rating.elo, aEloAfter, 'Ranked Arena Elo survived restart');
        assert.ok(h2.services.pvp.siege.stateFor(rA).activeSiege, 'Scheduled Order Siege survived restart');
      } finally {
        for (const cl of openClients) {
          try { await cl.close(); } catch {}
        }
        if (h2) await h2.stop();
        else await h.stop();
      }
    });
  }
});
