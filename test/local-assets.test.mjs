// Localhost installed-ARENA2 convenience (server/local-assets.js, client/lib/local-assets.js).
// Fixture data only: synthetic files named like Daggerfall archives, never real game content.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, truncateSync, readdirSync, readlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createGameServer } from '../server/game.js';
import { resolveLocalAssets, isKnownGameFile, isLoopbackAddress, parseRange, refusal } from '../server/local-assets.js';
import { discoverInstalledArena2, isLoopbackPage, LocalFile } from '../client/lib/local-assets.js';
import { selectArena2 } from '../client/lib/files.js';
import { indexFiles } from '../client/world/files.js';
import { readBlob } from '../client/world/bsa.js';

let tmp, arena2, clientDir, siteDir, server, port;
const bytes = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff));
const ARCH = bytes(5000, 1);

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-local-assets-'));
  arena2 = join(tmp, 'install', 'arena2');
  mkdirSync(join(arena2, 'books'), { recursive: true });
  writeFileSync(join(arena2, 'ARCH3D.BSA'), ARCH);
  writeFileSync(join(arena2, 'BLOCKS.BSA'), bytes(300, 2));
  writeFileSync(join(arena2, 'MAPS.BSA'), bytes(200, 3));
  writeFileSync(join(arena2, 'ART_PAL.COL'), bytes(776, 4));
  writeFileSync(join(arena2, 'TEXTURE.000'), bytes(64, 5));
  writeFileSync(join(arena2, '$CUREVAM.QBN'), bytes(32, 6));
  writeFileSync(join(arena2, 'notes.md'), 'not a game file');
  writeFileSync(join(arena2, 'books', 'BOOK0000.TXT'), 'nested');
  writeFileSync(join(tmp, 'SECRET.BSA'), 'outside the archive');
  symlinkSync(join(tmp, 'SECRET.BSA'), join(arena2, 'LINK.BSA'));
  clientDir = join(tmp, 'client');
  siteDir = join(tmp, 'site');
  mkdirSync(clientDir);
  mkdirSync(siteDir);
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  server = createGameServer({
    host: '127.0.0.1', port: 0, dbPath: join(tmp, 'db', 'w.db'), clientDir, siteDir, features: [],
    arena2Dir: join(tmp, 'install'), // install folder: the arena2 subfolder is used
    localAssets: { wodAssets: {
      model: async name => name === 'FixtureRock' ? {
        name, materials: [], submeshes: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6) }],
      } : null,
      texture: async path => path === 'Textures/fixture.png' ? Buffer.from([137, 80, 78, 71]) : null,
    } },
  });
  port = (await server.start()).port;
});

after(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function get(path, headers = {}, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const MANIFEST = { 'X-DFW-Local-Assets': 'manifest' };
async function token() {
  const r = await get('/local-assets/manifest', MANIFEST);
  assert.equal(r.status, 200);
  return JSON.parse(r.body).token;
}

test('abandoning an archive download closes the file and later range requests work', async () => {
  const path = join(arena2, 'ARCH3D.BSA');
  const headers = { 'X-DFW-Local-Assets': await token() };
  truncateSync(path, 32 * 1024 * 1024);
  try {
    await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/local-assets/file/ARCH3D.BSA', headers }, res => {
        res.once('data', () => res.destroy());
        res.once('close', resolve);
      });
      req.once('error', reject);
      req.end();
    });
    if (existsSync('/proc/self/fd')) {
      const stillOpen = () => readdirSync('/proc/self/fd').some(fd => {
        try { return readlinkSync('/proc/self/fd/' + fd) === path; } catch { return false; }
      });
      for (let i = 0; i < 100 && stillOpen(); i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(stillOpen(), false);
    }
    const r = await get('/local-assets/file/ARCH3D.BSA', { ...headers, Range: 'bytes=0-63' });
    assert.deepEqual(r.body, ARCH.subarray(0, 64));
  } finally {
    truncateSync(path, ARCH.length);
  }
});

// ---------------------------------------------------------------- configuration gate

