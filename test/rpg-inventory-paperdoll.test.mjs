import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import { settle } from '../server/rpg/social/trade.js';
import { applyDye, CLOTH_DYES } from '../client/gameplay/inventory/dyes.js';
import { itemArt, dollLayers, dollFiles, parseImg, parseCif, textureImage, ArtSource, RACE_FILE_INDEX, LOOT_HEAP_SPRITE } from '../client/gameplay/inventory/images.js';
import { IconSource } from '../client/gameplay/inventory/icons.js';
import { composeDoll, slotAt, buildDoll, DOLL_WIDTH, DOLL_HEIGHT, DOLL_ORIGIN } from '../client/gameplay/inventory/paperdoll.js';
import { TextureArchive, parsePalette } from '../client/world/textures.js';
import { SpriteArchive } from '../client/gameplay/actors/spriteArchive.js';
import { buildAtlas } from '../client/gameplay/actors/library.js';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { questItemArt } from '../server/rpg/quests/itemArt.js';
import * as model from '../client/gameplay/inventory/model.js';

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const haveGameFiles = existsSync(`${ARENA2}BODY00I0.IMG`) && existsSync(`${ARENA2}ART_PAL.COL`);
const haveQuests = haveGameFiles && existsSync(`${ARENA2}A0C00Y14.QBN`);

function classicArt() {
  const has = (name) => existsSync(ARENA2 + name);
  const get = (name) => (has(name) ? { arrayBuffer: async () => new Uint8Array(readFileSync(ARENA2 + name)).buffer } : undefined);
  return new ArtSource({ has, get });
}

function world() {
  const players = new Map();
  const rt = createRpgRuntime({
    players, features: [inventory], save: () => {}, send: () => {}, now: () => 0, log: { error() {}, warn() {}, info() {} },
  });
  const join = (id, rpg = {}) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  return { rt, join };
}
const byTemplate = (p, t) => p.rpg.inventory.find((i) => i.template === t);

test('clothing templates: dyes, slots, classic records and draw order', () => {
  const cloak = inventory.describeTemplate('casual-cloak');
  assert.equal(cloak.template, 'blue-casual-cloak');
  assert.equal(cloak.slot, 'cloak');
  assert.equal(cloak.index, 154);
  assert.deepEqual([cloak.doll.male, cloak.doll.female, cloak.doll.drawOrder, cloak.doll.cloak], [21, 21, 90, true]);
  const red = inventory.describeTemplate('red-short-shirt');
  assert.equal(red.name, 'Red Short Shirt');
  assert.equal(red.slot, 'chestClothes');
  assert.equal(inventory.describeTemplate('brown-casual-pants').slot, 'legsClothes');
  assert.equal(inventory.describeTemplate('shoes').slot, 'feet');
  assert.equal(inventory.resolveTemplate('iron-shoes'), null);
  assert.equal(inventory.resolveTemplate('pink-shoes'), null);
  for (const d of Object.keys(CLOTH_DYES)) assert.ok(inventory.resolveTemplate(`${d}-vest`), d);
  // Weapons and armour carry doll records and metal dyes.
  const ls = inventory.describeTemplate('daedric-longsword');
  assert.deepEqual([ls.doll.set, ls.doll.record, ls.doll.drawOrder, ls.doll.dye], ['weapon', 12, 100, 'daedric']);
  assert.equal(inventory.describeTemplate('katana').doll.record, 9, 'katana doll uses the left-hand record');
  const helm = inventory.describeTemplate('steel-helm');
  assert.deepEqual([helm.doll.record, helm.doll.drawOrder, helm.doll.dye], [29, 0, 'steel']);
  assert.equal(inventory.describeTemplate('leather-cuirass').doll.dye, 'silver', 'Unchanged shares Silver in DFU');
});

