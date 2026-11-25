// Classic books from the operator's ARENA2/BOOKS/BOKnnnnn.TXT files.
//
// Header layout and price rule follow Daggerfall Unity's BookFile (MIT, (c) 2009-2023 Daggerfall Workshop):
// title (64-byte C string), author (64), "naughty" flag (8), 88 reserved bytes, price (u32), three u16, page count
// (u16) and one u32 offset per page. The price DFU uses is DFRandom seeded with the file's first four bytes,
// random_range_inclusive(300, 800). Pages are TextFile token streams ending at 0xF6. A book's id is its file number
// (ItemHelper.GetBookFileName: "BOK" + (id & 0xFF).ToString("D5") + ".TXT").
//
// Nothing here is sent to players except the title, author and page text of a book they are reading.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dfRandom } from '../../../client/world/interiors/nameBanks.js';

const END_OF_PAGE = 0xf6;
const FONT_PREFIX = 0xf9;
const POSITION_PREFIX = 0xfb;

const cString = (buf, at, len) => {
  const end = buf.indexOf(0, at);
  return buf.toString('latin1', at, end < 0 || end > at + len ? at + len : end).trim();
};

export const bookFileName = (id) => `BOK${String(id & 0xff).padStart(5, '0')}.TXT`;

/** Parse one book file buffer. Returns {title, author, naughty, price, pages: string[][]} (pages as lines). */
export function parseBook(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 64 + 64 + 8 + 88 + 4 + 8) throw new Error('book file is truncated');
  const title = cString(buf, 0, 64);
  const author = cString(buf, 64, 64);
  const naughty = cString(buf, 128, 8) === 'naughty';
  let at = 64 + 64 + 8 + 88;
  at += 4; // stored price (DFU replaces it, below)
  at += 6;
  const pageCount = buf.readUInt16LE(at);
  at += 2;
  if (at + pageCount * 4 > buf.length) throw new Error('book page table is truncated');
  const offsets = [];
  for (let i = 0; i < pageCount; i++) offsets.push(buf.readUInt32LE(at + i * 4));
  const rng = dfRandom(buf.readUInt32LE(0));
  const price = (rng.rand() % (800 - 300 + 1)) + 300;
  const pages = offsets.map((o) => pageLines(buf, o));
  return { title, author, naughty, price, pages };
}

/** TextFile.ReadTokens up to EndOfPage, joined into display lines (formatting codes become line breaks). */
function pageLines(buf, pos) {
  const lines = [];
  let line = '';
  const flush = () => { lines.push(line.replace(/\s+$/, '')); line = ''; };
  while (pos < buf.length) {
    const b = buf[pos];
    if (b === END_OF_PAGE) break;
    if (b >= 0x20 && b <= 0x7f) {
      let end = pos;
      while (end < buf.length && buf[end] >= 0x20 && buf[end] <= 0x7f) end++;
      line += buf.toString('latin1', pos, end);
      pos = end;
      continue;
    }
    pos++;
    if (b === FONT_PREFIX) { pos++; continue; }
    if (b === POSITION_PREFIX) { pos++; continue; }
    // NewLine (0x00), justification (0xFC/0xFD), record separators: start a new line.
    if (line) flush();
  }
  if (line) flush();
  // Collapse runs of blank lines.
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1]));
}

/**
 * Lazy catalogue of the installed books.
 * @param {string|null} arena2Dir operator ARENA2 directory
 */
export function createBookLibrary(arena2Dir) {
  let index = null; // id -> {file, title, author, naughty, price}
  const cache = new Map(); // id -> parsed
  function dir() {
    if (!arena2Dir) return null;
    for (const name of readdirSync(arena2Dir)) {
      if (name.toLowerCase() === 'books') {
        const full = join(arena2Dir, name);
        if (statSync(full).isDirectory()) return full;
      }
    }
    return null;
  }
  function load() {
    if (index) return index;
    index = new Map();
    const d = dir();
    if (!d) return index;
    for (const name of readdirSync(d).sort()) {
      const m = /^BOK(\d{5})\.TXT$/i.exec(name);
      if (!m) continue;
      try {
        const book = parseBook(readFileSync(join(d, name)));
        const id = Number(m[1]);
        cache.set(id, book);
        index.set(id, { id, file: name, title: book.title, author: book.author, naughty: book.naughty, price: book.price });
      } catch { /* skip an unreadable book; it is simply not offered */ }
    }
    return index;
  }
  return {
    /** Every installed book's id, sorted. */
    ids: () => [...load().keys()],
    has: (id) => load().has(id),
    info: (id) => load().get(id) ?? null,
    title: (id) => load().get(id)?.title ?? null,
    /** ItemHelper.GetRandomBookID: a uniformly chosen installed book. `rand()` returns [0,1). */
    randomId(rand = Math.random) {
      const ids = [...load().keys()];
      return ids.length ? ids[Math.floor(rand() * ids.length)] : null;
    },
    /** Full text for a reader: {id, title, author, pages}. */
    read(id) {
      if (!load().has(id)) return null;
      const b = cache.get(id);
      return { id, title: b.title, author: b.author, pages: b.pages };
    },
    get count() { return load().size; },
  };
}
