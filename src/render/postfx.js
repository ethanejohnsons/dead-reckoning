// Post-processing: everything between the HDR frame and the screen.
//
//   surfaces   ambient occlusion from depth; open water mirrors what stands over it
//   time       temporal anti-aliasing, motion blur while the shutter is open
//   lens       depth of field with autofocus, barrel distortion, chromatic aberration,
//              bloom (widening into halos in mist), dirt, streak, halation, flare, glare
//   air        crepuscular rays through cloud gaps, heat shimmer behind the exhaust
//   glass      rain beading and running on the windshield, frost feathering in from the edges
//   print      exposure, white balance, film curve, grade, vignette
//   finish     sharpening (and FXAA where there is no temporal anti-aliasing), grain, dither
//
// Each pass is timed on the graphics card while the debug panel is open (render/perf.js: window.DR.perf.passes).
//
// The input is linear HDR in rgb; alpha says how much open sky shows at each
// pixel (cloud transmittance where there is no geometry, 0 elsewhere), which
// is what lets the sun be hidden by clouds and terrain. The depth-aware passes
// (postfx-scene.js) also want the scene's depth texture; the camera side is in
// postfx-lens.js.
//
// The game drives it through one plain object, postfx.fx (see the constructor).

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { FullscreenQuad, fsMaterial, hdrTarget } from './fullscreen.js';
import { AO_FRAG, SCENE_FRAG, TAA_FRAG, MBLUR_FRAG, FOCUS_FRAG, TILE_FRAG, DOF_FRAG } from './postfx-scene.js';
import { perf } from './perf.js';
import { GLASS_VERT, GLASS_FRAG, FINAL_VERT, FINAL_FRAG, STREAK_FRAG, OUT_FRAG, makeLensDirt } from './postfx-lens.js';

// 'low' is the old stack and nothing else: no pass that reads depth. 'med' and 'high'
// run everything and differ in sample counts.
//   deep: depth passes at all   ao: slices x steps per side   ssr: march steps   mb, dof: taps
//   maxCoc: widest blur circle, pixels of radius at 1080 lines
const TIERS = {
  low: { levels: 5, chroma: 0, raySteps: 8, deep: 0, ao: [0, 0], ssr: 0, taa: 0, mb: 0, dof: 0, maxCoc: 0, streak: 0 },
  med: { levels: 6, chroma: 1, raySteps: 10, deep: 1, ao: [2, 4], ssr: 28, taa: 1, mb: 9, dof: 18, maxCoc: 10, streak: 1 },
  high: { levels: 7, chroma: 1, raySteps: 16, deep: 1, ao: [4, 6], ssr: 56, taa: 1, mb: 15, dof: 32, maxCoc: 14, streak: 1 },
  ultra: { levels: 7, chroma: 1, raySteps: 24, deep: 1, ao: [4, 8], ssr: 72, taa: 1, mb: 15, dof: 32, maxCoc: 14, streak: 1 },
};

const DOWN_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
#if FIRST
  // A NaN or infinite pixel from the scene would otherwise be clamped to a 64.0 flare and bloom across the frame.
  // (The test is on the bits as well: some shader compilers assume there are no such numbers and drop isnan() and isinf().)
  bool unreal(vec3 c) { return any(equal(floatBitsToUint(c) & uvec3(0x7F800000u), uvec3(0x7F800000u))); }
  vec3 s(float x, float y) { vec3 c = texture(tSrc, vUv + vec2(x, y) * uTexel).rgb; return unreal(c) || any(isnan(c)) || any(isinf(c)) || !(c.r + c.g + c.b < 1.0e5) ? vec3(0.0) : clamp(c, 0.0, 6.0e4); }
#else
  vec3 s(float x, float y) { return texture(tSrc, vUv + vec2(x, y) * uTexel).rgb; }
