// The moisture the air carries, moved by the wind: what lets cloud form where air rises, drift on with the wind and
// dissolve where it sinks, instead of being drawn where the weather systems alone say it is (weather.js).
//
// One number for each texel of the weather map (2 km): how much more moisture the air there holds than the air mass
// itself would (a, as a share of what air can hold as vapor at cloud base). q, the moisture itself, is the air mass's
// own (eq: the situation's humidity, more over moist ground, less over water) plus a, so a change of situation or of
// the humidity acts at once and the field carries only what the ground and the wind have done to the air. Each time
// weather.js refreshes a row of the map, the row's a is moved on by the seconds since its last refresh:
//
//   carried    each texel takes the a of the air that was upwind of it, the wind being the one at 1500 m
//              (semi-Lagrangian: stable for any step); air coming in from outside the map brings none
//   the air    a fades over about TAU (80 minutes): at 10 m/s a plume runs some 35 km before it is half gone
//   slopes     air carried up a slope cools and q rises with the height it has climbed (LIFT a meter); coming down
//              the lee it warms and dries again, short of whatever rained out on the way up (the rain shadow)
//   water      cold air over warmer big water takes up moisture: lake-effect cloud, and sea-effect off a cold coast
//   highs      the sinking air under a high dries
//   breeze     on a sunny afternoon the breeze off big water meets the land's air some 20 km inland and lifts it
//   rain       q over WET rains out
//
// The other sources are given as the a each would build if it acted alone for long (the rate is that over TAU).
// weather.column() reads q: the fair-weather cumulus field grows and shrinks with it, and where q is well over what
// the air mass holds (on windward slopes, downwind of the lakes, along the breeze front) it is cloud of its own.
// The shore of big water (blurred, so a pond is no coast) also gives the sea breeze its direction (weather.wind).

import { clamp, smoothstep } from '../core/noise.js';
import { WORLD_HALF, baseWater } from '../world/terrain.js';

const TAU = 4800;                 // s: how fast what the ground and the wind did to the air fades
const LIFT = 0.0011;              // a for each meter the air has been carried up (about 7% relative humidity a hundred meters, and
                                  // more here: the 2 km terrain grid takes a third off the height of the ranges)
const LAKE = 1.0;                 // a over open water under air much colder than it
const SINK = 0.25;                // a (taken away) under the middle of a high
const BREEZE = 0.45;              // a at the sea-breeze front at the height of a calm afternoon
const WET = 1.15, RAIN = 1 / 900, QMAX = 1.6;   // q over WET rains out, by this share a second
const STEP_MAX = 1800;                    // s a row is moved on at most in one step
const BLUR = 4;                           // texels: water must fill this much of the country around to count as big water
const SHORE_MAX = 80e3;                   // m: the shore's distance is not followed farther than this

export class Moisture {
  constructor(N) {
    this.N = N; this.step = (2 * WORLD_HALF) / N;
    this.a = new Float32Array(N * N); this.an = new Float32Array(N * N);   // the field read, and the one being built
    this.water = new Float32Array(N * N);       // share of big water around each texel, 0..1
    this.shore = new Float32Array(N * N);       // signed distance to the shore of big water (m: + inland, - offshore)
    this.nx = new Float32Array(N * N); this.nz = new Float32Array(N * N);   // unit vector inland, across the shore
    this.rowT = new Float64Array(N);
    this._w = { x: 0, z: 0 }; this._s = { d: 0, nx: 0, nz: 0 };
  }

  /** What the air mass makes q at texel k when nothing else is acting on it (weather.column works it out the same way). */
  eq(w, k) { return w.humidity * (0.55 + 0.75 * w.moist[k]) * (w.terr[k] > 1 ? 1 : 0.55); }

