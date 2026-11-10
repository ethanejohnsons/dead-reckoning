// Quadtree level-of-detail terrain. Each node is a 33x33 vertex patch with
// skirts; nodes split as the camera approaches so detail follows the aircraft
// across the whole continent. Water is the same mesh clamped at sea level.

import * as THREE from 'three';
import { height, terrainColor, forestDensity, WORLD_HALF } from './terrain.js';
import { mulberry32 } from '../core/noise.js';
import { ENV } from '../core/env.js';

const N = 32, V = N + 1, W = V + 2;
const MIN_SIZE = 512, TREE_SIZE = 1024;
const SPLIT = 2.3, MERGE = 2.7;

const VERT = /* glsl */`
attribute float aWater;
varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying float vWater; varying float vDist;
void main() {
  vec4 lp = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_COLOR
    vColor = color;
  #endif
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
    mat3 im = mat3(instanceMatrix);
    n = normalize((im * n) / vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])));
    vColor = instanceColor * (0.55 + 0.6 * position.y);
  #endif
  vNormal = n;
  vWater = aWater;
  vWorld = (modelMatrix * lp).xyz;
  vec4 mv = modelViewMatrix * lp;
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround, uFogCol, uZenith, uCloudDrift;
uniform float uFogDensity, uTime, uWxHalf, uTAnom;
uniform sampler2D tWxA, tWxB, tDetail;
varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying float vWater; varying float vDist;

void main() {
  vec3 N = normalize(vNormal);
  vec3 L = uSunDir;
  vec3 alb = vColor;
  #ifndef TREE
    float d1 = texture2D(tDetail, vWorld.xz / 41.0).r;
    float d2 = texture2D(tDetail, vWorld.xz / 530.0).g;
    float land = 1.0 - vWater;
    alb *= mix(1.0, (0.7 + 0.6 * d1) * (0.82 + 0.36 * d2), land);
  #else
    float land = 1.0, d2 = 0.5;
  #endif
  // Fresh snow where today's air mass is below freezing (the baked colours hold the climatological snowline).
  if (uTAnom < -0.5) {
    float tHere = 16.0 + 14.0 * clamp((vWorld.z + 15000.0) / 165000.0, -1.0, 1.0) + uTAnom - 0.0065 * vWorld.y;
    float snow = smoothstep(1.0, -3.0, tHere + (d2 - 0.5) * 5.0) * land;
    #ifdef TREE
      snow *= 0.55;
    #else
      snow *= 1.0 - smoothstep(0.3, 0.6, 1.0 - N.y);
    #endif
    alb = mix(alb, vec3(0.86, 0.89, 0.93), snow);
  }

  // Cloud shadows: project along the sun to the cloud layer and read the weather map.
  vec2 wuv = (vWorld.xz + L.xz / max(L.y, 0.2) * 1400.0) / (2.0 * uWxHalf) + 0.5;
  vec4 wa = texture2D(tWxA, wuv);
  vec4 wb = texture2D(tWxB, wuv);
  float above = smoothstep(-200.0, 300.0, wb.g * 12800.0 - vWorld.y);
  float patchN = texture2D(tDetail, (vWorld.xz + uCloudDrift.xz) / 7300.0).b;
  float sh = smoothstep(0.92 - wa.r, 1.22 - wa.r, patchN + wa.g * 0.3) * step(0.02, wa.r) * above;
  sh = max(sh, wa.b * 0.6 * above);

  float ndl = max(dot(N, L), 0.0);
  vec3 sun = uSunCol * ndl * (1.0 - 0.85 * sh);
  vec3 amb = mix(uAmbGround, uAmbSky, N.y * 0.5 + 0.5) * (1.0 - 0.3 * sh);
  vec3 col = alb * (sun + amb);

  #ifndef TREE
  if (vWater > 0.02) {
    vec3 V = normalize(cameraPosition - vWorld);
    vec2 wv = vWorld.xz / 70.0;
    vec3 t1 = texture2D(tDetail, wv + uTime * vec2(0.011, 0.007)).rgb;
    vec3 t2 = texture2D(tDetail, wv * 2.7 - uTime * vec2(0.013, 0.016)).gbr;
    float near = exp(-vDist / 9000.0);
    vec3 wn = normalize(vec3((t1.r + t2.r - 1.0) * 0.5 * near, 1.0, (t1.g + t2.g - 1.0) * 0.5 * near));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(V, wn), 0.0), 5.0);
    vec3 R = reflect(-V, wn);
    vec3 sky = mix(uFogCol, uZenith, clamp(R.y * 1.6, 0.0, 1.0)) * (1.0 - 0.35 * sh);
    float spec = pow(max(dot(R, L), 0.0), 220.0) * (1.0 - sh);
    vec3 wcol = vColor * (uSunCol * max(L.y, 0.0) * (1.0 - 0.8 * sh) * 0.55 + amb) * (1.0 - fres)
      + sky * fres + uSunCol * spec * 3.0;
    col = mix(col, wcol, vWater);
  }
  #endif

  float f = 1.0 - exp(-pow(vDist * uFogDensity, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, f), 1.0);
}`;

