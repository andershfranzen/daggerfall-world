// Mouse capture (pointer lock) vs click actions in client/input.js, with a minimal fake DOM.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeCanvas extends EventTarget {
  constructor({ lock = 'grant', api = true } = {}) {
    super();
    this.mode = lock; // 'grant' | 'deny' | 'manual'
    this.requests = 0;
    this.classList = { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } };
    if (api) {
      this.requestPointerLock = () => {
        this.requests += 1;
        if (this.mode === 'grant') { queueMicrotask(() => setLock(this)); return Promise.resolve(); }
        if (this.mode === 'deny') {
          return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
        }
        return Promise.resolve(); // manual: the test calls setLock itself
      };
    }
  }
  setPointerCapture() {}
}

function setLock(el) {
  document.pointerLockElement = el;
  document.dispatchEvent(new Event('pointerlockchange'));
}

function installDom() {
  const doc = new EventTarget();
  doc.pointerLockElement = null;
  doc.hidden = false;
  doc.body = { attrs: new Set(), toggleAttribute(n, on) { if (on) this.attrs.add(n); else this.attrs.delete(n); } };
  doc.activeElement = doc.body;
  doc.exitPointerLock = () => { if (doc.pointerLockElement) setLock(null); };
  globalThis.document = doc;
  globalThis.window = new EventTarget();
}

const ptr = (type, init = {}) => {
  const e = new Event(type, { cancelable: true });
  return Object.assign(e, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 100, clientY: 100, movementX: 0, movementY: 0, ...init });
};
const tick = () => new Promise((r) => setTimeout(r, 0));

let Input;
beforeEach(async () => {
  installDom();
  ({ Input } = await import('../client/input.js'));
});

function setup(opts) {
  const canvas = new FakeCanvas(opts);
  const input = new Input(canvas);
  input.setEnabled(true);
  const clicks = [];
  const changes = [];
  input.onPrimaryClick = (e) => clicks.push(e.type);
  input.onLockChange = (locked, info) => changes.push({ locked, ...info });
  return { canvas, input, clicks, changes };
}

test('holding a bound Alt slow key before pressing a movement key still walks', () => {
  const { input } = setup();
  input.setTraversalBindings({ slow: 'AltLeft' });
  const press = (code) => window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code, altKey: true }));
  press('KeyW');
  assert.equal(input.axes().forward, 0);
  press('AltLeft');
  press('KeyW');
  assert.equal(input.traversalHeld().slow, true);
  assert.equal(input.axes().forward, 1);
});

async function click(canvas, init) {
  canvas.dispatchEvent(ptr('pointerdown', init));
  await tick();
  canvas.dispatchEvent(ptr('pointerup', init));
  await tick();
}

test('the capture click locks the pointer and never attacks; later clicks do', async () => {
  const { canvas, input, clicks } = setup();
  await click(canvas);
  assert.equal(canvas.requests, 1);
  assert.equal(input.locked, true);
  assert.ok(document.body.attrs.has('data-pointer-lock'));
  assert.deepEqual(clicks, [], 'acquiring click must not reach onPrimaryClick');

  await click(canvas);
  assert.deepEqual(clicks, ['pointerdown'], 'a click while captured is one action');
  assert.equal(canvas.requests, 1, 'no new lock request while captured');
});

test('a quick click released before the lock arrives still does not attack', async () => {
  const { canvas, input, clicks } = setup({ lock: 'manual' });
  canvas.dispatchEvent(ptr('pointerdown'));
  canvas.dispatchEvent(ptr('pointerup'));
  setLock(canvas);
  assert.equal(input.locked, true);
  assert.deepEqual(clicks, []);
});

test('mouse motion with no button held turns the view while locked', async () => {
  const { canvas, input } = setup();
  await click(canvas);
  canvas.dispatchEvent(ptr('pointermove', { movementX: 40, movementY: -20, buttons: 0 }));
  const look = input.look(0);
  assert.ok(look.yaw > 0, 'moving right turns right');
  assert.ok(look.pitch > 0, 'moving up looks up');
  // Without capture, plain motion does nothing.
  document.exitPointerLock();
  canvas.dispatchEvent(ptr('pointermove', { movementX: 40, movementY: -20, buttons: 0 }));
  assert.deepEqual(input.look(0), { yaw: 0, pitch: 0 });
});

test('release then re-entry: the re-acquiring click is swallowed too', async () => {
  const { canvas, input, clicks, changes } = setup();
  await click(canvas);
  document.exitPointerLock(); // Esc
  assert.equal(input.locked, false);
  assert.ok(!document.body.attrs.has('data-pointer-lock'));
  assert.ok(Number.isFinite(input.unlockedAt));
  await click(canvas);
  assert.equal(input.locked, true);
  assert.equal(canvas.requests, 2);
  assert.deepEqual(clicks, []);
  await click(canvas);
  assert.deepEqual(clicks, ['pointerdown']);
  assert.deepEqual(changes.map((c) => c.locked), [true, false, true]);
});

