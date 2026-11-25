import { DAWN_HOUR, DUSK_HOUR, MINUTES_PER_DAY } from '../gameplay/atmosphere/calendar.js';

// Daggerfall Unity RMBLayout and DaggerfallCityGate identify the native mesh
// pair and its fixed schedule. All geometry comes from the local ARCH3D.BSA.
export const GATE_OPEN = 446;
export const GATE_CLOSED = 447;
export const isCityGate = model => model === GATE_OPEN || model === GATE_CLOSED;
export const isCityGateId = id => id.startsWith('gate:');
export function cityGatesClosed(minutes) {
  if (!Number.isFinite(minutes)) return false;
  const minute = minutes % MINUTES_PER_DAY;
  return minute < DAWN_HOUR * 60 || minute >= DUSK_HOUR * 60;
}
