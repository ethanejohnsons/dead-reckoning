// Flight model for the Wayfarer, a single-engine turboprop bush plane.
// Forces come from real lift/drag/thrust physics (stalls, slips, wind and
// ground effect all emerge from it). Pitch uses a rate-command law with
// auto-trim so the aircraft holds the attitude you leave it in.
//
// Body axes follow three.js: +X right wing, +Y up, -Z out the nose.

import { Vector3, Quaternion } from 'three';
import { clamp, smoothstep, noise1 } from '../core/noise.js';

export const G = 9.81;
export const RHO0 = 1.225;
export const KT = 1.94384, FT = 3.28084, NM = 1852;
export const airDensity = (alt) => RHO0 * Math.exp(-alt / 8500);

export const SPEC = {
  mass: 2900, S: 26, span: 15.9,
  Ipitch: 9500, Iyaw: 17000, Iroll: 8500,
  CL0: 0.27, CLa: 5.0, CD0: 0.027, K: 0.046,
  power: 520e3, propEff: 0.82, staticThrust: 9500,
  fuelCap: 1000, fuelFlow: 0.042,           // kg, kg/s at full power
  // Wheel contact points (body frame): two mains just aft of the CG, one nose wheel.
  wheels: [
    { x: -1.7, y: -1.75, z: 0.3, k: 95e3, c: 12e3, main: true },
    { x: 1.7, y: -1.75, z: 0.3, k: 95e3, c: 12e3, main: true },
    { x: 0, y: -1.75, z: -3.1, k: 45e3, c: 7e3, main: false },
  ],
  // Points that must never touch the ground: nose, tail, wingtips, belly.
  hull: [[0, 0.1, -5.2], [0, 0.9, 6.0], [-7.9, 1.25, 0.3], [7.9, 1.25, 0.3], [0, -0.85, 0.5]],
  gearHeight: 1.6,
};

const QREF = 0.5 * RHO0 * 60 * 60;
const D2R = Math.PI / 180;

const v1 = new Vector3(), v2 = new Vector3(), v3 = new Vector3(), v4 = new Vector3();
const F = new Vector3(), TQ = new Vector3(), qInv = new Quaternion(), dq = new Quaternion();
const fwd = new Vector3(), right = new Vector3(), up = new Vector3();

export class Aircraft {
  constructor() {
    this.pos = new Vector3(); this.vel = new Vector3();
    this.quat = new Quaternion(); this.omega = new Vector3();
    this.throttle = 0; this.thrustLevel = 0;
    this.flapTarget = 0; this.flap = 0;           // 0, 0.5, 1
    this.brake = 0;
    this.elev = 0; this.ail = 0; this.rud = 0;    // surface deflections -1..1
    this.trimI = 0;
    this.ice = 0; this.fuel = SPEC.fuelCap;
    this.onGround = false; this.wheelsDown = 0;
    this.crashed = null;                           // reason string once crashed
    this.touchdown = null;                         // {sink, speed} of the last touchdown
    this.t = 0;
    // Air data, refreshed every step
    this.alpha = 0; this.beta = 0; this.tas = 0; this.ias = 0; this.stall = 0;
    this.gLoad = 1; this.agl = 1000; this.maxAgl = 0;
    this.surface = 'paved';
  }

  /** Place the aircraft at rest on the ground, pointing along heading (deg true). */
  placeOnGround(x, z, groundY, headingDeg) {
    this.pos.set(x, groundY + SPEC.gearHeight + 0.02, z);
    this.vel.set(0, 0, 0); this.omega.set(0, 0, 0);
    this.quat.setFromAxisAngle(v1.set(0, 1, 0), -headingDeg * D2R);
    this.throttle = 0; this.thrustLevel = 0; this.flapTarget = 0; this.flap = 0; this.brake = 1;
    this.trimI = 0; this.ice = 0; this.crashed = null; this.touchdown = null;
    this.onGround = true; this.maxAgl = 0; this.agl = 0;
  }

