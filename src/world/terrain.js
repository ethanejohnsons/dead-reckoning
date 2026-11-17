// The world model: ground height, water, climate. Heights come from real
// elevation data (dem.js); everything else here is derived from it so that
// physics, rendering, weather and the chart agree. buildWorld is run again
// whenever the game's window of the world moves.
// Coordinates: +X east, +Z south, +Y up, meters.
//
// The climate is for anywhere on earth. North America's is drawn by hand below
// (how wet the lowlands are, the tree line, the swing of the seasons); the rest
// of the world's is broader: its moisture is read off a half-degree grid baked
// from the satellite picture (public/data/climate.bin, tools/bake-climate.py:
// loadClimate), its tree line and seasons follow latitude, hemisphere and how
// far the sea rules the weather. northAmerica() says which of the two a place gets.

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
export const world = { base: null, water: null, moist: null, tsea: null, snow: null, low: null, args: null };

// ---------------------------------------------------------------- seasons
//
// The world's "ordinary day" (seaTempAt) is a mild flying day. A season moves it: by latitude, the mean of the
// daily highs over the year and how far they swing either side of it (deg C, lowlands of the interior), coldest
// about 22 January and warmest about 23 July (half a year on south of the equator). The Pacific coast swings less,
// and so does everywhere else the weather comes off the sea (seaRuled). The temperature then decides the
// rest: the snow line (so a northern winter lies white), and what the leaves are doing, in the shaders (SEASON_GLSL):
// they come out as the days warm through the teens, turn as the highs fall through the low twenties and are down by
// about 8 C, so the fall starts in Canada and the mountains and moves south, and the tropics hardly change at all.
const SEASON_MEAN = [[10, 31], [20, 29], [25, 28], [30, 25], [35, 22], [40, 17], [45, 12.5], [50, 9], [55, 5], [60, 2], [65, -2], [70, -6]];
const SEASON_SWING = [[10, 1], [20, 3], [25, 4.5], [30, 8], [35, 11], [40, 14], [45, 16], [50, 17], [55, 17], [60, 17.5], [70, 16]];
//
// The player picks a time of the season, not a date: early, mid (peak in the fall) or late. Summer and winter are
// dates. Spring and fall are where the leaves are at the place the world is built round: the day the lowland there
// reaches the temperature of that stage (on the way up for spring, on the way down for fall), so "peak fall" is
// peak color in Vermont on 1 October and in Virginia three weeks later. Where it never gets that cold (the
// tropics) the date stands.
export const SEASON_LIST = [
  ['spring-early', 'Early spring'], ['spring', 'Spring'], ['spring-late', 'Late spring'],
  ['summer-early', 'Early summer'], ['summer', 'Summer'], ['summer-late', 'Late summer'],
  ['fall-early', 'Early fall'], ['fall', 'Peak fall'], ['fall-late', 'Late fall'],
  ['winter-early', 'Early winter'], ['winter', 'Winter'], ['winter-late', 'Late winter'],
];
export const SEASONS = {
  'spring-early': 91, spring: 121, 'spring-late': 152, 'summer-early': 166, summer: 196, 'summer-late': 232,
  'fall-early': 268, fall: 288, 'fall-late': 309, 'winter-early': 340, winter: 15, 'winter-late': 60,
};
// the lowland temperature (deg C) of each stage, and whether it comes on the way up (1) or down (-1): see SEASON_GLSL
const SEASON_STAGE = { 'spring-early': [1, 14], spring: [1, 17], 'spring-late': [1, 21.5], 'fall-early': [-1, 19], fall: [-1, 15], 'fall-late': [-1, 9] };
const COLDEST = 22;
let seasonKey = 'summer', seasonDay = SEASONS.summer;
/** The day of the year the world's climate is for. */
export const season = () => seasonDay;
/** The day of a time of the season (SEASON_LIST) at a place; tlow: what the lowland there adds to the sea-level temperature. */
function seasonDayAt(key, lat, lon, tlow = 0) {
  const s = lat < 0 ? 182 : 0, fixed = SEASONS[key] ?? SEASONS.summer, stage = SEASON_STAGE[key];
  if (!stage) return (fixed + s) % 365;
  const [dir, want] = stage, base = seaTempAt(lat) + tlow;
  let best = fixed, err = 1e9;
  for (let d = dir > 0 ? COLDEST : COLDEST + 183; d <= (dir > 0 ? COLDEST + 183 : COLDEST + 365); d++) {
    const e = Math.abs(base + seasonShift(lat, lon, d + s) - want);
    if (e < err) { err = e; best = d; }
  }
  return ((err < 1.5 ? best : fixed) + s) % 365;
}
/** How much warmer than its ordinary day a place is on a day of the year (deg C). high: the height of the ground there (m), where it matters. */
export function seasonShift(lat, lon, day = seasonDay, high = 0) {
  const a = Math.abs(lat), na = northAmerica(lat, lon), pacific = na > 0 && lon < -116 && a > 30 ? na * smoothstep(-117, -122.5, lon) : 0;
  const ph = (2 * Math.PI * (day - COLDEST)) / 365.2422 + (lat < 0 ? Math.PI : 0);
  // Beyond North America: sea air keeps the year's mean up in the higher latitudes and takes most of its swing away
  // (London's highs run from 8 C to 23 C where Winnipeg's, two degrees south of it, run from -12 C to 26 C), and the
  // hot deserts of the subtropics are hotter than their latitude and swing more (Dubai: 24 C to 41 C). (The low ones:
  // the pale rock and snow of a high range also read as dry in the climate grid, and are not hot.)
  const sea = seaRuled(lat, lon) * (1 - na), dry = na < 1 && a < 40 ? (1 - na) * smoothstep(0.3, 0.12, gridMoisture(lat, lon)) * smoothstep(40, 30, a) * (1 - smoothstep(1200, 2500, high)) : 0;
  const mean = along(SEASON_MEAN, a) + 2 * pacific + sea * (7 + 3 * smoothstep(55, 65, a)) * smoothstep(35, 55, a) + 4 * dry;
  return mean - seaTempAt(lat) - along(SEASON_SWING, a) * (1 - 0.55 * pacific) * (1 - 0.62 * sea) * (1 + 0.6 * dry) * Math.cos(ph);
}
/**
 * How far a place's seasons are the sea's (0 the inside of a continent .. 0.9), outside North America: the whole of
 * the southern hemisphere, which is mostly water; western Europe, less and less eastward to the Urals; not eastern
 * Asia, whose winters come off Siberia.
 */
