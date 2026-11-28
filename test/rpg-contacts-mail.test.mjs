// Persistent account-scoped friends, directed blocks, privacy toggles, moderation reports,
// and account mailbox letters across server restarts, character switches, and third-account isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/db.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as social from '../server/rpg/social.js';

const flush = () => new Promise((r) => setImmediate(r));

function makeWorld({ store = openStore(':memory:'), muted = new Set(), clockStart = 1_700_000_000_000 } = {}) {
  let clock = clockStart;
  const players = new Map();
  const sent = new Map();
  const logLines = [];
  let failNextSave = false;

  const log = {
    info: (m) => logLines.push(String(m)),
    warn: (m) => logLines.push(String(m)),
    error: (m) => logLines.push(String(m)),
  };

  const rt = createRpgRuntime({
    players,
    features: [inventory, social],
    log,
    now: () => clock,
    worldStore: { load: (prefix) => store.loadWorld(prefix) },
    services: { isMuted: (p) => muted.has(p.id) },
    save(list, world = []) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated db failure');
      }
      const resolved = world.map(([k, v]) => [k, typeof v === 'function' ? v() : v]);
      store.saveCharacters(list, resolved);
    },
    send(p, msg) {
      (sent.get(p.id) ?? sent.set(p.id, []).get(p.id)).push(msg);
    },
  });

  function join(id, name, { accountId, username = name, rpg = {}, x = 0, z = 0 } = {}) {
    // Ensure a backing row in SQLite so saveCharacters succeeds cleanly.
    const exists = store.db.prepare('SELECT id FROM players WHERE id = ?').get(id);
    if (!exists) {
      store.db.prepare(
        'INSERT INTO players (id, token_hash, name, x, z, yaw, created_at, last_seen, rpg) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
      ).run(id, `tok_${id}_${Math.random()}`, name, x, z, clock, clock, JSON.stringify(rpg));
    }
    const p = {
      id,
      name,
      accountId,
      account: accountId != null ? { id: accountId, username } : null,
      x,
      z,
      yaw: 0,
      moving: false,
      rpg: structuredClone(rpg),
    };
    players.set(id, p);
    rt.join(p);
    // Flush join world_state writes just like game.js periodic persist().
    const pendingWorld = rt.takePendingWorld?.() ?? [];
    if (pendingWorld.length) store.saveCharacters([], pendingWorld);
    return p;
  }

  function leave(p) {
    rt.leave(p);
    players.delete(p.id);
    const pendingWorld = rt.takePendingWorld?.() ?? [];
    if (pendingWorld.length) store.saveCharacters([], pendingWorld);
  }

  const act = (p, verb, args = {}) => rt.act(p, verb, args);
  const ok = (p, verb, args = {}) => {
    const r = act(p, verb, args);
    assert.equal(r.error, undefined, `${verb} failed: ${r.error}`);
    return r;
  };
  const eventsOf = (p) => (sent.get(p.id) ?? []).filter((m) => m.type === 'gameEvent').map((m) => m.event);
  const socialOf = (p) => eventsOf(p).filter((e) => e.social).at(-1)?.social;
  const advance = (ms) => { clock += ms; };
  const failSave = () => { failNextSave = true; };

  return { store, rt, players, join, leave, act, ok, eventsOf, socialOf, advance, failSave, logLines };
}

