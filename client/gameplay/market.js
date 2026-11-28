// Contextual Player Market Board & House Trader UI (§6 Player Market).
//
// Exports:
//  - `install(api)` for Wave 2B registration in `client/gameplay/features.js`
//  - `mountMarketPanel(root, api, opts)` for standalone/contextual mounting
//  - `renderMarketPanel(root, ui, actions)` pure DOM renderer (granite & verdigris theme)
//
// Views:
//  1. Browse Fixed-Price (search, group/region/quality/sort, pagination, partial-stack buy,
//     stale-quote refresh-in-place, and Create Listing with fee/tax quote preview)
//  2. Timed Auctions (high bid, min next bid, optional buyout, anti-snipe countdown, bid/buyout/create)
//  3. Buy Orders (funded gold-escrowed orders, partial fulfillment, post buy order)
//  4. My Listings & Claims (account obligation caps, Offline Claims inbox, active listings/bids/orders)
//  5. House Trader (contextual placed house vendor view backed by the same escrow & claim ledger)

export const PANEL = 'market';

const ITEM_GROUPS = ['all', 'weapon', 'armor', 'shield', 'potion', 'gem', 'ingredient', 'clothing', 'jewellery', 'book', 'ammo', 'misc'];
const ITEM_QUALITIES = ['all', 'common', 'good', 'fine', 'masterwork', 'enchanted', 'artifact'];
const REGIONS = ['all', 'Daggerfall', 'Wayrest', 'Sentinel', 'Anticlere', 'Betony'];

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-market-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./market.css', import.meta.url).href;
  link.dataset.marketCss = '';
  document.head.append(link);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'value') n.value = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) n.append(c);
  }
  return n;
}

export function formatGold(n) {
  const v = Math.max(0, Math.trunc(Number(n) || 0));
  return `${v.toLocaleString('en-US')} g`;
}

export function formatTimeLeft(targetMs, nowMs = Date.now()) {
  if (!Number.isFinite(targetMs)) return '—';
  const diff = Math.max(0, targetMs - nowMs);
  if (diff === 0) return 'Due';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function genOpKey(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultMarketUiState(overrides = {}) {
  return {
    tab: 'browse', // 'browse' | 'auctions' | 'orders' | 'my' | 'trader'
    nowMs: Date.now(),
    busy: false,
    notice: null, // { kind: 'info'|'error'|'stale', text, freshQuote? }
    board: { id: 'board:daggerfall/gothway-garden', label: 'Gothway Garden Market Board', region: 'Daggerfall', town: 'Gothway Garden' },
    character: { id: null, name: 'Adventurer', gold: 0, carriedKg: 0, maxKg: 100, inventory: [] },
    filters: {
      q: '',
      group: 'all',
      region: 'all',
      quality: 'all',
      sort: 'price_asc',
      page: 1,
      pageSize: 12,
    },
    browse: { page: 1, totalPages: 1, total: 0, items: [] },
    auctions: { page: 1, totalPages: 1, total: 0, items: [] },
    orders: { page: 1, totalPages: 1, total: 0, items: [] },
    my: {
      listings: [],
      auctions: [],
      bids: [],
      orders: [],
      claims: [],
      usage: {
        listings: 0,
        auctions: 0,
        bids: 0,
        buyOrders: 0,
        total: 0,
        caps: { listings: 20, auctions: 10, buyOrders: 10, total: 30 },
      },
    },
    trader: null, // { trader: { houseId, traderId, label, town, region, ownerCharacterId, access }, items: [], total: 0 }
    buyQty: {},
    bidAmount: {},
    fillItem: {},
    fillQty: {},
    listForm: { itemId: '', quantity: 1, unitPrice: 25, durationHours: 168 },
    auctionForm: { itemId: '', startPrice: 50, reservePrice: '', buyoutPrice: '', durationHours: 24 },
    orderForm: { template: 'arrow', quantity: 50, unitPrice: 3, durationHours: 168 },
    ...overrides,
  };
}

/**
 * Pure DOM renderer for the Player Market Board & House Trader UI.
 */
export function renderMarketPanel(root, ui, actions = {}) {
  if (!root) return;
  const nowMs = ui.nowMs || Date.now();
  const gold = Number(ui.character?.gold) || 0;
  const pendingClaimsCount = Array.isArray(ui.my?.claims) ? ui.my.claims.length : 0;
  const eligibleInventory = (ui.character?.inventory ?? []).filter(
    (it) => it && !it.equipped && !it.quest && !it.bound && !it.stolen && !it.conjuredUntil && !it.credit && it.group !== 'transport',
  );

  const wrap = el('div', { class: 'mkt-root', 'data-market-tab': ui.tab });

  // 1. Granite Header Banner
  const boardLabel = ui.tab === 'trader' && ui.trader?.trader?.label
    ? ui.trader.trader.label
    : (ui.board?.label || 'Town Market Board');
  const boardSub = ui.tab === 'trader' && ui.trader?.trader
    ? `${ui.trader.trader.town || 'Town'}, ${ui.trader.trader.region || 'Iliac Bay'} · Shared Escrow Ledger`
    : (ui.board
      ? `${ui.board.town}, ${ui.board.region} · 2% Listing Fee · 5% Sale Tax · Durable Escrow`
      : 'Visit a town market board to commit trades, bids, or collect claims');

  wrap.append(
    el(
      'header',
      { class: 'mkt-banner' },
      el(
        'div',
        { class: 'mkt-banner-title' },
        el('h2', { class: 'mkt-title', text: boardLabel }),
        el('p', { class: 'mkt-subtitle', text: boardSub }),
      ),
      el(
        'div',
        { class: 'mkt-wallet' },
        el('span', { class: 'mkt-stat-pill is-gold' }, 'Purse ', el('strong', { text: formatGold(gold) })),
        el(
          'span',
          { class: 'mkt-stat-pill' },
          'Pack ',
          el('strong', { text: `${Number(ui.character?.carriedKg || 0).toFixed(1)} / ${Number(ui.character?.maxKg || 100).toFixed(0)} kg` }),
        ),
        el(
          'span',
          { class: 'mkt-stat-pill' },
          'Claims ',
          el('strong', { text: String(pendingClaimsCount) }),
        ),
      ),
    ),
  );

  // 2. Sub-Tab Strip
  const tabs = [
    { id: 'browse', label: 'Fixed-Price', count: ui.browse?.total ?? 0 },
    { id: 'auctions', label: 'Timed Auctions', count: ui.auctions?.total ?? 0 },
    { id: 'orders', label: 'Buy Orders', count: ui.orders?.total ?? 0 },
    { id: 'my', label: 'My Listings & Claims', count: pendingClaimsCount, alert: pendingClaimsCount > 0 },
    { id: 'trader', label: 'House Trader', count: ui.trader?.items?.length ?? 0 },
  ];
  wrap.append(
    el(
      'nav',
      { class: 'mkt-tabs', role: 'tablist', 'aria-label': 'Market sections' },
      ...tabs.map((t) =>
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `mkt-tab-btn${ui.tab === t.id ? ' is-active' : ''}`,
            'aria-selected': ui.tab === t.id ? 'true' : 'false',
            'data-tab': t.id,
            onclick: () => actions.onTab?.(t.id),
          },
          t.label,
          t.count > 0 ? el('span', { class: `mkt-badge${t.alert ? ' is-alert' : ''}`, text: String(t.count) }) : null,
        ),
      ),
    ),
  );

  // 3. Status / Stale-Quote / Error Notice
  if (ui.notice?.text) {
    const cls = ui.notice.kind === 'error'
      ? 'mkt-notice is-error'
      : (ui.notice.kind === 'stale' ? 'mkt-notice is-stale' : 'mkt-notice');
    wrap.append(
      el(
        'div',
        { class: cls, role: 'status' },
        el('span', { text: ui.notice.text }),
        ui.notice.freshQuote
          ? el(
              'button',
              {
                type: 'button',
                class: 'mkt-btn mkt-btn-primary',
                onclick: () => actions.onRefresh?.(),
              },
              'Refresh Quote',
            )
          : null,
      ),
    );
  }

  // 4. Active View Body
  if (ui.tab === 'browse') wrap.append(renderBrowseView(ui, actions, eligibleInventory, gold, nowMs));
  else if (ui.tab === 'auctions') wrap.append(renderAuctionsView(ui, actions, eligibleInventory, gold, nowMs));
  else if (ui.tab === 'orders') wrap.append(renderOrdersView(ui, actions, eligibleInventory, gold, nowMs));
  else if (ui.tab === 'my') wrap.append(renderMyView(ui, actions, nowMs));
  else if (ui.tab === 'trader') wrap.append(renderTraderView(ui, actions, gold, nowMs));

  root.replaceChildren(wrap);
}

