// Materials and surface detail for the cabin: tiling grain textures (cloth, vinyl, carpet, moulded plastic,
// perforated headliner) made once and shared by every variant, a material whose ambient light is dimmed by
// baked contact shading, box-projected texture coordinates, and the contact-shading bake itself.

import * as THREE from 'three';
import { canvas, clamp01, lerp, sstep } from './kit.js';

// ---------------------------------------------------------------- shared textures

const SHARED = new Map();
/** A texture made once and kept for every variant (disposeAircraft leaves these alone). */
export function shared(name, make) {
  if (!SHARED.has(name)) { const t = make(); t.userData.shared = true; SHARED.set(name, t); }
  return SHARED.get(name);
}

function rng(seed) { let s = seed * 9301 + 49297; return () => { s = (s * 233280 + 49297) % 2147483647; return s / 2147483647; }; }
/** Tileable value noise, S x S, `cells` lattice cells across. */
function tileNoise(S, cells, seed) {
  const r = rng(seed), lat = new Float32Array(cells * cells), out = new Float32Array(S * S);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x / S) * cells, fy = (y / S) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
    out[y * S + x] = lerp(lerp(lat[y0 * cells + x0], lat[y0 * cells + x1], sx), lerp(lat[y1 * cells + x0], lat[y1 * cells + x1], sx), sy);
  }
  return out;
}
/** Height field (0..1) of one grain, S x S, tileable. */
function grainHeight(kind, S) {
  const h = new Float32Array(S * S), r = rng(kind.length * 7 + 3);
  const n1 = tileNoise(S, 8, 11), n2 = tileNoise(S, 32, 12), n3 = tileNoise(S, 128, 13);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, u = x / S, v = y / S;
    if (kind === 'cloth') {            // a plain weave: warp and weft threads passing over and under
      const a = Math.sin(u * Math.PI * 2 * 48), b = Math.sin(v * Math.PI * 2 * 48), over = a * b > 0;
      h[i] = 0.5 + 0.28 * (over ? Math.abs(a) : -Math.abs(b) * 0.6) * (0.75 + 0.5 * n3[i]) + 0.12 * (n2[i] - 0.5);
    } else if (kind === 'vinyl') {     // pebbled leather grain
      const c = Math.abs(n2[i] - 0.5) * 2, d = Math.abs(n3[i] - 0.5) * 2;
      h[i] = 0.5 + 0.3 * (Math.min(c * 2.2, 1) - 0.6) + 0.14 * (d - 0.5) + 0.1 * (n1[i] - 0.5);
    } else if (kind === 'carpet') {    // loop pile: dense bright speckle over soft trodden patches
      h[i] = 0.2 + 0.6 * r() * (0.6 + 0.4 * n3[i]) + 0.25 * (n1[i] - 0.5);
    } else if (kind === 'perf') {      // perforated headliner: a grid of small holes
      const px = (u * 24) % 1 - 0.5, py = (v * 24) % 1 - 0.5;
      h[i] = 0.62 - 0.5 * (1 - sstep(0.1, 0.2, Math.hypot(px, py))) + 0.06 * (n3[i] - 0.5) + 0.05 * (n1[i] - 0.5);
    } else {                           // moulded plastic: fine stipple
      h[i] = 0.5 + 0.2 * (n3[i] - 0.5) + 0.12 * (r() - 0.5) + 0.06 * (n1[i] - 0.5);
    }
  }
  return h;
}
function grainTextures(kind) {
  const S = kind === 'cloth' || kind === 'carpet' ? 512 : 256, h = grainHeight(kind, S);
  const [cc, gc] = canvas(S, S), [nc, gn] = canvas(S, S), ci = gc.createImageData(S, S), ni = gn.createImageData(S, S);
  const str = { cloth: 2.6, vinyl: 1.5, carpet: 3.2, perf: 2.4, plastic: 1.1 }[kind] || 1.2;
  const depth = { cloth: 0.3, vinyl: 0.12, carpet: 0.55, perf: 0.5, plastic: 0.08 }[kind] || 0.1;   // how much the colour follows the height
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, o = i * 4;
    const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)], dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
    const nx = -dx * str, ny = dy * str, l = 1 / Math.hypot(nx, ny, 1);
    ni.data[o] = (nx * l * 0.5 + 0.5) * 255; ni.data[o + 1] = (ny * l * 0.5 + 0.5) * 255; ni.data[o + 2] = (l * 0.5 + 0.5) * 255; ni.data[o + 3] = 255;
    const c = 255 * clamp01(1 - depth + depth * 1.6 * h[i]);
    ci.data[o] = ci.data[o + 1] = ci.data[o + 2] = c; ci.data[o + 3] = 255;
  }
  gc.putImageData(ci, 0, 0); gn.putImageData(ni, 0, 0);
  const mk = (cv, srgb) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; return t; };
  return [mk(cc, true), mk(nc, false)];
}
/** Colour (a grey that multiplies the surface colour) and normal map of a tiling grain: 'cloth' | 'vinyl' | 'carpet' | 'perf' | 'plastic'. */
export function grain(kind) {
  if (!SHARED.has(kind + ':map')) { const [m, n] = grainTextures(kind); m.userData.shared = n.userData.shared = true; SHARED.set(kind + ':map', m); SHARED.set(kind + ':normal', n); }
  return { map: SHARED.get(kind + ':map'), normalMap: SHARED.get(kind + ':normal') };
}

