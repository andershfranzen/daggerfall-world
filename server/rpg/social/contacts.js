// Account-scoped persistent Friends, Directed Blocks, Privacy Settings, and Moderation Reports.
//
// Persisted via `ctx.dirtyWorld` / `ctx.loadWorld` (atomic with RPG actions on both SQLite and
// PostgreSQL without requiring schema edits outside social's ownership):
//   social:acct:<accountKey>               -> profile, publicLabel, privacy settings, character slots, lastActiveAt
//   social:rel:<minKey>|<maxKey>           -> canonical friend request or accepted friendship (deduped across slots)
//   social:blk:<blockerKey>|<blockedKey>   -> immediate directed block
//   social:report:<reportId>               -> moderation report with bounded selected-record evidence
//
// Privacy invariants:
//   - Never expose raw accountIds, logins, session keys, character rosters, or private coordinates.
//   - Never leak directed-block status in error/status messages to the blocked sender.
//   - Keep letter contents and private account data out of routine logs.
import { randomBytes } from 'node:crypto';
import { regionOf, tokenBucket } from './chat.js';

export const ACCT_PREFIX = 'social:acct:';
export const REL_PREFIX = 'social:rel:';
export const BLK_PREFIX = 'social:blk:';
export const REPORT_PREFIX = 'social:report:';

export const MAX_FRIENDS = 200;
export const MAX_BLOCKS = 200;
export const MAX_PENDING_OUTGOING = 50;
export const MAX_LABEL_LEN = 32;
export const MAX_REPORT_REASON_LEN = 300;
export const MAX_EVIDENCE_EXCERPT_LEN = 300;
export const FRIENDS_PAGE_DEFAULT = 25;
export const FRIENDS_PAGE_MAX = 100;

export const REQUEST_POLICIES = Object.freeze(['everyone', 'none']);
export const PRESENCE_MODES = Object.freeze(['friends', 'hidden']);
export const REPORT_CATEGORIES = Object.freeze(['harassment', 'spam', 'impersonation', 'abuse', 'other']);
export const EVIDENCE_TYPES = Object.freeze(['letter', 'chat', 'interaction']);

export const DEFAULT_PRIVACY = Object.freeze({
  allowRequests: 'everyone',
  showPresence: 'friends',
  showLastActive: true,
  allowLetters: true,
});

// Neutral refusals that never reveal whether the target blocked the sender or restricted privacy.
export const NEUTRAL_REFUSAL = Object.freeze({
  friend: 'That traveller is not accepting friend requests right now.',
  letter: 'Your letter could not be delivered to that traveller.',
  whisper: 'That traveller is not accepting whispers right now.',
  trade: 'That traveller is not available to trade right now.',
  party: 'That traveller is not accepting party invitations right now.',
  visit: 'That traveller is not accepting visitors right now.',
  duel: 'That traveller is not accepting duel challenges right now.',
  default: 'Unable to complete that request right now.',
});

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const newId = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;

export function cleanText(raw, maxLen = 200) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export function cleanLabel(raw) {
  const text = cleanText(raw, MAX_LABEL_LEN);
  return text.length >= 1 ? text : null;
}

/** Canonical account key for a live player, descriptor, or existing key string. */
export function accountKeyOf(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;
    if (s.startsWith('acct:') || s.startsWith('char:')) return s;
    return `acct:${s}`;
  }
  if (typeof input === 'number' && Number.isSafeInteger(input)) {
    return `char:${input}`;
  }
  if (typeof input === 'object') {
    if (typeof input.accountKey === 'string' && input.accountKey) return input.accountKey;
    const aid = input.accountId ?? input.account?.id ?? null;
    if (aid !== null && aid !== undefined && String(aid).trim() !== '') {
      return `acct:${String(aid).trim()}`;
    }
    if (Number.isSafeInteger(input.id)) return `char:${input.id}`;
  }
  return null;
}

/** Stable pair key independent of direction so requests/friendships deduplicate across slots. */
export function pairKeyOf(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function blockKeyOf(blocker, blocked) {
  return `${blocker}|${blocked}`;
}

export function normalizeSettings(raw, base = DEFAULT_PRIVACY) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    allowRequests: REQUEST_POLICIES.includes(s.allowRequests) ? s.allowRequests : base.allowRequests,
    showPresence: PRESENCE_MODES.includes(s.showPresence) ? s.showPresence : base.showPresence,
    showLastActive: typeof s.showLastActive === 'boolean' ? s.showLastActive : base.showLastActive,
    allowLetters: typeof s.allowLetters === 'boolean' ? s.allowLetters : base.allowLetters,
  };
}