function renderItemTags(item, extra = {}) {
  const tags = [];
  if (item?.quality && item.quality !== 'common') {
    const cls = item.quality === 'enchanted' || item.quality === 'artifact' ? 'mkt-tag is-enchanted' : 'mkt-tag';
    tags.push(el('span', { class: cls, text: item.quality }));
  }
  if (item?.crafted?.maker) {
    tags.push(el('span', { class: 'mkt-tag is-crafted', text: `Crafted: ${item.crafted.maker}` }));
  }
  if (extra.houseTrader) {
    tags.push(el('span', { class: 'mkt-tag is-trader', text: extra.houseTrader.label || 'House Trader' }));
  }
  if (extra.antiSnipe) {
    tags.push(el('span', { class: 'mkt-tag is-snipe', text: 'Anti-Snipe Active' }));
  }
  return tags;
}

function renderBrowseView(ui, actions, eligibleInventory, gold, nowMs) {
  const f = ui.filters;
  const page = ui.browse || { page: 1, totalPages: 1, total: 0, items: [] };

  const filterBar = el(
    'div',
    { class: 'mkt-filters' },
    el('input', {
      type: 'search',
      class: 'mkt-input mkt-input-grow',
      placeholder: 'Search item, material, crafter, seller...',
      value: f.q || '',
      'aria-label': 'Search listings',
      oninput: (e) => actions.onFilterChange?.({ q: e.target.value, page: 1 }),
    }),
    el(
      'select',
      {
        class: 'mkt-select',
        'aria-label': 'Item group',
        onchange: (e) => actions.onFilterChange?.({ group: e.target.value, page: 1 }),
      },
      ...ITEM_GROUPS.map((g) => el('option', { value: g, selected: f.group === g, text: g === 'all' ? 'All Groups' : g })),
    ),
    el(
      'select',
      {
        class: 'mkt-select',
        'aria-label': 'Region',
        onchange: (e) => actions.onFilterChange?.({ region: e.target.value, page: 1 }),
      },
      ...REGIONS.map((r) => el('option', { value: r, selected: f.region === r, text: r === 'all' ? 'All Regions' : r })),
    ),
    el(
      'select',
      {
        class: 'mkt-select',
        'aria-label': 'Quality',
        onchange: (e) => actions.onFilterChange?.({ quality: e.target.value, page: 1 }),
      },
      ...ITEM_QUALITIES.map((q) => el('option', { value: q, selected: f.quality === q, text: q === 'all' ? 'Any Quality' : q })),
    ),
    el(
      'select',
      {
        class: 'mkt-select',
        'aria-label': 'Sort order',
        onchange: (e) => actions.onFilterChange?.({ sort: e.target.value, page: 1 }),
      },
      el('option', { value: 'price_asc', selected: f.sort === 'price_asc', text: 'Price: Low → High' }),
      el('option', { value: 'price_desc', selected: f.sort === 'price_desc', text: 'Price: High → Low' }),
      el('option', { value: 'ending_soon', selected: f.sort === 'ending_soon', text: 'Ending Soon' }),
      el('option', { value: 'newest', selected: f.sort === 'newest', text: 'Newest First' }),
      el('option', { value: 'qty_desc', selected: f.sort === 'qty_desc', text: 'Largest Stack' }),
    ),
    el('button', { type: 'button', class: 'mkt-btn', onclick: () => actions.onRefresh?.() }, 'Refresh'),
  );

  const tbody = el('tbody');
  for (const l of page.items || []) {
    const qty = Math.max(1, Math.min(l.remainingQuantity, Number(ui.buyQty?.[l.id]) || 1));
    const totalCost = qty * l.unitPrice;
    const isOwn = ui.character?.id != null && Number(l.sellerCharacterId) === Number(ui.character.id);
    const canAfford = totalCost <= gold;
    tbody.append(
      el(
        'tr',
        { 'data-listing-id': l.id },
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-item-cell' },
            el('span', { class: 'mkt-item-name', text: l.item?.name || 'Item' }),
            el(
              'span',
              { class: 'mkt-item-meta' },
              ...renderItemTags(l.item, { houseTrader: l.houseTrader }),
              `${l.sellerName} · ${l.town || l.region}`,
            ),
          ),
        ),
        el('td', { class: 'mkt-num', text: `×${l.remainingQuantity}` }),
        el('td', { class: 'mkt-num mkt-price', text: formatGold(l.unitPrice) }),
        el('td', { class: 'mkt-num', text: formatGold(totalCost) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(l.expiresAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            l.remainingQuantity > 1
              ? el('input', {
                  type: 'number',
                  class: 'mkt-input mkt-input-num',
                  min: 1,
                  max: l.remainingQuantity,
                  value: qty,
                  'aria-label': `Buy quantity for ${l.item?.name}`,
                  oninput: (e) => actions.onBuyQtyChange?.(l.id, Math.max(1, Math.min(l.remainingQuantity, Math.trunc(Number(e.target.value)) || 1))),
                })
              : null,
            el(
              'button',
              {
                type: 'button',
                class: 'mkt-btn mkt-btn-primary',
                disabled: ui.busy || isOwn || !canAfford,
                onclick: () => actions.onBuyListing?.(l, qty),
              },
              isOwn ? 'Yours' : `Buy (${formatGold(totalCost)})`,
            ),
          ),
        ),
      ),
    );
  }

  const listingsPanel = el(
    'section',
    { class: 'mkt-panel' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Town Market Board Listings' }),
      el('span', { class: 'mkt-badge', text: `${page.total || 0} active` }),
    ),
    filterBar,
    page.items?.length
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: 'Item / Seller' }),
                el('th', { class: 'mkt-num', text: 'Qty' }),
                el('th', { class: 'mkt-num', text: 'Unit' }),
                el('th', { class: 'mkt-num', text: 'Total' }),
                el('th', { class: 'mkt-num', text: 'Expires' }),
                el('th', { class: 'mkt-num', text: 'Action' }),
              ),
            ),
            tbody,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'No matching fixed-price listings right now.' }),
    el(
      'div',
      { class: 'mkt-pager' },
      el('span', { text: `Page ${page.page || 1} of ${page.totalPages || 1} · Revision-locked checkout` }),
      el(
        'div',
        { class: 'mkt-actions-cell' },
        el('button', {
          type: 'button',
          class: 'mkt-btn',
          disabled: (page.page || 1) <= 1,
          onclick: () => actions.onFilterChange?.({ page: Math.max(1, (page.page || 1) - 1) }),
        }, 'Prev'),
        el('button', {
          type: 'button',
          class: 'mkt-btn',
          disabled: !page.hasMore,
          onclick: () => actions.onFilterChange?.({ page: (page.page || 1) + 1 }),
        }, 'Next'),
      ),
    ),
  );

  // Side Create Listing Form with Fee & Tax Quote
  const lf = ui.listForm;
  const selectedItem = eligibleInventory.find((it) => it.id === lf.itemId) || eligibleInventory[0] || null;
  const qty = selectedItem ? Math.max(1, Math.min(selectedItem.quantity, Number(lf.quantity) || 1)) : 1;
  const unitPrice = Math.max(1, Math.trunc(Number(lf.unitPrice) || 1));
  const gross = unitPrice * qty;
  const fee = Math.max(1, Math.floor(gross * 0.02));
  const tax = Math.floor(gross * 0.05);

  const createPanel = el(
    'aside',
    { class: 'mkt-panel mkt-panel-verdigris' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Post Fixed-Price Listing' }),
      el('span', { class: 'mkt-badge', text: 'Escrow' }),
    ),
    el(
      'div',
      { class: 'mkt-form' },
      el(
        'label',
        { class: 'mkt-field' },
        el('span', { class: 'mkt-field-label', text: 'Eligible Pack Item' }),
        el(
          'select',
          {
            class: 'mkt-select',
            onchange: (e) => actions.onListFormChange?.({ itemId: e.target.value, quantity: 1 }),
          },
          ...(eligibleInventory.length
            ? eligibleInventory.map((it) =>
                el('option', {
                  value: it.id,
                  selected: selectedItem?.id === it.id,
                  text: `${it.name}${it.quantity > 1 ? ` (×${it.quantity})` : ''}`,
                }),
              )
            : [el('option', { value: '', text: 'No eligible items in pack' })]),
        ),
      ),
      el(
        'div',
        { class: 'mkt-form-row' },
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Quantity' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            min: 1,
            max: selectedItem?.quantity || 1,
            value: qty,
            oninput: (e) => actions.onListFormChange?.({ quantity: Math.max(1, Math.trunc(Number(e.target.value)) || 1) }),
          }),
        ),
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Unit Price (g)' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            min: 1,
            value: unitPrice,
            oninput: (e) => actions.onListFormChange?.({ unitPrice: Math.max(1, Math.trunc(Number(e.target.value)) || 1) }),
          }),
        ),
      ),
      el(
        'div',
        { class: 'mkt-quote-box' },
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Gross Total' }), el('span', { text: formatGold(gross) })),
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Upfront Listing Fee (2%)' }), el('span', { text: `-${formatGold(fee)}` })),
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Sale Tax on Fill (5%)' }), el('span', { text: `-${formatGold(tax)}` })),
        el('div', { class: 'mkt-quote-line is-total' }, el('span', { text: 'Net Proceeds on Sale' }), el('span', { text: formatGold(gross - tax) })),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'mkt-btn mkt-btn-primary',
          disabled: ui.busy || !selectedItem || gold < fee,
          onclick: () => selectedItem && actions.onCreateListing?.({ itemId: selectedItem.id, quantity: qty, unitPrice }),
        },
        `Escrow & List (${formatGold(fee)} Fee)`,
      ),
    ),
  );

  return el('div', { class: 'mkt-grid-2' }, listingsPanel, createPanel);
}

