// Static NPC content: roles, guilds, factions, district rosters, stock and
// dialogue. All prose here is original to this project.
//
// Numbers that identify classic data are references, not content:
// - Faction ids follow FactionFile.FactionIDs in Daggerfall Unity
//   (MIT, (c) 2009-2023 Daggerfall Workshop): 40 mages, 41 fighters,
//   82 a temple order, 201 the Daggerfall region court.
// - Guild rank requirements follow Guild.cs in Daggerfall Unity (same licence):
//   reputation 10 per rank, guild skills compared against high/low tables.
// - Sprites are {archive, record} into the player's own TEXTURE.nnn files
//   (334 = Daggerfall townsfolk flats, 182 = common people flats).

export const TALK_RANGE = 3.5; // metres, measured on the ground plane
export const SESSION_TTL_MS = 5 * 60_000;
export const RESTOCK_MS = 30 * 60_000;
export const TRAIN_COOLDOWN_MS = 60_000;
export const MAX_QUANTITY = 99;
export const HOSTILE_REPUTATION = -10; // at or below: no trade, no services
export const REP_MIN = -100;
export const REP_MAX = 100;

export const FACTIONS = Object.freeze({
  40: { id: 40, name: 'Mages Guild', kind: 'guild' },
  41: { id: 41, name: 'Fighters Guild', kind: 'guild' },
  82: { id: 82, name: 'Temple', kind: 'temple' },
  201: { id: 201, name: 'Daggerfall Court', kind: 'region' },
  900: { id: 900, name: 'Merchants of the district', kind: 'people' },
});
export const REGION_FACTION = 201;
export const MERCHANT_FACTION = 900;

/** DFU Guild.cs tables, indexed by rank 0..9. */
export const RANK_REQ_REPUTATION = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
export const RANK_REQ_SKILL_HIGH = [22, 23, 31, 39, 47, 55, 63, 71, 79, 87];
export const RANK_REQ_SKILL_LOW = [4, 5, 9, 13, 17, 21, 25, 29, 33, 37];

export const GUILDS = Object.freeze({
  fighters: {
    id: 'fighters',
    factionId: 41,
    name: 'Fighters Guild',
    skills: ['Archery', 'Axe', 'Blunt Weapon', 'Giantish', 'Long Blade', 'Orcish', 'Short Blade'],
    training: ['Archery', 'Axe', 'Blunt Weapon', 'Hand-to-Hand', 'Long Blade', 'Short Blade', 'Swimming', 'Jumping'],
    // Original titles for this project.
    ranks: ['Recruit', 'Shieldhand', 'Blade', 'Sergeant', 'Banneret', 'Warden', 'Captain', 'Champion', 'Marshal', 'Lord Marshal'],
    trainCost: 40,
  },
  mages: {
    id: 'mages',
    factionId: 40,
    name: 'Mages Guild',
    skills: ['Alteration', 'Destruction', 'Illusion', 'Mysticism', 'Restoration', 'Thaumaturgy'],
    training: ['Alteration', 'Destruction', 'Illusion', 'Mysticism', 'Restoration', 'Thaumaturgy', 'Daedric', 'Dragonish'],
    ranks: ['Novice', 'Reader', 'Scribe', 'Lector', 'Arcanist', 'Savant', 'Magister', 'High Magister', 'Loremaster', 'Arch-Lector'],
    trainCost: 50,
  },
  temple: {
    id: 'temple',
    factionId: 82,
    name: 'Temple',
    skills: ['Restoration', 'Medical', 'Etiquette', 'Blunt Weapon', 'Alteration'],
    training: ['Restoration', 'Medical', 'Etiquette', 'Blunt Weapon'],
    ranks: ['Lay Brother', 'Acolyte', 'Votary', 'Deacon', 'Curate', 'Canon', 'Prior', 'Abbot', 'Prelate', 'Patriarch'],
    trainCost: 35,
  },
});

/**
 * Fallback names/values, used only when the equipment feature's
 * `describeItem` service is not installed (unit tests). Keys are equipment
 * catalogue template keys (server/rpg/inventory.js).
 */
