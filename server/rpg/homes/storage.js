// Shared container & vault item transfer primitives built on server/rpg/inventory.js.
// Enforces single item eligibility policy, stack merge/split identity rules, pack weight/slot limits,
// and exact conservation across SQLite and PostgreSQL durable transactions.

import {
  MAX_ITEMS,
  MAX_STACK,
  GOLD_PER_KG,
  checkItemEligibility,
  assertItemEligible,
  itemFingerprint,
  canMergeStacks,
  splitStack,
  mergeStacks,
  takeForTransfer,
  insertRecord,
  normalizeRecord,
  normalizeRpg,
  carriedWeight,
  maxEncumbrance,
} from '../inventory.js';

const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);

export function ensurePlayerInventory(rpg) {
  if (!rpg || typeof rpg !== 'object') throw new Error('Invalid character state.');
  if (!Array.isArray(rpg.inventory) || !rpg.equipment || !Number.isFinite(rpg.gold)) {
    normalizeRpg(rpg);
  }
  return rpg;
}

/**
 * Pure helper: inserts a detached item record (or gold) into a container's item list,
 * merging equivalent stackable records when permitted by `canMergeStacks`.
 * Supports either plain item records (home chest) or wrapped vault slots (`{ item, depositedBy, ... }`).
 * Returns `{ list, entry, merged }`.
 */
export function putIntoContainerList(rawList, record, {
  capacity = 100,
  wrapSlot = null,
  unwrapSlot = (s) => s,
  allowGold = true,
} = {}) {
  const list = Array.isArray(rawList) ? rawList.map((e) => structuredClone(e)) : [];
  if (!record || typeof record !== 'object') throw new Error('Invalid item.');

  if (record.template === 'gold') {
    if (!allowGold) {
      const err = new Error('Use the treasury to store gold.');
      err.code = 'GOLD_NOT_ALLOWED';
      throw err;
    }
    const qty = int(record.quantity, 0);
    if (qty < 1) throw new Error('Invalid gold amount.');
    const existing = list.find((e) => unwrapSlot(e)?.template === 'gold');
    if (existing) {
      const target = unwrapSlot(existing);
      if (target.quantity + qty > 1e9) throw new Error('Too much gold in this container.');
      target.quantity += qty;
      return { list, entry: existing, merged: true };
    }
    if (list.length >= capacity) {
      const err = new Error(`Container is full (${capacity} slots).`);
      err.code = 'CONTAINER_FULL';
      throw err;
    }
    const goldRec = { template: 'gold', name: 'Gold pieces', quantity: qty };
    const entry = wrapSlot ? wrapSlot(goldRec) : goldRec;
    list.push(entry);
    return { list, entry, merged: false };
  }

  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error('That item cannot be stored.');
  delete normalized.equipped;

  // Preserve exact original ID & stack quantity from `record` when valid.
  if (typeof record.id === 'string' && /^[\w-]{1,40}$/.test(record.id)) {
    normalized.id = record.id;
  }

  if (normalized.stackable) {
    for (let i = 0; i < list.length; i++) {
      const existingItem = unwrapSlot(list[i]);
      if (existingItem && canMergeStacks(existingItem, normalized)) {
        const mergedItem = mergeStacks(existingItem, normalized);
        if (wrapSlot) {
          list[i] = { ...list[i], item: mergedItem };
        } else {
          list[i] = mergedItem;
        }
        return { list, entry: list[i], merged: true };
      }
    }
  }

  if (list.length >= capacity) {
    const err = new Error(`Container is full (${capacity} slots).`);
    err.code = 'CONTAINER_FULL';
    throw err;
  }
  const entry = wrapSlot ? wrapSlot(normalized) : normalized;
  list.push(entry);
  return { list, entry, merged: false };
}

/**
 * Pure helper: removes `quantity` of `itemId` (or `'gold'`) from a container's list
 * using `splitStack` so full removals preserve original ID and partial removals preserve
 * remaining ID while assigning a fresh ID to the split record.
 */
export function takeFromContainerList(rawList, itemId, quantity = null, {
  unwrapSlot = (s) => s,
  rewrapSlot = (oldSlot, nextItem) => ({ ...oldSlot, item: nextItem }),
  isWrapped = false,
} = {}) {
  const list = Array.isArray(rawList) ? rawList.map((e) => structuredClone(e)) : [];
  const key = String(itemId ?? '');
  const idx = key === 'gold'
    ? list.findIndex((e) => unwrapSlot(e)?.template === 'gold')
    : list.findIndex((e) => unwrapSlot(e)?.id === key);
  if (idx < 0) {
    const err = new Error('That item is no longer in storage.');
    err.code = 'ITEM_NOT_FOUND';
    throw err;
  }
  const slot = list[idx];
  const item = unwrapSlot(slot);
  const avail = int(item.quantity, 1);
  const qty = quantity == null ? avail : int(quantity, 0);
  if (qty < 1 || qty > avail) {
    const err = new Error(`Only ${avail} available in storage.`);
    err.code = 'INVALID_QUANTITY';
    throw err;
  }

  if (item.template === 'gold') {
    const taken = { template: 'gold', name: 'Gold pieces', quantity: qty };
    if (qty === avail) {
      list.splice(idx, 1);
    } else {
      item.quantity = avail - qty;
      list[idx] = isWrapped ? rewrapSlot(slot, item) : item;
    }
    return { list, taken, slot };
  }

  const { remaining, split } = splitStack(item, qty);
  if (remaining) {
    list[idx] = isWrapped ? rewrapSlot(slot, remaining) : remaining;
  } else {
    list.splice(idx, 1);
  }
  return { list, taken: split, slot };
}

