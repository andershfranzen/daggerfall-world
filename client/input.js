// Keyboard, mouse/touch look and gamepad.
//
// Desktop mouse: one primary click on the game view captures the pointer (Pointer Lock API);
// afterwards plain mouse motion turns the view and Esc releases it. The click that acquires (or
// re-acquires) the lock is swallowed: it never reaches `onPrimaryClick`, so it cannot attack or
// interact. While locked every primary press is reported through `onPrimaryClick`. If pointer lock
// is missing or keeps being refused, the mouse falls back to drag-to-look with click-to-attack.
// Touch and pen always drag to look; a short tap is reported through `onPrimaryClick`. The
// secondary (right) button is left entirely to the weapons feature and never moves the camera here.
//
// Movement keys are ignored while a text field has focus, while the input is disabled (not in
// game) and while it is suspended (a menu or dialogue is open).

const TURN_SPEED = 2.2; // rad/s for arrow / Q E turning
const PITCH_SPEED = 1.4;
const DRAG_SENS = 0.0042; // rad per CSS pixel
const LOCK_SENS = 0.0026;
const STICK_LOOK = 2.6; // rad/s at full right-stick deflection
const STICK_DEAD = 0.18;
const CLICK_SLOP = 5; // px of travel before a press counts as a drag
const CLICK_MS = 350;
const LOCK_GIVE_UP = 2; // consecutive refused lock requests before falling back to drag-look
// Chromium briefly denies recapture after Esc. Clicks during this interval can still request
// the lock (other browsers may grant it), but cannot disable mouse capture for the session.
const RECAPTURE_GRACE_MS = 1500;
export const PITCH_LIMIT = 1.35;

function typingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export const MOVE_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Apply a radial dead zone to a stick, rescaling so output still reaches 1. */
export function deadZone(x, y, dead = STICK_DEAD) {
  const m = Math.hypot(x, y);
  if (m <= dead) return [0, 0];
  const k = Math.min(1, (m - dead) / (1 - dead)) / m;
  return [x * k, y * k];
}

// Standard-mapping gamepad buttons (https://w3c.github.io/gamepad/#remapping).
export const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
});

/**
 * Tracks gamepad buttons between polls and reports presses (rising edges) with key repeat
 * for the d-pad. DOM-free given a `getGamepads` function, so it can be tested in Node.
 */
export class PadReader {
  constructor(getGamepads = () => globalThis.navigator?.getGamepads?.() ?? []) {
    this.getGamepads = getGamepads;
    this.prev = [];
    this.heldSince = new Map();
    this.lastRepeat = new Map();
    this.axes = [0, 0, 0, 0];
    this.connected = false;
  }

  /** Returns { pressed: Set<button>, axes: [lx, ly, rx, ry] } for the first standard pad. */
  poll(now) {
    let pad = null;
    for (const p of this.getGamepads() || []) if (p && p.connected !== false) { pad = p; break; }
    this.connected = !!pad;
    const pressed = new Set();
    if (!pad) { this.prev = []; this.axes = [0, 0, 0, 0]; return { pressed, axes: this.axes }; }
    const cur = pad.buttons.map((b) => (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5));
    cur.forEach((down, i) => {
      if (down && !this.prev[i]) {
        pressed.add(i);
        this.heldSince.set(i, now);
        this.lastRepeat.set(i, now);
      } else if (down && i >= PAD.UP && i <= PAD.RIGHT) {
        // D-pad repeat for list navigation: after 0.4 s, every 0.11 s.
        if (now - this.heldSince.get(i) > 0.4 && now - this.lastRepeat.get(i) > 0.11) {
          pressed.add(i);
          this.lastRepeat.set(i, now);
        }
      }
    });
    this.prev = cur;
    const a = pad.axes || [];
    const [lx, ly] = deadZone(a[0] || 0, a[1] || 0);
    const [rx, ry] = deadZone(a[2] || 0, a[3] || 0);
    this.axes = [lx, ly, rx, ry];
    return { pressed, axes: this.axes };
  }

