// Tiling 3D noise volume used for cloud shapes. Generated once on the CPU so
// the renderer (as a 3D texture) and the flight model (is the aircraft inside
// cloud?) sample exactly the same field.
//   R: Perlin-Worley base shape, histogram-equalised so a coverage threshold of
//      c covers a fraction c of the sky
//   G: fine Worley billows for edge erosion
//   B: wispy Perlin for cirrus

import { mulberry32 } from '../core/noise.js';

export const NOISE_SIZE = 64;

export function makeCloudNoise() {
  const S = NOISE_SIZE, rnd = mulberry32(4242);
  const perm = new Uint8Array(512);
  { const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
  const GR = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (x, y, z, P, seed) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const g = (i, j, k) => {
      const gr = GR[perm[perm[perm[((xi + i) % P) + seed] + ((yi + j) % P)] + ((zi + k) % P)] % 12];
      return gr[0] * (xf - i) + gr[1] * (yf - j) + gr[2] * (zf - k);
    };
    const a = g(0, 0, 0) + (g(1, 0, 0) - g(0, 0, 0)) * u, b = g(0, 1, 0) + (g(1, 1, 0) - g(0, 1, 0)) * u;
    const c = g(0, 0, 1) + (g(1, 0, 1) - g(0, 0, 1)) * u, d = g(0, 1, 1) + (g(1, 1, 1) - g(0, 1, 1)) * u;
    return (a + (b - a) * v) + ((c + (d - c) * v) - (a + (b - a) * v)) * w;
  };
  const worleyTable = (f) => { const t = new Float32Array(f * f * f * 3); for (let i = 0; i < t.length; i++) t[i] = rnd(); return t; };
  const worley = (x, y, z, f, tab) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j, cz = zi + k;
      const o = ((((cz % f) + f) % f) * f * f + (((cy % f) + f) % f) * f + (((cx % f) + f) % f)) * 3;
      const dx = cx + tab[o] - x, dy = cy + tab[o + 1] - y, dz = cz + tab[o + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const w4 = worleyTable(4), w8 = worleyTable(8), w16 = worleyTable(16);

  const data = new Uint8Array(S * S * S * 4);
  const base = new Float32Array(S * S * S);
  let o = 0;
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++, o++) {
    const u = x / S, v = y / S, w = z / S;
    const pf = perlin(u * 4, v * 4, w * 4, 4, 0) + 0.5 * perlin(u * 8, v * 8, w * 8, 8, 31) + 0.25 * perlin(u * 16, v * 16, w * 16, 16, 67);
    const wa = worley(u * 4, v * 4, w * 4, 4, w4), wb = worley(u * 8, v * 8, w * 8, 8, w8), wc = worley(u * 16, v * 16, w * 16, 16, w16);
    base[o] = pf * 0.62 + wa * 0.55 + wb * 0.2;
    data[o * 4 + 1] = Math.min(255, (wb * 0.6 + wc * 0.4) * 300);
    const pb = perlin(u * 8, v * 8, w * 8, 8, 101) + 0.5 * perlin(u * 16, v * 16, w * 16, 16, 143);
    data[o * 4 + 2] = Math.max(0, Math.min(255, (0.5 + pb * 0.6) * 255));
    data[o * 4 + 3] = 255;
  }
  // Histogram-equalise the base channel to a uniform distribution.
  const order = new Uint32Array(base.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => base[a] - base[b]);
  for (let r = 0; r < order.length; r++) data[order[r] * 4] = Math.floor((r / order.length) * 256);
  return data;
}

/** Trilinear, tiling sample of one channel; coordinates in tile units. Returns 0..1. */
export function sampleNoise(data, x, y, z, ch) {
  const S = NOISE_SIZE, M = S - 1;
  const fx = (x - Math.floor(x)) * S - 0.5, fy = (y - Math.floor(y)) * S - 0.5, fz = (z - Math.floor(z)) * S - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const u = fx - x0, v = fy - y0, w = fz - z0;
  const xa = x0 & M, xb = (x0 + 1) & M, ya = (y0 & M) * S, yb = ((y0 + 1) & M) * S, za = (z0 & M) * S * S, zb = ((z0 + 1) & M) * S * S;
  const g = (i) => data[i * 4 + ch];
  const c00 = g(za + ya + xa) * (1 - u) + g(za + ya + xb) * u, c10 = g(za + yb + xa) * (1 - u) + g(za + yb + xb) * u;
  const c01 = g(zb + ya + xa) * (1 - u) + g(zb + ya + xb) * u, c11 = g(zb + yb + xa) * (1 - u) + g(zb + yb + xb) * u;
  return ((c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w) / 255;
}