test('converted wilderness models and their textures use the local file access key', async () => {
  const header = { 'X-DFW-Local-Assets': await token() };
  const model = '/local-assets/wod/model?name=FixtureRock&climate=231';
  assert.equal((await get(model)).status, 403);
  const result = await get(model, header);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).submeshes[0].positions.length, 9);
  const texture = '/local-assets/wod/texture?path=Textures%2Ffixture.png';
  assert.equal((await get(texture)).status, 403);
  assert.equal((await get(texture, header)).headers['content-type'], 'image/png');
  assert.equal((await get('/local-assets/wod/model?name=Missing', header)).status, 404);
});

test('enabled only on a direct loopback bind without proxy or public settings', () => {
  const base = { arena2Dir: arena2, env: {} };
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1' }).enabled, true);
  assert.equal(resolveLocalAssets({ ...base, host: 'localhost' }).enabled, true);
  assert.equal(resolveLocalAssets({ ...base, host: '::1' }).enabled, true);
  for (const host of ['0.0.0.0', '::', '192.168.1.5', 'play.example.org', undefined]) {
    assert.equal(resolveLocalAssets({ ...base, host }).enabled, false, String(host));
  }
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1', trustProxy: true }).enabled, false);
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1', publicOrigin: 'https://play.example.org' }).enabled, false);
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1', requireHttps: true }).enabled, false);
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1', env: { NODE_ENV: 'production' } }).enabled, false);
  assert.equal(resolveLocalAssets({ ...base, host: '127.0.0.1', env: { LOCAL_ASSETS: '0' } }).enabled, false);
  // Docker image settings: HOST=0.0.0.0, TRUST_PROXY=1, REQUIRE_HTTPS=1, NODE_ENV=production.
  assert.equal(resolveLocalAssets({ ...base, host: '0.0.0.0', trustProxy: true, requireHttps: true, env: { NODE_ENV: 'production' } }).enabled, false);
});

test('ARENA2 directory: ARENA2_DIR first, checkout fallback, never inside a public root', () => {
  const r = resolveLocalAssets({ host: '127.0.0.1', env: {}, arena2Dir: null, autoDir: arena2 });
  assert.equal(r.enabled, true);
  assert.equal(r.reason, 'checkout gamedata');
  assert.equal(resolveLocalAssets({ host: '127.0.0.1', env: {}, autoDir: join(tmp, 'missing') }).enabled, false);
  assert.equal(resolveLocalAssets({ host: '127.0.0.1', env: {}, arena2Dir: join(tmp, 'missing'), autoDir: arena2 }).enabled, false);
  assert.equal(resolveLocalAssets({ host: '127.0.0.1', env: {}, arena2Dir: arena2, publicRoots: [join(tmp, 'install')] }).enabled, false);
  assert.equal(resolveLocalAssets({ host: '127.0.0.1', env: {}, arena2Dir: arena2, publicRoots: [arena2] }).enabled, false);
});

test('server without the localAssets option never serves the route', async () => {
  const s = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, 'db2', 'w.db'), clientDir, siteDir, features: [], arena2Dir: arena2 });
  const p = (await s.start()).port;
  try {
    const r = await new Promise((resolve) => request({ host: '127.0.0.1', port: p, path: '/local-assets/manifest', headers: MANIFEST }, resolve).end());
    assert.equal(r.statusCode, 404);
    r.resume();
  } finally {
    await s.close();
  }
});

