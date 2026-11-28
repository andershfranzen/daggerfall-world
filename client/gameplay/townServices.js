// Bank & Repairs panel: classic regional banking, letters of credit and item repair.
// Server rules: server/rpg/townServices.js. Shared formulas: ./townServices/rules.js.
// Documentation: docs/town-services.md.
//
// The panel lists the real counters of the current town (sent by the server in a
// `townServices.counters` event), shows which one the player is standing at, and offers only that
// counter's controls. Every button sends intent; the server re-validates distance, balances,
// inventory and prices.
import {
  LETTER_MIN, DOOR_REACH, NPC_REACH, GOLD_PER_KG, letterCost, repairBatchMinutes, repairCost, repairMinutes, repairRefusal, formatWait,
  placeOf, regionKey,
} from './townServices/rules.js';
import { priceContext } from './economy/rules.js';

import { getItemArtSource, itemIcon } from './inventory/icons.js';
import { getNpcAssets } from './npcs/portrait.js';

export const PANEL_ID = 'townServices';
const TITLE = 'Bank & Repairs';

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

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-town-services-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./townServices.css', import.meta.url).href;
  link.dataset.townServicesCss = '';
  document.head.append(link);
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Bearing word from (x,z) to (tx,tz); yaw 0 = north (-z). */
const compass = (x, z, tx, tz) => COMPASS[((Math.round(Math.atan2(tx - x, -(tz - z)) / (Math.PI / 4)) % 8) + 8) % 8];
const requestId = () => `ts-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;

export function install(api) {
  const npcArt = getNpcAssets(api);
  loadStyles();
  getItemArtSource(api);
  const ui = {
    counters: [], status: 'unknown', reason: null, location: null,
    clock: null, // {minutes, minutesPerSecond, at}
    reachKey: '', busy: false, busyTimer: 0, announced: new Set(),
    amounts: { deposit: '', withdraw: '', letter: '' },
  };
  let container = null;

  const rpg = () => api.state?.character ?? null;
  const ts = () => rpg()?.townServices ?? { accounts: {}, letters: [], repairs: [] };
  const isOpen = () => api.panel === PANEL_ID && !!container?.isConnected;
  const rerender = () => { if (isOpen()) render(container); };
  api.on('assets', rerender);
  const pos = () => (api.camera && Number.isFinite(api.camera.x) ? { x: api.camera.x, z: api.camera.z } : null);
  const nowMinutes = () => {
    if (!ui.clock) return null;
    const secs = (performance.now() - ui.clock.at) / 1000;
    return ui.clock.minutes + secs * (ui.clock.minutesPerSecond || 0);
  };

  /** Counters from the server plus any smith NPC in view (the roster can appear after the announcement). */
  function counters() {
    const list = [...ui.counters];
    const loc = api.state?.character?.location ?? api.location;
    for (const e of api.state?.entities ?? []) {
      if (e.kind !== 'npc' || e.role !== 'smith' || e.location !== loc) continue;
      const id = `npc:${e.id}`;
      const found = list.find((c) => c.id === id);
      if (found) found.doors = [{ x: e.x, z: e.z }];
      else list.push({ id, kind: 'npc', type: 'smith', npcId: e.id, services: ['repair'], quality: 10, name: `${e.name}, ${e.title || 'Smith'}`, doors: [{ x: e.x, z: e.z }] });
    }
    return list;
  }

  function distance(c) {
    const place = placeOf(api.state?.character?.location ?? '');
    if (place?.kind === 'interior') return c.id === place.counterId ? 0 : Infinity;
    const p = pos();
    if (!p) return Infinity;
    let best = Infinity;
    for (const d of c.doors || []) best = Math.min(best, Math.hypot(d.x - p.x, d.z - p.z));
    return best;
  }
  const reachOf = (c) => (c.kind === 'npc' ? NPC_REACH : DOOR_REACH);
  /** Counters the player can use right now, nearest first (with a small margin against jitter). */
  const inReach = () => counters().map((c) => ({ c, d: distance(c) })).filter(({ c, d }) => d <= reachOf(c) - 0.1).sort((a, b) => a.d - b.d).map(({ c }) => c);

  const act = (verb, args) => {
    if (ui.busy) return;
    ui.busy = true;
    clearTimeout(ui.busyTimer);
    ui.busyTimer = setTimeout(() => { ui.busy = false; rerender(); }, 4000);
    api.act(verb, { ...args, requestId: requestId() });
    rerender();
  };
  const done = () => {
    ui.busy = false;
    clearTimeout(ui.busyTimer);
  };

  api.on('state', () => { done(); rerender(); });
  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'clock' && Number.isFinite(ev.minutes)) {
      ui.clock = { minutes: ev.minutes, minutesPerSecond: ev.minutesPerSecond, at: performance.now() };
      return;
    }
    // Town-services events carry the shared clock too (12x real time unless a clock event says otherwise).
    if (typeof ev.kind === 'string' && ev.kind.startsWith('townServices') && Number.isFinite(ev.clock)) {
      ui.clock = { minutes: ev.clock, minutesPerSecond: ui.clock?.minutesPerSecond ?? 0.2, at: performance.now() };
    }
    if (ev.kind === 'townServices.counters') {
      ui.counters = Array.isArray(ev.counters) ? ev.counters : [];
      ui.market = ev.market ?? null;
      ui.trade = ev.trade ?? null; // the server's live Mercantile and Personality
      ui.status = ev.status;
      ui.reason = ev.reason ?? null;
      ui.location = ev.location;
      ui.reachKey = '';
      rerender();
    } else if (ev.kind === 'townServices' || ev.kind === 'townServices.offer') {
      done();
      // An offer made inside an NPC conversation is already shown in the chat dock (npcs.js).
      if (ev.text && !ev.talkHandled) api.message(ev.text);
      rerender();
    }
  });
  api.on('message', (m) => { if (m?.kind === 'error' && ui.busy) { done(); rerender(); } });

  // Re-render when the set of reachable counters changes; otherwise only refresh distances.
  let lastFrame = 0;
  api.on('frame', (f) => {
    const t = f?.now ?? 0;
    if (t - lastFrame < 0.25) return;
    lastFrame = t;
    const here = inReach();
    const key = here.map((c) => c.id).join('|');
    if (key !== ui.reachKey) {
      ui.reachKey = key;
      for (const c of here) {
        if (ui.announced.has(c.id) || c.kind === 'npc') continue;
        ui.announced.add(c.id);
        api.message(`You are at ${c.name}. Open ${TITLE} to use its counter.`);
      }
      rerender();
    } else if (isOpen()) {
      for (const span of container.querySelectorAll('[data-dist-for]')) {
        const c = counters().find((k) => k.id === span.dataset.distFor);
        if (c) span.textContent = distLabel(c);
      }
    }
  });

  function distLabel(c) {
    const d = distance(c);
    if (d <= reachOf(c)) return 'here';
    if (!Number.isFinite(d)) return '';
    const p = pos();
    const d0 = c.doors?.reduce((a, b) => (Math.hypot(b.x - p.x, b.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? b : a));
    return `${Math.round(d)} m ${p && d0 ? compass(p.x, p.z, d0.x, d0.z) : ''}`.trim();
  }

  // ---------------------------------------------------------------- render

  function render(root) {
    container = root;
    root.replaceChildren();
    const ch = rpg();
    const wrap = el('div', { class: 'tsv-root' });
    root.append(wrap);
    if (!ch) {
      wrap.append(el('p', { class: 'tsv-dim', text: 'Join the town to use its bank and smiths.' }));
      return;
    }
    const place = placeOf(ch.location);
    const here = inReach();
    const bank = here.find((c) => c.services.includes('bank'));
    const smith = here.find((c) => c.services.includes('repair'));

    wrap.append(el('header', { class: 'tsv-head' },
      el('div', {}, el('h2', { class: 'tsv-h', text: place ? `${place.location}, ${place.region}` : 'Away from town' }),
        el('p', { class: 'tsv-dim', text: statusLine() })),
      el('dl', { class: 'tsv-purse' }, el('dt', { text: 'Gold carried' }), el('dd', { text: String(ch.gold ?? 0) }),
        el('dt', { text: 'Account here' }), el('dd', { text: place ? String(ts().accounts?.[regionKey(place.region)]?.gold ?? 0) : '—' }))));

    const contextualLinks = [
      api.getPanel?.('market') ? el('button', { type: 'button', class: 'tsv-btn', onclick: () => api.openPanel('market') }, 'Market Board') : null,
      api.getPanel?.('pvp') ? el('button', { type: 'button', class: 'tsv-btn', onclick: () => api.openPanel('pvp') }, 'Land PvP & Arena') : null,
      api.getPanel?.('coopWorld') ? el('button', { type: 'button', class: 'tsv-btn', onclick: () => api.openPanel('coopWorld') }, 'Co-op & Delves') : null,
    ].filter(Boolean);
    if (contextualLinks.length) {
      wrap.append(el('section', { class: 'tsv-box', 'aria-label': 'Town boards and halls' },
        el('h3', { class: 'tsv-h4', text: 'Town Boards & Activities' }),
        el('div', { class: 'tsv-row' }, contextualLinks)));
    }
    wrap.append(countersSection(here));
    const cols = el('div', { class: 'tsv-cols' });
    cols.append(bankSection(bank, place));
    cols.append(repairSection(smith, place));
    wrap.append(cols);
  }

  function statusLine() {
    if (ui.status === 'loading') return 'Reading the town ledgers…';
    if (ui.status === 'unavailable') return `No banks or shops known here: ${ui.reason || 'no game data'}.`;
    const n = counters().length;
    return n ? `${n} counter${n === 1 ? '' : 's'} in town. Stand at a door to use it.` : 'This town has no bank or repair shop.';
  }

  function countersSection(here) {
    const list = counters().map((c) => ({ c, d: distance(c) })).sort((a, b) => a.d - b.d);
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Counters in town' }, el('h3', { class: 'tsv-h4', text: 'Counters in town' }));
    if (!list.length) {
      sec.append(el('p', { class: 'tsv-dim', text: ui.status === 'loading' ? 'Loading…' : 'None.' }));
      return sec;
    }
    const ul = el('ul', { class: 'tsv-counters' });
    for (const { c } of list.slice(0, 12)) {
      const at = here.includes(c);
      ul.append(el('li', { class: at ? 'tsv-at' : null },
        el('span', { class: `tsv-tag tsv-tag-${c.services[0]}`, text: c.services.includes('bank') ? 'Bank' : 'Repair' }),
        el('span', { class: 'tsv-name', text: c.name }),
        el('span', { class: 'tsv-q', text: c.kind === 'building' ? `quality ${c.quality}` : 'townsfolk' }),
        el('span', { class: 'tsv-dist', 'data-dist-for': c.id, text: distLabel(c) })));
    }
    sec.append(ul);
    return sec;
  }

  const numberInput = (key, label, max) => el('input', {
    type: 'number', min: '1', step: '1', max: max != null ? String(max) : null, inputmode: 'numeric', 'aria-label': label,
    value: ui.amounts[key], class: 'tsv-num',
    oninput: (e) => { ui.amounts[key] = e.target.value; if (key === 'letter') updateLetterCost(); },
  });
  const amountOf = (key) => {
    const v = Number(ui.amounts[key]);
    return Number.isInteger(v) && v > 0 ? v : null;
  };
  const button = (label, onclick, disabled = false, cls = '') => el('button', { type: 'button', class: `tsv-btn ${cls}`.trim(), disabled: disabled || ui.busy, onclick }, label);

  function updateLetterCost() {
    const out = container?.querySelector('[data-letter-cost]');
    if (!out) return;
    const a = amountOf('letter');
    out.textContent = a ? (a < LETTER_MIN ? `Minimum ${LETTER_MIN} gold.` : `Costs ${letterCost(a)} from your account.`) : `1% commission, minimum ${LETTER_MIN} gold.`;
  }

  function bankSection(bank, place) {
    const s = ts();
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Bank' }, el('h3', { class: 'tsv-h4', text: 'Bank' }));
    const ch = rpg();
    // Letters of Credit are items in the pack (template letter-of-credit with a `credit` record).
    const letters = (Array.isArray(ch?.inventory) ? ch.inventory : [])
      .filter((it) => it?.template === 'letter-of-credit' && it.credit?.amount > 0)
      .map((it) => ({ id: it.id, amount: it.credit.amount, region: it.credit.region }));
    if (!bank) {
      sec.append(el('p', { class: 'tsv-dim', text: 'Stand at a bank door to deposit, withdraw or write letters of credit.' }));
    } else {
      const acct = s.accounts?.[regionKey(place.region)]?.gold ?? 0;
      sec.append(el('p', { class: 'tsv-at-line', text: `At ${bank.name}. Balance in ${place.region}: ${acct} gold.` }));
      sec.append(el('form', { class: 'tsv-row', onsubmit: (e) => { e.preventDefault(); const a = amountOf('deposit'); if (a) act('bank.deposit', { counterId: bank.id, amount: a }); } },
        numberInput('deposit', 'Gold to deposit', ch.gold), el('button', { type: 'submit', class: 'tsv-btn', disabled: ui.busy || !(ch.gold > 0) }, 'Deposit'),
        button('Deposit all', () => ch.gold > 0 && act('bank.deposit', { counterId: bank.id, amount: ch.gold }), !(ch.gold > 0))));
      sec.append(el('form', { class: 'tsv-row', onsubmit: (e) => { e.preventDefault(); const a = amountOf('withdraw'); if (a) act('bank.withdraw', { counterId: bank.id, amount: a }); } },
        numberInput('withdraw', 'Gold to withdraw', acct), el('button', { type: 'submit', class: 'tsv-btn', disabled: ui.busy || acct <= 0 }, 'Withdraw'),
        el('span', { class: 'tsv-dim tsv-small', text: `${GOLD_PER_KG} gold weigh 1 kg` })));
      sec.append(el('h4', { class: 'tsv-h5', text: 'Letter of credit' }));
      sec.append(el('form', { class: 'tsv-row', onsubmit: (e) => { e.preventDefault(); const a = amountOf('letter'); if (a) act('bank.letter', { counterId: bank.id, amount: a }); } },
        numberInput('letter', 'Letter amount', null), el('button', { type: 'submit', class: 'tsv-btn', disabled: ui.busy || acct < letterCost(LETTER_MIN) }, 'Write letter'),
        el('span', { class: 'tsv-dim tsv-small', 'data-letter-cost': '', text: '' })));
      queueMicrotask(updateLetterCost);
    }
    const total = letters.reduce((n, l) => n + l.amount, 0);
    sec.append(el('h4', { class: 'tsv-h5', text: `Letters carried (${letters.length})` }));
    if (letters.length) {
      sec.append(el('ul', { class: 'tsv-list' }, letters.map((l) => el('li', { 'data-letter': l.id }, itemIcon(api, { template: 'letter-of-credit' }), `${l.amount} gold`, el('span', { class: 'tsv-dim', text: ` from ${l.region}` })))));
      sec.append(el('div', { class: 'tsv-row' }, button(`Deposit all letters (${total} gold)`, () => act('bank.redeem', { counterId: bank.id }), !bank)));
    } else sec.append(el('p', { class: 'tsv-dim tsv-small', text: 'None. Any bank in the Iliac Bay honours them.' }));

    const others = Object.values(s.accounts || {}).filter((a) => a.gold > 0 && (!place || regionKey(a.region) !== regionKey(place.region)));
    if (others.length) {
      sec.append(el('h4', { class: 'tsv-h5', text: 'Accounts elsewhere' }));
      sec.append(el('ul', { class: 'tsv-list' }, others.map((a) => el('li', {}, `${a.region}: ${a.gold} gold`))));
    }
    return sec;
  }

  function repairPortrait(smith) {
    const npc = smith.npcId && api.state?.entities?.find((e) => e.id === smith.npcId);
    if (!npc?.sprite) return null;
    const pic = el('span', { class: 'tsv-portrait', 'aria-hidden': 'true', hidden: true });
    npcArt.portrait(npc.sprite, npc.faction).then((canvas) => {
      if (!canvas) return;
      pic.append(canvas);
      pic.hidden = false;
    });
    return pic;
  }

  function repairSection(smith, place) {
    const s = ts();
    const ch = rpg();
    const sec = el('section', { class: 'tsv-box', 'aria-label': 'Repairs' }, el('h3', { class: 'tsv-h4', text: 'Repairs' }));
    const now = nowMinutes();
    if (!smith) {
      sec.append(el('p', { class: 'tsv-dim', text: 'Stand at an armourer, weaponsmith or general store door, or beside a smith, to leave damaged gear.' }));
    } else {
      sec.append(el('div', { class: 'tsv-operator' }, repairPortrait(smith),
        el('p', { class: 'tsv-at-line', text: `At ${smith.name} (quality ${smith.quality}).` })));
      const damaged = (ch.inventory || []).filter((i) => i && i.maxCondition > 0 && i.condition < i.maxCondition && ['weapon', 'armor', 'shield'].includes(i.group));
      if (!damaged.length) sec.append(el('p', { class: 'tsv-dim tsv-small', text: 'Nothing you carry needs repairing.' }));
      const ul = el('ul', { class: 'tsv-list tsv-items' });
      // Classic trade price: the region's market (from the server) and this character's Mercantile and Personality.
      const pc = priceContext({ quality: smith.quality, character: ch.character ?? null, mercantile: ui.trade?.mercantile, personality: ui.trade?.personality });
      const price = { adjust: ui.market?.adjust ?? 1000, mercantile: pc.mercantile, personality: pc.personality };
      const rank = ch.guilds?.fighters?.rank;
      const quote = (it) => repairCost(it, smith.quality, Number.isInteger(rank) ? rank : null, price);
      const leaveable = damaged.filter((it) => !repairRefusal(it));
      if (leaveable.length > 1) {
        const total = leaveable.reduce((a, it) => a + quote(it), 0);
        const longest = Math.max(...repairBatchMinutes(leaveable));
        sec.append(el('p', { class: 'tsv-dim tsv-small' }, `Leave all ${leaveable.length} together: ${total} gold, ready in ${formatWait(longest, 0)}. `,
          button('Leave all', () => act('repair.leave', { counterId: smith.id, itemIds: leaveable.map((it) => it.id), cost: total }), (ch.gold ?? 0) < total)));
      }
      for (const it of damaged) {
        const refusal = repairRefusal(it);
        const cost = quote(it);
        const pct = Math.round((100 * it.condition) / it.maxCondition);
        ul.append(el('li', {},
          el('span', { class: 'tsv-name' }, itemIcon(api, it), it.name, it.equipped ? ' (worn)' : ''),
          el('span', { class: 'tsv-dim', text: `${pct}% · ${cost} gold · ${formatWait(repairMinutes(it), 0)}` }),
          refusal ? el('span', { class: 'tsv-dim tsv-small', text: refusal })
            : button('Leave for repair', () => act('repair.leave', { counterId: smith.id, itemId: it.id, cost }), (ch.gold ?? 0) < cost)));
      }
      if (damaged.length) sec.append(ul);
    }
    const tickets = Array.isArray(s.repairs) ? s.repairs : [];
    sec.append(el('h4', { class: 'tsv-h5', text: `With smiths (${tickets.length})` }));
    if (!tickets.length) sec.append(el('p', { class: 'tsv-dim tsv-small', text: 'Nothing is being repaired.' }));
    const ul = el('ul', { class: 'tsv-list tsv-items' });
    for (const t of tickets) {
      const ready = now != null && now >= t.readyAt;
      const here = smith && smith.id === t.counterId && place && place.town === t.town;
      const where = `${t.shop}, ${placeOf(t.town)?.location ?? '?'}`;
      const status = now == null ? 'waiting for the clock' : ready ? 'ready' : `ready in ${formatWait(t.readyAt, now)}`;
      const controls = !here ? el('span', { class: 'tsv-dim tsv-small', text: where })
        : ready ? button('Collect', () => act('repair.collect', { counterId: t.counterId, ticket: t.ticket }))
          : button('Take back unrepaired', () => {
            if (typeof confirm !== 'function' || confirm(`Take back ${t.item.name} before it is repaired? The ${t.cost} gold is not refunded.`)) {
              act('repair.collect', { counterId: t.counterId, ticket: t.ticket, interrupt: true });
            }
          }, false, 'tsv-btn-quiet');
      ul.append(el('li', {}, el('span', { class: 'tsv-name' }, itemIcon(api, t.item), t.item.name), el('span', { class: ready ? 'tsv-ok' : 'tsv-dim', text: status }), controls));
    }
    if (tickets.length) sec.append(ul);
    return sec;
  }

  // Ask for a fresh counter list each time the panel opens (not on every re-render).
  let wasOpen = false;
  api.on('panel', (d) => {
    const open = !!d?.open && d.id === PANEL_ID;
    if (open && !wasOpen) api.act('town.services', {});
    wasOpen = open;
  });
  api.on('assets', () => { if (isOpen()) rerender(); });
  api.registerPanel(PANEL_ID, TITLE, (root) => render(root));

  return { counters, inReach };
}
