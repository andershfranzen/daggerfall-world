// Automap exploration memory, orientation, notes, notebook and the discovery hook (package 6).
// FIXTURE: the real runtime (server/rpg/runtime.js), the real automap feature and the real SQLite store on a temp
// file. Line of sight is a stub wall at x = 10 (the real collision service is exercised by the live check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CELL, MAX_CELLS, packCells, unpackCells, revealAround, cellKey, cleanText, fogged, cellsBounds, cellIndexMap, isExplored,
} from '../client/gameplay/automap/memory.js';
import { makeView, worldToScreen, screenToWorld, headingVector, panBy, zoomAt, viewTransform } from '../client/gameplay/automap/model.js';
import { createAutomapController } from '../client/gameplay/automap/controller.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import * as automapFeature from '../client/gameplay/automap.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as automap } from '../server/rpg/automap.js';
import { openStore } from '../server/db.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const DUNGEON = "dungeon:Daggerfall/Privateer's Hold";
const TOWN = 'town:Daggerfall/Gothway Garden';

test('cells round-trip through the wire format; malformed data is refused', () => {
  const cells = [[0, 0, 0], [-5, 7, -12], [32000, -32000, 3], [1, 2, 77]];
  assert.deepEqual(unpackCells(packCells(cells)), cells);
  assert.deepEqual(unpackCells(packCells(cells.map(([a, b, c]) => cellKey(a, b, c)))), cells);
  assert.deepEqual(unpackCells(''), []);
  assert.throws(() => unpackCells('@@@@'), /invalid/);
  assert.throws(() => unpackCells('AAAA'), /invalid/, 'not a whole number of cells');
  const big = Array.from({ length: MAX_CELLS + 50 }, (_, i) => [i % 300, Math.floor(i / 300), 0]);
  assert.equal(unpackCells(packCells(big)).length, MAX_CELLS, 'capped');
});

test('reveal: line of sight decides what is explored; the cell you stand in always is', () => {
  const wall = (x, z, cx) => (x < 10) === (cx < 10); // a wall along x = 10
  const seen = revealAround(5, 5, 0, wall, 7);
  const xs = [...seen].map((k) => Number(k.split(',')[0]));
  assert.ok(seen.has(cellKey(2, 2, 0)), 'own cell');
  assert.ok(Math.max(...xs) <= 5, 'only one cell row beyond the wall line is kept (wall edge)');
  const open = revealAround(5, 5, 0, () => true, 7);
  assert.ok(open.size > seen.size);
  assert.ok([...open].some((k) => Number(k.split(',')[0]) >= 6));
  const blind = revealAround(5, 5, 3.2, () => false, 7);
  assert.equal(blind.size, 9, '3×3 around the player when nothing is visible');
  assert.ok([...blind].every((k) => k.endsWith(',6')), 'foot height 3.2 m is stored as iy 6');
  assert.equal(fogged(DUNGEON), true);
  assert.equal(fogged('interior:Daggerfall/Gothway Garden/0,0/10'), true);
  assert.equal(fogged(TOWN), false);
  assert.equal(cleanText('  a‮ b\n\tc  ', 10), 'a b c');
  const idx = cellIndexMap([[1, 1, 0], [1, 1, 8]]);
  assert.equal(isExplored(idx, 2.5, 3.9, 4), true);
  assert.equal(isExplored(idx, 2.5, 3.9, 1.5), true);
  assert.equal(isExplored(idx, 2.5, 3.9, 9), false);
  assert.equal(isExplored(idx, 6, 3, 0), false);
  assert.deepEqual(cellsBounds([[1, 1, 0], [-2, 3, 0]]), { minX: -4, maxX: 4, minZ: 2, maxZ: 8 });
});

