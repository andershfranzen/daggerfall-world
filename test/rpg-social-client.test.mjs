// DOM-free helpers behind the Party & Trade panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelCommand,
  tradeableItems,
  draftFrom,
  draftToArgs,
  draftMatches,
  describeOffer,
  describeFriendPresence,
  describeMemberLocation,
  resetPrivateUiState,
} from '../client/gameplay/social/model.js';

test('channel prefixes route chat; other text stays location chat', () => {
  assert.deepEqual(parseChannelCommand('/p  regroup at the gate'), { channel: 'party', text: 'regroup at the gate' });
  assert.deepEqual(parseChannelCommand('/R hi'), { channel: 'region', text: 'hi' });
  assert.deepEqual(parseChannelCommand('/global'), { channel: 'global', text: '' });
  assert.equal(parseChannelCommand('/shrug'), null);
  assert.equal(parseChannelCommand('hello /p'), null);
});

test('only unequipped, tradeable items are offered', () => {
  const ch = {
    equipment: { rightHand: 'w1' },
    inventory: [
      { id: 'w1', template: 'iron-longsword', name: 'Sword', quantity: 1, equipped: 'rightHand' },
      { id: 'p1', template: 'potion-of-healing', name: 'Potion', quantity: 3 },
      { id: 'q1', template: 'letter', name: 'Letter', quantity: 1, quest: 'q' },
    ],
  };
  assert.deepEqual(tradeableItems(ch).map((i) => i.id), ['p1']);
});

test('drafts clamp, drop empty lines and detect stale server state', () => {
  const ch = { gold: 50, inventory: [{ id: 'p1', name: 'Potion', quantity: 3 }] };
  const d = draftFrom({ items: [{ id: 'p1', quantity: 2 }], gold: 5 });
  assert.ok(draftMatches(d, { items: [{ id: 'p1', quantity: 2 }], gold: 5 }, ch));
  d.items.set('p1', 9);
  d.items.set('gone', 1);
  assert.deepEqual(draftToArgs(d, ch), { items: [{ id: 'p1', quantity: 3 }], gold: 5 });
  assert.ok(!draftMatches(d, { items: [{ id: 'p1', quantity: 2 }], gold: 5 }, ch));
  d.items.set('p1', 0);
  assert.deepEqual(draftToArgs(d, ch).items, []);
  assert.equal(describeOffer({ items: [{ name: 'Potion', quantity: 2 }], gold: 5 }), 'Potion ×2, 5 gold');
  assert.equal(describeOffer({ items: [], gold: 0 }), 'Nothing yet');
});

test('friend presence, party location descriptors, and private cache clearing respect privacy', () => {
  assert.equal(describeFriendPresence({ publicLabel: 'Ada', presenceHidden: true, online: false }), 'Status hidden');
  assert.equal(
    describeFriendPresence({ publicLabel: 'Ada', online: true, characterName: 'AdaMage', region: 'Wayrest' }),
    'Online · as AdaMage · in Wayrest',
  );
  assert.equal(
    describeMemberLocation({ online: true, locationSharing: { shared: false } }),
    'Location hidden',
  );
  assert.equal(
    describeMemberLocation({ online: true, locationSharing: { shared: true, restricted: true, region: 'Daggerfall' } }),
    'Daggerfall · Restricted area',
  );
  assert.equal(
    describeMemberLocation({
      online: true,
      locationSharing: { shared: true, restricted: false, mode: 'exact', region: 'Daggerfall', landmark: 'Gothway Garden', exact: { x: 12.4, z: -8.6 } },
    }),
    'Gothway Garden, Daggerfall · Pin (12, -9)',
  );

  const ui = {
    social: { contacts: { friends: [1] } },
    selectedId: 5,
    draft: { gold: 10 },
    recentChat: ['hi'],
    friendsExtra: [1],
    friendsNextCursor: 'abc',
    mailExtra: { inbox: [1], sent: [2] },
    mailNextCursor: { inbox: 'x', sent: 'y' },
    activeThread: { threadId: 't1' },
    mailReply: 'draft',
    composeMail: { body: 'secret' },
    travelQuote: { to: 'town:Wayrest/Wayrest' },
    reportDraft: { reason: 'x' },
    status: 'ok',
  };
  resetPrivateUiState(ui);
  assert.equal(ui.social, null);
  assert.equal(ui.activeThread, null);
  assert.equal(ui.composeMail, null);
  assert.equal(ui.recentChat.length, 0);
  assert.equal(ui.friendsExtra.length, 0);
  assert.deepEqual(ui.mailExtra, { inbox: [], sent: [] });
});
