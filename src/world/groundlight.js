// The light that reaches the ground, baked into top-down maps so that every ground shader
// (terrain, trees, airfields) gets it with one texture read instead of working it out per pixel.
//
// Two maps, each RGBA float:
//   r  the height of the mountain-shadow ceiling: a point lower than this has a ridge between it and the sun
//   g  how far away (m) the ridge that sets that ceiling is, which gives the width of the shadow's soft edge
//   b  the mean height of the ground in a ring around the point (valley floors see less sky than ridges)
//   a  the optical depth of the cloud on the sun's ray through the point at the map's reference height
//
//   far   the whole region at the regional grid's spacing (about 512 m), fixed in the world
//   near  1024 x 1024 texels of 40 m around the camera, marched through a height map of its own made from
//         elevation tiles of about 55 m (zoom 11) as they arrive; it scrolls with the camera in whole
//         blocks of 32 texels and is addressed toroidally, so nothing in it ever moves
//
// Both are refreshed a band of rows at a time: the sun moves slowly and the clouds drift less than a
// texel between two refreshes of the same row. The result is a function of the place alone: it does not
// change with the level of detail of the mesh that reads it, nor from one frame to the next.
//
// GROUND_LIGHT_GLSL gives a shader terrainShadow(), skyOcclusion(), cloudShadow() and, from the sun's
// shadow maps (world/sunshadow.js), localShadow(); and treeShade(), the shade of the trees on the ground,
// from the maps world/trees.js draws. A material that includes it needs the uniforms named in
// GROUND_LIGHT_UNIFORMS, all of which live in ENV.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import * as dem from './dem.js';
import { WORLD_HALF } from './geo.js';
import { CLOUD_SHADOW_GLSL, CLOUD_SHADOW_UNIFORMS } from '../weather/clouds.js';
import { FullscreenQuad, fsMaterial } from '../render/fullscreen.js';
import { perf } from '../render/perf.js';

const N = 1024;                      // texels across each map
const TS = 40;                       // near map: meters a texel
const BLOCK = 32, NB = N / BLOCK;    // the near height map is filled in blocks of this many texels
const HEIGHT_Z = 11;                 // elevation zoom wanted for it (about 55 m a pixel here)
const VALID = (NB / 2 - 1.5) * BLOCK * TS;   // the near map is trusted this far from its center (the outermost blocks may be mid-scroll)
const BLEND = 1400;                  // and gives way to the far map over this distance inside that
const SLICES = 8;                    // a full refresh takes this many frames
const SOFT = 0.011, SOFT_MIN = 5;    // half-width of a shadow edge in height: meters per meter of distance to the ridge, and at least
const CLOUD_L_MIN = 0.12;            // the cloud code's own floor on the sun's height (see cloudShadowDepth)

// ---- uniforms shared with every ground shader. Made here, at import, so a material built before the
// maps exist still gets the holders.
const hold = (k, v) => ENV[k] || (ENV[k] = { value: v });
hold('tLmNear', null); hold('tLmFar', null);
hold('uLmNear', new THREE.Vector4(1 / (N * TS), VALID - BLEND, 1 / BLEND, 0));   // 1 / window (1/m), radius the near map has to itself (m), 1 / blend width, cloud reference height (m)
hold('uLmCenter', new THREE.Vector2(1e9, 1e9));                                 // center of the near window (m)
hold('uLmView', 0.001);                                                          // radians a screen pixel spans
hold('uLmSun', new THREE.Vector4(0, 0, SOFT, SOFT_MIN));                          // xz the sun's ray covers per meter of height (as the cloud code clamps it); shadow edge softness
hold('tAcShadow', null); hold('uAcShadowM', new THREE.Matrix4()); hold('uAcShadowP', new THREE.Vector4(0, 1, 0, 0));
hold('tSunShadow', null); hold('uSunShadowM', [new THREE.Matrix4(), new THREE.Matrix4()]); hold('uSunShadowP', new THREE.Vector4(0, 1, 0.2, 1));
// The trees' shade (world/trees.js draws it): top-down maps around the camera, one inside the other, as the layers of one texture.
export const TREE_SHADE_LEVELS = 6;
hold('tTreeShade', null);
hold('uTreeShadeA', Array.from({ length: TREE_SHADE_LEVELS }, () => new THREE.Vector4(0, 0, 0, 0)));   // each level: its center x, z (m), 1 / its width (1/m; 0: not drawn yet)
hold('uTreeShadeP', new THREE.Vector4(0, 0, 0, 1));                              // x: 1 once there is a map; y: how far the shade lies under the crowns (no sun) instead of along the sun's ray; z: 1 / texels across a map; w: how many times wider each map is than the one inside it
hold('uSpot', [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, -1, 0, 2), new THREE.Vector4(0, 0, 0, 0)]);   // the landing light: position + range, direction + cos of the cone, color (see localLight)