test('starter clothes: new characters are dressed; version-1 characters get clothes once', () => {
  const w = world();
  const p = w.join(1);
  const shirt = byTemplate(p, 'white-short-shirt');
  const pants = byTemplate(p, 'brown-casual-pants');
  assert.equal(p.rpg.equipment.chestClothes, shirt.id);
  assert.equal(p.rpg.equipment.legsClothes, pants.id);
  assert.equal(byTemplate(p, 'blue-casual-cloak').equipped, undefined);
  assert.equal(p.rpg.inventoryVersion, inventory.INVENTORY_VERSION);

  const old = w.join(2, {
    inventoryVersion: 1, gold: 7,
    inventory: [{ id: 'sword', template: 'iron-longsword' }],
    equipment: { rightHand: 'sword' },
  });
  assert.equal(old.rpg.gold, 7, 'no second gold grant');
  assert.equal(old.rpg.inventory.filter((i) => i.template === 'iron-longsword').length, 1, 'no second weapon kit');
  assert.ok(byTemplate(old, 'white-short-shirt').equipped);
  const stored = JSON.parse(JSON.stringify(old.rpg));
  const again = w.join(2, stored);
  assert.equal(again.rpg.inventory.length, stored.inventory.length, 'rejoin does not duplicate clothes');
});

test('equip clothing over and under armour; feet slot is shared with boots', () => {
  const w = world();
  const p = w.join(3);
  const cloak = byTemplate(p, 'blue-casual-cloak');
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: cloak.id }).ok, true);
  assert.equal(p.rpg.equipment.cloak, cloak.id);
  const shoes = byTemplate(p, 'brown-shoes');
  assert.equal(w.rt.act(p, 'inventory.use', { itemId: shoes.id }).ok, true);
  assert.equal(p.rpg.equipment.feet, shoes.id);
  assert.equal(byTemplate(p, 'leather-boots').equipped, undefined);
  assert.match(w.rt.act(p, 'inventory.equip', { itemId: cloak.id, slot: 'chestClothes' }).error, /does not fit/);
  assert.equal(w.rt.act(p, 'inventory.unequip', { slot: 'chestClothes' }).ok, true);
  assert.equal(model.primaryAction(byTemplate(p, 'white-short-shirt')).label, 'Equip');
  assert.ok(model.itemsForTab(p.rpg.inventory, 'clothing').some((i) => i.template === 'white-short-shirt'));
});

test('clothing variant survives persistence and is clamped', () => {
  const w = world();
  const p = w.join(4, {
    inventoryVersion: inventory.INVENTORY_VERSION,
    inventory: [{ id: 'c1', template: 'red-casual-cloak', variant: 3 }, { id: 'c2', template: 'vest', variant: 99 }],
  });
  assert.equal(p.rpg.inventory.find((i) => i.id === 'c1').variant, 3);
  const vest = p.rpg.inventory.find((i) => i.id === 'c2');
  assert.equal(vest.variant, 1);
  assert.equal(itemArt(vest, { gender: 'Male' }).record, 109, 'male vests have one original record');
  assert.equal(itemArt(vest, { gender: 'Female' }).record, 110, 'female vests have two original records');
});

test('trade keeps clothing and weapon records intact (variant, dye, condition, id)', () => {
  const w = world();
  const a = w.join(5);
  const b = w.join(6);
  const s = w.rt.ctx.services;
  const cloak = s.giveItem(a, 'red-casual-cloak');
  cloak.variant = 4;
  cloak.condition = 77;
  const axe = byTemplate(a, 'iron-battle-axe');
  axe.condition = 321;
  const before = { cloak: { ...cloak }, axe: { ...axe } };
  settle(s, { player: a, offer: { items: [{ id: cloak.id, quantity: 1 }, { id: axe.id, quantity: 1 }], gold: 10 } },
    { player: b, offer: { items: [], gold: 0 } });
  const gotCloak = b.rpg.inventory.find((i) => i.template === 'red-casual-cloak');
  const gotAxe = b.rpg.inventory.find((i) => i.template === 'iron-battle-axe' && i.condition === 321);
  assert.deepEqual(gotCloak, before.cloak);
  assert.equal(gotAxe.id, before.axe.id);
  assert.equal(b.rpg.gold, inventory.STARTER_GOLD + 10);
  assert.equal(a.rpg.inventory.some((i) => i.id === cloak.id), false);
  // Equipped garments cannot leave through the inventory service.
  assert.throws(() => s.transferItem(a, b, a.rpg.equipment.chestClothes), /Unequip/);
});

