// Shared-world spellbook and spellcasting (panel 'spellbook', actions magic.*).
//
// Spells come from the operator's SPELLS.STD (ARENA2_DIR) when present, else from a small built-in
// set of original spells. Effect costs, magnitudes, durations, chances and saving throws follow
// Daggerfall Unity's formulas (MIT, see server/rpg/magic/*.js). The server is authoritative:
// it validates magicka, cooldown, range, aim, target kind and status before anything changes.
import { randomUUID } from 'node:crypto';
import { loadCatalogue, startingSpellIds } from './magic/catalogue.js';
import { EFFECTS } from './magic/effects.js';
import { CONJURED_EQUIPMENT } from './magic/conjuration.js';
import { CAST_COST_FLOOR, spellCosts, effectGoldCost, rollMagnitude, durationRounds, chanceValue, savingThrow, classicCastingCost } from './magic/formulas.js';
import { buildCustomSpell, makerTemplates, saveCustomSpell } from './magic/spellmaker.js';
import { ENEMY_EXTRAS } from './combat/monsters.js';
import { actorDistance, directionFrom, distance, obstructionDistance, pointAt, ranged } from './magic/delivery.js';
import { priceContext, tradePrice } from '../../client/gameplay/economy/rules.js';

export const MAGIC = Object.freeze({
  roundMs: 5000, // one classic magic round = one game minute = 5 real seconds at DFU's 12x timescale
  cooldownMs: 1200, // length of the classic cast animation; one spell at a time
  touchRange: 3.0 + 0.75, // DaggerfallMissile.TouchRange plus latency slack
  missileRange: 200, // DaggerfallMissile.LifespanInSeconds times MovementSpeed
  missileSpeed: 25,
  areaRadius: 4.0, // DaggerfallMissile.ExplosionRadius
  aimCone: 0.6, // radians either side of the caster's facing for missiles
  touchCone: 1.1,
  maxActivePerTarget: 24,
});

const POOLS = {
  health: ['health', 'maxHealth', 'hp', 'maxHp'],
  fatigue: ['fatigue', 'maxFatigue', 'fatigue', 'maxFatigue'],
  magicka: ['magicka', 'maxMagicka', 'magicka', 'maxMagicka'],
};
const ENEMY_GROUPS = {
  animal: new Set([0, 3, 4, 5, 6, 11, 20, 34, 40]),
  humanoid: new Set([1, 2, 7, 8, 9, 10, 12, 13, 14, 16, 21, 22, 24, 41, 42]),
  undead: new Set([15, 17, 18, 19, 23, 28, 30, 32, 33]),
  daedra: new Set([25, 26, 27, 29, 31]),
};
const CONCEALMENT = new Set(['invisible', 'chameleon', 'shadow']);
const NO_SPELL_ICON = new Set([...EFFECTS.values()].filter((e) => !e.showSpellIcon).map((e) => e.key));
const NEARBY_RANGE = 14;
const FLOOR_REACH = 2.2;
const bundleIdOf = (a) => a.bundleId ?? JSON.stringify([a.spellId, a.casterId, a.casterEntityId, a.objectCast, a.reflected, a.source?.itemId]);

function enemyGroup(e, group) {
  if (group === 'class') return e._m?.human === true;
  const id = e.monsterId ?? e._m?.id;
  return Number.isInteger(e.monsterId) ? ENEMY_GROUPS[group]?.has(id)
    : e.affinity === group || e.group === group || ENEMY_GROUPS[group]?.has(id);
}

const wrap = (a) => {
  a %= 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
};

/** Public, JSON-safe description of a spell for the spellbook. */
export function publicSpell(spell) {
  return {
    id: spell.id, name: spell.name, index: spell.index, element: spell.element, targetType: spell.targetType,
    icon: spell.icon, price: spell.price, support: spell.support, harmful: spell.harmful, schools: spell.schools,
    origin: spell.origin, baseCosts: spell.baseCosts, ...(spell.innate && { innate: spell.innate }),
    effects: spell.effects.map(({ template: t, settings: s }) => ({
      key: t.key, name: t.name, school: t.school, support: t.support, reason: t.reason, gold: effectGoldCost(t, s),
      duration: t.duration ? { base: s.durationBase, plus: s.durationPlus, perLevel: s.durationPerLevel } : null,
      chance: t.chance ? { base: s.chanceBase, plus: s.chancePlus, perLevel: s.chancePerLevel } : null,
      magnitude: t.magnitude
        ? { min: s.magnitudeBaseMin, max: s.magnitudeBaseMax, plusMin: s.magnitudePlusMin, plusMax: s.magnitudePlusMax, perLevel: s.magnitudePerLevel }
        : null,
    })),
  };
}

