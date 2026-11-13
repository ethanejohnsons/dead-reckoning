// Airfield scenery, built from the real layout of each field (airports.js):
// runways, taxiways and aprons painted on the ground as one layer of decals,
// extruded buildings, steady lights, and a windsock that answers to the wind.
//
// Pavement is drawn by one shader. The surface is tiling detail at several
// scales in field coordinates (aggregate, mottling, crack webs kept as distance
// fields so they stay hair-fine up close) plus seams, patches, stains and rubber
// worked out per pixel; paint is not a texture at all but geometry evaluated per
// pixel and box-filtered over the pixel's footprint, so it is as sharp as the
// screen allows at any range and fades instead of shimmering when it gets thin.
// Everything is lit as the terrain is (sun, sky, mountain and cloud shadow, haze)
// and takes the aircraft's shadow from the scene's shadow map; the buildings
// throw their own shadows on the ground as flat shapes swept along the sun.

import * as THREE from 'three';
import { AIRPORTS } from './airports.js';
import { ENV } from '../core/env.js';
import { ATMO_GLSL, ATMO_UNIFORMS } from './atmosphere.js';
import { GROUND_LIGHT_GLSL, GROUND_LIGHT_UNIFORMS } from './groundlight.js';
import { mulberry32 } from '../core/noise.js';

// A field's scenery exists only this close to the camera: far enough that a field is in sight before the haze
// lets go of it on a clear day. Out there it is three draw calls (pavement, buildings, lamps); the building
// shadows and the windsocks are drawn only from close by.
const BUILD_DIST = 60000, DROP_DIST = 70000, SHADE_DIST = 7000, SOCK_DIST = 6000;
const LAMP_MIRROR = 45;              // the lamps' reflections in wet pavement, against what their drawn size and brightness would give
const KIND = { asphalt: 0, concrete: 1, gravel: 2, grass: 3 };
const T_AREA = 0, T_RIBBON = 1, T_RUNWAY = 2, T_LINE = 3, T_HOLD = 4, T_STRIP = 5;

// ------------------------------------------------------------------ shaders

/** The terrain's lighting helpers: mountain shadow, sky occlusion, cloud shadow and the local shadows, all read from baked maps (world/groundlight.js). */
const LIGHT_GLSL = /* glsl */`
uniform sampler2D tRegion, tWxA, tWxB, tDetail;
uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround, uCloudDrift;
uniform float uWxHalf, uTAnom, uWet, uSnow, uGroundT;
float regionHeight(vec2 xz) { return max(texture2D(tRegion, xz / (2.0 * uWxHalf) + 0.5).r, 0.0); }
// The cold at a place. x: snow lying there (0..1): what has fallen around the aircraft (uSnow), wherever today's air
// lets it lie. y: how hard the ground is frozen (0 above freezing .. 1 from two degrees under: water does not lie as
// water there). The regional map carries the level snow lies above on an ordinary day, where the air is about 2 C;
// the weather's temperature shift moves it 150 m a degree (the rule of snowLine() in world/terrain.js), which gives
// the temperature here. The pack was measured where the air at the ground is uGroundT: snow lies on ground as cold as
// that and not on ground more than a few degrees warmer (the valley under a snowy pass), and it stays until the weather
// model melts it. So the pack decides when the ground turns white and when it clears, not the thermometer.
vec2 groundCold(vec3 p) {
  float hs = p.y - texture2D(tRegion, p.xz / (2.0 * uWxHalf) + 0.5).a - uTAnom * 150.0, t = 2.2 - hs / 150.0;
  return vec2(uSnow * (1.0 - smoothstep(2.0, 7.0, t - max(uGroundT, 1.8))), smoothstep(350.0, 650.0, hs));
}
${GROUND_LIGHT_GLSL}`;
const LIGHT_UNIFORMS = ['tRegion', 'tWxA', 'tWxB', 'tDetail', 'uSunDir', 'uSunCol', 'uAmbSky', 'uAmbGround', 'uCloudDrift', 'uWxHalf', 'uTAnom', 'uWet', 'uSnow', 'uGroundT', ...GROUND_LIGHT_UNIFORMS];
const shared = (names) => Object.fromEntries(names.map((k) => [k, ENV[k]]));

const PAVE_VERT = /* glsl */`
#include <common>
#include <shadowmap_pars_vertex>
attribute vec4 aRC, aP0, aP1;
// The scene is multisampled. A plain varying is evaluated at the pixel center even when only a corner of
// the pixel is covered, and on ground seen edge-on that center can lie past the plane's horizon, where
// the value is garbage. So everything that is used as a value is centroid-sampled (always inside the
// triangle); vGrad carries the same coordinates plainly, for screen-space derivatives only.
centroid varying vec3 vWorld, vN;
centroid varying vec2 vLocal, vLight;
centroid varying vec4 vRC, vP0, vP1;
centroid varying vec2 vCold;
varying vec4 vGrad;
${LIGHT_GLSL}
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xyz; vLocal = position.xz; vN = normal;
  vCold = groundCold(vWorld);
  vRC = aRC; vP0 = aP0; vP1 = aP1; vGrad = vec4(aRC.xy, position.xz);
  float hReg = regionHeight(vWorld.xz);
  vLight = vec2(terrainShadow(vWorld, hReg), skyOcclusion(vWorld, hReg));
  // Far away the terrain under the pavement is a coarser mesh that no longer follows the graded plane
  // to the centimeter: ride a little above it, by less than a pixel's worth.
  vec3 transformed = position;
  transformed.y += max(distance(vWorld, cameraPosition) - 600.0, 0.0) * 0.0004;
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vec3 transformedNormal = normalMatrix * normal;
  #include <shadowmap_vertex>
}`;

