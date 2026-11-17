// The map's tile worker: fetches a vector tile of the map (OpenFreeMap: OpenStreetMap in the OpenMapTiles layers),
// decodes it (world/mvt.js) and paints what is drawn as shapes into a bitmap, in the map's dark style: water,
// land cover, towns' built-up ground, parks, borders, roads, railroads, runways and, close in, buildings. What
// is written is not painted here but handed back as label candidates, for the map to place across all the
// tiles in view without collisions (ui/maptiles.js, ui/chart.js).
//
// in:   { type: 'tile', key, z, x, y, size }
// out:  { type: 'tile', key, bitmap, labels }   labels: [{ k (kind), n (name), x, y (global pixels at zoom z), p (priority), ... }]
//       { type: 'failed', key, error }

import { decodeTile } from '../world/mvt.js';

const SOURCE = 'https://tiles.openfreemap.org/planet';           // TileJSON: names the current weekly tile set
const QUIET = { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' };
const LAYERS = { water: 1, waterway: 1, landcover: 1, landuse: 1, park: 1, boundary: 1, transportation: 1, transportation_name: 1, aeroway: 1, building: 1, place: 1, water_name: 1, mountain_peak: 1, poi: 1 };

let template = null;
async function tileUrl(z, x, y) {
  if (!template) {
    template = (async () => {
      const r = await fetch(SOURCE, { ...QUIET, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('tile index: HTTP ' + r.status);
      const j = await r.json(), t = j.tiles?.[0];
      if (typeof t !== 'string' || !t.startsWith(new URL(SOURCE).origin + '/')) throw new Error('tile index: no tile address');
      return t;
    })();
    template.catch(() => { template = null; });
  }
  const n = 2 ** z;          // (the map goes round the earth: columns beyond the grid are the same tiles again)
  return (await template).replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** The English name where the map has one (a US English game), else the local one. */
const nameOf = (p) => p['name:en'] || p.name_en || p.name || '';

// ---------------------------------------------------------------- style
// Fills: by layer, a color for a feature's class (or null: not drawn).
const LANDCOVER = { wood: 'rgba(30,62,40,0.5)', grass: 'rgba(62,92,56,0.22)', wetland: 'rgba(38,76,78,0.38)', ice: 'rgba(214,226,236,0.72)', sand: 'rgba(176,158,116,0.3)', rock: 'rgba(138,138,138,0.24)' };
const LANDUSE = {
  residential: 'rgba(150,160,172,0.13)', commercial: 'rgba(172,150,150,0.15)', retail: 'rgba(172,150,150,0.15)', industrial: 'rgba(162,150,134,0.15)', railway: 'rgba(162,150,134,0.12)',
  university: 'rgba(170,160,118,0.11)', college: 'rgba(170,160,118,0.11)', school: 'rgba(170,160,118,0.09)', hospital: 'rgba(180,140,140,0.11)', cemetery: 'rgba(88,120,92,0.22)',
  military: 'rgba(176,96,96,0.1)', stadium: 'rgba(120,150,120,0.16)', pitch: 'rgba(90,140,96,0.18)', playground: 'rgba(90,140,96,0.14)', zoo: 'rgba(90,140,96,0.16)', theme_park: 'rgba(170,140,160,0.14)',
};
// Lines: [color, width (CSS px at zoom 10), dash, casing]
const ROADS = {
  motorway: ['#c8955f', 1.35, null, true], trunk: ['#bba57e', 1.15, null, true], primary: ['#b3aea2', 1.0, null, false], secondary: ['#979fa7', 0.85, null, false],
  tertiary: ['#8c949c', 0.8, null, false], minor: ['#6f7881', 0.6, null, false], service: ['#5d666f', 0.4, null, false], track: ['#5d666f', 0.4, [2, 2], false], path: ['#58616a', 0.32, [1.5, 1.5], false],
  rail: ['#8c929a', 0.75, [3, 2], false], transit: ['#7a8189', 0.55, [2, 2], false], ferry: ['#3f78a8', 0.8, [4, 3], false],
};
const ROAD_ORDER = ['path', 'track', 'service', 'minor', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
const WATER = '#183a5c', RIVER = '#22527d';
// Landmarks among the points of interest (OpenMapTiles poi classes and subclasses)
const LANDMARK = new Set(['attraction', 'museum', 'monument', 'castle', 'stadium', 'zoo', 'aquarium', 'theme_park', 'lighthouse', 'memorial', 'ruins', 'archaeological_site', 'fort', 'dam', 'observation', 'waterfall', 'volcano']);

function drawTile(d, z, SZ) {
  const c = new OffscreenCanvas(SZ, SZ), g = c.getContext('2d');
  const fz = clamp(2 ** ((z - 10) * 0.25), 0.42, 1.9), K = SZ / 256;          // line widths grow with the zoom; K: tile pixels to a CSS pixel at the nominal size
  g.lineJoin = 'round'; g.lineCap = 'round';

  // Fill every polygon of a layer whose class has a color, one path per color.
  const fill = (L, pick, stroke) => {
    if (!L) return;
    const s = SZ / L.extent, groups = new Map();
    for (const f of L.features) {
      if (f.type !== 3) continue;
      const col = pick(f.props);
      if (!col) continue;
      let a = groups.get(col); if (!a) groups.set(col, (a = []));
      a.push(f);
    }
    for (const [col, fs] of groups) {
      g.beginPath();
      for (const f of fs) for (const r of f.geom) { g.moveTo(r[0] * s, r[1] * s); for (let i = 2; i < r.length; i += 2) g.lineTo(r[i] * s, r[i + 1] * s); g.closePath(); }
      g.fillStyle = col; g.fill();
      if (stroke) { g.strokeStyle = stroke[0]; g.lineWidth = stroke[1] * K; g.stroke(); }
    }
  };
  // Stroke the lines (and polygon outlines) of a layer that `pick` chooses, with the style it gives.
  const lines = (L, pick, width, color, dash, alpha = 1) => {
    if (!L) return;
    const s = SZ / L.extent;
    g.beginPath();
    let any = false;
    for (const f of L.features) {
      if (f.type === 1 || !pick(f.props, f)) continue;
      for (const r of f.geom) { g.moveTo(r[0] * s, r[1] * s); for (let i = 2; i < r.length; i += 2) g.lineTo(r[i] * s, r[i + 1] * s); }
      any = true;
    }
    if (!any) return;
    g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width * K; g.setLineDash(dash ? dash.map((v) => v * K * Math.max(1, fz)) : []); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
  };

  fill(d.landcover, (p) => LANDCOVER[p.class]);
  fill(d.landuse, (p) => LANDUSE[p.class]);
  fill(d.park, (p) => (p.class ? 'rgba(66,138,88,0.13)' : null), z >= 6 ? ['rgba(112,186,134,0.32)', 0.7] : null);
  fill(d.water, (p) => (p.intermittent ? 'rgba(24,58,92,0.55)' : WATER), z >= 8 ? ['rgba(58,110,156,0.55)', 0.6] : null);
  // rivers and canals (streams once there is room for them)
  const ww = d.waterway;
  lines(ww, (p) => p.class === 'river', 1.25 * fz, RIVER);
  lines(ww, (p) => p.class === 'canal', 0.9 * fz, RIVER);
  if (z >= 11) lines(ww, (p) => p.class === 'stream', 0.5 * fz, RIVER);
  fill(d.aeroway, (p) => (p.class === 'apron' ? 'rgba(122,132,142,0.28)' : p.class === 'runway' || p.class === 'taxiway' ? '#7f8a95' : null));
  lines(d.aeroway, (p, f) => f.type === 2 && p.class === 'runway', 2.4 * fz, '#8f9aa5');
  lines(d.aeroway, (p, f) => f.type === 2 && p.class === 'taxiway' && z >= 12, 0.8 * fz, '#6a7580');
  if (z >= 14) fill(d.building, () => 'rgba(124,132,142,0.32)');

  // Borders: countries and states (not the sea ones)
  const bd = d.boundary;
  lines(bd, (p) => p.admin_level >= 3 && p.admin_level <= 4 && !p.maritime, 0.9, 'rgba(206,210,220,0.42)', [4, 3]);
  lines(bd, (p) => p.admin_level <= 2 && !p.maritime, 1.35, 'rgba(232,232,240,0.62)', [6, 3, 1.5, 3]);

  // Roads, the small ones first; the big ones over a dark casing that keeps them crisp over the rest. Tunnels faint.
  const T = d.transportation;
  if (T) {
    const cls = (p) => p.class;                       // (roads under construction, "motorway_construction", are left out)
    for (const k of ['ferry', 'transit', 'rail']) { const st = ROADS[k]; lines(T, (p) => p.class === k && p.brunnel !== 'tunnel', st[1] * fz, st[0], st[2]); }
    for (const k of ROAD_ORDER) {
      const st = ROADS[k], w = st[1] * fz;
      if (st[3] && z >= 8) lines(T, (p) => cls(p) === k && p.brunnel !== 'tunnel' && !p.ramp, w + 1.2, 'rgba(10,14,19,0.8)');
      lines(T, (p) => cls(p) === k && p.brunnel === 'tunnel', w, st[0], [2, 2], 0.45);
      lines(T, (p) => cls(p) === k && p.brunnel !== 'tunnel' && p.ramp, w * 0.55, st[0], st[2]);      // (ramps and links thinner)
      lines(T, (p) => cls(p) === k && p.brunnel !== 'tunnel' && !p.ramp, w, st[0], st[2]);
    }
  }
  return c.transferToImageBitmap();
}

// ---------------------------------------------------------------- labels
// Priority: lower is placed first (so wins). Each label: k kind, n name, x, y global pixels at the tile's zoom.
function labelsOf(d, z, tx, ty) {
  const out = [];
  const at = (L, gx, gy) => ({ x: (tx + gx / L.extent) * 256, y: (ty + gy / L.extent) * 256 });
  const inside = (L, gx, gy) => gx >= 0 && gy >= 0 && gx < L.extent && gy < L.extent;      // (the tile's buffer repeats its neighbors' points)
  const points = (L, fn) => { if (L) for (const f of L.features) if (f.type === 1) for (const r of f.geom) if (inside(L, r[0], r[1])) fn(f.props, at(L, r[0], r[1])); };

  points(d.place, (p, q) => {
    const n = nameOf(p), c = p.class, rank = p.rank ?? 10;
    if (!n) return;
    const pri = { country: 0, state: 2, province: 2, city: 3 + rank * 0.12 - (p.capital === 2 ? 1 : p.capital === 4 ? 0.3 : 0), town: 6 + rank * 0.06, village: 9 + rank * 0.03, suburb: 11, neighbourhood: 12.5, quarter: 12, hamlet: 12, island: 8.5, islet: 12 }[c];
    if (pri !== undefined) out.push({ k: c === 'province' ? 'state' : c === 'islet' ? 'island' : c, n, ...q, p: pri, cap: p.capital || 0 });
  });
  points(d.water_name, (p, q) => {
    const n = nameOf(p);
    if (n) out.push({ k: p.class === 'ocean' || p.class === 'sea' ? 'sea' : 'water', n, ...q, p: p.class === 'ocean' ? 1 : p.class === 'sea' ? 2.5 : p.class === 'bay' ? 7 : 7.5 });
  });
  points(d.mountain_peak, (p, q) => {
    const n = nameOf(p);
    if (n && (p.class === 'peak' || p.class === 'volcano') && (p.rank ?? 9) <= (z < 9 ? 1 : z < 11 ? 2 : z < 13 ? 4 : 9)) {
      const e = p.ele_ft ?? (p.ele != null ? Math.round(p.ele * 3.281) : null);
      out.push({ k: 'peak', n, ...q, p: 7 + (p.rank ?? 5) * 0.3, e: e > 0 && e < 29100 ? e : null });       // (the odd height in the data is a typo: nothing tops Everest's 29,032 ft)
    }
  });
  points(d.park, (p, q) => { const n = nameOf(p); if (n) out.push({ k: 'park', n, ...q, p: 8 + (p.rank ?? 5) * 0.2 }); });
  points(d.poi, (p, q) => {
    const n = nameOf(p);
    if (n && (LANDMARK.has(p.class) || LANDMARK.has(p.subclass))) out.push({ k: 'poi', n, ...q, p: 10 + (p.rank ?? 20) * 0.05 });
  });
  // Names along lines: rivers, and the numbers of the highways (shields), at the middle of their longest piece in the tile.
  const along = (L, pick, fn) => {
    if (!L) return;
    for (const f of L.features) {
      if (f.type !== 2 || !pick(f.props)) continue;
      let best = null, bl = 0;
      for (const r of f.geom) { let l = 0; for (let i = 2; i < r.length; i += 2) l += Math.hypot(r[i] - r[i - 2], r[i + 1] - r[i - 1]); if (l > bl) { bl = l; best = r; } }
      if (!best) continue;
      let half = bl / 2;
      for (let i = 2; i < best.length; i += 2) {
        const sl = Math.hypot(best[i] - best[i - 2], best[i + 1] - best[i - 1]);
        if (half > sl) { half -= sl; continue; }
        const t = sl ? half / sl : 0, gx = best[i - 2] + (best[i] - best[i - 2]) * t, gy = best[i - 1] + (best[i + 1] - best[i - 1]) * t;
        if (!inside(L, gx, gy)) break;
        let a = Math.atan2(best[i + 1] - best[i - 1], best[i] - best[i - 2]);
        if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;        // never upside down
        fn(f.props, at(L, gx, gy), a, (bl / L.extent) * 256);
        break;
      }
    }
  };
  along(d.waterway, (p) => (p.class === 'river' || p.class === 'canal') && nameOf(p), (p, q, a, len) => out.push({ k: 'river', n: nameOf(p), ...q, p: 8.6, a, len }));
  // (in the United States and Canada by their networks; in the rest of the world the motorways and trunk roads, on a plain plate)
  along(d.transportation_name, (p) => p.ref && String(p.ref).length <= 6 && (/^(us-interstate|us-highway|ca-transcanada|us-state)/.test(p.network || '') ? p.class === 'motorway' || p.class === 'trunk' || p.class === 'primary' : !/^(us|ca)-/.test(p.network || '') && (p.class === 'motorway' || p.class === 'trunk')), (p, q) => {
    const network = p.network || '', net = network.startsWith('us-interstate') ? 'i' : network.startsWith('us-highway') ? 'us' : network.startsWith('ca-') ? 'ca' : 'st';
    out.push({ k: 'shield', n: String(p.ref).split(';')[0], ...q, p: net === 'i' ? 7.2 : net === 'us' ? 8.2 : 9.6, net });
  });
  return out;
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'tile') return;
  try {
    const url = await tileUrl(m.z, m.x, m.y);
    const r = await fetch(url, { ...QUIET, signal: AbortSignal.timeout(25000) });
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    const buf = r.ok && r.status !== 204 ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array(0);
    const d = buf.length ? decodeTile(buf, LAYERS) : {};
    const bitmap = drawTile(d, m.z, m.size), labels = labelsOf(d, m.z, m.x, m.y);
    self.postMessage({ type: 'tile', key: m.key, bitmap, labels }, [bitmap]);
  } catch (err) {
    self.postMessage({ type: 'failed', key: m.key, error: err.message });
  }
};
