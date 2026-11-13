// The real airfields. The index of all of them (airfield-index.js) is what the menu lists; the geometry
// of each (every runway, taxiway, apron and building footprint, from OpenStreetMap) is a file of its own in
// public/airfields/, fetched for the fields that lie inside the game's window of the world. Elevations are
// read from the terrain data, and the ground under each field is graded to one gently tilted plane fitted
// through it, so pavement lies on the ground and buildings neither float nor sink.

import * as dem from './dem.js';
import { toWorld, scaleAt, LAND_HALF } from './geo.js';
import { AIRFIELD_INDEX, DEFAULT_FIELD } from './airfield-index.js';
import { setFlats, gradeHeight } from './terrain.js';

export { DEFAULT_FIELD };
/** Every airfield of the game (for the menu): { id, name, city, state, lat, lon, blurb, ... }. */
export const FIELDS = AIRFIELD_INDEX;
export const fieldById = (id) => FIELDS.find((f) => f.id === id);
/** The airfields inside the window of the world, loaded and graded. The same array for the life of the game. */
export const AIRPORTS = [];
export const airportById = (id) => AIRPORTS.find((a) => a.id === id);

const DATA_URL = `${import.meta.env.BASE_URL}airfields/`;
const FIT_Z = 11;           // elevation zoom the grading plane is fitted to (a tile or two a field)
const raw = new Map();      // id -> the field's file, as fetched

const D2R = Math.PI / 180;
const CELL = 10;            // grading grid (m)
const MARGIN = 80;          // ground is exactly the plane this far out from any pavement or building
const BLEND = 260;          // and eases back to the natural terrain over this much more
const OVERRUN = 60;         // graded strip past each runway end
const PAVED = (s) => s === 'asphalt' || s === 'concrete';
const SURFACE = (s) => (PAVED(s) ? 'paved' : s);          // what the wheels feel: paved | gravel | grass

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
function inRing(px, pz, r) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if ((r[i + 1] > pz) !== (r[j + 1] > pz) && px < ((r[j] - r[i]) * (pz - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
  }
  return c;
}
function bounds(p, pad = 0) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1]; }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}

/** One runway from the baked data, in field-local meters (the frame every list of the field uses). */
function makeRunway(r, flip) {
  const a = flip ? r.b : r.a, b = flip ? r.a : r.b, n = flip ? [r.n[1], r.n[0]] : r.n, dt = r.dt ? (flip ? [r.dt[1], r.dt[0]] : r.dt) : [0, 0];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
  const paved = PAVED(r.s);
  return {
    numbers: n, ax: a[0], az: a[1], bx: b[0], bz: b[1], lx: (a[0] + b[0]) / 2, lz: (a[1] + b[1]) / 2,
    ux, uz, hdg: (Math.atan2(ux, -uz) / D2R + 360) % 360, len, width: r.w, kind: r.s, surface: SURFACE(r.s), dt,
    // Paint: 0 none (grass, gravel), 1 threshold, numbers and centerline, 2 adds aiming points, 3 adds touchdown-zone bars.
    cls: !paved ? 0 : r.w >= 44 && len >= 1500 ? 3 : r.w >= 29 && len >= 1150 ? 2 : 1,
    lit: paved,
  };
}

