// Orbits: gravity, coasting, the numbers that describe an orbit, and the path ahead.
//
// The spacecraft feels the Earth and the Moon (the Moon on its prescribed circle, see frames.js; the Earth
// held at the origin, with the small correction that makes that honest). There are no patched conics: a
// coasting craft is integrated (RK4, with a step that is a small fraction of the local orbit's period), and
// the path drawn on the map is the same integration run ahead. Flying past the Moon, being captured by
// it or thrown out by it all come out of that with no special cases.
//
// elements() gives the conic the craft would follow around one body alone: what the readouts show
// (apoapsis, periapsis, period, inclination).

import { MU_E, MU_M, RE, RM, MOON_SOI, ATMO_TOP, moonPos, moonVel, dot, len, cross } from './frames.js';

const rm = [0, 0, 0], d = [0, 0, 0];
/** Acceleration of gravity at an ECI position r at time t, into out (m/s2). */
export function gravity(clock, t, r, out) {
  const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], k = -MU_E / (r2 * Math.sqrt(r2));
  moonPos(clock, t, rm);
  d[0] = r[0] - rm[0]; d[1] = r[1] - rm[1]; d[2] = r[2] - rm[2];
  const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], km = -MU_M / (d2 * Math.sqrt(d2)), ki = -MU_M / (rm[0] * rm[0] + rm[1] * rm[1] + rm[2] * rm[2]) ** 1.5;
  out[0] = k * r[0] + km * d[0] + ki * rm[0]; out[1] = k * r[1] + km * d[1] + ki * rm[1]; out[2] = k * r[2] + km * d[2] + ki * rm[2];
  return out;
}

