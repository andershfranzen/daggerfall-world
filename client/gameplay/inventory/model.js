// Pure view-model helpers for the inventory screen (no DOM), shared with tests.

export { maxEncumbrance } from './weight.js';

/** Classic inventory tabs. */
export const TABS = Object.freeze([
  { id: 'weapons', label: 'Weapons & Armor', key: 'W', groups: ['weapon', 'armor', 'shield', 'ammo'] },
  { id: 'magic', label: 'Magic Items', key: 'M', groups: ['potion'] },
  { id: 'clothing', label: 'Clothing & Misc', key: 'C', groups: ['clothing', 'misc', 'book', 'letter', 'light', 'jewellery', 'religious', 'drug', 'map', 'painting', 'quest'] },
  { id: 'ingredients', label: 'Ingredients', key: 'N', groups: ['gem', 'ingredient'] },
]);

export const SLOT_ORDER = Object.freeze([
  ['head', 'Head'], ['rightArm', 'Right pauldron'], ['leftArm', 'Left pauldron'], ['chestArmor', 'Chest'],
  ['gloves', 'Hands'], ['legsArmor', 'Legs'], ['feet', 'Feet'], ['rightHand', 'Right hand'], ['leftHand', 'Left hand'],
  ['cloak', 'Cloak'], ['chestClothes', 'Shirt'], ['legsClothes', 'Trousers'],
  ['amulet0', 'Amulet'], ['amulet1', 'Second amulet'], ['bracer0', 'Bracer'], ['bracer1', 'Second bracer'],
  ['ring0', 'Ring'], ['ring1', 'Second ring'], ['bracelet0', 'Bracelet'], ['bracelet1', 'Second bracelet'],
  ['mark0', 'Mark'], ['mark1', 'Second mark'],
]);
/** Jewellery template index -> slot pair (mirrors server/rpg/inventory.js JEWEL_SLOTS). */
const JEWEL_SLOTS = Object.freeze({ 133: ['amulet0', 'amulet1'], 138: ['amulet0', 'amulet1'], 139: ['amulet0', 'amulet1'],
  134: ['bracer0', 'bracer1'], 135: ['ring0', 'ring1'], 136: ['bracelet0', 'bracelet1'], 137: ['mark0', 'mark1'] });
export const jewelSlots = (it) => (it?.group === 'jewellery' ? JEWEL_SLOTS[it.index] ?? null : null);
/** Enchanted items with a Used payload: Cast When Used, or the Rose, Oghma, Skull and a filled Azura's Star. */
export const hasUsePower = (it) => !!it?.magic?.enchantments?.some?.((e) => e && (e.type === 0 || (e.type === 26 && [4, 5, 8, 9].includes(e.param))));
export const BODY_PARTS = Object.freeze([
  ['head', 'Head'], ['rightArm', 'Right arm'], ['leftArm', 'Left arm'], ['chest', 'Chest'], ['hands', 'Hands'], ['legs', 'Legs'], ['feet', 'Feet'],
]);