/** A field from the index alone (its file could not be fetched): one runway and nothing else. */
function fallbackData(f) {
  const th = f.hdg * D2R, ux = Math.sin(th), uz = -Math.cos(th), h = f.len / 2;
  return { ll: [f.lat, f.lon], rw: [{ n: f.numbers, a: [-ux * h, -uz * h], b: [ux * h, uz * h], w: f.surface === 'paved' ? 30 : 24, s: f.surface === 'paved' ? 'asphalt' : f.surface }], tw: [], ap: [], bd: [], hp: [], ws: [], hold: [], papi: [], als: [], park: [], fence: [] };
}
async function fetchData(f) {
  if (raw.has(f.id)) return raw.get(f.id);
  let d;
  try {
    const r = await fetch(`${DATA_URL}${f.id}.json`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d = await r.json();
  } catch (e) { console.warn(`Airfield ${f.id} could not be loaded, using its main runway alone:`, e.message); d = fallbackData(f); }
  raw.set(f.id, d);
  return d;
}
/**
 * A field's file is in true meters at the field; the world is true to scale only at its window's center.
 * Stretch the plan (not the heights) by the difference, so pavement meets the picture on the ground.
 */
function scaled(d, s) {
  const pts = (p) => p.map((v) => v * s);
  return {
    rw: d.rw.map((r) => ({ ...r, a: pts(r.a), b: pts(r.b), w: r.w * s, dt: r.dt ? pts(r.dt) : undefined })),
    tw: d.tw.map((t) => ({ ...t, p: pts(t.p), w: t.w * s })), ap: d.ap.map((p) => ({ ...p, p: pts(p.p) })), bd: d.bd.map((b) => ({ ...b, p: pts(b.p) })),
    hp: pts(d.hp), ws: pts(d.ws), hold: pts(d.hold), papi: pts(d.papi), als: pts(d.als), park: d.park.map(pts), fence: pts(d.fence),
  };
}

/**
 * Mark the cells of a field's grid that lie on pavement or under a building, then turn the distance
 * to the nearest marked cell into a grading weight. Returns the flat (without its plane yet).
 */
function gradeGrid(a) {
  const boxes = [];
  for (const r of a.runways) boxes.push(bounds([r.ax - r.ux * OVERRUN, r.az - r.uz * OVERRUN, r.bx + r.ux * OVERRUN, r.bz + r.uz * OVERRUN], r.width / 2));
  for (const t of a.taxiways) boxes.push(bounds(t.p, t.w / 2));
  for (const p of a.aprons) boxes.push(bounds(p.p));
  for (const b of a.buildings) boxes.push(bounds(b.p));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); }
  const pad = MARGIN + BLEND + 2 * CELL;
  // The grid is laid out in world coordinates, snapped to the cell size.
  const gx0 = Math.floor((a.ox + x0 - pad) / CELL) * CELL, gz0 = Math.floor((a.oz + z0 - pad) / CELL) * CELL;
  const nx = Math.ceil((a.ox + x1 + pad - gx0) / CELL) + 1, nz = Math.ceil((a.oz + z1 + pad - gz0) / CELL) + 1;
  const INF = 1e12, d2 = new Float64Array(nx * nz).fill(INF);
  const lx = (i) => gx0 + i * CELL - a.ox, lz = (j) => gz0 + j * CELL - a.oz;         // cell corner in field-local meters
  const cells = (b, fn) => {
    const i0 = Math.max(0, Math.floor((a.ox + b[0] - gx0) / CELL) - 1), i1 = Math.min(nx - 1, Math.ceil((a.ox + b[2] - gx0) / CELL) + 1);
    const j0 = Math.max(0, Math.floor((a.oz + b[1] - gz0) / CELL) - 1), j1 = Math.min(nz - 1, Math.ceil((a.oz + b[3] - gz0) / CELL) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (d2[j * nx + i] && fn(lx(i), lz(j))) d2[j * nx + i] = 0;
  };
  const slack = CELL * 0.75;
  a.runways.forEach((r, k) => cells(boxes[k], (x, z) => segDist(x, z, r.ax - r.ux * OVERRUN, r.az - r.uz * OVERRUN, r.bx + r.ux * OVERRUN, r.bz + r.uz * OVERRUN) <= r.width / 2 + slack));
  for (const t of a.taxiways) {
    for (let i = 0; i + 3 < t.p.length; i += 2) {
      const s = [t.p[i], t.p[i + 1], t.p[i + 2], t.p[i + 3]];
      cells(bounds(s, t.w / 2), (x, z) => segDist(x, z, s[0], s[1], s[2], s[3]) <= t.w / 2 + slack);
    }
  }
  const ring = (p) => cells(bounds(p), (x, z) => {
    if (inRing(x, z, p)) return true;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) if (segDist(x, z, p[j], p[j + 1], p[i], p[i + 1]) <= slack) return true;
    return false;
  });
  for (const p of a.aprons) ring(p.p);
  for (const b of a.buildings) ring(b.p);

  // Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), rows then columns.
  const n = Math.max(nx, nz), f = new Float64Array(n), v = new Int32Array(n), zz = new Float64Array(n + 1), out = new Float64Array(n);
  const pass = (off, stride, len) => {
    for (let q = 0; q < len; q++) f[q] = d2[off + q * stride];
    let k = 0; v[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      do { const p = v[k]; s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p); } while (s <= zz[k] && --k >= 0);
      k++; v[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (zz[k + 1] < q) k++; const p = v[k]; out[q] = (q - p) * (q - p) + f[p]; }
    for (let q = 0; q < len; q++) d2[off + q * stride] = out[q];
  };
  for (let j = 0; j < nz; j++) pass(j * nx, 1, nx);
  for (let i = 0; i < nx; i++) pass(i, nx, nz);

  const w = new Float32Array(nx * nz), seeds = [];
  for (let k = 0; k < nx * nz; k++) {
    const d = Math.sqrt(d2[k]) * CELL;
    w[k] = 1 - smooth(MARGIN, MARGIN + BLEND, d);
    if (d === 0) seeds.push(k);
  }
  // Inside the airport's boundary the ground is the airfield's whether it is graded or not: no water
  // (the elevation data reads dead-level fields as lakes), no trees. Filled a grid row at a time.
  let dry = w;
  if (a.fence.length >= 6) {
    dry = w.slice();
    const p = a.fence, xs = [];
    for (let j = 0; j < nz; j++) {
      const z = lz(j); xs.length = 0;
      for (let i = 0, k = p.length - 2; i < p.length; k = i, i += 2) if ((p[i + 1] > z) !== (p[k + 1] > z)) xs.push(p[i] + ((z - p[i + 1]) / (p[k + 1] - p[i + 1])) * (p[k] - p[i]));
      xs.sort((u, v) => u - v);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil((a.ox + xs[s] - gx0) / CELL)), i1 = Math.min(nx - 1, Math.floor((a.ox + xs[s + 1] - gx0) / CELL));
        for (let i = i0; i <= i1; i++) dry[j * nx + i] = 1;
      }
    }
  }
  return { x0: gx0, z0: gz0, x1: gx0 + (nx - 1) * CELL, z1: gz0 + (nz - 1) * CELL, cell: CELL, nx, nz, w, dry, seeds, cx: a.x, cz: a.z, e0: 0, gx: 0, gz: 0 };
}

