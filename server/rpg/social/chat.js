// Party, regional and global chat channels. Location chat stays with the runtime.
import { performance } from 'node:perf_hooks';
import { regionNameOf } from '../../../client/gameplay/travel/identity.js';

export const CHANNELS = Object.freeze(['party', 'region', 'global']);
export const MAX_CHAT_LENGTH = 200; // matches server/game.js DEFAULTS.maxChatLength

// Global shout keeps a tighter anti-spam burst while still allowing natural sustained pacing.
// Local, party, whisper, and region channels have generous human-conversation budgets via CHAT_LIMITS.
export const CHAT_RATE_PER_SEC = 2;
export const CHAT_BURST = 5;

export const CHAT_LIMITS = Object.freeze({
  local: Object.freeze({ ratePerSec: 4, burst: 12 }),
  party: Object.freeze({ ratePerSec: 5, burst: 15 }),
  whisper: Object.freeze({ ratePerSec: 5, burst: 15 }),
  region: Object.freeze({ ratePerSec: 3, burst: 10 }),
  global: Object.freeze({ ratePerSec: CHAT_RATE_PER_SEC, burst: CHAT_BURST }),
});

/** Return the rate/burst budget for a chat channel (falls back to `local` for unknown channels). */
export function chatLimitFor(channel) {
  return CHAT_LIMITS[channel] ?? CHAT_LIMITS.local;
}

/**
 * Per-player multi-channel chat limiter with independent token buckets per channel so
 * active party/local/whisper conversation never throttles or collides with global shout limits.
 */
export function createChatLimiter(now = () => performance.now(), overrides = {}) {
  const buckets = new Map();
  return (channel = 'local') => {
    const key = String(channel || 'local');
    let check = buckets.get(key);
    if (!check) {
      const base = chatLimitFor(key);
      const custom = overrides[key];
      const ratePerSec = custom?.ratePerSec ?? base.ratePerSec;
      const burst = custom?.burst ?? base.burst;
      check = tokenBucket(ratePerSec, burst, now);
      buckets.set(key, check);
    }
    return check();
  };
}

// Same character filter as server/game.js (C0/C1 controls, line separators, bidi overrides).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function cleanChatText(raw, maxLength = MAX_CHAT_LENGTH) {
  if (typeof raw !== 'string') throw new Error('Chat needs text.');
  const text = raw.normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Chat message is empty.');
  if (text.length > maxLength) throw new Error(`Chat message is longer than ${maxLength} characters.`);
  return text;
}

// `town:Daggerfall/Gothway Garden` -> `Daggerfall`; `town:0/272` -> `Alik'r Desert`; `dungeon:Privateer's Hold` -> `Privateer's Hold`.
export function regionOf(location) {
  if (typeof location !== 'string' || !location) return 'Unknown';
  const body = location.includes(':') ? location.slice(location.indexOf(':') + 1) : location;
  return regionNameOf(body.split('/')[0]) || 'Unknown';
}

export function tokenBucket(ratePerSec, burst, now = () => performance.now()) {
  let tokens = burst;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

// Mute lookup, most specific first. The runtime may expose any of these; all are honoured.
export function isMuted(ctx, p) {
  try {
    if (typeof ctx.services?.isMuted === 'function' && ctx.services.isMuted(p)) return true;
    if (typeof ctx.isMuted === 'function' && ctx.isMuted(p)) return true;
    if (p.muted === true || (typeof p.muted === 'object' && p.muted !== null)) return true;
    const accountId = p.accountId ?? p.account?.id;
    if (accountId != null && typeof ctx.accounts?.isMuted === 'function' && ctx.accounts.isMuted(accountId)) return true;
  } catch {
    return true; // fail closed: if moderation state cannot be read, do not relay
  }
  return false;
}
