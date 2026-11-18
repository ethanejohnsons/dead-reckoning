// What a launch puts into the air: this module turns the state of the vehicle, frame by frame, into
// puffs in a SmokeField (fx-smoke.js). plume.js's ExhaustTrail hands it everything mission.js knows.
//
// The sources, each a rate of puffs with its own look and motion:
//   - On a Launch Complex 39 pad (pad.js: the flame trench runs north-south under the Mobile Launcher,
//     with a wedge that splits the flame both ways): two jets of exhaust and deluge steam down the
//     trench and out of its ends at a few hundred km/h, kept between the trench walls until they are
//     clear of them; steam driven sideways out of the gap under the launcher; and, as the vehicle rises
//     and its flame opens over the deck, a splash going every way from the launcher.
//   - On Starship's mount: a ring of steam from the deluge plate going every way along the ground,
//     strongest between the mount's six legs, the fastest of it picking up dust as it runs out past the
//     concrete, and slower steam boiling up around the mount and the foot of the tower.
//   - With no pad under it, a flame near the ground throws a ring of dust.
//   - A vehicle coming back down to its tower: a thin, low skirt of dust under the end of its flame (s.settle).
//   - The column: puffs strung along the path of the flame's end, a vehicle radius or so apart, in the
//     color and amount of the propellant (dense white-gray for kerosene, a thin white streak for methane),
//     carried off by the wind of the height they were left at, plus a made-up shear by height so the
//     column kinks as real ones do. It thins with the air and ends near TRAIL_TUNING.minPressure.
//   - Ice: flakes of frost shaken off the tanks from ignition until a few seconds into the climb.
//   - Vents: before launch, wisps of cold oxygen vapor from partway up the stack and round its foot,
//     sinking as they drift downwind.
//   - The vapor collar: around Mach 1 a short-lived cloud rides with the vehicle behind its shoulders.
//   - The flame as a light on all of it (the field's point light), and each fresh puff's own glow.
//
// The pad's shape is known here only as far as the smoke cares: the height of the ground at a point
// (hardstand, trench, the launcher's deck) and the trench walls. Lengths are meters, world axes
// (+X east, +Y up, +Z south), and the pad model's origin is where the vehicle stood when first seen.

import * as THREE from 'three';
import { PUFF, F_GROUND, F_CONFINE, F_ICE, F_NOSHADE, F_DIE_ON_GROUND, F_AXIAL } from './fx-smoke.js';

/**
 * Knobs. life: seconds a column puff lives at sea level; opacity: of fresh kerosene smoke; minPressure: the
 * ambient pressure (against sea level) below which no trail forms; the rest multiply a source's rate or strength.
 */
export const TRAIL_TUNING = {
  life: 210, opacity: 0.92, minPressure: 0.04,
  padCloud: 1,        // amount of steam and exhaust from the pad
  padLife: 1,         // how long the pad cloud lasts
  jetSpeed: 1,        // speed the jets leave the trench or the mount with
  column: 1,          // puffs per meter of column
  ice: 1, vents: 1, collar: 1,
  flameLight: 1,      // the flame's light on the smoke
  shear: 1,           // the made-up wind shear that kinks the column
};

const LOOK = {
  //            amount of smoke, its color, flame length in vehicle radii, light: color and strength
  kerolox: { amount: 1, tint: [0.9, 0.88, 0.85], len: 27, light: [1.0, 0.5, 0.17], power: 3.4 },
  // (methane burns clean: nothing is left behind it low down; the white streak is its water, freezing out in the cold air from a few miles up)
  methalox: { amount: 0.2, tint: [0.97, 0.97, 0.98], len: 44, light: [1.0, 0.62, 0.42], power: 2.2, from: [2500, 8000] },
  hydrolox: { amount: 0.14, tint: [0.98, 0.98, 0.98], len: 30, light: [0.75, 0.8, 1.0], power: 0.8 },
  hypergolic: { amount: 0, tint: [1, 0.95, 0.9], len: 16, light: [1.0, 0.6, 0.4], power: 0.5 },
};
const VEHICLE = {
  // frost: bands of the stack (fractions of its height) that shed ice; narrow: above this fraction the stack is slimmer (by `slim`);
  // vents: [fraction of height, compass bearing in degrees]; collar: fractions of height where the vapor collar forms
  saturnv: { frost: [[0.12, 0.33], [0.4, 0.6], [0.63, 0.74]], narrow: 0.62, slim: 0.66, vents: [[0.25, 80], [0.53, 290], [0.71, 110]], collar: [0.64, 0.8] },
  starship: { frost: [[0.04, 0.55], [0.62, 0.9]], narrow: 2, slim: 1, vents: [[0.3, 250], [0.57, 100], [0.82, 280]], collar: [0.6, 0.9] },
};

