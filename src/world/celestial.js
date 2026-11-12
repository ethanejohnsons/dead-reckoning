// Where the sun, the moon and the stars are, for a latitude, a day of the year and a local solar hour.
//
// The game keeps solar time: the sun is due south at 12:00 whatever the longitude (no time zones, no
// equation of time). Everything else follows from that on one celestial sphere, so the stars turn round
// the pole, the moon keeps its place among them and its phase is the angle it stands from the sun.
// Low precision on purpose: a mean sun on a circular orbit and a moon set by its phase are good to a
// degree or two, which is all the eye can check from a cockpit.

const D2R = Math.PI / 180;
export const OBLIQUITY = 23.4393 * D2R;
const CE = Math.cos(OBLIQUITY), SE = Math.sin(OBLIQUITY);
export const MARCH_EQUINOX = 79.5;          // day of the year (20 March): sunrise at 06:00 due east, sunset at 18:00 due west

/** Ecliptic longitude and latitude (radians) to a unit vector in equatorial coordinates (x to RA 0h, z to the north pole). */
export function eclipticToEquatorial(lon, lat, out) {
  const cb = Math.cos(lat), sb = Math.sin(lat), x = cb * Math.cos(lon), y = cb * Math.sin(lon);
  out[0] = x; out[1] = y * CE - sb * SE; out[2] = y * SE + sb * CE;
  return out;
}

/** The sun's ecliptic longitude (radians) on a day of the year, hour of the day included. */
export function sunLongitude(day, hour = 12) {
  return ((day + (hour - 12) / 24 - MARCH_EQUINOX) / 365.2422) * 2 * Math.PI;
}

/**
 * The rotation that takes equatorial unit vectors to the game world (+X east, +Y up, +Z south) for an
 * observer at a latitude at a local sidereal time (both radians). Fills a 9-element array, row-major.
 */
export function equatorialToWorld(lat, lst, m) {
  const sp = Math.sin(lat), cp = Math.cos(lat), sl = Math.sin(lst), cl = Math.cos(lst);
  m[0] = -sl; m[1] = cl; m[2] = 0;                    // east
  m[3] = cp * cl; m[4] = cp * sl; m[5] = sp;          // up
  m[6] = sp * cl; m[7] = sp * sl; m[8] = -cp;         // south
  return m;
}
export function rotate(m, v, out) {
  const x = v[0], y = v[1], z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z; out[1] = m[3] * x + m[4] * y + m[5] * z; out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

const sunEq = [1, 0, 0], moonEq = [1, 0, 0], poleEq = [0, 0, 1];

/**
 * The sky for a moment. lat: degrees; day: day of the year; hour: local solar time 0..24;
 * moonPhase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter (the phase at 12:00 that day).
 * Writes into `out`: sun, moon and pole as world unit vectors [x, y, z], the equatorial-to-world matrix m,
 * and the moon's numbers: elongation (rad), lit fraction, illuminance outside the atmosphere (lux), and
 * earthshine 0..1 (how full the Earth looks from the moon).
 */
export function skyAt(lat, day, hour, moonPhase, out) {
  const lon = sunLongitude(day, hour);
  eclipticToEquatorial(lon, 0, sunEq);
  const raSun = Math.atan2(sunEq[1], sunEq[0]);
  const lst = raSun + ((hour - 12) / 12) * Math.PI;       // the sun's hour angle is the solar time past noon
  equatorialToWorld(lat * D2R, lst, out.m);
  rotate(out.m, sunEq, out.sun);
  rotate(out.m, poleEq, out.pole);

  // The moon stands `elong` east of the sun along the ecliptic and gains 12.19 degrees on it a day. Its
  // orbit is tilted 5.1 degrees to the ecliptic; the node is put where a waxing moon rides a little high.
  const elong = moonPhase * 2 * Math.PI + ((hour - 12) / 24) * 12.19 * D2R;
  const mlon = lon + elong, mlat = 5.145 * D2R * Math.sin(mlon - lon + 0.6);
  eclipticToEquatorial(mlon, mlat, moonEq);
  rotate(out.m, moonEq, out.moon);
  const cosE = out.sun[0] * out.moon[0] + out.sun[1] * out.moon[1] + out.sun[2] * out.moon[2];
  const alpha = Math.acos(Math.max(-1, Math.min(1, -cosE))) / D2R;       // phase angle: 0 at full, 180 at new
  out.elong = Math.acos(Math.max(-1, Math.min(1, cosE)));
  out.lit = (1 - cosE) / 2;
  // Brightness against phase (Allen's Astrophysical Quantities): the moon is far from a matt ball. At the
  // quarters it gives a tenth of the full moon's light, not half. 0.32 lux is a full moon overhead with no air.
  out.moonLux = 0.32 * Math.pow(10, -0.4 * (0.026 * alpha + 4e-9 * alpha ** 4));
  out.earthshine = (1 + cosE) / 2;
  out.lst = lst;
  return out;
}

export const makeSky = () => ({ sun: [0, 1, 0], moon: [0, 1, 0], pole: [0, 0, 1], m: new Array(9).fill(0), elong: 0, lit: 1, moonLux: 0, earthshine: 0, lst: 0 });

/** Sunrise and sunset (local solar hours) at a latitude on a day of the year; null where the sun does not rise or set. */
export function sunTimes(lat, day) {
  const dec = Math.asin(SE * Math.sin(sunLongitude(day)));
  const c = -Math.tan(lat * D2R) * Math.tan(dec);
  if (c <= -1 || c >= 1) return null;
  const h = (Math.acos(c) / Math.PI) * 12;
  return { rise: 12 - h, set: 12 + h };
}