/**
 * Checks whether a character's pack can receive `record` (slot cap + encumbrance + duplicate ID guard).
 */
export function assertPackCanReceive(rpg, record, { maxCarryKg = null } = {}) {
  ensurePlayerInventory(rpg);
  const qty = int(record.quantity, 1);
  const addKg = record.template === 'gold'
    ? qty / GOLD_PER_KG
    : (Number(record.weight) || 0) * qty;
  const maxKg = Number.isFinite(maxCarryKg) ? maxCarryKg : maxEncumbrance(rpg);
  if (addKg > 0 && carriedWeight(rpg) + addKg > maxKg + 1e-6) {
    const err = new Error('You cannot carry that much weight.');
    err.code = 'OVER_ENCUMBERED';
    throw err;
  }
  if (record.template === 'gold') {
    if ((rpg.gold || 0) + qty > 1e9) {
      const err = new Error('You cannot carry that much gold.');
      err.code = 'GOLD_CAP';
      throw err;
    }
    return;
  }
  if (record.stackable) {
    const mergeable = rpg.inventory.find((i) => canMergeStacks(i, record));
    if (mergeable) return;
  }
  if (rpg.inventory.length >= MAX_ITEMS) {
    const err = new Error('Your pack cannot hold any more items.');
    err.code = 'PACK_FULL';
    throw err;
  }
}

/**
 * Pure two-sided deposit: removes eligible item from cloned `rpg` and places it into container list.
 * Returns `{ rpg, list, moved, fingerprint }`.
 */
export function applyDepositToContainer(rpgInput, rawList, itemId, quantity, {
  shared = false,
  capacity = 100,
  allowGold = true,
  wrapSlot = null,
  unwrapSlot = (s) => s,
} = {}) {
  const rpg = structuredClone(rpgInput);
  ensurePlayerInventory(rpg);
  const key = String(itemId ?? '');
  let qty;
  if (key === 'gold') {
    if (!allowGold) {
      const err = new Error('Gold cannot be placed in this container.');
      err.code = 'GOLD_NOT_ALLOWED';
      throw err;
    }
    qty = quantity == null ? rpg.gold : int(quantity, 0);
  } else {
    const existing = rpg.inventory.find((i) => i.id === key);
    if (!existing) {
      const err = new Error('You do not have that item.');
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    }
    qty = quantity == null ? int(existing.quantity, 1) : int(quantity, 0);
    assertItemEligible(existing, 'storage', { shared, quantity: qty });
  }

  const moved = takeForTransfer(rpg, key, qty, 'storage', { shared, forbidGold: !allowGold });
  const { list, entry, merged } = putIntoContainerList(rawList, moved, {
    capacity,
    wrapSlot,
    unwrapSlot,
    allowGold,
  });
  return {
    rpg,
    list,
    moved,
    entry,
    merged,
    fingerprint: itemFingerprint(moved),
  };
}

/**
 * Pure two-sided withdrawal: removes item from container list and inserts it into cloned `rpg`.
 * Rejects full pack / over-encumbrance BEFORE returning mutated state.
 */
export function applyWithdrawFromContainer(rpgInput, rawList, itemId, quantity, {
  maxCarryKg = null,
  unwrapSlot = (s) => s,
  rewrapSlot = (oldSlot, nextItem) => ({ ...oldSlot, item: nextItem }),
  isWrapped = false,
} = {}) {
  const rpg = structuredClone(rpgInput);
  ensurePlayerInventory(rpg);
  const { list, taken, slot } = takeFromContainerList(rawList, itemId, quantity, {
    unwrapSlot,
    rewrapSlot,
    isWrapped,
  });
  assertPackCanReceive(rpg, taken, { maxCarryKg });
  const inserted = insertRecord(rpg, taken);
  return {
    rpg,
    list,
    taken,
    inserted,
    slot,
    fingerprint: itemFingerprint(taken),
  };
}

export {
  MAX_ITEMS,
  MAX_STACK,
  checkItemEligibility,
  assertItemEligible,
  itemFingerprint,
  canMergeStacks,
  splitStack,
  mergeStacks,
  takeForTransfer,
  insertRecord,
  normalizeRecord,
};
