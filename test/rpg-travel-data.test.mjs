// Travel against the local Daggerfall install (gamedata/, never committed).
// Skips when the data is absent. Synthetic coverage: rpg-travel.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { loadWorldFromDir, indexDataDir } from '../server/rpg/travel/data.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { CLASSIC_STARTERS } from '../client/gameplay/travel/classic.js';
import { quoteJourney } from '../client/gameplay/travel/journey.js';
import { DOT_PALETTE_INDEX, REGION_NAMES } from '../client/gameplay/travel/catalog.js';
import { MapImages, OVERVIEW_IMG, PICKER_IMG, REGION_MAP_ORIGIN, regionMapNames, regionMapFor } from '../client/gameplay/travel/mapimages.js';
import { loadTown } from '../client/world/town.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'MAPS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';

let world;
before(async () => {
  if (hasData) world = await loadWorldFromDir(ARENA2);
});

test('catalogue covers the Iliac Bay', { skip }, () => {
  const c = world.catalog;
  assert.ok(c.size > 15000, `${c.size} locations`);
  assert.ok(c.regions.length >= 44);
  const types = new Set(c.locations.map((l) => l.type));
  for (const t of ['city', 'hamlet', 'village', 'temple', 'tavern', 'labyrinth', 'farm']) assert.ok(types.has(t), t);
  assert.ok(c.locations.every((l) => l.x >= 0 && l.x < 1000 && l.y >= 0 && l.y < 500), 'map pixels in range');
  assert.ok(c.locations.every((l) => l.type in DOT_PALETTE_INDEX || l.type === 'ships'), 'every type has a dot colour');
});

test('locations sit in their own region on POLITIC.PAK', { skip }, () => {
  let same = 0;
  for (const l of world.catalog.locations) if (world.politic.atMapPixel(l.x, l.y) - 128 === l.regionIndex) same++;
  assert.ok(same / world.catalog.size > 0.97, `${same}/${world.catalog.size}`);
});

test('classic starters match the original data exactly', { skip }, () => {
  for (const s of CLASSIC_STARTERS) {
    const l = world.catalog.get(s.id);
    assert.ok(l, s.id);
    assert.equal(l.id, s.id);
    assert.deepEqual([l.x, l.y, l.type, l.regionIndex], [s.x, s.y, s.type, s.regionIndex], s.id);
    assert.equal(l.discovered, true, `${s.id} is known from the start`);
  }
});

test('search finds places by name', { skip }, () => {
  const r = world.catalog.search('wayrest', { limit: 5 });
  assert.equal(r[0].id, 'town:Wayrest/Wayrest');
  assert.ok(world.catalog.search('gothway').some((l) => l.id === 'town:Daggerfall/Gothway Garden'));
  assert.equal(world.catalog.search('gothway garden')[0].id, 'town:Daggerfall/Gothway Garden');
  assert.equal(world.catalog.get('TOWN:daggerfall/GOTHWAY GARDEN').id, 'town:Daggerfall/Gothway Garden');
});

test('journey Gothway Garden to Daggerfall and across the bay to Sentinel', { skip }, () => {
  const c = world.catalog;
  const climateAt = (x, y) => world.climate.atMapPixel(x, y);
  const from = c.get('town:Daggerfall/Gothway Garden');
  const near = quoteJourney(from, c.get('town:Daggerfall/Daggerfall'), { speed: 'reckless', lodging: 'camp' }, { climateAt });
  assert.equal(near.steps, 98);
  assert.equal(near.oceanPixels, 0);
  assert.ok(near.days >= 3 && near.days <= 6, `${near.days} days`);
  const far = quoteJourney(from, c.get('town:Sentinel/Sentinel'), { speed: 'cautious', lodging: 'inn', ship: true }, { climateAt });
  assert.ok(far.oceanPixels > 0, 'crosses the Iliac Bay');
  assert.ok(far.cost.passage > 0 && far.cost.inn >= 5);
  const walk = quoteJourney(from, c.get('town:Sentinel/Sentinel'), { speed: 'cautious', lodging: 'inn', ship: false }, { climateAt });
  assert.ok(far.minutes < walk.minutes, 'sailing is faster than wading');
});