function renderAuctionsView(ui, actions, eligibleInventory, gold, nowMs) {
  const page = ui.auctions || { items: [], total: 0 };
  const singleItems = eligibleInventory.filter((it) => !it.stackable || it.quantity === 1);
  const af = ui.auctionForm;
  const selectedItem = singleItems.find((it) => it.id === af.itemId) || singleItems[0] || null;

  const tbody = el('tbody');
  for (const a of page.items || []) {
    const minNext = a.minNextBid || a.startPrice;
    const bidVal = Math.max(minNext, Number(ui.bidAmount?.[a.id]) || minNext);
    const isOwn = ui.character?.id != null && Number(a.sellerCharacterId) === Number(ui.character.id);
    const isHigh = ui.character?.id != null && Number(a.highBidderCharacterId) === Number(ui.character.id);
    const nearClose = a.endsAt - nowMs <= 2 * 60 * 1000;

    tbody.append(
      el(
        'tr',
        { 'data-auction-id': a.id },
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-item-cell' },
            el('span', { class: 'mkt-item-name', text: a.item?.name || 'Auction Item' }),
            el(
              'span',
              { class: 'mkt-item-meta' },
              ...renderItemTags(a.item, { antiSnipe: nearClose || a.extensions > 0 }),
              `${a.sellerName} · ${a.bidCount} bid${a.bidCount === 1 ? '' : 's'}${a.hasReserve ? (a.reserveMet ? ' · Reserve met' : ' · Reserve unmet') : ''}`,
            ),
          ),
        ),
        el('td', { class: 'mkt-num mkt-price', text: a.highBid > 0 ? formatGold(a.highBid) : `Start ${formatGold(a.startPrice)}` }),
        el('td', { class: 'mkt-num', text: a.buyoutPrice ? formatGold(a.buyoutPrice) : '—' }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(a.endsAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            el('input', {
              type: 'number',
              class: 'mkt-input mkt-input-num',
              min: minNext,
              value: bidVal,
              'aria-label': `Bid for ${a.item?.name}`,
              oninput: (e) => actions.onBidAmountChange?.(a.id, Math.max(minNext, Math.trunc(Number(e.target.value)) || minNext)),
            }),
            el(
              'button',
              {
                type: 'button',
                class: 'mkt-btn mkt-btn-primary',
                disabled: ui.busy || isOwn || isHigh || gold < bidVal,
                onclick: () => actions.onPlaceBid?.(a, bidVal),
              },
              isOwn ? 'Yours' : (isHigh ? 'Leading' : 'Bid'),
            ),
            a.buyoutPrice
              ? el(
                  'button',
                  {
                    type: 'button',
                    class: 'mkt-btn',
                    disabled: ui.busy || isOwn || gold < a.buyoutPrice,
                    onclick: () => actions.onBuyoutAuction?.(a),
                  },
                  'Buyout',
                )
              : null,
          ),
        ),
      ),
    );
  }

  const listPanel = el(
    'section',
    { class: 'mkt-panel' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Active Timed Auctions' }),
      el('span', { class: 'mkt-badge', text: `${page.total || 0} open · 2m anti-snipe` }),
    ),
    page.items?.length
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: 'Item / Status' }),
                el('th', { class: 'mkt-num', text: 'Current Bid' }),
                el('th', { class: 'mkt-num', text: 'Buyout' }),
                el('th', { class: 'mkt-num', text: 'Time Left' }),
                el('th', { class: 'mkt-num', text: 'Bid / Buyout' }),
              ),
            ),
            tbody,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'No active timed auctions at this board.' }),
  );

  const startPrice = Math.max(1, Math.trunc(Number(af.startPrice) || 50));
  const reservePrice = af.reservePrice ? Math.max(startPrice, Math.trunc(Number(af.reservePrice))) : startPrice;
  const fee = Math.max(1, Math.floor(Math.max(startPrice, reservePrice) * 0.02));

  const createPanel = el(
    'aside',
    { class: 'mkt-panel mkt-panel-verdigris' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Start Timed Auction' }),
      el('span', { class: 'mkt-badge', text: 'Single Item' }),
    ),
    el(
      'div',
      { class: 'mkt-form' },
      el(
        'label',
        { class: 'mkt-field' },
        el('span', { class: 'mkt-field-label', text: 'Individual Eligible Item' }),
        el(
          'select',
          {
            class: 'mkt-select',
            onchange: (e) => actions.onAuctionFormChange?.({ itemId: e.target.value }),
          },
          ...(singleItems.length
            ? singleItems.map((it) => el('option', { value: it.id, selected: selectedItem?.id === it.id, text: it.name }))
            : [el('option', { value: '', text: 'No individual eligible items' })]),
        ),
      ),
      el(
        'div',
        { class: 'mkt-form-row' },
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Starting Bid (g)' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            min: 1,
            value: startPrice,
            oninput: (e) => actions.onAuctionFormChange?.({ startPrice: Math.max(1, Math.trunc(Number(e.target.value)) || 1) }),
          }),
        ),
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Reserve (opt)' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            placeholder: String(startPrice),
            value: af.reservePrice ?? '',
            oninput: (e) => actions.onAuctionFormChange?.({ reservePrice: e.target.value }),
          }),
        ),
      ),
      el(
        'label',
        { class: 'mkt-field' },
        el('span', { class: 'mkt-field-label', text: 'Buyout Price (optional)' }),
        el('input', {
          type: 'number',
          class: 'mkt-input',
          placeholder: 'Leave blank for no buyout',
          value: af.buyoutPrice ?? '',
          oninput: (e) => actions.onAuctionFormChange?.({ buyoutPrice: e.target.value }),
        }),
      ),
      el(
        'div',
        { class: 'mkt-quote-box' },
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Listing Fee (2%)' }), el('span', { text: formatGold(fee) })),
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Anti-Snipe Extension' }), el('span', { text: '+2m if bid < 2m left' })),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'mkt-btn mkt-btn-primary',
          disabled: ui.busy || !selectedItem || gold < fee,
          onclick: () => selectedItem && actions.onCreateAuction?.({
            itemId: selectedItem.id,
            startPrice,
            ...(af.reservePrice ? { reservePrice: Number(af.reservePrice) } : {}),
            ...(af.buyoutPrice ? { buyoutPrice: Number(af.buyoutPrice) } : {}),
          }),
        },
        `Post Auction (${formatGold(fee)} Fee)`,
      ),
    ),
  );

  return el('div', { class: 'mkt-grid-2' }, listPanel, createPanel);
}

