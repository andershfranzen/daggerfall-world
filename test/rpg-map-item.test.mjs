// Reading an ordinary map item (DaggerfallInventoryWindow.RecordLocationFromMap): both classic templates, current-region
// selection, notebook, consumption, exhausted vs unavailable world data, retries, failed saves, privacy, transfer and
// restart. Runtime cases use a small catalogue fixture; the [asset] case uses the installed MAPS.BSA and TEXT.RSC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../client/gameplay/travel/catalog.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { install as installInventory, templateForClassic, templateForIndex, normalizeRecord as normalizeItem } from '../server/rpg/inventory.js';
import { install as installAutomap } from '../server/rpg/automap.js';
import { loadWorldFromDir } from '../server/rpg/travel/data.js';
import { isMapItem } from '../server/rpg/items/mapItem.js';
import { primaryAction } from '../client/gameplay/inventory/model.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'MAPS.BSA')) && existsSync(join(ARENA2, 'TEXT.RSC'));
const HOME = 'town:Daggerfall/Gothway Garden';
const READ_FAIL = 'You have already discovered the location shown by this map.';
const quiet = { info() {}, warn() {}, error() {} };

/** Daggerfall: Gothway (MAPTABLE-discovered), two unknown places, a "Your Ship" deck; one unknown Wayrest place. */
function fixtureCatalog() {
  return new Catalog([
    { region: 'Daggerfall', regionIndex: 17, index: 197, name: 'Gothway Garden', type: 'hamlet', discovered: true, x: 109, y: 159 },
    { region: 'Daggerfall', regionIndex: 17, index: 10, name: 'Old Barrow', type: 'graveyard', discovered: false, x: 120, y: 150 },
    { region: 'Daggerfall', regionIndex: 17, index: 11, name: 'Ravenwatch Keep', type: 'keep', discovered: false, x: 130, y: 160 },
    { region: 'Daggerfall', regionIndex: 17, index: 12, name: 'Your Ship', type: 'ships', discovered: false, x: 131, y: 161 },
    { region: 'Wayrest', regionIndex: 23, index: 5, name: 'Far Hollow', type: 'ruin', discovered: false, x: 800, y: 200 },
  ], 'files');
}
const fixtureWorld = () => ({ catalog: fixtureCatalog(), climate: null, politic: null });

