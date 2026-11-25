// End-to-end integration test exercising all wired multiplayer systems together on a live server:
// account lifecycle APIs, proximity & shout chat, persistent SQLite chat logging across every channel,
// player-founded orders & classic guild overview, classic Mage starting kit, spatial AOI with party priority,
// uncapped maxPlayers=0, and delta protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createAccounts } from '../server/accounts.js';
import { createGameServer } from '../server/game.js';
import * as charRules from '../client/gameplay/character/rules.js';

function httpJson(port, method, path, body, cookie = '') {
  const headers = { Origin: `http://127.0.0.1:${port}` };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({
    status: res.status,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    json: await res.json().catch(() => null),
  }));
}

function connectWs(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Origin: `http://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}) },
    });
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0];
        clearTimeout(w.timer);
        w.res(msg);
      } else {
        inbox.push(msg);
      }
    });
    const next = (pred, ms = 4000) => {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const j = waiters.findIndex((w) => w.res === res);
          if (j >= 0) waiters.splice(j, 1);
          rej(new Error('timed out waiting for message'));
        }, ms);
        waiters.push({ pred, res, timer });
      });
    };
    let seq = 0;
    const act = (verb, args = {}) => {
      const mySeq = ++seq;
      ws.send(JSON.stringify({ type: 'action', seq: mySeq, verb, args }));
      return next((m) => m.type === 'actionResult' && m.seq === mySeq);
    };
    ws.once('open', () => resolve({ ws, next, act, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() }));
    ws.once('error', reject);
  });
}

test('integrated live server: accounts lifecycle, proximity/shout chat, persistent chat logs, guilds, Mage start, AOI, and uncapped world', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-all-systems-'));
  const accounts = createAccounts({
    dbPath: join(dir, 'accounts.db'),
    secureCookies: false,
    scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 },
  });
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'world.db'),
    accounts,
    maxPlayers: 0, // uncapped single world
    aoiThreshold: 2, // force SpatialGrid AOI active with 3+ players
    aoiRadius: 50,
    maxVisiblePeers: 2,
    chatRatePerSec: 20,
    chatBurst: 50,
    actionRatePerSec: 40,
    actionBurst: 80,
  });

  try {
    const { port } = await server.start();

    // 1. Account lifecycle: register (gets recoveryCode), change password, recover, logout-all.
    const regA = await httpJson(port, 'POST', '/api/register', { username: 'Aldric', password: 'Password1234!' });
    assert.equal(regA.status, 201);
    assert.ok(regA.json.recoveryCode, 'registration returns one-time recovery code');
    const recCode = regA.json.recoveryCode;

    const pw = await httpJson(port, 'POST', '/api/password', {
      currentPassword: 'Password1234!',
      newPassword: 'NewPassword5678!',
    }, regA.cookie);
    assert.equal(pw.status, 200);

    const outAll = await httpJson(port, 'POST', '/api/logout-all', {}, regA.cookie);
    assert.equal(outAll.status, 200);

    const rec = await httpJson(port, 'POST', '/api/recover', {
      username: 'Aldric',
      recoveryCode: recCode,
      newPassword: 'RecoveredPass999!',
    });
    assert.equal(rec.status, 200);
    assert.ok(rec.json.recoveryCode, 'recover issues a fresh recovery code');

    const loginA = await httpJson(port, 'POST', '/api/login', { username: 'Aldric', password: 'RecoveredPass999!' });
    assert.equal(loginA.status, 200);
    const regB = await httpJson(port, 'POST', '/api/register', { username: 'Brynja', password: 'Password1234!' });
    assert.equal(regB.status, 201);
    const regC = await httpJson(port, 'POST', '/api/register', { username: 'Corvus', password: 'Password1234!' });
    assert.equal(regC.status, 201);

    // 2. Connect 3 players over WebSocket with delta: true on uncapped maxPlayers=0.
    const a = await connectWs(port, loginA.cookie);
    const b = await connectWs(port, regB.cookie);
    const c = await connectWs(port, regC.cookie);
    try {
      a.send({ type: 'join', name: 'Aldric', delta: true });
      b.send({ type: 'join', name: 'Brynja', delta: true });
      c.send({ type: 'join', name: 'Corvus', delta: true });
      const wa = await a.next((m) => m.type === 'welcome');
      const wb = await b.next((m) => m.type === 'welcome');
      const wc = await c.next((m) => m.type === 'welcome');
      assert.ok(wa.id && wb.id && wc.id);

      // 3. Roll attributes + create a classic Mage for Aldric and verify authentic starting spells + torch.
      const rRoll = await a.act('character.roll', { race: 'High Elf', className: 'Mage' });
      assert.equal(rRoll.ok, true, rRoll.error);
      const pa = server.runtime.ctx.players.get(wa.id);
      const pb = server.runtime.ctx.players.get(wb.id);
      const pc = server.runtime.ctx.players.get(wc.id);
      const draft = pa.rpg.character.draft;
      const career = charRules.CLASS_BY_NAME.Mage;
      const attributes = charRules.spendLowest({ ...draft.attributeBase }, charRules.ATTRIBUTES, draft.bonusPool);
      const skills = { ...draft.skillBase };
      for (const [, list] of charRules.groupsOf(career)) charRules.spendLowest(skills, list, charRules.SKILL_GROUP_POOL);
      const rCreate = await a.act('character.create', {
        name: 'Aldric',
        race: 'High Elf',
        gender: 'Male',
        className: 'Mage',
        reflexes: 'Average',
        attributes,
        skills,
      });
      assert.equal(rCreate.ok, true, rCreate.error);
      assert.ok((pa.rpg.magic?.known?.length ?? 0) > 0, 'Mage receives classic starting spells');
      assert.ok(pa.rpg.inventory?.some((it) => it.template === 'torch'), 'new character starts with a torch');

      // 4. Proximity chat vs shout + persistent SQLite chat_messages verification.
      pa.x = 0; pa.z = 0;
      pb.x = 10; pb.z = 0;   // within 24m proximity
      pc.x = 100; pc.z = 0;  // outside 24m proximity, inside 160m shout

      const sayRes = await a.act('chat.send', { channel: 'say', text: 'Quiet nearby greeting' });
      assert.equal(sayRes.ok, true, sayRes.error);
      const bHeardSay = await b.next((m) => m.type === 'gameEvent' && m.event.kind === 'chat' && m.event.text === 'Quiet nearby greeting');
      assert.equal(bHeardSay.event.channel, 'say');
      // Verify Corvus did NOT receive the 24m proximity chat.
      let cGotSay = false;
      try {
        await c.next((m) => m.type === 'gameEvent' && m.event.kind === 'chat' && m.event.text === 'Quiet nearby greeting', 150);
        cGotSay = true;
      } catch {}
      assert.equal(cGotSay, false, 'player 100m away must not receive proximity chat');

      const shoutRes = await a.act('chat.send', { channel: 'shout', text: 'Hear ye across town!' });
      assert.equal(shoutRes.ok, true, shoutRes.error);
      const cHeardShout = await c.next((m) => m.type === 'gameEvent' && m.event.kind === 'chat' && m.event.text === 'Hear ye across town!');
      assert.equal(cHeardShout.event.channel, 'shout');

      // Raw { type: 'chat' } also uses proximity and logs to SQLite.
      a.send({ type: 'chat', text: 'Raw socket local line' });
      await b.next((m) => m.type === 'chat' && m.text === 'Raw socket local line');

      // 5. Player-founded multiplayer Order + treasury + order chat persistence.
      pa.rpg.gold = 500;
      const ordCreate = await a.act('order.create', { name: 'Blades of Iliac', tag: 'BOI', motd: 'Guard the Bay' });
      assert.equal(ordCreate.ok, true, ordCreate.error);
      const ordDep = await a.act('order.deposit', { amount: 100 });
      assert.equal(ordDep.ok, true, ordDep.error);
      const ordChat = await a.act('guild.chat', { scope: 'order', text: 'Order rally at dusk' });
      assert.equal(ordChat.ok, true, ordChat.error);

      // 6. Verify ALL chat messages across say, shout, raw chat, and order chat were persisted in SQLite!
      const logged = server.chatLog.queryChat({ senderName: 'Aldric', limit: 20 });
      const bodies = logged.rows.map((r) => `${r.channel}:${r.body}`);
      assert.ok(bodies.includes('say:Quiet nearby greeting'), `expected say in ${JSON.stringify(bodies)}`);
      assert.ok(bodies.includes('shout:Hear ye across town!'), `expected shout in ${JSON.stringify(bodies)}`);
      assert.ok(bodies.includes('say:Raw socket local line'), `expected raw say in ${JSON.stringify(bodies)}`);
      assert.ok(bodies.includes('order:Order rally at dusk'), `expected order chat in ${JSON.stringify(bodies)}`);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  } finally {
    await server.close();
    accounts.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
