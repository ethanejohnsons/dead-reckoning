// Volumetric cloud renderer and final image composite.
//   1. the scene renders to an HDR target with a depth texture
//   2. a ray-march pass integrates cloud, fog and rain shafts along each view
//      ray up to the scene depth, reading the baked weather map
//   3. a composite pass blends clouds over the scene and tone-maps to screen

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { WX_N, TEX_ALT, CLOUD_SIGMA, NOISE_SCALE, DETAIL_SCALE } from './weather.js';
import { NOISE_SIZE } from './cloudnoise.js';

const FS_VERT = /* glsl */`
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler2D tDepth, tWxA, tWxB;
uniform sampler3D tNoise;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos, uSunDir, uSunCol, uAmbSky, uAmbGround, uFogCol, uCloudDrift, uFlashPos;
uniform float uNear, uFar, uWxHalf, uFogDensity, uFlash;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

const float TEX_ALT = ${TEX_ALT.toFixed(1)};
const float SIGMA = ${CLOUD_SIGMA};
const float NS = ${NOISE_SCALE.toFixed(1)};
const float DS = ${DETAIL_SCALE.toFixed(1)};

struct Wx { float cov; float conv; float precip; float base; float top; };
Wx getWx(vec2 xz) {
  vec2 uv = xz / (2.0 * uWxHalf) + 0.5;
  vec4 a = texture(tWxA, uv), b = texture(tWxB, uv);
  return Wx(a.r, a.g, a.b, b.r * TEX_ALT, b.g * TEX_ALT);
}

// Keep in sync with Weather.density() in weather.js.
float cloudDensity(vec3 p, Wx w, float lod, bool detail) {
  float h = (p.y - w.base) / max(w.top - w.base, 1.0);
  if (w.cov < 0.01 || h <= 0.0 || h >= 1.0) return 0.0;
  float pS = smoothstep(0.0, 0.1, h) * smoothstep(1.0, 0.72, h);
  float pC = smoothstep(0.0, 0.07, h) * (1.0 - 0.72 * smoothstep(0.3, 1.0, h))
    + 0.5 * smoothstep(0.78, 0.93, h) * smoothstep(1.0, 0.95, h) * smoothstep(5000.0, 8000.0, w.top - w.base);
  float prof = mix(pS, pC, w.conv);
  vec3 q = p + vec3(uCloudDrift.x, 0.0, uCloudDrift.z);
  float n1 = textureLod(tNoise, q / NS, lod).r;
  n1 = mix(n1, n1 * 0.45 + 0.55, (1.0 - w.conv) * 0.7);
  float d = clamp((n1 * prof - (1.0 - w.cov)) / (mix(0.3, 0.11, w.conv) * (1.0 + lod * 0.7)), 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  if (detail) {
    float n2 = textureLod(tNoise, q / DS, lod).g;
    d = clamp(d - n2 * 0.55 * (1.0 - d) / (1.0 + lod), 0.0, 1.0);
  }
  return d * SIGMA * mix(0.75, 1.35, w.conv);
}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

void main() {
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 fwd = -normalize(uCamWorld[2].xyz);
  float depth = texture(tDepth, vUv).r;
  float zN = depth * 2.0 - 1.0;
  float viewZ = 2.0 * uNear * uFar / (uFar + uNear - zN * (uFar - uNear));
  float sceneDist = depth >= 0.999999 ? 1.0e9 : viewZ / max(dot(rd, fwd), 0.05);
  outDepth = vec4(depth >= 0.999999 ? 60000.0 : min(viewZ, 60000.0), 0.0, 0.0, 1.0);

  float t0 = 0.0, t1 = min(sceneDist, 160000.0);
  const float yTop = 12600.0;
  if (abs(rd.y) > 1.0e-5) {
    float ta = -uCamPos.y / rd.y, tb = (yTop - uCamPos.y) / rd.y;
    t0 = max(0.0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (uCamPos.y > yTop) t1 = -1.0;

  vec3 col = vec3(0.0);
  float T = 1.0;
  float mu = dot(rd, uSunDir);
  float phase = 0.72 + 0.28 * mu * mu + 1.1 * pow(max(mu, 0.0), 7.0);

  if (t1 > t0) {
    float t = t0 + max(45.0, t0 * 0.06) * ign(gl_FragCoord.xy);
    for (int i = 0; i < STEPS; i++) {
      if (t >= t1) break;
      vec3 p = uCamPos + rd * t;
      Wx w = getWx(p.xz);
      float stp = max(45.0, t * 0.06);
      bool inLayer = w.cov > 0.01 && p.y > w.base && p.y < w.top;
      bool rain = w.precip > 0.03 && p.y <= w.base;
      if (!inLayer && !rain) {
        // Clear air: stride quickly, but never leap over the layer ahead.
        float skip = stp * 3.0;
        if (w.cov > 0.01) {
          float te = 1.0e9;
          if (p.y >= w.top && rd.y < 0.0) te = (p.y - w.top) / -rd.y;
          else if (p.y <= w.base && rd.y > 0.0) te = (w.base - p.y) / rd.y;
          skip = min(skip, te + 2.0);
        }
        t += max(skip, 20.0);
        continue;
      }
      stp = min(stp, max(40.0, (w.top - w.base) / max(abs(rd.y), 0.02) * 0.4));
      stp = min(stp, max(t1 - t, 10.0));
      float lod = clamp(log2(stp / 110.0) - 0.5, 0.0, 4.0);
      float d = inLayer ? cloudDensity(p, w, lod, t < 40000.0) : 0.0;
      float dr = rain ? w.precip * 0.0007 : 0.0;
      float ext = d + dr;
      if (ext > 1.0e-6) {
        float hN = clamp((p.y - w.base) / max(w.top - w.base, 1.0), 0.0, 1.0);
        float od = 0.0;
        if (d > 0.0) {
          od += cloudDensity(p + uSunDir * 90.0, w, lod + 0.5, false) * 150.0;
          od += cloudDensity(p + uSunDir * 330.0, w, lod + 1.0, false) * 330.0;
          od += cloudDensity(p + uSunDir * 850.0, w, lod + 1.5, false) * 650.0;
        }
        float sunT = exp(-od) * 0.82 + exp(-od * 0.2) * 0.26;
        float dark = 1.0 - 0.6 * w.precip * (1.0 - hN);
        vec3 amb = mix(uAmbGround * 1.1 + uAmbSky * 0.4, uAmbSky * 1.55, hN) * dark;
        vec3 L = uSunCol * sunT * phase * dark * 0.62 + amb;
        L += vec3(0.75, 0.82, 1.0) * uFlash * 9.0 * exp(-distance(p, uFlashPos) / 3200.0);
        vec3 Lr = (uAmbSky * 0.6 + uAmbGround * 0.3) * (1.0 - 0.45 * w.precip);
        vec3 S = (L * d + Lr * dr) / ext;
        float fog = 1.0 - exp(-pow(t * uFogDensity * 0.75, 2.0));
        S = mix(S, uFogCol, fog);
        float a = 1.0 - exp(-ext * stp);
        col += T * a * S;
        T *= 1.0 - a;
        if (T < 0.012) { T = 0.0; break; }
      }
      t += stp;
    }
  }

  // High cirrus veil above everything the aircraft can reach.
  const float yCi = 10400.0;
  if (T > 0.01 && uCamPos.y < yCi && rd.y > 0.012) {
    float tc = (yCi - uCamPos.y) / rd.y;
    if (tc < sceneDist && tc < 260000.0) {
      vec3 pc = uCamPos + rd * tc;
      float ci = texture(tWxA, pc.xz / (2.0 * uWxHalf) + 0.5).a;
      vec2 q = pc.xz + uCloudDrift.xz * 2.0;
      float n = texture(tNoise, vec3(q.x / 31000.0, 0.31, q.y / 9000.0)).b * 0.6 + texture(tNoise, vec3(q.x / 9000.0, 0.71, q.y / 2700.0)).b * 0.4;
      float a = smoothstep(0.62 - ci * 0.5, 0.95 - ci * 0.45, n) * min(1.0, ci * 3.0) * 0.55 * exp(-tc / 110000.0);
      vec3 cc = uSunCol * (0.22 + 0.5 * pow(max(mu, 0.0), 4.0)) + uAmbSky * 1.2;
      col += T * a * mix(cc, uFogCol, 1.0 - exp(-tc / 150000.0));
      T *= 1.0 - a;
    }
  }
  outColor = vec4(col, T);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tScene, tCloud, tCloudDepth, tDepth;
uniform vec2 uCloudRes;
uniform float uNear, uFar, uFlashScreen, uExposure;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 s = texture(tScene, vUv).rgb;
  // Depth-aware upsample: prefer low-res cloud texels whose depth matches this pixel.
  float depth = texture(tDepth, vUv).r;
  float zN = depth * 2.0 - 1.0;
  float d0 = depth >= 0.999999 ? 60000.0 : min(2.0 * uNear * uFar / (uFar + uNear - zN * (uFar - uNear)), 60000.0);
  vec2 f = vUv * uCloudRes - 0.5;
  ivec2 b = ivec2(floor(f));
  vec2 fr = f - vec2(b);
  ivec2 mx = ivec2(uCloudRes) - 1;
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 c = clamp(b + ivec2(i, j), ivec2(0), mx);
    float cd = texelFetch(tCloudDepth, c, 0).r;
    float wb = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
    float wd = 1.0 / (0.02 + abs(cd - d0) / max(min(cd, d0), 1.0));
    float w = (wb + 0.02) * wd;
    acc += texelFetch(tCloud, c, 0) * w; wsum += w;
  }
  vec4 c = acc / wsum;
  vec3 col = s * c.a + c.rgb;
  col += vec3(0.7, 0.78, 1.0) * uFlashScreen;
  col *= uExposure;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outColor = vec4(col + (n - 0.5) / 255.0, 1.0);
}`;

