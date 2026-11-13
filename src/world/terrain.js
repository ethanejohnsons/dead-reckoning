// The world model: ground height, water, climate. Heights come from real
// elevation data (dem.js); everything else here is derived from it so that
// physics, rendering, weather and the chart agree. buildWorld is run again
// whenever the game's window of the world moves.
// Coordinates: +X east, +Z south, +Y up, meters.

import * as THREE from 'three';
import * as dem from './dem.js';
import { WORLD_HALF, LAND_HALF, toLatLon, hemisphere } from './geo.js';
import { clamp, smoothstep } from '../core/noise.js';
import { ENV } from '../core/env.js';

export { WORLD_HALF, LAND_HALF };
export const BN = 1024;             // regional base grid (about 512 m per cell)
export const MN = 256;              // climate grid (about 2 km per cell)

// base: coarse height; water: 0..255 coverage; moist, tsea, snow: the climate grids; low: the level of the
// valley floors and plains around each point (m).
export const world = { base: null, water: null, moist: null, tsea: null, snow: null, low: null };

// What the surface shaders need to know about the place: x: the tree line at the window's center (m),
// y: how much higher it is at the southern edge of the chart (m), z: +1 when the midday sun stands in the
// south (northern hemisphere), -1 in the north.
ENV.uRegion = { value: new THREE.Vector4(3000, 0, 1, 0) };
/** GLSL for the terrain and tree shaders (after the lighting code, which declares tRegion, uWxHalf and uTAnom). */
export const REGION_GLSL = /* glsl */`
uniform vec4 uRegion;
float treeLine(vec2 xz) { return uRegion.x + uRegion.y * xz.y / ${LAND_HALF.toFixed(1)}; }
// Altitude above which snow lies today: the regional map carries the level for an ordinary day, the weather's
// temperature shift moves it 150 m a degree, and faces turned from the sun (shade: -1 sunward .. 1 poleward) hold it lower.
float snowLine(vec2 xz, float shade) { return texture2D(tRegion, xz / (2.0 * uWxHalf) + 0.5).a - 260.0 * shade + uTAnom * 150.0; }
`;
export const REGION_UNIFORMS = ['uRegion'];

function bilinear(g, n, x, z) {
  const fx = clamp(((x + WORLD_HALF) / (2 * WORLD_HALF)) * (n - 1), 0, n - 1.001);
  const fz = clamp(((z + WORLD_HALF) / (2 * WORLD_HALF)) * (n - 1), 0, n - 1.001);
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * n + i;
  return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + n] * (1 - u) + g[k + n + 1] * u) * v;
}
/** Coarse regional height (m, sea floor negative): always available once the world is loaded. */
export const baseHeight = (x, z) => bilinear(world.base, BN, x, z);
/** Moisture 0 (desert) .. 1 (wet forest). */
export const moisture = (x, z) => bilinear(world.moist, MN, x, z);
/** Temperature of an ordinary day brought down to sea level (deg C): what the weather starts from. */
export const seaLevelTemp = (x, z) => bilinear(world.tsea, MN, x, z);
/** Is this point lake or sea on the coarse regional map? (For things laid out before fine data is loaded.) */
export const baseWater = (x, z) => {
  const i = Math.round(clamp((x + WORLD_HALF) / (2 * WORLD_HALF), 0, 1) * (BN - 1)), j = Math.round(clamp((z + WORLD_HALF) / (2 * WORLD_HALF), 0, 1) * (BN - 1));
  return world.water[j * BN + i] > 127;
};

