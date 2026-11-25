// Pure Daggerfall peer billboard selector.
// Default ('classic8dir'): every remote player is a real ARENA2 8-direction classic
// TEXTURE world sprite, as mobiles are drawn in the original game. The opt-in 'hybrid'
// and 'doll' modes put the equipped-gear paper doll in the world instead (front views
// only in 'hybrid'). Zero DOM or WebGL side effects; never falls back to procedural
// boxy avatars once ARENA2 is loaded.

import { facingIndex, animRecord, frameAt, hasLoot } from './logic.js';
import { CORPSE_FALLBACK } from './tables.js';
import { resolvePeerAppearance, peerFigureTint, isPeerDefeated } from './peerFigure.js';

export const PEER_BILLBOARD_MODES = Object.freeze(['hybrid', 'doll', 'classic8dir']);
export const REAR_FACINGS = Object.freeze(new Set([3, 4, 5]));
export const FRONT_FACINGS = Object.freeze(new Set([0, 1, 2, 6, 7]));

/** Maximum vertical stride bob (metres) applied to moving equipped-gear doll billboards. */
export const DOLL_BOB_AMPLITUDE = 0.04;
/** Phase rate (rad/s) for the equipped-gear doll walk-cycle bob when view.walkPhase is unset. */
export const DOLL_BOB_RATE = 8;

const TARGET_TINT = Object.freeze([0.94, 1.0, 1.08]);
const BEAST_FORMS = new Set(['werewolf', 'wereboar']);
const BEAST_ARCHIVES = new Set([264, 269]);
const COMBAT_STATES = new Set(['attack', 'ranged']);

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function normalizeMode(mode) {
  if (mode === 'doll' || mode === 'classic8dir' || mode === 'hybrid') return mode;
  return 'classic8dir';
}

function isBeastPeer(peer, app) {
  const form = String(peer?.form ?? '').trim().toLowerCase();
  return BEAST_FORMS.has(form) || BEAST_ARCHIVES.has(app?.archive);
}

function readEntrySize(entry, record = 0) {
  const rec = entry?.sprite?.records?.[record] ?? null;
  const w = rec?.world?.width ?? entry?.world?.width ?? entry?.w ?? 0;
  const h = rec?.world?.height ?? entry?.world?.height ?? entry?.h ?? 0;
  return { w, h, rec };
}

function combineTint(baseTint, isTarget) {
  if (!baseTint && !isTarget) return null;
  if (!baseTint) return [TARGET_TINT[0], TARGET_TINT[1], TARGET_TINT[2]];
  if (!isTarget) return [baseTint[0], baseTint[1], baseTint[2]];
  return [
    round3(baseTint[0] * TARGET_TINT[0]),
    round3(baseTint[1] * TARGET_TINT[1]),
    round3(baseTint[2] * TARGET_TINT[2]),
  ];
}

function resolveAnimState(view, peer, defeated, now) {
  if (view.anim && typeof view.anim.current === 'function') {
    const cur = view.anim.current(now);
    if (cur && typeof cur.state === 'string') {
      return { state: cur.state, t: Number.isFinite(cur.t) ? cur.t : 0 };
    }
  }
  if (typeof view.animState === 'string') {
    return { state: view.animState, t: Number.isFinite(view.animTime) ? view.animTime : 0 };
  }
  if (defeated) return { state: 'corpse', t: 0 };
  const moving = !!peer?.moving || (typeof view.speed === 'number' && view.speed > 0.25);
  return { state: moving ? 'move' : 'idle', t: Number.isFinite(now) ? now : 0 };
}

function computeLight(view, peer, defeated, isTarget, now) {
  let light = 0.96;
  const lf = now - (view.lootFlashAt ?? -Infinity);
  if (lf >= 0 && lf < 0.6) light += 0.5 * (1 - lf / 0.6);
  if (defeated && !hasLoot(peer)) light *= 0.82;
  if (isTarget) light *= 1.1;
  return light;
}

/**
 * Scale `(w, h)` proportionally so its height equals `targetHeight`, preserving
 * aspect ratio. Prevents size pop when switching between front doll and rear 8-dir sprite.
 */
