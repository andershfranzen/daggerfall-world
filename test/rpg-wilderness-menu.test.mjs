// Wilderness panel view model (client/gameplay/wildernessMap.js). DOM-free; synthetic snapshots
// shaped like docs/wilderness-protocol.md. The site names are test fixtures, not pack data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWildernessId, bearing, distanceText, kindLabel, townName, wildernessView, actionErrorText, install, PANEL_ID, PANEL_KEY,
} from '../client/gameplay/wildernessMap.js';

test('location ids and town names', () => {
  assert.deepEqual(parseWildernessId('wilderness:207,213'), { px: 207, py: 213 });
  assert.equal(parseWildernessId('town:Daggerfall/Gothway Garden'), null);
  assert.equal(parseWildernessId(null), null);
  assert.equal(townName('town:Daggerfall/Gothway Garden'), 'Gothway Garden');
  assert.equal(townName('wilderness:1,2'), null);
});

test('bearing uses map pixels with y growing south', () => {
  const o = { px: 100, py: 100 };
  assert.equal(bearing(o, { px: 100, py: 90 }).name, 'north');
  assert.equal(bearing(o, { px: 110, py: 100 }).name, 'east');
  assert.equal(bearing(o, { px: 100, py: 110 }).short, 'S');
  assert.equal(bearing(o, { px: 90, py: 90 }).name, 'north-west');
  assert.equal(bearing(o, { px: 105, py: 95 }).arrow, '↗');
  assert.equal(bearing(o, o), null);
});

test('site ids carry within-pixel position; bearings use it', async () => {
  const { sitePosition } = await import('../client/gameplay/wildernessMap.js');
  assert.deepEqual(sitePosition('wod:109,160:64,64'), { px: 109.5, py: 160.5 });
  assert.deepEqual(sitePosition('wod:109,158:21,21#2'), { px: 109 + 21 / 128, py: 159 - 21 / 128 });
  // Same pixel as the origin, but near the north edge (terrain y grows north): bearing is north.
  const v = wildernessView(town({ pack: 'ready', origin: { px: 109, py: 159 },
    nearby: [{ id: 'wod:109,159:64,120', name: 'Edge Camp', kind: 'camp', px: 109, py: 159, distance: 0.44 }] }));
  assert.equal(v.nearby[0].bearing.name, 'north');
});

test('distance and kind labels', () => {
  assert.equal(distanceText(0), 'here');
  assert.equal(distanceText(0.66), '600 yards');
  assert.equal(distanceText(0.01), 'here');
  assert.equal(distanceText(4), '2 miles');
  assert.equal(distanceText(30), '15 miles');
  assert.equal(distanceText(null), '');
  assert.equal(kindLabel('bandit_camp'), 'Bandit camp');
  assert.equal(kindLabel('RUINS'), 'Ruin');
  assert.equal(kindLabel('standing-stones'), 'Standing stones');
  assert.equal(kindLabel(undefined), 'Site');
});

const town = (wilderness, location = 'town:Daggerfall/Gothway Garden') => ({ character: { location, wilderness, travel: { lastTown: 'town:Daggerfall/Gothway Garden' } } });

test('view: nearest first, computed bearings, nameless records dropped', () => {
  const v = wildernessView(town({
    pack: 'ready', origin: { px: 200, py: 200, region: 'Daggerfall' }, returnTo: 'town:Daggerfall/Gothway Garden',
    nearby: [
      { id: 'wilderness:203,200', name: 'Far Camp', kind: 'camp', px: 203, py: 200, region: 'Daggerfall' },
      { id: 'wilderness:200,199', name: 'Near Shrine', kind: 'shrine', region: 'Daggerfall' },
      { id: 'wilderness:9,9', kind: 'camp' },
      { name: 'no id' },
    ],
  }));
  assert.equal(v.pack, 'ready');
  assert.equal(v.atSite, false);
  assert.deepEqual(v.nearby.map((s) => s.name), ['Near Shrine', 'Far Camp']);
  assert.equal(v.nearby[0].bearing.name, 'north');
  assert.equal(v.nearby[1].bearing.name, 'east');
  assert.equal(v.nearby[1].distance, 3);
  assert.equal(v.region, 'Daggerfall');
  assert.equal(v.returnName, 'Gothway Garden');
});