test('behind a reverse proxy the route is off even for perfect loopback requests', async () => {
  const s = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, 'db3', 'w.db'), clientDir, siteDir, features: [], arena2Dir: arena2, localAssets: { trustProxy: true } });
  const p = (await s.start()).port;
  try {
    assert.equal(s.localAssets.enabled, false);
    const r = await new Promise((resolve) => request({ host: '127.0.0.1', port: p, path: '/local-assets/manifest', headers: MANIFEST }, resolve).end());
    assert.equal(r.statusCode, 404);
    r.resume();
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------- request gate

test('manifest lists only known top-level regular game files (metadata only)', async () => {
  const r = await get('/local-assets/manifest', MANIFEST);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(r.headers['access-control-allow-origin'], undefined);
  const m = JSON.parse(r.body);
  assert.equal(m.dir, 'arena2');
  assert.match(m.token, /^[\w-]{32}$/);
  const names = m.files.map((f) => f.name).sort();
  assert.deepEqual(names, ['$CUREVAM.QBN', 'ARCH3D.BSA', 'ART_PAL.COL', 'BLOCKS.BSA', 'MAPS.BSA', 'TEXTURE.000']);
  assert.equal(m.files.find((f) => f.name === 'ARCH3D.BSA').size, ARCH.length);
  assert.ok(!r.body.includes(tmp), 'no absolute paths leak');
  assert.ok(r.body.length < 1000);
});

test('unauthorized archive calls are refused', async () => {
  const t = await token();
  const hp = `127.0.0.1:${port}`;
  const cases = [
    ['no marker header', '/local-assets/manifest', {}],
    ['file with manifest marker', '/local-assets/file/ARCH3D.BSA', MANIFEST],
    ['file without token', '/local-assets/file/ARCH3D.BSA', {}],
    ['file with wrong token', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': 'x'.repeat(32) }],
    ['cross-origin', '/local-assets/manifest', { ...MANIFEST, Origin: 'http://evil.example' }],
    ['other loopback port origin', '/local-assets/manifest', { ...MANIFEST, Origin: 'http://127.0.0.1:1' }],
    ['null origin (sandboxed iframe)', '/local-assets/manifest', { ...MANIFEST, Origin: 'null' }],
    ['cross-site fetch metadata', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, 'Sec-Fetch-Site': 'cross-site' }],
    ['same-site (other port) metadata', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, 'Sec-Fetch-Site': 'same-site' }],
    ['navigation', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }],
    ['iframe embed', '/local-assets/manifest', { ...MANIFEST, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' }],
    ['img embed', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' }],
    ['X-Forwarded-For', '/local-assets/manifest', { ...MANIFEST, 'X-Forwarded-For': '203.0.113.9' }],
    ['Forwarded', '/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, Forwarded: 'for=203.0.113.9' }],
    ['Via', '/local-assets/manifest', { ...MANIFEST, Via: '1.1 proxy' }],
  ];
  for (const [label, path, headers] of cases) {
    const r = await get(path, headers);
    assert.equal(r.status, 403, label);
    assert.ok(!r.body.equals(ARCH), label);
  }
  // Same-origin browser fetch metadata is accepted.
  const ok = await get('/local-assets/manifest', { ...MANIFEST, Origin: `http://${hp}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' });
  assert.equal(ok.status, 200);
});

test('Host must be a loopback name on the real port (DNS rebinding, public hostnames)', async () => {
  for (const host of ['daggerfall.example.org', `daggerfall.example.org:${port}`, `127.0.0.1.nip.io:${port}`, `localhost.:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.2:${port}`, `0.0.0.0:${port}`]) {
    const r = await get('/local-assets/manifest', MANIFEST, { host });
    assert.equal(r.status, 403, host);
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    assert.equal((await get('/local-assets/manifest', MANIFEST, { host })).status, 200, host);
  }
});

test('file reads: whole, ranged, case-insensitive; traversal, symlinks and non-game files refused', async () => {
  const t = await token();
  const H = { 'X-DFW-Local-Assets': t };
  const whole = await get('/local-assets/file/ARCH3D.BSA', H);
  assert.equal(whole.status, 200);
  assert.ok(whole.body.equals(ARCH));
  assert.equal(whole.headers['content-type'], 'application/octet-stream');
  assert.equal(whole.headers['content-disposition'], 'attachment');
  const part = await get('/local-assets/file/ARCH3D.BSA', { ...H, Range: 'bytes=100-199' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 100-199/${ARCH.length}`);
  assert.ok(part.body.equals(ARCH.subarray(100, 200)));
  const tail = await get('/local-assets/file/ARCH3D.BSA', { ...H, Range: 'bytes=-10' });
  assert.ok(tail.body.equals(ARCH.subarray(-10)));
  assert.equal((await get('/local-assets/file/ARCH3D.BSA', { ...H, Range: 'bytes=9000-' })).status, 416);
  assert.equal((await get('/local-assets/file/arch3d.bsa', H)).status, 200);
  assert.equal((await get('/local-assets/file/TEXTURE.000', H)).status, 200);
  assert.equal((await get('/local-assets/file/$CUREVAM.QBN', H)).status, 200);

  const refused = [
    '/local-assets/file/LINK.BSA', // symlink out of the archive
    '/local-assets/file/SECRET.BSA',
    '/local-assets/file/..%2FSECRET.BSA',
    '/local-assets/file/%2e%2e%2fSECRET.BSA',
    '/local-assets/file/%2E%2E/SECRET.BSA',
    '/local-assets/file/../SECRET.BSA',
    '/local-assets/file/..%5cSECRET.BSA',
    '/local-assets/file/%41RCH3D.BSA', // encoded letters never match
    '/local-assets/file/ARCH3D.BSA%00',
    '/local-assets/file/books/BOOK0000.TXT',
    '/local-assets/file/books%2FBOOK0000.TXT',
    '/local-assets/file/notes.md',
    '/local-assets/file/.ARCH3D.BSA',
    '/local-assets/file/',
    '/local-assets/',
    '/local-assets/../ARCH3D.BSA',
  ];
  for (const path of refused) {
    const r = await get(path, H);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 403, `${path} -> ${r.status}`);
    assert.ok(!r.body.includes('outside the archive'), path);
    assert.ok(!r.body.equals(ARCH), path);
  }
});

test('only GET/HEAD; no CORS preflight approval', async () => {
  const t = await token();
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await get('/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t, Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' }, { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  const head = await get('/local-assets/file/ARCH3D.BSA', { 'X-DFW-Local-Assets': t }, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), ARCH.length);
});

test('game data is never reachable through static roots', async () => {
  for (const path of ['/ARCH3D.BSA', '/arena2/ARCH3D.BSA', '/gamedata/DaggerfallGameFiles/arena2/ARCH3D.BSA', '/local-assets', '/local-assets/ARCH3D.BSA']) {
    const r = await get(path);
    assert.notEqual(r.status, 200, path);
    assert.ok(!r.body.equals(ARCH), path);
  }
});

test('helpers', () => {
  assert.ok(isKnownGameFile('ARCH3D.BSA'));
  assert.ok(isKnownGameFile('TEXTURE.000'));
  assert.ok(isKnownGameFile('weapon09.cif'));
  assert.ok(isKnownGameFile('$CUREWER.QRC') && isKnownGameFile('MAPSAVE.SAV'));
  assert.ok(!isKnownGameFile('$$X.QBN') && !isKnownGameFile('X$.QBN'));
  for (const bad of ['notes.md', '../X.BSA', 'a/b.BSA', 'X.BSA/', '.X.BSA', 'X.EXE', 'X', '%2e.BSA', 'X.BSA\0', 'A'.repeat(17) + '.BSA']) assert.ok(!isKnownGameFile(bad), bad);
  assert.ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && isLoopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!isLoopbackAddress('10.0.0.1') && !isLoopbackAddress('::ffff:10.0.0.1') && !isLoopbackAddress(undefined));
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.equal(parseRange('bytes=0-1,4-5', 100), 'bad');
  assert.equal(parseRange(undefined, 100), null);
  // A request from a non-loopback peer is refused even with a loopback Host.
  const req = { socket: { remoteAddress: '192.168.1.20', localAddress: '127.0.0.1', localPort: 8080 }, headers: { host: '127.0.0.1:8080', 'x-dfw-local-assets': 'manifest' } };
  assert.equal(refusal(req), 'not a loopback connection');
  req.socket.remoteAddress = '127.0.0.1';
  assert.equal(refusal(req), null);
  assert.equal(refusal({ ...req, headers: { ...req.headers, host: undefined } }), 'host is not a loopback name');
  assert.equal(refusal({ ...req, headers: { ...req.headers, host: '' } }), 'host is not a loopback name');
});

// ---------------------------------------------------------------- client

const pageAt = (url) => new URL(url);
const fetchVia = (calls) => (path, init) => {
  calls.push(path);
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: init.headers, signal: init.signal });
};

