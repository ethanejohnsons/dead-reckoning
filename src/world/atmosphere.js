// Atmospheric scattering shared by the sky dome, terrain haze, water reflections, clouds and (on the
// CPU) the scene lights.
//
// The model is Hillaire's lookup-table atmosphere (see skylut.js for the tables): Rayleigh air, ozone and
// one aerosol set by the weather, single scattering marched against a transmittance table with the
// Earth's shadow, and every further order from a small multiple-scattering table. Every shader that
// includes ATMO_GLSL reads the same two textures:
//
//   skyRadiance(dir)                 the sky in a direction, from the sky-view table
//   atmosphereTransmittance(a, b)    light surviving between two points (closed form, as before)
//   applyAtmosphere(col, eye, p)     col seen through the air between: col * T + inscatter * (1 - T)
//   atmosphereInscatter(dir, dist)   the colour of that haze alone, from the aerial table
//   skyIrradiance(n)                 sky light falling on a surface facing n (irradiance / pi), from
//                                    nine spherical-harmonic coefficients fitted to the sky each frame
//
// Where this departs from the paper:
// - The sky view is stored all round the compass (not folded about the sun), so one table carries the
//   sun's sky, the moon's sky and the airglow together, and a reader needs no sun direction.
// - The aerial-perspective volume is not a camera frustum. It is indexed by world direction and
//   distance from the camera, so it does not change as the view turns, vertex shaders can read it, and
//   applyAtmosphere keeps its old (col, eye, point) signature. It holds colour only; transmittance stays
//   the closed form over exponential layers, which is exact from fog at 100 m to haze at 200 km.
// - The weather drives the aerosol: the air mass sets the tables, the local visibility sets the haze in
//   front of things, and what is not air-mass haze (fog, rain, cloud) glows with the overcast's grey light.
// - Overcast and murk are mixed in when the tables are read (uSkyP.z), as before, so the tables need no
//   redrawing as cloud cover changes; the horizon stays clearer than the rest under a deck (uAtmSky.y).
// - Night works in the same units as day: moonlight, airglow and starlight are in their true proportion
//   to sunlight, and one adaptation gain (set in sky.js from the light there is) scales all of it, the way
//   the eye opens. The tables are drawn with that gain inside, so half floats hold a moonless night.
//
// The CPU mirror reads back a small copy of the sky-view table (the probe), a frame or two late.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { PROBE_W, PROBE_H, SKY_HORIZON_V } from './skylut.js';

export const ATMO_UNIFORMS = ['uSkySun', 'uSkyOvc', 'uSkyP', 'uHaze', 'uHorizon', 'tAtmSky', 'tAtmAP', 'uAtmSky', 'uAtmAP', 'uSkySH'];

const SLOT_K = 26;        // how fast the overcast closes in above the horizon (per unit of dir.y)

/** Sky light alone (a part of ATMO_GLSL): for a shader stage that wants skyIrradiance() and nothing else. Needs the uniform uSkySH. */
export const SKY_SH_GLSL = /* glsl */`
uniform vec3 uSkySH[9];
// Sky light on a surface facing n (world axes), as irradiance / pi (multiply by albedo). The lower half
// of the sphere is the ground's own bounce, so walls and the undersides of things get it too.
vec3 skyIrradiance(vec3 n) {
  vec3 e = uSkySH[0] + uSkySH[1] * n.y + uSkySH[2] * n.z + uSkySH[3] * n.x
    + uSkySH[4] * (n.x * n.y) + uSkySH[5] * (n.y * n.z) + uSkySH[6] * (3.0 * n.z * n.z - 1.0) + uSkySH[7] * (n.x * n.z) + uSkySH[8] * (n.x * n.x - n.y * n.y);
  return max(e, uSkySH[0] * 0.12);
}`;

