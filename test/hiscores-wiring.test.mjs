// The real pieces together: server/db.js game store -> createHiscoresService (SQLite store, project.js,
// engine) -> public HTTP handler. Guards the contracts the separately written modules disagreed on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { createHiscoresService } from '../server/hiscores/index.js';
import { SKILLS } from '../client/gameplay/character/rules.js';

function rpgFor({ level = 1, skill = 20, slain = 0, hidden = false, order = null } = {}) {
  return {
    character: { created: true, className: 'Warrior', race: 'Nord', level, skills: Object.fromEntries(SKILLS.map((s) => [s, skill])) },
    chronicles: { monstersSlain: slain, hidden },
    ...(order ? { playerGuild: order } : {}),
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hiscores-wiring-'));
  const store = openStore(join(dir, 'world.db'));
  const mk = (name, rpg) => {
    const { row } = store.create(name, rpg);
    return { ...row, rpg };
  };
  const gareth = mk('Gareth', rpgFor({ level: 3, skill: 30, slain: 3 }));
  const ysolde = mk('Ysolde', rpgFor({ level: 2, skill: 25, slain: 2 }));
  const shade = mk('Shade', rpgFor({ level: 9, skill: 40, slain: 1, hidden: true, order: { id: 'pg_nh', name: 'Night Hollow', tag: 'NH', rank: 'Leader' } }));
  const createdAt = '2026-11-25T15:00:00.000Z';
  store.saveCharacters([], [['pguild:pg_nh', {
    id: 'pg_nh', name: 'Night Hollow', tag: 'NH', treasury: 0, createdAt, leaderId: shade.id,
    members: { [shade.id]: { id: shade.id, name: 'Shade', rank: 'Leader' }, [gareth.id]: { id: gareth.id, name: 'Gareth', rank: 'Member' } },
  }]]);
  const hiscores = createHiscoresService({ gameStore: store, log: null });
  const http = createServer((req, res) => hiscores.handleHttp(req, res));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${http.address().port}/api/hiscores`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  return {
    store, hiscores, get, gareth, ysolde, shade, createdAt,
    async close() {
      await new Promise((r) => http.close(r));
      await hiscores.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('HTTP ?q= search reaches the engine and filters by name', async () => {
  const w = await setup();
  try {
    const { status, body } = await w.get('?board=overall&q=gar');
    assert.equal(status, 200);
    assert.equal(body.filters.query, 'gar');
    assert.deepEqual(body.entries.map((e) => e.name), ['Gareth']);
    const orders = await w.get('/orders?q=zzz');
    assert.equal(orders.body.total, 0);
  } finally {
    await w.close();
  }
});

test('Orders board never names a hidden leader and keeps the documented fields', async () => {
  const w = await setup();
  try {
    const { body } = await w.get('/orders?sort=level');
    assert.equal(body.entries.length, 1);
    const [ord] = body.entries;
    assert.equal(ord.name, 'Night Hollow');
    assert.notEqual(ord.leaderName, 'Shade');
    assert.equal(JSON.stringify(body).includes('Shade'), false);
    // docs/hiscores.md: combinedLevel / combinedTotalSkill / createdAt (epoch ms) — public members only.
    assert.equal(ord.combinedLevel, 3);
    assert.equal(ord.combinedTotalSkill, 30 * SKILLS.length);
    assert.equal(ord.createdAt, Date.parse(w.createdAt));
  } finally {
    await w.close();
  }
});

test('hidden, deleted and renamed characters after live syncs and a restart', async () => {
  const w = await setup();
  try {
    assert.deepEqual((await w.get('/board/slayer')).body.entries.map((e) => [e.rank, e.name]), [[1, 'Gareth'], [2, 'Ysolde']]);
    assert.equal((await w.get('/player/Shade')).status, 404);
    assert.equal((await w.get(`/player/${w.shade.id}`)).status, 404);
    assert.equal((await w.get('/compare?a=Gareth&b=Shade')).status, 404);

    // Gareth opts out, Ysolde is renamed: the very next request reflects both (no stale cache).
    await w.get('/board/slayer');
    w.gareth.rpg.chronicles.hidden = true;
    w.ysolde.name = 'Ysolde Dres';
    await w.hiscores.syncPlayers([w.gareth, w.ysolde]);
    let board = (await w.get('/board/slayer')).body;
    assert.deepEqual(board.entries.map((e) => [e.rank, e.name]), [[1, 'Ysolde Dres']]);
    assert.equal((await w.get('/player/Ysolde')).status, 404);

    // Deleted character disappears; ranks close up.
    w.gareth.rpg.chronicles.hidden = false;
    await w.hiscores.syncPlayers([w.gareth]);
    await w.hiscores.removePlayer(w.ysolde.id);
    board = (await w.get('/board/slayer')).body;
    assert.deepEqual(board.entries.map((e) => [e.rank, e.name]), [[1, 'Gareth']]);

    // Restart: a fresh service over the same database rebuilds from players and keeps privacy.
    w.store.saveCharacters([w.gareth]);
    w.store.db.prepare('DELETE FROM players WHERE id = ?').run(w.ysolde.id);
    const again = createHiscoresService({ gameStore: w.store, log: null });
    const restarted = await again.getBoard({ board: 'slayer' });
    assert.deepEqual(restarted.entries.map((e) => [e.rank, e.name]), [[1, 'Gareth']]);
    assert.equal(await again.getPlayer('Shade'), null);
  } finally {
    await w.close();
  }
});
