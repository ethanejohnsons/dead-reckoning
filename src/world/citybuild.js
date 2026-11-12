// Turns one vector tile of building footprints into meshes. Pure arithmetic on typed arrays (no DOM, no
// three.js objects), so it runs in the city worker and can be exercised from Node.
//
//   parseTile   the tile's `building` layer -> a list of buildings in metres from the tile's north-west
//               corner (+x east, +z south), each with a height, a kind and its colours decided once, so
//               every level of detail of a tile agrees about them
//   buildLevel  one level of detail of a tile (or of one quarter of it) -> vertex and index arrays in
//               chunks of at most 60,000 vertices, the footprints for collision, and the obstruction lights
//   (the near level also carries the tile's roads as ribbons laid on the ground: see buildRoads)
//
// Levels:  'near'  everything, with pitched roofs on houses and plant on big flat roofs
//          'mid'   buildings of 350 m2 or 12 m and over, outlines simplified, flat roofs
//          'tall'  buildings of 35 m and over as plain prisms: the skyline
//
// Vertex layout (28 bytes): position f32 x3 (tile-local x, absolute height, tile-local z), normal i8 x4,
// aUV i16 x2 (metres along the wall and above the ground, in eighths), colour u8 x4 (rgb, a = a random
// number per building), aK u8 x4 (what the surface is, how its wall is glazed (+8 on a building that only
// the near level draws), and where to sample the satellite picture: the offset in metres to the
// building's middle + 128, or 128, 128 to sample under the pixel itself).

import earcut from 'three/src/extras/lib/earcut.js';
import { decodeTile, ringArea2 } from './mvt.js';
import { parseBridges } from './bridgebuild.js';

export const TALL = 35, MID_AREA = 350, MID_H = 12;
const CHUNK = 60000;
export const K_WALL = 0, K_FLAT = 1, K_PITCH = 2, K_PLANT = 3, K_UNDER = 4;
export const S_BLANK = 0, S_HOUSE = 1, S_PUNCHED = 2, S_GLASS = 3, S_RIBBON = 4;

// ------------------------------------------------------------------ small helpers

function hash32(a, b, c, d) {
  let h = (a * 0x9e3779b1) ^ (b * 0x85ebca6b) ^ (c * 0xc2b2ae35) ^ (d * 0x27d4eb2f);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
const frac = (h, k) => (((h >>> (k * 5)) ^ Math.imul(h, 0x9e3779b1 + k * 2)) >>> 8 & 0xffff) / 65536;

/** Shoelace area of a ring [x0, z0, ...] (positive for an outer ring as the tiles wind them). */
function area(p) { let a = 0; for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1]; return a / 2; }

function inRing(x, z, p) {
  let c = false;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) if ((p[i + 1] > z) !== (p[j + 1] > z) && x < p[i] + ((z - p[i + 1]) / (p[j + 1] - p[i + 1])) * (p[j] - p[i])) c = !c;
  return c;
}

/** Sutherland-Hodgman: the part of a ring with a * x + b * z + c >= 0. */
function clipHalf(p, a, b, c) {
  const out = [];
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const dj = a * p[j] + b * p[j + 1] + c, di = a * p[i] + b * p[i + 1] + c;
    if ((dj >= 0) !== (di >= 0)) { const t = dj / (dj - di); out.push(p[j] + (p[i] - p[j]) * t, p[j + 1] + (p[i + 1] - p[j + 1]) * t); }
    if (di >= 0) out.push(p[i], p[i + 1]);
  }
  return out;
}
function clipBox(p, size) {
  let r = clipHalf(p, 1, 0, 0); if (r.length < 6) return null;
  r = clipHalf(r, -1, 0, size); if (r.length < 6) return null;
  r = clipHalf(r, 0, 1, 0); if (r.length < 6) return null;
  r = clipHalf(r, 0, -1, size); if (r.length < 6) return null;
  return r;
}