function renderOrdersView(ui, actions, eligibleInventory, gold, nowMs) {
  const page = ui.orders || { items: [], total: 0 };
  const of = ui.orderForm;

  const tbody = el('tbody');
  for (const o of page.items || []) {
    const matches = eligibleInventory.filter((it) => it.template === o.template);
    const picked = matches.find((it) => it.id === ui.fillItem?.[o.id]) || matches[0] || null;
    const maxFill = picked ? Math.min(picked.quantity, o.remainingQuantity) : 0;
    const fillQty = maxFill > 0 ? Math.max(1, Math.min(maxFill, Number(ui.fillQty?.[o.id]) || maxFill)) : 0;
    const isOwn = ui.character?.id != null && Number(o.buyerCharacterId) === Number(ui.character.id);

    tbody.append(
      el(
        'tr',
        { 'data-order-id': o.id },
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-item-cell' },
            el('span', { class: 'mkt-item-name', text: o.itemName || o.template }),
            el('span', { class: 'mkt-item-meta', text: `Buyer: ${o.buyerName} · ${o.town || o.region} · ${o.template}` }),
          ),
        ),
        el('td', { class: 'mkt-num', text: `${o.remainingQuantity} / ${o.initialQuantity}` }),
        el('td', { class: 'mkt-num mkt-price', text: formatGold(o.unitPrice) }),
        el('td', { class: 'mkt-num', text: formatGold(o.remainingEscrowGold) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(o.expiresAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            picked && !isOwn
              ? [
                  maxFill > 1
                    ? el('input', {
                        type: 'number',
                        class: 'mkt-input mkt-input-num',
                        min: 1,
                        max: maxFill,
                        value: fillQty,
                        oninput: (e) => actions.onFillQtyChange?.(o.id, Math.max(1, Math.min(maxFill, Math.trunc(Number(e.target.value)) || 1))),
                      })
                    : null,
                  el(
                    'button',
                    {
                      type: 'button',
                      class: 'mkt-btn mkt-btn-primary',
                      disabled: ui.busy,
                      onclick: () => actions.onFillOrder?.(o, picked.id, fillQty),
                    },
                    `Deliver ×${fillQty}`,
                  ),
                ]
              : el('span', { class: 'mkt-item-meta', text: isOwn ? 'Your order' : 'Not in pack' }),
          ),
        ),
      ),
    );
  }

  const listPanel = el(
    'section',
    { class: 'mkt-panel' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Funded Buy Orders' }),
      el('span', { class: 'mkt-badge', text: `${page.total || 0} funded` }),
    ),
    page.items?.length
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: 'Wanted Item / Buyer' }),
                el('th', { class: 'mkt-num', text: 'Remaining' }),
                el('th', { class: 'mkt-num', text: 'Offer/Unit' }),
                el('th', { class: 'mkt-num', text: 'Escrowed' }),
                el('th', { class: 'mkt-num', text: 'Expires' }),
                el('th', { class: 'mkt-num', text: 'Fulfill' }),
              ),
            ),
            tbody,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'No active buy orders right now.' }),
  );

  const qty = Math.max(1, Math.trunc(Number(of.quantity) || 1));
  const unitPrice = Math.max(1, Math.trunc(Number(of.unitPrice) || 1));
  const totalEscrow = qty * unitPrice;

  const createPanel = el(
    'aside',
    { class: 'mkt-panel mkt-panel-verdigris' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Post Funded Buy Order' }),
      el('span', { class: 'mkt-badge', text: 'Gold Escrowed' }),
    ),
    el(
      'div',
      { class: 'mkt-form' },
      el(
        'label',
        { class: 'mkt-field' },
        el('span', { class: 'mkt-field-label', text: 'Catalog Template' }),
        el('input', {
          type: 'text',
          class: 'mkt-input',
          value: of.template || 'arrow',
          placeholder: 'e.g. arrow, potion-of-healing, ruby',
          oninput: (e) => actions.onOrderFormChange?.({ template: e.target.value }),
        }),
      ),
      el(
        'div',
        { class: 'mkt-form-row' },
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Quantity' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            min: 1,
            value: qty,
            oninput: (e) => actions.onOrderFormChange?.({ quantity: Math.max(1, Math.trunc(Number(e.target.value)) || 1) }),
          }),
        ),
        el(
          'label',
          { class: 'mkt-field' },
          el('span', { class: 'mkt-field-label', text: 'Offer / Unit (g)' }),
          el('input', {
            type: 'number',
            class: 'mkt-input',
            min: 1,
            value: unitPrice,
            oninput: (e) => actions.onOrderFormChange?.({ unitPrice: Math.max(1, Math.trunc(Number(e.target.value)) || 1) }),
          }),
        ),
      ),
      el(
        'div',
        { class: 'mkt-quote-box' },
        el('div', { class: 'mkt-quote-line is-total' }, el('span', { text: 'Total Gold to Escrow' }), el('span', { text: formatGold(totalEscrow) })),
        el('div', { class: 'mkt-quote-line' }, el('span', { text: 'Partial Fills' }), el('span', { text: 'Enabled · Claims delivery' })),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'mkt-btn mkt-btn-primary',
          disabled: ui.busy || !of.template || gold < totalEscrow,
          onclick: () => actions.onCreateOrder?.({ template: of.template, quantity: qty, unitPrice }),
        },
        `Escrow ${formatGold(totalEscrow)} & Post`,
      ),
    ),
  );

  return el('div', { class: 'mkt-grid-2' }, listPanel, createPanel);
}

