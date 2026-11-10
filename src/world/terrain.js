// The world of Dead Reckoning: a fictional continent ~400 km across.
// Everything here is a pure function of (x, z) so physics, charts, weather
// and rendering all agree. Coordinates: +X east, +Z south, +Y up, metres.

import { makeSimplex2, fbm, ridged, clamp, smoothstep } from '../core/noise.js';

export const WORLD_HALF = 262144; // quadtree root + weather map half extent
export const LAND_HALF = 215000;  // charted area half extent

const nWarp = makeSimplex2(11), nCont = makeSimplex2(23), nSpine = makeSimplex2(37),
  nMask = makeSimplex2(41), nRidge = makeSimplex2(53), nHill = makeSimplex2(67),
  nDet = makeSimplex2(71), nClim = makeSimplex2(83), nFor = makeSimplex2(97);

// Offshore islands (km): x, z, radius
const ISLANDS = [[24, 176, 9], [-98, 156, 11], [-176, 96, 6], [168, -128, 8], [118, 168, 6]];

/** East-west position (km) of the main mountain spine at a given latitude. */
export function spineX(Z) {
  return -28 + 42 * Math.sin(Z / 80 + 0.6) + 20 * nSpine(Z / 75, 3.3);
}

function continent(X, Z) {
  const wx = X + 32 * nWarp(X / 150, Z / 150), wz = Z + 32 * nWarp(X / 150 + 40, Z / 150 - 17);
  const ex = wx / 168, ez = (wz + 18) / 148;
  const r = Math.sqrt(ex * ex + ez * ez);
  let c = (1 - r) + 0.2 * fbm(nCont, X / 75, Z / 75, 4);
  for (let i = 0; i < ISLANDS.length; i++) {
    const is = ISLANDS[i];
    const dx = X - is[0], dz = Z - is[1];
    const d2 = (dx * dx + dz * dz) / (2 * is[2] * is[2]);
    if (d2 < 6) {
      const ci = 0.5 * Math.exp(-d2) - 0.09 + 0.07 * nCont(X / 14, Z / 14);
      if (ci > c) c = ci;
    }
  }
  return c;
}

/** Natural terrain height before airports are graded in. lod>0 skips fine detail. */
export function rawHeight(x, z, lod = 0) {
  const X = x * 0.001, Z = z * 0.001;
  const c = continent(X, Z);
  if (c < 0) return Math.max(-450, c * 900);

  const land = smoothstep(0, 0.1, c);
  const inland = smoothstep(0.02, 0.45, c);
  let h = c * 60 + inland * 240;

  // Mountain masks: main N-S spine, a northern E-W range, scattered massifs.
  const dsp = (X - spineX(Z)) / 34;
  let m = Math.exp(-dsp * dsp);
  const dn = (Z + 122 + 14 * nSpine(X / 60, 9.1)) / 22;
  m = Math.max(m, 0.7 * Math.exp(-dn * dn));
  m = Math.max(m, 0.55 * smoothstep(0.25, 0.8, nMask(X / 85 + 5, Z / 85)));
  m *= smoothstep(0.03, 0.3, c);
  if (m > 0.002) {
    const rg = ridged(nRidge, X / 26, Z / 26, lod ? 4 : 6);
    h += m * (450 + 3300 * Math.pow(rg, 1.25));
  }

  const hl = fbm(nHill, X / 11, Z / 11, lod ? 3 : 5) * 0.5 + 0.5;
  const hillAmt = 0.3 + 0.7 * smoothstep(-0.3, 0.5, nMask(X / 60 - 8, Z / 60 + 3));
  h += land * (1 - 0.6 * m) * hillAmt * 280 * hl * hl;

  if (!lod) {
    h += land * (0.25 + m) * 26 * fbm(nDet, X / 1.4, Z / 1.4, 3);
    h += land * (0.3 + m) * 2.5 * nDet(X / 0.11, Z / 0.11);
  }
  return h;
}

// Airports grade the terrain flat around their runways.
let FLATS = [];
export function setFlats(list) { FLATS = list; groundCache.clear(); }

export function height(x, z, lod = 0) {
  let h = rawHeight(x, z, lod);
  for (let i = 0; i < FLATS.length; i++) {
    const f = FLATS[i];
    const dx = x - f.x, dz = z - f.z;
    if (dx > f.R || dx < -f.R || dz > f.R || dz < -f.R) continue;
    const t = clamp(dx * f.ux + dz * f.uz, -f.half, f.half);
    const px = dx - t * f.ux, pz = dz - t * f.uz;
    const w = 1 - smoothstep(f.r0, f.r1, Math.sqrt(px * px + pz * pz));
    if (w > 0) h += (f.elev - h) * w;
  }
  return h;
}