function seaRuled(lat, lon) {
  if (lat < 0) return 0.9 * smoothstep(0, 12, -lat);
  return lon < 60 ? along(SEA_EUROPE, lon) : 0;
}
const SEA_EUROPE = [[0, 0.9], [15, 0.55], [40, 0.2], [60, 0]];
/** Set the time of the season (a key of SEASONS), and rebuild the maps that depend on it (when there is a world yet). */
export function setSeason(key) {
  seasonKey = SEASONS[key] !== undefined ? key : 'summer';
  if (world.args) buildWorld(...world.args);
  else setSeasonDay(SEASONS[seasonKey]);
}
function setSeasonDay(day) {
  seasonDay = ((day % 365) + 365) % 365;
  // Rising (spring) or falling (fall): the shaders read the leaves differently on the way up and the way down.
  // (Clamped hard: midsummer counts as spring, midwinter as fall.)
  ENV.uSeason.value.set(0.5 + 0.5 * clamp(3 * Math.sin((2 * Math.PI * (seasonDay - COLDEST)) / 365.2422) * (REGION_LAT() < 0 ? -1 : 1), -1, 1), seasonDay, 0, 0);
}
const REGION_LAT = () => toLatLon(0, 0).lat;
ENV.uSeason = { value: new THREE.Vector4(1, seasonDay, 0, 0) };
ENV.tSeason = { value: null };
/**
 * GLSL (after REGION_GLSL): seasonAt(p) for a point of the world, xyzw: leaves out (0 bare .. 1 full), turned (the
 * fall color, of what is still out), fresh (the light green of new leaves), dormant (grass gone to straw).
 *
 * The map is coarse (2 km a texel), so a shader short of texture units can read it in its vertex stage instead:
 * SEASON_MAP_GLSL there, seasonMap(xz) passed on as a varying, and SEASON_OF_GLSL in the fragment stage,
 * seasonOf(that, height), with no mention of tSeason (the terrain does this: world/chunks.js).
 */
