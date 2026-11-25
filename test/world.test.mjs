// loadTown against the local Daggerfall install (gamedata/, never committed).
// Skips when the data is absent. Synthetic format tests: world-formats.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { loadTown, WorldDataError, GROUND_MESH_Y } from '../client/world/town.js';

const INSTALL = new URL('../gamedata/DaggerfallGameFiles/', import.meta.url).pathname;
const ARENA2 = join(INSTALL, 'arena2');
const hasData = existsSync(join(ARENA2, 'MAPS.BSA'));
const skip = hasData ? false : 'local Daggerfall data not present in gamedata/DaggerfallGameFiles/arena2';

const NEEDED = /^(MAPS\.BSA|BLOCKS\.BSA|ARCH3D\.BSA|CLIMATE\.PAK|ART_PAL\.COL|TEXTURE\.\d{3})$/i;

/** Browser-like File objects for a directory, with webkitRelativePath rooted at the directory's own name. */
async function filesFromDir(root, { filter = (n) => NEEDED.test(n), rename = (n) => n } = {}) {
  const top = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const out = [];
  const walk = async (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) await walk(p);
      else if (filter(name)) {
        const file = new File([await openAsBlob(p)], rename(name));
        const rel = [top, ...relative(root, p).split(sep)];
        rel[rel.length - 1] = rename(name);
        Object.defineProperty(file, 'webkitRelativePath', { value: rel.join('/') });
        out.push(file);
      }
    }
  };
  await walk(root);
  return out;
}

const withPath = (file, path) => {
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
};

let files;
let town;
before(async () => {
  if (!hasData) return;
  files = await filesFromDir(ARENA2);
  town = await loadTown(files);
});

const tri = (P, t) => [0, 1, 2].map((k) => [P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Möller–Trumbore; returns distance or Infinity. */
function rayHit(o, d, [a, b, c]) {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return Infinity;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  const t = dot(e2, q) * inv;
  return t > 1e-6 ? t : Infinity;
}

/** Distance in the XZ plane from (px,pz) to a triangle's projection (0 if inside). */
function xzDistance(px, pz, v) {
  const P = v.map((q) => [q[0], q[2]]);
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  const p = [px, pz];
  const d1 = sign(p, P[0], P[1]), d2 = sign(p, P[1], P[2]), d3 = sign(p, P[2], P[0]);
  const area = Math.abs(sign(P[0], P[1], P[2]));
  if (area > 1e-9 && !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = P[i], b = P[(i + 1) % 3];
    const ab = [b[0] - a[0], b[1] - a[1]];
    const len2 = ab[0] ** 2 + ab[1] ** 2 || 1e-12;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2));
    best = Math.min(best, Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t));
  }
  return best;
}

test('Gothway Garden is read from MAPS/BLOCKS/ARCH3D with its original layout', { skip }, () => {
  assert.equal(town.name, 'Gothway Garden');
  assert.equal(town.region, 'Daggerfall');
  assert.equal(town.source.regionIndex, 17);
  assert.equal(town.source.locationIndex, 197);
  assert.equal(town.source.mapId, 206728581);
  assert.equal(town.source.width, 4);
  assert.equal(town.source.height, 3);
  assert.deepEqual(
    town.source.blocks.map((b) => b.name),
    [
      'TEMPAAH0.RMB', 'FIGHAA02.RMB', 'BANKAM02.RMB', 'GENRAM00.RMB',
      'RESIAM06.RMB', 'GRVEAM34.RMB', 'GENRAM02.RMB', 'RESIAM10.RMB',
      'RESIAM01.RMB', 'MAGEAA03.RMB', 'TVRNAM00.RMB', 'TEMPAAB0.RMB',
    ],
  );
  assert.equal(town.source.climate.value, 231);
  assert.equal(town.source.climate.groundArchive, 302);
  assert.equal(town.stats.modelInstances, 262);
  assert.equal(town.stats.uniqueModels, 95);
  assert.equal(town.stats.textures, 97);
  assert.equal(town.stats.droppedPlanes, 0);
  assert.deepEqual(town.stats.climateSwapFallbacks, []);
  assert.equal(town.stats.groundTriangles, 4 * 3 * 256 * 2);
  assert.equal(town.stats.triangles, 68415);
});

