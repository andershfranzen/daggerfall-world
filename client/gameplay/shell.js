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

const SETTINGS_KEY = 'dfw.settings';

// Menu pages are grouped on the rail (hud/layout.css draws the group labels). Unknown pages go
// to the group of their nearest known neighbour in registration order.
export const PANEL_GROUPS = Object.freeze([
  ['You', ['character', 'inventory', 'spellbook', 'journal']],
  ['World', ['map', 'wilderness', 'places', 'automap', 'rest', 'property', 'sailing', 'seaChart', 'shipyard', 'passage', 'admiralty']],
  ['People', ['party', 'interaction', 'dialogue', 'townServices']],
  ['System', ['settings', 'audio']],
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

/** The contextual name of the Use action for a target (bar button label). */
export function useLabel(e) {
  const it = interactionFor(e);
  if (!it) return 'Use';
  if (it.verb === 'npc.talk') return 'Talk';
  if (it.verb === 'inventory.inspectLoot' || it.verb === 'combat.loot') return 'Loot';
  if (it.verb === 'combat.revive') return 'Revive';
  if (it.panel === 'party') return 'Party';
  return 'Use';
}

export function loadSettings(storage = globalThis.localStorage) {
  let raw = {};
  try { raw = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}') || {}; } catch { raw = {}; }
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    sensitivity: num(raw.sensitivity, 0.2, 3, 1),
    invertY: raw.invertY === true,
    uiScale: num(raw.uiScale, 0.8, 1.4, 1),
    clickAttack: raw.clickAttack !== false,
    showTarget: raw.showTarget !== false,
    bindings: normalizeBindings(raw.bindings),
  };
}

export function saveSettings(settings, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage disabled */ }
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
    menu: $('game-menu'), tabs: $('menu-tabs'), title: $('menu-title'), panel: $('menu-panel'),
    close: $('menu-close'), hint: $('menu-hint'),
    vitals: $('hud-vitals'), breath: $('hud-breath'), target: $('hud-target'), toasts: $('hud-toasts'), bar: $('hud-bar'),
    readyBtn: $('hud-ready-btn'), menuBtn: $('hud-menu-btn'), helpDl: $('hud-help-list'),
    useBtn: $('hud-use-btn'),
  };
  let open = null;
  let openKey = null; // watchKey of the open panel at its last render
  let returnFocus = null;
  let rebinding = null; // action awaiting a key
  const dialogue = []; // recent interaction lines {who, text, at}

  // ---------------------------------------------------- panels: built-in fallbacks

  const WATCH_ALL = new Set(['map', 'party', 'interaction']);
  for (const p of PANELS) {
    api.registerPanel(p.id, p.title, builtinPanels[p.id], { builtin: true, key: p.key, watch: WATCH_ALL.has(p.id) ? 'all' : p.id === 'settings' ? 'none' : 'character' });
  }
  api._dialogue = dialogue;
  api._shellContext = {
    settings,
    apply: () => { saveSettings(settings); applySettings(); renderTabs(); updateBar(); updateHelp(); updateTarget(); renderPanel(); },
    startRebind: (action) => { rebinding = action; },
    leave: () => { closePanel(); actions.leave?.(); },
  };

  // ---------------------------------------------------- open / close / render

  function renderTabs() {
    const list = groupPanels(api.panels());
    ui.tabs.replaceChildren(...list.map((p) => {
      const code = p.id in settings.bindings ? settings.bindings[p.id] : p.key;
      const b = h('button', {
        type: 'button', role: 'tab', id: `menu-tab-${p.id}`, class: 'menu-tab',
        'aria-selected': String(p.id === open), 'aria-controls': 'menu-panel',
        tabindex: p.id === open ? '0' : '-1', dataset: { panel: p.id, group: p.group },
        'data-group-start': p.groupStart ? '' : null, 'data-group-label': p.groupStart ? p.group : null,
        onclick: () => openPanel(p.id),
      }, h('span', { class: 'menu-tab-name', text: p.title }), code ? h('kbd', { text: keyLabel(code) }) : null);
      return b;
    }));
    // Keep the selected page in view on a rail or tab strip that scrolls.
    const sel = open && $(`menu-tab-${open}`);
    if (sel && ui.tabs.scrollHeight + ui.tabs.scrollWidth > ui.tabs.clientHeight + ui.tabs.clientWidth) {
      sel.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    updateBar();
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
    ui.panel.setAttribute('aria-labelledby', `menu-tab-${p.id}`);
    ui.panel.dataset.panel = p.id;
    const body = h('div', { class: `panel-body panel-${p.id}` });
    try {
      p.render(body, api);
    } catch (err) {
      console.error(`[gameplay] panel ${p.id} failed:`, err);
      body.replaceChildren(h('p', { class: 'menu-error', role: 'alert', text: `This page could not be drawn: ${err.message}` }));
    }
    ui.panel.replaceChildren(body);
    restoreEdited(edited, ui.panel);
    ui.panel.scrollTop = scroll;
    if (fkey) restoreFocus(fkey, ui.panel);
  }

  function openPanel(id, detail) {
    const first = !open;
    if (first) returnFocus = document.activeElement;
    open = id;
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
    const target = list.find((el) => el.hasAttribute('autofocus')) ?? list.find((el) => !isTextField(el)) ?? $(`menu-tab-${id}`);
    (first || !ui.menu.contains(document.activeElement) ? target : document.activeElement)?.focus({ preventScroll: true });
  }

  function closePanel() {
    if (!open) return;
    const was = open;
    open = null;
    rebinding = null;
    api._setModal(false);
    input.setSuspended(false);
    ui.menu.hidden = true;
    delete document.body.dataset.menu;
    ui.panel.replaceChildren();
    updateBar();
    api.emit('panel', { id: was, open: false });
    const back = returnFocus && document.contains(returnFocus) && returnFocus !== document.body ? returnFocus : $('view');
    returnFocus = null;
    back?.focus?.({ preventScroll: true });
  }

  api._attachShell({
    open: openPanel,
    close: closePanel,
    refresh: () => renderPanel(),
    panelsChanged: () => { if (open) renderTabs(); updateBar(); updateHelp(); },
  });

  ui.close.addEventListener('click', closePanel);
  ui.menu.addEventListener('pointerdown', (e) => { if (e.target === ui.menu) closePanel(); });

  // Keyboard inside the menu: Tab trap, arrow keys on the rail, Esc closes.
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
    if (e.target.getAttribute?.('role') === 'tab' && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const tabs = [...ui.tabs.querySelectorAll('[role="tab"]')];
      let i = tabs.indexOf(e.target);
      if (e.key === 'ArrowUp') i = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'ArrowDown') i = (i + 1) % tabs.length;
      else if (e.key === 'Home') i = 0;
      else i = tabs.length - 1;
      openPanel(tabs[i].dataset.panel);
      $(`menu-tab-${tabs[i].dataset.panel}`)?.focus();
    }
  });

  // Key capture for rebinding in Settings.
  window.addEventListener('keydown', (e) => {
    if (!rebinding) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const action = rebinding;
    rebinding = null;
    if (e.code === 'Escape') { renderPanel(); return; }
    if (e.code === 'Backspace' || e.code === 'Delete') settings.bindings = rebind(settings.bindings, action, null);
    else {
      try { settings.bindings = rebind(settings.bindings, action, e.code); }
      catch (err) { api.message(err.message, { kind: 'error' }); }
    }
    saveSettings(settings);
    renderTabs();
    renderPanel();
    updateHelp();
    $(`bind-${action}`)?.focus();
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

  function toast(text, { kind = 'info', ttl = 5000, event } = {}) {
    const icons = Array.isArray(event?.artItems) ? event.artItems.slice(0, 4).map((item) => itemIcon(api, item)) : [];
    const li = h('li', { class: `toast toast-${kind}` }, icons, text);
    ui.toasts.append(li);
    while (ui.toasts.children.length > 4) ui.toasts.firstElementChild.remove();
    setTimeout(() => { li.classList.add('toast-out'); setTimeout(() => li.remove(), 400); }, ttl);
  }

  function updateHelp() {
    if (!ui.helpDl) return;
    const b = settings.bindings;
    const rows = [
      ['W A S D', 'Walk and sidestep'], ['← → / Q E', 'Turn'], ['↑ ↓', 'Look up and down'],
      ['Click view', 'Capture mouse, then move it to look (Esc releases)'], ['Touch drag', 'Look around'],
      [keyLabel(b.ready), 'Ready or sheathe weapon'],
      [`${keyLabel(b.attack)} / Click`, 'Attack once the mouse is captured (readies first if sheathed)'],
      ['Right-drag', 'Directional strike'],
      [keyLabel(b.interact), 'Talk, use or loot target (in the current activation mode)'],
      [[b.modeSteal, b.modeGrab, b.modeInfo, b.modeTalk].map(keyLabel).join(' '), 'Activation mode: Steal, Grab, Info, Talk'],
      [`${keyLabel(b.run)} / ${keyLabel(b.slow)}`, 'Hold to run / walk slowly'],
      [keyLabel(b.jump), 'Jump; hold to swim up or rise while levitating'],
      [keyLabel(b.crouch), 'Crouch and sneak; hold to dive or sink'],
      ['Walk into a wall', 'Climb (skill sets how soon)'],
      [[b.character, b.inventory, b.spellbook, b.journal].map(keyLabel).join(' '), 'Character, inventory, spells, journal'],
      [[b.map, b.party].map(keyLabel).join(' '), 'Map, party'],
      ...api.panels().filter(p => !p.builtin && p.key && !(p.id in b) && !Object.values(b).includes(p.key)).map(p => [keyLabel(p.key), p.title]),
      ...(api.getPanel('spellbook')?.builtin === false ? [['V', 'Cast readied spell']] : []),
      [`Esc / ${keyLabel(b.settings)}`, 'Close menus / settings'],
      [`Enter / ${keyLabel(b.chat)}`, 'Speak'],
      [keyLabel(b.people), 'People here'],
      ['Gamepad', 'Sticks move/look · A use · X attack · Y ready · LB run · RS crouch · A/B swim up/down · Start menu'],
    ];
    ui.helpDl.replaceChildren(...rows.flatMap(([k, d]) => [h('dt', { text: k }), h('dd', { text: d })]));
  }

  // ---------------------------------------------------- gamepad navigation inside menus

  function padNav(pressed) {
    if (!open) return false;
    if (pressed.has(PAD.B) || pressed.has(PAD.START)) { closePanel(); return true; }
    if (pressed.has(PAD.LB) || pressed.has(PAD.RB)) {
      const list = groupPanels(api.panels());
      let i = list.findIndex((p) => p.id === open);
      i = (i + (pressed.has(PAD.RB) ? 1 : -1) + list.length) % list.length;
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
    if (pressed.has(PAD.A)) {
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

  applySettings();
  updateVitals();
  updateBar();
  updateHelp();

  function applySettings() {
    input.sensitivity = settings.sensitivity;
    input.invertY = settings.invertY;
    document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale));
  }

  return {
    open: openPanel, close: closePanel, toast, padNav, updateTarget, updateBar,
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
    const { settings, apply, startRebind, leave } = ctx;
    const field = (label, control) => h('label', { class: 'setting' }, h('span', { class: 'setting-name', text: label }), control);
    const range = (id, min, max, step, value, on) => h('input', {
      id, type: 'range', min, max, step, value,
      oninput: (ev) => { on(Number(ev.target.value)); ev.target.nextElementSibling && (ev.target.nextElementSibling.textContent = Number(ev.target.value).toFixed(2)); },
      onchange: () => apply(),
    });
    const check = (id, value, on) => h('input', { id, type: 'checkbox', checked: value, onchange: (ev) => { on(ev.target.checked); apply(); } });

    el.append(h('h4', { text: 'Controls' }),
      field('Look sensitivity', h('span', { class: 'setting-range' },
        range('set-sens', 0.2, 3, 0.05, settings.sensitivity, (v) => { settings.sensitivity = v; }),
        h('output', { for: 'set-sens', text: settings.sensitivity.toFixed(2) }))),
      field('Invert look up/down', check('set-invert', settings.invertY, (v) => { settings.invertY = v; })),
      field('Click to attack', check('set-click', settings.clickAttack, (v) => { settings.clickAttack = v; })),
      h('h4', { text: 'Interface' }),
      field('Interface size', h('span', { class: 'setting-range' },
        range('set-scale', 0.8, 1.4, 0.05, settings.uiScale, (v) => { settings.uiScale = v; }),
        h('output', { for: 'set-scale', text: settings.uiScale.toFixed(2) }))),
      field('Show target name', check('set-target', settings.showTarget, (v) => { settings.showTarget = v; })),
    );

    el.append(h('h4', { text: 'Key bindings' }),
      h('p', { class: 'sheet-sub', text: 'Choose an action, then press a key. Backspace clears it, Esc cancels. W A S D, Q E, arrows, Tab, Enter and Esc are fixed.' }),
      h('table', { class: 'bindings' }, h('tbody', {}, ...Object.keys(DEFAULT_BINDINGS).map((action) => h('tr', {},
        h('th', { scope: 'row', text: BINDING_LABELS[action] }),
        h('td', {}, h('button', {
          type: 'button', class: 'btn btn-small bind-btn', id: `bind-${action}`,
          'aria-label': `${BINDING_LABELS[action]}: ${keyLabel(settings.bindings[action])}. Change`,
          onclick: (ev) => { startRebind(action); ev.currentTarget.textContent = 'Press a key…'; },
          text: keyLabel(settings.bindings[action]),
        })),
      )))),
      h('div', { class: 'menu-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { settings.bindings = { ...DEFAULT_BINDINGS }; apply(); }, text: 'Restore default keys' }),
      ),
    );

    el.append(h('h4', { text: 'Gamepad' }), h('dl', { class: 'sheet-grid' },
      ...[['Left stick', 'Walk'], ['Right stick', 'Look'], ['A', 'Talk / use · confirm in menus'], ['B', 'Close menu'], ['X / RT', 'Attack'], ['Y', 'Ready weapon'],
        ['Start', 'Menu'], ['Back', 'Map'], ['LB / RB', 'Previous / next menu page'], ['D-pad', 'Move between controls']]
        .flatMap(([k, d]) => [h('dt', { text: k }), h('dd', { text: d })])));

    el.append(h('h4', { text: 'Account' }),
      h('p', { class: 'sheet-sub', text: api.account ? `Signed in as ${api.account.username}.` : 'Playing as a guest on this server.' }),
      h('div', { class: 'menu-actions' },
        h('button', { type: 'button', class: 'btn', onclick: leave, text: 'Leave the world' }),
        api.account && globalThis.dfwAccount?.logout
          ? h('button', { type: 'button', class: 'btn', onclick: () => globalThis.dfwAccount.logout(), text: 'Sign out' }) : null));
  },
};

export { builtinPanels };
