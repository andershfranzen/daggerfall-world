// Two-sided trade offers: validation and atomic settlement between two live characters.
// Settlement is synchronous. Any failure restores both characters exactly and rethrows,
// so the runtime's action transaction never persists a half-applied exchange.

export const TRADE_RANGE = 8; // metres, same location required
export const MAX_OFFER_LINES = 16;

export function equippedIds(rpg) {
  const ids = new Set();
  const eq = rpg?.equipment;
  if (eq && typeof eq === 'object') for (const v of Object.values(eq)) if (v != null) ids.add(String(v));
  return ids;
}

export function goldOf(rpg) {
  const g = rpg?.gold;
  return Number.isSafeInteger(g) && g > 0 ? g : 0;
}

function isUntradeable(item) {
  return Boolean(item.quest || item.questItem || item.noTrade || item.bound || item.conjuredUntil || item.template === 'gold');
}

// Normalise a client offer {items:[{id,quantity}], gold} against the owner's live state.
// Throws a user-readable Error. Returns {items:[{id,template,name,quantity}], gold}.
export function normaliseOffer(rpg, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Offer must list items and gold.');
  const gold = raw.gold === undefined ? 0 : raw.gold;
  if (!Number.isSafeInteger(gold) || gold < 0) throw new Error('Gold must be a whole number of 0 or more.');
  const list = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(list)) throw new Error('Offer items must be a list.');
  if (list.length > MAX_OFFER_LINES) throw new Error(`An offer can hold at most ${MAX_OFFER_LINES} items.`);
  const seen = new Set();
  const items = [];
  for (const line of list) {
    if (!line || typeof line !== 'object') throw new Error('Each offered item needs an id and quantity.');
    const id = String(line.id ?? '');
    const quantity = line.quantity === undefined ? 1 : line.quantity;
    if (!id) throw new Error('Each offered item needs an id.');
    if (seen.has(id)) throw new Error('An item can only appear once in an offer.');
    seen.add(id);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Item quantities must be whole numbers of 1 or more.');
    items.push({ id, quantity });
  }
  const offer = { items, gold };
  return describeOffer(rpg, offer); // validates against inventory
}

// Validates an already-normalised offer against current state; returns a display copy.
export function describeOffer(rpg, offer) {
  if (offer.gold > goldOf(rpg)) throw new Error('You do not have that much gold.');
  const inv = Array.isArray(rpg?.inventory) ? rpg.inventory : [];
  const equipped = equippedIds(rpg);
  const items = offer.items.map(({ id, quantity }) => {
    const item = inv.find((i) => i && String(i.id) === id);
    if (!item) throw new Error('An offered item is no longer in your pack.');
    if (equipped.has(id) || item.equipped) throw new Error(`Unequip ${item.name ?? 'that item'} before trading it.`);
    if (isUntradeable(item)) throw new Error(`${item.name ?? 'That item'} cannot be traded.`);
    const have = Number.isSafeInteger(item.quantity) ? item.quantity : 1;
    if (quantity > have) throw new Error(`You only have ${have} × ${item.name ?? 'that item'}.`);
    const { icon, variant } = item;
    return {
      id, template: item.template, name: item.name ?? item.template, quantity,
      ...(icon ? { icon } : {}), ...(Number.isInteger(variant) ? { variant } : {}),
    };
  });
  return { items, gold: offer.gold };
}

// Returns null if the side is still valid, else a reason string.
export function offerProblem(rpg, offer) {
  try {
    describeOffer(rpg, offer);
    return null;
  } catch (err) {
    return err.message;
  }
}

function countTemplate(rpg, template) {
  let n = 0;
  for (const i of rpg.inventory ?? []) if (i && i.template === template) n += Number.isSafeInteger(i.quantity) ? i.quantity : 1;
  return n;
}

function capture(rpg) {
  return {
    inventory: structuredClone(rpg.inventory ?? []),
    equipment: structuredClone(rpg.equipment ?? {}),
    gold: rpg.gold,
    hadInventory: Array.isArray(rpg.inventory),
    hadEquipment: rpg.equipment && typeof rpg.equipment === 'object',
  };
}

// Restore in place so references other features hold stay valid.
function restore(rpg, snap) {
  if (snap.hadInventory && Array.isArray(rpg.inventory)) rpg.inventory.splice(0, rpg.inventory.length, ...snap.inventory);
  else rpg.inventory = snap.inventory;
  if (snap.hadEquipment && rpg.equipment && typeof rpg.equipment === 'object') {
    for (const k of Object.keys(rpg.equipment)) delete rpg.equipment[k];
    Object.assign(rpg.equipment, snap.equipment);
  } else rpg.equipment = snap.equipment;
  rpg.gold = snap.gold;
}