// ---------------------------------------------------------------- materials

/**
 * A cabin surface. Like a standard material, but the light that reaches it from the sky and the ground is
 * scaled by the baked `ao` attribute (so corners and footwells are dark and nothing floats) and pulled
 * toward neutral, since what lights a cabin is its own pale lining more than the blue overhead.
 * Sunlight through the windows is untouched. Every geometry drawn with it needs an `ao` attribute (see bakeAO, flatAO).
 */
export function cabinMat(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.3, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float ao;\nvarying float vAo;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvAo = ao;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAo;').replace('#include <aomap_fragment>', `#include <aomap_fragment>
      { float cabL = dot(reflectedLight.indirectDiffuse, vec3(0.3, 0.55, 0.15));
        reflectedLight.indirectDiffuse = mix(vec3(cabL) * vec3(1.05, 1.0, 0.93), reflectedLight.indirectDiffuse, 0.35) * vAo * 1.7;
        reflectedLight.indirectSpecular *= vAo * vAo; }`);
  };
  m.customProgramCacheKey = () => 'cabin';
  return m;
}
/** A cabin material with one of the tiling grains; `scale` is the size of one tile in metres. */
export function grainMat(kind, tile, { bump = 1, ...opts } = {}) {
  const g = grain(kind), m = cabinMat({ ...g, normalScale: new THREE.Vector2(bump, bump), ...opts });
  m.userData.tile = tile;
  return m;
}

// ---------------------------------------------------------------- geometry finishing

/** Box-projected texture coordinates in metres / tile, chosen per triangle (the geometry must be non-indexed). */
export function boxUv(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = new Float32Array(p.count * 2), s = 1 / tile;
  for (let i = 0; i < p.count; i += 3) {
    const ax = Math.abs(n.getX(i) + n.getX(i + 1) + n.getX(i + 2)), ay = Math.abs(n.getY(i) + n.getY(i + 1) + n.getY(i + 2)), az = Math.abs(n.getZ(i) + n.getZ(i + 1) + n.getZ(i + 2));
    for (let k = i; k < i + 3; k++) {
      const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
      if (ax >= ay && ax >= az) { uv[k * 2] = z * s; uv[k * 2 + 1] = y * s; } else if (ay >= az) { uv[k * 2] = x * s; uv[k * 2 + 1] = z * s; } else { uv[k * 2] = x * s; uv[k * 2 + 1] = y * s; }
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Give a geometry one contact-shading value throughout. */
export function flatAO(geo, v = 1) {
  geo.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count).fill(v), 1));
  return geo;
}

/**
 * Bake soft contact shading into a geometry's `ao` attribute.
 *   boxes   occluders as [cx, cy, cz, hx, hy, hz] (centre, half-size): seats, people, the panel, the pedestal
 *   room    (x, y, z) -> 0..1, how open that part of the cabin is to the windows before any occluder
 * Each vertex is tested a little way out along its normal against every box, so a surface darkens where it
 * comes close to another: the seat on the floor, the body in the seat, the yoke shaft at the panel.
 */
export function bakeAO(geo, boxes, room, reach = 0.16) {
  const p = geo.attributes.position, n = geo.attributes.normal, ao = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), qx = x + n.getX(i) * 0.05, qy = y + n.getY(i) * 0.05, qz = z + n.getZ(i) * 0.05;
    let a = room ? room(x, y, z) : 1;
    for (const b of boxes) {
      const dx = Math.abs(qx - b[0]) - b[3], dy = Math.abs(qy - b[1]) - b[4], dz = Math.abs(qz - b[2]) - b[5];
      if (dx > reach || dy > reach || dz > reach) continue;
      const d = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
      a *= lerp(0.42, 1, sstep(-0.03, reach, d));
    }
    ao[i] = Math.max(a, 0.06);
  }
  geo.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
  return geo;
}
