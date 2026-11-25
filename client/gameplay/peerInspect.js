// Classic Paper Doll Peer Inspector (panel `inspect`, "Traveller").
// Renders another player's authentic 110x184 classic Daggerfall Paper Doll from the local
// viewer's ARENA2 files via buildDoll(), with a stylized canvas silhouette fallback when
// ARENA2 art is not loaded. Displays public identity, visible attire & arms (zero private
// stats), and quick social actions.

import { buildDoll, DOLL_WIDTH, DOLL_HEIGHT, slotAt } from './inventory/paperdoll.js';
import { RACE_FILE_INDEX, identity } from './inventory/images.js';
import { getItemArtSource } from './inventory/icons.js';
import { parsePalette } from '../world/textures.js';

const CANONICAL_RACES = Object.freeze(
  Object.fromEntries(
    Object.keys(RACE_FILE_INDEX).map((name) => [name.toLowerCase().replace(/[\s_-]+/g, ''), name]),
  ),
);

const SLOT_ALIASES = Object.freeze({
  helm: 'head',
  helmet: 'head',
  hat: 'head',
  head: 'head',
  cloak: 'cloak',
  cape: 'cloak',
  chestArmor: 'chestArmor',
  cuirass: 'chestArmor',
  chestClothes: 'chestClothes',
  shirt: 'chestClothes',
  robes: 'chestClothes',
  robe: 'chestClothes',
  tunic: 'chestClothes',
  rightArm: 'rightArm',
  leftArm: 'leftArm',
  gloves: 'gloves',
  gauntlets: 'gloves',
  hands: 'gloves',
  legsArmor: 'legsArmor',
  greaves: 'legsArmor',
  legsClothes: 'legsClothes',
  trousers: 'legsClothes',
  pants: 'legsClothes',
  feet: 'feet',
  boots: 'feet',
  shoes: 'feet',
  rightHand: 'rightHand',
  weapon: 'rightHand',
  leftHand: 'leftHand',
  shield: 'leftHand',
});

const PUBLIC_GEAR_ROWS = Object.freeze([
  { key: 'head', label: 'Helm', slots: ['head'] },
  { key: 'cloak', label: 'Cloak', slots: ['cloak'] },
  { key: 'chest', label: 'Cuirass / Robes', slots: ['chestArmor', 'chestClothes'] },
  { key: 'arms', label: 'Arms', slots: ['rightArm', 'leftArm'] },
  { key: 'gloves', label: 'Hands', slots: ['gloves'] },
  { key: 'legs', label: 'Legs', slots: ['legsArmor', 'legsClothes'] },
  { key: 'feet', label: 'Boots', slots: ['feet'] },
  { key: 'rightHand', label: 'Right Hand', slots: ['rightHand'] },
  { key: 'leftHand', label: 'Left Hand', slots: ['leftHand'] },
]);

const RACE_SKIN_TONES = Object.freeze({
  Breton: ['#e2be9e', '#c79b78'],
  Redguard: ['#8e5a3b', '#6d4128'],
  Nord: ['#edd0b7', '#cfa98c'],
  'Dark Elf': ['#687285', '#4c5464'],
  'High Elf': ['#dec985', '#bba461'],
  'Wood Elf': ['#cfa982', '#ae8760'],
  Khajiit: ['#c79b65', '#9d7242'],
  Argonian: ['#5f8c68', '#42684b'],
});

const MATERIAL_COLORS = Object.freeze({
  iron: ['#7e8591', '#515763'],
  steel: ['#b3becd', '#7a8596'],
  silver: ['#d7e0eb', '#9ba7b8'],
  elven: ['#d9dec9', '#9ea68c'],
  dwarven: ['#c89f54', '#8f6b2e'],
  mithril: ['#74a4d4', '#4874a3'],
  adamantium: ['#5c687a', '#394352'],
  ebony: ['#3b414c', '#1f232b'],
  orcish: ['#6d8a64', '#486041'],
  daedric: ['#9e3238', '#661a20'],
  leather: ['#8a5c3c', '#603d25'],
  chain: ['#96a0ae', '#646e7c'],
});

const DYE_COLORS = Object.freeze({
  blue: ['#3b6eb5', '#24487d'],
  grey: ['#7f8896', '#555d69'],
  red: ['#a93d42', '#732428'],
  brown: ['#7e5539', '#543622'],
  purple: ['#784c94', '#503066'],
  tan: ['#b99b6d', '#876d46'],
  white: ['#d5dce6', '#9aa4b2'],
  aquamarine: ['#43918e', '#2a6260'],
  yellow: ['#c8a846', '#8d7327'],
  green: ['#457d52', '#2b5435'],
});

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="peer-inspect"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./peerInspect.css', import.meta.url).href;
  link.dataset.feature = 'peer-inspect';
  document.head.append(link);
}

