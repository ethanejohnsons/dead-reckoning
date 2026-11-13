// Quadtree level-of-detail terrain built from streamed real elevation.
// Each node is a 33x33 vertex patch plus a 129x129 data texture (surface
// normal, curvature, water mask) sampled from elevation tiles at a zoom
// matched to the patch size, so lighting detail is four times finer than the
// geometry. The surface itself (forest, prairie, cropland, sagebrush, rock,
// snow, water) is decided per pixel in the shader from height, slope and
// regional moisture where the satellite picture has not loaded.

import * as THREE from 'three';
import * as dem from './dem.js';
import { metersPerPixel, WORLD_HALF, LAND_HALF } from './geo.js';
import { flatsIn, applyFlats, flatWeight, baseHeight, baseWater, URBAN, REGION_GLSL, REGION_UNIFORMS } from './terrain.js';
import { townsIn, urbanDensity } from './towns.js';
import { mulberry32 } from '../core/noise.js';
import { ENV } from '../core/env.js';
import { Trees } from './trees.js';
import { BUILDING_COVER_UNIFORMS } from './cities.js';
import { GROUND_LIGHT_GLSL, GROUND_LIGHT_UNIFORMS } from './groundlight.js';
import { ATMO_GLSL, ATMO_UNIFORMS } from './atmosphere.js';
import { IMAGERY_GLSL, IMAGERY_UNIFORMS } from './imagery.js';
// Streaming: a patch's data is worked out in a worker (patchbuild.js, through workers.js) and only handed to
// the graphics card here, a few a frame as the shared upload budget allows.
import { moisture, treeline, BN } from './terrain.js';
import { REGION } from './geo.js';
import { DOUBT_Z } from './water.js';
import { N, V, TN, VERTS, buildPatch, buffersOf } from './patchbuild.js';
import { pool } from './workers.js';
import { uploads } from '../render/budget.js';
import { perf } from '../render/perf.js';

const MIN_SIZE = 512, TREE_SIZE = 1024;
const PATCH_BYTES = TN * TN * 4 + VERTS * 8 * 4;       // what one patch sends to the graphics card: its texture layer and its vertices
const LAYERS = 1024;                 // patch data textures live in one texture array, a layer each
// A patch gives way to its four children inside SPLIT sizes of the camera. They are asked for a little earlier
// (AHEAD), so they are usually built by then and can appear in their parent's shape (see geomorphing, above
// VERT); a late arrival is the only pop left. They are let go beyond MERGE.
const SPLIT = 2.3, AHEAD = 2.42, MERGE = 2.7;
// Elevation zoom for a patch: about 64 source pixels across it. Patches up to 8 km take zoom 11 at the least:
// from there down the data is the fine survey, in which every lake of a few acres can be told (water.js);
// the coarser tiles only show the big ones. (Worked out when a patch is made: the scale follows the window of the world.)
const zoomFor = (size) => { const z = Math.max(4, Math.min(dem.MAX_Z, Math.round(Math.log2((metersPerPixel(0) * 64) / size)))); return size <= 8192 ? Math.max(z, 11) : z; };

// The towns' built-up density (the grid towns.placeTowns() returns), which a patch in a town is built from.
// A worker cannot ask towns.js, so a job carries the piece of the grid under its patch; until the game has
// handed the grid over (setUrbanGrid), such patches are built on the main thread instead.
let URBAN_GRID = null;
export function setUrbanGrid(grid) { URBAN_GRID = grid && grid.length === BN * BN ? grid : null; }
function urbanCrop(x0, z0, x1, z1) {
  const g = URBAN_GRID, f = (v) => Math.floor(((v + WORLD_HALF) / (2 * WORLD_HALF)) * (BN - 1));
  const i0 = Math.max(0, Math.min(BN - 2, f(x0) - 1)), i1 = Math.max(i0 + 1, Math.min(BN - 1, f(x1) + 2));
  const j0 = Math.max(0, Math.min(BN - 2, f(z0) - 1)), j1 = Math.max(j0 + 1, Math.min(BN - 1, f(z1) + 2));
  const w = i1 - i0 + 1, h = j1 - j0 + 1, data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) data.set(g.subarray((j0 + j) * BN + i0, (j0 + j) * BN + i0 + w), j * w);
  return { bn: BN, i0, j0, w, data };
}
const nextTurn = (() => {                     // (a timer would do, but a hidden tab's timers run once a second)
  const ch = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null, waiting = [];
  if (ch) ch.port1.onmessage = () => { const w = waiting.shift(); if (w) w(); };
  return () => new Promise((r) => { if (ch) { waiting.push(r); ch.port2.postMessage(0); } else setTimeout(r, 0); });
})();

/** Lighting helpers shared by the terrain and tree shaders. local: terrainShadow() also takes in the shadows of the aircraft and of buildings. */
const lightGlsl = (local) => /* glsl */`
${local ? '#define LOCAL_SHADOW_IN_TERRAIN' : ''}
uniform sampler2D tRegion, tWxA, tWxB, tDetail;
uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround, uCloudDrift;
uniform float uWxHalf, uTime, uTAnom, uWind, uSea, uWet, uSnow, uGroundT;

float regionHeight(vec2 xz) { return max(texture2D(tRegion, xz / (2.0 * uWxHalf) + 0.5).r, 0.0); }

// Mountain shadow, sky occlusion, cloud shadow, the shadows of the aircraft and of buildings: all read from
// maps that are baked or drawn once a frame (world/groundlight.js, world/sunshadow.js).
${GROUND_LIGHT_GLSL}
${ATMO_GLSL}
${IMAGERY_GLSL}`;
const LIGHT_GLSL = lightGlsl(false), LIGHT_GLSL_TREES = lightGlsl(true);     // a tree is lit at one point, so it takes the local shadows there too

