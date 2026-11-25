// Browser spellbook helpers (client/gameplay/magic/*): art decoding, cost estimates that must agree
// with the server, list building and event text. Synthetic bytes; local gamedata/ is optional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  readImageRecords, parsePalette, toRgba, iconPixels, handRects, indexFiles, SpellArtError, CAST_FILES, CAST_SEQUENCE,
} from '../client/gameplay/magic/art.js';
import { magickaCost, spellRows, effectLines, eventText, magicOf } from '../client/gameplay/magic/model.js';
import { loadCatalogue, fallbackSpells } from '../server/rpg/magic/catalogue.js';
import { spellCosts } from '../server/rpg/magic/formulas.js';
import { publicSpell } from '../server/rpg/magic.js';
import { markerBearing } from '../client/gameplay/magic/detection.js';
import { peerCoverage } from '../client/gameplay/magic/concealment.js';

test('detection compass uses camera-relative bearings and clamps targets behind the player', () => {
  const camera = { x: 4, z: 8, yaw: 0 };
  assert.equal(markerBearing(camera, { x: 4, z: 5 }), 0.5);
  assert.equal(markerBearing(camera, { x: 9, z: 8 }), 1);
  assert.equal(markerBearing(camera, { x: 1, z: 8 }), 0);
  assert.equal(markerBearing(camera, { x: 5, z: 9 }), 1);
  assert.equal(markerBearing({ ...camera, yaw: Math.PI / 2 }, { x: 9, z: 8 }), 0.5);
  assert.ok(Math.abs(markerBearing({ ...camera, yaw: Math.PI * 2 }, { x: 4, z: 5 }) - 0.5) < 1e-10);
});

test('peer coverage follows the current movement and concealment combination', () => {
  assert.equal(peerCoverage(undefined, false), 1);
  assert.equal(peerCoverage('invisible', true), 0);
  assert.ok(peerCoverage('chameleon', false) < 1);
  assert.equal(peerCoverage('chameleon', true), 1);
  assert.equal(peerCoverage('shadow', false), 1);
  assert.ok(peerCoverage('shadow', true) < 1);
  assert.equal(peerCoverage('blending', false), peerCoverage('blending', true));
});

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const imgRecord = (w, h, compression, data) => [...u16(0), ...u16(0), ...u16(w), ...u16(h), ...u16(compression), ...u16(data.length), ...data];

test('multi-image CIF records decode raw and RLE frames; corrupt data is refused', () => {
  const raw = imgRecord(2, 2, 0, [1, 2, 3, 4]);
  const rle = imgRecord(3, 2, 2, [0x82, 7, 2, 1, 2, 3]); // run of 3×7 then literal 1,2,3
  const recs = readImageRecords(new Uint8Array([...raw, ...rle]));
  assert.equal(recs.length, 2);
  assert.deepEqual([...recs[0].pixels], [1, 2, 3, 4]);
  assert.deepEqual([...recs[1].pixels], [7, 7, 7, 1, 2, 3]);
  assert.throws(() => readImageRecords(new Uint8Array(imgRecord(2, 2, 0, [1]))), SpellArtError);
  assert.throws(() => readImageRecords(new Uint8Array([...imgRecord(4, 4, 2, [0x82, 1])])), SpellArtError);
  assert.throws(() => readImageRecords(new Uint8Array(imgRecord(2, 2, 0x108, [1, 2, 3, 4]))), /unsupported compression/);
  const pal = new Uint8Array(768).map((_, i) => i % 256);
  const rgba = toRgba(recs[0], pal);
  assert.equal(rgba[3], 255);
  assert.equal(toRgba({ width: 1, height: 1, pixels: new Uint8Array([0]) }, pal)[3], 0, 'index 0 is transparent');
  assert.equal(parsePalette(new Uint8Array(776)).length, 768);
});

test('spell icons are cut from the 320x64 atlas and hands are mirrored at the screen edges', () => {
  const atlas = new Uint8Array(320 * 64);
  atlas[16 * 320 + 3 * 16] = 9; // icon 23 (row 1, column 3), top-left pixel
  assert.equal(iconPixels(atlas, 23).pixels[0], 9);
  assert.throws(() => iconPixels(new Uint8Array(10), 0), SpellArtError);
  const r = handRects(600, 400, { width: 100, height: 80 }, 2, 'shock');
  assert.deepEqual(r.left, { x: 0, y: 240, w: 200, h: 160 });
  assert.equal(r.right.x, 400);
  assert.ok(r.right.mirror);
  const small = handRects(600, 400, { width: 100, height: 80 }, 0, 'shock');
  assert.ok(small.left.x > 0 && small.right.x < 400);
  const narrow = handRects(300, 720, { width: 100, height: 80 }, 2, 'shock');
  assert.deepEqual(narrow.left, { x: 0, y: 640, w: 100, h: 80 });
  assert.deepEqual(CAST_SEQUENCE, [0, 1, 2, 3, 4, 5, 0]);
  const idx = indexFiles([{ name: 'arena2/fire00c6.cif' }]);
  assert.ok(idx.has(CAST_FILES.fire));
});

