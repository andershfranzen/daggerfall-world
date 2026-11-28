// The outdoor sky: the classic SKYnn.DAT frame for the hour, the sun and moons, the dome's colours, the night
// image, and the light model following the painting (client/render/sky-dome.js, client/world/scenery/sky.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  skyFrameAt, skySunDirection, moonState, skyStateFor, skyColors, SKY_WEATHER, NIGHT_SKY, PANORAMA_RISE,
  DEFAULT_SKY_STATE, DOME_FS, SKY_STYLES,
} from '../client/render/sky-dome.js';
import {
  readTimedSky, readDaySky, readClassicSky, decodeNightSky, nightSkyFileName, SKY_FILE_SIZE, SKY_WIDTH, SKY_HEIGHT,
  NIGHT_SKY_WIDTH, NIGHT_SKY_HEIGHT,
} from '../client/world/scenery/sky.js';
import { lightFor } from '../client/gameplay/atmosphere/light.js';
import { normalizeGraphicsOptions, DEFAULT_GRAPHICS } from '../client/render/graphics-options.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const deg = (r) => (r * 180) / Math.PI;

test('classic sky frame: 64 frames dawn to dusk, the night sky fading in either side', () => {
  assert.deepEqual(skyFrameAt(6 * 60), { frame: 0, next: 1, blend: 0, night: skyFrameAt(360).night });
  assert.equal(skyFrameAt(12 * 60).frame, 32);
  assert.equal(skyFrameAt(18 * 60).frame, 63);
  assert.equal(skyFrameAt(18 * 60).next, 63, 'the last frame holds');
  near(skyFrameAt(6 * 60 + 5.625).blend, 0.5, 1e-9, 'half way to the next frame');
  assert.equal(skyFrameAt(0).night, 1);
  assert.equal(skyFrameAt(3 * 60).night, 1);
  assert.equal(skyFrameAt(12 * 60).night, 0);
  assert.equal(skyFrameAt(7 * 60).night, 0);
  assert.equal(skyFrameAt(17 * 60).night, 0);
  assert.equal(skyFrameAt(19 * 60).night, 1);
  const dusk = skyFrameAt(18 * 60 + 15).night;
  assert.ok(dusk > 0 && dusk < 1, 'dusk is a fade, not a cut');
  assert.equal(skyFrameAt(-60).frame, skyFrameAt(23 * 60).frame, 'minutes wrap');
});

test('sky sun: due east then due west, at the painted sun\'s height, sinking below the horizon at night', () => {
  for (const m of [0, 200, 360, 500, 719, 721, 900, 1080, 1300]) near(Math.hypot(...skySunDirection(m)), 1, 1e-9, `unit at ${m}`);
  const am = skySunDirection(8 * 60), pm = skySunDirection(16 * 60);
  assert.ok(am[0] > 0 && pm[0] < 0, 'east in the morning, west in the afternoon');
  assert.equal(am[2], 0, 'no drift north or south: it stays over the painted sun');
  // Frame 10 (07:52): the painted sun's row is 218 - 9.3 * 10 of 220, on a cylinder PANORAMA_RISE high.
  const f10 = skySunDirection(360 + 10 * 11.25);
  near(Math.tan(Math.asin(f10[1])) / PANORAMA_RISE, (220 - (218 - 93)) / 220, 0.012, 'painted sun row');
  // The afternoon frame n shows morning frame 63 - n mirrored.
  const f53 = skySunDirection(360 + 53 * 11.25);
  near(f53[1], f10[1], 1e-9, 'frame 53 mirrors frame 10');
  assert.ok(skySunDirection(12 * 60)[1] > 0.999, 'overhead at noon');
  assert.ok(skySunDirection(0)[1] < -0.5 && skySunDirection(21 * 60)[1] < -0.3, 'well down at night');
  let last = -2;
  for (let m = 240; m <= 720; m += 10) { const y = skySunDirection(m)[1]; assert.ok(y >= last - 1e-9, `rises steadily at ${m}`); last = y; }
});