// vDist and vLayer are `centroid` varyings: with multisampling a plain varying is extrapolated outside thin,
// edge-on triangles at the horizon, exp(-vDist / k) then overflows, the pixel becomes NaN and bloom
// turned each one into a haloed dot hopping along the horizon when the camera was near the ground.
//
// Geomorphing: a patch does not jump to its parent's coarser shape when the quadtree merges it (or from it when
// it appears). Every vertex also knows the height of the parent's mesh at its place; from 81% of the distance
// at which the parent takes over it eases toward that height, and the patch's data texture (normals, water)
// eases to the parent's with it, so at the moment of the swap the two are the same surface. The distance is
// measured as the quadtree measures it (see Terrain.dist), which is what makes the two agree.
const MORPH_FROM = 0.81, MORPH_TO = 0.98;
const VERT = /* glsl */`
attribute float aLayer;
attribute vec4 aMorph;          // height of the parent's mesh here, the parent's layer, the distance at which the parent takes over (0: never), the parent's middle height
attribute vec2 aUvP;            // this vertex in the parent's data texture
varying vec3 vWorld; varying vec2 vUv, vUvP; centroid varying float vDist, vLayer, vLayerP, vMorph;   // centroid: see the note above VERT
void main() {
  vUv = uv; vLayer = aLayer; vUvP = aUvP; vLayerP = aMorph.y;
  vec3 pos = position;
  vec4 w0 = modelMatrix * vec4(position, 1.0);
  float d = length(vec3(w0.xz - cameraPosition.xz, cameraPosition.y - aMorph.w));
  vMorph = aMorph.z > 0.0 ? smoothstep(${MORPH_FROM} * aMorph.z, ${MORPH_TO} * aMorph.z, d) : 0.0;
  pos.y = mix(position.y, aMorph.x, vMorph);
  vWorld = (modelMatrix * vec4(pos, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray tChunks;
uniform sampler2D tFields;
uniform float uLandHalf;
varying vec3 vWorld; varying vec2 vUv, vUvP; centroid varying float vDist, vLayer, vLayerP, vMorph;   // centroid: see the note above VERT
${LIGHT_GLSL}
${REGION_GLSL}

// How far a color of the picture is hard, bare ground: gray and not dark (roads, roofs, gravel, rock). 0..1.
float hardGround(vec3 c) { float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)); return (1.0 - smoothstep(0.1, 0.3, (mx - mn) / max(mx, 0.004))) * smoothstep(0.03, 0.08, mx); }

void main() {
  vec4 ch = texture(tChunks, vec3(vUv, vLayer));
  if (vMorph > 0.002) ch = mix(ch, texture(tChunks, vec3(vUvP, vLayerP)), vMorph);     // easing to the parent patch (see VERT)
  vec2 nxz = ch.rg * 2.0 - 1.0;
  vec3 N = vec3(nxz.x, sqrt(max(1.0 - dot(nxz, nxz), 0.01)), nxz.y);
  float water = smoothstep(0.35, 0.65, ch.a);
  float h = vWorld.y, slope = 1.0 - N.y;
  vec4 reg = texture2D(tRegion, vWorld.xz / (2.0 * uWxHalf) + 0.5);
  // Blue is how built-up the land is, or (negative) how far out on big open water this is.
  float hReg = max(reg.r, 0.0), moist = reg.g, town = max(reg.b, 0.0), openWater = max(-reg.b, 0.0);

  // Each noise scale is sampled on its own rotated grid so the tiling never lines up into a visible pattern.
  const mat2 R1 = mat2(0.84, 0.54, -0.54, 0.84), R2 = mat2(0.60, -0.80, 0.80, 0.60), R3 = mat2(0.94, 0.34, -0.34, 0.94);
  vec4 d1 = texture2D(tDetail, R1 * vWorld.xz / 19.0);
  vec4 d2 = texture2D(tDetail, R2 * vWorld.xz / 173.0);
  vec4 d3 = texture2D(tDetail, R3 * vWorld.xz / 1470.0);
  vec4 d4 = texture2D(tDetail, vWorld.xz / 11300.0);
  vec4 d0 = texture2D(tDetail, vWorld.xz / 3.3);
  float nearK = exp(-vDist / 700.0), midK = exp(-vDist / 9000.0), closeK = exp(-vDist / 140.0);

  // ---- what grows here (the rules for where no picture has loaded: the interior of North America)
  float tl = treeLine(vWorld.xz) + 90.0 * (d3.r - 0.5);
  float mJ = moist + (d3.g - 0.5) * 0.14 + (d4.r - 0.5) * 0.08;
  // Cropland on level ground wherever there is rain enough, from the corn belt up onto the high plains
  // (thinning out to the odd irrigated field where it is dry), but not in the high valleys of the mountains.
  float farm = (1.0 - smoothstep(0.03, 0.09, slope)) * smoothstep(0.25, 0.42, mJ) * (1.0 - smoothstep(0.66, 0.78, mJ)) * (1.0 - smoothstep(tl - 1500.0, tl - 1100.0, h));
  float forest = smoothstep(0.42, 0.6, mJ) * (1.0 - smoothstep(tl - 100.0, tl + 50.0, h)) * (1.0 - smoothstep(0.38, 0.62, slope)) * (1.0 - 0.9 * farm);
  float alpine = smoothstep(tl - 50.0, tl + 350.0, h);
  // Conifers hold the mountains and much of the north woods; the rest is broadleaf.
  float conifer = clamp(smoothstep(tl - 1700.0, tl - 1100.0, h) + 0.45 * smoothstep(0.7, 0.86, moist), 0.0, 1.0);

  // open ground: gray-green sagebrush steppe where it is dry, tawny short-grass prairie, green pasture and tall grass where it is wet
  vec3 sage = mix(vec3(0.30, 0.27, 0.185), vec3(0.235, 0.22, 0.15), smoothstep(0.3, 0.75, d3.r + (d2.g - 0.5) * 0.3));
  sage = mix(sage, vec3(0.13, 0.15, 0.105), smoothstep(0.52, 0.72, mix(d2.g, d1.g, nearK) + (d3.r - 0.5) * 0.4) * (0.3 + 0.3 * nearK));   // the brush itself
  vec3 prairie = mix(vec3(0.31, 0.29, 0.14), vec3(0.22, 0.24, 0.10), smoothstep(0.35, 0.7, d3.g + (d2.r - 0.5) * 0.3));
  vec3 alb = mix(mix(sage, prairie, smoothstep(0.24, 0.38, mJ)), vec3(0.14, 0.215, 0.07), smoothstep(0.42, 0.72, mJ));
  alb = mix(alb, vec3(0.26, 0.245, 0.14), alpine * 0.8);          // tundra
  alb *= (0.84 + 0.32 * d2.r) * mix(1.0, 0.7 + 0.6 * d0.g, closeK);
  // cropland: square fields on the section lines, a mile to the side
  vec3 fields = texture2D(tFields, vWorld.xz / 6437.4 + d4.rg * 0.003).rgb;
  fields = mix(fields, dot(fields, vec3(0.33)) * vec3(1.25, 1.12, 0.72), smoothstep(0.46, 0.3, mJ) * 0.6);   // drier country: wheat, fallow and stubble
  alb = mix(alb, fields * (0.85 + 0.3 * d2.g), farm * (0.55 + 0.45 * midK));
  // woods: mixed hardwoods, darker and bluer where the conifers take over
  vec3 woods = mix(mix(vec3(0.040, 0.078, 0.026), vec3(0.060, 0.098, 0.030), d3.r), mix(vec3(0.024, 0.047, 0.027), vec3(0.036, 0.062, 0.030), d3.r), conifer) * (0.7 + 0.6 * mix(d2.g, d1.g, nearK));
  alb = mix(alb, woods, forest * (1.0 - 0.7 * town));
  // towns: a mosaic of roofs, roads and gardens
  vec3 blocks = texture2D(tFields, R2 * vWorld.xz / 610.0).rgb;
  float roofs = mix(d1.g, d0.r, closeK);                       // fine speckle only up close, so it never reads as a grid
  vec3 urban = mix(vec3(0.20, 0.20, 0.205), vec3(0.30, 0.27, 0.24), d1.r) * (0.78 + 0.44 * roofs);
  urban = mix(urban, blocks * 0.75, 0.35 * smoothstep(0.45, 0.6, d2.g));
  urban = mix(urban, vec3(0.07, 0.11, 0.05), smoothstep(0.62, 0.75, d2.r) * 0.6);   // gardens and street trees
  alb = mix(alb, urban, smoothstep(0.25, 0.7, town + (d2.r - 0.5) * 0.5) * 0.85 * (1.0 - smoothstep(0.25, 0.5, slope)));
  // rock and scree
  float rock = max(smoothstep(0.3, 0.55, slope + (d2.r - 0.5) * 0.12), smoothstep(tl + 250.0, tl + 700.0, h + (d3.g - 0.5) * 300.0) * 0.85);
  // Cliffs: banded strata and gullies run down the face, so sample noise against height as well as plan position.
  vec2 face = vec2(dot(vWorld.xz, vec2(0.71, 0.71)), vWorld.y);
  vec4 s1 = texture2D(tDetail, face / vec2(260.0, 38.0)), s2 = texture2D(tDetail, face / vec2(31.0, 190.0));
  float strata = mix(0.5, s1.r * 0.6 + s2.g * 0.4, smoothstep(0.25, 0.6, slope));
  vec3 stone = mix(vec3(0.20, 0.20, 0.205), vec3(0.27, 0.235, 0.19), smoothstep(0.4, 0.7, d4.g)) * (0.55 + 0.5 * mix(d2.r, d1.r, nearK) + 0.55 * strata);
  stone = mix(stone, stone * vec3(0.8, 0.86, 0.72), forest * 0.6);            // mossy faces in the wet woods
  alb = mix(alb, stone, rock);
  // gravel and sand at the water's edge
  float shore = (1.0 - smoothstep(0.6, 3.5, h - 0.2)) * (1.0 - smoothstep(0.05, 0.2, slope));
  alb = mix(alb, vec3(0.33, 0.32, 0.30) * (0.8 + 0.4 * d1.r), shore * (1.0 - forest));
  // Snow. The regional map carries the level it lies above on an ordinary day (see snowLine), lower on the faces
  // turned from the sun. Two kinds: the standing snow of the high mountains, whose line climbs on a warm day; and
  // what the weather has laid down. Cold air alone whitens nothing: the snow itself has to fall (uSnow, the pack
  // around the aircraft; where it rains on the low ground the same weather is taken to be snowing on the heights
  // well above the freezing level). The air's temperature, which the same map gives (150 m a degree), only says
  // where the pack can lie: on ground as cold as where it was measured (uGroundT), not on ground more than a few
  // degrees warmer, the valley under a snowy pass. Fallen, it stays until the weather melts it: the pack decides
  // when the ground turns white and when it clears, not the thermometer. A light fall settles in patches first
  // and lets the ground show through; melting, it goes gray and sodden before it goes.
  float hSnow = h + (d3.r - 0.5) * 420.0 + (d2.r - 0.5) * 130.0 - (reg.a - 260.0 * (-N.z * uRegion.z));
  float steep = 1.0 - 0.85 * smoothstep(0.5, 0.82, slope);
  float standing = smoothstep(-130.0, 170.0, hSnow - max(uTAnom, 0.0) * 150.0) * steep;
  // (Where the ground is frozen, two degrees under and colder, it is not wet either.)
  float hToday = hSnow - uTAnom * 150.0, wetNow = uWet * (1.0 - 0.85 * smoothstep(350.0, 650.0, hToday));
  float fall = max(uSnow * (1.0 - smoothstep(2.0, 7.0, 2.2 - hToday / 150.0 - max(uGroundT, 1.8))), 0.8 * uWet * smoothstep(100.0, 400.0, hToday));
  // (the first tenth of a full pack is a patchy dusting, by four tenths the ground is covered: the same rule as the airfields' pavement)
  float fresh = smoothstep(0.0, 1.0, (fall * 3.5 - (0.5 * d1.r + 0.3 * d2.g + 0.2 * d0.r)) * 2.0) * mix(0.55, 1.0, smoothstep(0.1, 0.45, fall)) * steep;
  float slush = wetNow * (1.0 - smoothstep(0.2, 0.6, fall)) * (1.0 - standing);
  fresh *= 1.0 - 0.35 * slush;
  float snow = max(standing, fresh);
  vec3 snowCol = mix(vec3(0.86, 0.89, 0.93), vec3(0.72, 0.82, 0.90), smoothstep(0.55, 0.8, d3.g) * (1.0 - smoothstep(0.1, 0.3, slope)));
  snowCol = mix(snowCol, vec3(0.40, 0.42, 0.45), 0.7 * slush);

  // ---- the real thing: satellite imagery where it has loaded, the rules above everywhere else
  // (filtered along the line of sight, level blended into level, each tile fading in as it arrives: world/imagery.js)
  vec2 imGx = dFdx(vWorld.xz), imGy = dFdy(vWorld.xz);
  vec4 im = imageryView(vWorld.xz, imGx, imGy);
  if (im.a > 0.004) {
    vec3 ph = im.rgb;
    // Near the aircraft the aerial survey is worked into it: the survey's detail (a factor: roofs, roads, furrows,
    // the crowns of trees) over the satellite's color, so the tone stays one from the nose to the horizon. The
    // survey's own shadows are hard and fall its own way: they are let through at about two thirds strength.
    vec4 det = imageryDetail(vWorld.xz, imGx, imGy);
    vec3 dt = vec3(1.0);
    if (det.a > 0.004) {
      dt = clamp(det.rgb, 0.2, 3.0);
      dt = sqrt(mix(vec3(1.0), mix(dt, pow(dt, vec3(0.66)), step(dt, vec3(1.0))), det.a));     // (the root: half goes on before the shoulder below, half after)
      ph = mix(ph, imageryLow(vWorld.xz, ph), det.a);
    }
    // A photograph has the light of its own day baked in (late-morning sun, from the south in the northern
    // hemisphere): take some of it back out.
    float lum = dot(ph, vec3(0.3, 0.55, 0.15));
    // Its shadows are deep blue. The sun here casts its own, so on slopes lift them back toward lit ground
    // (flat blue ground is a river or a tarn, and stays).
    float shade = smoothstep(0.03, 0.25, (ph.b - max(ph.r, ph.g)) / max(ph.b, 0.004)) * (1.0 - smoothstep(0.22, 0.45, lum)) * smoothstep(0.04, 0.16, slope);
    ph = mix(ph, mix(vec3(1.10, 1.0, 0.84), vec3(0.45, 0.8, 0.35), forest) * (lum * 1.6 + 0.012), shade * 0.85);   // shaded woods lifts toward green, not gray
    float baked = max(dot(N, normalize(vec3(0.25, 0.72, 0.64 * uRegion.z))), 0.0);
    vec3 photo = ph * dt * 2.9 / mix(1.0, 0.42 + 0.85 * baked, 0.55);
    // Shoulder. The satellite mosaic is stretched bright (a town center comes out near white): bare ground, roofs and
    // concrete are brought down to what they reflect, and only what is as bright as snow is let back up, below white.
    photo = photo / (1.0 + 1.45 * photo) * (1.0 + 0.55 * smoothstep(1.6, 2.9, dot(photo, vec3(0.3, 0.55, 0.15)))) * dt;
    // Ten meters a pixel goes soft up close: carry the procedural texture over it there, strata on the rock faces.
    // Two detail scales on differently rotated grids, faded out on steep faces where a plan-view texture smears.
    float faceK = smoothstep(0.25, 0.5, slope);
    float fine = mix(d1.r, texture2D(tDetail, R3 * vWorld.xz / 71.0).g, smoothstep(250.0, 900.0, vDist));
    float amp = mix(0.52, 0.86, nearK);                           // stronger grain close to the ground, where the photo is softest
    // (where the survey has given real detail the invented grain steps back, and the finest of it, all finer than
    // the survey's own meter, reaches further out instead: it is what the last few hundred meters are made of)
    // (two grids of it, turned against each other, so that at a few hundred meters it does not read as a weave)
    float grit = mix(d0.g, 0.5 * (d0.g + texture2D(tDetail, R2 * vWorld.xz / 7.3).r), det.a);
    photo *= mix(1.0, 1.0 - 0.5 * amp + amp * fine, exp(-vDist / 2200.0) * (1.0 - 0.8 * faceK) * (1.0 - 0.7 * det.a)) * mix(1.0, 0.66 + 0.68 * grit, max(closeK, det.a * exp(-vDist / 260.0)));
    photo *= mix(1.0, 0.72 + 0.56 * strata, faceK * midK);
    // Under the trees the ground is in their shade: darken woodland in the picture out to where the trees end.
    float woodsP = smoothstep(0.05, 0.024, dot(im.rgb, vec3(0.3, 0.55, 0.15))) * step(im.r, im.g * 1.1) * step(im.b, im.g * 1.15);
    photo *= mix(1.0, 0.6, woodsP * (1.0 - smoothstep(3500.0, 9000.0, vDist)));
    // Its own snow and ice are already in the picture; only add what the weather has laid down. The country still
    // shows through it: roads are cleared and driven gray, and what was dark in the picture (woods, most of all past
    // where the trees themselves are drawn) stays darker than the open fields.
    float lumP = dot(im.rgb, vec3(0.3, 0.55, 0.15)), hardP = hardGround(im.rgb);
    vec3 photoSnow = mix(photo, snowCol * (1.0 - 0.3 * hardP), fresh * mix(0.5, 1.0, smoothstep(0.02, 0.06, lumP)) * (1.0 - 0.5 * hardP));
    alb = mix(mix(alb, snowCol, snow), photoSnow, im.a);     // im.a: an arriving tile fades in over the rules
  } else alb = mix(alb, snowCol, snow);

  // Wet ground is darker and its color deeper. hard is what takes a sheen when wet: rock, and in the picture
  // whatever is gray and not dark (roads, roofs, gravel, bare rock).
  float wetG = wetNow * (1.0 - snow), hard = im.a > 0.5 ? max(rock, hardGround(im.rgb)) : rock;
  if (wetG > 0.004) alb = mix(vec3(dot(alb, vec3(0.3, 0.55, 0.15))), alb, 1.0 + 0.22 * wetG) * mix(1.0, mix(0.8, 0.62, hard), wetG);

  // ---- surface detail and light
  float bump = mix(mix(0.45, 0.9, forest), 1.25, rock) * (1.0 - 0.75 * snow);
  vec2 dn = ((d0.ba - 0.5) * 1.1 * closeK + ((d1.ba - 0.5) * R1) * 1.3 * nearK + ((d2.ba - 0.5) * R2) * 0.9 * midK + ((d3.ba - 0.5) * R3) * 0.3) * bump;
  vec3 Nd = normalize(N + vec3(dn.x, 0.0, dn.y));
  vec3 L = uSunDir;
  vec2 gLit = terrainLight(vWorld, hReg);                      // mountain shadow, sky occlusion
  // (the trees' shade: nine tenths of the sun where a crown stands in its way; with no sun to speak of, the patch of gloom under each crown)
  float trees = treeShade(vWorld, imGx, imGy);
  float shadow = gLit.x * localShadow(vWorld) * (1.0 - 0.9 * cloudShadow(vWorld)) * (1.0 - 0.9 * trees);
  float ao = (1.0 - 0.5 * gLit.y) * clamp(0.62 + 0.76 * ch.b, 0.55, 1.15) * (1.0 - 0.21 * trees * uTreeShadeP.y);
  float ndl = max(dot(Nd, L), 0.0);
  vec3 amb = skyIrradiance(Nd) * ao;
  vec3 col = alb * (uSunCol * ndl * shadow + amb + localLight(vWorld, Nd));
  // snow sparkles and sheen
  vec3 Vv = normalize(cameraPosition - vWorld);
  col += snow * uSunCol * shadow * pow(max(dot(reflect(-L, Nd), Vv), 0.0), 24.0) * 0.18;
  // the sheen of wet roads and rock: the sky mirrored at a low angle, and the sun's glint
  float sheen = wetG * mix(0.1, 0.8, hard);
  if (sheen > 0.02) {
    float fr = pow(1.0 - max(dot(Nd, Vv), 0.0), 5.0);
    vec3 Rw = reflect(-Vv, Nd); Rw.y = abs(Rw.y);
    float F = (0.02 + 0.6 * fr) * sheen;
    col = col * (1.0 - F) + skyRadiance(Rw) * F + uSunCol * (shadow * sheen * pow(max(dot(reflect(-L, Nd), Vv), 0.0), 60.0) * 0.5);
  }

  // ---- water
  if (water > 0.01) {
    float wind = clamp(uWind / 14.0, 0.06, 1.0);
    // Three wave trains on differently rotated grids, so no ripple pattern lines up with the view.
    const mat2 W1 = mat2(0.89, 0.45, -0.45, 0.89), W2 = mat2(0.75, -0.66, 0.66, 0.75), W3 = mat2(0.45, 0.89, -0.89, 0.45);
    vec2 w1 = (texture2D(tDetail, W1 * vWorld.xz / 37.0 + uTime * vec2(0.021, 0.013)).ba - 0.5) * W1;
    vec2 w2 = (texture2D(tDetail, W2 * vWorld.xz / 11.0 - uTime * vec2(0.034, 0.027)).ba - 0.5) * W2;
    vec2 w3 = (texture2D(tDetail, W3 * vWorld.xz / 210.0 + uTime * vec2(0.006, -0.004)).ba - 0.5) * W3;
    float fade = exp(-vDist / 3500.0);
    // Lakes are sheltered: smaller ripples and almost no swell. Not so the Great Lakes, well out from the shore.
    float lake = smoothstep(1.0, 4.0, h), lakeK = lake * (1.0 - 0.85 * openWater);
    // Heavy weather on open water (the sea, a Great Lake well out from the shore; less of it on a small lake): long
    // seas with their crests across the wind, which still read from far off, and the short chop standing up on them.
    float rough = uSea * (1.0 - 0.6 * lakeK);
    vec2 wq = W1 * vWorld.xz;
    vec4 s4 = texture2D(tDetail, wq * vec2(1.0 / 70.0, 1.0 / 112.0) + uTime * vec2(0.085, 0.004));
    vec2 w4 = ((s4.ba - 0.5) * vec2(1.0, 0.62)) * W1;
    vec2 wxz = (w1 + w2 * 0.6) * (0.2 + 1.0 * wind + 0.8 * rough) * fade * (1.0 - 0.45 * lakeK) + w3 * (0.03 + 0.24 * wind + 0.3 * rough) * (1.0 - 0.8 * lakeK)
      + w4 * (1.1 * rough * exp(-vDist / 12000.0));
    vec3 wn = normalize(vec3(wxz.x, 1.0, wxz.y));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(Vv, wn), 0.0), 5.0);
    vec3 R = reflect(-Vv, wn); R.y = abs(R.y);
    vec3 refl = skyRadiance(R);
    float depth = mix(max(-reg.r, 0.0), 40.0, lake);
    vec3 sea = mix(vec3(0.045, 0.19, 0.20), vec3(0.008, 0.035, 0.07), 1.0 - exp(-depth / 14.0));
    vec3 lakeC = mix(vec3(0.014, 0.045, 0.062), vec3(0.016, 0.075, 0.10), openWater);                    // dark inland water, bluer out on the big lakes
    // The picture lends the water its color near the shore (shallows, silt); well out on a big lake the mosaic of
    // satellite passes shows its seams, so there the water keeps its own color.
    vec3 body = mix(mix(sea, lakeC, lake), im.rgb * 3.2, 0.6 * im.a * (1.0 - 0.9 * openWater)) * (uSunCol * max(L.y, 0.0) * shadow * 0.75 + mix(uAmbGround, uAmbSky, 0.85) * 1.2);
    // Storm water is darker and grayer, lit along its crests and dark in its troughs.
    body = mix(body, vec3(dot(body, vec3(0.3, 0.55, 0.15))) * vec3(0.86, 1.0, 0.96), 0.4 * rough) * (1.0 - 0.2 * rough);
    body *= 1.0 + (s4.r - 0.5) * 1.6 * rough * exp(-vDist / 8000.0);
    // Whitecaps. Each is a stretch of one contour of a smooth, drifting field, on the side that faces down the
    // wind: a thin curved crest with a lace of foam left behind it, where the long seas and the gusts stand highest.
    // The crests move through that mask, so they form, run a while and die. (A threshold on stretched noise drew
    // them in the rows and columns of its lattice.) Past the range where one can be told from the next they become
    // their average, so far water pales a little instead of losing its white.
    float caps = 0.0;
    if (rough > 0.12) {
      float whK = smoothstep(0.12, 0.95, rough);
      vec2 cu = wq * vec2(1.0 / 40.0, 1.0 / 62.0) + (s4.rg - 0.5) * 0.1 + uTime * vec2(0.11, 0.008);
      vec4 cf = texture2D(tDetail, cu, 2.5);
      float grp = texture2D(tDetail, W3 * vWorld.xz / 420.0 + uTime * vec2(0.004, 0.002)).r;
      float cd = cf.r - 0.62;
      float crest = 1.0 - smoothstep(0.015, 0.038, abs(cd));
      float trail = step(0.0, cd) * (1.0 - smoothstep(0.0, 0.13, cd)) * smoothstep(0.35, 0.65, texture2D(tDetail, cu * 5.3 + 0.31).g);
      float mth = mix(0.78, 0.44, whK);
      float near = max(crest, 0.6 * trail) * smoothstep(0.001, 0.012, 0.5 - cf.b) * smoothstep(mth, mth + 0.18, 0.6 * s4.r + 0.4 * grp);
      float far = mix(0.006, 0.05, whK) * (0.3 + 1.4 * grp);
      caps = mix(far, near, 1.0 - smoothstep(0.012, 0.05, sqrt(fwidth(cu.x) * fwidth(cu.y))));
    }
    // Surf breaks on the sea's edge and, in a wind, on the shores of the great lakes; never on a river bank or
    // around a pond. (Drawn wherever the water mask was partial, it traced the mask's own texels along sheltered
    // banks as a line of pale dashes.)
    float surfK = max(1.0 - lake, smoothstep(0.08, 0.5, openWater) * smoothstep(3.0, 10.0, uWind));
    float surf = surfK < 0.01 ? 0.0 : surfK * smoothstep(0.35, 0.5, ch.a) * (1.0 - smoothstep(0.55, 0.95, ch.a)) * smoothstep(0.35, 0.6, d1.g + 0.5 * (texture2D(tDetail, R2 * vWorld.xz / 140.0 + uTime * vec2(0.008, 0.005)).r - 0.5));
    float spec = pow(max(dot(R, uSkySun), 0.0), mix(1400.0, 160.0, wind)) * shadow * step(0.0, uSkySun.y);
    vec3 wcol = body * (1.0 - fres) + refl * fres + uSunCol * spec * 14.0;
    wcol = mix(wcol, vec3(0.8, 0.84, 0.86) * (uSunCol * max(L.y, 0.0) * shadow + amb), clamp(caps + surf, 0.0, 1.0) * 0.8);
    col = mix(col, wcol, water);
  }

  // Alpha tags the surface for post-processing: 1 = land, 0.25 = open water (reflective).
  gl_FragColor = vec4(applyAtmosphere(col, cameraPosition, vWorld), 1.0 - 0.75 * water);
}`;