test('itemArt: archives by sex and body type, right-hand record, cloak interior', () => {
  const sword = inventory.makeItem('iron-longsword');
  const male = { gender: 'Male', race: 'Breton' };
  const female = { gender: 'Female', race: 'Wood Elf' };
  assert.deepEqual(itemArt(sword, male, { doll: true, slot: 'rightHand' }), { archive: 234, record: 13, dye: { kind: 'metal', name: 'iron' } });
  assert.equal(itemArt(sword, female, { doll: true, slot: 'leftHand' }).archive, 233);
  assert.equal(itemArt(sword, female, { doll: true, slot: 'leftHand' }).record, 12);
  const helm = inventory.makeItem('leather-helm');
  assert.equal(itemArt(helm, male).archive, 251);
  assert.equal(itemArt(helm, female).archive, 246);
  assert.equal(itemArt(helm, { gender: 'Male', race: 'Khajiit' }).archive, 252);
  const cloak = { ...inventory.makeItem('blue-casual-cloak'), variant: 2 };
  assert.deepEqual(itemArt(cloak, male, { doll: true }), { archive: 241, record: 24, dye: { kind: 'clothing', name: 'blue' } });
  assert.equal(itemArt(cloak, male, { doll: true, interior: true }).record, 21);
  assert.equal(itemArt(cloak, female, { doll: true }).archive, 236);
  const breeches = inventory.makeItem('breeches');
  assert.equal(itemArt(breeches, female, { doll: true }).archive, 240, 'men-only garment falls back to men\'s art (elf body)');
  const potion = inventory.makeItem('potion-of-healing');
  assert.deepEqual(itemArt(potion, male), { archive: 205, record: 15, dye: null });
  assert.deepEqual(itemArt(inventory.makeItem('potion-of-stamina')), { archive: 205, record: 11, dye: null });
  assert.deepEqual(itemArt(inventory.makeItem('potion-of-magicka')), { archive: 205, record: 12, dye: null });
  assert.equal(itemArt(potion, male, { doll: true }), null);
  assert.deepEqual(dollFiles({ gender: 'Female', race: 'Nord', faceIndex: 3 }),
    { background: 'SCBG02I0.IMG', bodyUnclothed: 'BODY12I0.IMG', bodyClothed: 'BODY12I1.IMG', heads: 'FACE12I0.CIF', faceIndex: 3 });
});

test('single drops expose the item ground sprite, and mixed contents use the classic heap', () => {
  const { rt, join } = world();
  const p = join(90);
  const pileId = rt.ctx.services.spawnLoot(rt.ctx.defaultLocation, 0, 0, [
    { template: 'iron-longsword', quantity: 1 }, { template: 'gold', quantity: 5 },
  ]);
  const pile = rt.ctx.entities.get(pileId);
  assert.deepEqual(pile.sprite, LOOT_HEAP_SPRITE);
  assert.equal(rt.act(p, 'inventory.loot', { targetId: pileId, itemId: 'gold' }).ok, true);
  assert.deepEqual(pile.sprite, { archive: 207, record: 2 });
  const shirt = byTemplate(p, 'white-short-shirt');
  assert.equal(rt.act(p, 'inventory.unequip', { itemId: shirt.id }).ok, true);
  assert.equal(rt.act(p, 'inventory.drop', { itemId: shirt.id }).ok, true);
  assert.deepEqual([...rt.ctx.entities.values()].find((e) => e.name.endsWith('dropped items')).sprite, { archive: 204, record: 0 });
});

