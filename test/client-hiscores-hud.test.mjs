// Chronicles of the Iliac Bay HUD panel (client/gameplay/hiscores.js) tests
// with a lightweight DOM stub (no browser required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------- minimal DOM
class ClassList0 {
  constructor(el) { this.el = el; }
  _parts() { return this.el.className ? this.el.className.split(/\s+/).filter(Boolean) : []; }
  add(...names) {
    const set = new Set(this._parts());
    for (const n of names) if (n) set.add(n);
    this.el.className = [...set].join(' ');
  }
  contains(name) { return this._parts().includes(name); }
}

class Node0 {
  constructor() { this.childNodes = []; this.parentNode = null; }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === 'string' ? new Text0(k) : k;
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids) { this.childNodes = []; this.append(...kids); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = [new Text0(String(v))]; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document?.body || n === globalThis.document?.head;
  }
}

class Text0 extends Node0 {
  constructor(t) { super(); this.t = t; }
  get textContent() { return this.t; }
}

class El0 extends Node0 {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.classList = new ClassList0(this);
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  dispatch(type, extra = {}) {
    const ev = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...extra,
    };
    for (const f of this.listeners[type] ?? []) f(ev);
  }
  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }
  all(pred, out = []) {
    for (const c of this.childNodes) {
      if (c instanceof El0) {
        if (pred(c)) out.push(c);
        c.all(pred, out);
      }
    }
    return out;
  }
  byClass(cls) { return this.all((e) => e.classList.contains(cls)); }
  querySelector(sel) {
    if (sel.startsWith('.')) return this.byClass(sel.slice(1))[0] ?? null;
    if (sel === 'link[data-feature="hiscores"]') {
      return this.all((e) => e.tagName === 'LINK' && (e.dataset.feature === 'hiscores' || e.attrs['data-feature'] === 'hiscores'))[0] ?? null;
    }
    return null;
  }
  buttons(text) {
    return this.all((e) => e.tagName === 'BUTTON' && (!text || e.textContent.includes(text)));
  }
}

globalThis.Node = Node0;
const head = new El0('head');
const body = new El0('body');
globalThis.document = {
  head,
  body,
  createElement: (t) => new El0(t),
  createTextNode: (t) => new Text0(t),
  querySelector: (sel) => head.querySelector(sel) || body.querySelector(sel),
};

const { install, CORE_BOARDS, GUILD_BOARDS, SKILL_BOARDS } = await import('../client/gameplay/hiscores.js');
const { createGameplayApi } = await import('../client/gameplay/api.js');

function harness({ startNow = 100_000, selfName = 'Lyra', hidden = false } = {}) {
  let clock = startNow;
  const sent = [];
  const notes = [];
  const api = createGameplayApi({
    send: (verb, args) => {
      sent.push({ verb, args });
      return Promise.resolve({ ok: true, verb });
    },
    notify: (text) => notes.push(text),
  });
  let openId = null;
  const root = new El0('div');
  document.body.replaceChildren(root);
  api._attachShell({
    open: (id) => {
      openId = id;
      api._setModal(true, id);
      api.getPanel(id).render(root, api);
      api.emit('panel', { id, open: true });
    },
    close: () => {
      const prev = openId;
      openId = null;
      api._setModal(false);
      if (prev) api.emit('panel', { id: prev, open: false });
    },
    refresh: () => { if (openId) api.getPanel(openId).render(root, api); },
    panelsChanged() {},
  });

  api.screen = 'game';
  api.selfId = 'char-self';
  api.state = {
    selfId: 'char-self',
    self: {
      id: 'char-self',
      name: selfName,
      rpg: { chronicles: { hidden } },
    },
    character: {
      id: 'char-self',
      name: selfName,
      chronicles: { hidden },
    },
  };

  const mod = install(api, { now: () => clock });
  return {
    api,
    mod,
    root,
    sent,
    notes,
    advance: (ms) => { clock += ms; },
    open: () => api.openPanel('hiscores'),
    close: () => api.closePanel(),
    emitChronicles: (payload) => api.emit('event', { kind: 'chronicles', ...payload }),
    text: () => root.textContent,
  };
}

