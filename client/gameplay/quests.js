// Quest journal and offers (panel `journal`). The server runs the quests
// (server/rpg/quests.js); this module only shows offers, questions, the log and quest items,
// and sends quest.* intents. Quest text arrives from the server, read from the operator's
// own classic files; nothing is bundled here.
//
// The page always says which state it is in, so "no quests" is never shown for a journal
// that has not arrived: not in the world / loading / quest service missing / disconnected
// (last known journal, read-only) / genuinely empty (with where to find work from here).

import { dateFromMinutes, formatDate } from './atmosphere/calendar.js';
import { locationName } from './api.js';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const RESULT = { success: 'Completed', failed: 'Failed', ended: 'Ended' };
const MAX_FEED = 6;
const ROLE_LABEL = { crier: 'Town Crier', noble: 'Noble', fighters: 'Fighters Guild', mages: 'Mages Guild' };

/**
 * Which journal state to show for a merged RPG state. Pure; exported for tests.
 * @returns {{kind:'offline'|'loading'|'unavailable'|'ready', quests?:object, stale?:boolean}}
 */
export function journalState(state, { screen = 'game', connection = 'online' } = {}) {
  const lost = connection === 'lost' || connection === 'closed' || connection === 'connecting';
  const c = state?.character;
  if (!c || typeof c !== 'object') return { kind: screen === 'game' && !lost ? 'loading' : 'offline' };
  const q = c.quests;
  if (!q || typeof q !== 'object' || q.v !== 1) return { kind: 'unavailable', stale: lost };
  return {
    kind: 'ready',
    stale: lost,
    quests: {
      active: Array.isArray(q.active) ? q.active : [],
      done: Array.isArray(q.done) ? q.done : [],
      offer: q.offer && typeof q.offer === 'object' ? q.offer : null,
      minutes: Number.isFinite(q.minutes) ? q.minutes : 0,
    },
  };
}