test('view: at a site (protocol wod: ids), return target and current site', () => {
  const v = wildernessView(town({
    pack: 'ready', site: 'wod:203,200:64,64', returnTo: 'town:Daggerfall/Gothway Garden', origin: { px: 203, py: 200 }, radius: 6,
    discovered: ['wod:203,200:64,64'],
    nearby: [{ id: 'wod:203,200:64,64', name: 'Far Camp', kind: 'camp', px: 203, py: 200, distance: 0 },
      { id: 'wod:204,200:64,64', name: 'Next Ruin', kind: 'ruin', px: 204, py: 200, distance: 1, discovered: false }],
  }, 'wilderness:203,200'));
  assert.equal(v.atSite, true);
  assert.equal(v.inWilds, true);
  assert.equal(v.radius, 6);
  assert.equal(v.nearby[0].discovered, true);
  assert.equal(v.nearby[1].discovered, false);
  assert.equal(v.here.name, 'Far Camp');
  assert.equal(v.returnName, 'Gothway Garden');
  assert.equal(v.nearby.find((s) => s.name === 'Next Ruin').bearing.name, 'east');
});

test('view: walked overland onto a pixel with no visited site', () => {
  const v = wildernessView(town({ pack: 'ready', site: null, returnTo: null, origin: { px: 5, py: 6 }, nearby: [] }, 'wilderness:5,6'));
  assert.equal(v.atSite, false);
  assert.equal(v.inWilds, true);
  assert.deepEqual(v.pixel, { px: 5, py: 6 });
  assert.equal(kindLabel('logging'), 'Logging camp');
});

test('view: missing pack, unknown server, metres', () => {
  assert.equal(wildernessView(town({ pack: 'missing', packNote: 'Operator has not installed it.' })).pack, 'missing');
  assert.equal(wildernessView(town({ available: false })).pack, 'missing');
  assert.equal(wildernessView(town(undefined)).pack, 'unknown');
  const v = wildernessView(town({ pack: 'ready', nearby: [{ id: 's1', name: 'A', distance: 1638.4, distanceUnit: 'metres' }] }));
  assert.equal(v.nearby[0].distance, 2);
  assert.equal(v.listKnown, true);
  assert.equal(wildernessView(town({ pack: 'ready' })).listKnown, false);
});

test('readable action errors', () => {
  assert.match(actionErrorText('unknown site', 'wilderness.visit'), /no longer on the list/);
  assert.match(actionErrorText('stale route'), /refreshed/);
  assert.match(actionErrorText('site too far'), /too far/);
  assert.match(actionErrorText('pack unavailable'), /not available/);
  assert.equal(actionErrorText('the gate is barred'), 'The gate is barred.');
  assert.match(actionErrorText('', 'wilderness.leave'), /return to town/);
});

// ---------------------------------------------------------------- install with a fake api

function fakeApi(state) {
  const listeners = new Map();
  const sent = [];
  const api = {
    state, location: state.character.location, panels: new Map(), refreshed: 0, opened: [],
    on(n, fn) { (listeners.get(n) ?? listeners.set(n, new Set()).get(n)).add(fn); },
    emit(n, d) { for (const fn of listeners.get(n) ?? []) fn(d); },
    registerPanel(id, title, render, opts) { api.panels.set(id, { id, title, render, ...opts }); return true; },
    refreshPanel() { api.refreshed++; },
    closePanel() { api.closed = (api.closed ?? 0) + 1; api.panel = null; },
    openPanel(id) { api.opened.push(id); },
    act(verb, args) { sent.push({ verb, args }); return Promise.resolve(api.reply?.(verb, args) ?? { ok: true, verb }); },
  };
  return { api, sent };
}

