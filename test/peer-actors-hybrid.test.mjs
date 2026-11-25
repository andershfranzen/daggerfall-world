// Hybrid authentic Daggerfall peer billboard selector (client/gameplay/actors/peerHybrid.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePeerBillboardItem,
  shouldSkipFallbackAvatar,
  matchHeight,
  DOLL_BOB_AMPLITUDE,
  DOLL_BOB_RATE,
  REAR_FACINGS,
  FRONT_FACINGS,
} from '../client/gameplay/actors/peerHybrid.js';
import { AnimState, facingIndex } from '../client/gameplay/actors/logic.js';
import { resolvePeerAppearance, peerFigureTint } from '../client/gameplay/actors/peerFigure.js';

/** Build a minimal SpriteLibrary-compatible entry with realistic world dimensions. */
function makeSpriteEntry(archive, { recordCount = 25, framesPerRecord = 5, width = 1.0, height = 1.65 } = {}) {
  const records = Array.from({ length: recordCount }, () => ({
    frameCount: framesPerRecord,
    world: { width, height },
  }));
  return {
    archive,
    sprite: {
      recordCount,
      records,
      frame: () => ({ width: 32, height: 64, data: new Uint8Array(32 * 64) }),
    },
    atlas: {
      width: 64,
      height: 64,
      pixels: new Uint8Array(64 * 64 * 4),
      rects: records.map((rec) =>
        Array.from({ length: rec.frameCount }, () => ({ x: 0, y: 0, w: 32, h: 64 })),
      ),
    },
  };
}

/** Build a PeerDollLibrary-compatible equipped-gear paper doll entry. */
function makeDollEntry(id = 'p1', { width = 0.92, height = 1.84 } = {}) {
  return {
    archive: `doll:${id}`,
    sprite: {
      recordCount: 1,
      records: [{ frameCount: 1, world: { width, height } }],
      frame: () => ({ width: 64, height: 128, data: new Uint8Array(64 * 128) }),
    },
    atlas: {
      width: 64,
      height: 128,
      pixels: new Uint8Array(64 * 128 * 4),
      rects: [[{ x: 0, y: 0, w: 64, h: 128 }]],
    },
  };
}

/**
 * Place a camera at distance 10 around an actor at (0, 0) with yaw = 0 (facing -z)
 * such that facingIndex(0, 0, 0, camera.x, camera.z) === desiredFacing.
 *
 * facingIndex math: a = atan2(cx, -cz), i = round(-a / (2π/8)) mod 8
 * => a = -facing * π/4 => cx = 10 * sin(a), cz = -10 * cos(a).
 */
function cameraForFacing(facing, dist = 10) {
  const a = -facing * (Math.PI / 4);
  return {
    x: dist * Math.sin(a),
    y: 1.6,
    z: -dist * Math.cos(a),
    yaw: 0,
  };
}

function makeLibraries({ sprites = {}, doll = null } = {}) {
  const spriteMap = new Map(Object.entries(sprites).map(([k, v]) => [Number(k), v]));
  const spriteLibrary = {
    get: (archive) => spriteMap.get(archive) ?? null,
  };
  const dollLibrary = {
    get: (peer) => (typeof doll === 'function' ? doll(peer) : doll),
  };
  return { spriteLibrary, dollLibrary };
}

function makePeerView(peer, { animState = 'idle', now = 1.0, footY = 0.5, x = 0, z = 0, yaw = 0 } = {}) {
  const anim = new AnimState();
  const moving = animState === 'move';
  const dead = animState === 'corpse' || peer.defeated === true;
  anim.observe({ moving, dead, animation: peer.animation ?? null }, 0);
  if (animState === 'attack' || animState === 'ranged' || animState === 'hurt') {
    anim.trigger(animState, now - 0.15);
    if (animState === 'hurt') anim.hurtAt = now - 0.1;
  }
  const app = resolvePeerAppearance(peer);
  return {
    key: `p:${peer.id}`,
    id: peer.id,
    source: 'peer',
    data: peer,
    app,
    anim,
    x,
    z,
    yaw,
    footY,
    speed: moving ? 3.5 : 0,
    lootFlashAt: -Infinity,
  };
}

