// Wilderness over the real game server and WebSocket protocol, alongside the production features
// (passed through the `features` option; the production manifest is not changed here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGameServer, PRODUCTION_FEATURES } from '../server/game.js';
import { install as wilderness } from '../server/rpg/wilderness.js';

let tmp, root;
const obj = (type, id, name, [x, y, z], extra = '') =>
  `<object><type>${type}</type><objectID>${id}</objectID><name>${name}</name><posX>${x}</posX><posY>${y}</posY><posZ>${z}</posZ>` +
  `<scaleX>1</scaleX><scaleY>1</scaleY><scaleZ>1</scaleZ>${extra}</object>`;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-wild-ws-'));
  for (const d of ['client', 'site']) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, 'client', 'play.html'), '<!doctype html><title>play</title>');
  root = join(tmp, 'wod');
  mkdirSync(join(root, 'Locations', 'Daggerfall'), { recursive: true });
  mkdirSync(join(root, 'Locations', 'LocationPrefab'), { recursive: true });
  writeFileSync(join(root, 'Locations', 'Daggerfall', 'Daggerfall_Locations.csv'), 'name,type,prefab,worldX,worldY,terrainX,terrainY\nWOD_OrcCamp,0,Camp,109,160,40,40\n');
  writeFileSync(
    join(root, 'Locations', 'LocationPrefab', 'Camp.txt'),
    `<locationPrefab><height>4</height><width>4</width>${obj(0, 1, '41734', [0, 0, 0])}${obj(1, 2, '216.27', [1, 0, 0])}` +
      `${obj(2, 3, '199.16', [3, 0, 0], '<extraData>{"EnemyId":7,"TeamOverride":0}</extraData>')}</locationPrefab>`,
  );
});
after(() => rmSync(tmp, { recursive: true, force: true }));

class Client {
  constructor(port) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((r) => this.ws.once('open', r));
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  next(pred, timeout = 4000) {
    const found = this.messages.find(pred);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        this.messages.splice(this.messages.indexOf(msg), 1);
        resolve(msg);
        return true;
      });
    });
  }
  async join(name) {
    await this.opened;
    this.ws.send(JSON.stringify({ type: 'join', name }));
    return this.next((m) => m.type === 'welcome' || m.type === 'error');
  }
  act(verb, args, seq) {
    this.ws.send(JSON.stringify({ type: 'action', verb, args, seq }));
    return this.next((m) => m.type === 'actionResult' && m.seq === seq).catch(() => this.next((m) => m.seq === seq));
  }
}

test('two WebSocket accounts visit the same camp and receive the same scene', async () => {
  // Production manifest, with the wilderness entry pointed at this test's tree.
  const mine = { name: 'wilderness', install: (ctx) => wilderness(ctx, { root }) };
  const features = PRODUCTION_FEATURES.some((f) => f.name === 'wilderness')
    ? PRODUCTION_FEATURES.map((f) => (f.name === 'wilderness' ? mine : f))
    : [...PRODUCTION_FEATURES, mine];
  const server = createGameServer({ host: '127.0.0.1', port: 0, clientDir: join(tmp, 'client'), siteDir: join(tmp, 'site'), dbPath: join(tmp, 'w.db'), features });
  const { port } = await server.start();
  try {
    const a = new Client(port), b = new Client(port);
    assert.equal((await a.join('Alice')).type, 'welcome');
    assert.equal((await b.join('Bob')).type, 'welcome');
    const snapA = await a.next((m) => m.type === 'rpg' && m.character?.wilderness?.pack === 'ready' && m.character.wilderness.nearby.length);
    const site = snapA.character.wilderness.nearby[0];
    assert.equal(site.id, 'wod:109,160:40,40');

    const ra = await a.act('wilderness.visit', { site: site.id }, 1);
    const rb = await b.act('wilderness.visit', { site: site.id }, 1);
    assert.equal(ra.ok, true, JSON.stringify(ra));
    assert.equal(rb.ok, true, JSON.stringify(rb));
    const sceneA = await a.next((m) => m.type === 'gameEvent' && m.event.kind === 'wildernessScene');
    const sceneB = await b.next((m) => m.type === 'gameEvent' && m.event.kind === 'wildernessScene');
    assert.equal(JSON.stringify(sceneA.event.scene), JSON.stringify(sceneB.event.scene));
    const atA = await a.next((m) => m.type === 'rpg' && m.character.location === 'wilderness:109,160' && m.peers.some((p) => p.name === 'Bob'));
    assert.equal(atA.character.wilderness.site, site.id);

    const stale = await a.act('wilderness.visit', { site: 'wod:109,160:1,1' }, 2);
    assert.equal(stale.ok, false);
    assert.match(stale.error, /no longer there/);
    const back = await a.act('wilderness.leave', {}, 3);
    assert.equal(back.ok, true);
    await a.next((m) => m.type === 'rpg' && m.character.location === 'town:Daggerfall/Gothway Garden');
  } finally {
    await server.stop?.();
    await server.close?.();
  }
});
