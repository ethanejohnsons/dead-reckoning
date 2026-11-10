// Weather simulation. The atmosphere is built from the same pieces a real
// synoptic chart shows: highs and lows (wind blows along the isobars,
// anticlockwise round a low), cold and warm fronts trailing from each low,
// air-mass thunderstorm cells with a life cycle, sea-fog banks, fair-weather
// cumulus with thermals, and terrain effects (upslope cloud, lee sink,
// mountain wave). One function answers "what is the air doing here?" for the
// flight model, and a baked weather map drives the cloud renderer.

import { makeSimplex2, fbm, clamp, lerp, smoothstep, mulberry32 } from '../core/noise.js';
import { rawHeight, climate, WORLD_HALF } from '../world/terrain.js';
import { makeCloudNoise, sampleNoise } from './cloudnoise.js';

export const WX_N = 256;
export const TEX_ALT = 12800;
export const CLOUD_SIGMA = 0.011;      // extinction of dense cloud, 1/m
export const NOISE_SCALE = 7300, DETAIL_SCALE = 1900;
const K_GEO = 1.0e5;                   // m/s of wind per hPa/m of pressure gradient
const D2R = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export const SITUATIONS = {
  fair: { title: 'High pressure', difficulty: 1, hours: [9, 11, 14, 17],
    blurb: 'Settled air under a high. Light winds, scattered fair-weather cumulus, afternoon thermals.' },
  storms: { title: 'Air-mass thunderstorms', difficulty: 2, hours: [15, 16, 17],
    blurb: 'Hot and humid. Isolated cells build fast through the afternoon. Thread between them, never under.' },
  gale: { title: 'Gale and mountain wave', difficulty: 2, hours: [10, 13, 15],
    blurb: 'A tight pressure gradient. Heavy drift aloft, lee-side sink and rotor near high ground, a gusty crosswind to land in.' },
  coldfront: { title: 'Cold front', difficulty: 3, hours: [11, 14, 16],
    blurb: 'A squall line is sweeping across the route: towering cumulonimbus, heavy rain, then a sharp wind shift and colder, clearer air.' },
  warmfront: { title: 'Warm front', difficulty: 3, hours: [9, 12, 15],
    blurb: 'Cirrus thickening to a lowering overcast with steady rain toward the destination. Icing in cloud above the freezing level.' },
  fog: { title: 'Sea fog', difficulty: 3, hours: [6.5, 7.5, 8.5],
    blurb: 'Calm and clear on top, but a fog bank lies over the destination. The runway is somewhere underneath.' },
  winter: { title: 'Winter stratus', difficulty: 3, hours: [10, 13, 15],
    blurb: 'A cold air mass with low overcast and snow showers. Ice builds on the airframe in cloud.' },
  monsoon: { title: 'Tropical squalls', difficulty: 2, hours: [13, 15, 17],
    blurb: 'Deep moist air, towering cumulus everywhere and sudden blinding downpours.' },
};

