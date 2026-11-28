// Game shell UI: the in-game menu (character, inventory, spellbook, journal, map, party,
// interaction, settings), numeric vitals, target readout, toasts and the action bar.
// Markup lives in play.html (see client/hud-contract.md, "Game shell"); styles in shell.css.
//
// Feature modules register real panels with api.registerPanel(id, title, render). Each section
// also has a built-in panel here that renders whatever the server already sends, so no menu
// entry is ever empty while a feature module is missing or failed to load.

import {
  PANELS, BINDING_LABELS, DEFAULT_BINDINGS, keyLabel, rebind, normalizeBindings,
  statsOf, vitalsOf, readiedOf, locationName, targetables, interactionFor, watchKey,
} from './api.js';
import { PAD } from '../input.js';
import { REGION_NAMES } from '../world/maps.js';
import { itemIcon } from './inventory/icons.js';
import { ACCOUNT_LINKS, WEBSITE_LINKS } from '../lib/web-integration.js';
import {
  t, setLocale, listLocales, normalizeLocaleCode, applyLocaleToDocument, DEFAULT_LOCALE,
} from '../lib/i18n.js';

const SETTINGS_KEY = 'dfw.settings';
export const SETTINGS_SCHEMA_VERSION = 1;

/** Keyboard movement and look bindings (previously fixed; now fully remappable). */
export const DEFAULT_MOVE_BINDINGS = Object.freeze({
  moveForward: 'KeyW',
  moveBack: 'KeyS',
  strafeLeft: 'KeyA',
  strafeRight: 'KeyD',
  turnLeft: 'KeyQ',
  turnRight: 'KeyE',
  turnLeftAlt: 'ArrowLeft',
  turnRightAlt: 'ArrowRight',
  lookUp: 'ArrowUp',
  lookDown: 'ArrowDown',
});

export const MOVE_BINDING_LABELS = Object.freeze({
  moveForward: 'Move forward',
  moveBack: 'Move backward',
  strafeLeft: 'Strafe left',
  strafeRight: 'Strafe right',
  turnLeft: 'Turn left',
  turnRight: 'Turn right',
  turnLeftAlt: 'Turn left (alt)',
  turnRightAlt: 'Turn right (alt)',
  lookUp: 'Look up',
  lookDown: 'Look down',
});

const MOVE_RESERVED = new Set(['Escape', 'Tab', 'Enter', 'NumpadEnter']);

export const DEFAULT_GAMEPAD_SETTINGS = Object.freeze({
  lookSensitivity: 1,
  deadzone: 0.18,
  invertMoveX: false,
  invertMoveY: false,
  invertLookX: false,
  invertLookY: false,
  axes: Object.freeze({ moveX: 0, moveY: 1, lookX: 2, lookY: 3 }),
  buttons: Object.freeze({
    interact: PAD.A,
    cancel: PAD.B,
    attack: PAD.X,
    attackAlt: PAD.RT,
    ready: PAD.Y,
    run: PAD.LB,
    quickslotNext: PAD.RB,
    crouch: PAD.RS,
    menu: PAD.START,
    map: PAD.BACK,
  }),
});

export const GAMEPAD_BUTTON_NAMES = Object.freeze({
  [PAD.A]: 'A / Cross',
  [PAD.B]: 'B / Circle',
  [PAD.X]: 'X / Square',
  [PAD.Y]: 'Y / Triangle',
  [PAD.LB]: 'LB / L1',
  [PAD.RB]: 'RB / R1',
  [PAD.LT]: 'LT / L2',
  [PAD.RT]: 'RT / R2',
  [PAD.BACK]: 'Back / Select',
  [PAD.START]: 'Start / Options',
  [PAD.LS]: 'Left Stick Click',
  [PAD.RS]: 'Right Stick Click',
  [PAD.UP]: 'D-Pad Up',
  [PAD.DOWN]: 'D-Pad Down',
  [PAD.LEFT]: 'D-Pad Left',
  [PAD.RIGHT]: 'D-Pad Right',
});

export const GAMEPAD_ACTION_LABELS = Object.freeze({
  interact: 'Use / Talk / Confirm',
  cancel: 'Close Menu / Cancel',
  attack: 'Primary Attack',
  attackAlt: 'Secondary Attack',
  ready: 'Ready / Sheathe Weapon',
  run: 'Run (hold)',
  quickslotNext: 'Cycle Quickslot',
  crouch: 'Crouch / Sneak',
  menu: 'Open Menu',
  map: 'Open Map',
});

export const GAMEPAD_AXIS_NAMES = Object.freeze([
  'Left Stick X (Axis 0)',
  'Left Stick Y (Axis 1)',
  'Right Stick X (Axis 2)',
  'Right Stick Y (Axis 3)',
]);

export const DEFAULT_CAMERA_PREFS = Object.freeze({
  mouseSmoothing: 0,
  movementAcceleration: 1,
  headBob: 1,
  handedness: 'right',
  cameraRecoil: 1,
  weaponGestureSensitivity: 1,
  bowDrawback: false,
});

export const MOVABLE_HUD_WIDGETS = Object.freeze([
  { id: 'hud-vitals', key: 'vitals', label: 'Vitals' },
  { id: 'hud-bar', key: 'bar', label: 'Action bar' },
  { id: 'hud-compass', key: 'compass', label: 'Compass' },
  { id: 'hud-chat', key: 'chat', label: 'Chat' },
  { id: 'hud-quickslots', key: 'quickslots', label: 'Quickslots' },
  { id: 'hud-conveniences', key: 'conveniences', label: 'HUD counters' },
  { id: 'hud-minimap', key: 'minimap', label: 'Dungeon minimap' },
]);

export function normalizeMoveBindings(saved) {
  const out = { ...DEFAULT_MOVE_BINDINGS };
  if (!saved || typeof saved !== 'object') return out;
  for (const [action, code] of Object.entries(saved)) {
    if (!(action in DEFAULT_MOVE_BINDINGS)) continue;
    if (code === null) { out[action] = null; continue; }
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{2,20}$/.test(code) || MOVE_RESERVED.has(code)) continue;
    out[action] = code;
  }
  const seen = new Set();
  for (const action of Object.keys(DEFAULT_MOVE_BINDINGS)) {
    const c = out[action];
    if (!c) continue;
    if (seen.has(c)) out[action] = null;
    else seen.add(c);
  }
  return out;
}

export function rebindMove(moveBindings, action, code) {
  if (!(action in DEFAULT_MOVE_BINDINGS)) throw new Error(`Unknown movement action ${action}`);
  if (code && MOVE_RESERVED.has(code)) throw new Error(`${keyLabel(code)} is reserved.`);
  const out = { ...moveBindings };
  for (const a of Object.keys(out)) if (code && out[a] === code) out[a] = null;
  out[action] = code || null;
  return out;
}

export function normalizeGamepadSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const axis = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : d);
  const btn = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 15 ? v : d);
  const rawAxes = src.axes && typeof src.axes === 'object' ? src.axes : {};
  const rawButtons = src.buttons && typeof src.buttons === 'object' ? src.buttons : {};
  const buttons = {};
  for (const [k, def] of Object.entries(DEFAULT_GAMEPAD_SETTINGS.buttons)) {
    buttons[k] = btn(rawButtons[k], def);
  }
  return {
    lookSensitivity: num(src.lookSensitivity, 0.2, 3, DEFAULT_GAMEPAD_SETTINGS.lookSensitivity),
    deadzone: num(src.deadzone, 0.05, 0.45, DEFAULT_GAMEPAD_SETTINGS.deadzone),
    invertMoveX: src.invertMoveX === true,
    invertMoveY: src.invertMoveY === true,
    invertLookX: src.invertLookX === true,
    invertLookY: src.invertLookY === true,
    axes: {
      moveX: axis(rawAxes.moveX, DEFAULT_GAMEPAD_SETTINGS.axes.moveX),
      moveY: axis(rawAxes.moveY, DEFAULT_GAMEPAD_SETTINGS.axes.moveY),
      lookX: axis(rawAxes.lookX, DEFAULT_GAMEPAD_SETTINGS.axes.lookX),
      lookY: axis(rawAxes.lookY, DEFAULT_GAMEPAD_SETTINGS.axes.lookY),
    },
    buttons,
  };
}

/** Apply gamepad axis mapping, radial deadzone, and per-axis inversion to raw gamepad axes. */
export function mapGamepadAxes(rawAxes, gp = DEFAULT_GAMEPAD_SETTINGS) {
  const cfg = normalizeGamepadSettings(gp);
  const read = (i) => (Array.isArray(rawAxes) && Number.isFinite(rawAxes[i]) ? rawAxes[i] : 0);
  const radial = (x, y, dead) => {
    const m = Math.hypot(x, y);
    if (m <= dead) return [0, 0];
    const k = Math.min(1, (m - dead) / Math.max(0.05, 1 - dead)) / m;
    return [x * k, y * k];
  };
  let [mx, my] = radial(read(cfg.axes.moveX), read(cfg.axes.moveY), cfg.deadzone);
  let [lx, ly] = radial(read(cfg.axes.lookX), read(cfg.axes.lookY), cfg.deadzone);
  if (cfg.invertMoveX && mx) mx = -mx;
  if (cfg.invertMoveY && my) my = -my;
  if (cfg.invertLookX && lx) lx = -lx;
  if (cfg.invertLookY && ly) ly = -ly;
  return [mx || 0, my || 0, lx || 0, ly || 0];
}

export function normalizeCameraPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    mouseSmoothing: num(src.mouseSmoothing, 0, 0.85, DEFAULT_CAMERA_PREFS.mouseSmoothing),
    movementAcceleration: num(src.movementAcceleration, 0.25, 1, DEFAULT_CAMERA_PREFS.movementAcceleration),
    headBob: num(src.headBob, 0, 1.5, DEFAULT_CAMERA_PREFS.headBob),
    handedness: src.handedness === 'left' ? 'left' : 'right',
    cameraRecoil: num(src.cameraRecoil, 0, 1.5, DEFAULT_CAMERA_PREFS.cameraRecoil),
    weaponGestureSensitivity: num(src.weaponGestureSensitivity, 0.4, 2.5, DEFAULT_CAMERA_PREFS.weaponGestureSensitivity),
    bowDrawback: src.bowDrawback === true,
  };
}

