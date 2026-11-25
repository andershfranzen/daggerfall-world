// Shipyard window: ships for sale, your fleet, shipwright (refit, repair, stores), crew hall, port market and
// harbour board. Server rules: server/rpg/shipyard.js (state, prices and every check live there; this panel only
// shows the last `shipyard.status` the server sent and sends intent with a request id).
//
// UI contract (for the main UI / sailing controls):
//   PANEL_ID = 'shipyard'; install(api) registers the panel with api.registerPanel and listens for
//   `shipyard.status` / `shipyard` events. openYard(api) asks the server for status and opens the panel.
//   render(root) draws into any container (exported via install's return value).
// Styles are scoped to .syd-root and use the cool Bank & Repairs palette (.tsv-*), injected once.
export const PANEL_ID = 'shipyard';
const TITLE = 'Shipyard';
const TABS = Object.freeze([
  ['fleet', 'Your fleet'], ['buy', 'Ships for sale'], ['wright', 'Shipwright'], ['crew', 'Crew hall'], ['market', 'Market'], ['board', 'Harbour board'],
]);

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
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const requestId = () => `sy-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

const CSS = `
.syd-root{--syd-line:#34475a;--syd-dim:#93a4b6;--syd-ink:#dde5ee;--syd-accent:#8fb4d6;--syd-here:#1d2c3b;color:var(--syd-ink)}
.syd-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 12px;border-bottom:1px solid var(--syd-line)}
.syd-tab{background:none;border:1px solid transparent;border-bottom:none;color:var(--syd-dim);padding:6px 10px;cursor:pointer;font:inherit;letter-spacing:.04em}
.syd-tab[aria-selected="true"]{color:var(--syd-ink);border-color:var(--syd-line);background:var(--syd-here)}
.syd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.syd-card{border:1px solid var(--syd-line);padding:10px;background:#141c25}
.syd-card.is-active{border-color:var(--syd-accent)}
.syd-card h4{margin:0 0 4px;font-family:var(--serif,serif);font-weight:normal;font-size:1rem}
.syd-stats{display:grid;grid-template-columns:auto auto;gap:1px 10px;font-size:.8rem;color:var(--syd-dim);margin:6px 0;font-variant-numeric:tabular-nums}
.syd-stats dd{margin:0;color:var(--syd-ink);text-align:right}
.syd-table{width:100%;border-collapse:collapse;font-size:.85rem;font-variant-numeric:tabular-nums}
.syd-table th,.syd-table td{padding:4px 6px;border-bottom:1px solid #26323f;text-align:left}
.syd-table td.n,.syd-table th.n{text-align:right}
.syd-made{color:#9cc7a4}.syd-wanted{color:#d6c08f}
.syd-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px}
.syd-pick{margin-bottom:10px}
`;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('syd-css')) return;
  document.head.append(el('style', { id: 'syd-css' }, CSS));
}

export function openYard(api) {
  api.act('shipyard.status', {});
  api.openPanel?.(PANEL_ID);
}

export function install(api) {
  injectCss();
  const ui = { status: null, tab: 'fleet', ship: null, busy: false, timer: 0, qty: {} };
  let container = null;
  const isOpen = () => api.panel === PANEL_ID && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  const done = () => { ui.busy = false; clearTimeout(ui.timer); };
  const act = (verb, args = {}) => {
    if (ui.busy) return;
    ui.busy = true;
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => { ui.busy = false; rerender(); }, 4000);
    api.act(verb, { ...args, requestId: requestId() });
    rerender();
  };
  api.on('event', (ev) => {
    if (ev?.kind === 'shipyard.status') {
      ui.status = ev;
      done();
      if (!ev.fleet?.some((s) => s.id === ui.ship)) ui.ship = ev.active ?? ev.fleet?.[0]?.id ?? null;
      rerender();
    } else if (ev?.kind === 'shipyard') {
      // A ship bought, sold or made flagship changes what the quay offers (Board / Board and cast off): ask the
      // sailing core for a fresh ashore snapshot.
      api.act('sailing.sync', { harbour: true }, { quiet: true });
    } else if (ev?.kind === 'teleport' && isOpen()) api.act('shipyard.status', {});
  });
  api.on('message', (m) => { if (m?.kind === 'error' && ui.busy) { done(); rerender(); } });

  const btn = (label, onclick, disabled = false, title = null) => el('button', { type: 'button', class: 'tsv-btn', disabled: disabled || ui.busy, title, onclick }, label);
  const qtyInput = (key, label, def = 1) => el('input', {
    type: 'number', min: '1', step: '1', class: 'tsv-num', 'aria-label': label, value: ui.qty[key] ?? def,
    oninput: (e) => { ui.qty[key] = e.target.value; },
  });
  const qtyOf = (key, def = 1) => { const v = Math.trunc(Number(ui.qty[key] ?? def)); return v > 0 ? v : null; };
  const stats = (pairs) => el('dl', { class: 'syd-stats' }, pairs.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));
  const shipHere = () => (ui.status?.fleet ?? []).filter((s) => s.here);
  const selected = () => (ui.status?.fleet ?? []).find((s) => s.id === ui.ship) ?? null;

  function shipPicker(onlyHere = true) {
    const list = onlyHere ? shipHere() : ui.status?.fleet ?? [];
    if (!list.length) return el('p', { class: 'tsv-dim', text: onlyHere ? 'None of your ships is berthed here.' : 'You own no ships.' });
    if (!list.some((s) => s.id === ui.ship)) ui.ship = list[0].id;
    const sel = el('select', { class: 'tsv-num', 'aria-label': 'Ship', onchange: (e) => { ui.ship = e.target.value; rerender(); } },
      list.map((s) => el('option', { value: s.id, selected: s.id === ui.ship }, `${s.name} (${s.label})`)));
    return el('div', { class: 'syd-row syd-pick' }, el('span', { class: 'tsv-dim', text: 'Ship:' }), sel);
  }

  // ---------------------------------------------------------------- tabs

  function fleetTab() {
    const s = ui.status;
    if (!s.fleet.length) return el('p', { class: 'tsv-dim', text: 'You own no ships yet. A rowboat costs little and needs no crew: see Ships for sale.' });
    return el('div', { class: 'syd-grid' }, s.fleet.map((f) => el('article', { class: `syd-card${f.active ? ' is-active' : ''}` },
      el('h4', { text: f.name }),
      el('p', { class: 'tsv-dim tsv-small', text: `${f.label}${f.legacy ? ' · classic deed' : ''} · ${f.at === 'sea' ? 'at sea' : f.here ? 'berthed here' : `at ${f.portName ?? 'anchor'}`}` }),
      stats([
        ['Hull', `${f.hullHp} / ${f.stats.hullMax}`], ['Sails', f.stats.sailMax ? `${f.sailHp} / ${f.stats.sailMax}` : 'oars'],
        ['Crew', `${f.crew.length} / ${f.stats.crewMax} (min ${f.stats.crewMin})`], ['Guns', f.stats.guns],
        ['Cargo', `${f.cargoUsed} / ${f.stats.capacity}`], ['Provisions', f.stores.provisions], ['Shot', f.stores.shot], ['Timber', f.stores.timber],
        ['Wages', `${f.wages} / day`], ['Worth', `${fmt(f.salePrice)} gold`],
      ]),
      f.canSail ? el('p', { class: 'tsv-dim tsv-small', text: f.canSail }) : el('p', { class: 'tsv-ok tsv-small', text: 'Ready to sail.' }),
      el('div', { class: 'syd-row' },
        f.active ? null : btn('Make flagship', () => act('shipyard.activate', { shipId: f.id })),
        btn('Rename', () => {
          const n = globalThis.prompt?.('New name for her stern board', f.name);
          if (n) act('shipyard.rename', { shipId: f.id, name: n });
        }),
        f.here ? btn(`Sell ${fmt(f.salePrice)}`, () => { if (globalThis.confirm?.(`Sell ${f.name} for ${fmt(f.salePrice)} gold?`) !== false) act('shipyard.sell', { shipId: f.id }); }, !s.port) : null))));
  }

  function buyTab() {
    const s = ui.status;
    return el('div', { class: 'syd-grid' }, s.hulls.map((h) => el('article', { class: 'syd-card' },
      el('h4', { text: h.label }), el('p', { class: 'tsv-dim tsv-small', text: h.line }),
      stats([['Price', `${fmt(h.price)} gold`], ['Crew', `${h.crewMin}–${h.crewMax}`], ['Guns', h.guns], ['Hold', h.capacity], ['Hull', h.hullMax], ['Speed', h.speed]]),
      el('div', { class: 'syd-row' }, btn(s.gold >= h.price ? `Buy for ${fmt(h.price)}` : `Need ${fmt(h.price)}`,
        () => act('shipyard.buy', { hull: h.id, expectPrice: h.price }), !s.port || s.gold < h.price)))));
  }

  function wrightTab() {
    const f = selected();
    const wrap = el('div', {}, shipPicker());
    if (!f || !f.here) return wrap;
    const rq = f.repair;
    const repairAll = rq.hull.gold + rq.sail.gold;
    wrap.append(el('h3', { class: 'tsv-h4', text: 'Repairs' }),
      el('div', { class: 'syd-row' },
        btn(`Hull ${rq.hull.points ? `(${fmt(rq.hull.gold)})` : '— sound'}`, () => act('shipyard.repair', { shipId: f.id, part: 'hull', expectPrice: rq.hull.gold }), !rq.hull.gold),
        btn(`Sails ${rq.sail.points ? `(${fmt(rq.sail.gold)})` : '— sound'}`, () => act('shipyard.repair', { shipId: f.id, part: 'sail', expectPrice: rq.sail.gold }), !rq.sail.gold),
        btn(`All (${fmt(repairAll)})`, () => act('shipyard.repair', { shipId: f.id, part: 'all', expectPrice: repairAll }), !repairAll)));
    wrap.append(el('h3', { class: 'tsv-h4', text: 'Stores' }), el('table', { class: 'syd-table' },
      el('tr', {}, el('th', { text: 'Store' }), el('th', { class: 'n', text: 'Aboard' }), el('th', { class: 'n', text: 'Price' }), el('th', {})),
      ui.status.stores.map((k) => {
        const cap = f.stats.stores[k.id];
        return el('tr', {}, el('td', { title: k.text, text: k.label }), el('td', { class: 'n', text: `${f.stores[k.id]} / ${cap}` }), el('td', { class: 'n', text: k.price }),
          el('td', {}, cap ? el('span', { class: 'syd-row' }, qtyInput(`st-${k.id}`, `${k.label} to buy`, Math.max(1, Math.min(cap - f.stores[k.id], 10))),
            btn('Buy', () => act('shipyard.supply', { shipId: f.id, store: k.id, qty: qtyOf(`st-${k.id}`, 10) }), f.stores[k.id] >= cap)) : '—'));
      })));
    wrap.append(el('h3', { class: 'tsv-h4', text: 'Refits' }), el('table', { class: 'syd-table' },
      ui.status.refitLines.map((l) => {
        const cost = f.refitCosts[l.id];
        const tier = f.refits[l.id];
        return el('tr', {}, el('td', { title: l.text, text: l.label }), el('td', { class: 'n', text: `${tier} / ${l.tiers}` }),
          el('td', {}, cost == null ? el('span', { class: 'tsv-dim', text: tier >= l.tiers ? 'Finest' : 'Not on this hull' })
            : btn(`Refit ${fmt(cost)}`, () => act('shipyard.refit', { shipId: f.id, line: l.id, expectPrice: cost }), tier >= l.tiers)));
      })));
    const bigger = ui.status.hulls.filter((h) => h.price > (ui.status.hulls.find((x) => x.id === f.hull)?.price ?? 0) && !h.classic);
    if (!f.legacy && bigger.length) {
      wrap.append(el('h3', { class: 'tsv-h4', text: 'Rebuild as a larger class' }), el('div', { class: 'syd-row' }, bigger.map((h) => {
        const cost = Math.max(0, h.price - f.salePrice);
        return btn(`${h.label} (${fmt(cost)})`, () => act('shipyard.reclass', { shipId: f.id, hull: h.id, expectPrice: cost }), ui.status.gold < cost);
      })));
    }
    return wrap;
  }

  function crewTab() {
    const f = selected();
    const wrap = el('div', {}, shipPicker());
    if (!f || !f.here) return wrap;
    const others = shipHere().filter((s) => s.id !== f.id);
    wrap.append(el('h3', { class: 'tsv-h4', text: `Aboard ${f.name} (${f.crew.length} / ${f.stats.crewMax})` }),
      f.crew.length ? el('table', { class: 'syd-table' }, f.crew.map((h) => el('tr', {},
        el('td', { text: h.name }),
        el('td', {}, el('select', { class: 'tsv-num', 'aria-label': `Post for ${h.name}`, disabled: ui.busy, onchange: (e) => act('shipyard.assign', { shipId: f.id, handId: h.id, role: e.target.value }) },
          ['Mate', 'Bosun', 'Gunner', 'Carpenter', 'Lookout', 'Cook', 'Deckhand'].map((r) => el('option', { value: r, selected: r === h.role }, r)))),
        el('td', { class: 'n', text: `${h.wage}/day` }), el('td', { class: 'n', text: `morale ${h.morale}` }),
        el('td', {}, others.map((o) => btn(`To ${o.name}`, () => act('shipyard.assign', { shipId: f.id, handId: h.id, toShipId: o.id }))),
          btn('Dismiss', () => act('shipyard.dismiss', { shipId: f.id, handId: h.id })))))) : el('p', { class: 'tsv-dim', text: 'No hands aboard.' }));
    wrap.append(el('h3', { class: 'tsv-h4', text: 'Sailors looking for a berth' }),
      ui.status.recruits.length ? el('table', { class: 'syd-table' }, ui.status.recruits.map((r) => el('tr', {},
        el('td', { text: r.name }), el('td', { text: r.role }), el('td', { class: 'n', text: `${r.wage}/day` }),
        el('td', {}, btn(`Sign on (${fmt(r.fee)})`, () => act('shipyard.hire', { shipId: f.id, recruitId: r.id }), f.crew.length >= f.stats.crewMax || ui.status.gold < r.fee))))) : el('p', { class: 'tsv-dim', text: 'Nobody else is looking for a berth today.' }));
    return wrap;
  }

  function marketTab() {
    const f = selected();
    const wrap = el('div', {}, shipPicker());
    if (!f || !f.here) return wrap;
    const held = (id) => f.cargo.find((c) => c.good === id)?.qty ?? 0;
    wrap.append(el('p', { class: 'tsv-dim tsv-small', text: `Hold ${f.cargoUsed} / ${f.stats.capacity}. Green: made here (cheap). Gold: wanted here (dear).` }),
      el('table', { class: 'syd-table' },
        el('tr', {}, el('th', { text: 'Goods' }), el('th', { class: 'n', text: 'Buy' }), el('th', { class: 'n', text: 'Sell' }), el('th', { class: 'n', text: 'Aboard' }), el('th', {})),
        ui.status.market.map((m) => el('tr', {},
          el('td', { class: m.stand === 'made' ? 'syd-made' : m.stand === 'wanted' ? 'syd-wanted' : null, text: m.label }),
          el('td', { class: 'n', text: `${m.buy} (${m.stock})` }), el('td', { class: 'n', text: `${m.sell} (${m.demand})` }), el('td', { class: 'n', text: held(m.id) }),
          el('td', {}, el('span', { class: 'syd-row' }, qtyInput(`mk-${m.id}`, `${m.label} quantity`, 5),
            btn('Buy', () => act('shipyard.trade', { shipId: f.id, good: m.id, qty: qtyOf(`mk-${m.id}`, 5), side: 'buy', expectPrice: m.buy }), !m.stock),
            btn('Sell', () => act('shipyard.trade', { shipId: f.id, good: m.id, qty: qtyOf(`mk-${m.id}`, 5), side: 'sell', expectPrice: m.sell }), !held(m.id) || !m.demand)))))));
    return wrap;
  }

  function boardTab() {
    const s = ui.status;
    const f = selected();
    const wrap = el('div', {});
    if (s.contracts.length) {
      wrap.append(el('h3', { class: 'tsv-h4', text: 'Your consignments' }), el('table', { class: 'syd-table' }, s.contracts.map((c) => el('tr', {},
        el('td', { text: `${c.kind} → ${c.toName}` }), el('td', { class: 'n', text: `${c.units} units` }), el('td', { class: 'n', text: `${fmt(c.pay)} gold` }),
        el('td', { text: c.overdue ? 'overdue: half pay' : 'on time' }),
        el('td', {}, btn('Abandon', () => { if (globalThis.confirm?.('Abandon this consignment? You will not be paid.') !== false) act('shipyard.contract.abandon', { contractId: c.id }); }))))));
    }
    wrap.append(shipPicker());
    wrap.append(el('h3', { class: 'tsv-h4', text: 'Notices on the harbour board' }),
      s.board.length ? el('table', { class: 'syd-table' }, s.board.map((o) => el('tr', {},
        el('td', { text: `${o.kind} to ${o.toName}` }), el('td', { class: 'n', text: `${o.units} units` }), el('td', { class: 'n', text: `${o.leagues} leagues` }),
        el('td', { class: 'n', text: `${o.days} days` }), el('td', { class: 'n', text: `${fmt(o.pay)} gold` }),
        el('td', {}, btn('Take', () => act('shipyard.contract.take', { shipId: f?.id, offerId: o.id }), !f?.here || f.stats.capacity - f.cargoUsed < o.units))))) : el('p', { class: 'tsv-dim', text: 'No notices today.' }));
    return wrap;
  }

  // ---------------------------------------------------------------- render

  function render(root) {
    container = root;
    const wrap = el('div', { class: 'tsv-root syd-root' });
    root.replaceChildren(wrap);
    const s = ui.status;
    if (!s) {
      wrap.append(el('p', { class: 'tsv-dim', text: 'Asking the harbourmaster…' }));
      api.act('shipyard.status', {});
      return;
    }
    wrap.append(el('header', { class: 'tsv-head' },
      el('div', {}, el('h2', { class: 'tsv-h', text: s.port ? `Shipyard of ${s.port.name}` : TITLE }),
        el('p', { class: 'tsv-dim', text: s.port ? 'Ships, refits, crew, cargo and contracts.' : s.refusal })),
      el('dl', { class: 'tsv-purse' }, el('dt', { text: 'Gold (with letters)' }), el('dd', { text: fmt(s.gold) }))));
    const tabs = s.port ? TABS : TABS.filter(([id]) => id === 'fleet' || id === 'board');
    if (!tabs.some(([id]) => id === ui.tab)) ui.tab = 'fleet';
    wrap.append(el('div', { class: 'syd-tabs', role: 'tablist' }, tabs.map(([id, label]) => el('button', {
      type: 'button', role: 'tab', class: 'syd-tab', 'aria-selected': String(ui.tab === id), onclick: () => { ui.tab = id; rerender(); },
    }, label))));
    const body = { fleet: fleetTab, buy: buyTab, wright: wrightTab, crew: crewTab, market: marketTab, board: boardTab }[ui.tab]();
    wrap.append(el('div', { role: 'tabpanel' }, body));
  }

  api.registerPanel?.(PANEL_ID, TITLE, (root) => render(root));
  let wasOpen = false;
  api.on('panel', (d) => {
    const open = !!d?.open && d.id === PANEL_ID;
    if (open && !wasOpen) api.act('shipyard.status', {});
    wasOpen = open;
  });
  return { render, open: () => openYard(api), status: () => ui.status };
}