/** Drop repeated points and (tol > 0) points that stand less than `tol` metres off the line through their neighbours. */
function tidy(p, tol) {
  const pts = [];
  for (let i = 0; i < p.length; i += 2) { const n = pts.length; if (n && Math.abs(pts[n - 2] - p[i]) < 0.02 && Math.abs(pts[n - 1] - p[i + 1]) < 0.02) continue; pts.push(p[i], p[i + 1]); }
  if (pts.length >= 4 && Math.abs(pts[0] - pts[pts.length - 2]) < 0.02 && Math.abs(pts[1] - pts[pts.length - 1]) < 0.02) pts.length -= 2;
  const n = pts.length / 2;
  if (!(tol > 0) || n <= 4) return pts;
  const keep = new Uint8Array(n).fill(1); let left = n;
  for (let i = 0; i < n && left > 4; i++) {
    let a = i - 1; while (a >= 0 && !keep[a]) a--;
    if (a < 0) { a = n - 1; while (a > i && !keep[a]) a--; }
    const c = (i + 1) % n;
    const ax = pts[2 * a], az = pts[2 * a + 1], ex = pts[2 * c] - ax, ez = pts[2 * c + 1] - az, l = Math.hypot(ex, ez);
    const d = l < 1e-6 ? Math.hypot(pts[2 * i] - ax, pts[2 * i + 1] - az) : Math.abs((pts[2 * i] - ax) * ez - (pts[2 * i + 1] - az) * ex) / l;
    if (d < tol) { keep[i] = 0; left--; }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

const NAMED = { white: 'ffffff', whitesmoke: 'f5f5f5', ivory: 'fffff0', beige: 'f5f5dc', tan: 'd2b48c', khaki: 'f0e68c', gray: '808080', grey: '808080', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', lightgray: 'd3d3d3', lightgrey: 'd3d3d3', silver: 'c0c0c0', dimgray: '696969', black: '000000', brown: '8b5a3c', maroon: '800000', red: 'b03020', firebrick: 'b22222', orange: 'd08030', yellow: 'e0d060', green: '407040', blue: '4060a0', navy: '202850', teal: '306e6e', pink: 'e0b0b0', sienna: 'a0522d', peru: 'cd853f', wheat: 'f5deb3', gold: 'd4af37', lightblue: 'add8e6', steelblue: '4682b4', slategray: '708090', sandybrown: 'f4a460', burlywood: 'deb887', bisque: 'ffe4c4', linen: 'faf0e6', cream: 'fffdd0', saddlebrown: '8b4513', chocolate: '7b3f00', darkred: '8b0000', darkgreen: '006400', lightyellow: 'ffffe0', gainsboro: 'dcdcdc', antiquewhite: 'faebd7' };
/** A CSS colour from the map -> a wall albedo, or null. */
function parseColour(s) {
  if (typeof s !== 'string') return null;
  let h = s.trim().toLowerCase();
  if (h[0] === '#') h = h.slice(1); else h = NAMED[h.replace(/[\s_-]/g, '')];
  if (!h) return null;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const c = [0, 2, 4].map((i) => Math.pow(parseInt(h.slice(i, i + 2), 16) / 255, 2.2));
  return c.map((v) => Math.min(0.72, Math.max(0.035, v * 0.85)));
}

// Albedos. Houses: siding, brick; their roofs: shingle. Blocks: brick, concrete, stone; flat roofs: gravel, membrane.
const SIDING = [[0.70, 0.69, 0.66], [0.64, 0.61, 0.52], [0.47, 0.48, 0.49], [0.37, 0.42, 0.49], [0.54, 0.47, 0.36], [0.42, 0.46, 0.38], [0.40, 0.21, 0.16], [0.66, 0.59, 0.38], [0.34, 0.26, 0.20], [0.74, 0.73, 0.71], [0.58, 0.60, 0.61]];
const SHINGLE = [[0.15, 0.15, 0.16], [0.10, 0.10, 0.11], [0.21, 0.165, 0.13], [0.25, 0.25, 0.25], [0.24, 0.145, 0.12], [0.19, 0.215, 0.19], [0.30, 0.29, 0.275]];
const MASONRY = [[0.40, 0.23, 0.17], [0.48, 0.32, 0.23], [0.54, 0.47, 0.38], [0.34, 0.19, 0.15], [0.50, 0.48, 0.44], [0.58, 0.56, 0.51], [0.44, 0.30, 0.22], [0.62, 0.58, 0.50], [0.36, 0.35, 0.34]];
const FLATROOF = [[0.34, 0.33, 0.31], [0.10, 0.10, 0.11], [0.66, 0.66, 0.64], [0.17, 0.165, 0.16], [0.42, 0.41, 0.39], [0.26, 0.25, 0.24]];
const SHED = [[0.60, 0.60, 0.58], [0.52, 0.50, 0.45], [0.46, 0.47, 0.47], [0.66, 0.64, 0.58], [0.40, 0.44, 0.50], [0.56, 0.52, 0.44]];
const GLASS = [[0.10, 0.15, 0.22], [0.09, 0.17, 0.165], [0.19, 0.145, 0.10], [0.27, 0.30, 0.33], [0.045, 0.05, 0.055], [0.13, 0.19, 0.25], [0.08, 0.11, 0.16]];
const TOWER = [[0.55, 0.53, 0.49], [0.46, 0.44, 0.40], [0.62, 0.60, 0.56], [0.30, 0.27, 0.24], [0.36, 0.24, 0.18], [0.50, 0.42, 0.34], [0.40, 0.40, 0.41], [0.66, 0.63, 0.57]];
const pick = (list, h, k) => { const c = list[Math.floor(frac(h, k) * list.length) % list.length], s = 0.9 + 0.2 * frac(h, k + 3); return [c[0] * s, c[1] * s, c[2] * s]; };

// Roads drawn, by the map's class: half the width of the made road (m; a motorway's carriageways are mapped one by one), and a rank 0..1 (how strongly it is drawn).
const ROAD = { motorway: [6.4, 1], trunk: [5.6, 0.9], primary: [5.4, 0.9], secondary: [4.6, 0.8], tertiary: [3.9, 0.7], minor: [3.3, 0.5] };       // (ranks in tenths: they are packed with the width)

// ------------------------------------------------------------------ the tile

/**
 * Read the buildings of a tile. buf: the tile's bytes; size: metres across the tile; tx, ty: its indices
 * (only to make each building's random numbers its own).
 */
export function parseTile(buf, size, tx, ty) {
  const layers = decodeTile(buf, { building: true, transportation: true, water: true, waterway: true });
  const L = layers.building, blds = [], roads = [];
  const br = parseBridges(layers, size);            // the tile's bridges, and what passes under them (world/bridgebuild.js)
  const T = layers.transportation;
  if (T) for (const f of T.features) {
    const w = ROAD[f.props.class];
    if (f.type !== 2 || !w || f.props.brunnel === 'tunnel' || f.props.brunnel === 'bridge') continue;      // (a bridge would be laid on the river: bridges are built as structures, in world/bridgebuild.js)
    const k = size / T.extent;
    for (const g of f.geom) { if (g.length < 4) continue; const p = new Float32Array(g.length); for (let i = 0; i < g.length; i++) p[i] = g[i] * k; roads.push({ p, hw: f.props.ramp ? w[0] * 0.75 : w[0], rank: w[1] }); }
  }
  if (!L) return { blds, roads, size, tall: 0, br };
  const ext = L.extent, k = size / ext, lo = -0.0155 * ext, hi = ext * 1.0155;
  for (const f of L.features) {
    if (f.type !== 3 || f.props.hide_3d) continue;
    const h = +f.props.render_height || 5, mh = Math.max(0, +f.props.render_min_height || 0);
    if (h - mh < 0.8) continue;
    const col = parseColour(f.props.colour);
    let cur = null;
    for (const g of f.geom) {
      if (g.length < 6) continue;
      const outer = ringArea2(g) > 0;
      if (!outer && !cur) continue;
      let cut = false;
      for (let i = 0; i < g.length; i++) if (g[i] <= lo || g[i] >= hi) { cut = true; break; }
      let p = new Array(g.length);
      for (let i = 0; i < g.length; i++) p[i] = g[i] * k;
      if (cut) { p = clipBox(p, size); if (!p) { if (outer) cur = null; continue; } }
      p = tidy(p, 0.12);
      if (p.length < 6) { if (outer) cur = null; continue; }
      if (!outer) { if (cur && area(p) < -2) cur.holes.push(Float32Array.from(p)); continue; }
      const A = area(p);
      if (A < 6) { cur = null; continue; }
      let cx = 0, cz = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
        const w = p[j] * p[i + 1] - p[i] * p[j + 1]; cx += (p[j] + p[i]) * w; cz += (p[j + 1] + p[i + 1]) * w;
        if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1];
      }
      cx /= 6 * A; cz /= 6 * A;
      if (!(cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1)) { cx = (x0 + x1) / 2; cz = (z0 + z1) / 2; }
      // A building whole in this tile's margin belongs to the neighbour its middle lies in.
      if (!cut && (cx < 0 || cx >= size || cz < 0 || cz >= size)) { cur = null; continue; }
      cur = { ring: Float32Array.from(p), holes: [], h, mh, known: h !== 5, col, area: A, cx: Math.min(size - 0.01, Math.max(0, cx)), cz: Math.min(size - 0.01, Math.max(0, cz)), box: [x0, z0, x1, z1], cut };
      blds.push(cur);
    }
  }
  classify(blds, size, tx, ty);
  let tall = 0; for (const b of blds) if (b.top >= TALL) tall++;
  return { blds, roads, size, tall, br };
}

/** Decide each building's height where the map gives none, what kind of building it is, and its colours. */
function classify(blds, size, tx, ty) {
  // How built-up each part of the tile is: the mean known height over all the footprint there (a downtown
  // scores tens of metres, streets of houses nothing).
  const G = 8, cell = size / G, hA = new Float32Array(G * G), aA = new Float32Array(G * G);
  for (const b of blds) {
    const k = Math.min(G - 1, Math.floor(b.cz / cell)) * G + Math.min(G - 1, Math.floor(b.cx / cell));
    aA[k] += b.area; if (b.known && b.h >= 9 && b.mh === 0) hA[k] += b.h * b.area;
  }
  const ctx = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    let h = 0, a = 1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const x = i + di, y = j + dj; if (x < 0 || y < 0 || x >= G || y >= G) continue; const w = di || dj ? 0.5 : 1; h += hA[y * G + x] * w; a += aA[y * G + x] * w; }
    ctx[j * G + i] = h / a;
  }
  for (const b of blds) {
    const hs = b.hash = hash32(tx, ty, Math.round(b.cx), Math.round(b.cz));
    const r1 = frac(hs, 0), r2 = frac(hs, 1), r3 = frac(hs, 2), r4 = frac(hs, 3);
    const A = b.area - b.holes.reduce((s, h) => s - area(h), 0);
    const c = ctx[Math.min(G - 1, Math.floor(b.cz / cell)) * G + Math.min(G - 1, Math.floor(b.cx / cell))];
    let H = b.h - b.mh, roof = 'flat', kind, eave = 0;
    const part = b.mh > 0, simple = !b.cut && !b.holes.length && !part && b.ring.length <= 24;
    if (!b.known) {
      if (A < 45) H = 2.7 + 0.7 * r1;
      else if (A < 330) H = c > 16 ? 7 + 7 * r1 : (r1 < 0.45 ? 3.0 : 5.6);
      else if (A < 1200) H = 6.5 + 6 * r1 * r1 + Math.min(c * 0.5, 22) * r2;
      else H = 6.5 + 4 * r1 + Math.min(c * 0.6, 32) * r2;
    }
    if (H >= 40) kind = 'tower';
    else if (H >= 14) kind = 'mid';
    else if (A < 45 && !part) kind = 'garage';
    else if (A < 330 && H <= 10.5 && simple && c <= 16) kind = 'house';
    else if (A >= 1200) kind = 'box';
    else kind = 'low';
    let style, wall, top;
    if (kind === 'house' || kind === 'garage') {
      style = kind === 'house' ? S_HOUSE : S_BLANK;
      wall = pick(SIDING, hs, 4); top = pick(SHINGLE, hs, 5);
      roof = kind === 'garage' && (A < 30 || r2 < 0.25) ? 'flat' : r3 < 0.42 ? 'hip' : 'gable';
      eave = b.known ? Math.max(2.6, H - 2.2) : H;
    } else if (kind === 'box') { style = r3 < 0.25 ? S_PUNCHED : S_BLANK; wall = pick(SHED, hs, 4); top = pick(FLATROOF, hs, 5); }
    else if (kind === 'low') { style = S_PUNCHED; wall = pick(MASONRY, hs, 4); top = pick(FLATROOF, hs, 5); }
    else if (kind === 'mid') { style = r3 < 0.58 ? S_PUNCHED : r3 < 0.82 ? S_RIBBON : S_GLASS; wall = style === S_GLASS ? pick(GLASS, hs, 4) : r4 < 0.6 ? pick(MASONRY, hs, 4) : pick(TOWER, hs, 4); top = pick(FLATROOF, hs, 5); }
    else { style = r3 < 0.55 ? S_GLASS : r3 < 0.82 ? S_RIBBON : S_PUNCHED; wall = style === S_GLASS ? pick(GLASS, hs, 4) : pick(TOWER, hs, 4); top = pick(FLATROOF, hs, 5); }
    if (b.col && style !== S_GLASS) wall = b.col;
    else if (b.col && style === S_GLASS) wall = b.col.map((v, i) => 0.45 * v + 0.55 * wall[i] * 0.6);
    b.H = H; b.top = b.mh + H; b.kind = kind; b.style = style; b.wall = wall; b.roofCol = top; b.roof = roof; b.eave = eave; b.A = A;
    b.small = !(A >= MID_AREA || b.top >= MID_H);
    b.q = (b.cx >= size / 2 ? 1 : 0) + (b.cz >= size / 2 ? 2 : 0);
    b.seed = (hs >>> 9) & 255;
  }
}