// Physics samples the same 16 m lattice the finest terrain mesh uses.
const CELL = 16;
const groundCache = new Map();
function lattice(ix, iz) {
  const key = ix * 131071 + iz;
  let h = groundCache.get(key);
  if (h === undefined) {
    if (groundCache.size > 6000) groundCache.clear();
    h = height(ix * CELL, iz * CELL);
    groundCache.set(key, h);
  }
  return h;
}
export function groundHeight(x, z) {
  const fx = x / CELL, fz = z / CELL;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const u = fx - ix, v = fz - iz;
  const a = lattice(ix, iz), b = lattice(ix + 1, iz), c = lattice(ix, iz + 1), d = lattice(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

const CL = { tSea: 15, moist: 0.5 };
/** Climate at a point: sea-level temperature (°C) and moisture (0 arid .. 1 wet). */
export function climate(x, z) {
  const X = x * 0.001, Z = z * 0.001;
  const lat = clamp(-(Z + 15) / 165, -1, 1); // +1 far north, -1 tropical south
  CL.tSea = 16 - 14 * lat + 2 * nClim(X / 130, Z / 130);
  const dxs = X - spineX(Z);
  const lee = smoothstep(-25, 45, dxs);
  let moist = 0.52 + 0.28 * fbm(nClim, X / 70 + 9, Z / 70, 2);
  moist += 0.16 * smoothstep(-120, -10, dxs) * (1 - lee) - 0.42 * lee * Math.exp(-Math.max(dxs, 0) / 95);
  moist += 0.2 * smoothstep(40, 140, Z) - 0.1 * smoothstep(0.3, 1, lat);
  CL.moist = clamp(moist, 0, 1);
  return CL;
}

/** 0..1 tree cover; also drives instanced tree placement. */
export function forestDensity(x, z, h, slope, cl = climate(x, z)) {
  const t = cl.tSea - 0.0065 * h;
  const pn = nFor(x / 1700 + 31, z / 1700);
  return smoothstep(0.42, 0.6, cl.moist + pn * 0.16) * smoothstep(-5, 2, t) *
    (1 - smoothstep(0.2, 0.4, slope)) * smoothstep(2, 8, h);
}

const mix3 = (o, r, g, b, t) => { o[0] += (r - o[0]) * t; o[1] += (g - o[1]) * t; o[2] += (b - o[2]) * t; };
const tmp = [0, 0, 0];

/** Surface colour (linear-ish RGB) written to out[o..o+2]. slope = 1 - normal.y */
export function terrainColor(x, z, h, slope, out, o) {
  const cl = climate(x, z);
  const c = tmp;
  if (h <= 0) {
    const d = -h;
    const trop = smoothstep(18, 27, cl.tSea), cold = smoothstep(9, 2, cl.tSea);
    c[0] = 0.10; c[1] = 0.42; c[2] = 0.47;
    mix3(c, 0.08, 0.56, 0.58, trop);
    mix3(c, 0.16, 0.30, 0.34, cold);
    const deep = smoothstep(0, 70, d);
    mix3(c, 0.025 + 0.02 * cold, 0.12 + 0.03 * trop, 0.27 - 0.05 * cold, deep);
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
    return;
  }
  const t = cl.tSea - 0.0065 * h;
  const pn = nFor(x / 900, z / 900);
  const m = clamp(cl.moist + pn * 0.07, 0, 1);

  c[0] = 0.78; c[1] = 0.61; c[2] = 0.40;                         // desert
  mix3(c, 0.56, 0.55, 0.30, smoothstep(0.16, 0.34, m));          // dry grass
  mix3(c, 0.36, 0.50, 0.21, smoothstep(0.34, 0.52, m));          // meadow
  mix3(c, 0.20, 0.42, 0.15, smoothstep(0.55, 0.8, m));           // lush
  mix3(c, 0.40, 0.43, 0.33, smoothstep(6, -1, t) * 0.8);         // tundra

  const f = forestDensity(x, z, h, slope, cl);
  const trop = smoothstep(19, 26, t);
  mix3(c, 0.085 + 0.02 * trop, 0.21 + 0.07 * trop, 0.10, f * 0.9);

  const arid = 1 - smoothstep(0.15, 0.4, m);
  const rock = Math.max(smoothstep(0.16, 0.36, slope), smoothstep(4, -2, t) * 0.6);
  mix3(c, 0.41 + 0.16 * arid, 0.39 + 0.02 * arid, 0.37 - 0.07 * arid, rock);

  const snow = smoothstep(0.5, -3.5, t + pn * 1.6) * (1 - smoothstep(0.42, 0.7, slope));
  mix3(c, 0.93, 0.95, 0.98, snow);

  const beach = smoothstep(5, 1.2, h) * (1 - snow);
  mix3(c, 0.80 - 0.25 * smoothstep(9, 2, cl.tSea), 0.74 - 0.2 * smoothstep(9, 2, cl.tSea), 0.57 - 0.1 * smoothstep(9, 2, cl.tSea), beach);

  out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
}