const mk = (o) => ({ ...PUFF, ...o });
const P_JET = mk({ flags: F_GROUND | F_CONFINE, softRate: 0.012, fadeIn: 0.22, spin: 0.9, lift: 0.4, heatTau: 0.9, fadeOut: 0.62 });
const P_COLUMN = mk({ kq: 0.012, kl: 0.22, ent: 0.2, dif: 3.2, buoy: 0.5, buoyTau: 25, softRate: 0.02, fadeIn: 0.35, fadeOut: 0.5, thin: 0.3, heatTau: 0.8, turb: 1.4, cap: 125, flags: F_NOSHADE | F_AXIAL });
const P_ICE = mk({ kq: 0, kl: 0.8, ent: 0, dif: 0, buoy: 0, grav: 9.8, fadeIn: 0.05, fadeOut: 0.92, flags: F_ICE | F_NOSHADE | F_GROUND | F_DIE_ON_GROUND, turb: 2.5, lift: 0.5, r: 1, g: 1, b: 1, spin: 3 });
const P_VENT = mk({ kq: 0.02, kl: 0.6, ent: 0.22, dif: 1.1, buoy: -0.7, buoyTau: 5, alpha: 0.38, soft0: 0.6, softRate: 0.05, fadeIn: 0.4, fadeOut: 0.3, thin: 0.9, turb: 0.5, r: 0.98, g: 0.98, b: 1, cap: 12 });
const P_COLLAR = mk({ kq: 0, kl: 0, ent: 0, dif: 5, buoy: 0, alpha: 0.2, soft0: 0.9, softRate: 0, fadeIn: 0.08, fadeOut: 0.3, flags: F_NOSHADE, turb: 0, boil: 5, r: 1, g: 1, b: 1 });

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ZERO = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const a1 = new THREE.Vector3(), a2 = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), nz = new THREE.Vector3();

export class LaunchSmoke {
  constructor(field) {
    this.field = field;
    this.pad = null;                                   // { kind: 'lc39' | 'mount' | 'bare', x, y, z }
    this.acc = {}; this.last = new THREE.Vector3(); this.hasLast = false; this.lastStage = -1;
    this.light = 0; this.clock = 0; this.burn = 0;
    this.shade = new Float32Array(90).fill(0);         // direct sun lost to the weather, per 500 m of height
    this.seed = Math.random() * 1000;
    field.confine = (f, i) => this._walls(f, i);
    field.groundAt = (x, z) => this._ground(x, z);
    field.shadeAt = (y) => { const k = clamp((y - this.shadeY0) / 500, 0, 88.99), i = Math.floor(k); return this.shade[i] + (this.shade[i + 1] - this.shade[i]) * (k - i); };
    this.shadeY0 = 0;
    /** Optional: the real height of the land at (x, z), used outside the pad's concrete. */
    this.terrainAt = null;
  }

  reset() { this.pad = null; this.acc = {}; this.hasLast = false; this.light = 0; this.burn = 0; this.shade.fill(0); this.shadeSeen = false; this.field.flame.power = 0; }
  shift(dx, dy, dz) { if (this.pad) { this.pad.x += dx; this.pad.y += dy; this.pad.z += dz; } this.last.x += dx; this.last.y += dy; this.last.z += dz; this.shadeY0 += dy; }

  /** Height of whatever a puff at (x, z) would rest on. */
  _ground(x, z) {
    const p = this.pad;
    if (!p) return -1e5;
    const lx = Math.abs(x - p.x), lz = Math.abs(z - p.z);
    if (p.kind === 'lc39') {
      if (lx < 20.5 && z - p.z > -33 && z - p.z < 16 && (lx > 6.85 || lz > 6.85)) return p.y + 26.5;      // the launcher's deck
      if (lx < 9 && lz < 150) return p.y + 0.6;                                                            // the trench
      const m = Math.max(lx, lz, (lx + lz) * 0.585);
      if (m < 86) return p.y + 0.6 + 11.6 * clamp((86 - m) / 24, 0, 1);                                    // the hardstand and its slopes
      if (m < 175) return p.y + 0.6;
    } else if (p.kind === 'mount') { if (Math.max(lx, lz, (lx + lz) * 0.585) < 165) return p.y + 0.5; }
    else return p.y;
    return this.terrainAt ? Math.min(this.terrainAt(x, z), p.y + 0.6) : p.y + 0.2;
  }