// ------------------------------------------------------------------ output buffers

export class Out {
  constructor() {
    this.cap = 8192; this.icap = 16384;
    this.pos = new Float32Array(this.cap * 3); this.nrm = new Int8Array(this.cap * 4); this.uv = new Int16Array(this.cap * 2);
    this.col = new Uint8Array(this.cap * 4); this.k = new Uint8Array(this.cap * 4); this.idx = new Uint16Array(this.icap);
    this.n = 0; this.ni = 0; this.chunks = []; this.ranges = new Uint32Array(8); this.q = -1; this.qStart = 0;
    this.c = [0, 0, 0]; this.seed = 0; this.kind = 0; this.style = 0;
    this.central = false; this.cenX = 0; this.cenZ = 0;        // roofs of a small building sample the picture at its middle
    this.raw = false; this.kz = 0; this.kw = 0;                 // (bridges put two numbers of their own there instead)
  }
  /** Make room for nv more vertices and ni more indices, starting a new chunk when this one is full. */
  need(nv, ni) {
    if (this.n + nv > CHUNK && this.n) { const q = this.q; this.flush(); this.quadrant(q); }
    if (this.n + nv > this.cap) {
      while (this.n + nv > this.cap) this.cap *= 2;
      const g = (A, per) => { const a = new A(this.cap * per); return a; };
      let a = g(Float32Array, 3); a.set(this.pos.subarray(0, this.n * 3)); this.pos = a;
      a = g(Int8Array, 4); a.set(this.nrm.subarray(0, this.n * 4)); this.nrm = a;
      a = g(Int16Array, 2); a.set(this.uv.subarray(0, this.n * 2)); this.uv = a;
      a = g(Uint8Array, 4); a.set(this.col.subarray(0, this.n * 4)); this.col = a;
      a = g(Uint8Array, 4); a.set(this.k.subarray(0, this.n * 4)); this.k = a;
    }
    if (this.ni + ni > this.icap) { while (this.ni + ni > this.icap) this.icap *= 2; const a = new Uint16Array(this.icap); a.set(this.idx.subarray(0, this.ni)); this.idx = a; }
  }
  colour(c, seed) { this.c = c; this.seed = seed; }
  v(x, y, z, nx, ny, nz, u, h) {
    const n = this.n++, a = n * 3, b = n * 4;
    this.pos[a] = x; this.pos[a + 1] = y; this.pos[a + 2] = z;
    this.nrm[b] = Math.round(nx * 127); this.nrm[b + 1] = Math.round(ny * 127); this.nrm[b + 2] = Math.round(nz * 127);
    this.uv[n * 2] = Math.max(-32768, Math.min(32767, Math.round(u * 8))); this.uv[n * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(h * 8)));
    const c = this.c;
    this.col[b] = Math.min(255, c[0] * 255 + 0.5); this.col[b + 1] = Math.min(255, c[1] * 255 + 0.5); this.col[b + 2] = Math.min(255, c[2] * 255 + 0.5); this.col[b + 3] = this.seed;
    this.k[b] = this.kind; this.k[b + 1] = this.style;
    if (this.central) { this.k[b + 2] = Math.max(1, Math.min(255, Math.round(this.cenX - x) + 128)); this.k[b + 3] = Math.max(1, Math.min(255, Math.round(this.cenZ - z) + 128)); } else if (this.raw) { this.k[b + 2] = this.kz; this.k[b + 3] = this.kw; } else { this.k[b + 2] = 128; this.k[b + 3] = 128; }
    return n;
  }
  tri(a, b, c) { this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c; }
  /** A triangle that must face up (or down), whichever way its corners were given. */
  triUp(a, b, c, down = false) {
    const p = this.pos, ux = p[b * 3] - p[a * 3], uz = p[b * 3 + 2] - p[a * 3 + 2], vx = p[c * 3] - p[a * 3], vz = p[c * 3 + 2] - p[a * 3 + 2];
    if ((uz * vx - ux * vz >= 0) !== down) this.tri(a, b, c); else this.tri(a, c, b);
  }
  /** What follows belongs to quarter q of the tile (its index range is recorded for the chunk). */
  quadrant(q) {
    if (this.q >= 0) { this.ranges[this.q * 2] = this.qStart; this.ranges[this.q * 2 + 1] = this.ni - this.qStart; }
    this.q = q; this.qStart = this.ni;
  }
  flush() {
    this.quadrant(-1);
    if (this.ni) {
      const n = this.n, p = this.pos;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < n * 3; i += 3) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2]; }
      this.chunks.push({
        pos: this.pos.slice(0, n * 3), nrm: this.nrm.slice(0, n * 4), uv: this.uv.slice(0, n * 2), col: this.col.slice(0, n * 4), k: this.k.slice(0, n * 4), idx: this.idx.slice(0, this.ni),
        ranges: this.ranges.slice(), bounds: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2], verts: n, tris: this.ni / 3,
      });
    }
    this.n = 0; this.ni = 0; this.ranges = new Uint32Array(8); this.qStart = 0;
  }
}

