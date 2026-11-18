// What the two crew cabins (cabin-apollo.js, cabin-starship.js) share.
//
// The cabin's own axes ("cab"): +X to the crew's right, +Y toward the top of their heads, +Z toward their
// backs, so a seated (or, on the pad, reclined) crew member looks along -Z, like a camera. In the vehicle's
// axes that is X = -Xv, Y = -Zv (the leeward side), Z = -Yv (away from the nose); V2C turns one into the other.
//
// Light. The game's lights pass straight through the hull (no shadow reaches inside), so the cabin does not
// use them: every surface carries a baked `lit` attribute (how much of the flood lights and how much of the
// daylight from the windows reaches it) and cabMat() turns that into the surface's own radiance, with what
// the scene's lights would add scaled almost away. Sunlight is cast for real: each window is an aperture
// the fragment shader tests against the sun's direction, so a hard patch of sun moves over the panels as
// the craft turns. Lettering and dial markings light themselves when it is dark (electroluminescent panels).
//
// Also here: the pressure wall with window openings (a surface of revolution with rounded holes, their
// reveals, bezels and panes), canvases that redraw only when what they show has changed, needles that move
// inside one merged geometry, and the drawing helpers for panels (sheets in meters, lettering, seven-segment
// digits).

import * as THREE from 'three';
import { TAU, FONT, canvas, tex, merge, prim } from './model-kit.js';
import { sweep } from '../aircraft/kit.js';

export const V2C = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
/** A point in the cab's axes to the vehicle's (yRef: the station of the cab's origin). */
export const pointToVehicle = (p, yRef) => new THREE.Vector3(-p[0], yRef - p[2], -p[1]);
export const dirToVehicle = (d) => new THREE.Vector3(-d[0], -d[2], -d[1]).normalize();

// ---------------------------------------------------------------- light and materials

/** The uniforms every material of one cabin shares. windows: [{ c, n, a, b, o, round }] in the cab's axes (see shellWall). */
export function cabinLight(windows) {
  const v = (k) => windows.map((w) => new THREE.Vector3(...w[k]));
  return {
    uFlood: { value: new THREE.Vector3(1, 1, 1) }, uDay: { value: new THREE.Vector3(0, 0, 0) },
    uSunCol: { value: new THREE.Vector3(0, 0, 0) }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uEL: { value: 0 }, uSceneK: { value: 0.05 },
    uWinC: { value: v('c') }, uWinN: { value: v('n') }, uWinO: { value: v('o') },
    uWinA: { value: windows.map((w) => new THREE.Vector3(...w.a).multiplyScalar(1 / w.ha)) },     // axis / half-size: |dot| < 1 inside
    uWinB: { value: windows.map((w) => new THREE.Vector3(...w.b).multiplyScalar(1 / w.hb)) },
    uWinR: { value: windows.map((w) => (w.round ? 1 : 0)) },
  };
}

/**
 * A cabin surface: a standard material lit by the baked `lit` attribute (x: flood lights, y: daylight) and by
 * the sun through the windows. o.shafts: test the windows (static geometry in the cab's axes only),
 * o.el: bright ink in the map glows by uEL, o.sharp: mip bias for lettering.
 */
export function cabMat(U, opts = {}, o = {}) {
  const shafts = o.shafts !== false, el = !!o.el, sharp = o.sharp || 0, nw = U.uWinC.value.length;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, fog: false, roughness: 0.8, metalness: 0, envMapIntensity: 0.1, ...opts });
  m.onBeforeCompile = (sh) => {
    for (const k of Object.keys(U)) sh.uniforms[k] = U[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 lit;\nvarying vec2 vLit;\nvarying vec3 vCabP;\nvarying vec3 vCabN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = lit; vCabP = position; vCabN = normal;');
    let f = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec2 vLit; varying vec3 vCabP; varying vec3 vCabN;
uniform vec3 uFlood; uniform vec3 uDay; uniform vec3 uSunCol; uniform vec3 uSunDir; uniform float uEL; uniform float uSceneK;
${shafts && nw ? `uniform vec3 uWinC[${nw}]; uniform vec3 uWinN[${nw}]; uniform vec3 uWinO[${nw}]; uniform vec3 uWinA[${nw}]; uniform vec3 uWinB[${nw}]; uniform float uWinR[${nw}];
float cabShaft(vec3 P) {
  float s = 0.0;
  for (int i = 0; i < ${nw}; i++) {
    float dn = dot(uSunDir, uWinN[i]);
    if (dn > 0.03) {
      float t = dot(uWinC[i] - P, uWinN[i]) / dn;
      if (t > 0.004) {
        vec3 q = P + uSunDir * t - uWinC[i];
        vec3 q2 = q + uSunDir * (dot(uWinO[i], uWinN[i]) / dn) - uWinO[i];
        vec2 a = vec2(dot(q, uWinA[i]), dot(q, uWinB[i])), b = vec2(dot(q2, uWinA[i]), dot(q2, uWinB[i]));
        float ra = mix(max(abs(a.x), abs(a.y)), length(a), uWinR[i]), rb = mix(max(abs(b.x), abs(b.y)), length(b), uWinR[i]);
        float soft = 0.03 + 0.03 * t;
        s += 1.0 - smoothstep(1.0 - soft, 1.0 + soft, max(ra, rb));
      }
    }
  }
  return min(s, 1.0);
}` : ''}`);
    f = f.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  vec3 cabL = uFlood * vLit.x + uDay * vLit.y;
  ${shafts && nw ? 'cabL += uSunCol * cabShaft(vCabP) * max(dot(normalize(vCabN), uSunDir), 0.0);' : ''}
  totalEmissiveRadiance += diffuseColor.rgb * cabL;
  ${el ? 'totalEmissiveRadiance += uEL * smoothstep(0.42, 0.75, dot(diffuseColor.rgb, vec3(0.3, 0.6, 0.1))) * vec3(0.7, 1.0, 0.88);' : ''}
  diffuseColor.rgb *= uSceneK;
}`);
    if (sharp) f = f.replace('#include <map_fragment>', `#ifdef USE_MAP\n vec4 sampledDiffuseColor = texture2D( map, vMapUv, ${sharp.toFixed(2)} );\n diffuseColor *= sampledDiffuseColor;\n#endif`);
    sh.fragmentShader = f;
  };
  m.customProgramCacheKey = () => `cab${nw}${shafts ? 's' : ''}${el ? 'e' : ''}${sharp}`;
  return m;
}

