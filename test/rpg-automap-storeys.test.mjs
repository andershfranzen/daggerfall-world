// [asset] Explored-storey selector on the real Privateer's Hold (package 6 follow-up).
// Real ARENA2 dungeon geometry, the shared collision world and line of sight, and the browser's own automap
// controller. Regression: the Hold's entrance level (~720 m² of floor in a ~19,500 m² dungeon) fell under the 4 %
// storey threshold, so the entrance never appeared among a character's explored storeys. Exploration stays private
// (one controller per character) and storeys nobody has walked stay hidden. Skips without the local game data.
import test from 'node:test';
import assert from 'node:assert/strict';

import { localArena2 } from './support/rpg-session.mjs';
import { createWorldSource } from '../server/rpg/interiors/data.js';
import { worldFromTown } from '../client/gameplay/collision/world.js';
import { buildAutomap, floorIndexFor, EYE_HEIGHT } from '../client/gameplay/automap/model.js';
import { createAutomapController } from '../client/gameplay/automap/controller.js';
import { packCells, revealAround, REVEAL_RADIUS } from '../client/gameplay/automap/memory.js';

const ARENA2 = localArena2();
const DUNGEON = "dungeon:Daggerfall/Privateer's Hold";
const HOLD = "town:Daggerfall/Privateer's Hold";

