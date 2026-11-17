// Towns and cities: a soft "built-up" tint in the terrain by day and a scatter of lights by night.
// The places are baked into public/data/towns.json by tools/fetch-towns.mjs (name, latitude, longitude,
// population): from OpenStreetMap in the United States, Canada and northern Mexico, places of 1,500 people
// and more, and from GeoNames in the rest of the world, places of 5,000 and more. A town's size on the ground
// is worked out from how many live there and how closely that part of the world builds (density).
// Only the towns inside the game's window of the world are kept, and they are laid out again when it moves.

import * as THREE from 'three';
import * as dem from './dem.js';
import { toWorld, WORLD_HALF } from './geo.js';
import { baseHeight, baseWater, isWater, setTownDensity, BN } from './terrain.js';
import { mulberry32 } from '../core/noise.js';

const DATA_URL = `${import.meta.env.BASE_URL}data/towns.json`;
/** The credit for the towns that are not OpenStreetMap's (tools/fetch-towns.mjs --geonames), for the title screen. */
export const TOWNS_ATTRIBUTION = 'Towns and cities beyond the United States, Canada and northern Mexico: GeoNames (geonames.org), CC BY 4.0';
const CN = 128;                       // coarse "is there a town about" grid (4 km cells)
const MAX_LIGHTS = 170000;

let ALL = [];                         // every town of the data: [name, lat, lon, population]
let TOWNS = [];                       // those in the window: { name, x, z, r, pop, lights }
let urban = new Float32Array(BN * BN), coarse = new Uint8Array(CN * CN);

