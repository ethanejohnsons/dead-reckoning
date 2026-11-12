// Tiling noise volumes for cloud shapes.
//
// The shapes are built as a ladder of octaves a factor of two apart, from kilometres down to a few
// metres, and no one texture can hold that: a 128^3 volume resolves four octaves (4, 8, 16 and 32
// cells to the tile). So there are two volumes, and the renderer reads the second one at more than
// one scale and rotation (see LOBE_SCALE / FINE_SCALE in weather.js).
//
// makeCloudNoise()  128^3 RGBA base volume, shared by the renderer (3D texture) and the flight
//                   model (is the aircraft inside cloud?):
//   R: Perlin-Worley shape, octaves at 4, 8, 16, 32 cells, histogram-equalised so that a coverage
//      threshold of c covers a fraction c of the sky
//   G: cellular (round Worley billows at 8, 16, 32 cells), equalised
//   B: wispy Perlin (8, 16 cells) for cirrus, fibres and the bend of the sampling domain
//   A: very low frequency Perlin (2, 4 cells), equalised: slow variation
//   .detail: the detail volume below (made on first use), so the flight model can reach it too
// makeDetailNoise() 128^3 RGBA lobe volume, every channel equalised (mean 0.5):
//   R: billows, low (4, 8 cells): round heads with sharp creases between   G: billows, high (16, 32)
//   B: wisps, low (4, 8, 16): ragged shreds (plain gradient noise)          A: wisps, high (16, 32): fibres (broad ridges, unbent)
// makeCurlNoise()   128^2 RGBA 2D curl field (RG coarse, BA fine). Only the high cloud reads it now, to
//                   bend its bands a little; the cloud volumes are no longer stirred with it
//
// Speed: nothing is evaluated voxel by voxel at 128^3. Each octave is made on a grid of at most
// 64^3 with eight (or four) texels to the cell, then either magnified (low octaves) or tiled twice
// (high octaves, which then repeat at half the tile: under the low octaves that never shows).

import { mulberry32 } from '../core/noise.js';

export const NOISE_SIZE = 128;
export const DETAIL_SIZE = 128;
export const CURL_SIZE = 128;

const GR = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tiling gradient noise on an S^3 grid, f cells to the side: about [-1, 1]. */
function perlinGrid(S, f, rnd) {
  const cs = S / f, out = new Float32Array(S * S * S), g = new Uint8Array(f * f * f);
  for (let i = 0; i < g.length; i++) g[i] = (rnd() * 12) | 0;
  const t = new Float32Array(cs), u = new Float32Array(cs);
  for (let i = 0; i < cs; i++) { t[i] = (i + 0.5) / cs; u[i] = fade(t[i]); }
  const gx = new Float32Array(8), gy = new Float32Array(8), gz = new Float32Array(8);
  for (let cz = 0; cz < f; cz++) for (let cy = 0; cy < f; cy++) for (let cx = 0; cx < f; cx++) {
    for (let k = 0; k < 8; k++) {
      const v = GR[g[(((cz + (k >> 2)) % f) * f + ((cy + ((k >> 1) & 1)) % f)) * f + ((cx + (k & 1)) % f)]];
      gx[k] = v[0]; gy[k] = v[1]; gz[k] = v[2];
    }
    for (let k = 0; k < cs; k++) {
      const z = t[k], w = u[k];
      for (let j = 0; j < cs; j++) {
        const y = t[j], v = u[j];
        let o = ((cz * cs + k) * S + cy * cs + j) * S + cx * cs;
        for (let i = 0; i < cs; i++, o++) {
          const x = t[i], uu = u[i], x1 = x - 1, y1 = y - 1, z1 = z - 1;
          const a = gx[0] * x + gy[0] * y + gz[0] * z, b = gx[1] * x1 + gy[1] * y + gz[1] * z;
          const c = gx[2] * x + gy[2] * y1 + gz[2] * z, d = gx[3] * x1 + gy[3] * y1 + gz[3] * z;
          const e = gx[4] * x + gy[4] * y + gz[4] * z1, ff = gx[5] * x1 + gy[5] * y + gz[5] * z1;
          const gg = gx[6] * x + gy[6] * y1 + gz[6] * z1, h = gx[7] * x1 + gy[7] * y1 + gz[7] * z1;
          const ab = a + (b - a) * uu, cd = c + (d - c) * uu, ef = e + (ff - e) * uu, gh = gg + (h - gg) * uu;
          const lo = ab + (cd - ab) * v, hi = ef + (gh - ef) * v;
          out[o] = lo + (hi - lo) * w;
        }
      }
    }
  }
  return out;
}

