// Book passage: the non-owner sea passage panel (server rules: server/rpg/passage.js).
//
// Design source: Daggerfall Online (Lattymoy, MIT), .ref/dfjs-research-03 @ a3eb1605 src/scenes/naval/passageHost.js -
// her master's ports nearest first with bearing and fare, then the question with the purse beside the fare, nothing paid
// until confirmed. Reimplemented as a Play panel; the voyage itself (deck, sea, helm HUD) is the sailing UI and
// renderer's, driven by the core's sailing.state with role 'passenger'. This module invents no voyage state: it shows the
// server's private `passage.status` and sends intent with a request id.
//
// Exports for the sailing UI owner (client/gameplay/sailing.js imports this module): PANEL_ID, install(api) ->
// { openPassage, actions }, passageActions(api.state) -> [{id,label,run}], offerRow().

export const PANEL_ID = 'passage';
const TITLE = 'Sea Passage';

/** One row of her master's list: "Wayrest - north-east, 75 gold". */
export function offerRow(o) {
  if (!o) return '';
  return o.bearing ? `${o.name} - ${o.bearing}, ${o.fare} gold` : `${o.name} - ${o.fare} gold`;
}

/** The installed panel (one per page), so the sailing HUD can ask for runnable buttons. */
let active = null;

/**
 * The contextual passage buttons: ids 'book' | 'rejoin' | 'disembark' | 'cancel'. Pass a `passage.status` event for the
 * pure rule (no `run`); pass anything else (the sailing HUD hands api.state) and the installed panel's last server status
 * is used, each button with its `run`.
 */
export function passageActions(arg) {
  const isStatus = arg && typeof arg === 'object' && 'voyage' in arg && 'here' in arg;
  if (!isStatus) return active ? active.actions() : [];
  return passageRule(arg);
}
function passageRule(status) {
  if (!status) return [];
  const v = status.voyage;
  if (!v) return status.here && status.available !== false ? [{ id: 'book', label: `Book passage at ${status.here.name}` }] : [];
  const out = [];
  if (v.present && !v.aboard) out.push({ id: 'rejoin', label: `Rejoin the ${v.ship}` });
  if (v.aboard && v.docked === v.to.id) out.push({ id: 'disembark', label: `Go ashore at ${v.to.name}` });
  if (v.aboard && v.docked === v.from.id && v.state !== 'arrived') out.push({ id: 'cancel', label: 'Leave her before she sails (refund)' });
  if (!v.present) out.push({ id: 'rejoin', label: 'Ask after your ship' }); // the server settles a lost ship in the passenger's favour
  return out;
}

