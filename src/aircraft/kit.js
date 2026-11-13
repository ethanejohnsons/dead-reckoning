// Building blocks for the procedural aircraft: lofted and swept surfaces, primitives prepared for merging,
// airfoil sections, and canvas-texture helpers. Shared by the airframe (model.js), the cabin (interior.js)
// and the instrument panel (panel.js).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const D2R = Math.PI / 180;
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (t) => Math.max(0, Math.min(1, t));
export const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const lin = (css) => new THREE.Color(css).toArray();
let WHITE = [1, 1, 1];
/** Color given to geometry that does not name one (the airframe sets it to the variant's base paint). */
export function setDefaultRgb(rgb) { WHITE = rgb; }
export const BLANK = [0.986, 0.986];             // texel region with no panel lines, for small parts

// ---------------------------------------------------------------- geometry helpers

/** Monotone cubic interpolation: no overshoot between stations. */
export function pchip(xs, ys) {
  const n = xs.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]));
  m.push(d[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/**
 * Skin a grid of points P[row][col] = [x, y, z, ...extra].
 * closed: columns wrap. Normals come from grid tangents, so strips shade smoothly
 * and strip ends stay sharp. Faces are oriented outward from `inside` (default: the
 * centroid) or along `out`; `flip` turns the surface inside out.
 */
export function loftGrid(P, o = {}) {
  const M = P.length, N = P[0].length, closed = !!o.closed, C = closed ? N + 1 : N;
  const pos = [], nor = [], uv = [], col = [], idx = [], degen = [];
  const at = (i, j) => P[i][closed ? ((j % N) + N) % N : j < 0 ? 0 : j >= N ? N - 1 : j];
  let cx = 0, cy = 0, cz = 0;
  for (const r of P) for (const p of r) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const ins = o.inside || [cx / (M * N), cy / (M * N), cz / (M * N)];
  const rgb = o.rgb || WHITE;
  let orient = 0;
  for (let i = 0; i < M; i++) for (let j = 0; j < C; j++) {
    const p = at(i, j), a = at(Math.min(i + 1, M - 1), j), b = at(Math.max(i - 1, 0), j), c = at(i, j + 1), d = at(i, j - 1);
    const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2], vx = c[0] - d[0], vy = c[1] - d[1], vz = c[2] - d[2];
    let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux, l = Math.hypot(nx, ny, nz);
    const bad = l < 1e-10;
    if (bad) { nx = p[0] - ins[0]; ny = p[1] - ins[1]; nz = p[2] - ins[2]; l = Math.hypot(nx, ny, nz) || 1; }
    nx /= l; ny /= l; nz /= l;
    if (!bad) orient += o.out ? nx * o.out[0] + ny * o.out[1] + nz * o.out[2] : nx * (p[0] - ins[0]) + ny * (p[1] - ins[1]) + nz * (p[2] - ins[2]);
    degen.push(bad);
    pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz);
    const t = o.uv ? o.uv(p, i, j) : [i / (M - 1), j / (C - 1)];
    uv.push(t[0], t[1]);
    const k = o.color ? o.color(p, i, j) : rgb;
    col.push(k[0], k[1], k[2]);
  }
  const sgn = (orient < 0 ? -1 : 1) * (o.flip ? -1 : 1), dsgn = o.flip ? -1 : 1;
  for (let k = 0; k < degen.length; k++) { const s = degen[k] ? dsgn : sgn; nor[k * 3] *= s; nor[k * 3 + 1] *= s; nor[k * 3 + 2] *= s; }
  const V = (k, q) => [q[k * 3], q[k * 3 + 1], q[k * 3 + 2]];
  const facing = (a, b, c, n) => {
    const A = V(a, pos), B = V(b, pos), Cc = V(c, pos);
    const gx = (B[1] - A[1]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[1] - A[1]);
    const gy = (B[2] - A[2]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[2] - A[2]);
    const gz = (B[0] - A[0]) * (Cc[1] - A[1]) - (B[1] - A[1]) * (Cc[0] - A[0]);
    return gx * n[0] + gy * n[1] + gz * n[2];
  };
  for (let i = 0; i < M - 1; i++) for (let j = 0; j < C - 1; j++) {
    const a = i * C + j, b = a + C, c = a + 1, d = b + 1;
    const n = [nor[a * 3] + nor[d * 3], nor[a * 3 + 1] + nor[d * 3 + 1], nor[a * 3 + 2] + nor[d * 3 + 2]];
    let f = facing(a, b, c, n);
    if (Math.abs(f) < 1e-12) f = facing(b, d, c, n);
    if (f >= 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }
  const gridCount = idx.length, caps = {};
  const cap = (i, name) => {
    const r = P[i], nb = P[i === 0 ? 1 : M - 2], m = [0, 0, 0], q = [0, 0, 0];
    for (const p of r) { m[0] += p[0] / N; m[1] += p[1] / N; m[2] += p[2] / N; }
    for (const p of nb) { q[0] += p[0] / N; q[1] += p[1] / N; q[2] += p[2] / N; }
    // Newell normal of the ring, pointed away from the neighboring ring
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < N; j++) { const p = r[j], s = r[(j + 1) % N]; nx += (p[1] - s[1]) * (p[2] + s[2]); ny += (p[2] - s[2]) * (p[0] + s[0]); nz += (p[0] - s[0]) * (p[1] + s[1]); }
    let l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (nx * (m[0] - q[0]) + ny * (m[1] - q[1]) + nz * (m[2] - q[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    if (o.flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = pos.length / 3, start = idx.length, crgb = o.capRgb || null;
    const push = (p, t, k) => { pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz); uv.push(t[0], t[1]); col.push(k[0], k[1], k[2]); };
    const t0 = o.uv ? o.uv(r[0], i, 0) : BLANK, k0 = crgb || (o.color ? o.color(r[0], i, 0) : rgb);
    push(m, o.capUv || t0, k0);
    for (let j = 0; j < N; j++) push(r[j], o.capUv || (o.uv ? o.uv(r[j], i, j) : BLANK), crgb || (o.color ? o.color(r[j], i, j) : rgb));
    for (let j = 0; j < (closed ? N : N - 1); j++) {
      const a = base, b = base + 1 + j, c = base + 1 + ((j + 1) % N);
      if (facing(a, b, c, [nx, ny, nz]) >= 0) idx.push(a, b, c); else idx.push(a, c, b);
    }
    caps[name] = [start, idx.length - start];
  };
  if (o.capStart) cap(0, 'start');
  if (o.capEnd) cap(M - 1, 'end');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.userData = { rowStride: (C - 1) * 6, cols: C, gridCount, caps };
  return g;
}

/** Sweep a 2D section along a path. section: [[a, b], ...] or (t) => that; `a` lies along ref. */
export function sweep(path, section, ref = [0, 0, 1], o = {}) {
  const n = path.length, R = new THREE.Vector3(...ref), T = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3();
  const rings = path.map((p, i) => {
    const a = path[Math.min(i + 1, n - 1)], b = path[Math.max(i - 1, 0)];
    T.set(a[0] - b[0], a[1] - b[1], a[2] - b[2]).normalize();
    A.copy(R).addScaledVector(T, -R.dot(T)).normalize(); B.crossVectors(T, A);
    const sh = typeof section === 'function' ? section(i / (n - 1)) : section;
    return sh.map(([u, v]) => [p[0] + A.x * u + B.x * v, p[1] + A.y * u + B.y * v, p[2] + A.z * u + B.z * v]);
  });
  return loftGrid(rings, { closed: true, capStart: true, capEnd: true, uv: () => BLANK, ...o });
}
export const ellipse = (ra, rb, n = 12) => Array.from({ length: n }, (_, k) => [ra * Math.cos((2 * Math.PI * k) / n), rb * Math.sin((2 * Math.PI * k) / n)]);

const M4 = new THREE.Matrix4(), QT = new THREE.Quaternion(), EU = new THREE.Euler();
/** Prepare a three.js primitive for merging: transform, flat color, blank UV. */
export function prim(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], rgb = WHITE, keepUv = false } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.applyMatrix4(M4.compose(new THREE.Vector3(...pos), QT.setFromEuler(EU.set(...rot)), new THREE.Vector3(...scale)));
  const n = g.attributes.position.count, c = new Float32Array(n * 3), u = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { c.set(rgb, i * 3); u.set(BLANK, i * 2); }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!keepUv || !g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}
export const merge = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false);
/** A rod between two points (capsule), for limbs, links and antennas. */
export function rod(a, b, r, rgb, seg = 8) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), len = va.distanceTo(vb);
  const g = prim(new THREE.CapsuleGeometry(r, len, 3, seg), { rgb });
  QT.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyMatrix4(M4.compose(va.add(vb).multiplyScalar(0.5), QT, new THREE.Vector3(1, 1, 1)));
  return g;
}

