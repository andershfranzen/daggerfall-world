// Account-scoped Mailbox (plain-text letters between accepted friends).
//
// Persisted via `ctx.dirtyWorld` / `ctx.loadWorld` under `social:mail:<letterId>`:
//   - Inbox, Sent, Reply threading, Unread counts, Per-viewer delete
//   - Cursor-paginated private views (stable sort: createdAt DESC, id DESC)
//   - Strict ownership & block/privacy enforcement (never leaks block status)
//   - Length, rate, mute, and bounded idempotency validation
//   - Plain-text storage and offline delivery across server restarts and character switches
import { randomBytes } from 'node:crypto';
import { isMuted, tokenBucket } from './chat.js';
import { NEUTRAL_REFUSAL, accountKeyOf } from './contacts.js';

export const MAIL_PREFIX = 'social:mail:';
export const MAX_SUBJECT_LEN = 80;
export const MAX_BODY_LEN = 800; // fits safely inside runtime ARG_LIMITS.maxStringLength (1000)
export const MAIL_PAGE_DEFAULT = 20;
export const MAIL_PAGE_MAX = 50;
export const MAIL_RATE_PER_SEC = 0.2; // 1 letter per 5s sustained
export const MAIL_BURST = 5;
const REQUEST_ID_RE = /^[\w-]{4,64}$/;

// Control characters excluding \n (for plain-text multi-line letter bodies) and all controls (for subject).
// eslint-disable-next-line no-control-regex
const SUBJECT_CTRL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const BODY_CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const newLetterId = () => `ltr_${randomBytes(6).toString('hex')}`;

export function cleanSubject(raw, fallback = '(No subject)') {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') throw new Error('Letter subject must be text.');
  const s = raw.normalize('NFC').replace(SUBJECT_CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  if (s.length > MAX_SUBJECT_LEN) throw new Error(`Subject must be at most ${MAX_SUBJECT_LEN} characters.`);
  return s;
}

export function cleanBody(raw) {
  if (typeof raw !== 'string') throw new Error('Write a message before sending your letter.');
  const text = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(BODY_CTRL_RE, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!text) throw new Error('Write a message before sending your letter.');
  if (text.length > MAX_BODY_LEN) throw new Error(`Letter body must be at most ${MAX_BODY_LEN} characters.`);
  return text;
}

function parseDescCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.includes(':')) return null;
  const idx = cursor.indexOf(':');
  const ts = Number(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (!Number.isFinite(ts) || !id) return null;
  return { ts, id };
}

function parseAscCursor(cursor) {
  return parseDescCursor(cursor);
}

