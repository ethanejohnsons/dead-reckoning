// Shadows the sun throws from things, as opposed to from the land (world/groundlight.js bakes those).
//
//   the aircraft   Its silhouette as the sun sees it, drawn every frame into a small map that travels with
//                  it, with mipmaps. Whatever lies down-sun of it reads that map blurred by the width the
//                  sun's half degree gives at that distance: crisp under the wheels, a soft smudge from
//                  300 m up, gone by a kilometer or so. The map is centered on the aircraft itself, so the
//                  silhouette does not move in it and the shadow cannot swim.
//   structures     Two depth maps around the camera, one inside the other (420 m and 2.1 km across), for
//                  airfield buildings and whatever else is handed in as a caster. Each is laid out on a
//                  grid fixed to the sun's direction and moves in whole texels, so a shadow's edge is
//                  rasterized the same way every frame however the camera moves.
//
// Ground shaders read both through localShadow() in GROUND_LIGHT_GLSL (world/groundlight.js); the
// uniforms live in ENV.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import './groundlight.js';              // declares the uniform holders in ENV
import { perf } from '../render/perf.js';

const AC_PAD = 8;                       // room around the aircraft for the widest blur (m)
// Texels across the aircraft's map and across each structure map, by quality tier.
const TIERS = { low: [512, 1024], med: [1024, 2048], high: [1024, 2048], ultra: [1024, 3072] };
const SPANS = [420, 2100];              // their widths (m)
const BIAS = [0.3, 1.3];                // how far behind a surface its own shadow starts (m)
const DEPTH = 1500;                     // the maps reach this far up-sun and down-sun of the camera (m)
const AC_REACH = 1400;                  // the aircraft's shadow has faded out this far down-sun of it (m): see aircraftShadow() in groundlight.js

