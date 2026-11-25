import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { peerToDollRpg, renderPeerPaperDoll, install } from '../client/gameplay/peerInspect.js';
import { dollLayers } from '../client/gameplay/inventory/images.js';
import { DOLL_WIDTH, DOLL_HEIGHT } from '../client/gameplay/inventory/paperdoll.js';

// Minimal DOM shim for headless Node testing (zero external dependencies)
function createFakeDom() {
  class FakeNode {
    constructor(tag = '#text') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.dataset = {};
      this.listeners = new Map();
      this._text = '';
      this.className = '';
      this.value = '';
      this.disabled = false;
      this.id = '';
      this.isConnected = true;
      this.classList = {
        add: (...cls) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          this.className = [...set].join(' ');
        },
        contains: (c) => this.className.split(/\s+/).includes(c),
      };
    }

    get textContent() {
      if (!this.children.length) return this._text;
      return this.children.map((c) => c.textContent).join('');
    }

    set textContent(v) {
      this._text = String(v ?? '');
      this.children = [];
    }

    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'disabled') this.disabled = true;
      if (k.startsWith('data-')) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }

    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }

    append(...nodes) {
      for (const n of nodes) {
        if (n instanceof FakeNode) {
          n.parentElement = this;
          this.children.push(n);
        } else {
          const t = new FakeNode('#text');
          t._text = String(n);
          t.parentElement = this;
          this.children.push(t);
        }
      }
    }

    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    click() {
      if (this.disabled) return;
      for (const fn of this.listeners.get('click') ?? []) fn({ target: this, currentTarget: this });
    }

    focus() {
      this._focused = true;
    }

    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    }

    querySelectorAll(sel) {
      const out = [];
      const match = (node) => {
        if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
        const attrMatch = sel.match(/^([a-z0-9]*)?\[([^=\]]+)(?:="([^"]*)")?\]$/i);
        if (attrMatch) {
          const [, tag, attr, val] = attrMatch;
          if (tag && node.tagName !== tag.toUpperCase()) return false;
          const got = node.getAttribute(attr) ?? (attr.startsWith('data-') ? node.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : undefined);
          return val !== undefined ? got === val : got != null;
        }
        return node.tagName === sel.toUpperCase();
      };
      const walk = (node) => {
        for (const ch of node.children) {
          if (match(ch)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }

    getContext(kind) {
      if (this.tagName !== 'CANVAS' || kind !== '2d') return null;
      if (!this._ctx) this._ctx = createMockCtx();
      return this._ctx;
    }
  }

  const head = new FakeNode('head');
  const byId = new Map();
  const doc = {
    head,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const t = new FakeNode('#text');
      t._text = String(text);
      return t;
    },
    querySelector: (sel) => head.querySelector(sel),
    getElementById: (id) => byId.get(id) ?? null,
    _registerId: (id, node) => { node.id = id; byId.set(id, node); },
  };
  return { FakeNode, doc };
}

function createMockCtx() {
  const ops = [];
  return {
    ops,
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    clearRect(x, y, w, h) { ops.push(['clearRect', x, y, w, h]); },
    fillRect(x, y, w, h) { ops.push(['fillRect', x, y, w, h, this.fillStyle]); },
    strokeRect(x, y, w, h) { ops.push(['strokeRect', x, y, w, h, this.strokeStyle]); },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(imgData, x, y) { ops.push(['putImageData', imgData, x, y]); },
  };
}

function createMockApi(peers = []) {
  const listeners = new Map();
  const panels = new Map();
  const actions = [];
  const opened = [];
  const messages = [];
  let closed = false;
  const api = {
    selfId: 'self-1',
    state: { selfId: 'self-1', peers },
    files: [],
    panel: null,
    panels,
    actions,
    opened,
    messages,
    get closed() { return closed; },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev)?.delete(fn);
    },
    emit(ev, detail) {
      for (const fn of listeners.get(ev) ?? []) fn(detail);
    },
    registerPanel(id, title, render) {
      panels.set(id, { id, title, render });
    },
    hasPanel(id) {
      return panels.has(id);
    },
    openPanel(id, detail) {
      api.panel = id;
      opened.push({ id, detail });
    },
    closePanel() {
      api.panel = null;
      closed = true;
    },
    act(verb, args) {
      actions.push({ verb, args });
      return Promise.resolve({ ok: true });
    },
    message(text, opts) {
      messages.push({ text, opts });
    },
  };
  return api;
}