function renderMyView(ui, actions, nowMs) {
  const my = ui.my || {};
  const usage = my.usage || { listings: 0, auctions: 0, bids: 0, buyOrders: 0, total: 0, caps: { listings: 20, auctions: 10, buyOrders: 10, total: 30 } };
  const claims = my.claims || [];

  const capCard = (label, cur, cap) => el(
    'div',
    { class: 'mkt-cap-card' },
    el('div', { class: 'mkt-cap-label' }, el('span', { text: label }), el('span', { text: `${cur} / ${cap}` })),
    el('div', { class: 'mkt-cap-bar' }, el('div', { class: 'mkt-cap-fill', style: `width:${Math.min(100, Math.round((cur / Math.max(1, cap)) * 100))}%` })),
  );

  // Offline Claims Inbox Panel (Verdigris accent)
  const claimsRows = el('tbody');
  for (const c of claims) {
    claimsRows.append(
      el(
        'tr',
        { 'data-claim-id': c.id },
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-item-cell' },
            el('span', {
              class: 'mkt-item-name',
              text: c.item
                ? `${c.item.name}${c.item.quantity > 1 ? ` ×${c.item.quantity}` : ''}`
                : `Gold Payout (${formatGold(c.gold)})`,
            }),
            el('span', { class: 'mkt-item-meta', text: c.reason || c.kind }),
          ),
        ),
        el('td', { class: 'mkt-num mkt-price', text: c.gold > 0 ? formatGold(c.gold) : 'Item' }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            el(
              'button',
              {
                type: 'button',
                class: 'mkt-btn mkt-btn-primary',
                disabled: ui.busy,
                onclick: () => actions.onClaimOne?.(c.id),
              },
              'Collect',
            ),
          ),
        ),
      ),
    );
  }

  const claimsPanel = el(
    'section',
    { class: 'mkt-panel mkt-panel-verdigris' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Offline Claims & Payouts Inbox' }),
      el(
        'div',
        { class: 'mkt-actions-cell' },
        el('span', { class: `mkt-badge${claims.length ? ' is-ok' : ''}`, text: `${claims.length} pending` }),
        claims.length
          ? el(
              'button',
              {
                type: 'button',
                class: 'mkt-btn mkt-btn-primary',
                disabled: ui.busy,
                onclick: () => actions.onClaimAll?.(),
              },
              'Collect All',
            )
          : null,
      ),
    ),
    claims.length
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el(
              'thead',
              {},
              el('tr', {}, el('th', { text: 'Claim / Reason' }), el('th', { class: 'mkt-num', text: 'Value' }), el('th', { class: 'mkt-num', text: 'Action' })),
            ),
            claimsRows,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'No pending claims. Sales proceeds, won auctions, and refunds arrive here even while offline.' }),
  );

  // Active Obligations Table
  const obRows = el('tbody');
  for (const l of my.listings || []) {
    obRows.append(
      el(
        'tr',
        {},
        el('td', {}, el('span', { class: 'mkt-tag', text: 'Listing' }), l.item?.name, ` ×${l.remainingQuantity}`),
        el('td', { class: 'mkt-num mkt-price', text: `${formatGold(l.unitPrice)} / ea` }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(l.expiresAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            el('button', { type: 'button', class: 'mkt-btn mkt-btn-danger', disabled: ui.busy, onclick: () => actions.onCancelListing?.(l.id) }, 'Cancel'),
          ),
        ),
      ),
    );
  }
  for (const a of my.auctions || []) {
    obRows.append(
      el(
        'tr',
        {},
        el('td', {}, el('span', { class: 'mkt-tag is-snipe', text: 'Auction' }), a.item?.name, ` (${a.bidCount} bids)`),
        el('td', { class: 'mkt-num mkt-price', text: a.highBid > 0 ? formatGold(a.highBid) : formatGold(a.startPrice) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(a.endsAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            a.bidCount === 0
              ? el('button', { type: 'button', class: 'mkt-btn mkt-btn-danger', disabled: ui.busy, onclick: () => actions.onCancelAuction?.(a.id) }, 'Cancel')
              : el('span', { class: 'mkt-item-meta', text: 'Has bids' }),
          ),
        ),
      ),
    );
  }
  for (const b of my.bids || []) {
    obRows.append(
      el(
        'tr',
        {},
        el('td', {}, el('span', { class: 'mkt-tag is-trader', text: 'High Bid' }), b.item?.name),
        el('td', { class: 'mkt-num mkt-price', text: formatGold(b.highBid) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(b.endsAt, nowMs) }),
        el('td', { class: 'mkt-num', text: 'Escrowed' }),
      ),
    );
  }
  for (const o of my.orders || []) {
    obRows.append(
      el(
        'tr',
        {},
        el('td', {}, el('span', { class: 'mkt-tag is-crafted', text: 'Buy Order' }), `${o.itemName} ×${o.remainingQuantity}`),
        el('td', { class: 'mkt-num mkt-price', text: formatGold(o.remainingEscrowGold) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(o.expiresAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            el('button', { type: 'button', class: 'mkt-btn mkt-btn-danger', disabled: ui.busy, onclick: () => actions.onCancelOrder?.(o.id) }, 'Cancel'),
          ),
        ),
      ),
    );
  }

  const obligationsPanel = el(
    'section',
    { class: 'mkt-panel' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: 'Account Obligations & Active Orders' }),
      el('span', { class: 'mkt-badge', text: `${usage.total} / ${usage.caps.total} account-wide` }),
    ),
    el(
      'div',
      { class: 'mkt-cap-grid' },
      capCard('Listings', usage.listings, usage.caps.listings),
      capCard('Auctions', usage.auctions, usage.caps.auctions),
      capCard('Buy Orders', usage.buyOrders, usage.caps.buyOrders),
      capCard('Total Active', usage.total, usage.caps.total),
    ),
    obRows.childElementCount > 0
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el('thead', {}, el('tr', {}, el('th', { text: 'Obligation' }), el('th', { class: 'mkt-num', text: 'Value' }), el('th', { class: 'mkt-num', text: 'Remaining' }), el('th', { class: 'mkt-num', text: 'Action' }))),
            obRows,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'No active listings, bids, or buy orders.' }),
  );

  return el('div', { class: 'mkt-grid-2' }, claimsPanel, obligationsPanel);
}

