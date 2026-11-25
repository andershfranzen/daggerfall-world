// Pure actor logic, independent of WebGL and the DOM: which archive an entity
// or remote player is drawn from, which facing the viewer sees, which record and
// frame to show for an animation state, and a small animation state machine
// driven only by what the server already sent. Nothing here changes entity state.

import {
  ORIENTATIONS, FPS, ENEMY_ANIMS, PERSON_ANIMS, RAT_IDLE, SPECTRAL_MOVE, SPECTRAL_ATTACK, FEMALE_THIEF_IDLE,
  RAT_ARCHIVE, SPECTRAL_ARCHIVES, GUARD_ARCHIVE, TREASURE_ARCHIVE, TREASURE_ICONS,
  ENEMY_ARCHIVES, PERSON_ARCHIVES, mobileFor, corpseForArchive, peopleFor,
} from './tables.js';

export function hash(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const isFemale = (g, seed) => {
  const s = String(g ?? '').toLowerCase();
  if (s.startsWith('f')) return true;
  if (s.startsWith('m')) return false;
  return (hash(seed) >>> 3) % 2 === 1;
};

const DEAD_ANIMS = new Set(['dead', 'death', 'die', 'dying', 'corpse']);
export const ATTACK_ANIMS = new Set(['attack', 'swing', 'strike', 'melee']);
export const RANGED_ANIMS = new Set(['cast', 'spell', 'ranged', 'shoot']);
const MOVE_ANIMS = new Set(['move', 'walk', 'run', 'chase', 'flee']);
/** Daedra Seducer transformation states (server `animation`), drawn from records 23 and 22. */
export const TRANSFORM_ANIMS = new Set(['transform1', 'transform2']);

/** True when an entity should be drawn as a corpse (server-reported). */
export function isDead(e) {
  if (!e) return false;
  if (e.kind === 'corpse' || e.dead === true) return true;
  if (DEAD_ANIMS.has(String(e.animation ?? '').toLowerCase())) return true;
  return e.kind === 'monster' && typeof e.hp === 'number' && e.hp <= 0;
}

/** True when an entity carries loot the player could take. */
export function hasLoot(e) {
  if (!e) return false;
  if (e.kind === 'loot' || e.kind === 'treasure') return e.looted !== true && e.empty !== true;
  if (e.lootable === true) return true;
  if (Array.isArray(e.loot)) return e.loot.length > 0;
  if (Array.isArray(e.items)) return e.items.length > 0;
  if (typeof e.loot === 'number') return e.loot > 0;
  return false;
}

/**
 * Appearance of a shared entity. Returns
 * { archive, layout: 'enemy'|'person'|'flat', record, mobile, guard, personLike, corpse:[archive,record], key }.
 * `layout` selects the record layout: enemy = 20/25 records by state and facing,
 * person = 6-record town walker, flat = a single (possibly animated) record.
 */
export function entityAppearance(e) {
  const seed = e.id ?? e.name ?? '';
  const sprite = e.sprite && Number.isInteger(e.sprite.archive) ? e.sprite : null;
  let archive, layout, record = 0, mobile = null, guard = false, personLike = e.kind === 'npc';

  if (e.kind === 'loot' || e.kind === 'treasure') {
    archive = sprite?.archive ?? TREASURE_ARCHIVE;
    record = sprite?.record ?? TREASURE_ICONS[hash(seed) % TREASURE_ICONS.length];
    return finish({ archive, layout: 'flat', record, mobile, guard, personLike: false, corpse: null });
  }
  const typeRef = e.mobileType ?? e.mobile ?? e.enemyType ?? e.monster ?? e.type ?? e.className ?? null;
  mobile = mobileFor(typeof typeRef === 'string' && /^\d+$/.test(typeRef) ? Number(typeRef) : typeRef)
    ?? (e.kind === 'monster' ? mobileFor(e.name) : null);
  if (sprite) {
    archive = sprite.archive;
    record = sprite.record ?? 0;
  } else if (e.kind === 'npc' && !mobile) {
    const role = String(e.role ?? '').toLowerCase();
    if (role === 'guard' || role === 'watch' || role === 'citywatch') {
      archive = GUARD_ARCHIVE;
    } else {
      const set = peopleFor(e.race);
      const list = isFemale(e.gender, seed) ? set.female : set.male;
      const v = Number.isInteger(e.variant) ? e.variant : hash(seed) % list.length;
      archive = list[((v % list.length) + list.length) % list.length];
    }
  } else if (mobile) {
    archive = isFemale(e.gender, seed) ? mobile.female : mobile.male;
  } else {
    return null;
  }
  if (ENEMY_ARCHIVES.has(archive)) layout = 'enemy';
  else if (PERSON_ARCHIVES.has(archive)) layout = 'person';
  else layout = 'flat';
  guard = archive === GUARD_ARCHIVE;
  if (layout === 'person') personLike = true;
  const winged = layout === 'enemy' && e.form === 'winged';
  const corpse = e.corpseSprite && Number.isInteger(e.corpseSprite.archive)
    ? [e.corpseSprite.archive, e.corpseSprite.record ?? 0]
    : layout === 'enemy' ? (mobile?.corpse ?? corpseForArchive(archive)) : corpseForArchive(archive);
  return finish({ archive, layout, record, mobile, guard, personLike, corpse, winged });
}

/**
 * Appearance of a remote player from public peer fields. A readied player is
 * drawn from the class's armed archive (with attack records); otherwise from
 * the town-walker archive for their race and gender. Only identifiers travel:
 * pixels come from the local player's own files.
 */
export function peerAppearance(p) {
  const beast = p.form === 'werewolf' ? 9 : p.form === 'wereboar' ? 14 : null;
  if (beast !== null) {
    const m = mobileFor(beast);
    return finish({ archive: m.male, layout: 'enemy', record: 0, mobile: m, guard: false, personLike: false, corpse: m.corpse, readied: p.readied === true });
  }
  const seed = p.id ?? p.name ?? '';
  const female = isFemale(p.gender, seed);
  const readied = p.readied === true || p.readied === 'weapon' || !!p.readiedWeapon;
  if (readied) {
    const cls = mobileFor(p.className ?? p.class ?? null);
    const m = cls && cls.humanoid ? cls : mobileFor(144);
    const archive = female ? m.female : m.male;
    return finish({ archive, layout: 'enemy', record: 0, mobile: m, guard: false, personLike: false, corpse: m.corpse, readied: true });
  }
  const set = peopleFor(p.race);
  const list = female ? set.female : set.male;
  const v = Number.isInteger(p.variant) ? p.variant : hash(seed) % list.length;
  const archive = list[((v % list.length) + list.length) % list.length];
  return finish({ archive, layout: 'person', record: 0, mobile: null, guard: false, personLike: true, corpse: null, readied: false });
}

function finish(a) {
  a.key = `${a.archive}:${a.layout}:${a.record}:${a.personLike ? 1 : 0}${a.winged ? ':w' : ''}`;
  return a;
}

/**
 * Facing index 0..7 the viewer sees. Yaw follows the client convention
 * (0 = facing -z, positive turns toward +x). 0 = facing the viewer,
 * 2 = facing the viewer's left, 4 = back to the viewer, 6 = facing the viewer's right.
 */
export function facingIndex(ax, az, yaw, cx, cz) {
  const dx = cx - ax, dz = cz - az;
  if (dx === 0 && dz === 0) return 0;
  const fx = Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = Math.sin(yaw);
  const a = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
  const i = Math.round(-a / (Math.PI * 2 / ORIENTATIONS));
  return ((i % ORIENTATIONS) + ORIENTATIONS) % ORIENTATIONS;
}

/**
 * Record, mirroring and frame rate for an animation state.
 * recordCount is the archive's record count (so missing idle/ranged records fall back).
 * Returns { record, flip, fps, loop } or null for states the appearance cannot show.
 */
export function animRecord(app, state, facing, recordCount) {
  if (app.layout === 'flat') return { record: app.record, flip: false, fps: FPS.flat, loop: true };
  if (app.layout === 'person' || (app.personLike && app.guard)) {
    if (state === 'move' || state === 'attack' || state === 'ranged' || state === 'hurt') {
      // Town people have no combat records; a walking guard uses its enemy walk.
      const [record, flip] = PERSON_ANIMS.move[facing];
      return { record, flip, fps: FPS.personMove, loop: true, still: state !== 'move' };
    }
    const [record, flip] = (app.guard ? PERSON_ANIMS.guardIdle : PERSON_ANIMS.idle)[facing];
    if (record >= recordCount) return { record: 0, flip: false, fps: FPS.personIdle, loop: true };
    return { record, flip, fps: FPS.personIdle, loop: true };
  }
  // EnemyBasics Seducer*Anims: player-facing only. 23 crouch and grow wings, 22 stand and spread them,
  // then 21 winged idle/move and 20 winged attack.
  if (state === 'transform1' || state === 'transform2') {
    const record = state === 'transform1' ? 23 : 22;
    if (record < recordCount) return { record, flip: false, fps: FPS.move, loop: false };
  }
  if (app.winged && recordCount > 21) {
    const record = state === 'attack' || state === 'ranged' ? 20 : 21;
    return { record, flip: false, fps: state === 'attack' || state === 'ranged' ? FPS.attack : FPS.move, loop: !(state === 'attack' || state === 'ranged') };
  }
  const spectral = SPECTRAL_ARCHIVES.has(app.archive);
  let table, fps, loop = true;
  switch (state) {
    case 'attack':
      table = spectral ? SPECTRAL_ATTACK : ENEMY_ANIMS.attack; fps = FPS.attack; loop = false; break;
    case 'ranged':
      table = recordCount >= 25 ? ENEMY_ANIMS.ranged : ENEMY_ANIMS.attack; fps = FPS.ranged; loop = false; break;
    case 'hurt': case 'dying':
      table = ENEMY_ANIMS.hurt; fps = FPS.hurt; loop = false; break;
    case 'move':
      table = spectral ? SPECTRAL_MOVE : ENEMY_ANIMS.move; fps = FPS.move; break;
    default: // idle
      if (recordCount < 20 || spectral || app.mobile?.flying) { table = spectral ? SPECTRAL_MOVE : ENEMY_ANIMS.move; fps = FPS.move; }
      else if (app.archive === RAT_ARCHIVE) { table = RAT_IDLE; fps = FPS.idle; }
      else if (app.mobile?.id === 138 && app.archive === app.mobile.female) { table = FEMALE_THIEF_IDLE; fps = FPS.idle; }
      else { table = ENEMY_ANIMS.idle; fps = FPS.idle; }
  }
  let [record, flip] = table[facing];
  if (record >= recordCount) [record, flip] = ENEMY_ANIMS.move[facing];
  return { record, flip, fps, loop };
}

/** Frame index for elapsed seconds; one-shots clamp to the last frame. */
export function frameAt(t, fps, count, loop) {
  if (count <= 1) return 0;
  const f = Math.floor(Math.max(0, t) * fps);
  return loop ? f % count : Math.min(f, count - 1);
}

export const DYING_SECONDS = 0.9;
export const HURT_FLASH_SECONDS = 0.35;

/**
 * Per-actor animation state, fed with server-visible fields each frame.
 *   observe({ moving, hp, animation, dead, attackSeq }, now)
 *   trigger('attack'|'ranged'|'hurt', now)   (e.g. from a `swing` event)
 *   current(now) → { state, t }    state ∈ idle, move, attack, ranged, hurt, dying, corpse
 *   endOneShot()                   called by the renderer when a one-shot ran out of frames
 */
export class AnimState {
  constructor() {
    this.base = 'idle';
    this.oneShot = null;
    this.oneShotAt = 0;
    this.baseAt = 0;
    this.lastHp = null;
    this.lastAnim = null;
    this.dead = false;
    this.deadAt = -Infinity;
    this.hurtAt = -Infinity;
    this.seen = false;
  }

  observe({ moving = false, hp = null, animation = null, dead = false } = {}, now) {
    const anim = animation == null ? '' : String(animation).toLowerCase();
    if (dead) {
      if (!this.dead) {
        this.dead = true;
        // Already dead when first seen: show the corpse at once.
        this.deadAt = this.seen ? now : now - DYING_SECONDS - 1;
        this.oneShot = null;
      }
    } else if (this.dead) {
      this.dead = false;
      this.oneShot = null;
    }
    if (!this.dead) {
      if (typeof hp === 'number' && typeof this.lastHp === 'number' && hp < this.lastHp) {
        this.hurtAt = now;
        if (!this.oneShot || this.oneShot === 'hurt') this.trigger('hurt', now);
      }
      if (anim !== this.lastAnim) {
        if (ATTACK_ANIMS.has(anim)) this.trigger('attack', now);
        else if (RANGED_ANIMS.has(anim)) this.trigger('ranged', now);
      }
      const base = TRANSFORM_ANIMS.has(anim) ? anim : ATTACK_ANIMS.has(anim) ? 'attack' : RANGED_ANIMS.has(anim) ? 'ranged'
        : (moving || MOVE_ANIMS.has(anim)) ? 'move' : 'idle';
      if (base !== this.base) { this.base = base; this.baseAt = now; }
    }
    if (typeof hp === 'number') this.lastHp = hp;
    this.lastAnim = anim;
    this.seen = true;
  }

  trigger(name, now) {
    if (this.dead) return;
    this.oneShot = name;
    this.oneShotAt = now;
  }

  endOneShot() {
    // A held server attack keeps swinging; otherwise fall back to the base state.
    if ((this.oneShot === 'attack' && this.base === 'attack') || (this.oneShot === 'ranged' && this.base === 'ranged')) {
      this.oneShotAt = Infinity; // restarted on next current()
      return;
    }
    this.oneShot = null;
  }

  current(now) {
    if (this.dead) {
      const t = now - this.deadAt;
      return t < DYING_SECONDS ? { state: 'dying', t } : { state: 'corpse', t: t - DYING_SECONDS };
    }
    if (this.oneShot) {
      if (this.oneShotAt === Infinity) this.oneShotAt = now;
      return { state: this.oneShot, t: now - this.oneShotAt };
    }
    return { state: this.base === 'attack' || this.base === 'ranged' ? 'idle' : this.base, t: now - this.baseAt };
  }

  /** 0..1 strength of the brief hurt flash. */
  hurtFlash(now) {
    const t = now - this.hurtAt;
    return t >= 0 && t < HURT_FLASH_SECONDS ? 1 - t / HURT_FLASH_SECONDS : 0;
  }
}
