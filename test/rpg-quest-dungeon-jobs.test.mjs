// Ordinary jobs that put people and enemies in a randomly chosen dungeon (package 17), on the production feature
// manifest and the operator's ARENA2:
//   K0C00Y09  a merchant pays for killing a Ranger placed on a dungeon quest spawn marker (199/11)
//   A0C01Y03  a resident's errand chain: a created person at home, a librarian in a remote library, a contact in a
//             random dungeon, then back to the giver
// Positions are set by the fixture (FIXTURE POSITIONING); the live Rare Book test walks with real input. Requires
// gamedata/…/arena2; skipped without it (RPG_INTEGRATION_STRICT=1 makes that a failure).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverFeatures, createFixtureWorld, readPersisted, tempDir, STRICT, localArena2, featuresWithQuestCatalog,
} from './support/rpg-session.mjs';
import * as R from '../client/gameplay/character/rules.js';
import { exteriorOf } from '../client/world/interiors/index.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const discovered = ARENA2 ? await discoverFeatures() : { features: [] };
const SHOP = 'interior:Daggerfall/Gothway Garden/3,0/16';

async function questWorld(t, names) {
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/world.db`;
  const features = await featuresWithQuestCatalog(discovered.features, ARENA2, names);
  const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
  t.after(() => { try { world.close(); } finally { tmp.remove(); } });
  await world.ctx.services.interiors.ready;
  return { world, dbPath };
}
async function until(world, fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** FIXTURE POSITIONING: production portal transfer to a landing. */
function placeAt(world, c, location, at, portal = null) {
  world.ctx.services.portals.transfer(world.players.get(c.id), { location, x: at.x, y: at.y ?? 0, z: at.z, yaw: 0 }, { portal });
  world.tick(40);
}
/** FIXTURE POSITIONING: beside an entity on its storey, on clear floor. */
function beside(world, c, at) {
  const p = world.players.get(c.id);
  const loc = c.character.location;
  const col = world.ctx.services.collision;
  const spot = col.nearestClear(loc, at.x, at.z + 0.9, 3, at.y) ?? { x: at.x, z: at.z + 0.9 };
  p.x = spot.x;
  p.z = spot.z;
  const y = col.groundAt(loc, p.x, p.z, at.y);
  if (p.rpg.portal && Number.isFinite(y)) p.rpg.portal.footY = y;
  world.tick(40);
}
/** Into a building or dungeon through its own door (FIXTURE POSITIONING at the door). */
async function enter(world, c, interior) {
  const s = world.ctx.services;
  const town = interior.startsWith('dungeon:') ? `town:${interior.slice(8)}` : null;
  if (town) {
    if (c.character.location !== town) c.must('travel.go', { to: town });
    await s.interiors.survey(town);
  } else {
    const exterior = s.portals.into(interior)?.from;
    if (exterior && c.character.location !== exterior) { world.clock.advance(5000); c.must('travel.go', { to: exterior }); }
    await s.interiors.survey(exterior);
  }
  const door = s.portals.into(interior);
  placeAt(world, c, door.from, { x: door.entrances[0].x, z: door.entrances[0].z });
  await s.collision.whenSettled(interior);
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.use', { portalId: door.id });
    if (!r.ok && !/loading|moment|locked/i.test(r.error)) throw new Error(`portal.use: ${r.error}`);
    return r.ok;
  }, `${interior} to open`);
  return door;
}
async function leave(world, c) {
  const loc = c.character.location;
  if (!/^(interior|dungeon):/.test(loc)) return;
  await world.ctx.services.interiors.survey(loc);
  const door = world.ctx.services.portals.into(loc);
  const p = world.players.get(c.id);
  p.x = door.entrances[0].inner.x; // FIXTURE POSITIONING: at the exit door
  p.z = door.entrances[0].inner.z;
  if (p.rpg.portal) p.rpg.portal.footY = door.entrances[0].enter?.y ?? p.rpg.portal.footY;
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.leave', {});
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.leave: ${r.error}`);
    return r.ok;
  }, 'the way out');
  world.clock.advance(5000);
}
function createCharacter(c) {
  c.must('character.roll', { className: 'Warrior' });
  const d = c.character.character.draft;
  const attributes = { ...d.attributeBase };
  let pool = d.bonusPool;
  for (const a of R.ATTRIBUTES) { const add = Math.min(pool, R.MAX_STAT - attributes[a]); attributes[a] += add; pool -= add; }
  const career = d.career ?? R.CLASSES.find((k) => k.name === d.className); // the server validates against the draft's career
  const skills = {};
  for (const g of ['primary', 'major', 'minor']) {
    let left = R.SKILL_GROUP_POOL;
    for (const sk of R.SKILLS.filter((x) => R.skillGroupOf(career, x) === g)) {
      const add = Math.min(left, R.MAX_SKILL - d.skillBase[sk]);
      if (add > 0) { skills[sk] = d.skillBase[sk] + add; left -= add; }
    }
  }
  c.must('character.create', { race: 'Nord', gender: 'Male', attributes, skills });
}
const gold = (c) => Number(c.character.gold) || 0;
const questOf = (c, name) => c.character.quests?.active?.find((q) => q.name === name) ?? null;

