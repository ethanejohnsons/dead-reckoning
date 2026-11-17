// Trees. A handful of tree models per species are grown at boot (trunk, limbs,
// and foliage as clusters of leaf cards cut from a drawn leaf texture) and each
// is photographed from 32 directions into an impostor atlas: brightness, bark
// mask, ambient occlusion and coverage in one texture, surface normal and depth
// in the other. In flight almost every tree is one camera-facing card that shows
// the nearest of those views and is lit per pixel from the baked normal and
// depth; the few trees close to the camera are drawn as the real meshes, lit by
// the same code. The shade the trees throw on the ground is drawn from above into
// maps fixed to the ground, which every ground shader reads (see SHADE_VERT below).
//
// Where a tree stands is decided twice. The terrain patch proposes candidates
// (position, species, size) from height, slope, moisture and noise; the vertex
// shader then keeps a candidate only where the satellite picture is dark and
// green, or, where no picture has loaded, where the vegetation rules would grow
// one.
//
// Everything about a tree changes smoothly with distance, so nothing pops in flight:
//   - fewer trees are drawn far away (treeKeep), and each one left stands for its lost neighbors: it grows a
//     little taller and its card widens to show several crowns side by side (treeSize);
//   - the real mesh and its card swap through a per-pixel dissolve across a band of distance;
//   - the baked views cross-fade in both compass direction and height;
//   - as a card shrinks toward a few pixels it is read from ever coarser mip levels of the atlas, down to one
//     texel a view, and its coverage goes from a crisp silhouette to a soft share: a far forest is a stable
//     textured canopy, not a field of sparkling points;
//   - beyond HAND meters the terrain's fine patches hand each tree over to the far tiles kept here: the same
//     candidates (first FAR_POOL of every patch's list), standing on the terrain as it is drawn out there,
//     blended instead of cut out, and fading into the picture at the tier's range.

import * as THREE from 'three';
import { mulberry32, smoothstep, clamp } from '../core/noise.js';
import { ENV } from '../core/env.js';
import * as dem from './dem.js';
import { LAND_HALF, WORLD_HALF, metersPerPixel } from './geo.js';
import { flatWeight, flatsIn, applyFlats, treeline, oceanWoods, moisture } from './terrain.js';
import { townsIn, urbanDensity } from './towns.js';
import { SKY_SH_GLSL } from './atmosphere.js';
import { BUILDING_COVER_GLSL } from './cities.js';
import { TREE_SHADE_LEVELS } from './groundlight.js';
// Where the trees stand is worked out in a worker (treeplace.js, through workers.js); here they are only
// handed to the graphics card, as the shared upload budget allows.
import { REGION } from './geo.js';
import { placeFar, candidates } from './treeplace.js';
import { buffersOf } from './patchbuild.js';
import { pool } from './workers.js';
import { uploads } from '../render/budget.js';
import { perf } from '../render/perf.js';

const NV = 16;                       // tree models
const NA = 8, NE = 4;                // views per model: compass directions x heights above the horizon
const ELS = [6, 30, 55, 82];         // those heights, degrees
const CELL = 9.5;                    // spacing of candidate positions, m
const GRID = 16;                     // each patch indexes its trees in GRID x GRID squares for the near-mesh search
const NEAR_CAP = 1024;               // most real meshes of one model at a time
const FIT = 1.06;                    // margin around a model in its atlas frame
const PATCH = 1024;                  // the terrain patches that propose trees, m
const HAND = 4000, HAND_BAND = 250, HAND_JIT = 600;   // fine patches hand over to the far tiles here (m), each tree at its own distance
const FAR_SIZE = 2048;               // far tiles, m: four patches each
const FAR_POOL = 0.09;               // share of every patch's candidates a far tile holds (those still drawn at HAND)
const FADE_IN = 0.8;                 // seconds a newly built patch or tile takes to appear
const SPLIT = 2.3;                   // the terrain draws a patch of size s out to about SPLIT * 2 s (see chunks.js)

// Quality tiers: share of candidates used, impostor frame size, how far out the real meshes and ground shadows go,
// where thinning starts and how fast it goes (m), and where the trees end (m).
const TIERS = {
  low: { density: 0.4, frame: 64, near: 0, decal: 900, thin: [500, 700], range: 5500 },
  med: { density: 0.7, frame: 96, near: 110, decal: 1700, thin: [600, 800], range: 8500 },
  high: { density: 1, frame: 128, near: 170, decal: 2600, thin: [700, 850], range: 13000 },
  ultra: { density: 1, frame: 128, near: 200, decal: 3200, thin: [850, 1000], range: 16000 },
};
// What the trees keep of their light at the foot and at the top of the crown, in place of screen-space occlusion.
const OCC = [0.52, 0.95];
// The terrain shader darkens woodland in the picture, for the shade under the trees, out to the first of these
// distances, fading by the second (chunks.js: the line that scales `photo` by woodsP). The far trees brighten to match.
const GROUND_SHADE = [3500, 9000];
const NEAR_BAND = 55;                // the mesh and its card dissolve into each other over this many meters
// The maps of the trees' shade: texels across each (by quality tier), and half the width of the innermost (m).
// The outermost reaches as far as the tier's shadows go; the ones between are spaced evenly by ratio.
const SHADE_N = { low: 512, med: 1024, high: 2048, ultra: 2048 }, SHADE_INNER = 128;
const SHADE_REACH = 160;             // a tree this far outside a map can still throw shade into it (m)
const SHADE_MIPS = 4;                // smaller copies kept of each map, each half the one before (down to a sixteenth)

// ---------------------------------------------------------------- leaf texture

/**
 * Four foliage cards on one canvas: a spray of small leaves, a spray of larger leaves,
 * a conifer bough (base at the left edge) and hanging strands (hung from the top edge).
 * r: brightness, g: twig, a: coverage. Uploaded premultiplied so its mipmaps average correctly.
 */
function makeLeafTexture() {
  const T = 256, c = document.createElement('canvas'); c.width = c.height = 2 * T;
  const g = c.getContext('2d'), rnd = mulberry32(4242), r = (a, b) => a + (b - a) * rnd();
  const gray = (lum, twig = 0) => `rgb(${Math.round(clamp(lum, 0, 1) * 255)},${twig ? 255 : 0},0)`;
  const leaf = (x, y, ang, len, wid, lum) => {
    g.fillStyle = gray(lum); g.beginPath();
    g.ellipse(x + Math.cos(ang) * len * 0.5, y + Math.sin(ang) * len * 0.5, len * 0.5, wid * 0.5, ang, 0, 6.2832); g.fill();
  };
  const twig = (x0, y0, x1, y1, w) => { g.strokeStyle = gray(0.5, 1); g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  const tile = (i, fn) => { g.save(); g.beginPath(); g.rect((i % 2) * T + 3, (i >> 1) * T + 3, T - 6, T - 6); g.clip(); g.translate((i % 2) * T, (i >> 1) * T); fn(); g.restore(); };

  // A spray is built in three sizes so that it still has a shape when it is small on screen: a handful of
  // sub-sprays with open gaps between them, each a twig with side twigs, each of those lined with leaves.
  const spray = (subs, len) => {
    const cx = T / 2, cy = T / 2;
    for (let i = 0; i < subs; i++) {
      const a = ((i + r(-0.4, 0.4)) / subs) * 6.2832, L = T * r(0.22, 0.45), bright = r(0.45, 1);
      const sx = cx + Math.cos(a) * T * 0.03, sy = cy + Math.sin(a) * T * 0.03;
      const twigs = [[sx, sy, sx + Math.cos(a) * L, sy + Math.sin(a) * L, a]];
      for (let k = 0, n = 2 + ((rnd() * 3) | 0); k < n; k++) {
        const t = r(0.25, 0.8), b = a + (rnd() < 0.5 ? 1 : -1) * r(0.45, 0.95), l2 = L * r(0.3, 0.55), px = sx + Math.cos(a) * L * t, py = sy + Math.sin(a) * L * t;
        twigs.push([px, py, px + Math.cos(b) * l2, py + Math.sin(b) * l2, b]);
      }
      for (const [x0, y0, x1, y1, b] of twigs) {
        twig(x0, y0, x1, y1, 1.8);
        const Lt = Math.hypot(x1 - x0, y1 - y0);
        for (let t = 0.12; t < 1.05; t += (len / Lt) * r(0.3, 0.5)) {
          for (const side of [-1, 1]) leaf(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, b + side * r(0.45, 1.1), len * r(0.8, 1.3), len * r(0.4, 0.55), bright * (0.65 + 0.35 * rnd()) * (0.7 + 0.3 * t));
        }
      }
    }
  };
  const bough = () => {
    const needle = (x, y, a, len, lum) => { g.strokeStyle = gray(lum); g.lineWidth = r(1.4, 2.4); g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke(); };
    const shoot = (x0, y0, a, L, depth) => {
      const x1 = x0 + Math.cos(a) * L, y1 = y0 + Math.sin(a) * L;
      twig(x0, y0, x1, y1, depth ? 1.3 : 2.6);
      if (depth < 2) {
        let side = rnd() < 0.5 ? 1 : -1;
        for (let s = depth ? 0.25 : 0.1; s < 0.93; s += r(0.05, 0.09) * (depth ? 2.4 : 1)) {
          const sub = L * (depth ? 0.34 : 0.43) * Math.sin(Math.PI * Math.pow(0.08 + 0.92 * s, 0.75)) * r(0.75, 1.1);
          shoot(x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, a + side * r(0.75, 1.05), sub, depth + 1);
          side = -side;
        }
      }
      for (let s = 0.03; s < 1; s += 3 / Math.max(L, 3)) {
        const px = x0 + (x1 - x0) * s, py = y0 + (y1 - y0) * s;
        needle(px, py, a + r(0.45, 1.0), T * r(0.028, 0.05), 0.4 + 0.6 * rnd());
        needle(px, py, a - r(0.45, 1.0), T * r(0.028, 0.05), 0.4 + 0.6 * rnd());
      }
      for (let k = 0; k < 7; k++) needle(x1, y1, a + r(-1.1, 1.1), T * r(0.03, 0.055), 0.55 + 0.45 * rnd());
    };
    shoot(T * 0.03, T * 0.5, r(-0.03, 0.03), T * 0.92, 0);
  };
  const strands = () => {
    for (let i = 0; i < 13; i++) {
      const x = T * (0.1 + (0.8 * (i + r(-0.3, 0.3))) / 12), y = T * r(0.05, 0.3), L = T * r(0.5, 0.9) - y * 0.4, sway = r(-0.22, 0.22);
      for (let k = 0; k < 16; k++) leaf(x + r(-11, 11), y + r(-11, 11), r(0, 6.2832), T * r(0.03, 0.05), T * 0.017, 0.45 + 0.55 * rnd());
      let px = x, py = y;
      for (let s = 0; s < L; s += 4) {
        const nx = x + Math.sin(s * 0.03 + i) * 5 + sway * s, ny = y + s;
        if (ny > T - 8) break;
        twig(px, py, nx, ny, 1.1);
        for (const side of [-1, 1]) if (rnd() < 0.9) leaf(nx, ny, Math.PI / 2 + side * r(0.25, 0.75), T * r(0.035, 0.055), T * r(0.013, 0.02), 0.45 + 0.55 * rnd());
        px = nx; py = ny;
      }
    }
  };
  tile(0, () => spray(8, T * 0.044));
  tile(1, () => spray(6, T * 0.078));
  tile(2, bough);
  tile(3, strands);

  const t = new THREE.CanvasTexture(c);
  t.premultiplyAlpha = true; t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- tree models

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Directions spread evenly over the sphere, for measuring how much of its surroundings a point inside a crown can see.
const SKY = Array.from({ length: 24 }, (_, i) => { const y = 1 - (2 * (i + 0.5)) / 24, r = Math.sqrt(1 - y * y), a = i * 2.39996; return [r * Math.cos(a), y, r * Math.sin(a)]; });

/** Collects the triangles of one tree. Vertex extras: how open the point is (see sky), brightness, bark (1) or foliage (0). */
class Builder {
  constructor(seed) {
    this.rnd = mulberry32(seed);
    this.P = []; this.N = []; this.UV = []; this.A = []; this.I = [];
    this.lobes = [];                     // foliage masses as ellipsoids [cx, cy, cz, rx, ry, rz]
    this.dense = 0.3;                    // how fast light dies inside a mass, per meter
  }
  r(a = 0, b = 1) { return a + (b - a) * this.rnd(); }
  dir() { const y = this.r(-1, 1), a = this.r(0, 6.2832), s = Math.sqrt(1 - y * y); return [s * Math.cos(a), y, s * Math.sin(a)]; }
  vert(p, n, u, v, open, lum, bark) { this.P.push(p[0], p[1], p[2]); this.N.push(n[0], n[1], n[2]); this.UV.push(u, v); this.A.push(open, lum, bark); return this.P.length / 3 - 1; }

  /**
   * What a point sees through the foliage masses around it: n, the middle of the open directions (a "bent normal"),
   * and open, the share of all directions that are clear: 0.5 on the surface of a mass, less inside or beneath one.
   */
  sky(p) {
    let sx = 0, sy = 0, sz = 0, open = 0;
    for (const d of SKY) {
      let path = 0;
      for (const l of this.lobes) {
        const qx = (p[0] - l[0]) / l[3], qy = (p[1] - l[1]) / l[4], qz = (p[2] - l[2]) / l[5], mx = d[0] / l[3], my = d[1] / l[4], mz = d[2] / l[5];
        // the solid heart of a mass lies a little inside its leafy surface (0.72 = 0.85 squared)
        const a = mx * mx + my * my + mz * mz, b = qx * mx + qy * my + qz * mz, disk = b * b - a * (qx * qx + qy * qy + qz * qz - 0.72);
        if (disk <= 0) continue;
        const root = Math.sqrt(disk);
        path += Math.max((-b + root) / a, 0) - Math.max((-b - root) / a, 0);
      }
      const T = Math.exp(-this.dense * path), w = d[1] < 0 ? T * 0.45 : T;      // the ground gives less light than the sky
      open += T; sx += d[0] * w; sy += d[1] * w; sz += d[2] * w;
    }
    return { n: norm([sx, sy, sz]), open: open / SKY.length };
  }

  /** A tapered limb from a to b. */
  limb(a, b, ra, rb, sides = 5) {
    const ax = norm(sub(b, a)), s1 = norm(cross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), s2 = cross(ax, s1);
    const base = this.P.length / 3, lum = this.r(0.8, 1.1);
    for (let k = 0; k < 2; k++) {
      const open = Math.min(this.sky(k ? b : a).open * 1.25, 1);
      for (let i = 0; i < sides; i++) {
        const t = (i / sides) * 6.2832, n = add(mul(s1, Math.cos(t)), mul(s2, Math.sin(t)));
        this.vert(add(k ? b : a, mul(n, k ? rb : ra)), n, 0.01, 0.01, open, lum * (0.85 + 0.3 * ((i * 7) % 3) / 2), 1);
      }
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.I.push(base + i, base + sides + i, base + j, base + j, base + sides + i, base + sides + j);
    }
  }

  /** One foliage card: center c, half-axes U and V, a tile of the leaf texture. shade gives each corner [normal, openness]. */
  card(c, U, V, tile, shade, lum = 1) {
    const flip = tile < 2 && this.rnd() < 0.5, u0 = (tile % 2) * 0.5, v0 = 1 - ((tile >> 1) + 1) * 0.5, m = 0.012;
    const idx = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [c[0] + U[0] * sx + V[0] * sy, c[1] + U[1] * sx + V[1] * sy, c[2] + U[2] * sx + V[2] * sy];
      const fu = flip ? 1 - (sx + 1) / 2 : (sx + 1) / 2, sh = shade(p);
      idx.push(this.vert(p, sh, u0 + m + fu * (0.5 - 2 * m), v0 + m + ((sy + 1) / 2) * (0.5 - 2 * m), sh[3], lum, 0));
    }
    this.I.push(idx[0], idx[1], idx[2], idx[0], idx[2], idx[3]);
  }

  /**
   * A clump of foliage: several cards through one point at different angles.
   * o.flat tips them toward horizontal layers, o.star adds conifer boughs laid out from the center,
   * o.hang drops strands below it.
   */
  cluster(c, cr, o) {
    // The clump takes its light from where it sits in the crown; each corner leans out from the clump's center,
    // so the crown has a lit side and every clump on it a highlight.
    // Each card also keeps a little of its own facing, so the cards of a clump catch the light differently.
    const s = this.sky(c);
    const shader = (cn) => {
      const k = (cn[0] * s.n[0] + cn[1] * s.n[1] + cn[2] * s.n[2] < 0 ? -1 : 1) * 0.4;
      return (p) => {
        const out = norm(sub(p, c)), n = norm([s.n[0] + out[0] * 0.6 + cn[0] * k, s.n[1] + out[1] * 0.6 + cn[1] * k, s.n[2] + out[2] * 0.6 + cn[2] * k]);
        const face = out[0] * s.n[0] + out[1] * s.n[1] + out[2] * s.n[2];
        return [n[0], n[1], n[2], clamp(s.open * 1.25 * (0.85 + 0.4 * face), 0, 1)];
      };
    };
    const lum = this.r(0.74, 1.18);
    for (let k = 0; k < (o.star || 0); k++) {
      // a conifer bough laid out from the center of the clump
      const a = ((k + this.r(-0.3, 0.3)) / o.star) * 6.2832, tilt = this.r(-0.3, 0.5);
      const d = norm([Math.cos(a), tilt, Math.sin(a)]), side = norm(cross(d, [0, 1, 0])), roll = this.r(-0.6, 0.6);
      const V = add(mul(side, Math.cos(roll)), mul(cross(side, d), Math.sin(roll)));
      const L = cr * this.r(0.95, 1.35);
      this.card(add(c, mul(d, L * 0.5)), mul(d, L * 0.56), mul(V, L * 0.44), 2, shader(cross(d, V)), lum * this.r(0.9, 1.1));
    }
    for (let k = 0; k < (o.cards ?? 4); k++) {
      const off = mul(this.dir(), cr * 0.22);
      let n = this.dir();
      if (o.flat) n = norm([n[0] * (1 - o.flat), n[1] + (n[1] < 0 ? -1 : 1) * o.flat * 1.6, n[2] * (1 - o.flat)]);
      if (o.upright) n = norm([n[0], n[1] * (1 - o.upright), n[2]]);
      let U = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), V = cross(n, U);
      if (!o.upright) { const t = this.r(0, 6.2832), cs = Math.cos(t), sn = Math.sin(t); [U, V] = [add(mul(U, cs), mul(V, sn)), add(mul(V, cs), mul(U, -sn))]; }
      const hw = cr * this.r(0.9, 1.25), hh = cr * this.r(0.9, 1.25) * (o.tall || 1);
      this.card(add(c, off), mul(U, hw), mul(V, hh), o.tile || 0, shader(n), lum * this.r(0.9, 1.1));
    }
    for (let k = 0; k < (o.hang || 0); k++) {
      const a = this.r(0, 6.2832), U = [Math.cos(a), 0, Math.sin(a)], hh = o.hangLen * this.r(0.75, 1.2);
      const top = add(c, [this.r(-0.3, 0.3) * cr, cr * 0.35, this.r(-0.3, 0.3) * cr]);
      this.card(add(top, [0, -hh, 0]), mul(U, cr * this.r(0.85, 1.2)), [0, hh, 0], 3, shader([-U[2], 0, U[0]]), lum * this.r(0.9, 1.1));
    }
  }
}

