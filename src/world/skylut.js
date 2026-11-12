// The atmosphere's lookup tables, after Sébastien Hillaire, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique" (Computer Graphics Forum 39(4), 2020), fitted to this engine:
//
//   transmittance   256 x 64    light surviving from a height, along a direction, to the top of the air
//   multiple        64 x 32     light scattered more than once, as an even glow, by sun height and height
//   sky view        256 x 128   the sky as seen from the camera's height, all round the compass
//   aerial          64 x 32 x 32  the colour haze adds in front of things, by direction and distance
//   probe           32 x 16     the sky view again, small, read back for the CPU (ambient light, exposure)
//
// Differences from the paper are listed in atmosphere.js. Lengths in these shaders are kilometres.

import * as THREE from 'three';
import { FullscreenQuad, fsMaterial } from '../render/fullscreen.js';

export const LUT_SIZES = {
  low: { sky: [128, 64], ap: [32, 16, 16], steps: 24 },
  med: { sky: [192, 96], ap: [48, 24, 24], steps: 32 },
  high: { sky: [256, 128], ap: [64, 32, 32], steps: 40 },
};
export const PROBE_W = 32, PROBE_H = 16;
export const AP_NEAR = 50, AP_FAR = 400000;        // metres: the first and last slice of the aerial table
export const SKY_HORIZON_V = 0.3;                  // where the horizon sits in the sky view table

const COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
const float PI = 3.14159265359;
const float RG = 6360.0, RT = 6460.0;                        // ground and top of the atmosphere, km
const vec3 BETA_R = vec3(5.802e-3, 13.558e-3, 33.1e-3);       // Rayleigh scattering at sea level, 1/km
const vec3 BETA_O = vec3(1.70e-3, 1.85e-3, 0.085e-3);         // ozone absorption at the middle of its layer, 1/km (see atmosphere.js on the red)
const float GROUND_ALBEDO = 0.2;
uniform vec4 uAer;        // the air mass's aerosol. x: extinction at sea level (1/km), y: scale height (km), z: single-scattering albedo, w: Mie g

