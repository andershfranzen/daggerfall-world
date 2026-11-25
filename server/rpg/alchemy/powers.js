// Enchantment and artifact power consumers (package 16). Installed by server/rpg/alchemy.js.
//
// Behaviour follows Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), read from
// Assets/Scripts/Game/MagicAndEffects/Effects/{Enchanting,Special}/*.cs and EntityEffectManager.cs:
//   CastWhenHeld   spell bundle on equip (item loses the casting cost), recast free every 6 game hours, lowered
//                  1 condition every 4 magic rounds (60 while resting); bundle ends on unequip, drop or break
//   Held           Strengthens/Weakens Armor (one -5/+5 armour modifier each, never stacked), EnhancesSkill +15,
//                  RegensHealth 1 HP / 4 rounds (always / sunlight / darkness), RepairsObjects 1 point / 4 rounds
//                  on one damaged unenchanted item, ItemDeteriorates 1 / 4 rounds (always / sunlight / holy
//                  places), UserTakesDamage 1 HP / 4 rounds (sunlight / holy places), AbsorbsSpells,
//                  GoodRepWith / BadRepWith ±10 reaction, Masque of Clavicus Personality/5 reaction to all groups
//   Strikes        PotentVs +5 / LowDamageVs -5 by MobileAffinity, CastWhenStrikes (spell on target, 10 wear),
//                  Mehrunes' Razor (failed save: slain, wear = health removed), Wabbajack (transform into another
//                  creature, damage carried over, once per creature, never a live quest foe), Mace of Molag Bal
//                  (failed save: drain magicka into the wielder, or 1-6 Strength moved to the wielder for 12 minutes)
//   Struck         Ring of Namira reflects melee damage (Daedra half, Undead double, beasts none)
//   Used           Sanguine Rose (allied Daedroth), Skull of Corruption (allied copy of the nearest enemy); both
//                  need a hostile monster within 12 m and cost 100 condition
//   Hircine Ring   reported through wearsArtifact(); conditions owns the lycanthropy rules it changes
//   Item Maker     VampiricEffect (at range: 1 HP from each enemy within 2.25 m every 4 rounds; when strikes: heal
//                  the strike's damage), HealthLeech (whenever used: 8 HP per strike, 16 per use; unless used
//                  daily/weekly: 1 HP every 4 rounds once the item has gone unused that long), ExtraSpellPts (+75
//                  maximum spell points by season, moon phase or creatures within 18 m), ImprovesTalents (stronger
//                  Acute Hearing / Athleticism / Adrenaline Rush when the career has them), BadReactionsFrom (-5 to
//                  hit while such a creature is within 8 m; its armour call passes -5 to SetDecreasedArmorValueModifier,
//                  which keeps only larger values, so armour is unchanged)
//   Mace max SP    drained spell points beyond the maximum raise MaxMagickaModifier until 12 minutes after a strike
//   SoulBound      the soul's forced enchantments (SoulBound.MobileForcedEnchantmentSets) and its Breaks payload:
//                  the bound creature appears when the item breaks
import { isIndoors, dateFromMinutes, MINUTES_PER_DAY, DAYS_PER_WEEK } from '../../../client/gameplay/atmosphere/calendar.js';
import { lunarPhase } from '../../../client/gameplay/conditions/rules.js';
import { SKILLS } from '../../../client/gameplay/character/rules.js';
import { allowanceMultiplier } from '../../../client/gameplay/inventory/weight.js';

export const ROUND_MS = 5000; // one magic round (magic.js opts.roundMs)
export const HELD_REROLL_MINUTES = 6 * 60; // EntityEffectManager.rerollMinimumHours
export const HELD_DEGRADE_ROUNDS = 4; // CastWhenHeld.normalMagicItemDegradeRate
export const HELD_DEGRADE_ROUNDS_RESTING = 60; // CastWhenHeld.restingMagicItemDegradeRate
export const PER_ROUNDS = 4; // RegensHealth / RepairsObjects / ItemDeteriorates / UserTakesDamage
export const STRIKE_WEAR = 10; // CastWhenStrikes.durabilityLossOnStrike
export const USED_WEAR = 100; // SanguineRoseEffect / SkullOfCorruptionEffect durabilityLoss
export const MACE_ROUNDS = 12; // MaceOfMolagBalEffect.maxIncreaseRounds (classic minutes)
export const VAMPIRIC_RANGE = 2.25; // VampiricEffect.vampiricDrainRange
export const LEECH_STRIKE = 8; // HealthLeech.leechWeaponAmount
export const LEECH_USE = 16; // HealthLeech.leechCastAmount
export const EXTRA_SPELL_POINTS = 75; // ExtraSpellPts maxIncrease
export const EXTRA_SPELL_RANGE = 18; // ExtraSpellPts.nearbyRadius
export const BAD_REACTION_RANGE = 8; // BadReactionsFrom.nearbyRange
export const BAD_REACTION_TO_HIT = -5; // BadReactionsFrom.decreaseHitChanceValue
const SEASONS = ['Winter', 'Spring', 'Summer', 'Fall'];
/** ImprovesTalents params -> career advantage keys. */
export const TALENTS = Object.freeze(['acuteHearing', 'athleticism', 'adrenalineRush']);

