// Where trees are proposed to stand: the arithmetic of world/trees.js that needs no graphics, kept apart so
// that it can run in a worker (world/terrain.worker.js) as well as on the main thread. Everything a call needs
// comes in through its arguments: heights and water as grids, the airfields that touch the ground in question,
// and an `env` with the few numbers of the regional maps that matter here. Nothing in this file reads the
// game's state, so the same call gives the same trees wherever it runs.
//
//   P     { CELL, PATCH, GRID, FAR_SIZE, FAR_POOL }: the layout constants of trees.js
//   env   { m: [m00, m10, m01, m11]   moisture at the patch's four corners (terrain.moisture)
//           tl                        the tree line at the patch's middle (terrain.treeline), m
//           sea                       how far the region's woods are a wet coast's (terrain.oceanWoods)
//           towny                     does a town touch the patch (towns.townsIn)
//           urban }                   the towns' built-up density under it (see urbanAt in patchbuild.js)

import { mulberry32, smoothstep, clamp } from '../core/noise.js';
import { flatWeight, applyFlats } from './terrain.js';
import { sampleWindow, urbanAt } from './demwindow.js';

const hash2 = (x, y, s) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
// Where there is no picture to show the shelter belts, a loose grid of field boundaries stands in:
// some of its edges carry a belt. Returns 0, or 1 + a number that picks the belt's species.
function beltAt(x, z) {
  const G = 310, c = 0.9563, s = 0.2924;                          // turned 17 degrees off north
  const u = (x * c + z * s) / G, v = (-x * s + z * c) / G, iu = Math.round(u), iv = Math.round(v);
  if (Math.abs(u - iu) * G < 5.5 && hash2(iu, Math.floor(v), 7) < 0.3) return 1 + hash2(iu, Math.floor(v), 9);
  if (Math.abs(v - iv) * G < 5.5 && hash2(Math.floor(u), iv, 8) < 0.2) return 1 + hash2(Math.floor(u), iv, 10);
  return 0;
}
const CONIFERS = [11, 7, 8, 9, 11, 7, 8], BELTS = [14, 15, 7, 14, 11, 12, 15, 8];      // spruce and pine; shelterbelts of ash, cottonwood and spruce

// Scratch space for one patch's proposals, before they are packed (made for the layout on first use).
let PN = 0, PTOTAL = 0, PA = null, PB = null, PC = null, ORDER = null;
let FGN = 0, FH = null, FW = null;
const LH = new Float32Array(33 * 33);
function scratch(P) {
  const n = Math.floor(P.PATCH / P.CELL);
  if (n === PN) return;
  PN = n; PTOTAL = n * n;
  PA = new Float32Array(PTOTAL * 4); PB = new Uint8Array(PTOTAL * 4); PC = new Int8Array(PTOTAL * 4); ORDER = new Uint16Array(PTOTAL);
  FGN = P.PATCH / 32 + 3; FH = new Float32Array(FGN * FGN); FW = new Uint8Array(FGN * FGN);
}
/** How many candidates a patch has in all. */
export const candidates = (P) => Math.floor(P.PATCH / P.CELL) ** 2;

/**
 * Propose trees for one PATCH-sized square of ground: the first `share` of its list of candidates (all of it for a
 * terrain patch, the head of it for a far tile: the same trees either way, because the list is made from the
 * square's own seed). H, W: height and water grids, GN across with one cell of margin, `step` meters apart.
 * Fills PA (x and z in the square, height, rank), PB and PC as the shaders' aA, aB and aC; returns how many.
 */
