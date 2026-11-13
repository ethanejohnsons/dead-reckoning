// Cities: the real buildings of the towns under the aircraft, as 3D massing.
//
// Footprints and heights come from OpenStreetMap by way of OpenFreeMap's public vector tiles (zoom 14, the
// `building` layer of the OpenMapTiles schema), streamed around the aircraft and never bundled. A worker
// fetches and decodes each tile and builds its meshes (world/cities.worker.js, world/citybuild.js); this
// file decides which tiles are wanted at which level of detail, puts the meshes in the scene a slice at a
// time, lights them like the terrain, and answers "is there a building here?" for the flight model and
// the trees.
//
//   near   every building, pitched roofs on houses, plant on big roofs: a quarter-tile at a time, within R0
//   mid    buildings of 350 m2 or 12 m and over, simplified: whole tiles within R1
//   tall   buildings of 35 m and over as prisms, out to SKY: only around the centers of big towns, spreading
//          from tile to tile for as long as tall buildings keep turning up, so a skyline reads from afar
//
// Houses (anything only the near level draws) rise out of their footprints over the last few hundred
// meters of R0, taking the color of the satellite picture under them as they sink, so no line shows where
// the near level ends. The 10 m picture cannot texture a house: walls, windows and roofs are drawn in the
// shader from a few numbers per building (kind, glazing, color, a random byte), and a roof borrows its
// tone from the picture under it where that has loaded.
//
// Bridges come from the same tiles (world/bridgebuild.js): every line the map marks as a bridge, as a deck on
// piers. They are two more levels of a tile, each a whole tile at a time:
//   bn     full detail (parapets, pier caps, arch columns, truss diagonals, light poles), within R0 or so
//   bf     a deck, its piers and the outline of its arch or truss, out to RB (2 km beyond the mid buildings)
// A bridge is put together in two steps, because the worker has the map and the main thread has the ground:
// the worker joins the lines across tile edges and says where it needs heights; they are read from the
// elevation here and sent back; then it builds. Under each deck a strip on the ground carries its shade where
// the sun's shadow maps do not reach (and a little always, where the picture shows the real bridge's shadow).
//
// The scene's alpha is a tag for the post-processing: buildings and bridges write 1.0, as the land does.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import * as dem from './dem.js';
import { pixelX, pixelY, metersPerPixel, LAND_HALF } from './geo.js';
import { applyFlats, flatsIn, groundHeight } from './terrain.js';
import { AIRPORTS } from './airports.js';
import { townList } from './towns.js';
import { GROUND_LIGHT_GLSL, GROUND_LIGHT_UNIFORMS } from './groundlight.js';
import { ATMO_GLSL, ATMO_UNIFORMS } from './atmosphere.js';
import { IMAGERY_GLSL, IMAGERY_UNIFORMS } from './imagery.js';
import { FullscreenQuad, fsMaterial } from '../render/fullscreen.js';
import { Traffic } from './traffic.js';

const FACADE_URL = `${import.meta.env.BASE_URL}facades/`, FAC_N = 11;      // wall materials: public/facades, one layer each (tools/bake-facades.py)

/** The credit OpenFreeMap asks for, for the title screen. */
export const CITY_ATTRIBUTION = 'Buildings: OpenFreeMap © OpenMapTiles, data from OpenStreetMap (openstreetmap.org/copyright); wall materials from ambientCG.com (CC0)';

const Z = 14;                              // the only zoom that carries every building with its height
const TIERS = {                            // R0 near, R1 mid, SKY tall (m); upload budget a frame (bytes)
  low: { R0: 1200, R1: 5000, SKY: 26000 },
  med: { R0: 1600, R1: 6500, SKY: 34000 },
  high: { R0: 2000, R1: 8000, SKY: 42000 },
  ultra: { R0: 2400, R1: 10000, SKY: 50000 },
};
const FADE = 450;                          // houses rise over this much of R0
const MAX_JOBS = 4;                        // tiles being fetched or built at once
const UPLOAD = 1.4e6;                      // bytes of new geometry handed to the GPU a frame
const SEED_POP = 60000, CORE_POP = 150000; // towns whose center is looked at for towers; and with the tiles around it
const COVER_N = 2048, COVER_M = 2;         // the coverage map: texels across, meters a texel
const BRIDGE_FAR = 2000;                   // bridges are kept in view this much farther than the mid buildings (m)
const GRAVE = 90;                          // frames a dropped mesh waits before its buffers are freed (the shadow pass may still hold it)

// ---- where buildings stand, for other shaders (the trees): a top-down map around the camera
const hold = (k, v) => ENV[k] || (ENV[k] = { value: v });
hold('tBldCover', null); hold('uBldCover', new THREE.Vector4(0, 0, 1 / (COVER_N * COVER_M), 0));
export const BUILDING_COVER_UNIFORMS = ['tBldCover', 'uBldCover'];
/** GLSL: buildingCover(worldXZ) is 1 on a building's footprint (and a couple of meters around it), 0 elsewhere or beyond the map. */
export const BUILDING_COVER_GLSL = /* glsl */`
uniform sampler2D tBldCover;
uniform vec4 uBldCover;          // center x, center z, 1 / width (1/m), 1 when the map holds anything
float buildingCover(vec2 xz) {
  vec2 q = (xz - uBldCover.xy) * uBldCover.z;
  if (uBldCover.w < 0.5 || max(abs(q.x), abs(q.y)) > 0.495) return 0.0;
  return textureLod(tBldCover, vec2(0.5 + q.x, 0.5 - q.y), 0.0).r;
}`;

// ------------------------------------------------------------------ shaders

const LIGHT_GLSL = /* glsl */`
uniform sampler2D tRegion, tWxA, tWxB, tDetail;
uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround;
uniform float uWxHalf;
float regionHeight(vec2 xz) { return max(texture2D(tRegion, xz / (2.0 * uWxHalf) + 0.5).r, 0.0); }
${GROUND_LIGHT_GLSL}`;
const LIGHT_UNIFORMS = ['tRegion', 'tWxA', 'tWxB', 'tDetail', 'uSunDir', 'uSunCol', 'uAmbSky', 'uAmbGround', 'uWxHalf', ...GROUND_LIGHT_UNIFORMS];
const shared = (names) => Object.fromEntries(names.map((k) => [k, ENV[k]]));

