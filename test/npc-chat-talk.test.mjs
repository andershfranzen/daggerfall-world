import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NUMBERED, PASSAGE_CHARS, choiceIndexForCode, passages, questEventForTalk, replyChoices,
} from '../client/gameplay/npcs/conversation.js';

const base = {
  kind: 'dialogue', session: 's1', npc: { id: 'npc:t:1', name: 'Ada Quill', role: 'merchant' }, gold: 10,
  topics: [{ id: 'trade', label: 'Trade' }, { id: 'news', label: 'News' }], services: [], journal: false,
};

test('passages: classic line breaks join, blank lines split, long text is cut at sentences', () => {
  assert.deepEqual(passages('Hello there,\ntraveller.'), ['Hello there, traveller.']);
  assert.deepEqual(passages('One.\n\nTwo.'), ['One.\n\nTwo.'], 'short paragraphs share a passage');
  const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const out = passages(long);
  assert.ok(out.length > 1);
  assert.ok(out.every((p) => p.length <= PASSAGE_CHARS));
  assert.equal(out.join(' ').replace(/\s+/g, ' '), long);
  assert.deepEqual(passages(''), []);
  assert.ok(passages('x'.repeat(900)).every((p) => p.length <= PASSAGE_CHARS));
});

test('replies: topics, trade page, numbering and Goodbye last', () => {
  const c = replyChoices(base);
  assert.deepEqual(c.map((x) => x.id), ['topic-trade', 'topic-news', 'leave']);
  assert.equal(c[0].openPanel, true, 'trade without a shop view asks the server, then opens the page');
  assert.deepEqual(c.map((x) => x.key), [1, 2, 3]);
  const shop = replyChoices({ ...base, shop: { items: [] } });
  assert.equal(shop[0].kind, 'panel');
  assert.equal(shop[0].panel, 'dialogue');
});

test('replies: services, training and repairs open pages; heal shows its cost', () => {
  const v = {
    ...base, npc: { ...base.npc, role: 'priest' }, topics: [],
    services: [{ id: 'heal', label: 'Healing', cost: 12 }, { id: 'train', label: 'Training' }],
    guild: { training: [{ skill: 'Restoration' }] }, journal: true,
  };
  const c = replyChoices(v, { canJournal: true, canRepair: true });
  assert.deepEqual(c.map((x) => x.label), ['Healing (12 gold)', 'Training…', 'Repairs…', 'Review journal…', 'Goodbye.']);
  assert.equal(c[1].panel, 'dialogue');
  assert.equal(c[2].panel, 'townServices');
  assert.equal(c[3].panel, 'journal');
  assert.equal(replyChoices({ ...v, guild: { training: [] } }).some((x) => x.id === 'train'), false);
});

test('replies: continue, offers and prompts replace topics', () => {
  assert.deepEqual(replyChoices(base, { more: true }).map((x) => x.id), ['continue', 'leave']);
  const o = replyChoices(base, { offer: { id: 'q-1' } });
  assert.deepEqual(o.map((x) => [x.verb, x.args]), [['quest.accept', { offerId: 'q-1' }], ['quest.refuse', { offerId: 'q-1' }], [undefined, undefined]]);
  const p = replyChoices(base, { prompt: { uid: 'u1' } });
  assert.deepEqual(p.slice(0, 2).map((x) => x.args), [{ uid: 'u1', yes: true }, { uid: 'u1', yes: false }]);
  assert.deepEqual(replyChoices(null), []);
});

test('cure replies display and carry the temple quote, including zero', () => {
  for (const [cost, label] of [[125, 'Cure disease (125 gold)'], [0, 'Cure disease (free)']]) {
    const [reply] = replyChoices({ ...base, topics: [], services: [{ id: 'cure', label: 'Cure disease', cost }] });
    assert.equal(reply.label, label);
    assert.deepEqual(reply.args, { cost });
  }
  const [reply] = replyChoices({ ...base, topics: [], services: [{ id: 'cure', label: 'Cure disease' }] });
  assert.equal(reply.label, 'Cure disease');
  assert.equal(reply.args, undefined);
});

test('number keys map to numbered replies only', () => {
  const many = { ...base, topics: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, label: `T${i}` })) };
  const c = replyChoices(many);
  assert.equal(c.filter((x) => x.key).length, MAX_NUMBERED);
  assert.equal(c.at(-1).key, null, 'Goodbye past 9 is still clickable and Esc ends it');
  assert.equal(choiceIndexForCode('Digit1', c), 0);
  assert.equal(choiceIndexForCode('Numpad9', c), 8);
  assert.equal(choiceIndexForCode('Digit0', c), -1);
  assert.equal(choiceIndexForCode('KeyG', c), -1);
});

test('quest events belong to the conversation only when they come from it', () => {
  const talk = { view: base, offerAnswered: false, lastSpokeAt: 1000 };
  assert.equal(questEventForTalk(talk, { kind: 'questOffer', giver: { id: 'npc:t:1' } }), true);
  assert.equal(questEventForTalk(talk, { kind: 'questOffer', giver: { id: 'npc:other' } }), false);
  assert.equal(questEventForTalk(talk, { kind: 'questAccepted' }), false);
  assert.equal(questEventForTalk({ ...talk, offerAnswered: true }, { kind: 'questAccepted' }), true);
  assert.equal(questEventForTalk(talk, { kind: 'questMessage' }, 2000), true);
  assert.equal(questEventForTalk(talk, { kind: 'questMessage' }, 9000), false, 'later quest news goes to the journal');
  assert.equal(questEventForTalk({ view: null }, { kind: 'questOffer', giver: { id: 'npc:t:1' } }), false);
  assert.equal(questEventForTalk(talk, { kind: 'questLog' }, 1100), false);
});

test('bank and repair services get readable labels and continue on Bank & Repairs', () => {
  const v = { ...base, topics: [], services: [{ id: 'bank', label: 'bank' }, { id: 'repair', label: 'repair' }, { id: 'rest', label: 'rest' }] };
  const c = replyChoices(v, { canRepair: true });
  assert.deepEqual(c.map((x) => x.label), ['Banking…', 'Repairs…', 'Room & board…', 'Goodbye.']);
  assert.deepEqual(c.slice(0, 2).map((x) => [x.kind, x.service, x.panel]), [['service', 'bank', 'townServices'], ['service', 'repair', 'townServices']]);
  assert.equal(c[2].panel, 'dialogue');
});