function sampleProfile(name, overrides = {}) {
  return {
    id: `id-${name.toLowerCase()}`,
    name,
    className: 'Spellsword',
    race: 'Breton',
    level: 14,
    totalSkill: 1420,
    orderTag: 'BAY',
    core: {
      overall: { score: 1420, rank: 2 },
      level: { score: 14, rank: 3 },
      cartography: { score: 412, total: 15251, rank: 5 },
      quests: { score: 27, rank: 4 },
      slayer: { score: 310, rank: 6 },
      wanted: { score: 150, rank: 9 },
      admiralty: { score: 8, title: 'Commodore', rank: 1 },
    },
    guilds: {
      mages: { rank: 7, rankTitle: 'Wizard', boardRank: 3 },
      fighters: { rank: 4, rankTitle: 'Swordsman', boardRank: 11 },
    },
    skills: {
      'Long Blade': { level: 100, rank: 1 },
      Destruction: { level: 82, rank: 4 },
      Stealth: { level: 45, rank: 19 },
      Running: { level: 68, rank: 7 },
      Daedric: { level: 30, rank: 12 },
    },
    ...overrides,
  };
}

test('panel registers as hiscores / Chronicles, injects stylesheet lazily, and uses zero innerHTML', () => {
  const src = readFileSync(new URL('../client/gameplay/hiscores.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\.innerHTML\b/, 'hiscores.js must never use innerHTML');

  const h = harness();
  const panel = h.api.getPanel('hiscores');
  assert.ok(panel, 'hiscores panel registered');
  assert.equal(panel.title, 'Chronicles');

  const link = document.querySelector('link[data-feature="hiscores"]');
  assert.ok(link, 'hiscores.css stylesheet link injected');
  assert.match(link.href, /hiscores\.css$/);
});

test('panel open auto-fetches active tab and respects 30s staleness window', () => {
  const h = harness();
  h.open();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], {
    verb: 'chronicles.board',
    args: { board: 'overall', page: 1, pageSize: 20 },
  });

  h.emitChronicles({
    subkind: 'board',
    board: 'overall',
    page: 1,
    pageSize: 20,
    total: 1,
    entries: [{ rank: 1, name: 'Lyra', className: 'Mage', race: 'Breton', score: 1200, level: 12 }],
  });

  // Re-opening within 30s should not re-fetch
  h.close();
  h.advance(10_000);
  h.open();
  assert.equal(h.sent.length, 1);

  // Re-opening after > 30s should re-fetch
  h.close();
  h.advance(25_000);
  h.open();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].verb, 'chronicles.board');
});