export function matchHeight(w, h, targetHeight) {
  if (!(targetHeight > 0) || !(h > 0) || !(w > 0)) return { w, h };
  const scale = targetHeight / h;
  return { w: w * scale, h: targetHeight };
}

/**
 * True when the procedural fallback cube avatar should be suppressed for a peer: its ARENA2
 * sprite is drawn, or can still be drawn (archive loading, out of draw range, snapshot not in
 * yet; see ActorController.figureDrawable). A peer whose figure cannot be drawn (archive failed,
 * no game files) keeps the cube rather than becoming invisible.
 */
export function shouldSkipFallbackAvatar({ hasActorSprite = false, figureDrawable = false, peer = null } = {}) {
  if (hasActorSprite === true) return true;
  if (figureDrawable === true) return true;
  if (peer && typeof peer.coverage === 'number' && peer.coverage <= 0) return true;
  return false;
}

/**
 * Resolve a remote player's `SpritePass` billboard item:
 * - Defeated / downed peers -> classic corpse sprite (`source: 'corpse'`).
 * - Beast forms (Werewolf / Wereboar) -> classic 8-dir beast sprite (`source: 'sprite'`).
 * - `'classic8dir'` (default): always classic 8-dir `TEXTURE` sprites with archetype & dye tinting.
 * - `'hybrid'`:
 *   - Active combat (`attack` / `ranged`) -> classic 8-dir combat frames (`TEXTURE.475–490`).
 *   - Rear views (`facing` 3, 4, 5) -> classic 8-dir rear frames, height-matched to doll.
 *   - Front & front-side views (`facing` 0, 1, 2, 6, 7) during idle/move/hurt ->
 *     equipped-gear ARENA2 paper doll (`source: 'doll'`) with subtle walk bob and mirror,
 *     falling back only to the classic 8-dir ARENA2 sprite while the doll composites.
 * - `'doll'`: always equipped-gear ARENA2 doll (except beast forms & corpses).
 *
 * Returns `{ key, id, entry, record, frame, flip, x, y, z, w, h, light, tint, hurt, source }`
 * or `null` if no ARENA2 texture is ready yet.
 */