/** Fetch the list of towns (once). The game runs without it: no tint, no lights. */
export async function loadTowns() {
  try {
    const r = await fetch(DATA_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json(), small = d.small || [];
    ALL = d.towns || [];
    // (the small places of the rest of the world come without names, as whole numbers: see the bake script)
    for (let i = 0; i + 2 < small.length; i += 3) ALL.push(['', small[i] / 1000, small[i + 1] / 1000, small[i + 2] * 100]);
  } catch (e) { console.warn('Towns could not be loaded:', e.message); ALL = []; }
}

/**
 * People to the square kilometer of built-up ground, by the part of the world: the suburbs of North America
 * (and of Australia and New Zealand) are the thinnest on earth, Europe builds more than twice as close, and
 * most of the rest of the world closer still.
 */
function density(lat, lon) {
  if (lon < -52 && lat >= 7) return 1100;
  if (lon > 110 && lat < -10) return 1400;
  if (lon > -30 && lon < 45 && lat > 35) return 2600;
  return 4200;
}

/**
 * Lay out the towns of the window of the world as it is now. Returns the built-up density (0..1) as a
 * BN x BN grid over the window, for the regional map.
 */
export function placeTowns() {
  TOWNS = [];
  urban = new Float32Array(BN * BN); coarse = new Uint8Array(CN * CN);
  const H = WORLD_HALF, cell = (2 * H) / (BN - 1);
  for (const [name, lat, lon, pop] of ALL) {
    const p = toWorld(lat, lon);
    // (about 1,100 people to the square kilometer in North America, suburbs and all)
    const r = Math.min(22000, Math.max(450, Math.sqrt(pop / (density(lat, lon) * Math.PI)) * 1000));
    if (Math.abs(p.x) > H + 2 * r || Math.abs(p.z) > H + 2 * r) continue;
    TOWNS.push({ name, x: p.x, z: p.z, r, pop, lights: 0, start: 0 });
    const rr = r * 1.15, reach = rr * 2, k2 = 1 / (0.5 * rr * rr);
    const i0 = Math.max(0, Math.floor((p.x - reach + H) / cell)), i1 = Math.min(BN - 1, Math.ceil((p.x + reach + H) / cell));
    const j0 = Math.max(0, Math.floor((p.z - reach + H) / cell)), j1 = Math.min(BN - 1, Math.ceil((p.z + reach + H) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = i * cell - H - p.x, dz = j * cell - H - p.z, d = Math.exp(-(dx * dx + dz * dz) * k2), k = j * BN + i;
      if (d > urban[k]) urban[k] = d;
    }
    const c = (2 * H) / CN, m = r * 2.3;
    for (let j = Math.max(0, Math.floor((p.z - m + H) / c)); j <= Math.min(CN - 1, Math.floor((p.z + m + H) / c)); j++)
      for (let i = Math.max(0, Math.floor((p.x - m + H) / c)); i <= Math.min(CN - 1, Math.floor((p.x + m + H) / c)); i++) coarse[j * CN + i] = 1;
  }
  return urban;
}

/** Built-up density (0..1) at a point. */
export function urbanDensity(x, z) {
  const fx = ((x + WORLD_HALF) / (2 * WORLD_HALF)) * (BN - 1), fz = ((z + WORLD_HALF) / (2 * WORLD_HALF)) * (BN - 1);
  if (!(fx >= 0 && fz >= 0 && fx < BN - 1 && fz < BN - 1)) return 0;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * BN + i;
  return (urban[k] * (1 - u) + urban[k + 1] * u) * (1 - v) + (urban[k + BN] * (1 - u) + urban[k + BN + 1] * u) * v;
}

setTownDensity(urbanDensity);

/** Does any town touch this rectangle? */
export function townsIn(x0, z0, x1, z1) {
  const c = (2 * WORLD_HALF) / CN;
  const i0 = Math.max(0, Math.floor((x0 + WORLD_HALF) / c)), i1 = Math.min(CN - 1, Math.floor((x1 + WORLD_HALF) / c));
  const j0 = Math.max(0, Math.floor((z0 + WORLD_HALF) / c)), j1 = Math.min(CN - 1, Math.floor((z1 + WORLD_HALF) / c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (coarse[j * CN + i]) return true;
  return false;
}

/** The towns of the window (for the chart). */
export const townList = () => TOWNS;
/** Every town of the data: [name, lat, lon, population], biggest first down to 30,000 people (for the map, which names no smaller ones). */
export const allTowns = () => ALL;

export class TownLights {
  constructor(scene) {
    this.scene = scene; this.points = null; this.t = 0; this.cursor = 0;
    this.material = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
    // Where the real buildings are drawn with their own lit windows (world/cities.js), these scattered lights
    // stand back, so the town is not lit twice: x, z of the camera, the radius the buildings reach, how much to dim.
    this.uYield = { value: new THREE.Vector4(0, 0, 1, 0) };
    this.material.onBeforeCompile = (sh) => {
      sh.uniforms.uCityYield = this.uYield;
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform vec4 uCityYield;\nvoid main() {')
        .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb *= 1.0 - uCityYield.w * (1.0 - smoothstep(0.75 * uCityYield.z, uCityYield.z, distance(position.xz, uCityYield.xy)));');
    };
    this.rebuild();
  }

  /** Scatter the lights of the towns laid out by placeTowns (again after the world has moved). */
  rebuild() {
    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
    const rnd = mulberry32(2024);
    let total = 0;
    for (const t of TOWNS) { t.lights = Math.round(Math.min(9000, Math.max(10, 4.5 * Math.sqrt(t.pop)))); total += t.lights; }
    const thin = Math.min(1, MAX_LIGHTS / Math.max(total, 1));
    total = 0;
    for (const t of TOWNS) { t.lights = Math.max(6, Math.round(t.lights * thin)); t.start = total; total += t.lights; }
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
    for (const t of TOWNS) {
      for (let i = 0; i < t.lights; i++) {
        // Denser toward the center, on the square street grid of an American town.
        const a = rnd() * 6.2832, rr = Math.pow(rnd(), 0.75) * t.r;
        let x = t.x + Math.cos(a) * rr, z = t.z + Math.sin(a) * rr;
        if (rnd() < 0.75) { const g = 100; if (rnd() < 0.5) x = Math.round(x / g) * g; else z = Math.round(z / g) * g; }
        const k = (t.start + i) * 3, warm = rnd();
        pos[k] = x; pos[k + 1] = baseWater(x, z) ? -500 : Math.max(baseHeight(x, z), 0) + 6; pos[k + 2] = z;      // none on the lake
        const b = 1.6 + rnd() * 2.2;
        col[k] = b; col[k + 1] = b * (0.62 + 0.3 * warm); col[k + 2] = b * (0.3 + 0.55 * warm * warm);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false; this.points.visible = false;
    this.scene.add(this.points);
    this.near = []; this.cursor = 0; this.t = 0;
  }

  /**
   * dark: 0 by day .. 1 at night. Lights near the camera are settled onto the fine terrain as it loads, a few thousand a frame.
   * cities: the layer of real buildings, if there is one (it says how far its lit houses reach and how many are in).
   */
  update(dt, dark, cam, exposure = 1, cities = null) {
    const on = dark > 0.03;
    this.points.visible = on;
    if (!on) return;
    if (cities) this.uYield.value.set(cam.x, cam.z, cities.R0, 0.5 * cities.nearShare()); else this.uYield.value.w = 0;
    this.material.opacity = Math.min(1, dark * 1.3);
    this.material.color.setScalar(1 / Math.sqrt(exposure));   // keep lights from burning out as the eye adapts
    if (!this.near.length) {
      if ((this.t -= dt) > 0) return;
      this.t = 2.5;
      for (const t of TOWNS) if (Math.hypot(t.x - cam.x, t.z - cam.z) < 26000 + t.r) this.near.push(t);
      this.cursor = 0;
      if (!this.near.length) return;
    }
    const p = this.points.geometry.attributes.position;
    let changed = false, budget = 2500;
    while (budget > 0 && this.near.length) {
      const t = this.near[this.near.length - 1], end = t.start + t.lights;
      let i = Math.max(this.cursor, t.start);
      for (; i < end && budget > 0; i++, budget--) {
        const x = p.getX(i), z = p.getZ(i);
        const y = isWater(x, z) ? -500 : dem.heightAt(x, z) + 6;
        if (Math.abs(y - p.getY(i)) > 0.5) { p.setY(i, y); changed = true; }
      }
      if (i >= end) { this.near.pop(); this.cursor = 0; } else this.cursor = i;
    }
    if (changed) p.needsUpdate = true;
  }
}
