// Character head portraits: FACE??I0.CIF mapping and decoding (DOM-free).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { faceSource, decodeFace, requiredFiles, FACE_FRAME, FACE_COUNT, parsePalette } from '../client/gameplay/character/portraits.js';
import { dollFiles } from '../client/gameplay/inventory/images.js';
import { portraitScale, portraitAvailable, setPortraitFiles, loadFace } from '../client/gameplay/character/art.js';
import { RACES } from '../client/gameplay/character/rules.js';

const ARENA2 = path.resolve('gamedata/DaggerfallGameFiles/arena2');
const haveGameFiles = fs.existsSync(path.join(ARENA2, 'FACE00I0.CIF')) && fs.existsSync(path.join(ARENA2, 'ART_PAL.COL'));

// RaceTemplate.cs PaperDollHeadsMale / PaperDollHeadsFemale.
const EXPECTED = {
  Breton: ['FACE00I0.CIF', 'FACE10I0.CIF'],
  Redguard: ['FACE01I0.CIF', 'FACE11I0.CIF'],
  Nord: ['FACE02I0.CIF', 'FACE12I0.CIF'],
  'Dark Elf': ['FACE03I0.CIF', 'FACE13I0.CIF'],
  'High Elf': ['FACE04I0.CIF', 'FACE14I0.CIF'],
  'Wood Elf': ['FACE05I0.CIF', 'FACE15I0.CIF'],
  Khajiit: ['FACE06I0.CIF', 'FACE16I0.CIF'],
  Argonian: ['FACE07I0.CIF', 'FACE17I0.CIF'],
};

test('every playable race and gender maps to the Daggerfall Unity head file; record = face index', () => {
  assert.deepEqual(RACES.map((r) => r.name).sort(), Object.keys(EXPECTED).sort());
  for (const [race, [male, female]] of Object.entries(EXPECTED)) {
    for (let i = 0; i < FACE_COUNT; i++) {
      assert.deepEqual(faceSource({ race, gender: 'Male', faceIndex: i }), { file: male, record: i });
      assert.deepEqual(faceSource({ race, gender: 'Female', faceIndex: i }), { file: female, record: i });
      // Same head the inventory paper doll draws.
      assert.equal(dollFiles({ race, gender: 'Female', faceIndex: i }).heads, female);
    }
  }
  assert.equal(faceSource({ race: 'Orc', gender: 'Male', faceIndex: 0 }), null);
  assert.equal(faceSource({ race: 'Nord', gender: 'Male', faceIndex: 10 }), null);
  assert.equal(faceSource({ race: 'Nord', gender: 'Male', faceIndex: -1 }), null);
  assert.equal(requiredFiles().length, 17);
});

function cif(records) {
  const parts = [];
  for (const r of records) {
    const h = new DataView(new ArrayBuffer(12));
    h.setInt16(0, r.x, true); h.setInt16(2, r.y, true); h.setInt16(4, r.w, true); h.setInt16(6, r.h, true);
    h.setUint16(8, 0, true); h.setUint16(10, r.w * r.h, true);
    parts.push(new Uint8Array(h.buffer), Uint8Array.from(r.px));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const PAL = new Uint8Array(768);
for (let i = 0; i < 256; i++) { PAL[i * 3] = i; PAL[i * 3 + 1] = 255 - i; PAL[i * 3 + 2] = 7; }

test('decodeFace places the record by its paper-doll offset, palette-maps it and keeps index 0 transparent', () => {
  const bytes = cif([
    { x: 240, y: 20, w: 2, h: 2, px: [0, 5, 6, 7] },
    { x: 250, y: 30, w: 1, h: 1, px: [9] },
  ]);
  const f = decodeFace(bytes, 0, PAL);
  assert.equal(f.width, FACE_FRAME.width);
  assert.equal(f.height, FACE_FRAME.height);
  const at = (x, y) => Array.from(f.rgba.subarray((y * f.width + x) * 4, (y * f.width + x) * 4 + 4));
  const ox = 240 - FACE_FRAME.x; const oy = 20 - FACE_FRAME.y;
  assert.deepEqual(at(ox, oy), [0, 0, 0, 0], 'index 0 transparent');
  assert.deepEqual(at(ox + 1, oy), [5, 250, 7, 255]);
  assert.deepEqual(at(ox + 1, oy + 1), [7, 248, 7, 255]);
  assert.deepEqual(decodeFace(bytes, 1, PAL).source, { width: 1, height: 1, offsetX: 250, offsetY: 30 });
  assert.throws(() => decodeFace(bytes, 2, PAL));
});

test('records outside the frame are centred rather than clipped', () => {
  const f = decodeFace(cif([{ x: 0, y: 0, w: 2, h: 2, px: [1, 1, 1, 1] }]), 0, PAL);
  const x = 19; const y = 27;
  assert.equal(f.rgba[(y * f.width + x) * 4 + 3], 255);
  assert.equal(f.rgba[3], 0);
});

test('portraits scale by whole pixels and report missing files', async () => {
  assert.equal(portraitScale(40), 1);
  assert.equal(portraitScale(56), 2);
  assert.equal(portraitScale(112), 3);
  setPortraitFiles(null);
  assert.equal(portraitAvailable({ race: 'Nord', gender: 'Male', faceIndex: 0 }), false);
  assert.equal(await loadFace({ race: 'Nord', gender: 'Male', faceIndex: 0 }), null);
  setPortraitFiles([new File([new Uint8Array(776)], 'ART_PAL.COL')]);
  assert.equal(portraitAvailable({ race: 'Nord', gender: 'Male', faceIndex: 0 }), false, 'head file missing');
  setPortraitFiles([new File([new Uint8Array(776)], 'ART_PAL.COL'), new File([new Uint8Array(3)], 'face02i0.cif')]);
  assert.equal(portraitAvailable({ race: 'Nord', gender: 'Male', faceIndex: 0 }), true, 'case-insensitive');
  assert.equal(await loadFace({ race: 'Nord', gender: 'Male', faceIndex: 0 }), null, 'unreadable file is unavailable');
  setPortraitFiles(null);
});

test('real game files: all 160 player heads decode with visible pixels', { skip: !haveGameFiles && 'local ARENA2 not present' }, async () => {
  const pal = parsePalette(new Uint8Array(fs.readFileSync(path.join(ARENA2, 'ART_PAL.COL'))));
  for (const [race, files] of Object.entries(EXPECTED)) {
    for (const file of files) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(ARENA2, file)));
      for (let i = 0; i < FACE_COUNT; i++) {
        const f = decodeFace(bytes, i, pal);
        const { offsetX, offsetY, width, height } = f.source;
        assert.ok(offsetX >= FACE_FRAME.x && offsetX + width <= FACE_FRAME.x + FACE_FRAME.width, `${race} ${file}#${i} x fits`);
        assert.ok(offsetY >= FACE_FRAME.y && offsetY + height <= FACE_FRAME.y + FACE_FRAME.height, `${race} ${file}#${i} y fits`);
        let opaque = 0;
        for (let p = 3; p < f.rgba.length; p += 4) opaque += f.rgba[p] === 255;
        assert.ok(opaque > width * height * 0.3, `${file}#${i} has visible pixels`);
      }
    }
  }
  const files = requiredFiles().map((n) => new File([fs.readFileSync(path.join(ARENA2, n))], n));
  setPortraitFiles(files);
  const face = await loadFace({ race: 'Argonian', gender: 'Female', faceIndex: 9 });
  assert.equal(face?.width, FACE_FRAME.width);
  setPortraitFiles(null);
});