/** A tree whose crown is a group of rounded masses: every broadleaf here, and the old conifers. */
function lobed(seed, o) {
  const B = new Builder(seed), H = o.H;
  const lobes = o.lobes(B, H);
  B.lobes = lobes; B.dense = o.dense || 0.3;
  // trunk: three slightly bent lengths, flared at the foot
  const topY = H * (o.trunkTop || 0.7), tr = o.trunkR;
  const k1 = [B.r(-1, 1) * tr * 0.8, topY * 0.4, B.r(-1, 1) * tr * 0.8], k2 = [B.r(-1, 1) * tr * 1.5, topY * 0.75, B.r(-1, 1) * tr * 1.5], k3 = [k2[0] * 1.2, topY, k2[2] * 1.2];
  if (!o.stems) {
    B.limb([0, -0.6, 0], k1, tr * 1.3, tr * 0.9, 7); B.limb(k1, k2, tr * 0.9, tr * 0.62, 6); B.limb(k2, k3, tr * 0.62, tr * 0.25, 5);
  }
  const trunkAt = (y) => { const t = clamp(y / topY, 0, 1); return t < 0.4 ? mul(k1, t / 0.4) : t < 0.75 ? add(k1, mul(sub(k2, k1), (t - 0.4) / 0.35)) : add(k2, mul(sub(k3, k2), (t - 0.75) / 0.25)); };
  lobes.forEach((l, li) => {
    const c = [l[0], l[1], l[2]], reach = Math.hypot(l[0], l[2]);
    // a limb carries each mass: from the trunk, or from the ground for a many-stemmed shrub
    const from = o.stems ? [l[0] * 0.15, -0.4, l[2] * 0.15] : trunkAt(Math.max(l[1] - reach * 0.75 - l[4] * 0.3, H * 0.12));
    const mid = add(mul(add(from, c), 0.5), [0, reach * 0.12, 0]), lr = tr * (o.stems ? 0.5 : 0.36);
    B.limb(from, mid, lr, lr * 0.7, 5); B.limb(mid, c, lr * 0.7, lr * 0.3, 4);
    for (let i = 0; i < o.per; i++) {
      for (let tries = 0; tries < 4; tries++) {
        const d = B.dir(); d[1] = Math.abs(d[1]) * 1.25 - 0.3; const dn = norm(d), k = B.r(0.7, 1.0);
        const p = [c[0] + dn[0] * l[3] * k, c[1] + dn[1] * l[4] * k, c[2] + dn[2] * l[5] * k];
        let buried = false;
        for (let m = 0; m < lobes.length && !buried; m++) if (m !== li) { const q = lobes[m]; buried = ((p[0] - q[0]) / q[3]) ** 2 + ((p[1] - q[1]) / q[4]) ** 2 + ((p[2] - q[2]) / q[5]) ** 2 < 0.5; }
        if (buried && tries < 3) continue;
        B.cluster(p, o.cr * H * B.r(0.8, 1.25), o.leaf);
        // a twig out to the clump, where the crown is open enough to see it
        if (o.twigs && B.rnd() < o.twigs) B.limb(c, p, lr * 0.22, lr * 0.08, 3);
        break;
      }
    }
  });
  return B;
}

/** A conifer with a single leader and whorls of boughs. */
function whorled(seed, o) {
  const B = new Builder(seed), H = o.H;
  const reach = (t) => H * o.spread * Math.pow(Math.max(1 - (t - o.base) / (1 - o.base), 0), o.pow) + 0.3;
  // for the light, the crown is a stack of disks narrowing to the tip
  B.lobes = Array.from({ length: 6 }, (_, k) => { const t = o.base + ((1 - o.base) * (k + 0.5)) / 6, r = reach(t) * 0.8; return [0, t * H, 0, r, (((1 - o.base) * H) / 6) * 0.9, r]; });
  B.dense = o.dense || 0.4;
  B.limb([0, -0.6, 0], [0, H * 0.5, 0], o.trunkR * 1.15, o.trunkR * 0.6, 7);
  B.limb([0, H * 0.5, 0], [0, H * 0.97, 0], o.trunkR * 0.6, 0.04, 5);
  const shade = (p) => {
    const s = B.sky(p), rr = Math.hypot(p[0], p[2]) || 1, n = norm([s.n[0] + (p[0] / rr) * 0.45, s.n[1] + 0.25, s.n[2] + (p[2] / rr) * 0.45]);
    return [n[0], n[1], n[2], Math.min(s.open * 1.25, 1)];
  };
  for (let t = o.base; t < 0.965; t += o.step * B.r(0.8, 1.2)) {
    const y = t * H, n = o.per + (B.rnd() < 0.4 ? 1 : 0), a0 = B.r(0, 6.2832), Lw = reach(t);
    for (let i = 0; i < n; i++) {
      if (B.rnd() < (o.gaps || 0)) continue;                      // a lost bough leaves a gap
      const a = a0 + (i / n) * 6.2832 + B.r(-0.3, 0.3), rise = o.rise + B.r(-0.2, 0.2), L = Lw * B.r(0.7, 1.15);
      const d = norm([Math.cos(a) * Math.cos(rise), Math.sin(rise), Math.sin(a) * Math.cos(rise)]), side = [-Math.sin(a), 0, Math.cos(a)], up = cross(side, d);
      const c = add([0, y + B.r(-0.4, 0.4) * o.step * H, 0], mul(d, L * 0.5)), lum = B.r(0.78, 1.15);
      B.card(c, mul(d, L * 0.52), mul(side, L * o.width), 2, shade, lum);
      B.card(add(c, mul(up, L * 0.05)), mul(d, L * 0.52), mul(up, L * o.width * 0.6), 2, shade, lum * 0.92);
    }
  }
  // the leader
  for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI + B.r(0, 0.4); B.card([0, H * 0.93, 0], [Math.cos(a) * H * 0.05, 0, Math.sin(a) * H * 0.05], [0, H * 0.085, 0], 0, shade); }
  return B;
}

const ring = (B, H, n, y0, y1, d0, d1, rx, ry) => Array.from({ length: n }, (_, i) => {
  const a = ((i + B.r(-0.3, 0.3)) / n) * 6.2832, d = H * B.r(d0, d1), k = B.r(0.85, 1.18);
  return [Math.cos(a) * d, H * B.r(y0, y1), Math.sin(a) * d, H * rx * k, H * ry * B.r(0.9, 1.1), H * rx * k];
});

