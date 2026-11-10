// Sky dome, sun and time-of-day lighting. Colours are keyed on sun elevation
// and greyed out by the weather overhead.
import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { clamp, smoothstep } from '../core/noise.js';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position * 1000.0, 1.0);
  gl_Position = p;
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDir, uSunDisc, uFogCol, uZenith;
uniform float uNight;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uFogCol, uZenith, 1.0 - exp(-h * 3.2));
  col = mix(col, uFogCol * 0.92, smoothstep(0.0, -0.25, d.y));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunDisc * (smoothstep(0.99955, 0.9998, s) * 30.0 + pow(s, 400.0) * 1.2 + pow(s, 24.0) * 0.16);
  if (uNight > 0.01 && d.y > 0.0) {
    vec3 g = d * 520.0, q = floor(g);
    float st = step(0.9982, hash(q)) * hash(q + 7.0) * (1.0 - smoothstep(0.15, 0.5, length(g - q - 0.5)));
    col += vec3(0.9, 0.95, 1.0) * st * uNight * smoothstep(0.0, 0.25, d.y) * 2.2;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const C = (r, g, b) => new THREE.Color(r, g, b);
const K = {
  dayZen: C(0.13, 0.32, 0.74), dayHor: C(0.60, 0.73, 0.88), daySun: C(1.16, 1.1, 0.99), dayAmb: C(0.17, 0.215, 0.30),
  goldZen: C(0.17, 0.25, 0.50), goldHor: C(0.98, 0.62, 0.36), goldSun: C(1.15, 0.64, 0.29), goldAmb: C(0.16, 0.16, 0.22),
  duskZen: C(0.035, 0.05, 0.14), duskHor: C(0.42, 0.27, 0.27), duskAmb: C(0.055, 0.065, 0.11),
  nightZen: C(0.004, 0.007, 0.02), nightHor: C(0.018, 0.026, 0.05), nightAmb: C(0.014, 0.019, 0.034), moon: C(0.05, 0.065, 0.1),
  ovcZen: C(0.36, 0.39, 0.43), ovcHor: C(0.55, 0.58, 0.62),
};
const tmp = new THREE.Color(), tmp2 = new THREE.Color();

export class Sky {
  constructor(scene) {
    this.uSunDisc = { value: new THREE.Color() };
    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 4),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: new THREE.Vector3() }, uSunDisc: this.uSunDisc, uFogCol: ENV.uFogCol, uZenith: ENV.uZenith, uNight: ENV.uNight },
        vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
      }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -1000;
    scene.add(this.mesh);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, Math.PI);
    scene.add(this.sun, this.sun.target, this.hemi);
    this.fog = new THREE.FogExp2(0xffffff, 0.00004);
    scene.fog = this.fog;
    this.trueSun = new THREE.Vector3();
    this.elev = 45;
  }

  /**
   * hour: local time 0..24. wx: {overcast 0..1 above camera, shade 0..1 on aircraft,
   * visibility m, precip 0..1}
   */
  update(hour, wx, focus) {
    const ha = ((hour - 6) / 12) * Math.PI;                     // 0 at sunrise, pi at sunset
    const el = Math.asin(clamp(Math.sin(ha) * 0.86, -1, 1));    // peak ~59 degrees
    const az = Math.PI / 2 + ((hour - 6) / 12) * Math.PI;       // east -> south -> west
    this.trueSun.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const e = (el * 180) / Math.PI;
    this.elev = e;

    const day = smoothstep(2, 22, e), gold = smoothstep(-5, 3, e) * (1 - day);
    const dusk = smoothstep(-13, -4, e) * (1 - smoothstep(-5, 3, e)), night = 1 - smoothstep(-13, -4, e);
    const blend = (out, a, b, c, d) => out.setRGB(0, 0, 0)
      .add(tmp.copy(a).multiplyScalar(day)).add(tmp.copy(b).multiplyScalar(gold))
      .add(tmp.copy(c).multiplyScalar(dusk)).add(tmp.copy(d).multiplyScalar(night));

    const ov = clamp(wx.overcast, 0, 1), dim = 1 - 0.45 * wx.precip;
    const lum = day * 1 + gold * 0.55 + dusk * 0.12 + night * 0.012;

    blend(ENV.uZenith.value, K.dayZen, K.goldZen, K.duskZen, K.nightZen);
    ENV.uZenith.value.lerp(tmp2.copy(K.ovcZen).multiplyScalar(lum * dim), ov * 0.92);
    blend(ENV.uFogCol.value, K.dayHor, K.goldHor, K.duskHor, K.nightHor);
    ENV.uFogCol.value.lerp(tmp2.copy(K.ovcHor).multiplyScalar(lum * dim), Math.max(ov * 0.85, wx.precip * 0.8));
    blend(ENV.uAmbSky.value, K.dayAmb, K.goldAmb, K.duskAmb, K.nightAmb);
    ENV.uAmbSky.value.lerp(tmp2.setRGB(0.24, 0.25, 0.27).multiplyScalar(lum * dim), ov * 0.8);
    ENV.uAmbGround.value.copy(ENV.uAmbSky.value).multiplyScalar(0.38).lerp(tmp2.setRGB(0.06, 0.055, 0.045).multiplyScalar(lum), 0.4);

    // Below the horizon the "sun" light becomes faint moonlight from the opposite sky.
    const sunUp = smoothstep(-3, 2, e);
    blend(ENV.uSunCol.value, K.daySun, K.goldSun, K.goldSun, K.moon);
    ENV.uSunCol.value.multiplyScalar(sunUp + (1 - smoothstep(-13, -6, e)));
    if (e > -4) ENV.uSunDir.value.copy(this.trueSun);
    else ENV.uSunDir.value.set(-this.trueSun.x, Math.max(0.35, -this.trueSun.y), -this.trueSun.z).normalize();
    if (ENV.uSunDir.value.y < 0.03) { ENV.uSunDir.value.y = 0.03; ENV.uSunDir.value.normalize(); }
    ENV.uNight.value = night + dusk * 0.4;

    this.mesh.material.uniforms.uSunDir.value.copy(this.trueSun);
    this.uSunDisc.value.copy(ENV.uSunCol.value).multiplyScalar(sunUp * (1 - ov * 0.97));

    ENV.uFogDensity.value = 1.98 / Math.max(wx.visibility, 300);
    this.fog.color.copy(ENV.uFogCol.value);
    this.fog.density = ENV.uFogDensity.value;

    this.sun.color.copy(ENV.uSunCol.value).multiplyScalar(Math.PI * (1 - 0.85 * wx.shade));
    this.sun.position.copy(focus).addScaledVector(ENV.uSunDir.value, 1000);
    this.sun.target.position.copy(focus);
    this.hemi.color.copy(ENV.uAmbSky.value);
    this.hemi.groundColor.copy(ENV.uAmbGround.value);
  }
}
