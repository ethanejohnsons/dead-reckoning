#!/usr/bin/env node
// Bakes the airfields of the game from OpenStreetMap: one file of geometry per field in public/airfields/
// (fetched by the game when the field comes into its window of the world) and the index of all of them in
// src/world/airfield-index.js (the menu, the chart and the search for which fields a window holds).
//
//   node tools/fetch-airfields.mjs [--cache DIR] [--offline] [--all] [--only ID,ID] [--endpoint URL] [--skip-buildings]
//
// Only the fields of the list that are not baked yet are fetched (no entry in the index, or no file): the
// rest keep their files, and their index entries are carried over with the list's wording. --all fetches
// every field again; --only names the ones to fetch.
//
// The list of fields is tools/airfield-list.mjs. The Overpass API is asked a batch of fields at a time
// (aeroway features around each, then the buildings inside each airport boundary), with a pause between
// requests, and the raw answers are kept in a cache directory outside the repository (default: the system
// temp directory). --offline rebuilds from that cache without touching the network.
//
// The result is a derived database of OpenStreetMap data, © OpenStreetMap contributors, available under
// the Open Database License (ODbL) 1.0.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { magVarAt } from '../src/world/geo.js';
import { AIRFIELD_LIST, DEFAULT_FIELD } from './airfield-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public/airfields');
const OUT_INDEX = join(ROOT, 'src/world/airfield-index.js');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const CACHE = opt('--cache', join(tmpdir(), 'airfield-osm-cache'));
const OFFLINE = flag('--offline');
const ONLY = opt('--only', '').split(',').filter(Boolean);
const ALL = flag('--all');
const SKIP_BUILDINGS = flag('--skip-buildings');      // an interim bake: buildings only where their answer is already cached
const ENDPOINT = opt('--endpoint', 'https://overpass-api.de/api/interpreter');      // any Overpass API server
const USER_AGENT = 'airfield-geometry-fetch/1.0';
const PAUSE_MS = 10000;
const BATCH = 14;                 // fields per request

const D2R = Math.PI / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fetching