// leaf and bark colors are linear albedo; tint is how far the foliage follows the color of the picture under it;
// dense is how fast light dies inside the crown's masses (per meter); fall and fall2, on the trees that lose their
// leaves, the two colors they turn (each tree takes one, see treeLeaf).
const SPECIES = [
  // 0-2 broadleaved forest trees (oak, maple, ash): tiers of fine foliage, very dark; the third is the tall, high-crowned forest form
  { leaf: [0.068, 0.112, 0.036], bark: [0.085, 0.075, 0.06], tint: 0.6, fall: [0.34, 0.11, 0.03], fall2: [0.42, 0.19, 0.04],
    make: () => lobed(11, { dense: 0.28, H: 21, trunkR: 0.34, trunkTop: 0.72, cr: 0.095, per: 11, twigs: 0.2, leaf: { cards: 5, flat: 0.3, tile: 0 },
      lobes: (B, H) => [[B.r(-1, 1), H * 0.77, B.r(-1, 1), H * 0.2, H * 0.17, H * 0.2], ...ring(B, H, 5, 0.45, 0.66, 0.14, 0.21, 0.18, 0.15)] }) },
  { leaf: [0.063, 0.106, 0.037], bark: [0.085, 0.075, 0.06], tint: 0.6, fall: [0.42, 0.08, 0.03], fall2: [0.52, 0.23, 0.03],
    make: () => lobed(12, { dense: 0.28, H: 18, trunkR: 0.3, trunkTop: 0.7, cr: 0.1, per: 11, twigs: 0.2, leaf: { cards: 5, flat: 0.3, tile: 0 },
      lobes: (B, H) => [[H * 0.07, H * 0.79, -H * 0.03, H * 0.2, H * 0.16, H * 0.2], [-H * 0.12, H * 0.68, H * 0.08, H * 0.18, H * 0.15, H * 0.18], ...ring(B, H, 4, 0.42, 0.6, 0.18, 0.25, 0.19, 0.155)] }) },
  { leaf: [0.070, 0.110, 0.034], bark: [0.09, 0.08, 0.065], tint: 0.6, fall: [0.46, 0.31, 0.04], fall2: [0.30, 0.09, 0.06],
    make: () => lobed(13, { dense: 0.28, H: 25, trunkR: 0.36, trunkTop: 0.8, cr: 0.078, per: 11, twigs: 0.25, leaf: { cards: 5, flat: 0.3, tile: 0 },
      lobes: (B, H) => [[B.r(-1, 1), H * 0.83, B.r(-1, 1), H * 0.16, H * 0.13, H * 0.16], ...ring(B, H, 4, 0.6, 0.76, 0.1, 0.16, 0.14, 0.12)] }) },
  // 3-4 tall forest conifers: one with hanging foliage (hemlock, cedar) and a narrow one, both standing above the canopy
  { leaf: [0.090, 0.114, 0.036], bark: [0.10, 0.075, 0.055], tint: 0.45,
    make: () => lobed(21, { dense: 0.20, H: 31, trunkR: 0.42, trunkTop: 0.9, cr: 0.062, per: 8, twigs: 0.6, leaf: { cards: 3, flat: 0.4, tile: 0, hang: 2, hangLen: 1.9 },
      lobes: (B, H) => [[0, H * 0.92, 0, H * 0.1, H * 0.08, H * 0.1], ...ring(B, H, 3, 0.74, 0.86, 0.08, 0.14, 0.1, 0.08), ...ring(B, H, 3, 0.55, 0.7, 0.1, 0.17, 0.095, 0.075)] }) },
  { leaf: [0.068, 0.106, 0.041], bark: [0.11, 0.10, 0.09], tint: 0.45,
    make: () => lobed(22, { dense: 0.24, H: 28, trunkR: 0.36, trunkTop: 0.93, cr: 0.058, per: 8, twigs: 0.5, leaf: { cards: 4, flat: 0.3, tile: 0 },
      lobes: (B, H) => Array.from({ length: 8 }, (_, i) => { const t = i / 7, a = i * 2.4, d = H * (0.13 - 0.1 * t); return [Math.cos(a) * d, H * (0.46 + 0.5 * t), Math.sin(a) * d, H * (0.1 - 0.035 * t), H * 0.07, H * (0.1 - 0.035 * t)]; }) }) },
  // 5 small broadleaved understory tree, 6 brush (juniper and sagebrush country): gray-green, rounded, many stems
  { leaf: [0.076, 0.132, 0.041], bark: [0.08, 0.07, 0.055], tint: 0.6, fall: [0.40, 0.09, 0.03], fall2: [0.46, 0.17, 0.03],
    make: () => lobed(31, { dense: 0.37, H: 8.5, trunkR: 0.16, trunkTop: 0.55, cr: 0.16, per: 8, twigs: 0.1, leaf: { cards: 4, flat: 0.2, tile: 1 },
      lobes: (B, H) => [[0, H * 0.72, 0, H * 0.3, H * 0.24, H * 0.3], ...ring(B, H, 4, 0.42, 0.58, 0.22, 0.3, 0.27, 0.2)] }) },
  { leaf: [0.080, 0.108, 0.052], bark: [0.11, 0.095, 0.08], tint: 0.4,
    make: () => lobed(32, { dense: 0.42, H: 6.5, trunkR: 0.11, stems: 1, cr: 0.17, per: 8, twigs: 0.3, leaf: { cards: 4, flat: 0.25, tile: 0 },
      lobes: (B, H) => [[0, H * 0.7, 0, H * 0.3, H * 0.25, H * 0.3], ...ring(B, H, 3, 0.48, 0.62, 0.2, 0.3, 0.27, 0.21)] }) },
  // 7-8 young pine: a dense cone to the ground
  { leaf: [0.048, 0.094, 0.054], bark: [0.085, 0.06, 0.045], tint: 0.3,
    make: () => whorled(41, { dense: 0.37, H: 15, trunkR: 0.2, base: 0.07, spread: 0.3, pow: 0.85, step: 0.066, per: 6, rise: 0.32, width: 0.44, gaps: 0.1 }) },
  { leaf: [0.046, 0.090, 0.054], bark: [0.085, 0.06, 0.045], tint: 0.3,
    make: () => whorled(42, { dense: 0.37, H: 19, trunkR: 0.25, base: 0.12, spread: 0.25, pow: 0.7, step: 0.06, per: 6, rise: 0.22, width: 0.46, gaps: 0.16 }) },
  // 9 mature pine (ponderosa): a bare lower trunk under a ragged, heavy-limbed crown; 10 a dense dark windbreak conifer
  { leaf: [0.050, 0.092, 0.050], bark: [0.08, 0.058, 0.045], tint: 0.25,
    make: () => lobed(51, { dense: 0.28, H: 30, trunkR: 0.42, trunkTop: 0.9, cr: 0.07, per: 9, twigs: 0.5, leaf: { star: 3, cards: 3, tile: 2 },
      lobes: (B, H) => [[H * 0.02, H * 0.88, 0, H * 0.14, H * 0.1, H * 0.14], ...ring(B, H, 4, 0.68, 0.8, 0.1, 0.19, 0.14, 0.09), ...ring(B, H, 4, 0.48, 0.62, 0.13, 0.22, 0.13, 0.085)] }) },
  { leaf: [0.048, 0.090, 0.046], bark: [0.085, 0.065, 0.05], tint: 0.25,
    make: () => lobed(52, { dense: 0.39, H: 19, trunkR: 0.4, trunkTop: 0.6, cr: 0.11, per: 10, twigs: 0.05, leaf: { star: 2, cards: 3, tile: 2 },
      lobes: (B, H) => [[0, H * 0.8, 0, H * 0.2, H * 0.18, H * 0.2], ...ring(B, H, 4, 0.52, 0.66, 0.16, 0.24, 0.2, 0.16), ...ring(B, H, 5, 0.22, 0.36, 0.2, 0.28, 0.19, 0.15)] }) },
  // 11 Douglas fir: a tall narrow spire with drooping tiers
  { leaf: [0.038, 0.078, 0.054], bark: [0.075, 0.06, 0.05], tint: 0.25,
    make: () => whorled(61, { dense: 0.37, H: 31, trunkR: 0.34, base: 0.16, spread: 0.2, pow: 0.72, step: 0.05, per: 5, rise: -0.22, width: 0.4, gaps: 0.08 }) },
  // 12 Lombardy poplar (it also stands in for aspen and birch), 13 willow, 14-15 broad field and town trees (ash, cottonwood)
  { leaf: [0.110, 0.175, 0.052], bark: [0.16, 0.15, 0.13], tint: 0.35, fall: [0.48, 0.36, 0.05], fall2: [0.46, 0.29, 0.04],
    make: () => lobed(71, { dense: 0.28, H: 27, trunkR: 0.3, trunkTop: 0.95, cr: 0.045, per: 9, twigs: 0, leaf: { cards: 3, upright: 0.85, tall: 1.7, tile: 1 },
      lobes: (B, H) => Array.from({ length: 7 }, (_, i) => { const t = i / 6, w = 0.058 * Math.pow(Math.sin(Math.PI * (0.12 + 0.82 * Math.pow(t, 0.8))), 0.6) + 0.01; return [B.r(-0.3, 0.3), H * (0.17 + 0.76 * t), B.r(-0.3, 0.3), H * w, H * 0.085, H * w]; }) }) },
  { leaf: [0.136, 0.195, 0.080], bark: [0.12, 0.11, 0.095], tint: 0.35, fall: [0.28, 0.26, 0.05], fall2: [0.30, 0.23, 0.04],
    make: () => lobed(81, { dense: 0.26, H: 13, trunkR: 0.34, trunkTop: 0.4, cr: 0.12, per: 8, twigs: 0.3, leaf: { cards: 2, flat: 0.5, tile: 0, hang: 2, hangLen: 2.3 },
      lobes: (B, H) => [[0, H * 0.78, 0, H * 0.3, H * 0.19, H * 0.3], ...ring(B, H, 5, 0.58, 0.7, 0.26, 0.34, 0.27, 0.18)] }) },
  { leaf: [0.086, 0.150, 0.043], bark: [0.095, 0.085, 0.07], tint: 0.4, fall: [0.42, 0.32, 0.05], fall2: [0.40, 0.24, 0.04],
    make: () => lobed(91, { dense: 0.30, H: 16, trunkR: 0.4, trunkTop: 0.55, cr: 0.11, per: 12, twigs: 0.15, leaf: { cards: 4, tile: 1 },
      lobes: (B, H) => [[0, H * 0.76, 0, H * 0.27, H * 0.2, H * 0.27], ...ring(B, H, 5, 0.46, 0.64, 0.2, 0.28, 0.24, 0.19)] }) },
  { leaf: [0.078, 0.140, 0.046], bark: [0.095, 0.085, 0.07], tint: 0.4, fall: [0.44, 0.31, 0.05], fall2: [0.48, 0.22, 0.04],
    make: () => lobed(92, { dense: 0.30, H: 12.5, trunkR: 0.34, trunkTop: 0.5, cr: 0.13, per: 11, twigs: 0.15, leaf: { cards: 4, tile: 1 },
      lobes: (B, H) => [[H * 0.05, H * 0.74, 0, H * 0.3, H * 0.21, H * 0.3], ...ring(B, H, 4, 0.44, 0.6, 0.24, 0.32, 0.28, 0.21)] }) },
];

/** Grow every model. Each comes back with its geometry and the measurements the shaders need. */
function buildVariants() {
  return SPECIES.map((sp) => {
    const B = sp.make(), pos = new Float32Array(B.P), n = pos.length / 3;
    let rc = 0, top = 0;
    for (let i = 0; i < n; i++) { rc = Math.max(rc, Math.hypot(pos[i * 3], pos[i * 3 + 2])); top = Math.max(top, pos[i * 3 + 1]); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(B.N), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(B.UV), 2));
    geo.setAttribute('aVtx', new THREE.BufferAttribute(new Float32Array(B.A), 3));
    geo.setIndex(B.I);
    const hc = top / 2;
    return {
      geo, tris: B.I.length / 3, height: top,
      rc: rc * FIT, hc, R: Math.hypot(rc, hc) * 1.02,
      leaf: sp.leaf, bark: sp.bark, tint: sp.tint, fall: sp.fall, fall2: sp.fall2 || sp.fall,
    };
  });
}

// ---------------------------------------------------------------- shaders

// Baking: every view of every model is one mesh in a flat scene, drawn once into both atlas textures.
const BAKE_VERT = /* glsl */`
in vec3 aVtx;
out vec3 vN, vVtx; out vec2 vUv; out float vDepth;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normal; vVtx = aVtx; vUv = uv; vDepth = wp.z;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BAKE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tLeaf;
in vec3 vN, vVtx; in vec2 vUv; in float vDepth;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  vec4 t = texture(tLeaf, vUv);
  float bark = vVtx.z;
  if (max(t.a, bark) < 0.5) discard;
  float k = 1.0 / max(t.a, 0.004);
  oA = vec4(clamp(mix(t.r * k, 0.77, bark) * vVtx.y * 0.8, 0.0, 1.0), max(bark, t.g * k), vVtx.x, 1.0);
  oB = vec4(normalize(vN) * 0.5 + 0.5, clamp(vDepth * 0.5 + 0.5, 0.0, 1.0));
}`;

const HEAD = /* glsl */`
#define NV ${NV}
#define NA ${NA}.0
#define NE ${NE}.0
#define OCC_LOW ${OCC[0].toFixed(2)}
#define OCC_HIGH ${OCC[1].toFixed(2)}
`;