const VERT = /* glsl */`
attribute vec4 aN;            // normal
attribute vec2 aUV;           // meters along the wall, meters above the ground (eighths)
attribute vec4 aCol;          // color, a random number per building
attribute vec4 aK;            // surface (0 wall, 1 flat roof, 2 pitched roof, 3 plant, 4 underside); glazing + 8 small + 16 roof sampled at the middle; offset to the middle + 128
uniform vec2 uCityFade;       // small buildings start to sink at x meters from the eye and are gone by y
// The scene is multisampled: everything used as a value is centroid-sampled, so it is never read outside its triangle.
centroid varying vec3 vWorld, vN, vCol;
centroid varying vec4 vW;     // along the wall, above the ground, how far the building has risen, distance
centroid varying vec2 vLight, vImg;
flat varying vec4 vK;         // surface, glazing, random, roof sampled at the middle
flat varying float vMat;      // a wall's material (a layer of tFacade, from 1; 0 or over 100: none)
flat varying float vTop;      // how high above the ground a wall's top is (m; 0: not told)
${LIGHT_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vTop = aK.x < 0.5 ? aK.w : 0.0;
  float style = aK.y, central = step(15.5, style); style -= 16.0 * central;
  float small = step(7.5, style); style -= 8.0 * small;
  vec2 uv = aUV * 0.125;
  float d = distance(cameraPosition, wp.xyz);
  float grow = 1.0 - small * smoothstep(uCityFade.x, uCityFade.y, d);
  wp.y -= max(uv.y, 0.0) * (1.0 - grow);
  vWorld = wp.xyz; vN = aN.xyz; vCol = aCol.rgb;
  vW = vec4(uv, grow, d);
  vK = vec4(aK.x, style, aCol.a * 255.0, central);
  vImg = wp.xz + (aK.zw - 128.0);
  vMat = aK.z;
  float hReg = regionHeight(wp.xz);
  vLight = vec2(terrainShadow(wp.xyz, hReg) * (1.0 - 0.9 * cloudShadow(wp.xyz)), skyOcclusion(wp.xyz, hReg));
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (grow < 0.015) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform float uCityLit;       // how brightly lit rooms show: 0 by day
centroid varying vec3 vWorld, vN, vCol;
centroid varying vec4 vW;
centroid varying vec2 vLight, vImg;
flat varying vec4 vK;
flat varying float vMat;
flat varying float vTop;
// Wall materials (public/facades, tools/bake-facades.py): photographed surfaces and whole facades, one to a layer.
uniform mediump sampler2DArray tFacade;
uniform vec4 uFacA[FAC_N];    // meters a tile covers across and up; window cells across and up (0: a plain surface)
uniform vec4 uFacB[FAC_N];    // the mean color of the part that takes the building's color; (a facade) 1 when its glass takes it too, (a surface) how strongly it shows
uniform float uFacOn;         // 1 once the pictures are loaded
${LIGHT_GLSL}
${ATMO_GLSL}
${IMAGERY_GLSL}
float hashB(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 N = normalize(vN), V = normalize(cameraPosition - vWorld);
  float kind = vK.x, style = vK.y, seed = vK.z, dist = vW.w;
  vec3 alb = vCol, emit = vec3(0.0);
  float glass = 0.0, F0 = 0.06, low = 1.0, reveal = 0.0, tilt = 0.0;
  vec2 paneTilt = vec2(0.0);
  float grain = texture2D(tDetail, vWorld.xz / 23.0).g;
  if (kind < 0.5) {
    // ---- a wall: its material, and the windows its kind of building has
    float streak = texture2D(tDetail, vec2(vW.x / 9.0, vW.y / 90.0)).r;
    low = smoothstep(0.0, 2.5, vW.y);
    // The material: a photographed surface in the building's own color (the picture over its mean), or a whole
    // facade, whose windows then stand for the drawn ones: their glass is the picture's mask, their cells its grid.
    int mi = uFacOn > 0.5 && vMat > 0.5 && vMat < 99.5 ? int(vMat + 0.5) : 0;
    vec4 fA = vec4(0.0), fB = vec4(1.0), ftx = vec4(1.0, 1.0, 1.0, 0.0);
    vec2 fuv = vec2(0.0);
    if (mi > 0) {
      fA = uFacA[mi - 1]; fB = uFacB[mi - 1];
      fuv = vec2(vW.x, max(vW.y, 0.0)) / fA.xy;
      if (fA.z > 0.5) fuv.x += floor(fract(seed * 0.618) * fA.z) / fA.z; else fuv += vec2(fract(seed * 0.618), fract(seed * 0.377));
      ftx = texture(tFacade, vec3(fuv, float(mi - 1)));
      ftx.rgb /= fB.rgb;
      if (fA.z < 0.5) ftx.rgb = mix(vec3(1.0), ftx.rgb, fB.a);
      else if (fB.a > 0.5) ftx.rgb = mix(vec3(1.0), ftx.rgb, 0.6);     // (a dark glass wall's pane-to-pane differences are large beside its mean)
    }
    bool facade = fA.z > 0.5;
    float wear = (0.84 + 0.3 * streak) * mix(0.72, 1.0, smoothstep(0.0, 1.1, vW.y));
    vec3 pane = vec3(0.035, 0.05, 0.065), panel = alb * wear;
    if (mi > 0) panel = alb * clamp(ftx.rgb, 0.0, 3.0) * (facade ? mix(0.8, 1.0, smoothstep(0.0, 1.1, vW.y)) : mix(wear, 1.0, 0.5));
    if (style > 0.5 || facade) {
      // story height, bay width, half the window's share of a bay, the window's sill and head, the share of bays glazed, the share lit at night
      float fh = 2.8, bw = 3.4, wHalf = 0.19, wy0 = 0.95, wy1 = 2.15, some = 0.72, share = 0.16;
      vec3 lamp = vec3(1.0, 0.62, 0.28);
      if (style > 3.5) { fh = 3.7; bw = 6.0; wHalf = 0.485; wy0 = 1.05; wy1 = 2.75; some = 1.0; share = 0.3; lamp = vec3(1.0, 0.88, 0.68); F0 = 0.1; }
      else if (style > 2.5) { fh = 3.9; bw = 1.5; wHalf = 0.47; wy0 = 0.85; wy1 = 3.8; some = 1.0; share = 0.28; lamp = vec3(0.96, 0.92, 0.82); F0 = 0.14 + 0.3 * fract(seed * 0.137); pane = alb * 0.55; if (mi == 0) panel = alb * 1.25; }
      else if (style > 1.5) { fh = 3.5; bw = 2.7; wHalf = 0.27; wy0 = 1.0; wy1 = 2.7; some = 1.0; share = 0.26; lamp = mix(vec3(1.0, 0.68, 0.34), vec3(1.0, 0.88, 0.66), step(128.0, seed)); }
      vec2 fw = vec2(fwidth(vW.x), fwidth(vW.y));
      float y = max(vW.y, 0.0), up = step(0.01, vW.y), fl, bay, h1, w, mean, far;
      if (facade) {
        fh = fA.y / fA.w; bw = fA.x / fA.z;
        fl = floor(fuv.y * fA.w); bay = floor(fuv.x * fA.z);
        h1 = hashB(vec2(bay, fl) + seed * 0.37);
        far = max(smoothstep(0.4, 1.3, fw.x / (0.6 * bw)), smoothstep(0.4, 1.3, fw.y / (0.5 * fh)));
        glass = ftx.a * up; w = glass; mean = glass;
        // the picture's own glass, or (a wall all of glass) glass in the building's color
        pane = mix(ftx.rgb * fB.rgb, panel, fB.a);
        F0 = max(F0, 0.08);
        share *= 0.62;          // (a facade's whole pane lights, where a drawn window is a part of its bay)
      } else {
        fl = floor(y / fh); bay = floor(vW.x / bw);
        float fy = y - fl * fh, fx = fract(vW.x / bw) - 0.5;
        float band = clamp(min(fy - wy0, wy1 - fy) / max(fw.y, 0.02) + 0.5, 0.0, 1.0);
        float colm = clamp((wHalf - abs(fx)) * bw / max(fw.x, 0.02) + 0.5, 0.0, 1.0);
        h1 = hashB(vec2(bay, fl) + seed * 0.37);
        float there = some < 1.0 ? step(1.0 - some, h1) : 1.0;
        // Once a window is about a pixel the grid gives way to its average, across and up separately (the floors of
        // a tower still read as bands when its bays have long merged): nothing small and bright is left to twinkle.
        float farX = smoothstep(0.4, 1.3, fw.x / (2.0 * wHalf * bw)), farY = smoothstep(0.4, 1.3, fw.y / (wy1 - wy0));
        float meanX = 2.0 * wHalf * some, meanY = (wy1 - wy0) / fh;
        far = max(farX, farY);
        w = band * colm * there * up; mean = meanX * meanY * up;
        glass = mix(colm * there, meanX, farX) * mix(band, meanY, farY) * up;
        // A window is set back in its wall: the head and one jamb throw a shadow on the glass (which jamb, and how
        // deep, by where the sun stands to the wall), and a pale sill runs under it. Gone once a window is a few pixels.
        float close = (1.0 - smoothstep(0.1, 0.45, fw.y)) * there * up * step(style, 2.5);
        if (close > 0.0) {
          vec3 T = normalize(vec3(-N.z, 0.0, N.x));
          float sun = max(dot(N, uSunDir), 0.0), deep = 0.22;
          float headS = deep * clamp(uSunDir.y / max(sun, 0.15), 0.0, 3.0), sideS = deep * clamp(dot(T, uSunDir) / max(sun, 0.15), -3.0, 3.0);
          float wx = (fx + wHalf) * bw, ww = 2.0 * wHalf * bw;             // meters in from the window's left jamb; its width
          float head = smoothstep(wy1 - headS - 0.03, wy1 - headS + 0.03, fy);
          float jamb = sideS > 0.0 ? 1.0 - smoothstep(sideS - 0.03, sideS + 0.03, wx) : smoothstep(ww + sideS - 0.03, ww + sideS + 0.03, wx);
          reveal = max(max(head, jamb) * step(0.02, sun), 0.35 * smoothstep(wy1 - 0.12, wy1, fy)) * w * close;
          float sill = colm * clamp(min(fy - (wy0 - 0.14), wy0 - fy) / max(fw.y, 0.02) + 0.5, 0.0, 1.0) * there;
          panel = mix(panel, panel * 1.22 + 0.02, sill * close * 0.8);
        }
      }
      float h2 = hashB(vec2(fl * 1.31, seed));
      // Lit rooms: this window or that; in offices a floor here and there works late. Far off, where windows have
      // merged, the glow still varies floor by floor and from one stretch of wall to the next for as long as those
      // can be told apart, and some buildings are busier than others: a tower is never one even lamp.
      float on = step(1.0 - share, hashB(vec2(bay * 1.7 + 3.0, fl * 2.3 + 1.0) + seed * 0.71));
      if (style > 2.5) { float late = step(0.8, h2); on = mix(on, step(0.3, h1), late); share = mix(share, 0.7, 0.2); lamp = mix(lamp, vec3(0.80, 0.9, 1.0), step(0.5, fract(seed * 0.618))); }
      float bright = 0.55 + 0.9 * hashB(vec2(bay + 9.0, fl + seed));
      float floorVar = mix(0.2 + 1.6 * h2, 1.0, smoothstep(0.5, 1.5, fw.y / fh));
      float blockVar = mix(0.35 + 1.3 * hashB(vec2(floor(vW.x / (bw * 5.0)) + 7.0, fl * 0.5 + seed)), 1.0, smoothstep(0.5, 1.5, fw.x / (bw * 5.0)));
      float busy = 0.45 + 1.1 * fract(seed * 0.377);
      emit = lamp * busy * mix(w * on * bright, mean * share * floorVar * blockVar, far);
      if (facade) {
        // A lit pane is a room, not a lamp: dark below the sill line, brightest under the ceiling lights, uneven,
        // and it keeps the pane's own frames and blinds. (Far off this is its average.)
        float cy = fract(fuv.y * fA.w);
        float room = smoothstep(0.06, 0.3, cy) * (0.5 + 0.5 * smoothstep(0.3, 0.92, cy)) * (0.7 + 0.5 * texture2D(tDetail, fuv * fA.zw * 0.37 + seed * 0.11).r);
        emit *= mix(room, 0.6, far) * (0.55 + 0.45 * clamp(dot(ftx.rgb * fB.rgb, vec3(4.0)), 0.0, 1.0));
      }
      // blinds drawn behind some panes
      if (!facade) pane = mix(pane, vec3(0.30, 0.29, 0.26), (1.0 - far) * step(0.8, hashB(vec2(bay + 5.0, fl + 2.0) + seed)) * 0.7 * step(style, 2.5));
    }
    // ---- what a wall has at its foot and at its top, whatever is between (not a house, not a shed: vTop says how tall)
    if (vTop > 0.5) {
      vec2 fw = vec2(fwidth(vW.x), fwidth(vW.y));
      float y = max(vW.y, 0.0), fromTop = vTop - vW.y;
      // The ground floor of anything with stories above it: storefronts and lobbies, glass from knee to head between
      // piers, under a fascia. Its lamps are on in the evening when the offices above have gone home.
      if (style > 1.5 && vTop > 6.5) {
        float gh = vTop > 30.0 ? 5.4 : 4.1, bw = style > 2.5 ? 4.5 : 5.2;
        float in0 = 1.0 - smoothstep(gh - 0.02, gh + 0.02, y);
        if (in0 > 0.0) {
          float farG = smoothstep(0.5, 1.6, max(fw.x / (0.5 * bw), fw.y / (0.4 * gh)));
          float bx = abs(fract(vW.x / bw + fract(seed * 0.23)) - 0.5) * bw;          // meters from the middle of a bay
          float pier = clamp((bx - (0.5 * bw - 0.32)) / max(fw.x, 0.02) + 0.5, 0.0, 1.0);
          float open = clamp(min(y - 0.45, (gh - 0.95) - y) / max(fw.y, 0.02) + 0.5, 0.0, 1.0) * (1.0 - pier);
          float bayN = floor(vW.x / bw + fract(seed * 0.23)), shut = step(0.86, hashB(vec2(bayN, seed)));      // a blank bay here and there: a service door, a wall
          open *= 1.0 - shut;
          float g0 = mix(open, 0.52, farG) * step(0.01, vW.y);
          vec3 fascia = mix(panel * 0.72, mix(vec3(0.05, 0.05, 0.055), vec3(0.3, 0.07, 0.05), step(0.72, hashB(vec2(bayN, seed + 3.0)))), step(0.6, hashB(vec2(bayN + 2.0, seed))) * (1.0 - farG));
          vec3 base = mix(panel * 0.86, fascia, smoothstep(gh - 0.95, gh - 0.9, y));
          panel = mix(panel, base, in0);
          pane = mix(pane, vec3(0.03, 0.04, 0.05), in0);
          glass = mix(glass, g0, in0); reveal *= 1.0 - in0;
          float shopOn = step(0.35, hashB(vec2(bayN + 11.0, seed)));
          emit = mix(emit, vec3(1.0, 0.8, 0.55) * mix(open * shopOn * (0.6 + 0.6 * hashB(vec2(bayN, 5.0 + seed))), 0.3, farG) * 1.25, in0);
          F0 = mix(F0, 0.08, in0);
        }
      }
      // The roof line: a coping along the top of the wall and its shadow under it; on a tower, a blind band of
      // louvres for the plant floor behind.
      float farT = smoothstep(0.35, 1.2, fw.y);
      if (vTop < 253.5) {
        float crown = vTop > 38.0 && style > 1.5 ? clamp(0.06 * vTop, 3.0, 6.5) : 0.0;
        if (crown > 0.0) {
          float inC = smoothstep(crown + 0.03, crown - 0.03, fromTop);
          float slat = 0.5 + 0.5 * sin(vW.y * 20.9) * (1.0 - smoothstep(0.08, 0.25, fw.y));
          vec3 plant = (style > 2.5 ? vCol * 0.5 + 0.03 : panel * 0.7) * (0.72 + 0.28 * slat);
          panel = mix(panel, plant, inC); glass *= 1.0 - inC; emit *= 1.0 - inC; reveal *= 1.0 - inC;
        }
        float cope = smoothstep(0.55, 0.45, fromTop) * (1.0 - farT), under = smoothstep(0.9, 0.6, fromTop) * (1.0 - smoothstep(0.52, 0.48, fromTop)) * (1.0 - farT);
        panel = mix(panel, panel * 0.62, under * 0.7);
        panel = mix(panel, panel * 1.18 + 0.025, cope * step(style, 2.5));
        glass *= 1.0 - max(cope, under) * step(style, 2.5);
      }
      // Glass in a wall of glass is not one mirror: every pane sits a hair off true, so each shows a slightly different sky.
      if (style > 2.5 && glass > 0.01) {
        float ph = 3.9, pw = 1.5;
        vec2 cell = vec2(floor(vW.x / pw), floor(y / ph));
        tilt = (1.0 - smoothstep(0.25, 1.2, max(fw.x / pw, fw.y / ph)));
        paneTilt = (vec2(hashB(cell + seed), hashB(cell * 1.7 + seed + 4.0)) - 0.5) * tilt;
      }
    }
    alb = mix(panel, pane * (1.0 - 0.62 * reveal), glass);
  } else if (kind < 2.5) {
    // ---- a roof: its own color, pulled toward what the satellite picture shows there
    vec4 im = imagery(vImg, vK.w > 0.5 ? 0.0 : max(imageryLevel(dist), 0.0));
    alb *= 0.86 + 0.28 * grain;
    if (im.a > 0.5) {
      vec3 p = im.rgb * 2.6; p = p / (1.0 + 0.65 * p);
      const vec3 W = vec3(0.3, 0.55, 0.15);
      float L = dot(p, W), L0 = max(dot(vCol, W), 0.02);
      vec3 mine = mix(alb * clamp(L / L0, 0.6, 1.6), p, 0.25);          // a house: its shingle, as light or dark as the picture has it
      if (vK.w < 0.5) mine = mix(alb, p * (0.9 + 0.2 * grain), 0.72);       // a big roof is in the picture itself
      alb = mix(p, mine, vW.z);                                            // sinking into the picture at the edge of the near level
    }
  } else if (kind < 3.5) alb *= 0.82 + 0.3 * grain;
  else alb *= 0.5;

  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * (1.0 - 0.5 * vLight.y) * mix(0.78, 1.0, low);
  amb += uSunCol * max(uSunDir.y, 0.0) * vLight.x * 0.11 * (1.0 - N.y * N.y) * vec3(1.0, 0.95, 0.82);     // sunlit ground throws light back up a wall
  float sunLit = vLight.x * localShadow(vWorld + N * 0.35);
  vec3 col = alb * (uSunCol * ndl * sunLit + amb + localLight(vWorld, N));
  if (glass > 0.01) {
    // glass shows the sky it faces, more of it the shallower the look
    vec3 Ng = N;
    if (tilt > 0.0) Ng = normalize(N + (normalize(vec3(-N.z, 0.0, N.x)) * paneTilt.x + vec3(0.0, 1.0, 0.0) * paneTilt.y) * 0.05);
    vec3 R = reflect(-V, Ng);
    vec3 env = skyRadiance(normalize(vec3(R.x, max(R.y, 0.03), R.z)));
    env *= 1.0 - 0.5 * reveal;
    env = mix(env, uSunCol * max(uSunDir.y, 0.0) * vLight.x * 0.15 + uAmbSky * 0.4, smoothstep(0.0, -0.25, R.y));      // looking down a wall, it shows the street
    float fres = F0 + (1.0 - F0) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = mix(col, env, glass * fres);
    col += glass * uSunCol * sunLit * pow(max(dot(R, uSunDir), 0.0), 220.0) * (1.5 * F0 + 0.1);
  }
  // after dark: the rooms, and a little of the street's light up the foot of the walls
  col += emit * uCityLit + alb * vec3(1.0, 0.62, 0.32) * (uCityLit * 0.03 * (kind < 0.5 ? 1.0 - smoothstep(0.0, 12.0, vW.y) : 0.0));
  vec3 outc = applyAtmosphere(col, cameraPosition, vWorld);
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b < 1e4)) discard;
  gl_FragColor = vec4(outc, 1.0);
}`;

