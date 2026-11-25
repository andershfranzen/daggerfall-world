// First-person weapon animation: which WEAPON*.CIF record and frame to show,
// where it sits on screen, and how a mouse drag maps to a swing direction.
//
// Adapted from daggerfall-js-source src/combat/fpsWeapon.js (MIT, (c) 2026
// Lattymoy), itself translated from Daggerfall Unity's Game/WeaponBasics.cs,
// Game/FPSWeapon.cs and Game/WeaponManager.cs (MIT, (c) 2009-2023 Daggerfall
// Workshop). See ./THIRD_PARTY_NOTICES.txt. DOM-free so it can be unit tested.
//
// Departures: the item → set mapping reads this server's template strings
// (or its `weaponType`) rather than classic template indices; a swing that
// arrives mid-swing is queued (one deep) instead of dropped, because swings
// are server-approved; placement can keep the classic 4:3 pixel aspect on
// wide windows (see weaponQuad). Metal tables are from ImageProcessing.cs.

export const ALIGN = Object.freeze({ Left: 0, Center: 1, Right: 2 });

/** WeaponStates order, which is also the row order of every animation table. */
export const STATES = Object.freeze(['Idle', 'StrikeDown', 'StrikeDownLeft', 'StrikeLeft', 'StrikeRight', 'StrikeDownRight', 'StrikeUp']);
const STATE_INDEX = Object.fromEntries(STATES.map((s, i) => [s, i]));

/** Wire directions for `combat.attack` and `swing` events, and their weapon states (FPSWeapon.OnAttackDirection). */
export const DIRECTION_STATE = Object.freeze({
  down: 'StrikeDown',
  downLeft: 'StrikeDownLeft',
  left: 'StrikeLeft',
  right: 'StrikeRight',
  downRight: 'StrikeDownRight',
  up: 'StrikeUp',
  upLeft: 'StrikeUp',
  upRight: 'StrikeUp',
});

/** Normalises 'down-left', 'DownLeft', 'StrikeDownLeft', 'down_left' … to a DIRECTION_STATE key, or null. */
export function normalizeDirection(direction) {
  if (typeof direction !== 'string') return null;
  const flat = direction.replace(/^strike/i, '').replace(/[\s_-]/g, '').toLowerCase();
  for (const key of Object.keys(DIRECTION_STATE)) if (key.toLowerCase() === flat) return key;
  return null;
}

export const SET = Object.freeze({
  LongBlade: 'LongBlade', Staff: 'Staff', Dagger: 'Dagger', Mace: 'Mace', Flail: 'Flail',
  Warhammer: 'Warhammer', Battleaxe: 'Battleaxe', Bow: 'Bow', Melee: 'Melee', Werecreature: 'Werecreature',
});

/** WeaponBasics.GetWeaponFilename: plain and enchanted (WEAPO1xx) files per set. */
export const WEAPON_FILE = Object.freeze({
  LongBlade: ['WEAPON04.CIF', 'WEAPO104.CIF'],
  Staff: ['WEAPON01.CIF', 'WEAPO101.CIF'],
  Dagger: ['WEAPON02.CIF', 'WEAPO102.CIF'],
  Mace: ['WEAPON05.CIF', 'WEAPO105.CIF'],
  Flail: ['WEAPON06.CIF', 'WEAPO106.CIF'],
  Warhammer: ['WEAPON07.CIF', 'WEAPO107.CIF'],
  Battleaxe: ['WEAPON08.CIF', 'WEAPO108.CIF'],
  Bow: ['WEAPON09.CIF', 'WEAPON09.CIF'],
  Melee: ['WEAPON10.CIF', 'WEAPON10.CIF'],
  Werecreature: ['WEAPON11.CIF', 'WEAPON11.CIF'],
});

export function weaponFile(set, enchanted = false) {
  const pair = WEAPON_FILE[set];
  return pair ? pair[enchanted ? 1 : 0] : null;
}

const IDLE_FPS = 10, STRIKE_FPS = 10, BOW_FPS = 10;
const A = (Record, NumFrames, FramePerSecond, Alignment, Offset) => Object.freeze({ Record, NumFrames, FramePerSecond, Alignment, Offset });