/** Quest givers in the current place, nearest first (only what the server already shows). */
export function questGiversHere(state, at = null) {
  const list = (state?.entities ?? []).filter((e) => e && e.kind === 'npc' && (e.questGiver || e.journal) && !e.dead);
  const d = (e) => (at && Number.isFinite(e.x) ? Math.hypot(e.x - at.x, e.z - at.z) : 0);
  return list.map((e) => ({ id: String(e.id), name: e.name || 'Someone', role: ROLE_LABEL[e.role] ?? e.title ?? '', distance: at ? Math.round(d(e)) : null }))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

/** The running deadline (classic minutes) of a quest instance, or null. */
export function questDeadline(inst) {
  let end = null;
  for (const c of Object.values(inst?.clocks ?? {})) {
    if (c && c.running && !c.done && Number.isFinite(c.endAt)) end = end === null ? c.endAt : Math.min(end, c.endAt);
  }
  return end;
}

export function install(api) {
  const ui = { feed: [], report: null, busy: false, showReport: false, open: new Set(), owner: null };
  let container = null;

  const connection = () => api.connection ?? globalThis.document?.body?.dataset?.conn ?? 'online';
  const current = () => journalState(api.state, { screen: api.screen ?? 'game', connection: connection() });
  const rerender = () => { if (container?.isConnected) render(container); };
  const push = (title, text, tone = 'say') => {
    if (!text) return;
    ui.feed.unshift({ title, text, tone, at: Date.now() });
    ui.feed.length = Math.min(ui.feed.length, MAX_FEED);
  };
  // The feed and support report are this session's notes; they never carry over to another
  // character or account on the same page.
  const resetSession = () => { ui.feed = []; ui.report = null; ui.showReport = false; ui.open.clear(); ui.busy = false; };
  const show = () => {
    if (api.panel !== 'journal') api.openPanel('journal');
    else rerender();
  };
  const act = (verb, args) => {
    ui.busy = true;
    rerender();
    const r = api.act(verb, args);
    const done = () => { ui.busy = false; rerender(); };
    if (r && typeof r.then === 'function') r.then(done, done);
    else done();
  };

  api.on('state', (s) => {
    const owner = s?.selfId != null ? `${api.account?.id ?? ''}:${s.selfId}` : null;
    if (!s || (owner && ui.owner && owner !== ui.owner)) resetSession();
    if (owner) ui.owner = owner;
    else if (!s) ui.owner = null;
    rerender();
  });
  api.on('account', () => { resetSession(); ui.owner = null; rerender(); });
  api.on('connection', rerender);
  api.on('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('quest')) return;
    // The journal announces quest events itself (a short toast; full text in the page), so
    // main.js must not toast the same text again.
    ev.silent = true;
    switch (ev.kind) {
      case 'questOffer':
        // A conversation page that shows the offer itself (Accept/Refuse in the dialogue) keeps
        // the player there; otherwise the journal opens on the offer. Either way the offer is
        // also in the journal, from the authoritative snapshot, until answered.
        // `ev.talkHandled`: the in-chat conversation (npcs.js) is showing it with Accept/Refuse.
        if (ev.talkHandled || (api.panel === 'dialogue' && api.getPanel('dialogue')?.handlesQuestOffers)) rerender();
        else show();
        break;
      case 'questAccepted':
        push(ev.title, ev.text, 'accept');
        if (!ev.talkHandled) api.message(`Journal: ${ev.title} added.`, { kind: 'quest' });
        rerender();
        break;
      case 'questRefused':
        push(ev.title, ev.text, 'refuse');
        rerender();
        break;
      case 'questMessage':
        push(ev.title ?? 'Journal', ev.text);
        if (!ev.talkHandled) api.message(firstLine(ev.text), { kind: 'quest' });
        rerender();
        break;
      case 'questPrompt':
        push(ev.title, ev.text, 'prompt');
        if (ev.talkHandled) rerender();
        else show();
        break;
      case 'questLog':
        api.message(`Journal updated: ${ev.title}`, { kind: 'quest' });
        rerender();
        break;
      case 'questReward':
        api.message(ev.gold ? `You receive ${ev.gold} gold.` : `You receive ${ev.item}.`, { kind: 'quest' });
        break;
      case 'questEnd':
        api.message(`${ev.title}: ${RESULT[ev.result] ?? ev.result}.`, { kind: 'quest' });
        rerender();
        break;
      case 'questSound':
        // Classic `play sound` (DAGGER.SND index ev.sound) or `play song` (ev.song): audio only, no journal entry
        // or toast. The audio module owns playback.
        break;
      case 'questCatalog':
        ui.report = ev.report;
        ui.showReport = true;
        rerender();
        break;
      default:
        break;
    }
  });

  // Quest objects lying in the world (kind questItem) are picked up from here.
  const nearbyItems = () => (api.state?.entities ?? []).filter((e) => e.kind === 'questItem');
  const dateText = (m) => (Number.isFinite(m) ? formatDate(dateFromMinutes(m)) : '');

  function offerBox(o, stale) {
    return el('section', { class: 'qj-card qj-offer', 'aria-label': 'Quest offer' },
      el('p', { class: 'qj-kicker', text: `${o.giver?.name ?? 'Someone'} offers work` }),
      el('h4', { class: 'qj-title', text: o.title }),
      el('p', { class: 'qj-meta', text: `classic ${o.name}` }),
      el('p', { class: 'qj-text', text: reflow(o.text) || '…' }),
      el('div', { class: 'qj-buttons' },
        el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'qj-accept', disabled: ui.busy || stale, onclick: () => act('quest.accept', { offerId: o.id }) }, 'Accept'),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': 'qj-refuse', disabled: ui.busy || stale, onclick: () => act('quest.refuse', { offerId: o.id }) }, 'Refuse')));
  }

  function promptBox(inst, text, stale) {
    return el('section', { class: 'qj-card qj-prompt', role: 'group', 'aria-label': 'Question' },
      el('p', { class: 'qj-kicker', text: inst.title }),
      el('p', { class: 'qj-text', text: reflow(text) || 'Will you?' }),
      el('div', { class: 'qj-buttons' },
        el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': `qj-yes-${inst.uid}`, disabled: ui.busy || stale, onclick: () => act('quest.answer', { uid: inst.uid, yes: true }) }, 'Yes'),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': `qj-no-${inst.uid}`, disabled: ui.busy || stale, onclick: () => act('quest.answer', { uid: inst.uid, yes: false }) }, 'No')));
  }

  function questEntry(inst, stale) {
    const held = Object.entries(inst.items ?? {}).filter(([, it]) => it.held);
    const status = inst.unavailable ? 'Script unavailable on this server' : inst.success ? 'Rewarded' : 'In progress';
    const expanded = ui.open.has(inst.uid);
    const due = questDeadline(inst);
    const source = inst.giver;
    const place = source?.location && locationName(source.location, null, null, { to: source.location, label: source.buildingName, townName: source.townName });
    const giver = source?.name ? `From ${source.name}${place ? `, ${place}` : ''}` : null;
    return el('li', { class: 'qj-quest', 'data-quest': inst.uid },
      el('div', { class: 'qj-quest-head' },
        el('strong', { class: 'qj-quest-title', text: inst.title }),
        el('span', { class: `qj-chip${inst.success ? ' qj-chip-good' : ''}`, text: status })),
      el('p', { class: 'qj-meta', text: [giver, `classic ${inst.name}`].filter(Boolean).join(' · ') }),
      Number.isFinite(inst.acceptedAt) || due !== null ? el('p', { class: 'qj-meta' },
        Number.isFinite(inst.acceptedAt) ? `Accepted ${dateText(inst.acceptedAt)}` : null,
        Number.isFinite(inst.acceptedAt) && due !== null ? ' · ' : null,
        due !== null ? el('span', { class: 'qj-due', text: `Due by ${dateText(due)}` }) : null) : null,
      // Classic escort faces (`add _P_ face`): people travelling with the player for this quest.
      inst.faces?.length ? el('p', { class: 'qj-meta qj-faces', text: `Travelling with you: ${inst.faces.map((f) => f.name).join(', ')}` }) : null,
      inst.log?.length
        ? el('ol', { class: 'qj-log' }, inst.log.map((e) => el('li', { class: 'qj-text', text: reflow(e.text) })))
        : el('p', { class: 'qj-meta', text: 'No journal entry yet.' }),
      held.length ? el('div', { class: 'qj-items' },
        el('span', { class: 'qj-meta', text: 'Carrying:' }),
        held.flatMap(([k, it]) => {
          const actions = [];
          const dropPlaces = it.dropPlaces ?? [];
          if (!dropPlaces.length || it.usedMessage || it.useTask) actions.push(el('button', {
            type: 'button', class: 'btn btn-small', 'data-focus-key': `qj-use-${inst.uid}-${k}`, disabled: ui.busy || stale,
            title: it.usedMessage ? 'Read' : 'Use', onclick: () => act('quest.use', { uid: inst.uid, item: k }),
          }, `${it.usedMessage ? 'Read' : 'Use'} ${it.name}`));
          const canReturn = dropPlaces.some((key) => {
            const p = inst.places?.[key];
            return !!p && (p.interior ?? (p.noBuilding ? p.location : null)) === api.location;
          });
          if (canReturn) actions.push(el('button', {
            type: 'button', class: 'btn btn-small', 'data-focus-key': `qj-drop-${inst.uid}-${k}`, disabled: ui.busy || stale,
            onclick: () => act('quest.drop', { uid: inst.uid, item: k }),
          }, `Put back ${it.name}`));
          return actions.length ? actions : el('span', { text: it.name });
        })) : null,
      inst.report || inst.notes?.length ? el('details', { class: 'qj-report', open: expanded, ontoggle: (e) => { if (e.target.open) ui.open.add(inst.uid); else ui.open.delete(inst.uid); } },
        el('summary', { text: 'How this quest runs here' }),
        el('p', { class: 'qj-meta', text: inst.report?.source === 'classic' ? 'Logic and text read from your ARENA2 QBN/QRC files.' : 'Logic from the operator’s quest script; text from ARENA2 when present.' }),
        inst.report?.approximations?.length ? el('ul', { class: 'qj-notes' }, inst.report.approximations.map((a) => el('li', { text: `Simplified: ${a}` }))) : null,
        inst.notes?.length ? el('ul', { class: 'qj-notes' }, inst.notes.map((a) => el('li', { text: `Not supported: ${a}` }))) : null) : null);
  }

  function reportBox(r) {
    return el('section', { class: 'qj-card qj-catalog', 'aria-label': 'Quest support report' },
      el('div', { class: 'qj-quest-head' },
        el('h4', { class: 'qj-title', text: 'Quest support on this server' }),
        el('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': 'qj-catalog-close', onclick: () => { ui.showReport = false; rerender(); } }, 'Close')),
      el('p', { class: 'qj-meta', text: `${r.offerable?.length ?? 0} of ${r.total ?? 0} quests can be offered.` }),
      r.offerable?.length ? el('p', { class: 'qj-text qj-mono', text: r.offerable.map((x) => x.name).join(' ') }) : null,
      r.topBlockers?.length ? el('h5', { class: 'qj-h5', text: 'Most common reasons a quest is held back' }) : null,
      r.topBlockers?.length ? el('ul', { class: 'qj-notes' }, r.topBlockers.slice(0, 10).map((b) => el('li', { text: `${b.quests} × ${b.reason}` }))) : null);
  }

  /** Where to find work from here: named givers in this place, or why there are none. */
  function emptyBox() {
    const loc = api.location ?? '';
    const givers = questGiversHere(api.state, api.camera ? { x: api.camera.x, z: api.camera.z } : null);
    const kids = [el('p', { class: 'menu-empty', text: 'You have no current work.' })];
    if (givers.length) {
      kids.push(el('p', { class: 'qj-meta', text: 'People here who may have work — walk up to one, press the Use key and ask “Any work?”:' }));
      kids.push(el('ul', { class: 'qj-givers' }, givers.slice(0, 8).map((g) => el('li', {},
        el('strong', { text: g.name }),
        g.role ? el('span', { class: 'qj-meta', text: ` · ${g.role}` }) : null,
        g.distance !== null ? el('span', { class: 'qj-meta', text: ` · ${g.distance} m` }) : null))));
    } else {
      const where = loc.startsWith('wilderness:') ? 'in the wilderness' : loc.startsWith('dungeon:') ? 'in this dungeon' : loc.startsWith('interior:') ? 'in this building' : 'here';
      kids.push(el('p', { class: 'qj-meta', text: `No one ${where} offers work. In towns, the town crier, nobles and the Fighters and Mages Guild officials do — open the travel map to go to one.` }));
    }
    return el('section', { class: 'qj-card qj-empty', 'aria-label': 'No current work' }, kids);
  }

  function statusBox(kind) {
    const text = {
      offline: ['Not in the world', 'Your journal is kept on the server and appears here once you enter the world.'],
      loading: ['Loading your journal…', 'Waiting for your character from the server.'],
      unavailable: ['Journal unavailable', 'This server is not running the quest service, so it has not sent a journal. Nothing has been lost.'],
    }[kind];
    return el('section', { class: 'qj-card qj-status', role: 'status', 'data-state': kind },
      el('h4', { class: 'qj-title', text: text[0] }),
      el('p', { class: 'qj-meta', text: text[1] }));
  }

  function render(root) {
    container = root;
    const js = current();
    root.dataset.journal = js.kind;
    const kids = [];
    if (js.stale) {
      kids.push(el('p', { class: 'qj-card qj-stale', role: 'status', text: 'Disconnected — this is your journal as last received. Actions resume when you reconnect.' }));
    }
    if (js.kind !== 'ready') {
      kids.push(statusBox(js.kind));
      root.replaceChildren(el('div', { class: 'qj-root' }, kids));
      return;
    }
    const q = js.quests;
    const stale = !!js.stale;
    if (q.offer) kids.push(offerBox(q.offer, stale));
    for (const inst of q.active) {
      if (inst.prompt) {
        const recent = ui.feed.find((f) => f.title === inst.title && f.tone === 'prompt');
        kids.push(promptBox(inst, inst.prompt.text ?? recent?.text, stale));
      }
    }
    if (ui.feed.length) {
      kids.push(el('section', { class: 'qj-card qj-feed', 'aria-label': 'Recent quest messages', 'aria-live': 'polite' },
        ui.feed.slice(0, 3).map((f) => el('div', { class: `qj-say qj-say-${f.tone}` },
          el('p', { class: 'qj-kicker', text: f.title }),
          el('p', { class: 'qj-text', text: reflow(f.text) })))));
    }
    const items = nearbyItems();
    if (items.length) {
      kids.push(el('section', { class: 'qj-card', 'aria-label': 'Nearby quest objects' },
        el('h5', { class: 'qj-h5', text: 'Nearby' }),
        el('div', { class: 'qj-items' }, items.map((e) => el('button', {
          type: 'button', class: 'btn btn-small', 'data-focus-key': `qj-take-${e.id}`, disabled: ui.busy || stale, onclick: () => act('quest.click', { targetId: e.id }),
        }, `Take ${e.name}`)))));
    }
    kids.push(el('h4', { class: 'qj-h4', text: `Current work${q.active.length ? ` (${q.active.length})` : ''}` }));
    kids.push(q.active.length ? el('ul', { class: 'qj-list' }, q.active.map((inst) => questEntry(inst, stale))) : (q.offer ? el('p', { class: 'menu-empty', text: 'None yet — accept the offer above to add it.' }) : emptyBox()));
    if (q.done.length) {
      kids.push(el('h4', { class: 'qj-h4', text: `Finished (${q.done.length})` }));
      kids.push(el('ul', { class: 'qj-list qj-done' }, q.done.slice(0, 12).map((d) => el('li', { class: 'qj-quest', 'data-quest': d.uid },
        el('div', { class: 'qj-quest-head' },
          el('strong', { class: 'qj-quest-title', text: d.title }),
          el('span', { class: `qj-chip qj-chip-${d.result}`, text: RESULT[d.result] ?? d.result })),
        d.giver || Number.isFinite(d.endedAt) ? el('p', { class: 'qj-meta', text: [typeof d.giver === 'string' ? `From ${d.giver}` : null, Number.isFinite(d.endedAt) ? `${RESULT[d.result] ?? 'Ended'} ${dateText(d.endedAt)}` : null].filter(Boolean).join(' · ') }) : null,
        d.log?.length ? el('p', { class: 'qj-text qj-dim', text: reflow(typeof d.log.at(-1) === 'string' ? d.log.at(-1) : d.log.at(-1)?.text ?? '') }) : null))));
    }
    if (ui.showReport && ui.report) kids.push(reportBox(ui.report));
    kids.push(el('p', { class: 'qj-foot' },
      el('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': 'qj-catalog', disabled: stale, onclick: () => api.act('quest.catalog', {}) }, 'Quest support report')));
    root.replaceChildren(el('div', { class: 'qj-root' }, kids));
  }

  api.registerPanel('journal', 'Journal', (root) => render(root));
}

function firstLine(text) {
  const s = String(text ?? '').split('\n').join(' ').trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export default install;

/**
 * Classic QRC text is hard-wrapped for a 320-pixel screen. Join single line breaks so it reflows
 * to the page width; keep blank lines (paragraphs). Exported for tests.
 */
export function reflow(text) {
  return String(text ?? '').replace(/\r/g, '').split(/\n{2,}/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join(' ')).filter(Boolean).join('\n\n');
}