async function merchantOffer(world, a, name) {
  await enter(world, a, SHOP);
  const m = await until(world, () => a.state.entities.find((e) => e.kind === 'npc' && e.questGroup === 'Merchants'), 'the merchant');
  beside(world, a, m);
  a.must('quest.request', { targetId: m.id });
  const offer = a.events('questOffer').at(-1);
  a.must('quest.accept', { offerId: offer.offerId });
  assert.ok(questOf(a, name), `${name} accepted`);
  return { merchant: m, offer };
}

test('[asset] the authored Kynareth quest giver offers the deity’s job only to its own temple member', gate, async (t) => {
  const { world } = await questWorld(t, ['G0B00Y00']);
  const a = world.connect('acct-temple-work', 'Seryn');
  const s = world.ctx.services;
  const town = 'town:Daggerfall/Daggerfall';
  const temple = 'interior:Daggerfall/Daggerfall/3,4/13';
  await s.interiors.survey(town);
  const portal = s.portals.into(temple);
  assert.ok(portal);
  placeAt(world, a, temple, portal.entrances[0].inner, portal);
  await s.collision.whenSettled(temple);
  const giver = await until(world, () => a.state.entities.find(e => e.questGroup === 'HolyOrder'), 'the Kynareth quest giver');
  beside(world, a, giver);
  const p = world.players.get(a.id);
  const e = world.ctx.entities.get(giver.id);
  assert.equal(s.guilds.hallOf(e).variant, 35);
  assert.notEqual(e.faction, 35, 'the staff member has their own service faction');
  const request = { targetId: giver.id };
  assert.match(a.act('quest.request', request).error, /no work/);
  s.guilds.addMembership(p, 'temple', 27, 6);
  assert.match(a.act('quest.request', request).error, /no work/, 'a high-ranking Julianos member is a stranger here');
  s.guilds.addMembership(p, 'temple', 35, 0);
  const foot = p.rpg.portal.footY;
  p.rpg.portal.footY = foot + 3.225;
  assert.match(a.act('quest.request', request).error, /another floor/, 'the quest giver is one storey below');
  p.rpg.portal.footY = foot;
  a.must('quest.request', request);
  const offer = a.events('questOffer').at(-1);
  a.must('quest.accept', { offerId: offer.offerId });
  assert.ok(questOf(a, 'G0B00Y00'));
});

