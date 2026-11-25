// Sailing renderer: the sea, the sky's roll, other ships, shores and harbours, and the sea fight, drawn around
// the classic "Your Ship" deck the player walks on. Installed by the sailing UI feature: installSailingRenderer(api).
//
// THE DECK STAYS PUT. Players walk the installed deck model in its own coordinates (deck-local feet, the normal
// Play camera and collision). Everything at sea - water, horizon, sky, other hulls, coasts, shot - is placed by
// the server's chart pose (x east, z south, yaw 0 north, metres) relative to the own ship and moved into the
// deck frame (renderMath.relToDeck), so heave, pitch and heel roll the world past a deck that never moves under
// anyone's feet. Two crew members on one deck share the same server snapshot and a shared wave clock (wall
// time), so both see the same sea and motion; each other's figures are the ordinary deck-local peers.
//
// SOURCES (server-authoritative; nothing here invents state):
//   gameEvent sailing.state   docs/sailing.md "Server protocol" (core): vessel, nearby, ports, wind, role, helm
//   gameEvent naval.state / naval.shot / naval.hit / naval.ram / naval.news   naval contract v1 (combat owner)
//   coast rings / land sampler (geo owner) when published: sailing.state.coast, or setCoast()/setLandSampler()
// Daggerfall Online (Lattymoy, MIT, .ref/dfjs-research-03 src/render/navalRender.js) was read for which cues a
// sea fight needs - smoke, flashes, spray, splinters, balls in the air, an aim arc; no code or asset is copied.

import { PALETTE } from '../../render/renderer.js';
import { Avatar } from '../../render/avatar.js';
import * as R from './renderMath.js';
import { analyseDeck, deckSlot, modelTriangles, stripTriangles, triangleRuns, BOW_BY_TYPE } from './renderHull.js';
import { SeaPass } from './renderSea.js';
import { SolidBatch, FxBatch, SHAPE, viewAxes } from './renderFx.js';
import { buildLand, buildHarbour, landPatch, woodsLandSampler } from './renderCoast.js';