export const ITEM_VALUES = Object.freeze({
  'iron-dagger': { name: 'Iron Dagger', value: 30 },
  'iron-shortsword': { name: 'Iron Shortsword', value: 55 },
  'iron-broadsword': { name: 'Iron Broadsword', value: 80 },
  'iron-longsword': { name: 'Iron Longsword', value: 90 },
  'steel-longsword': { name: 'Steel Longsword', value: 140 },
  'iron-mace': { name: 'Iron Mace', value: 70 },
  'iron-battle-axe': { name: 'Iron Battle Axe', value: 110 },
  'iron-staff': { name: 'Iron Staff', value: 25 },
  'iron-short-bow': { name: 'Iron Short Bow', value: 75 },
  'iron-long-bow': { name: 'Iron Long Bow', value: 120 },
  'arrow': { name: 'Arrow', value: 2 },
  'leather-cuirass': { name: 'Leather Cuirass', value: 100 },
  'leather-boots': { name: 'Leather Boots', value: 50 },
  'leather-gauntlets': { name: 'Leather Gauntlets', value: 50 },
  'leather-helm': { name: 'Leather Helm', value: 80 },
  'chain-cuirass': { name: 'Chain Cuirass', value: 200 },
  'buckler': { name: 'Buckler', value: 10 },
  'round-shield': { name: 'Round Shield', value: 20 },
  'potion-of-healing': { name: 'Potion of Healing', value: 30 },
  'potion-of-stamina': { name: 'Potion of Stamina', value: 25 },
  'potion-of-magicka': { name: 'Potion of Magicka', value: 40 },
  'amber': { name: 'Amber', value: 100 },
  'big-tooth': { name: 'Big Tooth', value: 8 },
});

/** Stock templates per merchant kind: [template, quantity]. Unknown templates are skipped at stock time. */
export const STOCK = Object.freeze({
  general: [['potion-of-healing', 4], ['potion-of-stamina', 4], ['arrow', 40], ['iron-dagger', 2], ['iron-staff', 1],
    ['buckler', 2], ['leather-boots', 1], ['amber', 2],
    // DaggerfallLoot: every classic general store also offers a horse (server/rpg/mount.js).
    ['horse', 1]],
  smith: [['iron-dagger', 4], ['iron-shortsword', 3], ['iron-broadsword', 2], ['iron-longsword', 2], ['steel-longsword', 1],
    ['iron-mace', 2], ['iron-battle-axe', 1], ['leather-cuirass', 2], ['leather-boots', 3], ['leather-gauntlets', 3],
    ['leather-helm', 2], ['chain-cuirass', 1], ['buckler', 2], ['round-shield', 1]],
  alchemist: [['potion-of-healing', 8], ['potion-of-stamina', 6], ['potion-of-magicka', 5], ['big-tooth', 6]],
  bowyer: [['iron-short-bow', 2], ['iron-long-bow', 1], ['arrow', 120], ['iron-dagger', 2]],
  inn: [['potion-of-stamina', 6], ['potion-of-healing', 2]],
});
export const MERCHANT_PURSE = Object.freeze({ general: 800, smith: 2500, alchemist: 1200, bowyer: 1000, inn: 400 });

/**
 * Roles. `sprites` are candidate {archive,record} pairs; one is chosen per NPC
 * deterministically. `services` lists commands the role offers.
 */
