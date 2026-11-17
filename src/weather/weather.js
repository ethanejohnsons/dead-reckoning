// Weather simulation. The atmosphere is built from the same pieces a real
// synoptic chart shows: highs and lows (wind blows along the isobars,
// counterclockwise around a low north of the equator, clockwise south of it), cold and warm fronts trailing from each low,
// air-mass thunderstorm cells with a life cycle, sea-fog banks, fair-weather
// cumulus with thermals, and terrain effects (upslope cloud, lee sink,
// mountain wave). One function answers "what is the air doing here?" for the
// flight model, and a baked weather map drives the cloud renderer.

import { ENV } from '../core/env.js';
import { REGION } from '../world/geo.js';
import { makeSimplex2, fbm, clamp, lerp, smoothstep, mulberry32 } from '../core/noise.js';
import { baseHeight, moisture, seaLevelTemp, WORLD_HALF, LAND_HALF } from '../world/terrain.js';
import { makeCloudNoise, sampleNoise } from './cloudnoise.js';
import { Moisture } from './moisture.js';

export const WX_N = 256;
export const TEX_ALT = 12800;
export const CLOUD_SIGMA = 0.03;       // extinction of dense cloud, 1/m (visibility of about 130 m inside)
// Seconds new cover takes to grow into full cloud: until then it is drawn as it forms, thin wisps that thicken and
// fill out, instead of finished cloud appearing where there was clear sky (the fourth channel of the B map).
export const FORM_TIME = 20;
// The ladder of scales cloud shapes are built from (renderer and density() agree on all of it).
// The base volume's tile: its four octaves are 3.2 km, 1.6 km, 800 m and 400 m across.
export const NOISE_SCALE = 12700;
// The lobe volume is read twice, at these tile sizes (octaves at 460, 230, 115, 57 m, then 34, 17, 9, 4 m),
// each time turned so its axes and its tiling line up with nothing else.
export const LOBE_SCALE = 1830, FINE_SCALE = 137;
const turn = (ax, ay, az, ang) => { const l = Math.hypot(ax, ay, az), x = ax / l, y = ay / l, z = az / l, c = Math.cos(ang), s = Math.sin(ang), t = 1 - c; return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, t * x * y - s * z, t * y * y + c, t * y * z + s * x, t * x * z + s * y, t * y * z - s * x, t * z * z + c]; };
export const LOBE_ROT = turn(0.36, 0.48, 0.8, 0.93), FINE_ROT = turn(0.7, -0.3, 0.65, 2.11);   // (columns of a rotation matrix)
export const LOBE_AMP = [0.13, 0.2], FINE_AMP = 0.17;  // how far the lobes move the surface, in units of the base noise: layer cloud .. heaps; the fine octaves against the coarse (0.6 an octave down from 460 m to 34 m is 0.15: at 0.3 the skin was a sponge seventy meters deep)
export const LOBE_WARP = 300;                            // m: the lobe lookup is bent by the base noise, so lobes are of uneven size, not packed bubbles
// Above the base noise: cloud shapes are sampled through a slowly bending domain, and their amount swells and
// thins in clusters a few kilometers across and again over tens of kilometers, from scales that share no period
// with the noise tiles: cells shear and merge instead of sitting in rows, and the tiling never shows.
export const WARP_SCALE = 23700, WARP_AMP = [500, 1700], VARY_SCALE = 61000, VARY_AMP = 1.1, MESO_AMP = 0.9;   // (the bend along x comes from a finer channel of the noise: any more of it would fold the clouds over)
export const NOISE_SQUASH = 1.0;                         // vertical scale of the base shape lookup (below 1 stretches its cells into columns; 1 keeps turrets round)
export const CLEFT = 0.55;                               // depth of the clefts between the cells on a layer's top, in units of the noise
export const TURRET = [0.3, 0.1];                        // how far a storm tower's wall is pushed out and in, as a share of its radius: by the slowest noise, by its cells
export const SCUD_CONV = 420, SCUD_LAYER = 260;          // m the cloud base hangs lower under the heaviest rain: under showers, under steady rain
export const FOG_TOP_MARGIN = 70;                        // m above a fog bank's nominal top that its rolling top can reach
// Storm cells shape their own cloud (see cellAt): beyond CELL_R0..CELL_R1 cell radii the ordinary layer takes over.
export const CELL_RMAX = 3.2, CELL_R0 = 2.6, CELL_R1 = 3.1;
const K_GEO = 1.0e5;                   // m/s of wind per hPa/m of pressure gradient
const D2R = Math.PI / 180;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Weather systems the game can stage. "local" ones are centered on the aircraft; the rest are
// laid out along a line from the aircraft toward a point about 100 km away.
export const SITUATIONS = {
  clear: { title: 'Clear', blurb: 'A cloudless sky under a strong high. Unlimited visibility, light winds.' },
  fair: { title: 'Fair-weather cumulus', blurb: 'Settled air under a high. Light winds, scattered cumulus, afternoon thermals.' },
  overcast: { title: 'Overcast', blurb: 'A flat gray stratus deck from horizon to horizon. Dull light, no rain.' },
  rain: { title: 'Rain', blurb: 'Deep nimbostratus and steady rain. Low clouds, poor visibility, wet runways.' },
  storms: { title: 'Thunderstorms', blurb: 'A cumulonimbus overhead and more on every side: heavy rain under the dark bases, lightning all around, violent up- and downdrafts.' },
  scattered: { title: 'Scattered thunderstorms', blurb: 'Isolated cumulonimbus towers standing in clear air: sunshine between them, rain, lightning and turbulence underneath.' },
  hail: { title: 'Hailstorm', blurb: 'A severe storm cell with a hail core. Stay out from under the anvil.' },
  snow: { title: 'Snow', blurb: 'A cold air mass with low overcast and steady snow. The ground is white to the sea.' },
  fog: { title: 'Fog', blurb: 'Calm and clear on top, with a fog bank lying over the airfield and the low ground.' },
  coldfront: { title: 'Cold front', blurb: 'A squall line sweeping in: a wall of cumulonimbus, heavy rain, then a sharp wind shift and colder, clearer air.' },
  warmfront: { title: 'Warm front', blurb: 'Cirrus thickening to a lowering overcast with steady rain ahead.' },
  gale: { title: 'Gale', blurb: 'A tight pressure gradient. Strong wind, wave clouds and sink in the lee of the ranges, whitecaps on the water.' },
  monsoon: { title: 'Squalls', blurb: 'Deep moist air, towering cumulus everywhere and sudden blinding downpours.' },
  blizzard: { title: 'Blizzard', blurb: 'Heavy snow driven by a gusting northerly gale, snow streaming across the ground, near whiteout and bitter cold.' },
  lakeeffect: { title: 'Lake-effect snow', blurb: 'Arctic air off open water: long narrow bands of blinding snow squalls lying along the wind, hard blue sky between them.' },
  icestorm: { title: 'Ice storm', blurb: 'Rain falling from a warm layer aloft into freezing air at the surface. Low clouds, glaze on the glass; the air is warmer three thousand feet up.' },
  derecho: { title: 'Derecho', blurb: 'A bowed squall line racing in behind a low shelf cloud: a violent wind shift, a wall of rain and lightning, then a long gray trailing shield.' },
  heat: { title: 'Hot and hazy', blurb: 'A stifling summer afternoon. Thick haze below ten thousand feet, strong thermals, and cumulus towers building through the top of it.' },
  chinook: { title: 'Chinook', blurb: 'A warm, gusting gale pouring off the mountains: a clear slot in their lee, lens clouds standing in the wave, and a sharp-edged arch of high clouds overhead.' },
  virga: { title: 'Virga', blurb: 'High-based showers over dry country: gray shafts of rain that evaporate before they reach the ground, and gusty sinking air beneath them.' },
};

// How each situation reads while it is on its way in (for a line such as "clearing, 3 min"), and the
// situations it may drift into when Weather.evolve is on.
const BECOMING = {
  clear: 'clearing', fair: 'clearing', overcast: 'clouding over', rain: 'rain moving in', storms: 'storms building', scattered: 'storms building',
  hail: 'a hailstorm building', snow: 'snow setting in', fog: 'fog forming', coldfront: 'cold front approaching', warmfront: 'warm front approaching',
  gale: 'wind rising', monsoon: 'squalls building', blizzard: 'blizzard closing in', lakeeffect: 'snow bands forming', icestorm: 'freezing rain moving in',
  derecho: 'squall line approaching', heat: 'heat building', chinook: 'chinook setting in', virga: 'high showers building',
};
export const EVOLUTION = {
  clear: ['fair', 'fair', 'fog', 'heat'], fair: ['clear', 'scattered', 'overcast', 'heat', 'virga'], overcast: ['fair', 'rain', 'warmfront'], rain: ['overcast', 'storms', 'coldfront'],
  storms: ['scattered', 'rain', 'hail'], scattered: ['fair', 'storms', 'virga'], hail: ['storms', 'scattered'], snow: ['overcast', 'blizzard', 'lakeeffect', 'icestorm'],
  fog: ['fair', 'clear', 'overcast'], coldfront: ['fair', 'gale'], warmfront: ['rain', 'overcast'], gale: ['fair', 'coldfront', 'chinook'], monsoon: ['storms', 'scattered', 'rain'],
  blizzard: ['snow', 'lakeeffect'], lakeeffect: ['snow', 'blizzard', 'overcast'], icestorm: ['rain', 'snow', 'overcast'], derecho: ['rain', 'scattered'], heat: ['scattered', 'storms', 'derecho', 'fair'],
  chinook: ['gale', 'fair', 'clear'], virga: ['scattered', 'fair'],
};
// When a situation can develop on its own (evolve): fog forms in the night and early morning, storms build from midday
// through the evening. A situation not listed can come at any hour.
const AFTERNOON = (h) => h >= 12 && h < 21;
const WHEN = { fog: (h) => h >= 20 || h < 8, heat: (h) => h >= 10 && h < 19, storms: AFTERNOON, scattered: AFTERNOON, hail: AFTERNOON, derecho: AFTERNOON, monsoon: (h) => h >= 11 };
// A low's life (p: its age as a share of its life): it deepens to its deepest a third of the way through, then fills
// (its pressure, and so its wind, falls back toward half), and as it ages its cold front wraps further round it (occludes).
const lowDepth = (p) => (p < 0.35 ? lerp(0.8, 1, smoothstep(0, 0.35, p)) : lerp(1, 0.45, smoothstep(0.35, 1, p)));
const occlusion = (p) => 0.35 * smoothstep(0.45, 1, p);
// Air-mass numbers a transition carries from the old situation to the new (haze goes the same way, as extinction).
const AIR = ['tAnom', 'humidity', 'cirrus', 'flowX', 'flowZ', 'gust', 'blowing', 'invDT', 'invH', 'invD', 'hazeCap', 'hazeTop', 'dry'];
const ease = (t) => smoothstep(0, 1, t);
// Everything that makes up a situation (what _build lays out and setup installs).
const STATE = ['lows', 'highs', 'cells', 'fogs', 'cellAreas', 'bands', 'lines', 'arches', 'layer', 'rng', 'haze', ...AIR];
const ROUTE0 = { ax: -60000, az: 30000, bx: 60000, bz: -30000 };

// Distance, in cell radii, from the axis of a storm cell's anvil, measured so that the anvil (which ends
// at 2.5) streams five radii downwind but overhangs the tower only a little upwind and to the sides:
// a round anvil would keep the whole tower in its shadow. (sx, sz: unit vector of the flow.)
function anvilDist(dx, dz, sx, sz) {
  const al = dx * sx + dz * sz, ac = dz * sx - dx * sz;
  return Math.hypot(al * (al > 0 ? 0.5 : 1.75), ac * 1.4);
}

/**
 * How much of the sky a storm cell fills at height fraction hc of its depth, rho cell radii from its axis
 * (0..1; in between, the cloud noise decides where the cloud is). A wide flat base (wider on one side than
 * another: skirt, about 1) whose flanking towers (taller here than there: tall, about 1) step up to a main
 * tower about 0.7 radii across, tapering as it rises; once the top reaches its ceiling an anvil spreads under
 * it and streams downwind (rhoA); as the cell dies the tower thins out and leaves the anvil behind.
 * Sets cellCover.anvil to how far the point belongs to the anvil rather than the tower. (GLSL twin in clouds.js.)
 */
function cellCover(rho, rhoA, hc, ph, skirt, tall) {
  const grow = smoothstep(0, 0.25, ph), fade = 1 - smoothstep(0.8, 1, ph), an = smoothstep(0.3, 0.5, ph) * (1 - smoothstep(0.93, 1, ph));
  const lw = 1 - smoothstep(0, 0.32 * tall, hc), low = lw * lw, cap = smoothstep(lerp(0.72, 0.9, an), 1, hc);
  // (Under an anvil the tower does not taper: it flares out into the sheet.)
  const taper = smoothstep(0.25, 0.85, hc) * (1 - an), flare = an * smoothstep(0.6, 0.86, hc);
  const rin = lerp(0.56 - 0.12 * taper + 0.12 * flare, 0.7 * skirt, low) * (1 - cap), rout = lerp(0.84 - 0.22 * taper + 0.26 * flare, 1.45 * skirt, low) * (1 - 0.8 * cap);
  const k = (1 - smoothstep(rin, rout, rho)) * grow * fade;
  const e = smoothstep(0.3, 2.4, rhoA), lo = 0.79 + 0.11 * e, up = 0.95 - 0.03 * e;
  const ka = an * smoothstep(lo - 0.03, lo + 0.03, hc) * (1 - smoothstep(up - 0.035, up + 0.015, hc)) * (1 - smoothstep(1.1, 2.5, rhoA));
  cellCover.anvil = clamp((ka - k) * 4, 0, 1);
  cellCover.under = 1 - smoothstep(lo + 0.01, lo + 0.07, hc);      // how far this is the anvil's underside
  return Math.max(k, ka);
}