export const SEASON_MAP_GLSL = /* glsl */`
uniform sampler2D tSeason;
// The map at a place: the season's lowland temperature (deg C), and how much warmer than an ordinary day the season
// makes the place (deg C; negative in winter).
vec2 seasonMap(vec2 xz) { return texture2D(tSeason, xz / (2.0 * uWxHalf) + 0.5).rg; }`;
export const SEASON_OF_GLSL = /* glsl */`
uniform vec4 uSeason;           // x: 1 while the days warm (spring), 0 while they cool (fall), in between at the turn
vec4 seasonOf(vec2 s, float y) {
  float T = s.r - 0.0065 * max(y, 0.0), up = smoothstep(0.35, 0.65, uSeason.x);
  float leaf = mix(smoothstep(6.0, 11.0, T), smoothstep(12.0, 19.0, T), up);
  float turned = (1.0 - up) * (1.0 - smoothstep(15.0, 22.0, T));
  float fresh = up * smoothstep(12.0, 18.0, T) * (1.0 - smoothstep(21.0, 27.0, T));
  float dormant = 1.0 - smoothstep(5.0, 13.0, T);
  return vec4(leaf, turned, fresh, dormant);
}`;
export const SEASON_GLSL = SEASON_MAP_GLSL + SEASON_OF_GLSL + /* glsl */`
vec4 seasonAt(vec3 p) { return seasonOf(seasonMap(p.xz), p.y); }
float seasonShift(vec2 xz) { return seasonMap(xz).g; }`;
export const SEASON_UNIFORMS = ['tSeason', 'uSeason'];

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
/**
 * How far a place is North America's (1: the hand-drawn maps of this file describe it) or the rest of the world's (0),
 * with a few degrees between: north of Panama, from the Bering Sea to Newfoundland.
 */
export function northAmerica(lat, lon) {
  return smoothstep(5, 9, lat) * smoothstep(-50, -54, lon) * smoothstep(-172, -168, lon);
}

