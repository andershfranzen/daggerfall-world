// Travel map panel and exterior scene switching (docs/gameplay-protocol.md, panel `map`).
//
// - Draws the classic Iliac Bay overview and region maps from the player's own
//   ARENA2 files, with location dots for every place the character knows of.
// - Lets the player search for places by name and quotes the classic journey
//   time and cost (client/gameplay/travel/journey.js, shared with the server).
// - Sends `travel.go`; the server validates and moves the character. When the
//   character's `town:` location differs from the scene on screen, the matching
//   original exterior is built with loadTown() and handed to api.setScene().
//   `building:` and `dungeon:` locations belong to the interiors feature.

import { indexFiles } from '../world/files.js';
import { browserWorldData } from '../world/wilderness/replacements.js';
import { fromGlobal } from '../world/exterior/frame.js';
import { wildernessId } from '../world/wilderness/data.js';
import {
  readWorld, parseLocationId, wildernessOrigin, locationId, LOCATION_TYPES, DOT_PALETTE_INDEX, REGION_NAMES, CLIMATE_LABELS,
} from './travel/catalog.js';
import { CLASSIC_STARTERS } from './travel/classic.js';
import { hasFreeShipPassage, quoteJourney, normalizeOptions } from './travel/journey.js';
import { fastTravelMinutes, freeTavernRooms } from './guilds/perks.js';
import { countFound, hasFound, regionNameOf } from './travel/identity.js';
import {
  MapImages, OVERVIEW_IMG, PICKER_IMG, regionMapCorner, REGION_MAP_W, REGION_MAP_H,
  regionMapNames, regionMapScale, regionMapFor,
} from './travel/mapimages.js';

const TYPE_LABEL = Object.fromEntries(LOCATION_TYPES.map((t) => [t.id, t.label]));
const FILTERS = [
  { id: 'all', label: 'All places', test: () => true },
  { id: 'towns', label: 'Towns', test: (l) => ['city', 'hamlet', 'village'].includes(l.type) },
  { id: 'temples', label: 'Temples', test: (l) => ['temple', 'cult'].includes(l.type) },
  { id: 'taverns', label: 'Taverns', test: (l) => l.type === 'tavern' },
  { id: 'dungeons', label: 'Dungeons', test: (l) => ['labyrinth', 'keep', 'ruin', 'graveyard', 'coven'].includes(l.type) },
  { id: 'homes', label: 'Homes', test: (l) => ['farm', 'wealthy', 'poor'].includes(l.type) },
];
const ACT_TIMEOUT_MS = 10000;
const clean = (s) => String(s).trim();
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
};

/** `town:` id of a scene mesh from loadTown(), or null for other scenes. */
export function sceneLocationId(mesh) {
  const region = mesh?.source?.region ?? mesh?.region;
  if (!mesh || typeof mesh.name !== 'string' || typeof region !== 'string') return null;
  if (mesh.kind && mesh.kind !== 'town' && mesh.kind !== 'exterior') return null;
  return mesh.source?.townId ?? locationId(region, mesh.name);
}