/** A box that blocks light in the bake: M stands it in the cab (its own axes are its edges), half its half-sizes. */
export function occluder(M, half) { return { e: M.clone().invert().elements, h: half }; }
const segHitsBox = (ax, ay, az, bx, by, bz, h) => {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const a = k === 0 ? ax : k === 1 ? ay : az, d = (k === 0 ? bx : k === 1 ? by : bz) - a, hk = h[k];
    if (Math.abs(d) < 1e-9) { if (a < -hk || a > hk) return false; continue; }
    let ta = (-hk - a) / d, tb = (hk - a) / d; if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return false;
  }
  return true;
};

/**
 * Bake the `lit` attribute. L = { floods: [{ p, i, r }], wins: [{ c, n, area }], amb: [flood, day], occ: [occluder()],
 * shade(x, y, z, nx, ny, nz) -> number or [flood, day] that scales the result }. With `shadows`, each light is
 * tested against the occluders (what it cannot reach keeps a fifth, for the light that bounces round) and
 * surfaces darken where they come close to one: nothing floats.
 */
export function bakeLit(geo, L, shadows = false) {
  const p = geo.attributes.position, n = geo.attributes.normal, out = new Float32Array(p.count * 2);
  const amb = L.amb || [0.25, 0.2], occ = shadows && L.occ ? L.occ : [], NB = occ.length, floods = L.floods || [], wins = L.wins || [];
  const lp = occ.map((b) => [...floods.map((f) => f.p), ...wins.map((w) => w.c)].map((q) => { const e = b.e; return [e[0] * q[0] + e[4] * q[1] + e[8] * q[2] + e[12], e[1] * q[0] + e[5] * q[1] + e[9] * q[2] + e[13], e[2] * q[0] + e[6] * q[1] + e[10] * q[2] + e[14]]; }));
  const qx = new Float64Array(NB), qy = new Float64Array(NB), qz = new Float64Array(NB);
  const seen = (j) => { for (let b = 0; b < NB; b++) { const l = lp[b][j]; if (segHitsBox(qx[b], qy[b], qz[b], l[0], l[1], l[2], occ[b].h)) return 0.2; } return 1; };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    let f = amb[0], d = amb[1], ao = 1;
    for (let b = 0; b < NB; b++) {
      const e = occ[b].e, h = occ[b].h, X = x + nx * 0.025, Y = y + ny * 0.025, Z = z + nz * 0.025;
      const u = (qx[b] = e[0] * X + e[4] * Y + e[8] * Z + e[12]), v = (qy[b] = e[1] * X + e[5] * Y + e[9] * Z + e[13]), w = (qz[b] = e[2] * X + e[6] * Y + e[10] * Z + e[14]);
      const dx = Math.abs(u) - h[0], dy = Math.abs(v) - h[1], dz = Math.abs(w) - h[2];
      if (dx < 0.1 && dy < 0.1 && dz < 0.1) { const dist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0), t = Math.max(0, Math.min(1, dist / 0.1)); ao *= 0.45 + 0.55 * t * t * (3 - 2 * t); }
    }
    for (let j = 0; j < floods.length; j++) {
      const fl = floods[j], dx = fl.p[0] - x, dy = fl.p[1] - y, dz = fl.p[2] - z, dd = dx * dx + dy * dy + dz * dz, l = Math.sqrt(dd) || 1;
      const c = Math.max(0, ((nx * dx + ny * dy + nz * dz) / l + 0.4) / 1.4), k = (fl.i * c) / (1 + dd / (fl.r * fl.r));
      if (k > 0.004) f += k * (NB ? seen(j) : 1);
    }
    for (let j = 0; j < wins.length; j++) {
      const w = wins[j], dx = w.c[0] - x, dy = w.c[1] - y, dz = w.c[2] - z, dd = dx * dx + dy * dy + dz * dz, l = Math.sqrt(dd) || 1;
      const c = Math.max(0, ((nx * dx + ny * dy + nz * dz) / l + 0.5) / 1.5), e = Math.max(0, -(w.n[0] * dx + w.n[1] * dy + w.n[2] * dz) / l + 0.15) / 1.15, k = (w.area * c * e) / (dd + 0.12);
      if (k > 0.004) d += k * (NB ? seen(floods.length + j) : 1);
    }
    f *= ao; d *= ao;
    if (L.shade) { const k = L.shade(x, y, z, nx, ny, nz); if (typeof k === 'number') { f *= k; d *= k; } else { f *= k[0]; d *= k[1]; } }
    out[i * 2] = Math.min(f, 1.6); out[i * 2 + 1] = Math.min(d, 1.6);
  }
  geo.setAttribute('lit', new THREE.BufferAttribute(out, 2));
  return geo;
}
/** One value of `lit` for a whole geometry (moving parts). */
export function constLit(geo, f, d = f) {
  const a = new Float32Array(geo.attributes.position.count * 2);
  for (let i = 0; i < a.length; i += 2) { a[i] = f; a[i + 1] = d; }
  geo.setAttribute('lit', new THREE.BufferAttribute(a, 2));
  return geo;
}