// WeaponBasics' tables, verbatim (row order = STATES).
export const MELEE_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Right, 0.15),
  A(1, 5, STRIKE_FPS, ALIGN.Center, 0), A(2, 5, STRIKE_FPS, ALIGN.Center, 0), A(3, 5, STRIKE_FPS, ALIGN.Center, 0),
  A(4, 5, STRIKE_FPS, ALIGN.Center, 0), A(5, 5, STRIKE_FPS, ALIGN.Center, 0), A(6, 5, STRIKE_FPS, ALIGN.Center, 0),
]);
const WERECREATURE_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Center, 0.02), A(1, 5, 20, ALIGN.Right, 0.2),
  A(2, 5, 20, ALIGN.Right, 0), A(3, 5, 20, ALIGN.Right, 0), A(4, 5, 20, ALIGN.Right, 0),
  A(5, 5, 20, ALIGN.Left, 0), A(6, 5, 20, ALIGN.Left, 0.2),
]);
export const GENERAL_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Right, 0),
  A(1, 5, STRIKE_FPS, ALIGN.Right, 0), A(2, 5, STRIKE_FPS, ALIGN.Right, 0), A(3, 5, STRIKE_FPS, ALIGN.Right, 0),
  A(4, 5, STRIKE_FPS, ALIGN.Left, 0), A(5, 5, STRIKE_FPS, ALIGN.Left, 0), A(6, 5, STRIKE_FPS, ALIGN.Right, 0),
]);
export const DAGGER_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Right, 0.04),
  A(1, 5, STRIKE_FPS, ALIGN.Right, 0), A(2, 5, STRIKE_FPS, ALIGN.Right, 0), A(3, 5, STRIKE_FPS, ALIGN.Right, 0),
  A(4, 5, STRIKE_FPS, ALIGN.Left, 0), A(5, 5, STRIKE_FPS, ALIGN.Left, 0), A(6, 5, STRIKE_FPS, ALIGN.Right, 0),
]);
export const STAFF_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Right, 0.02),
  A(1, 5, STRIKE_FPS, ALIGN.Right, 0), A(2, 5, STRIKE_FPS, ALIGN.Right, 0), A(3, 5, STRIKE_FPS, ALIGN.Center, 0),
  A(4, 5, STRIKE_FPS, ALIGN.Center, 0), A(5, 5, STRIKE_FPS, ALIGN.Left, 0), A(6, 5, STRIKE_FPS, ALIGN.Right, 0),
]);
export const MAGIC_BATTLEAXE_ANIMS = Object.freeze([
  A(0, 1, IDLE_FPS, ALIGN.Right, 0),
  A(1, 5, STRIKE_FPS, ALIGN.Right, 0), A(2, 5, STRIKE_FPS, ALIGN.Right, 0),
  A(4, 5, STRIKE_FPS, ALIGN.Right, 0), A(5, 5, STRIKE_FPS, ALIGN.Left, 0), // records shuffled, verbatim
  A(3, 5, STRIKE_FPS, ALIGN.Left, 0), A(6, 5, STRIKE_FPS, ALIGN.Right, 0),
]);
export const BOW_ANIMS = Object.freeze([
  A(0, 1, BOW_FPS, ALIGN.Right, 0),
  A(0, 7, BOW_FPS, ALIGN.Right, 0), A(0, 7, BOW_FPS, ALIGN.Right, 0), A(0, 7, BOW_FPS, ALIGN.Right, 0),
  A(0, 7, BOW_FPS, ALIGN.Right, 0), A(0, 7, BOW_FPS, ALIGN.Right, 0), A(0, 4, BOW_FPS, ALIGN.Right, 0),
]);

/** WeaponBasics.GetWeaponAnims. */
export function weaponAnims(set, enchanted = false) {
  if (set === SET.Melee) return MELEE_ANIMS;
  if (set === SET.Werecreature) return WERECREATURE_ANIMS;
  if (set === SET.Dagger) return DAGGER_ANIMS;
  if (set === SET.Staff) return STAFF_ANIMS;
  if (set === SET.Battleaxe && enchanted) return MAGIC_BATTLEAXE_ANIMS;
  if (set === SET.Bow) return BOW_ANIMS;
  return GENERAL_ANIMS;
}

