// Where in the real world the game takes place, and how real coordinates map to the flat game world.
//
// The world is a square window of the earth, 524 km on a side, on a Web Mercator plane scaled to true
// meters at the window's center: +X east, +Z south, origin at the center. Scale error is about 3% at the
// north and south edges in the middle latitudes (more toward the poles: see LAT_MAX). The window can be
// anywhere on earth and can be moved (setRegion): everything built from world coordinates (elevation base,
// regional maps, airfields, terrain, chart) is then rebuilt by the game's loadWorld. It moves when another
// airfield or a place on the map is chosen, and in flight it follows the aircraft, so there is no edge to
// fly off.
//
// Around the earth: longitudes are taken the short way round from the window's center (toWorld), so a window
// that straddles the 180th meridian is as good as any other, and the map tiles' column numbers (pixelX) run
// on past the edge of the tile grid there: whoever fetches a tile wraps its column with wrapTile.

const R = 6378137, D2R = Math.PI / 180, CIRC = 2 * Math.PI * R;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.06, Math.min(85.06, lat)) * D2R) / 2));

export const WORLD_HALF = 262144;   // quadtree root and regional maps cover +/- this (m)
export const LAND_HALF = 240000;    // airfields and cities are loaded this far out from the center (m)
/** In flight the window is moved to the aircraft before it gets this far from the center (m): see main.js. */
export const RECENTER_AT = 150000;
/**
 * The window's center goes no nearer a pole than this latitude (degrees). The Mercator plane and the map and
 * elevation tiles end at 85 degrees, and a window centered at 80 already reaches 82.4 with its scale a third
 * out at that edge. Nothing can be started beyond PIN_LAT_MAX (the last latitude a window still holds with room to fly).
 */
export const LAT_MAX = 80, PIN_LAT_MAX = 81;
/** A longitude brought into -180..180. */
export const wrapLon = (lon) => lon - 360 * Math.floor((lon + 180) / 360);
/** A tile's column brought into the tile grid of its zoom (columns run on round the earth: see the top). */
export const wrapTile = (x, z) => { const n = 2 ** z; return ((x % n) + n) % n; };