#endif
float kw(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
void main() {
  // 13-tap downsample: five overlapping 2x2 boxes, the center one weighted double.
  vec3 a = s(-2.0, 2.0), b = s(0.0, 2.0), c = s(2.0, 2.0), d = s(-2.0, 0.0), e = s(0.0, 0.0), f = s(2.0, 0.0);
  vec3 g = s(-2.0, -2.0), h = s(0.0, -2.0), i = s(2.0, -2.0), j = s(-1.0, 1.0), k = s(1.0, 1.0), l = s(-1.0, -1.0), m = s(1.0, -1.0);
  vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
  #if FIRST
    // Weight each box by 1/(1+brightness) so one hot pixel cannot flicker the whole bloom.
    g0 = min(g0, vec3(64.0)); g1 = min(g1, vec3(64.0)); g2 = min(g2, vec3(64.0)); g3 = min(g3, vec3(64.0)); g4 = min(g4, vec3(64.0));
    float w0 = 0.5 * kw(g0), w1 = 0.125 * kw(g1), w2 = 0.125 * kw(g2), w3 = 0.125 * kw(g3), w4 = 0.125 * kw(g4);
    outColor = vec4((g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
  #else
    outColor = vec4(g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125, 1.0);
  #endif
}`;

const UP_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tLow, tHigh;
uniform vec2 uTexel;
uniform float uMix;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 d = uTexel;
  vec3 t = texture(tLow, vUv).rgb * 4.0
    + (texture(tLow, vUv + vec2(d.x, 0.0)).rgb + texture(tLow, vUv - vec2(d.x, 0.0)).rgb + texture(tLow, vUv + vec2(0.0, d.y)).rgb + texture(tLow, vUv - vec2(0.0, d.y)).rgb) * 2.0
    + texture(tLow, vUv + d).rgb + texture(tLow, vUv - d).rgb + texture(tLow, vUv + vec2(d.x, -d.y)).rgb + texture(tLow, vUv + vec2(-d.x, d.y)).rgb;
  outColor = vec4(mix(texture(tHigh, vUv).rgb, t / 16.0, uMix), 1.0);
}`;

// Radial blur of "how much bright sky shows" toward the sun's place on screen.
// Run twice (coarse then fine) it costs a few taps yet behaves like their product.
const RAYS_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uSun;        // sun position in uv
uniform float uAspect, uSpan, uFirst;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 dir = (uSun - vUv) * uSpan / float(RAY_STEPS);
  float acc = 0.0, wsum = 0.0;
  for (int i = 0; i < RAY_STEPS; i++) {
    vec2 uv = vUv + dir * (float(i) + 0.5);
    float w = 1.0 - float(i) / float(RAY_STEPS) * 0.55;
    float m;
    if (uFirst > 0.5) {
      // Only sky close to the sun is bright enough to throw shafts.
      vec2 q = (uv - uSun) * vec2(uAspect, 1.0);
      float glow = exp(-dot(q, q) * 3.4) * 0.8 + exp(-dot(q, q) * 26.0) * 0.5;
      m = texture(tSrc, uv).a * glow;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) m = glow * 0.6;
    } else m = texture(tSrc, uv).r;
    acc += m * w; wsum += w;
  }
  outColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;


// Shows one intermediate buffer instead of the picture (postfx.debug = 'ao' | 'vel' | 'dof' | 'tile' | 'rays' | 'streak').
const DEBUG_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec4 uScale;
in vec2 vUv;
out vec4 outColor;
void main() { vec4 c = texture(tSrc, vUv); outColor = vec4(pow(clamp(uScale.w > 1.5 ? vec3(c.r) : abs(c.rgb * uScale.rgb), 0.0, 1.0), vec3(1.0 / 2.2)), 1.0); }`;

const vPos = new THREE.Vector3(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), cTmp = new THREE.Color();
const mV = new THREE.Matrix4(), mVP = new THREE.Matrix4(), mInv = new THREE.Matrix4(), mD = new THREE.Matrix4(), qA = new THREE.Quaternion();
const { clamp, lerp, smoothstep } = THREE.MathUtils;
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
// Where the exhaust stacks end, in the aircraft's own coordinates (nose toward -z).
const EXHAUST = [[0.79, -0.11, -3.72], [-0.79, -0.11, -3.72]];
const U = (value) => ({ value });
const V2 = () => U(new THREE.Vector2()), V3 = () => U(new THREE.Vector3()), M3 = () => U(new THREE.Matrix3()), M4 = () => U(new THREE.Matrix4());
const pixel = (r, g, b, a) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1); t.needsUpdate = true; return t; };

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    perf.init(renderer);
    /**
     * Per-frame parameters, filled by the game. Anything left alone keeps its default.
     * Strengths are 1 = as a real camera would give it, 0 = off, more = heavier.
     *   time        seconds, animates drops and grain and times the shutter
     *   rain, snow  0..1 precipitation at the camera        ice  0..1 frost on the glass
     *   cockpit     0 outside views (no water or frost at all), 1 behind the windshield. There the eye replaces the
     *               camera: no depth of field, lens distortion or color fringing, and the cabin keeps its full sharpness
     *   glass       the aircraft's glazing mesh (hull uv, alphaMap = 1 on glass): rain and frost are drawn on it
     *   airspeed    m/s; above ~20 the airflow drives water up the glass
     *   clearance   meters from the camera to the nearest scenery (height above ground will do); lets motion blur be
     *               skipped when nothing can streak. Left unset it is taken as 20 m
     *   flash       0..1 additive lightning flash
     *   exposure    linear exposure before the tone curve (0.64 keeps mid-gray where the game was tuned)
     *   subject     the aircraft's Object3D: it keeps its own motion (stable under TAA) and is never motion-blurred
     *   exhaust     exhaust outlets in the subject's coordinates, for the heat plume
     *   bloom       share of the image replaced by its blur (0.07)
     *   ssr         mirror reflections on open water          ao        ambient occlusion
     *   taa         temporal anti-aliasing (0 = FXAA only)    motionBlur shutter, 1 = 1/100 s
     *   dof         aperture, 1 = f/4 on a full-frame body    distort   barrel distortion
     *   dirt, streak, halation, glare, flare, rays, mist, heat: lens and air
     *   filmic      highlight roll-off toward white           wb        white balance following the light
     *   clarity     local contrast    grade   split-toning    sharpen, vignette, grain, chroma
     */
    this.fx = {
      time: 0, rain: 0, snow: 0, ice: 0, cockpit: 0, airspeed: 0, flash: 0, exposure: 0.64, subject: null, exhaust: EXHAUST, glass: null,
      bloom: 0.07, ssr: 1, ao: 1, taa: 1, motionBlur: 1, dof: 1, distort: 1, dirt: 1, streak: 1, halation: 1, glare: 1, flare: 1, rays: 1,
      mist: 1, heat: 1, filmic: 1, wb: 1, clarity: 1, grade: 1, sharpen: 1, vignette: 1, grain: 1, chroma: 1,
    };
    this.flashExtra = 0;
    this.tier = 'med';
    this.wet = 0;                 // smoothed wetness so the glass dries gradually
    this.lastTime = 0; this.frame = 0; this.reset = true; this.taaValid = false; this.dofValid = false; this.jit = false;
    this.prevVP = new THREE.Matrix4(); this.prevPos = new THREE.Vector3(); this.prevSub = new THREE.Matrix4(); this.prevQuat = new THREE.Quaternion();
    this.saveP = new THREE.Matrix4(); this.savePI = new THREE.Matrix4();
    this.box = new THREE.Box3(); this.boxFor = null; this.jitterPx = new THREE.Vector2();
    this.white = pixel(255, 255, 255, 255); this.black = pixel(0, 0, 0, 0);
    this.dirt = makeLensDirt();
    this.quad = new FullscreenQuad();
    const T = TIERS[this.tier];

    this.downFirst = fsMaterial(DOWN_FRAG, { tSrc: U(null), uTexel: V2() }, { defines: { FIRST: 1 } });
    this.down = fsMaterial(DOWN_FRAG, { tSrc: U(null), uTexel: V2() }, { defines: { FIRST: 0 } });
    this.up = fsMaterial(UP_FRAG, { tLow: U(null), tHigh: U(null), uTexel: V2(), uMix: U(0.6) });
    this.uSun = V2(); this.uAspect = U(1); this.uRes = V2();
    this.raysMat = fsMaterial(RAYS_FRAG, { tSrc: U(null), uSun: this.uSun, uAspect: this.uAspect, uSpan: U(1), uFirst: U(1) }, { defines: { RAY_STEPS: T.raySteps } });
    this.streakMat = fsMaterial(STREAK_FRAG, { tSrc: U(null), uStep: V2(), uThreshold: U(0) });

    // Depth passes share the depth texture and the projection.
    this.uDepth = U(null); this.uProj = U(new THREE.Vector4()); this.uFrame = U(0);
    this.aoMat = fsMaterial(AO_FRAG, { tDepth: this.uDepth, uProj: this.uProj, uRes: this.uRes, uFrame: this.uFrame }, { defines: { AO_SLICES: T.ao[0], AO_STEPS: T.ao[1] } });
    this.sceneMat = fsMaterial(SCENE_FRAG, {
      tDepth: this.uDepth, uProj: this.uProj, uRes: this.uRes, uFrame: this.uFrame,
      tHdr: U(null), tScene: U(null), tAO: U(null), tCloud: U(null), tDetail: ENV.tDetail,
      uCamRot: M3(), uCamRotInv: M3(), uPrevVP: M4(), uCamDelta: V3(), uCamPos: V3(), uSunCol: ENV.uSunCol,
      uSubInvRot: M3(), uSubDRot: M3(), uSubInvOff: V3(), uSubDOff: V3(), uBoxMin: V3(), uBoxMax: V3(),
      uHeatA: U([new THREE.Vector4(), new THREE.Vector4()]), uHeatB: U([new THREE.Vector4(), new THREE.Vector4()]),
      uTime: ENV.uTime, uWind: ENV.uWind, uFog: ENV.uFogDensity, uAO: U(1), uSSR: U(1), uHeat: U(0), uRough: U(1), uRigid: U(0),
    }, { defines: { SSR_STEPS: T.ssr, AO_ON: T.ao[0] ? 1 : 0 } });
    this.copyMat = fsMaterial('precision highp float;\nuniform sampler2D tSrc;\nin vec2 vUv;\nout vec4 outColor;\nvoid main() { outColor = texture(tSrc, vUv); }', { tSrc: U(null) });
    this.taaMat = fsMaterial(TAA_FRAG, { tCur: U(null), tVel: U(null), tHist: U(null), tCloud: U(null), uRes: this.uRes, uBlend: U(0.1), uReset: U(1), uPrecip: U(0), uSubject: U(0), uJitter: V2() });
    this.mbMat = fsMaterial(MBLUR_FRAG, { tSrc: U(null), tVel: U(null), uRes: this.uRes, uScale: U(0), uMaxPx: U(32), uFrame: this.uFrame }, { defines: { MB_TAPS: T.mb || 1 } });
    this.uCoc = U(0); this.uMaxCoc = U(10);
    this.focusMat = fsMaterial(FOCUS_FRAG, { tVel: U(null), tPrev: U(null), uRate: U(1), uAspect: this.uAspect });
    this.tileMat = fsMaterial(TILE_FRAG, { tVel: U(null), tFocus: U(null), uRes: this.uRes, uCoc: this.uCoc, uMaxCoc: this.uMaxCoc });
    this.dofMat = fsMaterial(DOF_FRAG, { tSrc: U(null), tVel: U(null), tTile: U(null), tFocus: U(null), uRes: this.uRes, uCoc: this.uCoc, uMaxCoc: this.uMaxCoc }, { defines: { DOF_TAPS: T.dof || 1 } });

    this.finalMat = fsMaterial(FINAL_FRAG, {
      tHdr: U(null), tBloom: U(null), tWide: U(null), tBlur: U(null), tDrop: U(null), tAvg: U(null), tRays: U(null),
      tDof: U(this.black), tVel: U(this.black), tDirt: U(this.dirt), tStreak: U(this.black), tCloud: U(this.white),
      uInset: M3(), uOutset: M3(), uSunCol: ENV.uSunCol, uWB: U(new THREE.Vector3(1, 1, 1)), uSun: this.uSun, uRes: this.uRes, uAspect: this.uAspect, uSunOn: U(0),
      uTime: U(0), uExposure: U(0.64), uBloom: U(0.07), uGlow: U(0), uFlash: U(0), uRayGain: U(0), uFlare: U(1), uGlare: U(1),
      tGlass: U(this.black), tGlassD: U(this.black), tDepth: U(this.black), uNF: V2(), uGlassOn: U(0), uAir: U(0),
      uWet: U(0), uMist: U(0), uIce: U(0), uVignette: U(0.32), uChroma: U(0.005), uDistort: U(0.022),
      uDofOn: U(0), uDeep: U(0), uDirt: U(0), uStreak: U(0), uHalation: U(0), uClarity: U(0), uGrade: U(1), uMurk: U(0),
    }, { vertexShader: FINAL_VERT, defines: { CHROMA: T.chroma } });
    // The cockpit glazing, drawn as "where on the glass is this pixel" (see postfx-lens.js).
    this.glassMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, uniforms: { tMask: U(null), uBase: U(-0.945) },
      side: THREE.DoubleSide, depthTest: false, depthWrite: false,
    });
    this.glassMesh = null; this.glassFor = null; this.glassRT = null;
    this.debug = null;
    this.debugMat = fsMaterial(DEBUG_FRAG, { tSrc: U(null), uScale: U(new THREE.Vector4(1, 1, 1, 1)) });
    this.outMat = fsMaterial(OUT_FRAG, { tSrc: U(null), uTexel: V2(), uTime: U(0), uGrain: U(0.018), uSharp: U(0.14), uFxaa: U(1) });
    this.mips = []; this.ups = []; this.rays = []; this.extra = []; this.ldr = null; this.sceneRT = null;
  }

  setQuality(tier) {
    if (!TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    const t = TIERS[tier], set = (m, d) => { Object.assign(m.defines, d); m.needsUpdate = true; };
    set(this.finalMat, { CHROMA: t.chroma }); set(this.raysMat, { RAY_STEPS: t.raySteps });
    set(this.aoMat, { AO_SLICES: t.ao[0], AO_STEPS: t.ao[1] }); set(this.sceneMat, { SSR_STEPS: t.ssr, AO_ON: t.ao[0] ? 1 : 0 });
    set(this.mbMat, { MB_TAPS: t.mb || 1 }); set(this.dofMat, { DOF_TAPS: t.dof || 1 });
    if (this.w) this.setSize(this.w, this.h);
  }

  setSize(w, h) {
    // A change of size in mid-flight (dynamic resolution moves in steps of a twentieth) must not throw the temporal
    // filter's history away: without it every edge in the picture is drawn raw for a frame and takes a dozen more
    // to settle, which shows as a flicker of the whole frame, worst where the contrast is highest (shadow edges).
    // The last settled picture is kept and carried over, scaled, into the new targets (below).
    const carry = this.taaValid && !this.reset && this.w > 0 && this.taa ? this.taa[(this.frame + 1) & 1] : null;
    this.w = w; this.h = h;
    for (const t of [...this.mips, ...this.ups, ...this.rays, ...this.extra, this.ldr, this.glassRT]) if (t !== carry) t?.dispose();
    const T = TIERS[this.tier], n = T.levels, part = (k) => [Math.max(2, Math.round(w / k)), Math.max(2, Math.round(h / k))];
    this.mips = []; this.ups = []; this.extra = [];
    for (let i = 0; i < n; i++) {
      this.mips.push(hdrTarget(...part(2 ** (i + 1))));
      if (i < n - 1) this.ups.push(hdrTarget(...part(2 ** (i + 1))));
    }
    this.rays = [hdrTarget(...part(4)), hdrTarget(...part(4))];
    this.ldr = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.glassRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, count: 2, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.sceneRT = null;
    if (T.deep) {
      const near = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
      this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, count: 2, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.aoRT = hdrTarget(...part(2), near);
      this.taa = [hdrTarget(w, h), hdrTarget(w, h)];
      this.mbRT = hdrTarget(w, h);
      this.dofRT = hdrTarget(...part(2));
      this.tileRT = hdrTarget(...part(8));
      this.focus = [hdrTarget(1, 1, near), hdrTarget(1, 1, near)];
      this.streak = [hdrTarget(...part(8)), hdrTarget(...part(8))];
      this.extra = [this.sceneRT, this.aoRT, ...this.taa, this.mbRT, this.dofRT, this.tileRT, ...this.focus, ...this.streak];
    }
    this.outMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.uRes.value.set(w, h);
    this.uAspect.value = w / h;
    this.dofValid = false;
    if (carry && T.deep && T.taa) {
      // the old history, read smoothly into the target the next frame takes as its past; nothing else restarts
      const r = this.renderer, prev = r.getRenderTarget();
      this.copyMat.uniforms.tSrc.value = carry.texture;
      this.quad.draw(r, this.copyMat, this.taa[(this.frame + 1) & 1]);
      this.copyMat.uniforms.tSrc.value = null;
      r.setRenderTarget(prev);
    } else { this.reset = true; this.taaValid = false; }
    carry?.dispose();
  }

  /** Forget temporal history (after a teleport). A camera jump of more than 400 m does this by itself. */
  resetHistory() { this.reset = true; }

  /**
   * Temporal anti-aliasing needs each frame drawn a fraction of a pixel off the last.
   * Call jitter() just before the scene is rendered and unjitter() straight after, so
   * every later pass (clouds, reprojection) sees the camera as it really is.
   */
  jitter(camera) {
    const amt = Math.min(this.fx.taa ?? 1, 1);
    this.jitterPx.set(0, 0);
    if (!TIERS[this.tier].taa || !(amt > 0) || !this.w) return;
    const i = (this.frame % 8) + 1, e = camera.projectionMatrix.elements;
    this.saveP.copy(camera.projectionMatrix); this.savePI.copy(camera.projectionMatrixInverse);
    const jx = (halton(i, 2) - 0.5) * amt, jy = (halton(i, 3) - 0.5) * amt;          // pixels
    e[8] += 2 * jx / this.w; e[9] += 2 * jy / this.h; this.jitterPx.set(jx, jy);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.jit = true;
  }

  unjitter(camera) {
    if (!this.jit) return;
    camera.projectionMatrix.copy(this.saveP); camera.projectionMatrixInverse.copy(this.savePI);
    this.jit = false;
  }

  /** The aircraft's bounding box in its own coordinates: whatever lies inside moves with it. */
  measure(sub) {
    sub.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(sub.matrixWorld).invert(), b = new THREE.Box3(), m = new THREE.Matrix4();
    this.box.makeEmpty();
    sub.traverse((o) => {
      if (!o.isMesh || !o.geometry || o.material?.transparent) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      this.box.union(b.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
    });
    // A little slack for moving parts, and keep the ground under the wheels out of it.
    if (!this.box.isEmpty()) { this.box.expandByScalar(0.06); this.box.min.y += 0.2; }
    this.boxFor = sub; this.prevSub.copy(sub.matrixWorld);
  }

  /**
   * hdr: linear HDR color with the open-sky mask in alpha. target null = screen.
   * opts.depth  the scene's depth texture; without it only the flat passes run
   * opts.scene  the scene color before clouds; its alpha marks open water (0.25) against everything else (1)
   * opts.cloud  the cloud layer (alpha = how much of the scene shows through it), so
   *             occlusion and reflections fade behind cloud and TAA leaves cloud to its own history
   */
  render(hdr, camera, target = null, opts = {}) {
    const r = this.renderer, q = this.quad, fx = this.fx, T = TIERS[this.tier], w = this.w, h = this.h;
    const time = fx.time || 0, dt = Math.min(Math.max(time - this.lastTime, 0), 0.1);
    this.lastTime = time;
    const pos = vPos.setFromMatrixPosition(camera.matrixWorld);
    const pe = camera.projectionMatrix.elements, tanX = 1 / pe[0], tanY = 1 / pe[5];
    mV.copy(camera.matrixWorldInverse).setPosition(0, 0, 0);
    mVP.multiplyMatrices(camera.projectionMatrix, mV);
    const reset = this.reset || pos.distanceTo(this.prevPos) > 400;
    const cockpit = fx.cockpit || 0, spd = fx.airspeed || 0, precip = Math.max(fx.rain || 0, fx.snow || 0);
    const sub = fx.subject?.isObject3D ? fx.subject : null;
    const cloud = opts.cloud || this.white;
    const deep = !!(T.deep && opts.depth && this.sceneRT);
    const fu = this.finalMat.uniforms;
    let color = hdr, dofOn = false;
    perf.frame();

    // Glass: wetness builds quickly and dries slowly, whichever view is up. Only the cockpit shows it:
    // the glazing is drawn from the pilot's eye so the final pass knows where on the glass each pixel is.
    const wetTarget = Math.max(fx.rain || 0, (fx.snow || 0) * 0.3);
    this.wet += (wetTarget - this.wet) * Math.min(1, dt * (wetTarget > this.wet ? 1.2 : 0.25));
    const glass = fx.glass?.isMesh && fx.glass.material?.alphaMap ? fx.glass : null;
    const glassOn = !!(glass && cockpit > 0.5 && opts.depth && (this.wet > 0.004 || (fx.ice || 0) > 0.01));
    if (glassOn) {
      perf.begin('glass');
      if (this.glassFor !== glass) {
        this.glassMesh = new THREE.Mesh(glass.geometry, this.glassMat);
        this.glassMesh.matrixAutoUpdate = false; this.glassMesh.matrixWorldAutoUpdate = false; this.glassMesh.frustumCulled = false;
        this.glassFor = glass;
      }
      this.glassMesh.matrixWorld.copy(glass.matrixWorld);
      this.glassMat.uniforms.tMask.value = glass.material.alphaMap;
      const alpha = r.getClearAlpha(); r.getClearColor(cTmp); r.setClearColor(0x000000, 0);
      r.setRenderTarget(this.glassRT); r.render(this.glassMesh, camera);
      r.setClearColor(cTmp, alpha);
    }
    this.uFrame.value = T.taa && (fx.taa ?? 1) > 0 ? this.frame % 64 : 0;       // sampling patterns only move when something averages them

    if (deep) {
      this.uDepth.value = opts.depth;
      this.uProj.value.set(camera.near, camera.far, tanX, tanY);
      const aoOn = T.ao[0] > 0 && (fx.ao ?? 1) > 0;
      perf.begin('ao');
      if (aoOn) q.draw(r, this.aoMat, this.aoRT);

      // Scene pass: occlusion, water reflections, exhaust heat; also writes motion and distance.
      perf.begin('scene fx');
      const su = this.sceneMat.uniforms;
      su.tHdr.value = hdr; su.tScene.value = opts.scene || this.white; su.tAO.value = this.aoRT.texture; su.tCloud.value = cloud;
      su.uCamRot.value.setFromMatrix4(camera.matrixWorld); su.uCamRotInv.value.copy(su.uCamRot.value).transpose();
      su.uPrevVP.value.copy(reset ? mVP : this.prevVP);
      su.uCamDelta.value.copy(pos).sub(reset ? pos : this.prevPos);
      su.uCamPos.value.copy(pos);
      su.uRough.value = T.taa && (fx.taa ?? 1) > 0 ? 1 : 0;      // random facets need the temporal filter to average them
      su.uAO.value = aoOn ? fx.ao ?? 1 : 0; su.uSSR.value = opts.scene ? fx.ssr ?? 1 : 0;
      let heat = 0;
      if (sub) {
        if (this.boxFor !== sub) this.measure(sub);
        mInv.copy(sub.matrixWorld).invert();
        su.uSubInvRot.value.setFromMatrix4(mInv); su.uSubInvOff.value.copy(pos).applyMatrix4(mInv);
        mD.multiplyMatrices(reset ? sub.matrixWorld : this.prevSub, mInv);
        su.uSubDRot.value.setFromMatrix4(mD); su.uSubDOff.value.copy(pos).applyMatrix4(mD).sub(reset ? pos : this.prevPos);
        su.uBoxMin.value.copy(this.box.min); su.uBoxMax.value.copy(this.box.max);
        this.prevSub.copy(sub.matrixWorld);
        // The plume leaves each stack and trails back along the fuselage, widening as it cools.
        heat = (fx.heat ?? 1) * (1 - 0.65 * smoothstep(spd, 15, 55));
        const ex = fx.exhaust || EXHAUST;
        for (let i = 0; i < 2; i++) {
          const A = su.uHeatA.value[i], B = su.uHeatB.value[i], e = ex[i];
          A.w = 0;
          if (!e || !(heat > 0)) continue;
          vA.set(e[0], e[1], e[2]).applyMatrix4(sub.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
          vB.set(e[0] * 1.15, e[1] + 0.12, e[2] + 3.4).applyMatrix4(sub.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
          if (-vA.z < camera.near + 0.3 || -vB.z < camera.near + 0.3) continue;
          A.set(vA.x / (-vA.z * tanX) * 0.5 + 0.5, vA.y / (-vA.z * tanY) * 0.5 + 0.5, -vA.z, 0.2 / (-vA.z * 2 * tanY));
          B.set(vB.x / (-vB.z * tanX) * 0.5 + 0.5, vB.y / (-vB.z * tanY) * 0.5 + 0.5, -vB.z, 0.55 / (-vB.z * 2 * tanY));
        }
      } else { su.uBoxMin.value.set(1, 1, 1); su.uBoxMax.value.set(-1, -1, -1); }
      su.uHeat.value = heat; su.uRigid.value = sub ? 0 : cockpit > 0.5 ? 4 : 38;
      q.draw(r, this.sceneMat, this.sceneRT);
      color = this.sceneRT.textures[0];
      const vel = this.sceneRT.textures[1];

      // Temporal anti-aliasing.
      const taa = Math.min(fx.taa ?? 1, 1);
      if (T.taa && taa > 0) {
        perf.begin('taa');
        const cur = this.taa[this.frame & 1], prev = this.taa[(this.frame + 1) & 1], tu = this.taaMat.uniforms;
        tu.tCur.value = color; tu.tVel.value = vel; tu.tHist.value = prev.texture; tu.tCloud.value = cloud;
        tu.uBlend.value = clamp(lerp(1, 0.1, taa) + 0.08 * precip, 0.05, 1); tu.uPrecip.value = clamp(precip * 3, 0, 1);
        tu.uReset.value = reset || !this.taaValid ? 1 : 0; tu.uJitter.value.copy(this.jitterPx); tu.uSubject.value = cockpit > 0.5 ? 1 : 0;
        q.draw(r, this.taaMat, cur);
        color = cur.texture; this.taaValid = true;
      } else this.taaValid = false;

      // Motion blur: how far things moved while the shutter was open. Not run at all when the longest streak the
      // camera's own motion can draw is under half a pixel (parked, paused, or high above everything). The world
      // stands still, so that streak is known without looking at the picture: the turn of the camera since the
      // last frame, plus its travel seen at the nearest the scenery can be (fx.clearance), widened for the
      // corners of the frame.
      const shutter = (fx.motionBlur ?? 1) / 100, scale = dt > 1e-4 ? Math.min(shutter / dt, 4) : 0;
      const fpx = (h * 0.5) / tanY, wide = 1 + tanX * tanX + tanY * tanY;
      qA.setFromRotationMatrix(camera.matrixWorld);
      const streak = scale * fpx * wide * (reset ? 0 : qA.angleTo(this.prevQuat) + pos.distanceTo(this.prevPos) / Math.max(fx.clearance ?? 20, 1));
      this.prevQuat.copy(qA);
      this.mbRan = false;
      if (T.mb && scale > 0 && !reset && streak >= 0.5) {
        perf.begin('motion blur');
        this.mbRan = true;
        const mu = this.mbMat.uniforms;
        mu.tSrc.value = color; mu.tVel.value = vel; mu.uScale.value = scale; mu.uMaxPx.value = 0.035 * h;
        q.draw(r, this.mbMat, this.mbRT);
        color = this.mbRT.texture;
      }

      // Depth of field from a real lens: 24 mm of sensor height behind this field of view, f/4 by
      // day opening to f/2 at night. Outside the cockpit nothing is close enough to matter, so skip it.
      // From the cockpit there is none: an eye refocuses wherever it looks, and the panel and the horizon
      // must both be sharp.
      const fl = 0.012 / tanY, coc = (fl * fl) / (4 - 2 * ENV.uNight.value) / 0.024 * h * 0.5 * (fx.dof ?? 1);
      const nearest = sub ? Math.max(pos.distanceTo(vA.setFromMatrixPosition(sub.matrixWorld)) - 6, 3) : 12;
      dofOn = T.dof > 0 && cockpit < 0.5 && coc / nearest > 0.9;
      if (dofOn) {
        perf.begin('dof');
        const fc = this.focus[this.frame & 1], fp = this.focus[(this.frame + 1) & 1];
        this.uCoc.value = coc; this.uMaxCoc.value = T.maxCoc * h / 1080;
        const fo = this.focusMat.uniforms;
        fo.tVel.value = vel; fo.tPrev.value = fp.texture; fo.uRate.value = this.dofValid && !reset ? Math.max(1 - Math.exp(-dt * 5), 0.03) : 1;
        q.draw(r, this.focusMat, fc);
        const tl = this.tileMat.uniforms; tl.tVel.value = vel; tl.tFocus.value = fc.texture;
        q.draw(r, this.tileMat, this.tileRT);
        const du = this.dofMat.uniforms; du.tSrc.value = color; du.tVel.value = vel; du.tTile.value = this.tileRT.texture; du.tFocus.value = fc.texture;
        q.draw(r, this.dofMat, this.dofRT);
      }
      this.dofValid = dofOn;
    }
    fu.tDof.value = dofOn ? this.dofRT.texture : this.black;
    fu.tVel.value = deep ? this.sceneRT.textures[1] : this.black;

    // Bloom: walk down the mip chain, then back up blending each level in.
    perf.begin('bloom');
    let src = color, sw = w, sh = h;
    for (let i = 0; i < this.mips.length; i++) {
      const m = i === 0 ? this.downFirst : this.down;
      m.uniforms.tSrc.value = src; m.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      q.draw(r, m, this.mips[i]);
      src = this.mips[i].texture; sw = this.mips[i].width; sh = this.mips[i].height;
    }
    let low = this.mips[this.mips.length - 1];
    for (let i = this.ups.length - 1; i >= 0; i--) {
      const u = this.up.uniforms;
      u.tLow.value = low.texture; u.tHigh.value = this.mips[i].texture; u.uTexel.value.set(1 / low.width, 1 / low.height);
      u.uMix.value = i === 0 ? 0.72 : 0.62;
      q.draw(r, this.up, this.ups[i]);
      low = this.ups[i];
    }

    // Anamorphic streak: the very brightest light, smeared sideways twice.
    const exposure = fx.exposure ?? 0.64, streak = (fx.streak ?? 1) * 0.3;
    const streakOn = deep && T.streak && streak > 0;
    perf.begin('streak, rays');
    if (streakOn) {
      const st = this.streakMat.uniforms, sx = 1 / this.streak[0].width;
      st.tSrc.value = this.mips[2].texture; st.uStep.value.set(sx * 1.5, 0); st.uThreshold.value = 2.2 / exposure; q.draw(r, this.streakMat, this.streak[0]);
      st.tSrc.value = this.streak[0].texture; st.uStep.value.set(sx * 6, 0); st.uThreshold.value = 0; q.draw(r, this.streakMat, this.streak[1]);
    }

    // Where is the sun on screen, and is it in front of us?
    vA.copy(ENV.uSunDir.value).applyMatrix4(mV);                         // view-space direction
    let sunOn = 0, rayGain = 0;
    const fogD = ENV.uFogDensity.value;
    if (vA.z < -0.02) {
      const nx = (vA.x * pe[0]) / -vA.z, ny = (vA.y * pe[5]) / -vA.z;
      this.uSun.value.set(nx * 0.5 + 0.5, ny * 0.5 + 0.5);
      const off = Math.max(Math.abs(nx), Math.abs(ny));
      sunOn = 1 - smoothstep(off, 1.0, 1.5);
      // Shafts need haze to show up in: more in murk, and when the sun is low and the light path long.
      const lum = ENV.uSunCol.value.r * 0.3 + ENV.uSunCol.value.g * 0.5 + ENV.uSunCol.value.b * 0.2;
      const haze = clamp(fogD / 0.00012, 0.3, 1.8), lowSun = 1 + 0.3 * (1 - smoothstep(ENV.uSunDir.value.y, 0.05, 0.45));
      rayGain = (1 - smoothstep(off, 1.1, 2.2)) * haze * lowSun * 0.44 * Math.min(lum, 1.5) * (fx.rays ?? 1);
    }
    if (rayGain > 0.003) {
      const ru = this.raysMat.uniforms;
      ru.tSrc.value = color; ru.uSpan.value = 0.9; ru.uFirst.value = 1; q.draw(r, this.raysMat, this.rays[0]);
      ru.tSrc.value = this.rays[0].texture; ru.uSpan.value = 0.9 / T.raySteps; ru.uFirst.value = 0; q.draw(r, this.raysMat, this.rays[1]);
    } else rayGain = 0;

    const nm = this.mips.length;
    fu.tHdr.value = color; fu.tBloom.value = low.texture; fu.tWide.value = this.ups[Math.min(2, this.ups.length - 1)].texture;
    fu.tBlur.value = this.mips[1].texture; fu.tDrop.value = this.mips[Math.min(3, nm - 1)].texture; fu.tAvg.value = this.mips[nm - 1].texture;
    fu.tRays.value = this.rays[1].texture; fu.tStreak.value = streakOn ? this.streak[1].texture : this.black;
    fu.uSunOn.value = sunOn; fu.uRayGain.value = rayGain; fu.uFlare.value = fx.flare ?? 1; fu.uGlare.value = fx.glare ?? 1;
    fu.uTime.value = time; fu.uExposure.value = exposure; fu.uBloom.value = fx.bloom ?? 0.07;
    // Mist halos: murk and falling water widen every light.
    fu.uGlow.value = clamp((0.12 * smoothstep(fogD, 1e-4, 2.5e-3) + 0.1 * this.wet + 0.05 * (fx.snow || 0)) * (fx.mist ?? 1), 0, 0.6);
    fu.tCloud.value = cloud; fu.uMurk.value = 0.45 * (fx.mist ?? 1);
    fu.uFlash.value = Math.max(fx.flash || 0, this.flashExtra);
    fu.uGlassOn.value = glassOn ? 1 : 0; fu.uAir.value = spd; fu.uNF.value.set(camera.near, camera.far);
    fu.tGlass.value = glassOn ? this.glassRT.textures[0] : this.black; fu.tGlassD.value = glassOn ? this.glassRT.textures[1] : this.black;
    fu.tDepth.value = glassOn ? opts.depth : this.black;
    fu.uWet.value = this.wet; fu.uMist.value = this.wet * 0.22; fu.uIce.value = fx.ice || 0;
    // Barrel distortion and color fringes belong to a camera lens. From the pilot's seat they would only soften
    // and fringe the panel (every pixel resampled off-center), so the cockpit view has neither.
    const lens = cockpit > 0.5 ? 0 : 1;
    fu.uVignette.value = 0.32 * (fx.vignette ?? 1); fu.uChroma.value = 0.005 * (fx.chroma ?? 1) * lens; fu.uDistort.value = 0.022 * (fx.distort ?? 1) * lens;
    fu.uDofOn.value = dofOn ? 1 : 0; fu.uDeep.value = deep ? 1 : 0;
    fu.uDirt.value = 0.6 * (fx.dirt ?? 1); fu.uStreak.value = streak; fu.uHalation.value = 0.1 * (fx.halation ?? 1);
    fu.uClarity.value = 0.14 * (fx.clarity ?? 1); fu.uGrade.value = fx.grade ?? 1;
    // White balance: lean a third of the way toward neutralizing the light that is falling on the scene.
    const sc = ENV.uSunCol.value, sk = ENV.uAmbSky.value, lum = (c) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    const ls = Math.max(lum(sc), 1e-5), lk = Math.max(lum(sk), 1e-5), s = 0.3 * (fx.wb ?? 1);
    const wb = fu.uWB.value.set(1, 1, 1);
    if (s > 0) {
      wb.set(Math.pow(Math.max(0.5 * (sc.r / ls + sk.r / lk), 0.05), -s), Math.pow(Math.max(0.5 * (sc.g / ls + sk.g / lk), 0.05), -s), Math.pow(Math.max(0.5 * (sc.b / ls + sk.b / lk), 0.05), -s));
      wb.multiplyScalar(1 / (wb.x * 0.2126 + wb.y * 0.7152 + wb.z * 0.0722));
    }
    // The tone curve works in a gamut pulled a little toward gray, and is pushed back out afterward.
    const k = 0.24 * clamp(fx.filmic ?? 1, 0, 2), a = 1 - k + k / 3, b = k / 3;
    fu.uInset.value.set(a, b, b, b, a, b, b, b, a); fu.uOutset.value.copy(fu.uInset.value).invert();
    perf.begin('final');
    q.draw(r, this.finalMat, this.ldr);

    const xu = this.outMat.uniforms;
    xu.tSrc.value = this.ldr.texture; xu.uTime.value = time;
    // kept fine: heavier grain reads as a mesh on dark cloud
    xu.uGrain.value = 0.012 * (fx.grain ?? 1) * (1 + 0.8 * ENV.uNight.value);
    xu.uSharp.value = 0.14 * (fx.sharpen ?? 1);
    xu.uFxaa.value = deep && T.taa && (fx.taa ?? 1) > 0 ? 0 : 1;      // edges come out of the temporal filter already smooth
    perf.begin('out');
    q.draw(r, this.outMat, target);
    perf.end();
    if (this.debug && deep) {
      const view = {
        ao: [this.aoRT.texture, 1, 1, 1, 2], vel: [this.sceneRT.textures[1], 40, 40, 1],
        dof: [this.dofRT.texture, 1, 1, 1], tile: [this.tileRT.texture, 0.1, 0.1, 0.1], rays: [this.rays[1].texture, 1, 1, 1], streak: [this.streak[1].texture, 1, 1, 1],
      }[this.debug];
      if (view) { this.debugMat.uniforms.tSrc.value = view[0]; this.debugMat.uniforms.uScale.value.set(view[1], view[2], view[3], view[4] || 1); q.draw(r, this.debugMat, target); }
    }

    this.prevVP.copy(mVP); this.prevPos.copy(pos);
    this.reset = false; this.frame++;
  }
}
