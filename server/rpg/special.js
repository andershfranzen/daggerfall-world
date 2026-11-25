// Special quest triggers (backlog package 19): Daedra summoning, secret guild invitations and the quests a
// vampire or lycanthrope receives. This feature decides *when* an original quest begins and for whom; the quest
// engine (server/rpg/quests.js, package 17) runs the script, conditions (package 10) own the curses, artifacts
// (package 16) own the rewards and the calendar (package 20) owns the date and weather.
//
// rpg.special = {
//   v: 1,
//   summoned: {factionId: classicMinutes}   princes this character has already summoned (FactionFile.Flags.Summoned)
//   covenDay, covenIndex                     today's coven prince (PlayerEntity.DaedraSummonDay/Index)
//   pending: {npcId, daedra, day, at} | null a summoning waiting for the yes/no answer
//   thieves, brotherhood: {tally, letterAt}  TallyCrimeGuildRequirements / HandleStartingCrimeGuildQuests
//   vampireInitial: boolean                  P0A01L00 has been started (VampirismEffect.hasStartedInitialVampireQuest)
//   history: [{at, kind, quest?, result, detail}]   newest first, capped; what triggered and why
// }
//
// Actions: special.summon {targetId, confirm?: boolean}, special.status.
// Services: daedraSummon(p, entity, args) for the npc.service 'summon' route, special.{status, coverage, ...}.
// Events consumed: crimeTally {player, thieving, amount} (law, package 14), supernaturalQuest {player, kind, cure}
// (conditions, package 10), questComplete / questFailed / questEnded (quests).
// Events emitted: daedraSummoned {player, daedra, quest, result}, specialQuestStarted {player, quest, source},
// guildInvite {player, guild, quest, started} (the letter is due; guilds.js handles membership and fallback).

import { readFileSync } from 'node:fs';
import {
  DAEDRA, DAEDRA_BY_FACTION, DAEDRA_QUESTS, DAEDRIC_FOES, SUMMON_TEXT, rollSummoning, selectDaedra, summonerOf,
  summoningCost, summoningDays,
} from './special/daedra.js';
import {
  CURE_QUESTS, INVITATIONS, VAMPIRE_INITIAL, letterDue, newTally, supernaturalStart, tallyCrime, vampirePool,
} from './special/triggers.js';
import { parseTextRsc } from '../../client/gameplay/character/classic.js';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { dateFromMinutes, formatDate } from '../../client/gameplay/atmosphere/calendar.js';
import { exteriorOf } from '../../client/world/interiors/index.js';

export const name = 'special';

const TALK_RANGE = 4.5;
const ID_RE = /^[\w:,.-]{1,100}$/;
const MAX_HISTORY = 24;
const TICK_SECONDS = 5;
/** Engine blockers that are about *offering* a quest, which a special trigger replaces. */
const TRIGGER_BLOCKERS = [/^not a guild or social quest/, /^no offer text/, /^not in the operator quest list/];
const fail = (msg) => {
  throw new Error(msg);
};