// Vertex-stage code shared by the impostors, the near meshes and the shade maps.
const TREE_VERT_FN = /* glsl */`
uniform float uLandHalf, uNow;
uniform vec4 uVar[NV];       // atlas frame half-width, center height, bounding radius, share of color taken from the picture
uniform vec3 uLeaf[NV];
uniform vec4 uFall[NV];      // the color a broadleaf turns in the fall, and 1 if it loses its leaves (0: evergreen)
uniform vec3 uFall2[NV];     // the other color it may turn
uniform vec4 uLod;           // share of candidates in use, thinning starts (m), thinning length (m), trees end (m)
uniform vec4 uNear;          // real meshes give way to cards between x and y (m); z: the shade on the ground ends (m)
uniform vec2 uGround;        // the terrain darkens the ground under trees out to x (m), fading by y (m)
uniform vec4 uHand;          // fine patches hand over to far tiles at x (m) across y (m), each tree up to z (m) early or late; w: frame counter

// Share of the candidates still drawn at a distance: all of them close in, falling as 1 / distance squared,
// which keeps about as many trees to the pixel however far the forest is.
float treeKeep(float d) { float t = max(d - uLod.y, 0.0) / uLod.z; return 1.0 / (1.0 + t * t); }
// 0 for a tree thinned out at this distance; the last few shrink away instead of popping.
float treeGrow(float rank, float keep) { float D = uLod.x * keep; return 1.0 - smoothstep(0.8 * D, D, rank); }
// A number 0..1 that belongs to the tree (its rank is stored in 16 bits, the same in every buffer that holds it).
float treeHash(float rank, float k) { return fract(floor(rank * 65535.0 + 0.5) * k); }
// What a tree left standing among thinned-out neighbors makes up for them. x: how much taller it is drawn,
// y: how many crowns wide its card is. A tree that stands alone has no neighbors to stand for.
vec2 treeSize(float keep, float solitary) {
  float hs = min(pow(keep, -0.2), 1.8);                 // not much taller: on a skyline every tree is seen whole
  return vec2(hs, mix(max(inversesqrt(keep) / hs, 1.0), 1.0, solitary));
}

// How wooded a color from the picture is: 1 dark green, 0 open. The picture's own shadows are deep blue and
// hide what grows in them, so there the vegetation rules (ruleDense) are trusted instead; and the very darkest
// ground on the flat (level: 1), where no hill can shade it, is dense conifer plantation whatever its hue.
// shadowed: 1 where the picture's color is no guide to the foliage.
float woodsIn(vec3 c, float ruleDense, float level, out float shadowed) {
  float lum = dot(c, vec3(0.3, 0.55, 0.15));
  float rule = smoothstep(0.25, 0.6, ruleDense);
  shadowed = max(smoothstep(0.04, 0.022, lum) * step(max(c.r, c.g) * 1.05, c.b) * rule, smoothstep(0.016, 0.009, lum) * level);
  // where the rules expect forest, hazy blue-green and slightly brighter ground still counts
  float green = step(c.r, c.g * 1.1) * step(c.b, c.g * (1.15 + 0.3 * rule));
  return max(smoothstep(0.05 + 0.015 * rule, 0.024 + 0.008 * rule, lum) * green, shadowed);
}
// The same at a point on the ground; -1 where no picture has loaded.
float woodsAt(vec2 xz, float ruleDense) {
  vec4 im = imagery(xz, 0.0);
  float shadowed;
  return im.a < 0.5 ? -1.0 : woodsIn(im.rgb, ruleDense, 1.0, shadowed);
}
// The picture a tree is judged by. The finest level only reaches a few kilometers from the camera, and a tree
// must not change its mind when the edge of that level passes over it: the level follows the tree's distance,
// blended from one to the next, so the judgment drifts instead of jumping.
vec4 treePicture(vec2 xz, float d) {
  float lv = clamp(log2(max(d, 1.0) / 3000.0), 0.0, 3.0), l0 = floor(lv), f = lv - l0;
  vec4 a = imagery(xz, l0);
  if (f > 0.01 && a.a > 0.5) { vec4 b = imagery(xz, l0 + 1.0); if (b.a > 0.5) a = mix(a, b, f); }
  return a;
}

${BUILDING_COVER_GLSL}
// Does a tree stand here? 0 no, 1 yes, between the two it is drawn part-grown, so a tree whose picture changes
// under it (a finer level arriving) swells or shrinks instead of appearing. Where the picture has loaded it decides:
// dark green ground is woodland, and ground darker than its surroundings is a shelter belt or a clump.
// ground: the tree's slope and rule density (aC). pic: the picture's color (r < 0 where there is none);
// dense: 0 a lone tree .. 1 inside closed forest.
float treeKept(vec3 base, float d, float rank, float flags, vec4 ground, out vec3 pic, out float dense) {
  if (buildingCover(base.xz) > 0.5) { pic = vec3(-1.0); dense = 0.0; return 0.0; }       // a building stands here (world/cities.js)
  if (waterCover(base.xz) > 0.5) { pic = vec3(-1.0); dense = 0.0; return 0.0; }          // or the map has water here
  float ruleDense = ground.w;
  float solitary = mod(flags, 2.0), rule = mod(floor(flags * 0.5), 2.0);
  vec4 im = treePicture(base.xz, d);
  if (im.a > 0.5) {
    const vec3 W = vec3(0.3, 0.55, 0.15);
    float lum = dot(im.rgb, W), shadowed;
    float green = step(im.r, im.g * 1.1) * step(im.b, im.g * 1.15);
    float woods = woodsIn(im.rgb, ruleDense, 1.0 - smoothstep(0.12, 0.3, length(ground.xy) * 2.0), shadowed);
    // In prairie and plowed country a dark green field is a crop far more often than a wood: on level ground
    // there (the regional map says how wooded the lowlands are) only the darkest of the picture is taken for trees.
    // Shelter belts and clumps (below) and whatever the rules plant are not touched by this.
    float moist = texture2D(tRegion, base.xz / (2.0 * uWxHalf) + 0.5).g;
    // (Nothing is plowed in the mountains: from about 1,500 m under the tree line up, the picture is trusted as it was.)
    float tlHere = treeLine(base.xz);
    float crop = (1.0 - smoothstep(0.44, 0.62, moist)) * (1.0 - smoothstep(0.05, 0.12, length(ground.xy) * 2.0)) * (1.0 - smoothstep(tlHere - 1560.0, tlHere - 1160.0, base.y));
    woods *= mix(1.0, smoothstep(0.026, 0.014, lum), crop);
    float lumW = dot(imagery(base.xz, 3.0).rgb, W);
    float line = smoothstep(0.1, 0.35, 1.0 - lum / max(lumW, 0.004)) * smoothstep(0.085, 0.045, lum) * green;
    woods = max(woods, line);
    dense = woods * smoothstep(0.075, 0.035, lumW);
    pic = shadowed > 0.5 ? vec3(-1.0) : im.rgb;                   // a tree takes no color from a shadow
    float pasture = step(im.r, im.g * 1.05) * step(im.b, im.g) * smoothstep(0.03, 0.05, lum) * smoothstep(0.2, 0.12, lum);
    // Thinning with distance takes the head of the list by rank. Whether the picture grows a tree here is drawn
    // on a second number of the tree's own, so that open woodland thins in step with closed forest instead of
    // filling up with distance.
    return max(smoothstep(0.0, 0.03, woods * 0.92 - treeHash(rank, 0.4142135)), smoothstep(0.3, 0.7, solitary * pasture));
  }
  pic = vec3(-1.0); dense = ruleDense * (1.0 - solitary);
  return rule;
}

// Dark blocks of woodland in the dry West are stands of pine: whatever was proposed there is drawn as one.
int treeModel(float code, vec3 base, float dense, float flags) {
  int vi = int(mod(code, 16.0) + 0.5);
  if (vi >= 12 && dense > 0.55) {
    float wet = smoothstep(0.3, 0.4, texture2D(tRegion, base.xz / (2.0 * uWxHalf) + 0.5).g);
    if (wet < 0.5) vi = mod(floor(flags * 0.25), 2.0) > 0.5 ? 9 : 7;
  }
  return vi;
}

// Out where the ground under the trees is no longer darkened for their shade (the terrain does that to the picture
// as far as uGround says), the trees stop being darker than the picture's own forest: 0 close, 1 far.
float treeFar(float d) { return smoothstep(uGround.x, uGround.y, d); }

float gBare = 0.0;            // how far treeLeaf found the tree's leaves down (for treeLight)
vec3 treeLeaf(int vi, float tintRnd, vec3 pic, float d, vec3 C) {
  vec3 leaf = uLeaf[vi] * (0.78 + 0.44 * tintRnd);
  if (pic.r >= 0.0) {
    // Take the hue of the picture, but keep the brightness inside what foliage can be. Far away the trees
    // follow the picture more closely: there they should give the forest relief, not a color of their own.
    float lum = max(dot(pic, vec3(0.3, 0.55, 0.15)), 0.004), want = dot(leaf, vec3(0.3, 0.55, 0.15)), far = smoothstep(500.0, 2500.0, d);
    float leafy = smoothstep(1.3, 1.05, pic.b / max(pic.g, 1e-4)) * smoothstep(1.3, 1.05, pic.r / max(pic.g, 1e-4));   // blue or brown ground lends no color
    float lit = treeFar(d);
    leaf = mix(leaf, pic / lum * clamp(lum * 3.4, want * mix(0.95, 0.9, far), want * mix(mix(1.55, 1.8, far), 3.2, lit)), mix(mix(uVar[vi].w, 0.85, far), 0.95, lit) * leafy);
  }
  // The season (seasonAt): the light green of new leaves; the fall color, each tree in its own time and one of its
  // kind's two colors; then the leaves coming down, which leaves the twigs (treeShade's caller thins the crown).
  vec4 se = seasonAt(C);
  float dec = uFall[vi].a, own = fract(tintRnd * 7.13);
  leaf = mix(leaf, leaf * vec3(1.12, 1.3, 0.72), se.z * dec);
  vec3 fc = mix(uFall[vi].rgb, uFall2[vi], smoothstep(0.25, 0.85, tintRnd)) * (0.9 + 0.2 * own);   // (the kind's two colors and every shade between)
  leaf = mix(leaf, fc, clamp(se.y * 1.5 - 0.5 * own, 0.0, 1.0) * dec);
  gBare = clamp((1.0 - se.x) * 1.3 - 0.3 * fract(tintRnd * 5.31), 0.0, 1.0) * dec;
  leaf = mix(leaf, vec3(0.10, 0.085, 0.07), 0.85 * gBare);
  return leaf;
}`;

// Everything about one tree that the pixel shader needs, worked out once per tree.
const TREE_LIGHT_VERT = /* glsl */`
flat varying vec4 vLeaf, vTr, vIn, vView, vRot;
flat varying vec3 vWood;
void treeLight(vec3 C, vec3 leaf, float yaw, float dense, float fade, float lod) {
  float hReg = regionHeight(C.xz);
  // Neighbors shade this tree only if they stand between it and the sun: look that way in the picture.
  float sunward = woodsAt(C.xz + normalize(uSunDir.xz + vec2(1e-4)) * 16.0, dense);
  vWood = vec3(dense, sunward < 0.0 ? dense * 0.7 : dense * sunward, gBare);
  float sh = terrainShadow(C, hReg) * (1.0 - 0.9 * cloudShadow(C));
  // Snow on the crowns: the standing snow of the high country (its line climbs on a warm day, but cold air alone does
  // not bring it down), and what the weather has laid (uSnow) on ground as cold as where that was measured
  // (uGroundT; the terrain's rule: see the snow in world/chunks.js).
  float snowline = snowLine(C.xz, 0.0);
  float snowOn = max(smoothstep(-100.0, 250.0, C.y - snowline + min(uTAnom, 0.0) * 150.0), 0.85 * min(uSnow * 2.5, 1.0) * (1.0 - smoothstep(2.0, 7.0, 2.2 - (C.y - snowline) / 150.0 - max(uGroundT, 1.8))));
  snowOn *= 1.0 - 0.6 * gBare;              // (a bare crown holds little of it)
  vec3 T = atmosphereTransmittance(cameraPosition, C);
  vec3 dir = normalize(C - cameraPosition);
  float cy = cos(yaw), sy = sin(yaw);
  vLeaf = vec4(leaf, sh);
  vTr = vec4(T, 1.0 - 0.5 * skyOcclusion(C, hReg));
  // (the haze in front of the tree is the haze in front of the ground it stands on: the same table, by direction and
  // distance, so that toward a low sun the trees sink into the glare with the land instead of standing out dark)
  vIn = vec4(atmosphereInscatter(dir, distance(cameraPosition, C)) * (1.0 - T), snowOn);
  vView = vec4(-(cy * dir.x - sy * dir.z), -dir.y, -(sy * dir.x + cy * dir.z), treeFar(distance(cameraPosition, C)));
  vRot = vec4(cy, sy, fade, lod);
}`;

// Pixel-stage lighting, the same for an impostor pixel and a mesh pixel. Works in the tree's own frame.
// Trees are left out of the screen-space ambient occlusion (they tag their pixels, see COVER below): among
// thousands of cards it was mostly noise, different every frame. What it did for the picture, darkening
// the crowns from the top down and deepest where the forest is closed, is done here instead, where it holds still.
const TREE_LIGHT_FRAG = /* glsl */`
${SKY_SH_GLSL}
uniform vec3 uSunDir, uSunCol, uAmbSky, uAmbGround;
uniform vec3 uBark[NV];
uniform vec4 uHand;
flat varying vec4 vLeaf, vTr, vIn, vView, vRot;
flat varying vec3 vWood;         // x: how closed the forest is here, y: how much of it stands toward the sun, z: how bare its crown is (gBare)
float leafHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// A different screen-door every frame, which the temporal filter turns into a smooth dissolve.
float dissolve() { return ign(gl_FragCoord.xy + uHand.w * 5.588238); }
// lum: brightness of the leaf or bark; open: how much of its surroundings the point sees; N: the middle of what it sees;
// hRel: height in the tree, 0 foot .. 1 top; rot: cos and sin of the tree's turn about the vertical
vec3 treeShade(float lum, float bark, float open, vec3 N, float hRel, int vi, vec2 rot) {
  vec3 L = vec3(rot.x * uSunDir.x - rot.y * uSunDir.z, uSunDir.y, rot.y * uSunDir.x + rot.x * uSunDir.z);
  vec3 alb = mix(vLeaf.rgb, uBark[vi], bark) * lum;
  alb = mix(alb, vec3(0.80, 0.84, 0.88), vIn.a * smoothstep(0.05, 0.7, N.y) * (0.92 - 0.55 * bark));     // snow lies on what faces up
  // Sunlight reaches the point if the sun stands inside the cone of open directions round N (open 0.625 = a full hemisphere).
  float d = dot(N, L);
  float vis = smoothstep(-0.5, 0.25, d - (1.0 - 1.6 * open));
  // In closed forest the neighbors shade the lower crown, more of it as the sun drops.
  float line = clamp(1.0 - 1.45 * L.y, 0.0, 0.85);
  float sun = vLeaf.a * mix(1.0, smoothstep(line - 0.3, line + 0.05, hRel), vWood.y);
  vec3 light = uSunCol * (sun * vis * (0.62 + 0.38 * max(d, 0.0)));
  // sunlight coming through thin foliage toward the eye
  float back = clamp(-dot(vView.xyz, L), 0.0, 1.0);
  light += uSunCol * vec3(0.85, 1.0, 0.3) * (sun * back * back * open * 0.6 * (1.0 - bark));
  vec3 amb = skyIrradiance(vec3(rot.x * N.x + rot.y * N.z, N.y, rot.x * N.z - rot.y * N.x)) * (vTr.a * min(open * 1.6, 1.15) * mix(1.0, 0.6 + 0.4 * hRel, vWood.x));
  // the occlusion the screen-space pass used to add (see above): deeper as the crowns close up with distance
  float occ = mix(mix(OCC_LOW, OCC_HIGH, hRel) * mix(1.0, 0.82, smoothstep(0.0, 2.5, vRot.w)), 1.0, 0.85 * vView.w);
  return alb * (light * mix(1.0, occ, 0.75) + amb * occ) * vTr.rgb + vIn.rgb;
}`;

