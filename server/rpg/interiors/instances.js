// Public, personal, and party dungeon instances tied to layoutId, mechanisms, enemies,
// loot, quest placements, portal returns, Recall anchors, automap exploration, and wipe recovery.
//
// Separation from public scene:
//   - Public instances share the world's base dungeon location with presenceScope = null.
//   - Personal and party instances isolate players via `ctx.services.presenceScope` and
//     store mechanisms, defeated enemies, instance loot claims, and quest markers under
//     their own `instances/<instanceId>` world_state row, completely isolated from public.
//
// Actions:
//   instance.select           { location?, mode: 'public'|'personal'|'party', layoutMode? }
//   instance.enter            { location?, mode?, layoutMode?, instanceId?, entrance?, returnTo? }
//   instance.leave            {}
//   instance.status           { location? }
//   instance.recover          { toExterior? }
//   instance.recallSet        {}
//   instance.recallReturn     {}
//   instance.toggleMechanism  { mechanismId }
//
// Services (ctx.services.dungeonInstances):
//   createOrGet, enter, leave, statusOf, recoverWipe, setRecallAnchor, returnRecallAnchor,
//   toggleMechanism, recordEnemyDefeat, claimLoot, placeQuestObject, getInstance, activeForPlayer

import { parseLocation } from '../../../client/world/interiors/index.js';
import { buildSmallerDungeonLayout, layoutIdFor } from './smaller-dungeons.js';

export const name = 'dungeonInstances';
export const WORLD_PREFIX = 'instances/';
export const INSTANCE_MODES = Object.freeze(['public', 'personal', 'party']);
const MODE_SET = new Set(INSTANCE_MODES);
const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour idle expiry for non-public instances

function isDungeonLoc(loc) {
  return typeof loc === 'string' && loc.startsWith('dungeon:');
}

