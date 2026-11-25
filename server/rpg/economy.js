// Shop shelves and the regional economy (docs/shops-and-economy.md).
//
// Classic shops sell from their shelves: every shelf prop of a shop building (DaggerfallInterior.AddFurnitureAction)
// is a container stocked by DaggerfallLoot.StockShopShelf. Here a player inside a shop walks to a shelf, browses it
// (G / `shop.shelf`) and buys from it (`shop.take`). The goods, the merchant's purse and the player's gold are the same
// shared ledger the shopkeeper's counter uses (server/rpg/npcs.js, `services.shopLedger`), saved in the same transaction.
// Taking goods while nobody minds the shop is shoplifting and belongs to the law feature.
//
// Actions
//   shop.shelves {}                                  re-send the shelves of the shop the player is in (empty list elsewhere)
//   shop.shelf   {shelf}                             browse one shelf (must stand at it)
//   shop.take    {shelf, key, quantity, price}       buy from that shelf at once; `price` is the unit price shown
//   shop.pick    {shelf, key, quantity, price}       classic: put goods from that shelf in your basket (unpaid)
//   shop.unpick  {key, quantity?}                    put a basket line (or part of it) back on its shelf
//   shop.basket  {}                                  re-send your basket
//   shop.pay     {basket, seq, total, targetId?, session?}
//                                                    pay the shopkeeper for the basket at the counter; with the
//                                                    conversation's {targetId, session} it is the checkout reply
//   shop.steal   {basket, seq}                       walk off with the basket (package 14 decides if you are seen)
// Events (private)
//   {kind:'shop.shelves', location, shop, quality, shelves:[{shelf, x, y, z, r}]}  on entering a shop and on request
//   {kind:'shop.shelf', location, shelf, rev, quality, market, gold, keeper, items:[{key,name,quantity,price,icon,variant}]}
//   {kind:'shop.closed', location}                   the player left the shop
//   {kind:'shop.basket', location, basket, seq, keeper, lines:[{key,name,quantity,icon,variant,shelf,price}], total,
//     gold, count, text?}                            your own basket only (others see just the shelf quantities)
// Services
//   regionalPrice(p, cost)        FormulaHelper.ApplyRegionalPriceAdjustment for the player's current region
//   regionPriceAdjust(regionIndex) the shared per-mille adjustment today
//   priceContext(p, location, quality?) the full classic price context (Mercantile, Personality, region, holiday)
//   shopBasketFor(p, keeper)      {basket, seq, count, total, lines:[{name, quantity}]} of p's unpaid basket when `keeper`
//                                 minds the shop p stands in (the shopkeeper's dialogue view offers the checkout)

import { readFileSync } from 'node:fs';
import {
  applyRegional, basketLine, marketNote, priceAdjust, priceContext, regionIndexOf, setFactionPowers, tradePrice,
} from '../../client/gameplay/economy/rules.js';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { basketOf, pick, returnAll, settle, unpick } from './economy/basket.js';

export const name = 'economy';
export const SHELF_REACH = 1.75; // metres beyond the shelf's own half-width
const MAX_QUANTITY = 99;
/** Reach to pay at the counter: the shopkeeper's talk range (npcs TALK_RANGE 3.5 m) plus a step. */
export const COUNTER_REACH = 4;
/** A disconnected shopper's basket waits this long (real ms) for a reconnect before the goods go back. */
export const BASKET_GRACE_MS = 2 * 60_000;
/** A basket nobody touched for this long (real ms) goes back on the shelves, so nobody can hoard the last item. */
export const BASKET_IDLE_MS = 15 * 60_000;
const BASKET_RE = /^[a-z0-9]{1,40}$/;

function fail(msg) {
  throw new Error(msg);
}