/** SpecialArtifactEffect params (ArtifactsSubTypes). */
export const SPECIAL = Object.freeze({
  masque: 0, razor: 1, mace: 2, hircine: 3, rose: 4, oghma: 5, wabbajack: 6, namira: 7, skull: 8, azura: 9,
});

/** WabbajackEffect.careerIDs. */
export const WABBAJACK_FORMS = Object.freeze([0, 1, 2, 3, 4, 6, 10, 13, 15, 16, 17, 20, 36, 37, 38, 35, 32]);
// EnemyBasics teams used by RingOfNamiraEffect: Vermin, Spriggans, Bears, Tigers, Spiders, Scorpions take nothing back.
const NAMIRA_IMMUNE = new Set([0, 3, 2, 4, 5, 6, 20]);
const TEAM_DAEDRA = new Set([25, 26, 27, 29, 31]);
const TEAM_UNDEAD = new Set([15, 17, 18, 19, 23, 28, 30, 32, 33]);
const DAEDROTH = 27;
// FormulaHelper.GetEnemyEntityEnemyGroup by monster career. DFU passes a class enemy's class index (ID - 128) into
// the same switch; this world counts class enemies as Humanoid, like PlayerGPS counts civilians.
const ENEMY_GROUP = new Map([
  ...[0, 3, 4, 5, 6, 11, 20, 34, 39, 40].map((id) => [id, 'animal']),
  ...[1, 2, 7, 8, 9, 10, 12, 13, 14, 16, 21, 22, 24, 41, 42].map((id) => [id, 'human']),
  ...[15, 17, 18, 19, 23, 28, 30, 32, 33].map((id) => [id, 'undead']),
  ...[25, 26, 27, 29, 31].map((id) => [id, 'daedra']),
]);
/** PlayerGPS nearby-object group of an entity: 'undead' | 'daedra' | 'human' | 'animal' | null. */
export function creatureGroup(e) {
  if (e?.kind === 'npc') return e.mobile ? 'human' : null; // GetActiveCivilianMobileBehaviours
  const id = e?._m?.id;
  if (!Number.isInteger(id)) return null;
  if (e._m.human || id >= 128) return 'human';
  return ENEMY_GROUP.get(id) ?? null;
}

/**
 * SoulBound.MobileForcedEnchantmentSets: soul (MobileTypes) -> [[type, param]…] added to the item with their own
 * costs; positive costs count as powers, negative ones as side effects.
 */
export const FORCED_BY_SOUL = Object.freeze({
  31: [[4, 1], [17, 1], [23, -1]], // Daedra Lord: Potent Vs Daedra, takes damage in holy places, extra weight
  29: [[14, 5], [16, 1], [17, 1], [21, 2], [22, 1]], // Daedra Seducer
  27: [[20, 1], [22, 2], [16, 2]], // Daedroth
  35: [[0, 12]], // Fire Atronach: Cast When Used Resist Fire
  26: [[10, 9], [0, 12], [22, 1]], // Fire Daedra: Enhances Daedric
  25: [[10, 9], [0, 11], [16, 2]], // Frost Daedra
  18: [[11, -1], [16, 2], [20, 0]], // Ghost
  32: [[10, 22], [16, 1], [20, 0]], // Lich: Enhances Destruction
  23: [[5, 2], [16, 2], [20, 0]], // Wraith
});

// GoodRepWith / BadRepWith params -> the conversation social groups (server/rpg/npcs/talk.js).
const REP_GROUPS = ['commoners', 'merchants', 'learned', 'nobility', 'underworld'];

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

/** MobileAffinity match for PotentVs / LowDamageVs params (Undead, Daedra, Humanoid, Animals). */
export function affinityMatches(target, param) {
  const m = target?._m;
  const human = !!(m?.human || (Number.isInteger(m?.id) && m.id >= 128));
  const affinity = human ? 'human' : String(target?.affinity ?? m?.affinity ?? '').toLowerCase();
  return affinity === ['undead', 'daedra', 'human', 'animal'][param];
}

