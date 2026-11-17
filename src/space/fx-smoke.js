// A field of smoke, steam, dust and vapor puffs (and falling ice), simulated on the CPU and drawn as
// camera-facing octagons in one instanced draw call, plus a second, depth-only call for the solid ones.
// plume.js's ExhaustTrail owns one; fx-launch.js decides what goes into it.
//
// The simulation is deliberately simple and per puff: drag against the wind of its own layer (quadratic,
// so a jet leaves fast and stalls; plus a linear term that hands it to the wind, which is slower near the
// ground), growth by entrainment (in proportion to its speed through the air) and by slow diffusion up to
// a cap, buoyancy that dies away, a meander from a field of eddies all puffs share, and the ground, which
// puffs ride on as they swell. Ten thousand puffs cost about a millisecond and a half of CPU a frame.
//
// What makes them read as a volume instead of stickers:
//   - Sorting. Every frame the live puffs are ordered far to near from the camera (a two-pass counting
//     sort on the bits of the squared distance) and written to the instance buffers in that order.
//   - Shadows between puffs. Every few frames the puffs are ordered along the light and walked from the
//     lit side: each reads the optical depth laid down so far at its place in a hashed grid across the
//     light (three cell sizes, by puff size), and adds its own once the walk is clear of it. That gives
//     a cloud a sunlit side, a dark far side and a dark underside. With no sun worth the name the light
//     is taken from straight above, so the same pass shades the cloud's inside against the sky. A column
//     is a string of puffs all on one axis, which that walk would call dark from end to end whenever the
//     sun looks down its length: its puffs are flagged F_AXIAL and take their sunlight from across their
//     own axis instead, so the flank toward the sun is the lit one.
//   - The puff itself. A lumpy ball: a tiling "billow" noise (domes of mixed sizes, with their gradient
//     baked beside them) eats the silhouette into cauliflower lobes, tilts the fake normal and darkens the
//     creases; two copies of it cross-fade while expanding from the middle, so the lobes keep turning
//     over, faster while the puff is still moving. Edges start hard and soften with age. Light is the
//     sun (wrapped, times the shadow), a share of it scattered round inside, the sky from above, a
//     little bounce from below, the flame as a point light with falloff, each puff's own heat while it
//     is fresh, and a forward-scattered rim toward the sun. Puffs fade where they meet the ground under
//     them, and turn to mist and vanish as they come close to the eye.
//   - Depth. Where a puff is solid (opacity over a half) the second pass writes it into the depth buffer
//     after the color is down, so everything that works from depth afterwards (the flame behind the
//     smoke, the weather's clouds laid over the scene, focus, motion blur) takes it for the surface it
//     looks like. Left out on 'low'.
//   - A budget. The share of the screen the puffs will cover is estimated against the camera of the last
//     frame; over the quality level's budget, the big ones are thinned (and the rest made denser to
//     keep the cloud's opacity), smoothly, by each puff's own random number.
//
// Colors are in the game's scene-linear HDR units (a white surface in full sun is about the sun color
// passed in) and premultiplied. Positions are sent relative to the camera, so nothing loses precision
// far from the world's origin. No pow() of anything that can be negative, no unguarded normalize or
// division: Apple's GPUs are a target.

import * as THREE from 'three';

/** Live puffs allowed, emission rate against 'high', screens of overdraw allowed, frames between shadow passes, and whether solid smoke is written to the depth buffer. */
export const SMOKE_QUALITY = {
  low: { max: 3200, rate: 0.4, overdraw: 5, shadowEvery: 4, depth: false },
  med: { max: 6000, rate: 0.65, overdraw: 8, shadowEvery: 3, depth: true },
  high: { max: 10000, rate: 1, overdraw: 12, shadowEvery: 2, depth: true },
  ultra: { max: 16000, rate: 1.5, overdraw: 20, shadowEvery: 2, depth: true },
};
const CAP = 16000;

/** Shading constants (all can be changed at run time). */
export const SMOKE_TUNING = {
  sun: 1.0,            // direct sunlight on a puff's lit side, against a white surface
  fill: 0.16,          // sunlight that finds its way round inside a cloud (multiple scattering), share of the sun
  sky: 1.0,            // sky light
  depth: 1.2,          // optical depth through the middle of one fully opaque puff, for the shadows between puffs
  shadowFloor: 0.06,   // least direct light that reaches a puff deep in the cloud
  flame: 1.0,          // light of the flame on the smoke
  heat: 1.0,           // the glow of fresh exhaust itself
  writeDepth: true,    // solid smoke goes into the depth buffer (a second, cheap pass; off on 'low' regardless)
};

export const F_GROUND = 1, F_CONFINE = 2, F_ICE = 4, F_NOSHADE = 8, F_DIE_ON_GROUND = 16, F_AXIAL = 32;

// ---------------------------------------------------------------- noise

