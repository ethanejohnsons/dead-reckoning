// A rocket as a point with a nose: thrust, drag and gravity move it, in the inertial frame of frames.js.
//
// Arcade on purpose. There is no fuel to run out: each stage pushes with the acceleration the real one had,
// rising as the real one's did while its tanks drained, and then simply stays at its final figure for as
// long as the engines are left on. Dropping a stage (stageNext) is the player's to do whenever they like.
//
// Attitude is not a rigid body's. The nose is held where the player (or the guidance) puts it, described
// against the local horizon of whichever body the craft is near: `hdg` (compass direction of the nose over
// the ground), `pitch` (degrees above the horizon; 90 is straight up) and `roll`. Left alone it keeps those,
// so in a circular orbit a nose set on the horizon stays on the horizon all the way around. `sas` can also
// hold it on the direction of travel or against it.
//
// The craft's position r is the point the vehicle turns about (spec.pivot above its base).
// On the ground (`landed`) it rides the turning Earth; guidance() is the "fly me to orbit" autopilot.

import {
  D2R, RE, RM, MU_E, MU_M, ATMO_TOP, G0, geoToEci, eciToGeo, groundVel, enu, moonPos, moonVel, MOON_SOI, dot, len,
} from './frames.js';
import { gravity, coast, orbitNow } from './orbit.js';

/** Flight numbers per vehicle and stage: thrust (N), acceleration at ignition and at burnout (m/s2), the burn it takes
 *  to go from one to the other (s), drag area nose-on and broadside (Cd x m2), and the height of the stack's turning point above its base once the stages below are gone. */
export const ROCKETS = {
  saturnv: {
    stages: [
      { name: 'S-IC', thrust: 35.1e6, a0: 11.9, a1: 38, burn: 162, cda: 45, cdaSide: 900, pivot: 48 },
      { name: 'S-II', thrust: 5.14e6, a0: 7.6, a1: 19, burn: 384, cda: 45, cdaSide: 520, pivot: 68 },
      { name: 'S-IVB', thrust: 1.03e6, a0: 6.2, a1: 13, burn: 470, cda: 24, cdaSide: 260, pivot: 86 },
      { name: 'Apollo', thrust: 91e3, a0: 3.1, a1: 7, burn: 520, cda: 14, cdaSide: 60, pivot: 98 },
    ],
  },
  starship: {
    stages: [
      { name: 'Super Heavy', thrust: 74.4e6, a0: 14.7, a1: 36, burn: 160, cda: 50, cdaSide: 820, cdaBack: 720, pivot: 55 },      // (cdaBack: engines first, grid fins out, as it comes back: slowed by the air to about 500 mph)
      { name: 'Ship', thrust: 12.3e6, a0: 9.6, a1: 34, burn: 350, cda: 45, cdaSide: 480, cdaBack: 300, pivot: 92 },      // (cdaBack: tail first, as it comes home under the autopilot's "tail to the direction of travel")
    ],
  },
};

export const airDensity = (alt) => (alt < ATMO_TOP ? 1.225 * Math.exp(-Math.max(alt, 0) / 7200) : 0);
export const airPressure = (alt) => (alt < ATMO_TOP ? Math.exp(-Math.max(alt, 0) / 7200) : 0);      // against sea level