test("[asset] Privateer's Hold: the entrance and new-character start storeys are listed once explored; other storeys stay private and hidden", {
  skip: ARENA2 ? false : 'local Daggerfall data not present', timeout: 300_000,
}, async () => {
  const source = createWorldSource(ARENA2);
  const scene = await source.scene(DUNGEON);
  const world = worldFromTown(scene);
  const map = buildAutomap(scene, { kind: 'dungeon' });
  const spawn = scene.spawn;
  const entranceY = world.standHeight(spawn.x, spawn.z);
  assert.ok(Number.isFinite(entranceY), 'the entrance has ground under it');

  // The plan itself now has a storey at the entrance level.
  const entrance = map.floors[floorIndexFor(map.floors, entranceY)];
  assert.ok(entrance && Math.abs(entrance.y - entranceY) <= 1, `a storey at the entrance (feet ${entranceY.toFixed(2)}; storeys ${map.floors.map((f) => f.y).join(', ')})`);
  assert.ok(map.floors.length >= 3, 'the Hold has several storeys');

  // Ground the server would reveal (same reveal rule, same line of sight) for a character standing at (x, z, y).
  const sight = (y) => (x, z, cx, cz) => world.canSee(x, z, cx, cz, { y1: y, y2: y });
  const revealAt = (p) => revealAround(p.x, p.z, p.y, sight(p.y), REVEAL_RADIUS);
  const character = (cells, at) => {
    const ctl = createAutomapController();
    ctl.setLocation(DUNGEON);
    ctl.setScene(scene);
    ctl.ensureMap(); // the panel builds the plan lazily when drawn
    ctl.applyExplored({ location: DUNGEON, cells: packCells(cells), full: true });
    ctl.setCamera({ x: at.x, y: at.y + EYE_HEIGHT, z: at.z, yaw: 0 });
    return ctl;
  };
  const near = (list, y) => list.some((f) => Math.abs(f.y - y) <= 1);

  // A character who has only stood in the entrance hall: exactly the entrance storey, named as ground.
  const start = { x: spawn.x, z: spawn.z, y: entranceY };
  const ava = character(revealAt(start), start);
  assert.equal(ava.floors.length, 1, `only the explored storey is listed (got ${ava.floors.map((f) => f.y)})`);
  assert.ok(Math.abs(ava.floors[0].y - entrance.y) < 1e-9, 'it is the entrance storey');
  assert.equal(ava.playerFloor(), 0, 'the player is placed on it');
  for (const f of map.floors) if (f !== entrance) assert.ok(!near(ava.floors, f.y), `unexplored storey ${f.y} hidden`);

  assert.equal(ava.floorSelector(), true, 'the storey selector is offered with the explored entrance storey');
  assert.equal(ava.floorText(), 'Ground level (1 of 1 explored)');

  // On foot the entrance level is closed off by the Hold's doors, so take the deeper storey a character reaches
  // later: a real standable spot on another detected storey (walkable floor, clear headroom, in collision).
  const P = scene.positions;
  let other = null;
  for (let o = 0; o < P.length && !other; o += 9) {
    const x = (P[o] + P[o + 3] + P[o + 6]) / 3, y = (P[o + 1] + P[o + 4] + P[o + 7]) / 3, z = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    const f = map.floors[floorIndexFor(map.floors, y)];
    if (!f || f === entrance || Math.abs(f.y - y) > 0.25 || Math.abs(f.y - entrance.y) < 3) continue;
    const h = world.standHeight(x, z);
    if (Math.abs(h - y) < 0.1 && world.isClear(x, z, y)) other = { at: { x, z, y }, floor: f };
  }
  assert.ok(other, 'another storey has standable floor');
  const walked = new Set([...revealAt(start), ...revealAt(other.at)]);

  const avaLater = character(walked, other.at);
  assert.ok(near(avaLater.floors, entrance.y), 'the entrance storey is still listed after leaving it');
  assert.ok(near(avaLater.floors, other.floor.y), `the newly reached storey ${other.floor.y} is listed`);
  assert.ok(avaLater.floors.length >= 2 && avaLater.floors.length < map.floors.length, 'the selector lists explored storeys only');
  const ground = avaLater.floors.findIndex((f) => Math.abs(f.y - entrance.y) < 1e-9);
  avaLater.selectFloor(ground);
  assert.match(avaLater.floorText(), /^Ground level \(/, 'the entrance storey is the ground level');
  avaLater.selectFloor(null);
  assert.match(avaLater.floorText(), other.floor.y < entrance.y ? /^Lower level / : /^Upper level /);
  const deepest = map.floors.find((f) => !near(avaLater.floors, f.y));
  assert.ok(deepest, 'at least one storey of the Hold remains unexplored');

  // A new character starts at the Hold's authored start marker on its bottom level (server/rpg/campaign/opening.js),
  // whose ~380 m² floor is below the plan's area rule. The level they walk is still listed, named below the entrance.
  const spec = (await source.townPortals(HOLD)).find((sp) => sp.to === DUNGEON);
  const mark = spec?.meta?.newCharacterStart;
  assert.ok(mark, 'the installed Hold has a new-character start marker');
  const startY = world.heightAt(mark.x, mark.z, mark.y);
  assert.ok(Number.isFinite(startY) && entranceY - startY > 10, `the start level (${startY}) lies far below the entrance`);
  const newcomerAt = { x: mark.x, z: mark.z, y: startY };
  const newcomer = character(revealAt(newcomerAt), newcomerAt);
  assert.equal(newcomer.floors.length, 1, `exactly the start level is listed (got ${newcomer.floors.map((f) => f.y)})`);
  assert.ok(Math.abs(newcomer.floors[0].y - startY) <= 1, 'it is the level the newcomer stands on');
  assert.equal(newcomer.playerFloor(), 0);
  assert.equal(newcomer.floorSelector(), true);
  assert.equal(newcomer.floorText(), 'Lower level 1 (1 of 1 explored)', 'below the entrance, without counting unseen levels');
  assert.ok(!near(newcomer.floors, entrance.y), 'the entrance level stays hidden until reached');
  const seenOnce = character(new Set([...revealAround(mark.x, mark.z, startY, () => false)]), newcomerAt);
  assert.equal(seenOnce.floors.length, 0, 'a glimpse of 9 cells does not make a storey the plan does not have');

  // Bram has only seen the entrance: Ava's second storey never shows on his map.
  const bram = character(revealAt(start), start);
  assert.equal(bram.floors.length, 1);
  assert.ok(!near(bram.floors, other.floor.y), "another character's storey is not listed");
});
