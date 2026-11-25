// Riding rules shared by the server (server/rpg/mount.js) and the browser's movement
// prediction, so a mounted player predicts exactly the speed the server moves them at.
// DOM-free.
//
// Speed follows Daggerfall Unity's PlayerSpeedChanger (MIT, (c) 2009-2023 Daggerfall
// Workshop): on foot (LiveSpeed + dfWalkBase 150), on horseback (LiveSpeed + dfRideBase 375),
// both / 39.5. This shell walks every character at a flat 4 m/s, which is the classic walk of the
// reference Speed of 50, so the ride is that classic ratio applied to the shell's walk:
//   ride = walk * (Speed + 375) / (50 + 150)   → 8.5 m/s at Speed 50.
// Notices: client/gameplay/travel/NOTICES.txt.

import { parseLocationId } from '../travel/catalog.js';
import { parseWildernessId } from '../../world/wilderness/data.js';

export const WALK_SPEED = 4; // m/s, client/lib/motion.js SPEED and server/game.js maxSpeed
export const DF_WALK_BASE = 150;
export const DF_RIDE_BASE = 375;
/** PlayerSpeedChanger.dfCartBase = dfWalkBase + 100: driving the small cart. */
export const DF_CART_BASE = 250;
export const REFERENCE_SPEED = 50;
/** PlayerHeightChanger: controller 1.8 m standing, 2.6 m riding. */
export const RIDE_EYE_LIFT = 0.8;
/** The only riding animal the game sells (ItemTemplates index 94, Transportation.Horse). */
export const HORSE_TEMPLATE = 'horse';
/** ItemTemplates index 93, Transportation.Small_cart (also the wagon of server/rpg/property.js). */
export const CART_TEMPLATE = 'small-cart';
export const RIDE_MODES = Object.freeze(['horse', 'cart']);

const clampStat = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(1, Math.trunc(v))) : REFERENCE_SPEED);

/** Mounted ground speed in m/s for a character record (`rpg.character`), on horseback or driving the cart. */
export function rideSpeed(character, walk = WALK_SPEED, mode = 'horse') {
  const spd = clampStat(character?.attributes?.Speed);
  return walk * (spd + (mode === 'cart' ? DF_CART_BASE : DF_RIDE_BASE)) / (REFERENCE_SPEED + DF_WALK_BASE);
}

/** Exterior places (towns and wilderness squares) are the only ones a horse may stand in. */
export const isOutdoors = (location) => parseLocationId(location) !== null || parseWildernessId(location) !== null;

/** The character's horse item, or null. */
export function horseOf(rpg) {
  const inv = Array.isArray(rpg?.inventory) ? rpg.inventory : [];
  return inv.find((it) => it && it.template === HORSE_TEMPLATE) ?? null;
}

/** The character's small cart item, or null. */
export function cartOf(rpg) {
  const inv = Array.isArray(rpg?.inventory) ? rpg.inventory : [];
  return inv.find((it) => it && it.template === CART_TEMPLATE) ?? null;
}

/** TransportManager.ToggleMount: the horse when owned, else the cart, else nothing. */
export const defaultRideMode = (rpg) => (horseOf(rpg) ? 'horse' : cartOf(rpg) ? 'cart' : null);

/** The transport a mounted record uses: its stored mode (cart only with `mode: 'cart'`). */
export const rideModeOf = (rpg) => (rpg?.mount?.mode === 'cart' ? 'cart' : 'horse');

/**
 * Why `rpg` may not ride `mode` right now, or null when it may.
 * DaggerfallUI: "You cannot change transportation indoors." (cannotChangeTransportationIndoors).
 */
export function rideRefusal(rpg, mode = rpg?.mount?.riding === true ? rideModeOf(rpg) : defaultRideMode(rpg) ?? 'horse') {
  if (mode === 'cart' ? !cartOf(rpg) : !horseOf(rpg)) {
    return mode === 'cart' ? 'You have no cart. General stores sell them.' : 'You have no horse. General stores sell them.';
  }
  if (!isOutdoors(rpg?.location)) return 'You cannot change transportation indoors.';
  if (rpg?.defeated) return 'You cannot ride while you are down.';
  return null;
}

/** True when the stored state says riding and the rules still allow it. */
export const isRiding = (rpg) => rpg?.mount?.riding === true && rideRefusal(rpg, rideModeOf(rpg)) === null;

/** Current ground speed while riding, else null. */
export const mountedSpeed = (rpg, walk = WALK_SPEED) => (isRiding(rpg) ? rideSpeed(rpg.character, walk, rideModeOf(rpg)) : null);
