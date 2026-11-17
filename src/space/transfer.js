// The way to the Moon, worked out and flown for the player: the transfer helper (L in a rocket).
//
// From a low orbit of the Earth, one burn along the direction of travel raises the far end of the orbit to the
// Moon's distance; the craft coasts for about three days and arrives as the Moon does. Two things have to be
// right, and finding them by hand on the map is trial and error:
//   - The Moon must be in the plane of the craft's orbit when the craft gets there. It crosses that plane
//     twice a month, so the plan may begin with a wait of up to two weeks (seconds, with time run fast).
//   - The burn must start at the right point of the orbit (nearly opposite where the Moon will be) and last
//     the right time. plan() finds that by trying: it flies the burn and the coast ahead with the same gravity
//     and the same engine as the game (orbit.js, rocket.js) and adjusts the start, the length and a degree or
//     two of sideways aim until the path passes the Moon at the height asked for.
// TransferPilot then flies the plan: runs time fast to the burn, holds the nose and burns, trims the cutoff
// against the path it predicts as it goes, coasts to the Moon, and at the low point of the pass burns against
// the direction of travel until the craft is in a circular orbit there. Any touch of the controls hands the
// craft back to the player with the plan still drawn on the map.

import { MU_E, MU_M, RE, RM, MOON_SOI, moonPos, moonVel, dot, len, cross } from './frames.js';
import { gravity, rk4, coastStep, coast } from './orbit.js';

const TARGET_ALT = 150000;                 // how high over the Moon the pass is aimed (m)
const LAG = 0.69;                          // the time constant of the engines coming up to thrust (s)
const D2R = Math.PI / 180;
const g = [0, 0, 0], rm = [0, 0, 0], mv = [0, 0, 0], nrm = [0, 0, 0], dir = [0, 0, 0];

/** The direction of a burn: along the velocity, swung by yaw (radians) toward the orbit's normal. Into out (unit, ECI). */
export function burnDir(r, v, yaw, out) {
  cross(r, v, nrm);
  const vl = len(v), nl = len(nrm) || 1, c = Math.cos(yaw), s = Math.sin(yaw);
  for (let k = 0; k < 3; k++) out[k] = c * v[k] / vl + s * nrm[k] / nl;
  return out;
}

/** Fly a burn of `secs` from (r, v) at t (all changed in place) with an engine giving accel(burnTime) m/s2. Returns the time it ends. */
function burn(clock, t, r, v, secs, yaw, accel, burnT0) {
  const h = 0.25, n = Math.max(1, Math.round(secs / h)), dt = secs / n;
  for (let i = 0; i < n; i++) {
    gravity(clock, t, r, g); burnDir(r, v, yaw, dir);
    const tau = (i + 0.5) * dt, a = accel(burnT0 + Math.max(0, tau - LAG)) * (1 - Math.exp(-tau / LAG));       // (the engines take a moment to come up, as in rocket.js)
    for (let k = 0; k < 3; k++) { v[k] += (g[k] + a * dir[k]) * dt; r[k] += v[k] * dt; }
    t += dt;
  }
  return t;
}

/** Coast from (r, v) at t (both changed) until the craft has passed the Moon (or for maxTime). Returns { dist: closest distance to the Moon's center, t: when }. */
export function pass(clock, t, r, v, maxTime) {
  const t0 = t; let best = Infinity, bt = t, was = Infinity;
  while (t - t0 < maxTime) {
    moonPos(clock, t, rm);
    const d = Math.hypot(r[0] - rm[0], r[1] - rm[1], r[2] - rm[2]);
    if (d < best) { best = d; bt = t; }
    if (d > was && best < 3 * MOON_SOI && d > best * 1.5) break;             // well past it
    if (len(r) < RE + 50000 && t - t0 > 3600) break;                         // came back down
    was = d;
    // (finer steps near the Moon than the orbit's own would take, so the closest point is not stepped over)
    const h = Math.min(coastStep(clock, t, r), d < 2 * MOON_SOI ? Math.max(d / 24000, 2) : 1e9);           // (the same steps the game's own coasting takes, so the two agree)
    rk4(clock, t, r, v, h); t += h;
  }
  return { dist: best, t: bt };
}

