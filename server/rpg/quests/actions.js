// Quest action patterns. Syntax and trigger/rearm rules adapted from Daggerfall Unity
// Game/Questing/Actions/*.cs (MIT, see NOTICE.txt). Behaviour lives in engine.js.
//
// status:
//   exact    — implemented with the original semantics
//   approx   — implemented, but the world model is simpler (e.g. a building is treated as
//              its town because interiors are not modelled); listed in the quest's report
//   ignored  — no runtime effect (location marker, create npc at); listed, never blocks
//   unsupported — recognised but not implemented; the quest is not offered
// A line that matches nothing is `unknown` and is treated like `unsupported`.

const S = '([A-Za-z0-9_.-]+)'; // a symbol
const N = '(-?\\d+)';
const ID = '(\\d+|[A-Za-z]+)'; // message id or static message name

/** "location _a_ person _b_ item _c_" -> [{kind:'place'|'person'|'item', symbol}], empty operands dropped. */
function dialogRefs(text) {
  const kinds = { location: 'place', person: 'person', item: 'item' };
  return [...text.matchAll(/(location|person|item)\s+([A-Za-z0-9_.-]+)/gi)]
    .filter((m) => !/^_missing/i.test(m[2]))
    .map((m) => ({ kind: kinds[m[1].toLowerCase()], symbol: m[2] }));
}

/** Normalises comparison keywords/symbols from Daggerfall Unity trigger lines. */
function normOp(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'at least' || s === '>=') return '>=';
  if (s === 'at most' || s === '<=') return '<=';
  if (s === 'less than' || s === '<') return '<';
  if (s === 'greater than' || s === '>' || s === 'exceeds') return '>';
  return '>=';
}