const k1 = [0, 0, 0], k2 = [0, 0, 0], k3 = [0, 0, 0], k4 = [0, 0, 0], p = [0, 0, 0];
/** One RK4 step of free fall: r and v (arrays) are advanced in place by h seconds from time t. */
export function rk4(clock, t, r, v, h) {
  const h2 = h / 2;
  gravity(clock, t, r, k1);
  p[0] = r[0] + h2 * v[0]; p[1] = r[1] + h2 * v[1]; p[2] = r[2] + h2 * v[2];
  gravity(clock, t + h2, p, k2);
  p[0] = r[0] + h2 * v[0] + (h * h / 4) * k1[0]; p[1] = r[1] + h2 * v[1] + (h * h / 4) * k1[1]; p[2] = r[2] + h2 * v[2] + (h * h / 4) * k1[2];
  gravity(clock, t + h2, p, k3);
  p[0] = r[0] + h * v[0] + (h * h / 2) * k2[0]; p[1] = r[1] + h * v[1] + (h * h / 2) * k2[1]; p[2] = r[2] + h * v[2] + (h * h / 2) * k2[2];
  gravity(clock, t + h, p, k4);
  for (let i = 0; i < 3; i++) {
    r[i] += h * v[i] + (h * h / 6) * (k1[i] + k2[i] + k3[i]);
    v[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
}

/** The step (s) a coasting craft at r can take: a fraction of the period of a circular orbit there, around whichever body is nearer in its pull. */
export function coastStep(clock, t, r, frac = 1 / 240) {
  const re = len(r);
  moonPos(clock, t, rm);
  const dm = Math.hypot(r[0] - rm[0], r[1] - rm[1], r[2] - rm[2]);
  const te = 2 * Math.PI * Math.sqrt((re * re * re) / MU_E), tm = 2 * Math.PI * Math.sqrt((dm * dm * dm) / MU_M);
  return Math.max(0.05, Math.min(te, tm) * frac);
}

/** Coast for dt seconds (r, v in place). Returns the altitude above the nearer surface at the end. */
export function coast(clock, t, r, v, dt) {
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(left, coastStep(clock, t, r));
    rk4(clock, t, r, v, h); t += h; left -= h;
  }
}

const hv = [0, 0, 0], ev = [0, 0, 0], rr = [0, 0, 0], vv = [0, 0, 0], mv = [0, 0, 0];
/**
 * The orbit around one body (mu, radius R) of a craft at r moving at v, both relative to that body.
 * Returns out: a (semi-major axis; negative when the craft is escaping), e, inc (radians, to the
 * equator), ap and pe (altitudes above the surface, m; ap is Infinity on an escape path), period (s),
 * tPe and tAp (seconds until the next periapsis and apoapsis; NaN where there is none), bound.
 */
export function elements(r, v, mu, R, out = {}) {
  const rl = len(r), v2 = dot(v, v), en = v2 / 2 - mu / rl;
  cross(r, v, hv);
  const h = len(hv), rv = dot(r, v);
  for (let i = 0; i < 3; i++) ev[i] = ((v2 - mu / rl) * r[i] - rv * v[i]) / mu;
  const e = len(ev), a = -mu / (2 * en);
  out.a = a; out.e = e; out.inc = Math.acos(Math.max(-1, Math.min(1, hv[2] / (h || 1)))); out.energy = en;
  out.bound = en < 0 && e < 1;
  const pe = (h * h / mu) / (1 + e);
  out.pe = pe - R; out.ap = out.bound ? a * (1 + e) - R : Infinity;
  if (out.bound) {
    const n = Math.sqrt(mu / (a * a * a)), T = (2 * Math.PI) / n;
    // Eccentric anomaly from the position, then the mean anomaly (Kepler's equation).
    const cosE = e > 1e-9 ? (1 - rl / a) / e : 1, E0 = Math.acos(Math.max(-1, Math.min(1, cosE))), E = rv >= 0 ? E0 : 2 * Math.PI - E0;
    const M = E - e * Math.sin(E);
    out.period = T; out.tPe = (2 * Math.PI - M) / n; out.tAp = (((Math.PI - M) / n) + T) % T;
  } else {
    out.period = NaN; out.tAp = NaN;
    // Hyperbola: time to periapsis only while still inbound.
    const aa = -a, coshF = e > 1 ? (1 + rl / aa) / e : 1, F = Math.acosh(Math.max(1, coshF)), n = Math.sqrt(mu / (aa * aa * aa));
    out.tPe = rv < 0 ? (e * Math.sinh(F) - F) / n : NaN;
  }
  return out;
}

/** Which body an orbit at r is described around at t: 'moon' inside the Moon's sphere of influence, else 'earth'. */
export function bodyAt(clock, t, r) {
  moonPos(clock, t, rm);
  return Math.hypot(r[0] - rm[0], r[1] - rm[1], r[2] - rm[2]) < MOON_SOI ? 'moon' : 'earth';
}

/** The orbit's numbers around the body that matters at t (see elements): adds out.body. */
export function orbitNow(clock, t, r, v, out = {}) {
  moonPos(clock, t, rm);
  const dm = Math.hypot(r[0] - rm[0], r[1] - rm[1], r[2] - rm[2]);
  if (dm < MOON_SOI) {
    moonVel(clock, t, mv);
    for (let i = 0; i < 3; i++) { rr[i] = r[i] - rm[i]; vv[i] = v[i] - mv[i]; }
    elements(rr, vv, MU_M, RM, out); out.body = 'moon'; out.alt = dm - RM;
  } else { elements(r, v, MU_E, RE, out); out.body = 'earth'; out.alt = len(r) - RE; }
  return out;
}

/**
 * The path ahead of a coasting craft. Fills path.pts (Float64Array: x, y, z, t, body flag per point, where
 * positions inside the Moon's sphere of influence are stored RELATIVE TO THE MOON and flagged 1, so the map
 * can draw them around the Moon where it is now, the way a patched-conic map does) and returns path with:
 *   n          points written
 *   impact     { t, body } if the path runs into the Earth's lower atmosphere or the Moon's surface
 *   moon       { t, dist } the closest approach to the Moon, if the path enters its sphere of influence
 * It stops after one full turn of a closed orbit around the Earth (or the Moon), at an impact, at maxTime,
 * or when the buffer is full.
 */
export function predict(clock, t0, r0, v0, path, maxTime = 12 * 86400) {
  const pts = path.pts, cap = Math.floor(pts.length / 5), r = [r0[0], r0[1], r0[2]], v = [v0[0], v0[1], v0[2]];
  let t = t0, n = 0, swept = 0, was = null, lastBody = -1;
  const prev = [0, 0, 0];
  path.impact = null; path.moon = null;
  const put = () => {
    moonPos(clock, t, rm);
    const dx = r[0] - rm[0], dy = r[1] - rm[1], dz = r[2] - rm[2], dm = Math.hypot(dx, dy, dz), inM = dm < MOON_SOI;
    const o = n * 5;
    if (inM) { pts[o] = dx; pts[o + 1] = dy; pts[o + 2] = dz; } else { pts[o] = r[0]; pts[o + 1] = r[1]; pts[o + 2] = r[2]; }
    pts[o + 3] = t; pts[o + 4] = inM ? 1 : 0; n++;
    if (inM && (!path.moon || dm < path.moon.dist)) path.moon = { t, dist: dm };
    return inM ? 1 : 0;
  };
  while (n < cap) {
    const body = put();
    // The angle swept around the current body: a closed orbit is drawn once around.
    const q = body ? [pts[(n - 1) * 5], pts[(n - 1) * 5 + 1], pts[(n - 1) * 5 + 2]] : r;
    if (body !== lastBody) { swept = 0; was = null; lastBody = body; }
    if (was) { const c = dot(q, prev) / (len(q) * len(prev)); swept += Math.acos(Math.max(-1, Math.min(1, c))); }
    prev[0] = q[0]; prev[1] = q[1]; prev[2] = q[2]; was = true;
    if (swept > 2 * Math.PI * 1.01) break;
    const alt = body ? len(q) - RM : len(r) - RE;
    if (alt < (body ? 0 : Math.min(ATMO_TOP * 0.5, len(r0) - RE - 1000)) && n > 1) { path.impact = { t, body: body ? 'moon' : 'earth' }; break; }
    if (t - t0 > maxTime) break;
    const h = coastStep(clock, t, r, 1 / 160);
    rk4(clock, t, r, v, h); t += h;
  }
  path.n = n; path.t0 = t0; path.t1 = t;
  return path;
}

export const makePath = (points = 2400) => ({ pts: new Float64Array(points * 5), n: 0, impact: null, moon: null, t0: 0, t1: 0 });
