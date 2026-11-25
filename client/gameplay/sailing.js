// Sailing controls in Play: boarding and casting off at real ports, the helm (rudder, canvas, oars), anchor and making
// fast, the sea chart between real ports, crew and the helm hand-over, deck/cabin/hold, broadsides, grapple/board/
// plunder, and the shipyard, passage and admiralty entries. Server rules: server/rpg/sailing.js (sailing.state),
// server/rpg/naval.js (naval.state), docs/sailing.md. 3D art is ./sailing/render.js (separate owner).
//
// Authority: every readout comes from the latest server snapshot. The browser never moves the ship, never decides a
// battery is ready and never shows a control the snapshot does not allow. While the link is down the last snapshot
// stays on screen marked "last known" with its controls disabled; on reconnect the browser asks for `sailing.sync` and
// `naval.sync` and enables nothing until a fresh snapshot arrives.
//
// Keys (./sailing/input.js) are claimed only aboard, and never while a text field, chat or a menu has focus.

import {
  SAIL_STEPS, SAIL_LABELS, OAR_STEPS, OAR_LABELS, ROLE_LABELS, SIDES, SIDE_LABELS, SHOT_LABELS, SHOTS, GUN_LABELS, groupOf,
  readSailing, readNaval, readyIn, degrees, cardinal, knots, pointOfSail, facingSide, bearingTo, nearestPort,
  aboard, canCommand, encounterTarget, contextActions, stepOf, seaLook, canSetCourse,
} from './sailing/model.js';
import { HELM_TOGGLE, SHIP_PANEL, GUN_KEYS, helmCommand, rudderFrom } from './sailing/input.js';
import * as yard from './sailing/yard.js';
import * as passage from './sailing/passage.js';
import * as admiralty from './sailing/admiralty.js';
import { installChartPanel } from './sailing/chart.js';

