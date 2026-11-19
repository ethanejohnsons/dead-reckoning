// The view from space: the Earth, its air and clouds, the Moon, the sun and the stars.
//
// The planets are not meshes. One full-screen pass follows each pixel's ray from the camera (which sits at
// the origin; everything is placed relative to it in double precision before it reaches the GPU) and
// intersects it with spheres: the Earth's ground, a cloud shell 6.5 km up, the top of the air, the Moon.
//   - The ground takes its color from the clip levels of globetiles.js (Web Mercator, so a hit point's
//     latitude and longitude address them directly), lit by the sun through the air.
//   - Clouds come from the game's tiling noise volume laid over the sphere in bands (wet tropics, dry
//     subtropics, storm tracks), and, inside the game's window of the world, from the weather's own cloud
//     map, so the weather a rocket climbed out of is the weather seen from above. They have height: the
//     layer is a slab from one mile up to seven, the thick of a system standing tall in it and its edges
//     low, and the ray is walked down through the slab to where it first meets cloud, so from low down
//     the towers stand in front of what is behind them and slide against the ground as the camera moves.
//     They shade themselves and throw shadows on the ground. Detail finer than a pixel is left out (it
//     only shimmered), and what changes with distance is cross-faded, never stretched.
//   - The air is marched: Rayleigh and haze scattering with the sun's light followed down to each sample by a
//     closed-form optical depth (Schuler's approximation of the Chapman function), which gives the blue
//     limb, the white haze toward the sun, the red band at the terminator and the Earth's shadow in its
//     own air.
//   - The Moon is a sphere wearing NASA's maps of it: the Lunar Reconnaissance Orbiter's color mosaic, and
//     the slopes of its laser altimeter's terrain tilting the light (public/data/moon_*.jpg, baked by
//     tools/bake-moon.py); craters too small for the maps are generated in the shader down to the size of
//     a pixel. Lit without limb darkening, as lunar soil is.
// Stars are the game's catalog (world/stars.js) drawn first; the pass covers them where something is in front.
//
// After that pass, things with shape are drawn: what the caller puts in `far` (orbit lines, markers; depth
// against stand-in spheres for the Earth and the Moon) and in `near` (the vehicle, satellites close by),
// each with its own depth range, lit by the sun, by the light the Earth throws back, and by a small
// reflection map of the scene so bare metal has something to mirror.
//
// The result is an HDR picture in the engine's daylight units (see world/sky.js), ready for the same
// post-processing as the ground view.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { fsMaterial, FullscreenQuad } from '../render/fullscreen.js';
import { Stars, MILKY_CDM2 } from '../world/stars.js';
import { REGION } from '../world/geo.js';
import { air } from '../world/atmosphere.js';
import { RE, RM, D2R, sunDir, moonPos, earthAngle, eciToGeo, enu, dot, len } from './frames.js';
import { GlobeTiles, GLOBE_Z0, mercV } from './globetiles.js';
import { SolarSystem, SUN_GLSL } from './solar.js';

export const MOON_CREDIT = 'The Moon: NASA\'s Scientific Visualization Studio, CGI Moon Kit (Lunar Reconnaissance Orbiter Camera color, laser altimeter elevation)';

const S0 = 1.56;                            // sunlight above the air as irradiance / pi, in engine units (world/sky.js)
const K_LUM = (S0 * Math.PI) / 133000;      // engine radiance per cd/m2
const H_AIR = 80000, H_CLOUD = 6500;        // top of the marched air, and the middle of the cloud layer (m): where its shadow is cast from
const H_CTOP = 11500, H_CBASE = 1500;       // the cloud layer's top and bottom (m)
const CSTEPS = { low: 4, med: 5, high: 7, ultra: 9 };      // steps down through it
const NL = 11;                              // clip levels
const TILES = { low: 4, med: 6, high: 6, ultra: 8 };
const STEPS = { low: 10, med: 14, high: 16, ultra: 20 };