function normalizeRace(raw) {
  if (typeof raw !== 'string') return 'Breton';
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return CANONICAL_RACES[key] ?? 'Breton';
}

function normalizeGender(raw) {
  return /^f/i.test(String(raw ?? '')) ? 'Female' : 'Male';
}

function normalizeFaceIndex(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 10 ? n : 0;
}

function canonicalSlot(rawSlot, entry) {
  const s = String(rawSlot ?? '').trim();
  if (s === 'chest') {
    const isArmor = entry?.group === 'armor' || entry?.doll?.set === 'armor' || Boolean(entry?.material && !entry?.dye);
    return isArmor ? 'chestArmor' : 'chestClothes';
  }
  if (s === 'legs') {
    const isArmor = entry?.group === 'armor' || entry?.doll?.set === 'armor' || Boolean(entry?.material && !entry?.dye);
    return isArmor ? 'legsArmor' : 'legsClothes';
  }
  return SLOT_ALIASES[s] ?? null;
}

function sanitizeDollSpec(doll, fallbackDye) {
  if (!doll || typeof doll !== 'object') return null;
  const out = {};
  if (typeof doll.set === 'string') out.set = doll.set;
  if (Number.isInteger(doll.archive)) out.archive = doll.archive;
  if (Number.isInteger(doll.record)) out.record = doll.record;
  if (Number.isInteger(doll.baseRecord)) out.baseRecord = doll.baseRecord;
  if (Array.isArray(doll.variants)) out.variants = doll.variants.filter((v) => Number.isInteger(v));
  else if (Number.isInteger(doll.variants)) out.variants = doll.variants;
  if (Number.isInteger(doll.male)) out.male = doll.male;
  if (Number.isInteger(doll.female)) out.female = doll.female;
  if (Number.isInteger(doll.maleVariants)) out.maleVariants = doll.maleVariants;
  if (Number.isInteger(doll.femaleVariants)) out.femaleVariants = doll.femaleVariants;
  if (doll.cloak) out.cloak = true;
  if (Number.isFinite(doll.drawOrder)) out.drawOrder = Number(doll.drawOrder);
  const dye = typeof doll.dye === 'string' && doll.dye ? doll.dye : fallbackDye;
  if (typeof dye === 'string' && dye) out.dye = dye.toLowerCase();
  return out;
}

function normalizePublicItem(slot, raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const name = raw.trim();
    if (!name) return null;
    return { id: `peer-${slot}`, slot, equipped: slot, name };
  }
  if (typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim()
    : typeof raw.template === 'string' && raw.template.trim()
      ? raw.template.replace(/[-_]+/g, ' ')
      : null;
  if (!name && !raw.doll) return null;
  const material = typeof raw.material === 'string' && raw.material.trim() ? raw.material.trim() : null;
  const dye = typeof raw.dye === 'string' && raw.dye.trim() ? raw.dye.trim() : null;
  const fallbackDye = dye ?? (material ? material.toLowerCase() : null);
  const item = {
    id: raw.id != null ? String(raw.id) : `peer-${slot}`,
    slot,
    equipped: slot,
    name: name ?? slot,
  };
  if (typeof raw.template === 'string' && raw.template) item.template = raw.template;
  if (typeof raw.group === 'string' && raw.group) item.group = raw.group;
  if (material) item.material = material;
  if (dye) item.dye = dye;
  if (Number.isInteger(raw.variant)) item.variant = raw.variant;
  if (typeof raw.hands === 'string' && raw.hands) item.hands = raw.hands;
  const doll = sanitizeDollSpec(raw.doll, fallbackDye);
  if (doll) item.doll = doll;
  return item;
}

/**
 * Convert a public peer object into the minimal synthetic `rpg` shape accepted by
 * `buildDoll(art, palette, rpg)` and `dollLayers(rpg)`.
 * Strips all private character/item stats.
 */
