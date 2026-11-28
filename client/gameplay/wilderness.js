// Outdoor scenes in the browser: World of Daggerfall wilderness pixels (docs/wilderness-protocol.md) and the
// streaming that keeps the exterior visible while walking (docs/world-expansion-plan.md, brief D).
//
// The server decides where a character is. This feature:
//   1. builds `wilderness:<px>,<py>` scenes from the public scene descriptors (GET /api/wilderness/scene for the
//      pixel and its eight neighbours; 404 = no site there) and the player's own ARENA2 files
//      (client/world/wilderness/scene.js), and hands them to api.setScene(mesh, {location});
//   2. keeps one bounded cache of exterior scenes (client/world/exterior/stream.js): wilderness pixels and the
//      classic towns they contain, built one at a time, current location first;
//   3. composes the view around whatever exterior is current. A wilderness pixel draws every classic town of its
//      3×3 cells in place (townMeshOffset); a town draws its own pixel's terrain, sites and neighbouring towns
//      around it. Nature and town flats are drawn with each layer, the sky with the current pixel;
//   4. prefetches the pixel the player is walking toward, so the server's crossing swaps to a scene that is
//      already resident. The view is re-expressed in the new frame (api.exterior.crossing), so the camera never
//      jumps. When the destination is still loading, the old scene stays drawn, translated into the new frame
//      (api.rebaseScene), until it arrives. Stale results are discarded, never shown.
//
//   5. keeps every drawn exterior in the season's look (client/world/exterior/season.js): when the shared clock
//      crosses into or out of Winter, the drawn scenes get their winter or summer textures in place (same mesh,
//      geometry, collision and positions; one background build at a time, never per tick), cached scenes nobody
//      draws are dropped to be rebuilt on demand, and the day sky follows climate, season and weather.
//
// Browser events it publishes:
//   'wildernessScene' {location, status: 'loading'|'ready'|'error', message?, site?, stats?, warnings?}
//   'exteriorLook'    {key, look: {winter}, changed} after a drawn scene took the season's textures
//   'exteriorSky'     {sky: {pixels, width, height, horizon, zenith, index, file}, town} for the current exterior
// It sets api.wilderness = { location, heightAt(x, z), scene } while a wilderness scene is shown, and
// api.exterior = { ready(id), load(id), crossing(from, to), stats(), frames() } for the shell and travel.

import { PALETTE } from '../render/renderer.js';
import { buildWildernessScene, parseWildernessLocation, neighbourLocations } from '../world/wilderness/scene.js';
import { ExteriorStream } from '../world/exterior/stream.js';
import { groundFor } from '../lib/ground.js';
import * as M from '../lib/mat.js';
import { SceneryPass } from './scenery/pass.js';
import { locationOf } from './api.js';
import { sceneLocationId } from './travel.js';
import { lookFor, lookOf, sameLook, reskinMesh, skyIndexFor, sceneClimate, hasWinterSwap } from '../world/exterior/season.js';
import { readClassicSky, skyFileName, DEFAULT_SKY_FRAME } from '../world/scenery/sky.js';
import { readBlob } from '../world/bsa.js';
import { WEATHER_PERIOD_HOURS, regionOf } from './atmosphere/calendar.js';

export const name = 'wilderness';
export const SCENE_URL = '/api/wilderness/scene';
const SWEEP_MS = 15000;
const PLAN_EVERY_MS = 500;
const DESCRIPTORS = 96;
/** How often the season and sky are compared with what is drawn (a comparison, not a rebuild). */
const LOOK_EVERY_MS = 1000;
/** A new look must hold this long before scenes change (clock corrections around a boundary). */
const LOOK_SETTLE_MS = 1500;
/** A failed seasonal rebuild is tried again after this long. */
const LOOK_RETRY_MS = 20000;
/** Arrival waits this long for the server's clock before showing a place as built: a missing clock must not hold the loading screen. */
const SEASON_WAIT_MS = 5000;
const SKY_CACHE = 4;

/** Read one SKYnn.DAT day sky from the player's files (the frame the scene builders use). */
export async function readSkyFrom(files, index) {
  const name = skyFileName(index);
  const open = (wanted) => {
    const f = files.find((x) => String(x.name ?? '').split('/').pop().toUpperCase() === wanted);
    return f ? { size: f.size, read: (a, n) => readBlob(f, a, n) } : null;
  };
  if (!open(name)) throw new Error(`${name} is not in the selected folder.`);
  // Every frame of the day and the night ridge line; the sky pass picks the hour (client/render/sky-dome.js).
  return readClassicSky(open, index, DEFAULT_SKY_FRAME);
}

