// Rocket exhaust: the flame (Plume) and what it leaves in the air (ExhaustTrail).
//
// Plume is one instanced draw call. Every instance is the same open tube, shaped in the vertex shader:
// one narrow jet per nozzle (where shock diamonds and the dark fuel-rich film at an F-1's lip live), plus
// two tubes round the whole cluster, a core and a wider, fainter shell. Their radius, length and
// brightness follow the ambient pressure: at sea level the cluster is a long flame that closes to a
// ragged point; as the pressure falls the tubes open into the wide, thin bell of an underexpanded plume
// and the single jets fade into it. The fragment shader fakes volume from the angle between the tube's
// wall and the eye (thick through the middle, soft at the limb), scrolls two octaves of tiling noise down
// the flow, and writes premultiplied color, so the flame adds light and the film band can also hide what
// is behind it. Attach plume.group to the vehicle's root.
//
// ExhaustTrail is the smoke, steam, dust, vapor and ice of a launch: the clouds blasted out of the flame trench
// (or from under Starship's mount) at ignition, the column left up the sky, frost falling off the tanks, the
// vents' wisps before launch and the vapor collar at Mach 1. It is a thin shell here: the puffs are simulated,
// lit and drawn (one instanced draw call, and a depth-only second) by fx-smoke.js, and fx-launch.js decides what to put into the air
// from what mission.js says about the vehicle each frame. Add trail.object to the scene.
//
// Brightness is in the game's HDR units (the frame is half-float, bloomed and tone mapped): PLUME_TUNING
// holds the peak radiance of each propellant's flame and one master gain; they can be changed at run time.

import * as THREE from 'three';
import { SmokeField, SMOKE_QUALITY, SMOKE_TUNING } from './fx-smoke.js';
import { LaunchSmoke, TRAIL_TUNING } from './fx-launch.js';

export { TRAIL_TUNING, SMOKE_TUNING, SMOKE_QUALITY };

/** Peak radiance of the flame by propellant (scene-linear HDR units) and a master gain over all of them. */
export const PLUME_TUNING = { intensity: 1, kerolox: 42, methalox: 24, hydrolox: 4.5, hypergolic: 2.2 };

const LOOK = {
  //           core (hot middle)         mid (limb by the nozzle) tail (far down)                   jet length (nozzle radii), cluster length (cluster radii), diamonds, film, opacity
  kerolox: { core: [1.0, 0.9, 0.62], mid: [1.0, 0.42, 0.09], tail: [1.0, 0.22, 0.03], jet: 24, len: 27, diamond: 0.0, film: 1, opacity: 0.85, white: 0.7 },
  methalox: { core: [0.86, 0.8, 1.0], mid: [0.4, 0.3, 1.0], tail: [1.0, 0.48, 0.22], jet: 20, len: 44, diamond: 1.0, film: 0, opacity: 0.25, white: 0.35 },
  hydrolox: { core: [0.8, 0.9, 1.0], mid: [0.32, 0.52, 1.0], tail: [0.5, 0.45, 0.9], jet: 14, len: 30, diamond: 0.7, film: 0, opacity: 0.0, white: 0.3 },
  hypergolic: { core: [1.0, 0.85, 0.75], mid: [1.0, 0.62, 0.5], tail: [0.8, 0.45, 0.5], jet: 8, len: 16, diamond: 0.0, film: 0, opacity: 0.0, white: 0.2 },
};
const MAX_NOZZLES = 40;

/** Tiling value noise, two independent fields in R and G. */
let NOISE = null;
function noiseTexture() {
  if (NOISE) return NOISE;
  const N = 128, d = new Uint8Array(N * N * 4);
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
  for (let ch = 0; ch < 2; ch++) {
    const acc = new Float32Array(N * N);
    let amp = 1, norm = 0;
    for (const P of [4, 8, 16, 32]) {
      const g = new Float32Array(P * P).map(() => rnd());
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = (x / N) * P, fy = (y / N) * P, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
        const a = g[y0 * P + x0], b = g[y0 * P + x1], c = g[y1 * P + x0], e = g[y1 * P + x1];
        acc[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy);
      }
      norm += amp; amp *= 0.5;
    }
    for (let i = 0; i < N * N; i++) d[i * 4 + ch] = Math.max(0, Math.min(255, ((acc[i] / norm - 0.5) * 1.7 + 0.5) * 255));
  }
  for (let i = 0; i < N * N; i++) { d[i * 4 + 2] = 0; d[i * 4 + 3] = 255; }
  NOISE = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  NOISE.wrapS = NOISE.wrapT = THREE.RepeatWrapping; NOISE.minFilter = THREE.LinearMipmapLinearFilter; NOISE.magFilter = THREE.LinearFilter;
  NOISE.generateMipmaps = true; NOISE.needsUpdate = true;
  return NOISE;
}

