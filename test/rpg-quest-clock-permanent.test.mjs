// Quest travel clocks (Daggerfall Unity Clock.GetTravelTimeInSeconds) and `make _item_ permanent` (Item.MakePermanent).
// The synthetic quest scripts below are written for these tests and are NOT Daggerfall quests. The "classic" checks
// read the operator's ARENA2 quest records (gamedata/) with a stub host and are skipped without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuest } from '../server/rpg/quests/script.js';
import { createInstance, updateQuest, travelClockMinutes, RETURN_TRIP_MULTIPLIER } from '../server/rpg/quests/engine.js';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { permanentQuestItem, deliverCampaignRewards } from '../server/rpg/campaign/rewards.js';
import { localArena2 } from './support/rpg-session.mjs';

const DAY = 1440;
const ARENA2 = localArena2();

/** SYNTHETIC: a travel clock (flag 17, as in the classic records) and the given places. */
function synthetic(places, clockLine = 'Clock _due_ 00:00 0 flag 17 range 0 2') {
  return parseQuest(`Quest: T0C00Y99
QRC:
QuestorOffer: [1000]
SYNTHETIC OFFER.
QBN:
${places.map(([k, how]) => `Place _${k}_ ${how}`).join('\n')}
${clockLine}

_due_ task:
  end quest
`);
}

/** Stub host: each place key's location has a fixed one-way leg; `null` means its site could not be bound. */
function stubHost(legs, sites = {}) {
  let n = 0;
  return {
    location: () => 'town:Here/Here',
    remoteTown: () => `town:R/${n++}`,
    remoteDungeon: () => null,
    localDungeon: () => null,
    makeName: () => 'Test',
    itemName: (r) => r.className,
    travelMinutes: (location) => legs[location] ?? 0,
    ...sites,
  };
}

test('travel clock: every place adds its own leg (one-day minimum each) and the sum takes 2.5 once', () => {
  assert.equal(RETURN_TRIP_MULTIPLIER, 2.5);
  const def = synthetic([['a', 'remote tavern'], ['b', 'remote temple'], ['c', 'local tavern']]);
  const host = stubHost({ 'town:R/0': 3000, 'town:R/1': 500 });
  const inst = createInstance(def, { uid: 'u1', seed: 1, giver: { id: 'g', name: 'G', location: 'town:Here/Here' }, host, now: 0 });
  // 3000 + max(1440, 500) + max(1440, 0 for the giver's own town) = 5880; × 2.5 = 14700.
  assert.equal(inst.clocks.due.total, Math.trunc((3000 + DAY + DAY) * 2.5));
});

test('travel clock: a single place keeps the classic first-place result', () => {
  const def = synthetic([['a', 'remote tavern']]);
  const inst = createInstance(def, { uid: 'u2', seed: 1, giver: null, host: stubHost({ 'town:R/0': 4321 }), now: 0 });
  assert.equal(inst.clocks.due.total, Math.trunc(4321 * 2.5));
  const near = createInstance(def, { uid: 'u3', seed: 1, giver: null, host: stubHost({ 'town:R/0': 90 }), now: 0 });
  assert.equal(near.clocks.due.total, DAY * 2.5, 'Clock.cs allows at least one day per place');
});

test('travel clock: an unbound site adds nothing (Clock.cs GetLocation failure); none bound falls back to three days', () => {
  const def = synthetic([['a', 'remote dungeon'], ['b', 'remote tavern']]);
  const inst = createInstance(def, { uid: 'u4', seed: 1, giver: null, host: stubHost({ 'town:R/0': 2000 }), now: 0 });
  assert.equal(inst.places.a.location, null, 'no dungeon could be chosen');
  assert.equal(inst.clocks.due.total, 2000 * 2.5);
  const none = synthetic([['a', 'remote dungeon']]);
  const lone = createInstance(none, { uid: 'u5', seed: 1, giver: null, host: stubHost({}), now: 0 });
  assert.equal(lone.clocks.due.total, 3 * DAY);
  // travelClockMinutes directly: missing places, non-numeric quotes.
  const places = [{ key: 'x' }, { key: 'y' }];
  assert.equal(travelClockMinutes(places, { places: { x: { location: 'town:a' }, y: {} } }, { travelMinutes: () => NaN }), DAY * 2.5);
});

