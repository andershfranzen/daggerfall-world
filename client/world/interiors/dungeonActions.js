// RDB object links are byte offsets within one block. A dungeon can place the
// same block more than once, so each instance also needs its signed grid address.
//
// Action records follow Daggerfall Unity's DFBlock.RdbActionFlags / RdbTriggerFlags and
// Internal/DaggerfallAction.cs (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a28.
// The rules here are pure data shared by the authoritative server, Play and the audit.
import { RDB_TYPE } from './blocks.js';
import { mul, translate, rotX, rotY, rotZ, point, SCALE, yawDegrees } from './scene.js';

export const OP = Object.freeze({
  MOVE: 1, ROTATE: 8, CAST_SPELL: 9, TEXT: 11, TEXT_INPUT: 12, TELEPORT: 14, LOCK: 16, UNLOCK: 17,
  OPEN: 18, CLOSE: 20, HURT_RANDOM: 21, HURT_22: 22, HURT_23: 23, HURT_24: 24, HURT_25: 25, POISON: 26,
  UNKNOWN_27: 27, DRAIN_MAGICKA: 28, DIALOGUE: 29, ACTIVATE: 30, GLOBAL: 31, UNKNOWN_32: 32,
  UNKNOWN_50: 50, DOOR_TEXT: 99, UNKNOWN_100: 100,
});

/** RdbTriggerFlags. Other values (lock bits on doors, NPC flat flags) are None, as Enum.IsDefined gives in DFU. */
export const TRIGGER = Object.freeze({ NONE: 0, WALK_ON: 1, DIRECT: 2, WALK_INTO: 3, ATTACK: 5, DIRECT6: 6, MULTI: 8, COLLISION9: 9, DOOR: 10 });
/** DaggerfallAction.TriggerTypes: what caused a Receive. */
export const CAUSE = Object.freeze({ CHAIN: 'chain', DIRECT: 'direct', WALK_ON: 'walkOn', WALK_INTO: 'walkInto', ATTACK: 'attack', DOOR: 'door' });
const DEFINED_TRIGGERS = new Set(Object.values(TRIGGER));
export const triggerFlag = (raw) => (DEFINED_TRIGGERS.has(raw) ? raw : TRIGGER.NONE);

/** DaggerfallAction.Receive: chained activations are always valid, others must match the trigger flag. */
export function accepts(raw, cause) {
  if (cause === CAUSE.CHAIN) return true;
  switch (triggerFlag(raw)) {
    case TRIGGER.WALK_ON: return cause === CAUSE.WALK_ON;
    case TRIGGER.DIRECT: case TRIGGER.DIRECT6: return cause === CAUSE.DIRECT;
    case TRIGGER.WALK_INTO: return cause === CAUSE.WALK_INTO;
    case TRIGGER.ATTACK: return cause === CAUSE.ATTACK;
    case TRIGGER.MULTI: return cause === CAUSE.DIRECT || cause === CAUSE.ATTACK || cause === CAUSE.WALK_INTO;
    case TRIGGER.COLLISION9: return cause === CAUSE.DIRECT || cause === CAUSE.WALK_INTO;
    case TRIGGER.DOOR: return cause === CAUSE.DOOR;
    default: return false;
  }
}
/** Collision-driven triggers (DaggerfallActionCollision is attached for 1, 3, 8 and 9). */
export const collisionTrigger = (raw) => [TRIGGER.WALK_ON, TRIGGER.WALK_INTO, TRIGGER.MULTI, TRIGGER.COLLISION9].includes(triggerFlag(raw));

const LOCKS = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25, 30, 50, 128, 255];
export const startingLock = (flags) => LOCKS[(flags >>> 4) & 15];
/** DaggerfallActionDoor.IsMagicallyHeld. */
export const MAGIC_LOCK = 20;
export const directAction = (trigger) => accepts(trigger, CAUSE.DIRECT);
export const dungeonObjectId = (block, offset) => `${block.x},${block.z}:${offset}`;

export function objectPoint(block, obj, frame) {
  const [x, y, z] = point(frame, obj.xPos * SCALE, -obj.yPos * SCALE, obj.zPos * SCALE);
  return { id: dungeonObjectId(block, obj.position), block: block.rdb.name, blockX: block.x, blockZ: block.z, offset: obj.position, x, y, z: -z };
}

/**
 * RDBLayout.AddAction{Model,Flat}Helper. `index` is the record's sound byte, which DFU uses as the spell, text and
 * sound index. Flats carry one magnitude byte that DFU uses both as Magnitude and ActionAxisRawValue.
 */
