// Actor sprites: synthetic regression tests (no game data needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpriteArchive, recordWorldSize, indicesToRgba } from '../client/gameplay/actors/spriteArchive.js';
import { packFrames, buildAtlas, SpriteLibrary } from '../client/gameplay/actors/library.js';
import {
  entityAppearance, peerAppearance, facingIndex, animRecord, frameAt, AnimState, isDead, hasLoot, DYING_SECONDS,
} from '../client/gameplay/actors/logic.js';
import { Occluder } from '../client/gameplay/actors/occlusion.js';
import { billboardCorners, SpritePass } from '../client/gameplay/actors/spritePass.js';
import { ActorController, describeTarget, install } from '../client/gameplay/actors.js';
import { Renderer } from '../client/render/renderer.js';
import { createGameplayApi } from '../client/gameplay/api.js';

// ------------------------------------------------------------ synthetic TEXTURE.nnn

/**
 * records: [{ width, height, frames: [Uint8Array(width*height)], codec: 'multi'|'single'|'rle', scale }]
 */
function buildTexture(records) {
  const chunks = [];
  const headerSize = 26 + records.length * 20;
  let pos = headerSize;
  const recPos = [];
  for (const r of records) {
    recPos.push(pos);
    const body = encodeRecord(r);
    chunks.push(body);
    pos += body.length;
  }
  const out = new Uint8Array(pos);
  const v = new DataView(out.buffer);
  v.setInt16(0, records.length, true);
  records.forEach((r, i) => v.setInt32(26 + i * 20 + 2, recPos[i], true));
  let p = headerSize;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function encodeRecord({ width, height, frames, codec = frames.length > 1 ? 'multi' : 'single', scale = 0 }) {
  const H = 28;
  let data;
  let compression = 0;
  if (codec === 'single') {
    data = new Uint8Array((height - 1) * 256 + width);
    for (let y = 0; y < height; y++) data.set(frames[0].subarray(y * width, (y + 1) * width), y * 256);
  } else if (codec === 'multi') {
    const encoded = frames.map((f) => {
      const bytes = [width & 255, width >> 8, height & 255, height >> 8];
      for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
          let skip = 0;
          while (x + skip < width && f[y * width + x + skip] === 0 && skip < 255) skip++;
          let run = 0;
          while (x + skip + run < width && f[y * width + x + skip + run] !== 0 && run < 255) run++;
          bytes.push(skip, run);
          for (let i = 0; i < run; i++) bytes.push(f[y * width + x + skip + i]);
          x += skip + run;
        }
      }
      return Uint8Array.from(bytes);
    });
    const table = frames.length * 4;
    data = new Uint8Array(table + encoded.reduce((s, e) => s + e.length, 0));
    const dv = new DataView(data.buffer);
    let o = table;
    encoded.forEach((e, i) => { dv.setInt32(i * 4, o, true); data.set(e, o); o += e.length; });
  } else {
    // RecordRle: per-frame row headers (offset from record start, encoding), rows RLE-coded.
    compression = 0x1108;
    const rowHeaders = frames.length * height * 4;
    const rows = [];
    for (const f of frames) {
      for (let y = 0; y < height; y++) {
        const row = f.subarray(y * width, (y + 1) * width);
        const b = [width & 255, width >> 8];
        let x = 0;
        while (x < width) {
          let n = 1;
          while (x + n < width && row[x + n] === row[x] && n < 100) n++;
          if (n >= 2) {
            const probe = -n & 0xffff;
            b.push(probe & 255, probe >> 8, row[x]);
            x += n;
          } else {
            let m = 1;
            while (x + m < width && row[x + m] !== row[x + m - 1] && m < 100) m++;
            b.push(m & 255, m >> 8, ...row.subarray(x, x + m));
            x += m;
          }
        }
        rows.push(Uint8Array.from(b));
      }
    }
    data = new Uint8Array(rowHeaders + rows.reduce((s, r) => s + r.length, 0));
    const dv = new DataView(data.buffer);
    let o = rowHeaders;
    rows.forEach((r, i) => {
      dv.setInt16(i * 4, H + o, true); // relative to record position
      dv.setUint16(i * 4 + 2, 0x8000, true);
      data.set(r, o);
      o += r.length;
    });
  }
  const out = new Uint8Array(H + data.length);
  const v = new DataView(out.buffer);
  v.setInt16(4, width, true);
  v.setInt16(6, height, true);
  v.setInt16(8, compression, true);
  v.setUint32(10, out.length, true);
  v.setUint32(14, H, true);
  v.setUint16(20, frames.length, true);
  v.setInt16(24, scale, true);
  v.setInt16(26, scale, true);
  out.set(data, H);
  return out;
}

