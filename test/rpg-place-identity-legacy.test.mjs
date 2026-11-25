// [asset] Brief A: a character saved by the pre-identity server, inside a Gothway Garden shop with an
// active quest, an outstanding repair and 4,000 string discoveries, restarts on the identity server.
// Real runtime, every real feature and the real SQLite store (test/support/rpg-session.mjs, FIXTURE
// layer). The pre-identity save is produced by playing the current server, then rewritten in SQLite
// to the old spellings and the old discovery list. Skips without gamedata/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createFixtureWorld, discoverFeatures, featuresWithQuestCatalog, localArena2, readPersisted, tempDir, STRICT,
} from './support/rpg-session.mjs';
import { loadWorldFromDir } from '../server/rpg/travel/data.js';
import { hasFound } from '../client/gameplay/travel/identity.js';
import { priceContext } from '../client/gameplay/economy/rules.js';
import { repairCost } from '../client/gameplay/townServices/rules.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const HOME = 'town:Daggerfall/Gothway Garden';
const STORE = 'b:2,1:15'; // Gothway Garden general store (repairs, quality 19)

/** Old spellings: any case the pre-identity reader accepted for the same record. */
const legacySpelling = (id) => typeof id === 'string' ? id.replace('Daggerfall/Gothway Garden', 'daggerfall/GOTHWAY garden') : id;

/** First building occupant in `town` offering `group` work today, reached through its real door. */
async function commonerGiver(world, c, town, group = 'Commoners') {
  const s = world.ctx.services;
  const p = world.players.get(c.id);
  const specs = s.portals.at(town);
  const data = await s.npcs.source.town(town);
  for (const w of data.work.filter((x) => x.group === group)) {
    const spec = specs.find((sp) => sp.to === w.interior);
    if (!spec) continue;
    if (world.ctx.location(p) !== town) s.portals.transfer(p, { location: town, x: 0, z: 0, yaw: 0 }, { label: 'outside' });
    const door = spec.entrances[0];
    Object.assign(p, { x: door.x, z: door.z });
    world.clock.advance(2000);
    c.must('portal.use', { portalId: spec.id });
    await s.npcs.ready(w.interior);
    await s.collision?.whenSettled?.(w.interior);
    world.tick(200);
    const e = c.state.entities.find((x) => x.kind === 'npc' && x.questGiver && x.questGroup === group);
    if (e) return e;
  }
  return null;
}