test('Masser and Secunda: a 32-day cycle each, on the night side of the sky', () => {
  const day = 1440;
  const a = moonState(1000 * day), b = moonState(1032 * day), c = moonState(1016 * day);
  near(a.masser.phase, b.masser.phase, 1e-9, 'Masser repeats in 32 days');
  near(a.secunda.phase, b.secunda.phase, 1e-9, 'Secunda repeats in 32 days');
  near(Math.abs(a.masser.phase - c.masser.phase), 0.5, 1e-9, 'half a cycle is the other phase');
  near((((a.masser.phase - a.secunda.phase) % 1) + 1) % 1, 4 / 32, 1e-9, 'Masser runs four days ahead');
  assert.ok(a.masser.radius > a.secunda.radius * 1.8, 'Masser is the large moon');
  for (const m of [0, 123, 700, 1439]) {
    const s = moonState(1000 * day + m);
    near(Math.hypot(...s.masser.dir), 1, 1e-9, 'unit');
    near(Math.hypot(...s.secunda.dir), 1, 1e-9, 'unit');
  }
  const midnight = moonState(1000 * day), noon = moonState(1000 * day + 720);
  assert.ok(midnight.masser.dir[1] > 0.6 && midnight.secunda.dir[1] > 0.6, 'high at midnight');
  assert.ok(noon.masser.dir[1] < -0.6 && noon.secunda.dir[1] < -0.6, 'down at noon');
  assert.ok(moonState(1000 * day + 20 * 60).masser.dir[0] > 0, 'rising in the east in the evening');
  const sep = Math.acos(midnight.masser.dir.reduce((s, v, i) => s + v * midnight.secunda.dir[i], 0));
  assert.ok(deg(sep) > 15 && deg(sep) < 50, `the two keep company (${deg(sep).toFixed(0)} degrees apart)`);
});

test('sky state: stars only in the dark and through clear air, weather thickens the cloud', () => {
  const noon = skyStateFor({ minuteOfDay: 720 }), midnight = skyStateFor({ minuteOfDay: 0 });
  assert.equal(noon.stars, 0);
  assert.equal(noon.night, 0);
  assert.ok(noon.day > 0.99);
  assert.equal(midnight.stars, 1);
  assert.equal(midnight.night, 1);
  assert.ok(midnight.day < 0.01);
  assert.ok(skyStateFor({ minuteOfDay: 0, weather: 'thunder' }).stars < 0.2, 'a storm deck hides the stars');
  const dusk = skyStateFor({ minuteOfDay: 17 * 60 + 40 });
  assert.ok(dusk.warmth > 0.6 && noon.warmth < 0.01, 'the low sun is warm');
  for (const w of Object.keys(SKY_WEATHER)) {
    const s = skyStateFor({ minuteOfDay: 600, weather: w });
    assert.equal(s.weather, w);
    assert.ok(s.cloud.cover >= SKY_WEATHER.sunny.cover, `${w} is no clearer than a sunny day`);
  }
  assert.equal(skyStateFor({ minuteOfDay: 600, weather: 'nonsense' }).weather, 'sunny');
  assert.equal(skyStateFor({ minuteOfDay: 600, flash: 3 }).flash, 1);
  near(Math.hypot(...skyStateFor({ minuteOfDay: 600, flashDir: [3, 4, 0] }).flashDir), 1, 1e-9, 'flash direction is a unit vector');
  assert.equal(DEFAULT_SKY_STATE.night, 0);
  assert.equal(DEFAULT_SKY_STATE.frames.frame, 31, 'the default is the late-morning frame the scene builders use');
});

