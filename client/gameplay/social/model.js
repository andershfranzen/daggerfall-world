// DOM-free helpers for the Social panel (Party, Trade, Friends & Blocks, Mailbox, Group Travel).

export const CHANNEL_PREFIXES = Object.freeze({ '/p': 'party', '/party': 'party', '/r': 'region', '/region': 'region', '/g': 'global', '/global': 'global' });

export const CHAT_COMMAND_PREFIXES = Object.freeze({
  '/say': 'say',
  '/local': 'say',
  '/l': 'say',
  '/shout': 'shout',
  '/yell': 'shout',
  '/y': 'shout',
  '/s': 'shout',
  '/me': 'emote',
  '/w': 'whisper',
  '/whisper': 'whisper',
  '/p': 'party',
  '/party': 'party',
  '/r': 'region',
  '/region': 'region',
  '/g': 'global',
  '/global': 'global',
  '/help': 'help',
  '/?': 'help',
});

export const CHAT_HELP_SUMMARY = 'Chat: plain text speaks nearby (~24 m) · /<message> or /yell (/y, /s, /shout) shouts across the area · /me <action> · /w <name> <msg> · /p party · /r region · /g global';

export const SOCIAL_TABS = Object.freeze(['fellowship', 'friends', 'letters']);

/** `/p hello` -> {channel:'party', text:'hello'}; anything else -> null (location chat). */
export function parseChannelCommand(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\/[a-z]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  if (!m) return null;
  const channel = CHANNEL_PREFIXES[m[1].toLowerCase()];
  if (!channel) return null;
  return { channel, text: (m[2] ?? '').replace(/\s+/g, ' ').trim() };
}

function parseWhisperRest(rest) {
  if (!rest) return { channel: 'whisper', target: '', text: '' };
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0];
    const end = rest.indexOf(q, 1);
    if (end > 1) {
      return {
        channel: 'whisper',
        target: rest.slice(1, end).replace(/\s+/g, ' ').trim(),
        text: rest.slice(end + 1).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  const sp = rest.search(/\s/);
  if (sp < 0) return { channel: 'whisper', target: rest, text: '' };
  return {
    channel: 'whisper',
    target: rest.slice(0, sp).trim(),
    text: rest.slice(sp + 1).replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Parse HUD chat input:
 * - Plain text -> { channel: 'say', text } (proximity ~24 m)
 * - /shout, /yell, /y, /s, or bare leading `/` (e.g. `/Watch out!`) -> { channel: 'shout', text }
 * - /p, /party, /r, /region, /g, /global, /say, /local, /l, /me, /w, /whisper, /help
 */
export function parseChatInput(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('/')) {
    return { channel: 'say', text: trimmed.replace(/\s+/g, ' ').trim() };
  }
  const m = /^(\/(?:[a-z]+|\?))(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (m) {
    const channel = CHAT_COMMAND_PREFIXES[m[1].toLowerCase()];
    if (channel) {
      const rest = (m[2] ?? '').trim();
      if (channel === 'help') return { channel: 'help', text: '' };
      if (channel === 'whisper') return parseWhisperRest(rest);
      return { channel, text: rest.replace(/\s+/g, ' ').trim() };
    }
  }
  // Any other leading `/` (e.g. `/Watch out!`) shouts across the area.
  return { channel: 'shout', text: trimmed.slice(1).replace(/\s+/g, ' ').trim() };
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

/** Human-readable relative or short timestamp for letters and last-active presence. */
export function formatRelativeTime(ts, nowMs = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 'Unknown';
  const diff = Math.max(0, nowMs - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'Just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** Human-readable friend presence line respecting privacy flags. */
export function describeFriendPresence(friend, nowMs = Date.now()) {
  if (!friend) return '';
  if (friend.presenceHidden) return 'Status hidden';
  if (friend.online) {
    const parts = ['Online'];
    if (friend.characterName && friend.characterName !== friend.publicLabel) parts.push(`as ${friend.characterName}`);
    if (friend.region) parts.push(`in ${friend.region}`);
    return parts.join(' · ');
  }
  if (friend.lastActiveAt) return `Offline · Last active ${formatRelativeTime(friend.lastActiveAt, nowMs)}`;
  return 'Offline';
}

/** Human-readable party member location line respecting sharing mode & restricted instances. */
export function describeMemberLocation(member) {
  const ls = member?.locationSharing;
  if (!member?.online) return 'Offline';
  if (!ls || !ls.shared) return 'Location hidden';
  if (ls.restricted) return `${ls.region || 'Iliac Bay'} · Restricted area`;
  const base = ls.landmark && ls.region && ls.landmark !== ls.region
    ? `${ls.landmark}, ${ls.region}`
    : (ls.landmark || ls.region || 'Online');
  if (ls.mode === 'exact' && ls.exact && Number.isFinite(ls.exact.x) && Number.isFinite(ls.exact.z)) {
    return `${base} · Pin (${Math.round(ls.exact.x)}, ${Math.round(ls.exact.z)})`;
  }
  return base;
}

/** Clear all account/character-private UI caches before switching character or disconnecting. */
export function resetPrivateUiState(ui) {
  ui.social = null;
  ui.selectedId = null;
  ui.draft = null;
  ui.recentChat.length = 0;
  ui.friendsExtra = [];
  ui.friendsNextCursor = null;
  ui.mailExtra = { inbox: [], sent: [] };
  ui.mailNextCursor = { inbox: null, sent: null };
  ui.activeThread = null;
  ui.mailReply = '';
  ui.composeMail = null;
  ui.travelQuote = null;
  ui.reportDraft = null;
  ui.status = '';
}