  /** Place in flight (used for air starts and tests). */
  placeInAir(x, y, z, headingDeg, speed) {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(v1.set(0, 1, 0), -headingDeg * D2R);
    this.vel.set(0, 0, -speed).applyQuaternion(this.quat);
    this.omega.set(0, 0, 0); this.trimI = 0; this.throttle = 0.7; this.thrustLevel = 0.7;
    this.crashed = null; this.onGround = false; this.flap = this.flapTarget = 0; this.maxAgl = 100;
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
    const q = this.quat;
    const rho = airDensity(this.pos.y);

    // Slew actuators and engine
    this.flap += clamp(this.flapTarget - this.flap, -dt * 0.22, dt * 0.22);
    const thrTarget = this.fuel > 0 ? this.throttle : 0;
    this.thrustLevel += (thrTarget - this.thrustLevel) * Math.min(1, dt / 0.9);
    this.fuel = Math.max(0, this.fuel - SPEC.fuelFlow * (0.12 + 0.88 * this.thrustLevel) * dt);

    // --- Air data
    qInv.copy(q).invert();
    const vb = v1.copy(this.vel).sub(env.wind).applyQuaternion(qInv);
    const V = vb.length(), u = -vb.z;
    const alpha = V > 1 ? Math.atan2(-vb.y, u) : 0;
    const beta = V > 1 ? Math.atan2(vb.x, Math.hypot(u, vb.y)) : 0;
    const qbar = 0.5 * rho * V * V, qn = Math.min(qbar / QREF, 3), sqn = Math.sqrt(qn);
    this.alpha = alpha; this.beta = beta; this.tas = V; this.ias = V * Math.sqrt(rho / RHO0);

    // --- Lift, drag, side force
    const ice = this.ice, flap = this.flap;
    const aStall = (15.5 - 2.5 * flap - 5 * ice) * D2R;
    const sig = Math.max(smoothstep(aStall, aStall + 7 * D2R, alpha), smoothstep(11 * D2R, 17 * D2R, -alpha));
    this.stall = sig;
    const CLlin = SPEC.CL0 + 0.62 * flap + SPEC.CLa * alpha;
    const CLflat = 1.05 * Math.sin(2 * alpha);
    const CL = (CLlin + (CLflat - CLlin) * sig) * (1 - 0.25 * ice);
    // Ground effect trims induced drag within a wingspan of the surface.
    const ge = 1 - 0.45 * Math.exp(-Math.pow(Math.max(this.agl, 0) / (0.35 * SPEC.span), 2));
    const s2 = Math.sin(alpha);
    let CD = SPEC.CD0 + 0.012 + 0.055 * flap * flap + 0.02 * flap + SPEC.K * ge * CLlin * CLlin;
    CD = CD + (0.12 + 1.7 * s2 * s2 - CD) * sig;
    CD = CD * (1 + 1.6 * ice) + 0.35 * Math.sin(beta) * Math.sin(beta);
    const CY = -0.95 * clamp(beta, -0.5, 0.5);

    F.set(0, 0, 0);
    if (V > 0.5) {
      const vh = v2.copy(vb).multiplyScalar(1 / V);
      const lift = v3.set(0, -vh.z, vh.y).normalize();             // X cross v
      const qS = qbar * SPEC.S;
      F.addScaledVector(lift, qS * CL).addScaledVector(vh, -qS * CD);
      F.x += qS * CY;
    }
    // Thrust: constant-power prop, capped at static thrust; thinner air, less power.
    const dens = Math.pow(rho / RHO0, 0.75);
    const thrust = this.thrustLevel * Math.min(SPEC.staticThrust, (SPEC.power * SPEC.propEff) / Math.max(V, 1)) * dens
      - (1 - this.thrustLevel) * 0.012 * qbar * SPEC.S * 0.3;       // windmilling drag at idle
    F.z -= thrust;
    const Faero = v4.copy(F);
    F.applyQuaternion(q);
    F.y -= SPEC.mass * G;

    // --- Control law and aerodynamic moments (expressed as angular accelerations)
    const om = this.omega;
    const wow = this.wheelsDown > 0;
    let de;
    if (wow) {
      de = input.pitch; this.trimI = 0;
    } else {
      const qMax = Math.min(0.62, (2.7 * G) / Math.max(V, 30));
      // Turn compensation: add the pitch rate a level, coordinated turn needs at this
      // bank angle, so rolling into a turn doesn't immediately drop the nose.
      const bank = Math.min(Math.abs(this.bank), 0.9);
      const qTurn = (G / Math.max(V, 25)) * Math.sin(bank) * Math.tan(bank) * (1 - smoothstep(0.6, 0.9, bank) * 0.5);
      const qCmd = input.pitch * (input.pitch > 0 ? qMax : qMax * 0.7) + qTurn * (1 - sig);
      const err = qCmd - om.x;
      const raw = 1.6 * err + this.trimI;
      de = clamp(raw, -1, 1);
      if (raw === de || Math.sign(err) !== Math.sign(raw)) this.trimI = clamp(this.trimI + 5.5 * err * dt, -0.85, 0.85);
    }
    const slew = dt * 6;
    this.elev += clamp(de - this.elev, -slew, slew);
    this.ail += clamp(input.roll - this.ail, -slew, slew);
    this.rud += clamp(input.yaw - this.rud, -slew, slew);

    const auth = 1 - 0.45 * sig;                                    // controls go mushy in the stall
    const t = this.t, tb = env.turb;
    let aPitch = qn * (3.5 * this.elev * auth - 9.5 * (alpha - 2 * D2R) - 2.2 * sig) - 3.2 * sqn * om.x;
    let aRollR = qn * (4.6 * this.ail * auth - 2.2 * beta) - 4.2 * sqn * -om.z + 0.35 * sqn * -om.y;
    let aYawR = qn * (1.25 * this.rud + 6.5 * beta - 0.22 * this.ail) - 2.6 * sqn * -om.y;
    // Wing drop in the stall, and turbulence shaking the airframe.
    aRollR += qn * sig * 2.4 * noise1(t * 0.9, 5);
    if (tb > 0.01) {
      aPitch += tb * sqn * 2.2 * noise1(t * 1.7, 11);
      aRollR += tb * sqn * 3.0 * noise1(t * 1.3, 12);
      aYawR += tb * sqn * 1.2 * noise1(t * 1.1, 13);
    }
    TQ.set(aPitch * SPEC.Ipitch, -aYawR * SPEC.Iyaw, -aRollR * SPEC.Iroll);

    // --- Landing gear and ground contact
    let down = 0;
    this.agl = this.pos.y - SPEC.gearHeight - env.ground(this.pos.x, this.pos.z);
    if (this.agl > this.maxAgl) this.maxAgl = this.agl;
    if (this.agl < 25) {
      fwd.set(0, 0, -1).applyQuaternion(q); right.set(1, 0, 0).applyQuaternion(q);
      const steer = input.yaw * 0.34 * clamp(1.1 - this.groundSpeed / 30, 0.08, 1);
      for (const w of SPEC.wheels) {
        const r = v1.set(w.x, w.y, w.z).applyQuaternion(q);
        const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
        const gy = env.ground(px, pz);
        const pen = gy - py;
        if (pen <= 0) continue;
        const surf = env.surface(px, pz);
        if (surf === 'water') { this.crashed = 'Ditched in the water'; return; }
        // velocity of the contact point: v + omega x r (omega is body-frame)
        const pv = v2.copy(om).applyQuaternion(q).cross(r).add(this.vel);
        const Nf = clamp(w.k * pen - w.c * pv.y, 0, SPEC.mass * G * 5);
        if (Nf <= 0) continue;
        if (down === 0 && !this.onGround) {
          const sink = -this.vel.y;
          this.touchdown = { sink, speed: this.groundSpeed, t: this.t };
          if (sink > 6.2) { this.crashed = 'Hit the ground too hard'; return; }
        }
        down++;
        // Wheel heading on the ground plane (nose wheel steers).
        let hx = fwd.x, hz = fwd.z;
        if (!w.main) { const cs = Math.cos(steer), sn = Math.sin(steer); const nx = hx * cs - hz * sn; hz = hx * sn + hz * cs; hx = nx; }
        const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
        const sx = -hz, sz = hx;                                     // wheel's right-hand side
        const vLong = pv.x * hx + pv.z * hz, vLat = pv.x * sx + pv.z * sz;
        const mu = surf === 'paved' ? 0.8 : 0.6;
        const roll = surf === 'paved' ? 0.02 : surf === 'gravel' ? 0.035 : 0.075;
        const fLat = -clamp(vLat * Nf * 2.2, -mu * Nf, mu * Nf);
        const fLong = -clamp(vLong / 0.4, -1, 1) * Nf * (roll + (w.main ? this.brake * 0.42 : 0));
        const fx = fLat * sx + fLong * hx, fz = fLat * sz + fLong * hz;
        F.x += fx; F.y += Nf; F.z += fz;
        // Torque: normal force at the wheel, friction applied at CG height (yaw only).
        v3.set(r.z * -Nf, r.z * fx - r.x * fz, r.x * Nf);           // r x (0,Nf,0) + (rx,0,rz) x (fx,0,fz)
        TQ.add(v3.applyQuaternion(qInv));
        this.surface = surf;
      }
      // Anything other than wheels touching the ground is a crash.
      if (this.groundSpeed > 9 || Math.abs(this.vel.y) > 3) {
        for (const h of SPEC.hull) {
          const r = v1.set(h[0], h[1], h[2]).applyQuaternion(q);
          if (env.ground(this.pos.x + r.x, this.pos.z + r.z) - (this.pos.y + r.y) > 0.15) {
            this.crashed = h[0] !== 0 ? 'Wingtip struck the ground' : h[2] < 0 ? 'Flew into terrain' : 'Struck the ground';
            return;
          }
        }
      }
    }
    this.wheelsDown = down;
    this.onGround = down > 0;

    // --- Integrate
    this.gLoad = Faero.y / (SPEC.mass * G);
    this.vel.addScaledVector(F, dt / SPEC.mass);
    this.pos.addScaledVector(this.vel, dt);
    om.x += (TQ.x / SPEC.Ipitch) * dt; om.y += (TQ.y / SPEC.Iyaw) * dt; om.z += (TQ.z / SPEC.Iroll) * dt;
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