describe('peerHybrid: facing camera helper sanity', () => {
  test('cameraForFacing produces exact facing indices 0..7', () => {
    for (let f = 0; f < 8; f++) {
      const cam = cameraForFacing(f);
      assert.equal(facingIndex(0, 0, 0, cam.x, cam.z), f);
    }
  });
});

describe('peerHybrid: all 8 facings across hybrid, doll, and classic8dir modes', () => {
  const peer = {
    id: 'knight-1',
    name: 'Gothryd',
    race: 'Breton',
    gender: 'male',
    className: 'Knight',
    readied: true,
    armorTier: 'daedric',
    primaryDye: 'red',
  };
  const dollHeight = 1.84;
  const dollEntry = makeDollEntry(peer.id, { width: 0.92, height: dollHeight });
  const spriteEntry = makeSpriteEntry(488, { recordCount: 25, width: 1.0, height: 1.60 });
  const { spriteLibrary, dollLibrary } = makeLibraries({
    sprites: { 488: spriteEntry },
    doll: dollEntry,
  });
  const expectedTint = peerFigureTint(peer);

  test('hybrid mode: front/side (0,1,2,6,7) uses equipped-gear doll; rear (3,4,5) uses height-matched 8-dir sprite with tint', () => {
    const view = makePeerView(peer, { animState: 'idle', now: 1.0, footY: 2.0 });
    for (let f = 0; f < 8; f++) {
      const cam = cameraForFacing(f);
      const item = resolvePeerBillboardItem({
        view,
        camera: cam,
        now: 1.0,
        spriteLibrary,
        dollLibrary,
        mode: 'hybrid',
      });
      assert.ok(item, `facing ${f} produced an item`);
      assert.equal(item.id, peer.id);
      assert.equal(item.key, `p:${peer.id}`);

      if (FRONT_FACINGS.has(f)) {
        assert.equal(item.source, 'doll', `facing ${f} should use doll`);
        assert.equal(item.entry, dollEntry);
        assert.equal(item.flip, f === 6 || f === 7, `facing ${f} mirror`);
        assert.equal(item.h, dollHeight, `facing ${f} doll height`);
        assert.equal(item.y, 2.0, `facing ${f} idle has zero bob`);
        assert.equal(item.tint, null, `facing ${f} doll should not double-tint`);
      } else {
        assert.ok(REAR_FACINGS.has(f));
        assert.equal(item.source, 'sprite', `facing ${f} should switch to 8-dir sprite`);
        assert.equal(item.entry, spriteEntry);
        assert.equal(item.h, dollHeight, `facing ${f} rear sprite height matches doll (zero size pop)`);
        assert.ok(Math.abs(item.w - (1.0 * (dollHeight / 1.60))) < 1e-9, `facing ${f} preserves aspect ratio`);
        assert.deepEqual(item.tint, expectedTint, `facing ${f} applies armor/dye tint`);
      }
    }
  });

  test('doll mode: always uses equipped-gear doll across all 8 facings', () => {
    const view = makePeerView(peer, { animState: 'idle', now: 1.0 });
    for (let f = 0; f < 8; f++) {
      const item = resolvePeerBillboardItem({
        view,
        camera: cameraForFacing(f),
        now: 1.0,
        spriteLibrary,
        dollLibrary,
        mode: 'doll',
      });
      assert.ok(item);
      assert.equal(item.source, 'doll', `doll mode facing ${f}`);
      assert.equal(item.entry, dollEntry);
      assert.equal(item.flip, f === 6 || f === 7);
    }
  });

  test('classic8dir mode: always uses classic 8-dir TEXTURE sprites with archetype & dye tinting', () => {
    let dollRequested = false;
    const trackingDollLib = {
      get: () => { dollRequested = true; return dollEntry; },
    };
    const view = makePeerView(peer, { animState: 'move', now: 1.0 });
    for (let f = 0; f < 8; f++) {
      const item = resolvePeerBillboardItem({
        view,
        camera: cameraForFacing(f),
        now: 1.0,
        spriteLibrary,
        dollLibrary: trackingDollLib,
        mode: 'classic8dir',
      });
      assert.ok(item);
      assert.equal(item.source, 'sprite', `classic8dir facing ${f}`);
      assert.equal(item.entry, spriteEntry);
      assert.equal(item.h, 1.60, 'classic8dir uses native sprite height');
      assert.deepEqual(item.tint, expectedTint);
    }
    assert.equal(dollRequested, false, 'classic8dir should not query dollLibrary');
  });
});