// far: the far tiles' material. Their cards are single triangles (the tree is the square in the corner), blended
// over the terrain already drawn; the fine patches' cards are quads cut out with alpha-to-coverage before it.
const IMPOSTOR_VERT = (light, far) => /* glsl */`${HEAD}${far ? '#define FAR 1\n' : ''}
attribute vec4 aA, aB, aC;      // aA: position in the patch, rank. aB: model and flags, yaw, size, tint. aC: ground slope x and z, girth (far: which patch), rule density
attribute vec4 aP;              // one for the whole patch. x: when it was built (s)
#ifdef FAR
attribute vec4 aQ;              // one for the whole tile: when the fine patch over each quarter was built (s; far in the future if there is none)
#endif
uniform vec4 uAtlas;            // 1 / frames across, 1 / models, frame size (px), coarsest mip level that keeps the frames apart
varying vec2 vUv;
flat varying vec4 vDf, vFrame, vDim, vMix;
${light}
${TREE_VERT_FN}
${TREE_LIGHT_VERT}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);                          // off screen unless a tree stands here
  vec3 base = (modelMatrix * vec4(aA.xyz, 1.0)).xyz;
  float d = distance(cameraPosition, base), keep = treeKeep(d), grow = treeGrow(aA.w, keep);
  if (grow <= 0.0) return;
  float dj = d + (treeHash(aA.w, 0.6180339) - 0.5) * uHand.z;
  float born = clamp((uNow - aP.x) / ${FADE_IN.toFixed(2)}, 0.0, 1.0);
  #ifdef FAR
    // the fine patch has this tree out to the hand-over distance, once it has arrived
    float blk = floor(aC.z * 127.0 + 0.5);
    float fine = clamp((uNow - (blk < 0.5 ? aQ.x : blk < 1.5 ? aQ.y : blk < 2.5 ? aQ.z : aQ.w)) / ${FADE_IN.toFixed(2)}, 0.0, 1.0);
    float fade = mix(1.0, smoothstep(uHand.x - uHand.y, uHand.x, dj), fine) * (1.0 - smoothstep(0.72 * uLod.w, uLod.w, d)) * born;
    float show = 1.0, girth = 1.0;
  #else
    float fade = 1.0 - smoothstep(uHand.x - uHand.y, uHand.x, dj);
    // the real mesh has it close in; trees swap at slightly different distances so no ring shows
    float show = born * (uNear.y > 0.0 ? smoothstep(uNear.x, uNear.y, d + (treeHash(aA.w, 0.7548777) - 0.5) * 24.0) : 1.0);
    float girth = 1.0 + aC.z * 0.22;
  #endif
  if (fade <= 0.0 || show <= 0.0) return;
  float flags = floor(aB.x / 16.0), dense; vec3 pic;
  grow *= treeKept(base, d, aA.w, flags, aC, pic, dense);
  if (grow <= 0.0) return;
  int vi = treeModel(aB.x, base, dense, flags);
  vec4 var = uVar[vi];
  vec2 sz = treeSize(keep, mod(flags, 2.0));
  float s = (0.3 + aB.z * (1.7 / 255.0)) * sqrt(grow) * sz.x;
  float yaw = aB.y * (6.2831853 / 256.0);
  vec3 C = base + vec3(0.0, var.y * s, 0.0);
  vec3 toCam = cameraPosition - C; float dist = length(toCam); vec3 v = toCam / dist;
  // which baked views: the direction to the camera in the tree's own frame, between two heights and two compass points
  float cy = cos(yaw), sy = sin(yaw);
  vec3 vt = vec3(cy * v.x - sy * v.z, v.y, sy * v.x + cy * v.z);
  float el = clamp(degrees(asin(clamp(vt.y, -1.0, 1.0))) + (treeHash(aA.w, 0.5698403) - 0.5) * 8.0, ${ELS[0]}.0, ${ELS[3]}.0);
  float r0 = el < ${ELS[1]}.0 ? 0.0 : el < ${ELS[2]}.0 ? 1.0 : 2.0;
  float e0 = r0 < 0.5 ? ${ELS[0]}.0 : r0 < 1.5 ? ${ELS[1]}.0 : ${ELS[2]}.0, e1 = r0 < 0.5 ? ${ELS[1]}.0 : r0 < 1.5 ? ${ELS[2]}.0 : ${ELS[3]}.0;
  float eb = smoothstep(0.3, 0.7, (el - e0) / (e1 - e0)), elR = radians(el);
  float az = fract(atan(vt.x, vt.z + 1.0e-6) / 6.2831853) * NA, a0 = floor(az), ab = smoothstep(0.3, 0.7, az - a0);
  // The card is as tall as the tree looks from this height (the baked view is stretched that little to fit).
  vec2 half0 = vec2(var.x, (var.y * cos(elR)) * ${FIT.toFixed(2)} + var.x * sin(elR));
  float halfW = half0.x * girth * s * sz.y, halfH = half0.y * s;
  // Never under a few pixels: a tree smaller than that keeps its size on screen and thins instead.
  float pix = dist * uPixAngle, mw = max(1.0, 1.4 * pix / halfW), mh = max(1.0, 1.4 * pix / halfH);
  vec2 corner = position.xy;
  vec3 right = normalize(vec3(v.z, 0.0, -v.x)), up = cross(v, right);
  // A card that stands for neighbors stands for the ground they covered too: its top leans back along the slope
  // by the spacing of the trees still drawn. Seen across level ground that changes nothing; on a mountainside
  // that faces the camera it is what keeps the thinned forest closed.
  vec3 gn = normalize(vec3(-aC.x * 2.0, 1.0, -aC.y * 2.0)), back = -v - gn * dot(-v, gn);
  float lean = ${CELL.toFixed(1)} * (inversesqrt(max(keep * uLod.x, 1.0e-4)) - inversesqrt(max(uLod.x, 1.0e-4))) * (1.0 - mod(flags, 2.0));
  vec3 wp = C + right * (corner.x * halfW * mw) + up * (corner.y * halfH * mh) + back * (lean * (corner.y * 0.5 + 0.5));
  float lod = clamp(log2(uAtlas.z * pix / (2.0 * halfH)), 0.0, uAtlas.w);
  // a tree of a few pixels is one of a crowd: its own tint goes
  treeLight(C, treeLeaf(vi, mix(aB.w / 255.0, 0.5, smoothstep(3.5, 5.5, lod)), pic, d, C), yaw, dense, fade / (mw * mh), lod);
  vUv = corner * 0.5 + 0.5;
  vDf = vec4(cos(elR), sin(elR), ab, eb);
  vFrame = vec4(a0, r0, float(vi), sz.y);
  vDim = vec4(half0.y, var.z, var.y, show);
  vMix = vec4(treeHash(aA.w, 0.3247179), 0.0, 0.0, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const IMPOSTOR_FRAG = (far) => /* glsl */`${HEAD}${far ? '#define FAR 1\n' : ''}
uniform sampler2D tTreeA, tTreeB;
uniform vec4 uAtlas;
varying vec2 vUv;
flat varying vec4 vDf, vFrame, vDim, vMix;
${TREE_LIGHT_FRAG}
void main() {
  #ifdef FAR
    if (vUv.x > 1.0 || vUv.y > 1.0) discard;
  #else
    if (vDim.w < 1.0 && dissolve() >= vDim.w) discard;                // the real mesh is drawn in the pixels left out
  #endif
  float lod = vRot.w, n = vFrame.w;
  // Crowns side by side: the middle one is the tree itself, the others stand in for neighbors thinned away.
  // Each is another view of the same model, a little shorter, lit as if it had been turned that way.
  float X = (vUv.x - 0.5) * n, k = floor(X + 0.5), fu = X - k + 0.5, fv = vUv.y, turn = 0.0, side = 1.0;
  vec2 rot = vRot.xy;
  if (abs(k) > 0.5) {
    float hk = fract(sin((k + vMix.x * 37.0) * 91.3458) * 47453.5453);
    fv = vUv.y / (0.7 + 0.3 * hk);
    if (fv > 1.0) discard;
    turn = floor(1.0 + hk * (NA - 1.01));
    float a = turn * (6.2831853 / NA), ca = cos(a), sa = sin(a);
    rot = vec2(rot.x * ca - rot.y * sa, rot.y * ca + rot.x * sa);
    side = smoothstep(0.0, 0.3, 0.5 * n - abs(X));                 // the last crown slides in from behind the card's edge
  }
  vec2 inset = vec2(0.5 * exp2(lod) / uAtlas.z), cuv = clamp(vec2(fu, fv), inset, 1.0 - inset);
  float ab = vDf.z, eb = vDf.w, mdl = vFrame.z;
  vec2 f0 = (vec2(vFrame.y * NA + mod(vFrame.x + turn, NA), mdl) + cuv) * uAtlas.xy;
  vec2 f1 = (vec2(vFrame.y * NA + mod(vFrame.x + turn + 1.0, NA), mdl) + cuv) * uAtlas.xy;
  vec2 up = vec2(NA * uAtlas.x, 0.0);                                // the same view from the next height
  vec4 A = textureLod(tTreeA, f0, lod);
  if (ab > 0.01) A = mix(A, textureLod(tTreeA, f1, lod), ab);
  if (eb > 0.01) {
    vec4 A2 = textureLod(tTreeA, f0 + up, lod);
    if (ab > 0.01) A2 = mix(A2, textureLod(tTreeA, f1 + up, lod), ab);
    A = mix(A, A2, eb);
  }
  // Coverage. Close up, a crisp edge (the mipmaps thin the foliage, so count it for more as they coarsen).
  // A tree of a few pixels has no edge to draw: its coverage is the share of the card its crown fills.
  float cov = A.a;
  float crisp = clamp((cov * (1.0 + 0.3 * min(lod, 4.0)) - 0.5) / clamp(fwidth(cov), 0.04, 0.5) + 0.5, 0.0, 1.0);
  float alpha = mix(crisp, clamp(cov * 1.7, 0.0, 1.0), smoothstep(3.0, 5.0, lod)) * side * vRot.z;
  if (alpha < ${far ? '0.02' : '0.06'}) discard;
  vec4 B = textureLod(tTreeB, f0, lod);
  if (ab > 0.01) B = mix(B, textureLod(tTreeB, f1, lod), ab);
  if (eb > 0.01) {
    vec4 B2 = textureLod(tTreeB, f0 + up, lod);
    if (ab > 0.01) B2 = mix(B2, textureLod(tTreeB, f1 + up, lod), ab);
    B = mix(B, B2, eb);
  }
  float q = 1.0 / max(A.a, 0.004);
  vec3 N = normalize(B.rgb * q * 2.0 - 1.0 + vec3(0.0, 0.0, 1.0e-4));
  // height of this pixel in the tree, from where it lies on the card and how deep
  float y = vDim.z + vDf.x * ((cuv.y * 2.0 - 1.0) * vDim.x) + vDf.y * ((B.a * q * 2.0 - 1.0) * vDim.y);
  float hRel = mix(clamp(y / (2.0 * vDim.z), 0.0, 1.0), 0.7, smoothstep(4.5, 6.5, lod));
  // A bare crown: most of its leaf is gone, the twigs and limbs stay (in steady spots of the card, so it holds still).
  float leafPart = 1.0 - clamp(A.g * q, 0.0, 1.0);
  if (vWood.z > 0.01 && leafPart > 0.5) {
    if (lod < 3.0 && leafHash(floor(cuv * 44.0) + vMix.x * 17.0) < 0.82 * vWood.z) discard;
    alpha *= 1.0 - 0.6 * vWood.z * smoothstep(2.0, 4.0, lod);
  }
  vec3 col = treeShade(A.r * q * 1.6, clamp(A.g * q, 0.0, 1.0), A.b * q, N, hRel, int(mdl + 0.5), rot);
  gl_FragColor = vec4(col, alpha);
}`;

const NEAR_VERT = (light) => /* glsl */`${HEAD}
attribute vec3 aVtx;            // openness, brightness, bark
attribute vec4 iA, iB, iC;      // iA: position, rank. iB: model and flags, yaw + 256 * model drawn, size, tint. iC: as aC
varying vec3 vP, vN, vVtx; varying vec2 vUv;
flat varying float vHc, vShow; flat varying int vVi;
${light}
${TREE_VERT_FN}
${TREE_LIGHT_VERT}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec3 base = (modelMatrix * vec4(iA.xyz, 1.0)).xyz;
  float d = distance(cameraPosition, base);
  // the card has it from here; in between, the two share the tree's pixels (see dissolve)
  float card = smoothstep(uNear.x, uNear.y, d + (treeHash(iA.w, 0.7548777) - 0.5) * 24.0);
  if (card >= 1.0) return;
  float keep = treeKeep(d), grow = treeGrow(iA.w, keep);
  if (grow <= 0.0) return;
  float flags = floor(iB.x / 16.0), dense; vec3 pic;
  grow *= treeKept(base, d, iA.w, flags, iC, pic, dense);
  if (grow <= 0.0) return;
  int vi = treeModel(iB.x, base, dense, flags);
  float drawn = floor(iB.y / 256.0);
  if (vi != int(drawn + 0.5)) return;
  // the same size as its card: thinning has not begun this close, but the last trees of the list are part-grown
  float s = (0.3 + iB.z * (1.7 / 255.0)) * sqrt(grow) * treeSize(keep, mod(flags, 2.0)).x;
  float girth = 1.0 + iC.z * 0.22, yaw = (iB.y - drawn * 256.0) * (6.2831853 / 256.0);
  float cy = cos(yaw), sy = sin(yaw);
  vec3 pt = position * vec3(girth, 1.0, girth) * s;
  vec3 wp = base + vec3(cy * pt.x + sy * pt.z, pt.y, -sy * pt.x + cy * pt.z);
  vec3 C = base + vec3(0.0, uVar[vi].y * s, 0.0);
  treeLight(C, treeLeaf(vi, iB.w / 255.0, pic, d, C), yaw, dense, 1.0, 0.0);
  vP = position; vN = normal; vVtx = aVtx; vUv = uv; vHc = uVar[vi].y; vVi = vi; vShow = card;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const NEAR_FRAG = /* glsl */`${HEAD}
uniform sampler2D tLeaf;
varying vec3 vP, vN, vVtx; varying vec2 vUv;
flat varying float vHc, vShow; flat varying int vVi;
${TREE_LIGHT_FRAG}
void main() {
  if (vShow > 0.0 && dissolve() < vShow) discard;                    // the card is drawn in these pixels
  vec4 t = texture2D(tLeaf, vUv);
  float bark = vVtx.z, cov = max(t.a, bark);
  float alpha = clamp((cov - 0.5) / clamp(fwidth(cov), 0.02, 0.5) + 0.5, 0.0, 1.0);
  if (alpha < 0.06) discard;
  float k = 1.0 / max(t.a, 0.004);
  if (vWood.z > 0.01 && bark < 0.5 && leafHash(floor(vP.xz * 3.0 + vP.y * 2.7) + vec2(vHc)) < 0.85 * vWood.z) discard;   // a bare crown (as above)
  vec3 col = treeShade(mix(t.r * k, 0.77, bark) * vVtx.y * 1.28, max(bark, clamp(t.g * k, 0.0, 1.0)), vVtx.x, normalize(vN), clamp(vP.y / (2.0 * vHc), 0.0, 1.0), vVi, vRot.xy);
  gl_FragColor = vec4(col, alpha);
}`;