const SHARED = ['uSunDir', 'uSunCol', 'uAmbSky', 'uAmbGround', 'uCloudDrift', 'uWxHalf', 'uTime', 'uTAnom', 'uWind', 'uSea', 'uWet', 'uSnow', 'uGroundT',
  'tRegion', 'tWxA', 'tWxB', 'tDetail', ...ATMO_UNIFORMS, ...IMAGERY_UNIFORMS, ...GROUND_LIGHT_UNIFORMS, ...REGION_UNIFORMS, ...BUILDING_COVER_UNIFORMS];
const sharedUniforms = () => Object.fromEntries(SHARED.map((k) => [k, ENV[k]]));

/** Tiling noise: r, g = two fractal value-noise fields; b, a = the slope of the first (a detail normal). */
function makeDetailTexture() {
  const S = 512, f = [new Float32Array(S * S), new Float32Array(S * S)];
  for (let c = 0; c < 2; c++) {
    let amp = 0.5, norm = 0;
    for (const freq of [4, 8, 16, 32, 64, 128]) {
      const r = mulberry32(100 + c * 17 + freq), g = new Float32Array(freq * freq);
      for (let i = 0; i < g.length; i++) g[i] = r();
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const fx = (x / S) * freq, fy = (y / S) * freq, ix = Math.floor(fx), iy = Math.floor(fy);
        let u = fx - ix, v = fy - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
        const a = g[(iy % freq) * freq + (ix % freq)], b = g[(iy % freq) * freq + ((ix + 1) % freq)];
        const cc = g[((iy + 1) % freq) * freq + (ix % freq)], d = g[((iy + 1) % freq) * freq + ((ix + 1) % freq)];
        f[c][y * S + x] += amp * ((a + (b - a) * u) * (1 - v) + (cc + (d - cc) * u) * v);
      }
      norm += amp; amp *= 0.55;
    }
    for (let i = 0; i < S * S; i++) f[c][i] /= norm;
  }
  // Stretch contrast so the fields use the full range.
  for (const a of f) { let lo = 1, hi = 0; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / (hi - lo); }
  const data = new Uint8Array(S * S * 4), h = f[0];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const k = y * S + x, o = k * 4;
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)], dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
    data[o] = h[k] * 255; data[o + 1] = f[1][k] * 255;
    data[o + 2] = Math.max(0, Math.min(255, 127.5 - dx * 900)); data[o + 3] = Math.max(0, Math.min(255, 127.5 - dy * 900));
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

