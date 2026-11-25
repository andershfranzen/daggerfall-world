// Classic Daggerfall character figures for captains and crew standing on remote
// ship decks (plugs into client/gameplay/sailing/render.js in place of boxy
// procedural Avatar cubes).
//
// Transforms each contact's deck-local captain and crew poses through the ship's
// rolling, pitching, yawed deck frame into world-space SpritePass billboards:
//   - Front / 3/4 views (facing 0, 1, 7) render the sailor's equipped-gear
//     ARENA2 doll via `dollLibrary.get(peer)` when ready.
//   - Side / rear views (facing 2..6), beast forms, defeated sailors, and
//     pending doll loads fall back to classic 8-direction TEXTURE sprites via
//     `resolvePeerAppearance(peer)` + `spriteLibrary.get(archive)`.

import * as R from './renderMath.js';
import { SpritePass } from '../actors/spritePass.js';
import { facingIndex, animRecord, frameAt, ATTACK_ANIMS, RANGED_ANIMS } from '../actors/logic.js';
import { resolvePeerAppearance } from '../actors/peerFigure.js';

export const DRAW_RANGE = 220;
export const MAX_CREW_PER_CONTACT = 24;
export const DEFAULT_DECK_Y = 6;
export const DEFAULT_DOLL_WIDTH = 1.05;
export const DEFAULT_DOLL_HEIGHT = 1.85;

const FRONT_FACINGS = new Set([0, 1, 7]);
const HURT_ANIMS = new Set(['hurt', 'hit', 'damage', 'pain']);
const MOVE_ANIMS = new Set(['move', 'walk', 'run', 'chase', 'flee']);
const BEAST_FORMS = new Set(['werewolf', 'wereboar']);

const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/** True when a facing index (0..7) shows the sailor from the front or front 3/4. */
export function isDollFacing(facing) {
  return FRONT_FACINGS.has(facing);
}

/**
 * Whether to draw a legacy procedural cube Avatar on a remote ship deck.
 * Returns `false` whenever a classic sprite/doll is available OR `ARENA2` is loaded.
 */
export function shouldDrawCubeAvatarOnDeck({ hasSprite = false, arena2Loaded = false } = {}) {
  return !hasSprite && !arena2Loaded;
}

function iterateContacts(contacts) {
  if (!contacts) return [];
  if (contacts instanceof Map) return [...contacts.values()];
  if (Array.isArray(contacts)) return contacts;
  if (typeof contacts[Symbol.iterator] === 'function') return [...contacts];
  if (typeof contacts === 'object') return Object.values(contacts);
  return [];
}

function lookupPeerState(peerStateById, id) {
  if (!peerStateById || id == null) return null;
  if (typeof peerStateById === 'function') return peerStateById(id) ?? peerStateById(String(id)) ?? null;
  if (peerStateById instanceof Map) return peerStateById.get(id) ?? peerStateById.get(String(id)) ?? null;
  if (typeof peerStateById === 'object') return peerStateById[id] ?? peerStateById[String(id)] ?? null;
  return null;
}

function mergePeer(base, overlay) {
  const out = {};
  if (base && typeof base === 'object') {
    for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  }
  if (overlay && typeof overlay === 'object') {
    for (const [k, v] of Object.entries(overlay)) if (v !== undefined) out[k] = v;
  }
  return out;
}