export class Weather {
  constructor() {
    this.noise = makeCloudNoise();
    this.cu = makeSimplex2(501);
    this.rng = mulberry32(7);
    this.lows = []; this.highs = []; this.cells = []; this.fogs = [];
    this.bands = []; this.lines = []; this.arches = [];   // snow bands along the wind, squall lines, wave-cloud arches in the lee of a range
    this.layer = null;                   // optional widespread stratus deck
    this.time = 0; this.hour = 12;
    this.tAnom = 0; this.humidity = 0.5; this.haze = 60000; this.cirrus = 0.15;
    this.flowX = 4; this.flowZ = 0;
    this.gust = 0; this.blowing = 0;                     // gustiness of the air mass; snow the wind lifts off the ground (both 0..1)
    this.invDT = 0; this.invH = 1100; this.invD = 600;   // a warm layer aloft: how much warmer (deg C), the height of its middle and its half depth (m)
    this.hazeCap = 0; this.hazeTop = 3000;               // haze trapped under an inversion: how far (0..1), and where its top is (m)
    this.dry = 0;                                        // dryness of the air under the cloud (0..1): rain evaporates on the way down (virga)
    this.wet = 0; this.snowpack = 0;                     // the ground around the aircraft: wetness, and snow lying on it (0..1)
    this.trans = null;                                   // the transition under way: { from, to, seconds, t, progress, remaining }
    this.evolve = false; this.evolveEvery = 2400; this.evolveOver = 900;   // slow drift between related situations: on/off, seconds settled, seconds changing
    this.at = { x: 0, z: 0, hx: 0, hz: -1, rx: 0, rz: 0 };   // where the aircraft was last sampled, and which way it was going
    this.hemi = 0;                                       // +1 north of the equator, -1 south (read from REGION when a situation is staged)
    this.cellAreas = [];
    this.drift = { x: 0, y: 0, z: 0 };   // accumulated cloud-noise advection (m)
    this.org = { x: 0, z: 0 };           // how far the window of the world has been moved under the weather (see shift)
    this.flashes = [];
    this.kind = 'fair';

    // Coarse terrain, moisture and sea-level temperature grids (2 km).
    const N = WX_N, H = WORLD_HALF;
    this.terr = new Float32Array(N * N); this.moist = new Float32Array(N * N); this.tsea = new Float32Array(N * N);
    this.mo = new Moisture(N);           // the moisture the wind carries (moisture.js)
    this.readTerrain();
    // Wind grid (16 km) refreshed every bake, used for terrain-forced cloud.
    this.WG = 33; this.windGrid = new Float32Array(this.WG * this.WG * 2);
    this.A = new Uint8Array(N * N * 4); this.B = new Uint8Array(N * N * 4);
    this.A2 = new Uint8Array(N * N * 4); this.B2 = new Uint8Array(N * N * 4);
    this.row = 0; this.dirty = false; this.snap = false;   // (dirty: a refresh of the map is complete; snap: show it at once, see CloudRenderer.blendMaps)
    // How much of each texel's cover has been there long enough to be grown cloud (see FORM_TIME), and when each row
    // was last baked. What is more than that is cloud still forming: the renderer draws it thin and wispy.
    this.M = new Float32Array(N * N); this.rowT = new Float64Array(N); this.mature = true;
    this.col = { cov: 0, base: 0, top: 0, conv: 0, precip: 0, cirrus: 0, front: 0, cell: 0, fog: 0, cold: 0, warm: 0, cu: 0, cuBase: 1200, line: 0, lineD: 0, band: 0, rainEnd: 0 };
    this.setup('fair', null, 12);
  }

  /** Which way around the weather turns: sea-level temperature falls toward the pole, and (see _geo, fronts) air circles a low
   *  counterclockwise in the northern hemisphere, clockwise in the southern. */
  _hemisphere() {
    const hs = REGION.lat0 < 0 ? -1 : 1;
    if (hs === this.hemi) return;
    this.hemi = hs;
    this.readTerrain();
  }