test('client magicka estimates match the server formula for every spell and skill level', () => {
  const real = 'gamedata/DaggerfallGameFiles/arena2/SPELLS.STD';
  const spells = existsSync(real) ? [...loadCatalogue({ arena2Dir: 'gamedata/DaggerfallGameFiles' }).spells.values()] : fallbackSpells();
  for (const sp of spells) {
    const pub = JSON.parse(JSON.stringify(publicSpell(sp)));
    for (const skill of [0, 23, 50, 77, 100]) {
      const skills = Object.fromEntries(['Alteration', 'Destruction', 'Illusion', 'Mysticism', 'Restoration', 'Thaumaturgy'].map((s) => [s, skill]));
      assert.equal(magickaCost(pub, skills), spellCosts(sp, (s) => skills[s]).magicka, `${sp.name} at ${skill}`);
    }
  }
});

test('spell rows split known and learnable, mark the readied spell and sort castable first', () => {
  const cat = fallbackSpells().map((s) => JSON.parse(JSON.stringify(publicSpell(s))));
  cat.push({ ...cat[0], id: 'x:broken', name: 'Broken', support: 'unsupported', price: 1 });
  const state = { character: { magic: { known: ['ward:mending'], selected: 'ward:mending', active: [] }, character: { skills: { Restoration: 40 }, magicka: 50 } } };
  const { known, learnable } = spellRows(cat, state);
  assert.deepEqual(known.map((s) => s.id), ['ward:mending']);
  assert.ok(known[0].selected);
  assert.equal(learnable.at(-1).id, 'x:broken');
  assert.ok(!learnable.some((s) => s.id === 'ward:mending'));
  assert.equal(spellRows(cat, state, { query: 'ember' }).learnable.length, 1);
  assert.deepEqual(magicOf(null), { known: [], selected: null, active: [], readySpell: null });
  // A trap's free spell (server magic.readySpell) reaches the HUD chip and the V key.
  const ready = { spellId: 'std:37', name: 'Slowfalling', expiresAt: 1 };
  assert.deepEqual(magicOf({ character: { magic: { readySpell: ready } } }).readySpell, ready);
  const lines = effectLines(cat.find((s) => s.id === 'ward:slow-rot').effects[0]);
  assert.match(lines[0], /^Magnitude 1–3 \+ 1 per level$/);
  assert.match(lines[1], /^Duration 3 \+ 1 per level rounds$/);
});

test('event text: no duplicates of server text; targets hear about spells and expiries on them', () => {
  assert.equal(eventText({ kind: 'spellResult', text: 'You cast Heal.' }, 1), null, 'the shell shows event.text itself');
  assert.equal(eventText({ kind: 'spellCast', casterId: 1, targetIds: ['player:1'] }, 1), null);
  assert.equal(eventText({ kind: 'spellCast', casterId: 2, casterName: 'Bo', spellName: 'Heal', targetIds: ['player:1'] }, 1), 'Bo casts Heal on you.');
  assert.equal(eventText({ kind: 'spellCast', casterId: 2, targetIds: ['rat'] }, 1), null);
  assert.equal(eventText({ kind: 'magicEffect', targetId: 'player:1', name: 'Regenerate', sign: 1, amount: 2, pool: 'health' }, 1), 'Regenerate: +2 health.');
  assert.equal(eventText({ kind: 'magicExpired', targetId: 'player:1', spellName: 'Shield' }, 1), 'Shield has worn off.');
});

const ARENA = 'gamedata/DaggerfallGameFiles/arena2';
test('local casting animations and icons decode (local only)', { skip: !existsSync(`${ARENA}/ART_PAL.COL`) && 'no local game data' }, () => {
  for (const name of Object.values(CAST_FILES)) {
    const recs = readImageRecords(readFileSync(`${ARENA}/${name}`), name);
    assert.ok(recs.length >= 6, `${name} has the six cast frames`);
  }
  assert.equal(iconPixels(readFileSync(`${ARENA}/ICON00I0.IMG`), 68).pixels.length, 256);
});
