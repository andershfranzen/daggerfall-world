// Screen-space rain and snow over the 3D view. Cheap 2D canvas particles; they drift
// sideways when the camera turns so the precipitation feels attached to the world.

const MAX_PARTICLES = 420;

export function particleCount(type, intensity = 0.7, reduced = false) {
  const base = type === 'rain' ? 260 : type === 'thunder' ? 360 : type === 'snow' ? 200 : 0;
  const n = Math.round(base * Math.min(1, Math.max(0.3, intensity)));
  return Math.min(MAX_PARTICLES, reduced ? Math.round(n * 0.35) : n);
}

export class WeatherLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d') ?? null;
    this.p = [];
    this.type = null;
    this.drawn = false;
  }

  _size() {
    const c = this.canvas;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return { w, h, dpr };
  }

  _spawn(p, w, h, top) {
    p.x = Math.random() * w;
    p.y = top ? -Math.random() * h * 0.2 : Math.random() * h;
    p.z = 0.35 + Math.random() * 0.65; // depth: nearer is bigger and faster
    p.s = Math.random() * Math.PI * 2;
    return p;
  }

  clear() {
    if (this.ctx && this.drawn) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = false;
    this.p.length = 0;
  }

  draw({ type, intensity = 0.7, dt = 0.016, dyaw = 0, reduced = false }) {
    if (!this.ctx) return;
    const n = particleCount(type, intensity, reduced);
    if (!n) { if (this.drawn) this.clear(); this.type = type; return; }
    const { w, h, dpr } = this._size();
    if (this.type !== type) { this.p.length = 0; this.type = type; }
    while (this.p.length < n) this.p.push(this._spawn({}, w, h, false));
    if (this.p.length > n) this.p.length = n;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const turn = -dyaw * w * 0.8; // px shift from turning (≈ fov)
    const rain = type !== 'snow';
    const speed = reduced ? 0.45 : 1;
    ctx.lineCap = 'round';
    if (rain) {
      ctx.strokeStyle = 'rgba(190, 205, 225, 0.42)';
      ctx.lineWidth = 1.1 * dpr;
      ctx.beginPath();
    } else {
      ctx.fillStyle = 'rgba(240, 244, 250, 0.82)';
    }
    for (const p of this.p) {
      if (rain) {
        const vy = (900 + 700 * p.z) * dpr * speed;
        const vx = -120 * dpr * speed;
        p.y += vy * dt; p.x += vx * dt + turn * p.z;
        const len = (10 + 16 * p.z) * dpr;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - vx * (len / vy), p.y - len);
      } else {
        p.s += dt * (0.8 + p.z);
        p.y += (35 + 55 * p.z) * dpr * dt * speed;
        p.x += (Math.sin(p.s) * 18 * dpr * dt + turn * p.z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, (0.8 + 1.8 * p.z) * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.y > h + 20) this._spawn(p, w, h, true);
      if (p.x < -40) p.x += w + 80; else if (p.x > w + 40) p.x -= w + 80;
    }
    if (rain) ctx.stroke();
    this.drawn = true;
  }
}
