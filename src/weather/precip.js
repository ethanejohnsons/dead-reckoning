// Weather particles: rain, snow and hail around the camera, vapor rushing
// past inside cloud, condensation trails off the wingtips, and lightning.
//
// Falling particles live in a wrapping box centered on the camera. Each is a
// soft capsule stretched along its velocity relative to the viewer, so rain
// streaks sideways at cruise speed and snow blurs into the windshield.
// Everything is drawn in HDR before the cloud pass, so cloud and fog between
// the eye and a particle still dim it and bloom picks up the bright ones.
//
// Nothing falls inside the aircraft: every particle fragment is tested against
// the fuselage (a tube of superellipse sections, in the aircraft's own axes)
// and dropped if it is inside, so precipitation is seen only through the windows.
// Hail also strikes the airframe (see Impacts): stones bounce off the wing,
// cowl, windshield and tail and break up, and leave brief marks on the glass.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { warp } from '../aircraft/variants.js';

const MAX = 9000;

/**
 * The airframe as the weather sees it, in the aircraft's own axes (x right, y up, -z forward, meters). The defaults
 * are the Cessna 172 of aircraft/model.js; airframeFor() below gives another variant's.
 *   hull    fuselage stations, nose to tail: [z, top, bottom, half width, height of the widest point, superellipse exponent]
 *   cabin   [z0, z1] the part of the hull with windows (nothing is drawn inside the hull anywhere, this is for reference)
 *   cowl, screen, aft   [z0, z1] stretches of the hull's upper surface that hail lands on: engine cowl, windshield, rear fuselage
 *   wing    span, height of the upper surface at the root, rise to the tip, leading and trailing edge z, thickness
 *   stab    stabilizer: half span, height, leading and trailing edge z
 *   fin     leading edge from [z, y] at its foot to [z, y] at its tip, and its thickness
 */
export const AIRFRAME_172 = {
  hull: [
    [-1.92, 0.225, -0.235, 0.36, -0.01, 2.6], [-1.85, 0.28, -0.315, 0.44, -0.02, 2.6], [-1.73, 0.305, -0.365, 0.468, -0.03, 2.7], [-1.40, 0.34, -0.44, 0.492, -0.04, 2.8],
    [-1.00, 0.38, -0.52, 0.51, -0.05, 2.9], [-0.94, 0.40, -0.53, 0.513, -0.05, 2.9], [-0.78, 0.545, -0.555, 0.52, -0.03, 3.1], [-0.62, 0.69, -0.575, 0.527, -0.01, 3.3],
    [-0.47, 0.80, -0.59, 0.532, 0.0, 3.5], [-0.30, 0.86, -0.60, 0.535, 0.0, 3.6], [-0.05, 0.885, -0.60, 0.535, 0.0, 3.6], [0.35, 0.87, -0.60, 0.535, 0.0, 3.6],
    [0.80, 0.815, -0.59, 0.527, 0.0, 3.6], [1.16, 0.765, -0.565, 0.505, 0.0, 3.5], [1.60, 0.63, -0.50, 0.465, 0.01, 3.2], [2.00, 0.505, -0.42, 0.42, 0.03, 2.9],
    [2.40, 0.455, -0.335, 0.37, 0.06, 2.7], [3.20, 0.42, -0.18, 0.28, 0.12, 2.4], [4.20, 0.39, -0.01, 0.18, 0.19, 2.2], [5.00, 0.37, 0.11, 0.105, 0.24, 2.1], [5.75, 0.345, 0.225, 0.035, 0.285, 2.0],
  ],
  cabin: [-1.0, 2.1],
  cowl: [-1.88, -0.97], screen: [-0.93, -0.5], aft: [1.2, 4.3],
  wing: { span: 11, y: 0.9, rise: 0.12, zLE: -0.45, zTE: 1.12, thick: 0.17 },
  stab: { half: 1.72, y: 0.34, zLE: 4.75, zTE: 5.9 },
  fin: { foot: [4.4, 0.36], tip: [5.4, 1.52], thick: 0.1 },
};
/** The airframe of a variant (aircraft/variants.js): the 172's, every point moved as the variant's model moves it (warp). */
export function airframeFor(geom) {
  const A = AIRFRAME_172, p = [];
  const at = (x, y, z) => warp(geom, x, y, z, p);
  const Z = (z) => at(0, 0, z)[2];
  const Y = (y, z) => at(0, y, z)[1];
  return {
    hull: A.hull.map(([z, top, bot, hw, ym, e]) => [Z(z), Y(top, z), Y(bot, z), at(hw, 0, z)[0], Y(ym, z), e]),
    cabin: A.cabin.map(Z), cowl: A.cowl.map(Z), screen: A.screen.map(Z), aft: A.aft.map(Z),
    wing: { ...A.wing, span: 2 * at(A.wing.span / 2, A.wing.y, 0)[0], y: Y(A.wing.y, 0), zLE: Z(A.wing.zLE), zTE: Z(A.wing.zTE) },
    stab: { ...A.stab, half: at(A.stab.half, A.stab.y, A.stab.zLE)[0], y: Y(A.stab.y, A.stab.zLE), zLE: Z(A.stab.zLE), zTE: Z(A.stab.zTE) },
    fin: { ...A.fin, foot: [Z(A.fin.foot[0]), Y(A.fin.foot[1], A.fin.foot[0])], tip: [Z(A.fin.tip[0]), Y(A.fin.tip[1], A.fin.tip[0])] },
  };
}
const HULL_PAD = 0.02;          // the clip volume stands this far outside the skin (m)

const FIELD_VERT = /* glsl */`
attribute vec2 aCorner;      // x: -1/+1 across, y: 0 head / 1 tail
attribute float aRand;
uniform vec3 uOffset, uStreak, uSunDir;
uniform float uBox, uRadius, uFlutter, uTime, uNear;
uniform vec2 uLayer;         // a field that hugs the ground: height of its middle relative to the camera, and its depth (0: it fills its box)
uniform vec3 uAcOff;         // the aircraft relative to the camera, world axes
uniform mat3 uAcInv;         // world axes to the aircraft's own
varying vec3 vLocal;         // x across, y along, z length; all in radii
varying vec3 vBody;          // this vertex in the aircraft's axes
varying float vFade, vMu, vRand;
void main() {
  vec3 q = mod(position * uBox + uOffset, uBox) - uBox * 0.5;      // camera-relative, world axes
  float lay = q.y / uBox;
  if (uLayer.y > 0.0) q.y = uLayer.x + lay * uLayer.y;
  q += vec3(sin(uTime * 1.7 + aRand * 40.0), 0.4 * cos(uTime * 1.3 + aRand * 23.0), cos(uTime * 1.1 + aRand * 57.0)) * uFlutter;
  float dist = length(q);
  float rad = uRadius * (0.55 + 0.9 * aRand);
  vec3 a = mat3(viewMatrix) * q;
  vec3 s = mat3(viewMatrix) * uStreak * (0.7 + 0.6 * fract(aRand * 7.3));
  // Build the capsule in the plane facing the eye.
  vec3 vdir = normalize(a + s * 0.5);
  vec3 sp = s - vdir * dot(s, vdir);
  float len = length(sp);
  vec3 ax = len > 1.0e-4 ? sp / len : normalize(cross(vdir, vec3(1.0, 0.0, 0.0)) + vec3(0.0, 1.0e-5, 0.0));
  vec3 side = cross(vdir, ax);
  vec3 pv = a + s * aCorner.y + ax * rad * (aCorner.y * 2.0 - 1.0) + side * rad * aCorner.x;
  vLocal = vec3(aCorner.x, aCorner.y > 0.5 ? len / rad + 1.0 : -1.0, len / rad);
  vFade = smoothstep(uNear, uNear * 3.0, dist);
  if (uLayer.y > 0.0) vFade *= (1.0 - smoothstep(uBox * 0.32, uBox * 0.5, length(q.xz))) * (1.0 - smoothstep(-0.1, 0.5, lay));   // thickest at the surface, thinning upward
  else vFade *= 1.0 - smoothstep(uBox * 0.32, uBox * 0.5, dist);
  vMu = dot(q / max(dist, 1.0e-3), uSunDir);
  vRand = aRand;
  vBody = uAcInv * (pv * mat3(viewMatrix) - uAcOff);                // (v * M: by the transpose, view axes back to world)
  gl_Position = projectionMatrix * vec4(pv, 1.0);
}`;