/**
 * Tiling cellular noise on an S^3 grid, f cells to the side, as a billow: 1 at a feature point,
 * falling as the square of the distance to 0 one cell away, so each cell is a round head and the
 * cells meet in sharp creases (the plain distance gives cones).
 */
function billowGrid(S, f, rnd) {
  const cs = S / f, n = f * f * f, pts = new Float32Array(n * 3), out = new Float32Array(S * S * S);
  for (let i = 0; i < n * 3; i++) pts[i] = rnd() * cs - 0.5;
  const px = new Float32Array(27), py = new Float32Array(27), pz = new Float32Array(27), inv = 1 / (cs * cs);
  for (let cz = 0; cz < f; cz++) for (let cy = 0; cy < f; cy++) for (let cx = 0; cx < f; cx++) {
    let m = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, m++) {
      const o = ((((cz + dz + f) % f) * f + ((cy + dy + f) % f)) * f + ((cx + dx + f) % f)) * 3;
      px[m] = dx * cs + pts[o]; py[m] = dy * cs + pts[o + 1]; pz[m] = dz * cs + pts[o + 2];
    }
    for (let k = 0; k < cs; k++) for (let j = 0; j < cs; j++) {
      let o = ((cz * cs + k) * S + cy * cs + j) * S + cx * cs;
      for (let i = 0; i < cs; i++, o++) {
        let best = 1e9;
        for (let q = 0; q < 27; q++) {
          const ax = i - px[q], ay = j - py[q], az = k - pz[q], d = ax * ax + ay * ay + az * az;
          if (d < best) best = d;
        }
        out[o] = 1 - Math.min(1, best * inv);
      }
    }
  }
  return out;
}

/** Magnify a tiling S^3 field k times (linear interpolation, one axis at a time). */
function magnify(src, S, k) {
  const D = S * k;
  const i0 = new Int32Array(D), i1 = new Int32Array(D), w = new Float32Array(D);
  for (let i = 0; i < D; i++) { const f = (i + 0.5) / k - 0.5, b = Math.floor(f); i0[i] = (b + S) % S; i1[i] = (b + 1) % S; w[i] = f - b; }
  const a = new Float32Array(D * S * S);                      // x
  for (let z = 0, o = 0; z < S; z++) for (let y = 0; y < S; y++) { const r = (z * S + y) * S; for (let x = 0; x < D; x++, o++) { const p = src[r + i0[x]]; a[o] = p + (src[r + i1[x]] - p) * w[x]; } }
  const b = new Float32Array(D * D * S);                      // y
  for (let z = 0, o = 0; z < S; z++) for (let y = 0; y < D; y++) { const r0 = (z * S + i0[y]) * D, r1 = (z * S + i1[y]) * D, t = w[y]; for (let x = 0; x < D; x++, o++) { const p = a[r0 + x]; b[o] = p + (a[r1 + x] - p) * t; } }
  const c = new Float32Array(D * D * D);                      // z
  for (let z = 0, o = 0; z < D; z++) { const r0 = i0[z] * D * D, r1 = i1[z] * D * D, t = w[z]; for (let q = 0; q < D * D; q++, o++) { const p = b[r0 + q]; c[o] = p + (b[r1 + q] - p) * t; } }
  return c;
}

/** dst (D^3) += w * src (S^3) tiled D / S times, shifted by (ox, oy, oz) texels. */
function addTiled(dst, D, src, S, w, ox = 0, oy = 0, oz = 0) {
  const M = S - 1;
  for (let z = 0, o = 0; z < D; z++) for (let y = 0; y < D; y++) {
    const r = (((z + oz) & M) * S + ((y + oy) & M)) * S;
    for (let x = 0; x < D; x++, o++) dst[o] += w * src[r + ((x + ox) & M)];
  }
}
function addScaled(dst, src, w) { for (let i = 0; i < dst.length; i++) dst[i] += w * src[i]; return dst; }

/** A field with its axes cycled (x -> y -> z -> x): the same grid, read so that it shares no pattern with its first use. */
function cycled(src, S) {
  const out = new Float32Array(src.length);
  for (let z = 0, o = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++, o++) out[o] = src[(x * S + z) * S + y];
  return out;
}