test('orientation: a heading-up map puts the facing direction up; transforms stay inverse', () => {
  for (const rotation of [0, Math.PI / 2, -2.3, Math.PI]) {
    const v = makeView({ centerX: 3, centerZ: -4, scale: 5, width: 300, height: 200, rotation });
    const [sx, sy] = worldToScreen(v, 11, 6);
    const [x, z] = screenToWorld(v, sx, sy);
    close(x, 11); close(z, 6);
    const [a, b, c, d, e, f] = viewTransform(v);
    close(a * 11 + c * 6 + e, sx); close(b * 11 + d * 6 + f, sy);
    // Facing the rotation yaw points straight up.
    const [hx, hy] = headingVector(rotation, rotation);
    close(hx, 0); close(hy, -1);
    // A world step in the facing direction moves up the screen.
    const [ux, uy] = worldToScreen(v, 3 + Math.sin(rotation), -4 - Math.cos(rotation));
    close(ux, 150); close(uy, 95);
    // Dragging moves the content with the pointer; zooming keeps the point under the cursor.
    const p = panBy(v, 30, -10);
    const [px, py] = worldToScreen(p, 11, 6);
    close(px, sx + 30); close(py, sy - 10);
    const zz = zoomAt(v, 2, 40, 60);
    const [w0, w1] = screenToWorld(v, 40, 60);
    const [q0, q1] = screenToWorld(zz, 40, 60);
    close(w0, q0); close(w1, q1);
  }
});

test('controller: classic orientation, cutaway and fogged floors and bounds', () => {
  const ctl = createAutomapController({ build: () => ({ kind: 'dungeon', sliced: true, bounds: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 }, floors: [{ index: 0, y: -6 }, { index: 1, y: 0 }, { index: 2, y: 6 }], pieces: [], markers: [{ x: 0, y: 0, z: 0, type: 3, label: 'Exit' }, { x: 300, y: 0, z: 300, type: 1, label: 'Door' }], triangles: 1 }) });
  ctl.setLocation(DUNGEON);
  ctl.setScene({ positions: new Float32Array(9) });
  ctl.ensureMap();
  ctl.setCamera({ x: 1, y: 1.6, z: 1, yaw: Math.PI / 2 });
  assert.equal(ctl.fog, true);
  assert.equal(ctl.floors.length, 0);
  ctl.applyExplored({ location: DUNGEON, cells: packCells([[0, 0, 0], [1, 0, 0], [0, 0, -12]]), full: true });
  assert.deepEqual(ctl.floors.map((f) => f.y), [-6, 0], 'only explored storeys');
  assert.equal(ctl.seen(1, 1, 0), true);
  assert.equal(ctl.seen(300, 300, 0), false, 'a door in unexplored space is not known');
  assert.equal(ctl.applyExplored({ location: DUNGEON, cells: packCells([[1, 0, 0]]) }), false, 'no-op delta');
  ctl.fitAll();
  assert.ok(ctl.view.scale > 10, 'Explored area fits the explored cells, not the whole dungeon');
  assert.match(ctl.describe(), /Explored: about 12 m²/);
  // Cutaway on: upper storeys cut; off: everything.
  assert.ok(Number.isFinite(ctl.slice().top));
  ctl.setCutaway(false);
  assert.equal(ctl.slice().top, Infinity);
  ctl.setCutaway(true);
  // Orientation.
  assert.equal(ctl.orientationText(), 'North up');
  ctl.rotate(1);
  assert.equal(ctl.orientationText(), 'West up', 'turning the map clockwise brings west to the top');
  ctl.rotate(-1); ctl.rotate(-1);
  assert.equal(ctl.orientationText(), 'East up');
  ctl.setOrientation('heading');
  close(ctl.view.rotation, Math.PI / 2);
  const me = ctl.playerMarker();
  close(me.dx, 0); close(me.dy, -1);
  ctl.setCamera({ x: 1, y: 1.6, z: 1, yaw: Math.PI });
  close(ctl.view.rotation, Math.PI, 1e-9);
  ctl.setOrientation('north');
  assert.equal(ctl.view.rotation, 0);
});

