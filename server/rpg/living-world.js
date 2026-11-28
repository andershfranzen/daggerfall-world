// Living World & Persistent Followers (§9):
//   - Pilot town (Daggerfall / Gothway Garden) named residents with deterministic hourly
//     schedules and building-to-building travel (Home -> Market/Guild -> Tavern -> Home).
//   - Cross-scene caravan route with stable named actors moving deterministically across
//     town boundaries, persisted in world state (`livingWorld/caravans`).
//   - Persistent character-specific relationships (`p.rpg.livingWorld.relationships`).
//   - Recruitable persistent follower (`p.rpg.livingWorld.follower`) with recruit, dismiss,
//     stance, and recall across doors — cleanly distinct from classic quest escorts and
//     artifact/conjured allies.
//
// Actions:
//   living.status       {}
//   living.talk         { residentId, topic? }
//   living.gift         { residentId, gold? }
//   living.caravan      {}
//   follower.recruit    { residentId }
//   follower.dismiss    {}
//   follower.recall     {}
//   follower.stance     { stance: 'follow'|'hold'|'guard' }
//
// Services (ctx.services.livingWorld):
//   residentAt, caravanAt, relationshipOf, followerOf, syncFollowerEntity

export const name = 'livingWorld';
export const WORLD_PREFIX = 'livingWorld/';
export const PILOT_TOWN = 'town:Daggerfall/Gothway Garden';

export const SCHEDULED_RESIDENTS = Object.freeze([
  Object.freeze({
    id: 'res-maren-vell',
    name: 'Maren Vell',
    role: 'Quartermaster',
    homeTown: PILOT_TOWN,
    recruitable: false,
    bio: 'Keeps Gothway Garden’s caravan manifests and supply ledgers.',
    schedule: Object.freeze([
      { startHour: 0, endHour: 6, building: 'home', place: 'interior:Daggerfall/Gothway Garden/0,0/0', label: 'Maren’s Cottage', x: -8, z: 6 },
      { startHour: 6, endHour: 17, building: 'market', place: PILOT_TOWN, label: 'Gothway Market Square', x: 6, z: -4 },
      { startHour: 17, endHour: 22, building: 'tavern', place: 'interior:Daggerfall/Gothway Garden/1,0/2', label: 'The Hedge Tavern', x: 2, z: -2 },
      { startHour: 22, endHour: 24, building: 'home', place: 'interior:Daggerfall/Gothway Garden/0,0/0', label: 'Maren’s Cottage', x: -8, z: 6 },
    ]),
  }),
  Object.freeze({
    id: 'res-aldric-thorne',
    name: 'Aldric Thorne',
    role: 'Sellsword Companion',
    homeTown: PILOT_TOWN,
    recruitable: true,
    hireGold: 50,
    minAffinity: 0,
    combatStyle: 'sword-and-shield',
    bio: 'A dependable Breton bladesman willing to swear companionship across doors and delves.',
    schedule: Object.freeze([
      { startHour: 0, endHour: 7, building: 'tavern', place: 'interior:Daggerfall/Gothway Garden/1,0/2', label: 'The Hedge Tavern', x: 3, z: -3 },
      { startHour: 7, endHour: 18, building: 'gate', place: PILOT_TOWN, label: 'Gothway North Gate', x: -4, z: -10 },
      { startHour: 18, endHour: 24, building: 'tavern', place: 'interior:Daggerfall/Gothway Garden/1,0/2', label: 'The Hedge Tavern', x: 3, z: -3 },
    ]),
  }),
  Object.freeze({
    id: 'res-lyra-ashford',
    name: 'Lyra Ashford',
    role: 'Hedge Alchemist',
    homeTown: PILOT_TOWN,
    recruitable: true,
    hireGold: 75,
    minAffinity: 10,
    combatStyle: 'restoration-and-frost',
    bio: 'Collects Iliac herbs by dawn and offers restorative aid to trusted allies.',
    schedule: Object.freeze([
      { startHour: 0, endHour: 6, building: 'home', place: 'interior:Daggerfall/Gothway Garden/2,0/5', label: 'Ashford Apothecary', x: 10, z: 8 },
      { startHour: 6, endHour: 12, building: 'garden', place: PILOT_TOWN, label: 'Gothway Herb Verge', x: 12, z: 4 },
      { startHour: 12, endHour: 19, building: 'shop', place: 'interior:Daggerfall/Gothway Garden/3,0/16', label: 'General Store', x: 0, z: -2 },
      { startHour: 19, endHour: 24, building: 'home', place: 'interior:Daggerfall/Gothway Garden/2,0/5', label: 'Ashford Apothecary', x: 10, z: 8 },
    ]),
  }),
]);