const SHIP_SLOTS = Object.freeze({ small: 1, large: 2 });
const DRAW_RANGE = 3200;
const CONTACT_TTL = 20;
const WAKE_LIFE = 22;
const MAX_PARTICLES = 1600;
const FACTION_SAIL = Object.freeze({
  pirate: [[0.16, 0.14, 0.13], [0.5, 0.08, 0.06]],
  navy: [[0.9, 0.88, 0.82], [0.16, 0.26, 0.55]],
  merchant: [[0.86, 0.8, 0.66], [0.55, 0.32, 0.18]],
  player: [[0.9, 0.86, 0.76], [0.26, 0.42, 0.5]],
});
const FLAG = Object.freeze({
  pirate: [[0.07, 0.07, 0.07], [0.85, 0.85, 0.8]],
  navy: [[0.14, 0.24, 0.6], [0.95, 0.8, 0.25]],
  merchant: [[0.7, 0.45, 0.15], [0.95, 0.92, 0.8]],
  player: [[0.2, 0.45, 0.55], [0.95, 0.92, 0.8]],
  hostile: [[0.75, 0.08, 0.06], [0.08, 0.06, 0.05]],
  struck: [[0.95, 0.95, 0.92], [0.95, 0.95, 0.92]],
});
const WOOD = [0.36, 0.24, 0.14], DARK_WOOD = [0.22, 0.15, 0.09];

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rnd = (seed) => { let x = seed >>> 0 || 1; return () => ((x = Math.imul(x ^ (x >>> 15), 2246822519) ^ Math.imul(x ^ (x >>> 13), 3266489917)) >>> 0) / 4294967296; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

/**
 * Install the sea renderer. Returns the controller also published as `api.sailingRender`:
 *   intake(ev)          feed a sailing/naval gameEvent directly (also subscribed to api 'event')
 *   active()            true while the sea is drawn around the current deck
 *   deckFrame()         {bowYaw, pivot, length, beam, deckToChart(x,y,z), chartToDeck(X,Y,Z), pose} or null
 *   setHelmView(on)     raised helm view while holding the helm (default on)
 *   setAim(aim|null)    {side:'port'|'starboard'|'bow'|'stern', range (m)} draws the laid guns' arcs and fall zone
 *   setCoast(rings), setLandSampler(fn(x,z)->h|null)   shores from the geo owner
 *   labels()            [{id, name, kind, x, y (CSS px), distance, hostile}] for the UI's own name tags
 *   stats()             counts of what the last frame drew (tests and probes)
 *   dispose()
 */
export function installSailingRenderer(api, opts = {}) {
  if (api.sailingRender?.dispose) return api.sailingRender;
  const S = {
    sailing: null, role: 'none', helm: false, own: null, ownNaval: null, ownTrack: new R.VesselTrack(60),
    wind: null, ports: [], coast: [], coastKey: null, land: null, landSampler: opts.landSampler ?? null, patch: null,
    contacts: new Map(), balls: new Map(), particles: [], flecks: [], wakes: new Map(),
    clock: new R.ServerClock(), aim: null, helmView: opts.helmView !== false,
    deck: null, deckTown: null, applied: null, hulls: new Map(), loading: new Map(), avatars: new Map(),
    frame: null, active: false, last: performance.now() / 1000, emitAcc: new Map(), stats: {},
  };
  const sea = new SeaPass(), solids = new SolidBatch(), fx = new FxBatch();
  const unsub = [];
  const localNow = () => performance.now() / 1000;
  const serverNow = () => S.clock.now(localNow());

  // ------------------------------------------------------------------ intake
  function upsertContact(view, src) {
    const v = R.readVessel(view);
    if (!v || (S.own && v.id === S.own.id)) return null;
    const c = S.contacts.get(v.id) ?? { id: v.id, track: new R.VesselTrack(), view: null, seen: 0, sinkSince: null, crew: [] };
    c.view = { ...(c.view ?? {}), ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)) };
    c.seen = localNow();
    c[src] = true;
    if (c.view.state === 'sinking' && c.sinkSince === null) c.sinkSince = localNow() - (Number.isFinite(v.sinkingSince) && serverNow() !== null ? Math.max(0, serverNow() - v.sinkingSince) : 0);
    if (c.view.state === 'afloat') c.sinkSince = null;
    if (Array.isArray(view.crewPoses ?? view.poses)) c.crew = (view.crewPoses ?? view.poses).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.z));
    c.track.update(c.view, localNow());
    S.contacts.set(v.id, c);
    return c;
  }

  function intake(ev) {
    if (!ev || typeof ev !== 'object') return;
    const kind = ev.kind;
    if (kind === 'admiralty.sea') { readMarks(ev); return; }
    if (typeof kind !== 'string' || !/^(sailing|naval)\./.test(kind)) return;
    if (/^naval\./.test(kind) && Number.isFinite(ev.t)) S.clock.observe(ev.t, localNow());
    if (kind === 'sailing.state') {
      S.sailing = ev;
      S.role = typeof ev.role === 'string' ? ev.role : ev.vessel ? 'passenger' : 'none';
      S.helm = ev.helm === true;
      const own = R.readVessel(ev.vessel);
      if (own) {
        if (S.own?.id !== own.id) { S.ownTrack = new R.VesselTrack(60); S.wakes.clear(); }
        S.own = { ...own, ...(S.ownNaval ? { state: S.ownNaval.state ?? own.state, fire: S.ownNaval.fire ?? own.fire, sailHealth: S.ownNaval.sailHealth ?? own.sailHealth, hullHealth: S.ownNaval.hullHealth ?? own.hullHealth, colours: S.ownNaval.colours ?? own.colours, faction: 'player' } : {}) };
        S.ownTrack.update(S.own, localNow());
      } else S.own = null;
      const w = R.readWind(ev.wind);
      if (w) S.wind = w;
      if (Array.isArray(ev.ports) && (ev.full || ev.ports.length >= S.ports.length || ev.ports.some((p) => Number.isFinite(p?.x)))) {
        const ports = R.readPorts(ev.ports);
        if (ev.full) S.ports = ports;
        else { const m = new Map(S.ports.map((p) => [p.id, p])); for (const p of ports) m.set(p.id, p); S.ports = [...m.values()]; }
      }
      for (const n of Array.isArray(ev.nearby) ? ev.nearby : []) upsertContact(n, 'sailing');
      if (ev.coast && typeof ev.coast === 'object') setCoast(ev.coast); // coast.shoreNear (geo owner)
      return;
    }
    if (kind === 'naval.state') {
      const self = ev.self && typeof ev.self === 'object' ? R.readVessel({ id: S.own?.id ?? 'self', x: 0, z: 0, ...ev.self }) : null;
      if (self) {
        S.ownNaval = { state: self.state, fire: self.fire, sailHealth: self.sailHealth, hullHealth: self.hullHealth, colours: self.colours };
        if (S.own) Object.assign(S.own, S.ownNaval);
      }
      for (const c of Array.isArray(ev.contacts) ? ev.contacts : []) upsertContact(c, 'naval');
      for (const b of Array.isArray(ev.projectiles) ? ev.projectiles : []) addBall(b, { gun: b.gun, shot: b.shot, volleyId: b.volleyId }, false);
      return;
    }
    if (kind === 'naval.shot') {
      const gun = ev.gun ?? 'long', shot = ev.shot ?? 'round';
      for (const b of Array.isArray(ev.balls) ? ev.balls : []) addBall(b, { gun, shot, volleyId: ev.volleyId, from: ev.from?.id, g: ev.g }, true);
      return;
    }
    if (kind === 'naval.hit') {
      const ball = S.balls.get(String(ev.ballId));
      if (ev.zone !== 'rig') S.balls.delete(String(ev.ballId)); // shot through the rigging flies on
      if (ev.view) upsertContact(ev.view, 'naval');
      if (Array.isArray(ev.point)) impact(ev.point, ev.zone ?? (ev.target ? 'hull' : 'water'), { fire: ev.fire === true, shot: ball?.shot, damage: ev.damage });
      return;
    }
    if (kind === 'naval.ram') {
      if (ev.view) upsertContact(ev.view, 'naval');
      if (ev.rammerView) upsertContact(ev.rammerView, 'naval');
      if (Array.isArray(ev.point)) { impact(ev.point, 'hull', { big: true }); impact([ev.point[0], 0, ev.point[2]], 'water', { big: true }); }
      return;
    }
    if (kind === 'naval.news') {
      const c = S.contacts.get(String(ev.shipId));
      if (c && ev.what === 'sinking') { c.view.state = 'sinking'; if (c.sinkSince === null) c.sinkSince = localNow(); }
      if (c && (ev.what === 'wrecked' || ev.what === 'sunk')) c.view.state = 'wrecked';
      if (c && (ev.what === 'struck' || ev.what === 'surrender')) c.view.state = 'struck';
      if (S.own && String(ev.shipId) === S.own.id && ev.what === 'sinking') S.own.state = 'sinking';
    }
  }

  /** Admiralty marks (server/rpg/admiralty.js `admiralty.sea`): casks afloat and contract sites. */
  function readMarks(ev) {
    const casks = Array.isArray(ev?.casks) ? ev.casks.filter((c) => c?.id != null && Number.isFinite(c.x) && Number.isFinite(c.z)) : [];
    const sites = Array.isArray(ev?.sites) ? ev.sites.filter((c) => c?.id != null && Number.isFinite(c.x) && Number.isFinite(c.z)) : [];
    S.marks = { casks: casks.map((c) => ({ id: String(c.id), x: c.x, z: c.z, kind: c.kind, haul: c.haul === true })), sites: sites.map((c) => ({ id: String(c.id), x: c.x, z: c.z, kind: c.kind, radius: Number.isFinite(c.radius) ? c.radius : 60 })) };
  }

  function addBall(b, meta, fresh) {
    if (!b || b.id == null || !Array.isArray(b.p0) || !Array.isArray(b.v0) || !Number.isFinite(b.t0)) return;
    const id = String(b.id);
    if (S.balls.has(id)) return;
    const floating = b.kind === 'barrel';
    const ball = { id, p0: b.p0.map(Number), v0: b.v0.map(Number), t0: b.t0, life: Number.isFinite(b.life) ? b.life : null, g: Number.isFinite(meta.g) ? meta.g : R.G, shot: b.shot ?? meta.shot, gun: floating ? 'barrel' : b.gun ?? meta.gun, from: meta.from ?? null, floating };
    ball.end = ball.t0 + (ball.life ?? (floating ? 90 : R.ballFlightTime(ball, ball.g) + 0.05));
    S.balls.set(id, ball);
    // The flash and smoke go off when the gun does (t0; a volley ripples 0.09 s gun to gun), not on receipt.
    const now = serverNow();
    ball.flashed = !fresh || (now !== null && now - ball.t0 > 1.5);
  }

  /** A ball's chart position: ballistic in flight; a fire barrel rides the sea where it was dropped. */
  function ballPos(b, t) {
    if (b.floating) return [b.p0[0], seaY(b.p0[0], b.p0[2]) + 0.3, b.p0[2]];
    return R.ballAt(b, t, b.g);
  }

  // ------------------------------------------------------------------ particles (chart coordinates)
  function emit(p) {
    if (S.particles.length >= MAX_PARTICLES) S.particles.shift();
    S.particles.push({ age: 0, grav: 0, drag: 0, rot: 0, add: false, flat: false, ...p });
  }
  function muzzle(ball) {
    const [x, y, z] = ball.p0;
    const dir = norm(ball.v0);
    const small = ball.gun === 'swivel';
    emit({ x, y, z, vx: dir[0] * 6, vy: dir[1] * 6, vz: dir[2] * 6, life: 0.14, s0: small ? 0.8 : 2.2, s1: small ? 1.2 : 3.2, color: [1, 0.72, 0.3, 1], shape: SHAPE.soft, add: true });
    const r = rnd(hash(ball.id));
    for (let i = 0; i < (small ? 2 : 5); i++) {
      const sp = 2 + r() * 5;
      emit({ x: x + dir[0] * i * 0.8, y, z: z + dir[2] * i * 0.8, vx: dir[0] * sp + (r() - 0.5), vy: 0.6 + r() * 0.8, vz: dir[2] * sp + (r() - 0.5), life: 5 + r() * 4, s0: small ? 0.6 : 1.4, s1: small ? 3 : 7, color: [0.78, 0.77, 0.74, 0.55], shape: SHAPE.smoke, drag: 0.6, wind: 0.7 });
    }
  }
  function impact(point, zone, { fire = false, big = false, shot = null } = {}) {
    const [x, , z] = point;
    const y = Number.isFinite(point[1]) ? point[1] : 0;
    const r = rnd(hash(`${x.toFixed(2)}${z.toFixed(2)}${zone}`));
    if (zone === 'water') {
      const n = big ? 22 : 12;
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, h = r();
        emit({ x, y: 0.2, z, vx: Math.cos(a) * (0.5 + r() * 1.8), vy: 6 + h * (big ? 12 : 9), vz: Math.sin(a) * (0.5 + r() * 1.8), life: 1.1 + h * 0.8, s0: 0.5 + r() * 0.5, s1: 1.6 + r(), color: [0.9, 0.94, 0.96, 0.75], shape: SHAPE.soft, grav: R.G });
      }
      emit({ x, y: 0.05, z, life: 3.5, s0: 1, s1: big ? 9 : 6, color: [0.92, 0.95, 0.96, 0.7], shape: SHAPE.ring, flat: true, onSea: true });
      emit({ x, y: 0.05, z, life: 2, s0: 1.5, s1: 3.5, color: [0.92, 0.95, 0.96, 0.5], shape: SHAPE.soft, flat: true, onSea: true });
      return;
    }
    emit({ x, y, z, life: 0.12, s0: 1.2, s1: 2.4, color: [1, 0.8, 0.45, 1], shape: SHAPE.soft, add: true });
    const n = big ? 34 : zone === 'holed' ? 20 : 14;
    const cloth = zone === 'rig';
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, e = r() * 0.9 + 0.2, sp = 4 + r() * (big ? 12 : 8);
      const isCloth = cloth && i % 2 === 0;
      emit({ x, y, z, vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp, vz: Math.sin(a) * Math.cos(e) * sp, life: 1.4 + r() * 1.2, s0: isCloth ? 0.25 : 0.1 + r() * 0.12, s1: isCloth ? 0.25 : 0.08, color: isCloth ? [0.85, 0.8, 0.7, 1] : [0.42 + r() * 0.15, 0.28, 0.15, 1], shape: SHAPE.disc, grav: isCloth ? 2.5 : R.G, drag: isCloth ? 1.5 : 0.1, splash: true });
    }
    for (let i = 0; i < 3; i++) emit({ x, y, z, vx: (r() - 0.5) * 2, vy: 0.8 + r(), vz: (r() - 0.5) * 2, life: 3 + r() * 2, s0: 0.8, s1: 4, color: [0.55, 0.5, 0.45, 0.5], shape: SHAPE.smoke, drag: 0.5, wind: 0.6 });
    if (fire || shot === 'heated') for (let i = 0; i < 10; i++) emit({ x, y, z, vx: (r() - 0.5) * 5, vy: 2 + r() * 5, vz: (r() - 0.5) * 5, life: 1 + r(), s0: 0.12, s1: 0.04, color: [1, 0.55, 0.15, 1], shape: SHAPE.soft, add: true, grav: 3 });
  }

  // ------------------------------------------------------------------ own deck
  function prepareDeck(town) {
    if (S.deckTown === town && S.deck) return S.deck;
    S.deckTown = town;
    const slot = deckSlot(town);
    const type = S.own?.type ?? (slot === '31/1' ? 'small' : slot === '31/2' ? 'large' : null);
    try {
      S.deck = analyseDeck(town, { bowYaw: BOW_BY_TYPE[type] ?? null });
      S.deck.type = type ?? 'large';
    } catch (err) { console.error('[sailing] deck analysis failed:', err); S.deck = null; }
    return S.deck;
  }
  /** Hide the deck's sea-level tiles and its static sail cloth while the sea is drawn; undo on leaving. */
  function applyDeck(renderer, on) {
    const town = S.deckTown;
    const key = on && town ? `${renderer.contextVersion}` : null;
    if (S.applied?.key === key && S.applied?.town === town) return;
    const gl = renderer.gl, g = S.applied?.town ? renderer.gpu?.get(S.applied.town) : null;
    // Undo the previous application.
    if (S.applied?.town && g && !renderer.lost && S.applied.version === renderer.contextVersion) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
      for (const [t, n] of S.applied.runs) gl.bufferSubData(gl.ARRAY_BUFFER, t * 36, S.applied.town.positions.subarray(t * 9, (t + n) * 9));
    }
    if (renderer.town === S.applied?.town) renderer.primaryVertexLimit = null;
    S.applied = null;
    if (!on || !town || !S.deck) return;
    const mesh = renderer.gpu?.get(town);
    if (!mesh) return;
    const runs = triangleRuns(S.deck.sailTriangles);
    const flat = stripTriangles(town.positions, S.deck.sailTriangles, S.deck.triangles);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
    for (const [t, n] of runs) gl.bufferSubData(gl.ARRAY_BUFFER, t * 36, flat.subarray(t * 9, (t + n) * 9));
    renderer.primaryVertexLimit = S.deck.triangles * 3;
    S.applied = { key, town, runs, version: renderer.contextVersion };
  }

  // ------------------------------------------------------------------ other hulls (the installed deck models)
  function hullFor(type) {
    const t = type === 'large' ? 'large' : 'small';
    if (S.hulls.has(t)) return S.hulls.get(t);
    if (S.loading.has(t)) return null;
    // The own deck is already built: reuse it for its own type.
    const own = S.deckTown && S.deck?.type === t ? S.deckTown : null;
    const job = own ? Promise.resolve(own) : (async () => {
      if (!api.files?.length) throw new Error('no game files');
      const mod = await import('../../world/town.js');
      return mod.loadTown(api.files, { region: 31, location: SHIP_SLOTS[t], flatColliders: false });
    })();
    S.loading.set(t, job);
    job.then((town) => {
      const a = analyseDeck(town, { bowYaw: BOW_BY_TYPE[t] });
      const keep = modelTriangles(town);
      const mesh = {
        positions: stripTriangles(town.positions, a.sailTriangles, keep),
        colors: town.colors?.length >= keep * 9 ? town.colors.slice(0, keep * 9) : town.colors,
        uv: town.uv?.slice ? town.uv.slice(0, keep * 6) : town.uv,
        atlas: town.atlas, uvConvention: town.uvConvention, frontFace: town.frontFace, name: `sailing hull ${t}`,
      };
      S.hulls.set(t, { analysis: a, mesh });
      try { api.renderer?.retain?.(mesh); } catch (err) { console.error('[sailing] hull upload failed:', err); }
    }).catch((err) => { console.warn(`[sailing] ${t} hull model unavailable:`, err?.message ?? err); S.hulls.set(t, { analysis: null, mesh: null }); });
    return null;
  }
  const classHull = (cls) => (cls === 'large' || cls === 'galley' ? 'large' : 'small');
  const classScale = (cls) => (cls === 'boat' ? 0.55 : cls === 'galley' ? 0.78 : 1);

  // ------------------------------------------------------------------ coast
  function setCoast(rings) {
    const list = R.readCoast(rings);
    const key = JSON.stringify(list.map((c) => [c.id, c.ring.length, c.ring[0], c.clipped]));
    if (key === S.coastKey) return;
    S.coastKey = key;
    // A harbour's `shore` hint (coast.shoreNear) shapes the land about it: rock stands as cliffs, sand and marsh lie low.
    const hints = Array.isArray(rings?.ports) ? rings.ports.filter((p) => Number.isFinite(p?.x) && typeof p.shore === 'string') : [];
    for (const c of list) {
      if (Number.isFinite(c.height)) continue;
      const near = hints.find((p) => c.ring.some((q) => Math.hypot(q[0] - p.x, q[1] - p.z) < 1500));
      if (near) c.height = { rock: 30, grass: 14, sand: 6, marsh: 3 }[near.shore] ?? null;
    }
    S.coast = list;
    S.land = list.length ? buildLand(list) : null;
  }

  // ------------------------------------------------------------------ per-frame state (before render)
  function update(camera, now, dt) {
    const f = api.frame;
    const town = api.town ?? f?.town ?? null;
    const renderer = api.renderer ?? f?.renderer ?? null;
    // Aboard (the core says so) and standing on a classic deck scene: the deck is the ship.
    const onDeck = !!(town && renderer && town.spawn?.deck && !town.kind && S.own && S.role !== 'none');
    if (renderer && !onDeck && S.active) {
      applyDeck(renderer, false);
      renderer.skyFrame = null;
      S.active = false;
    }
    if (!onDeck || !renderer) { S.frame = null; return; }
    if (!prepareDeck(town)) { S.frame = null; return; }
    applyDeck(renderer, true);
    S.active = true;
    const t = localNow();
    const pose = S.ownTrack.sample(t, dt) ?? { x: S.own.x, z: S.own.z, yaw: S.own.yaw };
    const wind = S.wind ?? { from: 0, speed: 5 };
    const waveTime = Date.now() / 1000;
    const waves = R.waveSet({ toward: wind.from + Math.PI, windSpeed: wind.speed, origin: [pose.x, pose.z], time: waveTime });
    const deck = S.deck, hull = deck.hull;
    const motion = R.shipMotion(waves, { x: 0, z: 0, yaw: pose.yaw, length: hull.length, beam: hull.beam, sail: S.own.anchored ? 0 : S.own.sail, cls: deck.type, heel: S.own.heel, pitch: S.own.pitch }, wind);
    const sink = R.sinkPose(S.own.state, S.own.state === 'sinking' ? (S.ownSinkSince ??= t, t - S.ownSinkSince) : (S.ownSinkSince = null, 0));
    const ownPose = { yaw: pose.yaw, pitch: motion.pitch + sink.pitch, heel: motion.heel + sink.heel, heave: motion.heave - sink.drop + (S.own.grounded ? 0.6 : 0) };
    const relToDeck = R.relToDeck(hull, ownPose);
    const deckToRel = R.invRigid(relToDeck);
    renderer.skyFrame = R.f32(R.relToDeckRotation(hull, ownPose));
    S.frame = { t, dt, chart: pose, ownPose, relToDeck, deckToRel, waves, wind, seaState: R.seaState(wind.speed), waveTime };
    // Wakes and life.
    stepWakes(t);
    stepParticles(dt);
    stepFlecks(pose);
    stepEmitters(t, dt);
    for (const [id, c] of S.contacts) if (t - c.seen > CONTACT_TTL) { S.contacts.delete(id); S.wakes.delete(id); S.avatars.delete(id); }
    stepLand(pose);
  }

  /**
   * The shore around the ship from the operator's WOODS.WLD (renderCoast.woodsLandSampler), read a few pixels at a
   * time as she sails; a sampler set by the geo owner (setLandSampler) takes its place.
   */
  function stepLand(pose) {
    if (!S.landSampler && !S.woods && api.files?.length && opts.woods !== false) {
      S.woods = woodsLandSampler(api.files).then((w) => { S.landSampler = w; }).catch((err) => console.warn('[sailing] shore sampler unavailable:', err?.message ?? err));
    }
    const ls = S.landSampler;
    if (!ls) return;
    const fn = typeof ls === 'function' ? ls : (x, z) => ls.heightAt(x, z);
    if (ls.ensure && (!S.landAsk || Math.hypot(pose.x - S.landAsk.x, pose.z - S.landAsk.z) > 400) && !S.landBusy) {
      S.landAsk = { x: pose.x, z: pose.z };
      S.landBusy = true;
      ls.ensure(pose.x, pose.z, 3300).catch((err) => console.warn('[sailing] shore read failed:', err?.message ?? err)).finally(() => { S.landBusy = false; });
    }
    const version = ls.version ?? 0;
    if (!S.patch || S.patch.version !== version || Math.hypot(pose.x - S.patch.cx, pose.z - S.patch.cz) > 500) {
      try {
        S.patch = landPatch(fn, Math.round(pose.x / 100) * 100, Math.round(pose.z / 100) * 100, { size: 6000, cells: 72 });
        S.patch.version = version;
      } catch (err) { console.error('[sailing] land patch failed:', err); S.landSampler = null; }
    }
  }

  function vesselPoseRel(view, chart, cls) {
    const f = S.frame;
    const dx = chart.x - f.chart.x, dz = chart.z - f.chart.z;
    const h = S.hulls.get(classHull(cls))?.analysis?.hull ?? R.hullFrame(null, { bowYaw: 0 });
    const k = classScale(cls);
    const m = R.shipMotion(f.waves, { x: dx, z: dz, yaw: chart.yaw, length: h.length * k, beam: h.beam * k, sail: view.anchored ? 0 : view.sail, cls, heel: view.heel, pitch: view.pitch }, f.wind);
    const fade = 1 - clamp((Math.hypot(dx, dz) - 230) / 500, 0, 1); // the sea shader flattens far swell
    const c = S.contacts.get(view.id);
    const sink = R.sinkPose(view.state, c?.sinkSince != null ? f.t - c.sinkSince : 0);
    return { dx, dz, yaw: chart.yaw, pitch: m.pitch * fade + sink.pitch, heel: m.heel * fade + sink.heel, heave: m.heave * fade - sink.drop, scale: k, hull: h };
  }
  /** Contact deck frame -> own deck frame (float64). */
  function contactMatrix(p) {
    return R.chain(S.frame.relToDeck, R.shipToRel(p.dx, p.dz, p), R.sc(p.scale), p.hull.deckToShip);
  }

  function stepWakes(t) {
    const track = (id, chart, speed, beam) => {
      const w = S.wakes.get(id) ?? [];
      const last = w[w.length - 1];
      if (Math.abs(speed) > 0.4 && (!last || t - last.t > 0.35)) w.push({ x: chart.x, z: chart.z, yaw: chart.yaw, t, speed: Math.abs(speed), beam });
      while (w.length && t - w[0].t > WAKE_LIFE) w.shift();
      S.wakes.set(id, w);
    };
    track('own', S.frame.chart, S.own.anchored ? 0 : S.own.speed, S.deck.hull.beam * 0.8);
    for (const c of S.contacts.values()) {
      const p = c.track.sample(t, 0) ?? c.view;
      if (c.view.state === 'wrecked') continue;
      track(c.id, p, c.view.anchored ? 0 : c.view.speed, 9 * classScale(c.view.cls));
    }
  }
  function stepParticles(dt) {
    const w = S.frame.wind, tw = R.headingVec(w.from + Math.PI);
    const ps = S.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) { ps.splice(i, 1); continue; }
      if (p.flat) continue;
      if (p.wind) { p.vx += (tw[0] * w.speed * p.wind - p.vx) * dt * 0.4; p.vz += (tw[1] * w.speed * p.wind - p.vz) * dt * 0.4; }
      p.vy -= p.grav * dt;
      if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= p.grav ? 1 : k; p.vz *= k; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.grav && p.y < 0) {
        if (p.splash) emit({ x: p.x, y: 0.05, z: p.z, life: 1.2, s0: 0.2, s1: 0.9, color: [0.9, 0.94, 0.96, 0.6], shape: SHAPE.ring, flat: true, onSea: true });
        ps.splice(i, 1);
      }
    }
  }
  function stepFlecks(chart) {
    const r = rnd(hash(Math.floor(S.frame.t * 10)));
    while (S.flecks.length < 150) S.flecks.push({ x: chart.x + (r() - 0.5) * 360, z: chart.z + (r() - 0.5) * 360, s: 0.4 + r() * 1.2, a: 0.15 + r() * 0.3 });
    const ahead = R.headingVec(chart.yaw);
    for (const f of S.flecks) {
      const dx = f.x - chart.x, dz = f.z - chart.z;
      if (Math.hypot(dx, dz) > 190) {
        // Respawn ahead of the bow (so a moving ship streams through them) or around her at rest.
        const a = r() * Math.PI * 2, d = 40 + r() * 140;
        const moving = Math.abs(S.own.speed) > 0.5 && !S.own.anchored;
        f.x = chart.x + (moving ? ahead[0] * 150 : 0) + Math.cos(a) * d * (moving ? 0.6 : 1);
        f.z = chart.z + (moving ? ahead[1] * 150 : 0) + Math.sin(a) * d * (moving ? 0.6 : 1);
      }
    }
  }
  /** Continuous emitters: fire smoke and embers, spray at the bow, bubbles round a sinking hull, shot trails. */
  function stepEmitters(t, dt) {
    const f = S.frame;
    const rate = (key, perSecond) => {
      const acc = (S.emitAcc.get(key) ?? 0) + perSecond * dt;
      const n = Math.floor(acc);
      S.emitAcc.set(key, acc - n);
      return n;
    };
    const r = rnd(hash(`${t}`));
    const ships = [{ id: 'own', view: S.own, toChart: (p) => { const q = R.apply(f.deckToRel, ...p); return [q[0] + f.chart.x, q[1], q[2] + f.chart.z]; }, hull: S.deck.hull, deckY: S.deck.deckY }];
    for (const c of S.contacts.values()) {
      const chart = c.track.sample(t, 0) ?? c.view;
      if (Math.hypot(chart.x - f.chart.x, chart.z - f.chart.z) > 1500) continue;
      const h = S.hulls.get(classHull(c.view.cls))?.analysis;
      if (!h) continue;
      const pose = vesselPoseRel(c.view, chart, c.view.cls);
      const m = R.chain(R.shipToRel(pose.dx, pose.dz, pose), R.sc(pose.scale), h.hull.deckToShip);
      ships.push({ id: c.id, view: c.view, toChart: (p) => { const q = R.apply(m, ...p); return [q[0] + f.chart.x, q[1], q[2] + f.chart.z]; }, hull: h.hull, deckY: h.deckY, chart });
    }
    for (const s of ships) {
      const v = s.view;
      if (v.fire > 0 && v.state !== 'wrecked') {
        for (let i = rate(`smoke:${s.id}`, v.fire * 4); i > 0; i--) {
          const p = firePoint(s, r() * v.fire);
          const c = s.toChart(p);
          emit({ x: c[0], y: c[1] + 1, z: c[2], vx: 0, vy: 2.5 + r() * 2, vz: 0, life: 6 + r() * 4, s0: 1.2, s1: 7 + v.fire * 2, color: [0.16, 0.14, 0.13, 0.55], shape: SHAPE.smoke, drag: 0.3, wind: 0.8 });
        }
        for (let i = rate(`ember:${s.id}`, v.fire * 6); i > 0; i--) {
          const c = s.toChart(firePoint(s, r() * v.fire));
          emit({ x: c[0], y: c[1] + 0.5, z: c[2], vx: (r() - 0.5) * 2, vy: 2 + r() * 4, vz: (r() - 0.5) * 2, life: 1 + r(), s0: 0.1, s1: 0.03, color: [1, 0.6, 0.2, 1], shape: SHAPE.soft, add: true, wind: 0.5 });
        }
      }
      if (v.state === 'sinking') {
        for (let i = rate(`bubble:${s.id}`, 10); i > 0; i--) {
          const a = r() * Math.PI * 2, d = r() * s.hull.length * 0.45;
          const c = s.toChart([Math.cos(a) * d * 0.4, s.deckY, Math.sin(a) * d]);
          emit({ x: c[0], y: 0.05, z: c[2], life: 1.6 + r(), s0: 0.4, s1: 2.2, color: [0.9, 0.95, 0.96, 0.55], shape: SHAPE.ring, flat: true, onSea: true });
        }
      }
      const speed = Math.abs(v.anchored ? 0 : v.speed);
      if (speed > 2.5 && v.state !== 'wrecked') {
        for (let i = rate(`spray:${s.id}`, (speed - 2) * 3 * f.seaState); i > 0; i--) {
          const side = r() < 0.5 ? -1 : 1;
          const bow = s.hull.length * 0.47;
          // Ship-frame bow point -> its deck frame -> chart.
          const pd = R.apply(s.hull.shipToDeck, side * s.hull.beam * 0.2, 0.3, -bow);
          const c = s.toChart(pd);
          const out = R.applyDir(s.hull.shipToDeck, side, 0, 0);
          const cr = R.headingVec((s.chart ?? f.chart).yaw);
          emit({ x: c[0], y: 0.4, z: c[2], vx: cr[0] * speed * 0.5 + out[0] * 2, vy: 2 + r() * 3, vz: cr[1] * speed * 0.5 + out[2] * 2, life: 0.9 + r() * 0.5, s0: 0.4, s1: 1.4, color: [0.92, 0.95, 0.97, 0.55], shape: SHAPE.soft, grav: R.G });
        }
      }
    }
    const now = serverNow();
    for (const b of S.balls.values()) {
      const tb = now ?? b.t0;
      if (!b.flashed && tb >= b.t0) {
        b.flashed = true;
        if (b.floating) impact([b.p0[0], 0, b.p0[2]], 'water');
        else muzzle(b);
      }
      if (tb > b.end || tb < b.t0) continue;
      if (b.floating) continue;
      for (let i = rate(`trail:${b.id}`, b.shot === 'heated' ? 30 : 14); i > 0; i--) {
        const p = ballPos(b, tb);
        emit({ x: p[0], y: p[1], z: p[2], vx: 0, vy: 0.2, vz: 0, life: 1.2, s0: 0.25, s1: 1.1, color: b.shot === 'heated' ? [0.4, 0.3, 0.25, 0.4] : [0.8, 0.8, 0.78, 0.25], shape: SHAPE.smoke, drag: 1 });
      }
    }
    // Balls that reached the sea without a hit report end in a splash (the server's own end of flight).
    if (now !== null) for (const [id, b] of S.balls) {
      if (now <= b.end) continue;
      S.balls.delete(id);
      if (b.floating) continue;
      const p = R.ballAt(b, b.end, b.g);
      if (p[1] < 3) impact([p[0], 0, p[2]], 'water');
    }
  }
  function firePoint(s, k) {
    const r = rnd(Math.floor(k * 7) + hash(s.id));
    const a = (r() - 0.5) * s.hull.length * 0.7;
    return R.apply(s.hull.shipToDeck, (r() - 0.5) * s.hull.beam * 0.5, s.deckY - s.hull.pivot[1] + 0.2, a);
  }

  // ------------------------------------------------------------------ drawing
  function chartToDeck(x, y, z) {
    const f = S.frame;
    return R.apply(f.relToDeck, x - f.chart.x, y, z - f.chart.z);
  }
  function seaY(x, z) {
    const f = S.frame;
    return R.waveHeight(f.waves, x - f.chart.x, z - f.chart.z);
  }

  /** Sail cloth on a yard: corners A,B (yard) C,D (foot) in a ship's deck frame, drawn through matrix m. */
  function drawSail(m, sail, view, id, windRel, windLocal) {
    const level = clamp(view.sail ?? 1, 0, 1);
    const [A0, B0, C0, D0] = sail.corners;
    // Brace the yard about the mast toward the wind (radians, about deck +y).
    const brace = clamp(-Math.sin(windRel) * 0.45, -0.45, 0.45) * (level > 0 ? 1 : 0.3);
    const mx = sail.mast.x, mz = sail.mast.z, cb = Math.cos(brace), sb = Math.sin(brace);
    const turn = (p) => [mx + (p[0] - mx) * cb + (p[2] - mz) * sb, p[1], mz - (p[0] - mx) * sb + (p[2] - mz) * cb];
    const A = turn(A0), B = turn(B0), C = turn(C0), D = turn(D0);
    const pal = view.state === 'struck' ? [[0.85, 0.83, 0.78], [0.85, 0.83, 0.78]] : FACTION_SAIL[view.faction] ?? FACTION_SAIL.player;
    const scorch = clamp(view.fire / 3, 0, 1);
    const health = view.sailHealth ?? 1;
    const fill = level > 0 ? clamp(0.35 + S.frame.wind.speed / 10, 0.35, 1.1) : 0;
    const inIrons = Math.cos(windRel) > 0.8; // wind from ahead: the cloth luffs
    const flutter = inIrons ? Math.sin(S.frame.t * 11 + hash(id) % 7) * 0.4 : 0;
    // Billow toward leeward: the side the wind blows to.
    const across = norm(cross(sub(B, A), sub(D, A)));
    const lee = Math.sign(dot(across, windLocal)) || 1;
    const depth = Math.hypot(...sub(B, A)) * 0.11 * fill * (inIrons ? 0.25 : 1);
    const NU = 8, NV = 6;
    const vMax = 0.06 + 0.94 * level;
    const P = [];
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
      const u = i / NU, v = (j / NV) * vMax;
      const top = lerp3(A, B, u), bot = lerp3(D, C, u);
      let p = lerp3(top, bot, v);
      const bulge = Math.sin(Math.PI * u) * Math.sin(Math.PI * Math.min(1, v / Math.max(vMax, 0.01))) * (depth + flutter * 0.4 * Math.sin(u * 9 + S.frame.t * 13));
      p = add(p, scale(across, bulge * lee));
      P.push(R.apply(m, ...p));
    }
    const rr = rnd(hash(id) ^ 0x5a5a);
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const torn = rr() < (1 - health) * 0.6;
      if (torn) continue;
      let col = pal[0];
      if (view.faction === 'merchant' && i % 3 === 1) col = pal[1];
      if (view.faction === 'navy' && (i === NU / 2 || j === Math.floor(NV / 2))) col = pal[1];
      if (view.faction === 'pirate' && j === NV - 1) col = pal[1];
      if (view.faction === 'player' && j >= NV - 1) col = pal[1];
      if (scorch) col = lerp3(col, [0.12, 0.1, 0.08], scorch * (0.3 + 0.7 * rr()));
      const k = j * (NU + 1) + i;
      solids.quad(P[k], P[k + 1], P[k + NU + 2], P[k + NU + 1], col);
    }
    if (level < 0.2) {
      // Furled: the cloth bundled along the yard.
      const mid = lerp3(A, B, 0.5), ax = scale(sub(B, A), 0.5);
      const c = R.apply(m, ...add(mid, [0, -0.35, 0]));
      solids.box(c, R.applyDir(m, ...ax), R.applyDir(m, 0, 0.3, 0), R.applyDir(m, ...scale(across, 0.3)), lerp3(pal[0], [0.5, 0.45, 0.4], 0.3));
    }
  }

  function drawFlag(m, top, view, id, windDirDeck) {
    const kind = view.state === 'struck' || view.state === 'prize' || view.colours === 'struck' ? 'struck' : view.colours === 'hostile' ? 'hostile' : view.faction ?? 'player';
    const pal = FLAG[kind] ?? FLAG.player;
    const own = view.faction === 'player' && view.ownerName ? hash(view.ownerName) : 0;
    const c0 = own ? [0.25 + (own & 255) / 400, 0.25 + ((own >> 8) & 255) / 400, 0.3 + ((own >> 16) & 255) / 450] : pal[0];
    // Pole above the masthead.
    const pole0 = R.apply(m, ...top), pole1 = R.apply(m, top[0], top[1] + 3, top[2]);
    const up = sub(pole1, pole0);
    solids.box(scale(add(pole0, pole1), 0.5), [0.08, 0, 0], scale(up, 0.5), [0, 0, 0.08], DARK_WOOD);
    // The cloth streams downwind with a travelling ripple.
    const dir = norm([windDirDeck[0], 0, windDirDeck[2]]);
    const side = norm(cross(dir, [0, 1, 0]));
    const L = 3.2, H = 1.9, N = 8;
    const ph = S.frame.t * 9 + (hash(id) % 13);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N, wave = Math.sin(u * 5 - ph) * 0.35 * u;
      const base = add(pole1, add(scale(dir, u * L), scale(side, wave)));
      pts.push([add(base, [0, -0.1, 0]), add(base, [0, -0.1 - H, 0])]);
    }
    for (let i = 0; i < N; i++) {
      const col = (kind === 'navy' || kind === 'pirate' || kind === 'merchant') && i >= N / 2 - 1 && i <= N / 2 ? pal[1] : i === 0 ? pal[1] : c0;
      solids.quad(pts[i][0], pts[i + 1][0], pts[i + 1][1], pts[i][1], col);
    }
  }

  function drawRig(m, analysis, view, id, chartYaw) {
    const f = S.frame;
    // Apparent wind in the ship frame: true wind toward minus the ship's own way.
    const tw = R.headingVec(f.wind.from + Math.PI), hv = R.headingVec(chartYaw);
    const sp = view.anchored ? 0 : view.speed ?? 0;
    const ax = tw[0] * f.wind.speed - hv[0] * sp, az = tw[1] * f.wind.speed - hv[1] * sp;
    const windToYaw = Math.atan2(ax, -az);
    const windRel = R.wrapPi(windToYaw + Math.PI - chartYaw); // where the apparent wind comes FROM, relative to the bow
    // Direction the wind blows toward in the drawn (own deck) frame.
    const windDeck = R.applyDir(f.relToDeck, ax, 0, az);
    const windLocal = R.applyDir(R.invRigid(m), ...windDeck);
    for (const s of analysis.sails) drawSail(m, s, view, `${id}:${s.mast.x.toFixed(1)}`, windRel, windLocal);
    const mast = analysis.masts[0];
    if (mast) drawFlag(m, [mast.x, mast.top, mast.z], view, id, windDeck);
    if (!analysis.sails.length) {
      // A deck without model cloth gets a mast and a square sail of its own.
      const h = analysis.hull, base = analysis.deckY;
      const fore = R.apply(h.shipToDeck, 0, 0, -h.length * 0.12);
      const height = Math.max(12, h.length * 0.45);
      const mpos = [fore[0], base, fore[2]];
      const top = add(mpos, [0, height, 0]);
      solids.box(R.apply(m, ...add(mpos, [0, height / 2, 0])), R.applyDir(m, 0.25, 0, 0), R.applyDir(m, 0, height / 2, 0), R.applyDir(m, 0, 0, 0.25), DARK_WOOD);
      const across = R.applyDir(h.shipToDeck, 1, 0, 0);
      const w = h.beam * 0.9;
      const A = add(top, add(scale(across, -w / 2), [0, -1, 0])), B = add(top, add(scale(across, w / 2), [0, -1, 0]));
      const corners = [A, B, add(B, [0, -height * 0.65, 0]), add(A, [0, -height * 0.65, 0])];
      drawSail(m, { corners, mast: { x: mpos[0], z: mpos[2] } }, view, `${id}:gen`, windRel, windLocal);
      drawFlag(m, top, view, id, windDeck);
    }
  }

  function drawCrew(gl, renderer, m, c) {
    if (!c.crew?.length) return;
    let avs = S.avatars.get(c.id);
    if (!avs) S.avatars.set(c.id, avs = new Map());
    const w = renderer.world;
    gl.useProgram(w.p);
    gl.bindTexture(gl.TEXTURE_2D, renderer.white);
    gl.uniform1f(w.u.u_useTex, 0);
    gl.uniform1f(w.u.u_shade, 0.85);
    gl.uniform1f(w.u.u_coverage, 1);
    renderer.bindAttr(0, renderer.cube.pos, 3);
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib3f(1, 1, 1, 1);
    renderer.bindAttr(2, renderer.cube.nrm, 3);
    gl.disableVertexAttribArray(3);
    gl.vertexAttrib2f(3, 0, 0);
    const mf = m;
    for (const p of c.crew.slice(0, 24)) {
      const key = String(p.id ?? `${p.x},${p.z}`);
      let av = avs.get(key);
      if (!av) avs.set(key, av = new Avatar(key));
      av.pose(p.x, Number.isFinite(p.y) ? p.y : (S.hulls.get(classHull(c.view.cls))?.analysis?.deckY ?? 6), p.z, p.yaw ?? 0, !!p.moving, S.frame.dt, S.frame.t);
      for (const part of av.parts) {
        gl.uniformMatrix4fv(w.u.u_model, false, R.f32(R.mul(mf, part.model)));
        gl.uniform3fv(w.u.u_tint, part.color);
        gl.drawArrays(gl.TRIANGLES, 0, renderer.cube.count);
      }
    }
  }

  function opaquePass(gl, renderer) {
    const f = S.frame;
    if (!f || !S.active) return;
    const stats = { contacts: 0, hulls: 0, balls: 0, particles: 0, ports: 0, land: 0 };
    renderer.__sailFog = PALETTE.horizon;
    const light = clamp(lum(PALETTE.horizon) * 1.45, 0.12, 1);
    f.light = light;
    const eyeRel = R.apply(f.deckToRel, ...renderer.eye);
    const masks = [];
    const own = S.deck.hull;
    masks.push({ relToShip: R.f32(R.invRigid(R.shipToRel(0, 0, f.ownPose))), halfBeam: own.beam * 0.42, halfLength: own.length * 0.5 });
    // Contacts in range, nearest first.
    const list = [];
    for (const c of S.contacts.values()) {
      const chart = c.track.sample(f.t, f.dt);
      if (!chart) continue;
      const d = Math.hypot(chart.x - f.chart.x, chart.z - f.chart.z);
      if (d > DRAW_RANGE) continue;
      list.push({ c, chart, d });
    }
    list.sort((a, b) => a.d - b.d);
    for (const it of list) {
      it.pose = vesselPoseRel(it.c.view, it.chart, it.c.view.cls);
      if (masks.length < 4 && it.c.view.state !== 'wrecked') masks.push({ relToShip: R.f32(R.invRigid(R.mul(R.shipToRel(it.pose.dx, it.pose.dz, it.pose), R.sc(it.pose.scale)))), halfBeam: it.pose.hull.beam * 0.42, halfLength: it.pose.hull.length * 0.5 });
    }
    gl.enable(gl.DEPTH_TEST);
    sea.draw(gl, renderer, {
      relToDeck: R.f32(f.relToDeck), center: [Math.round(eyeRel[0] / 2) * 2, Math.round(eyeRel[2] / 2) * 2], eyeRel,
      sunRel: norm(R.applyDir(f.deckToRel, ...renderer.sunDir)), waves: f.waves, seaState: f.seaState, masks,
      fogColor: PALETTE.horizon, skyColor: PALETTE.zenith, light,
    });
    solids.clear();
    // The own rig: model cloth replaced by a sail that fills, braces, furls and tears.
    drawRig(R.m4(), S.deck, { ...S.own, faction: 'player' }, S.own.id, f.chart.yaw);
    // Other hulls.
    const w = renderer.world;
    for (const it of list) {
      const { c, pose } = it;
      const hullRec = hullFor(classHull(c.view.cls));
      const m = contactMatrix(pose);
      stats.contacts++;
      if (hullRec?.mesh) {
        const g = renderer.upload(hullRec.mesh);
        gl.useProgram(w.p);
        gl.uniformMatrix4fv(w.u.u_vp, false, renderer.viewProj);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform3f(w.u.u_tint, ...(c.view.state === 'wrecked' ? [0.45, 0.4, 0.38] : c.view.fire > 1 ? [0.75, 0.68, 0.62] : [1, 1, 1]));
        gl.uniform1f(w.u.u_shade, 0.55);
        gl.uniform1f(w.u.u_coverage, 1);
        gl.uniform2fv(w.u.u_fog, renderer.fogRange);
        renderer.drawMesh(g, null, R.f32(m));
        stats.hulls++;
        if (c.view.state !== 'wrecked') drawRig(m, hullRec.analysis, c.view, c.id, it.chart.yaw);
        drawCrew(gl, renderer, m, c);
      } else if (hullRec === undefined || hullRec?.mesh === null) {
        // No model (no game files yet): a plain hull so the contact is still a ship on the sea.
        const h = pose.hull;
        solids.box(R.apply(m, 0, 2, 0), R.applyDir(m, h.beam * 0.4, 0, 0), R.applyDir(m, 0, 2.2, 0), R.applyDir(m, 0, 0, h.length * 0.45), DARK_WOOD);
      }
      if (c.view.state === 'wrecked') drawWreckage(c, it.chart);
    }
    // Harbours and shores.
    for (const p of S.ports) {
      const d = Math.hypot(p.x - f.chart.x, p.z - f.chart.z);
      if (d > DRAW_RANGE + 400 || !p.charted) continue;
      stats.ports++;
      buildHarbour(solids, fx, p, chartToDeck, { t: f.t, light, d, axes: null, own: f.chart });
    }
    if (S.land) stats.land += S.land.draw(solids, chartToDeck, f.chart, DRAW_RANGE + 1500);
    // Server shore rings are exact; the WOODS patch stands in only where none were sent.
    if (S.patch && !S.land?.pieces?.length) stats.land += S.patch.draw(solids, chartToDeck);
    // Casks afloat (admiralty): barrels riding the swell.
    for (const c of S.marks?.casks ?? []) {
      if (Math.hypot(c.x - f.chart.x, c.z - f.chart.z) > 1500) continue;
      const y = seaY(c.x, c.z) + 0.2, k = hash(c.id) % 628 / 100;
      const p = chartToDeck(c.x, y, c.z);
      const ax = R.applyDir(f.relToDeck, Math.cos(k + f.t * 0.2) * 0.45, Math.sin(f.t * 1.3 + k) * 0.08, Math.sin(k + f.t * 0.2) * 0.45);
      solids.box(p, ax, R.applyDir(f.relToDeck, 0, 0.32, 0), R.applyDir(f.relToDeck, -Math.sin(k) * 0.32, 0, Math.cos(k) * 0.32), c.kind === 'wreck' ? [0.4, 0.3, 0.2] : [0.5, 0.36, 0.2]);
      solids.box(p, scale(ax, 1.04), R.applyDir(f.relToDeck, 0, 0.05, 0), R.applyDir(f.relToDeck, -Math.sin(k) * 0.34, 0, Math.cos(k) * 0.34), [0.25, 0.25, 0.27]);
    }
    // Shot in flight (solid iron; heated shot glows in the fx pass).
    const now = serverNow();
    for (const b of S.balls.values()) {
      const tb = now ?? b.t0;
      if (tb < b.t0 || tb > b.end) continue;
      const p = ballPos(b, tb);
      const d = chartToDeck(...p);
      const dist = Math.hypot(d[0] - renderer.eye[0], d[1] - renderer.eye[1], d[2] - renderer.eye[2]);
      const r = Math.max(0.13, dist * 0.0022);
      const col = b.shot === 'heated' ? [0.9, 0.35, 0.1] : b.gun === 'barrel' ? WOOD : [0.08, 0.08, 0.09];
      if (b.shot === 'chain') {
        const v = norm(b.v0), sideV = norm(cross(v, [0, 1, 0])), spin = (tb - b.t0) * 12;
        const off = add(scale(sideV, Math.cos(spin) * 0.9), [0, Math.sin(spin) * 0.9, 0]);
        const a = chartToDeck(...add(p, off)), c2 = chartToDeck(...sub(p, off));
        solids.box(a, [r, 0, 0], [0, r, 0], [0, 0, r], col);
        solids.box(c2, [r, 0, 0], [0, r, 0], [0, 0, r], col);
        solids.box(scale(add(a, c2), 0.5), scale(sub(a, c2), 0.5), [0, 0.03, 0], [0.03, 0, 0], [0.25, 0.25, 0.27]);
      } else if (b.shot === 'grape') {
        const rr = rnd(hash(b.id));
        const open = Math.min(1, (tb - b.t0) / 1.2) * 0.9;
        for (let i = 0; i < 5; i++) solids.box(add(d, [(rr() - 0.5) * open, (rr() - 0.5) * open, (rr() - 0.5) * open]), [r * 0.6, 0, 0], [0, r * 0.6, 0], [0, 0, r * 0.6], col);
      } else {
        const k = b.gun === 'barrel' ? 2.5 : 1;
        solids.box(d, [r * k, 0, 0], [0, r * k, 0], [0, 0, r * k], col);
      }
      stats.balls++;
    }
    solids.draw(gl, renderer);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    stats.solids = solids.n;
    S.stats = stats;
  }

  function drawWreckage(c, chart) {
    const r = rnd(hash(c.id));
    for (let i = 0; i < 14; i++) {
      const a = r() * Math.PI * 2, d = 3 + r() * 18;
      const x = chart.x + Math.cos(a) * d + Math.sin(S.frame.t * 0.05 + i) * 1.5, z = chart.z + Math.sin(a) * d;
      const y = seaY(x, z) + 0.1;
      const yaw = r() * Math.PI;
      const p = chartToDeck(x, y, z);
      const ax = R.applyDir(S.frame.relToDeck, Math.cos(yaw) * (1 + r() * 1.5), 0, Math.sin(yaw) * (1 + r() * 1.5));
      const az = R.applyDir(S.frame.relToDeck, -Math.sin(yaw) * 0.25, 0, Math.cos(yaw) * 0.25);
      solids.box(p, ax, R.applyDir(S.frame.relToDeck, 0, 0.12, 0), az, i % 4 === 0 ? [0.45, 0.42, 0.36] : WOOD);
    }
  }

  function fxPass(gl, renderer) {
    const f = S.frame;
    if (!f || !S.active) return;
    fx.clear();
    const axes = viewAxes(renderer.view);
    const flatAxes = (x, z, s) => {
      const ax = R.applyDir(f.relToDeck, s, 0, 0), bz = R.applyDir(f.relToDeck, 0, 0, s);
      return [ax, bz];
    };
    // Foam flecks fixed to the chart: the sea visibly streams past a ship under way.
    for (const k of S.flecks) {
      const y = seaY(k.x, k.z) + 0.04;
      const [a, b] = flatAxes(k.x, k.z, k.s);
      fx.flat(chartToDeck(k.x, y, k.z), a, b, [0.9, 0.94, 0.95, k.a], SHAPE.soft);
    }
    // Wakes: foam laid along each hull's recent track, widening and fading astern.
    for (const [id, trail] of S.wakes) {
      for (let i = 0; i < trail.length; i++) {
        const q = trail[i], age = f.t - q.t;
        const a = clamp(1 - age / WAKE_LIFE, 0, 1) * clamp(q.speed / 4, 0.15, 1) * 0.6;
        if (a < 0.02) continue;
        const width = q.beam * (0.45 + age * 0.12);
        const hv = R.headingVec(q.yaw);
        const across = R.applyDir(f.relToDeck, -hv[1] * width, 0, hv[0] * width);
        const along = R.applyDir(f.relToDeck, hv[0] * q.speed * 0.25, 0, hv[1] * q.speed * 0.25);
        const y = seaY(q.x, q.z) + 0.06;
        fx.flat(chartToDeck(q.x, y, q.z), across, along, [0.9, 0.94, 0.95, a], SHAPE.soft);
        if (i % 2 === 0) {
          // The two diverging arms of the Kelvin wake.
          for (const side of [-1, 1]) {
            const sx = q.x - hv[1] * side * width * 1.6, sz = q.z + hv[0] * side * width * 1.6;
            fx.flat(chartToDeck(sx, seaY(sx, sz) + 0.06, sz), scale(across, 0.35), scale(along, 1.4), [0.9, 0.94, 0.95, a * 0.6], SHAPE.streak);
          }
        }
      }
    }
    // Particles.
    for (const p of S.particles) {
      const k = p.age / p.life;
      const s = p.s0 + (p.s1 - p.s0) * k;
      const alpha = (p.color[3] ?? 1) * (p.add ? 1 - k : Math.min(1, (1 - k) * 1.6) * Math.min(1, p.age * 8 + 0.3));
      const color = p.add ? [p.color[0] * (1 - k * 0.5), p.color[1] * (1 - k), p.color[2] * (1 - k), 1] : [p.color[0], p.color[1], p.color[2], alpha];
      const y = p.onSea ? seaY(p.x, p.z) + 0.07 : p.y;
      const pos = chartToDeck(p.x, y, p.z);
      if (p.flat) { const [a, b] = flatAxes(p.x, p.z, s); fx.flat(pos, a, b, color, p.shape, { add: p.add }); }
      else fx.billboard(pos, [s, s], color, p.shape, { add: p.add, axes });
    }
    // Fire on burning hulls and glowing shot.
    const burning = [{ s: { id: 'own', hull: S.deck.hull, deckY: S.deck.deckY }, view: S.own, m: R.m4() }];
    for (const c of S.contacts.values()) {
      if (!(c.view.fire > 0)) continue;
      const h = S.hulls.get(classHull(c.view.cls))?.analysis;
      const chart = c.track.sample(f.t, 0);
      if (!h || !chart) continue;
      burning.push({ s: { id: c.id, hull: h.hull, deckY: h.deckY }, view: c.view, m: contactMatrix(vesselPoseRel(c.view, chart, c.view.cls)) });
    }
    for (const b of burning) {
      if (!(b.view?.fire > 0) || b.view.state === 'wrecked') continue;
      const n = Math.round(b.view.fire * 4);
      for (let i = 0; i < n; i++) {
        const p = R.apply(b.m, ...firePoint(b.s, i / 4 + 0.01));
        const fl = 1.4 + Math.sin(f.t * 13 + i * 2.1) * 0.35;
        fx.billboard(add(p, [0, fl, 0]), [fl * 0.7, fl * 1.4], [1, 0.55, 0.18, (f.t * 3 + i) % 10], SHAPE.flame, { add: true, axes });
        fx.billboard(add(p, [0, 0.6, 0]), [fl * 1.3, fl * 1.3], [0.55, 0.25, 0.08, 1], SHAPE.soft, { add: true, axes });
      }
    }
    const now = serverNow();
    for (const b of S.balls.values()) {
      if (b.shot !== 'heated' && b.gun !== 'barrel') continue;
      const tb = now ?? b.t0;
      if (tb < b.t0 || tb > b.end) continue;
      fx.billboard(chartToDeck(...ballPos(b, tb)), [1.1, 1.1], [1, 0.5, 0.15, 1], SHAPE.soft, { add: true, axes });
    }
    // Lanterns of the harbours.
    for (const p of S.ports) {
      const d = Math.hypot(p.x - f.chart.x, p.z - f.chart.z);
      if (d > DRAW_RANGE + 2000) continue;
      const lamp = p.__lamp;
      if (!lamp) continue;
      const s = Math.max(1.5, d * 0.006) * (1.6 - f.light);
      fx.billboard(chartToDeck(...lamp), [s, s], [1, 0.8, 0.45, 1], SHAPE.soft, { add: true, axes });
    }
    for (const c of S.marks?.casks ?? []) {
      if (!c.haul) continue;
      const [a, b] = flatAxes(c.x, c.z, 2.2 + Math.sin(f.t * 4) * 0.3);
      fx.flat(chartToDeck(c.x, seaY(c.x, c.z) + 0.1, c.z), a, b, [0.95, 0.85, 0.4, 1], SHAPE.ring, { add: true });
      fx.billboard(chartToDeck(c.x, seaY(c.x, c.z) + 0.9, c.z), [0.6, 0.6], [1, 0.9, 0.5, 1], SHAPE.soft, { add: true, axes });
    }
    for (const site of S.marks?.sites ?? []) {
      if (site.kind !== 'salvage' || Math.hypot(site.x - f.chart.x, site.z - f.chart.z) > 2500) continue;
      const [a, b] = flatAxes(site.x, site.z, site.radius);
      fx.flat(chartToDeck(site.x, 0.15, site.z), a, b, [0.25, 0.4, 0.45, 1], SHAPE.ring, { add: true });
    }
    if (S.aim) drawAim(axes);
    fx.draw(gl, renderer, f.light);
    S.stats.particles = S.particles.length;
    S.stats.fx = fx.alpha.length + fx.add.length;
  }

  /** The laid guns: arcs from the battery to the fall of shot at the chosen range, and the zone there. */
  function drawAim(axes) {
    const f = S.frame, a = S.aim;
    const range = clamp(Number(a.range) || 300, 20, 2000);
    const side = a.side ?? 'starboard';
    const off = { starboard: Math.PI / 2, port: -Math.PI / 2, bow: 0, stern: Math.PI }[side] ?? Math.PI / 2;
    const yaw = f.chart.yaw + off;
    const dir = R.headingVec(yaw), along = R.headingVec(f.chart.yaw);
    const h = S.deck.hull;
    const T = Math.max(1.2, range / 140);
    const muzzleY = S.deck.deckY - h.pivot[1] + 0.8;
    const vy = (0.5 * R.G * T * T - muzzleY) / T;
    const guns = side === 'starboard' || side === 'port' ? [-0.3, 0, 0.3] : [0];
    const hot = a.hot !== false;
    for (const g of guns) {
      const sx = f.chart.x + along[0] * g * h.length + dir[0] * h.beam * 0.5, sz = f.chart.z + along[1] * g * h.length + dir[1] * h.beam * 0.5;
      const N = 26;
      for (let i = 0; i < N; i++) {
        const t0 = (i / N) * T, t1 = ((i + 0.55) / N) * T;
        const p0 = [sx + dir[0] * range * t0 / T, muzzleY + vy * t0 - 0.5 * R.G * t0 * t0, sz + dir[1] * range * t0 / T];
        const p1 = [sx + dir[0] * range * t1 / T, muzzleY + vy * t1 - 0.5 * R.G * t1 * t1, sz + dir[1] * range * t1 / T];
        const d0 = chartToDeck(...p0), d1 = chartToDeck(...p1);
        const mid = scale(add(d0, d1), 0.5), half = scale(sub(d1, d0), 0.5);
        const wv = norm(cross(half, sub(renderer().eye, mid)));
        fx.flat(mid, scale(wv, 0.12 + i * 0.012), half, hot ? [0.95, 0.75, 0.3, 1] : [0.5, 0.6, 0.65, 1], SHAPE.streak, { add: true });
      }
    }
    const cx = f.chart.x + dir[0] * (range + h.beam * 0.5), cz = f.chart.z + dir[1] * (range + h.beam * 0.5);
    const zr = Math.max(8, range * 0.06);
    const zA = R.applyDir(f.relToDeck, along[0] * h.length * 0.45 + dir[0] * zr * 0.2, 0, along[1] * h.length * 0.45 + dir[1] * zr * 0.2);
    const zB = R.applyDir(f.relToDeck, dir[0] * zr, 0, dir[1] * zr);
    fx.flat(chartToDeck(cx, 0.15, cz), zA, zB, hot ? [0.95, 0.6, 0.2, 1] : [0.4, 0.55, 0.6, 1], SHAPE.ring, { add: true });
    void axes;
  }
  const renderer = () => api.renderer;

  // ------------------------------------------------------------------ hooks
  function viewTransform(camera, info) {
    const now = localNow();
    const dt = clamp(now - S.last, 0, 0.25);
    S.last = now;
    try { update(camera, info?.now, dt); } catch (err) { console.error('[sailing] render update failed:', err); S.frame = null; }
    if (!S.frame || !S.helmView || !(S.helm || S.role === 'helm')) return undefined;
    // At the helm: a raised view over the helmsman's shoulder, still the deck camera (walls and depth intact).
    const back = 1.6, up = 1.5;
    return { ...camera, x: camera.x - Math.sin(camera.yaw) * back, y: camera.y + up, z: camera.z + Math.cos(camera.yaw) * back, pitch: camera.pitch - 0.08 };
  }
  api.viewTransforms = Array.isArray(api.viewTransforms) ? api.viewTransforms : [];
  api.viewTransforms.push(viewTransform);
  unsub.push(() => { const i = api.viewTransforms.indexOf(viewTransform); if (i >= 0) api.viewTransforms.splice(i, 1); });
  unsub.push(api.on('event', intake));
  unsub.push(api.on('state', (st) => {
    if (st?.sailing && typeof st.sailing === 'object') intake({ kind: 'sailing.state', ...st.sailing });
  }));
  unsub.push(api.on('scene', () => {
    if (api.renderer) applyDeck(api.renderer, false); // give the old deck back its cloth before it is cached away
    S.deck = null; S.deckTown = null;
  }));
  let removePasses = [];
  const attach = (r) => {
    if (!r || removePasses.r === r) return;
    for (const f of removePasses) f();
    removePasses = [r.addPass((gl, rr) => { try { opaquePass(gl, rr); } catch (err) { console.error('[sailing] sea pass failed:', err); } }),
      r.addTranslucentPass((gl, rr) => { try { fxPass(gl, rr); } catch (err) { console.error('[sailing] fx pass failed:', err); } })];
    removePasses.r = r;
  };
  attach(api.renderer);
  unsub.push(api.on('frame', (f) => attach(f?.renderer)));

  const controller = {
    intake,
    active: () => S.active,
    setHelmView(on) { S.helmView = !!on; },
    setAim(aim) { S.aim = aim && typeof aim === 'object' ? { ...aim } : null; },
    setCoast,
    setLandSampler(fn) { S.landSampler = typeof fn === 'function' || typeof fn?.heightAt === 'function' ? fn : null; S.patch = null; S.woods = S.woods ?? Promise.resolve(); },
    deckFrame() {
      const f = S.frame;
      if (!f || !S.deck) return null;
      return {
        bowYaw: S.deck.bowYaw, pivot: [...S.deck.hull.pivot], length: S.deck.hull.length, beam: S.deck.hull.beam, deckY: S.deck.deckY,
        pose: { ...f.chart, ...f.ownPose },
        deckToChart: (x, y, z) => { const q = R.apply(f.deckToRel, x, y, z); return [q[0] + f.chart.x, q[1], q[2] + f.chart.z]; },
        chartToDeck: (x, y, z) => chartToDeck(x, y, z),
      };
    },
    labels() {
      const r = api.renderer, f = S.frame;
      if (!r || !f) return [];
      const out = [];
      const put = (id, name, kind, x, y, z, extra) => {
        const d = chartToDeck(x, y, z);
        const p = r.project(d[0], d[1], d[2]);
        if (p) out.push({ id, name, kind, x: p.x ?? p[0], y: p.y ?? p[1], distance: Math.hypot(x - f.chart.x, z - f.chart.z), ...extra });
      };
      for (const c of S.contacts.values()) {
        const ch = c.track.sample(f.t, 0);
        if (ch) put(c.id, c.view.name ?? c.view.ownerName ?? 'Ship', 'ship', ch.x, 22, ch.z, { hostile: c.view.colours === 'hostile', state: c.view.state, faction: c.view.faction });
      }
      for (const p of S.ports) put(p.id, p.name, 'port', p.x, 30, p.z, {});
      return out;
    },
    stats: () => ({ active: S.active, ...S.stats, contacts: S.contacts.size, balls: S.balls.size, ports: S.ports.length, wind: S.wind, own: S.own && { id: S.own.id, x: S.own.x, z: S.own.z, yaw: S.own.yaw, speed: S.own.speed, sail: S.own.sail, state: S.own.state }, pose: S.frame ? { ...S.frame.chart, ...S.frame.ownPose } : null, bowYaw: S.deck?.bowYaw ?? null, masts: S.deck?.masts?.length ?? null, sails: S.deck?.sails?.length ?? null, hulls: [...S.hulls.keys()] }),
    dispose() {
      for (const f of unsub) try { f?.(); } catch { /* ignore */ }
      for (const f of removePasses) f();
      const r = api.renderer;
      if (r) { applyDeck(r, false); r.skyFrame = null; for (const h of S.hulls.values()) if (h.mesh) r.release?.(h.mesh); }
      if (api.sailingRender === controller) delete api.sailingRender;
    },
  };
  api.sailingRender = controller;
  return controller;
}

export { installSailingRenderer as install };
