// Flight model. It began as the Skyhawk-class trainer's (a high-wing piston single with a fixed-pitch
// propeller and fixed tricycle gear) and flies anything whose numbers it is given (see variants.js):
// jets have their own thrust law, drag that rises near the speed of sound, airbrakes and legs that fold away.
// Forces come from real lift/drag/thrust physics (stalls, slips, wind and
// ground effect all emerge from it). Pitch uses a rate-command law with
// auto-trim so the aircraft holds the attitude you leave it in.
//
// Body axes follow three.js: +X right wing, +Y up, -Z out the nose.

import { Vector3, Quaternion } from 'three';
import { clamp, smoothstep, noise1 } from '../core/noise.js';
import { AIRCRAFT } from './variants.js';

export const G = 9.81;
export const RHO0 = 1.225;
export const KT = 1.94384, FT = 3.28084, NM = 1852;
export const airDensity = (alt) => RHO0 * Math.exp(-alt / 8500);
/** Speed of sound (m/s) at an altitude: it falls with the temperature up to the tropopause, then holds. */
export const speedOfSound = (alt) => 340.3 * Math.sqrt(Math.max(216.65, 288.15 - 0.0065 * alt) / 288.15);

// The numbers come per aircraft (see variants.js): `new Aircraft(spec)` or `ac.setSpec(spec)`. SPEC is the
// 172's set, kept for readers that want a default; the aircraft being flown is always `ac.spec`.
export const SPEC = AIRCRAFT[0].spec;

const D2R = Math.PI / 180;

const v1 = new Vector3(), v2 = new Vector3(), v3 = new Vector3(), v4 = new Vector3();
const F = new Vector3(), TQ = new Vector3(), qInv = new Quaternion(), dq = new Quaternion();
const fwd = new Vector3(), right = new Vector3(), up = new Vector3(), nrm = new Vector3(), v5 = new Vector3(), v6 = new Vector3();

/** Unit normal of the ground at (x, z), into `out`. */
function groundNormal(env, x, z, out) {
  const e = 1.5;
  return out.set(env.ground(x - e, z) - env.ground(x + e, z), 2 * e, env.ground(x, z - e) - env.ground(x, z + e)).normalize();
}
const STRIKE_REASON = { nose: 'Flew into the ground', tail: 'Broke the tail on the ground', tipL: 'Wingtip struck the ground', tipR: 'Wingtip struck the ground', belly: 'Struck the ground', top: 'Came down inverted' };

export class Aircraft {
  constructor(spec = SPEC) {
    this.spec = spec;
    this.pos = new Vector3(); this.vel = new Vector3();
    this.quat = new Quaternion(); this.omega = new Vector3();
    this.throttle = 0; this.thrustLevel = 0; this.rpm = 0;
    this.flapTarget = 0; this.flap = 0;           // 0, 0.5, 1
    this.gearTarget = 1; this.gear = 1;           // landing gear: 1 down and locked, 0 up (only aircraft with spec.retract move it)
    this.mach = 0; this.reheat = 0; this.airbrake = 0;       // Mach number; afterburner and airbrakes, 0..1
    this.brake = 0;
    this.elev = 0; this.ail = 0; this.rud = 0;    // surface deflections -1..1
    this.trimI = 0;
    this.ice = 0; this.fuel = spec.fuelCap;
    this.onGround = false; this.wheelsDown = 0;
    this.crashed = null;                           // reason string once crashed
    this.touchdown = null;                         // {sink, closing, speed, t, hard} of the last touchdown
    // Light contact of anything but the wheels (see the hull points in variants.js):
    this.scrape = 0;                               // 0..1, how hard something is dragging along the ground right now
    this.scrapePart = null;                        // 'tail' | 'nose' | 'tipL' | 'tipR' | 'belly' while it does
    this.strike = null;                            // {part, vn, speed, t}: a new object each time a part first touches
    this.strikes = 0;
    this._hullT = {};
    this.t = 0;
    // Air data, refreshed every step
    this.alpha = 0; this.beta = 0; this.tas = 0; this.ias = 0; this.stall = 0;
    this.gLoad = 1; this.agl = 1000; this.maxAgl = 0;
    this.surface = 'paved';
  }

