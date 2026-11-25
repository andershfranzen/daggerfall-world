// Horse-and-rider billboards for the actor sprite pass (client/gameplay/actors/spritePass.js).
// The horse is the classic animal flat from the player's own TEXTURE.201 (record 0 bay, 1 black;
// the same art ItemTemplates gives the Horse item); the rider is the person or class sprite the
// actor pass already chose, lifted onto its back and drawn a hand's breadth nearer the camera so
// both billboards sort cleanly. Pure: no DOM, no GL.

export const HORSE_ARCHIVE = 201;
/**
 * Metres the rider's sprite is raised: its hips meet the 2.2 m flat's back (about 1.5 m) and its legs
 * hang down the horse's flank, drawn over it.
 */
export const RIDER_LIFT = 0.6;
const NEARER = 0.12;

/**
 * True when the horse's head (drawn facing the viewer's right in the original art) should be mirrored:
 * the actor faces the viewer's left (facingIndex 1-3, client/gameplay/actors/logic.js).
 */
export const horseFlip = (facing) => facing >= 1 && facing <= 3;

/**
 * @param {object} rider  sprite item for the person (from the actor pass), drawn standing at its feet
 * @param {{sprite:{records:any[], recordCount:number}}|null} horseEntry  SpriteLibrary entry for TEXTURE.201
 * @param {{x:number, z:number}} camera
 * @param {{coat?:number, facing?:number}} opts
 * @returns {object[]} [horse, rider] (or [rider] while the horse art is still loading)
 */
export function mountedItems(rider, horseEntry, camera, { coat = 0, facing = 0 } = {}) {
  const dx = camera.x - rider.x, dz = camera.z - rider.z;
  const d = Math.hypot(dx, dz) || 1;
  const lifted = { ...rider, y: rider.y + RIDER_LIFT, x: rider.x + (dx / d) * NEARER, z: rider.z + (dz / d) * NEARER };
  const record = coat === 1 ? 1 : 0;
  if (!horseEntry || record >= horseEntry.sprite.recordCount) return [lifted];
  const rec = horseEntry.sprite.records[record];
  return [{
    key: `${rider.key}:horse`, id: rider.id, entry: horseEntry, record, frame: 0, flip: horseFlip(facing),
    x: rider.x, y: rider.y, z: rider.z, w: rec.world.width, h: rec.world.height,
    light: rider.light, tint: rider.tint ?? null, hurt: 0, coverage: rider.coverage,
  }, lifted];
}