function propose(P, x0, z0, H, W, GN, step, flats, share, env) {
  scratch(P);
  const size = P.PATCH, n = PN, total = PTOTAL, cell = size / n;
  const rnd = mulberry32((x0 * 73856093) ^ (z0 * 19349663));
  const order = ORDER;
  for (let i = 0; i < total; i++) order[i] = i;
  // Visit the cells in random order and hand out ranks in that order: any leading share of the list is then an even thinning.
  for (let i = total - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = order[i]; order[i] = order[j]; order[j] = t; }
  const A = PA, B = PB, C = PC;
  const tl = env.tl + 60, TNm = GN - 4, foot = Math.max(1, Math.round(24 / step));
  const towny = env.towny;
  // Smooth noise on lattices that divide the patch: each node is hashed once, and neighboring patches agree along their edges.
  const lattice = (cells, seed) => {
    const m = cells + 1, g = new Float32Array(m * m), s = size / cells, ix0 = Math.round(x0 / s), iz0 = Math.round(z0 / s);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) g[j * m + i] = hash2(ix0 + i, iz0 + j, seed);
    return (lx, lz) => {
      const fx = lx / s, fz = lz / s, i = Math.min(cells - 1, fx | 0), j = Math.min(cells - 1, fz | 0), q = j * m + i;
      let u = fx - i, v = fz - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
      return (g[q] + (g[q + 1] - g[q]) * u) * (1 - v) + (g[q + m] + (g[q + m + 1] - g[q + m]) * u) * v;
    };
  };
  const standAt = lattice(3, 11), grownAt = lattice(8, 23), block = size / 3;     // stands about 340 m across, growth about 130 m
  // moisture changes over kilometers: the patch's corners are enough
  const m00 = env.m[0], m10 = env.m[1], m01 = env.m[2], m11 = env.m[3];
  let count = 0;
  const last = Math.min(total, Math.ceil(total * share));
  for (let k = 0; k < last; k++) {
    const ci = order[k], lx = ((ci % n) + rnd()) * cell, lz = (((ci / n) | 0) + rnd()) * cell;
    const r1 = rnd(), r3 = rnd(), r2 = (r1 * 1024) % 1, r4 = (r3 * 1024) % 1;
    const fx = lx / step, fz = lz / step, ix = Math.min(TNm, fx | 0), iz = Math.min(TNm, fz | 0);
    const c = (iz + 1) * GN + ix + 1, u = fx - ix, v = fz - iz;
    if (W[c] > 40 || W[c + 1] > 40 || W[c + GN] > 40 || W[c + GN + 1] > 40) continue;
    const h = (H[c] * (1 - u) + H[c + 1] * u) * (1 - v) + (H[c + GN] * (1 - u) + H[c + GN + 1] * u) * v;
    const sx = (H[c + 1] - H[c]) / step, sz = (H[c + GN] - H[c]) / step;
    const slope = 1 - 1 / Math.sqrt(1 + sx * sx + sz * sz);
    const wx = x0 + lx, wz = z0 + lz;
    if (h > tl || slope > 0.62 || h < 1.5) continue;
    if (flats.length && flatWeight(flats, wx, wz) > 0.02) continue;

    // ---- what the vegetation rules say grows here (they mirror the terrain shader)
    const tx = lx / size, tz = lz / size, m = (m00 + (m10 - m00) * tx) * (1 - tz) + (m01 + (m11 - m01) * tx) * tz, town = towny ? urbanAt(env.urban, wx, wz) : 0;
    const farm = (1 - smoothstep(0.03, 0.09, slope)) * (1 - smoothstep(tl - 1560, tl - 1160, h)) * smoothstep(0.25, 0.42, m) * (1 - smoothstep(0.66, 0.78, m));
    let forest = smoothstep(0.42, 0.6, m) * (1 - smoothstep(tl - 160, tl - 10, h)) * (1 - smoothstep(0.38, 0.62, slope)) * (1 - 0.9 * farm);
    forest = Math.max(forest * (1 - 0.7 * town), 0.1 * town) * smoothstep(1.5, 6, h);
    const stand = standAt(lx, lz), grown = grownAt(lx, lz), wet = smoothstep(0.36, 0.5, m);
    const rank = (k + r1) / total;

    // ---- species
    let vi, solitary = 0, rule = rank <= forest * 0.92 ? 1 : 0, scale = (0.6 + 0.8 * grown) * (0.8 + 0.4 * r2);
    if (town > 0.25 && r3 < town) vi = r4 < 0.72 ? 14 + (r2 < 0.5 ? 0 : 1) : r4 < 0.86 ? CONIFERS[(r2 * 7) | 0] : r4 < 0.93 ? 12 : 5;
    else if (r3 < wet || h > tl - 1760) {
      // woods: spruce, fir and pine on the mountains and through the north woods, with aspen and birch among them;
      // oak, maple and ash in the Midwest; everything smaller toward the tree line
      // (The conifers' band begins 1760 m under the tree line in the high West; where the tree line is low it is a
      // share of it, so New England's hills are maple, beech and birch up to about 700 m and spruce and fir above,
      // unless the tree line is lower still, in the boreal north, where the spruce come down to the lowlands.)
      const cDrop = Math.min(1760, 0.5 * tl + 900 * smoothstep(1300, 900, tl)), cBand = Math.min(600, 0.25 * tl);
      const conif = clamp(smoothstep(tl - cDrop, tl - cDrop + cBand, h) + 0.45 * (env.sea ?? 1) * smoothstep(0.7, 0.86, m), 0, 1), high = smoothstep(tl - 320, tl - 60, h);
      if (r4 < conif * 0.85) vi = r2 < 0.38 ? 11 : r2 < 0.62 ? 7 : r2 < 0.8 ? 8 : 9;
      else if (r4 > 0.93 - 0.3 * high || grown < 0.2) vi = conif > 0.5 ? 12 : 5;
      else vi = r2 < 0.3 ? 0 : r2 < 0.55 ? 1 : r2 < 0.75 ? 14 : r2 < 0.92 ? 15 : 2;
      scale *= 1 - 0.45 * high;
    } else if (farm > 0.35) {
      // farmland: shelterbelts and woodlots of one kind each, willows and cottonwoods by the water
      const belt = beltAt(wx, wz);
      const wetFoot = W[Math.max(c - 3, 0)] > 40 || W[Math.min(c + 3, GN * GN - 1)] > 40 || W[Math.max(c - 3 * GN, 0)] > 40 || W[Math.min(c + 3 * GN, GN * GN - 1)] > 40;
      if (belt) { vi = BELTS[((belt - 1) * 8) | 0]; rule = 1; scale = 0.8 + 0.3 * stand + 0.12 * r2; }
      else if (wetFoot && r4 < 0.7) vi = r4 < 0.35 ? 13 : 15;
      else vi = stand < 0.15 ? CONIFERS[(hash2(Math.floor(wx / block), Math.floor(wz / block), 5) * 7) | 0] : stand < 0.25 ? 12 : stand < 0.32 ? 13 : 14 + (r2 < 0.5 ? 0 : 1);
      if (stand > 0.84) { rule = 1; scale = 0.75 + 0.5 * stand; }       // a farm woodlot
      if (r4 > 0.9975) { solitary = 1; rule = 1; vi = r2 < 0.5 ? 14 : r2 < 0.8 ? 15 : r2 < 0.9 ? 11 : 13; scale = 1.05 + 0.5 * r3; }
    } else {
      // dry country: juniper and brush, ponderosa pine, cottonwoods in the damper draws
      vi = forest > 0.3 && r4 < 0.6 ? (r2 < 0.5 ? 15 : 5) : r4 < 0.6 ? 6 : r4 < 0.82 ? 9 : r4 < 0.9 ? 8 : 5;
      if (r3 > 0.9985 && slope < 0.12) { solitary = 1; rule = 1; }
    }
    if (r3 > 0.97 && !solitary) scale *= 1.4;                    // the odd giant
    scale = clamp(scale, 0.36, 1.95);

    const o = count * 4;
    A[o] = lx; A[o + 1] = h - 0.3 - 1.6 * Math.hypot(sx, sz); A[o + 2] = lz; A[o + 3] = Math.min(rank, 0.99998);
    B[o] = vi + 16 * (solitary + 2 * rule + 4 * (stand > 0.5 ? 1 : 0)); B[o + 1] = (r2 * 9973) & 255; B[o + 2] = Math.round(((scale - 0.3) / 1.7) * 255); B[o + 3] = (r4 * 7919) & 255;
    C[o] = clamp(sx / 2, -1, 1) * 127; C[o + 1] = clamp(sz / 2, -1, 1) * 127; C[o + 2] = (r1 * 2 - 1) * 127; C[o + 3] = clamp(forest, 0, 1) * 127;
    count++;
  }
  return count;
}