const PAVE_FRAG = /* glsl */`
#include <common>
#include <packing>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>
uniform sampler2D tPave;
uniform vec4 uGlyph[130];
uniform float uRain, uWind, uTime, uLampGlow;
centroid varying vec3 vWorld, vN;
centroid varying vec2 vLocal, vLight;
centroid varying vec4 vRC, vP0, vP1;
centroid varying vec2 vCold;
varying vec4 vGrad;
${LIGHT_GLSL}
${ATMO_GLSL}

// Share of the interval [a, b] seen by a pixel centered on x whose footprint is w wide.
float cov1(float a, float b, float x, float w) { return clamp((min(b, x + 0.5 * w) - max(a, x - 0.5 * w)) / w, 0.0, 1.0); }
float rectCov(vec2 p, vec2 lo, vec2 hi, vec2 fw) { return cov1(lo.x, hi.x, p.x, fw.x) * cov1(lo.y, hi.y, p.y, fw.y); }
// The same for a train of bars (each \`duty\` wide, every \`period\`): exact at any range, so it cannot moire.
float pulseI(float x, float period, float duty) { float k = floor(x / period); return k * duty + min(x - k * period, duty); }
float pulses(float x, float period, float duty, float w) { return clamp((pulseI(x + 0.5 * w, period, duty) - pulseI(x - 0.5 * w, period, duty)) / w, 0.0, 1.0); }
// A straight stroke from a to b, hw either side, cut square at both ends.
float stroke(vec2 p, vec2 a, vec2 b, float hw, vec2 fw) {
  vec2 d = b - a; float l = max(length(d), 1e-5); d /= l; vec2 n = vec2(-d.y, d.x);
  vec2 q = vec2(dot(p - a, d), dot(p - a, n));
  vec2 f = vec2(abs(d.x) * fw.x + abs(d.y) * fw.y, abs(n.x) * fw.x + abs(n.y) * fw.y);
  return cov1(0.0, l, q.x, f.x) * cov1(-hw, hw, q.y, f.y);
}
float hash1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

// One numeral or letter (10 L, 11 C, 12 R): q in meters from the lower left corner of its box, h its height.
float digit(vec2 q, float n, float h, vec2 fw) {
  float c = 0.0; int base = int(n + 0.5) * 10;
  vec2 g = q / h, fg = fw / h;
  for (int i = 0; i < 10; i++) {
    vec4 s = uGlyph[base + i];
    if (s.x < -0.5) break;
    c = max(c, stroke(g, s.xy, s.zw, 0.043, fg));
  }
  return c;
}
// A runway's designator as it is painted in the United States, read by a pilot looking along +y: one numeral or two
// (no leading zero: "4", not "04"), and under them, nearer the threshold, the letter of a parallel runway.
// code: the number + 100 x the letter (0 none, 1 L, 2 C, 3 R). q.y is measured from the foot of the lowest character;
// up: how far above that the numerals stand (designatorRise).
float designatorRise(float code, float h) { return code > 99.5 ? 1.33 * h : 0.0; }
float designator(vec2 q, float code, float h, vec2 fw) {
  float letter = floor(code / 100.0 + 0.01), num = code - letter * 100.0, up = designatorRise(code, h);
  if (abs(q.x) > 0.42 * h + fw.x || q.y < -fw.y || q.y > up + h + fw.y) return 0.0;
  float m = 0.0;
  if (q.y > up - fw.y) {
    float tens = floor(num / 10.0 + 0.01), ones = num - tens * 10.0;
    vec2 qn = vec2(q.x, q.y - up);
    m = tens > 0.5 ? max(digit(qn - vec2(-0.40 * h, 0.0), tens, h, fw), digit(qn - vec2(0.07 * h, 0.0), ones, h, fw)) : digit(qn - vec2(-0.165 * h, 0.0), ones, h, fw);
  }
  if (letter > 0.5 && q.y < h + fw.y) m = max(m, digit(q - vec2(-0.165 * h, 0.0), 9.0 + letter, h, fw));
  return m;
}

// Paint at one end of a runway. q.x: meters right of the centerline for a pilot landing over this end;
// q.y: meters in from the end of the pavement. dt: how far the threshold is displaced in.
// Sizes follow ICAO Annex 14 for the runway's width and landing distance.
float endMarks(vec2 q, float dt, float num, float halfW, float lda, float cls, vec2 fw, out float yCl) {
  float W = 2.0 * halfW, s = abs(q.x), y = q.y - dt, m = 0.0;
  float sc = clamp(W / 30.0, 0.45, 1.0);                       // narrow strips carry smaller paint
  // threshold: a comb of stripes, more of them on a wider runway, a double gap in the middle
  float n = W >= 59.0 ? 8.0 : W >= 44.0 ? 6.0 : W >= 29.0 ? 4.0 : W >= 22.0 ? 3.0 : 2.0;
  float a = (halfW - (W >= 29.0 ? 3.0 : 1.2)) / (2.0 * n);
  float y0 = 6.0 * sc, y1 = y0 + 30.0 * max(sc, 0.6);
  m = max(m, pulses(s - a, 2.0 * a, a, fw.x) * cov1(a, 2.0 * n * a, s, fw.x) * cov1(y0, y1, y, fw.y));
  // designator: 60 ft numerals, as the FAA paints them (smaller on a narrow runway)
  float h = 18.3 * sc, y2 = y1 + 12.0 * sc;
  m = max(m, designator(vec2(q.x, y - y2), num, h, fw));
  yCl = dt + y2 + designatorRise(num, h) + h + 12.0 * sc;
  if (dt > 4.0) {
    // displaced threshold: a bar across the runway, and arrows up the centerline leading to it
    m = max(m, rectCov(vec2(s, y), vec2(0.0, -1.8), vec2(halfW - 1.5, 0.0), fw));
    for (int k = 0; k < 2; k++) {
      float tip = dt - 5.0 - float(k) * 34.0;
      if (tip < 24.0) break;
      m = max(m, rectCov(vec2(s, q.y), vec2(0.0, tip - 26.0), vec2(0.45, tip - 2.0), fw));
      m = max(m, stroke(vec2(s, q.y), vec2(0.0, tip - 0.6), vec2(4.2, tip - 7.6), 0.42, fw));
    }
  }
  if (cls > 1.5 && y > 100.0) {
    // aiming point: two blocks either side of the centerline
    float dAim = lda < 800.0 ? 150.0 : lda < 1200.0 ? 250.0 : lda < 2400.0 ? 300.0 : 400.0;
    float wAim = W >= 44.0 ? 9.0 : W >= 29.0 ? 6.0 : 4.0, inner = W >= 44.0 ? 9.0 : W >= 29.0 ? 4.5 : 3.0;
    m = max(m, rectCov(vec2(s, y), vec2(inner, dAim), vec2(inner + wAim, dAim + (lda < 1200.0 ? 30.0 : 45.0)), fw));
    if (cls > 2.5) {
      // touchdown zone: pairs of bars every 150 m, three, then two, then one a side
      float kmax = lda >= 2400.0 ? 6.0 : lda >= 1500.0 ? 5.0 : 4.0;
      float k = floor(y / 150.0 + 0.5 - 11.25 / 150.0);
      float yk = k * 150.0;
      if (k >= 1.0 && k <= kmax && abs(yk - dAim) > 60.0 && yk + 22.5 < lda * 0.5) {
        float nb = k <= 2.0 ? 3.0 : k <= 4.0 ? 2.0 : 1.0;
        m = max(m, pulses(s - inner, 3.3, 1.8, fw.x) * cov1(inner, inner + nb * 3.3 - 1.5, s, fw.x) * cov1(yk, yk + 22.5, y, fw.y));
      }
    }
  }
  return m;
}

// The slope that rings spreading from raindrops give standing water: one drop to a cell, each on its own clock.
vec2 rings(vec2 p, float cell, float t) {
  vec2 g = p / cell, c = floor(g);
  float h = hash2(c), ph = fract(t * (0.9 + 0.5 * h) + h * 7.3);            // 0 as the drop lands .. 1 gone
  vec2 d = g - c - (0.3 + 0.4 * vec2(hash2(c + 3.7), hash2(c + 9.2)));
  float r = length(d), w = (r - 0.42 * ph) * 34.0;
  return d / max(r, 1e-3) * (sin(w) * exp(-w * w * 0.06) * (1.0 - ph) * (1.0 - ph));
}
// Microfacet lobe (GGX) of a surface of roughness a, at the angle between its normal and the half-vector.
float lobe(float ndh, float a) { float a2 = a * a, d = ndh * ndh * (a2 - 1.0) + 1.0; return a2 / (3.14159 * d * d); }
// A lamp seen in a wet surface: what a point light at l (from the surface point, any frame) sends back to the eye
// along V, for a lamp of unit strength. The streak drawn out toward the viewer is the lobe's own doing at a low angle.
float glint(vec3 l, vec3 N, vec3 V, float a) {
  float d2 = max(dot(l, l), 0.01); l *= inversesqrt(d2);
  vec3 H = normalize(l + V);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  return lobe(max(dot(N, H), 0.0), a) * F * step(0.0, dot(N, l)) / (d2 * (4.0 * max(dot(N, V), 0.0) + 0.06));
}

void main() {
  float type = floor(vRC.z + 0.5), kind = floor(vRC.w + 0.5);
  // A runway's fourth number carries how busy it is and, in twos, how well it is plowed: 0 not at all, 1 a lane, 2 the width.
  float plow = floor(vP1.w * 0.5 + 0.005), traffic = vP1.w - 2.0 * plow; plow *= 0.5;
  vec2 p = vLocal, rc = vRC.xy;
  vec3 V = cameraPosition - vWorld; float dist = max(length(V), 0.01); V /= dist;
  // Screen-space derivatives of the feature's coordinates (xy) and of the field's (zw), limited so that
  // a pixel on the horizon cannot hand on an infinity.
  vec4 gx = clamp(dFdx(vGrad), -1e4, 1e4), gy = clamp(dFdy(vGrad), -1e4, 1e4);
  // Footprint of this pixel on the ground along each axis of the feature's own coordinates (m).
  vec2 fw = max(vec2(length(vec2(gx.x, gy.x)), length(vec2(gx.y, gy.y))), vec2(1e-4));
  float fpx = max(max(length(gx.zw), length(gy.zw)), 1e-4);   // and its longest reach in any direction
  float halfW = vP0.x, L = vP0.y;

  // ---- detail, each scale on its own rotated grid (explicit gradients: see the note on vGrad)
  const mat2 R1 = mat2(0.84, 0.54, -0.54, 0.84), R2 = mat2(0.60, -0.80, 0.80, 0.60);
  vec2 lx = gx.zw, ly = gy.zw;
  vec4 t0 = textureGrad(tPave, p / 1.37, lx / 1.37, ly / 1.37);                       // aggregate, about 3 mm a texel
  vec4 t1 = textureGrad(tPave, R1 * p / 7.3, R1 * lx / 7.3, R1 * ly / 7.3);
  vec4 t2 = textureGrad(tPave, R2 * p / 23.0, R2 * lx / 23.0, R2 * ly / 23.0);
  const vec2 S3 = vec2(1.0 / 38.0, 1.0 / 170.0);                                        // the coarse web is drawn out along the feature:
  vec4 t3 = textureGrad(tPave, rc * S3 + 0.31, gx.xy * S3, gy.xy * S3);               // pavement cracks along its paving lanes first
  vec4 d1 = textureGrad(tDetail, R2 * p / 61.0, R2 * lx / 61.0, R2 * ly / 61.0);
  vec4 d2 = textureGrad(tDetail, p / 410.0 + 0.17, lx / 410.0, ly / 410.0);
  const vec2 S1 = vec2(1.0 / 2.9, 1.0 / 83.0), S2 = vec2(1.0 / 0.83, 1.0 / 37.0);
  vec4 st = textureGrad(tPave, rc * S1, gx.xy * S1, gy.xy * S1);                      // streaks drawn out along the feature
  vec4 st2 = textureGrad(tPave, rc * S2 + vec2(0.4, 0.0), gx.xy * S2, gy.xy * S2);
  float agg = t0.r, mot = t1.g, blot = t3.a;
  float cd = t2.b * 0.27, sd = t3.b * 0.445;                 // meters to the nearest crack in the fine and the coarse web
  float cdw = fpx, sdw = fpx;                                // a distance field changes by a meter a meter
  float isRunway = step(1.5, type) * step(type, 2.5), isRibbon = step(0.5, type) * step(type, 1.5);

  // ---- asphalt
  float age = smoothstep(0.25, 0.8, d2.g + 0.3 * (mot - 0.5));
  vec3 asph = mix(vec3(0.150, 0.153, 0.162), vec3(0.275, 0.270, 0.255), age) * (0.80 + 0.22 * d1.g + 0.18 * (d2.r - 0.5));
  // resurfaced lengths of runway: a tone to each, with a hard joint between them
  float secX = rc.y / 233.0 + 0.37, secK = floor(secX);
  float secTone = mix(hash1(secK - 1.0), hash1(secK), clamp((secX - secK) * 233.0 / fw.y, 0.0, 1.0));
  asph *= 1.0 + isRunway * (secTone - 0.5) * 0.16;
  // patches: now and then a rectangle of newer or older surface, with a tarred edge
  vec2 pg = rc / vec2(11.0, 37.0), pc = floor(pg);
  float ph = hash2(pc);
  vec2 lo = (pc + vec2(0.08 + 0.3 * hash2(pc + 3.1), 0.08 + 0.3 * hash2(pc + 5.7))) * vec2(11.0, 37.0);
  vec2 sz = vec2(2.2 + 5.0 * hash2(pc + 7.3), 3.0 + 14.0 * hash2(pc + 9.1));
  float patchIn = rectCov(rc, lo, lo + sz, fw) * step(ph, 0.16);
  float patchEdge = (rectCov(rc, lo - 0.05, lo + sz + 0.05, fw) - rectCov(rc, lo + 0.05, lo + sz - 0.05, fw)) * step(ph, 0.16);
  asph *= 1.0 + patchIn * (hash2(pc + 1.7) > 0.5 ? -0.22 : 0.16);
  asph *= 0.88 + 0.24 * mot;
  asph *= 0.60 + 0.80 * agg;                                  // stones in the binder; the mip chain smooths it with range
  // cracks: a fine web where the surface is old, sealed with tar where it was worst
  float upkeep = 1.0 - 0.55 * isRunway * traffic;             // a busy runway is kept in better repair
  float old = smoothstep(0.52, 0.78, d1.r + 0.3 * (blot - 0.5)) * upkeep;
  float crack = (1.0 - smoothstep(0.004, 0.005 + cdw * 1.2, cd)) * old * smoothstep(0.38, 0.62, t1.a + 0.4 * (st.g - 0.5));    // broken runs of it, never the whole net
  float seal = (1.0 - smoothstep(0.03, 0.032 + sdw, sd)) * smoothstep(0.50, 0.66, d1.g + 0.35 * (t1.a - 0.5));
  // paving lanes: a joint every few meters across a runway or taxiway, running its whole length
  float lanes = max(floor(2.0 * halfW / 3.8 + 0.5), 1.0), lw = 2.0 * halfW / lanes;
  float lj = abs(fract(rc.x / lw + 0.5 * mod(lanes, 2.0) + 0.5) - 0.5) * lw + (t1.a - 0.5) * 0.04;
  float joint = cov1(-0.025, 0.025, lj, fw.x) * (isRunway + isRibbon) * step(1.5, lanes) * (0.5 + 0.5 * step(0.4, st.g));
  // and one across it at the end of each day's paving
  float tx = rc.y / 97.0 + 0.2; float tj = abs(fract(tx) - 0.5) * 97.0;
  joint = max(joint, cov1(-0.03, 0.03, tj, fw.y) * isRunway);
  asph *= 1.0 - 0.30 * max(max(crack, patchEdge), joint * 0.8);
  asph = mix(asph, vec3(0.055, 0.055, 0.06), seal * 0.8 * (0.55 + 0.45 * upkeep));
  // oil and fuel: drips down the middle of a taxiway, blots on an apron
  float drip = exp(-rc.x * rc.x / 0.9) * isRibbon * (0.35 + 0.65 * st.a);
  float blots = smoothstep(0.70, 0.90, t1.a * 0.5 + d1.b * 0.55) * (1.0 - isRunway);
  asph *= 1.0 - 0.3 * drip - 0.3 * blots;

  // ---- concrete: pale slabs with dark joints, weather-stained
  vec2 sl = abs(fract(rc / 6.0) - 0.5) * 6.0;
  float slab = max(cov1(-0.012, 0.012, 3.0 - sl.x, fw.x), cov1(-0.012, 0.012, 3.0 - sl.y, fw.y));
  vec2 sid = floor(rc / 6.0);
  vec3 conc = vec3(0.56, 0.545, 0.50) * (0.86 + 0.2 * hash2(sid)) * (0.84 + 0.2 * d1.g) * (0.9 + 0.2 * mot) * (0.82 + 0.36 * agg);
  conc *= 1.0 - 0.22 * blots - 0.5 * slab - 0.25 * crack;
  conc = mix(conc, vec3(0.06), seal * 0.6);

  // ---- gravel and mown grass
  vec3 grav = mix(vec3(0.30, 0.28, 0.24), vec3(0.50, 0.47, 0.42), d1.g) * (0.5 + 1.0 * agg) * (0.82 + 0.36 * mot);
  grav *= 1.0 + 0.16 * exp(-pow(abs(rc.x) - 1.3, 2.0) / 0.5) * (isRunway + isRibbon + step(4.5, type));          // wheel tracks, packed pale
  float mow = pulses(rc.x + 0.6 * (d1.r - 0.5), 4.8, 2.4, fw.x);
  vec3 gras = mix(vec3(0.115, 0.185, 0.055), vec3(0.20, 0.245, 0.085), d1.g) * (0.78 + 0.44 * mot) * (0.93 + 0.14 * mow);

  vec3 alb = kind < 0.5 ? asph : kind < 1.5 ? conc : kind < 2.5 ? grav : gras;
  float soft = step(1.5, kind);                               // gravel and grass have ragged edges
  float alpha = 1.0, paint = 0.0, yellow = 0.0, rubber = 0.0, gloss = 1.0;
  float thin = 1.0, worn = 0.0;                               // how much of the ground shows through this surface (grass is hardly a layer at all); wheel-worn hollows

  if (type < 0.5) {
    alpha = thin = kind > 2.5 ? 0.34 : kind > 1.5 ? 0.9 : 1.0;
  } else if (type < 1.5) {
    float rag = (mot - 0.5) * mix(0.12, 1.6, soft);
    thin = kind > 2.5 ? 0.34 : kind > 1.5 ? 0.9 : 1.0;
    alpha = cov1(-halfW, halfW, rc.x + rag, fw.x + soft * 1.5) * thin;
  } else if (type < 2.5) {
    // ---- a paved runway and its paint
    float dtA = vP0.z, dtB = vP0.w, cls = vP1.z, lda = L - dtA - dtB, W = 2.0 * halfW, sAbs = abs(rc.x);
    alpha = cov1(-halfW, halfW, rc.x + (mot - 0.5) * 0.14, fw.x) * cov1(0.0, L, rc.y, fw.y);
    float yA, yB;
    // the two designators come packed in one number: this end's + 1024 x the far end's (see buildGround)
    float codeB = floor(vP1.x / 1024.0 + 0.001), codeA = vP1.x - codeB * 1024.0;
    paint = endMarks(rc, dtA, codeA, halfW, lda, cls, fw, yA);
    paint = max(paint, endMarks(vec2(-rc.x, L - rc.y), dtB, codeB, halfW, lda, cls, fw, yB));
    // centerline, 30 m on and 20 m off between the two sets of numbers
    float cw = W >= 44.0 ? 0.9 : W >= 29.0 ? 0.45 : 0.3;
    paint = max(paint, pulses(rc.y - yA, 50.0, 30.0, fw.y) * cov1(yA, L - yB, rc.y, fw.y) * cov1(-0.5 * cw, 0.5 * cw, rc.x, fw.x));
    // side stripes
    float sw = W >= 29.0 ? 0.9 : 0.45;
    paint = max(paint, cov1(halfW - 0.4 - sw, halfW - 0.4, sAbs, fw.x) * cov1(1.0, L - 1.0, rc.y, fw.y));
    // rubber where the wheels arrive, in streaks, heaviest a little past the aiming point; a duller band all the way down
    float reach = clamp(lda / 1600.0, 0.5, 1.0);
    float zone = exp(-pow((rc.y - dtA - 340.0 * reach) / (250.0 * reach), 2.0)) + exp(-pow((L - rc.y - dtB - 340.0 * reach) / (250.0 * reach), 2.0));
    float lat = exp(-pow(rc.x / (halfW * 0.42), 2.0));
    float tracks = smoothstep(0.3, 0.75, st.a * 0.65 + st2.g * 0.55);
    rubber = clamp(zone * lat * (0.25 + 0.95 * tracks) * traffic * 1.25, 0.0, 0.92);
    rubber = max(rubber, lat * 0.16 * (0.4 + 0.6 * st.g) * (0.4 + 0.6 * traffic));
    worn = clamp(zone, 0.0, 1.0) * lat;
  } else if (type < 3.5) {
    // ---- a yellow line down a taxiway or onto a stand
    yellow = cov1(-vP0.x, vP0.x, rc.x, fw.x);
    alpha = yellow;
  } else if (type < 4.5) {
    // ---- holding position: two solid lines on the side you wait, two broken ones toward the runway
    float w = vP0.y, v = rc.y / w;
    float bars = cov1(0.0, w, rc.y, fw.y) + cov1(2.0 * w, 3.0 * w, rc.y, fw.y);
    float dash = (cov1(4.0 * w, 5.0 * w, rc.y, fw.y) + cov1(6.0 * w, 7.0 * w, rc.y, fw.y)) * pulses(rc.x + halfW, 12.0 * w, 6.0 * w, fw.x);
    yellow = clamp(bars + dash, 0.0, 1.0) * cov1(-halfW, halfW, rc.x, fw.x);
    alpha = yellow;
  } else {
    // ---- a grass or gravel strip: a soft-edged band with white boards along its sides and across its ends
    float dtA = vP0.z, dtB = vP0.w, sAbs = abs(rc.x);
    float rag = (mot - 0.5) * 2.4 + (d1.r - 0.5) * 3.0;
    thin = kind > 2.5 ? 0.46 : 0.93;
    alpha = smoothstep(halfW + 1.5, halfW - 2.5, sAbs + rag) * smoothstep(-2.0, 3.0, min(rc.y, L - rc.y) + rag) * thin;
    float side = cov1(halfW, halfW + 1.2, sAbs, fw.x) * pulses(rc.y - dtA, 60.0, 4.0, fw.y) * cov1(dtA, L - dtB + 4.0, rc.y, fw.y);
    float ends = pulses(halfW - sAbs, 6.0, 4.0, fw.x) * cov1(0.0, 16.0, halfW - sAbs, fw.x) * (cov1(dtA, dtA + 1.2, rc.y, fw.y) + cov1(L - dtB - 1.2, L - dtB, rc.y, fw.y));
    paint = max(side, ends);
    alpha = max(alpha, paint);
  }

  // Paint wears: thin in places, the surface showing through its cracks, rubber laid over the top of it.
  float wear = 1.0 - 0.3 * smoothstep(0.45, 0.8, t1.a) - 0.25 * crack;
  alb = mix(alb, vec3(0.88, 0.88, 0.85) * (0.76 + 0.28 * agg) * (0.9 + 0.2 * mot), paint * wear);
  alb = mix(alb, vec3(0.90, 0.60, 0.05) * (0.78 + 0.26 * agg), yellow * (0.72 + 0.28 * wear));
  alb = mix(alb, vec3(0.05, 0.05, 0.054) * (0.7 + 0.6 * agg), rubber);
  gloss = 1.0 + 2.0 * rubber + 1.5 * seal + paint * 0.5;

  // ---- the weather on it: snow lying, the surface wet, water standing in the hollows
  float paved = 1.0 - soft, across = abs(rc.x) / max(halfW, 0.5);
  float vSnow = vCold.x, wetNow = uWet * (1.0 - 0.85 * vCold.y);     // frozen ground is not wet ground
  // The lie of the surface over a few meters, and its finer unevenness: 0 the hollows .. 1 the high spots (in the field's
  // frame, so the same under every layer; the noise keeps to the middle of its range, hence the stretch). A threshold
  // drawn through one tiling texture shows its tile as a lattice, so three scales on three grids go into each.
  float relief = 0.5, uneven = 0.5;
  if (vSnow > 0.004 || wetNow > 0.004) {
    vec4 dw = textureGrad(tDetail, R1 * p / 17.0 + 0.43, R1 * lx / 17.0, R1 * ly / 17.0);
    relief = clamp((0.45 * t2.g + 0.3 * d1.r + 0.25 * dw.g - 0.3) * 2.5, 0.0, 1.0);
    uneven = clamp((0.45 * dw.r + 0.3 * d1.g + 0.25 * mot - 0.3) * 2.5, 0.0, 1.0);
  }
  float snowOp = 0.0;
  if (vSnow > 0.004) {
    // The busy fields plow: the main runway of an airline airport across most of its width, with the markings
    // showing in the cleared part and the snow left in a bank along each edge; a lane down the middle elsewhere, and
    // down the taxiways; the aprons pass by pass, a ridge left between passes. A small strip lies as the snow left it.
    float cleared = 0.0;
    if (plow > 0.25) {
      if (type < 0.5) cleared = 0.85 * (1.0 - pulses(rc.x + 2.0 * (d1.g - 0.5), 13.0, 1.4, fw.x));
      else if (type < 1.5) cleared = 1.0 - smoothstep(0.5, 0.75, across);
      else if (type < 2.5) cleared = plow > 0.75 ? 1.0 - smoothstep(0.66, 0.8, across) : 0.85 * (1.0 - smoothstep(0.3, 0.45, across));
      else cleared = 1.0;
    }
    float depth = vSnow * (1.0 - 0.86 * cleared);
    // Where it settles first; what the plow leaves is in streaks along the runway. The first tenth of a full
    // pack is a patchy dusting, by about half the ground is covered, and from there it only deepens.
    float lie = mix(uneven, clamp((st.g - 0.3) * 2.5, 0.0, 1.0), 0.6 * cleared * isRunway);
    float cover = smoothstep(0.0, 1.0, (depth * 3.5 - 0.25 * paved - lie) * 2.0);       // (pavement holds the day's warmth a little longer than grass)
    snowOp = cover * mix(0.5, 1.0, smoothstep(0.1, 0.45, depth));              // a dusting is thin: the paint shows through it
    vec3 snowCol = vec3(0.86, 0.89, 0.93) * (0.93 + 0.1 * mot);
    snowCol = mix(snowCol, vec3(0.56, 0.57, 0.59), 0.45 * cleared);          // plowed and driven on: packed and gray
    float slush = wetNow * (1.0 - smoothstep(0.2, 0.6, depth));                 // melting: sodden and gray, going in patches
    snowCol = mix(snowCol, vec3(0.40, 0.42, 0.45), 0.7 * slush);
    snowOp *= 1.0 - 0.35 * slush;
    alb = mix(alb, snowCol, snowOp);
  }
  // Wet: damp is the surface darkened by water in it (the high spots dry first, the ground around the hollows last),
  // film the water lying over it while it is soaked, puddle the water standing where the surface is low. Puddles
  // shrink as the ground dries and are the last thing to go.
  float damp = 0.0, film = 0.0, puddle = 0.0;
  if (wetNow > 0.004) {
    float ruts = exp(-(abs(rc.x) - 1.3) * (abs(rc.x) - 1.3) / 0.5);
    // how far up the hollows fill: most on an apron, least on a runway's crown, more toward its edges and where the wheels have worn it
    float fill = type < 0.5 ? 0.25 : type < 1.5 ? 0.14 + 0.10 * smoothstep(0.45, 0.95, across) : type < 2.5 ? 0.07 + 0.13 * smoothstep(0.45, 0.95, across) + 0.10 * worn : type < 4.5 ? 0.14 : 0.10 + 0.22 * ruts;
    float low = type > 4.5 ? mix(relief, clamp((st.a - 0.3) * 2.5, 0.0, 1.0), 0.45) : relief;      // on a grass strip the water lies along the wheel tracks
    // drying, the water sinks back into the lowest hollows, and the last of it goes only when the ground is all but dry
    puddle = smoothstep(0.0, 0.05 + 0.08 * min(fpx, 2.0), fill - 0.22 * (1.0 - sqrt(wetNow)) - low) * smoothstep(0.0, 0.1, wetNow) * (1.0 - snowOp);
    damp = smoothstep(0.0, 0.2, wetNow * 1.9 - 0.9 * mix(uneven, relief, 0.5)) * (1.0 - snowOp);
    film = damp * smoothstep(0.3, 0.9, wetNow);
    float dark = kind < 0.5 ? 0.52 : kind < 1.5 ? 0.60 : kind < 2.5 ? 0.62 : 0.84;
    alb *= mix(1.0, mix(dark, 0.88, max(paint, yellow)), max(damp, puddle));
    alpha = mix(alpha, alpha / thin, 0.85 * puddle);          // standing water hides the grass it stands in
  }

  // ---- light, as the terrain is lit
  vec3 Nb = vec3((t0.g - 0.5) * 0.22 + (t1.r - 0.5) * 0.06, 0.0, (t0.a - 0.5) * 0.22 + (t1.b - 0.5) * 0.06) * exp(-dist / 90.0);
  vec3 N = normalize(vN + Nb * (1.0 - 0.8 * snowOp));
  // Mountain shadow per pixel (its edge is sharp now, and a runway's triangles are long), then the aircraft's and the buildings' shadows.
  vec2 gLit = terrainLight(vWorld, regionHeight(vWorld.xz));
  float trees = treeShade(vWorld, dFdx(vWorld.xz), dFdy(vWorld.xz));      // trees beside the field shade it as they shade the land
  float shadow = gLit.x * localShadow(vWorld) * (1.0 - 0.9 * cloudShadow(vWorld)) * (1.0 - 0.9 * trees);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = skyIrradiance(N) * (1.0 - 0.5 * gLit.y) * (1.0 - 0.21 * trees * uTreeShadeP.y);
  // Seen at a low angle a dry road goes pale: the stones' flat tops catch the sky. (Wet, the water does the reflecting: below.)
  float dry = (1.0 - soft) * (1.0 - max(max(damp, puddle), snowOp));
  float graze = pow(1.0 - max(V.y, 0.0), 5.0) * dry;
  vec3 col = alb * (uSunCol * ndl * shadow + amb + localLight(vWorld, N)) * (1.0 + 0.5 * graze);
  col += (uSunCol * shadow * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 14.0) * 0.045 * dry + uAmbSky * graze * 0.10) * gloss;
  col += snowOp * uSunCol * shadow * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 24.0) * 0.18;          // the sheen of snow, as on the terrain

  // The water's own surface: it mirrors the sky by Fresnel's rule, sharply where it stands and in a blur where it is
  // only a film over the stones; the sun (or the moon) glints in it, and so do the lamps.
  float mirror = mix(damp * (paved + soft * (kind > 2.5 ? 0.12 : 0.45)), 1.0, puddle);
  if (mirror > 0.004) {
    // Standing water is level but for what the wind and the rain do to it: ripples that grow with the wind, rings
    // from the drops. Too far off to draw, they roughen the mirror instead.
    vec2 rip = vec2(0.0);
    float rough = 0.025;
    if (puddle > 0.004) {
      float blow = smoothstep(1.0, 9.0, uWind), nearK = exp(-dist / 70.0);
      vec2 drift = uTime * vec2(0.11, 0.07);
      rip = ((textureGrad(tDetail, p / 1.7 + drift, lx / 1.7, ly / 1.7).ba - 0.5) + (textureGrad(tDetail, R1 * p / 0.63 - drift * 1.6, R1 * lx / 0.63, R1 * ly / 0.63).ba - 0.5) * 0.6) * (0.03 + 0.5 * blow) * nearK;
      float seen = 1.0 - smoothstep(0.012, 0.045, fpx);
      if (uRain > 0.02 && seen > 0.0) rip += (rings(p, 0.55, uTime) + rings(p + 3.1, 0.34, uTime * 1.13)) * 0.55 * min(uRain * 2.5, 1.0) * seen;
      rough += (0.03 + 0.14 * blow) * (1.0 - nearK) + 0.07 * min(uRain * 2.5, 1.0) * (1.0 - seen);
    }
    float a = mix(mix(0.5, 0.2, film), rough, puddle);
    // The film follows the surface under it, loosely. Its unevenness is taken from the two coarser scales of the
    // detail: the finest repeats every meter or so, and a mirror shows that up as a lattice of glints at night.
    vec3 Nf = vec3((t1.g - 0.5) * 0.10 + (t2.a - 0.5) * 0.08, 0.0, (t1.a - 0.5) * 0.10 + (t2.g - 0.5) * 0.08) * exp(-dist / 250.0) + Nb * (0.5 * exp(-dist / 25.0));
    vec3 Nw = normalize(vN + mix(Nf * (1.0 - 0.5 * film), vec3(rip.x, 0.0, rip.y), puddle));
    float ndv = max(dot(Nw, V), 1e-3);
    // A film over the stones is not a sheet of glass: their tops stand through it and hide one another, so it only
    // comes to a mirror at a much lower angle than standing water does, and never to as good a one.
    float F = (0.02 + ((1.0 - a) * mix(0.8, 1.0, puddle) - 0.02) * pow(1.0 - ndv, mix(8.0, 5.0, puddle))) * mirror;
    vec3 R = reflect(-V, Nw);
    // What lies just under the horizon in the mirror is the far ground, darker than the sky over it.
    float sky = mix(0.45, 1.0, smoothstep(-0.03, 0.06, R.y));
    R.y = abs(R.y);
    vec3 spec = skyRadiance(normalize(R + vec3(0.0, 0.5 * a, 0.0))) * sky * F;
    vec3 H = normalize(uSunDir + V);
    float sun = lobe(max(dot(Nw, H), 0.0), max(a, 0.03)) * 3.14159 * (0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0)) / (4.0 * ndv + 0.15);
    spec += uSunCol * (shadow * min(sun, 24.0) * mirror * smoothstep(0.0, 0.05, dot(Nw, uSunDir)));
    // The aircraft's landing light, for whoever looks back at it over wet ground.
    if (uSpot[2].w > 0.0) {
      vec3 ls = uSpot[0].xyz - vWorld; float r = length(ls), c = dot(-ls / max(r, 0.01), uSpot[1].xyz);
      if (r < uSpot[0].w && c > uSpot[1].w) {
        float cone = smoothstep(uSpot[1].w, mix(uSpot[1].w, 1.0, 0.55), c);
        spec += uSpot[2].rgb * (uSpot[2].w * cone * cone * (1.0 - smoothstep(0.6 * uSpot[0].w, uSpot[0].w, r)) * mirror * min(glint(ls, Nw, V, max(a, 0.05)) * 1100.0, 30.0));
      }
    }
    // The runway's own lamps. They stand in rows whose places are known from the runway's measurements alone, so
    // the few that can show in this pixel are found by rule: along each edge the lamp abreast of it, the next one
    // away from the eye, and the one the line of sight runs out to; and across each end the red ones nearest that line.
    if (uLampGlow > 0.0 && type > 1.5 && type < 2.5 && dist < 3000.0) {
      float cs = cos(vP1.y), sn = sin(vP1.y);                 // the runway's direction on the map
      // into its own frame: x across, y up, z along
      vec3 Vr = vec3(cs * V.z - sn * V.x, V.y, cs * V.x + sn * V.z), Nr = vec3(cs * Nw.z - sn * Nw.x, Nw.y, cs * Nw.x + sn * Nw.z);
      vec2 away = -Vr.xz / max(length(Vr.xz), 1e-4);
      float ar = sqrt(a * a + 0.0004 + pow(0.6 * fpx / max(dist * 0.02, 0.3), 2.0));          // never a lobe thinner than the pixel
      float from = vP0.z, to = L - vP0.w, nL = max(2.0, floor((to - from) / 60.0 + 0.5)), gap = (to - from) / nL;
      float dz = away.y >= 0.0 ? 1.0 : -1.0, ia = floor((rc.y - from) / gap + 0.5);
      float white = 0.0, red = 0.0;
      for (int sd = 0; sd < 2; sd++) {
        float ex = (sd == 0 ? -1.0 : 1.0) * (halfW + 1.5), tc = (ex - rc.x) / (abs(away.x) > 1e-4 ? away.x : 1e-4);
        float ic = tc > 0.0 ? floor((rc.y + away.y * tc - from) / gap + 0.5) : ia + 2.0 * dz;
        if (abs(ic - ia - 0.5 * dz) < 1.0) ic = ia + 2.0 * dz;
        for (int k = 0; k < 3; k++) {
          float i = k == 0 ? ia : k == 1 ? ia + dz : ic;
          if (i > -0.5 && i < nL + 0.5) white += glint(vec3(ex - rc.x, 0.35, from + i * gap - rc.y), Nr, Vr, ar);
        }
      }
      // red lamps across each end, shining up the runway
      float W = 2.0 * halfW, nE = max(6.0, floor(W / 3.2 + 0.5)), eg = W / nE;
      for (int e = 0; e < 2; e++) {
        float ez = e == 0 ? -1.5 : L + 1.5, into = e == 0 ? 1.0 : -1.0, tc = (ez - rc.y) / (abs(away.y) > 1e-4 ? away.y : 1e-4);
        if (tc <= 0.0 || abs(ez - rc.y) > 500.0) continue;
        float jc = clamp(floor((rc.x + away.x * tc + halfW) / eg), 0.0, nE - 1.0), side = rc.x + away.x * tc + halfW - (jc + 0.5) * eg >= 0.0 ? 1.0 : -1.0;
        for (int k = 0; k < 2; k++) {
          float j = jc + float(k) * side;
          if (j < -0.5 || j > nE - 0.5) continue;
          vec3 l = vec3(-halfW + (j + 0.5) * eg - rc.x, 0.3, ez - rc.y);
          red += glint(l, Nr, Vr, ar) * smoothstep(0.02, 0.35, -l.z * into / length(l));
        }
      }
      spec += (vec3(1.0, 0.90, 0.74) * white + vec3(1.0, 0.09, 0.05) * red * 0.5) * (uLampGlow * mirror * (1.0 - smoothstep(2000.0, 3000.0, dist)));
    }
    col = col * (1.0 - F) * (1.0 - 0.25 * puddle) + spec;
  }
  vec4 outc = vec4(applyAtmosphere(col, cameraPosition, vWorld), alpha);
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b + outc.a < 1e4)) discard;         // never hand the post-processing a bad pixel
  gl_FragColor = outc;
}`;