export const CARAVAN_ROUTES = Object.freeze([
  Object.freeze({
    id: 'caravan-iliac-north',
    name: 'Gothway–Daggerfall Merchant Train',
    merchantId: 'caravan-actor-brennan',
    merchantName: 'Brennan the Wain-Master',
    guardId: 'caravan-actor-kestrel',
    guardName: 'Kestrel of the Road',
    legMinutes: 60, // 1 game hour per stop
    stops: Object.freeze([
      Object.freeze({ location: 'town:Daggerfall/Gothway Garden', label: 'Gothway Garden', x: 4, z: -14 }),
      Object.freeze({ location: 'town:Daggerfall/Daggerfall', label: 'Daggerfall Gate', x: -12, z: 18 }),
      Object.freeze({ location: 'town:Daggerfall/Aldingwall', label: 'Aldingwall Crossing', x: 8, z: 6 }),
    ]),
    goods: Object.freeze(['spices', 'timber', 'iron-ingots']),
  }),
]);

const RESIDENT_BY_ID = new Map(SCHEDULED_RESIDENTS.map((r) => [r.id, r]));
const FOLLOWER_STANCES = new Set(['follow', 'hold', 'guard']);

export function affinityTier(affinity) {
  const n = Number(affinity) || 0;
  if (n >= 60) return 'Sworn Ally';
  if (n >= 30) return 'Trusted';
  if (n >= 10) return 'Friendly';
  if (n <= -20) return 'Distrustful';
  return 'Acquaintance';
}

/** Deterministic building/position of a scheduled resident for a given world hour (0..23). */
export function residentScheduleAt(resident, hour) {
  const h = ((Math.floor(Number(hour) || 0) % 24) + 24) % 24;
  const slot = resident.schedule.find((s) => h >= s.startHour && h < s.endHour) ?? resident.schedule[0];
  return {
    id: resident.id,
    name: resident.name,
    role: resident.role,
    recruitable: resident.recruitable,
    hireGold: resident.hireGold ?? 0,
    minAffinity: resident.minAffinity ?? 0,
    location: slot.place,
    building: slot.building,
    label: slot.label,
    x: slot.x,
    z: slot.z,
    hour: h,
  };
}

/** Deterministic cross-scene caravan state for a given world minute timestamp. */
export function caravanStateAt(route, worldMinutes) {
  const mins = Math.max(0, Math.floor(Number(worldMinutes) || 0));
  const totalStops = route.stops.length;
  const legIndex = Math.floor(mins / route.legMinutes);
  const stopIdx = legIndex % totalStops;
  const nextIdx = (stopIdx + 1) % totalStops;
  const stop = route.stops[stopIdx];
  const nextStop = route.stops[nextIdx];
  const progress = Math.round(((mins % route.legMinutes) / route.legMinutes) * 100) / 100;
  return {
    id: route.id,
    name: route.name,
    actors: [
      { id: route.merchantId, name: route.merchantName, role: 'Caravan Master' },
      { id: route.guardId, name: route.guardName, role: 'Outrider' },
    ],
    location: stop.location,
    stopLabel: stop.label,
    nextLocation: nextStop.location,
    nextLabel: nextStop.label,
    x: stop.x,
    z: stop.z,
    legIndex,
    progress,
    goods: [...route.goods],
  };
}

function ensureLivingWorldState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.livingWorld;
  if (!cur || typeof cur !== 'object') {
    p.rpg.livingWorld = { relationships: {}, follower: null };
  } else {
    if (!cur.relationships || typeof cur.relationships !== 'object') cur.relationships = {};
    if (cur.follower !== null && typeof cur.follower !== 'object') cur.follower = null;
  }
  return p.rpg.livingWorld;
}