export function clampHudOffset(x, y, { maxX = 480, maxY = 320 } = {}) {
  const cx = Number.isFinite(x) ? Math.round(Math.max(-maxX, Math.min(maxX, x))) : 0;
  const cy = Number.isFinite(y) ? Math.round(Math.max(-maxY, Math.min(maxY, y))) : 0;
  return { x: cx, y: cy };
}

export function normalizeHudLayout(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const allowed = new Set(MOVABLE_HUD_WIDGETS.map((w) => w.key));
  for (const [k, pos] of Object.entries(raw)) {
    if (!allowed.has(k) || !pos || typeof pos !== 'object') continue;
    const clamped = clampHudOffset(Number(pos.x), Number(pos.y));
    if (clamped.x !== 0 || clamped.y !== 0) out[k] = clamped;
  }
  return out;
}

export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    sensitivity: num(src.sensitivity, 0.2, 3, 1),
    invertY: src.invertY === true,
    uiScale: num(src.uiScale, 0.8, 1.4, 1),
    clickAttack: src.clickAttack !== false,
    showTarget: src.showTarget !== false,
    classicCompass: src.classicCompass === true,
    touchControls: src.touchControls === true,
    locale: normalizeLocaleCode(src.locale ?? DEFAULT_LOCALE),
    bindings: normalizeBindings(src.bindings),
    moveBindings: normalizeMoveBindings(src.moveBindings),
    gamepad: normalizeGamepadSettings(src.gamepad),
    camera: normalizeCameraPrefs(src.camera),
    hudLayout: normalizeHudLayout(src.hudLayout),
  };
}

/** Portable settings export (versioned JSON string). */
export function exportSettingsJson(settings, { automapPrefs = null } = {}) {
  const payload = {
    schema: 'daggerfall-world.settings',
    version: SETTINGS_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(settings),
    ...(automapPrefs ? { automapPrefs } : {}),
  };
  return JSON.stringify(payload, null, 2);
}

/** Portable settings import with strict validation and clear errors. */
export function importSettingsJson(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) {
    return { ok: false, error: 'Settings JSON is empty.' };
  }
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Settings file must be a JSON object.' };
  }
  if (parsed.version !== undefined && parsed.version !== SETTINGS_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported settings version (${parsed.version}).` };
  }
  const source = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  const settings = normalizeSettings(source);
  const automapPrefs = parsed.automapPrefs && typeof parsed.automapPrefs === 'object' ? parsed.automapPrefs : null;
  return { ok: true, settings, automapPrefs };
}

// Menu pages are grouped on the rail (hud/layout.css draws the group labels). Unknown pages go
// to the group of their nearest known neighbour in registration order.
export const PANEL_GROUPS = Object.freeze([
  ['You', ['character', 'inventory', 'spellbook', 'journal']],
  ['World', ['map', 'wilderness', 'places', 'automap', 'rest', 'property', 'sailing', 'seaChart', 'shipyard', 'passage', 'admiralty']],
  ['People', ['party', 'guilds', 'interaction', 'dialogue', 'townServices']],
  ['System', ['settings', 'audio', 'help']],
]);
const GROUP_OF = new Map(PANEL_GROUPS.flatMap(([g, ids], gi) => ids.map((id, i) => [id, [gi, i, g]])));

/** Pages in rail order: by group, then the group's listed order, then registration order. */
export function groupPanels(list) {
  let last = [0, 0, PANEL_GROUPS[0][0]];
  const keyed = list.map((p, n) => {
    const k = GROUP_OF.get(p.id);
    if (k) last = k;
    return { p, g: k ? k[0] : last[0], i: k ? k[1] : last[1] + 0.5, n, label: k ? k[2] : last[2] };
  });
  keyed.sort((a, b) => a.g - b.g || a.i - b.i || a.n - b.n);
  return keyed.map((k, j) => ({ ...k.p, group: k.label, groupStart: j === 0 || keyed[j - 1].g !== k.g }));
}

// The live menu: seven top-level categories along the top bar, each with sub-tabs for its pages.
// PANEL_GROUPS above stays for callers (and tests) that still want the rail order.
export const MENU_CATEGORIES = Object.freeze([
  { id: 'character', title: 'Character', key: 'KeyC', panels: ['character', 'professions', 'health', 'law', 'property', 'homes'] },
  { id: 'inventory', title: 'Inventory', key: 'KeyI', panels: ['inventory'] },
  { id: 'magic', title: 'Magic', key: 'KeyB', panels: ['spellbook'] },
  { id: 'journal', title: 'Journal', key: 'KeyJ', panels: ['journal', 'notebook', 'admiralty'] },
  { id: 'maps', title: 'Maps', key: 'KeyM', panels: ['map', 'automap', 'wilderness', 'places', 'sailing', 'seaChart'] },
  { id: 'social', title: 'Social', key: 'KeyO', panels: ['party', 'guilds', 'townServices'] },
  { id: 'system', title: 'System', key: 'F10', panels: ['settings', 'audio', 'graphics', 'rest', 'help'] },
].map((c) => Object.freeze({ ...c, panels: Object.freeze(c.panels) })));
/** Pages opened by the world (a shop counter, a conversation, market board, crafting station, arena/co-op), never listed in the menu tabs. */
export const CONTEXTUAL_PANELS = Object.freeze([
  'shop', 'interaction', 'dialogue', 'alchemy', 'spellmaker', 'shipyard', 'passage', 'spellchoice',
  'market', 'crafting-station', 'pvp', 'coopWorld',
]);
const CATEGORY_OF = new Map(MENU_CATEGORIES.flatMap((c) => c.panels.map((id) => [id, c.id])));
const CONTEXTUAL = new Set(CONTEXTUAL_PANELS);

/**
 * Registered pages laid out by category. Unknown pages join Character when the legacy rail put
 * them with "You", otherwise Maps, so every registered page stays reachable from the tabs.
 * Returns { categories: [{ ...category, pages }], contextual: [page] } with empty categories dropped.
 */
export function menuLayout(list) {
  const legacy = new Map(groupPanels(list).map((p) => [p.id, p.group]));
  const pages = new Map(MENU_CATEGORIES.map((c) => [c.id, []]));
  const contextual = [];
  for (const p of list) {
    if (CONTEXTUAL.has(p.id)) { contextual.push(p); continue; }
    const cat = CATEGORY_OF.get(p.id) ?? (legacy.get(p.id) === 'You' ? 'character' : 'maps');
    pages.get(cat).push(p);
  }
  for (const c of MENU_CATEGORIES) {
    const order = c.panels;
    pages.get(c.id).sort((a, b) => {
      const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    });
  }
  return {
    categories: MENU_CATEGORIES.map((c) => ({ ...c, pages: pages.get(c.id) })).filter((c) => c.pages.length),
    contextual,
  };
}

/** The category a page sits in for a layout, or null for a contextual page. */
export function categoryFor(layout, id) {
  return layout.categories.find((c) => c.pages.some((p) => p.id === id)) ?? null;
}

/** The contextual name of the Use action for a target (bar button label). */
export function useLabel(e) {
  const it = interactionFor(e);
  if (!it) return 'Use';
  if (it.verb === 'npc.talk') return 'Talk';
  if (it.verb === 'inventory.inspectLoot' || it.verb === 'combat.loot' || (it.verb === 'container.open' && e.containerType === 'treasure')) return 'Loot';
  if (it.verb === 'combat.revive') return 'Revive';
  if (it.panel === 'party') return 'Party';
  return 'Use';
}

export function loadSettings(storage = globalThis.localStorage) {
  let raw = {};
  try { raw = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}') || {}; } catch { raw = {}; }
  return normalizeSettings(raw);
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings))); } catch { /* storage disabled */ }
}

// ---------------------------------------------------------------- tiny DOM helper

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);
const isTextField = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type || 'text'));

/** A stable key for re-finding an element after a re-render. */
function focusKey(el, root) {
  if (!el || !root.contains(el)) return null;
  if (el.id) return { id: el.id };
  if (el.dataset.focusKey) return { fk: el.dataset.focusKey };
  const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60);
  return { index: focusables(root).indexOf(el), label, tag: el.tagName };
}

function restoreFocus(key, root) {
  if (!key) return false;
  let el = null;
  if (key.id) el = root.querySelector(`#${CSS.escape(key.id)}`);
  else if (key.fk) el = root.querySelector(`[data-focus-key="${CSS.escape(key.fk)}"]`);
  else {
    const list = focusables(root);
    el = list.find((e) => e.tagName === key.tag && (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 60)) === key.label)
      ?? list[Math.min(key.index, list.length - 1)] ?? null;
  }
  if (el) { el.focus({ preventScroll: true }); return true; }
  return false;
}

/** Values the player typed into fields that have an id or name, to carry across a re-render. */
function editedFields(root) {
  return [...root.querySelectorAll('[data-user-edited="1"]')].map((el) => ({
    key: el.id ? { id: el.id } : el.name ? { name: el.name, type: el.type } : null,
    value: el.value, checked: el.checked,
    sel: typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null,
  })).filter((f) => f.key);
}

function restoreEdited(list, root) {
  for (const f of list) {
    const el = f.key.id ? root.querySelector(`#${CSS.escape(f.key.id)}`)
      : root.querySelector(`[name="${CSS.escape(f.key.name)}"]${f.key.type === 'radio' ? `[value="${CSS.escape(f.value)}"]` : ''}`);
    if (!el || el.dataset.noRestore !== undefined) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked;
    else el.value = f.value;
    el.dataset.userEdited = '1';
    if (f.sel) { try { el.setSelectionRange(...f.sel); } catch { /* not a text field */ } }
  }
}

// ---------------------------------------------------------------- shell

/**
 * @param {object} o
 * @param {object} o.api          gameplay API (api.js)
 * @param {object} o.input        Input instance (sensitivity, invertY, suspend)
 * @param {object} o.actions      { ready(), attack(), interact(), leave(), chat() }
 * @param {object} o.settings     from loadSettings()
 */
