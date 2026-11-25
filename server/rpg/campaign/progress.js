import { LYSANDUS_TOMB } from './sites.js';
import { PERMANENT_PLACES } from '../quests/tables.js';

const STORY_TITLES = new Map([
  ['_TUTOR__', 'Tutorial'],
  ['_BRISIEN', 'Lady Brisienna'],
  ['S0000999', 'Main Quest'],
  ['S0000977', 'Curse of Daggerfall'],
  ['S0000008', 'Who Gets the Totem'],
  ['S0000016', 'Journey to Aetherius'],
]);

const LETTER_TITLES = {
  _BRISIEN: { 1020: 'Letter from Lady Brisienna', 1021: 'Reminder from Lady Brisienna', 1022: 'Final letter from Lady Brisienna' },
  S0000008: {
    1011: 'Letter from Lady Brisienna', 1020: 'Letter from Queen Akorithi', 1021: 'Letter from King Eadwyre',
    1022: 'Letter from Gortwog', 1023: 'Letter from the King of Worms', 1024: 'Letter from the Underking',
    1025: 'Second letter from Lady Brisienna',
  },
  S0000015: { 1011: 'Woodborne’s diary' },
  S0000020: { 1020: 'Mynisera’s letter to Gortwog', 1021: 'The Emperor’s letter' },
};

export const storyTitle = (name) => STORY_TITLES.get(name);

/** Fill in formerly unresolved fixed sites and preserve completed action slots in older story saves. */
export function updateSavedCampaignInstance(instance, definition) {
  if (!instance.story || !instance.name) return;
  for (const item of Object.values(instance.items)) {
    const title = LETTER_TITLES[instance.name]?.[item.usedMessage];
    if (title) item.name = title;
    if (instance.name === 'S0000008' && item.className === 'specials') item.name = 'Totem';
    if ((instance.name === 'S0000018' || instance.name === 'S0000022') && item.className === 'organs') item.name = 'Dust of Restful Death';
  }
  for (const resource of definition.resources.values()) {
    if (resource.kind !== 'place' || resource.scope !== 'permanent') continue;
    const place = instance.places[resource.key];
    const site = PERMANENT_PLACES.get(resource.site.toLowerCase());
    if (!place || place.location || !site?.location) continue;
    const isDungeon = site.location.startsWith('dungeon:');
    place.location = isDungeon ? `town:${site.location.slice(8)}` : site.location;
    place.interior = isDungeon ? site.location : null;
    place.site = site.name;
  }
  if (instance.report?.source !== 'classic') return;
  if (instance.name === 'S0000007' && !instance.tasks['until.s.07']) {
    instance.tasks['until.s.07'] = { t: true, p: false, d: false, a: [{ c: false }] };
    if (instance.tasks['s.06']) instance.tasks['s.06'].t = false;
  }
  if (instance.name === 'S0000999' && instance.tasks['s.22']?.a.length === 2) {
    for (let step = 22; step <= 35; step++) {
      const feedback = instance.tasks[`s.${step}`];
      if (feedback?.a.length === 2) feedback.a.push({ c: false });
    }
    for (let court = 0; court <= 6; court++) {
      const audience = instance.tasks[`s.0${court}`];
      if (audience) audience.t = false;
    }
    instance.individualClicks = [];
  }
  if (instance.name === 'S0000020') {
    if (!instance.tasks['until.s.02']) {
      instance.tasks['until.s.02'] = { t: true, p: false, d: false, a: [{ c: false }] };
      // Earlier saves could carry an audience from before the player acquired the lead.
      if (instance.tasks['s.00']) instance.tasks['s.00'].t = false;
    }
    const accept = instance.tasks['s.03'];
    if (accept?.a.length === 4) accept.a.push({ c: false });
  }
  if (instance.name === 'S0000021') {
    if (!instance.tasks['until.s.15']) {
      instance.tasks['until.s.15'] = { t: true, p: false, d: false, a: [{ c: false }] };
      instance.tasks['s.18'] = { t: false, p: false, d: false, a: [{ c: false }, { c: false }] };
      if (instance.tasks['s.02']) instance.tasks['s.02'].t = false;
      if (instance.tasks['s.10']) instance.tasks['s.10'].t = false;
      if (instance.tasks['s.15']?.a[0]) instance.tasks['s.15'].a[0].c = false;
    }
    const slay = instance.tasks['s.08'];
    if (slay?.a.length === 2) slay.a.push({ c: false });
  }
  const startup = instance.tasks.__startup;
  if (instance.name === 'S0000015' && startup?.a.length === 4) {
    const diary = instance.items['i.00'];
    startup.a.unshift({ c: !!(diary?.held || diary?.handedOver || diary?.location) });
  }
  const exit = instance.tasks['s.05'];
  if (instance.name === '_BRISIEN' && exit?.a.length === 3) {
    instance.tasks.inhold = { t: false, p: false, d: false, a: [] };
    exit.d = exit.a[0].c === true;
    exit.a = [{ c: false }, ...exit.a, { c: false }];
  }
}

export function acceptsCampaignGlobal(player, location, index) {
  if (index !== 43) return true;
  if (location !== LYSANDUS_TOMB) return false;
  const quest = player.rpg.quests?.active?.find((instance) => instance.name === 'S0000022');
  return !!quest && Object.values(quest.items).some((item) => item.className === 'organs' && item.held);
}

/** Put the destinations disclosed by source letters and the Totem handover onto the player's travel map. */
export function revealCampaignDestination(services, player, instance, message) {
  let building;
  if (instance.name === '_BRISIEN' && message === 1026) building = 'tavern';
  if (instance.name === 'S0000010' && message === 1022) building = 'house2';
  if (instance.name === 'S0000008') {
    if (message === 1060) {
      services.travel?.discover?.(player, 'town:Wrothgarian Mountains/Shedungent');
      return;
    }
    if (message === 1070) building = 'tavern';
    if (message === 1034) building = 'temple';
  }
  if (!building) return;
  const destination = Object.values(instance.places).find((place) => place.building === building)?.location;
  if (destination) services.travel?.discover?.(player, destination);
}
