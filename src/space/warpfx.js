// The streaks of warp: stars drawn out into lines, rushing past the ship from bow to stern.
//
// They are not the sky's stars (which do not move at all on a trip across the solar system) but a tube of
// points of light around the ship, in the ship's own axes, each drawn as a ribbon along the direction of
// travel that faces the camera. A point's place along the tube is its own offset plus the distance "flown",
// wrapped, so the whole thing is one instanced draw with nothing to update but a few numbers. The faster
// the warp factor, the longer the streaks and the faster they pass.

import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec4 aSeed;            // angle round the tube, radius, place along it, tint: each 0..1
uniform vec4 uTube;              // inner and outer radius, length (m), distance flown (m)
uniform vec3 uStreak;            // a streak's length and width (m), brightness
varying vec3 vCol; varying vec2 vUv;
void main() {
  float ang = aSeed.x * 6.2831853, rad = mix(uTube.x, uTube.y, sqrt(aSeed.y));
  float z = mod(aSeed.z * uTube.z + uTube.w * (0.6 + 0.8 * aSeed.w), uTube.z) - 0.5 * uTube.z;
  float len = uStreak.x * (0.5 + aSeed.y);
  vec4 mv = modelViewMatrix * vec4(cos(ang) * rad, sin(ang) * rad, z - position.y * len, 1.0);
  vec3 along = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 side = cross(along, normalize(mv.xyz));
  float sl = max(length(side), 1.0e-4);
  // (never thinner than a pixel and a half, however far off)
  mv.xyz += side / sl * position.x * max(uStreak.y, -mv.z * 0.0016);
  gl_Position = projectionMatrix * mv;
  float ends = smoothstep(0.5, 0.36, abs(z) / uTube.z);
  vCol = mix(vec3(0.75, 0.86, 1.0), vec3(1.0, 0.95, 0.88), aSeed.w * aSeed.w) * (uStreak.z * ends * (0.35 + 0.65 * aSeed.x));
  vUv = position.xy;
}`;
const FRAG = /* glsl */`
varying vec3 vCol; varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.x) * 2.0;
  float along = smoothstep(0.0, 0.08, vUv.y) * (1.0 - vUv.y);       // bright at the head, fading down the tail
  gl_FragColor = vec4(vCol * across * across * along, 0.0);
}`;

export class WarpStreaks {
  constructor(count = 900) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seed = new Float32Array(count * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    g.instanceCount = count;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.u = { uTube: { value: new THREE.Vector4(420, 9000, 70000, 0) }, uStreak: { value: new THREE.Vector3(2000, 6, 0) } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.object = new THREE.Mesh(g, this.mat);
    this.object.frustumCulled = false; this.object.visible = false; this.object.renderOrder = 5;
  }

  /** amount: 0 (none) .. 1 (at warp). factor: the warp factor. surge: 0..1, the moment of the jump. */
  update(dt, amount, factor = 1, surge = 0) {
    this.object.visible = amount > 0.01;
    if (!this.object.visible) return;
    const f = Math.max(1, Math.min(factor, 9.5));
    this.u.uTube.value.w = (this.u.uTube.value.w + dt * (9000 + 5200 * f) * (1 + 2 * surge)) % 7.0e6;
    this.u.uStreak.value.set((900 + 620 * f) * (0.25 + 0.75 * amount) * (1 + 1.5 * surge), 5, 5.5 * amount * amount);
  }

  dispose() { this.object.geometry.dispose(); this.mat.dispose(); }
}