test('panel: memory request on arrival, private events applied, external markers and learned names', async () => {
  const sent = [];
  const api = createGameplayApi({ send: (verb, args) => { sent.push([verb, args]); return Promise.resolve({ ok: true, verb }); } });
  const handle = automapFeature.install(api);
  assert.ok(api.getPanel('notebook'), 'notebook panel registered');
  api._receiveRpg({ type: 'rpg', character: { location: TOWN } });
  await Promise.resolve();
  assert.equal(sent.filter(([v]) => v === 'automap.sync').length, 0, 'towns are not fogged');
  api._receiveRpg({ type: 'rpg', character: { location: DUNGEON } });
  assert.deepEqual(sent.at(-1), ['automap.sync', {}]);
  api._receiveRpg({ type: 'rpg', character: { location: DUNGEON, hp: 3 } });
  assert.equal(sent.filter(([v]) => v === 'automap.sync').length, 1, 'once per arrival');
  api.emit('event', { kind: 'automap', location: DUNGEON, cells: packCells([[0, 0, 0]]), full: true });
  assert.equal(handle.controller.cells(DUNGEON).size, 1);
  api.emit('event', { kind: 'automap', location: DUNGEON, cells: packCells([[0, 1, 0]]) });
  assert.equal(handle.controller.cells(DUNGEON).size, 2);
  api.emit('event', { kind: 'automap', location: DUNGEON, cells: 'not base64!' });
  assert.equal(handle.controller.cells(DUNGEON).size, 2, 'malformed data ignored');
  const v = handle.controller.version;
  api.emit('automap:markers', { source: 'magic', location: DUNGEON, markers: [{ kind: 'enemy', id: 'm1', x: 1, y: 0, z: 1 }] });
  assert.ok(handle.controller.version > v);
  // Reconnect: the location event with no previous location asks again.
  api._reset();
  api._receiveRpg({ type: 'rpg', character: { location: DUNGEON } });
  assert.equal(sent.filter(([v]) => v === 'automap.sync').length, 2);
});

// ------------------------------------------------------------------------------------------------ server fixture

