// Unit tests for classic Daggerfall player figures on remote ship decks
// (client/gameplay/sailing/deckPeers.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAW_RANGE,
  DEFAULT_DECK_Y,
  isDollFacing,
  shouldDrawCubeAvatarOnDeck,
  projectContactCrewBillboards,
  createDeckPeerPass,
} from '../client/gameplay/sailing/deckPeers.js';
import * as R from '../client/gameplay/sailing/renderMath.js';

function makeSpriteEntry(archive, { recordCount = 25, frameCount = 4, width = 1.0, height = 1.85 } = {}) {
  const records = Array.from({ length: recordCount }, () => ({
    width: 40,
    height: 74,
    frameCount,
    world: { width, height },
  }));
  const rects = Array.from({ length: recordCount }, () =>
    Array.from({ length: frameCount }, (_, f) => ({ x: f * 41, y: 0, w: 40, h: 74 })),
  );
  return {
    archive,
    sprite: { archive, recordCount, records },
    atlas: { width: 256, height: 256, pixels: new Uint8Array(256 * 256 * 4), rects },
  };
}

function makeDollEntry(key, { width = 1.08, height = 1.9 } = {}) {
  return {
    archive: `doll:${key}`,
    world: { width, height },
    atlas: {
      width: 128,
      height: 128,
      pixels: new Uint8Array(128 * 128 * 4),
      rects: [[{ x: 0, y: 0, w: 64, h: 112 }]],
    },
  };
}

function makeSpriteLibrary(archives = [488, 487, 486, 485, 385, 386, 391, 394, 453, 454, 455, 456, 380, 264]) {
  const map = new Map(archives.map((a) => [a, makeSpriteEntry(a)]));
  const requested = [];
  return {
    requested,
    get(archive) {
      requested.push(archive);
      return map.get(archive) ?? null;
    },
  };
}

function makeDollLibrary(byPeerId = {}) {
  const requested = [];
  return {
    requested,
    get(peer) {
      requested.push(peer?.id ?? null);
      return byPeerId[String(peer?.id)] ?? null;
    },
  };
}

describe('shouldDrawCubeAvatarOnDeck', () => {
  test('suppresses cube avatars whenever hasSprite or arena2Loaded is true', () => {
    assert.equal(shouldDrawCubeAvatarOnDeck({ hasSprite: true, arena2Loaded: false }), false);
    assert.equal(shouldDrawCubeAvatarOnDeck({ hasSprite: false, arena2Loaded: true }), false);
    assert.equal(shouldDrawCubeAvatarOnDeck({ hasSprite: true, arena2Loaded: true }), false);
  });

  test('only allows cube fallback when neither sprite nor ARENA2 is loaded', () => {
    assert.equal(shouldDrawCubeAvatarOnDeck({ hasSprite: false, arena2Loaded: false }), true);
    assert.equal(shouldDrawCubeAvatarOnDeck(), true);
  });
});