/** Damage the Ring of Namira returns to a melee attacker (RingOfNamiraEffect), 0 for beasts. */
export function namiraReflection(monsterId, damage) {
  if (NAMIRA_IMMUNE.has(monsterId)) return 0;
  if (TEAM_DAEDRA.has(monsterId)) return Math.trunc(damage / 2);
  if (TEAM_UNDEAD.has(monsterId)) return damage * 2;
  return damage;
}

export function installPowers(ctx, { services, rng, say, itemOf, useCharge, spellName }) {
  const S = services;
  const enchanted = (it) => it?.magic?.enchantments?.length > 0;
  const equippedIds = (p) => new Set(Object.values(p.rpg?.equipment ?? {}).filter(Boolean));
  /** Equipped enchanted items still holding charges (DFU only runs payloads for unbroken equipped items). */
  const equippedMagic = (p) => {
    const ids = equippedIds(p);
    return (p.rpg?.inventory ?? []).filter((i) => i && ids.has(i.id) && enchanted(i) && i.condition > 0);
  };
  const specialsOf = (it) => it.magic.enchantments.filter((e) => e.type === 26).map((e) => e.param);
  const wearsSpecial = (p, param) => equippedMagic(p).some((it) => specialsOf(it).includes(param));
  const minuteOf = (p) => Math.floor(S.playerMinutes?.(p) ?? S.worldClock?.()?.minutes ?? int(ctx.now?.()) / ROUND_MS);
  const character = (p) => p.rpg?.character ?? null;

  // ---- constant (held) modifiers ---------------------------------------------------------------
  function enchantmentModifiers(p) {
    const out = {
      armor: 0, weightAllowance: 0, skills: {}, potentVs: [], lowDamageVs: [], absorbSpells: false, regen: [], repairs: false,
      deteriorates: [], reputation: {}, spellPointsWhen: [], userTakesDamage: [], specials: [], heldSpells: [],
      vampiric: [], leech: [], talents: [], badReactions: [],
    };
    let strengthens = false;
    let weakens = false;
    for (const it of equippedMagic(p)) {
      for (const e of it.magic.enchantments) {
        switch (e.type) {
          case 1: out.heldSpells.push({ itemId: it.id, spell: e.param }); break;
          case 12: strengthens = true; break;
          case 24: weakens = true; break;
          case 7: out.weightAllowance = Math.max(out.weightAllowance, allowanceMultiplier(e.param)); break;
          case 10: out.skills[e.param] = (out.skills[e.param] ?? 0) + 15; break;
          case 4: if (it.equipped === 'rightHand') out.potentVs.push(e.param); break;
          case 20: if (it.equipped === 'rightHand') out.lowDamageVs.push(e.param); break;
          case 9: out.absorbSpells = true; break;
          case 5: out.regen.push(e.param); break;
          case 8: out.repairs = true; break;
          case 16: out.deteriorates.push({ itemId: it.id, param: e.param }); break;
          case 14: out.reputation[e.param] = (out.reputation[e.param] ?? 0) + 10; break;
          case 25: out.reputation[e.param] = (out.reputation[e.param] ?? 0) - 10; break;
          case 3: out.spellPointsWhen.push(e.param); break;
          case 17: out.userTakesDamage.push(e.param); break;
          case 26: out.specials.push(e.param); break;
          case 6: out.vampiric.push({ itemId: it.id, param: e.param }); break;
          case 21: out.leech.push({ itemId: it.id, param: e.param }); break;
          case 13: if (TALENTS[e.param] && !out.talents.includes(TALENTS[e.param])) out.talents.push(TALENTS[e.param]); break;
          case 22: out.badReactions.push(e.param); break;
          default: break;
        }
      }
    }
    // DaggerfallEntity.Set{In,De}creasedArmorValueModifier keep the strongest single value: never stacked.
    out.armor = (strengthens ? 5 : 0) - (weakens ? 5 : 0);
    return out;
  }

  function socialReactionModifier(p, group) {
    const m = enchantmentModifiers(p);
    const idx = REP_GROUPS.indexOf(group);
    let n = 0;
    for (const [param, amount] of Object.entries(m.reputation)) if (Number(param) === 5 || Number(param) === idx) n += amount;
    if (m.specials.includes(SPECIAL.masque)) {
      const per = S.effectiveAttribute?.(p, 'Personality') ?? character(p)?.attributes?.Personality ?? 50;
      n += Math.trunc(per / 5); // MasqueOfClavicusEffect: LivePersonality / 5 to every social group
    }
    return n;
  }

  function enchantmentSkillModifier(p, name) {
    const idx = SKILLS.indexOf(name);
    return idx < 0 ? 0 : enchantmentModifiers(p).skills[idx] ?? 0;
  }

  const wearsArtifact = (p, key) => equippedMagic(p).some((it) => it.magic.artifact === key);

  // ---- nearby creatures (PlayerGPS.GetNearbyObjects) ----------------------------------------------------
  function nearbyCreatures(p, range, { enemiesOnly = false } = {}) {
    const location = p.rpg?.location;
    if (!location) return [];
    const out = [];
    for (const e of ctx.entities?.values?.() ?? []) {
      if (!e || e.location !== location || Math.hypot(e.x - p.x, e.z - p.z) > range) continue;
      if (e.kind === 'monster') {
        if (!e._m || e.dead || !(e.hp > 0)) continue;
      } else if (enemiesOnly || e.kind !== 'npc' || !e.mobile) continue;
      out.push(e);
    }
    return out;
  }
  const groupNear = (p, group, range) => nearbyCreatures(p, range).some((e) => creatureGroup(e) === group);

  // ---- maximum spell points (DaggerfallEntity.MaxMagickaModifier) -------------------------------------
  /** ExtraSpellPts conditions: season 0-3, moon 4-6 (either moon), creatures 7-10 within 18 m. */
  function extraSpellPointsApply(p, param, date) {
    if (param >= 0 && param <= 3) return date.season === SEASONS[param];
    if (param >= 4 && param <= 6) {
      const phases = [lunarPhase(date, true), lunarPhase(date, false)];
      if (param === 4) return phases.includes('full');
      if (param === 5) return phases.some((x) => x === 'halfWane' || x === 'halfWax');
      return phases.includes('new');
    }
    const group = { 7: 'undead', 8: 'daedra', 9: 'human', 10: 'animal' }[param];
    return !!group && groupNear(p, group, EXTRA_SPELL_RANGE);
  }
  function maxMagickaModifier(p) {
    if (!p?.rpg?.inventory) return 0;
    const m = enchantmentModifiers(p);
    let n = 0;
    if (m.spellPointsWhen.length) {
      const date = dateFromMinutes(minuteOf(p));
      for (const param of m.spellPointsWhen) if (extraSpellPointsApply(p, param, date)) n += EXTRA_SPELL_POINTS;
    }
    for (const a of p.rpg.magic?.active ?? []) if (a?.key === 'MaceOfMolagBal') n += Math.max(0, int(a.maxMagicka));
    return n;
  }
  /** BadReactionsFrom: -5 per enchantment while its creature group is within 8 m (Humanoids, Animals, Daedra). */
  function enchantmentChanceToHit(p) {
    if (!p?.rpg?.inventory) return 0;
    let n = 0;
    for (const param of enchantmentModifiers(p).badReactions) {
      const group = ['human', 'animal', 'daedra'][param];
      if (group && groupNear(p, group, BAD_REACTION_RANGE)) n += BAD_REACTION_TO_HIT;
    }
    return n;
  }

  // ---- HealthLeech (timeHealthLeechLastUsed) ---------------------------------------------------------------
  const leechesOf = (it) => (it?.magic?.enchantments ?? []).filter((e) => e.type === 21);
  /** Minute the item was last enchanted, used or struck with. Items from before this record start counting now. */
  function leechClock(p, it) {
    if (!Number.isFinite(it.magic.leechAt)) { it.magic.leechAt = minuteOf(p); ctx.dirty?.(p); }
    return it.magic.leechAt;
  }
  function hurt(p, amount, name) {
    const c = character(p);
    if (!c || !(c.health > 0) || !(amount > 0)) return;
    if (S.hurtPlayerBy) S.hurtPlayerBy(p, amount, { name, source: 'enchantment' });
    else c.health = Math.max(0, c.health - amount);
    ctx.dirty?.(p);
  }
  /** Strikes / Used payloads: restart the leech clock; "whenever used" costs 8 HP per strike or 16 per use. */
  function leechTouch(p, it, context) {
    const list = leechesOf(it);
    if (!list.length) return;
    it.magic.leechAt = minuteOf(p);
    ctx.dirty?.(p);
    for (const e of list) if (e.param === 0) hurt(p, context === 'used' ? LEECH_USE : LEECH_STRIKE, it.name);
  }

  // ---- environment (PlayerEnterExit.IsPlayerInSunlight / IsPlayerInHolyPlace) -----------------------
  function environment(p) {
    const location = p.rpg?.location;
    const isNight = S.worldClock?.()?.isNight ?? false;
    const sunlight = !isIndoors(location) && !isNight;
    const holy = S.isHolyPlace?.(p) ?? (!!location?.startsWith?.('temple:') || S.portals?.into?.(location)?.meta?.buildingType === 14);
    return { sunlight, darkness: !sunlight, holy: !!holy };
  }

  // ---- CastWhenHeld lifecycle ------------------------------------------------------------------
  const heldOf = (it) => it.magic.enchantments.filter((e) => e.type === 1);
  /**
   * Equip charge: classic lowers the item by the casting cost of its last CastWhenHeld spell
   * (CastWhenHeld.InstantiateSpellBundle note), FormulaHelper.CalculateCastingCost(spell, false) with the wearer's
   * live skills. Recasts are free.
   */
  function castHeld(p, it, { charge }) {
    let cost = 0;
    for (const e of heldOf(it)) {
      const r = S.castHeldItemSpell(p, e.param, { itemId: it.id, itemName: it.name });
      if (r && charge) cost = Math.max(0, int(S.heldSpellCharge?.(p, e.param) ?? S.enemySpellInfo?.(e.param)?.baseCost));
    }
    it.magic.held = { at: minuteOf(p) };
    ctx.dirty?.(p);
    if (cost > 0) wear(p, it, cost);
  }
  /**
   * Bring held bundles in line with what is equipped: a newly equipped CastWhenHeld item casts (and pays) once,
   * an item worn for six game hours recasts for free, and every bundle whose item is no longer equipped and intact
   * ends. `restore` (join) recasts free when a saved item lost its bundle.
   */
  const syncing = new Set();
  function syncHeld(p, opts = {}) {
    if (!p?.rpg?.inventory || typeof S.castHeldItemSpell !== 'function' || syncing.has(p)) return;
    syncing.add(p); // casting wears the item, which reports inventoryChanged again
    try { syncHeldNow(p, opts); } finally { syncing.delete(p); }
  }
  function syncHeldNow(p, { restore = false }) {
    const live = equippedMagic(p);
    const liveIds = new Set(live.map((i) => i.id));
    for (const it of p.rpg.inventory) {
      if (it?.magic?.held && !liveIds.has(it.id)) { delete it.magic.held; ctx.dirty?.(p); }
    }
    S.endItemEffects?.(p, (id) => !liveIds.has(id));
    const minute = minuteOf(p);
    for (const it of live) {
      if (!heldOf(it).length) continue;
      const h = it.magic.held;
      if (!h) { castHeld(p, it, { charge: true }); continue; }
      // EntityEffectManager schedules a reroll only from a live held bundle, and a load restores only saved
      // bundles: once Dispel Magic removed the item's spells they stay gone until the item is equipped again.
      if (h.dispelled) continue;
      const liveBundles = S.itemEffects?.(p, it.id)?.length ?? 0;
      if (liveBundles && minute - int(h.at) >= HELD_REROLL_MINUTES) castHeld(p, it, { charge: false });
      else if (restore && !liveBundles) castHeld(p, it, { charge: false }); // a save from before held bundles were kept
    }
  }

  // ---- item wear and SoulBound breaks ----------------------------------------------------------------
  function spawnBoundSoul(p, item) {
    const soul = item?.magic?.enchantments?.find((e) => e.type === 15);
    if (!soul || typeof S.createEnemy !== 'function' || !p.rpg?.location) return null;
    const yaw = p.yaw ?? 0;
    try {
      const e = S.createEnemy(p.rpg.location, soul.param, p.x + Math.sin(yaw) * 2, p.z - Math.cos(yaw) * 2, { origin: 'soul-bound' });
      if (e) {
        S.provokeEnemy?.(e, p);
        say(p, `The ${e.name} bound in ${item.name} is released!`);
        ctx.emit?.('boundSoulReleased', { player: p, itemId: item.id, monsterId: soul.param, entityId: e.id });
      }
      return e;
    } catch {
      return null;
    }
  }
  /** Lower an item's condition; a broken enchanted item frees its bound soul and drops its held bundles. */
  function wear(p, it, amount) {
    if (!(amount > 0) || !it) return { broke: false };
    const snapshot = { ...it, magic: it.magic ? { ...it.magic } : undefined };
    const r = useCharge(p, it, Math.trunc(amount));
    if (r?.broke) {
      S.endItemEffects?.(p, it.id);
      spawnBoundSoul(p, snapshot);
    }
    return r ?? { broke: false };
  }
  // Breaks from ordinary combat wear (inventory.damageItem) release a bound soul too.
  if (typeof S.damageItem === 'function') {
    const damageItem = S.damageItem;
    S.damageItem = (p, itemId, amount = 1) => {
      const id = itemId === 'weapon' ? p.rpg?.equipment?.rightHand : itemId;
      const before = itemOf(p, id);
      const snapshot = before?.magic ? { ...before, magic: { ...before.magic } } : null;
      const broke = damageItem(p, itemId, amount);
      if (broke && snapshot) {
        S.endItemEffects?.(p, id);
        spawnBoundSoul(p, snapshot);
      }
      return broke;
    };
  }

  // ---- strikes ------------------------------------------------------------------------------
  function wabbajack(p, target) {
    if (!target || target.dead || !(target.hp > 0) || target._wabbajack || target._quest?.foe || target._ally != null) return null;
    if (typeof S.createEnemy !== 'function' || typeof S.banishMonster !== 'function') return null;
    const from = target._m?.id;
    const choices = WABBAJACK_FORMS.filter((id) => id !== from);
    const id = choices[Math.min(choices.length - 1, Math.floor(rng() * choices.length))];
    const lost = Math.max(0, int(target.maxHp) - int(target.hp));
    const next = S.createEnemy(target.location, id, target.x, target.z, { yaw: target.yaw, origin: 'wabbajack' });
    if (!next) return null;
    if (!S.banishMonster(target)) { S.banishMonster(next); return null; }
    next._wabbajack = true;
    next.hp = Math.max(1, int(next.maxHp) - lost);
    S.provokeEnemy?.(next, p);
    say(p, `The ${target.name} is transformed into a ${next.name}!`);
    ctx.emit?.('wabbajack', { player: p, from: target.id, to: next.id, monsterId: id });
    return next;
  }

  function maceStrike(p, it, target, damage) {
    const c = character(p);
    if (!c) return;
    const m = (p.rpg.magic ??= {});
    if (!Array.isArray(m.active)) m.active = [];
    const maceEntry = () => {
      const prev = m.active.find((a) => a.key === 'MaceOfMolagBal' && a.source?.itemId === it.id);
      if (prev) { prev.showSpellIcon = false; return prev; }
      const entry = {
        uid: `mace:${it.id}`, key: 'MaceOfMolagBal', name: 'Mace of Molag Bal', spellId: 'artifact:mace-of-molag-bal', spellName: 'Mace of Molag Bal',
        element: 'magic', casterId: p.id, casterName: p.name, roundsLeft: 1, totalRounds: 1, bundleType: 'held', source: { itemId: it.id, itemName: it.name },
        attribute: 'Strength', amount: 0, maxMagicka: 0, showSpellIcon: false,
      };
      m.active.push(entry);
      return entry;
    };
    const mp = Number(target.magicka);
    if (mp > 0) {
      // DecreaseMagicka(damage) on the victim; spell points past the wielder's maximum raise that maximum.
      const drained = Math.min(mp, damage);
      target.magicka = mp - drained;
      const before = Math.max(0, int(c.magicka));
      const max = Number.isFinite(c.maxMagicka) ? c.maxMagicka : before + drained;
      const overflow = before + drained - max;
      if (overflow > 0) {
        const entry = maceEntry();
        entry.maxMagicka = int(entry.maxMagicka) + overflow;
        c.maxMagicka = max + overflow;
      }
      c.magicka = before + drained;
      say(p, `The Mace of Molag Bal drains ${drained} spell points.`);
    } else {
      const amount = 1 + Math.floor(rng() * 6); // Random.Range(1, 7)
      S.changeMagicAttributeDamage?.(target, 'Strength', amount);
      const entry = maceEntry();
      entry.amount = int(entry.amount) + amount;
      say(p, `The Mace of Molag Bal drains ${amount} Strength.`);
    }
    it.magic.lastStrike = minuteOf(p);
    ctx.dirty?.(p);
  }

  /**
   * Weapon Strikes payloads in enchantment order. Returns {damage, after(result)} for combat, or null when the
   * weapon carries no strike power.
   */
  function enchantmentStrike(p, target, { itemId, damage: base } = {}) {
    const it = itemOf(p, itemId ?? p.rpg?.equipment?.rightHand);
    if (!enchanted(it) || !(it.condition > 0) || target?.kind !== 'monster' || !target._m) return null;
    let damage = int(base);
    let durability = 0;
    const after = [];
    for (const e of it.magic.enchantments) {
      if (e.type === 4 && affinityMatches(target, e.param)) damage += 5;
      else if (e.type === 20 && affinityMatches(target, e.param)) damage -= 5;
      else if (e.type === 2 && base > 0) {
        after.push(() => S.castStrikeSpell?.(p, e.param, target, { itemName: it.name }));
        durability += STRIKE_WEAR;
      } else if (e.type === 26 && e.param === SPECIAL.razor) {
        if (S.magicSavingThrow?.(target, 'magic') !== 0) {
          const removed = Math.max(0, int(target.hp));
          damage += removed;
          durability += removed;
          after.push(() => say(p, `Mehrunes' Razor slays the ${target.name}!`));
        }
      } else if (e.type === 26 && e.param === SPECIAL.wabbajack) {
        after.push((result) => { if (!result?.killed) wabbajack(p, target); });
      } else if (e.type === 26 && e.param === SPECIAL.mace && base > 0) {
        if (S.magicSavingThrow?.(target, 'magic') !== 0) {
          after.push(() => maceStrike(p, it, target, int(base)));
          durability += int(base);
        }
      } else if (e.type === 6 && e.param === 1 && base > 0) {
        // VampiricEffect when strikes: the wielder gains the strike's incoming damage.
        after.push(() => heal(p, int(base)));
      }
    }
    if (leechesOf(it).length) after.push(() => leechTouch(p, it, 'strikes'));
    if (!after.length && !durability && damage === int(base)) return null;
    return {
      damage,
      after(result) {
        for (const fn of after) fn(result);
        if (durability > 0 && itemOf(p, it.id)) wear(p, it, durability);
      },
    };
  }

  function heal(p, amount) {
    const c = character(p);
    if (!c || !(c.health > 0) || !(amount > 0) || !(c.health < c.maxHealth)) return;
    c.health = Math.min(c.maxHealth, c.health + amount);
    ctx.dirty?.(p);
  }
  /** A swing that reached the target for 0 damage still runs the weapon's Strikes payloads (HealthLeech). */
  function enchantmentContact(p, target, { itemId } = {}) {
    const it = itemOf(p, itemId ?? p.rpg?.equipment?.rightHand);
    if (!enchanted(it) || !(it.condition > 0) || target?.kind !== 'monster') return;
    if (leechesOf(it).length) leechTouch(p, it, 'strikes');
  }

  function enchantmentStruck(p, e, damage) {
    if (!(damage > 0) || !e?._m || e.dead || !wearsSpecial(p, SPECIAL.namira)) return 0;
    const id = e._m.human || e._m.id >= 128 ? 128 : e._m.id;
    const back = namiraReflection(id, Math.trunc(damage));
    if (back <= 0 || typeof S.damageEntity !== 'function') return 0;
    try {
      const r = S.damageEntity(p, e, back, { source: 'namira' });
      if (r?.damage > 0) say(p, `The Ring of Namira returns ${r.damage} damage to the ${e.name}.`);
      return r?.damage ?? 0;
    } catch {
      return 0;
    }
  }

  // ---- used artifacts ----------------------------------------------------------------------------
  /** SanguineRoseEffect / SkullOfCorruptionEffect. Returns a message, or undefined for other items. */
  function useSpecial(p, item, param) {
    if (param !== SPECIAL.rose && param !== SPECIAL.skull) return undefined;
    const rose = param === SPECIAL.rose;
    if (!S.summonCombatAlly) throw new Error('Nothing answers the call here.');
    const ally = S.summonCombatAlly(p, rose ? DAEDROTH : null, rose ? 'sanguine-rose' : 'skull-of-corruption');
    if (!ally) return 'There are no monsters nearby.';
    const r = wear(p, item, USED_WEAR);
    ctx.emit?.('artifactUsed', { player: p, key: item.magic.artifact, power: rose ? 'rose' : 'skull', entityId: ally.id });
    return `${item.name} summons a ${ally.name} to your side.${r.broke ? ` ${item.name} has broken.` : ''}`;
  }

  // ---- magic rounds ------------------------------------------------------------------------------
  let clock = 0;
  let round = 0;
  function magicRound() {
    round++;
    for (const p of ctx.players.values()) {
      if (!p.rpg?.inventory) continue;
      syncHeld(p);
      const c = character(p);
      const m = enchantmentModifiers(p);
      const env = environment(p);
      let touched = false;
      // Mace of Molag Bal: drained Strength and the raised spell point maximum fade 12 minutes after the last strike.
      for (const a of p.rpg.magic?.active ?? []) {
        if (a.key !== 'MaceOfMolagBal') continue;
        a.showSpellIcon = false;
        const it = itemOf(p, a.source?.itemId);
        if (!it || minuteOf(p) > int(it.magic?.lastStrike) + MACE_ROUNDS) { a.amount = 0; a.maxMagicka = 0; }
      }
      if (p.rpg.magic?.active?.some((a) => a.key === 'MaceOfMolagBal' && !a.amount && !a.maxMagicka)) {
        p.rpg.magic.active = p.rpg.magic.active.filter((a) => !(a.key === 'MaceOfMolagBal' && !a.amount && !a.maxMagicka));
        S.refreshCharacterMaxima?.(p);
        touched = true;
      }
      // CastWhenHeld durability: 1 point every 4 rounds (60 while resting), only while its held bundle is live.
      const rate = S.isResting?.(p) ? HELD_DEGRADE_ROUNDS_RESTING : HELD_DEGRADE_ROUNDS;
      if (round % rate === 0) {
        for (const it of equippedMagic(p)) if (heldOf(it).length && !it.magic.held?.dispelled) { wear(p, it, 1); touched = true; }
      }
      if (round % PER_ROUNDS === 0 && c && c.health > 0) {
        // VampiricEffect at range: each enemy within 2.25 m loses 1 health to the wearer, per enchantment.
        for (const v of m.vampiric) {
          if (v.param !== 0) continue;
          for (const e of nearbyCreatures(p, VAMPIRIC_RANGE, { enemiesOnly: true })) {
            let drained = 0;
            try { drained = S.damageEntity?.(null, e, 1, { source: 'vampiric' })?.damage ?? 0; } catch { drained = 0; }
            if (drained > 0) { heal(p, 1); touched = true; }
          }
        }
        // HealthLeech unless used daily / weekly: 1 HP while the item has gone unused longer than that.
        if (!S.isResting?.(p)) {
          for (const l of m.leech) {
            if (l.param !== 1 && l.param !== 2) continue;
            const it = itemOf(p, l.itemId);
            if (!it) continue;
            const idle = minuteOf(p) - leechClock(p, it);
            if (idle > MINUTES_PER_DAY * (l.param === 2 ? DAYS_PER_WEEK : 1)) { hurt(p, 1, it.name); touched = true; }
          }
        }
      }
      if (round % PER_ROUNDS === 0 && c && c.health > 0) {
        const regen = m.regen.some((prm) => prm === 0 || (prm === 1 && env.sunlight) || (prm === 2 && env.darkness));
        if (regen && c.health < c.maxHealth) { c.health += 1; touched = true; }
        const hurt = m.userTakesDamage.some((prm) => (prm === 0 && env.sunlight) || (prm === 1 && env.holy));
        if (hurt) {
          if (S.hurtPlayerBy) S.hurtPlayerBy(p, 1, { name: 'enchantment', source: 'enchantment' });
          else c.health = Math.max(0, c.health - 1);
          touched = true;
        }
        for (const d of m.deteriorates) {
          if ((d.param === 1 && !env.sunlight) || (d.param === 2 && !env.holy)) continue;
          const it = itemOf(p, d.itemId);
          if (it) { wear(p, it, 1); touched = true; }
        }
        if (m.repairs) {
          // RepairsObjects: one damaged, unenchanted item gains a point (AllowMagicRepairs off).
          const it = p.rpg.inventory.find((i) => i && !enchanted(i) && Number.isFinite(i.maxCondition) && i.condition < i.maxCondition);
          if (it) { it.condition += 1; touched = true; }
        }
      }
      if (touched) ctx.dirty?.(p);
    }
  }
  ctx.onTick?.((dt) => {
    clock += dt * 1000;
    while (clock >= ROUND_MS) {
      clock -= ROUND_MS;
      magicRound();
    }
  });
  ctx.onJoin?.((p) => syncHeld(p, { restore: true }));
  ctx.on?.('inventoryChanged', ({ player }) => {
    if (!player) return;
    syncHeld(player);
    S.refreshCharacterMaxima?.(player); // ExtraSpellPts, Mace maximum and ImprovesTalents follow what is worn
  });
  ctx.on?.('heldBundleDispelled', ({ player, itemId }) => {
    const it = itemOf(player, itemId);
    if (!it?.magic?.held || S.itemEffects?.(player, itemId)?.length) return;
    it.magic.held.dispelled = true;
    ctx.dirty?.(player);
  });

  Object.assign(S, {
    enchantmentModifiers,
    enchantmentDamageBonus: (p, target) => {
      const m = enchantmentModifiers(p);
      return 5 * (m.potentVs.filter((x) => affinityMatches(target, x)).length - m.lowDamageVs.filter((x) => affinityMatches(target, x)).length);
    },
    enchantmentStrike,
    enchantmentContact,
    enchantmentStruck,
    maxMagickaModifier,
    enchantmentChanceToHit,
    enchantmentSkillModifier,
    socialReactionModifier,
    wearsArtifact,
    syncHeldEnchantments: syncHeld,
  });
  void spellName;
  return {
    enchantmentModifiers, syncHeld, useSpecial, magicRound, wear, environment,
    /** Used payloads (alchemy useMagicItem): HealthLeech. */
    used: (p, it) => leechTouch(p, it, 'used'),
    /** Enchanted payload (Item Maker): HealthLeech starts its clock. */
    enchanted: (p, it) => { if (leechesOf(it).length) { it.magic.leechAt = minuteOf(p); ctx.dirty?.(p); } },
  };
}