export const ROLES = Object.freeze({
  crier: {
    title: 'Town Crier', sprites: [[334, 0], [334, 17]], topics: ['work', 'news', 'directions'],
    services: [], questGiver: true, faction: REGION_FACTION,
  },
  noble: {
    title: 'Court Envoy', sprites: [[334, 19], [334, 20], [334, 18]], topics: ['work', 'news', 'organisation'],
    services: [], questGiver: true, faction: REGION_FACTION,
  },
  merchant: {
    title: 'Provisioner', sprites: [[334, 5], [182, 26]], topics: ['trade', 'news', 'directions'],
    services: [], shop: 'general', faction: MERCHANT_FACTION,
  },
  smith: {
    title: 'Smith', sprites: [[334, 14], [182, 59]], topics: ['trade', 'news', 'directions'],
    services: [], shop: 'smith', faction: MERCHANT_FACTION,
  },
  herbalist: {
    title: 'Herbalist', sprites: [[334, 4], [182, 9]], topics: ['trade', 'news', 'directions'],
    services: [], shop: 'alchemist', faction: MERCHANT_FACTION,
  },
  bowyer: {
    title: 'Bowyer', sprites: [[334, 13], [182, 44]], topics: ['trade', 'news', 'directions'],
    services: [], shop: 'bowyer', faction: MERCHANT_FACTION,
  },
  innkeeper: {
    title: 'Innkeeper', sprites: [[334, 9], [182, 1]], topics: ['trade', 'news', 'rumours', 'directions'],
    services: ['rest'], shop: 'inn', faction: MERCHANT_FACTION,
  },
  fighters: {
    title: 'Guild Steward', sprites: [[334, 10], [334, 2]], topics: ['organisation', 'work', 'news'],
    services: ['join', 'train'], guild: 'fighters', questGiver: true, faction: 41,
  },
  mages: {
    title: 'Guild Magister', sprites: [[334, 1]], topics: ['organisation', 'work', 'news'],
    services: ['join', 'train'], guild: 'mages', questGiver: true, faction: 40,
  },
  priest: {
    title: 'Temple Healer', sprites: [[334, 4], [182, 22]], topics: ['organisation', 'news', 'directions'],
    services: ['join', 'train', 'heal', 'donate'], guild: 'temple', faction: 82,
  },
  guard: {
    title: 'City Guard', sprites: [[334, 15], [334, 16]], topics: ['directions', 'news', 'organisation'],
    services: [], faction: REGION_FACTION,
  },
  townsfolk: {
    title: 'Resident', sprites: [[334, 0], [334, 2], [334, 8], [334, 12], [334, 18]], topics: ['news', 'rumours', 'directions'],
    services: [], faction: REGION_FACTION,
  },
});

/**
 * Standing spots relative to the spawn point (origin, facing -z). Town spawn
 * selection guarantees a clear 1.5 m circle and a clear ±0.5 m lane 12 m
 * ahead, so NPCs stand along that lane, alternating sides, facing the arrival.
 */
export const SLOTS = Object.freeze([
  { x: 0.5, z: -3.0 }, { x: -0.5, z: -4.5 }, { x: 0.5, z: -6.0 }, { x: -0.5, z: -7.5 },
  { x: 0.5, z: -9.0 }, { x: -0.5, z: -10.5 }, { x: 0.5, z: -11.8 },
]);

/** District rosters by keyword in the location's place name. First match wins. */
export const DISTRICTS = Object.freeze([
  { match: /garden/i, label: 'garden quarter', roles: ['crier', 'merchant', 'herbalist', 'fighters', 'mages', 'priest', 'guard'] },
  { match: /market|bazaar|square|cross/i, label: 'market quarter', roles: ['crier', 'merchant', 'smith', 'bowyer', 'innkeeper', 'fighters', 'guard'] },
  { match: /temple|chapel|abbey|shrine/i, label: 'temple quarter', roles: ['crier', 'priest', 'herbalist', 'merchant', 'mages', 'guard', 'townsfolk'] },
  { match: /castle|court|keep|palace|hold/i, label: 'court quarter', roles: ['noble', 'crier', 'guard', 'smith', 'mages', 'fighters', 'guard'] },
  { match: /port|harbo|dock|wharf|bay/i, label: 'harbour quarter', roles: ['crier', 'innkeeper', 'merchant', 'bowyer', 'fighters', 'guard', 'townsfolk'] },
  { match: /farm|grange|field|meadow|orchard|hamlet/i, label: 'farmland', roles: ['crier', 'merchant', 'innkeeper', 'townsfolk', 'guard'] },
]);
export const DEFAULT_DISTRICT = { label: 'town', roles: ['crier', 'merchant', 'smith', 'innkeeper', 'fighters', 'priest', 'guard'] };

// Original name parts.
export const NAME_PARTS = Object.freeze({
  first: ['Aldric', 'Bertil', 'Cadoc', 'Doran', 'Elsbeth', 'Fenna', 'Gaspard', 'Hollis', 'Isolde', 'Jory', 'Kestrel',
    'Lisette', 'Maelor', 'Nell', 'Oswin', 'Perrin', 'Quill', 'Rosalind', 'Sabine', 'Tamsin', 'Ulric', 'Veyla', 'Wendel',
    'Yvaine', 'Corwen', 'Adele', 'Brannoc', 'Mirelle', 'Tobin', 'Gwenna'],
  last: ['Ashby', 'Brightwater', 'Coldmere', 'Dunmore', 'Everard', 'Fairweather', 'Greystock', 'Hallow', 'Ivercourt',
    'Larkspur', 'Marrow', 'Northam', 'Oakhaven', 'Pellard', 'Quenby', 'Redfern', 'Stillwell', 'Thornbury', 'Underhill',
    'Valmont', 'Whitlow', 'Yarrow'],
});

