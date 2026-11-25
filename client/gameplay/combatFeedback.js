// Combat feedback on the HUD layer. Every amount comes from the server's combat events (server/rpg/combat.js):
//   hit {playerId, entityId, damage, hp, maxHp, source, backstab?}, miss {playerId, entityId},
//   ineffective (private) {entityId}, monsterAttack {entityId, targetId, hit, damage, ranged?, absorbed?},
//   hurt (private) {damage, cause}, heal (private) {amount}.
// Only the viewer's own fight shows: other players' hits and misses are never drawn.
// Draws: numbers over the struck monster, a crosshair hit/kill marker, a plate for the monster you fight,
// the side a blow came from, and a drain on the health bar. The sprite flash stays in actors.js and the
// sounds in atmosphere/playlists.js. No camera shake: everything here is DOM over the canvas.

import { vitalsOf } from './api.js';

const LIFE_S = 1.2; // matches the cf-rise animation in combatFeedback.css
const MAX_ACTIVE = 16;
const ANCHOR_HEIGHT = 1.1; // metres above the monster's feet
const EYE_HEIGHT = 1.62; // client/main.js, for monsters without a published floor height
const PLATE_IDLE_S = 8; // hide the plate after this long without a blow either way
const PLATE_SLAIN_S = 2.5;
const CAUSES = { spell: 'Spell', trap: 'Trap', fall: 'Fall', drowning: 'Drowning', condition: 'Affliction' };

/** Pure: how big a number reads, 1 for a scratch up to 1.9 for a blow that takes most of a monster's health. */
export function weightOf(damage, maxHp) {
  const k = Number(maxHp) > 0 ? Math.min(1, Math.max(0, Number(damage) / Number(maxHp))) : 0.25;
  return +(1 + 0.9 * Math.sqrt(k)).toFixed(2);
}

/**
 * Pure: what to show for a game event, or null.
 * `at` is the entity ID to float over, or null for the viewer; `label` is a small caption; `from` is the
 * entity the blow came from (for the side marker); `mark` is the crosshair confirmation.
 */
export function popupFor(ev, selfId) {
  if (!ev || selfId == null) return null;
  const self = String(selfId);
  const mine = ev.playerId != null && String(ev.playerId) === self;
  const amount = Math.trunc(Number(ev.damage));
  switch (ev.kind) {
    case 'hit': {
      if (!mine || !(amount > 0)) return null;
      const kill = Number(ev.hp) <= 0;
      const cls = kill ? 'kill' : ev.backstab ? 'backstab' : ev.source === 'magic' ? 'magic' : 'hit';
      const label = kill ? 'Slain' : ev.backstab ? 'Backstab' : null;
      return { at: ev.entityId, text: String(amount), cls, label, scale: weightOf(amount, ev.maxHp), mark: kill ? 'kill' : 'hit' };
    }
    case 'miss':
      return mine ? { at: ev.entityId, text: 'Miss', cls: 'miss' } : null;
    case 'ineffective':
      return { at: ev.entityId, text: 'No effect', cls: 'noeffect' };
    case 'monsterAttack':
      if (String(ev.targetId) !== self) return null;
      if (ev.absorbed) return { at: null, text: 'Absorbed', cls: 'absorbed', from: ev.entityId };
      return ev.hit && amount > 0
        ? { at: null, text: `-${amount}`, cls: 'hurt', from: ev.entityId }
        : { at: null, text: ev.ranged ? 'Missed you' : 'Dodged', cls: 'evade', from: ev.entityId };
    case 'hurt':
      return amount > 0 ? { at: null, text: `-${amount}`, cls: 'hurt', label: CAUSES[ev.cause] ?? null } : null;
    case 'heal': {
      const n = Math.trunc(Number(ev.amount));
      return n > 0 ? { at: null, text: `+${n}`, cls: 'heal' } : null;
    }
    default:
      return null;
  }
}

/** Pure: the monster plate's next state after an event, or the same object when it does not change. */
export function plateFor(plate, ev, selfId) {
  if (!ev || selfId == null) return plate;
  const self = String(selfId);
  const mine = ev.playerId != null && String(ev.playerId) === self;
  const fighting = (ev.kind === 'hit' || ev.kind === 'miss') && mine && ev.entityId != null
    || ev.kind === 'ineffective' && ev.entityId != null
    || ev.kind === 'monsterAttack' && String(ev.targetId) === self;
  // Your own blow picks the plate; a monster biting you takes it only while no other fight holds it.
  const claims = fighting && (ev.kind !== 'monsterAttack' || !plate || plate.slain);
  if (claims && ev.entityId !== plate?.id) plate = { id: ev.entityId, hp: null, maxHp: null };
  if (!plate || ev.entityId !== plate.id) return plate;
  if (ev.kind === 'hit' && Number.isFinite(ev.hp)) {
    // A monster's own blows on another monster also carry its health; any hit on this monster keeps the bar true.
    const maxHp = Number.isFinite(ev.maxHp) ? ev.maxHp : plate.maxHp;
    const before = Number(ev.damage) > 0 ? Math.min(maxHp ?? Infinity, ev.hp + Number(ev.damage)) : null; // for the drain
    return { ...plate, hp: Math.max(0, ev.hp), maxHp, before, slain: ev.hp <= 0 };
  }
  if (ev.kind === 'death') return { ...plate, hp: 0, slain: true };
  return fighting ? { ...plate } : plate;
}