const FRAG = /* glsl */`
precision highp float; precision highp sampler3D; precision highp sampler2DArray;
in vec2 vUv; out vec4 outColor;
uniform mat4 uProjInv; uniform mat3 uCamRot;
uniform vec3 uEarthC, uEarthK;        // the Earth's center from the camera (m); |c|^2 - r^2 for the ground, the cloud shell, the top of the air
uniform vec2 uCloudK;                 // the same for the top and the bottom of the cloud layer
uniform mat3 uEarthRot;               // drawing axes to geographic: x through 0 E on the equator, y through 90 E, z the north pole
uniform vec3 uSun, uSunCol;           // direction to the sun (from the Earth); its light above the air (irradiance / pi)
uniform vec4 uSunV;                   // where the sun stands from the camera, and in w how many times smaller it looks than from the Earth (solar.js)
uniform vec3 uMoonC; uniform float uMoonK; uniform mat3 uMoonRot;      // (moon axes: x toward the Earth, z north)
uniform sampler2DArray tTiles, tMask; uniform vec4 uLevel[${NL}]; uniform float uTilesW;
uniform sampler3D tNoise; uniform float uClouds, uFar;        // uFar: 0 close to the Earth .. 1 seen whole
uniform sampler2D tWxA; uniform vec4 uWx;      // the game's weather map: Mercator u, v of its center, 1 / its width in Mercator units, 1 if there is one
uniform sampler2D tMilky; uniform vec3 uMilky;
uniform sampler2D tMoon, tMoonRelief; uniform float uMoonMap;      // the Moon's color and relief maps; 1 once both are there
uniform float uPix, uSunDisk;
uniform vec4 uAer;       // the haze of the air mass (world/atmosphere.js): extinction at the ground (1/m), scale height (m), single-scattering albedo, asymmetry

const float RE = ${RE.toFixed(1)}, RM = ${RM.toFixed(1)}, HR = 8000.0;
#define HM uAer.y
#define BME uAer.x
#define BMS (uAer.x * uAer.z)
const vec3 BR = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const vec3 BO = vec3(0.65e-6, 1.881e-6, 0.085e-6);

${SUN_GLSL}

// A ray from the origin along d against a sphere centered c, where k = |c|^2 - radius^2 (worked out in double precision).
bool sphere(vec3 d, vec3 c, float k, out float t0, out float t1) {
  float b = dot(d, c), disc = b * b - k;
  t0 = 0.0; t1 = 0.0;
  if (disc < 0.0) return false;
  float s = sqrt(disc);
  if (k > 0.0) { if (b <= 0.0) return false; t0 = k / (b + s); }
  t1 = b + s;
  return true;
}

// Optical depth to space from a height, in units of (density at the ground x scale height): X is the planet's
// radius and h the height, both in scale heights; mu the cosine of the angle from the vertical.
float chapman(float X, float h, float mu) {
  float c = sqrt(1.5707963 * (X + h));
  if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h), c0 = sqrt(1.5707963 * x0);
  return 2.0 * c0 * exp(min(X - x0, 0.0)) - c / (1.0 - c * mu) * exp(-h);
}
// Sunlight left at a point p (from the Earth's center, |p| = r).
vec3 sunAt(vec3 p, float r) {
  float mu = dot(p, uSun) / r, h = max(r - RE, 0.0);
  if (mu < 0.0 && r * r * (1.0 - mu * mu) < RE * RE) return vec3(0.0);          // the Earth is in the way
  float tr = HR * chapman(RE / HR, h / HR, mu), tm = HM * chapman(RE / HM, h / HM, mu);
  // (ozone sits in a layer about 25 km up: its column is nearly the same for any low sun, and it is what keeps the twilight band blue)
  float to = 14000.0 * exp(-max(h - 30000.0, 0.0) / 6000.0) / (max(mu, 0.0) + 0.06 + 0.2 * max(-mu, 0.0));
  return exp(-(BR * tr + BME * tm + BO * to));
}

// The air along a ray: from p0 (from the Earth's center) for L meters. ins: light scattered toward the eye, as radiance
// for a sun of irradiance pi; T: what survives of the light from beyond.
void air(vec3 p0, vec3 d, float L, out vec3 ins, out vec3 T) {
  float ds = L / float(STEPS), cs = dot(d, uSun);
  float pr = 0.0596831 * (1.0 + cs * cs);
  float g = uAer.w, pm = 0.0795775 * (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cs, 1e-4), 1.5);
  float oR = 0.0, oM = 0.0;
  ins = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = p0 + d * ((float(i) + 0.5) * ds);
    float r = length(p), h = max(r - RE, 0.0), dR = exp(-h / HR), dM = exp(-h / HM);
    vec3 Tv = exp(-(BR * (oR + 0.5 * dR * ds) + BME * (oM + 0.5 * dM * ds)));
    vec3 Ls = sunAt(p, r);
    // (the last term stands in for light scattered more than once: a little, the color of the sky, wherever the sun still reaches)
    ins += Tv * (Ls * (BR * dR * pr + BMS * dM * pm) + (Ls.b + 0.06 * Ls.r) * BR * dR * 0.022) * ds;
    oR += dR * ds; oM += dM * ds;
  }
  T = exp(-(BR * oR + BME * oM));
  ins *= 3.14159265;
}

// ---- the ground's picture
vec3 tiles(vec2 uv, float zw) {
  float lf = clamp(zw - ${GLOBE_Z0.toFixed(1)}, 0.0, ${(NL - 1).toFixed(1)});
  int top = int(ceil(lf));
  vec3 acc = vec3(0.0); float a = 0.0;
  for (int l = top; l >= 0; l--) {
    vec4 Lv = uLevel[l];
    if (Lv.w < 0.5) continue;
    vec2 f = uv * Lv.z, dl = vec2(mod(f.x - Lv.x, Lv.z), f.y - Lv.y);
    if (dl.x >= Lv.w || dl.y < 0.0 || dl.y >= Lv.w) continue;
    vec2 tc = Lv.xy + dl;
    float m = textureLod(tMask, vec3((floor(mod(tc, uTilesW)) + 0.5) / uTilesW, float(l)), 0.0).r;
    if (m <= 0.0) continue;
    float w = m * (l == top && top > 0 ? 1.0 - (float(top) - lf) : 1.0);
    acc += (1.0 - a) * w * textureLod(tTiles, vec3(tc / uTilesW, float(l)), 0.0).rgb;
    a += (1.0 - a) * w;
    if (a > 0.995) break;
  }
  return acc + (1.0 - a) * vec3(0.004, 0.012, 0.03);
}

// The value a blend of two or three of the noise's (evenly spread) channels exceeds over a fraction c of the globe.
float quant(float c) { c = clamp(c, 0.0, 1.0); return c < 0.5 ? 1.0 - sqrt(0.5 * c) : sqrt(0.5 * (1.0 - c)); }
// ---- clouds: how much cloud stands over a point of the globe (g: unit vector in geographic axes), 0..1. Also leaves in
// gTop how high it stands there, 0 (the bottom of the layer) .. 1 (its top). gFoot: a pixel's width on the globe, in radii.
float gTop, gFoot;
float cloudAt(vec3 g, vec2 uv) {
  vec3 w = textureLod(tNoise, g.zxy * 2.3 + 0.37, 0.0).rgb - 0.5;
  vec4 a = textureLod(tNoise, g * vec3(1.3, 1.3, 2.0) + vec3(0.13, 0.31, 0.57) + w * 0.3, 0.0);       // (stretched along the parallels, and stirred)
  // The middle detail at two fixed scales, the finer giving way to the coarser with distance, and the grain: each left
  // out as its texels (the noise is 128 across) shrink under a pixel. (One scale stretched as the camera drew away made
  // every cloud swim; grain finer than a pixel shimmered.)
  float fb = smoothstep(0.4, 1.3, gFoot * 9.0 * 128.0), fc = smoothstep(0.4, 1.3, gFoot * 61.0 * 128.0);
  float b = mix(mix(textureLod(tNoise, g.yzx * 9.0 + w * 0.3, 0.0).r, 0.5, fb), textureLod(tNoise, g.yzx * 3.3 + w * 0.3, 0.0).r, uFar);
  float c = mix(textureLod(tNoise, g * 61.0 + w * 0.2, 0.0).r, 0.5, max(uFar, fc));
  float lat = asin(clamp(g.z, -1.0, 1.0));
  // Wet along the equator, dry in the subtropics, stormy in the middle latitudes.
  float cover = 0.31 - 0.04 * uFar + 0.15 * cos(6.0 * lat) * (1.0 - 0.5 * smoothstep(1.0, 1.4, abs(lat))) + (a.a - 0.5) * 0.6;
  float shape = a.r * 0.5 + b * 0.32 + c * 0.18;
  float th = quant(cover * 0.9);
  // Thick in the middle of a system and thin toward its edge; from far off the edges are soft.
  float d = smoothstep(th - 0.05 - 0.05 * uFar, th + 0.08 + 0.10 * uFar, shape) * (0.62 + 0.38 * smoothstep(th, th + 0.22, shape));
  // And tall in the middle: the heart of a system reaches the top of the layer, its edges stay low.
  gTop = d * (0.3 + 0.7 * smoothstep(th + 0.02, th + 0.3, shape));
  if (uWx.w > 0.5) {
    // Inside the game's window the weather's own map decides: its cloud cover, broken by the same noise.
    vec2 q = vec2(fract(uv.x - uWx.x + 0.5) - 0.5, uv.y - uWx.y) * uWx.z;
    float e = max(abs(q.x), abs(q.y));
    if (e < 0.5) {
      vec4 wx = textureLod(tWxA, q + 0.5, 0.0);
      float cv = max(max(wx.r, 0.85 * wx.g), 0.2 * wx.a), fine = b * 0.55 + c * 0.45;       // (high cloud is thin: from above it hides little)
      float tl = quant(cv);
      float dl = smoothstep(tl - 0.04, tl + 0.06, fine) * (0.6 + 0.4 * smoothstep(0.0, 0.6, wx.r));
      gTop = mix(dl * (0.3 + 0.7 * smoothstep(tl + 0.02, tl + 0.3, fine)), gTop, smoothstep(0.38, 0.5, e));
      d = mix(dl, d, smoothstep(0.38, 0.5, e));
    }
  }
  return d * uClouds;
}
// The cloud over the point a ray reaches at t: how much, with the globe's direction there and its place on the map left in gc, uvc.
float cloudOn(vec3 d, float t, out vec3 nc, out vec3 gc, out vec2 uvc) {
  nc = normalize(t * d - uEarthC);
  gc = uEarthRot * nc; float sc = clamp(gc.z, -0.99999, 0.99999);
  uvc = vec2(atan(gc.y, gc.x) * 0.15915494 + 0.5, 0.5 - log((1.0 + sc) / (1.0 - sc)) * 0.0795775);
  return cloudAt(gc, uvc);
}

// ---- the Moon
float blob(vec2 q, float x, float y, float r) { vec2 d = (q - vec2(x, y)) / r; return 1.0 - smoothstep(0.1, 1.3, dot(d, d)); }
float maria(vec2 q) {
  q += 0.05 * vec2(sin(q.y * 9.0 + 1.3) + sin(q.y * 17.0), sin(q.x * 8.0 + 0.7) + sin(q.x * 19.0 + 2.0));
  float m = blob(q, -0.25, 0.50, 0.33) + blob(q, 0.27, 0.45, 0.20) + blob(q, 0.45, 0.14, 0.23) + blob(q, 0.78, 0.28, 0.12)
    + blob(q, 0.73, -0.08, 0.15) + blob(q, 0.52, -0.28, 0.10) + blob(q, -0.62, 0.22, 0.36) + blob(q, -0.58, -0.40, 0.11)
    + blob(q, -0.22, -0.38, 0.22) + blob(q, 0.04, 0.20, 0.09) + 0.6 * blob(q, 0.0, 0.84, 0.13) + 0.6 * blob(q, -0.32, 0.86, 0.12);
  return smoothstep(0.25, 0.95, m);
}
vec3 hash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
// One size of crater around p (in cells): adds to the slope (grad) and returns a brightness change (fresh rims and rays are bright).
float craters(vec3 p, float amp, inout vec3 grad) {
  vec3 ip = floor(p), fp = p - ip;
  float tone = 0.0;
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 hsh = hash3(ip + o), cpos = o + 0.25 + 0.5 * hsh - fp;        // from the crater's center to p, negated below
    float rad = 0.16 + 0.26 * hsh.x * hsh.y, r = length(cpos) / rad;
    if (r > 1.6) continue;
    vec3 dir = -cpos / max(length(cpos), 1e-4);
    // A bowl with a raised rim: the slope points inward inside the rim and outward on its skirt.
    float slope = r < 1.0 ? 1.9 * r : -3.2 * (1.6 - r) * smoothstep(1.6, 1.0, r);
    grad += dir * slope * amp * step(0.35, hsh.z);
    tone += (smoothstep(0.75, 1.0, r) * smoothstep(1.5, 1.05, r)) * 0.5 * step(0.8, hsh.z);
  }
  return tone;
}
vec3 moonColor(vec3 d, float t) {
  vec3 n = (t * d - uMoonC) / RM, m = uMoonRot * n;
  float foot = t * uPix / RM;                                    // a pixel, in Moon radii
  float tex = 0.0; vec3 grad = vec3(0.0), nb = n, albedo;
  if (uMoonMap > 0.5) {
    // The surveyed Moon: color from the orbiter's camera, relief from its laser altimeter (tools/bake-moon.py).
    float lat = asin(clamp(m.z, -1.0, 1.0));
    vec2 uv = vec2(atan(m.y, m.x) * 0.15915494 + 0.5, 0.5 + lat * 0.31830989);
    float lod = log2(max(foot * 651.9, 1.0));                    // texels of the 4096-wide map to a pixel
    vec3 rel = textureLod(tMoonRelief, uv, lod).rgb;
    vec2 slope = (rel.rg - 0.5) * 1.4 * 1.15;                    // toward the east, toward the north (a little steeper than life, to read at the game's exposure)
    vec3 east = vec3(-m.y, m.x, 0.0); east /= max(length(east), 1e-4);
    vec3 north = cross(m, east);
    vec3 nm = normalize(m - slope.x * east - slope.y * north);
    // Below what the maps resolve (a pixel of them is 2.7 km), small craters are generated, as far down as the screen shows.
    float f = 152.0, amp = 0.45;
    for (int i = 0; i < 4; i++) {
      if (foot * f > 0.22) break;
      tex += craters(m * f + float(i) * 17.3, amp, grad) * amp;
      f *= 2.35; amp *= 0.8;
    }
    vec3 gm = grad - m * dot(grad, m);
    nb = normalize((nm - gm * 0.16) * uMoonRot);
    albedo = textureLod(tMoon, uv, lod).rgb * 0.40 * (1.0 + 0.4 * tex);      // (0.40: the map's mean brightness to the Moon's mean albedo, 0.12)
  } else {
    // Until the maps have arrived: the near side's seas as the game's sky draws them, and generated craters.
    float sea = maria(vec2(m.y, m.z)) * smoothstep(-0.05, 0.25, m.x);
    float f = 5.0, amp = 1.0;
    for (int i = 0; i < 7; i++) {
      if (foot * f > 0.22) break;                                // craters smaller than a few pixels are left out
      tex += craters(m * f + float(i) * 17.3, amp * (1.0 - 0.6 * sea * step(float(i), 1.5)), grad) * amp;
      f *= 2.35; amp *= 0.8;
    }
    vec3 gm = grad - m * dot(grad, m);
    nb = normalize(n - (gm * uMoonRot) * 0.16);
    albedo = vec3(1.05, 1.0, 0.92) * mix(0.155, 0.072, sea) * (1.0 + 0.5 * tex);
  }
  float mu0 = dot(nb, uSun), mu = max(dot(n, -d), 0.0);
  float lit = smoothstep(-0.01, 0.04, dot(n, uSun)) * 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + mu + 0.03);
  return albedo * uSunCol * min(lit, 1.6);
}

void main() {
  vec4 vd = uProjInv * vec4(vUv * 2.0 - 1.0, -1.0, 1.0);          // (a point on the near plane: the far one is too far for single precision)
  vec3 d = normalize(uCamRot * (vd.xyz / vd.w));

  // ---- beyond everything: the Milky Way and the sun's disk
  vec3 e = vec3(d.x, -d.z, d.y);                                     // back to equatorial axes
  vec3 mw = textureLod(tMilky, vec2(0.5 - atan(e.y, e.x + 1.0e-6) * 0.15915494, 0.5 + asin(clamp(e.z, -1.0, 1.0)) * 0.31830989), 0.0).rgb;
  vec3 col = mw * mw * uMilky;
  col += uSunCol * sunGlow(d, uSunV) * uSunDisk;
  float cov = 0.0;

  float t0, t1, tm0, tm1;
  bool hitMoon = sphere(d, uMoonC, uMoonK, tm0, tm1) && uMoonK > 0.0;
  float a0, a1, g0, g1;
  bool inAir = sphere(d, uEarthC, uEarthK.z, a0, a1);
  bool hitGround = inAir && sphere(d, uEarthC, uEarthK.x, g0, g1) && uEarthK.x > 0.0;
  if (hitMoon && !(hitGround && g0 < tm0)) { col = moonColor(d, tm0); cov = 1.0; }

  if (inAir) {
    float tEnd = a1;
    if (hitMoon && tm0 < a0) inAir = false;                         // the Moon is in front of the Earth
    else if (hitGround) {
      vec3 pg = g0 * d - uEarthC, n = pg / RE, g = uEarthRot * n;
      float s = clamp(g.z, -0.99999, 0.99999), cl = sqrt(1.0 - s * s);
      vec2 uv = vec2(atan(g.y, g.x) * 0.15915494 + 0.5, 0.5 - log((1.0 + s) / (1.0 - s)) * 0.0795775);
      float nl = dot(n, uSun);
      float zw = log2(40030174.0 * max(cl, 0.02) / (256.0 * max(g0 * uPix, 0.5))) - 0.35;
      vec3 alb = tiles(uv, zw);
      float cap = smoothstep(0.9950, 0.9962, abs(s));
      float lum = dot(alb, vec3(0.25, 0.6, 0.15));
      float water = smoothstep(0.003, 0.012, alb.b - max(alb.r, alb.g)) * (1.0 - smoothstep(0.05, 0.12, lum)) * (1.0 - cap);
      // The mosaic is a dark picture: forest comes out of it at a few percent, hardly above the sea. The game's ground
      // shader lifts it to what the land reflects before lighting it (world/chunks.js: the gain and its shoulder), and
      // the same is done here, or from orbit the continents sink into the blue of the air over them. The sea stays dark.
      vec3 land = alb * 2.9;
      land = land / (1.0 + 1.45 * land) * (1.0 + 0.55 * smoothstep(1.6, 2.9, dot(land, vec3(0.3, 0.55, 0.15))));
      land = mix(vec3(dot(land, vec3(0.3, 0.55, 0.15))), land, 1.25);                      // (and a little more color, against the haze)
      alb = mix(max(land, 0.0), alb * 1.3, water);
      // Beyond the map's reach: sea ice in the north, the ice sheet in the south.
      alb = mix(alb, s > 0.0 ? vec3(0.62, 0.68, 0.74) : vec3(0.80, 0.82, 0.85), cap);

      // Clouds: where the ray meets the shell, and the shadow of the cloud between the ground and the sun.
      float c0, c1, b0, b1, cd = 0.0, shade = 1.0; vec3 nc = n; float tc = g0;
      vec3 sunT = uSun - n * nl;                                    // toward the sun along the ground
      gFoot = g0 * uPix / RE;
      if (uClouds > 0.0) {
        if (sphere(d, uEarthC, uCloudK.x, c0, c1) && uCloudK.x > 0.0 && sphere(d, uEarthC, uCloudK.y, b0, b1)) {
          // Down through the layer from its top to its bottom, to the first place the cloud stands higher than the ray:
          // between the last step above it and the first below, where the two heights cross. From far off (where the
          // layer is thinner than a pixel) one look in the middle of it does.
          vec3 gc; vec2 uvc;
          float top = 0.0, hit = 0.5;
          if (uFar > 0.75) { tc = mix(c0, b0, 0.5); cd = cloudOn(d, tc, nc, gc, uvc); top = gTop; }
          else {
            float pt = c0, pd = -1.0; tc = b0; hit = 0.0;
            for (int i = 0; i < CSTEPS; i++) {
              float s = (float(i) + 0.5) / float(CSTEPS), t = mix(c0, b0, s);
              cloudOn(d, t, nc, gc, uvc);
              float over = gTop - (1.0 - s);                        // > 0: the cloud here stands above the ray
              if (over > 0.0) { float f = clamp(pd / (pd - over), 0.0, 1.0); tc = mix(pt, t, f); hit = 1.0 - mix(s - 1.0 / float(CSTEPS), s, f); break; }
              pt = t; pd = over;
            }
            cd = cloudOn(d, tc, nc, gc, uvc); top = gTop;
          }
          // Relief: lower cloud toward the sun means this side is lit, higher means it lies in shadow; and what is met
          // low down, between the towers, has less of the sky over it.
          cloudAt(normalize(gc + (uEarthRot * sunT) * 0.0016), uvc);
          shade = clamp(1.0 + 1.5 * (top - gTop), 0.4, 1.4) * mix(0.88, 1.0, smoothstep(0.0, 0.6, hit));
        }
        float reach = ${(H_CLOUD / RE).toFixed(6)} / max(nl, 0.12);
        float sh = cloudAt(normalize(g + (uEarthRot * sunT) * reach), uv);
        // (the shadow darkens the direct light only)
        vec3 Ls = sunAt(pg, RE) * uSunCol;
        vec3 skyL = uSunCol * vec3(0.045, 0.075, 0.13) * smoothstep(-0.12, 0.25, nl);
        vec3 r = reflect(-uSun, n);
        float glint = pow(max(dot(r, -d), 0.0), 90.0) * 2.2 + pow(max(dot(r, -d), 0.0), 900.0) * 30.0;
        vec3 ground = alb * (Ls * max(nl, 0.0) * (1.0 - 0.72 * sh) + skyL) + water * Ls * glint * (1.0 - sh) * 0.06;
        float nlc = dot(nc, uSun);
        vec3 Lc = sunAt(nc * (RE + ${H_CLOUD.toFixed(1)}), RE + ${H_CLOUD.toFixed(1)}) * uSunCol;
        vec3 cloud = 0.82 * (Lc * clamp(nlc * 1.25 + 0.06, 0.0, 1.0) * shade + skyL * 1.6);
        col = mix(ground, cloud, cd);
      } else {
        vec3 Ls = sunAt(pg, RE) * uSunCol;
        vec3 skyL = uSunCol * vec3(0.045, 0.075, 0.13) * smoothstep(-0.12, 0.25, nl);
        col = alb * (Ls * max(nl, 0.0) + skyL);
      }
      cov = 1.0;
      tEnd = mix(g0, tc, cd);
    } else if (hitMoon) tEnd = min(tEnd, tm0);
    if (inAir && tEnd > a0) {
      vec3 ins, T;
      air(a0 * d - uEarthC, d, tEnd - a0, ins, T);
      col = col * T + ins * uSunCol;
      if (!hitGround && !hitMoon) cov = 1.0 - dot(T, vec3(0.3333));
      else if (!hitGround) cov = 1.0;
    }
  }
  outColor = vec4(col, cov);
}`;