export function install(ctx, opts = {}) {
  const services = (ctx.services ||= {});
  const log = ctx.log ?? console;
  const rng = () => (opts.random ?? Math.random)();

  // ------------------------------------------------------------------ operator data (optional)

  let text = opts.textRsc ?? null;
  if (!text && typeof ctx.dataFile === 'function') {
    try {
      text = parseTextRsc(new Uint8Array(readFileSync(ctx.dataFile('TEXT.RSC'))));
    } catch {
      text = null;
    }
  }
  let factions = opts.factions ?? null;
  if (!factions && typeof ctx.dataFile === 'function') {
    try {
      factions = parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1'));
    } catch {
      factions = null;
    }
  }
  const princeName = (d) => factions?.get(d.factionId)?.name || d.name;
  const factionType = (id) => factions?.get(Number(id))?.type ?? null;

  // ------------------------------------------------------------------ state

  function ensure(p) {
    const rpg = (p.rpg ||= {});
    let s = rpg.special;
    if (!s || typeof s !== 'object' || s.v !== 1) s = rpg.special = { v: 1 };
    if (!s.summoned || typeof s.summoned !== 'object' || Array.isArray(s.summoned)) s.summoned = {};
    for (const k of ['thieves', 'brotherhood']) {
      const r = s[k];
      if (!r || typeof r !== 'object' || !Number.isFinite(r.tally) || !Number.isFinite(r.letterAt)) s[k] = newTally();
    }
    if (!Number.isInteger(s.covenIndex)) s.covenIndex = 0;
    if (!Number.isInteger(s.covenDay)) s.covenDay = -1;
    if (s.pending !== null && (typeof s.pending !== 'object' || !s.pending)) s.pending = null;
    if (s.pending === undefined) s.pending = null;
    s.vampireInitial = !!s.vampireInitial;
    if (!Array.isArray(s.history)) s.history = [];
    return s;
  }

  function record(p, entry) {
    const s = ensure(p);
    s.history.unshift({ at: worldMinutes(), ...entry });
    s.history.length = Math.min(s.history.length, MAX_HISTORY);
    ctx.dirty?.(p);
  }

  // ------------------------------------------------------------------ calendar, weather, standing

  const worldMinutes = () => {
    const c = services.worldClock?.();
    return Number.isFinite(c?.minutes) ? c.minutes : Math.floor(ctx.now() / 5000);
  };
  /** Summoning days are a shared calendar fact (package 20 recommendation): the world clock decides. */
  const worldDate = () => dateFromMinutes(worldMinutes());
  /** Letters arrive after the character's own time has passed (travel and rest count). */
  const playerMinutes = (p) => {
    const c = services.playerClock?.(p);
    return Number.isFinite(c?.minutes) ? c.minutes : worldMinutes() + (Number(p.rpg?.quests?.minutes) || 0);
  };
  const locOf = (p) => (typeof p.rpg?.location === 'string' ? p.rpg.location : ctx.defaultLocation ?? '');
  const inside = (p) => /^(interior|dungeon):/.test(locOf(p));
  /** An indoor shrine has no sky: the surrounding town's weather counts (package 20). */
  function weatherType(p) {
    const here = locOf(p);
    const sky = exteriorOf(here) ?? here;
    try {
      const w = services.weatherAt?.(sky);
      return typeof w?.type === 'string' ? w.type : 'sunny';
    } catch {
      return 'sunny';
    }
  }
  const reputation = (p, fid) => {
    try {
      return Number(services.reputation?.(p, fid)) || 0;
    } catch {
      return 0;
    }
  };
  /** Prince standing (factions 1..16) lives in the shared reputation (questComplete with the prince's faction). */
  const princeRep = (p, fid) => reputation(p, fid);
  const rankIn = (p, summoner) => {
    if (summoner.kind === 'temple') {
      const r = services.templeRank?.(p, summoner.deity) ?? services.guildRank?.(p, 'temple', { factionId: summoner.deity });
      return Number.isInteger(r) ? r : null;
    }
    const r = services.guildRank?.(p, summoner.guild);
    return Number.isInteger(r) ? r : null;
  };
  const gold = (p) => Number(p.rpg?.gold) || 0;
  function takeGold(p, n) {
    if (typeof services.takeGold === 'function') services.takeGold(p, n);
    else p.rpg.gold = gold(p) - n;
  }
  function giveGold(p, n) {
    if (typeof services.addGold === 'function') for (let left = n; left > 0; left -= 9999) services.addGold(p, Math.min(9999, left));
    else p.rpg.gold = gold(p) + n;
  }

  // ------------------------------------------------------------------ classic words

  function rsc(id, vars) {
    const list = text?.variants?.(id);
    if (!list?.length) return null;
    const raw = list[Math.floor(rng() * list.length)] ?? list[0];
    return raw.replace(/%(dae|dat|pcn|pcf)/g, (m, k) => vars[k] ?? m).replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const FALLBACK = {
    [SUMMON_TEXT.notToday]: 'There are to be no summonings this day.',
    [SUMMON_TEXT.areYouSure]: 'Today is %dat, the day of summoning for %dae. Do you, %pcn, wish to risk your life and very soul by summoning %dae?',
    [SUMMON_TEXT.before]: 'You have summoned %dae once. Go away.',
    [SUMMON_TEXT.failed]: '%dae did not deign to grace our world this night.',
  };
  const words = (id, vars) => rsc(id, vars) ?? FALLBACK[id].replace(/%(dae|dat|pcn|pcf)/g, (m, k) => vars[k] ?? m);
  const varsFor = (p, d) => {
    const pcn = p.rpg?.character?.name || p.name || 'traveller';
    return { dae: d ? princeName(d) : '', dat: formatDate(worldDate()), pcn, pcf: String(pcn).split(/\s+/)[0] };
  };

  // ------------------------------------------------------------------ quest engine bridge (package 17)

  const quests = () => services.quests ?? null;
  /** Blockers the engine reports for a script, minus the ones a special trigger replaces. */
  function blockers(questName) {
    const a = quests()?.analyse?.(questName);
    if (!a) return [`${questName} is not installed on this server`];
    return (a.unsupported ?? []).filter((u) => !TRIGGER_BLOCKERS.some((re) => re.test(u)));
  }
  const running = (p, questName) => !!quests()?.active?.(p)?.some((i) => i.name === questName);

  /** Starts an original quest for `p` without an offer (letters, curses) through the engine's startSpecial hook. */
  function startQuest(p, questName, { source, factionId = null } = {}) {
    const q = quests();
    if (typeof q?.startSpecial !== 'function') return { blocked: ['the quest engine has no special start (services.quests.startSpecial)'] };
    if (running(p, questName)) return { blocked: [`${questName} is already in the journal`] };
    const b = blockers(questName);
    if (b.length) return { blocked: b };
    const inst = q.startSpecial(p, questName, { source, factionId });
    if (!inst) return { blocked: [`${questName} could not start`] };
    if (inst.blocked) return inst;
    ctx.emit('specialQuestStarted', { player: p, quest: questName, source });
    return { inst };
  }

  /** A summoned prince offers their quest (yes/no) through the engine's normal offer flow (offerSpecial hook). */
  function offerQuest(p, questName, giver) {
    const q = quests();
    if (typeof q?.offerSpecial !== 'function') return { blocked: ['the quest engine has no special offer (services.quests.offerSpecial)'] };
    try {
      return { offer: q.offerSpecial(p, questName, { giver, source: 'summoning' }) };
    } catch (err) {
      return { blocked: [err.message] };
    }
  }

  // ------------------------------------------------------------------ Daedra summoning

  function summonerEntity(p, targetId) {
    if (typeof targetId !== 'string' || !ID_RE.test(targetId)) fail('Summon with whom?');
    const e = ctx.entities.get(targetId);
    if (!e || e.kind !== 'npc' || e._quest) fail('There is nobody like that here.');
    if (e.location !== locOf(p)) fail(`${e.name} is not here.`);
    if (!(Math.hypot(e.x - p.x, e.z - p.z) <= TALK_RANGE)) fail(`You are too far away from ${e.name}.`);
    return e;
  }

  /**
   * DaedraSummoningService + ConfirmSummon. `args.confirm` undefined asks; true pays and rolls; false declines.
   * Returns {step, text, ...} and notifies the player with {kind:'daedraSummoning', ...}.
   */
  function summon(p, e, args = {}) {
    if (!p.rpg?.character) fail('Create your character first.');
    const s = ensure(p);
    const summoner = summonerOf(e, factionType(e.faction));
    if (!summoner) fail(`${e.name} cannot summon the Daedra.`);
    if (summoner.rankNeeded !== null) {
      const rank = rankIn(p, summoner);
      if (rank === null || rank < summoner.rankNeeded) {
        const who = summoner.kind === 'temple' ? `the Temple of ${summoner.deityName}` : 'the Mages Guild';
        return reply(p, e, { step: 'refused', reason: 'rank', rankNeeded: summoner.rankNeeded, rank,
          text: `Only members of ${who} of rank ${summoner.rankNeeded} or higher may ask for a summoning.` });
      }
    }
    const date = worldDate();
    const vars0 = varsFor(p, null);

    if (args.confirm === false) {
      s.pending = null;
      return reply(p, e, { step: 'declined', text: 'You think better of it.' });
    }

    if (args.confirm !== true) {
      const d = selectDaedra(summoner, date.dayOfYear, s, rng);
      if (!d) {
        s.pending = null;
        record(p, { kind: 'summon', result: 'not-today', detail: `day ${date.dayOfYear} at ${e.name}` });
        return reply(p, e, { step: 'notToday', dayOfYear: date.dayOfYear, text: words(SUMMON_TEXT.notToday, vars0) });
      }
      const cost = summoningCost(reputation(p, summoner.summonerFaction));
      s.pending = { npcId: e.id, daedra: d.factionId, day: date.dayOfYear, year: date.year, cost };
      ctx.dirty?.(p);
      return reply(p, e, { step: 'confirm', daedra: princeName(d), dayOfYear: date.dayOfYear, cost, gold: gold(p),
        text: words(SUMMON_TEXT.areYouSure, varsFor(p, d)) });
    }

    // confirm === true
    const pend = s.pending;
    if (!pend || pend.npcId !== e.id) fail('Ask for a summoning first.');
    if (pend.day !== date.dayOfYear || pend.year !== date.year) {
      s.pending = null;
      return reply(p, e, { step: 'notToday', dayOfYear: date.dayOfYear, text: words(SUMMON_TEXT.notToday, vars0) });
    }
    s.pending = null;
    const asked = DAEDRA_BY_FACTION.get(pend.daedra);
    const cost = summoningCost(reputation(p, summoner.summonerFaction));
    if (gold(p) < cost) {
      return reply(p, e, { step: 'noGold', cost, gold: gold(p), text: `The summoning costs ${cost} gold. You do not have enough gold.` });
    }
    takeGold(p, cost);
    const r = rollSummoning(asked, { weatherType: weatherType(p), daedraRep: (fid) => princeRep(p, fid), rng });
    const d = r.daedra;
    const detail = { daedra: princeName(d), quest: d.quest, chance: r.chance, roll: r.roll, sheogorath: d.index !== asked.index, cost, weather: weatherType(p) };
    if (!r.success) {
      record(p, { kind: 'summon', quest: d.quest, result: 'failed', detail: `${detail.daedra}: roll ${r.roll} > ${r.chance}` });
      if (summoner.kind === 'coven') spawnDaedricFoes(p, e);
      ctx.emit('daedraSummoned', { player: p, daedra: d.factionId, quest: d.quest, result: 'failed' });
      return reply(p, e, { step: 'failed', ...detail, text: words(SUMMON_TEXT.failed, varsFor(p, d)) });
    }
    if (s.summoned[d.factionId] !== undefined) {
      record(p, { kind: 'summon', quest: d.quest, result: 'before', detail: detail.daedra });
      ctx.emit('daedraSummoned', { player: p, daedra: d.factionId, quest: d.quest, result: 'before' });
      return reply(p, e, { step: 'before', ...detail, video: `${d.key}`, text: words(SUMMON_TEXT.before, varsFor(p, d)) });
    }
    // A demand the engine cannot run is not offered and costs nothing: the gold goes back, the prince may be
    // summoned again once the server supports the script.
    const b = blockers(d.quest);
    if (b.length) {
      giveGold(p, cost);
      record(p, { kind: 'summon', quest: d.quest, result: 'blocked', detail: b.join('; ') });
      return reply(p, e, { step: 'blocked', ...detail, blockers: b,
        text: `${detail.daedra} appears, but this server cannot yet run ${detail.daedra}'s demand (${b[0]}). Your ${cost} gold is returned.` });
    }
    s.summoned[d.factionId] = worldMinutes();
    const giver = { id: e.id, name: princeName(d), faction: d.factionId, location: e.location, gender: 'female', daedra: true };
    const o = offerQuest(p, d.quest, giver);
    if (o.blocked) {
      delete s.summoned[d.factionId];
      giveGold(p, cost);
      record(p, { kind: 'summon', quest: d.quest, result: 'blocked', detail: o.blocked.join('; ') });
      return reply(p, e, { step: 'blocked', ...detail, blockers: o.blocked, text: `${detail.daedra}'s demand cannot begin: ${o.blocked[0]}. Your ${cost} gold is returned.` });
    }
    record(p, { kind: 'summon', quest: d.quest, result: o.offer ? 'offered' : 'started', detail: `${detail.daedra} (roll ${r.roll} ≤ ${r.chance})` });
    ctx.emit('daedraSummoned', { player: p, daedra: d.factionId, quest: d.quest, result: 'summoned' });
    return reply(p, e, { step: o.offer ? 'offered' : 'started', ...detail, video: d.key, offerId: o.offer?.id ?? null, uid: o.inst?.uid ?? null,
      text: `${detail.daedra} answers the summoning.` });
  }

  function reply(p, e, out) {
    ctx.notify(p, { kind: 'daedraSummoning', npc: { id: e.id, name: e.name }, ...out });
    ctx.dirty?.(p);
    return out;
  }

  /** CreateFoeSpawner(daedricFoes[Random.Range(0,5)], Random.Range(1,4)) beside the coven. */
  function spawnDaedricFoes(p, e) {
    if (typeof services.createEnemy !== 'function') return;
    const mobile = DAEDRIC_FOES[Math.floor(rng() * DAEDRIC_FOES.length)];
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      try {
        const at = services.collision?.nearestClear?.(e.location, p.x + 2.5 * Math.sin(a), p.z + 2.5 * Math.cos(a), 3) ?? { x: p.x + 2.5 * Math.sin(a), z: p.z + 2.5 * Math.cos(a) };
        services.createEnemy(e.location, mobile, at.x, at.z, { origin: 'coven-summoning', level: Number(p.rpg?.character?.level) || 1 });
      } catch (err) {
        log.warn?.(`[special] coven foe: ${err.message}`);
      }
    }
  }

  // ------------------------------------------------------------------ invitations (package 14 tallies)

  ctx.on('crimeTally', (ev) => {
    const p = ev?.player;
    if (!p?.rpg) return;
    const s = ensure(p);
    const k = ev.thieving ? 'thieves' : 'brotherhood';
    if (Number.isInteger(services.guildRank?.(p, INVITATIONS[k].guild))) return; // already a member: nothing to invite to
    const before = s[k].letterAt;
    tallyCrime(s[k], INVITATIONS[k], ev.amount, playerMinutes(p));
    if (s[k].letterAt && !before) record(p, { kind: 'invitation', quest: INVITATIONS[k].quest, result: 'scheduled', detail: `${INVITATIONS[k].name} letter after tally ${s[k].tally}` });
    ctx.dirty?.(p);
  });

  function checkLetters(p) {
    const s = ensure(p);
    for (const k of ['thieves', 'brotherhood']) {
      if (!letterDue(s[k], playerMinutes(p), inside(p))) continue;
      const r = startQuest(p, INVITATIONS[k].quest, { source: 'invitation', factionId: INVITATIONS[k].factionId });
      record(p, { kind: 'invitation', quest: INVITATIONS[k].quest, result: r.inst ? 'started' : 'blocked', detail: r.blocked?.join('; ') ?? INVITATIONS[k].name });
      // Guilds (package 15) own what follows: membership on success, the hall's 'awaiting' fallback when the
      // letter quest cannot run here, and the join gate.
      ctx.emit('guildInvite', { player: p, guild: INVITATIONS[k].guild, quest: INVITATIONS[k].quest, started: !!r.inst });
      ctx.dirty?.(p);
    }
  }

  // ------------------------------------------------------------------ supernatural (package 10 cadence)

  ctx.on('supernaturalQuest', (ev) => {
    const p = ev?.player;
    if (!p?.rpg || !['vampire', 'werewolf', 'wereboar'].includes(ev.kind)) return;
    const s = ensure(p);
    const want = supernaturalStart(ev.kind, !!ev.cure, s, (n) => running(p, n), rng);
    if (!want) {
      record(p, { kind: ev.cure ? 'cure' : 'clan', result: 'no-roll', detail: ev.kind });
      return;
    }
    const status = services.conditionStatus?.(p);
    const clan = status?.vampire?.clanFactionId ?? null;
    let questName = want.start;
    if (want.pool) {
      const level = Number(p.rpg.character?.level) || 1;
      const entries = [...(quests()?.catalog?.quests?.values() ?? [])];
      const pool = vampirePool(entries, { rep: clan ? reputation(p, clan) : 0, level, oneTimeDone: p.rpg.quests?.oneTime ?? [] })
        .filter((x) => !running(p, x.name) && !blockers(x.name).length);
      if (!pool.length) {
        record(p, { kind: 'clan', result: 'blocked', detail: 'no runnable Vampires-group quest' });
        return;
      }
      questName = pool[Math.floor(rng() * pool.length)].name;
    }
    const r = startQuest(p, questName, { source: ev.cure ? 'cure' : 'clan', factionId: questName === VAMPIRE_INITIAL || want.pool ? clan : null });
    record(p, { kind: ev.cure ? 'cure' : 'clan', quest: questName, result: r.inst ? 'started' : 'blocked', detail: r.blocked?.join('; ') ?? ev.kind });
  });

  // ------------------------------------------------------------------ outcomes

  const onEnd = (result) => (ev) => {
    const p = ev?.player;
    const qn = ev?.quest?.name;
    if (!p?.rpg || !qn) return;
    const s = ensure(p);
    const fid = ev.factionId ?? ev.quest?.factionId;
    if (DAEDRA_QUESTS.has(qn) && DAEDRA_BY_FACTION.has(fid)) {
      record(p, { kind: 'summon', quest: qn, result, detail: DAEDRA_BY_FACTION.get(fid).name });
    }
    for (const inv of Object.values(INVITATIONS)) {
      if (qn !== inv.quest) continue;
      record(p, { kind: 'invitation', quest: qn, result, detail: inv.name }); // membership itself: guilds.js
    }
    if (Object.values(CURE_QUESTS).includes(qn) || qn === VAMPIRE_INITIAL) record(p, { kind: qn === VAMPIRE_INITIAL ? 'clan' : 'cure', quest: qn, result });
    ctx.dirty?.(p);
  };
  ctx.on('questComplete', onEnd('success'));
  ctx.on('questFailed', onEnd('failed'));
  ctx.on('questEnded', onEnd('ended'));

  // ------------------------------------------------------------------ tick

  let acc = 0;
  ctx.onTick?.((dt) => {
    acc += dt;
    if (acc < TICK_SECONDS) return;
    acc = 0;
    for (const p of ctx.players.values()) {
      const s = p.rpg?.special;
      if (!s || !(s.thieves?.letterAt > 0 || s.brotherhood?.letterAt > 0)) continue;
      const go = () => checkLetters(p);
      try {
        if (typeof ctx.runAtomic === 'function') ctx.runAtomic(p, 'special.letter', go);
        else go();
      } catch (err) {
        log.error?.('[special] letter check failed:', err);
      }
    }
  });

  // ------------------------------------------------------------------ actions

  ctx.onAction('special.summon', (p, args) => {
    const e = summonerEntity(p, args.targetId);
    return summon(p, e, { confirm: typeof args.confirm === 'boolean' ? args.confirm : undefined });
  });

  ctx.onAction('special.status', (p) => {
    ctx.notify(p, { kind: 'specialStatus', status: status(p) });
  });

  function status(p) {
    const s = ensure(p);
    return {
      summoned: Object.keys(s.summoned).map(Number).map((fid) => princeName(DAEDRA_BY_FACTION.get(fid) ?? { factionId: fid, name: String(fid) })),
      pending: s.pending ? { daedra: princeName(DAEDRA_BY_FACTION.get(s.pending.daedra)), cost: s.pending.cost } : null,
      thieves: { ...s.thieves }, brotherhood: { ...s.brotherhood },
      history: s.history.slice(0, 10),
    };
  }

  /** Which special triggers this server can run end to end, per original script (honest coverage). */
  function coverage() {
    const rows = [];
    for (const d of DAEDRA) rows.push({ trigger: `summon ${d.name} (day ${d.dayOfYear})`, quest: d.quest, blockers: blockers(d.quest) });
    for (const inv of Object.values(INVITATIONS)) rows.push({ trigger: `${inv.name} letter (tally ${inv.threshold})`, quest: inv.quest, blockers: blockers(inv.quest) });
    rows.push({ trigger: 'vampire, 38-day clan roll', quest: VAMPIRE_INITIAL, blockers: blockers(VAMPIRE_INITIAL) });
    rows.push({ trigger: 'vampire, 84-day cure roll', quest: CURE_QUESTS.vampire, blockers: blockers(CURE_QUESTS.vampire) });
    rows.push({ trigger: 'lycanthrope, 84-day cure', quest: CURE_QUESTS.werewolf, blockers: blockers(CURE_QUESTS.werewolf) });
    return rows.map((r) => ({ ...r, runnable: r.blockers.length === 0 }));
  }

  /**
   * npc.service 'summon' (guilds/npcs, package 15): their rank gate has run; `args.confirm` carries the yes/no.
   * The conversation uses the result to show the price and ask for confirmation.
   */
  services.daedraSummon = (p, e, args = {}) => summon(p, e, { confirm: typeof args.confirm === 'boolean' ? args.confirm : undefined });
  services.special = { status, coverage, summoningDays, startQuest, ensure };

  return { summon, coverage, status, ensure };
}

export default install;