/** Box-projected texture coordinates, `tile` meters a repeat, chosen per triangle (non-indexed geometry). */
export function boxUv(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = new Float32Array(p.count * 2), s = 1 / tile;
  for (let i = 0; i < p.count; i += 3) {
    const ax = Math.abs(n.getX(i) + n.getX(i + 1) + n.getX(i + 2)), ay = Math.abs(n.getY(i) + n.getY(i + 1) + n.getY(i + 2)), az = Math.abs(n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2));
    for (let k = i; k < i + 3; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      if (ax >= ay && ax >= az) { uv[k * 2] = z * s; uv[k * 2 + 1] = y * s; } else if (ay >= az) { uv[k * 2] = x * s; uv[k * 2 + 1] = z * s; } else { uv[k * 2] = x * s; uv[k * 2 + 1] = y * s; }
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** A matrix whose columns are the images of the axes. */
export const basis = (x, y, z) => new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z));
/** Turn a (non-indexed) geometry inside out. */
export function insideOut(g) {
  for (const k of ['position', 'normal', 'uv', 'color']) { const a = g.attributes[k], n = a.itemSize, A = a.array; for (let i = 0; i < a.count; i += 3) for (let q = 0; q < n; q++) { const t = A[(i + 1) * n + q]; A[(i + 1) * n + q] = A[(i + 2) * n + q]; A[(i + 2) * n + q] = t; } }
  const N = g.attributes.normal.array; for (let i = 0; i < N.length; i++) N[i] = -N[i];
  return g;
}
/** An upholstered pad from a to b: w wide along ref, t thick, soft at the edges and ends (`sq` < 1 squares its section). */
export function softPad(a, b, w, t, rgb, ref = [1, 0, 0], n = 7, sq = 0.35) {
  const path = Array.from({ length: n }, (_, k) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * (k / (n - 1))));
  return sweep(path, (u) => {
    const r = Math.max(Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, 0.04 + 0.92 * u))), 0.22), 0.25);
    return Array.from({ length: 14 }, (_, j) => { const an = (j / 14) * TAU, c = Math.cos(an), sn = Math.sin(an); return [(w / 2) * (0.86 + 0.14 * r) * Math.sign(c) * Math.pow(Math.abs(c), sq), (t / 2) * r * Math.sign(sn) * Math.pow(Math.abs(sn), 0.5)]; });
  }, ref, { rgb });
}

