// Economy anti-exploit balance rules & NPC buyback guard (§3).
// Ensures buying materials from NPC vendors, crafting, and selling outputs back to NPCs
// can NEVER generate an infinite gold loop under any Mercantile/Personality/quality/holiday setting.
import * as inventory from '../inventory.js';
import { buyPrice, sellPrice, priceContext, DEFAULT_QUALITY } from '../../../client/gameplay/economy/rules.js';
import { RECIPES, registerProfessionItems } from './catalog.js';

/**
 * Maximum fraction of base value an NPC shop will pay when buying back a crafted item.
 * Classic Daggerfall Mercantile=100 + holiday discounts can invert naive base values;
 * capping crafted NPC buyback to 35% of base value guarantees materialBuy + fee > npcSell.
 */
export const NPC_CRAFTED_BUYBACK_RATE = 0.30;

/**
 * Computes the safe NPC sell payout for an item, applying the crafted buyback cap
 * whenever `item.crafted` is present (or when auditing crafted recipes).
 */
export function npcSellPriceForCrafted(item, rawSellPrice) {
  const raw = Math.max(0, Math.trunc(Number(rawSellPrice) || 0));
  if (!item || !item.crafted) return raw;
  const qty = Math.max(1, Math.trunc(Number(item.quantity) || 1));
  const unitBase = Math.max(0, Number(item.value) || 0);
  const cap = Math.max(1, Math.floor(unitBase * qty * NPC_CRAFTED_BUYBACK_RATE));
  return Math.min(raw, cap);
}

/**
 * Audits one recipe across a given economy context (or default neutral + extreme contexts).
 * Returns `{ recipeId, inputBaseTotal, outputBaseTotal, fee, buyCost, npcSell, cappedNpcSell, netGold, exploit }`.
 */
export function auditRecipeEconomy(recipe, ctxOpts = {}) {
  registerProfessionItems();
  const pc = priceContext({
    quality: ctxOpts.quality ?? DEFAULT_QUALITY,
    mercantile: ctxOpts.mercantile ?? 50,
    personality: ctxOpts.personality ?? 50,
    ...ctxOpts,
  });
  if (ctxOpts.adjust != null) pc.adjust = ctxOpts.adjust;
  if (ctxOpts.holiday !== undefined) pc.holiday = ctxOpts.holiday;

  let inputBaseTotal = 0;
  let buyCost = 0;
  for (const inp of recipe.inputs) {
    const desc = inventory.describeTemplate(inp.template);
    inputBaseTotal += desc.value * inp.quantity;
    buyCost += buyPrice(desc.value, inp.quantity, pc);
  }
  const outDesc = inventory.describeTemplate(recipe.output.template);
  const outputBaseTotal = outDesc.value * recipe.output.quantity;
  const rawSell = sellPrice(outDesc.value, recipe.output.quantity, pc);
  const cappedSell = npcSellPriceForCrafted(
    { value: outDesc.value, quantity: recipe.output.quantity, crafted: { makerId: 1 } },
    rawSell,
  );
  const totalCost = buyCost + (recipe.fee || 0);
  const netGold = cappedSell - totalCost;
  const baseRatio = outputBaseTotal / Math.max(1, inputBaseTotal + (recipe.fee || 0));

  return {
    recipeId: recipe.id,
    profession: recipe.profession,
    inputBaseTotal,
    outputBaseTotal,
    fee: recipe.fee || 0,
    baseRatio: Math.round(baseRatio * 1000) / 1000,
    buyCost,
    totalCost,
    rawNpcSell: rawSell,
    cappedNpcSell: cappedSell,
    netGold,
    exploit: netGold >= 0 || outputBaseTotal > inputBaseTotal + (recipe.fee || 0),
  };
}

/**
 * Runs a full sweep over every recipe across standard, high-Mercantile, high-quality,
 * low-quality, and holiday-discount scenarios. Returns `{ ok, violations, checked }`.
 */
export function auditAllRecipes(scenarios = null) {
  const matrix = scenarios ?? [
    { label: 'neutral', quality: 10, mercantile: 25, personality: 50, adjust: 1000, holiday: null },
    { label: 'novice', quality: 10, mercantile: 0, personality: 30, adjust: 1000, holiday: null },
    { label: 'master-trader', quality: 10, mercantile: 100, personality: 100, adjust: 1000, holiday: null },
    { label: 'low-quality-shop', quality: 1, mercantile: 100, personality: 100, adjust: 1000, holiday: null },
    { label: 'high-quality-shop', quality: 20, mercantile: 100, personality: 100, adjust: 1000, holiday: null },
    { label: 'low-region', quality: 10, mercantile: 100, personality: 100, adjust: 250, holiday: null },
    { label: 'high-region', quality: 10, mercantile: 100, personality: 100, adjust: 4000, holiday: null },
    { label: 'holiday-extreme', quality: 1, mercantile: 100, personality: 100, adjust: 1000, holiday: 'NorthWindsPrayer' },
  ];
  const violations = [];
  let checked = 0;
  for (const s of matrix) {
    for (const r of RECIPES) {
      checked++;
      const res = auditRecipeEconomy(r, s);
      if (res.exploit) violations.push({ scenario: s.label, ...res });
    }
  }
  return { ok: violations.length === 0, violations, checked };
}