export function install(api) {
  const S = {
    index: null, // Map name -> File
    world: null, // Promise<{catalog, climate, politic}>
    worldValue: null,
    worldError: null,
    images: null,
    sceneId: null, // town id of the scene on screen (null: unknown / interior)
    loadingId: null,
    loadSeq: 0,
    loadError: null, // {id, message}
    cache: new Map(), // id -> mesh (most recent previous exterior)
    selected: null, // catalogue entry
    region: null, // selected region index on the map (null = overview)
    mapIndex: 0,
    query: '',
    filter: 'all',
    options: null,
    pending: null, // {to, requestId, timer}
    retry: null, // {to, cost, requestId}: the last journey asked for, until the server confirms or refuses it
    status: '',
    seaPixel: null,
    root: null,
    flashOn: true,
    autoRegion: false,
    sceneSeen: false,
  };

  // ------------------------------------------------------------------ data

  function setFiles(files) {
    try {
      S.index = indexFiles(files ?? []);
    } catch {
      S.index = new Map();
    }
    S.world = null;
    S.worldValue = null;
    S.worldError = null;
    S.images = new MapImages(S.index);
    S.cache.clear();
  }

  function world() {
    if (!S.world) {
      if (!S.index) setFiles(api.files);
      const index = S.index;
      S.world = readWorld(index, browserWorldData(api.files)).then(
        (w) => {
          if (index === S.index) { S.worldValue = w; refresh(); }
          return w;
        },
        (err) => {
          if (index === S.index) { S.worldError = err; refresh(); }
          throw err;
        },
      );
      S.world.catch(() => {});
    }
    return S.world;
  }

  const character = () => api.state?.character ?? null;

  /** Display name of a `town:` address; numeric record addresses never show their digits. */
  function placeLabel(id) {
    const name = S.worldValue?.catalog.get(id)?.name;
    if (name) return name;
    const where = parseLocationId(id);
    if (!where) return '';
    return /^\d+$/.test(where.location) ? 'your destination' : where.location;
  }
  const travelState = () => character()?.travel ?? {};
  const currentId = () => character()?.location ?? null;

  let lastDiscoveryList, knownIds;
  function discovered(list) {
    if (!knownIds || list !== lastDiscoveryList) {
      knownIds = new Set(Array.isArray(list) ? list : []);
      lastDiscoveryList = list;
    }
    return knownIds;
  }

  /** Can the server accept this destination for this character? */
  function visible(entry) {
    const t = travelState();
    if (t.server === 'classic' && !CLASSIC_STARTERS.some((s) => s.id === entry.id)) return false;
    return entry.discovered || entry.id === currentId() || hasFound(t.found, entry) || discovered(t.discovered).has(entry.id);
  }

  /** Map entry for where the character stands (the last town when inside a building). */
  function hereEntry() {
    const w = S.worldValue;
    if (!w) return null;
    if (S.seaPixel) return wildernessOrigin(S.seaPixel, w.politic);
    return w.catalog.get(currentId()) ?? wildernessOrigin(currentId(), w.politic) ?? w.catalog.get(travelState().lastTown) ?? null;
  }

  function transport() {
    const inv = Array.isArray(character()?.inventory) ? character().inventory : [];
    if (inv.some((it) => it?.template === 'horse')) return 'horse';
    if (inv.some((it) => /^(small-)?cart$/.test(it?.template ?? ''))) return 'cart';
    return 'foot';
  }

  function quote(entry) {
    const from = hereEntry();
    const w = S.worldValue;
    if (!from || !w) return null;
    // A server without its own CLIMATE.PAK prices every step as woodland; mirror it.
    const climateAt = travelState().server === 'classic' ? null : (x, y) => w.climate.atMapPixel(x, y);
    return quoteJourney(from, entry, S.options ?? travelState().options, {
      climateAt, transport: transport(), freePassage: hasFreeShipPassage(character()),
      // The server applies the same guild perks (client/gameplay/guilds/perks.js).
      fastTravel: (m) => fastTravelMinutes(m, character()?.guilds),
      freeInnRooms: freeTavernRooms(character()?.guilds, from.regionIndex),
    });
  }

  // ------------------------------------------------------------------ scene switching

  async function loadScene(id) {
    const where = parseLocationId(id);
    if (!where) return;
    const seq = ++S.loadSeq;
    S.loadingId = id;
    S.loadError = null;
    refresh();
    const label = clean(placeLabel(id));
    try {
      // A town the exterior stream already holds (drawn beside the road, or prefetched) swaps in at once.
      let mesh = S.cache.get(id) ?? api.exterior?.ready?.(id) ?? null;
      if (!mesh && api.exterior?.load) {
        try { mesh = await api.exterior.load(id); } catch { mesh = null; } // cancelled or failed: build it here
        if (seq !== S.loadSeq) return;
      }
      if (!mesh) {
        api.message?.(`Travelling to ${label}…`);
        const files = api.files ? [...api.files] : [];
        if (!files.length) throw new Error('Your Daggerfall files are not loaded. Leave and choose your ARENA2 folder again.');
        const { loadTown } = await import('../world/town.js');
        const entry = S.worldValue?.catalog.get(id);
        // The season's look (client/world/exterior/season.js); the exterior feature corrects a wrong guess in place.
        const season = api.atmosphere?.now?.()?.date?.season;
        const winter = api.exterior?.look?.()?.winter ?? String(season ?? '').toLowerCase() === 'winter';
        mesh = await loadTown(files, { region: entry?.regionIndex ?? where.region, location: entry?.index ?? where.location, winter });
      }
      if (seq !== S.loadSeq) return; // superseded by a newer move
      if (typeof api.setScene !== 'function') throw new Error('This game shell cannot change scenes.');
      const applied = await api.setScene(mesh, { location: id });
      if (seq !== S.loadSeq) return;
      S.loadingId = null;
      if (applied) {
        S.sceneId = id;
        S.cache.clear();
        S.cache.set(id, mesh);
      }
    } catch (err) {
      if (seq !== S.loadSeq) return;
      console.error('[travel] scene load failed', err);
      S.loadingId = null;
      S.loadError = { id, message: err?.message || String(err) };
      api.emit('sceneError', { location: id, message: S.loadError.message, source: 'travel' });
      api.message?.(`Could not draw ${label}: ${S.loadError.message}`);
    }
    refresh();
  }

  function syncScene() {
    // Until the shell has shown its first scene we cannot tell what is on screen.
    if (!S.sceneSeen) return;
    const id = currentId();
    if (!id || !parseLocationId(id)) {
      // Interior or unknown: another feature owns the scene. Cancel any exterior load.
      if (S.loadingId) { S.loadSeq++; S.loadingId = null; }
      return;
    }
    if (id === S.sceneId || id === S.loadingId) return;
    if (S.loadError?.id === id) return; // wait for an explicit retry
    loadScene(id);
  }

  // ------------------------------------------------------------------ actions

  function finishPending(message) {
    if (!S.pending) return;
    clearTimeout(S.pending.timer);
    S.pending = null;
    if (message != null) S.status = message;
    refresh();
  }

  const newRequestId = () => `trip-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

  async function travel(entry, q) {
    if (S.pending) return;
    // Retrying the same journey (after a dropped connection) reuses its request id, so the server
    // can never charge twice or send the traveller on twice.
    const same = S.retry && S.retry.to === entry.id && S.retry.cost === q.cost.total;
    const requestId = same ? S.retry.requestId : newRequestId();
    S.retry = { to: entry.id, cost: q.cost.total, requestId };
    S.status = `Setting out for ${clean(entry.name)}…`;
    S.pending = { to: entry.id, requestId, timer: setTimeout(() => finishPending('No answer from the server. Check your connection and try again.'), ACT_TIMEOUT_MS) };
    refresh();
    try {
      const r = await api.act('travel.go', { to: entry.id, options: q.options, expectCost: q.cost.total, requestId }, { quiet: true });
      if (r && r.ok === false) {
        if (r.closed) finishPending('The connection dropped before the server answered. If you have not arrived when it returns, choose Travel again: you will not be charged twice.');
        else { S.retry = null; finishPending(r.error || 'The journey could not begin.'); }
      } else if (r === false) finishPending('Not connected — the journey could not begin.');
    } catch (err) {
      finishPending(err?.message || 'The journey could not begin.');
    }
  }

  /** A guild teleport offered in the last few minutes by the conversation (client/gameplay/npcs.js), or null. */
  function teleportOffer() {
    const t = api.guildTeleport;
    if (!t || !(Date.now() - t.at < 5 * 60_000)) return null;
    return t;
  }

  async function teleport(entry, tp) {
    if (S.pending) return;
    S.status = `Teleporting to ${clean(entry.name)}…`;
    S.pending = { to: entry.id, teleport: true, timer: setTimeout(() => finishPending('No answer from the server. Check your connection and try again.'), ACT_TIMEOUT_MS) };
    refresh();
    try {
      const r = await api.act('npc.service', { targetId: tp.targetId, session: tp.session, service: 'teleport', to: entry.id }, { quiet: true });
      if (r && r.ok === false) finishPending(r.error || 'The teleport failed.');
      else if (r === false) finishPending('Not connected — the teleport could not begin.');
      else { api.guildTeleport = null; finishPending(`You arrive in ${clean(entry.name)}.`); api.closePanel?.(); }
    } catch (err) {
      finishPending(err?.message || 'The teleport failed.');
    }
  }

  // ------------------------------------------------------------------ events

  setFiles(api.files);
  api.on('assets', (files) => {
    setFiles(files);
    S.loadError = null;
    if (S.loadingId) { S.loadSeq++; S.loadingId = null; }
    if (S.root?.isConnected) { world(); refresh(); }
    syncScene();
  });
  api.on('frame', (f) => {
    if (S.sceneSeen || !f?.town) return;
    S.sceneSeen = true;
    S.sceneId = sceneLocationId(f.town);
    syncScene();
  });
  api.on('scene', (mesh) => {
    S.sceneSeen = true;
    const id = sceneLocationId(mesh);
    S.sceneId = id;
    if (id) {
      if (S.loadingId === id) S.loadingId = null; // our own setScene (or the shell's) completed it
      if (!S.cache.has(id)) { S.cache.clear(); S.cache.set(id, mesh); }
    }
    syncScene();
    refresh();
  });
  api.on('state', () => {
    const id = currentId();
    // An answer lost to a dropped connection: the saved trip says whether the journey happened.
    if (S.retry && travelState().lastTrip?.requestId === S.retry.requestId) {
      S.retry = null;
      if (!S.pending) S.status = travelState().lastTrip ? `You arrived in ${clean(S.worldValue?.catalog.get(id)?.name ?? parseLocationId(id)?.location ?? '')}.` : S.status;
    }
    if (S.pending && id === S.pending.to) {
      const name = placeLabel(id);
      finishPending(`You arrive in ${clean(name)}.`);
    }
    syncScene();
    refresh();
  });
  api.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'sailing.state') {
      let id = null;
      if (ev.vessel) {
        const { px, py } = fromGlobal(ev.vessel.x, ev.vessel.z);
        id = wildernessId(px, py);
      }
      if (S.seaPixel !== id) { S.seaPixel = id; refresh(); }
    } else if (ev.kind === 'travel') {
      if (ev.requestId && S.retry?.requestId === ev.requestId) S.retry = null;
      if (S.pending) finishPending(ev.text ?? '');
      else if (ev.text) { S.status = ev.text; refresh(); }
      // The journey plays over the whole screen (client/gameplay/journey.js); put the map away.
      if (ev.route && api.panel === 'map') api.closePanel?.();
    } else if (S.pending && (ev.kind === 'error' || ev.kind === 'actionError') && (!ev.verb || ev.verb === 'travel.go')) {
      finishPending(ev.text || ev.message || 'The journey could not begin.');
    }
  });
  api.on('screen', (screen) => {
    if (screen !== 'game' && S.pending) finishPending('');
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    if (document.body.dataset.screen !== 'game' || api.modalOpen) return;
    e.preventDefault();
    api.openPanel?.('map');
  });

  if (api.state) syncScene();

  // For the journey view: the world the map is drawn from, and a destination that failed to draw.
  api.travelWorld = () => S.worldValue;
  api.travelLoadError = () => S.loadError?.id ?? null;

  // ------------------------------------------------------------------ panel

  api.registerPanel('map', 'Travel map', (container) => {
    if (!S.root) S.root = buildPanel();
    if (S.root.parentNode !== container) container.replaceChildren(S.root);
    world();
    S.root.update();
  });

  function refresh() {
    if (!S.root || !S.root.isConnected) return;
    S.root.update();
  }

  function buildPanel() {
    const root = el('div', { class: 'travel' });
    const here = el('p', { class: 'travel-here' });
    const notice = el('p', { class: 'travel-notice', role: 'status' });
    const search = el('input', {
      class: 'travel-search', type: 'search', placeholder: 'Find a place…', 'aria-label': 'Find a place by name', autocomplete: 'off', spellcheck: 'false',
    });
    const filter = el('select', { class: 'travel-filter', 'aria-label': 'Kind of place' },
      ...FILTERS.map((f) => el('option', { value: f.id }, f.label)));
    const results = el('ol', { class: 'travel-results', 'aria-label': 'Places' });
    const crumbs = el('div', { class: 'travel-crumbs' });
    const canvas = el('canvas', { class: 'travel-canvas', width: 320, height: 200, tabindex: '0', 'aria-label': 'Map of the Iliac Bay' });
    const hover = el('p', { class: 'travel-hover', 'aria-hidden': 'true' });
    const detail = el('section', { class: 'travel-detail', 'aria-live': 'polite' });
    const status = el('p', { class: 'travel-status', role: 'status' });

    root.append(
      el('div', { class: 'travel-top' }, here, notice),
      el('div', { class: 'travel-body' },
        el('div', { class: 'travel-mapcol' }, crumbs, el('div', { class: 'travel-frame' }, canvas), hover),
        el('div', { class: 'travel-side' },
          el('div', { class: 'travel-find' }, search, filter), results, detail, status)),
    );

    search.addEventListener('input', () => { S.query = search.value; drawResults(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results.querySelector('button');
        if (first) { e.preventDefault(); first.click(); }
      }
      e.stopPropagation();
    });
    filter.addEventListener('change', () => { S.filter = filter.value; drawResults(); drawMap(); });

    let flash = null;
    const startFlash = () => {
      if (flash) return;
      flash = setInterval(() => {
        if (!root.isConnected) { clearInterval(flash); flash = null; return; }
        S.flashOn = !S.flashOn;
        drawMap();
      }, 500);
    };

    // ----------------------------------------------------- map drawing

    let picker = null, renderedSource = null, drawToken = 0;
    const ctx2d = canvas.getContext('2d');

    async function drawMap() {
      const token = ++drawToken;
      const w = S.worldValue;
      const images = S.images;
      if (renderedSource !== images) {
        renderedSource = images;
        picker = null;
        crumbs.dataset.key = '';
        crumbs.replaceChildren();
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (!images || !S.index?.size) return;
      // Crumbs are rebuilt only when the view changes so the flashing redraw keeps focus.
      const key = `${S.region}:${S.mapIndex}`;
      const fresh = crumbs.dataset.key !== key;
      if (fresh) { crumbs.replaceChildren(); crumbs.dataset.key = key; }
      try {
        if (S.region == null) {
          if (fresh) crumbs.append(el('span', { class: 'travel-crumb-current' }, 'The Iliac Bay'));
          const [overview, mask] = await Promise.all([
            images.image(OVERVIEW_IMG),
            images.has(PICKER_IMG) ? images.image(PICKER_IMG).catch(() => null) : null,
          ]);
          if (token !== drawToken || images !== S.images) return;
          picker = mask;
          canvas.width = overview.width;
          canvas.height = overview.height;
          ctx2d.putImageData(new ImageData(overview.rgba, overview.width, overview.height), 0, 0);
          const here = hereEntry();
          if (here && picker && S.flashOn) {
            // Highlight the player's region the way the classic map flashes it.
            const target = here.regionIndex + 128;
            const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < picker.indices.length; i++) {
              if (picker.indices[i] === target) {
                img.data[i * 4] = Math.min(255, img.data[i * 4] * 0.5 + 120);
                img.data[i * 4 + 1] = img.data[i * 4 + 1] * 0.6;
                img.data[i * 4 + 2] = img.data[i * 4 + 2] * 0.5;
              }
            }
            ctx2d.putImageData(img, 0, 0);
          }
          canvas.setAttribute('aria-label', 'Map of the Iliac Bay. Choose a region.');
        } else {
          const names = regionMapNames(S.region);
          const name = names[Math.min(S.mapIndex, names.length - 1)];
          if (fresh) crumbs.append(
            el('button', { type: 'button', class: 'travel-crumb', onclick: () => { S.region = null; drawMap(); drawResults(); } }, 'Iliac Bay'),
            el('span', { class: 'travel-crumb-sep', 'aria-hidden': 'true' }, '›'),
            el('span', { class: 'travel-crumb-current' }, REGION_NAMES[S.region]),
          );
          if (fresh && names.length > 1) {
            names.forEach((_, i) => crumbs.append(el('button', {
              type: 'button', class: 'travel-crumb travel-part', 'aria-pressed': String(i === S.mapIndex),
              onclick: () => { S.mapIndex = i; drawMap(); },
              'data-direction': names.length === 2 ? (i === 0 ? 'west' : 'east') : null,
            }, `Part ${i + 1}`)));
          }
          const [regionImg, pal] = await Promise.all([images.image(name), images.palette('FMAP_PAL.COL')]);
          if (token !== drawToken || images !== S.images) return;
          canvas.width = REGION_MAP_W;
          canvas.height = REGION_MAP_H;
          ctx2d.putImageData(new ImageData(regionImg.rgba, regionImg.width, regionImg.height), 0, 0);
          const [ox, oy] = regionMapCorner(name);
          const scale = regionMapScale(S.region);
          const f = FILTERS.find((x) => x.id === S.filter) ?? FILTERS[0];
          const here = hereEntry();
          for (const l of w?.catalog.inRegion(REGION_NAMES[S.region]) ?? []) {
            if (!visible(l) || !f.test(l)) continue;
            const px = (l.x - ox) * scale, py = (l.y - oy) * scale;
            if (px < 0 || py < 0 || px >= REGION_MAP_W || py >= REGION_MAP_H) continue;
            const pi = DOT_PALETTE_INDEX[l.type];
            if (pi == null) continue;
            ctx2d.fillStyle = `rgb(${pal[pi * 3]},${pal[pi * 3 + 1]},${pal[pi * 3 + 2]})`;
            ctx2d.fillRect(px, py, scale, scale);
          }
          const mark = (l, color, size) => {
            const px = (l.x - ox) * scale, py = (l.y - oy) * scale;
            if (px < -2 || py < -2 || px > REGION_MAP_W + 2 || py > REGION_MAP_H + 2) return;
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = 1;
            ctx2d.strokeRect(px - size + 0.5 + scale / 2 - 0.5, py - size + 0.5 + scale / 2 - 0.5, size * 2, size * 2);
          };
          if (here && here.regionIndex === S.region && S.flashOn) mark(here, '#ffffff', 3);
          if (S.selected && S.selected.regionIndex === S.region) mark(S.selected, '#9fd3ff', 4);
          canvas.setAttribute('aria-label', `Map of ${REGION_NAMES[S.region]}. Choose a place.`);
        }
        crumbs.querySelector('.travel-art-error')?.remove();
      } catch (err) {
        if (token !== drawToken || images !== S.images) return;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        canvas.setAttribute('aria-label', 'Map artwork unavailable');
        const message = `The map pictures could not be read: ${err.message}`;
        const error = crumbs.querySelector('.travel-art-error');
        if (!error) crumbs.append(el('span', { class: 'travel-art-error', role: 'status' }, message));
        else if (error.textContent !== message) error.textContent = message;
      }
    }

    const canvasPoint = (e) => {
      const r = canvas.getBoundingClientRect();
      return [Math.floor(((e.clientX - r.left) / r.width) * canvas.width), Math.floor(((e.clientY - r.top) / r.height) * canvas.height)];
    };

    const regionAt = (x, y) => {
      if (!picker) return -1;
      const v = picker.indices[y * picker.width + x];
      const reg = v - 128;
      return v >= 128 && reg < REGION_NAMES.length ? reg : -1;
    };

    function nearestAt(x, y) {
      const w = S.worldValue;
      if (!w || S.region == null) return null;
      const name = regionMapNames(S.region)[S.mapIndex];
      const origin = regionMapCorner(name);
      if (!origin) return null;
      const [ox, oy] = origin;
      const scale = regionMapScale(S.region);
      const f = FILTERS.find((q) => q.id === S.filter) ?? FILTERS[0];
      let best = null, bestD = (4 * scale) ** 2 + 1;
      for (const l of w.catalog.inRegion(REGION_NAMES[S.region])) {
        if (!visible(l) || !f.test(l)) continue;
        const d = ((l.x - ox) * scale + scale / 2 - x) ** 2 + ((l.y - oy) * scale + scale / 2 - y) ** 2;
        if (d < bestD) { bestD = d; best = l; }
      }
      return best;
    }

    canvas.addEventListener('mousemove', (e) => {
      const [x, y] = canvasPoint(e);
      if (S.region == null) {
        const r = regionAt(x, y);
        hover.textContent = r >= 0 ? REGION_NAMES[r] : '';
        canvas.style.cursor = r >= 0 ? 'pointer' : 'default';
      } else {
        const l = nearestAt(x, y);
        hover.textContent = l ? `${clean(l.name)} · ${TYPE_LABEL[l.type] ?? l.type}` : '';
        canvas.style.cursor = l ? 'pointer' : 'default';
      }
    });
    canvas.addEventListener('mouseleave', () => { hover.textContent = ''; });
    canvas.addEventListener('click', (e) => {
      const [x, y] = canvasPoint(e);
      if (S.region == null) {
        const r = regionAt(x, y);
        if (r >= 0) { openRegion(r); drawResults(); }
      } else {
        const l = nearestAt(x, y);
        if (l) select(l, { recentre: false });
      }
    });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.region != null) { e.preventDefault(); e.stopPropagation(); S.region = null; drawMap(); }
    });

    function openRegion(r, focusEntry = null) {
      S.region = r;
      const names = regionMapNames(r);
      S.mapIndex = 0;
      if (focusEntry) {
        const i = regionMapFor(r, focusEntry.x, focusEntry.y);
        if (i >= 0) S.mapIndex = i;
      }
      if (S.mapIndex >= names.length) S.mapIndex = 0;
      drawMap();
    }

    function select(entry, { recentre = true } = {}) {
      S.selected = entry;
      if (recentre || S.region !== entry.regionIndex) openRegion(entry.regionIndex, entry);
      else drawMap();
      drawDetail();
      drawResults();
    }

    // ----------------------------------------------------- results

    // Identical names are told apart by map pixel, placed before the region so a narrow list still shows it.
    const mapPosition = entry => S.worldValue?.catalog.ambiguous(entry) ? ` · ${entry.x}, ${entry.y}` : '';

    function drawResults() {
      const w = S.worldValue;
      results.replaceChildren();
      if (!w) return;
      const f = FILTERS.find((x) => x.id === S.filter) ?? FILTERS[0];
      const filterFn = (l) => visible(l) && f.test(l);
      let list;
      if (S.query.trim()) list = w.catalog.search(S.query, { limit: 40, filter: filterFn });
      else if (S.region != null) list = w.catalog.inRegion(REGION_NAMES[S.region]).filter(filterFn).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200);
      else list = [];
      if (!list.length) {
        const msg = S.query.trim()
          ? 'No place you know of matches that name.'
          : S.region == null ? 'Choose a region on the map, or search by name.' : 'You know of no such places here.';
        results.append(el('li', { class: 'travel-empty' }, msg));
        return;
      }
      for (const l of list) {
        const here = l.id === currentId();
        results.append(el('li', {},
          el('button', {
            type: 'button', class: 'travel-result', 'aria-current': S.selected?.id === l.id ? 'true' : null,
            onclick: () => select(l),
          },
          el('span', { class: 'travel-result-name' }, clean(l.name)),
          el('span', { class: 'travel-result-meta' }, `${TYPE_LABEL[l.type] ?? l.type}${mapPosition(l)} · ${l.region}${here ? ' · you are here' : ''}`))));
      }
    }

    // ----------------------------------------------------- detail

    function radio(name, value, label, checked, onChange) {
      const input = el('input', { type: 'radio', name, value, checked });
      input.addEventListener('change', () => input.checked && onChange(value));
      return el('label', { class: 'travel-opt' }, input, ' ', label);
    }

    function drawDetail() {
      detail.replaceChildren();
      const l = S.selected;
      if (!l) return;
      const t = travelState();
      const opts = normalizeOptions(S.options ?? t.options);
      const here = l.id === currentId();
      detail.append(
        el('h3', { class: 'travel-dest' }, clean(l.name)),
        el('p', { class: 'travel-dest-meta' }, `${TYPE_LABEL[l.type] ?? l.type} in ${l.region}${mapPosition(l) ? ` at map ${l.x}, ${l.y}` : ''}`),
      );
      if (here) {
        detail.append(el('p', { class: 'travel-note' }, 'You are here.'));
        return;
      }
      if (S.seaPixel) {
        detail.append(el('button', { type: 'button', class: 'btn', onclick: () => api.openPanel('sailing') }, 'Open sailing chart'));
        return;
      }
      const tp = teleportOffer();
      if (tp) {
        // Guild teleport (package 15): free and instant, from inside the hall (DaggerfallTeleportPopUp).
        detail.append(
          el('p', { class: 'travel-note travel-teleport' }, `${tp.name} of the Mages Guild will send you there at once, free of charge.`),
          el('button', { type: 'button', class: 'btn btn-primary travel-go', disabled: !!S.pending, onclick: () => teleport(l, tp) },
            S.pending ? 'Teleporting…' : `Teleport to ${clean(l.name)}`),
          el('button', { type: 'button', class: 'btn travel-teleport-cancel', onclick: () => { api.guildTeleport = null; drawDetail(); } }, 'Travel normally instead'),
        );
        return;
      }
      const q = quote(l);
      if (!q) {
        detail.append(el('p', { class: 'travel-note' }, 'Your starting point is not on the map, so the journey cannot be priced.'));
        return;
      }
      const setOpt = (k) => (v) => { S.options = { ...opts, [k]: v }; drawDetail(); };
      const ship = el('input', { type: 'checkbox', checked: opts.ship });
      ship.addEventListener('change', () => setOpt('ship')(ship.checked));
      detail.append(
        el('fieldset', { class: 'travel-opts' },
          el('legend', {}, 'Pace'),
          radio('travel-speed', 'cautious', 'Cautiously', opts.speed === 'cautious', setOpt('speed')),
          radio('travel-speed', 'reckless', 'Recklessly', opts.speed === 'reckless', setOpt('speed'))),
        el('fieldset', { class: 'travel-opts' },
          el('legend', {}, 'Nights'),
          radio('travel-lodging', 'inn', 'At inns', opts.lodging === 'inn', setOpt('lodging')),
          radio('travel-lodging', 'camp', 'Camping out', opts.lodging === 'camp', setOpt('lodging'))),
      );
      if (q.shipUseful) detail.append(el('label', { class: 'travel-opt travel-ship' }, ship, ' Take ship passage over the water'));
      const gold = Number.isFinite(character()?.gold) ? character().gold : 0;
      const terrain = Object.entries(q.terrain).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => CLIMATE_LABELS[c] ?? c).join(', ');
      const rows = [
        ['Journey', `${q.days} day${q.days === 1 ? '' : 's'}${q.transport !== 'foot' ? ` by ${q.transport}` : ' on foot'}`],
        ['Cost', `${q.cost.total} gold${q.cost.passage ? ` (${q.cost.passage} passage)` : ''}`],
        ['Your gold', String(gold)],
      ];
      if (terrain) rows.push(['Country', terrain]);
      detail.append(el('dl', { class: 'travel-quote' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
      if (q.options.speed === 'cautious') detail.append(el('p', { class: 'travel-note' }, 'A cautious journey arrives rested.'));
      detail.append(el('p', { class: 'travel-note' }, 'The world keeps one clock for everyone; the days are spent on your road, not the realm’s calendar.'));
      const busy = !!S.pending || !!S.loadingId;
      const short = q.cost.total > gold;
      const outside = !!(parseLocationId(currentId()) || wildernessOrigin(currentId()));
      const go = el('button', {
        type: 'button', class: 'btn btn-primary travel-go', disabled: busy || short || !outside,
        onclick: () => travel(l, q),
      }, S.pending ? 'Travelling…' : `Travel to ${clean(l.name)}`);
      detail.append(go);
      if (short) detail.append(el('p', { class: 'travel-warn' }, `You need ${q.cost.total - gold} more gold.`));
      else if (!outside) detail.append(el('p', { class: 'travel-warn' }, 'Step outside before you set off.'));
    }

    // ----------------------------------------------------- update

    root.update = () => {
      const w = S.worldValue;
      const t = travelState();
      const cur = currentId();
      const entry = w?.catalog.get(cur) ?? null;
      const where = parseLocationId(cur);
      const wild = wildernessOrigin(cur, w?.politic);
      here.textContent = S.seaPixel
        ? `You are sailing the Iliac Bay at map square ${S.seaPixel.slice('wilderness:'.length)}.`
        : entry
        ? `You are in ${clean(entry.name)}, ${entry.region}.`
        : where ? `You are in ${clean(placeLabel(cur))}, ${regionNameOf(where.region)}.`
        : wild ? `You are in the wilderness at map square ${wild.x}, ${wild.y}.` : 'You are indoors.';
      const notes = [];
      if (S.worldError) notes.push(`Your files have no readable world map: ${S.worldError.message}`);
      else if (!w) notes.push('Reading the world map from your files…');
      if (t.server === 'classic') notes.push('This server has no world data of its own, so only the great cities and your home town can be visited.');
      if (t.server === 'loading') notes.push('The server is still reading its world map.');
      if (S.loadingId) notes.push(`Drawing ${clean(placeLabel(S.loadingId))}…`);
      notice.replaceChildren(...notes.map((n) => el('span', {}, n)));
      if (S.loadError) {
        notice.append(el('span', { class: 'travel-warn' }, `Could not draw ${clean(placeLabel(S.loadError.id))}: ${S.loadError.message} `),
          el('button', { type: 'button', class: 'btn travel-retry', onclick: () => { const id = S.loadError.id; S.loadError = null; loadScene(id); } }, 'Try again'));
      }
      status.textContent = S.status;
      if (w) {
        if (S.selected) S.selected = w.catalog.get(S.selected.id);
        if (!S.selected && S.region == null && !S.autoRegion) {
          const h = hereEntry();
          if (h && REGION_NAMES[h.regionIndex]) {
            S.autoRegion = true; S.region = h.regionIndex; S.mapIndex = Math.max(0, regionMapFor(h.regionIndex, h.x, h.y)); }
        }
        if (search.value !== S.query) search.value = S.query;
        filter.value = S.filter;
        drawMap();
        // Rebuild the list and the fare only when what they show has changed: the panel refreshes
        // on every state message (moving townsfolk send several a second), and replacing the buttons
        // under the pointer would swallow a player's click.
        const c = character();
        const foundCount = countFound(t.found);
        const key = JSON.stringify([
          S.query, S.filter, S.region, S.mapIndex, S.selected?.id ?? null, cur, !!S.seaPixel, c?.gold ?? null, foundCount,
          t.discovered?.length ?? 0, t.options ?? null, t.server ?? null, hasFreeShipPassage(c), S.options ?? null,
          c?.guilds?.knights?.rank, c?.guilds?.knights?.variant, c?.guilds?.temple?.rank, c?.guilds?.temple?.variant,
          !!S.pending, S.loadingId, transport(),
        ]);
        if (key !== root.shownKey) {
          root.shownKey = key;
          drawResults();
          drawDetail();
        }
        startFlash();
      } else {
        drawMap();
        results.replaceChildren();
        detail.replaceChildren();
      }
    };
    return root;
  }

  return { sceneLocationId, get state() { return S; } };
}