/** Collects geometry per finish and turns each list into one mesh. */
export class Parts {
  constructor() { this.lists = {}; }
  add(name, ...geos) { const l = this.lists[name] || (this.lists[name] = []); for (const g of geos) if (g) l.push(g); return this; }
  /** Merge list `name` (moved by matrix M first, if given). */
  geometry(name, M) {
    const l = this.lists[name]; if (!l || !l.length) return null;
    const g = merge(l); for (const x of l) x.dispose();
    this.lists[name] = [];
    if (M) g.applyMatrix4(M);
    return g;
  }
}
export function meshFrom(geo, mat) {
  if (!geo) return null;
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------- the pressure wall and its windows

const sdRR = (s, v, a, b, r) => { const dx = Math.abs(s) - (a - r), dy = Math.abs(v) - (b - r); return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r; };

/**
 * The inside of a wall of revolution about +Y (vehicle-like axes: polar azimuth a, height h) with rounded
 * openings. R(h) is the inner radius. holes: [{ ac, hc, w, hgt, rad, margin }]: center, width round the
 * wall and height up its slope in meters, corner radius (half the smaller side makes it round).
 * Returns { wall, holes: [...] } where each hole can build its reveal, bezel and pane, and describes itself
 * for the sun (window()). Everything is still in vehicle-like axes: apply V2C afterwards.
 */
export function shellWall(R, h0, h1, o = {}) {
  const { az0 = 0, az1 = TAU, segA = 72, segH = 14, rgb = [1, 1, 1], NS = 44 } = o, holesIn = o.holes || [];
  const dR = (h) => (R(h + 1e-3) - R(h - 1e-3)) / 2e-3;
  const P = (a, h, e = 0) => { const r = R(h), s = dR(h), l = Math.hypot(1, s), rr = r - e / l; return [rr * Math.cos(a), h + (e * s) / l, -rr * Math.sin(a)]; };
  const Nin = (a, h) => { const s = dR(h), l = Math.hypot(1, s); return [-Math.cos(a) / l, s / l, Math.sin(a) / l]; };
  const pos = [], nor = [], col = [];
  const tri = (A, B, C, flipTo) => {
    // wind so the face looks along flipTo (the inward normal)
    const ux = B[0][0] - A[0][0], uy = B[0][1] - A[0][1], uz = B[0][2] - A[0][2], vx = C[0][0] - A[0][0], vy = C[0][1] - A[0][1], vz = C[0][2] - A[0][2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const order = gx * flipTo[0] + gy * flipTo[1] + gz * flipTo[2] >= 0 ? [A, B, C] : [A, C, B];
    for (const q of order) { pos.push(q[0][0], q[0][1], q[0][2]); nor.push(q[1][0], q[1][1], q[1][2]); const c = q[2] || rgb; col.push(c[0], c[1], c[2]); }
  };
  const vert = (a, h) => [P(a, h), Nin(a, h)];
  const holes = holesIn.map((H) => {
    const lc = Math.hypot(1, dR(H.hc)), ha = H.w / 2, hb = H.hgt / 2, rad = Math.min(H.rad ?? 0.03, ha, hb), m = H.margin ?? 0.05;
    const Rw = (h) => (H.conformal ? R(H.hc) : R(h));                 // conformal: the sides follow lines of azimuth (a pane that tapers with the hull)
    const toSV = (a, h) => [(a - H.ac) * Rw(h), (h - H.hc) * lc];
    const hh = (hb + m) / lc, rMin = H.conformal ? R(H.hc) : Math.min(R(H.hc - hh), R(H.hc + hh)), aa = (ha + m) / rMin;
    const rect = [H.ac - aa, H.ac + aa, H.hc - hh, H.hc + hh];
    // ring of samples: by direction in (a, h), with the rectangle's corners among them
    const angs = []; for (let k = 0; k < NS; k++) angs.push((k / NS) * TAU);
    for (const [sa, sh] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) angs.push((Math.atan2(sh * hh, sa * aa) + TAU) % TAU);
    angs.sort((x, y) => x - y);
    const ring = [];
    for (let k = 0; k < angs.length; k++) {
      if (k && angs[k] - angs[k - 1] < 1e-4) continue;
      const ca = Math.cos(angs[k]), sa = Math.sin(angs[k]), kk = Math.min(aa / Math.max(Math.abs(ca), 1e-9), hh / Math.max(Math.abs(sa), 1e-9));
      const oa = H.ac + ca * kk, oh = H.hc + sa * kk;
      let lo = 0, hi = 1;
      for (let it = 0; it < 26; it++) { const t = (lo + hi) / 2, [s, v] = toSV(H.ac + ca * kk * t, H.hc + sa * kk * t); if (sdRR(s, v, ha, hb, rad) < 0) lo = t; else hi = t; }
      ring.push({ o: [oa, oh], i: [H.ac + ca * kk * lo, H.hc + sa * kk * lo] });
    }
    return { ...H, rect, ring, lc, ha, hb, rad, Rw };
  });
  // grid lines: regular ones plus every sample on a hole's rectangle
  const uniq = (list) => { list.sort((x, y) => x - y); const out = []; for (const v of list) if (!out.length || v - out[out.length - 1] > 1e-6) out.push(v); return out; };
  const as = [], hs = [];
  for (let i = 0; i <= segA; i++) as.push(az0 + ((az1 - az0) * i) / segA);
  for (let j = 0; j <= segH; j++) hs.push(h0 + ((h1 - h0) * j) / segH);
  for (const H of holes) for (const s of H.ring) { if (s.o[0] > az0 && s.o[0] < az1) as.push(s.o[0]); if (s.o[1] > h0 && s.o[1] < h1) hs.push(s.o[1]); }
  const A = uniq(as), Hh = uniq(hs);
  for (let i = 0; i < A.length - 1; i++) for (let j = 0; j < Hh.length - 1; j++) {
    const am = (A[i] + A[i + 1]) / 2, hm = (Hh[j] + Hh[j + 1]) / 2;
    if (holes.some((H) => am > H.rect[0] && am < H.rect[1] && hm > H.rect[2] && hm < H.rect[3])) continue;
    const a = vert(A[i], Hh[j]), b = vert(A[i + 1], Hh[j]), c = vert(A[i + 1], Hh[j + 1]), d = vert(A[i], Hh[j + 1]), nn = Nin(am, hm);
    tri(a, b, c, nn); tri(a, c, d, nn);
  }
  for (const H of holes) {
    const n = H.ring.length, nn = Nin(H.ac, H.hc);
    for (let k = 0; k < n; k++) {
      const s0 = H.ring[k], s1 = H.ring[(k + 1) % n];
      const a = vert(...s0.o), b = vert(...s1.o), c = vert(...s1.i), d = vert(...s0.i);
      tri(a, b, c, nn); tri(a, c, d, nn);
    }
  }
  const geo = (pp, nn, cc) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array((pp.length / 3) * 2), 2));
    return g;
  };
  const wall = geo(pos, nor, col);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const quads = (rows, c, toward) => {
    // rows: [[p...], [p...]] two loops of points; faces look toward `toward(point)` (a direction)
    const pp = [], nn = [], cc = [], n = rows[0].length;
    for (let k = 0; k < n; k++) {
      const a = rows[0][k], b = rows[0][(k + 1) % n], c2 = rows[1][(k + 1) % n], d = rows[1][k];
      let g = norm(cross(sub(b, a), sub(d, a)));
      if (Math.hypot(...cross(sub(b, a), sub(d, a))) < 1e-12) g = norm(cross(sub(c2, a), sub(d, a)));
      const t = toward(a), flip = g[0] * t[0] + g[1] * t[1] + g[2] * t[2] < 0;
      if (flip) g = [-g[0], -g[1], -g[2]];
      for (const q of flip ? [a, c2, b, a, d, c2] : [a, b, c2, a, c2, d]) { pp.push(...q); nn.push(...g); cc.push(...c); }
    }
    return geo(pp, nn, cc);
  };
  for (const H of holes) {
    const center = P(H.ac, H.hc), nOut = Nin(H.ac, H.hc).map((v) => -v);
    const inner = (e = 0) => H.ring.map((s) => P(s.i[0], s.i[1], e));
    const dirOf = (d) => (d ? norm(d) : nOut);
    /** The reveal: the opening's wall, `depth` meters along dir (vehicle-like axes; default: the wall's normal). */
    H.reveal = (depth, c = [0.1, 0.1, 0.1], dir) => {
      const d = dirOf(dir), a = inner(0), b = a.map((p) => add(p, d, depth)), mid = add(center, d, depth / 2);
      return quads([a, b], c, (p) => sub(mid, p));
    };
    /** A flat frame round the opening on the cabin side: `w` wide, standing `e` proud of the wall. */
    H.bezel = (w, e, c = [0.3, 0.3, 0.3]) => {
      const out = H.ring.map((s) => {
        const [sv0, sv1] = [(s.i[0] - H.ac) * H.Rw(s.i[1]), (s.i[1] - H.hc) * H.lc], l = Math.hypot(sv0, sv1) || 1, k = (l + w) / l;
        return [H.ac + ((sv0 * k) / H.Rw(s.i[1])), H.hc + (sv1 * k) / H.lc];
      });
      const i0 = inner(0), i1 = inner(e), o1 = out.map(([a, h]) => P(a, h, e)), o0 = out.map(([a, h]) => P(a, h, 0));
      const inw = (p) => sub([0, p[1], 0], p);
      return merge([quads([i1, o1], c, inw), quads([o1, o0], c, (p) => sub(p, center)), quads([i0, i1], c, (p) => sub(center, p))]);
    };
    /** The glass: `t` meters out along dir from the wall, as rings of triangles that follow the wall. */
    H.pane = (t = 0.02, dir) => {
      const d = dirOf(dir), pp = [], nn = [], cc = [], rings = 3, n = H.ring.length;
      const at = (k, f) => { const s = H.ring[k % n]; return add(P(H.ac + (s.i[0] - H.ac) * f, H.hc + (s.i[1] - H.hc) * f), d, t); };
      const nrm = (k, f) => { const s = H.ring[k % n]; return Nin(H.ac + (s.i[0] - H.ac) * f, H.hc + (s.i[1] - H.hc) * f); };
      const put = (p, q) => { pp.push(...p); nn.push(...q); cc.push(1, 1, 1); };
      for (let r = 0; r < rings; r++) for (let k = 0; k < n; k++) {
        const f0 = r / rings, f1 = (r + 1) / rings, a = at(k, f0), b = at(k + 1, f0), c2 = at(k + 1, f1), e = at(k, f1);
        const g = cross(sub(c2, a), sub(e, a)), nq = nrm(k, 0.5), fl = g[0] * nq[0] + g[1] * nq[1] + g[2] * nq[2] < 0;
        for (const [p, q] of fl ? [[a, nrm(k, f0)], [e, nrm(k, f1)], [c2, nrm(k + 1, f1)]] : [[a, nrm(k, f0)], [c2, nrm(k + 1, f1)], [e, nrm(k, f1)]]) put(p, q);
        if (r > 0) { for (const [p, q] of fl ? [[a, nrm(k, f0)], [c2, nrm(k + 1, f1)], [b, nrm(k + 1, f0)]] : [[a, nrm(k, f0)], [b, nrm(k + 1, f0)], [c2, nrm(k + 1, f1)]]) put(p, q); }
      }
      return geo(pp, nn, cc);
    };
    /** The opening as the sun sees it, in the cab's axes: for cabinLight() and bakeLit(). */
    H.window = (depth = 0.1, dir) => {
      const d = dirOf(dir), ta = norm([-Math.sin(H.ac), 0, -Math.cos(H.ac)]), tb = norm(cross(nOut, ta));
      const cv = (v) => { const q = new THREE.Vector3(...v).applyMatrix4(V2C); return [q.x, q.y, q.z]; };
      return { c: cv(center), n: cv(nOut), a: cv(ta), b: cv(tb), ha: H.ha, hb: H.hb, o: cv([d[0] * depth, d[1] * depth, d[2] * depth]), round: H.rad >= Math.min(H.ha, H.hb) - 1e-6, area: H.w * H.hgt };
    };
    H.center = center; H.nOut = nOut;
  }
  return { wall, holes, P, Nin };
}

