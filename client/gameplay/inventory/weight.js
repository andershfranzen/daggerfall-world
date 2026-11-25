/** Increased Weight Allowance, MAGIC.DEF enchantment type 7. */
export function allowanceMultiplier(param) {
  return param === 1 ? 0.5 : param === 0 ? 0.25 : 0;
}

/** FormulaHelper.MaxEncumbrance and DaggerfallEntity.GetMaxEncumbrance, in kilograms. */
export function maxEncumbrance(rpg, strength = rpg?.character?.effectiveAttributes?.Strength ?? rpg?.character?.attributes?.Strength) {
  const base = Math.floor((Number.isFinite(strength) ? strength : 50) * 1.5);
  const equipped = new Set(Object.values(rpg?.equipment ?? {}));
  let extra = 0;
  for (const item of rpg?.inventory ?? []) {
    const effects = item?.magic?.enchantments;
    if (!Array.isArray(effects) || !(item.condition > 0) || !equipped.has(item.id)) continue;
    for (const effect of effects) {
      if (effect?.type === 7) extra = Math.max(extra, allowanceMultiplier(effect.param));
    }
  }
  return base + Math.floor(base * extra);
}