function renderTraderView(ui, actions, gold, nowMs) {
  const tr = ui.trader;
  if (!tr || !tr.trader) {
    return el(
      'section',
      { class: 'mkt-panel' },
      el('div', { class: 'mkt-panel-head' }, el('h3', { class: 'mkt-h', text: 'House Trader' })),
      el('p', { class: 'mkt-empty', text: 'Approach a placed House Trader inside a residence to browse vendor stock or assign your listings.' }),
    );
  }

  const info = tr.trader;
  const isOwner = ui.character?.id != null && Number(info.ownerCharacterId) === Number(ui.character.id);
  const unassignedOwn = (ui.my?.listings ?? []).filter((l) => !l.houseTrader || l.houseTrader.traderId !== info.traderId);

  const tbody = el('tbody');
  for (const l of tr.items || []) {
    const qty = Math.max(1, Math.min(l.remainingQuantity, Number(ui.buyQty?.[l.id]) || 1));
    const cost = qty * l.unitPrice;
    tbody.append(
      el(
        'tr',
        {},
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-item-cell' },
            el('span', { class: 'mkt-item-name', text: l.item?.name || 'Item' }),
            el('span', { class: 'mkt-item-meta' }, ...renderItemTags(l.item, { houseTrader: l.houseTrader }), 'Shared public board & house escrow'),
          ),
        ),
        el('td', { class: 'mkt-num', text: `×${l.remainingQuantity}` }),
        el('td', { class: 'mkt-num mkt-price', text: formatGold(l.unitPrice) }),
        el('td', { class: 'mkt-num', text: formatTimeLeft(l.expiresAt, nowMs) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'mkt-actions-cell' },
            isOwner
              ? el('button', { type: 'button', class: 'mkt-btn mkt-btn-danger', disabled: ui.busy, onclick: () => actions.onDetachTrader?.(l.id) }, 'Detach')
              : el('button', { type: 'button', class: 'mkt-btn mkt-btn-primary', disabled: ui.busy || gold < cost, onclick: () => actions.onBuyFromTrader?.(l, info, qty) }, `Buy (${formatGold(cost)})`),
          ),
        ),
      ),
    );
  }

  const stockPanel = el(
    'section',
    { class: 'mkt-panel' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: `${info.label} · Stock` }),
      el('span', { class: 'mkt-badge is-ok', text: `${tr.items?.length || 0} stocked · No stock duplication` }),
    ),
    tr.items?.length
      ? el(
          'div',
          { class: 'mkt-table-wrap' },
          el(
            'table',
            { class: 'mkt-table' },
            el('thead', {}, el('tr', {}, el('th', { text: 'Item' }), el('th', { class: 'mkt-num', text: 'Qty' }), el('th', { class: 'mkt-num', text: 'Unit' }), el('th', { class: 'mkt-num', text: 'Expires' }), el('th', { class: 'mkt-num', text: 'Action' }))),
            tbody,
          ),
        )
      : el('p', { class: 'mkt-empty', text: 'This house trader has no assigned listings yet.' }),
  );

  const ownerPanel = el(
    'aside',
    { class: 'mkt-panel mkt-panel-verdigris' },
    el(
      'div',
      { class: 'mkt-panel-head' },
      el('h3', { class: 'mkt-h', text: isOwner ? 'Assign Listings to Trader' : 'Residence Vendor Info' }),
      el('span', { class: 'mkt-badge', text: info.access || 'public' }),
    ),
    isOwner
      ? el(
          'div',
          { class: 'mkt-form' },
          el('p', { class: 'mkt-subtitle', text: 'Assigned listings share your existing market escrow and also remain visible at town boards. Detach before selling your home.' }),
          ...(unassignedOwn.length
            ? unassignedOwn.map((l) =>
                el(
                  'div',
                  { class: 'mkt-quote-line' },
                  el('span', { text: `${l.item?.name} ×${l.remainingQuantity} (${formatGold(l.unitPrice)})` }),
                  el('button', { type: 'button', class: 'mkt-btn mkt-btn-primary', disabled: ui.busy, onclick: () => actions.onAssignTrader?.(l.id, info) }, 'Assign'),
                ),
              )
            : [el('p', { class: 'mkt-empty', text: 'All your active listings are already assigned or none exist.' })]),
        )
      : el('p', { class: 'mkt-subtitle', text: `Operated in ${info.town}, ${info.region}. Purchases settle atomically to your Offline Claims inbox with full stale-price protection.` }),
  );

  return el('div', { class: 'mkt-grid-2' }, stockPanel, ownerPanel);
}