async function makeWorld({ dataPath = null, loadWorld = async () => fixtureWorld(), saveFails = () => false, random = () => 0 } = {}) {
  const players = new Map();
  const sent = [];
  let travel;
  const runtime = createRpgRuntime({
    players, dataPath, log: quiet,
    save() { if (saveFails()) throw new Error('disk full'); },
    send(p, msg) { sent.push({ to: p.id, msg }); },
    features: [
      (ctx) => { ctx.random = random; installInventory(ctx); },
      (ctx) => { travel = installTravel(ctx, { loadWorld }); },
      (ctx) => installAutomap(ctx),
    ],
  });
  await travel.ready;
  const add = (id, name, rpg = {}) => {
    const p = { id, name, x: 0, z: 0, yaw: 0, rpg: { location: HOME, ...rpg } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const svc = runtime.ctx.services;
  const giveMap = (p, extra = {}) => {
    let it;
    const r = runtime.ctx.runAtomic(p, 'test.seed', () => { it = svc.insertRecord(p, { ...svc.makeItemRecord('map'), ...extra }); });
    assert.equal(r.ok, true, r.error);
    return it;
  };
  const events = (p) => sent.filter((s) => s.to === p.id && s.msg.type === 'gameEvent').map((s) => s.msg.event);
  return { runtime, players, add, svc, giveMap, events, sent, travel };
}
const notes = (p) => (p.rpg.automap?.notebook ?? []).filter((n) => n.source === 'map');

test('both classic map templates resolve to the one map item, new and saved', () => {
  assert.equal(templateForIndex(287), 'map');
  assert.equal(templateForClassic(11, 0), 'map', 'ItemGroups.Maps / Maps.Map');
  assert.equal(templateForClassic(27, 7), 'map', 'ItemGroups.MiscItems / MiscItems.Map');
  assert.ok(isMapItem({ template: 'map', group: 'map', index: 287 }));
  assert.ok(isMapItem({ template: 'something-old', group: 'misc', index: 287, classicGroup: 27 }), 'MiscItems record from an older save');
  assert.ok(!isMapItem({ template: 'parchment', group: 'misc', index: 279 }));
  assert.ok(!isMapItem({ template: 'map', group: 'map', index: 287, magic: { enchantments: [] } }), 'enchanted items stay with their owner');
  const saved = normalizeItem({ id: 'legacy1', template: 'map', quantity: 1 });
  assert.ok(saved && isMapItem(saved), 'a saved {template:"map"} record still normalizes to a map');
  assert.deepEqual(primaryAction({ id: 'm1', group: 'map', template: 'map' }), { verb: 'inventory.use', label: 'Read map', args: { itemId: 'm1' } });
});

test('reading a map reveals an unknown place of the current region, notes it and uses the map up', async () => {
  const w = await makeWorld({ dataPath: '/nonexistent-arena2', random: () => 0.99 });
  const a = w.add(1, 'Ada');
  const b = w.add(2, 'Bo');
  const map = w.giveMap(a);
  const r = w.runtime.act(a, 'inventory.use', { itemId: map.id });
  assert.equal(r.ok, true, r.error);
  assert.ok(!a.rpg.inventory.some((i) => i.id === map.id), 'map consumed');
  const ev = w.events(a).filter((e) => e.kind === 'inventory').at(-1);
  assert.equal(ev.map.outcome, 'revealed');
  assert.equal(ev.map.location, 'town:Daggerfall/Ravenwatch Keep', 'random 0.99 picks the last eligible Daggerfall place');
  assert.match(ev.text, /Ravenwatch Keep/);
  assert.deepEqual(a.rpg.travel.found, { 17: [11] });
  assert.equal(notes(a).length, 1);
  assert.equal(notes(a)[0].text, 'Discovered the location of Ravenwatch Keep after studying a map.');
  // Private: the other character learns nothing and hears nothing.
  assert.deepEqual(b.rpg.travel.found ?? {}, {});
  assert.equal(notes(b).length, 0);
  assert.ok(!w.events(b).some((e) => e.map));
  assert.ok(!w.sent.some((s) => s.to === b.id && s.msg.type === 'rpg' && JSON.stringify(s.msg).includes('Ravenwatch')));
  // Travel now accepts the revealed place for Ada only.
  assert.ok(w.svc.travel.quote(a, 'town:Daggerfall/Ravenwatch Keep'));
  assert.throws(() => w.svc.travel.quote(b, 'town:Daggerfall/Ravenwatch Keep'), /not yet heard/);
});

test('a retried read repeats the answer without a second discovery or note', async () => {
  const w = await makeWorld({ dataPath: '/nonexistent-arena2' });
  const a = w.add(1, 'Ada');
  const map = w.giveMap(a);
  assert.equal(w.runtime.act(a, 'inventory.use', { itemId: map.id }).ok, true);
  const found = JSON.stringify(a.rpg.travel.found);
  const r = w.runtime.act(a, 'inventory.use', { itemId: map.id });
  assert.equal(r.ok, true, r.error);
  const ev = w.events(a).filter((e) => e.kind === 'inventory').at(-1);
  assert.equal(ev.map.repeat, true);
  assert.equal(JSON.stringify(a.rpg.travel.found), found);
  assert.equal(notes(a).length, 1);
});

test('a failed save keeps the map and reveals nothing; the next attempt works once', async () => {
  let fail = false;
  const w = await makeWorld({ dataPath: '/nonexistent-arena2', saveFails: () => fail });
  const a = w.add(1, 'Ada');
  const map = w.giveMap(a);
  fail = true;
  const r = w.runtime.act(a, 'inventory.use', { itemId: map.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not save/);
  assert.ok(a.rpg.inventory.some((i) => i.id === map.id), 'map still carried');
  assert.deepEqual(a.rpg.travel.found ?? {}, {});
  assert.equal(notes(a).length, 0);
  assert.equal(a.rpg.lastMapRead, undefined);
  fail = false;
  assert.equal(w.runtime.act(a, 'inventory.use', { itemId: map.id }).ok, true);
  assert.equal(Object.values(a.rpg.travel.found).flat().length, 1);
  assert.equal(notes(a).length, 1);
});

test('an exhausted region gives the classic refusal and still uses the map; ships and other regions never count', async () => {
  const w = await makeWorld({ dataPath: '/nonexistent-arena2' });
  const a = w.add(1, 'Ada');
  for (let i = 0; i < 2; i++) assert.equal(w.runtime.act(a, 'inventory.use', { itemId: w.giveMap(a).id }).ok, true);
  assert.deepEqual([...a.rpg.travel.found[17]].sort(), [10, 11], 'both unknown Daggerfall places, never the ship deck');
  const third = w.giveMap(a);
  assert.equal(w.runtime.act(a, 'inventory.use', { itemId: third.id }).ok, true);
  const ev = w.events(a).filter((e) => e.kind === 'inventory').at(-1);
  assert.equal(ev.text, READ_FAIL);
  assert.equal(ev.map.outcome, 'exhausted');
  assert.ok(!a.rpg.inventory.some((i) => i.id === third.id), 'classic: the map is used up anyway');
  assert.equal(a.rpg.travel.found[23], undefined, 'Wayrest is another region');
  assert.equal(notes(a).length, 2);
});

test('without the installed world map nothing is revealed and the map is kept', async () => {
  const w = await makeWorld({ dataPath: null }); // starter catalogue only
  const a = w.add(1, 'Ada');
  const map = w.giveMap(a);
  const r = w.runtime.act(a, 'inventory.use', { itemId: map.id });
  assert.equal(r.ok, false);
  assert.match(r.error, /no world map/);
  assert.ok(a.rpg.inventory.some((i) => i.id === map.id));
  // A broken MAPS.BSA read behaves the same.
  const broken = await makeWorld({ dataPath: '/nonexistent-arena2', loadWorld: async () => { throw new Error('bad file'); } });
  const c = broken.add(3, 'Cy');
  const m2 = broken.giveMap(c);
  assert.equal(broken.runtime.act(c, 'inventory.use', { itemId: m2.id }).ok, false);
  assert.ok(c.rpg.inventory.some((i) => i.id === m2.id));
});

test('a map passed to another character is read by its new owner only; discoveries survive a restart', async () => {
  const w = await makeWorld({ dataPath: '/nonexistent-arena2' });
  const a = w.add(1, 'Ada');
  const b = w.add(2, 'Bo');
  const map = w.giveMap(a);
  assert.equal(w.runtime.act(a, 'inventory.drop', { itemId: map.id }).ok, true);
  const pile = [...w.runtime.ctx.entities.values()].find((e) => e.kind === 'loot');
  assert.ok(pile, 'dropped pile');
  assert.equal(w.runtime.act(b, 'inventory.loot', { targetId: pile.id }).ok, true);
  const carried = b.rpg.inventory.find((i) => isMapItem(i));
  assert.ok(carried, 'Bo carries the map');
  const refused = w.runtime.act(a, 'inventory.use', { itemId: carried.id });
  assert.equal(refused.ok, false, 'the previous owner cannot read it');
  assert.match(refused.error, /do not have/);
  assert.equal(w.runtime.act(b, 'inventory.use', { itemId: carried.id }).ok, true);
  assert.equal(Object.values(b.rpg.travel.found).flat().length, 1);
  assert.deepEqual(a.rpg.travel.found ?? {}, {});
  // Restart: a new server process with the saved rows.
  const saved = JSON.parse(JSON.stringify(b.rpg));
  const w2 = await makeWorld({ dataPath: '/nonexistent-arena2' });
  const b2 = w2.add(2, 'Bo', saved);
  assert.deepEqual(b2.rpg.travel.found, saved.travel.found);
  assert.equal(notes(b2).length, 1);
  assert.equal(w2.runtime.act(b2, 'inventory.use', { itemId: carried.id }).ok, true, 'restarted retry repeats');
  assert.equal(Object.values(b2.rpg.travel.found).flat().length, 1);
});

test('[asset] installed data: a map read in Daggerfall reveals an unknown Daggerfall place with TEXT.RSC 499 wording', { skip: hasData ? false : 'local Daggerfall data not present' }, async () => {
  const world = await loadWorldFromDir(ARENA2);
  const dir = mkdtempSync(join(tmpdir(), 'dfw-map-'));
  try {
    const w = await makeWorld({ dataPath: ARENA2, loadWorld: async () => world, random: () => 0.5 });
    const a = w.add(1, 'Ada');
    const before = world.catalog.locations.filter((e) => e.regionIndex === 17 && !e.discovered).length;
    assert.ok(before > 0);
    const map = w.giveMap(a);
    assert.equal(w.runtime.act(a, 'inventory.use', { itemId: map.id }).ok, true);
    const ev = w.events(a).filter((e) => e.kind === 'inventory').at(-1);
    const entry = w.svc.travel.lookup(ev.map.location);
    assert.equal(entry.region, 'Daggerfall');
    assert.equal(entry.discovered, false);
    assert.match(ev.text, /^(The scrap of parchment shows the location of|A finely drawn vellum reveals the secret location of|A freshly drawn map indicates the long lost location of)/);
    assert.ok(ev.text.includes(entry.name.trim()));
    assert.ok(w.svc.travel.quote(a, entry.id), 'the revealed place is a valid journey');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
