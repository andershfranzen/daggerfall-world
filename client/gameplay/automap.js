// Local automap: a top-down plan of the town, building or dungeon the player is in, drawn from the scene mesh the
// game built from the player's own archives. Live player position and heading, other players here, doors and
// exits, zoom/pan/recenter, and storey selection inside buildings and dungeons (sliced at the player's height like
// Daggerfall Unity's automap). The REGION travel map is a different panel ('map').
//
// Keys: N opens/closes. In the panel: arrows/WASD pan (Shift = faster), + / − zoom, C or Home recentres and
// follows you, 0 shows the whole place, Page Up / Page Down (or [ / ]) change floor, Q / E turn the map,
// H heading-up, X cutaway, K pins a note at the centre (or double-click a spot).
//
// Exploration memory (package 6): inside buildings and dungeons only ground this character has explored is drawn.
// The server reveals it from its own position and line of sight and sends it privately ({kind:'automap'} events);
// town building names appear once learned (by entering, or from directions: character.learnedPlaces).
// Other features may add private markers: api.emit('automap:markers', {source, location, markers:[{kind,id,x,y,z,label?}]}).
// Model: automap/model.js, automap/controller.js, automap/memory.js. Notices: automap/NOTICE.txt.

import { createAutomapController } from './automap/controller.js';
import { worldToScreen, screenToWorld, viewTransform, floorLabel, makeView, headingVector } from './automap/model.js';
import { CELL, MAX_NOTE_TEXT, MAX_NOTEBOOK_TEXT, fogged, cellsBounds } from './automap/memory.js';
import {
  loadAutomapPrefs, saveAutomapPrefs, resetAutomapPrefs,
  MIN_EXTERIOR_ZOOM, MAX_EXTERIOR_ZOOM, MIN_SLICE_OFFSET, MAX_SLICE_OFFSET, MINIMAP_CORNERS, MINIMAP_SIZES,
} from './automap/prefs.js';
import { build3DDrawList, project3D, unproject3D, waterSurface3D, PALETTE } from './automap/view3d.js';
import { create3DRenderer } from './automap/render3d.js';

export const PANEL_ID = 'automap';
export const PANEL_KEY = 'KeyN';
const PAN_STEP = 48;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

export const NOTEBOOK_ID = 'notebook';

const KIND_WORD = { town: 'Town', interior: 'Interior', dungeon: 'Dungeon', unknown: 'Local map' };

function placeName(location, mesh) {
  if (mesh?.name) return String(mesh.name);
  // `interior:R/L/bx,by/record` -> L; `town:R/L` and `dungeon:R/L` -> L.
  const parts = String(location ?? '').replace(/^[a-z]+:/i, '').split('/').filter(Boolean);
  return parts[1] ?? parts[0] ?? 'Here';
}

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-automap-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./automap.css', import.meta.url).href;
  link.dataset.automapCss = '';
  document.head.append(link);
}