  /** Read the terrain, moisture and sea-level temperature grids from the world (again whenever its window moves).
   *  The world gives a sea-level temperature that makes an ordinary day as warm at any field's elevation as its
   *  latitude makes the lowlands (world/terrain.js: seaTempAt), colder toward the pole. */
  readTerrain() {
    const N = WX_N, H = WORLD_HALF;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = ((i + 0.5) / N) * 2 * H - H, z = ((j + 0.5) / N) * 2 * H - H;
      const k = j * N + i;
      this.terr[k] = Math.max(0, baseHeight(x, z));
      this.moist[k] = moisture(x, z); this.tsea[k] = seaLevelTemp(x, z);
    }
    this.mo.readSurface();
  }

  /**
   * The window of the world has moved under the weather (the aircraft flew on and the window followed): every
   * system, cell and bank is carried dx, dz in the new world coordinates, and the cloud noise with them, so
   * the sky stays what it was. The caller reads the terrain again and bakes the maps (readTerrain, bakeAll).
   */
  shift(dx, dz) {
    const seen = new Set();
    const move = (o) => { if (o && !seen.has(o)) { seen.add(o); o.x += dx; o.z += dz; } };
    for (const list of [this.lows, this.highs, this.cells, this.fogs, this.bands, this.lines, this.arches, this.cellAreas, this.flashes]) list.forEach(move);
    for (const c of this.cells) move(c.area);
    if (this.trans) for (const b of this.trans.born) { move(b.c); move(b.c.area); }
    const a = this.at; a.x += dx; a.z += dz; a.rx += dx; a.rz += dz;
    // (the cloud still forming goes with it, to the nearest texel)
    const N = WX_N, step = (2 * WORLD_HALF) / N, di = Math.round(dx / step), dj = Math.round(dz / step), M = this.M.slice();
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const si = i - di, sj = j - dj;
      this.M[j * N + i] = si >= 0 && si < N && sj >= 0 && sj < N ? M[sj * N + si] : 1;
    }
    this.mo.shift(di, dj);
    this.org.x += dx; this.org.z += dz;
    this.drift.x -= dx; this.drift.z -= dz;             // the noise is read at position + drift
  }

  grid(g, x, z) {
    const N = WX_N, H = WORLD_HALF;
    const fx = clamp(((x + H) / (2 * H)) * N - 0.5, 0, N - 1.001), fz = clamp(((z + H) / (2 * H)) * N - 0.5, 0, N - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * N + i;
    return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + N] * (1 - u) + g[k + N + 1] * u) * v;
  }

  // ---------------------------------------------------------------- scenarios

  /** Build a weather situation around a route {ax, az, bx, bz} (or the map center), at once. */
  setup(kind, route, hour, seed = 1) {
    this.kind = kind; this.hour = hour; this.time = 0;
    this.flashes = []; this.trans = null;
    this.ctl = { cover: 1, precip: 1, wind: null, lift: this.ctl?.lift || 0 };   // live overrides from the debug panel (lift: m the cloud is raised, kept across situations)
    const d = this._stage(kind, route, seed);
    for (const k of STATE) this[k] = d[k];
    this._dwell = 0; this._dwellFor = this.evolveEvery * (0.6 + 0.8 * this.rng());
    const r = route || ROUTE0, a = this.at;
    a.x = a.rx = r.ax; a.z = a.rz = r.az;
    { const dx = r.bx - r.ax, dz = r.bz - r.az, dl = Math.hypot(dx, dz) || 1; a.hx = dx / dl; a.hz = dz / dl; }
    this.mature = true; this.bakeAll(); this.mature = false;   // (set up at once: all of it grown already)
    // The ground starts as this weather would have left it: soaked under rain, white under snow.
    const g = this.grid(this.terr, r.ax, r.az), o = this._gs || (this._gs = {});
    this._quiet = true; this.sample(r.ax, g + 2, r.az, g, o); this._quiet = false;
    this.snowpack = o.temp < 0.5 && (o.precip > 0.05 || this.blowing > 0.2) ? 1 : 0;
    this.wet = o.precip > 0.05 && o.snowMix < 0.5 ? 1 : 0;
    if (ENV.uWet) ENV.uWet.value = this.wet;
  }

  /** A situation built apart from the live weather: an object holding its systems, cells and air-mass numbers (the STATE keys). */
  _stage(kind, route, seed) {
    this._hemisphere();
    const d = Object.create(this);
    d._build(kind, route, seed);
    return d;
  }

  /**
   * Lay out one situation. Runs on a scratch object (see _stage), so nothing live is touched. The layout is written
   * for the northern hemisphere, north up: south of the equator the route is mirrored north-south on the way in and
   * everything built is mirrored back on the way out, so lows still pass on the poleward side and cold air still
   * comes from the pole.
   */
  _build(kind, route, seed) {
    const R = this.rng = mulberry32(seed * 7919 + 13), hs = this.hemi;
    this.lows = []; this.highs = []; this.cells = []; this.fogs = []; this.cellAreas = [];
    this.bands = []; this.lines = []; this.arches = [];
    this.layer = null;
    this.tAnom = 0; this.humidity = 0.5; this.haze = 120000; this.cirrus = 0.12;
    this.gust = 0; this.blowing = 0; this.invDT = 0; this.invH = 1100; this.invD = 600; this.hazeCap = 0; this.hazeTop = 3000; this.dry = 0;
    this.flowX = 3 + R() * 3; this.flowZ = (R() - 0.5) * 3;
    const r0 = route || ROUTE0, r = { ax: r0.ax, az: hs * r0.az, bx: r0.bx, bz: hs * r0.bz };
    const mx = (r.ax + r.bx) / 2, mz = (r.az + r.bz) / 2;
    const dist = Math.hypot(r.bx - r.ax, r.bz - r.az);
    const eta = dist / 72;                                       // seconds to fly the route
    const low = (x, z, amp, sig, vx, vz, fronts = true) => {
      const l = { x, z, amp, sig, vx, vz, fronts, trough: fronts ? 3 : 0, thC: -115 * D2R, thW: -12 * D2R, curlC: -0.3, curlW: -0.25, s: 1, hs: 1,
        life: 21600 + R() * 10800, p0: 0.45 };                    // (staged near its deepest, already filling: see lowDepth)
      l.age = l.p0 * l.life;
      this.lows.push(l); return l;
    };
    const high = (x, z, amp, sig, vx = 3, vz = 0) => this.highs.push({ x, z, amp, sig, vx, vz, s: 1 });
    const ux0 = (r.bx - r.ax) / (dist || 1), uz0 = (r.bz - r.az) / (dist || 1);
    // A storm cell placed by hand: `ahead` and `right` in meters from the start of the route.
    const cell = (ahead, right, rad, phase, hail = false) => {
      const c = { area: null, x: r.ax + ux0 * ahead - uz0 * right, z: r.az + uz0 * ahead + ux0 * right, r: rad, life: 4200 + R() * 1200, age: 0, vx: 0, vz: 0, flashT: 1 + R() * 4, hail, rate: 1,
        base: Math.max(820, g0 + 650) };                          // a workable gap under the base even at the high inland fields
      c.age = phase * c.life; this.cells.push(c); return c;
    };
    // A tower that builds to a few kilometers and subsides again without ever maturing into a storm.
    const tower = (ahead, right, rad, phase) => { const c = cell(ahead, right, rad, 0); c.life = 2000 + R() * 900; c.cap = 0.2; c.age = phase * c.cap * c.life; return c; };
    const area = (x, z, rad, count, cap = 0) => { const a = { x, z, r: rad, count, cap }; this.cellAreas.push(a); for (let i = 0; i < count; i++) this.spawnCell(a, R() * 0.7); };
    const terr = (x, z) => this.grid(this.terr, x, hs * z);
    const geo = (x, z) => this._geo(x, z, { x: 0, z: 0 }, 1);    // the wind the systems laid out so far would blow (this frame)

    const g0 = terr(r.ax, r.az);                                 // ground level where the weather is staged
    // Set the air mass so the staging field itself is at T degrees C (fields here stand anywhere from sea level to 2000 m).
    const surface = (T) => { this.tAnom = T - (this.grid(this.tsea, r.ax, hs * r.az) - 0.0065 * g0 + this.invDT * Math.exp(-Math.pow((g0 - this.invH) / this.invD, 2))); };
    if (kind === 'clear') {
      high(r.ax, r.az, 18, 260e3, 1, 0);
      this.humidity = 0; this.cirrus = 0.02; this.flowX = 1.5; this.flowZ = 0.5; this.haze = 160000;
    } else if (kind === 'overcast') {
      high(mx + 300e3, mz, 8, 220e3, 2, 0);
      this.humidity = 0.15; this.cirrus = 0; this.haze = 60000;
      this.layer = { cov: 1, base: g0 + 750, top: g0 + 1600, precip: 0, steady: true, seed: R() * 100 };
    } else if (kind === 'rain') {
      low(r.ax - 80e3, r.az - 260e3, -16, 190e3, 3, 0, false);
      this.humidity = 0.3; this.cirrus = 0; this.haze = 28000;
      this.layer = { cov: 1, base: g0 + 420, top: g0 + 4300, precip: 0.62, steady: true, seed: R() * 100 };
    } else if (kind === 'snow') {
      this.tAnom = -15; this.humidity = 0.2; this.haze = 55000; this.cirrus = 0;
      low(r.ax + 150e3, r.az - 240e3, -16, 170e3, 3, 0, false);
      this.layer = { cov: 0.97, base: g0 + 450, top: g0 + 2500, precip: 0.6, steady: true, seed: R() * 100 };
    } else if (kind === 'hail') {
      high(mx + 420e3, mz - 200e3, 8, 220e3);
      low(r.ax - 60e3, r.az + 40e3, -6, 200e3, 2, 0, false);
      this.humidity = 0.75; this.haze = 60000; this.tAnom = 2; this.cirrus = 0.3;
      cell(8000, 0, 9500, 0.45, true);
      cell(24000, -15000, 6500, 0.3); cell(30000, 17000, 7000, 0.55);
      area(mx, mz, Math.max(110e3, dist), 3);
    } else if (kind === 'fair') {
      high(mx + (R() - 0.5) * 80e3, mz + (R() - 0.5) * 80e3, 14, 210e3);
      low(mx - 520e3, mz - 380e3, -14, 130e3, 6, 0, false);
      this.humidity = 0.55; this.flowX = 2; this.flowZ = (R() - 0.5) * 2;
    } else if (kind === 'storms' || kind === 'scattered' || kind === 'monsoon') {
      const mon = kind === 'monsoon', sct = kind === 'scattered';
      high(mx + 420e3, mz - 200e3, 8, 220e3);
      low(mx - 60e3, mz + 40e3, -5, 200e3, 2, 0, false);         // weak thermal low
      this.humidity = mon ? 1.0 : sct ? 0.6 : 0.9; this.haze = mon ? 32000 : sct ? 70000 : 42000; this.tAnom = mon ? 3 : 5; this.cirrus = sct ? 0.15 : 0.3;
      const n = mon ? 9 : sct ? 5 : 7;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.86 * (i + R() * 0.8)) / n, side = (i % 2 ? 1 : -1) * (9e3 + R() * 34e3);
        const ux = (r.bx - r.ax) / dist, uz = (r.bz - r.az) / dist;
        area(r.ax + (r.bx - r.ax) * t - uz * side, r.az + (r.bz - r.az) * t + ux * side, 12e3, 1);
      }
      area(mx, mz, Math.max(120e3, dist), mon ? 8 : sct ? 3 : 6);
      if (sct) {
        // Isolated cells with sunshine between: the nearest stands off to one side of the field, in full view.
        cell(9000, 6500, 6500, 0.45); cell(20000, -14000, 6000, 0.32); cell(31000, 12000, 7000, 0.6); cell(-17000, -9000, 6200, 0.5);
      } else if (mon) {
        cell(10000, 2000, 7500, 0.42); cell(21000, -13000, 6000, 0.3); cell(27000, 15000, 6800, 0.6);
        this.flowX = -2; this.flowZ = -3;
      } else {
        // Storms everywhere: one big mature cell sits right over the airfield, so the flight starts under its
        // dark base in rain, with a ring of others close around and a second ring beyond filling the horizon.
        cell(1800, 900, 10500, 0.45);
        for (let i = 0; i < 6; i++) { const a = ((i + R() * 0.6) / 6) * 6.2832, d = 15500 + R() * 5000; cell(Math.cos(a) * d, Math.sin(a) * d, 6200 + R() * 2600, 0.3 + R() * 0.35); }
        for (let i = 0; i < 7; i++) { const a = ((i + R() * 0.7) / 7) * 6.2832, d = 31000 + R() * 13000; cell(Math.cos(a) * d, Math.sin(a) * d, 6000 + R() * 3200, 0.25 + R() * 0.45); }
      }
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
      this.humidity = 0.55; this.haze = 80000; this.cirrus = 0.2;
    } else if (kind === 'warmfront') {
      const sig = 125e3, vx = 6, d0 = 0.85 * sig;
      const th = -12 * D2R - 0.25 * 0.85;
      // Destination sits ~35 km ahead of the surface front under the rain shield.
      const fx = Math.cos(th), fn = Math.sin(th), ahead = 35e3;
      low(r.bx - fx * d0 + fn * ahead - vx * eta, r.bz + fn * d0 + fx * ahead + 2 * eta, -20, sig, vx, -2);
      high(r.bx + 460e3, r.bz - 80e3, 12, 200e3, 5, 0);
      this.humidity = 0.5; this.haze = 50000; this.cirrus = 0.35;
    } else if (kind === 'fog') {
      high(mx + (R() - 0.5) * 60e3, mz + (R() - 0.5) * 60e3, 16, 230e3, 1, 0);
      this.flowX = 0.8; this.flowZ = 0.4; this.humidity = 0.16; this.haze = 90000; this.cirrus = 0.08;
      // The bank sits over the start point; a second lies somewhere down the route.
      this.fogs.push({ x: r.ax, z: r.az, r: 30e3 + R() * 10e3, top: g0 + 150 + R() * 70, persist: true });
      this.fogs.push({ x: r.bx + (R() - 0.5) * 30e3, z: r.bz + (R() - 0.5) * 30e3, r: 22e3 + R() * 16e3, top: 160 + R() * 120, persist: true });
    } else if (kind === 'blizzard') {
      // A deep low passing to the east and a high building behind it: a gale straight from the pole down the gap between them,
      // heavy snow from a low deck, and loose snow streaming along the ground under it.
      low(r.ax + 300e3, r.az + 60e3, -54, 180e3, 4, 0, false);
      high(r.ax - 430e3, r.az - 80e3, 24, 210e3, 4, 0);
      surface(-15);
      this.humidity = 0.2; this.haze = 16000; this.cirrus = 0; this.gust = 0.75; this.blowing = 1;
      this.flowX = 1; this.flowZ = 4;
      this.layer = { cov: 1, base: g0 + 280, top: g0 + 3400, precip: 0.95, steady: true, seed: R() * 100 };
    } else if (kind === 'lakeeffect') {
      // Arctic air crossing open water picks up heat and moisture and lines up in bands along the wind.
      low(r.ax + 300e3, r.az - 180e3, -40, 190e3, 3, 0, false);
      high(r.ax - 300e3, r.az + 170e3, 20, 220e3, 3, 0);
      surface(-11);
      this.humidity = 0.1; this.haze = 95000; this.cirrus = 0.03; this.gust = 0.35; this.blowing = 0.45;
      this.flowX = 3; this.flowZ = 2.5;
      const w = geo(r.ax, r.az), ws = Math.hypot(w.x, w.z) || 1;
      // The field sits just inside the edge of a band: snow overhead, the clear lane a few kilometers off to one side.
      this.bands.push({ x: r.ax, z: r.az, ux: w.x / ws, uz: w.z / ws, off: 3200, spacing: 34e3, width: 9000, base: g0 + 480, top: g0 + 2700, precip: 0.9, r: 200e3, seed: R() * 50, s: 1 });
    } else if (kind === 'icestorm') {
      // Warm air riding up over a shallow wedge of freezing air: snow melts to rain in the warm layer, then falls into the cold.
      low(r.ax - 260e3, r.az + 200e3, -12, 200e3, 3, 0, false);
      high(r.ax + 300e3, r.az - 330e3, 14, 230e3, 2, 0);
      this.invDT = 14.5; this.invH = g0 + 1100; this.invD = 600;
      surface(-3);
      this.humidity = 0.25; this.haze = 9000; this.cirrus = 0; this.flowX = 1.5; this.flowZ = -1;
      this.layer = { cov: 1, base: g0 + 230, top: g0 + 2500, precip: 0.5, steady: true, seed: R() * 100 };
    } else if (kind === 'derecho') {
      // Hot, humid air ahead; the line comes out of the northwest at 25 m/s with its gust front under ten minutes from the field.
      high(mx + 500e3, mz + 250e3, 8, 240e3);
      low(r.ax - 330e3, r.az - 240e3, -12, 200e3, 4, 0, false);
      this.humidity = 0.8; this.haze = 34000; this.tAnom = 9; this.cirrus = 0.25; this.flowX = 4; this.flowZ = 1.5;
      const nx = 0.94, nz = 0.342, lead = 13e3;
      this.lines.push({ x: r.ax - nx * lead, z: r.az - nz * lead, nx, nz, speed: 25, half: 190e3, bow: 60e3, base: Math.max(700, g0 + 600), flashT: 2, seed: R() * 50, s: 1 });
    } else if (kind === 'heat') {
      // A stagnant high. The haze is trapped under an inversion; thermals punch towers through it that rise and subside all afternoon.
      high(mx + 150e3, mz + 120e3, 12, 300e3, 1, 0);
      low(mx - 480e3, mz - 300e3, -8, 180e3, 3, 0, false);
      this.humidity = 0.78; this.haze = 13000; this.tAnom = 14; this.cirrus = 0.1; this.hazeCap = 1; this.hazeTop = g0 + 2600;
      this.flowX = 1.5; this.flowZ = -1.5;
      tower(11000, 5000, 3600, 0.75); tower(19000, -9000, 4200, 0.4); tower(30000, 8000, 4600, 0.9); tower(-13000, -8000, 3800, 0.6); tower(7000, -17000, 4000, 0.2);
      area(mx, mz, Math.max(110e3, dist), 8, 0.2);
    } else if (kind === 'chinook') {
      // A strong flow square across the range. The air that sinks down the lee side warms and dries (a clear slot along
      // the foot of the mountains); it rebounds in waves marked by lens clouds, and the high cloud of the wave's first
      // crest stands as an arch with a hard upwind edge parallel to the range.
      low(r.ax + 40e3, r.az - 335e3, -64, 175e3, 4, 0, false);
      high(r.ax - 40e3, r.az + 335e3, 28, 195e3, 4, 0);
      this.humidity = 0.12; this.cirrus = 0.08; this.haze = 150000; this.gust = 0.65; this.flowX = 5; this.flowZ = 0;
      surface(13);
      const w = geo(r.ax, r.az), ws = Math.hypot(w.x, w.z) || 1, nx = w.x / ws, nz = w.z / ws;
      // The range: the highest ground within reach up- or downwind of the field (on flat country, a line upwind of it).
      let crest = g0 + 600, dc = -38e3;
      for (let d = -220e3; d <= 120e3; d += 4000) { const t = terr(r.ax + nx * d, r.az + nz * d); if (t > crest) { crest = t; dc = d; } }
      const slot = 46e3;
      this.arches.push({ x: r.ax + nx * (dc + slot), z: r.az + nz * (dc + slot), nx, nz, slot, lens: Math.max(crest + 1100, g0 + 2400), base: Math.max(crest + 2900, g0 + 5200), seed: R() * 50, s: 1 });
    } else if (kind === 'virga') {
      // Showers from a deck three kilometers up, over air so dry that the rain is gone long before the ground.
      high(mx + 380e3, mz + 150e3, 9, 240e3);
      low(mx - 300e3, mz - 200e3, -7, 200e3, 3, 0, false);
      this.humidity = 0.22; this.haze = 110000; this.tAnom = 7; this.cirrus = 0.2; this.dry = 1; this.gust = 0.3; this.flowX = 4; this.flowZ = 1;
      this.layer = { cov: 0.8, base: g0 + 3000, top: g0 + 5600, precip: 0.6, steady: false, conv: 0.5, seed: R() * 100 };
    }
    if (this.layer) { const L = this.layer; L.steady = +L.steady; L.conv = L.conv ?? 0.08; L.k = 1; }
    for (const f of this.fogs) f.s = 1;
    if (hs < 0) {
      // Back to the real map: mirror north-south. Front angles are measured counterclockwise from east, so they change sign.
      for (const l of this.lows) { l.z = -l.z; l.vz = -l.vz; l.thC = -l.thC; l.thW = -l.thW; l.curlC = -l.curlC; l.curlW = -l.curlW; l.hs = -1; }
      for (const o of [...this.highs, ...this.cells]) { o.z = -o.z; o.vz = -o.vz; }
      for (const o of [...this.fogs, ...this.cellAreas]) o.z = -o.z;
      for (const o of this.bands) { o.z = -o.z; o.uz = -o.uz; o.off = -o.off; }
      for (const o of [...this.lines, ...this.arches]) { o.z = -o.z; o.nz = -o.nz; }
      this.flowZ = -this.flowZ;
    }
  }

  /** A storm cell for area `a`, at the most humid of a few places in it (`phase`: how far through its life it starts). */
  spawnCell(a, phase = 0) {
    const R = this.rng;
    let x = a.x, z = a.z, best = -1e9;
    for (let n = 0; n < 3; n++) {
      const ang = R() * Math.PI * 2, rad = Math.sqrt(R()) * a.r, cx = a.x + Math.cos(ang) * rad, cz = a.z + Math.sin(ang) * rad, q = this.moistureAt(cx, cz);
      if (q > best) { best = q; x = cx; z = cz; }
    }
    const c = { area: a, x, z,
      r: 5200 + R() * 4200, life: 2000 + R() * 1400, age: 0, vx: 0, vz: 0, flashT: 2 + R() * 6, rate: 1 };
    if (a.cap) { c.cap = a.cap; c.r *= 0.55; phase *= a.cap / 0.7; }   // an area of towers that never mature
    c.age = phase * c.life;
    this.cells.push(c);
    return c;
  }

  // ---------------------------------------------------------------- transitions

  /**
   * Change to another situation over `seconds` of game time, staged round `route` like setup(). Nothing is cross-faded:
   * the systems and clouds that are here leave the way weather leaves, and the new ones arrive the way it arrives.
   *   pressure systems   weaken and move off downstream; the new ones deepen as they come in from upstream (a front
   *                      arrives from the side it would have come from), so the wind backs or veers round smoothly
   *   a cloud deck       lowers, lifts, thickens or thins into the new one; with no new deck it breaks into patches that
   *                      lift and shrink, its rain or snow stopping first; a new one forms in patches that join up
   *   storm cells        collapse through the dissipating stage (young ones subside); the new ones are born small once
   *                      the old have gone and build to the stage they would have been staged at
   *   fog                thins and draws in from its edges as it burns off; new fog thickens and spreads outward
   *   the air mass       temperature, humidity, haze, upper flow and the rest move steadily, so snow sets in as it cools
   * A call during a transition starts from the weather as it stands. `kind` is what the weather is becoming at once;
   * `trans` and status() report how far along it is. With seconds <= 0 this is setup() (the caller resets cloud history).
   */
  transitionTo(kind, route, seconds, seed = 1 + Math.floor(Math.random() * 1e6)) {
    if (!(seconds > 0)) { this.setup(kind, route, this.hour, seed); return; }
    const d = this._stage(kind, route, seed), R = d.rng;
    const tr = { from: this.kind, to: kind, seconds, t: 0, p: 0, progress: 0, remaining: seconds, objs: [], born: [], air: {}, hazeInv: 0 };
    // One change to one object: the fields in `to` move from what they are now, over the part a..b of the transition.
    const tw = (o, list, a, b, to, more) => {
      const from = {};
      for (const k in to) from[k] = o[k];
      o.tw = { a, b, from, to, list, ...more }; tr.objs.push(o);
    };
    // How far a system travels in or out on top of its own motion: no faster than the maps can follow without a visible step.
    const far = (dist) => Math.min(dist, 100 * seconds);
    const along = (s, fx, fz, dist) => { const v = Math.hypot(s.vx, s.vz), f = Math.hypot(fx, fz) || 1; dist = far(dist); return v > 1.5 ? [(s.vx / v) * dist, (s.vz / v) * dist] : [(fx / f) * dist, (fz / f) * dist]; };

    // What is here leaves.
    for (const l of this.lows) tw(l, this.lows, 0, 0.8, { s: 0 }, { kill: true, slide: along(l, this.flowX, this.flowZ, l.fronts ? 150e3 : 0.5 * l.sig) });
    for (const h of this.highs) tw(h, this.highs, 0, 0.8, { s: 0 }, { kill: true, slide: along(h, this.flowX, this.flowZ, 0.5 * h.sig) });
    for (const f of this.fogs) tw(f, this.fogs, 0, 0.75, { r: 0.45 * f.r, s: 0 }, { kill: true });
    for (const b of this.bands) tw(b, this.bands, 0, 0.75, { s: 0 }, { kill: true });
    for (const q of this.lines) tw(q, this.lines, 0, 0.8, { s: 0 }, { kill: true });
    for (const a of this.arches) tw(a, this.arches, 0, 0.8, { s: 0 }, { kill: true });
    for (const a of this.cellAreas) a.off = true;
    const had = this.cells.length > 0;
    for (const c of this.cells) {
      const td = seconds * (0.28 + 0.22 * R());                   // gone by half way, so the new cells never have to grow through the old
      c.out = true; c.to = null; c.cap = 0;
      c.rate = c.age < 0.3 * c.life ? -(c.age + 1) / td : Math.max(1, (c.life - c.age) / td);
    }

    // What is coming arrives.
    for (const l of d.lows) {
      const sl = along(l, d.flowX, d.flowZ, l.fronts ? 150e3 : 0.5 * l.sig);
      l.x -= sl[0] + l.vx * seconds; l.z -= sl[1] + l.vz * seconds; l.s = 0;
      if (l.life) l.age = 0.15 * l.life;                          // (a low on its way in is young, and deepens as it comes)
      this.lows.push(l); tw(l, this.lows, 0.2, 1, { s: 1 }, { slide: sl });
    }
    for (const h of d.highs) {
      const sl = along(h, d.flowX, d.flowZ, 0.5 * h.sig);
      h.x -= sl[0] + h.vx * seconds; h.z -= sl[1] + h.vz * seconds; h.s = 0;
      this.highs.push(h); tw(h, this.highs, 0.2, 1, { s: 1 }, { slide: sl });
    }
    for (const f of d.fogs) { const to = { r: f.r, s: 1 }; f.r *= 0.45; f.s = 0; this.fogs.push(f); tw(f, this.fogs, 0.25, 1, to); }
    for (const b of d.bands) { b.s = 0; this.bands.push(b); tw(b, this.bands, 0.25, 1, { s: 1 }); }
    for (const a of d.arches) { a.s = 0; this.arches.push(a); tw(a, this.arches, 0.2, 1, { s: 1 }); }
    for (const q of d.lines) {
      const sl = [q.nx * far(110e3), q.nz * far(110e3)];
      q.x -= sl[0] + q.nx * q.speed * seconds; q.z -= sl[1] + q.nz * q.speed * seconds; q.s = 0;
      this.lines.push(q); tw(q, this.lines, 0.1, 0.5, { s: 1 }, { slide: sl });
    }
    this.cellAreas.push(...d.cellAreas);
    for (const c of d.cells) {
      const tb = seconds * ((had ? 0.5 : 0.06) + 0.1 * R());
      if (c.age > 0) { c.to = c.age; c.rate = Math.max(1, c.age / (seconds - tb)); c.age = 0; }
      tr.born.push({ t: tb, c });
    }
    tr.born.sort((a, b) => a.t - b.t);
    const L0 = this.layer, L1 = d.layer;
    if (L0 && L1) tw(L0, null, 0, 1, { cov: L1.cov, base: L1.base, top: L1.top, precip: L1.precip, steady: L1.steady, conv: L1.conv, k: 1 });
    else if (L0) tw(L0, null, 0, 0.85, { k: 0 }, { kill: true });
    else if (L1) { L1.k = 0; this.layer = L1; tw(L1, null, 0.1, 1, { k: 1 }); }

    // The air mass. Heights only mean something while there is something at them, so those do not slide in from nowhere.
    const b = {};
    for (const k of AIR) b[k] = d[k];
    if (!this.invDT) { this.invH = b.invH; this.invD = b.invD; } else if (!b.invDT) { b.invH = this.invH; b.invD = this.invD; }
    if (!this.hazeCap) this.hazeTop = b.hazeTop; else if (!b.hazeCap) b.hazeTop = this.hazeTop;
    for (const k of AIR) tr.air[k] = b[k] - this[k];
    tr.hazeInv = 1 / d.haze - 1 / this.haze;

    this.kind = kind; this.rng = R; this.trans = tr;
  }

  /** Advance the transition under way. Changes are applied as increments, so the debug panel's sliders still act on top. */
  _step(dt) {
    const tr = this.trans, p0 = tr.p, p = tr.p = Math.min(1, (tr.t += dt) / tr.seconds), de = ease(p) - ease(p0);
    tr.progress = p; tr.remaining = Math.max(0, tr.seconds - tr.t);
    for (const k of AIR) this[k] += tr.air[k] * de;
    this.haze = 1 / Math.max(1 / this.haze + tr.hazeInv * de, 2.5e-6);
    for (const o of tr.objs) {
      const w = o.tw, f = ease(clamp((p - w.a) / (w.b - w.a), 0, 1));
      for (const k in w.to) o[k] = lerp(w.from[k], w.to[k], f);
      if (w.slide) { o.x += w.slide[0] * de; o.z += w.slide[1] * de; }
    }
    while (tr.born.length && tr.born[0].t <= tr.t) this.cells.push(tr.born.shift().c);
    if (p < 1) return;
    for (const o of tr.objs) {
      const w = o.tw; o.tw = null;
      if (!w.kill) continue;
      if (!w.list) { if (this.layer === o) this.layer = null; continue; }
      const i = w.list.indexOf(o);
      if (i >= 0) w.list.splice(i, 1);
    }
    this.cellAreas = this.cellAreas.filter((a) => !a.off);
    this.trans = null; this._dwell = 0; this._dwellFor = this.evolveEvery * (0.6 + 0.8 * this.rng());
  }

  /** Where the weather stands, for a line of interface text: { kind, from, progress 0..1, remaining s, verb, text }. */
  status() {
    const tr = this.trans;
    if (!tr) return { kind: this.kind, from: null, progress: 1, remaining: 0, verb: '', text: '' };
    const verb = tr.from === 'fog' && tr.to !== 'fog' && tr.p < 0.6 ? 'fog lifting' : BECOMING[tr.to] || 'changing';
    const m = tr.remaining / 60;
    return { kind: tr.to, from: tr.from, progress: tr.p, remaining: tr.remaining, verb, text: `${verb}, ${m >= 1 ? `${Math.round(m)} min` : `${Math.max(1, Math.round(tr.remaining))} s`}` };
  }

  /** With `evolve` on: after a settled spell, drift into one of the situations this one tends to turn into. */
  _drift(dt) {
    if ((this._dwell += dt) < this._dwellFor) return;
    const all = EVOLUTION[this.kind], h = this.hour, next = all && all.filter((k) => !WHEN[k] || WHEN[k](h));
    this._dwell = 0;
    if (!next || !next.length) { this._dwell = 0.8 * this._dwellFor; return; }   // (nothing it turns into comes at this hour: look again in a while)
    const a = this.at, far = 100000;
    this.transitionTo(next[Math.floor(this.rng() * next.length) % next.length], { ax: a.x, az: a.z, bx: a.x + a.hx * far, bz: a.z + a.hz * far }, this.evolveOver * (0.7 + 0.6 * this.rng()));
  }

  /**
   * The ground around the aircraft: `wet` rises under rain and while lying snow melts, and falls again at a rate set by
   * the temperature, the wind, the sun and how humid the air is (a quarter of an hour on a hot breezy afternoon, an hour or more on a
   * cold gray day or at night; frozen ground hardly dries). `snowpack` builds under snow and melts above freezing. ENV.uWet follows `wet`.
   */
  _ground(dt) {
    if ((this._gt = (this._gt || 0) + dt) < 0.5) return;
    const t = this._gt, a = this.at, g = this.grid(this.terr, a.x, a.z), o = this._gs || (this._gs = {});
    this._gt = 0;
    this._quiet = true; this.sample(a.x, g + 2, a.z, g, o); this._quiet = false;
    const rain = o.precip * (1 - o.snowMix), snow = o.precip * o.snowMix, T = o.temp, ws = Math.hypot(o.x, o.z);
    const sun = clamp(Math.sin((Math.PI * (this.hour - 6)) / 12), 0, 1) * (1 - o.overcast);
    const melt = Math.min(this.snowpack, (t / 500) * clamp((T - 0.5) / 5, 0, 1) * (1 + 1.5 * sun) + (rain * t) / 200);
    this.snowpack = clamp(this.snowpack - melt + (snow * t) / 240, 0, 1);
    let w = this.wet + (rain * t) / 30 + melt * 6;
    if (rain < 0.02 && melt <= 0) {
      const k = (1 / 4000) * clamp(0.25 + T / 16, 0.08, 2) * (1 + ws / 7) * (1 + 2.5 * sun) * (1 - 0.6 * clamp(this.humidity, 0, 1)) * (T < -1 ? 0.15 : 1);
      w -= k * t;
    }
    this.wet = clamp(w, 0, 1);
    if (ENV.uWet) ENV.uWet.value = this.wet;
  }

  /** A low ages (lowDepth, occlusion). Its depth and its cold front's curl as staged are taken as those at age p0. */
  _ageLow(l, dt) {
    if (l.amp0 == null) { l.amp0 = l.amp; l.curl0 = l.curlC; }
    l.age = Math.min(l.age + dt, l.life);
    const p = l.age / l.life;
    l.amp = (l.amp0 * lowDepth(p)) / lowDepth(l.p0);
    l.curlC = l.curl0 - l.hs * (occlusion(p) - occlusion(l.p0));
  }

  /** The moisture of the air over a point: the air mass's own and what the wind and the ground have made of it (moisture.js). */
  moistureAt(x, z) {
    return this.humidity * (0.55 + 0.75 * this.grid(this.moist, x, z)) * (this.grid(this.terr, x, z) > 1 ? 1 : 0.55) + this.mo.at(x, z);
  }

  /**
   * Storms that build on their own in the heat of the day, whatever the situation: now and then, somewhere around the
   * aircraft (8 to 53 km off) where the air is warm and humid and the sun reaches the ground, a cumulus tower climbs and
   * subsides again or, in very humid air in the afternoon, grows into a storm cell. They drift with the wind.
   */
  _convect(dt) {
    if ((this._popT = (this._popT ?? 20) - dt) > 0) return;
    const R = this.rng, heat = this.heat();
    this._popT = 30 + 20 * R();
    if (heat < 0.25) return;
    let n = 0;
    for (const c of this.cells) if (c.popup) n++;
    if (n >= 6) return;
    const a = this.at, o = this._pc || (this._pc = {});
    let best = null, score = 0;
    for (let t = 0; t < 3; t++) {
      const ang = R() * 6.283, d = 8e3 + R() * 45e3, x = a.x + Math.cos(ang) * d, z = a.z + Math.sin(ang) * d, terr = this.grid(this.terr, x, z);
      if (terr <= 1) continue;                                                       // (not over the water: it is cooler than the land by day)
      const q = this.moistureAt(x, z), T = this.grid(this.tsea, x, z) + this.tAnom - 0.0065 * terr;
      this.column(x, z, o);
      if (o.cell > 0.05 || o.line > 0.05) continue;
      const s = heat * smoothstep(0.42, 0.85, q) * smoothstep(8, 20, T) * (1 - smoothstep(0.55, 0.95, o.cov)) * (1 - o.fog);
      if (s > score) { score = s; best = { x, z, q, base: o.cuBase }; }
    }
    if (!best || R() > score) return;
    const deep = best.q > 0.62 && heat > 0.55 && R() < 0.15 + 0.6 * smoothstep(0.62, 1.0, best.q);
    const c = { area: null, popup: true, x: best.x, z: best.z, r: deep ? 4500 + R() * 3000 : 2900 + R() * 2300, life: deep ? 2600 + R() * 1200 : 1800 + R() * 900,
      age: 0, vx: 0, vz: 0, flashT: 2 + R() * 6, rate: 1, base: Math.max(820, best.base) };
    if (!deep) c.cap = 0.2;
    this.cells.push(c);
  }

  /**
   * Radiation fog. On a clear night with little wind the ground cools and the air over it, in the hollows and valleys where
   * the moist ground is, fills with fog (up to three banks around the aircraft), which thickens over the small hours and
   * burns off in the morning (fogAmount). Fog that is not the lasting kind is gone by midday; a bank far behind is dropped.
   */
  _nightFog(dt) {
    for (let i = this.fogs.length - 1; i >= 0; i--) {
      const f = this.fogs[i], h = this.hour;
      if (f.tw) continue;
      if (f.auto && f.s < 1 && (h >= 20 || h < 8.5)) f.s = Math.min(1, f.s + dt / 2400);
      if ((!f.persist && h >= 11.5 && h < 14) || (f.auto && Math.hypot(f.x - this.at.x, f.z - this.at.z) > 90e3)) this.fogs.splice(i, 1);   // (or left far behind)
    }
    if ((this._fogT = (this._fogT ?? 30) - dt) > 0) return;
    const R = this.rng, h = this.hour;
    this._fogT = 50 + 30 * R();
    if (!(h >= 21 || h < 6.5)) return;
    let n = 0;
    for (const f of this.fogs) if (f.auto) n++;
    if (n >= 3) return;
    const a = this.at, ang = R() * 6.283, d = 4e3 + R() * 36e3, x = a.x + Math.cos(ang) * d, z = a.z + Math.sin(ang) * d, terr = this.grid(this.terr, x, z);
    if (terr <= 1 || this.mo.at(x, z, this.mo.water) > 0.5) return;                // (on land)
    let around = 0;
    for (const [ox, oz] of [[6000, 0], [-6000, 0], [0, 6000], [0, -6000]]) around += this.grid(this.terr, x + ox, z + oz) / 4;
    if (terr > around - 10) return;                                                  // (a hollow: the cold air drains into it)
    const W = this.wind(x, z, terr + 10, terr, this._fw || (this._fw = { x: 0, z: 0 }));
    if (Math.hypot(W.x, W.z) > 3.5) return;
    const o = this._pc || (this._pc = {});
    this.column(x, z, o);
    if (o.cov - o.fog > 0.35) return;                                                // (under cloud the ground does not cool)
    const q = this.moistureAt(x, z);
    if (this.grid(this.moist, x, z) < 0.3 || R() > smoothstep(0.2, 0.55, q)) return;
    this.fogs.push({ x, z, r: 5000 + R() * 9000, top: terr + 90 + R() * 160, persist: false, auto: true, s: 0 });
  }

  // ---------------------------------------------------------------- dynamics

  update(dt) {
    this.time += dt; this.hour = (this.hour + dt / 3600) % 24;
    if (this.trans) this._step(dt); else if (this.evolve) this._drift(dt);
    for (const s of this.lows) { s.x += s.vx * dt; s.z += s.vz * dt; if (s.life) this._ageLow(s, dt); }
    for (const s of this.highs) { s.x += s.vx * dt; s.z += s.vz * dt; }
    for (const q of this.lines) { q.x += q.nx * q.speed * dt; q.z += q.nz * q.speed * dt; }
    const W = this._w || (this._w = { x: 0, z: 0 });
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      // A cell ages at its own rate: faster while a transition builds it up or runs it down, backward while it subsides.
      c.age += dt * c.rate;
      if (c.to != null && c.age >= c.to) { c.age = c.to; c.to = null; c.rate = 1; }
      if (c.cap && c.rate > 0 && c.age >= c.cap * c.life) c.rate = -1;       // a tower that never matures: it sinks back
      if ((c.steerT = (c.steerT || 0) - dt) <= 0) { this.wind(c.x, c.z, 3000, 0, W); c.vx = W.x * 0.7; c.vz = W.z * 0.7; c.steerT = 20; }
      c.x += c.vx * dt; c.z += c.vz * dt;
      const ph = c.age / c.life;
      if (ph >= 1 || (c.age <= 0 && c.rate < 0)) {
        // Gone, with nothing left of it to see. One that belongs to an area is replaced somewhere else in it, in a while
        // (sooner in the heat of the afternoon); one that built up on its own is gone; one placed by hand builds again
        // where it stands (from nothing: it used to reappear mature).
        if (c.out || c.area || c.popup) { this.cells.splice(i, 1); if (c.area && !c.out && !c.area.off) c.area.owed = (c.area.owed || 0) + 1; continue; }
        c.age = 0; c.rate = 1;
        continue;
      }
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
    const heat = this.heat();
    for (const a of this.cellAreas) if (a.owed > 0 && !a.off && this.rng() < (dt * (0.2 + 0.8 * heat)) / 90) { a.owed--; this.spawnCell(a, 0); }
    this._convect(dt); this._nightFog(dt);
    // Squall-line lightning along active cold fronts.
    for (const l of this.lows) {
      if (!l.fronts || l.s < 0.3) continue;
      l.flashT = (l.flashT ?? 3) - dt;
      if (l.flashT <= 0) {
        l.flashT = (1.5 + this.rng() * 5) / l.s;
        const d = l.sig * (0.5 + this.rng() * 1.5), th = l.thC + l.curlC * (d / l.sig);
        this.flashes.push({ x: l.x + Math.cos(th) * d + 4000, z: l.z - Math.sin(th) * d, y: 900 + this.rng() * 3500, ground: this.rng() < 0.45 });
      }
    }
    // Lightning along a squall line, in the stretch of it nearest the aircraft.
    for (const q of this.lines) {
      if (q.s < 0.3 || (q.flashT -= dt) > 0) continue;
      q.flashT = (0.7 + this.rng() * 2.6) / q.s;
      const tx = -q.nz, tz = q.nx, a0 = (this.at.x - q.x) * tx + (this.at.z - q.z) * tz;
      const a = clamp(a0 + (this.rng() - 0.5) * 90e3, -0.8 * q.half, 0.8 * q.half), dn = -(1200 + this.rng() * 9000) - q.bow * Math.pow(a / q.half, 2);
      this.flashes.push({ x: q.x + tx * a + q.nx * dn, z: q.z + tz * a + q.nz * dn, y: 900 + this.rng() * 3500, ground: this.rng() < 0.5 });
    }
    // Clouds drift with the mid-level flow.
    this.drift.x += this.flowX * 1.5 * dt; this.drift.z += this.flowZ * 1.5 * dt;
    this._ground(dt);
    // The maps are rebaked a few rows a frame; quicker while a short transition is under way, so each refresh is a small step.
    this.bakeSome(this.trans ? clamp(Math.round((15360 * dt) / this.trans.seconds), 6, 18) : 6);
  }

  // ---------------------------------------------------------------- pressure and wind

  /** Front geometry for a low at (x,z): fills this.fg with signed distances and envelopes. */
  fronts(l, x, z) {
    const g = this.fg || (this.fg = {});
    const dx = x - l.x, dz = z - l.z, d = Math.hypot(dx, dz), ds = d / l.sig;
    g.d = d;
    if (!l.fronts || ds > 3 || l.s <= 0) { g.eC = g.eW = g.sector = g.cold = 0; g.sC = g.sW = 1e9; return g; }
    // (South of the equator a low's fronts are the mirror image: its angles are stored mirrored, and l.hs turns the
    // warm and cold sides round with them.)
    const phi = Math.atan2(-dz, dx);
    const dc = l.hs * wrap(phi - (l.thC + l.curlC * ds)), dw = l.hs * wrap(phi - (l.thW + l.curlW * ds));
    g.sC = Math.abs(dc) < 1.57 ? d * Math.sin(dc) : Math.sign(dc) * d;
    g.sW = Math.abs(dw) < 1.57 ? d * Math.sin(dw) : Math.sign(dw) * d;
    g.eC = l.s * smoothstep(0.1, 0.38, ds) * (1 - smoothstep(2.0, 2.6, ds)) * smoothstep(1.5, 1.0, Math.abs(dc));
    g.eW = l.s * smoothstep(0.1, 0.35, ds) * (1 - smoothstep(1.3, 1.85, ds)) * smoothstep(1.5, 1.0, Math.abs(dw));
    const inSector = dc > 0 && dw < 0;
    g.sector = inSector ? l.s * smoothstep(0, 30e3, g.sC) * smoothstep(0, 30e3, -g.sW) * (1 - smoothstep(1.3, 2.0, ds)) : 0;
    g.cold = dc < 0 && dc > -2.2 ? l.s * smoothstep(0, -50e3, g.sC) * (1 - smoothstep(1.8, 2.6, ds)) * smoothstep(-2.2, -1.2, dc) : 0;
    return g;
  }

  pressure(x, z) {
    let p = 1013;
    for (const h of this.highs) { const dx = x - h.x, dz = z - h.z; p += h.s * h.amp * Math.exp(-(dx * dx + dz * dz) / (2 * h.sig * h.sig)); }
    for (const l of this.lows) {
      const dx = x - l.x, dz = z - l.z;
      p += l.s * l.amp * Math.exp(-(dx * dx + dz * dz) / (2 * l.sig * l.sig));
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
    this._geo(x, z, out);
    let wx = out.x, wz = out.z;
    if (this.ctl.wind) { wx = this.ctl.wind.x; wz = this.ctl.wind.z; }
    // Surface friction slows the wind and backs it toward low pressure (the other way round south of the equator).
    const agl = Math.max(0, y - gy);
    const f = smoothstep(0, 1100, agl);
    const sp = lerp(0.55, 1, f) * (1 + 0.45 * smoothstep(1500, 7000, y));
    const a = this.hemi * (1 - f) * 0.42, cs = Math.cos(a), sn = Math.sin(a);
    out.x = (wx * cs + wz * sn) * sp; out.z = (-wx * sn + wz * cs) * sp;
    if (this.ctl.wind) return out;
    // The sea breeze: on a sunny afternoon with little wind of its own, the low air near big water blows in off it,
    // strongest at the shore and dying out some 40 km inland, where it meets the land's air (and lifts it: moisture.js).
    const heat = agl < 1200 ? this.heat() : 0;
    if (heat > 0) {
      const sh = this.mo.shoreAt(x, z);
      if (sh) {
        const v = 4.5 * heat * (1 - smoothstep(5, 12, Math.hypot(wx, wz))) * Math.exp(-Math.pow((sh.d - 3000) / 22e3, 2)) * (1 - smoothstep(400, 1200, agl));
        out.x += sh.nx * v; out.z += sh.nz * v;
      }
    }
    // A squall line's own wind: a light draw in toward it ahead, and behind its gust front the cold outflow, about as fast as
    // the line itself moves, strongest in the lowest kilometer and dying away under the trailing rain.
    for (const q of this.lines) {
      const e = this.lineAt(q, x, z);
      if (e <= 0.001) continue;
      const d = this._ld, v = e * (1 - smoothstep(1500, 5000, agl)) * lerp(0.75, 1, smoothstep(0, 150, agl))
        * (q.speed * 0.95 * smoothstep(900, -1500, d) * (0.3 + 0.7 * smoothstep(-150e3, -25e3, d)) - 6 * smoothstep(-300, 900, d) * Math.exp(-Math.max(d, 0) / 25e3));
      out.x += q.nx * v; out.z += q.nz * v;
    }
    return out;
  }

  /** Wind along the isobars, low pressure on the left north of the equator and on the right south of it, plus the upper flow. */
  _geo(x, z, out, hs = this.hemi) {
    const h = 4000;
    const px = (this.pressure(x + h, z) - this.pressure(x - h, z)) / (2 * h);
    const pz = (this.pressure(x, z + h) - this.pressure(x, z - h)) / (2 * h);
    out.x = hs * K_GEO * pz + this.flowX; out.z = -hs * K_GEO * px + this.flowZ;
    return out;
  }

  /** How strongly a squall line bears on a point (0..1, tapering to its ends); leaves in _ld the distance ahead of its
   *  gust front (m, negative behind). The line is bowed: its middle runs ahead of its ends. */
  lineAt(q, x, z) {
    const dx = x - q.x, dz = z - q.z, a = dz * q.nx - dx * q.nz;
    if (a > q.half || a < -q.half) return 0;
    const d = this._ld = dx * q.nx + dz * q.nz + q.bow * (a / q.half) * (a / q.half);
    if (d > 130e3 || d < -190e3) return 0;
    return q.s * (1 - smoothstep(0.75 * q.half, q.half, Math.abs(a)));
  }

  // ---------------------------------------------------------------- cloud column

  /** Cloud layer over a point: coverage, base/top (m ASL), convective fraction, precipitation. */
  column(x, z, out = this.col) {
    let keep = 1, wb = 0, wt = 0, wc = 0, ws = 0, precip = 0, cirrus = this.cirrus * 0.6, front = 0, cellS = 0, fogS = 0, cold = 0, warm = 0, lineS = 0, lineD = 0, bandS = 0;
    const add = (cov, base, top, conv, pr) => {
      if (cov <= 0.003) return;
      cov = Math.min(cov, 1);
      keep *= 1 - cov; ws += cov; wb += base * cov; wt += top * cov; wc += conv * cov;
      if (pr > precip) precip = pr;
    };
    const terr = this.grid(this.terr, x, z), moist = this.grid(this.moist, x, z);
    const hr = this.hour, diurnal = 0.3 + 0.7 * clamp(Math.sin((Math.PI * (hr - 8)) / 12), 0, 1);
    const n = fbm(this.cu, (x + this.drift.x * 0.5) / 46e3, (z + this.drift.z * 0.5) / 46e3, 2);
    const n2 = this.cu((x - this.org.x) / 17e3 + 40, (z - this.org.z) / 17e3 - 9);

    const sub = this.subsidence(x, z);

    // Fair-weather cumulus field, deeper where the air is humid: the air mass's own moisture, and what the wind has
    // brought or the ground has done to it (moisture.js).
    const wet = this.mo.at(x, z), eq = this.humidity * (0.55 + 0.75 * moist) * (terr > 1 ? 1 : 0.55), hum = Math.max(0, eq + wet);
    const humA = clamp(this.humidity + 0.6 * wet, 0, 1);                 // (the air mass's humidity as the wind has changed it)
    let cu = smoothstep(-0.15, 0.55, n) * Math.min(hum, 1.1) * diurnal * (1 - 0.45 * sub) * 0.9;
    const cuBase = 950 + 1250 * (1 - moist) + 150 * smoothstep(0, 2, this.tAnom) + 0.5 * terr;   // bases sit higher over the inland basins
    out.cu = cu; out.cuBase = cuBase;
    let cuTop = cuBase + 500 + 2300 * humA * humA * smoothstep(-0.2, 0.7, n2 + n * 0.5) * diurnal;

    for (const l of this.lows) {
      const g = this.fronts(l, x, z);
      const core = l.s * Math.exp(-(g.d * g.d) / (2 * 0.09 * l.sig * l.sig)) * (l.fronts ? 1 : 0.5) * Math.min(1, -l.amp / 18);
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
      const cb = this.cellBase(c);                                    // hand-placed cells sit clear of the local ground
      add(cov, cb, cb + 2980 + 7600 * smoothstep(0, 0.42, ph), 1, mature * (1 - smoothstep(0.3 * c.r, 0.95 * c.r, d)));
      cellS = Math.max(cellS, cov);
      const ax = dx - c.vx * 90, az = dz - c.vz * 90;                // anvil streams downwind
      cirrus = Math.max(cirrus, mature * (1 - smoothstep(c.r, 3.3 * c.r, Math.hypot(ax, az))) * 0.85);
    }

    // Squall lines. Ahead of the gust front the shelf: a low wedge of cloud running out under the anvil. Then the wall
    // of towers and the heaviest rain, and behind that a wide, flat shield of trailing cloud with lighter rain.
    for (const q of this.lines) {
      const e = this.lineAt(q, x, z);
      if (e <= 0.002) continue;
      const d = this._ld, lump = 0.72 + 0.28 * this.cu(((z - q.z) * q.nx - (x - q.x) * q.nz) / 9000, q.seed);
      const wall = e * smoothstep(6500, 3000, d) * smoothstep(-22e3, -12e3, d), shelf = smoothstep(-2500, 3500, d);
      const lb = q.base - 300 * smoothstep(-1500, 1500, d);
      add(wall, lb, lerp(9800 + 2800 * lump, lb + 900, shelf), lerp(1, 0.25, smoothstep(0, 3000, d)), e * smoothstep(400, -2200, d) * smoothstep(-17e3, -9e3, d) * (0.82 + 0.18 * lump));
      add(e * 0.96 * smoothstep(-150e3, -85e3, d) * smoothstep(-9e3, -18e3, d), 2400, 8600, 0.08, e * 0.4 * smoothstep(-95e3, -40e3, d) * smoothstep(-12e3, -19e3, d));
      cirrus = Math.max(cirrus, e * 0.9 * smoothstep(80e3, 15e3, d) * smoothstep(-185e3, -120e3, d));
      if (e > lineS) { lineS = e; lineD = d; }
    }

    // Snow bands: rows of shallow, heavy showers lying along the wind, a clear lane between each and the next.
    for (const b of this.bands) {
      const dx = x - b.x, dz = z - b.z, rr = Math.hypot(dx, dz);
      if (rr > b.r || b.s <= 0.002) continue;
      const al = dx * b.ux + dz * b.uz, cr = dz * b.ux - dx * b.uz + b.off;
      const ph = (cr + b.spacing * 0.2 * this.cu((al - this.drift.x * b.ux - this.drift.z * b.uz) / 42e3 + b.seed, cr / 120e3)) / b.spacing, row = Math.round(ph);
      const dl = Math.abs(ph - row) * b.spacing, e = b.s * (1 - smoothstep(0.7 * b.r, b.r, rr));
      const lump = smoothstep(-0.45, 0.45, this.cu((al - this.drift.x * b.ux - this.drift.z * b.uz) / 7500, row * 7.3 + b.seed));
      const cov = e * (1 - smoothstep(0.45 * b.width, b.width, dl));
      add(cov, b.base, b.base + (b.top - b.base) * (0.55 + 0.45 * lump), 0.85, e * b.precip * (1 - smoothstep(0.2 * b.width, 0.62 * b.width, dl)) * (0.5 + 0.5 * lump));
      bandS = Math.max(bandS, cov);
    }

    // Air brought to saturation: where it is forced up a windward slope, has crossed a lake under cold air, or rises at
    // the sea-breeze front, it holds more than the air mass does, and makes cloud of its own that drifts on with the wind
    // and dissolves as it dries (moisture.js); the lee slopes and the air under a high are dry, and the cumulus thin there.
    // (In the lee of a range under a chinook the air is sinking and dry: no cloud forms on the foothills there.)
    let lee = 0;
    for (const A of this.arches) { const d = (x - A.x) * A.nx + (z - A.z) * A.nz; lee = Math.max(lee, A.s * smoothstep(-A.slot - 6000, -A.slot + 6000, d) * (1 - smoothstep(120e3, 200e3, d))); }
    const sat = (1 - lee) * smoothstep(0.12, 0.5, wet) * smoothstep(0.62, 0.98, hum);
    if (sat > 0.003) {
      const chill = smoothstep(2, -10, this.grid(this.tsea, x, z) + this.tAnom);   // over-water air this cold makes towering lake-effect showers
      // (over the lowlands a line of cumulus at the usual base; on the mountains a cap down over the summits)
      const lift = smoothstep(0.3, 0.9, wet), hill = smoothstep(300, 1200, terr), top = Math.max(terr, 0) + 1300 + (1100 + 1700 * chill) * lift;
      add(sat * (0.75 + 0.25 * moist), Math.max(650, lerp(cuBase, terr * 0.55, hill)), top, clamp(lerp(0.55, 0.3, hill) + 0.45 * chill * lift, 0, 1), smoothstep(0.95, 1.3, hum) * (0.35 + 0.35 * chill));
    }

    // The lee of a range in a strong flow: the sinking air leaves a clear slot along the foot of the mountains, lens
    // clouds stand in the crests of the wave downwind, and beyond the slot the high cloud begins at a hard edge (the arch).
    for (const A of this.arches) {
      if (A.s <= 0.002) continue;
      const dx = x - A.x, dz = z - A.z, ac = dz * A.nx - dx * A.nz;
      const d = dx * A.nx + dz * A.nz + 3500 * this.cu(ac / 45e3, A.seed), e = A.s * (1 - smoothstep(260e3, 340e3, Math.abs(ac)));
      cu *= 1 - e * smoothstep(-A.slot - 12e3, -A.slot + 4000, d) * (1 - smoothstep(60e3, 140e3, d));
      const sheet = e * smoothstep(0, 4500, d) * (1 - smoothstep(170e3, 260e3, d));
      add(sheet * 0.97, A.base + 300 * n2, A.base + 700 + 300 * n2, 0, 0);
      cirrus = Math.max(cirrus, sheet * 0.5);
      for (let k = 0; k < 3; k++) {
        // one row of lenses per wave crest: two in the slot, one out past the end of the arch
        const dr = d + A.slot - (k === 0 ? 13e3 : k === 1 ? 27e3 : A.slot + 285e3), row = Math.round(ac / 36e3), j = this.cu(row * 3.7 + k * 11, A.seed);
        const q = Math.hypot(dr / 5200, (ac - (row + 0.3 * j) * 36e3) / (9500 + 2500 * j));
        if (q < 1) add(e * (1 - smoothstep(0.72, 1, q)), A.lens + 450 * k + 300 * j, A.lens + 450 * k + 300 * j + 650, 0, 0);
      }
    }

    add(cu, cuBase, cuTop, 0.55 + 0.4 * this.humidity * smoothstep(1500, 3000, cuTop - cuBase), cu > 0.3 ? (cu - 0.3) * 1.2 * smoothstep(0.2, 0.7, n2) * smoothstep(0.8, 0.9, this.humidity) : 0);

    const L = this.layer;
    if (L && L.k > 0.001) {
      const br = 0.72 + 0.28 * smoothstep(-0.5, 0.3, this.cu((x - this.org.x) / 60e3 + L.seed, (z - this.org.z) / 60e3));
      const showers = smoothstep(0.1, 0.65, n2 + 0.25 * n);
      // k < 1: the deck is forming or breaking up. It is in patches (the first to form are the last to go), which spread
      // and join as it thickens; while it is broken it sits higher, shallower and lumpier, and nothing falls from it.
      const k = L.k, th = 1.3 - 1.6 * k, patch = k >= 1 ? 1 : smoothstep(th - 0.15, th + 0.15, 0.5 + 0.38 * n + 0.2 * n2), lift = 420 * (1 - k);
      add(L.cov * lerp(br, 0.9 + 0.1 * br, L.steady) * patch, L.base + 250 * n + lift, L.top + 400 * n + lift - (L.top - L.base) * 0.5 * (1 - k), lerp(0.4, L.conv, k),
        L.precip * lerp(showers, 0.7 + 0.3 * showers, L.steady) * smoothstep(0.5, 0.95, k));
    }

    for (const f of this.fogs) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d > f.r * 1.3) continue;
      const burn = this.fogAmount(f);
      const s = burn * (1 - smoothstep(0.65 * f.r, f.r * (1.05 + 0.2 * n2), d));
      if (s > 0.01 && terr < f.top) {
        // Fog hugs the surface: it wins the blend outright where present.
        const k = s * s; keep *= 1 - s; ws = ws * (1 - k) + s; wb = wb * (1 - k); wt = wt * (1 - k) + (f.top + 40 * n2) * s; wc *= 1 - k;
        fogS = Math.max(fogS, s);
      }
    }

    const cov = clamp((1 - keep) * this.ctl.cover, 0, 1);
    out.cov = cov;
    if (ws > 0.001) { out.base = wb / ws; out.top = Math.max(wt / ws, out.base + 120); out.conv = clamp(wc / ws, 0, 1); }
    else { out.base = 1200; out.top = 2000; out.conv = 0.5; }
    // The debug panel's cloud height: every cloud raised or lowered (not the fog, which lies on the ground).
    const lift = this.ctl.lift * (1 - fogS);
    if (lift) { out.base = Math.max(out.base + lift, 30); out.top = Math.max(out.top + lift, out.base + 120); out.cuBase = Math.max(out.cuBase + lift, 30); }
    out.precip = clamp(precip * this.ctl.precip, 0, 1) * smoothstep(0.05, 0.4, cov);
    out.cirrus = clamp(cirrus, 0, 1);
    out.front = front; out.cell = cellS; out.fog = fogS; out.cold = cold; out.warm = warm;
    out.line = lineS; out.lineD = lineD; out.band = bandS;
    // Where the rain ends. Over dry air it evaporates as it falls, sooner the lighter it is (virga: precipitation aloft and
    // none at the surface); otherwise, and always in the ordinary situations, it reaches the ground.
    out.rainEnd = this.dry > 0.001 ? Math.max(terr, out.base - (500 + 1800 * out.precip) / this.dry) : terr;
    return out;
  }

  /** The wind that carries the weather along (m/s at 1500 m, from the wind grid refreshed every bake). */
  steer(x, z, out) {
    const G = this.WG, H = WORLD_HALF;
    const fx = clamp(((x + H) / (2 * H)) * (G - 1), 0, G - 1.001), fz = clamp(((z + H) / (2 * H)) * (G - 1), 0, G - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = (j * G + i) * 2, g = this.windGrid;
    out.x = (g[k] * (1 - u) + g[k + 2] * u) * (1 - v) + (g[k + G * 2] * (1 - u) + g[k + G * 2 + 2] * u) * v;
    out.z = (g[k + 1] * (1 - u) + g[k + 3] * u) * (1 - v) + (g[k + G * 2 + 1] * (1 - u) + g[k + G * 2 + 3] * u) * v;
    return out;
  }
  /** How much the air over a point is sinking under the highs (0..1). */
  subsidence(x, z) {
    let sub = 0;
    for (const h of this.highs) { const dx = x - h.x, dz = z - h.z; sub += h.s * Math.exp(-(dx * dx + dz * dz) / (2 * h.sig * h.sig)); }
    return Math.min(sub, 1);
  }
  /** The afternoon's heating of the ground (0..1): nothing before 9, most at 15, nothing after 21. */
  heat() { return clamp(Math.sin((Math.PI * (this.hour - 9)) / 12), 0, 1); }
  /** Vertical air speed forced at the surface by wind (wx, wz) blowing over sloping terrain. */
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
      const grow = this.mature ? 1 : 1 - Math.exp(-Math.max(this.time - this.rowT[j], 0) / FORM_TIME);
      this.rowT[j] = this.time;
      this.mo.stepRow(this, j, this.time);
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 * H - H, o = (j * N + i) * 4, k = j * N + i;
        this.column(x, z, c);
        // Cover that has just come is forming; it grows into cloud over FORM_TIME. Cover that goes, goes at once.
        const m = this.M[k] = c.cov <= this.M[k] ? c.cov : this.M[k] + (c.cov - this.M[k]) * grow;
        this.B2[o + 3] = c.cov > 0.002 ? clamp((c.cov - m) / Math.max(c.cov, 0.15), 0, 1) * 255 : 0;
        this.A2[o] = c.cov * 255; this.A2[o + 1] = c.conv * 255; this.A2[o + 2] = c.precip * 255; this.A2[o + 3] = c.cirrus * 255;
        this.B2[o] = clamp(c.base / TEX_ALT, 0, 1) * 255; this.B2[o + 1] = clamp(c.top / TEX_ALT, 0, 1) * 255;
        this.B2[o + 2] = clamp(c.rainEnd / TEX_ALT, 0, 1) * 255;             // height at which the rain ends (the ground, unless it is virga)
      }
    }
    if (this.row >= N) {
      this.A.set(this.A2); this.B.set(this.B2); this.mo.swap();
      this.row = 0; this.dirty = true; this.refreshWindGrid();
    }
  }
  bakeSome(rows) { this.bakeRows(rows); }
  /** Bake the whole map now; the renderer shows it at once instead of blending toward it (snap). */
  bakeAll() { this.refreshWindGrid(); if (this.mature) this.mo.spinUp(this); this.row = 0; this.bakeRows(WX_N); this.snap = true; }

  // ---------------------------------------------------------------- point sample for the flight model

  /**
   * The storm cell that shapes the cloud over a point. The weather map knows a cell only as a disk of
   * full cover two kilometers to the texel, which on its own makes a featureless cylinder; with this
   * the cloud code builds a tower, shoulders and an anvil instead (see cellCover).
   *   rho   distance from the nearest cell's axis, in cell radii     rhoA  the same for its anvil, which
   *   ph    that cell's age as a fraction of its life                      lies downwind, drawn out along the flow
   *   base  its cloud base (m)
   * The renderer reads the same four numbers from a map baked by bakeCells().
   */
  cellAt(x, z, o = this._cell || (this._cell = {})) {
    const fl = Math.hypot(this.flowX, this.flowZ), sx = fl > 0.2 ? this.flowX / fl : 1, sz = fl > 0.2 ? this.flowZ / fl : 0;
    let rho = CELL_RMAX, rhoA = CELL_RMAX, best = CELL_RMAX, ph = 0, base = 820;
    for (const c of this.cells) {
      const dx = (x - c.x) / c.r, dz = (z - c.z) / c.r;
      if (dx > 7 || dx < -7 || dz > 7 || dz < -7) continue;
      const d = Math.hypot(dx, dz), da = anvilDist(dx, dz, sx, sz), m = Math.min(d, da);
      if (d < rho) rho = d;
      if (da < rhoA) rhoA = da;
      if (m < best) { best = m; ph = c.age / c.life; base = this.cellBase(c); }
    }
    o.rho = rho; o.rhoA = rhoA; o.ph = ph; o.base = base;
    return o;
  }

  /** The height of a storm cell's base (m), with the debug panel's cloud height. */
  cellBase(c) { return Math.max((c.base || 820) + (this.ctl?.lift || 0), 30); }

  /** cellAt() over the weather map's grid, for the renderer: rho, rhoA, ph, base / TEX_ALT in each texel of `out`. */
  bakeCells(out) {
    const N = WX_N, H = WORLD_HALF, step = (2 * H) / N;
    const best = this._cellBest || (this._cellBest = new Float32Array(N * N));
    best.fill(CELL_RMAX);
    for (let o = 0; o < out.length; o += 4) { out[o] = out[o + 1] = CELL_RMAX; out[o + 2] = 0; out[o + 3] = 820 / TEX_ALT; }
    const fl = Math.hypot(this.flowX, this.flowZ), sx = fl > 0.2 ? this.flowX / fl : 1, sz = fl > 0.2 ? this.flowZ / fl : 0;
    for (const c of this.cells) {
      const R = c.r * 6.8, ph = c.age / c.life, base = this.cellBase(c) / TEX_ALT;
      const i0 = Math.max(0, Math.floor((c.x - R + H) / step - 0.5)), i1 = Math.min(N - 1, Math.ceil((c.x + R + H) / step - 0.5));
      const j0 = Math.max(0, Math.floor((c.z - R + H) / step - 0.5)), j1 = Math.min(N - 1, Math.ceil((c.z + R + H) / step - 0.5));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = ((i + 0.5) * step - H - c.x) / c.r, dz = ((j + 0.5) * step - H - c.z) / c.r;
        const d = Math.hypot(dx, dz), da = anvilDist(dx, dz, sx, sz), m = Math.min(d, da), k = j * N + i, o = k * 4;
        if (d < out[o]) out[o] = d;
        if (da < out[o + 1]) out[o + 1] = da;
        if (m < best[k]) { best[k] = m; out[o + 2] = ph; out[o + 3] = base; }
      }
    }
    this._cellMap = out;
    return out;
  }

  /**
   * The layer over a point as the renderer reads it: the baked weather maps (8 bits a channel, two kilometers
   * to the texel, bilinearly filtered), not column() itself. density() takes its layer from here, so that
   * "in cloud" is decided from exactly what is drawn.
   */
  mapColumn(x, z, o = this._mc || (this._mc = {})) {
    const N = WX_N, H = WORLD_HALF, A = this.A, B = this.B;
    const fx = clamp(((x + H) / (2 * H)) * N - 0.5, 0, N - 1.001), fz = clamp(((z + H) / (2 * H)) * N - 0.5, 0, N - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = (j * N + i) * 4, k2 = k + N * 4;
    const w00 = (1 - u) * (1 - v) / 255, w10 = u * (1 - v) / 255, w01 = (1 - u) * v / 255, w11 = u * v / 255;
    o.cov = A[k] * w00 + A[k + 4] * w10 + A[k2] * w01 + A[k2 + 4] * w11;
    o.conv = A[k + 1] * w00 + A[k + 5] * w10 + A[k2 + 1] * w01 + A[k2 + 5] * w11;
    o.precip = A[k + 2] * w00 + A[k + 6] * w10 + A[k2 + 2] * w01 + A[k2 + 6] * w11;
    o.base = (B[k] * w00 + B[k + 4] * w10 + B[k2] * w01 + B[k2 + 4] * w11) * TEX_ALT;
    o.top = (B[k + 1] * w00 + B[k + 5] * w10 + B[k2 + 1] * w01 + B[k2 + 5] * w11) * TEX_ALT;
    o.fresh = B[k + 3] * w00 + B[k + 7] * w10 + B[k2 + 3] * w01 + B[k2 + 7] * w11;
    return o;
  }
  /** cellAt() as the renderer reads it: from the map bakeCells() last filled, once there is one. */
  mapCell(x, z, o = this._cell || (this._cell = {})) {
    const M = this._cellMap;
    if (!M) return this.cellAt(x, z, o);
    const N = WX_N, H = WORLD_HALF;
    const fx = clamp(((x + H) / (2 * H)) * N - 0.5, 0, N - 1.001), fz = clamp(((z + H) / (2 * H)) * N - 0.5, 0, N - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = (j * N + i) * 4, k2 = k + N * 4;
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    o.rho = M[k] * w00 + M[k + 4] * w10 + M[k2] * w01 + M[k2 + 4] * w11;
    o.rhoA = M[k + 1] * w00 + M[k + 5] * w10 + M[k2 + 1] * w01 + M[k2 + 5] * w11;
    o.ph = M[k + 2] * w00 + M[k + 6] * w10 + M[k2 + 2] * w01 + M[k2 + 6] * w11;
    o.base = (M[k + 3] * w00 + M[k + 7] * w10 + M[k2 + 3] * w01 + M[k2 + 7] * w11) * TEX_ALT;
    return o;
  }

  /**
   * The direction cloud is combed out along (fibers of an anvil, rolls on the top of a layer): the flow as it
   * was when this weather was set up. It is held, not followed: these patterns are laid out along it across the
   * whole map, so turning it by a degree would slide cloud a hundred kilometers away by kilometers.
   */
  grain() {
    const g = this._grain || (this._grain = { x: 1, z: 0, rng: null });
    if (g.rng !== this.rng) {
      const fl = Math.hypot(this.flowX, this.flowZ);
      g.x = fl > 0.2 ? this.flowX / fl : 1; g.z = fl > 0.2 ? this.flowZ / fl : 0; g.rng = this.rng;
    }
    return g;
  }

  /** How much of a fog bank there is at this hour (1: all of it; radiation fog that does not persist burns off through the morning). */
  /** How much of a fog bank is there (0..1): f.s is a bank forming (in the night, or in a transition) or going, and fog that
   *  is not the lasting kind burns off in the morning sun. */
  fogAmount(f) { const h = this.hour; return (f.s ?? 1) * (f.persist || h < 8.5 || h >= 14 ? 1 : 1 - smoothstep(8.5, 11.5, h)); }

  /**
   * The fog over a point, from the banks' own outlines: how far inside a bank it is (fog, 0..1), the bank's top (ftop, m),
   * and how far the weather map's layer here is only the map's stand-in for the fog (sup), which density() then
   * leaves out. (GLSL twin in getSite(), clouds.js.)
   */
  fogAt(x, z, o = this._fog || (this._fog = {})) {
    let fog = 0, fw = 0, ft = 0, sup = 0;
    for (const f of this.fogs) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d > 1.3 * f.r + 6000) continue;
      const amt = this.fogAmount(f), a = amt * (1 - smoothstep(0.65 * f.r, 1.12 * f.r, d));
      if (a > fog) fog = a;
      fw += a; ft += a * f.top;
      sup = Math.max(sup, Math.min(amt * 4, 1) * (1 - smoothstep(1.3 * f.r + 3000, 1.3 * f.r + 6000, d)));
    }
    o.fog = fog; o.ftop = fw > 0 ? ft / fw : -1e9; o.sup = sup;
    return o;
  }

  /**
   * Extinction (1/m) of the fog at a point inside a bank (F: fogAt() there): thick everywhere under a gently rolling,
   * wispy top, in denser and thinner patches (visibility from about 150 m to 400 m). Twin of fogDensity() in clouds.js.
   */
  fogDensity(x, y, z, F, warpX, warpZ, vary) {
    const dy = F.ftop - y;
    if (F.fog < 0.02 || dy < -FOG_TOP_MARGIN) return 0;
    const N = this.noise, D = this.drift, S = NOISE_SCALE / 2, qx = x + warpX, qz = z + warpZ;
    const u = (qx + D.x) / S, v = (y * 4) / S, w = (qz + D.z) / S;
    const nr = sampleNoise(N, u, v, w, 0), na = sampleNoise(N, u, v, w, 3);
    let d = Math.min((dy + (nr - 0.5) * 90 + vary * 50) / 45, (na * 0.6 + nr * 0.4 - 1 + 1.35 * F.fog) / 0.12);
    if (d <= 0) return 0;
    if (d < 1.6) {
      const R = LOBE_ROT, px = qx + D.x, py = y * 1.5, pz = qz + D.z, L = N.detail;
      const lu = (R[0] * px + R[3] * py + R[6] * pz) / LOBE_SCALE, lv = (R[1] * px + R[4] * py + R[7] * pz) / LOBE_SCALE, lw = (R[2] * px + R[5] * py + R[8] * pz) / LOBE_SCALE;
      const wi = lerp(sampleNoise(L, lu, lv, lw, 2), sampleNoise(L, lu, lv, lw, 3), 0.4);
      d += 0.9 * (wi * wi - 1 / 3);
    }
    return clamp(d, 0, 1) * (0.37 + 0.63 * smoothstep(0.15, 0.8, sampleNoise(N, u, v, w, 1))) * CLOUD_SIGMA * 0.87;
  }

  /**
   * Cloud extinction (1/m) at a point; mirrors cloudDensity() in clouds.js (its shape and its lobes down
   * to 60 m, with the average of the finer detail only the renderer resolves).
   * The layer and the storm cell over the point are read as the renderer reads them, from the baked maps
   * (see mapColumn); c, the column over the point from column(), is not needed for that and is ignored.
   */
  density(x, y, z, c) {
    c = this.mapColumn(x, z);
    const F = this.fogs.length ? this.fogAt(x, z) : null;
    this.fogDens = 0;
    if (F && F.sup > 0) c.cov *= 1 - F.sup;                      // (the map's stand-in for a fog bank: the bank itself is drawn by fogDensity)
    const inF = F && F.fog >= 0.02 && y < F.ftop + FOG_TOP_MARGIN;
    const cell = this.mapCell(x, z);
    const cw = 1 - smoothstep(CELL_R0, CELL_R1, Math.min(cell.rho, cell.rhoA));
    if (c.cov < 0.01 && cw <= 0.001 && !inF) return 0;
    // Under rain the base hangs lower: in ragged scud under a shower, in shreds of fractus under steady rain.
    const drop = c.precip * lerp(SCUD_LAYER, SCUD_CONV, c.conv);
    const wb = c.base - drop, thick = Math.max(c.top - wb, 1), h = (y - wb) / thick;
    const cwb = cell.base - drop, cthick = Math.max(cell.base + 2980 + 7600 * smoothstep(0, 0.42, cell.ph) - cwb, 1), hc = (y - cwb) / cthick;
    const inG = c.cov > 0.01 && h > 0 && h < 1, inC = cw > 0.001 && hc > 0 && hc < 1;
    if (!inG && !inC && !inF) return 0;
    const N = this.noise, D = this.drift;
    // The bent sampling domain, how far this patch of cloud has aged, clustering, and the slow swell in cloud amount.
    const wu = (x + D.x) / WARP_SCALE, wv = y / WARP_SCALE, ww = (z + D.z) / WARP_SCALE;
    const warpX = (sampleNoise(N, wu, wv, ww, 2) - 0.5) * WARP_AMP[0], warpZ = (sampleNoise(N, wu, wv, ww, 3) - 0.5) * WARP_AMP[1];
    const aged = sampleNoise(N, wu, wv, ww, 1), meso = sampleNoise(N, wu, wv, ww, 0);
    const vu = (x + D.x) / VARY_SCALE, vv = (z + D.z) / VARY_SCALE, vw = y / VARY_SCALE;
    const vary = (sampleNoise(N, vu, vv, vw, 3) - 0.5) * 0.6 + (sampleNoise(N, vu, vv, vw, 0) - 0.5) * 0.4, rough = sampleNoise(N, vu, vv, vw, 1);
    if (inF) this.fogDens = this.fogDensity(x, y, z, F, warpX, warpZ, vary);
    if (!inG && !inC) return this.fogDens;
    return this.fogDens + this.layerDensity(x, y, z, c, cell, cw, h, hc, thick, cthick, drop, inG, inC, warpX, warpZ, aged, meso, vary, rough);
  }

  /** The cloud of the layer and of the storm cell at a point: twin of layerDensity() in clouds.js. (Arguments: what density() worked out.) */
  layerDensity(x, y, z, c, cell, cw, h, hc, thick, cthick, drop, inG, inC, warpX, warpZ, aged, meso, vary, rough) {
    const N = this.noise, L = N.detail, D = this.drift, G = this.grain(), wb = c.base - drop;
    const cv = smoothstep(0.1, 0.5, c.conv);
    const hh = lerp(clamp(h, 0, 1), clamp(hc, 0, 1), cw), cve = Math.max(cv, cw);
    const hm = lerp(clamp(h, 0, 1) * thick, clamp(hc, 0, 1) * cthick, cw);   // meters above the base
    // Towers lean downwind as they rise (same shear the renderer applies).
    const fl = Math.hypot(this.flowX, this.flowZ), lean = hh * hh * lerp(thick, cthick, cw) * 0.2 * lerp(c.conv, 1, cw);
    const qx = x + (fl > 0.2 ? this.flowX / fl : 1) * lean + warpX, qz = z + (fl > 0.2 ? this.flowZ / fl : 0) * lean + warpZ;
    const nu = (qx + D.x) / NOISE_SCALE, nv = (y * NOISE_SQUASH) / NOISE_SCALE, nw = (qz + D.z) / NOISE_SCALE;
    const n0 = sampleNoise(N, nu, nv, nw, 0), n1 = sampleNoise(N, nu, nv, nw, 1), n2 = sampleNoise(N, nu, nv, nw, 2), n3 = sampleNoise(N, nu, nv, nw, 3);
    // Along and across the grain, for what is combed out by the wind.
    const fx = (x + D.x) * G.x + (z + D.z) * G.z, fz = (z + D.z) * G.x - (x + D.x) * G.z;
    let n = n0;
    // How much of the noise the layer lets through at this height (0: all of it is cloud .. 1: none).
    let thG = 2, deep = 0, topz = 0, scud = 0;
    if (inG) {
      const ce = clamp(c.cov * (1 + 0.3 * cv) * (1 + VARY_AMP * vary * lerp(0.3, 1, cv)) * (1 + MESO_AMP * (meso - 0.5) * cv), 0, 1);
      const rag = (c.base - wb) / thick;
      scud = rag > 0.0005 ? 1 - smoothstep(0.6 * rag, rag + 0.004, h) : 0;
      deep = smoothstep(5000, 8000, thick);
      // Cumulus: a flat base, and a dome over each cell of the noise, taller the stronger the cell.
      const tC = (0.12 + ce) * h * h + 0.05 * (1 - smoothstep(0, 200, h * thick)) - 0.45 * deep * smoothstep(0.76, 0.9, h) * (1 - smoothstep(0.95, 1, h)) + 1 - smoothstep(0, 0.035 + rag * 1.6, h);
      // Layer cloud: a slab whose top rolls over a few hundred meters, in sheets where it is deep.
      const zt = clamp(450 / thick, 0.06, 0.5), zb = clamp(110 / thick, 0.02, 0.2) + rag * 1.3;
      const tS = smoothstep(1 - zt, 1, h) + 1 - smoothstep(0, zb, h) + 0.3 * smoothstep(2000, 4000, thick) * (0.5 - 0.5 * Math.cos(h * thick * 0.0037));
      // The top of a layer is a pavement of cells with narrow clefts between them, half of them drawn out into rolls along the wind.
      let tS2 = tS;
      topz = (1 - cv) * smoothstep(1 - 2.2 * zt, 1 - zt, h) * (1 - cw);
      if (topz > 0.02) { const cleft = 1 - lerp(n1, sampleNoise(N, fx / 29200, y / 7300, fz / 7300, 1), 0.5); tS2 += topz * CLEFT * (cleft * cleft - 0.3); }
      thG = 1 - ce + lerp(tS2, tC, cv);
    }
    let thC = 2, anv = 0, und = 0;
    if (inC) {
      // Turrets: the tower's wall is pushed out and in by the slowest octaves of the noise and by its cells.
      const k = cellCover(cell.rho * (1 - TURRET[0] * (n3 - 0.5) - TURRET[1] * (n1 - 0.5)), cell.rhoA, hc, cell.ph, 1 + 0.9 * vary, 1 + 1.3 * (n3 - 0.5));
      anv = cellCover.anvil; und = cellCover.under;
      thC = (1 - k) * 1.35 + 1 - smoothstep(0, 0.03 + (drop / cthick) * 1.6, hc);
    }
    const th = lerp(thG, thC, cw);
    if (anv > 0) {
      // An anvil is a smooth sheet, not a heap, combed out along the wind into fibers; mammatus hangs in patches from its underside.
      und *= anv;
      const streak = sampleNoise(N, fx / 14600, y / 7300, fz / 1825, 2), fib = sampleNoise(L, fx / 3650, y / 1825, fz / 608.3333, 2);
      let na = 0.5 + (n - 0.5) * 0.3 + ((streak - 0.5) * 0.5 + (fib - 0.5) * 0.2) * (1 - 0.9 * und);
      if (und > 0.01) na += (sampleNoise(L, (qx + D.x) / 3175, 950 / 3175, (qz + D.z) / 3175, 0) - 0.5) * 0.34 * und * smoothstep(0.45, 0.7, aged) * (1 - smoothstep(1.3, 2.1, cell.rhoA));
      n = lerp(n, na, anv);
    } else und = 0;
    // Lobes: billows where the cloud is growing, wisps where it is old, layered, anvil or scud (the renderer adds finer detail; this takes its average).
    const soft = smoothstep(0.55, 0.9, aged);
    let tw = lerp(lerp(0.7 - 0.45 * topz, 0.06 + 0.8 * soft * (1 - 0.8 * cw) + 0.45 * (1 - smoothstep(0, 160, hm)), cve), 1, Math.max(anv * (1 - und), scud));
    tw = clamp(lerp(tw, 0, und), 0, 1);
    const form = c.fresh * (1 - cw);                              // cloud still forming: wisps, soft and thin (see FORM_TIME)
    tw = lerp(tw, 1, 0.75 * form);
    const topw = lerp(0.35, 1, Math.max(smoothstep(0, 250, hm), cve)) * (1 - 0.55 * deep * (1 - cw) * smoothstep(0.7, 0.9, hh)) * (1 - 0.5 * anv);
    const eL = lerp(LOBE_AMP[0], LOBE_AMP[1], cve) * topw * lerp(0.6, 1.35, rough) * (1 + 0.35 * tw) * (1 - 0.1 * cw) * (1 - 0.7 * und), eF = FINE_AMP * eL;
    // What a lobe octave cuts away: a billow as a round dome does (0.61 on average), a wisp all but its shreds (0.70).
    const cutAvg = lerp(0.61, 0.70, tw);
    let d = n - th + cutAvg * (eL + eF);
    if (d <= 0) return 0;
    // Density climbs from the surface inward: crisply on the crown of a young turret, through a ragged fringe on its flanks and where the cloud is old, gently where it is layered or anvil.
    const crisp = cve * smoothstep(0, 160, hm) * (1 - anv) * (1 - 0.6 * tw);
    const young = (1 - soft) * lerp(0.75 + 0.25 * smoothstep(0.15, 0.7, hh), 1, cw);
    const edge = lerp(lerp(0.14, 0.03, smoothstep(0.45, 0.85, hh) * (1 - anv)), lerp(0.08, 0.009, young), crisp) * (1 + 6 * form);   // (the top of a layer is sharp too, under its inversion)
    let cut = cutAvg;
    if (d < eL + eF + edge) {
      const bx = qx + (n2 - 0.5) * LOBE_WARP, by = y + (n1 - 0.5) * 0.4 * LOBE_WARP, bz = qz - (n3 - 0.5) * LOBE_WARP, R = LOBE_ROT;
      // (R holds the columns of the rotation; the drift is turned with the point.)
      const px = bx + D.x, pz = bz + D.z;
      const lu = (R[0] * px + R[3] * by + R[6] * pz) / LOBE_SCALE, lv = (R[1] * px + R[4] * by + R[7] * pz) / LOBE_SCALE, lw = (R[2] * px + R[5] * by + R[8] * pz) / LOBE_SCALE;
      const b = 1 - lerp(sampleNoise(L, lu, lv, lw, 0), sampleNoise(L, lu, lv, lw, 1), 0.36 * (1 - und));
      cut = Math.pow(b, 0.6667);
      if (tw > 0.001) { const w = lerp(sampleNoise(L, lu, lv, lw, 2), sampleNoise(L, lu, lv, lw, 3), 0.42); cut = lerp(cut, 1 - w * w, tw); }
    }
    d -= eL * cut + eF * cutAvg;
    if (d <= 0) return 0;
    const xe = Math.min(d / edge, 1);
    return xe * (0.3 + 0.7 * xe) * CLOUD_SIGMA * lerp(0.75, 1.35, cve) * lerp(1, 0.8 + 0.45 * hh, cve) * (1 - 0.7 * anv) * (1 - 0.7 * form);
  }

  /**
   * Everything the aircraft feels at a point. gy = ground height beneath.
   * Writes: wind x/y/z (m/s), turb 0..1, temp °C, cloud (extinction), precip 0..1,
   * snow bool, icing rate, visibility m, overcast 0..1, shade 0..1, plus the column.
   * Also: snowMix 0..1 (how much of the precipitation is snow: it turns over a couple of degrees), freezing 0..1 (rain
   * falling through air below zero, which glazes whatever it lands on), hail 0..1, blow 0..1 (snow streaming over the
   * ground here, whatever the height of the aircraft), rainEnd (m: the height below which no rain is left, see column()).
   */
  sample(x, y, z, gy, out) {
    const c = this.column(x, z, this.col);
    const agl = Math.max(0, y - gy);
    if (!this._quiet) {
      // Remember where the aircraft is and which way it is going, for the ground state and for weather that stages itself.
      const a = this.at, dx = x - a.rx, dz = z - a.rz, dl = Math.hypot(dx, dz);
      a.x = x; a.z = z;
      if (dl > 300) { if (dl < 5000) { a.hx = dx / dl; a.hz = dz / dl; } a.rx = x; a.rz = z; }
    }
    this.wind(x, z, y, gy, out);
    const hr = this.hour, diurnal = clamp(Math.sin((Math.PI * (hr - 8)) / 12), 0, 1);
    let up = 0, turb = 0, hail = 0, chill = 0;

    // Thermals under fair-weather cumulus (stronger on a very hot day).
    const th = Math.max(smoothstep(0.02, 0.05, c.cu), smoothstep(0.3, 0.4, this.humidity));
    if (th > 0) {
      const tn = this.cu((x + this.drift.x) / 1300, (z + this.drift.z) / 1300);
      const lift = Math.pow(Math.max(0, tn), 1.6) * 5.2 - 0.5;
      const k = th * diurnal * (0.35 + 1.6 * Math.min(c.cu, 0.5)) * smoothstep(0, 350, agl) * (1 - smoothstep(c.cuBase - 150, c.cuBase + 350, y)) * (gy > 1 ? 1 : 0.15) * (1 + 0.045 * clamp(this.tAnom - 6, 0, 10));
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
      if (s.hail && y < c.top) hail = Math.max(hail, mature * (1 - smoothstep(0.12 * s.r, 0.6 * s.r, d)));
    }
    // Cold-front squall line.
    if (c.front > 0.02) {
      const cn = this.cu((x + this.drift.x) / 2400 + 7, (z + this.drift.z) / 2400);
      up += c.front * 9 * cn * smoothstep(c.base - 300, c.base + 600, y) - c.front * 5 * (1 - smoothstep(c.base, c.base + 500, y)) * smoothstep(0, 250, agl) * c.precip;
      turb = Math.max(turb, c.front * 0.85);
    }
    // Squall line: lift along the shelf, the downdraft in the rain behind it, small hail in the leading core, and a
    // pool of rain-cooled air that reaches back under the trailing cloud.
    if (c.line > 0.02) {
      const d = c.lineD, e = c.line, low = 1 - smoothstep(1500, 3500, agl);
      up += e * 7 * Math.exp(-Math.pow((d - 800) / 1800, 2)) * smoothstep(0, 300, agl) * low
        - e * 7 * smoothstep(0, -2500, d) * smoothstep(-17e3, -10e3, d) * (1 - smoothstep(c.base, c.base + 500, y)) * smoothstep(0, 250, agl);
      turb = Math.max(turb, e * Math.exp(-Math.pow((d + 500) / 2600, 2)) * (0.45 + 0.55 * low), e * 0.75 * smoothstep(1500, -1000, d) * smoothstep(-16e3, -10e3, d) * (y < c.top ? 1 : 0.2));
      if (y < c.top) hail = Math.max(hail, 0.4 * e * Math.exp(-Math.pow((d + 3500) / 2500, 2)));
      chill = 9 * e * smoothstep(1500, -6000, d) * smoothstep(-185e3, -90e3, d);
    }
    // Snow bands: lift and rough air in the showers.
    if (c.band > 0.02) {
      up += 2.5 * c.band * smoothstep(c.base - 500, c.base + 300, y) * (1 - smoothstep(c.top - 600, c.top, y));
      turb = Math.max(turb, 0.5 * c.band * (y < c.top ? 1 : 0.15));
    }
    // Under rain that is evaporating as it falls, the air it chills sinks and spreads out in gusts.
    if (this.dry > 0.01 && c.precip > 0.02) {
      const k = this.dry * c.precip * (1 - smoothstep(c.base - 300, c.base, y));
      up -= 6 * k * smoothstep(0, 300, agl); turb = Math.max(turb, 0.45 * k);
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
    // A gusty air mass: the stronger the wind the rougher, most of all near the ground.
    if (this.gust > 0.01) turb = Math.max(turb, this.gust * clamp(ws / 16, 0, 1) * (0.3 + 0.7 * Math.exp(-agl / 1200)));

    const dens = this.density(x, y, z, c);
    if (dens > 0) turb = Math.max(turb, 0.12 + 0.35 * c.conv * Math.min(1, dens / CLOUD_SIGMA));
    out.y = up; out.turb = clamp(turb, 0, 1); out.hail = hail * this.ctl.precip;
    out.cloud = dens;

    const tsl = this.grid(this.tsea, x, z) + this.tAnom - 6.5 * c.cold + 2.5 * c.warm + (diurnal - 0.4) * 4 * (1 - c.cov) - chill;
    out.tempSea = tsl;
    // Temperature falls with height, except through a warm layer aloft (an inversion: the air there is warmer than below it).
    out.temp = tsl - 0.0065 * y + (this.invDT ? this.invDT * Math.exp(-Math.pow((y - this.invH) / this.invD, 2)) : 0);
    const under = y < c.top ? 1 : 0;
    // Rain that evaporates on the way down (virga) is gone below rainEnd.
    out.rainEnd = c.rainEnd;
    out.precip = c.precip * under * (y > c.base ? Math.min(1, 0.3 + dens / CLOUD_SIGMA) : c.rainEnd > gy + 1 ? smoothstep(c.rainEnd - 250, c.rainEnd + 250, y) : 1);
    // Snow or rain: decided by the warmest air it has fallen through to get here. Under a warm layer it has melted, and
    // if the air here is below zero again it is freezing rain.
    const melt = Math.max(out.temp, this.invDT && y < this.invH ? tsl - 0.0065 * this.invH + this.invDT : -99);
    out.snowMix = smoothstep(1.8, -0.2, melt);
    out.snow = out.snowMix > 0.5;
    out.freezing = (1 - out.snowMix) * smoothstep(0.3, -1, out.temp);
    out.icing = dens > 0.0004 && out.temp < 0 && out.temp > -20 ? (0.5 + 0.5 * c.conv) * Math.min(1, dens / (CLOUD_SIGMA * 0.5))
      : (out.precip > 0.1 && out.temp < 0 && out.temp > -7 && !dens ? 0.4 * out.precip : 0);
    out.icing = Math.max(out.icing, 0.9 * out.freezing * out.precip);
    // Snow lifted off the ground by the wind: a shallow, blinding layer that the aircraft climbs out of in a few seconds.
    out.blow = 0;
    if (this.blowing > 0.01) {
      const w = this._wb || (this._wb = { x: 0, z: 0 });
      this.wind(x, z, gy + 10, gy, w);
      out.blow = this.blowing * smoothstep(5, 12, Math.hypot(w.x, w.z)) * smoothstep(1, -1.5, tsl - 0.0065 * gy);
    }
    let vis = this.haze * (1 + 0.5 * c.cold) / (1 + 0.6 * c.warm);
    // Haze trapped under an inversion ends at its top: above it the air is clean.
    if (this.hazeCap > 0.001) vis = lerp(vis, Math.max(vis, 150000), this.hazeCap * smoothstep(this.hazeTop - 450, this.hazeTop + 250, y));
    vis /= 1 + out.precip * lerp(13, 34, out.snowMix);
    vis = 1 / (1 / vis + (out.blow * Math.exp(-agl / 40)) / 600);
    out.visibility = vis * (1 + smoothstep(2000, 6000, y) * 0.8);
    // Inside a fog bank the world is gone: what the pilot sees is set by the fog's own density (Koschmieder: 3.9 / extinction).
    if (this.fogDens > 0) out.visibility = 1 / (1 / out.visibility + this.fogDens / 3.912);
    out.overcast = c.cov * smoothstep(c.top + 300, c.top - 300, y) * smoothstep(0.25, 0.95, c.cov);
    out.shade = Math.max(out.overcast * 0.9, dens > 0 ? 0.8 : 0);
    out.col = c;
    return out;
  }

  // ---------------------------------------------------------------- reports for briefings

  /** Surface observation in the style of a METAR. */
  report(x, z, elev) {
    const o = this._rep || (this._rep = {});
    this._quiet = true; this.sample(x, elev + 3, z, elev, o); this._quiet = false;
    const c = o.col, sp = Math.hypot(o.x, o.z) * 1.944;
    const dir = (Math.round(((Math.atan2(-o.x, o.z) / D2R + 360) % 360) / 10) * 10) || 360;
    const gust = sp * (1 + 0.9 * o.turb) + (c.cell > 0.2 ? 14 : 0);
    const fog = c.fog > 0.3 && elev < c.top;
    const visKm = fog ? 0.3 + (1 - c.fog) * 2 : Math.min(o.visibility / 1000, 99);
    const wx = [];
    if (c.cell > 0.3 || c.front > 0.35) wx.push(c.precip > 0.5 ? '+TSRA' : 'TS');
    else if (o.precip > 0.08) wx.push((o.precip > 0.6 ? '+' : o.precip < 0.3 ? '-' : '') + (o.snow ? (c.conv > 0.5 ? 'SHSN' : 'SN') : o.freezing > 0.5 ? 'FZRA' : c.conv > 0.5 ? 'SHRA' : 'RA'));
    else if (c.precip > 0.08) wx.push('VIRGA');
    if (o.blow > 0.3) wx.push('BLSN');
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