export const ATMO_GLSL = /* glsl */`
uniform vec3 uSkySun, uSkyOvc, uHorizon;
uniform vec4 uSkyP;     // y: brightness of the sky tables now against when they were drawn, z: murk 0..1 (overcast, rain, fog), w: night 0..1
uniform vec4 uHaze;     // x: haze extinction at sea level (1/m), y: haze scale height (m), z: Rayleigh strength
uniform highp sampler2D tAtmSky, tAtmAP;
uniform vec4 uAtmSky;   // x: sine of the horizon's dip at the tables' height, y: how clear the horizon stays under overcast 0..1
uniform vec4 uAtmAP;    // x: slices of the aerial table, y: ln of the first slice's distance (m), z: 1 / ln of the ratio between slices, w: half a row of a slice

// The sky in a direction: the sun's and the moon's scattered light and the airglow, greyed by cloud and murk.
vec3 skyRadiance(vec3 dir) {
  float s = dir.y + uAtmSky.x;
  float v = s >= 0.0 ? ${SKY_HORIZON_V.toFixed(2)} + ${(1 - SKY_HORIZON_V).toFixed(2)} * sqrt(s / (1.0 + uAtmSky.x)) : ${SKY_HORIZON_V.toFixed(2)} - ${SKY_HORIZON_V.toFixed(2)} * sqrt(-s / (1.0 - uAtmSky.x));
  vec3 col = textureLod(tAtmSky, vec2(atan(dir.x, dir.z + 1e-6) * 0.15915494 + 0.5, v), 0.0).rgb * uSkyP.y;
  float cz = max(dir.y, 0.0);
  return mix(col, uSkyOvc * (0.75 + 0.25 * cz), uSkyP.z * (1.0 - uAtmSky.y * exp(-cz * ${SLOT_K.toFixed(1)})));
}

// Fraction of light surviving the path from worldPos to camPos, per colour channel.
vec3 atmosphereTransmittance(vec3 camPos, vec3 worldPos) {
  float d = distance(camPos, worldPos);
  float H = uHaze.y, dy = worldPos.y - camPos.y;
  float a0 = exp(-max(camPos.y, 0.0) / H), a1 = exp(-max(worldPos.y, 0.0) / H);
  float avg = abs(dy) < 5.0 ? a0 : (a0 - a1) * H / dy;
  float ray = exp(-0.5 * (max(camPos.y, 0.0) + max(worldPos.y, 0.0)) / 8000.0);
  return exp(-d * (uHaze.x * avg + uHaze.z * ray * vec3(5.802e-6, 13.558e-6, 33.1e-6)));
}

// Colour of the haze between the camera and something dist metres away in direction dir (the mean light
// the air scatters toward the eye along the way; multiply by 1 - transmittance).
vec3 atmosphereInscatter(vec3 dir, float dist) {
  float w = clamp((log(max(dist, 1.0)) - uAtmAP.y) * uAtmAP.z, 0.0, uAtmAP.x - 1.0), k = floor(w);
  float u = atan(dir.x, dir.z + 1e-6) * 0.15915494 + 0.5;
  float v = clamp(0.5 + 0.5 * sign(dir.y) * sqrt(abs(dir.y)), uAtmAP.w, 1.0 - uAtmAP.w);
  vec3 a = textureLod(tAtmAP, vec2(u, (k + v) / uAtmAP.x), 0.0).rgb;
  vec3 b = textureLod(tAtmAP, vec2(u, (min(k + 1.0, uAtmAP.x - 1.0) + v) / uAtmAP.x), 0.0).rgb;
  return mix(a, b, w - k) * uSkyP.y;
}

vec3 applyAtmosphere(vec3 col, vec3 camPos, vec3 worldPos) {
  vec3 T = atmosphereTransmittance(camPos, worldPos), v = worldPos - camPos;
  float d = length(v);
  return col * T + atmosphereInscatter(v / max(d, 1e-3), d) * (1.0 - T);
}

${SKY_SH_GLSL}`;

// ---------------------------------------------------------------- the air, on the CPU

export const RG = 6360, RT = 6460;                                   // km
const BETA_R = [5.802e-3, 13.558e-3, 33.1e-3], BETA_O = [1.70e-3, 1.85e-3, 0.085e-3];
/** The air mass's aerosol: extinction at sea level (1/km), scale height (km), single-scattering albedo, Mie g. */
export const air = { ext: 0.0217, H: 4.1, albedo: 0.9, g: 0.8 };

/** Sine of the dip of the horizon seen from a height (km above sea level). */
export const horizonDip = (altKm) => Math.sqrt(Math.max(1 - (RG / (RG + Math.max(altKm, 0))) ** 2, 0));

/**
 * Optical depth from a height (km) along a direction (mu: cosine from the vertical) to the top of the
 * atmosphere, per colour channel: the twin of the transmittance table. Returns false if the ground is in the way.
 */