function fixture(dbPath, { canSee = (loc, x, z, cx) => (x < 10) === (cx < 10) } = {}) {
  const store = openStore(dbPath);
  const players = new Map();
  const inbox = new Map();
  let clock = 1000;
  const runtime = createRpgRuntime({
    players,
    features: [{ name: 'automap', install: automap }],
    save: (list, world = []) => store.saveCharacters(list, world.map(([k, v]) => [k, typeof v === 'function' ? v() : v])),
    send: (p, msg) => inbox.get(p.id)?.push(JSON.parse(JSON.stringify(msg))),
    worldStore: { load: (prefix) => store.loadWorld(prefix) },
    now: () => clock,
    services: { canSee },
    log: { error() {}, warn() {}, info() {}, log() {} },
  });
  const w = {
    store, runtime, players, inbox,
    join(account, name, at = {}) {
      let row = store.findByAccount(account);
      if (!row) row = store.createForAccount(account, name);
      const p = { id: row.id, name, x: row.x, z: row.z, yaw: 0, moving: false, rpg: row.rpg ?? {} };
      Object.assign(p, at.pos ?? {});
      if (at.location) p.rpg.location = at.location;
      inbox.set(p.id, []);
      players.set(p.id, p);
      runtime.join(p);
      return p;
    },
    leave(p) {
      const list = runtime.leave(p);
      players.delete(p.id);
      store.saveCharacters(list);
    },
    tick(ms = 250) {
      clock += ms;
      runtime.tick(ms / 1000, clock);
    },
    flush() {
      const rows = runtime.takePendingWorld();
      store.saveCharacters([...players.values()], rows.map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
    },
    events(p, kind) { return inbox.get(p.id).filter((m) => m.type === 'gameEvent' && m.event.kind === kind).map((m) => m.event); },
    close() { store.close(); },
  };
  return w;
}

test('server: exploration is revealed by position and sight, private, persisted, and survives a restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-automap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = join(dir, 'game.db');
  let w = fixture(db);
  const a = w.join('acct-a', 'Ava', { location: DUNGEON, pos: { x: 2, z: 2 } });
  const b = w.join('acct-b', 'Bram', { location: DUNGEON, pos: { x: 40, z: 40 } });
  a.rpg.portal = { to: DUNGEON, footY: 0 };
  w.tick();
  const firstA = w.events(a, 'automap');
  assert.equal(firstA.length, 1);
  assert.equal(firstA[0].silent, true);
  const startCells = unpackCells(firstA[0].cells);
  assert.ok(startCells.length > 9);
  assert.ok(startCells.every(([ix]) => ix * CELL < 12), 'nothing past the wall at x = 10 (one boundary row)');
  // B only ever receives B's own memory.
  const bCells = w.events(b, 'automap').flatMap((e) => unpackCells(e.cells));
  assert.ok(bCells.every(([ix, iz]) => ix >= 15 && iz >= 15), 'B gets only cells around B');
  assert.ok(!JSON.stringify(w.inbox.get(b.id)).includes(firstA[0].cells), 'A\'s cells never reach B');
  // Walking reveals more; standing still reveals nothing new.
  a.x = 6; a.z = 9;
  w.tick();
  w.tick();
  const more = w.events(a, 'automap').length;
  assert.equal(more, 2, 'one delta for the move, none for standing still');
  // Upper storey is a separate memory.
  a.rpg.portal.footY = 3.2;
  w.tick();
  const upper = unpackCells(w.events(a, 'automap').at(-1).cells);
  assert.ok(upper.every(([, , iy]) => iy === 6));
  // Notes: only on explored ground; text cleaned; private to A.
  assert.equal(w.runtime.act(a, 'automap.note', { x: 4, z: 4, text: '  Lever‮ room ' }).ok, true);
  const note = a.rpg.automap.notes[DUNGEON][0];
  assert.equal(note.text, 'Lever room');
  assert.equal(note.y, 3, 'pinned to the explored storey nearest the player (upper floor, iy 6)');
  const far = w.runtime.act(a, 'automap.note', { x: 60, z: 4, text: 'beyond the wall' });
  assert.deepEqual(far, { ok: false, error: 'You can only mark places you have explored.' });
  assert.equal(w.runtime.act(a, 'automap.note', { x: 1e9, z: 0, text: 'x' }).ok, false);
  assert.equal(w.runtime.act(a, 'automap.note', { x: 2, z: 2, text: '   ' }).ok, false);
  const peerView = w.runtime.rpgMessage(b);
  assert.ok(!JSON.stringify(peerView).includes('Lever room'), 'notes are not in another player\'s snapshot');
  assert.ok(!JSON.stringify(peerView.peers).includes('automap'));
  // Notebook.
  assert.equal(w.runtime.act(a, 'notebook.write', { text: 'Ask about the Lady at the Pig and Cat.' }).ok, true);
  assert.equal(w.runtime.act(a, 'notebook.write', { text: 'Second entry' }).ok, true);
  const nb = a.rpg.automap.notebook;
  assert.equal(nb.length, 2);
  assert.equal(w.runtime.act(a, 'notebook.erase', { id: nb[1].id }).ok, true);
  assert.equal(a.rpg.automap.notebook.length, 1);
  assert.equal(w.runtime.act(b, 'notebook.erase', { id: nb[0].id }).ok, false, 'B cannot erase A\'s entry');
  const explored = w.runtime.ctx.services.automap.explored(a, DUNGEON);
  // Graceful shutdown: leave saves the character; pending exploration rows are flushed.
  w.flush();
  w.leave(a); w.leave(b);
  w.flush();
  w.close();

  // Cold start on the same database.
  w = fixture(db);
  const a2 = w.join('acct-a', 'Ava', { pos: { x: 2, z: 2 } });
  assert.equal(a2.rpg.location, DUNGEON);
  assert.equal(a2.rpg.automap.notes[DUNGEON][0].text, 'Lever room');
  assert.equal(a2.rpg.automap.notebook[0].text, 'Ask about the Lady at the Pig and Cat.');
  assert.equal(w.runtime.act(a2, 'automap.sync', {}).ok, true);
  const full = w.events(a2, 'automap').find((e) => e.full);
  assert.ok(full);
  assert.ok(unpackCells(full.cells).length >= explored, 'every explored cell came back after the restart');
  const b2 = w.join('acct-b', 'Bram', { pos: { x: 40, z: 40 } });
  assert.equal(w.runtime.act(b2, 'automap.sync', {}).ok, true);
  const bFull = unpackCells(w.events(b2, 'automap').find((e) => e.full).cells);
  assert.ok(bFull.length > 0 && bFull.every(([ix, iz]) => ix >= 15 && iz >= 15), 'B\'s map is B\'s own');
  w.close();
});