/**
 * A tiling patchwork of Midwestern cropland, four miles to the side: square sections split into quarters and
 * strips, in corn and soybean greens, small grain, hay and bare earth, with farmsteads, section roads and the
 * odd center-pivot circle.
 */
function makeFieldsTexture() {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), r = mulberry32(77), mile = S / 4;
  const palette = ['#3f6a2c', '#4a7631', '#557f35', '#3a6229', '#628a3b', '#6f8f40', '#8c9a4c', '#a8a25a', '#b9ad68', '#7a6a48', '#8d7a55', '#4f7a34', '#5b8438', '#9aa052'];
  const field = (x, y, w, h) => {
    g.fillStyle = palette[Math.floor(r() * palette.length)];
    g.fillRect(x, y, w + 1, h + 1);
    if (r() < 0.5) {                                             // rows, swaths and tramlines
      g.globalAlpha = 0.09; g.fillStyle = r() < 0.5 ? '#000' : '#fff';
      const horiz = r() < 0.5, n = 6 + Math.floor(r() * 14);
      for (let i = 0; i < n; i += 2) horiz ? g.fillRect(x, y + (h * i) / n, w, h / n) : g.fillRect(x + (w * i) / n, y, w / n, h);
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(40,50,25,0.3)'; g.lineWidth = 1; g.strokeRect(x, y, w, h);
  };
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const x0 = sx * mile, y0 = sy * mile, q = mile / 2;
    for (let qy = 0; qy < 2; qy++) for (let qx = 0; qx < 2; qx++) {
      const x = x0 + qx * q, y = y0 + qy * q, k = r();
      if (k < 0.4) field(x, y, q, q);                                                     // a quarter section whole
      else if (k < 0.7) { const t = r() < 0.5; field(x, y, t ? q / 2 : q, t ? q : q / 2); field(t ? x + q / 2 : x, t ? y : y + q / 2, t ? q / 2 : q, t ? q : q / 2); }   // halved
      else if (k < 0.9) { const n = 2 + Math.floor(r() * 3), t = r() < 0.5; for (let i = 0; i < n; i++) t ? field(x + (q * i) / n, y, q / n, q) : field(x, y + (q * i) / n, q, q / n); }   // strips
      else {                                                                               // a pivot circle in its square
        field(x, y, q, q);
        g.fillStyle = palette[Math.floor(r() * 6)]; g.beginPath(); g.arc(x + q / 2, y + q / 2, q * 0.47, 0, 7); g.fill();
        g.strokeStyle = 'rgba(30,45,20,0.35)'; g.beginPath(); g.moveTo(x + q / 2, y + q / 2); const a = r() * 7; g.lineTo(x + q / 2 + Math.cos(a) * q * 0.47, y + q / 2 + Math.sin(a) * q * 0.47); g.stroke();
      }
      if (r() < 0.3) { g.fillStyle = 'rgba(22,44,20,0.9)'; const fx = x + 3 + r() * 8, fy = y + 3 + r() * 8; g.fillRect(fx, fy, 6 + r() * 5, 5 + r() * 5); g.fillStyle = 'rgba(190,185,170,0.9)'; g.fillRect(fx + 2, fy + 2, 2, 2); }   // a farmstead in its grove
    }
  }
  g.strokeStyle = 'rgba(150,140,115,0.75)'; g.lineWidth = 1.2;                           // gravel roads on the section lines
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * mile, 0); g.lineTo(i * mile, S); g.moveTo(0, i * mile); g.lineTo(S, i * mile); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

