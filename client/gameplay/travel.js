// Travel map panel and exterior scene switching (docs/gameplay-protocol.md, panel `map`).
//
// - Draws the classic Iliac Bay overview and region maps from the player's own
//   ARENA2 files, with interactive pan/zoom, inset navigator mini-map, color-coded
//   markers, smart landmark labels, live route previews, and rich hover tooltips.
// - Lets the player search and filter places by category and quotes the classic
//   journey time and cost (client/gameplay/travel/journey.js, shared with the server).
// - Sends `travel.go`; the server validates and moves the character. When the
//   character's `town:` location differs from the scene on screen, the matching
//   original exterior is built with loadTown() and handed to api.setScene().
//   `building:` and `dungeon:` locations belong to the interiors feature.

import { indexFiles } from '../world/files.js';
import { browserWorldData } from '../world/wilderness/replacements.js';
import { fromGlobal } from '../world/exterior/frame.js';
import { wildernessId } from '../world/wilderness/data.js';
import {
  readWorld, parseLocationId, wildernessOrigin, locationId, LOCATION_TYPES, REGION_NAMES, CLIMATE_LABELS, CLIMATE,
} from './travel/catalog.js';
import { CLASSIC_STARTERS } from './travel/classic.js';
import { hasFreeShipPassage, quoteJourney, normalizeOptions, journeyRoute } from './travel/journey.js';
import { fastTravelMinutes, freeTavernRooms } from './guilds/perks.js';
import { countFound, hasFound, regionNameOf } from './travel/identity.js';
import {
  MapImages, OVERVIEW_IMG, PICKER_IMG, regionMapCorner, REGION_MAP_W, REGION_MAP_H,
  regionMapNames, regionMapScale, regionMapFor,
} from './travel/mapimages.js';

const TYPE_LABEL = Object.fromEntries(LOCATION_TYPES.map((t) => [t.id, t.label]));
const FILTERS = [
  { id: 'all', label: 'All', fullLabel: 'All places', color: '#cfd6df', test: () => true },
  { id: 'towns', label: 'Towns', fullLabel: 'Towns', color: '#e8edf2', test: (l) => ['city', 'hamlet', 'village'].includes(l.type) },
  { id: 'temples', label: 'Temples', fullLabel: 'Temples', color: '#78c6c8', test: (l) => ['temple', 'cult'].includes(l.type) },
  { id: 'taverns', label: 'Taverns', fullLabel: 'Taverns', color: '#b4a2e0', test: (l) => l.type === 'tavern' },
  { id: 'dungeons', label: 'Dungeons', fullLabel: 'Dungeons', color: '#d96262', test: (l) => ['labyrinth', 'keep', 'ruin', 'graveyard', 'coven'].includes(l.type) },
  { id: 'homes', label: 'Homes', fullLabel: 'Homes', color: '#82bc88', test: (l) => ['farm', 'wealthy', 'poor'].includes(l.type) },
];

const MARKER_STYLE = Object.freeze({
  city:      { color: '#f4f7fa', ring: '#1a3c3e', shape: 'star',    priority: 10 },
  hamlet:    { color: '#d4dce4', ring: '#141619', shape: 'square',  priority: 6 },
  village:   { color: '#b8c2cc', ring: '#141619', shape: 'square',  priority: 5 },
  temple:    { color: '#78c6c8', ring: '#0f2628', shape: 'cross',   priority: 7 },
  cult:      { color: '#9c8ce8', ring: '#1d1433', shape: 'cross',   priority: 6 },
  tavern:    { color: '#b8a6e2', ring: '#201830', shape: 'circle',  priority: 5 },
  labyrinth: { color: '#df6262', ring: '#260c0c', shape: 'diamond', priority: 7 },
  keep:      { color: '#cf5050', ring: '#260c0c', shape: 'diamond', priority: 7 },
  ruin:      { color: '#c46868', ring: '#260c0c', shape: 'diamond', priority: 5 },
  graveyard: { color: '#b58488', ring: '#1f1010', shape: 'diamond', priority: 4 },
  coven:     { color: '#c474b8', ring: '#240f22', shape: 'diamond', priority: 6 },
  farm:      { color: '#82bc88', ring: '#122214', shape: 'dot',     priority: 2 },
  wealthy:   { color: '#98cc9c', ring: '#122214', shape: 'dot',     priority: 3 },
  poor:      { color: '#6ea274', ring: '#122214', shape: 'dot',     priority: 1 },
  ships:     { color: '#8cd4e8', ring: '#0d2229', shape: 'circle',  priority: 8 },
});

const ACT_TIMEOUT_MS = 10000;
const MIN_ZOOM = 1;
const MAX_REGION_ZOOM = 8;
const MAX_OVERVIEW_ZOOM = 3;
const MINI_W_FRAC = 0.24;
const MINI_PAD = 10;

const clean = (s) => String(s).trim();
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
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