export const GROUND_LIGHT_UNIFORMS = ['tLmNear', 'tLmFar', 'uLmNear', 'uLmCenter', 'uLmSun', 'uLmView', 'tAcShadow', 'uAcShadowM', 'uAcShadowP', 'tSunShadow', 'uSunShadowM', 'uSunShadowP', 'uSpot', 'tTreeShade', 'uTreeShadeA', 'uTreeShadeP'];

/**
 * Needs, declared by the including shader: tRegion, tWxB (sampler2D), uWxHalf (float), uSunDir (vec3), and
 * regionHeight(vec2). Works in vertex and fragment shaders alike (no screen-space derivatives).
 *   float terrainShadow(vec3 p, float hReg)   1 lit .. 0 behind a mountain
 *   float skyOcclusion(vec3 p, float hReg)    0 open .. 1 deep in a valley
 *   vec2  terrainLight(vec3 p, float hReg)    both of those from the one read
 *   float cloudShadow(vec3 p)                 0 clear .. 1 under thick cloud (or rain)
 *   float localShadow(vec3 p)                 1 lit .. 0 in the shadow of the aircraft or of a building
 *   float sunMapCover(vec3 p)                 1 where the building shadow maps reach, 0 beyond them (for whatever stands in for them there)
 *   vec3  localLight(vec3 p, vec3 n)          light from the aircraft's landing light falling on a surface
 *   float treeShade(vec3 p, vec2 gx, vec2 gy) 0 open .. 1 in the shade of trees; gx, gy: how p.xz changes from one pixel to
 *                                             the next across and up the screen (dFdx and dFdy of it, in a fragment shader)
 * Define LOCAL_SHADOW_IN_TERRAIN before it to have terrainShadow() include localShadow().
 */