describe('projectContactCrewBillboards: world-space deck projection', () => {
  test('projects captain and crew onto a moving, rotated, pitching/heeling ship deck', () => {
    const spriteLibrary = makeSpriteLibrary();
    const dollLibrary = makeDollLibrary({
      'cap-1': makeDollEntry('cap-1'),
      'crew-1': makeDollEntry('crew-1'),
    });
    const peerStateById = new Map([
      ['cap-1', { id: 'cap-1', name: 'Capt. Barenziah', race: 'breton', gender: 'female', className: 'Knight', readied: true }],
      ['crew-1', { id: 'crew-1', name: 'Bosun Gothryd', race: 'nord', gender: 'male', className: 'Warrior', readied: true }],
    ]);

    // Ship at (40, 0, -20), heading east (+x, yaw = PI/2), pitching bow up (+0.15 rad),
    // heeling starboard down (+0.1 rad), heave +0.8m, deckY = 6.5m.
    const shipYaw = Math.PI / 2;
    const pitch = 0.15;
    const heel = 0.1;
    const heave = 0.8;
    const deckY = 6.5;

    const contact = {
      id: 'ship-red-galleon',
      x: 40,
      z: -20,
      yaw: shipYaw,
      pitch,
      heel,
      heave,
      deckY,
      captain: { id: 'cap-1', x: 0, z: -6, yaw: 0 },        // forward near bow, facing bow (east)
      crew: [
        { id: 'crew-1', x: 3, z: 4, yaw: Math.PI / 2, moving: true }, // starboard aft
      ],
    };

    // Camera east of the ship looking west toward the bow.
    const camera = { x: 80, y: 8, z: -20, yaw: -Math.PI / 2 };
    const items = projectContactCrewBillboards({
      contacts: [contact],
      camera,
      now: 1.5,
      spriteLibrary,
      dollLibrary,
      peerStateById,
    });

    assert.equal(items.length, 2);
    const expectedMat = R.shipToRel(40, -20, { yaw: shipYaw, pitch, heel, heave });
    const [capX, capY, capZ] = R.apply(expectedMat, 0, deckY, -6);
    const [crewX, crewY, crewZ] = R.apply(expectedMat, 3, deckY, 4);

    const cap = items.find((i) => i.id === 'cap-1');
    const crew = items.find((i) => i.id === 'crew-1');
    assert.ok(cap && crew);

    assert.equal(cap.role, 'captain');
    assert.ok(Math.abs(cap.x - capX) < 1e-6);
    assert.ok(Math.abs(cap.y - capY) < 1e-6);
    assert.ok(Math.abs(cap.z - capZ) < 1e-6);
    // Bow-up pitch raises the bow captain above flat deckY + heave.
    assert.ok(cap.y > deckY + heave);

    assert.equal(crew.role, 'crew');
    assert.ok(Math.abs(crew.x - crewX) < 1e-6);
    assert.ok(Math.abs(crew.y - crewY) < 1e-6);
    assert.ok(Math.abs(crew.z - crewZ) < 1e-6);
    // Starboard-down heel + aft position lowers crew below the bow captain.
    assert.ok(crew.y < cap.y);
  });

  test('uses explicit contact matrix when provided by sailing/render.js', () => {
    const spriteLibrary = makeSpriteLibrary();
    const m = R.chain(R.tr(15, 1.2, -30), R.yawMatrix(Math.PI));
    const contact = {
      id: 'ship-mat',
      matrix: m,
      deckY: 5,
      crew: [{ id: 'sailor-a', x: 2, z: -4, yaw: 0 }],
    };
    const items = projectContactCrewBillboards({
      contacts: [contact],
      camera: { x: 0, y: 6, z: 0, yaw: 0 },
      now: 0.5,
      spriteLibrary,
    });

    assert.equal(items.length, 1);
    const [ex, ey, ez] = R.apply(m, 2, 5, -4);
    assert.ok(Math.abs(items[0].x - ex) < 1e-6);
    assert.ok(Math.abs(items[0].y - ey) < 1e-6);
    assert.ok(Math.abs(items[0].z - ez) < 1e-6);
  });

  test('deduplicates captain if also listed in crew array and defaults deckY cleanly', () => {
    const spriteLibrary = makeSpriteLibrary();
    const contact = {
      id: 'ship-dup',
      x: 0,
      z: -25,
      yaw: 0,
      captain: { id: 'p-1', x: 0, z: 0, yaw: Math.PI },
      crew: [{ id: 'p-1', x: 0, z: 0, yaw: Math.PI }],
    };
    const items = projectContactCrewBillboards({
      contacts: [contact],
      camera: { x: 0, y: 6, z: 0, yaw: 0 },
      now: 0,
      spriteLibrary,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].y, DEFAULT_DECK_Y);
    assert.equal(items[0].role, 'captain');
  });
});

