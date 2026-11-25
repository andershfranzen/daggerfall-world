// Crew hall rules: recruits on offer at a port, wages, roles and morale (pure).
import { hash, unit } from './yard.js';

export const ROLES = Object.freeze(['Mate', 'Bosun', 'Gunner', 'Carpenter', 'Lookout', 'Cook', 'Deckhand']);
/** Daily wage by role (gold). A hand's signing fee is SIGN_DAYS wages, paid at hire. */
export const WAGE = Object.freeze({ Mate: 12, Bosun: 9, Gunner: 8, Carpenter: 8, Lookout: 6, Cook: 6, Deckhand: 4 });
export const SIGN_DAYS = 5;
export const RECRUITS_PER_DAY = 8;
export const MORALE_START = 60;
export const MORALE_MAX = 100;
/** Morale lost per day a hand goes unpaid or unfed; at or below DESERT a hand leaves at the next port. */
export const MORALE_UNPAID = 25;
export const MORALE_HUNGRY = 20;
export const MORALE_PORT = 10;
export const DESERT = 20;

const FIRST = Object.freeze([
  'Aldo', 'Bera', 'Corwin', 'Dalla', 'Edric', 'Fenna', 'Garreth', 'Hilde', 'Ivo', 'Jessa', 'Kaleb', 'Lirra', 'Maddoc', 'Nessa', 'Orrin',
  'Perrin', 'Quill', 'Rosamund', 'Sten', 'Tamsin', 'Ulric', 'Vella', 'Wynn', 'Yorick', 'Brannoc', 'Cressa', 'Doran', 'Elsbet',
]);
const LAST = Object.freeze([
  'Tarrow', 'Saltmarsh', 'Kettle', 'Hawse', 'Brack', 'Weller', 'Gannet', 'Marlow', 'Oakes', 'Rook', 'Fairweather', 'Stroud', 'Penhallow',
  'Cobb', 'Dunmore', 'Lowe', 'Quayle', 'Thorne',
]);

/** The day's recruits at a port: [{id, name, role, wage, fee}]. `taken` ids are omitted (already signed by this captain). */
export function recruitsAt(portId, day, taken = []) {
  const out = [];
  for (let i = 0; i < RECRUITS_PER_DAY; i++) {
    const seed = `${portId}|${day}|r${i}`;
    const role = i < 2 ? 'Deckhand' : ROLES[hash(seed + 'role') % ROLES.length];
    const id = `rc-${day.toString(36)}-${(hash(portId) % 46656).toString(36)}-${i}`;
    if (taken.includes(id)) continue;
    const name = `${FIRST[hash(seed + 'f') % FIRST.length]} ${LAST[hash(seed + 'l') % LAST.length]}`;
    const wage = Math.max(2, Math.round(WAGE[role] * (0.85 + 0.3 * unit(seed + 'w'))));
    out.push({ id, name, role, wage, fee: wage * SIGN_DAYS });
  }
  return out;
}

export const handCount = (ship) => (Array.isArray(ship?.crew) ? ship.crew.length : 0);
export const dailyWages = (ship) => (ship?.crew ?? []).reduce((n, h) => n + (h.wage | 0), 0);
export function roleCounts(ship) {
  const out = Object.fromEntries(ROLES.map((r) => [r, 0]));
  for (const h of ship?.crew ?? []) if (out[h.role] != null) out[h.role]++;
  return out;
}