/**
 * Plan a transfer for a craft at (r, v) at time t in a low orbit of the Earth, with an engine giving
 * accel(burnTime) m/s2 from burn time burnT0. Returns null if no pass could be found, else
 * { tBurn, secs, yaw, dv, tArrive, dist (the pass's distance from the Moon's center, as planned), target }.
 */
export function plan(clock, t, r0, v0, accel, burnT0 = 0, targetAlt = TARGET_ALT) {
  const r = [r0[0], r0[1], r0[2]], v = [v0[0], v0[1], v0[2]];
  const a = 1 / (2 / len(r) - dot(v, v) / MU_E), P = 2 * Math.PI * Math.sqrt((a * a * a) / MU_E);
  const target = RM + targetAlt;
  // A first guess at the burn: enough speed for a far end at the Moon's distance, by the vis-viva equation.
  const rl = len(r), vl = len(v), dv0 = Math.sqrt(MU_E * (2 / rl - 2 / (rl + 384400e3))) - vl;
  const secsFor = (dv) => { let s = 0, got = 0; while (got < dv && s < 3000) { got += accel(burnT0 + s) * 0.5; s += 0.5; } return s; };
  const secs0 = secsFor(dv0 + 25);
  // How long the trip takes: fly one from here and see when it is at the Moon's distance.
  const tr = [r[0], r[1], r[2]], tv = [v[0], v[1], v[2]];
  let tt = burn(clock, t, tr, tv, secs0, 0, accel, burnT0); const tb0 = tt;
  while (len(tr) < 370000e3 && tt - tb0 < 8 * 86400) { const h = coastStep(clock, tt, tr, 1 / 120); rk4(clock, tt, tr, tv, h); tt += h; }
  const tof = tt - t;
  // When is the Moon in the plane of this orbit, as the craft would arrive? (The orbit's plane does not turn.)
  cross(r, v, nrm); const nl = len(nrm);
  const off = (ta) => { moonPos(clock, ta, rm); return dot(rm, nrm) / nl; };
  let ta = t + tof + P, f0 = off(ta), found = false;
  for (let k = 0; k < 16 * 24 && !found; k++) {
    const f1 = off(ta + 3600);
    if (f0 === 0 || f0 * f1 < 0) { let lo = ta, hi = ta + 3600; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (off(lo) * off(mid) <= 0) hi = mid; else lo = mid; } ta = (lo + hi) / 2; found = true; break; }
    ta += 3600; f0 = f1;
  }
  if (!found) ta = t + tof + P;                       // (the Moon never far from the plane: any time will do)
  // Bring the orbit forward to just before the burn that arrives then, and search from there.
  const tw = Math.max(t, ta - tof - P / 2);
  coast(clock, t, r, v, tw - t);
  const base = { r: [r[0], r[1], r[2]], v: [v[0], v[1], v[2]] };
  const sr = [0, 0, 0], sv = [0, 0, 0];
  const fly = (wait, secs, yaw) => {
    for (let k = 0; k < 3; k++) { sr[k] = base.r[k]; sv[k] = base.v[k]; }
    coast(clock, tw, sr, sv, wait);
    const te = burn(clock, tw + wait, sr, sv, secs, yaw, accel, burnT0);
    return pass(clock, te, sr, sv, 9 * 86400);
  };
  // Where in the orbit: try all the way around, coarsely.
  let best = null;
  for (let i = 0; i < 72; i++) {
    const wait = (i / 72) * P, p = fly(wait, secs0, 0);
    if (!best || p.dist < best.dist) best = { wait, secs: secs0, yaw: 0, dist: p.dist, t: p.t };
  }
  // Then start, length and sideways aim together, by steps that shrink.
  const err = (c) => Math.abs(c.dist - target);
  let step = [P / 72, 4, 1.5 * D2R];
  for (let it = 0; it < 60 && err(best) > 2000; it++) {
    let moved = false;
    for (let k = 0; k < 3; k++) for (const sgn of [1, -1]) {
      const c = { wait: best.wait, secs: best.secs, yaw: best.yaw };
      if (k === 0) c.wait = Math.max(0, c.wait + sgn * step[0]); else if (k === 1) c.secs = Math.max(10, c.secs + sgn * step[1]); else c.yaw = Math.max(-0.2, Math.min(0.2, c.yaw + sgn * step[2]));
      const p = fly(c.wait, c.secs, c.yaw); c.dist = p.dist; c.t = p.t;
      if (err(c) < err(best)) { best = c; moved = true; }
    }
    if (!moved) { step = step.map((s) => s * 0.5); if (step[1] < 0.01) break; }
  }
  if (!best || best.dist > MOON_SOI) return null;
  let dv = 0; for (let s = 0; s < best.secs; s += 0.5) dv += accel(burnT0 + s) * 0.5;
  return { tBurn: tw + best.wait, secs: best.secs, yaw: best.yaw, dv, tArrive: best.t, dist: best.dist, target };
}

