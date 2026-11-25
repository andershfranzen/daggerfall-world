export const MANTELLAN = Object.freeze({
  region: 31,
  index: 0,
  quest: 'S0000016',
  place: 50000,
  returnPlace: 50005,
  town: 'town:High Rock sea coast/Mantellan Crux',
  dungeon: 'dungeon:High Rock sea coast/Mantellan Crux',
  returnDungeon: 'dungeon:Wrothgarian Mountains/Shedungent',
});

export const isMantellan = (region, index) => Number(region) === MANTELLAN.region && Number(index) === MANTELLAN.index;
export const GRAVEYARD_ACCESS = 'graveyard-compatibility';

// These two source templates have no door planes. Use the verified open
// exterior spawn as the landmark; the return faces away from the access point.
export function graveyardAccess(blockName) {
  if (!/^GRVEAS(?:10|36)\.RMB$/i.test(blockName)) return null;
  return { x: 0, y: 1, z: -1, nx: 0, nz: 1, exit: { x: 0, y: 0, z: 0.05, yaw: Math.PI }, access: GRAVEYARD_ACCESS };
}
