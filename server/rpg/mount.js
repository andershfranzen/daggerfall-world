// Riding a horse outdoors (docs/gameplay-protocol.md, feature `mount`).
//
// Owns `rpg.mount = { riding: boolean, coat: 0|1, mode: 'horse'|'cart' }`. A character rides only while it owns a horse
// (inventory template `horse`, sold by general stores), stands in an exterior (`town:` or
// `wilderness:`) and is not defeated; the shared rules live in client/gameplay/mount/rules.js so
// the browser predicts the same speed.
//
// Services:
//   moveSpeed(p) -> m/s | null     game loop: mounted ground speed, null on foot (server default)
//   mount.isRiding(p) -> boolean
// Action:
//   mount.ride {on?: boolean, mode?: 'horse'|'cart'}  toggle, or set explicitly; dismounting is always allowed.
//       Without a mode, TransportManager.ToggleMount applies: the horse when owned, else the small cart
//       (DaggerfallTransportWindow offers both). The cart drives at dfCartBase (PlayerSpeedChanger).
// Events:
//   self   {kind:'mount', playerId, mounted, text}
//   nearby {kind:'mount', playerId, name, mounted}   so other players see the rider change
// Peers carry `mounted: true` (server/rpg/runtime.js publicPeer) while riding.
//
// Walking through a door (portal or interior), defeat, or losing the horse dismounts at once; the
// horse waits outside and the character stays on foot on the way back out, as in the classic game.

import { rideRefusal, isRiding, horseOf, cartOf, defaultRideMode, rideModeOf, mountedSpeed, RIDE_MODES } from '../../client/gameplay/mount/rules.js';

export const name = 'mount';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function normalizeMount(rpg) {
  const raw = isObj(rpg.mount) ? rpg.mount : {};
  rpg.mount = { riding: raw.riding === true, coat: raw.coat === 1 ? 1 : 0, ...(raw.mode === 'cart' ? { mode: 'cart' } : {}) };
  return rpg.mount;
}

export function install(ctx) {
  const services = (ctx.services ||= {});
  const location = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p.rpg?.location);

  function announce(p, mounted, text) {
    const mode = rideModeOf(p.rpg);
    ctx.notify(p, { kind: 'mount', playerId: p.id, mounted, mode, text });
    const here = location(p);
    for (const q of ctx.players.values()) {
      if (q !== p && location(q) === here && ctx.sameScene?.(q, p) !== false) ctx.notify(q, { kind: 'mount', playerId: p.id, name: p.name, mounted, mode });
    }
  }

  /** Dismount when the rules no longer allow riding. Returns true when something changed. */
  function enforce(p) {
    if (!p?.rpg) return false;
    const m = normalizeMount(p.rpg);
    if (!m.riding || isRiding(p.rpg)) return false;
    const what = rideModeOf(p.rpg) === 'cart' ? 'cart' : 'horse';
    const why = !(what === 'cart' ? cartOf(p.rpg) : horseOf(p.rpg)) ? `You no longer have a ${what}.`
      : p.rpg.defeated ? (what === 'cart' ? 'You fall from your cart.' : 'You fall from your horse.')
      : `You leave your ${what} outside.`;
    m.riding = false;
    ctx.dirty(p);
    announce(p, false, why);
    return true;
  }

  ctx.onJoin((p) => {
    normalizeMount(p.rpg);
    enforce(p);
  });

  // Doors, defeat and trades change the inputs without going through this feature.
  ctx.onTick(() => {
    for (const p of ctx.players.values()) {
      if (p.rpg?.mount?.riding === true) enforce(p);
    }
  });

  ctx.onAction('mount.ride', (p, args) => {
    const m = normalizeMount(p.rpg);
    const want = typeof args.on === 'boolean' ? args.on : !m.riding;
    if (!want) {
      if (!m.riding) return;
      m.riding = false;
      announce(p, false, 'You dismount.');
      return;
    }
    if (args.mode !== undefined && !RIDE_MODES.includes(args.mode)) throw new Error('Ride what?');
    const mode = args.mode ?? (m.riding ? rideModeOf(p.rpg) : defaultRideMode(p.rpg) ?? 'horse');
    if (m.riding && isRiding(p.rpg) && rideModeOf(p.rpg) === mode) return;
    const refusal = rideRefusal(p.rpg, mode);
    if (refusal) throw new Error(refusal);
    m.riding = true;
    if (mode === 'cart') {
      m.mode = 'cart';
      announce(p, true, 'You drive your cart.');
      return;
    }
    delete m.mode;
    const horse = horseOf(p.rpg);
    // A stable coat per horse: TEXTURE.201 record 0 (bay) or 1 (black).
    m.coat = [...String(horse.id)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2;
    announce(p, true, 'You mount your horse.');
  });

  services.moveSpeed = (p) => (p?.rpg ? mountedSpeed(p.rpg, ctx.config?.maxSpeed) : null);
  services.mount = {
    isRiding: (p) => !!p?.rpg && isRiding(p.rpg),
    mode: (p) => (p?.rpg && isRiding(p.rpg) ? rideModeOf(p.rpg) : null),
    dismount: (p) => {
      const m = p?.rpg ? normalizeMount(p.rpg) : null;
      if (!m?.riding) return false;
      m.riding = false;
      ctx.dirty(p);
      announce(p, false, 'You dismount.');
      return true;
    },
  };
  return { enforce };
}