test('travel clock: fixed durations and a pinned first-place clock are unchanged', () => {
  const fixed = synthetic([['a', 'remote tavern'], ['b', 'remote temple']], 'Clock _due_ 2.00:00');
  const inst = createInstance(fixed, { uid: 'u6', seed: 1, giver: null, host: stubHost({ 'town:R/0': 9999 }), now: 0 });
  assert.equal(inst.clocks.due.total, 2 * DAY);
  const pinned = synthetic([['a', 'remote tavern'], ['b', 'remote temple']]);
  pinned.resources.get('due').firstPlaceClock = true; // special/quests.js U0C00Y00 `_S.07_`
  const p = createInstance(pinned, { uid: 'u7', seed: 1, giver: null, host: stubHost({ 'town:R/0': 3000, 'town:R/1': 6000 }), now: 0 });
  assert.equal(p.clocks.due.total, 3000 * 2.5);
});

test('travel clock: a saved running clock keeps its duration and deadline', () => {
  const def = synthetic([['a', 'remote tavern'], ['b', 'remote temple']]);
  const host = { ...stubHost({ 'town:R/0': 3000, 'town:R/1': 3000 }), end: (i, r) => { i.status = r; } };
  const inst = createInstance(def, { uid: 'u8', seed: 1, giver: null, host, now: 0 });
  // A save from before this change: first place only, already started.
  const saved = JSON.parse(JSON.stringify(inst));
  saved.clocks.due = { total: 7500, endAt: 100 + 7500, running: true, done: false };
  updateQuest(def, saved, host, 200);
  assert.deepEqual(saved.clocks.due, { total: 7500, endAt: 7600, running: true, done: false });
  updateQuest(def, saved, host, 7600);
  assert.equal(saved.clocks.due.done, true, 'it fires at the saved deadline');
});

test('classic multi-place deadlines: K0C00Y02 (four remote places) and A0C10Y05 (two) sum every place', { skip: ARENA2 ? false : 'operator ARENA2 not present in gamedata/' }, (t) => {
  const cat = loadCatalog({ dataPath: ARENA2 });
  const rows = [];
  for (const [name, clock, legs] of [['K0C00Y02', 's.02', [2000, 500, 7000, 3000]], ['A0C10Y05', 's.00', [4000, 6000]], ['K0C00Y07', 's.00', [2600]]]) {
    const { def } = cat.quests.get(name);
    const places = [...def.resources.values()].filter((r) => r.kind === 'place');
    assert.equal(places.length, legs.length, `${name} places`);
    let n = 0;
    const byLocation = {};
    const host = {
      ...stubHost({}),
      remoteTown: () => { const id = `town:R/${n++}`; return id; },
      remoteDungeon: () => { const id = `town:D/${n++}`; return { location: id, interior: `dungeon:D/${n}` }; },
      individual: () => null,
      travelMinutes: (location) => byLocation[location] ?? 0,
      rewardGold: () => 100,
      itemTemplate: () => null,
    };
    const inst = createInstance(def, { uid: name, seed: 7, giver: { id: 'g', name: 'G', location: 'town:Here/Here', faction: 0 }, host: {
      ...host,
      // Each place's leg is assigned in declaration order as the place binds.
      remoteTown: () => { const id = host.remoteTown(); byLocation[id] = legs[Object.keys(byLocation).length]; return id; },
      remoteDungeon: () => { const d = host.remoteDungeon(); byLocation[d.location] = legs[Object.keys(byLocation).length]; return d; },
    }, now: 0 });
    const expected = Math.trunc(legs.reduce((s, m) => s + Math.max(DAY, m), 0) * 2.5);
    assert.equal(inst.clocks[clock].total, expected, `${name} ${clock}`);
    rows.push(`${name} ${clock}: legs ${legs.join('+')} -> ${inst.clocks[clock].total} min`);
  }
  t.diagnostic(rows.join('; '));
});

// ------------------------------------------------------------------ make permanent

/** Minimal installed-service doubles: an inventory with a pack limit, a dirty log and notifications. */
function fakeWorld({ limit = 10, owned = [] } = {}) {
  const players = new Map();
  const notes = [];
  const dirty = [];
  const mk = (id) => {
    const p = { id, rpg: { quests: { active: [] }, inventory: owned.map((t, i) => ({ id: `o${i}`, template: t, quantity: 1 })) } };
    players.set(id, p);
    return p;
  };
  let seq = 0;
  const ctx = {
    dirty: (p) => dirty.push(p.id),
    notify: (p, m) => notes.push({ to: p.id, ...m }),
    services: {
      giveItem(p, template, quantity, appearance) {
        if (p.rpg.inventory.length >= limit) throw new Error('Your pack cannot hold any more items.');
        const rec = { id: `n${seq++}`, template, quantity, ...(appearance?.extra ?? {}) };
        p.rpg.inventory.push(rec);
        return rec;
      },
      countItem: (p, t) => p.rpg.inventory.filter((i) => i.template === t).length,
    },
  };
  return { ctx, mk, notes, dirty, players };
}
const quest = (items) => ({ uid: 'K0C00Y07-1-x', title: 'Work for G', items, notes: [] });
const text = () => 'You may keep this.';