/** Fit the grading plane through the terrain under the field's pavement (robust least squares). */
function fitPlane(a, f) {
  const xs = [], zs = [], hs = [];
  for (let s = 0; s < f.seeds.length; s++) {
    const k = f.seeds[s], i = k % f.nx, j = (k / f.nx) | 0;
    if ((i % 3) || (j % 3)) continue;                      // a sample every 30 m is plenty
    const x = f.x0 + i * CELL, z = f.z0 + j * CELL;
    xs.push(x - f.cx); zs.push(z - f.cz); hs.push(Math.max(dem.heightAt(x, z, FIT_Z), 0));
  }
  const n = hs.length, wt = new Float64Array(n).fill(1);
  let e0 = 0, gx = 0, gz = 0;
  if (n < 6) { e0 = Math.max(dem.heightAt(f.cx, f.cz, FIT_Z), 0); }
  else for (let it = 0; it < 5; it++) {
    // Weighted normal equations for h = e0 + gx * x + gz * z.
    let s1 = 0, sx = 0, sz = 0, sxx = 0, sxz = 0, szz = 0, sh = 0, sxh = 0, szh = 0;
    for (let i = 0; i < n; i++) { const w = wt[i], x = xs[i], z = zs[i], h = hs[i]; s1 += w; sx += w * x; sz += w * z; sxx += w * x * x; sxz += w * x * z; szz += w * z * z; sh += w * h; sxh += w * x * h; szh += w * z * h; }
    const det = s1 * (sxx * szz - sxz * sxz) - sx * (sx * szz - sxz * sz) + sz * (sx * sxz - sxx * sz);
    if (Math.abs(det) < 1e-6) { e0 = sh / s1; gx = gz = 0; break; }
    e0 = (sh * (sxx * szz - sxz * sxz) - sx * (sxh * szz - sxz * szh) + sz * (sxh * sxz - sxx * szh)) / det;
    gx = (s1 * (sxh * szz - szh * sxz) - sh * (sx * szz - sxz * sz) + sz * (sx * szh - sxh * sz)) / det;
    gz = (s1 * (sxx * szh - sxz * sxh) - sx * (sx * szh - sxh * sz) + sh * (sx * sxz - sxx * sz)) / det;
    // Huber weights: bumps and holes in the data (a ditch, a stand of trees) pull less.
    for (let i = 0; i < n; i++) { const r = Math.abs(hs[i] - (e0 + gx * xs[i] + gz * zs[i])); wt[i] = r < 1.5 ? 1 : 1.5 / r; }
  }
  // The elevation data is drawn from 20 m contours, so what it says about a flat is rough. Keep the tilt
  // to what real fields have: a percent and a half along the main runway, under one across it. And
  // between the shore and the first contour the data is a plain ramp up from the sea, which a river
  // flat is not: a field that low is graded level, toward the low side of what the data shows.
  const m = a.runways[0];
  const sorted = hs.slice().sort((p, q) => p - q), coastal = n > 0 && sorted[n >> 1] < 20;
  let along = gx * m.ux + gz * m.uz, cross = gz * m.ux - gx * m.uz;
  along = coastal ? 0 : Math.max(-0.015, Math.min(0.015, along)); cross = coastal ? 0 : Math.max(-0.008, Math.min(0.008, cross));
  gx = along * m.ux - cross * m.uz; gz = along * m.uz + cross * m.ux;
  if (n) {
    const res = hs.map((h, i) => h - gx * xs[i] - gz * zs[i]).sort((p, q) => p - q);
    e0 = res[Math.floor(n * (coastal ? 0.3 : 0.5))];
  }
  // Stay clear of the sea: nowhere on the pavement below a meter and a half.
  let low = Infinity;
  for (let i = 0; i < n; i++) low = Math.min(low, e0 + gx * xs[i] + gz * zs[i]);
  if (n && low < 1.5) e0 += 1.5 - low;
  let res = 0;
  for (let i = 0; i < n; i++) res += Math.abs(hs[i] - (e0 + gx * xs[i] + gz * zs[i]));
  f.e0 = n ? e0 : Math.max(e0, 1.5); f.gx = gx; f.gz = gz; f.fit = n ? res / n : 0;
  delete f.seeds;
}

