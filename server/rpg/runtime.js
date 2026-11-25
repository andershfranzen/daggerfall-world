// Shared online RPG runtime (docs/gameplay-protocol.md, docs/rpg-runtime.md).
//
// Owns the feature registry and the server-authoritative action transaction:
//   - features register handlers through `ctx` once per server instance;
//   - an action runs synchronously; every affected player's `rpg` is snapshotted, all affected
//     players are saved in ONE store transaction, and on any failure (handler error or save error)
//     their `rpg` is restored and buffered events are discarded;
//   - private `{type:'rpg'}` snapshots are diffed per client and only sent when their content changes.
import { performance } from 'node:perf_hooks';
import { isAbsolute, relative, resolve } from 'node:path';

export const DEFAULT_LOCATION = 'town:Daggerfall/Gothway Garden';

export const ARG_LIMITS = Object.freeze({
  maxDepth: 6,
  maxNodes: 256,
  maxKeys: 64,
  maxKeyLength: 64,
  maxStringLength: 1000,
});

// Lower-case dotted verbs: `combat.attack`, `inventory.equip`, `npc.talk`.
const VERB_RE = /^[a-z][A-Za-z0-9]{0,31}(?:\.[a-z][A-Za-z0-9]{0,31}){1,3}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** An Error whose message is safe and meant for the player. Plain `Error`s are treated the same. */
export class ActionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionError';
    this.expose = true;
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;

/** Fields of `rpg.character` copied into public peers (browser actor appearance). */
export const PUBLIC_CHARACTER_FIELDS = Object.freeze(['race', 'gender', 'className']);

/** Only plain `Error`/`ActionError` (or `err.expose === true`) messages reach the player. */
export function userMessage(err) {
  const exposed = err instanceof Error && (err.constructor === Error || err.expose === true);
  if (!exposed || typeof err.message !== 'string' || !err.message.trim()) return 'action failed';
  return err.message.replace(CONTROL_RE, ' ').trim().slice(0, 200);
}

export function isValidVerb(verb) {
  return typeof verb === 'string' && VERB_RE.test(verb);
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates untrusted action args (already JSON-parsed). Returns `{}` for null/undefined.
 * Rejects non-objects, prototype-polluting keys, deep/large structures, non-finite numbers.
 */
export function validateArgs(args, limits = ARG_LIMITS) {
  if (args === undefined || args === null) return {};
  if (!isPlainObject(args)) throw new ActionError('action args must be an object');
  let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > limits.maxNodes) throw new ActionError('action args too large');
    if (depth > limits.maxDepth) throw new ActionError('action args nested too deeply');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new ActionError('action args must contain finite numbers');
      return;
    }
    if (typeof v === 'string') {
      if (v.length > limits.maxStringLength) throw new ActionError('action argument text too long');
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > limits.maxKeys) throw new ActionError('action args too large');
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isPlainObject(v)) throw new ActionError('invalid action args');
    const keys = Object.keys(v);
    if (keys.length > limits.maxKeys) throw new ActionError('action args too large');
    for (const k of keys) {
      if (FORBIDDEN_KEYS.has(k) || k.length > limits.maxKeyLength) throw new ActionError('invalid action argument name');
      walk(v[k], depth + 1);
    }
  };
  walk(args, 0);
  return args;
}

