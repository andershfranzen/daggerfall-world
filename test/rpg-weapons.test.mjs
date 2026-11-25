// First-person weapon view: CIF reader bounds, animation tables, drag gestures,
// placement, and File-based loading. Synthetic bytes only; the optional real-file
// test reads the operator's local gamedata/ and is skipped when it is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { WeaponCif, CifError, decodeRle, parsePalette, toRgba, MAX_WEAPON_RECORDS } from '../client/gameplay/weapons/cifReader.js';
import {
  WeaponAnimator, classifyDrag, normalizeDirection, weaponSetForItem, weaponFile, weaponAnims,
  rightHandItem, weaponQuad, ALIGN, NATIVE_H, SET, BOW_ANIMS, MAGIC_BATTLEAXE_ANIMS,
} from '../client/gameplay/weapons/animation.js';
import { indexFiles, loadWeaponArt, weaponSpec } from '../client/gameplay/weapons.js';
import {
  meleeFrameTime, bowCooldownTime, metalTable, dyeBitmap, METAL_TABLES, BOW_DRAWN_HOLD_FRAME, MAX_BOW_HELD_DRAWN_SECONDS,
} from '../client/gameplay/weapons/animation.js';

// ---------------------------------------------------------------- synthetic files

const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];

/** Literal-only RLE for a run of indices (chunks of ≤128). */
function rleLiteral(pixels) {
  const out = [];
  for (let i = 0; i < pixels.length; i += 128) {
    const chunk = pixels.slice(i, i + 128);
    out.push(chunk.length - 1, ...chunk);
  }
  return out;
}

/** Held record: uncompressed IMG header + pixels. */
function heldRecord(w, h, fill) {
  const px = new Array(w * h).fill(fill);
  return [...u16(0), ...u16(0), ...u16(w), ...u16(h), ...u16(0), ...u16(px.length), ...px];
}

/** Animation record with `frames` frames, each filled with index base+f. */
function animRecord(w, h, frames, base = 10) {
  const header = 12 + 62 + 2;
  const bodies = [];
  const offsets = [];
  let at = header;
  for (let f = 0; f < frames; f++) {
    const body = rleLiteral(new Array(w * h).fill(base + f));
    offsets.push(at);
    bodies.push(body);
    at += body.length;
  }
  const list = [];
  for (let i = 0; i < 31; i++) list.push(...u16(offsets[i] ?? 0));
  return [...u16(w), ...u16(h), ...u16(w), ...u16(0), ...u16(0), ...u16(0), ...list, ...u16(at), ...bodies.flat()];
}

function weaponBytes({ held = true, records = 6, frames = 5, w = 6, h = 4 } = {}) {
  const parts = held ? heldRecord(8, 5, 3) : [];
  for (let r = 0; r < records; r++) parts.push(...animRecord(w, h, frames, 10 + r * 10));
  return new Uint8Array(parts);
}

const palette = () => {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { p[i * 3] = i; p[i * 3 + 1] = 255 - i; p[i * 3 + 2] = 7; }
  return p;
};

// ---------------------------------------------------------------- reader

test('synthetic WEAPON04.CIF: held record then six 5-frame records', () => {
  const cif = new WeaponCif(weaponBytes(), 'weapon04.cif');
  assert.equal(cif.recordCount, 7);
  assert.deepEqual(cif.size(0), { width: 8, height: 5 });
  assert.equal(cif.frameCount(0), 1);
  for (let r = 1; r <= 6; r++) {
    assert.equal(cif.frameCount(r), 5);
    assert.deepEqual(cif.size(r), { width: 6, height: 4 });
  }
  assert.ok(cif.frame(0, 0).data.every((v) => v === 3));
  const f = cif.frame(2, 3);
  assert.equal(f.data.length, 24);
  assert.ok(f.data.every((v) => v === 20 + 3));
  assert.equal(cif.frame(2, 3), f, 'frames are cached');
});

test('WEAPON09.CIF (bow) has no held record', () => {
  const cif = new WeaponCif(weaponBytes({ held: false, records: 1, frames: 7 }), 'WEAPON09.CIF');
  assert.equal(cif.recordCount, 1);
  assert.equal(cif.frameCount(0), 7);
});

