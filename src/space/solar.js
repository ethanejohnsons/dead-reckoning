// The solar system: where the sun and the planets are, and their picture in the view from space.
//
// Where. Everything in space/ lives in the Earth-centered frame of frames.js, so the Earth stays at the origin
// and the sun and the planets go round it: the sun where the game's sky puts it (one astronomical unit away),
// each planet on its real ellipse round the sun (the Jet Propulsion Laboratory's "approximate positions of the
// planets": six elements and their drift per century, good to a fraction of a degree for these centuries) for
// the day of the year the flight began on, in the present year. Each world turns about its real pole at its
// real rate (the International Astronomical Union's figures), so Saturn's rings tilt as they do and Uranus
// lies on its side. The big moons of Jupiter and Saturn go round their planets in the plane of the planet's
// equator, at their real distances and in their real times, each keeping one face to its planet; where along
// its orbit each one is, is not its real place (the three inner moons of Jupiter do keep their real step with
// one another: never all three on one side).
//
// The picture. cosmos.js draws the Earth and the Moon itself; this module draws the rest, and the Earth and
// the Moon too once they are specks:
//   - A world too small to show a disk is a point of light among the stars, as bright as it is in the sky.
//   - One that shows a disk is ray-traced, a pixel at a time, inside a rectangle fitted round it: an
//     ellipsoid (Jupiter and Saturn are visibly flattened) wearing its map (public/data/planets/, baked by
//     tools/bake-planets.py; the moons' by tools/bake-moons.py from NASA's models of them), lit by the sun from where the sun really stands, with a rim of air where it has
//     air. The maps are fetched when a world is first near enough to need one.
//   - Saturn's rings are a plane through its equator, their color and opacity read along the radius from a
//     strip; the globe's shadow falls on them and theirs on the globe, and from the dark side they show by
//     the light that comes through them.
//   - The sun is drawn as cosmos.js always drew it, but where it stands from the camera and as large as it
//     looks from there (sunGlow below, shared with that shader).
// The arithmetic is done in units of the world's radius, about the point of the ray nearest its center, so
// single precision holds from a low orbit out to where the disk is a pixel across.
//
// Light. The sun's light thins with distance, though much less than it really does (sunlight() below): at
// Neptune the true figure is a nine-hundredth of the Earth's, which no picture exposed for the Earth could
// show. frame() also works out the light for things with shape (the craft): which way the sun is from the
// camera, whether a world's shadow covers it, and the nearest world's glow.

import * as THREE from 'three';
import { fsMaterial, FullscreenQuad } from '../render/fullscreen.js';
import { STAR_LUX } from '../world/stars.js';
import { OBLIQUITY } from '../world/celestial.js';
import { RE, RM, MU_E, MU_M, D2R, sunDir, moonPos } from './frames.js';

export const AU = 149597870700, LIGHT = 299792458;
export const SOLAR_CREDIT = 'The planets: Solar System Scope (CC BY 4.0), from NASA imagery. Their moons: NASA Visualization Technology Applications and Development (VTAD)';
const CE = Math.cos(OBLIQUITY), SE = Math.sin(OBLIQUITY);
const STAR_GAIN = 3;                        // (world/stars.js draws a point of light this much brighter than a pixel would show it)
const DISK_PX = 1.2;                        // a world this many pixels in radius, or more, is drawn as a disk
const MAP_URL = `${import.meta.env.BASE_URL}data/planets/`;

