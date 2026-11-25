// Classic quest text (QRC) reader.
//
// Layout, read from the operator's own ARENA2/*.QRC files:
//   u16 indexBytes                       size of the index that follows
//   { u16 messageId, u32 offset } * n     the last entry has id 0xFFFF and offset = file end
//   record text                          bytes between consecutive offsets
// Inside a record: 0xFD and 0xFC end a line (centred / left aligned), 0xFF separates
// alternative variants (one is picked when shown), 0xFE ends the record. Other bytes are
// Latin-1 text. No quest text is bundled with this project; callers pass bytes read from
// the operator's files.

export const QRC_END = 0xffff;

/** @returns {{id:number, offset:number}[]} */
export function readQrcIndex(buf) {
  if (!buf || buf.length < 8) throw new Error('QRC file is too short');
  const indexBytes = buf.readUInt16LE(0);
  if (indexBytes < 6 || indexBytes % 6 !== 0 || 2 + indexBytes > buf.length) throw new Error('QRC index is malformed');
  const out = [];
  for (let i = 2; i < 2 + indexBytes; i += 6) out.push({ id: buf.readUInt16LE(i), offset: buf.readUInt32LE(i + 2) });
  const last = out[out.length - 1];
  if (last.id !== QRC_END || last.offset !== buf.length) throw new Error('QRC index does not end at the file end');
  for (let i = 1; i < out.length; i++) {
    if (out[i].offset < out[i - 1].offset || out[i].offset > buf.length) throw new Error('QRC record offsets are out of order');
  }
  return out;
}

function decodeRecord(bytes) {
  const variants = [];
  let lines = [];
  let cur = '';
  const endLine = () => {
    lines.push(cur.trim());
    cur = '';
  };
  const endVariant = () => {
    if (cur.trim()) endLine();
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    if (lines.length) variants.push(lines.join('\n'));
    lines = [];
    cur = '';
  };
  for (const b of bytes) {
    if (b === 0xfe) break;
    if (b === 0xfd || b === 0xfc) endLine();
    else if (b === 0xff) endVariant();
    else if (b >= 0x20 || b === 0x09) cur += String.fromCharCode(b === 0x09 ? 0x20 : b);
    // other control bytes carry layout hints that do not apply to an HTML panel
  }
  endVariant();
  return variants;
}

/**
 * Parses a classic QRC buffer. Returns Map id -> {id, variants:string[]}. Placeholder records
 * ("Error: Quest ... tried to display text") and empty records are left out.
 */
export function readQrc(buf) {
  const index = readQrcIndex(buf);
  const messages = new Map();
  for (let i = 0; i < index.length - 1; i++) {
    const { id, offset } = index[i];
    const variants = decodeRecord(buf.subarray(offset, index[i + 1].offset));
    if (!variants.length || /^Error: Quest \S+ tried to display text/.test(variants[0])) continue;
    if (!messages.has(id)) messages.set(id, { id, variants });
  }
  return messages;
}