test('two accounts friend, switch characters, send offline letter, restart, and read once', () => {
  const store = openStore(':memory:');
  const w1 = makeWorld({ store });

  const adaSlot1 = w1.join(101, 'AdaBlade', { accountId: 'acct-ada', username: 'Ada' });
  const bramSlot1 = w1.join(201, 'BramShield', { accountId: 'acct-bram', username: 'Bram' });

  // Send friend request by exact character name; accept.
  w1.ok(adaSlot1, 'friends.request', { name: 'bramshield' });
  assert.equal(w1.socialOf(bramSlot1).contacts.incoming.length, 1);
  assert.equal(w1.socialOf(bramSlot1).contacts.incoming[0].publicLabel, 'Ada');
  w1.ok(bramSlot1, 'friends.accept', { accountKey: w1.socialOf(bramSlot1).contacts.incoming[0].accountKey });
  assert.equal(w1.rt.ctx.services.areFriends(adaSlot1, bramSlot1), true);

  // Switch Ada to Slot 2 character: friendship persists and duplicate requests across slots are rejected.
  w1.leave(adaSlot1);
  const adaSlot2 = w1.join(102, 'AdaMage', { accountId: 'acct-ada', username: 'Ada' });
  assert.equal(w1.rt.ctx.services.areFriends(adaSlot2, bramSlot1), true);
  assert.match(w1.act(adaSlot2, 'friends.request', { targetId: bramSlot1.id }).error, /already friends/);

  // Bram goes offline; Ada (on Slot 2) sends an offline plain-text letter.
  w1.leave(bramSlot1);
  w1.advance(5_000);
  const bramKey = w1.socialOf(adaSlot2).contacts.friends[0].accountKey;
  w1.ok(adaSlot2, 'mail.send', {
    toAccount: bramKey,
    subject: 'Meet at Wayrest',
    body: 'Bring potions.\nMeet by the north gate.',
    requestId: 'req-offline-1',
  });
  // Idempotent retry with same requestId returns success without creating a duplicate letter.
  w1.ok(adaSlot2, 'mail.send', {
    toAccount: bramKey,
    subject: 'Meet at Wayrest',
    body: 'Bring potions.\nMeet by the north gate.',
    requestId: 'req-offline-1',
  });
  // Reusing the same requestId with different params is refused.
  assert.match(
    w1.act(adaSlot2, 'mail.send', { toAccount: bramKey, subject: 'Other', body: 'Changed body', requestId: 'req-offline-1' }).error,
    /different letter/,
  );

  // Full server restart against the same persisted SQLite store!
  const w2 = makeWorld({ store, clockStart: 1_700_000_050_000 });
  // Bram logs in on a SECOND character slot (Slot 2) on a second device.
  const bramSlot2 = w2.join(202, 'BramScout', { accountId: 'acct-bram', username: 'Bram' });
  const mail = w2.socialOf(bramSlot2).mail;
  assert.equal(mail.unreadCount, 1, 'exactly one offline letter delivered across restart');
  assert.equal(mail.inbox.length, 1);
  assert.equal(mail.inbox[0].subject, 'Meet at Wayrest');
  assert.equal(mail.inbox[0].fromLabel, 'Ada');
  assert.equal(mail.inbox[0].fromCharName, 'AdaMage');
  assert.equal(mail.inbox[0].body, 'Bring potions.\nMeet by the north gate.');

  // Read once; repeated/concurrent read stays idempotent and keeps unreadCount at 0.
  const letterId = mail.inbox[0].id;
  w2.ok(bramSlot2, 'mail.read', { letterId });
  assert.equal(w2.socialOf(bramSlot2).mail.unreadCount, 0);
  const readAt1 = w2.socialOf(bramSlot2).mail.inbox[0].readAt;
  w2.advance(10_000);
  w2.ok(bramSlot2, 'mail.read', { letterId });
  assert.equal(w2.socialOf(bramSlot2).mail.inbox[0].readAt, readAt1, 'readAt is immutable on duplicate read');
  assert.equal(w2.socialOf(bramSlot2).mail.unreadCount, 0);

  // Reply threading & per-viewer delete.
  w2.ok(bramSlot2, 'mail.send', { replyToId: letterId, body: 'On my way from Sentinel!' });
  w2.ok(bramSlot2, 'mail.thread', { threadId: mail.inbox[0].threadId });
  const threadEv = w2.eventsOf(bramSlot2).filter((e) => e.mailThread).at(-1).mailThread;
  assert.equal(threadEv.messages.length, 2);
  assert.equal(threadEv.messages[1].subject, 'Re: Meet at Wayrest');

  // Delete root letter from Bram's view -> Ada still sees it in Sent!
  w2.ok(bramSlot2, 'mail.delete', { letterId });
  assert.equal(w2.socialOf(bramSlot2).mail.inbox.length, 0);
  const adaBack = w2.join(101, 'AdaBlade', { accountId: 'acct-ada', username: 'Ada' });
  assert.equal(w2.socialOf(adaBack).mail.sent.length, 1, 'sender still keeps their sent copy');
  assert.equal(w2.socialOf(adaBack).mail.unreadCount, 1, 'Ada sees Bram reply as unread');
  store.close();
});

test('crossed friend requests deduplicate across character slots into one accepted friendship', () => {
  const w = makeWorld();
  const a1 = w.join(1, 'AdaOne', { accountId: 'acct-a', username: 'Ada' });
  const b1 = w.join(2, 'BramOne', { accountId: 'acct-b', username: 'Bram' });

  w.ok(a1, 'friends.request', { targetId: b1.id });
  assert.equal(w.socialOf(a1).contacts.outgoing.length, 1);
  assert.equal(w.socialOf(b1).contacts.incoming.length, 1);

  // Bram switches to Slot 2 and sends a crossed request to Ada by name.
  w.leave(b1);
  const b2 = w.join(22, 'BramTwo', { accountId: 'acct-b', username: 'Bram' });
  w.ok(b2, 'friends.request', { name: 'AdaOne' });

  // Both are now accepted friends with zero pending requests.
  assert.equal(w.rt.ctx.services.areFriends(a1, b2), true);
  assert.equal(w.socialOf(a1).contacts.friends.length, 1);
  assert.equal(w.socialOf(a1).contacts.outgoing.length, 0);
  assert.equal(w.socialOf(b2).contacts.friends.length, 1);
  assert.equal(w.socialOf(b2).contacts.incoming.length, 0);
  w.store.close();
});

