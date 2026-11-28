// Quickslots, searchable contextual Help (reading active bindings), HUD conveniences
// (arrow count, quest deadline countdown, rest warnings, dungeon-exit wagon prompt),
// and updated Privateer's Hold opening tutorial prompts.
// Pure helpers are DOM-free so they run under `node --test`.

import { DEFAULT_BINDINGS, keyLabel, readiedOf } from './api.js';
import {
  DEFAULT_MOVE_BINDINGS, DEFAULT_GAMEPAD_SETTINGS, GAMEPAD_BUTTON_NAMES,
} from './shell.js';
import { WAGON_DUNGEON_REACH, CART_TEMPLATE } from './property/rules.js';
import { t } from '../lib/i18n.js';

export const QUICKSLOT_COUNT = 8;
export const HELP_PANEL_ID = 'help';
export const HELP_PANEL_KEY = 'F5';
const QUICKSLOT_STORAGE_PREFIX = 'dfw.quickslots.';
const TUTORIAL_DISMISSED_KEY = 'dfw.tutorial.dismissed';
const REST_MONSTER_RADIUS = 18;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-quickslots-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./quickslots.css', import.meta.url).href;
  link.dataset.quickslotsCss = '';
  document.head.append(link);
}

// ------------------------------------------------------------------ pure quickslot model

export function isWeaponItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.slot === 'rightHand' || it.slot === 'leftHand' || it.weaponType || it.kind === 'weapon') return true;
  return /(sword|dagger|axe|mace|hammer|flail|staff|katana|dai-katana|wakizashi|claymore|bow|shortbow|longbow|saber|broadsword|tanto)/i.test(String(it.template ?? it.name ?? ''));
}

export function isConsumableItem(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.usable || it.consumable || it.kind === 'potion' || it.kind === 'consumable') return true;
  return /(potion|elixir|bread|food|rations|torch|lantern|oil|bandage)/i.test(String(it.template ?? it.name ?? ''));
}

/** Items eligible for quickslot assignment (weapons and consumables). */
export function quickslotCandidates(character) {
  const inv = Array.isArray(character?.inventory) ? character.inventory : [];
  return inv.filter((it) => it && it.id != null && (isWeaponItem(it) || isConsumableItem(it)));
}

/** Build default quickslots from equipped weapons + carried consumables/weapons. */
export function autoPopulateQuickslots(character, savedSlots = null) {
  const slots = Array.from({ length: QUICKSLOT_COUNT }, (_, i) => {
    const s = Array.isArray(savedSlots) ? savedSlots[i] : null;
    return s && typeof s === 'object' && s.itemId ? { kind: s.kind || 'item', itemId: String(s.itemId), label: s.label || '' } : null;
  });
  const inv = Array.isArray(character?.inventory) ? character.inventory : [];
  const byId = new Map(inv.map((it) => [String(it.id), it]));
  // Prune missing items only if inventory has arrived
  if (inv.length) {
    for (let i = 0; i < slots.length; i++) {
      if (slots[i]?.kind === 'item' && !byId.has(slots[i].itemId)) slots[i] = null;
    }
  }
  const used = new Set(slots.filter(Boolean).map((s) => s.itemId));
  const hasAny = slots.some(Boolean);
  if (!hasAny && inv.length) {
    const eqRight = character?.equipment?.rightHand != null ? String(character.equipment.rightHand) : null;
    const candidates = quickslotCandidates(character).sort((a, b) => {
      const aEq = String(a.id) === eqRight ? 0 : 1;
      const bEq = String(b.id) === eqRight ? 0 : 1;
      if (aEq !== bEq) return aEq - bEq;
      const aW = isWeaponItem(a) ? 0 : 1;
      const bW = isWeaponItem(b) ? 0 : 1;
      return aW - bW;
    });
    let idx = 0;
    for (const item of candidates) {
      if (idx >= QUICKSLOT_COUNT) break;
      const id = String(item.id);
      if (used.has(id)) continue;
      used.add(id);
      slots[idx++] = { kind: 'item', itemId: id, label: item.name ?? item.template ?? id };
    }
  }
  return slots;
}

/** Resolve what action activating a quickslot triggers, using existing inventory/combat verbs. */
export function quickslotActivation(slot, character) {
  if (!slot || slot.kind !== 'item') return null;
  const inv = Array.isArray(character?.inventory) ? character.inventory : [];
  const item = inv.find((it) => String(it.id) === String(slot.itemId));
  if (!item) return null;
  if (isConsumableItem(item) && !isWeaponItem(item)) {
    return { verb: 'inventory.use', args: { itemId: String(item.id) }, item, mode: 'use' };
  }
  const eq = character?.equipment ?? {};
  const alreadyEquipped = Object.values(eq).some((id) => String(id) === String(item.id));
  if (alreadyEquipped) {
    return { verb: 'combat.ready', args: { ready: true }, item, mode: 'ready' };
  }
  return { verb: 'inventory.equip', args: { itemId: String(item.id) }, item, mode: 'equip' };
}

