// Classic loans, houses, ships, the wagon and owned storage (docs/property.md, backlog package 13).
//
// Owns `rpg.property`:
//   { version: 1,
//     loans:  { [regionKey]: {region, regionIndex, total, due, defaulted, checkedAt, reputationLoss} },
//     houses: { [regionKey]: {region, regionIndex, town, buildingId, interior, buildingType, radius, price, boughtAt} },
//     ship:   null | {type, boughtAt},
//     board:  null | {location, x, z, yaw}      where the player stood before boarding the ship
//     stores: { wagon: [item…], ship: [item…], ['house:'+regionKey]: [item…] },
//     recent: [requestId…], seq }
//
// Banking actions run at a real bank counter validated by town services (`services.bankCounter`), in the
// region of that counter; balances move through `services.bankAdjust`, gold and items through the
// inventory services. Every action validates first and changes state inside the runtime's single
// transaction, so a refusal or a failed save leaves gold, items, balances, deeds and stores untouched (the
// runtime restores the player's whole `rpg`). A repeated `requestId` is refused before anything else.
//
// Storage is per character: another player standing in the same house or on the same deck sees none of
// it. Item records keep their ids in both directions.
//
// Services on ctx.services:
//   property.ownsShip(p), property.shipLocation(type), property.isShipLocation(id), property.checkLoans(p)
//   property.grantHouse(p, {town?, random?})  KnightlyOrder.ReceiveHouse for package 15 (call inside an action)
//   property.wagonGold(p) / takeWagonGold(p, n), property.houses(p)
//   ownsBuilding(p, portal)    town-services building access: the owner may enter at any hour
//   ownsInterior(p, location)  containers (package 7): furniture in an owned house is the owner's storage
//   propertyContainers(p)      read-only list of the stores this player can reach now
import {
  CART_TEMPLATE, LOAN_TERM_MINUTES, LOAN_DEFAULT_REPUTATION, MAX_STORED_ITEMS, SHIPS, SHIP_TYPES, WAGON_KG_LIMIT,
  WAGON_DUNGEON_REACH, deedSellPrice, exteriorTownOf, housesForSale, loanRefusal, loanRepayment, maxLoan, monthsLeft,
  reminderCrossed, shipPrice, storedWeight, MINUTES_PER_MONTH,
} from '../../client/gameplay/property/rules.js';
import { placeOf, regionKey, goldAmount } from '../../client/gameplay/townServices/rules.js';
import { parseLocationId } from '../../client/gameplay/travel/catalog.js';
import { normalizeRpg, MAX_ITEMS } from './inventory.js';

export const name = 'property';
export const VERSION = 1;

const REQUEST_RE = /^[\w-]{6,64}$/;
const RECENT_MAX = 64;
const CHECK_MS = 5_000;
const fail = (msg) => {
  throw new Error(msg);
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);
const SAFE_KEY = (k) => typeof k === 'string' && k && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';

function cleanItems(list) {
  return (Array.isArray(list) ? list : [])
    .filter((it) => isObj(it) && typeof it.template === 'string' && (it.template === 'gold' ? int(it.quantity) > 0 : typeof it.id === 'string'))
    .slice(0, MAX_STORED_ITEMS)
    .map((it) => {
      const out = { ...it, quantity: Math.max(1, int(it.quantity, 1)) };
      delete out.equipped;
      return out;
    });
}