const VERBS = Object.freeze({ rejoin: 'passage.rejoin', disembark: 'passage.disembark', cancel: 'passage.cancel' });
const requestId = () => `pg-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

export function install(api) {
  const ui = { status: null, pick: null, busy: false, busyTimer: 0 };
  let container = null;
  const isOpen = () => api.panel === PANEL_ID && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  const done = () => { ui.busy = false; clearTimeout(ui.busyTimer); };
  const act = (verb, args = {}) => {
    if (ui.busy) return;
    ui.busy = true;
    clearTimeout(ui.busyTimer);
    ui.busyTimer = setTimeout(() => { ui.busy = false; rerender(); }, 4000);
    const r = api.act(verb, { ...args, requestId: requestId() });
    if (r && typeof r.then === 'function') r.then((res) => { done(); if (res?.ok && verb === 'passage.book') ui.pick = null; rerender(); });
    rerender();
  };

  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'passage.status') {
      ui.status = ev;
      if (ev.voyage) ui.pick = null;
      done();
      rerender();
      api.emit('passage', ev); // the sailing HUD redraws its contextual buttons
    } else if (ev.kind === 'passage') done();
  });
  // A reconnect: drop local state and ask the server (never assume).
  api.on('connection', (state) => { if (state !== 'online') return; ui.status = null; ui.pick = null; api.act('passage.sync', {}, { quiet: true }); });
  api.on('state', () => { if (!ui.status) api.act('passage.sync', {}, { quiet: true }); });

  function openPassage() {
    ui.pick = null;
    api.act('passage.offer', {}, { quiet: false });
    api.openPanel(PANEL_ID);
  }
  function actions() {
    return passageRule(ui.status).map((a) => ({
      ...a,
      run: a.id === 'book' ? openPassage : () => act(VERBS[a.id], {}),
    }));
  }

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
  const button = (label, onclick, disabled = false) => el('button', { type: 'button', class: 'tsv-btn', disabled: disabled || ui.busy, onclick }, label);

  function render(root) {
    container = root;
    root.replaceChildren();
    const s = ui.status;
    const box = el('section', { class: 'tsv-section passage', 'aria-live': 'polite' });
    root.append(box);
    if (!s) { box.append(el('p', { text: 'Asking the harbour…' })); return; }
    const v = s.voyage;
    if (v) {
      box.append(
        el('h3', { text: `The ${v.ship}` }),
        el('p', { text: `Captain ${v.master ?? 'unknown'} · ${v.from.name} → ${v.to.name}${v.bearing ? ` (${v.bearing})` : ''} · fare ${v.fare} gold paid` }),
        el('p', { text: v.state === 'arrived' || v.docked === v.to.id ? `She is made fast at ${v.to.name}'s quay.`
          : v.aboard && v.docked === v.from.id ? `Aboard at ${v.from.name}'s quay. Her master casts off shortly; walk her deck as you like.`
          : v.aboard ? 'Under sail. Her master steers; walk her deck as you like.' : v.present ? 'You are ashore while she sails on.' : 'Her master cannot be found.' }),
      );
      const row = el('div', { class: 'tsv-row' });
      for (const a of actions()) row.append(button(a.label, a.run));
      box.append(row);
      return;
    }
    if (!s.here) { box.append(el('p', { text: 'There is no harbour here. Book passage in a port town.' })); return; }
    if (s.available === false) { box.append(el('p', { text: 'No ship sails from this harbour yet.' })); return; }
    box.append(el('h3', { text: `${s.here.name} harbour` }), el('p', { text: `Her master names the ports he will sail for. You carry ${s.gold} gold.` }));
    if (!Array.isArray(s.offers)) { box.append(button('Ask the ship’s master', () => act('passage.offer'))); return; }
    if (!s.offers.length) { box.append(el('p', { text: 'Her master knows of no port you have heard of to sail for.' })); return; }
    if (ui.pick) {
      const o = ui.pick;
      box.append(
        el('p', { text: `Book passage to ${o.name}? The fare is ${o.fare} gold. You have ${s.gold}.` }),
        el('p', { text: 'Her master sails you there. You may walk her deck; go ashore when she is made fast.' }),
        el('div', { class: 'tsv-row' },
          button(`Pay ${o.fare} gold and board`, () => act('passage.book', { toPortId: o.portId, expectFare: o.fare }), o.fare > s.gold),
          button('Back', () => { ui.pick = null; rerender(); })),
      );
      return;
    }
    const list = el('ul', { class: 'passage-offers', role: 'list' });
    for (const o of s.offers) {
      list.append(el('li', {}, button(offerRow(o), () => { ui.pick = o; rerender(); }, o.fare > s.gold)));
    }
    box.append(list);
  }

  let wasOpen = false;
  api.on('panel', (d) => {
    const open = !!d?.open && d.id === PANEL_ID;
    if (open && !wasOpen && !ui.status?.voyage) api.act('passage.offer', {}, { quiet: true });
    wasOpen = open;
  });
  api.registerPanel(PANEL_ID, TITLE, (root) => render(root), { watch: 'none', listed: false });
  const handle = { openPassage, actions, get status() { return ui.status; } };
  active = handle;
  return handle;
}
