// Property & Transport panel: loans, houses, ships, the wagon and owned storage (backlog package 13).
// Server rules: server/rpg/property.js. Shared formulas: ./property/rules.js. Documentation: docs/property.md.
//
// Bank controls appear only while the player stands at a bank counter (the same counters and reach as the
// Bank & Repairs panel). Storage lists only the stores the server says are reachable now. Every button
// sends intent with a request id; the server re-validates reach, prices, balances and weight.
import { DOOR_REACH, placeOf, regionKey } from './townServices/rules.js';
import { LOAN_MIN, MINUTES_PER_MONTH, SHIPS, deedSellPrice, loanRepayment, maxLoan, storedWeight } from './property/rules.js';
import { itemIcon } from './inventory/icons.js';

export const PANEL_ID = 'property';
const TITLE = 'Property & Transport';

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
const requestId = () => `pr-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

export function install(api) {
  const ui = { counters: [], status: null, busy: false, busyTimer: 0, amounts: { loan: '', repay: '' }, clock: null };
  let container = null;
  const ch = () => api.state?.character ?? null;
  const prop = () => ch()?.property ?? { loans: {}, houses: {}, ship: null, stores: {} };
  const isOpen = () => api.panel === PANEL_ID && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  const pos = () => (api.camera && Number.isFinite(api.camera.x) ? { x: api.camera.x, z: api.camera.z } : null);

  function bankHere() {
    const place = placeOf(ch()?.location ?? '');
    if (!place) return null;
    for (const c of ui.counters) {
      if (!c.services?.includes('bank')) continue;
      if (place.kind === 'interior' && c.id === place.counterId) return c;
      const p = pos();
      if (place.kind === 'town' && p && (c.doors || []).some((d) => Math.hypot(d.x - p.x, d.z - p.z) <= DOOR_REACH - 0.1)) return c;
    }
    return null;
  }

  const act = (verb, args = {}) => {
    if (ui.busy) return;
    ui.busy = true;
    clearTimeout(ui.busyTimer);
    ui.busyTimer = setTimeout(() => { ui.busy = false; rerender(); }, 4000);
    api.act(verb, { ...args, requestId: requestId() });
    rerender();
  };
  const done = () => { ui.busy = false; clearTimeout(ui.busyTimer); };
  const refresh = () => api.act('property.status', {});

  api.on('state', () => { done(); rerender(); });
  api.on('message', (m) => { if (m?.kind === 'error' && ui.busy) { done(); rerender(); } });
  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'townServices.counters') {
      ui.counters = Array.isArray(ev.counters) ? ev.counters : [];
      rerender();
    } else if (ev.kind === 'property.status') {
      ui.status = ev;
      ui.clock = Number.isFinite(ev.clock) ? ev.clock : ui.clock;
      rerender();
    } else if (ev.kind === 'property') {
      done(); // client/main.js already shows ev.text
      if (isOpen()) refresh();
    } else if (ev.kind === 'teleport' && isOpen()) refresh();
  });

  const button = (label, onclick, disabled = false) => el('button', { type: 'button', class: 'tsv-btn', disabled: disabled || ui.busy, onclick }, label);
  const numberInput = (key, label) => el('input', {
    type: 'number', min: '1', step: '1', inputmode: 'numeric', 'aria-label': label, class: 'tsv-num', value: ui.amounts[key],
    oninput: (e) => { ui.amounts[key] = e.target.value; },
  });
  const amountOf = (key) => { const v = Number(ui.amounts[key]); return Number.isInteger(v) && v > 0 ? v : null; };

  function render(root) {
    container = root;
    root.replaceChildren();
    const wrap = el('div', { class: 'tsv-root' });
    root.append(wrap);
    const c = ch();
    if (!c) { wrap.append(el('p', { class: 'tsv-dim', text: 'Join the world to manage property.' })); return; }
    const place = placeOf(c.location);
    const bank = bankHere();
    wrap.append(el('header', { class: 'tsv-head' },
      el('div', {}, el('h2', { class: 'tsv-h', text: TITLE }),
        el('p', { class: 'tsv-dim', text: bank ? `At ${bank.name}, ${place.region}.` : 'Stand at a bank door for loans, deeds and ships.' })),
      el('dl', { class: 'tsv-purse' }, el('dt', { text: 'Gold carried' }), el('dd', { text: String(c.gold ?? 0) }),
        el('dt', { text: 'Account here' }), el('dd', { text: place ? String(c.townServices?.accounts?.[regionKey(place.region)]?.gold ?? 0) : '—' }))));
    const cols = el('div', { class: 'tsv-cols' });
    cols.append(bankSection(bank, place), transportSection());
    const homesShortcut = api.getPanel?.('homes')
      ? el('div', { class: 'tsv-row' },
        button('Personal Homes (Furnishing, Guests & Chests)', () => api.openPanel('homes')),
        api.getPanel?.('market') ? button('Player Market Board', () => api.openPanel('market')) : null)
      : null;
    wrap.append(homesShortcut, cols, storesSection());
  }

  function bankSection(bank, place) {
    const p = prop();
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Loans and deeds' }, el('h3', { class: 'tsv-h4', text: 'Loans and deeds' }));
    const loans = Object.values(p.loans || {});
    if (loans.length) {
      sec.append(el('ul', { class: 'tsv-list' }, loans.map((l) => el('li', {},
        `${l.region}: ${l.total} gold owed`,
        el('span', { class: 'tsv-dim', text: l.defaulted ? ' · defaulted' : ui.clock != null && l.due ? ` · due in ${Math.max(1, Math.ceil((l.due - ui.clock) / MINUTES_PER_MONTH))} month(s)` : '' })))));
    } else sec.append(el('p', { class: 'tsv-dim tsv-small', text: 'No loans.' }));
    if (bank) {
      const key = regionKey(place.region);
      const loan = p.loans?.[key];
      const level = ch().character?.level ?? 1;
      if (!loan?.total && !loan?.defaulted) {
        sec.append(el('form', { class: 'tsv-row', onsubmit: (e) => { e.preventDefault(); const a = amountOf('loan'); if (a) act('bank.loan', { counterId: bank.id, amount: a }); } },
          numberInput('loan', 'Amount to borrow'), el('button', { type: 'submit', class: 'tsv-btn', disabled: ui.busy }, 'Borrow'),
          el('span', { class: 'tsv-dim tsv-small', text: `${LOAN_MIN}–${maxLoan(level)} gold; repay ${amountOf('loan') ? loanRepayment(amountOf('loan')) : '+10%'} within a year` })));
      }
      if (loan?.total) {
        sec.append(el('form', { class: 'tsv-row', onsubmit: (e) => { e.preventDefault(); const a = amountOf('repay'); if (a) act('bank.repay', { counterId: bank.id, amount: a }); } },
          numberInput('repay', 'Amount to repay'), el('button', { type: 'submit', class: 'tsv-btn', disabled: ui.busy }, 'Repay'),
          button(`Repay all (${loan.total})`, () => act('bank.repay', { counterId: bank.id, amount: loan.total }))));
      }
      const house = p.houses?.[key];
      sec.append(el('h4', { class: 'tsv-h5', text: 'Houses' }));
      if (house) {
        sec.append(el('p', { class: 'tsv-small', text: `You own a house in ${placeOf(house.town)?.location ?? house.region}.` }),
          el('div', { class: 'tsv-row' }, button(`Sell for ${deedSellPrice(house.price)}`, () => act('house.sell', { counterId: bank.id }))));
      } else {
        const offers = ui.status?.offers?.houses ?? [];
        if (!offers.length) sec.append(el('p', { class: 'tsv-dim tsv-small', text: ui.status ? 'No houses for sale here this month.' : 'Loading…' }));
        sec.append(el('ul', { class: 'tsv-list' }, offers.map((h) => el('li', {}, `${h.buildingType === 1 ? 'House for sale' : 'Residence'} ${h.id}`,
          el('span', { class: 'tsv-dim', text: ` ${h.price} gold ` }),
          button('Buy', () => act('house.buy', { counterId: bank.id, houseId: h.id, expectPrice: h.price }))))));
      }
      sec.append(el('h4', { class: 'tsv-h5', text: 'Ships' }));
      if (p.ship) {
        sec.append(el('div', { class: 'tsv-row' }, button(`Sell ${SHIPS[p.ship.type].label.toLowerCase()} for ${deedSellPrice(SHIPS[p.ship.type].price)}`, () => act('ship.sell', { counterId: bank.id }))));
      } else if (ui.status?.offers?.port) {
        sec.append(el('div', { class: 'tsv-row' }, Object.values(SHIPS).map((s) => button(`${s.label}: ${s.price}`, () => act('ship.buy', { counterId: bank.id, type: s.type, expectPrice: s.price })))));
      } else sec.append(el('p', { class: 'tsv-dim tsv-small', text: 'Ships are sold only in port towns.' }));
    }
    return sec;
  }

  function transportSection() {
    const p = prop();
    const s = ui.status;
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Transport' }, el('h3', { class: 'tsv-h4', text: 'Transport' }));
    const inv = ch().inventory ?? [];
    const has = (t) => inv.some((i) => i.template === t);
    sec.append(el('ul', { class: 'tsv-list' },
      el('li', {}, has('horse') ? 'Horse: ride with the mount control outdoors.' : 'No horse.'),
      el('li', {}, has('small-cart') ? `Small cart: wagon storage, cart travel rate; drive it outdoors with the mount control${has('horse') ? '' : ' (H)'}.` : 'No cart. General stores sell one.'),
      el('li', {}, p.ship ? `${SHIPS[p.ship.type].label}: free sea passage.` : 'No ship.')));
    if (p.ship) {
      sec.append(el('div', { class: 'tsv-row' }, s?.onShip ? button('Go ashore', () => act('ship.leave')) : button('Board your ship', () => act('ship.board'))));
    }
    if (api.panels().some((panel) => panel.id === 'sailing')) {
      sec.append(button('Harbour and sailing', () => api.openPanel('sailing')));
    }
    if (has('small-cart') && has('horse')) {
      // DaggerfallTransportWindow offers the cart beside the horse.
      const riding = ch().mount?.riding === true;
      sec.append(el('div', { class: 'tsv-row' }, riding ? button('Get down', () => act('mount.ride', { on: false }))
        : button('Drive the cart', () => act('mount.ride', { on: true, mode: 'cart' }))));
    }
    return sec;
  }

  function storesSection() {
    const p = prop();
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Storage' }, el('h3', { class: 'tsv-h4', text: 'Storage' }));
    const stores = ui.status?.stores ?? [];
    if (!stores.length) {
      sec.append(el('p', { class: 'tsv-dim tsv-small', text: ui.status?.wagon?.refusal ?? 'Your wagon, house or ship hold appears here when you can reach it.' }));
      return sec;
    }
    const inv = (ch().inventory ?? []).filter((i) => !i.equipped && !i.quest);
    for (const s of stores) {
      const items = p.stores?.[s.id] ?? [];
      const box = el('div', { class: 'tsv-store' }, el('h4', { class: 'tsv-h5', text: `${s.name}${s.limitKg ? ` (${storedWeight(items)} / ${s.limitKg} kg)` : ''}` }));
      box.append(el('ul', { class: 'tsv-list tsv-items' }, items.map((r) => el('li', {},
        el('span', { class: 'tsv-name' }, itemIcon(api, r), r.template === 'gold' ? `${r.quantity} gold` : `${r.quantity > 1 ? `${r.quantity} × ` : ''}${r.name}`),
        button('Take', () => act('property.take', { container: s.id, itemId: r.template === 'gold' ? 'gold' : r.id, quantity: r.quantity }))))));
      const pick = el('select', { class: 'tsv-num', 'aria-label': `Item to put in ${s.name}` },
        el('option', { value: '' }, 'Put…'), ch().gold > 0 ? el('option', { value: 'gold' }, `${ch().gold} gold`) : null,
        inv.map((i) => el('option', { value: i.id }, `${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.name}`)));
      box.append(el('div', { class: 'tsv-row' }, pick, button('Put', () => {
        const id = pick.value;
        if (!id) return;
        const it = inv.find((i) => i.id === id);
        act('property.store', { container: s.id, itemId: id, quantity: id === 'gold' ? ch().gold : it?.quantity ?? 1 });
      })));
      sec.append(box);
    }
    return sec;
  }

  let wasOpen = false;
  api.on('panel', (d) => {
    const open = !!d?.open && d.id === PANEL_ID;
    if (open && !wasOpen) { api.act('town.services', {}); refresh(); }
    wasOpen = open;
  });
  api.registerPanel(PANEL_ID, TITLE, (root) => render(root));
  return { bankHere };
}
