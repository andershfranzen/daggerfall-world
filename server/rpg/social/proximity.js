// Proximity chat, shout/yell distance rules, slash-command parser, and audience selector.
// Shared by server/rpg/social.js (chat.send) and exposed via ctx.services.chatAudience
// so server/game.js can reuse the exact same proximity/shout rules during integration.
import { regionOf } from './chat.js';

/** Default spoken proximity radius in metres (~24 m). */
export const PROXIMITY_RANGE = 24;
/** Cross-boundary exterior shout/yell hearing radius in metres (matches peerView VIEW_RANGE). */
export const SHOUT_RANGE = 160;

export const PROXIMITY_CHANNELS = Object.freeze(['say', 'local', 'shout', 'yell', 'emote', 'whisper']);
export const ALL_CHAT_CHANNELS = Object.freeze(['say', 'local', 'shout', 'yell', 'emote', 'whisper', 'party', 'region', 'global']);

const CHANNEL_ALIASES = Object.freeze({
  say: 'say',
  local: 'say',
  l: 'say',
  shout: 'shout',
  yell: 'shout',
  y: 'shout',
  s: 'shout',
  emote: 'emote',
  me: 'emote',
  whisper: 'whisper',
  w: 'whisper',
  party: 'party',
  p: 'party',
  region: 'region',
  r: 'region',
  global: 'global',
  g: 'global',
});

const SLASH_COMMANDS = Object.freeze({
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

export function canonicalChannel(raw) {
  if (typeof raw !== 'string') return null;
  return CHANNEL_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function distance2D(a, b) {
  return Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0));
}

function locationOf(ctx, p) {
  if (typeof ctx?.location === 'function') return ctx.location(p);
  return p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden';
}

function sameScene(ctx, a, b) {
  return typeof ctx?.sameScene === 'function' ? ctx.sameScene(a, b) : true;
}

/**
 * Parse raw chat input into a structured command:
 * - Plain text -> { channel: 'say', text }
 * - /shout, /yell, /y, /s -> { channel: 'shout', text }
 * - /p, /party, /r, /region, /g, /global, /say, /local, /l, /me -> matching channel
 * - /w <name> <msg> or /whisper "Full Name" <msg> -> { channel: 'whisper', target, text }
 * - /help or /? -> { channel: 'help', text: '' }
 * - Bare leading `/` not matching another known command (e.g. `/Watch out!`) -> { channel: 'shout', text }
 */
export function parseChatCommand(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('/')) {
    return { channel: 'say', text: trimmed.replace(/\s+/g, ' ').trim() };
  }

  const headMatch = /^(\/(?:[a-z]+|\?))(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (headMatch) {
    const cmd = SLASH_COMMANDS[headMatch[1].toLowerCase()];
    if (cmd) {
      const rest = (headMatch[2] ?? '').trim();
      if (cmd === 'help') return { channel: 'help', text: '' };
      if (cmd === 'whisper') return parseWhisperArgs(rest);
      return { channel: cmd, text: rest.replace(/\s+/g, ' ').trim() };
    }
  }

  // Leading `/` that isn't a known command -> Shout/Yell (e.g. `/Watch out!`, `/ Hello!`).
  const shoutText = trimmed.slice(1).replace(/\s+/g, ' ').trim();
  return { channel: 'shout', text: shoutText };
}

function parseWhisperArgs(rest) {
  if (!rest) return { channel: 'whisper', target: '', text: '' };
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0];
    const end = rest.indexOf(q, 1);
    if (end > 1) {
      const target = rest.slice(1, end).replace(/\s+/g, ' ').trim();
      const text = rest.slice(end + 1).replace(/\s+/g, ' ').trim();
      return { channel: 'whisper', target, text };
    }
  }
  const space = rest.search(/\s/);
  if (space < 0) return { channel: 'whisper', target: rest, text: '' };
  return {
    channel: 'whisper',
    target: rest.slice(0, space).trim(),
    text: rest.slice(space + 1).replace(/\s+/g, ' ').trim(),
  };
}

/**
 * Resolve an online whisper recipient by id or name (exact case-insensitive, then unique prefix).
 */
