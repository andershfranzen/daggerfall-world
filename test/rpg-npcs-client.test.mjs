import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  acceptsEvent, buyRows, clampQuantity, commandArgs, factionRelations, guildText, sellRows, standingText,
} from '../client/gameplay/npcs/model.js';
import { replyChoices } from '../client/gameplay/npcs/conversation.js';
import { parseFactionText } from '../client/gameplay/npcs/factionFile.js';
import { faceRecord, NpcAssets, parseFlatFaces } from '../client/gameplay/npcs/portrait.js';
import { toRgba } from '../client/hud/classic-art.js';
import { parsePalette } from '../client/world/textures.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as npcs from '../server/rpg/npcs.js';

const view = {
  kind: 'dialogue', session: 's1', npc: { id: 'npc:a:1', name: 'Fenna Ashby' }, gold: 50,
  standing: { factionId: 41, faction: 'Fighters Guild', reputation: 12, region: -3 },
  guild: { name: 'Fighters Guild', member: true, rankTitle: 'Blade' },
  shop: { purse: 40, items: [{ key: 'arrow', name: 'Arrow', quantity: 120, price: 3 }, { key: 'x', name: 'X', quantity: 1, price: 80 }],
    sellable: [{ itemId: 'i1', name: 'Ruby', quantity: 2, price: 100 }, { itemId: 'i2', name: 'Tooth', quantity: 9, price: 3 }] },
};

test('quantities, affordability and command arguments', () => {
  assert.equal(clampQuantity('7', 5), 5);
  assert.equal(clampQuantity(-2, 5), 1);
  assert.equal(clampQuantity('abc', 5), 1);
  assert.equal(clampQuantity(500, 500), 99);
  const b = buyRows(view);
  assert.deepEqual(b.map((r) => [r.affordable, r.maxQuantity]), [[true, 16], [false, 1]]);
  const s = sellRows(view);
  assert.deepEqual(s.map((r) => [r.affordable, r.maxQuantity]), [[false, 1], [true, 9]]);
  assert.deepEqual(commandArgs(view, { topic: 'news' }), { targetId: 'npc:a:1', session: 's1', topic: 'news' });
  assert.equal(standingText(view), 'Fighters Guild +12 · region -3');
  assert.equal(guildText(view), 'Fighters Guild — Blade');
});

test('event filtering: other NPCs’ endings are ignored', () => {
  assert.ok(acceptsEvent(null, view));
  assert.ok(!acceptsEvent(null, { kind: 'dialogue.end', npcId: 'npc:a:1' }));
  assert.ok(acceptsEvent(view, { kind: 'dialogue.end', npcId: 'npc:a:1' }));
  assert.ok(!acceptsEvent(view, { kind: 'dialogue.end', npcId: 'npc:b:2' }));
  assert.ok(!acceptsEvent(view, { kind: 'loot' }));
});

