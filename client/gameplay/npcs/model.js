// DOM-free helpers for the dialogue panel (unit tested in Node).

export const ATTITUDE_LABELS = Object.freeze({
  friendly: 'Friendly', neutral: 'Neutral', cold: 'Wary', hostile: 'Hostile',
});

export const MAX_QUANTITY = 99;

/** Clamp a quantity input to 1..min(available, 99). */
export function clampQuantity(value, available) {
  const n = Math.trunc(Number(value));
  const max = Math.max(1, Math.min(MAX_QUANTITY, Math.trunc(available) || 1));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, max);
}

/** Signed reputation text: "+12", "0", "-4". */
export const signed = (n) => (n > 0 ? `+${n}` : String(n ?? 0));

/** Buy rows with affordability for the player's gold. */
export function buyRows(view) {
  const gold = Number.isFinite(view?.gold) ? view.gold : 0;
  return (view?.shop?.items ?? []).map((it) => ({
    ...it,
    affordable: it.price <= gold,
    maxQuantity: Math.max(1, Math.min(it.quantity, MAX_QUANTITY, Math.floor(gold / Math.max(1, it.price)) || 1)),
  }));
}

/** Sell rows the merchant's purse can pay for. */
export function sellRows(view) {
  const purse = Number.isFinite(view?.shop?.purse) ? view.shop.purse : 0;
  return (view?.shop?.sellable ?? []).map((it) => ({
    ...it,
    affordable: it.price <= purse,
    maxQuantity: Math.max(1, Math.min(it.quantity, MAX_QUANTITY, Math.floor(purse / Math.max(1, it.price)) || 1)),
  }));
}

/** One-line standing summary for the header. */
export function standingText(view) {
  const s = view?.standing;
  if (!s) return '';
  const parts = [`${s.faction ?? 'Faction'} ${signed(s.reputation)}`];
  if (Number.isFinite(s.region) && s.factionId !== 201) parts.push(`region ${signed(s.region)}`);
  return parts.join(' · ');
}

/** Guild membership line: "Fighters Guild — Blade" or "Not a member". */
export function guildText(view) {
  const g = view?.guild;
  if (!g) return '';
  return g.member ? `${g.name} — ${g.rankTitle}` : `${g.name} — not a member`;
}

/**
 * Does an incoming event belong to the conversation on screen? Stale views from
 * an earlier conversation (different session) are ignored.
 */
export function acceptsEvent(current, ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev.kind === 'dialogue') return !!ev.npc?.id;
  if (ev.kind === 'dialogue.end') return !!current && (!ev.npcId || ev.npcId === current.npc?.id);
  return false;
}

/** Arguments for a mutating command, always carrying the session token and target. */
export const commandArgs = (view, extra = {}) => ({ targetId: view.npc.id, session: view.session, ...extra });

/** Look up a faction's allies/enemies by name from a parsed FACTION.TXT map (player's files). */
export function factionRelations(factions, id) {
  const f = factions?.get?.(id);
  if (!f) return null;
  const nameOf = (x) => factions.get(x)?.name;
  return {
    name: f.name,
    allies: f.allies.map(nameOf).filter(Boolean),
    enemies: f.enemies.map(nameOf).filter(Boolean),
  };
}