const B = new Array(9), g = [0, 0, 0], va = [0, 0, 0], gv = [0, 0, 0], rm = [0, 0, 0], mv = [0, 0, 0], rel = [0, 0, 0], vrel = [0, 0, 0], geo = {}, el = {};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Rocket {
  constructor(id = 'saturnv') {
    this.r = [RE, 0, 0]; this.v = [0, 0, 0];
    this.nose = [1, 0, 0];                    // unit vector in ECI: where the nose points (derived from hdg and pitch every step)
    this.hdg = 90; this.pitch = 90; this.roll = 0;
    this.throttle = 0; this.thrustLevel = 0;  // commanded, and what the engines are giving (they take a moment to come up)
    this.sas = 'hold';                        // 'hold' | 'prograde' | 'retrograde'
    this.stage = 0; this.burnT = 0;
    this.landed = null;                       // { body, lat, lon, alt } on the Earth (alt: of the full stack's base, wherever the lowest part left is); { body: 'moon', off: [x, y, z] } on the Moon
    this.caught = false;                      // landed, but hanging in a launch tower's arms
    this.light = 1;                           // how much harder the engines push than the stage's figures say: a booster that has let its upper stage go is a fraction of the weight
    this.held = false;                        // on the pad with the hold-down arms on: no liftoff until released
    this.crashed = null;
    this.body = 'earth';
    this.t = 0;                               // the mission clock (s)
    this.met = 0; this.lifted = false;        // time since liftoff
    // Flight data, refreshed every step
    this.alt = 0; this.agl = 0; this.vs = 0; this.speedSurf = 0; this.speedOrb = 0; this.mach = 0; this.q = 0; this.heat = 0;
    this.gLoad = 1; this.accel = 0; this.maxAlt = 0; this.touchdown = null;
    this.setSpec(id);
  }

  setSpec(id) { this.id = ROCKETS[id] ? id : 'saturnv'; this.spec = ROCKETS[this.id]; this.stage = 0; this.burnT = 0; }
  get stageSpec() { return this.spec.stages[this.stage]; }
  get lastStage() { return this.stage >= this.spec.stages.length - 1; }
  /** Height of the turning point above the vehicle's base, with the stages below the current one gone (the base is then that stage's own). */
  get pivot() { return this.stageSpec.pivot; }

  /** Stand the vehicle on the ground at a place: base at alt (m above the sphere), nose up, engines off, held down. */
  placeOnPad(clock, t, lat, lon, alt, hdg = 90) {
    this.t = t; this.stage = 0; this.burnT = 0; this.throttle = 0; this.thrustLevel = 0;
    this.hdg = hdg; this.pitch = 90; this.roll = 0; this.sas = 'hold';
    this.landed = { body: 'earth', lat, lon, alt }; this.held = true; this.caught = false; this.crashed = null; this.body = 'earth';
    this.met = 0; this.lifted = false; this.maxAlt = 0; this.touchdown = null; this.baseY = 0; this.light = 1;
    this.ride(clock);
    this.data(clock, null);
  }

  /** Put the craft in a circular orbit of the Earth: for tests and for "start in orbit". Crossing the equator at lonDeg on an
   *  orbit inclined incDeg, or, given latDeg, over that place heading east. */
  placeInOrbit(clock, t, alt, incDeg = 28.5, lonDeg = -80, latDeg = null) {
    const r = RE + alt, v = Math.sqrt(MU_E / r), i = incDeg * D2R;
    if (latDeg !== null) {
      // Over a place, heading due east: the northernmost (or southernmost) point of an orbit inclined by that place's latitude.
      geoToEci(clock, t, latDeg, lonDeg, alt, this.r); enu(this.r, B);
      for (let k = 0; k < 3; k++) this.v[k] = v * B[k];
    } else {
      geoToEci(clock, t, 0, lonDeg, alt, this.r); enu(this.r, B);
      for (let k = 0; k < 3; k++) this.v[k] = v * (Math.cos(i) * B[k] + Math.sin(i) * B[3 + k]);
    }
    this.t = t; this.landed = null; this.held = false; this.crashed = null; this.throttle = 0; this.thrustLevel = 0;
    this.stage = this.spec.stages.length - 1; this.burnT = 0; this.sas = 'prograde'; this.lifted = true; this.met = 0;
    this.aim(clock); this.data(clock, null);
  }

  /** Put the craft in a circular orbit of the Moon: for tests and for "start at the Moon". */
  placeAtMoon(clock, t, alt) {
    moonPos(clock, t, rm); moonVel(clock, t, mv);
    const d = RM + alt, v = Math.sqrt(MU_M / d), l = len(rm), ux = rm[0] / l, uy = rm[1] / l, uz = rm[2] / l, ml = len(mv);
    // On the Earth's side of the Moon, moving against the Moon's own motion (a retrograde orbit, as Apollo flew).
    for (let k = 0; k < 3; k++) { this.r[k] = rm[k] - [ux, uy, uz][k] * d; this.v[k] = mv[k] - (mv[k] / ml) * v; }
    this.t = t; this.landed = null; this.held = false; this.crashed = null; this.throttle = 0; this.thrustLevel = 0;
    this.stage = this.spec.stages.length - 1; this.burnT = 0; this.sas = 'prograde'; this.lifted = true; this.body = 'moon';
    this.aim(clock); this.data(clock, null);
  }

  /** While landed: ride the body's surface. */
  ride(clock) {
    const L = this.landed;
    if (L.body === 'earth') {
      geoToEci(clock, this.t, L.lat, L.lon, L.alt + this.pivot, this.r);
      groundVel(this.r, this.v);
    } else {
      moonPos(clock, this.t, rm); moonVel(clock, this.t, mv);
      for (let k = 0; k < 3; k++) { this.r[k] = rm[k] + L.off[k]; this.v[k] = mv[k]; }
    }
    this.frame(clock);
    this.setNose();
  }

  /** The local axes (B: east, north, up) of the body the craft is near, and the craft's position and velocity relative to that body (rel, vrel). */
  frame(clock) {
    moonPos(clock, this.t, rm);
    const dm = Math.hypot(this.r[0] - rm[0], this.r[1] - rm[1], this.r[2] - rm[2]);
    const body = dm < MOON_SOI ? 'moon' : 'earth';
    if (body !== this.body) {
      // The horizon the attitude is described against has changed: keep the nose where it is in space.
      const n = [this.nose[0], this.nose[1], this.nose[2]];
      this.body = body; this.frame(clock); this.noseTo(n);
      return;
    }
    if (body === 'moon') { moonVel(clock, this.t, mv); for (let k = 0; k < 3; k++) { rel[k] = this.r[k] - rm[k]; vrel[k] = this.v[k] - mv[k]; } }
    else { groundVel(this.r, gv); for (let k = 0; k < 3; k++) { rel[k] = this.r[k]; vrel[k] = this.v[k]; } }
    enu(rel, B);
  }
  /** nose from hdg and pitch in the current local axes (call frame first). */
  setNose() {
    const h = this.hdg * D2R, p = this.pitch * D2R, ce = Math.cos(p) * Math.sin(h), cn = Math.cos(p) * Math.cos(h), cu = Math.sin(p);
    for (let k = 0; k < 3; k++) this.nose[k] = ce * B[k] + cn * B[3 + k] + cu * B[6 + k];
  }
  /** Set hdg and pitch so that the nose points along n (ECI, any length), in the current local axes. */
  noseTo(n) {
    const l = len(n) || 1, e = dot(n, [B[0], B[1], B[2]]) / l, nn = dot(n, [B[3], B[4], B[5]]) / l, u = dot(n, [B[6], B[7], B[8]]) / l;
    this.pitch = Math.asin(clamp(u, -1, 1)) / D2R;
    if (Math.hypot(e, nn) > 1e-4) this.hdg = (Math.atan2(e, nn) / D2R + 360) % 360;
    this.setNose();
  }
  /** Point the nose as the stability mode says (nothing to do for 'hold'). Below 40 km over the Earth "the direction of travel" is over the ground, above it around the planet. */
  aim(clock) {
    this.frame(clock);
    if (this.sas === 'prograde' || this.sas === 'retrograde') {
      const s = this.sas === 'prograde' ? 1 : -1, surf = this.body === 'earth' && len(this.r) - RE < 40000;
      for (let k = 0; k < 3; k++) va[k] = s * (surf ? this.v[k] - gv[k] : vrel[k]);
      if (len(va) > 5) { this.noseTo(va); return; }
    }
    this.setNose();
  }

  /** Drop the current stage and light the next. Returns the index of the stage dropped, or -1 if there is none left to drop. */
  stageNext() {
    if (this.lastStage || this.landed) return -1;
    const was = this.stage;
    this.stage++; this.burnT = 0; this.thrustLevel = 0;
    return was;
  }

  /**
   * One step of powered or atmospheric flight (dt up to about 1/30 s).
   * ctl: { pitch, yaw, roll } each -1..1: nose up / down against the horizon, nose right / left around the compass, roll.
   * env: { clock, ground(lat, lon) -> terrain height above the sphere under a point of the Earth (m), wind: [x, y, z] ECI m/s or null }
   */
  step(dt, ctl, env) {
    if (this.crashed) return;
    const c = env.clock, S = this.stageSpec;
    this.t += dt;
    this.thrustLevel += (this.throttle - this.thrustLevel) * Math.min(1, dt / 0.7);
    const aT = this.thrustAccel();

    if (this.landed) {
      this.ride(c);
      const gl = this.body === 'moon' ? MU_M / (RM * RM) : G0;
      if (!this.held && aT > gl * 1.01) { this.landed = null; this.caught = false; this.lifted = true; }      // off the ground (or out of the arms)
      else { this.burnT += this.thrustLevel * dt * (this.held ? 0 : 1); this.data(c, env); this.gLoad = 1; if (this.lifted) this.met += dt; return; }
    }
    if (this.lifted) this.met += dt;
    this.burnT += this.thrustLevel * dt;

    // Attitude: the player's hands, then the stability mode.
    this.frame(c);
    const rate = 9 * dt;
    if (ctl.pitch || ctl.yaw) {
      this.pitch = clamp(this.pitch + ctl.pitch * rate, -90, 90);
      // Near the vertical the compass direction of the nose means little: there, "yaw" swings it fast enough to feel the same.
      this.hdg = (this.hdg + ctl.yaw * rate / Math.max(Math.cos(this.pitch * D2R), 0.25) + 360) % 360;
      if (this.sas !== 'hold') this.sas = 'hold';
    }
    this.roll = (this.roll + ctl.roll * 20 * dt + 360) % 360;
    this.aim(c);

    // Forces.
    gravity(c, this.t, this.r, g);
    let ax = g[0] + aT * this.nose[0], ay = g[1] + aT * this.nose[1], az = g[2] + aT * this.nose[2];
    const alt = len(this.r) - RE;
    let q = 0, mach = 0;
    if (this.body === 'earth' && alt < ATMO_TOP) {
      groundVel(this.r, gv);
      const w = env.wind;
      va[0] = this.v[0] - gv[0] - (w ? w[0] : 0); va[1] = this.v[1] - gv[1] - (w ? w[1] : 0); va[2] = this.v[2] - gv[2] - (w ? w[2] : 0);
      const V = len(va), rho = airDensity(alt);
      if (V > 0.1) {
        const cosA = dot(va, this.nose) / V, sin2 = 1 - cosA * cosA;
        const mass = S.thrust / this.fullAccel(), end = cosA < 0 && S.cdaBack ? S.cdaBack : S.cda, cda = end + (S.cdaSide - end) * sin2;
        const k = (-0.5 * rho * V * cda) / mass;
        ax += k * va[0]; ay += k * va[1]; az += k * va[2];
      }
      q = 0.5 * rho * V * V; mach = V / (alt < 11000 ? 340 - 0.0041 * alt : 295);
      this.heat = Math.sqrt(rho) * V * V * V;
    } else this.heat = 0;
    this.q = q; this.mach = mach;
    // What the crew feels: everything but gravity.
    this.accel = Math.hypot(ax - g[0], ay - g[1], az - g[2]); this.gLoad = this.accel / G0;
    this.v[0] += ax * dt; this.v[1] += ay * dt; this.v[2] += az * dt;
    this.r[0] += this.v[0] * dt; this.r[1] += this.v[1] * dt; this.r[2] += this.v[2] * dt;

    this.contact(c, env);
    this.data(c, env);
  }

  /** Coast for dt seconds with the engines off and no air: any length of time (the integrator takes its own steps). */
  coast(dt, env) {
    if (this.crashed) return;
    const c = env.clock;
    if (this.landed) { this.t += dt; this.ride(c); this.data(c, env); return; }
    coast(c, this.t, this.r, this.v, dt);
    this.t += dt; if (this.lifted) this.met += dt;
    this.heat = 0; this.q = 0; this.mach = 0; this.accel = 0; this.gLoad = 0;
    this.aim(c);
    this.contact(c, env);
    this.data(c, env);
  }
  /** May the craft be coasted (and time run fast)? Engines off, and no air to speak of. */
  get canCoast() { return this.landed ? this.throttle === 0 : this.throttle === 0 && this.thrustLevel < 0.01 && (this.body === 'moon' || this.alt > ATMO_TOP); }

  /** Thrust acceleration right now (m/s2). */
  thrustAccel() { return this.thrustLevel * this.fullAccel(); }
  /** At full throttle: rising from a0 to a1 as a stage with constant thrust and draining tanks does, then staying there. */
  fullAccel() { const S = this.stageSpec, f = Math.min(this.burnT / S.burn, 1); return (this.light || 1) * S.a0 / (1 - (1 - S.a0 / S.a1) * f); }

  /** Caught by a tower's arms: hang there, the stack's base (as it would be with every stage on) at alt over a place. */
  catchAt(clock, lat, lon, alt) {
    this.landed = { body: 'earth', lat, lon, alt }; this.caught = true; this.held = false;
    this.throttle = 0; this.thrustLevel = 0; this.pitch = 90; this.sas = 'hold';
    this.touchdown = { sink: Math.max(-this.vs, 0), side: 0, pitch: 90, t: this.t, caught: true };
    this.ride(clock); this.data(clock, null);
  }

  /** Touching the ground: a soft, upright arrival is a landing; anything else is the end of the vehicle. */
  contact(c, env) {
    this.frame(c);
    let base, up = dot(vrel, [B[6], B[7], B[8]]);
    if (this.body === 'moon') base = len(rel) - RM - this.clear();
    else { eciToGeo(c, this.t, this.r, geo); base = geo.alt - this.clear() - (env.ground ? env.ground(geo.lat, geo.lon) : 0); for (let k = 0; k < 3; k++) vrel[k] = this.v[k] - gv[k]; up = dot(vrel, [B[6], B[7], B[8]]); }
    if (base > 0) return;
    const side = Math.sqrt(Math.max(dot(vrel, vrel) - up * up, 0));
    this.touchdown = { sink: -up, side, pitch: this.pitch, t: this.t };
    if (up > -9 && side < 7 && this.pitch > 72) {
      // (what is kept is where the full stack's base would be: below the ground by the height of the stages that are gone)
      if (this.body === 'moon') { const k = (RM + this.clear()) / len(rel); this.landed = { body: 'moon', off: [rel[0] * k, rel[1] * k, rel[2] * k] }; }
      else this.landed = { body: 'earth', lat: geo.lat, lon: geo.lon, alt: geo.alt - this.pivot - base };
      this.held = false; this.throttle = 0; this.thrustLevel = 0; this.pitch = 90; this.sas = 'hold';
      this.ride(c);
    } else this.crashed = up < -9 || side >= 7 ? 'Hit the ground' : 'Fell over on landing';
  }
  /** How far below the turning point the lowest part of what is left of the vehicle is (m). baseY is the height of that
   *  lowest part above the full stack's base: the game sets it from the model when a stage is dropped. */
  clear() { return this.pivot - (this.baseY || 0); }

  /** Refresh the flight data. */
  data(c, env) {
    this.frame(c);
    const up = [B[6], B[7], B[8]];
    if (this.body === 'moon') { this.alt = len(rel) - RM; this.agl = this.alt - this.clear(); this.speedSurf = len(vrel); this.vs = dot(vrel, up); }
    else {
      eciToGeo(c, this.t, this.r, geo);
      this.alt = geo.alt; this.lat = geo.lat; this.lon = geo.lon;
      this.agl = geo.alt - this.clear() - (env?.ground ? env.ground(geo.lat, geo.lon) : 0);
      for (let k = 0; k < 3; k++) va[k] = this.v[k] - gv[k];
      this.speedSurf = len(va); this.vs = dot(va, up);
    }
    this.speedOrb = len(vrel);
    if (this.alt > this.maxAlt) this.maxAlt = this.alt;
  }

  /** The orbit's numbers around the current body (see orbit.js). */
  orbit(clock, out = el) { return orbitNow(clock, this.t, this.r, this.v, out); }
}

