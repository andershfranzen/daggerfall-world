// Client-side website integration tests:
// - ?place= deep-link parsing, api.initialPlace setter/consumer, and travel.js catalog pre-selection
// - Bug-report draft serialization, live/failure context, quota fallback & 1.5 MiB screenshot guard
// - Patch-notes JSON Feed parsing & seen/unseen localStorage tracking
// - Account panel links (/signup/?mode=recover, /signup/), Settings card links, and play.html markup
// - Chronicles / Hiscores web URL builders & HUD Copy/Open web link controls
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUG_DRAFT_KEY,
  SEEN_PATCH_KEY,
  BUG_REPORT_URL,
  PATCH_NOTES_URL,
  MAX_SCREENSHOT_BYTES,
  ACCOUNT_LINKS,
  WEBSITE_LINKS,
  parseInitialPlace,
  parseLatestPatchNote,
  isPatchNoteUnseen,
  markPatchNoteSeen,
  sanitizeScreenshot,
  captureCanvasScreenshot,
  detectWebglRenderer,
  buildBugDraft,
  saveBugDraft,
  hiscoresWebUrl,
  hiscoresBoardWebUrl,
  hiscoresPlayerWebUrl,
} from '../client/lib/web-integration.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import { builtinPanels } from '../client/gameplay/shell.js';
import { install as installTravel } from '../client/gameplay/travel.js';
import { install as installHiscores } from '../client/gameplay/hiscores.js';

function memStorage({ failWhen = null } = {}) {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const str = String(v);
      if (failWhen && failWhen(k, str)) throw new Error('QuotaExceededError');
      map.set(k, str);
    },
    removeItem: (k) => map.delete(k),
  };
}

// Minimal DOM stub for rendering shell Settings card & hiscores panel in Node.
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
  click() {
    if (this.disabled) return;
    for (const f of this.listeners.click ?? []) f({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} });
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
}