export function install(ctx) {
  const services = (ctx.services ||= {});
  const caravanMeta = new Map(); // caravanId -> { escortsCompleted, lastStop }

  for (const [k, v] of ctx.loadWorld?.(`${WORLD_PREFIX}caravan:`) ?? []) {
    if (v && typeof v === 'object') caravanMeta.set(k.slice(`${WORLD_PREFIX}caravan:`.length), v);
  }

  function worldTime() {
    const c = services.worldClock?.();
    if (c && Number.isFinite(c.minutes)) {
      const hour = Number.isFinite(c.hour) ? c.hour : Math.floor((c.minutes % 1440) / 60);
      return { minutes: Math.trunc(c.minutes), hour };
    }
    const mins = Math.floor((ctx.now?.() ?? Date.now()) / 60_000);
    return { minutes: mins, hour: Math.floor((mins % 1440) / 60) };
  }

  function followerEntityId(playerId) {
    return `follower:${playerId}`;
  }

  function removeFollowerEntity(playerId) {
    const eid = followerEntityId(playerId);
    if (ctx.entities?.has(eid)) ctx.entities.delete(eid);
  }

  function syncFollowerEntity(p) {
    const lw = ensureLivingWorldState(p);
    const f = lw.follower;
    const eid = followerEntityId(p.id);
    if (!f || !f.active) {
      removeFollowerEntity(p.id);
      return null;
    }
    const entity = {
      id: eid,
      kind: 'follower',
      name: f.name,
      role: f.role,
      residentId: f.residentId,
      ownerId: p.id,
      stance: f.stance,
      location: f.location,
      x: Math.round((Number(f.x) || 0) * 100) / 100,
      y: Number(f.y) || 0,
      z: Math.round((Number(f.z) || 0) * 100) / 100,
      isQuestEscort: false,
      isArtifactAlly: false,
      persistentFollower: true,
    };
    ctx.entities?.set(eid, entity);
    return entity;
  }

  function relationshipOf(p, residentId) {
    const lw = ensureLivingWorldState(p);
    const rel = lw.relationships[residentId] ?? { affinity: 0, interactions: 0, giftsGold: 0, lastTalkAt: 0 };
    return { ...rel, tier: affinityTier(rel.affinity) };
  }

  function statusFor(p) {
    const { minutes, hour } = worldTime();
    const residents = SCHEDULED_RESIDENTS.map((r) => ({
      ...residentScheduleAt(r, hour),
      relationship: relationshipOf(p, r.id),
    }));
    const caravans = CARAVAN_ROUTES.map((route) => {
      const st = caravanStateAt(route, minutes);
      return { ...st, meta: caravanMeta.get(route.id) ?? { escortsCompleted: 0 } };
    });
    const lw = ensureLivingWorldState(p);
    return {
      pilotTown: PILOT_TOWN,
      hour,
      minutes,
      residents,
      caravans,
      follower: lw.follower ? { ...lw.follower } : null,
      relationships: Object.fromEntries(
        Object.entries(lw.relationships).map(([id, rel]) => [id, { ...rel, tier: affinityTier(rel.affinity) }]),
      ),
    };
  }

  // Follow owner across doors/portals automatically unless stance is 'hold'.
  ctx.on?.('locationChanged', ({ player, to }) => {
    if (!player) return;
    const lw = ensureLivingWorldState(player);
    const f = lw.follower;
    if (!f || !f.active) return;
    if (f.stance === 'hold') return;
    f.location = to;
    f.x = (Number(player.x) || 0) - 1.2;
    f.y = Number(player.rpg?.portal?.footY) || 0;
    f.z = (Number(player.z) || 0) - 1.2;
    syncFollowerEntity(player);
    ctx.dirty(player);
    ctx.notify(player, {
      kind: 'follower',
      follower: { ...f },
      text: `${f.name} followed you to ${to}.`,
    });
  });

  ctx.onJoin?.((p) => {
    const lw = ensureLivingWorldState(p);
    if (lw.follower?.active) syncFollowerEntity(p);
  });

  ctx.onLeave?.((p) => {
    removeFollowerEntity(p.id);
  });

  ctx.onAction?.('living.status', (p) => {
    ctx.notify(p, { kind: 'livingWorld', ...statusFor(p), silent: true });
  });

  ctx.onAction?.('living.caravan', (p) => {
    const { minutes } = worldTime();
    const caravans = CARAVAN_ROUTES.map((r) => caravanStateAt(r, minutes));
    for (const c of caravans) {
      const meta = caravanMeta.get(c.id) ?? { escortsCompleted: 0 };
      meta.lastStop = c.location;
      caravanMeta.set(c.id, meta);
      ctx.dirtyWorld?.(`${WORLD_PREFIX}caravan:${c.id}`, meta);
    }
    ctx.notify(p, { kind: 'livingCaravan', caravans, text: `${caravans[0].name} is currently at ${caravans[0].stopLabel}.` });
  });

  ctx.onAction?.('living.talk', (p, args) => {
    const res = RESIDENT_BY_ID.get(String(args?.residentId ?? ''));
    if (!res) throw new Error('Named resident not found.');
    const lw = ensureLivingWorldState(p);
    ctx.dirty(p);
    const cur = lw.relationships[res.id] ?? { affinity: 0, interactions: 0, giftsGold: 0, lastTalkAt: 0 };
    cur.interactions += 1;
    cur.affinity = Math.min(100, cur.affinity + 5);
    cur.lastTalkAt = Math.trunc(ctx.now?.() ?? Date.now());
    lw.relationships[res.id] = cur;
    const { hour } = worldTime();
    const sched = residentScheduleAt(res, hour);
    ctx.notify(p, {
      kind: 'livingWorld',
      ...statusFor(p),
      spokeWith: res.id,
      text: `${res.name} (${sched.label}): "Good to see you, ${p.name}." (${affinityTier(cur.affinity)}, affinity ${cur.affinity})`,
    });
  });

  ctx.onAction?.('living.gift', (p, args) => {
    const res = RESIDENT_BY_ID.get(String(args?.residentId ?? ''));
    if (!res) throw new Error('Named resident not found.');
    const gold = Math.max(5, Math.min(500, Math.trunc(Number(args?.gold) || 10)));
    const purse = Number(p.rpg?.gold) || 0;
    if (purse < gold) throw new Error(`You need ${gold} gold to offer that gift.`);
    ctx.dirty(p);
    if (typeof services.takeGold === 'function') services.takeGold(p, gold);
    else p.rpg.gold = purse - gold;

    const lw = ensureLivingWorldState(p);
    const cur = lw.relationships[res.id] ?? { affinity: 0, interactions: 0, giftsGold: 0, lastTalkAt: 0 };
    cur.giftsGold += gold;
    cur.affinity = Math.min(100, cur.affinity + Math.max(3, Math.floor(gold / 5)));
    lw.relationships[res.id] = cur;
    ctx.notify(p, {
      kind: 'livingWorld',
      ...statusFor(p),
      text: `${res.name} gladly accepts your ${gold} gold gift (${affinityTier(cur.affinity)}, affinity ${cur.affinity}).`,
    });
  });

  ctx.onAction?.('follower.recruit', (p, args) => {
    const res = RESIDENT_BY_ID.get(String(args?.residentId ?? ''));
    if (!res) throw new Error('Companion not found.');
    if (!res.recruitable) throw new Error(`${res.name} cannot leave their post in ${PILOT_TOWN}.`);
    const lw = ensureLivingWorldState(p);
    if (lw.follower?.active && lw.follower.residentId === res.id) {
      throw new Error(`${res.name} is already accompanying you.`);
    }
    const rel = relationshipOf(p, res.id);
    if (rel.affinity < (res.minAffinity ?? 0)) {
      throw new Error(`${res.name} requires at least ${res.minAffinity} affinity before travelling with you.`);
    }
    const fee = Math.max(0, res.hireGold ?? 0);
    const purse = Number(p.rpg?.gold) || 0;
    if (fee > 0 && purse < fee) throw new Error(`Recruiting ${res.name} requires ${fee} gold.`);

    ctx.dirty(p);
    if (fee > 0) {
      if (typeof services.takeGold === 'function') services.takeGold(p, fee);
      else p.rpg.gold = purse - fee;
    }
    lw.follower = {
      residentId: res.id,
      name: res.name,
      role: res.role,
      combatStyle: res.combatStyle,
      active: true,
      stance: 'follow',
      location: ctx.location(p),
      x: (Number(p.x) || 0) - 1.2,
      y: Number(p.rpg?.portal?.footY) || 0,
      z: (Number(p.z) || 0) - 1.2,
      recruitedAt: Math.trunc(ctx.now?.() ?? Date.now()),
      isQuestEscort: false,
      isArtifactAlly: false,
    };
    const ent = syncFollowerEntity(p);
    ctx.onRollback?.(() => removeFollowerEntity(p.id));
    ctx.notify(p, {
      kind: 'follower',
      follower: { ...lw.follower },
      entity: ent,
      text: `${res.name} joins you as a persistent follower.`,
    });
  });

  ctx.onAction?.('follower.dismiss', (p) => {
    const lw = ensureLivingWorldState(p);
    if (!lw.follower?.active) throw new Error('You have no active follower to dismiss.');
    const oldName = lw.follower.name;
    const prevEnt = ctx.entities?.get(followerEntityId(p.id)) ?? null;
    ctx.dirty(p);
    lw.follower = {
      ...lw.follower,
      active: false,
      location: PILOT_TOWN,
      dismissedAt: Math.trunc(ctx.now?.() ?? Date.now()),
    };
    removeFollowerEntity(p.id);
    ctx.onRollback?.(() => {
      if (prevEnt) ctx.entities?.set(prevEnt.id, prevEnt);
    });
    ctx.notify(p, {
      kind: 'follower',
      follower: { ...lw.follower },
      text: `Dismissed ${oldName}; they have returned to ${PILOT_TOWN}.`,
    });
  });

  ctx.onAction?.('follower.recall', (p) => {
    const lw = ensureLivingWorldState(p);
    if (!lw.follower) throw new Error('You have never recruited a follower to recall.');
    ctx.dirty(p);
    lw.follower.active = true;
    lw.follower.stance = 'follow';
    lw.follower.location = ctx.location(p);
    lw.follower.x = (Number(p.x) || 0) - 1.0;
    lw.follower.y = Number(p.rpg?.portal?.footY) || 0;
    lw.follower.z = (Number(p.z) || 0) - 1.0;
    const ent = syncFollowerEntity(p);
    ctx.notify(p, {
      kind: 'follower',
      follower: { ...lw.follower },
      entity: ent,
      text: `Recalled ${lw.follower.name} to your side at ${lw.follower.location}.`,
    });
  });

  ctx.onAction?.('follower.stance', (p, args) => {
    const stance = String(args?.stance ?? '').toLowerCase();
    if (!FOLLOWER_STANCES.has(stance)) throw new Error('Stance must be follow, hold, or guard.');
    const lw = ensureLivingWorldState(p);
    if (!lw.follower?.active) throw new Error('You have no active follower.');
    ctx.dirty(p);
    lw.follower.stance = stance;
    const ent = syncFollowerEntity(p);
    ctx.notify(p, {
      kind: 'follower',
      follower: { ...lw.follower },
      entity: ent,
      text: `${lw.follower.name} stance set to ${stance}.`,
    });
  });

  services.livingWorld = {
    pilotTown: PILOT_TOWN,
    residents: SCHEDULED_RESIDENTS,
    caravans: CARAVAN_ROUTES,
    residentAt: (id, hour = worldTime().hour) => {
      const r = RESIDENT_BY_ID.get(id);
      return r ? residentScheduleAt(r, hour) : null;
    },
    caravanAt: (id, minutes = worldTime().minutes) => {
      const r = CARAVAN_ROUTES.find((c) => c.id === id);
      return r ? caravanStateAt(r, minutes) : null;
    },
    relationshipOf,
    followerOf: (p) => ensureLivingWorldState(p).follower,
    syncFollowerEntity,
    statusFor,
  };
}