function makeIndex() {
  const idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * V + i, b = a + V, c = a + 1, d = b + 1;
    idx.push(a, b, c, c, b, d);
  }
  const edge = [(k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N];
  for (let e = 0; e < 4; e++) for (let k = 0; k < N; k++) {
    const a = edge[e](k), b = edge[e](k + 1), sa = V * V + e * V + k, sb = sa + 1;
    idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
  }
  return new THREE.BufferAttribute(new Uint16Array(idx), 1);
}
function makeUv() {
  const uv = new Float32Array((V * V + 4 * V) * 2), edge = [(k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N];
  // Texel centers sit exactly on the patch lattice, so neighboring patches agree along their shared edge.
  const tc = (t) => (t * (TN - 1) + 0.5) / TN;
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) { uv[(j * V + i) * 2] = tc(i / N); uv[(j * V + i) * 2 + 1] = tc(j / N); }
  for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) { const s = edge[e](k) * 2, d = (V * V + e * V + k) * 2; uv[d] = uv[s]; uv[d + 1] = uv[s + 1]; }
  return new THREE.BufferAttribute(uv, 2);
}

/** Where a patch's vertices lie in its parent's data texture, for the quarter (qx, qz) of the parent it covers. */
function makeUvParent(qx, qz) {
  const uv = new Float32Array((V * V + 4 * V) * 2), edge = [(k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N];
  const tc = (t) => (t * (TN - 1) + 0.5) / TN;
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) { uv[(j * V + i) * 2] = tc((qx + i / N) / 2); uv[(j * V + i) * 2 + 1] = tc((qz + j / N) / 2); }
  for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) { const s = edge[e](k) * 2, d = (V * V + e * V + k) * 2; uv[d] = uv[s]; uv[d + 1] = uv[s + 1]; }
  return new THREE.BufferAttribute(uv, 2);
}