// ---------------------------------------------------------------- small geometry

/** A flat grid in the XY plane (normal +Z) over [x0, x1] x [y0, y1], clipped to the convex outline `clip`
 *  ([[a, b, c], ...]: keep a x + b y + c >= 0), with texture coordinates from uv(x, y). */
export function plateGeo(x0, y0, x1, y1, nx, ny, uv, clip = [], z = 0, rgb = [1, 1, 1]) {
  const pos = [], nor = [], uvs = [], col = [];
  const cut = (poly, [a, b, c]) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length], dp = a * p[0] + b * p[1] + c, dq = a * q[0] + b * q[1] + c;
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    return out;
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const xa = x0 + ((x1 - x0) * i) / nx, xb = x0 + ((x1 - x0) * (i + 1)) / nx, ya = y0 + ((y1 - y0) * j) / ny, yb = y0 + ((y1 - y0) * (j + 1)) / ny;
    let poly = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]];
    for (const c of clip) { poly = cut(poly, c); if (poly.length < 3) break; }
    for (let k = 1; k < poly.length - 1; k++) for (const p of [poly[0], poly[k], poly[k + 1]]) {
      pos.push(p[0], p[1], z); nor.push(0, 0, 1); const t = uv(p[0], p[1]); uvs.push(t[0], t[1]); col.push(rgb[0], rgb[1], rgb[2]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A block standing on the XY plane: its top face (at z1) takes texture coordinates from uv(x, y), its sides the color `side`
 *  at the texture's blank corner. */
export function block(x0, y0, x1, y1, z0, z1, uv, side = [0.05, 0.05, 0.05], top = [1, 1, 1], blank = [0.986, 0.986]) {
  const pos = [], nor = [], uvs = [], col = [];
  const quad = (a, b, c, d, n, t, k) => { [a, b, c, a, c, d].forEach((p, i) => { pos.push(...p); nor.push(...n); const q = t ? t[[0, 1, 2, 0, 2, 3][i]] : blank; uvs.push(q[0], q[1]); col.push(...k); }); };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], uv ? [uv(x0, y0), uv(x1, y0), uv(x1, y1), uv(x0, y1)] : null, top);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], null, side);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], null, side);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], null, side);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], null, side);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A ring standing on the XY plane about (x, y): a bezel. seg sides; sq > 0 makes the outside a rounded square of half-size rOut. */
