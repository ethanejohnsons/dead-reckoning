// Coming back to the launch tower and being caught by its arms: the autopilot for it (K in a Starship).
//
// The tower catches a vehicle by two pins near its top, which come to rest on the rails of the tower's two arms
// (space/pad.js); the target is the point in the air where the vehicle must hang for that. ReturnPilot flies
// whatever is left of the vehicle there from wherever it is, in three parts, as the real ones do:
//
//   aim      Where will this fall? The fall is flown ahead (gravity, the air's drag in the attitude the vehicle
//            will fall in, the turning Earth) to the height of the target, and while the answer is not "at the
//            tower", the engines burn sideways toward it: a boostback burn when the vehicle is flying away
//            downrange, small corrections later. There is no fuel to save, so it simply keeps the miss small.
//   fall     Engines off. The Ship falls flat on its belly, broadside to the air, as it does, steering with its
//            flaps so that it comes down over the tower; a booster falls engines first.
//   land     The landing burn, started as late as the engines allow: the nose swings upright (the Ship's
//            flip), the fall is braked along a curve that ends at the target, and the sideways error is steered
//            out with a tilt of at most 28 degrees. Close in, it will hold its height until it is centered.
//
// The catch itself is the game's to declare (Mission: close enough, slow enough, upright); step() returns
// 'ready' when the pilot is hovering in the arms.

import { RE, MU_E, G0, D2R, ATMO_TOP, OMEGA_E, geoToEci, enu, groundVel, dot, len, cross } from './frames.js';
import { airDensity } from './rocket.js';

const T = [0, 0, 0], B = new Array(9), d = [0, 0, 0], gv = [0, 0, 0], vr = [0, 0, 0], want = [0, 0, 0], tmp = [0, 0, 0], pr = [0, 0, 0], pv = [0, 0, 0], pt = [0, 0, 0], side = [0, 0, 0];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const TILT = Math.tan(28 * D2R);

/** How far a vehicle's turning point is from a target { lat, lon, alt }: { dist (m, over the ground), height (m, above it) }. */
export function offsetTo(rk, clock, target, out = {}) {
  geoToEci(clock, rk.t, target.lat, target.lon, target.alt, T); enu(T, B);
  for (let i = 0; i < 3; i++) d[i] = rk.r[i] - T[i];
  out.dist = Math.hypot(dot(d, [B[0], B[1], B[2]]), dot(d, [B[3], B[4], B[5]])); out.height = len(rk.r) - len(T);
  return out;
}

export class ReturnPilot {
  /**
   * target: { lat, lon, alt } where the vehicle's turning point (rk.r) must come to rest: alt in meters above the sphere.
   * opts.belly: fall broadside (the Ship) rather than engines first.
   */
  constructor(target, opts = {}) {
    this.target = target; this.belly = !!opts.belly;
    this.phase = 'aim'; this.burning = false; this.miss = Infinity; this.ignite = 0; this.predT = 0; this.dist = 0; this.height = 0; this.done = false;
  }

  /** Where the fall ends, flown ahead: fills this.missE / missN (m, east and north of the target) and this.miss. */
  predict(rk, clock) {
    const S = rk.stageSpec, mass = S.thrust / rk.fullAccel(), cda = this.belly ? S.cdaSide : (S.cdaBack || S.cda), k = cda / mass;
    const tg = this.target, rT = RE + tg.alt;
    for (let i = 0; i < 3; i++) { pr[i] = rk.r[i]; pv[i] = rk.v[i]; }
    // Along the way: the height at which the landing burn has to begin, for the speed the air will have left it by then.
    const aNet = 0.8 * Math.max(rk.fullAccel(), 1) - G0, lag = this.belly ? 3.2 : 1.3;
    let t = rk.t, n = 0, ign = -1;
    while (n++ < 2500) {
      const r2 = pr[0] * pr[0] + pr[1] * pr[1] + pr[2] * pr[2], r = Math.sqrt(r2), h = r - RE;
      if (r <= rT && dot(pr, pv) < 0) break;
      // (the last height from which the engines can still stop it: high up it is going far too fast, but the air sees to that)
      if (dot(pr, pv) < 0) {
        const ux = pv[0] + OMEGA_E * pr[1], uy = pv[1] - OMEGA_E * pr[0], V = Math.hypot(ux, uy, pv[2]), drag = h < ATMO_TOP ? 0.5 * airDensity(h) * V * V * k : 0;
        if (r - rT >= (V * V) / (2 * (aNet + 0.5 * drag)) + V * lag + 70) ign = r - rT;                 // (the air goes on braking it through the burn: half of what it gives now is counted)
      }
      const dt = h > 60000 ? 2 : h > 20000 ? 1 : 0.5, g = -MU_E / (r2 * r);
      let ax = g * pr[0], ay = g * pr[1], az = g * pr[2];
      if (h < ATMO_TOP) {
        const ux = pv[0] + OMEGA_E * pr[1], uy = pv[1] - OMEGA_E * pr[0], uz = pv[2], V = Math.hypot(ux, uy, uz), c = -0.5 * airDensity(h) * V * k;
        ax += c * ux; ay += c * uy; az += c * uz;
      }
      pv[0] += ax * dt; pv[1] += ay * dt; pv[2] += az * dt; pr[0] += pv[0] * dt; pr[1] += pv[1] * dt; pr[2] += pv[2] * dt; t += dt;
    }
    geoToEci(clock, t, tg.lat, tg.lon, tg.alt, pt); enu(pt, B);
    for (let i = 0; i < 3; i++) d[i] = pr[i] - pt[i];
    this.missE = dot(d, [B[0], B[1], B[2]]); this.missN = dot(d, [B[3], B[4], B[5]]); this.miss = Math.hypot(this.missE, this.missN);
    this.fallT = t - rk.t; this.ignite = ign < 0 ? 1e9 : ign;                 // (never slow enough on the way: light them now)
  }