describe('peerHybrid: walk-cycle stride bob, idle, and hurt', () => {
  const peer = { id: 'walker-1', race: 'Breton', gender: 'female', className: 'Mage' };
  const dollEntry = makeDollEntry(peer.id, { width: 0.88, height: 1.78 });
  const { spriteLibrary, dollLibrary } = makeLibraries({
    sprites: { 453: makeSpriteEntry(453, { recordCount: 6 }) },
    doll: dollEntry,
  });

  test('front-facing moving doll applies stride bob Math.abs(Math.sin(walkPhase)) * 0.04; idle has zero bob', () => {
    const cam = cameraForFacing(0);
    const footY = 3.25;

    // Moving at t = 0.2s -> walkPhase = 0.2 * DOLL_BOB_RATE
    const movingView = makePeerView(peer, { animState: 'move', now: 0.2, footY });
    const movingItem = resolvePeerBillboardItem({
      view: movingView,
      camera: cam,
      now: 0.2,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    const expectedBob = Math.abs(Math.sin(0.2 * DOLL_BOB_RATE)) * DOLL_BOB_AMPLITUDE;
    assert.equal(movingItem.source, 'doll');
    assert.ok(expectedBob > 0 && expectedBob <= DOLL_BOB_AMPLITUDE);
    assert.ok(Math.abs(movingItem.y - (footY + expectedBob)) < 1e-9);

    // Explicit walkPhase override
    movingView.walkPhase = Math.PI / 2;
    const peakItem = resolvePeerBillboardItem({
      view: movingView,
      camera: cam,
      now: 0.2,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.ok(Math.abs(peakItem.y - (footY + DOLL_BOB_AMPLITUDE)) < 1e-9);

    // Idle -> zero bob
    const idleView = makePeerView(peer, { animState: 'idle', now: 0.2, footY });
    const idleItem = resolvePeerBillboardItem({
      view: idleView,
      camera: cam,
      now: 0.2,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(idleItem.source, 'doll');
    assert.equal(idleItem.y, footY);
  });

  test('front-facing hurt state keeps equipped-gear doll with hurt flash', () => {
    const view = makePeerView(peer, { animState: 'hurt', now: 1.0, footY: 1.0 });
    const item = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(0),
      now: 1.0,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(item.source, 'doll');
    assert.ok(item.hurt > 0 && item.hurt <= 1);
  });
});

describe('peerHybrid: combat swings, spell casts, beast forms, and corpses', () => {
  test('attack and ranged switch to classic 8-dir TEXTURE.475-490 swing/cast frames with tint & matched height', () => {
    const mage = {
      id: 'mage-1',
      race: 'High Elf',
      gender: 'female',
      className: 'Mage',
      wearingRobes: true,
      primaryDye: 'purple',
    };
    const dollEntry = makeDollEntry(mage.id, { width: 0.9, height: 1.86 });
    const mageSprite = makeSpriteEntry(485, { recordCount: 25, width: 1.0, height: 1.7 });
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 485: mageSprite },
      doll: dollEntry,
    });
    const cam = cameraForFacing(0); // front facing

    // Melee swing
    const attackView = makePeerView(mage, { animState: 'attack', now: 2.0 });
    const attackItem = resolvePeerBillboardItem({
      view: attackView,
      camera: cam,
      now: 2.0,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(attackItem.source, 'sprite');
    assert.equal(attackItem.entry, mageSprite);
    assert.equal(attackItem.record, 5, 'facing 0 attack record is 5');
    assert.equal(attackItem.h, 1.86, 'combat sprite height matches doll');
    assert.deepEqual(attackItem.tint, peerFigureTint(mage));

    // Spell cast (ranged)
    const castView = makePeerView(mage, { animState: 'ranged', now: 2.0 });
    const castItem = resolvePeerBillboardItem({
      view: castView,
      camera: cam,
      now: 2.0,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(castItem.source, 'sprite');
    assert.equal(castItem.entry, mageSprite);
    assert.equal(castItem.record, 20, 'facing 0 ranged/cast record is 20');
    assert.equal(castItem.h, 1.86);
    assert.deepEqual(castItem.tint, peerFigureTint(mage));
  });

  test('peaceful town-walker triggering attack upgrades to armed archetype archive (475-490)', () => {
    const townPeer = {
      id: 'town-warrior',
      race: 'Breton',
      gender: 'male',
      className: 'Warrior',
      variant: 0, // archive 385 (person layout) when unready
    };
    const dollEntry = makeDollEntry(townPeer.id, { width: 0.9, height: 1.8 });
    const personSprite = makeSpriteEntry(385, { recordCount: 6, width: 0.9, height: 1.7 });
    const warriorSprite = makeSpriteEntry(488, { recordCount: 25, width: 1.0, height: 1.75 });
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 385: personSprite, 488: warriorSprite },
      doll: dollEntry,
    });

    const view = makePeerView(townPeer, { animState: 'attack', now: 1.0 });
    assert.equal(view.app.layout, 'person');

    const item = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(0),
      now: 1.0,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(item.source, 'sprite');
    assert.equal(item.entry, warriorSprite, 'upgrades to TEXTURE.488 for swing frames');
    assert.equal(item.record, 5);
  });

  test('Werewolf (264) and Wereboar (269) always use beast 8-dir sprite in all modes', () => {
    const wolfEntry = makeSpriteEntry(264, { recordCount: 20, width: 1.2, height: 2.1 });
    const boarEntry = makeSpriteEntry(269, { recordCount: 20, width: 1.3, height: 2.0 });
    const dollEntry = makeDollEntry('beast-doll', { width: 0.9, height: 1.8 });
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 264: wolfEntry, 269: boarEntry },
      doll: dollEntry,
    });

    for (const [form, expectedEntry] of [['werewolf', wolfEntry], ['wereboar', boarEntry]]) {
      const peer = { id: `b-${form}`, form, armorTier: 'daedric', primaryDye: 'red' };
      const view = makePeerView(peer, { animState: 'move', now: 1.0 });
      for (const mode of ['hybrid', 'doll', 'classic8dir']) {
        const item = resolvePeerBillboardItem({
          view,
          camera: cameraForFacing(0),
          now: 1.0,
          spriteLibrary,
          dollLibrary,
          mode,
        });
        assert.equal(item.source, 'sprite', `${form} in ${mode} must be beast sprite`);
        assert.equal(item.entry, expectedEntry);
        assert.equal(item.tint, null, `${form} must not apply humanoid armor tint`);
        assert.equal(item.h, expectedEntry.sprite.records[0].world.height);
      }
    }
  });

  test('defeated peer always uses classic corpse sprite (never standing doll or upright sprite)', () => {
    const corpseEntry = makeSpriteEntry(380, { recordCount: 5, framesPerRecord: 1, width: 1.3, height: 0.5 });
    const knightEntry = makeSpriteEntry(488, { recordCount: 25 });
    const dollEntry = makeDollEntry('fallen', { width: 0.9, height: 1.84 });
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 380: corpseEntry, 488: knightEntry },
      doll: dollEntry,
    });

    const fallen = { id: 'fallen', className: 'Knight', readied: true, defeated: true };
    const view = makePeerView(fallen, { animState: 'idle', now: 5.0 });

    for (const mode of ['hybrid', 'doll', 'classic8dir']) {
      const item = resolvePeerBillboardItem({
        view,
        camera: cameraForFacing(0),
        now: 5.0,
        spriteLibrary,
        dollLibrary,
        mode,
      });
      assert.equal(item.source, 'corpse', `defeated peer in ${mode} must be corpse`);
      assert.equal(item.entry, corpseEntry);
      assert.equal(item.record, 1, 'humanoid corpse is TEXTURE.380 record 1');
      assert.equal(item.flip, false);
    }
  });
});

