// Where in the real world the game takes place, and how real coordinates map to the flat game world.
//
// The world is a square window of the earth, 524 km on a side, on a Web Mercator plane scaled to true
// metres at the window's centre: +X east, +Z south, origin at the centre. Scale error is about 3% at the
// north and south edges. The window can be moved (setRegion): everything built from world coordinates
// (elevation base, regional maps, airfields, terrain, chart) is then rebuilt by the game's loadWorld.

const R = 6378137, D2R = Math.PI / 180, CIRC = 2 * Math.PI * R;
const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));

export const WORLD_HALF = 262144;   // quadtree root and regional maps cover +/- this (m)
export const LAND_HALF = 240000;    // charted area

/**
 * Magnetic variation (degrees east) for the middle of North America, good to about a degree between the
 * Great Lakes and the northern Rockies in the 2020s: the agonic line runs down through Minnesota, with
 * easterly variation growing to the west and westerly to the east.
 */
export function magVarAt(lat, lon) {
  const d = lon + 93.5;
  return Math.round((d < 0 ? -0.63 * d : -0.68 * d - 0.025 * Math.min(d, 10) * (lat - 42)) * 10) / 10;
}

export const REGION = {
  name: 'the United States',
  title: 'Minnesota · United States',      // shown above the game's name on the title screen
  lat0: 44.88, lon0: -93.22,
  magVar: 0,                               // degrees east; compass heading = true - magVar
};

let K = 1, MX0 = 0, MY0 = 0;
/** Move the window: its centre goes to (lat0, lon0). World coordinates mean something else from here on. */
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
/** World metres per true metre on the ground at a latitude (1 at the window's centre). */
export const scaleAt = (lat) => K / Math.cos(lat * D2R);

// Slippy-map pixel coordinates (256 px tiles) are an affine function of world x/z.
/** Metres of world per tile pixel at zoom z. */
export const metresPerPixel = (z) => (CIRC * K) / (256 * 2 ** z);
/** Continuous global pixel coordinates at zoom z for a world position. */
export const pixelX = (x, z) => ((MX0 + x / K + Math.PI * R) / CIRC) * 256 * 2 ** z;
export const pixelY = (zw, z) => ((Math.PI * R - MY0 + zw / K) / CIRC) * 256 * 2 ** z;