export const GROUND_LIGHT_GLSL = /* glsl */`
precision highp sampler2DShadow;
precision highp sampler2DArray;
uniform sampler2D tLmNear, tLmFar, tAcShadow;
uniform sampler2DArray tTreeShade;
uniform vec4 uTreeShadeA[${TREE_SHADE_LEVELS}], uTreeShadeP;
uniform sampler2DShadow tSunShadow;
uniform vec4 uLmNear, uLmSun, uAcShadowP, uSunShadowP;
uniform vec2 uLmCenter;
uniform float uLmView;
uniform mat4 uAcShadowM, uSunShadowM[2];
uniform vec4 uSpot[3];

// The aircraft's own shadow. Its silhouette as the sun sees it is kept with its mipmaps; the sun is half a
// degree wide, so the shadow is that silhouette blurred by 0.0093 m for every meter the light travels on.
float aircraftShadow(vec3 p) {
  if (uAcShadowP.x <= 0.0) return 1.0;
  vec3 q = (uAcShadowM * vec4(p, 1.0)).xyz;                // xy: place in the map 0..1, z: meters past the aircraft's middle, down-sun
  if (q.z < -uAcShadowP.w || q.z > 1500.0 || q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return 1.0;
  float blur = max(q.z, 0.0) * 0.0093;                     // width of the soft edge here (m)
  float lod = max(log2(blur / uAcShadowP.y + 1.0) - 1.0, 0.0);
  vec2 o = vec2(0.25 * blur * uAcShadowP.z);               // four taps half a blur apart: a smoother kernel than one box
  vec2 s = textureLod(tAcShadow, q.xy + o, lod).rg + textureLod(tAcShadow, q.xy - o, lod).rg
    + textureLod(tAcShadow, q.xy + vec2(o.x, -o.y), lod).rg + textureLod(tAcShadow, q.xy + vec2(-o.x, o.y), lod).rg;
  s *= 0.25;
  if (s.r < 0.002) return 1.0;
  // only what lies beyond the part of the aircraft that covers it is shaded (s.g / s.r: how far down-sun that part is)
  float past = smoothstep(0.03, 0.22, q.z - (s.g / s.r - uAcShadowP.w));
  vec2 e = smoothstep(vec2(0.0), vec2(0.04), min(q.xy, 1.0 - q.xy));
  return 1.0 - s.r * past * e.x * e.y * uAcShadowP.x * (1.0 - smoothstep(700.0, 1400.0, q.z));
}

// Buildings and whatever else stands near the camera: two shadow maps, one inside the other.
// Four hardware-filtered taps make a fixed, smooth kernel about three texels wide (no noise for the eye or
// the temporal filter to chew on).
float sunMapTap(vec3 q, int i) {
  float z = q.z - (i == 0 ? uSunShadowP.z : uSunShadowP.w);
  vec2 uv = vec2((q.x + float(i)) * 0.5, q.y), t = vec2(0.5 * uSunShadowP.y, uSunShadowP.y) * 0.75;
  return 0.25 * (texture(tSunShadow, vec3(uv + t, z)) + texture(tSunShadow, vec3(uv - t, z))
    + texture(tSunShadow, vec3(uv + vec2(t.x, -t.y), z)) + texture(tSunShadow, vec3(uv + vec2(-t.x, t.y), z)));
}
// Returns x: 1 lit .. 0 shadowed, y: how far the maps cover this point at all (1 inside, easing to 0 at the outer rim).
vec2 sunMap(vec3 p) {
  if (uSunShadowP.x <= 0.0) return vec2(1.0, 0.0);
  vec3 q0 = (uSunShadowM[0] * vec4(p, 1.0)).xyz, q1 = (uSunShadowM[1] * vec4(p, 1.0)).xyz;
  vec2 c0 = abs(q0.xy - 0.5), c1 = abs(q1.xy - 0.5);
  float m0 = max(c0.x, c0.y), m1 = max(c1.x, c1.y);
  bool in0 = m0 < 0.49 && q0.z > 0.0 && q0.z < 1.0, in1 = m1 < 0.49 && q1.z > 0.0 && q1.z < 1.0;
  if (!in0 && !in1) return vec2(1.0, 0.0);
  // the fine map hands over to the coarse one across its rim, so no line shows where one ends
  float k0 = in0 ? 1.0 - smoothstep(0.40, 0.49, m0) : 0.0, sh = 1.0, cover = k0;
  if (k0 > 0.0) sh = sunMapTap(q0, 0);
  if (k0 < 1.0 && in1) { float k1 = 1.0 - smoothstep(0.42, 0.49, m1); sh = mix(mix(1.0, sunMapTap(q1, 1), k1), sh, k0); cover = mix(k1, 1.0, k0); }
  else if (k0 < 1.0) sh = mix(1.0, sh, k0);
  return vec2(mix(1.0, sh, uSunShadowP.x), cover * uSunShadowP.x);
}
float sunMapShadow(vec3 p) { return sunMap(p).x; }
float sunMapCover(vec3 p) { return sunMap(p).y; }
float localShadow(vec3 p) { return aircraftShadow(p) * sunMapShadow(p); }

float lmShade(vec4 m, float y) {
  float w = max(m.g * uLmSun.z, uLmSun.w);
  return smoothstep(-w, w, y - m.r);
}
vec2 terrainLight(vec3 p, float hReg) {
  float k;
  vec2 d = abs(p.xz - uLmCenter);
  k = clamp((max(d.x, d.y) - uLmNear.y) * uLmNear.z, 0.0, 1.0);
  vec2 r = vec2(1.0, 0.0);
  float yr = max(p.y, hReg);
  if (k < 1.0) { vec4 m = textureLod(tLmNear, p.xz * uLmNear.x, 0.0); r = vec2(lmShade(m, p.y + 3.0), clamp((m.b - yr) / 800.0, 0.0, 1.0)); }
  // the regional map knows the ground only to the nearest half kilometer: stand well clear of it
  if (k > 0.0) { vec4 m = textureLod(tLmFar, p.xz / (2.0 * uWxHalf) + 0.5, 0.0); r = mix(r, vec2(lmShade(m, yr + 45.0), clamp((m.b - yr) / 800.0, 0.0, 1.0)), k); }
  #ifdef LOCAL_SHADOW_IN_TERRAIN
  r.x *= localShadow(p);
  #endif
  return r;
}
float terrainShadow(vec3 p, float hReg) { return terrainLight(p, hReg).x; }
float skyOcclusion(vec3 p, float hReg) { return terrainLight(p, hReg).y; }

// Cloud shadow: the cloud's optical depth along the sun's ray through p, which the bake worked out for the
// point where that ray meets the map's reference height, plus the gloom under rain (baked in with it).
// Far off and seen at a low angle, a pixel covers hundreds of meters of ground along the line of sight: the
// map is read at the mip level that matches, so distant cloud shadows are averaged instead of sparkling.
float cloudShadow(vec3 p) {
  vec2 q = p.xz - uLmSun.xy * (p.y - uLmNear.w);
  vec2 d = abs(q - uLmCenter);
  float k = clamp((max(d.x, d.y) - uLmNear.y) * uLmNear.z, 0.0, 1.0);
  float dist = distance(p, cameraPosition);
  float foot = dist * uLmView / max(abs(cameraPosition.y - p.y) / max(dist, 1.0), 0.04);    // meters of ground under one pixel, the long way
  float od = 0.0;
  if (k < 1.0) od = textureLod(tLmNear, q * uLmNear.x, clamp(log2(foot * uLmNear.x * ${N}.0), 0.0, 5.0)).a;
  if (k > 0.0) od = mix(od, textureLod(tLmFar, (p.xz - uLmSun.xy * p.y) / (2.0 * uWxHalf) + 0.5, clamp(log2(foot * ${N}.0 / (2.0 * uWxHalf)), 0.0, 4.0)).a, k);
  if (od < 0.004) return 0.0;
  // a mountain standing up into the layer, or clear above it, has less of it (or none) overhead
  vec2 b = textureLod(tWxB, (p.xz + uLmSun.xy * max(1200.0 - p.y, 100.0)) / (2.0 * uWxHalf) + 0.5, 0.0).rg * 12800.0;
  if (b.g > b.r + 50.0 && p.y > b.r) od *= clamp((b.g - p.y) / (b.g - b.r), 0.0, 1.0);
  return od / (od + 1.5);
}

// The shade of trees on the ground. It is not drawn per tree on the screen (a shape laid on the ground and seen
// at a shallow angle changes with every step of the camera): the trees are drawn from above into maps that are
// fixed to the ground, each tree's silhouette as the sun sees it, already smoothed to the map's texel, and the
// ground reads the map like any other texture, filtered along the line of sight. A shadow is then a property
// of the place: it cannot slide, crawl or double as the camera moves. The finest map that reaches the point
// is used, each handing over to the next across its rim.
// Each map is coarser than the one inside it, and a shadow must not go soft all at once where one hands over
// (a ring of that would travel with the aircraft): so a map is read a little coarser the further out in it
// the point lies, by as much at its rim as the next map is coarser. A shadow's edge is then as wide as the
// distance to it asks, about a pixel and a half at any range, and nothing marks where the maps meet.
float treeShade(vec3 p, vec2 gx, vec2 gy) {
  if (uTreeShadeP.x <= 0.0) return 0.0;
  float sh = 0.0, rem = 1.0;
  for (int l = 0; l < ${TREE_SHADE_LEVELS}; l++) {
    vec4 A = uTreeShadeA[l];
    vec2 q = (p.xz - A.xy) * A.z;
    float m = max(abs(q.x), abs(q.y));
    if (m >= 0.5 || A.z <= 0.0) continue;
    float w = 1.0 - smoothstep(0.40, 0.49, m);
    // the footprint of the pixel in the map, each way never under the width the map is read at here
    float t = uTreeShadeP.z * max(1.0, uTreeShadeP.w * m * 2.0);
    vec2 ax = gx * A.z, ay = gy * A.z;
    ax *= max(1.0, t * inversesqrt(max(dot(ax, ax), 1.0e-16)));
    ay *= max(1.0, t * inversesqrt(max(dot(ay, ay), 1.0e-16)));
    sh += rem * w * textureGrad(tTreeShade, vec3(q + 0.5, float(l)), ax, ay).r;
    rem *= 1.0 - w;
    if (rem < 0.01) break;
  }
  return sh * uTreeShadeP.x;
}

// The landing light: a cone of light from the aircraft's nose. Zero unless the game switches it on.
vec3 localLight(vec3 p, vec3 n) {
  if (uSpot[2].w <= 0.0) return vec3(0.0);
  vec3 d = p - uSpot[0].xyz;
  float r2 = dot(d, d), r = sqrt(r2);
  if (r > uSpot[0].w) return vec3(0.0);
  vec3 l = d / max(r, 0.01);
  float c = dot(l, uSpot[1].xyz);
  if (c < uSpot[1].w) return vec3(0.0);
  float cone = smoothstep(uSpot[1].w, mix(uSpot[1].w, 1.0, 0.55), c);
  float fall = 1.0 / (1.0 + r2 * 0.0009) * (1.0 - smoothstep(0.6 * uSpot[0].w, uSpot[0].w, r));
  return uSpot[2].rgb * (uSpot[2].w * cone * cone * fall * max(dot(n, -l), 0.0));
}
`;

