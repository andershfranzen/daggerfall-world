// End-to-end integration test for the wired Chronicles of the Iliac Bay (Hiscores)
// and Authentic Daggerfall Peer Character Figures stack on a live createGameServer.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../server/game.js';
import { createAccounts } from '../server/accounts.js';

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function connectWs(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: `http://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.once('open', () => resolve({
      ws,
      send: (obj) => ws.send(JSON.stringify(obj)),
      next: (pred = () => true, timeoutMs = 5000) => {
        const idx = queue.findIndex(pred);
        if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('ws message timeout')), timeoutMs);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); }, reject: (e) => { clearTimeout(t); rej(e); } });
        });
      },
      close: () => (ws.readyState === ws.CLOSED ? Promise.resolve() : new Promise((res) => { ws.once('close', res); ws.close(); })),
    }));
    ws.once('error', reject);
  });
}

async function registerAndJoin(base, port, username, password) {
  const reg = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password }),
  });
  const regBodyText = await reg.text();
  assert.equal(reg.status, 201, `register ${username}: ${regBodyText}`);
  const regJson = JSON.parse(regBodyText);
  const cookie = cookieHeader(reg);
  const sock = await connectWs(port, cookie);
  sock.send({ type: 'join', name: username, delta: true });
  const welcome = await sock.next((m) => m.type === 'welcome');
  await sock.next((m) => m.type === 'rpg');
  return { sock, cookie, playerId: welcome.id, user: regJson.user };
}

test('E2E wired Hiscores (HTTP + WS + privacy + ban exclusion) and Peer Equipped-Gear Figure projection', async () => {
  const accounts = createAccounts({
    dbPath: ':memory:',
    secureCookies: false,
    scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 },
  });
  const server = createGameServer({
    accounts,
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
  });
  const addr = await server.start();
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const heroA = await registerAndJoin(base, addr.port, 'Gothryd', 'SilverDragonPass#1');
    const heroB = await registerAndJoin(base, addr.port, 'Barenziah', 'SapphireArcanePass#2');
    const bannedHero = await registerAndJoin(base, addr.port, 'OutlawBot', 'IronSentinelPass#3');

    // Create characters via real character.create flow? Or populate via authoritative server players directly
    // to keep the test focused on live HTTP/WS Hiscores + publicPeer projection.
    const pA = server.runtime.ctx.players.get(heroA.playerId);
    const pB = server.runtime.ctx.players.get(heroB.playerId);
    const pBan = server.runtime.ctx.players.get(bannedHero.playerId);

    // Give heroA and heroB distinct created characters, gear, skills, and stats
    pA.rpg.character = {
      ...pA.rpg.character,
      created: true,
      race: 'Breton',
      gender: 'Male',
      faceIndex: 3,
      className: 'Knight',
      level: 12,
      skills: { ...(pA.rpg.character?.skills ?? {}), 'Long Blade': 92, 'Critical Strike': 80, Etiquette: 65 },
    };
    pA.rpg.chronicles = { ...(pA.rpg.chronicles ?? {}), hidden: false, monstersSlain: 145, questsCompleted: 14 };
    pA.rpg.law = { ...(pA.rpg.law ?? {}), rep: { Daggerfall: -40 } };
    pA.rpg.admiralty = { ...(pA.rpg.admiralty ?? {}), standing: { Daggerfall: 160 }, log: { sunk: { pirate: 4 } } };
    server.runtime.ctx.services.giveItem?.(pA, 'daedric-cuirass', 1);
    const cuirass = pA.rpg.inventory.find((i) => i.template === 'daedric-cuirass');
    if (cuirass) pA.rpg.equipment.chestArmor = cuirass.id;

    pB.rpg.character = {
      ...pB.rpg.character,
      created: true,
      race: 'Dark Elf',
      gender: 'Female',
      faceIndex: 5,
      className: 'Mage',
      level: 15,
      skills: { ...(pB.rpg.character?.skills ?? {}), Destruction: 98, Thaumaturgy: 88, Mysticism: 75 },
    };
    pB.rpg.chronicles = { ...(pB.rpg.chronicles ?? {}), hidden: false, monstersSlain: 90, questsCompleted: 22 };

    pBan.rpg.character = {
      ...pBan.rpg.character,
      created: true,
      race: 'Nord',
      gender: 'Male',
      className: 'Barbarian',
      level: 30,
      skills: { ...(pBan.rpg.character?.skills ?? {}), Axe: 100 },
    };

    // Persist players into SQLite players table & sync to Hiscores store
    server.runtime.ctx.dirty(pA);
    server.runtime.ctx.dirty(pB);
    server.runtime.ctx.dirty(pBan);
    await server.hiscores.syncPlayers([pA, pB, pBan]);

    // 1. Verify publicPeer includes equipped gear & classic figure fields (and zero private inventory)
    server.runtime.sync();
    const rpgSnapB = await heroB.sock.next((m) =>
      m.type === 'rpg' && Array.isArray(m.peers) && m.peers.some((p) => p.id === heroA.playerId && p.className === 'Knight'),
    );
    const peerA = rpgSnapB.peers.find((p) => p.id === heroA.playerId);
    assert.ok(peerA, 'heroB receives peerA in rpg snapshot');
    assert.equal(peerA.race, 'Breton');
    assert.equal(peerA.className, 'Knight');
    assert.equal(peerA.faceIndex, 3);
    assert.equal(peerA.archetype, 'knight');
    assert.equal(peerA.armorTier, 'daedric');
    assert.ok(peerA.worn?.chestArmor?.template === 'daedric-cuirass', 'peerA exposes visible worn Daedric cuirass');
    assert.equal('inventory' in peerA, false, 'private inventory must never leak on peer');

    // 2. Public HTTP /api/hiscores/categories
    const catRes = await fetch(`${base}/api/hiscores/categories`);
    assert.equal(catRes.status, 200);
    const cats = await catRes.json();
    assert.equal(cats.totalClassicPlaces, 15251);
    assert.ok(cats.groups.some((g) => g.id === 'skills' && g.boards.length === 35));

    // 3. Public HTTP /api/hiscores?board=level
    const boardRes = await fetch(`${base}/api/hiscores?board=level`);
    assert.equal(boardRes.status, 200);
    const board = await boardRes.json();
    assert.equal(board.entries.length, 3);
    assert.equal(board.entries[0].name, 'OutlawBot');
    assert.equal(board.entries[1].name, 'Barenziah');
    assert.equal(board.entries[2].name, 'Gothryd');
    assert.equal('accountId' in board.entries[0], false, 'accountId never exposed');
    assert.equal('location' in board.entries[0], false, 'live location never exposed');

    // 4. Ban OutlawBot -> automatically excluded from public Hiscores!
    // Save players first so rebuild() reads updated RPG from players table
    pA.rpg.chronicles.updatedAt = Date.now();
    server.hiscores.store.db.prepare('UPDATE players SET rpg = ? WHERE id = ?').run(JSON.stringify(pA.rpg), pA.id);
    server.hiscores.store.db.prepare('UPDATE players SET rpg = ? WHERE id = ?').run(JSON.stringify(pB.rpg), pB.id);
    server.hiscores.store.db.prepare('UPDATE players SET rpg = ? WHERE id = ?').run(JSON.stringify(pBan.rpg), pBan.id);
    accounts.ban('OutlawBot', { reason: 'exploit test', actor: 'test' });
    await server.hiscores.rebuild();
    const afterBan = await (await fetch(`${base}/api/hiscores?board=level`)).json();
    assert.equal(afterBan.entries.length, 2);
    assert.ok(!afterBan.entries.some((e) => e.name === 'OutlawBot'), 'banned account excluded from Hiscores');

    // 5. Public HTTP /api/hiscores/player/Barenziah & /api/hiscores/compare
    const profRes = await fetch(`${base}/api/hiscores/player/Barenziah`);
    assert.equal(profRes.status, 200);
    const prof = await profRes.json();
    assert.equal(prof.player.name, 'Barenziah');
    assert.equal(prof.skills.length, 35);
    assert.equal(prof.summary.levelRank, 1);

    const cmpRes = await fetch(`${base}/api/hiscores/compare?a=Gothryd&b=Barenziah`);
    assert.equal(cmpRes.status, 200);
    const cmp = await cmpRes.json();
    assert.equal(cmp.ok, true);
    assert.equal(cmp.skills.length, 35);

    // 6. WebSocket chronicles.board & chronicles.privacy opt-out
    heroA.sock.send({ type: 'action', seq: 1, verb: 'chronicles.board', args: { board: 'slayer' } });
    const wsBoard = await heroA.sock.next((m) => m.type === 'gameEvent' && m.event?.kind === 'chronicles' && m.event?.view === 'board');
    assert.equal(wsBoard.event.data.entries[0].name, 'Gothryd');
    assert.equal(wsBoard.event.data.entries[0].score, 145);

    heroA.sock.send({ type: 'action', seq: 2, verb: 'chronicles.privacy', args: { hidden: true } });
    const wsPriv = await heroA.sock.next((m) => m.type === 'gameEvent' && m.event?.kind === 'chronicles' && m.event?.view === 'privacy');
    assert.equal(wsPriv.event.hidden, true);
    await new Promise((r) => setTimeout(r, 40));

    const hiddenLookup = await fetch(`${base}/api/hiscores/player/Gothryd`);
    assert.equal(hiddenLookup.status, 404, 'opted-out player is hidden from public Hiscores');

    await heroA.sock.close();
    await heroB.sock.close();
    await bannedHero.sock.close();
  } finally {
    await server.close();
    accounts.close();
  }
});