// ------------------------------------------------------------------ one building

/** The smallest rectangle round a ring that lies along one of its edges: centre, long axis, half length and half width. */
function boundingRect(p) {
  let best = null;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const ex = p[i] - p[j], ez = p[i + 1] - p[j + 1], l = Math.hypot(ex, ez);
    if (l < 0.5) continue;
    const ax = ex / l, az = ez / l;
    let s0 = Infinity, s1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    for (let k = 0; k < n; k += 2) { const s = p[k] * ax + p[k + 1] * az, d = -p[k] * az + p[k + 1] * ax; if (s < s0) s0 = s; if (s > s1) s1 = s; if (d < d0) d0 = d; if (d > d1) d1 = d; }
    const a = (s1 - s0) * (d1 - d0);
    if (!best || a < best.a) best = { a, ax, az, s0, s1, d0, d1 };
  }
  if (!best) return null;
  let { ax, az, s0, s1, d0, d1 } = best;
  let hl = (s1 - s0) / 2, hw = (d1 - d0) / 2; const sc = (s0 + s1) / 2, dc = (d0 + d1) / 2;
  const cx = sc * ax - dc * az, cz = sc * az + dc * ax;
  if (hw > hl) { const t = hl; hl = hw; hw = t; const tx = ax; ax = -az; az = tx; }     // long axis first
  return { cx, cz, ax, az, hl, hw, fill: 0 };
}

