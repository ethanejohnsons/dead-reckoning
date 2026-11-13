// Where in the real world the game takes place, and how real coordinates map to the flat game world.
//
// The world is a square window of the earth, 524 km on a side, on a Web Mercator plane scaled to true
// meters at the window's center: +X east, +Z south, origin at the center. Scale error is about 3% at the
// north and south edges (more in the Arctic). The window can be moved (setRegion): everything built from
// world coordinates (elevation base, regional maps, airfields, terrain, chart) is then rebuilt by the game's
// loadWorld. It moves when another airfield or a place on the map is chosen, and in flight it follows the
// aircraft, so there is no edge to fly off.

const R = 6378137, D2R = Math.PI / 180, CIRC = 2 * Math.PI * R;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));

export const WORLD_HALF = 262144;   // quadtree root and regional maps cover +/- this (m)
export const LAND_HALF = 240000;    // airfields and cities are loaded this far out from the center (m)
/** In flight the window is moved to the aircraft before it gets this far from the center (m): see main.js. */
export const RECENTER_AT = 150000;

// Magnetic variation (degrees east) around North America in the mid-2020s, read off the World Magnetic Model
// at places spread over the continent: [lat, lon, variation]. Good to a degree or two, which is all a
// compass card and a runway number need.
const MAGVAR = [
  [47.5, -122.3, 15.2], [47.6, -117.5, 14.0], [45.6, -122.6, 14.6], [42.4, -122.9, 13.9], [40.9, -124.1, 13.8], [37.6, -122.4, 12.8],
  [36.8, -119.7, 12.4], [33.9, -118.4, 11.3], [32.7, -117.2, 10.8], [39.5, -119.8, 12.7], [36.1, -115.2, 10.9], [40.8, -115.8, 12.0],
  [43.6, -116.2, 12.6], [43.5, -112.1, 11.4], [40.8, -112.0, 10.7], [37.1, -113.5, 10.6], [33.4, -112.0, 9.6], [32.1, -110.9, 9.0],
  [35.1, -111.7, 9.8], [35.0, -106.6, 7.9], [31.8, -106.4, 7.2], [37.2, -107.8, 8.5], [39.9, -104.7, 7.4], [41.2, -104.8, 7.6],
  [42.9, -106.5, 8.4], [45.8, -108.5, 9.6], [47.5, -111.4, 11.5], [48.3, -114.3, 13.0], [46.9, -114.1, 12.5], [43.6, -110.7, 10.6],
  [46.8, -100.7, 4.6], [48.3, -103.8, 7.0], [44.0, -103.1, 6.6], [46.9, -96.8, 2.0], [44.9, -93.2, -0.1], [46.8, -92.2, -1.6],
  [48.6, -93.4, -0.3], [41.3, -95.9, 2.0], [39.3, -94.7, 1.4], [37.6, -97.4, 2.9], [37.8, -100.0, 4.5], [35.2, -101.7, 5.6],
  [33.7, -101.8, 5.4], [31.9, -102.2, 5.6], [35.4, -97.6, 3.0], [32.9, -97.0, 2.4], [30.2, -97.7, 3.0], [29.5, -98.5, 3.4],
  [29.9, -95.3, 1.7], [25.9, -97.4, 2.8], [27.8, -97.5, 2.6], [41.5, -93.7, 0.6], [38.7, -90.4, -1.6], [42.0, -87.9, -4.0],
  [44.5, -88.1, -4.0], [46.4, -87.4, -5.2], [46.3, -84.5, -8.0], [42.2, -83.4, -7.6], [39.7, -86.3, -5.2], [35.0, -90.0, -1.6],
  [34.7, -92.2, -0.4], [30.0, -90.3, -1.0], [32.3, -90.1, -1.6], [30.7, -88.2, -2.9], [33.6, -86.8, -4.2], [36.1, -86.7, -4.2],
  [38.2, -85.7, -5.6], [39.0, -84.7, -6.3], [41.4, -81.8, -8.6], [40.0, -82.9, -7.5], [40.5, -80.2, -9.5], [33.6, -84.4, -5.8],
  [32.1, -81.2, -7.4], [30.5, -81.7, -6.9], [28.0, -82.5, -6.2], [25.8, -80.3, -7.6], [24.6, -81.8, -6.5], [32.9, -80.0, -8.3],
  [35.2, -80.9, -8.2], [35.9, -78.8, -9.6], [36.9, -76.2, -11.2], [38.9, -77.0, -10.9], [39.9, -75.2, -12.3], [40.6, -73.8, -12.9],
  [42.9, -78.7, -10.9], [42.7, -73.8, -13.6], [42.4, -71.0, -14.4], [44.5, -73.2, -14.3], [43.6, -70.3, -15.2], [44.8, -68.8, -16.0],
  [46.7, -68.0, -16.8], [44.9, -63.5, -17.0], [46.2, -60.0, -17.8], [47.6, -52.8, -17.9], [48.9, -54.6, -18.5], [53.3, -60.4, -19.5],
  [46.1, -64.7, -17.0], [46.8, -71.4, -15.5], [45.5, -73.7, -14.0], [45.3, -75.7, -13.2], [43.7, -79.6, -10.6], [46.6, -80.8, -10.0],
  [48.6, -81.4, -10.2], [48.4, -89.3, -3.4], [49.9, -97.2, 2.2], [58.7, -94.1, -1.5], [50.4, -104.7, 7.4], [52.2, -106.7, 9.0],
  [51.1, -114.0, 13.2], [53.3, -113.6, 13.2], [56.7, -111.2, 12.2], [49.2, -123.2, 15.4], [53.9, -122.7, 16.3], [54.3, -130.4, 17.8],
  [60.7, -135.1, 17.9], [64.0, -139.1, 18.5], [62.5, -114.4, 15.0], [68.3, -133.5, 19.5], [65.3, -126.8, 18.5], [69.1, -105.1, 3.0],
  [74.7, -95.0, -13.0], [63.8, -68.6, -23.5], [58.1, -68.4, -21.5], [62.8, -92.1, -4.0], [51.3, -80.6, -10.5], [50.2, -66.3, -18.2],
  [48.8, -64.5, -18.3], [55.2, -105.3, 7.5], [55.8, -97.9, 1.5], [54.0, -101.1, 4.5], [61.2, -150.0, 14.3], [64.8, -147.9, 15.2],
  [58.4, -134.6, 17.4], [55.4, -131.7, 17.3], [57.0, -135.4, 17.2], [59.5, -139.7, 17.0], [57.8, -152.5, 12.7], [64.5, -165.4, 7.5],
  [66.9, -162.6, 9.5], [60.8, -161.8, 9.0], [71.3, -156.8, 12.5], [70.2, -148.5, 16.0], [53.9, -166.5, 5.5], [21.3, -157.9, 9.3],
  [19.7, -155.0, 9.2], [22.0, -159.3, 9.4], [19.4, -99.1, 4.0], [23.1, -82.4, -5.5], [25.0, -77.5, -8.5], [32.4, -64.7, -14.5],
  [25.8, -100.1, 4.5], [29.1, -111.0, 8.8], [24.1, -110.4, 8.2],
  [20.7, -105.2, 6.6], [16.8, -99.8, 4.6], [17.0, -96.7, 3.2], [21.0, -89.7, 0.3], [21.0, -86.9, -1.8], [14.6, -90.5, 0.8], [13.4, -89.1, 0.2],
  [14.1, -87.2, -0.8], [12.1, -86.2, -0.8], [10.0, -84.2, -1.4], [9.1, -79.4, -3.8], [19.3, -81.4, -4.6], [18.0, -76.8, -7.6], [18.6, -72.3, -10.2],
  [18.4, -69.7, -11.8], [18.4, -66.0, -13.3], [18.0, -63.1, -14.4], [16.3, -61.5, -15.0], [13.1, -59.5, -15.6], [10.6, -61.3, -15.0], [12.2, -69.0, -11.2],
];
/** Magnetic variation (degrees east) at a place: the listed values, each weighted by the inverse fourth power of its distance. */
export function magVarAt(lat, lon) {
  const c = Math.cos(lat * D2R);
  let s = 0, w = 0;
  for (let i = 0; i < MAGVAR.length; i++) {
    const m = MAGVAR[i], dy = m[0] - lat, dx = (m[1] - lon) * c, d2 = dx * dx + dy * dy + 0.05, k = 1 / (d2 * d2);
    s += m[2] * k; w += k;
  }
  return Math.round((s / w) * 10) / 10;
}

