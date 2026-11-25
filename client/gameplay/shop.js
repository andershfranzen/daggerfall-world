// Shop shelves in the browser (server/rpg/economy.js, docs/shops-and-economy.md).
//
// Inside a shop the server lists its shelves (`shop.shelves`). Facing a shelf within reach, G browses it
// (`shop.shelf`), and the "Shelf" page lists what is on it with the classic price for this character in this shop and
// region. As in the classic trade window, goods are picked into a basket at the shelf (`shop.pick`), can be put back
// (`shop.unpick`) and are paid for at the counter (`shop.pay`), or carried off unpaid (`shop.steal`, package 14).
// Leaving the shop puts unpaid goods back. The server re-checks reach, stock, price and the basket's revision.

import { itemIcon, getItemArtSource } from './inventory/icons.js';
import { marketNote } from './economy/rules.js';

const PANEL = 'shop';
const REACH = 1.6; // a little inside the server's 1.75 m
const CONE = 0.75; // radians either side of the view direction

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-shop-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./shop.css', import.meta.url).href;
  link.dataset.shopCss = '';
  document.head.append(link);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

export function install(api) {
  loadStyles();
  getItemArtSource(api);
  const ui = { shelves: null, view: null, basket: null, busy: false, qty: new Map(), hinted: new Set() };
  let container = null;
  const isOpen = () => api.panel === PANEL && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  const location = () => api.state?.character?.location ?? api.location;

  /** The shelf in front of the player within reach, or null. */
  function facingShelf() {
    const cam = api.camera;
    if (!ui.shelves || ui.shelves.location !== location() || !cam || !Number.isFinite(cam.x)) return null;
    let best = null, bestScore = Infinity;
    for (const s of ui.shelves.shelves) {
      const dx = s.x - cam.x, dz = s.z - cam.z;
      const dist = Math.hypot(dx, dz);
      if (dist > s.r + REACH) continue;
      let off = Math.atan2(dx, -dz) - cam.yaw;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (dist > s.r && Math.abs(off) > CONE) continue;
      const score = Math.abs(off) + dist * 0.2;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  function browse(shelf) {
    ui.busy = true;
    api.act('shop.shelf', { shelf: shelf.shelf });
  }

  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'shop.shelves') {
      ui.shelves = ev;
      if (ev.shelves.length && !ui.hinted.has(ev.location)) {
        ui.hinted.add(ev.location);
        api.message?.(`${ev.shop ?? 'This shop'} has ${ev.shelves.length} shel${ev.shelves.length === 1 ? 'f' : 'ves'}. Face one and press G to browse it.`);
      }
    } else if (ev.kind === 'shop.shelf') {
      ui.busy = false;
      ui.view = ev; // its `text` is shown by the shell's event notices
      if (api.panel !== PANEL) api.openPanel(PANEL);
      else rerender();
    } else if (ev.kind === 'shop.closed') {
      if (ui.view?.location === ev.location) ui.view = null;
      rerender();
    } else if (ev.kind === 'shop.basket') {
      ui.busy = false;
      ui.basket = ev.lines?.length ? ev : null;
      rerender();
    }
  });
  api.on('message', (m) => { if (m?.kind === 'error' && ui.busy) { ui.busy = false; rerender(); } });
  // Ask for the shelves of every building entered (also after a reconnect inside one).
  let asked = null;
  const ask = () => {
    const loc = location();
    if (!loc || asked === loc || ui.shelves?.location === loc) return;
    asked = loc;
    if (String(loc).startsWith('interior:')) {
      api.act('shop.shelves', {});
      api.act('shop.basket', {}); // a reconnect inside a shop finds its unpaid goods
    }
  };
  api.on('location', () => {
    if (ui.view && ui.view.location !== location()) ui.view = null;
    if (ui.basket && ui.basket.location !== location()) ui.basket = null;
    ask();
  });
  api.on('state', () => {
    ask();
    rerender();
  });

  // G at a shelf. A person in the crosshair (the shopkeeper) keeps priority.
  api.on('interactIntent', (d) => {
    if (d?.handled || d?.entity) return;
    const shelf = facingShelf();
    if (!shelf) return;
    d.preventDefault?.();
    browse(shelf);
  });

  function render(root) {
    container = root;
    root.replaceChildren();
    const v = ui.view;
    const wrap = el('div', { class: 'shop-root' });
    root.append(wrap);
    if (!v || v.location !== location()) {
      const near = facingShelf();
      wrap.append(el('p', { class: 'shop-empty', text: ui.shelves?.location === location()
        ? 'Face a shelf and press G to see what is on it.' : 'Shop shelves are inside shops. Walk to one and press G.' }));
      if (near) wrap.append(el('button', { type: 'button', class: 'btn', onclick: () => browse(near) }, `Browse shelf ${near.shelf}`));
      basketBox(wrap);
      return;
    }
    const gold = api.state?.character?.gold ?? v.gold ?? 0;
    wrap.append(el('div', { class: 'shop-head' },
      el('strong', { text: `${ui.shelves?.shop ?? 'Shop'} · shelf ${v.shelf}` }),
      el('span', { class: 'shop-meta', text: [v.quality ? `quality ${v.quality}` : null, `${gold} gold`].filter(Boolean).join(' · ') })));
    const note = [v.market?.note ?? marketNote(v.market?.adjust ?? 1000), v.market?.holiday ? `Holiday: ${v.market.holiday.replace(/-/g, ' ')}.` : null].filter(Boolean).join(' ');
    if (note) wrap.append(el('p', { class: 'shop-note', text: note }));
    if (!v.keeper) {
      wrap.append(el('p', { class: 'shop-empty', text: v.text ?? 'Nobody is minding the shop.' }));
      return;
    }
    const ul = el('ul', { class: 'shop-list', 'aria-label': `Shelf ${v.shelf}` });
    for (const it of v.items) {
      const key = it.key;
      const max = Math.max(1, Math.min(it.quantity, 99, Math.floor(gold / Math.max(1, it.price)) || 1));
      const qty = Math.min(max, ui.qty.get(key) ?? 1);
      const afford = it.price <= gold;
      const input = it.quantity > 1 ? el('input', {
        type: 'number', class: 'shop-qty', min: 1, max, value: qty, 'aria-label': `Quantity of ${it.name}`,
        oninput: (e) => ui.qty.set(key, Math.max(1, Math.min(max, Math.trunc(Number(e.target.value)) || 1))),
      }) : el('span');
      ul.append(el('li', { class: `shop-row${afford ? '' : ' shop-poor'}` },
        el('span', { class: 'shop-item' }, itemIcon(api, it), it.name),
        el('span', { class: 'shop-num', text: `×${it.quantity}` }),
        el('span', { class: 'shop-price', text: `${it.price} g` }),
        input,
        el('button', {
          type: 'button', class: 'btn btn-small', disabled: ui.busy,
          onclick: () => {
            ui.busy = true;
            api.act('shop.pick', { shelf: v.shelf, key, quantity: Math.min(it.quantity, 99, ui.qty.get(key) ?? 1), price: it.price });
            rerender();
          },
        }, 'Take')));
    }
    if (!v.items.length) ul.append(el('li', { class: 'shop-empty', text: 'This shelf is empty.' }));
    wrap.append(ul, el('p', { class: 'shop-hint', text: `${v.keeper.name} minds the shop. Take goods to your basket and pay at the counter. Prices follow the shop’s quality, your Mercantile and Personality, and the region’s market.` }));
    basketBox(wrap);
  }

  /** The player's own unpaid goods: put back, pay at the counter, or walk off with them. */
  function basketBox(wrap) {
    const b = ui.basket;
    if (!b || b.location !== location() || !b.lines?.length) return;
    const gold = api.state?.character?.gold ?? b.gold ?? 0;
    const ul = el('ul', { class: 'shop-list shop-basket-list', 'aria-label': 'Basket' });
    for (const l of b.lines) {
      ul.append(el('li', { class: 'shop-row' },
        el('span', { class: 'shop-item' }, itemIcon(api, l), l.name, el('small', { class: 'shop-shelf', text: ` · shelf ${l.shelf}` })),
        el('span', { class: 'shop-num', text: `×${l.quantity}` }),
        el('span', { class: 'shop-price', text: l.price != null ? `${l.price} g` : '' }),
        el('span'),
        el('button', {
          type: 'button', class: 'btn btn-small', disabled: ui.busy,
          onclick: () => { ui.busy = true; api.act('shop.unpick', { key: l.key }); rerender(); },
        }, 'Put back')));
    }
    wrap.append(el('section', { class: 'shop-basket', 'aria-label': 'Your basket' },
      el('div', { class: 'shop-head' }, el('strong', { text: `Your basket · ${b.count} item${b.count === 1 ? '' : 's'}` }),
        el('span', { class: 'shop-meta', text: `${b.total} g to pay · ${gold} gold` })),
      ul,
      el('div', { class: 'shop-actions' },
        el('button', {
          type: 'button', class: 'btn btn-primary', disabled: ui.busy || !b.keeper || b.total > gold,
          onclick: () => { ui.busy = true; api.act('shop.pay', { basket: b.basket, seq: b.seq, total: b.total }); rerender(); },
        }, b.keeper ? `Pay ${b.keeper.name} ${b.total} g` : 'Pay'),
        el('button', {
          type: 'button', class: 'btn shop-steal', disabled: ui.busy,
          onclick: () => { ui.busy = true; api.act('shop.steal', { basket: b.basket, seq: b.seq }); rerender(); },
        }, 'Steal')),
      el('p', { class: 'shop-hint', text: 'Pay at the counter. Unpaid goods go back on the shelves if you leave the shop.' })));
  }

  api.registerPanel(PANEL, 'Shelf', (root) => render(root));
}