// ---- the bake

const BAKE_HEAD = /* glsl */`
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
uniform sampler2D tRegion, tWxA, tWxB;
uniform float uWxHalf;
uniform vec3 uSunDir;
out vec4 outColor;
${CLOUD_SHADOW_GLSL}
float regionHeight(vec2 xz) { return max(texture(tRegion, xz / (2.0 * uWxHalf) + 0.5).r, 0.0); }
// optical depth of the cloud on the sun's ray through a point, with the gloom under rain as its equivalent
float cloudAt(vec3 p) {
  float od = cloudShadowDepth(p);
  float rain = 0.6 * texture(tWxA, (p.xz + uSunDir.xz / max(uSunDir.y, ${CLOUD_L_MIN.toFixed(2)}) * max(1200.0 - p.y, 100.0)) / (2.0 * uWxHalf) + 0.5).b;
  return min(max(od, 1.5 * rain / max(1.0 - rain, 0.05)), 60.0);
}
`;

// The regional map. The ceiling over a point is the highest of (ridge height - what the sun's ray climbs on
// the way to it) over everything sunward of it, from 600 m out (nearer than that the half-kilometer grid
// cannot tell a ridge from the slope the point stands on).
const FAR_FRAG = BAKE_HEAD + /* glsl */`
void main() {
  vec2 xz = (gl_FragCoord.xy / float(${N}) * 2.0 - 1.0) * uWxHalf;
  float tanE = uSunDir.y / max(length(uSunDir.xz), 1.0e-4);
  vec2 dir = normalize(uSunDir.xz + vec2(1.0e-6, 0.0));
  float S = -1.0e4, D = 0.0, t = 600.0;
  for (int i = 0; i < 72; i++) {
    if (tanE * t > 4000.0 || t > 110000.0) break;
    float c = regionHeight(xz + dir * t) - tanE * t;
    if (c > S) { S = c; D = t; }
    t += max(256.0, t * 0.06);
  }
  const float R = 1400.0;
  float M = 0.0;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.7853982; M += regionHeight(xz + vec2(cos(a), sin(a)) * R); }
  outColor = vec4(S, D, M * 0.125, cloudAt(vec3(xz.x, 0.0, xz.y)));
}`;

