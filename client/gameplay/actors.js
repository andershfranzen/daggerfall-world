// Actor sprites: shared entities (monsters, NPCs, corpses, loot) from
// api.state.entities and remote players from api.state.peers, drawn as
// classic 8-direction billboards decoded from the player's own TEXTURE files.
// Also picks the actor under the crosshair (api.target) with line of sight.
//
// Read-only with respect to game state: this module never changes entities,
// never sends actions and never transmits decoded art.
// API reference: client/gameplay/actors/README.md

import { SpriteLibrary } from './actors/library.js';
import { SpritePass } from './actors/spritePass.js';
import { Occluder } from './actors/occlusion.js';
import {
  entityAppearance, peerAppearance, facingIndex, animRecord, frameAt, AnimState, isDead, hasLoot,
} from './actors/logic.js';
import { groundFor, layersHeightAt } from '../lib/ground.js';
import { crossesDoor } from '../lib/arrival.js';
import { SnapshotBuffer } from '../lib/motion.js';
import { mountedItems, HORSE_ARCHIVE } from './mount/sprites.js';
import { peerCoverage } from './magic/concealment.js';

export const TARGET_RANGE = 40;
export const DRAW_RANGE = 220;
const PICK_RADIUS_PX = 2;
const MOVING_SPEED = 0.25; // m/s inferred from interpolated motion

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

function settle(cur, target, dt) {
  if (target === null || target === undefined) return cur;
  if (cur === null) return target;
  if (target > cur) return cur + (target - cur) * Math.min(1, dt * 14);
  return Math.max(target, cur - Math.max(2.5, (cur - target) * 10) * dt);
}

function healthWord(hp, max) {
  if (typeof hp !== 'number' || typeof max !== 'number' || max <= 0) return '';
  const k = hp / max;
  if (k >= 0.999) return 'Unhurt';
  if (k > 0.66) return 'Lightly wounded';
  if (k > 0.33) return 'Wounded';
  if (k > 0.1) return 'Badly wounded';
  return 'Near death';
}

/** Short status line for the crosshair readout. */
export function describeTarget(info) {
  if (!info) return '';
  if (info.kind === 'player') return info.readied ? 'Traveller · weapon readied' : 'Traveller';
  if (info.dead) return info.loot ? 'Corpse · something to take' : 'Corpse · searched';
  if (info.kind === 'loot' || info.kind === 'treasure') return info.loot ? 'Treasure' : 'Picked clean';
  if (info.kind === 'npc') {
    const role = String(info.role ?? '').trim();
    return role ? role[0].toUpperCase() + role.slice(1) : 'Townsperson';
  }
  return healthWord(info.hp, info.maxHp) || (info.kind === 'monster' ? 'Hostile' : '');
}

export class ActorController {
  /**
   * @param {object} api gameplay api (see docs/gameplay-protocol.md)
   * @param {{ clock?: () => number }} opts clock in seconds (defaults to performance.now)
   */
  constructor(api, { clock } = {}) {
    this.api = api;
    this.clock = clock ?? (() => performance.now() / 1000);
    this.library = new SpriteLibrary();
    this.library.onReady = () => { this.loaded = true; };
    this.pass = new SpritePass();
    this.views = new Map();
    this.items = [];
    this.drawnIds = new Set();
    this.target = null;
    this.targetInfo = null;
    this.renderer = null;
    this.screen = null;
    this.town = null;
    this.ground = null;
    this.occluder = null;
    this.lastUpdate = -Infinity;
    this.removePass = null;
    this.selfId = null;
    this.location = null;
  }

  setFiles(files) {
    this.library.setFiles(files ? Array.from(files) : null);
    for (const v of this.views.values()) v.entry = v.corpseEntry = null;
  }

