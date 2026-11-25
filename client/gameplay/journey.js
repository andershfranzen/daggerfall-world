// The travel journey, shown after the server has accepted a `travel.go`
// (server/rpg/travel.js sends a `travel` game event with the route; a refused journey sends none,
// so nothing here ever plays for a refusal).
//
//  1. Rise:   the eye leaves the head and climbs behind and above the traveller, who now stands
//             visible in the street (on the horse when riding).
//  2. Map:    the view gives way to the whole Iliac Bay assembled from the original region maps in
//             the player's own ARENA2. It starts close on the origin, zooms out until origin and
//             destination are both in view, and the traveller (their own character sprite, mounted
//             when riding) walks or rides the classic stepped route the fare was priced on. The bar
//             counts days of that route's own time, so slow country and sea visibly take longer.
//  3. Arrive: the destination scene (loaded meanwhile by client/gameplay/travel.js, held back until
//             the map covers the screen) appears under a raised view over the traveller, and the eye
//             falls back into first person.
//
// The camera follows the Daggerfall Online travel view's law (.ref/dfjs-research-03
// src/player/travelCamera.js, MIT (c) 2026 Lattymoy): a raised, tilted eye that stays out of the
// player's own position and the streaming; here it is a view transform over the shell's camera,
// adapted to this shell's frame (yaw 0 faces -z, north).
//
// Reduced motion (prefers-reduced-motion or the settings toggle): no rise or fall and no zoom; the
// map shows both ends at once and the traveller crosses it in about a second and a half.
// Enter, Space or Escape (or the Skip button) jumps to the arrival.
//
// Reconnect: a journey whose event was missed (connection dropped mid-way) is replayed from
// `rpg.travel.lastTrip` while its presentation time has not run out.

import { SpriteLibrary } from './actors/library.js';
import { SpritePass } from './actors/spritePass.js';
import { peerAppearance, animRecord, facingIndex, frameAt } from './actors/logic.js';
import { mountedItems, HORSE_ARCHIVE, horseFlip, RIDER_LIFT } from './mount/sprites.js';
import { MapImages } from './travel/mapimages.js';
import { indexFiles } from '../world/files.js';
import { journeyRoute, routeAt, presentationMs } from './travel/journey.js';
import {
  compositeWorld, COMPOSITE_MAPS, frameRoute, closeView, lerpView, timelineAt, dayAt, toCanvas, smooth,
} from './travel/journeyView.js';
import { sceneLocationId } from './travel.js';

const RISE_S = 1.1;
const FALL_S = 0.9;
const COVER_S = 0.35;
const REVEAL_S = 0.45;
const RAISED_HEIGHT = 18; // metres over the traveller's feet
// The traveller's own sprite is drawn this much larger in the raised view so it reads at a glance
// (the reference's tvOwnGrow: about one step per 32 m of eye distance, never below 1).
const RAISED_GROW = 2.2;
const RAISED_TILT = (48 * Math.PI) / 180; // below the horizon
const RAISED_ORBIT = 0.85; // radians round from behind, so the traveller shows in three-quarter view
const SCENE_WAIT_MS = 20000;
const SHOWN_KEY = 'dfw-journeys-shown';

const smooth01 = (t) => smooth(t);
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; else if (a <= -Math.PI) a += Math.PI * 2; return a; };

/** The raised eye over feet (x, y, z) for a traveller facing `yaw` (shell frame: forward = (sin, -cos)). */
export function raisedCamera(x, y, z, yaw) {
  const camYaw = wrap(yaw + RAISED_ORBIT);
  const back = RAISED_HEIGHT / Math.tan(RAISED_TILT);
  return { x: x - Math.sin(camYaw) * back, y: y + RAISED_HEIGHT, z: z + Math.cos(camYaw) * back, yaw: camYaw, pitch: -RAISED_TILT };
}

/** Blend two cameras (`t` already eased): position straight across, yaw the short way round. */
export function blendCamera(a, b, t) {
  return {
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
    yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * t), pitch: lerp(a.pitch, b.pitch, t),
  };
}