/** Normalizes stored state in place; drops anything malformed. */
export function normalizeProperty(rpg) {
  const raw = isObj(rpg.property) ? rpg.property : {};
  const loans = {};
  for (const [k, l] of Object.entries(isObj(raw.loans) ? raw.loans : {})) {
    if (!SAFE_KEY(k) || !isObj(l) || typeof l.region !== 'string' || regionKey(l.region) !== k) continue;
    const total = Math.max(0, int(l.total));
    const defaulted = l.defaulted === true;
    if (!total && !defaulted) continue;
    loans[k] = {
      region: l.region.slice(0, 64), regionIndex: Number.isInteger(l.regionIndex) ? l.regionIndex : null,
      total, due: total ? int(l.due) : 0, defaulted, checkedAt: int(l.checkedAt), reputationLoss: Math.max(0, int(l.reputationLoss)),
    };
  }
  const houses = {};
  for (const [k, h] of Object.entries(isObj(raw.houses) ? raw.houses : {})) {
    if (!SAFE_KEY(k) || !isObj(h) || typeof h.interior !== 'string' || typeof h.town !== 'string' || regionKey(h.region) !== k) continue;
    houses[k] = {
      region: String(h.region).slice(0, 64), regionIndex: Number.isInteger(h.regionIndex) ? h.regionIndex : null,
      town: h.town.slice(0, 200), buildingId: String(h.buildingId ?? '').slice(0, 40), interior: h.interior.slice(0, 200),
      buildingType: int(h.buildingType), radius: Number(h.radius) || 0, price: Math.max(0, int(h.price)), boughtAt: int(h.boughtAt),
    };
  }
  const ship = isObj(raw.ship) && SHIP_TYPES.includes(raw.ship.type) ? { type: raw.ship.type, boughtAt: int(raw.ship.boughtAt) } : null;
  const b = raw.board;
  const board = isObj(b) && typeof b.location === 'string' && [b.x, b.z, b.yaw].every(Number.isFinite)
    ? { location: b.location.slice(0, 200), x: b.x, z: b.z, yaw: b.yaw } : null;
  const stores = {};
  for (const [k, list] of Object.entries(isObj(raw.stores) ? raw.stores : {})) {
    if (!SAFE_KEY(k) || !(k === 'wagon' || k === 'ship' || /^house:[^/]{1,64}$/.test(k))) continue;
    const items = cleanItems(list);
    if (items.length) stores[k] = items;
  }
  const recent = (Array.isArray(raw.recent) ? raw.recent : []).filter((s) => typeof s === 'string' && REQUEST_RE.test(s)).slice(-RECENT_MAX);
  rpg.property = { version: VERSION, loans, houses, ship, board: ship ? board : null, stores, recent, seq: Math.max(0, int(raw.seq)) };
  return rpg.property;
}