const SAMPLE_PEER = {
  id: 'peer-42',
  name: 'Lyra Vance',
  race: 'dark elf',
  gender: 'female',
  faceIndex: 4,
  className: 'Spellsword',
  level: 11,
  orderTag: 'BLADE',
  guildTitle: 'Magician of the Mages Guild',
  mounted: true,
  readied: true,
  // Private fields that MUST NOT leak
  gold: 99999,
  health: 42,
  maxHealth: 100,
  quests: [{ title: 'Secret Quest' }],
  worn: {
    head: { name: 'Steel Helm', material: 'Steel', doll: { set: 'armor', record: 29, drawOrder: 0, dye: 'steel' }, armorValue: 18 },
    cloak: { name: 'Blue Casual Cloak', dye: 'Blue', doll: { set: 'clothing', male: 21, female: 21, drawOrder: 90, cloak: true, dye: 'blue' } },
    chestArmor: { name: 'Mithril Cuirass', material: 'Mithril', doll: { set: 'armor', record: 12, drawOrder: 40, dye: 'mithril' }, armorValue: 22 },
    chestClothes: { name: 'White Short Shirt', dye: 'White', doll: { set: 'clothing', male: 42, female: 42, drawOrder: 20, dye: 'white' } },
    legsClothes: { name: 'Brown Casual Pants', dye: 'Brown', doll: { set: 'clothing', male: 60, female: 60, drawOrder: 10, dye: 'brown' } },
    feet: { name: 'Leather Boots', material: 'Leather', doll: { set: 'armor', record: 5, drawOrder: 15, dye: 'silver' } },
    rightHand: { name: 'Daedric Longsword', material: 'Daedric', doll: { set: 'weapon', record: 12, drawOrder: 100, dye: 'daedric' }, damage: { min: 15, max: 32 } },
    leftHand: { name: 'Steel Kite Shield', material: 'Steel', group: 'shield', doll: { set: 'armor', record: 38, drawOrder: 95, dye: 'steel' } },
  },
};

test('peerToDollRpg maps peer identity & worn slots into buildDoll/dollLayers shape without leaking private stats', () => {
  const rpg = peerToDollRpg(SAMPLE_PEER);
  assert.deepEqual(rpg.character, {
    race: 'Dark Elf',
    gender: 'Female',
    faceIndex: 4,
    className: 'Spellsword',
  });
  assert.equal(Object.keys(rpg.equipment).length, 8);
  assert.equal(rpg.inventory.length, 8);

  // Compatible with dollLayers draw order
  const layers = dollLayers(rpg);
  assert.equal(layers.length, 8);
  assert.equal(layers[0].slot, 'head', 'drawOrder 0 comes first');
  assert.equal(layers[layers.length - 1].slot, 'rightHand', 'drawOrder 100 comes last');

  // No private stats leaked onto rpg or items
  const serialized = JSON.stringify(rpg);
  assert.ok(!serialized.includes('99999'), 'gold must not leak');
  assert.ok(!serialized.includes('Secret Quest'), 'quests must not leak');
  assert.ok(!serialized.includes('armorValue'), 'armorValue must not leak');
  assert.ok(!serialized.includes('damage'), 'damage must not leak');

  // Defaults & faceIndex clamping & peer.weapon fallback
  const minimal = peerToDollRpg({ race: 'unknown-race', gender: 'm', faceIndex: 99, weapon: 'Iron Dagger' });
  assert.deepEqual(minimal.character, { race: 'Breton', gender: 'Male', faceIndex: 0, className: 'Traveller' });
  assert.ok(minimal.equipment.rightHand);
  assert.equal(minimal.inventory[0].name, 'Iron Dagger');
});