export const PANEL_ID = 'sailing'; // the Property & Transport "Harbour and sailing" button opens this id
const TITLE = 'Ship & Sea';
const STEER_MIN_MS = 200; // at most 5 rudder messages a second

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const requestId = () => `sl-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
const KEY_TEXT = { KeyK: 'K', KeyU: 'U', KeyX: 'X', KeyY: 'Y', Slash: '/', Space: 'Space' };
const keyText = (code) => KEY_TEXT[code] ?? code?.replace(/^Key/, '');
const meterText = (p) => (p ? `${Math.round(p[0])}/${Math.round(p[1])}` : '—');
const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const hdg = (rad) => `${String(degrees(rad)).padStart(3, '0')}° ${cardinal(rad)}`;

function isTextEntry(t) {
  const tag = t?.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return true;
  return tag === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(t.type || 'text');
}

export function install(api) {
  const doc = globalThis.document;
  const S = {
    raw: null, // the last sailing.state event as sent (periodic ones merged over the last full port list)
    sail: null, // readSailing(raw) for the current location
    naval: null, // readNaval() of the last naval.state
    stale: false, // link lost: last known state, controls disabled
    syncing: false, // asked for sailing.sync, no snapshot since
    seenState: false,
    busy: new Map(), // action id -> timer
    held: new Set(), // rudder keys held
    latchedRudder: 0, // from the on-screen rudder buttons
    rudderSent: null,
    rudderAt: 0,
    rudderTimer: 0,
    wrecks: new Map(), // player ships seen going down (naval.news 'sinking'): id -> {id, name, until}
  };
  let panelRoot = null;
  const selfId = () => api.selfId ?? api.state?.selfId ?? null;
  const live = () => !!S.sail && !S.stale && !S.syncing;
  const helm = () => !!S.sail?.helm;
  // The camera yaw is in the deck's town frame; turned into a sea bearing it picks the battery you face.
  const lookYaw = () => seaLook(Number.isFinite(api.camera?.yaw) ? api.camera.yaw : null, S.sail?.vessel);
  const reread = () => { S.sail = S.raw ? readSailing(S.raw, { location: api.location, selfId: selfId() }) : null; };

  // ---------------------------------------------------------------- sibling panels (shipyard, passage, admiralty)
  // Each registers its own panel. The manifest may install them too, so install only when the panel is missing.

  const yardUi = api.getPanel?.(yard.PANEL_ID) ? null : yard.install(api);
  if (!api.getPanel?.(passage.PANEL_ID)) passage.install(api);
  if (!api.getPanel?.(admiralty.PANEL_ID)) admiralty.install(api);
  installChartPanel(api);
  const openYard = () => (yardUi?.open ? yardUi.open() : yard.openYard(api));
  function passageActions() {
    return (passage.passageActions(api.state) ?? []).filter((a) => a && a.label && typeof a.run === 'function')
      .map((a) => ({ id: `passage:${a.id}`, label: a.label, run: a.run }));
  }
  const WRECK_MS = 10 * 60 * 1000; // naval: the killer may haul up a sunk player ship's cargo for 10 minutes
  const wrecks = () => { const now = Date.now(); for (const [id, w] of S.wrecks) if (w.until < now) S.wrecks.delete(id); return [...S.wrecks.values()]; };
  // Casks the admiralty says can be hauled from here (admiralty.sea, re-emitted as sailing:marks).
  let casks = [];
  api.on('sailing:marks', (sea) => { casks = Array.isArray(sea?.casks) ? sea.casks.filter((c) => c && c.haul === true && c.id != null) : []; draw(); });
  const haulActions = () => (aboard(S.sail) && S.sail.spot === 'deck' ? casks.map((c) => ({ id: `haul:${c.id}`, label: c.label ? `Haul ${c.label} aboard` : 'Haul cask aboard', verb: 'admiralty.haul', args: { caskId: c.id } })) : []);
  const allActions = () => [...contextActions(S.sail, S.naval, { wrecks: wrecks() }), ...haulActions(),
    ...(S.sail && (aboard(S.sail) || S.sail.port) ? [{ id: 'log', label: 'Captain’s log', local: 'admiralty' }] : []), ...passageActions()];

  // ---------------------------------------------------------------- sending intent

  function send(id, verb, args = {}, { quiet = false, hold = true } = {}) {
    if (!live()) {
      if (!quiet) api.message(S.stale ? 'Reconnecting — the ship will answer once the link is back.' : 'Waiting for the ship’s state.', { kind: 'error' });
      return null;
    }
    if (hold && S.busy.has(id)) return null;
    if (hold) S.busy.set(id, setTimeout(() => { S.busy.delete(id); draw(); }, 5000));
    draw();
    const r = api.act(verb, { ...args, requestId: requestId() }, { quiet });
    const done = (out) => { clearTimeout(S.busy.get(id)); S.busy.delete(id); draw(); return out; };
    if (!r) return done({ ok: false, error: 'Not connected' });
    return r.then(done);
  }

  function runAction(a) {
    if (!a) return;
    if (a.local === 'panel') return api.togglePanel(PANEL_ID);
    if (a.local === 'shipyard') return openYard();
    if (a.local === 'property') return api.openPanel('property');
    if (a.local === 'admiralty') return api.openPanel(admiralty.PANEL_ID);
    if (typeof a.run === 'function') return a.run();
    return send(a.id, a.verb, a.args);
  }

  function steer(rudder, force = false) {
    clearTimeout(S.rudderTimer);
    if (!force && rudder === S.rudderSent) return;
    const wait = STEER_MIN_MS - (performance.now() - S.rudderAt);
    if (wait > 0 && !force) { S.rudderTimer = setTimeout(() => steer(rudder, true), wait); return; }
    S.rudderSent = rudder; S.rudderAt = performance.now();
    send('rudder', 'sailing.control', { rudder }, { hold: false });
  }
  const wantRudder = () => rudderFrom(S.held) || S.latchedRudder;
  const setSails = (dir) => { const x = stepOf(S.sail.vessel.sails, dir, SAIL_STEPS); if (x != null) send('sails', 'sailing.control', { sails: x }); };
  const setOars = (dir) => { const x = stepOf(S.sail.vessel.oars, dir, OAR_STEPS); if (x != null) send('oars', 'sailing.control', { oars: x }); };

  // ---------------------------------------------------------------- HUD

  const hud = { plate: null, strip: null, card: null, aim: null };
  function ensureHud() {
    if (hud.plate) return true;
    const dock = doc?.querySelector('[data-hud-slot="dock"]');
    const prompts = doc?.querySelector('[data-hud-slot="prompts"]');
    if (!dock || !prompts) return false;
    hud.plate = el('section', { class: 'sail-plate', 'aria-label': 'Ship', hidden: true });
    hud.aim = el('div', { class: 'sail-aim', role: 'status', 'aria-live': 'polite', hidden: true });
    hud.card = el('section', { class: 'sail-card', 'aria-label': 'Encounter', hidden: true });
    hud.strip = el('div', { class: 'sail-strip', role: 'toolbar', 'aria-label': 'Sailing actions', hidden: true });
    dock.prepend(hud.plate);
    prompts.append(hud.aim, hud.card, hud.strip);
    const help = doc.getElementById('hud-help-list');
    if (help && !help.querySelector('[data-sail-help]')) {
      for (const [k, d] of [
        ['K', 'Aboard: take or leave the helm'], ['U', 'Ship & Sea: chart, crew, guns'],
        ['A D / ← →', 'At the helm: rudder (hold)'], ['W S / ↑ ↓', 'At the helm: make or shorten sail'],
        ['Q E', 'At the helm: oars back / pull'], ['X / Y', 'At the helm: anchor / make fast at a berth'],
        ['/', 'On deck in a fight: load the battery you face'], ['Space', 'Captain or helm: fire the ready battery you face'],
      ]) {
        const dt = el('dt', { text: k }); dt.dataset.sailHelp = '';
        help.append(dt, el('dd', { text: d }));
      }
    }
    return true;
  }

  function bar(label, p, tone) {
    const pct = p ? Math.round((p[0] / p[1]) * 100) : 0;
    return el('div', { class: 'sail-meter', 'data-tone': tone, role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(p?.[1] ?? 1), 'aria-valuenow': String(p?.[0] ?? 0) },
      el('span', { class: 'sail-meter-name', text: label }),
      el('span', { class: 'sail-meter-bar' }, el('span', { class: 'sail-meter-fill', style: `width:${pct}%` })),
      el('span', { class: 'sail-meter-num', text: meterText(p) }));
  }

  function actButton(a, { primary = false, disabled = false } = {}) {
    const busy = S.busy.has(a.id);
    const off = disabled || busy || (!a.local && !a.run && !live());
    const b = el('button', {
      type: 'button', class: `sail-btn${primary ? ' sail-btn-primary' : ''}`, 'data-sail-action': a.id,
      'aria-disabled': String(off), 'aria-busy': busy ? 'true' : null, title: a.key ? `${a.label} (${keyText(a.key)})` : a.label,
      onclick: (e) => { e.preventDefault(); if (b.getAttribute('aria-disabled') !== 'true') runAction(a); },
    }, el('span', { text: busy ? `${a.label}…` : a.label }), a.key ? el('kbd', { text: keyText(a.key) }) : null);
    return b;
  }

  function staleNote() {
    return S.stale || S.syncing ? el('p', { class: 'sail-stale', role: 'status', text: S.stale ? 'Link lost — last known state' : 'Resynchronising…' }) : null;
  }

  function drawPlate() {
    const s = S.sail, v = s?.vessel, n = S.naval;
    hud.plate.hidden = !aboard(s);
    if (hud.plate.hidden) return;
    const rows = [];
    if (v.heading != null) rows.push(['Heading', hdg(v.heading)]);
    if (v.speed != null) rows.push(['Speed', `${knots(v.speed)} kn`]);
    if (s.wind) {
      const pos = v.heading != null ? pointOfSail(v.heading, s.wind.from) : null;
      rows.push(['Wind', `from ${cardinal(s.wind.from)}${s.wind.speed != null ? ` ${knots(s.wind.speed)} kn` : ''}${pos ? ` · ${pos}` : ''}${v.pointOfSail != null ? ` · ${Math.round(v.pointOfSail * 100)}% draw` : ''}`]);
    }
    const rig = [v.sails != null ? SAIL_LABELS[v.sails] : null, v.oars ? OAR_LABELS[v.oars] : null,
      v.rudder ? `rudder ${v.rudder < 0 ? 'port' : 'starboard'} ${Math.round(Math.abs(v.rudder) * 100)}%` : null].filter(Boolean).join(' · ');
    if (rig) rows.push(['Rig', rig]);
    const status = [v.sunk ? 'Wrecked' : null, v.grounded ? 'Aground' : null, v.docked ? `Made fast at ${s.ports.find((p) => p.id === v.docked)?.name ?? v.docked}` : null,
      !v.docked && v.anchored ? 'At anchor' : null, !v.docked && !v.anchored && !v.sunk ? 'Under way' : null].filter(Boolean).join(' · ');
    if (status) rows.push(['Status', status]);
    if (v.course) {
      const left = v.course.points.reduce((acc, q, i, a) => acc + Math.hypot(q.x - (i ? a[i - 1].x : v.x), q.z - (i ? a[i - 1].z : v.z)), 0);
      rows.push(['Course', `${v.course.name}${left ? ` · ${km(left)}` : ''}${v.course.routed ? '' : ' · plotting'}`]);
    }
    rows.push(['Helm', s.helm ? 'You' : v.helmName ?? (v.helmId ? 'Taken' : 'Unmanned')]);
    const me = n?.self; // naval's own-ship view is fresher in a fight
    const hull = me?.hull ?? v.hull;
    const kids = [
      el('header', { class: 'sail-plate-head' }, el('strong', { text: v.name }),
        el('span', { class: 'sail-dim', text: ` ${ROLE_LABELS[s.role] ?? ''}${s.spot === 'below' ? ' · below decks' : ''}` })),
      staleNote(),
      el('dl', { class: 'sail-read' }, rows.flatMap(([k, t]) => [el('dt', { text: k }), el('dd', { text: t })])),
      hull || me?.sails || me?.crew ? el('div', { class: 'sail-meters' }, hull ? bar('Hull', hull, 'hull') : null, me?.sails ? bar('Sails', me.sails, 'sails') : null, me?.crew ? bar('Crew', me.crew, 'crew') : null) : null,
    ];
    if (n && Object.keys(n.ready).length) {
      const facing = facingSide(lookYaw(), v.heading);
      const now = performance.now();
      kids.push(el('div', { class: 'sail-guns', role: 'group', 'aria-label': 'Batteries' }, SIDES.map((side) => {
        const r = readyIn(n, side, now);
        if (r == null) return null;
        const load = n.loads[groupOf(side)];
        return el('div', { class: 'sail-gun', 'data-side': side, 'data-loaded': String(r === 0), 'data-facing': String(facing === side) },
          el('span', { class: 'sail-gun-name', text: SIDE_LABELS[side] }),
          el('span', { class: 'sail-gun-state', text: r === 0 ? (load ? SHOT_LABELS[load] ?? load : 'Ready') : `${Math.ceil(r)} s` }));
      })));
      const notes = [n.safeHarbour ? 'Safe harbour' : null, n.repel ? `Boarders aboard: ${n.repel.foesLeft}/${n.repel.foesTotal}` : null, n.braced ? 'Braced' : null, me?.colours ? (me.colours === 'hostile' ? 'Hostile colours' : 'Peaceful colours') : null, me?.fire ? `Fire aboard (${me.fire})` : null].filter(Boolean).join(' · ');
      if (notes) kids.push(el('p', { class: 'sail-dim sail-small', text: notes }));
    }
    if (s.helm) kids.push(helmControls(v));
    hud.plate.replaceChildren(...kids.filter(Boolean));
  }

  function helmControls(v) {
    const dis = !live();
    const btn = (label, title, onclick, pressed = null) => el('button', {
      type: 'button', class: 'sail-btn sail-btn-small', title, 'aria-disabled': String(dis), 'aria-pressed': pressed == null ? null : String(pressed),
      onclick: (e) => { e.preventDefault(); if (!dis) onclick(); },
    }, label);
    const r = wantRudder();
    const latch = (x) => { S.latchedRudder = S.latchedRudder === x ? 0 : x; steer(wantRudder()); draw(); };
    if (v.docked) return el('p', { class: 'sail-dim sail-small', text: 'Made fast. Cast off to sail.' });
    return el('div', { class: 'sail-helm', role: 'group', 'aria-label': 'Helm' },
      el('div', { class: 'sail-helm-row' },
        btn('◀ Port', 'Rudder to port (hold A or ←)', () => latch(-1), r < 0),
        btn('Amidships', 'Centre the rudder', () => latch(0), r === 0),
        btn('Starboard ▶', 'Rudder to starboard (hold D or →)', () => latch(1), r > 0)),
      el('div', { class: 'sail-helm-row' },
        btn('Sail −', 'Shorten sail (S or ↓)', () => setSails(-1)),
        el('span', { class: 'sail-helm-val', text: v.sails != null ? SAIL_LABELS[v.sails] : '—' }),
        btn('Sail +', 'Make sail (W or ↑)', () => setSails(1))),
      el('div', { class: 'sail-helm-row' },
        btn('Oars −', 'Back the oars (Q)', () => setOars(-1)),
        el('span', { class: 'sail-helm-val', text: v.oars != null ? OAR_LABELS[v.oars] : '—' }),
        btn('Oars +', 'Pull the oars (E)', () => setOars(1))));
  }

  function drawAim() {
    const s = S.sail, n = S.naval, v = s?.vessel;
    const side = v && n ? facingSide(lookYaw(), v.heading) : null;
    const r = side ? readyIn(n, side, performance.now()) : null;
    hud.aim.hidden = !aboard(s) || r == null || s.spot !== 'deck' || s.helm;
    if (hud.aim.hidden) return;
    const load = n.loads[groupOf(side)];
    const t = encounterTarget(s, n);
    const text = `${SIDE_LABELS[side]} · ${n.guns[side]?.gun === 'barrel' ? 'barrels' : load ? SHOT_LABELS[load] ?? load : 'unloaded'} · ${r === 0 ? (n.safeHarbour ? 'ready · safe harbour' : canCommand(s) ? 'READY — Space fires' : 'ready (captain fires)') : `reloading ${Math.ceil(r)} s`}${t?.distance != null ? ` · ${t.name} ${Math.round(t.distance)} m` : ''}`;
    if (hud.aim.textContent !== text) hud.aim.textContent = text;
    hud.aim.dataset.loaded = String(r === 0);
  }

  const STATE_WORDS = { struck: 'Colours struck', sinking: 'Sinking', wrecked: 'Wrecked', prize: 'Taken as a prize', boarded: 'Boarded' };
  function drawCard() {
    const s = S.sail, n = S.naval;
    const t = aboard(s) ? encounterTarget(s, n) : null;
    hud.card.hidden = !t;
    if (!t) return;
    const grappled = n?.self && (n.self.grappledTo === t.id || t.grappledTo === n.self.id);
    const board = n?.boarding?.id === t.id ? n.boarding : null;
    const words = [t.hostile ? 'Hostile' : null, t.faction && t.faction !== 'player' ? t.faction[0].toUpperCase() + t.faction.slice(1) : null,
      STATE_WORDS[t.state] ?? null, t.fire ? 'Burning' : null, grappled ? 'Grappled' : null,
      board ? `Boarding: ${board.phase ?? ''}${board.foesLeft != null ? ` (${board.foesLeft}/${board.foesTotal ?? '?'} left)` : ''}` : null].filter(Boolean).join(' · ');
    hud.card.replaceChildren(
      el('header', {}, el('strong', { text: t.name }), el('span', { class: 'sail-dim', text: `${t.ownerName ? ` · ${t.ownerName}` : ''}${t.distance != null ? ` · ${km(t.distance)}` : ''}` })),
      words ? el('p', { class: 'sail-card-state', 'data-hostile': String(!!t.hostile), text: words }) : null,
      t.hull || t.sails || t.crew ? el('div', { class: 'sail-meters' }, t.hull ? bar('Hull', t.hull, 'hull') : null, t.sails ? bar('Sails', t.sails, 'sails') : null, t.crew ? bar('Crew', t.crew, 'crew') : null) : null);
  }

  function drawStrip() {
    const acts = allActions();
    hud.strip.hidden = !acts.length || !!api.panel;
    if (!hud.strip.hidden) hud.strip.replaceChildren(...acts.map((a, i) => actButton(a, { primary: i === 0 })));
  }

  let drawQueued = false;
  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    queueMicrotask(() => {
      drawQueued = false;
      if (!ensureHud()) return;
      const on = api.screen === 'game';
      doc.body.toggleAttribute('data-sailing', on && aboard(S.sail));
      doc.body.toggleAttribute('data-helm', on && helm());
      if (!on) { for (const k of Object.keys(hud)) hud[k].hidden = true; return; }
      drawPlate(); drawAim(); drawCard(); drawStrip();
      if (api.panel === PANEL_ID && panelRoot?.isConnected) renderPanel(panelRoot);
    });
  }

  // ---------------------------------------------------------------- Ship & Sea panel

  function renderPanel(root) {
    panelRoot = root;
    const s = S.sail, v = s?.vessel, n = S.naval;
    const box = (label, ...kids) => el('section', { class: 'tsv-box sail-box', 'aria-label': label }, el('h3', { class: 'tsv-h4', text: label }), ...kids);
    const dim = (t) => el('p', { class: 'tsv-dim tsv-small', text: t });
    const sub = !s ? (S.stale ? 'Not connected.' : 'Asking the harbour for your ship…')
      : v ? `${v.name} · ${ROLE_LABELS[s.role]}${s.spot === 'below' ? ' · below decks' : ''}`
        : s.port ? `On the quay at ${s.port.name}${s.port.region ? `, ${s.port.region}` : ''}.` : 'Not in a port town. Ships sail from harbours.';
    const wrap = el('div', { class: 'tsv-root sail-panel' }, el('header', { class: 'tsv-head' },
      el('div', {}, el('h2', { class: 'tsv-h', text: TITLE }), el('p', { class: 'tsv-dim', text: sub })), staleNote()));
    if (!s) { root.replaceChildren(wrap); return; }
    const cols = el('div', { class: 'tsv-cols' });

    const acts = allActions().filter((a) => a.id !== 'ship');
    const harbourHint = v ? (v.docked ? null : 'Make fast at a berth to go ashore.')
      : s.own && s.port && s.own.docked && s.own.docked !== s.port.id ? `Your ship is made fast at ${s.ports.find((p) => p.id === s.own.docked)?.name ?? 'another port'}.`
        : s.own && !s.own.docked ? 'Your ship is at sea.' : null;
    cols.append(box(v ? 'Aboard' : 'Harbour',
      acts.length ? el('div', { class: 'tsv-row sail-wrap' }, acts.map((a) => actButton(a))) : dim('Nothing to do here.'),
      actButton({ id: 'chart', label: 'Open sea chart', run: () => api.openPanel('seaChart') }),
      harbourHint ? dim(harbourHint) : null,
      v && s.role === 'captain' ? dim('The hold and cabin chests are in Property & Transport while you stand in them.') : null));

    if (v) {
      const captain = s.role === 'captain';
      cols.append(box('Crew',
        el('ul', { class: 'tsv-list' }, v.crew.map((c) => el('li', {}, c.name,
          el('span', { class: 'tsv-dim', text: `${c.id === v.helmId ? ' · at the helm' : ''}${c.id === v.ownerId ? ' · captain' : ''}` }),
          captain && c.id !== String(selfId()) && c.id !== v.helmId ? actButton({ id: `give:${c.id}`, label: 'Give helm', verb: 'sailing.helm', args: { give: Number(c.id) } }) : null))),
        captain ? el('div', { class: 'tsv-row' }, actButton({ id: 'party', label: 'Invite to party', run: () => api.openPanel('party') }),
          el('span', { class: 'tsv-dim tsv-small', text: ' Your party can board at the quay while you are aboard.' })) : null));
    }

    if (s.ports.length) {
      const near = nearestPort(s);
      cols.append(box('Sea chart', el('ul', { class: 'tsv-list sail-ports' }, s.ports.map((p) => {
        const brg = v ? bearingTo(v, p) : null;
        return el('li', { 'data-port': p.id },
          el('span', { class: 'tsv-name', text: `${p.name}${p.region ? `, ${p.region}` : ''}` }),
          el('span', { class: 'tsv-dim', text: ` ${p.distance != null ? km(p.distance) : ''}${brg != null ? ` · bearing ${hdg(brg)}` : ''}${v?.docked === p.id ? ' · berthed' : ''}${p.charted === false ? ' · charting' : ''}` }),
          s.helm && v && !v.docked ? (v.course?.to === p.id
            ? actButton({ id: 'course', label: 'Clear course', verb: 'sailing.course', args: { portId: null } })
            : actButton({ id: `course:${p.id}`, label: 'Set course', verb: 'sailing.course', args: { portId: p.id } }, { disabled: !canSetCourse(s) || p.charted === false })) : null);
      })),
      v && !v.docked && near ? dim(s.dockRange != null && near.distance > s.dockRange
        ? `Nearest berth ${near.name}: ${km(near.distance)}. Come within ${km(s.dockRange)} and take the way off her to make fast.`
        : `Within reach of ${near.name}'s berth — make fast (Y at the helm).`) : null,
      s.helm && v && !v.docked ? dim(v.anchored ? 'Weigh anchor to lay a course.' : 'Set a course and she steers herself; any touch on the wheel, canvas, oars or anchor takes her off it.') : null));
    }

    if (v && n) {
      const captain = canCommand(s);
      const now = performance.now();
      const t = encounterTarget(s, n);
      const harbour = n.safeHarbour;
      // Only the batteries this hull carries (naval guns{side}), grouped as the loads are: broadside, bow, stern.
      const groups = ['broadside', 'bow', 'stern'].filter((g) => SIDES.some((side) => groupOf(side) === g && n.guns[side]));
      const ammo = `${n.ammo.shot ?? '?'} shot${n.ammo.barrels ? ` · ${n.ammo.barrels} barrels` : ''}`;
      cols.append(box('Guns', groups.length ? el('div', { class: 'sail-wrap' }, groups.map((g) => {
        const sides = SIDES.filter((side) => groupOf(side) === g && n.guns[side]);
        const gun = n.guns[sides[0]];
        const barrel = gun.gun === 'barrel';
        return el('div', { class: 'sail-battery', 'data-group': g },
          el('strong', { text: g === 'broadside' ? 'Broadsides' : SIDE_LABELS[g] }),
          el('span', { class: 'tsv-dim', text: ` · ${sides.map((side) => `${n.guns[side].count}`).join('+')} ${GUN_LABELS[gun.gun] ?? gun.gun}${gun.range ? ` · ${km(gun.range)}` : ''} · ${barrel ? 'barrels' : n.loads[g] ? SHOT_LABELS[n.loads[g]] ?? n.loads[g] : 'unloaded'}` }),
          !barrel && captain ? el('div', { class: 'tsv-row sail-wrap', role: 'group', 'aria-label': `Load ${g}` }, SHOTS.map((shot) => {
            const b = actButton({ id: `load:${g}:${shot}`, label: SHOT_LABELS[shot], verb: 'naval.load', args: { group: g, shot } }, { disabled: n.loads[g] === shot || n.ammo.shot === 0 });
            b.setAttribute('aria-pressed', String(n.loads[g] === shot));
            return b;
          })) : null,
          captain ? el('div', { class: 'tsv-row sail-wrap' }, sides.map((side) => {
            const r = readyIn(n, side, now);
            const empty = barrel ? !n.ammo.barrels : n.ammo.shot === 0;
            return actButton({ id: `fire:${side}`, label: harbour ? `${SIDE_LABELS[side]}: safe harbour` : empty ? `${SIDE_LABELS[side]}: no ${barrel ? 'barrels' : 'shot'}` : r === 0 ? `Fire ${SIDE_LABELS[side].toLowerCase()}` : `${SIDE_LABELS[side]} ${Math.ceil(r)} s`,
              verb: 'naval.fire', args: { side, ...(t?.hostile ? { targetId: t.id } : {}) } }, { primary: r === 0 && !harbour && !empty, disabled: r !== 0 || harbour || empty });
          })) : null);
      })) : dim('This hull carries no guns.'),
      el('p', { class: 'tsv-dim tsv-small', text: `${ammo}${harbour ? ' · in safe harbour: the guns are quiet' : ''}${n.repel ? ` · repel boarders: ${n.repel.foesLeft}/${n.repel.foesTotal} left` : ''}` }),
      el('div', { class: 'tsv-row sail-wrap' },
        actButton({ id: 'brace', label: n.braced ? 'Stand easy' : 'Brace', verb: 'naval.brace', args: { on: !n.braced } }),
        captain && n.self?.colours && n.self.colours !== 'struck' ? actButton({ id: 'colours', label: n.self.colours === 'hostile' ? 'Fly peaceful colours' : 'Fly hostile colours', verb: 'naval.colours', args: { hostile: n.self.colours !== 'hostile' } }) : null,
        captain && t?.hostile && (n.self?.state ?? 'afloat') === 'afloat' ? actButton({ id: 'surrender', label: 'Strike colours', verb: 'naval.surrender', args: {} }) : null,
        v.docked ? actButton({ id: 'restock', label: 'Restock shot', verb: 'naval.restock', args: {} }) : null),
      dim(captain ? 'Face a side: / loads it, Space fires it at the ship you face.' : 'The captain or helmsman fires; you can brace and board.')));
    }

    wrap.append(cols);
    root.replaceChildren(wrap);
  }
  api.registerPanel(PANEL_ID, TITLE, (root) => renderPanel(root), { key: SHIP_PANEL, watch: 'none' });
  api.on('panel', (e) => {
    if (e?.open && e.id === PANEL_ID) resync(true);
    else draw();
  });

  // ---------------------------------------------------------------- keys

  function claims(e) {
    if (api.screen !== 'game' || api.modalOpen || api.panel || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (isTextEntry(e.target) || isTextEntry(doc?.activeElement)) return false;
    return aboard(S.sail);
  }

  function onKeyDown(e) {
    if (!claims(e)) return;
    const s = S.sail, v = s.vessel, n = S.naval;
    const take = (fn) => { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) fn(); };
    if (e.code === HELM_TOGGLE) {
      const a = contextActions(s, n).find((x) => x.id === 'helm');
      return a ? take(() => runAction(a)) : undefined;
    }
    if (s.helm && !v.docked) {
      const cmd = helmCommand(e.code);
      if (cmd === 'rudderPort' || cmd === 'rudderStarboard') {
        e.preventDefault(); e.stopImmediatePropagation();
        S.held.add(e.code); S.latchedRudder = 0; steer(wantRudder()); draw();
        return;
      }
      if (cmd === 'sailUp' || cmd === 'sailDown') return take(() => setSails(cmd === 'sailUp' ? 1 : -1));
      if (cmd === 'oarsBack' || cmd === 'oarsAhead') return take(() => setOars(cmd === 'oarsAhead' ? 1 : -1));
      if (cmd === 'anchor' || cmd === 'dock') {
        const a = contextActions(s, n).find((x) => x.id === cmd);
        return take(() => (a ? runAction(a) : api.message(cmd === 'dock' ? 'No berth within reach.' : 'Not now.', { kind: 'error' })));
      }
    }
    if (n && s.spot === 'deck' && !s.helm) {
      const side = facingSide(lookYaw(), v.heading);
      const r = side ? readyIn(n, side, performance.now()) : null;
      if (r == null) return;
      const g = groupOf(side);
      if (e.code === GUN_KEYS.load && n.guns[side]?.gun !== 'barrel' && canCommand(s)) {
        // / cycles the battery you face to its next munition (round → grape → chain → heated).
        const next = SHOTS[(SHOTS.indexOf(n.loads[g]) + 1) % SHOTS.length];
        return take(() => send(`load:${g}`, 'naval.load', { group: g, shot: next }));
      }
      if (e.code === GUN_KEYS.fire && r === 0 && canCommand(s) && !n.safeHarbour) {
        const t = encounterTarget(s, n);
        return take(() => send(`fire:${side}`, 'naval.fire', { side, ...(t?.hostile ? { targetId: t.id } : {}) }));
      }
    }
  }
  function onKeyUp(e) {
    if (!S.held.has(e.code)) return;
    S.held.delete(e.code);
    e.stopImmediatePropagation();
    if (helm()) steer(wantRudder());
    draw();
  }
  function releaseRudder() {
    const had = S.held.size || S.latchedRudder;
    S.held.clear(); S.latchedRudder = 0;
    if (had && helm() && live()) steer(0, true);
  }
  globalThis.addEventListener?.('keydown', onKeyDown, true); // capture: ahead of walking keys, only when claimed
  globalThis.addEventListener?.('keyup', onKeyUp, true);
  globalThis.addEventListener?.('blur', releaseRudder);

  // ---------------------------------------------------------------- server state, reconnect, errors

  function resync(harbour = false) {
    S.syncing = true;
    draw();
    const r = api.act('sailing.sync', { harbour, requestId: requestId() }, { quiet: true });
    if (!r) { S.syncing = false; return; }
    r.then((out) => { if (out && !out.ok) { S.syncing = false; api.message(`Sailing: ${out.error ?? 'no answer'}`, { kind: 'error' }); draw(); } });
    api.act('naval.sync', {}, { quiet: true });
  }

  // Periodic snapshots carry the nearest ports only: keep the full list (newer distances win) until the next full one.
  function mergePorts(full, recent) {
    if (!Array.isArray(full)) return recent;
    const byId = new Map(full.map((p) => [p.id, p]));
    for (const p of recent ?? []) byId.set(p.id, p);
    return [...byId.values()].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }

  api.on('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string') return;
    if (ev.kind === 'sailing.state') {
      if (Number.isFinite(S.raw?.seq) && Number.isFinite(ev.seq) && ev.seq <= S.raw.seq && !S.syncing) return; // stale or repeated (seq rises per player)
      const keep = !ev.full && S.raw?.vessel && ev.vessel && S.raw.vessel.id === ev.vessel.id ? { dockRange: S.raw.dockRange, ports: mergePorts(S.raw.ports, ev.ports) } : {};
      const wasHelm = helm();
      S.raw = { ...ev, ...keep };
      reread();
      S.syncing = false; S.stale = false; S.seenState = true;
      if (wasHelm && !helm()) { S.held.clear(); S.latchedRudder = 0; S.rudderSent = null; }
      if (!aboard(S.sail)) S.naval = null;
      draw();
    } else if (ev.kind === 'social' && ev.social && !aboard(S.sail) && S.sail?.port) {
      // The quay's party boats come with sailing.sync: ask again when the party changes on the quay.
      const key = JSON.stringify(ev.social.party?.members?.map?.((m) => m.id ?? m) ?? ev.social.party ?? null);
      if (key !== S.partyKey) { S.partyKey = key; resync(); }
    } else if (ev.kind === 'sailing' && 'course' in ev) {
      draw(); // the text is toasted by the shell; the course itself arrives with the next sailing.state
    } else if (ev.kind === 'naval.news') {
      // A player ship going down leaves a wreck her sinker may plunder; the server decides who that is.
      if (ev.what === 'sinking' && ev.shipId != null && !String(ev.shipId).startsWith('npc:') && String(ev.shipId) !== S.sail?.vessel?.id) {
        const seen = S.naval?.contacts.find((c) => c.id === String(ev.shipId));
        S.wrecks.set(String(ev.shipId), { id: String(ev.shipId), name: seen?.name ?? null, until: Date.now() + WRECK_MS });
      } else if (ev.what === 'plunder' && ev.shipId != null) S.wrecks.delete(String(ev.shipId));
      draw();
    } else if (ev.kind === 'naval.state') {
      S.naval = readNaval(ev, performance.now());
      draw();
    } else if (ev.kind === 'teleport') {
      resync();
    }
  });
  api.on('passage', () => draw()); // passage.js re-emits after it stores its status
  api.on('connection', (state) => {
    if (state === 'online') { if (S.stale || S.seenState) { S.stale = false; resync(!aboard(S.sail) && /^town:/.test(api.location ?? '')); } }
    else if (state === 'lost' || state === 'closed' || state === 'connecting') { if (S.sail) S.stale = true; releaseRudder(); draw(); }
  });
  api.on('screen', (name) => {
    if (name === 'game' && api.connection !== 'lost') { lastPlace = null; resync(/^town:/.test(api.location ?? '')); }
    else releaseRudder();
    draw();
  });
  // Arriving in a town exterior (by foot, travel or going ashore) asks the harbour master whether this town has a berth:
  // `harbour:true` makes the core chart the coast and send a sailing.state with `port` once the berth is known.
  let lastPlace = null;
  function arrived() {
    const loc = api.location ?? api.state?.character?.location ?? null;
    if (loc === lastPlace) return;
    lastPlace = loc;
    if (loc && /^town:/.test(loc) && !aboard(S.sail) && api.connection !== 'lost' && api.screen === 'game') resync(true);
  }
  api.on('state', (st) => {
    if (st) arrived();
    if (st === null) { S.raw = null; S.sail = null; S.naval = null; lastPlace = null; }
    else reread(); // deck or cabin follows the player's location
    draw();
  });
  let lastFace = null, lastTick = 0;
  api.on('frame', (f) => {
    if (!aboard(S.sail) || !S.naval) return;
    const face = facingSide(lookYaw(), S.sail.vessel.heading);
    const now = f?.now ?? 0;
    if (face !== lastFace || now - lastTick > 0.5) { lastFace = face; lastTick = now; draw(); } // reload countdown
  });

  // ---------------------------------------------------------------- 3D (separate owner; file lands later)

  import('./sailing/render.js').then((m) => m.installSailingRenderer(api))
    .catch((err) => console.error('[sailing] ./sailing/render.js failed to load; ships are not drawn:', err));

  draw();
  return {
    get sailing() { return S.sail; },
    get naval() { return S.naval; },
    get stale() { return S.stale; },
    actions: allActions,
    resync,
    openYard,
  };
}