const pattern = (w, h, seed) => {
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = ((i * 7 + seed * 13) % 5 === 0) ? 0 : 1 + ((i + seed) % 200);
  return a;
};

test('SpriteArchive decodes every frame of multi-frame, single-frame and RLE records', () => {
  const recs = [
    { width: 9, height: 7, frames: [pattern(9, 7, 1), pattern(9, 7, 2), pattern(9, 7, 3)], codec: 'multi', scale: -128 },
    { width: 5, height: 4, frames: [pattern(5, 4, 4)], codec: 'single' },
    { width: 6, height: 5, frames: [pattern(6, 5, 5), pattern(6, 5, 6)], codec: 'rle', scale: -70 },
  ];
  const s = new SpriteArchive(buildTexture(recs), 270);
  assert.equal(s.recordCount, 3);
  recs.forEach((r, ri) => {
    assert.equal(s.frameCount(ri), r.frames.length);
    r.frames.forEach((f, fi) => assert.deepEqual(s.frame(ri, fi).data, f, `record ${ri} frame ${fi}`));
  });
  assert.equal(s.frame(0, 1), s.frame(0, 1), 'frames are cached');
  assert.throws(() => s.frame(0, 3), /no frame 3/);
  assert.throws(() => s.frame(9, 0), /does not exist/);
});

test('SpriteArchive rejects malformed archives with clear errors', () => {
  assert.throws(() => new SpriteArchive(new Uint8Array(10), 300), /too short/);
  const bad = buildTexture([{ width: 4, height: 4, frames: [pattern(4, 4, 1)] }]);
  new DataView(bad.buffer).setInt32(26 + 2, 1e6, true);
  assert.throws(() => new SpriteArchive(bad, 300), /out of range/);
  const trunc = buildTexture([{ width: 8, height: 8, frames: [pattern(8, 8, 1), pattern(8, 8, 2)] }]);
  const s = new SpriteArchive(trunc.subarray(0, trunc.length - 20), 300);
  assert.throws(() => s.frame(0, 1), /out of range/);
});

test('record world size follows the classic scale rule (size + size*scale/256) at 1/40 m per unit', () => {
  assert.deepEqual(recordWorldSize(52, 110, -70, -70), { width: (52 - 14) * 0.025, height: (110 - 30) * 0.025 });
  const s = recordWorldSize(65, 67, -128, -128);
  assert.ok(Math.abs(s.width - 0.825) < 1e-9 && Math.abs(s.height - 0.85) < 1e-9);
  assert.deepEqual(recordWorldSize(10, 20, 0, 0), { width: 0.25, height: 0.5 });
});

test('indicesToRgba keeps index 0 transparent and mirrors when flipped', () => {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i, 255 - i, 7], i * 3);
  const img = { width: 3, height: 1, data: Uint8Array.from([0, 5, 9]) };
  assert.deepEqual([...indicesToRgba(img, pal)], [0, 0, 0, 0, 5, 250, 7, 255, 9, 246, 7, 255]);
  assert.deepEqual([...indicesToRgba(img, pal, { flip: true })], [9, 246, 7, 255, 5, 250, 7, 255, 0, 0, 0, 0]);
});

