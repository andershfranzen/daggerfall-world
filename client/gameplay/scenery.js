// Classic scenery: for the current town, RMB flats (trees, lamps, signs,
// animals, decorations), the climate's SKYnn.DAT day sky, and a terrain apron with
// nature flats shaped by WOODS.WLD; for a building interior, its lamps and decorations
// (scenery/interiorFlats.js). All from the player's own files.
//
// install(api) listens to:
//   assets  - the selected File array (falls back to api.files)
//   scene   - the town from world/town.js; scenery is (re)built for it
//   location/state - a location change drops the old town's scenery at once
//   frame   - (re)attaches the draw pass to the renderer (Renderer.addPass); the
//             pass is also attached from api.renderer as soon as a build finishes
// Loading, fallbacks and the data contract: client/world/scenery/README.md.

import { PALETTE } from '../render/renderer.js';
import { loadScenery } from '../world/scenery/index.js';
import { SceneryPass } from './scenery/pass.js';
import { hasInteriorFlats, loadInteriorFlats } from './scenery/interiorFlats.js';
import { locationOf } from './api.js';
import { sceneLocation } from '../lib/arrival.js';

export function install(api, { load = loadScenery, loadInterior = loadInteriorFlats } = {}) {
  const S = {
    files: null,
    town: null,
    location: null,
    gen: 0,
    data: null,
    pass: null,
    renderer: null,
    removePass: null,
    palette: null, // saved PALETTE values while the classic sky colours are applied
    status: 'idle',
    error: null,
  };

  const filesNow = () => (S.files && S.files.length ? S.files : Array.from(api.files ?? []));

  function detach() {
    S.removePass?.();
    S.removePass = null;
    S.renderer = null;
  }

  function restorePalette() {
    if (!S.palette) return;
    for (const k of Object.keys(S.palette)) PALETTE[k].splice(0, 3, ...S.palette[k]);
    S.palette = null;
  }

  function clear(status = 'idle') {
    S.retry = S.status === 'failed';
    S.gen++;
    detach();
    S.pass?.release();
    S.pass = null;
    S.data = null;
    restorePalette();
    S.status = status;
  }

  function attach(renderer) {
    if (!renderer || !S.pass) return;
    if (S.renderer !== renderer) {
      detach();
      if (typeof renderer.addPass !== 'function') return;
      S.renderer = renderer;
      const pass = S.pass;
      S.removePass = renderer.addPass((gl, r, camera) => {
        pass.time = performance.now() / 1000; // same clock as the shell's frame.now
        pass.draw(gl, r, camera);
      });
    }
  }

  /** A building interior's lamps and decorations (no sky or terrain; the shared palette is left alone). */
  async function buildInterior(mesh) {
    const gen = ++S.gen;
    S.status = 'loading';
    S.error = null;
    let data;
    try {
      data = await loadInterior(filesNow(), mesh);
    } catch (err) {
      if (gen !== S.gen) return;
      S.status = 'failed';
      S.error = err;
      console.warn('[scenery] could not build the interior flats:', err);
      return;
    }
    if (gen !== S.gen || mesh !== S.town) return;
    for (const w of data.warnings) console.warn('[scenery]', w);
    S.data = data;
    S.pass = data.billboards.count ? new SceneryPass(data) : null;
    S.status = 'ready';
    attach(api.renderer ?? api.frame?.renderer);
  }

  async function build(town) {
    if (hasInteriorFlats(town)) return buildInterior(town);
    const gen = ++S.gen;
    S.status = 'loading';
    S.error = null;
    let data;
    // With exterior streaming the town's flats are one shared build and pass (client/gameplay/wilderness.js), drawn
    // with its layers and already built while it stood beside the road; this feature adds only its sky. The
    // town's own pixel terrain surrounds it, so the separate WOODS apron is not built.
    const shared = typeof api.exterior?.townScenery === 'function';
    try {
      data = await (shared ? api.exterior.townScenery(town, { retry: S.status === 'failed' || S.retry }) : load(filesNow(), town));
    } catch (err) {
      if (gen !== S.gen) return;
      S.status = 'failed';
      S.error = err;
      console.warn('[scenery] could not build the town scenery:', err);
      return;
    }
    if (gen !== S.gen || town !== S.town) return;
    for (const w of data.warnings) console.warn('[scenery]', w);
    // The season's or weather's sky (client/gameplay/wilderness.js) replaces the one the flats were built with.
    const seasonal = shared ? api.exterior.sky?.(town) : null;
    if (seasonal && data.sky) data = { ...data, sky: seasonal };
    S.data = data;
    S.pass = shared
      ? (data.sky ? new SceneryPass({ billboards: { vertices: new Float32Array(0), count: 0 }, atlas: { width: 1, height: 1, pixels: new Uint8Array(4) }, terrain: null, sky: data.sky }) : null)
      : new SceneryPass(data);
    if (data.sky) {
      S.palette = { horizon: [...PALETTE.horizon], zenith: [...PALETTE.zenith] };
      PALETTE.horizon.splice(0, 3, ...data.sky.horizon);
      PALETTE.zenith.splice(0, 3, ...data.sky.zenith);
    }
    S.status = 'ready';
    attach(api.renderer ?? api.frame?.renderer);
    api.emit('scenery', { town: data.town, stats: data.stats, warnings: data.warnings });
  }

  function setScene(mesh) {
    const exterior = mesh?.source ? mesh : mesh?.town;
    const town = hasInteriorFlats(mesh) ? mesh
      : exterior?.source && (!exterior.kind || exterior.kind === 'town' || exterior.kind === 'exterior') ? exterior : null;
    if (town === S.town && (S.data || S.status === 'loading')) return;
    clear();
    S.town = town;
    if (!town) return;
    if (!filesNow().length) { S.status = 'waiting'; return; }
    build(town);
  }

  function onLocation(loc) {
    if (!loc || loc === S.location) return;
    const previous = S.location;
    S.location = loc;
    // A new location's town arrives as a new scene; until then, draw nothing stale.
    if (previous !== null) {
      if (sceneLocation(api.town) === loc) {
        setScene(api.town);
      } else {
        clear();
        S.town = null;
      }
    }
  }

  const off = [
    api.on('assets', (files) => {
      S.files = Array.from(files ?? []);
      if (S.town && !S.data && S.status !== 'loading') build(S.town);
    }),
    api.on('scene', setScene),
    api.on('exteriorSky', (e) => {
      if (!e?.sky || e.town !== S.town || !S.pass || !S.data?.sky || S.data.sky === e.sky) return;
      S.data = { ...S.data, sky: e.sky };
      S.pass.setSky(e.sky);
      PALETTE.horizon.splice(0, 3, ...e.sky.horizon);
      PALETTE.zenith.splice(0, 3, ...e.sky.zenith);
    }),
    api.on('location', (e) => onLocation(e?.location ?? null)),
    api.on('state', (state) => onLocation(locationOf(state))),
    api.on('frame', (f) => {
      if (!S.pass) return;
      attach(f?.renderer ?? api.renderer);
    }),
  ];

  /** The current town's flats and sky, or a building interior's flats: {status: 'idle'|'waiting'|'loading'|'ready'|'failed', town, error} (arrival gate). */
  api.scenery = { get status() { return S.status; }, get town() { return S.town; }, get error() { return S.error; } };

  if (api.location) S.location = api.location;
  if (api.town) setScene(api.town);

  return {
    get status() { return S.status; },
    get data() { return S.data; },
    get error() { return S.error; },
    get pass() { return S.pass; },
    dispose() {
      for (const f of off) f?.();
      clear('disposed');
      S.town = null;
    },
  };
}

export default { name: 'scenery', install };