// ------------------------------------------------------------------ pure HUD convenience models

/** Arrow count from inventory + whether a bow is currently equipped/readied. */
export function arrowStatusOf(character) {
  const inv = Array.isArray(character?.inventory) ? character.inventory : [];
  let arrows = 0;
  for (const it of inv) {
    if (!it) continue;
    const tpl = String(it.template ?? it.name ?? '').toLowerCase();
    if (tpl === 'arrow' || tpl === 'arrows' || /\barrow(s)?\b/.test(tpl) || it.ammoType === 'arrow') {
      arrows += Number.isFinite(it.quantity) ? Math.max(0, Math.trunc(it.quantity)) : 1;
    }
  }
  const rightId = character?.equipment?.rightHand != null ? String(character.equipment.rightHand) : null;
  const rightItem = rightId ? inv.find((it) => String(it.id) === rightId) : null;
  const weaponView = character?.weaponView;
  const bowEquipped = !!(
    (rightItem && /bow/i.test(String(rightItem.template ?? rightItem.name ?? rightItem.weaponType ?? ''))) ||
    (weaponView && /bow/i.test(String(weaponView.weaponType ?? weaponView.template ?? '')))
  );
  return { count: arrows, bowEquipped, show: bowEquipped || arrows > 0, low: bowEquipped && arrows <= 5, empty: bowEquipped && arrows === 0 };
}

