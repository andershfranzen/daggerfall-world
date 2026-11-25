// Procedural low-poly traveller: boxes for legs, tunic, torso, arms, head and hair, with a
// walk cycle driven by distance travelled. Origin at the feet, facing -z at yaw 0.

import * as M from '../lib/mat.js';

const CLOTH = [
  [0.55, 0.16, 0.13], [0.20, 0.36, 0.20], [0.20, 0.24, 0.45], [0.62, 0.47, 0.18],
  [0.36, 0.38, 0.42], [0.42, 0.20, 0.40], [0.45, 0.30, 0.18], [0.16, 0.40, 0.42],
];
const SKIN = [[0.93, 0.76, 0.62], [0.80, 0.60, 0.44], [0.60, 0.42, 0.30], [0.42, 0.29, 0.20]];
const HAIR = [[0.15, 0.11, 0.08], [0.40, 0.25, 0.12], [0.75, 0.62, 0.36], [0.55, 0.53, 0.50], [0.08, 0.08, 0.09]];
const LEG = [0.24, 0.20, 0.17];
const BELT = [0.18, 0.12, 0.08];

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function appearanceFor(seed) {
  const h = hashString(String(seed));
  return {
    cloth: CLOTH[h % CLOTH.length],
    skin: SKIN[(h >>> 8) % SKIN.length],
    hair: HAIR[(h >>> 16) % HAIR.length],
  };
}

const STRIDE = 1.5; // metres per full walk cycle

export class Avatar {
  constructor(seed) {
    this.look = appearanceFor(seed);
    this.phase = 0;
    this.moveAmt = 0;
    this.lastX = null;
    this.lastZ = null;
    const darker = this.look.cloth.map((c) => c * 0.7);
    // [pivot xyz, rotation source, offset from pivot xyz, size xyz, colour]
    this.spec = [
      { pivot: [-0.11, 0.9, 0], swing: 'legL', off: [0, -0.43, 0], size: [0.17, 0.86, 0.2], color: LEG },
      { pivot: [0.11, 0.9, 0], swing: 'legR', off: [0, -0.43, 0], size: [0.17, 0.86, 0.2], color: LEG },
      { pivot: [0, 0.9, 0], swing: null, off: [0, 0.02, 0], size: [0.46, 0.34, 0.3], color: darker },
      { pivot: [0, 0.9, 0], swing: null, off: [0, 0.2, 0], size: [0.47, 0.06, 0.31], color: BELT },
      { pivot: [0, 0.9, 0], swing: null, off: [0, 0.42, 0], size: [0.48, 0.42, 0.28], color: this.look.cloth },
      { pivot: [-0.32, 1.5, 0], swing: 'armL', off: [0, -0.3, 0], size: [0.14, 0.62, 0.16], color: this.look.cloth },
      { pivot: [0.32, 1.5, 0], swing: 'armR', off: [0, -0.3, 0], size: [0.14, 0.62, 0.16], color: this.look.cloth },
      { pivot: [-0.32, 1.5, 0], swing: 'armL', off: [0, -0.66, 0], size: [0.12, 0.1, 0.13], color: this.look.skin },
      { pivot: [0.32, 1.5, 0], swing: 'armR', off: [0, -0.66, 0], size: [0.12, 0.1, 0.13], color: this.look.skin },
      { pivot: [0, 1.56, 0], swing: null, off: [0, 0.03, 0], size: [0.12, 0.08, 0.12], color: this.look.skin },
      { pivot: [0, 1.56, 0], swing: null, off: [0, 0.2, 0], size: [0.26, 0.28, 0.26], color: this.look.skin },
      { pivot: [0, 1.56, 0], swing: null, off: [0, 0.35, 0.02], size: [0.28, 0.07, 0.3], color: this.look.hair },
      { pivot: [0, 1.56, 0], swing: null, off: [0, 0.2, 0.1], size: [0.28, 0.26, 0.09], color: this.look.hair },
    ];
    this.parts = this.spec.map((s) => ({ model: new Float32Array(16), color: s.color }));
    this.base = new Float32Array(16);
  }

  /** Update animation and part matrices. */
  pose(x, y, z, yaw, moving, dt, time) {
    if (this.lastX !== null) {
      const d = Math.hypot(x - this.lastX, z - this.lastZ);
      if (d < 3) this.phase += (d / STRIDE) * Math.PI * 2;
    }
    this.lastX = x; this.lastZ = z;
    const target = moving ? 1 : 0;
    this.moveAmt += (target - this.moveAmt) * Math.min(1, dt * 8);
    const k = this.moveAmt;
    const s = Math.sin(this.phase);
    const idle = Math.sin(time * 1.7) * 0.03 * (1 - k);
    const angles = {
      legL: s * 0.55 * k,
      legR: -s * 0.55 * k,
      armL: -s * 0.45 * k + idle,
      armR: s * 0.45 * k - idle,
    };
    const bob = Math.abs(Math.cos(this.phase)) * 0.045 * k;

    M.identity(this.base);
    M.translate(this.base, this.base, x, y + bob, z);
    M.rotateY(this.base, this.base, -yaw);
    for (let i = 0; i < this.spec.length; i++) {
      const sp = this.spec[i];
      const m = this.parts[i].model;
      m.set(this.base);
      M.translate(m, m, sp.pivot[0], sp.pivot[1], sp.pivot[2]);
      if (sp.swing) M.rotateX(m, m, angles[sp.swing]);
      M.translate(m, m, sp.off[0], sp.off[1], sp.off[2]);
      M.scale(m, m, sp.size[0], sp.size[1], sp.size[2]);
    }
    return this;
  }
}

export const LABEL_HEIGHT = 2.15;