test('reader rejects malformed input without reading out of bounds', () => {
  const good = weaponBytes();
  assert.throws(() => new WeaponCif(good, 'FACES.CIF'), CifError);
  assert.throws(() => new WeaponCif(new Uint8Array(0), 'WEAPON04.CIF'), CifError);
  assert.throws(() => new WeaponCif(good.slice(0, 30), 'WEAPON04.CIF'), CifError, 'truncated');
  assert.throws(() => new WeaponCif(good.slice(0, good.length - 1), 'WEAPON04.CIF'), CifError, 'last record short');

  // Oversized held image.
  const big = good.slice();
  big[4] = 0xff; big[5] = 0x7f;
  assert.throws(() => new WeaponCif(big, 'WEAPON04.CIF'), /invalid image size/);

  // TotalSize 0 never advances the head: refused, not an infinite loop.
  const zero = new Uint8Array(animRecord(2, 2, 1));
  zero[74] = 0; zero[75] = 0;
  assert.throws(() => new WeaponCif(zero, 'WEAPON09.CIF'), CifError);

  // Frame offset past its record.
  const off = new Uint8Array(animRecord(2, 2, 1));
  off[12] = 0xff; off[13] = 0x00;
  assert.throws(() => new WeaponCif(off, 'WEAPON09.CIF'), /frame offset/);

  // Record cap.
  const many = new Uint8Array(Array.from({ length: MAX_WEAPON_RECORDS + 1 }, () => animRecord(1, 1, 1)).flat());
  assert.throws(() => new WeaponCif(many, 'WEAPON09.CIF'), /too many records/);

  // Truncated RLE inside a valid-looking record.
  const rec = animRecord(4, 4, 1);
  rec[74] = 78; rec[75] = 0; // totalSize: header + 2 bytes
  const cut = new Uint8Array(rec.slice(0, 78));
  const cif = new WeaponCif(cut, 'WEAPON09.CIF');
  assert.throws(() => cif.frame(0, 0), /ends early/);
  assert.throws(() => cif.frame(0, 1), CifError);
  assert.throws(() => cif.frame(5, 0), CifError);
});

test('RLE runs and literals stop at the destination length', () => {
  const dst = new Uint8Array(5);
  const end = decodeRle(new Uint8Array([130, 9, 1, 4, 5, 99]), 0, dst);
  assert.deepEqual([...dst], [9, 9, 9, 4, 5]);
  assert.equal(end, 5);
  const small = new Uint8Array(2);
  decodeRle(new Uint8Array([200, 1]), 0, small); // a 73-pixel run into 2 bytes
  assert.deepEqual([...small], [1, 1]);
});

test('palette parsing and RGBA with index 0 transparent', () => {
  const col = new Uint8Array(776);
  col[8 + 3] = 50;
  assert.equal(parsePalette(col)[3], 50);
  assert.equal(parsePalette(new Uint8Array(768)).length, 768);
  assert.throws(() => parsePalette(new Uint8Array(10)), CifError);
  const rgba = toRgba({ width: 2, height: 1, data: new Uint8Array([0, 5]) }, palette());
  assert.deepEqual([...rgba], [0, 0, 0, 0, 5, 250, 7, 255]);
});

// ---------------------------------------------------------------- tables and gestures

test('items map to classic animation sets and files', () => {
  assert.equal(weaponSetForItem(null), SET.Melee);
  assert.equal(weaponSetForItem({ template: 'iron-longsword', name: 'Iron Longsword' }), SET.LongBlade);
  assert.equal(weaponSetForItem({ template: 'steel-dai-katana' }), SET.LongBlade);
  assert.equal(weaponSetForItem({ template: 'long-bow' }), SET.Bow);
  assert.equal(weaponSetForItem({ template: 'elven-war-axe' }), SET.Battleaxe);
  assert.equal(weaponSetForItem({ template: 'dwarven-warhammer' }), SET.Warhammer);
  assert.equal(weaponSetForItem({ template: 'kite-shield' }), null);
  assert.equal(weaponFile(SET.LongBlade), 'WEAPON04.CIF');
  assert.equal(weaponFile(SET.LongBlade, true), 'WEAPO104.CIF');
  assert.equal(weaponFile(SET.Bow, true), 'WEAPON09.CIF');
  assert.equal(weaponFile(SET.Melee), 'WEAPON10.CIF');
  assert.equal(weaponAnims(SET.Battleaxe, true), MAGIC_BATTLEAXE_ANIMS);
  const rpg = { equipment: { rightHand: 'i2' }, inventory: [{ id: 'i1' }, { id: 'i2', template: 'iron-dagger' }] };
  assert.equal(rightHandItem(rpg).template, 'iron-dagger');
  assert.equal(rightHandItem({ equipment: {}, inventory: [] }), null);
});

