import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_HEIGHT_M,
  peerDollSignature,
  trimDollBounds,
  buildPeerDollEntry,
  PeerDollLibrary,
} from '../client/gameplay/actors/peerDollBillboard.js';
import { DOLL_WIDTH, DOLL_HEIGHT, DOLL_ORIGIN } from '../client/gameplay/inventory/paperdoll.js';

function makePalette() {
  const pal = new Uint8Array(256 * 3);
  for (let i = 1; i < 256; i++) {
    pal[i * 3] = (i * 37) & 0xff;
    pal[i * 3 + 1] = (i * 73) & 0xff;
    pal[i * 3 + 2] = (i * 113) & 0xff;
  }
  return pal;
}

function makeIndexedImage(width, height, fill, { offsetX = DOLL_ORIGIN.x, offsetY = DOLL_ORIGIN.y } = {}) {
  const data = new Uint8Array(width * height);
  data.fill(fill);
  return { width, height, offsetX, offsetY, data };
}

function makeFakeArt({ hasBody = true, hasHead = true, items = new Map(), onCall = null } = {}) {
  return {
    async img(name) {
      onCall?.('img', name);
      if (!hasBody) return null;
      if (name.startsWith('SCBG')) {
        // Must never be requested for world billboard composition.
        return makeIndexedImage(DOLL_WIDTH, DOLL_HEIGHT, 99);
      }
      // Standing figure body from x=[35..74], y=[44..173] in doll space.
      return makeIndexedImage(40, 130, 12, {
        offsetX: DOLL_ORIGIN.x + 35,
        offsetY: DOLL_ORIGIN.y + 44,
      });
    },
    async cif(name, record) {
      onCall?.('cif', `${name}#${record}`);
      if (!hasHead) return null;
      // Head from x=[45..64], y=[16..43] in doll space.
      return makeIndexedImage(20, 28, 24, {
        offsetX: DOLL_ORIGIN.x + 45,
        offsetY: DOLL_ORIGIN.y + 16,
      });
    },
    async item(item, _character, opts) {
      const key = opts?.interior ? `${opts.slot ?? item.slot}:interior` : (opts?.slot ?? item.slot);
      onCall?.('item', key);
      return items.get(key) ?? null;
    },
    async bytes(name) {
      onCall?.('bytes', name);
      if (name === 'ART_PAL.COL') {
        const col = new Uint8Array(776);
        col.set(makePalette(), 8);
        return col;
      }
      return null;
    },
  };
}

function makeSamplePeer(overrides = {}) {
  return {
    id: 'peer-1',
    name: 'Gothryd',
    race: 'Breton',
    gender: 'Male',
    faceIndex: 2,
    readied: false,
    weapon: { template: 'steel-longsword', material: 'steel' },
    worn: {
      chestArmor: {
        template: 'steel-cuirass',
        base: 'cuirass',
        group: 'armor',
        material: 'steel',
        doll: { set: 'armor', record: 5, dye: 'steel', drawOrder: 20 },
      },
      cloak: {
        template: 'blue-cloak',
        base: 'cloak',
        group: 'clothing',
        dye: 'blue',
        doll: { set: 'clothing', male: 10, female: 10, cloak: true, dye: 'blue', drawOrder: 5 },
      },
      rightHand: {
        template: 'steel-longsword',
        base: 'longsword',
        group: 'weapon',
        material: 'steel',
        doll: { set: 'weapon', record: 3, dye: 'steel', drawOrder: 40 },
      },
    },
    ...overrides,
  };
}