  /** Turn the nose toward a direction (ECI), no faster than rate degrees a second. */
  slew(rk, clock, to, rate, dt) {
    const l = len(to) || 1, c = clamp(dot(rk.nose, to) / l, -1, 1), ang = Math.acos(c), f = ang < 1e-4 ? 1 : Math.min(1, (rate * D2R * dt) / ang);
    for (let i = 0; i < 3; i++) tmp[i] = rk.nose[i] * (1 - f) + (to[i] / l) * f;
    if (len(tmp) < 1e-3) { cross(rk.nose, [B[6], B[7], B[8]], tmp); }                  // straight back the other way: go round by the side
    rk.frame(clock); rk.noseTo(tmp);
  }

  /** Steering the fall with the air: a sideways push of up to `ld` times the drag, toward a point `lead` meters short of the target along the nose. */
  glide(rk, dt, V, rl, ld, lead, pe, pn, ve, vn, E, N) {
    const S = rk.stageSpec, aMax = ld * 0.5 * airDensity(rl - RE) * V * V * (this.belly ? S.cdaSide : (S.cdaBack || S.cda)) * rk.fullAccel() / S.thrust;
    const ne = dot(rk.nose, E), nn = dot(rk.nose, N), nl = Math.hypot(ne, nn) || 1;
    let ae = -0.05 * (pe + lead * ne / nl) - 0.42 * ve, an = -0.05 * (pn + lead * nn / nl) - 0.42 * vn;
    const al = Math.hypot(ae, an);
    if (al > aMax) { ae *= aMax / al; an *= aMax / al; }
    for (let i = 0; i < 3; i++) rk.v[i] += (ae * E[i] + an * N[i]) * dt;
  }