test('drag classification follows the classic radial sectors and threshold', () => {
  const L = 1000;
  assert.equal(classifyDrag(10, 0, 10, L), null, 'below 5% of the longest side');
  assert.equal(classifyDrag(100, 0, 100, L), 'right');
  assert.equal(classifyDrag(-100, 0, 100, L), 'left');
  assert.equal(classifyDrag(0, -100, 100, L), 'up'); // screen y up
  assert.equal(classifyDrag(70, -70, 100, L), 'up', 'up-right folds into up');
  assert.equal(classifyDrag(0, 100, 100, L), 'down');
  assert.equal(classifyDrag(-70, 70, 100, L), 'downLeft');
  assert.equal(classifyDrag(70, 70, 100, L), 'downRight');
  assert.equal(normalizeDirection('StrikeDownLeft'), 'downLeft');
  assert.equal(normalizeDirection('down-right'), 'downRight');
  assert.equal(normalizeDirection('sideways'), null);
  assert.equal(normalizeDirection(7), null);
});

test('melee animator: classic frame time, queued follow-up, idle', () => {
  const t = meleeFrameTime(50);
  assert.ok(Math.abs(t - 195 / 980) < 1e-12, 'GetMeleeWeaponAnimTime at Speed 50');
  assert.ok(meleeFrameTime(100) < meleeFrameTime(0));
  const a = new WeaponAnimator(SET.LongBlade);
  assert.equal(a.current().record, 0);
  assert.equal(a.strike('nonsense'), false);
  assert.equal(a.strike('downLeft'), true);
  assert.equal(a.current().record, 2);
  assert.equal(a.strike('right'), false, 'mid-swing strike does not interrupt');
  const events = [];
  for (let i = 0; i < 4; i++) events.push(...a.update(t + 1e-6, 50));
  assert.equal(a.frame, 4);
  assert.deepEqual(events, ['hit']);
  assert.deepEqual(a.update(t + 1e-6, 50), ['done']);
  assert.equal(a.state, 'Idle');
  a.update(0.01, 50); // queued swing starts on the next idle step
  assert.equal(a.state, 'StrikeRight');
  assert.equal(a.current().anim.Alignment, ALIGN.Left, 'right strike is left-aligned in GENERAL_ANIMS');
  assert.equal(a.queued, null);

  const one = new WeaponAnimator(SET.Mace);
  one.strike('up');
  one.update(5, 50); // a long frame steps once, never skips the swing
  assert.equal(one.frame, 1);

  const fists = new WeaponAnimator(SET.Melee);
  fists.strike('left');
  const seen = [];
  const hits = [];
  for (let i = 0; i < 8; i++) { hits.push(...fists.update(t + 1e-6, 50)); seen.push(fists.frame); }
  assert.deepEqual(seen, [1, 2, 3, 4, 2, 1, 0, 0]);
  assert.equal(hits.filter((k) => k === 'hit').length, 1, 'second visit to frame 2 is not a second hit');
  assert.equal(fists.state, 'Idle');
});