test('an old armour record retains its valid original variant after rejoin', () => {
  const { join } = world();
  const p = join(91, {
    inventoryVersion: inventory.INVENTORY_VERSION,
    inventory: [{ id: 'old', template: 'steel-cuirass', variant: 3, icon: { archive: 999, record: 999 } }],
    equipment: { chestArmor: 'old' },
  });
  const item = p.rpg.inventory[0];
  assert.equal(item.variant, 3);
  assert.deepEqual(itemArt(item, { race: 'Redguard', gender: 'Female' }, { doll: true }),
    { archive: 247, record: 6, dye: { kind: 'metal', name: 'steel' } });
});

test('dyes swap the classic 16-colour bands', () => {
  const cloth = applyDye(Uint8Array.from([0x5f, 0x60, 0x65, 0x6f, 0x70]), 'clothing', 'red');
  assert.deepEqual([...cloth], [0x5f, 0xef, 0xf4, 0xfe, 0x70]);
  const metal = applyDye(Uint8Array.from([0x70, 0x7f, 0x6f]), 'metal', 'dwarven');
  assert.deepEqual([...metal], [0x90, 0x9f, 0x6f]);
  assert.deepEqual([...applyDye(Uint8Array.from([0x60]), 'clothing', 'nope')], [0x60]);
});

test('compositor: draw order, censor halves, masks clear, hit testing', () => {
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) palette.set([i, i, i], i * 3);
  const solid = (w, h, c, x, y) => ({ width: w, height: h, offsetX: 200 + x, offsetY: 8 + y, data: new Uint8Array(w * h).fill(c) });
  const body = solid(10, 60, 10, 50, 50);
  const clothed = solid(10, 60, 20, 50, 50);
  const shirt = solid(10, 10, 30, 50, 55);
  const cloak = solid(4, 4, 40, 52, 56);
  const helmet = solid(10, 10, 0xff, 50, 50);
  const bg = solid(DOLL_WIDTH, DOLL_HEIGHT, 5, 0, 0);
  const px = (d, x, y) => d.rgba[(y * DOLL_WIDTH + x) * 4];
  const naked = composeDoll({ palette, background: bg, body, clothed, layers: [], upperClothed: false, lowerClothed: false });
  assert.equal(px(naked, 51, 60), 20, 'upper censor half drawn');
  assert.equal(px(naked, 51, 100), 20, 'lower censor half drawn');
  const dressed = composeDoll({
    palette, background: bg, body, clothed, upperClothed: true, lowerClothed: false,
    interior: { slot: 'cloak', img: solid(15, 60, 40, 50, 50) },
    layers: [{ slot: 'head', img: helmet }, { slot: 'chestClothes', img: shirt }, { slot: 'cloak', img: cloak }],
  });
  assert.equal(px(dressed, 51, 52), 5, 'mask pixels expose the background');
  assert.equal(px(dressed, 51, 62), 30, 'shirt drawn over body');
  assert.equal(px(dressed, 53, 57), 40, 'later layer on top');
  assert.equal(px(dressed, 51, 100), 20, 'lower censor still drawn');
  assert.equal(px(dressed, 5, 5), 5, 'background');
  assert.equal(slotAt(dressed, 53, 57), 'cloak');
  assert.equal(slotAt(dressed, 51, 62), 'chestClothes');
  assert.equal(slotAt(dressed, 51, 100), null);
  assert.equal(slotAt(dressed, 51, 52), null, 'a mask clears the concealed item hit');
  assert.equal(slotAt(dressed, 62, 100), 'cloak', 'visible lining still belongs to its cloak');
  assert.equal(slotAt(dressed, -1, 0), null);
});

