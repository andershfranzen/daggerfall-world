// Shop baskets: goods picked from a shop's shelves and not yet paid for (docs/shops-and-economy.md, "Basket").
//
// Classic DaggerfallTradeWindow (Buy mode, opened on a shelf while the shop is open) moves picked goods from the
// merchant's items into a basket: Remove puts a line back (TransferItem basket -> remote), closing the window returns
// everything (ClearSelectedItems), Buy pays for the whole basket (DeductGoldAmount + TransferAll) and Steal rolls
// CalculateShopliftingChance on the basket's weight + item count (DoSteal). Here the basket is held on the shop's shared
// ledger, so the goods a player picked are off the shelf for everybody else until they are paid for, put back, or the
// player leaves. Holding the basket on the ledger row (not on the character) means a pick, an undo, a payment and a
// return each change one record per side and are saved in the same transaction as the buyer.
//
// Ledger fields (npcs.js `npcshop:shop:<interior>` row):
//   holds: Map<playerId, {id, seq, at, lines: Map<stockKey, entry>}>
// `entry` is a copy of the stock entry (template, name, value, icon, variant, extra, shelf, group, maxCondition) with the
// held quantity. `id` is unique per basket and `seq` changes on every change of it. A payment names the basket and the
// `seq` it was shown; the buyer's character keeps a receipt of the last payment (`rpg.shopReceipt`, saved with the
// gold), so a retry of a payment that already went through is recognised and never charges twice.

export const MAX_LINES = 32;
export const MAX_QUANTITY = 99;
const ENTRY_FIELDS = ['template', 'name', 'value', 'icon', 'variant', 'extra', 'shelf', 'group', 'maxCondition'];

const copyEntry = (it, quantity) => {
  const out = { quantity };
  for (const k of ENTRY_FIELDS) if (it[k] !== undefined) out[k] = k === 'extra' && it.extra ? JSON.parse(JSON.stringify(it.extra)) : it[k];
  return out;
};

export function holdsOf(shop) {
  if (!(shop.holds instanceof Map)) shop.holds = new Map();
  return shop.holds;
}

/** The basket of `pid` (created empty when `create`). */
let basketSerial = 0;
const newBasketId = () => `${Date.now().toString(36)}${(++basketSerial).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export function basketOf(shop, pid, create = false) {
  const holds = holdsOf(shop);
  let h = holds.get(pid);
  if (!h && create) {
    h = { id: newBasketId(), seq: 1, at: 0, lines: new Map() };
    holds.set(pid, h);
  }
  return h ?? null;
}

const fail = (msg) => {
  throw new Error(msg);
};

/** Moves `qty` of shelf stock `key` into the basket of `pid`. Returns the basket line. */
export function pick(shop, pid, key, qty, now) {
  const it = shop.stock.get(key);
  if (!it || it.quantity < 1) fail('That is no longer on this shelf.');
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) fail('Choose a quantity between 1 and 99.');
  if (it.quantity < qty) fail(`Only ${it.quantity} left on the shelf.`);
  const h = basketOf(shop, pid, true);
  const line = h.lines.get(key);
  if (!line && h.lines.size >= MAX_LINES) fail('Your basket is full. Pay for what you have first.');
  if (line && line.quantity + qty > MAX_QUANTITY) fail('That is as many as you can carry to the counter.');
  it.quantity -= qty;
  if (line) line.quantity += qty;
  else h.lines.set(key, copyEntry(it, qty));
  h.seq++;
  h.at = now;
  shop.rev++;
  return h.lines.get(key);
}

/** Puts `qty` (default all) of basket line `key` back on its shelf. Returns the quantity returned. */
export function unpick(shop, pid, key, qty = null, now = 0) {
  const h = basketOf(shop, pid);
  const line = h?.lines.get(key);
  if (!line) fail('That is not in your basket.');
  const n = qty == null ? line.quantity : qty;
  if (!Number.isInteger(n) || n < 1 || n > line.quantity) fail(`You have ${line.quantity} of that in your basket.`);
  restore(shop, key, line, n);
  line.quantity -= n;
  if (line.quantity <= 0) h.lines.delete(key);
  h.seq++;
  h.at = now;
  shop.rev++;
  return n;
}

function restore(shop, key, line, n) {
  const it = shop.stock.get(key);
  if (it) it.quantity += n;
  else {
    const { quantity: _q, ...rest } = line;
    shop.stock.set(key, { ...rest, quantity: n });
  }
}

/** Every held line of `pid` goes back on the shelves (leaving the shop, a caught thief). Returns the item count. */
export function returnAll(shop, pid) {
  const h = basketOf(shop, pid);
  if (!h) return 0;
  let n = 0;
  for (const [key, line] of h.lines) {
    restore(shop, key, line, line.quantity);
    n += line.quantity;
  }
  shop.holds.delete(pid);
  shop.rev++;
  return n;
}

/** Ends the basket after a payment or a successful theft (the goods left with the player). */
export function settle(shop, pid) {
  if (holdsOf(shop).delete(pid)) shop.rev++;
}

/** Stock keys and quantities held by everyone (diagnostics and the anti-duplication checks). */
export function heldTotal(shop, key) {
  let n = 0;
  for (const h of holdsOf(shop).values()) n += h.lines.get(key)?.quantity ?? 0;
  return n;
}

export function serializeHolds(holds) {
  if (!(holds instanceof Map) || !holds.size) return undefined;
  const out = [];
  for (const [pid, h] of holds) {
    if (!h.lines.size) continue;
    out.push({ pid, id: h.id, seq: h.seq, at: h.at, lines: [...h.lines].map(([key, l]) => ({ key, ...l })) });
  }
  return out.length ? out : undefined;
}

export function hydrateHolds(list) {
  const holds = new Map();
  if (!Array.isArray(list)) return holds;
  for (const h of list) {
    if (!h || (typeof h.pid !== 'string' && !Number.isInteger(h.pid))) continue;
    const lines = new Map();
    for (const l of Array.isArray(h.lines) ? h.lines : []) {
      if (!l || typeof l.key !== 'string' || typeof l.template !== 'string' || !Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) continue;
      const { key, ...rest } = l;
      lines.set(key, copyEntry(rest, l.quantity));
    }
    if (!lines.size || typeof h.id !== 'string') continue;
    holds.set(h.pid, { id: h.id.slice(0, 40), seq: Math.max(1, Math.trunc(h.seq) || 1), at: Number(h.at) || 0, lines });
  }
  return holds;
}

/** Deep copy for rollback snapshots. */
export function cloneHolds(holds) {
  const out = new Map();
  if (!(holds instanceof Map)) return out;
  for (const [pid, h] of holds) {
    out.set(pid, { id: h.id, seq: h.seq, at: h.at, lines: new Map([...h.lines].map(([k, l]) => [k, copyEntry(l, l.quantity)])) });
  }
  return out;
}
