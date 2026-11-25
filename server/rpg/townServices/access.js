import { dateFromMinutes, pad2 } from '../../../client/gameplay/atmosphere/calendar.js';
import { holidayAt, shopsClosed } from '../../../client/gameplay/atmosphere/holidays.js';
import { BUILDING, buildingHours, isBuildingOpen, isShop } from '../npcs/people.js';

// Rules from Daggerfall Unity PlayerActivate.BuildingIsUnlocked. Read the
// portal surveyed from MAPS.BSA, and keep access separate from staffing.
export function buildingAccess(ctx) {
  const s = ctx.services;
  const clock = (minutes = s.worldClock?.()?.minutes) => Number.isFinite(minutes) ? dateFromMinutes(minutes) : null;
  const closedForHoliday = (type, region, at) => isShop(type) &&
    shopsClosed((s.holidayAt ?? holidayAt)(at.classicMinutes, region));

  function publicOpen(type, region, minutes) {
    const at = clock(minutes);
    return !at || !Number.isInteger(type) || (isBuildingOpen(type, at.hour) && !closedForHoliday(type, region, at));
  }

  function lockedReason(p, portal) {
    const type = portal.meta?.buildingType;
    const at = clock();
    if (portal.kind !== 'building' || !Number.isInteger(type) || !at) return;
    const faction = portal.meta.factionId;
    const privateHall = type === BUILDING.House2 && faction > 0;
    const residence = type >= BUILDING.House1 && type <= BUILDING.House6;
    if (s.ownsBuilding?.(p, portal) || ((type === BUILDING.GuildHall || privateHall) && s.guildHallAccess?.(p, portal))) return;
    if (residence && !privateHall && (s.quests?.active?.(p) ?? []).some(q =>
      Object.values(q.places ?? {}).some(site => site.interior === portal.to))) return;
    const canOpen = type <= BUILDING.Palace || (type >= BUILDING.House1 && type <= BUILDING.House4);
    if (canOpen && !privateHall && publicOpen(type, portal.meta.regionIndex, at.classicMinutes)) return;
    if (closedForHoliday(type, portal.meta.regionIndex, at)) return `${portal.label} is closed for Sun’s Rest.`;
    const hours = buildingHours(type);
    const schedule = canOpen && !privateHall && hours && hours.close > hours.open
      ? ` It opens at ${pad2(hours.open)}:00.` : '';
    return `${portal.label} is locked.${schedule}`;
  }

  function entry(p, portal) {
    const reason = lockedReason(p, portal);
    if (!reason || s.buildingEntryOverride?.(p, portal)) return true;
    const spell = s.takeDoorMagic?.(p, 'open');
    if (!spell) throw new Error(reason);
    // The reference estimates an exterior lock at half the building's quality.
    if (spell.level < Math.floor((portal.meta.quality ?? 10) / 2)) {
      ctx.notify(p, { kind: 'portal', text: 'Your spell fails to open the lock.' });
      return false;
    }
    s.law?.openDoor(p, portal, 'spell');
    return true;
  }

  return { publicOpen, lockedReason, entry };
}
