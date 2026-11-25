import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS } from '../client/gameplay/character/rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DOC_PATH = resolve(ROOT, 'docs/hiscores.md');
const doc = readFileSync(DOC_PATH, 'utf8');

function skillSlug(skillName) {
  return String(skillName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

describe('docs/hiscores.md Chronicles of the Iliac Bay contract', () => {
  it('documents the canonical public HTTP endpoints', () => {
    const endpoints = [
      '/api/hiscores/categories',
      '/api/hiscores?board=overall',
      '/api/hiscores/board/:board',
      '/api/hiscores/orders',
      '/api/hiscores/player',
      '/api/hiscores/player/:name',
      '/api/hiscores/compare',
    ];
    for (const ep of endpoints) {
      assert.ok(doc.includes(ep), `docs/hiscores.md must document endpoint ${ep}`);
    }
  });

  it('documents HTTP status codes, Cache-Control headers, and rate limits', () => {
    for (const code of ['200', '400', '404', '405', '429', '500']) {
      assert.match(doc, new RegExp(`\\b${code}\\b`), `docs/hiscores.md must document HTTP status ${code}`);
    }
    assert.ok(doc.includes('Cache-Control'), 'docs/hiscores.md must document Cache-Control headers');
    assert.ok(doc.includes('max-age=15'), 'docs/hiscores.md must document 200 Cache-Control max-age');
    assert.ok(doc.includes('no-store'), 'docs/hiscores.md must document error Cache-Control no-store');
    assert.match(doc, /rate limit/i, 'docs/hiscores.md must document HTTP rate limits');
    assert.ok(doc.includes('Retry-After'), 'docs/hiscores.md must document Retry-After header for 429');
  });

  it('documents all 7 core boards and tie-breaking rules', () => {
    const coreBoards = [
      'overall',
      'level',
      'exploration',
      'quests',
      'slayer',
      'wanted',
      'admiralty',
    ];
    for (const board of coreBoards) {
      assert.ok(doc.includes(`\`${board}\``), `docs/hiscores.md must document core board "${board}"`);
    }
    assert.match(doc, /first-to-milestone|first-to-100/i, 'docs/hiscores.md must document first-to-milestone tie-breaking');
    assert.ok(doc.includes('milestoneAt'), 'docs/hiscores.md must document milestoneAt tie-breaker');
  });

  it('documents all 6 classic guild boards', () => {
    const guildBoards = [
      'guild:fighters',
      'guild:mages',
      'guild:thieves',
      'guild:brotherhood',
      'guild:temple',
      'guild:knights',
    ];
    for (const board of guildBoards) {
      assert.ok(doc.includes(`\`${board}\``), `docs/hiscores.md must document classic guild board "${board}"`);
    }
  });

  it('documents all 35 classic Daggerfall skills from client/gameplay/character/rules.js', () => {
    assert.equal(SKILLS.length, 35, 'Expected 35 classic Daggerfall skills in rules.js');
    for (const skill of SKILLS) {
      const slug = `skill:${skillSlug(skill)}`;
      assert.ok(doc.includes(skill), `docs/hiscores.md must document skill name "${skill}"`);
      assert.ok(doc.includes(`\`${slug}\``), `docs/hiscores.md must document skill board id "${slug}"`);
    }
    assert.ok(
      doc.includes('client/gameplay/character/rules.js'),
      'docs/hiscores.md must reference client/gameplay/character/rules.js',
    );
  });

  it('documents the Player Orders board and its 3 sort modes', () => {
    assert.ok(doc.includes('`orders`'), 'docs/hiscores.md must document orders board');
    for (const sort of ['members', 'level', 'treasury']) {
      assert.ok(doc.includes(`\`${sort}\``), `docs/hiscores.md must document orders sort "${sort}"`);
    }
  });

  it('documents all 6 in-game chronicles.* WebSocket actions', () => {
    const wsVerbs = [
      'chronicles.categories',
      'chronicles.board',
      'chronicles.orders',
      'chronicles.player',
      'chronicles.compare',
      'chronicles.privacy',
    ];
    for (const verb of wsVerbs) {
      assert.ok(doc.includes(`\`${verb}\``), `docs/hiscores.md must document WS action "${verb}"`);
    }
  });

  it('documents privacy boundary invariants and automatic exclusions', () => {
    const forbiddenFields = [
      'accountId',
      'tokenHash',
      '`x`',
      '`z`',
      '`yaw`',
      '`location`',
      '`inventory`',
      'raw `rpg`',
    ];
    for (const field of forbiddenFields) {
      assert.ok(doc.includes(field), `docs/hiscores.md must explicitly prohibit exposing ${field}`);
    }
    assert.ok(doc.includes('rpg.chronicles.hidden'), 'docs/hiscores.md must document rpg.chronicles.hidden opt-out');
    assert.match(doc, /banned/i, 'docs/hiscores.md must document automatic exclusion of banned accounts');
    assert.match(doc, /uncreated/i, 'docs/hiscores.md must document automatic exclusion of uncreated characters');
  });

  it('documents storage tables, 30 s snapshot cache, and operator CLI subcommands', () => {
    assert.ok(doc.includes('`hiscores`'), 'docs/hiscores.md must document hiscores table');
    assert.ok(doc.includes('`hiscores_orders`'), 'docs/hiscores.md must document hiscores_orders table');
    assert.ok(doc.includes('server/storage/schema.sql'), 'docs/hiscores.md must reference server/storage/schema.sql');
    assert.match(doc, /30\s*s|30_000/, 'docs/hiscores.md must document the 30 s snapshot cache');
    assert.ok(doc.includes('tools/hiscores.mjs'), 'docs/hiscores.md must document tools/hiscores.mjs');
    for (const subcmd of ['rebuild', 'top', 'player', 'orders', 'stats']) {
      assert.ok(
        doc.includes(`node tools/hiscores.mjs ${subcmd}`),
        `docs/hiscores.md must document CLI subcommand "${subcmd}"`,
      );
    }
  });
});
