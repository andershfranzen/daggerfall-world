// DOM-free helpers for the party/trade panel (unit-testable in Node).

export const CHANNEL_PREFIXES = Object.freeze({ '/p': 'party', '/party': 'party', '/r': 'region', '/region': 'region', '/g': 'global', '/global': 'global' });

/** `/p hello` -> {channel:'party', text:'hello'}; anything else -> null (location chat). */
export function parseChannelCommand(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  if (!m) return null;
  const channel = CHANNEL_PREFIXES[m[1].toLowerCase()];
  if (!channel) return null;
  return { channel, text: (m[2] ?? '').replace(/\s+/g, ' ').trim() };
}

/** Items the player may put on the table: unequipped, not gold, not quest-bound. */
export function tradeableItems(character) {
  const inv = Array.isArray(character?.inventory) ? character.inventory : [];
  const equipped = new Set(Object.values(character?.equipment ?? {}).filter((v) => v != null).map(String));
  return inv.filter((i) => i && i.template !== 'gold' && !i.equipped && !equipped.has(String(i.id)) && !i.quest && !i.questItem && !i.noTrade && !i.bound && !i.conjuredUntil);
}

/** Server offer -> editable draft. */
export function draftFrom(offer) {
  const items = new Map();
  for (const l of offer?.items ?? []) items.set(String(l.id), l.quantity);
  return { items, gold: offer?.gold ?? 0 };
}

/** Draft -> action args. Drops zero lines and clamps to what is carried. */
export function draftToArgs(draft, character) {
  const inv = new Map((character?.inventory ?? []).map((i) => [String(i.id), i]));
  const items = [];
  for (const [id, q] of draft.items) {
    const it = inv.get(id);
    const quantity = Math.floor(Number(q));
    if (!it || !(quantity >= 1)) continue;
    items.push({ id, quantity: Math.min(quantity, it.quantity ?? 1) });
  }
  const gold = Math.max(0, Math.floor(Number(draft.gold) || 0));
  return { items, gold };
}

/** True when the draft matches what the server holds for my side. */
export function draftMatches(draft, offer, character) {
  const a = draftToArgs(draft, character);
  const b = { items: (offer?.items ?? []).map((l) => ({ id: String(l.id), quantity: l.quantity })), gold: offer?.gold ?? 0 };
  const key = (o) => JSON.stringify([o.gold, [...o.items].sort((x, y) => x.id.localeCompare(y.id))]);
  return key(a) === key(b);
}

export function describeOffer(offer) {
  const parts = (offer?.items ?? []).map((i) => (i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name));
  if (offer?.gold) parts.push(`${offer.gold} gold`);
  return parts.length ? parts.join(', ') : 'Nothing yet';
}