const ENV_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uEarthDir, uEarthCol, uSun, uSunCol; uniform float uEarthCos;
void main() {
  vec3 d = normalize(vDir);
  float e = smoothstep(uEarthCos - 0.02, uEarthCos + 0.02, dot(d, uEarthDir));
  // The Earth as a soft blue-white disk (brighter toward the sun's side), a glow for the sun, and a trace of light everywhere else.
  vec3 col = mix(vec3(0.004), uEarthCol * (0.55 + 0.45 * dot(d, uSun)), e);
  col += uSunCol * pow(max(dot(d, uSun), 0.0), 600.0) * 30.0 * (1.0 - e);
  gl_FragColor = vec4(col, 1.0);
}`;

const m3 = new THREE.Matrix3(), m4 = new THREE.Matrix4(), v3 = new THREE.Vector3(), vA = [0, 0, 0], vB = [0, 0, 0], vC = [0, 0, 0], geo = {}, B = new Array(9);

export class Cosmos {
  constructor(renderer, quality = 'high') {
    this.renderer = renderer; this.quality = quality;
    this.quad = new FullscreenQuad();
    this.tiles = new GlobeTiles(renderer, TILES[quality] || 6, NL);
    this.rt = null; this.w = 0; this.h = 0;
    this.camera = new THREE.PerspectiveCamera(58, 1, 1, 1e10);
    this.camera.matrixAutoUpdate = true;

    const V = () => ({ value: new THREE.Vector3() }), M = () => ({ value: new THREE.Matrix3() });
    this.u = {
      uProjInv: { value: new THREE.Matrix4() }, uCamRot: M(), uEarthC: V(), uEarthK: V(), uEarthRot: M(),
      uCloudK: { value: new THREE.Vector2() }, uSun: V(), uSunV: { value: new THREE.Vector4(1, 0, 0, 1) }, uSunCol: { value: new THREE.Vector3(S0, S0, S0) }, uMoonC: V(), uMoonK: { value: 1 }, uMoonRot: M(),
      tTiles: { value: this.tiles.texture }, tMask: { value: this.tiles.maskTexture }, uLevel: { value: this.tiles.uniform }, uTilesW: { value: this.tiles.W },
      tNoise: ENV.tCloudNoise, uClouds: { value: 1 }, uFar: { value: 0 }, tWxA: ENV.tWxA, uWx: { value: new THREE.Vector4(0, 0, 1, 0) },
      tMoon: { value: null }, tMoonRelief: { value: null }, uMoonMap: { value: 0 },
      tMilky: { value: null }, uMilky: V(), uPix: { value: 0.001 }, uSunDisk: { value: 1 }, uAer: { value: new THREE.Vector4(2.2e-5, 4100, 0.9, 0.8) },
    };
    this.mat = fsMaterial(FRAG, this.u, { defines: { STEPS: STEPS[quality] || 16, CSTEPS: CSTEPS[quality] || 7 } });
    Object.assign(this.mat, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });

    // Stars: the catalog again, in a scene of its own (equatorial axes map straight onto the drawing axes).
    this.starScene = new THREE.Scene();
    this.stars = new Stars(this.starScene);
    this.stars.onMilky = (t) => { this.u.tMilky.value = t; };
    // The Moon's maps (NASA's CGI Moon Kit, baked by tools/bake-moon.py): until both arrive the Moon is drawn generated.
    this.moonMaps = 0;
    const loader = new THREE.TextureLoader(), moonMap = (file, srgb, to) => loader.load(`${import.meta.env.BASE_URL}data/${file}`, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
      this.u[to].value = t;
      if (++this.moonMaps === 2) this.u.uMoonMap.value = 1;
    }, undefined, () => console.warn(`${file} did not load: the Moon stays generated`));
    const blank = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); blank.needsUpdate = true;
    this.u.tMoon.value = blank; this.u.tMoonRelief.value = blank;
    moonMap('moon_color.jpg', true, 'tMoon'); moonMap('moon_relief.jpg', false, 'tMoonRelief');
    this.u.tMilky.value = this.stars.milky;
    this.starGain = 3000;

    // Things with shape. `far` is drawn against stand-in spheres for the Earth and the Moon; `near` on top of everything.
    this.far = new THREE.Scene(); this.near = new THREE.Scene();
    this.chart = new THREE.Scene();          // lines laid over the picture whatever their distance, with no depth: the chart of the solar system (solarchart.js)
    const hide = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.earthBall = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), hide); this.earthBall.scale.setScalar(RE);
    this.moonBall = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), hide); this.moonBall.scale.setScalar(RM);
    this.earthBall.renderOrder = this.moonBall.renderOrder = -10;
    this.far.add(this.earthBall, this.moonBall);
    const lights = () => {
      const sun = new THREE.DirectionalLight(0xffffff, 1), earth = new THREE.DirectionalLight(0xffffff, 0), amb = new THREE.AmbientLight(0xffffff, 0.012);
      return { sun, earth, amb, all: [sun, sun.target, earth, earth.target, amb] };
    };
    this.nearLights = lights(); this.farLights = lights();
    this.near.add(...this.nearLights.all); this.far.add(...this.farLights.all);
    // Up close the sun throws shadows: the vehicle on itself (see shadowAround).
    { const sh = this.nearLights.sun.shadow; this.nearLights.sun.castShadow = true; sh.mapSize.set(2048, 2048); sh.bias = -0.0006; sh.normalBias = 0.06; }

    // What bare metal mirrors: a small cube map of the Earth's disk and the sun, refreshed now and then.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envU = { uEarthDir: V(), uEarthCol: V(), uSun: V(), uSunCol: V(), uEarthCos: { value: 0 } };
    this.envScene = new THREE.Scene();
    const envMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), new THREE.ShaderMaterial({
      uniforms: this.envU, side: THREE.BackSide, depthTest: false, depthWrite: false, fragmentShader: ENV_FRAG,
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position * 100.0, 1.0); }',
    }));
    envMesh.frustumCulled = false; this.envScene.add(envMesh);
    this.envRT = null; this.envT = 0; this.envKey = '';

    // The sun as it stands from wherever the camera is, the planets, and the light they give (solar.js).
    this.solar = new SolarSystem(renderer, this.u);

    this.sun = [1, 0, 0]; this.moon = [0, 0, 0]; this.cam = [0, 0, 0];
    this.sunlit = 1;                     // 0 in the Earth's shadow
    this.exposure = 1;
  }

  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.mat.defines.STEPS = STEPS[q] || 16; this.mat.defines.CSTEPS = CSTEPS[q] || 7; this.mat.needsUpdate = true;
    // (the windows keep the size they were made with: remaking the tile store mid-flight would blank the planet)
  }
  setSize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }

  /** Where a thing at an ECI position is drawn: relative to the camera, in drawing axes. Call after begin(). */
  place(obj, r) { obj.position.set(r[0] - this.cam[0], r[2] - this.cam[2], -(r[1] - this.cam[1])); return obj; }

  /**
   * Set the frame up. view: { pos: [x, y, z] ECI (m), quat: the camera's orientation in drawing axes, fov (degrees), aspect }.
   * After this, place() works and the lights point the right way; then call draw().
   */
  begin(view, clock, t, dt = 0.016) {
    const u = this.u, cam = this.camera, p = view.pos;
    this.cam[0] = p[0]; this.cam[1] = p[1]; this.cam[2] = p[2];
    cam.position.set(0, 0, 0); cam.quaternion.copy(view.quat); cam.fov = view.fov; cam.aspect = view.aspect;
    cam.near = 1; cam.far = 1e10; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
    u.uPix.value = (view.fov * D2R) / Math.max(this.h, 1);

    // The Earth.
    const d2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2], dist = Math.sqrt(d2), h = dist - RE;
    u.uEarthC.value.set(-p[0], -p[2], p[1]);
    u.uEarthK.value.set(d2 - RE * RE, d2 - (RE + H_CLOUD) ** 2, d2 - (RE + H_AIR) ** 2);
    u.uCloudK.value.set(d2 - (RE + H_CTOP) ** 2, d2 - (RE + H_CBASE) ** 2);
    const th = earthAngle(clock, t), c = Math.cos(th), s = Math.sin(th);
    u.uEarthRot.value.set(c, 0, -s, -s, 0, -c, 0, 1, 0);
    this.earthBall.position.copy(u.uEarthC.value);

    // The sun and the Moon.
    sunDir(clock, t, this.sun); moonPos(clock, t, this.moon);
    u.uSun.value.set(this.sun[0], this.sun[2], -this.sun[1]);
    const mx = this.moon[0] - p[0], my = this.moon[1] - p[1], mz = this.moon[2] - p[2];
    u.uMoonC.value.set(mx, mz, -my);
    u.uMoonK.value = mx * mx + my * my + mz * mz - RM * RM;
    this.moonBall.position.copy(u.uMoonC.value);
    // The Moon keeps one face to the Earth: x toward the Earth, z as near the pole as that allows.
    const ml = len(this.moon), ex = [-this.moon[0] / ml, -this.moon[1] / ml, -this.moon[2] / ml];
    let ey = [-ex[1], ex[0], 0]; const el = Math.hypot(ey[0], ey[1]) || 1; ey = [ey[0] / el, ey[1] / el, 0];
    const ez = [ex[0] * ey[1] * 0 - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * 0, ex[0] * ey[1] - ex[1] * ey[0]];
    // rows: moon axes written in drawing axes (x, z, -y of ECI)
    u.uMoonRot.value.set(ex[0], ex[2], -ex[1], ey[0], ey[2], -ey[1], ez[0], ez[2], -ez[1]);

    // Is the camera in the Earth's shadow?
    const along = dot(p, this.sun), perp = Math.sqrt(Math.max(d2 - along * along, 0));
    this.sunlit = along > 0 ? 1 : THREE.MathUtils.smoothstep(perp, RE - 20000, RE + 60000);

    // The game's weather map lies over its window of the world.
    const K = Math.cos(REGION.lat0 * D2R), half = ENV.uWxHalf.value;
    u.uWx.value.set(REGION.lon0 / 360 + 0.5, mercV(REGION.lat0), (2 * Math.PI * 6378137 * K) / (2 * half), this.weatherOn && ENV.tWxA.value ? 1 : 0);

    // Tiles: centered under the camera, pushed toward where it looks; as sharp as the height asks.
    eciToGeo(clock, t, p, geo); enu(p, B);
    v3.set(0, 0, -1).applyQuaternion(view.quat);
    vA[0] = v3.x; vA[1] = -v3.z; vA[2] = v3.y;
    const fe = dot(vA, [B[0], B[1], B[2]]), fn = dot(vA, [B[3], B[4], B[5]]), fu = dot(vA, [B[6], B[7], B[8]]);
    const push = 0.3 * Math.max(0, 1 + Math.min(fu, 0)) * (h < 3e6 ? 1 : 0);      // looking straight down, or from far away: no push
    const foot = Math.max(h, 1000) * u.uPix.value, cl = Math.max(Math.cos(geo.lat * D2R), 0.05);
    const zMax = Math.log2((40030174 * cl) / (256 * foot)) + 0.6 - GLOBE_Z0;
    this.tiles.update(dt, geo.lat, geo.lon, { e: fe * push, n: fn * push }, zMax);
    this.alt = h;
    u.uFar.value = THREE.MathUtils.smoothstep(h, 4e5, 6e6);

    // Lights for what has shape: the sun from where it stands here, and the light the nearest world throws back (the
    // Earth, until the camera is nearer another planet: solar.js).
    const sol = this.solar.frame(this, clock, t, K_LUM * this.starGain, this.renderer.getPixelRatio()), sh = sol.shine;
    const earthLit = sh.lit, big = sh.big, sunP = this.sunlit * sol.sunPower, hd = sh.body.dist / sh.body.R;
    for (const L of [this.nearLights, this.farLights]) {
      L.sun.position.copy(sol.sunView).multiplyScalar(100); L.sun.target.position.set(0, 0, 0);
      L.sun.color.setRGB(1, 0.98, 0.95).multiplyScalar(S0 * Math.PI * sunP);
      L.earth.position.copy(sh.dir).multiplyScalar(100); L.earth.target.position.set(0, 0, 0);
      L.earth.color.setRGB(sh.col.x, sh.col.y, sh.col.z).multiplyScalar(S0 * Math.PI * 0.3 * earthLit * big);
      L.sun.updateMatrixWorld(); L.sun.target.updateMatrixWorld(); L.earth.updateMatrixWorld(); L.earth.target.updateMatrixWorld();
    }
    // The reflection map, when the scene has changed enough to see.
    this.envT -= dt;
    v3.copy(sh.dir);
    const key = `${sh.body.id}|${Math.round(v3.x * 12)}|${Math.round(v3.y * 12)}|${Math.round(v3.z * 12)}|${Math.round(sol.sunView.x * 12)}|${Math.round(sol.sunView.z * 12)}|${Math.round(earthLit * 8)}|${Math.round(Math.log2(hd) * 6)}|${Math.round(sunP * 4)}`;
    if (!this.envRT || (key !== this.envKey && this.envT <= 0)) {
      this.envKey = key; this.envT = 0.7;
      const eu = this.envU;
      eu.uEarthDir.value.copy(v3); eu.uEarthCos.value = sh.cos;
      eu.uEarthCol.value.copy(sh.sky).multiplyScalar(S0 * earthLit * 1.3);
      eu.uSun.value.copy(sol.sunView); eu.uSunCol.value.set(S0, S0, S0).multiplyScalar(sunP);
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
      this.envRT?.dispose(); this.envRT = rt;
      this.near.environment = rt.texture; this.far.environment = rt.texture;
    }

    // How dark is it? Stars come out when neither the sun nor the sunlit Earth fills the view.
    const ang = Math.acos(THREE.MathUtils.clamp(v3.set(0, 0, -1).applyQuaternion(view.quat).dot(sh.dir), -1, 1));
    const er = sh.ang, half2 = (view.fov * D2R) * 0.7;
    const earthIn = THREE.MathUtils.smoothstep(er + half2 - ang, 0, half2 * 1.6) * (0.15 + 0.85 * earthLit) * (hd < 6.28 ? 1 : (6.28 / hd) ** 2);
    const sunIn = THREE.MathUtils.smoothstep(v3.dot(sol.sunView), 0.55, 0.95) * Math.min(sunP, 1);
    const dark = 1 - THREE.MathUtils.clamp(Math.max(earthIn, sunIn * 0.8), 0, 1);
    const want = Math.exp(Math.log(1500) + (Math.log(2.5e5) - Math.log(1500)) * dark);
    this.starGain += (want - this.starGain) * Math.min(1, dt * 1.2 + (dt === 0 ? 1 : 0));
    this.exposure += ((1.25 + 1.5 * dark * dark) - this.exposure) * Math.min(1, dt * 1.2 + (dt === 0 ? 1 : 0));
    const mwk = 2.5 * K_LUM * MILKY_CDM2 * this.starGain;
    u.uMilky.value.setScalar(this.stars.milkyReady ? mwk : 0);
    const pixWas = ENV.uPixAngle.value; ENV.uPixAngle.value = u.uPix.value;
    this.stars.uCel.value.set(1, 0, 0, 0, 0, 1, 0, -1, 0);
    this.stars.update([1, 0, 0, 0, 0, 1, 0, -1, 0], K_LUM * this.starGain, [0, 0, 0], 2, 0, this.renderer.getPixelRatio());
    ENV.uPixAngle.value = pixWas;
    u.uSunCol.value.set(S0, S0, S0);
    u.uAer.value.set(air.ext / 1000, air.H * 1000, air.albedo, air.g);
    return this;
  }

  /** Fit the near sun's shadow to a thing: center (drawing axes, after begin) and half-size (m). */
  shadowAround(center, half) {
    const L = this.nearLights.sun, c = L.shadow.camera;
    L.target.position.copy(center); L.position.copy(center).addScaledVector(this.solar.sunView, half * 3);
    if (c.right !== half) { c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 1; c.far = half * 6; c.updateProjectionMatrix(); }
    L.updateMatrixWorld(); L.target.updateMatrixWorld();
  }

  /** Draw the frame set up by begin() into this.rt (HDR, alpha: 1 where the sky is open). Returns its texture. */
  draw() {
    const r = this.renderer, cam = this.camera, auto = r.autoClear, rtWas = r.getRenderTarget();
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.autoClear = false;
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 1); r.clear(true, true, false);
    cam.near = 1; cam.far = 1e10; cam.updateProjectionMatrix();
    r.render(this.starScene, cam);
    // The sun and the planets (solar.js): those beyond the Earth before it, those nearer after. Far from the Earth its
    // own pass is left out, and the Earth and the Moon are two more specks among them.
    this.solar.draw(this.rt, cam, 'beyond');
    if (this.solar.earthOn) this.quad.draw(r, this.mat, this.rt);
    this.solar.draw(this.rt, cam, 'within');
    // Far things: depth from a tenth of the way to the nearest surface out to beyond the Moon.
    const dE = Math.sqrt(this.u.uEarthK.value.x > 0 ? this.u.uEarthK.value.x : 1), dM = Math.sqrt(Math.max(this.u.uMoonK.value, 1));
    if (this.far.children.length > 7) {
      cam.near = Math.max(2000, 0.1 * Math.min(dE, dM)); cam.far = 4e9; cam.updateProjectionMatrix();
      r.setRenderTarget(this.rt); r.clearDepth();
      r.render(this.far, cam);
    }
    if (this.chart.children.some((o) => o.visible)) {
      cam.near = 1e5; cam.far = 1e15; cam.updateProjectionMatrix();
      r.setRenderTarget(this.rt);
      r.render(this.chart, cam);
    }
    if (this.near.children.length > 5) {
      cam.near = this.nearClip || 2; cam.far = 80000; cam.updateProjectionMatrix();
      r.setRenderTarget(this.rt); r.clearDepth();
      r.render(this.near, cam);
    }
    cam.near = 1; cam.far = 1e10; cam.updateProjectionMatrix();
    r.autoClear = auto; r.setClearColor(cc, ca); r.setRenderTarget(rtWas);
    return this.rt.texture;
  }
}