test('public origins never contact the route', async () => {
  for (const url of ['https://play.example.org/play.html', 'http://play.example.org/play.html', 'https://localhost/play.html', 'http://192.168.1.5:8080/play.html', 'http://127.0.0.1.nip.io:8080/play.html']) {
    const calls = [];
    assert.equal(isLoopbackPage(pageAt(url)), false, url);
    assert.equal(await discoverInstalledArena2({ fetch: fetchVia(calls), location: pageAt(url) }), null, url);
    assert.deepEqual(calls, [], url);
  }
  assert.ok(isLoopbackPage(pageAt('http://localhost:8080/play.html')));
  assert.ok(isLoopbackPage(pageAt('http://[::1]:8080/play.html')));
});

test('discovery yields lazy File-like values the game readers accept', async () => {
  const calls = [];
  const found = await discoverInstalledArena2({ fetch: fetchVia(calls), location: pageAt(`http://127.0.0.1:${port}/play.html`) });
  assert.deepEqual(calls, ['/local-assets/manifest'], 'metadata only up front');
  assert.equal(found.files.length, 6);
  assert.equal((await found.files.find((f) => f.name === '$CUREVAM.QBN').arrayBuffer()).byteLength, 32);
  const sel = selectArena2(found.files);
  assert.equal(sel.problem, null);
  assert.deepEqual(sel.missing, []);
  assert.equal(sel.dir, 'arena2');
  const index = indexFiles(sel.files);
  const arch = index.get('ARCH3D.BSA');
  assert.ok(arch instanceof LocalFile);
  assert.equal(arch.size, ARCH.length);
  assert.equal(typeof arch.lastModified, 'number');
  // BSA reader contract: readBlob(blob, offset, length) -> blob.slice(a, b).arrayBuffer()
  assert.ok(Buffer.from(await readBlob(arch, 10, 20)).equals(ARCH.subarray(10, 30)));
  assert.ok(Buffer.from(await arch.slice(-5).arrayBuffer()).equals(ARCH.subarray(-5)));
  assert.ok(Buffer.from(await arch.slice(100, 300).slice(50, 60).arrayBuffer()).equals(ARCH.subarray(150, 160)));
  assert.equal((await arch.slice(10, 5).arrayBuffer()).byteLength, 0);
  // Whole-file reads (textures, palettes) and the Response(file) fallback path.
  const pal = index.get('ART_PAL.COL');
  assert.equal((await pal.arrayBuffer()).byteLength, 776);
  assert.equal((await pal.arrayBuffer()).byteLength, 776); // served from the cache
  assert.ok(calls.filter((c) => c.includes('ART_PAL.COL')).length === 1);
  assert.ok(calls.every((c) => c.startsWith('/local-assets/')));
});