/**
 * The autopilot that flies to a circular parking orbit: straight up off the pad, a pitch program through the
 * thick air, then closed-loop steering that trades vertical for horizontal speed so the craft arrives level at
 * the target height with orbital speed, and shuts down. It drops each stage when its nominal burn is done.
 * Call once per physics step while it is engaged; returns 'ascent' | 'orbit' (done) | 'stage' (it just dropped one).
 */
export function guidance(rk, clock, target = 190000, azimuth = 90) {
  let did = 'ascent';
  const S = rk.stageSpec;
  rk.throttle = 1; rk.held = false; rk.sas = 'hold';
  if (!rk.lastStage && rk.burnT >= S.burn && !rk.landed) { rk.stageNext(); did = 'stage'; }
  if (rk.landed) { rk.pitch = 90; rk.hdg = azimuth; return did; }
  const h = rk.alt, r = len(rk.r);
  rk.frame(clock);
  // Horizontal speed around the planet, and what a circular orbit here needs.
  const vu = dot(vrel, [B[6], B[7], B[8]]), vh = Math.sqrt(Math.max(dot(vrel, vrel) - vu * vu, 0)), vc = Math.sqrt(MU_E / r);
  rk.hdg = azimuth;
  const program = 90 - 90 * Math.pow(clamp((h - 300) / 85000, 0, 1), 0.5);          // the first minutes: tip over steadily, nose near the airflow
  // Closed loop: the vertical acceleration that brings the craft level at the target height, critically damped.
  const tau = 55, want = (target - h) / (tau * tau) - (2 * vu) / tau, geff = MU_E / (r * r) - (vh * vh) / r;
  const aT = Math.max(rk.fullAccel(), 0.1), loop = Math.asin(clamp((want + geff) / aT, -0.35, 0.72)) / D2R;
  const w = clamp((h - 55000) / 30000, 0, 1);
  rk.pitch = clamp(program + (loop - program) * w, -20, 90);
  rk.setNose();
  if (vh >= vc - 2 && h > 100000) {
    rk.throttle = 0; rk.thrustLevel = 0; rk.sas = 'prograde';
    return 'orbit';
  }
  // The last of the speed is added gently, so the cutoff lands on the number.
  if (vc - vh < 60) rk.throttle = clamp((vc - vh) / 60, 0.08, 1);
  return did;
}