test('dome colours: taken from the painting by day, the night sky at night, our own without it', () => {
  const pano = { top: [0.68, 0.78, 0.99], mid: [0.8, 0.86, 0.98], horizon: [0.9, 1, 1] };
  const day = skyColors(skyStateFor({ minuteOfDay: 700 }), pano);
  assert.deepEqual(day.low, pano.mid, 'the dome starts in the colour the painting fades out over');
  assert.deepEqual(day.fog, pano.horizon, 'the world fogs to the painting\'s horizon colour');
  assert.ok(day.top[2] > day.top[0] * 1.5 && day.top[1] < pano.top[1], 'deeper and bluer overhead');
  const night = skyColors(skyStateFor({ minuteOfDay: 0 }), pano);
  for (const k of ['low', 'top', 'fog']) night[k].forEach((v, i) => near(v, NIGHT_SKY[k][i], 1e-9, `night ${k}`));
  const grey = skyColors(skyStateFor({ minuteOfDay: 700, weather: 'rain' }), pano);
  const spread = (c) => Math.max(...c) - Math.min(...c);
  assert.ok(spread(grey.low) < spread(day.low), 'rain takes the colour out of the sky');
  const plain = skyColors(skyStateFor({ minuteOfDay: 700 }), null);
  assert.equal(plain.fog, null, 'no painting: the light model keeps its own fog colour');
  assert.ok(plain.low.every((v) => v > 0 && v < 1) && plain.top.every((v) => v > 0 && v < 1));
  for (const c of [day, night, grey, plain]) for (const k of ['cloudLit', 'cloudDark']) assert.ok(c[k].every((v) => Number.isFinite(v) && v >= 0 && v <= 1.2), `${k} in range`);
  assert.ok(day.cloudLit[1] > day.cloudDark[1], 'lit cloud is lighter than its shadow');
});