test('make permanent: a carried gem becomes its rolled inventory gem, once', () => {
  const w = fakeWorld({ owned: ['ruby'] });
  const a = w.mk('a');
  const b = w.mk('b');
  const q = quest({ 'i.00': { className: 'gem', template: 'ruby', held: true, name: 'gem' } });
  permanentQuestItem(w.ctx, a, q, 'i.00', text);
  assert.deepEqual(a.rpg.inventory.map((i) => i.template), ['ruby', 'ruby'], 'an ordinary gem is added even when one is owned');
  assert.equal(q.items['i.00'].held, false);
  assert.equal(q.items['i.00'].permanent, true);
  assert.deepEqual(a.rpg.quests.campaignRewards, {});
  assert.deepEqual(b.rpg.inventory.map((i) => i.template), ['ruby'], 'nobody else receives it');
  // The task re-running, a rejoin and the tick delivery do not repeat it.
  permanentQuestItem(w.ctx, a, q, 'i.00', text);
  deliverCampaignRewards(w.ctx, a);
  assert.equal(a.rpg.inventory.length, 2);
  assert.ok(w.dirty.includes('a') && !w.dirty.includes('b'));
});

test('make permanent: a full pack queues the gem until there is room, then delivers it once', () => {
  const w = fakeWorld({ limit: 1, owned: ['dagger'] });
  const a = w.mk('a');
  const q = quest({ 'i.00': { className: 'gem', template: 'amber', held: true } });
  permanentQuestItem(w.ctx, a, q, 'i.00', text);
  assert.equal(a.rpg.inventory.length, 1);
  assert.deepEqual(a.rpg.quests.campaignRewards, { 'K0C00Y07-1-x:i.00': { template: 'amber', ordinary: true } });
  assert.ok(w.notes.some((n) => n.to === 'a' && /room in your pack/.test(n.text)));
  // Saved and restored (JSON), then a rejoin with room.
  a.rpg = JSON.parse(JSON.stringify(a.rpg));
  a.rpg.inventory.length = 0;
  deliverCampaignRewards(w.ctx, a);
  deliverCampaignRewards(w.ctx, a);
  assert.deepEqual(a.rpg.inventory.map((i) => i.template), ['amber']);
  assert.deepEqual(a.rpg.quests.campaignRewards, {});
});

test('make permanent: handed-over and never-received stay out; template-less religious item converts cleanly', () => {
  const w = fakeWorld();
  const a = w.mk('a');
  const q = quest({
    gone: { className: 'gem', template: 'ruby', held: false, handedOver: true },
    never: { className: 'gem', template: 'ruby', held: false },
    beads: { className: 'religious', template: null, held: true, name: 'Prayer Beads' },
    missingArtifact: { className: 'artifact', template: null, held: true, name: 'Unknown Relic' },
  });
  for (const k of Object.keys(q.items)) permanentQuestItem(w.ctx, a, q, k, text);
  assert.deepEqual(a.rpg.inventory.map((i) => i.template), ['religious-item']);
  assert.equal(a.rpg.inventory[0].quest, undefined, 'an ordinary record, not a quest item');
  assert.equal(q.items.beads.held, false, 'converted out of journal into inventory');
  assert.equal(q.items.beads.permanent, true);
  assert.equal(q.items.missingArtifact.held, true, 'unresolved unique artifact stays in journal');
  assert.deepEqual(q.notes, ['make permanent: no inventory item for artifact']);
});

test('make permanent: artifacts are not duplicated and letters keep their text (unchanged behaviour)', () => {
  const w = fakeWorld({ owned: ['ring-of-namira'] });
  const a = w.mk('a');
  const q = quest({
    art: { className: 'artifact', template: 'ring-of-namira', held: true },
    note: { className: 'letter', usedMessage: 1015, held: true, name: 'letter' },
  });
  permanentQuestItem(w.ctx, a, q, 'art', text);
  permanentQuestItem(w.ctx, a, q, 'note', text);
  assert.deepEqual(a.rpg.inventory.map((i) => i.template), ['ring-of-namira', 'parchment']);
  assert.deepEqual(a.rpg.inventory[1].letter, { title: 'Work for G', lines: ['You may keep this.'] });
  // An artifact entry queued by an older save (no `ordinary` flag) still respects ownership.
  a.rpg.quests.campaignRewards = { old: { template: 'ring-of-namira' } };
  deliverCampaignRewards(w.ctx, a);
  assert.equal(a.rpg.inventory.length, 2);
});