// el: semi-major axis (AU), eccentricity, inclination, mean longitude, longitude of perihelion, of the ascending node
// (degrees), then the change of each per century, from J2000. pole: right ascension and declination of the north pole
// (degrees); spin: the prime meridian's angle at J2000 and its turn per day (degrees). R: equatorial radius (m), f:
// flattening, mu: gravitational parameter (m3/s2). H: brightness at 1 AU from sun and eye, fully lit (magnitudes).
// color: its look where the map does not reach (linear). air: the rim of scattered light (color, strength).
// near: how close, in radii from the center, a ship comes out of warp; low: the lowest it may fly, in radii above the surface.
export const BODIES = [
  { id: 'sun', name: 'the Sun', R: 695700e3, mu: 1.32712440018e20, pole: [286.13, 63.87], spin: [84.176, 14.1844], color: [1, 0.95, 0.85], near: 9, low: 1.2 },
  { id: 'mercury', name: 'Mercury', R: 2439.7e3, mu: 2.2032e13, pole: [281.01, 61.41], spin: [329.5469, 6.1385025], H: -0.6, color: [0.2, 0.19, 0.18], map: 'mercury.jpg', gain: 0.75, near: 4.5, low: 0.012,
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  { id: 'venus', name: 'Venus', R: 6051.8e3, mu: 3.24859e14, pole: [272.76, 67.16], spin: [160.20, -1.4813688], H: -4.4, color: [0.75, 0.66, 0.45], map: 'venus.jpg', gain: 1.0, gas: 1, air: [1.0, 0.86, 0.6, 0.5], near: 4.5, low: 0.03,
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  { id: 'earth', name: 'the Earth', R: RE, mu: MU_E, H: -3.86, color: [0.32, 0.45, 0.75], shine: [0.55, 0.72, 1.0], sky: [0.32, 0.42, 0.6], near: 4.2, low: 0 },
  { id: 'moon', name: 'the Moon', R: RM, mu: MU_M, H: 0.21, color: [0.3, 0.3, 0.3], near: 4.5, low: 0.004 },
  { id: 'mars', name: 'Mars', R: 3396.2e3, f: 0.00589, mu: 4.282837e13, pole: [317.68, 52.89], spin: [176.630, 350.89198226], H: -1.52, color: [0.5, 0.22, 0.1], map: 'mars.jpg', gain: 1.0, air: [0.85, 0.55, 0.38, 0.22], near: 4.5, low: 0.012,
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { id: 'jupiter', name: 'Jupiter', R: 71492e3, f: 0.06487, mu: 1.26686534e17, pole: [268.06, 64.50], spin: [284.95, 870.5360000], H: -9.4, color: [0.55, 0.45, 0.33], map: 'jupiter.jpg', gain: 1.0, gas: 1, air: [0.75, 0.7, 0.6, 0.18], near: 4.2, low: 0.03,
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  { id: 'saturn', name: 'Saturn', R: 60268e3, f: 0.09796, mu: 3.7931187e16, pole: [40.59, 83.54], spin: [38.90, 810.7939024], H: -8.88, color: [0.62, 0.52, 0.34], map: 'saturn.jpg', gain: 1.0, gas: 1, air: [0.8, 0.72, 0.55, 0.18], near: 5.6, low: 0.03,
    ring: { in: 70951e3 / 60268e3, out: 140917e3 / 60268e3, map: 'saturn_rings.png', gain: 3.4 },
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  { id: 'uranus', name: 'Uranus', R: 25559e3, f: 0.0229, mu: 5.793939e15, pole: [257.31, -15.18], spin: [203.81, -501.1600928], H: -7.19, color: [0.45, 0.68, 0.72], map: 'uranus.jpg', gain: 1.0, gas: 1, air: [0.55, 0.85, 0.9, 0.3], near: 4.5, low: 0.03,
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  { id: 'neptune', name: 'Neptune', R: 24764e3, f: 0.0171, mu: 6.836529e15, pole: [299.36, 43.46], spin: [253.18, 536.3128492], H: -6.87, color: [0.2, 0.32, 0.75], map: 'neptune.jpg', gain: 1.0, gas: 1, air: [0.35, 0.5, 1.0, 0.35], near: 4.5, low: 0.03,
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
  // The moons. orb: the planet, the orbit's radius (m), its period (days), where along it the moon was at J2000 (degrees
  // from the node of the planet's equator: not its real place, see above), and the orbit's tilt to that equator (degrees).
  // A moon's map has the middle of the face it keeps to its planet in its own middle, east to the right (tools/bake-moons.py).
  { id: 'io', name: 'Io', R: 1821.6e3, mu: 5.9599e12, H: -1.68, color: [0.62, 0.52, 0.22], map: 'io.jpg', gain: 1, near: 4.5, low: 0.012, orb: { about: 'jupiter', a: 421.8e6, P: 1.769138, L0: 106, inc: 0 } },
  { id: 'europa', name: 'Europa', R: 1560.8e3, mu: 3.2027e12, H: -1.41, color: [0.6, 0.56, 0.48], map: 'europa.jpg', gain: 1, near: 4.5, low: 0.012, orb: { about: 'jupiter', a: 671.1e6, P: 3.551181, L0: 176, inc: 0 } },
  { id: 'ganymede', name: 'Ganymede', R: 2634.1e3, mu: 9.8878e12, H: -2.09, color: [0.4, 0.37, 0.33], map: 'ganymede.jpg', gain: 1, near: 4.5, low: 0.012, orb: { about: 'jupiter', a: 1070.4e6, P: 7.154553, L0: 301, inc: 0 } },
  { id: 'callisto', name: 'Callisto', R: 2410.3e3, mu: 7.1793e12, H: -1.05, color: [0.24, 0.21, 0.18], map: 'callisto.jpg', gain: 1, near: 4.5, low: 0.012, orb: { about: 'jupiter', a: 1882.7e6, P: 16.689017, L0: 87, inc: 0 } },
  { id: 'mimas', name: 'Mimas', R: 198.2e3, mu: 2.503e9, H: 3.3, color: [0.55, 0.55, 0.55], map: 'mimas.jpg', gain: 1, near: 4.5, low: 0.03, orb: { about: 'saturn', a: 185.54e6, P: 0.942422, L0: 14, inc: 0 } },
  { id: 'enceladus', name: 'Enceladus', R: 252.1e3, mu: 7.211e9, H: 2.1, color: [0.85, 0.87, 0.9], map: 'enceladus.jpg', gain: 1, near: 4.5, low: 0.03, orb: { about: 'saturn', a: 238.04e6, P: 1.370218, L0: 200, inc: 0 } },
  { id: 'tethys', name: 'Tethys', R: 531.1e3, mu: 4.121e10, H: 0.6, color: [0.7, 0.7, 0.7], map: 'tethys.jpg', gain: 1, near: 4.5, low: 0.02, orb: { about: 'saturn', a: 294.67e6, P: 1.887802, L0: 150, inc: 0 } },
  { id: 'dione', name: 'Dione', R: 561.4e3, mu: 7.312e10, H: 0.8, color: [0.62, 0.62, 0.62], map: 'dione.jpg', gain: 1, near: 4.5, low: 0.02, orb: { about: 'saturn', a: 377.42e6, P: 2.736915, L0: 254, inc: 0 } },
  { id: 'rhea', name: 'Rhea', R: 763.8e3, mu: 1.5394e11, H: 0.1, color: [0.6, 0.6, 0.6], map: 'rhea.jpg', gain: 1, near: 4.5, low: 0.02, orb: { about: 'saturn', a: 527.07e6, P: 4.518212, L0: 356, inc: 0 } },
  { id: 'titan', name: 'Titan', R: 2574.7e3, mu: 8.9781e12, H: -1.28, color: [0.62, 0.4, 0.13], gas: 1, air: [1.0, 0.62, 0.25, 0.6], near: 4.5, low: 0.04, orb: { about: 'saturn', a: 1221.87e6, P: 15.945421, L0: 120, inc: 0 } },
  { id: 'iapetus', name: 'Iapetus', R: 734.5e3, mu: 1.2053e11, H: 1.5, color: [0.36, 0.33, 0.29], map: 'iapetus.jpg', gain: 1, near: 4.5, low: 0.02, orb: { about: 'saturn', a: 3560.84e6, P: 79.33, L0: 201, inc: 15.5 } },
];

/** How strong the sun's light is at a distance (m), against its strength at the Earth: thinning with distance, far more gently than the truth. */
export const sunlight = (dist) => Math.max(0.1, Math.min(1.7, Math.pow(Math.max(dist, 1) / AU, -0.6)));

const YEAR0 = Date.UTC(new Date().getUTCFullYear(), 0, 1) / 86400000 - Date.UTC(2000, 0, 1, 12) / 86400000;
/** Days since J2000 at mission time t: the clock's day of the year, in the present year. */
export const daysJ2000 = (clock, t) => YEAR0 + (clock.day - 1) + (clock.hourG0 + t / 3600) / 24;

/** A planet's place from the sun (m, equatorial axes) at T centuries from J2000, into out. */
function helio(el, T, out) {
  const a = (el[0] + el[6] * T) * AU, e = el[1] + el[7] * T, I = (el[2] + el[8] * T) * D2R, L = el[3] + el[9] * T, wb = el[4] + el[10] * T, Om = (el[5] + el[11] * T) * D2R;
  const w = wb * D2R - Om, M = ((((L - wb) % 360) + 540) % 360 - 180) * D2R;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  const xe = (cw * cO - sw * sO * cI) * x + (-sw * cO - cw * sO * cI) * y, ye = (cw * sO + sw * cO * cI) * x + (-sw * sO + cw * cO * cI) * y, ze = sw * sI * x + cw * sI * y;
  out[0] = xe; out[1] = ye * CE - ze * SE; out[2] = ye * SE + ze * CE;
  return out;
}

/** The sun as the eye sees it: d a unit ray, sv the direction to the sun and, in w, how many times smaller it looks than from the Earth. */
export const SUN_GLSL = /* glsl */`
float sunGlow(vec3 d, vec4 sv) {
  float sa = atan(length(cross(d, sv.xyz)), dot(d, sv.xyz)) * sv.w;
  float sd = cos(min(sa, 3.14159265));
  return smoothstep(0.99996, 0.999985, sd) * 60.0 + pow(max(sd, 0.0), 2500.0) * 3.0 + pow(max(sd, 0.0), 180.0) * 0.1;
}`;

const SUN_FRAG = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform mat4 uProjInv; uniform mat3 uCamRot;
uniform vec4 uSunV; uniform vec3 uSunCol; uniform float uSunDisk;
${SUN_GLSL}
void main() {
  vec4 vd = uProjInv * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 d = normalize(uCamRot * (vd.xyz / vd.w));
  outColor = vec4(uSunCol * sunGlow(d, uSunV) * uSunDisk, 0.0);
}`;

const DISK_FRAG = /* glsl */`
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform mat4 uProjInv; uniform mat3 uCamRot, uRot;
uniform vec3 uC, uPole, uSunL, uLight, uColor;        // the center from the camera (in radii); the pole; the way to the sun; the sun's light there; the color without a map
uniform vec4 uAir, uRing, uLook;                      // uRing: inner and outer radius (radii), 1 if there are rings, their gain. uLook: 1 for cloud tops (0: bare rock), 1 once the map is there, its width in texels, its gain
uniform float uSquash, uPix;
uniform sampler2D tMap, tRing;

vec3 squash(vec3 v) { return v + (uSquash - 1.0) * dot(v, uPole) * uPole; }

void main() {
  vec4 vd = uProjInv * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec3 d = normalize(uCamRot * (vd.xyz / vd.w));
  vec3 col = vec3(0.0); float cov = 0.0, tGlobe = 1.0e30;

  // The globe, in a space stretched along its pole until it is a sphere of radius one. p is the center as seen from the
  // point of the ray nearest it: everything is worked out from there, where the numbers are small.
  vec3 ds = squash(d); float dl = length(ds); ds /= dl;
  vec3 cs = squash(uC);
  vec3 p = cross(cross(ds, cs), ds);
  float pp = dot(p, p), b = dot(ds, cs);
  float edge = clamp((1.0 - sqrt(pp)) / max(b * uPix, 1.0e-7) + 0.5, 0.0, 1.0);
  if (b > 0.0 && edge > 0.0) {
    float s = sqrt(max(1.0 - pp, 0.0));
    vec3 ns = normalize(-p - s * ds);
    vec3 n = normalize(squash(ns));
    tGlobe = (b - s) / dl;
    float mu0 = dot(n, uSunL), mu = max(dot(n, -d), 0.0);
    vec3 g = uRot * ns;
    vec2 uv = vec2(atan(g.y, g.x) * 0.15915494 + 0.5, 0.5 + asin(clamp(g.z, -1.0, 1.0)) * 0.31830989);
    vec3 alb = uColor;
    if (uLook.y > 0.5) alb = textureLod(tMap, uv, log2(max((b - s) * uPix * uLook.z * 0.15915494, 1.0))).rgb * uLook.w;
    float lit;
    if (uLook.x > 0.5) lit = smoothstep(-0.06, 0.2, mu0) * pow(max(mu0, 0.0) * 0.92 + 0.08, 0.9) * (0.62 + 0.38 * pow(mu + 1.0e-4, 0.4));      // cloud tops: darker toward the limb
    else lit = min(smoothstep(-0.01, 0.05, mu0) * 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 0.03), 1.6);                                 // bare rock and dust, as the Moon: bright to the edge
    vec3 globe = alb * uLight * lit;
    // The air seen edge on: a rim of scattered light round the day side.
    float om = max(1.0 - mu, 0.0);
    globe += uAir.rgb * uLight * (uAir.a * om * om * om * smoothstep(-0.25, 0.35, mu0));
    if (uRing.z > 0.5) {
      // The rings' shadow: follow the way to the sun from this point to the plane of the rings.
      vec3 x = ns + (1.0 / uSquash - 1.0) * dot(ns, uPole) * uPole;
      float h = dot(x, uPole), lp = dot(uSunL, uPole);
      if (h * lp < 0.0) {
        float rho = length(x - (h / lp) * uSunL);
        if (rho > uRing.x && rho < uRing.y) globe *= 1.0 - 0.8 * textureLod(tRing, vec2((rho - uRing.x) / (uRing.y - uRing.x), 0.5), 3.0).a;
      }
    }
    col = globe * edge; cov = edge;
  }

  if (uRing.z > 0.5) {
    float dz = dot(d, uPole);
    if (abs(dz) > 1.0e-6) {
      vec3 p0 = cross(cross(d, uC), d);
      float tau = dot(p0, uPole) / dz, tR = tau + dot(d, uC);        // tR: along the ray from the camera to the plane of the rings (radii)
      vec3 h = tau * d - p0; float rho = length(h);
      if (tR > 0.0 && rho > uRing.x && rho < uRing.y) {
        float fw = tR * uPix / max(abs(dz), 0.04);                   // a pixel's width on the rings (they stretch when seen edge on)
        vec4 rg = textureLod(tRing, vec2((rho - uRing.x) / (uRing.y - uRing.x), 0.5), log2(max(fw / (uRing.y - uRing.x) * 4096.0, 1.0)));
        float a = rg.a * smoothstep(0.0, 0.02, abs(dz) + 0.004);
        // In the globe's shadow?
        vec3 ls = normalize(squash(uSunL)); float bs = dot(h, ls);
        float sh = bs < 0.0 ? smoothstep(0.985, 1.015, sqrt(max(dot(h, h) - bs * bs, 0.0))) : 1.0;
        float lp = dot(uSunL, uPole), sunny = -dot(uC, uPole) * lp;  // > 0: the camera is on the side the sun lights
        vec3 lit = rg.rgb * uLight * (uRing.w * sh) * (sunny > 0.0
          ? (0.62 + 0.38 * abs(lp)) * (0.8 + 0.4 * max(dot(-d, uSunL), 0.0))
          : 1.6 * a * (1.0 - a) * (0.4 + 0.6 * abs(lp)));            // from the dark side: the light that comes through, most where they are neither thick nor thin
        if (tR < tGlobe) { col = lit * a + col * (1.0 - a); cov = a + cov * (1.0 - a); }
        else { col += lit * a * (1.0 - cov); cov += a * (1.0 - cov); }
      }
    }
  }
  outColor = vec4(col, cov);
}`;

const POINT_VERT = /* glsl */`
attribute vec3 aCol; attribute float aSig;
varying vec3 vCol; varying float vSig;
void main() {
  vCol = aCol; vSig = aSig;
  gl_PointSize = max(2.0, ceil(aSig * 6.0));
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
}`;
const POINT_FRAG = /* glsl */`
varying vec3 vCol; varying float vSig;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * max(2.0, ceil(vSig * 6.0));
  gl_FragColor = vec4(vCol * exp(-dot(p, p) / (2.0 * vSig * vSig)), 0.0);
}`;

const OVER = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
const ADD = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };
const tA = [0, 0, 0], tB = [0, 0, 0], v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), qi = new THREE.Quaternion();
const sstep = (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** ECI components to the drawing axes of cosmos.js (x, z, -y). */
const draw3 = (v, out) => out.set(v[0], v[2], -v[1]);

export class SolarSystem {
  /** u: the uniforms of cosmos.js's own pass (the camera's and the sun's are shared with it). */
  constructor(renderer, u) {
    this.renderer = renderer; this.u = u;
    this.bodies = BODIES.map((b) => ({ ...b, r: [0, 0, 0], toSun: [1, 0, 0], sunDist: AU, rel: new THREE.Vector3(), dist: 1, px: 0, poleV: new THREE.Vector3(0, 1, 0), rot: new THREE.Matrix3(), tex: null, wanted: false, mat: null, point: 0, globe: !!(b.pole || b.orb) }));
    this.by = Object.fromEntries(this.bodies.map((b) => [b.id, b]));
    this.sun = this.by.sun; this.earth = this.by.earth; this.moon = this.by.moon;
    this.key = null;
    this.quad = new FullscreenQuad();
    this.loader = new THREE.TextureLoader();
    this.blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); this.blank.needsUpdate = true;
    this.sunMat = Object.assign(fsMaterial(SUN_FRAG, { uProjInv: u.uProjInv, uCamRot: u.uCamRot, uSunV: u.uSunV, uSunCol: u.uSunCol, uSunDisk: u.uSunDisk }), ADD);
    // The specks.
    const n = this.bodies.length, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSig', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, depthTest: false, depthWrite: false, fog: false, ...ADD }));
    this.points.frustumCulled = false;
    this.pointScene = new THREE.Scene(); this.pointScene.add(this.points);
    // What frame() leaves for cosmos.js.
    this.earthOn = true;                       // is the Earth near enough for cosmos.js's own pass?
    this.sunView = new THREE.Vector3(1, 0, 0); // the way to the sun from the camera (drawing axes)
    this.sunPower = 1;                         // the sun's light at the camera against its light at the Earth, a world's shadow included
    this.shine = { dir: new THREE.Vector3(0, -1, 0), col: new THREE.Vector3(), sky: new THREE.Vector3(), lit: 0, big: 0, cos: 0, ang: 0, body: this.earth };
    this.order = [];
  }

  /** Where everything is at mission time t: each body's r (ECI, m), its distance and direction to the sun, its pole and turn. */
  place(clock, t) {
    const key = `${clock.day}|${clock.hourG0}|${t}`;
    if (key === this.key) return this;
    this.key = key;
    const d = daysJ2000(clock, t), T = d / 36525, s = this.sun;
    sunDir(clock, t, tA);
    s.r[0] = tA[0] * AU; s.r[1] = tA[1] * AU; s.r[2] = tA[2] * AU;
    moonPos(clock, t, this.moon.r);
    for (const b of this.bodies) {
      if (b.el) { helio(b.el, T, tB); b.r[0] = s.r[0] + tB[0]; b.r[1] = s.r[1] + tB[1]; b.r[2] = s.r[2] + tB[2]; }
      if (b.orb) {
        // A moon: round its planet (placed already: the planets come first), and its own axes: one face to the planet, its pole the orbit's.
        const o = this.moonAt(b, d, 0, tB), pl = this.by[b.orb.about];
        b.r[0] = pl.r[0] + tB[0]; b.r[1] = pl.r[1] + tB[1]; b.r[2] = pl.r[2] + tB[2];
        const l = Math.hypot(tB[0], tB[1], tB[2]), X = [-tB[0] / l, -tB[1] / l, -tB[2] / l], Z = o, Y = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
        b.poleV.set(Z[0], Z[2], -Z[1]);
        b.rot.set(X[0], X[2], -X[1], Y[0], Y[2], -Y[1], Z[0], Z[2], -Z[1]);
      }
      if (b !== s) {
        const x = s.r[0] - b.r[0], y = s.r[1] - b.r[1], z = s.r[2] - b.r[2], l = Math.hypot(x, y, z);
        b.sunDist = l; b.toSun[0] = x / l; b.toSun[1] = y / l; b.toSun[2] = z / l;
      }
      if (b.pole) {
        // Its own axes in the drawing axes: the pole, and the prime meridian turned from the node of its equator on the Earth's.
        const ra = b.pole[0] * D2R, de = b.pole[1] * D2R, W = ((b.spin[0] + b.spin[1] * d) % 360) * D2R;
        const P = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)], N = [-Math.sin(ra), Math.cos(ra), 0];
        const M = [P[1] * N[2] - P[2] * N[1], P[2] * N[0] - P[0] * N[2], P[0] * N[1] - P[1] * N[0]];
        const X = [0, 0, 0], Y = [0, 0, 0];
        for (let k = 0; k < 3; k++) X[k] = Math.cos(W) * N[k] + Math.sin(W) * M[k];
        Y[0] = P[1] * X[2] - P[2] * X[1]; Y[1] = P[2] * X[0] - P[0] * X[2]; Y[2] = P[0] * X[1] - P[1] * X[0];
        b.poleV.set(P[0], P[2], -P[1]);
        b.rot.set(X[0], X[2], -X[1], Y[0], Y[2], -Y[1], P[0], P[2], -P[1]);
      }
    }
    return this;
  }

  /** A body's place from the sun (m, the axes of frames.js) at any mission time t, into out, leaving what place() holds alone. */
  fromSun(b, clock, t, out) {
    out[0] = out[1] = out[2] = 0;
    if (b === this.sun) return out;
    if (b === this.earth || b === this.moon) {
      const s = sunDir(clock, t, [0, 0, 0]);
      for (let k = 0; k < 3; k++) out[k] = -s[k] * AU;
      if (b === this.moon) { const m = moonPos(clock, t, [0, 0, 0]); for (let k = 0; k < 3; k++) out[k] += m[k]; }
      return out;
    }
    const d = daysJ2000(clock, t);
    if (b.orb) { this.fromSun(this.by[b.orb.about], clock, t, out); const o = [0, 0, 0]; this.moonAt(b, d, 0, o); for (let k = 0; k < 3; k++) out[k] += o[k]; return out; }
    return helio(b.el, d / 36525, out);
  }
  /** Its velocity round the sun (m/s) at t, into out. */
  velocity(b, clock, t, out) {
    const a = this.fromSun(b, clock, t - 60, [0, 0, 0]), c = this.fromSun(b, clock, t + 60, [0, 0, 0]);
    for (let k = 0; k < 3; k++) out[k] = (c[k] - a[k]) / 120;
    return out;
  }

  /** A moon's place from its planet (m, the axes of frames.js) at d days from J2000, `turn` of a turn further along its orbit, into out. Returns the orbit's pole. */
  moonAt(b, d, turn, out) {
    const o = b.orb, pl = this.by[o.about], ra = pl.pole[0] * D2R, de = pl.pole[1] * D2R, inc = (o.inc || 0) * D2R;
    const P = [Math.cos(de) * Math.cos(ra), Math.cos(de) * Math.sin(ra), Math.sin(de)], Nd = [-Math.sin(ra), Math.cos(ra), 0];
    const M = [P[1] * Nd[2] - P[2] * Nd[1], P[2] * Nd[0] - P[0] * Nd[2], P[0] * Nd[1] - P[1] * Nd[0]];
    const ci = Math.cos(inc), si = Math.sin(inc), L = ((((o.L0 + (360 * d) / o.P) % 360) + 360) % 360) * D2R + turn * 2 * Math.PI, c = Math.cos(L) * o.a, sn = Math.sin(L) * o.a;
    for (let k = 0; k < 3; k++) out[k] = c * Nd[k] + sn * (ci * M[k] + si * P[k]);
    return [ci * P[0] - si * M[0], ci * P[1] - si * M[1], ci * P[2] - si * M[2]];
  }

  /**
   * A world's orbit as n points, for the chart: each relative to what the world goes round (`about`: the sun, or the
   * Earth for the Moon), in the axes of frames.js. The first point is where the world is now, so a line through
   * them passes through it. Nothing for the sun.
   */
  orbit(b, clock, t, n = 360) {
    const pts = new Float64Array(n * 3);
    if (b === this.moon) {
      for (let k = 0; k < n; k++) { moonPos(clock, t + (k * 27.3217 * 86400) / n, tA); pts[k * 3] = tA[0]; pts[k * 3 + 1] = tA[1]; pts[k * 3 + 2] = tA[2]; }
      return { pts, n, about: this.earth };
    }
    if (b === this.earth) {
      // (the Earth stands still in these axes and the sun goes round it: the Earth's path about the sun is the sun's, reversed)
      for (let k = 0; k < n; k++) { sunDir(clock, t + (k * 365.2422 * 86400) / n, tA); pts[k * 3] = -tA[0] * AU; pts[k * 3 + 1] = -tA[1] * AU; pts[k * 3 + 2] = -tA[2] * AU; }
      return { pts, n, about: this.sun };
    }
    const d = daysJ2000(clock, t);
    if (b.orb) {
      for (let k = 0; k < n; k++) { this.moonAt(b, d, k / n, tB); pts[k * 3] = tB[0]; pts[k * 3 + 1] = tB[1]; pts[k * 3 + 2] = tB[2]; }
      return { pts, n, about: this.by[b.orb.about] };
    }
    if (!b.el) return null;
    const period = 365.25 * Math.pow(b.el[0], 1.5);
    for (let k = 0; k < n; k++) { helio(b.el, (d + (k * period) / n) / 36525, tB); pts[k * 3] = tB[0]; pts[k * 3 + 1] = tB[1]; pts[k * 3 + 2] = tB[2]; }
    return { pts, n, about: this.sun };
  }

  /** The body a place (ECI) belongs to: the one that looks largest from there, the sun aside unless nothing else is near. */
  nearest(r, was = null) {
    let best = null, bk = Infinity;
    for (const b of this.bodies) {
      const d = Math.hypot(r[0] - b.r[0], r[1] - b.r[1], r[2] - b.r[2]);
      // (a little loyalty to the present one, so it does not flicker at the border; and a moon holds its own neighborhood
      // however large its planet looms: Mimas, from where a ship stands off it, looks smaller than Saturn behind it)
      const k = b.orb && d < b.R * b.near * (b === was ? 1.5 : 1.3) ? (d / b.R) * 1e-3 : (d / b.R) * (b === was ? 0.9 : 1);
      if (k < bk) { bk = k; best = b; }
    }
    return best;
  }

  /** Fetch a world's map (and Saturn's rings), once. */
  want(b) {
    if (b.wanted || !b.map) return;
    b.wanted = true;
    const load = (file, done) => this.loader.load(MAP_URL + file, (t) => {
      t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
      done(t);
    }, undefined, () => console.warn(`${file} did not load: ${b.name} stays plain`));
    load(b.map, (t) => { b.tex = t; if (b.mat) { b.mat.uniforms.tMap.value = t; b.mat.uniforms.uLook.value.y = 1; b.mat.uniforms.uLook.value.z = t.image.width; } });
    if (b.ring) load(b.ring.map, (t) => { t.wrapS = THREE.ClampToEdgeWrapping; b.ringTex = t; if (b.mat) { b.mat.uniforms.tRing.value = t; b.mat.uniforms.uRing.value.z = 1; } });
  }

  material(b) {
    if (b.mat) return b.mat;
    const u = this.u, air = b.air || [0, 0, 0, 0];
    b.mat = Object.assign(fsMaterial(DISK_FRAG, {
      uProjInv: u.uProjInv, uCamRot: u.uCamRot, uPix: u.uPix, uRot: { value: b.rot }, uC: { value: new THREE.Vector3() }, uPole: { value: b.poleV },
      uSunL: { value: new THREE.Vector3() }, uLight: { value: new THREE.Vector3() }, uColor: { value: new THREE.Vector3(...b.color) },
      uAir: { value: new THREE.Vector4(...air) }, uRing: { value: new THREE.Vector4(b.ring?.in || 0, b.ring?.out || 0, b.ringTex ? 1 : 0, b.ring?.gain || 1) },
      uLook: { value: new THREE.Vector4(b.gas ? 1 : 0, b.tex ? 1 : 0, b.tex ? b.tex.image.width : 1, b.gain || 1) }, uSquash: { value: 1 / (1 - (b.f || 0)) },
      tMap: { value: b.tex || this.blank }, tRing: { value: b.ringTex || this.blank },
    }), OVER);
    return b.mat;
  }

  /**
   * Set this frame up, after cosmos.js has placed its camera (cs.cam: ECI; cs.camera; cs.u.uPix). gain: engine radiance per
   * lux per steradian for points of light (the stars' own figure). Fills what cosmos.js reads back: earthOn, sunView,
   * sunPower, shine, and the uniforms the sun is drawn from.
   */
  frame(cs, clock, t, gain, pixelRatio) {
    this.place(clock, t);
    const cam = cs.cam, u = this.u, pix = Math.max(u.uPix.value, 1e-7), s = this.sun;
    // The sun: where it stands from here, and how large. Far out it is kept a pixel or two across, and dimmed to suit.
    draw3([s.r[0] - cam[0], s.r[1] - cam[1], s.r[2] - cam[2]], s.rel); s.dist = s.rel.length();
    this.sunView.copy(s.rel).divideScalar(s.dist);
    const scale = s.dist / AU, sMax = 0.007 / (1.3 * pix), sEff = Math.min(scale, sMax);
    u.uSunV.value.set(this.sunView.x, this.sunView.y, this.sunView.z, sEff);
    u.uSunDisk.value = (sEff / scale) ** 2;

    let near = null, nk = 0;
    for (const b of this.bodies) {
      if (b === s) continue;
      draw3([b.r[0] - cam[0], b.r[1] - cam[1], b.r[2] - cam[2]], b.rel); b.dist = b.rel.length();
      b.px = b.R / b.dist / pix;
      const k = b.R / b.dist;
      if (k > nk && b !== this.moon) { nk = k; near = b; }                 // (by the Moon it is still the Earth's light that counts, as cosmos.js always had it)
    }
    this.earthOn = this.earth.px > DISK_PX;

    // The world whose light falls on the craft, and whose shadow may.
    const sh = this.shine, nb = near || this.earth, kk = Math.min(1, nb.R / nb.dist);
    sh.body = nb; sh.dir.copy(nb.rel).divideScalar(nb.dist);
    const toCam = [cam[0] - nb.r[0], cam[1] - nb.r[1], cam[2] - nb.r[2]], along = toCam[0] * nb.toSun[0] + toCam[1] * nb.toSun[1] + toCam[2] * nb.toSun[2];
    sh.lit = Math.max(0, 0.5 + 0.5 * along / nb.dist); sh.big = kk * kk; sh.cos = Math.sqrt(Math.max(1 - kk * kk, 0)); sh.ang = Math.asin(kk);
    const fall = nb === this.earth || nb === this.moon ? 1 : sunlight(nb.sunDist);
    sh.col.fromArray(nb.shine || nb.color).multiplyScalar(fall * (nb.shine ? 1 : 1.5));
    sh.sky.fromArray(nb.sky || nb.color).multiplyScalar(fall);
    let shadow = 1;
    if (nb !== this.earth && along < 0) shadow = sstep(Math.sqrt(Math.max(nb.dist * nb.dist - along * along, 0)), nb.R * 0.985, nb.R * 1.02);      // (the Earth's shadow is cosmos.js's own business)
    this.sunPower = sunlight(s.dist) * shadow;

    // What to draw, from the farthest to the nearest: disks, and specks among the stars.
    const flux0 = (STAR_GAIN * gain * STAR_LUX) / (pix * pix);
    this.order.length = 0;
    for (const b of this.bodies) {
      if (b === s) { this.order.push(b); continue; }
      const own = b === this.earth || b === this.moon;
      b.disk = !(own && this.earthOn) && b.px > DISK_PX * 0.7 && b.globe;
      // A point of light: as bright as the world is in the sky from here, fading out as its disk takes over.
      b.point = 0;
      if (!(own && this.earthOn) && b.px < 3) {
        const ca = ((cam[0] - b.r[0]) * b.toSun[0] + (cam[1] - b.r[1]) * b.toSun[1] + (cam[2] - b.r[2]) * b.toSun[2]) / b.dist;      // cosine of the angle sun - world - eye
        const al = Math.acos(Math.max(-1, Math.min(1, ca))), phase = Math.max((Math.sin(al) + (Math.PI - al) * Math.cos(al)) / Math.PI, 0.003);
        const mag = Math.max(b.H + 5 * Math.log10((b.sunDist / AU) * (b.dist / AU)) - 2.5 * Math.log10(phase), -4.6);
        b.point = flux0 * Math.pow(10, -0.4 * mag) * (b.globe ? 1 - sstep(b.px, DISK_PX * 0.7, 3) : 1);
      }
      if (b.disk) { if (b.px > 2.5) this.want(b); this.order.push(b); } else if (b.point > 0) this.order.push(b);
    }
    this.order.sort((a, b) => b.dist - a.dist);
    this.pixelRatio = pixelRatio;
    return this;
  }

  /** Draw what lies beyond the Earth (which = 'beyond') or nearer than it ('within') into rt. With the Earth's own pass off, 'beyond' draws everything. */
  draw(rt, camera, which) {
    const r = this.renderer, eD = this.earthOn ? this.earth.dist : -1, P = this.points.geometry, pos = P.attributes.position.array, col = P.attributes.aCol.array, sig = P.attributes.aSig.array;
    let n = 0;
    const flush = () => {
      if (!n) return;
      P.setDrawRange(0, n); P.attributes.position.needsUpdate = P.attributes.aCol.needsUpdate = P.attributes.aSig.needsUpdate = true;
      r.setRenderTarget(rt); r.render(this.pointScene, camera); n = 0;
    };
    for (const b of this.order) {
      if ((which === 'beyond') !== (b.dist > eD)) continue;
      if (b === this.sun) {
        if (this.earthOn) continue;                                    // (cosmos.js's pass draws the sun itself, through the Earth's air)
        flush(); this.quad.draw(r, this.sunMat, rt); continue;
      }
      if (b.point > 0) {
        const f = Math.min(b.point, 45), sg = (this.pixelRatio || 1) * (0.72 + 0.45 * sstep(f, 0.05, 12)), lum = 0.2126 * b.color[0] + 0.7152 * b.color[1] + 0.0722 * b.color[2], k = f / (6.2832 * sg * sg) / lum;
        v1.copy(b.rel).multiplyScalar(1000 / b.dist);
        pos[n * 3] = v1.x; pos[n * 3 + 1] = v1.y; pos[n * 3 + 2] = v1.z;
        col[n * 3] = b.color[0] * k; col[n * 3 + 1] = b.color[1] * k; col[n * 3 + 2] = b.color[2] * k; sig[n] = sg; n++;
      }
      if (b.disk) {
        flush();
        const box = this.box(b, camera, rt);
        if (!box) continue;
        const m = this.material(b), mu = m.uniforms;
        mu.uC.value.copy(b.rel).divideScalar(b.R);
        mu.uSunL.value.set(b.toSun[0], b.toSun[2], -b.toSun[1]);
        mu.uLight.value.copy(this.u.uSunCol.value).multiplyScalar(sunlight(b.sunDist));
        rt.scissor.set(box[0], box[1], box[2], box[3]); rt.scissorTest = true;
        this.quad.draw(r, m, rt);
        rt.scissorTest = false; rt.scissor.set(0, 0, rt.width, rt.height); r.setRenderTarget(rt);
      }
    }
    flush();
  }

  /** The rectangle of the target (x, y, width, height in pixels) that holds a body and its rings, or null if it is out of the picture. */
  box(b, camera, rt) {
    const reach = (b.ringTex ? b.ring.out : 1) * 1.03 * b.R, w = rt.width, h = rt.height;
    v2.copy(b.rel).applyQuaternion(qi.copy(camera.quaternion).invert());
    const z = -v2.z;
    if (b.dist <= reach * 1.05 || z <= reach) {
      if (z < -reach) return null;                                     // wholly behind the camera
      return [0, 0, w, h];
    }
    const tY = Math.tan((camera.fov * D2R) / 2), tX = tY * camera.aspect, out = [0, 0, 0, 0];
    const span = (c, t, size, o) => {
      const l = Math.hypot(c, z), a0 = Math.atan2(c, z), da = Math.asin(Math.min(1, reach / l));
      const lo = a0 - da <= -1.5 ? -1 : Math.tan(a0 - da) / t, hi = a0 + da >= 1.5 ? 1 : Math.tan(a0 + da) / t;
      const p0 = Math.max(0, Math.floor((lo * 0.5 + 0.5) * size) - 2), p1 = Math.min(size, Math.ceil((hi * 0.5 + 0.5) * size) + 2);
      out[o] = p0; out[o + 2] = p1 - p0;
      return p1 > p0;
    };
    return span(v2.x, tX, w, 0) && span(v2.y, tY, h, 1) ? out : null;
  }
}
