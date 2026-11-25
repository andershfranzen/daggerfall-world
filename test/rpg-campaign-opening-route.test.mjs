// The installed opening: a new character on Privateer's Hold's start marker can reach the dungeon exit through the
// real collision and the real doors, then leave. FIXTURE: the route is planned on the server's collision world and the
// body is placed at each door's planned standing spot (not walked in real time); doors open through `dungeon.use`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { OPENING_DUNGEON } from '../server/rpg/campaign/sites.js';
import { createFixtureWorld, discoverFeatures, localArena2, STRICT, tempDir } from './support/rpg-session.mjs';
import { DungeonExplorer, usableDoors } from './support/dungeon-route.mjs';

const dataPath = localArena2();
const gate = { skip: !dataPath && !STRICT ? 'operator ARENA2 unavailable' : false };

test('a new character reaches Privateer’s Hold’s exit from the start marker (fixture route)', gate, async (t) => {
  const temp = tempDir('dfw-opening-route-');
  const world = await createFixtureWorld({ dbPath: `${temp.dir}/world.db`, features: (await discoverFeatures()).features, dataPath });
  t.after(() => { try { world.close(); } finally { temp.remove(); } });
  await world.ctx.services.quests.openingReady;
  const client = world.connect('opening-route', 'Aldora');
  const draft = new CharacterDraft('Aldora');
  draft.race = 'Breton';
  draft.gender = 'Female';
  draft.chooseClass('Warrior');
  client.must('character.roll', draft.rollRequest());
  draft.syncRoll(client.character.character.draft);
  draft.autoDistribute('attributes');
  draft.autoDistribute('skills');
  client.must('character.create', draft.createRequest());

  const p = world.players.get(client.id);
  const s = world.ctx.services;
  const portal = s.portals.into(OPENING_DUNGEON);
  assert.equal(p.rpg.location, OPENING_DUNGEON);
  assert.equal(p.x, portal.meta.newCharacterStart.x);
  assert.equal(p.z, portal.meta.newCharacterStart.z);
  const names = client.character.quests.active.map((q) => q.name);
  assert.ok(names.includes('_TUTOR__') && names.includes('_BRISIEN'), names.join(','));

  const exit = portal.exits[0];
  const col = s.collision.instanceWorld(OPENING_DUNGEON);
  const scene = await s.interiors.scene(OPENING_DUNGEON);
  const isOpen = (id) => s.dungeonLocks.isOpen(OPENING_DUNGEON, id);
  const ex = new DungeonExplorer(col, { x: p.x, y: p.rpg.portal.footY, z: p.z }, exit, { reach: 1.2, maxDrop: 0.8 });
  const tried = new Set();
  const opened = [];
  let hit = null;
  for (let round = 0; round < 60 && !hit; round++) {
    hit = ex.search();
    if (hit) break;
    const [cand] = usableDoors(ex.visited, scene.mechanisms, exit, { isOpen, tried });
    assert.ok(cand, `no usable door after ${ex.visited.length} reachable spots; opened ${opened.join(',')}`);
    tried.add(cand.door.id);
    Object.assign(p, { x: cand.stand.x, z: cand.stand.z });
    p.rpg.portal.footY = cand.stand.y;
    const r = cand.door.lock ? client.act('dungeon.pick', { id: cand.door.id }) : client.act('dungeon.use', { id: cand.door.id });
    for (let i = 0; i < 10; i++) { world.clock.advance(250); world.tick(250); }
    if (r.ok && isOpen(cand.door.id)) opened.push(cand.door.id);
    ex.reopen(cand.door, 5);
  }
  assert.ok(hit, 'route from the start marker to the exit');
  Object.assign(p, { x: hit.x, z: hit.z });
  p.rpg.portal.footY = hit.y;
  client.must('portal.leave');
  assert.equal(client.character.location, portal.from);
  assert.ok(client.character.quests.active.some((q) => q.name === 'S0000999'), 'leaving starts the main quest backbone');
  t.diagnostic(`exit reached through ${opened.length} opened doors (${opened.join(', ')}); ${ex.expanded} nodes expanded`);
});