float rayTop(float r, float mu) { return -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + RT * RT, 0.0)); }
// Distance to the ground along a ray, or -1 if it misses.
float rayGround(float r, float mu) {
  float disc = r * r * (mu * mu - 1.0) + RG * RG;
  return (mu < 0.0 && disc >= 0.0) ? -r * mu - sqrt(disc) : -1.0;
}
void medium(float h, out vec3 scatR, out float scatM, out vec3 ext) {
  float extM = uAer.x * exp(-h / uAer.y);
  scatR = BETA_R * exp(-h / 8.0);
  scatM = extM * uAer.z;
  ext = scatR + extM + BETA_O * max(0.0, 1.0 - abs(h - 25.0) / 15.0);
}
float phaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseM(float c, float g) {                                // Cornette-Shanks
  float g2 = g * g;
  return 0.1193662 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// (1 - exp(-x)) / x without losing the small end.
vec3 segment(vec3 x) { return mix(1.0 - 0.5 * x, (1.0 - exp(-x)) / max(x, vec3(1e-6)), step(vec3(1e-3), x)); }
`;

// Bruneton's mapping for the transmittance table: u is the distance to the top between its least and
// greatest for the height, v the height as distance to the horizon. Texel centres carry the end values.
const TRANS_READ = /* glsl */`
uniform sampler2D tTrans;
const vec2 TRANS_RES = vec2(256.0, 64.0);
vec3 transToTop(float r, float mu) {
  float H = sqrt(RT * RT - RG * RG), rho = sqrt(max(r * r - RG * RG, 0.0));
  float d = rayTop(r, mu), dmin = RT - r, dmax = rho + H;
  vec2 uv = vec2((d - dmin) / (dmax - dmin), rho / H);
  return texture(tTrans, (clamp(uv, 0.0, 1.0) * (TRANS_RES - 1.0) + 0.5) / TRANS_RES).rgb;
}
// Sunlight reaching a point: nothing once the ground is in the way (softened over the sun's own width).
vec3 sunLight(float r, float mu) {
  float muH = -sqrt(max(1.0 - RG * RG / (r * r), 0.0));
  return transToTop(r, max(mu, muH)) * smoothstep(-0.006, 0.004, mu - muH);
}`;

const MS_READ = /* glsl */`
uniform sampler2D tMulti;
// (Columns crowd round a sun on the horizon: through twilight this light halves with every degree the sun sinks.)
vec3 multiScat(float r, float mu) {
  vec2 uv = vec2(0.5 + 0.5 * sign(mu) * sqrt(abs(mu)), (r - RG) / (RT - RG));
  return texture(tMulti, (clamp(uv, 0.0, 1.0) * vec2(63.0, 31.0) + 0.5) / vec2(64.0, 32.0)).rgb;
}`;

const TRANS_FRAG = /* glsl */`
${COMMON}
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = clamp((vUv * vec2(256.0, 64.0) - 0.5) / vec2(255.0, 63.0), 0.0, 1.0);
  float H = sqrt(RT * RT - RG * RG), rho = H * uv.y, r = sqrt(rho * rho + RG * RG);
  float dmin = RT - r, dmax = rho + H, d = dmin + uv.x * (dmax - dmin);
  float mu = d < 1e-5 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  float tMax = rayTop(r, mu);
  vec3 tau = vec3(0.0), sR, ext; float sM;
  for (int i = 0; i < 40; i++) {
    float t = tMax * (float(i) + 0.5) / 40.0;
    medium(max(sqrt(r * r + t * t + 2.0 * r * t * mu) - RG, 0.0), sR, sM, ext);
    tau += ext;
  }
  outColor = vec4(exp(-tau * tMax / 40.0), 1.0);
}`;

const MULTI_FRAG = /* glsl */`
${COMMON}
${TRANS_READ}
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 uv = clamp((vUv * vec2(64.0, 32.0) - 0.5) / vec2(63.0, 31.0), 0.0, 1.0);
  float eS = uv.x * 2.0 - 1.0, muS = sign(eS) * eS * eS, r = RG + 0.01 + uv.y * (RT - RG - 0.02);
  vec3 sun = vec3(sqrt(max(1.0 - muS * muS, 0.0)), muS, 0.0);
  vec3 Lsum = vec3(0.0), Fsum = vec3(0.0), sR, ext; float sM;
  for (int i = 0; i < 64; i++) {
    float a = 6.2831853 * (float(i / 8) + 0.5) / 8.0, cy = 1.0 - 2.0 * (float(i % 8) + 0.5) / 8.0, sy = sqrt(1.0 - cy * cy);
    vec3 dir = vec3(sy * cos(a), cy, sy * sin(a));
    float tG = rayGround(r, dir.y), tMax = tG > 0.0 ? tG : rayTop(r, dir.y);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    float dt = tMax / 20.0, cs = dot(dir, sun);
    for (int k = 0; k < 20; k++) {
      float t = (float(k) + 0.3) * dt, ri = sqrt(r * r + t * t + 2.0 * r * t * dir.y);
      medium(max(ri - RG, 0.0), sR, sM, ext);
      vec3 sc = sR + sM, w = T * segment(ext * dt) * dt;
      L += w * sc * sunLight(ri, (r * muS + t * cs) / ri) * 0.0795775;
      F += w * sc;
      T *= exp(-ext * dt);
    }
    if (tG > 0.0) {
      float nl = (r * muS + tG * cs) / RG;
      L += T * transToTop(RG, max(nl, 0.0)) * max(nl, 0.0) * GROUND_ALBEDO / PI;
    }
    Lsum += L; Fsum += F;
  }
  // Second-order light, and every order after it as a geometric series.
  outColor = vec4((Lsum / 64.0) / (1.0 - Fsum / 64.0), 1.0);
}`;

// Sky-view rows: fine about the horizon (which dips with height), coarse toward the zenith and the nadir.
const SKY_FRAG = /* glsl */`
${COMMON}
${TRANS_READ}
${MS_READ}
uniform vec3 uSun, uSunE, uMoon, uMoonE, uGlow;
uniform vec4 uCam;       // x: distance from the Earth's centre (km), y: sine of the horizon's dip, z: steps
in vec2 vUv;
out vec4 outColor;
void main() {
  float r0 = uCam.x, sd = uCam.y, az = (vUv.x - 0.5) * 6.2831853;
  float q = vUv.y - ${SKY_HORIZON_V.toFixed(2)};
  float s = q >= 0.0 ? (q * q) / ${((1 - SKY_HORIZON_V) ** 2).toFixed(4)} * (1.0 + sd) : -(q * q) / ${(SKY_HORIZON_V ** 2).toFixed(4)} * (1.0 - sd);
  float y = clamp(s - sd, -1.0, 1.0), hz = sqrt(1.0 - y * y);
  vec3 dir = vec3(sin(az) * hz, y, cos(az) * hz);
  float tG = rayGround(r0, y), tMax = tG > 0.0 ? tG : rayTop(r0, y);
  float cS = dot(dir, uSun), cM = dot(dir, uMoon), g = uAer.w;
  float pRs = phaseR(cS), pMs = phaseM(cS, g), pRm = phaseR(cM), pMm = phaseM(cM, g);
  bool moon = uMoonE.g > 0.0, sun = uSunE.g > 0.0;
  vec3 L = vec3(0.0), T = vec3(1.0), sR, ext; float sM;
  int N = int(uCam.z);
  for (int i = 0; i < 64; i++) {
    if (i >= N) break;
    // Steps lengthen with distance: the near air matters by day, the far high air at twilight.
    float a = float(i) / float(N), b = float(i + 1) / float(N), t0 = tMax * a * a, t1 = tMax * b * b, dt = t1 - t0, t = t0 + 0.4 * dt;
    float ri = sqrt(r0 * r0 + t * t + 2.0 * r0 * t * y);
    medium(max(ri - RG, 0.0), sR, sM, ext);
    vec3 S = vec3(0.0);
    if (sun) { float mu = (r0 * uSun.y + t * cS) / ri; S += uSunE * (sunLight(ri, mu) * (sR * pRs + sM * pMs) + multiScat(ri, mu) * (sR + sM)); }
    if (moon) { float mu = (r0 * uMoon.y + t * cM) / ri; S += uMoonE * (sunLight(ri, mu) * (sR * pRm + sM * pMm) + multiScat(ri, mu) * (sR + sM)); }
    L += T * S * segment(ext * dt) * dt;
    T *= exp(-ext * dt);
  }
  if (tG > 0.0) {
    float nS = (r0 * uSun.y + tG * cS) / RG, nM = (r0 * uMoon.y + tG * cM) / RG;
    vec3 E = uSunE * (transToTop(RG, max(nS, 0.0)) * max(nS, 0.0) + PI * multiScat(RG, nS)) + uMoonE * (transToTop(RG, max(nM, 0.0)) * max(nM, 0.0) + PI * multiScat(RG, nM));
    L += T * E * GROUND_ALBEDO / PI;
  } else {
    // Airglow and the unresolved stars: a thin layer at 90 km, brighter toward the horizon where the look through it is long.
    float k = r0 / (RG + 90.0);
    L += T * uGlow / sqrt(max(1.0 - k * k * (1.0 - y * y), 0.02));
  }
  outColor = vec4(L, 1.0);
}`;

// What the sky view holds for a direction (the same mapping as skyRadiance in atmosphere.js).
const PROBE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tSky;
uniform float uDip;
in vec2 vUv;
out vec4 outColor;
void main() {
  float y = vUv.y * vUv.y, s = y + uDip;
  float v = ${SKY_HORIZON_V.toFixed(2)} + ${(1 - SKY_HORIZON_V).toFixed(2)} * sqrt(s / (1.0 + uDip));
  outColor = vec4(texture(tSky, vec2(vUv.x, v)).rgb, 1.0);
}`;