const STYLE = `
.journey{position:fixed;inset:0;z-index:60;background:#05080b;opacity:0;transition:opacity .35s linear;display:grid;
  grid-template-rows:1fr auto;color:#e6edf5;font:15px/1.35 var(--font-sans,system-ui,sans-serif)}
.journey[hidden]{display:none}
.journey.is-shown{opacity:1}
.journey-map{grid-row:1/3;grid-column:1;width:100%;height:100%;image-rendering:pixelated;display:block}
.journey-hud{grid-row:2;grid-column:1;align-self:end;justify-self:center;margin:0 1rem 1.2rem;padding:.75rem 1rem .8rem;
  width:min(40rem,calc(100% - 2rem));box-sizing:border-box;background:rgba(10,16,24,.82);border:1px solid rgba(150,175,205,.35);
  border-radius:4px;display:grid;grid-template-columns:1fr auto;gap:.3rem .9rem;align-items:center}
.journey-title{margin:0;font-size:1.1rem;letter-spacing:.02em;grid-column:1}
.journey-title b{font-weight:600;color:#cfe6ff}
.journey-route{margin:0;font-size:.85rem;color:#a9b8c9;grid-column:1}
.journey-skip{grid-column:2;grid-row:1/3}
.journey-bar{grid-column:1/3;height:8px;border-radius:4px;background:rgba(150,175,205,.18);overflow:hidden}
.journey-fill{display:block;height:100%;width:0;background:linear-gradient(90deg,#6fa8dc,#cfe6ff)}
.journey-meta{grid-column:1/3;margin:0;font-size:.85rem;color:#a9b8c9;display:flex;flex-wrap:wrap;gap:.15rem .9rem}
.journey-meta b{color:#e6edf5;font-weight:600}
@media (max-width:520px),(max-height:420px){.journey-hud{margin:0 .5rem .5rem;padding:.5rem .7rem;width:calc(100% - 1rem)}
  .journey-title{font-size:1rem}.journey-route{display:none}}
@media (prefers-reduced-motion:reduce){.journey{transition:none}}
`;

