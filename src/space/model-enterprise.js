// The starship Enterprise of "Star Trek: The Next Generation": the Galaxy-class NCC-1701-D, as a procedural
// model at the studio model's proportions, 642.5 m long, 463.7 m across the saucer and 137.5 m from the keel
// to the top of the bridge. Axes: -Z is forward (the saucer's bow), +Y up, +X starboard; the origin is on the
// centerline at the middle of the overall length, at the height of the saucer's rim. Positions along the ship
// are given below as stations: meters aft of the bow (Z() turns one into a z coordinate).
//
// The shapes come from the published side, top and bottom drawings, measured station by station:
//   - the saucer is an ellipse (190 m from its center to the bow, 231.85 m to either side) whose top is a
//     shallow dome and whose underside is a dished outer ring around a cone down to a flat floor; it is a
//     grid in (angle round the rim, fraction of the way out), so every ring of it is the same ellipse;
//   - the neck is a stack of level sections, each a blunt-backed teardrop, raked forward as it rises;
//   - the engineering hull is a row of sections along the ship, each half an ellipse over a flatter keel,
//     starting at the raked oval mouth the deflector dish sits in and ending in the undercut fantail;
//   - the pylons are one wing swept through a bend: level out from the hull's stern, then up to the nacelles;
//   - the nacelles are flattened boxes with rounded sections, the Bussard collectors domes on their fronts.
//
// Finish. The saucer's two faces each wear a canvas painted in plan (the starboard half; the port half mirrors
// it): two-tone "aztec" plating in rings and sectors, lifeboat hatches, the shuttlebay apron. Everything else
// shares one atlas canvas. Each canvas comes with a normal map and a roughness map painted by the same strokes,
// so the seams between plates are where the tones change. What must stay sharp close up is geometry, not
// paint: every window is its own small pane (lit ones in an unlit material that update() dims at night, dark
// ones as glass), the phaser strips stand off the hull, and the lettering is on decals that follow the hull
// (drawn in a face made here for it, since a mirrored canvas cannot carry text). Stock materials throughout:
// fifteen draw calls, about 65,000 triangles.
//
// Light. update(dt, s) takes s = { time, impulse, warp, night, flash }: the Bussard collectors glow red with
// two layers of slow swirl, the warp grilles go from an idle blue to full brightness with warp and surge with
// flash, the impulse exhausts from a dim to a bright red with impulse, the deflector breathes, and the running
// lights blink (red to port, green to starboard, white strobes). On the night side the registry and the hull
// round it are lit as if by the ship's own floodlights (a light map that comes up with night).
//
// buildEnterprise({ detail }) -> { id, root, length, beam, height, points, update(dt, s), dispose() }. detail (0.25 to 1,
// 1 if left out) scales the saucer's canvases, for graphics cards with little memory. Every mesh comes with
// castShadow and receiveShadow set as it should be (only the three hull skins cast); userData.noShadow marks the rest.

import * as THREE from 'three';
import { TAU, D2R, revolve, facets, hexa, box, meshOf, rng, disposeTree, canvas, tex, BLANK, lerp, clamp01, sstep, pchip } from './model-kit.js';

const LENGTH = 642.5, BEAM = 463.7, HEIGHT = 137.5, HALF = LENGTH / 2, HPI = Math.PI / 2;
const Z = (s) => s - HALF;                              // a station (meters aft of the bow) as a z coordinate
const SA = BEAM / 2, SB = 190, SC = Z(190);             // saucer: half its beam, half its length, the z of its center
const NX = 128, NY = -34.5;                             // the nacelles' axes: how far out, and the height of the Bussard collectors' centers
const LIFT = 0.12;                                      // how far a window or a decal stands off the hull
const UP = [0, 1, 0], DOWN = [0, -1, 0], ONE = [1, 1, 1];
const NEARER = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };

// Emissive strengths, in the game's HDR units (sunlit hull is about 0.8; above 1 blooms).
export const ENTERPRISE_GLOW = { window: 2.3, windowNight: 1.05, flood: 1.7, bussard: 3.2, grilleIdle: 1.3, grilleWarp: 7, grilleFlash: 16, dish: 2.6, impulseIdle: 0.5, impulseFull: 9, lamp: 9 };

const TONES = ['#a7b6be', '#9dadb4', '#b1bfc6'];        // the hull's paint: the two tones of the plating and a paler third
const DARK = [0.035, 0.037, 0.042], STRIP = [0.1, 0.1, 0.105], GLASS = [0.02, 0.026, 0.034];
const ROUGH = (v) => `rgb(0,${Math.round(v * 255)},0)`;

// ---------------------------------------------------------------- small vector and grid tools

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const along = (p, d, k) => [p[0] + d[0] * k, p[1] + d[1] * k, p[2] + d[2] * k];
const fold = (t) => (t <= 0.5 ? t * 2 : 2 - t * 2);    // 0..1 round a section to 0..1..0: both sides share half a canvas

function geoOf(pos, nor, uv, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Skin a grid of points P[row][col] = [x, y, z, ...] with smooth normals taken across the whole grid, so a part of it
 * (o.pick(row, col) says which quads) shades as one with the rest. o.closed: the columns wrap. The surface faces the way
 * o.out says (a direction, or (p, row, col) => direction), or away from o.inside (default: the middle of the points).
 * o.uv(p, row, col, quadRow, quadCol) and o.color(...) give each corner's texture coordinate and color; col runs one past
 * the last column where a closed grid wraps.
 */
function gridGeo(P, o = {}) {
  const M = P.length, N = P[0].length, closed = !!o.closed, C = closed ? N : N - 1, rgb = o.rgb || ONE;
  const jw = closed ? (j) => (j + N) % N : (j) => (j < 0 ? 0 : j >= N ? N - 1 : j);
  const nor = new Float64Array(M * N * 3), bad = new Uint8Array(M * N);
  let ins = o.inside;
  if (!o.out && !ins) { ins = [0, 0, 0]; for (const r of P) for (const p of r) { ins[0] += p[0] / (M * N); ins[1] += p[1] / (M * N); ins[2] += p[2] / (M * N); } }
  const outF = typeof o.out === 'function' ? o.out : null;
  let vote = 0;
  for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) {
    const p = P[i][j], a = P[Math.min(i + 1, M - 1)][j], b = P[Math.max(i - 1, 0)][j], c = P[i][jw(j + 1)], d = P[i][jw(j - 1)];
    const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2], vx = c[0] - d[0], vy = c[1] - d[1], vz = c[2] - d[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz), k = (i * N + j) * 3;
    if (l < 1e-9) { bad[i * N + j] = 1; continue; }
    nx /= l; ny /= l; nz /= l; nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
    const w = outF ? outF(p, i, j) : o.out || [p[0] - ins[0], p[1] - ins[1], p[2] - ins[2]];
    vote += Math.sign(nx * w[0] + ny * w[1] + nz * w[2]);
  }
  // a point where the grid closes to nothing (a pole) takes the normal of the nearest row that has one
  for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) if (bad[i * N + j]) {
    for (let d = 1; d < M; d++) {
      const i2 = i + d < M && !bad[(i + d) * N + j] ? i + d : i - d >= 0 && !bad[(i - d) * N + j] ? i - d : -1;
      if (i2 >= 0) { for (let q = 0; q < 3; q++) nor[(i * N + j) * 3 + q] = nor[(i2 * N + j) * 3 + q]; break; }
    }
  }
  const sg = (vote < 0 ? -1 : 1) * (o.flip ? -1 : 1), pos = [], nrm = [], uv = [], col = [];
  const put = (i, j, qi, qj) => {
    const p = P[i][jw(j)], k = (i * N + jw(j)) * 3;
    pos.push(p[0], p[1], p[2]); nrm.push(nor[k] * sg, nor[k + 1] * sg, nor[k + 2] * sg);
    const t = o.uv ? o.uv(p, i, j, qi, qj) : BLANK; uv.push(t[0], t[1]);
    const c = o.color ? o.color(p, i, j, qi, qj) : rgb; col.push(c[0], c[1], c[2]);
  };
  for (let i = 0; i < M - 1; i++) for (let j = 0; j < C; j++) {
    if (o.pick && !o.pick(i, j)) continue;
    const A = P[i][j], B = P[i + 1][j], Cq = P[i][jw(j + 1)], Dq = P[i + 1][jw(j + 1)];
    let g = cross(sub(B, A), sub(Cq, A));
    if (Math.hypot(g[0], g[1], g[2]) < 1e-9) g = cross(sub(Dq, B), sub(Cq, B));
    const ka = (i * N + j) * 3, kd = ((i + 1) * N + jw(j + 1)) * 3;
    const f = (g[0] * (nor[ka] + nor[kd]) + g[1] * (nor[ka + 1] + nor[kd + 1]) + g[2] * (nor[ka + 2] + nor[kd + 2])) * sg;
    if (f >= 0) { put(i, j, i, j); put(i + 1, j, i, j); put(i, j + 1, i, j); put(i + 1, j, i, j); put(i + 1, j + 1, i, j); put(i, j + 1, i, j); }
    else { put(i, j, i, j); put(i, j + 1, i, j); put(i + 1, j, i, j); put(i + 1, j, i, j); put(i, j + 1, i, j); put(i + 1, j + 1, i, j); }
  }
  return geoOf(pos, nrm, uv, col);
}

/** A surface's frame at (u, v): the point, the outward normal, unit tangents along u and v, and meters per unit of each. */
function frame(surf, u, v, out, eu = 1e-4, ev = 1e-4) {
  const p = surf(u, v), du = sub(surf(u + eu, v), surf(u - eu, v)), dv = sub(surf(u, v + ev), surf(u, v - ev));
  let n = unit(cross(du, dv));
  if (dot(n, typeof out === 'function' ? out(p) : out) < 0) n = [-n[0], -n[1], -n[2]];
  return { p, n, du: unit(du), dv: unit(dv), mu: Math.hypot(du[0], du[1], du[2]) / (2 * eu), mv: Math.hypot(dv[0], dv[1], dv[2]) / (2 * ev) };
}

// ---------------------------------------------------------------- the shapes

// Saucer: height of the top and of the underside by the fraction of the way out to the rim.
const TOP_H = pchip([0, 0.1, 0.231, 0.326, 0.388, 0.452, 0.515, 0.577, 0.641, 0.704, 0.766, 0.829, 0.893, 0.955, 0.992], [27.2, 27.0, 26.4, 25.5, 24.6, 23.6, 22.3, 20.6, 18.7, 16.4, 13.8, 11.2, 8.3, 5.2, 3.5]);
const BOT_H = pchip([0, 0.06, 0.12, 0.2, 0.3, 0.42, 0.546, 0.672, 0.735, 0.78, 0.84, 0.9, 0.96, 0.992], [-22.8, -22.8, -22.6, -21.6, -19.6, -16.2, -12.4, -6.3, -3.9, -2.6, -1.7, -1.7, -2.6, -3.5]);
const topSurf = (f, r) => [SA * r * Math.sin(f), TOP_H(r), SC - SB * r * Math.cos(f)];      // f: angle round from the bow toward starboard
const botSurf = (f, r) => [SA * r * Math.sin(f), BOT_H(r), SC - SB * r * Math.cos(f)];
const rimSurf = (f, y) => [SA * Math.sin(f), y, SC - SB * Math.cos(f)];
const rhoAt = (x, z) => Math.hypot(x / SA, (z - SC) / SB);
const rimOut = (p) => [p[0] / (SA * SA), 0, (p[2] - SC) / (SB * SB)];

// The saucer's two canvases are painted in plan: x 0..PLAN_W to starboard, z from PLAN_Z0 aft.
const PLAN_W = 234, PLAN_Z0 = SC - 198, PLAN_L = 396;
let DETAIL = 1;                                         // the share of full size the saucer's canvases are painted at: buildEnterprise({ detail }) sets it (they are most of the model's memory)
const uvPlan = (p) => [Math.abs(p[0]) / PLAN_W, 1 - (p[2] - PLAN_Z0) / PLAN_L];