  attach(renderer) {
    if (!renderer || renderer === this.renderer) return;
    this.removePass?.();
    this.renderer = renderer;
    if (typeof renderer.addPass === 'function') {
      this.removePass = renderer.addPass((gl, r, camera) => {
        const now = this.clock();
        // Drive ourselves if the shell does not emit frame events.
        if (now - this.lastUpdate > 0.25 && camera) this.update(camera, 1 / 60, now, r, r.town);
        if (this.visible()) this.pass.draw(gl, r, camera, this.items);
      });
    }
  }

  visible() {
    if (this.screen) return this.screen === 'game';
    const ds = globalThis.document?.body?.dataset?.screen;
    return ds ? ds === 'game' : true;
  }

  setTown(town) {
    if (!town || town === this.town) return;
    this.town = town;
    // The world pass precedes the next frame event. Resolve this room's occupants on that first draw.
    this.lastUpdate = -Infinity;
    const pos = town.positions;
    this.ground = groundFor(town); // shared with the shell, built once per scene
    for (const view of this.views.values()) view.footY = null;
    this.occluder = null; // built on first pick
    this.occluderPositions = pos;
  }

  /** Apply an RPG state message. Positions are buffered and interpolated. */
  syncState(state, now = this.clock()) {
    if (!state) return;
    this.selfId = state.selfId ?? this.selfId;
    const location = this.api.location ?? state.character?.location ?? state.character?.rpg?.location ?? state.location ?? this.location;
    if (crossesDoor(this.location, location)) {
      // A companion can have the same id on both sides of a door. Their old positions are in the other room.
      this.views.clear();
      this.lastUpdate = -Infinity;
    }
    this.location = location;
    const seen = new Set();
    for (const e of asList(state.entities)) {
      if (!e || e.id == null || typeof e.x !== 'number' || typeof e.z !== 'number') continue;
      if (e.location && this.location && e.location !== this.location) continue;
      const key = `e:${e.id}`;
      seen.add(key);
      this.#upsert(key, 'entity', e, now);
    }
    for (const p of asList(state.peers)) {
      if (!p || p.id == null || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
      if (this.selfId != null && String(p.id) === String(this.selfId)) continue;
      if (p.location && this.location && p.location !== this.location) continue;
      const key = `p:${p.id}`;
      seen.add(key);
      this.#upsert(key, 'peer', p, now);
    }
    for (const key of [...this.views.keys()]) if (!seen.has(key)) this.views.delete(key);
  }

  #upsert(key, source, data, now) {
    let v = this.views.get(key);
    const app = source === 'peer' ? peerAppearance(data) : entityAppearance(data);
    if (!v) {
      v = { key, id: data.id, source, data, app, anim: new AnimState(), buf: new SnapshotBuffer(0.1), footY: null, x: data.x, z: data.z, yaw: data.yaw ?? 0, speed: 0, entry: null, corpseEntry: null, lootFlashAt: -Infinity };
      this.views.set(key, v);
    }
    if (!app) { v.app = null; v.data = data; return; }
    if (!v.app || v.app.key !== app.key) { v.app = app; v.entry = null; v.corpseEntry = null; }
    v.data = data;
    v.buf.push(now, { x: data.x, z: data.z, yaw: data.yaw ?? v.yaw, moving: !!data.moving });
  }

  /** Browser-only feedback for private game events (never changes state). */
  onEvent(ev, now = this.clock()) {
    if (!ev || typeof ev !== 'object') return;
    const kind = String(ev.kind ?? ev.type ?? '').toLowerCase();
    const find = (...ids) => {
      for (const id of ids) {
        if (id == null) continue;
        const v = this.views.get(`p:${id}`) ?? this.views.get(`e:${id}`);
        if (v) return v;
      }
      return null;
    };
    if (kind === 'swing' || kind === 'attack') {
      find(ev.playerId, ev.attackerId, ev.entityId)?.anim.trigger('attack', now);
    } else if (kind === 'cast' || kind === 'spell' || kind === 'spellcast') {
      find(ev.playerId, ev.casterId)?.anim.trigger('ranged', now);
    } else if (kind === 'hit' || kind === 'damage' || kind === 'hurt') {
      const v = find(ev.targetId, ev.entityId);
      if (v) { v.anim.hurtAt = now; v.anim.trigger('hurt', now); }
    } else if (kind === 'loot' || kind === 'looted' || kind === 'pickup') {
      const v = find(ev.entityId, ev.targetId, ev.corpseId);
      if (v) v.lootFlashAt = now;
    }
  }