/** Fetch one descriptor: the JSON, null for 404 (no site on the pixel), or throw a readable error. */
export async function fetchDescriptor(location, { fetchFn = globalThis.fetch, signal } = {}) {
  let res;
  try {
    res = await fetchFn(`${SCENE_URL}?location=${encodeURIComponent(location)}`, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('The server could not be reached for the site layout.');
  }
  if (res.status === 404) return null;
  if (res.status === 503) {
    let note = '';
    try {
      const detail = await res.json();
      if (detail?.pack === 'missing') return null;
      note = detail?.error ?? '';
    } catch { /* plain text */ }
    throw new Error(note || 'The World of Daggerfall data is not installed or is still loading on the server.');
  }
  if (!res.ok) throw new Error(`The site layout request failed (HTTP ${res.status}).`);
  const d = await res.json();
  if (!d || typeof d !== 'object' || !Array.isArray(d.sites) || !Number.isInteger(d.px) || !Number.isInteger(d.py)) {
    throw new Error('The server sent a malformed site layout.');
  }
  return d;
}

export { neighbourLocations };

const isTownId = (id) => typeof id === 'string' && id.startsWith('town:');
const isExterior = (id) => !!parseWildernessLocation(id) || isTownId(id);
const exteriorMesh = (m) => !!m && (m.kind === 'wilderness' || (!!m.source && (!m.kind || m.kind === 'town' || m.kind === 'exterior')));

export function install(api, {
  build = buildWildernessScene,
  fetchFn = (...a) => globalThis.fetch(...a),
  loadModels = () => import('../world/wilderness/models.js'),
  // The operator's converted World of Daggerfall meshes and textures (loopback pages only; null elsewhere).
  loadPack = () => import('../world/wilderness/localPack.js').then((m) => m.localWodPack()),
  loadTown = (files, o) => import('../world/town.js').then((m) => m.loadTown(files, o)),
  loadScenery = (files, town, o) => import('../world/scenery/index.js').then((m) => m.loadScenery(files, town, o)),
  readCatalog = (maps) => import('./travel/catalog.js').then((m) => m.readCatalog(maps)),
  loadSky = readSkyFrom,
  limits,
  now = () => performance.now(),
} = {}) {
  let pack = null;
  const packNow = () => (pack ??= Promise.resolve().then(loadPack).catch(() => null));
  const S = {
    files: null,
    loading: null, // { location } while the current pixel is building
    scene: null, // current wilderness mesh (primary)
    view: null, // exterior location id whose frame the view is in
    rebased: null, // {from, offset} while an old scene is drawn in a new frame
    crossing: null, // {from, to, shift}: the last re-expression, read by the shell
    overland: null, // {from, to, shift?}: the server's announced overland step
    renderer: null,
    removePass: null,
    palette: null,
    status: 'idle',
    error: null,
    failedLocation: null,
    catalog: null,
    descriptors: new Map(),
    flats: new Map(), // mesh -> {pass, promise}
    sky: null, // {mesh, pass}
    draws: [], // [{pass, offset}] flats drawn this frame
    townFlatsByScenery: null, // town mesh whose flats the scenery feature now draws
    lastPlan: 0,
    lastSweep: 0,
    frames: { total: 0, empty: 0, jumps: 0, duplicates: 0, maxStep: 0, log: [] },
    lastCam: null,
    timeline: [], // [t, dt, E, S, location] per exterior frame
    // Seasonal look (client/world/exterior/season.js)
    clockKnown: false, // the server's clock event arrived: the season is the shared one, not a guess
    look: null, // {winter} every drawn scene should have
    lookCandidate: null, // {look, since} while a new look settles
    lastLook: -Infinity,
    reskin: null, // {mesh, key, ctrl, look} the one background build in flight
    reskinFailed: new WeakMap(), // mesh -> time of its last failed rebuild
    seasonWaitFrom: null, // when arrival first waited for the server's clock (SEASON_WAIT_MS)
    skies: new Map(), // SKY index -> promise of sky data
    skyWant: null, // index wanted for the current exterior
    skyData: null, // sky data applied for skyWant
    seasonCounters: { reskinned: 0, dropped: 0, discarded: 0, failed: 0, skySwaps: 0 },
  };
  const filesNow = () => (S.files && S.files.length ? S.files : Array.from(api.files ?? []));
  const emit = (detail) => api.emit('wildernessScene', detail);
  const rendererNow = () => api.renderer ?? api.frame?.renderer ?? null;

  // ------------------------------------------------------------------ builders

  function descriptor(location) {
    let p = S.descriptors.get(location);
    if (!p) {
      p = fetchDescriptor(location, { fetchFn });
      S.descriptors.set(location, p);
      p.catch(() => S.descriptors.delete(location));
      if (S.descriptors.size > DESCRIPTORS) S.descriptors.delete(S.descriptors.keys().next().value);
    }
    return p;
  }

  async function catalogNow(files) {
    if (S.catalog?.files === files) return S.catalog.promise;
    const maps = files.find((f) => /(^|\/)MAPS\.BSA$/i.test(f.name ?? ''));
    const promise = maps ? readCatalog(maps).catch(() => null) : Promise.resolve(null);
    S.catalog = { files, promise, value: null };
    promise.then((c) => { if (S.catalog?.promise === promise) S.catalog.value = c; });
    return promise;
  }

  /** The look new scenes are built with: the settled one, else the clock's season (corrected later if wrong). */
  function lookNow() {
    if (S.look) return S.look;
    const season = api.atmosphere?.now?.()?.date?.season;
    return season ? lookFor(season) : { winter: false };
  }

  async function buildWild(location, ctrl) {
    const mesh = await makeWild(location, ctrl, lookNow());
    groundFor(mesh); // the shell and actors reuse it on arrival
    await rendererNow()?.prepareExterior?.(mesh, ctrl);
    return mesh;
  }

  async function makeWild(location, ctrl, look) {
    const at = parseWildernessLocation(location);
    const files = filesNow();
    if (!files.length) throw new Error('Your Daggerfall files are not loaded, so the wilderness cannot be drawn.');
    const [d, models, localPack, ...around] = await Promise.all([
      descriptor(location),
      Promise.resolve().then(loadModels).catch(() => null),
      packNow(),
      ...neighbourLocations(at.px, at.py).map((l) => descriptor(l).catch(() => null)),
    ]);
    if (ctrl.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const neighbours = new Map();
    for (const n of around) if (n) neighbours.set(`${n.px},${n.py}`, n);
    const season = api.atmosphere?.now()?.date?.season?.toLowerCase() ?? 'summer';
    const mesh = await build({
      files, descriptor: d, location, neighbours, signal: ctrl, models,
      vertexColors: false,
      season, winter: !!look.winter,
      loadAsset: localPack?.loadAsset ? (n, c) => localPack.loadAsset(n, c) : undefined,
      loadTexture: localPack?.loadTexture ? (p) => localPack.loadTexture(p) : undefined,
    });
    mesh.look ??= { winter: !!look.winter };
    return mesh;
  }

  async function buildTown(id, placement, ctrl) {
    const mesh = await makeTown(id, placement, ctrl, lookNow());
    groundFor(mesh);
    await rendererNow()?.prepareExterior?.(mesh, ctrl);
    return mesh;
  }

  async function makeTown(id, placement, ctrl, look) {
    const files = filesNow();
    if (!files.length) throw new Error('Your Daggerfall files are not loaded.');
    let region = placement?.regionIndex, location = placement?.index;
    if (!Number.isInteger(region) || !Number.isInteger(location)) {
      const entry = (await catalogNow(files))?.get(id);
      if (!entry) throw new Error(`${id} is not in this MAPS.BSA.`);
      region = entry.regionIndex; location = entry.index;
    }
    if (ctrl.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const mesh = await loadTown(files, { region, location, winter: !!look.winter });
    mesh.look ??= { winter: !!look.winter };
    return mesh;
  }

  const stream = new ExteriorStream({
    buildWild, buildTown, limits, now,
    townPixel(id) {
      // The town on screen names its own pixel (MapsFile.LongitudeLatitudeToMapPixel).
      const src = api.town?.source;
      if (src && Number.isFinite(src.longitude) && sceneLocationId(api.town) === id) {
        return { px: Math.trunc(src.longitude / 128), py: 499 - Math.trunc(src.latitude / 128) };
      }
      const e = S.catalog?.value?.get(id);
      if (e) return { px: e.x, py: e.y };
      if (filesNow().length) catalogNow(filesNow()).then((c) => { if (c?.get(id)) compose(); });
      return null;
    },
    onReady(key, mesh) {
      rendererNow()?.retain(mesh); // upload once, while nothing is crossing
      // Collision (and anyone else) can prepare this place before the player reaches it.
      api.emit('exteriorScene', { key, mesh, status: 'ready' });
      compose();
    },
    onEvict(mesh, key) {
      api.emit('exteriorScene', { key, mesh, status: 'evicted' });
      rendererNow()?.release(mesh);
      const f = S.flats.get(mesh);
      f?.pass?.release();
      S.flats.delete(mesh);
      if (S.sky?.mesh === mesh) { S.sky.pass.release(); S.sky = null; }
    },
  });

  // ------------------------------------------------------------------ passes

  /**
   * One flats record per scene mesh, shared by every view of it: the stream's layers, the current
   * scene and the scenery feature (which adds only the town's sky). A failed town build stays failed
   * until retrySceneryFor() (arrival retry, a new scene for that town).
   */
  function sceneryFor(mesh) {
    let f = S.flats.get(mesh);
    if (f) return f;
    f = { pass: null, data: null, promise: null, status: 'loading', error: null };
    S.flats.set(mesh, f);
    if (mesh.kind === 'wilderness') {
      if (mesh.flats?.billboards?.count > 0) f.pass = new SceneryPass({ billboards: mesh.flats.billboards, atlas: mesh.flats.atlas, terrain: null, sky: null });
      f.status = 'ready';
      f.promise = Promise.resolve(null);
    } else if (mesh.source) {
      const files = filesNow();
      f.look = lookOf(mesh);
      f.promise = (files.length ? loadScenery(files, mesh, { terrain: false, winter: f.look.winter }) : Promise.reject(new Error('Your Daggerfall files are not loaded.')))
        .then((data) => {
          if (S.flats.get(mesh) !== f) return data;
          f.data = data;
          f.status = 'ready';
          if (data?.billboards?.count) f.pass = new SceneryPass({ ...data, terrain: null, sky: null });
          return data;
        }, (err) => {
          if (S.flats.get(mesh) === f) { f.status = 'failed'; f.error = err; }
          console.info('[exterior] town flats unavailable:', err?.message ?? err);
          throw err;
        });
      f.promise.catch(() => {});
    } else {
      f.status = 'ready';
      f.promise = Promise.resolve(null);
    }
    return f;
  }
  const flatsFor = (mesh) => sceneryFor(mesh).pass;
  function retrySceneryFor(mesh) {
    if (S.flats.get(mesh)?.status === 'failed') S.flats.delete(mesh);
  }

  function attach() {
    const renderer = rendererNow();
    if (!renderer || typeof renderer.addPass !== 'function' || S.renderer === renderer) return;
    S.removePass?.();
    S.renderer = renderer;
    const vp = new Float32Array(16), T = new Float32Array(16);
    S.removePass = renderer.addPass((gl, r, camera) => {
      const t = performance.now() / 1000;
      for (const d of S.draws) {
        const pass = d.pass ?? (d.mesh ? S.flats.get(d.mesh)?.pass : null);
        if (!pass) continue;
        pass.time = t;
        const [ox, oy, oz] = d.offset;
        if (!ox && !oy && !oz) { pass.draw(gl, r, camera); continue; }
        M.identity(T); T[12] = ox; T[13] = oy; T[14] = oz;
        M.multiply(vp, r.viewProj, T);
        const view = Object.create(r, {
          viewProj: { value: vp },
          eye: { value: [r.eye[0] - ox, r.eye[1] - oy, r.eye[2] - oz] },
        });
        pass.draw(gl, view, camera);
      }
      if (S.sky) { S.sky.pass.time = t; S.sky.pass.draw(gl, r, camera); }
    });
  }

  function setSky(mesh) {
    if (S.sky?.mesh === mesh) return;
    if (S.sky) { S.sky.pass.release(); S.sky = null; }
    restorePalette();
    if (!mesh?.sky) return;
    // The season's or weather's sky once it is loaded for this climate; the scene's own until then.
    const sky = S.skyData && S.skyData.index === S.skyWant && sceneClimate(mesh) === S.skyClimate ? S.skyData : mesh.sky;
    S.sky = { mesh, pass: new SceneryPass({ billboards: { vertices: new Float32Array(0), count: 0 }, atlas: { width: 1, height: 1, pixels: new Uint8Array(4) }, terrain: null, sky }) };
    S.palette = { horizon: [...PALETTE.horizon], zenith: [...PALETTE.zenith] };
    PALETTE.horizon.splice(0, 3, ...sky.horizon);
    PALETTE.zenith.splice(0, 3, ...sky.zenith);
  }

  // ------------------------------------------------------------------ seasonal look and sky

  /** Scenes the player can see now: the current exterior and every layer drawn around it. */
  function drawnMeshes() {
    const out = new Set();
    if (exteriorMesh(api.town) && isExterior(api.location)) out.add(api.town);
    for (const d of S.draws) if (d.mesh) out.add(d.mesh);
    return out;
  }

  const keyOfMesh = (mesh) => mesh.kind === 'wilderness' ? mesh.location : sceneLocationId(mesh);
  const resident = (mesh) => api.town === mesh || [...stream.entries.values()].some((e) => e.state === 'ready' && e.mesh === mesh);

  /** Settled look of the shared clock's season, or null while the clock is unknown. */
  function settledLook(t) {
    // The join-time clock event can reach the atmosphere feature before this one installs.
    if (!S.clockKnown && api.atmosphere?.clockKnown === true) S.clockKnown = true;
    const season = S.clockKnown ? api.atmosphere?.now?.()?.date?.season : null;
    if (!season) return null;
    const want = lookFor(season);
    if (!S.lookCandidate || !sameLook(S.lookCandidate.look, want)) S.lookCandidate = { look: want, since: t };
    if (!S.look || t - S.lookCandidate.since >= LOOK_SETTLE_MS) S.look = S.lookCandidate.look;
    return S.look;
  }

  function lookTick(t) {
    const want = settledLook(t);
    if (!want) return;
    const drawn = drawnMeshes();
    const job = S.reskin;
    if (job && (!sameLook(job.look, want) || !resident(job.mesh) || !drawn.has(job.mesh))) {
      job.ctrl.aborted = true; // the season turned back, or the place is no longer drawn
      S.reskin = null;
      S.seasonCounters.discarded++;
    }
    // Cached scenes nobody draws are rebuilt on demand rather than now.
    for (const [key, e] of [...stream.entries]) {
      if (e.state !== 'ready' || drawn.has(e.mesh) || sameLook(lookOf(e.mesh), want)) continue;
      if (stream.discard(key)) S.seasonCounters.dropped++;
    }
    if (S.reskin) return;
    // The player's arrival builds first; the look waits for it.
    if (stream.running && stream.running.priority >= 2) return;
    const stale = [...drawn].filter((m) => !sameLook(lookOf(m), want) && !(t - (S.reskinFailed.get(m) ?? -Infinity) < LOOK_RETRY_MS));
    // The scene the player stands in first, then its layers.
    stale.sort((a, b) => (b === api.town) - (a === api.town));
    if (stale.length) reskin(stale[0], want);
  }

  function reskin(mesh, look) {
    const key = keyOfMesh(mesh);
    if (!key) return;
    // Desert-based towns (climateBase === 0) keep identical ground, buildings and nature year-round:
    // mark the look in place without rebuilding the scene or re-uploading unchanged textures.
    if (!hasWinterSwap(mesh)) {
      mesh.look = { winter: !!look.winter };
      api.emit('exteriorLook', { key, look: lookOf(mesh), changed: { uv: false, atlas: false, flats: false, mechanisms: 0 } });
      return;
    }
    if (!filesNow().length) return;
    const ctrl = { aborted: false };
    const job = { mesh, key, ctrl, look };
    S.reskin = job;
    const fresh = mesh.kind === 'wilderness'
      ? makeWild(key, ctrl, look)
      : makeTown(key, Number.isInteger(mesh.source?.regionIndex) && Number.isInteger(mesh.source?.locationIndex)
        ? { regionIndex: mesh.source.regionIndex, index: mesh.source.locationIndex } : stream.placements.get(key) ?? null, ctrl, look);
    fresh.then((built) => {
      if (S.reskin !== job) return; // replaced or abandoned: a stale result is never shown
      S.reskin = null;
      if (ctrl.aborted || !sameLook(S.look, look) || !resident(mesh) || !drawnMeshes().has(mesh)) { S.seasonCounters.discarded++; return; }
      const changed = reskinMesh(mesh, built);
      if (!changed) {
        S.seasonCounters.failed++;
        S.reskinFailed.set(mesh, now());
        console.warn('[exterior] the seasonal build of', key, 'has different geometry; the old look stays.');
        return;
      }
      const r = rendererNow();
      if (changed.uv || changed.atlas || changed.mechanisms) r?.reskin?.(mesh, changed);
      refreshFlats(mesh, changed);
      S.seasonCounters.reskinned++;
      api.emit('exteriorLook', { key, look: lookOf(mesh), changed });
      compose();
    }, (err) => {
      if (S.reskin !== job) return;
      S.reskin = null;
      if (err?.name === 'AbortError') return;
      S.seasonCounters.failed++;
      S.reskinFailed.set(mesh, now());
      console.warn('[exterior] could not change the look of', key, err?.message ?? err);
    });
  }

  /** The nature (wilderness) or town flats of a reskinned scene, swapped once the new pass is ready. */
  function refreshFlats(mesh, changed) {
    const old = S.flats.get(mesh);
    if (mesh.kind === 'wilderness') {
      if (!changed.flats || !old) return;
      old.pass?.release();
      old.pass = mesh.flats?.billboards?.count > 0 ? new SceneryPass({ billboards: mesh.flats.billboards, atlas: mesh.flats.atlas, terrain: null, sky: null }) : null;
      return;
    }
    if (!mesh.source || !old || sameLook(old.look, lookOf(mesh))) return;
    const files = filesNow();
    if (!files.length) return;
    const look = lookOf(mesh);
    old.look = look;
    loadScenery(files, mesh, { terrain: false, winter: look.winter }).then((data) => {
      if (S.flats.get(mesh) !== old || !sameLook(lookOf(mesh), look)) return;
      const previous = old.pass;
      old.data = data;
      old.pass = data?.billboards?.count ? new SceneryPass({ ...data, terrain: null, sky: null }) : null;
      old.promise = Promise.resolve(data);
      previous?.release();
    }, (err) => console.info('[exterior] seasonal town flats unavailable:', err?.message ?? err));
  }

  /** The day sky for the climate the player stands in, the season and the weather (DaggerfallSky). */
  function skyTick() {
    const primary = api.town;
    if (!exteriorMesh(primary) || !isExterior(api.location)) return;
    const climate = sceneClimate(primary);
    const info = api.atmosphere?.now?.();
    if (climate === null || !info?.date?.season || info.indoors) return;
    const variant = `${regionOf(api.location)}#${Math.floor((info.minutes ?? 0) / (WEATHER_PERIOD_HOURS * 60))}`;
    const index = skyIndexFor(climate, info.date.season, info.weather, variant);
    if (index === S.skyWant && climate === S.skyClimate) return;
    S.skyWant = index;
    S.skyClimate = climate;
    const files = filesNow();
    if (!files.length) return;
    let p = S.skies.get(index);
    if (!p) {
      p = Promise.resolve().then(() => loadSky(files, index));
      S.skies.set(index, p);
      p.catch(() => S.skies.delete(index));
      if (S.skies.size > SKY_CACHE) S.skies.delete(S.skies.keys().next().value);
    }
    p.then((sky) => {
      if (S.skyWant !== index || S.skyClimate !== climate) return; // the weather or place moved on
      applySky(sky);
    }, (err) => console.info('[exterior] sky unavailable:', err?.message ?? err));
  }

  function applySky(sky) {
    if (S.skyData === sky) return;
    S.skyData = sky;
    S.seasonCounters.skySwaps++;
    if (S.sky) {
      S.sky.pass.setSky(sky);
      PALETTE.horizon.splice(0, 3, ...sky.horizon);
      PALETTE.zenith.splice(0, 3, ...sky.zenith);
    }
    // The scenery feature draws a town's sky; it takes the same one.
    api.emit('exteriorSky', { sky, town: api.town });
  }

  function restorePalette() {
    if (!S.palette) return;
    for (const k of Object.keys(S.palette)) PALETTE[k].splice(0, 3, ...S.palette[k]);
    S.palette = null;
  }

  // ------------------------------------------------------------------ composition

  /** Draw the current exterior with every resident layer around it. */
  function compose() {
    const renderer = rendererNow();
    const view = S.view;
    if (!view || !renderer) return;
    // An old-frame camera at the north edge looks like the far edge of the
    // destination until the next frame. Do not start building that distant pixel.
    const at = api.frame?.location === view ? api.frame.camera : null;
    const plan = stream.plan(view, at && { x: at.x, z: at.z });
    stream.pin(plan.need.keys());
    for (const [key, priority] of plan.need) if (key !== view || !stream.ready(key)) stream.request(key, priority);
    // While an old scene is drawn in the new frame, its layers keep their old placement too.
    const extra = S.rebased ? S.rebased.offset : [0, 0, 0];
    const base = S.rebased ? stream.plan(S.rebased.from, null) : plan;
    const layers = base.layers.map((l) => ({ ...l, offset: [l.offset[0] + extra[0], l.offset[1] + extra[1], l.offset[2] + extra[2]] }));
    renderer.setLayers(layers);
    const primary = api.town;
    const draws = [];
    if (primary && exteriorMesh(primary)) {
      // The current town's flats are the same shared pass its layer drew a moment ago.
      flatsFor(primary);
      draws.push({ mesh: primary, offset: extra });
    }
    for (const l of layers) { flatsFor(l.mesh); draws.push({ mesh: l.mesh, offset: l.offset }); }
    S.draws = draws;
    const skyFrom = primary?.kind === 'wilderness' ? primary : (layers.find((l) => l.mesh.kind === 'wilderness' && l.key === base.surround)?.mesh ?? null);
    // A town's own scenery feature brings its classic sky; a pixel brings its own.
    if (primary?.kind === 'wilderness' || !S.townFlatsByScenery) setSky(skyFrom);
    else setSky(null);
    attach();
  }

  function clearView() {
    S.view = null;
    S.rebased = null;
    S.draws = [];
    if (S.reskin) { S.reskin.ctrl.aborted = true; S.reskin = null; S.seasonCounters.discarded++; }
    setSky(null);
    rendererNow()?.setLayers([]);
    stream.pin([]);
    if (S.scene && api.wilderness?.scene === S.scene) api.wilderness = null;
    S.scene = null;
  }

  /** A scene was applied (by us, travel, interiors or the shell's first town). */
  function onScene(mesh) {
    const loc = api.location;
    if (exteriorMesh(mesh) && !loc) return; // the shell's first town, before the server names our place (sync adopts it)
    if (!exteriorMesh(mesh) || !isExterior(loc)) { clearView(); return; }
    stream.adopt(loc, mesh);
    S.view = loc;
    S.rebased = null;
    if (mesh.kind === 'wilderness') {
      S.scene = mesh;
      api.wilderness = { location: mesh.location, scene: mesh, heightAt: mesh.wilderness.heightAt };
    } else {
      if (S.scene && api.wilderness?.scene === S.scene) api.wilderness = null;
      S.scene = null;
      if (S.townFlatsByScenery !== mesh) S.townFlatsByScenery = null;
    }
    compose();
  }

  // ------------------------------------------------------------------ location changes

  /** Re-express the view when the server moves us between adjacent exteriors. */
  function cross(from, to) {
    S.crossing = null;
    // Only a server overland step is carried; fast travel, even to a neighbour, resets the view.
    const announced = S.overland && S.overland.from === from && S.overland.to === to ? S.overland : null;
    S.overland = null;
    if (!announced) {
      // An uncarried move leaves no translated scene behind: the next applied scene replaces it.
      if (S.rebased) { S.rebased = null; api.rebaseScene?.([0, 0, 0]); }
      return;
    }
    if (!isExterior(from) || !isExterior(to) || S.view !== from) return;
    if (S.rebased && to === S.rebased.from && api.town && stream.ready(to) === api.town) {
      // Turned back before the destination loaded: the scene on screen is already the right one.
      const [x, y, z] = S.rebased.offset;
      S.crossing = { from, to, shift: { x: -x, y: -y, z: -z, provisional: false } };
      S.rebased = null;
      S.view = to;
      api.rebaseScene?.([0, 0, 0]);
      compose();
      return;
    }
    let shift = stream.crossing(from, to);
    // Cold exterior without both anchors: the server's own conversion, height provisional until the scene arrives.
    if (!shift && announced.shift && Number.isFinite(announced.shift.x) && Number.isFinite(announced.shift.z)) {
      shift = { x: announced.shift.x, y: 0, z: announced.shift.z, provisional: true };
    }
    if (!shift) return;
    S.crossing = { from, to, shift };
    // Until the destination's scene is actually applied (even a resident one is published a task or more
    // later), keep drawing the old scene and its ground where they were, now in the new frame.
    const prior = S.rebased?.offset ?? [0, 0, 0];
    const offset = [prior[0] + shift.x, prior[1] + shift.y, prior[2] + shift.z];
    S.rebased = { from: S.rebased?.from ?? from, offset };
    S.view = to;
    api.rebaseScene?.(offset);
    compose();
  }

  function loadWild(location) {
    if (S.failedLocation === location) return;
    const mesh = stream.ready(location);
    if (mesh) {
      if (api.town === mesh) return;
      api.setScene(mesh, { location }).then((applied) => { if (applied) ready(location, mesh); });
      return;
    }
    if (S.loading?.location === location) return;
    S.loading = { location };
    S.status = 'loading';
    S.error = null;
    emit({ location, status: 'loading', message: 'Loading the site…' });
    const p = stream.request(location, 3);
    api.setScene(p.catch(() => null), { location }).then(async (applied) => {
      if (S.loading?.location === location) S.loading = null;
      let m = null, err = null;
      try { m = await p; } catch (e) { err = e; }
      if (api.location !== location || err?.name === 'AbortError') return; // overtaken: nothing to report
      if (err) {
        S.status = 'error';
        S.failedLocation = location;
        S.error = err;
        console.warn('[wilderness] could not draw', location, err);
        emit({ location, status: 'error', message: err.message ?? String(err) });
        api.emit('sceneError', { location, message: err.message ?? String(err), source: 'wilderness' });
        api.message?.(`Could not draw this place: ${err.message ?? err}`, { kind: 'error' });
        return;
      }
      if (applied && m) ready(location, m);
    });
  }

  function ready(location, mesh) {
    S.status = 'ready';
    for (const w of mesh.warnings ?? []) console.info('[wilderness]', w);
    const site = mesh.wilderness.sites.find((s) => s.pixel === `${mesh.wilderness.px},${mesh.wilderness.py}`) ?? null;
    emit({
      location, status: 'ready', site: site && { id: site.id, name: site.name, kind: site.kind, prefab: site.prefab },
      climate: mesh.wilderness.climate, stats: mesh.stats, warnings: mesh.warnings,
    });
  }

  let lastLocation = api.location ?? null;
  function sync() {
    const loc = api.location;
    if (loc !== lastLocation) {
      cross(lastLocation, loc);
      lastLocation = loc;
      // Movement and collision read api.wilderness in the current location's frame only.
      if (api.wilderness && api.wilderness.location !== loc) api.wilderness = null;
      // Work for places the new location will not draw stops now (fast travel, interiors).
      const keep = new Set(isExterior(loc) ? stream.plan(loc).need.keys() : []);
      const px = isExterior(loc) ? stream.pixelOf(loc) : null;
      if (px) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keep.add(`wilderness:${px.px + dx},${px.py + dy}`);
      if (S.view) for (const k of stream.plan(S.view).need.keys()) keep.add(k);
      if (S.view && !isExterior(loc)) keep.clear();
      stream.cancelExcept(keep);
      if (S.reskin && !drawnMeshes().has(S.reskin.mesh)) {
        S.reskin.ctrl.aborted = true;
        S.reskin = null;
        S.seasonCounters.discarded++;
      }
    }
    if (parseWildernessLocation(loc)) {
      loadWild(loc);
    } else {
      S.loading = null;
      S.failedLocation = null;
      if (!isExterior(loc)) S.status = 'idle';
    }
    if (isTownId(loc) && S.view !== loc && !S.rebased) {
      // The shell's starting town is already on screen: adopt it rather than building it again.
      const shown = api.town;
      if (exteriorMesh(shown) && shown.source && sceneLocationId(shown) === loc) onScene(shown);
      else stream.request(loc, 3);
    }
  }

  /**
   * Track overland steps announced ahead of their snapshot. A second step before the snapshot
   * (a quick reversal) extends the chain; back to where we stand cancels it. Any other move
   * (fast travel, a teleport, defeat) clears it, so it is never carried.
   */
  function onOverlandEvent(ev) {
    if (!ev || typeof ev.kind !== 'string') return;
    if (ev.kind !== 'overland') {
      if (['travel', 'teleport', 'defeat', 'resurrect', 'portal'].includes(ev.kind)) S.overland = null;
      return;
    }
    if (ev.status !== 'moved') return;
    const shift = ev.shift && Number.isFinite(ev.shift.x) && Number.isFinite(ev.shift.z) ? ev.shift : null;
    if (ev.from === api.location) { S.overland = { from: ev.from, to: ev.to, shift }; return; }
    const p = S.overland;
    if (p && ev.from === p.to) {
      if (ev.to === p.from) { S.overland = null; return; }
      S.overland = { from: p.from, to: ev.to, shift: p.shift && shift ? { x: p.shift.x + shift.x, z: p.shift.z + shift.z } : null };
      return;
    }
    S.overland = null; // out of order: never guess
  }

  // ------------------------------------------------------------------ frame diagnostics

  function onFrame(f) {
    attach();
    const t = now();
    // Season and sky first: a comparison each second, never a rebuild unless the look changed.
    if (t - S.lastLook > LOOK_EVERY_MS) {
      S.lastLook = t;
      try { lookTick(t); skyTick(); } catch (err) {
        if (!S.lookError) console.warn('[exterior] season check failed:', err);
        S.lookError = String(err?.message ?? err);
      }
    }
    if (S.view && t - S.lastPlan > PLAN_EVERY_MS) { S.lastPlan = t; compose(); }
    if (t - S.lastSweep > SWEEP_MS) { S.lastSweep = t; stream.enforce(true); }
    // Continuity: the camera in absolute exterior coordinates must not jump between frames.
    const cam = f?.camera;
    if (!cam || !isExterior(api.location)) { S.lastCam = null; return; }
    const r = f.renderer ?? rendererNow();
    S.frames.total++;
    const drawn = !!r?.mesh && exteriorMesh(r.town);
    if (!drawn) S.frames.empty++;
    // The same place twice: a layer repeating the scene, or two layers of one mesh or one town.
    const meshes = (r?.layers ?? []).map((l) => l.mesh);
    const names = meshes.map((m) => m.location ?? (m.source ? sceneLocationId(m) : null)).filter(Boolean);
    const own = r?.town ? (r.town.location ?? (r.town.source ? sceneLocationId(r.town) : null)) : null;
    if (new Set(meshes).size !== meshes.length || meshes.includes(r?.town) || new Set(names).size !== names.length || (own && names.includes(own))) S.frames.duplicates++;
    const a = stream.anchor(S.view ?? api.location);
    if (!a) { S.lastCam = null; return; }
    const abs = { e: a.e + cam.x, s: a.s + cam.z, at: t };
    S.timeline.push([Math.round(t), S.lastCam ? Math.round(t - S.lastCam.at) : 0, +abs.e.toFixed(2), +abs.s.toFixed(2), api.location]);
    if (S.timeline.length > 4000) S.timeline.splice(0, 1000);
    if (S.lastCam) {
      const step = Math.hypot(abs.e - S.lastCam.e, abs.s - S.lastCam.s);
      // Faster than any walk or ride could cover in this frame's time: the view jumped.
      const allowed = 1 + 20 * Math.max(0, t - S.lastCam.at) / 1000;
      S.frames.maxStep = Math.max(S.frames.maxStep, step);
      if (step > allowed) { S.frames.jumps++; S.frames.log.push({ at: t, step, location: api.location }); if (S.frames.log.length > 20) S.frames.log.shift(); }
    }
    S.lastCam = abs;
  }

  const off = [
    api.on('wildernessPack', (selected) => {
      pack = Promise.resolve(selected);
      stream.clear();
      S.descriptors.clear();
      S.failedLocation = null;
      if (S.view) { const v = S.view; clearView(); if (api.town && exteriorMesh(api.town)) onScene(api.town); else S.view = v; }
      sync();
    }),
    api.on('assets', (files) => {
      S.files = Array.from(files ?? []);
      S.catalog = null;
      if (parseWildernessLocation(api.location) && S.status === 'error') { S.failedLocation = null; sync(); }
    }),
    api.on('event', (ev) => {
      // The shared clock: from now on the season is the server's, not the local estimate.
      if (ev?.kind === 'clock') { S.clockKnown = true; S.lastLook = -Infinity; }
      // Sent before the new-frame position and the location change (server/rpg/overland.js).
      onOverlandEvent(ev);
    }),
    // Leaving the game (disconnect, return to the title or loading screen) abandons any handoff in flight.
    api.on('screen', (screen) => {
      if (screen === 'game') return;
      S.overland = null;
      // Signed out or reconnecting: the next clock event names the season again.
      S.clockKnown = false; S.look = null; S.lookCandidate = null; S.seasonWaitFrom = null;
      if (S.reskin) { S.reskin.ctrl.aborted = true; S.reskin = null; }
    }),
    api.on('location', sync),
    api.on('state', (state) => { if (locationOf(state) !== lastLocation) sync(); }),
    api.on('scene', onScene),
    api.on('scenery', () => {
      // The scenery feature now draws the current town's flats and sky; stop drawing ours.
      if (api.town?.source) { S.townFlatsByScenery = api.town; compose(); }
    }),
    api.on('frame', onFrame),
  ];

  /** Scenes the player sees on arrival at `location`: the place, its surroundings and visible towns, not prefetches. */
  function required(location) {
    const plan = stream.plan(location, null);
    return [...plan.need].filter(([, p]) => p >= 1).map(([k]) => k);
  }

  /**
   * Is everything visible on arrival at `location` built? Drives the work itself, so it progresses while the
   * loading screen hides the game. `{retry: true}` clears earlier failures of these parts and starts again.
   */
  function arrival(location, { retry = false } = {}) {
    if (!isExterior(location)) return { status: 'ready', parts: {} };
    if (!filesNow().length) return { status: 'loading', parts: {}, waiting: 'files' };
    if (retry) {
      for (const k of required(location)) {
        stream.forget(k);
        const m = stream.ready(k);
        if (m) retrySceneryFor(m);
      }
      if (api.town) retrySceneryFor(api.town);
    }
    const parts = {};
    let status = 'ready', error = null;
    const shown = api.town && exteriorMesh(api.town) && (api.town.location ?? sceneLocationId(api.town)) === location ? api.town : null;
    if (shown && S.view !== location && !S.rebased) onScene(shown);
    // Before the surroundings are known, only the place itself (and its pixel, for a town) can be named.
    for (const key of required(location)) {
      const mesh = key === location && shown ? shown : stream.ready(key);
      if (!mesh) {
        const e = stream.entries.get(key);
        if (e?.state === 'error') {
          parts[key] = 'failed';
          if (status !== 'failed') { status = 'failed'; error = e.error?.message ?? String(e.error); }
          continue;
        }
        if (!(key === location && isTownId(key))) stream.request(key, key === location ? 3 : 2); // the town itself arrives through travel
        parts[key] = 'loading';
        if (status === 'ready') status = 'loading';
        continue;
      }
      const f = sceneryFor(mesh);
      parts[key] = f.status === 'ready' ? 'ready' : f.status;
      if (f.status === 'failed') { if (status !== 'failed') { status = 'failed'; error = f.error?.message ?? String(f.error); } }
      else if (f.status !== 'ready' && status === 'ready') status = 'loading';
    }
    const plan = stream.plan(location, null);
    // A town whose pixel has not been built yet does not know its neighbours: not ready until it does.
    if (isTownId(location) && plan.surround && !stream.ready(plan.surround) && status === 'ready') status = 'loading';
    // The season's textures before the first visible frame: wait for the shared clock, then swap any drawn scene
    // built in another look (the shell's bootstrap town is always summer). A failed swap keeps the old look.
    if (status === 'ready' && api.atmosphere) {
      const want = settledLook(now());
      if (!want) {
        S.seasonWaitFrom ??= now();
        if (now() - S.seasonWaitFrom < SEASON_WAIT_MS) status = 'loading';
      } else if ([...drawnMeshes()].some((m) => !sameLook(lookOf(m), want) && !S.reskinFailed.has(m))) {
        lookTick(now());
        status = 'loading';
      }
    }
    return error ? { status, error, parts } : { status, parts };
  }

  api.exterior = {
    stream,
    arrival,
    /** The look drawn scenes are kept in ({winter}), or null before the shared clock is known. */
    look: () => (S.look ? { ...S.look } : null),
    /** The sky the current exterior should show (season and weather), once loaded; else null. */
    sky: (mesh = api.town) => (S.skyData && S.skyData.index === S.skyWant && sceneClimate(mesh) === S.skyClimate ? S.skyData : null),
    /** Town flats and sky shared with the scenery feature: resolves with loadScenery() data (no apron). */
    townScenery: (mesh, { retry = false } = {}) => { if (retry) retrySceneryFor(mesh); return sceneryFor(mesh).promise; },
    townSceneryPass: (mesh) => S.flats.get(mesh)?.pass ?? null,
    ready: (id) => stream.ready(id),
    /** The scene for an exterior id, shared with the layers that already draw it. */
    load: (id) => stream.request(id, 3),
    /** `{x, y, z}` to add to a position of `from` to express it in `to`, when the view was carried across. */
    /** The overland step the server announced and whose snapshot has not arrived yet, or null. */
    pendingCrossing() { return S.overland ? { from: S.overland.from, to: S.overland.to } : null; },
    crossing(from, to) {
      const c = S.crossing;
      return c && c.from === from && c.to === to ? c.shift : null;
    },
    stats() {
      const r = rendererNow();
      return {
        view: S.view, rebased: S.rebased && { from: S.rebased.from, offset: S.rebased.offset },
        cache: stream.stats(), gpu: r?.gpuStats?.() ?? null,
        season: {
          look: S.look && { ...S.look }, clockKnown: S.clockKnown, reskinning: S.reskin?.key ?? null, error: S.lookError ?? null,
          sky: S.skyData ? { index: S.skyData.index, file: S.skyData.file } : null, skyWanted: S.skyWant,
          drawn: [...drawnMeshes()].map((m) => ({ key: keyOfMesh(m), winter: lookOf(m).winter })),
          ...S.seasonCounters,
        },
        layers: (r?.layers ?? []).length, flats: S.flats.size, draws: S.draws.length,
        frames: { ...S.frames, log: [...S.frames.log] },
      };
    },
    timeline(since = 0) { return S.timeline.filter((f) => f[0] >= since); },
    resetFrames() { S.frames = { total: 0, empty: 0, jumps: 0, duplicates: 0, maxStep: 0, log: [] }; S.lastCam = null; },
  };

  if (api.town && exteriorMesh(api.town) && isExterior(api.location)) onScene(api.town);
  if (api.location) sync();

  return {
    get status() { return S.status; },
    get scene() { return S.scene; },
    get error() { return S.error; },
    stream,
    reload() { stream.clear(); S.descriptors.clear(); S.failedLocation = null; S.view = null; sync(); },
    dispose() {
      for (const f of off) f();
      clearView();
      stream.clear();
      for (const f of S.flats.values()) f.pass?.release();
      S.flats.clear();
      S.removePass?.();
      if (api.exterior?.stream === stream) api.exterior = null;
    },
  };
}