describe('projectContactCrewBillboards: doll vs 8-direction sprite selection', () => {
  test('uses equipped-gear doll for front and 3/4 facing sailors when doll is ready', () => {
    const spriteLibrary = makeSpriteLibrary();
    const dollEntry = makeDollEntry('hero-front');
    const dollLibrary = makeDollLibrary({ 'hero-front': dollEntry });

    // Camera at origin (0, 6, 0). Ship at (0, 0, -20) with yaw = 0.
    // Sailor yaw = PI faces +z (straight toward camera -> facing 0).
    // Sailor yaw = PI + PI/4 faces front-left 3/4 (facing 1 or 7).
    for (const localYaw of [Math.PI, Math.PI + Math.PI / 4, Math.PI - Math.PI / 4]) {
      const items = projectContactCrewBillboards({
        contacts: [{
          id: 's1', x: 0, z: -20, yaw: 0, deckY: 6,
          captain: { id: 'hero-front', x: 0, z: 0, yaw: localYaw, className: 'Knight', readied: true },
        }],
        camera: { x: 0, y: 6, z: 0, yaw: 0 },
        now: 1,
        spriteLibrary,
        dollLibrary,
      });
      assert.equal(items.length, 1);
      assert.equal(isDollFacing(items[0].facing), true);
      assert.equal(items[0].source, 'doll');
      assert.equal(items[0].entry, dollEntry);
      assert.equal(items[0].tint, null);
    }
  });

  test('falls back to classic 8-direction TEXTURE sprite for rear-facing and profile sailors', () => {
    const spriteLibrary = makeSpriteLibrary();
    const dollLibrary = makeDollLibrary({
      'hero-back': makeDollEntry('hero-back'),
    });

    // Sailor at (0, 6, -20) facing -z (yaw = 0, away from camera at origin -> facing 4).
    const items = projectContactCrewBillboards({
      contacts: [{
        id: 's2', x: 0, z: -20, yaw: 0, deckY: 6,
        captain: {
          id: 'hero-back', x: 0, z: 0, yaw: 0,
          gender: 'male', className: 'Warrior', readied: true, armorTier: 'daedric',
        },
      }],
      camera: { x: 0, y: 6, z: 0, yaw: 0 },
      now: 2,
      spriteLibrary,
      dollLibrary,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].facing, 4);
    assert.equal(items[0].source, 'sprite');
    assert.equal(items[0].entry.archive, 488); // Male Warrior TEXTURE.488
    assert.ok(Array.isArray(items[0].tint), 'daedric armor tint applied on 8-dir sprite');
    assert.equal(dollLibrary.requested.length, 0, 'does not query dollLibrary for rear-facing sailor');
  });

  test('falls back to classic 8-direction sprite when front-facing doll is still pending (null)', () => {
    const spriteLibrary = makeSpriteLibrary();
    const dollLibrary = makeDollLibrary({}); // returns null (loading/pending)

    const items = projectContactCrewBillboards({
      contacts: [{
        id: 's3', x: 0, z: -18, yaw: 0, deckY: 6,
        captain: { id: 'hero-pending', x: 0, z: 0, yaw: Math.PI, gender: 'female', className: 'Mage', readied: true },
      }],
      camera: { x: 0, y: 6, z: 0, yaw: 0 },
      now: 0.5,
      spriteLibrary,
      dollLibrary,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0].facing, 0);
    assert.equal(items[0].source, 'sprite');
    assert.equal(items[0].entry.archive, 485); // Female Mage TEXTURE.485
    assert.deepEqual(dollLibrary.requested, ['hero-pending']);
  });
});

describe('projectContactCrewBillboards: range culling', () => {
  test('culls sailors beyond DRAW_RANGE and keeps those within range', () => {
    const spriteLibrary = makeSpriteLibrary();
    const contacts = [
      { id: 'near', x: 0, z: -(DRAW_RANGE - 10), yaw: 0, deckY: 6, captain: { id: 'near-cap', x: 0, z: 0, yaw: Math.PI, readied: true } },
      { id: 'far', x: 0, z: -(DRAW_RANGE + 15), yaw: 0, deckY: 6, captain: { id: 'far-cap', x: 0, z: 0, yaw: Math.PI, readied: true } },
    ];
    const items = projectContactCrewBillboards({
      contacts,
      camera: { x: 0, y: 6, z: 0, yaw: 0 },
      now: 0,
      spriteLibrary,
    });

    assert.deepEqual(items.map((i) => i.id), ['near-cap']);
  });
});

describe('createDeckPeerPass controller', () => {
  test('exposes update, draw, drawnIds, and dispose wired to SpritePass', () => {
    const spriteLibrary = makeSpriteLibrary();
    const dollLibrary = makeDollLibrary({ 'cap-a': makeDollEntry('cap-a') });
    const drawCalls = [];
    const mockPass = {
      textures: new Map([['dummy', {}]]),
      draw(gl, renderer, camera, items) {
        drawCalls.push({ gl, renderer, camera, items: [...items] });
      },
    };

    const controller = createDeckPeerPass({ spriteLibrary, dollLibrary, pass: mockPass });
    const camera = { x: 0, y: 6, z: 0, yaw: 0 };
    const contacts = new Map([
      ['ship-1', {
        id: 'ship-1', x: 0, z: -25, yaw: 0, deckY: 6,
        captain: { id: 'cap-a', x: 0, z: 0, yaw: Math.PI, readied: true },
        crew: [{ id: 'crew-b', x: 2, z: 1, yaw: 0, readied: true }],
      }],
    ]);

    const items = controller.update({ contacts, camera, now: 1.25 });
    assert.equal(items.length, 2);
    assert.deepEqual(controller.drawnIds().sort(), ['cap-a', 'crew-b']);
    assert.equal(controller.hasSprite('cap-a'), true);
    assert.equal(controller.hasSprite('missing'), false);

    const fakeGl = {};
    const fakeRenderer = {};
    controller.draw(fakeGl, fakeRenderer, camera);
    assert.equal(drawCalls.length, 1);
    assert.equal(drawCalls[0].items.length, 2);
    assert.equal(drawCalls[0].gl, fakeGl);

    controller.dispose();
    assert.deepEqual(controller.drawnIds(), []);
    assert.equal(mockPass.textures.size, 0);
    controller.draw(fakeGl, fakeRenderer, camera);
    assert.equal(drawCalls.length, 1, 'draw is a no-op after dispose');
  });
});