test('dollLayers sorts equipped items by classic draw order', () => {
  const w = world();
  const p = w.join(7);
  const order = dollLayers(p.rpg).map((l) => l.slot);
  assert.deepEqual(order, ['head', 'legsClothes', 'feet', 'chestClothes', 'chestArmor', 'rightHand']);
});

test('real classic art: parses BODY/FACE/SCBG and dresses the doll; equip changes pixels', { skip: !haveGameFiles && 'local game files not present' }, async () => {
  const body = parseImg(new Uint8Array(readFileSync(`${ARENA2}BODY00I0.IMG`)));
  assert.equal(body.offsetX, 222);
  assert.ok(body.width > 40 && body.height > 100);
  const face = parseCif(new Uint8Array(readFileSync(`${ARENA2}FACE00I0.CIF`)), 1);
  assert.ok(face.width > 10 && face.offsetX > 200);
  const ta = new TextureArchive(new Uint8Array(readFileSync(`${ARENA2}TEXTURE.251`)), 251);
  assert.ok(textureImage(ta, 27).data.includes(0xff), 'helmet art carries mask pixels');

  const art = classicArt();
  const palette = parsePalette(new Uint8Array(readFileSync(`${ARENA2}ART_PAL.COL`)));
  const w = world();
  const p = w.join(8, { character: { gender: 'Male', race: 'Breton', faceIndex: 0 } });
  const dressed = await buildDoll(art, palette, p.rpg);
  assert.deepEqual(dressed.drawn, ['head', 'legsClothes', 'feet', 'chestClothes', 'chestArmor', 'rightHand']);
  const cloak = byTemplate(p, 'blue-casual-cloak');
  assert.equal(w.rt.act(p, 'inventory.equip', { itemId: cloak.id }).ok, true);
  const cloaked = await buildDoll(art, palette, p.rpg);
  assert.ok(cloaked.drawn.includes('cloak'));
  let diff = 0;
  for (let i = 0; i < dressed.rgba.length; i++) if (dressed.rgba[i] !== cloaked.rgba[i]) diff++;
  assert.ok(diff > 500, `cloak visibly changes the doll (${diff} channels)`);
  assert.ok(cloaked.hits.some((h) => cloaked.slots[h - 1] === 'cloak'));
  // Missing art: no body file -> null (panel falls back to the slot grid).
  const empty = new ArtSource({ has: () => false, get: () => undefined });
  assert.equal(await buildDoll(empty, palette, p.rpg), null);
});

