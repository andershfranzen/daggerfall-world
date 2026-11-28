// Daggerfall World guidance for the classic _TUTOR__ lessons read from the operator's ARENA2.
// Classic QRC text describes single-player DOS controls and manual save slots (Esc -> Save Game);
// this module appends accurate shared-world controls and server auto-save instructions without
// shipping any Bethesda text.

const NOTES = Object.freeze({
  1012: 'Daggerfall World controls: Move with W A S D, click the view to look around with the mouse (Esc releases the cursor), hold Shift to run, press Z to jump, X to crouch, and hold W against (or jump into) a wall to climb.',
  1013: 'Daggerfall World controls: Press I to open your Inventory, select a weapon, and click Equip. Press Esc or I again to return to the world.',
  1015: 'Daggerfall World controls: Press F to ready or sheathe your weapon. Left-click or press Space to swing, or right-drag to perform a directional strike.',
  1020: 'Daggerfall World controls: Aim at the secret door down the hall and press G to open or close it.',
  1025: 'Daggerfall World controls: Aim at the treasure pile on the altar and press G to search it, then click Take or Take all to move items into your inventory.',
  1030: 'Daggerfall World note: Your character and progress are saved automatically on the server — there is no Save Game menu under Esc. Open System (F10) to adjust settings or leave the world safely at any time. If you fall in combat, you will revive at the dungeon entrance with your character intact.',
  1035: 'Daggerfall World controls: Press B to open your Spellbook, ready a spell, and press V to cast it.',
  1041: 'Daggerfall World controls: Press M to open the Travel Map, pick a region and destination such as Daggerfall, and choose your travel options.',
  1045: 'Daggerfall World controls: Walk up to a townsperson and press G to talk (F1–F4 switch between Steal, Grab, Info, and Talk modes). Press R to Rest or Loiter.',
  1046: 'Daggerfall World controls: Press M for Maps (including the local Automap), F3 for Info mode, and R to Rest or Loiter.',
});

/** Attach Daggerfall World controls/auto-save guidance to a _TUTOR__ message when applicable. */
export function annotateTutorialText(questName, messageId, text) {
  if (questName !== '_TUTOR__' || !text) return text;
  const note = NOTES[messageId];
  if (!note) return text;
  // Put the save-game note first on Lesson 6 so players immediately see there is no manual Save menu.
  if (messageId === 1030) return `${note}\n\n${text}`;
  return `${text}\n\n${note}`;
}