export function resolvePeerBillboardItem({
  view,
  camera,
  now = 0,
  spriteLibrary = null,
  dollLibrary = null,
  mode = 'classic8dir',
  targetId = null,
} = {}) {
  if (!view || !camera) return null;

  const peer = view.data ?? view.peer ?? {};
  const id = view.id ?? peer.id ?? null;
  const key = view.key ?? (id != null ? `p:${id}` : 'p:unknown');
  const x = typeof view.x === 'number' ? view.x : (peer.x ?? 0);
  const z = typeof view.z === 'number' ? view.z : (peer.z ?? 0);
  const yaw = typeof view.yaw === 'number' ? view.yaw : (peer.yaw ?? 0);
  const footY = typeof view.footY === 'number' ? view.footY : (typeof peer.y === 'number' ? peer.y : 0);

  const app = view.app ?? resolvePeerAppearance(peer);
  if (!app) return null;

  const beast = isBeastPeer(peer, app);
  const defeated = isPeerDefeated(peer) || app.defeated === true || view.anim?.dead === true;
  const { state, t } = resolveAnimState(view, peer, defeated, now);
  const isTarget = targetId != null && id != null && String(targetId) === String(id);
  const light = computeLight(view, peer, defeated, isTarget, now);
  const hurt = typeof view.anim?.hurtFlash === 'function' ? view.anim.hurtFlash(now) : (view.hurt ?? 0);
  const anchorCentre = peer.anchor === 'centre';
  const yFor = (h, bob = 0) => (anchorCentre ? footY - h / 2 : footY) + bob;

  // 1. Defeated / downed peers ALWAYS lie as a classic Daggerfall corpse.
  if (defeated || state === 'corpse') {
    const [ca, cr] = Array.isArray(app.corpse) ? app.corpse : CORPSE_FALLBACK;
    const entry = spriteLibrary?.get?.(ca) ?? null;
    if (!entry || !entry.sprite || cr >= entry.sprite.recordCount) return null;
    const rec = entry.sprite.records[cr];
    const frame = frameAt(t, 4, rec.frameCount, true);
    const { w, h } = readEntrySize(entry, cr);
    return {
      key,
      id,
      entry,
      record: cr,
      frame,
      flip: false,
      x,
      y: yFor(h),
      z,
      w,
      h,
      light,
      tint: combineTint(null, isTarget),
      hurt,
      source: 'corpse',
    };
  }

  const facing = facingIndex(x, z, yaw, camera.x, camera.z);
  const resolvedMode = normalizeMode(mode);
  const isCombat = COMBAT_STATES.has(state);
  const isRear = REAR_FACINGS.has(facing);

  // Peek at the equipped-gear doll entry when applicable so we can render it directly
  // or match its exact world height for rear/combat 8-dir transitions in hybrid mode.
  const canUseDoll = !beast && resolvedMode !== 'classic8dir';
  const dollEntry = canUseDoll ? (dollLibrary?.get?.(peer) ?? null) : null;
  const dollRecord = dollEntry?.record ?? 0;
  const dollFrame = dollEntry?.frame ?? 0;
  const dollSize = dollEntry ? readEntrySize(dollEntry, dollRecord) : null;
  const dollHeight = dollSize && dollSize.h > 0 ? dollSize.h : 0;

  const wantDoll = canUseDoll && (
    resolvedMode === 'doll'
    || (resolvedMode === 'hybrid' && !isCombat && !isRear)
  );

  // 2. Equipped-gear ARENA2 paper doll billboard.
  if (wantDoll && dollEntry) {
    const { w, h } = dollSize;
    const walkPhase = typeof view.walkPhase === 'number' && Number.isFinite(view.walkPhase)
      ? view.walkPhase
      : t * DOLL_BOB_RATE;
    const bob = state === 'move' ? Math.abs(Math.sin(walkPhase)) * DOLL_BOB_AMPLITUDE : 0;
    const flip = facing === 6 || facing === 7;
    return {
      key,
      id,
      entry: dollEntry,
      record: dollRecord,
      frame: dollFrame,
      flip,
      x,
      y: yFor(h, bob),
      z,
      w,
      h,
      light,
      tint: combineTint(null, isTarget),
      hurt,
      source: 'doll',
    };
  }

  // 3. Authentic 8-direction classic ARENA2 sprite (beast forms, rear views, combat swings/casts,
  //    classic8dir mode, or temporary first-frame fallback while dollEntry finishes compositing).
  let spriteApp = app;
  if (beast && !BEAST_ARCHIVES.has(spriteApp.archive)) {
    spriteApp = resolvePeerAppearance(peer);
  } else if (isCombat && !beast && spriteApp.layout === 'person') {
    const armedApp = resolvePeerAppearance({ ...peer, readied: true });
    if (armedApp && spriteLibrary?.get?.(armedApp.archive)) {
      spriteApp = armedApp;
    }
  }

  const entry = spriteLibrary?.get?.(spriteApp.archive) ?? null;
  if (!entry || !entry.sprite) return null;

  const animState = state === 'corpse' ? 'dying' : state;
  const a = animRecord(spriteApp, animState, facing, entry.sprite.recordCount);
  if (!a || a.record >= entry.sprite.recordCount) return null;

  const rec = entry.sprite.records[a.record];
  let frame = a.still ? 0 : frameAt(t, a.fps, rec.frameCount, a.loop);
  if (!a.loop && !a.still && t * a.fps >= rec.frameCount && state !== 'dying' && state !== 'corpse') {
    view.anim?.endOneShot?.();
    frame = rec.frameCount - 1;
  }

  const raw = readEntrySize(entry, a.record);
  const sized = (!beast && resolvedMode === 'hybrid' && dollHeight > 0)
    ? matchHeight(raw.w, raw.h, dollHeight)
    : { w: raw.w, h: raw.h };

  const baseTint = beast ? null : (spriteApp.tint !== undefined ? spriteApp.tint : peerFigureTint(peer));

  return {
    key,
    id,
    entry,
    record: a.record,
    frame,
    flip: a.flip,
    x,
    y: yFor(sized.h),
    z,
    w: sized.w,
    h: sized.h,
    light,
    tint: combineTint(baseTint, isTarget),
    hurt,
    source: 'sprite',
  };
}