export const TOPIC_LABELS = Object.freeze({
  work: 'Any work?',
  news: 'What news?',
  rumours: 'Heard any rumours?',
  directions: 'Where can I find…',
  inn: 'Where is the nearest inn?',
  organisation: 'Tell me about your order',
  trade: 'Let me see your wares',
});

export const SERVICE_LABELS = Object.freeze({
  join: 'Ask to join', train: 'Train', heal: 'Healing', donate: 'Donate 100 gold', rest: 'Room & board…',
  bank: 'Banking', repair: 'Repairs', cure: 'Cure disease', summon: 'Daedra Summoning', spells: 'Buy spells',
  makeSpells: 'Spell Maker', magicItems: 'Buy magic items', makeItems: 'Item Maker', potions: 'Buy potions',
  makePotions: 'Potion Maker', soulgems: 'Buy soul gems', teleport: 'Guild teleport', identify: 'Identify',
  sellItems: 'Sell magic items', spymaster: 'Spymaster', armor: 'Receive armour', house: 'Receive house',
});

/** Original dialogue. `{place}`, `{district}`, `{name}`, `{player}` are substituted. */
export const LINES = Object.freeze({
  greet: {
    friendly: ['Well met, {player}. What can I do for you?', 'Ah, {player}. Good to see a friendly face in {place}.',
      'Welcome back, {player}. Speak your mind.'],
    neutral: ['Yes? I am {name}. What is it?', 'Good day, traveller. Something you need?',
      'You look new to the {district}. How can I help?'],
    cold: ['I have heard about you. Make it quick.', 'Keep your hands where I can see them. What do you want?'],
    hostile: ['I have nothing to say to you.', 'Begone, before I call the watch.'],
  },
  news: [
    'Wagons from the coast came in late again. Folk say the road past the old watchtower is not safe after dark.',
    'The court has doubled the patrols along the walls. Nobody will say why.',
    'Prices for good iron have gone up since the mines to the north flooded.',
    'There was singing in the tavern until dawn last night. A wedding, or a wake — hard to tell the difference here.',
    'The guilds are hiring. If you can swing a blade or read a scroll, there is coin to be had.',
    'Someone has been leaving fresh flowers at the gate every morning. A pretty mystery, at least.',
  ],
  rumours: [
    'They say a merchant in the next street sells potions watered down by half. I will not say which one.',
    'A cellar on the east side has a door that was bricked up years ago. Lately someone has been knocking from the other side.',
    'One of the guards swears he saw a hooded figure walking on the rooftops.',
    'If you want honest steel, ask the smith. If you want gossip, ask me.',
  ],
  work: {
    giver: 'I may have something for a capable hand. Hear me out.',
    member: 'Members in good standing get first pick of contracts. Here is what is on offer.',
    outsider: 'Our contracts are for members. Join first and we can talk about work.',
    none: 'I have no work for you. Try the crier, or the guild halls.',
  },
  trade: {
    open: 'Take a look. Prices are fair — fairer for friends.',
    refuse: 'I will not trade with the likes of you.',
  },
  organisation: {
    region: 'The court keeps the peace in {place}. Help its people and the court remembers.',
    people: 'We shopkeepers look after our own. Pay your way and you will be welcome.',
    guild: '{faction} welcomes those who prove themselves. Standing comes from deeds, and rank from skill.',
    temple: 'The temple tends the sick and the dying. Gifts to the poor box are remembered.',
  },
  join: {
    welcome: 'Welcome to {faction}, {rank} {player}. Serve well.',
    already: 'You are already one of us, {rank}.',
    badRep: 'Your reputation precedes you. Come back when you have mended it.',
    lowSkill: 'You lack the skills we need. Train {skills} and return.',
    noCharacter: 'Who are you, exactly? Find yourself first, then come to us.',
  },
  promote: 'Your service has been noticed. From today you are {rank}.',
  heal: { done: 'Be still… There. You are whole again.', unneeded: 'You are in good health. Save your coin.' },
  donate: 'Your generosity will be remembered.',
  train: 'A good session. You are sharper than when you came in.',
});