/** Is this field of the index inside the window of the world as it is now? (Its position in the world, or null.) */
export function inWindow(f, margin = 12000) {
  const o = toWorld(f.lat, f.lon);
  return Math.abs(o.x) < LAND_HALF + margin && Math.abs(o.z) < LAND_HALF + margin ? o : null;
}

let generation = 0;
/** Forget the airfields of the window (it is about to move: their world positions no longer mean anything). */
export function clearAirports() { generation++; AIRPORTS.length = 0; setFlats([]); }
/**
 * Load, lay out and grade the airfields inside the window of the world as it is now, replacing those of
 * the last one. Resolves with AIRPORTS. onProgress(fraction).
 */
export async function loadAirports(onProgress) {
  const mine = ++generation, list = [], flats = [];
  const wanted = FIELDS.filter((f) => inWindow(f));
  let done = 0;
  await Promise.all(wanted.map(async (f) => {
    const file = await fetchData(f), s = scaleAt(file.ll[0]), data = scaled(file, s), o = toWorld(file.ll[0], file.ll[1]);
    // The main runway (first in the data) faces the way the index lists its designators.
    const runways = data.rw.map((r, i) => makeRunway(r, i === 0 && r.n[0] !== f.numbers[0] && r.n[1] === f.numbers[0]));
    const main = runways[0], ox = o.x, oz = o.z;
    const a = {
      id: f.id, name: f.name, city: f.city, state: f.state, blurb: f.blurb, lat: f.lat, lon: f.lon, ox, oz,
      // The fields the rest of the game reads describe the main runway, in world coordinates.
      x: ox + main.lx, z: oz + main.lz, elev: 0, hdg: main.hdg, ux: main.ux, uz: main.uz, len: main.len, width: main.width, surface: main.surface, numbers: main.numbers,
      traffic: f.traffic ?? 0.15, big: !!f.big,
      runways,
      taxiways: data.tw.map((t) => ({ p: t.p, w: t.w, kind: t.s, surface: SURFACE(t.s), lane: !!t.lane, stop: !!t.stop, box: bounds(t.p, t.w / 2) })),
      aprons: data.ap.map((p) => ({ p: p.p, kind: p.s, surface: SURFACE(p.s), box: bounds(p.p) })),
      buildings: data.bd.map((b) => ({ p: b.p, kind: b.k, h: b.h })),
      helipads: data.hp, windsocks: data.ws, holds: data.hold, papis: data.papi, als: data.als, stands: data.park, fence: data.fence,
    };
    const g = gradeGrid(a);
    await dem.loadArea(FIT_Z, g.x0 + BLEND, g.z0 + BLEND, g.x1 - BLEND, g.z1 - BLEND, 1);
    if (mine !== generation) return;                         // the world moved again while this was loading
    fitPlane(a, g);
    a.flat = g;
    a.box = [g.x0, g.z0, g.x1, g.z1];
    /** Height of the field's graded plane at a world position. */
    a.heightAt = (x, z) => gradeHeight(g, x, z);
    a.elev = a.heightAt(a.x, a.z);
    for (const r of runways) { r.x = ox + r.lx; r.z = oz + r.lz; r.elev = a.heightAt(r.x, r.z); }
    list.push(a); flats.push(g);
    onProgress?.(++done / wanted.length);
  }));
  if (mine !== generation) return AIRPORTS;
  list.sort((p, q) => FIELDS.findIndex((f) => f.id === p.id) - FIELDS.findIndex((f) => f.id === q.id));
  AIRPORTS.length = 0; AIRPORTS.push(...list);
  setFlats(flats);
  return AIRPORTS;
}

