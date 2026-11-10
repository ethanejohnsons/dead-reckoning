// Rain and snow streaks around the camera, plus lightning bolts.
// Drops live in a wrapping box centred on the camera; the vertex shader
// stretches each into a streak along its velocity relative to the viewer,
// so rain rushes past horizontally at cruise speed.
import * as THREE from 'three';
import { ENV } from '../core/env.js';

const BOX = 32, COUNT = 14000;

const VERT = /* glsl */`
attribute float aEnd;
attribute float aSide;
uniform vec3 uOffset, uStreak;
uniform float uBox, uWidth;
varying float vFade;
void main() {
  vec3 q = mod(position + uOffset, uBox) - uBox * 0.5;
  float dist = length(q);
  vFade = (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, dist)) * smoothstep(0.6, 2.5, dist) * (1.0 - aEnd * 0.7);
  vec3 v = mat3(viewMatrix) * (q + uStreak * aEnd);
  vec3 s = mat3(viewMatrix) * uStreak;
  // Widen each streak into a ribbon facing the camera.
  vec3 side = normalize(cross(v, s) + vec3(1.0e-5, 0.0, 0.0)) * uWidth * aSide;
  gl_Position = projectionMatrix * vec4(v + side, 1.0);
}`;
const FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying float vFade;
void main() { gl_FragColor = vec4(uColor, uOpacity * vFade); }`;

export class Precip {
  constructor(scene) {
    const pos = new Float32Array(COUNT * 12), end = new Float32Array(COUNT * 4), side = new Float32Array(COUNT * 4), idx = new Uint32Array(COUNT * 6);
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random() * BOX, y = Math.random() * BOX, z = Math.random() * BOX;
      for (let k = 0; k < 4; k++) { pos.set([x, y, z], i * 12 + k * 3); end[i * 4 + k] = k >> 1; side[i * 4 + k] = k & 1 ? 1 : -1; }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.u = { uOffset: { value: new THREE.Vector3() }, uStreak: { value: new THREE.Vector3() }, uBox: { value: BOX }, uWidth: { value: 0.01 },
      uColor: { value: new THREE.Color() }, uOpacity: { value: 0 } };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.fall = new THREE.Vector3();       // accumulated drop displacement
    this.level = 0;

    // Lightning bolt: a jagged line that lives for a few frames.
    this.bolt = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 1, fog: false }));
    this.bolt.frustumCulled = false; this.bolt.visible = false;
    scene.add(this.bolt);
    this.boltT = 0; this.flash = 0;
  }

  /** intensity 0..1, snow bool, wind = air velocity (world), camVel = camera velocity, camPos. */
  update(dt, intensity, snow, wind, camVel, camPos) {
    this.level += (intensity - this.level) * Math.min(1, dt * 1.5);
    const on = this.level > 0.01;
    this.mesh.visible = on;
    if (on) {
      const vy = snow ? -1.6 : -9;
      this.fall.x += wind.x * dt; this.fall.y += (vy + wind.y) * dt; this.fall.z += wind.z * dt;
      // Drop positions are fixed in the air mass; subtract camera motion and wrap.
      const o = this.u.uOffset.value;
      o.set(((this.fall.x - camPos.x) % BOX + BOX) % BOX, ((this.fall.y - camPos.y) % BOX + BOX) % BOX, ((this.fall.z - camPos.z) % BOX + BOX) % BOX);
      const exp = snow ? 0.003 : 0.03;
      this.u.uStreak.value.set((wind.x - camVel.x) * exp, (vy + wind.y - camVel.y) * exp, (wind.z - camVel.z) * exp);
      if (snow) this.u.uStreak.value.clampLength(0.03, 0.3); else this.u.uStreak.value.clampLength(0.3, 4.5);
      this.u.uColor.value.copy(ENV.uFogCol.value).multiplyScalar(snow ? 1.9 : 1.7).addScalar(snow ? 0.45 : 0.32);
      this.u.uOpacity.value = Math.min(1, this.level * (snow ? 1.6 : 1.2)) * (snow ? 0.9 : 0.55);
      this.u.uWidth.value = snow ? 0.013 : 0.011;
    }
    // Lightning decay
    this.flash = Math.max(0, this.flash - dt * 4.5);
    if (this.boltT > 0) { this.boltT -= dt; this.bolt.material.opacity = Math.min(1, this.boltT * 8); if (this.boltT <= 0) this.bolt.visible = false; }
    ENV.uFlash.value = this.flash * (0.6 + 0.4 * Math.sin(performance.now() * 0.09));
  }

  /** Trigger a lightning flash at a world position; ground strikes draw a bolt. */
  strike(f, groundY) {
    ENV.uFlashPos.value.set(f.x, f.y, f.z);
    this.flash = 1;
    if (!f.ground) return;
    const p = this.bolt.geometry.attributes.position, n = p.count;
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      p.setXYZ(i, x, (1 - t) * (f.y - groundY), z);
      x += (Math.random() - 0.5) * 160; z += (Math.random() - 0.5) * 160;
    }
    p.needsUpdate = true;
    this.bolt.position.set(f.x, groundY, f.z);
    this.bolt.visible = true; this.boltT = 0.22;
  }
}