export function actionRecord(obj) {
  if (obj.type === RDB_TYPE.Model && obj.model.action?.opcode) {
    return { ...obj.model.action, trigger: obj.model.triggerFlagStartingLock, index: obj.model.soundIndex ?? 0, flat: false };
  }
  if (obj.type === RDB_TYPE.Flat && obj.flat.action) {
    return {
      opcode: obj.flat.action, trigger: obj.flat.flags, nextOffset: obj.flat.nextOffset,
      axis: obj.flat.magnitude, magnitude: obj.flat.magnitude, duration: 0, index: obj.flat.soundIndex ?? 0, flat: true,
    };
  }
  return null;
}

// ------------------------------------------------------------------ text and input

/** TEXT.RSC bases: DaggerfallAction.TYPE_11_TEXT_INDEX, TYPE_12_TEXT_INDEX and TYPE_99_TEXT_INDEX. */
export const TEXT_BASE = Object.freeze({ [OP.TEXT]: 8600, [OP.TEXT_INPUT]: 5400, [OP.DOOR_TEXT]: 7700 });

/**
 * Accepted replies for opcode 12, by TEXT.RSC prompt record (DaggerfallAction.actionTypeTwelveLookup). These are
 * the five prompts the installed blocks use: S0000004 (5404), S0000003 (5406), S0000001 (5423), S0000070 (5424)
 * and S0000160 (5464). Comparison ignores case, as string.Compare(.., true) does.
 */
export const TEXT_INPUT_ANSWERS = Object.freeze({
  5404: ['bow', 'bow arrow', 'crossbow', 'bows', 'crossbows'],
  5406: ['one', '1'],
  5423: ['benefactor', 'the benefactor'],
  5424: ['shut up', 'shutup', 'shaddup'],
  5464: ['yes', 'ok', 'i agree', 'y', 'agreed', 'done', 'fine', 'okay', 'sure', 'yep'],
});
export const textInputRecord = (action) => TEXT_BASE[OP.TEXT_INPUT] + (action?.index ?? 0);
export function answerMatches(action, reply) {
  const answers = TEXT_INPUT_ANSWERS[textInputRecord(action)];
  const text = String(reply ?? '').trim().toLowerCase();
  return !!answers && answers.some((a) => a === text);
}

/**
 * DaggerfallAction.DoorText: TEXT.RSC 7700 + index. Returns the record to show, or null when DFU skips the text
 * (index 0 and the six records that do not exist in the classic file). 7701-7704 read 7705.
 */
export function doorTextRecord(action) {
  const id = TEXT_BASE[OP.DOOR_TEXT] + (action?.index ?? 0);
  // DFU's list, plus 7720, 7722 and 7772: doors in S0000020, S0000021 and S0000205 name records that the classic
  // TEXT.RSC does not contain (tools/world-audit/mechanisms.mjs). DFU would throw; the door simply opens.
  if (id === 7700 || [7706, 7711, 7712, 7715, 7717, 7719, 7720, 7722, 7772].includes(id)) return null;
  return id >= 7701 && id <= 7704 ? 7705 : id;
}
/** DoorText: classic only tests the axis byte against 5 for its trespass check. */
export const trespass = (action) => (action?.axis ?? 0) > 5;

// ------------------------------------------------------------------ hazards

const isHurt = (op) => op >= OP.HURT_22 && op <= OP.HURT_25;
/**
 * Damage and drain amounts from DaggerfallAction.DrainHealth21, DrainHealth and DrainMagicka.
 * `count` is the action's activation count after this activation; `random(lo, hi)` returns an integer in [lo, hi).
 * Returns null when the activation does nothing (opcode 21 acts on every 20th activation).
 */
export function hazardAmount(action, { level = 1, count = 1, random = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo)) } = {}) {
  const lv = Math.max(1, Math.trunc(level) || 1);
  if (action.opcode === OP.HURT_RANDOM) {
    if (count % 20 !== 0) return null;
    const lo = Math.max(1, action.magnitude | 0), hi = Math.max(1, action.index | 0);
    return { pool: 'health', amount: (hi > lo ? random(lo, hi) : lo) * lv };
  }
  if (isHurt(action.opcode)) return { pool: 'health', amount: (action.flat ? action.magnitude | 0 : action.axis | 0) * lv };
  if (action.opcode === OP.DRAIN_MAGICKA) return { pool: 'magicka', amount: Math.max(1, action.flat ? action.magnitude | 0 : action.axis | 0) };
  return null;
}
/** DaggerfallAction.CastSpell cooldown: each activation removes 45.454546; a cast resets it to 1000. */
export const SPELL_COOLDOWN = Object.freeze({ step: 45.454546, reset: 1000 });