/** A value read off a table of [x, value] pairs (x rising), straight lines between them, level beyond the ends. */
function along(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) if (x <= table[i][0]) { const a = table[i - 1], b = table[i]; return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]); }
  return table[table.length - 1][1];
}
// The latitude at which the forest gives out into tundra, by longitude: the Aleutians and the Bering Sea coast
// are treeless far to the south, the Mackenzie carries the trees nearly to the Arctic Ocean, and Hudson Bay
// and the Labrador Sea push the line south again.
const ARCTIC = [[-172, 50], [-164, 55], [-159, 60], [-152, 66.5], [-140, 68.5], [-130, 68.5], [-115, 66], [-100, 61], [-95, 59.5], [-85, 56.5], [-78, 57], [-70, 58], [-62, 56.5], [-55, 53]];
// The tree line in the interior of the continent, by latitude (m).
const TREELINE = [[20, 3000], [28, 3900], [35.4, 3900], [39, 3500], [48, 2500], [53, 2150], [60, 1300], [65, 800], [69, 200]];
// The latitude at which the prairie gives way to the north woods and the boreal forest, by longitude: from the
// Twin Cities to northwestern Minnesota, around the north of Winnipeg, then northwest behind Saskatoon and Edmonton.
const WOODS_EDGE = [[-115, 54.2], [-110, 53.6], [-105, 53.2], [-101, 52], [-98, 51], [-96, 48.6], [-92, 44.4]];
// The longitude of the crest of the Pacific ranges (the Cascades, the Coast Mountains), by latitude: wet forest to the west of it.
const crestLon = (lat) => (lat < 49 ? -121.4 : -121.4 - (lat - 49) * 1.35);

/**
 * Altitude of the upper tree line at a place (m; at or below zero where no trees grow at all). In the interior
 * of the continent it is about 3,500 m in Colorado at 39 N and falls 110 m a degree to about 2,500 m at 48 N in
 * Montana, then more slowly through the Canadian Rockies and the Yukon. Sea air holds it lower west of the
 * Pacific crest from Oregon north (about 1,800 m in the Cascades, about 800 m around Anchorage), and it is much
 * lower in the East (1,400 m in New Hampshire); toward the Arctic it comes down to the ground where the forest ends.
 */
export function treelineAt(lat, lon = -100) {
  const a = Math.abs(lat), crest = crestLon(a);
  let tl = along(TREELINE, a);
  tl *= 1 - 0.3 * smoothstep(42, 47, a) * (1 - smoothstep(61.5, 63.5, a)) * smoothstep(crest + 1, crest - 1, lon);
  tl -= 1500 * smoothstep(-85, -75, lon) * smoothstep(36, 44, a);
  return Math.max(-200, Math.min(tl, (along(ARCTIC, lon) - a) * 220));
}
/** The same by world z. Mirrors treeLine() in the shaders. */
export const treeline = (z) => ENV.uRegion.value.x + ENV.uRegion.value.y * (z / LAND_HALF);

// How wet the lowlands are from the Rockies to the Atlantic, by longitude: short-grass plains under the
// mountains, mixed and tall-grass prairie through the Dakotas, Nebraska and Kansas, forest from the Mississippi east.
const EAST = [[-104, 0.28], [-100, 0.33], [-97, 0.4], [-94, 0.52], [-90, 0.66], [-84, 0.72], [-70, 0.74]];

/**
 * How wet the lowlands are at a place (0 desert .. 1 wet forest), from the map of North America. Under about
 * 0.42 nothing grows wild but grass and brush; from 0.6 up the country is forest. East of the Rockies the
 * humid East dries steadily westward across the plains; the corn belt from Iowa to Ohio, forest once, is
 * plowed nearly from edge to edge; the north woods and the boreal forest begin at a line that runs from the
 * Twin Cities to northwestern Minnesota and on northwest across the prairie provinces. Between the Rockies
 * and the Pacific ranges the basins are sagebrush, and desert in the south; the inland Northwest catches
 * Pacific air; west of the Cascades and the Coast Mountains, from northern California to Alaska, is rain
 * forest; California is dry but for its north coast. The relief adds the rest (see buildWorld).
 */
export function lowlandMoisture(lat, lon) {
  let m;
  if (lon > -104) {
    m = along(EAST, lon);
    m -= 0.16 * smoothstep(38, 40, lat) * (1 - smoothstep(42.3, 44.3, lat)) * smoothstep(-82.5, -84.5, lon) * smoothstep(0.4, 0.62, m);
    // the edge of the north woods
    const edge = along(WOODS_EDGE, lon);
    m = Math.max(m, 0.78 * smoothstep(edge - 0.5, edge + 0.5, lat));
  } else {
    m = 0.26 - 0.11 * smoothstep(38, 33, lat) + 0.03 * smoothstep(44, 48, lat);
    const west = -112 - 1.2 * Math.max(0, lat - 48.5);       // (the divide runs northwest)
    m += 0.2 * smoothstep(west, west - 3.5, lon) * smoothstep(46, 48.5, lat);
    // the boreal forest runs on behind the prairies of Alberta to the mountains, and through the Yukon and the interior of Alaska
    m = Math.max(m, 0.74 * smoothstep(53.2, 54.6, lat));
    // California: the dry south coast and the Central Valley, the wetter north coast
    m = Math.max(m, (0.3 + 0.42 * smoothstep(37.5, 40.5, lat)) * smoothstep(-121.3, -122.6, lon - 0.9 * Math.max(0, 38 - lat)));
    const crest = crestLon(lat);
    m = Math.max(m, 0.86 * smoothstep(crest + 0.6, crest - 0.6, lon) * smoothstep(40.5, 43.5, lat));
  }
  // The Hawaiian islands: forest to the trade winds, the relief sorts out the rest.
  if (lat < 24 && lon < -150) m = 0.6;
  return clamp(m, 0, 0.9);
}