describe('peerDollSignature', () => {
  it('is deterministic across object key order and identical peer loadouts', () => {
    const peerA = makeSamplePeer();
    const peerB = makeSamplePeer({
      id: 'peer-2',
      name: 'Someone Else',
      worn: {
        rightHand: peerA.worn.rightHand,
        cloak: peerA.worn.cloak,
        chestArmor: peerA.worn.chestArmor,
      },
    });
    assert.equal(peerDollSignature(peerA), peerDollSignature(peerB));
  });

  it('invalidates when race, gender, faceIndex, gear, dye, material, weapon, or readied changes', () => {
    const base = makeSamplePeer();
    const baseSig = peerDollSignature(base);

    assert.notEqual(peerDollSignature(makeSamplePeer({ race: 'Redguard' })), baseSig);
    assert.notEqual(peerDollSignature(makeSamplePeer({ gender: 'Female' })), baseSig);
    assert.notEqual(peerDollSignature(makeSamplePeer({ faceIndex: 5 })), baseSig);
    assert.notEqual(peerDollSignature(makeSamplePeer({ readied: true })), baseSig);
    assert.notEqual(
      peerDollSignature(makeSamplePeer({ weapon: { template: 'daedric-dai-katana', material: 'daedric' } })),
      baseSig,
    );

    const redCloak = makeSamplePeer({
      worn: {
        ...base.worn,
        cloak: {
          ...base.worn.cloak,
          dye: 'red',
          doll: { ...base.worn.cloak.doll, dye: 'red' },
        },
      },
    });
    assert.notEqual(peerDollSignature(redCloak), baseSig);

    const noCuirass = makeSamplePeer({
      worn: { cloak: base.worn.cloak, rightHand: base.worn.rightHand },
    });
    assert.notEqual(peerDollSignature(noCuirass), baseSig);
  });
});

describe('trimDollBounds', () => {
  it('crops transparent top, bottom, and side margins so feet touch bottom edge and scales to ~1.78m', () => {
    const rgba = new Uint8Array(DOLL_WIDTH * DOLL_HEIGHT * 4);
    // Draw a 40x120 opaque figure from x=[30..69], y=[20..139] (44px transparent below feet).
    for (let y = 20; y < 140; y++) {
      for (let x = 30; x < 70; x++) {
        const o = (y * DOLL_WIDTH + x) * 4;
        rgba[o] = 200;
        rgba[o + 1] = 150;
        rgba[o + 2] = 100;
        rgba[o + 3] = 255;
      }
    }

    const trimmed = trimDollBounds(rgba, DOLL_WIDTH, DOLL_HEIGHT);
    assert.ok(trimmed);
    assert.equal(trimmed.x, 30);
    assert.equal(trimmed.y, 20);
    assert.equal(trimmed.w, 40);
    assert.equal(trimmed.h, 120);
    assert.equal(trimmed.fullHeight, DOLL_HEIGHT);
    assert.ok(trimmed.pixels instanceof Uint8Array);
    assert.equal(trimmed.pixels.length, 40 * 120 * 4);

    // Bottom row of trimmed pixels (feet) must be opaque with zero floating gap underneath.
    const bottomRowOff = (trimmed.h - 1) * trimmed.w * 4;
    assert.equal(trimmed.pixels[bottomRowOff + 3], 255);

    // Aspect-preserved classic human world dimensions.
    assert.equal(trimmed.worldHeight, TARGET_HEIGHT_M);
    assert.ok(Math.abs(trimmed.worldWidth - TARGET_HEIGHT_M * (40 / 120)) < 1e-6);
  });

  it('returns null for a fully transparent buffer', () => {
    const empty = new Uint8Array(DOLL_WIDTH * DOLL_HEIGHT * 4);
    assert.equal(trimDollBounds(empty, DOLL_WIDTH, DOLL_HEIGHT), null);
  });
});