test('directed blocks take immediate effect across all interactions without leaking block status', () => {
  const w = makeWorld();
  const a = w.join(1, 'Ada', { accountId: 'acct-a', username: 'Ada' });
  const b = w.join(2, 'Bram', { accountId: 'acct-b', username: 'Bram' });
  const c = w.join(3, 'Cyra', { accountId: 'acct-c', username: 'Cyra' });

  // Make Ada & Bram friends, open a trade, and send a party invite from Ada to Bram.
  w.ok(a, 'friends.request', { targetId: b.id });
  w.ok(b, 'friends.accept', { targetId: a.id });
  w.ok(a, 'trade.request', { targetId: b.id });
  w.ok(a, 'party.invite', { targetId: b.id });
  assert.ok(w.socialOf(b).trade);
  assert.equal(w.socialOf(b).invites.length, 1);

  // Also have Cyra disable friend requests via privacy toggle so we can verify identical non-leaking errors.
  w.ok(c, 'friends.settings', { allowRequests: 'none', allowLetters: false });

  // Bram blocks Ada -> immediately severs friendship, cancels trade & party invite!
  w.ok(b, 'social.block', { targetId: a.id });
  assert.equal(w.rt.ctx.services.isDirectedBlocked(b, a), true);
  assert.equal(w.rt.ctx.services.isDirectedBlocked(a, b), false);
  assert.equal(w.rt.ctx.services.isBlocked(a, b), true);
  assert.equal(w.rt.ctx.services.areFriends(a, b), false);
  assert.equal(w.socialOf(a).trade, null);
  assert.equal(w.socialOf(b).invites.length, 0);

  // Every interaction from blocked Ada to Bram is refused WITHOUT mentioning block!
  const friendErrBlocked = w.act(a, 'friends.request', { targetId: b.id }).error;
  const friendErrPrivacy = w.act(a, 'friends.request', { targetId: c.id }).error;
  assert.equal(friendErrBlocked, friendErrPrivacy, 'blocked error matches privacy-off error so block status is never leaked');
  assert.doesNotMatch(friendErrBlocked, /block|ignor/i);

  const mailErr = w.act(a, 'mail.send', { targetId: b.id, body: 'Hello?' }).error;
  assert.ok(mailErr);
  assert.doesNotMatch(mailErr, /block|ignor/i);

  const whisperErr = w.act(a, 'chat.send', { channel: 'whisper', target: 'Bram', text: 'psst' }).error;
  assert.ok(whisperErr);
  assert.doesNotMatch(whisperErr, /block|ignor/i);

  const tradeErr = w.act(a, 'trade.request', { targetId: b.id }).error;
  assert.ok(tradeErr);
  assert.doesNotMatch(tradeErr, /block|ignor/i);

  const partyErr = w.act(a, 'party.invite', { targetId: b.id }).error;
  assert.ok(partyErr);
  assert.doesNotMatch(partyErr, /block|ignor/i);

  // Wave 2 hooks for visits & duels also enforce blocks without leaking block status.
  const visitCheck = w.rt.ctx.services.canInteract(a, b, 'visit');
  assert.equal(visitCheck.ok, false);
  assert.doesNotMatch(visitCheck.reason, /block|ignor/i);

  const duelCheck = w.rt.ctx.services.canInteract(a, b, 'duel');
  assert.equal(duelCheck.ok, false);
  assert.doesNotMatch(duelCheck.reason, /block|ignor/i);

  // Ada's players list must NOT reveal that Bram blocked Ada.
  const bramEntryForAda = w.socialOf(a).players.find((x) => x.id === b.id);
  assert.equal(bramEntryForAda.blockedByMe, false);

  // Unblocking restores normal interactions.
  w.ok(b, 'social.unblock', { targetId: a.id });
  assert.equal(w.rt.ctx.services.isBlocked(a, b), false);
  w.ok(a, 'friends.request', { targetId: b.id });
  w.store.close();
});