// ---------------------------------------------------------------- the flame

const PLUME_VS = /* glsl */`
attribute vec3 iPos;       // nozzle exit center (root coordinates), or the cluster's center
attribute vec4 iParam;     // radius at the exit, kind (0 jet, 1 cluster core, 2 cluster shell), seed
uniform float uTime, uThrottle, uW;
uniform float uLen[3], uSpread[3], uTaper[3];
varying float vT, vAng, vKind, vSeed, vLenR;
varying vec3 vN, vView, vAxis;
void main() {
  float t = position.y, kind = iParam.y, r0 = iParam.x;
  int k = int(kind + 0.5);
  float len = uLen[k] * (k == 0 ? r0 : 1.0);
  float open = (1.0 - exp(-3.2 * t)) / 0.9592;                       // quick at the lip, then steadier: the bell
  float close = 1.0 - uTaper[k] * smoothstep(0.5, 1.0, t);
  float r = r0 * (1.0 + uSpread[k] * open) * close;
  float dr = r0 * uSpread[k] * 3.2 * exp(-3.2 * t) / 0.9592;
  float a = uv.x * 6.2831853;
  // the wall billows more the farther it is from the nozzle
  float wob = sin(a * 3.0 + t * 37.0 - uTime * 9.0 + iParam.z * 6.0) + 0.6 * sin(a * 5.0 - t * 61.0 + uTime * 14.0 + iParam.z * 11.0);
  r *= 1.0 + wob * t * (k == 0 ? 0.035 : 0.06) * (1.0 - 0.75 * uW);
  vec3 radial = vec3(position.x, 0.0, position.z);
  vec3 p = iPos + radial * r - vec3(0.0, t * len, 0.0);
  if (k > 0) p.xz += vec2(sin(t * 5.0 - uTime * 2.9), cos(t * 4.3 - uTime * 2.3)) * t * t * r0 * 0.3;
  vec3 n = normalize(radial * len + vec3(0.0, dr, 0.0));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalMatrix * n; vView = -mv.xyz; vAxis = normalMatrix * vec3(0.0, -1.0, 0.0);
  vT = t; vAng = uv.x; vKind = kind; vSeed = iParam.z; vLenR = len / max(r0, 0.01);
  gl_Position = projectionMatrix * mv;
}`;

