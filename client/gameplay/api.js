// Browser gameplay API handed to every `client/gameplay/<feature>.js` install(api).
// See docs/gameplay-protocol.md ("Browser features") and client/hud-contract.md ("Game shell").
//
// This module is DOM-free so it can be unit tested in Node: the shell (shell.js) supplies
// the menu UI through `attachShell`, and main.js supplies networking, rendering and the scene.

export const DEFAULT_LOCATION = 'town:Daggerfall/Gothway Garden';

/** Menu sections in rail order. `key` is the default KeyboardEvent.code that opens it. */
export const PANELS = Object.freeze([
  { id: 'character', title: 'Character', key: 'KeyC' },
  { id: 'inventory', title: 'Inventory', key: 'KeyI' },
  { id: 'spellbook', title: 'Spellbook', key: 'KeyB' },
  { id: 'journal', title: 'Journal', key: 'KeyJ' },
  { id: 'map', title: 'Map', key: 'KeyM' },
  { id: 'party', title: 'Party', key: 'KeyO' },
  { id: 'interaction', title: 'Interaction', key: null },
  { id: 'settings', title: 'Settings', key: 'F10' },
]);

/** Rebindable actions → default KeyboardEvent.code. Esc, Enter, Tab and movement are fixed. */
export const DEFAULT_BINDINGS = Object.freeze({
  ready: 'KeyF',
  attack: 'Space',
  interact: 'KeyG',
  character: 'KeyC',
  inventory: 'KeyI',
  spellbook: 'KeyB',
  journal: 'KeyJ',
  map: 'KeyM',
  party: 'KeyO',
  settings: 'F10',
  people: 'KeyP',
  chat: 'KeyT',
  // Traversal (client/lib/locomotion.js). Run and walk-slowly are held; crouch toggles on the ground
  // and is held to dive while swimming or to sink while levitating; jump is held to rise.
  run: 'ShiftLeft',
  slow: 'AltLeft',
  jump: 'KeyZ', // R opens Rest (atmosphere), H mounts (mount), V casts (magic)
  crouch: 'KeyX',
  // Classic activation modes (DFU defaults F1-F4): what the interact key does to the target.
  modeSteal: 'F1',
  modeGrab: 'F2',
  modeInfo: 'F3',
  modeTalk: 'F4',
});

/** Classic activation modes (PlayerActivate.PlayerActivateModes) and their default. */
export const ACTIVATION_MODES = Object.freeze(['steal', 'grab', 'info', 'talk']);
export const MODE_ACTIONS = Object.freeze({ modeSteal: 'steal', modeGrab: 'grab', modeInfo: 'info', modeTalk: 'talk' });
export const MODE_LABELS = Object.freeze({ steal: 'Steal', grab: 'Grab', info: 'Info', talk: 'Talk' });

export const BINDING_LABELS = Object.freeze({
  ready: 'Ready / sheathe weapon',
  attack: 'Attack',
  interact: 'Talk / use / interact',
  character: 'Character sheet',
  inventory: 'Inventory',
  spellbook: 'Spellbook',
  journal: 'Journal',
  map: 'Map and travel',
  party: 'Party and trade',
  settings: 'Settings',
  people: 'People in this place',
  chat: 'Speak',
  run: 'Run (hold)',
  slow: 'Walk slowly (hold)',
  jump: 'Jump / swim up / rise',
  crouch: 'Crouch and sneak / dive / sink',
  modeSteal: 'Activation mode: Steal',
  modeGrab: 'Activation mode: Grab',
  modeInfo: 'Activation mode: Info',
  modeTalk: 'Activation mode: Talk',
});

/** Keys that can never be bound to an action (movement, turning, menus, focus, chat). */
export const RESERVED_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Escape', 'Tab', 'Enter', 'NumpadEnter',
]);

export function keyLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'Space';
  if (code.startsWith('Arrow')) return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code];
  return code.replace(/^Numpad/, 'Num ');
}