describe('[asset] random-dungeon jobs: people and enemies on quest spawn markers', () => {
  test('K0C00Y09: the merchant’s Ranger stands on a dungeon spawn marker, is private, dies once and pays once', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, ['K0C00Y09']);
    const a = world.connect('acct-kill-a', 'Aldora');
    const b = world.connect('acct-kill-b', 'Brannoc');
    createCharacter(a);
    const g0 = gold(a);
    await merchantOffer(world, a, 'K0C00Y09');
    const inst = questOf(a, 'K0C00Y09');
    const place = inst.places['l.00'];
    assert.match(place.interior, /^dungeon:Daggerfall\//);
    const spawn = await until(world, () => questOf(a, 'K0C00Y09').foes['f.00'].spawnAt, 'the Ranger’s marker');
    const markers = await world.ctx.services.npcs.questSpawn(place.interior);
    const items = await world.ctx.services.npcs.questItemMarkers(place.interior);
    assert.ok([...markers, ...items].some((m) => (m.id ?? m.key) === spawn.id), `on an authored marker of ${place.interior}`);
    assert.equal(spawn.fallback ?? null, markers.length ? null : 'item', 'spawn marker, or the item-marker fallback when the dungeon has none');

    await leave(world, a);
    await enter(world, a, place.interior);
    // B goes to the same dungeon (map knowledge through the party) and sees nothing of A's job.
    a.must('party.invite', { targetId: b.id });
    b.must('party.accept', { fromId: a.id });
    world.ctx.services.travel.discover(world.players.get(b.id), place.location);
    await enter(world, b, place.interior);
    const ranger = await until(world, () => a.state.entities.find((e) => e.kind === 'monster' && e.quest), 'the Ranger');
    assert.equal(b.entity(ranger.id), null, 'B does not see A’s quest foe');
    assert.ok(Math.abs(ranger.y - spawn.y) < 2.5, 'on the marker’s storey');

    beside(world, a, ranger);
    // FIXTURE GEAR: an armed Warrior. Unarmed (Hand-to-Hand 20) against this armoured class enemy, successfulHit clamps
    // to its 3% floor, so the first landed blow can take dozens of swings.
    const blade = world.ctx.services.giveItem(world.players.get(a.id), 'steel-longsword', 1);
    a.must('inventory.equip', { itemId: blade.id });
    a.must('combat.ready', { ready: true });
    // Every swing is logged (result, the server's hit events, distance and storey) so a failure carries its evidence.
    const swings = [];
    const pa = world.players.get(a.id);
    for (let i = 0; i < 200 && !(world.ctx.entities.get(ranger.id)?.dead || questOf(a, 'K0C00Y09')?.foes['f.00'].kills); i++) {
      const e = world.ctx.entities.get(ranger.id);
      if (!e) { swings.push({ i, gone: true }); world.tick(500); continue; }
      // FIXTURE DAMAGE: a one-hit-point Ranger dies to the first landed blow. maxHp drops with it so the fixture itself
      // is not a wound: any wound short of death sends this Ranger fleeing to _L.01_ (the classic flee branch).
      e.hp = 1;
      e.maxHp = 1;
      beside(world, a, e); // FIXTURE POSITIONING: the Ranger moves while fighting
      pa.rpg.character.health = pa.rpg.character.maxHealth; // FIXTURE: A is never defeated by the Ranger's replies
      pa.rpg.character.fatigue = pa.rpg.character.maxFatigue;
      world.clock.advance(2000);
      const r = a.act('combat.attack', { targetId: ranger.id, direction: 'right' });
      const hits = a.events('hit').filter((h) => h.entityId === ranger.id).length;
      swings.push({
        i, ok: r.ok, error: r.error, hits, hp: world.ctx.entities.get(ranger.id)?.hp ?? null,
        d: Math.hypot(pa.x - e.x, pa.z - e.z).toFixed(2), foot: pa.rpg.portal?.footY, y: e.y,
      });
      world.tick(300);
    }
    const kills = questOf(a, 'K0C00Y09')?.foes['f.00'].kills ?? 0;
    t.diagnostic(`K0C00Y09 swings to the kill: ${swings.length} (${swings.filter((x) => x.ok).length} accepted)`);
    assert.equal(kills, 1, `the Ranger fell; swings: ${JSON.stringify(swings)}`);
    assert.equal(questOf(a, 'K0C00Y09').foes['f.00'].kills, 1);
    assert.ok(a.events('questMessage').some((e) => e.uid === inst.uid), 'kill message from the QRC');

    // Restart mid-job: the dead Ranger is not respawned.
    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-kill-a', 'Aldora');
    await until(world, () => a2.character.location === place.interior && world.ctx.services.collision.instanceWorld(place.interior), 'resume inside');
    world.tick(2000);
    assert.ok(!a2.state.entities.some((e) => e.kind === 'monster' && e.quest && !e.dead), 'no living Ranger after restart');

    await leave(world, a2);
    world.clock.advance(5000);
    await enter(world, a2, SHOP);
    const m2 = await until(world, () => a2.state.entities.find((e) => e.kind === 'npc' && e.questGroup === 'Merchants'), 'the merchant again');
    beside(world, a2, m2);
    const before = gold(a2);
    a2.must('npc.talk', { targetId: m2.id });
    world.tick(2000);
    const done = a2.character.quests.done.find((d) => d.uid === inst.uid);
    assert.ok(done, 'job finished');
    const paid = gold(a2) - before;
    assert.ok(paid >= 10 && paid <= 45, `kill payment ${paid} from the classic 10..45 range`);
    a2.must('npc.talk', { targetId: m2.id });
    world.tick(2000);
    assert.equal(gold(a2), before + paid, 'paid once');
    assert.equal(readPersisted(dbPath, a2.id).rpg.quests.done.filter((d) => d.uid === inst.uid).length, 1);
    t.diagnostic(`K0C00Y09: ${place.interior} marker ${spawn.id}${spawn.fallback ? ' (item marker)' : ''}, paid ${paid} (start ${g0})`);
  });

  test('K0C00Y09 flee branch: a wounded Ranger moves to the second dungeon and the merchant pays the larger sum', gate, async (t) => {
    const { world } = await questWorld(t, ['K0C00Y09']);
    const a = world.connect('acct-flee-a', 'Aldora');
    createCharacter(a);
    await merchantOffer(world, a, 'K0C00Y09');
    const uid = questOf(a, 'K0C00Y09').uid;
    const cur = () => a.character.quests.active.find((q) => q.uid === uid);
    const first = cur().places['l.00'];
    const second = cur().places['l.01'];
    assert.notEqual(first.interior, second.interior, 'two different random dungeons');
    await leave(world, a);
    await enter(world, a, first.interior);
    const ranger = await until(world, () => a.state.entities.find((e) => e.kind === 'monster' && e.quest), 'the Ranger');
    beside(world, a, ranger);
    a.must('combat.ready', { ready: true });
    // A wound without a kill: the quest tick marks it injured and the script moves the Ranger away.
    const e = world.ctx.entities.get(ranger.id);
    e.hp = Math.max(1, e.hp - 1); // FIXTURE DAMAGE: a single non-lethal wound
    await until(world, () => cur()?.foes['f.00'].place === 'l.01', 'the Ranger to flee');
    world.tick(1000);
    assert.ok(!a.state.entities.some((x) => x.kind === 'monster' && x.quest), 'gone from the first dungeon');
    await leave(world, a);
    await enter(world, a, SHOP);
    const m = await until(world, () => a.state.entities.find((x) => x.kind === 'npc' && x.questGroup === 'Merchants'), 'the merchant');
    beside(world, a, m);
    const before = gold(a);
    a.must('npc.talk', { targetId: m.id });
    world.tick(1000);
    const paid = gold(a) - before;
    assert.equal(a.character.quests.done.find((d) => d.uid === uid)?.result, 'success');
    assert.ok(paid >= 50 && paid <= 150, `flee payment ${paid} from the classic 50..150 range`);
    t.diagnostic(`K0C00Y09 flee: ${first.interior} -> ${second.interior}, paid ${paid}`);
  });

  test('A0C01Y03: a created person at home, a librarian, and a contact on a dungeon marker complete the errand chain', gate, async (t) => {
    const { world } = await questWorld(t, ['A0C01Y03']);
    const a = world.connect('acct-chain-a', 'Aldora');
    const s = world.ctx.services;
    const town = world.ctx.defaultLocation;
    const work = await s.npcs.workAt(town, a.id);
    await s.interiors.survey(town);
    const job = work.find((w) => w.group === 'Commoners' && s.portals.at(town).some((sp) => sp.to === w.interior));
    assert.ok(job, 'a named building whose resident offers Commoners work today');
    await enter(world, a, job.interior);
    const giver = await until(world, () => a.state.entities.find((e) => e.questGiver && e.questGroup === 'Commoners'), 'the giver');
    beside(world, a, giver);
    a.must('quest.request', { targetId: giver.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    const uid = questOf(a, 'A0C01Y03').uid;
    const cur = () => a.character.quests.active.find((q) => q.uid === uid);

    /** Goes to a quest person wherever the engine put them and talks to them. */
    async function meet(k) {
      // Remote sites bind to a building once the player is in that town and it has been surveyed.
      const town = cur().places[cur().people[k].place]?.location;
      if (town && !/^(interior|dungeon):/.test(town) && c0(town)) {
        await leave(world, a);
        world.clock.advance(5000);
        a.must('travel.go', { to: town });
        await s.interiors.survey(town);
      }
      const pl = await until(world, () => { const q = cur(); const pk = q.people[k].place; return pk && (q.places[pk].interior || q.places[pk].noBuilding) && q.places[pk]; }, `${k}'s place`);
      if (pl.interior) {
        await leave(world, a);
        await enter(world, a, pl.interior);
      } else await leave(world, a); // no such building in that town: the person waits in its street
      const e = await until(world, () => a.state.entities.find((x) => x._quest === undefined && x.quest && x.kind === 'npc' && x.name === cur().people[k].name), `${k} in ${pl.interior}`);
      beside(world, a, e);
      a.must('npc.talk', { targetId: e.id });
      world.tick(500);
      return pl;
    }
    const c0 = (town) => a.character.location !== town && exteriorOf(a.character.location) !== town;
    const inst = cur();
    assert.equal(inst.people['p.02'].atHome, true, 'the created contact lives in a home building');
    const home = await meet('p.02');
    assert.ok(home.home && home.interior, `home site bound to a building: ${home.interior}`);
    assert.equal(cur().items['i.00'].held, true, 'the plant bought the book');
    const library = await meet('p.03');
    assert.match(library.interior, /^interior:/, 'the librarian is in a remote library');
    assert.equal(cur().places['l.00'].revealed, true, 'the dungeon is revealed');
    const dungeon = cur().places['l.00'];
    const contact = await meet('p.00');
    assert.equal(contact.interior, dungeon.interior);
    assert.ok(cur().people['p.00'].spawnAt, 'dungeon contact stands on a marker');
    assert.equal(cur().items['i.03'].held, true, 'the reply letter');
    await leave(world, a);
    await enter(world, a, job.interior);
    const g = await until(world, () => a.state.entities.find((e) => e.id === giver.id), 'the giver again');
    beside(world, a, g);
    const before = gold(a);
    a.must('npc.talk', { targetId: g.id });
    world.tick(1000);
    assert.equal(a.character.quests.done.find((d) => d.uid === uid)?.result, 'success');
    assert.ok(gold(a) > before, 'paid');
    t.diagnostic(`A0C01Y03: home ${home.interior}; library ${library.interior}; dungeon ${dungeon.interior}; paid ${gold(a) - before}`);
  });
});