// The near map: the same march through 40 m heights from 80 m out, handing over to the regional map's
// answer where the near heights end.
const NEAR_FRAG = BAKE_HEAD + /* glsl */`
uniform sampler2D tHeight, tLmFar;
uniform vec4 uWin;          // center of the window (m) xz, radius of valid heights (m), reference height for the cloud (m)
float nearHeight(vec2 xz) { return texture(tHeight, xz * ${(1 / (N * TS)).toExponential(8)}).r; }
void main() {
  // which piece of the world this texel holds: the one within half a window of the center
  vec2 ti = floor(gl_FragCoord.xy), ci = floor(uWin.xy * ${(1 / TS).toFixed(6)} + 0.5);
  vec2 xz = (ci + mod(ti - ci + ${N / 2}.0, ${N}.0) - ${N / 2}.0 + 0.5) * ${TS}.0;
  float tanE = uSunDir.y / max(length(uSunDir.xz), 1.0e-4);
  vec2 dir = normalize(uSunDir.xz + vec2(1.0e-6, 0.0));
  float S = -1.0e4, D = 0.0, t = 80.0;
  for (int i = 0; i < 56; i++) {
    vec2 q = xz + dir * t, e = abs(q - uWin.xy);
    if (max(e.x, e.y) > uWin.z || t > 9000.0 || tanE * t > 4000.0) break;
    float c = nearHeight(q) - tanE * t;
    if (c > S) { S = c; D = t; }
    t += max(40.0, t * 0.07);
  }
  if (tanE * t < 4000.0) {
    vec2 q = xz + dir * t;
    vec4 f = textureLod(tLmFar, q / (2.0 * uWxHalf) + 0.5, 0.0);
    float c = max(f.r, regionHeight(q)) - tanE * t;
    if (c > S) { S = c; D = (f.r > regionHeight(q) ? f.g : 0.0) + t; }
  }
  const float R = 1400.0;
  float M = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982;
    vec2 q = xz + vec2(cos(a), sin(a)) * R, e = abs(q - uWin.xy);
    M += max(e.x, e.y) > uWin.z ? regionHeight(q) : max(nearHeight(q), 0.0);
  }
  outColor = vec4(S, D, M * 0.125, cloudAt(vec3(xz.x, uWin.w, xz.y)));
}`;