/** Validate and merge saved bindings over the defaults. Duplicate keys keep the first action. */
export function normalizeBindings(saved) {
  const out = { ...DEFAULT_BINDINGS };
  if (!saved || typeof saved !== 'object') return out;
  for (const [action, code] of Object.entries(saved)) {
    if (!(action in DEFAULT_BINDINGS)) continue;
    if (code === null) { out[action] = null; continue; }
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{2,20}$/.test(code) || RESERVED_CODES.has(code)) continue;
    out[action] = code;
  }
  const seen = new Set();
  for (const action of Object.keys(DEFAULT_BINDINGS)) {
    const c = out[action];
    if (!c) continue;
    if (seen.has(c)) out[action] = null;
    else seen.add(c);
  }
  return out;
}

/** Re-bind `action` to `code`, unbinding any other action that used it. */
export function rebind(bindings, action, code) {
  if (!(action in DEFAULT_BINDINGS)) throw new Error(`Unknown action ${action}`);
  if (code && RESERVED_CODES.has(code)) throw new Error(`${keyLabel(code)} is reserved.`);
  const out = { ...bindings };
  for (const a of Object.keys(out)) if (code && out[a] === code) out[a] = null;
  out[action] = code || null;
  return out;
}

export function actionForCode(bindings, code) {
  for (const [action, c] of Object.entries(bindings)) if (c === code) return action;
  return null;
}

// ---------------------------------------------------------------- state helpers

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const capitalise = (t) => (t ? String(t)[0].toUpperCase() + String(t).slice(1) : t);

/**
 * Merge an incoming RPG message over the previous one: keys present replace, absent keep. `entityDelta`
 * `{upsert?, patch?, remove?}` patches `entities` and `peerDelta` `{upsert?, remove?}` patches `peers`, by id
 * (a `patch` entry carries only the changed fields, `$del` lists removed ones).
 */
export function mergeRpg(prev, msg) {
  if (!isObj(msg)) return prev;
  const next = { ...(prev || { character: null, entities: [], peers: [], selfId: null }) };
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'type' || k === 'entityDelta' || k === 'peerDelta') continue;
    next[k] = v;
  }
  if (isObj(msg.entityDelta) && !('entities' in msg)) next.entities = patchById(next.entities, msg.entityDelta);
  if (isObj(msg.peerDelta) && !('peers' in msg)) next.peers = patchById(next.peers, msg.peerDelta);
  return next;
}

function patchById(list, delta) {
  const remove = new Set((Array.isArray(delta.remove) ? delta.remove : []).map(String));
  const byId = new Map();
  for (const u of Array.isArray(delta.upsert) ? delta.upsert : []) if (isObj(u) && u.id !== undefined && u.id !== null) byId.set(String(u.id), u);
  const patches = new Map();
  for (const u of Array.isArray(delta.patch) ? delta.patch : []) if (isObj(u) && u.id !== undefined && u.id !== null) patches.set(String(u.id), u);
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!isObj(e)) continue;
    const id = e.id !== undefined && e.id !== null ? String(e.id) : null;
    if (id !== null && remove.has(id)) continue;
    if (id !== null && byId.has(id)) {
      out.push(byId.get(id));
      byId.delete(id);
    } else if (id !== null && patches.has(id)) {
      const { $del, ...set } = patches.get(id);
      const merged = { ...e, ...set };
      if (Array.isArray($del)) for (const k of $del) delete merged[k];
      out.push(merged);
    } else {
      out.push(e);
    }
  }
  for (const u of byId.values()) out.push(u);
  return out;
}

/** Location string from a merged RPG state, accepting either `character.location` or a top-level `location`. */
export function locationOf(state) {
  if (!state) return null;
  const c = state.character;
  const loc = (isObj(c) && typeof c.location === 'string' && c.location) || (typeof state.location === 'string' && state.location) || null;
  return loc;
}