// True inside the fuselage: between two stations the section is a superellipse, as the model's hull is.
const HULL_GLSL = /* glsl */`
uniform vec4 uHull[HULL_N];      // z, top, bottom, half width at each station (padded a little)
uniform vec2 uHull2[HULL_N];     // height of the widest point, exponent
uniform vec3 uHullMax;           // greatest half width, greatest top, least bottom; x < 0 switches the test off
bool inHull(vec3 p) {
  if (abs(p.x) > uHullMax.x || p.y > uHullMax.y || p.y < uHullMax.z || p.z <= uHull[0].x || p.z >= uHull[HULL_N - 1].x) return false;
  for (int i = 0; i < HULL_N - 1; i++) {
    if (p.z < uHull[i + 1].x) {
      float t = (p.z - uHull[i].x) / (uHull[i + 1].x - uHull[i].x);
      vec4 a = mix(uHull[i], uHull[i + 1], t);
      vec2 b = mix(uHull2[i], uHull2[i + 1], t);
      float h = p.y > b.x ? a.y - b.x : b.x - a.z;
      return pow(abs(p.x) / a.w, b.y) + pow(abs(p.y - b.x) / h, b.y) < 1.0;
    }
  }
  return false;
}`;

const FIELD_FRAG = /* glsl */`
uniform vec3 uAmb, uSun;
uniform float uOpacity, uCore, uVary;
varying vec3 vLocal;
varying vec3 vBody;
varying float vFade, vMu, vRand;
${HULL_GLSL}
void main() {
  if (inHull(vBody)) discard;                 // nothing falls inside the aircraft
  float y = clamp(vLocal.y, 0.0, vLocal.z);
  float d = length(vec2(vLocal.x, vLocal.y - y));
  float a = (1.0 - smoothstep(uCore, 1.0, d)) * vFade * uOpacity;
  // A streak spreads one drop's light along its length.
  a *= mix(1.0, 0.55, clamp(vLocal.z / 60.0, 0.0, 1.0));
  if (a < 0.003) discard;
  // Water and ice throw sunlight forward: brightest looking toward the sun.
  float fwd = pow(max(vMu, 0.0), 6.0) * 2.5 + 0.25 + 0.2 * vMu;
  vec3 col = (uAmb + uSun * fwd) * (1.0 + uVary * (vRand - 0.5));
  gl_FragColor = vec4(col, a);
}`;

const TRAIL_VERT = /* glsl */`
attribute float aAlpha;
attribute float aSide;
varying float vA, vS;
void main() { vA = aAlpha; vS = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vA, vS;
void main() { float a = vA * (1.0 - vS * vS) * (1.0 - vS * vS); if (a < 0.003) discard; gl_FragColor = vec4(uColor, a); }`;

/**
 * Contrails: the exhaust of a jet freezing into a line of cloud behind each engine, in air cold enough for it
 * (about -38 C and below: the upper troposphere). One ribbon an engine, laid point by point along the path flown
 * and drifting with the wind; it starts a little way behind the nozzle, spreads as it ages and is gone in a minute.
 */
class Contrails {
  constructor(scene, ribbons = 4, points = 150) {
    const R = this.R = ribbons, N = this.N = points, n = R * N, idx = [];
    for (let t = 0; t < R; t++) for (let i = 0; i < N - 1; i++) { const a = (t * N + i) * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    const g = new THREE.BufferGeometry(), side = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n * 2), 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    this.u = { uColor: { value: new THREE.Color() } };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.visible = false;
    scene.add(this.mesh);
    this.p = Array.from({ length: R }, () => ({ x: new Float64Array(N), y: new Float64Array(N), z: new Float64Array(N), s: new Float32Array(N), age: new Float32Array(N).fill(999), head: 0, lx: 0, ly: 0, lz: 0 }));
    this.sources = [];                    // the nozzles, in the aircraft's axes (THREE.Vector3): set with the aircraft
    this.live = false;
    this.tip = new THREE.Vector3(); this.side = new THREE.Vector3(); this.tan = new THREE.Vector3(); this.toCam = new THREE.Vector3();
  }

  /** strength 0..1: how readily a trail forms here and now (0 still lets the trail already laid fade out). */
  update(dt, ac, strength, wind, camPos) {
    const n = Math.min(this.sources.length, this.R);
    if (!n || (!this.live && !(strength > 0))) { this.mesh.visible = false; return; }
    const LIFE = 55, N = this.N, pos = this.mesh.geometry.attributes.position, al = this.mesh.geometry.attributes.aAlpha;
    const { tip, side, tan, toCam } = this, step = Math.max(8, (ac.tas || 0) * 0.3);
    let any = false;
    for (let t = 0; t < this.R; t++) {
      const P = this.p[t];
      if (t >= n) { for (let k = 0; k < N; k++) { al.setX((t * N + k) * 2, 0); al.setX((t * N + k) * 2 + 1, 0); } continue; }
      tip.copy(this.sources[t]).applyQuaternion(ac.quat).add(ac.pos);
      for (let i = 0; i < N; i++) { P.age[i] += dt; P.x[i] += wind.x * dt; P.y[i] += (wind.y - 0.3) * dt; P.z[i] += wind.z * dt; }
      const moved = Math.hypot(tip.x - P.lx, tip.y - P.ly, tip.z - P.lz);
      if (moved > 40 * step) P.age.fill(999);                 // the aircraft was repositioned: drop the old trail
      if (moved > step) {
        P.head = (P.head + 1) % N;
        P.x[P.head] = tip.x; P.y[P.head] = tip.y; P.z[P.head] = tip.z; P.s[P.head] = strength; P.age[P.head] = 0;
        P.lx = tip.x; P.ly = tip.y; P.lz = tip.z;
      }
      for (let k = 0; k < N; k++) {
        const i = (P.head - k + N) % N, j = (P.head - Math.min(k + 1, N - 1) + N) % N, o = (t * N + k) * 2;
        const dead = k > 0 && P.age[i] > 900;
        const x = k === 0 || dead ? tip.x : P.x[i], y = k === 0 || dead ? tip.y : P.y[i], z = k === 0 || dead ? tip.z : P.z[i];
        const age = k === 0 ? 0 : P.age[i], life = Math.max(0, 1 - age / LIFE);
        // nothing for the first stretch behind the nozzle (the exhaust has not yet cooled), then full, then thinning
        const a = dead ? 0 : (k === 0 ? 0 : P.s[i]) * Math.pow(life, 1.3) * 0.62 * THREE.MathUtils.smoothstep(age, 0.12, 0.5);
        if (a > 0.004) any = true;
        tan.set(P.x[j] - x, P.y[j] - y, P.z[j] - z);
        toCam.set(camPos.x - x, camPos.y - y, camPos.z - z);
        side.crossVectors(tan, toCam);
        const sl = side.length();
        if (sl > 1e-6) side.multiplyScalar((0.7 + age * 0.38) / sl); else side.set(0, 0, 0);
        pos.setXYZ(o, x - ac.pos.x - side.x, y - ac.pos.y - side.y, z - ac.pos.z - side.z);
        pos.setXYZ(o + 1, x - ac.pos.x + side.x, y - ac.pos.y + side.y, z - ac.pos.z + side.z);
        al.setX(o, a); al.setX(o + 1, a);
      }
    }
    this.live = any; this.mesh.visible = any;
    if (!any) return;
    pos.needsUpdate = true; al.needsUpdate = true;
    this.mesh.position.copy(ac.pos);
    const col = this.u.uColor.value, sky = ENV.uAmbSky.value, sun = ENV.uSunCol.value;
    col.setRGB(1.6 * sky.r + 0.55 * sun.r + 0.02, 1.6 * sky.g + 0.55 * sun.g + 0.02, 1.6 * sky.b + 0.55 * sun.b + 0.02);
  }
}