test('main.js adopts installed data through acceptData with a race guard and keeps the folder override', () => {
  const src = readFileSync(new URL('../client/main.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/lib\/local-assets\.js'/);
  assert.match(src, /acceptData\(found\.files, 'installed'\)/);
  assert.match(src, /if \(seq !== dataSeq \|\| S\.data\) return;/);
  assert.match(src, /function acceptData\(items, source = 'folder'\) \{\n  dataSeq\+\+;/);
  assert.match(src, /Installed game files ready/);
  assert.match(src, /ui\.pick\.addEventListener\('click'/);
  // Same files from a manual pick still count as a new (override) selection.
  assert.match(src, /S\.data\.source === source && sameFiles/);
});

test('runtime dataPath follows the auto-discovered folder only on silent localhost defaults', async () => {
  const mk = async (extra) => {
    const s = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, `db-${Math.random()}`, 'w.db'), clientDir, siteDir, features: [], ...extra });
    const dir = s.config.arena2Dir;
    await s.close();
    return dir;
  };
  // createGameServer resolves the checkout default internally; emulate with autoDir.
  assert.equal(await mk({ localAssets: { autoDir: arena2 } }), arena2);
  assert.equal(await mk({ localAssets: { autoDir: arena2, env: { LOCAL_ASSETS: '0' } } }), null);
  assert.equal(await mk({ localAssets: { autoDir: arena2, trustProxy: true } }), null);
  assert.equal(await mk({ localAssets: { autoDir: arena2, publicOrigin: 'https://play.example.org' } }), null);
  assert.equal(await mk({}), null);
  // An explicit ARENA2_DIR always wins.
  assert.equal(await mk({ arena2Dir: join(tmp, 'install'), localAssets: { autoDir: join(tmp, 'missing') } }), join(tmp, 'install'));
});

test('every top-level file of a real install is accepted when present (local only)', async (t) => {
  const { readdirSync } = await import('node:fs');
  const real = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url);
  let ents;
  try { ents = readdirSync(real, { withFileTypes: true }); } catch { return t.skip('no local ARENA2 in this checkout'); }
  const rejected = ents.filter((e) => e.isFile() && !isKnownGameFile(e.name)).map((e) => e.name);
  assert.deepEqual(rejected, []);
});
