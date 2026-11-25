// In-game layout: menu page grouping, the contextual Use label, and the HUD region markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { groupPanels, useLabel, PANEL_GROUPS } from '../client/gameplay/shell.js';

const ids = (list) => list.map((p) => p.id);

test('menu pages are grouped You · World · People · System, unknown pages follow their neighbour', () => {
  const registered = ['character', 'inventory', 'spellbook', 'journal', 'map', 'wilderness', 'party', 'interaction',
    'dialogue', 'settings', 'places', 'automap', 'townServices', 'rest', 'audio'].map((id) => ({ id }));
  const out = groupPanels(registered);
  assert.deepEqual(ids(out), ['character', 'inventory', 'spellbook', 'journal', 'map', 'wilderness', 'places', 'automap',
    'rest', 'party', 'interaction', 'dialogue', 'townServices', 'settings', 'audio']);
  assert.deepEqual(out.filter((p) => p.groupStart).map((p) => [p.id, p.group]),
    [['character', 'You'], ['map', 'World'], ['party', 'People'], ['settings', 'System']]);
  // A page no group lists stays next to the page registered before it.
  const extra = groupPanels([{ id: 'character' }, { id: 'map' }, { id: 'guildhall' }, { id: 'settings' }]);
  assert.deepEqual(ids(extra), ['character', 'map', 'guildhall', 'settings']);
  assert.equal(extra[2].group, 'World');
  assert.equal(extra[2].groupStart, false);
  assert.equal(PANEL_GROUPS.length, 4);
});

test('the Use button names the action for the target', () => {
  assert.equal(useLabel({ id: 1, kind: 'npc' }), 'Talk');
  assert.equal(useLabel({ id: 2, kind: 'loot' }), 'Loot');
  assert.equal(useLabel({ id: 3, kind: 'monster', dead: true, lootable: true }), 'Loot');
  assert.equal(useLabel({ id: 4, kind: 'monster', hp: 5 }), 'Use');
  assert.equal(useLabel({ id: 5, kind: 'player', defeated: true }), 'Revive');
  assert.equal(useLabel({ id: 6, kind: 'player' }), 'Party');
});

test('play.html places every HUD widget inside one layout region', () => {
  const html = readFileSync(new URL('../client/play.html', import.meta.url), 'utf8');
  const hud = html.slice(html.indexOf('<section id="hud"'), html.indexOf('<div id="game-menu"'));
  const order = ['id="hud-top"', 'id="hud-status"', 'id="hud-place"', 'id="hud-compass"', 'id="hud-actions"', 'id="hud-toasts"',
    'id="hud-popovers"', 'id="hud-roster"', 'id="hud-help"', 'id="hud-prompts"', 'id="hud-target"', 'id="hud-bottom"',
    'id="hud-chat"', 'id="hud-talk"', 'id="chat-log"', 'id="chat-form"', 'id="hud-dock"', 'id="hud-vitals"', 'id="hud-bar"'];
  let at = -1;
  for (const id of order) {
    const i = hud.indexOf(id);
    assert.ok(i > at, `${id} is in its region, in order`);
    at = i;
  }
  assert.match(html, /<link rel="stylesheet" href="\/hud\/layout\.css">/);
  assert.match(html, /<script type="module" src="\/hud\/layout\.js"><\/script>/);
  // The view takes focus back when a menu closes.
  assert.match(html, /<canvas id="view" tabindex="-1"/);
});