describe('buildPeerDollEntry', () => {
  it('composites transparent background, opaque gear pixels, SpritePass atlas rect, and #opaqueAt alphaMask', async () => {
    const calls = [];
    const items = new Map([
      // Cuirass torso piece inside body bounds
      ['chestArmor', makeIndexedImage(30, 40, 42, { offsetX: DOLL_ORIGIN.x + 40, offsetY: DOLL_ORIGIN.y + 50 })],
      // Cloak + cloak interior lining extending slightly wider than body
      ['cloak', makeIndexedImage(52, 90, 55, { offsetX: DOLL_ORIGIN.x + 29, offsetY: DOLL_ORIGIN.y + 46 })],
      ['cloak:interior', makeIndexedImage(48, 86, 61, { offsetX: DOLL_ORIGIN.x + 31, offsetY: DOLL_ORIGIN.y + 48 })],
      // Held sword extending to the left
      ['rightHand', makeIndexedImage(12, 50, 77, { offsetX: DOLL_ORIGIN.x + 20, offsetY: DOLL_ORIGIN.y + 60 })],
    ]);
    const art = makeFakeArt({ items, onCall: (kind, arg) => calls.push([kind, arg]) });
    const palette = makePalette();
    const peer = makeSamplePeer();

    const entry = await buildPeerDollEntry(peer, { art, palette, version: 3 });
    assert.ok(entry);

    // Never loads SCBG opaque background.
    assert.ok(!calls.some(([kind, arg]) => kind === 'img' && arg.startsWith('SCBG')));

    assert.equal(entry.archive, `doll:${peerDollSignature(peer)}`);
    assert.equal(entry.signature, peerDollSignature(peer));
    assert.equal(entry.version, 3);

    // Trimmed bounds: x=[20..80] (w=61), y=[16..173] (h=158).
    assert.equal(entry.atlas.width, 61);
    assert.equal(entry.atlas.height, 158);
    assert.deepEqual(entry.atlas.rects, [[{ x: 0, y: 0, w: 61, h: 158 }]]);
    assert.ok(entry.atlas.pixels instanceof Uint8Array);

    // Top-left corner of trimmed bounding box (x=20, y=16 in doll space) is outside head/body/sword -> alpha=0.
    assert.equal(entry.atlas.pixels[3], 0);

    // Center of head (x=50-20=30, y=25-16=9) -> opaque alpha=255.
    const headIdx = 9 * entry.atlas.width + 30;
    assert.equal(entry.atlas.pixels[headIdx * 4 + 3], 255);

    // SpritePass & actors.js #opaqueAt contract.
    assert.equal(entry.sprite.recordCount, 1);
    assert.equal(entry.sprite.records[0].frameCount, 1);
    assert.equal(entry.sprite.records[0].world.height, TARGET_HEIGHT_M);
    assert.ok(entry.sprite.records[0].world.width > 0.5 && entry.sprite.records[0].world.width < 1.0);

    const frame = entry.sprite.frame(0, 0);
    assert.equal(frame.width, entry.atlas.width);
    assert.equal(frame.height, entry.atlas.height);
    assert.ok(frame.data instanceof Uint8Array);
    assert.equal(frame.data[0], 0, 'transparent corner must be 0 in alphaMask');
    assert.equal(frame.data[headIdx], 1, 'opaque head pixel must be 1 in alphaMask');

    assert.deepEqual(entry.drawnSlots.sort(), ['chestArmor', 'cloak', 'rightHand']);
    assert.deepEqual(entry.missingSlots, []);
  });

  it('returns null gracefully when ARENA2 body files are absent', async () => {
    const art = makeFakeArt({ hasBody: false });
    const entry = await buildPeerDollEntry(makeSamplePeer(), { art, palette: makePalette() });
    assert.equal(entry, null);
  });
});