// ItemHelper.ConvertItemToAPIWeaponType, keyed by item name words instead of template index.
const NAME_SETS = [
  [/\b(long[\s-]?bow|short[\s-]?bow|bow)\b/, SET.Bow],
  [/\bdagger\b/, SET.Dagger],
  [/\bstaff\b/, SET.Staff],
  [/\b(tanto|short[\s-]?sword|wakazashi|broad[\s-]?sword|saber|sabre|long[\s-]?sword|dai[\s-]?katana|katana|claymore)\b/, SET.LongBlade],
  [/\bmace\b/, SET.Mace],
  [/\bflail\b/, SET.Flail],
  [/\bwar[\s-]?hammer\b/, SET.Warhammer],
  [/\b(battle[\s-]?axe|war[\s-]?axe)\b/, SET.Battleaxe],
];

/**
 * The animation set for the right-hand item, or Melee for bare hands.
 * Returns null for an item that has no first-person art (e.g. a shield).
 * @param {object|null|undefined} item inventory entry `{template,name,...}`
 */
export function weaponSetForItem(item) {
  if (!item) return SET.Melee;
  if (typeof item.weaponType === 'string' && SET[item.weaponType]) return item.weaponType;
  const text = `${item.template ?? ''} ${item.name ?? ''}`.toLowerCase().replace(/[_-]/g, ' ');
  for (const [re, set] of NAME_SETS) if (re.test(text)) return set;
  return null;
}

export function isEnchanted(item) {
  return !!(item && (item.enchanted || (Array.isArray(item.enchantments) && item.enchantments.length) || item.magic));
}

/** The right-hand item from an RPG character message, or null. */
export function rightHandItem(rpg) {
  const id = rpg?.equipment?.rightHand;
  if (id == null || !Array.isArray(rpg?.inventory)) return null;
  return rpg.inventory.find((it) => it && it.id === id) ?? null;
}

/**
 * WeaponManager.TrackMouseAttack: classify a drag. `dx`, `dy` are screen
 * pixels (y down); `longest` is the larger viewport side. Returns a wire
 * direction or null below AttackThreshold (5% of the longest side).
 */
export const ATTACK_THRESHOLD = 0.05;
export function classifyDrag(dx, dy, travel, longest) {
  if (!(longest > 0) || travel / longest < ATTACK_THRESHOLD) return null;
  let angle = (Math.atan2(-dy, dx) * 180) / Math.PI; // Unity mouse Y is up
  if (angle < 0) angle += 360;
  const section = Math.ceil(angle / 15);
  if (section <= 1 || section >= 24) return 'right';
  if (section <= 11) return 'up';
  if (section <= 13) return 'left';
  if (section <= 17) return 'downLeft';
  if (section <= 19) return 'down';
  return 'downRight';
}

/** The classic 320x200 surface the weapon images are drawn on. */
export const NATIVE_W = 320;
export const NATIVE_H = 200;
/** Classic pixels were shown at 4:3, so a native pixel is 1.2 times taller than wide. */
export const CLASSIC_PIXEL_ASPECT = (NATIVE_W / NATIVE_H) / (4 / 3);

/**
 * FPSWeapon.UpdateWeapon placement: bottom-anchored on a viewport of
 * `width`×`height`, aligned per the table row. `aspect: 'classic'` (default)
 * keeps the 4:3 classic proportions on any window by scaling from height;
 * `aspect: 'stretch'` reproduces the classic full-window stretch.
 */
export function weaponQuad(width, height, recordSize, anim, { aspect = 'classic', offsetHeight = 0 } = {}) {
  const scaleY = height / NATIVE_H;
  const scaleX = aspect === 'stretch' ? width / NATIVE_W : scaleY / CLASSIC_PIXEL_ASPECT;
  const w = recordSize.width * scaleX;
  const h = recordSize.height * scaleY;
  let x;
  if (anim.Alignment === ALIGN.Left) x = width * anim.Offset;
  else if (anim.Alignment === ALIGN.Center) x = width / 2 - w / 2;
  else x = width * (1 - anim.Offset) - w;
  return { x, y: height - h - offsetHeight, w, h };
}

/** FPSWeapon's leftUnarmedAnims - the bare-handed left strike plays this frame sequence. */
export const LEFT_UNARMED_FRAMES = Object.freeze([0, 1, 2, 3, 4, 2, 1, 0]);

// Timing (FormulaHelper.cs, GameManager.cs).
export const CLASSIC_FRAME_UPDATE = 980;
export const CLASSIC_UPDATE_INTERVAL = 0.0625; // the bow's tick
export const HIT_FRAME_MELEE = 2; // FPSWeapon.GetHitFrame
export const HIT_FRAME_BOW = 5;
export const BOW_SOUND_FRAME = 4;
export const BOW_DRAWN_HOLD_FRAME = 3; // StrikeUp's last frame: fully drawn
export const MAX_BOW_HELD_DRAWN_SECONDS = 10; // WeaponManager: a held draw is let down after this

