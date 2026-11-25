// DOM-free helpers behind the Party & Trade panel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelCommand, tradeableItems, draftFrom, draftToArgs, draftMatches, describeOffer } from '../client/gameplay/social/model.js';

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