function makeMaterial(tree) {
  const u = {};
  for (const k of ['uSunDir', 'uSunCol', 'uAmbSky', 'uAmbGround', 'uFogCol', 'uZenith', 'uFogDensity',
    'uTime', 'uWxHalf', 'tWxA', 'tWxB', 'tDetail', 'uCloudDrift', 'uTAnom']) u[k] = ENV[k];
  return new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VERT, fragmentShader: FRAG,
    vertexColors: !tree, defines: tree ? { TREE: 1 } : {},
  });
}

function makeDetailTexture() {
  const S = 256, data = new Uint8Array(S * S * 4);
  const rnd = mulberry32(99);
  // Three channels of tiling value noise at different octaves.
  const layer = (freq, seed) => {
    const g = new Float32Array(freq * freq);
    const r = mulberry32(seed);
    for (let i = 0; i < g.length; i++) g[i] = r();
    return (x, y) => {
      const fx = (x / S) * freq, fy = (y / S) * freq;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      let u = fx - ix, v = fy - iy; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
      const a = g[(iy % freq) * freq + (ix % freq)], b = g[(iy % freq) * freq + ((ix + 1) % freq)];
      const c = g[((iy + 1) % freq) * freq + (ix % freq)], d = g[((iy + 1) % freq) * freq + ((ix + 1) % freq)];
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
  };
  const chans = [0, 1, 2].map((c) => [layer(8, 10 + c), layer(16, 20 + c), layer(32, 30 + c), layer(64, 40 + c)]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) {
      const L = chans[c];
      const v = L[0](x, y) * 0.42 + L[1](x, y) * 0.28 + L[2](x, y) * 0.18 + L[3](x, y) * 0.08 + (rnd() - 0.5) * 0.06;
      data[o + c] = Math.max(0, Math.min(255, v * 255));
    }
    data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true;
  return t;
}

function makeIndex() {
  const idx = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * V + i, b = a + V, c = a + 1, d = b + 1;
    idx.push(a, b, c, c, b, d);
  }
  // Skirts: four strips hanging from the patch edges, emitted double-sided.
  const edge = [
    (k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N,
  ];
  for (let e = 0; e < 4; e++) for (let k = 0; k < N; k++) {
    const a = edge[e](k), b = edge[e](k + 1), sa = V * V + e * V + k, sb = sa + 1;
    idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
  }
  return new THREE.BufferAttribute(new Uint16Array(idx), 1);
}

class Node {
  constructor(x0, z0, size) {
    this.x0 = x0; this.z0 = z0; this.size = size;
    this.mesh = null; this.trees = null; this.children = null;
    this.queued = false; this.midY = 0;
  }
}

export class Terrain {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    ENV.tDetail.value = makeDetailTexture();
    this.material = makeMaterial(false);
    this.treeMaterial = makeMaterial(true);
    this.index = makeIndex();
    this.treeGeo = new THREE.ConeGeometry(0.5, 1, 6, 1, true);
    this.treeGeo.translate(0, 0.5, 0);
    this.hs = new Float32Array(W * W);
    this.queue = [];
    this.shown = [];
    this.root = new Node(-WORLD_HALF, -WORLD_HALF, WORLD_HALF * 2);
    this.build(this.root);
    this.chunkCount = 0;
  }

  build(node) {
    const { x0, z0, size } = node;
    const step = size / N, lod = step > 200 ? 1 : 0, hs = this.hs;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      hs[j * W + i] = height(x0 + (i - 1) * step, z0 + (j - 1) * step, lod);
    }
    const count = V * V + 4 * V;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
    const col = new Float32Array(count * 3), wat = new Float32Array(count);
    const half = size / 2, inv = 1 / (2 * step);
    let lo = 1e9, hi = -1e9;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const k = j * V + i, o = k * 3, c = (j + 1) * W + (i + 1);
      const h = hs[c];
      let nx = -(hs[c + 1] - hs[c - 1]) * inv, nz = -(hs[c + W] - hs[c - W]) * inv, ny = 1;
      const l = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nx *= l; ny *= l; nz *= l;
      const x = x0 + i * step, z = z0 + j * step;
      terrainColor(x, z, h, 1 - ny, col, o);
      let y = h;
      if (h <= 0) { y = 0; nx = 0; ny = 1; nz = 0; wat[k] = 1; }
      else { col[o] *= 0.8; col[o + 1] *= 0.8; col[o + 2] *= 0.8; }
      pos[o] = i * step - half; pos[o + 1] = y; pos[o + 2] = j * step - half;
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
    const skirt = size * 0.06 + 4;
    const edge = [(k) => k, (k) => N * V + k, (k) => k * V, (k) => k * V + N];
    for (let e = 0; e < 4; e++) for (let k = 0; k < V; k++) {
      const s = edge[e](k) * 3, d = (V * V + e * V + k) * 3;
      pos[d] = pos[s]; pos[d + 1] = pos[s + 1] - skirt; pos[d + 2] = pos[s + 2];
      nor[d] = nor[s]; nor[d + 1] = nor[s + 1]; nor[d + 2] = nor[s + 2];
      col[d] = col[s]; col[d + 1] = col[s + 1]; col[d + 2] = col[s + 2];
      wat[V * V + e * V + k] = wat[edge[e](k)];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aWater', new THREE.BufferAttribute(wat, 1));
    g.setIndex(this.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (lo + hi) / 2, 0),
      Math.hypot(half * 1.4143, (hi - lo) / 2 + skirt));
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(x0 + half, 0, z0 + half);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.visible = false;
    this.group.add(mesh);
    node.mesh = mesh; node.midY = (lo + hi) / 2;
    this.chunkCount++;
    if (size === TREE_SIZE && hi > 2) this.buildTrees(node, step);
  }

  buildTrees(node, step) {
    const { x0, z0, size } = node, hs = this.hs, half = size / 2;
    const cell = 36, n = Math.floor(size / cell);
    const rnd = mulberry32((x0 * 73856093) ^ (z0 * 19349663));
    const mats = [], cols = [];
    const m = new THREE.Matrix4();
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const lx = (i + rnd()) * cell, lz = (j + rnd()) * cell, r = rnd(), r2 = rnd();
      const fx = lx / step, fz = lz / step, ix = Math.min(N - 1, fx | 0), iz = Math.min(N - 1, fz | 0);
      const c = (iz + 1) * W + (ix + 1), u = fx - ix, v = fz - iz;
      const h = (hs[c] * (1 - u) + hs[c + 1] * u) * (1 - v) + (hs[c + W] * (1 - u) + hs[c + W + 1] * u) * v;
      if (h < 2.5) continue;
      const sx = (hs[c + 1] - hs[c]) / step, sz = (hs[c + W] - hs[c]) / step;
      const slope = 1 - 1 / Math.sqrt(1 + sx * sx + sz * sz);
      if (sx === 0 && sz === 0 && h > 5) continue; // graded airfield ground
      const f = forestDensity(x0 + lx, z0 + lz, h, slope);
      if (r > f * 0.9) continue;
      const ht = 10 + r2 * 13, wd = 5 + r2 * 4 + rnd() * 2;
      m.makeScale(wd, ht, wd).setPosition(lx - half, h - 0.6, lz - half);
      mats.push(...m.elements);
      const g = 0.75 + rnd() * 0.5;
      cols.push(0.07 * g, 0.2 * g + rnd() * 0.04, 0.085 * g);
    }
    const count = mats.length / 16;
    if (!count) return;
    const im = new THREE.InstancedMesh(this.treeGeo, this.treeMaterial, count);
    im.instanceMatrix.array.set(mats);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cols), 3);
    im.position.set(x0 + half, 0, z0 + half);
    im.matrixAutoUpdate = false; im.updateMatrix();
    im.frustumCulled = true;
    im.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, node.midY, 0), size);
    im.visible = false;
    this.group.add(im);
    node.trees = im;
  }

  dispose(node) {
    node.queued = false;
    if (node.children) { for (const c of node.children) this.dispose(c); node.children = null; }
    if (node.mesh) {
      this.group.remove(node.mesh); node.mesh.geometry.dispose(); node.mesh = null; this.chunkCount--;
    }
    if (node.trees) { this.group.remove(node.trees); node.trees.dispose(); node.trees = null; }
  }

  dist(node, cam) {
    const dx = Math.max(node.x0 - cam.x, 0, cam.x - (node.x0 + node.size));
    const dz = Math.max(node.z0 - cam.z, 0, cam.z - (node.z0 + node.size));
    const dy = cam.y - node.midY;
    return Math.sqrt(dx * dx + dz * dz + dy * dy);
  }

  visit(node, cam) {
    if (node.trees) { node.trees.visible = true; this.shown.push(node.trees); }
    const d = this.dist(node, cam);
    const want = node.size > MIN_SIZE && d < node.size * (node.children ? MERGE : SPLIT);
    if (want) {
      if (!node.children) {
        const h = node.size / 2;
        node.children = [new Node(node.x0, node.z0, h), new Node(node.x0 + h, node.z0, h),
          new Node(node.x0, node.z0 + h, h), new Node(node.x0 + h, node.z0 + h, h)];
      }
      let ready = true;
      for (const c of node.children) {
        if (!c.mesh) {
          ready = false;
          if (!c.queued) { c.queued = true; this.queue.push(c); }
          c.prio = this.dist(c, cam) / c.size;
        }
      }
      if (ready) {
        for (const c of node.children) this.visit(c, cam);
        return;
      }
    } else if (node.children) {
      for (const c of node.children) this.dispose(c);
      node.children = null;
    }
    node.mesh.visible = true; this.shown.push(node.mesh);
  }

  /** Refine around the camera. budgetMs caps mesh building per frame. */
  update(cam, budgetMs = 5) {
    for (const m of this.shown) m.visible = false;
    this.shown.length = 0;
    this.queue = this.queue.filter((n) => n.queued && !n.mesh);
    this.visit(this.root, cam);
    if (this.queue.length) {
      this.queue.sort((a, b) => a.prio - b.prio);
      const t0 = performance.now();
      let i = 0;
      while (i < this.queue.length && performance.now() - t0 < budgetMs) {
        const n = this.queue[i++];
        if (!n.queued) continue;
        n.queued = false;
        this.build(n);
      }
      this.queue.splice(0, i);
    }
    return this.queue.length;
  }

  /** Block until full detail is built around a point (used when spawning). */
  warm(cam) {
    for (let i = 0; i < 40; i++) if (this.update(cam, 60) === 0 && i > 10) break;
  }
}