/**
 * Mounts an interactive Market Panel bound to a gameplay `api` object (Wave 2B integration or standalone harness).
 */
export function mountMarketPanel(root, api, initialState = {}) {
  loadStyles();
  const ui = createDefaultMarketUiState(initialState);

  const syncCharacterFromApi = () => {
    const ch = api?.state?.character;
    if (!ch) return;
    ui.character = {
      id: api.state?.selfId ?? ch.id ?? ui.character.id,
      name: ch.character?.name || ch.name || ui.character.name,
      gold: Number(ch.gold) || 0,
      carriedKg: Number(ch.carriedWeight) || ui.character.carriedKg || 0,
      maxKg: Number(ch.maxEncumbrance) || ui.character.maxKg || 100,
      inventory: Array.isArray(ch.inventory) ? ch.inventory : [],
    };
  };

  const refreshActiveTab = () => {
    if (!api?.act) return;
    if (ui.tab === 'browse') api.act('market.browse', ui.filters);
    else if (ui.tab === 'auctions') api.act('market.auctions', { q: ui.filters.q, group: ui.filters.group, region: ui.filters.region });
    else if (ui.tab === 'orders') api.act('market.orders', { q: ui.filters.q, group: ui.filters.group, region: ui.filters.region });
    else if (ui.tab === 'my') api.act('market.my', {});
    else if (ui.tab === 'trader' && ui.trader?.trader) {
      api.act('market.trader.browse', { houseId: ui.trader.trader.houseId, traderId: ui.trader.trader.traderId });
    }
  };

  const rerender = () => {
    ui.nowMs = Date.now();
    syncCharacterFromApi();
    renderMarketPanel(root, ui, actions);
  };

  const actions = {
    onTab(tab) {
      ui.tab = tab;
      ui.notice = null;
      rerender();
      refreshActiveTab();
    },
    onRefresh() {
      ui.notice = null;
      refreshActiveTab();
      rerender();
    },
    onFilterChange(patch) {
      Object.assign(ui.filters, patch);
      refreshActiveTab();
      rerender();
    },
    onBuyQtyChange(id, qty) {
      ui.buyQty[id] = qty;
      rerender();
    },
    onBidAmountChange(id, amt) {
      ui.bidAmount[id] = amt;
      rerender();
    },
    onFillQtyChange(id, qty) {
      ui.fillQty[id] = qty;
      rerender();
    },
    onListFormChange(patch) {
      Object.assign(ui.listForm, patch);
      rerender();
    },
    onAuctionFormChange(patch) {
      Object.assign(ui.auctionForm, patch);
      rerender();
    },
    onOrderFormChange(patch) {
      Object.assign(ui.orderForm, patch);
      rerender();
    },
    onCreateListing(payload) {
      ui.busy = true;
      api?.act?.('market.list', { ...payload, opKey: genOpKey('list') });
      rerender();
    },
    onBuyListing(listing, quantity) {
      ui.busy = true;
      api?.act?.('market.buy', {
        listingId: listing.id,
        quantity,
        expectedRev: listing.revision,
        expectedUnitPrice: listing.unitPrice,
        opKey: genOpKey('buy'),
      });
      rerender();
    },
    onCancelListing(listingId) {
      ui.busy = true;
      api?.act?.('market.cancel', { listingId, opKey: genOpKey('cancel') });
      rerender();
    },
    onCreateAuction(payload) {
      ui.busy = true;
      api?.act?.('market.auction.create', { ...payload, opKey: genOpKey('auc') });
      rerender();
    },
    onPlaceBid(auction, amount) {
      ui.busy = true;
      api?.act?.('market.auction.bid', { auctionId: auction.id, amount, opKey: genOpKey('bid') });
      rerender();
    },
    onBuyoutAuction(auction) {
      ui.busy = true;
      api?.act?.('market.auction.buyout', { auctionId: auction.id, opKey: genOpKey('buyout') });
      rerender();
    },
    onCancelAuction(auctionId) {
      ui.busy = true;
      api?.act?.('market.auction.cancel', { auctionId, opKey: genOpKey('acancel') });
      rerender();
    },
    onCreateOrder(payload) {
      ui.busy = true;
      api?.act?.('market.order.create', { ...payload, opKey: genOpKey('ord') });
      rerender();
    },
    onFillOrder(order, itemId, quantity) {
      ui.busy = true;
      api?.act?.('market.order.fill', { orderId: order.id, itemId, quantity, expectedRev: order.revision, opKey: genOpKey('fill') });
      rerender();
    },
    onCancelOrder(orderId) {
      ui.busy = true;
      api?.act?.('market.order.cancel', { orderId, opKey: genOpKey('ocancel') });
      rerender();
    },
    onClaimOne(claimId) {
      ui.busy = true;
      api?.act?.('market.claim', { claimId, opKey: genOpKey('claim') });
      rerender();
    },
    onClaimAll() {
      ui.busy = true;
      api?.act?.('market.claimAll', {});
      rerender();
    },
    onAssignTrader(listingId, trader) {
      ui.busy = true;
      api?.act?.('market.trader.assign', { listingId, houseId: trader.houseId, traderId: trader.traderId, opKey: genOpKey('tassign') });
      rerender();
    },
    onDetachTrader(listingId) {
      ui.busy = true;
      api?.act?.('market.trader.detach', { listingId, opKey: genOpKey('tdetach') });
      rerender();
    },
    onBuyFromTrader(listing, trader, quantity) {
      ui.busy = true;
      api?.act?.('market.trader.buy', {
        listingId: listing.id,
        houseId: trader.houseId,
        traderId: trader.traderId,
        quantity,
        expectedRev: listing.revision,
        expectedUnitPrice: listing.unitPrice,
        opKey: genOpKey('tbuy'),
      });
      rerender();
    },
  };

  function handleEvent(ev) {
    if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('market.')) return;
    if (ev.kind === 'market.boards') {
      ui.board = ev.current ?? ui.board;
    } else if (ev.kind === 'market.browse') {
      ui.board = ev.board ?? ui.board;
      ui.browse = ev;
    } else if (ev.kind === 'market.auctions') {
      ui.board = ev.board ?? ui.board;
      ui.auctions = ev;
    } else if (ev.kind === 'market.orders') {
      ui.board = ev.board ?? ui.board;
      ui.orders = ev;
    } else if (ev.kind === 'market.my') {
      ui.board = ev.board ?? ui.board;
      ui.my = ev;
    } else if (ev.kind === 'market.claims') {
      ui.my = { ...ui.my, claims: ev.claims || [] };
    } else if (ev.kind === 'market.trader') {
      ui.trader = ev;
      ui.tab = 'trader';
    } else if (ev.kind === 'market.result') {
      ui.busy = false;
      if (ev.ok) {
        ui.notice = { kind: 'info', text: 'Market transaction committed.' };
        refreshActiveTab();
      } else if (ev.code === 'STALE_QUOTE' || ev.code === 'STALE_PRICE' || ev.code === 'INSUFFICIENT_STOCK') {
        ui.notice = { kind: 'stale', text: ev.error || 'Quote changed; refresh and confirm.', freshQuote: ev.freshQuote };
      } else {
        ui.notice = { kind: 'error', text: ev.error || 'Market action failed.' };
      }
    }
    rerender();
  }

  rerender();

  return {
    state: ui,
    rerender,
    refresh: refreshActiveTab,
    handleEvent,
    resetPrivateState() {
      ui.my = createDefaultMarketUiState().my;
      ui.trader = null;
      ui.notice = null;
      ui.busy = false;
      rerender();
    },
  };
}