function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  return c;
}

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
    hovered: null, // hovered catalogue entry on region map
    hoveredRegion: -1, // hovered region index on Iliac Bay overview
    region: null, // selected region index on the map (null = overview)
    mapIndex: 0,
    query: '',
    filter: 'all',
    options: null,
    pending: null, // {to, requestId, timer}
    retry: null, // {to, cost, requestId}
    status: '',
    seaPixel: null,
    root: null,
    flashOn: true,
    pulsePhase: 0,
    autoRegion: false,
    pendingFocusEntry: null,
    sceneSeen: false,
    cam: { zoom: 1, cx: 0.5, cy: 0.5 },
  };

  /** Apply deep-linked `?place=<id>` once the world catalog is loaded, then clear it. */
  function applyInitialPlace(w = S.worldValue) {
    if (!w?.catalog) return false;
    const placeId = typeof api.initialPlace === 'string' ? api.initialPlace.trim() : '';
    if (!placeId) return false;
    const entry = w.catalog.get(placeId);
    if (!entry) return false;
    S.selected = entry;
    S.region = entry.regionIndex;
    S.mapIndex = Math.max(0, regionMapFor(entry.regionIndex, entry.x, entry.y));
    S.autoRegion = true;
    S.pendingFocusEntry = entry;
    if (typeof api.consumeInitialPlace === 'function') api.consumeInitialPlace();
    else api.initialPlace = null;
    return true;
  }

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
          if (index === S.index) { S.worldValue = w; applyInitialPlace(w); refresh(); }
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
    const climateAt = travelState().server === 'classic' ? null : (x, y) => w.climate.atMapPixel(x, y);
    return quoteJourney(from, entry, S.options ?? travelState().options, {
      climateAt, transport: transport(), freePassage: hasFreeShipPassage(character()),
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
      let mesh = S.cache.get(id) ?? api.exterior?.ready?.(id) ?? null;
      if (!mesh && api.exterior?.load) {
        try { mesh = await api.exterior.load(id); } catch { mesh = null; }
        if (seq !== S.loadSeq) return;
      }
      if (!mesh) {
        api.message?.(`Travelling to ${label}…`);
        const files = api.files ? [...api.files] : [];
        if (!files.length) throw new Error('Your Daggerfall files are not loaded. Leave and choose your ARENA2 folder again.');
        const { loadTown } = await import('../world/town.js');
        const entry = S.worldValue?.catalog.get(id);
        const season = api.atmosphere?.now?.()?.date?.season;
        const winter = api.exterior?.look?.()?.winter ?? String(season ?? '').toLowerCase() === 'winter';
        mesh = await loadTown(files, { region: entry?.regionIndex ?? where.region, location: entry?.index ?? where.location, winter });
      }
      if (seq !== S.loadSeq) return;
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
    if (api.state?.character?.character?.created === false) return;
    const id = currentId();
    if (!S.sceneSeen && !(api.screen === 'loading' && id && id !== 'town:Daggerfall/Gothway Garden')) return;
    if (!id || !parseLocationId(id)) {
      if (S.loadingId) { S.loadSeq++; S.loadingId = null; }
      return;
    }
    if (id === S.sceneId || id === S.loadingId) return;
    if (S.loadError?.id === id) return;
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
      if (S.loadingId === id) S.loadingId = null;
      if (!S.cache.has(id)) { S.cache.clear(); S.cache.set(id, mesh); }
    }
    syncScene();
    refresh();
  });
  api.on('state', () => {
    const id = currentId();
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
    const hereCoords = el('span', { class: 'travel-coords' });
    const notice = el('p', { class: 'travel-notice', role: 'status' });

    const crumbs = el('div', { class: 'travel-crumbs' });
    const zoomOutBtn = el('button', { type: 'button', class: 'travel-tool-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out' }, '−');
    const zoomReadout = el('span', { class: 'travel-zoom-val', 'aria-live': 'off' }, '1.0×');
    const zoomInBtn = el('button', { type: 'button', class: 'travel-tool-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in' }, '+');
    const fitBtn = el('button', { type: 'button', class: 'travel-tool-btn', title: 'Fit whole map (0)', 'aria-label': 'Reset zoom' }, 'Fit');
    const locateBtn = el('button', { type: 'button', class: 'travel-tool-btn travel-tool-locate', title: 'Center on your location', 'aria-label': 'Center on your location' }, 'Locate');
    const tools = el('div', { class: 'travel-tools' }, zoomOutBtn, zoomReadout, zoomInBtn, fitBtn, locateBtn);

    const canvas = el('canvas', { class: 'travel-canvas', width: 640, height: 320, tabindex: '0', 'aria-label': 'Map of the Iliac Bay' });
    const tooltip = el('div', { class: 'travel-tooltip', hidden: true, 'aria-hidden': 'true' });
    const frame = el('div', { class: 'travel-frame' }, canvas, tooltip);
    const hoverBar = el('div', { class: 'travel-hoverbar' });
    const hoverText = el('span', { class: 'travel-hover' }, 'Scroll to zoom · Drag to pan · Click a place to plot a journey');
    const hoverCoords = el('span', { class: 'travel-hover-coords' });
    hoverBar.append(hoverText, hoverCoords);

    const filterBar = el('div', { class: 'travel-filters', role: 'group', 'aria-label': 'Filter places on map' });

    const search = el('input', {
      class: 'travel-search', type: 'search', placeholder: 'Search towns, dungeons, temples…',
      'aria-label': 'Find a place by name', autocomplete: 'off', spellcheck: 'false',
    });
    const filter = el('select', { class: 'travel-filter', 'aria-label': 'Kind of place' },
      ...FILTERS.map((f) => el('option', { value: f.id }, f.fullLabel)));
    const results = el('ol', { class: 'travel-results', 'aria-label': 'Places' });
    const detail = el('section', { class: 'travel-detail', 'aria-live': 'polite' });
    const status = el('p', { class: 'travel-status', role: 'status' });

    root.append(
      el('div', { class: 'travel-top' },
        el('div', { class: 'travel-top-row' }, here, hereCoords),
        notice),
      el('div', { class: 'travel-body' },
        el('div', { class: 'travel-mapcol' },
          el('div', { class: 'travel-bar' }, crumbs, tools),
          frame,
          hoverBar,
          filterBar),
        el('div', { class: 'travel-side' },
          el('div', { class: 'travel-find' }, search, filter),
          results,
          detail,
          status)),
    );

    // ----------------------------------------------------- camera & cached canvases

    const srcCache = new Map(); // imageName -> HTMLCanvasElement
    const maskTintCache = new Map(); // `${regionIndex}:${kind}` -> HTMLCanvasElement
    const routeCache = new Map(); // `${fromKey}->${toKey}` -> route points
    let picker = null, renderedSource = null, drawToken = 0;
    let activeImg = null; // { name, canvas, width, height, kind: 'overview'|'region', ox, oy, scale }
    let miniRect = null; // { x, y, w, h } in CSS pixels when inset minimap is shown
    const ctx2d = canvas.getContext('2d');

    const maxZoom = () => (S.region == null ? MAX_OVERVIEW_ZOOM : MAX_REGION_ZOOM);

    function clampCam() {
      S.cam.zoom = clamp(S.cam.zoom, MIN_ZOOM, maxZoom());
      const half = 0.5 / S.cam.zoom;
      S.cam.cx = clamp(S.cam.cx, half, 1 - half);
      S.cam.cy = clamp(S.cam.cy, half, 1 - half);
      zoomReadout.textContent = `${S.cam.zoom.toFixed(1)}×`;
      zoomOutBtn.disabled = S.cam.zoom <= MIN_ZOOM + 0.01;
      zoomInBtn.disabled = S.cam.zoom >= maxZoom() - 0.01;
      fitBtn.disabled = S.cam.zoom <= MIN_ZOOM + 0.01;
    }

    function resetCam() {
      S.cam.zoom = 1;
      S.cam.cx = 0.5;
      S.cam.cy = 0.5;
      clampCam();
    }

    function zoomAt(factor, normX = 0.5, normY = 0.5) {
      const prevZoom = S.cam.zoom;
      const nextZoom = clamp(prevZoom * factor, MIN_ZOOM, maxZoom());
      if (Math.abs(nextZoom - prevZoom) < 0.001) return;
      const vx0 = S.cam.cx - 0.5 / prevZoom;
      const vy0 = S.cam.cy - 0.5 / prevZoom;
      const imgX = vx0 + normX / prevZoom;
      const imgY = vy0 + normY / prevZoom;
      S.cam.zoom = nextZoom;
      S.cam.cx = imgX - (normX - 0.5) / nextZoom;
      S.cam.cy = imgY - (normY - 0.5) / nextZoom;
      clampCam();
      renderCanvas();
    }

    function focusMapPoint(entry, zoom = 2.6) {
      if (!entry || S.region == null) return;
      const name = regionMapNames(S.region)[S.mapIndex];
      const origin = regionMapCorner(name);
      if (!origin) return;
      const [ox, oy] = origin;
      const scale = regionMapScale(S.region);
      const px = (entry.x - ox) * scale + scale / 2;
      const py = (entry.y - oy) * scale + scale / 2;
      if (px < 0 || py < 0 || px > REGION_MAP_W || py > REGION_MAP_H) return;
      S.cam.zoom = clamp(Math.max(S.cam.zoom, zoom), MIN_ZOOM, maxZoom());
      S.cam.cx = px / REGION_MAP_W;
      S.cam.cy = py / REGION_MAP_H;
      clampCam();
    }

    function centerOnPlayer() {
      const h = hereEntry();
      if (!h) return;
      if (REGION_NAMES[h.regionIndex]) {
        const idx = Math.max(0, regionMapFor(h.regionIndex, h.x, h.y));
        const changed = S.region !== h.regionIndex || S.mapIndex !== idx;
        S.region = h.regionIndex;
        S.mapIndex = idx;
        focusMapPoint(h, 2.5);
        if (changed) { drawResults(); drawFilters(); }
        drawMap();
      }
    }

    zoomOutBtn.addEventListener('click', () => zoomAt(1 / 1.45, 0.5, 0.5));
    zoomInBtn.addEventListener('click', () => zoomAt(1.45, 0.5, 0.5));
    fitBtn.addEventListener('click', () => { resetCam(); renderCanvas(); });
    locateBtn.addEventListener('click', centerOnPlayer);

    search.addEventListener('input', () => { S.query = search.value; drawResults(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results.querySelector('button');
        if (first) { e.preventDefault(); first.click(); }
      }
      e.stopPropagation();
    });
    filter.addEventListener('change', () => { S.filter = filter.value; drawFilters(); drawResults(); renderCanvas(); });

    function getRoutePoints(from, to) {
      if (!from || !to) return null;
      const w = S.worldValue;
      const climateKey = travelState().server === 'classic' ? 'classic' : 'pak';
      const key = `${from.x},${from.y}->${to.x},${to.y}:${climateKey}`;
      if (routeCache.has(key)) return routeCache.get(key);
      const climateAt = climateKey === 'classic' || !w?.climate ? null : (x, y) => w.climate.atMapPixel(x, y);
      const r = journeyRoute(from, to, { climateAt });
      if (routeCache.size > 40) routeCache.clear();
      routeCache.set(key, r.points);
      return r.points;
    }

    function regionTintOverlay(regionIdx, fillRgb, borderRgb) {
      if (!picker || regionIdx < 0) return null;
      const key = `${regionIdx}:${fillRgb.join(',')}`;
      if (maskTintCache.has(key)) return maskTintCache.get(key);
      const w = picker.width, h = picker.height, idx = picker.indices;
      const target = regionIdx + 128;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (idx[i] !== target) continue;
          const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
            || idx[i - 1] !== target || idx[i + 1] !== target
            || idx[i - w] !== target || idx[i + w] !== target;
          const c = edge ? borderRgb : fillRgb;
          rgba[i * 4] = c[0];
          rgba[i * 4 + 1] = c[1];
          rgba[i * 4 + 2] = c[2];
          rgba[i * 4 + 3] = c[3];
        }
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
      if (maskTintCache.size > 40) maskTintCache.clear();
      maskTintCache.set(key, c);
      return c;
    }

    // ----------------------------------------------------- animation loop (subtle beacon pulse)

    let animTimer = null;
    const startPulse = () => {
      if (animTimer) return;
      animTimer = setInterval(() => {
        if (!root.isConnected) { clearInterval(animTimer); animTimer = null; return; }
        S.pulsePhase = (S.pulsePhase + 1) % 8;
        S.flashOn = S.pulsePhase < 5;
        if (activeImg) renderCanvas();
      }, 220);
    };

    // ----------------------------------------------------- map drawing

    function imgToCanvasCoord(imgX, imgY, cw, ch) {
      if (!activeImg) return [0, 0];
      const vw = activeImg.width / S.cam.zoom;
      const vh = activeImg.height / S.cam.zoom;
      const vx0 = S.cam.cx * activeImg.width - vw / 2;
      const vy0 = S.cam.cy * activeImg.height - vh / 2;
      return [((imgX - vx0) / vw) * cw, ((imgY - vy0) / vh) * ch];
    }

    function clientToImgCoord(clientX, clientY) {
      if (!activeImg) return null;
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const nx = (clientX - r.left) / r.width;
      const ny = (clientY - r.top) / r.height;
      const vw = activeImg.width / S.cam.zoom;
      const vh = activeImg.height / S.cam.zoom;
      const vx0 = S.cam.cx * activeImg.width - vw / 2;
      const vy0 = S.cam.cy * activeImg.height - vh / 2;
      return {
        imgX: vx0 + nx * vw,
        imgY: vy0 + ny * vh,
        nx, ny,
        cssX: clientX - r.left,
        cssY: clientY - r.top,
        rect: r,
      };
    }

    function drawMarkerShape(g, x, y, r, style, dpr, highlight = false) {
      g.save();
      g.fillStyle = style.color;
      g.strokeStyle = highlight ? '#fff7dc' : style.ring;
      g.lineWidth = (highlight ? 1.8 : 1.1) * dpr;
      g.beginPath();
      switch (style.shape) {
        case 'star': {
          const outer = r * 1.45, inner = r * 0.62;
          for (let i = 0; i < 8; i++) {
            const a = (i * Math.PI) / 4 - Math.PI / 2;
            const rad = i % 2 === 0 ? outer : inner;
            const px = x + Math.cos(a) * rad, py = y + Math.sin(a) * rad;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
          }
          g.closePath();
          g.fill();
          g.stroke();
          break;
        }
        case 'diamond':
          g.moveTo(x, y - r * 1.25);
          g.lineTo(x + r * 1.15, y);
          g.lineTo(x, y + r * 1.25);
          g.lineTo(x - r * 1.15, y);
          g.closePath();
          g.fill();
          g.stroke();
          break;
        case 'cross': {
          const arm = r * 1.2, th = Math.max(1.2 * dpr, r * 0.45);
          g.rect(x - th, y - arm, th * 2, arm * 2);
          g.rect(x - arm, y - th, arm * 2, th * 2);
          g.fill();
          g.strokeStyle = style.ring;
          g.lineWidth = 0.8 * dpr;
          g.strokeRect(x - th, y - arm, th * 2, arm * 2);
          g.strokeRect(x - arm, y - th, arm * 2, th * 2);
          break;
        }
        case 'square':
          g.rect(x - r, y - r, r * 2, r * 2);
          g.fill();
          g.stroke();
          break;
        case 'circle':
          g.arc(x, y, r * 1.05, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          break;
        default:
          g.arc(x, y, r * 0.78, 0, Math.PI * 2);
          g.fill();
          g.stroke();
          break;
      }
      g.restore();
    }

    function drawLabelPill(g, text, x, y, dpr, { accent = false, maxW = 999 } = {}) {
      g.save();
      g.font = `${accent ? '600' : '400'} ${(accent ? 13 : 11.5) * dpr}px "DFW Five", "DFW Pixel", "Pixelify Sans", sans-serif`;
      const tw = g.measureText(text).width;
      const padX = 5 * dpr, h = (accent ? 16 : 14) * dpr;
      const bw = Math.min(maxW, tw + padX * 2);
      const bx = x - bw / 2;
      const by = y - h - 6 * dpr;
      g.fillStyle = accent ? 'rgba(24, 52, 54, 0.94)' : 'rgba(20, 22, 26, 0.88)';
      g.strokeStyle = accent ? '#a4dadb' : '#737882';
      g.lineWidth = 1 * dpr;
      g.fillRect(bx, by, bw, h);
      g.strokeRect(bx + 0.5, by + 0.5, bw - 1, h - 1);
      g.fillStyle = accent ? '#eef7f7' : '#e4e7ec';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, x, by + h / 2 + 0.5 * dpr, bw - padX);
      g.restore();
      return { x1: bx, y1: by, x2: bx + bw, y2: by + h };
    }

    function renderCanvas() {
      if (!activeImg) return;
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(320, Math.round(rect.width || 640));
      const aspect = activeImg.height / activeImg.width;
      const cssH = Math.max(160, Math.round(cssW * aspect));
      const cw = Math.round(cssW * dpr);
      const ch = Math.round(cssH * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }

      const g = ctx2d;
      g.save();
      g.fillStyle = '#0c0d10';
      g.fillRect(0, 0, cw, ch);

      const vw = activeImg.width / S.cam.zoom;
      const vh = activeImg.height / S.cam.zoom;
      const vx0 = S.cam.cx * activeImg.width - vw / 2;
      const vy0 = S.cam.cy * activeImg.height - vh / 2;

      g.imageSmoothingEnabled = false;
      g.drawImage(activeImg.canvas, vx0, vy0, vw, vh, 0, 0, cw, ch);

      const here = hereEntry();
      const pulse = 0.5 + 0.5 * Math.sin((S.pulsePhase / 8) * Math.PI * 2);

      if (activeImg.kind === 'overview') {
        miniRect = null;
        // Player's current region tint
        if (here && here.regionIndex >= 0 && picker) {
          const ov = regionTintOverlay(here.regionIndex, [95, 163, 165, 80], [164, 218, 219, 230]);
          if (ov) {
            g.save();
            g.globalAlpha = 0.55 + 0.45 * pulse;
            g.drawImage(ov, vx0, vy0, vw, vh, 0, 0, cw, ch);
            g.restore();
          }
        }
        // Hovered region highlight
        if (S.hoveredRegion >= 0 && picker) {
          const hv = regionTintOverlay(S.hoveredRegion, [52, 111, 114, 105], [238, 247, 247, 245]);
          if (hv) g.drawImage(hv, vx0, vy0, vw, vh, 0, 0, cw, ch);
        }
        // Subtle cartographic vignette
        drawVignette(g, cw, ch);
      } else {
        const w = S.worldValue;
        const ox = activeImg.ox, oy = activeImg.oy, scale = activeImg.scale;
        const f = FILTERS.find((x) => x.id === S.filter) ?? FILTERS[0];
        const allInRegion = w?.catalog.inRegion(REGION_NAMES[S.region]) ?? [];
        const visiblePlaces = [];

        // Draw route preview FIRST (under markers) if destination is selected or hovered
        const routeTarget = S.selected ?? S.hovered;
        if (here && routeTarget && routeTarget.id !== currentId()) {
          const pts = getRoutePoints(here, routeTarget);
          if (pts && pts.length > 1) {
            g.save();
            g.lineCap = 'round';
            g.lineJoin = 'round';
            // Dark ink casing
            g.strokeStyle = 'rgba(8, 10, 12, 0.88)';
            g.lineWidth = 4.2 * dpr;
            g.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const [cx, cy] = imgToCanvasCoord((pts[i].x - ox) * scale + scale / 2, (pts[i].y - oy) * scale + scale / 2, cw, ch);
              if (i === 0) g.moveTo(cx, cy); else g.lineTo(cx, cy);
            }
            g.stroke();
            // Dashed bone-white land & verdigris-cyan sea segments
            g.lineWidth = 2.2 * dpr;
            g.setLineDash([6 * dpr, 5 * dpr]);
            for (let i = 1; i < pts.length; i++) {
              const [ax, ay] = imgToCanvasCoord((pts[i - 1].x - ox) * scale + scale / 2, (pts[i - 1].y - oy) * scale + scale / 2, cw, ch);
              const [bx, by] = imgToCanvasCoord((pts[i].x - ox) * scale + scale / 2, (pts[i].y - oy) * scale + scale / 2, cw, ch);
              const isSea = pts[i].climate === CLIMATE.OCEAN;
              g.strokeStyle = isSea ? '#8edae0' : (S.selected ? '#eef4f8' : 'rgba(238, 244, 248, 0.72)');
              g.beginPath();
              g.moveTo(ax, ay);
              g.lineTo(bx, by);
              g.stroke();
            }
            g.setLineDash([]);
            g.restore();
          }
        }

        // Collect & draw visible markers
        const baseR = clamp(1.75 + Math.log2(S.cam.zoom) * 1.25, 1.75, 5.2) * dpr;
        for (const l of allInRegion) {
          if (!visible(l) || !f.test(l)) continue;
          const imgX = (l.x - ox) * scale + scale / 2;
          const imgY = (l.y - oy) * scale + scale / 2;
          if (imgX < vx0 - 12 || imgY < vy0 - 12 || imgX > vx0 + vw + 12 || imgY > vy0 + vh + 12) continue;
          const [cx, cy] = imgToCanvasCoord(imgX, imgY, cw, ch);
          const style = MARKER_STYLE[l.type] ?? MARKER_STYLE.hamlet;
          visiblePlaces.push({ entry: l, cx, cy, style });
        }
        // Sort low priority first so cities/temples/dungeons render cleanly on top
        visiblePlaces.sort((a, b) => a.style.priority - b.style.priority);
        for (const p of visiblePlaces) {
          const isSel = S.selected?.id === p.entry.id;
          const isHov = S.hovered?.id === p.entry.id;
          const r = p.entry.type === 'city' ? baseR * 1.25 : baseR * 0.92;
          drawMarkerShape(g, p.cx, p.cy, isSel || isHov ? r * 1.3 : r, p.style, dpr, isSel || isHov);
        }

        // Pulsing beacon for player's current position
        if (here && here.regionIndex === S.region) {
          const imgX = (here.x - ox) * scale + scale / 2;
          const imgY = (here.y - oy) * scale + scale / 2;
          const [hx, hy] = imgToCanvasCoord(imgX, imgY, cw, ch);
          g.save();
          const outer = (7 + pulse * 5) * dpr;
          g.strokeStyle = `rgba(164, 218, 219, ${(0.88 - pulse * 0.45).toFixed(2)})`;
          g.lineWidth = 1.6 * dpr;
          g.beginPath();
          g.arc(hx, hy, outer, 0, Math.PI * 2);
          g.stroke();
          // Compass diamond
          g.fillStyle = '#ffffff';
          g.strokeStyle = '#143335';
          g.lineWidth = 1.8 * dpr;
          const dr = 4.6 * dpr;
          g.beginPath();
          g.moveTo(hx, hy - dr);
          g.lineTo(hx + dr, hy);
          g.lineTo(hx, hy + dr);
          g.lineTo(hx - dr, hy);
          g.closePath();
          g.fill();
          g.stroke();
          g.restore();
        }

        // Selected destination animated reticle
        if (S.selected && S.selected.regionIndex === S.region) {
          const imgX = (S.selected.x - ox) * scale + scale / 2;
          const imgY = (S.selected.y - oy) * scale + scale / 2;
          const [sx, sy] = imgToCanvasCoord(imgX, imgY, cw, ch);
          g.save();
          const rad = (8 + pulse * 3) * dpr;
          g.strokeStyle = '#e06666';
          g.lineWidth = 2 * dpr;
          g.beginPath();
          g.arc(sx, sy, rad, 0, Math.PI * 2);
          g.stroke();
          // Crosshair ticks
          const t0 = rad - 3 * dpr, t1 = rad + 4 * dpr;
          g.strokeStyle = '#eef7f7';
          g.lineWidth = 1.5 * dpr;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            g.beginPath();
            g.moveTo(sx + dx * t0, sy + dy * t0);
            g.lineTo(sx + dx * t1, sy + dy * t1);
            g.stroke();
          }
          g.restore();
        }

        // Smart non-overlapping landmark labels
        const placedBoxes = [];
        const overlaps = (box) => placedBoxes.some((b) => !(box.x2 + 4 * dpr < b.x1 || box.x1 - 4 * dpr > b.x2 || box.y2 + 3 * dpr < b.y1 || box.y1 - 3 * dpr > b.y2));

        // 1) Always label selected destination first
        if (S.selected && S.selected.regionIndex === S.region) {
          const [sx, sy] = imgToCanvasCoord((S.selected.x - ox) * scale + scale / 2, (S.selected.y - oy) * scale + scale / 2, cw, ch);
          if (sx > 20 && sx < cw - 20 && sy > 24 && sy < ch - 10) {
            placedBoxes.push(drawLabelPill(g, clean(S.selected.name), sx, sy - 6 * dpr, dpr, { accent: true }));
          }
        }
        // 2) Label "You" if on screen
        if (here && here.regionIndex === S.region && here.id !== S.selected?.id) {
          const [hx, hy] = imgToCanvasCoord((here.x - ox) * scale + scale / 2, (here.y - oy) * scale + scale / 2, cw, ch);
          if (hx > 20 && hx < cw - 20 && hy > 24 && hy < ch - 10) {
            const box = drawLabelPill(g, here.name ? `${clean(here.name)} (You)` : 'You are here', hx, hy - 5 * dpr, dpr, { accent: true });
            placedBoxes.push(box);
          }
        }
        // 3) Zoomed-in major settlement labels
        if (S.cam.zoom >= 1.35) {
          const minPri = S.cam.zoom >= 3.2 ? 4 : S.cam.zoom >= 2.0 ? 6 : 9;
          const maxLabels = S.cam.zoom >= 3.2 ? 18 : 10;
          let count = 0;
          for (let i = visiblePlaces.length - 1; i >= 0 && count < maxLabels; i--) {
            const p = visiblePlaces[i];
            if (p.style.priority < minPri) break;
            if (p.entry.id === S.selected?.id || p.entry.id === here?.id) continue;
            if (p.cx < 32 * dpr || p.cx > cw - 32 * dpr || p.cy < 28 * dpr || p.cy > ch - 16 * dpr) continue;
            const label = clean(p.entry.name);
            g.font = `400 ${11.5 * dpr}px "DFW Five", "DFW Pixel", "Pixelify Sans", sans-serif`;
            const estW = g.measureText(label).width + 10 * dpr;
            const estBox = { x1: p.cx - estW / 2, y1: p.cy - 22 * dpr, x2: p.cx + estW / 2, y2: p.cy - 8 * dpr };
            if (overlaps(estBox)) continue;
            placedBoxes.push(drawLabelPill(g, label, p.cx, p.cy - 2 * dpr, dpr));
            count++;
          }
        }

        drawVignette(g, cw, ch);

        // Inset Navigator Mini-Map when zoomed in
        if (S.cam.zoom > 1.05) {
          const mw = Math.round(cw * MINI_W_FRAC);
          const mh = Math.round(mw * (activeImg.height / activeImg.width));
          const mx = cw - mw - MINI_PAD * dpr;
          const my = ch - mh - MINI_PAD * dpr;
          miniRect = { x: mx / dpr, y: my / dpr, w: mw / dpr, h: mh / dpr };

          g.save();
          // Chiseled stone outer bezel
          g.fillStyle = 'rgba(20, 22, 26, 0.94)';
          g.fillRect(mx - 3 * dpr, my - 3 * dpr, mw + 6 * dpr, mh + 6 * dpr);
          g.imageSmoothingEnabled = false;
          g.drawImage(activeImg.canvas, mx, my, mw, mh);
          // Dim outside current viewport
          const rx = mx + (vx0 / activeImg.width) * mw;
          const ry = my + (vy0 / activeImg.height) * mh;
          const rw = (vw / activeImg.width) * mw;
          const rh = (vh / activeImg.height) * mh;
          g.fillStyle = 'rgba(8, 10, 12, 0.56)';
          g.fillRect(mx, my, mw, Math.max(0, ry - my));
          g.fillRect(mx, ry + rh, mw, Math.max(0, (my + mh) - (ry + rh)));
          g.fillRect(mx, ry, Math.max(0, rx - mx), rh);
          g.fillRect(rx + rw, ry, Math.max(0, (mx + mw) - (rx + rw)), rh);
          // Player & selected dots on mini-map
          if (here && here.regionIndex === S.region) {
            const px = mx + (((here.x - ox) * scale + scale / 2) / activeImg.width) * mw;
            const py = my + (((here.y - oy) * scale + scale / 2) / activeImg.height) * mh;
            g.fillStyle = '#ffffff';
            g.fillRect(px - 2 * dpr, py - 2 * dpr, 4 * dpr, 4 * dpr);
          }
          if (S.selected && S.selected.regionIndex === S.region) {
            const px = mx + (((S.selected.x - ox) * scale + scale / 2) / activeImg.width) * mw;
            const py = my + (((S.selected.y - oy) * scale + scale / 2) / activeImg.height) * mh;
            g.fillStyle = '#e06666';
            g.fillRect(px - 2 * dpr, py - 2 * dpr, 4 * dpr, 4 * dpr);
          }
          // Bright verdigris-white viewport frame
          g.strokeStyle = '#a4dadb';
          g.lineWidth = 1.5 * dpr;
          g.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
          // Carved grey stone border around mini-map
          g.strokeStyle = '#828791';
          g.lineWidth = 1.5 * dpr;
          g.strokeRect(mx - 1.5 * dpr, my - 1.5 * dpr, mw + 3 * dpr, mh + 3 * dpr);
          g.restore();
        } else {
          miniRect = null;
        }
      }
      g.restore();
    }

    function drawVignette(g, cw, ch) {
      g.save();
      const grad = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.36, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(8, 5, 3, 0.38)');
      g.fillStyle = grad;
      g.fillRect(0, 0, cw, ch);
      g.restore();
    }

    async function drawMap() {
      const token = ++drawToken;
      const images = S.images;
      if (renderedSource !== images) {
        renderedSource = images;
        picker = null;
        activeImg = null;
        srcCache.clear();
        maskTintCache.clear();
        routeCache.clear();
        crumbs.dataset.key = '';
        crumbs.replaceChildren();
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (!images || !S.index?.size) return;
      const key = `${S.region}:${S.mapIndex}`;
      const fresh = crumbs.dataset.key !== key;
      if (fresh) {
        crumbs.replaceChildren();
        crumbs.dataset.key = key;
      }
      try {
        if (S.region == null) {
          if (fresh) crumbs.append(el('span', { class: 'travel-crumb-current' }, 'The Iliac Bay'));
          const [overview, mask] = await Promise.all([
            images.image(OVERVIEW_IMG),
            images.has(PICKER_IMG) ? images.image(PICKER_IMG).catch(() => null) : null,
          ]);
          if (token !== drawToken || images !== S.images) return;
          picker = mask;
          let src = srcCache.get(OVERVIEW_IMG);
          if (!src) { src = imageToCanvas(overview); srcCache.set(OVERVIEW_IMG, src); }
          activeImg = { name: OVERVIEW_IMG, canvas: src, width: overview.width, height: overview.height, kind: 'overview', ox: 0, oy: 0, scale: 1 };
          clampCam();
          renderCanvas();
          canvas.setAttribute('aria-label', 'Map of the Iliac Bay. Choose a region.');
        } else {
          const names = regionMapNames(S.region);
          const name = names[Math.min(S.mapIndex, names.length - 1)];
          if (fresh) crumbs.append(
            el('button', { type: 'button', class: 'travel-crumb', onclick: () => { S.region = null; S.hovered = null; S.hoveredRegion = -1; resetCam(); drawMap(); drawFilters(); drawResults(); } }, 'Iliac Bay'),
            el('span', { class: 'travel-crumb-sep', 'aria-hidden': 'true' }, '›'),
            el('span', { class: 'travel-crumb-current' }, REGION_NAMES[S.region]),
          );
          if (fresh && names.length > 1) {
            names.forEach((_, i) => crumbs.append(el('button', {
              type: 'button', class: 'travel-crumb travel-part', 'aria-pressed': String(i === S.mapIndex),
              onclick: () => { S.mapIndex = i; resetCam(); drawMap(); },
              'data-direction': names.length === 2 ? (i === 0 ? 'west' : 'east') : null,
            }, `Part ${i + 1}`)));
          }
          const regionImg = await images.image(name);
          if (token !== drawToken || images !== S.images) return;
          let src = srcCache.get(name);
          if (!src) { src = imageToCanvas(regionImg); srcCache.set(name, src); }
          const [ox, oy] = regionMapCorner(name);
          const scale = regionMapScale(S.region);
          activeImg = { name, canvas: src, width: REGION_MAP_W, height: REGION_MAP_H, kind: 'region', ox, oy, scale };
          clampCam();
          renderCanvas();
          canvas.setAttribute('aria-label', `Map of ${REGION_NAMES[S.region]}. Scroll to zoom, drag to pan, choose a place.`);
        }
        crumbs.querySelector('.travel-art-error')?.remove();
      } catch (err) {
        if (token !== drawToken || images !== S.images) return;
        activeImg = null;
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        canvas.setAttribute('aria-label', 'Map artwork unavailable');
        const message = `The map pictures could not be read: ${err.message}`;
        const error = crumbs.querySelector('.travel-art-error');
        if (!error) crumbs.append(el('span', { class: 'travel-art-error', role: 'status' }, message));
        else if (error.textContent !== message) error.textContent = message;
      }
    }

    // ----------------------------------------------------- hit testing & interaction

    const regionAt = (x, y) => {
      if (!picker) return -1;
      const ix = Math.floor(x), iy = Math.floor(y);
      if (ix < 0 || iy < 0 || ix >= picker.width || iy >= picker.height) return -1;
      const v = picker.indices[iy * picker.width + ix];
      const reg = v - 128;
      return v >= 128 && reg < REGION_NAMES.length ? reg : -1;
    };

    function nearestAt(imgX, imgY) {
      const w = S.worldValue;
      if (!w || S.region == null || !activeImg) return null;
      const ox = activeImg.ox, oy = activeImg.oy, scale = activeImg.scale;
      const f = FILTERS.find((q) => q.id === S.filter) ?? FILTERS[0];
      // Hit radius shrinks in image pixels as zoom grows, staying comfortable (~10 CSS px)
      const hitImgR = Math.max(2.2, 6.5 / S.cam.zoom) * scale;
      let best = null, bestD = hitImgR * hitImgR;
      for (const l of w.catalog.inRegion(REGION_NAMES[S.region])) {
        if (!visible(l) || !f.test(l)) continue;
        const dx = (l.x - ox) * scale + scale / 2 - imgX;
        const dy = (l.y - oy) * scale + scale / 2 - imgY;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = l; }
      }
      return best;
    }

    function inMiniMap(cssX, cssY) {
      return miniRect && cssX >= miniRect.x && cssX <= miniRect.x + miniRect.w && cssY >= miniRect.y && cssY <= miniRect.y + miniRect.h;
    }

    function panFromMiniMap(cssX, cssY) {
      if (!miniRect) return;
      S.cam.cx = clamp((cssX - miniRect.x) / miniRect.w, 0, 1);
      S.cam.cy = clamp((cssY - miniRect.y) / miniRect.h, 0, 1);
      clampCam();
      renderCanvas();
    }

    function showTooltip(cssX, cssY, rect, lines) {
      if (!lines) { tooltip.hidden = true; return; }
      tooltip.replaceChildren(...lines);
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth || 180;
      const th = tooltip.offsetHeight || 48;
      const left = clamp(cssX + 14, 8, Math.max(8, rect.width - tw - 8));
      const top = cssY - th - 12 >= 8 ? cssY - th - 12 : Math.min(rect.height - th - 8, cssY + 16);
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    }

    let drag = null; // { startX, startY, startCx, startCy, moved, mini }

    canvas.addEventListener('wheel', (e) => {
      if (!activeImg) return;
      e.preventDefault();
      const pt = clientToImgCoord(e.clientX, e.clientY);
      if (!pt) return;
      const factor = e.deltaY < 0 ? 1.28 : 1 / 1.28;
      zoomAt(factor, pt.nx, pt.ny);
    }, { passive: false });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !activeImg) return;
      const pt = clientToImgCoord(e.clientX, e.clientY);
      if (!pt) return;
      canvas.setPointerCapture?.(e.pointerId);
      if (inMiniMap(pt.cssX, pt.cssY)) {
        drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, moved: true, mini: true };
        panFromMiniMap(pt.cssX, pt.cssY);
        tooltip.hidden = true;
        return;
      }
      drag = {
        id: e.pointerId, startX: e.clientX, startY: e.clientY,
        startCx: S.cam.cx, startCy: S.cam.cy, moved: false, mini: false,
      };
    });

    canvas.addEventListener('pointermove', (e) => {
      const pt = clientToImgCoord(e.clientX, e.clientY);
      if (!pt) return;

      if (drag && drag.id === e.pointerId) {
        if (drag.mini) {
          panFromMiniMap(pt.cssX, pt.cssY);
          return;
        }
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true;
          canvas.classList.add('is-dragging');
          tooltip.hidden = true;
        }
        if (drag.moved && S.cam.zoom > 1.001) {
          S.cam.cx = drag.startCx - (dx / pt.rect.width) / S.cam.zoom;
          S.cam.cy = drag.startCy - (dy / pt.rect.height) / S.cam.zoom;
          clampCam();
          renderCanvas();
          return;
        }
      }

      if (inMiniMap(pt.cssX, pt.cssY)) {
        canvas.style.cursor = 'crosshair';
        tooltip.hidden = true;
        hoverText.textContent = 'Drag inside mini-map to pan';
        hoverCoords.textContent = '';
        return;
      }

      if (S.region == null) {
        const r = regionAt(pt.imgX, pt.imgY);
        if (r !== S.hoveredRegion) {
          S.hoveredRegion = r;
          renderCanvas();
        }
        canvas.style.cursor = r >= 0 ? 'pointer' : (S.cam.zoom > 1 ? 'grab' : 'default');
        if (r >= 0) {
          const name = REGION_NAMES[r];
          const count = (S.worldValue?.catalog.inRegion(name) ?? []).filter(visible).length;
          hoverText.textContent = `${name} — ${count} known place${count === 1 ? '' : 's'} · Click to inspect`;
          hoverCoords.textContent = '';
          showTooltip(pt.cssX, pt.cssY, pt.rect, [
            el('strong', { class: 'travel-tip-title' }, name),
            el('span', { class: 'travel-tip-meta' }, `${count} known place${count === 1 ? '' : 's'}`),
            el('span', { class: 'travel-tip-hint' }, 'Click to open region'),
          ]);
        } else {
          hoverText.textContent = 'Click a realm of the Iliac Bay to inspect its settlements · Scroll to zoom';
          hoverCoords.textContent = '';
          tooltip.hidden = true;
        }
      } else {
        const mapX = Math.round(activeImg.ox + pt.imgX / activeImg.scale);
        const mapY = Math.round(activeImg.oy + pt.imgY / activeImg.scale);
        hoverCoords.textContent = `${mapX}, ${mapY}`;
        const l = nearestAt(pt.imgX, pt.imgY);
        if (l !== S.hovered) {
          S.hovered = l;
          renderCanvas();
        }
        canvas.style.cursor = l ? 'pointer' : (S.cam.zoom > 1 ? 'grab' : 'crosshair');
        if (l) {
          const st = MARKER_STYLE[l.type] ?? MARKER_STYLE.hamlet;
          const isHere = l.id === currentId();
          const q = !isHere ? quote(l) : null;
          const eta = isHere ? 'You are here' : q ? `${q.days} day${q.days === 1 ? '' : 's'} · ${q.cost.total} gold` : '';
          hoverText.textContent = `${clean(l.name)} · ${TYPE_LABEL[l.type] ?? l.type}${eta ? ` · ${eta}` : ''}`;
          showTooltip(pt.cssX, pt.cssY, pt.rect, [
            el('div', { class: 'travel-tip-head' },
              el('span', { class: 'travel-tip-dot', style: `background:${st.color}` }),
              el('strong', { class: 'travel-tip-title' }, clean(l.name))),
            el('span', { class: 'travel-tip-meta' }, `${TYPE_LABEL[l.type] ?? l.type} · ${l.x}, ${l.y}`),
            eta ? el('span', { class: 'travel-tip-eta' }, eta) : null,
          ].filter(Boolean));
        } else {
          hoverText.textContent = S.cam.zoom > 1.05
            ? 'Drag to pan · Scroll to zoom · Click a settlement to plot route'
            : 'Scroll to zoom in · Hover markers for details · Click to plot route';
          tooltip.hidden = true;
        }
      }
    });

    const endDrag = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const wasMoved = drag.moved;
      const wasMini = drag.mini;
      drag = null;
      canvas.classList.remove('is-dragging');
      if (wasMoved || wasMini) return;
      const pt = clientToImgCoord(e.clientX, e.clientY);
      if (!pt) return;
      if (S.region == null) {
        const r = regionAt(pt.imgX, pt.imgY);
        if (r >= 0) { openRegion(r); drawFilters(); drawResults(); }
      } else {
        const l = nearestAt(pt.imgX, pt.imgY);
        if (l) select(l, { recentre: false });
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', () => {
      if (S.hovered || S.hoveredRegion >= 0) {
        S.hovered = null;
        S.hoveredRegion = -1;
        renderCanvas();
      }
      tooltip.hidden = true;
      hoverCoords.textContent = '';
    });

    canvas.addEventListener('dblclick', (e) => {
      const pt = clientToImgCoord(e.clientX, e.clientY);
      if (!pt) return;
      if (S.region == null) {
        const r = regionAt(pt.imgX, pt.imgY);
        if (r >= 0) { openRegion(r); drawFilters(); drawResults(); }
      } else if (S.cam.zoom >= maxZoom() - 0.1) {
        resetCam();
        renderCanvas();
      } else {
        zoomAt(2, pt.nx, pt.ny);
      }
    });

    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.region != null) {
        e.preventDefault(); e.stopPropagation();
        S.region = null; S.hovered = null; resetCam(); drawMap(); drawFilters(); drawResults();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault(); zoomAt(1.4, 0.5, 0.5);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault(); zoomAt(1 / 1.4, 0.5, 0.5);
      } else if (e.key === '0') {
        e.preventDefault(); resetCam(); renderCanvas();
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && S.cam.zoom > 1.01) {
        e.preventDefault();
        const step = 0.14 / S.cam.zoom;
        if (e.key === 'ArrowLeft') S.cam.cx -= step;
        if (e.key === 'ArrowRight') S.cam.cx += step;
        if (e.key === 'ArrowUp') S.cam.cy -= step;
        if (e.key === 'ArrowDown') S.cam.cy += step;
        clampCam();
        renderCanvas();
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => { if (activeImg && root.isConnected) renderCanvas(); }).observe(frame);
    }

    function openRegion(r, focusEntry = null) {
      const changed = S.region !== r;
      S.region = r;
      S.hovered = null;
      S.hoveredRegion = -1;
      const names = regionMapNames(r);
      S.mapIndex = 0;
      if (focusEntry) {
        const i = regionMapFor(r, focusEntry.x, focusEntry.y);
        if (i >= 0) S.mapIndex = i;
      }
      if (S.mapIndex >= names.length) S.mapIndex = 0;
      if (changed) resetCam();
      if (focusEntry) focusMapPoint(focusEntry, Math.max(S.cam.zoom, 2.2));
      drawMap();
    }

    function select(entry, { recentre = true } = {}) {
      S.selected = entry;
      if (recentre || S.region !== entry.regionIndex) openRegion(entry.regionIndex, entry);
      else renderCanvas();
      drawFilters();
      drawDetail();
      drawResults();
    }

    // ----------------------------------------------------- filter & legend bar

    function drawFilters() {
      const w = S.worldValue;
      const pool = w && S.region != null ? w.catalog.inRegion(REGION_NAMES[S.region]).filter(visible) : null;
      filterBar.replaceChildren(...FILTERS.map((f) => {
        const count = pool ? pool.filter(f.test).length : null;
        return el('button', {
          type: 'button',
          class: 'travel-fchip',
          'aria-pressed': String(S.filter === f.id),
          onclick: () => {
            S.filter = f.id;
            filter.value = f.id;
            drawFilters();
            drawResults();
            renderCanvas();
          },
        },
        el('span', { class: 'travel-fchip-dot', style: `background:${f.color}` }),
        el('span', { class: 'travel-fchip-name' }, f.label),
        count != null ? el('span', { class: 'travel-fchip-n' }, String(count)) : null);
      }));
    }

    // ----------------------------------------------------- results

    const mapPosition = (entry) => (S.worldValue?.catalog.ambiguous(entry) ? ` · ${entry.x}, ${entry.y}` : '');

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
          : S.region == null ? 'Choose a realm on the map, or search by name.' : 'You know of no such places here.';
        results.append(el('li', { class: 'travel-empty' }, msg));
        return;
      }
      const from = hereEntry();
      for (const l of list) {
        const hereFlag = l.id === currentId();
        const st = MARKER_STYLE[l.type] ?? MARKER_STYLE.hamlet;
        const dist = from && !hereFlag ? Math.round(Math.hypot(l.x - from.x, l.y - from.y)) : null;
        results.append(el('li', {},
          el('button', {
            type: 'button', class: 'travel-result', 'aria-current': S.selected?.id === l.id ? 'true' : null,
            onclick: () => select(l),
          },
          el('span', { class: 'travel-result-dot', style: `background:${st.color}` }),
          el('span', { class: 'travel-result-main' },
            el('span', { class: 'travel-result-name' }, clean(l.name)),
            el('span', { class: 'travel-result-meta' }, `${TYPE_LABEL[l.type] ?? l.type}${mapPosition(l)} · ${l.region}${hereFlag ? ' · You are here' : ''}`)),
          dist != null ? el('span', { class: 'travel-result-dist' }, `${dist} mi`) : null)));
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
      const hereFlag = l.id === currentId();
      const st = MARKER_STYLE[l.type] ?? MARKER_STYLE.hamlet;
      detail.append(
        el('div', { class: 'travel-dest-head' },
          el('span', { class: 'travel-dest-dot', style: `background:${st.color}` }),
          el('div', {},
            el('h3', { class: 'travel-dest' }, clean(l.name)),
            el('p', { class: 'travel-dest-meta' }, `${TYPE_LABEL[l.type] ?? l.type} in ${l.region} · Map ${l.x}, ${l.y}`))),
      );
      if (hereFlag) {
        detail.append(el('p', { class: 'travel-note' }, 'You stand here already.'));
        return;
      }
      if (S.seaPixel) {
        detail.append(el('button', { type: 'button', class: 'btn', onclick: () => api.openPanel('sailing') }, 'Open sailing chart'));
        return;
      }
      const tp = teleportOffer();
      if (tp) {
        detail.append(
          el('p', { class: 'travel-note travel-teleport' }, `${tp.name} of the Mages Guild will send you there at once, free of charge.`),
          el('div', { class: 'travel-detail-actions' },
            el('button', { type: 'button', class: 'btn btn-primary travel-go', disabled: !!S.pending, onclick: () => teleport(l, tp) },
              S.pending ? 'Teleporting…' : `Teleport to ${clean(l.name)}`),
            el('button', { type: 'button', class: 'btn btn-small travel-teleport-cancel', onclick: () => { api.guildTeleport = null; drawDetail(); } }, 'Travel normally')),
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
        ['Your purse', `${gold} gold`],
      ];
      if (terrain) rows.push(['Country', terrain]);
      detail.append(el('dl', { class: 'travel-quote' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
      if (q.options.speed === 'cautious') detail.append(el('p', { class: 'travel-note' }, 'A cautious journey arrives rested.'));
      const busy = !!S.pending || !!S.loadingId;
      const short = q.cost.total > gold;
      const outside = !!(parseLocationId(currentId()) || wildernessOrigin(currentId()));
      const go = el('button', {
        type: 'button', class: 'btn btn-primary travel-go', disabled: busy || short || !outside,
        onclick: () => travel(l, q),
      }, S.pending ? 'Travelling…' : `Begin Journey to ${clean(l.name)}`);
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
      const h = hereEntry();
      here.textContent = S.seaPixel
        ? `Sailing the Iliac Bay`
        : entry
        ? `${clean(entry.name)}, ${entry.region}`
        : where ? `${clean(placeLabel(cur))}, ${regionNameOf(where.region)}`
        : wild ? `Wilderness of ${wild.region || 'the Iliac Bay'}` : 'Indoors';
      hereCoords.textContent = h ? `Map square ${h.x}, ${h.y}` : '';
      locateBtn.disabled = !h || !REGION_NAMES[h.regionIndex];

      const notes = [];
      if (S.worldError) notes.push(`Your files have no readable world map: ${S.worldError.message}`);
      else if (!w) notes.push('Reading the world map from your files…');
      if (t.server === 'classic') notes.push('This server has no world data of its own, so only the great cities and your home town can be visited.');
      if (t.server === 'loading') notes.push('The server is still reading its world map.');
      if (S.loadingId) notes.push(`Drawing ${clean(placeLabel(S.loadingId))}…`);
      notice.replaceChildren(...notes.map((n) => el('span', {}, n)));
      if (S.loadError) {
        notice.append(el('span', { class: 'travel-warn' }, `Could not draw ${clean(placeLabel(S.loadError.id))}: ${S.loadError.message} `),
          el('button', { type: 'button', class: 'btn btn-small travel-retry', onclick: () => { const id = S.loadError.id; S.loadError = null; loadScene(id); } }, 'Try again'));
      }
      status.textContent = S.status;
      if (w) {
        applyInitialPlace(w);
        if (S.selected) S.selected = w.catalog.get(S.selected.id);
        if (S.pendingFocusEntry && S.selected?.id === S.pendingFocusEntry.id) {
          focusMapPoint(S.pendingFocusEntry, 2.2);
          S.pendingFocusEntry = null;
        }
        if (!S.selected && S.region == null && !S.autoRegion) {
          if (h && REGION_NAMES[h.regionIndex]) {
            S.autoRegion = true;
            S.region = h.regionIndex;
            S.mapIndex = Math.max(0, regionMapFor(h.regionIndex, h.x, h.y));
          }
        }
        if (search.value !== S.query) search.value = S.query;
        filter.value = S.filter;
        drawMap();
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
          drawFilters();
          drawResults();
          drawDetail();
        }
        startPulse();
      } else {
        drawMap();
        drawFilters();
        results.replaceChildren();
        detail.replaceChildren();
      }
    };
    return root;
  }

  return { sceneLocationId, applyInitialPlace, get state() { return S; } };
}
