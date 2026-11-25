export const OPENING_DUNGEON = "dungeon:Daggerfall/Privateer's Hold";
export const LYSANDUS_TOMB = "dungeon:Menevia/Lysandus' Tomb";

// Fixed site codes in the installed QBNs. The addresses resolve against MAPS.BSA.
// The low byte of p2 identifies a classic site variant, not a marker-array index.
export const CAMPAIGN_SITES = [
  ['PirateerHold1', 0xc382, 0xfa01, OPENING_DUNGEON],
  ['PirateerHold2', 0xc382, 0xfa02, OPENING_DUNGEON],
  ['DirenniTowerEntry', 0xc364, 0xfa01, 'town:Isle of Balfiera/Direnni Tower'],
  ['DirenniTower2', 0xc365, 0xfa02, 'dungeon:Isle of Balfiera/Direnni Tower'],
  ['DirenniTower3', 0xc365, 0xfa08, 'dungeon:Isle of Balfiera/Direnni Tower'],
  ['Llugwych', 0xc352, 0x0001, 'town:Ykalon/Castle Llugwych'],
  ['LlugwychCastle', 0xc353, 0xfa02, 'dungeon:Ykalon/Castle Llugwych'],
  ['LysandusTomb1', 0xc368, 0xfa01, LYSANDUS_TOMB],
  ['LysandusTomb2', 0xc368, 0x0002, LYSANDUS_TOMB],
  ['OrsiniumCastle1', 0xc35f, 0xfa01, 'dungeon:Orsinium Area/Orsinium'],
  ['OrsiniumCastle2', 0xc35f, 0x0002, 'dungeon:Orsinium Area/Orsinium'],
  ['OrsiniumCastle4', 0xc35f, 0xfa04, 'dungeon:Orsinium Area/Orsinium'],
  ['ScourgBarrow1', 0xc379, 0xfa01, 'dungeon:Dragontail Mountains/Scourg Barrow'],
  ['ScourgBarrow2', 0xc379, 0xfa0c, 'dungeon:Dragontail Mountains/Scourg Barrow'],
  ['SentinelCastle', 0xc371, 0xfa01, 'dungeon:Sentinel/Sentinel'],
  ['WayrestCastle', 0xc36d, 0xfa01, 'dungeon:Wayrest/Wayrest'],
  ['WoodbourneHall4', 0xc363, 0xfa04, 'dungeon:Wayrest/Woodborne Hall'],
  ['WoodbourneHall5', 0xc363, 0xfa05, 'dungeon:Wayrest/Woodborne Hall'],
  ['Castle_Necromoghan', 0x4587, 0x0001, 'dungeon:Daggerfall/Castle Necromoghan'],
  ['Tristore_Laboratory1', 0x5825, 0xfa01, 'dungeon:Betony/Tristore Laboratory'],
  ['Tristore_Laboratory2', 0x5825, 0xfa02, 'dungeon:Betony/Tristore Laboratory'],
  ['Tristore_Laboratory4', 0x5825, 0xfa04, 'dungeon:Betony/Tristore Laboratory'],
  ['BluffCoven', 0xc360, 0x0001, 'town:Daggerfall/Coven on the Bluff'],
];
