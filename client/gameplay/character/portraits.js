// Classic character head portraits read from the player's own ARENA2 files.
//
// File and record mapping follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop):
//   Game/Entities/RaceTemplate.cs   PaperDollHeadsMale   = "FACE0{race}I0.CIF"
//                                   PaperDollHeadsFemale = "FACE1{race}I0.CIF"
//                                   race order Breton 0, Redguard 1, Nord 2, Dark Elf 3,
//                                   High Elf 4, Wood Elf 5, Khajiit 6, Argonian 7
//   Game/UserInterface/FacePicker.cs  ten faces per file, record = face index 0-9, frame 0,
//                                   alpha index 0 (ImageReader.GetImageData(..., hasAlpha: true))
//   API/CifRciFile.cs               CIF palette is always ART_PAL.COL
// The CIF reader and file names are shared with the inventory paper doll
// (../inventory/images.js, adapted from .ref/dfjs-research-03, MIT, (c) 2026 Lattymoy),
// so the face id shown here is the same head the paper doll draws.
//
// No game art ships with the project; everything here decodes bytes the player supplied.

import { dollFiles, parseCif, RACE_FILE_INDEX } from '../inventory/images.js';
import { parsePalette } from '../../world/textures.js';

export const FACE_COUNT = 10;
export const PALETTE_FILE = 'ART_PAL.COL';

/**
 * Shared portrait frame in paper-doll screen coordinates. Each FACE record carries its own
 * offset on the 320x200 inventory screen; placing every record by that offset inside one frame
 * keeps heads aligned the way the paper doll shows them. The frame is the union of all 160
 * player head records (x 237-275, y 4-59) with a one-pixel margin.
 */
export const FACE_FRAME = Object.freeze({ x: 236, y: 4, width: 40, height: 56 });

/** { file, record } for a race/gender/face choice, or null for an unknown race or face. */
export function faceSource({ race, gender, faceIndex = 0 } = {}) {
  if (!Object.hasOwn(RACE_FILE_INDEX, race)) return null;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= FACE_COUNT) return null;
  const f = dollFiles({ race, gender, faceIndex });
  return { file: f.heads, record: f.faceIndex };
}

/** Every file a full set of player portraits needs. */
export function requiredFiles() {
  const out = [PALETTE_FILE];
  for (const s of [0, 1]) for (let r = 0; r < 8; r++) out.push(`FACE${s}${r}I0.CIF`);
  return out;
}

export { parsePalette };

/**
 * Decode one face record into RGBA pixels placed in FACE_FRAME (index 0 transparent).
 * @param {Uint8Array} cifBytes FACE??I0.CIF contents
 * @param {number} record face index
 * @param {Uint8Array} palette 768-byte RGB palette (parsePalette of ART_PAL.COL)
 * @returns {{width:number,height:number,rgba:Uint8ClampedArray,source:{width:number,height:number,offsetX:number,offsetY:number}}}
 */
export function decodeFace(cifBytes, record, palette) {
  const img = parseCif(cifBytes, record);
  const { width: W, height: H } = FACE_FRAME;
  const rgba = new Uint8ClampedArray(W * H * 4);
  // Records outside the expected area (modded files) are centred instead of clipped away.
  let ox = img.offsetX - FACE_FRAME.x;
  let oy = img.offsetY - FACE_FRAME.y;
  if (ox < 0 || ox + img.width > W) ox = Math.floor((W - img.width) / 2);
  if (oy < 0 || oy + img.height > H) oy = Math.floor((H - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= W) continue;
      const c = img.data[y * img.width + x];
      if (c === 0) continue;
      const o = (ty * W + tx) * 4;
      rgba[o] = palette[c * 3];
      rgba[o + 1] = palette[c * 3 + 1];
      rgba[o + 2] = palette[c * 3 + 2];
      rgba[o + 3] = 255;
    }
  }
  return { width: W, height: H, rgba, source: { width: img.width, height: img.height, offsetX: img.offsetX, offsetY: img.offsetY } };
}