test('renderPeerPaperDoll blits 110x184 RGBA when buildDollFn succeeds with crisp pixel rendering', async () => {
  const ctx = createMockCtx();
  const canvas = { width: 0, height: 0, dataset: {}, getContext: () => ctx };
  const rgba = new Uint8ClampedArray(DOLL_WIDTH * DOLL_HEIGHT * 4);
  rgba[0] = 200; rgba[1] = 120; rgba[2] = 60; rgba[3] = 255;

  let receivedRpg = null;
  const res = await renderPeerPaperDoll(canvas, SAMPLE_PEER, {
    art: { mock: true },
    palette: new Uint8Array(768),
    buildDollFn: async (_art, _pal, rpg) => {
      receivedRpg = rpg;
      return { rgba, hits: new Int16Array(DOLL_WIDTH * DOLL_HEIGHT), slots: ['head'], drawn: ['head', 'rightHand'] };
    },
  });

  assert.equal(res.mode, 'classic');
  assert.equal(canvas.width, DOLL_WIDTH);
  assert.equal(canvas.height, DOLL_HEIGHT);
  assert.equal(ctx.imageSmoothingEnabled, false);
  assert.equal(canvas.dataset.dollMode, 'classic');
  assert.equal(canvas.dataset.layers, 'head rightHand');
  assert.equal(receivedRpg.character.race, 'Dark Elf');
  const putOp = ctx.ops.find((o) => o[0] === 'putImageData');
  assert.ok(putOp, 'putImageData must be called');
  assert.equal(putOp[1].data[0], 200);
  assert.equal(putOp[1].data[3], 255);
});

test('renderPeerPaperDoll renders stylized fallback silhouette when ARENA2 is unavailable or buildDoll returns null', async () => {
  const ctx1 = createMockCtx();
  const canvas1 = { width: 0, height: 0, dataset: {}, getContext: () => ctx1 };
  const res1 = await renderPeerPaperDoll(canvas1, SAMPLE_PEER);
  assert.equal(res1.mode, 'fallback');
  assert.equal(canvas1.width, DOLL_WIDTH);
  assert.equal(canvas1.height, DOLL_HEIGHT);
  assert.equal(ctx1.imageSmoothingEnabled, false);
  assert.equal(canvas1.dataset.dollMode, 'fallback');
  const fills = ctx1.ops.filter((o) => o[0] === 'fillRect');
  assert.ok(fills.length >= 15, `expected rich stylized silhouette draw calls, got ${fills.length}`);

  // Also falls back cleanly when buildDollFn returns null
  const ctx2 = createMockCtx();
  const canvas2 = { width: 0, height: 0, dataset: {}, getContext: () => ctx2 };
  const res2 = await renderPeerPaperDoll(canvas2, SAMPLE_PEER, { buildDollFn: async () => null });
  assert.equal(res2.mode, 'fallback');
  assert.ok(ctx2.ops.some((o) => o[0] === 'fillRect'));
});