function installDomStub() {
  const prevNode = globalThis.Node;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const head = new El0('head');
  const body = new El0('body');
  globalThis.Node = Node0;
  globalThis.document = {
    head,
    body,
    createElement: (t) => new El0(t),
    createTextNode: (t) => new Text0(t),
    querySelector: (sel) => head.querySelector(sel) || body.querySelector(sel),
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
  return () => {
    globalThis.Node = prevNode;
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  };
}

// ---------------------------------------------------------------- ?place= deep-linking

describe('map deep-linking (?place= parsing & consumption)', () => {
  test('parseInitialPlace parses encoded town ids and ignores invalid values', () => {
    assert.equal(parseInitialPlace('?place=town%3ADaggerfall%2FGothway%20Garden'), 'town:Daggerfall/Gothway Garden');
    assert.equal(parseInitialPlace('?foo=1&place=town:17/123&bar=2'), 'town:17/123');
    assert.equal(parseInitialPlace('place=  town:Wayrest/Wayrest  '), 'town:Wayrest/Wayrest');
    assert.equal(parseInitialPlace('?other=1'), null);
    assert.equal(parseInitialPlace('?place='), null);
    assert.equal(parseInitialPlace('?place=%20%20'), null);
    assert.equal(parseInitialPlace(''), null);
    assert.equal(parseInitialPlace(null), null);
    assert.equal(parseInitialPlace(`?place=${'a'.repeat(201)}`), null);
  });

  test('api.setInitialPlace and api.consumeInitialPlace store, emit, and clear initialPlace', () => {
    const api = createGameplayApi();
    const seen = [];
    api.on('initialPlace', (p) => seen.push(p));

    assert.equal(api.initialPlace, null);
    assert.equal(api.setInitialPlace('  town:Daggerfall/Daggerfall  '), 'town:Daggerfall/Daggerfall');
    assert.equal(api.initialPlace, 'town:Daggerfall/Daggerfall');
    assert.deepEqual(seen, ['town:Daggerfall/Daggerfall']);

    // api._reset() preserves a pending deep link until the Travel Map consumes it.
    api._reset();
    assert.equal(api.initialPlace, 'town:Daggerfall/Daggerfall');

    assert.equal(api.consumeInitialPlace(), 'town:Daggerfall/Daggerfall');
    assert.equal(api.initialPlace, null);
    assert.equal(api.consumeInitialPlace(), null);
  });

  test('travel.js resolves api.initialPlace against catalog, selects destination & region, and clears it', () => {
    const restore = installDomStub();
    try {
      const api = createGameplayApi();
      api.setInitialPlace('town:Daggerfall/Daggerfall');
      const travel = installTravel(api);

      const entry = {
        id: 'town:Daggerfall/Daggerfall',
        name: 'Daggerfall',
        region: 'Daggerfall',
        regionIndex: 17,
        type: 'city',
        x: 109,
        y: 159,
      };
      const fakeWorld = {
        catalog: {
          get: (id) => (id === entry.id ? entry : null),
        },
      };

      assert.equal(travel.applyInitialPlace(fakeWorld), true);
      assert.equal(travel.state.selected, entry);
      assert.equal(travel.state.region, 17);
      assert.equal(api.initialPlace, null, 'api.initialPlace is cleared once applied');

      // Second call is a no-op since initialPlace was cleared.
      assert.equal(travel.applyInitialPlace(fakeWorld), false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------- bug-report draft & screenshot guard

describe('bug-report draft serialization & screenshot guard', () => {
  test('buildBugDraft normalizes category, failure error summary, and live gameplay context', () => {
    const failDraft = buildBugDraft({
      createdAt: 1700000000000,
      category: 'gameplay',
      title: 'Could not raise the town',
      context: {
        screen: 'failure',
        errorTitle: 'Could not raise the town',
        errorMessage: 'Missing MAPS.BSA',
        errorHint: 'Choose the ARENA2 folder',
        url: 'https://daggerfall.world/play.html',
      },
      screenshot: null,
    });

    assert.equal(failDraft.createdAt, 1700000000000);
    assert.equal(failDraft.category, 'gameplay');
    assert.equal(failDraft.title, 'Could not raise the town');
    assert.equal(failDraft.context.screen, 'failure');
    assert.equal(failDraft.context.errorTitle, 'Could not raise the town');
    assert.equal(failDraft.context.errorMessage, 'Missing MAPS.BSA');
    assert.equal(failDraft.context.errorHint, 'Choose the ARENA2 folder');
    assert.match(failDraft.context.error, /Could not raise the town.*Missing MAPS\.BSA/);
    assert.equal(failDraft.screenshot, null);

    const liveDraft = buildBugDraft({
      category: 'not-a-valid-category',
      descriptionHint: 'Fell through floor near tavern',
      context: {
        screen: 'game',
        location: 'Gothway Garden',
        locationId: 'town:Daggerfall/Gothway Garden',
        region: 'Daggerfall',
        panel: 'settings',
        conn: 'online',
        renderer: 'ANGLE (Intel)',
      },
      screenshot: { name: 'shot.webp', data: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=' },
    });

    assert.equal(liveDraft.category, 'gameplay');
    assert.equal(liveDraft.descriptionHint, 'Fell through floor near tavern');
    assert.equal(liveDraft.context.location, 'Gothway Garden');
    assert.equal(liveDraft.context.locationId, 'town:Daggerfall/Gothway Garden');
    assert.equal(liveDraft.context.region, 'Daggerfall');
    assert.equal(liveDraft.context.panel, 'settings');
    assert.equal(liveDraft.context.conn, 'online');
    assert.equal(liveDraft.context.renderer, 'ANGLE (Intel)');
    assert.equal(liveDraft.screenshot.name, 'shot.webp');
  });

  test('screenshot guard caps size under 1.5 MiB and rejects invalid data URLs', () => {
    const valid = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
    assert.deepEqual(sanitizeScreenshot({ name: 'test.webp', data: valid }), { name: 'test.webp', data: valid });

    const oversized = `data:image/webp;base64,${'A'.repeat(MAX_SCREENSHOT_BYTES + 16)}`;
    assert.equal(sanitizeScreenshot({ name: 'huge.webp', data: oversized }), null);
    assert.equal(sanitizeScreenshot({ name: 'bad.svg', data: 'data:image/svg+xml;base64,PHN2Zz4=' }), null);
    assert.equal(sanitizeScreenshot({ name: 'empty', data: '' }), null);

    const mockCanvas = {
      width: 1280,
      height: 720,
      toDataURL(type, quality) {
        assert.equal(type, 'image/webp');
        assert.equal(quality, 0.78);
        return valid;
      },
    };
    const shot = captureCanvasScreenshot(mockCanvas);
    assert.deepEqual(shot, { name: 'gameplay-screenshot.webp', data: valid });

    const hugeCanvas = { width: 4096, height: 2160, toDataURL: () => oversized };
    assert.equal(captureCanvasScreenshot(hugeCanvas), null);

    const throwingCanvas = { width: 640, height: 480, toDataURL: () => { throw new Error('tainted'); } };
    assert.equal(captureCanvasScreenshot(throwingCanvas), null);

    const zeroCanvas = { width: 0, height: 0, toDataURL: () => valid };
    assert.equal(captureCanvasScreenshot(zeroCanvas), null);
  });

  test('saveBugDraft writes localStorage[dfw_bug_draft] and falls back without screenshot on quota error', () => {
    const valid = 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
    const storage = memStorage();
    const res = saveBugDraft({
      createdAt: 1700000000001,
      category: 'performance',
      context: { screen: 'game', location: 'Wayrest' },
      screenshot: { name: 's.webp', data: valid },
    }, storage);

    assert.equal(res.ok, true);
    assert.equal(res.droppedScreenshot, false);
    const parsed = JSON.parse(storage.getItem(BUG_DRAFT_KEY));
    assert.equal(parsed.category, 'performance');
    assert.equal(parsed.context.location, 'Wayrest');
    assert.equal(parsed.screenshot.data, valid);

    // Simulate QuotaExceededError when screenshot is included
    const tightStorage = memStorage({ failWhen: (_k, v) => v.includes('base64') });
    const res2 = saveBugDraft({
      createdAt: 1700000000002,
      category: 'performance',
      context: { screen: 'game', location: 'Sentinel' },
      screenshot: { name: 's.webp', data: valid },
    }, tightStorage);

    assert.equal(res2.ok, true);
    assert.equal(res2.droppedScreenshot, true);
    const parsed2 = JSON.parse(tightStorage.getItem(BUG_DRAFT_KEY));
    assert.equal(parsed2.context.location, 'Sentinel');
    assert.equal(parsed2.screenshot, null);
    assert.equal(BUG_REPORT_URL, '/report-bug/?from=game');
  });

  test('detectWebglRenderer safely extracts unmasked or fallback WebGL renderer', () => {
    const gl = {
      RENDERER: 0x1f01,
      getExtension: (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null),
      getParameter: (param) => (param === 0x9246 ? 'NVIDIA GeForce RTX' : 'WebGL'),
    };
    assert.equal(detectWebglRenderer({ gl }), 'NVIDIA GeForce RTX');
    assert.equal(detectWebglRenderer(null), '');
  });
});

// ---------------------------------------------------------------- patch-notes feed parsing

describe('launcher patch-notes feed parsing & seen state', () => {
  test('parseLatestPatchNote picks the newest feed item and extracts date + headline', () => {
    const feed = {
      version: 'https://jsonfeed.org/version/1.1',
      items: [
        {
          id: 'https://daggerfall.world/patch-notes/#2026-11-25-alpha',
          title: 'Alpha',
          date_published: '2026-11-25T00:00:00Z',
          content_text: '• Opened alpha.',
        },
        {
          id: 'https://daggerfall.world/patch-notes/#2026-11-26-interface',
          title: 'Interface & HUD',
          date_published: '2026-11-26T00:00:00Z',
          content_text: '• Rebuilt Inventory.',
        },
      ],
    };

    const latest = parseLatestPatchNote(feed);
    assert.deepEqual(latest, {
      id: 'https://daggerfall.world/patch-notes/#2026-11-26-interface',
      date: '2026-11-26',
      headline: 'Interface & HUD',
      url: PATCH_NOTES_URL,
    });
  });

  test('parseLatestPatchNote falls back to first bullet line when title is omitted and rejects empty feeds', () => {
    const latest = parseLatestPatchNote({
      items: [{ id: 'p2', date_published: '2026-11-26T00:00:00Z', content_text: '• Fixed fast travel camera.\n• Other fix.' }],
    });
    assert.equal(latest.headline, 'Fixed fast travel camera.');
    assert.equal(latest.date, '2026-11-26');
    assert.equal(parseLatestPatchNote({ items: [] }), null);
    assert.equal(parseLatestPatchNote(null), null);
  });

  test('seen patch tracking reads and writes localStorage[dfw_seen_patch_id]', () => {
    const storage = memStorage();
    const id = 'https://daggerfall.world/patch-notes/#2026-11-26-interface';
    assert.equal(isPatchNoteUnseen(id, storage), true);
    assert.equal(markPatchNoteSeen(id, storage), true);
    assert.equal(storage.getItem(SEEN_PATCH_KEY), id);
    assert.equal(isPatchNoteUnseen(id, storage), false);
    assert.equal(isPatchNoteUnseen('https://daggerfall.world/patch-notes/#2026-11-27-next', storage), true);
  });
});

// ---------------------------------------------------------------- account links & Settings card

describe('account links, play.html markup, and Settings -> Account card', () => {
  test('account.js includes Forgot password? (/signup/?mode=recover) and Account settings (/signup/)', () => {
    assert.equal(ACCOUNT_LINKS.recover, '/signup/?mode=recover');
    assert.equal(ACCOUNT_LINKS.settings, '/signup/');

    const accountSrc = readFileSync(new URL('../client/auth/account.js', import.meta.url), 'utf8');
    assert.match(accountSrc, /href:\s*['"]\/signup\/\?mode=recover['"]/);
    assert.match(accountSrc, /Forgot password\?/);
    assert.match(accountSrc, /href:\s*['"]\/signup\/['"]/);
    assert.match(accountSrc, /Account settings/);

    const playHtml = readFileSync(new URL('../client/play.html', import.meta.url), 'utf8');
    assert.match(playHtml, /id="whats-new"/);
    assert.match(playHtml, /href="\/patch-notes\/"/);
    assert.match(playHtml, /id="failure-report"/);
    assert.match(playHtml, /Report a bug/);
  });

  test('Settings -> Account card renders Account settings, Report a bug action, and Website links row', () => {
    const restore = installDomStub();
    try {
      const api = createGameplayApi();
      api.account = { id: 'u1', username: 'Lyra' };
      const bugCalls = [];
      api.openBugReport = (opts) => bugCalls.push(opts);
      api._shellContext = {
        settings: {
          sensitivity: 1,
          invertY: false,
          clickAttack: true,
          uiScale: 1,
          showTarget: true,
          classicCompass: false,
          bindings: {},
        },
        apply() {},
        startRebind() {},
        leave() {},
      };

      const container = new El0('div');
      builtinPanels.settings(container, api);

      const accountCard = container.byClass('settings-account')[0];
      assert.ok(accountCard, 'Account card rendered');

      const anchors = accountCard.all((e) => e.tagName === 'A');
      const byHref = new Map(anchors.map((a) => [a.getAttribute('href'), a]));

      assert.ok(byHref.has('/signup/'), 'Account settings link present');
      assert.equal(byHref.get('/signup/').getAttribute('target'), '_blank');
      assert.equal(byHref.get('/signup/').getAttribute('rel'), 'noopener');

      for (const item of WEBSITE_LINKS) {
        const a = byHref.get(item.href);
        assert.ok(a, `Website link ${item.href} present`);
        assert.equal(a.textContent, item.label);
        assert.equal(a.getAttribute('target'), '_blank');
        assert.equal(a.getAttribute('rel'), 'noopener');
      }

      const bugBtn = accountCard.all((e) => e.tagName === 'BUTTON' && e.textContent.includes('Report a bug'))[0];
      assert.ok(bugBtn, 'Report a bug button present');
      bugBtn.click();
      assert.deepEqual(bugCalls, [{ panel: 'settings' }]);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------- hiscores web URL builders & HUD buttons

describe('Chronicles / Hiscores web URL builders and HUD controls', () => {
  test('hiscoresWebUrl encodes board and player query params with or without origin', () => {
    assert.equal(hiscoresPlayerWebUrl('Lady Brisienna'), '/hiscores/?player=Lady%20Brisienna');
    assert.equal(
      hiscoresPlayerWebUrl('Lady Brisienna', 'https://daggerfall.world'),
      'https://daggerfall.world/hiscores/?player=Lady%20Brisienna',
    );
    assert.equal(
      hiscoresBoardWebUrl('skill:long-blade', 'https://daggerfall.world/'),
      'https://daggerfall.world/hiscores/?board=skill%3Along-blade',
    );
    assert.equal(hiscoresWebUrl({ board: 'overall', origin: 'file://' }), '/hiscores/?board=overall');
    assert.equal(hiscoresWebUrl({}), '/hiscores/?board=overall');
  });

  test('hiscores HUD board header and player profile include Copy web link and Open on web controls', async () => {
    const restore = installDomStub();
    const prevLoc = globalThis.location;
    const prevNav = globalThis.navigator;
    const copied = [];
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://daggerfall.world', href: 'https://daggerfall.world/play.html' },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: (txt) => { copied.push(txt); return Promise.resolve(); } } },
    });
    try {
      const api = createGameplayApi({ send: () => true });
      const root = new El0('div');
      document.body.replaceChildren(root);
      api._attachShell({
        open(id) { api._setModal(true, id); api.getPanel(id).render(root, api); api.emit('panel', { id, open: true }); },
        close() { api._setModal(false); },
        refresh() { api.getPanel('hiscores').render(root, api); },
        panelsChanged() {},
      });
      const mod = installHiscores(api);
      api.openPanel('hiscores');

      // Board view controls
      const boardCopy = root.byClass('hs-copy-link')[0];
      const boardOpen = root.byClass('hs-web-link')[0];
      assert.ok(boardCopy, 'board Copy web link button present');
      assert.ok(boardOpen, 'board Open on web link present');
      assert.equal(boardOpen.getAttribute('href'), '/hiscores/?board=overall');
      assert.equal(boardOpen.getAttribute('target'), '_blank');
      assert.equal(boardOpen.getAttribute('rel'), 'noopener');

      boardCopy.click();
      assert.equal(copied.at(-1), 'https://daggerfall.world/hiscores/?board=overall');

      // Player profile controls
      mod.ui.tab = 'player';
      api.emit('event', {
        kind: 'chronicles',
        subkind: 'player',
        player: { name: 'Lady Brisienna', className: 'Mage', race: 'Breton', level: 12, totalSkill: 980, core: {}, skills: {} },
      });

      const profCopy = root.byClass('hs-copy-link')[0];
      const profOpen = root.byClass('hs-web-link')[0];
      assert.ok(profCopy, 'profile Copy web link button present');
      assert.ok(profOpen, 'profile Open on web link present');
      assert.equal(profOpen.getAttribute('href'), '/hiscores/?player=Lady%20Brisienna');
      assert.equal(profOpen.getAttribute('target'), '_blank');
      assert.equal(profOpen.getAttribute('rel'), 'noopener');

      profCopy.click();
      assert.equal(copied.at(-1), 'https://daggerfall.world/hiscores/?player=Lady%20Brisienna');
    } finally {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: prevLoc });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
      restore();
    }
  });
});