export function install(ctx, options = {}) {
  const opts = { ...MAGIC, ...(ctx.config?.magic ?? {}), ...options };
  const rng = opts.rng ?? Math.random;
  const catalogue = opts.catalogue ?? loadCatalogue({
    arena2Dir: opts.arena2Dir ?? ctx.dataPath ?? ctx.config?.arena2Dir ?? null,
    spellsStd: opts.spellsStd ?? null,
  });
  if (catalogue.error) console.warn(`magic: ${catalogue.error}; using built-in spells`);
  const vampireSpells = new Map();

  const cooldownUntil = new Map(); // player id -> ms
  const entityEffects = new Map(); // entity id -> active effect array
  const missiles = new Set();
  const lastDetection = new WeakMap();
  const pendingChoices = new WeakMap();
  let roundClock = 0;
  let detectionClock = 0;
  let missileSeq = 0;
  const services = (ctx.services ??= {});
  const makerEffects = makerTemplates();

  function customSpells(p) {
    const out = [];
    for (const draft of magicOf(p).custom) {
      if (typeof draft?.id !== 'string' || !draft.id.startsWith('custom:')) continue;
      try { out.push(buildCustomSpell(draft, draft.id)); } catch { /* Skip malformed saved drafts. */ }
    }
    return out;
  }
  const requiresSeller = () => catalogue.source === 'SPELLS.STD' && typeof services.requireNpcService === 'function';

  function sellerMarket(p, seller) {
    return services.priceContext?.(p, p.rpg.location, seller.quality)
      ?? priceContext({ quality: seller.quality, character: p.rpg.character });
  }

  function learningPrice(p, spell, market) {
    if (opts.freeLearning) return 0;
    // DaggerfallSpellBookWindow prices standard spells at four times the buyer's casting cost,
    // applies the festival, then calculates the seller's trade price.
    const base = market ? 4 * costsFor(p, spell).magicka : spell.price;
    const presented = services.holidayPrice?.('spell', base, { p })?.price ?? base;
    return market ? tradePrice(presented, market.quality, false, market) : presented;
  }

  function catalogueEvent(p, market = null) {
    const known = magicOf(p).known;
    const spells = [...catalogue.spells.values(), ...vampireSpells.values()].filter(s => !s.hidden || known.includes(s.id)).map(s => ({
      ...publicSpell(s), price: learningPrice(p, s, market),
    }));
    return {
      kind: 'spellCatalogue', source: catalogue.source, coverage: catalogue.coverage,
      requiresSeller: requiresSeller(), spells: spells.concat(customSpells(p).map(publicSpell)),
    };
  }

  // ---------- state helpers ----------

  function magicOf(p) {
    p.rpg ??= {};
    const m = (p.rpg.magic ??= {});
    if (!Array.isArray(m.known)) m.known = [];
    if (!Array.isArray(m.active)) m.active = [];
    if (!Array.isArray(m.custom)) m.custom = [];
    if (m.selected === undefined) m.selected = null;
    return m;
  }

  /** Grant class starting spells once a character exists. Returns true if anything changed. */
  function grantStarting(p) {
    const m = magicOf(p);
    const cls = p.rpg.character?.className;
    if (m.granted || !cls) return false;
    m.granted = true;
    for (const id of startingSpellIds(catalogue, cls)) if (!m.known.includes(id)) m.known.push(id);
    if (!m.selected && m.known.length) m.selected = m.known.find((id) => catalogue.spells.get(id)?.support !== 'unsupported') ?? null;
    return true;
  }

  const activeOf = (t) => (t.kind === 'player' ? magicOf(t.ref).active : entityEffects.get(t.id) ?? []);
  function setActive(t, list) {
    if (t.kind === 'player') {
      magicOf(t.ref).active = list;
      return;
    }
    const before = entityEffects.get(t.id);
    ctx.onRollback?.(() => {
      if (before) entityEffects.set(t.id, before);
      else entityEffects.delete(t.id);
    });
    if (list.length) entityEffects.set(t.id, list);
    else entityEffects.delete(t.id);
  }

  const asPlayerTarget = (q) => ({ kind: 'player', ref: q, id: `player:${q.id}`, name: q.name, x: q.x, z: q.z });
  const asEntityTarget = (e) => ({ kind: 'entity', ref: e, id: e.id, name: e.name ?? e.id, x: e.x, z: e.z });

  function pool(t, name) {
    const [cur, max, eCur, eMax] = POOLS[name];
    if (t.kind === 'player') {
      const c = t.ref.rpg?.character;
      if (!c || typeof c[cur] !== 'number') return null;
      return { obj: c, cur, max: typeof c[max] === 'number' ? c[max] : Infinity };
    }
    const e = t.ref;
    if (name === 'fatigue' && typeof e.fatigue !== 'number') {
      e.maxFatigue = liveAttribute(t, 'Strength') + liveAttribute(t, 'Endurance');
      e.fatigue = e.maxFatigue;
    }
    if (typeof e[eCur] !== 'number') return null;
    return { obj: e, cur: eCur, max: typeof e[eMax] === 'number' ? e[eMax] : Infinity };
  }

  function statusesOf(t) {
    const out = {};
    for (const a of activeOf(t)) {
      if (!a.status || a.roundsLeft <= 0) continue;
      const value = a.status === 'comprehendLanguages' ? a.chance ?? 0 : a.roundsLeft;
      out[a.status] = Math.max(out[a.status] ?? 0, value);
    }
    return out;
  }

  function baseAttribute(t, key) {
    const a = t.kind === 'player' ? t.ref.rpg?.character?.attributes
      : t.ref.attributes ?? t.ref._career?.attributes ?? t.ref._mcareer?.attributes;
    return a?.[key] ?? (key === 'Willpower' ? t.ref.willpower : undefined) ?? 50;
  }

  const attributeDamage = (t) => t.kind === 'player' ? magicOf(t.ref).attributeDamage : t.ref._magicAttributeDamage;

  function changeAttributeDamage(t, key, delta) {
    const state = t.kind === 'player' ? magicOf(t.ref) : t.ref;
    const field = t.kind === 'player' ? 'attributeDamage' : '_magicAttributeDamage';
    const damage = (state[field] ??= {});
    const before = damage[key] ?? 0;
    const after = Math.max(0, Math.min(baseAttribute(t, key) - 1, before + delta));
    if (after > 0) damage[key] = after;
    else delete damage[key];
    if (after !== before && t.kind === 'player') ctx.dirty?.(t.ref);
    return after - before;
  }

  function healAttribute(t, key, amount) {
    const healed = -changeAttributeDamage(t, key, -amount);
    if (t.kind !== 'player' || healed >= amount) return healed;
    return healed + (services.healConditionAttribute?.(t.ref, key, amount - healed) ?? 0);
  }

  function canParalyze(t) {
    return !statusesOf(t).freeAction && (t.kind !== 'player' || !services.conditionImmune?.(t.ref, 'paralysis'));
  }

  function applyRecall(p, operation) {
    const custody = services.law?.custody?.(p);
    if (custody) throw new Error(custody);
    const m = magicOf(p);
    if (operation === 'anchor') {
      const portal = p.rpg.portal?.to === loc(p) ? p.rpg.portal : null;
      const y = footAt(p, loc(p));
      m.anchor = { location: loc(p), x: p.x, y, z: p.z, yaw: p.yaw ?? 0, ...(portal ? { portal: structuredClone(portal) } : {}) };
      return 'Recall anchor set.';
    }
    const a = m.anchor;
    if (!a) throw new Error('You have no Recall anchor.');
    if (!services.portals?.transfer) throw new Error('Recall travel is unavailable here.');
    const collision = services.collision;
    if (collision && !collision.isClear(a.location, a.x, a.z, a.y)) {
      collision.preload?.(a.location);
      if (collision.status?.(a.location)?.status === 'loading') throw new Error('Your Recall destination is still loading. Cast again in a moment.');
      throw new Error('Your Recall anchor is obstructed.');
    }
    const portal = a.portal ? services.portals.into?.(a.location) ?? a.portal : null;
    services.portals.transfer(p, a, { portal, returnTo: a.portal?.returnTo, label: 'Recall anchor' });
    delete m.anchor;
    return 'Returned to your Recall anchor.';
  }

  const alive = (e) => e && ctx.entities.get(e.id) === e && !(typeof e.hp === 'number' && e.hp <= 0) && !e.dead;

  // ---------- damage plumbing ----------

  function damageEntity(caster, e, amount) {
    if (amount <= 0 || !alive(e)) return 0;
    const before = typeof e.hp === 'number' ? e.hp : null;
    if (typeof services.damageEntity === 'function') {
      // Combat feature contract: damageEntity(p, entity, amount, {source}) -> {damage, hp, killed}.
      const r = services.damageEntity(caster, e, amount, { source: 'magic' });
      if (r && typeof r === 'object' && Number.isFinite(r.damage)) return r.damage;
      if (before !== null && typeof e.hp === 'number') return Math.max(0, before - e.hp);
      return typeof r === 'number' ? r : amount;
    }
    return damageEntityFallback(caster, e, amount);
  }

  // Used only when no combat feature is installed.
  function damageEntityFallback(caster, e, amount) {
    if (typeof e.hp !== 'number') return 0;
    const floor = amount >= e.hp && services.onMonsterLethalHit?.(caster, e) === false ? 1 : 0;
    const dealt = Math.min(e.hp - floor, amount);
    e.hp -= dealt;
    if (e.hp <= 0) {
      e.hp = 0;
      e.dead = true;
      ctx.emit?.('kill', { player: caster, entity: e });
    }
    return dealt;
  }

  // ---------- targeting ----------

  function aimYaw(p, args) {
    const y = Number(args?.yaw);
    if (Number.isFinite(y) && Math.abs(wrap(y - (p.yaw ?? 0))) <= 0.6) return y;
    return p.yaw ?? 0;
  }

  function geometry(p, yaw, x, z) {
    const dx = x - p.x;
    const dz = z - p.z;
    const dist = Math.hypot(dx, dz);
    const bearing = Math.atan2(dx, -dz); // 0 = north (-z), clockwise positive
    return { dist, off: dist < 0.5 ? 0 : Math.abs(wrap(bearing - yaw)) };
  }

  const loc = (p) => p.rpg?.location;

  function footAt(a, location) {
    const portalY = a.rpg?.portal?.to === location ? a.rpg.portal.footY : null;
    return a.y ?? services.collision?.bodyOf?.(a)?.y ?? portalY ?? services.collision?.groundAt?.(location, a.x, a.z) ?? 0;
  }
  const position = (a, location, offset = 0) => ({ x: a.x, y: footAt(a, location) + offset, z: a.z });
  const bodyPosition = (t, location) => position(t.ref, location, t.kind === 'player' ? 1.05 : 0.9);
  const nearOnFloor = (a, b) => Math.abs(a.y - b.y) <= FLOOR_REACH && distance(a, b) < NEARBY_RANGE;
  /** `own` = {id, firstTriangle, triangleCount}: the casting mechanism, whose geometry does not block its own missile. */
  function clearLine(location, a, b, own = null) {
    const mesh = services.collision?.instanceWorld?.(location);
    if (mesh?.segmentClear) {
      const skip = own ? (t) => mesh.mechanismAt?.(t) === own.id || (t >= own.firstTriangle && t < own.firstTriangle + own.triangleCount) : undefined;
      return mesh.segmentClear(a.x, a.y, a.z, b.x, b.y, b.z, skip);
    }
    return services.canSee?.(location, a.x, a.z, b.x, b.z, { y1: a.y - 1.5, y2: b.y - 1.5 }) ?? true;
  }

  /** Monsters spells may affect: the combat feature's living monsters when it is installed. */
  function harmable(location, viewer = null) {
    const list = typeof services.monstersIn === 'function' ? services.monstersIn(location).filter(alive)
      : [...ctx.entities.values()].filter((e) => e.kind === 'monster' && e.location === location && alive(e));
    return viewer ? list.filter((e) => canHarm(e, viewer)) : list;
  }
  const seenBy = (e, p) => e.visibleTo == null || (e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : Array.isArray(e.visibleTo) && e.visibleTo.includes(p.id));
  const canHarm = (e, p) => services.canHarmMonster?.(p, e) ?? seenBy(e, p);
  const monstersAt = (location, viewer) => harmable(location, viewer).map(asEntityTarget);
  function playersAt(location, except) {
    const out = [];
    for (const q of ctx.players.values()) {
      if (q !== except && !q.arriving && loc(q) === location && q.rpg?.character?.health > 0 && !q.rpg.defeated) out.push(asPlayerTarget(q));
    }
    return out;
  }

  function findTarget(p, id) {
    if (id === undefined || id === null || id === '') return null;
    const pm = typeof id === 'number' ? id : /^player:(\d+)$/.exec(String(id))?.[1];
    if (pm !== undefined && pm !== null) {
      const q = ctx.players.get(Number(pm));
      if (!q || q.arriving || loc(q) !== loc(p) || ctx.sameScene?.(q, p) === false || !q.rpg?.character || q.rpg.defeated) throw new Error('That person is not here.');
      return q === p ? { ...asPlayerTarget(q), self: true } : asPlayerTarget(q);
    }
    const e = ctx.entities.get(String(id));
    if (!e || e.location !== loc(p) || !canHarm(e, p)) throw new Error('That target is not here.');
    if (!alive(e)) throw new Error(`${e.name ?? 'That'} is already dead.`);
    if (e.kind !== 'monster' || !harmable(e.location).includes(e)) throw new Error(`You cannot cast spells at ${e.name ?? 'that'}.`);
    return asEntityTarget(e);
  }

  /** Resolve the spell's targets. Throws (nothing spent) when the cast cannot start. */
  function resolveTargets(p, spell, args) {
    const yaw = aimYaw(p, args);
    const location = loc(p);
    const me = { ...asPlayerTarget(p), self: true };
    const t = spell.targetType;
    const banishments = spell.effects.filter((eff) => eff.template.behaviour?.kind === 'banish');
    const nearBanishTargets = () => monstersAt(location, p).filter((target) =>
      banishments.some((eff) => enemyGroup(target.ref, eff.template.behaviour.group)) &&
      nearOnFloor(position(p, location), position(target.ref, location)));
    if (t === 'caster') {
      const center = position(p, location, 1.2);
      const targets = banishments.length ? nearBanishTargets().map((target) => ({ ...target, banishOnly: true })) : [];
      if (banishments.length !== spell.effects.length) targets.unshift(me);
      return { targets, center };
    }

    const harmful = spell.harmful;
    const range = t === 'touch' ? opts.touchRange : opts.missileRange;
    const cone = t === 'touch' ? opts.touchCone : opts.aimCone;
    const pool = harmful ? monstersAt(location, p) : playersAt(location, p);

    if (t === 'areaAroundCaster') {
      const center = { x: p.x, z: p.z };
      const targets = banishments.length === spell.effects.length ? nearBanishTargets()
        : inRadius(harmful ? monstersAt(location, p) : playersAt(location, p), position(p, location, 1.2), location);
      return { targets, center, area: true };
    }

    let target = findTarget(p, args?.targetId);
    if (target) {
      if (target.self) {
        if (harmful) throw new Error('You cannot cast that on yourself.');
        if (t !== 'areaAtRange') return { targets: [me], center: { x: p.x, z: p.z } };
      }
      if (harmful && target.kind === 'player') throw new Error('Harmful spells cannot be cast at other players.');
      if (!harmful && target.kind === 'entity') throw new Error(`${spell.name} would only help ${target.name}.`);
      const g = geometry(p, yaw, target.x, target.z);
      if (g.dist > range) throw new Error(t === 'touch' ? `${target.name} is out of reach.` : `${target.name} is out of range.`);
      if (g.off > cone) throw new Error(`You are not facing ${target.name}.`);
      if (t === 'touch' && !touchable(p, target, location)) throw new Error(`${target.name} is out of reach.`);
    } else if (!ranged(t) || !Number.isFinite(args?.pitch) || opts.missileSpeed === Infinity) {
      let best = null;
      for (const c of pool) {
        const g = geometry(p, yaw, c.x, c.z);
        if (t === 'touch' && !touchable(p, c, location)) continue;
        if (g.dist <= range && g.off <= cone && (!best || g.dist + g.off * 4 < best.score)) best = { c, score: g.dist + g.off * 4 };
      }
      target = best?.c ?? null;
    }

    if (!target) {
      if (t === 'touch') throw new Error(harmful ? 'There is nothing within reach.' : 'There is no one within reach.');
      return { targets: [], center: null, missed: true, aimed: null };
    }
    if (t === 'areaAtRange') {
      const center = { x: target.x, z: target.z };
      return { targets: inRadius(harmful ? monstersAt(location, p) : playersAt(location, null), bodyPosition(target, location), location), center, area: true, aimed: target };
    }
    return { targets: [target], center: { x: target.x, z: target.z }, aimed: target };
  }

  function touchable(p, target, location) {
    const start = position(p, location, 1.55);
    const end = bodyPosition(target, location);
    return Math.abs(footAt(p, location) - footAt(target.ref, location)) <= 1.6 && clearLine(location, start, end);
  }

  function inRadius(list, center, location) {
    return list.filter((t) => {
      const end = bodyPosition(t, location);
      return distance(center, end) <= opts.areaRadius && clearLine(location, center, end);
    });
  }

  // ---------- saving throws ----------

  function targetDefence(t) {
    const willpower = liveAttribute(t, 'Willpower');
    if (t.kind === 'player') {
      const c = t.ref.rpg.character;
      return {
        willpower,
        immune: (kind) => !!services.characterSavingThrow?.(t.ref, kind)?.immune,
        tolerance: (kind) => {
          const saving = services.characterSavingThrow?.(t.ref, kind);
          return saving?.critical ? 'critical' : undefined;
        },
        modifier: (kind) => services.characterSavingThrow?.(t.ref, kind)?.modifier ??
          (kind === 'magic' ? c.biography?.mods?.resistMagic ?? 0 : 0),
        resistChance: (el) => wardChance(t, `resist${{ fire: 'Fire', cold: 'Frost', poison: 'Poison', shock: 'Shock', magic: 'Magicka' }[el]}`),
      };
    }
    const e = t.ref;
    return {
      willpower,
      tolerance: (kind) => e.resistances?.[kind] ?? e.tolerances?.[kind],
      resistChance: (el) => wardChance(t, `resist${{ fire: 'Fire', cold: 'Frost', poison: 'Poison', shock: 'Shock', magic: 'Magicka' }[el]}`),
    };
  }

  const wardChance = (t, status) => Math.max(0, ...activeOf(t)
    .filter((entry) => entry.status === status).map((entry) => entry.chance ?? 60));

  function attributeModifier(t, key) {
    return activeOf(t).reduce((n, effect) => n + (effect.attribute === key ? effect.amount : 0), 0 - (attributeDamage(t)?.[key] ?? 0));
  }

  function liveAttribute(t, key) {
    return services.effectiveAttribute?.(t.ref, key) || Math.max(1, baseAttribute(t, key) + attributeModifier(t, key));
  }

  // ---------- effect application ----------

  function pushActive(t, entry) {
    const list = activeOf(t).filter((a) => !(a.key === entry.key && a.spellId === entry.spellId &&
      a.casterId === entry.casterId && a.casterEntityId === entry.casterEntityId && a.objectCast === entry.objectCast &&
      a.source?.itemId === entry.source?.itemId));
    list.push(entry);
    while (list.length > opts.maxActivePerTarget) list.shift();
    setActive(t, list);
  }

  function applyPool(caster, t, poolName, delta, source = null) {
    if (t.kind === 'entity' && poolName === 'health' && delta < 0) {
      if (source?._m && t.ref !== source && services.damageMonsterBy) return -services.damageMonsterBy(source, t.ref, -delta);
      return -damageEntity(caster, t.ref, -delta);
    }
    if (t.kind === 'player' && poolName === 'health' && delta < 0 && source && typeof services.hurtPlayerBy === 'function') {
      // Enemy spells: the combat feature applies shields, defeat and events.
      return -(Number(services.hurtPlayerBy(t.ref, -delta, source)) || 0);
    }
    const pl = pool(t, poolName);
    if (!pl) return null;
    const before = pl.obj[pl.cur];
    pl.obj[pl.cur] = Math.max(0, Math.min(pl.max, before + delta));
    if (t.kind === 'player') ctx.dirty?.(t.ref);
    return pl.obj[pl.cur] - before;
  }

  function applyEffect(cast, eff, t) {
    const { caster, spell, level, args } = cast;
    const tpl = eff.template;
    const b = tpl.behaviour;
    const s = eff.settings;
    const res = { targetId: t.id, target: t.name, effect: tpl.key, name: tpl.name };
    if (tpl.support === 'unsupported') return { ...res, outcome: 'unsupported', reason: tpl.reason };
    const hostile = !!b.harmful;
    if (hostile && t.kind === 'player' && !cast.enemy && !cast.object && !cast.reflected) return { ...res, outcome: 'skipped' };
    if (!hostile && t.kind === 'entity' && !cast.enemy && !spell.harmful) return { ...res, outcome: 'skipped' };
    const playerCaster = (cast.enemy || cast.object) ? null : caster;
    const casterTarget = cast.enemy ? asEntityTarget(caster) : cast.object ? null : asPlayerTarget(caster);
    const source = cast.enemy || cast.object ? caster : cast.reflected ? { name: spell.name } : null;
    const alterPool = (poolName, delta) => applyPool(playerCaster, t, poolName, delta, source);

    if (b.status === 'paralyzed' && !canParalyze(t)) return { ...res, outcome: 'saved' };
    const chance = tpl.chance ? chanceValue(s, level) : 0;
    const deferredChance = ['soulTrap', 'identify', 'dispel', 'banish'].includes(b.kind) || b.status === 'comprehendLanguages' ||
      b.status?.startsWith('spell') || b.status?.startsWith('resist');
    if (tpl.chance && !deferredChance && !cast.item && !(rng() * 100 < chance)) return { ...res, outcome: t.self ? 'failed' : 'saved' };
    const defence = hostile ? targetDefence(t) : null;
    const save = () => savingThrow({ element: spell.element, paralysis: b.status === 'paralyzed', target: defence, rng });
    const durationSave = hostile && !tpl.magnitude && b.kind !== 'banish' ? save() : 100;
    if (durationSave === 0) return { ...res, outcome: 'saved' };
    const magnitude = () => {
      const m = rollMagnitude(s, level, rng);
      if (!hostile) return m;
      return Math.trunc((m * save()) / 100);
    };
    const rounds = tpl.duration ? durationRounds(s, level) : 0;
    const base = {
      uid: randomUUID(), key: tpl.key, name: tpl.name, spellId: spell.id, spellName: spell.name, element: spell.element,
      bundleId: cast.bundleId,
      casterId: caster.id, casterName: caster.name, roundsLeft: rounds, totalRounds: rounds,
      ...(cast.enemy ? { casterEntityId: caster.id } : {}), ...(cast.object ? { objectCast: true } : {}),
      ...(cast.reflected ? { reflected: true } : {}),
      // CastWhenHeld (package 16): the bundle lives while its item stays equipped (EntityEffectBundle.FromEquippedItem).
      ...(cast.held ? { bundleType: 'held', source: { itemId: cast.held.itemId, itemName: cast.held.itemName } } : {}),
    };

    switch (b.kind) {
      case 'recall':
        if (!t.self || cast.enemy || cast.object) return { ...res, outcome: 'noEffect' };
        return { ...res, outcome: 'applied', message: applyRecall(t.ref, args.recall) };
      case 'door':
        if (!t.self || cast.enemy || cast.object) return { ...res, outcome: 'noEffect' };
        (magicOf(t.ref).door ??= {})[b.operation] = level;
        return { ...res, outcome: 'applied', message: `Ready to ${b.operation} the next door you activate.` };
      case 'identify': {
        if (!t.self || cast.enemy || cast.object) return { ...res, outcome: 'noEffect' };
        if (!cast.item && rng() * 100 >= chance) return { ...res, outcome: 'failed' };
        const result = services.identifyItem?.(t.ref, args.itemId);
        if (!result || result.already) return { ...res, outcome: 'noEffect', reason: 'the item needs no identification' };
        return { ...res, outcome: 'applied', message: `Identified ${result.name}.` };
      }
      case 'createItem':
      case 'dispel':
        if (!t.self || !playerCaster || cast.reflected) return { ...res, outcome: 'noEffect' };
        cast.choices.push({ kind: b.kind, rounds, chance });
        return { ...res, outcome: 'choice' };
      case 'soulTrap': {
        if (t.kind !== 'entity' || !playerCaster) return { ...res, outcome: 'noEffect' };
        const id = t.ref.monsterId ?? t.ref._m?.id;
        if (soulPoints(t.ref, id) === null) return { ...res, outcome: 'noEffect', reason: `${t.name} has no trappable soul` };
        const entry = { ...base, status: b.status, chance: cast.item ? 100 : chance };
        pushActive(t, entry);
        return { ...res, outcome: 'applied', status: b.status, rounds };
      }
      case 'pacify':
        if (t.kind !== 'entity') return { ...res, outcome: 'noEffect' };
        if (!enemyGroup(t.ref, b.group)) return { ...res, outcome: 'noEffect', reason: `${t.name} is outside the spell's target group` };
        t.ref.hostile = false;
        t.ref._targetId = null;
        t.ref._pending = [];
        return { ...res, outcome: 'applied', message: `${t.name} is pacified.` };
      case 'drainAttribute':
      case 'transferAttribute': {
        const m = magnitude();
        if (m <= 0) return { ...res, outcome: 'saved' };
        const amount = changeAttributeDamage(t, b.attribute, m);
        const transferred = b.kind === 'transferAttribute' && casterTarget ? healAttribute(casterTarget, b.attribute, m) : 0;
        return { ...res, outcome: 'applied', amount, pool: b.attribute, sign: -1, transferred };
      }
      case 'healAttribute': {
        const amount = healAttribute(t, b.attribute, magnitude());
        return { ...res, outcome: amount > 0 ? 'applied' : 'noEffect', amount, pool: b.attribute, sign: 1 };
      }
      case 'damage': {
        const m = magnitude();
        if (m <= 0) return { ...res, outcome: 'saved' };
        const d = alterPool(b.pool, -m);
        if (d === null) return { ...res, outcome: 'noEffect', reason: `${t.name} has no ${b.pool}` };
        return { ...res, outcome: 'applied', pool: b.pool, amount: -d, sign: -1, killed: t.kind === 'entity' && !alive(t.ref) || undefined };
      }
      case 'transfer': {
        const m = magnitude();
        if (m <= 0) return { ...res, outcome: 'saved' };
        const d = alterPool(b.pool, -m);
        if (d === null) return { ...res, outcome: 'noEffect', reason: `${t.name} has no ${b.pool}` };
        const gained = casterTarget ? applyPool(playerCaster, casterTarget, b.pool, -d) ?? 0 : 0;
        return { ...res, outcome: 'applied', pool: b.pool, amount: -d, sign: -1, transferred: gained, killed: t.kind === 'entity' && !alive(t.ref) || undefined };
      }
      case 'heal': {
        const d = alterPool(b.pool, magnitude());
        if (d === null) return { ...res, outcome: 'noEffect', reason: `${t.name} has no ${b.pool}` };
        return { ...res, outcome: 'applied', pool: b.pool, amount: d, sign: 1 };
      }
      case 'dot':
      case 'hot': {
        if (!pool(t, b.pool)) {
          return { ...res, outcome: 'noEffect', reason: `${t.name} has no ${b.pool}` };
        }
        const entry = { ...base, pool: b.pool, sign: b.kind === 'dot' ? -1 : 1, settings: s, level, hostile, roundsLeft: rounds };
        // The first round lands on cast; the rest each magic round.
        const first = roundAmount(entry, t);
        const amount = first === null ? 0 : first;
        entry.roundsLeft = rounds - 1;
        if (entry.roundsLeft > 0 && (t.kind === 'player' || alive(t.ref))) pushActive(t, entry);
        return { ...res, outcome: 'applied', pool: b.pool, amount: Math.abs(amount), sign: entry.sign, rounds, killed: t.kind === 'entity' && !alive(t.ref) || undefined };
      }
      case 'disintegrate': {
        const hp = pool(t, 'health');
        const dealt = hp ? -alterPool('health', -hp.obj[hp.cur]) : 0;
        return { ...res, outcome: 'applied', pool: 'health', amount: dealt, killed: t.kind === 'entity' && !alive(t.ref) };
      }
      case 'banish': {
        if (t.kind !== 'entity') return { ...res, outcome: 'noEffect' };
        const e = t.ref;
        if (!enemyGroup(e, b.group)) return { ...res, outcome: 'noEffect', reason: `${t.name} is not ${b.group === 'undead' ? 'undead' : 'daedric'}` };
        if (!playerCaster || e._quest?.foe) return { ...res, outcome: 'noEffect', reason: `${t.name} must be defeated` };
        if (rng() * 100 >= chance) return { ...res, outcome: 'saved' };
        if (!services.banishMonster) ctx.entities.delete(e.id);
        else if (!services.banishMonster(e)) return { ...res, outcome: 'noEffect' };
        setActive(t, []);
        return { ...res, outcome: 'applied', banished: true, message: `${t.name} is banished.` };
      }
      case 'status':
      case 'fortify':
      case 'shield': {
        let r = rounds;
        if (hostile && r > 0) r = Math.max(1, Math.trunc((r * durationSave) / 100));
        const entry = { ...base, roundsLeft: r, totalRounds: r };
        if (b.kind === 'status') entry.status = b.status;
        if (deferredChance) entry.chance = chance;
        if (b.status === 'freeAction') setActive(t, activeOf(t).filter((a) => a.status !== 'paralyzed'));
        if (b.kind === 'fortify') Object.assign(entry, { attribute: b.attribute, amount: Math.max(1, magnitude()) });
        if (b.kind === 'shield') Object.assign(entry, { shield: Math.max(1, magnitude()), status: 'shielded' });
        pushActive(t, entry);
        return { ...res, outcome: 'applied', rounds: r, status: entry.status, amount: entry.amount ?? entry.shield };
      }
      case 'cure': {
        const before = activeOf(t);
        const after = before.filter((a) => !b.removes?.includes(a.key));
        setActive(t, after);
        const removed = before.length - after.length + (b.condition && t.kind === 'player' ? services.cureCondition?.(t.ref, b.condition) ?? 0 : 0);
        return { ...res, outcome: removed ? 'applied' : 'noEffect', removed };
      }
      default:
        return { ...res, outcome: 'unsupported', reason: 'not implemented' };
    }
  }

  /** Apply one round of a damage/heal-over-time effect. Returns the signed change or null. */
  function roundAmount(a, t) {
    let m = rollMagnitude(a.settings, a.level, rng);
    if (a.hostile) m = Math.trunc((m * savingThrow({ element: a.element, target: targetDefence(t), rng })) / 100);
    if (m <= 0) return 0;
    if (a.objectCast || a.reflected) return applyPool(null, t, a.pool, a.sign * m, { name: a.casterName });
    if (a.casterEntityId) {
      const src = ctx.entities.get(a.casterEntityId);
      if (a.hostile && t.kind === 'entity' && (!src || !services.monsterOpponents?.(src, t.ref))) return null;
      return applyPool(null, t, a.pool, a.sign * m, src ?? { kind: 'monster', name: a.casterName });
    }
    const caster = ctx.players.get(a.casterId) ?? null;
    return applyPool(caster, t, a.pool, a.sign * m);
  }

  // ---------- rounds ----------

  function tickTarget(t, list, events) {
    const keep = [];
    for (const a of list) {
      if (a.sign) {
        const caster = a.casterEntityId ? ctx.entities.get(a.casterEntityId) : ctx.players.get(a.casterId);
        if (a.hostile && !caster && !a.casterEntityId) continue; // effects end when their caster leaves the world
        let d;
        try {
          d = roundAmount(a, t);
        } catch (err) {
          continue; // e.g. the caster left the location or the target can no longer be harmed: the effect ends
        }
        if (d) events.push({ kind: 'magicEffect', targetId: t.id, target: t.name, key: a.key, name: a.name, pool: a.pool, amount: Math.abs(d), sign: a.sign, casterId: a.casterId });
        if (t.kind === 'entity' && !alive(t.ref)) return [];
      }
      // Item effects are always ticked and never run out; the enchanting feature removes them on unequip.
      if (a.bundleType === 'held' && a.source?.itemId) { keep.push(a); continue; }
      a.roundsLeft -= 1;
      if (a.roundsLeft > 0) keep.push(a);
      else events.push({ kind: 'magicExpired', targetId: t.id, target: t.name, key: a.key, name: a.name, spellName: a.spellName });
    }
    return keep;
  }

  function magicRound() {
    for (const p of ctx.players.values()) {
      if (!p.rpg) continue;
      const m = magicOf(p);
      if (grantStarting(p)) ctx.dirty?.(p);
      if (!m.active.length) continue;
      const events = [];
      m.active = tickTarget(asPlayerTarget(p), m.active, events);
      ctx.dirty?.(p);
      for (const ev of events) ctx.notify?.(p, ev);
      if (events.some((ev) => ev.kind === 'magicExpired')) updateDetection(p);
    }
    for (const [id, list] of [...entityEffects]) {
      const e = ctx.entities.get(id);
      if (!alive(e)) { entityEffects.delete(id); continue; }
      const events = [];
      const keep = tickTarget(asEntityTarget(e), list, events);
      if (keep.length && alive(e)) entityEffects.set(id, keep);
      else entityEffects.delete(id);
      for (const ev of events) {
        for (const p of ctx.players.values()) if (loc(p) === e.location && seenBy(e, p)) ctx.notify?.(p, ev);
      }
    }
  }

  function updateDetection(p) {
    if (!p.rpg?.character || p.arriving) return;
    const status = statusesOf(asPlayerTarget(p));
    const detection = !p.rpg.defeated && p.rpg.character.health > 0 && (status.detectEnemy || status.detectMagic || status.detectTreasure);
    const before = lastDetection.get(p);
    if (!detection && !before) return;
    const location = loc(p);
    const markers = [];
    if (detection) {
      const at = position(p, location);
      for (const [id, thing] of ctx.entities) {
        if (thing.location !== location || !seenBy(thing, p) || !Number.isFinite(thing.x) || !Number.isFinite(thing.z)) continue;
        const pos = position(thing, location);
        if (!nearOnFloor(at, pos)) continue;
        const enemy = status.detectEnemy && thing.kind === 'monster' && alive(thing);
        const treasure = status.detectTreasure && (thing.kind === 'loot' && thing.count > 0 || thing.lootable ||
          thing.kind === 'container' && thing.containerType === 'treasure' && !thing.empty);
        const magic = status.detectMagic && alive(thing) && entityEffects.has(id);
        if (enemy || treasure || magic) markers.push({ id, ...pos, kind: enemy ? 'enemy' : treasure ? 'treasure' : 'item', label: thing.name });
      }
      if (status.detectMagic) {
        for (const t of playersAt(location, p)) {
          const pos = position(t.ref, location);
          if (nearOnFloor(at, pos) && activeOf(t).some((a) => a.roundsLeft > 0)) markers.push({ id: t.id, ...pos, kind: 'item', label: t.name });
        }
      }
    }
    const key = JSON.stringify([location, markers]);
    if (before !== key) {
      ctx.onRollback?.(() => before ? lastDetection.set(p, before) : lastDetection.delete(p));
      ctx.notify?.(p, { kind: 'spellDetection', location, markers, silent: true });
    }
    if (detection) lastDetection.set(p, key);
    else lastDetection.delete(p);
  }

  // ---------- casting ----------

  function knownSpell(p, id) {
    const m = magicOf(p);
    const spellId = id ?? m.selected;
    if (!spellId) throw new Error('Select a spell in your spellbook first.');
    if (!m.known.includes(spellId)) throw new Error('That spell is not in your spellbook.');
    const spell = catalogue.spells.get(spellId) ?? vampireSpells.get(spellId) ?? customSpells(p).find((s) => s.id === spellId);
    if (!spell) throw new Error('That spell no longer exists in this world.');
    return spell;
  }

  function costsFor(p, spell) {
    if (spell.innate) return spell.baseCosts;
    const skills = p.rpg?.character?.skills ?? {};
    return spellCosts(spell, (school) => services.skillValue?.(p, school) ?? skills[school] ?? 0);
  }

  function castingBlocker(p) {
    const c = p.rpg?.character;
    if (!c) throw new Error('Create your character before casting.');
    if (typeof c.health === 'number' && c.health <= 0) throw new Error('You cannot cast while dead.');
    const st = statusesOf(asPlayerTarget(p));
    if (st.silenced) throw new Error('You have been silenced and cannot cast.');
    if (st.paralyzed && !st.freeAction) throw new Error('You are paralyzed.');
    const inv = p.rpg.inventory ?? [];
    for (const itemId of Object.values(p.rpg.equipment ?? {})) {
      const item = inv.find((i) => i.id === itemId);
      if (item?.noSpellcasting || item?.blocksSpellcasting) throw new Error(`${item.name} prevents spellcasting.`);
    }
    const veto = services.canCast?.(p);
    if (typeof veto === 'string' && veto) throw new Error(veto);
    const magery = services.characterMagery?.(p);
    if (magery?.blocked) throw new Error('Your magery is blocked here.');
  }

  function spellResult(cast, t) {
    const { caster, spell } = cast;
    const effects = t.banishOnly ? spell.effects.filter((effect) => effect.template.behaviour?.kind === 'banish') : spell.effects;
    if (!cast.free && spell.harmful && !t.self && caster !== t.ref &&
        effects.some((effect) => effect.template.behaviour?.kind !== 'banish')) {
      const roll = (status) => {
        const chance = wardChance(t, status);
        return chance > 0 && rng() * 100 < chance;
      };
      const mana = pool(t, 'magicka');
      const room = mana ? mana.max - mana.obj[mana.cur] : 0;
      if (cast.cost > 0 && room >= cast.cost &&
          (roll('spellAbsorption') || (t.kind === 'player' && (services.characterMagery?.(t.ref)?.absorbs ||
            services.enchantmentModifiers?.(t.ref)?.absorbSpells)))) {
        const amount = applyPool(null, t, 'magicka', cast.cost);
        return [{ targetId: t.id, target: t.name, outcome: 'applied', effect: 'SpellAbsorption', name: 'Spell absorbed', pool: 'magicka', amount, sign: 1 }];
      }
      if (!cast.reflected && !cast.object && roll('spellReflection')) {
        const reflectedTarget = cast.enemy ? asEntityTarget(caster) : asPlayerTarget(caster);
        const reflected = spellResult({ ...cast, reflected: true }, reflectedTarget);
        return [{ targetId: t.id, target: t.name, outcome: 'applied', effect: 'SpellReflection', name: 'Spell reflected' }, ...reflected];
      }
      if (roll('spellResistance')) return [{ targetId: t.id, target: t.name, outcome: 'saved', name: spell.name }];
    }
    const results = [];
    for (const effect of effects) {
      if (effect.template.behaviour?.kind === 'banish' && t.self) continue;
      if (t.kind === 'player' && (t.ref.rpg.defeated || t.ref.rpg.character?.health <= 0)) break;
      if (t.kind === 'entity' && !alive(t.ref)) break;
      results.push(applyEffect(cast, effect, t));
    }
    return results;
  }

  function castEvent(cast, event, targets = [], results = []) {
    const { caster, spell, location } = cast;
    const entry = {
      casterId: caster.id, casterName: caster.name, ...(cast.enemy ? { casterKind: 'monster' } : {}),
      spellId: spell.id, spellName: spell.name, element: spell.element,
      targetType: spell.targetType, icon: spell.icon, x: cast.start.x, y: cast.start.y, z: cast.start.z,
      yaw: cast.yaw, area: spell.targetType.startsWith('area'), ...event,
    };
    for (const viewer of ctx.players.values()) {
      const followsCaster = !cast.enemy && !cast.object && viewer === caster && event.kind === 'spellCast' && !event.missile;
      if ((loc(viewer) !== location && !followsCaster) || ((cast.enemy || cast.object) && !seenBy(caster, viewer))) continue;
      const targetIds = targets.filter((t) => t.kind === 'player' || seenBy(t.ref, viewer)).map((t) => t.id);
      const canSeeResult = (r) => r.targetId === `player:${viewer.id}` || targetIds.includes(r.targetId);
      const hits = results.filter((r) => r.outcome === 'applied' && canSeeResult(r))
        .map(({ targetId, effect, pool, amount, killed, status, banished }) =>
          ({ targetId, effect, pool, amount, killed, status, ...(banished ? { banished } : {}) }));
      const foundOnlyHidden = targets.length > 0 && !targetIds.length;
      const publicImpact = foundOnlyHidden ? { center: null, missed: true, ...(entry.reason ? { reason: 'range' } : {}) } : null;
      ctx.notify?.(viewer, { ...entry, ...publicImpact, targetIds, hits });
    }
  }

  function dispellableBundles(p) {
    const bundles = new Map();
    for (const a of magicOf(p).active) {
      if (a.bundleType && !['spell', 'held'].includes(a.bundleType)) continue;
      if (typeof a.spellId !== 'string' || a.spellId.startsWith('potion:') || NO_SPELL_ICON.has(a.key)) continue;
      // Artifact effects without a spell icon (MaceOfMolagBalEffect ShowSpellIcon = false) are not offered.
      if (a.showSpellIcon === false || a.key === 'MaceOfMolagBal') continue;
      if (!(a.roundsLeft >= 0 || a.source?.itemId)) continue;
      bundles.set(bundleIdOf(a), a);
    }
    return bundles;
  }

  function queueChoices(p, choices) {
    const before = pendingChoices.get(p);
    ctx.onRollback?.(() => {
      if (before) pendingChoices.set(p, before);
      else pendingChoices.delete(p);
    });
    if (!choices.length) {
      pendingChoices.delete(p);
      ctx.notify?.(p, { kind: 'spellChoiceClosed', silent: true });
      return;
    }
    const [choice, ...rest] = choices;
    const token = randomUUID();
    const options = choice.kind === 'createItem' ? [...CONJURED_EQUIPMENT] :
      [...dispellableBundles(p)].map(([id, a]) => [id, a.spellName ?? a.name]);
    pendingChoices.set(p, { choice, rest, token, location: loc(p), options });
    ctx.notify?.(p, {
      kind: 'spellEffectChoice', choice: choice.kind, token, silent: true,
      options: options.map(([, name], index) => ({ index, name })),
    });
  }

  function resolveChoice(p, { token, index, cancel } = {}) {
    if (services.conditionBeastForm?.(p)) throw new Error('You cannot cast spells in beast form.');
    const pending = pendingChoices.get(p);
    if (!pending || pending.token !== token || loc(p) !== pending.location || p.rpg.defeated || !(p.rpg.character?.health > 0)) {
      throw new Error('That spell choice has expired.');
    }
    const { choice, rest, options } = pending;
    if (cancel === true) {
      if (choice.kind === 'createItem') throw new Error('Choose an item to finish Create Item.');
      queueChoices(p, rest);
      return;
    }
    if (!Number.isInteger(index) || !options[index]) throw new Error('Choose an option from the spell.');
    const [id, name] = options[index];
    let message;
    if (choice.kind === 'createItem') {
      const minute = services.conjurationMinute?.(p);
      if (!Number.isSafeInteger(minute) || !services.giveItem) throw new Error('Your pack is unavailable.');
      const item = services.giveItem(p, id, id === 'arrow' ? 1 + Math.floor(rng() * 20) : 1,
        { extra: { conjuredUntil: minute + choice.rounds } });
      message = `You conjure ${item.name}.`;
    } else {
      const bundle = dispellableBundles(p).get(id);
      const selfCast = bundle && !bundle.objectCast && !bundle.casterEntityId && !bundle.reflected && bundle.casterId === p.id;
      if (!bundle) message = `${name} has already ended.`;
      else if (selfCast || rng() * 100 < choice.chance) {
        const target = asPlayerTarget(p);
        setActive(target, activeOf(target).filter((a) => bundleIdOf(a) !== id));
        // A dispelled CastWhenHeld bundle stays gone until the item is equipped again (package 16 powers).
        if (bundle.bundleType === 'held' && bundle.source?.itemId) ctx.emit?.('heldBundleDispelled', { player: p, itemId: bundle.source.itemId, bundleId: id });
        message = `${name} is dispelled.`;
      } else message = `You fail to dispel ${name}.`;
    }
    ctx.dirty?.(p);
    ctx.notify?.(p, { kind: 'spellResult', text: message });
    queueChoices(p, rest);
    updateDetection(p);
  }

  function finishCast(cast, targets, center, missed, projectile = null) {
    const { caster, spell, cost, enemy, object } = cast;
    const results = targets.flatMap((t) => spellResult(cast, t));
    for (const t of targets) if (t.kind === 'player') ctx.dirty?.(t.ref);
    castEvent(cast, {
      kind: projectile ? 'spellImpact' : 'spellCast', center, missed: !!missed,
      ...(projectile ? { missileId: projectile.id, reason: projectile.reason } : {}),
    }, targets, results);
    if (enemy || object) {
      for (const t of targets) {
        if (t.kind !== 'player') continue;
        const mine = results.filter((r) => r.targetId === t.id);
        ctx.notify?.(t.ref, { kind: 'spellResult', text: describeEnemy(caster, spell, mine), spellId: spell.id, results: mine, casterId: caster.id });
      }
    } else {
      ctx.notify?.(caster, { kind: 'spellResult', text: describe(spell, results, missed), spellId: spell.id, cost, results });
      if (cast.choices.length) queueChoices(caster, cast.choices);
      ctx.emit?.('spellCast', { player: caster, spell, targets: targets.map((t) => t.ref), results });
    }
    return { ok: true, cost, results };
  }

  function launch(cast, aimed) {
    const { spell, location, start } = cast;
    const id = ++missileSeq;
    // DaggerfallAction.CastSpell aims from the object's own position at the player's centre; the missile itself starts
    // 40 classic units (1 m) higher, so the two lines are parallel.
    const direction = directionFrom(cast.aimFrom ?? start, aimed ? (cast.aimAt ?? bodyPosition(aimed, location)) : null, cast.yaw, cast.pitch);
    const missile = { id, cast, direction, at: 0, attempts: 0 };
    if (ctx.afterCommit) ctx.afterCommit(() => missiles.add(missile));
    else missiles.add(missile);
    castEvent(cast, {
      kind: 'spellCast', missile: { id, direction, speed: opts.missileSpeed, range: opts.missileRange, location },
      center: null, missed: false,
    });
    return { ok: true, cost: cast.cost, results: [], pending: true, spell: publicSpell(spell) };
  }

  function spellCandidates(cast) {
    const { caster, location, enemy, object, spell } = cast;
    if (cast.monsterFight) return harmable(location).filter((e) => services.monsterOpponents?.(caster, e)).map(asEntityTarget);
    if (enemy || object) return playersAt(location, null).filter((t) => enemySpellCanReach(caster, t.ref));
    return spell.harmful ? monstersAt(location, caster) : playersAt(location, caster);
  }

  function enemySpellCanReach(caster, player) {
    return !caster._playerAlly && (caster._ally == null || caster._ally === player.id) && seenBy(caster, player);
  }

  function missileImpact(m, dt) {
    if (m.impact) return m.impact;
    const { cast, direction } = m;
    const { location, spell } = cast;
    const length = Math.min(opts.missileRange - m.at, Math.max(0, dt) * opts.missileSpeed);
    if (length <= 0) return null;
    const start = pointAt(cast.start, direction, m.at);
    // A trap's missile leaves the mechanism it was fired from (DFU spawns it inside the object's own collider).
    const blockedAt = obstructionDistance(start, direction, length, (a, b) => clearLine(location, a, b, cast.object ? cast.caster.mechanism ?? null : null));
    let at = blockedAt ?? length;
    let hit = null;
    const candidates = spellCandidates(cast);
    for (const target of candidates) {
      const dist = actorDistance(start, direction, at, bodyPosition(target, location), 0.75);
      if (dist !== null && (dist < at || (!hit && blockedAt === null && dist === at))) {
        at = dist;
        hit = target;
      }
    }
    m.at += at;
    const reason = hit ? 'actor' : blockedAt !== null ? 'wall' : m.at >= opts.missileRange ? 'range' : null;
    if (!reason) return null;
    const center = pointAt(start, direction, at);
    const targets = spell.targetType === 'areaAtRange' && reason !== 'range'
      ? inRadius(candidates, center, location) : hit ? [hit] : [];
    m.reason = reason;
    m.impact = { targets, center };
    return m.impact;
  }

  function tickMissiles(dt) {
    for (const m of missiles) {
      const { caster, enemy, object, location } = m.cast;
      let player = caster;
      if (enemy || object) {
        const witnesses = m.cast.monsterFight ? playersAt(location, null) : spellCandidates(m.cast);
        player = witnesses.find((t) => t.ref === m.cast.witness)?.ref ?? witnesses[0]?.ref;
      }
      const summonActive = caster._ally == null || (alive(caster) && loc(ctx.players.get(caster._ally) ?? {}) === location);
      if (!player || !summonActive || ctx.players.get(player.id) !== player || loc(player) !== location || (!enemy && !object && player.rpg?.defeated)) {
        castEvent(m.cast, { kind: 'spellImpact', missileId: m.id, center: null, reason: 'range', missed: true });
        missiles.delete(m);
        continue;
      }
      const impact = missileImpact(m, dt);
      if (!impact) continue;
      const run = () => {
        const candidates = new Set(spellCandidates(m.cast).map((t) => t.ref));
        const targets = impact.targets.filter((t) => candidates.has(t.ref));
        return finishCast(m.cast, targets, impact.center, !targets.length, m);
      };
      const done = ctx.runAtomic ? ctx.runAtomic(player, 'magic.impact', run) : run();
      if (done.ok || ++m.attempts >= 3) missiles.delete(m);
    }
  }

  function cast(p, args = {}, itemSpell = null) {
    if (!p.rpg) throw new Error('No character.');
    if (services.conditionBeastForm?.(p)) throw new Error('You cannot cast spells in beast form.');
    grantStarting(p);
    const spell = itemSpell ?? knownSpell(p, args.spellId);
    if (spell.support === 'unsupported') {
      const why = spell.effects.find((e) => e.template.reason)?.template.reason ?? 'unavailable';
      throw new Error(`${spell.name} cannot be cast in this world yet: ${why}.`);
    }
    const item = !!itemSpell;
    if (!item) castingBlocker(p);
    const c = p.rpg.character;
    if (!c || c.health <= 0 || p.rpg.defeated) throw new Error('You cannot cast while defeated.');
    const pending = pendingChoices.get(p);
    if (pending?.choice.kind === 'createItem' && pending.location === loc(p)) {
      if (item) throw new Error('Finish the current Create Item spell first.');
      queueChoices(p, [pending.choice, ...pending.rest]);
      return { ok: true, cost: 0, results: [] };
    }
    const now = ctx.now();
    const prevCd = cooldownUntil.get(p.id);
    if (!item && now < (prevCd ?? 0)) throw new Error('You are still recovering from your last spell.');
    const baseCost = costsFor(p, spell).magicka;
    const cost = item ? 0 : baseCost;
    const mana = c.magicka ?? 0;
    if (mana < cost) throw new Error(`You need ${cost} magicka to cast ${spell.name} (you have ${Math.floor(mana)}).`);
    if (spell.effects.some((e) => e.template.behaviour?.kind === 'recall')) {
      if (!['anchor', 'return'].includes(args.recall)) {
        ctx.notify?.(p, { kind: 'spellRecallChoice', spellId: spell.id, hasAnchor: !!magicOf(p).anchor, silent: true });
        return { ok: true, cost: 0, results: [] };
      }
    }
    if (spell.effects.some((e) => e.template.behaviour?.kind === 'identify')) {
      const items = services.unidentifiedItems?.(p) ?? [];
      if (!items.length) throw new Error('You carry no unidentified magic items.');
      if (!args.itemId) {
        ctx.notify?.(p, { kind: 'spellIdentifyChoice', spellId: spell.id, items: items.map(({ id, name }) => ({ id, name })), silent: true });
        return { ok: true, cost: 0, results: [] };
      }
      if (!items.some((i) => i.id === args.itemId)) throw new Error('Choose an unidentified item you carry.');
    }
    const location = loc(p);
    const start = position(p, location, 1.55);
    const { targets, center, missed, aimed } = resolveTargets(p, spell, args);
    if (!item) {
      ctx.onRollback?.(() => {
        if (prevCd === undefined) cooldownUntil.delete(p.id);
        else cooldownUntil.set(p.id, prevCd);
      });
      c.magicka = mana - cost;
      cooldownUntil.set(p.id, now + opts.cooldownMs);
      for (const eff of spell.effects) if (eff.template.support !== 'unsupported') services.advanceSkill?.(p, eff.template.school, 1);
    }
    if (spell.harmful) services.breakMagicConcealment?.(p);
    services.interruptRest?.(p, 'magic', 'You stop resting to cast a spell.');
    ctx.dirty?.(p);
    const castInfo = {
      caster: p, spell, cost, item, args, location, start, level: Math.max(1, c.level ?? 1),
      bundleId: randomUUID(), choices: [],
      yaw: aimYaw(p, args), pitch: Number.isFinite(args.pitch) ? Math.max(-1.45, Math.min(1.45, args.pitch)) : 0,
    };
    if (ranged(spell.targetType) && Number.isFinite(opts.missileSpeed)) return launch(castInfo, aimed);
    return finishCast(castInfo, targets, center, missed);
  }

  function describe(spell, results, missed) {
    if (missed) return `${spell.name} flies wide and hits nothing.`;
    if (!results.length) return `You cast ${spell.name}, but no one is in its area.`;
    const parts = [];
    for (const r of results) {
      const who = r.target;
      if (r.outcome === 'applied') {
        const over = r.rounds > 1 ? ` (first of ${r.rounds} rounds)` : '';
        if (r.message) parts.push(r.message.replace(/\.$/, ''));
        else if (r.pool && r.amount !== undefined && r.sign) {
          const gain = r.sign > 0;
          parts.push(`${who} ${gain ? 'regains' : 'loses'} ${r.amount} ${r.pool}${over}${r.transferred ? `; you gain ${r.transferred}` : ''}${r.killed ? ' and falls' : ''}`);
        } else if (r.killed) parts.push(`${who} is destroyed`);
        else if (r.rounds) parts.push(`${r.name} on ${who} for ${r.rounds} rounds`);
        else parts.push(`${r.name} on ${who}`);
      } else if (r.outcome === 'choice') parts.push(`choose an option for ${r.name}`);
      else if (r.outcome === 'saved') parts.push(`${who} resists ${r.name}`);
      else if (r.outcome === 'failed') parts.push(`${r.name} fails`);
      else if (r.outcome === 'noEffect') parts.push(`${r.name}: ${r.reason ?? 'no effect'}`);
      else if (r.outcome === 'unsupported') parts.push(`${r.name} is not supported (${r.reason})`);
    }
    return `You cast ${spell.name}: ${parts.join('; ') || 'nothing happens'}.`;
  }

  // ---------- actions ----------

  ctx.onJoin?.((p) => {
    if (!p.rpg) return;
    magicOf(p);
    grantStarting(p);
    ctx.notify?.(p, catalogueEvent(p));
    const anchor = magicOf(p).anchor;
    if (anchor) services.collision?.preload?.(anchor.location);
  });
  ctx.onLeave?.((p) => {
    cooldownUntil.delete(p.id);
    pendingChoices.delete(p);
  });
  ctx.on?.('connectionReset', ({ player }) => lastDetection.delete(player));
  ctx.on?.('locationChanged', ({ player }) => {
    const before = pendingChoices.get(player);
    if (!before) return;
    ctx.onRollback?.(() => pendingChoices.set(player, before));
    pendingChoices.delete(player);
  });

  ctx.onAction('magic.catalogue', (p) => {
    ctx.notify?.(p, catalogueEvent(p));
  });

  function spendGold(p, price, name) {
    if (price <= 0) return;
    const gold = services.goldOf?.(p) ?? p.rpg.gold ?? 0;
    if (gold < price) throw new Error(`${name} costs ${price} gold; you have ${gold}.`);
    if (services.takeGold) services.takeGold(p, price);
    else p.rpg.gold = gold - price;
  }

  function requireMaker(p, args) {
    if (!p.rpg?.character) throw new Error('Create your character first.');
    if (!services.requireNpcService) throw new Error('Visit a Spell Maker first.');
    const { guild, rank, factionId } = services.requireNpcService(p, args, 'makeSpells');
    if (guild === 'temple' && factionId === 497 && rank >= 6) return;
    if (guild === 'mages' && rank >= 0) return;
    throw new Error(guild === 'temple' ? 'The School of Kynareth requires rank 6 to make spells.' : 'Only Mages Guild members may make spells here.');
  }
  (services.npcServiceHandlers ??= {}).makeSpells = (p, { npcId, session }) => {
    const counter = { targetId: npcId, session };
    requireMaker(p, counter);
    ctx.notify?.(p, { kind: 'spellMaker', counter, effects: makerEffects, silent: true });
  };
  services.npcServiceHandlers.spells = (p, info) => {
    const counter = { targetId: info.npcId, session: info.session };
    const seller = services.requireNpcService?.(p, counter, 'spells') ?? info;
    ctx.notify?.(p, catalogueEvent(p, sellerMarket(p, seller)));
    ctx.notify?.(p, { kind: 'spellShop', counter, silent: true });
  };
  ctx.onAction('magic.make', (p, args) => {
    requireMaker(p, args);
    const m = magicOf(p);
    const spell = buildCustomSpell(args);
    if (m.custom.length >= 100) throw new Error('Remove a custom spell before making more.');
    if (m.custom.some((s) => s.name?.toLowerCase() === spell.name.toLowerCase())) throw new Error('Choose a name you have not used for another custom spell.');
    spendGold(p, spell.price, spell.name);
    m.custom.push(saveCustomSpell(spell));
    m.known.push(spell.id);
    m.selected = spell.id;
    ctx.dirty?.(p);
    ctx.notify?.(p, catalogueEvent(p));
    ctx.notify?.(p, { kind: 'spellLearned', spellId: spell.id, text: `${spell.name} is readied in your spellbook. You paid ${spell.price} gold.` });
  });

  ctx.onAction('magic.learn', (p, args = {}) => {
    const spell = catalogue.spells.get(String(args.spellId ?? ''));
    if (!spell || spell.hidden) throw new Error('No such spell.');
    const m = magicOf(p);
    if (m.known.includes(spell.id)) throw new Error(`You already know ${spell.name}.`);
    if (spell.support === 'unsupported') throw new Error(`${spell.name} cannot be cast in this world yet, so it is not for sale.`);
    if (!p.rpg.character) throw new Error('Create your character first.');
    const seller = requiresSeller() || args.targetId ? services.requireNpcService?.(p, args, 'spells') : null;
    const market = seller ? sellerMarket(p, seller) : null;
    const price = learningPrice(p, spell, market);
    if (args.expectCost !== undefined && args.expectCost !== price) {
      ctx.notify?.(p, catalogueEvent(p, market));
      ctx.notify?.(p, { kind: 'spellResult', text: `The current price for ${spell.name} is ${price} gold. Check the quote and confirm again.` });
      return;
    }
    spendGold(p, price, spell.name);
    m.known.push(spell.id);
    if (!m.selected) m.selected = spell.id;
    ctx.dirty?.(p);
    ctx.notify?.(p, { kind: 'spellLearned', spellId: spell.id, text: `${spell.name} has been added to your spellbook${price ? ` for ${price} gold` : ''}.` });
  });

  ctx.onAction('magic.forget', (p, args = {}) => {
    const m = magicOf(p);
    const id = String(args.spellId ?? '');
    if (!m.known.includes(id)) throw new Error('That spell is not in your spellbook.');
    if (vampireSpells.has(id)) throw new Error('You cannot forget a vampire spell.');
    m.known = m.known.filter((k) => k !== id);
    if (id.startsWith('custom:')) {
      m.custom = m.custom.filter((s) => s.id !== id);
      ctx.notify?.(p, catalogueEvent(p));
    }
    if (m.selected === id) m.selected = null;
    ctx.dirty?.(p);
  });

  ctx.onAction('magic.select', (p, args = {}) => {
    const m = magicOf(p);
    if (args.spellId === null) { m.selected = null; return; }
    const spell = knownSpell(p, String(args.spellId ?? ''));
    m.selected = spell.id;
    ctx.dirty?.(p);
  });

  ctx.onAction('magic.cast', (p, args = {}) => { cast(p, args); });
  ctx.onAction('magic.choose', resolveChoice);

  ctx.onTick?.((dt) => {
    tickMissiles(dt);
    detectionClock += dt;
    if (detectionClock >= 0.45) {
      detectionClock %= 0.45;
      for (const p of ctx.players.values()) updateDetection(p);
    }
    roundClock += dt * 1000;
    while (roundClock >= opts.roundMs) {
      roundClock -= opts.roundMs;
      magicRound();
    }
  });

  // ---------- services for other features ----------

  const targetOf = (x) => (x && ctx.players.get(x.id) === x ? asPlayerTarget(x) : x && x.kind ? asEntityTarget(x) : null);
  services.magicStatus = (x) => { const t = targetOf(x); return t ? statusesOf(t) : {}; };
  services.peerConcealment = (p) => {
    if (p.rpg?.defeated || !(p.rpg?.character?.health > 0)) return null;
    const { invisible, chameleon, shadow } = statusesOf(asPlayerTarget(p));
    return invisible ? 'invisible' : chameleon && shadow ? 'blending' : chameleon ? 'chameleon' : shadow ? 'shadow' : null;
  };
  services.magicAttributeModifier = (x, key) => {
    const t = targetOf(x);
    return t ? attributeModifier(t, key) : 0;
  };
  services.breakMagicConcealment = (p) => {
    const t = asPlayerTarget(p);
    const before = activeOf(t);
    const after = before.filter((e) => !CONCEALMENT.has(e.status) || e.key.endsWith('-True'));
    if (before.length === after.length) return;
    setActive(t, after);
    ctx.dirty?.(p);
  };
  services.takeDoorMagic = (p, operation) => {
    const m = magicOf(p);
    const op = operation ?? (m.door?.lock ? 'lock' : 'open');
    const level = m.door?.[op];
    if (!level) return null;
    delete m.door[op];
    if (!m.door.open && !m.door.lock) delete m.door;
    ctx.dirty?.(p);
    return { operation: op, level };
  };

  function soulPoints(e, id) {
    return (Number.isInteger(id) && id >= 0 && id < 128 && !e._m?.human && e._ally == null)
      ? ENEMY_EXTRAS[id]?.soul ?? 0 : null;
  }
  services.onMonsterLethalHit = (_killer, e) => {
    const t = asEntityTarget(e);
    const traps = activeOf(t).filter((effect) => effect.status === 'soulTrapped');
    const id = e.monsterId ?? e._m?.id;
    const points = soulPoints(e, id);
    if (points === null) return;
    for (const trap of traps) {
      const owner = ctx.players.get(trap.casterId);
      if (!owner || loc(owner) !== e.location || owner.rpg?.defeated || (owner.rpg?.character?.health ?? 0) <= 0) continue;
      if (rng() * 100 >= trap.chance) {
        ctx.notify?.(owner, { kind: 'soulTrap', text: `The ${e.name}'s soul escapes.` });
        continue;
      }
      const result = services.captureSoul?.(owner, { id, name: e.name, points });
      if (!result?.captured) {
        ctx.notify?.(owner, { kind: 'soulTrap', text: 'You need an empty soul gem. The trapped creature clings to life.' });
        return false;
      }
      ctx.notify?.(owner, { kind: 'soulTrap', text: `You captured the ${e.name}'s soul.` });
      break;
    }
    if (traps.length) setActive(t, activeOf(t).filter((effect) => effect.status !== 'soulTrapped'));
  };
  services.magicModifiers = (p) => {
    const out = { attributes: {}, shield: 0 };
    for (const [key, amount] of Object.entries(magicOf(p).attributeDamage ?? {})) out.attributes[key] = -amount;
    for (const a of magicOf(p).active) {
      if (a.attribute) out.attributes[a.attribute] = (out.attributes[a.attribute] ?? 0) + a.amount;
      if (a.shield) out.shield += a.shield;
    }
    return out;
  };
  /** Shield absorbs incoming damage; returns the damage that gets through. */
  services.absorbDamage = (x, amount) => {
    const t = targetOf(x);
    if (!t) return amount;
    let left = amount;
    const list = activeOf(t).flatMap((a) => {
      if (!a.shield || left <= 0) return [a];
      const used = Math.min(a.shield, left);
      left -= used;
      const shield = a.shield - used;
      return shield > 0 ? [{ ...a, shield }] : [];
    });
    if (left < amount) {
      setActive(t, list);
      if (t.kind === 'player') ctx.dirty?.(t.ref);
    }
    return left;
  };
  services.knownSpells = (p) => [...magicOf(p).known];

  // ---------- enemy casters (combat feature) ----------

  /** SPELLS.STD spell by classic standard index, as an enemy would cast it, or null. */
  const enemySpell = (index) => {
    const sp = catalogue.spells.get(`std:${index}`);
    return sp && sp.origin === 'SPELLS.STD' && sp.support !== 'unsupported' ? sp : null;
  };
  /**
   * CastWhenHeld equip charge: FormulaHelper.CalculateCastingCost(spell, enchantingItem: false) on the raw SPELLS.STD
   * record, with the wearer's live school skills. null when the spell or its record is unavailable.
   */
  services.heldSpellCharge = (p, index) => {
    const spell = enemySpell(index);
    if (!spell?.classic) return null;
    const skills = p?.rpg?.character?.skills ?? {};
    return classicCastingCost(spell.classic, (school) => services.skillValue?.(p, school) ?? skills[school] ?? 0);
  };
  services.enemySpellInfo = (index) => {
    const sp = enemySpell(index);
    return sp ? { id: sp.id, name: sp.name, targetType: sp.targetType, harmful: sp.harmful, element: sp.element, baseCost: spellCosts(sp, () => 0).magicka } : null;
  };

  function hostileCast(caster, index, target, { level = caster?.level ?? 1, free = false, object = false } = {}) {
    const spell = enemySpell(index);
    if (!spell || !caster || (!object && !alive(caster))) return null;
    const self = asEntityTarget(caster);
    if (!object) {
      const status = statusesOf(self);
      if (status.silenced || status.paralyzed) return null;
    }
    const location = caster.location;
    const monsterFight = !object && !!target?._m;
    const tp = monsterFight ? (services.monsterOpponents?.(caster, target) ? asEntityTarget(target) : null)
      : target && ctx.players.get(target.id) === target && loc(target) === location && enemySpellCanReach(caster, target)
        ? asPlayerTarget(target) : null;
    const tt = spell.targetType;
    if ((tt !== 'caster' || object) && !tp) return null;
    const probe = tt === 'caster' && !object ? self : tp;
    const lasting = spell.effects.filter((eff) => eff.template.duration);
    if (lasting.length && lasting.every((eff) => activeOf(probe).some((a) => a.key === eff.template.key))) return null;
    const cost = free ? 0 : costsFor(target ?? {}, spell).magicka;
    if (cost && !(caster.magicka >= cost)) return null;
    // Objects: DaggerfallAction.CastSpell starts the missile at the action object's position + 40 units (1 m).
    const start = object && Number.isFinite(caster.y) ? { x: caster.x, y: caster.y + 1, z: caster.z } : position(caster, location, object ? 0.15 : 1.25);
    // DaggerfallAction.CastSpell: an object's Touch payload becomes SingleTargetAtRange (no touch reach check).
    if (tt === 'touch' && !object && (distance(start, bodyPosition(tp, location)) > opts.touchRange ||
      !touchable(caster, tp, location))) return null;
    if (cost) {
      ctx.touchEntity?.(caster);
      caster.magicka -= cost;
    }
    const witness = monsterFight ? ctx.players.get(caster._ally ?? target._ally) : target;
    const cast = { caster, spell, cost, free: free && !object, enemy: !object, object, monsterFight, witness, args: {}, location, bundleId: randomUUID(),
      start, level: Math.max(1, Math.trunc(level) || 1), yaw: caster.yaw ?? 0 };
    if (object && Number.isFinite(caster.y)) {
      cast.aimFrom = { x: caster.x, y: caster.y, z: caster.z };
      cast.aimAt = position(tp.ref, location, 0.9); // the player's transform: the capsule's centre
    }
    if (ranged(tt) && Number.isFinite(opts.missileSpeed)) return launch(cast, tp);
    let targets;
    let center = start;
    if (tt === 'caster') targets = [{ ...(object ? tp : self), self: true }];
    else if (tt === 'areaAroundCaster') targets = inRadius(spellCandidates(cast), start, location);
    else {
      center = bodyPosition(tp, location);
      targets = tt === 'areaAtRange' ? inRadius(spellCandidates(cast), center, location) : [tp];
    }
    const result = finishCast(cast, targets, center, false);
    return { ...result, spell: publicSpell(spell) };
  }

  services.enemyCast = (caster, index, target, opts) => hostileCast(caster, index, target, opts);
  services.drainMonsterFatigue = (target, amount) => applyPool(null, asEntityTarget(target), 'fatigue', -amount);
  services.objectCast = (caster, index, target, opts) => hostileCast(caster, index, target, { ...opts, object: true, free: true });
  services.castItemSpell = (p, index, args = {}, { itemName = 'The item' } = {}) => {
    const spell = enemySpell(index);
    if (!spell) throw new Error(`${itemName} has no usable spell.`);
    if (spell.effects.some((e) => e.template.behaviour?.kind === 'recall') && !args.recall) throw new Error('Choose whether to set a Recall anchor or return to it.');
    if (spell.effects.some((e) => e.template.behaviour?.kind === 'identify') && !args.itemId) throw new Error('Choose an item to identify.');
    return cast(p, args, spell);
  };

  // ---------- enchanted items (package 16 consumers) ----------

  /**
   * CastWhenHeld: the item's SPELLS.STD spell lands on the wearer as a 'held' bundle tagged with the item id. It never
   * runs out; endItemEffects removes it when the item is unequipped, dropped or broken. Returns the cast result, or
   * null when the spell is unknown here or does not target the caster (every classic CastWhenHeld spell does).
   */
  services.castHeldItemSpell = (p, index, { itemId, itemName = 'The item' } = {}) => {
    const spell = enemySpell(index);
    if (!spell || !p?.rpg || spell.targetType !== 'caster' || typeof itemId !== 'string') return null;
    const location = loc(p);
    const start = position(p, location, 1.55);
    const cast = { caster: p, spell, cost: 0, item: true, held: { itemId, itemName: String(itemName).slice(0, 40) }, args: {}, location, start,
      level: Math.max(1, p.rpg.character?.level ?? 1), bundleId: `held:${itemId}:${index}`, choices: [], yaw: p.yaw ?? 0, pitch: 0 };
    return finishCast(cast, [{ ...asPlayerTarget(p), self: true }], start, false);
  };
  /** Held bundles currently granted by `itemId` (or by any item when omitted). */
  services.itemEffects = (p, itemId) => magicOf(p).active.filter((a) => a.bundleType === 'held' && a.source?.itemId &&
    (itemId === undefined || a.source.itemId === itemId)).map((a) => ({ ...a }));
  /** Remove every held bundle of `itemId` (predicate form: (itemId) => boolean). Returns the number removed. */
  services.endItemEffects = (p, itemId) => {
    const m = magicOf(p);
    const match = typeof itemId === 'function' ? itemId : (id) => id === itemId;
    const keep = m.active.filter((a) => !(a.bundleType === 'held' && a.source?.itemId && match(a.source.itemId)));
    const removed = m.active.length - keep.length;
    if (removed) {
      m.active = keep;
      ctx.dirty?.(p);
      updateDetection(p);
    }
    return removed;
  };
  /** CastWhenStrikes: the item's spell is assigned to the struck monster, saving throws apply (AssignBundle). */
  services.castStrikeSpell = (p, index, target, { itemName = 'The weapon' } = {}) => {
    const spell = enemySpell(index);
    if (!spell || !p?.rpg || !alive(target) || target.location !== loc(p)) return null;
    const location = loc(p);
    const start = position(p, location, 1.25);
    const cast = { caster: p, spell, cost: 0, item: true, free: true, args: {}, location, start, itemName,
      level: Math.max(1, p.rpg.character?.level ?? 1), bundleId: randomUUID(), choices: [], yaw: p.yaw ?? 0, pitch: 0 };
    return finishCast(cast, [asEntityTarget(target)], bodyPosition(asEntityTarget(target), location), false);
  };
  /** FormulaHelper.SavingThrow(element, flags, target, 0): percent of the effect that lands (0 = fully resisted). */
  services.magicSavingThrow = (x, element = 'magic') => {
    const t = targetOf(x);
    return t ? savingThrow({ element, target: targetDefence(t), rng }) : 100;
  };
  /** Drain (positive) or restore (negative) a magical attribute loss on a player or monster. Returns the change. */
  services.changeMagicAttributeDamage = (x, key, delta) => {
    const t = targetOf(x);
    return t ? changeAttributeDamage(t, key, Math.trunc(delta) || 0) : 0;
  };

  function describeEnemy(caster, spell, results) {
    const parts = [];
    for (const r of results) {
      if (r.outcome === 'applied') {
        if (r.pool && r.sign < 0) parts.push(`you lose ${r.amount} ${r.pool}`);
        else if (r.status) parts.push(`you are ${r.status}`);
        else parts.push(r.name);
      } else if (r.outcome === 'saved') parts.push(`you resist ${r.name}`);
    }
    return `The ${caster.name} casts ${spell.name}${parts.length ? `: ${parts.join('; ')}` : ''}.`;
  }
  services.teachSpell = (p, spellId) => {
    const spell = catalogue.spells.get(spellId);
    if (!spell) throw new Error('No such spell.');
    const m = magicOf(p);
    if (!m.known.includes(spellId)) m.known.push(spellId);
    ctx.dirty?.(p);
  };
  services.setVampireSpells = (p, indices) => {
    const m = magicOf(p);
    const desired = new Set();
    let catalogueChanged = false;
    for (const index of indices) {
      const source = catalogue.spells.get(`std:${index}`);
      if (!source) continue;
      const id = `vampire:${index}`;
      if (!vampireSpells.has(id)) {
        vampireSpells.set(id, {
          ...source, id, hidden: true, innate: 'vampire', baseCosts: { ...source.baseCosts, magicka: CAST_COST_FLOOR },
        });
        catalogueChanged = true;
      }
      desired.add(id);
    }
    const isVampireSpell = (id) => typeof id === 'string' && id.startsWith('vampire:');
    const owned = m.known.filter(isVampireSpell);
    const ownedChanged = owned.length !== desired.size || owned.some((id) => !desired.has(id));
    if (ownedChanged) {
      ctx.dirty?.(p);
      m.known = m.known.filter((id) => !isVampireSpell(id)).concat([...desired]);
      if (m.selected && !m.known.includes(m.selected)) m.selected = null;
    }
    if (ownedChanged || catalogueChanged) ctx.notify?.(p, catalogueEvent(p));
  };

  return { catalogue, cast, magicRound, entityEffects, options: opts };
}