const tmpV = new THREE.Vector3(), tmpP = new THREE.Vector2();

export class GroundLight {
  constructor(renderer) {
    this.renderer = renderer;
    const ext = renderer.extensions, full = ext.has('EXT_color_buffer_float') && ext.has('OES_texture_float_linear');
    this.type = full ? THREE.FloatType : THREE.HalfFloatType;
    const target = (wrap) => {
      const rt = new THREE.WebGLRenderTarget(N, N, { type: this.type, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: wrap, wrapT: wrap, generateMipmaps: true });
      rt.scissorTest = true; renderer.initRenderTarget(rt);
      rt.texture.generateMipmaps = false;          // (made by hand once a round of bands is complete, not after every band: see update)
      return rt;
    };
    this.far = target(THREE.ClampToEdgeWrapping); this.near = target(THREE.RepeatWrapping);
    ENV.tLmFar.value = this.far.texture; ENV.tLmNear.value = this.near.texture;

    // heights for the near march, filled from the elevation tiles a block at a time
    this.H = full ? new Float32Array(N * N) : new Uint16Array(N * N);
    this.heightTex = new THREE.DataTexture(this.H, N, N, THREE.RedFormat, this.type);
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.RepeatWrapping;
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.LinearFilter; this.heightTex.needsUpdate = true;
    this.blockData = full ? new Float32Array(BLOCK * BLOCK) : new Uint16Array(BLOCK * BLOCK);
    this.blockTex = new THREE.DataTexture(this.blockData, BLOCK, BLOCK, THREE.RedFormat, this.type);
    this.blockTex.minFilter = this.blockTex.magFilter = THREE.NearestFilter;
    this.scratch = new Float32Array(BLOCK * BLOCK);
    this.blockAt = new Int32Array(NB * NB * 2).fill(0x7fffffff);    // which block of the world each block of the texture holds
    this.blockZoom = new Int8Array(NB * NB).fill(-1);               // and the elevation zoom it was filled from
    this.cb = [0x7fffffff, 0]; this.upgrade = 0; this.whole = true;

    const shared = { tRegion: ENV.tRegion, tWxA: ENV.tWxA, tWxB: ENV.tWxB, uWxHalf: ENV.uWxHalf, uSunDir: ENV.uSunDir, ...Object.fromEntries(CLOUD_SHADOW_UNIFORMS.map((k) => [k, ENV[k]])) };
    this.farMat = fsMaterial(FAR_FRAG, { ...shared });
    this.uWin = { value: new THREE.Vector4() };
    this.nearMat = fsMaterial(NEAR_FRAG, { ...shared, tHeight: { value: this.heightTex }, tLmFar: { value: this.far.texture }, uWin: this.uWin });
    this.quad = new FullscreenQuad();
    this.slice = 0; this.fresh = true;
    this.sun = new THREE.Vector3(); this.yRef = 0; this.last = new THREE.Vector3(1e9, 0, 0);
    this.enabled = true;
  }