// The superstructure round the bridge: a teardrop with a square stern (the main shuttlebay's wall), by station.
const SUP = { s0: 150, s1: 272, w: pchip([150, 153, 160, 170, 185, 200, 215, 230, 245, 258, 268, 272], [0, 12, 22, 30, 37, 42, 47, 51, 54, 55, 53, 48]) };
const supLift = (x, z) => { const s = z + HALF; return 1.8 + 2.4 * sstep(150, 272, s) + 1.25 * Math.exp(-(((s - 201) / 24) ** 2) - (x / 22) ** 2); };
const BRIDGE = { s: 206, top: 33.8, rx: 9.4, rz: 12.4 };

// Neck: by height, where its leading and trailing edges are and half its greatest width.
const NK = {
  le: pchip([-60, -50, -46, -42, -40, -38, -36, -35, -30, -24, -20.7, -18.7, -17.6, -16, 6], [380, 372, 360, 336, 329, 322, 311.5, 309.8, 307.6, 301.6, 296, 288, 272, 262, 262]),      // (below -35 it draws back inside the hull, behind the deflector's well)
  te: (y) => 385 + (3 - y) * (61 / 51),
  t: pchip([-60, -54, -48, -42, -36, -28, -20, -12, -3.6, 3, 6], [52, 44, 34, 26, 20, 17, 19.5, 24, 27, 26, 24]),
  levels: [-60, -55, -50, -46, -43, -40, -38, -36, -35, -33, -30, -27, -24, -21.5, -20, -18.7, -17.6, -16, -13, -10, -7, -3.6, 0, 3, 4.6],
};
const NK_MAX = 0.72;                                    // where along the chord a section is widest
const neckF = (t) => (t <= NK_MAX ? Math.pow(Math.sin((HPI * t) / NK_MAX), 0.75) : Math.sqrt(Math.max(0, 1 - Math.pow((t - NK_MAX) / (1 - NK_MAX), 2.6))));
const neckSurf = (side) => (t, y) => [side * NK.t(y) * neckF(clamp01(t)), y, Z(lerp(NK.le(y), NK.te(y), t))];
/** Is this point of the saucer or the hull under the neck's foot? */
function inNeck(p, pad = 3) {
  const y = Math.max(-60, Math.min(4.6, p[1])), s = p[2] + HALF, le = NK.le(y), te = NK.te(y);
  return s > le - pad && s < te + pad && Math.abs(p[0]) < NK.t(y) * neckF(clamp01((s - le) / (te - le))) + pad;
}

// Engineering hull: by station, half its beam, its dorsal line, its keel and the height of its widest line.
const EH = {
  B: pchip([319.3, 322, 326, 331, 340, 355, 380, 420, 450, 475, 500, 515, 540, 570, 595, 606], [44, 50, 56.5, 62, 68, 73, 75, 74.5, 72, 67.5, 62, 60, 57, 52, 46, 41]),
  top: pchip([309, 325, 340, 365, 400, 450, 475, 499, 511, 529, 560, 590, 606, 612], [-35, -36, -39, -44.5, -48.5, -50.5, -53.5, -57.8, -60, -63.7, -68.5, -73, -76, -76.5]),
  keel: pchip([329.6, 337.5, 343.5, 349.4, 355.4, 361.4, 373.4, 385.3, 397, 409, 421, 433, 445, 457, 469, 475, 481, 487, 493, 499, 505, 511, 560, 612], [-77, -83.6, -87, -91.3, -93.8, -94.8, -96.2, -97.7, -99.3, -100.6, -101.6, -102, -102.5, -102.3, -102, -99.1, -94.3, -90.9, -87.9, -86, -84.6, -84.1, -84.5, -84.5]),
  chine: pchip([319, 330, 345, 360, 500, 612], [-56, -66, -76, -80, -80, -80.5]),
  s0: 319.3, s1: 606, cap: 5,
  stations: [319.3, 320.6, 322.5, 325, 328, 332, 337, 343, 350, 358, 367, 377, 388, 400, 412, 424, 436, 448, 458, 466, 472, 477, 482, 487, 492, 497, 502, 507, 512, 518, 526, 536, 548, 560, 572, 584, 594, 601, 606, 608, 609.5, 610.5, 610.95],
};
// The hull's mouth is raked: its sections lean back toward the keel, by RAKE meters for each meter below YREF, easing upright by station 372.
const RAKE = 0.49, YREF = -56;
function hullSec(sg) {
  const r = RAKE * (1 - sstep(322, 372, sg));
  const solve = (f) => { let y = f(sg); for (let k = 0; k < 5; k++) y = f(sg + r * (YREF - y)); return y; };
  const cap = sg > EH.s1 ? Math.sqrt(Math.max(0, 1 - ((sg - EH.s1) / EH.cap) ** 2)) : 1, yc = solve(EH.chine);
  return { r, yc, B: EH.B(Math.min(sg, EH.s1)) * cap, hu: (solve(EH.top) - yc) * cap, hl: (yc - solve(EH.keel)) * cap };
}
/** A point of the hull: station sg, angle al round the section from the dorsal line (pi / 2 is the starboard side, pi the keel). */
function hullAt(sg, al, sec = hullSec(sg)) {
  const sn = Math.sin(al), cs = Math.cos(al), up = cs >= 0;
  const x = sec.B * Math.sign(sn) * Math.pow(Math.abs(sn), up ? 1 : 0.87), y = sec.yc + (up ? sec.hu * cs : -sec.hl * Math.pow(-cs, 0.87));
  return [x, y, Z(sg + sec.r * (YREF - y))];
}
const hullOut = (p) => [p[0], p[1] + 78, 0];
// The deflector's plane: across, up the rake, and out of the mouth.
const DISH = { c: [0, YREF, Z(EH.s0)], x: [1, 0, 0], u: unit([0, 1, -RAKE]), n: unit([0, -RAKE, -1]), in: unit([0, -0.25, 1]) };       // (in: the way its well is sunk, kept under the hull's back)

// Pylons: one wing swept through a bend. By distance along it from the centerline: level to PY.u0, an arc up, then straight to the nacelle.
const PY = {
  u0: 94, r: 22, bend: 62 * D2R, y: -80, u2: 142,
  le: pchip([0, 55, 64, 72, 80, 90, 100, 112, 125, 140], [500, 503, 510, 519, 527, 532.5, 535, 536, 536.5, 537]),
  te: pchip([0, 60, 92, 105, 116, 140], [604, 606, 609.5, 608.5, 606, 596]),
  th: pchip([0, 60, 92, 116, 140], [8.4, 8, 7, 6, 5.5]),
  spans: [0, 30, 52, 60, 66, 72, 78, 84, 89, 94, 96.5, 99, 101.5, 104, 106.5, 109, 111.5, 114, 116, 117.8, 122, 128, 135, 142],
  sec: [[0, 0], [0.012, 0.3], [0.04, 0.56], [0.1, 0.8], [0.2, 0.95], [0.35, 1], [0.6, 0.97], [0.8, 0.8], [0.93, 0.5], [1, 0.14]],      // chord fraction, share of the thickness
};
PY.u1 = PY.u0 + PY.r * PY.bend;
/** The wing's middle line at distance u along it: [out, height, direction out, direction up]. */
function pylonPath(u) {
  if (u <= PY.u0) return [u, PY.y, 1, 0];
  const a = Math.min(PY.bend, (u - PY.u0) / PY.r), x = PY.u0 + PY.r * Math.sin(a), y = PY.y + PY.r * (1 - Math.cos(a)), over = Math.max(0, u - PY.u1);
  return [x + Math.cos(a) * over, y + Math.sin(a) * over, Math.cos(a), Math.sin(a)];
}
/** A point of the wing's skin: u along it, c along the chord (0..1), face +1 for the upper (inboard) skin or -1 for the lower (outboard). */
function pylonAt(side, u, c, face) {
  const [px, py, dx, dy] = pylonPath(u), k = PY.sec, cc = clamp01(c);
  let i = 0; while (i < k.length - 2 && cc > k[i + 1][0]) i++;
  const t = lerp(k[i][1], k[i + 1][1], (cc - k[i][0]) / (k[i + 1][0] - k[i][0])) * PY.th(u) * 0.5 * face;
  return [side * (px - dy * t), py + dx * t, Z(lerp(PY.le(u), PY.te(u), cc))];
}

// Nacelles: by station, half the width, the top and the underside. The Bussard collector's dome covers the front.
const NC = (() => {
  const S = [423.5, 433, 443, 447, 451, 463, 487, 513, 560, 598, 613, 625, 632, 637, 640.5, 642.2, 642.5];
  return {
    s0: 423.5, s1: 642.5, tip: 393.5,
    hw: pchip(S, [16.5, 18, 18.6, 19.3, 19.6, 20.4, 22.2, 24.4, 25.4, 25.6, 25.4, 24.6, 22.5, 19, 13, 5.5, 0.05]),
    top: pchip(S, [-26.2, -24.8, -24, -23, -22.6, -21.8, -21, -20.6, -20.5, -20.9, -21.8, -23, -24.6, -27, -30.5, -34.6, -36.5]),
    bot: pchip(S, [-42.8, -44.5, -45.5, -47.5, -48.3, -50.3, -51.3, -51.8, -52.4, -52.7, -52.5, -51.6, -50.3, -48, -44.5, -38.8, -36.6]),
    // rows of the skin: [station, scale about the axis]: a bulkhead behind the dome and a lip round its base, the collar, the raised copper band, the body
    rows: [[424.5, 0.02], [423.5, 0.93], [423.5, 1], [428, 1], [433, 1], [433, 1.035], [443, 1.035], [443, 1], [446, 1], [449, 1], [452, 1], [455, 1], [458, 1], [461, 1], [464, 1], [467, 1], [470, 1], [473, 1], [480, 1], [490, 1], [505, 1], [520, 1], [540, 1], [560, 1], [580, 1], [598, 1], [610, 1], [618, 1], [625, 1], [630, 1], [634, 1], [637, 1], [639.5, 1], [641.2, 1], [642.2, 1], [642.5, 1]],
    // the warp grille: a band down each side, by station half its angle round the section (it flares at the front)
    g0: 446, g1: 637,
    half: pchip([440, 446, 452, 458, 463, 468, 473, 480, 630, 634, 637, 643], [0.03, 0.62, 0.64, 0.6, 0.42, 0.27, 0.195, 0.185, 0.185, 0.15, 0.03, 0.03]),
    frame: 0.035,
    // columns round a section: [how many, from, to] in units the grille's half-angle is added to
    cols: [8, 1, 4, 1, 14, 1, 4, 1, 8],
  };
})();
/** A point of a nacelle: station, angle round from the top toward the outboard side. */
function nacAt(side, s, al, k = 1) {
  const t = NC.top(s), b = NC.bot(s), sn = Math.sin(al), cs = Math.cos(al), e = 0.77;
  return [side * (NX + NC.hw(s) * k * Math.sign(sn) * Math.pow(Math.abs(sn), e)), (t + b) / 2 + ((t - b) / 2) * k * Math.sign(cs) * Math.pow(Math.abs(cs), e), Z(s)];
}
/** The angles of a nacelle section's columns at station s: they crowd round the grille's edges so the band is whole quads. */
function nacAngles(s) {
  const d = NC.half(Math.max(440, Math.min(643, s))), fr = NC.frame, marks = [0, HPI - d - fr, HPI - d, HPI + d, HPI + d + fr, 3 * HPI - d - fr, 3 * HPI - d, 3 * HPI + d, 3 * HPI + d + fr, TAU], out = [];
  NC.cols.forEach((n, q) => { for (let k = 0; k < n; k++) out.push(lerp(marks[q], marks[q + 1], k / n)); });
  return out;
}

// ---------------------------------------------------------------- windows, strips and decals: what stands on the skin