// Obstruction lights on tall buildings: point sprites, as the airfield lamps are (a soft round spot that never
// shrinks below a few pixels, dimming with range instead).
const LAMP_VERT = /* glsl */`
attribute float aFlash;
uniform float uViewH, uLevel, uTime;
varying vec3 vCol;
varying float vShape;
${ATMO_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float d = max(distance(cameraPosition, wp.xyz), 0.5);
  float I = aFlash > 0.5 ? 0.12 + 0.88 * pow(0.5 + 0.5 * sin(uTime * 3.14159 + floor(wp.x * 0.02) * 1.7), 4.0) : 0.7;
  gl_Position = projectionMatrix * viewMatrix * wp;
  float phys = 0.9 * uViewH * 0.5 * projectionMatrix[1][1] / d;
  float px = uViewH / 1080.0, core = clamp(phys, 3.6 * px, 12.0 * px);
  I *= pow(min(1.0, phys / core), 0.42) * uLevel;
  vCol = vec3(1.0, 0.06, 0.035) * atmosphereTransmittance(cameraPosition, wp.xyz) * I;
  float size = max(core, min(phys * 3.5, 40.0 * px));
  vShape = (size * size) / (core * core);
  gl_PointSize = size;
  if (I < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const LAMP_FRAG = /* glsl */`
varying vec3 vCol;
varying float vShape;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q), skirt = exp(-r2 * 3.2) - 0.0408;
  if (skirt <= 0.0) discard;
  float a = vShape > 1.02 ? exp(-r2 * 3.2 * vShape) + 0.06 * skirt * smoothstep(1.0, 2.5, vShape) : skirt;
  gl_FragColor = vec4(vCol * a, 0.0);
}`;

// Roads near the aircraft: ribbons on the ground from the same tiles, blended over the picture (which shows a
// road as a gray smear at 10 m a pixel) so that streets have edges and a center line from low down. Subtle on
// purpose, and gone by the edge of the near level.
const ROAD_VERT = /* glsl */`
attribute vec3 aR;            // -1 | 1 across, meters along, half-width + 100 * rank
centroid varying vec3 vWorld;
centroid varying vec2 vR;
flat varying vec2 vRoad;      // half-width (m), rank 0..1
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vR = aR.xy;
  float rank = floor(aR.z / 10.0) * 0.1;
  vRoad = vec2(aR.z - rank * 100.0, rank);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ROAD_FRAG = /* glsl */`
uniform vec2 uRoadFade;
centroid varying vec3 vWorld;
centroid varying vec2 vR;
flat varying vec2 vRoad;
${LIGHT_GLSL}
${ATMO_GLSL}
void main() {
  float dist = distance(cameraPosition, vWorld), hw = vRoad.x, rank = vRoad.y;
  float fade = 1.0 - smoothstep(uRoadFade.x, uRoadFade.y, dist);
  if (fade <= 0.0) discard;
  float across = abs(vR.x) * hw, px = max(fwidth(vR.x) * hw, 0.05);          // meters from the middle; meters a pixel spans across the road
  float edge = clamp((hw - across) / max(px, 0.6), 0.0, 1.0);
  float grain = texture2D(tDetail, vWorld.xz / 7.0).r, mott = texture2D(tDetail, vWorld.xz / 61.0).g;
  vec3 alb = vec3(0.105, 0.105, 0.11) * (0.8 + 0.25 * grain + 0.25 * mott);
  // paint, while a line is wider than a third of a pixel: a yellow center line on a two-way road, lane dashes on a roadway
  float fine = 1.0 - smoothstep(0.35, 0.9, px);
  if (rank > 0.65 && fine > 0.0) {
    bool mway = rank > 0.95;
    float line = (1.0 - smoothstep(0.10, 0.10 + px, across)) * (mway ? step(0.75, fract(vR.y / 12.0)) : 1.0);
    alb = mix(alb, mway ? vec3(0.62) : vec3(0.60, 0.44, 0.06), line * fine * 0.85);
    float side = 1.0 - smoothstep(0.08, 0.08 + px, abs(across - (hw - 0.45)));
    alb = mix(alb, vec3(0.6), side * fine * 0.6 * step(0.85, rank));
  }
  vec2 gLit = terrainLight(vWorld, regionHeight(vWorld.xz));
  float trees = treeShade(vWorld, dFdx(vWorld.xz), dFdy(vWorld.xz));      // street trees shade the road as they shade the land beside it
  float shadow = gLit.x * localShadow(vWorld) * (1.0 - 0.9 * cloudShadow(vWorld)) * (1.0 - 0.9 * trees);
  vec3 amb = uAmbSky * (1.0 - 0.5 * gLit.y) * (1.0 - 0.21 * trees * uTreeShadeP.y);
  vec3 col = alb * (uSunCol * max(uSunDir.y, 0.0) * shadow + amb + localLight(vWorld, vec3(0.0, 1.0, 0.0)));
  vec4 outc = vec4(applyAtmosphere(col, cameraPosition, vWorld), edge * fade * mix(0.5, 0.8, rank));
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b < 1e4)) discard;
  gl_FragColor = outc;
}`;

// Bridges: decks, piers and steelwork, lit as the buildings are. What a surface is comes with each vertex:
// 0 road, 1 concrete, 2 the underside, 3 steel, 4 railroad track bed, 5 sidewalk, 6 the deck's outer face.
const BRIDGE_VERT = /* glsl */`
attribute vec4 aN;
attribute vec2 aUV;           // across and along the deck, or along and up a face (eighths of a meter)
attribute vec4 aCol;          // color, a random number per bridge
attribute vec4 aK;            // surface; road paint, or how much sun a face under the deck gets (0..255); road half-width (eighths); lit at night
centroid varying vec3 vWorld, vN, vCol;
centroid varying vec3 vW;     // the two coordinates (m), distance
centroid varying vec2 vLight;
flat varying vec4 vK;
${LIGHT_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vN = aN.xyz; vCol = aCol.rgb;
  vW = vec3(aUV * 0.125, distance(cameraPosition, wp.xyz));
  vK = aK;
  float hReg = regionHeight(wp.xz);
  vLight = vec2(terrainShadow(wp.xyz, hReg) * (1.0 - 0.9 * cloudShadow(wp.xyz)), skyOcclusion(wp.xyz, hReg));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BRIDGE_FRAG = /* glsl */`