function wallQuad(o, ax, az, bx, bz, ya0, yb0, ya1, yb1, nx, nz, u0, u1, G) {
  o.need(4, 6);
  const a = o.v(ax, ya0, az, nx, 0, nz, u0, ya0 - G), b = o.v(bx, yb0, bz, nx, 0, nz, u1, yb0 - G);
  if (ya1 - ya0 < 0.02) { const d = o.v(bx, yb1, bz, nx, 0, nz, u1, yb1 - G); o.tri(a, d, b); return; }
  const c = o.v(ax, ya1, az, nx, 0, nz, u0, ya1 - G);
  if (yb1 - yb0 < 0.02) { o.tri(a, c, b); return; }
  const d = o.v(bx, yb1, bz, nx, 0, nz, u1, yb1 - G);
  o.tri(a, c, b); o.tri(b, c, d);
}

/** Walls round a ring from y0 up to y1, skipping the cuts a tile's edge made through a building. */
function walls(o, p, y0, y1, G, size, cut, u = 0) {
  for (let j = 0, n = p.length; j < n; j += 2) {
    const i = (j + 2) % n, ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1], l = Math.hypot(bx - ax, bz - az);
    if (l < 0.03) continue;
    if (cut && ((ax < 0.02 && bx < 0.02) || (az < 0.02 && bz < 0.02) || (ax > size - 0.02 && bx > size - 0.02) || (az > size - 0.02 && bz > size - 0.02))) { u += l; continue; }
    wallQuad(o, ax, az, bx, bz, y0, y0, y1, y1, (bz - az) / l, -(bx - ax) / l, u, u + l, G);
    u += l;
  }
  return u;
}

function flatRoof(o, ring, holes, y, G, down = false) {
  let data = ring, holeIdx = null;
  if (holes && holes.length) {
    let n = ring.length; for (const h of holes) n += h.length;
    data = new Float32Array(n); data.set(ring); holeIdx = []; let at = ring.length;
    for (const h of holes) { holeIdx.push(at / 2); data.set(h, at); at += h.length; }
  }
  const t = earcut(data, holeIdx, 2), n = data.length / 2;
  o.need(n, t.length);
  const base = o.n;
  for (let i = 0; i < n; i++) o.v(data[2 * i], y, data[2 * i + 1], 0, down ? -1 : 1, 0, 0, y - G);
  for (let i = 0; i < t.length; i += 3) o.triUp(base + t[i], base + t[i + 1], base + t[i + 2], down);
}