test('rankings tab renders board selector (7 core, 6 guilds, 35 skills), medals, self row, filters, and pagination', () => {
  const h = harness({ selfName: 'Lyra' });
  h.open();

  const select = h.root.byClass('hs-board-select')[0];
  const options = select.all((e) => e.tagName === 'OPTION');
  assert.equal(options.length, CORE_BOARDS.length + GUILD_BOARDS.length + SKILL_BOARDS.length);
  assert.equal(CORE_BOARDS.length, 7);
  assert.equal(GUILD_BOARDS.length, 6);
  assert.equal(SKILL_BOARDS.length, 35);

  h.emitChronicles({
    subkind: 'board',
    board: 'overall',
    page: 1,
    pageSize: 20,
    total: 45,
    totalPages: 3,
    entries: [
      { rank: 1, id: 'c1', name: 'Aurelia', className: 'Knight', race: 'Redguard', score: 2100, level: 19, orderTag: 'SUN' },
      { rank: 2, id: 'char-self', name: 'Lyra', className: 'Mage', race: 'Breton', score: 1850, level: 16, orderTag: 'BAY' },
      { rank: 3, id: 'c3', name: 'Vael', className: 'Assassin', race: 'Dark Elf', score: 1700, level: 15 },
    ],
  });

  assert.equal(h.root.byClass('hs-rank-1').length, 1);
  assert.equal(h.root.byClass('hs-rank-2').length, 1);
  assert.equal(h.root.byClass('hs-rank-3').length, 1);
  const selfRows = h.root.byClass('hs-row-self');
  assert.equal(selfRows.length, 1);
  assert.match(selfRows[0].textContent, /Lyra/);
  assert.match(selfRows[0].textContent, /\[BAY\]/);
  assert.match(h.text(), /Page 1 of 3 \(45 ranked\)/);

  // Pagination Next
  h.root.byClass('hs-page-next')[0].click();
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.board',
    args: { board: 'overall', page: 2, pageSize: 20 },
  });

  // Search with Enter key + class/race filters reset page to 1
  const search = h.root.byClass('hs-search')[0];
  search.value = 'Aur';
  search.dispatch('input');
  search.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.board',
    args: { board: 'overall', page: 1, pageSize: 20, search: 'Aur' },
  });

  const classSel = h.root.byClass('hs-filter-class')[0];
  classSel.value = 'Knight';
  classSel.dispatch('change');
  assert.deepEqual(h.sent.at(-1).args.className, 'Knight');

  const raceSel = h.root.byClass('hs-filter-race')[0];
  raceSel.value = 'Redguard';
  raceSel.dispatch('change');
  assert.deepEqual(h.sent.at(-1).args.race, 'Redguard');
});

test('clicking a player row opens their 35-skill profile, and clicking a skill opens its leaderboard', () => {
  const h = harness({ selfName: 'Lyra' });
  h.open();
  h.emitChronicles({
    subkind: 'board',
    board: 'overall',
    page: 1,
    pageSize: 20,
    total: 2,
    entries: [
      { rank: 1, id: 'c1', name: 'Aurelia', className: 'Spellsword', race: 'Breton', score: 1420, level: 14 },
    ],
  });

  // Click player button -> switches to player tab & requests chronicles.player
  h.root.byClass('hs-player-btn')[0].click();
  assert.equal(h.mod.ui.tab, 'player');
  assert.deepEqual(h.sent.at(-1), { verb: 'chronicles.player', args: { name: 'Aurelia' } });

  const playerTab = h.root.byClass('hs-tab').find((b) => b.attrs['data-tab'] === 'player');
  assert.equal(playerTab.getAttribute('aria-selected'), 'true');

  // Deliver profile
  h.emitChronicles({ subkind: 'player', player: sampleProfile('Aurelia') });

  assert.equal(h.root.byClass('hs-profile-head').length, 1);
  assert.equal(h.root.byClass('hs-stat-card').length, 7);
  assert.match(h.text(), /412 \/ 15,251/);
  assert.match(h.text(), /Commodore/);
  assert.match(h.text(), /Compare with Me/);

  const skillCells = h.root.byClass('hs-skill-cell');
  assert.equal(skillCells.length, 35, 'renders all 35 classic skills');
  const maxCells = h.root.byClass('hs-skill-max');
  assert.equal(maxCells.length, 1, 'Long Blade at 100 gets hs-skill-max');
  assert.equal(maxCells[0].attrs['data-skill'], 'Long Blade');

  // Click Long Blade skill -> opens board tab on skill:long-blade
  maxCells[0].click();
  assert.equal(h.mod.ui.tab, 'board');
  assert.equal(h.mod.ui.board, 'skill:long-blade');
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.board',
    args: { board: 'skill:long-blade', page: 1, pageSize: 20 },
  });
});

