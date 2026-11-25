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
import { worldToScreen, screenToWorld, viewTransform, floorLabel } from './automap/model.js';
import { CELL, MAX_NOTE_TEXT, MAX_NOTEBOOK_TEXT, fogged, cellsBounds } from './automap/memory.js';

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
  const ctl = createAutomapController();
  const ui = { root: null, canvas: null, status: null, floorSel: null, title: null, drawn: -1, raf: 0, lastStatus: 0 };
  const paths = new WeakMap(); // piece -> Path2D in world coordinates

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
      if (isOpen()) { if (ui.floorCount !== ctl.floors.length) build(); else { updateText(); schedule(); } }
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
    if (!moved && !(isOpen() && api.peers?.length && t - (ui.peerDraw ?? 0) > 100)) return;
    if (!moved) { ui.peerDraw = t; ctl.version++; }
    schedule();
    const now = Date.now();
    if (isOpen() && now - ui.lastStatus > 600) { ui.lastStatus = now; updateText(); }
  });
  api.on('state', () => schedule());
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
  }

  api.registerPanel(PANEL_ID, 'Automap', render, { key: PANEL_KEY, watch: 'none' });
  api.registerPanel(NOTEBOOK_ID, 'Notebook', renderNotebook, { watch: 'none' });

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

    const tools = el('div', { class: 'amap-tools', role: 'toolbar', 'aria-label': 'Map controls' },
      el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Zoom' },
        btn('−', 'Zoom out (−)', () => ctl.zoom(1 / 1.5)),
        btn('+', 'Zoom in (+)', () => ctl.zoom(1.5))),
      btn('⌖ Recentre', 'Recentre on you and follow (C)', () => ctl.recenter(), { class: 'amap-btn amap-wide' }),
      btn(ctl.fog ? 'Explored area' : 'Whole place', ctl.fog ? 'Show everything you have explored (0)' : 'Show the whole place (0)', () => ctl.fitAll(), { class: 'amap-btn amap-wide', disabled: !map }),
      floorBox,
      el('div', { class: 'amap-group', role: 'group', 'aria-label': 'Orientation' },
        btn('⟲', 'Turn the map anticlockwise (Q)', () => ctl.rotate(-1)),
        ui.orient = btn(ctl.orientationText(), 'North up or heading up (H)', () => ctl.setOrientation(ctl.orientation === 'heading' ? 'north' : 'heading'), { class: 'amap-btn amap-orient', 'aria-pressed': String(ctl.orientation === 'heading') }),
        btn('⟳', 'Turn the map clockwise (E)', () => ctl.rotate(1))),
      map?.sliced ? ui.cut = btn('Cutaway', 'Cut away levels above your floor (X)', () => ctl.setCutaway(!ctl.cutaway), { class: 'amap-btn amap-wide', 'aria-pressed': String(ctl.cutaway) }) : (ui.cut = null),
      ui.mark = btn('✎ Note', 'Pin a note: click a spot on the map, or K for the centre', () => { ui.marking = !ui.marking; }, { class: 'amap-btn amap-wide', 'aria-pressed': String(!!ui.marking) }));

    ui.canvas = el('canvas', { class: 'amap-canvas', role: 'img', 'aria-label': 'Map' });
    const stage = el('div', {
      class: 'amap-stage', tabindex: '0', 'aria-describedby': help,
      'aria-label': 'Map view. Arrow keys pan, plus and minus zoom.',
    }, ui.canvas, el('div', { class: 'amap-north', 'aria-hidden': 'true' }, 'N', el('span', {}, '▲')));
    attachPointer(stage);

    ui.status = el('p', { class: 'amap-status', role: 'status', 'aria-live': 'polite' });
    const keys = el('p', { class: 'amap-keys', id: help },
      'Arrows/WASD pan · + / − zoom · C recentre · 0 whole place', ctl.floorSelector() ? ' · PgUp/PgDn floor' : '',
      ' · Q/E turn · H heading up', map?.sliced ? ' · X cutaway' : '', ' · K note · N or Esc close');
    const legend = el('ul', { class: 'amap-legend', 'aria-label': 'Legend' },
      el('li', {}, el('span', { class: 'amap-sw amap-sw-you', 'aria-hidden': 'true' }), 'You'),
      el('li', {}, el('span', { class: 'amap-sw amap-sw-peer', 'aria-hidden': 'true' }), 'Other players'),
      map?.markers.length || ui.townDoors?.doors?.length ? el('li', {}, el('span', { class: 'amap-sw amap-sw-door', 'aria-hidden': 'true' }), 'Doors and exits') : null,
      map?.sliced ? el('li', {}, el('span', { class: 'amap-sw amap-sw-below', 'aria-hidden': 'true' }), 'Lower levels') : null,
      ctl.fog ? el('li', {}, el('span', { class: 'amap-sw amap-sw-fog', 'aria-hidden': 'true' }), 'Unexplored') : null,
      el('li', {}, el('span', { class: 'amap-sw amap-sw-note', 'aria-hidden': 'true' }), 'Your notes'));

    ui.notes = el('section', { class: 'amap-notes', 'aria-label': 'Your notes on this map' });
    ui.floorCount = floors.length;
    ui.root.replaceChildren(ui.title, tools, stage, ui.status, ui.notes, el('div', { class: 'amap-foot' }, legend, keys));
    renderNotes();
    // Inspection hooks for tests and capture harnesses.
    ui.root.dataset.kind = ctl.kind;
    ui.root.dataset.location = ctl.location ?? '';
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
    updateText();
    schedule();
    queueMicrotask(() => { if (isOpen() && !ui.root.contains(document.activeElement)) stage.focus({ preventScroll: true }); });
  }

  function floorOptionText(i) {
    const name = floorLabel(ctl.floors, i, ctl.groundY(), { explored: ctl.fog }).replace(/\s*\(.*\)$/, '') || `Floor ${i + 1}`;
    return `${name}${i === ctl.playerFloor() ? ' (you)' : ''}`;
  }

  function afterChange() {
    if (ui.floorSel) ui.floorSel.value = ctl.floor === null ? 'auto' : String(ctl.floor);
    if (ui.orient) { ui.orient.textContent = ctl.orientationText(); ui.orient.setAttribute('aria-pressed', String(ctl.orientation === 'heading')); }
    if (ui.cut) ui.cut.setAttribute('aria-pressed', String(ctl.cutaway));
    if (ui.mark) ui.mark.setAttribute('aria-pressed', String(!!ui.marking));
    if (ui.root) ui.root.dataset.orientation = ctl.orientation === 'heading' ? 'heading' : `north:${Math.round((ctl.turn * 2) / Math.PI)}`;
    if (ui.root) ui.root.dataset.cutaway = ctl.cutaway ? '1' : '0';
    updateText();
    schedule();
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
    if (north) north.style.transform = `rotate(${-ctl.view.rotation}rad)`;
    const text = ctl.describe();
    if (ui.status.textContent !== text) ui.status.textContent = text;
    if (ui.canvas) ui.canvas.setAttribute('aria-label', `Map of ${placeName(ctl.location, ctl.mesh)}. ${text}`);
  }

  /** Fit the canvas to the stage's width; returns true when the size changed. */
  function sizeCanvas() {
    const cv = ui.canvas;
    const stage = cv?.parentElement;
    if (!cv || !stage) return false;
    const w = Math.max(240, Math.floor(stage.clientWidth || 640));
    const h = Math.max(220, Math.round(Math.min(window.innerHeight * 0.46, w * 0.62)));
    if (w === ctl.view.width && h === ctl.view.height && cv.width) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    ctl.resize(w, h);
    return true;
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
      case 'KeyC': case 'Home': ctl.recenter(); break;
      case 'Digit0': case 'Numpad0': ctl.fitAll(); break;
      case 'PageUp': case 'BracketRight': handled = ctl.stepFloor(1); break;
      case 'PageDown': case 'BracketLeft': handled = ctl.stepFloor(-1); break;
      case 'KeyQ': ctl.rotate(-1); break;
      case 'KeyE': ctl.rotate(1); break;
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
      if (e.button !== 0) return;
      if (ui.marking) {
        const r = ui.canvas.getBoundingClientRect();
        const [x, z] = screenToWorldAt(e.clientX - r.left, e.clientY - r.top);
        ui.marking = false;
        startNote(x, z);
        afterChange();
        return;
      }
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      stage.setPointerCapture?.(e.pointerId);
      stage.focus({ preventScroll: true });
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!dx && !dy) return;
      drag.x = e.clientX; drag.y = e.clientY;
      ctl.pan(dx, dy);
      afterChange();
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
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
  const screenToWorldAt = (sx, sy) => screenToWorld(ctl.view, sx, sy);

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
    ctx.fillStyle = '#0b1016';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const map = ctl.map;
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

  return { controller: ctl, requestMemory };
}

export default { name: 'automap', install };