  /** Per-frame: animate, resolve sprites for this camera, pick the target. */
  update(camera, dt, now, renderer, town) {
    if (renderer) this.attach(renderer);
    if (town) this.setTown(town);
    this.lastUpdate = now;
    const items = [];
    const drawn = new Set();
    for (const v of this.views.values()) {
      // A player's position streams through `state` (the shell interpolates it into api.peers);
      // rpg snapshots only refresh appearance, so prefer the live sample, which also follows
      // a peer across an outdoor boundary.
      const live = v.source === 'peer' ? this.api.peer?.(v.id) : null;
      const s = live && Number.isFinite(live.x) ? { x: live.x, z: live.z, yaw: live.yaw ?? v.yaw, moving: !!live.moving } : v.buf.sample(now);
      if (s) {
        const moved = Math.hypot(s.x - v.x, s.z - v.z);
        v.speed = dt > 0 ? v.speed + ((moved / dt) - v.speed) * Math.min(1, dt * 10) : v.speed;
        v.x = s.x; v.z = s.z; v.yaw = s.yaw;
      }
      const d = v.data;
      const g = typeof d.y === 'number' ? d.y : (this.ground?.heightAt(v.x, v.z, v.footY) ?? (v.source === 'peer' ? layersHeightAt(this.api.renderer?.layers, v.x, v.z) : null));
      v.footY = typeof d.y === 'number' ? d.y : settle(v.footY, g, dt);
      if (v.footY === null) v.footY = 0;
      const dead = v.source === 'entity' && isDead(d);
      const moving = live ? live.moving : (s?.moving ?? !!d.moving) || v.speed > MOVING_SPEED;
      v.anim.observe({
        moving,
        hp: typeof d.hp === 'number' ? d.hp : null,
        animation: d.animation ?? null,
        dead,
      }, now);
      const coverage = v.source === 'peer' ? peerCoverage(d.concealment, moving) : 1;
      if (coverage === 0) continue;
      if (!v.app || !camera) continue;
      if (Math.hypot(v.x - camera.x, v.z - camera.z) > DRAW_RANGE) continue;
      const it = this.#resolve(v, camera, now);
      if (it) {
        it.coverage = coverage;
        // A mounted peer (server/rpg/mount.js) rides the classic horse flat.
        if (v.source === 'peer' && d.mounted === true) {
          const facing = facingIndex(v.x, v.z, v.yaw, camera.x, camera.z);
          items.push(...mountedItems(it, this.library.get(HORSE_ARCHIVE), camera, { coat: d.coat, facing }));
        } else items.push(it);
        drawn.add(String(v.id));
      }
    }
    this.items = items;
    this.drawnIds = drawn;
    if (this.renderer?.setActorSprites) this.renderer.setActorSprites(drawn);
    this.api.spritesActive = drawn.size > 0;
    if (camera) this.#pick(camera);
    return items;
  }