export function findWhisperTarget(players, sender, { target, targetId } = {}) {
  if (targetId != null && targetId !== '') {
    const id = typeof targetId === 'string' ? Number(targetId) : targetId;
    if (!Number.isSafeInteger(id)) throw new Error('Choose a player to whisper to.');
    const found = players.get(id) ?? null;
    if (!found) throw new Error('That player is not online.');
    if (found.id === sender?.id) throw new Error('You cannot whisper to yourself.');
    return found;
  }

  const query = typeof target === 'string' ? target.replace(/\s+/g, ' ').trim() : '';
  if (!query) throw new Error('Choose a player to whisper to.');
  const lower = query.toLowerCase();

  let exact = null;
  const prefixes = [];
  for (const p of players.values()) {
    const name = String(p.name ?? '');
    const nl = name.toLowerCase();
    if (nl === lower) {
      exact = p;
      break;
    }
    if (nl.startsWith(lower)) prefixes.push(p);
  }

  const resolved = exact ?? (prefixes.length === 1 ? prefixes[0] : null);
  if (!resolved) {
    if (prefixes.length > 1) throw new Error(`Multiple players match "${query}". Be more specific.`);
    throw new Error(`No online player named "${query}".`);
  }
  if (resolved.id === sender?.id) throw new Error('You cannot whisper to yourself.');
  return resolved;
}

/**
 * Select the audience of online players who should hear `sender` on `channel`.
 *
 * - `say` / `local` / `emote`: players in the same location & scene within `PROXIMITY_RANGE` (24 m),
 *   plus exterior peers across a boundary via `ctx.services.peerView.across(sender)` within `PROXIMITY_RANGE`.
 * - `shout` / `yell`: all players in the same location & scene (full town/area shout),
 *   plus exterior peers across a boundary via `ctx.services.peerView.across(sender)` within `SHOUT_RANGE` (160 m).
 * - `party`: online members of sender's party.
 * - `region`: all online players in the same region.
 * - `global`: all online players.
 * - `whisper`: sender and resolved recipient.
 */
export function selectChatAudience(ctx, sender, rawChannel = 'say', options = {}) {
  const channel = canonicalChannel(rawChannel);
  if (!channel) throw new Error('Choose say, shout, party, region, global or whisper chat.');

  const players = ctx.players;
  if (channel === 'global') return [...players.values()];

  if (channel === 'region') {
    const region = regionOf(locationOf(ctx, sender), ctx);
    return [...players.values()].filter((o) => regionOf(locationOf(ctx, o), ctx) === region);
  }

  if (channel === 'party') {
    const party = options.party ?? ctx.services?.partyOf?.(sender);
    if (!party) throw new Error('You are not in a party.');
    const ids = party.members ? [...party.members.keys()] : (party.memberIds ?? []);
    return ids.map((id) => players.get(id)).filter(Boolean);
  }

  if (channel === 'whisper') {
    const recipient = options.recipient ?? findWhisperTarget(players, sender, options);
    return sender && recipient.id !== sender.id ? [sender, recipient] : [recipient];
  }

  // Proximity (`say`, `emote`) or full-area `shout`.
  const loc = locationOf(ctx, sender);
  const isProximity = channel === 'say' || channel === 'emote';
  const maxAcross = isProximity ? PROXIMITY_RANGE : SHOUT_RANGE;
  const seen = new Set();
  const recipients = [];
  const add = (p) => {
    if (!p || seen.has(p.id)) return;
    seen.add(p.id);
    recipients.push(p);
  };

  add(sender);

  for (const o of players.values()) {
    if (o.id === sender?.id) continue;
    if (locationOf(ctx, o) !== loc) continue;
    if (!sameScene(ctx, o, sender)) continue;
    if (isProximity && distance2D(sender, o) > PROXIMITY_RANGE) continue;
    add(o);
  }

  // Exterior cross-boundary awareness (e.g. players just across a town gate).
  // `peerView.across(sender)` already restricts to exteriors and excludes interiors/dungeons/scoped scenes.
  const across = ctx.services?.peerView?.across?.(sender) ?? [];
  for (const entry of across) {
    if (!entry?.player) continue;
    const dist = Number.isFinite(entry.distance) ? entry.distance : distance2D(sender, entry);
    if (dist <= maxAcross) add(entry.player);
  }

  return recipients;
}