test('atlas packing places every frame without overlap', () => {
  const sizes = Array.from({ length: 40 }, (_, i) => ({ w: 20 + (i * 13) % 60, h: 30 + (i * 29) % 90 }));
  const p = packFrames(sizes);
  assert.ok(p.width <= 4096 && p.height <= 4096);
  const boxes = sizes.map((s, i) => ({ ...p.places[i], ...s }));
  for (const b of boxes) assert.ok(b.x + b.w <= p.width && b.y + b.h <= p.height);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${i} overlaps ${j}`);
  }
  const s = new SpriteArchive(buildTexture([{ width: 4, height: 3, frames: [pattern(4, 3, 1), pattern(4, 3, 2)] }]), 300);
  const pal = new Uint8Array(768).fill(200);
  const atlas = buildAtlas(s, pal);
  const r = atlas.rects[0][1];
  const firstOpaque = s.frame(0, 1).data.findIndex((x) => x !== 0);
  const ax = r.x + (firstOpaque % 4), ay = r.y + Math.floor(firstOpaque / 4);
  assert.equal(atlas.pixels[(ay * atlas.width + ax) * 4 + 3], 255);
});

// ------------------------------------------------------------ appearance

test('creatures, humanoid classes, NPC variants and guards resolve to the classic archives', () => {
  assert.equal(entityAppearance({ id: 'r1', kind: 'monster', name: 'Rat' }).archive, 255);
  const skel = entityAppearance({ id: 's', kind: 'monster', mobileType: 15 });
  assert.equal(skel.archive, 270);
  assert.equal(skel.layout, 'enemy');
  assert.deepEqual(skel.corpse, [306, 1]);
  assert.equal(entityAppearance({ id: 'm', kind: 'monster', mobileType: 'Spellsword', gender: 'female' }).archive, 475);
  assert.equal(entityAppearance({ id: 'm', kind: 'monster', mobileType: 129, gender: 'male' }).archive, 476);
  // explicit sprite reference wins and its archive picks the layout
  const lich = entityAppearance({ id: 'x', kind: 'monster', sprite: { archive: 288, record: 0 } });
  assert.equal(lich.archive, 288);
  assert.equal(lich.layout, 'enemy');
  // NPCs: guard role, race/gender sets, stable per-id variants
  assert.equal(entityAppearance({ id: 'g', kind: 'npc', role: 'guard' }).archive, 399);
  const a = entityAppearance({ id: 'npc-1', kind: 'npc', race: 'redguard', gender: 'female' });
  assert.ok([395, 396, 397, 398].includes(a.archive));
  assert.equal(a.layout, 'person');
  assert.equal(entityAppearance({ id: 'npc-1', kind: 'npc', race: 'redguard', gender: 'female' }).archive, a.archive);
  assert.equal(entityAppearance({ id: 'n', kind: 'npc', race: 'nord', gender: 'male', variant: 2 }).archive, 389);
  assert.ok([385, 386, 391, 394].includes(entityAppearance({ id: 'n', kind: 'npc', race: 'Khajiit', gender: 'male' }).archive));
  const variants = new Set(Array.from({ length: 40 }, (_, i) => entityAppearance({ id: `t${i}`, kind: 'npc', gender: 'm' }).archive));
  assert.ok(variants.size >= 3, 'ids spread over the variant set');
  // loot and flats
  const loot = entityAppearance({ id: 'l', kind: 'loot' });
  assert.equal(loot.archive, 216);
  assert.equal(loot.layout, 'flat');
  assert.equal(entityAppearance({ id: 'f', kind: 'npc', sprite: { archive: 182, record: 3 } }).layout, 'flat');
  assert.equal(entityAppearance({ id: '?', kind: 'monster', name: 'Unknown Thing' }), null);
});

test('remote players: civilian walker when sheathed, class archive when readied', () => {
  const calm = peerAppearance({ id: 7, name: 'Ana', race: 'Breton', gender: 'female', readied: false });
  assert.ok([453, 454, 455, 456].includes(calm.archive));
  assert.equal(calm.layout, 'person');
  const ready = peerAppearance({ id: 7, name: 'Ana', gender: 'female', className: 'Spellsword', readied: true });
  assert.equal(ready.archive, 475);
  assert.equal(ready.layout, 'enemy');
  assert.equal(peerAppearance({ id: 8, readied: true, gender: 'male' }).archive, 488, 'unknown class falls back to Warrior');
  assert.equal(peerAppearance({ id: 8, readied: true, gender: 'male', className: 'Knight' }).archive, 488);
  assert.equal(peerAppearance({ id: 8, readied: true, gender: 'male', className: 'Nightblade' }).archive, 490);
  assert.equal(peerAppearance({ id: 8, form: 'werewolf', readied: false }).archive, 264);
  assert.equal(peerAppearance({ id: 8, form: 'wereboar', readied: true }).archive, 269);
});

// ------------------------------------------------------------ facing and records

test('facing index: front, sides and back relative to the viewer', () => {
  // Actor at origin facing north (-z, yaw 0).
  assert.equal(facingIndex(0, 0, 0, 0, -5), 0, 'viewer in front');
  assert.equal(facingIndex(0, 0, 0, 0, 5), 4, 'viewer behind');
  assert.equal(facingIndex(0, 0, 0, -5, 0), 2, 'viewer on actor left sees it face their left');
  assert.equal(facingIndex(0, 0, 0, 5, 0), 6, 'viewer on actor right');
  assert.equal(facingIndex(0, 0, 0, -5, -5), 1);
  assert.equal(facingIndex(0, 0, 0, 5, -5), 7);
  // Rotating actor and viewer together leaves the index unchanged.
  for (let k = 0; k < 16; k++) {
    const yaw = k * 0.4;
    const cx = Math.sin(yaw + 1) * 5, cz = -Math.cos(yaw + 1) * 5;
    assert.equal(facingIndex(0, 0, yaw, cx, cz), facingIndex(0, 0, 0, Math.sin(1) * 5, -Math.cos(1) * 5));
  }
});

test('8-direction records mirror the right-hand views from the left-hand records', () => {
  const app = entityAppearance({ id: 's', kind: 'monster', mobileType: 15 });
  const recs = [0, 1, 2, 3, 4, 5, 6, 7].map((f) => animRecord(app, 'move', f, 20));
  assert.deepEqual(recs.map((r) => r.record), [0, 1, 2, 3, 4, 3, 2, 1]);
  assert.deepEqual(recs.map((r) => r.flip), [false, false, false, false, false, true, true, true]);
  assert.equal(animRecord(app, 'attack', 2, 20).record, 7);
  assert.equal(animRecord(app, 'attack', 0, 20).loop, false);
  assert.equal(animRecord(app, 'hurt', 4, 20).record, 14);
  assert.equal(animRecord(app, 'idle', 6, 20).record, 17);
  assert.equal(animRecord(app, 'idle', 6, 20).flip, true);
  assert.equal(animRecord(app, 'ranged', 0, 20).record, 5, 'no ranged records → melee attack');
  // rats are drawn facing the other way when idle
  const rat = entityAppearance({ id: 'r', kind: 'monster', mobileType: 0 });
  assert.equal(animRecord(rat, 'idle', 2, 20).flip, true);
  assert.equal(animRecord(rat, 'idle', 6, 20).flip, false);
  // ghosts mirror their side views
  const ghost = entityAppearance({ id: 'g', kind: 'monster', mobileType: 18 });
  assert.equal(animRecord(ghost, 'move', 2, 20).flip, true);
  // fliers (bat: 15 records) have no idle records and keep flapping
  const bat = entityAppearance({ id: 'b', kind: 'monster', mobileType: 3 });
  assert.equal(animRecord(bat, 'idle', 0, 15).record, 0);
  // town people: walk cycle per facing, single front idle
  const person = entityAppearance({ id: 'p', kind: 'npc', gender: 'm' });
  assert.equal(animRecord(person, 'move', 6, 6).record, 2);
  assert.equal(animRecord(person, 'move', 6, 6).flip, true);
  assert.equal(animRecord(person, 'idle', 3, 6).record, 5);
  assert.equal(animRecord(entityAppearance({ id: 'g', kind: 'npc', role: 'guard' }), 'idle', 3, 20).record, 15);
});

test('frameAt loops walk cycles and clamps one-shots', () => {
  assert.equal(frameAt(0, 6, 4, true), 0);
  assert.equal(frameAt(0.5, 6, 4, true), 3);
  assert.equal(frameAt(0.7, 6, 4, true), 0);
  assert.equal(frameAt(5, 10, 6, false), 5);
  assert.equal(frameAt(3, 4, 1, true), 0);
});

// ------------------------------------------------------------ animation state

test('animation state: walk, hurt on hp loss, attack, dying then corpse', () => {
  const a = new AnimState();
  a.observe({ moving: false, hp: 10 }, 0);
  assert.equal(a.current(0.1).state, 'idle');
  a.observe({ moving: true, hp: 10 }, 1);
  assert.equal(a.current(1.2).state, 'move');
  a.observe({ moving: true, hp: 7 }, 2);
  assert.equal(a.current(2.1).state, 'hurt');
  assert.ok(a.hurtFlash(2.05) > 0.5);
  a.endOneShot();
  assert.equal(a.current(2.5).state, 'move');
  a.observe({ moving: false, hp: 7, animation: 'attack' }, 3);
  assert.equal(a.current(3.05).state, 'attack');
  a.endOneShot(); // held server attack: swing again
  assert.equal(a.current(3.4).state, 'attack');
  assert.equal(a.current(3.4).t, 0);
  a.observe({ moving: false, hp: 7, animation: 'idle' }, 4);
  a.endOneShot();
  assert.equal(a.current(4.1).state, 'idle');
  a.observe({ hp: 0, dead: true }, 5);
  assert.equal(a.current(5.1).state, 'dying');
  assert.equal(a.current(5 + DYING_SECONDS + 0.1).state, 'corpse');
  a.trigger('attack', 6);
  assert.equal(a.current(6.1).state, 'corpse', 'the dead do not swing');
  const late = new AnimState();
  late.observe({ dead: true }, 10);
  assert.equal(late.current(10).state, 'corpse', 'already dead when first seen');
});

test('isDead and hasLoot read server fields only', () => {
  assert.equal(isDead({ kind: 'monster', hp: 0, maxHp: 5 }), true);
  assert.equal(isDead({ kind: 'monster', hp: 2 }), false);
  assert.equal(isDead({ kind: 'monster', animation: 'death' }), true);
  assert.equal(isDead({ kind: 'corpse' }), true);
  assert.equal(isDead({ kind: 'npc', hp: 0 }), false);
  assert.equal(hasLoot({ kind: 'corpse', loot: [{ id: 1 }] }), true);
  assert.equal(hasLoot({ kind: 'corpse', loot: [] }), false);
  assert.equal(hasLoot({ kind: 'loot' }), true);
  assert.equal(hasLoot({ kind: 'loot', looted: true }), false);
  assert.equal(describeTarget({ kind: 'monster', hp: 3, maxHp: 10 }), 'Badly wounded');
  assert.equal(describeTarget({ kind: 'corpse', dead: true, loot: true }), 'Corpse · something to take');
  assert.equal(describeTarget({ kind: 'npc', role: 'merchant' }), 'Merchant');
  assert.equal(describeTarget({ kind: 'player', readied: true }), 'Traveller · weapon readied');
});

// ------------------------------------------------------------ occlusion and picking

const wall = (x, y0, y1, z0, z1) => [x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z0, x, y1, z1, x, y0, z1];

test('occluder blocks segments through walls only', () => {
  const o = new Occluder(new Float32Array(wall(5, 0, 4, -3, 3)));
  assert.equal(o.blocked([0, 1.6, 0], [10, 1, 0]), true);
  assert.equal(o.blocked([0, 1.6, 0], [4, 1, 0]), false);
  assert.equal(o.blocked([0, 5, 0], [10, 5, 0]), false, 'over the wall');
  assert.equal(o.blocked([0, 1, 5], [10, 1, 5]), false, 'beside the wall');
  assert.equal(o.blocked([10, 1, 0], [0, 1.6, 0]), true, 'either direction');
});

test('billboard corners face the camera right vector and stand on the foot point', () => {
  const c = billboardCorners(1, 2, 3, 2, 4, 0);
  assert.deepEqual(c[0], [0, 2, 3]);
  assert.deepEqual(c[2], [2, 6, 3]);
  const r = billboardCorners(0, 0, 0, 2, 1, Math.PI / 2);
  assert.ok(Math.abs(r[1][2] - 1) < 1e-9 && Math.abs(r[1][0]) < 1e-9, 'yaw 90° → right is +z');
});

/** Library stub that serves synthetic archives without files. */
function fakeLibrary(archives) {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) pal.set([i, i, i], i * 3);
  const lib = new SpriteLibrary();
  for (const [n, bytes] of Object.entries(archives)) {
    const sprite = new SpriteArchive(bytes, Number(n));
    lib.entries.set(Number(n), { archive: Number(n), sprite, atlas: buildAtlas(sprite, pal), version: 0 });
  }
  return lib;
}

function solid(w, h, frames = 1) {
  return Array.from({ length: frames }, () => new Uint8Array(w * h).fill(9));
}
function enemyArchive(records = 20) {
  return buildTexture(Array.from({ length: records }, () => ({ width: 40, height: 80, frames: solid(40, 80, 4), scale: 0 })));
}

function makeController(state, archives) {
  const api = { state, events: [], emit(name, d) { this.events.push([name, d]); } };
  const renderer = {
    ids: null, town: null, addPass() { return () => {}; },
    setActorSprites(ids) { this.ids = new Set([...ids].map(String)); },
    hasActorSprite(id) { return this.ids?.has(String(id)); },
  };
  let t = 0;
  const ctl = new ActorController(api, { clock: () => t });
  ctl.library = fakeLibrary(archives);
  ctl.screen = 'game';
  return { api, renderer, ctl, tick: (dt = 0.1) => (t += dt) };
}

test('actors stand on the wilderness terrain above a buried model surface', () => {
  const state = { character: { location: 'wilderness:1,1' }, peers: [{ id: 2, x: 0, z: 0, readied: true, className: 'Warrior', gender: 'm' }] };
  const { ctl, tick, renderer } = makeController(state, { 488: enemyArchive(25) });
  ctl.syncState(state, 0);
  const mesh = { positions: new Float32Array([-2, -30, -2, 2, -30, -2, 0, -30, 2]), wilderness: { heightAt: () => 5 } };
  ctl.update({ x: 0, y: 6.6, z: 3, yaw: 0, pitch: 0 }, 0.1, tick(), renderer, mesh);
  assert.equal(ctl.views.get('p:2').footY, 5);
});

test('controller draws entities and peers, flags sprites for the shell, and targets under the crosshair', () => {
  const state = {
    selfId: 1,
    character: { location: 'town:A' },
    entities: [
      { id: 'skel', kind: 'monster', name: 'Skeletal Warrior', mobileType: 15, x: 0, z: -6, yaw: Math.PI, hp: 10, maxHp: 10, location: 'town:A' },
      { id: 'far', kind: 'monster', mobileType: 15, x: 0, z: -6, location: 'town:B' },
    ],
    peers: [{ id: 1, name: 'Me', x: 0, z: 0 }, { id: 2, name: 'Ana', x: 3, z: -6, yaw: 1, readied: true, className: 'Warrior', gender: 'm' }],
  };
  const { api, renderer, ctl, tick } = makeController(state, { 270: enemyArchive(), 488: enemyArchive(25) });
  ctl.syncState(state, 0);
  assert.deepEqual([...ctl.views.keys()].sort(), ['e:skel', 'p:2'], 'self and other-location entities skipped');
  const cam = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: -0.05 };
  const items = ctl.update(cam, 0.1, tick(), renderer, null);
  assert.equal(items.length, 2);
  assert.equal(renderer.hasActorSprite('skel'), true);
  assert.equal(renderer.hasActorSprite(2), true);
  assert.equal(api.spritesActive, true);
  const sk = items.find((i) => i.id === 'skel');
  assert.equal(sk.w, 1, '40 px at scale 0 is 1 m');
  assert.equal(sk.h, 2);
  assert.equal(sk.record, 15, 'idle, facing the viewer');
  const pi = items.find((i) => i.id === 2);
  assert.deepEqual([pi.record, pi.flip], [18, true], 'peer seen from behind-left: back-diagonal record, mirrored');
  assert.equal(api.target, 'skel');
  assert.equal(api.targetInfo.name, 'Skeletal Warrior');
  assert.deepEqual(api.events.at(-1), ['target', { id: 'skel', entity: null, info: api.targetInfo }]);
  // the entity object itself is never modified
  assert.deepEqual(Object.keys(state.entities[0]).sort(), ['hp', 'id', 'kind', 'location', 'maxHp', 'mobileType', 'name', 'x', 'yaw', 'z']);

  // Look away: no target.
  ctl.update({ ...cam, yaw: Math.PI / 2 }, 0.1, tick(), renderer, null);
  assert.equal(api.target, null);

  // A wall between camera and skeleton blocks targeting (but not drawing).
  ctl.setTown({ positions: new Float32Array([0, 0, -3, 0, 4, -3, 4, 4, -3, 0, 0, -3, 4, 4, -3, 4, 0, -3, -4, 0, -3, -4, 4, -3, 0, 4, -3, -4, 0, -3, 0, 4, -3, 0, 0, -3]) });
  ctl.update(cam, 0.1, tick(), renderer, null);
  assert.equal(api.target, null);
  assert.equal(ctl.items.length, 2);
});

test('controller: death shows the corpse archive, hurt flashes, swing events animate peers', () => {
  const state = {
    entities: [{ id: 'm', kind: 'monster', mobileType: 15, x: 0, z: -5, yaw: Math.PI, hp: 10, maxHp: 10 }],
    peers: [{ id: 2, name: 'Ana', x: 2, z: -5, readied: true, gender: 'm' }],
  };
  const corpse = buildTexture([{ width: 8, height: 8, frames: solid(8, 8) }, { width: 60, height: 20, frames: solid(60, 20), scale: 0 }]);
  const { renderer, ctl, tick } = makeController(state, { 270: enemyArchive(), 488: enemyArchive(25), 306: corpse });
  const cam = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  ctl.syncState(state, 0);
  ctl.update(cam, 0.1, tick(), renderer);
  ctl.syncState({ ...state, entities: [{ ...state.entities[0], hp: 4 }] }, 0.2);
  let it = ctl.update(cam, 0.1, tick(), renderer).find((i) => i.id === 'm');
  assert.equal(it.record, 10, 'hurt record, front');
  assert.ok(it.hurt > 0);
  ctl.onEvent({ kind: 'swing', playerId: 2 }, 0.2);
  it = ctl.update(cam, 0.05, tick(0.05), renderer).find((i) => i.id === 2);
  assert.ok(it.record >= 5 && it.record <= 9, `peer attack record, got ${it.record}`);
  ctl.syncState({ ...state, entities: [{ ...state.entities[0], hp: 0, loot: [{ id: 'x' }] }] }, 0.4);
  ctl.update(cam, 0.1, tick(), renderer);
  for (let i = 0; i < 12; i++) ctl.update(cam, 0.1, tick(), renderer);
  ctl.update({ ...cam, pitch: -0.27 }, 0.1, tick(), renderer); // look down at the body
  it = ctl.items.find((i) => i.id === 'm');
  assert.equal(it.entry.archive, 306, 'Skeletal Warrior corpse archive');
  assert.equal(it.record, 1);
  assert.equal(it.w, 1.5);
  assert.equal(ctl.targetInfo?.kind, 'corpse');
  assert.equal(ctl.targetInfo?.loot, true);
});

test('install wires api events and exposes the documented surface', () => {
  const handlers = {};
  const api = { state: null, files: [], on(n, f) { handlers[n] = f; }, emit() {} };
  const pub = install(api, { readout: false, clock: () => 0 });
  assert.equal(api.actors, pub);
  for (const k of ['hasSprite', 'drawnIds', 'target', 'appearance', 'library', 'update']) assert.ok(k in pub, k);
  for (const n of ['assets', 'state', 'event', 'screen', 'scene', 'frame']) assert.equal(typeof handlers[n], 'function', n);
  handlers.state({ entities: [{ id: 'a', kind: 'npc', x: 0, z: -3 }], peers: [] });
  handlers.frame({ camera: { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, dt: 0.016, now: 1 });
  assert.equal(api.spritesActive, false, 'no files selected: nothing drawn, shell keeps its placeholders');
  assert.equal(pub.hasSprite('a'), false);
  assert.ok(pub.appearance('a'));
});

test('the first game render includes the final occupant even immediately after a loading frame', (t) => {
  let render;
  const renderer = { addPass(fn) { render = fn; return () => {}; } };
  const api = createGameplayApi({});
  api.renderer = renderer;
  const actors = install(api, { clock: () => 1, readout: false });
  const sprites = fakeLibrary({ 182: enemyArchive(1) });
  actors.library.entries.set(182, sprites.entries.get(182));
  const draw = t.mock.method(SpritePass.prototype, 'draw', () => {});
  const camera = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  api.emit('screen', 'loading');
  render(null, renderer, camera);
  const contact = { id: 'contact', kind: 'npc', x: 0, z: -2, sprite: { archive: 182, record: 0 } };
  api.emit('state', { entities: [contact] });
  api.emit('screen', 'game');
  render(null, renderer, camera);
  assert.deepEqual(draw.mock.calls[0].arguments[3].map(item => item.id), ['contact']);
});

test('the first draw after a door opens uses the new roster even between consecutive frame events', (t) => {
  let render;
  let time = 1;
  const renderer = { addPass(fn) { render = fn; return () => {}; } };
  const api = createGameplayApi({});
  api.renderer = renderer;
  const actors = install(api, { clock: () => time, readout: false });
  const sprites = fakeLibrary({ 182: enemyArchive(1), 488: enemyArchive(25) });
  for (const [id, sprite] of sprites.entries) actors.library.entries.set(id, sprite);
  const draw = t.mock.method(SpritePass.prototype, 'draw', () => {});
  const camera = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  api.emit('screen', 'game');
  for (const [location, id, x] of [['town:Daggerfall/Gothway Garden', 'walker', 60], ['interior:Daggerfall/Gothway Garden/3,0/15', 'keeper', 2]]) {
    time += 1 / 60;
    api._receiveRpg({
      character: { location },
      entities: [{ id, location, kind: 'npc', x: 0, z: -2, sprite: { archive: 182, record: 0 } }],
      peers: [{ id: 'companion', location, x, z: -3, readied: true, className: 'Warrior', gender: 'm' }],
    });
    renderer.town = { location };
    api.emit('scene', renderer.town);
    render(null, renderer, camera);
    const items = draw.mock.calls.at(-1).arguments[3];
    assert.deepEqual(items.map(item => item.id), [id, 'companion']);
    assert.equal(items[1].x, x, 'the companion stands in this room on the first draw');
  }
});

test('renderer exposes the pass and sprite-flag hooks', () => {
  for (const k of ['addPass', 'hasActorSprite', 'setActorSprites']) assert.equal(typeof Renderer.prototype[k], 'function', k);
  const fake = Object.create(Renderer.prototype);
  fake.passes = [];
  fake.actorSprites = new Set();
  const remove = fake.addPass(() => {});
  assert.equal(fake.passes.length, 1);
  remove();
  assert.equal(fake.passes.length, 0);
  fake.setActorSprites([3, 'x']);
  assert.equal(fake.hasActorSprite('3'), true);
  assert.equal(fake.hasActorSprite(3), true);
  assert.equal(fake.spritesActive, true);
});

test('with the shell api: target goes through setTarget, and only once sprites are drawn', () => {
  const api = createGameplayApi({});
  const seen = [];
  api.on('target', (t) => seen.push(t));
  const state = { entities: [{ id: 'skel', kind: 'monster', name: 'Skeletal Warrior', mobileType: 15, x: 0, z: -6, yaw: Math.PI, hp: 5, maxHp: 5 }], peers: [] };
  api.state = state;
  let t = 0;
  const renderer = { addPass: () => () => {}, setActorSprites() {} };
  const cam = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: -0.05 };
  // No archives: nothing drawn, the shell's fallback picker keeps ownership.
  const bare = new ActorController(api, { clock: () => t });
  bare.screen = 'game';
  bare.syncState(state, 0);
  bare.update(cam, 0.1, (t += 0.1), renderer);
  assert.equal(api.targetOwnedByFeature, false);
  assert.equal(seen.length, 0);
  const ctl = new ActorController(api, { clock: () => t });
  ctl.library = fakeLibrary({ 270: enemyArchive() });
  ctl.screen = 'game';
  ctl.syncState(state, 0);
  ctl.update(cam, 0.1, (t += 0.1), renderer);
  assert.equal(api.target, 'skel');
  assert.equal(api.targetOwnedByFeature, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].entity.name, 'Skeletal Warrior');
  ctl.update(cam, 0.1, (t += 0.1), renderer);
  assert.equal(seen.length, 1, 'no repeat emits while the target is unchanged');
  assert.equal(api.spritesActive, true);
});
