// Shared plumbing for full-screen shader passes (clouds and post-processing).
import * as THREE from 'three';

export const FS_VERT = /* glsl */`
in vec2 position;
out vec2 vUv;
void main() { vUv = position * 0.5 + 0.5; gl_Position = vec4(position, 0.0, 1.0); }`;

/** A GLSL ES 3.00 full-screen material with depth disabled. */
export function fsMaterial(fragmentShader, uniforms, opts = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: opts.vertexShader || FS_VERT, fragmentShader, uniforms,
    defines: opts.defines || {}, depthTest: false, depthWrite: false,
  });
}

/** One triangle that covers the screen; draw() runs a material into a target. */
export class FullscreenQuad {
  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    this.mesh = new THREE.Mesh(geo, null);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  draw(renderer, material, target = null) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}

/** Colour-only HDR render target for intermediate passes. */
export function hdrTarget(w, h, opts = {}) {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...opts,
  });
}