/** Tiling noise: r a billowy height (domes of mixed sizes over scattered points, four octaves), gb its gradient, a a soft cloudy field. */
let NOISE = null;
function noiseTexture() {
  if (NOISE) return NOISE;
  const N = 512, h = new Float32Array(N * N), w = new Float32Array(N * N), d = new Uint8Array(N * N * 4);
  let s = 90210;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 0) / 4294967296; };
  for (const [P, amp] of [[5, 1], [11, 0.5], [23, 0.25], [47, 0.12]]) {
    const fx = new Float32Array(P * P).map(() => rnd()), fy = new Float32Array(P * P).map(() => rnd()), fr = new Float32Array(P * P).map(() => 0.45 + 0.55 * rnd() * rnd());
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = (x / N) * P, v = (y / N) * P, cx = Math.floor(u), cy = Math.floor(v);
      let top = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const gx = (cx + ox + P) % P, gy = (cy + oy + P) % P, k = gy * P + gx, dx = u - (cx + ox + fx[k]), dy = v - (cy + oy + fy[k]);
        top = Math.max(top, (1 - (dx * dx + dy * dy) / (fr[k] * fr[k])) * (0.55 + 0.45 * fr[k]));
      }
      h[y * N + x] += amp * top;                                       // a dome over every cell point, big ones and small
    }
  }
  let amp = 1;
  for (const P of [4, 8, 16, 32, 64]) {
    const g = new Float32Array(P * P).map(() => rnd());
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * P, fy = (y / N) * P, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
      const a = g[y0 * P + x0], b = g[y0 * P + x1], c = g[y1 * P + x0], e = g[y1 * P + x1];
      w[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy);
    }
    amp *= 0.5;
  }
  // Both fields to a mean of one half and a spread that fills the byte.
  const norm = (f, k) => {
    let m = 0, v = 0;
    for (let i = 0; i < f.length; i++) m += f[i];
    m /= f.length;
    for (let i = 0; i < f.length; i++) v += (f[i] - m) * (f[i] - m);
    const sd = Math.sqrt(v / f.length) || 1;
    for (let i = 0; i < f.length; i++) f[i] = Math.max(0, Math.min(1, 0.5 + ((f[i] - m) / sd) * k));
  };
  norm(h, 0.24); norm(w, 0.22);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, xl = h[y * N + ((x + N - 1) % N)], xr = h[y * N + ((x + 1) % N)], yu = h[((y + N - 1) % N) * N + x], yd = h[((y + 1) % N) * N + x];
    d[i * 4] = h[i] * 255;
    d[i * 4 + 1] = Math.max(0, Math.min(255, 127.5 + (xr - xl) * 1500));
    d[i * 4 + 2] = Math.max(0, Math.min(255, 127.5 + (yd - yu) * 1500));
    d[i * 4 + 3] = w[i] * 255;
  }
  NOISE = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  NOISE.wrapS = NOISE.wrapT = THREE.RepeatWrapping; NOISE.minFilter = THREE.LinearMipmapLinearFilter; NOISE.magFilter = THREE.LinearFilter;
  NOISE.generateMipmaps = true; NOISE.needsUpdate = true;
  return NOISE;
}

// ---------------------------------------------------------------- shaders

const VS = /* glsl */`
attribute vec4 aPos;       // center relative to the mesh (which sits at the camera), radius
attribute vec4 aLook;      // height of the ground under it (same frame), turn, boil phase, opacity
attribute vec4 aTint;      // albedo, and how much of the sun reaches it through the rest of the cloud
attribute vec4 aKind;      // own heat, seed, softness (ice: glint), kind (0 a puff, 1 an ice flake)
attribute vec4 aLight;     // the direction the puff takes its sunlight from (world, packed 0..1): the sun's, or the sun's across a column's axis
uniform vec3 uSunDir, uFlamePos;
uniform float uFlameR2;
varying vec2 vUv;
varying vec4 vN0, vN1, vLook, vTint, vFlame;
varying vec3 vSun, vSunT, vUp, vView, vMisc;
#include <fog_pars_vertex>
vec2 hash2(float n) { return fract(sin(vec2(n, n + 7.31)) * vec2(437.585, 225.781)); }
void main() {
  float size = aPos.w;
  vec4 mvPosition = modelViewMatrix * vec4(aPos.xyz, 1.0);
  float dist = length(mvPosition.xyz);
  bool ice = aKind.w > 0.5;
  float nearby = ice ? 1.0 : smoothstep(0.3 * size + 1.5, size + 5.0, dist), a = aLook.w * nearby;      // gone before it can fill the screen
  float soft = max(aKind.z, 1.0 - nearby);                                                               // (and going as mist, not as a disk)
  float cs = cos(aLook.y), sn = sin(aLook.y);
  vec2 c = position.xy, off = c * size;
  if (ice) { c.y *= 0.25 + 0.75 * abs(cos(aLook.z)); off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size; }      // a flat flake, tumbling
  mvPosition.xy += off;
  #ifdef DEPTH_ONLY
  bool skip = ice || a < 0.55 || soft > 0.7;                 // only what is solid enough to hide things goes into the depth buffer
  #else
  bool skip = a < 0.004;
  #endif
  gl_Position = skip ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mvPosition;
  vUv = position.xy;
  // height of this corner above the ground under the puff, in radii
  vMisc = vec3((aPos.y + viewMatrix[1].x * off.x + viewMatrix[1].y * off.y - aLook.x) / max(size, 0.01), cs, sn);
  // two copies of the noise, half a cycle apart, each growing out from the middle and then swapped for a fresh patch
  float ph = aLook.z, seed = aKind.y, f0 = fract(ph), f1 = fract(ph + 0.5), sc = 0.2 + 0.09 * seed;
  vN0 = vec4(hash2(floor(ph) + seed * 251.0), sc * (1.15 - 0.3 * f0), 1.0 - abs(2.0 * f0 - 1.0));
  vN1 = vec4(hash2(floor(ph + 0.5) + seed * 251.0 + 37.0), sc * (1.15 - 0.3 * f1), 1.0 - abs(2.0 * f1 - 1.0));
  vLook = vec4(a, ice ? aKind.z : soft, aKind.x * 4.0, aKind.w);
  vTint = aTint;
  mat3 V = mat3(viewMatrix);
  vSun = V * (aLight.xyz * 2.0 - 1.0); vSunT = V * uSunDir; vUp = viewMatrix[1].xyz; vView = mvPosition.xyz;
  vec3 toF = V * (uFlamePos - aPos.xyz);
  float d2 = dot(toF, toF);
  vFlame = vec4(toF * inversesqrt(max(d2, 1.0)), uFlameR2 / (d2 + uFlameR2 + 1.0));
  #include <fog_vertex>
}`;

