// The glow of reentry: the air a returning craft rams into, heated until it shines.
//
// One additive shell around what is left of the vehicle, turned to face the way it is moving through the
// air: a bright cap of shocked gas standing off its leading side, and a long tail of streamers behind,
// drawn from a sphere whose back half the vertex shader pulls out along the flow. How bright it is follows
// the heating the flight model reports (the root of the air's density times the speed cubed): nothing on
// the way up, a faint orange film at the first touch of air, white-pink at the worst of it, and gone again
// as the craft slows. The fragment shader fakes a thin glowing layer from the angle between the shell and
// the eye, and runs streaks of noise down the tail.
//
// attach `glow.mesh` to the vehicle's root; update(dt, s) every frame.

import * as THREE from 'three';

const VERT = /* glsl */`
uniform float uTail, uHeat;
varying vec3 vN; varying vec3 vView; varying float vZ; varying vec2 vAround;
void main() {
  vec3 p = position;                         // on a unit sphere: +Z is upstream, the way the craft is going
  vZ = p.z;
  float back = max(-p.z, 0.0);
  // Front: a cap flattened onto the craft. Back: pulled out into a tail that narrows.
  vec3 q = p;
  q.z = p.z > 0.0 ? p.z * 0.62 : -pow(back, 1.6) * uTail;
  q.xy *= p.z > 0.0 ? 1.0 + 0.1 * (1.0 - p.z) : 1.1 - 0.72 * back * back;
  vAround = vec2(atan(p.y, p.x), q.z);
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  // (the normal of the stretched shape, near enough: the sphere's, with its lengthwise part shrunk in the tail)
  vec3 n = normalize(vec3(p.xy, p.z > 0.0 ? p.z * 1.6 : p.z / max(uTail * 0.6, 1.0)));
  vN = normalize(normalMatrix * n); vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform float uHeat, uTime, uTail;
varying vec3 vN; varying vec3 vView; varying float vZ; varying vec2 vAround;
float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
float noise(vec2 p) { vec2 i = floor(p), f = p - i; f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  float facing = abs(dot(normalize(vN), normalize(vView)));
  // A thin layer of glowing gas is brightest where it is seen edge on.
  float edge = 1.0 - facing, layer = 0.05 + 0.95 * edge * edge * edge;
  float front = smoothstep(-0.25, 0.85, vZ);
  // Streamers down the tail, sliding back.
  float a = vAround.x * 2.5, s = vAround.y * 0.9 + uTime * 9.0;
  float streak = 0.55 * noise(vec2(a * 3.0, s * 0.35)) + 0.45 * noise(vec2(a * 9.0 + 4.0, s * 1.1));
  float tail = pow(clamp(1.0 + vZ, 0.0, 1.0), 3.0) * (0.2 + 1.3 * streak * streak);
  float flick = 0.88 + 0.12 * noise(vec2(uTime * 23.0, a));
  float i = (front * (0.9 + 0.5 * streak) + (1.0 - front) * tail) * layer * flick;
  // Orange at the edge of the air, white-pink at the worst of the heating.
  vec3 cool = vec3(1.0, 0.30, 0.06), hot = vec3(1.0, 0.56, 0.50);
  vec3 col = mix(cool, hot, clamp(uHeat * 1.15 - 0.15 + 0.35 * front, 0.0, 1.0));
  gl_FragColor = vec4(col * i * (0.35 + 3.2 * uHeat * uHeat) * smoothstep(0.0, 0.12, uHeat), 1.0);
}`;

export class ReentryGlow {
  constructor() {
    this.u = { uHeat: { value: 0 }, uTime: { value: 0 }, uTail: { value: 7 } };
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: false, toneMapped: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    // The sphere's poles are on Y: turn it so they lie on the flow's axis.
    this.mesh.geometry.rotateX(Math.PI / 2);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 5; this.mesh.castShadow = false;
    this.level = 0;
  }

  /**
   * s: { heat (the flight model's figure), flow (unit Vector3 in the vehicle root's own axes: the way the craft moves
   * through the air), length, radius (what is left of the vehicle, m), centerY (its middle, along the root's Y), time }
   */
  update(dt, s) {
    // Nothing below 6e8; all of it by 1.6e10 (log scale: the heating runs over orders of magnitude).
    const want = s.heat > 1 ? THREE.MathUtils.clamp((Math.log10(s.heat) - 8.78) / 1.42, 0, 1) : 0;
    this.level += (want - this.level) * Math.min(1, dt > 0 ? dt * 4 : 1);
    const k = this.level, m = this.mesh;
    m.visible = k > 0.01;
    if (!m.visible) return;
    // Wide enough to wrap the craft however it is turned to the flow.
    const cosA = Math.abs(s.flow.y), sinA = Math.sqrt(Math.max(1 - cosA * cosA, 0));
    const R = Math.hypot(0.5 * s.length * sinA, s.radius * 1.7) * (1.05 + 0.2 * k);
    m.position.set(0, s.centerY, 0);
    m.quaternion.setFromUnitVectors(Z, s.flow);
    m.scale.set(R, R, Math.max(R, 0.5 * s.length * cosA + s.radius) * 1.15);
    this.u.uHeat.value = k; this.u.uTime.value = s.time % 1000; this.u.uTail.value = 5 + 6 * k;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
const Z = new THREE.Vector3(0, 0, 1);