export function install(api) {
  const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
  const ctl = createAutomapController({ prefs: loadAutomapPrefs(storage) });
  const ui = {
    root: null, canvas: null, status: null, floorSel: null, title: null, drawn: -1, raf: 0, lastStatus: 0,
    prefsOpen: false, prefsBox: null, modeBtn: null, sliceOut: null, sliceRange: null,
    minimap: null, minimapCanvas: null, minimapTitle: null, minimapDrawn: -1,
    // 3D view: one persistent WebGL canvas under the 2D overlay canvas (markers); null renderer = canvas fallback.
    gl: null, renderer: undefined, water: null,
  };
  const paths = new WeakMap(); // piece -> Path2D in world coordinates
  const persistPrefs = () => { ctl.prefs = saveAutomapPrefs(ctl.prefs, storage); syncMinimap(); };

  if (api.location) ctl.setLocation(api.location);
  if (api.town) ctl.setScene(api.town);
  const external = new Map(); // source -> {location, markers}
  ui.pending = null; // {x, z} awaiting note text

  // Ask the server for this character's memory of the place (on arrival, travel and reconnect).
  const synced = { location: null };
  function requestMemory() {
    const loc = api.location;
    if (!loc || !fogged(loc) || synced.location === loc) return;
    synced.location = loc;
    const r = api.act('automap.sync', {}, { quiet: true });
    if (!r) synced.location = null;
  }
  if (api.location) queueMicrotask(requestMemory);
  api.on('event', (ev) => {
    if (ev?.kind !== 'automap') return;
    if (ctl.applyExplored(ev) && ev.location === ctl.location) {
      if (isOpen()) { if (ui.floorCount !== ctl.floors.length) build(); else { ctl.frame3d(); updateText(); schedule(); } }
    }
  });
  api.on('automap:markers', ({ source, location, markers } = {}) => {
    if (typeof source !== 'string' || !source) return;
    if (!Array.isArray(markers) || !markers.length) external.delete(source);
    else external.set(source, { location: String(location ?? api.location ?? ''), markers: markers.slice(0, 200) });
    ctl.version++;
    schedule();
  });

  // The shell marks the panel open only after render() returns, so "open" means our canvas is on the page.
  const isOpen = () => !!ui.canvas?.isConnected && (api.panel === PANEL_ID || (api.panel == null && ui.canvas.getClientRects().length > 0));
  const schedule = () => {
    if (!isOpen() || ui.raf || typeof requestAnimationFrame === 'undefined') return;
    ui.raf = requestAnimationFrame(() => { ui.raf = 0; draw(); });
  };

  api.on('location', ({ location, previous } = {}) => {
    if (previous == null) synced.location = null; // a (re)connect: fetch again
    requestMemory();
    ui.pending = null;
    if (ctl.setLocation(location)) refresh();
  });
  api.on('state', () => {
    // Notes, learned names and the notebook ride on the private character snapshot.
    const key = JSON.stringify([api.character?.automap ?? null, api.character?.learnedPlaces?.[ctl.location] ?? null]);
    if (key === ui.recordKey) return;
    ui.recordKey = key;
    ctl.version++;
    if (isOpen()) renderNotes();
    if (api.panel === NOTEBOOK_ID) api.refreshPanel(NOTEBOOK_ID);
  });
  api.on('scene', (mesh) => {
    if (api.location && api.location !== ctl.location) ctl.setLocation(api.location);
    if (ctl.setScene(mesh)) refresh();
  });
  api.on('frame', ({ camera, town } = {}) => {
    // The shell may apply its first scene before features subscribe; pick up whatever is on screen.
    if (town && town !== ctl.mesh && ctl.setScene(town, { adopt: false })) refresh();
    const moved = ctl.setCamera(camera ?? api.camera);
    // Other players move without us moving: redraw them about ten times a second while open.
    const t = Date.now();
    if (!moved && !(isOpen() && api.peers?.length && t - (ui.peerDraw ?? 0) > 100)) {
      if (ui.minimap && !ui.minimap.hidden && ui.minimapDrawn !== ctl.version) drawMinimap();
      return;
    }
    if (!moved) { ui.peerDraw = t; ctl.version++; }
    schedule();
    if (ui.minimap && !ui.minimap.hidden) drawMinimap();
    const now = Date.now();
    if (isOpen() && now - ui.lastStatus > 600) { ui.lastStatus = now; updateText(); }
  });
  api.on('state', () => { schedule(); syncMinimap(); });
  api.on('screen', () => syncMinimap());
  api.on('panel', ({ id, open } = {}) => {
    if (id === PANEL_ID && open && ctl.kind === 'town' && ctl.prefs.exteriorResetOnOpen) {
      ctl.resetExteriorView();
      afterChange();
    }
    syncMinimap();
  });
  // Building and dungeon entrances of the current town, published by the interiors feature.
  api.on('interiors:doors', ({ location, doors } = {}) => {
    ui.townDoors = { location, doors: Array.isArray(doors) ? doors : [] };
    ctl.version++;
    schedule();
  });

  if (typeof window !== 'undefined') {
    loadStyles();
    // The shell toggles feature panels from their registered key (N), so no key listener here.
    window.addEventListener('resize', () => { if (isOpen()) { sizeCanvas(); schedule(); } });
    queueMicrotask(syncMinimap);
  }

  api.registerPanel(PANEL_ID, 'Automap', render, { key: PANEL_KEY, watch: 'none' });
  api.registerPanel(NOTEBOOK_ID, 'Notebook', renderNotebook, { watch: 'none' });
  api.automap = {
    controller: ctl,
    setViewMode: (m) => { ctl.setViewMode(m); persistPrefs(); afterChange(); },
    setPrefs: (p) => { ctl.applyPrefs({ ...ctl.prefs, ...p }); persistPrefs(); if (isOpen()) build(); },
    getPrefs: () => ({ ...ctl.prefs }),
  };

  function refresh() {
    if (!isOpen()) return;
    build();
  }

  // ------------------------------------------------------------------------------------------- DOM

  function render(container) {
    if (!ui.root || !container.contains(ui.root)) {
      container.replaceChildren();
      ui.root = null;
    }
    if (!ui.root) {
      ui.root = el('section', { class: 'amap-root', 'aria-label': 'Automap', onkeydown: onKey });
      container.append(ui.root);
    }
    build();
  }

  function build() {
    const root = ui.root;
    if (!root) return;
    ctl.ensureMap();
    const map = ctl.map;
    const floors = ctl.floors;
    const help = 'amap-keys-help';

    ui.title = el('h2', { class: 'amap-title' }, placeName(ctl.location, ctl.mesh),
      el('span', { class: 'amap-kind' }, ` · ${KIND_WORD[ctl.kind] ?? 'Local map'}`));
    const btn = (label, title, fn, extra = {}) => el('button', {
      type: 'button', class: 'amap-btn', title, 'aria-label': title, onclick: () => { fn(); afterChange(); }, ...extra,
    }, label);

    ui.floorSel = null;
    let floorBox = null;
    if (ctl.floorSelector()) {
      ui.floorSel = el('select', {
        class: 'amap-floor', 'aria-label': 'Floor shown',
        onchange: (e) => { ctl.selectFloor(e.target.value === 'auto' ? null : Number(e.target.value)); afterChange(); },
      },
      el('option', { value: 'auto' }, 'Your floor'),
      floors.map((f, i) => el('option', { value: String(i) }, floorOptionText(i))).reverse());
      floorBox = el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Floor' },
        btn(el('span', { class: 'amap-level-down', 'aria-hidden': 'true' }), 'Floor down (Page Down)', () => ctl.stepFloor(-1)),
        ui.floorSel,
        btn(el('span', { class: 'amap-level-up', 'aria-hidden': 'true' }), 'Floor up (Page Up)', () => ctl.stepFloor(1)));
    }

    const is3d = ctl.viewMode === '3d';
    const tools = el('div', { class: 'amap-tools', role: 'toolbar', 'aria-label': 'Map controls' },
      el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Projection mode' },
        ui.modeBtn = btn(is3d ? '3D View' : '2D Plan', 'Switch between 2D plan and rotatable 3D perspective view (V)', () => {
          toggleViewMode();
        }, { class: 'amap-btn amap-wide amap-mode-btn', 'aria-pressed': String(is3d), 'data-view-mode': ctl.viewMode })),
      el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Zoom' },
        btn('−', 'Zoom out (−)', () => ctl.zoom(1 / 1.5)),
        btn('+', 'Zoom in (+)', () => ctl.zoom(1.5))),
      btn('⌖ Centre', 'Recentre on you and follow (C)', () => { ctl.recenter({ resetOrbit: is3d }); persistPrefs(); }, { class: 'amap-btn amap-wide' }),
      ctl.kind === 'town'
        ? btn('Reset ext.', 'Reset exterior zoom and centre to preferred default', () => ctl.resetExteriorView(), { class: 'amap-btn amap-wide' })
        : btn(ctl.fog ? 'Explored' : 'Whole place', ctl.fog ? 'Show everything you have explored (0)' : 'Show the whole place (0)', () => ctl.fitAll(), { class: 'amap-btn amap-wide', disabled: !map }),
      floorBox,
      map?.sliced ? el('div', { class: 'amap-group amap-slice-group', role: 'group', 'aria-label': 'Adjustable floor slice' },
        el('span', { class: 'amap-group-label', 'aria-hidden': 'true' }, 'Slice'),
        btn('−', 'Lower slice plane 0.5 m (Shift+PgDn)', () => { ctl.stepSliceOffset(-0.5); persistPrefs(); }),
        ui.sliceOut = el('span', { class: 'amap-slice-val', title: 'Height slice offset relative to viewed floor' }, `${ctl.sliceOffset >= 0 ? '+' : ''}${ctl.sliceOffset.toFixed(1)}m`),
        btn('+', 'Raise slice plane 0.5 m (Shift+PgUp)', () => { ctl.stepSliceOffset(0.5); persistPrefs(); })) : null,
      is3d
        ? el('div', { class: 'amap-group', role: 'group', 'aria-label': '3D orbit and tilt' },
          el('span', { class: 'amap-group-label', 'aria-hidden': 'true' }, 'Orbit'),
          btn('◄', 'Orbit left (Q)', () => { ctl.orbit(-Math.PI / 8, 0); persistPrefs(); }),
          btn('►', 'Orbit right (E)', () => { ctl.orbit(Math.PI / 8, 0); persistPrefs(); }),
          btn('▲', 'Tilt toward top-down (R)', () => { ctl.orbit(0, 0.14); persistPrefs(); }),
          btn('▼', 'Tilt toward the horizon (F)', () => { ctl.orbit(0, -0.14); persistPrefs(); }),
          btn('Reset', 'Reset 3D camera orbit and tilt', () => { ctl.resetOrbit(); persistPrefs(); }))
        : el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Orientation' },
          btn('⟲', 'Turn the map anticlockwise (Q)', () => ctl.rotate(-1)),
          ui.orient = btn(ctl.orientationText(), 'North up or heading up (H)', () => ctl.setOrientation(ctl.orientation === 'heading' ? 'north' : 'heading'), { class: 'amap-btn amap-orient', 'aria-pressed': String(ctl.orientation === 'heading') }),
          btn('⟳', 'Turn the map clockwise (E)', () => ctl.rotate(1))),
      map?.sliced ? ui.cut = btn('Cutaway', 'Cut away levels above your floor (X)', () => ctl.setCutaway(!ctl.cutaway), { class: 'amap-btn amap-wide', 'aria-pressed': String(ctl.cutaway) }) : (ui.cut = null),
      ui.mark = btn('✎ Note', 'Pin a note: click a spot on the map, or K for the centre', () => { ui.marking = !ui.marking; }, { class: 'amap-btn amap-wide', 'aria-pressed': String(!!ui.marking) }),
      ui.prefsBtn = btn('⚙ Prefs', 'Automap preferences (minimap, remembered slice, exterior zoom)', () => togglePrefs(), { class: 'amap-btn amap-wide', 'aria-pressed': String(ui.prefsOpen), 'aria-expanded': String(ui.prefsOpen), 'data-amap-prefs-btn': 'true' }));

    ui.prefsBox = el('section', {
      class: 'amap-prefs', 'aria-label': 'Automap preferences', hidden: !ui.prefsOpen,
      onkeydown: (e) => { if (e.code === 'Escape' && ui.prefsOpen) { e.preventDefault(); e.stopPropagation(); togglePrefs(false); } },
    });
    renderPrefs();

    ui.canvas = el('canvas', { class: 'amap-canvas', role: 'img', 'aria-label': 'Map' });
    const gl = is3d ? glCanvas() : null;
    const stage = el('div', {
      class: 'amap-stage', tabindex: '0', 'aria-describedby': help,
      'aria-label': is3d ? '3D Perspective Map view. Drag to orbit and tilt, Shift+drag or WASD to pan, scroll to zoom.' : 'Map view. Arrow keys pan, plus and minus zoom.',
    }, gl, ui.canvas,
      is3d ? null : el('div', { class: 'amap-north', 'aria-hidden': 'true' }, 'N', el('span', {}, '▲')),
      is3d ? el('div', { class: 'amap-3d-badge', 'aria-hidden': 'true' },
        ui.renderer ? 'Drag orbit · Right-drag pan · Wheel zoom' : 'Drag orbit · Right-drag pan · Wheel zoom · canvas renderer') : null);
    stage.dataset.renderer = is3d ? (ui.renderer ? 'webgl2' : 'canvas') : '2d';
    attachPointer(stage);
    // The preferences drawer floats over the map, so opening it never squeezes the viewport.
    const stageWrap = el('div', { class: 'amap-stage-wrap' }, stage, ui.prefsBox);

    ui.status = el('p', { class: 'amap-status', role: 'status', 'aria-live': 'polite' });
    const keys = el('p', { class: 'amap-keys', id: help },
      is3d
        ? `Q/E orbit · R/F tilt · WASD pan · + / − zoom · C centre · 0 fit${ctl.floorSelector() ? ' · PgUp/PgDn floor' : ''}${map?.sliced ? ' · Shift+PgUp/PgDn slice · X cutaway' : ''} · V 2D plan · K note · N or Esc close`
        : `Arrows/WASD pan · + / − zoom · C recentre · 0 whole place${ctl.floorSelector() ? ' · PgUp/PgDn floor' : ''} · Q/E turn · H heading up · V 3D view${map?.sliced ? ' · X cutaway' : ''} · K note · N or Esc close`);
    const scene3 = is3d ? ctl.scene3d() : null;
    const legend = el('ul', { class: 'amap-legend', 'aria-label': 'Legend' },
      el('li', {}, el('span', { class: 'amap-sw amap-sw-you', 'aria-hidden': 'true' }), 'You'),
      el('li', {}, el('span', { class: 'amap-sw amap-sw-peer', 'aria-hidden': 'true' }), 'Other players'),
      map?.markers.length || ui.townDoors?.doors?.length ? el('li', {}, el('span', { class: 'amap-sw amap-sw-door', 'aria-hidden': 'true' }), is3d && map?.sliced ? 'Exits' : 'Doors and exits') : null,
      is3d && ctl.mesh?.actionDoors?.length ? el('li', {}, el('span', { class: 'amap-sw amap-sw-portal', 'aria-hidden': 'true' }), 'Doors') : null,
      is3d && map?.sliced ? el('li', {}, el('span', { class: 'amap-sw amap-sw-ramp', 'aria-hidden': 'true' }), 'Stairs and ramps') : null,
      is3d && scene3?.water?.length ? el('li', {}, el('span', { class: 'amap-sw amap-sw-water', 'aria-hidden': 'true' }), 'Water') : null,
      map?.sliced ? el('li', {}, el('span', { class: 'amap-sw amap-sw-below', 'aria-hidden': 'true' }), 'Lower levels') : null,
      ctl.fog ? el('li', {}, el('span', { class: 'amap-sw amap-sw-fog', 'aria-hidden': 'true' }), 'Unexplored') : null,
      el('li', {}, el('span', { class: 'amap-sw amap-sw-note', 'aria-hidden': 'true' }), 'Your notes'));

    ui.notes = el('section', { class: 'amap-notes', 'aria-label': 'Your notes on this map' });
    ui.floorCount = floors.length;
    ui.stage = stage;
    ui.root.replaceChildren(el('header', { class: 'amap-head' }, ui.title, ui.status), tools, stageWrap, ui.notes, el('div', { class: 'amap-foot' }, legend, keys));
    renderNotes();
    // Inspection hooks for tests and capture harnesses.
    ui.root.dataset.kind = ctl.kind;
    ui.root.dataset.location = ctl.location ?? '';
    ui.root.dataset.viewMode = ctl.viewMode;
    ui.root.dataset.orbitYaw = ctl.orbitYaw.toFixed(3);
    ui.root.dataset.orbitPitch = ctl.orbitPitch.toFixed(3);
    ui.root.dataset.sliceOffset = ctl.sliceOffset.toFixed(1);
    ui.root.dataset.triangles = String(map?.triangles ?? 0);
    ui.root.dataset.floors = String(floors.length);
    ui.root.dataset.fog = ctl.fog ? '1' : '0';
    ui.root.dataset.explored = String(ctl.cells().size);
    // Indoors only the explored extent is exposed, like the drawing.
    const shownBounds = map && (ctl.fog ? cellsBounds(ctl.cells()) : map.bounds);
    if (shownBounds) ui.root.dataset.bounds = ['minX', 'maxX', 'minZ', 'maxZ'].map((k) => Math.round(shownBounds[k])).join(',');
    else delete ui.root.dataset.bounds;
    ui.drawn = -1;
    ui.resize?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      ui.resize = new ResizeObserver(() => { if (sizeCanvas()) { ui.drawn = -1; schedule(); } });
      ui.resize.observe(stage);
    }
    sizeCanvas();
    // 3D opens framed on what there is to see (the explored area, or the player in a place too big to fit).
    ctl.frame3d();
    afterChange();
    queueMicrotask(() => { if (isOpen() && !ui.root.contains(document.activeElement)) stage.focus({ preventScroll: true }); });
  }

  function floorOptionText(i) {
    const name = floorLabel(ctl.floors, i, ctl.groundY(), { explored: ctl.fog }).replace(/\s*\(.*\)$/, '') || `Floor ${i + 1}`;
    return `${name}${i === ctl.playerFloor() ? ' (you)' : ''}`;
  }

  function toggleViewMode() {
    ctl.setViewMode(ctl.viewMode === '3d' ? '2d' : '3d');
    if (ctl.viewMode === '3d') ctl.framing = 'auto';
    persistPrefs();
    build();
  }

  function togglePrefs(open = !ui.prefsOpen) {
    ui.prefsOpen = !!open;
    if (ui.prefsBtn) {
      ui.prefsBtn.setAttribute('aria-pressed', String(ui.prefsOpen));
      ui.prefsBtn.setAttribute('aria-expanded', String(ui.prefsOpen));
    }
    renderPrefs();
    if (ui.prefsOpen) queueMicrotask(() => ui.prefsBox?.querySelector('input, select, button')?.focus({ preventScroll: true }));
    else ui.prefsBtn?.focus({ preventScroll: true });
  }

  /** The persistent WebGL canvas of the 3D view (one context for the panel's lifetime), or null without WebGL2. */
  function glCanvas() {
    if (ui.renderer === undefined) {
      const cv = el('canvas', { class: 'amap-gl', 'aria-hidden': 'true' });
      ui.renderer = create3DRenderer(cv);
      ui.gl = ui.renderer ? cv : null;
    }
    return ui.gl;
  }

  function afterChange() {
    if (ui.floorSel) ui.floorSel.value = ctl.floor === null ? 'auto' : String(ctl.floor);
    if (ui.orient) { ui.orient.textContent = ctl.orientationText(); ui.orient.setAttribute('aria-pressed', String(ctl.orientation === 'heading')); }
    if (ui.cut) ui.cut.setAttribute('aria-pressed', String(ctl.cutaway));
    if (ui.mark) ui.mark.setAttribute('aria-pressed', String(!!ui.marking));
    if (ui.sliceOut) ui.sliceOut.textContent = `${ctl.sliceOffset >= 0 ? '+' : ''}${ctl.sliceOffset.toFixed(1)}m`;
    if (ui.root) {
      ui.root.dataset.orientation = ctl.orientation === 'heading' ? 'heading' : `north:${Math.round((ctl.turn * 2) / Math.PI)}`;
      ui.root.dataset.cutaway = ctl.cutaway ? '1' : '0';
      ui.root.dataset.viewMode = ctl.viewMode;
      ui.root.dataset.orbitYaw = ctl.orbitYaw.toFixed(3);
      ui.root.dataset.orbitPitch = ctl.orbitPitch.toFixed(3);
      ui.root.dataset.sliceOffset = ctl.sliceOffset.toFixed(1);
    }
    updateText();
    schedule();
  }

  function renderPrefs() {
    const box = ui.prefsBox;
    if (!box) return;
    box.hidden = !ui.prefsOpen;
    if (!ui.prefsOpen) return;
    const p = ctl.prefs;
    const check = (label, checked, onChange) => el('label', { class: 'amap-pref-check' },
      el('input', { type: 'checkbox', checked, onchange: (e) => { onChange(e.target.checked); persistPrefs(); afterChange(); } }),
      label);
    const words = (v) => String(v).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const cornerSel = el('select', {
      class: 'amap-floor amap-pref-select', 'aria-label': 'Minimap corner',
      onchange: (e) => { ctl.prefs = { ...ctl.prefs, minimapCorner: e.target.value }; persistPrefs(); },
    }, MINIMAP_CORNERS.map((c) => el('option', { value: c, selected: p.minimapCorner === c }, words(c))));
    const sizeSel = el('select', {
      class: 'amap-floor amap-pref-select', 'aria-label': 'Minimap size',
      onchange: (e) => { ctl.prefs = { ...ctl.prefs, minimapSize: e.target.value }; persistPrefs(); },
    }, MINIMAP_SIZES.map((s) => el('option', { value: s, selected: p.minimapSize === s }, words(s))));
    const extZoomOut = el('output', { class: 'amap-pref-val' }, `${p.exteriorDefaultZoom.toFixed(1)}×`);
    const extZoom = el('input', {
      type: 'range', min: String(MIN_EXTERIOR_ZOOM), max: String(MAX_EXTERIOR_ZOOM), step: '0.5',
      value: String(p.exteriorDefaultZoom), 'aria-label': 'Exterior default zoom',
      oninput: (e) => {
        const val = Number(e.target.value);
        extZoomOut.textContent = `${val.toFixed(1)}×`;
        ctl.prefs = { ...ctl.prefs, exteriorDefaultZoom: val };
      },
      onchange: () => { persistPrefs(); if (ctl.kind === 'town') ctl.resetExteriorView(); afterChange(); },
    });
    const sliceSliderOut = el('output', { class: 'amap-pref-val' }, `${ctl.sliceOffset >= 0 ? '+' : ''}${ctl.sliceOffset.toFixed(1)}m`);
    const sliceSlider = el('input', {
      type: 'range', min: String(MIN_SLICE_OFFSET), max: String(MAX_SLICE_OFFSET), step: '0.5',
      value: String(ctl.sliceOffset), 'aria-label': 'Floor slice offset (metres)',
      oninput: (e) => {
        const val = Number(e.target.value);
        sliceSliderOut.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)}m`;
        ctl.setSliceOffset(val);
        afterChange();
      },
      onchange: () => persistPrefs(),
    });
    const row = (label, ...controls) => el('label', { class: 'amap-pref-row' }, el('span', { class: 'amap-pref-name' }, label), el('span', { class: 'amap-pref-ctl' }, controls));
    box.replaceChildren(
      el('div', { class: 'amap-prefs-head' },
        el('h3', { class: 'amap-prefs-title' }, 'Automap preferences'),
        el('button', { type: 'button', class: 'amap-btn amap-x', title: 'Close preferences (Esc)', 'aria-label': 'Close preferences', onclick: () => togglePrefs(false) }, '×')),
      el('div', { class: 'amap-prefs-grid' },
        check('Dungeon / interior HUD minimap', p.minimapEnabled, (v) => { ctl.prefs = { ...ctl.prefs, minimapEnabled: v }; }),
        row('Minimap corner', cornerSel),
        row('Minimap size', sizeSel),
        check('Remember floor slice per place', p.rememberSlice, (v) => { ctl.prefs = { ...ctl.prefs, rememberSlice: v }; }),
        check('Reset exterior zoom & centre on open', p.exteriorResetOnOpen, (v) => { ctl.prefs = { ...ctl.prefs, exteriorResetOnOpen: v }; }),
        row('Exterior zoom', extZoom, extZoomOut),
        row('Slice height', sliceSlider, sliceSliderOut),
        el('div', { class: 'amap-pref-actions' },
          el('button', { type: 'button', class: 'amap-btn', onclick: () => { ctl.resetExteriorView(); afterChange(); } }, 'Reset exterior zoom'),
          el('button', { type: 'button', class: 'amap-btn', onclick: () => { ctl.applyPrefs(resetAutomapPrefs(storage)); ctl.setSliceOffset(0); syncMinimap(); build(); } }, 'Reset automap prefs'))));
  }

  function updateText() {
    if (!ui.status) return;
    // The player's own storey can change (stairs) or become known after the panel was built.
    if (ui.floorSel) {
      for (const o of ui.floorSel.options) {
        if (o.value === 'auto') continue;
        const t = floorOptionText(Number(o.value));
        if (o.textContent !== t) o.textContent = t;
      }
      const v = ctl.floor === null ? 'auto' : String(ctl.floor);
      if (ui.floorSel.value !== v) ui.floorSel.value = v;
    }
    if (ui.root) ui.root.dataset.explored = String(ctl.cells().size);
    const north = ui.root?.querySelector('.amap-north');
    if (north) north.style.transform = `rotate(${ctl.viewMode === '3d' ? -ctl.orbitYaw : -ctl.view.rotation}rad)`;
    const modeNote = ctl.viewMode === '3d' ? ` [3D · yaw ${Math.round((ctl.orbitYaw * 180) / Math.PI)}° · tilt ${Math.round((ctl.orbitPitch * 180) / Math.PI)}°]` : '';
    const sliceNote = ctl.sliceOffset ? ` (slice ${ctl.sliceOffset > 0 ? '+' : ''}${ctl.sliceOffset.toFixed(1)}m)` : '';
    const text = ctl.describe() + sliceNote + modeNote;
    if (ui.status.textContent !== text) { ui.status.textContent = text; ui.status.title = text; }
    if (ui.canvas) ui.canvas.setAttribute('aria-label', `Map of ${placeName(ctl.location, ctl.mesh)}. ${text}`);
  }

  /** Fit the canvas to the stage's width; returns true when the size changed. */
  function sizeCanvas() {
    const cv = ui.canvas;
    const stage = cv?.parentElement;
    if (!cv || !stage) return false;
    const w = Math.max(240, Math.floor(stage.clientWidth || 640));
    const h = stageHeight(stage, w);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const gl = ui.gl?.parentElement === stage ? ui.gl : null;
    const glOk = !gl || (gl.width === Math.round(w * dpr) && gl.height === Math.round(h * dpr));
    if (w === ctl.view.width && h === ctl.view.height && cv.width && glOk) return false;
    for (const c of [cv, gl]) {
      if (!c) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    ctl.resize(w, h);
    return true;
  }

  /**
   * Map height: everything the page has left under the toolbar, so the map dominates the panel. The space is
   * measured from the scrolling page (#menu-panel) down to its bottom edge, less the legend and notes below the map.
   */
  function stageHeight(stage, w) {
    const legacy = Math.max(220, Math.round(Math.min(window.innerHeight * 0.46, w * 0.62)));
    const root = ui.root;
    const page = root?.closest?.('#menu-panel') ?? null;
    const sr = stage.getBoundingClientRect();
    const rr = root?.getBoundingClientRect();
    if (!rr || !(sr.width > 0)) return legacy;
    const wrap = stage.parentElement?.getBoundingClientRect() ?? sr;
    const under = Math.max(0, rr.bottom - wrap.bottom); // notes, legend and key help
    let bottom = window.innerHeight - 12;
    if (page) {
      const pr = page.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(page).paddingBottom) || 0;
      if (pr.height > 0) bottom = Math.min(bottom, pr.bottom - pad);
    }
    const top = sr.top + (page?.scrollTop ?? 0);
    const room = Math.floor(bottom - top - under - 2);
    return Math.max(Math.min(legacy, 260), Math.min(room, Math.round(w * 1.1)));
  }

  function onKey(e) {
    if (e.target?.tagName === 'SELECT' && /^Arrow/.test(e.code)) return;
    const big = e.shiftKey ? 4 : 1;
    let handled = true;
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': ctl.pan(PAN_STEP * big, 0); break;
      case 'ArrowRight': case 'KeyD': ctl.pan(-PAN_STEP * big, 0); break;
      case 'ArrowUp': case 'KeyW': ctl.pan(0, PAN_STEP * big); break;
      case 'ArrowDown': case 'KeyS': ctl.pan(0, -PAN_STEP * big); break;
      case 'Equal': case 'NumpadAdd': ctl.zoom(1.5); break;
      case 'Minus': case 'NumpadSubtract': ctl.zoom(1 / 1.5); break;
      case 'KeyC': case 'Home': ctl.recenter({ resetOrbit: ctl.viewMode === '3d' }); persistPrefs(); break;
      case 'Digit0': case 'Numpad0': ctl.fitAll(); break;
      case 'PageUp': case 'BracketRight':
        if (e.shiftKey && ctl.map?.sliced) { handled = ctl.stepSliceOffset(0.5); persistPrefs(); }
        else { handled = ctl.stepFloor(1); persistPrefs(); }
        break;
      case 'PageDown': case 'BracketLeft':
        if (e.shiftKey && ctl.map?.sliced) { handled = ctl.stepSliceOffset(-0.5); persistPrefs(); }
        else { handled = ctl.stepFloor(-1); persistPrefs(); }
        break;
      case 'KeyQ':
        if (ctl.viewMode === '3d') { ctl.orbit(-Math.PI / 12, 0); persistPrefs(); }
        else ctl.rotate(-1);
        break;
      case 'KeyE':
        if (ctl.viewMode === '3d') { ctl.orbit(Math.PI / 12, 0); persistPrefs(); }
        else ctl.rotate(1);
        break;
      case 'KeyR':
        if (ctl.viewMode === '3d') { ctl.orbit(0, 0.12); persistPrefs(); }
        else handled = false;
        break;
      case 'KeyF':
        if (ctl.viewMode === '3d') { ctl.orbit(0, -0.12); persistPrefs(); }
        else handled = false;
        break;
      case 'KeyV': case 'Digit3':
        toggleViewMode();
        break;
      case 'KeyH': ctl.setOrientation(ctl.orientation === 'heading' ? 'north' : 'heading'); break;
      case 'KeyX': if (ctl.map?.sliced) ctl.setCutaway(!ctl.cutaway); else handled = false; break;
      case 'KeyK': startNote(ctl.view.centerX, ctl.view.centerZ); break;
      default: handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    afterChange();
  }

  function attachPointer(stage) {
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      if (ui.marking && e.button === 0) {
        const r = ui.canvas.getBoundingClientRect();
        const [x, z] = screenToWorldAt(e.clientX - r.left, e.clientY - r.top);
        ui.marking = false;
        startNote(x, z);
        afterChange();
        return;
      }
      const mode = ctl.viewMode === '3d' && !(e.shiftKey || e.button === 2) ? 'orbit' : 'pan';
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, mode };
      stage.setPointerCapture?.(e.pointerId);
      stage.focus({ preventScroll: true });
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!dx && !dy) return;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'orbit') {
        ctl.orbit(dx * 0.0085, dy * 0.0075);
      } else {
        ctl.pan(dx, dy);
      }
      afterChange();
    });
    const end = (e) => {
      if (drag && e.pointerId === drag.id) {
        if (drag.mode === 'orbit') persistPrefs();
        drag = null;
      }
    };
    stage.addEventListener('contextmenu', (e) => { if (ctl.viewMode === '3d') e.preventDefault(); });
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', (e) => {
      const r = ui.canvas.getBoundingClientRect();
      const [x, z] = screenToWorldAt(e.clientX - r.left, e.clientY - r.top);
      startNote(x, z);
    });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = ui.canvas.getBoundingClientRect();
      ctl.zoom(e.deltaY < 0 ? 1.25 : 1 / 1.25, e.clientX - r.left, e.clientY - r.top);
      afterChange();
    }, { passive: false });
  }

  // ------------------------------------------------------------------------------------------- notes

  const record = () => api.character?.automap ?? {};
  const notesHere = () => (Array.isArray(record().notes?.[ctl.location]) ? record().notes[ctl.location] : []);
  /** World [x, z] under a canvas pixel: on the plan in 2D, on the viewed floor's plane in 3D. */
  const screenToWorldAt = (sx, sy) => {
    if (ctl.viewMode !== '3d') return screenToWorld(ctl.view, sx, sy);
    const v3 = ctl.view3d();
    return unproject3D(v3, sx, sy, v3.centerY) ?? [NaN, NaN];
  };

  /** Town building names this character knows: {portalId: label} from entering and from directions. */
  function learnedNames(location) {
    const out = { ...(record().names?.[location] ?? {}) };
    const lp = api.character?.learnedPlaces?.[location];
    if (Array.isArray(lp)) for (const e of lp) if (e?.id && e?.name) out[e.id] ??= String(e.name);
    return out;
  }

  function startNote(x, z) {
    if (!ui.notes || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (!ctl.seen(x, z)) { api.message('You can only mark places you have explored.', { kind: 'error' }); return; }
    ui.pending = { x, z };
    ctl.version++;
    schedule();
    renderNotes();
    queueMicrotask(() => ui.notes?.querySelector('input')?.focus());
  }

  function renderNotes() {
    const box = ui.notes;
    if (!box) return;
    const list = notesHere();
    const kids = [];
    if (ui.pending) {
      const input = el('input', { type: 'text', class: 'amap-note-input', maxlength: String(MAX_NOTE_TEXT), 'aria-label': 'Note text', placeholder: 'What is here?' });
      const save = () => {
        const text = input.value.trim();
        const at = ui.pending;
        if (!text || !at) return;
        ui.pending = null;
        api.act('automap.note', { x: Math.round(at.x * 100) / 100, z: Math.round(at.z * 100) / 100, text });
        renderNotes();
        ctl.version++;
        schedule();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ui.pending = null; renderNotes(); ctl.version++; schedule(); }
        else e.stopPropagation(); // typing never pans the map or opens panels
      });
      kids.push(el('form', { class: 'amap-note-form', onsubmit: (e) => { e.preventDefault(); save(); } },
        el('label', {}, 'Note here: ', input),
        el('button', { type: 'submit', class: 'amap-btn' }, 'Pin'),
        el('button', { type: 'button', class: 'amap-btn', onclick: () => { ui.pending = null; renderNotes(); ctl.version++; schedule(); } }, 'Cancel')));
    }
    if (list.length) {
      kids.push(el('ul', { class: 'amap-note-list' }, list.map((n) => el('li', { 'data-note': n.id },
        el('button', { type: 'button', class: 'amap-link', title: 'Show on the map', onclick: () => {
          ctl.follow = false;
          ctl.view = { ...ctl.view, centerX: n.x, centerZ: n.z };
          ctl.version++;
          afterChange();
        } }, n.text),
        el('button', { type: 'button', class: 'amap-btn amap-x', title: 'Remove this note', 'aria-label': `Remove note ${n.text}`, onclick: () => api.act('automap.unnote', { id: n.id }) }, '×')))));
    }
    box.replaceChildren(...kids);
    box.hidden = !kids.length;
  }

  // ------------------------------------------------------------------------------------------- notebook

  function renderNotebook(container) {
    const entries = Array.isArray(record().notebook) ? record().notebook : [];
    const input = el('textarea', { class: 'nb-input', rows: '3', maxlength: String(MAX_NOTEBOOK_TEXT), 'aria-label': 'New notebook entry', placeholder: 'Write in your notebook…' });
    input.addEventListener('keydown', (e) => e.stopPropagation());
    const form = el('form', { class: 'nb-form', onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      const r = await api.act('notebook.write', { text });
      if (r && r.ok !== false) input.value = '';
    } }, input, el('button', { type: 'submit', class: 'amap-btn' }, 'Write'));
    const list = el('ol', { class: 'nb-list', reversed: true }, [...entries].reverse().map((n) => el('li', { 'data-entry': n.id },
      el('p', { class: 'nb-text' }, n.text),
      el('p', { class: 'nb-meta' }, n.source && n.source !== 'player' ? `${n.source} · ` : '', Number.isFinite(n.at) ? new Date(n.at).toLocaleString() : '',
        el('button', { type: 'button', class: 'amap-btn amap-x', 'aria-label': 'Erase this entry', title: 'Erase', onclick: () => api.act('notebook.erase', { id: n.id }) }, '×')))));
    container.replaceChildren(el('section', { class: 'amap-root nb-root', 'aria-label': 'Notebook' },
      el('h2', { class: 'amap-title' }, 'Notebook'),
      form,
      entries.length ? list : el('p', { class: 'amap-status' }, 'Your notebook is empty.')));
    loadStyles();
  }

  // ------------------------------------------------------------------------------------------- drawing

  function pathOf(piece) {
    let p = paths.get(piece);
    if (p) return p;
    p = new Path2D();
    const d = piece.data;
    if (piece.kind === 'fill') {
      for (let i = 0; i < d.length; i += 6) {
        p.moveTo(d[i], d[i + 1]); p.lineTo(d[i + 2], d[i + 3]); p.lineTo(d[i + 4], d[i + 5]); p.closePath();
      }
    } else {
      for (let i = 0; i < d.length; i += 4) { p.moveTo(d[i], d[i + 1]); p.lineTo(d[i + 2], d[i + 3]); }
    }
    paths.set(piece, p);
    return p;
  }

  function draw() {
    const cv = ui.canvas;
    if (!cv || !isOpen()) return;
    if (ui.drawn === ctl.version && cv.dataset.drawn) return;
    ui.drawn = ctl.version;
    cv.dataset.drawn = '1';
    const ctx = cv.getContext('2d');
    const dpr = cv.width / ctl.view.width;
    const v = ctl.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const map = ctl.map;
    if (map && ctl.viewMode === '3d') {
      draw3D(ctx, map, dpr);
      return;
    }
    ctx.fillStyle = '#0b1016';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!map) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#8fa3b8';
      ctx.font = '15px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText(ctl.error ? 'This place could not be mapped.' : 'Waiting for this place to load…', v.width / 2, v.height / 2);
      return;
    }
    const [ta, tb, tc, td, te, tf] = viewTransform(v);
    ctx.setTransform(ta * dpr, tb * dpr, tc * dpr, td * dpr, te * dpr, tf * dpr);
    const shown = ctl.pieces();
    if (ctl.fog) {
      // Only explored ground is drawn; the rest of the place stays unknown.
      const fog = fogPath();
      ctx.fillStyle = 'rgba(52,70,90,0.55)';
      ctx.fill(fog);
      ctx.save();
      ctx.clip(fog);
    }
    // Fills low to high (painter order), lower levels faded; then every wall line on top so rooms stay legible.
    for (const { piece, mode } of shown) {
      if (piece.kind !== 'fill') continue;
      ctx.globalAlpha = mode === 'below' ? 0.28 : 1;
      ctx.fillStyle = `rgb(${piece.colour[0]},${piece.colour[1]},${piece.colour[2]})`;
      ctx.fill(pathOf(piece));
    }
    ctx.lineCap = 'round';
    for (const pass of ['below', 'current']) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pass === 'below' ? 'rgba(120,145,170,0.35)' : 'rgba(225,236,247,0.92)';
      ctx.lineWidth = (pass === 'below' ? 1 : map.sliced ? 2 : 1.4) / v.scale;
      for (const { piece, mode } of shown) if (piece.kind === 'wall' && mode === pass) ctx.stroke(pathOf(piece));
    }
    ctx.globalAlpha = 1;
    if (ctl.fog) ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawMarkers(ctx, map);
    drawScale(ctx, v);
  }

  function fogPath() {
    const sl = ctl.slice();
    const key = `${ctl.exploredVersion}|${ctl.location}|${sl.top}|${sl.bottom}`;
    if (ui.fog?.key === key) return ui.fog.path;
    const path = new Path2D();
    const seen = new Set();
    for (const [ix, iz] of ctl.fogCells()) {
      const k = `${ix},${iz}`;
      if (seen.has(k)) continue;
      seen.add(k);
      path.rect(ix * CELL, iz * CELL, CELL, CELL);
    }
    ui.fog = { key, path };
    return path;
  }

  function glyph(ctx, x, y, kind) {
    ctx.strokeStyle = '#06090d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (kind === 'note') {
      ctx.fillStyle = '#f2f6fa';
      ctx.moveTo(x, y); ctx.lineTo(x - 5, y - 9); ctx.lineTo(x + 5, y - 9); ctx.closePath();
    } else if (kind === 'enemy') {
      ctx.fillStyle = '#e06c6c';
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    } else if (kind === 'treasure' || kind === 'item') {
      ctx.fillStyle = '#e8d27a';
      ctx.rect(x - 4, y - 4, 8, 8);
    } else {
      ctx.fillStyle = '#b9a6f0';
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath();
    }
    ctx.fill(); ctx.stroke();
  }

  const onScreen = (v, x, y) => !(x < -10 || y < -10 || x > v.width + 10 || y > v.height + 10);
  const inSlab = (map, slice, y) => !map.sliced || !Number.isFinite(y) || (y <= slice.top && y >= slice.below - 2);

  function label(ctx, text, x, y) {
    ctx.font = '11px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#06090d';
    ctx.strokeText(text, x + 7, y + 4);
    ctx.fillStyle = '#dbe6f0';
    ctx.fillText(text, x + 7, y + 4);
  }

  function drawMarkers(ctx, map) {
    const v = ctl.view;
    const slice = ctl.slice();
    // Player notes, then markers from other features (magic detection, quests).
    for (const n of notesHere()) {
      if (!Number.isFinite(n?.x) || !Number.isFinite(n?.z) || !inSlab(map, slice, n.y)) continue;
      const [x, y] = worldToScreen(v, n.x, n.z);
      if (!onScreen(v, x, y)) continue;
      glyph(ctx, x, y, 'note');
      if (v.scale >= 3) label(ctx, String(n.text).slice(0, 40), x, y - 6);
    }
    if (ui.pending) {
      const [x, y] = worldToScreen(v, ui.pending.x, ui.pending.z);
      ctx.strokeStyle = '#6fd0ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
    }
    for (const [source, set] of external) {
      if (set.location !== ctl.location) continue;
      for (const m of set.markers) {
        if (!Number.isFinite(m?.x) || !Number.isFinite(m?.z) || !inSlab(map, slice, m.y)) continue;
        if (source !== 'magic' && !ctl.seen(m.x, m.z, m.y)) continue;
        const [x, y] = worldToScreen(v, m.x, m.z);
        if (!onScreen(v, x, y)) continue;
        glyph(ctx, x, y, m.kind);
        if (m.label && v.scale >= 6) label(ctx, String(m.label).slice(0, 40), x, y);
      }
    }
    for (const m of map.markers) {
      if (map.sliced && (m.y > slice.top || m.y < slice.below - 2)) continue;
      if (!ctl.seen(m.x, m.z, m.y)) continue;
      const [x, y] = worldToScreen(v, m.x, m.z);
      if (x < -10 || y < -10 || x > v.width + 10 || y > v.height + 10) continue;
      ctx.fillStyle = m.type === 3 ? '#7fe0c4' : '#9cc3e6';
      ctx.strokeStyle = '#06090d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }
    // Town entrances (one marker per building, at its first door), labelled when zoomed in.
    const td = ui.townDoors;
    if (td && td.location === ctl.location && !map.sliced) {
      const seen = new Set();
      const names = learnedNames(ctl.location);
      ctx.font = '11px Georgia, serif';
      for (const d of td.doors) {
        if (!Number.isFinite(d?.x) || !Number.isFinite(d?.z) || seen.has(d.portalId)) continue;
        seen.add(d.portalId);
        const [x, y] = worldToScreen(v, d.x, d.z);
        if (x < -10 || y < -10 || x > v.width + 10 || y > v.height + 10) continue;
        ctx.fillStyle = d.kind === 'dungeon' ? '#7fe0c4' : '#9cc3e6';
        ctx.strokeStyle = '#06090d';
        ctx.lineWidth = 1.5;
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
        // Classic: a building's name is on your map once you have learned it (directions, or by going in).
        const known = names[d.portalId] ?? (d.kind === 'dungeon' ? d.label : null);
        if (known && v.scale >= 1.5) label(ctx, String(known), x - 1, y);
      }
    }
    // Other players in this place (state.peers is already limited to our location).
    ctx.font = '12px Georgia, serif';
    ctx.textAlign = 'left';
    // Prefer the shell's per-frame interpolated peers; fall back to the last RPG snapshot.
    for (const p of (Array.isArray(api.peers) ? api.peers : api.state?.peers) ?? []) {
      if (String(p?.id) === String(api.selfId) || !Number.isFinite(p?.x) || !Number.isFinite(p?.z)) continue;
      const [x, y] = worldToScreen(v, p.x, p.z);
      ctx.fillStyle = '#c4d2e0';
      ctx.strokeStyle = '#06090d';
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (p.name) {
        ctx.lineWidth = 3; ctx.strokeText(String(p.name), x + 7, y + 4);
        ctx.fillText(String(p.name), x + 7, y + 4); ctx.lineWidth = 1.5;
      }
    }
    const me = ctl.playerMarker();
    if (!me) return;
    const { x, y, dx, dy } = me;
    // View cone, then the arrow.
    const cone = 0.55, r = 46;
    const a = Math.atan2(dy, dx);
    ctx.fillStyle = 'rgba(120,200,255,0.16)';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, r, a - cone, a + cone); ctx.closePath(); ctx.fill();
    const px = -dy, py = dx;
    ctx.beginPath();
    ctx.moveTo(x + dx * 11, y + dy * 11);
    ctx.lineTo(x - dx * 7 + px * 7, y - dy * 7 + py * 7);
    ctx.lineTo(x - dx * 3, y - dy * 3);
    ctx.lineTo(x - dx * 7 - px * 7, y - dy * 7 - py * 7);
    ctx.closePath();
    ctx.fillStyle = '#6fd0ff';
    ctx.strokeStyle = '#04121c';
    ctx.lineWidth = 2;
    ctx.fill(); ctx.stroke();
  }

  function drawScale(ctx, v) {
    const target = 110 / v.scale;
    const pow = 10 ** Math.floor(Math.log10(target));
    const len = [5, 2, 1].map((k) => k * pow).find((m) => m <= target) ?? pow;
    const px = len * v.scale;
    const x0 = 14, y0 = v.height - 16;
    ctx.strokeStyle = '#dbe6f0';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 4); ctx.stroke();
    ctx.fillStyle = '#dbe6f0';
    ctx.font = '12px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${len} m`, x0 + px + 6, y0 + 4);
  }

  // ------------------------------------------------------------------------------------------- 3D view

  const css = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const YOU_3D = '#ff8a4c'; // the player's beacon: the one warm, saturated colour on the stone-and-verdigris map

  /**
   * The 3D view: WebGL paints the depth-buffered architecture on its own canvas underneath; this overlay canvas
   * carries the vignette, markers, compass and scale. Without WebGL2 the overlay paints the opaque fallback itself.
   */
  function draw3D(ctx, map, dpr) {
    const cv = ui.canvas;
    const v3 = ctl.view3d();
    const slice = ctl.slice();
    const scene = ctl.scene3d();
    const mask = ctl.mask3d();
    const floorY = v3.centerY;
    const gridStep = ctl.kind === 'town' ? 12.8 : ctl.kind === 'interior' ? 3.2 : 6.4;
    const maskKey = mask ? `${ctl.location}|${ctl.exploredVersion}` : `${ctl.location}|all`;
    if (!ui.water || ui.water.scene !== scene || ui.water.key !== maskKey) {
      ui.water = { scene, key: maskKey, tris: scene ? waterSurface3D(scene, mask) : null };
    }
    ctx.clearRect(0, 0, cv.width, cv.height);
    const gl = ui.renderer && ui.gl?.parentElement === ui.stage
      && ui.renderer.draw({ scene, mask, maskKey, view: v3, slice, floorY, gridStep, dpr, water: ui.water.tris, ghost: ctl.cutaway });
    if (ui.gl) ui.gl.style.visibility = gl ? 'visible' : 'hidden';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!gl) paint3DFallback(ctx, map, v3, slice, mask, floorY, gridStep);

    // Vignette: the corners fall away into the dark so the eye stays on the plan.
    const vg = ctx.createRadialGradient(v3.width / 2, v3.height / 2, Math.min(v3.width, v3.height) * 0.42, v3.width / 2, v3.height / 2, Math.hypot(v3.width, v3.height) * 0.62);
    vg.addColorStop(0, css(PALETTE.backgroundEdge, 0));
    vg.addColorStop(1, css(PALETTE.backgroundEdge, 0.78));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, v3.width, v3.height);

    drawMarkers3D(ctx, map, v3, slice);
    drawCompass3D(ctx, v3);
    const centre = project3D(v3, v3.centerX, v3.centerY, v3.centerZ);
    if (centre.visible) drawScale(ctx, { scale: centre.factor, height: v3.height });
  }

  /** Canvas fallback: opaque, back-face culled, depth-sorted faces with structural edges (no WebGL2). */
  function paint3DFallback(ctx, map, v3, slice, mask, floorY, gridStep) {
    ctx.fillStyle = css(PALETTE.background);
    ctx.fillRect(0, 0, v3.width, v3.height);
    // Reference grid on the viewed floor's plane.
    const n = 10;
    const gx0 = Math.round(v3.centerX / gridStep) * gridStep, gz0 = Math.round(v3.centerZ / gridStep) * gridStep;
    ctx.lineWidth = 1;
    for (let i = -n; i <= n; i++) {
      const major = Math.round((i * gridStep + gx0) / gridStep) % 4 === 0;
      const a = project3D(v3, gx0 + i * gridStep, floorY, gz0 - n * gridStep), b = project3D(v3, gx0 + i * gridStep, floorY, gz0 + n * gridStep);
      ctx.strokeStyle = css(PALETTE.grid, major ? 0.22 : 0.1);
      if (a.visible && b.visible) { ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke(); }
      const majorZ = Math.round((i * gridStep + gz0) / gridStep) % 4 === 0;
      const c = project3D(v3, gx0 - n * gridStep, floorY, gz0 + i * gridStep), d = project3D(v3, gx0 + n * gridStep, floorY, gz0 + i * gridStep);
      ctx.strokeStyle = css(PALETTE.grid, majorZ ? 0.22 : 0.1);
      if (c.visible && d.visible) { ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke(); }
    }
    const { polys } = build3DDrawList(map, slice, v3, { mask, mesh: ctl.mesh, floorY });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const poly of polys) {
      const pts = poly.pts;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (poly.kind === 'edge') {
        ctx.strokeStyle = css(poly.colour, poly.alpha);
        ctx.lineWidth = 1.1;
        ctx.stroke();
      } else {
        ctx.closePath();
        // A hairline in the face's own colour closes the antialiasing gap between neighbouring triangles.
        ctx.fillStyle = ctx.strokeStyle = css(poly.colour);
        ctx.lineWidth = 0.8;
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /** Ground-plane ring / shape around (x, y, z): points in metres mapped through the perspective camera. */
  function groundPath(ctx, v3, x, y, z, pts) {
    let started = false;
    ctx.beginPath();
    for (const [dx, dz] of pts) {
      const p = project3D(v3, x + dx, y, z + dz);
      if (!p.visible) return false;
      if (started) ctx.lineTo(p.sx, p.sy); else { ctx.moveTo(p.sx, p.sy); started = true; }
    }
    ctx.closePath();
    return started;
  }
  const circle = (r, n = 32) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * 2 * Math.PI) * r, Math.sin((i / n) * 2 * Math.PI) * r]);

  /**
   * A screen-space pin standing on world point (x, y, z): a foot dot on the ground, a stem and a crisp head glyph,
   * always the same size on screen so it stays legible at any zoom. Returns the head position, or null off screen.
   */
  function pin(ctx, v3, x, y, z, { colour, shape = 'diamond', text = null, size = 6.5, stem = 22 }) {
    const foot = project3D(v3, x, y, z);
    if (!foot.visible || !onScreen(v3, foot.sx, foot.sy)) return null;
    const hx = Math.round(foot.sx) + 0.5, hy = Math.round(foot.sy - stem) + 0.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6,8,10,0.9)'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(hx, foot.sy); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(hx, foot.sy); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = colour; ctx.strokeStyle = 'rgba(6,8,10,0.95)'; ctx.lineWidth = 1.25;
    ctx.beginPath(); ctx.ellipse(hx, foot.sy, 3.2, 3.2 * Math.max(0.35, Math.sin(v3.orbitPitch)), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.75; ctx.lineJoin = 'miter';
    ctx.beginPath();
    const r = size;
    if (shape === 'circle') ctx.arc(hx, hy, r * 0.82, 0, Math.PI * 2);
    else if (shape === 'square') ctx.rect(hx - r * 0.78, hy - r * 0.78, r * 1.56, r * 1.56);
    else if (shape === 'note') { ctx.moveTo(hx - r, hy - r * 0.9); ctx.lineTo(hx + r, hy - r * 0.9); ctx.lineTo(hx, hy + r); ctx.closePath(); }
    else if (shape === 'triangle') { ctx.moveTo(hx, hy - r); ctx.lineTo(hx + r, hy + r * 0.8); ctx.lineTo(hx - r, hy + r * 0.8); ctx.closePath(); }
    else { ctx.moveTo(hx, hy - r); ctx.lineTo(hx + r, hy); ctx.lineTo(hx, hy + r); ctx.lineTo(hx - r, hy); ctx.closePath(); }
    ctx.fill(); ctx.stroke();
    if (text) tag(ctx, text, hx + r + 5, hy);
    return { x: hx, y: hy };
  }

  /** A small label plate (dark, hairline border) so text stays readable over lit stone. */
  function tag(ctx, text, x, y) {
    ctx.font = '600 11px ui-sans-serif, system-ui, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const w = Math.ceil(ctx.measureText(text).width) + 10;
    ctx.fillStyle = 'rgba(14,16,19,0.9)';
    ctx.strokeStyle = 'rgba(164,218,219,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.rect(Math.round(x) + 0.5, Math.round(y - 8) + 0.5, w, 16); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e6e9ee';
    ctx.fillText(text, Math.round(x) + 5.5, Math.round(y) + 1);
    ctx.textBaseline = 'alphabetic';
  }

  const PIN_STYLE = {
    note: { colour: '#f2ead2', shape: 'note' },
    enemy: { colour: '#e06c6c', shape: 'circle' },
    treasure: { colour: '#e8d27a', shape: 'square' },
    item: { colour: '#e8d27a', shape: 'square' },
    quest: { colour: '#c9a7ff', shape: 'triangle' },
  };

  function drawMarkers3D(ctx, map, v3, slice) {
    const pY = ctl.player?.feetY ?? v3.centerY;
    const zoomed = ctl.view.scale >= 2.5;
    for (const n of notesHere()) {
      if (!Number.isFinite(n?.x) || !Number.isFinite(n?.z) || !inSlab(map, slice, n.y)) continue;
      pin(ctx, v3, n.x, Number.isFinite(n.y) ? n.y : pY, n.z, { ...PIN_STYLE.note, text: zoomed ? String(n.text).slice(0, 40) : null });
    }
    if (ui.pending) {
      const p = project3D(v3, ui.pending.x, v3.centerY, ui.pending.z);
      if (p.visible) {
        ctx.strokeStyle = '#f2ead2'; ctx.lineWidth = 2;
        if (groundPath(ctx, v3, ui.pending.x, v3.centerY, ui.pending.z, circle(Math.max(0.5, 8 / p.factor)))) ctx.stroke();
      }
    }
    for (const [source, set] of external) {
      if (set.location !== ctl.location) continue;
      for (const m of set.markers) {
        if (!Number.isFinite(m?.x) || !Number.isFinite(m?.z) || !inSlab(map, slice, m.y)) continue;
        if (source !== 'magic' && !ctl.seen(m.x, m.z, m.y)) continue;
        const style = PIN_STYLE[m.kind] ?? PIN_STYLE.quest;
        pin(ctx, v3, m.x, Number.isFinite(m.y) ? m.y : pY, m.z, { ...style, text: m.label && ctl.view.scale >= 4 ? String(m.label).slice(0, 40) : null });
      }
    }
    for (const m of map.markers) {
      if (map.sliced && (m.y > slice.top + 1.5 || m.y < slice.below - 2)) continue;
      if (!ctl.seen(m.x, m.z, m.y)) continue;
      // Door records sit mid-height in the doorway; stand the pin on its threshold.
      const exit = m.type === 3;
      pin(ctx, v3, m.x, Number.isFinite(m.y) ? m.y - 1 : pY, m.z, {
        colour: exit ? '#7fe0c4' : '#e0a548', shape: exit ? 'diamond' : 'square', size: exit ? 7.5 : 5.5,
        text: exit ? 'Exit' : zoomed ? m.label : null, stem: exit ? 26 : 20,
      });
    }
    const td = ui.townDoors;
    if (td && td.location === ctl.location && !map.sliced) {
      const seenDoors = new Set();
      const names = learnedNames(ctl.location);
      for (const d of td.doors) {
        if (!Number.isFinite(d?.x) || !Number.isFinite(d?.z) || seenDoors.has(d.portalId)) continue;
        seenDoors.add(d.portalId);
        const known = names[d.portalId] ?? (d.kind === 'dungeon' ? d.label : null);
        pin(ctx, v3, d.x, Number.isFinite(d.floor) ? d.floor : pY, d.z, {
          colour: d.kind === 'dungeon' ? '#7fe0c4' : '#e0a548', shape: 'square', size: 4.5, stem: 14,
          text: known && ctl.view.scale >= 1.5 ? String(known) : null,
        });
      }
    }
    for (const peer of (Array.isArray(api.peers) ? api.peers : api.state?.peers) ?? []) {
      if (String(peer?.id) === String(api.selfId) || !Number.isFinite(peer?.x) || !Number.isFinite(peer?.z)) continue;
      pin(ctx, v3, peer.x, Number.isFinite(peer.y) ? peer.y : pY, peer.z, { colour: '#dfe6ee', shape: 'circle', size: 6, text: peer.name ? String(peer.name) : null });
    }
    drawPlayer3D(ctx, v3);
  }

  /** The player: a heading arrow and view cone lying on their floor, an elevation ring and a beacon above. */
  function drawPlayer3D(ctx, v3) {
    const me = ctl.player;
    if (!me) return;
    const y = (me.feetY ?? v3.centerY) + 0.06;
    const foot = project3D(v3, me.x, y, me.z);
    if (!foot.visible) return;
    // Sized in metres but never smaller than ~13 px, so the marker reads from any distance.
    const r = Math.min(40, Math.max(0.55, 13 / foot.factor));
    const fx = Math.sin(me.yaw), fz = -Math.cos(me.yaw); // forward on the ground (yaw 0 = north = -z)
    const rx = -fz, rz = fx;
    const at = (f, s) => [fx * f + rx * s, fz * f + rz * s];

    // View cone.
    const cone = [[0, 0]];
    for (let i = -6; i <= 6; i++) { const a = (i / 6) * 0.5; cone.push(at(Math.cos(a) * r * 4.4, Math.sin(a) * r * 4.4)); }
    if (groundPath(ctx, v3, me.x, y, me.z, cone)) { ctx.fillStyle = 'rgba(255,170,110,0.17)'; ctx.fill(); }

    // When another storey is on view, tie the player to that plane so their height reads at a glance.
    if (Math.abs(y - v3.centerY) > 0.75) {
      const on = project3D(v3, me.x, v3.centerY, me.z);
      if (on.visible) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,170,110,0.75)'; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.moveTo(foot.sx, foot.sy); ctx.lineTo(on.sx, on.sy); ctx.stroke();
        if (groundPath(ctx, v3, me.x, v3.centerY, me.z, circle(r * 0.8))) ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Elevation ring on the player's own floor.
    if (groundPath(ctx, v3, me.x, y, me.z, circle(r * 1.25))) {
      ctx.strokeStyle = 'rgba(6,8,10,0.85)'; ctx.lineWidth = 4; ctx.stroke();
      ctx.strokeStyle = YOU_3D; ctx.lineWidth = 1.75; ctx.stroke();
    }
    // Heading arrow, flat on the floor.
    if (groundPath(ctx, v3, me.x, y, me.z, [at(r * 1.05, 0), at(-r * 0.72, r * 0.7), at(-r * 0.3, 0), at(-r * 0.72, -r * 0.7)])) {
      ctx.lineJoin = 'round';
      ctx.fillStyle = YOU_3D; ctx.strokeStyle = '#1a0d06'; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
    }
    // Beacon: a stem and bead above the head, visible over the walls of the room.
    const top = project3D(v3, me.x, y + Math.max(2.4, 30 / foot.factor), me.z);
    if (top.visible) {
      ctx.strokeStyle = 'rgba(6,8,10,0.8)'; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(foot.sx, foot.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
      ctx.strokeStyle = YOU_3D; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(foot.sx, foot.sy); ctx.lineTo(top.sx, top.sy); ctx.stroke();
      ctx.fillStyle = '#fff1e2'; ctx.strokeStyle = '#1a0d06'; ctx.lineWidth = 1.75;
      ctx.beginPath(); ctx.arc(top.sx, top.sy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  /** Compass gizmo: a ring lying on the ground plane that turns and tilts with the camera; N is picked out. */
  function drawCompass3D(ctx, v3) {
    const R = 30, cx = v3.width - R - 22, cy = R + 20;
    const cyaw = Math.cos(v3.orbitYaw), syaw = Math.sin(v3.orbitYaw), sp = Math.sin(v3.orbitPitch);
    // Ground direction (dx east, dz south) -> gizmo pixels, the same turn and tilt as the camera.
    const at = (dx, dz, k = 1) => [cx + (cyaw * dx + syaw * dz) * R * k, cy + (-syaw * dx + cyaw * dz) * sp * R * k];
    ctx.save();
    ctx.lineJoin = 'round';
    // Disc.
    ctx.beginPath(); ctx.ellipse(cx, cy, R + 7, (R + 7) * sp, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(14,16,19,0.78)'; ctx.fill();
    ctx.strokeStyle = 'rgba(115,120,130,0.9)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, R * 0.62, R * 0.62 * sp, 0, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(95,163,165,0.5)'; ctx.stroke();
    // Tick marks every 45°.
    ctx.strokeStyle = 'rgba(180,186,196,0.7)';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const [x0, y0] = at(Math.sin(a), -Math.cos(a), i % 2 ? 0.86 : 0.76), [x1, y1] = at(Math.sin(a), -Math.cos(a), 1);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    // Needle: verdigris toward north, dim toward south.
    const needle = (dz, colour) => {
      const [tx, ty] = at(0, dz * 0.7), [lx, ly] = at(-0.13, 0), [rx2, ry2] = at(0.13, 0);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(lx, ly); ctx.lineTo(rx2, ry2); ctx.closePath();
      ctx.fillStyle = colour; ctx.fill();
      ctx.strokeStyle = 'rgba(6,8,10,0.9)'; ctx.lineWidth = 1; ctx.stroke();
    };
    needle(1, '#5d636d');
    needle(-1, '#a4dadb');
    // Letters stand upright just outside the ring.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [text, dx, dz] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
      const [x, y] = at(dx, dz, 1.36);
      const north = text === 'N';
      ctx.font = `${north ? 700 : 600} ${north ? 13 : 10}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(6,8,10,0.95)';
      ctx.strokeText(text, x, y - 3);
      ctx.fillStyle = north ? '#a4dadb' : '#b4bac4';
      ctx.fillText(text, x, y - 3);
    }
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  // ------------------------------------------------------------------------------------------- dungeon minimap HUD

  function ensureMinimap() {
    if (typeof document === 'undefined' || ui.minimap) return ui.minimap;
    const hud = document.getElementById('hud');
    if (!hud) return null;
    ui.minimapCanvas = el('canvas', { class: 'amap-mini-canvas', width: '160', height: '160', 'aria-hidden': 'true' });
    ui.minimapTitle = el('span', { class: 'amap-mini-title' }, 'Automap');
    ui.minimap = el('aside', {
      id: 'hud-minimap',
      class: 'amap-mini',
      'data-hud-movable': 'minimap',
      'aria-label': 'Dungeon minimap',
      hidden: true,
      onclick: () => api.openPanel?.(PANEL_ID),
      title: 'Click to open full Automap (N)',
    },
      el('div', { class: 'amap-mini-head' }, ui.minimapTitle, el('kbd', {}, 'N')),
      ui.minimapCanvas);
    hud.append(ui.minimap);
    return ui.minimap;
  }

  function syncMinimap() {
    if (typeof document === 'undefined') return;
    const show = ctl.prefs.minimapEnabled && api.screen === 'game' && !api.modalOpen;
    if (!show) {
      if (ui.minimap) ui.minimap.hidden = true;
      return;
    }
    const box = ensureMinimap();
    if (!box) return;
    box.hidden = false;
    box.dataset.corner = ctl.prefs.minimapCorner;
    box.dataset.size = ctl.prefs.minimapSize;
    const dim = ctl.prefs.minimapSize === 'compact' ? 128 : ctl.prefs.minimapSize === 'large' ? 204 : 164;
    if (ui.minimapCanvas.width !== dim || ui.minimapCanvas.height !== dim) {
      ui.minimapCanvas.width = dim;
      ui.minimapCanvas.height = dim;
    }
    if (ui.minimapTitle) ui.minimapTitle.textContent = placeName(ctl.location, ctl.mesh);
    drawMinimap();
  }

  function drawMinimap() {
    const cv = ui.minimapCanvas;
    if (!cv || !ui.minimap || ui.minimap.hidden) return;
    ui.minimapDrawn = ctl.version;
    ctl.ensureMap();
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(9, 13, 19, 0.92)';
    ctx.fillRect(0, 0, w, h);
    const map = ctl.map;
    if (!map) return;
    const cx = ctl.player?.x ?? ctl.view.centerX;
    const cz = ctl.player?.z ?? ctl.view.centerZ;
    const v = makeView({
      centerX: cx, centerZ: cz,
      scale: ctl.kind === 'town' ? Math.max(1.2, ctl.prefs.exteriorDefaultZoom * 0.75) : 5.5,
      width: w, height: h,
      rotation: ctl.orientation === 'heading' ? (ctl.player?.yaw ?? 0) : 0,
    });
    const [ta, tb, tc, td, te, tf] = viewTransform(v);
    ctx.setTransform(ta, tb, tc, td, te, tf);
    if (ctl.fog) {
      const fog = fogPath();
      ctx.save();
      ctx.clip(fog);
    }
    const shown = ctl.pieces();
    for (const { piece, mode } of shown) {
      if (piece.kind !== 'fill') continue;
      ctx.globalAlpha = mode === 'below' ? 0.25 : 0.9;
      ctx.fillStyle = `rgb(${piece.colour[0]},${piece.colour[1]},${piece.colour[2]})`;
      ctx.fill(pathOf(piece));
    }
    ctx.strokeStyle = 'rgba(220,234,248,0.9)';
    ctx.lineWidth = 1.4 / v.scale;
    for (const { piece, mode } of shown) if (piece.kind === 'wall' && mode === 'current') ctx.stroke(pathOf(piece));
    if (ctl.fog) ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (ctl.player) {
      const [px, py] = worldToScreen(v, ctl.player.x, ctl.player.z);
      const [dx, dy] = headingVector(ctl.player.yaw, v.rotation);
      ctx.fillStyle = '#6fd0ff';
      ctx.beginPath();
      ctx.moveTo(px + dx * 7, py + dy * 7);
      ctx.lineTo(px - dx * 5 - dy * 4, py - dy * 5 + dx * 4);
      ctx.lineTo(px - dx * 5 + dy * 4, py - dy * 5 - dx * 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  return { controller: ctl, requestMemory, syncMinimap };
}

export default { name: 'automap', install };