test('install registers a keyed panel and sends visit / leave', async () => {
  const state = town({ pack: 'ready', origin: { px: 200, py: 200 }, returnTo: 'town:Daggerfall/Gothway Garden',
    nearby: [{ id: 'wilderness:201,200', name: 'Test Camp', kind: 'camp' }] });
  const { api, sent } = fakeApi(state);
  const ctl = install(api);
  const p = api.panels.get(PANEL_ID);
  assert.equal(p.key, PANEL_KEY);
  assert.equal(typeof p.watch, 'function');
  assert.notEqual(JSON.stringify(p.watch(state)), JSON.stringify(p.watch(town({ pack: 'missing' }))));

  const site = ctl.view().nearby[0];
  ctl.visit(site);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[0], { verb: 'wilderness.visit', args: { site: 'wilderness:201,200' } });

  // Arrival clears the pending action.
  api.state = town({ pack: 'ready', site: 'wilderness:201,200', returnTo: 'town:Daggerfall/Gothway Garden', nearby: [] }, 'wilderness:201,200');
  api.location = 'wilderness:201,200';
  api.panel = PANEL_ID;
  api.emit('event', { kind: 'wilderness', text: 'You arrive.' }); // event before the snapshot
  assert.equal(api.closed, undefined);
  api.emit('state', api.state);
  assert.equal(api.closed, 1, 'menu closes once the character is really there');
  ctl.leave();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[1], { verb: 'wilderness.leave', args: {} });
});

test('use selects the nearest unsearched wilderness treasure unless another target has focus', () => {
  const location = 'wilderness:201,200';
  const { api, sent } = fakeApi(town({ looted: ['site/1'] }, location));
  const treasure = [1, 3, 7].map((x, i) => ({ x, z: 0, site: 'site', object: i + 1 }));
  api.camera = { x: 0, z: 0 };
  api.wilderness = { scene: { location, wilderness: { treasure } } };
  install(api);
  api.emit('interactIntent', { entity: { id: 'enemy' } });
  api.emit('interactIntent', { handled: true });
  const intent = {};
  api.emit('interactIntent', intent);
  assert.equal(intent.handled, true);
  assert.deepEqual(sent, [{ verb: 'wilderness.loot', args: { site: 'site', object: 2 } }]);
  api.camera.x = 20;
  api.emit('interactIntent', {});
  assert.equal(sent.length, 1);
});

test('stale selection is refused locally and server stale errors are readable', async () => {
  const state = town({ pack: 'ready', origin: { px: 200, py: 200 }, nearby: [{ id: 'wilderness:201,200', name: 'Test Camp' }] });
  const { api, sent } = fakeApi(state);
  const ctl = install(api);
  ctl.visit({ id: 'wilderness:999,999', name: 'Gone Place' });
  assert.equal(sent.length, 0);
  api.reply = () => ({ ok: false, error: 'unknown site' });
  ctl.visit(ctl.view().nearby[0]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((x) => x.verb), ['wilderness.visit', 'wilderness.nearby']);
});

test('without a nearby list in the snapshot the panel asks wilderness.nearby once', async () => {
  const state = town({ pack: 'ready' });
  const { api, sent } = fakeApi(state);
  api.reply = (verb) => (verb === 'wilderness.nearby' ? { ok: true, origin: { px: 10, py: 10 }, nearby: [{ id: 'wilderness:10,9', name: 'North Stone', kind: 'landmark' }] } : { ok: true });
  const ctl = install(api);
  // render() needs a DOM; exercise the fetch through a minimal document stub instead.
  const doc = globalThis.document;
  globalThis.document = { createElement: () => new Proxy({ append() {}, setAttribute() {}, addEventListener() {}, replaceChildren() {}, dataset: {} }, { set: () => true, get: (t, k) => t[k] ?? (() => {}) }) };
  globalThis.Node = class {};
  try {
    const container = { replaceChildren() {} };
    api.panels.get(PANEL_ID).render(container);
    api.panels.get(PANEL_ID).render(container);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.filter((s) => s.verb === 'wilderness.nearby').length, 1);
    assert.equal(ctl.view().nearby[0].name, 'North Stone');
    assert.equal(ctl.view().nearby[0].bearing.name, 'north');
  } finally {
    globalThis.document = doc;
    delete globalThis.Node;
  }
});
