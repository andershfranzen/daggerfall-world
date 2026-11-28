// Repeatable group PvE Delves and Boss Encounters (§9).
//
// Features:
//   - Delve board & map entry listing active and resettable group PvE encounters.
//   - Dynamic participant scaling: boss HP, threat, and bonus rewards scale smoothly
//     with active participant count as players join publicly.
//   - Contributor rewards paid once per run per qualifying contributor, persisted in
//     `delves/` world state + `rpg.delves.claimedRuns`.
//   - Strictly separate from the classic dungeon `containers/` treasure ledger: resetting
//     or completing a delve never alters or restocks classic dungeon treasure piles.
//   - Restart recovery: active delve runs, boss HP, and contributor credits reload cleanly
//     from `ctx.loadWorld('delves/')` after a server restart.
//
// Actions:
//   delve.board    {}
//   delve.status   { delveId? }
//   delve.join     { delveId }
//   delve.leave    { delveId }
//   delve.engage   { delveId, damage?, support? }
//   delve.claim    { delveId, runId? }
//   delve.reset    { delveId }
//
// Services (ctx.services.delves):
//   catalog, getRun, join, engage, claim, resetRun, scaleForParticipants

import { randomBytes } from 'node:crypto';

export const name = 'delves';
export const WORLD_PREFIX = 'delves/';
export const DEFAULT_RESET_MS = 15 * 60_000;
export const MIN_CONTRIBUTION = 10;

export const DELVE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'delve-peristair-crypt',
    title: 'Vault of the Ash Warden',
    region: 'Daggerfall',
    site: 'dungeon:Daggerfall/The Dungeon of Peristair',
    mapCoords: { x: 42, z: -64 },
    bossName: 'Ash Warden Malakor',
    bossMonsterId: 19,
    baseHp: 240,
    baseGold: 220,
    baseRenown: 25,
    rewardItem: { template: 'potion-of-healing', name: 'Warden’s Elixir', quantity: 1 },
    resetMs: DEFAULT_RESET_MS,
    summary: 'A repeatable subterranean boss encounter open to public groups.',
  }),
  Object.freeze({
    id: 'delve-gothway-catacombs',
    title: 'Gothway Hollows Breach',
    region: 'Daggerfall',
    site: 'town:Daggerfall/Gothway Garden',
    mapCoords: { x: -18, z: 26 },
    bossName: 'Hollows Reaver',
    bossMonsterId: 7,
    baseHp: 180,
    baseGold: 150,
    baseRenown: 15,
    rewardItem: null,
    resetMs: DEFAULT_RESET_MS,
    summary: 'Repel the recurring raider warband gathering outside Gothway Garden.',
  }),
  Object.freeze({
    id: 'delve-sentinel-tomb',
    title: 'Sunken Reliquary of Alik’r',
    region: "Alik'r Desert",
    site: "town:Alik'r Desert/The Stuvam Graveyard",
    mapCoords: { x: 10, z: -22 },
    bossName: 'Dune Lich',
    bossMonsterId: 26,
    baseHp: 320,
    baseGold: 340,
    baseRenown: 40,
    rewardItem: { template: 'steel-dagger', name: 'Reliquary Blade', quantity: 1 },
    resetMs: DEFAULT_RESET_MS,
    summary: 'Confront the restless Dune Lich with scaled group rewards.',
  }),
]);

const CATALOG_BY_ID = new Map(DELVE_CATALOG.map((d) => [d.id, d]));

/** Scales boss stats and group bonus cleanly by active participant count. */
export function scaleForParticipants(baseHp, participantCount) {
  const n = Math.max(1, Math.min(12, Math.trunc(Number(participantCount) || 1)));
  const hpMultiplier = 1 + (n - 1) * 0.55;
  const maxHp = Math.round(baseHp * hpMultiplier);
  const damageMultiplier = Math.round((1 + (n - 1) * 0.15) * 100) / 100;
  const rewardMultiplier = Math.round((1 + Math.min(n - 1, 5) * 0.1) * 100) / 100;
  return { participants: n, hpMultiplier: Math.round(hpMultiplier * 100) / 100, maxHp, damageMultiplier, rewardMultiplier };
}

