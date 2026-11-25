// `make _item_ permanent` (Daggerfall Unity Actions/MakePermanent.cs -> Item.MakePermanent): the quest item the player
// carries stops being a quest item and stays with them after the quest ends. Here a carried quest item is a journal
// entry (`held`), so it becomes a real inventory record of the template rolled for it when the quest began.
//
// What is converted:
//   letter with `used` text  parchment carrying that text (campaign letters, cures)
//   artifact                 the artifact template; an artifact already owned is not copied again
//   any other item class     its rolled template and appearance (quests/itemIdentity.js: gems, ingredients, religious
//                            items, jewellery, drugs, magic items, books...), or a durable fallback misc/custom item
//                            preserving name, weight, value and icon metadata when no rolled template is present
// Not converted: an item the player is not carrying (never received, or handed over / taken back: Item.MakePermanent
// only exports items still in the player's collection), gold, or an unresolved unique artifact with no catalogue entry.
// Items already in the inventory (`give pc` rewards) are ordinary records and need nothing.
// Delivery is queued in `rpg.quests.campaignRewards` and retried on join and each tick until the pack has room.
import { permanentFallbackItem } from '../quests/itemIdentity.js';

/** Move a carried quest item into inventory when the script makes it permanent. Runs at most once per item. */
export function permanentQuestItem(ctx, player, quest, key, text) {
  const item = quest.items[key];
  if (!item?.held || item.handedOver || !ctx.services.giveItem) return;
  const letter = item.className === 'letter' && item.usedMessage ? text(quest, item.usedMessage) : null;
  let template = letter ? 'parchment' : item.className === 'gold' ? null : item.template;
  let appearance = !letter && item.appearance ? item.appearance : undefined;
  if (!template && !letter && item.className !== 'gold' && item.className !== 'artifact') {
    const fb = permanentFallbackItem(item, quest);
    if (fb) {
      template = fb.template;
      appearance = fb.appearance;
    }
  }
  if (!template) {
    const note = `make permanent: no inventory item for ${item.className}`;
    if (!quest.notes?.includes(note)) quest.notes?.push(note);
    return;
  }
  const reward = { template };
  if (letter) reward.letter = { title: item.name === 'letter' ? quest.title : item.name, lines: letter.split('\n') };
  else if (item.className !== 'artifact') reward.ordinary = true;
  if (appearance) reward.appearance = appearance; // rolled magic item/book or durable fallback metadata

  const pending = player.rpg.quests.campaignRewards ??= {};
  const id = `${quest.uid}:${key}`;
  ctx.dirty(player);
  pending[id] ??= reward;
  if (!item.template) item.template = template;
  item.held = false;
  item.permanent = true;
  if (!deliver(ctx, player, pending, id)) {
    ctx.notify(player, { kind: 'questMessage', uid: quest.uid, title: quest.title, text: 'The reward will be delivered when there is room in your pack.' });
  }
}

export function deliverCampaignRewards(ctx, player) {
  const pending = player.rpg?.quests?.campaignRewards;
  if (!pending || !ctx.services.giveItem) return;
  for (const id of Object.keys(pending)) deliver(ctx, player, pending, id);
}

function deliver(ctx, player, pending, id) {
  const { template, letter, ordinary, appearance } = pending[id];
  try {
    // Unique artifacts already owned by this player satisfy the delivery without making a second copy. Entries saved
    // before `ordinary` existed are artifacts or letters.
    if (letter || ordinary || !ctx.services.countItem?.(player, template)) {
      ctx.dirty(player);
      ctx.services.giveItem(player, template, 1, letter ? { extra: { letter } } : appearance);
    }
  } catch {
    return false;
  }
  ctx.dirty(player);
  delete pending[id];
  return true;
}