/** [name, regex, kind, status, (m) => args] — order matters: first match wins. */
const DEFS = [
  // ---- conditions (IsTriggerCondition)
  // Daggerfall Unity WhenSkillLevel: re-evaluated every update (not latching).
  ['whenSkill', `^when\\s+skill\\s+([A-Za-z0-9_ -]+?)\\s+is\\s+(at\\s+least|at\\s+most|less\\s+than|greater\\s+than|>=|<=|>|<)\\s+(-?\\d+)$`, 'trigger', 'exact',
    (m) => ({ skill: m[1].trim(), op: normOp(m[2]), amount: +m[3] })],
  // Classic 0x4f / Daggerfall Unity WhenReputeWith: re-evaluated every update (not latching); supports >=, <=, <, >.
  ['whenRepute', `^when\\s+repute\\s+with\\s+(?:faction\\s+(\\d+)|${S})\\s+(?:is\\s+(at\\s+least|at\\s+most|less\\s+than|greater\\s+than|>=|<=|>|<)|exceeds)\\s+(-?\\d+)$`, 'trigger', 'exact',
    (m) => ({ faction: m[1] !== undefined ? +m[1] : null, person: m[2] ?? null, op: m[3] ? normOp(m[3]) : '>', amount: +m[4] })],
  // Daggerfall Unity WhenNpcIsAvailable: the individual has not been destroyed or sent away by this quest.
  ['whenAvailable', `^when\\s+${S}\\s+is\\s+available$`, 'trigger', 'exact', (m) => ({ person: m[1] })],
  ['whenReputeOther', `^when\\s+repute\\s+`, 'trigger', 'unsupported', () => ({})],
  ['when', `^when\\s+(.+)$`, 'trigger', 'exact', (m) => ({ expr: m[1] })],
  ['clickedNpcGold', `^clicked\\s+${S}\\s+and\\s+at\\s+least\\s+(\\d+)\\s+gold\\s+otherwise\\s+do\\s+${S}$`, 'trigger', 'exact', (m) => ({ person: m[1], gold: +m[2], otherwise: m[3] })],
  ['clickedNpc', `^clicked\\s+npc\\s+${S}(?:\\s+say\\s+${ID})?$`, 'trigger', 'exact', (m) => ({ person: m[1], say: m[2] })],
  ['clickedItem', `^clicked\\s+item\\s+${S}(?:\\s+say\\s+${ID})?$`, 'trigger', 'exact', (m) => ({ item: m[1], say: m[2] })],
  ['toting', `^toting\\s+${S}\\s+and\\s+${S}\\s+clicked(?:\\s+saying\\s+${ID})?$`, 'trigger', 'exact', (m) => ({ item: m[1], person: m[2], say: m[3] })],
  ['killed', `^killed\\s+(?:(\\d+)\\s+)?${S}(?:\\s+saying\\s+(\\d+))?$`, 'trigger', 'exact', (m) => ({ count: Math.max(1, +(m[1] || 1)), foe: m[2], say: m[3] })],
  ['injured', `^injured\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'trigger', 'exact', (m) => ({ foe: m[1], say: m[2] })],
  ['dailyFrom', `^daily\\s+from\\s+(\\d+):(\\d+)\\s+to\\s+(\\d+):(\\d+)$`, 'trigger', 'exact', (m) => ({ from: +m[1] * 60 + +m[2], to: +m[3] * 60 + +m[4] })],
  // Classic opcode 0x4e (decompiled by qbn.js); Daggerfall Unity's script reads it as clicking that individual.
  ['clickedIndividual', `^clicked\\s+individual\\s+(\\d+)$`, 'trigger', 'approx', (m) => ({ faction: +m[1] })],
  // Classic 0x05: the player puts the held quest item down (quest.drop) while at that place.
  ['dropped', `^dropped\\s+${S}\\s+at\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'trigger', 'exact', (m) => ({ item: m[1], place: m[2], say: m[3] })],
  // Classic 0x4d / Daggerfall Unity LevelCompleted: the character has reached level N.
  ['levelCompleted', `^level\\s+(\\d+)\\s+completed$`, 'trigger', 'exact', (m) => ({ level: +m[1] })],
  // Classic 0x49 / Daggerfall Unity CastSpellDo: the questee casts spell N (SPELLS.STD index) anywhere.
  ['castSpellDo', `^cast\\s+spell\\s+(\\d+)\\s+do\\s+${S}$`, 'action', 'exact', (m) => ({ spell: +m[1], task: m[2] })],

  // ---- actions
  ['pcAt', `^pc\\s+at\\s+${S}\\s+(set|do)\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'action', 'approx', (m) => ({ place: m[1], task: m[3], say: m[4] })],
  // Daggerfall Unity PcAt (any <placeType>): evaluates against the player's current building or location kind.
  ['pcAtAny', `^pc\\s+at\\s+any\\s+${S}\\s+(set|do)\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'action', 'approx',
    (m) => ({ placeType: m[1].toLowerCase(), task: m[3], say: m[4] })],
  ['say', `^say\\s+${ID}$`, 'action', 'exact', (m) => ({ id: m[1] })],
  ['log', `^log\\s+(\\d+)(?:\\s+step)?\\s+(\\d+)$`, 'action', 'exact', (m) => ({ id: +m[1], step: +m[2] })],
  ['removeLog', `^remove\\s+log\\s+step\\s+(\\d+)$`, 'action', 'exact', (m) => ({ step: +m[1] })],
  ['prompt', `^prompt\\s+${ID}\\s+yes\\s+${S}\\s+no\\s+${S}$`, 'action', 'exact', (m) => ({ id: m[1], yes: m[2], no: m[3] })],
  ['givePcNothing', `^give\\s+pc\\s+nothing$`, 'action', 'exact', () => ({})],
  ['givePc', `^give\\s+pc\\s+${S}(?:\\s+(notify)\\s+(\\d+)|\\s+(silently))?$`, 'action', 'exact', (m) => ({ item: m[1], notify: m[3], silently: !!m[4] })],
  ['getItem', `^get\\s+item\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ item: m[1], say: m[2] })],
  ['takeItem', `^take\\s+${S}\\s+from\\s+pc(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ item: m[1], say: m[2] })],
  ['giveItemTo', `^give\\s+item\\s+${S}\\s+to\\s+${S}$`, 'action', 'approx', (m) => ({ item: m[1], target: m[2] })],
  ['endQuest', `^end\\s+quest(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ say: m[1] })],
  ['startTimer', `^start\\s+timer\\s+${S}$`, 'action', 'exact', (m) => ({ clock: m[1] })],
  ['stopTimer', `^stop\\s+timer\\s+${S}$`, 'action', 'exact', (m) => ({ clock: m[1] })],
  ['startTask', `^(?:start\\s+task|setvar)\\s+${S}$`, 'action', 'exact', (m) => ({ task: m[1] })],
  ['clear', `^clear\\s+(.+)$`, 'action', 'exact', (m) => ({ tasks: m[1].trim().split(/\s+/) })],
  ['unset', `^unset\\s+(.+)$`, 'action', 'exact', (m) => ({ tasks: m[1].trim().split(/\s+/) })],
  ['pickOne', `^pick\\s+one\\s+of\\s+(.+)$`, 'action', 'exact', (m) => ({ tasks: m[1].trim().split(/\s+/) })],
  ['placeNpc', `^place\\s+npc\\s+${S}\\s+at\\s+${S}(?:\\s+marker\\s+(\\d+))?$`, 'action', 'approx', (m) => ({ person: m[1], place: m[2], marker: m[3] === undefined ? null : +m[3] })],
  ['placeFoe', `^place\\s+foe\\s+${S}\\s+at\\s+${S}(?:\\s+marker\\s+(\\d+))?$`, 'action', 'approx', (m) => ({ foe: m[1], place: m[2], marker: m[3] === undefined ? null : +m[3] })],
  ['placeItem', `^place\\s+item\\s+${S}\\s+at\\s+${S}(?:\\s+marker\\s+(\\d+))?$`, 'action', 'approx', (m) => ({ item: m[1], place: m[2], marker: m[3] === undefined ? null : +m[3] })],
  ['createNpcAt', `^create\\s+npc\\s+at\\s+${S}`, 'action', 'ignored', () => ({})],
  ['createNpc', `^create\\s+npc\\s+${S}$`, 'action', 'approx', (m) => ({ person: m[1] })],
  ['hideNpc', `^hide\\s+npc\\s+${S}$`, 'action', 'exact', (m) => ({ person: m[1] })],
  ['restoreNpc', `^restore\\s+npc\\s+${S}$`, 'action', 'exact', (m) => ({ person: m[1] })],
  ['destroyNpc', `^destroy\\s+npc\\s+${S}$`, 'action', 'exact', (m) => ({ person: m[1] })],
  ['removeFoe', `^remove\\s+foe\\s+${S}$`, 'action', 'exact', (m) => ({ foe: m[1] })],
  ['createFoe', `^(create\\s+foe|send)\\s+${S}\\s+every\\s+(\\d+)\\s+minutes\\s+(?:(\\d+)\\s+times\\s+|(indefinitely)\\s+)?with\\s+(\\d+)%\\s+success(?:\\s+msg\\s+(\\d+))?$`, 'action', 'approx',
    (m) => ({ foe: m[2], minutes: +m[3], times: m[5] ? -1 : m[4] ? +m[4] : -1, chance: +m[6], msg: m[7], send: /^send/i.test(m[1]) })],
  ['restrainFoe', `^restrain\\s+foe\\s+${S}$`, 'action', 'approx', (m) => ({ foe: m[1], restrained: true })],
  ['unrestrainFoe', `^unrestrain\\s+foe\\s+${S}$`, 'action', 'approx', (m) => ({ foe: m[1], restrained: false })],
  ['changeRepute', `^change\\s+repute\\s+with\\s+${S}\\s+by\\s+([+-]?\\s*\\d+)$`, 'action', 'exact', (m) => ({ person: m[1], amount: Number(m[2].replace(/\s+/g, '')) })],
  ['reputeExceeds', `^repute\\s+with\\s+${S}\\s+exceeds\\s+(\\d+)\\s+do\\s+${S}$`, 'action', 'exact', (m) => ({ person: m[1], amount: +m[2], task: m[3] })],
  // Classic 0x1b / Daggerfall Unity RevealLocation "in province": a fixed MAPS record (region, low 20 bits of mapId).
  ['revealAt', `^reveal\\s+${S}\\s+in\\s+province\\s+(\\d+)\\s+at\\s+(\\d+)(?:\\s+readmap)?$`, 'action', 'exact', (m) => ({ place: m[1], region: +m[2], mapId: +m[3] })],
  ['reveal', `^reveal\\s+${S}(?:\\s+readmap)?$`, 'action', 'approx', (m) => ({ place: m[1] })],
  // Classic 0x52 / Daggerfall Unity Person "atHome": the person stays at (returns to) their own home.
  ['npcAtHome', `^npc\\s+${S}\\s+at\\s+home$`, 'action', 'exact', (m) => ({ person: m[1] })],
  // Classic 0x41: regional legal reputation (law owner's services.law.changeLegalRep).
  ['legalRepute', `^legal\\s+repute\\s+([+-]?\\s*\\d+)$`, 'action', 'exact', (m) => ({ amount: Number(m[1].replace(/\\s+/g, '')) })],
  // Classic 0x45: the foe carries spell N (SPELLS.STD) from its next appearance; consumed by combat.
  ['castOnFoe', `^cast\\s+spell\\s+(\\d+)\\s+on\\s+${S}$`, 'action', 'approx', (m) => ({ spell: +m[1], foe: m[2] })],
  // Classic 0x48 / 0x31 / 0x3a / 0x3b: handed to the health-condition owner (services.applyCondition / cureCondition).
  ['makeIll', `^make\\s+pc\\s+ill\\s+with\\s+(?:disease\\s+(\\d+)|([A-Za-z_']+))(?:\\s+saying\\s+(\\d+))?$`, 'action', 'approx', (m) => ({ disease: m[1] !== undefined ? +m[1] : m[2], say: m[3] })],
  ['cure', `^cure\\s+(?:disease\\s+(\\d+)|(vampirism|lycanthropy)|([A-Za-z_']+))$`, 'action', 'approx', (m) => ({ disease: m[1] !== undefined ? +m[1] : m[3] ?? null, condition: m[2]?.toLowerCase() ?? 'disease' })],
  ['itemUsedDo', `^${S}\\s+used\\s+do\\s+${S}(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ item: m[1], task: m[2], say: m[3] })],
  ['haveItem', `^have\\s+${S}\\s+set\\s+${S}$`, 'action', 'exact', (m) => ({ item: m[1], task: m[2] })],
  ['makePermanent', `^make\\s+${S}\\s+permanent$`, 'action', 'exact', (m) => ({ item: m[1] })],

  // ---- conversation hooks: kept on the instance for the NPC owner (services.quests.talk)
  // Classic 0x0a / 0x0b, Daggerfall Unity AddDialog / DialogLink: quest resources become "tell me about" topics, and
  // linked resources are learned together. Operands the QBN leaves empty (-1) decode as _missing…_ and are dropped.
  ['addDialog', `^add\\s+dialog\\s+for\\s+(.+)$`, 'action', 'approx', (m) => ({ refs: dialogRefs(m[1]) })],
  ['dialogLink', `^dialog\\s+link\\s+for\\s+(.+)$`, 'action', 'approx', (m) => ({ refs: dialogRefs(m[1]) })],
  // Classic 0x37/0x38 and 0x3f/0x40 / Daggerfall Unity AddFace, DropFace (HUDEscortingNPCFaces): a person or foe
  // travelling with the player. Kept on the instance (`faces`) so the companion persists and is shown to its owner.
  ['addFoeFace', `^(add|drop)\\s+foe\\s+${S}\\s+face(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ add: m[1].toLowerCase() === 'add', foe: m[2], say: m[3] })],
  ['locationMarker', `^location\\s+marker\\b`, 'action', 'ignored', () => ({})],
  // Classic 0x3c (only in B0B71Y03 _S.20_, Auriel's Bow): Daggerfall Unity treats `_0x3c_ 19` as a no-op so B0B71Y03 is playable.
  ['opcode3c', `^_0x3c_\\s+${N}$`, 'action', 'ignored', (m) => ({ value: +m[1] })],
  ['addFace', `^add\\s+${S}\\s+face(?:\\s+saying\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ person: m[1], say: m[2] })],
  ['dropFace', `^drop\\s+${S}\\s+face$`, 'action', 'exact', (m) => ({ person: m[1] })],
  // Classic 0x55 / 0x56, Daggerfall Unity AddQuestor / DropQuestor: the person speaks for the quest like its giver.
  ['addQuestor', `^add\\s+${S}\\s+as\\s+questor$`, 'action', 'approx', (m) => ({ person: m[1], add: true })],
  ['dropQuestor', `^drop\\s+${S}\\s+as\\s+questor$`, 'action', 'approx', (m) => ({ person: m[1], add: false })],
  // Classic 0x26 / Daggerfall Unity RumorMill: a quest message joins the rumours townspeople tell the quest owner.
  ['rumorMill', `^rumor\\s+mill\\s+${ID}$`, 'action', 'approx', (m) => ({ id: m[1] })],
  // Classic 0x54 / Daggerfall Unity PlaySound: DAGGER.SND clip, replayed every N game minutes, M plays in all.
  ['playSound', `^play\\s+sound\\s+(\\d+)(?:\\s+every\\s+(\\d+)\\s+minutes(?:\\s+(-?\\d+)\\s+times)?)?$`, 'action', 'approx',
    (m) => ({ sound: +m[1], minutes: m[2] === undefined ? 0 : +m[2], times: m[3] === undefined ? 1 : +m[3] })],
  // Daggerfall Unity PlaySong (script-only, no classic opcode): one named song for the owner.
  ['playSong', `^play\\s+song\\s+${S}$`, 'action', 'approx', (m) => ({ song: m[1] })],
  // Daggerfall Unity MuteNpc (script-only): the person stops offering conversation for this quest's owner.
  ['muteNpc', `^mute\\s+npc\\s+${S}$`, 'action', 'approx', (m) => ({ person: m[1] })],
  // Other spellings of the hooks above (named sounds, bare forms) stay harmless no-ops rather than blocking a quest.
  ['hookOther', `^(add\\s+dialog|dialog\\s+link|rumor\\s+mill|play\\s+(sound|song)|mute\\s+npc|(add|drop)\\s+\\S+\\s+as\\s+questor)\\b`, 'action', 'ignored', () => ({})],

  // ---- recognised, not implemented
  ['playVideo', `^play\\s+video\\s+(\\d+)$`, 'action', 'exact', (m) => ({ video: +m[1] })],
  // StartQuest.cs: "start/run quest 16 16" or "start/run quest <name>" schedules the quest for the same player.
  ['startQuest', `^(?:start|run)\\s+quest\\s+(?:(\\d+)(?:\\s+\\d+)?|([A-Za-z0-9$_]{1,8}))$`, 'action', 'exact',
    (m) => ({ quest: m[1] ? `S${m[1].padStart(7, '0')}` : m[2].toUpperCase() })],
  ['runQuest', `^(start|run)\\s+quest\\b`, 'action', 'unsupported', () => ({})],
  // TeleportPc.cs "transfer pc inside <place> marker <n>": only S0000016 uses it (Mantellan Crux and back).
  ['transferPc', `^transfer\\s+pc\\s+inside\\s+${S}(?:\\s+marker\\s+(\\d+))?$`, 'action', 'exact', (m) => ({ place: m[1], marker: +(m[2] || 0) })],
  ['castOther', `^cast\\b`, 'action', 'unsupported', () => ({})],
  // Classic 0x1e with person -1 / Daggerfall Unity TeleportPc: into the place's interior at its entrance (or marker).
  ['teleportPc', `^teleport\\s+pc\\s+to\\s+${S}(?:\\s+(?:at\\s+)?marker\\s+(\\d+))?$`, 'action', 'approx',
    (m) => ({ place: m[1], marker: m[2] === undefined ? null : +m[2] })],
  ['teleport', `^(teleport|transfer)\\s+pc\\b`, 'action', 'unsupported', () => ({})],
  ['makePcOther', `^make\\s+pc\\b`, 'action', 'unsupported', () => ({})],
  // Multiplayer-safe per-player atmosphere/season override (never mutates shared world clock or other players).
  ['world', `^(?:change\\s+)?(weather|climate|season)\\s+${S}$`, 'action', 'approx',
    (m) => ({ aspect: m[1].toLowerCase(), value: m[2] })],
  // Daggerfall Unity TrainPc: advances the player's skill via character service.
  ['trainPc', `^train\\s+pc\\s+([A-Za-z0-9_ -]+?)(?:\\s+by\\s+(\\d+))?$`, 'action', 'approx',
    (m) => ({ skill: m[1].trim(), amount: m[2] === undefined ? null : +m[2] })],
  // Daggerfall Unity SpawnCityGuards: invokes law guard spawn hook when installed, degrades cleanly otherwise.
  ['spawnGuards', `^spawn\\s+city\\s+guards(?:\\s+(immediate))?$`, 'action', 'approx',
    (m) => ({ immediate: !!m[1] })],
  // Daggerfall Unity ChangeFoeTeam: sets faction/team override on a quest foe.
  ['changeFoe', `^change\\s+foe\\s+${S}\\s+team\\s+(-?\\d+|${S})$`, 'action', 'approx',
    (m) => ({ foe: m[1], team: /^-?\d+$/.test(m[2]) ? +m[2] : m[2] })],
  // Daggerfall Unity KillFoe: marks the foe slain and removes live quest foe entities.
  ['killFoe', `^kill\\s+foe\\s+${S}$`, 'action', 'exact', (m) => ({ foe: m[1] })],
  // Daggerfall Unity PayMoney: deducts gold transactionally or triggers the optional otherwise task.
  ['payMoney', `^pay\\s+(\\d+)\\s+money\\s+(?:do|set)\\s+${S}(?:\\s+otherwise\\s+(?:do|set)\\s+${S})?$`, 'action', 'exact',
    (m) => ({ gold: +m[1], task: m[2], otherwise: m[3] ?? null })],
  ['unknownOpcode', `^unknown\\s+opcode\\b`, 'action', 'unsupported', () => ({})],
];

const COMPILED = DEFS.map(([name, re, kind, status, args]) => ({ name, re: new RegExp(re, 'i'), kind, status, args }));

/** Every recognised action name with its status, for reports and docs. */
export const ACTION_TABLE = Object.freeze(COMPILED.map(({ name, kind, status }) => ({ name, kind, status })));

/** Compiles one task line. Unknown lines become {name:'unknown', status:'unsupported'}. */
export function compileAction(source) {
  const line = String(source).trim().replace(/\s+/g, ' ');
  for (const d of COMPILED) {
    const m = line.match(d.re);
    if (m) {
      return {
        source: line,
        name: d.name,
        kind: d.kind,
        status: d.status,
        always: d.name === 'when' || d.name === 'whenRepute' || d.name === 'whenSkill' || d.name === 'whenAvailable',
        rearm: !['givePc', 'givePcNothing', 'endQuest', 'prompt', 'startQuest', 'transferPc', 'teleportPc'].includes(d.name),
        args: d.args(m),
      };
    }
  }
  return { source: line, name: 'unknown', kind: 'action', status: 'unsupported', always: false, rearm: true, args: {} };
}

/** Parses a `when` expression into [{op:'when'|'and'|'or', not, task}]. */
export function parseWhen(expr) {
  const toks = `when ${expr}`.trim().split(/\s+/);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const op = toks[i].toLowerCase();
    if (!['when', 'and', 'or'].includes(op)) return null;
    let not = false;
    if ((toks[i + 1] || '').toLowerCase() === 'not') { not = true; i++; }
    const task = toks[++i];
    if (!task) return null;
    out.push({ op, not, task });
  }
  return out.length ? out : null;
}