const BOLT_VERT = /* glsl */`
attribute vec3 aOther;
attribute float aSide;
attribute float aEnd;
attribute float aInt;
uniform float uWidth, uPixel;
varying float vS, vI;
void main() {
  vec4 a = modelViewMatrix * vec4(position, 1.0), b = modelViewMatrix * vec4(aOther, 1.0);
  vec3 dir = b.xyz - a.xyz;
  // dir points the other way at the far end of a segment, so flip there to keep one side on one side.
  vec3 side = normalize(cross(a.xyz, dir) + vec3(0.0, 1.0e-4, 0.0)) * (1.0 - 2.0 * aEnd);
  // Never thinner than a couple of pixels, however far away.
  float w = max(uWidth * (0.35 + 0.65 * aInt), -a.z * uPixel * (0.9 + 1.6 * aInt));
  vS = aSide; vI = aInt;
  gl_Position = projectionMatrix * vec4(a.xyz + side * w * aSide, 1.0);
}`;
const BOLT_FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uGain;
varying float vS, vI;
void main() {
  float core = 1.0 - smoothstep(0.0, 0.35, abs(vS)), glow = pow(max(1.0 - abs(vS), 0.0), 3.0);
  gl_FragColor = vec4(uColor * (core * 1.0 + glow * 0.25) * uGain * (0.2 + 0.8 * vI), 1.0);
}`;

/** One population of falling particles in a camera-centered wrapping box. */
class Field {
  constructor(scene, geo, o, shared) {
    this.o = o;
    this.u = {
      ...shared, uLayer: { value: new THREE.Vector2(0, 0) },
      uOffset: { value: new THREE.Vector3() }, uStreak: { value: new THREE.Vector3() }, uSunDir: ENV.uSunDir,
      uBox: { value: o.box }, uRadius: { value: o.radius }, uFlutter: { value: o.flutter || 0 }, uTime: { value: 0 }, uNear: { value: o.near || 0.5 },
      uAmb: { value: new THREE.Color() }, uSun: { value: new THREE.Color() }, uOpacity: { value: 0 }, uCore: { value: o.core ?? 0.25 }, uVary: { value: o.vary || 0 },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: this.u, defines: { HULL_N: shared.uHull.value.length }, vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = o.order || 5; this.mesh.visible = false;
    // Each field draws a prefix of the shared particle buffer.
    this.mesh.onBeforeRender = () => geo.setDrawRange(0, o.count * 6);
    scene.add(this.mesh);
    this.fall = new THREE.Vector3();
    this.level = 0;
  }
  /** level 0..1; vel = particle velocity in the air mass frame added to the wind. */
  update(dt, time, level, wind, camVel, camPos, amb, sun) {
    const o = this.o, B = o.box;
    this.level += (level - this.level) * Math.min(1, dt * (o.rate || 1.5));
    const on = this.level > 0.01;
    this.mesh.visible = on;
    if (!on) return;
    this.fall.x += wind.x * dt; this.fall.y += (wind.y - o.fall) * dt; this.fall.z += wind.z * dt;
    const w = (v) => ((v % B) + B) % B;
    this.u.uOffset.value.set(w(this.fall.x - camPos.x), w(this.fall.y - camPos.y), w(this.fall.z - camPos.z));
    const s = this.u.uStreak.value.set(wind.x - camVel.x, wind.y - o.fall - camVel.y, wind.z - camVel.z).multiplyScalar(o.shutter);
    if (s.length() > o.maxStreak) s.setLength(o.maxStreak);
    this.u.uTime.value = time;
    this.u.uAmb.value.copy(amb); this.u.uSun.value.copy(sun);
    this.u.uOpacity.value = Math.min(1, this.level * (o.gain || 1)) * o.opacity;
  }
}

/** Jagged channel from a to b by midpoint displacement; pushes segments [ax,ay,az,bx,by,bz,intensity]. */
function channel(out, a, b, depth, jitter, intensity, rnd) {
  if (depth === 0) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], intensity); return; }
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const m = [(a[0] + b[0]) / 2 + (rnd() - 0.5) * len * jitter, (a[1] + b[1]) / 2 + (rnd() - 0.5) * len * jitter * 0.4, (a[2] + b[2]) / 2 + (rnd() - 0.5) * len * jitter];
  channel(out, a, m, depth - 1, jitter, intensity, rnd);
  channel(out, m, b, depth - 1, jitter, intensity, rnd);
}

const HIT_VERT = /* glsl */`
attribute vec3 aVel;         // velocity relative to the aircraft, in its axes
attribute vec2 aCorner;      // x: -1/+1 across, y: 0 head / 1 tail
attribute vec2 aSA;          // radius (m), opacity
uniform float uShutter, uPixel;
varying vec3 vLocal;
varying float vA;
void main() {
  vec3 a = (modelViewMatrix * vec4(position, 1.0)).xyz;
  vec3 s = mat3(modelViewMatrix) * aVel * uShutter;
  // Never thinner than most of a pixel (from the chase camera a fragment is smaller than that): drawn wider and fainter instead.
  float rad = max(aSA.x, -a.z * uPixel * 0.75);
  vec3 vdir = normalize(a + s * 0.5);
  vec3 sp = s - vdir * dot(s, vdir);
  float len = length(sp);
  vec3 ax = len > 1.0e-4 ? sp / len : normalize(cross(vdir, vec3(1.0, 0.0, 0.0)) + vec3(0.0, 1.0e-5, 0.0));
  vec3 side = cross(vdir, ax);
  vec3 pv = a + s * aCorner.y + ax * rad * (aCorner.y * 2.0 - 1.0) + side * rad * aCorner.x;
  vLocal = vec3(aCorner.x, aCorner.y > 0.5 ? len / rad + 1.0 : -1.0, len / rad);
  vA = aSA.y * min(1.0, 0.25 + 0.75 * aSA.x / rad);
  gl_Position = projectionMatrix * vec4(pv, 1.0);
}`;
const HIT_FRAG = /* glsl */`
uniform vec3 uCol;
varying vec3 vLocal;
varying float vA;
void main() {
  float y = clamp(vLocal.y, 0.0, vLocal.z);
  float d = length(vec2(vLocal.x, vLocal.y - y));
  float a = (1.0 - smoothstep(0.35, 1.0, d)) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a);
}`;
const MARK_VERT = /* glsl */`
attribute vec3 aUv;          // x, y across the mark (-1..1), z: its own random number
attribute float aA;
varying vec3 vUv;
varying float vA;
void main() { vUv = aUv; vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MARK_FRAG = /* glsl */`
uniform vec3 uCol;
varying vec3 vUv;
varying float vA;
void main() {
  // A bruise of crushed ice: a bright core, a splash of short rays around it, a faint ring where the spray lands.
  float r = length(vUv.xy), ang = atan(vUv.y, vUv.x + 1.0e-6);
  float rays = pow(abs(sin(ang * (3.0 + floor(vUv.z * 4.0)) + vUv.z * 40.0)), 6.0) * (0.6 + 0.4 * sin(ang * 11.0 + vUv.z * 90.0));
  float a = (1.0 - smoothstep(0.0, 0.3, r)) + rays * (1.0 - smoothstep(0.15, 0.95, r)) * 0.7 + 0.25 * (1.0 - smoothstep(0.0, 0.12, abs(r - 0.6))) * (1.0 - vA);
  a = clamp(a, 0.0, 1.0) * vA * (1.0 - smoothstep(0.85, 1.0, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a);
}`;

/**
 * Hail meeting the airframe. The falling hail is drawn by a Field, whose stones know nothing of the aircraft; this
 * decides, from how many stones the air holds and how fast each surface is sweeping through them, how many strike
 * each surface this frame, and for every strike throws off a puff of shattered ice, the stone rebounding and a few
 * fragments, all carried away by the airflow. Strikes on the windshield also leave a mark lying on the glass itself.
 * Everything is worked out in the aircraft's own axes against simple shapes (see AIRFRAME_172).
 */
class Impacts {
  constructor(scene) {
    this.scene = scene;
    const N = this.N = 640, M = this.M = 48;
    const quad = (n, attrs) => {
      const g = new THREE.BufferGeometry(), idx = new Uint16Array(n * 6);
      for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
      for (const [k, size] of attrs) { const a = new THREE.BufferAttribute(new Float32Array(n * 4 * size), size); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); }
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      // (the cloud renderer sizes its aircraft pass from the bounding boxes under the aircraft: keep this one the aircraft's size)
      g.boundingBox = new THREE.Box3(new THREE.Vector3(-6, -1.2, -2.6), new THREE.Vector3(6, 2.2, 7));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 2), 9);
      return g;
    };
    const pg = quad(N, [['position', 3], ['aVel', 3], ['aSA', 2], ['aCorner', 2]]);
    for (let i = 0; i < N * 4; i++) { pg.attributes.aCorner.array[i * 2] = i & 1 ? 1 : -1; pg.attributes.aCorner.array[i * 2 + 1] = (i & 3) >> 1; }
    this.u = { uCol: { value: new THREE.Color() }, uShutter: { value: 1 / 110 }, uPixel: { value: 0.001 } };
    const mat = (vs, fs) => new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: vs, fragmentShader: fs, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(pg, mat(HIT_VERT, HIT_FRAG));
    const mg = quad(M, [['position', 3], ['aUv', 3], ['aA', 1]]);
    this.marks = new THREE.Mesh(mg, mat(MARK_VERT, MARK_FRAG));
    this.group = new THREE.Group();
    for (const m of [this.mesh, this.marks]) { m.frustumCulled = false; m.castShadow = m.receiveShadow = false; m.renderOrder = 6; this.group.add(m); }
    this.group.visible = false;
    // particle state, in the aircraft's axes: position, velocity, age, life, radius, opacity, drag, growth
    this.p = new Float32Array(N * 12); this.live = 0; this.next = 0;
    this.m = new Float32Array(M * 16); this.mnext = 0; this.mlive = 0;      // marks: center, two half-edges, age, life, seed
    this.acc = []; this.rate = 0; this.frame = 0; this.glass = 0; this.total = 0;
    this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.vf = new THREE.Vector3(); this.g = new THREE.Vector3(); this.last = new THREE.Vector3(); this.has = false;
    this.setAirframe(AIRFRAME_172);
  }

  setAirframe(A) {
    this.A = A;
    const W = A.wing, S = A.stab, F = A.fin, h = W.span / 2;
    const fl = Math.hypot(F.tip[0] - F.foot[0], F.tip[1] - F.foot[1]);
    // Surfaces a stone can land on. Flat ones: a corner, two edges, the outward normal. Stretches of the hull's upper
    // surface: a range of z, sampled on the hull itself (kind 1: the windshield, which shows marks).
    this.faces = [
      { o: [-h, W.y + W.rise, W.zLE], u: [h, -W.rise, 0], v: [0, 0, W.zTE - W.zLE], n: [0, 1, 0] },                 // upper wing, left and right (it rises to the tip)
      { o: [0, W.y, W.zLE], u: [h, W.rise, 0], v: [0, 0, W.zTE - W.zLE], n: [0, 1, 0] },
      { o: [-h, W.y - W.thick + W.rise * 0.5, W.zLE], u: [2 * h, 0, 0], v: [0, W.thick, 0], n: [0, 0, -1] },        // its leading edge
      { o: [-S.half, S.y, S.zLE], u: [2 * S.half, 0, 0], v: [0, 0, S.zTE - S.zLE], n: [0, 1, 0] },                  // stabilizer
      { o: [-F.thick / 2, F.foot[1], F.foot[0]], u: [F.thick, 0, 0], v: [0, F.tip[1] - F.foot[1], F.tip[0] - F.foot[0]], n: [0, (F.tip[0] - F.foot[0]) / fl, -(F.tip[1] - F.foot[1]) / fl] },   // leading edge of the fin (square to the swept edge, facing forward and up)
      { hull: A.cowl }, { hull: A.screen, glass: true }, { hull: A.aft },
    ];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    for (const f of this.faces) {
      if (f.hull) {
        const z = (f.hull[0] + f.hull[1]) / 2, w = this.station(z)[3] * 0.7;
        f.n = this.hullNormal(0.3 * w, z); f.area = (f.hull[1] - f.hull[0]) * 2 * w / Math.max(f.n[1], 0.3);
        if (f.glass) f.area *= 2;                // (counted double: the hits a pilot notices)
      } else f.area = Math.hypot(...cross(f.u, f.v));
    }
    this.acc = this.faces.map(() => 0);
  }

  /** The hull section at z: [z, top, bottom, half width, widest height, exponent], or null beyond the nose and tail. */
  station(z, out = this._st || (this._st = [0, 0, 0, 0, 0, 0])) {
    const H = this.A.hull, n = H.length;
    if (z <= H[0][0] || z >= H[n - 1][0]) return null;
    let i = 0; while (z > H[i + 1][0]) i++;
    const t = (z - H[i][0]) / (H[i + 1][0] - H[i][0]);
    for (let k = 0; k < 6; k++) out[k] = H[i][k] + (H[i + 1][k] - H[i][k]) * t;
    return out;
  }
  /** Height of the hull's upper surface over (x, z). */
  hullY(x, z) {
    const s = this.station(z);
    if (!s) return 0;
    const k = Math.min(Math.abs(x) / s[3], 0.999);
    return s[4] + (s[1] - s[4]) * Math.pow(1 - Math.pow(k, s[5]), 1 / s[5]);
  }
  hullNormal(x, z) {
    const e = 0.01, nx = -(this.hullY(x + e, z) - this.hullY(x - e, z)) / (2 * e), nz = -(this.hullY(x, z + e) - this.hullY(x, z - e)) / (2 * e), l = Math.hypot(nx, 1, nz);
    return [nx / l, 1 / l, nz / l];
  }
  inHull(x, y, z) {
    const s = this.station(z);
    if (!s) return false;
    const h = y > s[4] ? s[1] - s[4] : s[4] - s[2];
    return Math.pow(Math.abs(x) / s[3], s[5]) + Math.pow(Math.abs(y - s[4]) / h, s[5]) < 1;
  }

  emit(x, y, z, vx, vy, vz, life, rad, alpha, drag, grow) {
    const i = this.next * 12, p = this.p;
    this.next = (this.next + 1) % this.N;
    p[i] = x; p[i + 1] = y; p[i + 2] = z; p[i + 3] = vx; p[i + 4] = vy; p[i + 5] = vz;
    p[i + 6] = 0; p[i + 7] = life; p[i + 8] = rad; p[i + 9] = alpha; p[i + 10] = drag; p[i + 11] = grow;
  }

  /**
   * level: hail 0..1. ac: { pos, quat, vel?, root? }. wind: air velocity (world). fall: the stones' fall speed (m/s).
   * density: stones per cubic meter at level 1 (the falling field's own, so what strikes matches what is seen falling).
   */
  update(dt, level, ac, wind, fall, density, col, camera) {
    this.frame = 0; this.glass = 0;
    if (!ac || !ac.pos || !ac.quat) { this.group.visible = false; this.rate = 0; return; }
    // Ride with the aircraft: under its own node when the game hands that over (it is then drawn with the aircraft,
    // sharp under motion blur), otherwise placed by hand.
    const g = this.group;
    if (ac.root) { if (g.parent !== ac.root) { ac.root.add(g); g.position.set(0, 0, 0); g.quaternion.identity(); } }
    else { if (g.parent !== this.scene) this.scene.add(g); g.position.copy(ac.pos); g.quaternion.copy(ac.quat); }
    const inv = this.q.copy(ac.quat).invert();
    // The aircraft's velocity: given, or from how far it has moved.
    const av = this.v;
    if (ac.vel) av.copy(ac.vel);
    else if (this.has && dt > 0 && ac.pos.distanceTo(this.last) < 200) av.copy(ac.pos).sub(this.last).multiplyScalar(1 / dt);
    else av.set(0, 0, 0);
    this.last.copy(ac.pos); this.has = true;
    const vf = this.vf.set(wind.x - av.x, wind.y - av.y, wind.z - av.z).applyQuaternion(inv);       // the air, as the airframe meets it
    const gv = this.g.set(0, -1, 0).applyQuaternion(inv);                                            // down
    const hx = vf.x + gv.x * fall, hy = vf.y + gv.y * fall, hz = vf.z + gv.z * fall;                 // the stones
    const R = Math.random;

    let hits = 0;
    if (level > 0.01 && dt > 0) {
      for (let k = 0; k < this.faces.length; k++) {
        const f = this.faces[k], flux = -(hx * f.n[0] + hy * f.n[1] + hz * f.n[2]);
        if (flux <= 0) continue;
        let n = (this.acc[k] += Math.min(density * level * flux * f.area * dt, 6));
        for (; n >= 1 && hits < 14; n--) {
          let x, y, z, nx, ny, nz;
          if (f.hull) {
            z = f.hull[0] + R() * (f.hull[1] - f.hull[0]); x = (R() * 2 - 1) * 0.72 * this.station(z)[3]; y = this.hullY(x, z);
            const nn = this.hullNormal(x, z); nx = nn[0]; ny = nn[1]; nz = nn[2];
          } else {
            const a = R(), b = R();
            x = f.o[0] + f.u[0] * a + f.v[0] * b; y = f.o[1] + f.u[1] * a + f.v[1] * b; z = f.o[2] + f.u[2] * a + f.v[2] * b;
            nx = f.n[0]; ny = f.n[1]; nz = f.n[2];
          }
          hits++; if (f.glass) this.glass++;
          const vn = hx * nx + hy * ny + hz * nz, sp = Math.hypot(hx, hy, hz);
          // the stone rebounds with a third of its speed,
          this.emit(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, (hx - 2 * vn * nx) * 0.3 + (R() - 0.5) * 3, (hy - 2 * vn * ny) * 0.3 + (R() - 0.5) * 3, (hz - 2 * vn * nz) * 0.3 + (R() - 0.5) * 3, 0.5 + R() * 0.3, 0.008 + R() * 0.005, 1, 1.6, 0);
          // a puff of crushed ice stands on the skin for an instant and is blown back,
          this.emit(x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, nx * 1.5, ny * 1.5, nz * 1.5, 0.11 + R() * 0.07, 0.02 + R() * 0.018, 0.4, 2.5, 3.5);
          // and the fragments spray out around the normal.
          const nf = 3 + (R() < 0.5 ? 1 : 0), kick = 3 + 0.09 * sp;
          for (let j = 0; j < nf; j++) {
            const rx = R() - 0.5, ry = R() - 0.5, rz = R() - 0.5, d = rx * nx + ry * ny + rz * nz, up = (0.5 + R()) * kick;
            this.emit(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02, nx * up + (rx - d * nx) * kick * 2.4 + hx * 0.12, ny * up + (ry - d * ny) * kick * 2.4 + hy * 0.12, nz * up + (rz - d * nz) * kick * 2.4 + hz * 0.12, 0.22 + R() * 0.3, 0.004 + R() * 0.004, 0.9, 4.5, 0);
          }
          if (f.glass) this.mark(x, y, z, nx, ny, nz);
        }
        this.acc[k] = Math.min(n, 2);
      }
    }
    this.frame = hits; this.total += hits;
    if (dt > 0) this.rate += (hits / dt - this.rate) * Math.min(1, dt * 6);

    // Carry the pieces: each is dragged toward the speed of the air going past, and falls.
    const p = this.p, P = this.mesh.geometry.attributes, pos = P.position.array, vel = P.aVel.array, sa = P.aSA.array;
    let live = 0;
    for (let i = 0; i < this.N; i++) {
      const o = i * 12, life = p[o + 7];
      let rad = 0, al = 0;
      if (life > 0) {
        const age = (p[o + 6] += dt);
        if (age >= life) p[o + 7] = 0;
        else {
          const k = Math.min(1, p[o + 10] * dt);
          p[o + 3] += (vf.x - p[o + 3]) * k + gv.x * 9.8 * dt; p[o + 4] += (vf.y - p[o + 4]) * k + gv.y * 9.8 * dt; p[o + 5] += (vf.z - p[o + 5]) * k + gv.z * 9.8 * dt;
          p[o] += p[o + 3] * dt; p[o + 1] += p[o + 4] * dt; p[o + 2] += p[o + 5] * dt;
          if (this.inHull(p[o], p[o + 1], p[o + 2])) p[o + 7] = 0;                // nothing comes inside
          else { const t = age / life; rad = p[o + 8] * (1 + p[o + 11] * t); al = p[o + 9] * (1 - t * t); live++; }
        }
      }
      for (let c = 0; c < 4; c++) {
        const a = (i * 4 + c) * 3, b = (i * 4 + c) * 2;
        pos[a] = p[o]; pos[a + 1] = p[o + 1]; pos[a + 2] = p[o + 2];
        vel[a] = p[o + 3]; vel[a + 1] = p[o + 4]; vel[a + 2] = p[o + 5];
        sa[b] = rad; sa[b + 1] = al;
      }
    }
    if (live || this.live) { P.position.needsUpdate = P.aVel.needsUpdate = P.aSA.needsUpdate = true; }
    this.live = live; this.mesh.visible = live > 0;

    // Marks on the glass fade in well under a second.
    const m = this.m, G = this.marks.geometry.attributes, mp = G.position.array, ma = G.aA.array, mu = G.aUv.array;
    let ml = 0;
    for (let i = 0; i < this.M; i++) {
      const o = i * 16;
      let a = 0;
      if (m[o + 10] > 0) { const t = (m[o + 9] += dt) / m[o + 10]; if (t >= 1) m[o + 10] = 0; else { a = Math.min(1, t * 14) * (1 - t) * (1 - t); ml++; } }
      for (let c = 0; c < 4; c++) {
        const sx = c & 1 ? 1 : -1, sy = c & 2 ? 1 : -1, q = (i * 4 + c) * 3;
        mp[q] = m[o] + sx * m[o + 3] + sy * m[o + 6]; mp[q + 1] = m[o + 1] + sx * m[o + 4] + sy * m[o + 7]; mp[q + 2] = m[o + 2] + sx * m[o + 5] + sy * m[o + 8];
        mu[q] = sx; mu[q + 1] = sy; mu[q + 2] = m[o + 11];
        ma[i * 4 + c] = a;
      }
    }
    if (ml || this.mlive) { G.position.needsUpdate = G.aA.needsUpdate = G.aUv.needsUpdate = true; }
    this.mlive = ml; this.marks.visible = ml > 0;
    g.visible = live > 0 || ml > 0;
    this.u.uCol.value.copy(col);
    if (camera) this.u.uPixel.value = (Math.tan((camera.fov * Math.PI) / 360) * 2) / (typeof innerHeight === 'number' ? innerHeight : 1080);
  }

  /** A mark lying on the glass at a point of the hull, just proud of the skin. */
  mark(x, y, z, nx, ny, nz) {
    const o = this.mnext * 16, m = this.m, r = 0.028 + Math.random() * 0.03;
    this.mnext = (this.mnext + 1) % this.M;
    // two edges in the surface: one across the aircraft, one up the glass
    let ax = 1 - nx * nx, ay = -nx * ny, az = -nx * nz; const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax;
    m[o] = x + nx * 0.012; m[o + 1] = y + ny * 0.012; m[o + 2] = z + nz * 0.012;
    m[o + 3] = ax * r; m[o + 4] = ay * r; m[o + 5] = az * r; m[o + 6] = bx * r; m[o + 7] = by * r; m[o + 8] = bz * r;
    m[o + 9] = 0; m[o + 10] = 0.5 + Math.random() * 0.35; m[o + 11] = Math.random();
  }
}