let fetched = 0;
async function overpass(name, query) {
  const file = join(CACHE, `${name}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  if (fetched++ && !OFFLINE) await sleep(PAUSE_MS);
  if (OFFLINE) throw new Error(`--offline, but ${file} is not in the cache`);
  for (let attempt = 1; ; attempt++) {
    process.stderr.write(`Overpass: ${name} (attempt ${attempt})…\n`);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(300000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      const json = JSON.parse(text);          // data only: parsed, never evaluated
      if (!Array.isArray(json.elements)) throw new Error('no elements in the answer');
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`Overpass: ${String(json.remark).slice(0, 160)}`);
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, text);
      return json;
    } catch (e) {
      if (attempt >= 6) throw e;
      process.stderr.write(`  failed (${e.message}); waiting before another try\n`);
      await sleep(PAUSE_MS * 3 * attempt);
    }
  }
}

function bbox(lat, lon, km) {
  const dLat = km / 111.2, dLon = km / (111.2 * Math.cos(lat * D2R));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(5)).join(',');
}

// ---------------------------------------------------------------- geometry

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
}
/** Douglas-Peucker on an open line. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = 0, k = -1;
    for (let m = i + 1; m < j; m++) { const d = segDist(pts[m], pts[i], pts[j]); if (d > worst) { worst = d; k = m; } }
    if (worst > tol) { keep[k] = 1; stack.push([i, k], [k, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Simplify a closed ring (first point not repeated). Split at the two points farthest apart so no corner is favored. */
function simplifyRing(ring, tol) {
  if (ring.length < 5) return ring.slice();
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < ring.length; i++) { const d = dist(ring[0], ring[i]); if (d > far) { far = d; b = i; } }
  far = -1;
  for (let i = 0; i < ring.length; i++) { const d = dist(ring[b], ring[i]); if (d > far) { far = d; a = i; } }
  if (a > b) [a, b] = [b, a];
  const one = simplify(ring.slice(a, b + 1), tol), two = simplify([...ring.slice(b), ...ring.slice(0, a + 1)], tol);
  return [...one.slice(0, -1), ...two.slice(0, -1)];
}
function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
}
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
const centroid = (ring) => { let x = 0, z = 0; for (const p of ring) { x += p[0]; z += p[1]; } return [x / ring.length, z / ring.length]; };
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
/** Push a ring's points outward from its centroid by about `m` meters (enough for a loose search fence). */
function inflate(ring, m) {
  const c = centroid(ring);
  return ring.map((p) => { const d = dist(p, c) || 1; return [p[0] + ((p[0] - c[0]) / d) * m, p[1] + ((p[1] - c[1]) / d) * m]; });
}

// ---------------------------------------------------------------- OSM helpers

const num = (v) => { if (v == null) return null; const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
/** Meters from a tag that may carry a unit (ft, ', m). */
function meters(v) {
  const n = num(v);
  if (n == null) return null;
  return /ft|feet|'/.test(String(v)) ? n * 0.3048 : n;
}
function surfaceOf(tag) {
  if (!tag) return null;
  const s = String(tag).toLowerCase();
  if (/concrete/.test(s)) return 'concrete';
  if (/asphalt|paved|bitumen|seal|tarmac|chipseal/.test(s)) return 'asphalt';
  if (/gravel|unpaved|compacted|pebble|shingle|metal/.test(s)) return 'gravel';
  if (/grass|turf|ground|earth|dirt|sand|soil/.test(s)) return 'grass';
  return null;
}
const isClosed = (el) => el.geometry && el.geometry.length > 3 && el.geometry[0].lat === el.geometry.at(-1).lat && el.geometry[0].lon === el.geometry.at(-1).lon;
const round1 = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap((p) => [round1(p[0]), round1(p[1])]);

// ---------------------------------------------------------------- main

// Each field has its own flat frame: meters east (+x) and south (+z) of its listed position, on a Mercator
// plane true to scale there. The game scales it to its window of the world when it loads the field.
const R_EARTH = 6378137;
const mercY = (lat) => R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
// What is baked already: the index as it stands, and the files beside it.
let baked = new Map();
try { baked = new Map((await import('../src/world/airfield-index.js')).AIRFIELD_INDEX.map((e) => [e.id, e])); } catch { /* no index yet */ }
const wanted = (f) => (ONLY.length ? ONLY.includes(f.id) : ALL || !baked.has(f.id) || !existsSync(join(OUT_DIR, `${f.id}.json`)));
const fields = AIRFIELD_LIST.filter(wanted).map((f) => ({ ...f, k: Math.cos(f.lat * D2R), my: mercY(f.lat), magVar: magVarAt(f.lat, f.lon) }));
const local = (f, lat, lon) => [R_EARTH * (lon - f.lon) * D2R * f.k, -(mercY(lat) - f.my) * f.k];
function toLatLonLocal(f, x, z) {
  return { lat: (2 * Math.atan(Math.exp((f.my - z / f.k) / R_EARTH)) - Math.PI / 2) / D2R, lon: f.lon + x / f.k / R_EARTH / D2R };
}
// The size of a field decides how hard its geometry is simplified and what is left out.
for (const f of fields) f.size = f.traffic >= 0.8 ? 2 : f.traffic >= 0.4 ? 1 : 0;

const batches = [];
for (let i = 0; i < fields.length; i += BATCH) batches.push(fields.slice(i, i + BATCH));
const tag = (kind, batch, query) => `${kind}-${batch[0].id}-${createHash('sha1').update(query).digest('hex').slice(0, 10)}`;
const aero = { elements: [] };
for (const batch of batches) {
  const q = `[out:json][timeout:240];\n(\n${batch.map((f) => `  nwr["aeroway"](${bbox(f.lat, f.lon, f.radius)});`).join('\n')}\n);\nout geom;`;
  aero.elements.push(...(await overpass(tag('aeroways', batch, q), q)).elements);
}

// Sort every element to the field whose listed position is nearest (and within its search radius).
const nearestField = (lat, lon) => {
  let best = null, bd = Infinity;
  for (const f of fields) {
    if (Math.abs(lat - f.lat) > 0.3 || Math.abs(lon - f.lon) > 0.4) continue;
    const p = local(f, lat, lon), d = Math.hypot(p[0], p[1]) / (f.radius * 1000);
    if (d < bd) { bd = d; best = f; }
  }
  return bd < 3.4 ? best : null;
};
const elPoint = (el) => (el.type === 'node' ? [el.lat, el.lon] : el.geometry ? [el.geometry[0].lat, el.geometry[0].lon] : el.bounds ? [(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2] : null);
/** Outer rings of a multipolygon relation, stitched from its member ways. */
function relationRings(el) {
  const parts = (el.members || []).filter((m) => m.type === 'way' && m.geometry && m.role !== 'inner').map((m) => m.geometry.map((g) => [g.lat, g.lon]));
  const rings = [];
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 200; guard++) {
      const end = ring.at(-1);
      if (ring.length > 3 && end[0] === ring[0][0] && end[1] === ring[0][1]) break;
      const i = parts.findIndex((p) => (p[0][0] === end[0] && p[0][1] === end[1]) || (p.at(-1)[0] === end[0] && p.at(-1)[1] === end[1]));
      if (i < 0) break;
      const next = parts.splice(i, 1)[0];
      if (next[0][0] !== end[0] || next[0][1] !== end[1]) next.reverse();
      ring = ring.concat(next.slice(1));
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

for (const f of fields) Object.assign(f, { els: [], boundary: null });
for (const el of aero.elements) {
  const p = elPoint(el);
  const f = p && nearestField(p[0], p[1]);
  if (f) f.els.push(el);
}

// Aerodrome boundaries (for the building search and for sorting out what belongs to the field).
for (const f of fields) {
  const cands = [];
  for (const el of f.els) {
    if (el.tags?.aeroway !== 'aerodrome') continue;
    const rings = el.type === 'way' && isClosed(el) ? [el.geometry.map((g) => [g.lat, g.lon])] : el.type === 'relation' ? relationRings(el) : [];
    for (const r of rings) {
      const ring = r.slice(0, -1).map(([la, lo]) => local(f, la, lo));
      cands.push({ ring, a: Math.abs(area(ring)), tags: el.tags });
    }
  }
  // The field's own airport is the one that holds (or lies nearest) the listed position.
  cands.sort((p, q) => (inside([0, 0], q.ring) - inside([0, 0], p.ring)) || dist(centroid(p.ring), [0, 0]) - dist(centroid(q.ring), [0, 0]));
  if (cands.length) { f.boundary = cands[0].ring; f.adTags = cands[0].tags; }
}

// Runways first: the fence for a field without a mapped boundary is drawn around them.
function lineOf(f, el) { return el.geometry.map((g) => local(f, g.lat, g.lon)); }
for (const f of fields) {
  f.notes = [];
  const inField = (pts) => !f.boundary || pts.some((p) => inside(p, inflate(f.boundary, 60)));
  f.rawRunways = f.els.filter((el) => el.tags.aeroway === 'runway' && el.type === 'way' && !isClosed(el)).map((el) => ({ el, pts: lineOf(f, el) })).filter((r) => inField(r.pts));
  if (!f.boundary) {
    const pts = f.els.filter((el) => el.type === 'way' && /^(runway|taxiway|apron|hangar|terminal)$/.test(el.tags.aeroway)).flatMap((el) => lineOf(f, el)).filter((p) => dist(p, [0, 0]) < f.radius * 1000);
    if (pts.length >= 3) { f.boundary = inflate(hull(pts), 120); f.notes.push('no airport boundary in OSM: fenced 120 m around the mapped runways, taxiways and aprons'); }
  }
}

// Second round of requests: buildings inside each boundary.
const bld = { elements: [] };
for (const batch of batches) {
  const polys = batch.filter((f) => f.boundary).map((f) => {
    const ring = simplifyRing(inflate(f.boundary, 15), f.size === 2 ? 40 : 15);
    // Back to latitude and longitude for the query.
    return ring.map(([x, z]) => { const ll = toLatLonLocal(f, x, z); return `${ll.lat.toFixed(5)} ${ll.lon.toFixed(5)}`; }).join(' ');
  });
  if (!polys.length) continue;
  const q = `[out:json][timeout:240];\n(\n${polys.map((p) => `  nwr["building"](poly:"${p}");`).join('\n')}\n);\nout geom;`;
  const name = tag('buildings', batch, q);
  if (SKIP_BUILDINGS && !existsSync(join(CACHE, `${name}.json`))) { process.stderr.write(`--skip-buildings: no cached answer for ${name}, those fields get no buildings\n`); continue; }
  bld.elements.push(...(await overpass(name, q)).elements);
}
for (const el of bld.elements) {
  const p = elPoint(el);
  const f = p && nearestField(p[0], p[1]);
  if (f && !f.els.some((e) => e.type === el.type && e.id === el.id)) f.els.push(el);
}

// ---------------------------------------------------------------- convert

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const heading = (a, b) => (Math.atan2(b[0] - a[0], -(b[1] - a[1])) / D2R + 360) % 360;      // true, flying a -> b
const paved = (s) => s === 'asphalt' || s === 'concrete';
const report = [], index = [];
let bytes = 0;
await mkdir(OUT_DIR, { recursive: true });

for (const f of fields) {
  const fence = f.boundary ? inflate(f.boundary, 40) : null;
  const within = (pts) => !fence || pts.some((p) => inside(p, fence));
  const big = f.size > 0;
  const magnetic = (trueDeg) => (trueDeg - f.magVar + 720) % 360;
  const TOL = [{ tw: 0.6, ap: 0.8, bd: 1.0, minB: 45, maxB: 120 }, { tw: 1.0, ap: 1.3, bd: 1.3, minB: 70, maxB: 170 }, { tw: 1.6, ap: 2.2, bd: 1.8, minB: 160, maxB: 240 }][f.size];
  const note = (s) => f.notes.push(s);

  // ---- runways. A runway may be mapped in pieces: lengths before a displaced threshold are separate
  // ways tagged runway=displaced_threshold, and a strip is sometimes split where something crosses it.
  const pieces = f.rawRunways.filter(({ el }) => !(el.tags.abandoned === 'yes' || el.tags.disused === 'yes' || el.tags.runway === 'blast_pad'))
    .map(({ el, pts }) => ({ t: el.tags, a: pts[0], b: pts.at(-1), bend: Math.max(0, ...pts.map((p) => segDist(p, pts[0], pts.at(-1)))), disp: el.tags.runway === 'displaced_threshold', used: false, dt: [0, 0] }));
  const wholes = pieces.filter((p) => !p.disp).sort((p, q) => dist(q.a, q.b) - dist(p.a, p.b));
  for (const r of wholes) {
    if (r.used) continue;
    for (let again = true; again;) {
      again = false;
      for (const p of pieces) {
        if (p === r || p.used) continue;
        if (!p.disp && p.t.ref && r.t.ref && p.t.ref !== r.t.ref) continue;
        if (!p.disp && surfaceOf(p.t.surface) !== surfaceOf(r.t.surface)) continue;      // a grass overrun is its own strip
        const line = Math.min(angDiff(heading(p.a, p.b), heading(r.a, r.b)), angDiff(heading(p.b, p.a), heading(r.a, r.b)));
        if (line > 4) continue;
        for (const end of ['a', 'b']) {
          const near = dist(p.a, r[end]) < 8 ? 'a' : dist(p.b, r[end]) < 8 ? 'b' : null;
          if (!near) continue;
          const far = p[near === 'a' ? 'b' : 'a'], other = r[end === 'a' ? 'b' : 'a'];
          if (dist(far, other) < dist(r[end], other)) continue;            // folds back over the runway: not an extension
          const k = end === 'a' ? 0 : 1;
          if (p.disp) r.dt[k] += dist(p.a, p.b); else r.dt[k] += p.dt[near === 'a' ? 1 : 0];
          r[end] = far; p.used = true; again = true;
          if (!r.t.surface && p.t.surface) r.t = { ...r.t, surface: p.t.surface };
          if (!r.t.width && p.t.width) r.t = { ...r.t, width: p.t.width };
          break;
        }
      }
    }
  }
  const runways = [];
  for (const r of wholes) {
    if (r.used) continue;
    const t = r.t, a = r.a, b = r.b, len = dist(a, b);
    if (len < 150) continue;
    const hdgAB = heading(a, b), d = [];
    // Designators: the one painted at end a is read flying a -> b.
    let n0, n1;
    const refs = String(t.ref || t.name || '').split(/[/\-–]/).map((s) => s.trim()).filter((s) => /^\d{1,2}[LRC]?$/.test(s));
    // American designators carry no leading zero (4/22, 9L/27R); Canadian ones do (08/26).
    const canada = f.country === 'Canada';
    const pad = canada ? (s) => s.replace(/^(\d)(?!\d)/, '0$1') : (s) => s.replace(/^0+(?=\d)/, '');
    const fromHeading = (h) => pad(String(Math.round(magnetic(h) / 10) % 36 || 36));
    const opposite = (s) => pad(String(((num(s) + 17) % 36) + 1) + ({ L: 'R', R: 'L', C: 'C' }[s.slice(-1)] || ''));
    if (refs.length === 2) {
      const e0 = angDiff(num(refs[0]) * 10, magnetic(hdgAB)), e1 = angDiff(num(refs[1]) * 10, magnetic(hdgAB));
      [n0, n1] = (e0 <= e1 ? refs : [refs[1], refs[0]]).map(pad);
      if (Math.abs(num(n0) - num(n1)) !== 18) {
        // The two ends of one runway are 18 apart; keep whichever fits the mapped direction.
        const fit0 = angDiff(num(n0) * 10, magnetic(hdgAB)), fit1 = angDiff(num(n1) * 10, magnetic(hdgAB + 180));
        if (fit0 <= fit1) n1 = opposite(n0); else n0 = opposite(n1);
        note(`runway ref "${t.ref}" is not a matching pair: read as ${n0}/${n1} from the mapped direction`);
      }
      if (angDiff(num(n0) * 10, magnetic(hdgAB)) > 25) note(`runway ${t.ref}: designators do not fit the mapped direction (${Math.round(magnetic(hdgAB))}° magnetic)`);
    } else { n0 = fromHeading(hdgAB); n1 = fromHeading(hdgAB + 180); d.push('n'); }
    let surface = surfaceOf(t.surface);
    if (!surface) d.push('s');
    let width = meters(t.width);
    if (!(width >= 5 && width <= 90)) { width = null; d.push('w'); }
    runways.push({ n: [n0, n1], a, b, len, hdg: hdgAB, w: width, s: surface, d, bend: r.bend, lenTag: meters(t.length), lit: t.lit === 'yes', dt: r.dt.map((v) => Math.round(v)) });
  }
  // Main runway: the longest paved one, else the longest. An untagged surface counts as paved for now if
  // the old table called the field paved.
  const rank = (r) => r.len * (paved(r.s) || (r.s === null && r.len >= 900) ? 4 : r.s === 'gravel' ? 2 : 1);
  runways.sort((p, q) => rank(q) - rank(p));
  // Defaults for what the map leaves out.
  runways.forEach((r, i) => {
    // An untagged strip of 900 m or more is taken to be paved (nearly all such runways in these states are); a shorter one is grass.
    if (r.s === null) r.s = r.len >= 900 ? 'asphalt' : 'grass';
    if (r.w === null) r.w = paved(r.s) ? (r.len >= 2400 ? 46 : r.len >= 1500 ? 30 : r.len >= 900 ? 23 : 18) : r.s === 'gravel' ? 20 : 30;
  });

  // ---- taxiways (and stopways mapped as lines: plain pavement past a runway end)
  const taxiways = [];
  const mainPaved = runways[0] && paved(runways[0].s);
  for (const el of f.els) {
    const aw = el.tags.aeroway;
    if (aw !== 'taxiway' && aw !== 'taxilane' && aw !== 'stopway') continue;
    if (el.type !== 'way' || isClosed(el)) continue;
    const pts = simplify(lineOf(f, el), TOL.tw);
    if (!within(pts)) continue;
    let w = meters(el.tags.width); const d = [];
    let s = surfaceOf(el.tags.surface);
    if (aw === 'stopway') {
      // Takes after the runway it continues.
      const r = runways.slice().sort((p, q) => Math.min(dist(pts[0], p.a), dist(pts[0], p.b), dist(pts.at(-1), p.a), dist(pts.at(-1), p.b)) - Math.min(dist(pts[0], q.a), dist(pts[0], q.b), dist(pts.at(-1), q.a), dist(pts.at(-1), q.b)))[0];
      if (!r) continue;
      taxiways.push({ p: pts, w: w >= 3 ? w : r.w, s: s || r.s, d, stop: true });
      continue;
    }
    if (!(w >= 3 && w <= 60)) { w = null; d.push('w'); }
    if (!s) { s = null; d.push('s'); }
    taxiways.push({ p: pts, w, s, d, lane: aw === 'taxilane' });
  }
  for (const t of taxiways) {
    if (t.s === null) t.s = mainPaved ? 'asphalt' : runways[0]?.s || 'grass';
    if (t.w === null) t.w = t.s === 'grass' ? 12 : big ? (t.lane ? 15 : f.size === 2 ? 23 : 18) : (t.lane ? 8 : 10);
  }

  // ---- aprons (and stopways mapped as areas)
  const aprons = [];
  for (const el of f.els) {
    if (el.tags.aeroway !== 'apron' && !(el.tags.aeroway === 'stopway' && isClosed(el))) continue;
    const rings = el.type === 'way' && isClosed(el) ? [el.geometry.map((g) => [g.lat, g.lon])] : el.type === 'relation' ? relationRings(el) : [];
    for (const r of rings) {
      const ring = simplifyRing(r.slice(0, -1).map(([la, lo]) => local(f, la, lo)), TOL.ap);
      if (ring.length < 3 || Math.abs(area(ring)) < 80 || !within(ring)) continue;
      if (area(ring) < 0) ring.reverse();
      let s = surfaceOf(el.tags.surface); const d = [];
      if (!s) { s = mainPaved ? 'asphalt' : runways[0]?.s || 'grass'; d.push('s'); }
      aprons.push({ p: ring, s, d });
    }
  }

  // ---- buildings (terminals, hangars, towers and whatever else stands inside the boundary)
  const buildings = [];
  const seen = new Set();
  for (const el of f.els) {
    const t = el.tags || {};
    const aw = t.aeroway, isB = t.building && t.building !== 'no';
    if (!isB && !/^(terminal|hangar|tower|control_tower)$/.test(aw || '')) continue;
    if (t.building === 'roof' && !aw) continue;                       // open canopies
    if (t.location === 'underground' || t.demolished || t.abandoned === 'yes') continue;
    const rings = el.type === 'way' && isClosed(el) ? [el.geometry.map((g) => [g.lat, g.lon])] : el.type === 'relation' ? relationRings(el) : [];
    for (const r of rings) {
      const ring = simplifyRing(r.slice(0, -1).map(([la, lo]) => local(f, la, lo)), TOL.bd);
      if (ring.length < 3) continue;
      const A = Math.abs(area(ring));
      const c = centroid(ring);
      if (fence && !inside(c, fence)) continue;
      const key = `${Math.round(c[0])},${Math.round(c[1])},${Math.round(A)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tower = /tower/.test(aw || '') || t.man_made === 'tower' || t.building === 'tower' || /control_tower|airport_control/.test(`${t.building} ${t['tower:type']} ${t.service}`);
      if (A < (tower ? 12 : TOL.minB)) continue;                      // garden sheds and kiosks
      if (area(ring) < 0) ring.reverse();
      let h = meters(t.height) ?? (num(t['building:levels']) ? num(t['building:levels']) * 3.4 + 1 : null);
      const kind = tower ? 'c' : aw === 'terminal' || /terminal/.test(t.building) ? 't' : aw === 'hangar' || /hangar/.test(t.building) ? 'h' : 'b';
      const d = [];
      if (!(h >= 2 && h <= 110)) {
        d.push('h');
        const side = Math.sqrt(A);
        h = kind === 'c' ? 22 : kind === 't' ? Math.min(14, 6.5 + side * 0.03) : kind === 'h' ? Math.min(18, Math.max(5, 3.5 + side * 0.17)) : Math.min(12, Math.max(3.5, 3 + side * 0.09));
      }
      buildings.push({ p: ring, k: kind, h: Math.round(h * 10) / 10, A, d });
    }
  }

  // ---- points
  const nodes = (test) => f.els.filter((el) => el.type === 'node' && test(el.tags || {})).map((el) => local(f, el.lat, el.lon)).filter((p) => !fence || inside(p, fence));
  const helipads = nodes((t) => t.aeroway === 'helipad');
  for (const el of f.els) if (el.tags?.aeroway === 'helipad' && el.type === 'way' && isClosed(el)) { const c = centroid(lineOf(f, el).slice(0, -1)); if (!fence || inside(c, fence)) helipads.push(c); }
  const windsocks = nodes((t) => t.aeroway === 'windsock');
  const holds = nodes((t) => t.aeroway === 'holding_position');
  // Approach-slope indicators are mapped either as one node or as a node per lamp unit: one point per group.
  const cluster = (pts, r) => {
    const groups = [];
    for (const p of pts) { const g = groups.find((q) => q.some((o) => dist(o, p) < r)); if (g) g.push(p); else groups.push([p]); }
    return groups.map(centroid);
  };
  // Lights standing outside the fence (approach lights run out past the boundary) belong to the field all the same.
  const navaid = (re) => f.els.filter((el) => el.type === 'node' && el.tags?.aeroway === 'navigationaid' && re.test(`${el.tags.navigationaid} ${el.tags['navigationaid:type'] || ''}`)).map((el) => local(f, el.lat, el.lon));
  const papis = cluster(navaid(/papi|vasi/i), 60);
  const als = navaid(/\bals\b|approach/i);
  const stands = [];
  for (const el of f.els) if (el.tags?.aeroway === 'parking_position' && el.type === 'way' && !isClosed(el)) { const p = simplify(lineOf(f, el), f.size ? 1.5 : 0.5); if (within(p)) stands.push(p); }

  // ---- what was found
  const main = runways[0];
  if (!main) { report.push(`${f.id} ${f.name}: NO RUNWAY FOUND in OpenStreetMap`); continue; }
  // The biggest buildings only (a hub has hundreds of sheds), towers always.
  buildings.sort((p, q) => (q.k === 'c') - (p.k === 'c') || q.A - p.A);
  const droppedB = Math.max(0, buildings.length - TOL.maxB);
  buildings.length = Math.min(buildings.length, TOL.maxB);
  if (stands.length > 260) stands.length = 260;
  const lines = [];
  const mid = [(main.a[0] + main.b[0]) / 2, (main.a[1] + main.b[1]) / 2];
  lines.push(`main runway ${main.n.join('/')} ${Math.round(main.len)} m x ${main.w} m ${main.s}, true heading ${main.hdg.toFixed(1)}° (variation ${f.magVar}°), ${Math.round(dist(mid, [0, 0]))} m from the listed position`);
  for (const r of runways) {
    const dd = r.d.map((c) => ({ w: 'width', s: 'surface', n: 'designators' }[c])).join(', ');
    lines.push(`runway ${r.n.join('/')} ${Math.round(r.len)} m x ${r.w} m ${r.s}${r.dt[0] || r.dt[1] ? ` (thresholds displaced ${r.dt[0]} m and ${r.dt[1]} m)` : ''}${r.lenTag && Math.abs(r.lenTag - (r.len - r.dt[0] - r.dt[1])) > 0.05 * r.len ? ` (length tag says ${Math.round(r.lenTag)} m)` : ''}${dd ? `  [defaulted: ${dd}]` : ''}${r.bend > 3 ? `  [mapped line bends ${r.bend.toFixed(1)} m]` : ''}`);
  }
  const cnt = (list, c) => list.filter((x) => x.d.includes(c)).length;
  lines.push(`${taxiways.length} taxiways (${cnt(taxiways, 'w')} widths, ${cnt(taxiways, 's')} surfaces defaulted), ${aprons.length} aprons (${cnt(aprons, 's')} surfaces defaulted), ` +
    `${buildings.length} buildings (${cnt(buildings, 'h')} heights defaulted; ${buildings.filter((b) => b.k === 't').length} terminal, ${buildings.filter((b) => b.k === 'h').length} hangar, ${buildings.filter((b) => b.k === 'c').length} tower${droppedB ? `; ${droppedB} smaller ones left out` : ''}), ` +
    `${helipads.length} helipads, ${windsocks.length} windsocks, ${holds.length} holding positions, ${stands.length} stands, ${papis.length} PAPI/VASI, ${als.length} approach lights${f.boundary ? '' : ', no boundary'}`);
  for (const n of f.notes) lines.push(`note: ${n}`);

  const D = (d) => (d.length ? { d: d.join('') } : {});
  const data = {
    ll: [f.lat, f.lon],
    rw: runways.map((r) => ({ n: r.n, a: flat([r.a]), b: flat([r.b]), w: r.w, s: r.s, ...(r.dt[0] || r.dt[1] ? { dt: r.dt } : {}), ...(r.lit ? { lit: 1 } : {}), ...D(r.d) })),
    tw: taxiways.map((t) => ({ w: t.w, s: t.s, p: flat(t.p), ...(t.lane ? { lane: 1 } : {}), ...(t.stop ? { stop: 1 } : {}), ...D(t.d) })),
    ap: aprons.map((a) => ({ s: a.s, p: flat(a.p), ...D(a.d) })),
    bd: buildings.sort((p, q) => q.A - p.A).map((b) => ({ k: b.k, h: b.h, p: flat(b.p), ...D(b.d) })),
    hp: flat(helipads), ws: flat(windsocks), hold: flat(holds), papi: flat(papis), als: flat(als),
    park: stands.map((p) => flat(p)),
    fence: f.boundary ? flat(simplifyRing(f.boundary, f.size === 2 ? 12 : 4)) : [],
  };
  const text = JSON.stringify(data);
  await writeFile(join(OUT_DIR, `${f.id}.json`), text);
  bytes += text.length;
  lines.push(`${(text.length / 1024).toFixed(0)} kB`);
  report.push(`${f.id} ${f.name}\n  ${lines.join('\n  ')}`);

  // How far the field reaches from its listed position (m): the game loads a field when this circle touches its window.
  let reach = 0;
  for (const r of runways) reach = Math.max(reach, dist(r.a, [0, 0]), dist(r.b, [0, 0]));
  for (const b of buildings) for (const q of b.p) reach = Math.max(reach, dist(q, [0, 0]));
  const ll = toLatLonLocal(f, mid[0], mid[1]);
  index.push({ id: f.id, name: f.name, city: f.city, state: f.state, country: f.country, lat: +ll.lat.toFixed(5), lon: +ll.lon.toFixed(5), numbers: main.n, hdg: Math.round(main.hdg), len: Math.round(main.len),
    surface: paved(main.s) ? 'paved' : main.s, traffic: f.traffic, big: f.size === 2 ? 1 : 0, reach: Math.round(reach + 400), blurb: f.blurb });
}

