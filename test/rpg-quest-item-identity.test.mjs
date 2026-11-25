// Quest item identity (package 17): Daggerfall Unity Questing/Item.cs CreateItem maps each QBN item class to a real
// inventory item, rolled once. The synthetic script below is written for these tests and is NOT a Daggerfall quest.
// The "classic" checks read the operator's ARENA2 quest records (gamedata/) and are skipped without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInventory, classicGroupTemplates, describeTemplate } from '../server/rpg/inventory.js';
import { install as installQuests, reviseSavedQuestItem } from '../server/rpg/quests.js';
import { parseQuest } from '../server/rpg/quests/script.js';
import { analyseQuest } from '../server/rpg/quests/engine.js';
import { loadCatalog, metaFromName } from '../server/rpg/quests/catalog.js';
import { questItemIdentity } from '../server/rpg/quests/itemIdentity.js';
import { localArena2 } from './support/rpg-session.mjs';

const ARENA2 = localArena2();
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };
const inGroup = (group, template) => classicGroupTemplates(group).includes(template);

test('class mapping follows Item.CreateItem: junk is a container, never a random potion', () => {
  for (let r = 0; r < 1; r += 0.05) {
    const junk = questItemIdentity({ group: 1, index: -1 }, () => r);
    assert.ok(inGroup('UselessItems1', junk.template), `junk at ${r} -> ${junk.template}`);
    assert.doesNotMatch(junk.template, /^potion-of-/);
  }
  // O0B60Y18's parcel: UselessItems1 #16 of 11. DFU builds an empty template ("Item index out of range").
  assert.equal(questItemIdentity({ group: 1, index: 16 }, () => 0), null);
  // Only the potion subclass (1/1) is a potion: CreateRandomPotion.
  assert.deepEqual(questItemIdentity({ group: 1, index: 1 }, () => 0, { potion: () => ({ template: 'classic-potion-x' }) }), { template: 'classic-potion-x' });
  assert.match(questItemIdentity({ group: 1, index: 1 }, () => 0).template, /^potion-of-/, 'falls back to an installed potion');
});

test('religious items, trinkets, drugs, ingredients and specials resolve to installed templates', () => {
  const cases = [
    [{ group: 10, index: -1 }, 'ReligiousItems'], [{ group: 25, index: -1 }, 'Jewellery'], [{ group: 0, index: -1 }, 'Drugs'],
    [{ group: 17, index: -1 }, 'CreatureIngredients1'], [{ group: 15, index: -1 }, 'PlantIngredients1'],
    [{ group: 21, index: -1 }, 'MetalIngredients'], [{ group: 26, index: 5 }, 'QuestItems'], [{ group: 9, index: 4 }, 'UselessItems2'],
  ];
  for (const r of [0, 0.5, 0.999]) {
    for (const [cls, group] of cases) {
      const id = questItemIdentity(cls, () => r);
      assert.ok(id && inGroup(group, id.template), `${JSON.stringify(cls)} -> ${id?.template}`);
      assert.doesNotThrow(() => describeTemplate(id.template));
    }
  }
  // A fixed subclass is that enum member: Gems #3 is Diamond, MiscellaneousIngredients2 #0 Ivory, Jewellery #2 Ring.
  assert.equal(questItemIdentity({ group: 14, index: 3 }, () => 0).template, 'diamond');
  assert.equal(describeTemplate(questItemIdentity({ group: 22, index: 0 }, () => 0).template).name, 'Ivory');
  assert.equal(describeTemplate(questItemIdentity({ group: 25, index: 2 }, () => 0).template).name, 'Ring');
  // A random gem is one of the eight Gems members, never a pearl (MiscellaneousIngredients2).
  for (let r = 0; r < 1; r += 0.1) assert.ok(inGroup('Gems', questItemIdentity({ group: 14, index: -1 }, () => r).template));
  assert.equal(questItemIdentity({ group: 9, index: 5 }, () => 0), null, 'letters stay quest parchment');
});

test('magic items pass the QBN subclass to CreateRegularMagicItem; books roll an installed book', () => {
  const calls = [];
  const magicItem = (rand, chosen) => { calls.push(chosen); return { template: 'iron-dagger', extra: { magic: { defIndex: chosen ?? 9, enchantments: [] } } }; };
  assert.deepEqual(questItemIdentity({ group: 4, index: 3 }, () => 0, { magicItem }), { template: 'iron-dagger', appearance: { extra: { magic: { defIndex: 3, enchantments: [] } } } });
  questItemIdentity({ group: 4, index: -1 }, () => 0, { magicItem });
  assert.deepEqual(calls, [3, null]);
  assert.equal(questItemIdentity({ group: 4, index: -1 }, () => 0), null, 'no magic service: no fabricated item');
  const books = { randomId: () => 42 };
  assert.deepEqual(questItemIdentity({ group: 7, index: 2 }, seq(0.9), { books }), { template: 'book', appearance: { variant: 1, extra: { bookId: 42 } } });
});