const clampSpeed = (s) => (Number.isFinite(s) ? Math.min(Math.max(s, 0), 100) : 50);
/** FormulaHelper.GetMeleeWeaponAnimTime: seconds per frame. */
export const meleeFrameTime = (speed = 50) => (3 * (115 - clampSpeed(speed))) / CLASSIC_FRAME_UPDATE;
/** FormulaHelper.GetBowCooldownTime: seconds the bow is hidden after a shot or a let-down draw. */
export const bowCooldownTime = (speed = 50) => (10 * (100 - clampSpeed(speed)) + 800) / CLASSIC_FRAME_UPDATE;

/**
 * FPSWeapon.AnimateWeapon / OnAttackDirection / ChangeWeaponState for one
 * weapon. Melee: `strike(direction)` plays the one-shot and returns to Idle;
 * a strike that arrives mid-swing waits for it to finish (at most one is
 * kept), so server-approved swings are never dropped or stacked. Bow:
 * `draw()` steps StrikeUp to the drawn frame and holds; `release()` plays
 * StrikeDown from the frame the bow stands on (bows keep their frame on a
 * state change), after which the bow is hidden for its cooldown. With
 * `bowDrawback` off (the classic default) the idle bow rests drawn on frame
 * 3, so an instant shot looses straight away.
 *
 * `update(dt, speed)` returns the moments crossed this step: 'hit', 'bowSound',
 * 'done', 'undraw'. One frame step per tick, remainder dropped, as the
 * coroutine resumes once per wait.
 */
export class WeaponAnimator {
  constructor(set, enchanted = false, { bowDrawback = false } = {}) {
    this.set = set;
    this.isBow = set === SET.Bow;
    this.anims = weaponAnims(set, enchanted);
    this.bowDrawback = !!bowDrawback;
    this.state = 'Idle';
    this.frame = this.#rest();
    this.acc = 0;
    this.leftStep = 0;
    this.heldTime = 0;
    this.cooldown = 0;
    this.queued = null;
  }

  #rest() {
    return this.isBow && !this.bowDrawback ? BOW_DRAWN_HOLD_FRAME : 0;
  }

  get attacking() {
    return this.state !== 'Idle';
  }

  get drawing() {
    return this.isBow && this.state === 'StrikeUp';
  }

  /** The bow is hidden while it cools down after a shot (FPSWeapon.ShowWeapon). */
  get visible() {
    return !(this.isBow && this.state === 'Idle' && this.cooldown > 0);
  }

  #change(state) {
    this.state = state;
    if (!this.isBow || state === 'Idle') this.frame = state === 'Idle' ? this.#rest() : 0;
    this.acc = 0;
    this.leftStep = 0;
    this.heldTime = 0;
  }

  /** A server-approved melee swing (or a bow shot: any direction but 'up' looses). */
  strike(direction) {
    const key = normalizeDirection(direction);
    if (!key) return false;
    if (this.isBow) return key === 'up' || key === 'upLeft' || key === 'upRight' ? this.draw() : this.release();
    if (this.attacking) {
      this.queued = key;
      return false;
    }
    this.#change(DIRECTION_STATE[key]);
    return true;
  }

  /** Start drawing the bow (Idle only, not while cooling down). */
  draw() {
    if (!this.isBow || this.attacking || this.cooldown > 0) return false;
    this.#change('StrikeUp');
    return true;
  }

  /** Loose: from Idle (instant shot) or from a draw (FPSWeapon's one allowed interrupt). */
  release() {
    if (!this.isBow || this.cooldown > 0) return false;
    if (this.state !== 'Idle' && this.state !== 'StrikeUp') return false;
    this.#change('StrikeDown');
    return true;
  }

  /** Let a draw down without shooting; it costs the full cooldown (WeaponManager). */
  cancelDraw(speed = 50) {
    if (!this.drawing) return false;
    this.#change('Idle');
    this.cooldown = bowCooldownTime(speed);
    return true;
  }

  update(dt, speed = 50) {
    const events = [];
    if (!(dt > 0)) return events;
    dt = Math.min(dt, 1);
    if (this.state === 'Idle') {
      if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
      if (this.queued && !this.isBow) {
        const q = this.queued;
        this.queued = null;
        this.#change(DIRECTION_STATE[q]);
      }
      return events;
    }
    const anim = this.anims[STATE_INDEX[this.state]];
    const tick = this.isBow ? CLASSIC_UPDATE_INTERVAL : meleeFrameTime(speed);
    if (this.drawing) {
      this.heldTime += dt;
      if (this.heldTime > MAX_BOW_HELD_DRAWN_SECONDS) {
        this.cancelDraw(speed);
        events.push('undraw');
        return events;
      }
    }
    this.acc += dt;
    if (this.acc < tick) return events;
    this.acc = 0;
    if (this.set === SET.Melee && this.state === 'StrikeLeft') {
      this.leftStep++;
      if (this.leftStep >= LEFT_UNARMED_FRAMES.length) {
        this.#change('Idle');
        events.push('done');
      } else {
        this.frame = LEFT_UNARMED_FRAMES[this.leftStep];
        if (this.frame === HIT_FRAME_MELEE && this.leftStep < 3) events.push('hit');
      }
    } else if (this.drawing) {
      if (this.frame < anim.NumFrames - 1) this.frame++;
    } else {
      this.frame++;
      if (this.isBow && this.frame === BOW_SOUND_FRAME) events.push('bowSound');
      if (this.frame === (this.isBow ? HIT_FRAME_BOW : HIT_FRAME_MELEE)) events.push('hit');
      if (this.frame >= anim.NumFrames) {
        const bow = this.isBow;
        this.#change('Idle');
        if (bow) this.cooldown = bowCooldownTime(speed);
        events.push('done');
      }
    }
    return events;
  }

  /** `{anim, record, frame}` to draw now. The bow uses record 0 for every state. */
  current() {
    const anim = this.anims[STATE_INDEX[this.state]];
    const record = this.isBow ? 0 : anim.Record;
    return { anim, record, frame: this.frame };
  }
}