const FS = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uSunColor, uAmbient, uBounce, uFlameColor, uHeatColor;
uniform vec4 uShade;       // direct sun, fill, sky, own heat
varying vec2 vUv;
varying vec4 vN0, vN1, vLook, vTint, vFlame;
varying vec3 vSun, vSunT, vUp, vView, vMisc;
#include <fog_pars_fragment>
void main() {
  float r2 = dot(vUv, vUv), A = vLook.x;
  if (r2 >= 1.0 || A < 0.004) discard;
  float ball = 1.0 - r2, sh = vTint.a;
  vec2 q = vec2(vUv.x * vMisc.y - vUv.y * vMisc.z, vUv.x * vMisc.z + vUv.y * vMisc.y);
  vec4 n = texture2D(uNoise, q * vN0.z + vN0.xy) * vN0.w + texture2D(uNoise, q * vN1.z + vN1.xy) * vN1.w;
  n = 0.5 + (n - 0.5) * inversesqrt(max(vN0.w * vN0.w + vN1.w * vN1.w, 0.25));      // (a cross-fade flattens the contrast midway: put it back)
  vec3 S = normalize(vSunT + vec3(0.0, 0.0, 1.0e-5));
  vec3 col; float alpha;
  if (vLook.w > 0.5) {
    // a sheet of frost: an angular flake, bright when it turns its face to the sun
    float d = max(abs(vUv.x) * 0.85 + abs(vUv.y) * 0.5, abs(vUv.y) * 0.95) + (n.a - 0.5) * 0.5;
    alpha = A * (1.0 - smoothstep(0.62, 0.8, d));
    col = vTint.rgb * (uSunColor * uShade.x * sh * (0.3 + 1.1 * vLook.y) + uAmbient * uShade.z + uFlameColor * vFlame.w);
  } else {
    float soft = vLook.y, bil = clamp(n.r, 0.0, 1.0);
    // the silhouette: lobes where the billows stand proud, bays between them; crisp when fresh, feathered when old
    float edge = ball - mix(0.6, 0.04, bil) * mix(1.0, 0.7, soft);
    alpha = smoothstep(0.0, mix(0.07, 0.75, soft), edge);
    alpha *= mix(1.0, smoothstep(0.2, 0.7, n.a + 0.35 * ball), soft * 0.8);
    alpha *= smoothstep(0.0, 0.3, vMisc.x + (bil - 0.5) * 0.15) * A;      // into the ground
    #ifdef DEPTH_ONLY
    if (alpha < 0.5) discard;
    gl_FragColor = vec4(0.0);
    return;
    #endif
    if (alpha < 0.004) discard;
    vec2 g = (n.gb - 0.5) * 2.0, gq = vec2(g.x * vMisc.y + g.y * vMisc.z, g.y * vMisc.y - g.x * vMisc.z);
    vec3 N = normalize(vec3(vUv * 0.8 - gq * mix(1.0, 0.35, soft), sqrt(max(ball, 0.0)) * 0.75 + 0.3));
    float crev = mix(mix(0.42, 1.0, smoothstep(0.1, 0.7, bil)), 1.0, soft * 0.6);
    float wrap = clamp((dot(N, vSun) + 0.85 - 0.35 * min(length(vSun), 1.0)) / 1.5, 0.0, 1.0);      // (a column lit along its length has no dark side)
    float sky = 0.5 + 0.5 * dot(N, normalize(vUp + vec3(0.0, 1.0e-5, 0.0)));
    vec3 light = uSunColor * (uShade.x * mix(0.2, 1.0, wrap * wrap) * (0.25 + 0.75 * crev) * sh + uShade.y * (0.45 + 0.55 * sqrt(max(sh, 0.0))))
      + uAmbient * uShade.z * (0.5 + 0.5 * sky) * (0.65 + 0.35 * sh) * (0.6 + 0.4 * crev) + uBounce * (1.0 - sky);
    light += uFlameColor * vFlame.w * (0.35 + 0.65 * clamp(dot(N, vFlame.xyz) * 0.5 + 0.5, 0.0, 1.0)) * (0.4 + 0.6 * crev);
    // toward the sun the thin rim of a puff lights up
    float fs = max(dot(normalize(vView + vec3(0.0, 0.0, -1.0e-5)), S), 0.0); fs *= fs; fs *= fs; fs *= fs;
    light += uSunColor * uShade.x * fs * (1.0 - smoothstep(0.0, 0.5, edge)) * sh * 1.3;
    col = vTint.rgb * light + uHeatColor * uShade.w * vLook.z * (0.2 + 0.8 * bil * bil) * (0.4 + 0.6 * ball);
  }
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  gl_FragColor.rgb *= alpha;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- the field

const FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'size', 'size0', 'age', 'life', 'wx', 'wz', 'kq', 'kl', 'ent', 'dif', 'buoy', 'buoyTau', 'grav',
  'alpha', 'fadeIn', 'fadeOut', 'thin', 'soft0', 'softRate', 'rot', 'spin', 'phase', 'boil', 'turb', 'lift', 'gy', 'heat', 'heatTau', 'shadow', 'shTarget', 'now', 'seed', 'cr', 'cg', 'cb', 'dust', 'dustMax', 'cap', 'ax', 'ay', 'az'];