// ---------------------------------------------------------------- write

{
  // The index follows the list: a field fetched in this run takes its new entry, one baked before keeps
  // its old one (with the list's name, place and blurb), one that could not be baked is left out.
  const fresh = new Map(index.map((e) => [e.id, e])), merged = [];
  for (const f of AIRFIELD_LIST) {
    const e = fresh.get(f.id) || (baked.has(f.id) && existsSync(join(OUT_DIR, `${f.id}.json`)) ? { ...baked.get(f.id), name: f.name, city: f.city, state: f.state, country: f.country, traffic: f.traffic, blurb: f.blurb } : null);
    if (e) merged.push({ id: e.id, name: e.name, city: e.city, state: e.state, country: e.country, lat: e.lat, lon: e.lon, numbers: e.numbers, hdg: e.hdg, len: e.len, surface: e.surface, traffic: e.traffic, big: e.big, reach: e.reach, blurb: e.blurb });
  }
  const header = `// GENERATED by tools/fetch-airfields.mjs from tools/airfield-list.mjs. Do not edit by hand: run the script again.
//
// The index of the game's airfields: where each one is and what its main runway is. The full geometry of a
// field (every runway, taxiway, apron and building) is in public/airfields/<id>.json, fetched when the field
// comes into the game's window of the world. Both are taken from OpenStreetMap through the Overpass API.
//
// © OpenStreetMap contributors. This file and the files in public/airfields/ are a derived database of
// OpenStreetMap data, made available under the Open Database License (ODbL) 1.0:
// https://www.openstreetmap.org/copyright  https://opendatacommons.org/licenses/odbl/1-0/
//
// lat, lon: midpoint of the main runway. numbers: its designators; hdg: true heading flying from the first
// to the second (deg); len: pavement length (m). reach: how far the field extends from its listed position (m).
// A field's file holds, in meters east (+x) and south (+z) of ll (true to scale at the field), points as flat [x0, z0, x1, z1, ...]:
//   rw    runways: n designators (n[0] is painted at end a), a/b the two ends of the pavement, w width, s surface,
//         dt how far each landing threshold is displaced in from a and b
//   tw    taxiway centerlines: w width, s surface, p points (stop: a stopway past a runway end; lane: an apron taxilane)
//   ap    aprons: s surface, p outline
//   bd    buildings, largest first: k kind (t terminal, h hangar, c control tower, b other), h height, p outline
//   hp helipads, ws windsocks, hold holding positions, papi approach-slope indicators, als approach lights (points)
//   park  aircraft stand lines; fence the airport boundary
//   d     which values the map did not give and the script filled in: w width, s surface, n designators, h height

export const OSM_ATTRIBUTION = 'Airfields and towns: © OpenStreetMap contributors (openstreetmap.org/copyright)';
export const DEFAULT_FIELD = '${DEFAULT_FIELD}';

export const AIRFIELD_INDEX = [
${merged.map((r) => `  ${JSON.stringify(r)},`).join('\n')}
];
`;
  await writeFile(OUT_INDEX, header);
}
console.log(report.join('\n\n'));
console.log(`\n${index.length} of ${fields.length} fields fetched and written to ${OUT_DIR} (${(bytes / 1048576).toFixed(2)} MB); ${AIRFIELD_LIST.length} in the list, indexed in ${OUT_INDEX}`);
