// Account-scoped Daily Crafting Writs (§3).
// Resets deterministically on UTC day (`YYYY-MM-DD`), shared across all character slots
// of an account, delivered goods consumed on hand-in, rewards paid exactly once.
import { createHash } from 'node:crypto';
import * as inventory from '../inventory.js';
import { PROFESSIONS, registerProfessionItems } from './catalog.js';
import { awardProfessionXp, countEligibleInput } from './crafting.js';

export const WRIT_WORLD_PREFIX = 'prof:writ:';

const WRIT_POOLS = Object.freeze({
  smithing: Object.freeze([
    {
      slug: 'garrison-ingots',
      title: 'Garrison Iron Supply',
      description: 'Deliver freshly smelted iron ingots for the city watch armory.',
      requirements: [{ template: 'iron-ingot', quantity: 2 }],
      reward: { gold: 28, xp: 55 },
    },
    {
      slug: 'caravan-repair-kits',
      title: 'Caravan Maintenance Kits',
      description: 'Supply field repair kits to merchants heading across the Iliac hills.',
      requirements: [{ template: 'field-repair-kit', quantity: 2 }],
      reward: { gold: 34, xp: 65 },
    },
    {
      slug: 'watch-sidearms',
      title: 'Watchman Sidearms',
      description: 'Forge iron daggers and nails for the gate garrison.',
      requirements: [{ template: 'iron-dagger', quantity: 1 }, { template: 'iron-nails', quantity: 4 }],
      reward: { gold: 32, xp: 60 },
    },
  ]),
  carpentry: Object.freeze([
    {
      slug: 'harbor-planks',
      title: 'Harbor Joinery Planks',
      description: 'Mill oak planks for the dockmaster warehouse repairs.',
      requirements: [{ template: 'oak-plank', quantity: 2 }],
      reward: { gold: 24, xp: 50 },
    },
    {
      slug: 'tavern-seating',
      title: 'Innkeeper Furnishings',
      description: 'Craft a sturdy oak chair for a local tavern parlor.',
      requirements: [{ template: 'crafted-oak-chair', quantity: 1 }],
      reward: { gold: 30, xp: 60 },
    },
    {
      slug: 'fletchers-bundle',
      title: 'Watchtower Arrow Stock',
      description: 'Deliver a dozen fletched arrows for the wall archers.',
      requirements: [{ template: 'arrow', quantity: 12 }],
      reward: { gold: 26, xp: 55 },
    },
  ]),
  cooking: Object.freeze([
    {
      slug: 'guard-rations',
      title: 'Nightwatch Supper',
      description: 'Prepare grilled river trout for the evening gate shift.',
      requirements: [{ template: 'grilled-trout', quantity: 2 }],
      reward: { gold: 22, xp: 50 },
    },
    {
      slug: 'scholar-tea',
      title: 'Guildhall Infusion',
      description: 'Steep herbal field tea for visiting Mages Guild scribes.',
      requirements: [{ template: 'herbal-field-tea', quantity: 2 }],
      reward: { gold: 26, xp: 55 },
    },
    {
      slug: 'road-provisions',
      title: 'Courier Trail Biscuits',
      description: "Bake traveler's hardtack for riders bound for Wayrest.",
      requirements: [{ template: 'travelers-hardtack', quantity: 3 }],
      reward: { gold: 24, xp: 52 },
    },
  ]),
});