function resolveContactMatrix(contact) {
  const explicit = contact?.matrix ?? contact?.m ?? contact?.contactMatrix;
  if (explicit && explicit.length === 16) return explicit;

  const view = contact?.view && typeof contact.view === 'object' ? contact.view : {};
  const chart = contact?.chart && typeof contact.chart === 'object' ? contact.chart : {};
  const pose = contact?.pose && typeof contact.pose === 'object' ? contact.pose : {};

  const dx = isFin(pose.dx) ? pose.dx : isFin(contact?.dx) ? contact.dx : isFin(chart.x) ? chart.x : isFin(contact?.x) ? contact.x : isFin(view.x) ? view.x : 0;
  const dz = isFin(pose.dz) ? pose.dz : isFin(contact?.dz) ? contact.dz : isFin(chart.z) ? chart.z : isFin(contact?.z) ? contact.z : isFin(view.z) ? view.z : 0;
  const yaw = isFin(pose.yaw) ? pose.yaw : isFin(chart.yaw) ? chart.yaw : isFin(contact?.yaw) ? contact.yaw : isFin(view.yaw) ? view.yaw : 0;
  const pitch = isFin(pose.pitch) ? pose.pitch : isFin(contact?.pitch) ? contact.pitch : isFin(view.pitch) ? view.pitch : 0;
  const heel = isFin(pose.heel) ? pose.heel : isFin(pose.roll) ? pose.roll : isFin(contact?.heel) ? contact.heel : isFin(contact?.roll) ? contact.roll : isFin(view.heel) ? view.heel : 0;
  const heave = isFin(pose.heave) ? pose.heave : isFin(contact?.heave) ? contact.heave : 0;
  const scale = isFin(pose.scale) && pose.scale > 0 ? pose.scale : isFin(contact?.scale) && contact.scale > 0 ? contact.scale : 1;

  const parts = [];
  if (contact?.relToDeck && contact.relToDeck.length === 16) parts.push(contact.relToDeck);
  parts.push(R.shipToRel(dx, dz, { yaw, pitch, heel, heave }));
  if (scale !== 1) parts.push(R.sc(scale));
  const deckToShip = pose.hull?.deckToShip ?? contact?.hull?.deckToShip;
  if (deckToShip && deckToShip.length === 16) parts.push(deckToShip);

  return R.chain(...parts);
}

function resolveDeckY(contact) {
  if (isFin(contact?.deckY)) return contact.deckY;
  if (isFin(contact?.analysis?.deckY)) return contact.analysis.deckY;
  if (isFin(contact?.view?.deckY)) return contact.view.deckY;
  return DEFAULT_DECK_Y;
}

function collectSailors(contact, deckY) {
  const out = [];
  const seen = new Set();

  const push = (raw, role, allowDefaultPos) => {
    if (!raw || typeof raw !== 'object') return;
    const x = isFin(raw.x) ? raw.x : (allowDefaultPos ? 0 : null);
    const z = isFin(raw.z) ? raw.z : (allowDefaultPos ? 0 : null);
    if (x === null || z === null) return;
    const y = isFin(raw.y) ? raw.y : deckY;
    const id = raw.id ?? raw.peerId ?? `${contact?.id ?? 'ship'}:${role}:${x},${z}`;
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, id: key, role, x, y, z });
  };

  if (contact?.captain && typeof contact.captain === 'object') {
    push(contact.captain, 'captain', true);
  }
  const crewList = Array.isArray(contact?.crew)
    ? contact.crew
    : Array.isArray(contact?.crewPoses)
      ? contact.crewPoses
      : Array.isArray(contact?.poses)
        ? contact.poses
        : [];
  for (const member of crewList.slice(0, MAX_CREW_PER_CONTACT)) {
    push(member, 'crew', false);
  }
  return out;
}

function resolveAnimState(peer) {
  const anim = String(peer?.animation ?? '').trim().toLowerCase();
  if (ATTACK_ANIMS.has(anim)) return 'attack';
  if (RANGED_ANIMS.has(anim)) return 'ranged';
  if (HURT_ANIMS.has(anim)) return 'hurt';
  if (peer?.moving || MOVE_ANIMS.has(anim)) return 'move';
  return 'idle';
}

function unwrapDoll(doll) {
  if (!doll || typeof doll !== 'object') return null;
  const entry = doll.entry && typeof doll.entry === 'object' ? doll.entry : doll;
  const record = Number.isInteger(doll.record) ? doll.record : 0;
  const frame = Number.isInteger(doll.frame) ? doll.frame : 0;
  if (!entry?.atlas?.rects?.[record]?.[frame]) return null;
  const recWorld = entry.sprite?.records?.[record]?.world ?? entry.world ?? null;
  const w = isFin(doll.w) && doll.w > 0 ? doll.w : isFin(recWorld?.width) && recWorld.width > 0 ? recWorld.width : DEFAULT_DOLL_WIDTH;
  const h = isFin(doll.h) && doll.h > 0 ? doll.h : isFin(recWorld?.height) && recWorld.height > 0 ? recWorld.height : DEFAULT_DOLL_HEIGHT;
  return { entry, record, frame, w, h, flip: !!doll.flip };
}