/** Window panes: lit ones (unlit material, one color each) and dark ones (glass). */
class Glass {
  constructor(seed) { this.lp = []; this.lc = []; this.dp = []; this.dn = []; this.dc = []; this.rnd = rng(seed); this.count = 0; }
  /** A pane centered at p facing n, its long side along a: half-width hw, half-length hh, corners cut. */
  pane(p, n, a, hw, hh, lit) {
    const b = cross(a, n), q = Math.min(hw, hh) * 0.5, r = this.rnd, pts = [[-hw + q, -hh], [hw - q, -hh], [hw, -hh + q], [hw, hh - q], [hw - q, hh], [-hw + q, hh], [-hw, hh - q], [-hw, -hh + q]].map(([x, y]) => [p[0] + b[0] * x + a[0] * y, p[1] + b[1] * x + a[1] * y, p[2] + b[2] * x + a[2] * y]);
    const k = 0.5 + 0.5 * r(), c = lit ? (r() < 0.22 ? [0.8 * k, 0.9 * k, k] : [k, 0.93 * k, 0.78 * k]) : [GLASS[0] * (0.6 + r()), GLASS[1] * (0.6 + r()), GLASS[2] * (0.6 + r())];
    for (let i = 1; i < 7; i++) for (const v of [pts[0], pts[i], pts[i + 1]]) {
      if (lit) { this.lp.push(v[0], v[1], v[2]); this.lc.push(c[0], c[1], c[2]); } else { this.dp.push(v[0], v[1], v[2]); this.dn.push(n[0], n[1], n[2]); this.dc.push(c[0], c[1], c[2]); }
    }
    this.count++;
  }
  /**
   * A row of panes along u at a fixed v of a surface, in groups with gaps between, each pane's long side along v.
   * o: pitch (m between panes), w, h (m), lit (share lit), group and gap ([fewest, most] panes), skip(p), eu, ev.
   */
  row(surf, out, v, u0, u1, o = {}) {
    const { pitch = 3, w = 1.15, h = 3, lit = 0.55, group = [2, 5], gap = [3, 13], skip, eu = 1e-4, ev = 1e-4 } = o, r = this.rnd;
    let u = u0, run = 0, hole = Math.floor(r() * gap[1]);
    for (let guard = 0; u < u1 && guard < 4000; guard++) {
      const F = frame(surf, u, v, out, eu, ev);
      if (hole > 0) hole--; else {
        if (run === 0) run = group[0] + Math.floor(r() * (group[1] - group[0] + 1));
        const on = r() < lit;
        if (!skip || !skip(F.p)) this.pane(along(F.p, F.n, LIFT), F.n, F.dv, w / 2, h / 2, on);
        if (--run === 0) hole = gap[0] + Math.floor(r() * (gap[1] - gap[0] + 1));
      }
      u += pitch / Math.max(F.mu, 1e-6);
    }
  }
  geometries() {
    const lit = new THREE.BufferGeometry();
    lit.setAttribute('position', new THREE.Float32BufferAttribute(this.lp, 3)); lit.setAttribute('color', new THREE.Float32BufferAttribute(this.lc, 3));
    const uv = new Float32Array((this.dp.length / 3) * 2); for (let i = 0; i < uv.length; i += 2) { uv[i] = BLANK[0]; uv[i + 1] = BLANK[1]; }
    return { lit, dark: geoOf(this.dp, this.dn, uv, this.dc) };
  }
}

/** A raised band along u at a fixed v of a surface (a phaser strip): n steps, so wide, standing so high. */
function strip(surf, out, v, u0, u1, n, width, rise, rgb, eu, ev) {
  const P = [], ns = [];
  for (let k = 0; k <= n; k++) {
    const F = frame(surf, lerp(u0, u1, k / n), v, out, eu, ev), hw = width / 2, at = (x, y) => [F.p[0] + F.dv[0] * x + F.n[0] * y, F.p[1] + F.dv[1] * x + F.n[1] * y, F.p[2] + F.dv[2] * x + F.n[2] * y];
    P.push([at(-hw, -0.1), at(-hw * 0.8, rise), at(hw * 0.8, rise), at(hw, -0.1)]); ns.push(F.n);
  }
  return gridGeo(P, { out: (p, i) => ns[i], rgb });
}

/** A patch of a surface, lifted off it, for a decal: uvf(fu, fv) places the picture over the patch's 0..1 by 0..1. */
function patch(surf, out, u0, u1, v0, v1, nu, nv, uvf, eu, ev) {
  const P = [], ns = [];
  for (let i = 0; i <= nu; i++) {
    const row = [];
    for (let j = 0; j <= nv; j++) { const F = frame(surf, lerp(u0, u1, i / nu), lerp(v0, v1, j / nv), out, eu, ev); row.push([...along(F.p, F.n, LIFT * 0.7), i / nu, j / nv]); if (j === 0) ns.push(F.n); }
    P.push(row);
  }
  return gridGeo(P, { out: (p, i) => ns[i], uv: (p) => uvf(p[3], p[4]) });
}

// ---------------------------------------------------------------- paint