function boxBlur(g, n, r, passes = 1) {
  const t = new Float32Array(n * n);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < n) { s += g[j * n + ii]; c++; } } t[j * n + i] = s / c; }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < n) { s += t[jj * n + i]; c++; } } g[j * n + i] = s / c; }
  }
  return g;
}
function minFilter(g, n, r) {
  const t = new Float32Array(n * n), o = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let m = Infinity; for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < n && g[j * n + ii] < m) m = g[j * n + ii]; } t[j * n + i] = m; }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let m = Infinity; for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < n && t[jj * n + i] < m) m = t[jj * n + i]; } o[j * n + i] = m; }
  return o;
}

/**
 * Build the regional maps for the window of the world as it is now, from the base elevation and water
 * grids (dem.loadBase) and the built-up density of its towns (a BN x BN grid, towns.js): the climate
 * (moisture, temperature, snow level) and the texture the shaders read.
 */
export function buildWorld(base, urban) {
  world.base = base.height; world.water = base.water;
  const H = WORLD_HALF, terr = new Float32Array(MN * MN), moist = new Float32Array(MN * MN), tsea = new Float32Array(MN * MN), snow = new Float32Array(MN * MN), open = new Float32Array(MN * MN);
  const q = (BN / MN) | 0;
  for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) {
    const x = (i / (MN - 1)) * 2 * H - H, z = (j / (MN - 1)) * 2 * H - H, k = j * MN + i;
    terr[k] = Math.max(0, baseHeight(x, z));
    let w = 0;
    for (let dj = 0; dj < q; dj++) for (let di = 0; di < q; di++) w += world.water[Math.min(BN - 1, j * q + dj) * BN + Math.min(BN - 1, i * q + di)];
    open[k] = w / (q * q * 255);
  }
  // The level of the plains and valley floors around each point: the lowest ground within about 12 km, smoothed.
  const low = boxBlur(minFilter(terr, MN, 6), MN, 5, 2);
  boxBlur(open, MN, 2);                                    // 1 only well out on big water
  const c0 = toLatLon(0, 0), tl0 = treelineAt(c0.lat, c0.lon), tl1 = treelineAt(toLatLon(0, LAND_HALF).lat, c0.lon);
  ENV.uRegion.value.set(tl0, tl1 - tl0, hemisphere(), 0);
  for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) {
    const x = (i / (MN - 1)) * 2 * H - H, z = (j / (MN - 1)) * 2 * H - H, k = j * MN + i, ll = toLatLon(x, z);
    // Ranges are wetter than the country they stand in: forest begins a few hundred meters above the valley floor.
    moist[k] = clamp(lowlandMoisture(ll.lat, ll.lon) + 0.5 * smoothstep(150, 700, terr[k] - low[k]), 0, 1);
    // The plains and plateaux are as warm as the lowlands (the ground heats the air wherever it lies), up to
    // a point; only what stands above them is colder. So an ordinary day is about 15 C at any airfield's door.
    tsea[k] = 15.5 + 0.0065 * Math.min(low[k], 2000);
    // Snow lies where the air is under about 2 C, and never lower than 650 m above the tree line on an ordinary day.
    snow[k] = Math.min((tsea[k] - 2.2) / 0.0065, Math.max(treelineAt(ll.lat, ll.lon), 0) + 650);
  }
  boxBlur(moist, MN, 1, 2);                                // biome edges are not razor sharp
  world.moist = moist; world.tsea = tsea; world.snow = snow; world.low = low;

  const data = new Uint16Array(BN * BN * 4), toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < BN; j++) for (let i = 0; i < BN; i++) {
    const k = j * BN + i, x = (i / (BN - 1)) * 2 * H - H, z = (j / (BN - 1)) * 2 * H - H;
    const wet = world.water[k] > 127 || world.base[k] <= 0;
    data[k * 4] = toHalf(world.base[k]); data[k * 4 + 1] = toHalf(moisture(x, z));
    // Blue: how built-up the land is (0..1), or, negated, how far out on open water this is (0 at the shore .. -1).
    data[k * 4 + 2] = toHalf(wet ? -clamp((bilinear(open, MN, x, z) - 0.3) / 0.3, 0, 1) : urban ? urban[k] : 0);
    data[k * 4 + 3] = toHalf(bilinear(snow, MN, x, z));
  }
  ENV.tRegion.value?.dispose();
  const tex = new THREE.DataTexture(data, BN, BN, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  ENV.tRegion.value = tex;
}