// Magnetic variation: the World Magnetic Model 2025 (NOAA NCEI and the British Geological Survey, public
// domain), the main field to degree and order 12. One row of the model's file after another, degree 1 to 12,
// order 0 to the degree: g, h (nT) and their change a year. tools/bake-magvar.mjs prints this table and checks
// magVarAt against the model's test values.
const WMM_EPOCH = 2025;
const WMM = [
  -29351.8, 0, 12, 0, -1410.8, 4545.4, 9.7, -21.5, -2556.6, 0, -11.6, 0, 2951.1, -3133.6, -5.2, -27.7, 1649.3, -815.1, -8, -12.1, 1361, 0, -1.3, 0,
  -2404.1, -56.6, -4.2, 4, 1243.8, 237.5, 0.4, -0.3, 453.6, -549.5, -15.6, -4.1, 895, 0, -1.6, 0, 799.5, 278.6, -2.4, -1.1, 55.7, -133.9, -6, 4.1,
  -281.1, 212, 5.6, 1.6, 12.1, -375.6, -7, -4.4, -233.2, 0, 0.6, 0, 368.9, 45.4, 1.4, -0.5, 187.2, 220.2, 0, 2.2, -138.7, -122.9, 0.6, 0.4, -142, 43,
  2.2, 1.7, 20.9, 106.1, 0.9, 1.9, 64.4, 0, -0.2, 0, 63.8, -18.4, -0.4, 0.3, 76.9, 16.8, 0.9, -1.6, -115.7, 48.8, 1.2, -0.4, -40.9, -59.8, -0.9, 0.9,
  14.9, 10.9, 0.3, 0.7, -60.7, 72.7, 0.9, 0.9, 79.5, 0, 0, 0, -77, -48.9, -0.1, 0.6, -8.8, -14.4, -0.1, 0.5, 59.3, -1, 0.5, -0.8, 15.8, 23.4, -0.1, 0,
  2.5, -7.4, -0.8, -1, -11.1, -25.1, -0.8, 0.6, 14.2, -2.3, 0.8, -0.2, 23.2, 0, -0.1, 0, 10.8, 7.1, 0.2, -0.2, -17.5, -12.6, 0, 0.5, 2, 11.4, 0.5,
  -0.4, -21.7, -9.7, -0.1, 0.4, 16.9, 12.7, 0.3, -0.5, 15, 0.7, 0.2, -0.6, -16.8, -5.2, 0, 0.3, 0.9, 3.9, 0.2, 0.2, 4.6, 0, 0, 0, 7.8, -24.8, -0.1,
  -0.3, 3, 12.2, 0.1, 0.3, -0.2, 8.3, 0.3, -0.3, -2.5, -3.3, -0.3, 0.3, -13.1, -5.2, 0, 0.2, 2.4, 7.2, 0.3, -0.1, 8.6, -0.6, -0.1, -0.2, -8.7, 0.8,
  0.1, 0.4, -12.9, 10, -0.1, 0.1, -1.3, 0, 0.1, 0, -6.4, 3.3, 0, 0, 0.2, 0, 0.1, 0, 2, 2.4, 0.1, -0.2, -1, 5.3, 0, 0.1, -0.6, -9.1, -0.3, -0.1, -0.9,
  0.4, 0, 0.1, 1.5, -4.2, -0.1, 0, 0.9, -3.8, -0.1, -0.1, -2.7, 0.9, 0, 0.2, -3.9, -9.1, 0, 0, 2.9, 0, 0, 0, -1.5, 0, 0, 0, -2.5, 2.9, 0, 0.1, 2.4,
  -0.6, 0, 0, -0.6, 0.2, 0, 0.1, -0.1, 0.5, -0.1, 0, -0.6, -0.3, 0, 0, -0.1, -1.2, 0, 0.1, 1.1, -1.7, -0.1, 0, -1, -2.9, -0.1, 0, -0.2, -1.8, -0.1, 0,
  2.6, -2.3, -0.1, 0, -2, 0, 0, 0, -0.2, -1.3, 0, 0, 0.3, 0.7, 0, 0, 1.2, 1, 0, -0.1, -1.3, -1.4, 0, 0.1, 0.6, 0, 0, 0, 0.6, 0.6, 0.1, 0, 0.5, -0.1,
  0, 0, -0.1, 0.8, 0, 0, -0.4, 0.1, 0, 0, -0.2, -1, -0.1, 0, -1.3, 0.1, 0, 0, -0.7, 0.2, -0.1, -0.1,
];
/** The date the game's compass is set for (a decimal year). */
const MAG_YEAR = 2026.5;
// Schmidt semi-normalized Legendre functions P(n, m) and their derivatives by latitude, at index n * 13 + m.
const WP = new Float64Array(169), WD = new Float64Array(169);
/**
 * Magnetic variation (degrees east) at a place anywhere on earth, at sea level: the declination of the World
 * Magnetic Model there. (Near the magnetic poles the needle is of little use; the number is still the model's.)
 */