const BLD_VERT = /* glsl */`
attribute vec3 color;
attribute vec3 aW;            // meters along the wall, meters above the ground, what it is (0 wall, 1 roof, 2 glazed wall, 3 tower cab)
centroid varying vec3 vWorld, vN, vCol, vW;
centroid varying vec2 vLight;
centroid varying vec2 vCold;
${LIGHT_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vN = normal; vCol = color; vW = aW;
  vCold = groundCold(wp.xyz);
  float hReg = regionHeight(wp.xz);
  vLight = vec2(terrainShadow(wp.xyz, hReg) * (1.0 - 0.9 * cloudShadow(wp.xyz)), skyOcclusion(wp.xyz, hReg));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BLD_FRAG = /* glsl */`
uniform float uLamps;
centroid varying vec3 vWorld, vN, vCol, vW;
centroid varying vec2 vLight;
centroid varying vec2 vCold;
${LIGHT_GLSL}
${ATMO_GLSL}
float hashB(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 N = normalize(vN);
  float what = floor(vW.z + 0.5);
  vec3 alb = vCol;
  // Weather streaks down the cladding, a darker foot to the wall, sheets on the roof.
  float streak = texture2D(tDetail, vec2(vW.x / 9.0, vW.y / 90.0)).r, grain = texture2D(tDetail, vWorld.xz / 23.0).g;
  if (what < 0.5) alb *= (0.84 + 0.3 * streak) * mix(0.72, 1.0, smoothstep(0.0, 1.1, vW.y));
  else if (what < 1.5) alb *= 0.82 + 0.34 * grain;
  // Glazing: a band of windows on each floor of a terminal, a ring of glass around a tower cab.
  float glass = 0.0, lit = 0.0;
  if (what > 1.5) {
    vec2 fwW = vec2(fwidth(vW.x), fwidth(vW.y));
    float floorY = what > 2.5 ? vW.y : mod(vW.y, 4.4);
    float band = clamp((min(floorY - 1.0, (what > 2.5 ? 2.7 : 3.4) - floorY)) / max(fwW.y, 0.02) + 0.5, 0.0, 1.0);
    float bay = what > 2.5 ? 1.0 : 1.0 - smoothstep(0.42, 0.42 + fwW.x / 3.2 + 0.01, abs(fract(vW.x / 3.2) - 0.5));
    glass = band * bay * step(1.0, vW.y);
    glass = mix(glass, 0.45 * step(1.0, vW.y), smoothstep(0.5, 1.6, max(fwW.x, fwW.y)));     // far off, the windows merge into the wall's tone
    // Rooms lit after dark: this window or that one up close; once a window is a pixel or so they
    // merge into an even glow, and from far off the glow is let go (nothing small and bright to twinkle).
    float fine = max(fwW.x, fwW.y);
    lit = mix(step(0.45, hashB(vec2(floor(vW.x / 3.2), floor(vW.y / 4.4)))), 0.55, smoothstep(0.35, 1.2, fine)) * glass * (1.0 - smoothstep(0.9, 1.8, fine));
    alb = mix(alb, vec3(0.035, 0.05, 0.065), glass);
  }
  // The weather: rain darkens the cladding and the roofing, snow lies on whatever faces up (roofs whiten before the
  // pavement does: nothing warms them from below), going gray and patchy as it melts.
  float vSnow = vCold.x, wetNow = uWet * (1.0 - 0.85 * vCold.y);
  float up = smoothstep(0.25, 0.8, N.y), wetB = wetNow * (0.45 + 0.55 * up) * (1.0 - glass);
  float slush = wetNow * (1.0 - smoothstep(0.2, 0.6, vSnow));
  float lying = smoothstep(0.0, 1.0, (vSnow * 3.5 - grain) * 2.0) * up * (1.0 - 0.4 * slush);
  alb *= 1.0 - 0.3 * wetB;
  alb = mix(alb, mix(vec3(0.86, 0.89, 0.93), vec3(0.45, 0.47, 0.50), 0.6 * slush), lying);
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = skyIrradiance(N) * (1.0 - 0.5 * vLight.y) * mix(0.8, 1.0, smoothstep(0.0, 2.5, vW.y));
  amb += uSunCol * max(uSunDir.y, 0.0) * vLight.x * 0.11 * (1.0 - N.y * N.y) * vec3(1.0, 0.95, 0.82);     // sunlit ground throws light back up a wall
  float sunLit = vLight.x * localShadow(vWorld + N * 0.35);     // other buildings' shadows, and the aircraft's
  vec3 col = alb * (uSunCol * ndl * sunLit + amb + localLight(vWorld, N));
  vec3 V = normalize(cameraPosition - vWorld);
  col += glass * (uAmbSky * 0.35 + uSunCol * sunLit * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 24.0) * 0.2) * (0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0));
  // a wet roof or wall shines with the sky at a low angle
  col += wetB * (1.0 - lying) * skyIrradiance(vec3(0.0, up, sqrt(max(1.0 - up * up, 0.0)))) * 0.6 * pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += lit * uLamps * vec3(1.0, 0.72, 0.38) * 0.35;         // rooms lit after dark
  vec3 outc = applyAtmosphere(col, cameraPosition, vWorld);
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b < 1e4)) discard;
  gl_FragColor = vec4(outc, 1.0);
}`;

// Buildings throw their shadows as flat shapes on the graded ground: each footprint swept along the
// sun's direction, drawn as a multiply over whatever is there. The pieces of one sweep overlap (and so do
// neighbors' shadows), so every fragment writes the same depth, worked out from its pixel's ray and
// the field's plane, and the depth test (strictly nearer) lets only the first one at each pixel through.
const SHADE_VERT = /* glsl */`
attribute vec2 aSh;          // the building's height; 1 on the vertices that are thrown along the shadow
centroid varying vec3 vWorld;
centroid varying vec2 vLight;
${LIGHT_GLSL}
void main() {
  vec3 p = position;
  vec2 S = -uSunDir.xz / max(uSunDir.y, 0.16) * aSh.x * aSh.y;
  p.xz += S; p.y -= (normal.x * S.x + normal.z * S.y) / normal.y;          // stay on the field's plane
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  float hReg = regionHeight(wp.xz);
  vLight = vec2(terrainShadow(wp.xyz, hReg) * (1.0 - 0.9 * cloudShadow(wp.xyz)), skyOcclusion(wp.xyz, hReg));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SHADE_FRAG = /* glsl */`
uniform mat4 projectionMatrix;
uniform vec4 uPlane;         // the field's plane in view space: dot(xyz, p) = w
uniform vec2 uRes;
centroid varying vec3 vWorld;
centroid varying vec2 vLight;
${LIGHT_GLSL}
${ATMO_GLSL}
void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ray = vec3((ndc.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (ndc.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
  float t = uPlane.w / dot(uPlane.xyz, ray);
  if (!(t > 0.5 && t < 2.0e5)) discard;
  float zv = -(t * 0.999 - 0.04);                             // a shade nearer than the ground itself
  gl_FragDepth = clamp((projectionMatrix[2][2] * zv + projectionMatrix[3][2]) / -zv * 0.5 + 0.5, 0.0, 1.0);
  // What is left of the light where the sun is cut off: the sky's share of it.
  vec3 direct = uSunCol * max(uSunDir.y, 0.0) * vLight.x;
  vec3 amb = mix(uAmbGround, uAmbSky, 0.97) * (1.0 - 0.5 * vLight.y);
  vec3 k = amb / max(direct + amb, vec3(1e-4));
  // (where the sun's shadow maps reach, the buildings throw real shadows and this flat one stands down)
  float fade = (1.0 - smoothstep(3000.0, 6000.0, distance(cameraPosition, vWorld))) * (1.0 - sunMapCover(vWorld));
  vec3 outc = mix(vec3(1.0), k, clamp(atmosphereTransmittance(cameraPosition, vWorld) * fade, 0.0, 1.0));
  if (any(isnan(outc)) || any(isinf(outc))) discard;
  gl_FragColor = vec4(outc, 1.0);
}`;

// Lights are point sprites. The lamp has a real size, so close by it is a small bright disk; once that
// would be under about four and a half pixels (at 1080 lines; it scales with the frame) the sprite stops
// shrinking and the brightness falls instead. A soft round spot that size lands on the same pixels
// whichever way the anti-aliasing jitter has nudged the frame, where a hard one-pixel point hops
// between them and flickers. Nothing here switches hard on or off either: the beacon swells and fades.
const LAMP_VERT = /* glsl */`
attribute vec3 color;        // color and strength
attribute vec3 aCol2;        // second color (two-sided lamps), or x = the angle a PAPI unit changes at (degrees)
attribute vec4 aDir;         // xyz: where the beam points; w: 0 all around, 1 beam, 2 PAPI, 3 one color each side, 4 beacon
attribute float aSize;       // meters across
uniform float uViewH, uLevel, uTime, uMinPx;
varying vec3 vCol;
varying float vShape;
${ATMO_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 toCam = cameraPosition - wp.xyz; float d = max(length(toCam), 0.5); toCam /= d;
  vec3 col = color; float I = 1.0, k = aDir.w;
  float along = dot(toCam, aDir.xyz);
  if (k > 3.5) {
    // The beacon turns: a white beam and a green one, half a turn apart, each a slow swell as it passes.
    float a = atan(toCam.x, toCam.z) - uTime * 0.9, b = cos(a);
    col = b > 0.0 ? color : aCol2; I = pow(abs(b), 48.0);
  } else if (k > 2.5) { col = along < 0.0 ? aCol2 : color; }
  else if (k > 1.5) {
    float elev = degrees(asin(clamp(toCam.y, -1.0, 1.0)));
    col = mix(vec3(1.0, 0.05, 0.03), vec3(1.0, 0.95, 0.86), smoothstep(aCol2.x - 0.06, aCol2.x + 0.06, elev)) * color.r;
    I = smoothstep(0.90, 0.985, along);
  } else if (k > 0.5) { I = smoothstep(0.02, 0.35, along); }
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  float phys = aSize * uViewH * 0.5 * projectionMatrix[1][1] / d;          // the lamp's width in pixels
  float px = uViewH / 1080.0, core = clamp(phys, uMinPx * px, 14.0 * px);
  // Held at its smallest size the spot dims with range, but slowly, the way a lamp stays a hard bright
  // point to the eye for miles; the air between does the rest.
  I *= pow(min(1.0, phys / core), 0.42) * uLevel;
  vCol = col * atmosphereTransmittance(cameraPosition, wp.xyz) * I;
  // Close by, the sprite is drawn wider than the lamp to hold a faint glow around it.
  float size = max(core, min(phys * 3.5, 44.0 * px));
  vShape = (size * size) / (core * core);
  gl_PointSize = size;
  if (I < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const LAMP_FRAG = /* glsl */`
varying vec3 vCol;
varying float vShape;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q), skirt = exp(-r2 * 3.2) - 0.0408;      // a round spot that reaches zero at the sprite's edge
  if (skirt <= 0.0) discard;
  float a = vShape > 1.02 ? exp(-r2 * 3.2 * vShape) + 0.06 * skirt * smoothstep(1.0, 2.5, vShape) : skirt;
  gl_FragColor = vec4(vCol * a, 0.0);
}`;

// ------------------------------------------------------------------ textures and tables

/**
 * The pavement detail texture, 512 px, tiling. r: aggregate (stones a texel or two across); g: mottling;
 * b: distance to the nearest line of a crack web (0 on the crack, 1 from six texels away); a: a second mottling.
 */
function makePaveTexture() {
  const S = 512, data = new Uint8Array(S * S * 4), rnd = mulberry32(4711);
  // Aggregate: white noise, softened once so stones are a texel or two across, with the odd pale stone and dark pit.
  const w = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) w[i] = rnd();
  const agg = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = w[y * S + x], e = w[y * S + ((x + 1) % S)], s = w[((y + 1) % S) * S + x], d = w[((y + 1) % S) * S + ((x + 1) % S)];
    let v = 0.5 + ((c * 0.46 + e * 0.2 + s * 0.2 + d * 0.14) - 0.5) * 1.7;
    const k = w[((y + 7) % S) * S + ((x + 13) % S)];
    if (k > 0.94) v += 0.45 * (k - 0.94) / 0.06; else if (k < 0.05) v -= 0.4 * (0.05 - k) / 0.05;
    agg[y * S + x] = Math.max(0, Math.min(1, v));
  }
  // Two tiling fractal fields.
  const fractal = (seed) => {
    const f = new Float32Array(S * S); let amp = 0.5, norm = 0;
    for (const freq of [4, 8, 16, 32, 64]) {
      const r = mulberry32(seed + freq), g = new Float32Array(freq * freq);
      for (let i = 0; i < g.length; i++) g[i] = r();
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const fx = (x / S) * freq, fy = (y / S) * freq, ix = Math.floor(fx), iy = Math.floor(fy);
        let u = fx - ix, v = fy - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
        const a = g[(iy % freq) * freq + (ix % freq)], b = g[(iy % freq) * freq + ((ix + 1) % freq)];
        const c = g[((iy + 1) % freq) * freq + (ix % freq)], d = g[((iy + 1) % freq) * freq + ((ix + 1) % freq)];
        f[y * S + x] += amp * ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v);
      }
      norm += amp; amp *= 0.6;
    }
    let lo = 1, hi = 0;
    for (let i = 0; i < S * S; i++) { f[i] /= norm; if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
    for (let i = 0; i < S * S; i++) f[i] = (f[i] - lo) / (hi - lo);
    return f;
  };
  const f1 = fractal(31), f2 = fractal(977);
  // Crack web: the edges of a tiling Voronoi pattern, stored as the distance to the nearest edge.
  const G = 10, cell = S / G, px = new Float32Array(G * G), py = new Float32Array(G * G);
  for (let i = 0; i < G * G; i++) { px[i] = (i % G + 0.15 + 0.7 * rnd()) * cell; py[i] = (Math.floor(i / G) + 0.15 + 0.7 * rnd()) * cell; }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let d1 = 1e9, d2 = 1e9, ax = 0, ay = 0, bx = 0, by = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const gx = cx + i, gy = cy + j, k = (((gy % G) + G) % G) * G + (((gx % G) + G) % G);
      const qx = px[k] + Math.floor(gx / G) * S, qy = py[k] + Math.floor(gy / G) * S;
      const d = (qx - x) * (qx - x) + (qy - y) * (qy - y);
      if (d < d1) { d2 = d1; bx = ax; by = ay; d1 = d; ax = qx; ay = qy; } else if (d < d2) { d2 = d; bx = qx; by = qy; }
    }
    // Distance to the line midway between the two nearest sites, bent a little so cracks are not ruler-straight.
    const ex = bx - ax, ey = by - ay, el = Math.hypot(ex, ey) || 1;
    const edge = Math.abs(((x - (ax + bx) / 2) * ex + (y - (ay + by) / 2) * ey) / el) + (f2[y * S + x] - 0.5) * 2.2;
    const o = (y * S + x) * 4;
    data[o] = agg[y * S + x] * 255; data[o + 1] = f1[y * S + x] * 255;
    data[o + 2] = Math.max(0, Math.min(255, (Math.abs(edge) / 6) * 255)); data[o + 3] = f2[y * S + x] * 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;      // 16 looks the same here and doubles the layer's cost
  return t;
}

/**
 * Runway numerals, and the letters L, C and R, as straight strokes on a box 0.33 wide and 1 high (stroke 0.086), ten
 * strokes at most each, four numbers a stroke: x0, y0, x1, y1. Corners are mitred here so the shader can cut every end square.
 */
function makeGlyphs() {
  const xl = 0.045, xr = 0.285, xm = 0.165, yb = 0.045, yt = 0.955, ym = 0.5, c = 0.08, hw = 0.043;
  const lines = [
    [[xl + c, yb, xr - c, yb, xr, yb + c, xr, yt - c, xr - c, yt, xl + c, yt, xl, yt - c, xl, yb + c, xl + c, yb]],
    [[xm + 0.02, yb - hw, xm + 0.02, yt, xm - 0.085, yt - 0.14]],
    [[xl, yt - c - 0.03, xl, yt - c, xl + c, yt, xr - c, yt, xr, yt - c, xr, ym + 0.07, xl, yb, xr + hw, yb]],
    [[xl - hw, yt, xr - c, yt, xr, yt - c, xr, ym + c, xr - c, ym, xr, ym - c, xr, yb + c, xr - c, yb, xl - hw, yb], [xr - c, ym, xm - 0.03, ym]],
    [[xr - 0.065, yb - hw, xr - 0.065, yt, xl, ym - 0.16, xr + hw, ym - 0.16]],
    [[xr + hw, yt, xl, yt, xl, ym + 0.05, xr - c, ym + 0.05, xr, ym + 0.05 - c, xr, yb + c, xr - c, yb, xl + c, yb, xl, yb + c]],
    [[xr, yt - c, xr - c, yt, xl + c, yt, xl, yt - c, xl, yb + c, xl + c, yb, xr - c, yb, xr, yb + c, xr, ym - c + 0.03, xr - c, ym + 0.03, xl, ym + 0.03]],
    [[xl - hw, yt, xr, yt, xm - 0.04, yb - hw]],
    [[xl + c, yb, xr - c, yb, xr, yb + c, xr, yt - c, xr - c, yt, xl + c, yt, xl, yt - c, xl, yb + c, xl + c, yb], [xl, ym, xr, ym]],
    [[xl, yb + c, xl + c, yb, xr - c, yb, xr, yb + c, xr, yt - c, xr - c, yt, xl + c, yt, xl, yt - c, xl, ym + c - 0.03, xl + c, ym - 0.03, xr, ym - 0.03]],
    // 10 L, 11 C, 12 R: the letters of parallel runways
    [[xl, yt + hw, xl, yb, xr + hw, yb]],
    [[xr, yt - c - 0.07, xr, yt - c, xr - c, yt, xl + c, yt, xl, yt - c, xl, yb + c, xl + c, yb, xr - c, yb, xr, yb + c, xr, yb + c + 0.07]],
    [[xl, yb - hw, xl, yt, xr - c, yt, xr, yt - c, xr, ym + c, xr - c, ym, xl, ym], [xm - 0.02, ym, xr, yb - hw]],
  ];
  const out = [];
  for (const glyph of lines) {
    const segs = [];
    for (const l of glyph) {
      const n = l.length / 2, closed = n > 2 && Math.hypot(l[0] - l[2 * n - 2], l[1] - l[2 * n - 1]) < 1e-6;
      const dir = (i) => { const dx = l[2 * i + 2] - l[2 * i], dy = l[2 * i + 3] - l[2 * i + 1], d = Math.hypot(dx, dy); return [dx / d, dy / d]; };
      // Lengthen each end that meets another stroke so the outside of the corner fills (a mitre).
      const mitre = (d0, d1) => Math.min(hw * Math.tan(Math.acos(Math.max(-1, Math.min(1, d0[0] * d1[0] + d0[1] * d1[1]))) / 2), hw);
      for (let i = 0; i < n - 1; i++) {
        const d = dir(i);
        const before = i > 0 ? mitre(dir(i - 1), d) : closed ? mitre(dir(n - 2), d) : 0;
        const after = i < n - 2 ? mitre(d, dir(i + 1)) : closed ? mitre(d, dir(0)) : 0;
        segs.push(new THREE.Vector4(l[2 * i] - d[0] * before, l[2 * i + 1] - d[1] * before, l[2 * i + 2] + d[0] * after, l[2 * i + 3] + d[1] * after));
      }
    }
    while (segs.length < 10) segs.push(new THREE.Vector4(-1, -1, -1, -1));
    out.push(...segs.slice(0, 10));
  }
  return out;
}

// ------------------------------------------------------------------ geometry

const WALLS = { h: [[0.50, 0.51, 0.50], [0.56, 0.54, 0.47], [0.34, 0.41, 0.37], [0.40, 0.44, 0.50], [0.52, 0.47, 0.40], [0.58, 0.58, 0.56]], t: [[0.50, 0.50, 0.48], [0.56, 0.54, 0.50]], b: [[0.52, 0.50, 0.45], [0.46, 0.47, 0.47], [0.56, 0.55, 0.52], [0.42, 0.36, 0.30]], c: [[0.47, 0.46, 0.44]] };
const ROOFS = { h: [[0.40, 0.41, 0.42], [0.30, 0.31, 0.33], [0.33, 0.17, 0.13], [0.19, 0.25, 0.21], [0.46, 0.46, 0.45]], t: [[0.32, 0.33, 0.35], [0.40, 0.40, 0.40]], b: [[0.28, 0.29, 0.31], [0.36, 0.20, 0.16], [0.38, 0.39, 0.40], [0.20, 0.24, 0.22]], c: [[0.22, 0.23, 0.25]] };

/** Collects one field's ground layer: vertices carry the feature's own coordinates and what kind of thing it is. */
class Ground {
  constructor(a) {
    this.a = a; this.pos = []; this.rc = []; this.p0 = []; this.p1 = []; this.idx = []; this.n = 0;
    const f = a.flat, nl = Math.hypot(f.gx, 1, f.gz);
    this.normal = [-f.gx / nl, 1 / nl, -f.gz / nl];
  }
  /** x, z are field-local; the height comes from the field's graded plane. */
  vert(x, z, u, v, type, kind, p0, p1) {
    this.pos.push(x, this.a.heightAt(this.a.ox + x, this.a.oz + z), z);
    this.rc.push(u, v, type, kind); this.p0.push(p0[0], p0[1], p0[2], p0[3]); this.p1.push(p1[0], p1[1], p1[2], p1[3]);
    return this.n++;
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, b, d, c); }
  /** A band `half` either side of a line of points, mitred at the bends; along-track distance starts at s0. */
  ribbon(pts, half, type, kind, p0, p1, s0 = 0) {
    const n = pts.length / 2;
    if (n < 2) return;
    // Long straights are cut up so the per-vertex light terms follow the ground.
    const P = [pts[0], pts[1]];
    for (let i = 1; i < n; i++) {
      const ax = pts[2 * i - 2], az = pts[2 * i - 1], bx = pts[2 * i], bz = pts[2 * i + 1], k = Math.ceil(Math.hypot(bx - ax, bz - az) / 70);
      for (let j = 1; j <= k; j++) P.push(ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k);
    }
    const m = P.length / 2;
    let s = s0, prev = -1;
    for (let i = 0; i < m; i++) {
      const x = P[2 * i], z = P[2 * i + 1];
      let ax = 0, az = 0, bx = 0, bz = 0;
      if (i > 0) { ax = x - P[2 * i - 2]; az = z - P[2 * i - 1]; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l; s += l; }
      if (i < m - 1) { bx = P[2 * i + 2] - x; bz = P[2 * i + 3] - z; const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; }
      if (i === 0) { ax = bx; az = bz; } else if (i === m - 1) { bx = ax; bz = az; }
      // Right-hand normal of the bisector, stretched at a bend so the band keeps its width.
      let tx = ax + bx, tz = az + bz; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const k = half / Math.max(0.5, tx * ax + tz * az), nx = -tz * k, nz = tx * k;
      const l = this.vert(x - nx, z - nz, -half, s, type, kind, p0, p1), r = this.vert(x + nx, z + nz, half, s, type, kind, p0, p1);
      if (prev >= 0) this.quad(prev, prev + 1, l, r);
      prev = l;
    }
  }
  /** A filled outline (an apron). Its coordinates for the surface pattern are in the main runway's frame. */
  area(ring, kind, p1 = [0, 0, 0, 0]) {
    const a = this.a, m = a.runways[0], v2 = [];
    for (let i = 0; i < ring.length; i += 2) v2.push(new THREE.Vector2(ring[i], ring[i + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(v2, []), base = this.n, zero = [0, 0, 0, 0];
    for (let i = 0; i < ring.length; i += 2) {
      const dx = ring[i] - m.lx, dz = ring[i + 1] - m.lz;
      this.vert(ring[i], ring[i + 1], dz * m.ux - dx * m.uz, dx * m.ux + dz * m.uz, T_AREA, kind, [8, 0, 0, 0], p1);
    }
    for (const t of tris) this.idx.push(base + t[0], base + t[1], base + t[2]);
  }
  mesh(material) {
    const g = new THREE.BufferGeometry(), n = this.n, nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nrm.set(this.normal, i * 3);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aRC', new THREE.BufferAttribute(new Float32Array(this.rc), 4));
    g.setAttribute('aP0', new THREE.BufferAttribute(new Float32Array(this.p0), 4));
    g.setAttribute('aP1', new THREE.BufferAttribute(new Float32Array(this.p1), 4));
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true; mesh.renderOrder = -20;
    return mesh;
  }
}

const inRunway = (r, x, z, pad) => { const dx = x - r.lx, dz = z - r.lz; return Math.abs(dx * r.ux + dz * r.uz) <= r.len / 2 + pad && Math.abs(dz * r.ux - dx * r.uz) <= r.width / 2 + pad; };
const crossTrack = (r, x, z) => Math.abs((z - r.lz) * r.ux - (x - r.lx) * r.uz);

/** The parts of a line that lie outside every paved runway (yellow lines stop at the runway's edge). */
function outsideRunways(a, pts) {
  const runs = []; let run = [];
  const paved = a.runways.filter((r) => r.cls > 0);
  const out = (x, z) => !paved.some((r) => inRunway(r, x, z, -0.2));
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3], k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
    for (let j = i === 0 ? 0 : 1; j <= k; j++) {
      const x = ax + ((bx - ax) * j) / k, z = az + ((bz - az) * j) / k;
      if (out(x, z)) run.push(x, z); else { if (run.length >= 4) runs.push(run); run = []; }
    }
  }
  if (run.length >= 4) runs.push(run);
  // Straight stretches were chopped into 3 m steps to find the cuts; drop the points that add nothing.
  return runs.map((r) => {
    const keep = [r[0], r[1]];
    for (let i = 2; i + 3 < r.length; i += 2) {
      const ax = keep[keep.length - 2], az = keep[keep.length - 1], bx = r[i + 2], bz = r[i + 3], l = Math.hypot(bx - ax, bz - az) || 1;
      if (Math.abs(((r[i] - ax) * (bz - az) - (r[i + 1] - az) * (bx - ax)) / l) > 0.02) keep.push(r[i], r[i + 1]);
    }
    keep.push(r[r.length - 2], r[r.length - 1]);
    return keep;
  });
}

/** Where aircraft hold short of a runway: the mapped points if the field has them, else worked out from the taxiways. */
function holdLines(a) {
  const out = [], paved = a.runways.filter((r) => r.cls > 0);
  if (!paved.length) return out;
  const nearestRunway = (x, z) => paved.slice().sort((p, q) => crossTrack(p, x, z) - crossTrack(q, x, z))[0];
  const ways = a.taxiways.filter((t) => !t.stop && t.surface === 'paved');
  if (a.holds.length) {
    for (let h = 0; h < a.holds.length; h += 2) {
      const x = a.holds[h], z = a.holds[h + 1];
      let best = null, bd = 6;
      for (const t of ways) for (let i = 0; i + 3 < t.p.length; i += 2) {
        const ax = t.p[i], az = t.p[i + 1], bx = t.p[i + 2], bz = t.p[i + 3], l2 = (bx - ax) ** 2 + (bz - az) ** 2;
        const k = l2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / l2)) : 0;
        const d = Math.hypot(x - ax - k * (bx - ax), z - az - k * (bz - az));
        if (d < bd) { bd = d; const l = Math.sqrt(l2) || 1; best = { tx: (bx - ax) / l, tz: (bz - az) / l, w: t.w }; }
      }
      if (!best) continue;
      const r = nearestRunway(x, z);
      // Face the runway: the way along the taxiway that brings you closer to its centerline.
      if (crossTrack(r, x + best.tx * 5, z + best.tz * 5) > crossTrack(r, x - best.tx * 5, z - best.tz * 5)) { best.tx = -best.tx; best.tz = -best.tz; }
      out.push({ x, z, ...best });
    }
    return out;
  }
  for (const t of ways) {
    if (t.lane) continue;
    for (const end of [0, 1]) {
      // Walk the taxiway away from an end that lies on a runway until it is the holding distance off the centerline.
      const n = t.p.length / 2, at = (i) => [t.p[2 * i], t.p[2 * i + 1]], first = at(end ? n - 1 : 0);
      const r = paved.find((q) => inRunway(q, first[0], first[1], 4));
      if (!r) continue;
      const want = r.width / 2 + (r.cls >= 3 ? 52 : r.cls >= 2 ? 30 : 22);
      let prev = first, done = false;
      for (let s = 1; s < n && !done; s++) {
        const cur = at(end ? n - 1 - s : s), l = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) || 1;
        for (let d = 0; d <= l; d += 1) {
          const x = prev[0] + ((cur[0] - prev[0]) * d) / l, z = prev[1] + ((cur[1] - prev[1]) * d) / l;
          if (crossTrack(r, x, z) >= want) { out.push({ x, z, tx: -(cur[0] - prev[0]) / l, tz: -(cur[1] - prev[1]) / l, w: t.w }); done = true; break; }
        }
        prev = cur;
      }
    }
  }
  return out;
}

function buildGround(a, material) {
  const g = new Ground(a), zero = [0, 0, 0, 0];
  // Snow is cleared at the busy fields: the whole width of an airline airport's main runway (2), a lane down the
  // other runways and the taxiways there and at the busier general-aviation fields (1); nothing at a small strip (0).
  // It rides in the fourth number of a feature, in twos, above the runway's traffic (see the pavement shader).
  const busy = a.big ? 2 : a.traffic >= 0.45 ? 1 : 0, lane = [0, 0, 0, 2 * Math.min(busy, 1)];
  // Painter's order: aprons, taxiways, unpaved strips, paved runways, then the yellow lines over everything.
  for (const p of a.aprons) g.area(p.p, KIND[p.kind], lane);
  for (const t of a.taxiways) g.ribbon(t.p, t.w / 2 + 1.5, T_RIBBON, KIND[t.kind], [t.w / 2, 0, 0, 0], lane);
  const strip = (r) => {
    const paved = r.cls > 0, pad = paved ? 2 : 6, half = r.width / 2, main = r === a.runways[0];
    const pts = [r.ax - r.ux * pad, r.az - r.uz * pad, r.bx + r.ux * pad, r.bz + r.uz * pad];
    // A designator as the shader wants it: the number, + 100 for L, 200 for C, 300 for R ("4", "28L", "10C").
    const code = (s) => { const m = /^(\d+)\s*([LCR])?/i.exec(String(s)) || []; return (parseInt(m[1], 10) || 0) + 100 * (' LCR'.indexOf((m[2] || ' ').toUpperCase())); };
    // First: both designators (this end's + 1024 x the far end's). Second: the runway's direction on the map, for the
    // lamps the wet surface mirrors. Third: its class of paint. Fourth: how busy it is (under 1), + 2 x how well it is plowed.
    g.ribbon(pts, half + pad, paved ? T_RUNWAY : T_STRIP, KIND[r.kind], [half, r.len, r.dt[0], r.dt[1]],
      [code(r.numbers[0]) + 1024 * code(r.numbers[1]), Math.atan2(r.uz, r.ux), r.cls, Math.min(a.traffic * (main ? 1 : 0.5), 0.99) + 2 * (paved ? (main ? busy : Math.min(busy, 1)) : 0)], -pad);
  };
  for (const r of a.runways) if (r.cls === 0) strip(r);
  for (const r of a.runways) if (r.cls > 0) strip(r);
  const lw = a.big ? 0.1 : 0.075;
  for (const t of a.taxiways) {
    if (t.stop || t.surface !== 'paved') continue;
    for (const run of outsideRunways(a, t.p)) g.ribbon(run, 0.7, T_LINE, 0, [lw, 0, 0, 0], lane);
  }
  for (const s of a.stands) g.ribbon(s, 0.7, T_LINE, 0, [0.075, 0, 0, 0], lane);
  const hw = a.big ? 0.3 : 0.15;
  for (const h of holdLines(a)) {
    // A short band across the taxiway: u across it, v from the waiting side toward the runway.
    const half = Math.min(h.w / 2, 14), depth = 7 * hw, nx = -h.tz, nz = h.tx, base = g.n, p0 = [half, hw, 0, 0];
    for (const [u, v] of [[-half - 0.5, -0.5], [half + 0.5, -0.5], [-half - 0.5, depth + 0.5], [half + 0.5, depth + 0.5]]) g.vert(h.x + nx * u + h.tx * v, h.z + nz * u + h.tz * v, u, v, T_HOLD, 0, p0, lane);
    g.quad(base, base + 1, base + 2, base + 3);
  }
  return g.mesh(material);
}

/** Every building of a field as one mesh: walls and a roof for each footprint (a ridge on plain sheds and hangars). */
function buildBuildings(a, material) {
  const pos = [], nrm = [], col = [], aw = [], idx = [];
  let n = 0;
  const v = (x, y, z, nx, ny, nz, c, u, h, what) => { pos.push(x, y, z); nrm.push(nx, ny, nz); col.push(c[0], c[1], c[2]); aw.push(u, h, what); return n++; };
  const rnd = mulberry32(a.id.charCodeAt(2) * 131 + a.id.charCodeAt(3) * 7 + 5);
  let top = null;
  for (const b of a.buildings) {
    const p = b.p, m = p.length / 2;
    let cx = 0, cz = 0, area = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0, j = m - 1; i < m; j = i++) { cx += p[2 * i]; cz += p[2 * i + 1]; area += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1]; const y = a.heightAt(a.ox + p[2 * i], a.oz + p[2 * i + 1]); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    cx /= m; cz /= m;
    const sign = area >= 0 ? 1 : -1, ground = a.heightAt(a.ox + cx, a.oz + cz), y0 = lo - 0.6, yTop = ground + b.h;
    const pick = (list) => { const c = list[Math.floor(rnd() * list.length)], k = 0.88 + rnd() * 0.24; return [c[0] * k, c[1] * k, c[2] * k]; };
    const wall = pick(WALLS[b.kind] || WALLS.b), roof = pick(ROOFS[b.kind] || ROOFS.b);
    // A ridge roof for a plain four-cornered shed or hangar; anything else gets a flat one.
    const e0 = Math.hypot(p[2] - p[0], p[3] - p[1]), e1 = Math.hypot(p[4] - p[2], p[5] - p[3]);
    const square = m === 4 && Math.abs(((p[2] - p[0]) * (p[4] - p[2]) + (p[3] - p[1]) * (p[5] - p[3])) / (e0 * e1)) < 0.2;
    const ridge = square && (b.kind === 'h' || b.kind === 'b') && Math.min(e0, e1) < 60;
    const yEave = ridge ? ground + b.h * 0.78 : yTop;
    const what = b.kind === 't' ? 2 : 0;
    let u = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], l = Math.hypot(bx - ax, bz - az) || 1;
      const nx = ((bz - az) / l) * sign, nz = (-(bx - ax) / l) * sign;
      const cabFrom = b.kind === 'c' ? Math.max(yTop - 4.5, y0 + 3) : yTop;
      const band = (ya, yb, w, c) => {
        const q = n;
        v(ax, ya, az, nx, 0, nz, c, u, ya - ground, w); v(bx, ya, bz, nx, 0, nz, c, u + l, ya - ground, w);
        v(ax, yb, az, nx, 0, nz, c, u, yb - ground, w); v(bx, yb, bz, nx, 0, nz, c, u + l, yb - ground, w);
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      };
      if (b.kind === 'c') {
        band(y0, cabFrom, 0, wall);
        // The cab: its own height above its sill, so the glass sits in a ring just under the roof.
        const q = n, sill = cabFrom - 0.6;
        v(ax, cabFrom, az, nx, 0, nz, wall, u, cabFrom - sill, 3); v(bx, cabFrom, bz, nx, 0, nz, wall, u + l, cabFrom - sill, 3);
        v(ax, yTop, az, nx, 0, nz, wall, u, yTop - sill, 3); v(bx, yTop, bz, nx, 0, nz, wall, u + l, yTop - sill, 3);
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      } else band(y0, yEave, what, wall);
      u += l;
    }
    if (ridge) {
      // Ridge along the longer side: two slopes and two gable ends.
      const s = e0 >= e1 ? 0 : 1, P = (k) => [p[2 * ((k + s) % 4)], p[2 * ((k + s) % 4) + 1]];
      const [p0, p1, p2, p3] = [P(0), P(1), P(2), P(3)], m12 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], m30 = [(p3[0] + p0[0]) / 2, (p3[1] + p0[1]) / 2];
      const slope = (a0, a1, r1, r0) => {
        const ex = a1[0] - a0[0], ez = a1[1] - a0[1], fx = r0[0] - a0[0], fy = yTop - yEave, fz = r0[1] - a0[1];
        let nx = -ez * fy, ny = ez * fx - ex * fz, nz = ex * fy;         // e x f, with e level along the eave
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const l = Math.hypot(nx, ny, nz) || 1, q = n;
        v(a0[0], yEave, a0[1], nx / l, ny / l, nz / l, roof, 0, b.h, 1); v(a1[0], yEave, a1[1], nx / l, ny / l, nz / l, roof, 0, b.h, 1);
        v(r0[0], yTop, r0[1], nx / l, ny / l, nz / l, roof, 0, b.h, 1); v(r1[0], yTop, r1[1], nx / l, ny / l, nz / l, roof, 0, b.h, 1);
        idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
      };
      slope(p0, p1, m12, m30); slope(p2, p3, m30, m12);
      const gable = (a0, a1, r) => {
        const l = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]) || 1, nx = ((a1[1] - a0[1]) / l) * sign, nz = (-(a1[0] - a0[0]) / l) * sign, q = n;
        v(a0[0], yEave, a0[1], nx, 0, nz, wall, 0, yEave - ground, 0); v(a1[0], yEave, a1[1], nx, 0, nz, wall, l, yEave - ground, 0); v(r[0], yTop, r[1], nx, 0, nz, wall, l / 2, b.h, 0);
        idx.push(q, q + 1, q + 2);
      };
      gable(p1, p2, m12); gable(p3, p0, m30);
    } else {
      const v2 = [], q = n;
      for (let i = 0; i < m; i++) { v2.push(new THREE.Vector2(p[2 * i], p[2 * i + 1])); v(p[2 * i], yTop, p[2 * i + 1], 0, 1, 0, roof, 0, b.h, 1); }
      for (const t of THREE.ShapeUtils.triangulateShape(v2, [])) idx.push(q + t[0], q + t[1], q + t[2]);
    }
    const score = b.h + (b.kind === 'c' ? 100 : b.kind === 't' ? 20 : 0);
    if (!top || score > top.score) top = { score, x: cx, y: yTop, z: cz };
  }
  if (!n) return { mesh: null, top };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(aw), 3));
  g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return { mesh: new THREE.Mesh(g, material), top };
}

/** The shadows of a field's buildings: each footprint's edges and its outline again, to be thrown along the sun by the shader. */
function buildShade(a, material) {
  const pos = [], nrm = [], sh = [], idx = [];
  const f = a.flat, nl = Math.hypot(f.gx, 1, f.gz), N = [-f.gx / nl, 1 / nl, -f.gz / nl];
  let n = 0;
  const v = (x, z, h, top) => { pos.push(x, a.heightAt(a.ox + x, a.oz + z), z); nrm.push(N[0], N[1], N[2]); sh.push(h, top); return n++; };
  for (const b of a.buildings) {
    const p = b.p, m = p.length / 2, h = b.h * (b.kind === 'c' ? 1 : 0.9), base = n, v2 = [];
    for (let i = 0; i < m; i++) { v(p[2 * i], p[2 * i + 1], h, 0); v(p[2 * i], p[2 * i + 1], h, 1); v2.push(new THREE.Vector2(p[2 * i], p[2 * i + 1])); }
    for (let i = 0; i < m; i++) { const j = (i + 1) % m; idx.push(base + 2 * i, base + 2 * j, base + 2 * i + 1, base + 2 * j, base + 2 * j + 1, base + 2 * i + 1); }
    for (const t of THREE.ShapeUtils.triangulateShape(v2, [])) idx.push(base + 2 * t[0] + 1, base + 2 * t[1] + 1, base + 2 * t[2] + 1);
  }
  if (!n) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('aSh', new THREE.BufferAttribute(new Float32Array(sh), 2));
  g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  const mesh = new THREE.Mesh(g, material);
  mesh.renderOrder = -10; mesh.frustumCulled = false;      // the thrown vertices are not where the geometry says
  const p0 = new THREE.Vector3(), nv = new THREE.Vector3();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    // The plane in view space, worked out here in double precision.
    p0.set(a.x, a.elev, a.z).applyMatrix4(camera.matrixWorldInverse);
    nv.set(N[0], N[1], N[2]).transformDirection(camera.matrixWorldInverse);
    material.uniforms.uPlane.value.set(nv.x, nv.y, nv.z, nv.dot(p0));
    const rt = renderer.getRenderTarget();
    material.uniforms.uRes.value.set(rt ? rt.width : renderer.domElement.width, rt ? rt.height : renderer.domElement.height);
    material.uniformsNeedUpdate = true;
  };
  return mesh;
}

const WHITE = [1.0, 0.90, 0.74], GREEN = [0.12, 1.0, 0.32], RED = [1.0, 0.09, 0.05], BLUE = [0.10, 0.22, 1.0], AMBER = [1.0, 0.62, 0.10];

/** Every lamp of a field as one set of points. */
function buildLamps(a, material, beaconAt) {
  const pos = [], col = [], col2 = [], dir = [], size = [];
  const lamp = (x, z, h, c, k, s, d = [0, 0, 0], kind = 0, c2 = [0, 0, 0]) => {
    pos.push(x, a.heightAt(a.ox + x, a.oz + z) + h, z); const k2 = kind === 2 ? 1 : k;                        // a PAPI unit keeps its changeover angle there, not a color
    col.push(c[0] * k, c[1] * k, c[2] * k); col2.push(c2[0] * k2, c2[1] * k2, c2[2] * k2); dir.push(d[0], d[1], d[2], kind); size.push(s);
  };
  a.runways.forEach((r, ri) => {
    if (!(r.lit || ri === 0)) return;
    const half = r.width / 2, rx = -r.uz, rz = r.ux, big = r.cls >= 3;
    // Edge lights between the thresholds, 60 m apart; on the long instrument runways the last 600 m show amber.
    const from = r.dt[0], to = r.len - r.dt[1], n = Math.max(2, Math.round((to - from) / 60));
    for (let i = 0; i <= n; i++) {
      const s = from + ((to - from) * i) / n;
      for (const sd of [-1, 1]) {
        const x = r.ax + r.ux * s + rx * sd * (half + 1.5), z = r.az + r.uz * s + rz * sd * (half + 1.5);
        const amberA = big && s - from < 600, amberB = big && to - s < 600;
        if (amberA || amberB) lamp(x, z, 0.35, amberB ? WHITE : AMBER, 1, 0.3, [r.ux, 0, r.uz], 3, amberB ? AMBER : WHITE);
        else lamp(x, z, 0.35, WHITE, 1, 0.3);
      }
    }
    // Threshold (green, seen landing) and runway end (red, seen rolling out), a row across each end.
    const m = Math.max(6, Math.round(r.width / 3.2));
    for (let i = 0; i < m; i++) {
      const c = (-half + ((i + 0.5) * r.width) / m);
      for (const [s, out] of [[from, -1], [to, 1]]) {
        lamp(r.ax + r.ux * (s - out * 0.5) + rx * c, r.az + r.uz * (s - out * 0.5) + rz * c, 0.3, GREEN, 1.25, 0.32, [r.ux * out, 0.06, r.uz * out], 1);
      }
      for (const [s, out] of [[0, -1], [r.len, 1]]) {
        lamp(r.ax + r.ux * (s + out * 1.5) + rx * c, r.az + r.uz * (s + out * 1.5) + rz * c, 0.3, RED, 1.0, 0.32, [-r.ux * out, 0.06, -r.uz * out], 1);
      }
    }
  });
  // Blue edge lights on the taxiways of the airline airports.
  if (a.big) for (const t of a.taxiways) {
    if (t.stop || t.lane || t.surface !== 'paved') continue;
    let carry = 20;
    for (let i = 0; i + 3 < t.p.length; i += 2) {
      const ax = t.p[i], az = t.p[i + 1], bx = t.p[i + 2], bz = t.p[i + 3], l = Math.hypot(bx - ax, bz - az) || 1, ux = (bx - ax) / l, uz = (bz - az) / l;
      for (; carry <= l; carry += 45) {
        for (const sd of [-1, 1]) {
          const x = ax + ux * carry - uz * sd * (t.w / 2 + 1), z = az + uz * carry + ux * sd * (t.w / 2 + 1);
          if (!a.runways.some((r) => inRunway(r, x, z, 8)) && !a.aprons.some((p) => x > p.box[0] && x < p.box[2] && z > p.box[1] && z < p.box[3] && inside(p.p, x, z))) lamp(x, z, 0.3, BLUE, 0.8, 0.22);
        }
      }
      carry -= l;
    }
  }
  const paved = a.runways.filter((r) => r.cls > 0);
  const nearestEnd = (x, z) => {
    let best = null, bd = Infinity;
    for (const r of paved) for (const e of [0, 1]) {
      const ex = e ? r.bx : r.ax, ez = e ? r.bz : r.az, d = Math.hypot(x - ex, z - ez);
      if (d < bd) { bd = d; best = { r, out: e ? 1 : -1, ex, ez }; }
    }
    return best;
  };
  // Approach lights, where the field has them: white, shining back up the approach.
  for (let i = 0; i < a.als.length; i += 2) {
    const e = nearestEnd(a.als[i], a.als[i + 1]);
    if (e) lamp(a.als[i], a.als[i + 1], 0.8, WHITE, 1.5, 0.36, [e.r.ux * e.out, 0.07, e.r.uz * e.out], 1);
  }
  // Approach-slope indicators: four units in a row square to the runway; each turns from red to white at its own angle.
  const papi = (x, z, e) => {
    const r = e.r, rx = -r.uz, rz = r.ux, side = Math.sign((x - r.lx) * rx + (z - r.lz) * rz) || 1;
    for (let k = 0; k < 4; k++) {
      const off = (k - 1.5) * 9 * side;
      lamp(x + rx * off, z + rz * off, 0.6, [1, 1, 1], 2.2, 0.5, [r.ux * e.out, 0.052, r.uz * e.out], 2, [3.5 - k * (1 / 3), 0, 0]);
    }
  };
  if (a.papis.length) for (let i = 0; i < a.papis.length; i += 2) { const e = nearestEnd(a.papis[i], a.papis[i + 1]); if (e) papi(a.papis[i], a.papis[i + 1], e); }
  else if (a.big) {
    // Not on the map, but every airline runway here has them: left of the runway, abeam the aiming point.
    const r = a.runways[0], rx = -r.uz, rz = r.ux;
    for (const out of [-1, 1]) {
      const s = out < 0 ? r.dt[0] + 300 : r.len - r.dt[1] - 300, sd = out < 0 ? -1 : 1;
      papi(r.ax + r.ux * s + rx * sd * (r.width / 2 + 28), r.az + r.uz * s + rz * sd * (r.width / 2 + 28), { r, out });
    }
  }
  if (beaconAt) { pos.push(beaconAt.x, beaconAt.y, beaconAt.z); col.push(1.0, 0.97, 0.9); col2.push(0.12, 1.0, 0.33); dir.push(0, 1, 0, 4); size.push(0.9); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aCol2', new THREE.BufferAttribute(new Float32Array(col2), 3));
  g.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(dir), 4));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(size), 1));
  const pts = new THREE.Points(g, material);
  pts.renderOrder = 5;
  return pts;
}
function inside(r, px, pz) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) if ((r[i + 1] > pz) !== (r[j + 1] > pz) && px < ((r[j] - r[i]) * (pz - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
  return c;
}

// ------------------------------------------------------------------ the layer

export class Airfields {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.name = 'airfields'; this.group.userData.airfields = this;
    scene.add(this.group);
    this.fields = new Map();          // id -> { group, socks, tris }
    this.uLevel = { value: 0 }; this.uViewH = { value: 1080 }; this.uMinPx = { value: 4.5 }; this.uLamps = { value: 0 };
    this.uLampGlow = { value: 0 };    // strength of a runway lamp as the wet pavement mirrors it (0: lamps off)

    this.paveMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights), ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), tPave: { value: makePaveTexture() }, uGlyph: { value: makeGlyphs() },
        uRain: ENV.uRain, uWind: ENV.uWind, uTime: ENV.uTime, uLampGlow: this.uLampGlow },
      vertexShader: PAVE_VERT, fragmentShader: PAVE_FRAG, lights: true, side: THREE.DoubleSide,
      // A decal on the graded ground: blended over it (land stays alpha 1 for the post-processing), never written to depth.
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    });
    this.bldMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), uLamps: this.uLamps },
      vertexShader: BLD_VERT, fragmentShader: BLD_FRAG, side: THREE.DoubleSide,
    });
    this.shadeMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), uPlane: { value: new THREE.Vector4(0, 1, 0, 0) }, uRes: { value: new THREE.Vector2(1920, 1080) } },
      vertexShader: SHADE_VERT, fragmentShader: SHADE_FRAG, side: THREE.DoubleSide, transparent: true, depthFunc: THREE.LessDepth,
      // Multiply what is behind by the fragment's color; leave the surface tag in alpha alone.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.lampMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(ATMO_UNIFORMS), uViewH: this.uViewH, uLevel: this.uLevel, uMinPx: this.uMinPx, uTime: ENV.uTime },
      vertexShader: LAMP_VERT, fragmentShader: LAMP_FRAG, transparent: true, depthWrite: false,
      // Light adds to what is behind it and leaves the surface tag in alpha alone.
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const lam = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0, ...o });
    this.poleMat = lam(0x8c8c8c); this.sockMat = lam(0xff6a14, { side: THREE.DoubleSide });
    this.sockGeo = new THREE.ConeGeometry(0.55, 3.6, 10, 1, true); this.sockGeo.rotateX(Math.PI / 2); this.sockGeo.translate(0, 0, 1.8);
    this.poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 6.5, 6); this.poleGeo.translate(0, 3.25, 0);
  }

  build(a) {
    const group = new THREE.Group(), socks = [];
    group.position.set(a.ox, 0, a.oz); group.matrixAutoUpdate = false; group.updateMatrix();
    const ground = buildGround(a, this.paveMat);
    group.add(ground);
    const { mesh: bld, top } = buildBuildings(a, this.bldMat);
    if (bld) group.add(bld);
    const shade = buildShade(a, this.shadeMat);
    if (shade) group.add(shade);
    // Windsocks where the map has them, else one beside the main runway a third of the way along.
    const m = a.runways[0], spots = [], small = [];
    for (let i = 0; i < a.windsocks.length && spots.length < 3; i += 2) spots.push([a.windsocks[i], a.windsocks[i + 1]]);
    if (!spots.length) spots.push([m.ax + m.ux * m.len * 0.3 + m.uz * (m.width / 2 + 35), m.az + m.uz * m.len * 0.3 - m.ux * (m.width / 2 + 35)]);
    for (const [x, z] of spots) {
      const y = a.heightAt(a.ox + x, a.oz + z);
      const pole = new THREE.Mesh(this.poleGeo, this.poleMat); pole.position.set(x, y, z); group.add(pole);
      const sock = new THREE.Mesh(this.sockGeo, this.sockMat); sock.position.set(x, y + 6.4, z); sock.rotation.order = 'YXZ'; group.add(sock);
      small.push(pole, sock);
      socks.push({ sock, x: a.ox + x, z: a.oz + z, y });
    }
    // The beacon stands on the tower or the tallest building, or on a mast by the windsock.
    const beacon = top ? { x: top.x, y: top.y + 1.6, z: top.z } : { x: spots[0][0] + 8, y: a.heightAt(a.ox + spots[0][0], a.oz + spots[0][1]) + 9, z: spots[0][1] };
    const lamps = buildLamps(a, this.lampMat, beacon);
    lamps.onBeforeRender = (renderer) => { const rt = renderer.getRenderTarget(); this.uViewH.value = rt ? rt.height : renderer.domElement.height; };
    group.add(lamps);
    this.group.add(group);
    const tris = (ground.geometry.index.count + (bld ? bld.geometry.index.count : 0) + (shade ? shade.geometry.index.count : 0)) / 3;
    this.fields.set(a.id, { a, group, socks, lamps, shade, small, tris, lampCount: lamps.geometry.attributes.position.count });
  }

  drop(id) {
    const f = this.fields.get(id);
    this.group.remove(f.group);
    f.group.traverse((o) => { if (o.geometry && o.geometry !== this.sockGeo && o.geometry !== this.poleGeo) o.geometry.dispose(); });
    this.fields.delete(id);
  }

  /** Let go of every field: the window of the world is about to move. */
  reset() { for (const id of [...this.fields.keys()]) this.drop(id); }

  /**
   * Build the fields in range and let go of those left behind, swing the windsocks to the wind, and set
   * the lamps for the light: off in full daylight, on from dusk and in murk. exposure is the eye's
   * adaptation (the image is brightened by it), so lamps are held back as it opens up.
   */
  update(time, weather, dark, camPos, exposure = 1) {
    // One field is built a frame at the most, the nearest first: a hub takes a few tens of milliseconds.
    let next = null, nd = BUILD_DIST;
    for (const a of AIRPORTS) {
      const d = Math.hypot(a.x - camPos.x, a.z - camPos.z), have = this.fields.has(a.id);
      if (!have && d < nd) { next = a; nd = d; } else if (have && d > DROP_DIST) this.drop(a.id);
    }
    if (next) this.build(next);
    for (const f of this.fields.values()) {
      const d = Math.hypot(f.a.x - camPos.x, f.a.z - camPos.z) - f.a.len;
      if (f.shade) f.shade.visible = d < SHADE_DIST;
      for (const o of f.small) o.visible = d < SOCK_DIST;
    }
    const w = { x: 0, z: 0 };
    for (const f of this.fields.values()) {
      for (const s of f.socks) {
        if (Math.abs(s.x - camPos.x) > 6000 || Math.abs(s.z - camPos.z) > 6000) continue;
        weather.wind(s.x, s.z, s.y + 7, s.y, w);
        const sp = Math.hypot(w.x, w.z);
        s.sock.rotation.y = Math.atan2(w.x, w.z) + Math.sin(time * 3 + s.x) * 0.08 * Math.min(1, sp / 3);    // tail streams downwind
        s.sock.rotation.x = Math.max(0, 1.2 - sp / 7);                                                    // droops in light wind
      }
    }
    // How dark it is, from the sky itself (so the lamps come on at dusk, before night proper) or from murk.
    const sky = ENV.uAmbSky.value, lum = sky.r * 0.25 + sky.g * 0.6 + sky.b * 0.15;
    const dusk = 1 - Math.min(1, Math.max(0, (lum - 0.035) / 0.11));
    const on = Math.max(dusk, dark);
    this.uLevel.value = on < 0.04 ? 0 : (3 + 9 * on) / Math.sqrt(Math.max(exposure, 1));
    this.uLamps.value = Math.max(0, Math.min(1, (on - 0.3) / 0.5));
    for (const f of this.fields.values()) f.lamps.visible = this.uLevel.value > 0;
    // A lamp 0.3 m across at the brightness its sprite is drawn with: what the wet runway has to mirror.
    this.uLampGlow.value = this.uLevel.value * Math.PI * 0.15 * 0.15 * LAMP_MIRROR;
  }
}