  #resolve(v, camera, now) {
    const { state, t } = v.anim.current(now);
    if (state === 'corpse' && v.app.corpse) {
      const [ca, cr] = v.app.corpse;
      const entry = v.corpseEntry ?? (v.corpseEntry = this.library.get(ca));
      if (!entry || cr >= entry.sprite.recordCount) return null;
      const rec = entry.sprite.records[cr];
      const loot = hasLoot(v.data);
      return this.#item(v, entry, cr, frameAt(t, 4, rec.frameCount, true), false, rec, now, loot);
    }
    const entry = v.entry ?? (v.entry = this.library.get(v.app.archive));
    if (!entry) return null;
    const facing = facingIndex(v.x, v.z, v.yaw, camera.x, camera.z);
    const a = animRecord(v.app, state === 'corpse' ? 'dying' : state, facing, entry.sprite.recordCount);
    if (!a || a.record >= entry.sprite.recordCount) return null;
    const rec = entry.sprite.records[a.record];
    let frame = a.still ? 0 : frameAt(t, a.fps, rec.frameCount, a.loop);
    if (!a.loop && !a.still && t * a.fps >= rec.frameCount && state !== 'dying' && state !== 'corpse') {
      v.anim.endOneShot();
      frame = rec.frameCount - 1;
    }
    return this.#item(v, entry, a.record, frame, a.flip, rec, now, v.app.layout === 'flat' && hasLoot(v.data));
  }

  #item(v, entry, record, frame, flip, rec, now, shimmer) {
    const isTarget = this.target != null && String(this.target) === String(v.id);
    let light = 0.96;
    if (shimmer) light += 0.12 * (0.5 + 0.5 * Math.sin(now * 4.5));
    const lf = now - v.lootFlashAt;
    if (lf >= 0 && lf < 0.6) light += 0.5 * (1 - lf / 0.6);
    if (v.anim.dead && !hasLoot(v.data)) light *= 0.82;
    if (isTarget) light *= 1.1;
    return {
      key: v.key, id: v.id, entry, record, frame, flip,
      // Dungeon flats (RDBLayout.AddFlat) are centred on their record; everything else stands on its base.
      x: v.x, y: v.data?.anchor === 'centre' ? v.footY - rec.world.height / 2 : v.footY, z: v.z, w: rec.world.width, h: rec.world.height,
      light, tint: isTarget ? [0.94, 1.0, 1.08] : null, hurt: v.anim.hurtFlash(now),
    };
  }

  /** Actor under the screen centre within TARGET_RANGE and in line of sight, or null. */
  #pick(camera) {
    const cp = Math.cos(camera.pitch ?? 0);
    const D = [Math.sin(camera.yaw) * cp, Math.sin(camera.pitch ?? 0), -Math.cos(camera.yaw) * cp];
    const E = [camera.x, camera.y, camera.z];
    const fh = [Math.sin(camera.yaw), -Math.cos(camera.yaw)];
    const right = [Math.cos(camera.yaw), Math.sin(camera.yaw)];
    const denom = D[0] * fh[0] + D[2] * fh[1];
    let best = null;
    if (denom > 1e-4) {
      for (const it of this.items) {
        const t = ((it.x - E[0]) * fh[0] + (it.z - E[2]) * fh[1]) / denom;
        if (t <= 0.1) continue;
        const H = [E[0] + D[0] * t, E[1] + D[1] * t, E[2] + D[2] * t];
        const dist = Math.hypot(H[0] - E[0], H[2] - E[2]);
        if (dist > TARGET_RANGE || (best && t >= best.t)) continue;
        const u = ((H[0] - it.x) * right[0] + (H[2] - it.z) * right[1]) / it.w + 0.5;
        const vv = (H[1] - it.y) / it.h;
        if (u < 0 || u > 1 || vv < 0 || vv > 1) continue;
        if (!this.#opaqueAt(it, u, vv)) continue;
        best = { it, t, H, dist };
      }
    }
    if (best && this.#blocked(E, best.H)) best = null;
    const id = best ? best.it.id : null;
    const view = best ? this.views.get(best.it.key) : null;
    const info = view ? this.#info(view, best.dist) : null;
    const changed = String(id) !== String(this.target);
    this.target = id;
    this.targetInfo = info;
    this.api.targetInfo = info;
    // Take over the crosshair only once real sprites are on screen; until then the
    // shell's own fallback picker keeps working. api.setTarget emits 'target' itself.
    if (!this.drawnIds.size && !this.claimed) return;
    this.claimed = this.drawnIds.size > 0;
    if (!changed && String(this.api.target) === String(id)) return;
    if (typeof this.api.setTarget === 'function') this.api.setTarget(id);
    else {
      this.api.target = id;
      if (changed) this.api.emit?.('target', { id, entity: null, info });
    }
  }

  #opaqueAt(it, u, v) {
    const img = it.entry.sprite.frame(it.record, it.frame);
    let px = Math.floor(u * img.width);
    if (it.flip) px = img.width - 1 - px;
    const py = Math.floor((1 - v) * img.height);
    for (let dy = -PICK_RADIUS_PX; dy <= PICK_RADIUS_PX; dy++) {
      const y = py + dy;
      if (y < 0 || y >= img.height) continue;
      for (let dx = -PICK_RADIUS_PX; dx <= PICK_RADIUS_PX; dx++) {
        const x = px + dx;
        if (x >= 0 && x < img.width && img.data[y * img.width + x] !== 0) return true;
      }
    }
    return false;
  }

  #blocked(a, b) {
    if (!this.occluder && this.occluderPositions?.length) this.occluder = new Occluder(this.occluderPositions);
    return this.occluder ? this.occluder.blocked(a, b) : false;
  }

  #info(v, distance) {
    const d = v.data;
    if (v.source === 'peer') {
      return { id: v.id, kind: 'player', name: d.name ?? 'Traveller', distance, readied: !!v.app?.readied, dead: false, loot: false };
    }
    const dead = isDead(d);
    return {
      id: v.id, kind: dead && d.kind === 'monster' ? 'corpse' : d.kind ?? 'entity', name: d.name ?? '', distance,
      dead, loot: hasLoot(d), hp: d.hp, maxHp: d.maxHp, role: d.role ?? null, sourceKind: d.kind ?? null,
    };
  }

  /**
   * Start decoding every sprite set in the player's roster before revealing the world.
   * A caller checking a smaller area can supply a finite range.
   */
  arrival({ x = 0, z = 0, range = Infinity } = {}) {
    const need = new Map(); // archive -> actor count
    let actors = 0;
    for (const v of this.views.values()) {
      if (!v.app) continue;
      const d = v.data;
      if (Number.isFinite(range) && Math.hypot(d.x - x, d.z - z) > range) continue;
      actors++;
      const corpse = v.source === 'entity' && isDead(d) && v.app.corpse;
      const archives = [corpse ? v.app.corpse[0] : v.app.archive];
      if (v.source === 'peer' && d?.mounted === true) archives.push(HORSE_ARCHIVE);
      for (const a of archives) need.set(a, (need.get(a) ?? 0) + 1);
    }
    const lib = this.library;
    const out = { actors, archives: need.size, ready: 0, pending: [], failed: [] };
    for (const archive of need.keys()) {
      if (lib.entries.has(archive)) out.ready++;
      else if (lib.failed.has(archive)) out.failed.push({ archive, error: lib.failed.get(archive) });
      else if (!lib.index) out.failed.push({ archive, error: lib.failed.get('files') ?? 'no game files are selected' });
      else { lib.get(archive); out.pending.push(archive); }
    }
    return out;
  }

  /** Public, read-only view handed to the shell (also stored as api.actors). */
  publicApi() {
    return {
      arrival: (opts) => this.arrival(opts),
      hasSprite: (id) => this.drawnIds.has(String(id)),
      drawnIds: () => [...this.drawnIds],
      target: () => this.targetInfo,
      appearance: (id) => (this.views.get(`p:${id}`) ?? this.views.get(`e:${id}`))?.app ?? null,
      library: this.library,
      update: (camera, dt, now, renderer, town) => this.update(camera, dt, now, renderer, town),
    };
  }

  dispose() {
    this.removePass?.();
    this.removePass = null;
    this.renderer?.setActorSprites?.([]);
  }
}