uniform float uCityLit;
centroid varying vec3 vWorld, vN, vCol;
centroid varying vec3 vW;
centroid varying vec2 vLight;
flat varying vec4 vK;
${LIGHT_GLSL}
${ATMO_GLSL}
void main() {
  vec3 N = normalize(vN);
  float kind = vK.x;
  vec2 uv = vW.xy;
  vec3 alb = vCol, emit = vec3(0.0);
  float open = 1.0, occl = 1.0;       // how much sun reaches the surface where the shadow maps do not say; how much sky
  float grain = texture2D(tDetail, vWorld.xz / 9.0).r, mott = texture2D(tDetail, vWorld.xz / 67.0).g;
  if (kind < 0.5) {
    // ---- a road: asphalt, and paint while a line is wider than a third of a pixel
    float hw = vK.z * 0.125, mark = mod(vK.y, 8.0), across = abs(uv.x), px = max(fwidth(uv.x), 0.03);
    alb *= 0.8 + 0.24 * grain + 0.22 * mott;
    float fine = 1.0 - smoothstep(0.35, 1.1, px);
    if (mark > 0.5 && fine > 0.0) {
      vec3 lc = vec3(0.62); float line;
      if (mark > 2.5) {
        // a roadway: dashes between its lanes, a line down each edge
        float lanes = max(2.0, floor((2.0 * hw - 2.6) / 3.6 + 0.5)), t = uv.x / 3.6 + 0.5 * lanes, k = floor(t + 0.5);
        line = (1.0 - smoothstep(0.07, 0.07 + px, abs(t - k) * 3.6)) * step(0.5, k) * step(k, lanes - 0.5) * step(0.7, fract(uv.y / 12.0));
        line = max(line, 1.0 - smoothstep(0.07, 0.07 + px, abs(across - 1.8 * lanes)));
      } else {
        line = 1.0 - smoothstep(0.10, 0.10 + px, across); lc = vec3(0.60, 0.44, 0.06);
        float e = mark > 1.5 ? 1.0 - smoothstep(0.07, 0.07 + px, abs(across - (hw - 0.75))) : 0.0;
        if (e > line) { line = e; lc = vec3(0.62); }
      }
      alb = mix(alb, lc, line * fine * 0.85);
    }
    // beyond the road's own width (a far deck's parapets, the fill between two decks): concrete
    alb = mix(alb, vec3(0.47, 0.46, 0.43) * (0.85 + 0.25 * grain), smoothstep(hw - 0.42, hw - 0.42 + px, across));
    // after dark the lamps along it light the deck
    emit = alb * vec3(1.0, 0.74, 0.44) * (uCityLit * 1.5 * step(0.5, vK.w));
  } else if (kind < 1.5 || kind > 5.5) {
    // ---- concrete, streaked by the weather; the deck's outer face is a slab over girders set back in its shade
    float streak = texture2D(tDetail, vec2(uv.x / 7.0, uv.y / 55.0)).r;
    if (vK.z < 0.5) alb *= 0.8 + 0.3 * streak + 0.14 * (mott - 0.5); else alb *= 0.85 + 0.3 * grain;
    if (kind > 5.5) { float under = smoothstep(-0.5, -0.62, uv.y); alb *= mix(1.0, 0.72, under); open = mix(1.0, 0.3, under); occl = mix(1.0, 0.75, under); }
    else { open = vK.y / 255.0; occl = 0.55 + 0.45 * open; }
  } else if (kind < 2.5) { alb *= 0.6 + 0.2 * grain; open = 0.0; occl = 0.5; }
  else if (kind < 3.5) alb *= 0.85 + 0.3 * grain;
  else if (kind < 4.5) {
    // ---- a railroad: ballast, sleepers, two rails
    float across = abs(uv.x), px = max(fwidth(uv.x), 0.03);
    alb *= 0.75 + 0.5 * grain;
    alb = mix(alb, vec3(0.15, 0.125, 0.11), step(across, 1.3) * step(0.55, fract(uv.y / 0.6)) * (1.0 - smoothstep(0.08, 0.3, px)) * 0.8);
    alb = mix(alb, vec3(0.10, 0.09, 0.085), step(across, 1.3) * smoothstep(0.08, 0.3, px) * 0.35);
    alb = mix(alb, vec3(0.33, 0.30, 0.28), (1.0 - smoothstep(0.05, 0.05 + px, abs(across - 0.72))) * (1.0 - smoothstep(0.3, 1.2, px)));
  } else alb *= (0.85 + 0.25 * grain) * mix(0.8, 1.0, smoothstep(0.02, 0.05, abs(fract(uv.y / 3.0) - 0.5)));

  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * (1.0 - 0.5 * vLight.y) * occl;
  amb += uSunCol * max(uSunDir.y, 0.0) * vLight.x * 0.10 * (1.0 - 0.5 * N.y - 0.5 * N.y * N.y) * vec3(1.0, 0.95, 0.82);     // the sunlit land or water below throws light back up
  // the sun: the shadow maps where they reach; beyond them, what a surface under a deck is likely to get
  float sunLit = vLight.x * localShadow(vWorld + N * 0.35) * mix(open, kind > 5.5 ? open : 1.0, sunMapCover(vWorld));
  vec3 col = alb * (uSunCol * ndl * sunLit + amb + localLight(vWorld, N)) + emit;
  col += alb * vec3(1.0, 0.7, 0.4) * (uCityLit * step(0.5, kind) * step(0.5, vK.w) * (kind > 5.5 ? 0.09 * smoothstep(-1.2, 0.3, uv.y) : kind < 1.5 && vK.y > 200.0 ? 0.16 : 0.012));      // and a little of that light on the parapets beside them
  vec3 outc = applyAtmosphere(col, cameraPosition, vWorld);
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b < 1e4)) discard;
  gl_FragColor = vec4(outc, 1.0);
}`;

// The shade under a deck, as strips on the ground. Two to each deck: one slid down-sun by the deck's height (its
// shadow, where the sun's shadow maps do not reach: beyond a kilometer or so), one where it lies (the dimness
// under any deck, which also sits over the bridge that the picture on the ground shows).
const SHADE_VERT = /* glsl */`
attribute vec4 aS;            // -1 | 1 across, the deck's height over the ground here (m), half the strip's width (m), 1: the cast shadow, 0: the shade beneath
centroid varying vec3 vWorld;
centroid varying vec2 vS;
varying float vLit;
flat varying vec2 vH;
${LIGHT_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.xz -= aS.w * uSunDir.xz * (aS.y / max(uSunDir.y, 0.1));
  vWorld = wp.xyz; vS = vec2(aS.x, aS.z); vH = aS.yw;
  vLit = terrainShadow(wp.xyz, regionHeight(wp.xz)) * (1.0 - 0.9 * cloudShadow(wp.xyz));
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SHADE_FRAG = /* glsl */`
uniform vec2 uShade;          // how dark the cast shadow is, and the shade beneath
centroid varying vec3 vWorld;
centroid varying vec2 vS;
varying float vLit;
flat varying vec2 vH;
${LIGHT_GLSL}
${ATMO_GLSL}
void main() {
  float w = vS.y, px = max(fwidth(vS.x) * w, 0.05);
  bool down = vH.y > 0.5;        // the cast shadow, slid down-sun
  float soft = max(px, down ? 0.6 + 0.03 * vH.x : 1.6);
  float edge = clamp((1.0 - abs(vS.x)) * w / soft, 0.0, 1.0);
  const vec3 W = vec3(0.25, 0.6, 0.15);
  float sun = dot(uSunCol, W) * max(uSunDir.y, 0.0) * vLit, sky = dot(uAmbSky, W);
  float a = down
    ? uShade.x * sun / (sun + sky + 1.0e-4) * smoothstep(0.07, 0.2, uSunDir.y) * (1.0 - sunMapCover(vWorld))
    : uShade.y * exp(-vH.x / 16.0) * edge;
  a *= edge * dot(atmosphereTransmittance(cameraPosition, vWorld), vec3(0.3333));
  if (!(a > 0.003)) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, min(a, 1.0));
}`;

// The lamps along a road bridge: point sprites, like the obstruction lights but steady and warm.
const BLAMP_VERT = /* glsl */`
uniform float uViewH, uLevel;
varying vec3 vCol;
varying float vShape;
${ATMO_GLSL}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float d = max(distance(cameraPosition, wp.xyz), 0.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
  float phys = 0.7 * uViewH * 0.5 * projectionMatrix[1][1] / d;
  float px = uViewH / 1080.0, core = clamp(phys, 2.2 * px, 9.0 * px);
  float I = pow(min(1.0, phys / core), 0.5) * uLevel * (0.8 + 0.4 * fract(wp.x * 0.37 + wp.z * 0.11));
  vCol = vec3(1.0, 0.76, 0.46) * atmosphereTransmittance(cameraPosition, wp.xyz) * I;
  float size = max(core, min(phys * 3.0, 30.0 * px));
  vShape = (size * size) / (core * core);
  gl_PointSize = size;
  if (I < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

// ------------------------------------------------------------------ the layer

const tmpC = new THREE.Color();

export class Cities {
  constructor(scene, renderer) {
    this.renderer = renderer;
    this.group = new THREE.Group(); this.group.name = 'cities'; this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    this.uFade = { value: new THREE.Vector2(1550, 2000) }; this.uLit = { value: 0 };
    this.uLevel = { value: 0 }; this.uViewH = { value: 1080 };
    // wall materials: an empty array texture until the pictures arrive (loadFacades)
    const blank = new THREE.DataArrayTexture(new Uint8Array(4 * FAC_N).fill(128), 1, 1, FAC_N); blank.needsUpdate = true;
    this.uFacTex = { value: blank }; this.uFacOn = { value: 0 };
    this.uFacA = { value: Array.from({ length: FAC_N }, () => new THREE.Vector4(1, 1, 0, 0)) };
    this.uFacB = { value: Array.from({ length: FAC_N }, () => new THREE.Vector4(1, 1, 1, 0)) };
    this.loadFacades();
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), ...shared(IMAGERY_UNIFORMS), uCityFade: this.uFade, uCityLit: this.uLit,
        tFacade: this.uFacTex, uFacA: this.uFacA, uFacB: this.uFacB, uFacOn: this.uFacOn },
      defines: { FAC_N },
      vertexShader: VERT, fragmentShader: FRAG,
    });
    this.mats = [this.material];
    this.uRoadFade = { value: new THREE.Vector2(1200, 1900) };
    this.roadMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), uRoadFade: this.uRoadFade },
      vertexShader: ROAD_VERT, fragmentShader: ROAD_FRAG, side: THREE.DoubleSide,
      // a decal on the ground: blended over it (the land's alpha stays 1), never written to depth
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
    /** Draw the roads near the aircraft? */
    this.roads = true;
    // The vehicles on them (world/traffic.js): lit like the roads they drive on.
    this.traffic = new Traffic(this.group, { light: LIGHT_GLSL, atmo: ATMO_GLSL }, { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS) });
    this.bridgeMat = new THREE.ShaderMaterial({ uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), uCityLit: this.uLit }, vertexShader: BRIDGE_VERT, fragmentShader: BRIDGE_FRAG });
    this.bridgeMats = [this.bridgeMat];
    this.uShade = { value: new THREE.Vector2(0.9, 0.34) }; this.uBridgeLamp = { value: 0 };
    // the shade under a deck darkens what is there and leaves its alpha (the tag for land or water) alone
    this.shadeMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(LIGHT_UNIFORMS), ...shared(ATMO_UNIFORMS), uShade: this.uShade },
      vertexShader: SHADE_VERT, fragmentShader: SHADE_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.bridgeLampMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(ATMO_UNIFORMS), uViewH: this.uViewH, uLevel: this.uBridgeLamp },
      vertexShader: BLAMP_VERT, fragmentShader: LAMP_FRAG, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    /** Draw the bridges? (Off: no more are asked for, and those in the scene are hidden.) */
    this.bridges = true;
    this.waiting = [];                 // bridge jobs whose plan has come back, waiting for the ground under it to load
    this.lampMat = new THREE.ShaderMaterial({
      uniforms: { ...shared(ATMO_UNIFORMS), uViewH: this.uViewH, uLevel: this.uLevel, uTime: ENV.uTime },
      vertexShader: LAMP_VERT, fragmentShader: LAMP_FRAG, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });

    // the coverage map: footprints drawn from above, then spread a couple of meters so a tree's crown keeps clear of the eaves
    const target = () => new THREE.WebGLRenderTarget(COVER_N, COVER_N, { format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.coverRaw = target(); this.coverRT = target();
    this.coverCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
    this.coverScene = new THREE.Scene(); this.coverScene.matrixWorldAutoUpdate = false;
    this.coverScene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    this.spreadMat = fsMaterial(/* glsl */`
      precision highp float;
      uniform sampler2D tRaw;
      in vec2 vUv; out vec4 outColor;
      void main() {
        float t = ${(1 / COVER_N).toFixed(8)}, m = 0.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) m = max(m, texture(tRaw, vUv + vec2(float(i), float(j)) * t * 1.25).r);
        outColor = vec4(m, 0.0, 0.0, 1.0);
      }`, { tRaw: { value: this.coverRaw.texture } });
    this.quad = new FullscreenQuad();
    this.coverAt = [1e12, 1e12]; this.coverDirty = false; this.coverT = 0; this.coverHas = false;
    ENV.tBldCover.value = this.coverRT.texture;

    this.tiles = new Map();            // key -> tile
    this.info = new Map();             // key -> { tall, total }: what each tile turned out to hold (kept while the world stands)
    this.sky = new Map();              // key -> { tx, ty, depth }: tiles looked at for the skyline
    this.jobs = new Map();             // id -> { tile, level, quad, gen, t0 }
    this.queue = [];                   // wanted and not yet asked for
    this.staging = [];                 // built, on their way to the GPU
    this.grave = [];                   // [frame, geometry]
    this.gen = 0; this.nextId = 1; this.frame = 0; this.planT = 0; this.last = new THREE.Vector3(1e12, 0, 0);
    this.fails = 0; this.pauseUntil = 0; this.enabled = true; this.warned = false;
    this.stats = { bytes: 0, fetched: 0, built: 0, failed: 0, fetchMs: 0, parseMs: 0, buildMs: 0, maxBuildMs: 0, tris: 0, verts: 0, gpuBytes: 0, meshes: 0,
      bridge: { tris: 0, verts: 0, gpuBytes: 0, meshes: 0, count: 0, built: 0, planMs: 0, buildMs: 0, maxMs: 0, extraTiles: 0, extraBytes: 0, late: 0 } };
    this.setQuality('high');
    this.layout();
    this.worker = null;
    try {
      this.worker = new Worker(new URL('./cities.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => { console.warn('City worker failed:', e.message); this.enabled = false; };
    } catch (e) { console.warn('Cities are off (no worker):', e.message); this.enabled = false; }
  }

  /** Take the tiles from another server of the same schema (the address of its TileJSON), a mirror of one's own say. */
  setSource(url) { this.worker?.postMessage({ type: 'source', url }); this.pauseUntil = 0; this.fails = 0; }

  /**
   * Fetch the wall materials (public/facades: photographed surfaces and facades from ambientCG, CC0) into one array
   * texture, a layer each with its mipmaps. Until they are in, and if they never arrive, walls are drawn as before.
   */
  async loadFacades() {
    try {
      const man = await (await fetch(`${FACADE_URL}manifest.json`)).json(), S = man.size, L = man.layers.slice(0, FAC_N);
      const data = new Uint8Array(S * S * 4 * FAC_N).fill(128);
      const cv = new OffscreenCanvas(2 * S, S), cx = cv.getContext('2d', { willReadFrequently: true });
      await Promise.all(L.map(async (l, i) => {
        const bmp = await createImageBitmap(await (await fetch(FACADE_URL + l.file)).blob());
        l.bmp = bmp; l.i = i;
      }));
      for (const l of L) {
        cx.clearRect(0, 0, 2 * S, S); cx.drawImage(l.bmp, 0, 0); l.bmp.close();
        const px = cx.getImageData(0, 0, 2 * S, S).data, out = data.subarray(l.i * S * S * 4, (l.i + 1) * S * S * 4), fac = l.kind === 'facade';
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const a = (y * 2 * S + x) * 4, o = (y * S + x) * 4;
          out[o] = px[a]; out[o + 1] = px[a + 1]; out[o + 2] = px[a + 2]; out[o + 3] = fac ? px[a + S * 4] : 0;     // (the mask is the right-hand half)
        }
        this.uFacA.value[l.i].set(l.w, l.h, l.cols, l.rows);
        this.uFacB.value[l.i].set(Math.max(l.mean[0], 0.01), Math.max(l.mean[1], 0.01), Math.max(l.mean[2], 0.01), l.kind === 'facade' ? (l.glassTint ? 1 : 0) : l.strength ?? 0.6);
      }
      const t = new THREE.DataArrayTexture(data, S, S, FAC_N);
      t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true; t.anisotropy = this.renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true;
      this.uFacTex.value.dispose(); this.uFacTex.value = t; this.uFacOn.value = 1;
    } catch (e) { console.warn('wall materials not loaded', e); }
  }

  /** 'low' | 'med' | 'high': how far each level of detail reaches. */
  setQuality(level) {
    const t = TIERS[level] || TIERS.med;
    this.R0 = t.R0; this.R1 = t.R1; this.SKY = t.SKY;
    this.RB = t.R1 + BRIDGE_FAR; this.RBN = t.R0 + 300;
    this.uFade.value.set(t.R0 - FADE, t.R0);
    this.uRoadFade.value.set(t.R0 * 0.6, t.R0 * 0.95);
  }

  /** The tile grid in the world as it is now. */
  layout() {
    this.mpp = metersPerPixel(Z); this.size = 256 * this.mpp;
    this.px0 = pixelX(0, Z); this.py0 = pixelY(0, Z);
  }
  tileX(x) { return Math.floor((this.px0 + x / this.mpp) / 256); }
  tileY(z) { return Math.floor((this.py0 + z / this.mpp) / 256); }
  key(tx, ty) { return tx * 32768 + ty; }

  /** Let go of everything: the window of the world is about to move (or has), and tile-local meters with it. */
  reset() {
    this.gen++;
    for (const t of this.tiles.values()) this.dropTile(t);
    this.traffic.clear();
    this.tiles.clear(); this.info.clear(); this.sky.clear(); this.jobs.clear(); this.queue.length = 0; this.staging.length = 0; this.waiting.length = 0;
    this.worker?.postMessage({ type: 'forget' });
    this.layout();
    this.planT = 0; this.last.set(1e12, 0, 0); this.coverAt = [1e12, 1e12]; this.coverDirty = true;
  }

  // ---------------------------------------------------------------- tiles and levels

  tile(tx, ty) {
    const k = this.key(tx, ty);
    let t = this.tiles.get(k);
    if (!t) {
      const x0 = (tx * 256 - this.px0) * this.mpp, z0 = (ty * 256 - this.py0) * this.mpp;
      t = { key: k, tx, ty, x0, z0, mid: null, tall: null, bn: null, bf: null, near: [null, null, null, null], want: 0, dist: 0, mask: [-1, -1] };
      this.tiles.set(k, t);
    }
    return t;
  }

  level(t, name, q) { return name === 'near' ? t.near[q] : t[name]; }
  setLevel(t, name, q, L) { if (name === 'near') t.near[q] = L; else t[name] = L; }

  dropLevel(t, name, q) {
    const L = this.level(t, name, q);
    if (!L) return;
    const bridge = name === 'bn' || name === 'bf';
    for (const m of L.meshes) { const s = bridge ? this.stats.bridge : this.stats; this.group.remove(m); m.visible = false; this.grave.push([this.frame, m.geometry]); s.tris -= m.userData.tris; s.verts -= m.userData.verts; s.gpuBytes -= m.userData.bytes; s.meshes--; }
    if (L.lamps) { this.group.remove(L.lamps); L.lamps.geometry.dispose(); }
    if (L.road) { this.group.remove(L.road); L.road.geometry.dispose(); }
    if (L.cars) { this.traffic.remove(L.cars); L.cars = null; }
    if (L.shade) { this.group.remove(L.shade); L.shade.geometry.dispose(); }
    if (bridge && L.state === 'ready') this.stats.bridge.count -= L.count || 0;
    if (name === 'near' || bridge) this.coverDirty = true;
    if (!bridge) this.builtCount = (this.builtCount || 0) + 1;       // lets others notice that buildings have arrived (main.js refreshes the baked shadows)
    L.dead = true;
    this.setLevel(t, name, q, null);
  }
  dropTile(t) { this.dropLevel(t, 'mid'); this.dropLevel(t, 'tall'); this.dropLevel(t, 'bn'); this.dropLevel(t, 'bf'); for (let q = 0; q < 4; q++) this.dropLevel(t, 'near', q); }

  /** Heights of the ground on a grid over a square of a tile, from elevation of zoom `zoom` (or the best there is, when that never came). */
  groundGrid(t, lx, lz, span, n, zoom, late) {
    const x0 = t.x0 + lx, z0 = t.z0 + lz, step = span / (n - 1);
    const ready = dem.ensure(zoom, x0 + 12, z0 + 12, x0 + span - 12, z0 + span - 12, 6);
    if (!ready && !late) return null;
    const h = new Float32Array(n * n);
    if (ready) dem.sampleGrid(zoom, x0, z0, step, n, h, null);
    else for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = dem.heightAt(x0 + i * step, z0 + j * step);
    const flats = flatsIn(x0, z0, x0 + span, z0 + span);
    for (let j = 0, k = 0; j < n; j++) for (let i = 0; i < n; i++, k++) { const v = h[k] > 0 ? h[k] : 0; h[k] = flats.length ? applyFlats(flats, x0 + i * step, z0 + j * step, v) : v; }
    return { n, x0: lx, z0: lz, step, h };
  }

  /** Where buildings must not stand in a tile: inside an airport's boundary (the airfield draws its own). */
  skipFor(t) {
    const rings = [], boxes = [], s = this.size;
    for (const a of AIRPORTS) {
      const b = a.box;
      if (!b || b[0] > t.x0 + s || b[2] < t.x0 || b[1] > t.z0 + s || b[3] < t.z0) continue;
      if (a.fence && a.fence.length >= 6) { const r = new Float32Array(a.fence.length); for (let i = 0; i < r.length; i += 2) { r[i] = a.ox + a.fence[i] - t.x0; r[i + 1] = a.oz + a.fence[i + 1] - t.z0; } rings.push(r); }
      else for (const bd of a.buildings) { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (let i = 0; i < bd.p.length; i += 2) { x0 = Math.min(x0, bd.p[i]); x1 = Math.max(x1, bd.p[i]); z0 = Math.min(z0, bd.p[i + 1]); z1 = Math.max(z1, bd.p[i + 1]); } boxes.push(a.ox + x0 - t.x0 - 6, a.oz + z0 - t.z0 - 6, a.ox + x1 - t.x0 + 6, a.oz + z1 - t.z0 + 6); }
    }
    return { rings, boxes: Float32Array.from(boxes) };
  }

  /** Ask the worker for a level of a tile. False if the ground under it is not loaded yet (it has been asked for). */
  request(t, name, q, now) {
    const half = this.size / 2;
    const L = this.level(t, name, q);
    if (name === 'bn' || name === 'bf') {
      // bridges, first step: the worker puts them together and says where it needs the ground (see ground())
      const id = this.nextId++;
      this.jobs.set(id, { tile: t, level: name, quad: 0, gen: this.gen, L });
      L.state = 'building';
      this.worker.postMessage({ type: 'bplan', id, key: t.key, z: Z, x: t.tx, y: t.ty, level: name, size: this.size });
      return true;
    }
    const late = now - L.since > 3500;
    const ground = name === 'near' ? this.groundGrid(t, (q & 1) * half, (q >> 1) * half, half, 65, dem.MAX_Z, late)
      : this.groundGrid(t, 0, 0, this.size, name === 'mid' ? 65 : 33, name === 'mid' ? (t.dist < 4500 ? 13 : 12) : 11, late);
    if (!ground) return false;
    const id = this.nextId++;
    this.jobs.set(id, { tile: t, level: name, quad: q, gen: this.gen, L });
    L.state = 'building';
    this.worker.postMessage({ type: 'build', id, key: t.key, z: Z, x: t.tx, y: t.ty, level: name, quad: q, size: this.size, ground, skip: this.skipFor(t) }, [ground.h.buffer]);
    return true;
  }

  onMessage(m) {
    const job = this.jobs.get(m.id);
    if (!job) return;
    this.jobs.delete(m.id);
    const { tile: t, level: name, quad: q, L } = job;
    if (job.gen !== this.gen || L.dead) return;
    const now = performance.now();
    if (m.type === 'failed') {
      this.stats.failed++; this.fails++;
      L.state = 'failed'; L.tries = (L.tries || 0) + 1; L.retry = now + Math.min(60000, 4000 * 2 ** L.tries);
      if (this.fails >= 5) {            // the server is not answering: leave it alone for a while, and say so once
        this.pauseUntil = now + 30000; this.fails = 0;
        if (!this.warned) { this.warned = true; console.warn('Buildings could not be fetched (' + m.error + '): carrying on without them, and trying again every half minute.'); }
      }
      return;
    }
    this.fails = 0; this.warned = false;
    const s = this.stats;
    if (m.bytes) { s.bytes += m.bytes; s.fetched += m.fetched || 1; s.fetchMs += m.ms.fetch; s.parseMs += m.ms.parse; }
    if (m.total !== undefined) this.learn(t, m.tall, m.total, m.bridges);
    if (m.type === 'bplan' || m.bridge) {
      const b = s.bridge;
      if (m.extra) { b.extraTiles += m.extra; b.extraBytes += m.extraBytes; }
      if (m.type === 'bplan') {
        // the plan is back: the job waits (holding no place in the queue) until the ground under it has loaded
        b.planMs += m.ms.build; L.planMs = m.ms.build;
        this.waiting.push({ id: m.id, tile: t, level: name, gen: job.gen, L, pts: m.pts, since: now, cells: null });
        return;
      }
      if (m.coll) { b.built++; b.buildMs += m.ms.build; const all = m.ms.build + (L.planMs || 0); if (all > b.maxMs) b.maxMs = all; }
      L.data = m.chunks; L.coll = m.coll; L.shadeData = m.shade; L.lampData = m.lamps; L.count = m.count; L.staged = 0; L.state = 'staging';
      this.staging.push({ t, name, q, L });
      return;
    }
    s.built++; s.buildMs += m.ms.build; if (m.ms.build + m.ms.parse > s.maxBuildMs) s.maxBuildMs = m.ms.build + m.ms.parse;
    L.data = m.chunks; L.foot = m.foot; L.lights = m.lights; L.roadData = m.roads; L.count = m.count; L.staged = 0; L.state = 'staging';
    this.staging.push({ t, name, q, L });
  }

  /** A tile has shown what it holds: where there are towers, look at its neighbors too. */
  learn(t, tall, total, bridges = 0) {
    this.info.set(t.key, { tall, total, bridges });
    const e = this.sky.get(t.key);
    if (tall >= 1 && !e) this.sky.set(t.key, { tx: t.tx, ty: t.ty, depth: 4 });
    const depth = e ? e.depth : 4;
    if (tall >= 2 && depth < 7) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = this.key(t.tx + dx, t.ty + dy); if (!this.sky.has(k)) this.sky.set(k, { tx: t.tx + dx, ty: t.ty + dy, depth: depth + 1 }); }
  }

  /**
   * Bridges, second step: once the elevation under a plan's points has loaded (or has been waited for long enough),
   * read the ground there and send it to the worker, which then builds. The near level reads the finest
   * elevation; the far level what the mid buildings of the tile stand on.
   */
  ground(now) {
    const s = this.size;
    for (let i = 0; i < this.waiting.length; i++) {
      const w = this.waiting[i], t = w.tile, p = w.pts, n = p.length / 2;
      if (w.gen !== this.gen || w.L.dead) { this.waiting.splice(i--, 1); continue; }
      const zoom = w.level === 'bn' ? dem.MAX_Z : t.dist < 4500 ? 13 : 12, late = now - w.since > 3500;
      if (!w.cells) {
        // where the points lie: this tile, and here and there beyond it (a bridge that runs on into the next)
        const seen = new Set(); w.cells = []; w.box = [Infinity, Infinity, -Infinity, -Infinity];
        for (let k = 0; k < n; k++) {
          const x = p[2 * k], z = p[2 * k + 1], b = w.box;
          if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x; if (z < b[1]) b[1] = z; if (z > b[3]) b[3] = z;
          if (x >= 0 && x <= s && z >= 0 && z <= s) continue;
          const key = Math.floor(x / 300) * 4096 + Math.floor(z / 300);
          if (!seen.has(key)) { seen.add(key); w.cells.push(x, z); }
        }
      }
      let ready = dem.ensure(zoom, t.x0 + Math.max(w.box[0], 0) - 30, t.z0 + Math.max(w.box[1], 0) - 30, t.x0 + Math.min(w.box[2], s) + 30, t.z0 + Math.min(w.box[3], s) + 30, 6);
      for (let k = 0; k < w.cells.length; k += 2) if (!dem.ensure(zoom, t.x0 + w.cells[k] - 160, t.z0 + w.cells[k + 1] - 160, t.x0 + w.cells[k] + 160, t.z0 + w.cells[k + 1] + 160, 7)) ready = false;
      if (!ready && !late) continue;
      if (!ready) this.stats.bridge.late++;
      const h = new Float32Array(n), flats = flatsIn(t.x0 + w.box[0], t.z0 + w.box[1], t.x0 + w.box[2], t.z0 + w.box[3]);
      for (let k = 0; k < n; k++) { const x = t.x0 + p[2 * k], z = t.z0 + p[2 * k + 1], v = Math.max(dem.heightAt(x, z, zoom), 0); h[k] = flats.length ? applyFlats(flats, x, z, v) : v; }
      this.jobs.set(w.id, { tile: t, level: w.level, quad: 0, gen: w.gen, L: w.L });
      this.worker.postMessage({ type: 'bbuild', id: w.id, h, detail: w.level === 'bn' ? 0 : 1 }, [h.buffer]);
      this.waiting.splice(i--, 1);
    }
  }

  /** Hand the next chunks of built levels to the GPU, a bounded number of bytes a frame; show a level once all of it is there. */
  stage() {
    let budget = UPLOAD;
    for (let i = 0; i < this.staging.length; i++) {
      const S = this.staging[i], L = S.L, t = S.t;
      if (L.dead) { this.staging.splice(i--, 1); continue; }
      while (L.staged < L.data.length && budget > 0) {
        const c = L.data[L.staged++];
        const g = new THREE.BufferGeometry();
        const attr = (name, arr, size, norm) => { const a = new THREE.BufferAttribute(arr, size, norm); a.onUpload(function () { this.array = null; }); g.setAttribute(name, a); };      // the GPU's copy is the only one kept
        attr('position', c.pos, 3, false); attr('aN', c.nrm, 4, true); attr('aUV', c.uv, 2, false); attr('aCol', c.col, 4, true); attr('aK', c.k, 4, false);
        const ix = new THREE.BufferAttribute(c.idx, 1); ix.onUpload(function () { this.array = null; }); g.setIndex(ix);
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(c.bounds[0], c.bounds[1], c.bounds[2]), c.bounds[3] + 2);
        const bridge = S.name === 'bn' || S.name === 'bf';
        const mesh = new THREE.Mesh(g, bridge ? this.bridgeMats : this.mats);
        mesh.position.set(t.x0, 0, t.z0); mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.updateMatrixWorld(true);
        mesh.frustumCulled = false;              // for its first frame: in the scene with nothing to draw, so its buffers go up now
        const bytes = c.verts * 28 + c.idx.length * 2;
        mesh.userData = { ranges: c.ranges, mask: 0, tris: c.tris, verts: c.verts, bytes, cityCaster: false };
        this.group.add(mesh); L.meshes.push(mesh);
        const s = bridge ? this.stats.bridge : this.stats; s.tris += c.tris; s.verts += c.verts; s.gpuBytes += bytes; s.meshes++;
        budget -= bytes; L.stagedAt = this.frame;
      }
      if (L.staged < L.data.length) break;                    // out of budget: the rest next frame
      if (this.frame <= L.stagedAt) continue;                 // its last chunk went in this frame: shown from the next
      for (const m of L.meshes) m.frustumCulled = true;
      if (L.lights && L.lights.length && S.name !== 'near') {
        const n = L.lights.length / 4, pos = new Float32Array(n * 3), fl = new Float32Array(n);
        for (let k = 0; k < n; k++) { pos[k * 3] = L.lights[k * 4]; pos[k * 3 + 1] = L.lights[k * 4 + 1]; pos[k * 3 + 2] = L.lights[k * 4 + 2]; fl[k] = L.lights[k * 4 + 3]; }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aFlash', new THREE.BufferAttribute(fl, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(this.size / 2, 500, this.size / 2), this.size + 800);
        L.lamps = new THREE.Points(g, this.lampMat); L.lamps.position.set(t.x0, 0, t.z0); L.lamps.matrixAutoUpdate = false; L.lamps.updateMatrix(); L.lamps.updateMatrixWorld(true);
        L.lamps.visible = false; L.lamps.renderOrder = 5;
        L.lamps.onBeforeRender = (r) => { const rt = r.getRenderTarget(); this.uViewH.value = rt ? rt.height : r.domElement.height; };
        this.group.add(L.lamps);
      }
      if (L.roadData) {
        const d = L.roadData, g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); g.setAttribute('aR', new THREE.BufferAttribute(d.ar, 3)); g.setIndex(new THREE.BufferAttribute(d.idx, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(d.bounds[0], d.bounds[1], d.bounds[2]), d.bounds[3]);
        L.road = new THREE.Mesh(g, this.roadMat); L.road.position.set(t.x0, 0, t.z0); L.road.matrixAutoUpdate = false; L.road.updateMatrix(); L.road.updateMatrixWorld(true);
        L.road.renderOrder = -8; L.road.visible = false;
        this.group.add(L.road);
        if (d.paths) L.cars = this.traffic.add(d.paths, t.x0, t.z0, Math.round(t.x0 * 0.37 + t.z0 * 0.91 + d.bounds[0] * 3 + d.bounds[2] * 7));
      }
      if (L.shadeData) {
        // the strips of shade on the ground under the decks
        const d = L.shadeData, g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3)); g.setAttribute('aS', new THREE.BufferAttribute(d.a, 4)); g.setIndex(new THREE.BufferAttribute(d.idx, 1));
        g.computeBoundingSphere(); g.boundingSphere.radius += 400;          // (the cast shadow lies down-sun of where the strip is)
        const m = L.shade = new THREE.Mesh(g, this.shadeMat);
        m.position.set(t.x0, 0, t.z0); m.matrixAutoUpdate = false; m.updateMatrix(); m.updateMatrixWorld(true); m.renderOrder = -7; m.visible = false; this.group.add(m);
      }
      if (L.lampData && L.lampData.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(L.lampData, 3));
        g.computeBoundingSphere();
        L.lamps = new THREE.Points(g, this.bridgeLampMat); L.lamps.position.set(t.x0, 0, t.z0); L.lamps.matrixAutoUpdate = false; L.lamps.updateMatrix(); L.lamps.updateMatrixWorld(true);
        L.lamps.visible = false; L.lamps.renderOrder = 5;
        L.lamps.onBeforeRender = (r) => { const rt = r.getRenderTarget(); this.uViewH.value = rt ? rt.height : r.domElement.height; };
        this.group.add(L.lamps);
      }
      if (L.coll) this.stats.bridge.count += L.count || 0;
      L.data = null; L.lights = null; L.roadData = null; L.shadeData = null; L.lampData = null; L.state = 'ready';
      if (S.name !== 'tall') this.coverDirty = true;
      this.staging.splice(i--, 1);
    }
  }

  /** Show quarters `mask` (bits 0..3) of a level's meshes. */
  show(L, mask, caster) {
    for (const m of L.meshes) {
      const u = m.userData;
      u.cityCaster = caster && mask !== 0;
      if (u.mask === mask) continue;
      u.mask = mask;
      const g = m.geometry; g.clearGroups();
      let start = -1, count = 0;
      for (let q = 0; q < 4; q++) {
        const s = u.ranges[q * 2], c = u.ranges[q * 2 + 1];
        if (!(mask & (1 << q)) || !c) continue;
        if (start >= 0 && start + count === s) count += c;
        else { if (count) g.addGroup(start, count, 0); start = s; count = c; }
      }
      if (count) g.addGroup(start, count, 0);
      m.visible = g.groups.length > 0;
    }
  }

  // ---------------------------------------------------------------- what is wanted

  /** Work out which tiles are wanted at which level, drop what has been left behind, and line up the requests. */
  plan(cam, agl) {
    const s = this.size, R0 = this.R0, R1 = this.R1, SKY = this.SKY, half = s / 2, RB = this.RB, RBN = this.RBN;
    const cx = this.tileX(cam.x), cy = this.tileY(cam.z), n = Math.ceil((RB + 1500) / s) + 1;
    const rect = (x0, z0, w) => Math.hypot(Math.max(x0 - cam.x, 0, cam.x - x0 - w), Math.max(z0 - cam.z, 0, cam.z - z0 - w));
    for (const t of this.tiles.values()) t.want = 0;
    const inWorld = (t) => Math.abs(t.x0 + half) < LAND_HALF + 12000 && Math.abs(t.z0 + half) < LAND_HALF + 12000;
    // bits of want: 1 mid, 2 tall, 16 << q near; 4 keep mid, 8 keep tall, 256 << q keep near; bridges: 4096 far, 8192 keep it, 16384 near, 32768 keep it
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const tx = cx + i, ty = cy + j, x0 = (tx * 256 - this.px0) * this.mpp, z0 = (ty * 256 - this.py0) * this.mpp;
      const d = rect(x0, z0, s);
      if (d > RB + 1500) continue;
      const known = this.info.get(this.key(tx, ty));
      const noBld = d > R1 + 1500 || (known && known.total === 0), noBr = known && !known.bridges;
      if (noBld && noBr) continue;                              // open country: nothing to draw, nothing to ask again
      const t = this.tile(tx, ty);
      if (!inWorld(t)) continue;
      t.dist = d;
      if (!noBld) {
        t.want |= d < R1 ? 1 | 4 : 4;
        for (let q = 0; q < 4; q++) {
          const dq = Math.hypot(rect(x0 + (q & 1) * half, z0 + (q >> 1) * half, half), agl);
          if (dq < R0) t.want |= (16 | 256) << q; else if (dq < R0 + 500) t.want |= 256 << q;
        }
      }
      if (!noBr) {
        t.want |= d < RB ? 4096 | 8192 : 8192;
        const dn = Math.hypot(d, agl);
        if (dn < RBN) t.want |= 16384 | 32768; else if (dn < RBN + 600) t.want |= 32768;
      }
    }
    // the skyline: the middle of every big town within reach, and wherever towers have turned up
    for (const town of townList()) {
      if (town.pop < SEED_POP || Math.hypot(town.x - cam.x, town.z - cam.z) > SKY) continue;
      const tx = this.tileX(town.x), ty = this.tileY(town.z), r = town.pop >= CORE_POP ? 1 : 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const k = this.key(tx + i, ty + j); if (!this.sky.has(k)) this.sky.set(k, { tx: tx + i, ty: ty + j, depth: i || j ? 1 : 0 }); }
    }
    for (const [k, e] of this.sky) {
      const known = this.info.get(k);
      if (known && known.tall === 0) continue;
      const x0 = (e.tx * 256 - this.px0) * this.mpp, z0 = (e.ty * 256 - this.py0) * this.mpp, d = rect(x0, z0, s);
      if (d > SKY + 5000) continue;
      const t = this.tile(e.tx, e.ty);
      if (!inWorld(t)) continue;
      t.dist = d;
      // inside the mid range the mid level shows the towers; the tall level is made as the tile leaves it
      if (!(t.want & 1) || (t.mid && t.mid.state !== 'ready')) t.want |= d < SKY ? 2 | 8 : 8;
      else if (t.tall) t.want |= 8;
    }
    // drop, and queue
    this.queue.length = 0;
    const now = performance.now();
    const ask = (t, name, q, prio) => {
      let L = this.level(t, name, q);
      if (!L) { L = { state: 'queued', meshes: [], lamps: null, road: null, foot: null, since: now, dead: false }; this.setLevel(t, name, q, L); }
      if (L.state === 'queued' || (L.state === 'failed' && now > L.retry)) this.queue.push({ t, name, q, prio, L });
    };
    for (const t of this.tiles.values()) {
      if (!(t.want & 4) && t.mid) this.dropLevel(t, 'mid');
      if (!(t.want & 8) && t.tall) this.dropLevel(t, 'tall');
      for (let q = 0; q < 4; q++) if (!(t.want & (256 << q)) && t.near[q]) this.dropLevel(t, 'near', q);
      if (!(t.want & 8192) && t.bf) this.dropLevel(t, 'bf');
      if (!(t.want & 32768) && t.bn) this.dropLevel(t, 'bn');
      if (!t.want) { this.tiles.delete(t.key); continue; }
      if ((t.want & 4096) && this.bridges) ask(t, 'bf', 0, t.dist + 800);
      if ((t.want & 16384) && this.bridges) ask(t, 'bn', 0, t.dist + 150);
      if (t.want & 1) ask(t, 'mid', 0, t.dist + 500);
      if (t.want & 2) ask(t, 'tall', 0, 2500 + t.dist * 0.25);
      for (let q = 0; q < 4; q++) if (t.want & (16 << q)) ask(t, 'near', q, t.dist);
    }
    this.queue.sort((a, b) => a.prio - b.prio);
  }

  /** Send queued requests while the worker has room. */
  dispatch() {
    const now = performance.now();
    if (!this.worker || now < this.pauseUntil) return;
    this.ground(now);
    let i = 0;
    while (this.jobs.size < MAX_JOBS && i < this.queue.length) {
      const j = this.queue[i];
      if (j.L.dead || (j.L.state !== 'queued' && j.L.state !== 'failed')) { this.queue.splice(i, 1); continue; }
      if (this.request(j.t, j.name, j.q, now)) this.queue.splice(i, 1); else i++;
    }
  }

  /** Which level shows in each quarter of each tile; which meshes throw shadows. */
  display() {
    for (const t of this.tiles.values()) {
      let nearMask = 0, midMask = 0, tallMask = 0;
      const mid = t.mid && t.mid.state === 'ready', tall = t.tall && t.tall.state === 'ready';
      for (let q = 0; q < 4; q++) {
        const N = t.near[q];
        if (N && N.state === 'ready' && (t.want & (256 << q))) nearMask |= 1 << q;
        else if (mid) midMask |= 1 << q;
        else if (tall) tallMask |= 1 << q;
      }
      const close = t.dist < 2600;
      for (let q = 0; q < 4; q++) { const N = t.near[q]; if (N && N.state === 'ready') { this.show(N, nearMask & (1 << q) ? 15 : 0, close); if (N.road) N.road.visible = this.roads && !!(nearMask & (1 << q)); if (N.cars) N.cars.on = !!N.road?.visible; } }
      if (mid) this.show(t.mid, midMask, close);
      if (tall) this.show(t.tall, tallMask, false);
      const lampsOn = this.uLevel.value > 0;
      if (t.mid?.lamps) t.mid.lamps.visible = lampsOn && mid;
      if (t.tall?.lamps) t.tall.lamps.visible = lampsOn && tall && !mid;
      // bridges: the near level where it is wanted and ready, else the far one
      const bn = t.bn && t.bn.state === 'ready', bf = t.bf && t.bf.state === 'ready', useN = bn && !!(t.want & 32768);
      for (const [L, on] of [[t.bn, bn && useN && this.bridges], [t.bf, bf && !useN && this.bridges]]) {
        if (!L || L.state !== 'ready') continue;
        this.show(L, on ? 3 : 0, close);
        if (L.shade) L.shade.visible = on && (this.uShade.value.x > 0 || this.uShade.value.y > 0);
        if (L.lamps) L.lamps.visible = on && this.uBridgeLamp.value > 0;
      }
    }
  }

  // ---------------------------------------------------------------- the coverage map

  /** Redraw the top-down map of where buildings stand, when the camera has moved a block or the near level has changed. */
  cover(cam) {
    const snap = 256, cx = Math.round(cam.x / snap) * snap, cz = Math.round(cam.z / snap) * snap;
    if (cx !== this.coverAt[0] || cz !== this.coverAt[1]) this.coverDirty = true;
    const now = performance.now();
    if (!this.coverDirty || now < this.coverT) return;            // at most a couple of times a second
    this.coverT = now + 400; this.coverDirty = false; this.coverAt = [cx, cz];
    const W = COVER_N * COVER_M, r = this.renderer, list = [];
    for (const t of this.tiles.values()) {
      if (t.x0 > cx + W / 2 || t.x0 + this.size < cx - W / 2 || t.z0 > cz + W / 2 || t.z0 + this.size < cz - W / 2) continue;
      for (const L of [...t.near, t.mid, t.bn, t.bf]) if (L && L.state === 'ready') for (const m of L.meshes) if (m.visible) list.push(m);
    }
    const c = this.coverCam;
    c.left = -W / 2; c.right = W / 2; c.top = W / 2; c.bottom = -W / 2; c.near = 1; c.far = 20000; c.updateProjectionMatrix();
    c.position.set(cx, 12000, cz); c.up.set(0, 0, -1); c.lookAt(cx, 0, cz); c.updateMatrixWorld();
    const prev = r.getRenderTarget(), alpha = r.getClearAlpha(), auto = r.autoClear, sAuto = r.shadowMap.autoUpdate;
    r.getClearColor(tmpC); r.setClearColor(0x000000, 0); r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    this.coverScene.children = list;
    r.setRenderTarget(this.coverRaw); r.render(this.coverScene, c);
    this.coverScene.children = [];
    this.quad.draw(r, this.spreadMat, this.coverRT);
    r.autoClear = auto; r.shadowMap.autoUpdate = sAuto; r.setClearColor(tmpC, alpha); r.setRenderTarget(prev);
    this.coverHas = list.length > 0;
    ENV.uBldCover.value.set(cx, cz, 1 / W, this.coverHas ? 1 : 0);
  }

  // ---------------------------------------------------------------- questions

  /**
   * The building standing at a point of the world, if any: { top, base } heights (m) of its roof (the top of
   * whatever stands on it) and of the foot of its walls. Null where there is none, or none loaded.
   */
  buildingAt(x, z) {
    const t = this.tiles.get(this.key(this.tileX(x), this.tileY(z)));
    if (!t) return null;
    const lx = x - t.x0, lz = z - t.z0, q = (lx >= this.size / 2 ? 1 : 0) + (lz >= this.size / 2 ? 2 : 0);
    const N = t.near[q];
    const L = N && N.state === 'ready' ? N : t.mid && t.mid.state === 'ready' ? t.mid : t.tall && t.tall.state === 'ready' ? t.tall : null;
    const f = L && L.foot;
    if (!f) return null;
    const b = f.box, p = f.pts;
    let best = null;
    for (let i = 0, k = 0; k < b.length; i++, k += 7) {
      if (lx < b[k] || lx > b[k + 2] || lz < b[k + 1] || lz > b[k + 3]) continue;
      let c = false;
      for (let a = f.start[i], e = f.start[i + 1], j = e - 2; a < e; j = a, a += 2) if ((p[a + 1] > lz) !== (p[j + 1] > lz) && lx < p[a] + ((lz - p[a + 1]) / (p[j + 1] - p[a + 1])) * (p[j] - p[a])) c = !c;
      if (c && (!best || b[k + 4] > best.top)) best = { top: b[k + 4], base: b[k + 5] };
    }
    return best;
  }
  /** Height of the roof at a point, or -Infinity where no building stands. */
  roofAt(x, z) { const b = this.buildingAt(x, z); return b ? b.top : -Infinity; }
  /** Is this point (a THREE.Vector3, the aircraft's position) inside a building? `r`: clearance wanted above the roof (m). */
  hit(p, r = 1.2) {
    if (!this.tiles.size) return false;
    const b = this.buildingAt(p.x, p.z);
    this.lastHit = 'building';
    if (!!b && p.y < b.top + r && p.y > b.base) return true;
    if (this.bridgeHit(p, r)) { this.lastHit = 'bridge'; return true; }
    return false;
  }

  /**
   * Bridges near a point: calls seg(top, under, above, d, hw) for each stretch of deck the point lies over or under
   * (top: the running surface's height there, under: the depth of the structure below it, above: the height of
   * what stands on it, d: meters from the center line, hw: half its width) and pier(u, v, a, b, top) for each
   * pier near it (u, v: the point's place across and along the pier; a, b: the pier's half-sizes). Either may
   * return true to stop. Decks and piers of the tile's neighbors are looked at within reach of its edges.
   */
  bridgesNear(x, z, reach, seg, pier) {
    const s = this.size, tx = this.tileX(x), ty = this.tileY(z);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const t = this.tiles.get(this.key(tx + i, ty + j));
      if (!t) continue;
      const L = t.bn && t.bn.state === 'ready' && t.bn.coll ? t.bn : t.bf && t.bf.state === 'ready' ? t.bf : null, C = L && L.coll;
      if (!C || !C.ids.length) continue;
      const lx = x - t.x0, lz = z - t.z0;
      if (lx < -reach || lz < -reach || lx > s + reach || lz > s + reach) continue;
      const G = C.G, cell = Math.min(G - 1, Math.max(0, Math.floor((lz / s) * G))) * G + Math.min(G - 1, Math.max(0, Math.floor((lx / s) * G)));
      const S = C.segs, P = C.piers, nSeg = S.length / 9;
      for (let k = C.start[cell]; k < C.start[cell + 1]; k++) {
        const id = C.ids[k];
        if (id < nSeg) {
          const o = id * 9, ex = S[o + 3] - S[o], ez = S[o + 4] - S[o + 1], l2 = ex * ex + ez * ez || 1, u = ((lx - S[o]) * ex + (lz - S[o + 1]) * ez) / l2;
          if (u < -0.01 || u > 1.01) continue;
          const d = Math.abs((lx - S[o]) * ez - (lz - S[o + 1]) * ex) / Math.sqrt(l2);
          if (d > S[o + 6] + reach) continue;
          if (seg && seg(S[o + 2] + (S[o + 5] - S[o + 2]) * u, S[o + 7], S[o + 8], d, S[o + 6], C)) return true;
        } else if (pier) {
          const o = (id - nSeg) * 7, dx = lx - P[o], dz = lz - P[o + 1], u = dx * P[o + 2] + dz * P[o + 3], v = -dx * P[o + 3] + dz * P[o + 2];
          if (Math.abs(u) > P[o + 4] + reach || Math.abs(v) > P[o + 5] + reach) continue;
          if (pier(u, v, P[o + 4], P[o + 5], P[o + 6])) return true;
        }
      }
    }
    return false;
  }
  /** Has this point (the aircraft) struck a bridge? The deck is a slab and the piers are piers: the air between and beneath them is free. */
  bridgeHit(p, r = 1.2) {
    const y = p.y;
    return this.bridgesNear(p.x, p.z, r,
      (top, under, above) => y < top + above + r && y > top - under - r,
      (u, v, a, b, top) => y < top + r);
  }
  /** Height of the highest bridge deck over a point that is no higher than `below` (m), or -Infinity where there is none. */
  deckAt(x, z, below = Infinity) {
    let best = -Infinity;
    this.bridgesNear(x, z, 0, (top) => { if (top <= below && top > best) best = top; return false; }, null);
    return best;
  }
  /** The bridge deck over a point, if any: { top, bottom } heights (m) of its running surface and of the underside of its structure (the highest, where decks are stacked). */
  bridgeAt(x, z) {
    let best = null;
    this.bridgesNear(x, z, 0, (top, under) => { if (!best || top > best.top) best = { top, bottom: top - under }; return false; }, null);
    return best;
  }
  /** Is there a building here? (For anything that places things on the ground from the main thread.) */
  covered(x, z) { return this.buildingAt(x, z) !== null; }
  /**
   * Raise a grid of ground heights to the roofs of the buildings that stand on it, for anything that marches a
   * height field toward the sun (world/groundlight.js fills its 40 m map from dem.sampleGrid the same way: with
   * this, a downtown throws its shadow across the land and the lower buildings for kilometers).
   * x0, z0: the first sample; step: spacing (m); n: samples a side; h: Float32Array(n * n), raised in place.
   * Only buildings at least minH meters high count. Returns how many samples were raised.
   */
  raise(x0, z0, step, n, h, minH = 18) {
    let raised = 0;
    const s = this.size, x1 = x0 + (n - 1) * step, z1 = z0 + (n - 1) * step;
    for (let ty = this.tileY(z0 - step); ty <= this.tileY(z1 + step); ty++) for (let tx = this.tileX(x0 - step); tx <= this.tileX(x1 + step); tx++) {
      const t = this.tiles.get(this.key(tx, ty));
      const L = t && (t.mid && t.mid.state === 'ready' ? t.mid : t.tall && t.tall.state === 'ready' ? t.tall : null);
      const f = L && L.foot;
      if (!f) continue;
      const b = f.box, p = f.pts, ox = t.x0 - x0, oz = t.z0 - z0;
      for (let i = 0, k = 0; k < b.length; i++, k += 7) {
        if (b[k + 4] - b[k + 6] < minH) continue;
        const i0 = Math.max(0, Math.round((b[k] + ox) / step)), i1 = Math.min(n - 1, Math.round((b[k + 2] + ox) / step));
        const j0 = Math.max(0, Math.round((b[k + 1] + oz) / step)), j1 = Math.min(n - 1, Math.round((b[k + 3] + oz) / step));
        const big = i1 - i0 > 1 && j1 - j0 > 1;              // wide enough for the samples to trace its outline
        for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
          if (big) {
            const lx = ii * step - ox, lz = j * step - oz; let c = false;
            for (let a = f.start[i], e = f.start[i + 1], q = e - 2; a < e; q = a, a += 2) if ((p[a + 1] > lz) !== (p[q + 1] > lz) && lx < p[a] + ((lz - p[a + 1]) / (p[q + 1] - p[a + 1])) * (p[q] - p[a])) c = !c;
            if (!c) continue;
          }
          if (b[k + 4] > h[j * n + ii]) { h[j * n + ii] = b[k + 4]; raised++; }
        }
      }
    }
    return raised;
  }
  /** How much of the near level around the camera is in the scene, 0..1 (the town lights dim by it). */
  nearShare() { let want = 0, have = 0; for (const t of this.tiles.values()) for (let q = 0; q < 4; q++) if (t.want & (16 << q)) { want++; if (t.near[q]?.state === 'ready') have++; } return want ? have / want : 0; }

  // ---------------------------------------------------------------- once a frame

  /**
   * dt: seconds; camera: the game's camera, placed for this frame; dark: 0 by day .. 1 at night (the lit
   * windows follow it); exposure: the eye's adaptation, which the lights are held back by.
   */
  update(dt, camera, dark = 0, exposure = 1, clock = null) {
    this.frame++;
    const cam = camera.position;
    if (this.enabled && this.worker) {
      const now = performance.now();
      if (now > this.planT || this.last.distanceTo(cam) > 150) {            // four times a second, or when the camera has jumped
        this.planT = now + 250; this.last.copy(cam);
        this.plan(cam, Math.max(0, cam.y - groundHeight(cam.x, cam.z)));
      }
      this.dispatch();
      this.stage();
    }
    // light: the windows come on at dusk, as the airfield lamps do
    const sky = ENV.uAmbSky.value, lum = sky.r * 0.25 + sky.g * 0.6 + sky.b * 0.15;
    const on = Math.max(1 - Math.min(1, Math.max(0, (lum - 0.035) / 0.11)), dark);
    this.uLit.value = on < 0.25 ? 0 : (0.42 * Math.min(1, (on - 0.25) / 0.45)) / Math.sqrt(Math.max(exposure, 1));
    this.uLevel.value = on < 0.04 ? 0 : (3 + 9 * on) / Math.sqrt(Math.max(exposure, 1));
    this.uBridgeLamp.value = on < 0.25 ? 0 : (1.5 + 3.5 * Math.min(1, (on - 0.25) / 0.45)) / Math.sqrt(Math.max(exposure, 1));
    this.display();
    // the traffic: clock = { time: seconds of game time, hour: the time of day }
    if (clock) this.traffic.update(clock.time, cam, this.uRoadFade.value.y, clock.hour, on);
    this.cover(cam);
    while (this.grave.length && this.frame - this.grave[0][0] > GRAVE) this.grave.shift()[1].dispose();
  }
}
