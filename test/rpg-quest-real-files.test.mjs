// Classic 0x54 `play sound N every M minutes K times` against the installed ARENA2: N is a DAGGER.SND record id
// (316, 319, 349, 386, 10160, 11146 in the installed QBNs), not a record index. Skipped without local game data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { localArena2 } from './support/rpg-session.mjs';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { createInstance, updateQuest } from '../server/rpg/quests/engine.js';
import { clipsForEvent } from '../client/gameplay/atmosphere/playlists.js';
import { AudioEngine } from '../client/gameplay/atmosphere/engine.js';
import { BsaArchive, NUMBER_RECORD } from '../client/world/bsa.js';
import { questItemIdentity } from '../server/rpg/quests/itemIdentity.js';
import { permanentQuestItem } from '../server/rpg/campaign/rewards.js';
import { addItem } from '../server/rpg/inventory.js';

const arena2 = localArena2();

test('installed quest sounds reach the player as playable DAGGER.SND records', { skip: !arena2 && 'no local ARENA2' }, async () => {
  const cat = loadCatalog({ dataPath: arena2, artifact: () => true });
  const snd = await BsaArchive.open(await openAsBlob(join(arena2, 'DAGGER.SND')), 'DAGGER.SND', NUMBER_RECORD);

  // Every installed play sound names an existing record.
  const ids = new Set();
  for (const q of cat.quests.values()) for (const t of q.def.tasks) for (const a of t.actions) if (a.name === 'playSound') ids.add(a.args.sound);
  assert.deepEqual([...ids].sort((a, b) => a - b), [316, 319, 349, 386, 10160, 11146]);
  for (const id of ids) assert.ok(snd.indexOfId(id) >= 0, `record ${id} exists`);

  // O0B2XY14 `_S.02_`: when _S.00_ and _S.13_ -> play sound 11146 every 1 minutes 1 times, through the real engine.
  const def = cat.quests.get('O0B2XY14').def;
  const heard = [];
  const host = new Proxy({ sound: (inst, what) => heard.push(what), text: () => '' }, { get: (o, k) => o[k] ?? (() => null) });
  const inst = createInstance(def, { uid: 'q1', seed: 1, giver: null, host, now: 0, source: 'test' });
  inst.tasks['s.00'].t = true;
  inst.tasks['s.13'].t = true;
  updateQuest(def, inst, host, 1);
  updateQuest(def, inst, host, 5);
  assert.deepEqual(heard, [{ sound: 11146 }], 'plays once');

  // The client plays that record, not record index 11146 (out of range: silence).
  const ev = { kind: 'questSound', uid: 'q1', ...heard[0] };
  const [cue] = clipsForEvent(ev);
  const asked = [];
  const engine = Object.assign(Object.create(AudioEngine.prototype), {
    ctx: { state: 'running' }, paused: false, snd, _buffer: async (i) => { asked.push(i); return null; },
  });
  await engine.playClip(cue.clip, { record: cue.record });
  assert.deepEqual(asked, [snd.indexOfId(11146)]);
  assert.notEqual(asked[0], 11146);
});

// Item.MakePermanent: the converted item is an ordinary record. P0B00L03's men's clothing 6/8 has no installed
// classic template, so it takes the fallback path every time.
test('make permanent fallback on an installed quest item yields an ordinary, tradeable record', { skip: !arena2 && 'no local ARENA2' }, () => {
  const cat = loadCatalog({ dataPath: arena2, artifact: () => true });
  const def = cat.quests.get('P0B00L03').def;
  const r = [...def.resources.values()].find((x) => x.className === 'mens_clothing');
  assert.deepEqual(r.classicItem, { group: 6, index: 8 });
  assert.equal(questItemIdentity(r.classicItem, () => 0.5, {}), null, 'no rolled template');

  const player = { id: 'p', rpg: { gold: 0, inventory: [], quests: {} } };
  const ctx = { dirty() {}, notify() {}, services: { giveItem: (p, t, n, a) => addItem(p.rpg, t, n, a) } };
  const quest = { uid: 'q1', name: 'P0B00L03', title: 'P0B00L03', notes: [], items: { [r.key]: { className: 'mens_clothing', name: r.key, template: null, held: true } } };
  permanentQuestItem(ctx, player, quest, r.key, () => '');
  assert.equal(player.rpg.inventory.length, 1);
  const [rec] = player.rpg.inventory;
  assert.equal(rec.quest, undefined, 'not flagged as a quest item (untradeable, unsellable, unstorable)');
  assert.equal(quest.items[r.key].permanent, true);
});