/** Signed along/cross-track position of a point relative to a runway centerline (an airport's main runway, or any runway of one). */
export function runwayCoords(a, x, z) {
  const dx = x - a.x, dz = z - a.z;
  return { along: dx * a.ux + dz * a.uz, cross: dx * -a.uz + dz * a.ux };
}

/** The nearest field, and how far the point is from its nearest runway (0 on the centerline). */
export function nearestAirport(x, z) {
  let best = null, bd = Infinity;
  for (const a of AIRPORTS) {
    if (Math.hypot(a.x - x, a.z - z) - 2500 > bd) continue;
    for (const r of a.runways) {
      const d = segDist(x - a.ox, z - a.oz, r.ax, r.az, r.bx, r.bz);
      if (d < bd) { bd = d; best = a; }
    }
  }
  return { airport: best, dist: bd };
}

const RANK = { paved: 3, gravel: 2, grass: 1 };
/**
 * What the wheels are on at a world position: 'paved', 'gravel' or 'grass' on a runway, taxiway
 * or apron (the hardest surface wins where they overlap), or null away from any of them.
 */
export function airfieldSurface(x, z) {
  for (const a of AIRPORTS) {
    const b = a.box;
    if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
    const px = x - a.ox, pz = z - a.oz;
    let best = null;
    for (const r of a.runways) {
      if (best && RANK[r.surface] <= RANK[best]) continue;
      const dx = px - r.lx, dz = pz - r.lz;
      if (Math.abs(dx * r.ux + dz * r.uz) <= r.len / 2 && Math.abs(dz * r.ux - dx * r.uz) <= r.width / 2) best = r.surface;
    }
    if (best === 'paved') return best;
    for (const t of a.taxiways) {
      if (best && RANK[t.surface] <= RANK[best]) continue;
      const q = t.box;
      if (px < q[0] || px > q[2] || pz < q[1] || pz > q[3]) continue;
      for (let i = 0; i + 3 < t.p.length; i += 2) if (segDist(px, pz, t.p[i], t.p[i + 1], t.p[i + 2], t.p[i + 3]) <= t.w / 2) { best = t.surface; break; }
    }
    if (best === 'paved') return best;
    for (const p of a.aprons) {
      if (best && RANK[p.surface] <= RANK[best]) continue;
      const q = p.box;
      if (px < q[0] || px > q[2] || pz < q[1] || pz > q[3]) continue;
      if (inRing(px, pz, p.p)) best = p.surface;
    }
    if (best) return best;
  }
  return null;
}