// ------------------------------------------------------------ readout (DOM)

function createReadout() {
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  if (!doc.getElementById('actor-target-style')) {
    const style = doc.createElement('style');
    style.id = 'actor-target-style';
    style.textContent = `
#actor-target{position:fixed;left:50%;top:calc(50% + 22px);transform:translateX(-50%);pointer-events:none;
  z-index:40;text-align:center;font:600 14px/1.25 var(--font-sans,system-ui,sans-serif);color:#e6edf5;
  text-shadow:0 1px 2px #000,0 0 6px rgba(0,0,0,.8);padding:3px 10px;border-radius:4px;
  background:rgba(14,20,30,.55);border:1px solid rgba(150,175,205,.28);max-width:60vw;white-space:nowrap}
#actor-target small{display:block;font-weight:400;font-size:12px;color:#a9b8c9}
#actor-target[data-kind=monster] .actor-target-name{color:#f0d4d0}
#actor-target[data-loot] small{color:#bfe0ff}
body:not([data-screen=game]) #actor-target{display:none}`;
    doc.head?.append(style);
  }
  const el = doc.createElement('div');
  el.id = 'actor-target';
  el.hidden = true;
  el.setAttribute('aria-live', 'polite');
  const name = doc.createElement('span');
  name.className = 'actor-target-name';
  const sub = doc.createElement('small');
  el.append(name, sub);
  (doc.getElementById('hud') ?? doc.body)?.append(el);
  return { el, name, sub };
}

