// Dead reckoning. The navigator never knows where the aircraft truly is,
// only where heading, airspeed and the clock say it should be. Wind is the
// difference. Passing over an airfield gives a fix and resets the estimate.

import { AIRPORTS } from '../world/airports.js';

const D2R = Math.PI / 180;
export const NDB_RANGE = 170000;

export class Nav {
  constructor() {
    this.dr = { x: 0, z: 0 }; this.track = []; this.fixes = [];
    this.sinceFix = 0; this.distSinceFix = 0; this.station = null; this.trackT = 0; this.fixCool = 0;
    this.onFix = null; this.maxError = 0;
  }

  reset(x, z, name, station) {
    this.dr.x = x; this.dr.z = z;
    this.track = [x, z]; this.fixes = [{ x, z, name, t: 0 }];
    this.sinceFix = 0; this.distSinceFix = 0; this.station = station; this.trackT = 0; this.fixCool = 20; this.maxError = 0;
  }

  /** Advance the estimate from heading and true airspeed alone. */
  update(dt, ac, elapsed) {
    if (!ac.onGround || ac.groundSpeed > 5) {
      const h = ac.heading * D2R, v = ac.tas * Math.cos(ac.pitch - ac.alpha);
      this.dr.x += Math.sin(h) * v * dt; this.dr.z -= Math.cos(h) * v * dt;
      this.distSinceFix += v * dt;
    } else { this.dr.x = ac.pos.x; this.dr.z = ac.pos.z; }
    this.sinceFix += dt;
    this.maxError = Math.max(this.maxError, this.error(ac));
    if ((this.trackT -= dt) <= 0) { this.trackT = 6; this.track.push(this.dr.x, this.dr.z); if (this.track.length > 4000) this.track.splice(0, 2); }
    // Overflying a known airfield is a position fix.
    this.fixCool -= dt;
    if (this.fixCool <= 0) {
      for (const a of AIRPORTS) {
        if (Math.hypot(a.x - ac.pos.x, a.z - ac.pos.z) < 2200) {
          const err = this.error(ac);
          this.dr.x = ac.pos.x; this.dr.z = ac.pos.z;
          this.track.push(this.dr.x, this.dr.z);
          this.fixes.push({ x: ac.pos.x, z: ac.pos.z, name: a.name, t: elapsed });
          this.sinceFix = 0; this.distSinceFix = 0; this.fixCool = 90;
          this.onFix?.(a, err);
          break;
        }
      }
    }
  }

  error(ac) { return Math.hypot(this.dr.x - ac.pos.x, this.dr.z - ac.pos.z); }
  /** Radius of the uncertainty circle drawn around the estimate (m). */
  get uncertainty() { return 900 + this.distSinceFix * 0.07; }

  /** Relative bearing (deg, clockwise from the nose) to the tuned beacon, or null out of range. */
  adf(ac, time) {
    const s = this.station;
    if (!s) return null;
    const dx = s.x - ac.pos.x, dz = s.z - ac.pos.z, d = Math.hypot(dx, dz);
    if (d > NDB_RANGE) return null;
    let brg = Math.atan2(dx, -dz) / D2R - ac.heading;
    // Needle hunts a little at long range and swings in the cone overhead.
    brg += Math.sin(time * 1.3) * 5 * Math.min(1, (d / NDB_RANGE) ** 3) + (d < 600 ? Math.sin(time * 4) * 40 : 0);
    return ((brg % 360) + 360) % 360;
  }

  /** True bearing from the tuned station to the aircraft, for the line of position on the chart. */
  lop(ac) {
    const s = this.station;
    if (!s) return null;
    const dx = ac.pos.x - s.x, dz = ac.pos.z - s.z;
    if (Math.hypot(dx, dz) > NDB_RANGE) return null;
    return { station: s, bearing: (Math.atan2(dx, -dz) / D2R + 360) % 360 };
  }

  tuneNext(dir = 1) {
    const i = AIRPORTS.indexOf(this.station);
    this.station = AIRPORTS[(i + dir + AIRPORTS.length) % AIRPORTS.length];
    return this.station;
  }
}

export const bearing = (ax, az, bx, bz) => (Math.atan2(bx - ax, -(bz - az)) / D2R + 360) % 360;

/** Wind-triangle solution: heading to hold a course, and the resulting ground speed. */
export function windCorrection(course, tas, wind) {
  const c = course * D2R, cx = Math.sin(c), cz = -Math.cos(c);
  const cross = wind.x * -cz + wind.z * cx;         // wind component to the right of course
  const along = wind.x * cx + wind.z * cz;
  const wca = Math.asin(Math.max(-0.9, Math.min(0.9, -cross / tas)));
  return { heading: ((course + wca / D2R) % 360 + 360) % 360, gs: tas * Math.cos(wca) + along, wca: wca / D2R };
}
