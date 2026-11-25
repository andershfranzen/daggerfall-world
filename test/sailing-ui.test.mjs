// Sailing controls' pure model and key map (client/gameplay/sailing/model.js, input.js), read against the shapes
// server/rpg/sailing.js (stateEvent / ashoreEvent) and server/rpg/naval.js (naval.state v1) actually send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readSailing, readNaval, readyIn, contextActions, facingSide, pointOfSail, degrees, cardinal, knots, encounterTarget,
  groupOf, stepOf, SAIL_STEPS, OAR_STEPS, bearingTo, seaLook,
} from '../client/gameplay/sailing/model.js';
import { helmCommand, rudderFrom } from '../client/gameplay/sailing/input.js';

const ports = [{ id: 'town:17/5', name: 'Wayrest', region: 'Wayrest', x: 0, z: 0, yaw: 0, distance: 40 }, { id: 'town:17/9', name: 'Gaerhall', region: 'Wayrest', x: 3000, z: -4000, distance: 5000 }];
const vesselView = (over = {}) => ({
  id: 'v7', ownerId: 7, ownerName: 'Ana', type: 'small', name: "Ana's ship", x: 0, z: 0, yaw: 0, speed: 0,
  anchored: true, grounded: false, docked: 'town:17/5', sunk: false, sails: 0, oars: 0, rudder: 0, helmId: null, helmName: null,
  crew: [{ id: 7, name: 'Ana' }], hull: { hp: 100, max: 120 }, length: 50, deck: 'town:31/1', naval: {}, ...over,
});
const aboardEv = (over = {}, v = {}) => ({ kind: 'sailing.state', silent: true, full: true, at: 1, role: 'captain', helm: false, vessel: vesselView(v), wind: { from: 1, speed: 6 }, nearby: [], ports, dockRange: 150, ...over });

test('ashore: board and cast off at the quay where the ship lies, buy at the bank otherwise', () => {
  const here = readSailing({ kind: 'sailing.state', vessel: null, role: null, own: null, ownsShip: true, port: { id: 'town:17/5', name: 'Wayrest' }, ports: [] });
  assert.deepEqual(contextActions(here, null).map((a) => a.id), ['board', 'launch', 'shipyard']);
  const elsewhere = readSailing({ kind: 'sailing.state', vessel: null, own: { id: 'v7', name: 'Gull', docked: 'town:17/9' }, ownsShip: true, port: { id: 'town:17/5', name: 'Wayrest' }, ports });
  assert.deepEqual(contextActions(elsewhere, null).map((a) => a.id), ['shipyard']);
  const none = readSailing({ kind: 'sailing.state', vessel: null, ownsShip: false, port: { id: 'town:17/5', name: 'Wayrest' } });
  assert.deepEqual(contextActions(none, null).map((a) => a.id), ['buy', 'shipyard']);
  assert.deepEqual(contextActions(readSailing({ kind: 'sailing.state', vessel: null, port: null }), null), []);
});

test('aboard, docked: captain takes helm, casts off, goes ashore from the deck only', () => {
  const s = readSailing(aboardEv(), { location: 'town:31/1' });
  assert.equal(s.vessel.sails, 0);
  assert.deepEqual(s.vessel.hull, [100, 120]);
  assert.equal(s.spot, 'deck');
  assert.deepEqual(contextActions(s, null).map((a) => a.id), ['helm', 'castoff', 'ship', 'hold', 'ashore', 'shipyard']);
  const below = readSailing(aboardEv(), { location: 'interior:ship-cabin' });
  assert.equal(below.spot, 'below');
  assert.ok(!contextActions(below, null).some((a) => a.id === 'ashore'));
});

test('at the helm under way: anchor, and make fast only within the dock range', () => {
  const far = readSailing(aboardEv({ role: 'captain', helm: true, ports: [{ ...ports[0], distance: 400 }] }, { docked: null, anchored: false, helmId: 7 }));
  const ids = contextActions(far, null).map((a) => a.id);
  assert.deepEqual(ids, ['helm', 'anchor', 'ship']);
  assert.equal(contextActions(far, null)[0].args.take, false);
  const near = readSailing(aboardEv({ helm: true }, { docked: null, anchored: false, helmId: 7 }));
  assert.ok(contextActions(near, null).some((a) => a.verb === 'sailing.dock'));
  const pass = readSailing(aboardEv({ role: 'passenger', helm: false }, { docked: null, helmId: 7 }));
  assert.deepEqual(contextActions(pass, null).map((a) => a.id), ['ship']);
});

test('numeric canvas and oars step within what sailing.control accepts', () => {
  assert.equal(stepOf(0, 1, SAIL_STEPS), 0.5);
  assert.equal(stepOf(1, 1, SAIL_STEPS), null);
  assert.equal(stepOf(0, -1, OAR_STEPS), -1);
  assert.equal(stepOf(null, 1, OAR_STEPS), 1);
});