/** Normal map from a height canvas (white is high); the edges are clamped, since these canvases do not tile. */
function normalOf(src, strength) {
  const w = src.width, h = src.height, s = src.getContext('2d').getImageData(0, 0, w, h).data, [out, g] = canvas(w, h), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : y, yd = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : x, xr = x < w - 1 ? x + 1 : x, dx = (s[(y * w + xr) * 4] - s[(y * w + xl) * 4]) / 255, dy = (s[(yd * w + x) * 4] - s[(yu * w + x) * 4]) / 255;
      const nx = -dx * strength, ny = dy * strength, l = 1 / Math.hypot(nx, ny, 1), o = (y * w + x) * 4;
      d[o] = (nx * l * 0.5 + 0.5) * 255; d[o + 1] = (ny * l * 0.5 + 0.5) * 255; d[o + 2] = (l * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

/** Three canvases painted by the same strokes: color, height (half size, for the normal map) and roughness (quarter size). */
function layers(W, H, base) {
  const [C, g] = canvas(W, H, base), [Hc, gh] = canvas(Math.round(W / 2), Math.round(H / 2), '#808080'), [Rc, gr] = canvas(Math.round(W / 4), Math.round(H / 4), ROUGH(0.46));
  gh.scale(0.5, 0.5); gr.scale(0.25, 0.25);
  const all = [g, gh, gr];
  return {
    C, Hc, Rc, g, gh, gr,
    each(fn) { for (const c of all) fn(c); },
    /** draw(ctx) on each canvas a style is given for: color, height, roughness. */
    paint(col, hgt, rgh, draw) {
      if (col) { g.fillStyle = g.strokeStyle = col; draw(g, 0); }
      if (hgt) { gh.fillStyle = gh.strokeStyle = hgt; draw(gh, 1); }
      if (rgh) { gr.fillStyle = gr.strokeStyle = rgh; draw(gr, 2); }
    },
    textures(bump) { return { map: tex(C, true), normalMap: tex(normalOf(Hc, bump), false), roughnessMap: tex(Rc, false) }; },
  };
}
const SEAM = ['rgba(46,56,64,0.3)', 'rgba(64,64,64,0.9)'], SEAM_W = [0.17, 0.36, 0.5];       // a seam between plates: its color and groove, and how wide each canvas draws it (m)
const seam = (Lr, draw) => Lr.paint(SEAM[0], SEAM[1], null, (c, k) => { c.lineWidth = SEAM_W[k]; draw(c); c.stroke(); });

/** The saucer's canvases: meters in plan, x to starboard and z aft. */
function planLayers(ppm) {
  const Lr = layers(Math.round(PLAN_W * ppm), Math.round(PLAN_L * ppm), TONES[0]);
  Lr.each((c) => { c.scale(ppm, ppm); c.translate(0, -PLAN_Z0); });
  return Lr;
}
const RINGS = { z: SC, a: SA, b: SB };                 // the ellipse the saucer's rings are drawn round
/** Path of a plate of the saucer: from r0 to r1 of the way out, from angle f0 to f1 round from the bow (E: round another ellipse). */
function cellPath(c, r0, r1, f0, f1, E = RINGS) {
  c.beginPath(); c.ellipse(0, E.z, E.a * r1, E.b * r1, 0, f0 - HPI, f1 - HPI);
  if (r0 > 1e-4) c.ellipse(0, E.z, E.a * r0, E.b * r0, 0, f1 - HPI, f0 - HPI, true); else c.lineTo(0, E.z);
  c.closePath();
}
/** Two-tone plating in rings (bands: their edges, as fractions of the way out) and sectors, each plate with a smaller one of the other tone let into it. */
function aztecRings(Lr, bands, rnd, cellM = 17, E = RINGS) {
  const seams = [], mean = (E.a + E.b) * 0.487;
  for (let b = 0; b < bands.length - 1; b++) {
    const r0 = bands[b], r1 = bands[b + 1], n = Math.max(4, Math.round((Math.PI * (r0 + r1) * 0.5 * mean) / cellM));
    for (let k = 0; k < n; k++) {
      const f0 = (Math.PI * k) / n, f1 = (Math.PI * (k + 1)) / n, t = (k + b) & 1, tone = rnd() < 0.1 ? 2 : t;
      Lr.paint(TONES[tone], null, ROUGH(t ? 0.52 : 0.4), (c) => { cellPath(c, r0, r1, f0, f1, E); c.fill(); });
      seams.push([r0, r1, f0, f1]);
      if (rnd() < 0.8) {
        const a0 = rnd() < 0.5 ? 0 : 0.5, b0 = [0, 0.33, 0.5, 0.66][Math.floor(rnd() * 4)], b1 = Math.min(1, b0 + [0.34, 0.5][Math.floor(rnd() * 2)]);
        const q = [lerp(r0, r1, a0), lerp(r0, r1, a0 + 0.5), lerp(f0, f1, b0), lerp(f0, f1, b1)];
        Lr.paint(TONES[tone === 2 ? 0 : 1 - t], null, ROUGH(t ? 0.4 : 0.52), (c) => { cellPath(c, ...q, E); c.fill(); });
        seams.push(q);
      }
    }
  }
  for (const q of seams) seam(Lr, (c) => cellPath(c, ...q, E));
}
/** A lifeboat hatch: a small square plate standing a little proud, turned to face along the hull's rings. */
function hatch(Lr, x, z, ang, sz) {
  Lr.each((c) => { c.save(); c.translate(x, z); c.rotate(ang); });
  Lr.paint('#b7b1a2', '#a2a2a2', ROUGH(0.62), (c) => c.fillRect(-sz / 2, -sz / 2, sz, sz));
  Lr.paint('rgba(52,54,54,0.6)', '#606060', null, (c, k) => { c.lineWidth = [0.16, 0.3, 0.4][k]; c.strokeRect(-sz / 2, -sz / 2, sz, sz); });
  Lr.paint('rgba(70,70,66,0.5)', null, null, (c) => { c.lineWidth = 0.12; c.strokeRect(-sz * 0.22, -sz * 0.22, sz * 0.44, sz * 0.44); });
  Lr.each((c) => c.restore());
}
/** A row of lifeboat hatches round a ring of the saucer, in groups. */
function hatchRing(Lr, r, rnd, busy, sz = 3.3) {
  let f = 0.02 + rnd() * 0.04, run = 0, hole = 0;
  while (f < Math.PI - 0.02) {
    if (hole > 0) hole--; else {
      if (run === 0) run = 3 + Math.floor(rnd() * 5);
      const x = SA * r * Math.sin(f), z = SC - SB * r * Math.cos(f);
      if (!busy(x, z)) hatch(Lr, x, z, Math.atan2((z - SC) / (SB * SB), x / (SA * SA)), sz);
      if (--run === 0) hole = 2 + Math.floor(rnd() * 5);
    }
    f += (sz * 1.55) / (r * 205);
  }
}

/** What of the saucer's top is taken (by the superstructure, the shuttlebay's apron, the spine, the lettering): no windows or hatches there. */
function topBusy(x, z, pad = 0) {
  const s = z + HALF, ax = Math.abs(x), r = rhoAt(x, z), f = Math.atan2(ax / SA, -(z - SC) / SB);
  if (s > SUP.s0 - 3 - pad && s < SUP.s1 + pad && ax < SUP.w(Math.max(SUP.s0, s)) + 3 + pad) return true;
  if (s >= SUP.s1 && s < 322 && ax < 52 + pad) return true;
  if (s >= 318 && ax < 31 + pad) return true;
  if (r > 0.37 && r < 0.54 && f < 0.76) return true;
  if (r > 0.535 && r < 0.615 && f < 0.44) return true;
  return false;
}
/** And of its underside: the neck's foot, the registry, the middle. */
function botBusy(x, z, pad = 0) {
  const s = z + HALF, ax = Math.abs(x), r = rhoAt(x, z), f = Math.atan2(ax / SA, -(z - SC) / SB);
  if (s > 256 - pad && ax < lerp(5, 33, sstep(256, 312, s)) + pad) return true;
  if (r > 0.31 && r < 0.43 && f < 0.55) return true;
  return r < 0.135;
}

const supOutline = (() => {            // the superstructure's outline in plan, [x, z]: from the bow point down the starboard side, across the stern, back up the port side
  const side = [];
  for (let k = 0; k <= 30; k++) { const s = SUP.s0 + (SUP.s1 - SUP.s0) * Math.pow(k / 30, 1.7); side.push([SUP.w(s), Z(s)]); }
  const stern = []; for (let k = 1; k < 12; k++) stern.push([lerp(SUP.w(SUP.s1), -SUP.w(SUP.s1), k / 12), Z(SUP.s1)]);
  return [...side, ...stern, ...side.slice(1).reverse().map(([x, z]) => [-x, z])];
})();
const ARM = [[26, 272], [48, 272], [46.5, 285], [42, 300], [36, 312], [31, 318], [27.5, 318], [26.5, 300]];        // an arm of the shuttlebay's apron in plan: [x, station]
const SPINE = [[0, 318], [15, 318], [20, 330], [24, 350], [26.5, 368], [27, 379], [0, 379]];                   // the spine aft of the apron (starboard half)
const armLift = (x, z) => 0.3 + 2.3 * (1 - sstep(276, 318, z + HALF));
const polyPath = (c, pts) => { c.beginPath(); pts.forEach(([x, s], i) => (i ? c.lineTo(x, Z(s)) : c.moveTo(x, Z(s)))); c.closePath(); };

function paintTop(rnd) {
  const Lr = planLayers((2048 * DETAIL) / PLAN_W);
  aztecRings(Lr, [0.16, 0.2, 0.27, 0.33, 0.37, 0.41, 0.45, 0.49, 0.53, 0.57, 0.6, 0.64, 0.675, 0.705, 0.74, 0.775, 0.81, 0.84, 0.87, 0.9, 0.93, 0.96, 0.992], rnd);
  // the edges of the decks: a stronger line round a few of the rings, and the dark trim at the rim
  for (const r of [0.27, 0.6, 0.705, 0.81, 0.93]) Lr.paint('rgba(40,48,56,0.34)', 'rgba(52,52,52,0.9)', null, (c, k) => { c.lineWidth = [0.3, 0.5, 0.6][k]; c.beginPath(); c.ellipse(0, SC, SA * r, SB * r, 0, -HPI, HPI); c.stroke(); });
  Lr.paint('#5d676d', null, ROUGH(0.6), (c) => { cellPath(c, 0.982, 1.01, 0, Math.PI); c.fill(); });
  for (const r of [0.945, 0.855, 0.757, 0.585, 0.39, 0.3]) hatchRing(Lr, r, rnd, (x, z) => topBusy(x, z, 2));
  // the superstructure, a tone paler, with plating of its own in rings round its middle; the bridge's dome at their center
  const sup = supOutline.filter(([x]) => x >= -1e-6), supPath = (c) => { c.beginPath(); sup.forEach(([x, z], i) => (i ? c.lineTo(x, z) : c.moveTo(x, z))); c.lineTo(0, Z(SUP.s1)); c.closePath(); };
  Lr.paint(TONES[2], '#8a8a8a', ROUGH(0.42), (c) => { supPath(c); c.fill(); });
  Lr.each((c) => { c.save(); supPath(c); c.clip(); });
  aztecRings(Lr, [0.2, 0.34, 0.5, 0.66, 0.83, 1.02, 1.3], rnd, 11, { z: Z(BRIDGE.s), a: 62, b: 80 });
  Lr.each((c) => c.restore());
  seam(Lr, supPath);
  const br = { z: Z(BRIDGE.s), a: BRIDGE.rx, b: BRIDGE.rz };
  Lr.paint('#c3ced3', '#8e8e8e', ROUGH(0.36), (c) => { cellPath(c, 0, 1.25, 0, Math.PI, br); c.fill(); });
  Lr.paint('#8f9ca4', '#707070', ROUGH(0.5), (c) => { cellPath(c, 1.0, 1.25, 0, Math.PI, br); c.fill(); });
  for (const k of [1, 0.74, 0.42]) seam(Lr, (c) => { c.beginPath(); c.ellipse(0, br.z, br.a * k, br.b * k, 0, -HPI, HPI); });
  for (let a = 0; a < 6; a++) { const ang = ((a + 0.5) / 6) * Math.PI; seam(Lr, (c) => { c.beginPath(); c.moveTo(br.a * 0.42 * Math.sin(ang), br.z - br.b * 0.42 * Math.cos(ang)); c.lineTo(br.a * Math.sin(ang), br.z - br.b * Math.cos(ang)); }); }
  Lr.paint('#1d2329', '#505050', ROUGH(0.2), (c) => { cellPath(c, 0, 0.13, 0, Math.PI, br); c.fill(); });
  // the apron behind the main shuttlebay's door: a darker deck with its guide lines, between two arms; then the spine
  Lr.paint('#8b989f', '#787878', ROUGH(0.62), (c) => c.fillRect(0, Z(272), 26, 46));
  Lr.paint('rgba(236,238,232,0.8)', null, null, (c) => { c.fillRect(0, Z(274), 0.35, 40); c.fillRect(8, Z(274), 0.3, 30); c.fillRect(16, Z(274), 0.3, 22); c.fillRect(0, Z(290), 22, 0.3); });
  Lr.paint(TONES[2], '#8a8a8a', ROUGH(0.42), (c) => { polyPath(c, ARM); c.fill(); });
  Lr.paint(TONES[1], '#868686', ROUGH(0.5), (c) => { polyPath(c, SPINE); c.fill(); });
  seam(Lr, (c) => polyPath(c, SPINE));
  for (const s of [330, 342, 354, 366]) seam(Lr, (c) => { c.beginPath(); c.moveTo(0, Z(s)); c.lineTo(27, Z(s)); });
  // small dark fittings scattered along the deck edges, and a few large hatches inboard
  for (let i = 0; i < 260; i++) {
    const r = [0.27, 0.41, 0.6, 0.705, 0.81, 0.93][Math.floor(rnd() * 6)] + (rnd() - 0.5) * 0.012, f = rnd() * Math.PI, x = SA * r * Math.sin(f), z = SC - SB * r * Math.cos(f);
    if (topBusy(x, z, 2)) continue;
    Lr.each((c) => { c.save(); c.translate(x, z); c.rotate(Math.atan2((z - SC) / (SB * SB), x / (SA * SA))); });
    Lr.paint(rnd() < 0.5 ? 'rgba(50,56,62,0.75)' : 'rgba(214,220,222,0.7)', null, null, (c) => c.fillRect(-0.5, -1.4 - rnd() * 1.6, 1, 2.4 + rnd() * 2));
    Lr.each((c) => c.restore());
  }
  for (const [r0, r1, f0, f1] of [[0.285, 0.325, 1.2, 1.32], [0.285, 0.325, 2.05, 2.17], [0.62, 0.66, 2.45, 2.52], [0.62, 0.66, 0.9, 0.97]]) {
    Lr.paint('#b9b2a0', '#9c9c9c', ROUGH(0.6), (c) => { cellPath(c, r0, r1, f0, f1); c.fill(); });
    Lr.paint('rgba(52,54,54,0.6)', '#585858', null, (c, k) => { c.lineWidth = [0.2, 0.36, 0.5][k]; cellPath(c, r0, r1, f0, f1); c.stroke(); });
  }
  return Lr.textures(1.5);
}

function paintBottom(rnd) {
  const Lr = planLayers((1536 * DETAIL) / PLAN_W);
  aztecRings(Lr, [0.135, 0.2, 0.26, 0.32, 0.38, 0.44, 0.5, 0.535, 0.565, 0.61, 0.65, 0.69, 0.735, 0.77, 0.81, 0.86, 0.9, 0.95, 0.992], rnd);
  for (const r of [0.26, 0.5, 0.735, 0.86]) Lr.paint('rgba(40,48,56,0.34)', 'rgba(52,52,52,0.9)', null, (c, k) => { c.lineWidth = [0.3, 0.5, 0.6][k]; c.beginPath(); c.ellipse(0, SC, SA * r, SB * r, 0, -HPI, HPI); c.stroke(); });
  Lr.paint('#5d676d', null, ROUGH(0.6), (c) => { cellPath(c, 0.982, 1.01, 0, Math.PI); c.fill(); });
  for (const r of [0.925, 0.885, 0.79, 0.63, 0.47]) hatchRing(Lr, r, rnd, (x, z) => botBusy(x, z, 2));
  // the middle: the captain's yacht in its dock, ringed
  Lr.paint(TONES[1], null, ROUGH(0.5), (c) => { cellPath(c, 0, 0.135, 0, Math.PI); c.fill(); });
  Lr.paint(TONES[2], '#8c8c8c', ROUGH(0.4), (c) => { c.beginPath(); c.ellipse(0, SC + 4, 15, 21, 0, -HPI, HPI); c.closePath(); c.fill(); });
  for (const [rx, rz] of [[15, 21], [9, 13]]) seam(Lr, (c) => { c.beginPath(); c.ellipse(0, SC + 4, rx, rz, 0, -HPI, HPI); });
  for (const r of [0.135, 0.105]) seam(Lr, (c) => { c.beginPath(); c.ellipse(0, SC, SA * r, SB * r, 0, -HPI, HPI); });
  for (const [r0, r1, f0, f1] of [[0.2, 0.25, 0.75, 0.9], [0.2, 0.25, 1.5, 1.64], [0.2, 0.25, 2.2, 2.35], [0.66, 0.7, 1.52, 1.6]]) {
    Lr.paint('#b9b2a0', '#9c9c9c', ROUGH(0.6), (c) => { cellPath(c, r0, r1, f0, f1); c.fill(); });
    Lr.paint('rgba(52,54,54,0.6)', '#585858', null, (c, k) => { c.lineWidth = [0.2, 0.36, 0.5][k]; cellPath(c, r0, r1, f0, f1); c.stroke(); });
  }
  return Lr.textures(1.5);
}

// The atlas everything but the saucer's two faces shares: [x, y, width, height] in texels of a 2048 square, and what each spans.
const AT = 2048;
const RECT = {
  eng: [0, 0, 1536, 640],            // across: stations 305..615; down: round the section from the dorsal line to the keel
  nac: [0, 656, 1280, 352],          // across: stations 390..645; down: round from the top to the underside
  neck: [1296, 656, 752, 352],       // across: stations 255..465; down: heights +8..-62
  pylT: [0, 1024, 600, 512],         // across: along the wing 0..145 m; down: stations 495..615. Upper skin.
  pylB: [616, 1024, 600, 512],       // the lower skin
  rim: [0, 1552, 2048, 56],          // across: round the rim from the bow to the stern; down: its height
  neckB: [1232, 1024, 176, 384],     // the neck's back, seen from astern: across: 0..32 m from the centerline; down: heights +8..-62
};
const inRect = ([x, y, w, h], fu, fv) => [(x + fu * w) / AT, 1 - (y + fv * h) / AT];
const UV = {
  eng: (p, i, j) => inRect(RECT.eng, (p[2] + HALF - 305) / 310, fold(j / 64)),
  neck: (p, i, j, qi, qj) => (qj >= 13 && qj <= 18 ? inRect(RECT.neckB, Math.abs(p[0]) / 32, (8 - p[1]) / 70) : inRect(RECT.neck, (p[2] + HALF - 255) / 210, (8 - p[1]) / 70)),      // (columns 13..19 of a section are its back)
  nac: (p) => inRect(RECT.nac, (p[2] + HALF - 390) / 255, fold(p[3] / TAU)),
  pyl: (upper, u, p) => inRect(upper ? RECT.pylT : RECT.pylB, u / 145, (p[2] + HALF - 495) / 120),
};

/** Paint inside a rectangle of the atlas, in the units it spans (mw across, mh down). */
function within(Lr, [x, y, w, h], mw, mh, fn) {
  Lr.each((c) => { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.translate(x, y); c.scale(w / mw, h / mh); });
  fn();
  Lr.each((c) => c.restore());
}
/** Two-tone plating in courses, each plate with a smaller one of the other tone let into it. */
function plating(Lr, mw, mh, cw, ch, rnd) {
  const seams = [];
  for (let r = 0; r * ch < mh; r++) for (let k = -1; k * cw < mw; k++) {
    const x = (k + (r & 1 ? 0.5 : 0)) * cw, y = r * ch, t = (k + r) & 1, tone = rnd() < 0.1 ? 2 : t;
    Lr.paint(TONES[tone], null, ROUGH(t ? 0.52 : 0.4), (c) => c.fillRect(x, y, cw, ch));
    seams.push([x, y, cw, ch]);
    if (rnd() < 0.8) {
      const q = [x + cw * [0, 0.33, 0.5][Math.floor(rnd() * 3)], y + (rnd() < 0.5 ? 0 : ch / 2), cw * [0.34, 0.5][Math.floor(rnd() * 2)], ch / 2];
      Lr.paint(TONES[tone === 2 ? 0 : 1 - t], null, ROUGH(t ? 0.4 : 0.52), (c) => c.fillRect(...q));
      seams.push(q);
    }
  }
  for (const q of seams) seam(Lr, (c) => { c.beginPath(); c.rect(...q); });
}
/** A pennant: two red stripes from x0 to x1 about the line y, pointed at the far end, behind an arrowhead at x0 (facing -x). */
function pennant(Lr, x0, x1, y, w, half = false) {
  const RED = '#a8201f';
  Lr.paint(RED, null, ROUGH(0.5), (c) => {
    for (const s of half ? [1] : [-1, 1]) { c.beginPath(); c.moveTo(x0 + w * 3, y + s * w * 0.3); c.lineTo(x1, y + s * w * 0.3); c.lineTo(x1 - w * 3, y + s * w * 0.95); c.lineTo(x0 + w * 3, y + s * w * 0.95); c.closePath(); c.fill(); }
    c.beginPath(); c.moveTo(x0 - w * 2.4, y); c.lineTo(x0 + w * 2.2, y + w * 2.1); c.lineTo(x0 + w * 1.1, y); if (!half) c.lineTo(x0 + w * 2.2, y - w * 2.1); c.closePath(); c.fill();
  });
}

function paintAtlas(rnd) {
  const Lr = layers(AT, AT, TONES[0]);
  // engineering hull
  within(Lr, RECT.eng, 310, 120, () => {
    plating(Lr, 310, 120, 15, 9, rnd);
    for (const y of [22, 47, 70, 96]) seam(Lr, (c) => { c.beginPath(); c.moveTo(0, y); c.lineTo(310, y); });
    for (const y of [34, 58]) for (let x = 60 + rnd() * 8, n = 0; x < 250; x += 5.2, n++) { if (n % 9 > 5) continue; hatch(Lr, x, y + (n % 2) * 0.01, 0, 3.1); }
    pennant(Lr, 392 - 305, 480 - 305, 120, 1.2, true);           // along the keel (the canvas's lower edge is the centerline)
    pennant(Lr, 468 - 305, 584 - 305, 0, 0.95, true);             // and down the dorsal line
  });
  // nacelle: the collar behind the dome, the copper band, the pennant down the top (the upper edge is the top's centerline)
  within(Lr, RECT.nac, 255, 70, () => {
    plating(Lr, 255, 70, 16, 8, rnd);
    Lr.paint('#737d84', '#707070', ROUGH(0.55), (c) => c.fillRect(423.5 - 390 - 2, 0, 11.5, 70));
    Lr.paint('#9a5a2c', null, ROUGH(0.38), (c) => c.fillRect(43, 0, 10, 70));
    for (let x = 43.4; x < 53; x += 1.25) Lr.paint('rgba(52,24,8,0.75)', '#3a3a3a', null, (c) => c.fillRect(x, 0, 0.45, 70));
    Lr.paint('#272b2f', '#606060', ROUGH(0.6), (c) => { c.fillRect(42.2, 0, 0.8, 70); c.fillRect(53, 0, 1.6, 70); });
    pennant(Lr, 470 - 390, 592 - 390, 0, 1.05, true);
    Lr.paint('#a8201f', null, null, (c) => { c.fillRect(630 - 390, 12, 5, 2.4); c.fillRect(630 - 390, 55, 5, 2.4); });
    for (const y of [17, 53]) seam(Lr, (c) => { c.beginPath(); c.moveTo(56, y); c.lineTo(250, y); });
  });
  within(Lr, RECT.neck, 210, 70, () => {
    plating(Lr, 210, 70, 13, 7, rnd);
    for (const y of [18, 30, 44]) seam(Lr, (c) => { c.beginPath(); c.moveTo(0, y); c.lineTo(210, y); });
  });
  // the neck's back: the doors of the two smaller shuttlebays under the saucer's stern (one painted: the port side mirrors it)
  within(Lr, RECT.neckB, 32, 70, () => {
    plating(Lr, 32, 70, 8, 5.5, rnd);
    Lr.paint('#3a4046', '#5c5c5c', ROUGH(0.6), (c) => c.fillRect(1.6, 13.4, 9.8, 5.6));
    Lr.paint('#c2ccd1', '#8a8a8a', ROUGH(0.4), (c) => c.fillRect(2.2, 14, 8.6, 4.4));
    for (let x = 3.6; x < 10.5; x += 1.43) Lr.paint('rgba(40,46,52,0.6)', '#606060', null, (c) => c.fillRect(x, 14, 0.14, 4.4));
  });
  for (const [rect, upper] of [[RECT.pylT, true], [RECT.pylB, false]]) within(Lr, rect, 145, 120, () => {
    plating(Lr, 145, 120, 14, 12, rnd);
    // a red line follows the leading edge out along the wing, a dark strip (the phasers) lies across the chord further aft
    Lr.paint('#a8201f', null, null, (c) => { c.lineWidth = 1.1; for (const d of upper ? [7, 9.2] : [7]) { c.beginPath(); for (let u = 58; u <= 136; u += 3) { const y = PY.le(u) - 495 + d; u === 58 ? c.moveTo(u, y) : c.lineTo(u, y); } c.stroke(); } });
    Lr.paint('#2a2d31', '#a8a8a8', ROUGH(0.55), (c) => c.fillRect(66, 585 - 495, upper ? 30 : 44, 1.8));
    if (!upper) for (const [x, y] of [[40, 30], [40, 62], [78, 62]]) { Lr.paint('#b9b2a0', '#9c9c9c', ROUGH(0.6), (c) => c.fillRect(x, y, 9, 14)); Lr.paint('rgba(52,54,54,0.6)', '#585858', null, (c) => { c.lineWidth = 0.3; c.strokeRect(x, y, 9, 14); }); }
  });
  // the rim: a dark line along each edge, sensor strips in lengths between the rows of windows
  within(Lr, RECT.rim, 660, 7, () => {
    Lr.paint(TONES[0], null, ROUGH(0.45), (c) => c.fillRect(0, 0, 660, 7));
    Lr.paint('#5d676d', null, null, (c) => { c.fillRect(0, 0, 660, 0.7); c.fillRect(0, 6.3, 660, 0.7); });
    for (let x = 14; x < 650; x += 38 + rnd() * 30) Lr.paint('#3d444a', '#6a6a6a', ROUGH(0.6), (c) => c.fillRect(x, 3.1, 14 + rnd() * 16, 0.8));
  });
  return Lr.textures(1.6);
}

/** Where the ship's floodlights fall, for the light maps: soft pools, in a canvas's own units. pools: [x, y, radius x, radius y, strength]. */
function floodMap(W, H, mw, mh, base, pools) {
  const [C, g] = canvas(W, H, `rgb(${base},${base},${base})`);
  g.scale(W / mw, H / mh); g.globalCompositeOperation = 'lighter';
  for (const [x, y, rx, ry, k] of pools) {
    g.save(); g.translate(x, y); g.scale(rx, ry);
    const gd = g.createRadialGradient(0, 0, 0, 0, 0, 1), v = Math.round(255 * k);
    gd.addColorStop(0, `rgb(${v},${v},${Math.round(v * 0.96)})`); gd.addColorStop(0.45, `rgba(${v},${v},${Math.round(v * 0.96)},0.55)`); gd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gd; g.fillRect(-1, -1, 2, 2); g.restore();
  }
  return tex(C, false);
}

// The lettering: a plain, squared face of even strokes, drawn here letter by letter. Each letter fills a box w by h from its top left corner.
const GLYPH = {
  N: (c, w, h) => { c.moveTo(0, h); c.lineTo(0, 0); c.lineTo(w, h); c.lineTo(w, 0); },
  C: (c, w, h, r) => { c.moveTo(w, h * 0.3); c.arcTo(w, 0, w - r, 0, r); c.arcTo(0, 0, 0, r, r); c.arcTo(0, h, r, h, r); c.arcTo(w, h, w, h - r, r); c.lineTo(w, h * 0.7); },
  0: (c, w, h, r) => { c.moveTo(r, 0); c.arcTo(w, 0, w, r, r); c.arcTo(w, h, w - r, h, r); c.arcTo(0, h, 0, h - r, r); c.arcTo(0, 0, r, 0, r); c.closePath(); },
  D: (c, w, h, r) => { c.moveTo(0, 0); c.arcTo(w, 0, w, r, r); c.arcTo(w, h, w - r, h, r); c.lineTo(0, h); c.closePath(); },
  U: (c, w, h, r) => { c.moveTo(0, 0); c.arcTo(0, h, r, h, r); c.arcTo(w, h, w, h - r, r); c.lineTo(w, 0); },
  S: (c, w, h, r) => { const q = Math.min(r, h * 0.24); c.moveTo(w, h * 0.24); c.arcTo(w, 0, w - q, 0, q); c.arcTo(0, 0, 0, q, q); c.arcTo(0, h / 2, q, h / 2, q); c.arcTo(w, h / 2, w, h / 2 + q, q); c.arcTo(w, h, w - q, h, q); c.arcTo(0, h, 0, h - q, q); c.lineTo(0, h * 0.76); },
  E: (c, w, h) => { c.moveTo(w, 0); c.lineTo(0, 0); c.lineTo(0, h); c.lineTo(w, h); c.moveTo(0, h / 2); c.lineTo(w * 0.8, h / 2); },
  T: (c, w, h) => { c.moveTo(0, 0); c.lineTo(w, 0); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); },
  R: (c, w, h, r) => { const q = Math.min(r, h * 0.24); c.moveTo(0, h); c.lineTo(0, 0); c.arcTo(w, 0, w, q, q); c.arcTo(w, h / 2, w - q, h / 2, q); c.lineTo(0, h / 2); c.moveTo(w * 0.45, h / 2); c.lineTo(w, h); },
  P: (c, w, h, r) => { const q = Math.min(r, h * 0.24); c.moveTo(0, h); c.lineTo(0, 0); c.arcTo(w, 0, w, q, q); c.arcTo(w, h / 2, w - q, h / 2, q); c.lineTo(0, h / 2); },
  I: (c, w, h) => { c.moveTo(w / 2, 0); c.lineTo(w / 2, h); },
  1: (c, w, h) => { c.moveTo(0, h * 0.26); c.lineTo(w * 0.7, 0); c.lineTo(w * 0.7, h); },
  7: (c, w, h) => { c.moveTo(0, 0); c.lineTo(w, 0); c.lineTo(w * 0.36, h); },
  '-': (c, w, h) => { c.moveTo(0, h / 2); c.lineTo(w, h / 2); },
  '.': (c, w, h) => { c.moveTo(w / 2, h * 0.88); c.lineTo(w / 2, h); },
};
const GLYPH_W = { I: 0.02, 1: 0.32, 7: 0.46, '-': 0.3, '.': 0.02, ' ': 0.3 };
/** Draw str with its top left at (x, y), letters h tall: black with a red outline. Returns [[x0, x1] of each letter]. */
function letter(g, str, x, y, h) {
  const wt = h * 0.155, gap = h * 0.21 + wt, spans = [];
  let cx = x + wt;
  for (const ch of str) { const w = (GLYPH_W[ch] ?? 0.5) * h; spans.push([cx - wt, cx + w + wt]); cx += w + gap; }
  for (const [color, width] of [['#b3221f', wt * 1.75], ['#131416', wt]]) {
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'miter'; g.miterLimit = 3; g.lineCap = 'butt';
    [...str].forEach((ch, i) => { if (!GLYPH[ch]) return; g.save(); g.translate(spans[i][0] + wt, y); g.beginPath(); GLYPH[ch](g, (GLYPH_W[ch] ?? 0.5) * h, h, h * 0.2); g.stroke(); g.restore(); });
  }
  return spans;
}
/** The decals' canvas (transparent but for the letters) and where each piece is on it, as [u0, v0, u1, v1] with v down the canvas. */
function paintLettering() {
  const W = 2048, H = 512, [C, g] = canvas(W, H);
  const reg = letter(g, 'NCC-1701-D', 30, 44, 230), name = letter(g, 'U.S.S. ENTERPRISE', 30, 356, 112);
  const box = (spans, i0, i1, y, h) => [(spans[i0][0] - 18) / W, (y - 22) / H, (spans[i1][1] + 18) / W, (y + h + 22) / H];
  const t = tex(C, true);
  return { tex: t, reg: box(reg, 0, reg.length - 1, 44, 230), name: box(name, 0, name.length - 1, 356, 112), ship: box(name, 7, name.length - 1, 356, 112), aspect: (b) => ((b[2] - b[0]) * W) / ((b[3] - b[1]) * H) };
}

/** The deflector dish in its own plane (88 by 44 m about its center): color, and what glows. */
function paintDish() {
  const W = 512, H = 256, [C, g] = canvas(W, H, '#15110e'), [E, e] = canvas(W, H, '#000000');
  for (const c of [g, e]) { c.translate(W / 2, H / 2); c.scale(W / 88, -H / 44); }
  const oval = (c, k) => { c.beginPath(); c.ellipse(0, 0, 44 * k, 21 * k, 0, 0, TAU); };
  // the copper dish, ribbed in rings
  let gd = g.createRadialGradient(0, 0, 4, 0, 0, 40); gd.addColorStop(0, '#c97a3a'); gd.addColorStop(1, '#8a4a1e');
  g.save(); g.scale(1, 21 / 44); g.fillStyle = gd; g.beginPath(); g.arc(0, 0, 44 * 0.87, 0, TAU); g.fill(); g.restore();
  gd = e.createRadialGradient(0, 0, 4, 0, 0, 40); gd.addColorStop(0, '#8a3c10'); gd.addColorStop(0.5, '#56240a'); gd.addColorStop(1, '#2a1004');
  e.save(); e.scale(1, 21 / 44); e.fillStyle = gd; e.beginPath(); e.arc(0, 0, 44 * 0.87, 0, TAU); e.fill(); e.restore();
  for (let k = 0.42; k < 0.87; k += 0.035) for (const [c, col] of [[g, 'rgba(48,22,8,0.7)'], [e, 'rgba(0,0,0,0.6)']]) { c.strokeStyle = col; c.lineWidth = 0.38; oval(c, k); c.stroke(); }
  for (let a = 0; a < 24; a++) { const ca = Math.cos((a / 24) * TAU), sa = Math.sin((a / 24) * TAU); for (const [c, col] of [[g, 'rgba(48,22,8,0.5)'], [e, 'rgba(0,0,0,0.4)']]) { c.strokeStyle = col; c.lineWidth = 0.3; c.beginPath(); c.moveTo(44 * 0.4 * ca, 21 * 0.4 * sa); c.lineTo(44 * 0.87 * ca, 21 * 0.87 * sa); c.stroke(); } }
  // the middle: blue-white
  g.fillStyle = '#31506e'; oval(g, 0.385); g.fill(); g.strokeStyle = '#1c232b'; g.lineWidth = 0.7; g.stroke();
  e.save(); e.scale(1, 21 / 44); gd = e.createRadialGradient(0, 0, 0, 0, 0, 44 * 0.385); gd.addColorStop(0, '#ffffff'); gd.addColorStop(0.3, '#cfe6ff'); gd.addColorStop(0.7, '#62a8ff'); gd.addColorStop(1, '#1f55b8'); e.fillStyle = gd; e.beginPath(); e.arc(0, 0, 44 * 0.385, 0, TAU); e.fill(); e.restore();
  for (const k of [0.3, 0.2]) { e.strokeStyle = 'rgba(10,30,80,0.5)'; e.lineWidth = 0.3; oval(e, k); e.stroke(); }
  return { map: tex(C, true), emissiveMap: tex(E, true) };
}

/** Soft blotches that tile round: what swirls inside the Bussard collectors. hot: the brighter inner layer. */
function paintSwirl(seed, hot) {
  const W = 256, H = 128, [C, g] = canvas(W, H, hot ? '#5a0d04' : '#2a0502'), rnd = rng(seed);
  for (let i = 0; i < (hot ? 46 : 30); i++) {
    const x = rnd() * W, y = (0.15 + 0.85 * rnd()) * H, r = 14 + rnd() * 34, a = 0.25 + rnd() * 0.5, col = hot ? (rnd() < 0.4 ? '255,150,60' : '255,60,24') : '255,40,20';
    for (const ox of [0, W, -W]) { const gd = g.createRadialGradient(x + ox, y, 0, x + ox, y, r); gd.addColorStop(0, `rgba(${col},${a})`); gd.addColorStop(1, `rgba(${col},0)`); g.fillStyle = gd; g.fillRect(x + ox - r, y - r, 2 * r, 2 * r); }
  }
  if (hot) for (let k = 0; k < 16; k++) { g.fillStyle = 'rgba(30,2,0,0.5)'; g.fillRect((k / 16) * W, 0, 3, H); }       // the vanes behind the glass
  const t = tex(C, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}
/** The warp grille's glow: a bright core between ruled lines, crossed by the coils' dividers; it tiles along the nacelle. */
function paintGrille() {
  const W = 128, H = 64, [C, g] = canvas(W, H, '#000');
  const gd = g.createLinearGradient(0, 0, 0, H); gd.addColorStop(0, '#16327a'); gd.addColorStop(0.3, '#5f9cff'); gd.addColorStop(0.5, '#e6f2ff'); gd.addColorStop(0.7, '#5f9cff'); gd.addColorStop(1, '#16327a');
  g.fillStyle = gd; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(4,10,40,0.62)'; for (let y = 4; y < H; y += 8) g.fillRect(0, y, W, 2.4);
  g.fillStyle = 'rgba(4,10,40,0.8)'; g.fillRect(0, 0, 3, H); g.fillRect(W / 2, 0, 1.5, H);
  const t = tex(C, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}
/** An impulse exhaust: glowing slots in a dark grid. */
function paintExhaust() {
  const W = 256, H = 64, [C, g] = canvas(W, H, '#000');
  for (let x = 0; x < 10; x++) for (let y = 0; y < 2; y++) {
    const x0 = 14 + x * 22.8, y0 = 13 + y * 20, gd = g.createLinearGradient(0, y0, 0, y0 + 18);
    gd.addColorStop(0, '#8a1c06'); gd.addColorStop(0.5, '#ffc890'); gd.addColorStop(1, '#8a1c06'); g.fillStyle = gd; g.fillRect(x0 + 1.5, y0 + 1, 19.8, 16);
  }
  return tex(C, true);
}
function paintHalo() {
  const [C, g] = canvas(64, 64), gd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gd.addColorStop(0, 'rgba(255,255,255,1)'); gd.addColorStop(0.18, 'rgba(255,255,255,0.75)'); gd.addColorStop(0.5, 'rgba(255,255,255,0.16)'); gd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gd; g.fillRect(0, 0, 64, 64);
  return tex(C, true);
}

// ---------------------------------------------------------------- the parts

const COLS = 144;                                        // facets round the saucer
const ringRows = (surf, rs) => rs.map((r) => Array.from({ length: COLS }, (_, j) => surf((j / COLS) * TAU, r)));
const range = (a, b, step) => { const out = []; for (let x = a; x < b - 1e-9; x += step) out.push(x); return out; };

/** A raised deck on the saucer's top: outline in plan [[x, z], ...], standing lift(x, z) over the dome. Returns [wall, top]. */
function plateau(outline, c, lift) {
  const ring = (k, dy) => outline.map(([x, z]) => { const X = c[0] + (x - c[0]) * k, Zz = c[1] + (z - c[1]) * k; return [X, TOP_H(Math.min(0.992, rhoAt(X, Zz))) + (dy ?? lift(X, Zz)), Zz]; });
  const wall = gridGeo([ring(1, -0.6), ring(0.985)], { closed: true, out: (p) => [p[0] - c[0], 0, p[2] - c[1]], uv: uvPlan });
  const top = gridGeo([0.985, 0.94, 0.86, 0.74, 0.6, 0.45, 0.3, 0.16, 0.04].map((k) => ring(k)), { closed: true, out: UP, uv: uvPlan });
  return [wall, top];
}

function buildSaucer(B, G) {
  const rt = [0.02, ...range(0.05, 0.93, 0.0275), 0.94, 0.958, 0.972, 0.983, 0.992], rb = [0.02, 0.05, 0.08, ...range(0.105, 0.7, 0.0275), 0.71, 0.735, 0.757, 0.78, 0.81, 0.84, 0.87, 0.9, 0.93, 0.955, 0.975, 0.992];
  B.top.push(gridGeo(ringRows(topSurf, rt), { closed: true, out: UP, uv: uvPlan }));
  B.bottom.push(gridGeo(ringRows(botSurf, rb), { closed: true, out: DOWN, uv: uvPlan }));
  const rim = [[0.992, 3.5], [1, 2.4], [1, -2.4], [0.992, -3.5]].map(([r, y]) => Array.from({ length: COLS }, (_, j) => { const f = (j / COLS) * TAU; return [SA * r * Math.sin(f), y, SC - SB * r * Math.cos(f)]; }));
  B.hull.push(gridGeo(rim, { closed: true, inside: [0, 0, SC], uv: (p, i, j) => inRect(RECT.rim, fold(j / COLS), (3.5 - p[1]) / 7) }));

  // superstructure, the shuttlebay apron's arms, the spine; the bridge on top
  B.top.push(...plateau(supOutline, [0, Z(215)], supLift));
  for (const sd of [1, -1]) B.top.push(...plateau(ARM.map(([x, s]) => [sd * x, Z(s)]), [sd * 36, Z(290)], armLift));
  B.top.push(...plateau([...SPINE.slice(1, -1), ...SPINE.slice(1, -1).reverse().map(([x, s]) => [-x, s])].map(([x, s]) => [x, Z(s)]), [0, Z(350)], () => 1.5));
  const bz = Z(BRIDGE.s), by = BRIDGE.top - 3.3;
  const dome = [[1, -1.2], [1, 0.5], [0.92, 1.5], [0.78, 2.2], [0.565, 2.7], [0.3, 2.9], [0.15, 2.95], [0.11, 3.24], [0.02, 3.3]].map(([k, y]) => Array.from({ length: 36 }, (_, j) => [BRIDGE.rx * k * Math.sin((j / 36) * TAU), by + y, bz - BRIDGE.rz * k * Math.cos((j / 36) * TAU)]));
  B.top.push(gridGeo(dome, { closed: true, out: (p) => [p[0], 6, p[2] - bz], uv: uvPlan }));
  // the main shuttlebay's door across the stern of the superstructure: a wide segmented shutter in a dark frame
  const zd = Z(SUP.s1) + 0.25, doors = [], y0 = (x) => TOP_H(rhoAt(x, zd)) - 0.1, y1 = (x) => TOP_H(rhoAt(x, zd)) + supLift(x, zd) - 0.7;
  for (let k = -12; k < 12; k++) { const xa = k * 2.1, xb = xa + 2.1, c = k & 1 ? [0.5, 0.53, 0.55] : [0.58, 0.61, 0.63]; doors.push({ pts: [[xa + 0.07, y0(xa), zd], [xb - 0.07, y0(xb), zd], [xb - 0.07, y1(xb), zd], [xa + 0.07, y1(xa), zd]], rgb: c }); }
  doors.push({ pts: [[-26.6, y0(26) - 0.3, zd - 0.1], [26.6, y0(26) - 0.3, zd - 0.1], [26.6, y1(26) + 0.5, zd - 0.1], [-26.6, y1(26) + 0.5, zd - 0.1]], rgb: DARK });
  B.detail.push(facets(doors));

  // phaser strips: the horseshoe on top, a ring underneath
  B.detail.push(strip(topSurf, UP, 0.69, -152 * D2R, 152 * D2R, 150, 3.2, 0.55, STRIP));
  B.detail.push(strip(botSurf, DOWN, 0.55, -150 * D2R, 150 * D2R, 140, 3.0, 0.5, STRIP));

  // maneuvering thrusters on the rim, and the saucer's own impulse engines on its stern quarters
  const at = (f, w, d, h, rgb, dy = 0) => { const tx = SA * Math.cos(f), tz = SB * Math.sin(f); return box(w, h, d, [SA * Math.sin(f), dy, SC - SB * Math.cos(f)], rgb, [0, Math.atan2(-tz, tx), 0]); };
  for (const f of [55, 125, 235, 305]) B.detail.push(at(f * D2R, 10, 1.8, 5, [0.46, 0.24, 0.12]), at(f * D2R, 3.4, 2.1, 1.3, [0.05, 0.045, 0.04], 1.15), at(f * D2R, 3.4, 2.1, 1.3, [0.05, 0.045, 0.04], -1.15), ...[-1, 1].map((k) => at(f * D2R + (k * 3.3) / 200, 1.5, 2.1, 3.4, [0.05, 0.045, 0.04])));
  const engines = [];
  for (const f of [180 + 31.7, 180 - 31.7]) {          // port, then starboard
    const a = f * D2R, c = rimSurf(a, 0), n = unit(rimOut(c)), t = unit([SA * Math.cos(a), 0, SB * Math.sin(a)]);
    B.detail.push(at(a, 26, 5, 4.8, [0.36, 0.39, 0.42]));
    B.impulse.push(glowFace(along(c, n, 2.6), t, UP, n, 11.6, 1.7));
    engines.push(new THREE.Vector3(...along(c, n, 2.6)));
  }
  // the dome under the middle
  B.detail.push(revolve([[11.5, 0.4], [11.5, -0.3], [9.5, -1.1], [6, -1.7], [2.5, -1.9], [0, -1.92]].reverse(), { seg: 32, rgb: [0.3, 0.33, 0.36], crease: 40 }).translate(0, BOT_H(0) + 0.2, SC));

  // windows: rings of them over the top and the underside (long side up the slope), two rows round the rim
  for (const r of [0.972, 0.915, 0.885, 0.795, 0.725, 0.655, 0.62, 0.515, 0.43, 0.35, 0.32, 0.245]) G.row(topSurf, UP, r, 0, TAU, { skip: (p) => topBusy(p[0], p[2], 1.5) });
  for (const r of [0.968, 0.94, 0.86, 0.765, 0.69, 0.665, 0.595, 0.49, 0.41, 0.29, 0.235, 0.17]) G.row(botSurf, DOWN, r, 0, TAU, { skip: (p) => botBusy(p[0], p[2], 1.5) });
  // and along the superstructure: round its wall, and two rings over its top
  const NS = supOutline.length, cz = Z(215), edge = (u, k) => { const i = Math.floor(u), a = supOutline[((i % NS) + NS) % NS], b = supOutline[(((i + 1) % NS) + NS) % NS]; return [lerp(a[0], b[0], u - i) * k, cz + (lerp(a[1], b[1], u - i) - cz) * k]; };
  const supTop = (u, k) => { const [x, z] = edge(u, k); return [x, TOP_H(rhoAt(x, z)) + supLift(x, z), z]; }, supWall = (u, v) => { const [x, z] = edge(u, 0.992); return [x, TOP_H(rhoAt(x, z)) + v * supLift(x, z), z]; };
  const astern = (p) => p[2] > Z(SUP.s1) - 1.5, round = (f, k) => { const x = BRIDGE.rx * k * Math.sin(f), z = bz - BRIDGE.rz * k * Math.cos(f); return [x, TOP_H(rhoAt(x, z)) + supLift(x, z), z]; };
  G.row(round, UP, 1.5, 0, TAU, { pitch: 2.2, w: 0.8, h: 1.7, group: [3, 6], gap: [2, 4] });
  G.row(supWall, (p) => [p[0], 0, p[2] - cz], 0.56, 0, NS, { pitch: 2.4, w: 0.95, h: 1.25, group: [3, 8], gap: [2, 6], skip: astern, eu: 1e-3, ev: 1e-3 });
  for (const k of [0.9, 0.7]) G.row(supTop, UP, k, 0, NS, { pitch: 2.8, w: 1.0, h: 2.6, group: [2, 4], gap: [3, 9], skip: (p) => astern(p) || Math.hypot(p[0], p[2] - bz) < 24, eu: 1e-3, ev: 1e-3 });
  const rimSkip = (p) => { const f = (Math.atan2(p[0] / SA, -(p[2] - SC) / SB) / D2R + 360) % 360; return [55, 125, 235, 305].some((q) => Math.abs(f - q) < 2.2) || Math.abs(f - 148.3) < 4.6 || Math.abs(f - 211.7) < 4.6 || Math.abs(f - 180) < 8.5; };
  for (const y of [1.2, -1.2]) G.row(rimSurf, rimOut, y, 0.06, TAU - 0.06, { pitch: 2.5, w: 1.0, h: 1.7, group: [3, 9], gap: [2, 8], skip: rimSkip, ev: 0.05 });
  G.row(rimSurf, rimOut, 0.9, -0.05, 0.05, { pitch: 1.7, w: 1.15, h: 2.5, lit: 0.93, group: [99, 99], gap: [0, 0], ev: 0.05 });          // the forward lounge's tall windows across the bow
  return engines;
}

/** A glowing rectangle (an impulse exhaust) centered at c, hw by hh, facing n. */
function glowFace(c, ax, ay, n, hw, hh) {
  const a = dot(cross(ax, ay), n) < 0 ? [-ax[0], -ax[1], -ax[2]] : ax, pt = (x, y) => [c[0] + a[0] * x * hw + ay[0] * y * hh, c[1] + a[1] * x * hw + ay[1] * y * hh, c[2] + a[2] * x * hw + ay[2] * y * hh];
  return facets([[pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)]], ONE, { uv: (p) => [0.5 + dot(sub(p, c), a) / (2 * hw), 0.5 + dot(sub(p, c), ay) / (2 * hh)] });
}

function buildNeck(B, G) {
  const K = 16, taus = Array.from({ length: K + 1 }, (_, k) => 0.5 - 0.5 * Math.cos((Math.PI * k) / K));
  const ring = (y, k = 1, dy = 0) => { const st = neckSurf(1), row = []; for (let i = 0; i <= K; i++) { const p = st(taus[i], y); row.push([p[0] * k, y + dy, p[2]]); } for (let i = K - 1; i >= 1; i--) { const p = st(taus[i], y); row.push([-p[0] * k, y + dy, p[2]]); } return row; };
  const top = NK.levels[NK.levels.length - 1], rows = [...NK.levels.map((y) => ring(y)), ring(top, 0.7, 0.7), ring(top, 0.02, 0.95)];
  B.hull.push(gridGeo(rows, { closed: true, out: (p) => [p[0], 0.3, 0], uv: UV.neck }));
  for (const sd of [1, -1]) {
    const st = neckSurf(sd), out = [sd, 0, 0];
    B.detail.push(strip(st, out, -22.5, 0.3, 0.8, 30, 2.4, 0.4, STRIP, 1e-4, 0.05));
    for (const y of [-9, -13, -17, -27, -31, -35, -39, -43]) G.row(st, out, y, y > -20 ? 0.34 : 0.14, y < -37 ? 0.72 : 0.9, { pitch: 2.6, w: 1.0, h: 2.2, group: [2, 5], gap: [2, 9], ev: 0.05, skip: (p) => p[1] > BOT_H(Math.min(0.992, rhoAt(p[0], p[2]))) - 1 && rhoAt(p[0], p[2]) < 1 });
  }
  // the main impulse engine: a wedge standing off the sloping back of the neck, its exhaust in the square stern face
  const ys = -38.3, za = Z(438.5), zf = Z(428.5), end = (z, hw, yt, yb) => [[-hw, yt, z], [hw, yt, z], [hw, yb, z], [-hw, yb, z]];
  B.detail.push(hexa([...end(zf, 12, -33.8, -40), ...end(za, 13.6, -34.6, -42)], [0.36, 0.39, 0.42]));
  B.impulse.push(glowFace([0, ys, za + 0.1], [1, 0, 0], UP, [0, 0, 1], 12.4, 2.6));
  return new THREE.Vector3(0, ys, za + 0.1);
}

function buildHull(B, G) {
  const NA = 64, secs = EH.stations.map((s) => hullSec(s));
  const rows = EH.stations.map((s, i) => Array.from({ length: NA }, (_, j) => hullAt(s, (j / NA) * TAU, secs[i])));
  B.hull.push(gridGeo(rows, { closed: true, out: hullOut, uv: UV.eng }));
  // the deflector: the mouth's lip and well, then the dish itself in its own material
  const mouth = rows[0], ringOf = (k, d) => mouth.map((p) => { const q = [DISH.c[0] + (p[0] - DISH.c[0]) * k, DISH.c[1] + (p[1] - DISH.c[1]) * k, DISH.c[2] + (p[2] - DISH.c[2]) * k]; return along(q, DISH.in, d); });
  B.detail.push(gridGeo([ringOf(1, 0), ringOf(0.95, 1.2), ringOf(0.9, 5.5), ringOf(0.868, 6.2)], { closed: true, out: DISH.n, rgb: [0.11, 0.125, 0.15] }));
  const duv = (p) => { const q = sub(p, DISH.c); return [0.5 + dot(q, DISH.x) / 88, 0.5 + dot(q, DISH.u) / 44]; };
  B.dish.push(gridGeo([ringOf(0.868, 6.2), ringOf(0.7, 7.5), ringOf(0.52, 8.5), ringOf(0.385, 9.0), ringOf(0.37, 8.3), ringOf(0.22, 7.6), ringOf(0.08, 7.15), ringOf(0.002, 7.1)], { closed: true, out: DISH.n, uv: duv }));
  // the sensor strip along the widest line, a small dome under the keel
  for (const a of [HPI, 3 * HPI]) B.detail.push(strip(hullAt, hullOut, a, 345, 502, 50, 2.6, 0.45, STRIP, 0.05, 1e-4));
  B.detail.push(revolve([[0, -1.25], [2.2, -1.0], [3.6, -0.3], [3.8, 0.4]], { seg: 20, rgb: [0.3, 0.33, 0.36] }).translate(0, -102.45, Z(446)));
  // windows, in rows along the decks
  const skip = (p) => inNeck(p, 5) || (p[2] + HALF > 500 && p[1] < -66);
  for (const a of [14, 24, 34, 44, 54, 63, 71, 79, 101, 110, 120, 132]) for (const sd of [1, -1]) {
    const al = sd > 0 ? a * D2R : TAU - a * D2R;
    G.row(hullAt, hullOut, al, a < 90 ? 334 : 352, a < 60 ? 585 : a < 90 ? 540 : 492, { pitch: 2.8, w: 1.05, h: 2.5, group: [2, 5], gap: [3, 12], eu: 0.05, skip });
  }
  return new THREE.Vector3(...along(DISH.c, DISH.in, 7.1));
}

function buildPylons(B) {
  const k = PY.sec, n = k.length;
  for (const sd of [1, -1]) {
    // each section: round from the leading edge over the upper skin to the trailing edge and back under
    const rows = PY.spans.map((u) => { const row = []; for (let i = 0; i < n; i++) row.push([...pylonAt(sd, u, k[i][0], 1), u]); for (let i = n - 1; i >= 1; i--) row.push([...pylonAt(sd, u, k[i][0], -1), u]); return row; });
    const mid = PY.spans.map((u) => pylonPath(u));
    B.hull.push(gridGeo(rows, { closed: true, out: (p, i) => [p[0] - sd * mid[i][0], p[1] - mid[i][1], 0], uv: (p, i, j, qi, qj) => (qj === n - 1 ? BLANK : UV.pyl(qj < n - 1, p[3], p)) }));
  }
}

function buildNacelles(B) {
  const band = (j) => (j >= 9 && j < 13) || (j >= 29 && j < 33), edge = (j) => j === 8 || j === 13 || j === 28 || j === 33;
  const i0 = NC.rows.findIndex(([s]) => s === NC.g0), i1 = NC.rows.findIndex(([s]) => s === NC.g1);
  const centers = [], tips = [];
  for (const sd of [-1, 1]) {
    const rows = NC.rows.map(([s, k]) => nacAngles(s).map((al) => [...nacAt(sd, s, al, k), al]));
    const out = (p) => [p[0] - sd * NX, p[1] - NY, 0.02 * (p[2] - Z(520))], grille = (i, j) => i >= i0 && i < i1 && band(j);
    B.hull.push(gridGeo(rows, { closed: true, out, pick: (i, j) => !grille(i, j), uv: UV.nac, color: (p, i, j, qi, qj) => (qi === 0 ? [0.05, 0.012, 0.01] : qi >= i0 && qi < i1 && edge(qj) ? [0.2, 0.22, 0.25] : ONE) }));
    B.grille.push(gridGeo(rows, { closed: true, out, pick: grille, uv: (p, i, j) => [((p[2] + HALF - NC.g0) / (NC.g1 - NC.g0)) * 30, (j >= 29 ? j - 29 : j - 9) / 4] }));
    // the Bussard collector: a glass dome over a glowing core
    const dome = (k) => { const P = []; for (let i = 0; i <= 12; i++) { const c = Math.cos(lerp(0.03, HPI, i / 12)), rf = Math.pow(1 - Math.pow(c, 2.7), 0.56) * k, row = []; for (let j = 0; j < 28; j++) { const a = (j / 28) * TAU; row.push([sd * (NX + 15.4 * rf * Math.sin(a)), NY + 7.75 * rf * Math.cos(a), Z(NC.s0 - (NC.s0 - NC.tip) * c * k), i]); } P.push(row); } return P; };
    const duv = (p, i, j) => [j / 28, p[3] / 12], dout = (p) => [p[0] - sd * NX, p[1] - NY, -4];
    B.bussardOut.push(gridGeo(dome(1), { closed: true, out: dout, uv: duv }));
    B.bussardIn.push(gridGeo(dome(0.86), { closed: true, out: dout, uv: duv }));
    centers.push(new THREE.Vector3(sd * NX, (NC.top(518) + NC.bot(518)) / 2, Z((NC.tip + NC.s1) / 2))); tips.push(new THREE.Vector3(sd * NX, NY, Z(NC.tip)));
  }
  return { centers, tips };
}

/** The lettering, on patches that follow the hull. */
function buildDecals(B, L) {
  const pic = (b, a, t) => [lerp(b[0], b[2], a), 1 - lerp(b[1], b[3], t)];      // a: 0..1 along the text, t: 0..1 down it
  // saucer, top: the registry arcs across the bow, read from astern, with the name above it
  const arc = (surf, out, b, r, hgt, flip) => { const dr = hgt / SB, wid = hgt * L.aspect(b), f0 = Math.asin(Math.min(0.99, wid / 2 / (SA * r))); return patch(surf, out, -f0, f0, r - dr / 2, r + dr / 2, 40, 4, (fu, fv) => pic(b, flip ? 1 - fu : fu, 1 - fv)); };
  B.decal.push(arc(topSurf, UP, L.reg, 0.455, 24.5, false), arc(topSurf, UP, L.name, 0.575, 10.4, false));
  B.decal.push(arc(botSurf, DOWN, L.reg, 0.37, 14.5, true));
  // the registry again on the outboard face of each pylon, and the name on each side of the neck: read from that side
  for (const sd of [1, -1]) {
    const h = 6.6, w = h * L.aspect(L.reg), ua = PY.u1 + 4.5, sm = 568, st = (u, s) => pylonAt(sd, u, (s - PY.le(u)) / (PY.te(u) - PY.le(u)), -1);
    B.decal.push(patch(st, [sd, -0.4, 0], ua, ua + h, sm - w / 2, sm + w / 2, 2, 8, (fu, fv) => pic(L.reg, sd > 0 ? 1 - fv : fv, 1 - fu), 0.05, 0.05));
    const hn = 3.4, wn = hn * L.aspect(L.ship), yn = -27.5, nk = (s, y) => { const le = NK.le(y), te = NK.te(y); return neckSurf(sd)((s - le) / (te - le), y); };
    B.decal.push(patch(nk, [sd, 0, 0], 330, 330 + wn, yn - hn / 2, yn + hn / 2, 8, 2, (fu, fv) => pic(L.ship, sd > 0 ? 1 - fu : fu, 1 - fv), 0.05, 0.05));
  }
}

export function buildEnterprise(o = {}) {
  DETAIL = Math.max(0.25, Math.min(1, o.detail || 1));
  const rnd = rng(1701), L = paintLettering(), halo = paintHalo(), exhaust = paintExhaust();
  const plan = (t, base, pools) => ({ ...t, lightMap: floodMap(128, 216, PLAN_W, PLAN_L, base, pools), lightMapIntensity: 0, roughness: 1, metalness: 0.1, vertexColors: true });
  const M = {
    top: new THREE.MeshStandardMaterial(plan(paintTop(rnd), 16, [[0, SC - 0.47 * SB - PLAN_Z0, 92, 46, 0.9], [0, Z(206) - PLAN_Z0, 40, 40, 0.5], [0, Z(296) - PLAN_Z0, 32, 36, 0.4]])),
    bottom: new THREE.MeshStandardMaterial(plan(paintBottom(rnd), 16, [[0, SC - 0.37 * SB - PLAN_Z0, 62, 36, 0.9], [0, SC - PLAN_Z0, 40, 40, 0.35], [0, Z(300) - PLAN_Z0, 60, 50, 0.3]])),
    hull: new THREE.MeshStandardMaterial({ ...paintAtlas(rnd), lightMap: floodMap(256, 256, AT, AT, 14, [[300, 250, 520, 330, 0.5], [1100, 200, 520, 330, 0.4], [1670, 830, 330, 150, 0.6], [616 + 480, 1280, 150, 200, 0.9], [480, 1280, 150, 200, 0.5], [420, 700, 420, 110, 0.6]]), lightMapIntensity: 0, roughness: 1, metalness: 0.1, vertexColors: true }),
    detail: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.15 }),
    // (what lies on the skin is drawn a little toward the eye, or from far off the depth buffer cannot tell it from the hull under it)
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.16, metalness: 0, ...NEARER }),
    lit: new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, ...NEARER }),
    decal: new THREE.MeshLambertMaterial({ map: L.tex, transparent: true, alphaTest: 0.04, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    dish: new THREE.MeshStandardMaterial({ ...paintDish(), emissive: 0xffffff, emissiveIntensity: ENTERPRISE_GLOW.dish, roughness: 0.42, metalness: 0.5 }),
    bussardIn: new THREE.MeshBasicMaterial({ map: paintSwirl(11, true), fog: false }),
    bussardOut: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.03, 0.015), emissive: new THREE.Color(1, 0.1, 0.04), emissiveMap: paintSwirl(23, false), emissiveIntensity: 1, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false }),
    grille: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.02, 0.04, 0.09), emissive: new THREE.Color(0.38, 0.62, 1), emissiveMap: paintGrille(), emissiveIntensity: ENTERPRISE_GLOW.grilleIdle, roughness: 0.3, metalness: 0.2 }),
    impulse: new THREE.MeshStandardMaterial({ color: new THREE.Color(0.05, 0.01, 0.006), emissive: new THREE.Color(1, 0.2, 0.06), emissiveMap: exhaust, emissiveIntensity: ENTERPRISE_GLOW.impulseIdle, roughness: 0.5, ...NEARER }),
  };
  const B = { top: [], bottom: [], hull: [], detail: [], decal: [], dish: [], bussardIn: [], bussardOut: [], grille: [], impulse: [] }, G = new Glass(1987);
  const saucerEngines = buildSaucer(B, G), mainEngine = buildNeck(B, G), deflector = buildHull(B, G);
  buildPylons(B);
  const nac = buildNacelles(B);
  buildDecals(B, L);
  const panes = G.geometries();

  const root = new THREE.Group(); root.name = 'Enterprise';
  const add = (list, mat, cast, recv, order = 0) => { const m = meshOf(list, mat, cast, recv); if (m) { m.renderOrder = order; m.userData.noShadow = !cast; root.add(m); } return m; };
  add(B.top, M.top, true, true); add(B.bottom, M.bottom, true, true); add(B.hull, M.hull, true, true);
  add(B.detail, M.detail, false, true); add(B.dish, M.dish, false, true); add(B.grille, M.grille, false, false); add(B.impulse, M.impulse, false, false);
  add([panes.dark], M.glass, false, true); add([panes.lit], M.lit, false, false);
  add(B.bussardIn, M.bussardIn, false, false); add(B.decal, M.decal, false, false, 1); add(B.bussardOut, M.bussardOut, false, false, 2);

  // running lights: red to port, green to starboard, white strobes
  const lamps = (pts, rgb) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    const m = new THREE.Points(g, new THREE.PointsMaterial({ map: halo, size: 9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, color: new THREE.Color(...rgb).multiplyScalar(ENTERPRISE_GLOW.lamp) }));
    m.renderOrder = 3; m.frustumCulled = false; root.add(m);
    return m;
  };
  const sideLamps = (sd) => [[sd * SA * 0.978, 4.9, SC], [sd * SA * 0.978, -4.6, SC], [sd * (NX + 21.5), -27.5, Z(452)], [sd * (NX + 25.5), -28.5, Z(622)], [sd * 70, -79.5, Z(430)]];
  const red = lamps(sideLamps(-1), [1, 0.05, 0.03]), green = lamps(sideLamps(1), [0.05, 1, 0.2]);
  const strobe = lamps([[0, 31.6, Z(236)], [0, BOT_H(0) - 2.4, SC], [NX, -21.4, Z(630)], [-NX, -21.4, Z(630)], [0, -104, Z(446)], [0, 5.6, Z(382)]], [1, 1, 1]);

  let swirl = 0, last = null;
  const ship = {
    id: 'enterprise', root, length: LENGTH, beam: BEAM, height: HEIGHT,
    // (in root coordinates. impulse: the main exhaust on the back of the neck, then the saucer's two, port and starboard; nacelles and bussards: port, starboard)
    points: {
      bridge: new THREE.Vector3(0, BRIDGE.top, Z(BRIDGE.s)),
      impulse: [mainEngine, ...saucerEngines],
      nacelles: nac.centers, bussards: nac.tips, deflector,
    },
    update(dt, s = {}) {
      const E = ENTERPRISE_GLOW, t = s.time || 0, warp = clamp01(s.warp || 0), imp = clamp01(s.impulse || 0), night = clamp01(s.night || 0), flash = clamp01(s.flash || 0);
      M.lit.color.setScalar(lerp(E.window, E.windowNight, night));
      M.top.lightMapIntensity = M.bottom.lightMapIntensity = M.hull.lightMapIntensity = E.flood * night;
      // the collectors: two layers of blotches turning against each other, and a slow unsteady flicker
      swirl += (dt > 0 ? dt : last === null ? 0 : Math.max(0, Math.min(0.1, t - last))) * (0.018 + 0.05 * warp); last = t;
      M.bussardIn.map.offset.x = swirl; M.bussardOut.emissiveMap.offset.x = -swirl * 0.6;
      const fl = (0.9 + 0.1 * Math.sin(t * 2.3) * Math.sin(t * 0.71 + 1.3)) * (1 + 0.5 * warp) + 2.5 * flash;
      M.bussardIn.color.setScalar(E.bussard * fl); M.bussardOut.emissiveIntensity = 0.5 * E.bussard * fl;
      M.grille.emissiveIntensity = lerp(E.grilleIdle, E.grilleWarp, warp) * (1 + 0.04 * warp * Math.sin(t * 19)) + E.grilleFlash * flash;
      M.dish.emissiveIntensity = E.dish * (0.94 + 0.06 * Math.sin(t * 0.9)) * (1 + 0.35 * warp);
      M.impulse.emissiveIntensity = lerp(E.impulseIdle, E.impulseFull, imp) * (1 + 0.03 * imp * Math.sin(t * 27));
      red.visible = green.visible = t % 1.6 < 1.05;
      strobe.visible = t % 1.3 < 0.08;
    },
    dispose() { disposeTree(root); },
  };
  ship.update(0, {});
  return ship;
}