export const REGION = {
  name: 'North America',
  title: 'Minnesota · United States',      // shown above the game's name on the title screen
  lat0: 44.88, lon0: -93.22,
  magVar: 0,                               // degrees east; compass heading = true - magVar
};

let K = 1, MX0 = 0, MY0 = 0;
/** Move the window: its center goes to (lat0, lon0). World coordinates mean something else from here on. */
export function setRegion(lat0, lon0, title) {
  REGION.lat0 = lat0; REGION.lon0 = lon0;
  if (title) REGION.title = title;
  REGION.magVar = magVarAt(lat0, lon0);
  K = Math.cos(lat0 * D2R); MX0 = R * lon0 * D2R; MY0 = mercY(lat0);
}
setRegion(REGION.lat0, REGION.lon0);

/** +1 in the northern hemisphere (the pole lies toward -Z and the midday sun toward +Z), -1 in the southern. */
export const hemisphere = () => (REGION.lat0 >= 0 ? 1 : -1);

export function toWorld(lat, lon) {
  return { x: (R * lon * D2R - MX0) * K, z: -(mercY(lat) - MY0) * K };
}
export function toLatLon(x, z) {
  const my = MY0 - z / K;
  return { lat: (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / D2R, lon: (MX0 + x / K) / R / D2R };
}
/** World meters per true meter on the ground at a latitude (1 at the window's center). */
export const scaleAt = (lat) => K / Math.cos(lat * D2R);

// Slippy-map pixel coordinates (256 px tiles) are an affine function of world x/z.
/** Meters of world per tile pixel at zoom z. */
export const metersPerPixel = (z) => (CIRC * K) / (256 * 2 ** z);
/** Continuous global pixel coordinates at zoom z for a world position. */
export const pixelX = (x, z) => ((MX0 + x / K + Math.PI * R) / CIRC) * 256 * 2 ** z;
export const pixelY = (zw, z) => ((Math.PI * R - MY0 + zw / K) / CIRC) * 256 * 2 ** z;
/** And back: world x and z of global pixel coordinates at zoom z. */
export const worldX = (px, z) => ((px / (256 * 2 ** z)) * CIRC - Math.PI * R - MX0) * K;
export const worldZ = (py, z) => ((py / (256 * 2 ** z)) * CIRC - Math.PI * R + MY0) * K;