function slugOf(location) {
  return String(location ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
}

function ensurePlayerInstanceState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.dungeonInstance;
  if (!cur || typeof cur !== 'object') {
    p.rpg.dungeonInstance = {
      preferredMode: 'public',
      preferredLayout: 'classic',
      active: null,
      recallAnchor: null,
    };
  } else {
    if (!MODE_SET.has(cur.preferredMode)) cur.preferredMode = 'public';
    if (cur.preferredLayout !== 'smaller' && cur.preferredLayout !== 'classic') cur.preferredLayout = 'classic';
    if (cur.active !== null && typeof cur.active !== 'object') cur.active = null;
    if (cur.recallAnchor !== null && typeof cur.recallAnchor !== 'object') cur.recallAnchor = null;
  }
  return p.rpg.dungeonInstance;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const instances = new Map(); // instanceId -> instance record

  for (const [k, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    if (v && typeof v === 'object' && typeof v.instanceId === 'string') {
      instances.set(k.slice(WORLD_PREFIX.length), hydrate(v));
    }
  }

  function hydrate(raw) {
    return {
      instanceId: String(raw.instanceId),
      baseLocation: String(raw.baseLocation),
      mode: MODE_SET.has(raw.mode) ? raw.mode : 'personal',
      layoutId: String(raw.layoutId ?? layoutIdFor(raw.baseLocation, 'classic')),
      layoutMode: raw.layoutMode === 'smaller' ? 'smaller' : 'classic',
      collisionHash: String(raw.collisionHash ?? ''),
      ownerId: raw.ownerId ?? null,
      partyId: raw.partyId ?? null,
      memberIds: Array.isArray(raw.memberIds) ? [...new Set(raw.memberIds.map(Number).filter(Number.isSafeInteger))] : [],
      mechanisms: {
        active: Array.isArray(raw.mechanisms?.active) ? [...raw.mechanisms.active] : [],
        locks: raw.mechanisms?.locks && typeof raw.mechanisms.locks === 'object' ? { ...raw.mechanisms.locks } : {},
      },
      enemiesDefeated: Array.isArray(raw.enemiesDefeated) ? [...raw.enemiesDefeated] : [],
      lootClaimed: raw.lootClaimed && typeof raw.lootClaimed === 'object' ? { ...raw.lootClaimed } : {},
      questPlacements: raw.questPlacements && typeof raw.questPlacements === 'object' ? { ...raw.questPlacements } : {},
      entrance: raw.entrance && typeof raw.entrance === 'object'
        ? { x: Number(raw.entrance.x) || 0, y: Number(raw.entrance.y) || 0, z: Number(raw.entrance.z) || 0, yaw: Number(raw.entrance.yaw) || 0 }
        : { x: 0, y: 0, z: 0, yaw: 0 },
      returnTo: raw.returnTo && typeof raw.returnTo === 'object'
        ? {
          location: String(raw.returnTo.location ?? raw.baseLocation.replace(/^dungeon:/, 'town:')),
          x: Number(raw.returnTo.x) || 0,
          y: Number(raw.returnTo.y) || 0,
          z: Number(raw.returnTo.z) || 0,
          yaw: Number(raw.returnTo.yaw) || 0,
        }
        : { location: String(raw.baseLocation).replace(/^dungeon:/, 'town:'), x: 0, y: 0, z: 0, yaw: 0 },
      automapKey: String(raw.automapKey ?? `${raw.baseLocation}@${raw.instanceId}`),
      wipes: Number(raw.wipes) || 0,
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
      expiresAt: Number(raw.expiresAt) || 0,
    };
  }

  function saveInstance(inst) {
    if (!inst || inst.mode === 'public') return;
    const prev = instances.has(inst.instanceId) ? structuredClone(instances.get(inst.instanceId)) : null;
    inst.updatedAt = Math.trunc(ctx.now?.() ?? Date.now());
    inst.expiresAt = inst.updatedAt + ttlMs;
    instances.set(inst.instanceId, inst);
    ctx.dirtyWorld?.(`${WORLD_PREFIX}${inst.instanceId}`, inst);
    ctx.onRollback?.(() => {
      if (prev) instances.set(inst.instanceId, prev);
      else instances.delete(inst.instanceId);
    });
  }

  function partyOf(p) {
    try {
      const party = services.partyOf?.(p);
      if (party) return party;
    } catch { /* fallback to saved rpg.party */ }
    const saved = p?.rpg?.party;
    if (saved && saved.id && Array.isArray(saved.members)) {
      return {
        id: saved.id,
        leaderId: saved.leaderId,
        memberIds: saved.members.map((m) => m.id),
      };
    }
    return null;
  }

  function resolveLayout(p, baseLocation, layoutMode) {
    if (services.smallerDungeons?.selectLayout) {
      return services.smallerDungeons.selectLayout(baseLocation, { player: p, mode: layoutMode });
    }
    return buildSmallerDungeonLayout(baseLocation, { mode: layoutMode });
  }

  function instanceIdFor(mode, p, baseLocation) {
    if (mode === 'public') return 'public';
    const slug = slugOf(baseLocation);
    if (mode === 'personal') return `personal:${p.id}:${slug}`;
    const party = partyOf(p);
    if (!party) throw new Error('Join or form a party to enter a party dungeon instance.');
    return `party:${party.id}:${slug}`;
  }

  function canAccess(p, inst) {
    if (!inst) return false;
    if (inst.mode === 'public') return true;
    if (inst.mode === 'personal') return inst.ownerId === p.id;
    if (inst.mode === 'party') {
      const party = partyOf(p);
      if (party && party.id === inst.partyId) return true;
      return inst.memberIds.includes(p.id);
    }
    return false;
  }

  function publicView(inst) {
    if (!inst) return null;
    return {
      instanceId: inst.instanceId,
      baseLocation: inst.baseLocation,
      mode: inst.mode,
      layoutId: inst.layoutId,
      layoutMode: inst.layoutMode,
      collisionHash: inst.collisionHash,
      ownerId: inst.ownerId,
      partyId: inst.partyId,
      memberIds: [...inst.memberIds],
      mechanisms: { active: [...inst.mechanisms.active], locks: { ...inst.mechanisms.locks } },
      enemiesDefeated: [...inst.enemiesDefeated],
      lootClaimedCount: Object.keys(inst.lootClaimed).length,
      questPlacements: { ...inst.questPlacements },
      automapKey: inst.automapKey,
      returnTo: { ...inst.returnTo },
      wipes: inst.wipes,
    };
  }

  function createOrGet(p, baseLocation, opts = {}) {
    if (!isDungeonLoc(baseLocation)) throw new Error('Dungeon instances require a dungeon location.');
    const st = ensurePlayerInstanceState(p);
    const mode = MODE_SET.has(opts.mode) ? opts.mode : st.preferredMode;
    const layoutMode = opts.layoutMode === 'smaller' || opts.layoutMode === 'classic'
      ? opts.layoutMode
      : st.preferredLayout;
    const layout = resolveLayout(p, baseLocation, layoutMode);
    const portal = services.portals?.into?.(baseLocation) ?? null;
    const defaultEntrance = portal?.entrances?.[0]?.enter
      ? { ...portal.entrances[0].enter }
      : { x: 0, y: 0, z: 0, yaw: 0 };
    const defaultReturn = portal?.entrances?.[0]?.exit
      ? { location: portal.from, ...portal.entrances[0].exit }
      : { location: baseLocation.replace(/^dungeon:/, 'town:'), x: 0, y: 0, z: 0, yaw: 0 };

    if (mode === 'public') {
      return {
        instanceId: 'public',
        baseLocation,
        mode: 'public',
        layoutId: layout.layoutId,
        layoutMode: layout.mode,
        collisionHash: layout.collisionHash,
        ownerId: null,
        partyId: null,
        memberIds: [],
        mechanisms: { active: [], locks: {} },
        enemiesDefeated: [],
        lootClaimed: {},
        questPlacements: {},
        entrance: opts.entrance ?? defaultEntrance,
        returnTo: opts.returnTo ?? defaultReturn,
        automapKey: layout.automapKey,
        wipes: 0,
      };
    }

    const id = typeof opts.instanceId === 'string' && instances.has(opts.instanceId)
      ? opts.instanceId
      : instanceIdFor(mode, p, baseLocation);
    let inst = instances.get(id);
    if (inst) {
      if (!canAccess(p, inst)) throw new Error('You do not have permission to enter that dungeon instance.');
      if (mode === 'party') {
        const party = partyOf(p);
        if (party) inst.memberIds = [...new Set([...inst.memberIds, ...party.memberIds])];
      }
      saveInstance(inst);
      return inst;
    }

    const party = mode === 'party' ? partyOf(p) : null;
    const nowMs = Math.trunc(ctx.now?.() ?? Date.now());
    inst = hydrate({
      instanceId: id,
      baseLocation,
      mode,
      layoutId: layout.layoutId,
      layoutMode: layout.mode,
      collisionHash: layout.collisionHash,
      ownerId: mode === 'personal' ? p.id : (party?.leaderId ?? p.id),
      partyId: party?.id ?? null,
      memberIds: party ? [...party.memberIds] : [p.id],
      entrance: opts.entrance ?? defaultEntrance,
      returnTo: opts.returnTo ?? defaultReturn,
      automapKey: `${baseLocation}@${id}:${layout.layoutId}`,
      createdAt: nowMs,
      updatedAt: nowMs,
      expiresAt: nowMs + ttlMs,
    });
    saveInstance(inst);
    return inst;
  }

  function movePlayerTo(p, target, label) {
    if (services.portals?.transfer) {
      const portal = services.portals.into?.(target.location) ?? null;
      services.portals.transfer(p, target, { portal, label, returnTo: target.returnTo ?? null });
      return;
    }
    const from = ctx.location(p);
    ctx.dirty(p);
    p.rpg.location = target.location;
    p.x = target.x ?? 0;
    p.z = target.z ?? 0;
    p.yaw = target.yaw ?? 0;
    if (isDungeonLoc(target.location)) {
      p.rpg.portal = {
        from: target.returnTo?.location ?? from,
        to: target.location,
        footY: target.y ?? 0,
        returnTo: target.returnTo ?? null,
      };
    } else {
      delete p.rpg.portal;
    }
    ctx.notify(p, { kind: 'teleport', location: target.location, x: p.x, y: target.y ?? 0, z: p.z, yaw: p.yaw, label });
    ctx.emit('locationChanged', { player: p, from, to: target.location, portal: null });
  }

  function enter(p, baseLocation, opts = {}) {
    const inst = createOrGet(p, baseLocation, opts);
    const st = ensurePlayerInstanceState(p);
    ctx.dirty(p);
    st.active = {
      instanceId: inst.instanceId,
      baseLocation: inst.baseLocation,
      mode: inst.mode,
      layoutId: inst.layoutId,
      layoutMode: inst.layoutMode,
      automapKey: inst.automapKey,
      returnTo: { ...inst.returnTo },
      enteredAt: Math.trunc(ctx.now?.() ?? Date.now()),
    };
    const landing = {
      location: inst.baseLocation,
      x: inst.entrance.x,
      y: inst.entrance.y,
      z: inst.entrance.z,
      yaw: inst.entrance.yaw,
      returnTo: inst.returnTo,
    };
    movePlayerTo(p, landing, `${inst.mode} instance (${inst.layoutMode})`);
    ctx.notify(p, {
      kind: 'instanceState',
      instance: publicView(inst),
      active: st.active,
      recallAnchor: st.recallAnchor,
      text: `Entered ${inst.mode} dungeon instance (${inst.layoutMode}, ${inst.layoutId}).`,
    });
    return inst;
  }

  function leave(p) {
    const st = ensurePlayerInstanceState(p);
    const active = st.active;
    if (!active) throw new Error('You are not inside a tracked dungeon instance.');
    const inst = active.mode === 'public' ? null : instances.get(active.instanceId);
    const returnTo = inst?.returnTo ?? active.returnTo ?? {
      location: active.baseLocation.replace(/^dungeon:/, 'town:'),
      x: 0, y: 0, z: 0, yaw: 0,
    };
    ctx.dirty(p);
    st.active = null;
    movePlayerTo(p, returnTo, 'dungeon exit');
    ctx.notify(p, {
      kind: 'instanceState',
      instance: null,
      active: null,
      recallAnchor: st.recallAnchor,
      text: 'Left the dungeon instance.',
    });
  }

  function activeInstanceOf(p) {
    const active = p?.rpg?.dungeonInstance?.active;
    if (!active) return null;
    if (ctx.location(p) !== active.baseLocation) return null;
    if (active.mode === 'public') return active;
    return instances.get(active.instanceId) ?? null;
  }

  function recoverWipe(p, { toExterior = false } = {}) {
    const st = ensurePlayerInstanceState(p);
    const active = st.active;
    if (!active) throw new Error('No active dungeon instance to recover from.');
    const inst = active.mode === 'public' ? null : instances.get(active.instanceId);
    const targets = [];
    if (inst && inst.mode === 'party') {
      for (const q of ctx.players.values()) {
        if (q.rpg?.dungeonInstance?.active?.instanceId === inst.instanceId) targets.push(q);
      }
    }
    if (!targets.includes(p)) targets.push(p);

    if (inst) {
      inst.wipes += 1;
      saveInstance(inst);
    }

    for (const member of targets) {
      ctx.dirty(member);
      if (typeof services.revivePlayer === 'function') {
        try { services.revivePlayer(member); } catch { /* fallback below */ }
      }
      member.rpg.defeated = false;
      if (member.rpg.character && typeof member.rpg.character === 'object') {
        const maxHp = Math.max(10, Number(member.rpg.character.maxHealth) || 20);
        member.rpg.character.health = Math.max(Math.ceil(maxHp * 0.25), Number(member.rpg.character.health) || 0);
      }
      if (toExterior) {
        member.rpg.dungeonInstance.active = null;
        const ret = inst?.returnTo ?? active.returnTo;
        movePlayerTo(member, ret, 'safe return outside');
      } else {
        const ent = inst?.entrance ?? { x: 0, y: 0, z: 0, yaw: 0 };
        movePlayerTo(member, { location: active.baseLocation, ...ent, returnTo: inst?.returnTo ?? active.returnTo }, 'instance entrance');
      }
      ctx.notify(member, {
        kind: 'instanceRecover',
        instanceId: active.instanceId,
        layoutId: active.layoutId,
        toExterior,
        wipes: inst?.wipes ?? 1,
        text: toExterior
          ? 'Party recovered outside the dungeon entrance.'
          : 'Recovered at the dungeon instance entrance; progress preserved.',
      });
    }
    return { recovered: targets.map((t) => t.id), wipes: inst?.wipes ?? 1 };
  }

  function setRecallAnchor(p) {
    const st = ensurePlayerInstanceState(p);
    const loc = ctx.location(p);
    const active = st.active && st.active.baseLocation === loc ? st.active : null;
    ctx.dirty(p);
    st.recallAnchor = {
      location: loc,
      instanceId: active?.instanceId ?? 'public',
      mode: active?.mode ?? 'public',
      layoutId: active?.layoutId ?? (isDungeonLoc(loc) ? layoutIdFor(loc, st.preferredLayout) : null),
      automapKey: active?.automapKey ?? loc,
      x: Number(p.x) || 0,
      y: Number(p.rpg?.portal?.footY) || 0,
      z: Number(p.z) || 0,
      yaw: Number(p.yaw) || 0,
      returnTo: active?.returnTo ?? p.rpg?.portal?.returnTo ?? null,
      setAt: Math.trunc(ctx.now?.() ?? Date.now()),
    };
    ctx.notify(p, {
      kind: 'instanceRecall',
      action: 'set',
      anchor: st.recallAnchor,
      text: `Recall anchor bound to ${st.recallAnchor.mode} instance (${st.recallAnchor.layoutId ?? loc}).`,
    });
    return st.recallAnchor;
  }

  function returnRecallAnchor(p) {
    const st = ensurePlayerInstanceState(p);
    const anchor = st.recallAnchor;
    if (!anchor) throw new Error('You have no instance Recall anchor set.');
    if (anchor.mode !== 'public') {
      const inst = instances.get(anchor.instanceId);
      if (!inst) throw new Error('Your Recall anchor instance has expired.');
      if (!canAccess(p, inst)) throw new Error('You no longer have access to that Recall anchor instance.');
      if (anchor.layoutId && inst.layoutId !== anchor.layoutId) {
        throw new Error('Recall anchor layout mismatch.');
      }
      ctx.dirty(p);
      st.active = {
        instanceId: inst.instanceId,
        baseLocation: inst.baseLocation,
        mode: inst.mode,
        layoutId: inst.layoutId,
        layoutMode: inst.layoutMode,
        automapKey: inst.automapKey,
        returnTo: { ...inst.returnTo },
        enteredAt: Math.trunc(ctx.now?.() ?? Date.now()),
      };
      saveInstance(inst);
    } else {
      ctx.dirty(p);
      st.active = isDungeonLoc(anchor.location) ? {
        instanceId: 'public',
        baseLocation: anchor.location,
        mode: 'public',
        layoutId: anchor.layoutId,
        layoutMode: String(anchor.layoutId ?? '').startsWith('smaller:') ? 'smaller' : 'classic',
        automapKey: anchor.automapKey,
        returnTo: anchor.returnTo,
        enteredAt: Math.trunc(ctx.now?.() ?? Date.now()),
      } : null;
    }
    movePlayerTo(p, {
      location: anchor.location,
      x: anchor.x,
      y: anchor.y,
      z: anchor.z,
      yaw: anchor.yaw,
      returnTo: anchor.returnTo,
    }, 'Recall anchor');
    ctx.notify(p, {
      kind: 'instanceRecall',
      action: 'return',
      anchor,
      text: `Recalled to ${anchor.mode} instance (${anchor.layoutId ?? anchor.location}).`,
    });
    return anchor;
  }

  function toggleMechanism(p, mechanismId) {
    if (typeof mechanismId !== 'string' || !mechanismId.trim()) throw new Error('Mechanism id required.');
    const active = p.rpg?.dungeonInstance?.active;
    if (!active || active.mode === 'public') {
      throw new Error('Public dungeon mechanisms use standard dungeon.use.');
    }
    const inst = instances.get(active.instanceId);
    if (!inst || !canAccess(p, inst)) throw new Error('You are not inside that dungeon instance.');
    const set = new Set(inst.mechanisms.active);
    const opened = !set.has(mechanismId);
    if (opened) set.add(mechanismId);
    else set.delete(mechanismId);
    inst.mechanisms.active = [...set];
    saveInstance(inst);
    const payload = {
      kind: 'instanceMechanism',
      instanceId: inst.instanceId,
      mechanismId,
      active: opened,
      mechanisms: inst.mechanisms.active,
    };
    ctx.nearby(inst.baseLocation, payload, { scope: services.presenceScope?.(p) ?? null });
    return { mechanismId, active: opened };
  }

  // Chain presenceScope so personal/party instances are isolated from public and from each other.
  const prevPresenceScope = services.presenceScope;
  services.presenceScope = (p) => {
    const base = typeof prevPresenceScope === 'function' ? prevPresenceScope(p) : null;
    const active = p?.rpg?.dungeonInstance?.active;
    if (active && active.mode !== 'public' && ctx.location(p) === active.baseLocation) {
      return base ? `${base}|${active.instanceId}` : active.instanceId;
    }
    return base;
  };

  // Reconcile instance membership on join / reconnect / server restart.
  ctx.onJoin?.((p) => {
    const st = ensurePlayerInstanceState(p);
    const active = st.active;
    if (!active) return;
    if (active.mode === 'public') {
      if (ctx.location(p) !== active.baseLocation) st.active = null;
      return;
    }
    const inst = instances.get(active.instanceId);
    if (!inst || !canAccess(p, inst)) {
      const returnTo = active.returnTo ?? { location: active.baseLocation.replace(/^dungeon:/, 'town:'), x: 0, y: 0, z: 0, yaw: 0 };
      st.active = null;
      p.rpg.location = returnTo.location;
      p.x = returnTo.x ?? 0;
      p.z = returnTo.z ?? 0;
      p.yaw = returnTo.yaw ?? 0;
      delete p.rpg.portal;
      ctx.notify(p, { kind: 'instanceState', instance: null, active: null, text: 'Your dungeon instance expired; returned to the entrance outside.' });
      return;
    }
    ctx.notify(p, { kind: 'instanceState', instance: publicView(inst), active: st.active, recallAnchor: st.recallAnchor, silent: true });
  });

  ctx.onAction?.('instance.select', (p, args) => {
    const mode = String(args?.mode ?? '').toLowerCase();
    if (!MODE_SET.has(mode)) throw new Error('Instance mode must be public, personal, or party.');
    const st = ensurePlayerInstanceState(p);
    ctx.dirty(p);
    st.preferredMode = mode;
    if (args?.layoutMode === 'smaller' || args?.layoutMode === 'classic') {
      st.preferredLayout = args.layoutMode;
    }
    const loc = isDungeonLoc(args?.location) ? args.location : (isDungeonLoc(ctx.location(p)) ? ctx.location(p) : null);
    const layout = loc ? resolveLayout(p, loc, st.preferredLayout) : null;
    ctx.notify(p, {
      kind: 'instanceSelection',
      preferredMode: st.preferredMode,
      preferredLayout: st.preferredLayout,
      layout,
      text: `Dungeon entry set to ${st.preferredMode} (${st.preferredLayout} layout).`,
    });
  });

  ctx.onAction?.('instance.enter', (p, args) => {
    const loc = isDungeonLoc(args?.location)
      ? args.location
      : (isDungeonLoc(ctx.location(p)) ? ctx.location(p) : 'dungeon:Daggerfall/The Dungeon of Peristair');
    enter(p, loc, {
      mode: args?.mode,
      layoutMode: args?.layoutMode,
      instanceId: args?.instanceId,
    });
  });

  ctx.onAction?.('instance.leave', (p) => leave(p));

  ctx.onAction?.('instance.status', (p, args) => {
    const st = ensurePlayerInstanceState(p);
    const inst = activeInstanceOf(p);
    const loc = isDungeonLoc(args?.location) ? args.location : (inst?.baseLocation ?? 'dungeon:Daggerfall/The Dungeon of Peristair');
    const previewLayout = resolveLayout(p, loc, st.preferredLayout);
    ctx.notify(p, {
      kind: 'instanceState',
      preferredMode: st.preferredMode,
      preferredLayout: st.preferredLayout,
      active: st.active,
      instance: inst && inst.mode !== 'public' ? publicView(inst) : (inst ? { ...inst } : null),
      previewLayout,
      recallAnchor: st.recallAnchor,
      silent: true,
    });
  });

  ctx.onAction?.('instance.recover', (p, args) => {
    recoverWipe(p, { toExterior: Boolean(args?.toExterior) });
  });

  ctx.onAction?.('instance.recallSet', (p) => setRecallAnchor(p));
  ctx.onAction?.('instance.recallReturn', (p) => returnRecallAnchor(p));
  ctx.onAction?.('instance.toggleMechanism', (p, args) => toggleMechanism(p, args?.mechanismId));

  services.dungeonInstances = {
    createOrGet,
    enter,
    leave,
    recoverWipe,
    setRecallAnchor,
    returnRecallAnchor,
    toggleMechanism,
    getInstance: (id) => instances.get(id) ?? null,
    activeForPlayer: activeInstanceOf,
    recordEnemyDefeat(p, enemyKey) {
      const inst = activeInstanceOf(p);
      if (!inst || inst.mode === 'public') return false;
      if (!inst.enemiesDefeated.includes(enemyKey)) {
        inst.enemiesDefeated.push(enemyKey);
        saveInstance(inst);
      }
      return true;
    },
    claimLoot(p, lootKey) {
      const inst = activeInstanceOf(p);
      if (!inst || inst.mode === 'public') return false;
      if (inst.lootClaimed[lootKey]) throw new Error('That instance loot has already been claimed.');
      inst.lootClaimed[lootKey] = { by: p.id, at: Math.trunc(ctx.now?.() ?? Date.now()) };
      saveInstance(inst);
      return true;
    },
    placeQuestObject(instanceId, key, placement) {
      const inst = instances.get(instanceId);
      if (!inst) return false;
      inst.questPlacements[key] = { ...placement, layoutId: inst.layoutId };
      saveInstance(inst);
      return true;
    },
    listInstances: () => [...instances.values()].map(publicView),
  };
}
