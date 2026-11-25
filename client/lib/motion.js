// Movement model shared with the server: yaw = 0 faces -z, positive yaw turns right (+x),
// axes in [-1, 1], diagonal input normalised, 4 m/s. Plus client-side prediction and
// snapshot interpolation. DOM-free so it can be unit tested in Node.

export const SPEED = 4;
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function wrapAngle(a) {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

export function lerpAngle(a, b, t) {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/** Velocity (m/s) on the ground plane for given input. `speed` defaults to walking (a horse is faster). */
export function velocity(forward, strafe, yaw, speed = SPEED) {
  const f = clamp(forward, -1, 1), st = clamp(strafe, -1, 1);
  const s = Math.sin(yaw), c = Math.cos(yaw);
  let vx = s * f + c * st;
  let vz = -c * f + s * st;
  const len = Math.hypot(vx, vz);
  if (len > 1) { vx /= len; vz /= len; }
  const v = Number.isFinite(speed) && speed > 0 ? speed : SPEED;
  return [vx * v, vz * v];
}

/**
 * Predicts the local player's position from its own input and reconciles against
 * authoritative snapshots. The server has no access to our geometry, so divergence comes
 * only from latency/timing and world clamping. We keep ~0.6 s of predicted history; a
 * snapshot is matched to the closest historic point (latency-agnostic) and the difference
 * is applied instantly to the simulation but faded out visually.
 */
export class Predictor {
  constructor({ window = 0.6, snapDistance = 6 } = {}) {
    this.window = window;
    this.snapDistance = snapDistance;
    this.x = 0; this.z = 0;
    this.smoothX = 0; this.smoothZ = 0; // visual offset that decays to zero
    this.history = []; // {t, x, z}
    this.initialized = false;
  }

  reset(x, z) {
    this.x = x; this.z = z;
    this.smoothX = this.smoothZ = 0;
    this.history.length = 0;
    this.initialized = true;
  }

  /** Re-express the prediction in another frame (an outdoor crossing): nothing visibly moves. */
  shift(dx, dz) {
    this.x += dx; this.z += dz;
    for (const h of this.history) { h.x += dx; h.z += dz; }
  }

  /** Advance with the input currently being sent, at the server's speed for this player. */
  update(forward, strafe, yaw, dt, now, speed = SPEED) {
    const [vx, vz] = velocity(forward, strafe, yaw, speed);
    this.x += vx * dt;
    this.z += vz * dt;
    const decay = Math.exp(-dt * 10);
    this.smoothX *= decay;
    this.smoothZ *= decay;
    if (Math.abs(this.smoothX) < 1e-4) this.smoothX = 0;
    if (Math.abs(this.smoothZ) < 1e-4) this.smoothZ = 0;
    this.history.push({ t: now, x: this.x, z: this.z });
    while (this.history.length && now - this.history[0].t > this.window) this.history.shift();
  }

  /**
   * Record a position the caller stepped itself (shared locomotion rule with collision) as this
   * frame's prediction, keeping the visual correction decaying as update() does.
   */
  advanceTo(x, z, dt, now) {
    this.x = x; this.z = z;
    const decay = Math.exp(-dt * 10);
    this.smoothX *= decay;
    this.smoothZ *= decay;
    if (Math.abs(this.smoothX) < 1e-4) this.smoothX = 0;
    if (Math.abs(this.smoothZ) < 1e-4) this.smoothZ = 0;
    this.history.push({ t: now, x, z });
    while (this.history.length && now - this.history[0].t > this.window) this.history.shift();
  }

  /** Apply an authoritative position for ourselves. */
  reconcile(sx, sz, now) {
    if (!this.initialized) return this.reset(sx, sz);
    if (Math.hypot(sx - this.x, sz - this.z) > this.snapDistance) return this.reset(sx, sz);
    let best = null, bestD = Infinity;
    for (const h of this.history) {
      const d = (h.x - sx) ** 2 + (h.z - sz) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    // With no recent movement (or the best match is the oldest sample, meaning the server is
    // further behind than our window — e.g. clamped at the world edge) correct to the server.
    let ox, oz;
    if (!best || (this.history.length > 1 && best === this.history[0] && now - best.t >= this.window * 0.9)) {
      ox = sx - this.x; oz = sz - this.z;
      if (best) { // treat as converged from here on
        this.history.length = 0;
      }
    } else {
      ox = sx - best.x; oz = sz - best.z;
    }
    if (ox * ox + oz * oz < 0.0004) return; // < 2 cm: ignore
    this.x += ox; this.z += oz;
    this.smoothX -= ox; this.smoothZ -= oz;
    for (const h of this.history) { h.x += ox; h.z += oz; }
  }

  get renderX() { return this.x + this.smoothX; }
  get renderZ() { return this.z + this.smoothZ; }
}

/**
 * Buffers authoritative snapshots for a remote player and samples them with a fixed
 * render delay so motion stays smooth despite jitter.
 */
export class SnapshotBuffer {
  constructor(delay = 0.12) {
    this.delay = delay;
    this.samples = []; // {t, x, z, yaw, moving}
  }

  push(t, s) {
    const last = this.samples[this.samples.length - 1];
    if (last && t <= last.t) t = last.t + 1e-3;
    this.samples.push({
      t, x: s.x, z: s.z, yaw: s.yaw, moving: !!s.moving,
      // Replicated foot height, stance and speed (client/lib/locomotion.js publicBody); absent from older servers.
      y: Number.isFinite(s.y) ? s.y : null, stance: typeof s.stance === 'string' ? s.stance : null, speed: Number.isFinite(s.speed) ? s.speed : 0,
    });
    while (this.samples.length > 2 && t - this.samples[1].t > 1.5) this.samples.shift();
  }

  sample(now) {
    const s = this.samples;
    if (!s.length) return null;
    const t = now - this.delay;
    if (t <= s[0].t) return { ...s[0] };
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (t <= b.t) {
        const k = (t - a.t) / (b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * k,
          z: a.z + (b.z - a.z) * k,
          yaw: lerpAngle(a.yaw, b.yaw, k),
          moving: a.moving || b.moving,
          y: a.y !== null && b.y !== null ? a.y + (b.y - a.y) * k : b.y ?? a.y ?? null,
          stance: k < 0.5 ? a.stance : b.stance,
          speed: a.speed + (b.speed - a.speed) * k,
        };
      }
    }
    return { ...s[s.length - 1] };
  }
}

/**
 * Decides when to send input: on any meaningful change (rate limited), and every
 * `refresh` seconds while moving so the server's input timeout does not stop us.
 */
export class InputSender {
  constructor({ refresh = 0.1, minGap = 0.05, yawEpsilon = 0.01 } = {}) {
    this.refresh = refresh;
    this.minGap = minGap;
    this.yawEpsilon = yawEpsilon;
    this.last = null;
    this.lastAt = -Infinity;
  }

  reset() { this.last = null; this.lastAt = -Infinity; }

  /**
   * Returns the message to send now, or null. `extra` carries the optional traversal fields
   * ({run, slow, crouch, rise, jump}); any change to them is sent at once, and a held vertical
   * axis refreshes like movement.
   */
  poll(forward, strafe, yaw, now, extra = null) {
    const msg = { type: 'input', forward, strafe, yaw: wrapAngle(yaw), ...(extra || {}) };
    const prev = this.last;
    const moving = forward !== 0 || strafe !== 0 || !!extra?.rise || !!extra?.run || !!extra?.slow;
    const elapsed = now - this.lastAt;
    const sameExtra = (a, b) => ['run', 'slow', 'crouch', 'rise', 'jump'].every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));
    let send = false;
    if (!prev) send = true;
    else if (prev.forward !== forward || prev.strafe !== strafe || !sameExtra(prev, msg)) send = true; // start/stop: immediate
    else if (Math.abs(wrapAngle(prev.yaw - msg.yaw)) > this.yawEpsilon) send = elapsed >= this.minGap;
    else if (moving) send = elapsed >= this.refresh;
    if (!send) return null;
    this.last = msg;
    this.lastAt = now;
    return msg;
  }
}