export class Precip {
  constructor(scene) {
    // Shared particle buffer: unit-cube positions, expanded to capsules in the shader.
    const pos = new Float32Array(MAX * 12), corner = new Float32Array(MAX * 8), rand = new Float32Array(MAX * 4), idx = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random(), r = Math.random();
      for (let k = 0; k < 4; k++) { pos.set([x, y, z], i * 12 + k * 3); corner[i * 8 + k * 2] = k & 1 ? 1 : -1; corner[i * 8 + k * 2 + 1] = k >> 1; rand[i * 4 + k] = r; }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    // What every field needs to keep out of the aircraft: where it is, how it lies, and the shape of its fuselage.
    const HN = AIRFRAME_172.hull.length;
    this.clip = {
      uAcOff: { value: new THREE.Vector3() }, uAcInv: { value: new THREE.Matrix3() },
      uHull: { value: Array.from({ length: HN }, () => new THREE.Vector4()) }, uHull2: { value: Array.from({ length: HN }, () => new THREE.Vector2()) },
      uHullMax: { value: new THREE.Vector3(-1, 0, 0) },
    };
    this.fields = [];
    const F = (o) => { const f = new Field(scene, g, o, this.clip); this.fields.push(f); return f; };
    // Rain in two depth layers: fine streaks close by, broad faint ones far off for depth.
    this.rainNear = F({ count: 9000, box: 26, radius: 0.006, fall: 9, shutter: 1 / 42, maxStreak: 4.2, opacity: 0.5, gain: 1.25, near: 0.6 });
    this.rainFar = F({ count: 9000, box: 110, radius: 0.028, fall: 9, shutter: 1 / 30, maxStreak: 9, opacity: 0.24, gain: 1.25, near: 16, order: 4 });
    this.snowNear = F({ count: 7500, box: 24, radius: 0.017, fall: 1.4, shutter: 1 / 260, maxStreak: 0.5, opacity: 0.9, gain: 1.6, flutter: 0.11, core: 0.05, near: 0.45, vary: 0.4 });
    this.snowFar = F({ count: 7000, box: 90, radius: 0.075, fall: 1.4, shutter: 1 / 200, maxStreak: 1.2, opacity: 0.34, gain: 1.6, flutter: 0.3, core: 0.0, near: 5, order: 4 });
    this.hail = F({ count: 1600, box: 24, radius: 0.012, fall: 24, shutter: 1 / 160, maxStreak: 0.9, opacity: 0.95, core: 0.6, near: 0.5 });
    // Snow the wind has lifted off the ground: a shallow sheet of it streaming along the surface under the camera.
    this.blow = F({ count: 8000, box: 44, radius: 0.03, fall: 0.25, shutter: 1 / 24, maxStreak: 1.6, opacity: 0.5, gain: 1.4, flutter: 0.22, core: 0.0, near: 0.5, vary: 0.5, rate: 1.2 });
    this.blowDepth = 11;
    // Hail striking the airframe; `hits` is for whoever wants to follow it (sound): strikes per second, this frame's count, how many of those on the windshield.
    this.impacts = new Impacts(scene);
    this.hits = { rate: 0, frame: 0, glass: 0, total: 0 };
    this.mat3 = new THREE.Matrix4(); this.qi = new THREE.Quaternion();
    this.setAirframe(AIRFRAME_172);
    // Vapor: big soft puffs fixed in the air, so they rush past when flying in cloud.
    this.vapor = F({ count: 320, box: 56, radius: 3.6, fall: 0, shutter: 1 / 50, maxStreak: 2.5, opacity: 0.3, core: 0.0, near: 2.5, vary: 1.2, rate: 2.5, order: 3 });

    // Condensation trails: two ribbons of N points each, rebuilt every frame.
    this.TN = 72;
    const tn = this.TN * 2, tpos = new Float32Array(tn * 2 * 3), tidx = [];
    for (let t = 0; t < 2; t++) for (let i = 0; i < this.TN - 1; i++) { const a = (t * this.TN + i) * 2; tidx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
    tg.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(tn * 2), 1));
    const ts = new Float32Array(tn * 2); for (let i = 0; i < tn; i++) { ts[i * 2] = -1; ts[i * 2 + 1] = 1; }
    tg.setAttribute('aSide', new THREE.BufferAttribute(ts, 1));
    tg.setIndex(tidx);
    this.trailU = { uColor: { value: new THREE.Color() } };
    this.trail = new THREE.Mesh(tg, new THREE.ShaderMaterial({ uniforms: this.trailU, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.trail.frustumCulled = false; this.trail.renderOrder = 6; this.trail.visible = false;
    scene.add(this.trail);
    // Point history: world position (doubles), strength at birth, age.
    this.tp = [0, 1].map(() => ({ x: new Float64Array(this.TN), y: new Float64Array(this.TN), z: new Float64Array(this.TN), s: new Float32Array(this.TN), age: new Float32Array(this.TN).fill(99), head: 0, lx: 0, ly: 0, lz: 0 }));
    this.tips = [new THREE.Vector3(-7.95, 1.18, 0.4), new THREE.Vector3(7.95, 1.18, 0.4)];
    this.contrails = new Contrails(scene);        // (its `sources` are set with the aircraft: a jet's nozzles)

    // Lightning: up to 700 camera-facing segments, additive and far brighter than white.
    this.BMAX = 700;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.BMAX * 12), 3));
    bg.setAttribute('aOther', new THREE.BufferAttribute(new Float32Array(this.BMAX * 12), 3));
    const bs = new Float32Array(this.BMAX * 4), be = new Float32Array(this.BMAX * 4), bi = new Uint32Array(this.BMAX * 6);
    for (let i = 0; i < this.BMAX; i++) { bs.set([-1, 1, -1, 1], i * 4); be.set([0, 0, 1, 1], i * 4); bi.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6); }
    bg.setAttribute('aSide', new THREE.BufferAttribute(bs, 1));
    bg.setAttribute('aEnd', new THREE.BufferAttribute(be, 1));
    bg.setAttribute('aInt', new THREE.BufferAttribute(new Float32Array(this.BMAX * 4), 1));
    bg.setIndex(new THREE.BufferAttribute(bi, 1));
    this.boltU = { uColor: { value: new THREE.Color(0.72, 0.8, 1.0) }, uGain: { value: 0 }, uWidth: { value: 1.6 }, uPixel: { value: 0.001 } };
    this.bolt = new THREE.Mesh(bg, new THREE.ShaderMaterial({ uniforms: this.boltU, vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
    this.bolt.frustumCulled = false; this.bolt.visible = false; this.bolt.renderOrder = 7;
    scene.add(this.bolt);
    this.strokes = []; this.boltAge = 99; this.flash = 0; this.glow = 0;
    this.level = 0;                       // smoothed precipitation, kept for callers that read it
    this.amb = new THREE.Color(); this.amb2 = new THREE.Color(); this.sun = new THREE.Color(); this.tmp = new THREE.Color();
    this.zero = new THREE.Vector3();
  }

  /** Tell the weather the shape of the aircraft (see AIRFRAME_172): what precipitation is kept out of, and what hail strikes. */
  setAirframe(A) {
    this.airframe = A;
    const H = A.hull, c = this.clip;
    if (c.uHull.value.length !== H.length) {
      c.uHull.value = Array.from({ length: H.length }, () => new THREE.Vector4()); c.uHull2.value = Array.from({ length: H.length }, () => new THREE.Vector2());
      for (const f of this.fields) { f.mesh.material.defines.HULL_N = H.length; f.mesh.material.needsUpdate = true; }
    }
    let w = 0, top = -9, bot = 9;
    H.forEach((s, i) => {
      c.uHull.value[i].set(s[0], s[1] + HULL_PAD, s[2] - HULL_PAD, s[3] + HULL_PAD); c.uHull2.value[i].set(s[4], s[5]);
      w = Math.max(w, s[3] + HULL_PAD); top = Math.max(top, s[1] + HULL_PAD); bot = Math.min(bot, s[2] - HULL_PAD);
    });
    this.hullMax = [w, top, bot];
    this.impacts.setAirframe(A);
  }

  /**
   * Call once per frame with a state object:
   *   dt, time        seconds
   *   rain, snow      0..1 intensity of each at the camera
   *   hail            0..1 (optional) hail in a storm core
   *   wind            {x,y,z} air velocity, m/s
   *   camPos, camVel  THREE.Vector3 camera position and velocity
   *   cloud           0..1 (optional) cloud density around the aircraft; shows vapor
   *   camera          (optional) THREE.PerspectiveCamera, keeps distant lightning a few pixels wide
   *   aircraft        (optional) { pos: Vector3, quat: Quaternion, tas, gLoad, onGround } for wingtip trails; with it nothing is
   *                   drawn inside the fuselage and hail strikes the airframe. Also read: vel (Vector3, its velocity; else worked
   *                   out from its movement) and root (its Object3D: impact debris is then drawn as part of the aircraft)
   *   humidity        (optional) 0..1 moist air; trails also form in cloud, rain, or under high g
   *   temp            (optional) air temperature at the aircraft, C: a jet (see `contrails.sources`) leaves contrails in very
   *                   cold air; its aircraft.power (0..1) says how hard the engines are working
   *   blow            0..1 (optional) snow blowing along the ground here; needs `ground`
   *   ground          (optional) height of the ground under the camera, m
   * Afterward `hits` holds the hail strikes on the airframe: { rate per second (smoothed), frame, glass, total }.
   */
  update(s) {
    if (typeof s === 'number') { const a = arguments; s = { dt: a[0], time: performance.now() / 1000, rain: a[2] ? 0 : a[1], snow: a[2] ? a[1] : 0, wind: a[3], camVel: a[4], camPos: a[5] }; }
    const dt = s.dt || 0, time = s.time || 0, wind = s.wind || this.zero, camVel = s.camVel || this.zero, camPos = s.camPos || this.zero;
    const rain = s.rain || 0, snow = s.snow || 0, flashL = ENV.uFlash.value;
    this.level += (Math.max(rain, snow) - this.level) * Math.min(1, dt * 1.5);

    // Light on the particles: the sky's diffuse light, the sun thrown forward, and lightning.
    const fog = ENV.uFogCol.value, sky = ENV.uAmbSky.value, sun = ENV.uSunCol.value;
    this.amb.copy(fog).multiplyScalar(0.75).add(this.tmp.copy(sky).multiplyScalar(0.7)).addScalar(0.012).add(this.tmp.setRGB(0.72, 0.8, 1.0).multiplyScalar(flashL * 2.5));
    this.sun.copy(sun).multiplyScalar(0.55);
    // Where the aircraft is, for keeping the particles out of it.
    const ac = s.aircraft, c = this.clip;
    if (ac && ac.pos && ac.quat) {
      c.uAcOff.value.copy(ac.pos).sub(camPos);
      c.uAcInv.value.setFromMatrix4(this.mat3.makeRotationFromQuaternion(this.qi.copy(ac.quat).invert()));
      c.uHullMax.value.set(this.hullMax[0], this.hullMax[1], this.hullMax[2]);
    } else c.uHullMax.value.x = -1;
    this.rainNear.update(dt, time, rain, wind, camVel, camPos, this.amb, this.sun);
    this.rainFar.update(dt, time, rain, wind, camVel, camPos, this.amb, this.sun);
    this.hail.update(dt, time, s.hail || 0, wind, camVel, camPos, this.amb2.copy(this.amb).multiplyScalar(1.5).addScalar(0.05), this.sun);
    // Stones meeting the airframe, as many as the falling field would put there.
    const H = this.hail.o, I = this.impacts;
    I.update(dt, this.hail.level, ac, wind, H.fall, H.count / (H.box * H.box * H.box), this.tmp.copy(this.amb2).multiplyScalar(1.6).add(this.sun), s.camera);
    this.hits.rate = I.rate; this.hits.frame = I.frame; this.hits.glass = I.glass; this.hits.total = I.total;
    // Snow is a diffuse white scatterer: brighter than rain, less directional.
    this.amb.copy(sky).multiplyScalar(1.7).add(this.tmp.copy(fog).multiplyScalar(0.55)).add(this.tmp.copy(sun).multiplyScalar(0.14)).addScalar(0.015 + flashL * 2.0);
    this.sun.copy(sun).multiplyScalar(0.22);
    this.snowNear.update(dt, time, snow, wind, camVel, camPos, this.amb, this.sun);
    this.snowFar.update(dt, time, snow, wind, camVel, camPos, this.amb, this.sun);
    // Blowing snow lies in the lowest few meters: the sheet is laid on the ground under the camera, and is out of sight from higher up.
    const hasGround = typeof s.ground === 'number', camAgl = hasGround ? camPos.y - s.ground : 1e9;
    this.blow.u.uLayer.value.set(hasGround ? s.ground + 0.42 * this.blowDepth - camPos.y : 0, this.blowDepth);
    this.blow.update(dt, time, (s.blow || 0) * (1 - THREE.MathUtils.smoothstep(camAgl, 25, 70)), wind, camVel, camPos, this.amb, this.sun);
    // Vapor takes the color of the cloud it is part of.
    this.amb.copy(sky).multiplyScalar(1.25).add(this.tmp.copy(fog).multiplyScalar(0.35)).add(this.tmp.copy(sun).multiplyScalar(0.1)).addScalar(flashL * 1.5);
    this.sun.copy(sun).multiplyScalar(0.05);
    this.vapor.update(dt, time, Math.min(1, (s.cloud || 0) * 1.4), wind, camVel, camPos, this.amb, this.sun);

    this.updateTrails(s, dt, wind, camPos);
    // Contrails form behind a jet's engines in very cold air, more readily the harder they are working.
    if (s.aircraft?.pos) {
      const a = s.aircraft, cold = THREE.MathUtils.smoothstep(-(s.temp ?? 15), 33, 41);
      this.contrails.update(dt, a, a.onGround ? 0 : cold * (0.45 + 0.55 * (a.power ?? 1)) * THREE.MathUtils.smoothstep(a.tas ?? 0, 60, 110), wind, camPos);
    }
    this.updateLightning(dt, s.camera);
  }

  updateTrails(s, dt, wind, camPos) {
    const ac = s.aircraft;
    if (!ac || !ac.pos) { this.trail.visible = false; return; }
    const humid = Math.max(s.humidity || 0, Math.min(1, (s.cloud || 0) * 2), (s.rain || 0) * 0.8, (s.snow || 0) * 0.5);
    const g = Math.abs(ac.gLoad ?? 1), tas = ac.tas ?? 0;
    // Tip vortices condense when the air is near saturation, sooner the harder the wing is working.
    let strength = THREE.MathUtils.smoothstep(humid + Math.max(0, g - 1.15) * 0.45, 0.42, 0.95) * THREE.MathUtils.smoothstep(tas, 32, 50);
    if (ac.onGround) strength = 0;
    const pos = this.trail.geometry.attributes.position, al = this.trail.geometry.attributes.aAlpha;
    const tip = this._tip || (this._tip = new THREE.Vector3()), side = this._side || (this._side = new THREE.Vector3()), tan = this._tan || (this._tan = new THREE.Vector3()), toCam = this._toCam || (this._toCam = new THREE.Vector3());
    let any = false;
    const LIFE = 2.6;
    for (let t = 0; t < 2; t++) {
      const P = this.tp[t], N = this.TN;
      tip.copy(this.tips[t]).applyQuaternion(ac.quat).add(ac.pos);
      for (let i = 0; i < N; i++) { P.age[i] += dt; P.x[i] += wind.x * dt; P.y[i] += (wind.y - 0.6) * dt; P.z[i] += wind.z * dt; }
      const moved = Math.hypot(tip.x - P.lx, tip.y - P.ly, tip.z - P.lz);
      if (moved > 60) P.age.fill(99);                         // the aircraft was repositioned: drop the old trail
      // Lay a new point every few meters of travel.
      if (moved > 2.2) {
        P.head = (P.head + 1) % N;
        P.x[P.head] = tip.x; P.y[P.head] = tip.y; P.z[P.head] = tip.z; P.s[P.head] = strength; P.age[P.head] = 0;
        P.lx = tip.x; P.ly = tip.y; P.lz = tip.z;
      }
      // Newest point follows the wingtip exactly so the ribbon stays attached.
      for (let k = 0; k < N; k++) {
        const i = (P.head - k + N) % N, j = (P.head - Math.min(k + 1, N - 1) + N) % N, o = (t * N + k) * 2;
        const dead = k > 0 && P.age[i] > 90;                    // unused slots collapse onto the wingtip
        const x = k === 0 || dead ? tip.x : P.x[i], y = k === 0 || dead ? tip.y : P.y[i], z = k === 0 || dead ? tip.z : P.z[i];
        const age = k === 0 ? 0 : P.age[i], life = Math.max(0, 1 - age / LIFE);
        const a = (k === 0 ? strength : P.s[i]) * life * life * 0.5 * (age < 90 ? 1 : 0) * Math.min(1, k / 2);
        if (a > 0.004) any = true;
        tan.set(P.x[j] - x, P.y[j] - y, P.z[j] - z);
        toCam.set(camPos.x - x, camPos.y - y, camPos.z - z);
        side.crossVectors(tan, toCam);
        const sl = side.length();
        if (sl > 1e-6) side.multiplyScalar((0.1 + age * 0.55) / sl); else side.set(0, 0, 0);
        pos.setXYZ(o, x - ac.pos.x - side.x, y - ac.pos.y - side.y, z - ac.pos.z - side.z);
        pos.setXYZ(o + 1, x - ac.pos.x + side.x, y - ac.pos.y + side.y, z - ac.pos.z + side.z);
        al.setX(o, a); al.setX(o + 1, a);
      }
    }
    this.trail.visible = any;
    if (!any) return;
    pos.needsUpdate = true; al.needsUpdate = true;
    this.trail.position.copy(ac.pos);
    this.trailU.uColor.value.copy(ENV.uAmbSky.value).multiplyScalar(1.5).add(this.tmp.copy(ENV.uSunCol.value).multiplyScalar(0.3)).addScalar(0.02);
  }

  updateLightning(dt, camera) {
    this.boltAge += dt;
    // Several return strokes down the same channel, each a sharp flash that dies in a few hundredths of a second.
    let I = 0;
    for (const st of this.strokes) { const a = this.boltAge - st.t; if (a >= 0) I += st.i * Math.exp(-a / 0.035); }
    this.glow = Math.max(this.glow * Math.exp(-dt * 5), I);
    if (this.bolt.visible) {
      this.boltU.uGain.value = 110 * I;
      if (camera) this.boltU.uPixel.value = (Math.tan((camera.fov * Math.PI) / 360) * 2) / (typeof innerHeight === 'number' ? innerHeight : 1080);
      if (this.boltAge > 0.6 && I < 0.005) this.bolt.visible = false;
    }
    ENV.uFlash.value = Math.min(1, Math.max(I, this.glow * 0.35));
    this.flash = ENV.uFlash.value;
  }

  /** Trigger lightning at f = {x, y, z, ground}; ground strikes draw a branching bolt down to groundY. */
  strike(f, groundY = 0) {
    ENV.uFlashPos.value.set(f.x, f.y, f.z);
    const n = 2 + Math.floor(Math.random() * 3);
    this.strokes = [];
    for (let i = 0, t = 0; i < n; i++) { this.strokes.push({ t, i: i === 0 ? 1 : 0.35 + Math.random() * 0.55 }); t += 0.045 + Math.random() * 0.09; }
    this.boltAge = 0;
    if (!f.ground) { this.bolt.visible = false; return; }
    const rnd = Math.random, seg = [], top = f.y - groundY;
    const end = [(rnd() - 0.5) * top * 0.5, 0, (rnd() - 0.5) * top * 0.5];
    channel(seg, [0, top, 0], end, 7, 0.22, 1, rnd);
    // Branches fork off the main channel and die out before reaching the ground.
    const main = seg.length / 7, forks = 5 + Math.floor(rnd() * 5);
    for (let k = 0; k < forks; k++) {
      const i = Math.floor((0.08 + rnd() * 0.75) * main) * 7;
      const a = [seg[i], seg[i + 1], seg[i + 2]], len = a[1] * (0.18 + rnd() * 0.3), ang = rnd() * 6.283;
      const b = [a[0] + Math.cos(ang) * len * 0.7, Math.max(a[1] - len, top * 0.03), a[2] + Math.sin(ang) * len * 0.7];
      const start = seg.length;
      channel(seg, a, b, 5, 0.26, 0.42, rnd);
      if (rnd() < 0.5) {
        const j = start + Math.floor(rnd() * 20 + 6) * 7, c = [seg[j], seg[j + 1], seg[j + 2]], l2 = len * 0.45, a2 = ang + (rnd() - 0.5) * 2;
        channel(seg, c, [c[0] + Math.cos(a2) * l2, Math.max(c[1] - l2 * 0.8, top * 0.03), c[2] + Math.sin(a2) * l2], 4, 0.28, 0.2, rnd);
      }
    }
    const count = Math.min(seg.length / 7, this.BMAX), g = this.bolt.geometry;
    const P = g.attributes.position, O = g.attributes.aOther, A = g.attributes.aInt;
    for (let i = 0; i < count; i++) {
      const s = i * 7, ax = seg[s], ay = seg[s + 1], az = seg[s + 2], bx = seg[s + 3], by = seg[s + 4], bz = seg[s + 5];
      // Thin toward the tip of each branch.
      const it = seg[s + 6];
      P.setXYZ(i * 4, ax, ay, az); O.setXYZ(i * 4, bx, by, bz);
      P.setXYZ(i * 4 + 1, ax, ay, az); O.setXYZ(i * 4 + 1, bx, by, bz);
      P.setXYZ(i * 4 + 2, bx, by, bz); O.setXYZ(i * 4 + 2, ax, ay, az);
      P.setXYZ(i * 4 + 3, bx, by, bz); O.setXYZ(i * 4 + 3, ax, ay, az);
      for (let k = 0; k < 4; k++) A.setX(i * 4 + k, it);
    }
    P.needsUpdate = O.needsUpdate = A.needsUpdate = true;
    g.setDrawRange(0, count * 6);
    this.bolt.position.set(f.x, groundY, f.z);
    this.bolt.visible = true;
  }
}