  /** Per-step care of the pad's puffs: the trench walls, and dust picked up on the way out. */
  _walls(f, i) {
    const p = this.pad;
    if (!p) return;
    const lx = f.px[i] - p.x, lz = f.pz[i] - p.z;
    if (p.kind === 'lc39') {
      if (Math.abs(lz) < 64 && f.py[i] < p.y + 12.2 + 0.25 * f.size[i]) { const lim = Math.max(0, 8.5 - 0.6 * f.size[i]); if (lx > lim) f.px[i] = p.x + lim; else if (lx < -lim) f.px[i] = p.x - lim; }
    }
    if (f.dustMax[i] > 0) { const d = Math.hypot(lx, lz); f.dust[i] = Math.max(f.dust[i], f.dustMax[i] * smooth(p.dust0, p.dust1, d)); }
  }

  /** n puffs for a source running at `rate` a second. */
  _count(name, rate, dt, cap = 40) {
    const a = (this.acc[name] || 0) + rate * dt, n = Math.min(cap, Math.floor(a));
    this.acc[name] = a - Math.floor(a);
    return n;
  }

  /** The wind of a layer: what the weather gave at the vehicle, turned and stretched a little by height. */
  _wind(wind, alt, out) {
    const k = TRAIL_TUNING.shear, s = this.seed, n = (x) => Math.sin(x) * 0.6 + Math.sin(x * 2.3 + 1.7) * 0.4;
    const turn = 0.45 * k * n(alt / 1700 + s), gain = 1 + 0.35 * k * n(alt / 2300 + s * 1.7), c = Math.cos(turn), sn = Math.sin(turn);
    const lift = smooth(300, 3000, alt) * 6.5 * k;
    out.x = (wind.x * c - wind.z * sn) * gain + lift * n(alt / 900 + s * 2.1); out.z = (wind.x * sn + wind.z * c) * gain + lift * n(alt / 1100 + s * 3.3);
    return out;
  }