/** UTC day key `YYYY-MM-DD`. */
export function utcDayKey(nowUtcMs = Date.now()) {
  const d = new Date(Number.isFinite(nowUtcMs) ? nowUtcMs : Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Next UTC midnight timestamp in ms. */
export function nextUtcResetMs(nowUtcMs = Date.now()) {
  const d = new Date(Number.isFinite(nowUtcMs) ? nowUtcMs : Date.now());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/** Stable account key shared across all character slots of an account. */
export function writAccountKey(player) {
  if (player?.accountId != null && String(player.accountId).trim() !== '') {
    return `acct:${String(player.accountId)}`;
  }
  return `char:${player?.id ?? 'unknown'}`;
}

export function writWorldKey(accountKey, utcDay) {
  return `${WRIT_WORLD_PREFIX}${accountKey}:${utcDay}`;
}

function deterministicPick(seed, list) {
  const h = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return list[h % list.length];
}

/**
 * Deterministic daily crafting writs for `utcDay` (one Smithing, one Carpentry, one Cooking).
 */
export function getDailyWrits(utcDay) {
  registerProfessionItems();
  const out = [];
  for (const profession of ['smithing', 'carpentry', 'cooking']) {
    const picked = deterministicPick(`writ:${utcDay}:${profession}`, WRIT_POOLS[profession]);
    const requirements = picked.requirements.map((req) => {
      const desc = inventory.describeTemplate(req.template);
      return Object.freeze({ template: req.template, name: desc.name, quantity: req.quantity });
    });
    out.push(Object.freeze({
      writId: `writ:${utcDay}:${profession}:${picked.slug}`,
      utcDay,
      profession,
      professionName: PROFESSIONS[profession].name,
      title: picked.title,
      description: picked.description,
      requirements: Object.freeze(requirements),
      reward: Object.freeze({ ...picked.reward }),
    }));
  }
  return Object.freeze(out);
}

export function normalizeWritRecord(raw, accountKey, utcDay) {
  if (!raw || typeof raw !== 'object') {
    return { accountKey, utcDay, completed: {} };
  }
  const completed = raw.completed && typeof raw.completed === 'object' ? { ...raw.completed } : {};
  return { accountKey, utcDay, completed };
}

/** Builds the player's view of today's daily crafting writ board. */
export function buildWritBoardView(player, writState, nowUtcMs) {
  const utcDay = utcDayKey(nowUtcMs);
  const resetAt = nextUtcResetMs(nowUtcMs);
  const writs = getDailyWrits(utcDay);
  const completedMap = writState?.completed ?? {};

  return {
    utcDay,
    resetAt,
    resetInMs: Math.max(0, resetAt - nowUtcMs),
    accountScope: player?.accountId != null,
    completedCount: Object.keys(completedMap).length,
    totalCount: writs.length,
    writs: writs.map((w) => {
      const done = completedMap[w.writId] ?? null;
      const requirements = w.requirements.map((req) => {
        const have = countEligibleInput(player.rpg, req.template);
        return { ...req, have, enough: have >= req.quantity };
      });
      return {
        ...w,
        requirements,
        completed: !!done,
        completedBy: done ? { characterId: done.characterId, characterName: done.characterName, completedAt: done.completedAt } : null,
        canTurnIn: !done && requirements.every((r) => r.enough),
      };
    }),
  };
}

/**
 * Validates and executes a daily writ turn-in against `player.rpg` and `writState`.
 * Enforces once-per-UTC-day account allowance, consumes delivered goods via `takeForTransfer('craft')`,
 * and pays gold + profession XP once.
 */
export function executeWritTurnIn(player, rpg, writState, writId, nowUtcMs, opKey = null) {
  registerProfessionItems();
  const utcDay = utcDayKey(nowUtcMs);
  const writs = getDailyWrits(utcDay);
  const writ = writs.find((w) => w.writId === writId);
  if (!writ) {
    const err = new Error('That crafting writ is not active on today’s board.');
    err.code = 'WRIT_NOT_FOUND';
    throw err;
  }
  if (writState.completed[writ.writId]) {
    const prev = writState.completed[writ.writId];
    const err = new Error(`This daily writ was already completed today on your account by ${prev.characterName}.`);
    err.code = 'WRIT_ALREADY_COMPLETED';
    throw err;
  }

  // Verify all required goods exist and are eligible BEFORE consuming anything.
  const plan = [];
  for (const req of writ.requirements) {
    const resolved = inventory.resolveTemplate(req.template);
    let remaining = req.quantity;
    for (const it of rpg.inventory ?? []) {
      if (!it || it.template !== resolved.key) continue;
      if (!inventory.checkItemEligibility(it, 'craft').ok) continue;
      if (remaining <= 0) break;
      const takeQty = Math.min(it.quantity, remaining);
      plan.push({ itemId: it.id, quantity: takeQty });
      remaining -= takeQty;
    }
    if (remaining > 0) {
      const err = new Error(`Need ${req.quantity} × ${req.name} to deliver this writ (have ${req.quantity - remaining}).`);
      err.code = 'MISSING_WRIT_GOODS';
      throw err;
    }
  }

  // Consume delivered items.
  for (const step of plan) {
    inventory.takeForTransfer(rpg, step.itemId, step.quantity, 'craft');
  }

  // Grant gold and character-scoped profession XP.
  inventory.addItem(rpg, 'gold', writ.reward.gold);
  const xpResult = awardProfessionXp(rpg, writ.profession, writ.reward.xp);

  const completionRecord = {
    characterId: player.id,
    characterName: player.name || `Adventurer #${player.id}`,
    completedAt: nowUtcMs,
    opKey: opKey ?? null,
    reward: { ...writ.reward },
  };
  writState.completed[writ.writId] = completionRecord;

  return {
    writId: writ.writId,
    utcDay,
    title: writ.title,
    profession: writ.profession,
    reward: { ...writ.reward },
    xp: xpResult,
    completedBy: { characterId: completionRecord.characterId, characterName: completionRecord.characterName },
  };
}