// How wet the lowlands are all over the earth (0..255), half a degree to the cell: see tools/bake-climate.py.
const CLIMATE_URL = `${import.meta.env?.BASE_URL ?? '/'}data/climate.bin`, CW = 720, CH = 290, CLAT = 80;
let climate = null;
/** Fetch the climate grid (once, before the first world is built). Without it the rest of the world is middling everywhere. */
export async function loadClimate() {
  try {
    const r = await fetch(CLIMATE_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = new Uint8Array(await r.arrayBuffer());
    if (b.length !== CW * CH) throw new Error('not the size expected');
    climate = b;
  } catch (e) { console.warn('The climate grid could not be loaded:', e.message); }
}
/** The grid's moisture at a place (0..1), between its cells; round the earth east and west. */
function gridMoisture(lat, lon) {
  if (!climate) return 0.5;
  const fx = (lon + 180) * 2 - 0.5, fy = clamp((CLAT - lat) * 2 - 0.5, 0, CH - 1.001);
  const i = Math.floor(fx), j = fy | 0, u = fx - i, v = fy - j, i0 = ((i % CW) + CW) % CW, i1 = (i0 + 1) % CW;
  return ((climate[j * CW + i0] * (1 - u) + climate[j * CW + i1] * u) * (1 - v) + (climate[(j + 1) * CW + i0] * (1 - u) + climate[(j + 1) * CW + i1] * u) * v) / 255;
}

// The latitude at which the forest gives out into tundra, by longitude: the Aleutians and the Bering Sea coast
// are treeless far to the south, the Mackenzie carries the trees nearly to the Arctic Ocean, and Hudson Bay
// and the Labrador Sea push the line south again.
const ARCTIC = [[-172, 50], [-164, 55], [-159, 60], [-152, 66.5], [-140, 68.5], [-130, 68.5], [-115, 66], [-100, 61], [-95, 59.5], [-85, 56.5], [-78, 57], [-70, 58], [-62, 56.5], [-55, 53]];
// The temperature of an ordinary summer's day at sea level, by latitude (deg C): the tropics, the mid-latitudes
// (15.5 at 45 N), the Arctic coast a little above freezing.
const SEA_TEMP = [[8, 29], [20, 27.5], [30, 24], [38, 19.5], [45, 15.5], [52, 13], [60, 10], [66, 7], [72, 4], [80, 1]];
export const seaTempAt = (lat) => along(SEA_TEMP, Math.abs(lat));
// The tree line in the interior of the continent, by latitude (m).
const TREELINE = [[15, 4000], [35.4, 3900], [39, 3500], [48, 2500], [53, 2150], [60, 1300], [65, 800], [69, 200]];
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
  const na = northAmerica(lat, lon);
  return na >= 1 ? treelineNA(lat, lon) : na <= 0 ? treelineWorld(lat, lon) : treelineWorld(lat, lon) + (treelineNA(lat, lon) - treelineWorld(lat, lon)) * na;
}
// The latitude at which the forest gives out into tundra in the rest of the northern hemisphere, by longitude: Greenland
// and Iceland all but treeless, the Gulf Stream carrying the birches past 70 N in Norway, the larch reaching 72 N on
// the Taymyr, the cold coasts of the Bering Sea bare from the Anadyr on.
const ARCTIC_WORLD = [[-180, 64], [-172, 62], [-50, 60], [-30, 61], [-24, 64.5], [-12, 64.8], [-5, 66], [5, 69.5], [15, 70.5], [30, 70], [45, 67.5], [70, 67], [90, 70], [105, 72], [120, 71.5], [140, 70.5], [160, 69], [170, 66.5], [180, 64]];
/**
 * The tree line beyond North America: by latitude as in the interior there (which serves the Himalaya, the Tien Shan
 * and the Altai as it stands: 4,000 m in Nepal), lower where the sea rules the mountains' weather: by a quarter in
 * Europe and Japan (2,000 m in the Alps), by nearly half again in the British Isles and Iceland (700 m in Scotland),
 * and by half in the southern hemisphere outside the tropics, whose beeches and gums stop far below where northern
 * conifers would (1,400 m in New Zealand, 400 m above the Beagle Channel). South of 51.5 S only Tierra del Fuego has trees.
 */
function treelineWorld(lat, lon) {
  const a = Math.abs(lat);
  let tl = along(TREELINE, a), edge;
  if (lat < 0) { tl *= 1 - 0.5 * smoothstep(25, 40, a); edge = lon > -77 && lon < -62 ? 56.5 : 51.5; }
  else {
    const sea = Math.min(1, smoothstep(42, 30, lon) + smoothstep(128, 132, lon) * smoothstep(150, 146, lon));
    tl *= (1 - 0.24 * sea * smoothstep(30, 38, a)) * (1 - 0.45 * smoothstep(52, 58, a) * smoothstep(4, -2, lon));
    edge = along(ARCTIC_WORLD, lon);
  }
  return Math.max(-200, Math.min(tl, (edge - a) * 220));
}
function treelineNA(lat, lon) {
  const a = Math.abs(lat), crest = crestLon(a);
  let tl = along(TREELINE, a);
  if (a < 24 && lon < -150) tl = Math.min(tl, 3000);       // (the Hawaiian volcanoes stand in the dry air above the trade-wind clouds)
  tl *= 1 - 0.3 * smoothstep(42, 47, a) * (1 - smoothstep(61.5, 63.5, a)) * smoothstep(crest + 1, crest - 1, lon);
  tl -= 1500 * smoothstep(-85, -75, lon) * smoothstep(36, 44, a);
  return Math.max(-200, Math.min(tl, (along(ARCTIC, lon) - a) * 220));
}
/** The same by world z. Mirrors treeLine() in the shaders. */
export const treeline = (z) => ENV.uRegion.value.x + ENV.uRegion.value.y * (z / LAND_HALF);
/** How far the region's woods are a wet coast's, conifers down to the sea (0..1: see buildWorld). */
export const oceanWoods = () => ENV.uRegion.value.w;