function showReadout(r, info, api) {
  if (!r) return;
  const hide = !info || api.modalOpen;
  if (r.el.hidden !== hide) r.el.hidden = hide;
  if (hide) return;
  const title = info.name || (info.kind === 'player' ? 'Traveller' : info.kind);
  const sub = describeTarget(info);
  if (r.name.textContent !== title) r.name.textContent = title;
  if (r.sub.textContent !== sub) r.sub.textContent = sub;
  r.sub.hidden = !sub;
  r.el.dataset.kind = info.kind;
  r.el.toggleAttribute('data-loot', !!info.loot);
}

/**
 * Gameplay feature entry point. Returns (and stores as api.actors) the public
 * API documented in client/gameplay/actors/README.md.
 */
export function install(api, opts = {}) {
  const ctl = new ActorController(api, opts);
  const pub = ctl.publicApi();
  api.actors = pub;
  api.target = null;
  api.targetInfo = null;
  api.spritesActive = false;
  if (api.files) ctl.setFiles(api.files);
  if (api.renderer) ctl.attach(api.renderer);
  if (api.state) ctl.syncState(api.state);
  // The shell's #hud-target readout takes precedence; ours is a fallback for bare pages.
  let readout = null;
  const readoutFor = () => {
    if (readout || opts.readout === false) return readout;
    if (globalThis.document?.getElementById?.('hud-target')) { opts.readout = false; return null; }
    return (readout = createReadout());
  };

  const on = typeof api.on === 'function' ? api.on.bind(api) : () => {};
  on('assets', (files) => ctl.setFiles(files));
  on('state', (state) => ctl.syncState(state));
  on('event', (ev) => ctl.onEvent(ev));
  on('screen', (screen) => {
    ctl.screen = typeof screen === 'string' ? screen : screen?.screen ?? null;
    // The final roster or sprite may have arrived since the last loading-screen draw.
    // Rebuild the list with the player's camera in the first visible render pass.
    if (ctl.screen === 'game') ctl.lastUpdate = -Infinity;
    else showReadout(readoutFor(), null, api);
  });
  on('scene', (town) => {
    ctl.setTown(town?.town ?? town);
    if (api.renderer) ctl.attach(api.renderer);
  });
  on('frame', (...args) => {
    // Accept a detail object or positional (camera, dt, now, renderer, town).
    const a = args[0] && args[0].camera ? args[0] : { camera: args[0], dt: args[1], now: args[2], renderer: args[3], town: args[4] };
    if (!a.camera) return;
    const now = typeof a.now === 'number' ? a.now : ctl.clock();
    ctl.update(a.camera, a.dt ?? 1 / 60, now, a.renderer ?? api.renderer, a.town ?? a.renderer?.town);
    showReadout(readoutFor(), ctl.visible() ? ctl.targetInfo : null, api);
  });
  return pub;
}
