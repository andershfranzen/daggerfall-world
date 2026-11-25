// CreateItem.CreateTempItem and ItemBuilder.CreateWeapon in the reference.
const armour = [
  ['cuirass', 'Cuirass'], ['gauntlets', 'Gauntlets'], ['greaves', 'Greaves'],
  ['left-pauldron', 'Left Pauldron'], ['right-pauldron', 'Right Pauldron'],
  ['helm', 'Helm'], ['boots', 'Boots'],
];

export const CONJURED_EQUIPMENT = new Map([
  ...['leather', 'chain', 'steel'].flatMap((material) => armour.map(([key, name]) => {
    const label = material[0].toUpperCase() + material.slice(1);
    return [`${material}-${key}`, `${label} ${name}`];
  })),
  ['steel-buckler', 'Steel Buckler'], ['steel-dagger', 'Steel Dagger'],
  ['steel-longsword', 'Steel Longsword'], ['steel-staff', 'Steel Staff'],
  ['steel-short-bow', 'Short Bow'], ['arrow', 'Arrows'],
  ['steel-battle-axe', 'Steel Battle Axe'], ['plain-robes', 'Robes'],
]);