// ------------------------------------------------------------------ opcode families

/**
 * How each opcode is executed. `chain`: DaggerfallAction.Play activates the next object before any delegate, so
 * opcodes with no delegate still pass the activation on. Evidence for the opcodes DFU leaves unexplained is kept
 * with the audit (docs/dungeon-access.md).
 */
export const OPCODE_FAMILY = Object.freeze({
  [OP.MOVE]: 'motion', 2: 'motion', 3: 'motion', 4: 'motion', 5: 'motion', 6: 'motion', 7: 'motion', [OP.ROTATE]: 'motion',
  [OP.CAST_SPELL]: 'spell', [OP.TEXT]: 'text', [OP.TEXT_INPUT]: 'textInput', [OP.TELEPORT]: 'teleport',
  [OP.LOCK]: 'door', [OP.UNLOCK]: 'door', [OP.OPEN]: 'door', [OP.CLOSE]: 'door',
  [OP.HURT_RANDOM]: 'damage', [OP.HURT_22]: 'damage', [OP.HURT_23]: 'damage', [OP.HURT_24]: 'damage', [OP.HURT_25]: 'damage',
  [OP.POISON]: 'poison', [OP.DRAIN_MAGICKA]: 'magicka', [OP.ACTIVATE]: 'chain', [OP.GLOBAL]: 'global',
  [OP.DOOR_TEXT]: 'doorText', [OP.DIALOGUE]: 'dialogue',
  [OP.UNKNOWN_27]: 'chain', [OP.UNKNOWN_32]: 'chain', [OP.UNKNOWN_50]: 'chain', [OP.UNKNOWN_100]: 'chain',
});
export const opcodeFamily = (op) => OPCODE_FAMILY[op] ?? 'chain';

// RDBLayout.Get{Rotation,Translation}ActionVector. These are the resting
// transforms at each end of the authored motion, also used for collision.
export function actionTransform(matrix, action, description) {
  if (!action) return null;
  let { opcode, axis, magnitude } = action;
  if (opcode === OP.ROTATE) {
    if (axis === 13 && description === 'TRP') { axis = 2; magnitude = 400; }
    if (axis === 12 && description === 'C0E') axis = 3;
    const rotate = [null, rotX, rotX, rotY, rotY, rotZ, rotZ][axis];
    return rotate ? mul(matrix, rotate(yawDegrees(magnitude) * (axis % 2 ? 1 : -1))) : null;
  }
  if (opcode >= 2 && opcode <= 7) {
    magnitude = axis * 8;
    axis = [2, 1, 4, 3, 6, 5][opcode - 2];
    opcode = OP.MOVE;
  }
  if (opcode !== OP.MOVE) return null;
  if (axis === 11 && description === 'C0X') axis = 3;
  const distance = magnitude * SCALE;
  const delta = [null, [distance, 0, 0], [-distance, 0, 0], [0, -distance, 0],
    [0, distance, 0], [0, 0, distance], [0, 0, -distance]][axis];
  return delta ? mul(translate(...delta), matrix) : null;
}

export function mechanismLabel(mechanism) {
  if (mechanism.door) return 'Door';
  if (mechanism.mantella) return 'Mantella';
  switch (mechanism.action?.opcode) {
    case OP.TELEPORT: return 'Transport';
    case OP.TEXT: case OP.TEXT_INPUT: return mechanism.flat ? 'Speak' : 'Read';
    case OP.DOOR_TEXT: return 'Examine';
    default: return 'Switch';
  }
}

/** Bounds in the scene's output frame, used for moving geometry and interaction reach. */
export function mechanismBounds(positions, from = 0, to = positions?.length ?? 0) {
  if (!positions || !(to > from)) return null;
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = from; i < to; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  return bounds;
}

export function mechanismAimPoints(mechanism, bounds) {
  const { door, x, y, z } = mechanism;
  const points = [[x, door ? y + 1.1 : y, z]];
  if (bounds) points.push([
    (bounds.minX + bounds.maxX) / 2,
    door ? Math.min(bounds.maxY, bounds.minY + 1.1) : (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ]);
  return points;
}