const PLUME_FS = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uCore, uMid, uTail;
uniform float uTime, uW, uDiamond, uFilm, uOpacity, uWhite;
uniform float uGain[3], uEdge[3], uFadeIn[3];
varying float vT, vAng, vKind, vSeed, vLenR;
varying vec3 vN, vView, vAxis;
void main() {
  int k = int(vKind + 0.5);
  vec3 N = normalize(vN), V = normalize(vView);
  float ndv = abs(dot(N, V)), axial = abs(dot(V, normalize(vAxis)));
  float ax4 = axial * axial; ax4 *= ax4;
  // depth of gas along the line of sight: deep through the middle, nothing at the limb
  float body = pow(max(ndv, 1e-4), uEdge[k]);
  body = mix(body, 0.5, ax4);
  float t = vT;
  // noise carried down the flow
  float fast = k == 0 ? 2.6 : 0.9;
  vec2 q = vec2(vAng * (k == 0 ? 2.0 : 3.0) + vSeed, t * (k == 0 ? 1.2 : 2.6) - uTime * fast);
  float n1 = texture2D(uNoise, q).r, n2 = texture2D(uNoise, q * vec2(2.0, 2.7) + vec2(0.37, -uTime * 0.7)).g;
  float n = n1 * 0.62 + n2 * 0.38;
  float streak = texture2D(uNoise, vec2(vAng * 5.0 + vSeed, t * 0.35 - uTime * 0.12)).g;
  // along the flame: in after the lip, out in ragged wisps at the tail
  float fadeIn = smoothstep(uFadeIn[k] * 0.45, uFadeIn[k] * 1.6 + 0.004, t);
  float wisp = smoothstep(0.0, 0.45, n + (0.82 - t) * 1.7);
  float along = (k == 0 ? pow(max(1.0 - t, 0.0), 1.3) : mix(exp(-2.4 * t), exp(-4.5 * t) + 0.12, uW)) * (1.0 - smoothstep(0.86, 1.0, t));
  // turbulence in stops of brightness, rougher toward the tail and in the outer shell
  float rough = exp2((n - 0.5) * (1.2 + 3.2 * t + (k == 2 ? 1.5 : 0.0)) * (1.0 - 0.55 * uW));
  float I = uGain[k] * along * fadeIn * wisp * rough * body * mix(1.0, 0.55 + 0.9 * streak, uW);
  // color: the limb takes the cool edge color near the nozzle and the tail color far down; the hot, deep middle goes to the core color
  float heat = clamp(body * along * 1.3, 0.0, 1.0) * (k == 2 ? 0.4 : 1.0);
  vec3 c = mix(mix(uMid, uTail, smoothstep(0.12, 0.7, t)), uCore, smoothstep(0.2, 0.85, heat));
  c = mix(c, vec3(1.0), uWhite * smoothstep(0.6, 1.0, heat));
  c = mix(c, vec3(dot(c, vec3(0.4)) + 0.25), 0.5 * uW);                 // thin gas glows paler
  vec3 rgb = c * I;
  float alpha = uOpacity * body * fadeIn * wisp * (1.0 - smoothstep(0.5, 0.95, t)) * (1.0 - uW) * (k == 2 ? 0.3 : 1.0);
  if (k == 0) {
    // shock diamonds down each jet, strongest where the air still squeezes it
    float d = t * vLenR / 4.6, rho = sqrt(max(0.0, 1.0 - ndv * ndv));
    float wd = 0.8 * abs(cos(3.14159 * d));
    float dia = smoothstep(wd + 0.14, wd - 0.1, rho) * exp(-d * 0.42) * step(0.12, d);
    rgb += (c * 0.6 + vec3(0.9, 0.75, 0.7)) * uGain[0] * 1.6 * dia * uDiamond * (1.0 - ax4) * (0.85 + 0.3 * n);
    // an F-1's turbine exhaust lines the nozzle wall and leaves it as a dark, sooty sleeve before it lights
    float film = uFilm * (1.0 - smoothstep(0.07, 0.17, t + (n - 0.5) * 0.06));
    rgb = mix(rgb, vec3(0.5, 0.13, 0.03) * (0.25 + 0.6 * n) * body, film * 0.96);
    alpha = max(alpha, film * 0.9 * pow(max(ndv, 1e-4), 0.35));
  }
  gl_FragColor = vec4(rgb, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function tubeGeometry(around, along) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= along; j++) {
    const t = Math.pow(j / along, 1.6);                              // rows crowd toward the nozzle, where the shape turns fastest
    for (let i = 0; i <= around; i++) { const a = (i / around) * Math.PI * 2; pos.push(Math.cos(a), t, Math.sin(a)); uv.push(i / around, t); }
  }
  for (let j = 0; j < along; j++) for (let i = 0; i < around; i++) { const a = j * (around + 1) + i, b = a + around + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Plume {
  constructor() {
    this.group = new THREE.Group(); this.group.name = 'plume';
    const geo = tubeGeometry(24, 36);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array((MAX_NOZZLES + 2) * 3), 3);
    this.iParam = new THREE.InstancedBufferAttribute(new Float32Array((MAX_NOZZLES + 2) * 4), 4);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iParam', this.iParam);
    geo.instanceCount = 0;
    this.uniforms = {
      uNoise: { value: noiseTexture() }, uTime: { value: 0 }, uThrottle: { value: 0 }, uW: { value: 0 },
      uCore: { value: new THREE.Vector3() }, uMid: { value: new THREE.Vector3() }, uTail: { value: new THREE.Vector3() },
      uDiamond: { value: 0 }, uFilm: { value: 0 }, uOpacity: { value: 0 }, uWhite: { value: 0 },
      uLen: { value: [1, 1, 1] }, uSpread: { value: [0, 0, 0] }, uTaper: { value: [0, 0, 0] },
      uGain: { value: [0, 0, 0] }, uEdge: { value: [1, 1, 1] }, uFadeIn: { value: [0, 0, 0] },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: PLUME_VS, fragmentShader: PLUME_FS,
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 10; this.mesh.visible = false;
    this.group.add(this.mesh);
    this.level = 0; this.key = ''; this.clusterR = 1; this.time = 0;
    /** Length of the visible flame in meters, for cameras and lights (updated every frame). */
    this.length = 0;
    /** Rough radiance and color of the flame as a light source: multiply for a PointLight under the vehicle. */
    this.light = { color: new THREE.Color(), power: 0 };
  }

  /** Lay out one jet per nozzle and the two cluster tubes. */
  _layout(nozzles, radius, radii) {
    const n = Math.min(nozzles.length, MAX_NOZZLES), P = this.iPos.array, Q = this.iParam.array;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += nozzles[i].x / n; cy += nozzles[i].y / n; cz += nozzles[i].z / n; }
    let R = 0;
    for (let i = 0; i < n; i++) {
      const r = radii ? radii[i] : radius, v = nozzles[i];
      P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
      Q[i * 4] = r; Q[i * 4 + 1] = 0; Q[i * 4 + 2] = (i * 0.618) % 1; Q[i * 4 + 3] = 0;
      R = Math.max(R, Math.hypot(v.x - cx, v.z - cz) + r);
    }
    for (let k = 0; k < 2; k++) {
      const i = n + k;
      P[i * 3] = cx; P[i * 3 + 1] = cy; P[i * 3 + 2] = cz;
      Q[i * 4] = R * (k ? 1.08 : 0.94); Q[i * 4 + 1] = 1 + k; Q[i * 4 + 2] = 0.31 + k * 0.4; Q[i * 4 + 3] = 0;
    }
    this.iPos.needsUpdate = true; this.iParam.needsUpdate = true;
    this.mesh.geometry.instanceCount = n + 2; this.clusterR = R; this.single = n === 1;
  }

  update(dt, s) {
    const nozzles = s.nozzles || [], radius = s.nozzleRadius || 1;
    const key = nozzles.length ? `${nozzles.length}:${nozzles[0].x.toFixed(2)},${nozzles[0].y.toFixed(2)},${nozzles[0].z.toFixed(2)}:${radius}` : '';
    if (key !== this.key) { this.key = key; if (nozzles.length) this._layout(nozzles, radius, s.nozzleRadii); this.level = 0; }
    const want = nozzles.length ? Math.max(0, Math.min(1, s.throttle || 0)) : 0;
    this.level += (want - this.level) * (dt > 0 ? 1 - Math.exp(-dt * 5) : 1);
    const th = this.level, U = this.uniforms;
    this.mesh.visible = th > 0.004;
    if (!this.mesh.visible) { this.length = 0; this.light.power = 0; return; }
    this.time = s.time != null ? s.time : this.time + dt;
    const L = LOOK[s.propellant] || LOOK.kerolox, p = Math.max(1e-5, Math.min(1, s.pressure ?? 1));
    const w = Math.max(0, Math.min(1, Math.log10(1 / p) / 3));                 // 0 at sea level, 1 by a thousandth of an atmosphere
    const R = this.clusterR, push = 0.4 + 0.6 * th, gain = PLUME_TUNING.intensity * (PLUME_TUNING[s.propellant] ?? PLUME_TUNING.kerolox) * Math.pow(th, 1.2);
    U.uTime.value = this.time % 1000; U.uThrottle.value = th; U.uW.value = w;
    U.uCore.value.fromArray(L.core); U.uMid.value.fromArray(L.mid); U.uTail.value.fromArray(L.tail);
    U.uDiamond.value = L.diamond * (1 - w) * (1 - w) * Math.min(1, p * 3); U.uFilm.value = L.film * (1 - w); U.uOpacity.value = L.opacity; U.uWhite.value = L.white;
    const lenJet = L.jet * push * (1 + 1.3 * w), lenCore = L.len * R * push * (1 + 1.5 * w) * (this.single ? 1.6 : 1);
    U.uLen.value[0] = lenJet; U.uLen.value[1] = lenCore; U.uLen.value[2] = lenCore * 1.15;
    U.uSpread.value[0] = 0.45 + 9 * w * w; U.uSpread.value[1] = 0.42 + 9 * Math.pow(w, 1.6); U.uSpread.value[2] = 0.75 + 22 * Math.pow(w, 1.4);
    U.uTaper.value[0] = 0.55 * (1 - w); U.uTaper.value[1] = 0.78 * (1 - w); U.uTaper.value[2] = 0.7 * (1 - w);
    // many jets overlap along the eye's line: share the light out
    U.uGain.value[0] = gain * (1 - 0.82 * w) * Math.min(1, 2.6 / (this.mesh.geometry.instanceCount - 2));
    U.uGain.value[1] = gain * 0.8 * (1 - 0.9 * w) * (this.single ? 0.5 : 1); U.uGain.value[2] = gain * 0.12 * (1 - 0.8 * w);
    U.uEdge.value[0] = 1.8; U.uEdge.value[1] = 3.0 - 1.9 * w; U.uEdge.value[2] = 1.6;
    U.uFadeIn.value[0] = 0.004; U.uFadeIn.value[1] = this.single ? 0.01 : 0.07 * (1 - w) + 0.004; U.uFadeIn.value[2] = this.single ? 0.01 : 0.1 * (1 - w) + 0.004;
    this.length = lenCore * 0.9;
    this.light.color.setRGB(L.mid[0], L.mid[1], L.mid[2]); this.light.power = gain * (1 - 0.8 * w);
  }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.group.removeFromParent(); }
}

