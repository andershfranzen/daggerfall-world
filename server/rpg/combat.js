// Server-authoritative shared monster combat (docs/gameplay-protocol.md, "Combat").
//
// Owns `rpg.readied`, `rpg.defeated`, monster entities (`kind:'monster'`) and their corpses.
// Every player in a location sees the same monster entity; all rolls, ranges, cooldowns,
// line of sight, damage, death and rewards are decided here. Clients only send intent.
//
// Classic rules and data are adapted from Daggerfall Unity (MIT): see combat/formulas.js,
// combat/monsters.js and combat/THIRD_PARTY_NOTICES.txt.
//
// Actions
//   combat.ready  {ready:boolean}
//   combat.attack {targetId?, direction?}   direction: down|downLeft|left|right|downRight|up
//   combat.loot   {targetId}                 one claim per corpse, rewards through the inventory service
//   combat.revive {targetId}                 help a defeated companion up (same location, within reach)
// Services
//   damageEntity(p, entityOrId, amount, opts?) -> {damage, hp, killed}   for magic and other trusted callers
//   isDefeated(p) -> boolean
//   monstersIn(location) -> living monster entities (callers must check access)
//   summonCombatAlly(p, monsterId, origin) -> owned monster or null when there is no eligible enemy nearby
// Game events (ctx.nearby unless noted)
//   swing {playerId, direction, weapon}             every accepted attack, hit or miss, targeted or not
//   hit {playerId, attackerId?, entityId, damage, hp, maxHp, source}
//   miss {playerId, entityId} / ineffective (private) {entityId, text}
//   monsterAttack {entityId, targetId, hit, damage}
//   death {entityId, name, killerId}; kill (private, killer) {entityId, name}
//   defeat {playerId, name, by}; resurrect {playerId, x, z} (after combat.rise or resurrectMs); looted {entityId, playerId}; loot (private)
// Gameplay events (ctx.emit): swing {player, playerId, direction}, damage {target, source, amount},
//   kill {player, entity, noLoot:true}, loot {player, entity, gold, items}, defeat {player, entity}
//
// Optional services used when present: worldClock (night), canSee + collision (LOS, walkable
// steps, spawn placement), damagePlayer / revivePlayer / spendFatigue / advanceSkill (character),
// getEquippedWeapon / getArmorValues / findItem / takeItem / giveItem / damageItem / damageArmor
// (inventory), interruptRest (atmosphere), encounterSites(location) -> [{x,z,table?,monsters?,count?}]
// (dungeon markers from interiors, when a feature provides them).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOCATION } from './runtime.js';
import { PakMap } from '../../client/gameplay/travel/catalog.js';
import { parseWildernessId } from '../../client/world/wilderness/data.js';
import {
  ENEMY_BY_ID,
  ENCOUNTER_TABLES,
  ENEMY_EXTRAS,
  RESERVED_IDS,
  UNDERWATER_TABLE,
  hasBowAttack,
  DUNGEON_TABLE,
  chooseEncounter,
  classicDungeonSlots,
  climateEncounterTable,
  buildingEncounterTable,
  enemySpells,
  enemyGroup,
  hitMarkers,
  intermittentSpawn,
  isAquatic,
  monsterSkill,
} from './combat/monsters.js';
import { monsterCareerResolver } from './combat/careers.js';
import { generateRandomLoot } from './items/loot.js';
import {
  CLASSIC_UNIT, HEARING_RANGE, PURSUIT_SECONDS, SIGHT_RANGE, STEALTH_RANGE,
  classicEnemySpeed, enemyLanguage, pacificationChance, stealthChance,
} from './combat/senses.js';
import {
  BODY_PART_NAMES,
  BOW_RANGE,
  MELEE_REACH,
  SWINGS,
  SWING_FATIGUE,
  armorToHit,
  monsterAttack,
  monsterMeleeSeconds,
  playerAttack,
  rollRange,
  swingSeconds,
  weaponOf,
} from './combat/formulas.js';
import {
  BOW_MAX_RANGE,
  BOW_MIN_RANGE,
  BOW_SHOT_CHANCE,
  CLASSIC_UPDATE_S,
  careerResolver,
  CITY_WATCH_CAREER,
  classAttack,
  rollClassHealth,
  rollEquipment,
} from './combat/classes.js';

export const name = 'combat';

// Monster IDs (MobileTypes) used by the authored demonstration path.
const RAT = 0;
const GIANT_BAT = 3;
const ORC = 7;

export const DEFAULTS = Object.freeze({
  /** Extra metres accepted beyond classic reach for latency and body radius. */
  reachSlack: 0.75,
  /** Half-angle (degrees) of the melee arc in front of the player. */
  meleeArc: 60,
  /** Half-angle (degrees) of the aimed bow cone. */
  bowArc: 12,
  /** Classic arrow recovery: fraction of non-conjured player arrows hitting an enemy that remain recoverable on its corpse. */
  arrowRecoveryChance: 1,
  /** Accept a swing this much earlier than the classic animation time (ms) for jitter. */
  swingTolerance: 120,
  /** Sight limit. Geometry and the forward half-plane constrain awareness inside it. */
  aggroRange: SIGHT_RANGE,
  /** Monsters never chase further than this from where they were placed. */
  leash: 22,
  /** Optional per-behaviour speed overrides for server operators. */
  speed: {},
  /** Melee stop distance for monsters (inside MELEE_REACH). */
  monsterReach: MELEE_REACH,
  /** Unoccupied scenes are cleared after this long and re-seeded on the next visit. */
  reclaimMs: 3 * 60_000,
  /** Corpses stay this long. */
  corpseMs: 5 * 60_000,
  /** Authored dungeon monsters respawn this long after death while the dungeon stays occupied. */
  respawnMs: 2 * 60_000,
  /** Corpses become lootable by anyone after this long; before, only by players who hurt it. */
  lootOpenMs: 60_000,
  lootReach: 3.5,
  reviveReach: 2.5,
  /**
   * Automatic resurrection delay after defeat, the cap for a browser that never reports the end of its death movie
   * (`combat.rise`). The classic death movie ANIM0012.VID runs 15.0 s (130 frames); DFU plays it to its end or a key.
   */
  resurrectMs: 16_500,
  /** Health/fatigue fraction restored on automatic resurrection at the location's spawn. */
  resurrectFraction: 0.5,
  /** Health fraction restored when a companion helps a defeated player up. */
  assistFraction: 0.25,
  /** Upper bound for a single damageEntity call. */
  maxServiceDamage: 1000,
  /**
   * Authored low-level encounter path north of the default town's spawn (origin, -z is north),
   * past the atmosphere feature's 40 m rest-safety radius so the square stays restful.
   * Each post is snapped to the nearest clear ground by the collision service when present.
   */
  demoLocation: DEFAULT_LOCATION,
  demoPath: [
    { x: 4, z: -46, monsters: [RAT] },
    { x: -4, z: -62, monsters: [RAT, GIANT_BAT] },
    { x: 2, z: -80, monsters: [ORC] },
  ],
  /** Night visitors at the same outskirts (one wave per in-game night per scene). */
  nightSites: { [DEFAULT_LOCATION]: [{ x: 0, z: -70, table: 32, count: 1 }] },
  /** Random wilderness markers use the climate/day-night table (RandomEncounters.ChooseRandomEnemy) when known. */
  climateTables: true,
  /** Classic intermittent outdoor spawns (PlayerEntity.IntermittentEnemySpawn) when climate data is available. */
  classicSpawns: true,
});

const ANIM_RECORD = { idle: 15, move: 0, attack: 5, hurt: 10, ranged: 20 };
/** SetEnemyEquipment variants for equipment-using monsters (EnemyEntity.SetEnemyCareer). */
const MONSTER_EQUIPMENT = Object.freeze({ 7: 0, 21: 0, 8: 1, 12: 1, 24: 2 });
/** ItemHelper.AssignEnemyStartingEquipment: beyond level 1, eligible weapons can carry one poisoned strike. */
const POISONED_MONSTER_WEAPONS = new Set([7, 8, 12]);
/** DaedraSeducerMobileBehaviour.secondsToTransform; each transform plays 9 frames at 6 fps. */
const SEDUCER_TRANSFORM_S = 8;
const SEDUCER_STAGE_S = 1.5;
/** EnemyAttack.minRangedDistance / maxRangedDistance and the 1/40 spell chance per classic update. */
const SPELL_SHOT_CHANCE = 1 / 40;
/** PrimaryAttackAnimSpeed: hit markers land this many frames per second into the swing. */
const ATTACK_FPS = 10;
/** FormulaHelper.OnMonsterHit: Spider Touch (SPELLS.STD 66) from spiders and giant scorpions. */
const PARALYSIS_TOUCH = 66;
/** Largest foot-height gap still treated as the same floor for melee, aggro and looting (stairs, ramps). */
const FLOOR_REACH = 2.2;
/** IntermittentEnemySpawn minimum distances (classic units of metres). */
const MIN_SPAWN_DISTANCE = 10;
/** ArrowMissile.prefab movement speed (m/s). */
const ARROW_SPEED = 35;
const ARROW_RADIUS = 0.5;

/**
 * Climate (CLIMATE.PAK value) of a town or wilderness location, from the operator's ARENA2. Towns are found through
 * the travel catalogue's map pixel. Returns null when unknown (no data): outdoor random encounters then use the
 * table the marker source gave.
 */
export function climateResolver(dataPath, services, log) {
  let pak;
  const load = () => {
    if (pak !== undefined) return pak;
    pak = null;
    try {
      const f = dataPath && readdirSync(dataPath).find((n) => n.toUpperCase() === 'CLIMATE.PAK');
      if (f) pak = new PakMap(new Uint8Array(readFileSync(join(dataPath, f))), 'CLIMATE.PAK');
    } catch (err) {
      log?.warn?.(`[combat] CLIMATE.PAK unreadable: ${err.message}`);
    }
    return pak;
  };
  return (location) => {
    const w = parseWildernessId(location);
    let px = w ? { x: w.px, y: w.py } : null;
    if (!px) {
      try {
        const entry = services.travel?.lookup?.(location);
        if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) px = { x: entry.x, y: entry.y };
      } catch {}
    }
    if (!px) return null;
    return load()?.atMapPixel(px.x, px.y) ?? null;
  };
}
/** MobileTeams.PlayerAlly, also used by the Location Loader's TeamOverride. */
const TEAM_PLAYER_ALLY = 1;
const SUMMON_ENEMY_RANGE = 12;
const r2 = (v) => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrapAngle = (a) => {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};
/** yaw = 0 faces -z; positive yaw turns toward +x (server/game.js). */
const yawTo = (from, to) => Math.atan2(to.x - from.x, -(to.z - from.z));
const REFLEXES = ['Very High', 'High', 'Average', 'Low', 'Very Low'];
const floats = (e) => e.behaviour === 'flying' || e.behaviour === 'spectral' || e.behaviour === 'aquatic';
const snapshotPosition = (e, y) => ({ x: e.x, z: e.z, y });