/** Replaces the contents of `target` with `source`, keeping the object identity of `target`. */
function restoreInto(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

function normalizeFeature(entry, i) {
  if (typeof entry === 'function') return { name: entry.featureName || entry.name || `feature${i}`, install: entry };
  if (entry && typeof entry.install === 'function') {
    return { name: entry.name || entry.featureName || `feature${i}`, install: entry.install };
  }
  throw new TypeError(`RPG feature #${i} must be an install(ctx) function or a module exporting install`);
}

/**
 * @param {object} opts
 * @param {Map<number, object>} opts.players  live joined players (shared with game.js)
 * @param {Array} [opts.features]             installers: functions or `{name?, install}` / module namespaces
 * @param {(players: object[]) => void} opts.save  persists players atomically; throws on failure
 * @param {(player: object, msg: object) => void} opts.send
 * @param {() => number} [opts.now]           monotonic ms
 * @param {string|null} [opts.dataPath]       operator-provided ARENA2 directory (never served)
 * @param {string} [opts.defaultLocation]
 * @param {object} [opts.log]
 * @param {object} [opts.config]              read-only server config exposed as ctx.config
 * @param {object} [opts.services]            initial ctx.services (features may add or replace entries)
 */
export function createRpgRuntime(opts) {
  const {
    players,
    features = [],
    save,
    send,
    worldStore = null,
    now = () => performance.now(),
    dataPath = null,
    defaultLocation = DEFAULT_LOCATION,
    log = console,
    config = {},
    services = {},
  } = opts;
  if (!(players instanceof Map)) throw new TypeError('players must be a Map');
  if (typeof save !== 'function' || typeof send !== 'function') throw new TypeError('save and send are required');

  const entities = new Map();
  const pendingWorld = new Map(); // world-state rows changed outside actions, saved periodically
  const joinHandlers = [];
  const leaveHandlers = [];
  const tickHandlers = [];
  const actions = new Map();
  const events = new Map();
  const lastSent = new WeakMap(); // player -> {key, parts} of the last rpg snapshot sent
  // name -> (location) => {status:'loading'|'ready'|'failed', ...}: what the server still prepares for a place
  // (its people, ...). Sent with every snapshot as `readiness` so a joining client can wait for it.
  const readinessProviders = new Map();
  const privateReadinessProviders = new Map();
  // While an action runs: { snaps, entitySnaps, entityOrder, affected, events, undo, commit }.
  // While leave handlers run: same shape with null snapshots (nothing is rolled back).
  let txn = null;

  const locationOf = (p) => (p.rpg && typeof p.rpg.location === 'string' ? p.rpg.location : defaultLocation);
  // Presence scene: the location, partitioned where a feature scopes it (server/rpg/sailing.js: each crew on a shared
  // classic ship deck is its own scene). Players see, hear and reach only those in the same scene.
  const scopeOf = (p) => {
    try {
      return ctx.services.presenceScope?.(p) ?? null;
    } catch {
      return null;
    }
  };
  const sceneOf = (p) => {
    const s = scopeOf(p);
    return s ? `${locationOf(p)}#${s}` : locationOf(p);
  };

  function deliver(player, msg) {
    if (txn) txn.events.push([player, msg]);
    else send(player, msg);
  }

  function checkEvent(event) {
    if (!event || typeof event !== 'object' || typeof event.kind !== 'string' || !event.kind) {
      throw new TypeError('game events need a string kind');
    }
  }

  // Player fields restored on rollback besides `rpg`.
  const PLAYER_FIELDS = ['name', 'x', 'z', 'yaw', 'moving', 'animation'];

  function snap(p) {
    if (!txn?.snaps || txn.snaps.has(p)) return;
    const fields = {};
    for (const k of PLAYER_FIELDS) fields[k] = [Object.hasOwn(p, k), p[k]];
    txn.snaps.set(p, { rpg: structuredClone(p.rpg), fields });
  }

  function restorePlayer(p, { rpg, fields }) {
    if (isPlainObject(p.rpg)) restoreInto(p.rpg, rpg);
    else p.rpg = rpg;
    for (const [k, [had, v]] of Object.entries(fields)) {
      if (had) p[k] = v;
      else delete p[k];
    }
  }

  // Entities may hold values structuredClone rejects (functions, class instances); fall back to a
  // shallow copy so at least their own top-level fields (hp, location, x/z, loot lists) roll back.
  function cloneEntity(e) {
    try {
      return structuredClone(e);
    } catch {
      return { ...e };
    }
  }

  function snapEntity(e) {
    if (!txn?.entitySnaps || !e || typeof e !== 'object' || txn.entitySnaps.has(e)) return;
    txn.entitySnaps.set(e, cloneEntity(e));
  }

  const ctx = {
    players,
    entities,
    services: { ...services },
    config,
    dataPath,
    defaultLocation,
    log,
    /** Absolute path of a file inside the operator's ARENA2 directory; throws outside it or when unset. */
    dataFile(name) {
      if (!dataPath) throw new Error('game data is not configured on this server');
      const full = resolve(dataPath, String(name));
      const rel = relative(dataPath, full);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid game data path');
      return full;
    },
    location: locationOf,
    /** Presence scene of a player (location, or location#scope on a scoped deck). */
    sceneOf: (p) => sceneOf(p),
    /** True when a and b stand in the same place and can see each other (same location and presence scope). */
    sameScene: (a, b) => !!a && !!b && sceneOf(a) === sceneOf(b),
    now: () => now(),
    onJoin: (fn) => void joinHandlers.push(fn),
    onLeave: (fn) => void leaveHandlers.push(fn),
    onTick: (fn) => void tickHandlers.push(fn),
    /**
     * Reports what the server is still preparing for a location: `fn(location)` returns
     * `{status: 'loading'|'ready'|'failed', ...detail}` (or null when it has nothing to say). Snapshots carry
     * `readiness: {location, [name]: status}` so a joining client can hold its loading screen until the place is
     * complete, and tell a genuinely empty place from one whose occupants are still loading.
     * With `perPlayer`, fn(location, viewer) contributes only to that viewer's snapshot.
     */
    readiness(name, fn, { perPlayer = false } = {}) {
      if (typeof name !== 'string' || !name || typeof fn !== 'function') throw new TypeError('readiness needs a name and a function');
      (perPlayer ? privateReadinessProviders : readinessProviders).set(name, fn);
    },
    onAction(verb, fn) {
      if (!isValidVerb(verb)) throw new TypeError(`invalid action verb ${JSON.stringify(verb)}`);
      if (actions.has(verb)) throw new Error(`action ${verb} is already registered`);
      if (typeof fn !== 'function') throw new TypeError('action handler must be a function');
      actions.set(verb, fn);
    },
    /** Run a trusted, deferred feature callback with the same save and rollback as a player action. */
    runAtomic: (player, label, fn) => transact(player, label, fn),
    on(name, fn) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
    },
    emit(name, payload) {
      for (const fn of events.get(name) || []) fn(payload);
    },
    notify(player, event) {
      checkEvent(event);
      deliver(player, { type: 'gameEvent', event });
    },
    nearby(location, event, opts = {}) {
      checkEvent(event);
      // A player's own event (event.playerId) reaches only that player's scene; a scoped scene (a crew's deck) never
      // hears another's. Shared-world events (no actor) reach the whole location as before. opts.scope overrides.
      let scope;
      if (opts && 'scope' in opts) scope = opts.scope ?? null;
      else {
        const actor = Number.isSafeInteger(event.playerId) ? players.get(event.playerId) : null;
        scope = actor ? scopeOf(actor) : undefined;
      }
      for (const p of players.values()) {
        if (locationOf(p) !== location) continue;
        if (scope !== undefined && scopeOf(p) !== scope) continue;
        deliver(p, { type: 'gameEvent', event });
      }
    },
    /**
     * Records an entity's current fields so a failed action restores them. Entities in the actor's
     * location (and the entity Map's membership) are recorded automatically; call this BEFORE
     * mutating an entity elsewhere. No-op outside actions.
     */
    touchEntity(entity) {
      snapEntity(entity);
    },
    /** True while an action transaction runs (rollback hooks and touchEntity are meaningful). */
    inAction: () => !!txn?.snaps,
    /**
     * Registers an undo step for feature-private mutable state (party maps, cooldown tables...).
     * Runs only if the current action fails, in reverse registration order. Outside actions: ignored.
     */
    onRollback(fn) {
      if (typeof fn !== 'function') throw new TypeError('onRollback needs a function');
      if (txn?.snaps) txn.undo.push(fn);
    },
    /**
     * Defers a side effect (timers, outside notifications) until the action has been saved. Outside
     * actions it runs immediately. Dropped when the action fails.
     */
    afterCommit(fn) {
      if (typeof fn !== 'function') throw new TypeError('afterCommit needs a function');
      if (txn?.snaps) txn.commit.push(fn);
      else fn();
    },
    /**
     * Shared world state (not owned by a player), e.g. a shop ledger. Inside an action the row is saved in the
     * same transaction as the affected players (and dropped if the action fails); outside actions it is queued
     * for the next periodic save. `value` must be JSON-serialisable at save time; null deletes the row.
     */
    dirtyWorld(key, value) {
      if (typeof key !== 'string' || !key) throw new TypeError('dirtyWorld needs a key');
      if (txn?.snaps) txn.world.set(key, value);
      else pendingWorld.set(key, value);
    },
    /** Saved world-state rows by key prefix: [[key, value]] (empty without a store). */
    loadWorld: (prefix) => (typeof worldStore?.load === 'function' ? worldStore.load(prefix) : []),
    /**
     * Marks a player as changed. Inside an action/leave the player joins the atomic save (call it
     * BEFORE mutating a player outside the actor's location so it can be rolled back); otherwise the
     * change is saved by the periodic save.
     */
    dirty(player) {
      if (!player || typeof player !== 'object') return;
      if (txn) {
        snap(player);
        txn.affected.add(player);
      } else {
        player.dirty = true;
      }
    },
  };

  const installed = [];
  features.forEach((entry, i) => {
    const f = normalizeFeature(entry, i);
    f.install(ctx);
    installed.push(f.name);
  });

  function runAll(handlers, args, what) {
    for (const fn of handlers) {
      try {
        fn(...args);
      } catch (err) {
        log.error(`[rpg] ${what} handler failed:`, err);
      }
    }
  }

  function flushEvents(list) {
    for (const [p, msg] of list) send(p, msg);
  }

  // ---- snapshots -------------------------------------------------------------------------------

  function canSee(e, viewer) {
    if (e.visibleTo == null) return true;
    return e.visibleTo instanceof Set ? e.visibleTo.has(viewer.id) : Array.isArray(e.visibleTo) && e.visibleTo.includes(viewer.id);
  }

  function publicEntity(e) {
    const out = {};
    for (const k of Object.keys(e)) {
      if (k.startsWith('_') || k === 'visibleTo' || typeof e[k] === 'function') continue;
      out[k] = e[k];
    }
    return out;
  }

  function publicPeer(p) {
    const peer = { id: p.id, name: p.name, x: r3(p.x), z: r3(p.z), yaw: r3(p.yaw), moving: !!p.moving };
    const rpg = p.rpg || {};
    if (rpg.portal?.to === rpg.location && Number.isFinite(rpg.portal?.footY)) peer.y = rpg.portal.footY;
    if (typeof rpg.readied === 'boolean') peer.readied = rpg.readied;
    if (rpg.defeated) peer.defeated = true;
    const concealment = ctx.services.peerConcealment?.(p);
    if (concealment) peer.concealment = concealment;
    const form = ctx.services.conditionBeastForm?.(p);
    if (form) peer.form = form;
    // server/rpg/mount.js: a horse rider shows the horse flat; a cart driver has no classic peer art.
    if (!form && rpg.mount?.riding === true && rpg.mount.mode === 'cart') peer.transport = 'cart';
    else if (!form && rpg.mount?.riding === true) { peer.mounted = true; peer.coat = rpg.mount.coat === 1 ? 1 : 0; }
    // Appearance identifiers only (actor sprites); the rest of the sheet stays private.
    const ch = rpg.character;
    if (ch && typeof ch === 'object') {
      for (const k of PUBLIC_CHARACTER_FIELDS) {
        if (typeof ch[k] === 'string' && ch[k].length <= 40) peer[k] = ch[k];
      }
    }
    const weaponId = rpg.equipment?.rightHand;
    if (!form && weaponId != null && Array.isArray(rpg.inventory)) {
      const item = rpg.inventory.find((it) => it && it.id === weaponId);
      if (item) peer.weapon = { template: item.template, name: item.name };
    }
    const animation = p.animation ?? rpg.animation;
    if (animation != null) peer.animation = animation;
    return peer;
  }

  // `cache` memoizes work within one sync: per location (string keys) the entities, peers and readiness, and
  // per player (object keys) the public peer. Each is copied and serialized once, however many viewers share it.
  function peerOf(q, cache) {
    let v = cache.get(q);
    if (!v) {
      const peer = publicPeer(q);
      const { x, z, yaw, moving, ...rest } = peer; // peer positions stream through `state`
      v = { peer, rest: JSON.stringify(rest) };
      cache.set(q, v);
    }
    return v;
  }

  function locationCache(loc, cache) {
    let c = cache.get(loc);
    if (!c) {
      const readiness = { location: loc, ...readinessOf(readinessProviders, loc) };
      c = {
        entities: [...entities.values()].filter((e) => e && e.location === loc).map((e) => {
          const v = publicEntity(e);
          return { e, v, json: JSON.stringify(v) };
        }),
        // Players still on their loading screen (server/game.js `arriving`) are not shown to others yet.
        peers: [...players.values()].filter((q) => locationOf(q) === loc && !q.arriving).map((q) => ({ id: q.id, scene: sceneOf(q), ...peerOf(q, cache) })),
        readiness,
        readinessJson: JSON.stringify(readiness),
      };
      cache.set(loc, c);
    }
    return c;
  }

  // The snapshot's parts for `p` and its diff key, built from the cached JSON (no full snapshot is assembled).
  // Peer positions are left out of the key: they alone never trigger a resend.
  function viewOf(p, cache) {
    const loc = locationOf(p);
    const c = locationCache(loc, cache);
    const scene = sceneOf(p);
    const ents = c.entities.filter(({ e }) => canSee(e, p));
    const peers = c.peers.filter((q) => q.id !== p.id && q.scene === scene);
    // Outdoor players just across a boundary (server/rpg/peers.js): public appearance only, in p's frame.
    // Listed by id, not distance, so walking alone never changes the snapshot's diff key.
    const across = [...(ctx.services.peerView?.across(p) ?? [])]
      .sort((x, y) => x.player.id - y.player.id)
      .map((a) => ({ a, ...peerOf(a.player, cache) }));
    const readiness = privateReadinessProviders.size
      ? { ...c.readiness, ...readinessOf(privateReadinessProviders, loc, p) }
      : c.readiness;
    const locomotion = ctx.services.locomotionMods?.(p);
    const peerKeys = peers.map((q) => q.rest);
    for (const { rest } of across) peerKeys.push(rest === '{}' ? '{"across":true}' : `${rest.slice(0, -1)},"across":true}`);
    // One JSON part per snapshot field: character, entities, peers, readiness, locomotion.
    const parts = [
      JSON.stringify(p.rpg) ?? 'null',
      `[${ents.map((x) => x.json).join(',')}]`,
      `[${peerKeys.join(',')}]`,
      readiness === c.readiness ? c.readinessJson : JSON.stringify(readiness),
      JSON.stringify(locomotion) ?? 'null',
    ];
    return { p, loc, ents, peers, across, readiness, locomotion, parts, key: parts.join('\n') };
  }

  function entityMapOf(ents) {
    const map = new Map();
    for (const x of ents) {
      const id = x.v.id;
      if (id === undefined || id === null) return null;
      const key = String(id);
      if (map.has(key)) return null;
      map.set(key, { id, json: x.json });
    }
    return map;
  }

  /** Per-entity delta `{ upsert?, remove? }` against the viewer's last-sent entities, or null to send full `entities`. */
  function buildEntityDelta(ents, prevEntMap) {
    if (!prevEntMap) return null;
    const upsert = [];
    const seen = new Set();
    for (const x of ents) {
      const id = x.v.id;
      if (id === undefined || id === null) return null;
      const key = String(id);
      if (seen.has(key)) return null;
      seen.add(key);
      const prev = prevEntMap.get(key);
      if (!prev || prev.json !== x.json) upsert.push(x.v);
    }
    const remove = [];
    for (const [key, prev] of prevEntMap) {
      if (!seen.has(key)) remove.push(prev.id);
    }
    if (!upsert.length && !remove.length) return null; // order-only change: send full list
    const delta = {};
    if (upsert.length) delta.upsert = upsert;
    if (remove.length) delta.remove = remove;
    return delta;
  }

  /** The snapshot; with `prev` (a delta client) only changed fields and per-entity `entityDelta` within one location. */
  function messageOf({ p, loc, ents, peers, across, readiness, locomotion, parts }, prev = null) {
    const prevParts = prev?.parts ?? null;
    const msg = { type: 'rpg', selfId: p.id };
    const want = (i) => !prevParts || prevParts[i] !== parts[i];
    if (want(0)) msg.character = p.rpg;
    if (want(1)) {
      const delta = prev && prev.loc === loc ? buildEntityDelta(ents, prev.entMap) : null;
      if (delta) msg.entityDelta = delta;
      else msg.entities = ents.map((x) => x.v);
    }
    if (want(2)) {
      msg.peers = peers.map((q) => q.peer);
      for (const { a, peer } of across) msg.peers.push({ ...peer, x: r3(a.x), z: r3(a.z), across: true });
    }
    if (want(3)) msg.readiness = readiness;
    if (want(4)) msg.locomotion = locomotion;
    return msg;
  }

  /** Builds the private snapshot for `p` (`cache` memoizes per-location work within one sync). */
  function rpgMessage(p, cache = new Map()) {
    return messageOf(viewOf(p, cache));
  }

  function readinessOf(providers, loc, viewer) {
    const out = {};
    for (const [name, fn] of providers) {
      try {
        const r = fn(loc, viewer);
        if (r && typeof r === 'object') out[name] = r;
      } catch (err) {
        out[name] = { status: 'failed', error: err?.message ?? String(err) };
      }
    }
    return out;
  }

  /** Sends rpg snapshots whose content changed. `list` defaults to every live player. */
  function sync(list = players.values(), { force = false } = {}) {
    const cache = new Map();
    for (const p of list) {
      if (players.get(p.id) !== p) continue;
      const prev = lastSent.get(p);
      let view, msg;
      try {
        view = viewOf(p, cache);
        if (!force && prev?.key === view.key) continue;
        msg = messageOf(view, !force && p.delta === true ? prev : null);
      } catch (err) {
        log.error('[rpg] snapshot failed:', err);
        continue;
      }
      lastSent.set(p, {
        key: view.key,
        loc: view.loc,
        parts: view.parts,
        entMap: p.delta === true ? entityMapOf(view.ents) : null,
      });
      send(p, msg);
    }
  }

  function playersIn(locations) {
    return [...players.values()].filter((q) => locations.has(locationOf(q)));
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** Prepares a freshly loaded player and runs join handlers (defaults for new/returning characters). */
  function join(p) {
    if (!isPlainObject(p.rpg)) p.rpg = {};
    if (typeof p.rpg.location !== 'string' || !p.rpg.location) p.rpg.location = defaultLocation;
    lastSent.delete(p);
    runAll(joinHandlers, [p], 'join');
    p.dirty = true;
  }

  /** Session replaced by a newer connection: the next snapshot must be sent in full. */
  function resetSync(p) {
    lastSent.delete(p);
    ctx.emit('connectionReset', { player: p });
  }

  /**
   * Runs leave handlers while `p` is still in `players`. Returns the players to save (p plus any
   * players the handlers marked dirty). Events are delivered after the handlers finish.
   */
  function leave(p) {
    if (txn) throw new Error('leave during an action');
    txn = { snaps: null, entitySnaps: null, affected: new Set([p]), events: [], undo: [], commit: [] };
    const t = txn;
    try {
      runAll(leaveHandlers, [p], 'leave');
    } finally {
      txn = null;
    }
    flushEvents(t.events.filter(([q]) => q !== p));
    return [...t.affected];
  }

  function tick(dtSeconds, nowMs = now()) {
    runAll(tickHandlers, [dtSeconds, nowMs], 'tick');
  }

  /**
   * Runs one action atomically. Returns `{ok:true}` or `{ok:false, error}` with a player-readable
   * message. On success all affected players are saved in one transaction and get fresh snapshots.
   */
  function act(p, verb, rawArgs) {
    if (!isValidVerb(verb)) return { ok: false, error: 'invalid action' };
    const handler = actions.get(verb);
    if (!handler) return { ok: false, error: `unknown action ${verb}` };
    if (txn) return { ok: false, error: 'another action is in progress' };
    let args;
    try {
      args = validateArgs(rawArgs);
    } catch (err) {
      return { ok: false, error: userMessage(err) };
    }
    return transact(p, verb, () => handler(p, args));
  }

  function transact(p, verb, run) {
    if (txn) return { ok: false, error: 'another action is in progress' };
    const loc = locationOf(p);
    txn = {
      snaps: new Map(),
      entitySnaps: new Map(),
      entityOrder: [...entities], // membership: dropped loot is removed, killed mobs come back
      affected: new Set([p]),
      events: [],
      undo: [],
      commit: [],
      world: new Map(),
    };
    const t = txn;
    snap(p);
    for (const q of players.values()) if (q !== p && locationOf(q) === loc) snap(q);
    for (const e of entities.values()) if (e && e.location === loc) snapEntity(e);
    const before = new Map([...t.snaps.keys()].map((q) => [q, locationOf(q)]));

    let error = null;
    let saveFailed = false;
    try {
      run();
      saveFailed = true;
      save([...t.affected], [...t.world]);
      saveFailed = false;
      // A committed row supersedes a queued restock. A failed transaction must leave the restock queued.
      for (const k of t.world.keys()) pendingWorld.delete(k);
    } catch (err) {
      error = err;
    } finally {
      txn = null;
    }

    if (error) {
      for (let i = t.undo.length - 1; i >= 0; i--) {
        try {
          t.undo[i]();
        } catch (err) {
          log.error(`[rpg] rollback hook for ${verb} failed:`, err);
        }
      }
      for (const [q, snapshot] of t.snaps) restorePlayer(q, snapshot);
      for (const [e, clone] of t.entitySnaps) restoreInto(e, clone);
      entities.clear();
      for (const [id, e] of t.entityOrder) entities.set(id, e);
      if (saveFailed) {
        log.error(`[rpg] saving action ${verb} failed; rolled back:`, error);
        return { ok: false, error: 'could not save your progress; nothing changed, try again' };
      }
      if (!(error instanceof Error && (error.constructor === Error || error.expose))) {
        log.error(`[rpg] action ${verb} failed:`, error);
      }
      return { ok: false, error: userMessage(error) };
    }

    for (const q of t.affected) q.dirty = false; // full rows were just saved
    flushEvents(t.events);
    for (const fn of t.commit) {
      try {
        fn();
      } catch (err) {
        log.error(`[rpg] afterCommit for ${verb} failed:`, err);
      }
    }
    const locs = new Set([loc, ...before.values()]);
    for (const q of t.affected) locs.add(locationOf(q));
    sync(playersIn(locs));
    return { ok: true };
  }

  return {
    ctx,
    entities,
    installed,
    /** Queued world-state rows (changed outside actions); `takePendingWorld()` hands them to a save. */
    takePendingWorld() {
      const rows = [...pendingWorld];
      pendingWorld.clear();
      return rows;
    },
    /** Puts rows back after a failed save, unless a newer value was queued meanwhile. */
    restorePendingWorld(rows) {
      for (const [k, v] of rows) if (!pendingWorld.has(k)) pendingWorld.set(k, v);
    },
    locationOf,
    sceneOf,
    join,
    leave,
    tick,
    act,
    sync,
    resetSync,
    rpgMessage,
    hasAction: (verb) => actions.has(verb),
  };
}