// The aerial table: for each direction and distance, the mean colour of the light the air between adds,
// weighted as it reaches the eye: (light scattered in) / (1 - transmittance). The shaders multiply it by
// their own exact (1 - transmittance), so fog a hundred metres deep and haze two hundred kilometres deep
// both come out right from 32 slices. Slices are stacked up the texture; distance grows by a fixed ratio.
const AP_FRAG = /* glsl */`
${COMMON}
${TRANS_READ}
${MS_READ}
uniform vec3 uSun, uSunE, uMoon, uMoonE, uGlow, uOvc;
uniform vec4 uCam;       // x: distance from the Earth's centre (km)
uniform vec4 uLoc;       // local haze. x: extinction at sea level (1/km), y: scale height (km), z: share of it that is fog, rain or cloud, w: murk 0..1
uniform vec4 uApP;       // x: rows per slice, y: first slice (km), z: distance ratio between slices, w: direct light reaching the haze 0..1
in vec2 vUv;
out vec4 outColor;
void main() {
  float rows = uApP.x, fy = gl_FragCoord.y - 0.5;
  int slice = int(floor(fy / rows));
  float v = (fy - float(slice) * rows + 0.5) / rows, e = 2.0 * v - 1.0;
  float y = sign(e) * e * e, hz = sqrt(1.0 - y * y), az = (vUv.x - 0.5) * 6.2831853;
  vec3 dir = vec3(sin(az) * hz, y, cos(az) * hz);
  float r0 = uCam.x, cS = dot(dir, uSun), cM = dot(dir, uMoon), g = uAer.w;
  float pRs = phaseR(cS), pMs = phaseM(cS, g), pRm = phaseR(cM), pMm = phaseM(cM, g);
  bool moon = uMoonE.g > 0.0, sun = uSunE.g > 0.0;
  vec3 L = vec3(0.0), tau = vec3(0.0), S0 = vec3(0.0), fog = uOvc * 0.78;
  float t0 = 0.0, t1 = uApP.y;
  for (int j = 0; j < 32; j++) {
    if (j > slice) break;
    float t = j == 0 ? 0.5 * t1 : sqrt(t0 * t1), dt = t1 - t0;
    float ri = max(sqrt(r0 * r0 + t * t + 2.0 * r0 * t * y), RG + 0.001), h = ri - RG;
    vec3 sR = BETA_R * exp(-h / 8.0);
    float eL = uLoc.x * exp(-h / uLoc.y), sL = eL * (1.0 - uLoc.z) * uAer.z;
    vec3 ext = sR + eL, direct = vec3(0.0), amb = uGlow;
    if (sun) { float mu = (r0 * uSun.y + t * cS) / ri; direct += uSunE * sunLight(ri, mu) * (sR * pRs + sL * pMs); amb += uSunE * multiScat(ri, mu); }
    if (moon) { float mu = (r0 * uMoon.y + t * cM) / ri; direct += uMoonE * sunLight(ri, mu) * (sR * pRm + sL * pMm); amb += uMoonE * multiScat(ri, mu); }
    // Under cloud the haze is lit by the cloud's grey light, not by the sun and the blue sky; fog and rain glow with it too.
    vec3 S = direct * uApP.w + mix(amb, fog, uLoc.w) * (sR + sL) + fog * eL * uLoc.z;
    if (j == 0) S0 = S / ext;
    L += exp(-tau) * S * segment(ext * dt) * dt;
    tau += ext * dt;
    t0 = t1; t1 *= uApP.z;
  }
  vec3 A = 1.0 - exp(-tau);
  outColor = vec4(mix(S0, L / max(A, vec3(1e-7)), step(vec3(2e-5), A)), 1.0);
}`;