test('every catalogue appearance decodes visible pixels across the original bodies and variants', { skip: !haveGameFiles && 'local game files not present' }, async (t) => {
  const art = classicArt();
  const palette = parsePalette(new Uint8Array(readFileSync(`${ARENA2}ART_PAL.COL`)));
  const lookups = new Map();
  const atlases = new Map();
  const count = { icon: 0, ground: 0, doll: 0, face: 0 };
  const templates = [...inventory.catalogue(), 'gold'];
  const items = templates.map((key) => key === 'gold' ? { template: key } : inventory.makeItem(key));
  const visible = (img) => img?.data.some((c) => c !== 0 && c !== 255);
  const inDoll = (img) => img?.data.some((c, i) => {
    if (c === 0 || c === 255) return false;
    const x = img.offsetX + i % img.width - DOLL_ORIGIN.x;
    const y = img.offsetY + Math.floor(i / img.width) - DOLL_ORIGIN.y;
    return x >= 0 && y >= 0 && x < DOLL_WIDTH && y < DOLL_HEIGHT;
  });
  for (const gender of ['Male', 'Female']) {
    for (const race of Object.keys(RACE_FILE_INDEX)) {
      const character = { gender, race };
      const files = dollFiles(character);
      for (const name of [files.background, files.bodyUnclothed, files.bodyClothed]) {
        assert(inDoll(await art.img(name)), name);
      }
      for (let faceIndex = 0; faceIndex < 10; faceIndex++) {
        assert(inDoll(await art.cif(files.heads, faceIndex)), `${files.heads}:${faceIndex}`);
        count.face++;
      }
      for (const item of items) {
        const variants = Array.isArray(item.icon?.variants)
          ? item.icon.variants : Array.from({ length: item.variants ?? 1 }, (_, i) => i);
        for (const variant of variants) {
          const record = { ...item, variant };
          const contexts = [['icon', {}], ['ground', { ground: true }]];
          if (item.doll) contexts.push(['doll', { doll: true, slot: item.slot }]);
          if (item.hands === 'either') contexts.push(['doll', { doll: true, slot: 'leftHand' }]);
          if (item.doll?.cloak) contexts.push(['doll', { doll: true, interior: true }]);
          for (const [surface, opts] of contexts) {
            const address = itemArt(record, character, opts);
            assert(address, `${item.template}, ${gender} ${race}, variant ${variant}, ${surface}`);
            const key = JSON.stringify(address);
            if (!lookups.has(key)) lookups.set(key, art.image(address));
            const img = await lookups.get(key);
            assert((surface === 'doll' ? inDoll : visible)(img), `${item.template}: ${key} (${surface})`);
            if (surface === 'ground') {
              const { archive, record } = address;
              if (!atlases.has(archive)) {
                const bytes = await art.bytes(`TEXTURE.${archive}`);
                atlases.set(archive, buildAtlas(new SpriteArchive(bytes, archive), palette));
              }
              assert(atlases.get(archive).rects[record]?.[0], `${key} in world sprite atlas`);
            }
            count[surface]++;
          }
        }
      }
    }
  }
  assert(visible(await art.image(LOOT_HEAP_SPRITE)));
  assert(visible(await art.item({ template: 'letter-of-credit' })));
  t.diagnostic(`${templates.length} template/currency keys: ${JSON.stringify(count)} visible checks, ${lookups.size} distinct addresses/dyes`);
});

test('each offered classic quest resource resolves to visible icon and ground pixels', { skip: !haveQuests && 'local quest files not present' }, async (t) => {
  const catalog = loadCatalog({ dataPath: ARENA2 });
  const art = classicArt();
  let resources = 0;
  let quests = 0;
  for (const quest of catalog.quests.values()) {
    if (!quest.analysis.offerable) continue;
    quests++;
    for (const resource of quest.def.resources.values()) {
      if (resource.kind !== 'item') continue;
      const item = questItemArt({ className: resource.className }, resource);
      for (const opts of [{}, { ground: true }]) {
        const img = await art.item(item, { gender: 'Female', race: 'Breton' }, opts);
        assert(img?.data.some((c) => c !== 0 && c !== 255), `${quest.name}: ${resource.className}`);
      }
      resources++;
    }
  }
  assert(resources > 0);
  t.diagnostic(`${resources} item resources across ${quests} offerable quests`);
});

test('doll cache depends on resolved face, item appearance and the file generation', async () => {
  const makeFiles = () => ['ART_PAL.COL', 'BODY00I1.IMG', 'FACE00I0.CIF'].map((name) => new File([], name));
  const source = new IconSource();
  const files = makeFiles();
  source.setFiles(files);
  source.setFiles(files);
  const item = inventory.makeItem('red-casual-cloak');
  const rpg = { character: { faceIndex: 0 }, inventory: [item], equipment: { cloak: item.id } };
  const first = source.doll(rpg);
  assert.equal(source.doll(rpg), first);
  assert.notEqual(source.doll({ ...rpg, character: { faceIndex: 1 } }), first);
  assert.notEqual(source.doll({ ...rpg, inventory: [{ ...item, variant: 2 }] }), first);
  assert.notEqual(source.doll({ ...rpg, equipment: {} }), first);
  source.setFiles(makeFiles());
  assert.notEqual(source.doll(rpg), first);
  assert.equal(await first, null);
});