export function opticalDepth(altKm, mu, out) {
  const r = RG + Math.max(altKm, 0), disc = r * r * (mu * mu - 1);
  if (mu < 0 && disc + RG * RG >= 0) return false;
  const tMax = -r * mu + Math.sqrt(Math.max(disc + RT * RT, 0)), N = 48, dt = tMax / N;
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * dt, h = Math.max(Math.sqrt(r * r + t * t + 2 * r * t * mu) - RG, 0);
    const dR = Math.exp(-h / 8), eM = air.ext * Math.exp(-h / air.H), dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
    a += BETA_R[0] * dR + eM + BETA_O[0] * dO; b += BETA_R[1] * dR + eM + BETA_O[1] * dO; c += BETA_R[2] * dR + eM + BETA_O[2] * dO;
  }
  out[0] = a * dt; out[1] = b * dt; out[2] = c * dt;
  return true;
}

const od = [0, 0, 0];
/**
 * Colour of a light outside the atmosphere after its trip down to a height (km), for an elevation in
 * radians. Below the horizon it keeps the horizon's colour and fades over the width of a low sun.
 */
export function lightTransmittance(altKm, elev, out) {
  const dip = Math.asin(horizonDip(altKm));
  const vis = THREE.MathUtils.smoothstep(elev, -0.5 * dip - 0.021, -0.5 * dip + 0.010);
  if (vis <= 0 || !opticalDepth(altKm, Math.sin(Math.max(elev, -dip + 0.004)), od)) return out.setRGB(0, 0, 0);
  return out.setRGB(vis * Math.exp(-od[0]), vis * Math.exp(-od[1]), vis * Math.exp(-od[2]));
}

// ---------------------------------------------------------------- the sky, on the CPU

const st = {
  probe: new Float32Array(PROBE_W * PROBE_H * 3),      // the clear sky with no adaptation gain: [az][height] rows, RGB
  has: false, gain: 1, murk: 0, slot: 0, ovc: [0.5, 0.5, 0.5],
  sh: new Float32Array(27),
};
export const skyState = st;

/** Take a probe read back from the GPU (RGBA floats, drawn at `gain`) as the clear sky. */
export function setProbe(rgba, gain) {
  const p = st.probe, k = 1 / gain;
  for (let i = 0, j = 0; i < PROBE_W * PROBE_H; i++, j += 4) { p[i * 3] = rgba[j] * k; p[i * 3 + 1] = rgba[j + 1] * k; p[i * 3 + 2] = rgba[j + 2] * k; }
  st.has = true;
}
/** Adaptation gain, murk 0..1, how clear the horizon stays under it 0..1, and the overcast's colour (engine units, gain included). */
export function setSkyMix(gain, murk, slot, ovc) { st.gain = gain; st.murk = murk; st.slot = slot; st.ovc[0] = ovc.r; st.ovc[1] = ovc.g; st.ovc[2] = ovc.b; }

