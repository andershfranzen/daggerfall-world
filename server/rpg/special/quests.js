// Adjustments for installed special scripts. Their messages still come from the matching QRC.
export const SPECIAL_QUESTS = {
  O0A0AL00: {
    name: 'The Qualifying Examination',
    homes: { 'p.00': 'tavern' },
    letters: {
      'i.01': { 'l.00': 'Mansion from the letter' },
      'i.02': { 'home.p.00': 'Thieves Guild contact' },
    },
    note: 'The note’s guild contact meets the initiate at a tavern in the assigned town.',
  },
  L0A01L00: {
    name: 'The Acceptance Test',
    homes: { 'p.00': 'tavern', 'p.01': 'apothecary' },
    items: { 'i.01': 'wine decanter', 'i.02': 'snake venom' },
    letters: { 'i.00': { 'home.p.01': 'Apothecary from the letter' } },
    messages: { 1015: { 'l.00': 'Mansion from the apothecary', 'home.p.00': 'Dark Brotherhood contact' } },
    note: 'The appointment clock stops on meeting the chemist, and an initiate who reports without doing the job cannot later claim membership.',
    adapt: (lines) => lines.map((line) => {
      switch (line) {
        case 'Clock _S.01_ 0.00:00 0.00:00 flag 1 range 1 4':
          // The original clock is for the chemist appointment, which precedes the mansion trip.
          return 'Clock _S.01_ 30.00:00 0.00:00 flag 1 range 1 4';
        case '\tpc at _L.00_ set _S.08_': return `${line}\n\tstop timer _S.01_`;
        case '\twhen _S.11_ and _S.03_ and _S.05_': return `${line} and not _S.09_`;
        case '\tstart timer _S.12_': return `${line}\n\tstop timer _S.00_`;
        default: return line;
      }
    }),
  },
  '20C00Y00': {
    note: 'Molag Bal’s mage uses the specified dungeon classes, and his contact checks the kill before clearing an early visit.',
    adapt: (lines) => lines.map((line) => {
      if (line === 'Place _L.00_ remote dungeon9') return `${line} only`;
      if (line === 'Place _L.02_ remote dungeon11') return `${line},dungeon2 only`;
      if (line === '\twhen _S.03_ and not _S.05_') return '\twhen _S.03_ and not _S.02_\n\tsay 1003';
      if (line === '\tplace foe _F.00_ at _L.02_') return `${line}\n\tsay 1040`;
      return line;
    }),
  },
  '70C00Y00': {
    note: 'Sanguine’s target can be found in either of the source dungeon classes.',
    adapt: (lines) => lines.map((line) => line === 'Place _L.00_ remote dungeon4' ? `${line},dungeon7 only` : line),
  },
  T0C00Y00: {
    note: 'Azura’s healer can be found in either of the source dungeon classes.',
    adapt: (lines) => lines.map((line) => line === 'Place _L.00_ remote dungeon4' ? `${line},dungeon7 only` : line),
  },
  U0C00Y00: {
    note: 'Boethiah’s two hideouts use the dungeon classes specified in the source correction.',
    firstPlaceClock: 's.07',
    adapt: (lines) => lines.map((line) => {
      if (line === 'Place _L.00_ remote dungeon2') return `${line},dungeon15 only`;
      if (line === 'Place _L.01_ remote dungeon6') return `${line},dungeon5 only`;
      return line;
    }),
  },
  W0C00Y00: {
    homes: { 'p.01': 'library' },
    note: 'Sparing the Spellsword exposes the dungeon where he takes refuge.',
    adapt: (lines) => lines.map((line) => line === '\tplace foe _F.00_ at _L.01_' ? `${line}\n\treveal _L.01_` : line),
  },
  '40C00Y00': {
    homes: { 'p.01': 'library' },
    ownsArtifacts: ['i.01', 'i.02'],
    note: 'The mage makes his offer once, while alive, and the chosen bribe keeps its quest identity until cashed in.',
    lines: ['', 'variable _offerBow_', 'variable _offerRing_', 'variable _offerStaff_'],
    adapt: (lines) => lines.map((line) => {
      if (line === '\tclear _S.04_') return `${line}\n\tpc at _L.00_ set _S.00_`;
      if (line === '_S.00_ task:') return 'variable _S.00_';
      if (line === '\tpc at _L.00_ set _S.00_') return '';
      if (line.startsWith('\twhen _S.07_')) return `${line} and not _S.05_ and not _S.17_ and not _S.18_`;
      if (line === '\twhen _S.17_ and _S.19_') return '\twhen _S.17_ and _offerBow_';
      if (line === '\twhen _S.17_ and _S.20_') return '\twhen _S.17_ and _offerRing_';
      if (line === '\twhen _S.17_ and _S.21_') return '\twhen _S.17_ and _offerStaff_';
      const offer = line.match(/^\tprompt 103([012]) yes /);
      if (offer) return `${line}\n\tstart task _offer${['Bow', 'Ring', 'Staff'][Number(offer[1])]}_`;
      if (line === '\twhen _S.10_ and not _S.08_') return '\twhen _S.10_ and _S.14_ and not _S.05_';
      if (line === '\twhen _S.10_ and _S.08_ and not _S.09_') return '\twhen _S.10_ and _S.15_ and not _S.05_';
      if (line === '\twhen _S.10_ and _S.08_ and _S.09_') return '\twhen _S.10_ and _S.16_ and not _S.05_';
      const relocated = line.match(/^\tplace item (_I\.0[123]_) at _L\.04_$/);
      if (relocated) return `\ttake ${relocated[1]} from pc\n${line}`;
      const crumbled = line.match(/^\tsay 104([567])$/);
      if (crumbled) return `${line}\n\tclear _S.1${Number(crumbled[1]) - 4}_`;
      return line;
    }),
  },
};