// The shade of the trees on the ground. Each tree's silhouette as the sun sees it is laid along the slope it
// stands on and drawn FROM ABOVE into a map fixed to the ground (one of a few, one inside the other around the
// camera: see Trees.shade), and the ground shaders read the map (treeShade in world/groundlight.js).
//
// The shadows used to be drawn per tree on the screen, as quads multiplied into the picture. Seen at a shallow
// angle such a quad is a few pixels deep: its mip level, its fade and so its shape followed the view, so a
// shadow a kilometer off changed and crept as the camera moved, each stood at its tree's own height and slid
// against ground whose mesh was coarser, and where crowns overlapped the shadows multiplied. Drawn into a map,
// a shadow is a property of the place:
//   - the map's middle moves in whole texels, so a tree lands on the same texels every time it is drawn;
//   - the silhouette is read at the mip level that suits the map's texel (never the screen's), so it arrives
//     already smoothed to what the map can hold, and the ground's own texture filtering does the rest;
//   - where shadows overlap the darkest wins (the blend keeps the maximum): a wood throws one shade, not a
//     stack of them, and under closed forest the shade is whole.
// With no sun to speak of (overcast, night) the same quad lies under the crown instead: the gloom under a tree.
const SHADE_VERT = (light) => /* glsl */`${HEAD}
attribute vec4 aA, aB, aC, aP;
uniform vec4 uAtlas;
uniform vec3 uShadeEye;          // the camera the picture is drawn from (this pass has none of its own)
uniform vec4 uShadeM;            // this map: its middle x, z (m), 2 / its width (1/m), meters a texel
uniform vec4 uShadeL;            // xyz: where the light that throws the shade comes from; w: 1 the sun, 0 straight overhead (no sun)
varying vec2 vUv;
flat varying vec4 vFrame;
${light}
${TREE_VERT_FN}
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec3 base = (modelMatrix * vec4(aA.xyz, 1.0)).xyz;
  if (max(abs(base.x - uShadeM.x), abs(base.z - uShadeM.y)) * uShadeM.z > 1.0 + ${SHADE_REACH.toFixed(1)} * uShadeM.z) return;      // too far outside this map to reach it
  float d = distance(uShadeEye, base), keep = treeKeep(d), grow = treeGrow(aA.w, keep);
  if (grow <= 0.0 || d >= uNear.z) return;
  float flags = floor(aB.x / 16.0), dense; vec3 pic;
  grow *= treeKept(base, d, aA.w, flags, aC, pic, dense);
  if (grow <= 0.0) return;
  int vi = treeModel(aB.x, base, dense, flags);
  vec4 var = uVar[vi];
  vec2 sz = treeSize(keep, mod(flags, 2.0));
  float s = (0.3 + aB.z * (1.7 / 255.0)) * sqrt(grow) * sz.x, girth = (1.0 + aC.z * 0.22) * sz.y;
  float yaw = aB.y * (6.2831853 / 256.0), cy = cos(yaw), sy = sin(yaw);
  vec3 n = normalize(vec3(-aC.x * 2.0, 1.0, -aC.y * 2.0));
  vec3 L = uShadeL.xyz;
  // Ground turned from the sun is in its own shade already, and a shadow thrown along it would run to the horizon.
  float facing = dot(L, n), lit = mix(1.0, smoothstep(0.06, 0.22, facing), uShadeL.w);
  if (lit <= 0.0) return;
  // the baked view nearest to that direction
  vec3 lt = vec3(cy * L.x - sy * L.z, L.y, sy * L.x + cy * L.z);
  float el = degrees(asin(clamp(lt.y, 0.0, 1.0)));
  float row = el < 18.0 ? 0.0 : el < 42.5 ? 1.0 : el < 68.5 ? 2.0 : 3.0;
  float a0 = mod(floor(fract(atan(lt.x, lt.z + 1.0e-6) / 6.2831853) * NA + 0.5), NA);
  float elS = asin(L.y);
  vec2 half0 = vec2(var.x, (var.y * cos(elS)) * ${FIT.toFixed(2)} + var.x * sin(elS));
  float halfW = half0.x * girth * s, halfH = half0.y * s;
  // Never under a couple of texels of this map: a smaller shadow keeps that size and thins instead.
  float mw = max(1.0, 1.25 * uShadeM.w / halfW), mh = max(1.0, 1.25 * uShadeM.w / halfH);
  vec2 corner = position.xy;
  vec3 C = base + vec3(0.0, var.y * s, 0.0);
  vec3 right = L.y > 0.999 ? vec3(1.0, 0.0, 0.0) : normalize(vec3(L.z, 0.0, -L.x)), up = cross(L, right);
  vec3 P = C + right * (corner.x * halfW * mw) + up * (corner.y * halfH * mh);
  vec3 G = P - L * (dot(P - base, n) / max(facing, 0.1));               // where the light through P meets the slope the tree stands on
  // fades toward the end of the shadow range, and in with its patch
  float k = grow * lit * (1.0 - smoothstep(0.7 * uNear.z, uNear.z, d)) * clamp((uNow - aP.x) / ${FADE_IN.toFixed(2)}, 0.0, 1.0) / (mw * mh);
  vUv = corner * 0.5 + 0.5;
  vFrame = vec4(row * NA + a0, float(vi), clamp(log2(uAtlas.z * uShadeM.w / (2.0 * min(halfW, halfH))) + 0.5, 0.0, uAtlas.w), k);
  gl_Position = vec4((G.x - uShadeM.x) * uShadeM.z, (G.z - uShadeM.y) * uShadeM.z, 0.0, 1.0);
}`;

const SHADE_FRAG = /* glsl */`
uniform sampler2D tTreeA;
uniform vec4 uAtlas;
varying vec2 vUv;
flat varying vec4 vFrame;
void main() {
  // The silhouette at the mip level that suits this map's texels, in whichever direction the shadow is squeezed
  // most. (These are the map's texels, not the screen's pixels: the level is the same however the map is looked at.)
  vec2 dx = dFdx(vUv), dy = dFdy(vUv);
  float lod = clamp(max(vFrame.z, 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1.0e-12)) + log2(uAtlas.z) + 0.5), 0.0, uAtlas.w);
  vec2 inset = vec2(0.5 * exp2(lod) / uAtlas.z), cuv = clamp(vUv, inset, 1.0 - inset);
  float cov = textureLod(tTreeA, (vFrame.xy + cuv) * uAtlas.xy, lod).a;
  vec2 rim = smoothstep(vec2(0.0), vec2(0.1), min(vUv, 1.0 - vUv));  // no hard edge where the silhouette reaches the frame
  // Close to, a firm silhouette with the gaps in the foliage closed up a little. Smoothed over a few texels of a
  // coarse map the coverage is a share of area and is taken as it is: firmed up, it would fill the whole quad.
  float a = mix(smoothstep(0.05, 0.55, cov), min(cov * 1.3, 1.0), smoothstep(1.0, 3.0, lod));
  gl_FragColor = vec4(a * vFrame.w * rim.x * rim.y, 0.0, 0.0, 1.0);     // the blend keeps the darkest
}`;

// ---------------------------------------------------------------- placement

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);
const FAR_TRI = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);      // one triangle; the card is the square in its corner
// Elevation zoom the terrain uses for a patch of a given size (as zoomFor in chunks.js).
const zoomFor = (size) => Math.max(4, Math.min(dem.MAX_Z, Math.round(Math.log2((metersPerPixel(0) * 64) / size))));
const NEVER = 1e9;

// The layout the placement works to (treeplace.js), and the most trees a far tile can hold.
const LAYOUT = { CELL, PATCH, GRID, FAR_SIZE, FAR_POOL };
const FAR_MAX = Math.ceil(candidates(LAYOUT) * FAR_POOL) * 4;

// ---------------------------------------------------------------- the tree layer

export class Trees {
  /** group: where to add meshes. lightGlsl / uniforms / defines: the lighting code and state shared with the terrain. */
  constructor(group, lightGlsl, uniforms, defines) {
    this.group = group;
    this.tier = TIERS.high;
    this.variants = buildVariants();
    this.leafTex = makeLeafTexture();
    this.atlas = null; this.baked = 0;
    const V = this.variants;
    this.uni = {
      ...uniforms(),
      uLandHalf: { value: LAND_HALF }, uNow: { value: 0 },
      uVar: { value: V.map((v) => new THREE.Vector4(v.rc, v.hc, v.R, v.tint)) },
      uLeaf: { value: V.map((v) => new THREE.Vector3(...v.leaf)) },
      uFall: { value: V.map((v) => (v.fall ? new THREE.Vector4(...v.fall, 1) : new THREE.Vector4(0, 0, 0, 0))) },
      uFall2: { value: V.map((v) => new THREE.Vector3(...(v.fall2 || [0, 0, 0]))) },
      uBark: { value: V.map((v) => new THREE.Vector3(...v.bark)) },
      uLod: { value: new THREE.Vector4(1, 700, 850, 13000) },
      uNear: { value: new THREE.Vector4(115, 170, 2600, 0) },
      uHand: { value: new THREE.Vector4(HAND, HAND_BAND, HAND_JIT, 0) },
      uGround: { value: new THREE.Vector2(GROUND_SHADE[0], GROUND_SHADE[1]) },
      uAtlas: { value: new THREE.Vector4(1 / (NA * NE), 1 / NV, 128, 7) },
      tTreeA: { value: null }, tTreeB: { value: null }, tLeaf: { value: this.leafTex },
      uShadeEye: { value: new THREE.Vector3() }, uShadeM: { value: new THREE.Vector4(0, 0, 1, 1) }, uShadeL: { value: new THREE.Vector4(0, 1, 0, 0) },
    };
    // Alpha does two jobs in the scene's target. Post-processing reads it as a tag: 1 land, 0.25 open water, and
    // above 1 a tree, which it leaves out of screen-space occlusion. So trees ADD their coverage to the 1 the sky
    // wrote under them. For the cards and meshes drawn before the terrain the same output is the multisample
    // coverage (alpha-to-coverage); the far cards are drawn after the terrain and blend by it.
    const tag = { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor };
    const cover = { ...tag, alphaToCoverage: true, blendSrc: THREE.OneFactor, blendDst: THREE.ZeroFactor };
    this.impostorMat = new THREE.ShaderMaterial({ defines: { ...defines }, uniforms: this.uni, vertexShader: IMPOSTOR_VERT(lightGlsl, false), fragmentShader: IMPOSTOR_FRAG(false), ...cover });
    this.farMat = new THREE.ShaderMaterial({ defines: { ...defines }, uniforms: this.uni, vertexShader: IMPOSTOR_VERT(lightGlsl, true), fragmentShader: IMPOSTOR_FRAG(true), ...tag, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
    this.nearMat = new THREE.ShaderMaterial({ defines: { ...defines }, uniforms: this.uni, vertexShader: NEAR_VERT(lightGlsl), fragmentShader: NEAR_FRAG, side: THREE.DoubleSide, ...cover });
    // The shade map is drawn with the darkest of what overlaps kept (see SHADE_VERT).
    this.shadeMat = new THREE.ShaderMaterial({
      defines: { ...defines }, uniforms: this.uni, vertexShader: SHADE_VERT(lightGlsl), fragmentShader: SHADE_FRAG,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.shadeScene = new THREE.Scene(); this.shadeScene.matrixWorldAutoUpdate = false;
    this.shadeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.shadeRT = null; this.shadeN = 0;
    /** The shade maps as they were last drawn: each one's middle (m) and half-width (m; 0: to be drawn afresh). */
    this.shadeLevels = Array.from({ length: TREE_SHADE_LEVELS }, () => ({ x: 1e9, z: 1e9, half: 0 }));
    this.shadeNext = 0; this.shadeTurn = false; this.shadeFbo = [];
    this.shadeSun = new THREE.Vector3(0, 1, 0); this.shadeDrawnSun = new THREE.Vector3(0, -1, 0);       // where the light comes from now, and where it came from a frame ago
    /** false: no shade is drawn or read (for measuring what it costs and what it does). */
    this.shadeOn = true;
    this.materials = [this.impostorMat, this.farMat, this.nearMat, this.shadeMat];

    // real meshes for the nearest trees, one instanced mesh per model, refilled as the camera moves
    this.near = V.map((v) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const k of ['position', 'normal', 'uv', 'aVtx']) g.setAttribute(k, v.geo.attributes[k]);
      g.setIndex(v.geo.index);
      const arr = {};
      for (const k of ['iA', 'iB', 'iC']) { arr[k] = new Float32Array(NEAR_CAP * 4); const a = new THREE.InstancedBufferAttribute(arr[k], 4); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(k, a); }
      g.instanceCount = 0;
      const m = new THREE.Mesh(g, this.nearMat);
      m.frustumCulled = false; m.matrixAutoUpdate = false; m.visible = false; m.renderOrder = -1;
      group.add(m);
      return { mesh: m, geo: g, arr, n: 0 };
    });
    this.nearAt = new THREE.Vector3(1e9, 0, 0); this.nearDirty = true;

    // The atlas needs the renderer, which first shows up when a frame is drawn: this mesh draws nothing and waits for it.
    const trigger = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
    trigger.frustumCulled = false; trigger.renderOrder = -2;
    trigger.onBeforeRender = (renderer) => { this.drawn++; if (this.baked !== this.tier.frame) this.bake(renderer); };
    group.add(trigger);

    this.shown = []; this.patches = new Set();
    this.fine = new Map();             // patch origin -> when its fine patch was built (the far tiles hand over to it)
    this.far = new Map();              // far tile origin -> tile
    this.frame = 0; this.builtAt = -9; this.farMs = 0; this.todo = [];
    this.now = 0; this.envT = 0; this.live = false; this.drawn = 0; this.drawnSeen = 0;
    this.layout = LAYOUT;
    this.farDone = []; this.farFlying = 0;        // far tiles back from the workers, waiting for room in a frame; and still out
    for (const m of this.materials) perf.tag(m, 'trees');
    this.setQuality('high');
  }

  /** 'low' | 'med' | 'high': how many trees and how far, how far the real meshes and the shade on the ground reach, how sharp the impostors are. */
  setQuality(level) {
    const t = TIERS[level] || TIERS.med;
    this.tier = t;
    this.uni.uLod.value.set(t.density, t.thin[0], t.thin[1], t.range);
    this.uni.uNear.value.set(Math.max(t.near - NEAR_BAND, 0), t.near, t.decal, 0);
    for (const m of this.materials) {
      if (level === 'low') Object.assign(m.defines, { SHADOW_STEPS: 6, SHADOW_GROWTH: '2.3', LOWQ: 1 });
      else { Object.assign(m.defines, { SHADOW_STEPS: 10, SHADOW_GROWTH: '1.65' }); delete m.defines.LOWQ; }
      m.needsUpdate = true;
    }
    this.nearDirty = true;
    this.shadeSize = SHADE_N[level] || SHADE_N.med;
    for (const L of this.shadeLevels) L.half = 0;       // the shadows reach a different distance now: draw every map afresh
  }

  /** Share of candidates drawn at a distance (treeKeep in the shaders). */
  keep(d) { const t = Math.max(d - this.tier.thin[0], 0) / this.tier.thin[1]; return this.tier.density / (1 + t * t); }

  /** Photograph every model from every direction into the two atlas textures. One draw of a flat scene. */
  bake(renderer) {
    const F = this.tier.frame, W = F * NA * NE, H = F * NV;
    const rt = new THREE.WebGLRenderTarget(W, H, { count: 2, depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    for (const t of rt.textures) { t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; }
    const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(0, W, H, 0, -4, 4);
    const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { tLeaf: { value: this.leafTex } }, vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, side: THREE.DoubleSide });
    const m = new THREE.Matrix4(), b = new THREE.Matrix4();
    this.variants.forEach((v, vi) => {
      for (let e = 0; e < NE; e++) for (let a = 0; a < NA; a++) {
        const el = (ELS[e] * Math.PI) / 180, az = (a / NA) * 2 * Math.PI;
        const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)], r = [Math.cos(az), 0, -Math.sin(az)], u = cross(d, r);
        const halfW = v.rc, halfH = v.hc * Math.cos(el) * FIT + v.rc * Math.sin(el);
        const sx = F / 2 / halfW, sy = F / 2 / halfH, sz = 1 / v.R;
        // tree space -> atlas pixels: rows of the rotation are the view's right, up and toward-the-camera axes
        b.set(r[0] * sx, r[1] * sx, r[2] * sx, (e * NA + a + 0.5) * F,
          u[0] * sy, u[1] * sy, u[2] * sy, (vi + 0.5) * F,
          d[0] * sz, d[1] * sz, d[2] * sz, 0,
          0, 0, 0, 1);
        const mesh = new THREE.Mesh(v.geo, mat);
        mesh.matrixAutoUpdate = false; mesh.frustumCulled = false;
        mesh.matrix.copy(b).multiply(m.makeTranslation(0, -v.hc, 0));
        scene.add(mesh);
      }
    });
    // Save and restore what the frame in progress depends on, as three's own mirror objects do.
    const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate, prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false; renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto; renderer.shadowMap.autoUpdate = prevShadow; renderer.xr.enabled = prevXr;
    mat.dispose();
    this.atlas?.dispose();
    this.atlas = rt; this.baked = F;
    this.uni.tTreeA.value = rt.textures[0]; this.uni.tTreeB.value = rt.textures[1];
    // The mip chain is usable down to where a frame is a whole number of texels: one a frame for 64 and 128, three for 96.
    this.uni.uAtlas.value.set(1 / (NA * NE), 1 / NV, F, Math.log2(F & -F));
  }