/** Classic enchantment type labels (mirrors server/rpg/alchemy/enchantments.js). */
const ENCHANTMENT_LABELS = Object.freeze({
  0: ['Cast When Used'],
  1: ['Cast When Held'],
  2: ['Cast When Strikes'],
  3: ['Extra Spell Pts', { 0: 'Winter', 1: 'Spring', 2: 'Summer', 3: 'Fall', 4: 'Full Moon', 5: 'Half Moon', 6: 'New Moon', 7: 'Near Undead', 8: 'Near Daedra', 9: 'Near Humanoids', 10: 'Near Animals' }],
  4: ['Potent vs', { 0: 'Undead', 1: 'Daedra', 2: 'Humanoids', 3: 'Animals' }],
  5: ['Regens Health', { 0: 'always', 1: 'in sunlight', 2: 'in darkness' }],
  6: ['Vampiric Effect', { 0: 'at range', 1: 'on strike' }],
  7: ['Weight Allowance', { 0: '+25%', 1: '+50%' }],
  8: ['Repairs Objects'],
  9: ['Absorbs Spells'],
  10: ['Enhances Skill'],
  11: ['Feather Weight'],
  12: ['Strengthens Armor'],
  13: ['Improves Talents', { 0: 'Hearing', 1: 'Athleticism', 2: 'Adrenaline Rush' }],
  14: ['Good Rep', { 0: 'Commoners', 1: 'Merchants', 2: 'Scholars', 3: 'Nobility', 4: 'Underworld', 5: 'All' }],
  15: ['Soul Bound'],
  16: ['Item Deteriorates', { 0: 'always', 1: 'in sunlight', 2: 'in holy places' }],
  17: ['User Takes Damage', { 0: 'in sunlight', 1: 'in holy places' }],
  18: ['Vision Problems'],
  19: ['Walking Problems'],
  20: ['Low Damage vs', { 0: 'Undead', 1: 'Daedra', 2: 'Humanoids', 3: 'Animals' }],
  21: ['Health Leech', { 0: 'when used', 1: 'unless used daily', 2: 'unless used weekly' }],
  22: ['Bad Reactions', { 0: 'Humanoids', 1: 'Animals', 2: 'Daedra' }],
  23: ['Extra Weight'],
  24: ['Weakens Armor'],
  25: ['Bad Rep', { 0: 'Commoners', 1: 'Merchants', 2: 'Scholars', 3: 'Nobility', 4: 'Underworld', 5: 'All' }],
  26: ['Artifact Power'],
});

/** Human-readable enchantment effect strings for an item (empty array when non-magical). */
export function enchantmentEffects(it) {
  if (!it?.magic) return [];
  if (it.magic.identified === false) return ['Unidentified'];
  const list = (it.magic.enchantments || []).filter((e) => e && e.type >= 0);
  if (!list.length) return ['Enchanted'];
  return list.map((e) => {
    if (e.label) return String(e.label);
    const spec = ENCHANTMENT_LABELS[e.type];
    if (!spec) return `Effect #${e.type}`;
    const [base, params] = spec;
    const detail = params?.[e.param];
    return detail ? `${base} (${detail})` : base;
  });
}

/** One-line enchantment summary for tables and search. */
export function enchantmentSummary(it) {
  const fx = enchantmentEffects(it);
  return fx.length ? fx.join(', ') : '';
}

/** Magic item charge count (condition/maxCondition on enchanted items), or null. */
export function itemCharges(it) {
  if (!it?.magic) return null;
  const max = Number(it.maxCondition ?? it.magic.uses);
  if (!(max > 0)) return null;
  const current = Math.max(0, Math.min(max, Number(it.condition ?? max)));
  return { current, max };
}

// Enchanted items (item.magic) belong on the Magic Items tab whatever their base group, as in the classic window.
export const tabOf = (item) => (item?.magic && !['weapon', 'armor', 'shield', 'clothing'].includes(item.group) ? 'magic'
  : TABS.find((t) => t.groups.includes(item.group))?.id ?? 'clothing');