// How wet the lowlands are from the Rockies to the Atlantic, by longitude: short-grass plains under the
// mountains, mixed and tall-grass prairie through the Dakotas, Nebraska and Kansas, forest from the Mississippi east.
const EAST = [[-104, 0.28], [-100, 0.33], [-97, 0.4], [-94, 0.52], [-90, 0.66], [-84, 0.72], [-70, 0.74]];

/**
 * How wet the lowlands are at a place anywhere on earth (0 desert .. 1 wet forest): North America's from the map
 * drawn by hand below, the rest of the world's from the climate grid, a few degrees of both where they meet.
 */
export function lowlandMoisture(lat, lon) {
  const na = northAmerica(lat, lon);
  return na >= 1 ? moistureNA(lat, lon) : na <= 0 ? gridMoisture(lat, lon) : gridMoisture(lat, lon) + (moistureNA(lat, lon) - gridMoisture(lat, lon)) * na;
}
/**
 * How wet the lowlands are at a place (0 desert .. 1 wet forest), from the map of North America. Under about
 * 0.42 nothing grows wild but grass and brush; from 0.6 up the country is forest. East of the Rockies the
 * humid East dries steadily westward across the plains; the corn belt from Iowa to Ohio, forest once, is
 * plowed nearly from edge to edge; the north woods and the boreal forest begin at a line that runs from the
 * Twin Cities to northwestern Minnesota and on northwest across the prairie provinces. Between the Rockies
 * and the Pacific ranges the basins are sagebrush, and desert in the south; the inland Northwest catches
 * Pacific air; west of the Cascades and the Coast Mountains, from northern California to Alaska, is rain
 * forest; California is dry but for its north coast. South of the Mexican plateau the tropics are forest
 * again, through Central America and the Caribbean. The relief adds the rest (see buildWorld).
 */