  emit(dt, s) {
    const f = this.field, T = TRAIL_TUNING, r = () => f.rnd();
    const look = LOOK[s.propellant] || LOOK.kerolox, p = clamp(s.pressure ?? 1, 0, 1), th = clamp(s.throttle || 0, 0, 1);
    const R = s.radius || 5, H = s.height || R * 22, pos = s.pos, dir = s.dir, vel = s.vel || ZERO, wind = s.wind || ZERO;
    const nose = s.nose || nz.copy(dir).negate(), base = s.base || pos;
    const veh = VEHICLE[s.vehicle] || (s.propellant === 'methalox' ? VEHICLE.starship : VEHICLE.saturnv), kind = s.vehicle || (s.propellant === 'methalox' ? 'starship' : 'saturnv');
    const met = s.met ?? (th > 0 ? 1 : -1), stage = s.stage || 0;
    const Q = f.rate, K = f.sizeK;
    this.clock += dt; f.preroll = dt;

    // ---- the pad under it (kept once seen: its cloud outlives the launch)
    const hasPad = s.hasPad ?? !!s.onPad, padY = s.padY ?? s.groundY ?? pos.y, standY = s.standY || 0;
    const agl = s.agl ?? Math.max(0, pos.y - padY - standY);
    if (hasPad && (s.held || s.landed || agl < 3) && (!this.pad || this.pad.kind === 'bare' || Math.hypot(this.pad.x - base.x, this.pad.z - base.z) > 30)) {
      const lc39 = kind === 'saturnv';
      this.pad = { kind: lc39 ? 'lc39' : 'mount', x: base.x, y: padY, z: base.z, dust0: lc39 ? 150 : 70, dust1: lc39 ? 520 : 330 };
      this.shadeY0 = padY;
    } else if (hasPad && s.padPos && (!this.pad || this.pad.kind === 'bare')) {
      // (a vehicle coming back to a pad the smoke has forgotten, or never saw it leave: the game says where it stands)
      const lc39 = kind === 'saturnv';
      this.pad = { kind: lc39 ? 'lc39' : 'mount', x: s.padPos.x, y: padY, z: s.padPos.z, dust0: lc39 ? 150 : 70, dust1: lc39 ? 520 : 330 };
      this.shadeY0 = padY;
    } else if (!hasPad && th > 0.05 && agl < 120 && (!this.pad || Math.hypot(this.pad.x - base.x, this.pad.z - base.z) > 400)) {
      this.pad = { kind: 'bare', x: base.x, y: base.y - agl, z: base.z, dust0: 15, dust1: 90 };
    }
    const pad = this.pad;

    // ---- the weather's shade on the sun, by height, as far as the vehicle has found out
    if (s.shade != null) {
      const k = clamp(Math.floor((pos.y - this.shadeY0) / 500), 0, 89), v = clamp(s.shade, 0, 1) * 0.94;
      if (met < 0 || !this.shadeSeen) { this.shade.fill(v); this.shadeSeen = true; }
      for (let i = k; i < 90; i++) this.shade[i] = v;
    }

    // ---- the flame as a light
    const w = clamp(Math.log10(1 / Math.max(p, 1e-5)) / 3, 0, 1), Lf = s.flameLen ?? look.len * R * 1.05 * (0.4 + 0.6 * th) * (1 + 1.5 * w) * 0.9;
    const surf = pad ? (pad.kind === 'lc39' ? pad.y + 0.6 : pad.y + 0.5) : -1e9;
    const toGround = dir.y < -0.15 ? (pos.y - surf) / -dir.y : 1e9;      // along the flame to the ground under it
    this.light += ((th > 0.02 ? Math.pow(th, 1.2) : 0) - this.light) * Math.min(1, dt * 6);
    const F = f.flame, reachL = Math.min(Lf * 0.35, Math.max(toGround - 4, 0));
    F.pos.copy(pos).addScaledVector(dir, reachL);
    F.color.setRGB(look.light[0], look.light[1], look.light[2]); F.power = look.power * this.light * T.flameLight * (1 - 0.7 * w); F.reach = Math.max(25, Lf * 0.4);

    // ---- before launch: the stack breathes
    if (th < 0.02) {
      this.hasLast = false; this.burn = 0;
      if (pad && pad.kind !== 'bare' && (s.held || (s.landed && met < 0)) && T.vents > 0) this._vents(dt, s, veh, R, H, base, nose, wind, pad);
      return;
    }
    this.burn += dt;
    const thr = smooth(0.03, 0.45, th);

    // ---- ice off the tanks
    if (stage === 0 && met < 16 && agl < 900 && T.ice > 0) {
      const n = this._count('ice', 240 * T.ice * Math.sqrt(Q) * thr * (met < 1.5 ? 1 : Math.exp(-(met - 1.5) / 4)), dt, 30);
      for (let k = 0; k < n; k++) {
        const band = veh.frost[Math.floor(r() * veh.frost.length)], t = band[0] + (band[1] - band[0]) * r(), a = r() * 6.2832, rad = R * (t > veh.narrow ? veh.slim : 1) * 1.03;
        t1.set(Math.cos(a), 0, Math.sin(a));
        if (Math.abs(nose.y) < 0.999) { t2.crossVectors(nose, UP).normalize(); a2.crossVectors(t2, nose); t1.copy(t2).multiplyScalar(Math.cos(a)).addScaledVector(a2, Math.sin(a)); }
        const out = 1 + 5 * r() * r(), i = f.spawn(P_ICE, base.x + nose.x * t * H + t1.x * rad, base.y + nose.y * t * H + t1.y * rad, base.z + nose.z * t * H + t1.z * rad,
          vel.x + t1.x * out + (r() - 0.5) * 3, vel.y * 0.9 + (r() - 0.5) * 3, vel.z + t1.z * out + (r() - 0.5) * 3, 0.22 + 0.7 * r() * r(), 5 + 6 * r(), wind.x, wind.z, r() * dt);
        if (i >= 0) { f.kl[i] = 0.5 + 0.9 * r(); f.boil[i] = 8 + 16 * r(); }
      }
    }

    // ---- the flame on the pad
    const h0 = Math.max(0, base.y - (pad ? pad.y : padY) - standY);      // how far the vehicle has risen off its stand
    if (pad && dir.y < -0.3 && T.padCloud > 0) {
      // (s.padCloud, s.padLife: less of it, and sooner gone, for a vehicle coming down to be caught: a few engines far above a dry plate.
      //  And none from a flame that ends well short of the ground.)
      const wx = wind.x * 1.5, wz = wind.z * 1.5, js = T.jetSpeed, lifeK = T.padLife * (s.padLife ?? 1), rate = Q * T.padCloud * (s.padCloud ?? 1) * thr * (1 - smooth(0.9 * Lf, 1.8 * Lf, toGround));
      // White steam with streaks of creamier exhaust through it: which, changes slowly with the moment and the place it left from, so neighbors match.
      const steam = (i, warm) => {
        if (i < 0) return;
        const a = Math.atan2(f.vz[i], f.vx[i]);
        // some of it goes up in towers: whole bursts rise together
        f.buoy[i] *= 0.35 + 1.9 * Math.pow(0.5 + 0.5 * Math.sin(this.burn * 2.9 + a * 3.1 + 1) * Math.sin(this.burn * 1.3 - a * 1.7), 2);
        const m = clamp(0.5 + 0.5 * Math.sin(this.burn * 1.7 + a * 2.3) * Math.sin(this.burn * 0.73 + a * 1.1 + 2) + (warm - 0.5), 0, 1) * (0.7 + 0.3 * r());
        const g = 0.955 - 0.1 * m + 0.02 * r();
        f.cr[i] = g + 0.012 * m; f.cg[i] = g - 0.008 * m; f.cb[i] = g - 0.012 - 0.06 * m;
      };
      if (pad.kind === 'lc39') {
        const inTrench = 1 - smooth(25, 120, h0), onDeck = smooth(6, 45, h0) * (1 - smooth(150, 340, h0));
        // down the trench and out of both ends
        for (const sz of [-1, 1]) {
          const n = this._count(sz < 0 ? 'jetN' : 'jetS', 72 * rate * inTrench * (this.burn < 1.2 ? 1.6 : 1), dt);
          for (let k = 0; k < n; k++) {
            const v0 = (95 + 80 * r() * r()) * js * (0.55 + 0.45 * thr), size = (4.5 + 3 * r()) * K;
            const i = f.spawn(P_JET, pad.x + (r() - 0.5) * 12, pad.y + 2 + 8 * r(), pad.z + sz * (20 + 14 * r()), v0 * (r() - 0.5) * 0.6, v0 * (0.02 + 0.12 * r()), sz * v0, size, (120 + 95 * r()) * lifeK, wx, wz, r() * dt);
            if (i < 0) break;
            f.kq[i] = 1 / (v0 * (0.7 + 1.7 * r())); f.kl[i] = 0.05 + 0.05 * r(); f.ent[i] = 0.13 + 0.06 * r(); f.dif[i] = 0.8 + 0.8 * r(); f.buoy[i] = 0.05 + 0.45 * r() * r(); f.buoyTau[i] = 20 + 25 * r();
            f.cap[i] = 60 + 60 * r(); f.heat[i] = r() < 0.6 ? 0.6 + 1.3 * r() : 0.2; f.heatTau[i] = 0.45 + 0.7 * r(); f.dustMax[i] = 0.25 * r();
            steam(i, 0.3);
          }
        }
        // sideways out of the gap under the launcher, and up round it
        const n = this._count('gap', 42 * rate * inTrench, dt);
        for (let k = 0; k < n; k++) {
          const sx = r() < 0.5 ? -1 : 1, v0 = (28 + 50 * r()) * js;
          const i = f.spawn(P_JET, pad.x + sx * (19 + 4 * r()), pad.y + 13 + 5 * r(), pad.z - 8 + (r() - 0.5) * 44, sx * v0, 3 + 12 * r(), (r() - 0.5) * 0.7 * v0, (3.5 + 2.5 * r()) * K, (90 + 80 * r()) * lifeK, wx, wz, r() * dt);
          if (i < 0) break;
          f.kq[i] = 1 / (v0 * (1.2 + 1.8 * r())); f.kl[i] = 0.06 + 0.05 * r(); f.ent[i] = 0.14 + 0.05 * r(); f.buoy[i] = 0.2 + 0.6 * r(); f.buoyTau[i] = 20 + 20 * r(); f.cap[i] = 50 + 45 * r();
          f.heat[i] = 0.5 + 1.2 * r(); f.heatTau[i] = 0.5; f.flags[i] = F_GROUND;
          steam(i, 0.35);
        }
        // what the deluge leaves boiling off the hot launcher and trench for half a minute after
        const after = met > 0 ? 1 - smooth(18, 42, met) : 0, b = this._count('boil', 13 * Q * T.padCloud * after * smooth(40, 140, h0), dt);
        for (let k = 0; k < b; k++) {
          const a = r() * 6.2832, v0 = 4 + 10 * r(), d0 = 30 * Math.sqrt(r()), ca = Math.cos(a), sa = Math.sin(a);
          const i = f.spawn(P_JET, pad.x + ca * d0, pad.y + 14 + 14 * r(), pad.z - 6 + sa * d0 * 1.4, ca * v0, 3 + 7 * r(), sa * v0, (6 + 4 * r()) * K, (70 + 60 * r()) * lifeK, wx, wz, r() * dt);
          if (i < 0) break;
          f.kq[i] = 0.01; f.kl[i] = 0.1; f.ent[i] = 0.15; f.dif[i] = 1.6 + r(); f.buoy[i] = 0.3 + 0.5 * r(); f.buoyTau[i] = 25; f.cap[i] = 40 + 30 * r(); f.flags[i] = F_GROUND; f.soft0[i] = 0.15;
          steam(i, 0.1);
        }
        // the flame opening over the deck as the vehicle climbs away
        const m = this._count('deck', 80 * rate * onDeck, dt);
        for (let k = 0; k < m; k++) {
          const a = r() * 6.2832, v0 = (40 + 50 * r()) * js * (1 - 0.5 * smooth(120, 330, h0)), d0 = 8 + 9 * r(), ca = Math.cos(a), sa = Math.sin(a);
          const i = f.spawn(P_JET, pad.x + ca * d0, pad.y + 28 + 5 * r(), pad.z + sa * d0, ca * v0, 2 + 9 * r(), sa * v0, (4.5 + 3 * r()) * K, (95 + 85 * r()) * lifeK, wx, wz, r() * dt);
          if (i < 0) break;
          f.kq[i] = 1 / (v0 * (1.1 + 1.8 * r())); f.kl[i] = 0.06 + 0.05 * r(); f.ent[i] = 0.14 + 0.05 * r(); f.buoy[i] = 0.15 + 0.6 * r(); f.buoyTau[i] = 20 + 20 * r(); f.cap[i] = 50 + 50 * r();
          f.heat[i] = 1 + 1.5 * r(); f.heatTau[i] = 0.5 + 0.4 * r(); f.flags[i] = F_GROUND;
          steam(i, 0.45);
        }
      } else {
        // a ring along the ground: steam off the deluge plate (a mount), or dust (bare ground)
        const mount = pad.kind === 'mount', reach = 1 - smooth(mount ? 60 : 20, mount ? 280 : Math.max(60, Lf * 1.2), mount ? h0 : agl);
        const n = this._count('ring', (mount ? 170 : 80) * rate * reach * (this.burn < 1 ? 1.5 : 1), dt, 60);
        for (let k = 0; k < n; k++) {
          const a = r() * 6.2832, ca = Math.cos(a), sa = Math.sin(a), spoke = mount ? 0.74 + 0.26 * Math.cos(6 * a) : 1, boil = r() < 0.3;
          const v0 = (boil ? 16 + 34 * r() : (80 + 85 * r() * r()) * spoke) * js * (0.55 + 0.45 * thr) * (mount ? 1 : 0.5), d0 = (mount ? 5 : 2) + 6 * r();
          const i = f.spawn(P_JET, pad.x + ca * d0, pad.y + 1 + 5 * r(), pad.z + sa * d0, ca * v0, boil ? 6 + 16 * r() : v0 * 0.07 * r(), sa * v0, (boil ? 4 + 3 * r() : 3.5 + 2.5 * r()) * K, (boil ? 80 + 70 * r() : 95 + 95 * r()) * lifeK, wx, wz, r() * dt);
          if (i < 0) break;
          f.kq[i] = 1 / (v0 * (boil ? 1.5 + 2 * r() : 1.2 + 2.4 * r())); f.kl[i] = 0.045 + 0.05 * r(); f.ent[i] = boil ? 0.15 : 0.1 + 0.04 * r(); f.dif[i] = 0.7 + 0.6 * r();
          f.buoy[i] = boil ? 0.3 + 0.6 * r() : 0.04 + 0.3 * r() * r(); f.buoyTau[i] = 20 + 25 * r(); f.cap[i] = boil ? 60 + 40 * r() : 60 + 60 * r();
          f.heat[i] = mount ? 0.4 + 0.8 * r() : 0.2; f.heatTau[i] = 0.5;
          f.dustMax[i] = mount ? (boil ? 0.1 : clamp((v0 - 70) / 90 + 0.3 * r(), 0, 0.92)) : 0.75 + 0.2 * r();
          steam(i, mount ? 0.08 : 0.5);
        }
      }
    }

    // ---- coming down to be caught: no deluge is running and the few engines burning are far above the plate. What the end of
    // the flame raises, once it reaches the ground, is a low skirt of dust and scorched air that runs out over the concrete and is soon gone.
    if (pad && s.settle > 0 && dir.y < -0.5) {
      const lick = 1 - smooth(0.75 * Lf, 1.35 * Lf, toGround), n = this._count('settle', 30 * Q * s.settle * thr * lick, dt, 20);
      const gx = pos.x + dir.x * toGround, gz = pos.z + dir.z * toGround;
      for (let k = 0; k < n; k++) {
        const a = r() * 6.2832, ca = Math.cos(a), sa = Math.sin(a), v0 = 10 + 28 * r(), d0 = 2 + 5 * r();
        const i = f.spawn(P_JET, gx + ca * d0, surf + 0.6 + 2 * r(), gz + sa * d0, ca * v0, 1 + 3 * r(), sa * v0, (2.4 + 2 * r()) * K, 11 + 15 * r(), wind.x * 1.5, wind.z * 1.5, r() * dt);
        if (i < 0) break;
        f.kq[i] = 1 / (v0 * (1.5 + 2 * r())); f.kl[i] = 0.06; f.ent[i] = 0.12; f.dif[i] = 0.9; f.buoy[i] = 0.05 + 0.22 * r(); f.buoyTau[i] = 15; f.cap[i] = 16 + 16 * r();
        f.alpha[i] = 0.26 + 0.2 * r(); f.heat[i] = 0.5; f.heatTau[i] = 0.4; f.dustMax[i] = 0.55 + 0.35 * r(); f.dust[i] = 0.8 * f.dustMax[i];
        const g = 0.8 + 0.08 * r(); f.cr[i] = g; f.cg[i] = g - 0.03; f.cb[i] = g - 0.08;
      }
    }

    // ---- the column
    const dens = look.amount * Math.pow(clamp((p - T.minPressure) / 0.25, 0, 1), 0.6) * (0.4 + 0.6 * th) * (look.from ? smooth(look.from[0], look.from[1], pos.y - (pad ? pad.y : padY)) : 1);
    if (stage !== this.lastStage) { this.hasLast = false; this.lastStage = stage; }
    const back = Lf * (look.amount > 0.5 ? 0.62 : 0.85);
    a1.copy(pos).addScaledVector(dir, back);                              // where the flame gives way to smoke
    if (dens > 0.004 && T.column > 0) {
      const r0 = R * 2.0 * K * Math.min(3.0, Math.pow(Math.max(p, 0.005), -0.28)), first = this.hasLast ? this.last : a1;
      const gone = Math.max(first.distanceTo(a1), 13 * dt), alt = pos.y - (pad ? pad.y : padY);
      const thin = look.amount < 0.5, fresh = look.tint;
      const n = this._count('column', (gone / (r0 * (thin ? 1.1 : 0.5))) * T.column * Q / Math.max(dt, 1e-4), dt, 60);
      this._wind(wind, alt, t2);
      for (let k = 0; k < n; k++) {
        const u = (k + r()) / n, x = first.x + (a1.x - first.x) * u, y = first.y + (a1.y - first.y) * u, z = first.z + (a1.z - first.z) * u, size = r0 * (0.8 + 0.5 * r());
        if (pad && y < this._ground(x, z) + size * 0.8) continue;                              // down there the flame is on the ground: the pad cloud's business
        const push = (22 + 40 * r()) * (0.3 + 0.7 * p);
        const i = f.spawn(P_COLUMN, x + (r() - 0.5) * r0, y + (r() - 0.5) * r0, z + (r() - 0.5) * r0, dir.x * push + vel.x * 0.03 + (r() - 0.5) * 12, dir.y * push + vel.y * 0.03 + (r() - 0.5) * 12, dir.z * push + vel.z * 0.03 + (r() - 0.5) * 12,
          size, T.life * (0.7 + 0.5 * r()) * (thin ? 0.3 : 0.45 + 0.55 * Math.min(1, dens * 1.3)), t2.x, t2.z, (1 - u) * dt);
        if (i < 0) break;
        const g = thin ? 1 : 0.86 + 0.18 * r();
        f.cr[i] = Math.min(1, fresh[0] * g); f.cg[i] = Math.min(1, fresh[1] * g); f.cb[i] = Math.min(1, fresh[2] * g);
        f.alpha[i] = Math.min(1, T.opacity * (thin ? 0.26 : 1) * Math.pow(dens / look.amount, 0.55) * (0.8 + 0.2 * r()));
        f.heat[i] = thin ? 0.15 : 0.9 + 0.8 * r(); f.dif[i] = (2.6 + 1.6 * r()) * (thin ? 0.6 : 1); f.buoy[i] = (0.2 + 0.7 * r()) * p;
        if (thin) { f.soft0[i] = 0.6; f.thin[i] = 0.9; }
        f.ax[i] = -dir.x; f.ay[i] = -dir.y; f.az[i] = -dir.z;
        if (alt < 400) { f.flags[i] |= F_GROUND; f.lift[i] = 0.5; }
      }
    }
    this.last.copy(a1); this.hasLast = true;

    // ---- the vapor collar around Mach 1
    const mach = s.mach || 0;
    if (mach > 0.84 && mach < 1.4 && p > 0.1 && T.collar > 0) {
      const flick = 0.6 + 0.4 * Math.sin(this.clock * 5.3) * Math.sin(this.clock * 1.9 + 1);
      const str = T.collar * smooth(0.86, 1.0, mach) * (1 - smooth(1.12, 1.38, mach)) * smooth(0.1, 0.3, p) * flick;
      t2.crossVectors(nose, Math.abs(nose.y) < 0.99 ? UP : t1.set(1, 0, 0)).normalize(); a2.crossVectors(t2, nose);
      for (const st of veh.collar) {
        // a thin cone of mist standing off the body behind each shoulder, riding along with the vehicle
        const n = this._count('collar' + st, 260 * str * Math.sqrt(Q), dt, 30), rad = R * (st > veh.narrow ? veh.slim : 1);
        for (let k = 0; k < n; k++) {
          const a = r() * 6.2832, ca = Math.cos(a), sa = Math.sin(a), ox = t2.x * ca + a2.x * sa, oy = t2.y * ca + a2.y * sa, oz = t2.z * ca + a2.z * sa;
          const x = r() * r() * 3.2, d = rad * (1.15 + 0.5 * x + 0.12 * r()), t = st * H - x * rad, lag = 0.965 + 0.02 * r(), out = 4 + 8 * r();
          const i = f.spawn(P_COLLAR, base.x + nose.x * t + ox * d, base.y + nose.y * t + oy * d, base.z + nose.z * t + oz * d, vel.x * lag + ox * out, vel.y * lag + oy * out, vel.z * lag + oz * out, rad * (0.75 + 0.3 * x), 0.2 + 0.2 * r(), 0, 0, 0);
          if (i < 0) break;
          f.alpha[i] = 0.24 * Math.min(1, str * 1.4);
        }
      }
    }
  }