  /** Fill one block of the height map from the finest elevation loaded over it. Returns the zoom used. */
  fillBlock(bi, bj, wx, wz, upload) {
    const x0 = wx * BLOCK * TS, z0 = wz * BLOCK * TS, x1 = x0 + BLOCK * TS, z1 = z0 + BLOCK * TS;
    let z = dem.BASE_Z;
    if (Math.max(Math.abs(x0), Math.abs(x1), Math.abs(z0), Math.abs(z1)) < WORLD_HALF) {
      for (let k = HEIGHT_Z; k > dem.BASE_Z; k--) if (dem.ensure(k, x0, z0, x1, z1, 40 + (HEIGHT_Z - k))) { z = k; break; }
    }
    if (this.blockAt[(bj * NB + bi) * 2] === wx && this.blockAt[(bj * NB + bi) * 2 + 1] === wz && this.blockZoom[bj * NB + bi] === z) return z;
    dem.sampleGrid(z, x0 + TS / 2, z0 + TS / 2, TS, BLOCK, this.scratch, null);
    this.raise?.(x0 + TS / 2, z0 + TS / 2, TS, BLOCK, this.scratch);          // tall buildings stand in the height map too (set by main.js)
    const half = this.type !== THREE.FloatType, s = this.scratch, H = this.H, B = this.blockData;
    for (let j = 0; j < BLOCK; j++) {
      const row = (bj * BLOCK + j) * N + bi * BLOCK;
      for (let i = 0; i < BLOCK; i++) {
        let v = s[j * BLOCK + i]; if (!(v > 0)) v = 0;
        if (half) v = THREE.DataUtils.toHalfFloat(v);
        H[row + i] = v; B[j * BLOCK + i] = v;
      }
    }
    if (upload) { this.blockTex.needsUpdate = true; this.renderer.copyTextureToTexture(this.blockTex, this.heightTex, null, tmpP.set(bi * BLOCK, bj * BLOCK)); }
    this.blockAt[(bj * NB + bi) * 2] = wx; this.blockAt[(bj * NB + bi) * 2 + 1] = wz; this.blockZoom[bj * NB + bi] = z;
    return z;
  }

  /** Bring the height map up to date with the window round world block (cx, cz). Returns true if every block had to be redone. */
  /** The world has moved under the maps (the window went to another part of the country): forget every block
   *  of the near height map, so the next update refills it and bakes both maps afresh. */
  reset() { this.blockAt.fill(1e9); this.blockZoom.fill(-1); this.cb[0] = this.cb[1] = 1e9; this.fresh = true; }

  /** Something that raise() reads has changed (city tiles arrived): have every block refilled, a few a frame. */
  stale() { for (let b = 0; b < this.blockZoom.length; b++) if (this.blockZoom[b] > 0) this.blockZoom[b] = 0; }