/** The path a plan would fly, for the map: points [x, y, z, t] (ECI) from the burn to the Moon. */
export function planPath(clock, t, r0, v0, p, accel, burnT0, out) {
  const r = [r0[0], r0[1], r0[2]], v = [v0[0], v0[1], v0[2]];
  if (p.tBurn > t) coast(clock, t, r, v, p.tBurn - t);
  let n = 0, tt = Math.max(t, p.tBurn);
  const put = () => { out[n * 4] = r[0]; out[n * 4 + 1] = r[1]; out[n * 4 + 2] = r[2]; out[n * 4 + 3] = tt; n++; };
  put();
  tt = burn(clock, tt, r, v, Math.max(0, p.tBurn + p.secs - tt), p.yaw, accel, burnT0 + Math.max(0, t - p.tBurn));
  const cap = out.length / 4;
  while (n < cap - 1 && tt < p.tArrive) { put(); const h = Math.min(coastStep(clock, tt, r, 1 / 90), p.tArrive - tt + 1); rk4(clock, tt, r, v, h); tt += h; }
  put();
  return n;
}

/** Flies a plan (see the top of the file). Made by Mission when the helper is switched on; step() runs inside the physics loop. */
export class TransferPilot {
  constructor(planned) { this.plan = planned; this.phase = 'wait'; this.done = false; this.note = ''; this.errWas = Infinity; this.cut = false; this.trimmed = false; this.trimSign = 0; }

  /** Seconds until the next thing the pilot is waiting for (for the time acceleration, which eases off as it nears). */
  eta(rk, clock) {
    const p = this.plan;
    if (this.phase === 'wait') return p.tBurn - rk.t;
    if (this.phase === 'coast') {
      // To the edge of the Moon's pull (where the path is trimmed), then to the second trim closer in, then to the braking burn.
      moonPos(clock, rk.t, rm); moonVel(clock, rk.t, mv);
      const d = Math.hypot(rk.r[0] - rm[0], rk.r[1] - rm[1], rk.r[2] - rm[2]), sp = Math.max(Math.hypot(rk.v[0] - mv[0], rk.v[1] - mv[1], rk.v[2] - mv[2]), 300);
      if (rk.body !== 'moon') return Math.max((d - MOON_SOI) / sp * 0.7, 20);
      if (!this.trimmed) return 0;
      if (!this.trim2) return Math.max((d - RM - 1.6e7) / sp * 0.7, 20);
      const o = rk.orbit(clock);
      return isFinite(o.tPe) ? o.tPe - this.captureLead(rk, o) : 60;
    }
    return 0;
  }
  /** How long before the low point the capture burn starts: half its own length. */
  captureLead(rk, o) {
    const rp = o.pe + RM, vp = Math.sqrt(Math.max(MU_M * (2 / rp - 1 / o.a), 0)), vc = Math.sqrt(MU_M / rp);
    return Math.max(vp - vc, 0) / Math.max(rk.fullAccel(), 0.1) / 2;
  }