test('naval v1: ready counts down, grapple only when struck and close, plunder once', () => {
  const ev = {
    kind: 'naval.state', t: 10,
    self: { id: 'v7', hullHp: 90, maxHull: 100, sailHp: 40, maxSail: 50, crew: 7, maxCrew: 8, ready: { port: 0, starboard: 4, bow: 2 }, loads: { broadside: 'chain' }, ammo: { shot: 20, barrels: 2 }, guns: { port: { gun: 'long', count: 6, range: 400 }, starboard: { gun: 'long', count: 6, range: 400 }, bow: { gun: 'swivel', count: 1, range: 150 } }, safeHarbour: false, colours: 'hostile', x: 0, z: 0 },
    contacts: [{ id: 'npc:1', title: 'Red Wake', faction: 'pirate', x: 20, z: 0, hullHp: 10, maxHull: 100, sailHp: 1, maxSail: 50, crew: 3, maxCrew: 20, state: 'struck' }],
  };
  const n = readNaval(ev, 1000);
  assert.equal(readyIn(n, 'starboard', 2000), 3);
  assert.equal(readyIn(n, 'port', 5000), 0);
  assert.equal(readyIn(n, 'stern', 2000), null);
  assert.equal(groupOf('starboard'), 'broadside');
  assert.deepEqual(n.ammo, { shot: 20, barrels: 2 });
  assert.equal(n.guns.bow.gun, 'swivel');
  const s = readSailing(aboardEv({}, { docked: null }), { location: 'town:31/1' });
  const t = encounterTarget(s, n);
  assert.equal(t.name, 'Red Wake');
  assert.deepEqual(t.hull, [10, 100]);
  assert.ok(contextActions(s, n).some((a) => a.verb === 'naval.grapple' && a.args.targetId === 'npc:1'));
  const far = readNaval({ ...ev, contacts: [{ ...ev.contacts[0], x: 100 }] }, 0); // 100 m centre to centre is well past 32 m of water
  assert.ok(!contextActions(s, far).some((a) => a.verb === 'naval.grapple'));
  const prize = readNaval({ ...ev, self: { ...ev.self, boarding: { targetId: 'npc:1', phase: 'prize' } } }, 0);
  assert.ok(contextActions(s, prize).some((a) => a.verb === 'naval.plunder'));
  const done = readNaval({ ...ev, self: { ...ev.self, boarding: { targetId: 'npc:1', phase: 'prize' } }, contacts: [{ ...ev.contacts[0], plundered: true }] }, 0);
  assert.ok(!contextActions(s, done).some((a) => a.verb === 'naval.plunder'));
  // a sunk player ship's wreck, from naval.news, is offered while the browser holds it
  assert.ok(contextActions(s, n, { wrecks: [{ id: 'v9', name: 'Black Gull' }] }).some((a) => a.verb === 'naval.plunder' && a.args.targetId === 'v9'));
  // a surrendered player alongside is a prize without boarding
  const pvp = readNaval({ ...ev, self: { ...ev.self, grappledTo: 'v9' }, contacts: [{ id: 'v9', kind: 'player', title: 'Black Gull', x: 20, z: 0, state: 'struck', colours: 'struck', grappledTo: 'v7' }] }, 0);
  const acts = contextActions(s, pvp).map((a) => a.id);
  assert.ok(acts.includes('plunder') && !acts.includes('boardFoe'));
});

test('bearings: compass convention, deck frame turned to the sea', () => {
  assert.equal(facingSide(Math.PI / 2, 0), 'starboard');
  assert.equal(facingSide(-Math.PI / 2, 0), 'port');
  assert.equal(facingSide(0.1, 0), 'bow');
  assert.equal(facingSide(Math.PI, 0), 'stern');
  // small ship: bow along +x in her deck frame (π/2). Looking along +x on deck is looking where she heads.
  assert.ok(Math.abs(seaLook(Math.PI / 2, { heading: 1, deckBow: Math.PI / 2 }) - 1) < 1e-9);
  assert.equal(degrees(Math.PI / 2), 90);
  assert.equal(cardinal(Math.PI), 'S');
  assert.equal(knots(1), 1.9);
  assert.equal(degrees(bearingTo({ x: 0, z: 0 }, { x: 0, z: -10 })), 0);
  assert.equal(degrees(bearingTo({ x: 0, z: 0 }, { x: 10, z: 0 })), 90);
  assert.equal(pointOfSail(0, Math.PI / 2), 'Beam reach');
});

test('helm keys: rudder holds, the rest map to commands', () => {
  assert.equal(helmCommand('KeyA'), 'rudderPort');
  assert.equal(helmCommand('KeyY'), 'dock');
  assert.equal(helmCommand('KeyG'), null);
  assert.equal(rudderFrom(new Set(['KeyA'])), -1);
  assert.equal(rudderFrom(new Set(['KeyA', 'ArrowRight'])), 0);
  assert.equal(rudderFrom(new Set(['KeyD'])), 1);
});

test('plotted course: read as sent, clear offered to the helm, laying needs the anchor up', async () => {
  const { canSetCourse } = await import('../client/gameplay/sailing/model.js');
  const s = readSailing(aboardEv({ helm: true }, { docked: null, anchored: false, helmId: 7, course: { to: 'town:17/9', name: 'Gaerhall', routed: false, points: [{ x: 10, z: -10 }] } }));
  assert.equal(s.vessel.course.name, 'Gaerhall');
  assert.equal(s.vessel.course.routed, false);
  assert.ok(contextActions(s, null).some((a) => a.verb === 'sailing.course' && a.args.portId === null));
  assert.equal(canSetCourse(s), true);
  assert.equal(canSetCourse(readSailing(aboardEv({ helm: true }, { docked: null, anchored: true, helmId: 7 }))), false);
  assert.equal(canSetCourse(readSailing(aboardEv({ helm: false }, { docked: null, anchored: false }))), false);
});