test('install(api) registers inspect panel, exposes api.inspectPeer, renders attire/actions, and handles peer selector', async () => {
  const { FakeNode, doc } = createFakeDom();
  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  globalThis.document = doc;
  globalThis.Node = FakeNode;

  try {
    const chatInput = doc.createElement('input');
    doc._registerId('chat-input', chatInput);

    const peer2 = {
      id: 'peer-7',
      name: 'Aldric',
      race: 'Nord',
      gender: 'Male',
      className: 'Knight',
      level: 5,
      defeated: true,
      beastForm: true,
      worn: { chestArmor: { name: 'Iron Cuirass', material: 'Iron' } },
    };
    const api = createMockApi([SAMPLE_PEER, peer2]);
    api.registerPanel('hiscores', 'Chronicles', () => {});

    install(api);

    // Stylesheet lazily loaded with data-feature="peer-inspect"
    const link = doc.head.querySelector('link[data-feature="peer-inspect"]');
    assert.ok(link, 'should inject peerInspect.css link');

    // Panel registered as 'inspect' -> 'Traveller'
    assert.ok(api.panels.has('inspect'));
    assert.equal(api.panels.get('inspect').title, 'Traveller');
    assert.equal(typeof api.inspectPeer, 'function');

    // Open directly without target: shows peer selector list
    const root = doc.createElement('div');
    api.panels.get('inspect').render(root);
    const selectorBtns = root.querySelectorAll('.pi-peer-btn');
    assert.equal(selectorBtns.length, 2, 'peer selector lists both peers');

    // Inspect by id
    const found = api.inspectPeer('peer-42');
    assert.equal(found.name, 'Lyra Vance');
    assert.equal(api.opened[api.opened.length - 1].id, 'inspect');

    // Render inspected peer
    api.panels.get('inspect').render(root);
    await new Promise((r) => setTimeout(r, 0));

    const text = root.textContent;
    assert.match(text, /Lyra Vance/);
    assert.match(text, /\[BLADE\]/);
    assert.match(text, /Level 11 · Dark Elf · Female · Spellsword/);
    assert.match(text, /Magician of the Mages Guild/);
    assert.match(text, /Mounted/);
    assert.match(text, /Readied/);
    assert.match(text, /Steel Helm/);
    assert.match(text, /Blue Casual Cloak/);
    assert.match(text, /Mithril Cuirass/);
    assert.match(text, /Daedric Longsword/);
    assert.match(text, /Steel Kite Shield/);
    // Zero private stats leaked in rendered DOM
    assert.ok(!text.includes('99999'), 'private gold must not render');
    assert.ok(!text.includes('Secret Quest'), 'private quests must not render');

    // Quick actions
    root.querySelector('button[data-action="invite"]').click();
    assert.deepEqual(api.actions[0], { verb: 'party.invite', args: { targetId: 'peer-42' } });

    root.querySelector('button[data-action="trade"]').click();
    assert.deepEqual(api.actions[1], { verb: 'trade.request', args: { targetId: 'peer-42' } });

    root.querySelector('button[data-action="whisper"]').click();
    assert.equal(chatInput.value, '/w "Lyra Vance" ');
    assert.equal(api.closed, true);

    root.querySelector('button[data-action="chronicles"]').click();
    const lastOpen = api.opened[api.opened.length - 1];
    assert.equal(lastOpen.id, 'hiscores');
    assert.equal(lastOpen.detail.player, 'Lyra Vance');

    // Inspect second peer by name (case-insensitive)
    api.inspectPeer('aldric');
    api.panels.get('inspect').render(root);
    const text2 = root.textContent;
    assert.match(text2, /Aldric/);
    assert.match(text2, /Beast Form/);
    assert.match(text2, /Defeated/);
  } finally {
    globalThis.document = prevDoc;
    globalThis.Node = prevNode;
  }
});

test('source safety and CSS scoping', () => {
  const jsPath = fileURLToPath(new URL('../client/gameplay/peerInspect.js', import.meta.url));
  const cssPath = fileURLToPath(new URL('../client/gameplay/peerInspect.css', import.meta.url));
  const js = readFileSync(jsPath, 'utf8');
  const css = readFileSync(cssPath, 'utf8');

  assert.ok(!js.includes('.innerHTML'), 'peerInspect.js must never use .innerHTML');
  assert.match(css, /\.pi-doll-canvas[\s\S]*image-rendering:\s*pixelated/, 'doll canvas must use pixelated rendering');
  assert.match(css, /\.pi-layout[\s\S]*grid-template-columns:/, 'must define two-column layout');
  assert.match(css, /@media\s*\(max-width:\s*640px\)/, 'must include responsive narrow layout');

  // Every selector in peerInspect.css (outside @media and comments) must be scoped under .pi-
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '');
  const selectorBlocks = stripped.matchAll(/([^{}]+)\{/g);
  for (const m of selectorBlocks) {
    const raw = m[1].trim();
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const sel = part.trim();
      if (!sel) continue;
      assert.ok(sel.startsWith('.pi-'), `CSS selector must be scoped under .pi-: got "${sel}"`);
    }
  }
});