export function peerToDollRpg(peer) {
  const src = peer && typeof peer === 'object' ? peer : {};
  const character = {
    race: normalizeRace(src.race ?? src.character?.race),
    gender: normalizeGender(src.gender ?? src.sex ?? src.character?.gender ?? src.character?.sex),
    faceIndex: normalizeFaceIndex(src.faceIndex ?? src.character?.faceIndex),
    className: typeof (src.className ?? src.character?.className) === 'string' && (src.className ?? src.character?.className).trim()
      ? (src.className ?? src.character?.className).trim()
      : 'Traveller',
  };

  const equipment = {};
  const inventory = [];
  const addEntry = (rawSlot, rawItem) => {
    const slot = canonicalSlot(rawSlot, rawItem);
    if (!slot || equipment[slot]) return;
    const item = normalizePublicItem(slot, rawItem);
    if (!item) return;
    equipment[slot] = item.id;
    inventory.push(item);
  };

  if (Array.isArray(src.worn)) {
    for (const entry of src.worn) {
      if (entry && typeof entry === 'object') addEntry(entry.slot ?? entry.equipped, entry);
    }
  } else if (src.worn && typeof src.worn === 'object') {
    for (const [slot, entry] of Object.entries(src.worn)) {
      addEntry(slot, entry);
    }
  }

  if (!equipment.rightHand && src.weapon) {
    addEntry('rightHand', src.weapon);
  }

  return { character, equipment, inventory };
}

function pickPaletteForItem(item, defaultPair) {
  if (!item) return defaultPair;
  const dyeKey = String(item.dye ?? item.doll?.dye ?? '').toLowerCase();
  if (Object.hasOwn(DYE_COLORS, dyeKey)) return DYE_COLORS[dyeKey];
  const matKey = String(item.material ?? item.doll?.dye ?? '').toLowerCase();
  if (Object.hasOwn(MATERIAL_COLORS, matKey)) return MATERIAL_COLORS[matKey];
  const name = String(item.name ?? '').toLowerCase();
  for (const k of Object.keys(MATERIAL_COLORS)) if (name.includes(k)) return MATERIAL_COLORS[k];
  for (const k of Object.keys(DYE_COLORS)) if (name.includes(k)) return DYE_COLORS[k];
  return defaultPair;
}

