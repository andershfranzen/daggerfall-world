// loadScenery against the local Daggerfall install (gamedata/, never committed).
// Skips when the data is absent. Synthetic checks: rpg-scenery.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadTown } from '../client/world/town.js';
import { loadScenery } from '../client/world/scenery/index.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const hasData = existsSync(join(ARENA2, 'MAPS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';
const NEEDED = /^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3}|SKY\d\d\.DAT|WOODS\.WLD)$/i;

let files, town;
before(async () => {
  if (!hasData) return;
  files = [];
  for (const n of readdirSync(ARENA2)) if (NEEDED.test(n)) files.push(new File([await openAsBlob(join(ARENA2, n))], n));
  town = await loadTown(files);
});

test('Gothway Garden: RMB flats, climate sky and WOODS.WLD surroundings', { skip }, async () => {
  const s = await loadScenery(files, town);
  assert.deepEqual(s.warnings, []);
  // Counts below are what the local files contain; they are data facts, not tuning.
  assert.equal(s.stats.townFlats, 328);
  assert.equal(s.stats.skippedEditor, 6);
  assert.equal(s.stats.droppedFlats, 0);
  assert.equal(s.stats.natureArchive, 504); // Woodlands (231) → TEXTURE.504
  assert.equal(s.stats.kinds['scenery:nature'], 195);
  assert.equal(s.stats.kinds['misc:light'], 40);
  assert.equal(s.sky.file, 'SKY18.DAT'); // SkyBase 16 + summer (2)
  assert.equal(s.sky.width, 1024);
  assert.ok(s.terrain && s.terrain.stats.heightmap);
  assert.ok(s.stats.terrainFlats > 1000);
  // Flats sit between the ground and the rooftops (some hang on walls); most stand on the ground.
  const v = s.billboards.vertices;
  let grounded = 0, inTown = 0;
  for (let i = 0; i < s.billboards.count; i += 6) {
    const o = i * 10;
    const x = v[o], y = v[o + 1], z = v[o + 2];
    if (x < s.townRect.minX || x > s.townRect.maxX || z < s.townRect.minZ || z > s.townRect.maxZ) continue;
    assert.ok(y > -1 && y < town.bounds.maxY, `flat ${i / 6} base at ${y}`);
    grounded += Math.abs(y) < 0.5 ? 1 : 0; inTown++;
  }
  assert.ok(grounded / inTown > 0.9, `${grounded}/${inTown} flats on the ground`);
  // Deterministic: a second load gives the same placements.
  const again = await loadScenery(files, town);
  assert.deepEqual(again.billboards.vertices, s.billboards.vertices);
});

test('optional files absent: flat sky and flat apron fall back with warnings', { skip }, async () => {
  const some = files.filter((f) => !/^(SKY\d\d\.DAT|WOODS\.WLD|TEXTURE\.201)$/i.test(f.name));
  const s = await loadScenery(some, town);
  assert.equal(s.sky, null);
  assert.equal(s.terrain.stats.heightmap, false);
  assert.equal(s.stats.droppedFlats, 33); // the animals in TEXTURE.201
  assert.ok(s.warnings.some((w) => /SKY18\.DAT/.test(w)));
  assert.ok(s.warnings.some((w) => /WOODS\.WLD/.test(w)));
  assert.ok(s.warnings.some((w) => /TEXTURE\.201/.test(w)));
  await assert.rejects(loadScenery(files.filter((f) => f.name !== 'BLOCKS.BSA'), town), /BLOCKS\.BSA/);
});