test('comparing two adventurers renders win banner and delta classes across core + 35 skills', () => {
  const h = harness({ selfName: 'Lyra' });
  h.open();

  // Open Aurelia's profile and click "Compare with Me"
  h.mod.ui.tab = 'player';
  h.emitChronicles({ subkind: 'player', player: sampleProfile('Aurelia') });
  h.root.byClass('hs-compare-me-btn')[0].click();

  assert.equal(h.mod.ui.tab, 'compare');
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.compare',
    args: { a: 'Lyra', b: 'Aurelia' },
  });

  const left = sampleProfile('Lyra', {
    level: 18,
    totalSkill: 1600,
    core: {
      overall: { score: 1600, rank: 1 },
      level: { score: 18, rank: 1 },
      cartography: { score: 412, rank: 5 },
      quests: { score: 35, rank: 2 },
      slayer: { score: 200, rank: 10 },
      wanted: { score: 0, rank: null },
      admiralty: { score: 8, rank: 1 },
    },
    skills: {
      'Long Blade': { level: 90, rank: 2 },
      Destruction: { level: 95, rank: 1 },
    },
  });
  const right = sampleProfile('Aurelia');
  h.emitChronicles({ subkind: 'compare', a: left, b: right });

  const banner = h.root.byClass('hs-compare-banner')[0];
  assert.ok(banner, 'compare banner rendered');
  assert.match(banner.textContent, /(leads|Tied).*\(\d+ tied\)/);
  assert.ok(h.root.byClass('hs-delta-pos').length > 0, 'positive delta cells present');
  assert.ok(h.root.byClass('hs-delta-neg').length > 0, 'negative delta cells present');
  assert.ok(h.root.byClass('hs-delta-tie').length > 0, 'tie delta cells present');

  const rows = h.root.byClass('hs-compare-table')[0].all((e) => e.tagName === 'TR');
  assert.equal(rows.length, 1 + 7 + 35, 'header + 7 core boards + 35 skills');
});

test('player orders tab supports sorting, search, rendering, and pagination', () => {
  const h = harness();
  h.open();

  const ordersTab = h.root.byClass('hs-tab').find((b) => b.attrs['data-tab'] === 'orders');
  ordersTab.click();
  assert.equal(h.mod.ui.tab, 'orders');
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.orders',
    args: { sort: 'members', page: 1, pageSize: 20 },
  });

  h.emitChronicles({
    subkind: 'orders',
    sort: 'members',
    page: 1,
    pageSize: 20,
    total: 25,
    totalPages: 2,
    entries: [
      { rank: 1, tag: 'WOLF', name: 'Order of the Silver Wolf', leaderName: 'Aurelia', memberCount: 18, combinedLevel: 214, treasury: 54000 },
    ],
  });

  assert.match(h.text(), /\[WOLF\]/);
  assert.match(h.text(), /Order of the Silver Wolf/);
  assert.match(h.text(), /54,000g/);
  assert.match(h.text(), /Page 1 of 2 \(25 orders\)/);

  // Switch sort to Treasury
  const treasuryBtn = h.root.byClass('hs-sort-btn').find((b) => b.attrs['data-sort'] === 'treasury');
  treasuryBtn.click();
  assert.deepEqual(h.sent.at(-1), {
    verb: 'chronicles.orders',
    args: { sort: 'treasury', page: 1, pageSize: 20 },
  });
});

test('privacy toggle syncs with state/events and sends chronicles.privacy', () => {
  const h = harness({ hidden: false });
  h.open();

  const toggle = h.root.byClass('hs-privacy-toggle')[0];
  assert.equal(toggle.checked, true, 'publicly listed by default when hidden=false');

  // Uncheck -> hidden: true
  toggle.checked = false;
  toggle.dispatch('change');
  assert.deepEqual(h.sent.at(-1), { verb: 'chronicles.privacy', args: { hidden: true } });

  // Server confirms hidden=true
  h.emitChronicles({ subkind: 'privacy', hidden: true });
  assert.equal(h.root.byClass('hs-privacy-toggle')[0].checked, false);

  // Check -> hidden: false
  const toggle2 = h.root.byClass('hs-privacy-toggle')[0];
  toggle2.checked = true;
  toggle2.dispatch('change');
  assert.deepEqual(h.sent.at(-1), { verb: 'chronicles.privacy', args: { hidden: false } });
});