describe('peerHybrid: async fallback, target tint, matchHeight, and shouldSkipFallbackAvatar', () => {
  test('falls back to authentic 8-dir sprite while doll is compositing, and returns null if neither is ready', () => {
    const peer = { id: 'loading-1', className: 'Archer', readied: true, gender: 'male' };
    const archerEntry = makeSpriteEntry(482, { recordCount: 25, width: 1.0, height: 1.72 });
    const view = makePeerView(peer, { animState: 'idle', now: 1.0 });

    // Doll not ready yet, sprite ready -> uses classic 8-dir sprite
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 482: archerEntry },
      doll: null,
    });
    const fallbackItem = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(0),
      now: 1.0,
      spriteLibrary,
      dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(fallbackItem.source, 'sprite');
    assert.equal(fallbackItem.entry, archerEntry);

    // Neither ready -> returns null
    const emptyLibs = makeLibraries({ sprites: {}, doll: null });
    const noneItem = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(0),
      now: 1.0,
      spriteLibrary: emptyLibs.spriteLibrary,
      dollLibrary: emptyLibs.dollLibrary,
      mode: 'hybrid',
    });
    assert.equal(noneItem, null);
  });

  test('targetId applies highlight light boost and target tint', () => {
    const peer = { id: 'tgt-1', gender: 'male', className: 'Knight', readied: true, armorTier: 'elven' };
    const dollEntry = makeDollEntry(peer.id);
    const spriteEntry = makeSpriteEntry(488, { recordCount: 25 });
    const { spriteLibrary, dollLibrary } = makeLibraries({
      sprites: { 488: spriteEntry },
      doll: dollEntry,
    });
    const view = makePeerView(peer, { animState: 'idle', now: 1.0 });

    const frontTarget = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(0),
      now: 1.0,
      spriteLibrary,
      dollLibrary,
      targetId: 'tgt-1',
    });
    assert.equal(frontTarget.source, 'doll');
    assert.ok(frontTarget.light > 1.0);
    assert.deepEqual(frontTarget.tint, [0.94, 1.0, 1.08]);

    const rearTarget = resolvePeerBillboardItem({
      view,
      camera: cameraForFacing(4),
      now: 1.0,
      spriteLibrary,
      dollLibrary,
      targetId: 'tgt-1',
    });
    assert.equal(rearTarget.source, 'sprite');
    assert.ok(rearTarget.light > 1.0);
    assert.ok(Array.isArray(rearTarget.tint) && rearTarget.tint.length === 3);
  });

  test('matchHeight scales width proportionally to targetHeight', () => {
    const scaled = matchHeight(1.0, 1.6, 1.92);
    assert.equal(scaled.h, 1.92);
    assert.ok(Math.abs(scaled.w - 1.2) < 1e-9);
    assert.deepEqual(matchHeight(1.0, 1.6, 0), { w: 1.0, h: 1.6 });
  });

  test('shouldSkipFallbackAvatar suppresses blocky cube fallback whenever hasActorSprite or arena2Loaded is true', () => {
    assert.equal(shouldSkipFallbackAvatar({ hasActorSprite: true, arena2Loaded: false }), true);
    assert.equal(shouldSkipFallbackAvatar({ hasActorSprite: false, arena2Loaded: true }), true);
    assert.equal(shouldSkipFallbackAvatar({ hasActorSprite: true, arena2Loaded: true }), true);
    assert.equal(shouldSkipFallbackAvatar({ hasActorSprite: false, arena2Loaded: false }), false);
    assert.equal(shouldSkipFallbackAvatar({ hasActorSprite: false, arena2Loaded: false, peer: { coverage: 0 } }), true);
    assert.equal(shouldSkipFallbackAvatar(), false);
  });
});