// ---------------------------------------------------------------- smoke, steam, dust, vapor and ice

/**
 * Everything a launch leaves in the air, behind the interface mission.js drives:
 *
 *   trail = new ExhaustTrail(); scene.add(trail.object);
 *   trail.setQuality('low' | 'med' | 'high' | 'ultra');
 *   trail.emit(dt, s);         // every frame the vehicle is in the game's world, engines on or off; s is listed below
 *   trail.update(dt, { camPos, sunDir, sunColor, ambient, time });
 *   trail.shift(dx, dy, dz);   // the world's origin moved
 *   trail.clear(); trail.dispose();
 *
 * emit's s (world axes, meters; nothing in it is kept): pos (center of the nozzle exit plane), dir (unit, the way
 * the exhaust goes), vel, throttle 0..1, pressure 0..1, propellant, radius, wind, and, when the caller has them:
 * nose, base (bottom of the stack), height, vehicle ('saturnv' | 'starship'), stage, landed, held, met (seconds
 * since liftoff, -1 before), agl, mach, padY, standY, hasPad, flameLen (m, else estimated), and shade (0..1, how
 * much of the direct sun the weather's cloud takes at the vehicle: remembered by height, so a cloud left under an
 * overcast stays in its shade after the vehicle has climbed out of it). The older onPad and groundY stand in for
 * hasPad and padY. trail.terrainAt = (x, z) => height, if given, is the land outside the pad's concrete.
 */