const rt = (w, h, type = THREE.HalfFloatType, filter = THREE.LinearFilter) => new THREE.WebGLRenderTarget(w, h, {
  type, format: THREE.RGBAFormat, depthBuffer: false, minFilter: filter, magFilter: filter, generateMipmaps: false,
  wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, colorSpace: THREE.NoColorSpace,
});

export class SkyLUT {
  constructor(renderer) {
    this.renderer = renderer;
    this.quad = new FullscreenQuad();
    const V3 = () => ({ value: new THREE.Vector3() }), V4 = () => ({ value: new THREE.Vector4() });
    // Shared by every pass: the air mass, the lights (irradiance / pi, in the engine's units, adaptation gain included).
    this.u = { uAer: V4(), uSun: V3(), uSunE: V3(), uMoon: V3(), uMoonE: V3(), uGlow: V3(), uOvc: V3(), uCam: V4(), uLoc: V4(), uApP: V4() };
    this.trans = rt(256, 64); this.multi = rt(64, 32);
    this.probe = rt(PROBE_W, PROBE_H, THREE.FloatType, THREE.NearestFilter);
    const tTrans = { value: this.trans.texture }, tMulti = { value: this.multi.texture };
    this.tSky = { value: null };
    this.uDip = { value: 0 };
    this.mTrans = fsMaterial(TRANS_FRAG, { uAer: this.u.uAer });
    this.mMulti = fsMaterial(MULTI_FRAG, { uAer: this.u.uAer, tTrans });
    this.mSky = fsMaterial(SKY_FRAG, { ...this.u, tTrans, tMulti });
    this.mAP = fsMaterial(AP_FRAG, { ...this.u, tTrans, tMulti });
    this.mProbe = fsMaterial(PROBE_FRAG, { tSky: this.tSky, uDip: this.uDip });
    this.quality = ''; this.sky = null; this.ap = null;
    this.setQuality('high');
    // Read-back of the probe: asynchronous (a pixel-pack buffer and a fence), so the frame never waits for the GPU.
    this.data = new Float32Array(PROBE_W * PROBE_H * 4);
    this.pbo = null; this.sync = null; this.pendingMeta = null; this.pendingAge = 0;
    this.stats = { trans: 0, sky: 0, ap: 0, probe: 0, syncReads: 0 };
  }