test('output arrays honour the contract', { skip }, () => {
  const { positions: P, colors: C, uv: U, atlas: A, bounds: B } = town;
  assert.ok(P instanceof Float32Array && C instanceof Float32Array && U instanceof Float32Array);
  assert.equal(P.length % 9, 0);
  assert.equal(C.length, P.length);
  assert.equal(U.length, (P.length / 3) * 2);
  assert.ok(C.every((c) => c === 1), 'textured triangles are white');
  assert.ok(P.every(Number.isFinite));
  assert.ok(U.every((u) => u >= 0 && u <= 1), 'uv inside the atlas');
  assert.equal(A.width, 2048);
  assert.equal(A.pixels.length, A.width * A.height * 4);
  assert.ok(A.pixels instanceof Uint8Array);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]);
    minZ = Math.min(minZ, P[i + 2]); maxZ = Math.max(maxZ, P[i + 2]);
  }
  assert.deepEqual([B.minX, B.maxX, B.minZ, B.maxZ], [minX, maxX, minZ, maxZ]);
  assert.ok(B.minX < 0 && B.maxX > 0 && B.minZ < 0 && B.maxZ > 0, 'spawn inside bounds');
  // Ground footprint is exactly 4 x 3 blocks of 102.4 m; a few original props overhang the edge by metres.
  const g = town.ground;
  let gx0 = Infinity, gx1 = -Infinity, gz0 = Infinity, gz1 = -Infinity;
  for (let i = g.firstTriangle * 9; i < P.length; i += 3) {
    gx0 = Math.min(gx0, P[i]); gx1 = Math.max(gx1, P[i]);
    gz0 = Math.min(gz0, P[i + 2]); gz1 = Math.max(gz1, P[i + 2]);
  }
  assert.ok(Math.abs(gx1 - gx0 - 409.6) < 1e-3, `ground x span ${gx1 - gx0}`);
  assert.ok(Math.abs(gz1 - gz0 - 307.2) < 1e-3, `ground z span ${gz1 - gz0}`);
  assert.ok(B.maxX - B.minX < 409.6 + 10 && B.maxZ - B.minZ < 307.2 + 10, 'geometry stays near the town');
  assert.ok(B.maxY > 10 && B.maxY < 30, `tallest roof ${B.maxY} m`);
});

test('triangle centroids land on opaque decoded texels', { skip }, () => {
  // Opaque texels under every triangle centroid prove the uv lands on decoded image data, not padding/black.
  const { uv: U, atlas: A } = town;
  let opaque = 0;
  const n = U.length / 6;
  for (let t = 0; t < n; t++) {
    const u = (U[t * 6] + U[t * 6 + 2] + U[t * 6 + 4]) / 3;
    const v = (U[t * 6 + 1] + U[t * 6 + 3] + U[t * 6 + 5]) / 3;
    const o = (Math.min(A.height - 1, Math.floor(v * A.height)) * A.width + Math.min(A.width - 1, Math.floor(u * A.width))) * 4;
    if (A.pixels[o + 3] === 255) opaque++;
  }
  assert.ok(opaque / n > 0.95, `opaque centroid ratio ${opaque / n}`);
});

test('ground is included, upward facing, under the spawn', { skip }, () => {
  const { positions: P, ground: G } = town;
  assert.equal(G.included, true);
  assert.equal(G.firstTriangle + G.triangleCount, P.length / 9);
  let under = 0;
  for (let t = G.firstTriangle; t < G.firstTriangle + G.triangleCount; t++) {
    const v = tri(P, t);
    assert.ok(v.every((q) => Math.abs(q[1] - GROUND_MESH_Y) < 1e-6));
    const n = cross(sub(v[1], v[0]), sub(v[2], v[0]));
    assert.ok(n[1] > 0, 'ground triangles are counter-clockwise seen from above');
    if (xzDistance(0, 0, v) === 0) under++;
  }
  assert.ok(under >= 1, 'a ground triangle lies under the spawn');
  assert.equal(town.source.spawnTileRecord, 46, 'spawn tile is cobbled road');
  assert.equal(town.source.spawnTier, 'street');
});