function ensurePlayerDelveState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.delves;
  if (!cur || typeof cur !== 'object') {
    p.rpg.delves = { activeDelveId: null, claimedRuns: {}, totalClears: 0 };
  } else {
    if (!cur.claimedRuns || typeof cur.claimedRuns !== 'object') cur.claimedRuns = {};
    if (!Number.isFinite(cur.totalClears)) cur.totalClears = 0;
  }
  return p.rpg.delves;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const resetMsOverride = Number.isFinite(options.resetMs) ? options.resetMs : null;
  const runs = new Map(); // delveId -> run state

  function freshRun(def) {
    const nowMs = Math.trunc(ctx.now?.() ?? Date.now());
    const scaling = scaleForParticipants(def.baseHp, 1);
    return {
      delveId: def.id,
      runId: `run_${randomBytes(4).toString('hex')}`,
      status: 'open', // 'open' | 'active' | 'defeated'
      participants: [],
      contributions: {}, // playerId -> total damage + support credit
      claimedBy: [],
      bossHp: scaling.maxHp,
      bossMaxHp: scaling.maxHp,
      scaling,
      startedAt: nowMs,
      defeatedAt: null,
      resetAt: null,
      ledgerNamespace: 'delves', // explicitly distinct from classic `containers/`
    };
  }

  function hydrateRun(def, raw) {
    if (!raw || typeof raw !== 'object') return freshRun(def);
    const participants = Array.isArray(raw.participants) ? [...new Set(raw.participants.map(Number).filter(Number.isSafeInteger))] : [];
    const scaling = scaleForParticipants(def.baseHp, Math.max(1, participants.length));
    const maxHp = Math.max(1, Number(raw.bossMaxHp) || scaling.maxHp);
    const hp = Math.max(0, Math.min(maxHp, Number(raw.bossHp ?? maxHp)));
    return {
      delveId: def.id,
      runId: String(raw.runId || `run_${randomBytes(4).toString('hex')}`),
      status: raw.status === 'active' || raw.status === 'defeated' ? raw.status : 'open',
      participants,
      contributions: raw.contributions && typeof raw.contributions === 'object' ? { ...raw.contributions } : {},
      claimedBy: Array.isArray(raw.claimedBy) ? [...new Set(raw.claimedBy.map(Number).filter(Number.isSafeInteger))] : [],
      bossHp: hp,
      bossMaxHp: maxHp,
      scaling,
      startedAt: Number(raw.startedAt) || 0,
      defeatedAt: Number.isFinite(raw.defeatedAt) ? raw.defeatedAt : null,
      resetAt: Number.isFinite(raw.resetAt) ? raw.resetAt : null,
      ledgerNamespace: 'delves',
    };
  }

  // Load persisted runs across restarts
  const loaded = new Map();
  for (const [k, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    loaded.set(k.slice(WORLD_PREFIX.length), v);
  }
  for (const def of DELVE_CATALOG) {
    runs.set(def.id, hydrateRun(def, loaded.get(def.id)));
  }

  function saveRun(run) {
    const prev = runs.has(run.delveId) ? structuredClone(runs.get(run.delveId)) : null;
    runs.set(run.delveId, run);
    ctx.dirtyWorld?.(`${WORLD_PREFIX}${run.delveId}`, run);
    ctx.onRollback?.(() => {
      if (prev) runs.set(run.delveId, prev);
    });
  }

  function maybeAutoReset(def, run) {
    const nowMs = Math.trunc(ctx.now?.() ?? Date.now());
    if (run.status === 'defeated' && run.resetAt != null && nowMs >= run.resetAt) {
      const next = freshRun(def);
      saveRun(next);
      return next;
    }
    return run;
  }

  function getRun(delveId) {
    const def = CATALOG_BY_ID.get(String(delveId ?? ''));
    if (!def) throw new Error('Unknown delve encounter.');
    const cur = runs.get(def.id) ?? freshRun(def);
    return { def, run: maybeAutoReset(def, cur) };
  }

  function rescaleBoss(def, run) {
    const prevMax = Math.max(1, run.bossMaxHp);
    const ratio = run.bossHp / prevMax;
    const scaling = scaleForParticipants(def.baseHp, Math.max(1, run.participants.length));
    run.scaling = scaling;
    run.bossMaxHp = scaling.maxHp;
    run.bossHp = run.status === 'defeated' ? 0 : Math.max(1, Math.round(scaling.maxHp * ratio));
  }

  function runView(def, run, viewerId) {
    const myCredit = Number(run.contributions[viewerId] ?? 0);
    return {
      id: def.id,
      title: def.title,
      region: def.region,
      site: def.site,
      mapCoords: def.mapCoords,
      summary: def.summary,
      bossName: def.bossName,
      runId: run.runId,
      status: run.status,
      bossHp: run.bossHp,
      bossMaxHp: run.bossMaxHp,
      participantCount: run.participants.length,
      participants: [...run.participants],
      scaling: { ...run.scaling },
      myContribution: myCredit,
      eligibleForReward: run.status === 'defeated' && myCredit >= MIN_CONTRIBUTION && !run.claimedBy.includes(viewerId),
      claimed: run.claimedBy.includes(viewerId),
      resetAt: run.resetAt,
      baseGold: def.baseGold,
      baseRenown: def.baseRenown,
      ledgerNamespace: run.ledgerNamespace,
    };
  }

  function boardFor(p) {
    return DELVE_CATALOG.map((def) => {
      const { run } = getRun(def.id);
      return runView(def, run, p.id);
    });
  }

  function join(p, delveId) {
    const { def, run } = getRun(delveId);
    if (run.status === 'defeated') {
      throw new Error(`${def.title} is resetting. Claim rewards or wait for the next run.`);
    }
    const already = run.participants.includes(p.id);
    if (!already) {
      run.participants.push(p.id);
      if (run.contributions[p.id] == null) run.contributions[p.id] = 0;
      if (run.status === 'open') run.status = 'active';
      rescaleBoss(def, run);
      saveRun(run);
    }
    ctx.dirty(p);
    ensurePlayerDelveState(p).activeDelveId = def.id;
    ctx.notify(p, {
      kind: 'delveState',
      delve: runView(def, run, p.id),
      board: boardFor(p),
      text: `Joined delve "${def.title}" (${run.participants.length} active; ${def.bossName} scaled to ${run.bossMaxHp} HP).`,
    });
    return run;
  }

  function leave(p, delveId) {
    const { def, run } = getRun(delveId);
    run.participants = run.participants.filter((id) => id !== p.id);
    if (run.status === 'active' && run.participants.length === 0) run.status = 'open';
    rescaleBoss(def, run);
    saveRun(run);
    ctx.dirty(p);
    const st = ensurePlayerDelveState(p);
    if (st.activeDelveId === def.id) st.activeDelveId = null;
    ctx.notify(p, {
      kind: 'delveState',
      delve: runView(def, run, p.id),
      board: boardFor(p),
      text: `Left delve "${def.title}".`,
    });
  }

  function engage(p, delveId, { damage = 25, support = 0 } = {}) {
    const { def, run } = getRun(delveId);
    if (run.status === 'defeated') throw new Error(`${def.bossName} has already fallen in this run.`);
    if (!run.participants.includes(p.id)) {
      run.participants.push(p.id);
      if (run.status === 'open') run.status = 'active';
      rescaleBoss(def, run);
    }
    const dmg = Math.max(0, Math.min(run.bossMaxHp, Math.trunc(Number(damage) || 0)));
    const sup = Math.max(0, Math.min(200, Math.trunc(Number(support) || 0)));
    const credit = dmg + sup;
    if (credit <= 0) throw new Error('Deliver damage or support to contribute to the delve.');

    run.contributions[p.id] = (Number(run.contributions[p.id]) || 0) + credit;
    run.bossHp = Math.max(0, run.bossHp - dmg);

    if (run.bossHp === 0) {
      const nowMs = Math.trunc(ctx.now?.() ?? Date.now());
      run.status = 'defeated';
      run.defeatedAt = nowMs;
      run.resetAt = nowMs + (resetMsOverride ?? def.resetMs);
    }
    saveRun(run);

    for (const id of run.participants) {
      const q = ctx.players.get(id);
      if (!q) continue;
      ctx.notify(q, {
        kind: 'delveState',
        delve: runView(def, run, q.id),
        board: boardFor(q),
        text: run.status === 'defeated'
          ? `${def.bossName} defeated! Qualifying contributors may now claim delve rewards.`
          : `${p.name} struck ${def.bossName} for ${dmg} (${run.bossHp}/${run.bossMaxHp} HP).`,
      });
    }
    return run;
  }

  function claim(p, delveId) {
    const { def, run } = getRun(delveId);
    if (run.status !== 'defeated') throw new Error(`Defeat ${def.bossName} before claiming delve rewards.`);
    const st = ensurePlayerDelveState(p);
    if (run.claimedBy.includes(p.id) || st.claimedRuns[run.runId]) {
      throw new Error('You have already claimed your reward for this delve run.');
    }
    const credit = Number(run.contributions[p.id] ?? 0);
    if (credit < MIN_CONTRIBUTION) {
      throw new Error(`Contribute at least ${MIN_CONTRIBUTION} damage/support to earn delve rewards.`);
    }

    const gold = Math.round(def.baseGold * run.scaling.rewardMultiplier);
    const renown = Math.round(def.baseRenown * run.scaling.rewardMultiplier);
    ctx.dirty(p);
    if (typeof services.addGold === 'function') services.addGold(p, gold);
    else p.rpg.gold = (Number(p.rpg.gold) || 0) + gold;

    let item = null;
    if (def.rewardItem) {
      if (typeof services.giveItem === 'function') {
        try {
          item = services.giveItem(p, def.rewardItem.template, { quantity: def.rewardItem.quantity ?? 1, name: def.rewardItem.name });
        } catch { /* fallback below */ }
      }
      if (!item) {
        if (!Array.isArray(p.rpg.inventory)) p.rpg.inventory = [];
        item = {
          id: `delve_${run.runId}_${p.id}_${randomBytes(2).toString('hex')}`,
          template: def.rewardItem.template,
          name: def.rewardItem.name,
          quantity: def.rewardItem.quantity ?? 1,
          source: 'delve',
        };
        p.rpg.inventory.push(item);
      }
    }
    services.optionalRules?.awardRenown?.(p, renown, `delve:${def.id}`);

    run.claimedBy.push(p.id);
    st.claimedRuns[run.runId] = { delveId: def.id, gold, renown, itemId: item?.id ?? null, claimedAt: Math.trunc(ctx.now?.() ?? Date.now()) };
    st.totalClears += 1;
    saveRun(run);

    ctx.notify(p, {
      kind: 'delveClaim',
      delveId: def.id,
      runId: run.runId,
      gold,
      renown,
      item,
      delve: runView(def, run, p.id),
      board: boardFor(p),
      text: `Claimed ${gold} gold and ${renown} Renown from "${def.title}".`,
    });
    return { runId: run.runId, gold, renown, item };
  }

  function resetRun(delveId) {
    const def = CATALOG_BY_ID.get(String(delveId ?? ''));
    if (!def) throw new Error('Unknown delve encounter.');
    const next = freshRun(def);
    saveRun(next);
    return next;
  }

  ctx.onTick?.(() => {
    const nowMs = Math.trunc(ctx.now?.() ?? Date.now());
    for (const def of DELVE_CATALOG) {
      const cur = runs.get(def.id);
      if (cur && cur.status === 'defeated' && cur.resetAt != null && nowMs >= cur.resetAt) {
        saveRun(freshRun(def));
      }
    }
  });

  ctx.onJoin?.((p) => {
    ensurePlayerDelveState(p);
  });

  ctx.onAction?.('delve.board', (p) => {
    ctx.notify(p, { kind: 'delveBoard', board: boardFor(p), silent: true });
  });

  ctx.onAction?.('delve.status', (p, args) => {
    const id = args?.delveId ?? ensurePlayerDelveState(p).activeDelveId ?? DELVE_CATALOG[0].id;
    const { def, run } = getRun(id);
    ctx.notify(p, { kind: 'delveState', delve: runView(def, run, p.id), board: boardFor(p), silent: true });
  });

  ctx.onAction?.('delve.join', (p, args) => join(p, args?.delveId));
  ctx.onAction?.('delve.leave', (p, args) => leave(p, args?.delveId));
  ctx.onAction?.('delve.engage', (p, args) => engage(p, args?.delveId, { damage: args?.damage ?? 25, support: args?.support ?? 0 }));
  ctx.onAction?.('delve.claim', (p, args) => claim(p, args?.delveId));
  ctx.onAction?.('delve.reset', (p, args) => {
    const next = resetRun(args?.delveId);
    const def = CATALOG_BY_ID.get(next.delveId);
    ctx.notify(p, {
      kind: 'delveState',
      delve: runView(def, next, p.id),
      board: boardFor(p),
      text: `Delve "${def.title}" reset for a new repeatable run (${next.runId}).`,
    });
  });

  services.delves = {
    catalog: DELVE_CATALOG,
    scaleForParticipants,
    getRun: (id) => getRun(id).run,
    join,
    leave,
    engage,
    claim,
    resetRun,
  };
}
