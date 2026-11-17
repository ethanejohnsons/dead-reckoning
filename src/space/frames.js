// The frames of reference of spaceflight, and where the Earth, the Moon and the sun are in them.
//
// Everything that orbits is kept in one Earth-centered inertial frame ("ECI"): x toward the March
// equinox, z toward the north celestial pole, meters, in JavaScript's double precision. This is the
// equatorial frame of world/celestial.js, so the sun, the Moon and the stars of the game's sky are the
// same ones met in orbit. The Earth is a sphere of mean radius turning under that frame once a sidereal
// day; the Moon rides a circle at its mean distance, where the sky module puts it for its phase.
//
// Time is the mission clock t (seconds). A clock is anchored to the place and moment a flight starts
// (makeClock): the day of the year, the local solar hour there, its longitude, and the Moon's phase.
// From that follow the Earth's turn (earthAngle), the sun's direction and the Moon's position at any t.
//
// The flat game world (world/geo.js: +X east, +Y up, +Z south on a Mercator window) meets this frame
// through latitude, longitude and height: geoToEci / eciToGeo, and the local east-north-up axes (enu).
// The picture is drawn in three.js's axes with the camera at the origin: toRender swaps (x, y, z) to
// (x, z, -y), so +Y is the north pole.

import { eclipticToEquatorial, sunLongitude } from '../world/celestial.js';

export const D2R = Math.PI / 180;
export const RE = 6371000;                 // the Earth's mean radius (m)
export const MU_E = 3.986004418e14;        // its gravitational parameter (m3/s2)
export const RM = 1737400;                 // the Moon
export const MU_M = 4.9048695e12;
export const MOON_A = 384400e3;            // the Moon's distance (m), held constant
export const MOON_SOI = 66.1e6;            // inside this distance of the Moon, the Moon is the body an orbit is described around
export const ATMO_TOP = 140000;            // above this there is no drag at all (m)
export const G0 = 9.80665;
const DAY = 86400, MOON_RATE = 12.19 * D2R;       // the Moon gains this much on the sun a day

/** A mission clock for a flight starting at a longitude (deg), on a day of the year, at a local solar hour, with the Moon at a phase (0 new .. 0.5 full). */
export function makeClock(lon, day, hour, moonPhase) {
  return { day, hourG0: hour - lon / 15, hour0: hour, lon0: lon, moonPhase };
}
const sunV = [1, 0, 0], moonV = [1, 0, 0];
/** Greenwich solar hour (unwrapped) at mission time t. */
const hourG = (c, t) => c.hourG0 + t / 3600;
/** The sun's direction at t: a unit vector in ECI, into out. */
export function sunDir(c, t, out) {
  eclipticToEquatorial(sunLongitude(c.day, hourG(c, t)), 0, sunV);
  out[0] = sunV[0]; out[1] = sunV[1]; out[2] = sunV[2];
  return out;
}
/** The angle (radians) the Greenwich meridian has turned from the ECI x axis at t. */
export function earthAngle(c, t) {
  eclipticToEquatorial(sunLongitude(c.day, hourG(c, t)), 0, sunV);
  return Math.atan2(sunV[1], sunV[0]) + ((hourG(c, t) - 12) / 12) * Math.PI;
}
/** The Moon's position at t (m, ECI), into out. The same Moon the sky draws: set by its phase, on an orbit tilted 5.1 degrees to the ecliptic. */
export function moonPos(c, t, out) {
  const lon = sunLongitude(c.day, hourG(c, t));
  const elong = c.moonPhase * 2 * Math.PI + ((c.hour0 - 12) / 24 + t / DAY) * MOON_RATE;
  eclipticToEquatorial(lon + elong, 5.145 * D2R * Math.sin(elong + 0.6), moonV);
  out[0] = moonV[0] * MOON_A; out[1] = moonV[1] * MOON_A; out[2] = moonV[2] * MOON_A;
  return out;
}
const mA = [0, 0, 0], mB = [0, 0, 0];
/** The Moon's velocity at t (m/s, ECI), into out. */
export function moonVel(c, t, out) {
  moonPos(c, t - 30, mA); moonPos(c, t + 30, mB);
  out[0] = (mB[0] - mA[0]) / 60; out[1] = (mB[1] - mA[1]) / 60; out[2] = (mB[2] - mA[2]) / 60;
  return out;
}

/** A place on (or over) the Earth to ECI at t. lat, lon in degrees; alt in meters above the sphere. */
export function geoToEci(c, t, lat, lon, alt, out) {
  const a = earthAngle(c, t) + lon * D2R, cl = Math.cos(lat * D2R), r = RE + alt;
  out[0] = r * cl * Math.cos(a); out[1] = r * cl * Math.sin(a); out[2] = r * Math.sin(lat * D2R);
  return out;
}
/** And back: { lat, lon (degrees, -180..180), alt (m) } of an ECI position at t. */
export function eciToGeo(c, t, r, out = {}) {
  const d = Math.hypot(r[0], r[1], r[2]);
  let lon = (Math.atan2(r[1], r[0]) - earthAngle(c, t)) / D2R;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  out.lat = Math.asin(Math.max(-1, Math.min(1, r[2] / d))) / D2R; out.lon = lon; out.alt = d - RE;
  return out;
}
/** The velocity (ECI, m/s) of the ground, or of air turning with the Earth, at an ECI position. */
export const OMEGA_E = 7.2921159e-5;
export function groundVel(r, out) { out[0] = -OMEGA_E * r[1]; out[1] = OMEGA_E * r[0]; out[2] = 0; return out; }

/**
 * The local axes at an ECI position: east, north and up as unit vectors in ECI, into a 9-element array
 * [ex, ey, ez, nx, ny, nz, ux, uy, uz]. Up is straight out from the Earth's center.
 */
export function enu(r, out) {
  const d = Math.hypot(r[0], r[1], r[2]), ux = r[0] / d, uy = r[1] / d, uz = r[2] / d;
  let ex = -uy, ey = ux; const eh = Math.hypot(ex, ey) || 1;
  ex /= eh; ey /= eh;
  out[0] = ex; out[1] = ey; out[2] = 0;
  out[3] = uy * 0 - uz * ey; out[4] = uz * ex - ux * 0; out[5] = ux * ey - uy * ex;      // north = up x east
  out[6] = ux; out[7] = uy; out[8] = uz;
  return out;
}

/** ECI to the axes the space view is drawn in (three.js: +Y the north pole). Works on arrays and on Vector3-likes. */
export const toRender = (v, out) => out.set(v[0], v[2], -v[1]);
export const fromRender = (v, out) => { out[0] = v.x; out[1] = -v.z; out[2] = v.y; return out; };

const B = new Array(9);
/**
 * The rotation that takes directions in the flat game world (+X east, +Y up, +Z south, at the ECI position r)
 * to the space view's axes, as a three.js Quaternion (into q, using the Matrix4 m as scratch).
 */
export function worldToRenderQuat(r, q, m) {
  enu(r, B);
  // Columns: where world X (east), Y (up) and Z (south = -north) go, in render axes (x, z, -y of ECI).
  m.set(
    B[0], B[6], -B[3], 0,
    B[2], B[8], -B[5], 0,
    -B[1], -B[7], B[4], 0,
    0, 0, 0, 1);
  return q.setFromRotationMatrix(m);
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const cross = (a, b, out) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; out[0] = x; out[1] = y; out[2] = z; return out; };