export function ringZ(x, y, rIn, rOut, z0, z1, rgb, seg = 40, sq = 0, lip = 0, uv = null, top = rgb, blank = [0.986, 0.986]) {
  const pos = [], nor = [], col = [], uvs = [];
  const outer = (a) => { if (!sq) return [Math.cos(a) * rOut, Math.sin(a) * rOut]; const c = Math.cos(a), s = Math.sin(a), k = Math.pow(Math.pow(Math.abs(c), sq) + Math.pow(Math.abs(s), sq), -1 / sq); return [c * k * rOut, s * k * rOut]; };
  const quad = (a, b, c, d, n, tx) => { for (const p of [a, b, c, a, c, d]) { pos.push(x + p[0], y + p[1], p[2]); nor.push(...n); col.push(...(tx ? top : rgb)); const t = tx && uv ? uv(x + p[0], y + p[1]) : blank; uvs.push(t[0], t[1]); } };
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU, o0 = outer(a0), o1 = outer(a1), i0 = [Math.cos(a0) * rIn, Math.sin(a0) * rIn], i1 = [Math.cos(a1) * rIn, Math.sin(a1) * rIn];
    const zi = z1 - lip;                                    // the inner edge can sit lower: a dished face
    quad([i0[0], i0[1], zi], [o0[0], o0[1], z1], [o1[0], o1[1], z1], [i1[0], i1[1], zi], [0, 0, 1], true);
    const am = (a0 + a1) / 2;
    quad([o0[0], o0[1], z1], [o0[0], o0[1], z0], [o1[0], o1[1], z0], [o1[0], o1[1], z1], [Math.cos(am), Math.sin(am), 0]);
    quad([i0[0], i0[1], z0], [i0[0], i0[1], zi], [i1[0], i1[1], zi], [i1[0], i1[1], z0], [-Math.cos(am), -Math.sin(am), 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return g;
}
/** A disc in the XY plane about (x, y) at height z, with texture coordinates from uv(x, y) if given. */
export function discZ(x, y, r, z, rgb = [1, 1, 1], seg = 32, uv = null) {
  const g = prim(new THREE.CircleGeometry(r, seg), { pos: [x, y, z], rgb });
  if (uv) { const p = g.attributes.position, t = g.attributes.uv; for (let i = 0; i < p.count; i++) { const q = uv(p.getX(i), p.getY(i)); t.setXY(i, q[0], q[1]); } }
  return g;
}

/**
 * Pointers that turn or slide, all in one geometry. add() takes the pointer's outline as triangles in its own
 * plane ([[x, y], ...], three points a triangle), the matrix that stands that plane in the cab, and a color;
 * set(i, angle, dx, dy) turns it about its origin (counterclockwise, radians) and shifts it.
 */
export class Needles {
  constructor() { this.items = []; this.count = 0; }
  add(tris, M, rgb, lit = [0.8, 0.5], z = 0) { this.items.push({ tris, M, rgb, lit, z, at: this.count, a: NaN, dx: NaN, dy: NaN }); this.count += tris.length; return this.items.length - 1; }
  build(mat) {
    const n = this.count, g = new THREE.BufferGeometry(), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), lit = new Float32Array(n * 2), v = new THREE.Vector3();
    for (const it of this.items) {
      v.set(0, 0, 1).transformDirection(it.M);
      for (let k = 0; k < it.tris.length; k++) { const i = it.at + k; nor.set([v.x, v.y, v.z], i * 3); col.set(it.rgb, i * 3); lit.set(it.lit, i * 2); }
    }
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3); this.pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('lit', new THREE.BufferAttribute(lit, 2)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2).fill(0.986), 2));
    this.mesh = meshFrom(g, mat);
    for (let i = 0; i < this.items.length; i++) this.set(i, 0, 0, 0);
    return this.mesh;
  }
  set(i, a = 0, dx = 0, dy = 0) {
    const it = this.items[i];
    if (Math.abs(a - it.a) < 0.0015 && Math.abs(dx - it.dx) < 1e-4 && Math.abs(dy - it.dy) < 1e-4) return;
    it.a = a; it.dx = dx; it.dy = dy;
    const c = Math.cos(a), s = Math.sin(a), e = it.M.elements, A = this.pos.array;
    for (let k = 0; k < it.tris.length; k++) {
      const p = it.tris[k], x = p[0] * c - p[1] * s + dx, y = p[0] * s + p[1] * c + dy, z = it.z, o = (it.at + k) * 3;
      A[o] = e[0] * x + e[4] * y + e[8] * z + e[12]; A[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13]; A[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    this.pos.needsUpdate = true;
  }
}
/** A pointer's outline: a tapered blade from -tail to len, w0 wide at the hub and w1 at the tip, as triangles. */
export const blade = (len, w0, w1, tail = 0) => [[-w0 / 2, -tail], [w0 / 2, -tail], [w1 / 2, len], [-w0 / 2, -tail], [w1 / 2, len], [-w1 / 2, len]];
export const triangle = (w, h, y0 = 0) => [[-w / 2, y0], [w / 2, y0], [0, y0 + h]];

// ---------------------------------------------------------------- live canvases

/** A canvas texture that is redrawn only when its key changes; flushLive() spreads the redraws over frames. */
export class Live {
  constructor(w, h, draw, mips = true) {
    [this.c, this.g] = canvas(w, h, '#000');
    this.tex = tex(this.c, true); this.tex.generateMipmaps = mips; if (!mips) this.tex.minFilter = THREE.LinearFilter;
    this.draw = draw; this.key = null; this.dirty = true; this.state = null;
  }
  want(key, state) { if (key !== this.key) { this.key = key; this.state = state; this.dirty = true; } }
  flush() { this.draw(this.g, this.state, this.c); this.tex.needsUpdate = true; this.dirty = false; }
}
/** Redraw at most `max` of the canvases that have changed, taking turns. */
export function flushLive(list, turn, max = 2) {
  let done = 0;
  for (let k = 0; k < list.length && done < max; k++) { const l = list[(turn + k) % list.length]; if (l.dirty) { l.flush(); done++; } }
  return done;
}

// ---------------------------------------------------------------- drawing

/** A canvas over a rectangle of a panel, drawn on in meters (x right, y up). */
export class Sheet {
  constructor(x0, y0, x1, y1, k, fill) {
    Object.assign(this, { x0, y0, x1, y1, k });
    this.W = Math.round((x1 - x0) * k); this.H = Math.round((y1 - y0) * k);
    [this.c, this.g] = canvas(this.W, this.H, fill);
    this.uv = (x, y) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
  }
  X(x) { return (x - this.x0) * this.k; }
  Y(y) { return (this.y1 - y) * this.k; }
  has(x, y, m = 0) { return x > this.x0 - m && x < this.x1 + m && y > this.y0 - m && y < this.y1 + m; }
  /** A white patch at (x, y), somewhere hidden: where the untextured faces of parts drawn with this sheet sample (this.bl). */
  blankAt(x, y, r = 0.004) { this.g.fillStyle = '#fff'; this.g.fillRect(this.X(x - r), this.Y(y + r), 2 * r * this.k, 2 * r * this.k); this.bl = this.uv(x, y); }
  rect(x0, y0, x1, y1, fill, stroke, lw = 0.0005, r = 0) {
    const g = this.g, X0 = this.X(x0), Y0 = this.Y(y1), w = (x1 - x0) * this.k, h = (y1 - y0) * this.k;
    g.beginPath(); if (r > 0 && g.roundRect) g.roundRect(X0, Y0, w, h, r * this.k); else g.rect(X0, Y0, w, h);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = Math.max(1, lw * this.k); g.stroke(); }
  }
  disc(x, y, r, fill, stroke, lw = 0.0005) {
    const g = this.g; g.beginPath(); g.arc(this.X(x), this.Y(y), r * this.k, 0, TAU);
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = Math.max(1, lw * this.k); g.stroke(); }
  }
  line(pts, stroke, lw = 0.0005, cap = 'butt') {
    const g = this.g; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(this.X(p[0]), this.Y(p[1])) : g.moveTo(this.X(p[0]), this.Y(p[1]))));
    g.strokeStyle = stroke; g.lineWidth = Math.max(0.8, lw * this.k); g.lineCap = cap; g.lineJoin = 'round'; g.stroke();
  }
  poly(pts, fill, stroke, lw = 0.0005) {
    const g = this.g; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(this.X(p[0]), this.Y(p[1])) : g.moveTo(this.X(p[0]), this.Y(p[1])))); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = Math.max(1, lw * this.k); g.stroke(); }
  }
  /** Lettering: h is the cap height in meters; '\n' breaks lines; o: { color, align, weight, squeeze, track, rot, font }. */
  text(str, x, y, h, o = {}) {
    const g = this.g, px = (h * this.k) / 0.72, lines = String(str).split('\n'), lh = px * 0.95;
    g.save(); g.translate(this.X(x), this.Y(y)); if (o.rot) g.rotate(-o.rot); g.scale(o.squeeze || 0.86, 1);
    g.font = `${o.weight || 700} ${px}px ${o.font || FONT}`; g.textAlign = o.align || 'center'; g.textBaseline = 'middle'; g.fillStyle = o.color || '#eeede6';
    if ('letterSpacing' in g) g.letterSpacing = `${(o.track ?? 0.04) * px}px`;
    lines.forEach((s, i) => g.fillText(s, 0, (i - (lines.length - 1) / 2) * lh + px * 0.04));
    g.restore();
  }
  /** Arc of a dial, angles clockwise from the top in degrees. */
  arc(x, y, r, a0, a1, stroke, lw) {
    const g = this.g; g.beginPath(); g.arc(this.X(x), this.Y(y), r * this.k, ((a0 - 90) * Math.PI) / 180, ((a1 - 90) * Math.PI) / 180);
    g.strokeStyle = stroke; g.lineWidth = Math.max(1, lw * this.k); g.lineCap = 'butt'; g.stroke();
  }
  /** A tick of a dial at angle a (degrees clockwise from the top) from radius r0 to r1. */
  tick(x, y, a, r0, r1, stroke, lw) { const s = Math.sin((a * Math.PI) / 180), c = Math.cos((a * Math.PI) / 180); this.line([[x + s * r0, y + c * r0], [x + s * r1, y + c * r1]], stroke, lw); }
  noise(n, seed = 1, alpha = 0.035) {
    let s = seed * 9301 + 49297; const rnd = () => { s = (s * 233280 + 49297) % 2147483647; return s / 2147483647; }, g = this.g;
    for (let i = 0; i < n; i++) { g.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${alpha})` : `rgba(255,255,255,${alpha * 0.8})`; g.fillRect(rnd() * this.W, rnd() * this.H, 1 + rnd() * 10, 1 + rnd() * 2.5); }
  }
  texture(srgb = true) { const t = tex(this.c, srgb); t.anisotropy = 16; return t; }
}

const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
/** One seven-segment digit in the box (x, y, w, h) of a 2D context; `off` draws the unlit segments faintly. */
export function seg7(g, ch, x, y, w, h, on, off = null, slant = 0.08) {
  const t = w * 0.17, lit = SEG[ch] ?? '', H = h / 2;
  const bar = (cx, cy, len, horiz, o) => {
    g.fillStyle = o; g.beginPath();
    const a = len / 2, b = t / 2;
    if (horiz) { g.moveTo(cx - a, cy); g.lineTo(cx - a + b, cy - b); g.lineTo(cx + a - b, cy - b); g.lineTo(cx + a, cy); g.lineTo(cx + a - b, cy + b); g.lineTo(cx - a + b, cy + b); }
    else { g.moveTo(cx, cy - a); g.lineTo(cx + b, cy - a + b); g.lineTo(cx + b, cy + a - b); g.lineTo(cx, cy + a); g.lineTo(cx - b, cy + a - b); g.lineTo(cx - b, cy - a + b); }
    g.closePath(); g.fill();
  };
  g.save(); g.translate(x + w / 2, y + h / 2); g.transform(1, 0, -slant, 1, 0, 0);
  const hw = w / 2 - t / 2, L = w - t * 1.25, Lv = H - t * 0.75;
  const S = { a: [0, -H + t / 2, L, 1], g: [0, 0, L, 1], d: [0, H - t / 2, L, 1], f: [-hw, -H / 2, Lv, 0], b: [hw, -H / 2, Lv, 0], e: [-hw, H / 2, Lv, 0], c: [hw, H / 2, Lv, 0] };
  for (const k of Object.keys(S)) { const on1 = lit.includes(k); if (on1 || off) bar(S[k][0], S[k][1], S[k][2], S[k][3], on1 ? on : off); }
  g.restore();
}
/** A string of seven-segment digits starting at x; '+' and '-' draw a sign cell. Returns the x after the last one. */
export function segText(g, str, x, y, w, h, gap, on, off) {
  for (const ch of String(str)) {
    if (ch === '+' || ch === '_') {
      const t = w * 0.17;
      if (off) { g.fillStyle = off; g.fillRect(x + w * 0.12, y + h / 2 - t / 2, w * 0.76, t); g.fillRect(x + w / 2 - t / 2, y + h * 0.26, t, h * 0.48); }
      if (ch === '+') { g.fillStyle = on; g.fillRect(x + w * 0.12, y + h / 2 - t / 2, w * 0.76, t); g.fillRect(x + w / 2 - t / 2, y + h * 0.26, t, h * 0.48); }
    } else if (ch === '-' || ch === '~') {
      const t = w * 0.17;
      if (off) { g.fillStyle = off; g.fillRect(x + w / 2 - t / 2, y + h * 0.26, t, h * 0.48); }
      g.fillStyle = on; g.fillRect(x + w * 0.12, y + h / 2 - t / 2, w * 0.76, t);
    } else if (ch === ':') { g.fillStyle = on; g.fillRect(x + w * 0.1, y + h * 0.3, w * 0.16, w * 0.16); g.fillRect(x + w * 0.1, y + h * 0.62, w * 0.16, w * 0.16); x -= w * 0.6; }
    else seg7(g, ch, x, y, w, h, on, off);
    x += w + gap;
  }
  return x;
}

/** A small tiling texture of painted metal or molded plastic: a fine grain with a few specks and hairline scuffs (multiplies the vertex color). */
export function paintTexture(seed = 3, S = 256, contrast = 1) {
  const [c, g] = canvas(S, S, '#f0f0f0');
  let s = seed * 9301 + 49297; const rnd = () => { s = (s * 233280 + 49297) % 2147483647; return s / 2147483647; };
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = 240 + (rnd() - 0.5) * 16 * contrast; d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 9; i++) {
    const x = rnd() * S, y = rnd() * S, r = 30 + rnd() * 60, k = rnd() < 0.5 ? '255,255,255' : '150,150,150', a = 0.022 * contrast;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { const gd = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r); gd.addColorStop(0, `rgba(${k},${a})`); gd.addColorStop(1, `rgba(${k},0)`); g.fillStyle = gd; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2); }
  }
  for (let i = 0; i < 10; i++) { g.strokeStyle = `rgba(70,70,70,${0.05 * contrast})`; g.lineWidth = 0.6; g.beginPath(); const x = rnd() * S, y = rnd() * S; g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 40, y + (rnd() - 0.5) * 40); g.stroke(); }
  g.fillStyle = '#fff'; g.fillRect(S * 0.97, 0, S * 0.03 + 1, S * 0.03 + 1);
  const t = tex(c, true); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
/** A tiling plain weave (cloth, webbing): `n` threads a tile each way. */
export function weaveTexture(n = 24, S = 256, depth = 0.22) {
  const [c, g] = canvas(S, S, '#fff'), img = g.getImageData(0, 0, S, S), d = img.data;
  let s = 4711; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const a = Math.sin((x / S) * Math.PI * 2 * n), b = Math.sin((y / S) * Math.PI * 2 * n), over = a * b > 0;
    const hgt = over ? Math.abs(a) : -0.6 * Math.abs(b), v = 255 * (1 - depth + depth * (0.55 + 0.45 * hgt)) + (rnd() - 0.5) * 9, o = (y * S + x) * 4;
    d[o] = d[o + 1] = d[o + 2] = Math.max(0, Math.min(255, v)); d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, true); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
/** Carbon fiber: a 2 x 2 twill, each tow shaded along its length. */
export function carbonTexture(S = 256, n = 8) {
  const [c, g] = canvas(S, S, '#1a1a1c'), w = S / (n * 2);
  for (let j = 0; j < n * 2; j++) for (let i = 0; i < n * 2; i++) {
    const warp = ((i + j) & 3) < 2, x = i * w, y = j * w, gd = warp ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + w);
    const a = warp ? 78 : 44; gd.addColorStop(0, `rgb(${a * 0.45},${a * 0.45},${a * 0.5})`); gd.addColorStop(0.5, `rgb(${a},${a},${a + 4})`); gd.addColorStop(1, `rgb(${a * 0.45},${a * 0.45},${a * 0.5})`);
    g.fillStyle = gd; g.fillRect(x, y, w + 0.5, w + 0.5);
  }
  const t = tex(c, true); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