export function createShell({ api, input, actions, settings }) {
  const $ = (id) => document.getElementById(id);
  const ui = {
    menu: $('game-menu'), topbar: $('game-menu')?.querySelector?.('.menu-topbar') ?? null,
    tabs: $('menu-tabs'), subtabs: $('menu-subtabs'), title: $('menu-title'), panel: $('menu-panel'),
    close: $('menu-close'), hint: $('menu-hint'),
    vitals: $('hud-vitals'), breath: $('hud-breath'), target: $('hud-target'), toasts: $('hud-toasts'), bar: $('hud-bar'),
    readyBtn: $('hud-ready-btn'), menuBtn: $('hud-menu-btn'), helpDl: $('hud-help-list'),
    useBtn: $('hud-use-btn'),
  };
  let open = null;
  let openKey = null; // watchKey of the open panel at its last render
  let returnFocus = null;
  let rebinding = null; // { kind: 'action' | 'move', action: string } awaiting a key
  let hudEditMode = false;
  const lastInCategory = new Map(); // category id → page id last opened there
  const dialogue = []; // recent interaction lines {who, text, at}

  // Ensure settings always have normalized extended fields (moveBindings, gamepad, camera, hudLayout, locale).
  Object.assign(settings, normalizeSettings(settings));

  // ---- Runtime adapter for remapped keyboard movement/look, gamepad remapping, mouse smoothing, movement accel & camera recoil.
  const customHeld = new Set();
  let smoothYaw = 0, smoothPitch = 0;
  let smoothFwd = 0, smoothStrafe = 0;
  let recoilPitch = 0;
  let prevPadAxes = [0, 0, 0, 0];

  const isTypingEl = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (!input.active?.() || isTypingEl(document.activeElement)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (Object.values(settings.moveBindings || {}).includes(e.code)) {
        customHeld.add(e.code);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => customHeld.delete(e.code));
    window.addEventListener('blur', () => customHeld.clear());
  }

  // Wrap input.setPadAxes, input.axes, and input.look so remapped movement/look keys, gamepad axes/deadzone/inversion,
  // mouse smoothing, and movement acceleration take effect live without mutating client/input.js.
  if (input && typeof input.axes === 'function' && typeof input.look === 'function') {
    const origSetPadAxes = input.setPadAxes?.bind(input);
    const origLook = input.look.bind(input);
    if (origSetPadAxes) {
      input.setPadAxes = (axes) => {
        // Re-map raw gamepad sticks if navigator.getGamepads has a connected pad, else remap passed axes.
        let raw = axes;
        try {
          const pads = globalThis.navigator?.getGamepads?.() ?? [];
          for (const p of pads) {
            if (p && p.connected !== false && Array.isArray(p.axes) && p.axes.length >= 2) {
              raw = p.axes;
              break;
            }
          }
        } catch { /* no gamepad API */ }
        prevPadAxes = input.active() ? mapGamepadAxes(raw, settings.gamepad) : [0, 0, 0, 0];
        origSetPadAxes(prevPadAxes);
      };
    }

    input.axes = () => {
      if (!input.active() || isTypingEl(document.activeElement)) {
        smoothFwd = 0; smoothStrafe = 0;
        return { forward: 0, strafe: 0 };
      }
      const mb = settings.moveBindings || DEFAULT_MOVE_BINDINGS;
      const down = (code) => !!code && (customHeld.has(code) || input.keys?.has(code));
      const [lx, ly] = prevPadAxes;
      const touchMove = api._touchState?.move ?? { forward: 0, strafe: 0 };
      const clamp1 = (v) => Math.max(-1, Math.min(1, v));
      const targetFwd = clamp1((down(mb.moveForward) ? 1 : 0) - (down(mb.moveBack) ? 1 : 0) - ly + (touchMove.forward || 0));
      const targetStrafe = clamp1((down(mb.strafeRight) ? 1 : 0) - (down(mb.strafeLeft) ? 1 : 0) + lx + (touchMove.strafe || 0));
      const accel = settings.camera?.movementAcceleration ?? 1;
      if (accel >= 0.98) {
        smoothFwd = targetFwd;
        smoothStrafe = targetStrafe;
      } else {
        const blend = Math.min(1, 0.12 + accel * 0.75);
        smoothFwd += (targetFwd - smoothFwd) * blend;
        smoothStrafe += (targetStrafe - smoothStrafe) * blend;
        if (Math.abs(smoothFwd) < 0.01 && targetFwd === 0) smoothFwd = 0;
        if (Math.abs(smoothStrafe) < 0.01 && targetStrafe === 0) smoothStrafe = 0;
      }
      return { forward: clamp1(smoothFwd), strafe: clamp1(smoothStrafe) };
    };

    input.look = (dt) => {
      if (!input.active()) { smoothYaw = 0; smoothPitch = 0; return origLook(dt); }
      // Temporarily swap out fixed keys from input.keys so origLook doesn't double-count remapped keys.
      const savedKeys = new Set(input.keys || []);
      for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyQ', 'KeyE']) input.keys?.delete(k);
      const base = origLook(dt);
      for (const k of savedKeys) input.keys?.add(k);

      const mb = settings.moveBindings || DEFAULT_MOVE_BINDINGS;
      const down = (code) => !!code && (customHeld.has(code) || savedKeys.has(code));
      let keyYaw = 0, keyPitch = 0;
      if (!isTypingEl(document.activeElement)) {
        keyYaw = ((down(mb.turnRight) || down(mb.turnRightAlt) ? 1 : 0) - (down(mb.turnLeft) || down(mb.turnLeftAlt) ? 1 : 0)) * 2.2 * dt;
        keyPitch = ((down(mb.lookUp) ? 1 : 0) - (down(mb.lookDown) ? 1 : 0)) * 1.4 * dt;
      }
      // Gamepad look sensitivity scaling relative to mouse sensitivity
      const gpSensRatio = (settings.gamepad?.lookSensitivity ?? 1) / Math.max(0.2, settings.sensitivity || 1);
      const [, , rx, ry] = prevPadAxes;
      const extraGpYaw = rx * 2.6 * settings.sensitivity * (gpSensRatio - 1) * dt;
      const extraGpPitch = -ry * 2.6 * 0.7 * settings.sensitivity * (gpSensRatio - 1) * dt * (settings.invertY ? -1 : 1);

      const touchLook = api._touchState?.consumeLook?.() ?? { yaw: 0, pitch: 0 };
      const rawYaw = base.yaw + keyYaw + extraGpYaw + (touchLook.yaw || 0);
      const rawPitch = base.pitch + keyPitch + extraGpPitch + (touchLook.pitch || 0);

      const sm = settings.camera?.mouseSmoothing ?? 0;
      if (sm <= 0.01) return { yaw: rawYaw, pitch: rawPitch };
      smoothYaw = smoothYaw * sm + rawYaw * (1 - sm);
      smoothPitch = smoothPitch * sm + rawPitch * (1 - sm);
      return { yaw: smoothYaw, pitch: smoothPitch };
    };
  }

  // Camera presentation viewTransform: head bob scaling + subtle camera recoil on weapon swings (never alters server physics).
  if (Array.isArray(api.viewTransforms)) {
    let bobPhase = 0;
    api.viewTransforms.push((camera, { dt = 0.016, moving = false } = {}) => {
      const camPrefs = settings.camera ?? DEFAULT_CAMERA_PREFS;
      let nextY = camera.y;
      let nextPitch = camera.pitch;
      // Main.js applies a 1.0x bob of 0.035m; adjust delta cleanly so headBob=0 flattens bob and headBob=1.5 enhances it.
      if (moving && camPrefs.headBob !== 1) {
        bobPhase += dt * 11;
        nextY += Math.sin(bobPhase) * 0.025 * (camPrefs.headBob - 1);
      }
      if (Math.abs(recoilPitch) > 0.0005) {
        nextPitch += recoilPitch;
        recoilPitch *= Math.max(0, 1 - dt * 14);
      } else {
        recoilPitch = 0;
      }
      if (nextY === camera.y && nextPitch === camera.pitch) return camera;
      return { ...camera, y: nextY, pitch: nextPitch };
    });
  }

  api.on('event', (ev) => {
    const e = ev?.event ?? ev;
    if (e?.kind === 'swing' && String(e.playerId) === String(api.selfId)) {
      const recoil = settings.camera?.cameraRecoil ?? 1;
      if (recoil > 0) recoilPitch = Math.min(0.08, recoilPitch + 0.028 * recoil);
    }
  });

  // ---------------------------------------------------- panels: built-in fallbacks

  const WATCH_ALL = new Set(['map', 'party', 'interaction']);
  for (const p of PANELS) {
    api.registerPanel(p.id, p.title, builtinPanels[p.id], { builtin: true, key: p.key, watch: WATCH_ALL.has(p.id) ? 'all' : p.id === 'settings' ? 'none' : 'character' });
  }
  api._dialogue = dialogue;
  api._shellContext = {
    settings,
    apply: () => { saveSettings(settings); applySettings(); renderTabs(); updateBar(); updateHelp(); updateTarget(); renderPanel(); api.emit('settingsChanged', settings); },
    startRebind: (action, kind = 'action') => { rebinding = { kind, action }; },
    isHudEditMode: () => hudEditMode,
    setHudEditMode: (on) => { hudEditMode = !!on; syncHudEditMode(); renderPanel(); },
    resetHudLayout: () => { settings.hudLayout = {}; saveSettings(settings); applyHudLayout(); renderPanel(); },
    leave: () => { closePanel({ force: true }); actions.leave?.(); },
  };

  const isWizardLocked = () => ui.menu.dataset.wizard === 'true' || api.state?.character?.character?.created === false;

  // ---------------------------------------------------- open / close / render

  const bindingFor = (id, fallback) => (id in settings.bindings ? settings.bindings[id] : fallback);

  function renderTabs() {
    const layout = menuLayout(api.panels());
    const current = open ? categoryFor(layout, open) : null;
    ui.tabs.replaceChildren(...layout.categories.map((c) => {
      const selected = c === current;
      const code = bindingFor(c.pages[0].id, c.pages[0].key ?? c.key);
      return h('button', {
        type: 'button', role: 'tab', id: `menu-cat-${c.id}`, class: 'menu-tab',
        'aria-selected': String(selected), 'aria-controls': 'menu-panel',
        tabindex: selected || (!current && c === layout.categories[0]) ? '0' : '-1',
        dataset: { category: c.id, panel: c.pages[0].id },
        onclick: () => openCategory(c.id),
      }, h('span', { class: 'menu-tab-name', text: t(`menu.${c.id}`, null, { fallback: c.title }) }), code ? h('kbd', { text: keyLabel(code) }) : null);
    }));

    // Sub-tabs: the pages of the open category, or a lone marker for a page the world opened.
    const contextual = open && !current ? api.getPanel(open) : null;
    const subs = current ? (current.pages.length > 1 ? current.pages : []) : contextual ? [contextual] : [];
    ui.subtabs.replaceChildren(...subs.map((p) => h('button', {
      type: 'button', role: 'tab', id: `menu-tab-${p.id}`, class: 'menu-subtab',
      'aria-selected': String(p.id === open), 'aria-controls': 'menu-panel',
      tabindex: p.id === open ? '0' : '-1', dataset: { panel: p.id, contextual: contextual ? 'true' : null },
      onclick: () => openPanel(p.id),
    }, h('span', { class: 'menu-tab-name', text: p.title }))));
    ui.subtabs.hidden = !subs.length;
    ui.subtabs.dataset.contextual = contextual ? 'true' : 'false';
    ui.menu.dataset.category = current?.id ?? (contextual ? 'contextual' : '');

    for (const strip of [ui.tabs, ui.subtabs]) {
      const sel = strip.querySelector('[aria-selected="true"]');
      if (sel && strip.scrollWidth > strip.clientWidth) sel.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    updateBar();
  }

  /** Open a category on the page last visited there, else its first page. */
  function openCategory(catId) {
    const c = menuLayout(api.panels()).categories.find((x) => x.id === catId);
    if (!c) return;
    const last = lastInCategory.get(catId);
    openPanel(c.pages.some((p) => p.id === last) ? last : c.pages[0].id);
  }

  /** The tab that names the open page: its sub-tab when shown, else its category tab. */
  function selectedTab() {
    return (!ui.subtabs.hidden && ui.subtabs.querySelector('[aria-selected="true"]'))
      || ui.tabs.querySelector('[aria-selected="true"]') || null;
  }

  /** Pages in menu order, for gamepad LB/RB cycling (contextual pages are not in the cycle). */
  function menuPages() {
    return menuLayout(api.panels()).categories.flatMap((c) => c.pages);
  }

  function renderPanel({ keepFocus = true } = {}) {
    if (!open) return;
    const p = api.getPanel(open);
    if (!p) return;
    const fkey = keepFocus ? focusKey(document.activeElement, ui.panel) : null;
    const scroll = ui.panel.scrollTop;
    const edited = keepFocus ? editedFields(ui.panel) : [];
    openKey = watchKey(p, api.state);
    ui.title.textContent = p.title;
    const tab = selectedTab();
    if (tab) ui.panel.setAttribute('aria-labelledby', tab.id); else ui.panel.removeAttribute('aria-labelledby');
    ui.panel.dataset.panel = p.id;
    const body = h('div', { class: `panel-body panel-${p.id}` });
    try {
      p.render(body, api);
    } catch (err) {
      console.error(`[gameplay] panel ${p.id} failed:`, err);
      body.replaceChildren(h('p', { class: 'menu-error', role: 'alert', text: `This page could not be drawn: ${err.message}` }));
    }
    ui.panel.replaceChildren(body);
    // Character creation is a mandatory focused dialog: hide tabs and close controls until finished.
    const inWizard = Boolean(body.querySelector('.cc-wizard') || body.classList.contains('cc-wizard') || api.state?.character?.character?.created === false);
    if (inWizard) ui.menu.dataset.wizard = 'true';
    else delete ui.menu.dataset.wizard;
    if (ui.topbar) ui.topbar.hidden = inWizard;
    if (ui.hint) ui.hint.hidden = inWizard;
    ui.close.hidden = inWizard;
    ui.close.disabled = inWizard;
    restoreEdited(edited, ui.panel);
    ui.panel.scrollTop = scroll;
    if (fkey) restoreFocus(fkey, ui.panel);
  }

  function openPanel(id, detail) {
    if (isWizardLocked() && id !== 'character') return;
    const first = !open;
    if (first) returnFocus = document.activeElement;
    open = id;
    const cat = CATEGORY_OF.get(id) ?? (CONTEXTUAL.has(id) ? null : categoryFor(menuLayout(api.panels()), id)?.id);
    if (cat) lastInCategory.set(cat, id);
    api._setModal(true, id);
    input.setSuspended(true);
    ui.menu.hidden = false;
    document.body.dataset.menu = id;
    renderTabs();
    renderPanel({ keepFocus: false });
    if (detail !== undefined) api.emit('panelDetail', { id, detail });
    api.emit('panel', { id, open: true });
    // Focus: a control the page marks [autofocus], else its first control that is not a text
    // field (a focused search box would swallow the page hotkeys), else the selected tab.
    const list = focusables(ui.panel);
    const target = list.find((el) => el.hasAttribute('autofocus')) ?? list.find((el) => !isTextField(el)) ?? selectedTab();
    (first || !ui.menu.contains(document.activeElement) ? target : document.activeElement)?.focus({ preventScroll: true });
  }

  function closePanel({ force = false } = {}) {
    if (!open) return;
    if (!force && isWizardLocked()) return;
    const was = open;
    open = null;
    rebinding = null;
    api._setModal(false);
    input.setSuspended(false);
    ui.menu.hidden = true;
    delete document.body.dataset.menu;
    ui.panel.replaceChildren();
    delete ui.menu.dataset.wizard;
    if (ui.topbar) ui.topbar.hidden = false;
    if (ui.hint) ui.hint.hidden = false;
    ui.close.hidden = false;
    ui.close.disabled = false;
    updateBar();
    api.emit('panel', { id: was, open: false });
    const back = returnFocus && document.contains(returnFocus) && returnFocus !== document.body ? returnFocus : $('view');
    returnFocus = null;
    back?.focus?.({ preventScroll: true });
  }

  api._attachShell({
    open: openPanel,
    close: (opts) => closePanel(opts),
    refresh: () => renderPanel(),
    panelsChanged: () => { if (open) renderTabs(); updateBar(); updateHelp(); },
  });

  ui.close.addEventListener('click', () => closePanel());
  ui.menu.addEventListener('pointerdown', (e) => { if (e.target === ui.menu) closePanel(); });

  // Keyboard inside the menu: Tab trap, ←→ Home End on the section and page tabs, Esc closes (except in required wizard).
  ui.menu.addEventListener('keydown', (e) => {
    if (rebinding) return; // handled by the capture listener
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); return; }
    if (e.key === 'Tab') {
      const list = focusables(ui.menu);
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); list.at(-1).focus(); }
      else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
      return;
    }
    const strip = e.target.getAttribute?.('role') === 'tab' ? e.target.closest('[role="tablist"]') : null;
    if (strip && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const tabs = [...strip.querySelectorAll('[role="tab"]')];
      if (!tabs.length) return;
      let i = tabs.indexOf(e.target);
      if (e.key === 'ArrowLeft') i = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
      else if (e.key === 'Home') i = 0;
      else i = tabs.length - 1;
      const t = tabs[i];
      if (strip === ui.tabs) {
        openCategory(t.dataset.category);
        $(`menu-cat-${t.dataset.category}`)?.focus();
      } else {
        openPanel(t.dataset.panel);
        $(`menu-tab-${t.dataset.panel}`)?.focus();
      }
    }
  });

  // Key capture for rebinding in Settings (actions + movement/look).
  window.addEventListener('keydown', (e) => {
    if (!rebinding) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const { kind, action } = typeof rebinding === 'string' ? { kind: 'action', action: rebinding } : rebinding;
    rebinding = null;
    if (e.code === 'Escape') { renderPanel(); return; }
    if (kind === 'move') {
      if (e.code === 'Backspace' || e.code === 'Delete') settings.moveBindings = rebindMove(settings.moveBindings, action, null);
      else {
        try { settings.moveBindings = rebindMove(settings.moveBindings, action, e.code); }
        catch (err) { api.message(err.message, { kind: 'error' }); }
      }
    } else if (e.code === 'Backspace' || e.code === 'Delete') {
      settings.bindings = rebind(settings.bindings, action, null);
    } else {
      try { settings.bindings = rebind(settings.bindings, action, e.code); }
      catch (err) { api.message(err.message, { kind: 'error' }); }
    }
    saveSettings(settings);
    renderTabs();
    renderPanel();
    updateHelp();
    api.emit('settingsChanged', settings);
    $(kind === 'move' ? `mbind-${action}` : `bind-${action}`)?.focus();
  }, true);

  // ---------------------------------------------------- HUD: vitals, bar, target, toasts

  function updateVitals() {
    const v = vitalsOf(api.state);
    for (const name of ['health', 'fatigue', 'magicka']) {
      const row = ui.vitals.querySelector(`[data-vital="${name}"]`);
      if (!row) continue;
      const pair = v[name];
      row.hidden = !pair;
      if (!pair) continue;
      const [cur, max] = pair;
      const pct = Math.max(0, Math.min(100, (cur / max) * 100));
      row.querySelector('.vital-fill').style.width = `${pct}%`;
      row.querySelector('.vital-num').textContent = `${cur} / ${max}`;
      row.setAttribute('aria-valuenow', String(cur));
      row.setAttribute('aria-valuemax', String(max));
      row.setAttribute('aria-valuetext', `${cur} of ${max}`);
      row.dataset.low = String(pct <= 25);
    }
    ui.vitals.hidden = !(v.health || v.fatigue || v.magicka);
  }

  function updateBar() {
    for (const b of ui.bar.querySelectorAll('[data-panel]')) {
      const id = b.dataset.panel;
      b.setAttribute('aria-pressed', String(open === id));
      b.hidden = !api.getPanel(id);
      const kbd = b.querySelector('kbd');
      const code = settings.bindings[id];
      if (kbd) kbd.textContent = code ? keyLabel(code) : '';
    }
    for (const b of ui.bar.querySelectorAll('[data-action]')) {
      const kbd = b.querySelector('kbd');
      const code = settings.bindings[b.dataset.action];
      if (kbd) kbd.textContent = code ? keyLabel(code) : '';
    }
    const readied = readiedOf(api.state);
    ui.readyBtn.setAttribute('aria-pressed', String(readied));
    ui.readyBtn.querySelector('.bar-name').textContent = readied ? 'Sheathe' : 'Ready';
    document.body.toggleAttribute('data-readied', readied);
    ui.menuBtn.setAttribute('aria-expanded', String(!!open));
  }

  // Mouse clicks on the bar must not leave focus on a button, or Space would press it again.
  ui.bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  ui.bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.panel) api.togglePanel(b.dataset.panel);
    else if (b.dataset.action) actions[b.dataset.action]?.();
    else if (b === ui.menuBtn) (open ? closePanel() : openPanel('character'));
  });

  function updateTarget() {
    const e = api.entity(api.target);
    // The Use button names what it will do to the current target (Talk, Loot, Revive…).
    const useName = ui.useBtn?.querySelector('.bar-name');
    const useText = e ? useLabel(e) : 'Use';
    if (useName && useName.textContent !== useText) useName.textContent = useText;
    if (!e || !settings.showTarget) { ui.target.hidden = true; return; }
    const parts = [e.name || e.kind || 'Someone'];
    if (Number.isFinite(e.hp) && Number.isFinite(e.maxHp)) parts.push(`${Math.max(0, Math.round(e.hp))} / ${Math.round(e.maxHp)}`);
    const verb = interactionFor(e);
    const mode = api.activationMode && api.activationMode !== 'grab' ? ` · ${api.activationMode[0].toUpperCase()}${api.activationMode.slice(1)}` : '';
    const hint = e.kind === 'monster' && !(e.hp <= 0) ? keyLabel(settings.bindings.attack)
      : verb || mode ? `${keyLabel(settings.bindings.interact)}${mode}` : '';
    const sub = parts[1] ?? (e.title || (e.kind === 'player' ? 'Traveller' : ''));
    ui.target.replaceChildren(...[
      h('span', { class: 'target-name', text: parts[0] }),
      sub ? h('span', { class: 'target-hp', text: sub }) : null,
      hint ? h('kbd', { text: hint }) : null,
    ].filter(Boolean));
    ui.target.dataset.kind = e.kind || '';
    ui.target.hidden = false;
  }

  function toast(text, { kind = 'info', ttl = 5000, event, onclick } = {}) {
    const icons = Array.isArray(event?.artItems) ? event.artItems.slice(0, 4).map((item) => itemIcon(api, item)) : [];
    const attrs = { class: `toast toast-${kind}${onclick ? ' toast-action' : ''}` };
    if (typeof onclick === 'function') {
      attrs.role = 'button';
      attrs.tabindex = '0';
      attrs.onclick = () => { li.remove(); onclick(); };
      attrs.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.remove(); onclick(); } };
    }
    const li = h('li', attrs, icons, text);
    ui.toasts.append(li);
    while (ui.toasts.children.length > 4) ui.toasts.firstElementChild.remove();
    setTimeout(() => { li.classList.add('toast-out'); setTimeout(() => li.remove(), 400); }, ttl);
  }

  function updateHelp() {
    if (!ui.helpDl) return;
    const b = settings.bindings;
    const mb = settings.moveBindings || DEFAULT_MOVE_BINDINGS;
    const keys = (...codes) => codes.filter(Boolean).map(keyLabel).join(' ');
    const rows = [
      [keys(mb.moveForward, mb.strafeLeft, mb.moveBack, mb.strafeRight), 'Move'],
      [`${keys(mb.turnLeft, mb.turnRight)} · ${keys(mb.turnLeftAlt, mb.turnRightAlt)}`, 'Turn'],
      [keys(mb.lookUp, mb.lookDown), 'Look up / down'],
      ['Click view', 'Capture mouse to look · Esc releases'], ['Touch drag', 'Look'],
      [`${keys(b.run)} · ${keys(b.slow)}`, 'Run · walk slowly (hold)'],
      [keys(b.jump), 'Jump · swim up'], [keys(b.crouch), 'Crouch · dive'],
      ['Hold W into a wall (or jump)', 'Climb'],
      [keys(b.ready), 'Ready / sheathe weapon'],
      [`${keys(b.attack)} · Click`, 'Attack'], ['Right-drag', 'Directional strike'],
      ['1 – 8', 'Quickslots (weapons & consumables)'],
      [keys(b.interact), 'Talk · use · loot'],
      [keys(b.modeSteal, b.modeGrab, b.modeInfo, b.modeTalk), 'Steal · Grab · Info · Talk mode'],
      ...(api.getPanel('spellbook')?.builtin === false ? [['V', 'Cast readied spell']] : []),
      [keys(b.character, b.inventory, b.spellbook, b.journal), 'Character · Inventory · Magic · Journal'],
      [keys(b.map, b.party), 'Maps · Social'],
      ...api.panels().filter(p => !p.builtin && p.key && !(p.id in b) && !Object.values(b).includes(p.key)).map(p => [keyLabel(p.key), p.title]),
      [`Esc · ${keys(b.settings)}`, 'Close menus · System'],
      [`Enter · ${keys(b.chat)}`, 'Speak'],
      [keys(b.people), 'People here'],
      ['Gamepad', `${GAMEPAD_BUTTON_NAMES[settings.gamepad?.buttons?.menu ?? PAD.START]} menu · ${GAMEPAD_BUTTON_NAMES[settings.gamepad?.buttons?.interact ?? PAD.A]} use · ${GAMEPAD_BUTTON_NAMES[settings.gamepad?.buttons?.attack ?? PAD.X]} attack · ${GAMEPAD_BUTTON_NAMES[settings.gamepad?.buttons?.ready ?? PAD.Y]} ready`],
    ];
    ui.helpDl.replaceChildren(...rows.flatMap(([k, d]) => [h('dt', { text: k }), h('dd', { text: d })]));
  }

  // ---------------------------------------------------- gamepad navigation inside menus

  function padNav(pressed) {
    if (!open) return false;
    const gb = settings.gamepad?.buttons ?? DEFAULT_GAMEPAD_SETTINGS.buttons;
    if (pressed.has(gb.cancel ?? PAD.B) || pressed.has(gb.menu ?? PAD.START)) { closePanel(); return true; }
    if (pressed.has(PAD.LB) || pressed.has(PAD.RB)) {
      const list = menuPages();
      if (!list.length) return true;
      const step = pressed.has(PAD.RB) ? 1 : -1;
      let i = list.findIndex((p) => p.id === open);
      i = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length;
      openPanel(list[i].id);
      return true;
    }
    const step = pressed.has(PAD.DOWN) || pressed.has(PAD.RIGHT) ? 1 : pressed.has(PAD.UP) || pressed.has(PAD.LEFT) ? -1 : 0;
    if (step) {
      const el = document.activeElement;
      if (el?.type === 'range' && (pressed.has(PAD.LEFT) || pressed.has(PAD.RIGHT))) {
        if (pressed.has(PAD.RIGHT)) el.stepUp(); else el.stepDown();
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const list = focusables(ui.menu);
      const i = list.indexOf(el);
      list[(i + step + list.length) % list.length]?.focus();
      return true;
    }
    if (pressed.has(gb.interact ?? PAD.A)) {
      const el = document.activeElement;
      if (el && ui.menu.contains(el)) el.click();
      return true;
    }
    return false;
  }

  // ---------------------------------------------------- subscriptions

  api.on('state', () => {
    updateVitals();
    updateBar();
    updateTarget();
    // Only re-render when what the open page watches changed (entity-only updates leave a
    // character or inventory page alone, so typing, focus and scroll are undisturbed).
    if (open && watchKey(api.getPanel(open), api.state) !== openKey) renderPanel();
  });
  // Remember which fields the player changed so a re-render can keep their input.
  ui.panel.addEventListener('input', (e) => { if (e.target.matches?.('input, textarea, select')) e.target.dataset.userEdited = '1'; });
  ui.panel.addEventListener('change', (e) => { if (e.target.matches?.('input, textarea, select')) e.target.dataset.userEdited = '1'; });
  api.on('frame', () => {
    const m = api.movement;
    const visible = m?.underwater && !m.waterBreathing && !api.character?.defeated && Number.isFinite(m.breath) && m.maxBreath > 0;
    if (!visible) {
      if (!ui.breath.hidden) ui.breath.hidden = true;
      return;
    }
    const seconds = String(Math.ceil(Math.max(0, Math.min(m.breath, m.maxBreath))));
    const max = String(m.maxBreath);
    if (ui.breath.hidden || ui.breath.getAttribute('aria-valuenow') !== seconds || ui.breath.getAttribute('aria-valuemax') !== max) {
      ui.breath.hidden = false;
      ui.breath.setAttribute('aria-valuenow', seconds);
      ui.breath.setAttribute('aria-valuemax', max);
      ui.breath.setAttribute('aria-valuetext', seconds + ' seconds');
      ui.breath.firstElementChild.style.height = (Number(seconds) / m.maxBreath * 100) + '%';
    }
    ui.breath.classList.toggle('low', m.lowBreath);
  });
  api.on('target', updateTarget);
  api.on('event', (ev) => {
    if (typeof ev?.text === 'string' && ev.text && ['talk', 'dialogue', 'say', 'npc'].includes(ev.kind)) {
      dialogue.push({ who: ev.name || ev.speaker || api.entity(ev.entityId ?? ev.targetId)?.name || '', text: ev.text, id: String(ev.entityId ?? ev.targetId ?? '') });
      while (dialogue.length > 30) dialogue.shift();
      if (open === 'interaction') renderPanel();
    }
  });
  api.on('location', () => { dialogue.length = 0; ui.breath.hidden = true; });

  // ---- Movable HUD layout (drag widgets when HUD edit mode is active; works with docked & scaled layouts)
  let hudDrag = null;
  let hudEditBanner = null;

  function applyHudLayout() {
    const layout = settings.hudLayout ?? {};
    for (const w of MOVABLE_HUD_WIDGETS) {
      const node = $(w.id);
      if (!node) continue;
      const pos = layout[w.key];
      if (pos && (pos.x || pos.y)) {
        node.style.translate = `${pos.x}px ${pos.y}px`;
        node.dataset.hudMoved = 'true';
      } else {
        node.style.translate = '';
        delete node.dataset.hudMoved;
      }
    }
  }

  function syncHudEditMode() {
    document.body.dataset.hudEdit = hudEditMode ? 'true' : 'false';
    if (hudEditMode) {
      if (!hudEditBanner) {
        const hud = $('hud');
        if (hud) {
          hudEditBanner = h('div', { id: 'hud-edit-banner', class: 'hud-edit-banner', role: 'status' },
            h('span', { text: t('hud.layoutEditOn') }),
            h('button', { type: 'button', class: 'btn btn-small', onclick: () => { settings.hudLayout = {}; saveSettings(settings); applyHudLayout(); }, text: t('settings.hudReset') }),
            h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => { hudEditMode = false; syncHudEditMode(); }, text: 'Done' }));
          hud.append(hudEditBanner);
        }
      }
      if (hudEditBanner) hudEditBanner.hidden = false;
    } else if (hudEditBanner) {
      hudEditBanner.hidden = true;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', (e) => {
      if (!hudEditMode || e.button !== 0) return;
      const hit = MOVABLE_HUD_WIDGETS.find((w) => {
        const node = $(w.id);
        return node && (e.target === node || node.contains(e.target));
      });
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = settings.hudLayout?.[hit.key] ?? { x: 0, y: 0 };
      hudDrag = { key: hit.key, startX: e.clientX, startY: e.clientY, baseX: cur.x, baseY: cur.y, id: e.pointerId };
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!hudDrag || e.pointerId !== hudDrag.id) return;
      const dx = e.clientX - hudDrag.startX;
      const dy = e.clientY - hudDrag.startY;
      const maxX = Math.max(240, Math.round((window.innerWidth || 1280) * 0.45));
      const maxY = Math.max(180, Math.round((window.innerHeight || 800) * 0.42));
      settings.hudLayout = { ...(settings.hudLayout ?? {}), [hudDrag.key]: clampHudOffset(hudDrag.baseX + dx, hudDrag.baseY + dy, { maxX, maxY }) };
      applyHudLayout();
    });
    const endHudDrag = (e) => {
      if (!hudDrag || e.pointerId !== hudDrag.id) return;
      hudDrag = null;
      saveSettings(settings);
    };
    window.addEventListener('pointerup', endHudDrag);
    window.addEventListener('pointercancel', endHudDrag);
  }

  applySettings();
  updateVitals();
  updateBar();
  updateHelp();

  function applySettings() {
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    const cam = settings.camera ?? DEFAULT_CAMERA_PREFS;
    api.cameraPrefs = { ...cam };
    try { globalThis.localStorage?.setItem('fpWeapon.bowDrawback', cam.bowDrawback ? '1' : '0'); } catch { /* ignore */ }
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale));
    document.body.dataset.classicCompass = settings.classicCompass ? 'true' : 'false';
    document.body.dataset.handedness = cam.handedness === 'left' ? 'left' : 'right';
    document.body.dataset.touchControls = settings.touchControls ? 'true' : 'false';
    setLocale(settings.locale ?? DEFAULT_LOCALE, { persist: true });
    applyLocaleToDocument(document, settings.locale ?? DEFAULT_LOCALE);
    if (ui.close) ui.close.textContent = t('menu.close');
    applyHudLayout();
  }

  return {
    open: openPanel, close: closePanel, toast, padNav, updateTarget, updateBar, applyHudLayout,
    get isOpen() { return !!open; },
    get openId() { return open; },
    get rebinding() { return !!rebinding; },
  };
}

