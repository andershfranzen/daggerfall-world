import { clearDungeonReturn } from '../interiors/portals.js';
import { OPENING_DUNGEON } from './sites.js';

const TUTORIAL = '_TUTOR__';
const CONTACT = '_BRISIEN';

/** New characters join the existing world at the start marker read from the installed dungeon. */
export function installCampaignOpening(ctx, { definition, start, run }) {
  const { interiors, collision, portals } = ctx.services;
  if (!ctx.dataPath || !interiors?.survey || !collision?.whenSettled || !portals?.transfer) return;

  let opening;
  let preparing;
  let prepareError;
  function prepare() {
    if (!preparing) preparing = interiors.survey(OPENING_DUNGEON).then(async () => {
      const portal = portals.into(OPENING_DUNGEON);
      if (portal?.kind !== 'dungeon' || !portal.entrances.length || !portal.exits.length) {
        throw new Error('The starting dungeon has no authored entrance and exit.');
      }
      const [inside, outside] = await Promise.all([OPENING_DUNGEON, portal.from].map(collision.whenSettled));
      if (inside.status !== 'ready' || outside.status !== 'ready') throw new Error('The starting dungeon or its exterior could not be loaded.');
      const entrance = portal.entrances[0];
      const world = collision.instanceWorld(OPENING_DUNGEON);
      const { x, y, z, yaw } = portal.meta.newCharacterStart ?? entrance.enter;
      const floor = world?.heightAt(x, z, y);
      if (floor == null || Math.abs(floor - y) > 3 || !world.isClear(x, z, floor)) {
        throw new Error('The starting marker is obstructed.');
      }
      const outsideWorld = collision.instanceWorld(portal.from);
      const returnTo = outsideWorld && clearDungeonReturn(outsideWorld, { location: portal.from, ...entrance.exit });
      if (!returnTo) throw new Error('The starting dungeon has no clear exterior landing.');
      opening = { landing: { location: OPENING_DUNGEON, x, y: floor, z, yaw }, portal, returnTo };
      prepareError = null;
    }).catch((err) => {
      prepareError = err;
      throw err;
    }).finally(() => { preparing = null; });
    return preparing;
  }

  const warn = (err) => ctx.log?.warn?.(`[campaign] ${err.message}`);
  const installed = () => !!definition(TUTORIAL) && !!definition(CONTACT);
  // Load the catalogue ahead of character creation and skip the extra collision work for partial installations.
  const ready = Promise.resolve().then(() => installed() ? prepare() : undefined).catch(warn);
  ctx.on('characterCreated', ({ player }) => {
    if (!installed()) return;
    if (!opening) {
      prepare().catch(warn);
      if (prepareError) throw new Error(`The starting dungeon is unavailable. ${prepareError.message}`);
      throw new Error('The starting dungeon is loading. Try creating your character again in a moment.');
    }
    portals.transfer(player, opening.landing, { portal: opening.portal, returnTo: opening.returnTo });
    ctx.notify(player, { kind: 'questVideo', uid: 'campaign-opening', title: 'Opening', sequence: 'opening' });
    start(player, TUTORIAL, 'character-created');
    start(player, CONTACT, 'character-created');
    run(player);
  });
  return { ready };
}