test('rapid clicks during the browser cooldown after Esc can still recapture without attacking', async () => {
  const { canvas, input, clicks } = setup();
  await click(canvas);
  document.exitPointerLock();
  canvas.mode = 'deny';
  await click(canvas);
  await click(canvas);
  assert.equal(input.lockUnavailable, false);
  canvas.mode = 'grant';
  await click(canvas);
  assert.equal(input.locked, true);
  assert.deepEqual(clicks, []);
});

test('opening a menu releases the lock and clears input; closing it does not re-capture', async () => {
  const { canvas, input, clicks } = setup();
  await click(canvas);
  input.keys.add('KeyW');
  canvas.dispatchEvent(ptr('pointermove', { movementX: 50 }));
  input.setSuspended(true);
  assert.equal(input.locked, false);
  assert.equal(document.pointerLockElement, null);
  assert.equal(input.keys.size, 0);
  assert.deepEqual(input.look(0), { yaw: 0, pitch: 0 });
  // Clicks reaching the canvas while a menu is open do nothing.
  await click(canvas);
  assert.equal(canvas.requests, 1);
  input.setSuspended(false);
  assert.equal(input.locked, false, 'closing the menu leaves the mouse free');
  await click(canvas);
  assert.equal(input.locked, true);
  assert.deepEqual(clicks, []);
});

test('a lock that arrives after a menu opened is handed straight back', async () => {
  const { canvas, input } = setup({ lock: 'manual' });
  canvas.dispatchEvent(ptr('pointerdown'));
  input.setSuspended(true);
  setLock(canvas);
  assert.equal(document.pointerLockElement, null);
  assert.equal(input.locked, false);
});

test('leaving the game or hiding the tab releases the mouse', async () => {
  const { canvas, input } = setup();
  await click(canvas);
  input.setEnabled(false);
  assert.equal(document.pointerLockElement, null);
  input.setEnabled(true);
  await click(canvas);
  document.hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(document.pointerLockElement, null);
  assert.equal(input.locked, false);
});

test('a refused lock is reported, not faked, and the press falls back to drag-look', async () => {
  const { canvas, input, clicks, changes } = setup({ lock: 'deny' });
  canvas.dispatchEvent(ptr('pointerdown', { clientX: 100 }));
  canvas.dispatchEvent(ptr('pointermove', { clientX: 160 }));
  await tick();
  // pointerlockerror for the same refusal must not count twice
  document.dispatchEvent(new Event('pointerlockerror'));
  canvas.dispatchEvent(ptr('pointerup', { clientX: 160 }));
  assert.equal(input.locked, false);
  assert.ok(!document.body.attrs.has('data-pointer-lock'));
  assert.ok(input.look(0).yaw > 0, 'the press still drags the view');
  assert.deepEqual(clicks, []);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].locked, false);
  assert.ok(changes[0].error);
  assert.equal(changes[0].unavailable, false);

  // A second refusal gives up: the mouse goes back to drag-look and click-to-attack.
  await click(canvas);
  assert.equal(input.lockUnavailable, true);
  assert.equal(changes.at(-1).unavailable, true);
  const before = canvas.requests;
  await click(canvas);
  assert.equal(canvas.requests, before, 'no further lock requests');
  assert.deepEqual(clicks, ['pointerup']);
});

test('without the Pointer Lock API the mouse keeps drag-look and click-to-attack', async () => {
  const { canvas, input, clicks } = setup({ api: false });
  assert.equal(input.lockUnavailable, true);
  await click(canvas);
  assert.deepEqual(clicks, ['pointerup']);
});

test('touch drags to look and taps attack, never requesting pointer lock', async () => {
  const { canvas, input, clicks } = setup();
  await click(canvas, { pointerType: 'touch' });
  assert.deepEqual(clicks, ['pointerup']);
  canvas.dispatchEvent(ptr('pointerdown', { pointerType: 'touch', clientX: 100 }));
  canvas.dispatchEvent(ptr('pointermove', { pointerType: 'touch', clientX: 140 }));
  canvas.dispatchEvent(ptr('pointerup', { pointerType: 'touch', clientX: 140 }));
  assert.ok(input.look(0).yaw > 0);
  assert.equal(canvas.requests, 0);
  assert.deepEqual(clicks, ['pointerup'], 'a drag is not a tap');
});

test('right button is left to the weapons feature', async () => {
  const { canvas, clicks } = setup();
  await click(canvas, { button: 2 });
  assert.equal(canvas.requests, 0);
  assert.deepEqual(clicks, []);
});

test('keyboard look and movement still work with no mouse capture', () => {
  const { input } = setup();
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyW' }));
  window.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyE' }));
  assert.equal(input.axes().forward, 1);
  assert.ok(input.look(0.1).yaw > 0);
  window.dispatchEvent(new Event('blur'));
  assert.equal(input.axes().forward, 0);
});