// Built-in panels receive (container, api). Settings reads the live shell context from
// api._shellContext; Interaction reads recent dialogue lines from api._dialogue.
const builtinPanels = {
  character(el, api) {
    const s = statsOf(api.state);
    if (!s) {
      el.append(h('p', { class: 'menu-empty', text: 'Your character record has not arrived yet. It appears here once the server sends it.' }));
      return;
    }
    const c = api.state.character;
    const name = s.name || c?.name || api.account?.username || '';
    el.append(h('header', { class: 'sheet-head' },
      h('h3', { text: name || 'Your character' }),
      h('p', { class: 'sheet-sub', text: [s.race, s.className, Number.isFinite(s.level) ? `Level ${s.level}` : null].filter(Boolean).join(' · ') }),
    ));
    const v = vitalsOf(api.state);
    el.append(h('dl', { class: 'sheet-vitals' },
      ...['health', 'fatigue', 'magicka'].flatMap((k) => (v[k] ? [h('dt', { text: k[0].toUpperCase() + k.slice(1) }), h('dd', { text: `${v[k][0]} / ${v[k][1]}` })] : [])),
      Number.isFinite(c?.gold) ? [h('dt', { text: 'Gold' }), h('dd', { text: String(c.gold) })] : [],
    ));
    if (s.attributes && typeof s.attributes === 'object') {
      el.append(h('h4', { text: 'Attributes' }), h('dl', { class: 'sheet-grid' },
        ...Object.entries(s.attributes).flatMap(([k, val]) => [h('dt', { text: k }), h('dd', { text: String(val) })])));
    }
    if (s.skills && typeof s.skills === 'object') {
      const skills = Object.entries(s.skills).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
      el.append(h('h4', { text: 'Skills' }), h('dl', { class: 'sheet-grid sheet-skills' },
        ...skills.flatMap(([k, val]) => [h('dt', { text: k }), h('dd', { text: String(typeof val === 'object' ? val.value ?? '' : val) })])));
    }
  },

  inventory(el, api) {
    const c = api.state?.character;
    const items = Array.isArray(c?.inventory) ? c.inventory : [];
    const equipped = new Map(Object.entries(c?.equipment ?? {}).map(([slot, id]) => [String(id), slot]));
    el.append(h('p', { class: 'sheet-sub', text: `Gold: ${Number.isFinite(c?.gold) ? c.gold : 0}` }));
    if (!items.length) { el.append(h('p', { class: 'menu-empty', text: 'You carry nothing.' })); return; }
    el.append(h('ul', { class: 'item-list' }, ...items.map((it) => {
      const slot = equipped.get(String(it.id));
      return h('li', { class: 'item-row', dataset: { equipped: String(!!slot) } },
        h('span', { class: 'item-name', text: `${it.name ?? it.template}${it.quantity > 1 ? ` ×${it.quantity}` : ''}` }),
        h('span', { class: 'item-slot', text: slot ? `Equipped: ${slot}` : (it.slot ? it.slot : '') }),
        h('span', { class: 'item-actions' },
          it.slot || slot ? h('button', {
            type: 'button', class: 'btn btn-small', 'data-focus-key': `eq-${it.id}`,
            onclick: () => api.act(slot ? 'inventory.unequip' : 'inventory.equip', slot ? { slot, itemId: String(it.id) } : { itemId: String(it.id) }),
            text: slot ? 'Unequip' : 'Equip',
          }) : null,
          it.usable || it.consumable ? h('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': `use-${it.id}`, onclick: () => api.act('inventory.use', { itemId: String(it.id) }), text: 'Use' }) : null,
        ));
    })));
  },

  spellbook(el, api) {
    const c = api.state?.character;
    const m = c?.magic;
    const known = Array.isArray(m?.known) ? m.known : [];
    const names = new Map((api._spellCatalogue ?? []).map((sp) => [String(sp.id), sp]));
    const v = vitalsOf(api.state).magicka;
    if (v) el.append(h('p', { class: 'sheet-sub', text: `Magicka ${v[0]} / ${v[1]}` }));
    if (!known.length) { el.append(h('p', { class: 'menu-empty', text: 'You know no spells yet. Spells are learned from guilds and spellmakers.' })); return; }
    el.append(h('ul', { class: 'item-list' }, ...known.map((id) => {
      const sp = names.get(String(id));
      return h('li', { class: 'item-row', dataset: { selected: String(String(m.selected) === String(id)) } },
        h('span', { class: 'item-name', text: sp?.name ?? String(id) }),
        h('span', { class: 'item-slot', text: Number.isFinite(sp?.cost) ? `${sp.cost} magicka` : '' }),
        h('span', { class: 'item-actions' }, h('button', {
          type: 'button', class: 'btn btn-small', 'data-focus-key': `cast-${id}`,
          onclick: () => { api.closePanel(); api.act('magic.cast', { spellId: String(id), ...(api.target ? { targetId: api.target } : {}) }); },
          text: 'Cast',
        })));
    })));
  },

  journal(el, api) {
    const q = api.state?.character?.quests;
    if (!api.state?.character) { el.append(h('p', { class: 'menu-empty', role: 'status', text: 'Your journal appears here once your character has loaded.' })); return; }
    // Server journal v1: {v:1, active:[], done:[{result}], offer}. Older shapes: array or id→quest map.
    const list = q?.v === 1
      ? [...(Array.isArray(q.active) ? q.active : []), ...(Array.isArray(q.done) ? q.done.map((d) => ({ ...d, status: d.result === 'success' ? 'completed' : d.result === 'failed' ? 'failed' : 'done', log: d.log })) : [])]
      : Array.isArray(q) ? q : q && typeof q === 'object' ? Object.entries(q).map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : {}) })) : [];
    if (q === undefined) { el.append(h('p', { class: 'menu-empty', role: 'status', text: 'This server has not sent a quest journal.' })); return; }
    if (!list.length) { el.append(h('p', { class: 'menu-empty', text: 'Your journal is empty. Speak with the townsfolk to find work.' })); return; }
    const active = list.filter((x) => !['done', 'complete', 'completed', 'failed'].includes(x.status));
    const done = list.filter((x) => !active.includes(x));
    const section = (title, items) => items.length ? [h('h4', { text: title }), h('ul', { class: 'quest-list' }, ...items.map((x) => h('li', { class: 'quest' },
      h('strong', { text: x.title ?? x.name ?? x.id }),
      x.status ? h('span', { class: 'quest-status', text: x.status }) : null,
      ...(Array.isArray(x.log) ? x.log.slice(-4).map((l) => h('p', { text: typeof l === 'string' ? l : l.text ?? '' })) : []),
      x.objective ? h('p', { class: 'quest-objective', text: x.objective }) : null,
    )))] : [];
    el.append(...section('Current', active), ...section('Finished', done));
  },

  map(el, api) {
    const loc = api.location;
    const parts = String(loc ?? '').replace(/^[a-z]+:/i, '').split('/').filter(Boolean);
    const subtitle = /^\d+$/.test(parts[0]) ? REGION_NAMES[Number(parts[0])] : parts.slice(0, -1).join(' · ');
    el.append(h('header', { class: 'sheet-head' },
      h('h3', { text: locationName(loc, api.character?.wilderness, api.town, api.character?.portal) || 'Unknown place' }),
      h('p', { class: 'sheet-sub', text: subtitle || 'Iliac Bay' }),
    ));
    const cam = api.camera;
    if (cam) {
      const deg = ((cam.yaw * 180) / Math.PI + 360) % 360;
      el.append(h('dl', { class: 'sheet-vitals' },
        h('dt', { text: 'Position' }), h('dd', { text: `${cam.x.toFixed(0)}, ${(-cam.z).toFixed(0)}` }),
        h('dt', { text: 'Facing' }), h('dd', { text: `${Math.round(deg)}°` }),
      ));
    }
    const here = targetables(api.state, api.selfId);
    el.append(h('h4', { text: 'Here with you' }));
    if (!here.length) el.append(h('p', { class: 'menu-empty', text: 'No one else is nearby.' }));
    else el.append(h('ul', { class: 'item-list' }, ...here.slice(0, 40).map((e) => h('li', { class: 'item-row' },
      h('span', { class: 'item-name', text: e.name || e.kind }),
      h('span', { class: 'item-slot', text: e.kind }),
      h('span', { class: 'item-actions', text: cam ? `${Math.round(Math.hypot(e.x - cam.x, e.z - cam.z))} m` : '' }),
    ))));
  },

  party(el, api) {
    const c = api.state?.character;
    const peers = (api.state?.peers ?? []).filter((p) => String(p.id) !== String(api.selfId));
    const members = new Set((c?.party?.members ?? []).map((m) => String(m && typeof m === 'object' ? m.id : m)));
    const memberNames = new Map((c?.party?.members ?? []).filter((m) => m && typeof m === 'object').map((m) => [String(m.id), m.name]));
    if (members.size) {
      el.append(h('h4', { text: 'Your party' }), h('ul', { class: 'item-list' }, ...[...members].map((id) => {
        const p = peers.find((x) => String(x.id) === id);
        return h('li', { class: 'item-row' }, h('span', { class: 'item-name', text: p?.name ?? memberNames.get(id) ?? `Traveller ${id}` }));
      })), h('button', { type: 'button', class: 'btn', onclick: () => api.act('party.leave'), text: 'Leave party' }));
    }
    el.append(h('h4', { text: 'Travellers here' }));
    if (!peers.length) { el.append(h('p', { class: 'menu-empty', text: 'No other players are in this place.' })); return; }
    el.append(h('ul', { class: 'item-list' }, ...peers.map((p) => h('li', { class: 'item-row', dataset: { selected: String(String(p.id) === api.target) } },
      h('span', { class: 'item-name', text: p.name }),
      h('span', { class: 'item-slot', text: members.has(String(p.id)) ? 'In your party' : '' }),
      h('span', { class: 'item-actions' },
        !members.has(String(p.id)) ? h('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': `inv-${p.id}`, onclick: () => api.act('party.invite', { targetId: String(p.id) }), text: 'Invite' }) : null,
        h('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': `trade-${p.id}`, onclick: () => api.act('trade.request', { targetId: String(p.id) }), text: 'Trade' }),
      ),
    ))));
  },

  interaction(el, api) {
    const e = api.entity(api.target);
    if (!e) {
      el.append(h('p', { class: 'menu-empty', text: 'Face someone or something and press the interact key to talk, trade or loot.' }));
      return;
    }
    el.append(h('header', { class: 'sheet-head' },
      h('h3', { text: e.name || e.kind }),
      h('p', { class: 'sheet-sub', text: [e.role, e.kind].filter(Boolean).join(' · ') }),
    ));
    const lines = api._dialogue?.filter((l) => !l.id || l.id === String(e.id)) ?? [];
    if (lines.length) el.append(h('ol', { class: 'dialogue', 'aria-live': 'polite' }, ...lines.slice(-12).map((l) => h('li', {}, l.who ? h('strong', { text: `${l.who}: ` }) : null, l.text))));
    const buttons = [];
    const it = interactionFor(e);
    if (e.kind === 'npc') buttons.push(['Talk', () => api.act('npc.talk', { targetId: String(e.id) })]);
    else if (e.kind === 'loot') {
      buttons.push(['Search', () => api.act('inventory.inspectLoot', { targetId: String(e.id) })]);
      buttons.push(['Take all', () => api.act('inventory.loot', { targetId: String(e.id) })]);
    } else if (it?.verb) {
      const label = it.verb === 'combat.loot' ? 'Search remains' : it.verb === 'combat.revive' ? 'Revive' : 'Use';
      buttons.push([label, () => api.act(it.verb, it.args)]);
    }
    if (e.kind === 'player') buttons.push(['Party and trade', () => api.openPanel('party')]);
    if (e.kind === 'monster' && !(e.hp <= 0)) buttons.push(['Attack', () => { api.closePanel(); api.act('combat.attack', { targetId: String(e.id) }); }]);
    el.append(h('div', { class: 'menu-actions' }, ...buttons.map(([t, fn], i) => h('button', { type: 'button', class: i ? 'btn' : 'btn btn-primary', 'data-focus-key': `ia-${t}`, onclick: fn, text: t }))));
  },

  settings(el, api) {
    const ctx = api._shellContext;
    if (!ctx) return;
    const { settings, apply, startRebind, leave, isHudEditMode, setHudEditMode, resetHudLayout } = ctx;
    settings.camera = normalizeCameraPrefs(settings.camera);
    settings.gamepad = normalizeGamepadSettings(settings.gamepad);
    settings.moveBindings = normalizeMoveBindings(settings.moveBindings);

    const field = (label, control) => h('label', { class: 'setting' }, h('span', { class: 'setting-name', text: label }), control);
    const range = (id, min, max, step, value, on) => h('input', {
      id, type: 'range', min, max, step, value,
      oninput: (ev) => { on(Number(ev.target.value)); ev.target.nextElementSibling && (ev.target.nextElementSibling.textContent = Number(ev.target.value).toFixed(2)); },
      onchange: () => apply(),
    });
    const check = (id, value, on) => h('input', { id, type: 'checkbox', class: 'setting-check', checked: value, onchange: (ev) => { on(ev.target.checked); apply(); } });
    const toggle = (label, control) => h('label', { class: 'setting setting-toggle' }, control, h('span', { class: 'setting-name', text: label }));
    const card = (id, title, ...body) => h('section', { class: `settings-card settings-${id}`, 'aria-labelledby': `settings-h-${id}` },
      h('h4', { id: `settings-h-${id}`, text: title }), ...body);

    const grid = h('div', { class: 'settings-grid' });

    // 1. Controls & Look
    grid.append(
      card('controls', t('settings.controls'),
        field(t('settings.sensitivity'), h('span', { class: 'setting-range' },
          range('set-sens', 0.2, 3, 0.05, settings.sensitivity, (v) => { settings.sensitivity = v; }),
          h('output', { for: 'set-sens', text: settings.sensitivity.toFixed(2) }))),
        toggle(t('settings.invertY'), check('set-invert', settings.invertY, (v) => { settings.invertY = v; })),
        toggle(t('settings.clickAttack'), check('set-click', settings.clickAttack, (v) => { settings.clickAttack = v; })),
        field(t('settings.mouseSmoothing'), h('span', { class: 'setting-range' },
          range('set-smooth', 0, 0.85, 0.05, settings.camera.mouseSmoothing, (v) => { settings.camera.mouseSmoothing = v; }),
          h('output', { for: 'set-smooth', text: settings.camera.mouseSmoothing.toFixed(2) }))),
        field(t('settings.movementAccel'), h('span', { class: 'setting-range' },
          range('set-accel', 0.25, 1, 0.05, settings.camera.movementAcceleration, (v) => { settings.camera.movementAcceleration = v; }),
          h('output', { for: 'set-accel', text: settings.camera.movementAcceleration.toFixed(2) })))),

      // 2. Camera & Weapon Preferences
      card('camera', t('settings.cameraWeapon'),
        field(t('settings.headBob'), h('span', { class: 'setting-range' },
          range('set-bob', 0, 1.5, 0.05, settings.camera.headBob, (v) => { settings.camera.headBob = v; }),
          h('output', { for: 'set-bob', text: settings.camera.headBob.toFixed(2) }))),
        field(t('settings.cameraRecoil'), h('span', { class: 'setting-range' },
          range('set-recoil', 0, 1.5, 0.05, settings.camera.cameraRecoil, (v) => { settings.camera.cameraRecoil = v; }),
          h('output', { for: 'set-recoil', text: settings.camera.cameraRecoil.toFixed(2) }))),
        field(t('settings.weaponGesture'), h('span', { class: 'setting-range' },
          range('set-gesture', 0.4, 2.5, 0.05, settings.camera.weaponGestureSensitivity, (v) => { settings.camera.weaponGestureSensitivity = v; }),
          h('output', { for: 'set-gesture', text: settings.camera.weaponGestureSensitivity.toFixed(2) }))),
        field(t('settings.handedness'), h('select', {
          id: 'set-handedness', class: 'setting-select',
          onchange: (ev) => { settings.camera.handedness = ev.target.value === 'left' ? 'left' : 'right'; apply(); },
        },
          h('option', { value: 'right', selected: settings.camera.handedness !== 'left', text: t('settings.handednessRight') }),
          h('option', { value: 'left', selected: settings.camera.handedness === 'left', text: t('settings.handednessLeft') }))),
        toggle(t('settings.bowDrawback'), check('set-bow-draw', settings.camera.bowDrawback, (v) => { settings.camera.bowDrawback = v; })),
        h('p', { class: 'settings-note', text: 'Presentation preferences keep directional swings, bow draw/release, and server combat rules intact.' })),

      // 3. Interface & Movable HUD Layout
      card('interface', t('settings.interface'),
        field(t('settings.uiScale'), h('span', { class: 'setting-range' },
          range('set-scale', 0.8, 1.4, 0.05, settings.uiScale, (v) => { settings.uiScale = v; }),
          h('output', { for: 'set-scale', text: settings.uiScale.toFixed(2) }))),
        toggle(t('settings.showTarget'), check('set-target', settings.showTarget, (v) => { settings.showTarget = v; })),
        toggle(t('settings.classicCompass'), check('set-classic-compass', settings.classicCompass, (v) => { settings.classicCompass = v; })),
        toggle(t('settings.touchOverlay'), check('set-touch-overlay', settings.touchControls, (v) => { settings.touchControls = v; })),
        h('div', { class: 'menu-actions' },
          h('button', {
            type: 'button', id: 'set-hud-edit', class: `btn btn-small${isHudEditMode?.() ? ' btn-primary' : ''}`,
            onclick: () => { setHudEditMode?.(!isHudEditMode?.()); if (isHudEditMode?.()) api.closePanel(); },
            text: isHudEditMode?.() ? 'Finish HUD edit' : t('settings.hudEdit'),
          }),
          h('button', {
            type: 'button', id: 'set-hud-reset', class: 'btn btn-small',
            onclick: () => resetHudLayout?.(),
            text: t('settings.hudReset'),
          }))),

      // 4. Localization / Language Selector
      card('locale', t('settings.localization'),
        field(t('settings.localeLabel'), h('select', {
          id: 'set-locale', class: 'setting-select',
          onchange: (ev) => { settings.locale = normalizeLocaleCode(ev.target.value); apply(); },
        }, ...listLocales().map((loc) => h('option', {
          value: loc.code,
          selected: settings.locale === loc.code,
          text: `${loc.nativeName} — ${loc.name} (${loc.script})`,
        })))),
        h('p', { class: 'settings-note', text: t('settings.localeNote') })),
    );

    // 5. Keyboard Movement & Look Bindings (full remapping)
    grid.append(card('move-bindings', t('settings.moveBindings'),
      h('p', { class: 'settings-note', text: 'Click any movement or look action and press a key. Backspace clears · Esc cancels.' }),
      h('div', { class: 'bindings-grid' }, ...Object.keys(DEFAULT_MOVE_BINDINGS).map((action) => h('div', { class: 'binding' },
        h('span', { class: 'binding-name', id: `mbind-label-${action}`, text: MOVE_BINDING_LABELS[action] }),
        h('button', {
          type: 'button', class: 'btn btn-small bind-btn', id: `mbind-${action}`,
          'aria-label': `${MOVE_BINDING_LABELS[action]}: ${keyLabel(settings.moveBindings[action])}. Change`,
          onclick: (ev) => { startRebind(action, 'move'); ev.currentTarget.textContent = 'Press a key…'; ev.currentTarget.dataset.listening = 'true'; },
          text: keyLabel(settings.moveBindings[action]),
        }),
      ))),
      h('div', { class: 'menu-actions' },
        h('button', { type: 'button', id: 'reset-move-binds', class: 'btn btn-small', onclick: () => { settings.moveBindings = { ...DEFAULT_MOVE_BINDINGS }; apply(); }, text: t('settings.restoreMove') }),
      ),
    ));

    // 6. Keyboard Action Bindings
    grid.append(card('bindings', t('settings.bindings'),
      h('p', { class: 'settings-note', text: 'Pick an action, then press a key. Backspace clears · Esc cancels.' }),
      h('div', { class: 'bindings-grid' }, ...Object.keys(DEFAULT_BINDINGS).map((action) => h('div', { class: 'binding' },
        h('span', { class: 'binding-name', id: `bind-label-${action}`, text: BINDING_LABELS[action] }),
        h('button', {
          type: 'button', class: 'btn btn-small bind-btn', id: `bind-${action}`,
          'aria-label': `${BINDING_LABELS[action]}: ${keyLabel(settings.bindings[action])}. Change`,
          onclick: (ev) => { startRebind(action, 'action'); ev.currentTarget.textContent = 'Press a key…'; ev.currentTarget.dataset.listening = 'true'; },
          text: keyLabel(settings.bindings[action]),
        }),
      ))),
      h('div', { class: 'menu-actions' },
        h('button', { type: 'button', id: 'reset-action-binds', class: 'btn btn-small', onclick: () => { settings.bindings = { ...DEFAULT_BINDINGS }; apply(); }, text: t('settings.restoreKeys') }),
      ),
    ));

    // 7. Controller & Gamepad Remapping (buttons, axes, per-axis inversion, deadzone, sensitivity, reset)
    const gp = settings.gamepad;
    const axisSelect = (id, key) => h('select', {
      id, class: 'setting-select',
      onchange: (ev) => { gp.axes[key] = Number(ev.target.value); apply(); },
    }, ...GAMEPAD_AXIS_NAMES.map((label, idx) => h('option', { value: String(idx), selected: gp.axes[key] === idx, text: label })));

    grid.append(card('gamepad', t('settings.gamepad'),
      field('Controller look sensitivity', h('span', { class: 'setting-range' },
        range('set-gp-sens', 0.2, 3, 0.05, gp.lookSensitivity, (v) => { gp.lookSensitivity = v; }),
        h('output', { for: 'set-gp-sens', text: gp.lookSensitivity.toFixed(2) }))),
      field('Stick deadzone', h('span', { class: 'setting-range' },
        range('set-gp-dead', 0.05, 0.45, 0.01, gp.deadzone, (v) => { gp.deadzone = v; }),
        h('output', { for: 'set-gp-dead', text: gp.deadzone.toFixed(2) }))),
      h('div', { class: 'gp-inverts' },
        toggle('Invert move X', check('set-gp-inv-mx', gp.invertMoveX, (v) => { gp.invertMoveX = v; })),
        toggle('Invert move Y', check('set-gp-inv-my', gp.invertMoveY, (v) => { gp.invertMoveY = v; })),
        toggle('Invert look X', check('set-gp-inv-lx', gp.invertLookX, (v) => { gp.invertLookX = v; })),
        toggle('Invert look Y', check('set-gp-inv-ly', gp.invertLookY, (v) => { gp.invertLookY = v; }))),
      h('div', { class: 'gp-axes-grid' },
        field('Move X axis', axisSelect('set-gp-ax-mx', 'moveX')),
        field('Move Y axis', axisSelect('set-gp-ax-my', 'moveY')),
        field('Look X axis', axisSelect('set-gp-ax-lx', 'lookX')),
        field('Look Y axis', axisSelect('set-gp-ax-ly', 'lookY'))),
      h('div', { class: 'bindings-grid' }, ...Object.entries(GAMEPAD_ACTION_LABELS).map(([action, label]) => h('div', { class: 'binding' },
        h('span', { class: 'binding-name', text: label }),
        h('select', {
          id: `gp-btn-${action}`, class: 'setting-select gp-btn-select',
          'aria-label': `Gamepad button for ${label}`,
          onchange: (ev) => { gp.buttons[action] = Number(ev.target.value); apply(); },
        }, ...Object.entries(GAMEPAD_BUTTON_NAMES).map(([code, bname]) => h('option', {
          value: code, selected: gp.buttons[action] === Number(code), text: bname,
        })))))),
      h('div', { class: 'menu-actions' },
        h('button', {
          type: 'button', id: 'reset-gp-binds', class: 'btn btn-small',
          onclick: () => { settings.gamepad = normalizeGamepadSettings({}); apply(); },
          text: t('settings.restorePad'),
        }))));

    // 8. Portable Settings Export / Import JSON
    const jsonBox = h('textarea', {
      id: 'settings-json-io', class: 'settings-json-box', rows: '4',
      'aria-label': 'Settings JSON', placeholder: 'Exported JSON appears here, or paste JSON to import…',
    });
    jsonBox.addEventListener('keydown', (e) => e.stopPropagation());
    const importFileInput = h('input', {
      id: 'settings-json-file', type: 'file', accept: '.json,application/json', hidden: true,
      onchange: async (ev) => {
        const f = ev.target.files?.[0];
        if (!f) return;
        const text = await f.text();
        jsonBox.value = text;
        doImport(text);
        ev.target.value = '';
      },
    });
    const doImport = (text) => {
      const res = importSettingsJson(text);
      if (!res.ok) {
        api.message(t('settings.importErr', { reason: res.error }), { kind: 'error' });
        return;
      }
      Object.assign(settings, res.settings);
      if (res.automapPrefs && api.automap?.setPrefs) api.automap.setPrefs(res.automapPrefs);
      apply();
      api.message(t('settings.importOk'));
    };

    grid.append(card('portable', t('settings.portable'),
      h('p', { class: 'settings-note', text: t('settings.portableNote') }),
      jsonBox,
      importFileInput,
      h('div', { class: 'menu-actions' },
        h('button', {
          type: 'button', id: 'set-export-json', class: 'btn btn-small',
          onclick: () => {
            const payload = exportSettingsJson(settings, { automapPrefs: api.automap?.getPrefs?.() ?? null });
            jsonBox.value = payload;
            try {
              const blob = new Blob([payload], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = 'daggerfall-world-settings.json';
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch { /* headless fallback */ }
            api.message(t('settings.exported'));
          },
          text: t('settings.exportJson'),
        }),
        h('button', {
          type: 'button', id: 'set-import-json', class: 'btn btn-small',
          onclick: () => {
            if (jsonBox.value.trim()) doImport(jsonBox.value);
            else importFileInput.click();
          },
          text: t('settings.importJson'),
        }),
        h('button', {
          type: 'button', id: 'set-reset-all', class: 'btn btn-small',
          onclick: () => { Object.assign(settings, normalizeSettings({})); apply(); },
          text: t('settings.resetAll'),
        }))));

    // 9. Account
    grid.append(card('account', t('settings.account'),
      h('p', { class: 'settings-note', text: api.account
        ? `Signed in as ${api.account.username}. Your character and progress are saved automatically on the server.`
        : 'Playing as a guest on this server. Your character is saved for this browser session; sign in with an account to keep it permanently.' }),
      h('div', { class: 'menu-actions' },
        h('button', { type: 'button', class: 'btn', onclick: leave, text: 'Leave the world' }),
        api.account && globalThis.dfwAccount?.logout
          ? h('button', { type: 'button', class: 'btn', onclick: () => globalThis.dfwAccount.logout(), text: 'Sign out' }) : null,
        h('a', { class: 'btn', href: ACCOUNT_LINKS.settings, target: '_blank', rel: 'noopener', text: 'Account settings' }),
        h('button', {
          type: 'button',
          class: 'btn',
          onclick: () => api.openBugReport?.({ panel: 'settings' }) ?? globalThis.dfwBugDraft?.open?.({ panel: 'settings' }),
          text: 'Report a bug',
        }),
      ),
      h('nav', { class: 'settings-web-links', 'aria-label': 'Website' },
        h('span', { class: 'settings-web-label', text: 'Website' }),
        ...WEBSITE_LINKS.map((item) =>
          h('a', { class: 'settings-web-link', href: item.href, target: '_blank', rel: 'noopener', text: item.label }),
        ),
      )));
    el.append(grid);
  },
};

export { builtinPanels };
