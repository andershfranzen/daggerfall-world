// Compatibility adjustments for the operator's classic QBNs.
//
// Each entry adjusts decompiled source logic using the installed script references and individual QBN symbols.
// The quest report lists these corrections. All text still comes from the files supplied by the operator.

export const CORRECTIONS = Object.freeze({
  B0B70Y16: {
    note: 'The Dragonslayer uses a Dragon’s Den (QBN dungeon type 14 and the reference script’s dungeon14 only).',
    adapt: (lines) => lines.map((line) => line === 'Place _L.00_ remote dungeon14' ? `${line} only` : line),
  },
  _TUTOR__: {
    note: 'Leaving Privateer’s Hold stops stale indoor lesson timers, indoor follow-ups only start inside the Hold, and arriving in Daggerfall city fires Lesson 9 only once.',
    adapt: (lines) => {
      const indoorFollow = {
        '_S.16_': '_S.04_',
        '_S.17_': '_S.06_',
        '_S.18_': '_S.05_',
        '_S.19_': '_S.07_',
        '_S.20_': '_S.08_',
      };
      let currentTask = null;
      const extra = ['', 'variable _atdf_'];
      const adapted = lines.map((line) => {
        const m = /^(_S\.\d+_) task:$/.exec(line);
        if (m) currentTask = m[1];
        if (line === '\tpc at _L.01_ set _S.25_') return '\tpc at _L.01_ set _atdf_';
        if (line === '\tsay 1040') {
          return [
            '\tstop timer _S.03_',
            '\tstop timer _S.04_',
            '\tstop timer _S.05_',
            '\tstop timer _S.06_',
            '\tstop timer _S.07_',
            '\tstop timer _S.08_',
            line,
          ].join('\n');
        }
        if (line === '_S.25_ task:') return '_S.25_ task:\n\twhen _atdf_ and not _S.22_';
        if (currentTask && indoorFollow[currentTask] && line === `\tstart timer ${indoorFollow[currentTask]}`) {
          const timer = indoorFollow[currentTask];
          const gate = `_hold_${currentTask.slice(1, -1)}_`;
          extra.push('', `${gate} task:`, `\twhen ${currentTask} and _S.00_`, `\tstart timer ${timer}`);
          return '';
        }
        return line;
      });
      return [...adapted, ...extra];
    },
  },
  _BRISIEN: {
    note: 'The starting dungeon holds the contact clock until the character leaves, as in the _BRISIEN exit task.',
    adapt: (lines) => [
      ...lines.map((line) => {
        if (line === '\tpc at _L.00_ set _S.05_') return '\tpc at _L.00_ set _inhold_';
        if (line === '_S.05_ task:') return '_S.05_ task:\n\twhen not _inhold_';
        if (line === '\tremove log step 0') return `${line}\n\tunset _S.05_`;
        return line;
      }),
      '', 'variable _inhold_',
    ],
  },
  S0000007: {
    note: 'Cyndassa’s hunt places the werewolf at Tristore spawn marker 1 and starts the courier episode after a return audience following the kill.',
    adapt: (lines) => lines.map((line) => line === '\tplace foe _F.00_ at _L.00_' ? `${line} marker 1` : line),
    lines: ['', 'until _S.07_ performed:', '\tclear _S.06_ _S.33_'],
  },
  S0000015: {
    note: 'The source-compatible revenge task starts the Totem quest without setting its Gothryd delivery flag.',
    adapt: (lines) => lines.map((line) => {
      if (line === 'GothrydGotTotem _S.11_') return '_S.11_ task:';
      if (line === '\tplace item _I.00_ at _L.00_') return `${line} marker 1`;
      if (line === '\tplace foe _F.00_ at _L.01_') return `${line} marker 2`;
      return line;
    }),
  },
  S0000999: {
    note: 'The cure reset starts S0000977. Each court starts its work from an audience at the required level and standing.',
    adapt: (lines) => lines.flatMap((line, index) => {
      if (line === '\tstart quest 997 997') return ['\tstart quest 977 977'];
      if (!line.startsWith('\tsay ')) return [line];
      const feedback = lines[index - 2]?.match(/^(_S\.(?:2[2-9]|3[0-5])_) task:$/)?.[1];
      const audience = lines[index - 1]?.match(/^\twhen (_S\.0[0-6]_) and /)?.[1];
      return feedback && audience ? [line, `\tclear ${audience} ${feedback}`] : [line];
    }),
  },
  S0000020: {
    note: 'Mynisera requires a new audience once Morgiah or Barenziah has supplied the lead. The accepted offer preserves the letter handover click. The Emperor’s letter uses Orsinium item marker 0, as in the reference S0000020 script.',
    adapt: (lines) => lines.map((line) => {
      if (line === '\tlog 1010 step 0') return `${line}\n\tunset _S.00_`;
      if (line === '\tplace item _I.00_ at _L.00_') return `${line} marker 0`;
      return line;
    }),
    lines: ['', 'until _S.02_ performed:', '\tclear _S.00_ _S.10_'],
  },
  S0000021: {
    note: 'The courier summons ends on the first kill. The offer and the Lich’s Soul reward each require their own audience.',
    adapt: (lines) => lines.map((line) => {
      if (line === '\twhen _S.02_ and _S.15_') return '\twhen _S.02_ and _S.15_ and not _S.04_';
      if (line === '\tadd _P.01_ face') return `${line}\n\tunset _S.02_`;
      if (line === '\tclear _S.06_') return '\tunset _S.06_';
      return line;
    }),
    lines: ['', 'until _S.15_ performed:', '\tclear _S.02_', '', '_S.18_ task:',
      '\twhen _S.02_ and _S.04_ and not _S.08_', '\tclear _S.02_ _S.18_'],
  },
  // S0000008 (the Totem): classic _S.39_ is "individual 303 (Nulfaga) available" (opcode 0x4e). Daggerfall Unity's
  // S0000008.txt reads it as "clicked npc _nulfaga_" and adds _clearnulfaga_, so that talking to Nulfaga before the
  // totem has been delivered does not count, and Nulfaga sends the player only when spoken to afterwards. Without it
  // an early visit would latch _S.39_ and _S.41_ would start S0000016 (the Mantellan Crux transfer) at delivery time,
  // wherever the player stands.
  S0000008: {
    note: '_S.39_ Nulfaga must be spoken to after delivering the totem (Daggerfall Unity _clearnulfaga_)',
    lines: ['', '_S.47_ task:', '\twhen _S.39_ and not _S.40_', '\tclear _S.39_ _S.47_'],
  },
});