test('bow animator: draw, hold, single release, hidden cooldown, let-down', () => {
  const tick = 0.0625 + 1e-6;
  const classic = new WeaponAnimator(SET.Bow);
  assert.equal(classic.frame, BOW_DRAWN_HOLD_FRAME, 'BowDrawback off rests drawn');
  assert.equal(classic.release(), true, 'instant shot from idle');
  const ev = [];
  for (let i = 0; i < 3; i++) ev.push(...classic.update(tick));
  assert.deepEqual(ev, ['bowSound', 'hit']);
  assert.deepEqual(classic.update(tick), ['done']);
  assert.equal(classic.visible, false, 'hidden while cooling down');
  assert.equal(classic.draw(), false);
  assert.equal(classic.release(), false, 'no second arrow during cooldown');
  for (let t = 0; t < bowCooldownTime(50) + 0.05; t += 0.1) classic.update(0.1);
  assert.equal(classic.visible, true);

  const bow = new WeaponAnimator(SET.Bow, false, { bowDrawback: true });
  assert.equal(bow.frame, 0);
  assert.equal(bow.draw(), true);
  assert.equal(bow.current().anim, BOW_ANIMS[6]);
  for (let i = 0; i < 10; i++) bow.update(tick);
  assert.equal(bow.frame, BOW_DRAWN_HOLD_FRAME, 'holds fully drawn');
  assert.equal(bow.state, 'StrikeUp');
  assert.equal(bow.strike('right'), true, 'any non-up direction looses');
  assert.equal(bow.state, 'StrikeDown');
  assert.equal(bow.frame, BOW_DRAWN_HOLD_FRAME, 'release keeps the drawn frame');
  assert.equal(bow.release(), false, 'one release per draw');
  for (let i = 0; i < 4; i++) bow.update(tick);
  assert.equal(bow.state, 'Idle');
  assert.ok(bow.cooldown > 1.3 && bow.cooldown < 1.4, 'GetBowCooldownTime at Speed 50');

  const held = new WeaponAnimator(SET.Bow, false, { bowDrawback: true });
  held.draw();
  let undrawn = false;
  for (let t = 0; t < MAX_BOW_HELD_DRAWN_SECONDS + 1; t += 0.5) if (held.update(0.5).includes('undraw')) undrawn = true;
  assert.ok(undrawn);
  assert.equal(held.state, 'Idle');
  assert.ok(held.cooldown > 0, 'a let-down draw pays the cooldown');
});

test('metal dyes remap only the 0x70-0x7F band, steel unchanged', () => {
  assert.equal(metalTable('steel'), null);
  assert.equal(metalTable(null), null);
  assert.equal(metalTable('leather'), null);
  assert.equal(metalTable('Daedric'), METAL_TABLES.daedric);
  assert.equal(metalTable(0), METAL_TABLES.iron);
  for (const t of Object.values(METAL_TABLES)) assert.equal(t.length, 16);
  const bmp = { width: 4, height: 1, data: new Uint8Array([0, 0x6f, 0x70, 0x7f]) };
  const out = dyeBitmap(bmp, METAL_TABLES.daedric);
  assert.deepEqual([...out.data], [0, 0x6f, 0xef, 0xfe]);
  assert.deepEqual([...bmp.data], [0, 0x6f, 0x70, 0x7f], 'source untouched');
  assert.equal(dyeBitmap(bmp, null), bmp);
  assert.deepEqual([...dyeBitmap(bmp, METAL_TABLES.iron).data], [0, 0x6f, 0x77, 0x5f]);
});

test('weaponSpec reads readied state, equipment and weaponView', () => {
  const sword = { id: 'a', template: 'elven-longsword', weaponType: 'LongBlade', material: 'elven' };
  assert.equal(weaponSpec({ readied: false, inventory: [sword], equipment: { rightHand: 'a' } }), null);
  assert.deepEqual(weaponSpec({ readied: true, inventory: [sword], equipment: { rightHand: 'a' } }),
    { set: 'LongBlade', enchanted: false, material: 'elven', fileName: 'WEAPON04.CIF' });
  assert.deepEqual(weaponSpec({ readied: true, inventory: [], equipment: {}, weaponView: { itemId: null, template: 'unarmed', weaponType: 'Melee' } }),
    { set: 'Melee', enchanted: false, material: null, fileName: 'WEAPON10.CIF' });
  assert.equal(weaponSpec({ readied: true, inventory: [], equipment: {}, weaponView: { itemId: 'x', template: 'long-bow', weaponType: 'Bow', material: 'iron' } }).fileName, 'WEAPON09.CIF');
  assert.deepEqual(weaponSpec({ readied: true, inventory: [sword], equipment: { rightHand: 'a' }, conditions: { lycanthrope: { form: 'werewolf', transformed: true } } }),
    { set: SET.Werecreature, enchanted: false, material: null, fileName: 'WEAPON11.CIF' });
});