const IDENTITY_KEYS = new Set(['id', 'quantity', 'slot', 'equipped', 'template', 'name']);

function moveItem(services, from, to, line) {
  const src = from.rpg.inventory.find((i) => i && String(i.id) === line.id);
  if (!src) throw new Error('An offered item is no longer available.');
  const template = src.template;
  const extras = Object.fromEntries(Object.entries(structuredClone(src)).filter(([k]) => !IDENTITY_KEYS.has(k)));
  const fromBefore = countTemplate(from.rpg, template);
  const toBefore = countTemplate(to.rpg, template);
  const toIds = new Set((to.rpg.inventory ?? []).map((i) => i && String(i.id)));
  services.takeItem(from, src.id, line.quantity);
  if (countTemplate(from.rpg, template) !== fromBefore - line.quantity) throw new Error('Trade failed: item removal did not balance.');
  const given = services.giveItem(to, template, line.quantity);
  if (countTemplate(to.rpg, template) !== toBefore + line.quantity) throw new Error('Trade failed: item delivery did not balance.');
  // Carry per-item state (condition, enchantments…) onto a freshly created, unmerged item.
  const fresh = given && typeof given === 'object' && !toIds.has(String(given.id)) && given.quantity === line.quantity
    ? given
    : null;
  if (fresh && Object.keys(extras).length) Object.assign(fresh, extras);
}

// Exchange a.offer → b and b.offer → a. `a`,`b` are {player, offer}. Throws after full rollback.
// Uses the inventory feature's atomic `transferItem` (keeps item records and condition) when
// available, else `takeItem`/`giveItem`. Totals of every template and of gold are checked.
export function settle(services, a, b) {
  const canTransfer = typeof services?.transferItem === 'function';
  if (!canTransfer && (typeof services?.takeItem !== 'function' || typeof services?.giveItem !== 'function')) {
    throw new Error('Trading is unavailable right now.');
  }
  // Validate both sides against live state before touching anything.
  describeOffer(a.player.rpg, a.offer);
  describeOffer(b.player.rpg, b.offer);
  const snapA = capture(a.player.rpg);
  const snapB = capture(b.player.rpg);
  const templates = new Set([...a.offer.items, ...b.offer.items].map((l) => itemTemplate(a, b, l.id)));
  const totals = () => [...templates].map((t) => countTemplate(a.player.rpg, t) + countTemplate(b.player.rpg, t));
  const before = totals();
  const goldBefore = goldOf(a.player.rpg) + goldOf(b.player.rpg);
  const expect = {
    a: goldOf(a.player.rpg) - a.offer.gold + b.offer.gold,
    b: goldOf(b.player.rpg) - b.offer.gold + a.offer.gold,
  };
  try {
    for (const [from, to] of [[a, b], [b, a]]) {
      for (const line of from.offer.items) {
        if (canTransfer) services.transferItem(from.player, to.player, line.id, line.quantity);
        else moveItem(services, from.player, to.player, line);
      }
    }
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!from.offer.gold) continue;
      if (canTransfer) services.transferItem(from.player, to.player, 'gold', from.offer.gold);
      else {
        from.player.rpg.gold = goldOf(from.player.rpg) - from.offer.gold;
        to.player.rpg.gold = goldOf(to.player.rpg) + from.offer.gold;
      }
    }
    if (goldOf(a.player.rpg) !== expect.a || goldOf(b.player.rpg) !== expect.b) throw new Error('Trade failed: gold did not balance.');
    if (goldOf(a.player.rpg) + goldOf(b.player.rpg) !== goldBefore) throw new Error('Trade failed: gold did not balance.');
    if (JSON.stringify(totals()) !== JSON.stringify(before)) throw new Error('Trade failed: items did not balance.');
  } catch (err) {
    restore(a.player.rpg, snapA);
    restore(b.player.rpg, snapB);
    throw err instanceof Error ? err : new Error('Trade failed.');
  }
}

function itemTemplate(a, b, id) {
  for (const side of [a, b]) {
    const it = (side.player.rpg.inventory ?? []).find((i) => i && String(i.id) === id);
    if (it) return it.template;
  }
  return null;
}