test('spawn is open street with a clear view down -z', { skip }, () => {
  const { positions: P, ground: G } = town;
  assert.deepEqual(town.spawn, { x: 0, y: 0, z: 0, yaw: 0, forward: [0, 0, -1] });
  let nearest = Infinity;
  for (let t = 0; t < G.firstTriangle; t++) {
    const v = tri(P, t);
    const ys = v.map((q) => q[1]);
    if (Math.max(...ys) < 0.1 || Math.min(...ys) > 2.2) continue;
    nearest = Math.min(nearest, xzDistance(0, 0, v));
  }
  assert.ok(nearest >= 1.5, `nearest body-height geometry ${nearest.toFixed(2)} m from spawn`);
  for (const h of [0.3, 1.0, 1.7]) {
    for (const dx of [-0.4, 0, 0.4]) {
      let hit = Infinity;
      for (let t = 0; t < G.firstTriangle; t++) hit = Math.min(hit, rayHit([dx, h, 0], [0, 0, -1], tri(P, t)));
      assert.ok(hit > 12, `ray at h=${h}, dx=${dx} hits geometry ${hit.toFixed(2)} m ahead`);
    }
  }
});

test('visible faces point at the viewer (counter-clockwise front faces)', { skip }, () => {
  const { positions: P, ground: G } = town;
  const eye = [0, 1.6, 0];
  let facing = 0, hits = 0;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    for (const pitch of [0, 0.15]) {
      const d = [Math.sin(a) * Math.cos(pitch), Math.sin(pitch), -Math.cos(a) * Math.cos(pitch)];
      let best = Infinity, bestT = -1;
      for (let t = 0; t < G.firstTriangle; t++) {
        const h = rayHit(eye, d, tri(P, t));
        if (h < best) [best, bestT] = [h, t];
      }
      if (bestT < 0 || best > 80) continue;
      const v = tri(P, bestT);
      hits++;
      if (dot(cross(sub(v[1], v[0]), sub(v[2], v[0])), d) < 0) facing++;
    }
  }
  assert.ok(hits > 40, `rays hit ${hits} faces`);
  assert.ok(facing / hits > 0.9, `${facing}/${hits} first-hit faces are front-facing`);
});

test('install folder with lower-case names and a decoy duplicate', { skip }, async () => {
  const lower = await filesFromDir(INSTALL, { rename: (n) => n.toLowerCase() });
  assert.ok(lower.some((f) => f.webkitRelativePath.toLowerCase().includes('/arena2/maps.bsa')));
  const decoy = withPath(new File([new Uint8Array(64)], 'MAPS.BSA'), 'DaggerfallGameFiles/CDROM/MAPS.BSA');
  const t = await loadTown([decoy, ...lower]);
  assert.equal(t.name, 'Gothway Garden');
  const h = (a) => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
  assert.equal(h(t.positions), h(town.positions), 'deterministic geometry');
  assert.equal(h(t.atlas.pixels), h(town.atlas.pixels), 'deterministic atlas');
});

test('another named location loads on request; no silent fallback', { skip }, async () => {
  const wayrest = await loadTown(files, { region: 'Wayrest', location: 'Wayrest' });
  assert.equal(wayrest.name, 'Wayrest');
  assert.ok(wayrest.stats.triangles > town.stats.triangles);
  await assert.rejects(loadTown(files, { location: 'Nowhere At All' }), (e) => e instanceof WorldDataError && /Nowhere At All/.test(e.message));
  await assert.rejects(loadTown(files, { region: 'Cyrodiil' }), (e) => e instanceof WorldDataError && /Unknown region/.test(e.message));
});

test('missing or damaged data fails clearly', { skip }, async () => {
  const without = (re) => files.filter((f) => !re.test(f.name));
  await assert.rejects(loadTown(without(/^ARCH3D\.BSA$/)), (e) => e instanceof WorldDataError && /ARCH3D\.BSA/.test(e.message));
  await assert.rejects(loadTown(without(/^TEXTURE\.302$/)), (e) => e instanceof WorldDataError && /TEXTURE\.302/.test(e.message));
  const maps = files.find((f) => f.name === 'MAPS.BSA');
  const truncated = new File([maps.slice(0, maps.size - 100)], 'MAPS.BSA');
  await assert.rejects(loadTown([truncated, ...without(/^MAPS\.BSA$/)]), WorldDataError);
  const garbage = new File([new Uint8Array(4096).fill(7)], 'BLOCKS.BSA');
  await assert.rejects(loadTown([garbage, ...without(/^BLOCKS\.BSA$/)]), (e) => e instanceof WorldDataError && /BLOCKS\.BSA/.test(e.message));
});