test('sky shader source: one program for the dome, the panorama and the classic placement', () => {
  for (const u of ['u_invVp', 'u_shade', 'u_outScale', 'u_skyLow', 'u_skyTop', 'u_moonA', 'u_moonB', 'u_pano', 'u_texA', 'u_texB', 'u_texN', 'u_flash']) {
    assert.ok(DOME_FS.includes(`${u};`), `declares ${u}`);
  }
  assert.ok(DOME_FS.includes(`PANO_RISE = ${PANORAMA_RISE.toFixed(4)}`));
  assert.ok(!/\$\{/.test(DOME_FS), 'no template placeholder left in the source');
  assert.deepEqual([...SKY_STYLES], ['hybrid', 'classic']);
});

test('graphics options: sky style defaults to hybrid and survives normalisation', () => {
  assert.equal(DEFAULT_GRAPHICS.skyStyle, 'hybrid');
  assert.equal(normalizeGraphicsOptions(null).skyStyle, 'hybrid');
  assert.equal(normalizeGraphicsOptions({ skyStyle: 'classic' }).skyStyle, 'classic');
  assert.equal(normalizeGraphicsOptions({ skyStyle: 'neon' }).skyStyle, 'hybrid');
});

// ---------------------------------------------------------------- SKY and NITE files

function syntheticSky() {
  const bytes = new Uint8Array(SKY_FILE_SIZE);
  const F = SKY_WIDTH * SKY_HEIGHT;
  for (let f = 0; f < 32; f++) {
    // Palette f: index 1 = (f, 0, 0), index 2 = (0, f, 0), index 3 = (10 + f, 20, 30).
    const p = 776 * f + 8;
    bytes.set([f, 0, 0], p + 3);
    bytes.set([0, f, 0], p + 6);
    bytes.set([10 + f, 20, 30], p + 9);
    bytes.fill(1, 549120 + F * f, 549120 + F * (f + 1)); // east record
    bytes.fill(2, 549120 + F * (32 + f), 549120 + F * (33 + f)); // west record
    bytes[549120 + F * (32 + f) + (SKY_HEIGHT - 1) * SKY_WIDTH] = 3; // west bottom-left: the fog colour
  }
  return bytes;
}
const readerOf = (bytes) => async (offset, length) => bytes.subarray(offset, offset + length);

test('timed sky: any frame on demand, afternoon frames mirrored, same result as the single-frame reader', async () => {
  const bytes = syntheticSky();
  const sky = await readTimedSky(readerOf(bytes), bytes.length, 31, 'SKYXX.DAT');
  const one = await readDaySky(readerOf(bytes), bytes.length, 31, 'SKYXX.DAT');
  assert.deepEqual(sky.pixels, one.pixels);
  assert.deepEqual(sky.horizon, one.horizon);
  assert.equal(sky.width, 1024);
  const am = sky.frameAt(5), pm = sky.frameAt(58);
  assert.deepEqual([...am.pixels.subarray(0, 3)], [5, 0, 0], 'morning: east half on the left');
  assert.deepEqual([...pm.pixels.subarray(0, 3)], [0, 5, 0], 'afternoon: frame 63 - 58 with the halves swapped');
  near(am.horizon[0], 15 / 255, 1e-9, 'fog colour from the frame\'s own palette');
  assert.equal(am.mid.length, 3);
  assert.ok(am.mid.every((v) => v >= 0 && v <= 1));
  assert.equal(sky.frameAt(5), am, 'recent frames are kept');
  assert.equal(sky.frameAt(99).frame, 63, 'frame numbers are clamped');
  await assert.rejects(() => readTimedSky(readerOf(bytes.subarray(0, 1000)), 1000), /truncated/);
});

test('night sky: NITE image per SKY set, ridge opaque and open sky clear', () => {
  assert.equal(nightSkyFileName(0), 'NITE03I0.IMG');
  assert.equal(nightSkyFileName(8), 'NITE01I0.IMG');
  assert.equal(nightSkyFileName(16), 'NITE02I0.IMG');
  assert.equal(nightSkyFileName(23), 'NITE02I0.IMG');
  assert.equal(nightSkyFileName(24), 'NITE00I0.IMG');
  const image = new Uint8Array(NIGHT_SKY_WIDTH * NIGHT_SKY_HEIGHT).fill(31);
  image.fill(14, NIGHT_SKY_WIDTH * 180); // the ridge
  const col = new Uint8Array(776);
  col.set([0, 0, 100], 8 + 31 * 3);
  col.set([20, 20, 20], 8 + 14 * 3);
  const n = decodeNightSky(image, col);
  assert.deepEqual([...n.pixels.subarray(0, 4)], [0, 0, 100, 0], 'open sky: classic colour, clear');
  assert.deepEqual([...n.pixels.subarray(NIGHT_SKY_WIDTH * 200 * 4, NIGHT_SKY_WIDTH * 200 * 4 + 4)], [20, 20, 20, 255], 'ridge: opaque');
  assert.throws(() => decodeNightSky(image.subarray(0, 10), col), /truncated/);
  assert.throws(() => decodeNightSky(image, col.subarray(0, 10)), /truncated/);
});

test('classic sky bundle: the night image is optional, a missing day sky is an error', async () => {
  const bytes = syntheticSky();
  const files = { 'SKY16.DAT': bytes };
  const open = (name) => (files[name] ? { size: files[name].length, read: readerOf(files[name]) } : null);
  const alone = await readClassicSky(open, 16);
  assert.equal(alone.file, 'SKY16.DAT');
  assert.equal(alone.index, 16);
  assert.equal(alone.night, null);
  assert.equal(typeof alone.frameAt, 'function');
  files['NITE02I0.IMG'] = new Uint8Array(NIGHT_SKY_WIDTH * NIGHT_SKY_HEIGHT).fill(20);
  files['NIGHTSKY.COL'] = new Uint8Array(776);
  const full = await readClassicSky(open, 16);
  assert.equal(full.night.file, 'NITE02I0.IMG');
  assert.equal(full.night.width, 512);
  await assert.rejects(() => readClassicSky(open, 17), /SKY17\.DAT is not in the selected folder/);
});

const ARENA2 = process.env.ARENA2_DIR;
const haveArena2 = !!ARENA2 && existsSync(join(ARENA2, 'SKY16.DAT'));

test('installed SKY16.DAT: the panorama tiles at both seams and reddens toward dawn', { skip: haveArena2 ? false : 'ARENA2_DIR with SKY16.DAT not set' }, async () => {
  const bytes = new Uint8Array(readFileSync(join(ARENA2, 'SKY16.DAT')));
  const files = { 'SKY16.DAT': bytes };
  for (const n of ['NITE02I0.IMG', 'NIGHTSKY.COL']) if (existsSync(join(ARENA2, n))) files[n] = new Uint8Array(readFileSync(join(ARENA2, n)));
  const sky = await readClassicSky((name) => (files[name] ? { size: files[name].length, read: readerOf(files[name]) } : null), 16);
  const f = sky.frameAt(31);
  const column = (x) => { let s = 0; for (let y = 0; y < f.height; y++) for (let k = 0; k < 3; k++) s += f.pixels[(y * f.width + x) * 4 + k]; return s / (f.height * 3); };
  const step = (a, b) => { let s = 0; for (let y = 0; y < f.height; y++) for (let k = 0; k < 3; k++) s += Math.abs(f.pixels[(y * f.width + a) * 4 + k] - f.pixels[(y * f.width + b) * 4 + k]); return s / (f.height * 3); };
  assert.ok(column(0) > 0);
  const inside = step(255, 256);
  assert.ok(step(511, 512) < inside * 3 + 4, 'north seam is no worse than neighbouring columns');
  assert.ok(step(1023, 0) < inside * 3 + 4, 'the 0/360 degree wrap is no worse than neighbouring columns');
  const dawn = sky.frameAt(0), noon = sky.frameAt(31);
  assert.ok(dawn.horizon[0] > dawn.horizon[2] * 2, 'dawn horizon is red');
  assert.ok(noon.horizon[2] > 0.8, 'noon horizon is pale');
  assert.ok(noon.zenith[2] > noon.zenith[0], 'noon top row is blue');
  if (sky.night) {
    let ridge = 0, open = 0;
    for (let i = 3; i < sky.night.pixels.length; i += 4) (sky.night.pixels[i] ? ridge++ : open++);
    assert.ok(ridge > 0 && open > ridge, 'a ridge line under open sky');
  }
});

// ---------------------------------------------------------------- light under the classic sky

test('light model: with the classic sky on screen, fog and ground light follow the painting', () => {
  const dawnTone = { horizon: [0.31, 0.03, 0.035], zenith: [0.1, 0.02, 0.02], frame: 1 };
  const plain = lightFor({ minuteOfDay: 6 * 60 + 30, weather: 'sunny' });
  const toned = lightFor({ minuteOfDay: 6 * 60 + 30, weather: 'sunny', tone: dawnTone });
  assert.deepEqual(toned.horizon, dawnTone.horizon, 'fog is the painting\'s horizon colour');
  assert.deepEqual(toned.zenith, dawnTone.zenith);
  assert.notDeepEqual(plain.horizon, toned.horizon);
  assert.ok(toned.shade[0] > toned.shade[2] * 0.9 && toned.shade[0] < plain.shade[0], 'a dark red dawn dims the ground');
  const noonTone = { horizon: [0.9, 1, 1], zenith: [0.68, 0.78, 0.99] };
  assert.equal(lightFor({ minuteOfDay: 720, weather: 'sunny', tone: noonTone }).shadeCss, 'rgb(255 255 255)', 'a pale noon horizon leaves full daylight');
  const rain = lightFor({ minuteOfDay: 720, weather: 'rain', tone: noonTone });
  const spread = (c) => Math.max(...c) - Math.min(...c);
  assert.ok(spread(rain.horizon) < spread(noonTone.horizon), 'weather greys the painting\'s fog');
  const night = lightFor({ minuteOfDay: 0, weather: 'sunny', tone: { horizon: [...NIGHT_SKY.fog], zenith: [...NIGHT_SKY.low] } });
  assert.deepEqual(night.shade, lightFor({ minuteOfDay: 0, weather: 'sunny' }).shade, 'night shade is unchanged');
  assert.equal(lightFor({ minuteOfDay: 720, indoors: true, tone: dawnTone }).shadeCss, 'rgb(255 255 255)', 'interiors ignore the sky');
});