function moistureNA(lat, lon) {
  let m;
  if (lon > -104) {
    m = along(EAST, lon);
    m -= 0.16 * smoothstep(38, 40, lat) * (1 - smoothstep(42.3, 44.3, lat)) * smoothstep(-82.5, -84.5, lon) * smoothstep(0.4, 0.62, m);
    // the edge of the north woods
    const edge = along(WOODS_EDGE, lon);
    m = Math.max(m, 0.78 * smoothstep(edge - 0.5, edge + 0.5, lat));
    // the tropics: south of the Mexican plateau it is forest again, to Panama
    m = Math.max(m, 0.62 * smoothstep(20.5, 17.5, lat));
    if (lat < 13.2 && lon > -71.5 && lon < -67.5) m = 0.28;      // Aruba, Bonaire and Curaçao lie in the dry belt off Venezuela
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
    m = Math.max(m, 0.6 * smoothstep(23.5, 21.5, lat));          // Mexico's Pacific coast below the Tropic: dry forest and jungle
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
  world.args = [base, urban];
  world.base = base.height; world.water = base.water;
  const H = WORLD_HALF, terr = new Float32Array(MN * MN), moist = new Float32Array(MN * MN), tsea = new Float32Array(MN * MN), cold = new Float32Array(MN * MN), snow = new Float32Array(MN * MN), open = new Float32Array(MN * MN);
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
  // And the lowest ground within about 150 km: a valley floor far above that is a cleft in a range, not a plateau (see tsea below).
  const deep = boxBlur(minFilter(terr, MN, 73), MN, 8, 1);
  // The height up to which the ground is as warm as the lowlands (see tsea below): na: how far the place is North America's.
  const warmTo = (k, na) => { const plateau = Math.min(low[k], 2000), broad = Math.min(plateau, deep[k] + 400); return broad + (plateau - broad) * na; };
  boxBlur(open, MN, 2);                                    // 1 only well out on big water
  const c0 = toLatLon(0, 0), tl0 = treelineAt(c0.lat, c0.lon), tl1 = treelineAt(toLatLon(0, LAND_HALF).lat, c0.lon);
  // The day of the season, for the ground at the middle of the window (as the leaves there read it: see tsea below).
  { const kc = (MN >> 1) * MN + (MN >> 1); setSeasonDay(seasonDayAt(seasonKey, c0.lat, c0.lon, 0.0065 * (warmTo(kc, northAmerica(c0.lat, c0.lon)) - terr[kc]))); }
  // w: how far the region's climate is an ocean's (the wet coasts of the Northwest and Alaska), where conifers hold
  // the lowlands too. (Not the moisture itself, which the ranges raise everywhere: the hills of New England are wet
  // but their woods are maple, beech and birch.)
  ENV.uRegion.value.set(tl0, tl1 - tl0, hemisphere(), smoothstep(0.77, 0.85, lowlandMoisture(c0.lat, c0.lon)));
  for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) {
    const x = (i / (MN - 1)) * 2 * H - H, z = (j / (MN - 1)) * 2 * H - H, k = j * MN + i, ll = toLatLon(x, z);
    // Ranges are wetter than the country they stand in: forest begins a few hundred meters above the valley floor.
    moist[k] = clamp(lowlandMoisture(ll.lat, ll.lon) + 0.5 * smoothstep(150, 700, terr[k] - low[k]), 0, 1);
    // The plains and plateaux are as warm as the lowlands (the ground heats the air wherever it lies), up to
    // a point; only what stands above them is colder. So an ordinary day at an airfield's door is as warm as its
    // latitude makes the lowlands: about 15 C in Minnesota or Colorado, 27 C in the tropics, a few degrees on the Arctic coast.
    // (Beyond North America, whose high country is all plateau and basin, only as far as the high ground is broad: the
    // valley floors of the Himalaya stand two kilometers above plains a few dozen kilometers off, and are not as warm as those;
    // Tibet and the Altiplano, high for hundreds of kilometers, are warm for their height as Colorado is.)
    const shift = cold[k] = seasonShift(ll.lat, ll.lon, undefined, terr[k]);
    tsea[k] = seaTempAt(ll.lat) + shift + 0.0065 * warmTo(k, northAmerica(ll.lat, ll.lon));
    // Snow lies where the air is under about 2 C, and never lower than 650 m above the tree line on an ordinary day.
    // (In the tropics the snow line stands higher than the cold alone would put it, near 4,800 m: the volcanoes of Mexico
    // carry snow, Mauna Kea on an ordinary day does not.)
    const tropic = smoothstep(30, 20, Math.abs(ll.lat));
    // (A cold season brings the floor of that down with it.)
    snow[k] = Math.min((tsea[k] - 2.2) / 0.0065 + 900 * tropic, Math.max(treelineAt(ll.lat, ll.lon), 0) + 650 + 1200 * tropic + Math.min(shift, 0) / 0.0065);
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
  // The season's temperature at sea level, for the leaves, and how much colder or warmer than an ordinary day it is (SEASON_GLSL).
  const sd = new Uint16Array(MN * MN * 2);
  for (let k = 0; k < MN * MN; k++) { sd[k * 2] = toHalf(tsea[k]); sd[k * 2 + 1] = toHalf(cold[k]); }
  ENV.tSeason.value?.dispose();
  const st = new THREE.DataTexture(sd, MN, MN, THREE.RGFormat, THREE.HalfFloatType);
  st.minFilter = st.magFilter = THREE.LinearFilter; st.needsUpdate = true;
  ENV.tSeason.value = st;
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