const AC_VERT = /* glsl */`
uniform vec3 uCenter, uDown;
varying float vZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vZ = dot(wp.xyz - uCenter, uDown);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const AC_FRAG = /* glsl */`
uniform float uR;
varying float vZ;
void main() { gl_FragColor = vec4(1.0, vZ + uR, 0.0, 1.0); }`;

const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), C = new THREE.Vector3(), V = new THREE.Vector3();
const M = new THREE.Matrix4(), box = new THREE.Box3(), tb = new THREE.Box3(), sph = new THREE.Sphere(), black = new THREE.Color(0, 0, 0), keep = new THREE.Color();

export class SunShadows {
  constructor(renderer) {
    this.renderer = renderer;
    this.enabled = true;

    // ---- the aircraft
    this.acCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 10);
    this.acMat = new THREE.ShaderMaterial({ uniforms: { uCenter: { value: new THREE.Vector3() }, uDown: { value: new THREE.Vector3() }, uR: { value: 8 } }, vertexShader: AC_VERT, fragmentShader: AC_FRAG, side: THREE.DoubleSide });
    this.acScene = new THREE.Scene(); this.acScene.matrixWorldAutoUpdate = false; this.acScene.overrideMaterial = this.acMat;
    this.aircraft = null; this.show = []; this.hide = []; this.skip = []; this.acCenter = new THREE.Vector3(); this.acR = 8; this.measured = -1e9;
    /** Height of the ground at (x, z), if the game provides it: lets the aircraft's map be skipped when it flies too high to throw a shadow on anything. */
    this.ground = null;

    // ---- structures
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2 * DEPTH);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 4 });
    this.scene = new THREE.Scene(); this.scene.matrixWorldAutoUpdate = false; this.scene.overrideMaterial = this.depthMat;
    /** Where to look for things that throw shadows, and how to tell them: set by the game. */
    this.casterRoots = []; this.isCaster = (o) => o.isMesh && o.castShadow;
    this.casters = []; this.frame = 0;
    this.snap = true;                   // (false lets the maps slide with the camera: only for measuring what the snapping buys)
    this.acRT = null; this.rt = null;
    this.setQuality('high');
  }

  /** 'low' | 'med' | 'high': the size of the maps. */
  setQuality(level) {
    const [acSize, map] = TIERS[level] || TIERS.med, r = this.renderer;
    if (this.acSize === acSize && this.map === map) return;
    this.acSize = acSize; this.map = map;
    this.acRT?.dispose(); this.rt?.depthTexture?.dispose(); this.rt?.dispose();
    this.acRT = new THREE.WebGLRenderTarget(acSize, acSize, {
      type: THREE.HalfFloatType, format: THREE.RGFormat, samples: 4, depthBuffer: true,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    // both structure maps side by side in one depth texture, compared in hardware
    this.rt = new THREE.WebGLRenderTarget(map * 2, map, { format: THREE.RedFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const d = this.rt.depthTexture = new THREE.DepthTexture(map * 2, map, THREE.UnsignedIntType);
    d.format = THREE.DepthFormat; d.compareFunction = THREE.LessEqualCompare; d.minFilter = d.magFilter = THREE.LinearFilter;
    this.rt.scissorTest = true;
    // Both must exist as textures before any shader that names them is used, drawn into or not.
    r.initRenderTarget(this.acRT); r.initRenderTarget(this.rt);
    ENV.tAcShadow.value = this.acRT.texture; ENV.tSunShadow.value = d;
    ENV.uSunShadowP.value.set(0, 1 / map, BIAS[0] / (2 * DEPTH), BIAS[1] / (2 * DEPTH));
    ENV.uAcShadowP.value.x = 0;
  }

  /**
   * The aircraft that throws the traveling shadow. show: parts drawn for it whatever the view (the outside of
   * the aircraft); hide: parts left out (the cockpit interior, which exists only for the pilot's eye).
   */
  setAircraft(root, show = [], hide = []) { this.aircraft = root; this.show = show; this.hide = hide; this.measured = -1e9; }

  /** The aircraft's size, from the meshes that will be drawn: the map is fitted to it. */
  measure() {
    const root = this.aircraft, inv = M.copy(root.matrixWorld).invert(), m2 = new THREE.Matrix4();
    const hidden = new Set(); for (const h of this.hide) h.traverse((o) => hidden.add(o));
    box.makeEmpty(); this.skip.length = 0;
    root.traverse((o) => {
      if (o === root || o.isGroup || o.type === 'Object3D') return;
      const solid = o.isMesh && o.geometry && o.castShadow && !o.material?.transparent && !hidden.has(o);
      if (!solid) { this.skip.push(o); return; }
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(tb.copy(o.geometry.boundingBox).applyMatrix4(m2.multiplyMatrices(inv, o.matrixWorld)));
    });
    if (box.isEmpty()) { this.acR = 0; return; }
    box.getBoundingSphere(sph);
    this.acCenter.copy(sph.center); this.acR = sph.radius * 1.03 + 0.1;
  }

  drawAircraft(sun, strength) {
    const r = this.renderer, root = this.aircraft, P = ENV.uAcShadowP.value;
    if (!root || !this.enabled || !(strength > 0.004)) { P.x = 0; return; }
    root.updateWorldMatrix(true, true);
    if (this.ground) {
      // Is there any ground within reach, down-sun? Follow the ray and see how close it comes.
      let near = false; V.setFromMatrixPosition(root.matrixWorld);
      for (let t = 0; t <= AC_REACH + 100 && !near; t += 125) near = V.y - sun.y * t - this.ground(V.x - sun.x * t, V.z - sun.z * t) < 60 + 0.12 * t;
      if (!near) { P.x = 0; return; }
    }
    const vis = [];
    const set = (o, v) => { if (o.visible !== v) { vis.push(o, o.visible); o.visible = v; } };
    for (const o of this.show) set(o, true);
    if (this.frame - this.measured > 600) { this.measure(); this.measured = this.frame; }
    if (!(this.acR > 0)) { P.x = 0; for (let i = 0; i < vis.length; i += 2) vis[i].visible = vis[i + 1]; return; }
    for (const o of this.hide) set(o, false);
    for (const o of this.skip) set(o, false);

    const R = this.acR, E = R + AC_PAD, cam = this.acCam;
    C.copy(this.acCenter).applyMatrix4(root.matrixWorld);
    cam.left = -E; cam.right = E; cam.top = E; cam.bottom = -E; cam.near = 0.05; cam.far = 2 * R + 0.1; cam.updateProjectionMatrix();
    cam.position.copy(C).addScaledVector(Z, R + 0.05);
    cam.quaternion.setFromRotationMatrix(M.makeBasis(X, Y, Z));
    cam.updateMatrixWorld();
    const u = this.acMat.uniforms; u.uCenter.value.copy(C); u.uDown.value.copy(Z).negate(); u.uR.value = R;
    this.acScene.children = [root];
    const alpha = r.getClearAlpha(); r.getClearColor(keep); r.setClearColor(black, 0);
    const auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.acRT); r.render(this.acScene, cam);
    r.shadowMap.autoUpdate = auto; r.setClearColor(keep, alpha);
    this.acScene.children = [];
    for (let i = 0; i < vis.length; i += 2) vis[i].visible = vis[i + 1];

    // world -> (place in the map, meters down-sun of the aircraft's middle)
    const k = 1 / (2 * E);
    ENV.uAcShadowM.value.set(
      X.x * k, X.y * k, X.z * k, 0.5 - C.dot(X) * k,
      Y.x * k, Y.y * k, Y.z * k, 0.5 - C.dot(Y) * k,
      -Z.x, -Z.y, -Z.z, C.dot(Z),
      0, 0, 0, 1);
    P.set(strength, (2 * E) / this.acSize, k, R);
  }

  drawStructures(camera, strength) {
    const r = this.renderer, P = ENV.uSunShadowP.value;
    if (!(this.frame % 30) || !this.casters.length) {
      this.casters.length = 0;
      for (const root of this.casterRoots) root.traverse((o) => { if (this.isCaster(o)) { o.updateWorldMatrix(true, false); if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); this.casters.push(o); } });
    }
    const pos = V.setFromMatrixPosition(camera.matrixWorld);
    const px = pos.dot(X), py = pos.dot(Y), pz = pos.dot(Z);
    // is anything that throws a shadow inside the outer map's column of space at all?
    let any = false; const E1 = SPANS[1] / 2 + 80;
    for (const o of this.casters) {
      sph.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
      if (Math.abs(sph.center.dot(X) - px) < E1 + sph.radius && Math.abs(sph.center.dot(Y) - py) < E1 + sph.radius) { any = true; break; }
    }
    if (!any || !this.enabled || !(strength > 0.004)) {
      P.x = 0; return;                       // nothing near enough to throw a shadow here: the shaders skip the maps
    }
    const cam = this.cam, auto = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    this.scene.children = this.casters;
    for (let i = 0; i < 2; i++) {
      const E = SPANS[i] / 2, texel = SPANS[i] / this.map;
      // the map's middle sits on a grid of whole texels laid out across the sun's direction
      const cx = this.snap ? Math.round(px / texel) * texel : px, cy = this.snap ? Math.round(py / texel) * texel : py;
      C.set(0, 0, 0).addScaledVector(X, cx).addScaledVector(Y, cy).addScaledVector(Z, pz);
      cam.left = -E; cam.right = E; cam.top = E; cam.bottom = -E; cam.near = 0; cam.far = 2 * DEPTH; cam.updateProjectionMatrix();
      cam.position.copy(C).addScaledVector(Z, DEPTH);
      cam.quaternion.setFromRotationMatrix(M.makeBasis(X, Y, Z));
      cam.updateMatrixWorld();
      this.rt.viewport.set(i * this.map, 0, this.map, this.map); this.rt.scissor.set(i * this.map, 0, this.map, this.map);
      r.setRenderTarget(this.rt); r.render(this.scene, cam);
      const k = 1 / (2 * E), kz = 1 / (2 * DEPTH);
      ENV.uSunShadowM.value[i].set(
        X.x * k, X.y * k, X.z * k, 0.5 - cx * k,
        Y.x * k, Y.y * k, Y.z * k, 0.5 - cy * k,
        -Z.x * kz, -Z.y * kz, -Z.z * kz, 0.5 + pz * kz,
        0, 0, 0, 1);
    }
    this.scene.children = [];
    r.shadowMap.autoUpdate = auto;
    P.x = strength;
  }

  /**
   * Once a frame, after the aircraft has been placed and before the scene is drawn.
   * strength: 1 in clear sun, 0 when the sun is hidden (under overcast the light that is left comes from the whole
   * sky and throws no shadow, though the ground shaders still count a little of it as sunlight).
   */
  update(camera, strength = 1) {
    const r = this.renderer, prev = r.getRenderTarget(), sun = ENV.uSunDir.value;
    // axes across the sun's direction, the same whatever the camera does
    Z.copy(sun).normalize();
    X.set(Z.z, 0, -Z.x); if (X.lengthSq() < 1e-8) X.set(1, 0, 0); X.normalize();
    Y.crossVectors(Z, X);
    perf.begin('shadow maps');
    this.drawAircraft(sun, strength);
    this.drawStructures(camera, strength);
    perf.end();
    r.setRenderTarget(prev);
    this.frame++;
  }
}