  held(button) { return !!this.prev[button]; }
}

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    /** Held traversal keys (run, walk slowly, jump/rise, crouch/dive): codes from setTraversalBindings. */
    this.held = new Set();
    this.traversalCodes = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);
    this.traversal = { run: ['ShiftLeft', 'ShiftRight'], slow: ['AltLeft', 'AltRight'], jump: [], crouch: [] };
    this.padHeld = { run: false, jump: false, crouch: false };
    this.yawDelta = 0;
    this.pitchDelta = 0;
    this.dragging = null;
    this.enabled = false;
    this.suspended = false;
    this.locked = false;
    /** A lock request is in flight (between the capture click and pointerlockchange/error). */
    this.lockPending = false;
    this.lockFailures = 0;
    /** Pointer lock is missing or was refused repeatedly: the mouse drags to look instead. */
    this.lockUnavailable = typeof canvas.requestPointerLock !== 'function';
    /** performance.now() of the last lock release, so a late Esc keydown is not taken as a command. */
    this.unlockedAt = -Infinity;
    this.sensitivity = 1;
    this.invertY = false;
    this.padAxes = [0, 0, 0, 0];
    /** (event) primary-button click without dragging, or any primary press while pointer-locked. */
    this.onPrimaryClick = null;
    /** (locked, { error?, unavailable }) after the pointer is captured, released or refused. */
    this.onLockChange = null;

    const down = (e) => {
      if (!this.active() || typingTarget(document.activeElement)) return;
      // Traversal keys are held, including modifiers (Shift to run, Alt to walk slowly).
      if (this.traversalCodes.has(e.code)) {
        this.held.add(e.code);
        if (e.code.startsWith('Alt')) e.preventDefault(); // keep the browser menu bar shut
      }
      const slowAlt = e.altKey && this.traversal.slow.some((code) => code.startsWith('Alt') && this.held.has(code));
      if (e.ctrlKey || e.metaKey || (e.altKey && !slowAlt)) return;
      if (MOVE_CODES.has(e.code)) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    };
    const up = (e) => { this.keys.delete(e.code); this.held.delete(e.code); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.release(); });

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active()) return;
      if (e.button !== 0) return; // right/middle buttons belong to gameplay features
      if (this.locked) {
        e.preventDefault();
        this.onPrimaryClick?.(e);
        return;
      }
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      // A mouse press while not captured is a capture click: it requests the lock and is never an
      // attack, even if the browser refuses (the press then just drags to look).
      const capture = this.wantsLock(e);
      this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, capture };
      canvas.setPointerCapture?.(e.pointerId);
      canvas.classList.add('dragging');
      e.preventDefault();
      if (capture) this.requestLock();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active()) return;
      const s = this.sensitivity;
      const inv = this.invertY ? -1 : 1;
      if (this.locked) {
        this.yawDelta += (e.movementX || 0) * LOCK_SENS * s;
        this.pitchDelta -= (e.movementY || 0) * LOCK_SENS * s * inv;
        return;
      }
      const d = this.dragging;
      if (!d || d.id !== e.pointerId) return;
      this.yawDelta += (e.clientX - d.x) * DRAG_SENS * s;
      this.pitchDelta -= (e.clientY - d.y) * DRAG_SENS * s * inv;
      d.x = e.clientX; d.y = e.clientY;
      if (Math.hypot(d.x - d.x0, d.y - d.y0) > CLICK_SLOP) d.moved = true;
    });
    const end = (e) => {
      const d = this.dragging;
      if (d && d.id === e.pointerId) {
        this.dragging = null;
        canvas.classList.remove('dragging');
        if (e.type === 'pointerup' && !d.capture && !d.moved && performance.now() - d.t0 < CLICK_MS && this.active()) {
          this.onPrimaryClick?.(e);
        }
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => this.syncLock());
    document.addEventListener('pointerlockerror', () => this.lockFailed(new Error('pointer lock refused')));
  }

  /** Whether a primary press should request pointer lock rather than drag/click. */
  wantsLock(e) {
    return !this.lockUnavailable && !this.locked && (e.pointerType === 'mouse' || !e.pointerType);
  }

  requestLock() {
    if (this.lockPending || this.locked || this.lockUnavailable) return;
    this.lockPending = true;
    let r;
    try {
      r = this.canvas.requestPointerLock();
    } catch (err) {
      this.lockFailed(err);
      return;
    }
    if (r && typeof r.then === 'function') r.then(null, (err) => this.lockFailed(err));
  }

  lockFailed(error) {
    if (!this.lockPending) return; // the promise and the pointerlockerror event report the same refusal
    this.lockPending = false;
    if (document.pointerLockElement === this.canvas) return;
    if (performance.now() - this.unlockedAt >= RECAPTURE_GRACE_MS) this.lockFailures += 1;
    if (this.lockFailures >= LOCK_GIVE_UP) this.lockUnavailable = true;
    this.onLockChange?.(false, { error, unavailable: this.lockUnavailable });
  }

  syncLock() {
    const locked = document.pointerLockElement === this.canvas;
    this.lockPending = false;
    if (locked === this.locked) return;
    this.locked = locked;
    document.body.toggleAttribute('data-pointer-lock', locked);
    // Mouse state never carries across a capture change: no half-finished drag, no stale turn.
    this.dragging = null;
    this.yawDelta = this.pitchDelta = 0;
    this.canvas.classList.remove('dragging');
    if (locked) {
      this.lockFailures = 0;
      // The lock arrived after a menu opened or the game was left: give the mouse straight back.
      if (!this.active()) { document.exitPointerLock?.(); return; }
    } else {
      this.unlockedAt = performance.now();
    }
    this.onLockChange?.(locked, { unavailable: this.lockUnavailable });
  }

  active() { return this.enabled && !this.suspended; }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.release();
  }

  /** Suspend gameplay input while a menu/dialogue is open: stop moving, free the mouse. */
  setSuspended(on) {
    this.suspended = !!on;
    if (on) this.release();
  }

  /** Clear all held input and give the mouse back (menu opened, game left, tab hidden). */
  release() {
    this.clear();
    this.lockPending = false;
    if (this.locked || document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  clear() {
    this.keys.clear();
    this.held.clear();
    this.padHeld = { run: false, jump: false, crouch: false };
    this.dragging = null;
    this.yawDelta = this.pitchDelta = 0;
    this.padAxes = [0, 0, 0, 0];
    this.canvas.classList.remove('dragging');
  }

  /**
   * Keys whose held state drives traversal: `{run, slow, jump, crouch}` -> KeyboardEvent.code (or arrays).
   * The run key also counts with either Shift, and slow with either Alt, as in the classic controls.
   */
  setTraversalBindings(b = {}) {
    const list = (v, extra = []) => [...new Set([...(Array.isArray(v) ? v : v ? [v] : []), ...extra])];
    this.traversal = {
      run: list(b.run, b.run === 'ShiftLeft' || b.run === 'ShiftRight' ? ['ShiftLeft', 'ShiftRight'] : []),
      slow: list(b.slow, b.slow === 'AltLeft' || b.slow === 'AltRight' ? ['AltLeft', 'AltRight'] : []),
      jump: list(b.jump),
      crouch: list(b.crouch),
    };
    this.traversalCodes = new Set(Object.values(this.traversal).flat());
  }

  /** Gamepad traversal buttons held this frame (LB run, A jump/rise, B crouch/dive), fed by the shell. */
  setPadHeld(h) { this.padHeld = this.active() ? { run: !!h.run, jump: !!h.jump, crouch: !!h.crouch } : { run: false, jump: false, crouch: false }; }

  /** Held traversal state: {run, slow, jump, crouch}. False while suspended or typing. */
  traversalHeld() {
    if (!this.active() || typingTarget(document.activeElement)) return { run: false, slow: false, jump: false, crouch: false };
    const any = (codes) => codes.some((c) => this.held.has(c));
    const t = this.traversal;
    return {
      run: any(t.run) || this.padHeld.run,
      slow: any(t.slow),
      jump: any(t.jump) || this.padHeld.jump,
      crouch: any(t.crouch) || this.padHeld.crouch,
    };
  }

  /** Latest gamepad sticks [lx, ly, rx, ry], fed by the shell each frame. */
  setPadAxes(axes) { this.padAxes = this.active() ? axes : [0, 0, 0, 0]; }

  /** Movement axes in [-1, 1]. */
  axes() {
    if (!this.active() || typingTarget(document.activeElement)) return { forward: 0, strafe: 0 };
    const k = this.keys;
    const [lx, ly] = this.padAxes;
    const clamp1 = (v) => Math.max(-1, Math.min(1, v));
    // The server accepts any value in [-1, 1], so analogue stick walking is sent as is.
    return {
      forward: clamp1((k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) - ly),
      strafe: clamp1((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + lx),
    };
  }

  /** Consume look deltas accumulated since the last call (radians). */
  look(dt) {
    const k = this.keys;
    let yaw = this.yawDelta, pitch = this.pitchDelta;
    this.yawDelta = this.pitchDelta = 0;
    if (!this.active()) return { yaw: 0, pitch: 0 };
    if (!typingTarget(document.activeElement)) {
      yaw += ((k.has('ArrowRight') || k.has('KeyE') ? 1 : 0) - (k.has('ArrowLeft') || k.has('KeyQ') ? 1 : 0)) * TURN_SPEED * dt;
      pitch += ((k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0)) * PITCH_SPEED * dt;
    }
    const [, , rx, ry] = this.padAxes;
    yaw += rx * STICK_LOOK * this.sensitivity * dt;
    pitch -= ry * STICK_LOOK * 0.7 * this.sensitivity * dt * (this.invertY ? -1 : 1);
    return { yaw, pitch };
  }
}