export function matchesQuery(item, query = '') {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    item?.name,
    item?.material,
    item?.skill,
    item?.dye,
    kindOf(item),
    enchantmentSummary(item),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

export function itemsForTab(inventory, tab, query = '') {
  return (inventory || [])
    .filter((i) => i && (tab === 'all' || tabOf(i) === tab) && matchesQuery(i, query))
    .sort((a, b) => (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
}

export function carriedWeight(rpg) {
  let kg = 0;
  for (const i of rpg?.inventory || []) kg += (Number(i.weight) || 0) * (Number(i.quantity) || 1);
  return Math.round((kg + (Number(rpg?.gold) || 0) / 400) * 100) / 100;
}

export function armorValues(rpg) {
  const out = Object.fromEntries(BODY_PARTS.map(([p]) => [p, 0]));
  const inv = rpg?.inventory || [];
  for (const id of Object.values(rpg?.equipment || {})) {
    const it = inv.find((i) => i.id === id);
    for (const part of it?.covers || []) if (part in out) out[part] += it.armorValue || 0;
  }
  return out;
}

export function conditionLabel(it) {
  if (!it?.maxCondition) return '';
  const pct = (100 * it.condition) / it.maxCondition;
  if (pct >= 92) return 'New';
  if (pct >= 76) return 'Almost new';
  if (pct >= 61) return 'Slightly used';
  if (pct >= 41) return 'Used';
  if (pct >= 16) return 'Worn';
  if (pct > 0) return 'Battered';
  return 'Broken';
}

/** Detail rows [label, value] for an item. */
export function describe(it) {
  const rows = [];
  if (it.material) rows.push(['Material', it.material[0].toUpperCase() + it.material.slice(1)]);
  if (it.dye) rows.push(['Colour', it.dye[0].toUpperCase() + it.dye.slice(1)]);
  if (it.group === 'clothing' && it.variants > 1) rows.push(['Style', `${(it.variant | 0) + 1} of ${it.variants}`]);
  if (it.damage) rows.push(['Damage', `${it.damage.min}–${it.damage.max}${it.materialModifier ? ` ${it.materialModifier > 0 ? '+' : '−'}${Math.abs(it.materialModifier)}` : ''}`]);
  if (it.skill) rows.push(['Skill', it.skill]);
  if (it.hands) rows.push(['Hands', it.hands === 'both' ? 'Two-handed' : it.hands === 'left' ? 'Left hand' : 'One-handed']);
  if (it.armorValue != null) rows.push(['Armor', String(it.armorValue)]);
  if (it.effect) rows.push(['Effect', `Restores ${it.effect.amount} ${it.effect.stat}`]);
  if (it.magic) {
    rows.push(['Magic', enchantmentSummary(it)]);
    const ch = itemCharges(it);
    if (ch) rows.push(['Charges', `${ch.current} / ${ch.max}`]);
  }
  if (it.author) rows.push(['Author', it.author]);
  if (it.light) rows.push(['Light', `Radius ${it.light.radius}, ${it.condition} of ${it.maxCondition} burn left`]);
  if (it.stolen) rows.push(['Note', 'Stolen']);
  if (it.maxCondition > 1) rows.push(['Condition', `${conditionLabel(it)} (${it.condition}/${it.maxCondition})`]);
  rows.push(['Weight', `${(it.weight * (it.quantity || 1)).toFixed(2)} kg`]);
  rows.push(['Value', `${it.value * (it.quantity || 1)} gold`]);
  if (it.quantity > 1) rows.push(['Quantity', String(it.quantity)]);
  if (it.equipped) rows.push(['Equipped', SLOT_ORDER.find(([s]) => s === it.equipped)?.[1] ?? it.equipped]);
  return rows;
}

/** Primary action for an item: {verb,label} or null. */
export function primaryAction(it, lit = null) {
  if (!it) return null;
  if (['weapon', 'armor', 'shield', 'clothing'].includes(it.group) || jewelSlots(it)) {
    if (it.equipped) return { verb: 'inventory.unequip', label: 'Unequip', args: { itemId: it.id } };
    if (it.condition === 0) return null;
    return { verb: 'inventory.equip', label: 'Equip', args: { itemId: it.id } };
  }
  if (it.group === 'potion') return { verb: 'inventory.use', label: 'Drink', args: { itemId: it.id } };
  if (it.group === 'book' && hasUsePower(it)) return { verb: 'inventory.use', label: 'Use', args: { itemId: it.id } };
  if (it.group === 'book' || it.letter) return { verb: 'inventory.read', label: 'Read', args: { itemId: it.id } };
  if (it.group === 'light') {
    if (it.condition === 0) return null;
    return { verb: 'inventory.light', label: lit?.itemId === it.id ? 'Douse' : 'Light', args: { itemId: it.id } };
  }
  // Classic map items (template 287): reading one records a place of the current region (server/rpg/items/mapItem.js).
  if (it.group === 'map' || it.template === 'map') return { verb: 'inventory.use', label: 'Read map', args: { itemId: it.id } };
  if (it.template === 'oil') return { verb: 'inventory.use', label: 'Refuel lantern', args: { itemId: it.id } };
  if (it.magic) return { verb: 'inventory.use', label: 'Use', args: { itemId: it.id } };
  return null;
}

// ------------------------------------------------------------------ equipping previews
// These mirror server/rpg/inventory.js `canOccupy`, `equip` and `unequip` so the screen can show
// what an action will change before it is sent. The server stays authoritative.

export const WEARABLE_GROUPS = Object.freeze(['weapon', 'armor', 'shield', 'clothing']);
export const isWearable = (it) => !!it && (WEARABLE_GROUPS.includes(it.group) || !!jewelSlots(it));
export const slotLabel = (slot) => SLOT_ORDER.find(([s]) => s === slot)?.[1] ?? slot;

/** Body part whose armour rating a slot row shows (armour slots only). */
export const SLOT_PART = Object.freeze({
  head: 'head', rightArm: 'rightArm', leftArm: 'leftArm', chestArmor: 'chest', gloves: 'hands', legsArmor: 'legs', feet: 'feet',
});

export function fitsSlot(it, slot) {
  if (!isWearable(it)) return false;
  if (it.group === 'weapon') return slot === 'rightHand' || (slot === 'leftHand' && it.hands === 'either');
  if (it.group === 'jewellery') return !!jewelSlots(it)?.includes(slot);
  return it.slot === slot;
}

/** Slots an item can go in, preferred first. */
export const slotsFor = (it) => SLOT_ORDER.map(([s]) => s).filter((s) => fitsSlot(it, s))
  .sort((a, b) => (b === (it?.slot ?? jewelSlots(it)?.[0] ?? 'rightHand')) - (a === (it?.slot ?? jewelSlots(it)?.[0] ?? 'rightHand')));

const itemIn = (rpg, slot) => (rpg?.inventory || []).find((i) => i.id === rpg?.equipment?.[slot]) || null;

/** Copy of `{inventory, equipment}` after equipping `itemId` (in `slot`), plus the items it takes off. */
export function previewEquip(rpg, itemId, slot) {
  const inventory = (rpg?.inventory || []).map((i) => ({ ...i }));
  const equipment = { ...(rpg?.equipment || {}) };
  const next = { ...rpg, inventory, equipment };
  const it = inventory.find((i) => i.id === itemId);
  if (!it || !isWearable(it)) return { rpg: next, removed: [], slot: null };
  const pair = jewelSlots(it);
  slot = slot ?? (pair ? (pair.includes(it.equipped) ? it.equipped : pair.find((s) => !equipment[s]) ?? pair[0]) : it.slot ?? 'rightHand');
  if (!fitsSlot(it, slot)) return { rpg: next, removed: [], slot: null };
  const removed = [];
  const free = (s) => {
    const cur = itemIn(next, s);
    if (cur && cur.id !== it.id) removed.push(cur);
    if (cur) delete cur.equipped;
    delete equipment[s];
  };
  if (it.equipped && it.equipped !== slot) free(it.equipped);
  free(slot);
  if (it.hands === 'both') free('leftHand');
  if (slot === 'leftHand' && itemIn(next, 'rightHand')?.hands === 'both') free('rightHand');
  equipment[slot] = it.id;
  it.equipped = slot;
  return { rpg: next, removed, slot };
}

/** Copy of `{inventory, equipment}` with `itemId` taken off. */
export function previewUnequip(rpg, itemId) {
  const inventory = (rpg?.inventory || []).map((i) => ({ ...i }));
  const equipment = { ...(rpg?.equipment || {}) };
  const it = inventory.find((i) => i.id === itemId);
  if (it?.equipped) { delete equipment[it.equipped]; delete it.equipped; }
  return { ...rpg, inventory, equipment };
}

const avg = (d) => (d ? (d.min + d.max) / 2 : 0);
const signed = (n, digits = 0) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(digits)}`;

/**
 * What changes if the item is equipped (or, when already worn, removed).
 * Returns `{mode, slot, replaces, armor, rows, enchantments}`:
 * - `armor`: `[part, label, before, after]` for body parts whose rating changes.
 * - `rows`: `[label, current, candidate, change, sense]`, sense 1 better / -1 worse / 0 neutral.
 */
export function compareItem(rpg, it, slot) {
  if (!isWearable(it) || !rpg) return null;
  const before = armorValues(rpg);
  const mode = it.equipped ? 'remove' : 'equip';
  let after;
  let replaces = [];
  if (mode === 'remove') {
    after = armorValues(previewUnequip(rpg, it.id));
    slot = it.equipped;
  } else {
    const p = previewEquip(rpg, it.id, slot);
    if (!p.slot) return null;
    after = armorValues(p.rpg);
    replaces = p.removed;
    slot = p.slot;
  }
  const armor = BODY_PARTS.filter(([part]) => before[part] !== after[part]).map(([part, label]) => [part, label, before[part], after[part]]);
  const rows = [];
  const beforeEnchants = (mode === 'equip' ? replaces : [it]).flatMap((r) => enchantmentEffects(r));
  const afterEnchants = mode === 'equip' ? enchantmentEffects(it) : [];

  if (mode === 'equip') {
    const main = replaces.find((r) => r.equipped === slot) || replaces[0] || null;
    if (armor.length || it.armorValue != null || replaces.some((r) => r.armorValue != null)) {
      const curAc = replaces.reduce((sum, r) => sum + (Number(r.armorValue) || 0), 0);
      const nextAc = Number(it.armorValue) || 0;
      const d = nextAc - curAc;
      rows.push(['Armor (AC)', replaces.length ? String(curAc) : '0', String(nextAc), signed(d), Math.sign(d)]);
    }
    if (it.group === 'weapon' || replaces.some((r) => r.group === 'weapon')) {
      const cur = slot === 'rightHand' ? (itemIn(rpg, 'rightHand') ?? null) : (replaces.find((r) => r.group === 'weapon') ?? main);
      const curDmg = cur?.damage ?? (slot === 'rightHand' ? { min: 1, max: 2 } : null);
      const nextDmg = it.damage ?? null;
      if (curDmg || nextDmg) {
        const d = avg(nextDmg) - avg(curDmg);
        rows.push([
          'Damage',
          curDmg ? `${curDmg.min}–${curDmg.max}` : '—',
          nextDmg ? `${nextDmg.min}–${nextDmg.max}` : '—',
          `${signed(d, 1)} avg`,
          Math.sign(d),
        ]);
      }
    }
    const curWeight = replaces.reduce((kg, r) => kg + (Number(r.weight) || 0), 0);
    if (replaces.length || it.weight) {
      const d = (Number(it.weight) || 0) - curWeight;
      rows.push(['Weight worn', replaces.length ? `${curWeight.toFixed(2)} kg` : '—', `${(Number(it.weight) || 0).toFixed(2)} kg`, `${signed(d, 2)} kg`, d === 0 ? 0 : -Math.sign(d)]);
    }
    if (main?.maxCondition > 1 || it.maxCondition > 1) {
      const a = main?.maxCondition > 1 ? Math.round((100 * main.condition) / main.maxCondition) : null;
      const b = it.maxCondition > 1 ? Math.round((100 * it.condition) / it.maxCondition) : null;
      const deltaText = a != null && b != null ? `${signed(b - a)}%` : b != null ? conditionLabel(it) : '—';
      const sense = a != null && b != null ? Math.sign(b - a) : b != null ? (b < 41 ? -1 : 0) : 0;
      rows.push(['Condition', a != null ? `${a}%` : '—', b != null ? `${b}%` : '—', deltaText, sense]);
    }
    if (beforeEnchants.length || afterEnchants.length) {
      const deltaN = afterEnchants.length - beforeEnchants.length;
      const change = it.magic?.identified === false ? 'Unidentified'
        : deltaN !== 0 ? `${signed(deltaN)} effect${Math.abs(deltaN) === 1 ? '' : 's'}`
        : beforeEnchants.join('|') === afterEnchants.join('|') ? 'Same' : 'Changed';
      rows.push([
        'Enchantments',
        beforeEnchants.length ? beforeEnchants.join(', ') : 'None',
        afterEnchants.length ? afterEnchants.join(', ') : 'None',
        change,
        it.magic?.identified === false ? 0 : Math.sign(deltaN),
      ]);
    }
    const curCh = itemCharges(main);
    const nextCh = itemCharges(it);
    if (curCh || nextCh) {
      const d = (nextCh?.current ?? 0) - (curCh?.current ?? 0);
      rows.push([
        'Charges',
        curCh ? `${curCh.current}/${curCh.max}` : '—',
        nextCh ? `${nextCh.current}/${nextCh.max}` : '—',
        curCh && nextCh ? signed(d) : nextCh ? `${nextCh.current} left` : 'Lost',
        Math.sign(d),
      ]);
    }
  } else {
    if (armor.length || it.armorValue) {
      const curAc = Number(it.armorValue) || 0;
      rows.push(['Armor (AC)', String(curAc), '0', signed(-curAc), curAc > 0 ? -1 : 0]);
    }
    if (it.group === 'weapon' && it.damage) {
      const unarmed = slot === 'rightHand' ? { min: 1, max: 2 } : null;
      const d = avg(unarmed) - avg(it.damage);
      rows.push(['Damage', `${it.damage.min}–${it.damage.max}`, unarmed ? '1–2' : '—', `${signed(d, 1)} avg`, Math.sign(d)]);
    }
    if (it.weight) {
      const w = Number(it.weight) || 0;
      rows.push(['Weight worn', `${w.toFixed(2)} kg`, '—', `${signed(-w, 2)} kg`, 1]);
    }
    if (beforeEnchants.length) {
      rows.push(['Enchantments', beforeEnchants.join(', '), 'None', `${signed(-beforeEnchants.length)} effect${beforeEnchants.length === 1 ? '' : 's'}`, -1]);
    }
    const curCh = itemCharges(it);
    if (curCh) {
      rows.push(['Charges', `${curCh.current}/${curCh.max}`, '—', 'Unequipped', 0]);
    }
  }
  return { mode, slot, replaces, armor, rows, enchantments: { before: beforeEnchants, after: afterEnchants } };
}

export const conditionPct = (it) => (it?.maxCondition > 1 ? Math.max(0, Math.min(100, Math.round((100 * it.condition) / it.maxCondition))) : null);
/** Damaged enough that a smith is worth a visit (below "Almost new"). */
export const needsCare = (it) => { const p = conditionPct(it); return p != null && p < 76; };

/** Short kind line under an item name, such as "Chest armour · Steel" or "Potion". */
export function kindOf(it) {
  if (!it) return '';
  const where = it.group === 'weapon' ? (it.hands === 'both' ? 'Two-handed weapon' : 'Weapon')
    : it.group === 'shield' ? 'Shield'
    : it.group === 'armor' ? `${slotLabel(it.slot)} armor`
    : it.group === 'clothing' ? `${slotLabel(it.slot)} clothing`
    : it.group ? it.group[0].toUpperCase() + it.group.slice(1) : 'Item';
  return where;
}

// Status line while an item action is in flight: it names what that action does (Light reads "Lighting Torch…").
const PENDING_VERBS = Object.freeze({
  Unequip: 'Removing', Equip: 'Equipping', Drink: 'Drinking', Read: 'Reading', 'Read map': 'Studying', Light: 'Lighting',
  Douse: 'Dousing', 'Refuel lantern': 'Refuelling the lantern with', Use: 'Using',
});
export const pendingLabel = (action, it) => `${PENDING_VERBS[action?.label] ?? 'Using'} ${it?.name ?? 'the item'}…`;