/** A box of plant on a roof: four sides and a lid. */
function box(o, cx, cz, ax, az, hl, hw, y0, y1, G) {
  const c = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([s, d]) => [cx + s * ax - d * az, cz + s * az + d * ax]);
  // corners in order: make the ring wind as the tiles' outer rings do
  const p = []; for (const q of c) p.push(q[0], q[1]);
  if (area(p) < 0) { p.length = 0; for (let i = 3; i >= 0; i--) p.push(c[i][0], c[i][1]); }
  walls(o, p, y0, y1, G, 0, false);
  flatRoof(o, p, null, y1, G);
}

/** A ridged roof over any small footprint: the ridge runs along the footprint's long axis. */
function gableRoof(o, ring, R, yE, rise, G, wall, style) {
  const bx = -R.az, bz = R.ax, hw = Math.max(R.hw, 0.5);
  const dOf = (x, z) => (x - R.cx) * bx + (z - R.cz) * bz;
  for (const s of [1, -1]) {
    const poly = clipHalf(ring, s * bx, s * bz, -s * (R.cx * bx + R.cz * bz));
    if (poly.length < 6) continue;
    const t = earcut(poly, null, 2), n = poly.length / 2;
    let nx = s * bx * rise / hw, ny = 1, nz = s * bz * rise / hw; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    o.need(n, t.length);
    const base = o.n;
    for (let i = 0; i < n; i++) { const x = poly[2 * i], z = poly[2 * i + 1], y = yE + rise * Math.max(0, 1 - Math.abs(dOf(x, z)) / hw); o.v(x, y, z, nx, ny, nz, 0, y - G); }
    for (let i = 0; i < t.length; i += 3) o.triUp(base + t[i], base + t[i + 1], base + t[i + 2]);
  }
  // the walls go on up to meet it: gable ends, and the odd corner of an L
  o.kind = K_WALL; o.style = style; o.c = wall;
  for (let j = 0, n = ring.length; j < n; j += 2) {
    const i = (j + 2) % n, ax = ring[j], az = ring[j + 1], cx = ring[i], cz = ring[i + 1], l = Math.hypot(cx - ax, cz - az);
    if (l < 0.03) continue;
    const da = dOf(ax, az), db = dOf(cx, cz), ra = rise * Math.max(0, 1 - Math.abs(da) / hw), rb = rise * Math.max(0, 1 - Math.abs(db) / hw);
    const nx = (cz - az) / l, nz = -(cx - ax) / l;
    if (da * db < -1e-4) {
      const t = da / (da - db), mx = ax + (cx - ax) * t, mz = az + (cz - az) * t;
      wallQuad(o, ax, az, mx, mz, yE, yE, yE + ra, yE + rise, nx, nz, 0, l * t, G);
      wallQuad(o, mx, mz, cx, cz, yE, yE, yE + rise, yE + rb, nx, nz, l * t, l, G);
    } else if (ra > 0.05 || rb > 0.05) wallQuad(o, ax, az, cx, cz, yE, yE, yE + ra, yE + rb, nx, nz, 0, l, G);
  }
}

/** A hipped roof over a rectangle. */
function hipRoof(o, R, yE, rise, G) {
  const { cx, cz, ax, az, hl, hw } = R, bx = -az, bz = ax, rl = Math.max(hl - hw, 0);
  const P = (s, d) => [cx + s * ax + d * bx, cz + s * az + d * bz];
  const face = (pts, nx, nz) => {
    let ny = 1; const l = Math.hypot(nx, ny, nz);
    o.need(pts.length, 6);
    const base = o.n;
    for (const [x, z, y] of pts) o.v(x, y, z, nx / l, ny / l, nz / l, 0, y - G);
    o.triUp(base, base + 1, base + 2); if (pts.length === 4) o.triUp(base, base + 2, base + 3);
  };
  const k = rise / hw, yR = yE + rise;
  for (const s of [1, -1]) {
    face([[...P(-hl, s * hw), yE], [...P(hl, s * hw), yE], [...P(rl, 0), yR], [...P(-rl, 0), yR]], s * bx * k, s * bz * k);
    face([[...P(s * hl, -hw), yE], [...P(s * hl, hw), yE], [...P(s * rl, 0), yR]], s * ax * k, s * az * k);
  }
}

/** Is the ring (four corners) the rectangle R, near enough? */
function isRect(ring, R) {
  if (ring.length !== 8) return false;
  for (let i = 0; i < 8; i += 2) {
    const s = (ring[i] - R.cx) * R.ax + (ring[i + 1] - R.cz) * R.az, d = -(ring[i] - R.cx) * R.az + (ring[i + 1] - R.cz) * R.ax;
    if (Math.abs(Math.abs(s) - R.hl) > 0.35 || Math.abs(Math.abs(d) - R.hw) > 0.35) return false;
  }
  return true;
}

// ------------------------------------------------------------------ roads

/**
 * The roads inside a rectangle of a tile, as ribbons laid on the ground: two vertices every 18 m or less, each
 * standing on the ground under it. Returns { pos (x, y, z), ar (-1 | 1 across, metres along, half-width + rank / 2 packed as hw + 100 * rank), idx, bounds } or null.
 */