  /** Read where the big water is, and its shore (after the terrain grids are read: weather.readTerrain). */
  readSurface() {
    const N = this.N, H = WORLD_HALF, s = this.step, raw = new Float32Array(N * N), tmp = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) raw[j * N + i] = baseWater((i + 0.5) * s - H, (j + 0.5) * s - H) ? 1 : 0;
    // A box blur, rows then columns: the share of water within BLUR texels.
    const box = (src, dst, di, dj) => {
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let sum = 0, n = 0;
        for (let t = -BLUR; t <= BLUR; t++) { const ii = i + t * di, jj = j + t * dj; if (ii >= 0 && ii < N && jj >= 0 && jj < N) { sum += src[jj * N + ii]; n++; } }
        dst[j * N + i] = sum / n;
      }
    };
    box(raw, tmp, 1, 0); box(tmp, this.water, 0, 1);
    // Distance to the other side of the shore (two-pass chamfer), signed: + over land.
    const big = (k) => this.water[k] > 0.5, d = this.shore, D1 = s, D2 = s * Math.SQRT2;
    for (let k = 0; k < N * N; k++) d[k] = SHORE_MAX;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, b = big(k);
      if ((i > 0 && big(k - 1) !== b) || (i < N - 1 && big(k + 1) !== b) || (j > 0 && big(k - N) !== b) || (j < N - 1 && big(k + N) !== b)) d[k] = s / 2;
    }
    const relax = (k, k2, c) => { if (d[k2] + c < d[k]) d[k] = d[k2] + c; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i > 0) relax(k, k - 1, D1);
      if (j > 0) { relax(k, k - N, D1); if (i > 0) relax(k, k - N - 1, D2); if (i < N - 1) relax(k, k - N + 1, D2); }
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (i < N - 1) relax(k, k + 1, D1);
      if (j < N - 1) { relax(k, k + N, D1); if (i < N - 1) relax(k, k + N + 1, D2); if (i > 0) relax(k, k + N - 1, D2); }
    }
    for (let k = 0; k < N * N; k++) d[k] = Math.min(d[k], SHORE_MAX) * (big(k) ? -1 : 1);
    // Inland: up the slope of the signed distance.
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, gx = d[j * N + Math.min(i + 1, N - 1)] - d[j * N + Math.max(i - 1, 0)], gz = d[Math.min(j + 1, N - 1) * N + i] - d[Math.max(j - 1, 0) * N + i], l = Math.hypot(gx, gz);
      this.nx[k] = l > 1 ? gx / l : 0; this.nz[k] = l > 1 ? gz / l : 0;
    }
  }

  /** a at a point (bilinear); `fallback` (if given) beyond the map. */
  at(x, z, g = this.a, fallback = -1e9) {
    const N = this.N, H = WORLD_HALF, fx = ((x + H) / (2 * H)) * N - 0.5, fz = ((z + H) / (2 * H)) * N - 0.5;
    if (fallback > -1e9 && (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1)) return fallback;
    const cx = clamp(fx, 0, N - 1.001), cz = clamp(fz, 0, N - 1.001), i = cx | 0, j = cz | 0, u = cx - i, v = cz - j, k = j * N + i;
    return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + N] * (1 - u) + g[k + N + 1] * u) * v;
  }

  /** The shore of big water near a point: { d: m inland (negative offshore), nx, nz: unit vector inland }, or null far from any. */
  shoreAt(x, z) {
    const N = this.N, H = WORLD_HALF, fx = clamp(((x + H) / (2 * H)) * N - 0.5, 0, N - 1.001), fz = clamp(((z + H) / (2 * H)) * N - 0.5, 0, N - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * N + i;
    const lerp4 = (g) => (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + N] * (1 - u) + g[k + N + 1] * u) * v;
    const d = lerp4(this.shore);
    if (d > 60e3 || d < -40e3) return null;
    const o = this._s, nx = lerp4(this.nx), nz = lerp4(this.nz), l = Math.hypot(nx, nz);
    if (l < 0.2) return null;
    o.d = d; o.nx = nx / l; o.nz = nz / l;
    return o;
  }

  /** Move row j on to time `now` (weather.time), into the next field; read from the last whole one. */
  stepRow(w, j, now) {
    const dt = clamp(now - this.rowT[j], 0, STEP_MAX);
    this.rowT[j] = now;
    this._row(w, j, dt);
  }

  _row(w, j, dt) {
    const N = this.N, H = WORLD_HALF, s = this.step, a = this.a, an = this.an, W = this._w;
    if (dt <= 0) { an.set(a.subarray(j * N, j * N + N), j * N); return; }
    const z = (j + 0.5) * s - H, keep = Math.exp(-dt / TAU), rain = Math.exp(-dt * RAIN), heat = w.heat();
    for (let i = 0; i < N; i++) {
      const k = j * N + i, x = (i + 0.5) * s - H, eq = this.eq(w, k);
      w.steer(x, z, W);
      const ux = x - W.x * dt, uz = z - W.z * dt;
      const aa = this.at(ux, uz, a, 0) + LIFT * (w.terr[k] - w.grid(w.terr, ux, uz));   // (and the height it climbed, or came down, on the way)
      // What acts on the air here, as the a it would build on its own...
      let t = this.water[k] * smoothstep(4, -8, w.tsea[k] + w.tAnom) * LAKE;     // (air this much colder than the water it crosses)
      t -= w.subsidence(x, z) * SINK;
      const d = this.shore[k];
      if (heat > 0 && d > 0 && d < 50e3) t += heat * (1 - smoothstep(4, 10, Math.hypot(W.x, W.z))) * BREEZE * Math.exp(-Math.pow((d - 20e3) / 9e3, 2));
      // ...and a moving toward that, solved exactly over the step; then what is over WET rains out.
      let q = eq + t + (aa - t) * keep;
      if (q > WET) q = WET + (q - WET) * rain;
      an[k] = clamp(q, 0, QMAX) - eq;
    }
  }

  /** A row cycle is complete: the field just built becomes the one read. */
  swap() { const t = this.a; this.a = this.an; this.an = t; }

  /** Move everything on from still air until it has settled, as if the weather had been going for hours. */
  spinUp(w) {
    const N = this.N;
    this.a.fill(0);
    for (let n = 0; n < 10; n++) { for (let j = 0; j < N; j++) this._row(w, j, 1500); this.swap(); }
    this.an.set(this.a); this.rowT.fill(w.time);
  }

  /** The window of the world moved by (di, dj) texels: carry the field with it; what comes in is the air mass's own. */
  shift(di, dj) {
    const N = this.N, old = this.a.slice();
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const si = i - di, sj = j - dj;
      this.a[j * N + i] = si >= 0 && si < N && sj >= 0 && sj < N ? old[sj * N + si] : 0;
    }
    this.an.set(this.a);
  }
}
