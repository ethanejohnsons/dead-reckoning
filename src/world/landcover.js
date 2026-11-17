// Land cover: where the map says there are woods, and where it says the country is open (fields, pasture,
// prairie, marsh), as a top-down map around the camera that the trees and the terrain read.
//
// The satellite picture alone cannot tell a forest from a field of corn: from space in summer both are the same
// dark green, and the trees used to fill the farmland of the Midwest. This map can: it is drawn from Overture's
// base tiles (world/overture.js, zoom 12, about 7 km a tile), whose land cover is ESA WorldCover, with
// OpenStreetMap's woods and farmland on top of it where mapped (see landcover.worker.js for what counts).
//
// The map is a square of 2048 x 2048 texels, 18 m each (37 km: the trees reach 16 km at most), centered on the
// camera to the nearest kilometer and redrawn when that moves or a tile arrives. Red is woods, green is open; both
// can be 0 (built-up land, shrubland, water, or no data yet), and the picture decides there as it always has.
// Tiles are kept while they are on the map, and asked for again a while after a failure; if Overture cannot be
// reached at all the map stays empty and nothing changes.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { pixelX, pixelY, metersPerPixel } from './geo.js';

const Z = 12;                    // the zoom read (Overture's base tiles go to 13, five times the bytes for the same land)
const N = 2048, M = 18;          // texels across the map, meters a texel
const SNAP = 1024;               // the map's middle moves in steps of this (m)
const MAX_JOBS = 3;              // tiles being fetched at once

const hold = (k, v) => ENV[k] || (ENV[k] = { value: v });
hold('tLandCover', null); hold('uLandCover', new THREE.Vector4(0, 0, 1 / (N * M), 0));
export const LAND_COVER_UNIFORMS = ['tLandCover', 'uLandCover'];
/**
 * GLSL: landCover(worldXZ) -> (woods, open), each 0..1: how far the map says the ground here is woods, and how far
 * it is open country. (0, 0) where it says neither or nothing (and it fades to that at the edge of the map).
 */
export const LAND_COVER_GLSL = /* glsl */`
uniform sampler2D tLandCover;
uniform vec4 uLandCover;         // center x, center z, 1 / width (1/m), 1 when the map holds anything
vec2 landCover(vec2 xz) {
  vec2 q = (xz - uLandCover.xy) * uLandCover.z;
  float m = max(abs(q.x), abs(q.y));
  if (uLandCover.w < 0.5 || m > 0.495) return vec2(0.0);
  return textureLod(tLandCover, vec2(0.5 + q.x, 0.5 - q.y), 0.0).rg * (1.0 - smoothstep(0.45, 0.495, m));
}`;

const tmpC = new THREE.Color();

