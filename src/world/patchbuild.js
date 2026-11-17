// Building one terrain patch's data: the arithmetic of world/chunks.js that needs no graphics, kept apart so
// that it can run in a worker (world/terrain.worker.js) as well as on the main thread. A job carries all it
// needs (Terrain.prepare in chunks.js makes one); nothing here reads the game's state except the region
// (geo.setRegion), which the job names. What comes back is ready to hand to the graphics card: the patch's
// layer of the data texture, its vertex buffers, and its trees.
//
//   job  { x0, z0, size, zoom         the patch, and the elevation zoom it is sampled at
//          region: [lat0, lon0]       where the window of the world is (geo.REGION)
//          layer, quarter             its layer of the data texture; which quarter of its parent it is
//          win                        the elevation under it with a margin (dem.window: see demwindow.js)
//          flats                      airfields whose graded ground touches it (terrain.flatsIn)
//          towny, doubt, urban        a town touches it: the water codes at zoom DOUBT_Z under it, and the
//                                     towns' density there (demwindow.urbanAt)
//          parent                     null, or { h: the parent mesh's V x V heights, layer, midY, end }
//          trees }                    null, or { P, m, tl, towny }: see treeplace.js (urban is the job's)

import { setRegion, REGION, toLatLon } from './geo.js';
import { GREAT_LAKES } from './water.js';
import { applyFlats, flatWeight, URBAN } from './terrain.js';
import { sampleWindow, doubtfulIn, urbanAt } from './demwindow.js';
import { placeFine } from './treeplace.js';

// A patch is N x N quads (V x V vertices) with a data texture TN x TN: SUB texels to a quad. It is sampled
// on a grid one texel wider all around (GN x GN), for the slopes along its edge.
export const N = 32, V = N + 1, SUB = 4, TN = N * SUB + 1, GN = TN + 2;
export const VERTS = V * V + 4 * V;      // with the skirt: a strip of vertices hanging from each edge

const H = new Float32Array(GN * GN), W = new Uint8Array(GN * GN);

// Ground below sea level that the sea does not reach, where water under zero is not to be raised to it: south,
// north, west, east. Death Valley; the Salton Sea and the Imperial and Mexicali valleys; New Orleans behind its
// levees; Lake Enriquillo in the Dominican Republic.
const BELOW_SEA = [[35.6, 36.9, -117.4, -116.4], [32.0, 33.7, -116.3, -114.9], [29.8, 30.15, -90.3, -89.85], [18.3, 18.65, -72.0, -71.3]];

/** Work in the region a job was made for. (On the main thread this changes nothing.) */
export function inRegion(region) {
  if (REGION.lat0 !== region[0] || REGION.lon0 !== region[1]) setRegion(region[0], region[1]);
}

/**
 * Returns { tex, pos, morph, lay, lo, hi, trees }: the layer of the data texture (normal xz, curvature, water),
 * the vertex positions, the geomorphing attribute, the layer attribute, the lowest and highest vertex, and the
 * patch's trees (treeplace.placeFine) or null.
 */