/** What a puff is made with (everything a caller does not set). */
export const PUFF = {
  kq: 0.004, kl: 0.1, ent: 0.1, dif: 0.8, buoy: 0.3, buoyTau: 40, grav: 0, alpha: 1, fadeIn: 0.3, fadeOut: 0.6, thin: 0, soft0: 0, softRate: 0.012,
  spin: 0.5, boil: 1, turb: 1, lift: 0.38, heat: 0, heatTau: 1, r: 0.96, g: 0.96, b: 0.95, dust: 0, cap: 150, flags: 0,
};

const fsin = (x) => { x -= Math.floor(x); return x < 0.5 ? 16 * x * (0.5 - x) : -16 * (x - 0.5) * (1 - x); };      // a parabola's worth of sine, period 1
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const HBITS = 16, HSIZE = 1 << HBITS, CELLS = [10, 26, 68];

export class SmokeField {
  constructor(quality = 'high') {
    for (const k of FIELDS) this[k] = new Float32Array(CAP);
    this.flags = new Uint8Array(CAP);
    this.n = 0; this.time = 0; this.frame = 0; this.rs = 12345; this.dropped = 0;
    this.d2 = new Float32Array(CAP); this.d2bits = new Uint32Array(this.d2.buffer);
    this.key = new Uint16Array(CAP); this.ia = new Uint16Array(CAP); this.ib = new Uint16Array(CAP); this.cnt = new Uint32Array(256);
    this.hk = new Int32Array(HSIZE); this.hv = new Float32Array(HSIZE);
    /** Height of the ground at (x, z), for puffs that ride on it. Replace it to describe a pad. */
    this.groundAt = () => -1e5;
    /** Called for puffs flagged F_CONFINE after each step, with the field and the puff's index: walls. */
    this.confine = null;
    /** Share of direct sunlight lost to the weather's cloud, by height (m): set by whoever knows. */
    this.shadeAt = null;
    this.flame = { pos: new THREE.Vector3(), color: new THREE.Color(1, 0.5, 0.2), power: 0, reach: 60 };
    /** What a puff's color goes to as its `dust` rises (the callback of F_CONFINE sets that). */
    this.dustColor = [0.6, 0.5, 0.39];
    /** Seconds the next update will advance by, when puffs are spawned before it (set by the emitter): a new puff is set back that much, so it ends the frame where it was put. */
    this.preroll = 0;
    this.thinK = 1; this.overdraw = 0; this.view = null;

    const geo = new THREE.InstancedBufferGeometry(), pos = [], idx = [];
    for (let k = 0; k < 8; k++) { const a = ((k + 0.5) / 8) * Math.PI * 2, r = 1 / Math.cos(Math.PI / 8); pos.push(Math.cos(a) * r, Math.sin(a) * r, 0); }
    for (let k = 1; k < 7; k++) idx.push(0, k, k + 1);
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx);
    const attr = (name, A, norm) => { const a = new THREE.InstancedBufferAttribute(new A(CAP * 4), 4, norm); a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, a); return a; };
    this.aPos = attr('aPos', Float32Array, false); this.aLook = attr('aLook', Float32Array, false);
    this.aTint = attr('aTint', Uint8ClampedArray, true); this.aKind = attr('aKind', Uint8ClampedArray, true); this.aLight = attr('aLight', Uint8ClampedArray, true);      // (clamped: a value a hair over 1 must not wrap round to black)
    geo.instanceCount = 0;
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() }, uSunColor: { value: new THREE.Vector3(1.4, 1.4, 1.4) }, uAmbient: { value: new THREE.Vector3(0.3, 0.4, 0.55) },
      uBounce: { value: new THREE.Vector3(0.05, 0.05, 0.04) }, uFlamePos: { value: new THREE.Vector3() }, uFlameR2: { value: 3600 }, uFlameColor: { value: new THREE.Vector3() },
      uHeatColor: { value: new THREE.Vector3(5, 1.9, 0.45) }, uShade: { value: new THREE.Vector4(1, 0.13, 1, 1) },
    }]);
    this.uniforms.uNoise = { value: noiseTexture() };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS, fog: true, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.name = 'smoke';
    // The same puffs again, depth only, after the color: where the smoke is solid it goes into the depth buffer, so
    // what is drawn or worked out afterwards from depth (the flame behind it, the weather's clouds, focus, motion blur)
    // takes it for the surface it looks like.
    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VS, fragmentShader: FS, defines: { DEPTH_ONLY: 1 }, fog: false, transparent: true, depthWrite: true, colorWrite: false,
    });
    this.depthMesh = new THREE.Mesh(geo, this.depthMaterial);
    this.depthMesh.frustumCulled = false; this.depthMesh.renderOrder = 6; this.depthMesh.name = 'smoke depth';
    // The camera this was last drawn with: the next frame's overdraw estimate is made against it.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      const v = this.view || (this.view = { fwd: new THREE.Vector3(), tan: 0.52, aspect: 1.78 }), e = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
      v.fwd.set(-e[8], -e[9], -e[10]); v.tan = 1 / Math.max(p[5], 0.05); v.aspect = Math.max(p[5] / Math.max(p[0], 0.05), 0.2);
    };
    this.object = new THREE.Group(); this.object.name = 'exhaust trail'; this.object.add(this.mesh, this.depthMesh);
    this.setQuality(quality);
  }

  setQuality(q) {
    const Q = SMOKE_QUALITY[q] || SMOKE_QUALITY.high;
    this.quality = SMOKE_QUALITY[q] ? q : 'high'; this.max = Q.max; this.rate = Q.rate; this.budget = Q.overdraw; this.shadowEvery = Q.shadowEvery; this.writeDepth = Q.depth;
    /** Sizes grow as the count falls, so a cloud keeps its bulk. */
    this.sizeK = Math.pow(1 / Q.rate, 0.33);
  }

  rnd() { this.rs = (Math.imul(this.rs, 1664525) + 1013904223) | 0; return (this.rs >>> 0) / 4294967296; }

  /**
   * A new puff of look P (see PUFF) at a place, with a velocity (m/s), radius (m), life (s) and the wind of its layer.
   * `lead` is how long ago within this step it was really born. Returns its index (or -1 when the field is full),
   * good until the next step, for setting anything else.
   */
  spawn(P, x, y, z, vx, vy, vz, size, life, windX, windZ, lead = 0) {
    if (this.n >= this.max) { this.dropped++; return -1; }
    const i = this.n++;
    lead -= this.preroll;                                    // the step that follows will carry it this much further
    this.px[i] = x + vx * lead; this.py[i] = y + vy * lead; this.pz[i] = z + vz * lead; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.size[i] = this.size0[i] = size; this.age[i] = lead; this.life[i] = life; this.wx[i] = windX; this.wz[i] = windZ;
    this.kq[i] = P.kq; this.kl[i] = P.kl; this.ent[i] = P.ent; this.dif[i] = P.dif; this.buoy[i] = P.buoy; this.buoyTau[i] = P.buoyTau; this.grav[i] = P.grav;
    this.alpha[i] = P.alpha; this.fadeIn[i] = P.fadeIn; this.fadeOut[i] = P.fadeOut; this.thin[i] = P.thin; this.soft0[i] = P.soft0; this.softRate[i] = P.softRate;
    this.rot[i] = this.rnd() * 6.2832; this.spin[i] = (this.rnd() - 0.5) * 2 * P.spin; this.phase[i] = this.rnd() * 8; this.boil[i] = P.boil; this.turb[i] = P.turb; this.lift[i] = P.lift;
    this.gy[i] = -1e5; this.heat[i] = P.heat; this.heatTau[i] = P.heatTau; this.shadow[i] = this.shTarget[i] = 1; this.now[i] = 0; this.seed[i] = this.rnd();
    this.cr[i] = P.r; this.cg[i] = P.g; this.cb[i] = P.b; this.dust[i] = 0; this.dustMax[i] = P.dust; this.cap[i] = P.cap; this.flags[i] = P.flags; this.ax[i] = 0; this.ay[i] = 1; this.az[i] = 0;
    return i;
  }

  _kill(i) {
    const j = --this.n;
    if (i !== j) { for (const k of FIELDS) this[k][i] = this[k][j]; this.flags[i] = this.flags[j]; }
  }

  _step(dt) {
    const { px, py, pz, vx, vy, vz, size, age, life, wx, wz, kq, kl, ent, dif, buoy, buoyTau, grav, rot, spin, phase, boil, turb, lift, gy, heat, heatTau, flags, cap } = this;
    const t = this.time, t1 = t * 0.021, t2 = t * 0.057, fr = this.frame, ground = this.groundAt, confine = this.confine, lerpUp = Math.min(1, dt * 5);
    for (let i = 0; i < this.n;) {
      const a = age[i] + dt, fl = flags[i];
      if (a >= life[i]) { this._kill(i); continue; }
      age[i] = a;
      const X = px[i], Y = py[i], Z = pz[i], s = size[i];
      let g = gy[i];
      if (fl & F_GROUND && (((i + fr) & 7) === 0 || g < -9e4)) { g = ground(X, Z); gy[i] = g; }      // (asked for one puff in eight a step: the ground under a puff changes slowly, and the answer can be dear)
      // the wind is slower near the ground
      const hgt = Y - g, bl = hgt > 150 ? 1 : hgt < 0 ? 0.5 : 0.5 + hgt / 300, wxl = wx[i] * bl, wzl = wz[i] * bl;
      let rx = vx[i] - wxl, ry = vy[i], rz = vz[i] - wzl;
      const sp = Math.sqrt(rx * rx + ry * ry + rz * rz), f = 1 / (1 + (kq[i] * sp + kl[i]) * dt);
      rx *= f; ry *= f; rz *= f;
      const b = buoy[i];
      ry += (b - grav[i]) * dt; buoy[i] = b * Math.max(0, 1 - dt / buoyTau[i]);
      vx[i] = rx + wxl; vy[i] = ry; vz[i] = rz + wzl;
      // eddies: two scales of a field every puff shares, so neighbors move together
      const ta = turb[i] * (0.9 + 0.05 * sp), xa = X * 0.0037, ya = Y * 0.0041, za = Z * 0.0039, xb = X * 0.0113, yb = Y * 0.0127, zb = Z * 0.0119;
      const ex = fsin(za + ya * 0.7 + t1) + 0.55 * fsin(yb - zb * 0.6 + t2 + 0.31), ey = 0.6 * fsin(xa - za * 0.8 + t1 * 0.9 + 0.63) + 0.45 * fsin(xb + zb * 0.7 - t2 + 0.11), ez = fsin(xa * 0.9 + ya + t1 * 1.1 + 0.27) + 0.55 * fsin(xb * 0.8 - yb + t2 * 1.2 + 0.77);
      px[i] = X + (vx[i] + ex * ta) * dt; pz[i] = Z + (vz[i] + ez * ta) * dt;
      let y = Y + (ry + ey * ta) * dt;
      const sNew = s + (ent[i] * sp + dif[i] / (1 + 0.08 * a)) * Math.max(0, 1 - s / cap[i]) * dt;
      size[i] = sNew;
      if (fl & F_GROUND) {
        const floor = g + sNew * lift[i];
        if (y < floor) {
          if (fl & F_DIE_ON_GROUND) { this._kill(i); continue; }
          y = y < floor - 2 * sNew ? floor : y + (floor - y) * lerpUp; if (ry < 0) vy[i] = ry * 0.3;
        }
      }
      py[i] = y;
      const act = Math.min(sp / (sNew + 4), 4);
      phase[i] += dt * boil[i] * (0.02 + 0.22 * act); rot[i] += dt * spin[i] * (0.03 + 0.5 * act);
      heat[i] *= Math.max(0, 1 - dt / heatTau[i]);
      if (fl & F_CONFINE) confine(this, i);
      i++;
    }
  }

  /** Two passes of a counting sort over the 16-bit keys of the first n puffs; the order comes back in this.ia. */
  _sort(n) {
    const { key, ia, ib, cnt } = this;
    for (let pass = 0; pass < 2; pass++) {
      const sh = pass * 8, src = pass ? ib : null, dst = pass ? ia : ib;
      cnt.fill(0);
      for (let i = 0; i < n; i++) cnt[(key[i] >> sh) & 255]++;
      let sum = 0;
      for (let k = 0; k < 256; k++) { const c = cnt[k]; cnt[k] = sum; sum += c; }
      if (src) for (let j = 0; j < n; j++) { const i = src[j]; dst[cnt[(key[i] >> sh) & 255]++] = i; }
      else for (let i = 0; i < n; i++) dst[cnt[(key[i] >> sh) & 255]++] = i;
    }
    return ia;
  }

  /** How much light reaches each puff through the others, from direction (lx, ly, lz). */
  _shadows(lx, ly, lz) {
    const n = this.n, { px, py, pz, size, now, shTarget, flags, key, hk, hv } = this;
    if (!n) return;
    let lo = Infinity, hi = -Infinity;
    const d2 = this.d2;                                              // (free between frames: the camera sort refills it)
    for (let i = 0; i < n; i++) { const t = px[i] * lx + py[i] * ly + pz[i] * lz; d2[i] = t; if (t < lo) lo = t; if (t > hi) hi = t; }
    const sc = 65535 / Math.max(hi - lo, 1);
    for (let i = 0; i < n; i++) key[i] = 65535 - Math.floor((d2[i] - lo) * sc);      // nearest the light first
    const order = this._sort(n);
    // two axes across the light
    let ux = ly, uy = -lx, uz = 0;
    if (Math.abs(lz) > 0.9) { ux = 0; uy = lz; uz = -ly; }
    const ul = 1 / Math.hypot(ux, uy, uz); ux *= ul; uy *= ul; uz *= ul;
    const wx = ly * uz - lz * uy, wy = lz * ux - lx * uz, wz = lx * uy - ly * ux;
    hk.fill(0); hv.fill(0);
    const mask = HSIZE - 1, K = SMOKE_TUNING.depth * 1.6, floorL = SMOKE_TUNING.shadowFloor, LAG = 0.55;
    // A puff's own depth is laid down only once the walk is clear of it (deposits trail the reads by most of a
    // radius), so puffs side by side in one layer do not darken each other: only what is properly in front does.
    const slot = (L, cu, cv) => {
      const k = (((cu & 0x1fff) | ((cv & 0x1fff) << 13) | (L << 26)) + 1) | 0;
      let h = Math.imul(k, 0x9e3779b1) >>> (32 - HBITS), tries = 0;
      while (hk[h] !== 0 && hk[h] !== k && tries < 24) { h = (h + 1) & mask; tries++; }
      return hk[h] === k ? h : tries < 24 ? -h - 1 : -HSIZE - 1;      // found; or free at -(h + 1); or no room
    };
    let dp = 0;
    for (let j = 0; j < n; j++) {
      const i = order[j], tj = d2[i];
      for (; dp < j; dp++) {
        const e = order[dp], s = size[e];
        if (d2[e] - LAG * s < tj) break;
        if (flags[e] & F_NOSHADE || now[e] < 0.01) continue;
        const L = s < 14 ? 0 : s < 36 ? 1 : 2, c = CELLS[L], fu = (px[e] * ux + py[e] * uy + pz[e] * uz) / c - 0.5, fv = (px[e] * wx + py[e] * wy + pz[e] * wz) / c - 0.5;
        const iu = Math.floor(fu), iv = Math.floor(fv), tu = fu - iu, tv = fv - iv, add = K * now[e] * (s * s) / (c * c);
        for (let q = 0; q < 4; q++) {
          let h = slot(L, iu + (q & 1), iv + (q >> 1));
          if (h < -HSIZE) continue;
          if (h < 0) { h = -h - 1; hk[h] = (((iu + (q & 1)) & 0x1fff) | (((iv + (q >> 1)) & 0x1fff) << 13) | (L << 26)) + 1; }
          hv[h] += add * (q & 1 ? tu : 1 - tu) * (q >> 1 ? tv : 1 - tv);
        }
      }
      if (flags[i] & F_NOSHADE) { shTarget[i] = 1; continue; }
      const pu = px[i] * ux + py[i] * uy + pz[i] * uz, pv = px[i] * wx + py[i] * wy + pz[i] * wz;
      let tau = 0;
      for (let L = 0; L < 3; L++) {
        const c = CELLS[L], fu = pu / c - 0.5, fv = pv / c - 0.5, iu = Math.floor(fu), iv = Math.floor(fv), tu = fu - iu, tv = fv - iv;
        for (let q = 0; q < 4; q++) { const h = slot(L, iu + (q & 1), iv + (q >> 1)); if (h >= 0) tau += hv[h] * (q & 1 ? tu : 1 - tu) * (q >> 1 ? tv : 1 - tv); }
      }
      shTarget[i] = floorL + (1 - floorL) * Math.exp(-tau);
    }
  }

  /**
   * Advance by dt and get ready to draw: s = { camPos, sunDir, sunColor, ambient }.
   */
  update(dt, s) {
    const cam = s.camPos, n0 = this.n;
    this.preroll = 0;
    if (dt > 0) {
      const steps = Math.min(4, Math.ceil(dt / 0.05)), h = Math.min(dt, 0.2) / steps;
      for (let k = 0; k < steps; k++) { this.time += h; this._step(h); }
    }
    this.frame++;
    const U = this.uniforms, T = SMOKE_TUNING, n = this.n;
    const sd = s.sunDir, sc = s.sunColor, am = s.ambient;
    if (sd) U.uSunDir.value.copy(sd);
    if (sc) U.uSunColor.value.set(sc.r, sc.g, sc.b);
    if (am) U.uAmbient.value.set(am.r, am.g, am.b);
    const sun = U.uSunDir.value, sC = U.uSunColor.value, aC = U.uAmbient.value;
    const sunLum = (sC.x * 0.3 + sC.y * 0.5 + sC.z * 0.2) * Math.max(sun.y, 0), ambLum = aC.x * 0.3 + aC.y * 0.5 + aC.z * 0.2;
    // The light the shadows are cast by: the sun while it counts, else the sky overhead.
    if (this.fromSun === undefined) this.fromSun = sunLum > 0.3 * ambLum;
    else if (this.fromSun ? sunLum < 0.2 * ambLum : sunLum > 0.4 * ambLum) this.fromSun = !this.fromSun;
    U.uBounce.value.set(0.3 * sC.x * Math.max(sun.y, 0) + 0.5 * aC.x, 0.3 * sC.y * Math.max(sun.y, 0) + 0.5 * aC.y, 0.3 * sC.z * Math.max(sun.y, 0) + 0.5 * aC.z).multiplyScalar(0.22);
    U.uShade.value.set(T.sun, T.fill, T.sky, T.heat);
    const F = this.flame;
    U.uFlamePos.value.set(F.pos.x - cam.x, F.pos.y - cam.y, F.pos.z - cam.z); U.uFlameR2.value = F.reach * F.reach;
    U.uFlameColor.value.set(F.color.r, F.color.g, F.color.b).multiplyScalar(F.power * T.flame);
    this.mesh.position.copy(cam); this.depthMesh.position.copy(cam);
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0; this.depthMesh.visible = n > 0 && this.writeDepth && SMOKE_TUNING.writeDepth;
    if (!n) { this.overdraw = 0; return; }

    // ---- opacity now, and the shadows between puffs
    const { px, py, pz, size, size0, age, life, alpha, fadeIn, fadeOut, thin, now, shadow, shTarget, flags } = this;
    for (let i = 0; i < n; i++) {
      const a = age[i], L = life[i], fo = fadeOut[i] * L;
      let o = alpha[i] * smooth(0, fadeIn[i], a) * (1 - smooth(fo, L, a));
      if (thin[i] > 0) o *= Math.min(1, Math.pow(size0[i] * 2.5 / size[i], thin[i]));
      now[i] = o;
    }
    if (dt > 0 && (this.frame % this.shadowEvery === 0 || n0 === 0)) { if (this.fromSun) this._shadows(sun.x, sun.y, sun.z); else this._shadows(0, 1, 0); }
    const ks = dt > 0 ? Math.min(1, dt * 3.5) : 0;

    // ---- how much of the screen all this covers, and the thinning that keeps it within the budget
    const v = this.view, d2 = this.d2, key = this.key, bits = this.d2bits;
    const tan = v ? v.tan : 0.52, asp = v ? v.aspect : 1.78, cK = 0.83 / (tan * tan * asp), cone = v ? Math.sqrt(1 + tan * tan * (1 + asp * asp)) : 0;
    let small = 0, big = 0;
    for (let i = 0; i < n; i++) {
      const dx = px[i] - cam.x, dy = py[i] - cam.y, dz = pz[i] - cam.z, q = dx * dx + dy * dy + dz * dz, s = size[i];
      d2[i] = q;
      if (ks > 0) shadow[i] += (shTarget[i] - shadow[i]) * ks;
      if (flags[i] & F_ICE || now[i] < 0.02) continue;
      // inside the view? (a cone round the frustum, widened by the puff's own radius)
      if (v) { const along = dx * v.fwd.x + dy * v.fwd.y + dz * v.fwd.z, d = Math.sqrt(q); if (along * cone + s < d) continue; }
      const c = Math.min(cK * s * s / Math.max(q, s * s * 0.5), 1.2) * smooth(0.3 * s + 1.5, s + 5, Math.sqrt(q));
      if (c > 0.004) big += c * smooth(0.001, 0.004, c); small += c * (1 - smooth(0.001, 0.004, c));
    }
    for (let i = 0; i < n; i++) key[i] = 0xffff - (bits[i] >>> 15);      // far first (the bits of a positive float sort as it does)
    const want = big > 1e-6 ? Math.max(0.06, Math.min(1, (this.budget - small) / big)) : 1;
    this.thinK += (want - this.thinK) * (want < this.thinK ? Math.min(1, dt * 4 + (dt > 0 ? 0 : 1)) : Math.min(1, dt * 2.5));
    this.overdraw = small + big;
    const k = this.thinK, boost = 1 / Math.max(k, 0.06);

    // ---- into the instance buffers, far to near
    const order = this._sort(n), P = this.aPos.array, Lk = this.aLook.array, Tn = this.aTint.array, Kd = this.aKind.array, Lt = this.aLight.array;
    const { ax, ay, az } = this, lx = sun.x * 127.5 + 127.5, ly = sun.y * 127.5 + 127.5, lz = sun.z * 127.5 + 127.5;
    const { gy, rot, phase, heat, seed, soft0, softRate, cr, cg, cb, dust } = this, shadeAt = this.shadeAt, DC = this.dustColor;
    for (let j = 0; j < n; j++) {
      const i = order[j], o = j * 4, s = size[i], a = age[i], q = d2[i], ice = flags[i] & F_ICE;
      let op = now[i], grown = s * (0.6 + 0.4 * smooth(0, fadeIn[i] * 1.5, a));
      if (k < 0.999 && !ice) {
        const c = Math.min(cK * s * s / Math.max(q, s * s * 0.5), 1.2), part = smooth(0.001, 0.004, c);
        if (part > 0) { const keep = Math.max(0, Math.min(1, (k * 1.15 - seed[i]) / 0.15)); op += (keep * (1 - Math.pow(1 - Math.min(op, 0.98), boost)) - op) * part; }
      }
      P[o] = px[i] - cam.x; P[o + 1] = py[i] - cam.y; P[o + 2] = pz[i] - cam.z; P[o + 3] = ice ? s : grown;
      Lk[o] = gy[i] - cam.y; Lk[o + 1] = rot[i]; Lk[o + 2] = phase[i]; Lk[o + 3] = Math.min(op, 1);
      let sh = shadow[i];
      if (shadeAt && this.fromSun) sh *= 1 - shadeAt(py[i]);
      const du = dust[i];
      Tn[o] = (cr[i] + (DC[0] - cr[i]) * du) * 255; Tn[o + 1] = (cg[i] + (DC[1] - cg[i]) * du) * 255; Tn[o + 2] = (cb[i] + (DC[2] - cb[i]) * du) * 255; Tn[o + 3] = sh * 255;
      Kd[o] = Math.min(255, heat[i] * 63.75); Kd[o + 1] = seed[i] * 255;
      if (flags[i] & F_AXIAL) {
        // across the column's own axis: its flank toward the sun is the lit one, however steeply the sun looks down it
        const d = sun.x * ax[i] + sun.y * ay[i] + sun.z * az[i], ex = sun.x - d * ax[i], ey = sun.y - d * ay[i], ez = sun.z - d * az[i], g = Math.min(1.6, 1 / Math.max(Math.hypot(ex, ey, ez), 0.05)) * 127.5;
        Lt[o] = ex * g + 127.5; Lt[o + 1] = ey * g + 127.5; Lt[o + 2] = ez * g + 127.5;
      } else { Lt[o] = lx; Lt[o + 1] = ly; Lt[o + 2] = lz; }
      Kd[o + 2] = ice ? 255 * Math.pow(Math.abs(fsin(phase[i] * 0.37 + seed[i])), 3) : 255 * Math.max(0, Math.min(1, soft0[i] + softRate[i] * a + 0.45 * du)); Kd[o + 3] = ice ? 255 : 0;
    }
    for (const at of [this.aPos, this.aLook, this.aTint, this.aKind, this.aLight]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * 4); at.needsUpdate = true; }
  }

  /** The world's origin moved: everything goes with it. */
  shift(dx, dy, dz) {
    const { px, py, pz, gy } = this;
    for (let i = 0; i < this.n; i++) { px[i] += dx; py[i] += dy; pz[i] += dz; gy[i] += dy; }
    this.flame.pos.x += dx; this.flame.pos.y += dy; this.flame.pos.z += dz;
  }

  clear() { this.n = 0; this.mesh.geometry.instanceCount = 0; this.mesh.visible = this.depthMesh.visible = false; this.thinK = 1; this.flame.power = 0; }

  dispose() { this.mesh.geometry.dispose(); this.material.dispose(); this.depthMaterial.dispose(); this.object.removeFromParent(); }
}