function buildRoads(tile, x0, z0, x1, z1, hAt, skip) {
  const pos = [], ar = [], idx = [];
  let n = 0;
  const piece = (q, hw, rank) => {
    // resample
    const P = [q[0], q[1]];
    for (let i = 2; i < q.length; i += 2) {
      const ax = q[i - 2], az = q[i - 1], bx = q[i], bz = q[i + 1], l = Math.hypot(bx - ax, bz - az);
      if (l < 0.05) continue;
      const m = Math.ceil(l / 18);
      for (let k = 1; k <= m; k++) P.push(ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m);
    }
    const m = P.length / 2;
    if (m < 2 || (skip && skip(P[2 * (m >> 1)], P[2 * (m >> 1) + 1]))) return;         // (not across an aerodrome: the airfield lays its own pavement)
    let along = 0;
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      let dx = P[2 * b] - P[2 * a], dz = P[2 * b + 1] - P[2 * a + 1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (i) along += Math.hypot(P[2 * i] - P[2 * i - 2], P[2 * i + 1] - P[2 * i - 1]);
      const x = P[2 * i], z = P[2 * i + 1];
      for (const s of [-1, 1]) { const px = x - dz * hw * s, pz = z + dx * hw * s; pos.push(px, hAt(px, pz) + 0.3, pz); ar.push(s, along, hw + 100 * rank); }
      if (i) idx.push(n - 2, n - 1, n, n - 1, n + 1, n);
      n += 2;
    }
  };
  for (const r of tile.roads) {
    const p = r.p; let cur = null;
    for (let i = 2; i < p.length; i += 2) {
      // the part of this segment inside the rectangle (Liang-Barsky)
      const ax = p[i - 2], az = p[i - 1], dx = p[i] - ax, dz = p[i + 1] - az;
      let t0 = 0, t1 = 1, ok = true;
      for (const [pp, qq] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
        if (pp === 0) { if (qq < 0) ok = false; } else { const t = qq / pp; if (pp < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; } else if (t < t0) ok = false; else if (t < t1) t1 = t; }
      }
      if (!ok || t1 - t0 <= 0) { if (cur) { piece(cur, r.hw, r.rank); cur = null; } continue; }
      if (!cur || t0 > 0) { if (cur) piece(cur, r.hw, r.rank); cur = [ax + dx * t0, az + dz * t0]; }
      cur.push(ax + dx * t1, az + dz * t1);
      if (t1 < 1) { piece(cur, r.hw, r.rank); cur = null; }
    }
    if (cur) piece(cur, r.hw, r.rank);
  }
  if (!n) return null;
  let y0 = Infinity, y1 = -Infinity; for (let i = 1; i < pos.length; i += 3) { if (pos[i] < y0) y0 = pos[i]; if (pos[i] > y1) y1 = pos[i]; }
  return { pos: Float32Array.from(pos), ar: Float32Array.from(ar), idx: n > 65535 ? Uint32Array.from(idx) : Uint16Array.from(idx), bounds: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 8] };
}

// ------------------------------------------------------------------ a level of a tile

/**
 * Build one level of a tile.
 *   tile     from parseTile
 *   level    'near' | 'mid' | 'tall'
 *   quad     which quarter (0..3: +1 east half, +2 south half) for 'near'; ignored otherwise (all four)
 *   ground   { n, x0, z0, step, h: Float32Array(n * n) }: heights of the ground on a grid, in tile-local metres
 *   skip     (x, z) => true where a building must not stand (inside an aerodrome), tile-local
 * Returns { chunks, foot, lights, count, roads }.
 */