/** Pure: angle of a point relative to where the camera looks, radians, 0 ahead, positive to the right. */
export function bearingFrom(camera, x, z) {
  if (!camera || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const off = Math.atan2(x - camera.x, -(z - camera.z)) - camera.yaw; // yaw 0 looks toward -z (api.js pickTarget)
  return Math.atan2(Math.sin(off), Math.cos(off));
}

const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

export function install(api) {
  const doc = globalThis.document;
  if (!doc?.createElement) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./combatFeedback.css', import.meta.url).href;
  doc.head.append(link);
  const el = (cls, parent, tag = 'div') => { const n = doc.createElement(tag); n.className = cls; parent?.append(n); return n; };
  const layer = el('', null);
  layer.id = 'combat-numbers';
  layer.setAttribute('aria-hidden', 'true');
  const vignette = el('cf-vignette', layer);
  const mark = el('cf-mark', layer);
  const sides = [0, 1, 2, 3].map(() => el('cf-side', layer)); // reused round-robin
  let nextSide = 0;
  const plateEl = el('cf-plate', layer);
  plateEl.hidden = true;
  const plateName = el('cf-plate-name', plateEl);
  const plateBar = el('cf-plate-bar', plateEl);
  const plateGhost = el('cf-plate-ghost', plateBar);
  const plateFill = el('cf-plate-fill', plateBar);
  const plateNum = el('cf-plate-num', plateEl);
  (doc.getElementById('hud') ?? doc.body).append(layer);

  const clock = () => performance.now() / 1000;
  const restart = (node, cls) => { node.className = node.className.replace(/\s*cf-go-\S+/g, ''); void node.offsetWidth; node.classList.add(cls); };
  const entityOf = (id) => asList(api.state?.entities).find((it) => it?.id === id) ?? null;

  // ------------------------------------------------------------ floating numbers
  const active = []; // {el, x, y, z, born}; y null for the viewer's own damage
  const drop = (i) => active.splice(i, 1)[0].el.remove();

  function float(p) {
    let pos = null;
    if (p.at != null) {
      const e = entityOf(p.at);
      if (!e || !Number.isFinite(e.x) || !Number.isFinite(e.z)) return;
      const foot = Number.isFinite(e.y) ? e.y : (api.camera?.y ?? EYE_HEIGHT) - EYE_HEIGHT;
      // A small sideways jitter keeps rapid hits on one monster from stacking into a single number.
      pos = { x: e.x + (Math.random() - 0.5) * 0.35, y: foot + ANCHOR_HEIGHT, z: e.z };
    }
    if (active.length >= MAX_ACTIVE) drop(0);
    const n = el(`cf-pop cf-${p.cls}${pos ? '' : ' cf-self'}`, layer);
    n.textContent = p.text;
    if (p.label) n.dataset.label = p.label;
    if (p.scale) n.style.setProperty('--cf-scale', p.scale);
    let dx = 0;
    if (!pos) {
      // The viewer's own numbers lean toward the side the blow came from.
      const b = p.from != null ? bearingFrom(api.camera, entityOf(p.from)?.x, entityOf(p.from)?.z) : null;
      dx = b == null ? 0 : Math.sin(b) * Math.min(160, layer.clientWidth * 0.14);
      n.style.transform = `translate(calc(-50% + ${dx.toFixed(0)}px), 0)`;
    } else n.hidden = true; // placed on the next frame
    active.push({ el: n, ...(pos ?? { x: 0, y: null, z: 0 }), born: clock() });
  }

  // ------------------------------------------------------------ being hurt: vignette, side marker, health bar
  function flash(kind) {
    vignette.dataset.kind = kind;
    vignette.getAnimations?.().forEach((a) => a.cancel());
    const [from, ms] = { heal: [0.5, 600], kill: [0.9, 420] }[kind] ?? [0.75, 480];
    vignette.animate?.([{ opacity: from }, { opacity: 0 }], { duration: ms, easing: 'ease-out' });
  }
  function side(fromId) {
    const e = entityOf(fromId);
    const b = e ? bearingFrom(api.camera, e.x, e.z) : null;
    if (b == null) return;
    const s = sides[nextSide++ % sides.length];
    s.style.rotate = `${b.toFixed(3)}rad`;
    restart(s, 'cf-go-side');
  }
  let lastHealth = null;
  function healthRow() { return doc.querySelector('#hud-vitals [data-vital="health"]'); }
  function watchHealth() {
    const h = vitalsOf(api.state).health;
    if (!h) return;
    const [cur, max] = h;
    const pct = Math.max(0, Math.min(100, (cur / max) * 100));
    if (lastHealth !== null && pct !== lastHealth) {
      const row = healthRow();
      const bar = row?.querySelector('.vital-bar');
      if (bar) {
        let ghost = bar.querySelector('.cf-vital-ghost');
        if (!ghost) { ghost = el('cf-vital-ghost', null, 'span'); bar.prepend(ghost); }
        if (pct < lastHealth) {
          // The lost slice stays lit, then drains to the new level.
          ghost.style.transition = 'none';
          ghost.style.width = `calc(${lastHealth}% - 2px)`;
          void ghost.offsetWidth;
          ghost.style.transition = '';
          ghost.style.width = `calc(${pct}% - 2px)`;
          restart(row, 'cf-go-hurt');
        } else {
          ghost.style.transition = 'none';
          ghost.style.width = `calc(${pct}% - 2px)`;
          restart(row, 'cf-go-heal');
        }
      }
    }
    lastHealth = pct;
  }

  // ------------------------------------------------------------ target plate
  let plate = null, plateSeen = 0, plateShownPct = null;
  function drawPlate() {
    if (!plate) { plateEl.hidden = true; return; }
    const e = entityOf(plate.id);
    if (!e && !plate.slain) { plate = null; plateEl.hidden = true; return; }
    if (e?.kind && e.kind !== 'monster') { plate = null; plateEl.hidden = true; return; } // monsters only, never players
    const hp = plate.hp ?? (Number.isFinite(e?.hp) ? e.hp : null);
    const max = plate.maxHp ?? (Number.isFinite(e?.maxHp) ? e.maxHp : null);
    plateName.textContent = e?.name ?? plate.name ?? 'Foe';
    plate.name = plateName.textContent;
    plateEl.dataset.slain = String(!!plate.slain);
    const pct = hp != null && max > 0 ? Math.max(0, Math.min(100, (hp / max) * 100)) : null;
    plateBar.hidden = pct == null;
    plateNum.textContent = plate.slain ? 'Slain' : pct == null ? '' : `${Math.max(0, Math.round(hp))} / ${Math.round(max)}`;
    if (pct != null) {
      const before = plate.before != null && max > 0 ? Math.min(100, (plate.before / max) * 100) : null;
      if (plateShownPct == null && before != null) plateShownPct = before; // first blow: drain from the health it had
      if (plateShownPct == null || pct > plateShownPct) { plateGhost.style.transition = 'none'; plateGhost.style.width = `${pct}%`; void plateGhost.offsetWidth; plateGhost.style.transition = ''; }
      else if (pct < plateShownPct) { plateGhost.style.transition = 'none'; plateGhost.style.width = `${plateShownPct}%`; void plateGhost.offsetWidth; plateGhost.style.transition = ''; plateGhost.style.width = `${pct}%`; }
      plateFill.style.width = `${pct}%`;
      if (plateShownPct != null && pct < plateShownPct) restart(plateEl, 'cf-go-struck');
      plateShownPct = pct;
    }
    plateEl.hidden = false;
  }

  api.on('event', (ev) => {
    const prev = plate;
    plate = plateFor(plate, ev, api.selfId);
    if (plate !== prev) {
      if (plate?.id !== prev?.id) plateShownPct = null;
      plateSeen = clock();
      drawPlate();
    }
    const p = popupFor(ev, api.selfId);
    if (!p) return;
    float(p);
    if (p.mark) restart(mark, `cf-go-${p.mark}`);
    if (p.cls === 'hurt' || p.cls === 'absorbed') flash(p.cls);
    if (p.cls === 'heal' || p.cls === 'kill') flash(p.cls);
    if (p.from != null && p.cls !== 'evade') side(p.from);
    if (p.cls === 'hurt' || p.cls === 'heal') watchHealth();
  });

  api.on('frame', (f) => {
    const now = clock();
    for (let i = active.length - 1; i >= 0; i--) {
      if (now - active[i].born > LIFE_S) drop(i);
    }
    const renderer = f?.renderer ?? api.renderer;
    for (const a of active) {
      if (a.y === null) continue;
      let s = renderer?.project?.(a.x, a.y, a.z);
      if (!s && renderer?.project) {
        // Too close or behind to project (a rat at your feet): still yours, so float it near the crosshair on its side.
        const b = bearingFrom(api.camera, a.x, a.z) ?? 0;
        s = { x: layer.clientWidth * (0.5 + 0.22 * Math.sin(b)), y: layer.clientHeight * 0.62 };
      }
      if (a.el.hidden !== !s) a.el.hidden = !s;
      // A rat at your feet projects below the view: keep its number on screen.
      if (s) a.el.style.transform = `translate(${s.x.toFixed(1)}px, ${Math.min(s.y, layer.clientHeight * 0.8).toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (plate && now - plateSeen > (plate.slain ? PLATE_SLAIN_S : PLATE_IDLE_S)) { plate = null; plateEl.hidden = true; }
    watchHealth();
  });
}