export class ExhaustTrail {
  constructor(quality = 'high') {
    this.field = new SmokeField(typeof quality === 'string' ? quality : 'high');
    this.launch = new LaunchSmoke(this.field);
    this.object = this.field.object;
    this.lastTime = null;
  }

  setQuality(q) { this.field.setQuality(q); }
  /** Live particles, and the screens of overdraw last estimated for them. */
  get count() { return this.field.n; }
  get overdraw() { return this.field.overdraw; }
  set terrainAt(fn) { this.launch.terrainAt = fn; }
  get terrainAt() { return this.launch.terrainAt; }

  emit(dt, s) { if (dt > 0 && s && s.pos && s.dir) this.launch.emit(dt, s); }

  update(dt, s = {}) {
    // Left alone for minutes (the vehicle was in space): what was in the air then is long gone.
    if (s.time != null) { if (this.lastTime != null && Math.abs(s.time - this.lastTime) > 120 + 5 * dt) this.clear(); this.lastTime = s.time; }
    this.field.update(dt, { camPos: s.camPos || ZERO, sunDir: s.sunDir, sunColor: s.sunColor, ambient: s.ambient });
  }

  shift(dx, dy, dz) { this.field.shift(dx, dy, dz); this.launch.shift(dx, dy, dz); }

  clear() { this.field.clear(); this.launch.reset(); }

  dispose() { this.field.dispose(); }
}
const ZERO = new THREE.Vector3();