/** Height of the terrain as its mesh draws it: a lattice of n x n heights `step` apart, each square split along the diagonal the mesh uses. */
function meshHeight(L, n, step, lx, lz) {
  const fx = lx / step, fz = lz / step, i = Math.min(n - 2, Math.max(0, fx | 0)), j = Math.min(n - 2, Math.max(0, fz | 0)), u = fx - i, v = fz - j, q = j * n + i;
  const a = L[q], c = L[q + 1], b = L[q + n], d = L[q + n + 1];
  return u + v <= 1 ? a + (c - a) * u + (b - a) * v : d + (b - d) * (1 - u) + (c - d) * (1 - v);
}

/**
 * The trees of one terrain patch, packed as the shaders read them. H, W: the patch's height and water grids
 * (GN across, one cell of margin, `step` meters apart); flats: airfields touching the patch.
 * Returns null if nothing grows there, else { count, lo, yr, A, B, C, start, list }: positions as 16-bit
 * fractions of the patch (heights of lo .. lo + yr), and the index of its GRID x GRID squares.
 */
export function placeFine(P, x0, z0, H, W, GN, step, flats, env) {
  const size = P.PATCH, GRID = P.GRID;
  let lo = 1e9, hi = -1e9;
  for (let i = 0; i < GN * GN; i++) { const h = H[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  lo -= 6;
  const yr = Math.max(hi - lo, 1);
  const count = propose(P, x0, z0, H, W, GN, step, flats, 1, env);
  if (!count) return { count: 0, lo, yr };
  const A = new Uint16Array(count * 4);
  for (let o = 0; o < count * 4; o += 4) {
    A[o] = clamp(PA[o] / size, 0, 1) * 65535; A[o + 1] = clamp((PA[o + 1] - lo) / yr, 0, 1) * 65535; A[o + 2] = clamp(PA[o + 2] / size, 0, 1) * 65535; A[o + 3] = PA[o + 3] * 65535;
  }
  const B = PB.slice(0, count * 4), C = PC.slice(0, count * 4);
  // squares of the patch -> the trees in each, for finding the ones near the camera
  const start = new Uint32Array(GRID * GRID + 1), cellOf = new Uint16Array(count);
  for (let i = 0; i < count; i++) { const gx = Math.min(GRID - 1, (A[i * 4] * GRID) >> 16), gz = Math.min(GRID - 1, (A[i * 4 + 2] * GRID) >> 16); cellOf[i] = gz * GRID + gx; start[cellOf[i] + 1]++; }
  for (let i = 0; i < GRID * GRID; i++) start[i + 1] += start[i];
  const fill = start.slice(0, GRID * GRID), list = new Uint16Array(count);
  for (let i = 0; i < count; i++) list[fill[cellOf[i]]++] = i;
  return { count, lo, yr, A, B, C, start, list };
}

/**
 * One far tile: the head of the candidate list of each of its four patches, standing on the terrain as it is
 * drawn at that distance.
 *   job  { P, x0, z0, coarse, win, flats, q: [env x 4] }
 *        coarse: the terrain there is the 4 km patch (128 m mesh) instead of the 2 km one (64 m mesh);
 *        win: the elevation under the tile at the zoom the terrain uses there (dem.window);
 *        q: an env (see the top of this file) for each of the four patches.
 * Returns { n, lo, yr, A, B, C }: the tile's list in order of rank, packed for the shaders (n may be 0).
 */
export function placeFar(job) {
  const { P, x0, z0, coarse, win, flats } = job, S = P.FAR_SIZE, PATCH = P.PATCH, ls = coarse ? 128 : 64, ln = S / 2 / ls + 1;
  scratch(P);
  const cap = Math.ceil(PTOTAL * P.FAR_POOL) * 4;
  const X = new Float32Array(cap * 4), B = new Uint8Array(cap * 4), C = new Int8Array(cap * 4);
  let n = 0, lo = 1e9, hi = -1e9;
  for (let q = 0; q < 4; q++) {
    const bx = x0 + (q & 1) * PATCH, bz = z0 + (q >> 1) * PATCH;
    sampleWindow(win, bx - 32, bz - 32, 32, FGN, FH, FW);
    const count = propose(P, bx, bz, FH, FW, FGN, 32, flats, P.FAR_POOL, job.q[q]);
    if (!count) continue;
    // the mesh the terrain draws here: its vertices, graded for airfields as the terrain grades them
    sampleWindow(win, bx, bz, ls, ln, LH, null);
    if (flats.length) for (let j = 0; j < ln; j++) for (let i = 0; i < ln; i++) LH[j * ln + i] = applyFlats(flats, bx + i * ls, bz + j * ls, LH[j * ln + i]);
    for (let i = 0; i < count; i++, n++) {
      const o = i * 4, d = n * 4, lx = PA[o], lz = PA[o + 2];
      // sunk a little further than close up: a card may stand deep in a coarse mesh, but must never hang over it
      const y = meshHeight(LH, ln, ls, lx, lz) - 1.5 - 3.0 * Math.hypot(PC[o], PC[o + 1]) / 127;
      X[d] = lx + (q & 1) * PATCH; X[d + 1] = y; X[d + 2] = lz + (q >> 1) * PATCH; X[d + 3] = PA[o + 3];
      B[d] = PB[o]; B[d + 1] = PB[o + 1]; B[d + 2] = PB[o + 2]; B[d + 3] = PB[o + 3];
      C[d] = PC[o]; C[d + 1] = PC[o + 1]; C[d + 2] = q; C[d + 3] = PC[o + 3];
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
  }
  if (!n) return { n: 0, lo: 0, yr: 1 };
  // ranks rise along each patch's list; the tile's list is the four merged, so a leading run is still an even thinning
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => X[a * 4 + 3] - X[b * 4 + 3]);
  lo -= 2; const yr = Math.max(hi - lo, 1);
  const A = new Uint16Array(n * 4), B2 = new Uint8Array(n * 4), C2 = new Int8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = order[i] * 4, d = i * 4;
    A[d] = clamp(X[s] / S, 0, 1) * 65535; A[d + 1] = clamp((X[s + 1] - lo) / yr, 0, 1) * 65535; A[d + 2] = clamp(X[s + 2] / S, 0, 1) * 65535; A[d + 3] = X[s + 3] * 65535;
    B2[d] = B[s]; B2[d + 1] = B[s + 1]; B2[d + 2] = B[s + 2]; B2[d + 3] = B[s + 3];
    C2[d] = C[s]; C2[d + 1] = C[s + 1]; C2[d + 2] = C[s + 2]; C2[d + 3] = C[s + 3];
  }
  return { n, lo, yr, A, B: B2, C: C2 };
}