export function install(ctx) {
  const services = ctx.services ?? (ctx.services = {});
  // DaggerfallTradeWindow pays with GetGoldAmount / DeductGoldAmount: carried gold and letters of credit (package 13's
  // services.spendableGold / spendGold). Without that feature, carried gold only.
  const spendable = (p) => (typeof services.spendableGold === 'function' ? services.spendableGold(p) : p.rpg.gold);
  const pay = (p, amount) => {
    if (typeof services.spendGold === 'function') services.spendGold(p, amount);
    else p.rpg.gold -= amount;
  };
  const minutes = () => {
    const m = services.worldClock?.()?.minutes;
    return Number.isFinite(m) ? m : null;
  };
  // FormulaHelper.UpdateRegionalPrices: The Merchants' power against each province's, from the operator's FACTION.TXT.
  try {
    if (typeof ctx.dataFile === 'function') setFactionPowers(parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1')));
  } catch { /* no game data: the power term stays 0 */ }
  const browsing = new Map(); // player id -> {location, shelf}
  const announced = new Map(); // player id -> location last announced

  const ledger = () => services.shopLedger ?? null;
  const metaOf = (location) => {
    try {
      return services.portals?.into?.(location)?.meta ?? null;
    } catch {
      return null;
    }
  };
  const shelvesAt = (location) => {
    const meta = metaOf(location);
    return Array.isArray(meta?.shelves) && meta.shelves.length ? meta.shelves : null;
  };

  // ------------------------------------------------------------------ services

  services.regionPriceAdjust = (regionIndex) => priceAdjust(regionIndex, minutes());
  services.regionalPrice = (p, cost) => applyRegional(cost, priceAdjust(regionIndexOf(ctx.location(p)), minutes()));
  /**
   * CalculateTradePrice's player inputs: live Mercantile (GetLiveSkillValue: conditions, blessings, EnhancesSkill) and
   * live Personality (LivePersonality: magic, condition penalties, blessings), from the character feature. Null fields
   * fall back to the stored character in priceContext. Shared by shelves, the counter, repairs, temples and spell sellers.
   */
  services.tradeInputs = (p) => {
    if (!p?.rpg?.character) return { mercantile: null, personality: null };
    const m = typeof services.skillValue === 'function' ? Number(services.skillValue(p, 'Mercantile')) : NaN;
    const a = typeof services.attributeValue === 'function' ? Number(services.attributeValue(p, 'Personality')) : NaN;
    return { mercantile: Number.isFinite(m) ? Math.trunc(m) : null, personality: Number.isFinite(a) && a > 0 ? Math.trunc(a) : null };
  };
  services.priceContext = (p, location = ctx.location(p), quality) => priceContext({
    quality, regionIndex: regionIndexOf(location), minutes: minutes(), character: p?.rpg?.character ?? null, ...services.tradeInputs(p),
  });

  // ------------------------------------------------------------------ views

  function shelvesEvent(p) {
    const location = ctx.location(p);
    const shelves = shelvesAt(location);
    if (!shelves) return null;
    const meta = metaOf(location);
    return {
      kind: 'shop.shelves', location, shop: meta.buildingName ?? null, quality: meta.quality ?? null,
      shelves: shelves.map((s) => ({ shelf: s.number, x: s.x, y: s.y, z: s.z, r: s.r })),
    };
  }

  function announce(p) {
    const location = ctx.location(p);
    if (announced.get(p.id) === location) return;
    const prev = browsing.get(p.id);
    if (prev && prev.location !== location) {
      browsing.delete(p.id);
      ctx.notify(p, { kind: 'shop.closed', location: prev.location });
    }
    const ev = shelvesEvent(p);
    // An interior not surveyed yet (a reconnect or restart inside it): ask again on a later tick.
    if (!ev && String(location).startsWith('interior:') && !metaOf(location)) return;
    announced.set(p.id, location);
    if (ev) ctx.notify(p, ev);
    // A reconnect (or restart) inside the shop finds its basket where it left it.
    const shop = ev ? ledger()?.peek(location) : null;
    if (shop && basketOf(shop, p.id)?.lines.size) {
      sendBasket(p, location);
      talkBack(p, location); // a conversation opened before this announce shows the checkout reply now
    }
  }

  /** The shelf `n` the player stands at, the shop's keeper and the ledger, validated. */
  function atShelf(p, n) {
    if (!Number.isInteger(n) || n < 1 || n > 64) fail('Which shelf?');
    const location = ctx.location(p);
    const shelves = shelvesAt(location);
    if (!shelves) fail('There are no shop shelves here.');
    const shelf = shelves.find((s) => s.number === n);
    if (!shelf) fail('There is no such shelf here.');
    const d = Math.hypot(shelf.x - p.x, shelf.z - p.z);
    if (!(d <= shelf.r + SHELF_REACH)) fail(`You must stand at the shelf (${Math.round(d)} m away).`);
    if (Number.isFinite(p.y) && Number.isFinite(shelf.y) && Math.abs(p.y - shelf.y) > 2.5) fail('That shelf is on another floor.');
    const L = ledger();
    if (!L) fail('Trading is unavailable right now.');
    const keeper = L.keeperAt(location);
    return { location, shelf, keeper, L };
  }

  function shelfView(p, { location, shelf, keeper, L }, text = null) {
    if (!keeper) {
      return { kind: 'shop.shelf', location, shelf: shelf.number, keeper: null, items: [], gold: p.rpg.gold, text: 'Nobody is minding the shop.' };
    }
    const shop = L.open(keeper, p);
    const econ = L.economy;
    const pc = econ.context(p, keeper, shop);
    const items = [...shop.stock].filter(([, it]) => it.shelf === shelf.number && it.quantity > 0).map(([key, it]) => ({
      key, name: it.name, quantity: it.quantity, icon: it.icon, variant: it.variant, price: econ.buyUnit(p, keeper, it, shop),
    }));
    return {
      kind: 'shop.shelf', location, shelf: shelf.number, rev: shop.rev, quality: pc.quality,
      market: { adjust: pc.adjust, holiday: pc.holiday, note: marketNote(pc.adjust) },
      keeper: { id: keeper.id, name: keeper.name }, gold: p.rpg.gold, items, ...(text ? { text } : {}),
    };
  }

  // ------------------------------------------------------------------ basket (classic pick at the shelf, pay at the counter)

  const describe = (template) => {
    try { return services.describeItem?.(template) ?? null; } catch { return null; }
  };
  /** Classic GetTradePrice (Buy): the basket's CalculateCost lines summed, then one CalculateTradePrice. */
  function basketTotal(p, keeper, shop, h) {
    if (!h?.lines.size) return 0;
    const pc = ledger().economy.context(p, keeper, shop);
    let cost = 0;
    for (const l of h.lines.values()) cost += basketLine(l.value, l.quantity, pc, l.group ?? null);
    return Math.max(1, tradePrice(cost, pc.quality, false, pc));
  }
  /** DaggerfallTradeWindow.DoSteal: basket weight (kg, truncated) + the number of item entries (a stack counts once). */
  function weightAndCount(h) {
    let kg = 0, n = 0;
    for (const l of h.lines.values()) {
      const d = describe(l.template);
      kg += (Number(d?.weight) || 0) * l.quantity;
      n += d?.stackable ? 1 : l.quantity;
    }
    return Math.trunc(kg) + n;
  }
  const basketKg = (h) => [...(h?.lines.values() ?? [])].reduce((kg, l) => kg + (Number(describe(l.template)?.weight) || 0) * l.quantity, 0);

  function basketView(p, location, text = null) {
    const L = ledger();
    const shop = L?.peek(location) ?? null;
    const h = shop ? basketOf(shop, p.id) : null;
    const keeper = L?.keeperAt(location) ?? null;
    const pc = keeper && shop ? L.economy.context(p, keeper, shop) : null;
    const lines = h ? [...h.lines].map(([key, l]) => ({
      key, name: l.name, quantity: l.quantity, icon: l.icon, variant: l.variant, shelf: l.shelf ?? null,
      price: pc ? Math.max(1, tradePrice(basketLine(l.value, l.quantity, pc, l.group ?? null), pc.quality, false, pc)) : null,
    })) : [];
    return {
      kind: 'shop.basket', location, basket: h?.id ?? null, seq: h?.seq ?? 0,
      keeper: keeper ? { id: keeper.id, name: keeper.name } : null,
      lines, count: lines.reduce((n, l) => n + l.quantity, 0), total: keeper && h ? basketTotal(p, keeper, shop, h) : 0,
      gold: p.rpg.gold, ...(text ? { text } : {}),
    };
  }
  const sendBasket = (p, location, text) => ctx.notify(p, basketView(p, location, text));
  /** The conversation with this shop's keeper (if `p` is in one) shows the basket as it now is. */
  const talkBack = (p, location, text = null) => {
    const L = ledger();
    const keeper = L?.keeperAt(location);
    if (keeper) L.talkBack?.(p, keeper, text);
  };

  services.shopBasketFor = (p, keeper) => {
    const location = ctx.location(p);
    // No shelves check: right after a reconnect the interior survey (shelves) can still be pending while the keeper
    // and the ledger's basket are already live; the keeper match below is what ties the basket to this conversation.
    if (!keeper || keeper.location !== location) return null;
    const L = ledger();
    if (!L || L.keeperAt(location)?.id !== keeper.id) return null;
    const shop = L.peek(location);
    const h = shop ? basketOf(shop, p.id) : null;
    if (!h?.lines.size) return null;
    const lines = [...h.lines.values()].map((l) => ({ name: l.name, quantity: l.quantity }));
    return { basket: h.id, seq: h.seq, count: lines.reduce((n, l) => n + l.quantity, 0), total: basketTotal(p, keeper, shop, h), lines };
  };

  /** The basket of `p` in the shop they stand in, checked against the ids the browser was shown. */
  function ownBasket(p, args, { needSeq = true } = {}) {
    const location = ctx.location(p);
    if (!shelvesAt(location)) fail('You are not in a shop.');
    const L = ledger();
    if (!L) fail('Trading is unavailable right now.');
    const shop = L.peek(location);
    const h = shop ? basketOf(shop, p.id) : null;
    if (!h || !h.lines.size || (args?.basket != null && args.basket !== h.id)) return { location, L, shop, h: null };
    if (needSeq && args?.seq !== h.seq) fail('Your basket has changed. Look at it again.');
    return { location, L, shop, h };
  }

  /** Puts every unpaid good of `pid` in `location` back (outside an action: saved by the periodic save). */
  function putBack(location, shop, pid, why) {
    const n = returnAll(shop, pid);
    if (!n) return;
    const L = ledger();
    L?.changedAt(location);
    const keeper = L?.keeperAt(location);
    if (keeper) L.refresh({ id: pid }, keeper);
    const p = ctx.players.get(pid);
    if (p) {
      ctx.notify(p, { kind: 'shop.basket', location, basket: null, seq: 0, keeper: null, lines: [], count: 0, total: 0, gold: p.rpg.gold, text: why });
      talkBack(p, location);
    }
  }

  // ------------------------------------------------------------------ actions

  // Asked by the browser on arrival (a reconnect inside a shop can deliver the join notice before the page listens).
  ctx.onAction('shop.shelves', (p) => {
    ctx.notify(p, shelvesEvent(p) ?? { kind: 'shop.shelves', location: ctx.location(p), shop: null, quality: null, shelves: [] });
  });

  ctx.onAction('shop.shelf', (p, args) => {
    const at = atShelf(p, args?.shelf);
    browsing.set(p.id, { location: at.location, shelf: at.shelf.number });
    ctx.notify(p, shelfView(p, at));
  });

  ctx.onAction('shop.take', (p, args) => {
    const at = atShelf(p, args?.shelf);
    const { keeper, L } = at;
    if (!keeper) fail('Nobody is minding the shop. Taking goods now would be theft.');
    const shop = L.open(keeper, p);
    const it = typeof args.key === 'string' ? shop.stock.get(args.key) : null;
    if (!it || it.shelf !== at.shelf.number || it.quantity < 1) fail('That is no longer on this shelf.');
    const qty = args.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) fail('Choose a quantity between 1 and 99.');
    if (it.quantity < qty) fail(`Only ${it.quantity} left on the shelf.`);
    const unit = L.economy.buyUnit(p, keeper, it, shop);
    if (args.price !== unit) fail('The price has changed. Look again.');
    const total = unit * qty;
    if (spendable(p) < total) fail(`You need ${total} gold for that.`);
    if (typeof services.giveItem !== 'function') fail('Trading is unavailable right now.');
    L.guard(shop);
    services.giveItem(p, it.template, qty, { variant: it.variant, ...(it.extra ? { extra: it.extra } : {}) }); // throws (and changes nothing) if the pack refuses
    pay(p, total);
    shop.purse += total;
    it.quantity -= qty;
    shop.rev++;
    L.changed(keeper);
    L.economy.rememberPurchase(p, L.key(keeper), it.template, unit);
    services.advanceSkill?.(p, 'Mercantile', 1); // DaggerfallTradeWindow: TallySkill(Mercantile, 1) per completed trade
    browsing.set(p.id, { location: at.location, shelf: at.shelf.number });
    ctx.notify(p, shelfView(p, at, `${keeper.name} takes ${total} gold for ${qty > 1 ? `${qty} × ` : ''}${it.name}.`));
    L.refresh(p, keeper);
    ctx.emit('shopPurchase', { player: p, keeper, template: it.template, quantity: qty, total, shelf: at.shelf.number });
  });

  // Classic: picking at a shelf moves the goods into the trade window's basket; nothing is paid yet.
  ctx.onAction('shop.pick', (p, args) => {
    const at = atShelf(p, args?.shelf);
    const { keeper, L } = at;
    if (!keeper) fail('Nobody is minding the shop. Taking goods now would be theft.');
    const shop = L.open(keeper, p);
    const it = typeof args.key === 'string' ? shop.stock.get(args.key) : null;
    if (!it || it.shelf !== at.shelf.number || it.quantity < 1) fail('That is no longer on this shelf.');
    const qty = args.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) fail('Choose a quantity between 1 and 99.');
    if (it.quantity < qty) fail(`Only ${it.quantity} left on the shelf.`);
    const unit = L.economy.buyUnit(p, keeper, it, shop);
    if (args.price !== unit) fail('The price has changed. Look again.');
    // DaggerfallTradeWindow.CanCarryAmount: what you carry plus the basket.
    const kg = (Number(describe(it.template)?.weight) || 0) * qty;
    if (typeof services.canCarry === 'function' && !services.canCarry(p, basketKg(basketOf(shop, p.id)) + kg)) fail('You could not carry that as well.');
    L.guard(shop);
    pick(shop, p.id, args.key, qty, ctx.now());
    L.changed(keeper);
    browsing.set(p.id, { location: at.location, shelf: at.shelf.number });
    ctx.notify(p, shelfView(p, at));
    sendBasket(p, at.location, `${qty > 1 ? `${qty} × ` : ''}${it.name} in your basket. Pay ${keeper.name} at the counter.`);
    L.refresh(p, keeper);
    L.talkBack?.(p, keeper);
  });

  // Classic Remove on a basket line: anywhere in the shop, the goods go back on their own shelf.
  ctx.onAction('shop.unpick', (p, args) => {
    const { location, L, shop, h } = ownBasket(p, args, { needSeq: false });
    if (!h) fail('Your basket is empty.');
    if (typeof args?.key !== 'string') fail('Put back what?');
    L.guard(shop);
    const line = h.lines.get(args.key);
    const n = unpick(shop, p.id, args.key, args.quantity ?? null, ctx.now());
    if (!h.lines.size) settle(shop, p.id);
    L.changedAt(location);
    const at = browsing.get(p.id);
    if (at?.location === location) {
      try { ctx.notify(p, shelfView(p, atShelf(p, at.shelf))); } catch { /* walked away from that shelf */ }
    }
    sendBasket(p, location, `You put ${n > 1 ? `${n} × ` : ''}${line.name} back on shelf ${line.shelf}.`);
    const keeper = L.keeperAt(location);
    if (keeper) {
      L.refresh(p, keeper);
      L.talkBack?.(p, keeper);
    }
  });

  ctx.onAction('shop.basket', (p) => {
    sendBasket(p, ctx.location(p));
  });

  // Classic Buy in the trade window: the whole basket at once, paid to the shopkeeper at the counter.
  ctx.onAction('shop.pay', (p, args) => {
    if (typeof args?.basket !== 'string' || !BASKET_RE.test(args.basket) || !Number.isInteger(args.seq)) fail('Pay for which basket?');
    const r = p.rpg.shopReceipt;
    // From the shopkeeper's conversation: a live session with the person minding this shop, who is not hostile.
    const talking = args.targetId != null || args.session != null;
    const speaker = talking ? ledger()?.talking?.(p, args) : null;
    if (talking && !speaker) fail('That conversation has ended. Talk to them again.');
    const { location, L, shop, h } = ownBasket(p, args);
    if (!h) {
      // A retry of a payment that already went through (lost reply, reconnect): nothing is charged twice.
      if (r && r.basket === args.basket && r.seq === args.seq) {
        const said = `You have already paid ${r.total} gold for those goods.`;
        sendBasket(p, location, said);
        if (speaker) L.talkBack?.(p, speaker, said);
        return;
      }
      fail('Your basket is empty.');
    }
    const keeper = L.keeperAt(location);
    if (!keeper) fail('Nobody is minding the shop.');
    if (speaker && speaker.id !== keeper.id) fail(`${speaker.name} does not take payment here. Pay ${keeper.name}.`);
    const d = Math.hypot(keeper.x - p.x, keeper.z - p.z);
    if (!(d <= COUNTER_REACH)) fail(`Take your basket to ${keeper.name} at the counter.`);
    if (services.law?.custody?.(p)) fail(services.law.custody(p));
    const total = basketTotal(p, keeper, shop, h);
    if (args.total !== total) fail('The price has changed. Look at your basket again.');
    if (spendable(p) < total) fail(`You need ${total} gold for your basket.`);
    // DaggerfallTradeWindow.CanCarryAmount (CarriedWeight, gold included, + basket weight), re-checked at settlement against
    // the CURRENT capacity: Strength or a worn Increased Weight Allowance may have changed since the goods were picked.
    // Like classic, the gold about to be paid still counts as carried.
    if (typeof services.canCarry === 'function' && !services.canCarry(p, basketKg(h))) {
      fail('You could not carry all of your basket now. Put something back first.');
    }
    if (typeof services.giveItem !== 'function') fail('Trading is unavailable right now.');
    L.guard(shop);
    ctx.dirty(p);
    let count = 0;
    for (const l of h.lines.values()) {
      services.giveItem(p, l.template, l.quantity, { variant: l.variant, ...(l.extra ? { extra: l.extra } : {}) }); // throws: the whole payment rolls back
      L.economy.rememberPurchase(p, L.key(keeper), l.template, L.economy.buyUnit(p, keeper, l, shop));
      count += l.quantity;
    }
    pay(p, total);
    shop.purse += total;
    p.rpg.shopReceipt = { basket: h.id, seq: h.seq, total, location };
    settle(shop, p.id);
    shop.rev++;
    L.changed(keeper);
    services.advanceSkill?.(p, 'Mercantile', 1); // DaggerfallTradeWindow: TallySkill(Mercantile, 1) per completed trade
    sendBasket(p, location, `${keeper.name} takes ${total} gold for ${count} item${count === 1 ? '' : 's'}.`);
    L.refresh(p, keeper);
    L.talkBack?.(p, keeper, `${total} gold for ${count} item${count === 1 ? '' : 's'}. Thank you, and come again.`);
    ctx.emit('shopPurchase', { player: p, keeper, total, count, basket: true });
  });

  // Classic Steal in the trade window (DoSteal): package 14 rolls detection, tallies and charges the theft.
  ctx.onAction('shop.steal', (p, args) => {
    if (typeof args?.basket !== 'string' || !BASKET_RE.test(args.basket) || !Number.isInteger(args.seq)) fail('Steal which basket?');
    const { location, L, shop, h } = ownBasket(p, args);
    if (!h) fail('Your basket is empty.');
    if (typeof services.law?.shopliftBasket !== 'function') fail('You think better of it.');
    if (typeof services.giveItem !== 'function') fail('Trading is unavailable right now.');
    const meta = metaOf(location);
    L.guard(shop);
    ctx.dirty(p);
    const lines = [...h.lines.values()];
    const name = lines.length === 1 && lines[0].quantity === 1 ? lines[0].name : 'your basket';
    const { caught } = services.law.shopliftBasket(p, { location, quality: shop.building?.quality ?? meta?.quality ?? 0, weightAndCount: weightAndCount(h), name });
    if (caught) {
      returnAll(shop, p.id); // the goods stay with the merchant
      L.changedAt(location);
      sendBasket(p, location, 'The goods go back on the shelves.');
      talkBack(p, location);
      return;
    }
    const stolen = { from: location, at: Date.now() };
    for (const l of lines) services.giveItem(p, l.template, l.quantity, { variant: l.variant, extra: { ...(l.extra ?? {}), stolen } });
    settle(shop, p.id);
    L.changedAt(location);
    sendBasket(p, location);
    const keeper = L.keeperAt(location);
    if (keeper) {
      L.refresh(p, keeper);
      L.talkBack?.(p, keeper);
    }
    ctx.emit('shopTheft', { player: p, location, count: lines.reduce((n, l) => n + l.quantity, 0) });
  });

  // Everyone browsing a shelf of a ledger that changed (a purchase at the counter or another shelf) sees fresh stock.
  services.shopLedgerChanged = (key) => {
    const location = key.startsWith('shop:') ? key.slice(5) : null;
    if (!location) return;
    queueMicrotask(() => {
      for (const [pid, b] of browsing) {
        if (b.location !== location) continue;
        const p = ctx.players.get(pid);
        if (!p || ctx.location(p) !== location) {
          browsing.delete(pid);
          continue;
        }
        try {
          const at = atShelf(p, b.shelf);
          ctx.notify(p, shelfView(p, at));
        } catch {
          browsing.delete(pid);
        }
      }
    });
  };

  // ------------------------------------------------------------------ lifecycle

  const offline = new Map(); // player id -> ms the player left (or this server first saw their basket offline)
  ctx.onJoin((p) => {
    offline.delete(p.id);
    announced.delete(p.id);
    announce(p);
  });
  ctx.onLeave((p) => {
    browsing.delete(p.id);
    announced.delete(p.id);
    offline.set(p.id, ctx.now());
  });
  /** Baskets go back when their shopper left the shop, stayed away, let them sit, or the shop closed. */
  function sweepBaskets() {
    const L = ledger();
    if (!L?.withHolds) return;
    const now = ctx.now();
    for (const [location, shop] of L.withHolds()) {
      // Closed by the shop's hours (classic shops shut at night); people still loading after a restart are not a closure.
      const meta = metaOf(location);
      const closed = services.buildingAccess?.publicOpen?.(meta?.buildingType, meta?.regionIndex) === false;
      for (const [pid, h] of [...shop.holds]) {
        const p = ctx.players.get(pid);
        if (!p) {
          if (!offline.has(pid)) offline.set(pid, now);
          if (now - offline.get(pid) >= BASKET_GRACE_MS) {
            putBack(location, shop, pid, null);
            offline.delete(pid);
          }
        } else if (ctx.location(p) !== location) putBack(location, shop, pid, 'You leave the shop; the goods you had not paid for go back on the shelves.');
        else if (closed) putBack(location, shop, pid, 'The shop is closing; your unpaid goods go back on the shelves.');
        else if (now - h.at >= BASKET_IDLE_MS) putBack(location, shop, pid, 'You leave your basket too long; the goods go back on the shelves.');
      }
    }
  }
  ctx.on?.('locationChanged', (ev) => {
    if (ev?.player) {
      announced.delete(ev.player.id);
      announce(ev.player);
    }
  });
  ctx.onTick?.(() => {
    for (const p of ctx.players.values()) {
      if (announced.get(p.id) !== ctx.location(p)) announce(p);
    }
    sweepBaskets();
  });
}