export function install(ctx) {
  const log = ctx.log ?? console;
  const services = (ctx.services ||= {});
  const lastCheck = new Map(); // player id -> ms

  const stateOf = (p) => {
    if (!isObj(p.rpg)) p.rpg = {};
    if (!isObj(p.rpg.property) || p.rpg.property.version !== VERSION) normalizeProperty(p.rpg);
    return p.rpg.property;
  };
  const clock = () => {
    const c = typeof services.worldClock === 'function' ? services.worldClock() : null;
    return c && Number.isFinite(c.minutes) ? Math.trunc(c.minutes) : null;
  };
  /**
   * A borrower's own clock (package 20: services.playerMinutes = shared minutes + that character's rest, travel
   * and prison time), so a loan falls due by the time its borrower has lived. Falls back to the shared clock.
   */
  const loanClock = (p) => {
    const v = typeof services.playerMinutes === 'function' ? services.playerMinutes(p) : null;
    return Number.isFinite(v) ? Math.trunc(v) : clock();
  };
  const say = (p, text, extra = {}) => ctx.notify(p, { kind: 'property', text, clock: loanClock(p), ...extra });
  const location = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p.rpg?.location);
  const goldOf = (p) => Math.max(0, int(p.rpg?.gold));
  const levelOf = (p) => Math.max(1, int(p.rpg?.character?.level, 1));

  function claimRequest(st, args) {
    const rid = args?.requestId;
    if (rid == null) return;
    if (typeof rid !== 'string' || !REQUEST_RE.test(rid)) fail('Invalid request.');
    if (st.recent.includes(rid)) fail('That was already done.');
    st.recent.push(rid);
    if (st.recent.length > RECENT_MAX) st.recent.splice(0, st.recent.length - RECENT_MAX);
  }

  function needBank() {
    for (const s of ['bankCounter', 'bankAdjust', 'bankBalance', 'takeGold', 'addGold']) {
      if (typeof services[s] !== 'function') fail('The bank is closed right now.');
    }
  }

  /** A validated bank counter and the region it serves. */
  function atBank(p, args) {
    needBank();
    const { counter, place } = services.bankCounter(p, args);
    const regionIndex = Number.isInteger(counter.regionIndex) ? counter.regionIndex : null;
    return { counter, place, region: place.region, key: regionKey(place.region), regionIndex };
  }

  /** DaggerfallBankManager.PurchaseHouse/Ship: PlayerEntity.DeductGoldAmount takes carried gold first, then the account. */
  // GetGoldAmount counts carried letters of credit (package 13 items, server/rpg/townServices.js spendGold).
  function pay(p, region, amount) {
    const carried = typeof services.spendableGold === 'function' ? services.spendableGold(p) : goldOf(p);
    const fromPurse = Math.min(carried, amount);
    const fromAccount = amount - fromPurse;
    if (fromAccount > services.bankBalance(p, region)) fail(`That costs ${amount} gold; you have ${carried} carried and ${services.bankBalance(p, region)} in your account here.`);
    if (fromPurse) {
      if (typeof services.spendGold === 'function') services.spendGold(p, fromPurse);
      else services.takeGold(p, fromPurse);
    }
    if (fromAccount) services.bankAdjust(p, region, -fromAccount);
    return { fromPurse, fromAccount };
  }

  // ------------------------------------------------------------------ ships

  const shipLocation = (type) => {
    const s = SHIPS[type];
    if (!s) return null;
    const slot = `town:${s.regionIndex}/${s.locationIndex}`;
    return services.travel?.lookup?.(slot)?.id ?? slot;
  };
  const shipTypeAt = (loc) => {
    const town = exteriorTownOf(loc);
    if (!town) return null;
    for (const t of SHIP_TYPES) if (shipLocation(t) === town || `town:${SHIPS[t].regionIndex}/${SHIPS[t].locationIndex}` === town) return t;
    return null;
  };
  // server/rpg/sailing.js: aboard a launched vessel only its owner reaches a hold and the cabin door.
  const sailingHold = (p) => services.sailing?.holdAllowed?.(p) !== false;
  const sailingRefusal = (p, verb) => services.sailing?.refusal?.(p, verb) ?? null;
  const onOwnShip = (p) => {
    const st = stateOf(p);
    return !!st.ship && shipTypeAt(location(p)) === st.ship.type && sailingHold(p);
  };

  // ------------------------------------------------------------------ houses

  const ownedHouseAt = (p, loc) => Object.values(stateOf(p).houses).find((h) => h.interior === loc) ?? null;

  function offersAt(p, town) {
    const tp = typeof services.townProperty === 'function' ? services.townProperty(town) : null;
    if (!tp || tp.status !== 'ready') return { status: tp?.status ?? 'unavailable', reason: tp?.reason ?? null, port: false, houses: [] };
    const now = clock() ?? 0;
    const owned = new Set(Object.values(stateOf(p).houses).map((h) => h.interior));
    const houses = housesForSale(tp.houses, {
      town, monthIndex: Math.trunc(now / MINUTES_PER_MONTH), buildingCount: tp.buildingCount,
      excluded: (h) => owned.has(h.interior)
        || (typeof services.homes?.isAddressAvailable === 'function' && !services.homes.isAddressAvailable(h.interior))
        || services.quests?.active?.(p)?.some?.((q) => Object.values(q.places ?? {}).some((s) => s?.interior === h.interior)),
    });
    return { status: 'ready', port: tp.port === true, houses, regionIndex: tp.regionIndex };
  }

  // ------------------------------------------------------------------ storage

  function hasCart(p) {
    return (p.rpg?.inventory ?? []).some((it) => it?.template === CART_TEMPLATE);
  }

  /** Why the wagon cannot be opened here, or null. */
  function wagonRefusal(p) {
    if (!hasCart(p)) return 'You have no wagon. General stores sell a small cart.';
    const loc = location(p);
    if (typeof loc === 'string' && loc.startsWith('dungeon:')) {
      const exits = services.portals?.into?.(loc)?.exits ?? [];
      const d = exits.reduce((m, e) => Math.min(m, Math.hypot(e.x - p.x, e.z - p.z)), Infinity);
      if (!(d <= WAGON_DUNGEON_REACH)) return 'Your wagon is outside. Go back to the exit to reach it.';
    }
    return null;
  }

  /** Stores the player can reach now: [{id, name, limitKg}]. */
  function reachable(p) {
    const st = stateOf(p);
    const out = [];
    if (!wagonRefusal(p)) out.push({ id: 'wagon', name: 'Wagon', limitKg: WAGON_KG_LIMIT });
    const house = ownedHouseAt(p, location(p));
    if (house) out.push({ id: `house:${regionKey(house.region)}`, name: `Your house in ${placeOf(house.town)?.location ?? house.region}`, limitKg: null });
    if (onOwnShip(p)) out.push({ id: 'ship', name: `${SHIPS[st.ship.type].label} hold`, limitKg: null });
    return out;
  }

  function storeFor(p, id) {
    if (typeof id !== 'string') fail('Which store?');
    const found = reachable(p).find((s) => s.id === id);
    if (!found) {
      if (id === 'wagon') fail(wagonRefusal(p) ?? 'You cannot reach your wagon.');
      if (id === 'ship') fail('You can only reach the hold aboard your own ship.');
      fail('You can only reach your belongings inside your own house.');
    }
    return found;
  }

  // ------------------------------------------------------------------ loans

  /** LoanChecker: reminders, then on the due date repay from the account and default once. */
  function checkLoans(p) {
    const now = loanClock(p);
    if (now == null || !p?.rpg) return false;
    const st = stateOf(p);
    let changed = false;
    for (const loan of Object.values(st.loans)) {
      if (!(loan.total > 0) || !(loan.due > 0)) continue;
      const before = loan.checkedAt || now;
      if (loan.due < now) {
        const balance = typeof services.bankBalance === 'function' ? services.bankBalance(p, loan.region) : 0;
        const transfer = Math.min(loan.total, balance);
        if (transfer > 0 && typeof services.bankAdjust === 'function') {
          services.bankAdjust(p, loan.region, -transfer);
          loan.total -= transfer;
        }
        if (loan.total <= 0) {
          loan.total = 0;
          loan.due = 0;
          say(p, `Your loan in ${loan.region} fell due and was repaid from your account (${transfer} gold).`);
        } else if (!loan.defaulted) {
          loan.defaulted = true;
          loan.reputationLoss = LOAN_DEFAULT_REPUTATION;
          // PlayerEntity.LowerRepForCrime(LoanDefault): regional legal reputation is package 14's (server/rpg/law.js).
          services.law?.changeLegalRep?.(p, loan.region, -LOAN_DEFAULT_REPUTATION, 'loan-default');
          ctx.emit?.('loanDefault', { player: p, region: loan.region, regionIndex: loan.regionIndex, owed: loan.total });
          say(p, `You have defaulted on your loan in ${loan.region}. You still owe ${loan.total} gold, and the bank there will not lend to you again.`);
        }
        changed = true;
      } else {
        const month = reminderCrossed(loan.due, before, now);
        if (month) say(p, `A reminder from the bank: you owe ${loan.total} gold in ${loan.region}, due in ${monthsLeft(loan.due, now) + 1} month${month === 1 ? '' : 's'}.`);
      }
      if (loan.checkedAt !== now) {
        loan.checkedAt = now;
        changed = true;
      }
    }
    for (const [k, loan] of Object.entries(st.loans)) if (!loan.total && !loan.defaulted) delete st.loans[k];
    if (changed) ctx.dirty(p);
    return changed;
  }

  // ------------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    stateOf(p);
    lastCheck.delete(p.id);
  });
  ctx.onLeave((p) => lastCheck.delete(p.id));
  // Rest, travel or a jail term moves only this character's clock: check their loans at once.
  ctx.on?.('timeSpent', (ev) => {
    if (!ev?.player?.rpg) return;
    try {
      checkLoans(ev.player);
    } catch (err) {
      log.error?.('[property] loan check failed:', err);
    }
  });
  ctx.onTick(() => {
    const t = ctx.now();
    for (const p of ctx.players.values()) {
      if (t - (lastCheck.get(p.id) ?? -Infinity) < CHECK_MS) continue;
      lastCheck.set(p.id, t);
      try {
        checkLoans(p);
      } catch (err) {
        log.error?.('[property] loan check failed:', err);
      }
    }
  });

  /** Start loading a deck's collision and surveying its cabin door ahead of boarding. */
  function prepareDeck(deck) {
    services.collision?.preload?.(deck);
    services.interiors?.survey?.(deck)?.catch?.(() => {});
  }
  ctx.onJoin((p) => {
    const own = stateOf(p).ship;
    if (own) prepareDeck(shipLocation(own.type));
  });

  function statusEvent(p) {
    const loc = location(p);
    const own = stateOf(p).ship;
    if (own) prepareDeck(shipLocation(own.type)); // the deck height and cabin door for ship.board
    const town = exteriorTownOf(loc);
    const offers = town && parseLocationId(town) ? offersAt(p, town) : { status: 'unavailable', port: false, houses: [] };
    return {
      kind: 'property.status', location: loc, town, clock: loanClock(p), worldClock: clock(), level: levelOf(p), maxLoan: maxLoan(levelOf(p)),
      offers, stores: reachable(p), wagon: { hasCart: hasCart(p), refusal: wagonRefusal(p) }, onShip: onOwnShip(p),
      ships: SHIP_TYPES.map((t) => ({ type: t, label: SHIPS[t].label, price: shipPrice(t), location: shipLocation(t) })),
    };
  }

  // ------------------------------------------------------------------ actions

  ctx.onAction('property.status', (p) => {
    stateOf(p);
    ctx.notify(p, statusEvent(p));
  });

  ctx.onAction('bank.loan', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region, key, regionIndex } = atBank(p, args);
    const amount = goldAmount(args.amount);
    const refusal = loanRefusal(amount ?? 0, levelOf(p), st.loans[key]);
    if (refusal) fail(refusal);
    const now = loanClock(p);
    if (now == null) fail('The bank cannot date a loan right now.');
    const owed = loanRepayment(amount);
    services.bankAdjust(p, region, amount);
    st.loans[key] = { region, regionIndex, total: owed, due: now + LOAN_TERM_MINUTES, defaulted: false, checkedAt: now, reputationLoss: 0 };
    say(p, `The bank lends you ${amount} gold, paid into your account in ${region}. You owe ${owed} gold within a year.`);
  });

  ctx.onAction('bank.repay', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region, key } = atBank(p, args);
    const loan = st.loans[key];
    if (!loan || !(loan.total > 0)) fail(`You owe nothing to the bank in ${region}.`);
    let amount = goldAmount(args.amount);
    if (!amount) fail('Choose how much to repay.');
    const fromAccountOnly = args.fromAccount === true;
    const available = services.bankBalance(p, region) + (fromAccountOnly ? 0 : goldOf(p));
    if (amount > available) fail(`You have only ${available} gold ${fromAccountOnly ? 'in your account' : 'carried and in your account'} here.`);
    const overpaid = amount > loan.total;
    if (overpaid) amount = loan.total; // TransactionResult.OVERPAID_LOAN
    if (fromAccountOnly) services.bankAdjust(p, region, -amount);
    else pay(p, region, amount);
    loan.total -= amount;
    if (loan.total <= 0) {
      loan.total = 0;
      loan.due = 0;
      if (!loan.defaulted) delete st.loans[key];
    }
    say(p, loan.total ? `You repay ${amount} gold. You still owe ${loan.total} in ${region}.` : `You repay ${amount} gold and clear your loan in ${region}.${overpaid ? ' The bank keeps only what you owed.' : ''}`);
  });

  /** DaggerfallBankManager.AllocateHouseToPlayer: the deed record, the map name and the notebook entry. */
  function allocateHouse(p, { region, regionIndex, town, house, price }) {
    const st = stateOf(p);
    const record = {
      region, regionIndex, town, buildingId: house.id, interior: house.interior,
      buildingType: house.buildingType, radius: house.radius, price, boughtAt: clock() ?? 0,
    };
    st.houses[regionKey(region)] = record;
    services.automap?.learnPlace?.(p, { town, portalId: house.id, label: `${p.name}'s house` });
    services.automap?.write?.(p, `Deed: you own a house in ${placeOf(town)?.location ?? town}, ${region}.`, { source: 'deed' });
    ctx.dirty(p);
    return record;
  }

  /**
   * KnightlyOrder.ReceiveHouse (package 15 gates rank 9 and the once-only flag): a free house drawn from this
   * town's houses for sale, allocated like a purchase with price 0. No gold or account moves.
   * Returns {status:'granted', house} | {status:'owned'|'none'|'unavailable', text}.
   */
  function grantHouse(p, { town = exteriorTownOf(location(p)), random = Math.random } = {}) {
    const place = town ? placeOf(town) : null;
    if (!place) return { status: 'unavailable', text: 'There is no town here to grant a house in.' };
    const st = stateOf(p);
    if (st.houses[regionKey(place.region)]) return { status: 'owned', text: `You already own a house in ${place.region}.` };
    const offers = offersAt(p, town);
    if (offers.status !== 'ready') return { status: 'unavailable', text: 'The town records are not ready. Try again in a moment.' };
    if (!offers.houses.length) return { status: 'none', text: 'There are no houses for sale in this town.' };
    const house = offers.houses[Math.min(offers.houses.length - 1, Math.floor(random() * offers.houses.length))];
    const record = allocateHouse(p, { region: place.region, regionIndex: offers.regionIndex ?? null, town, house, price: 0 });
    return { status: 'granted', house: { ...record } };
  }

  ctx.onAction('house.buy', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region, key, place, regionIndex } = atBank(p, args);
    if (st.houses[key]) fail(`You already own a house in ${region}. Sell it first.`);
    const offers = offersAt(p, place.town);
    if (offers.status !== 'ready') fail('The bank is still reading the town records. Try again in a moment.');
    if (!offers.houses.length) fail('There are no houses for sale in this town.');
    const house = offers.houses.find((h) => h.id === args.houseId);
    if (!house) fail('That house is not for sale this month.');
    if (args.expectPrice !== undefined && args.expectPrice !== house.price) fail(`The price is now ${house.price} gold. Look again.`);
    const paid = pay(p, region, house.price);
    allocateHouse(p, { region, regionIndex: regionIndex ?? offers.regionIndex ?? null, town: place.town, house, price: house.price });
    services.homes?.migrateLegacyDeeds?.(p);
    say(p, `You buy the house for ${house.price} gold (${paid.fromPurse} carried, ${paid.fromAccount} from your account). The deed is in your name.`, { house: st.houses[key] });
  });

  ctx.onAction('house.sell', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region, key } = atBank(p, args);
    const house = st.houses[key];
    if (!house) fail(`You own no house in ${region}.`);
    const store = st.stores[`house:${key}`];
    if (store?.length && args.abandonContents !== true) fail('Your house still holds belongings. Take them out first.');
    const price = deedSellPrice(house.price);
    services.bankAdjust(p, region, price);
    delete st.houses[key];
    delete st.stores[`house:${key}`];
    services.automap?.forgetPlace?.(p, { town: house.town, portalId: house.buildingId }); // SellHouse: UndiscoverBuilding
    say(p, `The bank buys back your house for ${price} gold, paid into your account in ${region}.`);
  });

  ctx.onAction('ship.buy', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region, place } = atBank(p, args);
    if (st.ship) fail('You already own a ship.');
    const offers = offersAt(p, place.town);
    if (offers.status !== 'ready') fail('The bank is still reading the town records. Try again in a moment.');
    if (!offers.port) fail('This is not a port town. Ships are sold only in ports.');
    const type = args.type;
    if (!SHIP_TYPES.includes(type)) fail('Which ship?');
    const price = shipPrice(type);
    if (args.expectPrice !== undefined && args.expectPrice !== price) fail(`The price is now ${price} gold. Look again.`);
    const paid = pay(p, region, price);
    st.ship = { type, boughtAt: clock() ?? 0 };
    services.travel?.discover?.(p, shipLocation(type));
    say(p, `You buy a ${SHIPS[type].label.toLowerCase()} for ${price} gold (${paid.fromPurse} carried, ${paid.fromAccount} from your account). Board it from the Property panel; sea passage is now free.`);
  });

  ctx.onAction('ship.sell', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const { region } = atBank(p, args);
    if (!st.ship) fail('You own no ship.');
    const sailing = sailingRefusal(p, 'ship.sell');
    if (sailing) fail(sailing);
    if (st.stores.ship?.length && args.abandonContents !== true) fail('Your hold still has cargo. Unload it first.');
    const price = deedSellPrice(shipPrice(st.ship.type));
    services.bankAdjust(p, region, price);
    st.ship = null;
    st.board = null;
    delete st.stores.ship;
    say(p, `The bank buys back your ship for ${price} gold, paid into your account in ${region}.`);
  });

  function move(p, landing, label) {
    if (typeof services.portals?.transfer === 'function') {
      services.portals.transfer(p, landing, { label });
      return;
    }
    p.rpg.location = landing.location;
    delete p.rpg.portal;
    Object.assign(p, { x: landing.x, z: landing.z, yaw: landing.yaw, moving: false, forward: 0, strafe: 0 });
    ctx.dirty(p);
    ctx.notify(p, { kind: 'teleport', location: landing.location, x: landing.x, y: landing.y ?? 0, z: landing.z, yaw: landing.yaw, label });
    ctx.emit('locationChanged', { player: p, from: null, to: landing.location });
  }

  // TransportManager: ship mode keeps the boarding position and moves the player to the ship's deck.
  ctx.onAction('ship.board', (p, args) => {
    const custody = services.law?.custody?.(p);
    if (custody) fail(custody);
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    if (!st.ship) fail('You own no ship.');
    const sailing = sailingRefusal(p, 'ship.board');
    if (sailing) fail(sailing);
    if (onOwnShip(p)) fail('You are already aboard.');
    const loc = location(p);
    if (!parseLocationId(loc) && !/^wilderness:/.test(loc)) fail('You cannot change transportation indoors.');
    if (p.rpg.defeated) fail('You cannot do that while you are down.');
    services.mount?.dismount?.(p);
    if (p.rpg.mount?.riding) p.rpg.mount.riding = false;
    st.board = { location: loc, x: Math.round(p.x * 1000) / 1000, z: Math.round(p.z * 1000) / 1000, yaw: Math.round(p.yaw * 1000) / 1000 };
    // StreamingWorld RandomStartMarker + PlayerMotor.FixStanding: the arrival stands on the deck at the start marker.
    const deck = shipLocation(st.ship.type);
    prepareDeck(deck);
    const y = services.collision?.groundAt?.(deck, 0, 0);
    // Without the deck's collision the landing has no foot height and Play would stand at y 0, beside the hull.
    // prepareDeck has started the load; the refusal rolls the request claim back, so a retry boards on deck.
    if (services.collision?.groundAt && !Number.isFinite(y)) fail('Your ship is being made ready. Try again in a moment.');
    move(p, { location: deck, x: 0, y: Number.isFinite(y) ? y : undefined, z: 0, yaw: 0 }, 'your ship');
    say(p, `You board your ${SHIPS[st.ship.type].label.toLowerCase()}.`);
  });

  ctx.onAction('ship.leave', (p, args) => {
    const custody = services.law?.custody?.(p);
    if (custody) fail(custody);
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const sailing = sailingRefusal(p, 'ship.leave');
    if (sailing) fail(sailing);
    if (!onOwnShip(p)) fail('You are not aboard your ship.');
    if (location(p) !== exteriorTownOf(location(p))) fail('Go up on deck first.');
    if (!st.board) fail('Your ship has nowhere to put you ashore. Use the travel map.');
    const back = st.board;
    st.board = null;
    move(p, { location: back.location, x: back.x, y: 0, z: back.z, yaw: back.yaw }, 'the shore');
    say(p, 'You go ashore where you boarded.');
  });

  ctx.onAction('property.store', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const store = storeFor(p, args.container);
    const itemId = String(args.itemId ?? '');
    const isGold = itemId === 'gold';
    const item = isGold ? null : (p.rpg.inventory ?? []).find((i) => i?.id === itemId);
    if (!isGold && !item) fail('You do not have that item.');
    if (item?.equipped) fail(`Unequip ${item.name} first.`);
    if (item?.quest) fail(`${item.name} must stay with you.`);
    if (item?.template === CART_TEMPLATE && store.id === 'wagon') fail('The cart cannot go inside itself.');
    const qty = isGold ? goldAmount(args.quantity) : Math.max(1, Math.min(item.quantity ?? 1, int(args.quantity, item.quantity ?? 1)));
    if (!qty) fail('How much?');
    if (isGold && qty > goldOf(p)) fail(`You only have ${goldOf(p)} gold.`);
    const list = st.stores[store.id] ?? [];
    const addKg = isGold ? qty / 400 : (Number(item.weight) || 0) * qty;
    if (store.limitKg != null && storedWeight(list) + addKg > store.limitKg) fail(`${store.name} can carry only ${store.limitKg} kg.`);
    if (list.length >= MAX_STORED_ITEMS) fail(`${store.name} is full.`);
    const rec = services.takeItem(p, itemId, qty);
    if (!rec) fail('That could not be moved.');
    const out = { ...rec };
    delete out.equipped;
    const merge = (out.template === 'gold' || out.stackable) ? list.find((r) => r.template === out.template && r.stackable === out.stackable) : null;
    if (merge) merge.quantity += out.quantity;
    else list.push(out);
    st.stores[store.id] = list;
    say(p, `You put ${isGold ? `${qty} gold` : `${qty > 1 ? `${qty} × ` : ''}${item.name}`} in ${store.name.charAt(0).toLowerCase()}${store.name.slice(1)}.`);
  });

  ctx.onAction('property.take', (p, args) => {
    const st = stateOf(p);
    claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls the claim back
    const store = storeFor(p, args.container);
    const list = st.stores[store.id] ?? [];
    const itemId = String(args.itemId ?? '');
    const rec = itemId === 'gold' ? list.find((r) => r.template === 'gold') : list.find((r) => r.id === itemId);
    if (!rec) fail('That is not there.');
    const qty = Math.max(1, Math.min(rec.quantity, int(args.quantity, rec.quantity)));
    const kg = rec.template === 'gold' ? qty / 400 : (Number(rec.weight) || 0) * qty;
    if (typeof services.carriedWeight === 'function' && typeof services.maxEncumbrance === 'function' && kg > 0) {
      if (services.carriedWeight(p) + kg > services.maxEncumbrance(p)) fail('You cannot carry that much.');
    }
    const rpg = p.rpg;
    if (rec.template !== 'gold' && !rec.stackable) {
      if (!Array.isArray(rpg.inventory) || rpg.inventory.length >= MAX_ITEMS) fail('Your pack cannot hold any more items.');
      if (rpg.inventory.some((i) => i?.id === rec.id)) {
        log.error?.(`[property] ${p.name}: item ${rec.id} is already in the pack; refusing to duplicate it`);
        fail('That item is already in your pack. Please report this.');
      }
    }
    if (rec.template === 'gold') services.addGold(p, qty);
    else if (rec.stackable) services.giveItem(p, rec.template, qty);
    else {
      const item = { ...rec };
      delete item.equipped;
      rpg.inventory.push(item);
      normalizeRpg(rpg);
      if (!rpg.inventory.some((i) => i.id === item.id)) fail('That item could not be returned.');
      ctx.dirty(p);
      ctx.emit('inventoryChanged', { player: p, reason: 'property' });
    }
    rec.quantity -= qty;
    if (rec.quantity <= 0) list.splice(list.indexOf(rec), 1);
    if (list.length) st.stores[store.id] = list;
    else delete st.stores[store.id];
    say(p, `You take ${rec.template === 'gold' ? `${qty} gold` : `${qty > 1 ? `${qty} × ` : ''}${rec.name}`} from ${store.name.charAt(0).toLowerCase()}${store.name.slice(1)}.`);
  });

  // ------------------------------------------------------------------ services

  services.property = {
    ownsShip: (p) => !!p?.rpg && !!stateOf(p).ship,
    shipLocation,
    isShipLocation: (id) => shipTypeAt(id) !== null,
    checkLoans,
    house: (p, region) => stateOf(p).houses[regionKey(region)] ?? null,
    houses: (p) => Object.values(stateOf(p).houses).map((h) => ({ ...h })),
    grantHouse,
    /** Gold pieces stored in the wagon (DaggerfallBankManager.DepositGold draws on them after the purse). */
    wagonGold: (p) => (hasCart(p) ? (stateOf(p).stores.wagon ?? []).filter((r) => r.template === 'gold').reduce((n, r) => n + r.quantity, 0) : 0),
    takeWagonGold(p, amount) {
      const st = stateOf(p);
      const list = st.stores.wagon ?? [];
      let left = Math.max(0, int(amount));
      if (left > services.property.wagonGold(p)) fail('There is not that much gold in your wagon.');
      for (const r of list.filter((x) => x.template === 'gold')) {
        const n = Math.min(r.quantity, left);
        r.quantity -= n;
        left -= n;
        if (r.quantity <= 0) list.splice(list.indexOf(r), 1);
      }
      if (list.length) st.stores.wagon = list;
      else delete st.stores.wagon;
      ctx.dirty(p);
    },
  };
  // PlayerActivate.BuildingIsUnlocked: a ship's cabin door opens for its owner (BuildingTypes.Ship = 24).
  const SHIP_BUILDING = 24;
  services.ownsBuilding = (p, portal) => !!portal?.to && (!!ownedHouseAt(p, portal.to) ||
    (portal.meta?.buildingType === SHIP_BUILDING && !!stateOf(p).ship && shipTypeAt(portal.to) === stateOf(p).ship.type && sailingHold(p)));
  services.ownsInterior = (p, loc) => !!ownedHouseAt(p, loc) || (onOwnShip(p) && loc === location(p) && loc !== exteriorTownOf(loc));
  services.propertyContainers = (p) => reachable(p).map((s) => ({ ...s, items: (stateOf(p).stores[s.id] ?? []).map((r) => ({ ...r })) }));

  return { stateOf, checkLoans, offersAt, reachable };
}
