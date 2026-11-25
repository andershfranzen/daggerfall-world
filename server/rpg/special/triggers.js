// Secret invitations and supernatural quest triggers (package 19). Pure rules, no I/O.
//
// Adapted from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a28:
//   Entities/PlayerEntity.cs   TallyCrimeGuildRequirements, HandleStartingCrimeGuildQuests,
//                              StartRacialOverrideQuest (every 38 days: clan quests; every 84 days: cure)
//   Guilds/ThievesGuild.cs, Guilds/DarkBrotherhood.cs, Guilds/GuildManager.cs (membership on success)
//   MagicAndEffects/Effects/Special/VampirismEffect.cs, LycanthropyEffect.cs   StartQuest(isCureQuest)

export const INVITATIONS = Object.freeze({
  thieves: { quest: 'O0A0AL00', factionId: 42, threshold: 10, guild: 'thieves', name: 'Thieves Guild' },
  brotherhood: { quest: 'L0A01L00', factionId: 108, threshold: 15, guild: 'brotherhood', name: 'Dark Brotherhood' },
});
/** PlayerEntity.InviteSent: the tally value once the letter quest has started. */
export const INVITE_SENT = 100;
/** The letter arrives three days after the tally first reaches its threshold. */
export const LETTER_DELAY_MINUTES = 4320;

export const CURE_QUESTS = Object.freeze({ vampire: '$CUREVAM', werewolf: '$CUREWER', wereboar: '$CUREWER' });
export const VAMPIRE_INITIAL = 'P0A01L00';
export const SPECIAL_STARTS = new Set(['O0A0AL00', 'L0A01L00', '$CUREVAM', '$CUREWER', 'P0A01L00']);

/**
 * QuestListsManager.GetGuildQuestPool(Vampires, Member, clan, rep, level): member quests whose minReq is a
 * level (<10) the player has reached or a clan reputation (>=10) they hold. `entries` are catalogue rows
 * {name, meta:{group, membership, minReq, oneTime, adult}}.
 */
export function vampirePool(entries, { rep = 0, level = 1, oneTimeDone = [], allowAdult = false } = {}) {
  return entries.filter((e) => e.meta?.group === 'Vampires' && e.meta.membership === 'M'
    && ((e.meta.minReq < 10 && e.meta.minReq <= level) || (e.meta.minReq >= 10 && e.meta.minReq <= rep))
    && (allowAdult || !e.meta.adult) && !(e.meta.oneTime && oneTimeDone.includes(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A fresh tally record. */
export const newTally = () => ({ tally: 0, letterAt: 0 });

/**
 * TallyCrimeGuildRequirements for one guild. Mutates and returns the record. `now` is classic minutes.
 * Nothing changes once the letter is scheduled or sent.
 */
export function tallyCrime(rec, inv, amount, now) {
  if (rec.letterAt !== 0 || rec.tally === INVITE_SENT) return rec;
  rec.tally = Math.min(INVITE_SENT - 1, rec.tally + Math.max(0, Math.trunc(Number(amount) || 0)));
  if (rec.tally >= inv.threshold) rec.letterAt = now + LETTER_DELAY_MINUTES;
  return rec;
}

/**
 * HandleStartingCrimeGuildQuests for one guild: the letter quest starts once the time has passed and the
 * player is not inside a building or dungeon. Returns true when the quest should start now (and marks it sent).
 */
export function letterDue(rec, now, inside) {
  if (rec.tally === INVITE_SENT || !(rec.letterAt > 0) || !(rec.letterAt < now) || inside) return false;
  rec.tally = INVITE_SENT;
  rec.letterAt = 0;
  return true;
}

/**
 * RacialOverrideEffect.StartQuest(isCureQuest) for a deployed vampire or lycanthrope.
 * `kind` is 'vampire' | 'werewolf' | 'wereboar'; `state` is {vampireInitial:boolean}; `running(name)` says
 * whether a quest is already in the player's journal. Returns {start:name, group?} | {pool:'Vampires'} | null.
 *   vampire, cure:    DFRandom.random_range_inclusive(10, 100) < 30  -> $CUREVAM
 *   vampire, regular: after the first clan quest, 50% -> a Vampires-group member quest for the clan;
 *                     before it, 50% -> P0A01L00 (once)
 *   lycanthrope, cure: $CUREWER unless one is already running (LycanthropyEffect.StartQuest)
 *   lycanthrope, regular: base class does nothing
 */
export function supernaturalStart(kind, cure, state, running, rng = Math.random) {
  const range = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  if (kind === 'vampire') {
    if (cure) return range(10, 100) < 30 ? { start: CURE_QUESTS.vampire } : null;
    if (state.vampireInitial) return range(1, 100) < 50 ? { pool: 'Vampires' } : null;
    if (range(1, 100) < 50) {
      state.vampireInitial = true;
      return { start: VAMPIRE_INITIAL };
    }
    return null;
  }
  if (kind === 'werewolf' || kind === 'wereboar') {
    if (!cure) return null;
    return running(CURE_QUESTS[kind]) ? null : { start: CURE_QUESTS[kind] };
  }
  return null;
}