test('legacy save indoors: same door, same quest, same repair, every discovery, after restart', gate, async (t) => {
  assert.ok(ARENA2, 'RPG_INTEGRATION_STRICT=1 requires gamedata/…/arena2');
  const tmp = tempDir('dfw-identity-');
  const dbPath = `${tmp.dir}/world.db`;
  const discovered = await discoverFeatures();
  const features = await featuresWithQuestCatalog(discovered.features, ARENA2, ['A0C00Y21']);
  const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
  t.after(() => {
    try { world.close(); } finally { tmp.remove(); }
  });
  const svc = () => world.ctx.services;

  // ---- play on the current server: quest, repair, enter the shop ----
  let a = world.connect('acct-a', 'Aldora');
  assert.equal(a.character.location, HOME);
  await svc().collision.whenSettled(HOME);
  await svc().interiors.ready;
  await svc().interiors.survey(HOME);
  await svc().townCountersSettled(HOME);
  world.tick(40);
  const p = world.players.get(a.id);

  // Commoners work comes from authored building occupants (no street crier with installed data;
  // same rule as test/rpg-world-integration.test.mjs commonerGiver). Walk through each real door.
  const giver = await commonerGiver(world, a, HOME);
  assert.ok(giver, 'a Commoners quest giver in Gothway Garden');
  Object.assign(p, { x: giver.x, z: giver.z + 1 });
  world.tick(40);
  a.must('quest.request', { targetId: giver.id });
  a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
  const quest = structuredClone(a.character.quests.active[0]);
  // Back out through the giver's own door.
  const out = svc().portals.into(p.rpg.location).exits[0];
  Object.assign(p, { x: out.x, z: out.z });
  world.clock.advance(2000);
  a.must('portal.leave');
  assert.equal(p.rpg.location, HOME);

  const sword = p.rpg.inventory.find((i) => i.group === 'weapon');
  if (sword.equipped) a.must('inventory.unequip', { itemId: sword.id });
  svc().damageItem(p, sword.id, Math.floor(sword.maxCondition / 2));
  p.rpg.gold = 500;
  const portal = svc().portals.get(HOME, STORE);
  assert.ok(portal, 'general store door surveyed');
  const door = portal.entrances[0];
  Object.assign(p, { x: door.x, z: door.z });
  const damaged = p.rpg.inventory.find((i) => i.id === sword.id);
  a.must('town.services');
  const counters = a.events('townServices.counters').at(-1);
  const smith = counters.counters.find(c => c.id === STORE);
  assert.ok(smith, 'the shop is listed on the Bank & Repairs page');
  const trade = priceContext({ quality: smith.quality, character: p.rpg.character, ...counters.trade });
  const quote = repairCost(damaged, smith.quality, p.rpg.guilds?.fighters?.rank ?? null, { ...trade, adjust: counters.market.adjust });
  assert.ok(quote > 0);
  assert.equal(svc().repairQuote(p, STORE, sword.id), quote, 'the browser and the smith quote the same amount');
  a.must('repair.leave', { counterId: STORE, itemId: sword.id, cost: quote });
  const ticket = structuredClone(p.rpg.townServices.repairs[0]);
  assert.equal(ticket.item.id, sword.id);
  assert.equal(ticket.cost, quote);
  assert.equal(p.rpg.gold, 500 - quote);

  world.clock.advance(2000);
  a.must('portal.use', { portalId: STORE });
  const inside = p.rpg.location;
  assert.match(inside, /^interior:Daggerfall\/Gothway Garden\/2,1\/15$/);
  const back = structuredClone(p.rpg.portal.returnTo);
  assert.equal(back.location, HOME);

  // ---- save, stop, rewrite to the pre-identity form ----
  world.leave(a);
  world.store.close();
  const catalog = (await loadWorldFromDir(ARENA2)).catalog;
  const hidden = catalog.locations.filter((e) => !e.discovered).slice(0, 4000);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT rpg FROM players WHERE id = ?').get(a.id);
  const rpg = JSON.parse(row.rpg);
  rpg.location = legacySpelling(rpg.location);
  for (const k of ['from', 'to']) rpg.portal[k] = legacySpelling(rpg.portal[k]);
  rpg.portal.returnTo.location = legacySpelling(rpg.portal.returnTo.location);
  rpg.travel.lastTown = legacySpelling(rpg.travel.lastTown);
  rpg.travel.positions = Object.fromEntries(Object.entries(rpg.travel.positions ?? {}).map(([k, v]) => [legacySpelling(k), v]));
  rpg.travel.discovered = hidden.map((e) => e.id); // the old cap held at most 4,000 of these
  delete rpg.travel.found;
  delete rpg.travel.identity;
  for (const pl of Object.values(rpg.quests.active[0].places ?? {})) {
    pl.location = legacySpelling(pl.location);
    if (pl.interior) pl.interior = legacySpelling(pl.interior);
  }
  rpg.townServices.repairs[0].town = legacySpelling(rpg.townServices.repairs[0].town);
  db.prepare('UPDATE players SET rpg = ? WHERE id = ?').run(JSON.stringify(rpg), a.id);
  db.close();
  assert.equal(readPersisted(dbPath, a.id).rpg.location, 'interior:daggerfall/GOTHWAY garden/2,1/15');

  // ---- cold start on the identity server ----
  world.boot();
  a = world.connect('acct-a', 'Aldora');
  await svc().interiors.ready;
  const p2 = world.players.get(a.id);
  // Travel converts as soon as MAPS.BSA is read; the join may precede it.
  for (let i = 0; i < 200 && p2.rpg.travel.identity !== 1; i++) await new Promise((r) => setTimeout(r, 25));
  await svc().interiors.survey(HOME);
  await svc().townCountersSettled(HOME);
  world.tick(40);
  assert.equal(p2.rpg.location, inside, 'still inside the same shop, canonical address');
  assert.equal(p2.rpg.portal.returnTo.location, HOME);
  assert.equal(p2.rpg.quests.active[0].uid, quest.uid, 'same quest instance');
  assert.deepEqual(p2.rpg.quests.active[0].items, quest.items);
  assert.equal(p2.rpg.townServices.repairs[0].ticket, ticket.ticket);
  assert.equal(p2.rpg.townServices.repairs[0].cost, quote);
  assert.equal(p2.rpg.gold, 500 - quote, 'the repair payment survives legacy save conversion');
  assert.equal(p2.rpg.townServices.repairs[0].town, HOME);
  assert.deepEqual(p2.rpg.townServices.repairs[0].item, ticket.item);
  assert.equal(hidden.filter((e) => hasFound(p2.rpg.travel.found, e)).length, 4000, 'every legacy discovery kept');
  assert.deepEqual(p2.rpg.travel.discovered, []);
  const persisted = readPersisted(dbPath, a.id).rpg;
  assert.equal(persisted.travel.identity, 1, 'conversion saved');

  // Leave through the same door.
  const exit = svc().portals.into(inside).exits[0];
  Object.assign(p2, { x: exit.x, z: exit.z });
  world.clock.advance(2000);
  a.must('portal.leave');
  assert.equal(p2.rpg.location, HOME);
  assert.deepEqual([p2.x, p2.z], [back.x, back.z], 'returned through the same door');

  // Collect the same item once it is ready.
  world.clock.advance((ticket.readyAt - ticket.leftAt) * 60_000 + 60_000);
  world.tick(40);
  Object.assign(p2, { x: door.x, z: door.z });
  const r = a.act('repair.collect', { ticket: ticket.ticket, counterId: STORE });
  t.diagnostic(`repair.collect: ${JSON.stringify(r)}`);
  assert.equal(r.ok, true);
  assert.ok(p2.rpg.inventory.some((i) => i.id === sword.id), 'same item back');
  assert.equal(a.act('repair.collect', { ticket: ticket.ticket, counterId: STORE }).ok, false, 'collected once');
});