/** Map a float field to bytes with a flat histogram, written to data[i * stride + ch]. */
function equalise(field, data, stride, ch) {
  const lut = equaliser(field);
  for (let i = 0; i < field.length; i++) data[i * stride + ch] = lut.map[((field[i] - lut.lo) * lut.k) | 0];
}
function equaliser(field) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < field.length; i++) { const v = field[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const B = 16384, hist = new Uint32Array(B + 1), k = (B - 1) / Math.max(hi - lo, 1e-9);
  for (let i = 0; i < field.length; i++) hist[((field[i] - lo) * k) | 0]++;
  let acc = 0;
  const map = new Uint8Array(B + 1);
  for (let b = 0; b <= B; b++) { map[b] = Math.min(255, Math.floor(((acc + hist[b] * 0.5) / field.length) * 256)); acc += hist[b]; }
  return { lo, k, map };
}
/** The same, in place, to floats 0..1. */
function equalised(field) {
  const lut = equaliser(field);
  for (let i = 0; i < field.length; i++) field[i] = lut.map[((field[i] - lut.lo) * lut.k) | 0] / 255;
  return field;
}

const GAIN = 0.6;                    // amplitude of each octave against the one below it
let shared = null;                   // octave grids the two volumes share (dropped once both are built)
function grids() {
  if (shared) return shared;
  const rnd = mulberry32(4242);
  return (shared = { rnd, b8: billowGrid(64, 8, rnd), b8t: billowGrid(64, 8, rnd), b16t: billowGrid(64, 16, rnd) });
}

let detailData = null;

export function makeCloudNoise() {
  const S = NOISE_SIZE, N = S * S * S, G = grids(), rnd = mulberry32(977), g = GAIN;
  const data = new Uint8Array(N * 4);
  // R: the shape. Perlin gives the connected, drifting masses; billows give them round heads.
  const l32 = addScaled(addScaled(new Float32Array(32 * 32 * 32), perlinGrid(32, 4, rnd), 1), billowGrid(32, 4, rnd), 1);
  const l64 = addScaled(addScaled(new Float32Array(64 * 64 * 64), perlinGrid(64, 8, rnd), g), G.b8, g);
  const t64 = addScaled(addScaled(addScaled(addScaled(new Float32Array(64 * 64 * 64), perlinGrid(64, 8, rnd), g * g), G.b8t, g * g), perlinGrid(64, 16, rnd), g * g * g), G.b16t, g * g * g);
  const shape = magnify(l32, 32, 4);
  addScaled(shape, magnify(l64, 64, 2), 1);
  addTiled(shape, S, t64, 64, 1);
  equalise(shape, data, 4, 0);
  // G: cells alone.
  const cell = magnify(G.b8, 64, 2);
  addTiled(cell, S, addScaled(addScaled(new Float32Array(64 * 64 * 64), G.b8t, g), G.b16t, g * g), 64, 1, 23, 41, 11);
  equalise(cell, data, 4, 1);
  // B: wisps.
  const wisp = magnify(addScaled(perlinGrid(64, 8, rnd), perlinGrid(64, 16, rnd), 0.5), 64, 2);
  for (let i = 0; i < N; i++) data[i * 4 + 2] = Math.max(0, Math.min(255, (0.5 + wisp[i] * 0.6) * 255));
  // A: slow.
  equalise(magnify(addScaled(perlinGrid(32, 2, rnd), perlinGrid(32, 4, rnd), 0.5), 32, 4), data, 4, 3);
  Object.defineProperty(data, 'detail', { get: makeDetailNoise });
  return data;
}

export function makeDetailNoise() {
  if (detailData) return detailData;
  const S = DETAIL_SIZE, N = S * S * S, H = 64, HN = H * H * H, G = grids(), rnd = mulberry32(31), g = GAIN;
  const data = new Uint8Array(N * 4);
  const put = (field, ch) => { for (let i = 0; i < N; i++) data[i * 4 + ch] = Math.min(255, field[i] * 256); };
  // Billows: low octaves magnified, high octaves tiled twice. (The grids are the base volume's, with their axes cycled.)
  put(magnify(equalised(addScaled(addScaled(new Float32Array(HN), billowGrid(H, 4, rnd), 1), cycled(G.b8, H), g)), H, 2), 0);
  const hi = new Float32Array(N);
  addTiled(hi, S, equalised(addScaled(addScaled(new Float32Array(HN), cycled(G.b8t, H), 1), cycled(G.b16t, H), g)), H, 1);
  put(hi, 1);
  // Wisps: what is left of cloud that is evaporating. Its large pieces are ragged shreds with no grain to
  // them (plain gradient noise, three octaves); only its fine pieces are fibrous (broad ridges of gradient
  // noise, half and half with the plain kind, so the fibres do not join up into veins). Neither is read
  // through a bent domain: bent ridges are curls, and curls a few hundred metres across on the underside
  // of a cloud are marbled paper, not cloud.
  const shreds = equalised(addScaled(addScaled(perlinGrid(H, 4, rnd), perlinGrid(H, 8, rnd), g), perlinGrid(H, 16, rnd), g * g));
  put(magnify(shreds, H, 2), 2);
  const fibres = (fa, fb) => {
    const a = perlinGrid(H, fa, rnd), b = perlinGrid(H, fb, rnd), p = addScaled(perlinGrid(H, fa, rnd), perlinGrid(H, fb, rnd), g), out = new Float32Array(HN);
    for (let o = 0; o < HN; o++) out[o] = 1 - Math.min(1, Math.abs(a[o]) * 2.2) + g * (1 - Math.min(1, Math.abs(b[o]) * 2.2)) + 1.1 * p[o];
    return equalised(out);
  };
  const wh = new Float32Array(N);
  addTiled(wh, S, fibres(8, 16), H, 1);
  put(wh, 3);
  shared = null;
  return (detailData = data);
}

/** Tiling 2D gradient noise on an S^2 grid, f cells to the side. */
function perlin2(S, f, rnd) {
  const cs = S / f, out = new Float32Array(S * S), ang = new Float32Array(f * f);
  for (let i = 0; i < ang.length; i++) ang[i] = rnd() * 6.2832;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x + 0.5) / cs, fy = (y + 0.5) / cs, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
    const d = (i, j) => { const a = ang[((y0 + j) % f) * f + ((x0 + i) % f)]; return Math.cos(a) * (u - i) + Math.sin(a) * (v - j); };
    const a = d(0, 0), b = d(1, 0), c = d(0, 1), e = d(1, 1), su = fade(u), sv = fade(v);
    out[y * S + x] = (a + (b - a) * su) * (1 - sv) + (c + (e - c) * su) * sv;
  }
  return out;
}