test('FACTION.TXT parser: nesting, flats and relations (synthetic text)', () => {
  const text = `; comment\n#10\ntype: 2\nname: Order A\nflat: 182 15\nally: 11\nenemy: 12\n\n\t#11\n\ttype: 3\n\tname: Sub B\n\n#12\nname: Rival C\n`;
  const m = parseFactionText(text);
  assert.equal(m.get(11).parent, 10);
  assert.equal(m.get(12).parent, null);
  assert.deepEqual(m.get(10).flats, [[182, 15]]);
  assert.deepEqual(factionRelations(m, 10), { name: 'Order A', allies: ['Sub B'], enemies: ['Rival C'] });
  assert.equal(factionRelations(m, 99), null);
});

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
test('with the operator’s ARENA2: guild staff are the authored Fighters Guild people with FACTION.TXT names', { skip: !existsSync(`${ARENA2}FACTION.TXT`) && 'no local ARENA2' }, async () => {
  const players = new Map();
  const sent = [];
  const rt = createRpgRuntime({ players, features: [npcs], dataPath: ARENA2, save() {}, send: (p, m) => sent.push(m), now: () => 0, log: { error() {}, warn() {}, info() {} } });
  // Gothway Garden's Fighters Guild hall (RMB record 1,1/6 of its block grid is found by type, not assumed).
  const town = await rt.ctx.services.npcs.source.town('town:Daggerfall/Gothway Garden');
  const hall = town.buildings.find((b) => b.buildingType === 11 && b.people > 0);
  assert.ok(hall, 'Gothway Garden has a guild hall with authored people');
  const loc = `interior:Daggerfall/Gothway Garden/${hall.bx},${hall.by}/${hall.record}`;
  const p = { id: 1, name: 'A', x: 0, z: 0, yaw: 0, moving: false, rpg: { gold: 0, location: loc } };
  players.set(1, p);
  rt.join(p);
  await rt.ctx.services.npcs.ready(loc);
  rt.tick(0.1, 100);
  const fg = [...rt.entities.values()].find((e) => e.location === loc && e.guild === 'fighters' && e.services?.includes('train'));
  assert.ok(fg, 'a Fighter Trainer (faction 849) stands in the hall');
  assert.equal(fg.factionName, 'Fighter Trainers', 'name comes from FACTION.TXT');
  assert.ok(Number.isInteger(fg.sprite.archive));
  p.x = fg.x; p.z = fg.z + 1;
  assert.equal(rt.act(p, 'npc.talk', { targetId: fg.id }).ok, true);
  const d = sent.filter((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue').at(-1).event;
  assert.equal(d.npc.id, fg.id);
  assert.ok(d.services.some((s) => s.id === 'join'));
});

test('installed talk portraits resolve fixed records with the original art palette', {
  skip: !existsSync(`${ARENA2}TFAC00I0.RCI`) && 'no local ARENA2',
}, async () => {
  const read = (name) => readFileSync(ARENA2 + name);
  const flats = parseFlatFaces(read('FLATS.CFG').toString());
  const merchant = flats.get('182:26');
  assert.equal(merchant, 445);
  assert.equal(flats.get('334:17'), 0, 'the static named flat needs its special faction face');
  const faction = [...parseFactionText(read('FACTION.TXT').toString()).values()].find(
    (f) => f.type === 4 && f.flats.some(([archive, record]) => archive === 334 && record === 17),
  );
  assert.equal(faction.face, 21);
  const assets = new NpcAssets();
  assets.setFiles(['ART_PAL.COL', 'FLATS.CFG', 'FACTION.TXT', 'TFAC00I0.RCI', 'FACES.CIF'].map(
    (name) => new File([read(name)], name),
  ));
  assert.equal((await assets.readPortrait({ archive: 182, record: 26 }, '182:26')).source, 'TFAC00I0.RCI#445');
  assert.equal((await assets.readPortrait({ archive: 334, record: 17 }, '334:17')).source, 'FACES.CIF#21');
  const palette = parsePalette(read('ART_PAL.COL'));
  const common = read('TFAC00I0.RCI');
  assert.equal(faceRecord(common, 502).indices.length, 4096);
  assert.equal(faceRecord(common, 503), null, 'a trailing fragment is not another portrait record');
  for (const img of [faceRecord(common, merchant), faceRecord(read('FACES.CIF'), faction.face)]) {
    const rgba = toRgba(img, palette, true);
    const i = img.indices.findIndex((index) => index !== 0);
    assert.ok(i >= 0);
    assert.deepEqual([...rgba.subarray(4 * i, 4 * i + 4)], [...palette.subarray(3 * img.indices[i], 3 * img.indices[i] + 3), 255]);
  }
});

test('locked rank-gated services stay in conversation instead of opening a service panel', () => {
  const lockedView = {
    npc: { id: 'npc:fg:1', name: 'Guild Smith' },
    topics: [],
    services: [
      { id: 'repair', label: 'Repairs', locked: true, reason: 'Only Fighters Guild members may use repairs here.' },
      { id: 'bank', label: 'Banking' },
    ],
  };
  const choices = replyChoices(lockedView);
  const rep = choices.find((c) => c.id === 'svc-repair');
  const bank = choices.find((c) => c.id === 'svc-bank');
  assert.equal(rep.panel, null, 'locked repair should not open townServices over the refusal');
  assert.equal(bank.panel, 'townServices', 'unlocked bank still opens townServices');
});