export function buildPatch(job) {
  const { x0, z0, size, zoom, flats, layer } = job, step = size / (TN - 1);
  inRegion(job.region);
  sampleWindow(job.win, x0 - step, z0 - step, step, GN, H, W);
  if (flats.length) {
    for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
      const k = j * GN + i, x = x0 + (i - 1) * step, z = z0 + (j - 1) * step;
      H[k] = applyFlats(flats, x, z, H[k]);
      if (W[k]) W[k] *= 1 - flatWeight(flats, x, z);
    }
  }
  if (job.towny) {
    // Under big cities the survey has dead-level patches that are not water (see water.js): in built-up
    // country a level patch with no banks is dropped.
    for (let k = 0; k < GN * GN; k++) {
      if (!W[k]) continue;
      const x = x0 + ((k % GN) - 1) * step, z = z0 + (Math.floor(k / GN) - 1) * step;
      if (urbanAt(job.urban, x, z) > URBAN && doubtfulIn(job.doubt, x, z)) W[k] = 0;
    }
  }
  if (zoom <= 10) {
    // Coarse data: the sea floor is negative. Level it.
    for (let k = 0; k < GN * GN; k++) if (H[k] < 0) { H[k] = 0; W[k] = 255; }
  } else {
    // Some fine data has the sea floor in it too (Hawaii's survey goes out over the reef). The water is drawn on the
    // ground, so there it lay a few meters down on the bottom and ran up the beach as a sheet over the sand, stepped
    // wherever the depths changed. The sea's surface is at zero: water below it is put there. Not in the basins
    // that really are below the sea, where what lies under zero is dry land or a lake at its own level.
    const ll = toLatLon(x0 + size / 2, z0 + size / 2);
    if (!BELOW_SEA.some((b) => ll.lat > b[0] && ll.lat < b[1] && ll.lon > b[2] && ll.lon < b[3])) {
      for (let k = 0; k < GN * GN; k++) if (W[k] && H[k] < 0) H[k] = 0;
    }
  }
  // The Great Lakes. The survey levels each of its quadrangles on its own (up to 4 m apart on Superior) and the
  // coarse tiles use another datum (4 m lower), so far out the water showed straight steps along the seams, gone
  // again close in. Water within a few meters of a lake's level is put at that one level, at every zoom.
  {
    const ll = toLatLon(x0 + size / 2, z0 + size / 2), near = GREAT_LAKES.filter((l) => ll.lat > l[1] - 0.6 && ll.lat < l[2] + 0.6 && ll.lon > l[3] - 0.8 && ll.lon < l[4] + 0.8);
    if (near.length) for (let k = 0; k < GN * GN; k++) {
      if (W[k] < 100) continue;
      let best = 6.5, lev = 0;
      for (const l of near) { const d = Math.abs(H[k] - l[0]); if (d < best) { best = d; lev = l[0]; } }
      if (lev) H[k] = lev;
    }
  }

  // Data texture layer: normal (xz), curvature, water.
  const tex = new Uint8Array(TN * TN * 4), inv = 1 / (2 * step);
  for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const c = (j + 1) * GN + i + 1, o = (j * TN + i) * 4, h = H[c];
    let nx = -(H[c + 1] - H[c - 1]) * inv, nz = -(H[c + GN] - H[c - GN]) * inv;
    const l = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    nx *= l; nz *= l;
    if (W[c] > 127) { nx = 0; nz = 0; }
    const curv = (H[c - 1] + H[c + 1] + H[c - GN] + H[c + GN] - 4 * h) / (4 * step);
    tex[o] = nx * 127.5 + 127.5; tex[o + 1] = nz * 127.5 + 127.5;
    tex[o + 2] = Math.max(0, Math.min(255, 127.5 - curv * 190)); tex[o + 3] = W[c];
  }

  const count = VERTS, pos = new Float32Array(count * 3), half = size / 2, vs = size / N;
  let lo = 1e9, hi = -1e9;
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
    const o = (j * V + i) * 3, y = H[(j * SUB + 1) * GN + i * SUB + 1];
    pos[o] = i * vs - half; pos[o + 1] = y; pos[o + 2] = j * vs - half;
    if (y < lo) lo = y; if (y > hi) hi = y;
  }
  const skirt = size * 0.05 + 6, edge = [(k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N];
  for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
    const s = edge[e](k) * 3, d = (V * V + e * V + k) * 3;
    pos[d] = pos[s]; pos[d + 1] = pos[s + 1] - skirt; pos[d + 2] = pos[s + 2];
  }
  // What the parent's mesh has at each of these vertices (see the note on geomorphing in chunks.js): its own
  // vertices at every second one, the middle of one of its edges or of a cell's diagonal at the others.
  const morph = new Float32Array(count * 4), par = job.parent;
  if (par) {
    const pp = par.h, ox = (job.quarter & 1) * (N / 2), oz = (job.quarter >> 1) * (N / 2);
    const ph = (i, j) => pp[j * V + i], end = par.end;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const pi = ox + (i >> 1), pj = oz + (j >> 1), o = (j * V + i) * 4;
      // (a cell is cut along the diagonal from its (i, j + 1) corner to its (i + 1, j) corner: see makeIndex)
      morph[o] = (i & 1) ? ((j & 1) ? 0.5 * (ph(pi + 1, pj) + ph(pi, pj + 1)) : 0.5 * (ph(pi, pj) + ph(pi + 1, pj))) : ((j & 1) ? 0.5 * (ph(pi, pj) + ph(pi, pj + 1)) : ph(pi, pj));
      morph[o + 1] = par.layer; morph[o + 2] = end; morph[o + 3] = par.midY;
    }
    for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
      const s4 = edge[e](k) * 4, d4 = (V * V + e * V + k) * 4;
      morph[d4] = morph[s4] - skirt; morph[d4 + 1] = par.layer; morph[d4 + 2] = end; morph[d4 + 3] = par.midY;
    }
  } else for (let i = 0; i < count; i++) morph[i * 4] = pos[i * 3 + 1];
  const lay = new Float32Array(count).fill(layer);

  let trees = null;
  if (job.trees && hi > 2) {
    const t = job.trees;
    trees = placeFine(t.P, x0, z0, H, W, GN, step, flats, { m: t.m, tl: t.tl, sea: t.sea, towny: t.towny, urban: job.urban });
  }
  return { tex, pos, morph, lay, lo, hi, trees };
}

/** The buffers of a result (or of a job's windows), for handing between threads without copying. */
export function buffersOf(o, out = []) {
  for (const k in o) {
    const v = o[k];
    if (!v || typeof v !== 'object') continue;
    if (ArrayBuffer.isView(v)) { if (!out.includes(v.buffer)) out.push(v.buffer); } else if (!Array.isArray(v)) buffersOf(v, out);
  }
  return out;
}