test('placement is bottom-anchored with classic aspect and alignment', () => {
  const idle = weaponAnims(SET.LongBlade)[0];
  const q = weaponQuad(1600, 900, { width: 60, height: 86 }, idle);
  assert.equal(q.h, 86 * (900 / NATIVE_H));
  assert.ok(Math.abs(q.w / q.h - (60 / 86) * (5 / 6)) < 1e-9, '4:3 classic pixel aspect kept');
  assert.equal(q.y + q.h, 900);
  assert.ok(Math.abs(q.x + q.w - 1600) < 1e-9, 'right-aligned to the edge');
  const center = weaponQuad(1600, 900, { width: 100, height: 50 }, weaponAnims(SET.Melee)[1]);
  assert.ok(Math.abs(center.x + center.w / 2 - 800) < 1e-9);
  const stretch = weaponQuad(640, 400, { width: 60, height: 86 }, idle, { aspect: 'stretch' });
  assert.equal(stretch.w, 120);
  const dagger = weaponQuad(1000, 750, { width: 40, height: 40 }, weaponAnims(SET.Dagger)[0]);
  assert.ok(Math.abs(dagger.x + dagger.w - 960) < 1e-9, 'idle offset 0.04');
});

// ---------------------------------------------------------------- File loading

test('loads from File objects by case-insensitive basename and reports missing files', async () => {
  const files = [
    new File([weaponBytes()], 'weapon04.cif'),
    new File([new Uint8Array(776)], 'Art_Pal.col'),
  ];
  const map = indexFiles(files);
  assert.ok(map.has('WEAPON04.CIF') && map.has('ART_PAL.COL'));
  const { cif, palette: pal } = await loadWeaponArt(map, 'WEAPON04.CIF');
  assert.equal(cif.recordCount, 7);
  assert.equal(pal.length, 768);
  await assert.rejects(loadWeaponArt(map, 'WEAPON09.CIF'), /WEAPON09\.CIF not found/);
  await assert.rejects(loadWeaponArt(indexFiles([files[0]]), 'WEAPON04.CIF'), /ART_PAL\.COL not found/);
  await assert.rejects(loadWeaponArt(indexFiles([new File([new Uint8Array(5)], 'WEAPON04.CIF'), files[1]]), 'WEAPON04.CIF'), CifError);
});

// ---------------------------------------------------------------- operator's local files (optional)

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url);
const haveData = existsSync(new URL('WEAPON04.CIF', ARENA2)) && existsSync(new URL('ART_PAL.COL', ARENA2));

test('local WEAPON*.CIF files decode in full', { skip: !haveData && 'no local gamedata' }, async () => {
  const read = (n) => new File([readFileSync(new URL(n, ARENA2))], n);
  const map = indexFiles(['WEAPON04.CIF', 'WEAPON09.CIF', 'ART_PAL.COL'].map(read));
  const sword = (await loadWeaponArt(map, 'WEAPON04.CIF')).cif;
  assert.equal(sword.recordCount, 7);
  assert.deepEqual(sword.size(0), { width: 60, height: 86 });
  for (let r = 1; r <= 6; r++) assert.equal(sword.frameCount(r), 5);
  const bow = (await loadWeaponArt(map, 'WEAPON09.CIF')).cif;
  assert.equal(bow.recordCount, 1);
  assert.equal(bow.frameCount(0), 7);
  // Every other supplied weapon file decodes every frame without error.
  for (const n of ['WEAPON01', 'WEAPON02', 'WEAPON05', 'WEAPON06', 'WEAPON07', 'WEAPON08', 'WEAPON10', 'WEAPON11',
    'WEAPO101', 'WEAPO102', 'WEAPO104', 'WEAPO105', 'WEAPO106', 'WEAPO107', 'WEAPO108']) {
    const url = new URL(`${n}.CIF`, ARENA2);
    if (!existsSync(url)) continue;
    const cif = new WeaponCif(new Uint8Array(readFileSync(url)), `${n}.CIF`);
    for (let r = 0; r < cif.recordCount; r++) {
      for (let f = 0; f < cif.frameCount(r); f++) assert.equal(cif.frame(r, f).data.length, cif.size(r).width * cif.size(r).height);
    }
  }
});
