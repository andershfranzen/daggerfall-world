// Alchemy & Enchanting panel: Potion Maker, potion / soul gem / magic item merchants, Item Maker and
// Mages Guild identification (server: server/rpg/alchemy.js, package 16).
//
// The server opens the panel with an `alchemyPanel` event when the player picks one of these services
// in a conversation (npc.service) or sends alchemy.open. Every button sends intent; the server
// re-validates distance, rank, gold, ingredients and enchantment power.
import { itemIcon, getItemArtSource } from './inventory/icons.js';

export const PANEL_ID = 'alchemy';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-alchemy-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./alchemy.css', import.meta.url).href;
  link.dataset.alchemyCss = '';
  document.head.append(link);
}

const label = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2');

/** Item Maker running totals, mirrored from the server rules for display only. */
export function makerTotals(selection, power) {
  const cost = selection.reduce((n, s) => n + s.cost, 0);
  const gold = 10 * selection.filter((s) => s.cost > 0 || s.type === 15).reduce((n, s) => n + Math.max(0, s.cost), 0);
  return { cost, gold, power, over: cost > power };
}

export function install(api) {
  if (typeof document === 'undefined') return;
  loadStyles();
  getItemArtSource(api);
  const ui = { panel: null, cauldron: [], item: null, picks: [], name: '', type: null, busy: false };
  let container = null;
  const isOpen = () => api.panel === PANEL_ID && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  const counterArgs = () => ({ targetId: ui.panel.npcId, ...(ui.panel.session ? { session: ui.panel.session } : {}) });
  const act = async (verb, args) => {
    if (ui.busy) return;
    ui.busy = true;
    rerender();
    await api.act(verb, { ...counterArgs(), ...args });
    ui.busy = false;
    rerender();
  };

  api.on('event', (ev) => {
    if (ev?.kind === 'alchemyPanel') {
      const switched = ui.panel?.service !== ev.service || ui.panel?.npcId !== ev.npcId;
      ui.panel = ev;
      if (switched) Object.assign(ui, { cauldron: [], item: null, picks: [], name: '', type: null });
      ui.cauldron = ui.cauldron.filter((id) => ev.ingredients?.some((i) => i.id === id));
      if (ui.item && !ev.items?.some((i) => i.id === ui.item)) Object.assign(ui, { item: null, picks: [], name: '' });
      if (api.panel !== PANEL_ID) api.openPanel(PANEL_ID);
      rerender();
    } else if (ev?.kind === 'alchemy') {
      if (ev.text) api.message(ev.text);
    }
  });
  // No re-render on every snapshot: the server sends a fresh `alchemyPanel` after each change.
  api.on('assets', rerender);

  function potionMaker(p) {
    const recipes = el('div', { class: 'alc-recipes' },
      el('h3', { text: 'Recipes' }),
      p.recipes.length ? p.recipes.map((r) => el('button', {
        class: 'alc-chip', type: 'button', disabled: ui.busy,
        title: r.ingredients.map((i) => (i.template ?? `#${i.index}`).replace(/-/g, ' ')).join(', '),
        onclick: () => act('alchemy.brew', { recipe: r.key }),
      }, r.name)) : el('p', { class: 'alc-dim', text: 'You know no recipes yet. Read a potion recipe, or discover one by mixing.' }));
    const list = el('ul', { class: 'alc-list', role: 'listbox', 'aria-label': 'Ingredients' },
      p.ingredients.map((i) => {
        const inPot = ui.cauldron.includes(i.id);
        return el('li', {},
          el('button', {
            type: 'button', class: `alc-row${inPot ? ' alc-on' : ''}`, 'aria-pressed': inPot ? 'true' : 'false',
            onclick: () => {
              ui.cauldron = inPot ? ui.cauldron.filter((x) => x !== i.id) : ui.cauldron.length < 8 ? [...ui.cauldron, i.id] : ui.cauldron;
              rerender();
            },
          }, itemIcon(api, i), el('span', { class: 'alc-name', text: i.name }), el('span', { class: 'alc-dim', text: `×${i.quantity}` })));
      }));
    const pot = ui.cauldron.map((id) => p.ingredients.find((i) => i.id === id)?.name).filter(Boolean);
    return [
      recipes,
      el('h3', { text: 'Ingredients' }),
      p.ingredients.length ? list : el('p', { class: 'alc-dim', text: 'You carry no ingredients.' }),
      el('div', { class: 'alc-cauldron' },
        el('span', { class: 'alc-dim', text: 'Cauldron: ' }), pot.length ? pot.join(', ') : 'empty',
        el('button', { class: 'alc-go', type: 'button', disabled: ui.busy || !pot.length, onclick: () => { const ids = ui.cauldron; ui.cauldron = []; act('alchemy.brew', { itemIds: ids }); } }, 'Mix')),
    ];
  }

  function itemMaker(p) {
    const item = p.items.find((i) => i.id === ui.item);
    const totals = makerTotals(ui.picks, item?.power ?? 0);
    const items = el('ul', { class: 'alc-list', 'aria-label': 'Items that can be enchanted' }, p.items.map((i) => el('li', {},
      el('button', { type: 'button', class: `alc-row${ui.item === i.id ? ' alc-on' : ''}`, onclick: () => { ui.item = i.id; ui.picks = []; ui.name = i.name; rerender(); } },
        itemIcon(api, i), el('span', { class: 'alc-name', text: i.name }), el('span', { class: 'alc-dim', text: `${i.power} pts` })))));
    const types = p.enchantments.filter((t) => t.options.length && (!t.weaponOnly || item?.group === 'weapon'));
    const typeSel = el('select', { class: 'alc-select', 'aria-label': 'Power or side effect', onchange: (e) => { ui.type = Number(e.target.value); rerender(); } },
      el('option', { value: '', text: 'Choose a power or side effect…' }),
      types.map((t) => el('option', { value: t.type, selected: ui.type === t.type, text: label(t.key) })));
    const current = types.find((t) => t.type === ui.type);
    const optSel = current ? el('select', { class: 'alc-select', 'aria-label': 'Variant' },
      current.options.map((o) => el('option', { value: o.param, text: `${o.label ?? label(current.key)} (${o.cost > 0 ? '+' : ''}${o.cost})` }))) : null;
    const add = el('button', {
      type: 'button', class: 'alc-chip', disabled: !current || !item || ui.picks.length >= 10,
      onclick: () => {
        const param = Number(optSel.value);
        const o = current.options.find((x) => x.param === param);
        ui.picks = [...ui.picks, { type: current.type, param, cost: o.cost, text: `${label(current.key)}${o.label ? `: ${o.label}` : ''}` }];
        rerender();
      },
    }, 'Add');
    const picks = el('ol', { class: 'alc-picks' }, ui.picks.map((s, n) => el('li', { class: s.cost < 0 ? 'alc-side' : '' },
      `${s.text} `, el('span', { class: 'alc-dim', text: `${s.cost > 0 ? '+' : ''}${s.cost}` }),
      el('button', { type: 'button', class: 'alc-x', 'aria-label': `Remove ${s.text}`, onclick: () => { ui.picks = ui.picks.filter((_, k) => k !== n); rerender(); } }, '×'))));
    const nameInput = el('input', { class: 'alc-input', value: ui.name, maxlength: 32, 'aria-label': 'Item name', oninput: (e) => { ui.name = e.target.value; } });
    return [
      el('div', { class: 'alc-grid' },
        el('div', {}, el('h3', { text: 'Item' }), p.items.length ? items : el('p', { class: 'alc-dim', text: 'Nothing you carry can hold an enchantment.' })),
        el('div', {},
          el('h3', { text: 'Enchantments' }),
          el('div', { class: 'alc-pickrow' }, typeSel, optSel, add),
          picks,
          el('div', { class: `alc-totals${totals.over ? ' alc-bad' : ''}` },
            el('span', { text: `Enchantment ${totals.cost} / ${totals.power}` }), el('span', { text: `Gold ${totals.gold} (you have ${p.gold})` })),
          el('label', { class: 'alc-dim' }, 'Name ', nameInput),
          el('button', {
            type: 'button', class: 'alc-go', disabled: ui.busy || !item || !ui.picks.length || totals.over,
            onclick: () => act('alchemy.enchant', { itemId: item.id, enchantments: ui.picks.map(({ type, param }) => ({ type, param })), name: ui.name }),
          }, 'Enchant'))),
    ];
  }

  function merchant(p) {
    if (!p.offers.length) return [el('p', { class: 'alc-dim', text: 'Nothing is left for sale today.' })];
    return [el('ul', { class: 'alc-list' }, p.offers.map((o) => el('li', { class: 'alc-offer' },
      itemIcon(api, { template: o.template, magic: o.magic }), el('span', { class: 'alc-name', text: o.name }),
      o.quantity > 1 ? el('span', { class: 'alc-dim', text: `×${o.quantity}` }) : null,
      el('span', { class: 'alc-price', text: `${o.price} gp` }),
      el('button', { type: 'button', class: 'alc-chip', disabled: ui.busy || p.gold < o.price, onclick: () => act('alchemy.buy', { service: p.service, offerId: o.offerId }) }, 'Buy'))))];
  }

  function identify(p) {
    if (!p.items.length) return [el('p', { class: 'alc-dim', text: 'You carry nothing that needs identifying.' })];
    return [el('ul', { class: 'alc-list' }, p.items.map((i) => el('li', { class: 'alc-offer' },
      itemIcon(api, i), el('span', { class: 'alc-name', text: i.name }), el('span', { class: 'alc-price', text: i.price ? `${i.price} gp` : 'free' }),
      el('button', { type: 'button', class: 'alc-chip', disabled: ui.busy || p.gold < i.price, onclick: () => act('alchemy.identify', { itemId: i.id, expectCost: i.price }) }, 'Identify'))))];
  }

  /** Items with a power the wearer can release (Cast When Used, artifacts, recipes, brewed potions). */
  function usable() {
    const inv = api.state?.character?.inventory ?? [];
    return inv.filter((i) => i && ((i.magic?.enchantments ?? []).some((e) => e.type === 0 || e.type === 26) || i.recipe || (i.group === 'potion' && !i.effect)));
  }
  function magicItems() {
    const list = usable();
    if (!list.length) return null;
    return el('section', { class: 'alc-mine', 'aria-label': 'Your magic items' },
      el('h3', { text: 'Your magic items' }),
      el('ul', { class: 'alc-list' }, list.map((i) => el('li', { class: 'alc-offer' },
        itemIcon(api, i), el('span', { class: 'alc-name', text: i.name }),
        i.maxCondition > 1 ? el('span', { class: 'alc-dim', text: `${i.condition}/${i.maxCondition}` }) : null,
        el('button', { type: 'button', class: 'alc-chip', disabled: ui.busy, onclick: async () => { ui.busy = true; rerender(); await api.act('alchemy.use', { itemId: i.id }); ui.busy = false; rerender(); } }, i.recipe ? 'Read' : i.group === 'potion' ? 'Drink' : 'Use')))));
  }

  function render(root) {
    container = root;
    root.replaceChildren();
    const p = ui.panel;
    const wrap = el('div', { class: 'alc-root' });
    if (!p) {
      wrap.append(el('p', { class: 'alc-dim', text: 'Ask a guild or temple member for the Potion Maker, Item Maker, identification or their wares.' }));
      const mine = magicItems();
      if (mine) wrap.append(mine);
      root.append(wrap);
      return;
    }
    wrap.append(el('header', { class: 'alc-head' }, el('h2', { text: p.title }), el('span', { class: 'alc-dim', text: p.npcName }), el('span', { class: 'alc-gold', text: `${p.gold} gp` })));
    const body = p.service === 'makePotions' ? potionMaker(p)
      : p.service === 'makeItems' ? itemMaker(p)
        : p.service === 'identify' ? identify(p) : merchant(p);
    wrap.append(...body);
    const mine = magicItems();
    if (mine) wrap.append(mine);
    root.append(wrap);
  }

  api.registerPanel(PANEL_ID, 'Alchemy & Enchanting', render, { order: 6.6 });
}