  /** Geometry shared by the cards and shadows of one patch or tile: a card per instance, plus values held once for all of them. */
  pack(base, count, A, B, C, born, quarters) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(base, 3));
    if (base === QUAD) g.setIndex(new THREE.BufferAttribute(QUAD_INDEX, 1));
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 4, true));
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 4, false));
    g.setAttribute('aC', new THREE.InstancedBufferAttribute(C, 4, true));
    // one element with a divisor no instance count reaches: every instance reads the same value
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array([born, 0, 0, 0]), 4, false, 1 << 24));
    if (quarters) g.setAttribute('aQ', new THREE.InstancedBufferAttribute(quarters, 4, false, 1 << 24));
    g.instanceCount = count;
    return g;
  }

  /**
   * The trees of one terrain patch, as treeplace.placeFine proposed them (the terrain has them worked out
   * along with the patch): make the meshes that draw them. Returns the patch's record, or null if nothing grows there.
   */
  apply(node, t) {
    const { x0, z0, size } = node, { lo, yr, count } = t;
    this.builtAt = this.frame;
    const now = this.live ? this.now : -NEVER;      // only a patch that arrives in flight fades in
    this.arrive(x0, z0, now);
    if (!count) return null;
    const p = { x0, z0, size, lo, yr, count, A: t.A, B: t.B, C: t.C, start: t.start, list: t.list };

    // One quad per tree; the impostors and the shade they throw (drawn into the shade maps, never on the screen) are two meshes over the same instances.
    const g = p.geo = this.pack(QUAD, count, p.A, p.B, p.C, now);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.75 + 90 / size);
    const mesh = (mat, into) => {
      const o = new THREE.Mesh(g, mat);
      o.position.set(x0, lo, z0); o.scale.set(size, yr, size);       // the instances hold positions as fractions of the patch
      o.matrixAutoUpdate = false; o.updateMatrix(); o.updateMatrixWorld(true); o.visible = false; o.renderOrder = -1;
      if (into !== this.group) o.frustumCulled = false;             // (the shade pass places its vertices itself: see SHADE_VERT)
      into.add(o);
      return o;
    };
    p.trees = mesh(this.impostorMat, this.group);  // drawn before the terrain: what they cover, it need not shade
    p.shade = mesh(this.shadeMat, this.shadeScene);        // drawn into the shade maps only (see shade)
    this.patches.add(p); this.nearDirty = true;
    this.upload?.(g);
    return p;
  }

  dispose(p) {
    this.group.remove(p.trees); this.shadeScene.remove(p.shade); p.geo.dispose();
    this.patches.delete(p); this.nearDirty = true;
    this.arrive(p.x0, p.z0, NEVER);
  }

  /** A fine patch came (when: the time) or went (when: NEVER): tell the far tile that covers the same ground. */
  arrive(x0, z0, when) {
    const key = x0 + ',' + z0;
    if (when === NEVER) this.fine.delete(key); else this.fine.set(key, when);
    const fx = Math.floor(x0 / FAR_SIZE) * FAR_SIZE, fz = Math.floor(z0 / FAR_SIZE) * FAR_SIZE, t = this.far.get(fx + ',' + fz);
    if (!t || !t.geo) return;
    const a = t.geo.attributes.aQ;
    a.array[(z0 > fz ? 2 : 0) + (x0 > fx ? 1 : 0)] = when; a.needsUpdate = true;
  }

  /**
   * What one far tile is placed from (treeplace.placeFar): the head of the candidate list of each of its four
   * patches, standing on the terrain as it is drawn at that distance. coarse: the terrain there is the 4 km
   * patch (128 m mesh, one zoom level down) instead of the 2 km one (64 m mesh). Returns null if the elevation
   * has not loaded yet.
   */
  prepareFar(t, coarse) {
    const { x0, z0 } = t, S = FAR_SIZE, z = zoomFor(coarse ? 2 * S : S);
    if (!dem.ensure(z, x0 - 64, z0 - 64, x0 + S + 64, z0 + S + 64, 6)) return null;
    const q = [];
    let town = false;
    for (let k = 0; k < 4; k++) {
      const bx = x0 + (k & 1) * PATCH, bz = z0 + (k >> 1) * PATCH, towny = townsIn(bx, bz, bx + PATCH, bz + PATCH);
      town = town || towny;
      q.push({ m: [moisture(bx, bz), moisture(bx + PATCH, bz), moisture(bx, bz + PATCH), moisture(bx + PATCH, bz + PATCH)], tl: treeline(bz + PATCH / 2), sea: oceanWoods(), towny, urban: null });
    }
    const urban = !town ? null : this.urbanCrop ? this.urbanCrop(x0, z0, x0 + S, z0 + S) : null;
    for (const e of q) e.urban = urban || { fn: urbanDensity };
    return {
      P: LAYOUT, x0, z0, coarse, region: [REGION.lat0, REGION.lon0], main: town && !urban,
      win: dem.cut(z, x0 - 32, z0 - 32, x0 + S + 32, z0 + S + 32),
      flats: flatsIn(x0 - 32, z0 - 32, x0 + S + 32, z0 + S + 32), q,
    };
  }

  /** Make a far tile's mesh from its placed trees (r: see treeplace.placeFar), in place of the one it had. */
  applyFar(t, coarse, r) {
    const { x0, z0 } = t, S = FAR_SIZE, n = r.n;
    if (t.mesh) { this.group.remove(t.mesh); t.geo.dispose(); t.mesh = t.geo = null; }
    t.coarse = coarse; t.count = n; t.built = true;
    if (!n) return;
    const { lo, yr } = r;
    const quarters = new Float32Array(4);
    for (let q = 0; q < 4; q++) quarters[q] = this.fine.get((x0 + (q & 1) * PATCH) + ',' + (z0 + (q >> 1) * PATCH)) ?? NEVER;
    // a tile rebuilt on a different mesh is already showing: only a new one fades in
    const g = t.geo = this.pack(FAR_TRI, n, r.A, r.B, r.C, t.born ?? (t.born = this.live ? this.now : -NEVER), quarters);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.75 + 220 / S);
    const o = t.mesh = new THREE.Mesh(g, this.farMat);
    o.position.set(x0, lo, z0); o.scale.set(S, yr, S);
    o.matrixAutoUpdate = false; o.updateMatrix(); o.visible = false; o.renderOrder = 1;      // after the terrain, which they blend over
    this.group.add(o);
    t.A = r.A; t.lo = lo; t.yr = yr;
    this.upload?.(g);
  }

  /** Place a far tile here and now, on the main thread. Returns false if the elevation has not loaded yet. */
  buildFar(t, coarse) {
    const job = this.prepareFar(t, coarse);
    if (!job) return false;
    this.applyFar(t, coarse, placeFar(job));
    return true;
  }

  /** Hand a far tile to a worker. Its answer waits in `farDone` until a frame has room to show it. Returns false if the elevation has not loaded yet. */
  sendFar(t, coarse) {
    const job = this.prepareFar(t, coarse);
    if (!job) return false;
    if (job.main) { this.applyFar(t, coarse, placeFar(job)); return true; }       // (a town, and no grid of the towns to send: see chunks.js)
    for (const e of job.q) if (e.urban && e.urban.fn) e.urban = null;
    const state = t.job = { coarse, result: null }, flats = job.flats, S = FAR_SIZE, transfer = buffersOf(job);
    job.flats = null;
    this.farFlying++;
    pool.run({ t: 'far', job, flats, rect: [t.x0 - 32, t.z0 - 32, t.x0 + S + 32, t.z0 + S + 32] }, transfer).then((r) => {
      this.farFlying--;
      perf.worker('tree tile', r.ms);
      if (t.job !== state || this.far.get(t.x0 + ',' + t.z0) !== t) return;     // the tile has gone, or the world with it
      state.result = r; this.farDone.push(t);
    }, (r) => {
      this.farFlying--;
      if (!r.dead) console.warn('A tree tile could not be placed in a worker:', r.err);
      if (t.job === state) t.job = null;
    });
    return true;
  }

  /** Keep far tiles around the camera out to the tier's range, building at most one a frame, and thin each for its distance. */
  /** The window of the world has moved: drop every far tile (the terrain disposes the fine patches itself). */
  reset() {
    for (const t of this.far.values()) if (t.mesh) { this.group.remove(t.mesh); t.geo.dispose(); }
    this.far.clear(); this.farDone.length = 0;
  }

  updateFar(cam, shared = true) {
    const S = FAR_SIZE, R = this.tier.range, far = this.far, cx = Math.floor(cam.x / S), cz = Math.floor(cam.z / S), n = Math.ceil(R / S) + 1;
    const todo = this.todo; todo.length = 0;
    const lim = WORLD_HALF - S;
    for (let j = cz - n; j <= cz + n; j++) for (let i = cx - n; i <= cx + n; i++) {
      const x0 = i * S, z0 = j * S;
      if (x0 < -lim || z0 < -lim || x0 > lim || z0 > lim) continue;
      const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + S)), dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + S)), d = Math.hypot(dx, dz);
      if (d > R + 200) continue;
      const key = x0 + ',' + z0;
      let t = far.get(key);
      if (!t) { t = { x0, z0, built: false, coarse: false, count: 0, mesh: null, geo: null, wait: 0, job: null }; far.set(key, t); }
      // Which mesh does the terrain draw here? The 4 km patch around this tile splits when the camera is within
      // SPLIT times its size (and merges again somewhat later: between the two, leave the tile as it is).
      const px = Math.floor(x0 / (2 * S)) * 2 * S, pz = Math.floor(z0 / (2 * S)) * 2 * S;
      const pd = Math.hypot(Math.max(px - cam.x, 0, cam.x - (px + 2 * S)), Math.max(pz - cam.z, 0, cam.z - (pz + 2 * S)), cam.y - (t.built && t.count ? t.lo + t.yr / 2 : 0));
      const coarse = !t.built ? pd > 2 * S * SPLIT : pd > 2 * S * 2.6 ? true : pd < 2 * S * SPLIT ? false : t.coarse;
      t.prio = d + (t.built ? 4000 : 0);                       // a tile that is missing matters more than one on the wrong mesh
      if (t.job && t.job.coarse !== coarse && (!t.built || coarse !== t.coarse)) t.job = null;      // what is on its way is no longer what is wanted
      if ((!t.built || coarse !== t.coarse) && !t.job && this.frame >= t.wait) { t.want = coarse; todo.push(t); }
    }
    const free = !shared || uploads.open || !this.live;
    // Tiles the workers have placed, nearest first: an instance buffer each for the graphics card, as the frame's budget allows.
    if (this.farDone.length) {
      perf.cpuBegin('tree upload');
      const done = this.farDone.filter((t) => t.job && t.job.result && far.get(t.x0 + ',' + t.z0) === t).sort((a, b) => a.prio - b.prio);
      let i = 0;
      for (; i < done.length; i++) {
        const t = done[i], r = t.job.result;
        if (!free && !uploads.take(r.n * 16)) break;
        const t0 = performance.now();
        this.applyFar(t, t.job.coarse, r); t.job = null;
        if (!free) uploads.spend(performance.now() - t0);
      }
      this.farDone = done.slice(i);
      perf.cpuEnd();
    }
    if (todo.length && pool.ok) {
      // a job a worker, behind the terrain's own patches
      perf.cpuBegin('tree dispatch');
      todo.sort((a, b) => a.prio - b.prio);
      for (const t of todo) {
        if (this.farFlying >= pool.size || (!free && (uploads.behind || this.farSent === this.frame))) break;      // one a frame, none on a late one
        this.farSent = this.frame;
        if (!this.sendFar(t, t.want)) t.wait = this.frame + (this.live ? 20 : 2);           // its elevation is on the way
      }
      perf.cpuEnd();
    } else if (todo.length && (!this.live || this.frame - this.builtAt > 1)) {
      // No workers. One tile a frame (a couple of milliseconds), none on a frame after the terrain built a patch
      // of its own, and none on a frame that is already late. While a flight is loading (no frames drawn) there
      // is no such hurry to be done: build for 20 ms at a time.
      perf.cpuBegin('tree build');
      todo.sort((a, b) => a.prio - b.prio);
      const t0 = performance.now(), budget = this.live ? 0 : 20;
      for (const t of todo) {
        if (!free && !uploads.take(FAR_MAX * 16)) break;
        const t1 = performance.now();
        if (!this.buildFar(t, t.want)) t.wait = this.frame + (this.live ? 20 : 2);          // its elevation is on the way
        if (!free) uploads.spend(performance.now() - t1);
        if (performance.now() - t0 >= budget) break;
      }
      this.farMs = performance.now() - t0;
      perf.cpuEnd();
    }
    const inner = HAND - HAND_BAND - HAND_JIT / 2;
    for (const [key, t] of far) {
      const dx = Math.max(t.x0 - cam.x, 0, cam.x - (t.x0 + S)), dz = Math.max(t.z0 - cam.z, 0, cam.z - (t.z0 + S));
      const dh = Math.hypot(dx, dz);
      if (dh > R + 3000) { if (t.mesh) { this.group.remove(t.mesh); t.geo.dispose(); } far.delete(key); continue; }
      if (!t.mesh) continue;
      const dy = Math.max(t.lo - cam.y, 0, cam.y - (t.lo + t.yr + 60)), d = Math.hypot(dh, dy);
      // nothing to draw if the tile is past the range, or wholly inside the hand-over distance with fine patches over all of it
      const q = t.geo.attributes.aQ.array, now = this.uni.uNow.value;
      const covered = now - q[0] > FADE_IN && now - q[1] > FADE_IN && now - q[2] > FADE_IN && now - q[3] > FADE_IN;
      const farthest = Math.hypot(Math.max(Math.abs(cam.x - t.x0), Math.abs(cam.x - t.x0 - S)), Math.max(Math.abs(cam.z - t.z0), Math.abs(cam.z - t.z0 - S)), Math.max(Math.abs(cam.y - t.lo), Math.abs(cam.y - t.lo - t.yr)));
      if (d > R || (covered && farthest < inner)) { t.mesh.visible = false; continue; }
      const wantRank = this.keep(covered ? Math.max(d, inner) : d) * 65535;
      let a = 0, b = t.count;
      while (a < b) { const m = (a + b) >> 1; if (t.A[m * 4 + 3] < wantRank) a = m + 1; else b = m; }
      t.geo.instanceCount = a; t.mesh.visible = a > 0;
    }
  }

  /** Start of a frame's terrain walk: nothing is shown until the walk asks for it. */
  begin() {
    for (const p of this.shown) { p.trees.visible = false; p.inReach = false; }
    this.shown.length = 0;
  }
  show(p) { this.shown.push(p); }

  /** After the walk: thin each patch for its distance, look after the far tiles, and refill the near meshes when the camera has moved.
   *  shared: false while a flight is loading and no frame is at stake (see Terrain.update). */
  update(cam, shared = true) {
    const t = this.tier;
    perf.cpuBegin('trees');
    this.frame++;
    // A clock of our own for the fades: it never runs backward (the game's restarts with each flight), and it
    // only counts as running while frames are being drawn (patches built while a flight loads are simply there).
    const et = ENV.uTime.value;
    this.now += clamp(et - this.envT, 0, 0.1); this.envT = et;
    this.live = this.drawn !== this.drawnSeen; this.drawnSeen = this.drawn;
    this.uni.uNow.value = this.now; this.uni.uHand.value.w = this.frame % 64;
    const reach = Math.min(HAND + HAND_JIT / 2, t.range);
    for (const p of this.shown) {
      const dx = Math.max(p.x0 - cam.x, 0, cam.x - (p.x0 + p.size)), dz = Math.max(p.z0 - cam.z, 0, cam.z - (p.z0 + p.size));
      const dy = Math.max(p.lo - cam.y, 0, cam.y - (p.lo + p.yr + 40)), d = Math.sqrt(dx * dx + dz * dz + dy * dy);
      if (d > reach) continue;
      // ranks rise along the list, so the trees still wanted at this distance are a leading run of it
      let a = 0, b = p.count; const want = this.keep(d) * 65535;
      while (a < b) { const m = (a + b) >> 1; if (p.A[m * 4 + 3] < want) a = m + 1; else b = m; }
      if (!a) continue;
      p.geo.instanceCount = a; p.trees.visible = true; p.inReach = d < t.decal + SHADE_REACH;
    }
    this.updateFar(cam, shared);
    if (t.near > 0 && (this.nearDirty || this.nearAt.distanceToSquared(cam) > 36)) this.gather(cam);
    else if (t.near <= 0 && this.nearDirty) { for (const n of this.near) n.mesh.visible = false; this.nearDirty = false; }
    perf.cpuEnd();
  }

  /**
   * Draw the shade of the trees into its maps: once a frame, after update() and before the scene is drawn.
   * eye: the camera's position. sunny: 1 in clear sun .. 0 with none (overcast), when the shade lies under the crowns.
   *
   * There are TREE_SHADE_LEVELS maps, one inside the other, each fixed to the ground and re-centered on the
   * camera in whole texels. What a map holds only changes slowly (a tree growing in at the edge of the thinning,
   * the sun's march), so one map is redrawn every other frame, in turn; a map the camera has left behind (a new
   * flight, a change of view) is redrawn at once, and all of them when the light jumps (the clock is set). A map
   * redrawn around a new middle lands on the same texels of the ground as before (the middle moves in whole
   * texels), so the redrawing itself cannot be seen.
   */
  shade(renderer, eye, sunny = 1) {
    const P = ENV.uTreeShadeP.value, A = ENV.uTreeShadeA.value, N = this.shadeSize, R = this.tier.decal;
    if (!this.shadeOn || !this.atlas || !(R > 0)) { P.x = 0; return; }
    perf.begin('tree shade');
    if (!this.shadeRT || this.shadeN !== N) {
      this.shadeRT?.dispose();
      const rt = this.shadeRT = new THREE.WebGLArrayRenderTarget(N, N, TREE_SHADE_LEVELS, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: false,
        generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      renderer.initRenderTarget(rt);               // (this makes the whole chain of smaller copies once, which gives them their storage)
      rt.texture.generateMipmaps = false;          // from here on they are made by hand, for the one map drawn: see below
      // Only the first few smaller copies are kept up to date and only they are ever read: ground is never seen
      // from so far that a map's texel is under a sixteenth of a pixel, the next map out has it long before.
      const gl = renderer.getContext(), tex = renderer.properties.get(rt.texture).__webglTexture;
      renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, SHADE_MIPS);
      renderer.state.unbindTexture();
      for (const f of this.shadeFbo) gl.deleteFramebuffer(f);
      this.shadeFbo = [];
      for (let l = 0; l < TREE_SHADE_LEVELS; l++) for (let m = 0; m <= SHADE_MIPS; m++) {
        const f = gl.createFramebuffer();
        renderer.state.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, m, l);
        this.shadeFbo.push(f);
      }
      this.shadeN = N; ENV.tTreeShade.value = rt.texture;
      for (const L of this.shadeLevels) L.half = 0;
    }
    // Where the light comes from: the sun (never lower than eight degrees: a very low sun would throw the shade to
    // the horizon), or with no sun to speak of straight overhead.
    const sun = ENV.uSunDir.value, k = clamp(sunny, 0, 1) * smoothstep(0.02, 0.07, sun.y), L = this.uni.uShadeL.value;
    const sx = sun.x * k, sy = 1 + (Math.max(sun.y, 0.14) - 1) * k, sz = sun.z * k, sl = Math.hypot(sx, sy, sz);
    L.set(sx / sl, sy / sl, sz / sl, k);
    const turned = this.shadeSun.set(L.x, L.y, L.z).angleTo(this.shadeDrawnSun) > 0.01;        // since the last frame: a jump of the clock (the sun's own march is followed map by map, in turn)
    this.shadeDrawnSun.copy(this.shadeSun);
    // which maps to draw: any that the camera has left the middle of, or that has never been drawn; else the next in turn
    const todo = [], last = TREE_SHADE_LEVELS - 1, outer = R * 1.04;
    for (let l = 0; l <= last; l++) {
      const S = this.shadeLevels[l], half = SHADE_INNER * Math.pow(outer / SHADE_INNER, l / last);
      if (turned || S.half !== half || Math.max(Math.abs(eye.x - S.x), Math.abs(eye.z - S.z)) > 0.2 * half) todo.push(l);
    }
    if (!todo.length && (this.shadeTurn = !this.shadeTurn)) { todo.push(this.shadeNext); this.shadeNext = (this.shadeNext + 1) % TREE_SHADE_LEVELS; }
    P.set(1, 1 - k, 1 / N, Math.pow(outer / SHADE_INNER, 1 / last));
    if (!todo.length) { perf.end(); return; }
    const prevRT = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate, gl = renderer.getContext();
    renderer.shadowMap.autoUpdate = false; renderer.autoClear = true; renderer.setClearColor(0x000000, 0);
    this.uni.uShadeEye.value.copy(eye);
    for (const l of todo) {
      const S = this.shadeLevels[l], half = SHADE_INNER * Math.pow(outer / SHADE_INNER, l / last), texel = 2 * half / N;
      S.half = half; S.x = Math.round(eye.x / texel) * texel; S.z = Math.round(eye.z / texel) * texel;
      this.uni.uShadeM.value.set(S.x, S.z, 1 / half, texel);
      const reach = half + SHADE_REACH;
      for (const p of this.shown) p.shade.visible = !!p.inReach && p.x0 < S.x + reach && p.x0 + p.size > S.x - reach && p.z0 < S.z + reach && p.z0 + p.size > S.z - reach;
      renderer.setRenderTarget(this.shadeRT, l);
      renderer.render(this.shadeScene, this.shadeCam);
      // The smaller copies of this map, for ground seen far off or at a shallow angle: each the average of four
      // texels of the one before. (Done for this map alone: the texture's own mipmap call would redo all of them.)
      for (let m = 1, w = N; m <= SHADE_MIPS; m++, w >>= 1) {
        renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, this.shadeFbo[l * (SHADE_MIPS + 1) + m - 1]);
        renderer.state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.shadeFbo[l * (SHADE_MIPS + 1) + m]);
        gl.blitFramebuffer(0, 0, w, w, 0, 0, w >> 1, w >> 1, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      }
      renderer.state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      A[l].set(S.x, S.z, 0.5 / half, half);
    }
    for (const p of this.shown) p.shade.visible = false;
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto; renderer.shadowMap.autoUpdate = prevShadow;
    perf.end();
  }

  /** Collect the candidates within reach of the camera into the per-model instance buffers of the real meshes. */
  gather(cam) {
    const R = this.tier.near + 24, R2 = R * R;
    this.nearAt.copy(cam); this.nearDirty = false;
    const ox = Math.round(cam.x / 64) * 64, oz = Math.round(cam.z / 64) * 64;
    for (const n of this.near) n.n = 0;
    const put = (n, x, y, z, p, i, as) => {
      if (n.n >= NEAR_CAP) return;
      const o = n.n++ * 4, A = n.arr.iA, B = n.arr.iB, C = n.arr.iC, q = i * 4;
      A[o] = x - ox; A[o + 1] = y; A[o + 2] = z - oz; A[o + 3] = p.A[q + 3] / 65535;
      B[o] = p.B[q]; B[o + 1] = p.B[q + 1] + 256 * as; B[o + 2] = p.B[q + 2]; B[o + 3] = p.B[q + 3];
      C[o] = p.C[q] / 127; C[o + 1] = p.C[q + 1] / 127; C[o + 2] = p.C[q + 2] / 127; C[o + 3] = p.C[q + 3] / 127;
    };
    for (const p of this.patches) {
      if (cam.x < p.x0 - R || cam.x > p.x0 + p.size + R || cam.z < p.z0 - R || cam.z > p.z0 + p.size + R || cam.y < p.lo - R || cam.y > p.lo + p.yr + R + 60) continue;
      const cs = p.size / GRID;
      const gx0 = Math.max(0, Math.floor((cam.x - R - p.x0) / cs)), gx1 = Math.min(GRID - 1, Math.floor((cam.x + R - p.x0) / cs));
      const gz0 = Math.max(0, Math.floor((cam.z - R - p.z0) / cs)), gz1 = Math.min(GRID - 1, Math.floor((cam.z + R - p.z0) / cs));
      for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
        for (let k = p.start[gz * GRID + gx], e = p.start[gz * GRID + gx + 1]; k < e; k++) {
          const i = p.list[k], q = i * 4;
          const x = p.x0 + (p.A[q] / 65535) * p.size, y = p.lo + (p.A[q + 1] / 65535) * p.yr, z = p.z0 + (p.A[q + 2] / 65535) * p.size;
          const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
          if (dx * dx + dy * dy + dz * dz > R2) continue;
          const code = p.B[q], vi = code & 15;
          put(this.near[vi], x, y, z, p, i, vi);
          // the shader may turn a broadleaf into a plantation pine; offer that mesh the tree as well
          if (vi >= 12) { const alt = (code >> 6) & 1 ? 9 : 7; put(this.near[alt], x, y, z, p, i, alt); }
        }
      }
    }
    for (const n of this.near) {
      n.mesh.visible = n.n > 0;
      if (!n.n) continue;
      n.geo.instanceCount = n.n;
      n.mesh.position.set(ox, 0, oz); n.mesh.updateMatrix();
      for (const k of ['iA', 'iB', 'iC']) { const a = n.geo.attributes[k]; a.clearUpdateRanges(); a.addUpdateRange(0, n.n * 4); a.needsUpdate = true; }
    }
  }
}
