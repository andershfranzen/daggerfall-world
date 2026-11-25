import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameplayApi } from '../client/gameplay/api.js';
import { install } from '../client/gameplay/arrows.js';
import { transformPoint } from '../client/lib/mat.js';

const location = "dungeon:Daggerfall/Privateer's Hold";
const launch = {
  kind: 'arrowLaunch', location, projectileId: 1, playerId: 3,
  x: 4, y: 13, z: -6, dx: 0.6, dy: 0.8, dz: 0, speed: 35, range: 14,
};
const impact = {
  kind: 'arrowImpact', location, projectileId: 1, x: 6.1, y: 15.8, z: -6, reason: 'wall',
};

async function fixture() {
  const api = createGameplayApi();
  api.location = location;
  api.screen = 'game';
  const model = {};
  let time = 0, pass, drawn;
  const renderer = {
    retain(mesh) { assert.equal(mesh, model); },
    addPass(fn) { pass = fn; },
    drawModels(mesh, transforms) { assert.equal(mesh, model); drawn = transforms.map(m => [...m]); },
  };
  install(api, { load: async () => model, now: () => time });
  api.emit('assets', ['fake ARENA2']);
  await Promise.resolve();
  api.emit('frame', { renderer });
  return { api, event: ev => api.emit('event', ev), at(t) { time = t; drawn = []; pass(); return drawn; } };
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `expected ${a} near ${b}`);

test('buffers an early impact, interpolates the oriented arrow, and retires at the wall', async () => {
  const f = await fixture();
  f.event(launch);
  assert.deepEqual(f.at(0.04), []);
  f.event(impact);
  const [m] = f.at(0.17);
  near(m[12], 5.05);
  near(m[13], 14.4);
  near(m[14], -6);
  const tip = transformPoint(m, 0, 0, 0);
  const tail = transformPoint(m, 0, 0, 1);
  near(tip[0] - tail[0], launch.dx);
  near(tip[1] - tail[1], launch.dy);
  const [landed] = f.at(0.24);
  near(landed[12], impact.x);
  near(landed[13], impact.y);
  assert.deepEqual(f.at(0.49), []);
  f.event(impact);
  assert.deepEqual(f.at(0.5), [], 'an impact without its launch cannot recreate an arrow');
});

test('a late frame can present contact once, while stale arrivals expire', async () => {
  const f = await fixture();
  const target = { ...impact, reason: 'target' };
  f.event(launch);
  f.event(target);
  const [landed] = f.at(0.41);
  near(landed[12], impact.x);
  assert.deepEqual(f.at(0.58), []);
  f.event(launch);
  f.event(target);
  assert.deepEqual(f.at(1.11), [], 'a frame after the contact grace period cannot revive the arrow');
});

test('accepts enemy launches, clips unconfirmed flight at geometry, and clears on range and lifecycle events', async () => {
  const f = await fixture();
  const { playerId, ...trajectory } = launch;
  const enemy = { ...trajectory, projectileId: 2, entityId: 'archer' };
  f.api.canSee = (_x, _z, x) => x < 7;
  f.event({ ...enemy, location: 'dungeon:other' });
  assert.deepEqual(f.at(0.18), []);
  f.event(enemy);
  assert.equal(f.at(0.37).length, 1);
  assert.deepEqual(f.at(0.48), [], 'prediction cannot emerge on the far side of a wall');
  f.api.canSee = () => true;
  assert.deepEqual(f.at(0.71), [], 'range fallback retires a launch without an accessible impact');
  f.event(enemy);
  assert.equal(f.at(0.89).length, 1);
  f.event({ ...impact, projectileId: 2, reason: 'cancelled' });
  assert.deepEqual(f.at(0.93), []);
  let time = 0.93;
  for (const [name, value] of [['location', { location }], ['connection', 'lost'], ['screen', 'landing']]) {
    f.event(enemy);
    assert.equal(f.at(time + 0.14).length, 1);
    f.api.emit(name, value);
    time += 0.15;
    assert.deepEqual(f.at(time), []);
  }
});