// Airfields grade the terrain to a gently tilted plane under their runways, taxiways, aprons and
// buildings. A flat is a rectangle of the world with a grid of weights over it (1 on and close around
// the pavement, easing to 0 a few hundred meters out) and the plane it grades to:
//   { x0, z0, x1, z1, cell, nx, nz, w: Float32Array(nx * nz), dry (the same, see flatWeight), cx, cz, e0, gx, gz }
// graded height = e0 + gx * (x - cx) + gz * (z - cz); terrain = natural + (graded - natural) * weight.
// Where the weight is 1 the ground is exactly the plane, so pavement and buildings can sit on it.
let FLATS = [];
export function setFlats(list) { FLATS = list; }
/** Flats whose graded zone touches a rectangle (lets the mesher skip the test for most chunks). */
export const flatsIn = (x0, z0, x1, z1) => FLATS.filter((f) => f.x1 > x0 && f.x0 < x1 && f.z1 > z0 && f.z0 < z1);
function gradeWeight(f, x, z, w = f.w) {
  const fx = (x - f.x0) / f.cell, fz = (z - f.z0) / f.cell;
  if (!(fx >= 0 && fz >= 0 && fx < f.nx - 1 && fz < f.nz - 1)) return 0;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * f.nx + i;
  const a = w[k], b = w[k + 1], c = w[k + f.nx], d = w[k + f.nx + 1];
  if (a + b + c + d >= 4) return 1;
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
/** Height of a flat's graded plane at a point. */
export const gradeHeight = (f, x, z) => f.e0 + f.gx * (x - f.cx) + f.gz * (z - f.cz);
export function applyFlats(list, x, z, h) {
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (x <= f.x0 || x >= f.x1 || z <= f.z0 || z >= f.z1) continue;
    const w = gradeWeight(f, x, z);
    if (w > 0) h += (gradeHeight(f, x, z) - h) * w;
  }
  return h;
}
/**
 * How much a point belongs to an airfield (0..1): the grading weight, or 1 anywhere inside the
 * airport's boundary (a flat's `dry` grid). Water never shows and trees never grow inside it.
 */
export function flatWeight(list, x, z) {
  let best = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (x <= f.x0 || x >= f.x1 || z <= f.z0 || z >= f.z1) continue;
    const w = gradeWeight(f, x, z, f.dry || f.w);
    if (w > best) best = w;
  }
  return best;
}

/** Ground (or water surface) height for physics, from the finest terrain data loaded there. */
export function groundHeight(x, z) {
  return applyFlats(FLATS, x, z, Math.max(dem.heightAt(x, z), 0));
}
/** True over lake or sea. (Not on an airfield; and in a town, not on the dead-level patches the survey leaves under cities.) */
export function isWater(x, z) {
  return dem.waterAt(x, z) && flatWeight(FLATS, x, z) < 0.5 && !(town(x, z) > URBAN && dem.doubtfulAt(x, z));
}
/** Built-up density above which a level patch without banks is taken for a hole in the survey, not a lake. */
export const URBAN = 0.25;
let town = () => 0;
/** Give the world the towns' built-up density (towns.js does, when it loads). */
export function setTownDensity(fn) { town = fn; }
/** Height for planning and charts: the coarse regional grid with airfields graded in. */
export const height = (x, z) => applyFlats(FLATS, x, z, Math.max(baseHeight(x, z), 0));