function drawFallbackDoll(ctx, peer, rpg) {
  const W = DOLL_WIDTH;
  const H = DOLL_HEIGHT;
  const bySlot = new Map();
  for (const [slot, id] of Object.entries(rpg.equipment)) {
    const it = rpg.inventory.find((x) => x.id === id);
    if (it) bySlot.set(slot, it);
  }
  const idInfo = identity(rpg.character);
  const female = idInfo.female;
  const beast = Boolean(peer?.beastForm || peer?.werewolf || peer?.wereboar);
  const [skinHi, skinLo] = beast ? ['#6d6157', '#453c35'] : (RACE_SKIN_TONES[idInfo.race] ?? RACE_SKIN_TONES.Breton);

  const rect = (x, y, w, h, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };

  // Classic slate archway backdrop
  rect(0, 0, W, H, '#0f1520');
  rect(2, 2, W - 4, H - 4, '#151e2c');
  rect(6, 6, W - 12, H - 12, '#1b2638');
  rect(6, H - 24, W - 12, 18, '#121a26');

  // Cloak behind figure
  const cloak = bySlot.get('cloak');
  if (cloak) {
    const [cHi, cLo] = pickPaletteForItem(cloak, DYE_COLORS.blue);
    rect(26, 48, 58, 108, cLo);
    rect(30, 50, 50, 102, cHi);
  }

  // Body proportions
  const cx = 55;
  const shoulderW = female ? 34 : 40;
  const waistW = female ? 22 : 28;
  const hipW = female ? 28 : 26;

  // Head & neck
  rect(cx - 5, 42, 10, 8, skinLo);
  rect(cx - 10, 18, 20, 25, skinHi);
  rect(cx - 9, 36, 18, 7, skinLo);
  // Subtle facial features
  rect(cx - 5, 28, 3, 2, '#1a1e26');
  rect(cx + 2, 28, 3, 2, '#1a1e26');
  rect(cx - 2, 35, 4, 2, skinLo);

  // Torso (base skin)
  rect(cx - shoulderW / 2, 50, shoulderW, 24, skinHi);
  rect(cx - waistW / 2, 74, waistW, 18, skinLo);
  // Arms
  rect(cx - shoulderW / 2 - 7, 52, 8, 44, skinHi);
  rect(cx + shoulderW / 2 - 1, 52, 8, 44, skinHi);
  // Legs
  rect(cx - hipW / 2, 92, hipW, 14, skinLo);
  rect(cx - 12, 106, 10, 54, skinHi);
  rect(cx + 2, 106, 10, 54, skinHi);
  // Feet
  rect(cx - 14, 158, 12, 10, skinLo);
  rect(cx + 2, 158, 12, 10, skinLo);

  // Lower attire (trousers / greaves)
  const legsClothes = bySlot.get('legsClothes');
  const legsArmor = bySlot.get('legsArmor');
  const [legHi, legLo] = pickPaletteForItem(legsArmor ?? legsClothes, DYE_COLORS.brown);
  rect(cx - hipW / 2, 92, hipW, 16, legLo);
  rect(cx - 13, 106, 11, 52, legHi);
  rect(cx + 2, 106, 11, 52, legHi);

  // Upper attire (shirt/robes + cuirass)
  const chestClothes = bySlot.get('chestClothes');
  const chestArmor = bySlot.get('chestArmor');
  const [chHi, chLo] = pickPaletteForItem(chestArmor ?? chestClothes, ['#5a6476', '#3d4554']);
  const isRobe = /robe/i.test(String(chestClothes?.name ?? ''));
  rect(cx - shoulderW / 2, 50, shoulderW, 42, chHi);
  rect(cx - waistW / 2, 82, waistW, 12, chLo);
  if (isRobe && !chestArmor) {
    rect(cx - 16, 92, 32, 66, chHi);
    rect(cx - 2, 92, 4, 66, chLo);
  }
  if (chestArmor) {
    // Bevel highlight on cuirass
    rect(cx - shoulderW / 2 + 2, 52, shoulderW - 4, 6, chLo);
    rect(cx - 2, 52, 4, 38, chLo);
  }

  // Pauldrons (rightArm / leftArm)
  const rArm = bySlot.get('rightArm');
  const lArm = bySlot.get('leftArm');
  if (rArm) {
    const [aHi, aLo] = pickPaletteForItem(rArm, MATERIAL_COLORS.steel);
    rect(cx - shoulderW / 2 - 8, 49, 12, 16, aHi);
    rect(cx - shoulderW / 2 - 8, 62, 12, 4, aLo);
  }
  if (lArm) {
    const [aHi, aLo] = pickPaletteForItem(lArm, MATERIAL_COLORS.steel);
    rect(cx + shoulderW / 2 - 4, 49, 12, 16, aHi);
    rect(cx + shoulderW / 2 - 4, 62, 12, 4, aLo);
  }

  // Gloves / gauntlets
  const gloves = bySlot.get('gloves');
  if (gloves) {
    const [gHi] = pickPaletteForItem(gloves, MATERIAL_COLORS.leather);
    rect(cx - shoulderW / 2 - 7, 86, 9, 12, gHi);
    rect(cx + shoulderW / 2 - 2, 86, 9, 12, gHi);
  }

  // Boots / shoes
  const feet = bySlot.get('feet');
  if (feet) {
    const [fHi, fLo] = pickPaletteForItem(feet, MATERIAL_COLORS.leather);
    rect(cx - 14, 146, 12, 22, fHi);
    rect(cx + 2, 146, 12, 22, fHi);
    rect(cx - 15, 164, 13, 5, fLo);
    rect(cx + 2, 164, 13, 5, fLo);
  }

  // Helm / hood
  const head = bySlot.get('head');
  if (head) {
    const [hHi, hLo] = pickPaletteForItem(head, MATERIAL_COLORS.steel);
    rect(cx - 12, 14, 24, 15, hHi);
    rect(cx - 12, 26, 24, 4, hLo);
    rect(cx - 12, 26, 4, 14, hLo);
    rect(cx + 8, 26, 4, 14, hLo);
  }

  // Right-hand weapon (viewer's left side of doll, classic Daggerfall orientation)
  const rightHand = bySlot.get('rightHand');
  if (rightHand) {
    const [wHi, wLo] = pickPaletteForItem(rightHand, MATERIAL_COLORS.steel);
    const wName = String(rightHand.name ?? '').toLowerCase();
    const wx = cx - shoulderW / 2 - 5;
    if (wName.includes('bow')) {
      rect(wx - 4, 44, 3, 56, '#8a5c3c');
      rect(wx - 1, 46, 1, 52, '#d5dce6');
    } else if (wName.includes('staff')) {
      rect(wx - 2, 28, 4, 124, '#8a5c3c');
      rect(wx - 4, 24, 8, 8, wHi);
    } else if (wName.includes('axe') || wName.includes('hammer') || wName.includes('mace') || wName.includes('flail')) {
      rect(wx - 1, 56, 3, 44, '#6d4a2f');
      rect(wx - 8, 52, 14, 12, wHi);
      rect(wx - 8, 62, 14, 3, wLo);
    } else {
      // Sword / dagger / blade
      const bladeLen = wName.includes('dagger') || wName.includes('tanto') ? 24 : 46;
      rect(wx - 1, 90 - bladeLen, 4, bladeLen, wHi);
      rect(wx + 2, 90 - bladeLen, 1, bladeLen, wLo);
      rect(wx - 5, 88, 12, 3, '#c89f54');
      rect(wx, 91, 3, 9, '#543622');
    }
  }

  // Left-hand shield or offhand weapon (viewer's right side of doll)
  const leftHand = bySlot.get('leftHand');
  if (leftHand) {
    const [sHi, sLo] = pickPaletteForItem(leftHand, MATERIAL_COLORS.steel);
    const sx = cx + shoulderW / 2 - 2;
    const isShield = /shield|buckler|kite|tower|round/i.test(String(leftHand.name ?? '')) || leftHand.group === 'shield';
    if (isShield) {
      rect(sx, 66, 20, 32, sLo);
      rect(sx + 2, 68, 16, 26, sHi);
      rect(sx + 8, 72, 4, 18, sLo);
    } else {
      rect(sx + 3, 56, 4, 36, sHi);
      rect(sx, 88, 10, 3, '#c89f54');
    }
  }

  // Subtle classic gold/steel frame border
  ctx.strokeStyle = '#485262';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

/**
 * Paint a peer's classic 110x184 Daggerfall paper doll onto `canvas` using local ARENA2
 * art + palette when available, or a stylized classic silhouette fallback otherwise.
 */
export async function renderPeerPaperDoll(canvas, peer, { art = null, palette = null, buildDollFn = null } = {}) {
  const rpg = peerToDollRpg(peer);
  if (canvas) {
    canvas.width = DOLL_WIDTH;
    canvas.height = DOLL_HEIGHT;
  }
  const ctx = canvas?.getContext?.('2d') ?? null;
  if (ctx) ctx.imageSmoothingEnabled = false;

  const builder = typeof buildDollFn === 'function' ? buildDollFn : buildDoll;
  const canTryClassic = typeof buildDollFn === 'function' || Boolean(art && palette);

  if (canTryClassic) {
    try {
      const doll = await builder(art, palette, rpg);
      if (doll?.rgba && doll.rgba.length === DOLL_WIDTH * DOLL_HEIGHT * 4) {
        if (ctx) {
          ctx.clearRect(0, 0, DOLL_WIDTH, DOLL_HEIGHT);
          if (typeof ctx.createImageData === 'function') {
            const imgData = ctx.createImageData(DOLL_WIDTH, DOLL_HEIGHT);
            imgData.data.set(doll.rgba);
            ctx.putImageData(imgData, 0, 0);
          } else if (typeof ImageData !== 'undefined') {
            ctx.putImageData(new ImageData(new Uint8ClampedArray(doll.rgba), DOLL_WIDTH, DOLL_HEIGHT), 0, 0);
          }
        }
        if (canvas?.dataset) {
          canvas.dataset.dollMode = 'classic';
          canvas.dataset.layers = Array.isArray(doll.drawn) ? doll.drawn.join(' ') : '';
        }
        return { mode: 'classic', doll, width: DOLL_WIDTH, height: DOLL_HEIGHT };
      }
    } catch {
      // Fall through to stylized silhouette fallback.
    }
  }

  if (ctx) {
    ctx.clearRect(0, 0, DOLL_WIDTH, DOLL_HEIGHT);
    drawFallbackDoll(ctx, peer, rpg);
  }
  if (canvas?.dataset) {
    canvas.dataset.dollMode = 'fallback';
    canvas.dataset.layers = '';
  }
  return { mode: 'fallback', doll: null, width: DOLL_WIDTH, height: DOLL_HEIGHT };
}

function visiblePeers(api) {
  const selfId = api?.selfId ?? api?.state?.selfId;
  const list = Array.isArray(api?.state?.peers) ? api.state.peers : [];
  return list.filter((p) => p && p.id != null && (selfId == null || String(p.id) !== String(selfId)));
}

function findPeer(api, peerIdOrName) {
  if (peerIdOrName && typeof peerIdOrName === 'object') {
    const id = peerIdOrName.id;
    if (id != null) {
      const live = visiblePeers(api).find((p) => String(p.id) === String(id));
      if (live) return live;
    }
    return peerIdOrName;
  }
  if (peerIdOrName == null) return null;
  const needle = String(peerIdOrName).trim();
  if (!needle) return null;
  const peers = visiblePeers(api);
  const byId = peers.find((p) => String(p.id) === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  return peers.find((p) => String(p.name ?? '').toLowerCase() === lower) ?? null;
}

function formatSlotValue(rpg, slots) {
  const items = [];
  for (const s of slots) {
    const id = rpg.equipment[s];
    if (!id) continue;
    const it = rpg.inventory.find((x) => x.id === id);
    if (it) items.push(it);
  }
  return items;
}

function peerBadges(peer) {
  const badges = [];
  if (peer.mounted || peer.mount) badges.push({ label: 'Mounted', kind: 'info' });
  if (peer.beastForm || peer.werewolf || peer.wereboar) {
    badges.push({ label: peer.wereboar ? 'Beast Form (Wereboar)' : 'Beast Form', kind: 'warn' });
  }
  if (peer.readied) badges.push({ label: 'Readied', kind: 'accent' });
  if (peer.defeated || peer.dead) badges.push({ label: 'Defeated', kind: 'danger' });
  if (peer.across) badges.push({ label: 'Across Boundary', kind: 'muted' });
  return badges;
}

function formatWhisperPrefix(name) {
  const clean = String(name ?? '').trim();
  if (!clean) return '/w ';
  return /\s/.test(clean) ? `/w "${clean}" ` : `/w ${clean} `;
}

export function install(api) {
  loadStyles();

  let icons = null;
  try {
    icons = getItemArtSource(api);
  } catch {
    icons = null;
  }

  let cachedPalette = null;
  let cachedGen = -1;
  async function resolveArtAndPalette() {
    if (!icons?.art || !icons.available) return { art: null, palette: null };
    if (cachedGen !== icons.generation || !cachedPalette) {
      cachedGen = icons.generation;
      const bytes = await icons.art.bytes('ART_PAL.COL').catch(() => null);
      cachedPalette = bytes ? parsePalette(bytes, 'ART_PAL.COL') : null;
    }
    return { art: icons.art, palette: cachedPalette };
  }

  const ui = {
    selectedId: null,
    selectedPeer: null,
    targetId: null,
    highlightedSlot: null,
    status: '',
    renderSeq: 0,
  };
  let container = null;

  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === 'inspect') api.refreshPanel?.('inspect');
  };

  const say = (text) => {
    ui.status = text;
    const live = container?.querySelector('.pi-live');
    if (live) live.textContent = text;
  };

  const safeAct = (verb, args, feedback) => {
    try {
      const r = api.act?.(verb, args);
      if (feedback) say(feedback);
      return r;
    } catch (e) {
      const msg = e?.message || String(e);
      say(msg);
      api.message?.(msg, { kind: 'error' });
      return false;
    }
  };

  function resolveCurrentPeer() {
    if (ui.selectedId != null) {
      const live = findPeer(api, ui.selectedId);
      if (live) {
        ui.selectedPeer = live;
        return live;
      }
      if (ui.selectedPeer && String(ui.selectedPeer.id) === String(ui.selectedId)) return ui.selectedPeer;
    }
    if (ui.targetId != null) {
      const targeted = findPeer(api, ui.targetId);
      if (targeted) return targeted;
    }
    return null;
  }

  function inspectPeer(peerIdOrName) {
    const found = findPeer(api, peerIdOrName);
    if (found) {
      ui.selectedId = found.id != null ? String(found.id) : null;
      ui.selectedPeer = found;
      ui.highlightedSlot = null;
      ui.status = '';
    } else if (peerIdOrName == null) {
      ui.selectedId = null;
      ui.selectedPeer = null;
    }
    api.openPanel?.('inspect', found ? { peerId: ui.selectedId } : undefined);
    rerender();
    return found;
  }

  api.inspectPeer = inspectPeer;

  api.on?.('state', () => {
    if (ui.selectedId != null) {
      const live = findPeer(api, ui.selectedId);
      if (live) ui.selectedPeer = live;
    }
    if (api.panel === 'inspect' || container?.isConnected) rerender();
  });

  api.on?.('target', (ev) => {
    const id = typeof ev === 'object' ? (ev?.id ?? ev?.targetId ?? null) : ev;
    ui.targetId = id != null ? String(id) : null;
    if (api.panel === 'inspect' && ui.selectedId == null) rerender();
  });

  api.on?.('assets', () => {
    cachedPalette = null;
    if (api.panel === 'inspect' || container?.isConnected) rerender();
  });

  api.on?.('panelDetail', (d) => {
    if (d?.id === 'inspect' && d.detail?.peerId != null) {
      const found = findPeer(api, d.detail.peerId);
      if (found) {
        ui.selectedId = String(found.id);
        ui.selectedPeer = found;
        ui.highlightedSlot = null;
        rerender();
      }
    }
  });

  function renderSelector(peers, activePeer) {
    if (!peers.length) {
      return el('div', { class: 'pi-selector pi-selector-empty' },
        el('p', { class: 'pi-empty', text: 'No other travellers are visible in this place right now.' }));
    }
    return el('div', { class: 'pi-selector', role: 'region', 'aria-label': 'Travellers nearby' },
      el('span', { class: 'pi-label', text: 'Travellers Here' }),
      el('div', { class: 'pi-peer-list', role: 'list' },
        peers.map((p) => {
          const isSelected = activePeer && String(activePeer.id) === String(p.id);
          return el('button', {
            type: 'button',
            class: `pi-peer-btn${isSelected ? ' is-active' : ''}`,
            'aria-pressed': isSelected ? 'true' : 'false',
            'data-peer-id': String(p.id),
            onclick: () => {
              ui.selectedId = String(p.id);
              ui.selectedPeer = p;
              ui.highlightedSlot = null;
              ui.status = '';
              rerender();
            },
          },
          el('span', { class: 'pi-peer-btn-name', text: p.name ?? `Traveller ${p.id}` }),
          p.orderTag ? el('span', { class: 'pi-tag', text: `[${p.orderTag}]` }) : null);
        }),
      ));
  }

  function render(root) {
    container = root;
    root.classList.add('pi-root');
    const peers = visiblePeers(api);
    const peer = resolveCurrentPeer();
    const seq = ++ui.renderSeq;

    const nodes = [
      el('p', { class: 'pi-live', role: 'status', 'aria-live': 'polite', text: ui.status }),
      renderSelector(peers, peer),
    ];

    if (!peer) {
      if (peers.length) {
        nodes.push(el('p', { class: 'pi-note', text: 'Select a traveller above to inspect their classic figure and visible gear.' }));
      }
      root.replaceChildren(...nodes);
      return;
    }

    const rpg = peerToDollRpg(peer);
    const ch = rpg.character;
    const displayName = peer.name ?? `Traveller ${peer.id ?? ''}`.trim();
    const orderTag = peer.orderTag ?? peer.order?.tag ?? null;
    const guildTitle = peer.guildTitle ?? peer.guild?.title ?? null;
    const level = Number.isFinite(Number(peer.level)) && Number(peer.level) > 0 ? Math.floor(Number(peer.level)) : null;

    // Left column: 110x184 classic paper doll canvas scaled 2x crisp pixelated
    const canvas = el('canvas', {
      class: 'pi-doll-canvas',
      width: String(DOLL_WIDTH),
      height: String(DOLL_HEIGHT),
      role: 'img',
      'aria-label': `Classic figure of ${displayName}`,
    });
    const caption = el('figcaption', { class: 'pi-doll-cap', text: 'Rendering figure…' });
    const dollCol = el('figure', { class: 'pi-doll-col' },
      el('div', { class: 'pi-doll-frame' }, canvas),
      caption);

    // Right column: Identity header + Visible Attire & Arms + Quick Actions
    const identityLine = [
      level != null ? `Level ${level}` : null,
      ch.race,
      ch.gender,
      ch.className,
    ].filter(Boolean).join(' · ');

    const badges = peerBadges(peer);
    const header = el('header', { class: 'pi-header' },
      el('div', { class: 'pi-title-row' },
        el('h3', { class: 'pi-name', text: displayName }),
        orderTag ? el('span', { class: 'pi-order-tag', text: `[${orderTag}]` }) : null),
      el('p', { class: 'pi-identity', text: identityLine }),
      guildTitle ? el('p', { class: 'pi-guild-title', text: guildTitle }) : null,
      badges.length
        ? el('div', { class: 'pi-badges' },
          badges.map((b) => el('span', { class: `pi-badge pi-badge-${b.kind}`, text: b.label })))
        : null);

    // Visible Attire & Arms list (public appearance only — zero private stats)
    const gearItems = PUBLIC_GEAR_ROWS.map((row) => {
      const equipped = formatSlotValue(rpg, row.slots);
      const isHit = ui.highlightedSlot && row.slots.includes(ui.highlightedSlot);
      if (!equipped.length) {
        return el('li', { class: 'pi-gear-row pi-gear-empty', 'data-slot': row.key },
          el('span', { class: 'pi-gear-slot', text: row.label }),
          el('span', { class: 'pi-gear-val pi-muted', text: '—' }));
      }
      return el('li', { class: `pi-gear-row${isHit ? ' is-highlighted' : ''}`, 'data-slot': row.key },
        el('span', { class: 'pi-gear-slot', text: row.label }),
        el('span', { class: 'pi-gear-val' },
          equipped.map((it, idx) => {
            const tags = [it.material, it.dye].filter(Boolean);
            return el('span', { class: 'pi-gear-item' },
              idx > 0 ? ' / ' : '',
              el('span', { class: 'pi-gear-name', text: it.name }),
              tags.length ? el('span', { class: 'pi-gear-meta', text: ` (${tags.join(', ')})` }) : null);
          })));
    });

    const gearSection = el('section', { class: 'pi-gear', 'aria-label': 'Visible Attire & Arms' },
      el('h4', { class: 'pi-section-h', text: 'Visible Attire & Arms' }),
      el('ul', { class: 'pi-gear-list' }, gearItems));

    // Quick Actions
    const nearby = !peer.across;
    const actions = el('div', { class: 'pi-actions', role: 'group', 'aria-label': 'Traveller actions' },
      el('button', {
        type: 'button',
        class: 'pi-btn pi-btn-primary',
        disabled: nearby ? null : true,
        title: nearby ? `Invite ${displayName} to your party` : 'Must be in the same area to invite',
        'data-action': 'invite',
        onclick: () => safeAct('party.invite', { targetId: peer.id }, `Party invitation sent to ${displayName}.`),
      }, 'Invite to Party'),
      el('button', {
        type: 'button',
        class: 'pi-btn',
        disabled: nearby ? null : true,
        title: nearby ? `Request trade with ${displayName}` : 'Must be in the same area to trade',
        'data-action': 'trade',
        onclick: () => safeAct('trade.request', { targetId: peer.id }, `Trade request sent to ${displayName}.`),
      }, 'Trade'),
      el('button', {
        type: 'button',
        class: 'pi-btn',
        'data-action': 'whisper',
        onclick: () => {
          const prefix = formatWhisperPrefix(displayName);
          const input = typeof document !== 'undefined' ? document.getElementById('chat-input') : null;
          if (input) {
            input.value = prefix;
            api.closePanel?.();
            input.focus?.();
          } else {
            say(`Whisper ready: ${prefix}`);
          }
        },
      }, 'Whisper'),
      el('button', {
        type: 'button',
        class: 'pi-btn',
        'data-action': 'chronicles',
        onclick: () => {
          const hasHiscores = typeof api.hasPanel === 'function'
            ? api.hasPanel('hiscores')
            : (api.panels?.has?.('hiscores') ?? true);
          if (!hasHiscores) {
            say('Chronicles panel is not installed.');
            return;
          }
          api.openPanel?.('hiscores', { player: displayName, peerId: peer.id });
        },
      }, 'View Chronicles'));

    const infoCol = el('div', { class: 'pi-info-col' }, header, gearSection, actions);
    const layout = el('div', { class: 'pi-layout' }, dollCol, infoCol);

    nodes.push(layout);
    root.replaceChildren(...nodes);

    // Async render of classic ARENA2 paper doll (or fallback silhouette)
    resolveArtAndPalette().then(({ art, palette }) => {
      if (seq !== ui.renderSeq) return null;
      return renderPeerPaperDoll(canvas, peer, { art, palette });
    }).then((res) => {
      if (!res || seq !== ui.renderSeq) return;
      caption.textContent = res.mode === 'classic'
        ? 'Classic ARENA2 Figure'
        : 'Stylized Figure (load ARENA2 for classic art)';
      if (res.mode === 'classic' && res.doll) {
        canvas.addEventListener('click', (e) => {
          const rect = canvas.getBoundingClientRect?.();
          if (!rect || !rect.width || !rect.height) return;
          const slot = slotAt(res.doll, ((e.clientX - rect.left) / rect.width) * DOLL_WIDTH, ((e.clientY - rect.top) / rect.height) * DOLL_HEIGHT);
          if (slot) {
            ui.highlightedSlot = slot;
            rerender();
          }
        });
      }
    }).catch(() => {});
  }

  api.registerPanel?.('inspect', 'Traveller', render);

  return { inspectPeer, render };
}
