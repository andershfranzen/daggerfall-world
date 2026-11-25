// The original TVRNAS07.RMB contains eight people in this room. A parser-only
// test missed the regression where nobody was registered for an interior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { arena2Dir } from '../tools/world-audit/sources.mjs';
import { features } from '../server/rpg/features.js';
import { createFixtureWorld, tempDir, STRICT } from './support/rpg-session.mjs';

const dataPath = arena2Dir();
const town = 'town:Daggerfall/Blackidge Hamlet';
const interior = 'interior:Daggerfall/Blackidge Hamlet/0,0/10';

test('two players entering the Blackidge tavern receive its eight authored occupants', { skip: !dataPath && !STRICT }, async t => {
  assert.ok(dataPath, 'strict tavern regression requires the classic files');
  const tmp = tempDir('dfw-tavern-');
  const world = await createFixtureWorld({ dbPath: join(tmp.dir, 'tavern.db'), dataPath, features });
  t.after(() => { world.close(); tmp.remove(); });
  assert.deepEqual(world.installErrors, []);
  const services = world.ctx.services;
  await services.interiors.survey(town);
  const portal = services.portals.into(interior);
  assert.ok(portal?.entrances.length);
  const entrance = portal.entrances[0];
  for (const id of ['first', 'second']) {
    // Start a saved visitor at the street door. Both go inside through portal.use.
    const row = world.store.createForAccount(id, id);
    world.store.saveCharacters([{ ...row, ...entrance.exit, rpg: { location: town } }]);
  }
  const a = world.connect('first', 'first'), b = world.connect('second', 'second');
  a.must('portal.use', { portalId: portal.id });
  b.must('portal.use', { portalId: portal.id });
  assert.equal(a.character.location, interior);
  assert.equal(b.character.location, interior);
  const occupants = c => c.state.entities.filter(e => e.kind === 'npc');
  // Going through the door starts the population load. Waiting for its completion
  // must not be what triggers it, or a test could hide an empty room in normal play.
  world.tick(200);
  assert.ok(['loading', 'ready'].includes(services.npcs.status(interior).status));
  await services.npcs.ready(interior);
  world.tick(200);
  const guests = occupants(a);
  assert.equal(guests.length, 8);
  const keepers = guests.filter(e => e.role === 'innkeeper');
  assert.equal(keepers.length, 1);
  assert.deepEqual(keepers[0].sprite, { archive: 182, record: 2 });
  assert.deepEqual(occupants(b), guests);
  const signature = c => occupants(c).map(({ id, x, y, z, sprite }) => ({ id, x, y, z, sprite })).sort((l, r) => l.id.localeCompare(r.id));
  const before = signature(a);
  a.leave();
  const back = world.connect('first', 'first');
  assert.equal(back.character.location, interior);
  assert.deepEqual(signature(back), before);
});