class Node {
  constructor(x0, z0, size, parent = null, quarter = 0) {
    this.x0 = x0; this.z0 = z0; this.size = size; this.zoom = zoomFor(size);
    this.parent = parent; this.quarter = quarter;      // quarter of the parent: 1 = east half, 2 = south half
    this.mesh = null; this.trees = null; this.children = null;
    this.queued = false; this.midY = 0; this.prio = 0;
    this.job = null;                                   // its build, while that is with a worker or waiting to be shown: { canceled, result }
  }
}

export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    ENV.tDetail.value = makeDetailTexture();
    this.atlas = new THREE.DataArrayTexture(new Uint8Array(TN * TN * 4 * LAYERS), TN, TN, LAYERS);
    this.atlas.format = THREE.RGBAFormat; this.atlas.minFilter = this.atlas.magFilter = THREE.LinearFilter; this.atlas.needsUpdate = true;
    this.free = Array.from({ length: LAYERS }, (_, i) => LAYERS - 1 - i);
    const defines = { SHADOW_STEPS: 10, SHADOW_GROWTH: '1.65' };
    this.material = new THREE.ShaderMaterial({
      defines: { ...defines },
      uniforms: { ...sharedUniforms(), tChunks: { value: this.atlas }, tFields: { value: makeFieldsTexture() }, uLandHalf: { value: LAND_HALF } },
      vertexShader: VERT, fragmentShader: FRAG,
    });
    this.trees = new Trees(this.group, LIGHT_GLSL_TREES + REGION_GLSL, sharedUniforms, defines);
    this.index = makeIndex(); this.uv = makeUv(); this.uvParent = [0, 1, 2, 3].map((q) => makeUvParent(q & 1, q >> 1));
    this.queue = []; this.shown = []; this.chunkCount = 0;
    this.done = []; this.flying = 0; this.nudge = null;       // builds come back from the workers; in flight; who to tell
    this.pool = pool;                                         // (for the debug tools)
    this.stats = { sent: 0, dropped: 0, shown: 0 };            // patches sent to the workers; answers dropped because the camera had moved on; patches shown
    // Geometry that has just been made is sent to the graphics card on the next frame whether or not it is in
    // view yet: a mesh of it sits in this group for that one frame, with a material that draws nothing
    // (three.js uploads a mesh's buffers as it walks the scene). So uploads follow the budget, not the camera.
    this.fresh = new THREE.Group(); this.group.add(this.fresh);
    this.freshMat = new THREE.MeshBasicMaterial({ visible: false });
    this.trees.upload = (g) => this.upload(g);
    this.trees.urbanCrop = (x0, z0, x1, z1) => (URBAN_GRID ? urbanCrop(x0, z0, x1, z1) : null);
    perf.tag(this.material, 'terrain');
    this.root = null; this.apron = null;
    // Two flat layers for the ground beyond the edge of the world: one of land, one of water.
    this.apronLayers = [this.free.pop(), this.free.pop()];
    this.apronLayers.forEach((layer, water) => {
      const tex = this.atlas.image.data.subarray(layer * TN * TN * 4, (layer + 1) * TN * TN * 4);
      for (let o = 0; o < TN * TN * 4; o += 4) { tex[o] = tex[o + 1] = tex[o + 2] = 127.5; tex[o + 3] = water ? 255 : 0; }
      this.atlas.addLayerUpdate(layer);
    });
  }

  /** Let go of every patch (and its trees): the window of the world is about to move. Call init() again afterward. */
  reset() {
    if (this.root) this.dispose(this.root);              // (cancels what the workers still have of it)
    this.root = null; this.queue.length = 0; this.shown.length = 0; this.done.length = 0;
    this.fresh.clear();
    pool.forget();
    this.trees?.reset();
    if (this.apron) { this.group.remove(this.apron); this.apron.geometry.dispose(); this.apron = null; }
  }

  /**
   * The world is a square window; past its edge the ground carries on at the level it had there, out to
   * where the haze takes it, so the land never ends in a cliff. A ring of plain quads, land or water as
   * the edge was.
   */
  buildApron() {
    const H = WORLD_HALF, n = 48, ring = [], pos = [], uv = [], lay = [];
    for (let k = 0; k < n; k++) ring.push([-H + (2 * H * k) / n, -H]);
    for (let k = 0; k < n; k++) ring.push([H, -H + (2 * H * k) / n]);
    for (let k = 0; k < n; k++) ring.push([H - (2 * H * k) / n, H]);
    for (let k = 0; k < n; k++) ring.push([-H, H - (2 * H * k) / n]);
    const inset = (p) => [p[0] * 0.999, p[1] * 0.999], y = (p) => Math.max(baseHeight(...inset(p)), 0), far = 2.4;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length], ya = y(a), yb = y(b), m = inset([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const layer = this.apronLayers[baseWater(m[0], m[1]) ? 1 : 0];
      // inner edge a little under the terrain's own edge (its skirt covers the join), outer edge far away
      pos.push(a[0], ya - 3, a[1], a[0] * far, ya - 3, a[1] * far, b[0], yb - 3, b[1], b[0], yb - 3, b[1], a[0] * far, ya - 3, a[1] * far, b[0] * far, yb - 3, b[1] * far);
      for (let v = 0; v < 6; v++) { uv.push(0.5, 0.5); lay.push(layer); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aLayer', new THREE.BufferAttribute(new Float32Array(lay), 1));
    this.apron = new THREE.Mesh(g, this.material);
    this.apron.frustumCulled = false; this.apron.matrixAutoUpdate = false;
    this.group.add(this.apron);
  }

  /** 'low' trims the per-pixel shadow march and sky-occlusion taps for slower graphics cards; the trees scale with it too. */
  setQuality(level) {
    const m = this.material;
    if (level === 'low') Object.assign(m.defines, { SHADOW_STEPS: 6, SHADOW_GROWTH: '2.3', LOWQ: 1 });
    else { Object.assign(m.defines, { SHADOW_STEPS: 10, SHADOW_GROWTH: '1.65' }); delete m.defines.LOWQ; }
    m.needsUpdate = true;
    this.trees.setQuality(level);
  }

  /** Load the coarse zoom levels for the whole window of the world, then build the root patch. (Again after reset().) */
  async init() {
    const H = WORLD_HALF;
    this.reset();
    const root = new Node(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2);
    await Promise.all([4, 5, 6, 7].map((z) => dem.loadArea(z, -H, -H, H, H, 0)));
    this.build(root);
    this.root = root;
    this.buildApron();
  }

  ready(node, prio) {
    const m = (node.size / (TN - 1)) * 2, x0 = node.x0 - m, z0 = node.z0 - m, x1 = node.x0 + node.size + m, z1 = node.z0 + node.size + m;
    // In a town the water of a fine patch is checked against the zoom where holes in the survey can be told from lakes.
    const doubt = node.zoom < 11 || !townsIn(node.x0, node.z0, node.x0 + node.size, node.z0 + node.size) || dem.wantDoubt(x0, z0, x1, z1, prio);
    return dem.ensure(node.zoom, x0, z0, x1, z1, prio) && doubt;
  }

  /**
   * Everything a patch is built from, gathered for patchbuild.buildPatch: the elevation under it, the airfields
   * and town that touch it, its parent's heights. Cheap (copies of a few tens of kilobytes). The node must
   * have its layer of the data texture already.
   */
  prepare(node) {
    const { x0, z0, size, zoom } = node, step = size / (TN - 1), par = node.parent;
    const xa = x0 - step, za = z0 - step, xb = x0 + size + step, zb = z0 + size + step;
    const town = townsIn(x0, z0, x0 + size, z0 + size), towny = zoom >= 11 && town, trees = size === TREE_SIZE;
    const job = {
      x0, z0, size, zoom, region: [REGION.lat0, REGION.lon0], layer: node.layer, quarter: node.quarter,
      win: dem.cut(zoom, xa, za, xb, zb),
      flats: flatsIn(xa, za, xb, zb),
      towny, doubt: towny ? dem.cut(DOUBT_Z, xa, za, xb, zb, false) : null,
      urban: !(towny || (trees && town)) ? null : URBAN_GRID ? urbanCrop(xa, za, xb, zb) : { fn: urbanDensity },
      parent: null,
      trees: trees ? { P: this.trees.layout, m: [moisture(x0, z0), moisture(x0 + size, z0), moisture(x0, z0 + size), moisture(x0 + size, z0 + size)], tl: treeline(z0 + size / 2), towny: town } : null,
    };
    if (par && par.mesh) {
      const pp = par.mesh.geometry.attributes.position.array, h = new Float32Array(V * V);
      for (let i = 0; i < V * V; i++) h[i] = pp[i * 3 + 1];
      job.parent = { h, layer: par.layer, midY: par.midY, end: SPLIT * par.size };
    }
    return job;
  }

  /** Build a patch here and now, on the main thread: the root, and every patch when there are no workers. */
  build(node) {
    node.layer = this.free.pop();
    this.apply(node, buildPatch(this.prepare(node)));
  }

  /** Hand a patch to a worker. Its answer waits in `done` until a frame has room to show it. */
  send(node) {
    node.layer = this.free.pop();
    const job = this.prepare(node), state = node.job = { canceled: false, result: null };
    if (job.urban && job.urban.fn) { node.job = null; this.apply(node, buildPatch(job)); return; }     // (no grid to send: see setUrbanGrid)
    const flats = job.flats, step = node.size / (TN - 1), transfer = buffersOf(job);
    job.flats = null;
    this.flying++; this.stats.sent++;
    pool.run({ t: 'patch', job, flats, rect: [node.x0 - step, node.z0 - step, node.x0 + node.size + step, node.z0 + node.size + step] }, transfer).then((r) => {
      this.flying--;
      perf.worker('patch build', r.ms);
      if (state.canceled) { this.stats.dropped++; return; }
      state.result = r; this.done.push(node);
      if (this.nudge) { const f = this.nudge; this.nudge = null; f(); }
    }, (r) => {
      this.flying--;
      if (state.canceled) return;
      if (!r.dead) console.warn('A terrain patch could not be built in a worker:', r.err);
      node.job = null; node.queued = false; this.free.push(node.layer);         // back in the queue at the next walk
    });
  }

  /** Make a patch's mesh from its built data (r: see patchbuild.buildPatch) and its trees with it. */
  apply(node, r) {
    const { x0, z0, size } = node, layer = node.layer, half = size / 2, skirt = size * 0.05 + 6, { lo, hi } = r;
    this.atlas.image.data.set(r.tex, layer * TN * TN * 4);
    this.atlas.addLayerUpdate(layer); this.atlas.needsUpdate = true;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.pos, 3));
    g.setAttribute('uv', this.uv);
    g.setAttribute('aUvP', this.uvParent[node.quarter]);
    g.setAttribute('aMorph', new THREE.BufferAttribute(r.morph, 4));
    g.setAttribute('aLayer', new THREE.BufferAttribute(r.lay, 1));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (lo + hi) / 2, 0), Math.hypot(half * 1.4143, (hi - lo) / 2 + skirt));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(x0 + half, 0, z0 + half);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.visible = false;
    this.group.add(mesh);
    node.mesh = mesh; node.midY = (lo + hi) / 2;
    node.job = null; node.queued = false;
    this.chunkCount++; this.stats.shown++;
    this.upload(g);
    if (r.trees) node.trees = this.trees.apply(node, r.trees);
  }

  /** Have a new geometry's buffers sent to the graphics card on the next frame (see `fresh` in the constructor). */
  upload(geometry) {
    const m = new THREE.Mesh(geometry, this.freshMat);
    m.frustumCulled = false; m.matrixAutoUpdate = false;
    this.fresh.add(m);
  }

  dispose(node) {
    node.queued = false;
    // a build still with a worker, or back and waiting its turn: its answer is dropped, its layer is free again
    if (node.job) { node.job.canceled = true; node.job = null; this.free.push(node.layer); }
    if (node.children) { for (const c of node.children) this.dispose(c); node.children = null; }
    if (node.mesh) {
      this.group.remove(node.mesh); node.mesh.geometry.dispose(); node.mesh = null; this.chunkCount--; this.free.push(node.layer);
    }
    if (node.trees) { this.trees.dispose(node.trees); node.trees = null; }
  }

  dist(node, cam) {
    const dx = Math.max(node.x0 - cam.x, 0, cam.x - (node.x0 + node.size));
    const dz = Math.max(node.z0 - cam.z, 0, cam.z - (node.z0 + node.size));
    const dy = cam.y - node.midY;
    return Math.sqrt(dx * dx + dz * dz + dy * dy);
  }

  visit(node, cam) {
    if (node.trees) this.trees.show(node.trees);
    const d = this.dist(node, cam);
    const want = node.size > MIN_SIZE && d < node.size * (node.children ? MERGE : AHEAD);
    if (want) {
      if (!node.children) {
        const h = node.size / 2;
        node.children = [new Node(node.x0, node.z0, h, node, 0), new Node(node.x0 + h, node.z0, h, node, 1),
          new Node(node.x0, node.z0 + h, h, node, 2), new Node(node.x0 + h, node.z0 + h, h, node, 3)];
      }
      let ready = true;
      for (const c of node.children) {
        if (!c.mesh) {
          ready = false;
          c.prio = this.dist(c, cam) / c.size;
          if (!c.queued) { c.queued = true; this.queue.push(c); }
        }
      }
      // Inside SPLIT the children are drawn; outside it they wait, built, and this patch is drawn (the two are the
      // same surface there, so the swap can go either way without a jump and needs no hysteresis of its own).
      if (ready && d < node.size * SPLIT) { for (const c of node.children) this.visit(c, cam); return; }
      for (const c of node.children) if (c.children) { for (const g of c.children) this.dispose(g); c.children = null; }
    } else if (node.children) {
      for (const c of node.children) this.dispose(c);
      node.children = null;
    }
    node.mesh.visible = true; this.shown.push(node.mesh);
  }

  /**
   * Refine around the camera. Patches wait in the queue until their elevation tiles arrive, are built by the
   * workers nearest first, and are shown as the frame's upload budget allows (render/budget.js).
   * budgetMs: the most main-thread time to spend building when there are no workers. shared: false while a
   * flight is loading and no frame is at stake: then everything that is ready is taken at once.
   * Returns how many patches are still to come.
   */
  update(cam, budgetMs = 5, shared = true) {
    if (!this.root || !this.root.mesh) return 0;
    perf.cpuBegin('terrain walk');
    for (const m of this.shown) m.visible = false;
    this.shown.length = 0;
    this.fresh.clear();                                 // last frame's new geometry is with the graphics card by now
    this.trees.begin();
    this.queue = this.queue.filter((n) => n.queued && !n.mesh && !n.job);
    this.visit(this.root, cam);
    perf.cpuEnd();
    this.trees.update(cam, shared);
    const free = !shared || uploads.open, t0 = performance.now();
    // Patches the workers have finished, nearest first: each is a texture layer and a vertex buffer for the
    // graphics card, and a frame takes only what the budget has room for.
    if (this.done.length) {
      perf.cpuBegin('terrain upload');
      const done = this.done.filter((n) => n.job && n.job.result).sort((a, b) => a.prio - b.prio);
      let i = 0;
      for (; i < done.length; i++) {
        const n = done[i], r = n.job.result, bytes = PATCH_BYTES + (r.trees ? r.trees.count * 16 : 0);
        if (!free && !uploads.take(bytes)) break;
        const t = performance.now();
        this.apply(n, r);
        if (!free) uploads.spend(performance.now() - t);
      }
      this.done = done.slice(i);
      perf.cpuEnd();
    }
    if (this.queue.length) {
      this.queue.sort((a, b) => a.prio - b.prio);
      if (pool.ok) {
        // Two jobs a worker: one being built, one to go straight on with. Getting a job ready is a few copies
        // (about a tenth of a millisecond); all the same none is started on a frame that is already late, and
        // a frame spends a millisecond on it at most.
        perf.cpuBegin('terrain dispatch');
        const t1 = performance.now();
        for (const n of this.queue) {
          if (this.flying >= pool.size * 2 || !this.free.length) break;
          if (!n.queued || n.job || !this.ready(n, n.prio)) continue;
          if (!free && (uploads.behind || performance.now() - t1 > 1)) break;
          this.send(n);
        }
        perf.cpuEnd();
      } else {
        // no workers: build here, inside the time allowed, and not at all on a frame that is already late
        perf.cpuBegin('terrain build');
        for (const n of this.queue) {
          if (!n.queued || !this.free.length || !this.ready(n, n.prio)) continue;
          if (!free && !uploads.take(PATCH_BYTES)) break;
          const t = performance.now();
          this.build(n);
          if (!free) uploads.spend(performance.now() - t);
          if (performance.now() - t0 > budgetMs) break;
        }
        perf.cpuEnd();
      }
    }
    return this.queue.length + this.flying + this.done.length;
  }

  /** Resolve once full detail is built around a point (or a time limit passes). */
  async warm(cam, timeoutMs = 9000) {
    const t0 = performance.now();
    let idle = 0;
    while (performance.now() - t0 < timeoutMs) {
      const left = this.update(cam, 40, false);
      idle = left === 0 ? idle + 1 : 0;
      if (idle > 2) break;
      // wait for a tile or a finished patch (or a moment, whichever is first)
      if (left) await Promise.race([new Promise((r) => setTimeout(r, 30)), dem.arrived(), new Promise((r) => { this.nudge = r; })]);
      else await nextTurn();
    }
  }
}