export function buildLevel(tile, level, quad, ground, skip) {
  const size = tile.size, o = new Out(), near = level === 'near', tallOnly = level === 'tall';
  const tol = near ? 0 : tallOnly ? 2.2 : 0.9, skirt = near ? 1.5 : tallOnly ? 12 : 5;
  const gh = ground.h, gn = ground.n;
  const hAt = (x, z) => {
    const fx = Math.min(gn - 1.001, Math.max(0, (x - ground.x0) / ground.step)), fz = Math.min(gn - 1.001, Math.max(0, (z - ground.z0) / ground.step));
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * gn + i;
    return (gh[k] * (1 - u) + gh[k + 1] * u) * (1 - v) + (gh[k + gn] * (1 - u) + gh[k + gn + 1] * u) * v;
  };
  const boxes = [], fq = [], starts = [0], pts = [], lights = [];
  let count = 0;
  for (let q = 0; q < 4; q++) {
    if (near && q !== quad) continue;
    o.quadrant(q);
    for (const b of tile.blds) {
      if (b.q !== q) continue;
      if (tallOnly ? b.top < TALL : !near && b.small) continue;
      if (skip && skip(b.cx, b.cz)) continue;
      let ring = b.ring, holes = b.holes;
      if (tol) { const r = tidy(ring, tol); if (r.length >= 6 && area(r) > 4) ring = r; if (tallOnly) holes = null; }
      let gmin = Infinity, gmax = -Infinity;
      for (let i = 0; i < ring.length; i += 2) { const g = hAt(ring[i], ring[i + 1]); if (g < gmin) gmin = g; if (g > gmax) gmax = g; }
      const G = Math.max(hAt(b.cx, b.cz), (gmin + gmax) / 2 - 0.5);
      const y0 = b.mh > 0 ? G + b.mh : gmin - skirt, pitched = near && b.roof !== 'flat';
      const R = pitched ? boundingRect(ring) : null;
      const rise = R ? Math.min(4.2, Math.max(1.0, R.hw * (b.roof === 'hip' ? 0.52 : 0.6))) : 0;
      const yE = G + b.mh + (pitched && R ? b.eave : b.H), yTop = yE + rise;
      // where the roof takes its colour from the satellite picture: the building's middle for a small one
      const central = b.A < 600 && b.box[2] - b.box[0] < 120 && b.box[3] - b.box[1] < 120;
      o.central = false; o.cenX = b.cx; o.cenZ = b.cz;
      const sFlag = b.small ? 8 : 0;

      // walls
      o.colour(b.wall, b.seed); o.kind = K_WALL; o.style = b.style + sFlag;
      const u1 = walls(o, ring, y0, yE, G, size, b.cut);
      if (holes) for (const h of holes) walls(o, h, y0, yE, G, size, b.cut, u1);
      // roof
      o.colour(b.roofCol, b.seed); o.style = sFlag; o.central = central;
      if (pitched && R) {
        o.kind = K_PITCH;
        if (b.roof === 'hip' && isRect(ring, R)) hipRoof(o, R, yE, rise, G);
        else gableRoof(o, ring, R, yE, rise, G, b.wall, S_BLANK + sFlag);
      } else { o.kind = K_FLAT; flatRoof(o, ring, holes, yE, G); }
      o.central = false;
      if (b.mh > 0 && !tallOnly) { o.kind = K_UNDER; o.colour(b.wall, b.seed); flatRoof(o, ring, holes, y0, G, true); }
      let crown = yTop;
      // a plant room on a tall roof, and a few units on a big flat one
      if (!tallOnly && !pitched && b.kind !== 'house' && b.kind !== 'garage' && !b.cut) {
        const hs = b.hash;
        if (b.H >= 28 && b.A > 260 && frac(hs, 6) < 0.75) {
          const s = 0.42 + 0.22 * frac(hs, 7), ph = 3.2 + 4.5 * frac(hs, 8), p = new Float32Array(ring.length);
          let ok = true;
          for (let i = 0; i < ring.length; i += 2) { p[i] = b.cx + (ring[i] - b.cx) * s; p[i + 1] = b.cz + (ring[i + 1] - b.cz) * s; if (!inRing(p[i], p[i + 1], b.ring)) { ok = false; break; } if (holes) for (const h of holes) if (inRing(p[i], p[i + 1], h)) ok = false; }
          if (ok && inRing(b.cx, b.cz, b.ring)) {
            o.kind = K_WALL; o.style = S_BLANK; o.colour(b.style === S_GLASS ? [0.2, 0.21, 0.22] : b.wall.map((v) => v * 0.8), b.seed);
            walls(o, p, yE, yE + ph, G, size, false);
            o.kind = K_FLAT; o.colour(b.roofCol, b.seed); flatRoof(o, p, null, yE + ph, G);
            crown = yE + ph;
          }
        }
        if (near && b.A > 420 && b.H < 60) {
          const R2 = boundingRect(ring);
          const want = Math.min(7, 1 + Math.floor(b.A / 900));
          o.kind = K_PLANT; o.style = S_BLANK;
          for (let k = 0, made = 0; k < want * 3 && made < want && R2; k++) {
            const s = (frac(hs, 9 + k) - 0.5) * 1.6 * R2.hl, d = (frac(hs ^ 0x5bd1e995, 9 + k) - 0.5) * 1.6 * R2.hw;
            const x = R2.cx + s * R2.ax - d * R2.az, z = R2.cz + s * R2.az + d * R2.ax, hl = 1.2 + 2.2 * frac(hs, 20 + k), hw = 0.9 + 1.2 * frac(hs, 26 + k), r = Math.hypot(hl, hw) + 0.8;
            if (!inRing(x, z, b.ring) || !inRing(x + r, z, b.ring) || !inRing(x - r, z, b.ring) || !inRing(x, z + r, b.ring) || !inRing(x, z - r, b.ring)) continue;
            if (crown > yE && Math.hypot(x - b.cx, z - b.cz) < Math.max(R2.hw, 6)) continue;
            const g = 0.38 + 0.3 * frac(hs, 32 + k); o.colour([g, g, g * 1.02], b.seed);
            box(o, x, z, R2.ax, R2.az, hl, hw, yE, yE + 1.1 + 1.3 * frac(hs, 38 + k), G);
            made++;
          }
        }
      }
      // an obstruction light on what stands tall (thinned below: one to a tower, not one to each of its parts)
      if (b.top >= 60 && !b.cut && b.A > 120) {
        const inside = inRing(b.cx, b.cz, b.ring);
        lights.push([inside ? b.cx : ring[0], crown + 1.5, inside ? b.cz : ring[1], b.top >= 110 ? 1 : 0]);
      }
      boxes.push(b.box[0], b.box[1], b.box[2], b.box[3], crown, b.mh > 0 ? y0 : G - 3, G);        // bounds, top, foot (for a hit), ground
      fq.push(q);
      for (let i = 0; i < b.ring.length; i++) pts.push(b.ring[i]);
      starts.push(pts.length);
      count++;
    }
  }
  o.flush();
  lights.sort((a, b) => b[1] - a[1]);
  const lamps = [];
  for (const l of lights) { let ok = true; for (let i = 0; i < lamps.length && ok; i += 4) ok = Math.hypot(lamps[i] - l[0], lamps[i + 2] - l[2]) > 55; if (ok) lamps.push(l[0], l[1], l[2], l[3]); }
  const half = size / 2, rx = (quad & 1) * half, rz = (quad >> 1) * half;
  return {
    chunks: o.chunks, count, lights: Float32Array.from(lamps), roads: near && tile.roads.length ? buildRoads(tile, rx, rz, rx + half, rz + half, hAt, skip) : null,
    foot: { box: Float32Array.from(boxes), q: Uint8Array.from(fq), start: Uint32Array.from(starts), pts: Float32Array.from(pts) },
  };
}