export class LandCover {
  constructor(renderer) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(N, N, { format: THREE.RGFormat, type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    ENV.tLandCover.value = this.rt.texture;
    this.cam = new THREE.OrthographicCamera(-N * M / 2, N * M / 2, N * M / 2, -N * M / 2, 1, 20000);
    this.cam.up.set(0, 0, -1);
    this.scene = new THREE.Scene(); this.scene.matrixWorldAutoUpdate = false;
    // the woods in red, the open country in green; where a place is both, both (the shaders let the woods win)
    const mat = (color) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation });
    this.woodsMat = mat(0xff0000); this.openMat = mat(0x00ff00);
    this.tiles = new Map();            // key -> { tx, ty, x0, z0, state: 'queued' | 'loading' | 'ready' | 'failed', meshes, retry, tries }
    this.jobs = new Map();             // id -> { t, gen }
    this.gen = 0; this.nextId = 1; this.planT = 0;
    this.mid = [1e12, 1e12]; this.dirty = false; this.drawT = 0;
    this.stats = { bytes: 0, fetched: 0, failed: 0, fetchMs: 0, buildMs: 0, tris: 0 };
    this.enabled = true; this.off = false;
    this.layout();
    this.worker = null;
    try {
      this.worker = new Worker(new URL('./landcover.worker.js', import.meta.url), { type: 'module', name: 'land cover' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => { console.warn('Land cover worker failed:', e.message); this.worker = null; };
    } catch (e) { console.warn('No land cover (no worker):', e.message); }
  }

  layout() { this.mpp = metersPerPixel(Z); this.size = 256 * this.mpp; this.px0 = pixelX(0, Z); this.py0 = pixelY(0, Z); }
  key(tx, ty) { return tx * 8192 + ty; }

  /** Tiles still to come (for the loading bar). */
  get pending() { let n = 0; for (const t of this.tiles.values()) if (t.state === 'queued' || t.state === 'loading') n++; return this.worker && !this.off ? n : 0; }

  /** Let go of everything: the window of the world has moved, and tile-local meters with it. */
  reset() {
    this.gen++;
    for (const t of this.tiles.values()) this.drop(t);
    this.tiles.clear(); this.jobs.clear();
    this.layout();
    this.planT = 0; this.mid = [1e12, 1e12]; this.dirty = true;
    ENV.uLandCover.value.w = 0;
  }

  drop(t) { for (const m of t.meshes) { m.geometry.dispose(); this.stats.tris -= m.userData.tris; } t.meshes = []; }

  /** Which tiles the map round (cx, cz) needs; drop the rest; ask for the nearest missing ones. */
  plan(cx, cz, now) {
    const half = N * M / 2, s = this.size;
    const i0 = Math.floor((this.px0 + (cx - half) / this.mpp) / 256), i1 = Math.floor((this.px0 + (cx + half) / this.mpp) / 256);
    const j0 = Math.floor((this.py0 + (cz - half) / this.mpp) / 256), j1 = Math.floor((this.py0 + (cz + half) / this.mpp) / 256);
    const want = new Set();
    for (let ty = j0; ty <= j1; ty++) for (let tx = i0; tx <= i1; tx++) {
      const k = this.key(tx, ty);
      want.add(k);
      if (!this.tiles.has(k)) this.tiles.set(k, { tx, ty, x0: (tx * 256 - this.px0) * this.mpp, z0: (ty * 256 - this.py0) * this.mpp, state: 'queued', meshes: [], retry: 0, tries: 0 });
    }
    for (const [k, t] of this.tiles) if (!want.has(k) && t.state !== 'loading') { if (t.meshes.length) this.dirty = true; this.drop(t); this.tiles.delete(k); }
    if (!this.worker || this.off) return;
    const free = MAX_JOBS - this.jobs.size;
    if (free <= 0) return;
    const queue = [];
    for (const t of this.tiles.values()) if (t.state === 'queued' || (t.state === 'failed' && now > t.retry)) queue.push([Math.hypot(t.x0 + s / 2 - cx, t.z0 + s / 2 - cz), t]);
    queue.sort((a, b) => a[0] - b[0]);
    for (const [, t] of queue.slice(0, free)) {
      const id = this.nextId++;
      t.state = 'loading';
      this.jobs.set(id, { t, gen: this.gen });
      this.worker.postMessage({ type: 'tile', id, z: Z, x: t.tx, y: t.ty, size: s });
    }
  }

  onMessage(m) {
    const job = this.jobs.get(m.id);
    if (!job) return;
    this.jobs.delete(m.id);
    if (job.gen !== this.gen) return;
    const t = job.t;
    if (!this.tiles.has(this.key(t.tx, t.ty))) return;
    if (m.type === 'failed') {
      this.stats.failed++;
      t.state = 'failed'; t.tries++; t.retry = performance.now() + Math.min(120000, 5000 * 2 ** t.tries);
      if (m.off && !this.off) { this.off = true; this.offUntil = performance.now() + 60000; console.warn('Land cover could not be fetched (' + m.error + '): the trees follow the satellite picture alone for now.'); }
      return;
    }
    const s = this.stats;
    s.bytes += m.bytes; s.fetched++; s.fetchMs += m.ms.fetch; s.buildMs += m.ms.build;
    t.state = 'ready';
    for (const [data, mat] of [[m.forest, this.woodsMat], [m.open, this.openMat]]) {
      if (!data) continue;
      const n = data.pos.length / 2, p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { p[i * 3] = t.x0 + data.pos[2 * i]; p[i * 3 + 2] = t.z0 + data.pos[2 * i + 1]; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setIndex(new THREE.BufferAttribute(data.idx, 1));
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.userData.tris = data.idx.length / 3; s.tris += mesh.userData.tris;
      t.meshes.push(mesh);
    }
    if (t.meshes.length) this.dirty = true;
  }

  /** Draw the map again round the camera's place. */
  draw(cx, cz) {
    const r = this.renderer, c = this.cam, list = [];
    for (const t of this.tiles.values()) for (const m of t.meshes) list.push(m);
    c.position.set(cx, 12000, cz); c.lookAt(cx, 0, cz); c.updateMatrixWorld();
    const prev = r.getRenderTarget(), alpha = r.getClearAlpha(), auto = r.autoClear, sAuto = r.shadowMap.autoUpdate;
    r.getClearColor(tmpC); r.setClearColor(0x000000, 0); r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    this.scene.children = list;
    r.setRenderTarget(this.rt); r.render(this.scene, c);
    this.scene.children = [];
    r.autoClear = auto; r.shadowMap.autoUpdate = sAuto; r.setClearColor(tmpC, alpha); r.setRenderTarget(prev);
    ENV.uLandCover.value.set(cx, cz, 1 / (N * M), list.length && this.enabled ? 1 : 0);
  }

  /** Once a frame: plan a few times a second, redraw when the map's middle has moved or a tile has come or gone. */
  update(cam) {
    const now = performance.now();
    if (this.off && now > this.offUntil) this.off = false;            // (try Overture again now and then)
    const cx = Math.round(cam.x / SNAP) * SNAP, cz = Math.round(cam.z / SNAP) * SNAP;
    if (cx !== this.mid[0] || cz !== this.mid[1]) { this.dirty = true; this.planT = 0; }
    if (now > this.planT) { this.planT = now + 300; this.plan(cx, cz, now); }
    if (!this.dirty || now < this.drawT) return;
    this.drawT = now + 250; this.dirty = false; this.mid = [cx, cz];
    this.draw(cx, cz);
  }

  /** Switch the map's say off (or on again), for comparing in the debug tools. */
  setEnabled(on) { this.enabled = on; this.dirty = true; this.drawT = 0; }
}
