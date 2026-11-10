// Seeded noise primitives shared by terrain, weather and turbulence.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const GX = [1, -1, 1, -1, 1, -1, 0, 0], GY = [1, 1, -1, -1, 0, 0, 1, -1];

/** 2D simplex noise, roughly in [-1, 1]. */
export function makeSimplex2(seed) {
  const rnd = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return function (x, y) {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let a = 0.5 - x0 * x0 - y0 * y0;
    if (a > 0) { const g = perm[ii + perm[jj]] & 7; a *= a; n += a * a * (GX[g] * x0 + GY[g] * y0); }
    a = 0.5 - x1 * x1 - y1 * y1;
    if (a > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; a *= a; n += a * a * (GX[g] * x1 + GY[g] * y1); }
    a = 0.5 - x2 * x2 - y2 * y2;
    if (a > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; a *= a; n += a * a * (GX[g] * x2 + GY[g] * y2); }
    return 70 * n;
  };
}

export function fbm(n, x, y, oct, lac = 2, gain = 0.5) {
  let a = 1, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * n(x * f, y * f); norm += a; a *= gain; f *= lac; }
  return s / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests, good for mountain ranges. */
export function ridged(n, x, y, oct) {
  let a = 1, f = 1, s = 0, norm = 0, prev = 1;
  for (let i = 0; i < oct; i++) {
    let v = 1 - Math.abs(n(x * f, y * f));
    v *= v;
    s += v * a * prev; norm += a;
    prev = v; a *= 0.5; f *= 2.07;
  }
  return s / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smooth 1D value noise for gusts; returns [-1, 1]. */
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i;
  const h = (k) => {
    let x = Math.imul(k + seed * 7919, 0x27d4eb2d); x ^= x >>> 15;
    x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13;
    return ((x >>> 0) / 2147483648) - 1;
  };
  const u = f * f * (3 - 2 * f);
  return h(i) + (h(i + 1) - h(i)) * u;
}
