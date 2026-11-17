// The land cover worker: fetches a tile of Overture's base theme (world/overture.js), keeps what it says of woods
// and of open country, and triangulates both for world/landcover.js to draw from above.
//
// in:   { type: 'tile', id, z, x, y, size }
// out:  { type: 'tile', id, forest, open, bytes, ms }      forest, open: { pos: [x, z, ...] in meters from the
//                                                         tile's northwest corner, idx } or null
//       { type: 'failed', id, error }
//
// What counts:
//   woods  the land cover's forest and mangrove (ESA WorldCover, a 10 m classification of Sentinel-2 imagery,
//          smoothed into polygons), and OpenStreetMap's woods (natural=wood, landuse=forest) where mapped
//   open   the land cover's cropland, grassland, bare ground, herbaceous wetland, moss and snow, and OpenStreetMap's
//          farmland, meadow and grassland
// Built-up land and shrubland are neither: what grows there is left to the satellite picture, as everywhere the
// map does not reach. Where a place is both, the woods win (world/landcover.js).

import earcut from 'three/src/extras/lib/earcut.js';
import { decodeTile, ringArea2 } from './mvt.js';
import { archive } from './overture.js';

const COVER_WOODS = new Set(['forest', 'mangrove']);
const COVER_OPEN = new Set(['crop', 'grass', 'barren', 'wetland', 'moss', 'snow']);
const USE_OPEN = new Set(['farmland', 'meadow']);

/** Polygons (MVT rings: outer rings positive, holes after them) -> triangles, appended to out. */
function addPolygon(geom, k, out) {
  const polys = []; let cur = null;
  for (const g of geom) { if (g.length < 6) continue; if (ringArea2(g) > 0) { cur = { ring: g, holes: [] }; polys.push(cur); } else if (cur) cur.holes.push(g); }
  for (const p of polys) {
    let n = p.ring.length; for (const h of p.holes) n += h.length;
    const data = new Float32Array(n), holeIdx = []; let at = 0;
    for (let i = 0; i < p.ring.length; i++) data[at++] = p.ring[i] * k;
    for (const h of p.holes) { holeIdx.push(at / 2); for (let i = 0; i < h.length; i++) data[at++] = h[i] * k; }
    const t = earcut(data, holeIdx, 2), base = out.pos.length / 2;
    for (let i = 0; i < n; i++) out.pos.push(data[i]);
    for (let i = 0; i < t.length; i++) out.idx.push(base + t[i]);
  }
}
const pack = (o) => (o.idx.length ? { pos: Float32Array.from(o.pos), idx: Uint32Array.from(o.idx) } : null);

async function tile(job) {
  const t0 = performance.now(), info = { bytes: 0 };
  const buf = await archive('base').tile(job.z, job.x, job.y, info);
  const t1 = performance.now();
  const woods = { pos: [], idx: [] }, open = { pos: [], idx: [] };
  if (buf) {
    const L = decodeTile(buf, { land_cover: true, land: true, land_use: true });
    for (const [name, pick] of [
      ['land_cover', (p) => (COVER_WOODS.has(p.subtype) ? woods : COVER_OPEN.has(p.subtype) ? open : null)],
      ['land', (p) => (p.subtype === 'forest' ? woods : p.subtype === 'grass' && p.class === 'grassland' ? open : null)],
      ['land_use', (p) => (p.subtype === 'agriculture' && USE_OPEN.has(p.class) ? open : null)],
    ]) {
      const layer = L[name];
      if (!layer) continue;
      const k = job.size / layer.extent;
      for (const f of layer.features) { if (f.type !== 3) continue; const o = pick(f.props); if (o) addPolygon(f.geom, k, o); }
    }
  }
  const forest = pack(woods), fields = pack(open), transfer = [];
  for (const m of [forest, fields]) if (m) transfer.push(m.pos.buffer, m.idx.buffer);
  self.postMessage({ type: 'tile', id: job.id, forest, open: fields, bytes: info.bytes, ms: { fetch: t1 - t0, build: performance.now() - t1 } }, transfer);
}

self.onmessage = (e) => {
  const job = e.data;
  if (job.type !== 'tile') return;
  tile(job).catch((err) => self.postMessage({ type: 'failed', id: job.id, error: String(err?.message || err), off: /unavailable/.test(String(err?.message)) }));
};