let curlData = null;
export function makeCurlNoise() {
  if (curlData) return curlData;
  const S = CURL_SIZE, rnd = mulberry32(31337), M = S - 1;
  // The curl of a scalar potential, (d/dy, -d/dx), is divergence-free, so it swirls instead of bunching.
  const pa = addScaled(perlin2(S, 4, rnd), perlin2(S, 8, rnd), 0.5), pb = addScaled(perlin2(S, 12, rnd), perlin2(S, 24, rnd), 0.5);
  const data = new Uint8Array(S * S * 4);
  const enc = (v) => Math.max(0, Math.min(255, Math.round((0.5 + v * 0.5) * 255)));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    const c = (p, k) => [(p[((y + 1) & M) * S + x] - p[((y - 1) & M) * S + x]) * k, -(p[y * S + ((x + 1) & M)] - p[y * S + ((x - 1) & M)]) * k];
    const a = c(pa, S / 15), b = c(pb, S / 44);
    data[o] = enc(a[0]); data[o + 1] = enc(a[1]); data[o + 2] = enc(b[0]); data[o + 3] = enc(b[1]);
  }
  return (curlData = data);
}

/** Bilinear, tiling sample of the curl field; coordinates in tile units. Writes four values, each about -0.5..0.5, to out. */
export function sampleCurl(x, y, out) {
  const data = makeCurlNoise(), S = CURL_SIZE, M = S - 1;
  const fx = (x - Math.floor(x)) * S - 0.5, fy = (y - Math.floor(y)) * S - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
  const a = ((y0 & M) * S + (x0 & M)) * 4, b = ((y0 & M) * S + ((x0 + 1) & M)) * 4, c = (((y0 + 1) & M) * S + (x0 & M)) * 4, d = (((y0 + 1) & M) * S + ((x0 + 1) & M)) * 4;
  for (let k = 0; k < 4; k++) out[k] = ((data[a + k] * (1 - u) + data[b + k] * u) * (1 - v) + (data[c + k] * (1 - u) + data[d + k] * u) * v) / 255 - 0.5;
  return out;
}

/** Trilinear, tiling sample of one channel of either volume; coordinates in tile units. Returns 0..1. */
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