function locationOf(ctx, p) {
  if (typeof ctx?.location === 'function') return ctx.location(p);
  return p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden';
}

function isHiddenCharacter(p) {
  return p?.archived === true || p?.rpg?.archived === true || p?.rpg?.chronicles?.hidden === true;
}

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.includes(':')) return null;
  const idx = cursor.indexOf(':');
  const label = cursor.slice(0, idx);
  const key = cursor.slice(idx + 1);
  if (!key) return null;
  return { label, key };
}

export function createContactsService(ctx, { now = () => Date.now(), wallNow = () => Date.now(), onRelationBroken = null, getLetterForReport = null } = {}) {
  const profiles = new Map(); // accountKey -> profile
  const relations = new Map(); // pairKey -> rel
  const blocks = new Map(); // "blocker|blocked" -> { blocker, blocked, createdAt }
  const reports = new Map(); // reportId -> report
  const reqBuckets = new Map(); // accountKey -> tokenBucket
  const reportBuckets = new Map(); // accountKey -> tokenBucket

  const writeWorld = (key, val) => {
    if (typeof ctx.dirtyWorld === 'function') ctx.dirtyWorld(key, val);
  };

  function hydrate() {
    if (typeof ctx.loadWorld !== 'function') return;
    for (const [key, val] of ctx.loadWorld(ACCT_PREFIX)) {
      if (!val || typeof val !== 'object') continue;
      const acctKey = key.slice(ACCT_PREFIX.length);
      if (!acctKey) continue;
      profiles.set(acctKey, {
        accountKey: acctKey,
        publicLabel: cleanLabel(val.publicLabel) ?? 'Traveller',
        activeCharId: Number.isSafeInteger(val.activeCharId) ? val.activeCharId : null,
        activeCharName: typeof val.activeCharName === 'string' ? val.activeCharName : null,
        lastActiveAt: Number.isFinite(val.lastActiveAt) ? val.lastActiveAt : 0,
        characters: val.characters && typeof val.characters === 'object' ? structuredClone(val.characters) : {},
        settings: normalizeSettings(val.settings),
      });
    }
    for (const [key, val] of ctx.loadWorld(REL_PREFIX)) {
      if (!val || typeof val !== 'object' || typeof val.a !== 'string' || typeof val.b !== 'string') continue;
      const pairKey = key.slice(REL_PREFIX.length);
      if (!pairKey || (val.status !== 'pending' && val.status !== 'accepted')) continue;
      relations.set(pairKey, {
        pairKey,
        a: val.a,
        b: val.b,
        status: val.status,
        requestedBy: val.requestedBy,
        requestedAt: Number.isFinite(val.requestedAt) ? val.requestedAt : 0,
        acceptedAt: Number.isFinite(val.acceptedAt) ? val.acceptedAt : null,
        updatedAt: Number.isFinite(val.updatedAt) ? val.updatedAt : 0,
        requestedFromCharId: Number.isSafeInteger(val.requestedFromCharId) ? val.requestedFromCharId : null,
        requestedFromCharName: typeof val.requestedFromCharName === 'string' ? val.requestedFromCharName : null,
      });
    }
    for (const [key, val] of ctx.loadWorld(BLK_PREFIX)) {
      if (!val || typeof val !== 'object' || typeof val.blocker !== 'string' || typeof val.blocked !== 'string') continue;
      const blkKey = key.slice(BLK_PREFIX.length);
      if (!blkKey) continue;
      blocks.set(blkKey, {
        blocker: val.blocker,
        blocked: val.blocked,
        createdAt: Number.isFinite(val.createdAt) ? val.createdAt : 0,
      });
    }
    for (const [key, val] of ctx.loadWorld(REPORT_PREFIX)) {
      if (!val || typeof val !== 'object' || typeof val.id !== 'string') continue;
      reports.set(val.id, structuredClone(val));
    }
  }
  hydrate();

  function requestBucket(acctKey) {
    let b = reqBuckets.get(acctKey);
    if (!b) {
      const rate = ctx.config?.friendRequestRatePerSec ?? 1;
      const burst = ctx.config?.friendRequestBurst ?? 8;
      b = tokenBucket(rate, burst, now);
      reqBuckets.set(acctKey, b);
    }
    return b;
  }

  function reportBucket(acctKey) {
    let b = reportBuckets.get(acctKey);
    if (!b) {
      const rate = ctx.config?.reportRatePerSec ?? 0.2;
      const burst = ctx.config?.reportBurst ?? 4;
      b = tokenBucket(rate, burst, now);
      reportBuckets.set(acctKey, b);
    }
    return b;
  }

  function ensureProfile(p) {
    const key = accountKeyOf(p);
    if (!key) throw new Error('Account identity unavailable.');
    let prof = profiles.get(key);
    if (!prof) {
      const label = cleanLabel(p?.account?.username ?? p?.publicLabel ?? p?.name) ?? 'Traveller';
      prof = {
        accountKey: key,
        publicLabel: label,
        activeCharId: Number.isSafeInteger(p?.id) ? p.id : null,
        activeCharName: typeof p?.name === 'string' ? p.name : null,
        lastActiveAt: wallNow(),
        characters: {},
        settings: { ...DEFAULT_PRIVACY },
      };
      profiles.set(key, prof);
    }
    return prof;
  }

  function saveProfile(prof) {
    writeWorld(`${ACCT_PREFIX}${prof.accountKey}`, prof);
  }

  function onlinePlayersForAccount(acctKey) {
    const out = [];
    for (const p of ctx.players.values()) {
      if (accountKeyOf(p) === acctKey) out.push(p);
    }
    return out;
  }

  function activeOnlinePlayer(acctKey) {
    for (const p of ctx.players.values()) {
      if (accountKeyOf(p) === acctKey) return p;
    }
    return null;
  }

  function registerPlayer(p) {
    const prof = ensureProfile(p);
    const prevCharId = prof.activeCharId;
    const switchedCharacter = prevCharId != null && prevCharId !== p.id;
    prof.activeCharId = p.id;
    prof.activeCharName = p.name;
    prof.lastActiveAt = wallNow();
    if (!prof.publicLabel || prof.publicLabel === 'Traveller') {
      prof.publicLabel = cleanLabel(p.account?.username ?? p.name) ?? prof.publicLabel;
    }
    prof.characters[String(p.id)] = {
      id: p.id,
      name: p.name,
      archived: p.archived === true || p.rpg?.archived === true,
      hidden: isHiddenCharacter(p),
      updatedAt: prof.lastActiveAt,
    };
    saveProfile(prof);
    return { accountKey: prof.accountKey, switchedCharacter, prevCharId };
  }

  function markOffline(p) {
    const key = accountKeyOf(p);
    if (!key) return null;
    const prof = profiles.get(key);
    if (!prof) return key;
    prof.lastActiveAt = wallNow();
    if (prof.activeCharId === p.id) {
      const other = onlinePlayersForAccount(key).find((q) => q.id !== p.id) ?? null;
      prof.activeCharId = other ? other.id : null;
      prof.activeCharName = other ? other.name : null;
    }
    saveProfile(prof);
    return key;
  }

  function isDirectedBlocked(blocker, target) {
    const a = accountKeyOf(blocker);
    const b = accountKeyOf(target);
    if (!a || !b || a === b) return false;
    return blocks.has(blockKeyOf(a, b));
  }

  function isBlocked(a, b) {
    const ka = accountKeyOf(a);
    const kb = accountKeyOf(b);
    if (!ka || !kb || ka === kb) return false;
    return blocks.has(blockKeyOf(ka, kb)) || blocks.has(blockKeyOf(kb, ka));
  }

  function getRelation(a, b) {
    const ka = accountKeyOf(a);
    const kb = accountKeyOf(b);
    if (!ka || !kb || ka === kb) return null;
    return relations.get(pairKeyOf(ka, kb)) ?? null;
  }

  function areFriends(a, b) {
    const rel = getRelation(a, b);
    return Boolean(rel && rel.status === 'accepted' && !isBlocked(a, b));
  }

  function neutralReason(kind = 'default') {
    return NEUTRAL_REFUSAL[kind] ?? NEUTRAL_REFUSAL.default;
  }

  function canInteract(actor, target, kind = 'default') {
    const a = accountKeyOf(actor);
    const b = accountKeyOf(target);
    if (!a || !b || a === b) return { ok: true };
    if (blocks.has(blockKeyOf(a, b))) {
      return { ok: false, reason: 'You have blocked this player. Unblock them first.', selfBlocked: true };
    }
    if (blocks.has(blockKeyOf(b, a))) {
      return { ok: false, reason: neutralReason(kind), selfBlocked: false };
    }
    return { ok: true };
  }

  function labelFor(acctKey) {
    const prof = profiles.get(acctKey);
    if (prof?.publicLabel) return prof.publicLabel;
    const live = activeOnlinePlayer(acctKey);
    return live?.name ?? 'Traveller';
  }

  /**
   * Resolve a target by online peer `targetId`, explicit `accountKey`, or exact case-insensitive `name`.
   * Archived or hidden characters are never surfaced in exact-name lookup.
   */
  function findTargetAccount(actor, { targetId, name, accountKey } = {}) {
    const actorKey = accountKeyOf(actor);
    if (targetId !== undefined && targetId !== null && targetId !== '') {
      const id = typeof targetId === 'string' && targetId.trim() !== '' ? Number(targetId) : targetId;
      if (!Number.isSafeInteger(id)) throw new Error('Choose a valid player.');
      const live = ctx.players.get(id) ?? null;
      if (live) {
        const key = accountKeyOf(live);
        ensureProfile(live);
        return { accountKey: key, player: live, publicLabel: labelFor(key), charId: live.id, charName: live.name };
      }
      // Fall back to known non-archived character id from stored profiles.
      for (const prof of profiles.values()) {
        const ch = prof.characters?.[String(id)];
        if (ch && !ch.archived && !ch.hidden) {
          return { accountKey: prof.accountKey, player: activeOnlinePlayer(prof.accountKey), publicLabel: prof.publicLabel, charId: ch.id, charName: ch.name };
        }
      }
      throw new Error('That traveller could not be found.');
    }

    if (typeof accountKey === 'string' && accountKey.trim()) {
      const key = accountKeyOf(accountKey);
      const prof = profiles.get(key);
      const live = activeOnlinePlayer(key);
      if (!prof && !live) throw new Error('That traveller could not be found.');
      if (live && !prof) ensureProfile(live);
      return { accountKey: key, player: live, publicLabel: labelFor(key), charId: live?.id ?? null, charName: live?.name ?? null };
    }

    const q = cleanText(name, 48);
    if (!q) throw new Error('Enter an exact traveller name or choose a nearby player.');
    const lower = q.toLowerCase();

    // 1. Live non-hidden players by exact character name.
    for (const p of ctx.players.values()) {
      if (isHiddenCharacter(p)) continue;
      if (String(p.name ?? '').toLowerCase() === lower) {
        const key = accountKeyOf(p);
        ensureProfile(p);
        return { accountKey: key, player: p, publicLabel: labelFor(key), charId: p.id, charName: p.name };
      }
    }

    // 2. Stored profiles by exact non-archived/non-hidden character name or active account publicLabel.
    let matched = null;
    for (const prof of profiles.values()) {
      if (prof.accountKey === actorKey) continue;
      const chars = Object.values(prof.characters ?? {});
      const hasVisibleChar = chars.length === 0 || chars.some((ch) => ch && !ch.archived && !ch.hidden);
      const isArchivedName = chars.some((ch) => ch && (ch.archived || ch.hidden) && String(ch.name ?? '').toLowerCase() === lower);
      if (!hasVisibleChar || isArchivedName) continue;
      const labelHit = typeof prof.publicLabel === 'string' && prof.publicLabel.toLowerCase() === lower;
      let charHit = null;
      for (const ch of chars) {
        if (!ch || ch.archived || ch.hidden) continue;
        if (String(ch.name ?? '').toLowerCase() === lower) {
          charHit = ch;
          break;
        }
      }
      if (labelHit || charHit) {
        if (matched && matched.accountKey !== prof.accountKey) {
          throw new Error(`Multiple travellers match "${q}". Inspect them directly instead.`);
        }
        const live = activeOnlinePlayer(prof.accountKey);
        matched = {
          accountKey: prof.accountKey,
          player: live,
          publicLabel: prof.publicLabel,
          charId: charHit?.id ?? live?.id ?? null,
          charName: charHit?.name ?? live?.name ?? null,
        };
      }
    }
    if (matched) return matched;
    throw new Error(`No traveller named "${q}" was found.`);
  }

  function countFriends(acctKey) {
    let n = 0;
    for (const r of relations.values()) {
      if (r.status === 'accepted' && (r.a === acctKey || r.b === acctKey)) n++;
    }
    return n;
  }

  function countOutgoing(acctKey) {
    let n = 0;
    for (const r of relations.values()) {
      if (r.status === 'pending' && r.requestedBy === acctKey) n++;
    }
    return n;
  }

  function countBlocks(acctKey) {
    let n = 0;
    for (const b of blocks.values()) if (b.blocker === acctKey) n++;
    return n;
  }

  function sendFriendRequest(actor, args = {}) {
    const actorProf = ensureProfile(actor);
    const actorKey = actorProf.accountKey;
    const target = findTargetAccount(actor, args);
    const targetKey = target.accountKey;
    if (targetKey === actorKey) throw new Error('You cannot add yourself as a friend.');

    if (!requestBucket(actorKey)()) throw new Error('Slow down a little before sending another request.');

    const check = canInteract(actorKey, targetKey, 'friend');
    if (!check.ok) throw new Error(check.reason);

    const targetProf = profiles.get(targetKey);
    const pk = pairKeyOf(actorKey, targetKey);
    const existing = relations.get(pk);

    if (existing) {
      if (existing.status === 'accepted') throw new Error(`You are already friends with ${target.publicLabel}.`);
      if (existing.requestedBy === actorKey) {
        throw new Error(`You already sent a friend request to ${target.publicLabel}.`);
      }
      // Crossed request: target already requested actor -> deduplicate & accept immediately!
      if (countFriends(actorKey) >= MAX_FRIENDS) throw new Error(`Your friends list is full (${MAX_FRIENDS} max).`);
      if (countFriends(targetKey) >= MAX_FRIENDS) throw new Error(`${target.publicLabel} cannot add more friends right now.`);
      const t = wallNow();
      existing.status = 'accepted';
      existing.acceptedAt = t;
      existing.updatedAt = t;
      writeWorld(`${REL_PREFIX}${pk}`, existing);
      return { status: 'accepted', crossed: true, otherKey: targetKey, otherLabel: target.publicLabel };
    }

    // Target privacy: same neutral message as directed block so block status is never leaked.
    if (targetProf?.settings?.allowRequests === 'none') {
      throw new Error(NEUTRAL_REFUSAL.friend);
    }

    if (countFriends(actorKey) >= MAX_FRIENDS) throw new Error(`Your friends list is full (${MAX_FRIENDS} max).`);
    if (countOutgoing(actorKey) >= MAX_PENDING_OUTGOING) throw new Error('You have too many pending friend requests.');

    const t = wallNow();
    const [a, b] = actorKey < targetKey ? [actorKey, targetKey] : [targetKey, actorKey];
    const rel = {
      pairKey: pk,
      a,
      b,
      status: 'pending',
      requestedBy: actorKey,
      requestedAt: t,
      acceptedAt: null,
      updatedAt: t,
      requestedFromCharId: actor.id,
      requestedFromCharName: actor.name,
    };
    relations.set(pk, rel);
    writeWorld(`${REL_PREFIX}${pk}`, rel);
    return { status: 'pending', crossed: false, otherKey: targetKey, otherLabel: target.publicLabel };
  }

  function acceptFriendRequest(actor, args = {}) {
    const actorKey = ensureProfile(actor).accountKey;
    const target = findTargetAccount(actor, { accountKey: args.accountKey ?? args.fromAccount, targetId: args.targetId, name: args.name });
    const targetKey = target.accountKey;
    const pk = pairKeyOf(actorKey, targetKey);
    const rel = relations.get(pk);
    if (!rel || rel.status !== 'pending' || rel.requestedBy === actorKey) {
      throw new Error('That friend request is no longer pending.');
    }
    const check = canInteract(actorKey, targetKey, 'friend');
    if (!check.ok) throw new Error(check.reason);
    if (countFriends(actorKey) >= MAX_FRIENDS) throw new Error(`Your friends list is full (${MAX_FRIENDS} max).`);
    if (countFriends(targetKey) >= MAX_FRIENDS) throw new Error(`${target.publicLabel} cannot add more friends right now.`);
    const t = wallNow();
    rel.status = 'accepted';
    rel.acceptedAt = t;
    rel.updatedAt = t;
    writeWorld(`${REL_PREFIX}${pk}`, rel);
    return { otherKey: targetKey, otherLabel: target.publicLabel };
  }

  function declineFriendRequest(actor, args = {}) {
    const actorKey = ensureProfile(actor).accountKey;
    const target = findTargetAccount(actor, { accountKey: args.accountKey ?? args.fromAccount, targetId: args.targetId, name: args.name });
    const targetKey = target.accountKey;
    const pk = pairKeyOf(actorKey, targetKey);
    const rel = relations.get(pk);
    if (!rel || rel.status !== 'pending') {
      throw new Error('That friend request is no longer pending.');
    }
    const withdrew = rel.requestedBy === actorKey;
    relations.delete(pk);
    writeWorld(`${REL_PREFIX}${pk}`, null);
    return { otherKey: targetKey, otherLabel: target.publicLabel, withdrew };
  }

  function removeFriend(actor, args = {}) {
    const actorKey = ensureProfile(actor).accountKey;
    const target = findTargetAccount(actor, { accountKey: args.accountKey, targetId: args.targetId, name: args.name });
    const targetKey = target.accountKey;
    const pk = pairKeyOf(actorKey, targetKey);
    const rel = relations.get(pk);
    if (!rel || rel.status !== 'accepted') {
      throw new Error('That traveller is not on your friends list.');
    }
    relations.delete(pk);
    writeWorld(`${REL_PREFIX}${pk}`, null);
    return { otherKey: targetKey, otherLabel: target.publicLabel };
  }

  function blockPlayer(actor, args = {}) {
    const actorKey = ensureProfile(actor).accountKey;
    const target = findTargetAccount(actor, args);
    const targetKey = target.accountKey;
    if (targetKey === actorKey) throw new Error('You cannot block yourself.');
    const bk = blockKeyOf(actorKey, targetKey);
    if (blocks.has(bk)) throw new Error(`${target.publicLabel} is already blocked.`);
    if (countBlocks(actorKey) >= MAX_BLOCKS) throw new Error(`Your block list is full (${MAX_BLOCKS} max).`);
    const record = { blocker: actorKey, blocked: targetKey, createdAt: wallNow() };
    blocks.set(bk, record);
    writeWorld(`${BLK_PREFIX}${bk}`, record);
    // Immediately sever friendship or pending request without notifying target that they were blocked.
    const pk = pairKeyOf(actorKey, targetKey);
    let hadRelation = false;
    if (relations.has(pk)) {
      hadRelation = true;
      relations.delete(pk);
      writeWorld(`${REL_PREFIX}${pk}`, null);
    }
    if (typeof onRelationBroken === 'function') {
      onRelationBroken(actorKey, targetKey);
    }
    return { targetKey, targetLabel: target.publicLabel, hadRelation };
  }

  function unblockPlayer(actor, args = {}) {
    const actorKey = ensureProfile(actor).accountKey;
    const target = findTargetAccount(actor, args);
    const targetKey = target.accountKey;
    const bk = blockKeyOf(actorKey, targetKey);
    if (!blocks.has(bk)) throw new Error('That traveller is not on your block list.');
    blocks.delete(bk);
    writeWorld(`${BLK_PREFIX}${bk}`, null);
    return { targetKey, targetLabel: target.publicLabel };
  }

  function updateSettings(actor, args = {}) {
    const prof = ensureProfile(actor);
    const next = normalizeSettings(args, prof.settings);
    prof.settings = next;
    if (args.publicLabel !== undefined) {
      const cleaned = cleanLabel(args.publicLabel);
      if (!cleaned) throw new Error('Public label must be 1 to 32 characters.');
      prof.publicLabel = cleaned;
    }
    saveProfile(prof);
    return { settings: { ...prof.settings }, publicLabel: prof.publicLabel };
  }

  function submitReport(actor, args = {}) {
    const actorProf = ensureProfile(actor);
    const actorKey = actorProf.accountKey;
    if (!reportBucket(actorKey)()) throw new Error('Please wait before submitting another report.');

    const category = REPORT_CATEGORIES.includes(args.category) ? args.category : null;
    if (!category) throw new Error(`Choose a report category: ${REPORT_CATEGORIES.join(', ')}.`);
    const reason = cleanText(args.reason, MAX_REPORT_REASON_LEN);
    if (reason.length < 4) throw new Error('Please include a brief reason for the report.');
    const evidenceType = EVIDENCE_TYPES.includes(args.evidenceType) ? args.evidenceType : 'interaction';

    let targetKey = null;
    let targetCharId = null;
    let targetName = null;
    let evidenceId = args.evidenceId != null ? String(args.evidenceId).slice(0, 80) : null;
    let evidenceSnapshot = null;

    if (evidenceType === 'letter') {
      if (!evidenceId) throw new Error('Select a letter to attach as evidence.');
      if (typeof getLetterForReport !== 'function') throw new Error('Letter evidence lookup is unavailable.');
      const snap = getLetterForReport(actorKey, evidenceId);
      evidenceSnapshot = snap;
      targetKey = snap.otherAccount;
      targetCharId = snap.otherCharId ?? null;
      targetName = snap.otherLabel ?? 'Traveller';
    } else {
      const target = findTargetAccount(actor, {
        targetId: args.targetId,
        accountKey: args.targetAccount ?? args.accountKey,
        name: args.targetName ?? args.name,
      });
      if (target.accountKey === actorKey) throw new Error('You cannot report yourself.');
      targetKey = target.accountKey;
      targetCharId = target.charId;
      targetName = target.publicLabel;
      const excerpt = cleanText(args.evidenceExcerpt ?? '', MAX_EVIDENCE_EXCERPT_LEN);
      evidenceSnapshot = {
        type: evidenceType,
        ...(evidenceId ? { recordId: evidenceId } : {}),
        ...(excerpt ? { excerpt } : {}),
        location: locationOf(ctx, actor),
      };
    }

    const id = newId('rep_');
    const report = {
      id,
      reporterAccount: actorKey,
      reporterCharId: actor.id,
      reporterName: actor.name,
      targetAccount: targetKey,
      targetCharId,
      targetName,
      category,
      reason,
      evidenceType,
      evidenceId,
      evidenceSnapshot,
      createdAt: wallNow(),
      status: 'open',
    };
    reports.set(id, report);
    writeWorld(`${REPORT_PREFIX}${id}`, report);
    // Keep private content and letter bodies out of routine server logs.
    ctx.log?.info?.(`[social:report] id=${id} category=${category} evidence=${evidenceType}`);
    return { id, category, evidenceType, createdAt: report.createdAt, status: report.status };
  }

  function listReports({ limit = 50 } = {}) {
    const cap = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    return [...reports.values()]
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, cap)
      .map((r) => structuredClone(r));
  }

  function getReport(id) {
    const r = reports.get(String(id));
    return r ? structuredClone(r) : null;
  }

  function friendAccountKeys(acctKey) {
    const set = new Set();
    for (const rel of relations.values()) {
      if (rel.status !== 'accepted') continue;
      if (rel.a === acctKey) set.add(rel.b);
      else if (rel.b === acctKey) set.add(rel.a);
    }
    return set;
  }

  function presenceForFriend(otherKey) {
    const prof = profiles.get(otherKey);
    const settings = prof?.settings ?? DEFAULT_PRIVACY;
    const allowPresence = settings.showPresence !== 'hidden';
    const live = allowPresence ? activeOnlinePlayer(otherKey) : null;
    const liveVisible = live && !isHiddenCharacter(live) ? live : null;
    const online = Boolean(liveVisible);
    return {
      accountKey: otherKey,
      publicLabel: prof?.publicLabel ?? liveVisible?.name ?? 'Traveller',
      online,
      presenceHidden: !allowPresence,
      characterName: online ? liveVisible.name : null,
      characterId: online ? liveVisible.id : null,
      region: online ? regionOf(locationOf(ctx, liveVisible), ctx) : null,
      lastActiveAt: allowPresence && settings.showLastActive ? (prof?.lastActiveAt ?? null) : null,
      allowLetters: settings.allowLetters !== false,
    };
  }

  function friendsView(actor, { cursor = null, limit = FRIENDS_PAGE_DEFAULT, filter = 'all' } = {}) {
    const prof = ensureProfile(actor);
    const actorKey = prof.accountKey;
    const cap = Math.max(1, Math.min(FRIENDS_PAGE_MAX, Math.floor(Number(limit) || FRIENDS_PAGE_DEFAULT)));

    const allFriends = [];
    const incoming = [];
    const outgoing = [];

    for (const rel of relations.values()) {
      if (rel.a !== actorKey && rel.b !== actorKey) continue;
      const otherKey = rel.a === actorKey ? rel.b : rel.a;
      if (isBlocked(actorKey, otherKey)) continue;
      if (rel.status === 'accepted') {
        const entry = { ...presenceForFriend(otherKey), since: rel.acceptedAt ?? rel.updatedAt };
        if (filter === 'online' && !entry.online) continue;
        allFriends.push(entry);
      } else if (rel.status === 'pending') {
        if (rel.requestedBy === actorKey) {
          outgoing.push({
            accountKey: otherKey,
            publicLabel: labelFor(otherKey),
            requestedAt: rel.requestedAt,
          });
        } else {
          incoming.push({
            accountKey: otherKey,
            publicLabel: labelFor(otherKey),
            fromCharacterName: rel.requestedFromCharName ?? null,
            requestedAt: rel.requestedAt,
          });
        }
      }
    }

    // Stable sort order: publicLabel ASC (case-insensitive), accountKey ASC.
    allFriends.sort((x, y) => x.publicLabel.toLowerCase().localeCompare(y.publicLabel.toLowerCase()) || x.accountKey.localeCompare(y.accountKey));
    incoming.sort((x, y) => y.requestedAt - x.requestedAt || x.accountKey.localeCompare(y.accountKey));
    outgoing.sort((x, y) => y.requestedAt - x.requestedAt || x.accountKey.localeCompare(y.accountKey));

    let startIdx = 0;
    const parsed = parseCursor(cursor);
    if (parsed) {
      startIdx = allFriends.findIndex((f) => {
        const cmp = f.publicLabel.toLowerCase().localeCompare(parsed.label);
        return cmp > 0 || (cmp === 0 && f.accountKey.localeCompare(parsed.key) > 0);
      });
      if (startIdx < 0) startIdx = allFriends.length;
    }

    const page = allFriends.slice(startIdx, startIdx + cap);
    const hasMore = startIdx + cap < allFriends.length;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? `${last.publicLabel.toLowerCase()}:${last.accountKey}` : null;

    const myBlocks = [];
    for (const blk of blocks.values()) {
      if (blk.blocker !== actorKey) continue;
      myBlocks.push({
        accountKey: blk.blocked,
        publicLabel: labelFor(blk.blocked),
        blockedAt: blk.createdAt,
      });
    }
    myBlocks.sort((x, y) => y.blockedAt - x.blockedAt || x.accountKey.localeCompare(y.accountKey));

    return {
      publicLabel: prof.publicLabel,
      settings: { ...prof.settings },
      totalFriends: allFriends.length,
      onlineFriends: allFriends.filter((f) => f.online).length,
      friends: page,
      nextCursor,
      incoming,
      outgoing,
      blocks: myBlocks,
    };
  }

  function onCharacterArchived(accountId, charId) {
    const key = accountKeyOf(accountId);
    const prof = profiles.get(key);
    if (!prof) return;
    const c = prof.characters?.[String(charId)];
    if (c) {
      c.archived = true;
      c.hidden = true;
      c.updatedAt = now();
    }
    if (prof.activeCharId === charId) {
      prof.activeCharId = null;
      prof.activeCharName = null;
    }
    saveProfile(prof);
  }

  function onAccountDeleted(accountId) {
    const key = accountKeyOf(accountId);
    if (!key) return [];
    const affected = new Set();
    for (const [pk, rel] of [...relations]) {
      if (rel.a === key || rel.b === key) {
        affected.add(rel.a === key ? rel.b : rel.a);
        relations.delete(pk);
        writeWorld(`${REL_PREFIX}${pk}`, null);
      }
    }
    for (const [bk, blk] of [...blocks]) {
      if (blk.blocker === key || blk.blocked === key) {
        blocks.delete(bk);
        writeWorld(`${BLK_PREFIX}${bk}`, null);
      }
    }
    profiles.delete(key);
    reqBuckets.delete(key);
    reportBuckets.delete(key);
    writeWorld(`${ACCT_PREFIX}${key}`, null);
    return [...affected];
  }

  function capture() {
    return structuredClone({ profiles, relations, blocks, reports });
  }

  function restore(saved) {
    for (const [live, copy] of [
      [profiles, saved.profiles],
      [relations, saved.relations],
      [blocks, saved.blocks],
      [reports, saved.reports],
    ]) {
      live.clear();
      for (const [k, v] of copy) live.set(k, v);
    }
  }

  return {
    profiles,
    relations,
    blocks,
    reports,
    accountKeyOf,
    ensureProfile,
    registerPlayer,
    markOffline,
    onlinePlayersForAccount,
    activeOnlinePlayer,
    isDirectedBlocked,
    isBlocked,
    areFriends,
    canInteract,
    labelFor,
    findTargetAccount,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    removeFriend,
    blockPlayer,
    unblockPlayer,
    updateSettings,
    submitReport,
    listReports,
    getReport,
    friendAccountKeys,
    friendsView,
    onCharacterArchived,
    onAccountDeleted,
    capture,
    restore,
  };
}