  /** Take on another variant's numbers (call before placing the aircraft). */
  setSpec(spec) { this.spec = spec; this.fuel = spec.fuelCap; }

  /** Place the aircraft at rest on the ground, pointing along heading (deg true). */
  placeOnGround(x, z, groundY, headingDeg) {
    this.pos.set(x, groundY + this.spec.gearHeight + 0.02, z);
    this.vel.set(0, 0, 0); this.omega.set(0, 0, 0);
    this.quat.setFromAxisAngle(v1.set(0, 1, 0), -headingDeg * D2R);
    if (this.spec.groundPitch) this.quat.multiply(dq.setFromAxisAngle(v1.set(1, 0, 0), this.spec.groundPitch));      // a tail-dragger stands nose-high on its tail wheel
    this.throttle = 0; this.thrustLevel = 0; this.flapTarget = 0; this.flap = 0; this.brake = 1;
    this.gear = this.gearTarget = 1; this.reheat = 0; this.airbrake = 0;
    this.trimI = 0; this.ice = 0; this.crashed = null; this.touchdown = null;
    this.scrape = 0; this.scrapePart = null; this.strike = null; this._hullT = {};
    this.onGround = true; this.maxAgl = 0; this.agl = 0;
  }

  /** Place in flight (used for air starts and tests). */
  placeInAir(x, y, z, headingDeg, speed) {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(v1.set(0, 1, 0), -headingDeg * D2R);
    this.vel.set(0, 0, -speed).applyQuaternion(this.quat);
    this.omega.set(0, 0, 0); this.trimI = 0; this.throttle = this.thrustLevel = this.spec.cruiseThrottle;
    this.gear = this.gearTarget = this.spec.retract ? 0 : 1; this.reheat = 0; this.airbrake = 0;
    this.crashed = null; this.onGround = false; this.flap = this.flapTarget = 0; this.maxAgl = 100;
    this.scrape = 0; this.scrapePart = null; this.strike = null; this._hullT = {}; this.wheelsDown = 0;
  }

  /**
   * Flaps and landing gear set themselves; call once a frame before stepping. A piston single's flaps come out for
   * a slow approach with the power back and go in again as power comes on. A jet's follow airspeed alone (they stay
   * out through the take-off and the climb away). Legs that can fold do so once the aircraft is climbing, and come
   * down again for a slow descent toward the ground.
   */
  configure() {
    const sp = this.spec, [half, full, up] = sp.flapAuto;
    if (!sp.jet) {
      if (this.throttle < 0.45 && this.ias < half && !this.onGround) this.flapTarget = this.ias < full ? 1 : 0.5;
      else if (this.throttle > 0.6 || this.ias > up || this.onGround) this.flapTarget = 0;
    } else if (this.onGround) this.flapTarget = this.throttle > 0.5 || this.groundSpeed > 20 ? 0.5 : 0;
    else if (this.ias < full) this.flapTarget = 1;
    else if (this.ias < half) this.flapTarget = Math.max(this.flapTarget, 0.5);
    else if (this.ias > up) this.flapTarget = 0;
    if (!sp.retract) return;
    if (this.onGround) this.gearTarget = 1;
    else if (this.gearTarget === 1) { if ((this.vel.y > 2.5 && this.agl > 15) || this.ias > sp.gearSpeed * 1.08 || this.agl > 700) this.gearTarget = 0; }
    else if (this.agl < 500 && this.ias < sp.gearSpeed && this.vel.y < 1) this.gearTarget = 1;
  }