// ------------------------------------------------------------------ on the server: rolled once, kept

/** SYNTHETIC quest: carried keepsakes, an immediate magic reward and a timer that ends the quest. */
const KEEPSAKES = `
Quest: T0C00Y77
DisplayName: Synthetic keepsakes

QRC:

QuestorOffer:  [1000]
TEST OFFER.

AcceptQuest:  [1002]
TEST ACCEPTED.

QBN:
Item _beads_ religious
Item _charm_ trinket
Item _herb_ drug
Item _scrap_ junk
Item _wand_ magic_item
Item _tome_ book

Person _giver_ group Questor

Clock _late_ 1.00:00

	get item _beads_
	get item _charm_
	get item _herb_
	get item _scrap_
	make _beads_ permanent
	give pc _wand_ silently
	start timer _late_

_late_ task:
	make _charm_ permanent
	end quest
`;

function world() {
  let clock = 0;
  const players = new Map();
  const def = parseQuest(KEEPSAKES);
  const catalog = { quests: new Map([[def.name, { name: def.name, source: 'script', def, meta: { ...metaFromName(def.name), group: 'Commoners', membership: 'N', minReq: 0 }, analysis: analyseQuest(def) }]]), failures: [], listSource: 'test' };
  let magicRolls = 0;
  const rt = createRpgRuntime({
    players,
    features: [
      installInventory,
      (ctx) => {
        ctx.onAction('npc.topic', (p, { targetId }) => ctx.emit('npcWork', { player: p, entity: ctx.entities.get(targetId) }));
        ctx.services.randomMagicItem = (rand, level, chosen) => {
          magicRolls++;
          return { template: 'iron-dagger', extra: { magic: { enchantments: [], identified: false, name: `Dagger of Roll ${Math.floor(rand() * 1000)}`, defIndex: chosen ?? 0 } } };
        };
        ctx.services.books = { randomId: () => 7 };
      },
      (ctx) => installQuests(ctx, { catalog }),
    ],
    save() {}, send() {}, now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const giver = { id: 'npc:test:0', kind: 'npc', role: 'crier', title: 'Town Crier', name: 'Anna Giver', location: 'town:Daggerfall/Gothway Garden', x: 0, z: -3, yaw: 0, questGiver: true, faction: 201 };
  rt.entities.set(giver.id, giver);
  return { rt, players, giver, magicRolls: () => magicRolls, advance: (ms) => { clock += ms; for (let i = 0; i < 3; i++) rt.tick(1); } };
}

const identity = (inst) => Object.fromEntries(Object.entries(inst.items).map(([k, it]) => [k, { template: it.template, appearance: it.appearance ?? null }]));
const pack = (p) => p.rpg.inventory.filter((i) => !['gold'].includes(i.template)).map((i) => ({ template: i.template, magic: i.magic?.name ?? null, bookId: i.bookId ?? null }));

test('quest items keep their rolled identity through rejoin, a normal action and expiry', () => {
  const w = world();
  const p = { id: 1, name: 'Ida', x: 0, z: -2, yaw: 0, rpg: { gold: 0, character: { name: 'Ida', level: 3, gender: 'Female' } } };
  w.players.set(1, p);
  w.rt.join(p);
  const before = new Set(p.rpg.inventory.map((i) => i.id));
  const r = w.rt.act(p, 'npc.topic', { targetId: w.giver.id });
  assert.equal(r.ok, true, r.error);
  const offer = p.rpg.quests.offer;
  assert.ok(offer?.id, 'offered');
  assert.equal(w.rt.act(p, 'quest.accept', { offerId: offer.id }).ok, true);
  const inst = p.rpg.quests.active[0];
  const rolled = identity(inst);

  assert.ok(inGroup('ReligiousItems', rolled.beads.template), rolled.beads.template);
  assert.ok(inGroup('Jewellery', rolled.charm.template), rolled.charm.template);
  assert.ok(inGroup('Drugs', rolled.herb.template), rolled.herb.template);
  assert.ok(inGroup('UselessItems1', rolled.scrap.template), `junk rolled ${rolled.scrap.template}`);
  assert.equal(rolled.wand.template, 'iron-dagger');
  assert.equal(rolled.tome.template, 'book');
  assert.equal(rolled.tome.appearance.extra.bookId, 7);
  assert.equal(w.magicRolls(), 1, 'the magic item is rolled once, at creation');

  // `make _beads_ permanent` and `give pc _wand_` put exactly the rolled items in the pack.
  const added = () => p.rpg.inventory.filter((i) => !before.has(i.id));
  assert.deepEqual(added().map((i) => i.template).sort(), [rolled.beads.template, 'iron-dagger'].sort());
  const wand = added().find((i) => i.template === 'iron-dagger');
  assert.equal(wand.magic.name, rolled.wand.appearance.extra.magic.name, 'the inventory wand is the rolled one');
  assert.equal(inst.items.beads.permanent, true);

  // Saved and restored as the database would, then rejoined: nothing is re-rolled or duplicated.
  const saved = JSON.parse(JSON.stringify(p.rpg));
  w.rt.leave(p);
  const p2 = { id: 1, name: 'Ida', x: 0, z: -2, yaw: 0, rpg: saved };
  w.players.set(1, p2);
  w.rt.join(p2);
  w.advance(5000); // ordinary ticks
  const inst2 = p2.rpg.quests.active[0];
  assert.deepEqual(identity(inst2), rolled);
  assert.equal(w.magicRolls(), 1);
  const packAfterRejoin = pack(p2);
  assert.deepEqual(packAfterRejoin, pack(p), 'the rejoin delivers nothing twice');
  assert.deepEqual(identity(inst2).wand, rolled.wand);

  // The timer expires: `make _charm_ permanent` gives the rolled trinket; the unkept drug and junk end with the quest.
  w.advance(2 * 1440 * 5000 + 10_000);
  assert.equal(p2.rpg.quests.active.length, 0);
  const finalPack = pack(p2);
  assert.equal(finalPack.filter((i) => i.template === rolled.charm.template).length - packAfterRejoin.filter((i) => i.template === rolled.charm.template).length, 1);
  assert.equal(finalPack.length, packAfterRejoin.length + 1, 'only the permanent trinket is added at expiry');
  assert.equal(w.magicRolls(), 1);
});

test('older saves: a template-less carried item gets one rolled identity; a junk potion is withdrawn', () => {
  const roll = () => ({ template: 'prayer-beads' });
  const carried = { className: 'religious', template: null, held: true };
  assert.equal(reviseSavedQuestItem(carried, { className: 'religious' }, roll), true);
  assert.equal(carried.template, 'prayer-beads');
  assert.equal(reviseSavedQuestItem(carried, { className: 'religious' }, () => ({ template: 'other' })), false, 'kept once rolled');
  const parcel = { className: 'junk', template: 'potion-of-healing', held: true };
  assert.equal(reviseSavedQuestItem(parcel, { className: 'junk', classicItem: { group: 1, index: 16 } }, () => null), true);
  assert.equal(parcel.template, null);
  // Items the player already received, handed over or that a foe holds keep what the save recorded.
  for (const it of [{ template: null, given: true }, { template: null, handedOver: true }, { template: 'potion-of-healing', given: true }]) {
    const copy = { ...it, className: 'junk' };
    assert.equal(reviseSavedQuestItem(copy, { className: 'junk', classicItem: { group: 1, index: 16 } }, roll), false);
    assert.deepEqual(copy, { ...it, className: 'junk' });
  }
  const potion = { className: 'potion', template: 'potion-of-healing', held: true };
  assert.equal(reviseSavedQuestItem(potion, { className: 'potion', classicItem: { group: 1, index: 1 } }, roll), false);
});

test('classic: every installed QBN item record maps per Item.CreateItem (O0B60Y18 parcel has no template)', { skip: !ARENA2 && 'operator ARENA2 not present in gamedata/' }, () => {
  const cat = loadCatalog({ dataPath: ARENA2 });
  const o = cat.quests.get('O0B60Y18');
  assert.ok(o, 'O0B60Y18 in catalogue');
  const parcel = [...o.def.resources.values()].find((r) => r.kind === 'item' && r.className === 'junk');
  assert.deepEqual(parcel.classicItem, { group: 1, index: 16 });
  assert.equal(questItemIdentity(parcel.classicItem, () => 0), null);
  const unresolved = new Set();
  for (const [name, q] of cat.quests) {
    for (const r of q.def.resources.values()) {
      if (r.kind !== 'item' || ['gold', 'artifact'].includes(r.className) || !r.classicItem) continue;
      const id = questItemIdentity(r.classicItem, () => 0.5, { magicItem: () => ({ template: 'iron-dagger' }), potion: () => ({ template: 'p' }), books: { randomId: () => 1 } });
      if (id?.template?.startsWith('potion-of-') && !(r.classicItem.group === 1 && r.classicItem.index === 1)) assert.fail(`${name} ${r.key} rolled a potion`);
      if (!id) unresolved.add(`${r.classicItem.group}/${r.classicItem.index}`);
    }
  }
  // Without an inventory identity: letters, out-of-range subclasses (O0B60Y18 junk 1/16, S0000017 painting 13/3 of
  // the one-member Paintings enum) and clothing (no classic clothing group table).
  assert.deepEqual([...unresolved].sort(), ['1/16', '12/-1', '12/18', '13/3', '6/-1', '6/14', '6/8', '9/5']);
});