// ---------------------------------------------------------------- metal dyes

/**
 * ImageProcessing.GetMetalColorTable, verbatim: the 16 palette indices that
 * replace the weapon/armour band 0x70-0x7F for each metal.
 */
export const METAL_TABLES = Object.freeze({
  iron: [0x77, 0x78, 0x57, 0x79, 0x58, 0x59, 0x7a, 0x5a, 0x7b, 0x5b, 0x7c, 0x5c, 0x7d, 0x5d, 0x5e, 0x5f],
  steel: [0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f],
  silver: [0xe0, 0x70, 0x50, 0x71, 0x51, 0x72, 0x73, 0x52, 0x74, 0x53, 0x75, 0x54, 0x55, 0x56, 0x57, 0x58],
  elven: [0xe0, 0x70, 0x50, 0x71, 0x51, 0x72, 0x73, 0x52, 0x74, 0x53, 0x75, 0x54, 0x76, 0x56, 0x77, 0x78],
  dwarven: [0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f],
  mithril: [0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde],
  adamantium: [0x5a, 0x5b, 0x7c, 0x5c, 0x7d, 0x5d, 0x7e, 0x5e, 0x7f, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde],
  ebony: [0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde],
  orcish: [0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd],
  daedric: [0xef, 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe],
});
const MATERIAL_ORDER = ['iron', 'steel', 'silver', 'elven', 'dwarven', 'mithril', 'adamantium', 'ebony', 'orcish', 'daedric'];
const DYE_BAND = 0x70;

/**
 * The metal remap for an item's material, or null for no remap. Steel and
 * unknown/absent materials draw the file's own colours, as
 * FPSWeapon.GetWeaponTexture2D skips the dye for steel ("default colour in
 * files"). Accepts the server's names ('iron') or WeaponMaterialTypes indices.
 */
export function metalTable(material) {
  const name = typeof material === 'number' ? MATERIAL_ORDER[material] : typeof material === 'string' ? material.toLowerCase() : null;
  if (!name || name === 'steel') return null;
  return METAL_TABLES[name] ?? null;
}

/** ImageProcessing.ChangeDye(WeaponsAndArmor) into a copy of an indexed bitmap. */
export function dyeBitmap(bmp, table) {
  if (!table) return bmp;
  const data = new Uint8Array(bmp.data.length);
  for (let i = 0; i < data.length; i++) {
    const idx = bmp.data[i];
    data[i] = idx >= DYE_BAND && idx <= DYE_BAND + 0x0f ? table[idx - DYE_BAND] : idx;
  }
  return { ...bmp, data };
}