export function install(ctx, options = {}) {
  const cfg = { ...DEFAULTS, ...options, speed: { ...DEFAULTS.speed, ...(options.speed || {}) } };
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const S = ctx.services;
  const locationOf = (p) => ctx.location(p);
  const careerFor = options.careerFor ?? careerResolver(ctx.dataPath ?? null, ctx.log);
  const monsterCareerFor = options.monsterCareerFor ?? monsterCareerResolver(ctx.dataPath ?? null, ctx.log);
  // The authored demonstration path and night post are invented placements: only for servers without game data, or
  // when a fixture passes them explicitly. An installed game shows only source encounters (markers, classic spawns).
  const demoEnabled = !ctx.dataPath || options.demoPath !== undefined || options.nightSites !== undefined;
  const climateOf = options.climateOf ?? climateResolver(ctx.dataPath ?? null, S, ctx.log);
  /** Evidence counters: spawns by type and origin, and source records that could not become a creature (with why). */
  const stats = { spawned: new Map(), skipped: new Map() };
  const countSpawn = (id, origin) => {
    const k = `${id}|${origin}`;
    const previous = stats.spawned.get(k) ?? 0;
    stats.spawned.set(k, previous + 1);
    ctx.onRollback?.(() => {
      if (previous) stats.spawned.set(k, previous);
      else stats.spawned.delete(k);
    });
  };
  const skip = (id, reason) => {
    const k = `${id}|${reason}`;
    const n = (stats.skipped.get(k) ?? 0) + 1;
    stats.skipped.set(k, n);
    if (n === 1) ctx.log?.info?.(`[combat] not spawning enemy ${id}: ${reason}`);
  };

  const scenes = new Map(); // location -> {monsters:Set<id>, emptySince, nightKey}
  const nextSwing = new Map(); // player id -> ms
  const stealthPractice = new Map(); // player id -> game minute
  const alertUntil = new Map(); // player id -> real time
  const arrows = new Set();
  const resurrectAt = new Map(); // player id -> ms
  const downedAt = new Map(); // player id -> {x, z}
  let seq = 0;
  let arrowSeq = 0;

  // ------------------------------------------------------------------ character views

  const characterOf = (p) => {
    const c = p?.rpg?.character;
    return c && typeof c === 'object' && Number.isFinite(c.health) && Number.isFinite(c.maxHealth) ? c : null;
  };
  const isDefeated = (p) => !!p?.rpg?.defeated || (characterOf(p)?.health ?? 1) <= 0;
  const stat = (c, n) => (Number.isFinite(c?.attributes?.[n]) ? c.attributes[n] : 50);
  const effectiveStat = (actor, name, fallback) => {
    const value = S.effectiveAttribute?.(actor, name);
    return Number.isFinite(value) ? value : fallback;
  };
  const skillOf = (c, n) => {
    const v = c?.skills?.[n];
    const x = typeof v === 'number' ? v : v && typeof v === 'object' ? v.value : NaN;
    return Number.isFinite(x) ? x : 5;
  };
  const levelOf = (c) => Math.max(1, Math.trunc(c?.level) || 1);
  const reflexesOf = (c) => {
    const r = c?.reflexes;
    if (Number.isInteger(r) && r >= 0 && r <= 4) return r;
    const i = REFLEXES.indexOf(r);
    return i >= 0 ? i : 2;
  };

  function playerView(p) {
    const c = characterOf(p);
    let armor = [100, 100, 100, 100, 100, 100, 100];
    try {
      if (typeof S.getArmorValues === 'function') armor = armorToHit(S.getArmorValues(p));
    } catch {}
    const enchantmentArmor = Number(S.enchantmentModifiers?.(p)?.armor) || 0;
    if (enchantmentArmor) armor = armor.map((value) => value - enchantmentArmor);
    // CalculateAdrenalineRushToHit: 5, or 8 with an ImprovesTalents item (package 16).
    const rush = c && c.health < c.maxHealth / 8 && S.hasAbility?.(p, 'adrenalineRush');
    const adrenaline = rush ? (S.improvedTalents?.(p)?.includes('adrenalineRush') ? 8 : 5) : 0;
    return {
      strength: effectiveStat(p, 'Strength', stat(c, 'Strength')),
      agility: effectiveStat(p, 'Agility', stat(c, 'Agility')),
      luck: effectiveStat(p, 'Luck', stat(c, 'Luck')),
      criticalStrike: skillOf(c, 'Critical Strike'),
      dodging: skillOf(c, 'Dodging'),
      armor,
      adrenaline,
      chanceToHit: Number(S.enchantmentChanceToHit?.(p)) || 0, // DaggerfallEntity.ChanceToHitModifier (BadReactionsFrom)
      monster: false,
    };
  }

  function monsterView(e) {
    const m = e._m;
    const a = e._career?.attributes ?? e._mcareer?.attributes;
    const physical = {
      strength: effectiveStat(e, 'Strength', a?.Strength ?? 50),
      agility: effectiveStat(e, 'Agility', a?.Agility ?? 50),
      luck: effectiveStat(e, 'Luck', a?.Luck ?? 50),
    };
    if (m.human) {
      // Class enemies: career attributes, every skill at level*5+30 (max 100), equipment armour.
      const skill = Math.min(100, e.level * 5 + 30);
      return { ...physical, criticalStrike: skill, dodging: skill, handToHand: skill, armor: e._armor, monster: false };
    }
    const skill = monsterSkill(m);
    // ENEMYnnn.CFG attributes from the operator's MONSTER.BSA; without it they read as average (50).
    return {
      ...physical,
      criticalStrike: skill, dodging: skill, handToHand: skill, armor: e._armor ?? Array(7).fill(m.armor * 5), monster: true,
    };
  }

  // ------------------------------------------------------------------ entities

  function setAnim(e, animation, seconds = 0) {
    e.animation = animation;
    e._animUntil = seconds > 0 ? ctx.now() + seconds * 1000 : 0;
    if (animation === 'dead') e.sprite = { archive: e._m.corpse[0], record: e._m.corpse[1] };
    else if (e.form === 'winged' || animation === 'transform1' || animation === 'transform2') {
      // Daedra Seducer special records (EnemyBasics.Seducer*Anims, front facing only).
      const rec = animation === 'transform1' ? 23 : animation === 'transform2' ? 22 : animation === 'attack' || animation === 'ranged' ? 20 : 21;
      e.sprite = { archive: e._texture, record: rec };
    } else {
      const rec = animation === 'idle' && !e._m.hasIdle ? 0 : ANIM_RECORD[animation] ?? 0;
      e.sprite = { archive: e._texture, record: rec };
    }
  }

  function walkable(location, x, z, y) {
    const c = S.collision;
    if (c && typeof c.isClear === 'function' && typeof c.status === 'function') {
      const st = c.status(location)?.status;
      if (st === 'loading') return false;
      // Floor height (dungeon levels) is passed through for a y-aware collision service.
      return !!(Number.isFinite(y) ? c.isClear(location, x, z, y) : c.isClear(location, x, z));
    }
    return true;
  }

  function placeable(location, x, z, footY) {
    const c = S.collision;
    if (c && typeof c.nearestClear === 'function' && c.status?.(location)?.status !== 'loading') {
      const fy = Number.isFinite(footY) ? footY : undefined;
      const q = fy === undefined ? c.nearestClear(location, x, z, 8) : c.nearestClear(location, x, z, 8, fy);
      return q && Number.isFinite(q.x) && Number.isFinite(q.z) ? q : null;
    }
    return { x, z };
  }

  /** Floor under (x, z) on the storey of footY (stacked dungeon levels), or null. */
  function groundAt(location, x, z, footY) {
    const c = S.collision;
    if (!c || typeof c.groundAt !== 'function' || !Number.isFinite(footY)) return null;
    try {
      const g = c.groundAt(location, x, z, footY);
      return Number.isFinite(g) ? g : null;
    } catch {
      return null;
    }
  }

  /**
   * Foot height of an actor on stacked floors: a monster's own `y`; a player's tracked dungeon foot height
   * (collision keeps p.rpg.portal.footY inside instances). Undefined outdoors and in single-storey places.
   */
  function footOf(a, location) {
    if (Number.isFinite(a?.y)) return a.y;
    const body = a && S.collision?.bodyOf?.(a);
    if (Number.isFinite(body?.y)) return body.y;
    const portal = a?.rpg?.portal;
    return portal && portal.to === (location ?? a.location ?? locationOf(a)) && Number.isFinite(portal.footY) ? portal.footY : undefined;
  }
  /** Same storey (or unknown heights): melee, aggro and searching never reach through a floor. */
  function sameFloor(a, b, location) {
    const ya = footOf(a, location);
    const yb = footOf(b, location);
    return !Number.isFinite(ya) || !Number.isFinite(yb) || Math.abs(ya - yb) <= FLOOR_REACH;
  }

  function sees(location, a, b) {
    if (typeof S.canSee !== 'function') return true;
    try {
      const o = {};
      const ya = footOf(a, location);
      const yb = footOf(b, location);
      if (Number.isFinite(ya)) o.y1 = ya;
      if (Number.isFinite(yb)) o.y2 = yb;
      return !!S.canSee(location, a.x, a.z, b.x, b.z, o);
    } catch {
      return false;
    }
  }

  function spawnMonster(location, monsterId, x, z, scene, opts = {}) {
    const m = ENEMY_BY_ID.get(monsterId);
    if (!m) {
      skip(monsterId, RESERVED_IDS[monsterId]?.reason ?? 'not a MobileTypes enemy id');
      return null;
    }
    // Markers with a floor height (dungeon levels) are authored positions: kept on their own storey (footY), nudged
    // only out of solids on that storey, never onto the entry floor.
    let at;
    if (Number.isFinite(opts.y)) {
      at = placeable(location, x, z, opts.y) ?? { x, z };
      const g = groundAt(location, at.x, at.z, opts.y);
      if (g !== null && Math.abs(g - opts.y) < 2.5) at = { ...at, y: g };
    } else at = placeable(location, x, z);
    if (!at) {
      skip(monsterId, 'no clear ground near the marker');
      return null;
    }
    const e = {
      id: typeof opts.id === 'string' && !ctx.entities.has(opts.id) ? opts.id.slice(0, 160) : `monster-${++seq}`,
      kind: 'monster',
      name: m.name,
      location,
      x: r2(at.x),
      z: r2(at.z),
      yaw: r2(Number.isFinite(opts.yaw) ? wrapAngle(opts.yaw) : (random() * 2 - 1) * Math.PI),
      hp: 0,
      maxHp: 0,
      level: m.level,
      monsterId: m.id,
      behaviour: m.behaviour,
      affinity: m.affinity,
      origin: typeof opts.origin === 'string' ? opts.origin : 'service',
      sprite: null,
      animation: 'idle',
      noLoot: true, // corpses are looted through combat.loot, not the inventory feature's piles
      _m: m,
      _texture: m.texture,
      _home: { x: at.x, z: at.z },
      _cooldown: 0.5 + random(),
      _nextSense: 0,
      _targetId: null,
      _damageBy: new Map(),
    };
    const playerLevel = Math.max(1, Math.trunc(opts.level) || 1);
    if (m.human) {
      // EnemyEntity.SetEnemyCareer (class branch): levelled to the player, career health, equipment.
      const resolved = careerFor(m.careerIndex);
      if (!resolved) {
        skip(m.id, m.careerIndex === CITY_WATCH_CAREER ? 'CLASS18.CFG missing from the operator data' : 'no career');
        return null;
      }
      // City guards are 3 to 6 levels above the player and never carry items above iron or steel.
      const level = m.careerIndex === CITY_WATCH_CAREER ? playerLevel + 3 + Math.floor(random() * 4) : playerLevel;
      // GameObjectHelper.CreateEnemy: random gender for humans (quest foes keep the gender their script rolled).
      const female = m.texture.female !== m.texture.male && (opts.gender === 'female' || (opts.gender !== 'male' && random() < 0.5));
      const kit = rollEquipment(m.careerIndex === CITY_WATCH_CAREER ? 1 : level, random);
      Object.assign(e, { level, gender: female ? 'female' : 'male', className: m.name, careerSource: resolved.source, weapon: kit.weapon.base });
      e._texture = female ? m.texture.female : m.texture.male;
      e._career = resolved.career;
      e._weapon = kit.weapon;
      e._armor = kit.armor;
      e._items = kit.items;
      e.hp = e.maxHp = rollClassHealth(level, resolved.career.hitPointsPerLevel, random);
      if (resolved.career.tolerances) e.resistances = { ...resolved.career.tolerances };
      if (Number.isFinite(resolved.career.attributes?.Willpower)) e.willpower = resolved.career.attributes.Willpower;
    } else {
      e.hp = e.maxHp = rollRange(m.health[0], m.health[1], random);
      const mc = monsterCareerFor(m.id);
      if (mc) {
        e._mcareer = mc;
        e.careerSource = 'cfg';
        e.willpower = mc.attributes.Willpower;
        if (Object.keys(mc.tolerances).length) e.resistances = { ...mc.tolerances };
      } else e.careerSource = 'none';
      // Orcs, centaurs, the orc sergeant and warlord carry equipment (SetEnemyEquipment variants 0, 1, 2).
      const variant = MONSTER_EQUIPMENT[m.id];
      if (variant !== undefined) {
        const kit = rollEquipment(playerLevel, random, { variant, monsterArmor: m.armor * 5 });
        e._items = kit.items;
        e._armor = kit.armor;
        // EnemyEntity / CalculateAttackDamage: the weapon is used unless the weaponless attack averages more.
        const weaponAvg = Math.trunc((kit.weapon.min + kit.weapon.max) / 2);
        const bareAvg = Math.trunc((m.attacks[0][0] + m.attacks[0][1]) / 2);
        if (bareAvg <= weaponAvg) {
          e._weapon = kit.weapon;
          e.weapon = kit.weapon.base;
        }
      }
    }
    if (playerLevel > 1 && e._weapon && (m.human || POISONED_MONSTER_WEAPONS.has(m.id))
      && random() < (m.id === 139 ? 0.60 : 0.05)) {
      e._weaponPoison = rollRange(128, 135, random);
    }
    const spells = enemySpells(m, e.level);
    if (spells.length) {
      // SetEnemySpells: magicka 10 * level + 100.
      e._spells = spells;
      e.magicka = e.maxMagicka = 10 * e.level + 100;
    }
    if (ENEMY_EXTRAS[m.id]?.seducer) e._seducer = { countdown: SEDUCER_TRANSFORM_S, stage: null };
    if (Number.isFinite(opts.y)) {
      e.y = r2(Number.isFinite(at.y) ? at.y : opts.y);
      e._home.y = e.y;
    }
    if (Number.isFinite(opts.waterY)) e._waterY = opts.waterY;
    if (opts.visibleTo != null) e.visibleTo = opts.visibleTo;
    if (opts.team === TEAM_PLAYER_ALLY) {
      e._playerAlly = true;
      e.hostile = false;
    }
    if (opts.allyOwner != null) e._ally = opts.allyOwner;
    if (typeof opts.key === 'string') e._key = opts.key.slice(0, 120);
    setAnim(e, 'idle');
    ctx.entities.set(e.id, e);
    scene.monsters.add(e.id);
    countSpawn(m.id, e.origin);
    return e;
  }

  // ------------------------------------------------------------------ scenes

  const kindOf = (location) => String(location).split(':')[0].toLowerCase();

  function dungeonTable(location) {
    const s = String(location).toLowerCase();
    if (/orc/.test(s)) return DUNGEON_TABLE.orcStronghold;
    if (/cave|grotto|cavern|hole/.test(s)) return DUNGEON_TABLE.naturalCave;
    if (/cemetery|graveyard|barrow/.test(s)) return DUNGEON_TABLE.cemetery;
    return DUNGEON_TABLE.crypt;
  }

  function isNight() {
    try {
      return !!S.worldClock?.().isNight;
    } catch {
      return false;
    }
  }
  function nightKey() {
    try {
      const c = S.worldClock?.();
      return c ? String(Math.floor((c.minutes + 360) / 1440)) : null; // one key per dusk-to-dawn span
    } catch {
      return null;
    }
  }

  /**
   * Encounter posts for a location. `services.encounterSites(location)` is a chain owned by the
   * features that read authored markers (wilderness: World of Daggerfall 199.15/199.16; interiors:
   * RDB markers). It answers `undefined` (not mine), `null` (mine, still loading: seed later) or an
   * array (authoritative, possibly empty: nothing else is added). Only locations no source claims
   * get the built-in demonstration path or the dungeon placeholder.
   */
  function sitesFor(location) {
    if (typeof S.encounterSites === 'function') {
      try {
        const s = S.encounterSites(location);
        if (s === null) return null;
        if (Array.isArray(s)) return s;
      } catch (err) {
        ctx.log?.warn?.('[combat] encounterSites failed:', err?.message);
      }
    }
    if (location === cfg.demoLocation && demoEnabled) return cfg.demoPath;
    return []; // towns, wilderness, dungeons and interiors with no marker source: nothing seeded by day
  }

  /**
   * Water rules of a dungeon marker (RDBLayout, classic values: a greater y is lower). Sites carry them when the
   * marker source provides `waterLevel` (block start marker, 10000 = dry) and `markerY` (raw marker yPos).
   */
  const hasWaterData = (site) => Number.isFinite(site.waterLevel) && Number.isFinite(site.markerY);
  const underwater = (site) => hasWaterData(site) && site.waterLevel < site.markerY;

  /** Random table for an outdoor (town or wilderness) scene from its climate and the time of day, or null. */
  function outdoorTable(location) {
    const climate = climateOf(location);
    if (!Number.isFinite(climate)) return null;
    return climateEncounterTable(climate, { inLocation: kindOf(location) === 'town', night: isNight() });
  }

  function randomIds(location, site, level, scene) {
    const n = Math.max(1, Math.min(4, Math.trunc(site.count) || 1));
    const wet = underwater(site);
    // Classic dungeon selection: per-dungeon slot lists seeded with the dungeon's LocationId.
    if (Number.isFinite(site.classicSeed) && Number.isInteger(site.table) && site.table <= 18) {
      const k = `${site.table}|${site.classicSeed}|${level}`;
      scene.slots ??= new Map();
      let lists = scene.slots.get(k);
      if (!lists) scene.slots.set(k, (lists = classicDungeonSlots(site.table, site.classicSeed, level)));
      const slot = Number.isInteger(site.slot) && site.slot > 0 ? site.slot : 1 + Math.floor(random() * 6);
      return { ids: Array.from({ length: n }, () => (wet ? lists.water : lists.nonWater)[slot]), origin: wet ? 'rdb-random-water' : 'rdb-random' };
    }
    let table = Number.isInteger(site.table) ? site.table : dungeonTable(location);
    let origin = site.origin ?? (kindOf(location) === 'dungeon' ? 'rdb-random' : 'marker-random');
    if (wet) {
      table = UNDERWATER_TABLE;
      origin = 'rdb-random-water';
    } else if (kindOf(location) === 'wilderness' && cfg.climateTables) {
      // RandomEncounters.ChooseRandomEnemy for a random marker outdoors: climate and day/night pick the table.
      const t = outdoorTable(location);
      if (t !== null) {
        table = t;
        origin = 'wod-random-climate';
      }
    }
    return { ids: Array.from({ length: n }, () => chooseEncounter(table, level, random)), origin, table };
  }

  function populate(location, sites, scene, level, defaultOrigin) {
    for (const site of sites) {
      if (!site || !Number.isFinite(site.x) || !Number.isFinite(site.z)) continue;
      let ids;
      let origin;
      if (Array.isArray(site.monsters)) {
        ids = site.monsters;
        origin = site.origin ?? defaultOrigin ?? (kindOf(location) === 'dungeon' ? 'rdb-fixed' : kindOf(location) === 'wilderness' ? 'wod-fixed' : 'marker-fixed');
      } else ({ ids, origin } = randomIds(location, site, level, scene));
      ids.forEach((id, i) => {
        if (!ENEMY_BY_ID.has(id)) {
          skip(id, RESERVED_IDS[id]?.reason ?? 'not a MobileTypes enemy id');
          return;
        }
        // AddEnemy: Slaughterfish, Dreugh and Lamia are not placed where there is no water or above it.
        if (Array.isArray(site.monsters) && isAquatic(ENEMY_BY_ID.get(id)) && hasWaterData(site)
            && (site.waterLevel === 10000 || site.waterLevel - 20 > site.markerY)) {
          skip(id, 'aquatic fixed marker above the water level (classic AddEnemy check)');
          return;
        }
        const a = (i / Math.max(1, ids.length)) * 2 * Math.PI;
        const off = ids.length > 1 ? 1.5 : 0;
        const key = typeof site.key === 'string' ? (ids.length > 1 ? `${site.key}/${i}` : site.key) : undefined;
        // RDBLayout.AddEnemy: a fixed marker's Action 99 makes the enemy passive until provoked (castle guards), and
        // its Flags pick a human's gender (1 female, 2 male).
        const gender = site.gender === 'female' || site.gender === 'male' ? site.gender : undefined;
        const waterY = hasWaterData(site) && site.waterLevel !== 10000 ? site.y + (site.markerY - site.waterLevel) * CLASSIC_UNIT : undefined;
        const e = spawnMonster(location, id, site.x + Math.sin(a) * off, site.z - Math.cos(a) * off, scene, {
          level, team: site.team, yaw: site.yaw, y: site.y, key, origin, gender, waterY,
        });
        if (e && site.passive === true) e.hostile = false;
        if (e && kindOf(location) === 'dungeon' && e._ally == null && e.visibleTo == null && !e._quest && !e._m.guard) {
          e._respawn = {
            monsterId: id,
            x: site.x + Math.sin(a) * off,
            z: site.z - Math.cos(a) * off,
            y: site.y,
            yaw: site.yaw,
            team: site.team,
            key,
            origin,
            gender,
            waterY,
            passive: site.passive === true,
          };
        }
      });
    }
  }

  function scenePlayers(location) {
    return [...ctx.players.values()].filter((p) => locationOf(p) === location);
  }
  const sceneLevel = (list) => {
    const lv = list.map((p) => levelOf(characterOf(p)));
    return lv.length ? Math.round(lv.reduce((a, b) => a + b, 0) / lv.length) : 1;
  };

  function geometryReady(location) {
    const st = S.collision?.status?.(location)?.status;
    return st !== 'loading';
  }

  // Arrival readiness (server/rpg/runtime.js): a place's authored enemies are placed once its collision and
  // encounter sites are known; until the scene is seeded, a joining client keeps its loading screen.
  ctx.readiness?.('combat', (location) => {
    const scene = scenes.get(location);
    return scene ? { status: 'ready', monsters: scene.monsters.size } : { status: 'loading' };
  });

  function seedScene(location, occupants) {
    const sites = sitesFor(location);
    if (sites === null) return null; // the marker source is still loading this location
    const scene = scenes.get(location) ?? { monsters: new Set(), emptySince: null, nightKey: null };
    scene.external = false;
    scenes.set(location, scene);
    scene.quietAwakening = occupants.every((p) => S.conditionQuietArrival?.(p, location));
    if (!scene.quietAwakening) populate(location, sites, scene, sceneLevel(occupants), sites === cfg.demoPath ? 'demo' : undefined);
    return scene;
  }

  function reclaim(location, scene) {
    for (const id of scene.monsters) ctx.entities.delete(id);
    scenes.delete(location);
  }

  function nightWave(location, scene, occupants) {
    const kind = kindOf(location);
    if (kind !== 'town' && kind !== 'wilderness') return;
    if (!isNight()) return;
    const key = nightKey();
    if (key === null || scene.nightKey === key) return;
    scene.nightKey = key;
    // With climate data, classic intermittent spawns (spawnTick) decide night visitors; the authored outskirts post is
    // only the no-data demonstration.
    if (!demoEnabled || (cfg.classicSpawns && Number.isFinite(climateOf(location)))) return;
    const sites = cfg.nightSites?.[location] ?? null;
    if (!sites) return; // elsewhere night visitors need authored posts before anything walks there
    populate(location, sites.map((s) => ({ ...s, origin: 'demo' })), scene, sceneLevel(occupants));
  }

  function spawnNearPlayer(p, scene, table, origin, minDistance) {
    if (table == null) return null;
    const location = locationOf(p);
    const y = footOf(p, location);
    const level = levelOf(characterOf(p));
    const id = chooseEncounter(table, level, random);
    if (!ENEMY_BY_ID.has(id)) return null;
    const initial = random() * 2 * Math.PI;
    for (let i = 0; i < 12; i++) {
      const angle = initial + i * Math.PI / 6;
      const radius = minDistance + random() * 6;
      const at = placeable(location, p.x + Math.sin(angle) * radius, p.z - Math.cos(angle) * radius, y);
      if (!at || dist(at, p) < minDistance || !walkable(location, at.x, at.z, y)) continue;
      if (kindOf(location) === 'dungeon') {
        const ground = groundAt(location, at.x, at.z, y);
        if (S.collision?.groundAt && ground === null) continue;
        if (!sees(location, p, snapshotPosition(at, ground ?? y))) continue;
      }
      return spawnMonster(location, id, at.x, at.z, scene, { level, y, origin });
    }
    return null;
  }

  /**
   * PlayerEntity.IntermittentEnemySpawn for outdoor scenes: every elapsed game minute rolls (once each 144 minutes,
   * 1 in 24 at night in a town, 1 in 36 by day / 24 at night in the wilderness); a hit places one enemy from the
   * climate table at least 10 m from a player. Needs the operator's CLIMATE.PAK; classic spawns nothing in towns by day.
   */
  function spawnTick(location, scene, occupants) {
    if (!cfg.classicSpawns) return;
    const kind = kindOf(location);
    if (kind !== 'town' && kind !== 'wilderness') return;
    let minutes;
    try {
      minutes = S.worldClock?.()?.minutes;
    } catch {}
    if (!Number.isFinite(minutes)) return;
    minutes = Math.floor(minutes);
    const last = scene.spawnMinute ?? minutes;
    scene.spawnMinute = minutes;
    if (minutes <= last) return;
    const awake = occupants.filter((p) => !p.arriving && !isDefeated(p) && !S.isResting?.(p));
    if (!awake.length) return; // atmosphere advances resting players' encounter clocks separately
    const where = kind === 'town' ? 'location' : 'wilderness';
    for (let m = Math.max(last + 1, minutes - 1440); m <= minutes; m++) {
      if (!intermittentSpawn(m, where, random)) continue;
      const table = outdoorTable(location);
      if (table === null) return;
      const p = awake[Math.floor(random() * awake.length)];
      spawnNearPlayer(p, scene, table, 'climate-random', MIN_SPAWN_DISTANCE);
      return; // classic stops at the first spawn
    }
  }

  // ------------------------------------------------------------------ damage, death, defeat

  function applyMonsterDamage(e, amount, attacker, source, extra = null) {
    if (ctx.entities.get(e.id) !== e || e.dead || transforming(e) || !(amount >= 1)) return { damage: 0, hp: e.hp, killed: false };
    const remaining = S.absorbDamage?.(e, amount);
    if (Number.isFinite(remaining)) amount = Math.max(0, Math.min(amount, remaining));
    if (amount < 1) return { damage: 0, hp: e.hp, killed: false, absorbed: true };
    const monster = attacker?._m ? attacker : null;
    const player = monster ? null : attacker;
    const owner = monster ? allyOwner(monster) : player;
    const floor = e._ally == null && amount >= e.hp && S.onMonsterLethalHit?.(owner, e) === false ? 1 : 0;
    const n = Math.min(e.hp - floor, Math.trunc(amount));
    if (n <= 0) return { damage: 0, hp: e.hp, killed: false };
    e.hp -= n;
    if (owner) e._damageBy.set(owner.id, (e._damageBy.get(owner.id) ?? 0) + n);
    if (player) provoke(e, player);
    else if (monster) respondToMonster(e, monster);
    entityEvent(e, { kind: 'hit', playerId: player?.id ?? null, ...(monster ? { attackerId: monster.id } : {}),
      entityId: e.id, damage: n, hp: e.hp, maxHp: e.maxHp, source, ...extra });
    if (e.hp <= 0) {
      killMonster(e, owner, monster);
      return { damage: n, hp: 0, killed: true };
    }
    setAnim(e, 'hurt', 0.35);
    return { damage: n, hp: e.hp, killed: false };
  }

  function rollLoot(e, killer) {
    const m = e._m;
    const c = characterOf(killer);
    const level = levelOf(c);
    const { items } = generateRandomLoot(m.loot, {
      level, gender: c?.gender?.toLowerCase(), rand: random, books: S.books,
      magicItem: (rand) => S.randomMagicLoot?.(level, rand),
    });
    for (const template of e._items ?? []) items.push({ template });
    // EnemyEntity.SetEnemyCareer adds these independent rolls to its loot-table items.
    if (random() * 100 < (m.mapChance ?? ENEMY_EXTRAS[m.id]?.map ?? 0)) items.push({ template: 'map' });
    if (m.loot !== '-') {
      if (random() * 100 < 3) {
        const potions = ['potion-of-healing', 'potion-of-stamina', 'potion-of-magicka'];
        items.push(S.randomPotionLoot?.(random) ?? { template: potions[Math.floor(random() * potions.length)] });
      }
      if (random() * 100 < 2) {
        const recipe = S.randomPotionRecipeLoot?.(random);
        if (recipe) items.push(recipe);
      }
    }
    return items;
  }

  function killMonster(e, killer, monster) {
    e.hp = 0;
    e.dead = true;
    e._targetId = null;
    e._pursuit = null;
    e._pending = [];
    e._diedAt = ctx.now();
    if (e._respawn && cfg.respawnMs > 0) {
      const scene = scenes.get(e.location);
      if (scene) {
        scene.respawns ??= [];
        scene.respawns.push({ ...e._respawn, at: e._diedAt + cfg.respawnMs });
      }
    }
    e._loot = e._ally == null ? rollLoot(e, killer) : [];
    if (e._ally == null && Array.isArray(e._stuckArrows) && e._stuckArrows.length) {
      const stacks = new Map();
      for (const a of e._stuckArrows) {
        const key = `${a.template}|${a.variant ?? ''}`;
        const cur = stacks.get(key);
        if (cur) cur.quantity += 1;
        else stacks.set(key, { template: a.template, quantity: 1, ...(a.variant != null ? { variant: a.variant } : {}) });
      }
      for (const entry of stacks.values()) e._loot.push(entry);
      e._stuckArrows = [];
    }
    e.lootable = e._loot.length > 0;
    setAnim(e, 'dead');
    if (floats(e) && Number.isFinite(e.y)) {
      const ground = groundAt(e.location, e.x, e.z, e._home.y ?? e.y);
      if (ground !== null && ground <= e.y) e.y = r2(ground);
    }
    entityEvent(e, { kind: 'death', entityId: e.id, name: e.name, killerId: monster?.id ?? killer?.id ?? null });
    if (killer && !monster && e._ally == null) {
      ctx.notify(killer, { kind: 'kill', entityId: e.id, name: e.name, text: `You have slain the ${e.name}.` });
      ctx.emit('kill', { player: killer, entity: e, noLoot: true });
    }
  }

  function defeat(p, by) {
    if (!p.rpg || p.rpg.defeated) return;
    ctx.dirty(p);
    p.rpg.defeated = true;
    p.rpg.readied = false;
    resurrectAt.set(p.id, ctx.now() + cfg.resurrectMs);
    downedAt.set(p.id, { x: p.x, z: p.z });
    nextSwing.delete(p.id);
    dismissAllies(p.id, locationOf(p));
    const event = { kind: 'defeat', playerId: p.id, name: p.name, by: by?.name ?? null };
    if (by?.visibleTo != null) {
      entityEvent(by, event);
      for (const viewer of ctx.players.values()) {
        if (locationOf(viewer) === locationOf(p) && hiddenFrom(by, viewer)) ctx.notify(viewer, { ...event, by: null });
      }
    } else ctx.nearby(locationOf(p), event);
    ctx.emit('defeat', { player: p, entity: by ?? null });
  }

  const REVIVE_GRACE_MS = 8_000;
  const reviveGraceUntil = new Map();
  const inReviveGrace = (p) => !!p && ctx.now() < (reviveGraceUntil.get(p.id) ?? 0);

  function resurrect(p, { inPlace = false, fraction = cfg.resurrectFraction } = {}) {
    ctx.dirty(p);
    if (typeof S.revivePlayer === 'function') S.revivePlayer(p, fraction);
    else {
      const c = characterOf(p);
      if (c) {
        c.health = Math.max(1, Math.floor(c.maxHealth * fraction));
        if (Number.isFinite(c.maxFatigue)) c.fatigue = Math.max(c.fatigue ?? 0, Math.floor(c.maxFatigue * fraction));
      }
    }
    const c = characterOf(p);
    if (c && !inPlace && fraction >= 0.1 && Number.isFinite(c.maxHealth) && c.maxHealth > 0) {
      c.health = Math.max(c.health ?? 0, Math.min(c.maxHealth, 12));
    }
    delete p.rpg.defeated;
    resurrectAt.delete(p.id);
    downedAt.delete(p.id);
    reviveGraceUntil.set(p.id, ctx.now() + REVIVE_GRACE_MS);
    for (const e of ctx.entities.values()) {
      if (e?._m && e._targetId === p.id) {
        e._targetId = null;
        e._pursuit = null;
      }
    }
    if (!inPlace) {
      const location = locationOf(p);
      if (S.interiors?.isInstance?.(location)) {
        // Cold or unavailable geometry leaves the player at the defeat site.
        S.interiors.resurrectAtEntry?.(p);
      } else {
        const sp = respawnPoint(location);
        const at = placeable(location, sp.x, sp.z) ?? sp;
        p.x = at.x;
        p.z = at.z;
        p.dirty = true;
      }
    }
    ctx.nearby(locationOf(p), { kind: 'resurrect', playerId: p.id, x: r2(p.x), z: r2(p.z) });
  }

  /**
   * Where a defeated player gets up: the wilderness scene's published spawn for `wilderness:`
   * pixels (services.wilderness.scene), otherwise the origin, which is every town's spawn
   * (client/world/town.js).
   */
  function respawnPoint(location) {
    try {
      if (S.wilderness?.isWilderness?.(location)) {
        const sp = S.wilderness.scene(location)?.spawn;
        if (sp && Number.isFinite(sp.x) && Number.isFinite(sp.z)) return { x: sp.x, z: sp.z };
      }
    } catch {}
    return { x: 0, z: 0 };
  }

  /** `cause` (spell, trap, ...) sends the injured player a private `hurt`; monster blows report through monsterAttack. */
  function hurtPlayer(p, amount, source, onApplied, cause = null) {
    if (!(amount > 0) || isDefeated(p)) return;
    if (source?.kind === 'monster' && inReviveGrace(p)) return 0;
    let pvpIntercept = null;
    if (typeof S.pvp?.onPlayerDamage === 'function') {
      pvpIntercept = S.pvp.onPlayerDamage(p, amount, source, cause ?? 'melee');
      if (pvpIntercept?.blocked) return 0;
      if (Number.isFinite(pvpIntercept?.amount)) amount = pvpIntercept.amount;
      if (amount <= 0) return 0;
    }
    // Magical shields (magic feature) soak damage first.
    if (typeof S.absorbDamage === 'function') {
      try {
        const left = Number(S.absorbDamage(p, amount));
        if (Number.isFinite(left)) amount = Math.max(0, Math.min(amount, Math.trunc(left)));
      } catch {}
      if (amount <= 0) return 'absorbed';
    }
    const healthBefore = characterOf(p)?.health ?? 0;
    const floorHp = Number.isFinite(pvpIntercept?.floorHp) && pvpIntercept.floorHp >= 1 ? Math.trunc(pvpIntercept.floorHp) : 0;
    const nonLethalFinish = floorHp > 0 && healthBefore - Math.trunc(amount) <= floorHp;
    const effectiveAmount = nonLethalFinish ? Math.max(0, healthBefore - floorHp) : Math.trunc(amount);
    let dead = false;
    if (effectiveAmount > 0) {
      if (typeof S.damagePlayer === 'function') {
        dead = !!S.damagePlayer(p, effectiveAmount, source)?.dead;
      } else {
        const c = characterOf(p);
        if (!c) return;
        ctx.dirty(p);
        c.health = Math.max(floorHp, c.health - effectiveAmount);
        dead = c.health === 0;
      }
    }
    ctx.dirty(p);
    const damage = Math.max(0, healthBefore - (characterOf(p)?.health ?? 0));
    if (damage > 0) onApplied?.(damage);
    if (damage > 0 && cause) ctx.notify(p, { kind: 'hurt', damage, cause });
    ctx.emit('damage', { target: p, player: p, source, amount: effectiveAmount });
    if (nonLethalFinish) {
      pvpIntercept?.onNonLethal?.();
      return damage;
    }
    if (dead) {
      if (!S.pvp?.onPlayerDefeat?.(p, source, cause)) defeat(p, source);
    }
    return damage;
  }

  // A death from any source (spells, traps) arrives through the character feature.
  ctx.on('playerDowned', ({ player, source } = {}) => {
    if (player && ctx.players.get(player.id) === player) defeat(player, source?.kind === 'monster' ? source : null);
  });

  // ------------------------------------------------------------------ AI

  /** Another player's private quest foe (visibleTo) does not exist for `p`: not seen, struck, aimed at or looted. */
  function hiddenFrom(e, p) {
    return e.visibleTo != null && !(e.visibleTo instanceof Set ? e.visibleTo.has(p?.id) : Array.isArray(e.visibleTo) && e.visibleTo.includes(p?.id));
  }

  function entityEvent(e, event) {
    if (e.visibleTo == null) {
      ctx.nearby(e.location, event);
      return;
    }
    for (const p of ctx.players.values()) {
      if (locationOf(p) === e.location && !hiddenFrom(e, p)) ctx.notify(p, event);
    }
  }

  function allyOwner(e) {
    const p = ctx.players.get(e._ally);
    return p && locationOf(p) === e.location && !isDefeated(p) ? p : null;
  }

  function canHarmMonster(p, e) {
    return !hiddenFrom(e, p) && (e._ally == null || p?.id === e._ally);
  }

  function validTarget(e, p) {
    // A player still on their loading screen (server/game.js `arriving`) or in post-revive grace cannot be targeted.
    return !!p && !p.arriving && !inReviveGrace(p) && canHarmMonster(p, e) && (e.lawSuspect == null || e.lawSuspect === p.id)
      && ctx.players.get(p.id) === p && locationOf(p) === e.location && characterOf(p) && !isDefeated(p);
  }

  // Quest actors are protected from AI in DFU unless their script opts in. Private and law
  // combat encounters stay player-only in the shared world.
  const allowsMonsterCombat = (e) => e.visibleTo == null && !e._quest?.foe && e.lawSuspect == null && !e._m.guard;
  const allied = (e) => e._playerAlly && (e._ally == null || !!allyOwner(e));
  const worldHostile = (e) => e.hostile !== false && !e._playerAlly && e._ally == null;
  const livingMonster = (e) => !!e?._m && !e.dead && e.hp > 0 && ctx.entities.get(e.id) === e;

  function monsterOpponents(e, target) {
    if (!(livingMonster(e) && livingMonster(target) && e.location === target.location && allowsMonsterCombat(e) && allowsMonsterCombat(target))) return false;
    if (allied(e) && worldHostile(target) || worldHostile(e) && allied(target)) return true;
    if (e._ally != null && target._ally != null && e._ally !== target._ally && S.pvp?.canPlayerHarmPlayer) {
      const ownerA = allyOwner(e);
      const ownerB = allyOwner(target);
      return !!(ownerA && ownerB && S.pvp.canPlayerHarmPlayer(ownerA, ownerB, { kind: 'pet', summon: e })?.allowed);
    }
    return false;
  }

  function attackTarget(e, target) {
    if (target?._m) return monsterOpponents(e, target);
    if (e._playerAlly && e._ally != null && S.pvp?.canPlayerHarmPlayer) {
      const owner = allyOwner(e);
      return !!owner && !!target && !target.arriving && ctx.players.get(target.id) === target
        && locationOf(target) === e.location && characterOf(target) && !isDefeated(target)
        && !!S.pvp.canPlayerHarmPlayer(owner, target, { kind: 'pet', summon: e })?.allowed;
    }
    return !e._playerAlly && e.hostile !== false && validTarget(e, target);
  }

  const actorById = (id) => ctx.players.get(id) ?? ctx.entities.get(id);

  function remember(e, p, now) {
    e._targetId = p.id;
    e._pursuit = { ...snapshotPosition(p, footOf(p, e.location)), until: now + PURSUIT_SECONDS * 1000 };
  }

  function provoke(e, p) {
    if (e.dead || !validTarget(e, p)) return false;
    if (e._playerAlly) {
      e._playerAlly = false;
      e._pending = [];
    } else if (e.hostile === false) S.law?.provoked?.(p, e);
    e.hostile = true;
    e._encountered = true;
    remember(e, p, ctx.now());
    return true;
  }

  function respondToMonster(e, attacker) {
    if (!monsterOpponents(e, attacker)) return;
    const current = actorById(e._targetId);
    if (attackTarget(e, current) && dist(e, current) <= 2 && canSense(e, current) && sees(e.location, e, current)) return;
    remember(e, attacker, ctx.now());
  }

  function waterSurface(e, x, z) {
    const world = S.collision?.instanceWorld?.(e.location);
    return world?.waterAt ? world.waterAt(x, z) : e._waterY;
  }

  function underwaterAt(e, { x, z, y }) {
    const surface = waterSurface(e, x, z);
    return Number.isFinite(y) && Number.isFinite(surface) && y < surface;
  }

  function canSense(e, p) {
    const eligible = p?._m ? monsterOpponents(e, p)
      : (e._playerAlly && e._ally != null ? attackTarget(e, p) : validTarget(e, p));
    return eligible && dist(p, e._home) <= cfg.leash + cfg.aggroRange
      && (floats(e) || sameFloor(e, p, e.location))
      && (e.behaviour !== 'aquatic' || !Number.isFinite(e._waterY)
        || underwaterAt(e, snapshotPosition(p, footOf(p, e.location))))
      && (!S.magicStatus?.(p)?.invisible || ENEMY_EXTRAS[e.monsterId]?.seesInvisible);
  }

  function stealthDetected(e, p, distance, minute) {
    if (distance > STEALTH_RANGE) return false;
    const walkSpeed = ctx.config?.maxSpeed ?? 4;
    const slow = !p.moving || (p.motionSpeed ?? Math.hypot(p.forward ?? 0, p.strafe ?? 0) * walkSpeed) <= walkSpeed / 2 + 0.01;
    if (e._encountered && !slow) return true;
    e._stealth ??= new Map();
    const prior = e._stealth.get(p.id);
    if (prior?.minute === minute || (slow && prior && minute % 2)) return prior.detected;
    if (stealthPractice.get(p.id) !== minute) {
      S.advanceSkill?.(p, 'Stealth', 1);
      stealthPractice.set(p.id, minute);
    }
    const detected = random() >= stealthChance(distance, skillOf(characterOf(p), 'Stealth'));
    e._stealth.set(p.id, { minute, detected });
    return detected;
  }

  function doorOnLine(e, p, reach = Infinity) {
    const query = S.dungeonLocks?.doorOnLine;
    if (!query) return null;
    const y1 = footOf(e, e.location);
    const y2 = footOf(p, e.location);
    if (!Number.isFinite(y1) || !Number.isFinite(y2)) return null;
    const fraction = Math.min(1, reach / Math.max(0.01, dist(e, p)));
    return query(e.location, e.x, y1 + 1.1, e.z, e.x + (p.x - e.x) * fraction,
      y1 + 1.1 + (y2 - y1) * fraction, e.z + (p.z - e.z) * fraction);
  }

  function detect(e, p, minute) {
    if (!canSense(e, p)) return null;
    const distance = Math.hypot(dist(e, p), (e.y ?? footOf(p, e.location) ?? 0) - (footOf(p, e.location) ?? e.y ?? 0));
    if (distance > cfg.aggroRange) return null;
    const status = S.magicStatus?.(p) ?? {};
    const obscured = (status.chameleon && !p.moving || status.shadow && p.moving) && !ENEMY_EXTRAS[e.monsterId]?.seesInvisible;
    if (obscured) return null;
    const clear = sees(e.location, e, p);
    if (!clear) {
      if (e._targetId === p.id && distance < HEARING_RANGE && doorOnLine(e, p)) return { p, sight: false, clear: false };
      return null;
    }
    const inFront = distance <= cfg.monsterReach || facingWithin(e, p, 90);
    if (inFront) return { p, sight: true, clear };
    if (e._targetId === p.id && distance < HEARING_RANGE) return { p, sight: false, clear };
    if (p._m ? distance < HEARING_RANGE : stealthDetected(e, p, distance, minute)) return { p, sight: false, clear };
    return null;
  }

  function firstEncounter(e, p) {
    if (e._encountered) return;
    e._encountered = true;
    if (e.origin === 'quest' || e._quest || e.visibleTo != null || e._m.guard) return;
    const language = enemyLanguage(e._m);
    if (!language) return;
    const c = characterOf(p);
    const personality = effectiveStat(p, 'Personality', stat(c, 'Personality'));
    const bonus = Number(S.magicStatus?.(p)?.comprehendLanguages) || 0;
    const roll = random();
    const success = S.languageCheck?.(p, language, { roll: Math.floor(roll * 200), bonus })?.success
      ?? roll < pacificationChance(language, skillOf(c, language), personality, !p.rpg.readied, bonus);
    if (success) {
      e.hostile = false;
      e._targetId = null;
      e._pursuit = null;
      S.advanceSkill?.(p, language, 1);
      ctx.notify(p, { kind: 'combat', text: `You pacify the ${e.name} with your knowledge of ${language}.` });
    } else if (language !== 'Etiquette') S.advanceSkill?.(p, language, 1);
  }

  function step(e, target, dt) {
    const baseSpeed = (e._career ?? e._mcareer)?.attributes?.Speed ?? 50;
    const speed = cfg.speed[e.behaviour] ?? classicEnemySpeed(effectiveStat(e, 'Speed', baseSpeed));
    const movingInVolume = floats(e) || S.magicStatus?.(e)?.levitating;
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    const dy = movingInVolume && Number.isFinite(target.y) && Number.isFinite(e.y) ? target.y - e.y : 0;
    const distance = Math.hypot(dx, dz, dy);
    if (distance < 0.02) return false;
    const fraction = Math.min(1, speed * dt / distance);
    const nx = e.x + dx * fraction;
    const nz = e.z + dz * fraction;
    const candidates = [[nx, nz], [nx, e.z], [e.x, nz]];
    for (const [x, z] of candidates) {
      if (dist({ x, z }, e._home) > cfg.leash && dist({ x, z }, e._home) >= dist(e, e._home)) continue;
      const surface = e.behaviour === 'aquatic' ? waterSurface(e, x, z) : null;
      const ceiling = Number.isFinite(surface) ? surface - 0.25 : Infinity;
      const ny = Number.isFinite(e.y) ? Math.min(ceiling, e.y + dy * fraction) : undefined;
      if (e.behaviour === 'aquatic' && Number.isFinite(e._waterY) && !underwaterAt(e, { x, z, y: ny })) continue;
      const world = movingInVolume && Number.isFinite(ny) ? S.collision?.instanceWorld?.(e.location) : null;
      if (world?.fits ? !world.fits(x, z, ny) : !walkable(e.location, x, z, ny)) continue;
      const ground = movingInVolume ? null : groundAt(e.location, x, z, e.y);
      if (!movingInVolume && Number.isFinite(e.y) && S.collision?.groundAt && (ground === null || Math.abs(ground - e.y) > 0.8)) continue;
      if (r2(x) === e.x && r2(z) === e.z && (!Number.isFinite(ny) || r2(ny) === e.y)) continue;
      e.x = r2(x);
      e.z = r2(z);
      if (Number.isFinite(ny)) e.y = r2(ground ?? ny);
      return true;
    }
    return false;
  }

  function arrowPoint(location, actor) {
    const foot = footOf(actor, location) ?? S.collision?.groundAt?.(location, actor.x, actor.z) ?? 0;
    return snapshotPosition(actor, foot + (actor.kind === 'monster' && actor.behaviour === 'aquatic' ? 0.55 : 1.1));
  }

  function arrowEvent(arrow, event, hit) {
    const scoped = { projectileId: arrow.id, location: arrow.location, ...event };
    if (arrow.viewers == null && hit?.visibleTo == null) {
      ctx.nearby(arrow.location, scoped);
      return;
    }
    for (const p of ctx.players.values()) {
      if (locationOf(p) === arrow.location && (arrow.viewers == null || arrow.viewers.has(p.id)) &&
          (!hit || !hiddenFrom(hit, p))) ctx.notify(p, scoped);
    }
  }

  function fireArrow(shooter, target, attack) {
    const location = attack ? locationOf(shooter) : shooter.location;
    const start = arrowPoint(location, shooter);
    const aim = target ? arrowPoint(location, target) : null;
    const yaw = shooter.yaw ?? 0;
    const dx = aim ? aim.x - start.x : Math.sin(yaw);
    const dy = aim ? aim.y - start.y : 0;
    const dz = aim ? aim.z - start.z : -Math.cos(yaw);
    const length = Math.hypot(dx, dy, dz) || 1;
    const visibleTo = (attack ? target : shooter)?.visibleTo;
    const arrow = {
      id: ++arrowSeq, shooter, target, attack, location, at: start, dx: dx / length, dy: dy / length, dz: dz / length,
      left: attack ? BOW_RANGE + cfg.reachSlack : BOW_MAX_RANGE,
      viewers: visibleTo == null ? null : new Set(visibleTo),
      pvpContext: attack ? (S.pvp?.captureProjectileContext?.(shooter) ?? null) : null,
    };
    arrows.add(arrow);
    ctx.onRollback?.(() => arrows.delete(arrow));
    if (!attack) setAnim(shooter, 'ranged', 0.6);
    arrowEvent(arrow, {
      kind: 'arrowLaunch', ...start,
      dx: arrow.dx, dy: arrow.dy, dz: arrow.dz, speed: ARROW_SPEED, range: arrow.left,
      ...(attack ? { playerId: shooter.id } : { entityId: shooter.id }),
    });
  }

  function tickArrows(dt) {
    for (const a of arrows) {
      const e = a.shooter;
      const moved = a.attack ? ctx.players.get(e.id) !== e || locationOf(e) !== a.location : e.location !== a.location;
      if (moved || (!a.attack && a.target?._m && !monsterOpponents(e, a.target))
        || (!a.attack && e._ally != null && (!livingMonster(e) || !allyOwner(e)))) {
        arrows.delete(a);
        arrowEvent(a, { kind: 'arrowImpact', reason: 'cancelled' });
        continue;
      }
      const from = a.at;
      const step = Math.min(a.left, ARROW_SPEED * dt);
      const pointAt = (t) => ({ x: from.x + a.dx * t, y: from.y + a.dy * t, z: from.z + a.dz * t });
      const end = pointAt(step);
      const geometryClear = (to) => !S.canSee || S.canSee(a.location, from.x, from.z, to.x, to.z, { y1: from.y, y2: to.y, eye: 0, eye2: 0 });
      let closest = step + ARROW_RADIUS;
      let hit = null;
      const candidates = a.attack ? [...ctx.entities.values()] : [a.target];
      if (a.attack && S.pvp?.canPlayerHarmPlayer) {
        for (const q of ctx.players.values()) {
          if (q !== e && !q.arriving && !isDefeated(q) && locationOf(q) === a.location && ctx.sameScene?.(e, q) !== false
            && S.pvp.canPlayerHarmPlayer(e, q, { kind: 'arrow', projectileContext: a.pvpContext })?.allowed) {
            candidates.push(q);
          }
        }
      }
      for (const target of candidates) {
        const isPlayerTarget = a.attack && ctx.players.get(target?.id) === target;
        if (a.attack && !isPlayerTarget) {
          if (target.location !== a.location || target.dead || !canHarmMonster(e, target)) continue;
          if (!target._m && (target !== a.target || target.kind !== 'npc')) continue;
        } else if (!a.attack && !attackTarget(e, target)) continue;
        const center = arrowPoint(a.location, target);
        const x = center.x - from.x;
        const y = center.y - from.y;
        const z = center.z - from.z;
        const d = x * a.dx + y * a.dy + z * a.dz;
        if (d < -ARROW_RADIUS || d >= closest) continue;
        const at = pointAt(Math.max(0, Math.min(step, d)));
        if (dist(at, center) > ARROW_RADIUS || Math.abs(at.y - center.y) > 0.7 || !geometryClear(at)) continue;
        closest = d;
        hit = target;
      }
      if (hit) {
        arrows.delete(a);
        const contact = pointAt(Math.max(0, Math.min(step, closest)));
        const hitPlayer = ctx.players.get(hit.id) === hit;
        arrowEvent(a, { kind: 'arrowImpact', ...contact, reason: 'target', targetId: (a.attack && hitPlayer) ? `player:${hit.id}` : hit.id }, a.attack && !hitPlayer ? hit : e);
        if (a.attack) resolvePlayerHit(e, hit, { ...a.attack, pvpContext: a.pvpContext });
        else strikeTarget(e, hit, true);
        continue;
      }
      const blocked = !geometryClear(end);
      if (blocked || a.left <= step) {
        arrows.delete(a);
        // The blocked step may end behind the wall. Find its last clear point for the visible tip.
        let contact = end;
        if (blocked) {
          let clear = 0, solid = step;
          while (solid - clear > 0.01) {
            const mid = (clear + solid) / 2;
            if (geometryClear(pointAt(mid))) clear = mid;
            else solid = mid;
          }
          contact = pointAt(clear);
        }
        arrowEvent(a, { kind: 'arrowImpact', ...contact, reason: blocked ? 'wall' : 'range' }, a.attack ? null : e);
      } else {
        a.at = end;
        a.left -= step;
      }
    }
  }

  function face(e, target) {
    e.yaw = r2(wrapAngle(yawTo(e, target)));
  }

  function rollMonsterStrike(e, targetView, reflexes, weapon) {
    const attackerView = monsterView(e);
    return e._m.human || weapon
      ? classAttack({ attackerView, skill: attackerView.handToHand, weapon, targetView, random })
      : monsterAttack({ monster: e._m, monsterView: attackerView, playerView: targetView, reflexes, random });
  }

  function strikeTarget(e, target, ranged = false) {
    if (!target._m) return monsterStrike(e, target, ranged);
    // DFU EnemyAttack switches to bare hands when melee steel (or another metal) cannot harm the foe.
    const weapon = e._weapon;
    const effective = weapon && weapon.materialIndex >= (target._m.minMetal ?? -1);
    const reflexes = reflexesOf(characterOf(allyOwner(e) ?? allyOwner(target)));
    const r = ranged && weapon && !effective ? { damage: 0 }
      : rollMonsterStrike(e, monsterView(target), reflexes, effective ? weapon : null);
    if (r.damage > 0) S.breakMagicConcealment?.(e);
    const { damage, absorbed } = applyMonsterDamage(target, r.damage, e, ranged ? 'arrow' : 'melee');
    if (!damage) respondToMonster(target, e);
    if (damage > 0 && !target.dead && !ranged) onMonsterHit(e, target, damage);
    entityEvent(e, { kind: 'monsterAttack', entityId: e.id, targetId: target.id, hit: damage > 0, damage,
      ...(ranged ? { ranged: true } : {}), ...(absorbed && r.damage >= 1 ? { absorbed: true } : {}) });
  }

  function monsterStrike(e, p, ranged = false) {
    const r = rollMonsterStrike(e, playerView(p), reflexesOf(characterOf(p)), e._weapon);
    let absorbed = false;
    if (r.damage > 0) S.breakMagicConcealment?.(e);
    // EnemyAttack.ShootBow: the arrow ends up in the target's inventory.
    if (ranged && typeof S.giveItem === 'function') {
      try {
        S.giveItem(p, 'arrow', 1);
      } catch {}
    }
    if (r.damage > 0) {
      try {
        S.damageArmor?.(p, 1, BODY_PART_NAMES[r.part]);
      } catch {}
      // Ring of Namira (FormulaHelper.CalculateAttackDamage, package 16): every enemy attack on the player, melee
      // or EnemyAttack.BowDamage, returns the calculated damage before the player's shields and health take it.
      const calculated = r.damage;
      try { if (!isDefeated(p)) S.enchantmentStruck?.(p, e, calculated); } catch {}
      const applied = hurtPlayer(p, r.damage, e, ranged ? undefined : (damage) => {
        S.conditionExposure?.(p, { source: e, damage, delivery: 'melee' });
        if (e._weaponPoison != null && S.conditionExposure) {
          S.conditionExposure(p, { source: e, damage, delivery: 'weapon', poison: e._weaponPoison });
          delete e._weaponPoison;
        }
        onMonsterHit(e, p, damage);
      });
      absorbed = applied === 'absorbed';
      r.damage = absorbed ? 0 : applied ?? 0;
    }
    if (typeof S.advanceSkill === 'function') {
      try {
        S.advanceSkill(p, 'Dodging', 1);
      } catch {}
    }
    entityEvent(e, { kind: 'monsterAttack', entityId: e.id, targetId: p.id, hit: r.damage > 0, damage: r.damage, ...(ranged ? { ranged: true } : {}),
      ...(absorbed ? { absorbed: true } : {}) });
  }

  /**
   * FormulaHelper.OnMonsterHit effects that this world supports: nymph and lamia fatigue drain (2 points per point of
   * health damage) and the spider / giant scorpion paralysing touch. Conditions handles infection.
   */
  function onMonsterHit(e, p, damage) {
    const id = e._m.id;
    if (id === 10 || id === 42) {
      if (p._m) {
        S.drainMonsterFatigue?.(p, damage * 2);
        return;
      }
      const c = characterOf(p);
      if (c && Number.isFinite(c.fatigue)) {
        ctx.dirty(p);
        const n = Math.min(c.fatigue, damage * 2);
        if (typeof S.spendFatigue === 'function') S.spendFatigue(p, n);
        else c.fatigue -= n;
      }
    } else if ((id === 6 || id === 20) && typeof S.enemyCast === 'function' && !S.magicStatus?.(p)?.paralyzed) {
      try {
        S.enemyCast(e, PARALYSIS_TOUCH, p, { free: true });
      } catch {}
    }
  }

  /** Spell lists by how the classic AI uses them (EnemyMotor.CanCastRangedSpell / CanCastTouchSpell, classic AI). */
  function spellsBy(e, kinds) {
    if (!e._spells || typeof S.enemySpellInfo !== 'function' || !(e.magicka > 0)) return [];
    return e._spells.filter((i) => kinds.includes(S.enemySpellInfo(i)?.targetType));
  }
  function tryCast(e, list, target) {
    if (!list.length || typeof S.enemyCast !== 'function') return false;
    const index = list[Math.floor(random() * list.length)];
    let r = null;
    try {
      r = S.enemyCast(e, index, target, { level: e.level });
    } catch (err) {
      ctx.log?.warn?.(`[combat] ${e.name} spell ${index}: ${err.message}`);
    }
    if (!r) return false;
    setAnim(e, 'ranged', 0.6);
    return true;
  }

  /** DaedraSeducerMobileBehaviour: transform when hurt or after 8 s of pursuit; untouchable meanwhile. */
  function seducer(e, target, dt) {
    const s = e._seducer;
    if (!s || e.form === 'winged') return false;
    if (s.stage) {
      s.left -= dt;
      if (s.left > 0) return true;
      if (s.stage === 'transform1') {
        s.stage = 'transform2';
        s.left = SEDUCER_STAGE_S;
        setAnim(e, 'transform2', SEDUCER_STAGE_S);
        return true;
      }
      s.stage = null;
      e.form = 'winged';
      e.behaviour = 'flying';
      setAnim(e, 'idle');
      return false;
    }
    if (!target) return false;
    s.countdown -= dt;
    if (e.hp < e.maxHp || s.countdown <= 0) {
      s.stage = 'transform1';
      s.left = SEDUCER_STAGE_S;
      setAnim(e, 'transform1', SEDUCER_STAGE_S);
      return true;
    }
    return false;
  }
  const transforming = (e) => !!e._seducer?.stage;

  function think(e, occupants, opponents, dt, now) {
    e._cooldown = Math.max(0, e._cooldown - dt);
    if (e._animUntil && now >= e._animUntil && !transforming(e)) setAnim(e, 'idle');
    const status = S.magicStatus?.(e) ?? {};
    if (status.paralyzed || status.pacified || status.charmed) {
      e._pending = [];
      return;
    }
    // PrimaryAttackAnimFrames' -1 markers execute at contact, after the wind-up.
    if (e._pending?.length) {
      const due = e._pending.filter((h) => now >= h.at);
      e._pending = e._pending.filter((h) => now < h.at);
      for (const h of due) {
        const target = actorById(h.targetId);
        if (attackTarget(e, target) && !transforming(e) && dist(e, target) <= cfg.monsterReach
          && sameFloor(e, target, e.location) && (dist(e, target) <= 0.25 || facingWithin(e, target, 35.156))
          && sees(e.location, e, target)) {
          strikeTarget(e, target);
        }
        if (!livingMonster(e)) return;
      }
    }
    const minute = Math.floor(S.worldClock?.()?.minutes ?? now / 5000);
    const current = actorById(e._targetId);
    let detected = attackTarget(e, current) ? detect(e, current, minute) : null;
    const seeksOpponents = (allied(e) || worldHostile(e)) && allowsMonsterCombat(e);
    if (!detected && (allied(e) || e.hostile !== false) && now >= e._nextSense) {
      e._nextSense = now + 62.5;
      let nearest = Infinity;
      const allowAllyPvp = e._playerAlly && e._ally != null && !!S.pvp?.canPlayerHarmPlayer;
      const groups = [seeksOpponents ? opponents : [], (e._playerAlly && !allowAllyPvp) ? [] : occupants];
      for (const group of groups) {
        for (const actor of group) {
          const distance = dist(e, actor);
          if (actor === current || distance >= nearest) continue;
          const candidate = detect(e, actor, minute);
          if (!candidate) continue;
          nearest = distance;
          detected = candidate;
        }
      }
    }
    let target = detected?.p;
    if (target && !target._m && !e._playerAlly) {
      firstEncounter(e, target);
      if (e.hostile === false) target = null;
      else if (detected.sight) alertUntil.set(target.id, now + PURSUIT_SECONDS * 1000);
    }
    if (target) remember(e, target, now);
    if (seducer(e, target, dt)) return;
    if (!target) {
      if (!attackTarget(e, current) || now >= (e._pursuit?.until ?? 0)) {
        e._targetId = null;
        e._pursuit = null;
      }
      const destination = e._pursuit ?? e._home;
      const moved = step(e, destination, dt);
      if (moved) face(e, destination);
      if (!e._animUntil) setAnim(e, moved ? 'move' : 'idle');
      return;
    }
    face(e, target);
    const d = dist(e, target);
    const player = characterOf(target._m ? allyOwner(e) ?? allyOwner(target) : target);
    if (!detected.clear && (e._m.human || ENEMY_EXTRAS[e.monsterId]?.doors)) {
      const door = doorOnLine(e, target, cfg.monsterReach);
      if (door && S.dungeonLocks.enemyOpen?.(e.location, door)) return;
      if (door && !e._cooldown && S.dungeonLocks.enemyBash?.(e.location, door, e.x, e.z)) {
        e._cooldown = monsterMeleeSeconds(levelOf(player), reflexesOf(player), random);
        setAnim(e, 'attack', 0.6);
        return;
      }
    }
    // EnemyMotor.DoRangedAttack: bow users between 6 and 51.2 m with a clear shot hold and shoot,
    // 1/32 per classic update (16 per second).
    if (detected.clear && hasBowAttack(e._m) && d > BOW_MIN_RANGE && d < BOW_MAX_RANGE) {
      if (!e._animUntil) setAnim(e, 'idle');
      const p = 1 - Math.pow(1 - BOW_SHOT_CHANCE, dt / CLASSIC_UPDATE_S);
      if (!e._animUntil && random() < p) fireArrow(e, target, null);
      return;
    }
    // DoRangedAttack with spells: casters with a ranged spell hold position between 6 and 51.2 m.
    if (detected.clear && !hasBowAttack(e._m) && d > BOW_MIN_RANGE && d < BOW_MAX_RANGE) {
      const ranged = spellsBy(e, ['singleAtRange', 'areaAtRange']);
      if (ranged.length) {
        if (!e._animUntil) setAnim(e, 'idle');
        const p = 1 - Math.pow(1 - SPELL_SHOT_CHANCE, dt / CLASSIC_UPDATE_S);
        if (!e._animUntil && random() < p && tryCast(e, ranged, target)) return;
        if (e._animUntil || e.magicka >= 5) return;
      }
    }
    if (d > cfg.monsterReach * 0.8 || !sameFloor(e, target, e.location)) {
      const targetY = footOf(target, e.location);
      const desiredY = Number.isFinite(targetY) && (e.behaviour === 'flying' || e.monsterId === 11) ? targetY + 0.75 : targetY;
      const moved = step(e, snapshotPosition(target, desiredY), dt);
      if (!e._animUntil) setAnim(e, moved ? 'move' : 'idle');
    }
    if (d <= cfg.monsterReach && e._cooldown === 0 && !e._animUntil && sameFloor(e, target, e.location) && detected.clear) {
      const cooldown = monsterMeleeSeconds(levelOf(player), reflexesOf(player), random);
      // DoTouchSpell (classic AI: touch and caster-only spells) takes the melee turn when one can be cast.
      if (tryCast(e, spellsBy(e, ['touch', 'caster']), target)) {
        e._cooldown = cooldown;
        return;
      }
      e._cooldown = cooldown;
      const markers = e.form === 'winged' ? [2] : hitMarkers(e._m);
      setAnim(e, 'attack', Math.max(e._m.attackFrames ?? 6, (markers.at(-1) ?? 0) + 2) / ATTACK_FPS);
      e._pending = markers.map((f) => ({ at: now + f * 1000 / ATTACK_FPS, targetId: target.id }));
    }
  }

  // ------------------------------------------------------------------ tick

  ctx.onTick((dt, now) => {
    tickArrows(dt);
    const occupied = new Map();
    for (const p of ctx.players.values()) {
      const loc = locationOf(p);
      if (!occupied.has(loc)) occupied.set(loc, []);
      occupied.get(loc).push(p);
      // Defeated players stay where they fell until resurrected.
      if (p.rpg?.defeated) {
        const at = downedAt.get(p.id);
        if (at) {
          p.x = at.x;
          p.z = at.z;
          p.moving = false;
        }
        const t = resurrectAt.get(p.id);
        if (t === undefined) resurrectAt.set(p.id, now + cfg.resurrectMs);
        else if (now >= t) resurrect(p);
      }
    }
    for (const [loc, list] of occupied) {
      let scene = scenes.get(loc);
      if (!scene || scene.external || (scene.quietAwakening && list.some((p) => !S.conditionQuietArrival?.(p, loc)))) {
        if (!geometryReady(loc)) continue; // seed once collision for the area is known
        scene = seedScene(loc, list);
        if (!scene) continue;
      }
      scene.emptySince = null;
      nightWave(loc, scene, list);
      spawnTick(loc, scene, list);
    }
    for (const [loc, scene] of scenes) {
      if (occupied.has(loc)) continue;
      scene.emptySince ??= now;
      if (now - scene.emptySince >= cfg.reclaimMs) reclaim(loc, scene);
    }
    for (const [loc, scene] of scenes) {
      const occupants = occupied.get(loc);
      const allies = [];
      const foes = [];
      for (const id of scene.monsters) {
        const e = ctx.entities.get(id);
        if (!e || (e._ally != null && !allyOwner(e))) {
          if (e) ctx.entities.delete(id);
          scene.monsters.delete(id);
          continue;
        }
        if (e.dead) {
          if (now - e._diedAt >= cfg.corpseMs) {
            ctx.entities.delete(id);
            scene.monsters.delete(id);
          }
          continue;
        }
        if (e._playerAlly) allies.push(e);
        else foes.push(e);
      }
      if (!occupants) continue;
      if (scene.respawns?.length && geometryReady(loc)) {
        const level = sceneLevel(occupants);
        const pending = [];
        for (const r of scene.respawns) {
          if (now < r.at) { pending.push(r); continue; }
          const crowded = occupants.some((p) => sameFloor(r, p, loc) && dist(r, p) < 6);
          if (crowded) { pending.push(r); continue; }
          const e = spawnMonster(loc, r.monsterId, r.x, r.z, scene, {
            level, team: r.team, yaw: r.yaw, y: r.y, key: r.key, origin: r.origin, gender: r.gender, waterY: r.waterY,
          });
          if (e) {
            if (r.passive) e.hostile = false;
            e._respawn = { ...r };
            delete e._respawn.at;
            if (e._playerAlly) allies.push(e);
            else foes.push(e);
          }
        }
        scene.respawns = pending;
      }
      for (const e of foes) if (livingMonster(e)) think(e, occupants, allies, dt, now);
      for (const e of allies) if (livingMonster(e)) think(e, occupants, foes, dt, now);
    }
  });

  // ------------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    if (typeof p.rpg.readied !== 'boolean') p.rpg.readied = false;
    if (!Number.isFinite(p.rpg.combatFatigue) || p.rpg.combatFatigue < 0 || p.rpg.combatFatigue >= 1) p.rpg.combatFatigue = 0;
    // Rejoining while defeated (or with no health) resurrects at the location's spawn.
    if (p.rpg.defeated || (characterOf(p) && characterOf(p).health <= 0)) {
      p.rpg.defeated = true;
      resurrect(p);
    }
  });

  ctx.onLeave((p) => {
    nextSwing.delete(p.id);
    stealthPractice.delete(p.id);
    alertUntil.delete(p.id);
    for (const e of ctx.entities.values()) e._stealth?.delete(p.id);
    resurrectAt.delete(p.id);
    downedAt.delete(p.id);
    dismissAllies(p.id, locationOf(p));
  });

  function dismissAllies(ownerId, location) {
    for (const id of scenes.get(location)?.monsters ?? []) {
      if (ctx.entities.get(id)?._ally === ownerId) ctx.entities.delete(id);
    }
  }

  const onDeparture = ({ player, from, to }) => {
    if (player && from !== to) dismissAllies(player.id, from);
  };
  ctx.on('locationChanged', onDeparture);
  ctx.on('travel', onDeparture);
  ctx.on('overland', onDeparture);

  ctx.on('dungeonTrespass', ({ player, location } = {}) => {
    if (!player || !/^dungeon:[^/]+\/(castle|palace)/i.test(location)) return;
    for (const id of scenes.get(location)?.monsters ?? []) {
      const e = ctx.entities.get(id);
      if (e?._m.human && e.hostile === false && e.origin === 'rdb-fixed') provoke(e, player);
    }
  });

  // ------------------------------------------------------------------ actions

  function requireFighter(p) {
    const c = characterOf(p);
    if (!c) throw new Error('Create a character first.');
    if (isDefeated(p)) throw new Error('You have been defeated.');
    const custody = S.law?.custody?.(p);
    if (custody) throw new Error(custody);
    return c;
  }

  ctx.onAction('combat.ready', (p, args) => {
    if (typeof args.ready !== 'boolean') throw new Error('ready must be true or false.');
    if (args.ready) requireFighter(p);
    p.rpg.readied = args.ready;
  });

  function facingWithin(p, e, arcDeg) {
    const off = Math.abs(wrapAngle(yawTo(p, e) - p.yaw));
    return off <= (arcDeg * Math.PI) / 180;
  }

  function resolvePlayerTarget(id) {
    if (typeof id === 'number' && Number.isSafeInteger(id)) return ctx.players.get(id) ?? null;
    if (typeof id === 'string') {
      const m = /^(?:player:)?(\d+)$/.exec(id);
      if (m) return ctx.players.get(Number(m[1])) ?? null;
    }
    return null;
  }

  function targetFor(p, args, weapon) {
    const loc = locationOf(p);
    const range = (weapon?.bow ? BOW_RANGE : MELEE_REACH) + cfg.reachSlack;
    const arc = weapon?.bow ? cfg.bowArc : cfg.meleeArc;
    if (args.targetId != null) {
      const id = args.targetId;
      const found = typeof id === 'string' ? ctx.entities.get(id) : null;
      const e = found && canHarmMonster(p, found) ? found : null;
      if (!e) {
        const q = resolvePlayerTarget(id);
        if (q) {
          const elig = S.pvp?.canPlayerHarmPlayer?.(p, q, { kind: weapon?.bow ? 'arrow' : 'melee', weapon });
          if (!elig?.allowed) throw new Error(elig?.reason || 'You cannot attack other travellers.');
          if (dist(p, q) > range || !facingWithin(p, q, arc) || (!weapon?.bow && !sameFloor(p, q, loc)) || !sees(loc, p, q)) return null;
          return q;
        }
        throw new Error('There is nothing there to attack.');
      }
      if (e.kind === 'npc' && !S.law?.strikeTownsperson) throw new Error('You cannot attack townsfolk.');
      if (e.kind !== 'monster' && e.kind !== 'npc') throw new Error('You cannot attack that.');
      if (e.location !== loc || e.dead) throw new Error('There is nothing there to attack.');
      if (dist(p, e) > range || !facingWithin(p, e, arc) || (!weapon?.bow && !sameFloor(p, e, loc)) || !sees(loc, p, e)) return null; // a clean miss
      return e;
    }
    let best = null;
    let bestD = range;
    for (const e of ctx.entities.values()) {
      if (e.kind !== 'monster' || e.dead || e.location !== loc || !e._m || !canHarmMonster(p, e)) continue;
      const d = dist(p, e);
      if (d <= bestD && facingWithin(p, e, arc) && (weapon?.bow || sameFloor(p, e, loc)) && sees(loc, p, e)) {
        best = e;
        bestD = d;
      }
    }
    if (S.pvp?.canPlayerHarmPlayer) {
      for (const q of ctx.players.values()) {
        if (q === p || q.arriving || isDefeated(q) || locationOf(q) !== loc || ctx.sameScene?.(p, q) === false) continue;
        if (!S.pvp.canPlayerHarmPlayer(p, q, { kind: weapon?.bow ? 'arrow' : 'melee', weapon })?.allowed) continue;
        const d = dist(p, q);
        if (d <= bestD && facingWithin(p, q, arc) && (weapon?.bow || sameFloor(p, q, loc)) && sees(loc, p, q)) {
          best = q;
          bestD = d;
        }
      }
    }
    return best;
  }

  ctx.onAction('combat.attack', (p, args) => {
    const c = requireFighter(p);
    if (!p.rpg.readied) throw new Error('Ready your weapon first.');
    if (S.magicStatus?.(p)?.paralyzed) throw new Error('You are paralyzed.');
    if (args.direction != null && !Object.hasOwn(SWINGS, args.direction)) throw new Error('Unknown swing direction.');
    if (args.targetId != null && typeof args.targetId !== 'string' && typeof args.targetId !== 'number') throw new Error('Invalid target.');
    const now = ctx.now();
    reviveGraceUntil.delete(p.id);
    if (now < (nextSwing.get(p.id) ?? 0)) throw new Error('You are still recovering from your last attack.');

    let weaponItem = null;
    try {
      if (!S.conditionBeastForm?.(p)) weaponItem = S.getEquippedWeapon?.(p) ?? null;
    } catch {}
    const weapon = weaponOf(weaponItem);
    const direction = weapon?.bow ? 'up' : args.direction ?? 'right';
    const restriction = S.weaponRestriction?.(p, weapon?.skill ?? 'Hand-to-Hand');
    if (restriction) throw new Error(restriction);

    const doorId = args.buildingPortalId;
    if (doorId != null && (typeof doorId !== 'string' || args.targetId != null || weapon?.bow || !S.law?.bashDoor)) {
      throw new Error('Use a melee attack to bash a building door.');
    }
    // Resolve the target before spending anything so an illegal target costs nothing.
    const target = doorId == null ? targetFor(p, args, weapon) : null;

    // Fatigue: 11 classic units per swing (64 units per displayed point).
    const owed = (p.rpg.combatFatigue ?? 0) + SWING_FATIGUE;
    const whole = Math.floor(owed);
    if ((c.fatigue ?? 0) < Math.max(1, whole)) throw new Error('You are too exhausted to attack.');
    let firedArrow = null;
    if (weapon?.bow) {
      const arrow = S.findArrow ? S.findArrow(p) : S.findItem?.(p, 'arrow');
      if (!arrow) throw new Error('You have no arrows.');
      firedArrow = { template: arrow.template ?? 'arrow', variant: arrow.variant ?? null, conjured: arrow.conjuredUntil != null };
      S.takeItem(p, arrow.id, 1, { consumeConjured: true });
    }
    const prevSwing = nextSwing.get(p.id);
    ctx.onRollback?.(() => {
      if (prevSwing === undefined) nextSwing.delete(p.id);
      else nextSwing.set(p.id, prevSwing);
    });
    if (whole > 0) {
      if (typeof S.spendFatigue === 'function') S.spendFatigue(p, whole);
      else c.fatigue -= whole;
    }
    p.rpg.combatFatigue = owed - whole;

    const ms = swingSeconds(effectiveStat(p, 'Speed', stat(c, 'Speed')), !!weapon?.bow) * 1000;
    nextSwing.set(p.id, now + Math.max(200, ms - cfg.swingTolerance));
    try {
      S.interruptRest?.(p, 'combat', 'You stop resting to fight.');
    } catch {}
    ctx.emit('swing', { player: p, playerId: p.id, direction, ranged: !!weapon?.bow });
    ctx.nearby(locationOf(p), { kind: 'swing', playerId: p.id, direction, weapon: weaponItem?.template ?? 'unarmed' });
    S.breakMagicConcealment?.(p);

    if (doorId != null) {
      S.law.bashDoor(p, doorId);
      return;
    }
    if (weapon?.bow) {
      fireArrow(p, target, { weapon, item: weaponItem, direction, arrow: firedArrow });
      return;
    }
    if (!target) return;
    resolvePlayerHit(p, target, { weapon, item: weaponItem, direction });
  });

  function resolvePlayerHit(p, target, { weapon, item, direction, arrow = null, pvpContext = null }) {
    if (target.kind === 'npc') {
      S.law?.strikeTownsperson?.(p, target, { weapon: item?.template ?? 'unarmed' });
      return;
    }
    // Player-vs-Player resolution using server-owned classic attack math + unified PvP policy.
    if (ctx.players.get(target?.id) === target && target.rpg) {
      const kind = weapon?.bow ? 'arrow' : 'melee';
      const elig = S.pvp?.canPlayerHarmPlayer?.(p, target, { kind, projectileContext: pvpContext });
      if (!elig?.allowed) {
        ctx.nearby(locationOf(p), { kind: 'miss', playerId: p.id, entityId: `player:${target.id}`, pvp: true });
        return;
      }
      const c = characterOf(p);
      if (!c || !characterOf(target)) return;
      const facingAway = Math.abs(wrapAngle(yawTo(target, p) - (target.yaw ?? 0))) > Math.PI / 2;
      const modifiers = S.characterAttackModifiers?.(p, {
        skill: weapon?.skill ?? 'Hand-to-Hand', group: 'humanoid', armed: !!weapon,
      });
      const r = playerAttack({
        player: { view: playerView(p), skill: (n) => S.skillValue?.(p, n) ?? skillOf(c, n) },
        weapon,
        swing: weapon?.bow ? null : SWINGS[direction],
        monster: { id: -1, minMetal: -1 },
        monsterView: playerView(target),
        facingAway,
        modifiers,
        random,
      });
      let enchantmentDamage = 0;
      if (weapon && r.hit) {
        try { enchantmentDamage = Number(S.enchantmentDamageBonus?.(p, target)) || 0; } catch {}
      }
      const rawDamage = r.damage + enchantmentDamage;
      if (!r.hit || rawDamage <= 0) {
        ctx.nearby(locationOf(p), { kind: 'miss', playerId: p.id, entityId: `player:${target.id}`, pvp: true });
        return;
      }
      if (typeof S.advanceSkill === 'function') {
        S.advanceSkill(p, r.skill, 1);
        S.advanceSkill(p, 'Critical Strike', 1);
        if (r.backstabbing) S.advanceSkill(p, 'Backstabbing', 1);
        try { S.advanceSkill(target, 'Dodging', 1); } catch {}
      }
      if (elig.mode === 'district') {
        if (weapon) { try { S.damageItem?.(p, item?.id ?? 'weapon', 1); } catch {} }
        try { S.damageArmor?.(target, 1, BODY_PART_NAMES[Math.floor(random() * BODY_PART_NAMES.length)]); } catch {}
      }
      const sourceLabel = weapon?.bow ? 'arrow' : weapon ? 'weapon' : 'hand';
      const applied = hurtPlayer(target, rawDamage, p, undefined, sourceLabel);
      const dealt = applied === 'absorbed' ? 0 : (Number(applied) || 0);
      ctx.nearby(locationOf(p), {
        kind: 'hit',
        playerId: p.id,
        targetPlayerId: target.id,
        entityId: `player:${target.id}`,
        damage: dealt,
        hp: characterOf(target)?.health ?? 0,
        maxHp: characterOf(target)?.maxHealth ?? 0,
        source: sourceLabel,
        pvp: true,
        ...(applied === 'absorbed' ? { absorbed: true } : {}),
        ...(r.backstab ? { backstab: true } : {}),
      });
      if (r.backstab) ctx.notify(p, { kind: 'combat', text: 'Successful backstab!' });
      return;
    }
    const c = characterOf(p);
    if (!c || !target._m) return;
    if (transforming(target)) {
      entityEvent(target, { kind: 'miss', playerId: p.id, entityId: target.id });
      return;
    }
    const facingAway = Math.abs(wrapAngle(yawTo(target, p) - target.yaw)) > Math.PI / 2;
    const modifiers = S.characterAttackModifiers?.(p, {
      skill: weapon?.skill ?? 'Hand-to-Hand', group: enemyGroup(target._m), armed: !!weapon,
    });
    const r = playerAttack({
      player: { view: playerView(p), skill: (n) => S.skillValue?.(p, n) ?? skillOf(c, n) },
      weapon,
      swing: weapon?.bow ? null : SWINGS[direction],
      monster: target._m,
      monsterView: monsterView(target),
      facingAway,
      modifiers,
      random,
    });
    if (r.ineffective) {
      if (target.hostile !== false) provoke(target, p);
      ctx.notify(p, { kind: 'ineffective', entityId: target.id, text: 'Your weapon has no effect on this creature.' });
      return;
    }
    // Weapon Strikes payloads (package 16, DoItemEnchantmentPayloads): Potent/Low Damage Vs, CastWhenStrikes and
    // artifact strikes adjust the damage and wear the weapon; `after` runs once the hit has landed.
    let strike = null;
    if (weapon && r.hit && typeof S.enchantmentStrike === 'function') {
      try { strike = S.enchantmentStrike(p, target, { itemId: item?.id ?? null, damage: r.damage }); } catch { strike = null; }
    } else if (weapon) {
      // WeaponManager runs the Strikes payloads for a swing that reaches the target even when it deals 0 damage.
      try { S.enchantmentContact?.(p, target, { itemId: item?.id ?? null }); } catch {}
    }
    const enchantmentDamage = strike ? Number(strike.damage) - r.damage || 0
      : weapon ? Number(S.enchantmentDamageBonus?.(p, target)) || 0 : 0;
    const damage = r.damage + enchantmentDamage;
    if (!r.hit || damage <= 0) {
      if (target.hostile !== false) provoke(target, p);
      entityEvent(target, { kind: 'miss', playerId: p.id, entityId: target.id });
      return;
    }
    if (typeof S.advanceSkill === 'function') {
      S.advanceSkill(p, r.skill, 1);
      S.advanceSkill(p, 'Critical Strike', 1);
      if (r.backstabbing) S.advanceSkill(p, 'Backstabbing', 1);
    }
    if (weapon) {
      try {
        S.damageItem?.(p, item?.id ?? 'weapon', 1);
      } catch {}
    }
    if (weapon?.bow && arrow && !arrow.conjured && target._ally == null
      && (cfg.arrowRecoveryChance >= 1 || (cfg.arrowRecoveryChance > 0 && random() < cfg.arrowRecoveryChance))) {
      (target._stuckArrows ??= []).push({
        template: arrow.template ?? 'arrow',
        ...(arrow.variant != null ? { variant: arrow.variant } : {}),
      });
    }
    const result = applyMonsterDamage(target, damage, p, weapon?.bow ? 'arrow' : weapon ? 'weapon' : 'hand', r.backstab ? { backstab: true } : null);
    if (result.damage > 0) S.conditionPlayerHit?.(p, target, result.damage);
    if (strike?.after) {
      try { strike.after(result); } catch {}
    }
    if (r.backstab) ctx.notify(p, { kind: 'combat', text: 'Successful backstab!' });
  }

  ctx.onAction('combat.loot', (p, args) => {
    requireFighter(p);
    const e = typeof args.targetId === 'string' ? ctx.entities.get(args.targetId) : null;
    if (!e || e.kind !== 'monster' || !e._m || e._ally != null || e.location !== locationOf(p) || hiddenFrom(e, p)) {
      throw new Error('There is nothing there to search.');
    }
    if (!e.dead) throw new Error('It is still alive!');
    if (dist(p, e) > cfg.lootReach + cfg.reachSlack || !sameFloor(p, e, e.location)) throw new Error('That is too far away.');
    if (e._claimedBy != null) throw new Error(`The ${e.name} has already been searched.`);
    if (!e._damageBy.has(p.id) && ctx.now() - e._diedAt < cfg.lootOpenMs) {
      throw new Error(`Only those who fought the ${e.name} may search it yet.`);
    }
    let gold = 0;
    const items = [];
    const artItems = [];
    if (e._loot.length) {
      if (typeof S.giveItem !== 'function') throw new Error('Your pack is unavailable.');
      for (const { template, appearance, quantity = 1, variant, extra } of e._loot) {
        const item = S.giveItem(p, template, quantity, appearance ?? { variant, extra });
        if (template === 'gold') {
          gold += quantity;
          artItems.push({ template });
          continue;
        }
        items.push(item?.name ?? template);
        if (item?.icon) artItems.push({ icon: item.icon, variant: item.variant });
      }
    }
    // Only now, after every grant succeeded, is the corpse marked as searched.
    e._claimedBy = p.id;
    e.looted = true;
    e.lootable = false;
    const parts = [gold > 0 ? `${gold} gold` : null, ...items].filter(Boolean);
    ctx.notify(p, {
      kind: 'loot',
      entityId: e.id,
      gold,
      items,
      artItems,
      text: parts.length ? `You find ${parts.join(', ')}.` : `You find nothing of value on the ${e.name}.`,
    });
    entityEvent(e, { kind: 'looted', entityId: e.id, playerId: p.id });
    ctx.emit('loot', { player: p, entity: e, gold, items });
  });

  // The player's own death movie ended (played through or skipped, DaggerfallVidPlayerWindow): get up at the
  // location's spawn now instead of at the resurrectMs cap. A player who is no longer defeated gets nothing.
  ctx.onAction('combat.rise', (p) => {
    if (!p.rpg?.defeated) return { risen: false };
    resurrect(p);
    return { risen: true };
  });

  ctx.onAction('combat.revive', (p, args) => {
    requireFighter(p);
    const t = ctx.players.get(Number(args.targetId));
    if (!t || t === p || locationOf(t) !== locationOf(p) || ctx.sameScene?.(t, p) === false || !t.rpg?.defeated) throw new Error('There is no one here to help up.');
    const help = S.pvp?.canPlayerHelpPlayer?.(p, t, { kind: 'revive' });
    if (help && !help.allowed) throw new Error(help.reason || 'You cannot assist that player.');
    if (dist(p, t) > cfg.reviveReach + cfg.reachSlack) throw new Error('That is too far away.');
    ctx.dirty(t);
    resurrect(t, { inPlace: true, fraction: cfg.assistFraction });
    S.pvp?.onPlayerHelp?.(p, t);
    ctx.notify(t, { kind: 'combat', text: `${p.name} helps you to your feet.` });
  });

  // ------------------------------------------------------------------ services

  S.damageEntity = (p, entityOrId, amount, opts = {}) => {
    const e = typeof entityOrId === 'string' ? ctx.entities.get(entityOrId) : entityOrId;
    if (!e || e.kind !== 'monster' || !e._m || ctx.entities.get(e.id) !== e || (p && !canHarmMonster(p, e))) throw new Error('That cannot be harmed.');
    if (e.dead) throw new Error('It is already dead.');
    if (p && e.location !== locationOf(p)) throw new Error('That is too far away.');
    const n = Math.trunc(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return { damage: 0, hp: e.hp, killed: false };
    return applyMonsterDamage(e, Math.min(n, cfg.maxServiceDamage), p ?? null, typeof opts.source === 'string' ? opts.source.slice(0, 20) : 'magic');
  };
  S.canHarmMonster = canHarmMonster;
  S.monsterOpponents = monsterOpponents;
  S.damageMonsterBy = (e, target, amount) => {
    if (!monsterOpponents(e, target)) return 0;
    return applyMonsterDamage(target, amount, e, 'magic').damage;
  };
  S.isDefeated = isDefeated;
  S.reviveFromArrest = (p) => resurrect(p, { inPlace: true, fraction: 0.01 });
  S.provokeEnemy = provoke;
  S.monsterThreatens = (e, p) => e?.kind === 'monster' && !e.dead && e.hp > 0 && !e._playerAlly && e.hostile !== false
    && canSense(e, p) && sameFloor(e, p, e.location) && sees(e.location, e, p)
    && !S.magicStatus?.(e)?.pacified && !S.magicStatus?.(e)?.charmed;
  S.restEncounter = (p, minute) => {
    if (!cfg.classicSpawns || !Number.isFinite(minute)) return null;
    const location = locationOf(p);
    const kind = kindOf(location);
    const scene = scenes.get(location);
    if (!scene || scene.external || !geometryReady(location)) return null;
    if (kind === 'dungeon') {
      if ((alertUntil.get(p.id) ?? 0) <= ctx.now()) return null;
      if (!intermittentSpawn(minute, 'dungeonRest', random)) return null;
      const authoredTable = sitesFor(location)?.find((site) => Number.isInteger(site.table))?.table;
      return spawnNearPlayer(p, scene, authoredTable ?? dungeonTable(location), 'dungeon-rest', 8);
    }
    if (kind !== 'town' && kind !== 'wilderness') return null;
    if (!intermittentSpawn(minute, kind === 'town' ? 'location' : 'wilderness', random)) return null;
    const time = ((minute % 1440) + 1440) % 1440;
    const table = climateEncounterTable(climateOf(location), { inLocation: kind === 'town', night: time < 360 || time > 1080 });
    return spawnNearPlayer(p, scene, table, 'climate-rest', MIN_SPAWN_DISTANCE);
  };
  /**
   * Damage to a player from a source other than a monster's weapon (enemy spells, traps, holy ground): shields,
   * defeat, and a private `hurt` event whose cause is `cause`, else 'trap' for trap sources, else 'other'.
   */
  S.hurtPlayerBy = (p, amount, source, cause) => {
    const c = characterOf(p);
    if (!c || !(amount > 0)) return 0;
    const before = c.health;
    const isPlayerOrReflected = source && (ctx.players.get(source.id) === source || source.kind === 'reflected');
    const src = source?.kind === 'monster' || isPlayerOrReflected ? source : null;
    hurtPlayer(p, Math.trunc(amount), src, undefined, cause ?? (source?.kind === 'trap' ? 'trap' : 'other'));
    return Math.max(0, before - (characterOf(p)?.health ?? before));
  };
  S.monstersIn = (location) => [...ctx.entities.values()].filter((e) => e.kind === 'monster' && e._m && !e.dead && e.location === location);
  S.summonCombatAlly = (p, monsterId, origin) => {
    if (p.arriving || isDefeated(p)) throw new Error('You cannot summon an ally right now.');
    const location = locationOf(p);
    const y = footOf(p, location);
    let nearest = null;
    let best = SUMMON_ENEMY_RANGE;
    for (const e of S.monstersIn(location)) {
      // The reference scans by team, including pacified enemies. Shared-world quest and law opponents
      // are excluded so they cannot supply a public copy or trigger a summon for another player.
      if (!allowsMonsterCombat(e) || e._playerAlly || e._ally != null || !sameFloor(p, e, location)) continue;
      const distance = Math.hypot(dist(e, p), (e.y ?? y ?? 0) - (y ?? e.y ?? 0));
      if (distance < best) {
        nearest = e;
        best = distance;
      }
    }
    let pvpFoe = null;
    if (!nearest && S.pvp?.canPlayerHarmPlayer) {
      for (const q of ctx.players.values()) {
        if (q === p || q.arriving || isDefeated(q) || locationOf(q) !== location) continue;
        if (!S.pvp.canPlayerHarmPlayer(p, q, { kind: 'pet' })?.allowed) continue;
        const distance = dist(q, p);
        if (distance < best) {
          pvpFoe = q;
          best = distance;
        }
      }
    }
    if (!nearest && !pvpFoe) return null;
    const id = monsterId ?? nearest?.monsterId ?? 15;
    const yaw = p.yaw ?? 0;
    const at = placeable(location, p.x + Math.sin(yaw) * 2, p.z - Math.cos(yaw) * 2, y);
    if (!at || !geometryReady(location)) throw new Error('Nothing answers the call here.');
    const ally = S.createEnemy(location, id, at.x, at.z, {
      yaw, y, origin, team: TEAM_PLAYER_ALLY, allyOwner: p.id, level: levelOf(characterOf(p)),
      waterY: nearest && isAquatic(ENEMY_BY_ID.get(id)) ? waterSurface(nearest, at.x, at.z) : undefined,
    });
    if (!ally) throw new Error('Nothing answers the call here.');
    ctx.onRollback?.(() => scenes.get(location)?.monsters.delete(ally.id));
    return ally;
  };
  S.banishMonster = (e) => {
    if (ctx.entities.get(e.id) !== e || e.dead || e._quest?.foe) return false;
    // Scene membership is reclaimed by the tick, after the cast transaction is saved.
    return ctx.entities.delete(e.id);
  };

  /** Evidence: spawned counts by `id|origin` and skipped source records by `id|reason`. */
  const report = () => ({ spawned: Object.fromEntries(stats.spawned), skipped: Object.fromEntries(stats.skipped) });
  S.combatStats = report;
  /**
   * A fully formed enemy of MobileTypes `id` that fights, casts and drops classic loot, for features that place
   * their own foes (quests). opts: {id, level, gender, yaw, y, origin, key}. Returns the entity or null (with the
   * reason counted in combatStats) for reserved or unknown ids.
   */
  S.createEnemy = (location, id, x, z, opts = {}) => {
    let scene = scenes.get(location);
    if (!scene) {
      scene = { monsters: new Set(), emptySince: null, nightKey: null, external: true };
      scenes.set(location, scene);
    }
    return spawnMonster(location, id, x, z, scene, { origin: 'quest', ...opts });
  };
  return { scenes, cfg, stats: report, spawnMonster: (location, monsterId, x, z, opts = {}) => {
    let scene = scenes.get(location);
    if (!scene) {
      scene = { monsters: new Set(), emptySince: null, nightKey: null };
      scenes.set(location, scene);
    }
    return spawnMonster(location, monsterId, x, z, scene, opts);
  } };
}

export { ENCOUNTER_TABLES };