test('nearly every place has a dot on one of its region maps', { skip }, () => {
  const off = world.catalog.locations.filter((l) => regionMapFor(l.regionIndex, l.x, l.y) < 0);
  // Classic data has three High Rock sea coast entries outside any region map picture.
  assert.ok(off.length <= 3, off.map((l) => l.id).join(', '));
});

test('server feature validates against the operator files', { skip }, async () => {
  const players = new Map();
  let api;
  const runtime = createRpgRuntime({
    players, save() {}, send() {}, dataPath: ARENA2, log: { info() {}, warn() {}, error() {} },
    features: [(ctx) => { api = installTravel(ctx); }],
  });
  await api.ready;
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, rpg: { gold: 500 } };
  players.set(1, p);
  runtime.join(p);
  assert.equal(p.rpg.travel.server, 'files');
  assert.deepEqual(runtime.act(p, 'travel.go', { to: 'town:Wayrest/Merwark Hollow', options: { lodging: 'camp' } }), { ok: true });
  assert.equal(p.rpg.location, 'town:Wayrest/Merwark Hollow');
  assert.ok(p.rpg.travel.lastTrip.days > 10);
});

test('map pictures decode and line up', { skip }, async () => {
  const index = new Map();
  const names = [OVERVIEW_IMG, PICKER_IMG, 'FMAP_PAL.COL', 'ART_PAL.COL', ...Object.keys(REGION_MAP_ORIGIN)];
  for (const n of names) if (existsSync(join(ARENA2, n))) index.set(n, new File([await openAsBlob(join(ARENA2, n))], n));
  const imgs = new MapImages(index);
  const ov = await imgs.image(OVERVIEW_IMG);
  assert.deepEqual([ov.width, ov.height, ov.rgba.length], [320, 200, 320 * 200 * 4]);
  const pick = await imgs.image(PICKER_IMG);
  const regionsOnPicker = new Set([...pick.indices].filter((v) => v >= 128 && v < 255).map((v) => v - 128));
  assert.ok(regionsOnPicker.has(17) && regionsOnPicker.has(23), 'Daggerfall and Wayrest are clickable');
  for (const v of regionsOnPicker) assert.ok(v < REGION_NAMES.length, `picker region ${v}`);
  const fm = await imgs.image('FMAP0I17.IMG');
  assert.deepEqual([fm.width, fm.height], [320, 160]);
  // Every known region town lands on one of its region's map screens.
  for (const id of ['town:Daggerfall/Gothway Garden', 'town:Wayrest/Wayrest', "town:Alik'r Desert/Alik'ra", 'town:Dragontail Mountains/Dragontail']) {
    const l = world.catalog.get(id);
    assert.ok(regionMapFor(l.regionIndex, l.x, l.y) >= 0, `${id} on ${regionMapNames(l.regionIndex)}`);
  }
});

test('a travel destination builds as an original exterior', { skip, timeout: 120000 }, async () => {
  const files = [];
  for (const f of (await import('node:fs')).readdirSync(ARENA2)) {
    if (/^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3})$/i.test(f)) {
      files.push(new File([await openAsBlob(join(ARENA2, f))], f));
    }
  }
  const l = world.catalog.get('town:Wayrest/Merwark Hollow');
  const town = await loadTown(files, { region: l.region, location: l.name });
  assert.equal(town.name, l.name);
  assert.equal(town.source.region, l.region);
  assert.ok(town.positions.length > 1000);
});

test('server data index is case-insensitive and limited to travel files', { skip }, async () => {
  const idx = await indexDataDir(ARENA2);
  assert.deepEqual([...idx.keys()].sort(), ['CLIMATE.PAK', 'MAPS.BSA', 'POLITIC.PAK']);
});