export function install(api) {
  const doc = globalThis.document;
  const S = {
    j: null, // the journey being shown
    library: new SpriteLibrary(),
    pass: new SpritePass(),
    removePass: null,
    passRenderer: null,
    items: [],
    images: null,
    imagesFor: null,
    world: null, // {canvas} composite of the bay for the current files
    worldFor: null,
    worldLoad: null,
    overlay: null,
    gate: null, // {promise, resolve}
    shown: loadShown(),
    lastCamera: null,
    lastFoot: null,
    raf: 0,
  };

  // ------------------------------------------------------------------ helpers

  function loadShown() {
    try { return new Set(JSON.parse(globalThis.sessionStorage?.getItem(SHOWN_KEY) ?? '[]')); } catch { return new Set(); }
  }
  function markShown(at) {
    if (!Number.isFinite(at)) return;
    S.shown.add(at);
    try { globalThis.sessionStorage?.setItem(SHOWN_KEY, JSON.stringify([...S.shown].slice(-20))); } catch { /* private mode */ }
  }

  const reducedMotion = () => !!(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    || doc?.documentElement?.dataset.reducedMotion === 'true' || doc?.body?.dataset.reducedMotion === 'true');
  const sheet = () => api.state?.character?.character ?? {};
  const selfAppearance = () => {
    const c = sheet();
    return peerAppearance({ id: api.selfId ?? 'self', gender: c.gender, race: c.race, className: c.className, readied: false });
  };

  function setFiles(files) {
    S.library.setFiles(files ? [...files] : null);
    S.images = null;
    S.imagesFor = null;
    S.world = null;
    S.worldFor = null;
    S.worldLoad = null;
  }

  function images() {
    if (S.imagesFor !== api.files) {
      S.imagesFor = api.files;
      let index;
      try { index = indexFiles(api.files ? [...api.files] : []); } catch { index = new Map(); }
      S.images = new MapImages(index);
    }
    return S.images;
  }

  /** The bay composite for the current files (a canvas), loaded once. */
  function worldMap() {
    if (S.worldFor === api.files && S.worldLoad) return S.worldLoad;
    S.worldFor = api.files;
    const imgs = images();
    S.worldLoad = (async () => {
      const decoded = new Map();
      await Promise.all(COMPOSITE_MAPS.filter((n) => imgs.has(n)).map(async (n) => {
        try { decoded.set(n, await imgs.image(n)); } catch { /* a damaged map leaves sea */ }
      }));
      if (!decoded.size) throw new Error('No region maps (FMAP*.IMG) in your Daggerfall files');
      const w = compositeWorld((n) => decoded.get(n) ?? null);
      const canvas = doc.createElement('canvas');
      canvas.width = w.width;
      canvas.height = w.height;
      canvas.getContext('2d').putImageData(new ImageData(w.rgba, w.width, w.height), 0, 0);
      return (S.world = { canvas });
    })();
    S.worldLoad.catch((err) => console.warn('[journey] map unavailable:', err.message));
    return S.worldLoad;
  }

  /** A sprite frame as a canvas (palette from the library), cached on the entry. */
  function frameCanvas(entry, record, frame) {
    const cache = (entry.journeyFrames ||= new Map());
    const key = `${record}:${frame}`;
    let c = cache.get(key);
    if (c) return c;
    const img = entry.sprite.frame(record, frame);
    const pal = S.library.palette;
    if (!pal) return null;
    const rgba = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0; i < img.data.length; i++) {
      const p = img.data[i];
      if (!p) continue;
      rgba[i * 4] = pal[p * 3]; rgba[i * 4 + 1] = pal[p * 3 + 1]; rgba[i * 4 + 2] = pal[p * 3 + 2]; rgba[i * 4 + 3] = 255;
    }
    c = doc.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(rgba, img.width, img.height), 0, 0);
    cache.set(key, c);
    return c;
  }

  // ------------------------------------------------------------------ 3D: the traveller in the street

  function attachPass() {
    const r = api.renderer;
    if (!r || r === S.passRenderer || typeof r.addPass !== 'function') return;
    S.removePass?.();
    S.passRenderer = r;
    S.removePass = r.addPass((gl, renderer, camera) => {
      if (S.items.length && S.j?.raised) S.pass.draw(gl, renderer, camera, S.items);
    });
  }

  function travellerItems(feet, yaw, camera, now) {
    const app = selfAppearance();
    const entry = S.library.get(app.archive);
    if (!entry) return [];
    const facing = facingIndex(feet.x, feet.z, yaw, camera.x, camera.z);
    const a = animRecord(app, 'idle', facing, entry.sprite.recordCount);
    if (!a || a.record >= entry.sprite.recordCount) return [];
    const rec = entry.sprite.records[a.record];
    const frame = a.still ? 0 : frameAt(now, a.fps, rec.frameCount, true);
    const rider = {
      key: 'self', id: api.selfId ?? 'self', entry, record: a.record, frame, flip: a.flip,
      x: feet.x, y: feet.y, z: feet.z, w: rec.world.width, h: rec.world.height, light: 0.98, tint: null, hurt: 0,
    };
    const list = S.j?.mounted
      ? mountedItems(rider, S.library.get(HORSE_ARCHIVE), camera, { coat: api.state?.character?.mount?.coat ?? 0, facing })
      : [rider];
    // Grow with the eye's distance: 1 at head height, RAISED_GROW at the top of the rise.
    const g = 1 + (RAISED_GROW - 1) * Math.min(1, Math.max(0, (camera.y - feet.y - 2) / (RAISED_HEIGHT - 2)));
    return list.map((it) => ({ ...it, w: it.w * g, h: it.h * g, y: feet.y + (it.y - feet.y) * g }));
  }

  (api.viewTransforms ||= []).push((camera, f) => {
    S.lastCamera = camera;
    S.lastFoot = f?.footY ?? null;
    const j = S.j;
    if (!j || !j.raised) { S.items = []; return camera; }
    attachPass();
    const now = performance.now() / 1000;
    const feet = j.phase === 'rise' || j.phase === 'cover' ? j.originFeet
      : { x: camera.x, y: f?.footY ?? j.originFeet.y, z: camera.z };
    const yaw = j.phase === 'rise' || j.phase === 'cover' ? j.originYaw : camera.yaw;
    const high = raisedCamera(feet.x, feet.y, feet.z, yaw);
    let view = high;
    if (j.phase === 'rise') view = blendCamera(j.originCamera, high, smooth01((now - j.phaseAt) / RISE_S));
    else if (j.phase === 'fall') view = blendCamera(high, camera, smooth01((now - j.phaseAt) / FALL_S));
    S.items = travellerItems(feet, yaw, view, now);
    return view;
  });

  // ------------------------------------------------------------------ overlay

  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function ensureOverlay() {
    if (S.overlay || !doc?.createElement) return S.overlay;
    if (!doc.getElementById('journey-style')) {
      const style = el('style');
      style.id = 'journey-style';
      style.textContent = STYLE;
      doc.head?.append(style);
    }
    const root = el('div', 'journey');
    root.id = 'journey';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Journey');
    const canvas = el('canvas', 'journey-map');
    canvas.setAttribute('role', 'img');
    const hud = el('div', 'journey-hud');
    const title = el('p', 'journey-title');
    const route = el('p', 'journey-route');
    const skip = el('button', 'btn btn-small journey-skip', 'Skip');
    skip.type = 'button';
    skip.title = 'Skip to the arrival (Enter)';
    skip.addEventListener('click', () => skipJourney());
    const bar = el('div', 'journey-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    const fill = el('span', 'journey-fill');
    bar.append(fill);
    const meta = el('p', 'journey-meta');
    meta.setAttribute('aria-live', 'polite');
    hud.append(title, route, skip, bar, meta);
    root.append(canvas, hud);
    doc.body.append(root);
    S.overlay = { root, canvas, ctx: canvas.getContext('2d'), title, route, skip, bar, fill, meta, lastDay: -1 };
    return S.overlay;
  }

  function showOverlay(j) {
    const o = ensureOverlay();
    if (!o) return;
    o.root.hidden = false;
    o.lastDay = -1;
    o.title.replaceChildren(doc.createTextNode('Travelling to '), Object.assign(el('b'), { textContent: j.toName }),
      doc.createTextNode(j.toRegion && j.toRegion !== j.toName ? `, ${j.toRegion}` : ''));
    o.route.textContent = `From ${j.fromName}${j.fromRegion && j.fromRegion !== j.fromName ? `, ${j.fromRegion}` : ''}`;
    o.bar.setAttribute('aria-valuemax', String(j.days));
    o.bar.setAttribute('aria-label', `Journey to ${j.toName}`);
    o.canvas.setAttribute('aria-label', `Map of the Iliac Bay: ${j.fromName} to ${j.toName}, ${j.days} day${j.days === 1 ? '' : 's'}${j.mounted ? ' on horseback' : ''}.`);
    // force the transition from 0
    void o.root.offsetWidth;
    o.root.classList.add('is-shown');
    o.skip.focus({ preventScroll: true });
  }

  function hideOverlay() {
    const o = S.overlay;
    if (!o) return;
    o.root.classList.remove('is-shown');
  }

  function drawMap(j, nowMs) {
    const o = S.overlay;
    if (!o || o.root.hidden) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(o.canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(o.canvas.clientHeight * dpr));
    if (o.canvas.width !== cw || o.canvas.height !== ch) { o.canvas.width = cw; o.canvas.height = ch; }
    const g = o.ctx;
    const aspect = cw / ch;
    const tl = timelineAt(nowMs - j.mapAt, j.showMs, { reducedMotion: j.reduced });
    const elapsed = j.phase === 'map' ? tl : { zoomOut: 1, travel: 1, settle: 1, progress: 1, done: true };
    const start = closeView(j.from, aspect), mid = frameRoute(j.from, j.to, aspect), end = closeView(j.to, aspect);
    let view = j.reduced ? mid : lerpView(start, mid, elapsed.zoomOut, aspect);
    if (!j.reduced && elapsed.settle > 0) view = lerpView(mid, { ...end, w: Math.max(end.w, mid.w * 0.6) }, elapsed.settle * 0.5, aspect);
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#05080b';
    g.fillRect(0, 0, cw, ch);
    if (S.world) {
      g.drawImage(S.world.canvas, view.cx - view.w / 2, view.cy - view.h / 2, view.w, view.h, 0, 0, cw, ch);
    }
    const P = (x, y) => toCanvas(view, cw, ch, x + 0.5, y + 0.5);
    // Route: the classic stepped line, travelled part solid.
    const pts = j.route.points;
    const f = elapsed.progress;
    const here = routeAt(pts, f);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.setLineDash([6 * dpr, 6 * dpr]);
    g.strokeStyle = 'rgba(230,240,255,.85)';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    for (let i = 0; i < pts.length; i++) { const p = P(pts[i].x, pts[i].y); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#cfe6ff';
    g.lineWidth = 3.5 * dpr;
    g.beginPath();
    let first = true;
    for (const p0 of pts) {
      if (p0.f > f) break;
      const p = P(p0.x, p0.y);
      if (first) { g.moveTo(p.x, p.y); first = false; } else g.lineTo(p.x, p.y);
    }
    const hp = P(here.x, here.y);
    if (!first) { g.lineTo(hp.x, hp.y); g.stroke(); }
    // Ends.
    const a = P(j.from.x, j.from.y), b = P(j.to.x, j.to.y);
    const crowded = Math.hypot(a.x - b.x, a.y - b.y) < 60 * dpr; // short trips: origin label above, destination below
    const pin = (p, label, filled) => {
      const c = P(p.x, p.y);
      const above = crowded && !filled;
      g.fillStyle = filled ? '#cfe6ff' : 'rgba(10,16,24,.9)';
      g.strokeStyle = '#cfe6ff';
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.arc(c.x, c.y, 5 * dpr, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.font = `600 ${13 * dpr}px system-ui, sans-serif`;
      const tw = g.measureText(label).width;
      // Short trips: the origin's label sits to the left of its pin, clear of the traveller above it.
      const lx = Math.min(cw - tw - 10 * dpr, Math.max(6 * dpr, above ? c.x - tw - 40 * dpr : c.x - tw / 2));
      const ly = above ? c.y + 5 * dpr : c.y + 20 * dpr;
      g.fillStyle = 'rgba(10,16,24,.78)';
      g.fillRect(lx - 5 * dpr, ly - 13 * dpr, tw + 10 * dpr, 18 * dpr);
      g.fillStyle = '#e6edf5';
      g.fillText(label, lx, ly);
    };
    pin(j.from, j.fromName, false);
    pin(j.to, j.toName, true);
    drawTraveller(g, hp, j, dpr, nowMs, elapsed.progress < 1);
    // HUD
    const day = dayAt(f, j.days);
    o.fill.style.width = `${(f * 100).toFixed(1)}%`;
    if (day !== o.lastDay || j.phase !== o.lastPhase) {
      o.lastDay = day;
      o.lastPhase = j.phase;
      o.bar.setAttribute('aria-valuenow', String(day));
      o.bar.setAttribute('aria-valuetext', `Day ${day} of ${j.days}`);
      const bits = [
        [`Day ${day}`, ` of ${j.days}`],
        [j.mounted ? 'On horseback' : j.transport === 'horse' ? 'With your horse' : j.transport === 'cart' ? 'By cart' : 'On foot', ''],
        [j.options.speed === 'cautious' ? 'Cautiously' : 'Recklessly', ''],
        [j.options.lodging === 'inn' ? 'Nights at inns' : 'Camping out', ''],
        [j.options.ship ? 'Ship passage' : '', ''],
        [j.cost > 0 ? `${j.cost} gold` : '', ''],
      ].filter(([a]) => a);
      o.meta.replaceChildren(...bits.map(([a, b]) => { const s = el('span'); s.append(Object.assign(el('b'), { textContent: a }), doc.createTextNode(b)); return s; }));
      if (j.phase === 'wait') o.meta.append(el('span', null, `Arriving in ${j.toName}…`));
    }
  }

  function drawTraveller(g, p, j, dpr, nowMs, moving) {
    const app = selfAppearance();
    const entry = S.library.get(app.archive);
    const horse = j.mounted ? S.library.get(HORSE_ARCHIVE) : null;
    const east = j.to.x >= j.from.x;
    const facing = east ? 6 : 2; // facing the viewer's right (east) or left (west)
    const pxm = 26 * dpr; // pixels per metre of sprite
    const t = nowMs / 1000;
    const bob = moving && !j.reduced ? Math.abs(Math.sin(t * (j.mounted ? 9 : 6))) * 2.5 * dpr : 0;
    // ground shadow
    g.fillStyle = 'rgba(0,0,0,.35)';
    g.beginPath();
    g.ellipse(p.x, p.y, (j.mounted ? 30 : 12) * dpr, 5 * dpr, 0, 0, Math.PI * 2);
    g.fill();
    let feetY = p.y - bob;
    if (horse) {
      const rec = j.mounted && horse.sprite.records[(api.state?.character?.mount?.coat === 1) ? 1 : 0];
      const c = rec && frameCanvas(horse, (api.state?.character?.mount?.coat === 1) ? 1 : 0, 0);
      if (c) {
        const w = rec.world.width * pxm, h = rec.world.height * pxm;
        g.save();
        g.translate(p.x, p.y - bob);
        if (horseFlip(facing)) g.scale(-1, 1);
        g.drawImage(c, -w / 2, -h, w, h);
        g.restore();
        feetY = p.y - bob - RIDER_LIFT * pxm;
      }
    }
    if (!entry) {
      // Art still loading: a plain marker.
      g.fillStyle = '#cfe6ff';
      g.beginPath();
      g.arc(p.x, feetY - 10 * dpr, 7 * dpr, 0, Math.PI * 2);
      g.fill();
      return;
    }
    const a = animRecord(app, moving && !j.mounted ? 'move' : 'idle', facing, entry.sprite.recordCount);
    if (!a || a.record >= entry.sprite.recordCount) return;
    const rec = entry.sprite.records[a.record];
    const frame = a.still || !moving || j.reduced ? 0 : frameAt(t, a.fps, rec.frameCount, true);
    const c = frameCanvas(entry, a.record, frame);
    if (!c) return;
    const w = rec.world.width * pxm, h = rec.world.height * pxm;
    g.save();
    g.translate(p.x, feetY);
    if (a.flip) g.scale(-1, 1);
    g.drawImage(c, -w / 2, -h, w, h);
    g.restore();
  }

  // ------------------------------------------------------------------ the journey

  function setPhase(j, phase) {
    j.phase = phase;
    j.phaseAt = performance.now() / 1000;
    j.raised = phase === 'rise' || phase === 'cover' || phase === 'reveal' || phase === 'fall';
    api.emit('journey', { phase, raised: j.raised, to: j.toId });
  }

  function makeGate() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    S.gate = { promise, resolve };
  }
  function openGate() {
    S.gate?.resolve();
    S.gate = null;
  }
  /** client/gameplay/travel.js waits on this before showing the destination scene. */
  api.journeyGate = () => S.gate?.promise ?? null;

  /**
   * Start the journey for a `travel` event (or a replayed lastTrip). `resume` skips the rise
   * (reconnect), `remainingMs` shortens the map.
   */
  function play(ev, { resume = false, remainingMs = null } = {}) {
    const r = ev.route;
    if (!r?.from || !r?.to || !Number.isFinite(r.from.x) || !Number.isFinite(r.to.x)) return false;
    if (S.j) finish(true);
    const reduced = reducedMotion();
    const days = Math.max(1, ev.days | 0);
    let showMs = reduced ? presentationMs(days, { reducedMotion: true }) : (Number.isFinite(ev.showMs) ? ev.showMs : presentationMs(days));
    if (remainingMs != null) showMs = Math.max(reduced ? 600 : 1200, Math.min(showMs, remainingMs));
    const climate = api.travelWorld?.()?.climate;
    const opts = { ...(ev.options ?? {}), transport: ev.transport ?? 'foot' };
    if (climate && api.state?.character?.travel?.server !== 'classic') opts.climateAt = (x, y) => climate.atMapPixel(x, y);
    const cam = S.lastCamera;
    const j = {
      toId: ev.to, toName: ev.name ?? r.to.name, toRegion: r.to.region ?? ev.region ?? '', fromName: r.from.name || 'the wilds',
      fromRegion: r.from.region ?? '', from: r.from, to: r.to, days, cost: ev.cost | 0, transport: ev.transport ?? 'foot',
      options: ev.options ?? {}, mounted: ev.mounted === true, showMs, reduced, at: ev.at ?? null, text: typeof ev.text === 'string' ? ev.text : '',
      route: journeyRoute(r.from, r.to, opts), startedAt: performance.now(),
      originCamera: cam ? { ...cam } : null,
      originFeet: cam ? { x: cam.x, y: S.lastFoot ?? cam.y - 1.6, z: cam.z } : null,
      originYaw: cam?.yaw ?? 0,
    };
    S.j = j;
    api.movementLocked = true;
    makeGate();
    worldMap();
    // Warm the art the journey draws.
    S.library.get(selfAppearance().archive);
    if (j.mounted) S.library.get(HORSE_ARCHIVE);
    if (!reduced && !resume && j.originCamera && api.screen === 'game') setPhase(j, 'rise');
    else beginCover(j);
    tick();
    return true;
  }

  function beginCover(j) {
    setPhase(j, 'cover');
    showOverlay(j);
    j.coverAt = performance.now();
  }

  function beginMap(j) {
    openGate();
    setPhase(j, 'map');
    j.mapAt = performance.now();
  }

  function arrived(j) {
    const id = sceneLocationId(api.town);
    return !!id && id === j.toId;
  }

  function finish(abort = false) {
    const j = S.j;
    if (!j) return;
    S.j = null;
    S.items = [];
    openGate();
    hideOverlay();
    const o = S.overlay;
    if (o) setTimeout(() => { if (!S.j) o.root.hidden = true; }, abort ? 0 : 400);
    api.movementLocked = false;
    api.emit('journey', { phase: 'done', raised: false, to: j.toId });
    if (j.text) api.message(j.text);
    if (j.at != null) markShown(j.at);
  }

  function skipJourney() {
    const j = S.j;
    if (!j) return;
    if (j.phase === 'rise') { beginCover(j); j.coverAt -= COVER_S * 1000; }
    else if (j.phase === 'cover') { j.coverAt -= COVER_S * 1000; }
    else if (j.phase === 'map') { j.mapAt -= j.showMs; }
    else if (j.phase === 'reveal' || j.phase === 'fall') finish();
  }

  function tick() {
    cancelAnimationFrame(S.raf);
    const step = () => {
      const j = S.j;
      if (!j) return;
      const nowMs = performance.now();
      const nowS = nowMs / 1000;
      const inPhase = nowS - j.phaseAt;
      switch (j.phase) {
        case 'rise':
          if (inPhase >= RISE_S) beginCover(j);
          break;
        case 'cover':
          if (nowMs - j.coverAt >= COVER_S * 1000) { beginMap(j); j.mapAt = nowMs; }
          break;
        case 'map':
          if (nowMs - j.mapAt >= j.showMs) { setPhase(j, 'wait'); j.waitAt = nowMs; }
          break;
        case 'wait': {
          const failed = api.travelLoadError?.() === j.toId;
          if (arrived(j) || failed || nowMs - j.waitAt > SCENE_WAIT_MS || api.screen !== 'game') {
            if (j.reduced || !arrived(j)) { finish(); return; }
            setPhase(j, 'reveal');
            hideOverlay();
          }
          break;
        }
        case 'reveal':
          if (inPhase >= REVEAL_S) setPhase(j, 'fall');
          break;
        case 'fall':
          if (inPhase >= FALL_S) { finish(); return; }
          break;
        default: break;
      }
      if (j.phase === 'map' || j.phase === 'wait' || j.phase === 'cover') drawMap(j, nowMs);
      S.raf = requestAnimationFrame(step);
    };
    S.raf = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------ events

  setFiles(api.files);
  // Read the region maps once the game is up, so the first journey's map is ready when it opens.
  let warm = 0;
  const warmSoon = () => { clearTimeout(warm); warm = setTimeout(() => { if (api.files?.length) worldMap(); }, 2500); };
  api.on('assets', (files) => { setFiles(files); warmSoon(); });
  api.on('panel', (p) => { if (p?.id === 'map' && p.open) worldMap(); });
  api.on('event', (ev) => {
    if (!ev || ev.kind !== 'travel') return;
    const trip = api.state?.character?.travel?.lastTrip;
    const at = trip && trip.to === ev.to ? trip.at : ev.at ?? null;
    if (ev.repeat && (S.j || (at != null && S.shown.has(at)))) return;
    if (!play({ ...ev, at }) && ev.silent && ev.text) api.message(ev.text);
  });
  api.on('state', () => {
    // Reconnected while a journey was still on the road: show the rest of it.
    if (S.j || api.screen !== 'game') return;
    const t = api.state?.character?.travel?.lastTrip;
    if (!t || !Number.isFinite(t.at) || S.shown.has(t.at)) return;
    const left = (Number.isFinite(t.showMs) ? t.showMs : 0) - (Date.now() - t.at);
    if (left <= 300 || !t.route) { markShown(t.at); return; }
    play({ ...t, kind: 'travel', name: t.route.to?.name }, { resume: true, remainingMs: left });
  });
  api.on('screen', (screen) => {
    if (screen !== 'game' && S.j) finish(true);
    if (screen === 'game') warmSoon();
  });
  globalThis.addEventListener?.('keydown', (e) => {
    if (!S.j) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space' || e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      skipJourney();
    }
  }, true);

  const pub = {
    play,
    skip: skipJourney,
    /** Sprites drawn for the traveller this frame (for checks and tooling). */
    get drawn() { return S.items.map((it) => ({ archive: it.entry.archive, record: it.record, x: it.x, y: it.y, z: it.z, w: it.w, h: it.h })); },
    get passAttached() { return !!S.passRenderer; },
    get active() { return S.j ? { phase: S.j.phase, to: S.j.toId, mounted: S.j.mounted, days: S.j.days } : null; },
  };
  api.journey = pub;
  return pub;
}