/**
 * Standard client gameplay feature installer for Wave 2B (`client/gameplay/features.js`).
 */
export function install(api) {
  loadStyles();
  let mounted = null;
  let container = null;

  const ensureMounted = (root) => {
    container = root;
    mounted = mountMarketPanel(root, api);
    mounted.refresh();
    api.act?.('market.my', {});
  };

  api.on?.('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('market.')) return;
    if (ev.kind === 'market.notice' && ev.text) {
      api.message?.(ev.text);
      return;
    }
    if (ev.kind === 'market.trader' && api.panel !== PANEL) {
      api.openPanel?.(PANEL);
    }
    mounted?.handleEvent(ev);
  });

  api.on?.('state', () => {
    if (api.panel === PANEL && container?.isConnected) mounted?.rerender();
  });

  api.on?.('characterChange', () => mounted?.resetPrivateState());
  api.on?.('disconnect', () => mounted?.resetPrivateState());

  api.registerPanel?.(PANEL, 'Market', (root) => ensureMounted(root));

  return {
    openMarket(tab = 'browse') {
      api.openPanel?.(PANEL);
      if (mounted) {
        mounted.state.tab = tab;
        mounted.refresh();
        mounted.rerender();
      }
    },
  };
}

export default { PANEL, install, mountMarketPanel, renderMarketPanel };
