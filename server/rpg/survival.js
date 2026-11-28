// Optional Survival Ruleset (§9): Food, Water, Exposure/Warmth, and Camping.
//
// Designed as an opt-in ruleset (per-character or server default) that integrates cleanly
// with classic town/wilderness rest legality (`services.restPermission`), world clock,
// and inventory without altering classic gameplay when disabled.
//
// Actions:
//   survival.toggle  { enabled: boolean }
//   survival.status  {}
//   survival.eat     { itemId?, ration? }
//   survival.drink   { itemId?, waterskin? }
//   survival.camp    { action: 'pitch' | 'rest' | 'pack' }
//
// Services (ctx.services.survival):
//   stateOf, advance, computePenalties, pitchCamp, restAtCamp, packCamp

export const name = 'survival';

export const SURVIVAL_RATES = Object.freeze({
  foodPerHour: 4.5,
  waterPerHour: 6.0,
  exposureOutdoorsDayPerHour: 2.0,
  exposureOutdoorsNightPerHour: 6.5,
  exposureIndoorsRecoveryPerHour: 12.0,
  exposureCampRecoveryPerHour: 18.0,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;

export function computeSurvivalPenalties(st) {
  if (!st || !st.enabled) {
    return { active: false, fatigueCapMultiplier: 1, healthRegenBlocked: false, warnings: [] };
  }
  const warnings = [];
  let fatigueCapMultiplier = 1;
  let healthRegenBlocked = false;

  if (st.food <= 20) {
    warnings.push(st.food <= 5 ? 'Starving' : 'Hungry');
    fatigueCapMultiplier -= st.food <= 5 ? 0.25 : 0.1;
    if (st.food <= 5) healthRegenBlocked = true;
  }
  if (st.water <= 20) {
    warnings.push(st.water <= 5 ? 'Dehydrated' : 'Thirsty');
    fatigueCapMultiplier -= st.water <= 5 ? 0.25 : 0.1;
    if (st.water <= 5) healthRegenBlocked = true;
  }
  if (st.warmth <= 25) {
    warnings.push(st.warmth <= 10 ? 'Freezing' : 'Chilled');
    fatigueCapMultiplier -= st.warmth <= 10 ? 0.2 : 0.08;
    if (st.warmth <= 10) healthRegenBlocked = true;
  }

  return {
    active: true,
    fatigueCapMultiplier: Math.max(0.4, Math.round(fatigueCapMultiplier * 100) / 100),
    healthRegenBlocked,
    warnings,
  };
}

function ensureSurvivalState(p, defaultEnabled = false) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.survival;
  if (!cur || typeof cur !== 'object') {
    p.rpg.survival = {
      enabled: Boolean(defaultEnabled),
      food: 100,
      water: 100,
      warmth: 100,
      rations: 4,
      waterskin: 4,
      camp: null,
      lastMinutes: null,
    };
  } else {
    cur.enabled = Boolean(cur.enabled);
    cur.food = clamp(Number.isFinite(cur.food) ? cur.food : 100, 0, 100);
    cur.water = clamp(Number.isFinite(cur.water) ? cur.water : 100, 0, 100);
    cur.warmth = clamp(Number.isFinite(cur.warmth) ? cur.warmth : 100, 0, 100);
    cur.rations = Math.max(0, Math.trunc(Number.isFinite(cur.rations) ? cur.rations : 4));
    cur.waterskin = Math.max(0, Math.trunc(Number.isFinite(cur.waterskin) ? cur.waterskin : 4));
    if (cur.camp !== null && typeof cur.camp !== 'object') cur.camp = null;
  }
  return p.rpg.survival;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const defaultEnabled = Boolean(options.defaultEnabled ?? ctx.config?.survivalMode ?? false);

  function clockInfo() {
    const c = services.worldClock?.();
    if (c && Number.isFinite(c.minutes)) {
      const hour = Number.isFinite(c.hour) ? c.hour : Math.floor((c.minutes % 1440) / 60);
      return { minutes: Math.trunc(c.minutes), hour, isNight: hour < 6 || hour >= 20 };
    }
    const mins = Math.floor((ctx.now?.() ?? Date.now()) / 60_000);
    const hour = Math.floor((mins % 1440) / 60);
    return { minutes: mins, hour, isNight: hour < 6 || hour >= 20 };
  }

  function isIndoors(loc) {
    return typeof loc === 'string' && (loc.startsWith('interior:') || loc.startsWith('dungeon:'));
  }

  function viewOf(p) {
    const st = ensureSurvivalState(p, defaultEnabled);
    const penalties = computeSurvivalPenalties(st);
    return {
      enabled: st.enabled,
      food: r1(st.food),
      water: r1(st.water),
      warmth: r1(st.warmth),
      exposure: r1(100 - st.warmth),
      rations: st.rations,
      waterskin: st.waterskin,
      camp: st.camp ? { ...st.camp } : null,
      penalties,
    };
  }

  function advance(p, elapsedMinutes) {
    const st = ensureSurvivalState(p, defaultEnabled);
    if (!st.enabled) return viewOf(p);
    const mins = Math.max(0, Math.min(24 * 60, Number(elapsedMinutes) || 0));
    if (mins <= 0) return viewOf(p);

    const hours = mins / 60;
    const loc = ctx.location(p);
    const { isNight } = clockInfo();
    const nearCamp = Boolean(st.camp?.active && st.camp.location === loc);

    st.food = r1(clamp(st.food - SURVIVAL_RATES.foodPerHour * hours, 0, 100));
    st.water = r1(clamp(st.water - SURVIVAL_RATES.waterPerHour * hours, 0, 100));

    if (nearCamp) {
      st.warmth = r1(clamp(st.warmth + SURVIVAL_RATES.exposureCampRecoveryPerHour * hours, 0, 100));
    } else if (isIndoors(loc)) {
      st.warmth = r1(clamp(st.warmth + SURVIVAL_RATES.exposureIndoorsRecoveryPerHour * hours, 0, 100));
    } else {
      const drain = isNight ? SURVIVAL_RATES.exposureOutdoorsNightPerHour : SURVIVAL_RATES.exposureOutdoorsDayPerHour;
      st.warmth = r1(clamp(st.warmth - drain * hours, 0, 100));
    }

    ctx.dirty(p);
    return viewOf(p);
  }

  function pitchCamp(p) {
    const st = ensureSurvivalState(p, defaultEnabled);
    if (!st.enabled) throw new Error('Enable Survival ruleset before pitching camp.');
    const loc = ctx.location(p);
    // Respect classic town vagrancy / camping prohibition when restPermission is available.
    if (typeof services.restPermission === 'function') {
      const perm = services.restPermission(p, loc, 'hours');
      if (perm && perm.ok === false) {
        throw new Error(perm.error || 'Camping is not permitted here.');
      }
    } else if (loc.startsWith('town:')) {
      throw new Error('Camping within town walls is forbidden. Leave town or use an inn.');
    }
    ctx.dirty(p);
    st.camp = {
      active: true,
      location: loc,
      x: Math.round((Number(p.x) || 0) * 100) / 100,
      z: Math.round((Number(p.z) || 0) * 100) / 100,
      pitchedAt: clockInfo().minutes,
      fireLit: true,
    };
    st.warmth = r1(clamp(st.warmth + 15, 0, 100));
    return st.camp;
  }

  function restAtCamp(p, hours = 2) {
    const st = ensureSurvivalState(p, defaultEnabled);
    if (!st.camp?.active || st.camp.location !== ctx.location(p)) {
      throw new Error('Pitch a camp at your current location first.');
    }
    const hrs = Math.max(1, Math.min(8, Math.trunc(Number(hours) || 2)));
    ctx.dirty(p);
    st.warmth = r1(clamp(st.warmth + hrs * SURVIVAL_RATES.exposureCampRecoveryPerHour, 0, 100));
    st.food = r1(clamp(st.food - hrs * (SURVIVAL_RATES.foodPerHour * 0.5), 0, 100));
    st.water = r1(clamp(st.water - hrs * (SURVIVAL_RATES.waterPerHour * 0.5), 0, 100));
    if (p.rpg.character && Number.isFinite(p.rpg.character.maxFatigue)) {
      p.rpg.character.fatigue = p.rpg.character.maxFatigue;
    }
    return viewOf(p);
  }

  function packCamp(p) {
    const st = ensureSurvivalState(p, defaultEnabled);
    if (!st.camp?.active) throw new Error('You have no active camp to pack.');
    ctx.dirty(p);
    st.camp = null;
    return viewOf(p);
  }

  ctx.onJoin?.((p) => {
    const st = ensureSurvivalState(p, defaultEnabled);
    if (st.lastMinutes == null) st.lastMinutes = clockInfo().minutes;
  });

  ctx.onTick?.(() => {
    const { minutes } = clockInfo();
    for (const p of ctx.players.values()) {
      const st = ensureSurvivalState(p, defaultEnabled);
      if (!st.enabled) {
        st.lastMinutes = minutes;
        continue;
      }
      if (st.lastMinutes == null) {
        st.lastMinutes = minutes;
        continue;
      }
      const diff = minutes - st.lastMinutes;
      if (diff >= 5) {
        st.lastMinutes = minutes;
        advance(p, diff);
      }
    }
  });

  ctx.onAction?.('survival.toggle', (p, args) => {
    const st = ensureSurvivalState(p, defaultEnabled);
    const next = typeof args?.enabled === 'boolean' ? args.enabled : !st.enabled;
    ctx.dirty(p);
    st.enabled = next;
    st.lastMinutes = clockInfo().minutes;
    if (!next) st.camp = null;
    ctx.notify(p, {
      kind: 'survival',
      survival: viewOf(p),
      text: next ? 'Survival ruleset enabled (food, water, exposure, camping).' : 'Survival ruleset disabled.',
    });
  });

  ctx.onAction?.('survival.status', (p) => {
    ctx.notify(p, { kind: 'survival', survival: viewOf(p), silent: true });
  });

  ctx.onAction?.('survival.eat', (p, args) => {
    const st = ensureSurvivalState(p, defaultEnabled);
    ctx.dirty(p);
    let label = 'travel ration';
    if (args?.itemId && Array.isArray(p.rpg?.inventory)) {
      const idx = p.rpg.inventory.findIndex((it) => it && it.id === args.itemId);
      if (idx < 0) throw new Error('Food item not found in inventory.');
      const item = p.rpg.inventory[idx];
      label = item.name || item.template || 'food';
      if ((item.quantity ?? 1) > 1) item.quantity -= 1;
      else p.rpg.inventory.splice(idx, 1);
      st.food = r1(clamp(st.food + 35, 0, 100));
    } else {
      if (st.rations <= 0) throw new Error('You have no rations left.');
      st.rations -= 1;
      st.food = r1(clamp(st.food + 35, 0, 100));
    }
    ctx.notify(p, { kind: 'survival', survival: viewOf(p), text: `Ate ${label} (Food ${st.food}%).` });
  });

  ctx.onAction?.('survival.drink', (p, args) => {
    const st = ensureSurvivalState(p, defaultEnabled);
    ctx.dirty(p);
    let label = 'waterskin';
    if (args?.itemId && Array.isArray(p.rpg?.inventory)) {
      const idx = p.rpg.inventory.findIndex((it) => it && it.id === args.itemId);
      if (idx < 0) throw new Error('Drink item not found in inventory.');
      const item = p.rpg.inventory[idx];
      label = item.name || item.template || 'drink';
      if ((item.quantity ?? 1) > 1) item.quantity -= 1;
      else p.rpg.inventory.splice(idx, 1);
      st.water = r1(clamp(st.water + 40, 0, 100));
    } else {
      if (st.waterskin <= 0) throw new Error('Your waterskin is empty.');
      st.waterskin -= 1;
      st.water = r1(clamp(st.water + 40, 0, 100));
    }
    ctx.notify(p, { kind: 'survival', survival: viewOf(p), text: `Drank from ${label} (Water ${st.water}%).` });
  });

  ctx.onAction?.('survival.camp', (p, args) => {
    const action = String(args?.action ?? 'pitch').toLowerCase();
    if (action === 'pitch') {
      pitchCamp(p);
      ctx.notify(p, { kind: 'survival', survival: viewOf(p), text: 'Pitched a warm campfire and tent.' });
    } else if (action === 'rest') {
      restAtCamp(p, args?.hours ?? 2);
      ctx.notify(p, { kind: 'survival', survival: viewOf(p), text: 'Rested by the campfire; warmth and fatigue restored.' });
    } else if (action === 'pack') {
      packCamp(p);
      ctx.notify(p, { kind: 'survival', survival: viewOf(p), text: 'Packed up camp.' });
    } else {
      throw new Error('Camp action must be pitch, rest, or pack.');
    }
  });

  services.survival = {
    stateOf: viewOf,
    advance,
    computePenalties: computeSurvivalPenalties,
    pitchCamp,
    restAtCamp,
    packCamp,
  };
}