export function createMailboxService(ctx, { now = () => Date.now(), wallNow = () => Date.now(), contacts } = {}) {
  const letters = new Map(); // letterId -> letter
  const idempotency = new Map(); // `${acctKey}:${requestId}` -> { paramsHash, letterId }
  const mailBuckets = new Map(); // acctKey -> tokenBucket

  const writeWorld = (key, val) => {
    if (typeof ctx.dirtyWorld === 'function') ctx.dirtyWorld(key, val);
  };

  function hydrate() {
    if (typeof ctx.loadWorld !== 'function') return;
    for (const [key, val] of ctx.loadWorld(MAIL_PREFIX)) {
      if (!val || typeof val !== 'object' || typeof val.id !== 'string') continue;
      if (typeof val.fromAccount !== 'string' || typeof val.toAccount !== 'string') continue;
      letters.set(val.id, {
        id: val.id,
        threadId: typeof val.threadId === 'string' && val.threadId ? val.threadId : val.id,
        parentId: typeof val.parentId === 'string' ? val.parentId : null,
        fromAccount: val.fromAccount,
        fromLabel: String(val.fromLabel ?? 'Traveller'),
        fromCharId: Number.isSafeInteger(val.fromCharId) ? val.fromCharId : null,
        fromCharName: typeof val.fromCharName === 'string' ? val.fromCharName : null,
        toAccount: val.toAccount,
        toLabel: String(val.toLabel ?? 'Traveller'),
        toCharId: Number.isSafeInteger(val.toCharId) ? val.toCharId : null,
        toCharName: typeof val.toCharName === 'string' ? val.toCharName : null,
        subject: String(val.subject ?? '(No subject)'),
        body: String(val.body ?? ''),
        createdAt: Number.isFinite(val.createdAt) ? val.createdAt : 0,
        readAt: Number.isFinite(val.readAt) ? val.readAt : null,
        deletedBySender: val.deletedBySender === true,
        deletedByRecipient: val.deletedByRecipient === true,
      });
    }
  }
  hydrate();

  function limiterFor(acctKey) {
    let b = mailBuckets.get(acctKey);
    if (!b) {
      const rate = ctx.config?.mailRatePerSec ?? MAIL_RATE_PER_SEC;
      const burst = ctx.config?.mailBurst ?? MAIL_BURST;
      b = tokenBucket(rate, burst, now);
      mailBuckets.set(acctKey, b);
    }
    return b;
  }

  function visibleFor(letter, acctKey) {
    if (!letter) return false;
    if (letter.toAccount === acctKey && !letter.deletedByRecipient) return true;
    if (letter.fromAccount === acctKey && !letter.deletedBySender) return true;
    return false;
  }

  function projectLetter(letter, viewerKey, { includeBody = true } = {}) {
    const incoming = letter.toAccount === viewerKey;
    return {
      id: letter.id,
      threadId: letter.threadId,
      parentId: letter.parentId,
      direction: incoming ? 'inbox' : 'sent',
      fromAccount: letter.fromAccount,
      fromLabel: contacts.labelFor(letter.fromAccount) || letter.fromLabel,
      fromCharName: letter.fromCharName,
      toAccount: letter.toAccount,
      toLabel: contacts.labelFor(letter.toAccount) || letter.toLabel,
      toCharName: letter.toCharName,
      subject: letter.subject,
      ...(includeBody ? { body: letter.body } : { preview: letter.body.slice(0, 96) }),
      createdAt: letter.createdAt,
      readAt: letter.readAt,
      unread: incoming && letter.readAt == null,
    };
  }

  function unreadCount(acctKey) {
    let n = 0;
    for (const l of letters.values()) {
      if (l.toAccount === acctKey && !l.deletedByRecipient && l.readAt == null) n++;
    }
    return n;
  }

  function sendLetter(actor, args = {}) {
    if (isMuted(ctx, actor)) throw new Error('You are muted and cannot send letters right now.');
    const senderProf = contacts.ensureProfile(actor);
    const senderKey = senderProf.accountKey;

    let parent = null;
    let targetKey = null;
    let targetLabel = null;
    let targetCharId = null;
    let targetCharName = null;

    if (args.replyToId != null && args.replyToId !== '') {
      const pid = String(args.replyToId);
      parent = letters.get(pid);
      if (!parent || !visibleFor(parent, senderKey)) {
        throw new Error('The letter you are replying to is no longer available.');
      }
      targetKey = parent.fromAccount === senderKey ? parent.toAccount : parent.fromAccount;
      targetLabel = contacts.labelFor(targetKey);
      const liveTarget = contacts.activeOnlinePlayer(targetKey);
      targetCharId = liveTarget?.id ?? null;
      targetCharName = liveTarget?.name ?? null;
    } else {
      const target = contacts.findTargetAccount(actor, {
        accountKey: args.toAccount ?? args.accountKey,
        targetId: args.targetId,
        name: args.toName ?? args.name,
      });
      targetKey = target.accountKey;
      targetLabel = target.publicLabel;
      targetCharId = target.charId;
      targetCharName = target.charName;
    }

    if (targetKey === senderKey) throw new Error('You cannot send a letter to yourself.');

    const defaultSubj = parent
      ? (/^re:\s*/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`).slice(0, MAX_SUBJECT_LEN)
      : '(No subject)';
    const subject = cleanSubject(args.subject, defaultSubj);
    const body = cleanBody(args.body);

    const requestId = typeof args.requestId === 'string' && REQUEST_ID_RE.test(args.requestId) ? args.requestId : null;
    const idemKey = requestId ? `${senderKey}:${requestId}` : null;
    const paramsHash = JSON.stringify([targetKey, parent?.id ?? null, subject, body]);
    if (idemKey && idempotency.has(idemKey)) {
      const prev = idempotency.get(idemKey);
      if (prev.paramsHash !== paramsHash) {
        throw new Error('That request identifier was already used for a different letter.');
      }
      const existing = letters.get(prev.letterId);
      if (existing) {
        return { letter: existing, duplicate: true, recipientKey: targetKey };
      }
    }

    // Directed block and privacy checks (never leak whether recipient blocked sender).
    const interact = contacts.canInteract(senderKey, targetKey, 'letter');
    if (!interact.ok) throw new Error(interact.reason);

    // Must be accepted friends AND recipient must allow letters.
    if (!contacts.areFriends(senderKey, targetKey)) {
      throw new Error(NEUTRAL_REFUSAL.letter);
    }
    const targetProf = contacts.profiles.get(targetKey);
    if (targetProf?.settings?.allowLetters === false) {
      throw new Error(NEUTRAL_REFUSAL.letter);
    }

    if (!limiterFor(senderKey)()) {
      throw new Error('You are sending letters too quickly. Wait a moment and try again.');
    }

    const id = newLetterId();
    const record = {
      id,
      threadId: parent ? parent.threadId : id,
      parentId: parent ? parent.id : null,
      fromAccount: senderKey,
      fromLabel: senderProf.publicLabel,
      fromCharId: actor.id,
      fromCharName: actor.name,
      toAccount: targetKey,
      toLabel: targetLabel || contacts.labelFor(targetKey),
      toCharId: targetCharId,
      toCharName: targetCharName,
      subject,
      body,
      createdAt: wallNow(),
      readAt: null,
      deletedBySender: false,
      deletedByRecipient: false,
    };

    letters.set(id, record);
    writeWorld(`${MAIL_PREFIX}${id}`, record);
    if (idemKey) {
      idempotency.set(idemKey, { paramsHash, letterId: id });
      if (idempotency.size > 512) {
        const oldest = idempotency.keys().next().value;
        idempotency.delete(oldest);
      }
    }
    return { letter: record, duplicate: false, recipientKey: targetKey };
  }

  function listLetters(actor, { folder = 'inbox', cursor = null, limit = MAIL_PAGE_DEFAULT } = {}) {
    const acctKey = contacts.ensureProfile(actor).accountKey;
    const f = folder === 'sent' ? 'sent' : 'inbox';
    const cap = Math.max(1, Math.min(MAIL_PAGE_MAX, Math.floor(Number(limit) || MAIL_PAGE_DEFAULT)));

    const matched = [];
    for (const l of letters.values()) {
      if (f === 'inbox' && l.toAccount === acctKey && !l.deletedByRecipient) matched.push(l);
      else if (f === 'sent' && l.fromAccount === acctKey && !l.deletedBySender) matched.push(l);
    }

    // Stable descending order: createdAt DESC, id DESC.
    matched.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    let start = 0;
    const parsed = parseDescCursor(cursor);
    if (parsed) {
      start = matched.findIndex((l) => l.createdAt < parsed.ts || (l.createdAt === parsed.ts && l.id.localeCompare(parsed.id) < 0));
      if (start < 0) start = matched.length;
    }

    const page = matched.slice(start, start + cap);
    const hasMore = start + cap < matched.length;
    const tail = page[page.length - 1];
    const nextCursor = hasMore && tail ? `${tail.createdAt}:${tail.id}` : null;

    return {
      folder: f,
      total: matched.length,
      unreadCount: unreadCount(acctKey),
      items: page.map((l) => projectLetter(l, acctKey, { includeBody: true })),
      nextCursor,
    };
  }

  function getThread(actor, { threadId, cursor = null, limit = MAIL_PAGE_MAX, markRead = false } = {}) {
    const acctKey = contacts.ensureProfile(actor).accountKey;
    const tid = typeof threadId === 'string' ? threadId.trim() : '';
    if (!tid) throw new Error('Choose a letter thread to read.');
    const cap = Math.max(1, Math.min(MAIL_PAGE_MAX, Math.floor(Number(limit) || MAIL_PAGE_MAX)));

    const matched = [];
    for (const l of letters.values()) {
      if (l.threadId !== tid) continue;
      if (!visibleFor(l, acctKey)) continue;
      matched.push(l);
    }
    if (!matched.length) throw new Error('That letter thread is not available.');

    matched.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    let start = 0;
    const parsed = parseAscCursor(cursor);
    if (parsed) {
      start = matched.findIndex((l) => l.createdAt > parsed.ts || (l.createdAt === parsed.ts && l.id.localeCompare(parsed.id) > 0));
      if (start < 0) start = matched.length;
    }

    const page = matched.slice(start, start + cap);
    const hasMore = start + cap < matched.length;
    const tail = page[page.length - 1];
    const nextCursor = hasMore && tail ? `${tail.createdAt}:${tail.id}` : null;

    let marked = 0;
    if (markRead) {
      const t = wallNow();
      for (const l of page) {
        if (l.toAccount === acctKey && !l.deletedByRecipient && l.readAt == null) {
          l.readAt = t;
          writeWorld(`${MAIL_PREFIX}${l.id}`, l);
          marked++;
        }
      }
    }

    const root = matched[0];
    const otherAccount = root.fromAccount === acctKey ? root.toAccount : root.fromAccount;
    return {
      threadId: tid,
      subject: root.subject,
      otherAccount,
      otherLabel: contacts.labelFor(otherAccount),
      canReply: contacts.areFriends(acctKey, otherAccount) && contacts.canInteract(acctKey, otherAccount, 'letter').ok,
      messages: page.map((l) => projectLetter(l, acctKey, { includeBody: true })),
      nextCursor,
      markedRead: marked,
      unreadCount: unreadCount(acctKey),
    };
  }

  function markRead(actor, { letterId } = {}) {
    const acctKey = contacts.ensureProfile(actor).accountKey;
    const id = typeof letterId === 'string' ? letterId.trim() : '';
    const letter = letters.get(id);
    if (!letter || letter.toAccount !== acctKey || letter.deletedByRecipient) {
      throw new Error('That letter is not in your inbox.');
    }
    let changed = false;
    if (letter.readAt == null) {
      letter.readAt = wallNow();
      writeWorld(`${MAIL_PREFIX}${id}`, letter);
      changed = true;
    }
    return {
      letter: projectLetter(letter, acctKey, { includeBody: true }),
      changed,
      unreadCount: unreadCount(acctKey),
    };
  }

  function deleteLetter(actor, { letterId } = {}) {
    const acctKey = contacts.ensureProfile(actor).accountKey;
    const id = typeof letterId === 'string' ? letterId.trim() : '';
    const letter = letters.get(id);
    if (!letter || !visibleFor(letter, acctKey)) {
      throw new Error('That letter is no longer available.');
    }
    if (letter.toAccount === acctKey) letter.deletedByRecipient = true;
    if (letter.fromAccount === acctKey) letter.deletedBySender = true;

    if (letter.deletedByRecipient && letter.deletedBySender) {
      letters.delete(id);
      writeWorld(`${MAIL_PREFIX}${id}`, null);
    } else {
      writeWorld(`${MAIL_PREFIX}${id}`, letter);
    }
    return { letterId: id, unreadCount: unreadCount(acctKey) };
  }

  function getLetterForReport(actorKey, letterId) {
    const letter = letters.get(String(letterId));
    if (!letter || !visibleFor(letter, actorKey)) {
      throw new Error('That letter cannot be attached as evidence.');
    }
    const otherAccount = letter.fromAccount === actorKey ? letter.toAccount : letter.fromAccount;
    return {
      type: 'letter',
      letterId: letter.id,
      threadId: letter.threadId,
      createdAt: letter.createdAt,
      fromAccount: letter.fromAccount,
      fromCharId: letter.fromCharId,
      fromLabel: letter.fromLabel,
      toAccount: letter.toAccount,
      otherAccount,
      otherCharId: letter.fromAccount === otherAccount ? letter.fromCharId : letter.toCharId,
      otherLabel: contacts.labelFor(otherAccount),
      subject: letter.subject.slice(0, MAX_SUBJECT_LEN),
      excerpt: letter.body.slice(0, 300),
    };
  }

  function summaryView(actor) {
    const acctKey = contacts.ensureProfile(actor).accountKey;
    const inbox = listLetters(actor, { folder: 'inbox', limit: MAIL_PAGE_DEFAULT });
    const sent = listLetters(actor, { folder: 'sent', limit: MAIL_PAGE_DEFAULT });
    return {
      unreadCount: unreadCount(acctKey),
      inbox: inbox.items,
      inboxTotal: inbox.total,
      inboxNextCursor: inbox.nextCursor,
      sent: sent.items,
      sentTotal: sent.total,
      sentNextCursor: sent.nextCursor,
    };
  }

  function onAccountDeleted(accountId) {
    const key = accountKeyOf(accountId);
    if (!key) return;
    for (const [id, l] of [...letters]) {
      let touched = false;
      if (l.fromAccount === key && !l.deletedBySender) {
        l.deletedBySender = true;
        touched = true;
      }
      if (l.toAccount === key && !l.deletedByRecipient) {
        l.deletedByRecipient = true;
        touched = true;
      }
      if (!touched) continue;
      if (l.deletedBySender && l.deletedByRecipient) {
        letters.delete(id);
        writeWorld(`${MAIL_PREFIX}${id}`, null);
      } else {
        writeWorld(`${MAIL_PREFIX}${id}`, l);
      }
    }
    mailBuckets.delete(key);
    for (const k of [...idempotency.keys()]) {
      if (k.startsWith(`${key}:`)) idempotency.delete(k);
    }
  }

  function capture() {
    return structuredClone({ letters, idempotency });
  }

  function restore(saved) {
    letters.clear();
    for (const [k, v] of saved.letters) letters.set(k, v);
    idempotency.clear();
    for (const [k, v] of saved.idempotency) idempotency.set(k, v);
  }

  return {
    letters,
    unreadCount,
    sendLetter,
    listLetters,
    getThread,
    markRead,
    deleteLetter,
    getLetterForReport,
    summaryView,
    projectLetter,
    onAccountDeleted,
    capture,
    restore,
  };
}