const c3 = [0, 0, 0];
/** The clear sky in a direction (dy >= 0), in the engine's units without the adaptation gain. Writes [r, g, b]. */
export function skyClear(dx, dy, dz, out = c3) {
  const p = st.probe;
  let x = (Math.atan2(dx, dz) / (2 * Math.PI) + 0.5) * PROBE_W - 0.5, y = Math.sqrt(Math.max(dy, 0)) * PROBE_H - 0.5;
  y = Math.max(0, Math.min(PROBE_H - 1, y));
  const x0 = Math.floor(x), fx = x - x0, y0 = Math.min(Math.floor(y), PROBE_H - 2), fy = y - y0;
  const xa = ((x0 % PROBE_W) + PROBE_W) % PROBE_W, xb = (xa + 1) % PROBE_W;
  for (let c = 0; c < 3; c++) {
    const a = p[(y0 * PROBE_W + xa) * 3 + c], b = p[(y0 * PROBE_W + xb) * 3 + c], d = p[((y0 + 1) * PROBE_W + xa) * 3 + c], e = p[((y0 + 1) * PROBE_W + xb) * 3 + c];
    out[c] = (a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy;
  }
  return out;
}

/** CPU mirror of skyRadiance(). Writes linear RGB into out (a THREE.Color). */
export function skyRadiance(dx, dy, dz, out) {
  skyClear(dx, dy, dz, c3);
  const cz = Math.max(dy, 0), w = st.murk * (1 - st.slot * Math.exp(-cz * SLOT_K)), o = 0.75 + 0.25 * cz;
  return out.setRGB(
    c3[0] * st.gain * (1 - w) + st.ovc[0] * o * w,
    c3[1] * st.gain * (1 - w) + st.ovc[1] * o * w,
    c3[2] * st.gain * (1 - w) + st.ovc[2] * o * w);
}

const tmp = new THREE.Color();
/**
 * Means over the clear sky's dome, without gain: out.mean (plain average radiance) and out.down
 * (irradiance on level ground / pi), both [r, g, b].
 */
export function skyMeans(out) {
  const p = st.probe, m = out.mean, d = out.down;
  m[0] = m[1] = m[2] = d[0] = d[1] = d[2] = 0;
  for (let j = 0; j < PROBE_H; j++) {
    const y0 = (j / PROBE_H) ** 2, y1 = ((j + 1) / PROBE_H) ** 2, w = (y1 - y0) / PROBE_W, wc = (y1 * y1 - y0 * y0) / PROBE_W;   // share of the dome; cosine-weighted share
    for (let i = 0; i < PROBE_W; i++) for (let c = 0; c < 3; c++) { const v = p[(j * PROBE_W + i) * 3 + c]; m[c] += v * w; d[c] += v * wc; }
  }
  return out;
}

const SH_OUT = [1 * 0.282095, (2 / 3) * 0.488603, (2 / 3) * 0.488603, (2 / 3) * 0.488603, 0.25 * 1.092548, 0.25 * 1.092548, 0.25 * 0.315392, 0.25 * 1.092548, 0.25 * 0.546274];
const acc = new Float64Array(27);
/**
 * Fit order-2 spherical harmonics to the sky as it is now (murk and gain included) with the ground's
 * bounce (a THREE.Color: radiance of the lower hemisphere) below, and publish them cosine-convolved in
 * ENV.uSkySH so that skyIrradiance(n) is irradiance / pi. scale and grey tune the result (see sky.js).
 */
export function fitSkyIrradiance(ground, scale = 1, grey = 0) {
  acc.fill(0);
  const dA = (2 * Math.PI) / PROBE_W;
  for (let j = 0; j < PROBE_H; j++) {
    const y0 = (j / PROBE_H) ** 2, y1 = ((j + 1) / PROBE_H) ** 2, y = ((j + 0.5) / PROBE_H) ** 2, h = Math.sqrt(1 - y * y), w = (y1 - y0) * dA;
    for (let i = 0; i < PROBE_W; i++) {
      const az = ((i + 0.5) / PROBE_W - 0.5) * 2 * Math.PI, x = Math.sin(az) * h, z = Math.cos(az) * h;
      skyRadiance(x, y, z, tmp);
      const b = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
      for (let k = 0; k < 9; k++) { acc[k * 3] += tmp.r * b[k] * w; acc[k * 3 + 1] += tmp.g * b[k] * w; acc[k * 3 + 2] += tmp.b * b[k] * w; }
    }
  }
  // The ground: constant over the lower hemisphere, which only the first two terms see.
  const g = [ground.r, ground.g, ground.b];
  for (let c = 0; c < 3; c++) { acc[c] += g[c] * 0.282095 * 2 * Math.PI; acc[3 + c] += g[c] * 0.488603 * -Math.PI; }
  const u = ENV.uSkySH.value;
  for (let k = 0; k < 9; k++) {
    let r = acc[k * 3] * SH_OUT[k] * scale, gg = acc[k * 3 + 1] * SH_OUT[k] * scale, b = acc[k * 3 + 2] * SH_OUT[k] * scale;
    const l = r * 0.25 + gg * 0.6 + b * 0.15;
    r += (l - r) * grey; gg += (l - gg) * grey; b += (l - b) * grey;
    st.sh[k * 3] = r; st.sh[k * 3 + 1] = gg; st.sh[k * 3 + 2] = b;
    u[k].set(r, gg, b);
  }
}

/** CPU mirror of skyIrradiance(). */
export function skyIrradiance(nx, ny, nz, out) {
  const s = st.sh, b = [1, ny, nz, nx, nx * ny, ny * nz, 3 * nz * nz - 1, nx * nz, nx * nx - ny * ny];
  let r = 0, g = 0, bl = 0;
  for (let k = 0; k < 9; k++) { r += s[k * 3] * b[k]; g += s[k * 3 + 1] * b[k]; bl += s[k * 3 + 2] * b[k]; }
  return out.setRGB(Math.max(r, s[0] * 0.12), Math.max(g, s[1] * 0.12), Math.max(bl, s[2] * 0.12));
}