/** Format a remaining classic-minute duration as readable countdown text. */
export function formatCountdown(minutesLeft) {
  if (!Number.isFinite(minutesLeft)) return '';
  if (minutesLeft <= 0) return 'Expired';
  const days = Math.floor(minutesLeft / MINUTES_PER_DAY);
  const hours = Math.floor((minutesLeft % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  const mins = Math.floor(minutesLeft % MINUTES_PER_HOUR);
  if (days >= 1) return `${days}d ${hours}h left`;
  if (hours >= 1) return `${hours}h ${mins}m left`;
  return `${Math.max(1, mins)}m left`;
}

/** Soonest active quest deadline from character.quests using the character's own quest clocks. */
export function soonestQuestDeadline(character, nowMinutes = null) {
  const q = character?.quests;
  const active = Array.isArray(q?.active) ? q.active : [];
  const now = Number.isFinite(nowMinutes) ? nowMinutes : (Number.isFinite(q?.minutes) ? q.minutes : null);
  if (!active.length || now === null) return null;
  let best = null;
  for (const inst of active) {
    if (!inst || typeof inst !== 'object') continue;
    let endAt = null;
    for (const clk of Object.values(inst.clocks ?? {})) {
      if (clk && clk.running && !clk.done && Number.isFinite(clk.endAt)) {
        endAt = endAt === null ? clk.endAt : Math.min(endAt, clk.endAt);
      }
    }
    if (endAt === null && Number.isFinite(inst.deadline)) endAt = inst.deadline;
    if (endAt === null) continue;
    const remaining = endAt - now;
    if (!best || remaining < best.remaining) {
      best = {
        id: inst.id ?? inst.questId ?? '',
        title: inst.title ?? inst.name ?? 'Active Quest',
        endAt,
        remaining,
        text: formatCountdown(remaining),
        urgent: remaining <= MINUTES_PER_DAY,
      };
    }
  }
  return best;
}

/** Compute DFU-style rest warnings from live entities, character conditions, and location. */
export function restWarningsFor(state, camera = null) {
  const warnings = [];
  const c = state?.character;
  const loc = String(c?.location ?? state?.location ?? '');
  const entities = Array.isArray(state?.entities) ? state.entities : [];
  if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
    const hostileNear = entities.some((e) => {
      if (!e || e.kind !== 'monster' || e.dead || (Number.isFinite(e.hp) && e.hp <= 0)) return false;
      return Math.hypot(e.x - camera.x, e.z - camera.z) <= REST_MONSTER_RADIUS;
    });
    if (hostileNear) warnings.push({ code: 'enemies', severity: 'danger', text: 'Enemies are nearby — resting may be interrupted by combat.' });
  }
  const cond = c?.conditions;
  if (cond) {
    if (Array.isArray(cond.diseases) && cond.diseases.length) {
      warnings.push({ code: 'disease', severity: 'warn', text: 'You are diseased — resting for hours will advance the illness.' });
    }
    if (Array.isArray(cond.poisons) && cond.poisons.length) {
      warnings.push({ code: 'poison', severity: 'danger', text: 'You are poisoned — resting now could be fatal.' });
    }
  }
  if (loc.startsWith('town:')) {
    warnings.push({ code: 'loitering', severity: 'info', text: 'Loitering in town streets may attract guards; inns offer safe rest.' });
  }
  return warnings;
}

/** True when player owns a Small Cart (wagon) in inventory or property record. */
export function ownsWagon(character) {
  if (!character) return false;
  if (character.property?.wagon || character.property?.hasCart || character.wagon) return true;
  const inv = Array.isArray(character.inventory) ? character.inventory : [];
  return inv.some((it) => it && String(it.template ?? '').toLowerCase() === CART_TEMPLATE);
}

/**
 * Dungeon-exit wagon prompt check (DFU parity):
 * In a `dungeon:` location, owning a Small Cart, within WAGON_DUNGEON_REACH (5 m) of an exit door.
 */
export function dungeonWagonPrompt(state, camera, scene) {
  const c = state?.character;
  const loc = String(c?.location ?? state?.location ?? '');
  if (!loc.startsWith('dungeon:') || !ownsWagon(c) || !camera || !Number.isFinite(camera.x) || !Number.isFinite(camera.z)) {
    return null;
  }
  const exits = [];
  if (Array.isArray(scene?.exits)) exits.push(...scene.exits);
  if (Array.isArray(scene?.doors)) {
    for (const d of scene.doors) {
      if (d?.type === 3) {
        if (Number.isFinite(d.x) && Number.isFinite(d.z)) exits.push(d);
        else if (Array.isArray(d.centre)) exits.push({ x: d.centre[0], y: d.centre[1], z: -d.centre[2] });
      }
    }
  }
  let nearestDist = Infinity;
  for (const ex of exits) {
    if (!Number.isFinite(ex?.x) || !Number.isFinite(ex?.z)) continue;
    const d = Math.hypot(ex.x - camera.x, ex.z - camera.z);
    const dy = Number.isFinite(ex.y) && Number.isFinite(camera.y) ? Math.abs(ex.y - (camera.y - 1.6)) : 0;
    if (d <= WAGON_DUNGEON_REACH && dy <= 3.5 && d < nearestDist) nearestDist = d;
  }
  if (!Number.isFinite(nearestDist)) return null;
  return {
    distance: Math.round(nearestDist * 10) / 10,
    text: t('hud.wagonPrompt'),
  };
}

// ------------------------------------------------------------------ Privateer's Hold tutorial & searchable contextual Help

/** Build Privateer's Hold opening tutorial steps dynamically reading active keyboard/controller bindings. */
export function tutorialStepsFor(settings = null, { gamepadConnected = false } = {}) {
  const b = { ...DEFAULT_BINDINGS, ...(settings?.bindings ?? {}) };
  const mb = { ...DEFAULT_MOVE_BINDINGS, ...(settings?.moveBindings ?? {}) };
  const gp = { ...DEFAULT_GAMEPAD_SETTINGS.buttons, ...(settings?.gamepad?.buttons ?? {}) };
  const k = (code) => keyLabel(code);
  const moveKeys = `${k(mb.moveForward)}/${k(mb.strafeLeft)}/${k(mb.moveBack)}/${k(mb.strafeRight)}`;
  const turnKeys = `${k(mb.turnLeft)}/${k(mb.turnRight)} or mouse look`;
  const padMove = 'Left Stick to move, Right Stick to look';
  return [
    {
      id: 'move',
      title: '1. Movement & Camera',
      body: gamepadConnected
        ? `Use ${padMove}. Click the view on desktop to capture the mouse (Esc releases), or use ${moveKeys}.`
        : `Move with ${moveKeys}, turn with ${turnKeys}, or click the game view to capture mouse look (Esc releases). Hold ${k(b.run)} to run and press ${k(b.jump)} to jump.`,
    },
    {
      id: 'combat',
      title: '2. First Encounter & Combat',
      body: `Press ${k(b.ready)} (${GAMEPAD_BUTTON_NAMES[gp.ready]}) to ready your weapon. Attack with ${k(b.attack)} (${GAMEPAD_BUTTON_NAMES[gp.attack]}), click, or right-drag for directional strikes. Use keys 1–8 for quickslots.`,
    },
    {
      id: 'interact',
      title: '3. Doors, Locks & Activation Modes',
      body: `Approach doors, chests, or loot and press ${k(b.interact)} (${GAMEPAD_BUTTON_NAMES[gp.interact]}). Switch modes with ${k(b.modeSteal)} Steal · ${k(b.modeGrab)} Grab · ${k(b.modeInfo)} Info · ${k(b.modeTalk)} Talk.`,
    },
    {
      id: 'automap',
      title: '4. Reading the 2D & 3D Automap',
      body: 'Press N to open the Automap. Switch between 2D Plan and rotatable 3D Perspective (V), adjust floor slices (PgUp/PgDn), and follow the exit diamond back to the surface.',
    },
    {
      id: 'reconnect',
      title: '5. Saving, Reconnecting & Help',
      body: `Your progress, inventory, and explored dungeon cells save automatically on the server. Press ${k(b.settings)} for Settings/Remapping or F5 anytime to reopen this searchable Help.`,
    },
  ];
}

/** Build searchable help entries reading active bindings and current context. */
export function buildHelpEntries(settings = null, context = {}) {
  const b = { ...DEFAULT_BINDINGS, ...(settings?.bindings ?? {}) };
  const mb = { ...DEFAULT_MOVE_BINDINGS, ...(settings?.moveBindings ?? {}) };
  const gp = { ...DEFAULT_GAMEPAD_SETTINGS.buttons, ...(settings?.gamepad?.buttons ?? {}) };
  const k = (code) => keyLabel(code);
  const loc = String(context.location ?? '');
  const entries = [
    { id: 'move', category: 'Movement', title: 'Walk & Strafe', binding: `${k(mb.moveForward)} ${k(mb.strafeLeft)} ${k(mb.moveBack)} ${k(mb.strafeRight)}`, text: 'Move forward, back, and strafe. Remappable in Settings → Movement & Look Bindings.' },
    { id: 'look', category: 'Movement', title: 'Turn & Look', binding: `${k(mb.turnLeft)} ${k(mb.turnRight)} · ${k(mb.lookUp)} ${k(mb.lookDown)} · Mouse`, text: 'Click the 3D view for pointer-locked mouse look (Esc releases), or use keyboard turn/look keys or touch drag.' },
    { id: 'traversal', category: 'Movement', title: 'Run, Walk Slowly, Jump, Crouch & Climb', binding: `${k(b.run)} · ${k(b.slow)} · ${k(b.jump)} · ${k(b.crouch)}`, text: 'Hold Run to sprint, Walk Slowly to sneak quietly, Jump to leap or swim up, Crouch to sneak or dive. Push into walls to climb.' },
    { id: 'combat', category: 'Combat', title: 'Ready Weapon & Attack', binding: `${k(b.ready)} · ${k(b.attack)} · Right-drag`, text: `Draw or sheathe with ${k(b.ready)}. Strike with ${k(b.attack)} or click, or hold right mouse and drag for classic directional swings and bow draw/release.` },
    { id: 'quickslots', category: 'Combat', title: 'Weapon & Consumable Quickslots', binding: '1 – 8', text: 'Equip weapons or drink potions/consumables directly from the bottom quickslots bar. Click the + button on any slot to reassign it.' },
    { id: 'interact', category: 'World', title: 'Interact, Loot, Talk & Activation Modes', binding: `${k(b.interact)} · ${k(b.modeSteal)}-${k(b.modeTalk)}`, text: `Press ${k(b.interact)} to open doors, search loot, or talk. Switch between Steal (${k(b.modeSteal)}), Grab (${k(b.modeGrab)}), Info (${k(b.modeInfo)}), and Talk (${k(b.modeTalk)}).` },
    { id: 'automap', category: 'Navigation', title: '2D & Rotatable 3D Automap', binding: 'N · V (2D/3D) · PgUp/PgDn', text: 'Open the Automap (N) to inspect explored dungeon rooms in 2D or rotatable 3D perspective (V), adjust floor slices, pin notes (K), or enable the corner dungeon minimap.' },
    { id: 'road', category: 'Navigation', title: 'Road-Following & Junction Guidance', binding: 'Maps → Road Guidance', text: 'Follow roads outdoors from town gates across junctions and map-pixel boundaries with live bearing cues and junction branch selection.' },
    { id: 'wagon', category: 'Inventory', title: 'Dungeon-Exit Wagon Access', binding: 'Small Cart within 5 m of exit', text: 'If you own a Small Cart, approach within 5 metres of any dungeon exit door to see the quick Open Wagon prompt for storing heavy loot.' },
    { id: 'rest', category: 'Survival', title: 'Resting & Safety Warnings', binding: 'R (Rest panel)', text: 'Rest to recover health, fatigue, and magicka. Watch for rest warnings about nearby monsters, disease/poison, or loitering in town streets.' },
    { id: 'gamepad', category: 'Controls', title: 'Controller / Gamepad Controls', binding: `${GAMEPAD_BUTTON_NAMES[gp.interact]} Use · ${GAMEPAD_BUTTON_NAMES[gp.attack]} Attack · ${GAMEPAD_BUTTON_NAMES[gp.ready]} Ready`, text: 'Remap controller buttons, axes, deadzone, per-axis inversion, and sensitivity in Settings → Controller & Gamepad Remapping.' },
    { id: 'settings', category: 'System', title: 'Portable Settings, HUD Layout & Locale', binding: `${k(b.settings)} (Settings)`, text: 'Drag HUD widgets in HUD Layout Edit Mode, switch language/locale (including Japanese & Cyrillic), or export/import settings as JSON.' },
    { id: 'touch', category: 'Mobile', title: 'Phone Touch Controls & Local ZIP Loader', binding: 'Touch overlay · .zip loader', text: 'Enable touch controls in Settings or on mobile devices for full thumbstick movement, look pad, and action buttons, and load ARENA2 directly from a local .zip archive.' },
  ];
  if (/privateer/i.test(loc)) {
    entries.unshift({
      id: 'ctx-privateer',
      category: 'Here Now',
      title: "Privateer's Hold Opening Guide",
      binding: `${k(b.ready)} · ${k(b.interact)} · N`,
      text: 'You are in Privateer\'s Hold. Ready your weapon, clear the first guards, check locked doors, and follow your 2D/3D Automap (N) to the exit door.',
    });
  } else if (loc.startsWith('dungeon:')) {
    entries.unshift({
      id: 'ctx-dungeon',
      category: 'Here Now',
      title: 'Dungeon Navigation & Exit Wagon',
      binding: 'N (3D Map) · R (Rest)',
      text: 'Use the 3D Automap (V inside Automap) to inspect stacked rooms and ramps, and watch for the Wagon prompt near the dungeon exit.',
    });
  } else if (loc.startsWith('town:') || loc.startsWith('wilderness:')) {
    entries.unshift({
      id: 'ctx-outdoors',
      category: 'Here Now',
      title: 'Overland & Road Guidance',
      binding: `${k(b.map)} (Map)`,
      text: 'Use the Travel Map or Road-Following HUD guidance to navigate roads, forks, and map-pixel crossings.',
    });
  }
  return entries;
}

export function filterHelpEntries(entries, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return entries;
  const terms = q.split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    const hay = `${e.category} ${e.title} ${e.binding} ${e.text}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

// ------------------------------------------------------------------ feature install

export function install(api) {
  const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
  const S = {
    slots: Array(QUICKSLOT_COUNT).fill(null),
    ownerKey: null,
    selectedSlot: 0,
    pickerSlot: null,
    helpQuery: '',
    tutorialStep: 0,
    tutorialOpen: false,
    tutorialDismissed: (() => { try { return storage?.getItem(TUTORIAL_DISMISSED_KEY) === '1'; } catch { return false; } })(),
    lastRestWarnAt: 0,
    dom: { bar: null, picker: null, conv: null, tutorial: null },
  };

  const settingsNow = () => api._shellContext?.settings ?? null;
  const storageKeyFor = () => `${QUICKSLOT_STORAGE_PREFIX}${api.selfId ?? 'guest'}`;

  function loadSlots() {
    let saved = null;
    try { saved = JSON.parse(storage?.getItem(storageKeyFor()) ?? 'null'); } catch { saved = null; }
    S.slots = autoPopulateQuickslots(api.character, saved);
  }

  function saveSlots() {
    try { storage?.setItem(storageKeyFor(), JSON.stringify(S.slots)); } catch { /* ignore */ }
  }

  function assignSlot(index, item) {
    if (index < 0 || index >= QUICKSLOT_COUNT) return;
    S.slots[index] = item ? { kind: 'item', itemId: String(item.id), label: item.name ?? item.template ?? String(item.id) } : null;
    S.pickerSlot = null;
    saveSlots();
    renderQuickslots();
  }

  function activateSlot(index) {
    const slot = S.slots[index];
    S.selectedSlot = index;
    if (!slot) {
      S.pickerSlot = S.pickerSlot === index ? null : index;
      renderQuickslots();
      return false;
    }
    const act = quickslotActivation(slot, api.character);
    if (!act) {
      api.message('That quickslot item is no longer in your pack.', { kind: 'error' });
      S.slots[index] = null;
      saveSlots();
      renderQuickslots();
      return false;
    }
    api.act(act.verb, act.args);
    renderQuickslots();
    return true;
  }

  // ---- DOM mounting (no-op in Node unit tests)

  function ensureHudNodes() {
    if (typeof document === 'undefined') return false;
    loadStyles();
    const hud = document.getElementById('hud');
    if (!hud) return false;
    if (!S.dom.bar) {
      S.dom.bar = el('section', { id: 'hud-quickslots', class: 'qs-bar', 'aria-label': t('quickslots.title') });
      S.dom.picker = el('div', { id: 'hud-quickslot-picker', class: 'qs-picker', hidden: true, role: 'dialog', 'aria-label': 'Assign quickslot' });
      S.dom.conv = el('aside', { id: 'hud-conveniences', class: 'hud-conv', 'aria-label': 'HUD status indicators' });
      S.dom.tutorial = el('aside', { id: 'hud-tutorial', class: 'hud-tutorial', 'aria-label': "Privateer's Hold tutorial", hidden: true });
      hud.append(S.dom.bar, S.dom.picker, S.dom.conv, S.dom.tutorial);
    }
    return true;
  }

  function renderQuickslots() {
    if (!ensureHudNodes()) return;
    const show = api.screen === 'game';
    S.dom.bar.hidden = !show;
    if (!show) { S.dom.picker.hidden = true; return; }
    const inv = Array.isArray(api.character?.inventory) ? api.character.inventory : [];
    const byId = new Map(inv.map((it) => [String(it.id), it]));
    const eqIds = new Set(Object.values(api.character?.equipment ?? {}).map(String));

    S.dom.bar.replaceChildren(...S.slots.map((slot, i) => {
      const item = slot ? byId.get(slot.itemId) : null;
      const equipped = item && eqIds.has(String(item.id));
      const qty = item && Number.isFinite(item.quantity) && item.quantity > 1 ? `×${item.quantity}` : '';
      const shortName = item ? String(item.name ?? item.template ?? '').slice(0, 14) : (slot?.label?.slice(0, 14) || t('quickslots.empty'));
      return el('div', { class: 'qs-cell' },
        el('button', {
          type: 'button',
          class: `qs-slot${equipped ? ' is-equipped' : ''}${S.selectedSlot === i ? ' is-selected' : ''}${!item ? ' is-empty' : ''}`,
          'data-slot': String(i + 1),
          title: item ? `${item.name ?? item.template} (Press ${i + 1})` : `Assign slot ${i + 1}`,
          onclick: () => activateSlot(i),
          oncontextmenu: (ev) => { ev.preventDefault(); S.pickerSlot = S.pickerSlot === i ? null : i; renderQuickslots(); },
        },
          el('kbd', { class: 'qs-key', text: String(i + 1) }),
          el('span', { class: 'qs-name', text: shortName }),
          qty ? el('span', { class: 'qs-qty', text: qty }) : null),
        el('button', {
          type: 'button', class: 'qs-edit-btn', title: `Assign slot ${i + 1}`, 'aria-label': `Assign quickslot ${i + 1}`,
          onclick: (ev) => { ev.stopPropagation(); S.pickerSlot = S.pickerSlot === i ? null : i; renderQuickslots(); },
          text: '⋯',
        }));
    }));

    // Slot assignment picker
    if (S.pickerSlot === null) {
      S.dom.picker.hidden = true;
      return;
    }
    const candidates = quickslotCandidates(api.character);
    S.dom.picker.hidden = false;
    S.dom.picker.replaceChildren(
      el('div', { class: 'qs-picker-head' },
        el('strong', { text: `Assign Quickslot ${S.pickerSlot + 1}` }),
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => { S.pickerSlot = null; renderQuickslots(); }, text: '×' })),
      candidates.length
        ? el('ul', { class: 'qs-picker-list' }, ...candidates.map((it) => el('li', {},
          el('button', {
            type: 'button', class: 'qs-pick-item',
            onclick: () => assignSlot(S.pickerSlot, it),
          }, `${it.name ?? it.template}${it.quantity > 1 ? ` ×${it.quantity}` : ''} (${isWeaponItem(it) ? 'Weapon' : 'Consumable'})`))))
        : el('p', { class: 'qs-picker-empty', text: 'No weapons or consumables in inventory.' }),
      el('div', { class: 'qs-picker-foot' },
        el('button', { type: 'button', class: 'btn btn-small', onclick: () => assignSlot(S.pickerSlot, null), text: 'Clear slot' })));
  }

  function renderConveniences() {
    if (!ensureHudNodes()) return;
    if (api.screen !== 'game') {
      S.dom.conv.hidden = true;
      S.dom.tutorial.hidden = true;
      return;
    }
    const chips = [];

    // 1. Arrow count
    const arrows = arrowStatusOf(api.character);
    if (arrows.show) {
      chips.push(el('div', {
        class: `hud-chip hud-chip-arrows${arrows.empty ? ' is-danger' : arrows.low ? ' is-warn' : ''}`,
        'data-hud-chip': 'arrows',
      }, arrows.empty ? t('hud.arrowsEmpty') : t('hud.arrows', { count: arrows.count })));
    }

    // 2. Quest deadline countdown
    const nowMin = api.worldMinutes?.() ?? api.character?.quests?.minutes ?? null;
    const deadline = soonestQuestDeadline(api.character, nowMin);
    if (deadline) {
      chips.push(el('button', {
        type: 'button',
        class: `hud-chip hud-chip-quest${deadline.urgent ? ' is-warn' : ''}`,
        'data-hud-chip': 'deadline',
        onclick: () => api.openPanel('journal'),
        title: 'Open Quest Journal',
      }, `⏳ ${t('hud.questDeadline', { title: deadline.title.slice(0, 22), remaining: deadline.text })}`));
    }

    // 3. Rest warnings (show danger/warn badge when conditions/enemies make resting risky)
    const restWarns = restWarningsFor(api.state, api.camera);
    const highWarn = restWarns.find((w) => w.severity === 'danger' || w.severity === 'warn');
    if (highWarn) {
      chips.push(el('div', {
        class: `hud-chip hud-chip-rest is-${highWarn.severity}`,
        'data-hud-chip': 'rest-warning',
        title: highWarn.text,
      }, `⚠ ${highWarn.text}`));
    }

    // 4. Dungeon-exit wagon prompt
    const wagon = dungeonWagonPrompt(api.state, api.camera, api.town);
    if (wagon) {
      chips.push(el('button', {
        type: 'button',
        class: 'hud-chip hud-chip-wagon is-accent',
        'data-hud-chip': 'wagon',
        onclick: () => api.openPanel('property'),
      }, `🐴 ${wagon.text} (${wagon.distance}m)`));
    }

    // 5. Quick Help chip (always accessible)
    chips.push(el('button', {
      type: 'button',
      class: 'hud-chip hud-chip-help',
      'data-hud-chip': 'help',
      onclick: () => api.togglePanel(HELP_PANEL_ID),
      title: 'Searchable contextual Help (F5)',
    }, '? Help (F5)'));

    S.dom.conv.hidden = false;
    S.dom.conv.replaceChildren(...chips);

    // 6. Updated Privateer's Hold opening tutorial prompt
    const inPrivateers = /privateer/i.test(String(api.location ?? ''));
    const showTut = (S.tutorialOpen || (inPrivateers && !S.tutorialDismissed)) && !api.modalOpen;
    S.dom.tutorial.hidden = !showTut;
    if (showTut) {
      const steps = tutorialStepsFor(settingsNow(), { gamepadConnected: document.body.hasAttribute('data-gamepad') });
      const idx = Math.max(0, Math.min(steps.length - 1, S.tutorialStep));
      const step = steps[idx];
      S.dom.tutorial.replaceChildren(
        el('div', { class: 'tut-head' },
          el('strong', { text: `Opening Guide — ${step.title}` }),
          el('span', { class: 'tut-step', text: `${idx + 1}/${steps.length}` })),
        el('p', { class: 'tut-body', text: step.body }),
        el('div', { class: 'tut-actions' },
          el('button', { type: 'button', class: 'btn btn-small', disabled: idx === 0, onclick: () => { S.tutorialStep = Math.max(0, idx - 1); renderConveniences(); }, text: 'Prev' }),
          el('button', { type: 'button', class: 'btn btn-small', disabled: idx >= steps.length - 1, onclick: () => { S.tutorialStep = Math.min(steps.length - 1, idx + 1); renderConveniences(); }, text: 'Next' }),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => api.openPanel(HELP_PANEL_ID), text: 'Full Help' }),
          el('button', {
            type: 'button', class: 'btn btn-small',
            onclick: () => {
              S.tutorialOpen = false;
              S.tutorialDismissed = true;
              try { storage?.setItem(TUTORIAL_DISMISSED_KEY, '1'); } catch { /* ignore */ }
              renderConveniences();
            },
            text: 'Dismiss',
          })));
    }
  }

  // ---- Searchable Contextual Help panel

  function renderHelpPanel(container) {
    const entries = buildHelpEntries(settingsNow(), { location: api.location, readied: readiedOf(api.state) });
    const filtered = filterHelpEntries(entries, S.helpQuery);
    const steps = tutorialStepsFor(settingsNow(), { gamepadConnected: typeof document !== 'undefined' && document.body.hasAttribute('data-gamepad') });

    const searchInput = el('input', {
      id: 'help-search-input',
      type: 'search',
      class: 'help-search-input',
      value: S.helpQuery,
      placeholder: t('help.searchPlaceholder'),
      'aria-label': 'Search help topics and bindings',
      oninput: (ev) => { S.helpQuery = ev.target.value; renderHelpList(listEl); },
    });
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());

    const listEl = el('div', { class: 'help-entries' });
    const renderHelpList = (target) => {
      const matches = filterHelpEntries(buildHelpEntries(settingsNow(), { location: api.location, readied: readiedOf(api.state) }), S.helpQuery);
      if (!matches.length) {
        target.replaceChildren(el('p', { class: 'menu-empty', text: `No help entries match "${S.helpQuery}".` }));
        return;
      }
      target.replaceChildren(...matches.map((item) => el('article', { class: 'help-card', 'data-help-id': item.id },
        el('div', { class: 'help-card-head' },
          el('span', { class: 'help-cat', text: item.category }),
          el('strong', { text: item.title }),
          el('kbd', { class: 'help-bind', text: item.binding })),
        el('p', { class: 'help-card-body', text: item.text }))));
    };
    renderHelpList(listEl);

    const tutSection = el('section', { class: 'help-tutorial-box' },
      el('div', { class: 'help-tut-header' },
        el('h4', { text: "Privateer's Hold Opening Tutorial (Active Bindings)" }),
        el('button', {
          type: 'button', class: 'btn btn-small',
          onclick: () => { S.tutorialOpen = true; S.tutorialStep = 0; api.closePanel(); renderConveniences(); },
          text: 'Show on HUD',
        })),
      el('ol', { class: 'help-tut-list' }, ...steps.map((s) => el('li', {},
        el('strong', { text: `${s.title}: ` }), s.body))));

    container.replaceChildren(
      el('div', { class: 'help-root' },
        el('div', { class: 'help-search-bar' },
          searchInput,
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => { S.helpQuery = ''; searchInput.value = ''; renderHelpList(listEl); searchInput.focus(); }, text: 'Clear' }),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => api.openPanel('settings'), text: 'Remap Keys' })),
        listEl,
        tutSection));
  }

  api.registerPanel(HELP_PANEL_ID, 'Help', renderHelpPanel, { key: HELP_PANEL_KEY, watch: 'none' });

  // ---- Subscriptions & keyboard hotkeys (1-8 for quickslots)

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (api.screen !== 'game' || api.modalOpen || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      const m = /^Digit([1-8])$/.exec(e.code);
      if (m) {
        e.preventDefault();
        activateSlot(Number(m[1]) - 1);
      }
    });
  }

  api.on('state', () => {
    const key = `${api.account?.id ?? ''}:${api.selfId ?? 'guest'}`;
    if (key !== S.ownerKey) {
      S.ownerKey = key;
      loadSlots();
    } else {
      S.slots = autoPopulateQuickslots(api.character, S.slots);
    }
    renderQuickslots();
    renderConveniences();
  });
  api.on('screen', () => { renderQuickslots(); renderConveniences(); });
  api.on('location', () => renderConveniences());
  api.on('settingsChanged', () => {
    renderConveniences();
    if (api.panel === HELP_PANEL_ID) api.refreshPanel(HELP_PANEL_ID);
  });
  api.on('panel', ({ id, open } = {}) => {
    if (id === 'rest' && open) {
      const warns = restWarningsFor(api.state, api.camera);
      const now = Date.now();
      if (warns.length && now - S.lastRestWarnAt > 3000) {
        S.lastRestWarnAt = now;
        api.message(warns[0].text, { kind: warns[0].severity === 'danger' ? 'error' : 'info' });
      }
    }
    renderConveniences();
  });
  let lastConvFrame = 0;
  api.on('frame', () => {
    const now = Date.now();
    if (now - lastConvFrame > 450) {
      lastConvFrame = now;
      renderConveniences();
    }
  });

  api.quickslots = {
    getSlots: () => S.slots.map((s) => (s ? { ...s } : null)),
    assignSlot,
    activateSlot,
    openTutorial: () => { S.tutorialOpen = true; S.tutorialStep = 0; renderConveniences(); },
  };

  return api.quickslots;
}

export default { name: 'quickslots', install };