export class Weather {
  constructor() {
    this.noise = makeCloudNoise();
    this.cu = makeSimplex2(501);
    this.rng = mulberry32(7);
    this.lows = []; this.highs = []; this.cells = []; this.fogs = [];
    this.layer = null;                   // optional widespread stratus deck
    this.time = 0; this.hour = 12;
    this.tAnom = 0; this.humidity = 0.5; this.haze = 60000; this.cirrus = 0.15;
    this.flowX = 4; this.flowZ = 0;
    this.cellAreas = [];
    this.drift = { x: 0, y: 0, z: 0 };   // accumulated cloud-noise advection (m)
    this.flashes = [];
    this.kind = 'fair';

    // Coarse terrain, moisture and sea-level temperature grids (2 km).
    const N = WX_N, H = WORLD_HALF;
    this.terr = new Float32Array(N * N); this.moist = new Float32Array(N * N); this.tsea = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 * H - H, z = ((j + 0.5) / N) * 2 * H - H;
      const k = j * N + i;
      this.terr[k] = Math.max(0, rawHeight(x, z, 1));
      const cl = climate(x, z);
      this.moist[k] = cl.moist; this.tsea[k] = cl.tSea;
    }
    // Wind grid (16 km) refreshed every bake, used for terrain-forced cloud.
    this.WG = 33; this.windGrid = new Float32Array(this.WG * this.WG * 2);
    this.A = new Uint8Array(N * N * 4); this.B = new Uint8Array(N * N * 4);
    this.A2 = new Uint8Array(N * N * 4); this.B2 = new Uint8Array(N * N * 4);
    this.row = 0; this.dirty = false;
    this.col = { cov: 0, base: 0, top: 0, conv: 0, precip: 0, cirrus: 0, front: 0, cell: 0, fog: 0, cold: 0, warm: 0, cu: 0, cuBase: 1200 };
    this.setup('fair', null, 12);
  }

  grid(g, x, z) {
    const N = WX_N, H = WORLD_HALF;
    const fx = clamp(((x + H) / (2 * H)) * N - 0.5, 0, N - 1.001), fz = clamp(((z + H) / (2 * H)) * N - 0.5, 0, N - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * N + i;
    return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + N] * (1 - u) + g[k + N + 1] * u) * v;
  }

  // ---------------------------------------------------------------- scenarios

  /** Build a weather situation around a route {ax, az, bx, bz} (or the map centre). */
  setup(kind, route, hour, seed = 1) {
    const R = this.rng = mulberry32(seed * 7919 + 13);
    this.kind = kind; this.hour = hour; this.time = 0;
    this.lows = []; this.highs = []; this.cells = []; this.fogs = []; this.cellAreas = [];
    this.layer = null; this.flashes = [];
    this.tAnom = 0; this.humidity = 0.5; this.haze = 60000; this.cirrus = 0.12;
    this.flowX = 3 + R() * 3; this.flowZ = (R() - 0.5) * 3;
    const r = route || { ax: -60000, az: 30000, bx: 60000, bz: -30000 };
    const mx = (r.ax + r.bx) / 2, mz = (r.az + r.bz) / 2;
    const dist = Math.hypot(r.bx - r.ax, r.bz - r.az);
    const eta = dist / 72;                                       // seconds to fly the route
    const low = (x, z, amp, sig, vx, vz, fronts = true) => {
      const l = { x, z, amp, sig, vx, vz, fronts, trough: fronts ? 3 : 0, thC: -115 * D2R, thW: -12 * D2R, curlC: -0.3, curlW: -0.25 };
      this.lows.push(l); return l;
    };
    const high = (x, z, amp, sig, vx = 3, vz = 0) => this.highs.push({ x, z, amp, sig, vx, vz });
    const area = (x, z, rad, count) => { this.cellAreas.push({ x, z, r: rad, count }); for (let i = 0; i < count; i++) this.spawnCell(this.cellAreas.length - 1, R() * 0.7); };

    if (kind === 'fair') {
      high(mx + (R() - 0.5) * 80e3, mz + (R() - 0.5) * 80e3, 14, 210e3);
      low(mx - 520e3, mz - 380e3, -14, 130e3, 6, 0, false);
      this.humidity = 0.55; this.flowX = 2; this.flowZ = (R() - 0.5) * 2;
    } else if (kind === 'storms' || kind === 'monsoon') {
      const mon = kind === 'monsoon';
      high(mx + 420e3, mz - 200e3, 8, 220e3);
      low(mx - 60e3, mz + 40e3, -5, 200e3, 2, 0, false);         // weak thermal low
      this.humidity = mon ? 1.0 : 0.8; this.haze = mon ? 22000 : 32000; this.tAnom = mon ? 3 : 5; this.cirrus = 0.25;
      const n = mon ? 9 : 7;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.86 * (i + R() * 0.8)) / n, side = (i % 2 ? 1 : -1) * (9e3 + R() * 34e3);
        const ux = (r.bx - r.ax) / dist, uz = (r.bz - r.az) / dist;
        area(r.ax + (r.bx - r.ax) * t - uz * side, r.az + (r.bz - r.az) * t + ux * side, 12e3, 1);
      }
      area(mx, mz, Math.max(120e3, dist), mon ? 8 : 5);
      if (mon) { this.flowX = -2; this.flowZ = -3; }
    } else if (kind === 'gale') {
      const sgn = R() < 0.5 ? 1 : -1;                              // westerly or easterly gale
      low(mx + 40e3, mz - sgn * 330e3, -60, 170e3, 5, 0, false);
      high(mx - 40e3, mz + sgn * 330e3, 28, 190e3, 5, 0);
      this.humidity = 0.38; this.cirrus = 0.3; this.flowX = 5 * sgn;
    } else if (kind === 'coldfront') {
      // Lay the cold front square across the route so it is met about 55% of the way
      // along, and move the low so the front advances into its warm sector.
      const sig = 115e3, d0 = 1.15 * sig, speed = 11;
      const ux = (r.bx - r.ax) / dist, uz = (r.bz - r.az) / dist;
      let ox = -uz, oz = ux;                                       // outward along the front, pointing south-ish
      if (oz < 0) { ox = -ox; oz = -oz; }
      const vx = oz * speed, vz = -ox * speed;                     // toward the warm-sector side
      const px = r.ax + (r.bx - r.ax) * 0.55, pz = r.az + (r.bz - r.az) * 0.55, tc = eta * 0.55;
      const l = low(px - ox * d0 - vx * tc, pz - oz * d0 - vz * tc, -24, sig, vx, vz);
      l.thC = Math.atan2(-oz, ox) - l.curlC * 1.15; l.thW = l.thC + 103 * D2R;
      high(px - vx * 38e3, pz - vz * 38e3, 15, 180e3, vx, vz);
      this.humidity = 0.55; this.haze = 40000; this.cirrus = 0.2;
    } else if (kind === 'warmfront') {
      const sig = 125e3, vx = 6, d0 = 0.85 * sig;
      const th = -12 * D2R - 0.25 * 0.85;
      // Destination sits ~35 km ahead of the surface front under the rain shield.
      const fx = Math.cos(th), fn = Math.sin(th), ahead = 35e3;
      low(r.bx - fx * d0 + fn * ahead - vx * eta, r.bz + fn * d0 + fx * ahead + 2 * eta, -20, sig, vx, -2);
      high(r.bx + 460e3, r.bz - 80e3, 12, 200e3, 5, 0);
      this.humidity = 0.5; this.haze = 30000; this.cirrus = 0.35;
    } else if (kind === 'fog') {
      high(mx + (R() - 0.5) * 60e3, mz + (R() - 0.5) * 60e3, 16, 230e3, 1, 0);
      this.flowX = 0.8; this.flowZ = 0.4; this.humidity = 0.16; this.haze = 45000; this.cirrus = 0.08;
      this.fogs.push({ x: r.bx + (R() - 0.5) * 12e3, z: r.bz + (R() - 0.5) * 12e3, r: 30e3 + R() * 14e3, top: 190 + R() * 110, persist: true });
      // A second bank somewhere off the route, kept clear of the departure field.
      const f2 = { x: mx + (R() - 0.5) * 150e3, z: mz + (R() - 0.5) * 150e3, r: 24e3 + R() * 20e3, top: 160 + R() * 120, persist: true };
      const dd = Math.hypot(f2.x - r.ax, f2.z - r.az), need = f2.r * 1.35 + 12e3;
      if (dd < need) { const k = need / Math.max(dd, 1); f2.x = r.ax + (f2.x - r.ax) * k; f2.z = r.az + (f2.z - r.az) * k; }
      this.fogs.push(f2);
      const f1 = this.fogs[0], d1 = Math.hypot(f1.x - r.ax, f1.z - r.az);
      if (d1 < f1.r * 1.3 + 8e3) f1.r = Math.max(9e3, (d1 - 8e3) / 1.3);          // short hops: shrink the destination bank instead
    } else if (kind === 'winter') {
      this.tAnom = -15; this.humidity = 0.3; this.haze = 35000; this.cirrus = 0.1;
      low(mx + 150e3, mz - 220e3, -18, 160e3, 4, 0, false);
      high(mx - 380e3, mz + 60e3, 12, 200e3, 4, 0);
      this.layer = { cov: 0.92, base: 520, top: 2100, precip: 0.55, seed: R() * 100 };
    }
    this.bakeAll();
  }

  spawnCell(areaIdx, phase = 0) {
    const a = this.cellAreas[areaIdx], R = this.rng;
    const ang = R() * Math.PI * 2, rad = Math.sqrt(R()) * a.r;
    this.cells.push({ area: areaIdx, x: a.x + Math.cos(ang) * rad, z: a.z + Math.sin(ang) * rad,
      r: 5200 + R() * 4200, life: 2000 + R() * 1400, age: 0, vx: 0, vz: 0, flashT: 2 + R() * 6 });
    const c = this.cells[this.cells.length - 1];
    c.age = phase * c.life;
  }

  // ---------------------------------------------------------------- dynamics

  update(dt) {
    this.time += dt; this.hour = (this.hour + dt / 3600) % 24;
    for (const s of this.lows) { s.x += s.vx * dt; s.z += s.vz * dt; }
    for (const s of this.highs) { s.x += s.vx * dt; s.z += s.vz * dt; }
    const W = this._w || (this._w = { x: 0, z: 0 });
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      c.age += dt;
      if ((c.steerT = (c.steerT || 0) - dt) <= 0) { this.wind(c.x, c.z, 3000, 0, W); c.vx = W.x * 0.7; c.vz = W.z * 0.7; c.steerT = 20; }
      c.x += c.vx * dt; c.z += c.vz * dt;
      const ph = c.age / c.life;
      if (ph >= 1) { this.cells.splice(i, 1); this.spawnCell(c.area, 0); continue; }
      // Lightning in the mature stage.
      if (ph > 0.28 && ph < 0.82) {
        c.flashT -= dt;
        if (c.flashT <= 0) {
          c.flashT = 2.5 + this.rng() * 9;
          const a = this.rng() * 6.283, rr = this.rng() * c.r * 0.7;
          this.flashes.push({ x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr, y: 900 + this.rng() * 3500, ground: this.rng() < 0.45 });
        }
      }
    }
    // Squall-line lightning along active cold fronts.
    for (const l of this.lows) {
      if (!l.fronts) continue;
      l.flashT = (l.flashT ?? 3) - dt;
      if (l.flashT <= 0) {
        l.flashT = 1.5 + this.rng() * 5;
        const d = l.sig * (0.5 + this.rng() * 1.5), th = l.thC + l.curlC * (d / l.sig);
        this.flashes.push({ x: l.x + Math.cos(th) * d + 4000, z: l.z - Math.sin(th) * d, y: 900 + this.rng() * 3500, ground: this.rng() < 0.45 });
      }
    }
    // Clouds drift with the mid-level flow.
    this.drift.x += this.flowX * 1.5 * dt; this.drift.z += this.flowZ * 1.5 * dt;
    this.bakeSome(6);
  }

  // ---------------------------------------------------------------- pressure and wind

  /** Front geometry for a low at (x,z): fills this.fg with signed distances and envelopes. */
  fronts(l, x, z) {
    const g = this.fg || (this.fg = {});
    const dx = x - l.x, dz = z - l.z, d = Math.hypot(dx, dz), ds = d / l.sig;
    g.d = d;
    if (!l.fronts || ds > 3) { g.eC = g.eW = g.sector = g.cold = 0; g.sC = g.sW = 1e9; return g; }
    const phi = Math.atan2(-dz, dx);
    const dc = wrap(phi - (l.thC + l.curlC * ds)), dw = wrap(phi - (l.thW + l.curlW * ds));
    g.sC = Math.abs(dc) < 1.57 ? d * Math.sin(dc) : Math.sign(dc) * d;
    g.sW = Math.abs(dw) < 1.57 ? d * Math.sin(dw) : Math.sign(dw) * d;
    g.eC = smoothstep(0.1, 0.38, ds) * (1 - smoothstep(2.0, 2.6, ds)) * smoothstep(1.5, 1.0, Math.abs(dc));
    g.eW = smoothstep(0.1, 0.35, ds) * (1 - smoothstep(1.3, 1.85, ds)) * smoothstep(1.5, 1.0, Math.abs(dw));
    const inSector = dc > 0 && dw < 0;
    g.sector = inSector ? smoothstep(0, 30e3, g.sC) * smoothstep(0, 30e3, -g.sW) * (1 - smoothstep(1.3, 2.0, ds)) : 0;
    g.cold = dc < 0 && dc > -2.2 ? smoothstep(0, -50e3, g.sC) * (1 - smoothstep(1.8, 2.6, ds)) * smoothstep(-2.2, -1.2, dc) : 0;
    return g;
  }

  pressure(x, z) {
    let p = 1013;
    for (const h of this.highs) { const dx = x - h.x, dz = z - h.z; p += h.amp * Math.exp(-(dx * dx + dz * dz) / (2 * h.sig * h.sig)); }
    for (const l of this.lows) {
      const dx = x - l.x, dz = z - l.z;
      p += l.amp * Math.exp(-(dx * dx + dz * dz) / (2 * l.sig * l.sig));
      if (l.fronts) {
        const g = this.fronts(l, x, z);
        if (g.eC > 0) p -= l.trough * g.eC * Math.exp(-Math.pow(g.sC / 45e3, 2));
        if (g.eW > 0) p -= l.trough * 0.5 * g.eW * Math.exp(-Math.pow(g.sW / 55e3, 2));
      }
    }
    return p;
  }

  /** Wind vector (m/s, the direction the air moves toward) at altitude y over ground height gy. */
  wind(x, z, y, gy, out) {
    const h = 4000;
    const px = (this.pressure(x + h, z) - this.pressure(x - h, z)) / (2 * h);
    const pz = (this.pressure(x, z + h) - this.pressure(x, z - h)) / (2 * h);
    let wx = K_GEO * pz + this.flowX, wz = -K_GEO * px + this.flowZ;
    // Surface friction slows the wind and backs it toward low pressure.
    const agl = Math.max(0, y - gy);
    const f = smoothstep(0, 1100, agl);
    const sp = lerp(0.55, 1, f) * (1 + 0.45 * smoothstep(1500, 7000, y));
    const a = (1 - f) * 0.42, cs = Math.cos(a), sn = Math.sin(a);
    out.x = (wx * cs + wz * sn) * sp; out.z = (-wx * sn + wz * cs) * sp;
    return out;
  }

  // ---------------------------------------------------------------- cloud column

  /** Cloud layer over a point: coverage, base/top (m ASL), convective fraction, precipitation. */
  column(x, z, out = this.col) {
    let keep = 1, wb = 0, wt = 0, wc = 0, ws = 0, precip = 0, cirrus = this.cirrus * 0.6, front = 0, cellS = 0, fogS = 0, cold = 0, warm = 0;
    const add = (cov, base, top, conv, pr) => {
      if (cov <= 0.003) return;
      cov = Math.min(cov, 1);
      keep *= 1 - cov; ws += cov; wb += base * cov; wt += top * cov; wc += conv * cov;
      if (pr > precip) precip = pr;
    };
    const terr = this.grid(this.terr, x, z), moist = this.grid(this.moist, x, z);
    const hr = this.hour, diurnal = 0.3 + 0.7 * clamp(Math.sin((Math.PI * (hr - 8)) / 12), 0, 1);
    const n = fbm(this.cu, (x + this.drift.x * 0.5) / 46e3, (z + this.drift.z * 0.5) / 46e3, 2);
    const n2 = this.cu(x / 17e3 + 40, z / 17e3 - 9);

    let sub = 0;
    for (const h of this.highs) { const dx = x - h.x, dz = z - h.z; sub += Math.exp(-(dx * dx + dz * dz) / (2 * h.sig * h.sig)); }
    sub = Math.min(sub, 1);

    // Fair-weather cumulus field, deeper where the air is humid.
    const hum = this.humidity * (0.55 + 0.75 * moist) * (terr > 1 ? 1 : 0.55);
    let cu = smoothstep(-0.15, 0.55, n) * hum * diurnal * (1 - 0.45 * sub) * 0.9;
    const cuBase = 950 + 1250 * (1 - moist) + (this.tAnom > 0 ? 150 : 0);
    out.cu = cu; out.cuBase = cuBase;
    let cuTop = cuBase + 500 + 2300 * this.humidity * this.humidity * smoothstep(-0.2, 0.7, n2 + n * 0.5) * diurnal;

    for (const l of this.lows) {
      const g = this.fronts(l, x, z);
      const core = Math.exp(-(g.d * g.d) / (2 * 0.09 * l.sig * l.sig)) * (l.fronts ? 1 : 0.5) * Math.min(1, -l.amp / 18);
      add(core, 420, 6200, 0.2, core * 0.6);
      if (!l.fronts) continue;
      if (g.eW > 0.002) {
        const s = g.sW, w = g.eW * smoothstep(-22e3, 0, s) * (1 - smoothstep(70e3, 175e3, s));
        add(w, 260 + Math.max(s, 0) * 0.021, 6400, 0.05, g.eW * smoothstep(-16e3, 0, s) * (1 - smoothstep(30e3, 95e3, s)) * (0.5 + 0.15 * n2));
        cirrus = Math.max(cirrus, g.eW * smoothstep(-22e3, 0, s) * (1 - smoothstep(170e3, 310e3, s)));
      }
      if (g.eC > 0.002) {
        const lump = 0.72 + 0.28 * this.cu(g.d / 9000, l.amp);
        const w = g.eC * Math.exp(-Math.pow((g.sC - 4000) / 11e3, 2)) * lump;
        add(w * 1.15, 620, 8200 + 2600 * lump, 1, w * 0.95);
        front = Math.max(front, w);
        cirrus = Math.max(cirrus, g.eC * Math.exp(-Math.pow((g.sC - 32e3) / 42e3, 2)) * 0.75);
      }
      if (g.sector > 0.01) { warm = Math.max(warm, g.sector); cu = Math.max(cu, g.sector * smoothstep(-0.1, 0.6, n) * 0.42); cuTop = Math.max(cuTop, cuBase + 1900 * g.sector); }
      if (g.cold > 0.01) {
        cold = Math.max(cold, g.cold);
        const sh = g.cold * smoothstep(0.05, 0.7, n2);
        add(sh * 0.5, 1150, 3300, 0.75, g.cold * smoothstep(0.42, 0.8, n2) * 0.4);
      }
    }

    for (const c of this.cells) {
      const dx = x - c.x, dz = z - c.z, lim = c.r * 4;
      if (dx > lim || dx < -lim || dz > lim || dz < -lim) continue;
      const d = Math.hypot(dx, dz), ph = c.age / c.life;
      const s = smoothstep(0, 0.25, ph) * (1 - smoothstep(0.8, 1, ph));
      const mature = smoothstep(0.2, 0.35, ph) * (1 - smoothstep(0.82, 1, ph));
      const cov = s * (1 - smoothstep(0.7 * c.r, 1.45 * c.r, d));
      add(cov, 820, 3800 + 7600 * smoothstep(0, 0.42, ph), 1, mature * (1 - smoothstep(0.3 * c.r, 0.95 * c.r, d)));
      cellS = Math.max(cellS, cov);
      const ax = dx - c.vx * 90, az = dz - c.vz * 90;                // anvil streams downwind
      cirrus = Math.max(cirrus, mature * (1 - smoothstep(c.r, 3.3 * c.r, Math.hypot(ax, az))) * 0.85);
    }

    // Terrain forcing: upslope flow builds cloud on windward slopes, lee slopes dry out.
    const U = this.upslope(x, z);
    if (U > 0.25 && terr > 150) add(smoothstep(0.25, 1.6, U) * (0.35 + 0.6 * moist) * Math.min(1, this.humidity * 1.6 + 0.2), Math.max(800, terr * 0.55), terr + 1300, 0.3, smoothstep(1.2, 2.6, U) * 0.35 * moist);
    if (U < 0) cu *= 1 - 0.75 * smoothstep(0.2, 1.4, -U);

    add(cu, cuBase, cuTop, 0.55 + 0.4 * this.humidity * smoothstep(1500, 3000, cuTop - cuBase), cu > 0.3 && this.humidity > 0.85 ? (cu - 0.3) * 1.2 * smoothstep(0.2, 0.7, n2) : 0);

    if (this.layer) {
      const L = this.layer, br = 0.72 + 0.28 * smoothstep(-0.5, 0.3, this.cu(x / 60e3 + L.seed, z / 60e3));
      add(L.cov * br, L.base + 250 * n, L.top + 400 * n, 0.08, L.precip * smoothstep(0.1, 0.65, n2 + 0.25 * n));
    }

    for (const f of this.fogs) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d > f.r * 1.3) continue;
      const burn = f.persist ? 1 : 1 - smoothstep(8.5, 11.5, hr);
      const s = burn * (1 - smoothstep(0.65 * f.r, f.r * (1.05 + 0.2 * n2), d));
      if (s > 0.01 && terr < f.top) {
        // Fog hugs the surface: it wins the blend outright where present.
        const k = s * s; keep *= 1 - s; ws = ws * (1 - k) + s; wb = wb * (1 - k); wt = wt * (1 - k) + (f.top + 40 * n2) * s; wc *= 1 - k;
        fogS = Math.max(fogS, s);
      }
    }

    const cov = 1 - keep;
    out.cov = cov;
    if (ws > 0.001) { out.base = wb / ws; out.top = Math.max(wt / ws, out.base + 120); out.conv = clamp(wc / ws, 0, 1); }
    else { out.base = 1200; out.top = 2000; out.conv = 0.5; }
    out.precip = clamp(precip, 0, 1) * smoothstep(0.05, 0.4, cov);
    out.cirrus = clamp(cirrus, 0, 1);
    out.front = front; out.cell = cellS; out.fog = fogS; out.cold = cold; out.warm = warm;
    return out;
  }

  /** Vertical air speed forced at the surface by wind blowing over sloping terrain. */
  upslope(x, z) {
    const G = this.WG, H = WORLD_HALF;
    const fx = clamp(((x + H) / (2 * H)) * (G - 1), 0, G - 1.001), fz = clamp(((z + H) / (2 * H)) * (G - 1), 0, G - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = (j * G + i) * 2, g = this.windGrid;
    const wx = (g[k] * (1 - u) + g[k + 2] * u) * (1 - v) + (g[k + G * 2] * (1 - u) + g[k + G * 2 + 2] * u) * v;
    const wz = (g[k + 1] * (1 - u) + g[k + 3] * u) * (1 - v) + (g[k + G * 2 + 1] * (1 - u) + g[k + G * 2 + 3] * u) * v;
    return this.slopeFlow(x, z, wx, wz);
  }
  slopeFlow(x, z, wx, wz) {
    const e = 3000;
    const gx = (this.grid(this.terr, x + e, z) - this.grid(this.terr, x - e, z)) / (2 * e);
    const gz = (this.grid(this.terr, x, z + e) - this.grid(this.terr, x, z - e)) / (2 * e);
    return wx * gx + wz * gz;
  }

  // ---------------------------------------------------------------- baking for the renderer

  refreshWindGrid() {
    const G = this.WG, H = WORLD_HALF, o = { x: 0, z: 0 };
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const x = (i / (G - 1)) * 2 * H - H, z = (j / (G - 1)) * 2 * H - H;
      this.wind(x, z, 1500, 0, o);
      this.windGrid[(j * G + i) * 2] = o.x; this.windGrid[(j * G + i) * 2 + 1] = o.z;
    }
  }

  bakeRows(n) {
    const N = WX_N, H = WORLD_HALF, c = this.col;
    for (let r = 0; r < n && this.row < N; r++, this.row++) {
      const j = this.row, z = ((j + 0.5) / N) * 2 * H - H;
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 * H - H, o = (j * N + i) * 4;
        this.column(x, z, c);
        this.A2[o] = c.cov * 255; this.A2[o + 1] = c.conv * 255; this.A2[o + 2] = c.precip * 255; this.A2[o + 3] = c.cirrus * 255;
        this.B2[o] = clamp(c.base / TEX_ALT, 0, 1) * 255; this.B2[o + 1] = clamp(c.top / TEX_ALT, 0, 1) * 255;
      }
    }
    if (this.row >= N) {
      this.A.set(this.A2); this.B.set(this.B2);
      this.row = 0; this.dirty = true; this.refreshWindGrid();
    }
  }
  bakeSome(rows) { this.bakeRows(rows); }
  bakeAll() { this.refreshWindGrid(); this.row = 0; this.bakeRows(WX_N); }

  // ---------------------------------------------------------------- point sample for the flight model

  /** Cloud extinction (1/m) at a point; mirrors the GLSL in clouds.js. */
  density(x, y, z, c) {
    if (c.cov < 0.01) return 0;
    const h = (y - c.base) / Math.max(c.top - c.base, 1);
    if (h <= 0 || h >= 1) return 0;
    const pS = smoothstep(0, 0.1, h) * smoothstep(1, 0.72, h);
    const pC = smoothstep(0, 0.07, h) * (1 - 0.72 * smoothstep(0.3, 1, h)) + 0.5 * smoothstep(0.78, 0.93, h) * smoothstep(1, 0.95, h) * smoothstep(5000, 8000, c.top - c.base);
    const prof = lerp(pS, pC, c.conv);
    const px = x + this.drift.x, pz = z + this.drift.z;
    let n1 = sampleNoise(this.noise, px / NOISE_SCALE, y / NOISE_SCALE, pz / NOISE_SCALE, 0);
    n1 = lerp(n1, n1 * 0.45 + 0.55, (1 - c.conv) * 0.7);
    let d = clamp((n1 * prof - (1 - c.cov)) / lerp(0.3, 0.11, c.conv), 0, 1);
    if (d <= 0) return 0;
    const n2 = sampleNoise(this.noise, px / DETAIL_SCALE, y / DETAIL_SCALE, pz / DETAIL_SCALE, 1);
    d = clamp(d - n2 * 0.55 * (1 - d), 0, 1);
    return d * CLOUD_SIGMA * lerp(0.75, 1.35, c.conv);
  }

  /**
   * Everything the aircraft feels at a point. gy = ground height beneath.
   * Writes: wind x/y/z (m/s), turb 0..1, temp °C, cloud (extinction), precip 0..1,
   * snow bool, icing rate, visibility m, overcast 0..1, shade 0..1, plus the column.
   */
  sample(x, y, z, gy, out) {
    const c = this.column(x, z, this.col);
    const agl = Math.max(0, y - gy);
    this.wind(x, z, y, gy, out);
    const hr = this.hour, diurnal = clamp(Math.sin((Math.PI * (hr - 8)) / 12), 0, 1);
    let up = 0, turb = 0;

    // Thermals under fair-weather cumulus.
    if (c.cu > 0.02 || this.humidity > 0.3) {
      const tn = this.cu((x + this.drift.x) / 1300, (z + this.drift.z) / 1300);
      const lift = Math.pow(Math.max(0, tn), 1.6) * 5.2 - 0.5;
      const k = diurnal * (0.35 + 1.6 * Math.min(c.cu, 0.5)) * smoothstep(0, 350, agl) * (1 - smoothstep(c.cuBase - 150, c.cuBase + 350, y)) * (gy > 1 ? 1 : 0.15);
      up += lift * k; turb = Math.max(turb, 0.22 * k);
    }
    // Thunderstorm cells: core updraft, rain-shaft downdraft, gust-front outflow.
    for (const s of this.cells) {
      const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz);
      if (d > s.r * 3) continue;
      const ph = s.age / s.life;
      const st = smoothstep(0, 0.25, ph) * (1 - smoothstep(0.8, 1, ph));
      const mature = smoothstep(0.2, 0.35, ph) * (1 - smoothstep(0.82, 1, ph));
      up += st * 14 * (1 - smoothstep(0, 0.55 * s.r, d)) * smoothstep(c.base - 400, c.base + 900, y) * (1 - smoothstep(c.top - 1500, c.top, y));
      up -= mature * 10 * (1 - smoothstep(0.15 * s.r, 0.85 * s.r, d)) * (1 - smoothstep(c.base, c.base + 600, y)) * smoothstep(0, 250, agl);
      const of = mature * 13 * smoothstep(0.2 * s.r, 1.1 * s.r, d) * (1 - smoothstep(1.2 * s.r, 2.8 * s.r, d)) * Math.exp(-agl / 900);
      if (d > 1) { out.x += (dx / d) * of; out.z += (dz / d) * of; }
      turb = Math.max(turb, st * (1 - smoothstep(0.5 * s.r, 1.7 * s.r, d)) * (y < c.top ? 1 : 0.2));
    }
    // Cold-front squall line.
    if (c.front > 0.02) {
      const cn = this.cu((x + this.drift.x) / 2400 + 7, (z + this.drift.z) / 2400);
      up += c.front * 9 * cn * smoothstep(c.base - 300, c.base + 600, y) - c.front * 5 * (1 - smoothstep(c.base, c.base + 500, y)) * smoothstep(0, 250, agl) * c.precip;
      turb = Math.max(turb, c.front * 0.85);
    }
    // Terrain: slope lift/sink near the surface and a train of lee waves downwind.
    const ws = Math.hypot(out.x, out.z);
    const U = this.slopeFlow(x, z, out.x, out.z);
    up += clamp(U, -8, 8) * Math.exp(-agl / 1400);
    if (ws > 6) {
      const ux = out.x / ws, uz = out.z / ws, step = 3000;
      let wave = 0;
      for (let j = 1; j <= 10; j++) {
        const sx = x - ux * j * step, sz = z - uz * j * step;
        const dh = (this.grid(this.terr, sx + ux * 1500, sz + uz * 1500) - this.grid(this.terr, sx - ux * 1500, sz - uz * 1500)) / 3000;
        wave += dh * Math.cos((6.283 * j * step) / 13000) * Math.exp(-(j * step) / 34000);
      }
      wave *= ws * 1.5 * smoothstep(8, 16, ws) * smoothstep(200, 1400, agl);
      up += clamp(wave, -9, 9);
      turb = Math.max(turb, clamp(Math.abs(wave) / 7, 0, 0.8) * (1 - smoothstep(900, 2600, agl)));
    }
    // Mechanical turbulence from wind over rough ground.
    const rough = Math.min(1, Math.abs(U) / 1.2 + (gy > 1 ? 0.25 : 0.05));
    turb = Math.max(turb, clamp(ws / 22, 0, 1) * rough * Math.exp(-agl / 700));

    const dens = this.density(x, y, z, c);
    if (dens > 0) turb = Math.max(turb, 0.12 + 0.35 * c.conv * Math.min(1, dens / CLOUD_SIGMA));
    out.y = up; out.turb = clamp(turb, 0, 1);
    out.cloud = dens;

    const tsl = this.grid(this.tsea, x, z) + this.tAnom - 6.5 * c.cold + 2.5 * c.warm + (diurnal - 0.4) * 4 * (1 - c.cov);
    out.tempSea = tsl;
    out.temp = tsl - 0.0065 * y;
    const under = y < c.top ? 1 : 0;
    out.precip = c.precip * under * (y > c.base ? Math.min(1, 0.3 + dens / CLOUD_SIGMA) : 1);
    out.snow = out.temp < 0.8;
    out.icing = dens > 0.0004 && out.temp < 0 && out.temp > -20 ? (0.5 + 0.5 * c.conv) * Math.min(1, dens / (CLOUD_SIGMA * 0.5))
      : (out.precip > 0.1 && out.temp < 0 && out.temp > -7 && !dens ? 0.4 * out.precip : 0);
    let vis = this.haze * (1 + 0.5 * c.cold) / (1 + 0.6 * c.warm);
    vis /= 1 + out.precip * (out.snow ? 34 : 13);
    out.visibility = vis * (1 + smoothstep(2000, 6000, y) * 0.8);
    out.overcast = c.cov * smoothstep(c.top + 300, c.top - 300, y) * smoothstep(0.25, 0.95, c.cov);
    out.shade = Math.max(out.overcast * 0.9, dens > 0 ? 0.8 : 0);
    out.col = c;
    return out;
  }

  // ---------------------------------------------------------------- reports for briefings

  /** Surface observation in the style of a METAR. */
  report(x, z, elev) {
    const o = this._rep || (this._rep = {});
    this.sample(x, elev + 3, z, elev, o);
    const c = o.col, sp = Math.hypot(o.x, o.z) * 1.944;
    const dir = (Math.round(((Math.atan2(-o.x, o.z) / D2R + 360) % 360) / 10) * 10) || 360;
    const gust = sp * (1 + 0.9 * o.turb) + (c.cell > 0.2 ? 14 : 0);
    const fog = c.fog > 0.3 && elev < c.top;
    const visKm = fog ? 0.3 + (1 - c.fog) * 2 : Math.min(o.visibility / 1000, 99);
    const wx = [];
    if (c.cell > 0.3 || c.front > 0.35) wx.push(c.precip > 0.5 ? '+TSRA' : 'TS');
    else if (c.precip > 0.08) wx.push((c.precip > 0.6 ? '+' : c.precip < 0.3 ? '-' : '') + (o.snow ? 'SN' : c.conv > 0.5 ? 'SHRA' : 'RA'));
    if (fog) wx.push('FG');
    const baseFt = Math.max(0, c.base - elev) * 3.281;
    const amt = c.cov < 0.06 ? 'SKC' : c.cov < 0.3 ? 'FEW' : c.cov < 0.55 ? 'SCT' : c.cov < 0.88 ? 'BKN' : 'OVC';
    const cloud = fog ? 'VV001' : amt === 'SKC' ? 'SKC' : amt + String(Math.round(baseFt / 100)).padStart(3, '0') + (c.conv > 0.85 && c.top - c.base > 5000 ? 'CB' : '');
    const p = this.pressure(x, z);
    return {
      dir, kt: Math.round(sp), gust: gust > sp + 8 ? Math.round(gust) : 0, visKm, wx: wx.join(' '), cloud, cover: c.cov,
      ceilingFt: c.cov > 0.55 ? (fog ? 100 : baseFt) : Infinity, temp: Math.round(o.temp), qnh: Math.round(p), fog,
      text: `${String(dir).padStart(3, '0')}${String(Math.round(sp)).padStart(2, '0')}${gust > sp + 8 ? 'G' + Math.round(gust) : ''}KT ` +
        `${visKm >= 10 ? '9999' : String(Math.round(visKm * 1000 / 100) * 100).padStart(4, '0')} ${wx.length ? wx.join(' ') + ' ' : ''}${cloud} ` +
        `${o.temp < 0 ? 'M' : ''}${String(Math.abs(Math.round(o.temp))).padStart(2, '0')} Q${Math.round(p)}`,
    };
  }

  /** Wind aloft: direction it blows FROM (deg true) and speed (kt). */
  windAloft(x, z, y) {
    const o = this.wind(x, z, y, 0, { x: 0, z: 0 });
    return { dir: (Math.atan2(-o.x, o.z) / D2R + 360) % 360, kt: Math.hypot(o.x, o.z) * 1.944, x: o.x, z: o.z };
  }
}