test('server: building names are learned by entering; the discovery hook serves conversation and quest owners', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-automap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = fixture(join(dir, 'game.db'));
  const a = w.join('acct-a', 'Ava', { location: TOWN });
  const b = w.join('acct-b', 'Bram', { location: TOWN });
  const discovered = [];
  w.runtime.ctx.on('discovered', (e) => discovered.push({ ...e, player: e.player.id }));
  const svc = w.runtime.ctx.services.automap;
  // Entering through a street door (interiors emits locationChanged inside the portal.use action).
  w.runtime.ctx.emit('locationChanged', { player: a, from: TOWN, to: 'interior:Daggerfall/Gothway Garden/0,0/10', portal: { id: 'b:0,0:10', label: 'The Pig and Cat', kind: 'building' } });
  assert.equal(a.rpg.automap.names[TOWN]['b:0,0:10'], 'The Pig and Cat');
  assert.equal(svc.knows(a, TOWN, 'b:0,0:10'), true);
  assert.equal(svc.knows(b, TOWN, 'b:0,0:10'), false, 'B has not learned it');
  // Directions owner's record also counts.
  b.rpg.learnedPlaces = { [TOWN]: [{ id: 'b:1,0:3', name: 'The Superior Supply Store' }] };
  assert.equal(svc.knows(b, TOWN, 'b:1,0:3'), true);
  // Hook calls inside an action are part of its transaction.
  w.runtime.ctx.onAction('test.quest', (p, args) => {
    svc.learnPlace(p, { town: TOWN, portalId: 'b:2,2:1', label: 'Temple of Arkay' });
    svc.write(p, 'The priest wants a relic.', { source: 'quest' });
    svc.reveal(p, DUNGEON, { x: 100, z: 100, y: 0, radius: 6 });
    if (args.fail) throw new Error('nope');
  });
  assert.equal(w.runtime.act(b, 'test.quest', { fail: true }).ok, false);
  assert.equal(svc.knows(b, TOWN, 'b:2,2:1'), false, 'rolled back with the failed action');
  assert.equal(b.rpg.automap?.notebook?.length ?? 0, 0);
  assert.equal(svc.explored(b, DUNGEON), 0, 'revealed cells rolled back too');
  assert.equal(w.runtime.act(b, 'test.quest', {}).ok, true);
  assert.equal(b.rpg.automap.names[TOWN]['b:2,2:1'], 'Temple of Arkay');
  assert.equal(b.rpg.automap.notebook[0].source, 'quest');
  assert.ok(svc.explored(b, DUNGEON) > 0);
  assert.ok(w.events(b, 'automap').some((e) => e.location === DUNGEON));
  assert.deepEqual(discovered.slice(-2).map((d) => [d.player, d.kind, d.portalId ?? null]), [[b.id, 'place', 'b:2,2:1'], [b.id, 'area', null]]);
  assert.deepEqual(discovered[0], { player: a.id, kind: 'place', location: TOWN, portalId: 'b:0,0:10', label: 'The Pig and Cat' });
  // Bad input to the hook is ignored, never thrown at the caller.
  assert.equal(svc.learnPlace(a, { town: 'not a town', portalId: 'b:0,0:1', label: 'x' }), false);
  assert.equal(svc.learnPlace(a, { town: TOWN, portalId: '../../etc', label: 'x' }), false);
  assert.equal(svc.reveal(a, TOWN, { x: 0, z: 0 }), 0, 'towns are not fogged');
  w.close();
});