  scroll(cx, cz) {
    const mod = (a) => ((a % NB) + NB) % NB;
    const moved = cx !== this.cb[0] || cz !== this.cb[1];
    this.cb[0] = cx; this.cb[1] = cz;
    let stale = 0;
    if (moved) {
      // blocks that now stand for another part of the world
      const todo = [];
      for (let j = -NB / 2; j < NB / 2; j++) for (let i = -NB / 2; i < NB / 2; i++) {
        const wx = cx + i, wz = cz + j, bi = mod(wx), bj = mod(wz), k = (bj * NB + bi) * 2;
        if (this.blockAt[k] !== wx || this.blockAt[k + 1] !== wz) todo.push(bi, bj, wx, wz);
      }
      stale = todo.length / 4;
      const all = stale > 200;                       // a new place: redo the lot and send the texture whole
      for (let k = 0; k < todo.length; k += 4) this.fillBlock(todo[k], todo[k + 1], todo[k + 2], todo[k + 3], !all);
      if (all) { this.heightTex.needsUpdate = true; return true; }
    }
    // a few blocks a frame are looked at again in case finer elevation has arrived since they were filled
    for (let n = 0; n < 12; n++) {
      const b = this.upgrade = (this.upgrade + 1) % (NB * NB);
      if (this.blockZoom[b] >= HEIGHT_Z || this.blockZoom[b] < 0) continue;
      const bi = b % NB, bj = (b / NB) | 0, k = b * 2;
      this.fillBlock(bi, bj, this.blockAt[k], this.blockAt[k + 1], true);
    }
    return false;
  }

  bake(mat, target, y0, rows) {
    target.scissor.set(0, y0, N, rows); target.viewport.set(0, 0, N, N);
    this.quad.draw(this.renderer, mat, target);
  }

  /** Once a frame, before the scene is drawn. cam: the camera's position; ground: the height of the land under it. */
  update(cam, ground = 0) {
    if (!this.enabled) return;
    const r = this.renderer, sun = ENV.uSunDir.value, prev = r.getRenderTarget();
    const span = BLOCK * TS, cx = Math.round(cam.x / span), cz = Math.round(cam.z / span);
    let full = this.fresh || this.scroll(cx, cz);
    // The cloud term is baked for a level near the ground here, so the sideways step to a point's own height is short.
    if (Math.abs(ground - this.yRef) > 150) { this.yRef = Math.round(ground / 100) * 100; full = true; }
    if (this.sun.angleTo(sun) > 0.02 || this.last.distanceTo(cam) > 4000) full = true;
    this.sun.copy(sun); this.last.copy(cam);
    this.uWin.value.set(cx * span, cz * span, VALID, this.yRef);
    ENV.uLmCenter.value.set(cx * span, cz * span);
    ENV.uLmNear.value.w = this.yRef;
    const L = tmpV.copy(sun).multiplyScalar(1 / Math.max(sun.y, CLOUD_L_MIN));
    ENV.uLmSun.value.x = L.x; ENV.uLmSun.value.y = L.z;
    ENV.uLmView.value = ENV.uPixAngle.value;

    const rows = N / SLICES, y0 = full ? 0 : this.slice * rows, n = full ? N : rows;
    perf.begin('ground light bake');
    this.bake(this.farMat, this.far, y0, n);
    this.bake(this.nearMat, this.near, y0, n);
    this.slice = (this.slice + 1) % SLICES; this.fresh = false;
    r.setRenderTarget(prev);
    // The smaller copies of both maps (read for cloud shadow far off) are remade when a round of bands is done.
    if (full || this.slice === 0) {
      const gl = r.getContext();
      for (const t of [this.far, this.near]) { r.state.bindTexture(gl.TEXTURE_2D, r.properties.get(t.texture).__webglTexture); gl.generateMipmap(gl.TEXTURE_2D); }
      r.state.unbindTexture();
    }
    perf.end();
  }

  /** Redo everything on the next update (after the weather is replaced, say). */
  reset() { this.fresh = true; }
}