export function magVarAt(lat, lon, year = MAG_YEAR, altKm = 0, dp = 1) {
  const a = 6378.137, e2 = 0.00669437999014, re = 6371.2, dt = year - WMM_EPOCH;
  const phi = Math.max(-89.99, Math.min(89.99, lat)) * D2R, lam = lon * D2R, sp = Math.sin(phi), cp = Math.cos(phi);
  // geodetic to geocentric
  const rc = a / Math.sqrt(1 - e2 * sp * sp), p = (rc + altKm) * cp, zz = (rc * (1 - e2) + altKm) * sp, r = Math.hypot(p, zz);
  const x = zz / r, c = p / r;                         // sine and cosine of the geocentric latitude
  WP[0] = 1; WD[0] = 0;
  for (let n = 1; n <= 12; n++) {
    for (let m = 0; m <= n; m++) {
      const k = n * 13 + m;
      if (m === n) {
        const f = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n)), q = (n - 1) * 13 + m - 1;
        WP[k] = f * c * WP[q]; WD[k] = f * (c * WD[q] - x * WP[q]);
      } else {
        const q = (n - 1) * 13 + m, q2 = (n - 2) * 13 + m, s = Math.sqrt(n * n - m * m), t = n > 1 && m <= n - 2 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0;
        WP[k] = ((2 * n - 1) * x * WP[q] - (t ? t * WP[q2] : 0)) / s;
        WD[k] = ((2 * n - 1) * (x * WD[q] + c * WP[q]) - (t ? t * WD[q2] : 0)) / s;
      }
    }
  }
  let X = 0, Y = 0, Z = 0, i = 0, pw = (re / r) * (re / r);
  for (let n = 1; n <= 12; n++) {
    pw *= re / r;
    for (let m = 0; m <= n; m++, i += 4) {
      const g = WMM[i] + WMM[i + 2] * dt, h = WMM[i + 1] + WMM[i + 3] * dt, cm = Math.cos(m * lam), sm = Math.sin(m * lam), k = n * 13 + m;
      X -= pw * (g * cm + h * sm) * WD[k];
      Y += pw * m * (g * sm - h * cm) * WP[k];
      Z -= (n + 1) * pw * (g * cm + h * sm) * WP[k];
    }
  }
  Y /= c;
  // back to the geodetic frame: the north component turns by the difference of the two latitudes
  const d = Math.asin(x) - phi, north = X * Math.cos(d) - Z * Math.sin(d), q = 10 ** dp;
  return Math.round((Math.atan2(Y, north) / D2R) * q) / q;
}

export const REGION = {
  name: 'Earth',
  title: 'Minnesota · United States',      // shown above the game's name on the title screen
  lat0: 44.88, lon0: -93.22,
  magVar: 0,                               // degrees east; compass heading = true - magVar
};

let K = 1, MX0 = 0, MY0 = 0;
/** Move the window: its center goes to (lat0, lon0), no nearer a pole than LAT_MAX. World coordinates mean something else from here on. */
export function setRegion(lat0, lon0, title) {
  lat0 = Math.max(-LAT_MAX, Math.min(LAT_MAX, lat0)); lon0 = wrapLon(lon0);
  REGION.lat0 = lat0; REGION.lon0 = lon0;
  if (title) REGION.title = title;
  REGION.magVar = magVarAt(lat0, lon0);
  K = Math.cos(lat0 * D2R); MX0 = R * lon0 * D2R; MY0 = mercY(lat0);
}
setRegion(REGION.lat0, REGION.lon0);

/** +1 in the northern hemisphere (the pole lies toward -Z and the midday sun toward +Z), -1 in the southern. */
export const hemisphere = () => (REGION.lat0 >= 0 ? 1 : -1);

/** World position of a place: the copy of it nearest the window's center, going round the earth either way. */
export function toWorld(lat, lon) {
  const d = lon - REGION.lon0;
  return { x: R * (d - 360 * Math.round(d / 360)) * D2R * K, z: -(mercY(lat) - MY0) * K };
}
export function toLatLon(x, z) {
  const my = MY0 - z / K;
  return { lat: (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / D2R, lon: wrapLon((MX0 + x / K) / R / D2R) };
}
/** World meters per true meter on the ground at a latitude (1 at the window's center). */
export const scaleAt = (lat) => K / Math.cos(lat * D2R);
/** How far round the earth is in world meters: the world repeats at this distance east and west. */
export const worldAround = () => CIRC * K;

// Slippy-map pixel coordinates (256 px tiles) are an affine function of world x/z. (Not wrapped: east of the
// 180th meridian the columns run on past the last of the grid, and west of it below zero: see wrapTile.)
/** Meters of world per tile pixel at zoom z. */
export const metersPerPixel = (z) => (CIRC * K) / (256 * 2 ** z);
/** Continuous global pixel coordinates at zoom z for a world position. */
export const pixelX = (x, z) => ((MX0 + x / K + Math.PI * R) / CIRC) * 256 * 2 ** z;
export const pixelY = (zw, z) => ((Math.PI * R - MY0 + zw / K) / CIRC) * 256 * 2 ** z;
/** And back: world x and z of global pixel coordinates at zoom z. */
export const worldX = (px, z) => ((px / (256 * 2 ** z)) * CIRC - Math.PI * R - MX0) * K;
export const worldZ = (py, z) => ((py / (256 * 2 ** z)) * CIRC - Math.PI * R + MY0) * K;