// ---------------------------------------------------------------- airfoils

/** NACA 4-digit style section: upper and lower surface height at chord fraction x. */
export function foil(x, t, m = 0.02, p = 0.4) {
  const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const yc = m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x);
  return [yc + yt, yc - yt];
}
/** Section loop [xc, yc, upper] from xb over the top to xa and back underneath. */
export function foilPts(t, m, xa, xb, n, nose = 0) {
  const pts = [];
  for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * (0.5 + 0.5 * Math.cos((Math.PI * k) / n)); pts.push([x, foil(x, t, m)[0], 1]); }
  if (nose) { const [u, l] = foil(xa, t, m); pts.push([xa - nose, (u + l) / 2, 0]); }
  for (let k = 0; k <= n; k++) { const x = xa + (xb - xa) * (0.5 - 0.5 * Math.cos((Math.PI * k) / n)); pts.push([x, foil(x, t, m)[1], 0]); }
  return pts;
}

export function canvas(w, h, fill) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (fill) { g.fillStyle = fill; g.fillRect(0, 0, w, h); }
  return [c, g];
}
export const rough = (v) => `rgb(0,${Math.round(v * 255)},0)`;

export function normalFromHeight(src, strength) {
  const w = src.width, h = src.height, s = src.getContext('2d').getImageData(0, 0, w, h).data;
  const [out, g] = canvas(w, h), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y, yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const dx = (s[(y * w + ((x + 1) % w)) * 4] - s[(y * w + ((x + w - 1) % w)) * 4]) / 255, dy = (s[(yd * w + x) * 4] - s[(yu * w + x) * 4]) / 255;
      const nx = -dx * strength, ny = dy * strength, l = 1 / Math.hypot(nx, ny, 1), o = (y * w + x) * 4;
      d[o] = (nx * l * 0.5 + 0.5) * 255; d[o + 1] = (ny * l * 0.5 + 0.5) * 255; d[o + 2] = (l * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}
export function tex(c, srgb, repeatT = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8; t.wrapT = repeatT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return t;
}
export function speckle(g, w, h, n, seed = 1) {
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 233280 + 49297) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < n; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.03)'; g.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 14, 1 + rnd() * 3); }
  return rnd;
}

export const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';