function buildSailorBillboard({
  contactId, sailor, peer, wx, wy, wz, worldYaw, camera, now, spriteLibrary, dollLibrary, light,
}) {
  const app = resolvePeerAppearance(peer);
  const facing = facingIndex(wx, wz, worldYaw, camera.x, camera.z);
  const form = String(peer?.form ?? '').trim().toLowerCase();
  const isBeast = BEAST_FORMS.has(form);
  const baseLight = isFin(light) ? light : 0.96;
  const coverage = isFin(peer?.coverage) ? peer.coverage : 1;
  const hurt = isFin(peer?.hurt) ? peer.hurt : 0;

  // 1. Defeated sailor -> classic corpse sprite when available.
  if (app.defeated && app.corpse && spriteLibrary?.get) {
    const [ca, cr] = app.corpse;
    const corpseEntry = spriteLibrary.get(ca);
    const rec = corpseEntry?.sprite?.records?.[cr];
    if (corpseEntry && rec && corpseEntry.atlas?.rects?.[cr]?.[0]) {
      const frame = frameAt(now, 4, rec.frameCount ?? 1, true);
      return {
        key: `deck:${contactId}:${sailor.id}`,
        id: sailor.id,
        contactId,
        peerId: sailor.id,
        role: sailor.role,
        source: 'corpse',
        facing,
        entry: corpseEntry,
        record: cr,
        frame,
        flip: false,
        x: wx,
        y: wy,
        z: wz,
        w: rec.world?.width ?? DEFAULT_DOLL_WIDTH,
        h: rec.world?.height ?? DEFAULT_DOLL_HEIGHT,
        light: baseLight * 0.82,
        tint: app.tint ?? null,
        hurt: 0,
        coverage,
      };
    }
  }

  // 2. Front / 3/4 view -> equipped-gear ARENA2 doll when ready.
  if (!app.defeated && !isBeast && isDollFacing(facing) && typeof dollLibrary?.get === 'function') {
    const doll = unwrapDoll(dollLibrary.get(peer));
    if (doll) {
      return {
        key: `deck:${contactId}:${sailor.id}`,
        id: sailor.id,
        contactId,
        peerId: sailor.id,
        role: sailor.role,
        source: 'doll',
        facing,
        entry: doll.entry,
        record: doll.record,
        frame: doll.frame,
        flip: doll.flip,
        x: wx,
        y: wy,
        z: wz,
        w: doll.w,
        h: doll.h,
        light: baseLight,
        tint: null,
        hurt,
        coverage,
      };
    }
  }

  // 3. Fallback -> classic 8-direction TEXTURE sprite from spriteLibrary.
  if (typeof spriteLibrary?.get !== 'function') return null;
  const entry = spriteLibrary.get(app.archive);
  if (!entry?.sprite?.records?.length) return null;

  const state = app.defeated ? 'dying' : resolveAnimState(peer);
  const recordCount = entry.sprite.recordCount ?? entry.sprite.records.length;
  const anim = animRecord(app, state, facing, recordCount);
  if (!anim || anim.record >= recordCount) return null;

  const rec = entry.sprite.records[anim.record];
  if (!rec) return null;
  const frameCount = rec.frameCount ?? entry.atlas?.rects?.[anim.record]?.length ?? 1;
  const frame = anim.still ? 0 : frameAt(now, anim.fps, frameCount, anim.loop);
  if (!entry.atlas?.rects?.[anim.record]?.[frame]) return null;

  return {
    key: `deck:${contactId}:${sailor.id}`,
    id: sailor.id,
    contactId,
    peerId: sailor.id,
    role: sailor.role,
    source: 'sprite',
    facing,
    entry,
    record: anim.record,
    frame,
    flip: anim.flip,
    x: wx,
    y: wy,
    z: wz,
    w: rec.world?.width ?? DEFAULT_DOLL_WIDTH,
    h: rec.world?.height ?? DEFAULT_DOLL_HEIGHT,
    light: baseLight,
    tint: app.tint ?? null,
    hurt,
    coverage,
  };
}