  /** Cold vapor from the vents up the stack and from round its foot. */
  _vents(dt, s, veh, R, H, base, nose, wind, pad) {
    const f = this.field, r = () => f.rnd(), T = TRAIL_TUNING, wx = wind.x * 1.3, wz = wind.z * 1.3;
    for (const [t, deg] of veh.vents) {
      // each vent breathes in its own rhythm
      const puff = 0.55 + 0.45 * Math.sin(this.clock * (0.5 + t) + deg);
      const n = this._count('vent' + deg, 9 * T.vents * puff * Math.sqrt(f.rate), dt, 6), a = (deg * Math.PI) / 180, ox = Math.sin(a), oz = -Math.cos(a), rad = R * (t > veh.narrow ? veh.slim : 1) * 1.04;
      for (let k = 0; k < n; k++) {
        const v = 2.5 + 3.5 * r();
        f.spawn(P_VENT, base.x + nose.x * t * H + ox * rad, base.y + nose.y * t * H, base.z + nose.z * t * H + oz * rad, ox * v + (r() - 0.5), -0.4 + (r() - 0.5), oz * v + (r() - 0.5), 0.8 + 0.8 * r(), 6 + 6 * r(), wx, wz, r() * dt);
      }
    }
    const n = this._count('foot', 4 * T.vents * Math.sqrt(f.rate), dt, 4);
    for (let k = 0; k < n; k++) {
      const a = r() * 6.2832, d = R * (1.1 + 0.8 * r());
      const i = f.spawn(P_VENT, base.x + Math.cos(a) * d, base.y + 1 + 3 * r(), base.z + Math.sin(a) * d, Math.cos(a) * 1.5, -0.6, Math.sin(a) * 1.5, 1.5 + 1.5 * r(), 7 + 6 * r(), wx, wz, r() * dt);
      if (i >= 0) { f.alpha[i] = 0.3; f.flags[i] = F_GROUND; f.lift[i] = 0.5; f.buoy[i] = -0.35; }
    }
  }
}