  get heading() { fwd.set(0, 0, -1).applyQuaternion(this.quat); return (Math.atan2(fwd.x, -fwd.z) / D2R + 360) % 360; }
  get pitch() { fwd.set(0, 0, -1).applyQuaternion(this.quat); return Math.asin(clamp(fwd.y, -1, 1)); }
  get bank() {
    right.set(1, 0, 0).applyQuaternion(this.quat); up.set(0, 1, 0).applyQuaternion(this.quat);
    return Math.atan2(-right.y, up.y);
  }
  /** Ground track (deg true) and ground speed (m/s). */
  get track() { return (Math.atan2(this.vel.x, -this.vel.z) / D2R + 360) % 360; }
  get groundSpeed() { return Math.hypot(this.vel.x, this.vel.z); }

  /**
   * Advance one fixed step.
   * input: {pitch, roll, yaw} in -1..1 (pitch + = nose up, roll + = right, yaw + = right)
   * env: {wind: Vector3 (world, m/s, including gusts and vertical air motion),
   *       turb: 0..1, ground(x,z) -> height, surface(x,z) -> 'paved'|'gravel'|'grass'|'water'}
   */
  step(dt, input, env) {
    if (this.crashed) return;
    this.t += dt;
    const S = this.spec, q = this.quat, QREF = 0.5 * RHO0 * S.vRef * S.vRef;      // dynamic pressure the control gains are quoted at
    const rho = airDensity(this.pos.y);

    // Slew actuators and engine
    this.flap += clamp(this.flapTarget - this.flap, -dt * 0.22, dt * 0.22);
    const thrTarget = this.fuel > 0 ? this.throttle : 0;
    this.thrustLevel += (thrTarget - this.thrustLevel) * Math.min(1, dt / S.spool);
    if (S.retract) this.gear += clamp(this.gearTarget - this.gear, -dt / S.retract, dt / S.retract);
    this.fuel = Math.max(0, this.fuel - S.fuelFlow * (0.12 + 0.88 * this.thrustLevel) * dt);

    // --- Air data
    qInv.copy(q).invert();
    const vb = v1.copy(this.vel).sub(env.wind).applyQuaternion(qInv);
    const V = vb.length(), u = -vb.z;
    const alpha = V > 1 ? Math.atan2(-vb.y, u) : 0;
    const beta = V > 1 ? Math.atan2(vb.x, Math.hypot(u, vb.y)) : 0;
    const qbar = 0.5 * rho * V * V, qn = Math.min(qbar / QREF, 3), sqn = Math.sqrt(qn);
    this.alpha = alpha; this.beta = beta; this.tas = V; this.ias = V * Math.sqrt(rho / RHO0);
    const mach = V / speedOfSound(this.pos.y);
    this.mach = mach;

    // --- Lift, drag, side force
    const ice = this.ice, flap = this.flap;
    const aStall = (S.aStall - 2.5 * flap - 5 * ice) * D2R;
    const sig = Math.max(smoothstep(aStall, aStall + 7 * D2R, alpha), smoothstep(11 * D2R, 17 * D2R, -alpha));
    this.stall = sig;
    const CLlin = S.CL0 + S.flapLift * flap + S.CLa * alpha;
    const CLflat = 1.05 * Math.sin(2 * alpha);
    const CL = (CLlin + (CLflat - CLlin) * sig) * (1 - 0.25 * ice);
    // Ground effect trims induced drag within a wingspan of the surface.
    const ge = 1 - S.groundEffect * Math.exp(-Math.pow(Math.max(this.agl, 0) / (0.35 * S.span), 2));
    const s2 = Math.sin(alpha);
    let CD = S.CD0 + 0.012 + (0.055 * flap * flap + 0.02 * flap) * S.flapDrag + S.K * ge * CLlin * CLlin;
    CD = CD + (0.12 + 1.7 * s2 * s2 - CD) * sig;
    if (S.jet) {
      // Near the speed of sound the drag climbs steeply (and eases a little once well past it); open airbrakes
      // add their own. The airbrakes come out by themselves as the lever reaches idle. (Legs in the airflow: below.)
      this.airbrake += ((1 - smoothstep(0.02, 0.12, this.throttle)) - this.airbrake) * Math.min(1, dt * 2.5);
      CD += S.waveDrag * smoothstep(S.mCrit, S.mCrit + 0.18, mach) * (1 - 0.35 * smoothstep(1.1, 2.0, mach)) + S.brakeDrag * this.airbrake;
    }
    if (S.retract) CD += S.gearDrag * this.gear;
    CD = CD * (1 + 1.6 * ice) + 0.35 * Math.sin(beta) * Math.sin(beta);
    const CY = -0.95 * clamp(beta, -0.5, 0.5);

    F.set(0, 0, 0);
    if (V > 0.5) {
      const vh = v2.copy(vb).multiplyScalar(1 / V);
      const lift = v3.set(0, -vh.z, vh.y).normalize();             // X cross v
      const qS = qbar * S.S;
      F.addScaledVector(lift, qS * CL).addScaledVector(vh, -qS * CD);
      F.x += qS * CY;
    }
    // Thrust: fixed-pitch prop. Strongest standing still, fading with airspeed; thinner air, less power.
    const tl = this.thrustLevel;
    let thrust, rpmT;
    if (S.jet) {
      // Jet: thrust falls off a little with speed (a fighter's grows again with ram pressure) and thins with the air.
      // Idle still pushes a little. With an afterburner, the last part of the lever's travel lights it.
      const ab = S.reheat ? smoothstep(0.86, 1, tl) : 0, dry = S.reheat ? Math.min(tl / 0.86, 1) : tl;
      this.reheat = this.fuel > 0 ? ab : 0;
      const lapse = Math.max(0.3, 1 - S.thrustLapse * mach + S.thrustRam * mach * mach * ab);       // (ram pressure only pays with the afterburner lit)
      thrust = this.fuel > 0 ? (S.idleThrust + (1 - S.idleThrust) * dry) * (1 + (S.reheat - 1) * ab) * S.staticThrust * lapse * Math.pow(rho / RHO0, 0.7) : 0;
      // "rpm" is the fan speed in percent, for the panel and the sound
      rpmT = this.fuel > 0 ? S.rpmIdle + (S.rpmMax - S.rpmIdle) * Math.pow(dry, 0.75) : clamp(u * 0.12, 0, 18);
    } else {
      const dens = Math.pow(rho / RHO0, 0.75);
      const full = Math.min(S.staticThrust * Math.max(0, 1 - V / S.propZero), (S.power * S.propEff) / Math.max(V, 1));
      // The lever sets power more than thrust, so the first part of its travel does the most.
      const pull = tl * (1.55 - 0.55 * tl);
      thrust = pull * full * dens
        - (1 - tl) * 0.012 * qbar * S.S * 0.3;                     // windmilling drag at idle
      // Engine speed for the tachometer: a fixed-pitch prop unloads and spins up as the aircraft accelerates.
      rpmT = this.fuel > 0 ? Math.min(S.rpmMax, S.rpmIdle + (S.rpmStatic - S.rpmIdle) * Math.pow(tl, 0.8) + S.rpmWind * u * (0.25 + 0.75 * tl)) : clamp(u * 22, 0, 1100);
    }
    this.rpm += (rpmT - this.rpm) * Math.min(1, dt * 4);
    F.z -= thrust;
    const Faero = v4.copy(F);
    F.applyQuaternion(q);
    F.y -= S.mass * G;

    // --- Control law and aerodynamic moments (expressed as angular accelerations)
    const om = this.omega;
    const wow = this.wheelsDown > 0;
    let de;
    if (wow) {
      // Direct elevator on the ground, eased off as the nose comes up so the tail cannot be dragged.
      de = Math.min(input.pitch, (S.rotatePitch - this.pitch) * 9); this.trimI = 0;
    } else {
      const qMax = Math.min(S.pitchRate, (S.gPull * G) / Math.max(V, 30));
      // Turn compensation: add the pitch rate a level, coordinated turn needs at this
      // bank angle, so rolling into a turn doesn't immediately drop the nose.
      const bank = Math.min(Math.abs(this.bank), 0.9);
      const qTurn = (G / Math.max(V, 20)) * Math.sin(bank) * Math.tan(bank) * (1 - smoothstep(0.6, 0.9, bank) * 0.5);
      // Rolling into a steeper bank needs more lift; feed the extra angle of attack in as the bank
      // changes (and take it out again rolling level) so the flight path does not sag or balloon.
      const steep = Math.abs(this.bank) < 0.9 ? -om.z * Math.sign(this.bank) : 0;
      const qLoad = (Math.min(1.2, (S.mass * G) / (Math.max(qbar, 80) * S.S)) / S.CLa) * (Math.tan(bank) / Math.cos(bank)) * steep;
      const qCmd = input.pitch * (input.pitch > 0 ? qMax : qMax * 0.7) + (qTurn + qLoad) * (1 - sig);
      const err = qCmd - om.x;
      const raw = S.pitchGain * err + this.trimI;
      de = clamp(raw, -1, 1);
      if (raw === de || Math.sign(err) !== Math.sign(raw)) this.trimI = clamp(this.trimI + 5.5 * err * dt, -0.85, 0.85);
    }
    // The tail on the runway stops the rotation: for a moment after it touches, the elevator cannot ask for more nose-up.
    if (this.t - (this._hullT.tail ?? -9) < 0.3) { de = Math.min(de, -0.2); this.trimI = Math.min(this.trimI, 0); }
    const slew = dt * 6;
    this.elev += clamp(de - this.elev, -slew, slew);
    this.ail += clamp(input.roll - this.ail, -slew, slew);
    this.rud += clamp(input.yaw - this.rud, -slew, slew);

    const auth = 1 - 0.45 * sig;                                    // controls go mushy in the stall
    const t = this.t, tb = env.turb;
    // The propeller blows over the tail, so elevator and rudder still bite at low speed with power on.
    const qt = qn + 0.3 * Math.max(thrust, 0) / S.washRef;
    // Yaw rate of a balanced turn at this bank. Yaw damping works about it rather than about zero,
    // so a banked aircraft turns without skidding and needs no rudder to stay coordinated.
    const bk = this.bank;
    const rTurn = wow ? 0 : (G / Math.max(V, 20)) * Math.sin(clamp(bk, -0.9, 0.9)) * (1 - sig) * (1 - smoothstep(1.2, 1.7, Math.abs(bk)));
    const rErr = -om.y - rTurn;
    let aPitch = qt * S.pitchPower * this.elev * auth - qn * (S.pitchStiff * (alpha - 2 * D2R) + 2.2 * sig) - S.pitchDamp * sqn * om.x;
    // (the last term is a trace of spiral stability: left alone, a banked aircraft very slowly rolls level)
    let aRollR = qn * (S.rollPower * this.ail * auth - 2.2 * beta) - S.rollDamp * sqn * -om.z + 0.35 * sqn * rErr - (wow ? 0 : 0.045 * sqn * Math.sin(bk));
    let aYawR = qt * S.yawPower * this.rud + qn * (6.5 * beta - 0.22 * this.ail) - 2.6 * sqn * rErr;
    // Wing drop in the stall, and turbulence shaking the airframe.
    aRollR += qn * sig * 2.4 * noise1(t * 0.9, 5);
    if (tb > 0.01) {
      aPitch += tb * sqn * 2.2 * noise1(t * 1.7, 11);
      aRollR += tb * sqn * 3.0 * noise1(t * 1.3, 12);
      aYawR += tb * sqn * 1.2 * noise1(t * 1.1, 13);
    }
    TQ.set(aPitch * S.Ipitch, -aYawR * S.Iyaw, -aRollR * S.Iroll);

    // --- Landing gear and ground contact
    let down = 0;
    this.agl = this.pos.y - S.gearHeight - env.ground(this.pos.x, this.pos.z);
    if (this.agl > this.maxAgl) this.maxAgl = this.agl;
    if (this.agl < 25) {
      fwd.set(0, 0, -1).applyQuaternion(q); right.set(1, 0, 0).applyQuaternion(q);
      const steer = input.yaw * 0.34 * clamp(1.1 - this.groundSpeed / S.steerFade, 0.08, 1);
      for (const w of S.wheels) {
        if (this.gear < 0.9) break;                                  // legs not down and locked: the hull meets the ground instead
        const r = v1.set(w.x, w.y, w.z).applyQuaternion(q);
        const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
        const gy = env.ground(px, pz);
        const pen = gy - py;
        if (pen <= 0) continue;
        const surf = env.surface(px, pz);
        if (surf === 'water') { this.crashed = 'Ditched in the water'; return; }
        // velocity of the contact point: v + omega x r (omega is body-frame)
        const pv = v2.copy(om).applyQuaternion(q).cross(r).add(this.vel);
        // Spring-steel legs: firm going down, lightly damped coming back, so a hard arrival is thrown back into the air.
        const Nf = clamp(w.k * pen - w.c * pv.y * (pv.y > 0 && w.main ? S.gearRebound : 1), 0, S.mass * G * 5);
        if (Nf <= 0) continue;
        if (down === 0 && !this.onGround) {
          // Closing speed along the ground's own normal, so flying level into a hillside counts as well as sinking onto a runway.
          const sink = -this.vel.y, closing = Math.max(sink, -this.vel.dot(groundNormal(env, px, pz, nrm)));
          this.touchdown = { sink, closing, speed: this.groundSpeed, t: this.t, hard: closing > 3 };
          if (closing > S.sinkMax) { this.crashed = sink > 0.7 * closing ? 'Hit the ground too hard' : 'Flew into terrain'; return; }
        }
        down++;
        // Wheel heading on the ground plane (nose wheel steers).
        let hx = fwd.x, hz = fwd.z;
        if (!w.main) { const cs = Math.cos(steer), sn = Math.sin(w.z > 0 ? -steer : steer); /* (a tail wheel steers the other way) */ const nx = hx * cs - hz * sn; hz = hx * sn + hz * cs; hx = nx; }
        const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        const sx = -hz, sz = hx;                                     // wheel's right-hand side
        const vLong = pv.x * hx + pv.z * hz, vLat = pv.x * sx + pv.z * sz;
        const mu = surf === 'paved' ? 0.8 : 0.6;
        const roll = surf === 'paved' ? 0.02 : surf === 'gravel' ? 0.035 : 0.075;
        const fLat = -clamp(vLat * Nf * 2.2, -mu * Nf, mu * Nf);
        const fLong = -clamp(vLong / 0.4, -1, 1) * Nf * (roll + (w.main ? this.brake * S.brake : 0));
        const fx = fLat * sx + fLong * hx, fz = fLat * sz + fLong * hz;
        F.x += fx; F.y += Nf; F.z += fz;
        // Torque: normal force at the wheel, friction applied at CG height (yaw only).
        // (A tail-dragger's main wheels are ahead of its center of gravity, where their grip would swing it round the
        // moment the tail came up. No one wants to fight that here: their grip turns the aircraft as if they sat a
        // little behind it, as a nose-wheel aircraft's do.)
        let ax = r.x, az = r.z;
        if (w.main && S.tailSteady) { ax -= fwd.x * S.tailSteady; az -= fwd.z * S.tailSteady; }
        v3.set(r.z * -Nf, az * fx - ax * fz, r.x * Nf);             // r x (0,Nf,0) + (rx,0,rz) x (fx,0,fz)
        TQ.add(v3.applyQuaternion(qInv));
        this.surface = surf;
      }
      // Anything else that meets the ground. A light touch is survivable: the part pushes back and drags
      // (a tail scrape on over-rotation nudges the nose down and bleeds speed, a wingtip on the grass
      // swings the aircraft around it). It is a crash only when the part arrives faster than it can take,
      // when a wingtip digs in at speed (a cartwheel), or when the aircraft comes down on its back.
      let scr = 0, part = null;
      up.set(0, 1, 0).applyQuaternion(q);
      for (const h of S.hull) {
        const r = v1.set(h.p[0], h.p[1], h.p[2]).applyQuaternion(q);
        const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
        const pen = env.ground(px, pz) - py;
        if (pen <= 0) continue;
        const n = groundNormal(env, px, pz, nrm);
        const pv = v2.copy(om).applyQuaternion(q).cross(r).add(this.vel);
        const vn = -pv.dot(n), slide = v5.copy(pv).addScaledVector(n, vn), vs = slide.length(), speed = this.vel.length();
        if (env.surface(px, pz) === 'water' && speed > 6) { this.crashed = 'Ditched in the water'; return; }
        const tip = h.part === 'tipL' || h.part === 'tipR';
        if ((h.part === 'top' || up.y < 0.25) && speed > 3) { this.crashed = up.y < 0 ? 'Came down inverted' : 'Cartwheeled'; return; }
        if (vn > h.vMax) { this.crashed = STRIKE_REASON[h.part]; return; }
        if (tip && vs > S.tipDrag && (pen > 0.03 || vn > 1.2 || vs > 1.5 * S.tipDrag)) { this.crashed = 'Wingtip dug in'; return; }
        const Nf = clamp(h.k * pen + h.c * vn, 0, S.mass * G * 4);
        if (Nf <= 0) continue;
        const mu = (h.part === 'belly' ? 0.5 : 0.75) * Math.min(1, vs / 0.5);
        v3.copy(n).multiplyScalar(Nf); if (vs > 1e-4) v3.addScaledVector(slide, (-mu * Nf) / vs);
        F.add(v3);
        TQ.add(v6.copy(r).cross(v3).applyQuaternion(qInv));
        const level = clamp(vs / 25, 0, 1) * clamp(Nf / (S.mass * G * 0.25), 0.2, 1);
        if (level >= scr) { scr = level; part = h.part; }
        if (this.t - (this._hullT[h.part] ?? -9) > 0.4) { this.strike = { part: h.part, vn, speed, t: this.t }; this.strikes++; }
        this._hullT[h.part] = this.t;
      }
      this.scrape += (scr - this.scrape) * Math.min(1, dt * (scr > this.scrape ? 40 : 7));
      this.scrapePart = part || (this.scrape > 0.02 ? this.scrapePart : null);
    } else { this.scrape = 0; this.scrapePart = null; }
    this.wheelsDown = down;
    this.onGround = down > 0;

    // --- Integrate
    this.gLoad = Faero.y / (S.mass * G);
    this.vel.addScaledVector(F, dt / S.mass);
    this.pos.addScaledVector(this.vel, dt);
    om.x += (TQ.x / S.Ipitch) * dt; om.y += (TQ.y / S.Iyaw) * dt; om.z += (TQ.z / S.Iroll) * dt;
    const wl = om.length();
    if (wl > 1e-7) {
      dq.setFromAxisAngle(v1.copy(om).multiplyScalar(1 / wl), wl * dt);
      q.multiply(dq).normalize();
    }
    // Hold a parked aircraft still against numerical creep.
    if (down === 3 && this.brake > 0.5 && this.groundSpeed < 0.25 && this.thrustLevel < 0.2) {
      this.vel.x = 0; this.vel.z = 0; om.y = 0;
    }
  }
}