/**
 * Project visible sea contacts' captains and crew into world-space `SpritePass`
 * billboard items standing cleanly on each ship's rolling/pitching deck.
 */
export function projectContactCrewBillboards({
  contacts,
  camera,
  now = 0,
  spriteLibrary = null,
  dollLibrary = null,
  peerStateById = null,
  drawRange = DRAW_RANGE,
  light = 0.96,
} = {}) {
  if (!camera || !isFin(camera.x) || !isFin(camera.z)) return [];
  const items = [];
  const maxRange = isFin(drawRange) && drawRange > 0 ? drawRange : DRAW_RANGE;
  const t = isFin(now) ? now : 0;

  for (const contact of iterateContacts(contacts)) {
    if (!contact || typeof contact !== 'object') continue;
    const contactId = String(contact.id ?? contact.view?.id ?? 'ship');
    const deckY = resolveDeckY(contact);
    const sailors = collectSailors(contact, deckY);
    if (!sailors.length) continue;

    const matrix = resolveContactMatrix(contact);
    for (const sailor of sailors) {
      const [wx, wy, wz] = R.apply(matrix, sailor.x, sailor.y, sailor.z);
      if (Math.hypot(wx - camera.x, wz - camera.z) > maxRange) continue;

      const peerState = lookupPeerState(peerStateById, sailor.id);
      const peer = mergePeer(peerState, sailor.raw);
      if (peer.coverage === 0) continue;

      const localYaw = isFin(peer.yaw) ? peer.yaw : 0;
      const [fx, , fz] = R.applyDir(matrix, Math.sin(localYaw), 0, -Math.cos(localYaw));
      const worldYaw = fx === 0 && fz === 0 ? localYaw : Math.atan2(fx, -fz);

      const item = buildSailorBillboard({
        contactId,
        sailor,
        peer,
        wx,
        wy,
        wz,
        worldYaw,
        camera,
        now: t,
        spriteLibrary,
        dollLibrary,
        light,
      });
      if (item) items.push(item);
    }
  }
  return items;
}

/**
 * Thin controller wrapping `projectContactCrewBillboards` and `SpritePass`,
 * ready to plug directly into `client/gameplay/sailing/render.js`.
 */
export function createDeckPeerPass({
  spriteLibrary = null,
  dollLibrary = null,
  pass = null,
  drawRange = DRAW_RANGE,
} = {}) {
  const spritePass = pass ?? new SpritePass();
  let items = [];
  let drawn = new Set();
  let disposed = false;

  return {
    update({
      contacts,
      camera,
      now = 0,
      peerStateById = null,
      spriteLibrary: nextSpriteLibrary,
      dollLibrary: nextDollLibrary,
      drawRange: nextDrawRange,
      light,
    } = {}) {
      if (disposed) {
        items = [];
        drawn = new Set();
        return items;
      }
      items = projectContactCrewBillboards({
        contacts,
        camera,
        now,
        spriteLibrary: nextSpriteLibrary ?? spriteLibrary,
        dollLibrary: nextDollLibrary ?? dollLibrary,
        peerStateById,
        drawRange: nextDrawRange ?? drawRange,
        light,
      });
      drawn = new Set(items.map((it) => String(it.id)));
      return items;
    },

    draw(gl, renderer, camera) {
      if (disposed || !items.length || !gl || !renderer || !camera) return;
      spritePass.draw(gl, renderer, camera, items);
    },

    drawnIds() {
      return [...drawn];
    },

    hasSprite(id) {
      return drawn.has(String(id));
    },

    dispose() {
      disposed = true;
      items = [];
      drawn.clear();
      if (spritePass?.textures instanceof Map) spritePass.textures.clear();
    },
  };
}