describe('PeerDollLibrary', () => {
  it('deduplicates concurrent async loads, serves cache hits synchronously, and fires onReady', async () => {
    let composeCalls = 0;
    let resolveGate;
    const gate = new Promise((r) => { resolveGate = r; });

    const lib = new PeerDollLibrary({
      maxEntries: 8,
      createArtSource: () => makeFakeArt(),
      loadPalette: async () => makePalette(),
      composeDollFn: (args) => {
        composeCalls++;
        return {
          width: DOLL_WIDTH,
          height: DOLL_HEIGHT,
          rgba: (() => {
            const out = new Uint8Array(DOLL_WIDTH * DOLL_HEIGHT * 4);
            for (let y = 20; y < 160; y++) {
              for (let x = 35; x < 75; x++) {
                const o = (y * DOLL_WIDTH + x) * 4;
                out[o] = 180; out[o + 1] = 120; out[o + 2] = 90; out[o + 3] = 255;
              }
            }
            return out;
          })(),
        };
      },
    });

    // Wrap art.img with gate to test concurrent dedup.
    lib.setFiles(new Map([['ART_PAL.COL', {}]]));
    const origImg = lib.art.img.bind(lib.art);
    lib.art.img = async (name) => {
      await gate;
      return origImg(name);
    };

    const readySigs = [];
    lib.onReady = (sig) => readySigs.push(sig);

    const peer = makeSamplePeer();
    assert.equal(lib.get(peer), null);
    const p1 = lib.load(peer);
    const p2 = lib.load(peer);
    assert.equal(lib.stats().pending, 1);

    resolveGate();
    const [e1, e2] = await Promise.all([p1, p2]);
    assert.ok(e1);
    assert.strictEqual(e1, e2);
    assert.equal(composeCalls, 1);
    assert.equal(readySigs.length, 1);
    assert.equal(readySigs[0], peerDollSignature(peer));

    // Subsequent synchronous get() is an immediate cache hit.
    const hit = lib.get(peer);
    assert.strictEqual(hit, e1);
    assert.equal(lib.stats().hits, 1);
    assert.equal(lib.stats().entries, 1);
  });

  it('enforces LRU eviction at maxEntries', async () => {
    const lib = new PeerDollLibrary({
      maxEntries: 2,
      createArtSource: () => makeFakeArt(),
      loadPalette: async () => makePalette(),
    });
    lib.setFiles(new Map([['ART_PAL.COL', {}]]));

    const peerA = makeSamplePeer({ faceIndex: 0 });
    const peerB = makeSamplePeer({ faceIndex: 1 });
    const peerC = makeSamplePeer({ faceIndex: 2 });

    const entryA = await lib.load(peerA);
    const entryB = await lib.load(peerB);
    assert.ok(entryA && entryB);

    // Touch peerA so peerB becomes the least recently used.
    assert.strictEqual(lib.get(peerA), entryA);

    const entryC = await lib.load(peerC);
    assert.ok(entryC);
    assert.equal(lib.stats().entries, 2);
    assert.equal(lib.stats().evictions, 1);

    assert.ok(lib.entries.has(peerDollSignature(peerA)), 'peerA was touched and must remain');
    assert.ok(!lib.entries.has(peerDollSignature(peerB)), 'peerB was LRU and must be evicted');
    assert.ok(lib.entries.has(peerDollSignature(peerC)), 'peerC was just added and must remain');
  });

  it('invalidates cached entries and discards in-flight loads when setFiles bumps generation', async () => {
    let releaseFirst;
    const firstGate = new Promise((r) => { releaseFirst = r; });
    let genCount = 0;

    const lib = new PeerDollLibrary({
      createArtSource: () => {
        genCount++;
        const myGen = genCount;
        const base = makeFakeArt();
        return {
          ...base,
          async img(name) {
            if (myGen === 1) await firstGate;
            return base.img(name);
          },
        };
      },
      loadPalette: async () => makePalette(),
    });

    const peer = makeSamplePeer();
    lib.setFiles(new Map([['ART_PAL.COL', {}]]));
    const stalePromise = lib.load(peer);

    // Switch files while first load is still pending.
    lib.setFiles(new Map([['ART_PAL.COL', {}]]));
    const freshEntry = await lib.load(peer);
    releaseFirst();
    const staleResult = await stalePromise;

    assert.equal(staleResult, null, 'stale generation load must resolve to null');
    assert.ok(freshEntry);
    assert.equal(freshEntry.version, 2);
    assert.strictEqual(lib.get(peer), freshEntry);
  });

  it('returns null gracefully when ARENA2 body files are absent or after dispose()', async () => {
    const lib = new PeerDollLibrary({
      createArtSource: () => makeFakeArt({ hasBody: false }),
      loadPalette: async () => makePalette(),
    });
    lib.setFiles(new Map([['ART_PAL.COL', {}]]));

    const peer = makeSamplePeer();
    assert.equal(await lib.load(peer), null);
    assert.equal(lib.stats().failed, 1);
    assert.equal(lib.stats().entries, 0);

    lib.dispose();
    assert.equal(lib.stats().entries, 0);
    assert.equal(lib.stats().failed, 0);
    assert.equal(await lib.load(peer), null);
  });
});