export class CloudRenderer {
  constructor(renderer, weather) {
    this.renderer = renderer; this.weather = weather;
    this.scale = 0.5; this.steps = 88;
    const N = WX_N;
    const mk = (data) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
      t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
    };
    this.wxA = mk(weather.A); this.wxB = mk(weather.B);
    ENV.tWxA.value = this.wxA; ENV.tWxB.value = this.wxB;
    const n3 = new THREE.Data3DTexture(weather.noise, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
    n3.format = THREE.RGBAFormat; n3.wrapS = n3.wrapT = n3.wrapR = THREE.RepeatWrapping;
    n3.minFilter = THREE.LinearMipmapLinearFilter; n3.magFilter = THREE.LinearFilter;
    n3.generateMipmaps = true; n3.unpackAlignment = 1; n3.needsUpdate = true;
    this.noiseTex = n3;

    this.uFlashScreen = { value: 0 };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
    this.cloudMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: CLOUD_FRAG, defines: { STEPS: this.steps },
      depthTest: false, depthWrite: false,
      uniforms: {
        tDepth: { value: null }, tWxA: ENV.tWxA, tWxB: ENV.tWxB, tNoise: { value: n3 },
        uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
        uSunDir: ENV.uSunDir, uSunCol: ENV.uSunCol, uAmbSky: ENV.uAmbSky, uAmbGround: ENV.uAmbGround, uFogCol: ENV.uFogCol,
        uCloudDrift: ENV.uCloudDrift, uFlashPos: ENV.uFlashPos, uFlash: ENV.uFlash,
        uNear: { value: 1 }, uFar: { value: 1 }, uWxHalf: ENV.uWxHalf, uFogDensity: ENV.uFogDensity,
      },
    });
    this.compMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: null }, tCloud: { value: null }, tCloudDepth: { value: null }, tDepth: { value: null },
        uCloudRes: { value: new THREE.Vector2() }, uNear: { value: 1 }, uFar: { value: 1 },
        uFlashScreen: this.uFlashScreen, uExposure: { value: 0.64 },
      },
    });
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    this.quad = new THREE.Mesh(geo, this.cloudMat);
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene(); this.fsScene.add(this.quad);
    this.fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.sceneRT = null; this.cloudRT = null;
  }

  setQuality(scale, steps) {
    this.scale = scale;
    if (steps !== this.steps) { this.steps = steps; this.cloudMat.defines.STEPS = steps; this.cloudMat.needsUpdate = true; }
    if (this.w) this.setSize(this.w, this.h);
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.sceneRT?.dispose(); this.cloudRT?.dispose();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    const cw = Math.max(2, Math.round(w * this.scale)), ch = Math.max(2, Math.round(h * this.scale));
    this.cloudRT = new THREE.WebGLRenderTarget(cw, ch, {
      type: THREE.HalfFloatType, count: 2, depthBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.compMat.uniforms.uCloudRes.value.set(cw, ch);
  }

  render(scene, camera) {
    const r = this.renderer, wx = this.weather;
    if (wx.dirty) { this.wxA.needsUpdate = true; this.wxB.needsUpdate = true; wx.dirty = false; }
    const period = 138700;                                         // common period of both noise scales
    ENV.uCloudDrift.value.set(wx.drift.x % period, 0, wx.drift.z % period);

    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    const cu = this.cloudMat.uniforms;
    cu.tDepth.value = this.sceneRT.depthTexture;
    cu.uProjInv.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld.value.copy(camera.matrixWorld);
    cu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    cu.uNear.value = camera.near; cu.uFar.value = camera.far;
    this.quad.material = this.cloudMat;
    r.setRenderTarget(this.cloudRT);
    r.render(this.fsScene, this.fsCam);

    const co = this.compMat.uniforms;
    co.tScene.value = this.sceneRT.texture;
    co.tCloud.value = this.cloudRT.textures[0];
    co.tCloudDepth.value = this.cloudRT.textures[1];
    co.tDepth.value = this.sceneRT.depthTexture;
    co.uNear.value = camera.near; co.uFar.value = camera.far;
    this.quad.material = this.compMat;
    r.setRenderTarget(null);
    r.render(this.fsScene, this.fsCam);
  }
}