  /** One physics step's worth of flying. Returns a word when something happens: 'burn' | 'coast' | 'capture' | 'done' | 'lost'. */
  step(rk, clock, predictMoon) {
    const p = this.plan;
    if (this.phase === 'wait') {
      rk.throttle = 0; rk.sas = 'prograde';
      if (rk.t >= p.tBurn) { this.phase = 'burn'; return 'burn'; }
    } else if (this.phase === 'burn') {
      rk.sas = 'hold'; rk.frame(clock); rk.noseTo(burnDir(rk.r, rk.v, p.yaw, dir));
      rk.throttle = 1;
      const left = p.tBurn + p.secs - rk.t;
      // The end of the burn is flown against the prediction, gently: a foot a second too much misses the Moon by hundreds
      // of miles, so the thrust comes down as the predicted pass nears the height asked for, and is cut as it gets there.
      if (left < 4) {
        const d = predictMoon(), err = d == null ? Infinity : Math.abs(d - p.target);
        rk.throttle = err < 2.5e6 ? 0.02 : err < 3e7 ? 0.06 : 0.3;
        if ((err > this.errWas && this.errWas < 4e5) || left < -240) this.cut = true;
        this.errWas = err; this.dist = d;
      }
      if (this.cut) { rk.throttle = 0; rk.thrustLevel = 0; rk.sas = 'prograde'; this.phase = 'coast'; return 'coast'; }
    } else if (this.phase === 'coast') {
      rk.throttle = 0;
      if (rk.body === 'moon') {
        rk.sas = 'retrograde';
        const o = rk.orbit(clock);
        // Three days of coasting never land exactly on the plan: once in the Moon's pull, a nudge across the path puts the
        // low point of the pass where it was meant to be (outward from the Moon raises it, inward lowers it).
        const want = this.plan.target - RM;
        if (this.trimmed && !this.trim2 && o.alt < 1.6e7) { this.trim2 = true; this.trimmed = false; this.trimSign = 0; }      // (and once more closer in, where the Earth's pull no longer bends the numbers)
        if (!this.trimmed && isFinite(o.tPe) && o.tPe > 1800) {
          if (Math.abs(o.pe - want) < 4000 || (this.trimSign && (o.pe - want) * this.trimSign >= 0)) { this.trimmed = true; rk.throttle = 0; rk.thrustLevel = 0; if (this.trimSign) return 'trimmed'; }
          else {
            if (!this.trimSign) { this.trimSign = o.pe < want ? 1 : -1; this.phaseNote = 'trim'; }
            moonPos(clock, rk.t, rm); moonVel(clock, rk.t, mv);
            const rr = [rk.r[0] - rm[0], rk.r[1] - rm[1], rk.r[2] - rm[2]], vv = [rk.v[0] - mv[0], rk.v[1] - mv[1], rk.v[2] - mv[2]], vl = len(vv), al = dot(rr, vv) / (vl * vl);
            for (let k = 0; k < 3; k++) dir[k] = this.trimSign * (rr[k] - al * vv[k]);
            rk.sas = 'hold'; rk.frame(clock); rk.noseTo(dir);
            rk.throttle = Math.max(0.004, Math.min(0.2, Math.abs(o.pe - want) / 4e6 / Math.max(rk.fullAccel() / 10, 0.3)));       // (gentler as it closes, and for the stronger engine)
            return null;
          }
        }
        if (o.pe < 8000) { this.done = true; return 'lost'; }
        if (isFinite(o.tPe) && o.tPe <= this.captureLead(rk, o) + 0.05) { this.phase = 'capture'; return 'capture'; }
        if (!isFinite(o.tPe) && !o.bound) { this.phase = 'capture'; return 'capture'; }                  // already past the low point: brake now
      } else { rk.sas = 'prograde'; if (rk.t > p.tArrive + 2 * 86400) { this.done = true; return 'lost'; } }
    } else if (this.phase === 'capture') {
      rk.sas = 'retrograde'; rk.throttle = 1;
      moonPos(clock, rk.t, rm); moonVel(clock, rk.t, mv);
      const d = Math.hypot(rk.r[0] - rm[0], rk.r[1] - rm[1], rk.r[2] - rm[2]), sp = Math.hypot(rk.v[0] - mv[0], rk.v[1] - mv[1], rk.v[2] - mv[2]);
      if (sp <= Math.sqrt(MU_M / d)) { rk.throttle = 0; rk.thrustLevel = 0; rk.sas = 'prograde'; this.done = true; return 'done'; }
    }
    return null;
  }
}