/** Readable name for a location id such as `town:Daggerfall/Gothway Garden`. */
export function locationName(loc, wilderness, scene, portal) {
  if (!loc) return '';
  if ((loc.startsWith('dungeon:') || loc.startsWith('interior:')) && scene?.location === loc && scene.name) return scene.name;
  if (loc.startsWith('interior:')) {
    const door = portal?.to === loc ? portal : null;
    const town = door?.townName || (!/^interior:\d+\/\d+\//.test(loc) && loc.split('/')[1]);
    const building = door?.label || 'Building';
    return town ? `${building}, ${town}` : building;
  }
  if (/^dungeon:\d+\/\d+$/.test(loc)) return (portal?.to === loc && portal.label) || 'Dungeon';
  if (/^town:\d+\/\d+$/.test(loc)) {
    const source = scene?.source;
    if (source && loc === `town:${source.regionIndex}/${source.locationIndex}`) return scene.displayName || scene.name || 'Iliac Bay';
    return 'Iliac Bay';
  }
  if (scene?.displayName && loc === `town:${scene.region}/${scene.name}`) return scene.displayName;
  if (loc.startsWith('wilderness:')) {
    const current = wilderness?.nearby?.find(site => site.id === wilderness.site);
    return current?.name || 'Wilderness';
  }
  const body = String(loc).replace(/^[a-z]+:/i, '');
  const parts = body.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : body;
}

/** The record holding classic stats: `character.character` when nested (p.rpg), else `character`. */
export function statsOf(state) {
  const c = state?.character;
  if (!isObj(c)) return null;
  return isObj(c.character) ? c.character : c;
}

/** Numeric vitals `{health:[cur,max], fatigue:[..], magicka:[..]}`, null entries when unknown. */
export function vitalsOf(state) {
  const s = statsOf(state);
  const pair = (cur, max) => (Number.isFinite(s?.[cur]) && Number.isFinite(s?.[max]) && s[max] > 0
    ? [Math.max(0, Math.round(s[cur])), Math.round(s[max])] : null);
  return { health: pair('health', 'maxHealth'), fatigue: pair('fatigue', 'maxFatigue'), magicka: pair('magicka', 'maxMagicka') };
}

/** Is the weapon readied (`rpg.readied`)? */
export function readiedOf(state) {
  const c = state?.character;
  return !!(isObj(c) && (c.readied ?? statsOf(state)?.readied));
}

/** Entities and peers that can be targeted, as {id, kind, name, x, z, ...}. */
export function targetables(state, selfId) {
  const out = [];
  for (const e of state?.entities ?? []) if (isObj(e) && Number.isFinite(e.x) && Number.isFinite(e.z)) out.push(e);
  for (const p of state?.peers ?? []) {
    if (!isObj(p) || String(p.id) === String(selfId ?? state?.selfId)) continue;
    if (Number.isFinite(p.x) && Number.isFinite(p.z)) out.push({ kind: 'player', ...p, id: String(p.id) });
  }
  return out;
}

/**
 * Pick the candidate nearest the crosshair: within `range` metres and `cone` radians of the
 * camera yaw. Dead creatures are only picked when nothing living is in view. Returns an id or null.
 */
export function pickTarget(camera, candidates, { range = 6, cone = 0.42 } = {}) {
  if (!camera) return null;
  let best = null, bestScore = Infinity;
  for (const e of candidates) {
    const dx = e.x - camera.x, dz = e.z - camera.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range) continue;
    // yaw 0 looks toward -z, positive yaw toward +x.
    const bearing = Math.atan2(dx, -dz);
    let off = bearing - camera.yaw;
    off = Math.atan2(Math.sin(off), Math.cos(off));
    const allowed = dist < 1.2 ? Math.max(cone, 0.9) : cone; // very close: generous
    if (Math.abs(off) > allowed) continue;
    const dead = e.dead === true || (Number.isFinite(e.hp) && e.hp <= 0);
    const score = Math.abs(off) * 2 + dist * 0.15 + (dead ? 10 : 0);
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best ? String(best.id) : null;
}

/**
 * What the interact key should do for a target, using verbs the server registers:
 * `{verb, args}` to send, `{panel, args}` to open a menu page, or null when there is nothing to
 * do. Other kinds (doors, shrines, …) return null so the shell's `interactIntent` event lets the
 * feature that owns them respond.
 */
export function interactionFor(entity) {
  if (!entity) return null;
  const id = String(entity.id);
  switch (entity.kind) {
    case 'npc': return { verb: 'npc.talk', args: { targetId: id } };
    case 'loot': return { verb: 'inventory.inspectLoot', args: { targetId: id } };
    case 'container': return { verb: 'container.open', args: { containerId: id } };
    case 'monster':
      return entity.dead && entity.lootable && !entity.looted ? { verb: 'combat.loot', args: { targetId: id } } : null;
    case 'player':
      if (entity.defeated) return { verb: 'combat.revive', args: { targetId: id } };
      return { panel: 'party', args: { targetId: id } };
    default: return null;
  }
}

// ---------------------------------------------------------------- the API object

/**
 * @param {object} host
 * @param {(verb:string,args:object)=>boolean} host.send  sends `{type:'action',verb,args}`
 * @param {(mesh:any)=>void} [host.applyScene]           uploads a mesh to the current renderer
 * @param {(text:string,opts:object)=>void} [host.notify] shows feedback to the player
 */
export function createGameplayApi(host = {}) {
  const listeners = new Map();
  const panels = new Map(); // id -> {id,title,render,key,order,builtin}
  let shell = null; // { open(id), close(), refresh(id?), isOpen }
  let externalTarget = false;
  let sceneSeq = 0;
  let target = null;

  const api = {
    state: null,
    files: [],
    location: null,
    frame: null,
    renderer: null,
    camera: null,
    town: null,
    screen: 'landing',
    selfId: null,
    account: null,
    modalOpen: false,
    panel: null,
    /** Set to true by a sprite/actor feature once it draws peers itself; the shell then hides its cube avatars. */
    spritesActive: false,
    /** Optional collision hook a feature may install: (x0,z0,x1,z1) => {x,z}. */
    constrainMove: null,
    /** Optional speed hook: () => m/s for the local player's prediction, or null for walking (mount feature). */
    moveSpeed: null,
    /**
     * Classic activation mode for the interact key: 'steal' | 'grab' | 'info' | 'talk' (F1-F4). Set through
     * setActivationMode, which emits `activationMode` {mode}. The activation intent detail carries `mode`.
     */
    activationMode: 'grab',
    setActivationMode(mode) {
      if (!ACTIVATION_MODES.includes(mode) || mode === api.activationMode) return false;
      api.activationMode = mode;
      api.emit('activationMode', { mode });
      return true;
    },
    /**
     * The local body each frame (client/lib/locomotion.js, published by main.js): {mode, grounded, swimming,
     * underwater, climbing, levitating, crouch, running, slow, speed, y, breath, maxBreath, lowBreath, waterBreathing, surface?}. The
     * `movement` event carries one-off traversal events ({kind:'jump'|'land'|'swim'|'submerge'|'surface'|'climb'|'stance', ...}).
     */
    movement: null,
    /** True while a feature holds the player still (travel journey). Movement input is ignored. */
    movementLocked: false,
    /** Camera adjusters run in order each frame: (camera, {dt, now, moving, footY}) => camera | undefined. */
    viewTransforms: [],
    /** Other players at interpolated positions for the current frame: [{id,name,x,y,z,yaw,moving}]. */
    peers: [],
    /** One interpolated peer by id, or null. */
    peer(id) { return api.peers.find((p) => p.id === String(id)) ?? null; },

    on(name, fn) {
      if (typeof fn !== 'function') throw new TypeError('api.on needs a function');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    emit(name, detail) {
      const set = listeners.get(name);
      if (!set) return 0;
      let n = 0;
      for (const fn of [...set]) {
        try { fn(detail); n++; } catch (err) { console.error(`[gameplay] '${name}' handler failed:`, err); }
      }
      return n;
    },

    /**
     * Send gameplay intent. Returns false when it could not be sent (offline), else a promise
     * resolving — never rejecting — to `{ok, verb, error?}` once the server answers. Failures are
     * shown to the player unless `opts.quiet` is set (for callers that display their own).
     */
    act(verb, args = {}, opts = {}) {
      let r;
      try { r = host.send?.(verb, args); } catch (err) { r = false; console.error('[gameplay] send failed:', err); }
      if (!r) {
        if (!opts.quiet) api.message('Not connected — action not sent.', { kind: 'error' });
        return false;
      }
      if (typeof r.then !== 'function') return Promise.resolve({ ok: true, verb });
      return r.then((res) => {
        const out = res && typeof res === 'object' ? res : { ok: !!res, verb };
        if (!out.ok && !opts.quiet && out.error && !out.closed) api.message(capitalise(out.error), { kind: 'error', verb });
        api.emit('actionResult', out);
        return out;
      }, (err) => ({ ok: false, verb, error: err?.message ?? String(err) }));
    },

    message(text, opts = {}) {
      if (!text) return;
      host.notify?.(String(text), opts);
      api.emit('message', { text: String(text), ...opts });
    },

    registerPanel(id, title, render, opts = {}) {
      if (typeof id !== 'string' || !id) throw new TypeError('registerPanel needs an id');
      if (typeof render !== 'function') throw new TypeError('registerPanel needs a render function');
      const known = PANELS.find((p) => p.id === id);
      const prev = panels.get(id);
      // Feature panels replace the shell's built-in fallback; a second feature panel is refused.
      if (prev && !prev.builtin && !opts.builtin) {
        console.warn(`[gameplay] panel '${id}' is already registered; keeping the first`);
        return false;
      }
      if (prev && !prev.builtin && opts.builtin) return false;
      panels.set(id, {
        id, title: String(title || known?.title || id), render,
        key: opts.key ?? known?.key ?? null,
        order: opts.order ?? (known ? PANELS.indexOf(known) : 100 + panels.size),
        listed: opts.listed !== false,
        builtin: !!opts.builtin,
        // Which state changes re-render the open panel: 'character' (default: the player's own
        // record), 'all' (also entities and peers), 'none' (the feature refreshes itself with
        // api.refreshPanel), or a function (state) => any whose result is compared by JSON.
        watch: opts.watch ?? 'character',
      });
      shell?.panelsChanged?.();
      return true;
    },
    panels() { return [...panels.values()].filter((p) => p.listed).sort((a, b) => a.order - b.order); },
    getPanel(id) { return panels.get(id) ?? null; },
    openPanel(id, detail) {
      if (!panels.has(id)) { api.message(`${id} is not available.`, { kind: 'error' }); return false; }
      shell?.open(id, detail);
      return true;
    },
    closePanel() { shell?.close(); },
    togglePanel(id) {
      if (api.panel === id) api.closePanel();
      else api.openPanel(id);
    },
    /** Re-render the open panel (or a specific one if it is open). */
    refreshPanel(id) { if (!id || id === api.panel) shell?.refresh(); },

    /** Look up an entity or peer by id from the latest state. */
    entity(id) {
      if (id === null || id === undefined) return null;
      const s = String(id);
      return targetables(api.state, api.selfId).find((e) => String(e.id) === s) ?? null;
    },
    get character() { return api.state?.character ?? null; },
    get stats() { return statsOf(api.state); },
    get readied() { return readiedOf(api.state); },

    /** Set the crosshair target (actor/combat features). Pass null to clear. Takes over from the shell's fallback picker. */
    setTarget(id, { owner = 'feature' } = {}) {
      if (owner !== 'shell') externalTarget = true;
      const next = id === null || id === undefined ? null : String(id);
      if (next === target) return;
      target = next;
      api.emit('target', { id: next, entity: api.entity(next) });
    },
    get targetOwnedByFeature() { return externalTarget; },

    /**
     * Replace the world mesh for the current location. `meshOrPromise` may be a promise; a
     * result that arrives after another travel or setScene call is dropped. With
     * `{location}`, a mesh for a location other than the current one is dropped too.
     * Resolves true when the scene was applied.
     */
    async setScene(meshOrPromise, { location } = {}) {
      const seq = ++sceneSeq;
      const mesh = await meshOrPromise;
      if (seq !== sceneSeq) return false;
      // A travel journey on screen (client/gameplay/journey.js) shows the new place only once its map covers the old one.
      const gate = typeof api.journeyGate === 'function' ? api.journeyGate() : null;
      if (gate) {
        await gate;
        if (seq !== sceneSeq) return false;
      }
      if (location !== undefined && location !== api.location) return false;
      if (!mesh) return false;
      host.applyScene?.(mesh);
      api.town = mesh;
      api.emit('scene', mesh);
      return true;
    },
    /** Invalidate pending setScene promises (called by the shell on travel). */
    _invalidateScenes() { sceneSeq++; },

    // ---- shell hooks (used by main.js / shell.js only)
    _attachShell(s) { shell = s; },
    _setModal(open, panelId) {
      api.modalOpen = !!open;
      api.panel = open ? panelId ?? null : null;
    },
  };

  // `api.target = id` from a feature is the same as api.setTarget(id).
  Object.defineProperty(api, 'target', {
    enumerable: true,
    get: () => target,
    set: (id) => api.setTarget(id),
  });

  /** Accept a new RPG message; emits 'state', and 'location' when it changes. Returns {location changed?}. */
  api._receiveRpg = (msg) => {
    api.state = mergeRpg(api.state, msg);
    if (api.state.selfId) api.selfId = String(api.state.selfId);
    const loc = locationOf(api.state) ?? api.location ?? DEFAULT_LOCATION;
    const previous = api.location;
    const changed = previous !== null && loc !== previous;
    api.location = loc;
    if (changed) {
      sceneSeq++;
      externalTarget = false;
      api.setTarget(null, { owner: 'shell' });
    }
    api.emit('state', api.state);
    if (changed || previous === null) {
      api.emit('location', { location: loc, previous, peers: api.state.peers ?? [], name: locationName(loc, api.character?.wilderness, api.town, api.character?.portal) });
    }
    return { locationChanged: changed };
  };

  api._reset = () => {
    api.state = null;
    api.location = null;
    api.selfId = null;
    externalTarget = false;
    target = null;
    sceneSeq++;
  };

  return api;
}

/** The value compared between states to decide whether an open panel re-renders. */
export function watchKey(panel, state) {
  const w = panel?.watch ?? 'character';
  if (w === 'none') return null;
  let v;
  if (typeof w === 'function') {
    try { v = w(state); } catch { v = Math.random(); }
  } else if (w === 'all') v = state ? [state.character, state.entities, state.peers] : null;
  else v = state?.character ?? null;
  try { return JSON.stringify(v ?? null); } catch { return String(Math.random()); }
}

/** Normalise a feature manifest entry to an install function (module namespace, object or function). */
export function installerOf(entry) {
  if (typeof entry === 'function') return entry;
  if (entry && typeof entry.install === 'function') return entry.install.bind(entry);
  if (entry && entry.default && typeof entry.default.install === 'function') return entry.default.install.bind(entry.default);
  return null;
}

/** Install every feature, isolating failures. Returns [{name, ok, error?}]. */
export async function installFeatures(api, entries) {
  const results = [];
  for (const [i, entry] of (entries ?? []).entries()) {
    const name = entry?.name || entry?.id || entry?.default?.name || `feature ${i + 1}`;
    const install = installerOf(entry);
    if (!install) { results.push({ name, ok: false, error: new Error('no install(api) export') }); continue; }
    try {
      await install(api);
      results.push({ name, ok: true });
    } catch (error) {
      console.error(`[gameplay] ${name} failed to install:`, error);
      results.push({ name, ok: false, error });
    }
  }
  return results;
}

/** Collect manifest entries from `client/gameplay/features.js` (default array, or named exports). */
export function manifestEntries(mod) {
  if (!mod) return [];
  if (Array.isArray(mod.default)) return mod.default;
  if (Array.isArray(mod.features)) return mod.features;
  return Object.entries(mod)
    .filter(([k]) => k !== 'default')
    .map(([k, v]) => (v && typeof v === 'object' && !v.name ? { name: k, ...v, install: v.install } : v))
    .filter((v) => installerOf(v));
}
