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

// Enchanted items (item.magic) belong on the Magic Items tab whatever their base group, as in the classic window.
export const tabOf = (item) => (item?.magic && !['weapon', 'armor', 'shield', 'clothing'].includes(item.group) ? 'magic'
  : TABS.find((t) => t.groups.includes(item.group))?.id ?? 'clothing');

export function itemsForTab(inventory, tab, query = '') {
  const q = query.trim().toLowerCase();
  return (inventory || [])
    .filter((i) => i && tabOf(i) === tab && (!q || String(i.name).toLowerCase().includes(q)))
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
  if (it.magic) rows.push(['Magic', it.magic.identified === false ? 'Unidentified' : `${(it.magic.enchantments || []).filter((e) => e && e.type >= 0).length} enchantment(s)`]);
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
 * Returns `{mode, slot, replaces, armor, rows}`:
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
  if (mode === 'equip') {
    const main = replaces.find((r) => r.equipped === slot) || replaces[0] || null;
    if (it.group === 'weapon') {
      const cur = slot === 'rightHand' ? (itemIn(rpg, 'rightHand') ?? null) : main;
      const curDmg = cur?.damage ?? (slot === 'rightHand' ? { min: 1, max: 2 } : null);
      if (curDmg || it.damage) {
        const d = avg(it.damage) - avg(curDmg);
        rows.push(['Damage', curDmg ? `${curDmg.min}–${curDmg.max}` : '—', `${it.damage.min}–${it.damage.max}`, `${signed(d, 1)} avg`, Math.sign(d)]);
      }
    }
    const curWeight = replaces.reduce((kg, r) => kg + (Number(r.weight) || 0), 0);
    if (replaces.length || it.weight) {
      const d = (Number(it.weight) || 0) - curWeight;
      rows.push(['Weight worn', replaces.length ? `${curWeight.toFixed(2)} kg` : '—', `${(Number(it.weight) || 0).toFixed(2)} kg`, `${signed(d, 2)} kg`, d === 0 ? 0 : -Math.sign(d)]);
    }
    if (main?.maxCondition > 1 && it.maxCondition > 1) {
      const a = Math.round((100 * main.condition) / main.maxCondition);
      const b = Math.round((100 * it.condition) / it.maxCondition);
      rows.push(['Condition', `${a}%`, `${b}%`, `${signed(b - a)}%`, Math.sign(b - a)]);
    }
  }
  return { mode, slot, replaces, armor, rows };
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