  setQuality(q) {
    if (!LUT_SIZES[q] || q === this.quality) return false;
    this.quality = q;
    const s = this.size = LUT_SIZES[q];
    this.sky?.dispose(); this.ap?.dispose();
    this.sky = rt(s.sky[0], s.sky[1]); this.sky.texture.wrapS = THREE.RepeatWrapping;
    this.ap = rt(s.ap[0], s.ap[1] * s.ap[2]); this.ap.texture.wrapS = THREE.RepeatWrapping;
    this.tSky.value = this.sky.texture;
    this.apRatio = Math.pow(AP_FAR / AP_NEAR, 1 / (s.ap[2] - 1));
    return true;
  }

  draw(mat, target) {
    const r = this.renderer, prev = r.getRenderTarget();
    this.quad.draw(r, mat, target);
    r.setRenderTarget(prev);
  }
  /** Transmittance and multiple scattering: only the air mass's aerosol changes them. */
  renderAir() { this.draw(this.mTrans, this.trans); this.draw(this.mMulti, this.multi); this.stats.trans++; }
  renderSky() { this.u.uCam.value.z = this.size.steps; this.draw(this.mSky, this.sky); this.stats.sky++; }
  renderAP() {
    const s = this.size.ap;
    const p = this.u.uApP.value; p.x = s[1]; p.y = AP_NEAR / 1000; p.z = this.apRatio;
    this.draw(this.mAP, this.ap); this.stats.ap++;
  }

  /**
   * Render the probe and fetch it. meta travels with the pixels (what gain they were made at). With wait,
   * the read blocks and the pixels are in this.data on return; otherwise they arrive through poll() a frame or two on.
   */
  renderProbe(meta, wait) {
    const r = this.renderer, gl = r.getContext(), prev = r.getRenderTarget();
    if (!wait && this.sync) return false;                         // one in flight is enough
    this.uDip.value = this.u.uCam.value.y;
    this.quad.draw(r, this.mProbe, this.probe);
    this.stats.probe++;
    if (wait) {
      this.drop();
      gl.readPixels(0, 0, PROBE_W, PROBE_H, gl.RGBA, gl.FLOAT, this.data);
      this.meta = meta; this.stats.syncReads++;
    } else {
      if (!this.pbo) { this.pbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, this.data.byteLength, gl.STREAM_READ); }
      else gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, PROBE_W, PROBE_H, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      this.pendingMeta = meta; this.pendingAge = 0;
    }
    r.setRenderTarget(prev);
    return true;
  }
  drop() { if (this.sync) { this.renderer.getContext().deleteSync(this.sync); this.sync = null; } }
  /**
   * True when a probe sent earlier has arrived in this.data (with this.meta). A browser signals the fence
   * between frames, so this is normally the next frame. Where it does not (frames run back to back in one
   * task, a tab that is not being composited) the read is forced after maxAge frames, and waits.
   */
  poll(maxAge = 30) {
    if (!this.sync) return false;
    const gl = this.renderer.getContext();
    const st = gl.clientWaitSync(this.sync, 0, 0);
    if ((st === gl.TIMEOUT_EXPIRED || st === gl.WAIT_FAILED) && ++this.pendingAge < maxAge) return false;
    if (st === gl.TIMEOUT_EXPIRED) this.stats.syncReads++;
    gl.deleteSync(this.sync); this.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.meta = this.pendingMeta;
    return true;
  }
}