  /** One physics step. Returns 'burn' | 'fall' | 'land' when a part begins, 'ready' when it hangs at the target, else null. */
  step(rk, clock, dt) {
    const tg = this.target;
    let said = null;
    rk.sas = 'hold';
    geoToEci(clock, rk.t, tg.lat, tg.lon, tg.alt, T); enu(T, B);
    const E = [B[0], B[1], B[2]], N = [B[3], B[4], B[5]], U = [B[6], B[7], B[8]];
    groundVel(rk.r, gv);
    for (let i = 0; i < 3; i++) { d[i] = rk.r[i] - T[i]; vr[i] = rk.v[i] - gv[i]; }
    const rl = len(rk.r), pe = dot(d, E), pn = dot(d, N), h = rl - len(T), ve = dot(vr, E), vn = dot(vr, N), vu = dot(vr, rk.r) / rl;      // (climb is against the vehicle's own vertical: far from the tower the two differ)
    const hd = Math.hypot(pe, pn), aFull = Math.max(rk.fullAccel(), 1), g = MU_E / dot(rk.r, rk.r);
    this.dist = hd; this.height = h;

    if (this.phase !== 'land' && ((this.predT -= dt) <= 0 || this.miss === Infinity)) { this.predT = 0.2; this.predict(rk, clock); }
    // The landing burn begins where the fall flown ahead says it must (the air does much of the braking first), or
    // higher if the vehicle is still well off to one side and needs the height to come across.
    if (this.phase !== 'land' && vu < 0 && h < Math.max(this.ignite, Math.min(1.4 * hd, 7000))) { this.phase = 'land'; said = 'land'; }

    if (this.phase === 'land') {
      // Sideways: a spring and a damper toward the target's axis, held to what the tilt allows.
      const w = 0.46, vMax = clamp(hd * 0.25, 15, 150);
      let ae = -w * w * pe - 1.5 * w * ve, an = -w * w * pn - 1.5 * w * vn;
      const sp = Math.hypot(ve, vn);
      if (hd * w > vMax && sp > vMax * 0.6) { ae = -1.5 * w * (ve + (pe / hd) * vMax); an = -1.5 * w * (vn + (pn / hd) * vMax); }       // far out: just hold a closing speed
      // Down: along the braking curve that ends at the target; held level near the bottom until it is over the spot.
      const aDec = 0.6 * (aFull - g), off = (hd > 1.3 || sp > 1.2) && h < 45 ? clamp(hd * 3 + sp * 2, 4, 25) : 0;
      const hLead = h + 0.7 * Math.min(vu, 0);                          // (where it will be by the time the engines have answered)
      const vDes = -clamp(Math.sqrt(2 * aDec * Math.max(hLead - off - 4, 0)) * 0.9 + (h > off + 0.3 ? 1.1 : 0.0), 0, 400);
      let au = g + clamp(2.0 * (vDes - vu), -g * 0.92, aFull);
      // (leaning up to 28 degrees to come across while there is height for it; nearly upright for the last of the way down between the arms)
      const ah = Math.hypot(ae, an), lim = Math.max(au, 2) * TILT * (0.5 + 0.5 * clamp((h - 12) / 50, 0, 1));
      if (ah > lim) { ae *= lim / ah; an *= lim / ah; }
      for (let i = 0; i < 3; i++) want[i] = ae * E[i] + an * N[i] + au * U[i];
      const a = len(want);
      this.slew(rk, clock, want, this.belly ? 34 : 24, dt);
      // (thrust only along where the nose already points: while it is still swinging round, less of it)
      rk.throttle = clamp((a / aFull) * clamp(dot(rk.nose, want) / a, 0, 1), 0.03, 1);
      if (Math.abs(h) < 0.6 && hd < 1.2 && Math.hypot(ve, vn, vu) < 1.6) said = 'ready';
      return said;
    }

    // ---- aim, then fall
    const high = h > 4500 || vu > 0;                                // (corrections go on until the landing burn is near: the fall drifts with the wind)
    if (!this.burning && this.miss > (high ? 300 : 1e9)) { this.burning = true; if (this.phase !== 'burnback') { this.phase = 'burnback'; said = 'burn'; } }
    else if (this.burning && (this.miss < 80 || !high)) { this.burning = false; rk.throttle = 0; rk.thrustLevel = 0; this.phase = 'fall'; said = 'fall'; }
    if (this.burning) {
      // Push the place it will fall toward the tower: straight against the miss, level with the ground; and, when the
      // fall is too short for the burn that takes, upward as well, to buy the time.
      const need = (Math.hypot(ve, vn) + hd / Math.max(this.fallT, 20)) / aFull, loft = clamp(1.1 * need / Math.max(this.fallT, 20) - 0.35, 0, 0.7) * this.miss;
      for (let i = 0; i < 3; i++) want[i] = -(this.missE * E[i] + this.missN * N[i]) + loft * U[i];
      this.slew(rk, clock, want, 30, dt);
      const lined = clamp((dot(rk.nose, want) / (len(want) || 1) - 0.9) * 10, 0, 1);
      rk.throttle = lined * clamp(this.miss / (aFull * Math.max(this.fallT, 20) * 0.5), 0.05, 1);
    } else {
      rk.throttle = 0;
      if (this.phase === 'aim') this.phase = 'fall';
      const V = len(vr);
      if (V > 20) {
        if (this.belly) {
          // Flat to the air: the nose square to the way it is going, in the plane that holds that and the vertical; and when it
          // is falling straight down, which leaves that plane open, the way the nose already points.
          cross(U, vr, side);
          if (len(side) < 0.12 * V) { const k = dot(rk.nose, vr) / (V * V); for (let i = 0; i < 3; i++) want[i] = rk.nose[i] - k * vr[i]; }
          else cross(vr, side, want);
          this.slew(rk, clock, want, 12, dt);
          // The flaps steer the fall: the Ship glides a little on its belly (a lift of about a third of its drag), and with
          // that it comes down over the tower and not merely near it, whatever the wind has been doing. It aims a little
          // short of the tower along its own length: the flip throws it forward by about that much.
          if (h < 14000) this.glide(rk, dt, V, rl, 0.33, 40, pe, pn, ve, vn, E, N);
        } else {
          // (a booster steers its fall the same way with its grid fins, less strongly)
          for (let i = 0; i < 3; i++) want[i] = -vr[i]; this.slew(rk, clock, want, 12, dt);
          if (h < 14000 && vu < 0) this.glide(rk, dt, V, rl, 0.2, 0, pe, pn, ve, vn, E, N);
        }
      }
    }
    return said;
  }
}
