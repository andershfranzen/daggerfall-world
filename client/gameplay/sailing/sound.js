import { CLIP } from '../atmosphere/playlists.js';
import { DECK_BOW } from './model.js';

// The scene camera walks on the deck. Shot and impact positions are in the bay's frame.
export function seaSound(ev, vessel, lookYaw = 0) {
  if (!vessel) return null;
  let clip, position, reach, rate;
  switch (ev.kind) {
    case 'naval.shot':
      clip = CLIP.StormLightningShort;
      position = ev.balls?.[0]?.p0;
      reach = 920;
      rate = ev.gun === 'swivel' ? 1.25 : 0.78;
      break;
    case 'naval.hit':
      clip = ev.zone === 'water' ? CLIP.SplashLarge : CLIP.PlayerDoorBash;
      position = ev.point;
      reach = ev.zone === 'water' ? 150 : 340;
      rate = ev.zone === 'rig' ? 1.2 : 0.88;
      break;
    case 'naval.ram':
      clip = CLIP.PlayerDoorBash;
      position = ev.point;
      reach = 300;
      rate = 0.7;
      break;
    default:
      return null;
  }
  const dx = position?.[0] - vessel.x;
  const dz = position?.[2] - vessel.z;
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(distance) || distance >= reach) return null;
  const deckBow = vessel.deckBow ?? DECK_BOW[vessel.type] ?? 0;
  const hearingYaw = (vessel.yaw ?? 0) + lookYaw - deckBow;
  const bearing = Math.atan2(dx, -dz) - hearingYaw;
  const pan = distance < 1 ? 0 : Math.sin(bearing) * 0.85;
  return { clip, pan, volume: 0.88 * (1 - distance / reach), rate };
}