test('privacy toggles, cursor pagination, third-account isolation, reports, and account deletion', async () => {
  const w = makeWorld();
  const a = w.join(1, 'Ada', { accountId: 'acct-a', username: 'Ada' });
  const b = w.join(2, 'Bram', { accountId: 'acct-b', username: 'Bram' });
  const c = w.join(3, 'Cyra', { accountId: 'acct-c', username: 'Cyra' });

  w.ok(a, 'friends.request', { targetId: b.id });
  w.ok(b, 'friends.accept', { targetId: a.id });

  // Privacy: Bram hides online presence & last-active time.
  w.ok(b, 'friends.settings', { showPresence: 'hidden', showLastActive: false, publicLabel: 'Sir Bram' });
  const bramForAda = w.socialOf(a).contacts.friends[0];
  assert.equal(bramForAda.publicLabel, 'Sir Bram');
  assert.equal(bramForAda.online, false);
  assert.equal(bramForAda.presenceHidden, true);
  assert.equal(bramForAda.characterName, null);
  assert.equal(bramForAda.region, null);
  assert.equal(bramForAda.lastActiveAt, null);

  // Send 4 letters from Ada to Bram and verify cursor pagination (limit 2).
  for (let i = 1; i <= 4; i++) {
    w.advance(10_000);
    w.ok(a, 'mail.send', { targetId: b.id, subject: `Letter ${i}`, body: `Body number ${i} secret-payload-${i}` });
  }
  w.ok(b, 'mail.list', { folder: 'inbox', limit: 2 });
  const page1 = w.eventsOf(b).filter((e) => e.mailPage).at(-1).mailPage;
  assert.equal(page1.items.length, 2);
  assert.equal(page1.items[0].subject, 'Letter 4');
  assert.equal(page1.items[1].subject, 'Letter 3');
  assert.ok(page1.nextCursor);

  w.ok(b, 'mail.list', { folder: 'inbox', limit: 2, cursor: page1.nextCursor });
  const page2 = w.eventsOf(b).filter((e) => e.mailPage).at(-1).mailPage;
  assert.equal(page2.items.length, 2);
  assert.equal(page2.items[0].subject, 'Letter 2');
  assert.equal(page2.items[1].subject, 'Letter 1');
  assert.equal(page2.nextCursor, null);

  // Third-account isolation: Cyra sees zero contacts and zero letters, and cannot read/delete/report A/B's letters!
  assert.equal(w.socialOf(c).contacts.friends.length, 0);
  assert.equal(w.socialOf(c).mail.inbox.length, 0);
  const letterId = page1.items[0].id;
  const threadId = page1.items[0].threadId;
  assert.match(w.act(c, 'mail.thread', { threadId }).error, /not available/);
  assert.match(w.act(c, 'mail.read', { letterId }).error, /not in your inbox/);
  assert.match(w.act(c, 'mail.delete', { letterId }).error, /no longer available/);
  assert.match(w.act(c, 'social.report', { category: 'spam', reason: 'Trying to snoop', evidenceType: 'letter', evidenceId: letterId }).error, /cannot be attached/);

  // Valid moderation report by Bram with selected letter evidence keeps letter body out of routine logs.
  w.logLines.length = 0;
  w.ok(b, 'social.report', { category: 'spam', reason: 'Repeated unsolicited messages', evidenceType: 'letter', evidenceId: letterId });
  const reports = w.rt.ctx.services.socialContacts.listReports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].evidenceSnapshot.letterId, letterId);
  assert.match(reports[0].evidenceSnapshot.excerpt, /secret-payload-4/);
  assert.ok(!w.logLines.some((line) => line.includes('secret-payload-4')), 'routine logs must not include letter contents');

  // Save failure during mail.send rolls back letter and never delivers it.
  w.advance(10_000);
  w.failSave();
  assert.match(w.act(a, 'mail.send', { targetId: b.id, subject: 'Unsaved', body: 'Should roll back' }).error, /could not save/);
  await flush();
  assert.equal(w.socialOf(b).mail.inboxTotal, 4, 'rolled-back letter never entered mailbox');

  // Character archive prevents resurfacing hidden/archived character in exact-name lookups.
  w.rt.ctx.services.socialContacts.onCharacterArchived('acct-c', c.id);
  w.leave(c);
  assert.match(w.act(a, 'friends.request', { name: 'Cyra' }).error, /No traveller named/);

  // Account deletion clears friendships, blocks, and mailbox views cleanly.
  w.rt.ctx.services.socialContacts.onAccountDeleted('acct-b');
  assert.equal(w.rt.ctx.services.areFriends(a, b), false);
  assert.equal(w.socialOf(a).contacts.friends.length, 0);
  w.store.close();
});
