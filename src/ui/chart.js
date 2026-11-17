// The map. Two layers of relief: the whole continent, coarse, shaded once from a few dozen elevation tiles
// (loadOverview), and over it the game's window of the world in detail, baked from the regional elevation
// grid each time the window moves (bakeChart). Over the relief, real map data (OpenStreetMap, as vector tiles:
// ui/maptiles.js): water, rivers, woods, towns' built-up ground, parks, borders, roads, railroads and runways,
// and the names of places, waters, peaks, parks and landmarks, placed so that none covers another. On top: a
// graticule of latitude and longitude, every airfield of the game, the aircraft, a pin the player can drop
// anywhere (a flight can be started in the air over it), and optionally the synoptic weather picture.

import { baseHeight, baseWater, moisture, LAND_HALF } from '../world/terrain.js';
import { AIRPORTS, FIELDS, airportById } from '../world/airports.js';
import { allTowns } from '../world/towns.js';
import { tileUrl } from '../world/dem.js';
import { toWorld, toLatLon, worldX, worldZ } from '../world/geo.js';
import { NM } from '../aircraft/physics.js';
import { MapTiles, MAP_ATTRIBUTION } from './maptiles.js';

const D2R = Math.PI / 180;
// The map is drawn dark, like the rest of the interface: muted relief, one cool color for airfields.
const INK = '#edf1f4', MAGENTA = '#ffffff', BLUE = '#74d7f4', AMBER = '#ffb649', PLATE = 'rgba(13,18,24,0.74)', SOFT = 'rgba(170,181,191,0.95)';
const SANS = '"Inter", "Adwaita Sans", -apple-system, "Segoe UI", Roboto, "Noto Sans", system-ui, sans-serif';
/** Type and symbols follow the interface's root size, so the map reads the same at 720p and at 4K. */
const uiScale = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;

// How each kind of name is written: font (weight, size), color, dot under it (radius), capitals and spacing.
const LABEL = {
  country: { font: '600 13px', size: 13, color: 'rgba(236,240,244,0.8)', upper: true, spacing: '2.5px' },
  state: { font: '600 10.5px', size: 10.5, color: 'rgba(198,206,216,0.62)', upper: true, spacing: '1.8px' },
  city: { font: '700 13px', size: 13, color: '#f1f4f6', dot: 3.2 },
  town: { font: '600 11.5px', size: 11.5, color: '#dde3e8', dot: 2.4 },
  village: { font: '500 10.5px', size: 10.5, color: 'rgba(210,218,226,0.9)', dot: 1.7 },
  hamlet: { font: '500 10px', size: 10, color: 'rgba(190,198,206,0.78)', dot: 1.3 },
  suburb: { font: '600 9.5px', size: 9.5, color: 'rgba(182,192,202,0.62)', upper: true, spacing: '1px' },
  quarter: { font: '600 9px', size: 9, color: 'rgba(182,192,202,0.55)', upper: true, spacing: '1px' },
  neighbourhood: { font: '600 9px', size: 9, color: 'rgba(182,192,202,0.55)', upper: true, spacing: '1px' },
  island: { font: 'italic 500 11px', size: 11, color: 'rgba(214,220,226,0.82)' },
  sea: { font: 'italic 500 13px', size: 13, color: '#7fb2db', spacing: '1.5px' },
  water: { font: 'italic 500 11px', size: 11, color: '#8cc0e6' },
  river: { font: 'italic 500 10.5px', size: 10.5, color: '#7aaed8' },
  peak: { font: '500 10.5px', size: 10.5, color: '#d6c8ad' },
  park: { font: 'italic 500 10.5px', size: 10.5, color: '#8bcb9d' },
  poi: { font: '500 10.5px', size: 10.5, color: '#e2c58e' },
  shield: { font: '700 9.5px', size: 9.5, color: '#fff' },
};

export function bakeChart(size = 900) {
  const H = LAND_HALF, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data, dry = new Uint8ClampedArray(d.length);
  const hs = new Float32Array(size * size), px = (2 * H) / size;
  const at = (k) => (k + 0.5) / size * 2 * H - H;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) hs[j * size + i] = baseHeight(at(i), at(j));
  let top = 600;
  for (const h of hs) if (h > top) top = h;
  // The tints stretch to the relief of the window: plains country and the Rockies both use the whole scale.
  const mid = Math.min(900, top * 0.35), hi = Math.max(mid + 300, Math.min(top * 0.6, 2600)), span = Math.max(400, top - hi), step = top > 2200 ? 500 : top > 900 ? 250 : 100;
  const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i, h = hs[k], o = k * 4, x = at(i), z = at(j);
    const e = hs[j * size + Math.min(i + 1, size - 1)], w = hs[j * size + Math.max(i - 1, 0)];
    const s = hs[Math.min(j + 1, size - 1) * size + i], n = hs[Math.max(j - 1, 0) * size + i];
    const nx = -(e - w) / (2 * px), nz = -(s - n) / (2 * px), nl = Math.hypot(nx, 1, nz);
    const lake = h > 0 && baseWater(x, z);
    let r, gr, b;
    if (h <= 0 || lake) {
      const t = lake ? 0.25 : Math.min(1, -h / 300);
      r = 0.08 - 0.03 * t; gr = 0.17 - 0.05 * t; b = 0.29 - 0.09 * t;
    } else {
      // Hypsometric tint, dark: deep green lowlands, olive uplands, brown-gray ranges, pale tops; greener where wet.
      const m = moisture(x, z);
      r = mix(mix(0.15, 0.22, h / mid), mix(0.33, 0.74, (h - hi) / span), (h - mid) / (hi - mid));
      gr = mix(mix(0.21, 0.25, h / mid), mix(0.31, 0.77, (h - hi) / span), (h - mid) / (hi - mid));
      b = mix(mix(0.18, 0.19, h / mid), mix(0.27, 0.81, (h - hi) / span), (h - mid) / (hi - mid));
      const wet = Math.max(0, Math.min(1, (m - 0.45) * 2.5)) * (1 - Math.max(0, Math.min(1, (h - hi) / 400)));
      r = mix(r, 0.11, wet * 0.7); gr = mix(gr, 0.23, wet * 0.7); b = mix(b, 0.16, wet * 0.7);
      const sh = Math.max(0.55, Math.min(1.2, 0.84 + ((nx * -0.7 + nz * -0.7) / nl) * (top > 1500 ? 0.75 : 2.2)));
      r *= sh; gr *= sh; b *= sh;
      const lv = Math.floor(h / step);
      if (lv !== Math.floor(e / step) || lv !== Math.floor(s / step)) { r *= 1.22; gr *= 1.22; b *= 1.24; }
      if (Math.min(e, w, s, n) <= 0) { r = 0.3; gr = 0.43; b = 0.54; }
    }
    d[o] = Math.min(255, r * 255); d[o + 1] = Math.min(255, gr * 255); d[o + 2] = Math.min(255, b * 255); d[o + 3] = 255;
    landOnly(d, dry, o, h <= 0 || lake || Math.min(e, w, s, n) <= 0);
  }
  g.putImageData(img, 0, 0);
  c.land = dryCanvas(dry, size, size);
  return c;
}

// The relief without its own water, for under the map data, whose coasts and lakes are the true ones (the relief's,
// a pixel of a kilometer or more, would show beside them in blocks).
const DRY = [0.13, 0.2, 0.16];
function landOnly(d, dry, o, wet) {
  if (wet) { dry[o] = DRY[0] * 255; dry[o + 1] = DRY[1] * 255; dry[o + 2] = DRY[2] * 255; } else { dry[o] = d[o]; dry[o + 1] = d[o + 1]; dry[o + 2] = d[o + 2]; }
  dry[o + 3] = 255;
}
function dryCanvas(dry, W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(dry, W, H), 0, 0);
  return c;
}

/**
 * The relief of North America, from the Arctic islands to Central America, as one shaded picture on the Web
 * Mercator plane (the plane the game's world lies on, so it is drawn under the map by scale and offset
 * alone): 36 elevation tiles of zoom 4, about 7 km a pixel in the middle latitudes. Resolves with
 * { canvas, z, px0, py0 } (px0, py0: global pixel coordinates of its top left corner), or null if nothing came.
 */
export async function loadOverview() {
  const Z = 4, X0 = 0, X1 = 5, Y0 = 2, Y1 = 7, W = (X1 - X0 + 1) * 256, H = (Y1 - Y0 + 1) * 256;
  const hs = new Float32Array(W * H), tile = document.createElement('canvas');
  tile.width = tile.height = 256;
  const tg = tile.getContext('2d', { willReadFrequently: true });
  let got = 0;
  const jobs = [];
  for (let ty = Y0; ty <= Y1; ty++) for (let tx = X0; tx <= X1; tx++) jobs.push((async () => {
    try {
      const r = await fetch(tileUrl(Z, tx, ty));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      tg.clearRect(0, 0, 256, 256); tg.drawImage(bmp, 0, 0); bmp.close?.();
      const d = tg.getImageData(0, 0, 256, 256).data, ox = (tx - X0) * 256, oy = (ty - Y0) * 256;
      for (let j = 0; j < 256; j++) for (let i = 0, o = j * 1024; i < 256; i++, o += 4) hs[(oy + j) * W + ox + i] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
      got++;
    } catch (e) { console.warn('Map tile could not be loaded:', Z, tx, ty, e.message); }
  })());
  await Promise.all(jobs);
  if (!got) return null;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data, dry = new Uint8ClampedArray(d.length);
  const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
  const mid = 700, hi = 1900, span = 1900;
  for (let j = 0; j < H; j++) {
    // a pixel's size on the ground shrinks toward the pole: the shading allows for it
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y0 * 256 + j + 0.5)) / (256 * 2 ** Z)))), px = (40075017 / (256 * 2 ** Z)) * Math.cos(lat);
    for (let i = 0; i < W; i++) {
      const k = j * W + i, h = hs[k], o = k * 4;
      const e = hs[j * W + Math.min(i + 1, W - 1)], w = hs[j * W + Math.max(i - 1, 0)], s = hs[Math.min(j + 1, H - 1) * W + i], n = hs[Math.max(j - 1, 0) * W + i];
      // The survey levels every lake: land with nothing but its own height around it is water.
      const lake = h > 0 && Math.abs(e - h) < 0.3 && Math.abs(w - h) < 0.3 && Math.abs(s - h) < 0.3 && Math.abs(n - h) < 0.3;
      let r, gr, b;
      if (h <= 0 || lake) {
        const t = lake ? 0.25 : Math.min(1, -h / 2500);
        r = 0.08 - 0.03 * t; gr = 0.17 - 0.05 * t; b = 0.29 - 0.09 * t;
      } else {
        r = mix(mix(0.15, 0.22, h / mid), mix(0.33, 0.74, (h - hi) / span), (h - mid) / (hi - mid));
        gr = mix(mix(0.21, 0.25, h / mid), mix(0.31, 0.77, (h - hi) / span), (h - mid) / (hi - mid));
        b = mix(mix(0.18, 0.19, h / mid), mix(0.27, 0.81, (h - hi) / span), (h - mid) / (hi - mid));
        const nx = -(e - w) / (2 * px), nz = -(s - n) / (2 * px);
        const sh = Math.max(0.6, Math.min(1.25, 0.9 + (nx * -0.7 + nz * -0.7) * 9));
        r *= sh; gr *= sh; b *= sh;
        if (Math.min(e, w, s, n) <= 0) { r = 0.27; gr = 0.39; b = 0.5; }
      }
      d[o] = Math.min(255, r * 255); d[o + 1] = Math.min(255, gr * 255); d[o + 2] = Math.min(255, b * 255); d[o + 3] = 255;
      landOnly(d, dry, o, h <= 0 || lake || Math.min(e, w, s, n) <= 0);
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, land: dryCanvas(dry, W, H), z: Z, px0: X0 * 256, py0: Y0 * 256 };
}

const fmtLat = (v, dp = 0) => `${Math.abs(v).toFixed(dp)}°${v >= 0 ? 'N' : 'S'}`, fmtLon = (v, dp = 0) => `${Math.abs(v).toFixed(dp)}°${v >= 0 ? 'E' : 'W'}`;
/** A position in words: 46.52°N 93.11°W. */
export const fmtPlace = (lat, lon, dp = 2) => `${fmtLat(lat, dp)} ${fmtLon(lon, dp)}`;

export class Chart {
  /** base: the canvas from bakeChart (give it a new one, `chart.base = bakeChart()`, when the world moves). */
  constructor(base) {
    this.base = base;
    this.over = null;                                    // the map of the continent, once loadOverview has it
    this.cx = 0; this.cz = 0; this.scale = 0.0016;       // pixels per meter
    this.showWx = false;
    this.pin = null;                                     // { lat, lon, field? }: kept by latitude and longitude, so it stays put when the world moves; field: the airfield it was dropped on
    this.tiles = new MapTiles();
  }

  /** The world rectangle the map can be moved over: the continent when its map is loaded, else the window. */
  bounds() {
    const o = this.over;
    if (!o) return [-LAND_HALF, -LAND_HALF, LAND_HALF, LAND_HALF];
    return [worldX(o.px0, o.z), worldZ(o.py0, o.z), worldX(o.px0 + o.canvas.width, o.z), worldZ(o.py0 + o.canvas.height, o.z)];
  }
  /** Fit a route (or the whole window) into a viewport of w x h pixels. */
  fit(w, h, route, pad = 0.25) {
    if (!route) { this.cx = 0; this.cz = 0; this.scale = Math.min(w, h) / (LAND_HALF * 2); return; }
    this.cx = (route.ax + route.bx) / 2; this.cz = (route.az + route.bz) / 2;
    const span = Math.max(Math.abs(route.bx - route.ax), Math.abs(route.bz - route.az), 60000);
    this.scale = Math.min(w, h) / (span * (1 + pad * 2));
  }
  /** Zoom by a factor, keeping the point under (px, py) where it is (the middle of the view without one). */
  zoom(f, w, h, px = w / 2, py = h / 2) {
    const b = this.bounds(), min = Math.min(w, h) / (this.over ? Math.min(b[2] - b[0], b[3] - b[1]) : LAND_HALF * 2.4);
    const s = Math.max(min, Math.min(0.16, this.scale * f)), k = 1 / this.scale - 1 / s;
    this.cx += (px - w / 2) * k; this.cz += (py - h / 2) * k; this.scale = s;
    this.pan(0, 0);
  }
  pan(dxPx, dzPx) {
    const b = this.bounds();
    this.cx = Math.max(b[0], Math.min(b[2], this.cx - dxPx / this.scale));
    this.cz = Math.max(b[1], Math.min(b[3], this.cz - dzPx / this.scale));
  }
  /** The world position under a point of a viewport of w x h pixels. */
  worldAt(px, py, w, h) { return { x: this.cx + (px - w / 2) / this.scale, z: this.cz + (py - h / 2) / this.scale }; }
  /** Drop the pin at a point of the viewport; a click on the pin itself takes it away. Returns the pin (or null). */
  pinAt(px, py, w, h) {
    if (this.pin) { const p = toWorld(this.pin.lat, this.pin.lon); if (Math.hypot((p.x - this.cx) * this.scale + w / 2 - px, (p.z - this.cz) * this.scale + h / 2 - py) < 14) return (this.pin = null); }
    // A click on an airfield pins the airfield itself (the pin then carries its code, and a flight from it starts there).
    let best = null, bd = 13;
    for (const f of FIELDS) {
      const p = toWorld(f.lat, f.lon), d = Math.hypot((p.x - this.cx) * this.scale + w / 2 - px, (p.z - this.cz) * this.scale + h / 2 - py);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) return (this.pin = { lat: best.lat, lon: best.lon, field: best.id });
    const q = this.worldAt(px, py, w, h), ll = toLatLon(q.x, q.z);
    return (this.pin = { lat: ll.lat, lon: ll.lon });
  }

  /**
   * opts: { ac (aircraft, drawn at its position), station (tuned beacon's airfield), weather }
   */
  draw(g, w, h, opts = {}) {
    const u = this._u = uiScale();
    g.save();
    g.scale(u, u); w /= u; h /= u;                    // everything below is drawn in interface units
    const S = this.scale / u, X = (x) => w / 2 + (x - this.cx) * S, Z = (z) => h / 2 + (z - this.cz) * S;
    g.fillStyle = '#0d1f33'; g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const dry = this.tiles.ok;                          // (with the map data, the relief without its own water)
    if (this.over) { const b = this.bounds(); g.drawImage(dry ? this.over.land : this.over.canvas, X(b[0]), Z(b[1]), (b[2] - b[0]) * S, (b[3] - b[1]) * S); }
    // The window in detail, once a pixel of it is no bigger than a pixel of the screen or two (from far off the coarse map is enough).
    const detail = !this.over || S * LAND_HALF * 2 > 160;
    if (detail) g.drawImage(dry && this.base.land ? this.base.land : this.base, X(-LAND_HALF), Z(-LAND_HALF), LAND_HALF * 2 * S, LAND_HALF * 2 * S);
    // The map data over the relief, at the tile zoom that suits the scale (coarser tiles standing in while finer ones come).
    const tz = this.tiles.zoomFor(this.scale), vx0 = this.cx - w / 2 / S, vz0 = this.cz - h / 2 / S;
    const cover = this.tiles.cover(tz, vx0, vz0, this.cx + w / 2 / S, this.cz + h / 2 / S, this.cx, this.cz);
    const labelTiles = new Set();
    for (const c of cover) {
      const r = this.tiles.rect(c.z, c.x, c.y), x0 = Math.floor(X(r[0])), y0 = Math.floor(Z(r[1])), x1 = Math.ceil(X(r[2])), y1 = Math.ceil(Z(r[3]));
      if (c.sub) g.drawImage(c.t.bmp, c.sub[0], c.sub[1], c.sub[2], c.sub[2], x0, y0, x1 - x0, y1 - y0);
      else g.drawImage(c.t.bmp, x0, y0, x1 - x0, y1 - y0);
      labelTiles.add(c.t);
    }
    this.tiles.pump();

    // Graticule: parallels and meridians, as close together as there is room to label.
    const view = [toLatLon(this.cx - w / 2 / S, this.cz - h / 2 / S), toLatLon(this.cx + w / 2 / S, this.cz + h / 2 / S)];      // northwest and southeast corners
    const spanLon = view[1].lon - view[0].lon, step = [0.25, 0.5, 1, 2, 5, 10, 20].find((v) => spanLon / v <= 9) || 20, dp = step < 1 ? 2 : 0;
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1; g.fillStyle = 'rgba(237,241,244,0.42)'; g.font = `500 10.5px ${SANS}`; g.textAlign = 'left'; g.textBaseline = 'top';
    g.beginPath();
    for (let lon = Math.ceil(view[0].lon / step) * step; lon <= view[1].lon; lon += step) { const px = X(toWorld(0, lon).x); g.moveTo(px, 0); g.lineTo(px, h); g.fillText(fmtLon(lon, dp), px + 3, 3); }
    for (let lat = Math.ceil(view[1].lat / step) * step; lat <= view[0].lat; lat += step) { const pz = Z(toWorld(lat, 0).z); g.moveTo(0, pz); g.lineTo(w, pz); if (pz > 18) g.fillText(fmtLat(lat, dp), 3, pz + 3); }
    g.stroke();

    if (opts.weather && this.showWx) this.drawWeather(g, w, h, opts.weather, X, Z);

    // Names: the map's own (placed round the airfields, which come first), or without map data the game's list of
    // cities, the bigger the area in view, the bigger a city must be to be named.
    const named = S > 0.0011, coded = S > 0.00035;
    if (labelTiles.size) this.drawLabels(g, w, h, X, Z, labelTiles, this.airfieldBoxes(w, h, X, Z, view, named, coded));
    const minPop = S > 0.0016 ? 30000 : S > 0.0006 ? 120000 : S > 0.00022 ? 450000 : 1500000;
    g.font = `500 10.5px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (!this.tiles.ok) for (const [name, lat, lon, pop] of allTowns()) {
      if (pop < minPop) break;                         // (the list is sorted, biggest first)
      if (lat > view[0].lat || lat < view[1].lat || lon < view[0].lon || lon > view[1].lon) continue;
      const p = toWorld(lat, lon), px = X(p.x), pz = Z(p.z);
      g.fillStyle = 'rgba(13,18,24,0.5)'; g.fillRect(px - 1.5, pz - 1.5, 3, 3);
      g.strokeStyle = 'rgba(13,18,24,0.7)'; g.lineWidth = 2.5; g.strokeText(name, px, pz - 8);
      g.fillStyle = 'rgba(213,221,228,0.78)'; g.fillText(name, px, pz - 8);
    }

    // Airfields beyond the window, from the index: a dot from far off, its name from closer in.
    for (const f of FIELDS) {
      if (airportById(f.id)) continue;
      if (f.lat > view[0].lat || f.lat < view[1].lat || f.lon < view[0].lon || f.lon > view[1].lon) continue;
      const p = toWorld(f.lat, f.lon), px = X(p.x), pz = Z(p.z), r = coded ? 3.5 : f.big ? 2.6 : 1.8;
      g.fillStyle = '#0d1218'; g.strokeStyle = BLUE; g.lineWidth = coded ? 1.5 : 1.1;
      g.beginPath(); g.arc(px, pz, r, 0, 7); g.fill(); g.stroke();
      if (!named && !(coded && (f.big || S > 0.0007))) continue;
      const text = named ? `${f.name}  ${f.id}` : f.id;
      g.font = `600 ${named ? 11.5 : 10.5}px ${SANS}`; g.textAlign = 'left'; g.textBaseline = 'middle';
      if (named) { g.fillStyle = PLATE; g.fillRect(px + 7, pz - 8, g.measureText(text).width + 6, 15); }
      g.fillStyle = named ? INK : SOFT; g.fillText(text, px + (named ? 10 : 6), pz);
    }

    // Airfields of the window
    for (const a of AIRPORTS) {
      const px = X(a.x), pz = Z(a.z);
      if (px < -60 || px > w + 60 || pz < -30 || pz > h + 30) continue;
      const hot = opts.station === a;
      if (!coded) { g.fillStyle = '#0d1218'; g.strokeStyle = BLUE; g.lineWidth = 1.1; g.beginPath(); g.arc(px, pz, a.big ? 2.6 : 1.8, 0, 7); g.fill(); g.stroke(); continue; }
      g.strokeStyle = hot ? MAGENTA : BLUE; g.fillStyle = '#0d1218'; g.lineWidth = 1.75;
      g.beginPath(); g.arc(px, pz, 6.5, 0, 7); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(px - a.ux * 5, pz - a.uz * 5); g.lineTo(px + a.ux * 5, pz + a.uz * 5); g.lineWidth = 2.25; g.stroke();
      if (hot) { g.setLineDash([2, 3]); g.beginPath(); g.arc(px, pz, 12, 0, 7); g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      g.font = `${hot ? '700' : '600'} 12.5px ${SANS}`; g.textAlign = 'left'; g.textBaseline = 'middle';
      if (!named) { g.fillStyle = SOFT; g.fillText(a.id, px + 11, pz); continue; }
      const name = `${a.name}  ${a.id}`, tw = g.measureText(name).width;
      g.fillStyle = PLATE; g.fillRect(px + 11, pz - 14, tw + 6, 15);
      g.fillStyle = hot ? MAGENTA : INK; g.fillText(name, px + 14, pz - 6);
      g.font = `500 10.5px ${SANS}`; g.fillStyle = SOFT;
      g.fillText(`${Math.round(a.elev * 3.281)} ft · ${a.numbers.join('/')}`, px + 14, pz + 7);
    }

    // The pin, and the line to it from the aircraft
    if (this.pin) {
      const p = toWorld(this.pin.lat, this.pin.lon), px = X(p.x), pz = Z(p.z);
      if (opts.ac && opts.line !== false) { g.strokeStyle = 'rgba(255,182,73,0.55)'; g.lineWidth = 1.25; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(X(opts.ac.pos.x), Z(opts.ac.pos.z)); g.lineTo(px, pz); g.stroke(); g.setLineDash([]); }
      g.fillStyle = AMBER; g.strokeStyle = '#0a0e13'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(px, pz); g.bezierCurveTo(px - 3, pz - 9, px - 9, pz - 12, px - 9, pz - 19); g.arc(px, pz - 19, 9, Math.PI, 0); g.bezierCurveTo(px + 9, pz - 12, px + 3, pz - 9, px, pz); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#0a0e13'; g.beginPath(); g.arc(px, pz - 19, 3.2, 0, 7); g.fill();
    }

    if (opts.ac) {
      const px = X(opts.ac.pos.x), pz = Z(opts.ac.pos.z);
      g.save(); g.translate(px, pz); g.rotate(opts.ac.heading * D2R);
      g.fillStyle = '#fff'; g.strokeStyle = '#0a0e13'; g.lineWidth = 1.5; g.shadowColor = 'rgba(116,215,244,0.9)'; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(0, -11); g.lineTo(3, -2); g.lineTo(11, 3); g.lineTo(3, 3); g.lineTo(2, 9); g.lineTo(-2, 9); g.lineTo(-3, 3); g.lineTo(-11, 3); g.lineTo(-3, -2); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }

    // Scale bar
    const barNm = [0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * NM * S > 60) || 1000, bw = barNm * NM * S;
    g.fillStyle = PLATE; g.fillRect(12, h - 34, bw + 16, 24);
    g.strokeStyle = INK; g.lineWidth = 1.5; g.beginPath(); g.moveTo(20, h - 24); g.lineTo(20, h - 18); g.lineTo(20 + bw, h - 18); g.lineTo(20 + bw, h - 24); g.stroke();
    g.fillStyle = INK; g.font = `600 10.5px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(`${barNm} NM`, 20 + bw / 2, h - 22);
    if (this.tiles.ok) {
      g.font = `500 9.5px ${SANS}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      const aw = g.measureText(MAP_ATTRIBUTION).width;
      g.fillStyle = PLATE; g.fillRect(w - aw - 14, h - 19, aw + 10, 15);
      g.fillStyle = 'rgba(213,221,228,0.7)'; g.fillText(MAP_ATTRIBUTION, w - 9, h - 8);
    }
    g.restore();
  }

  /** Where the airfields' symbols and names will be drawn (as drawn in draw): the names of the map keep clear of them. */
  airfieldBoxes(w, h, X, Z, view, named, coded) {
    const boxes = [], len = (t, px) => t.length * px;
    for (const f of FIELDS) {
      if (airportById(f.id) || f.lat > view[0].lat || f.lat < view[1].lat || f.lon < view[0].lon || f.lon > view[1].lon) continue;
      const p = toWorld(f.lat, f.lon), px = X(p.x), pz = Z(p.z);
      boxes.push([px - 5, pz - 5, px + 5, pz + 5]);
      if (named) boxes.push([px + 7, pz - 8, px + 13 + len(`${f.name}  ${f.id}`, 6.6), pz + 7]);
      else if (coded && (f.big || this.scale / (this._u || 1) > 0.0007)) boxes.push([px + 6, pz - 6, px + 6 + len(f.id, 7), pz + 6]);
    }
    for (const a of AIRPORTS) {
      const px = X(a.x), pz = Z(a.z);
      if (px < -60 || px > w + 60 || pz < -30 || pz > h + 30) continue;
      if (!coded) { boxes.push([px - 4, pz - 4, px + 4, pz + 4]); continue; }
      boxes.push([px - 8, pz - 8, px + 8, pz + 8]);
      boxes.push(named ? [px + 11, pz - 14, px + 17 + len(`${a.name}  ${a.id}`, 7.2), pz + 13] : [px + 11, pz - 7, px + 11 + len(a.id, 8), pz + 7]);
    }
    return boxes;
  }

  /**
   * The names of the map data (labels of the tiles in view: see maptiles.worker.js), most important first, each
   * only where it covers no name or symbol already placed, and the same name not repeated close by.
   */
  drawLabels(g, w, h, X, Z, tiles, boxes) {
    const S = this.scale / (this._u || 1), items = [];
    for (const t of tiles) {
      if (!t.labels) continue;
      const disp = (worldX(256, t.z) - worldX(0, t.z)) * S / 256;          // screen pixels to a pixel of the tile's zoom
      for (const l of t.labels) {
        const px = X(worldX(l.x, t.z)), py = Z(worldZ(l.y, t.z));
        if (px > -60 && px < w + 60 && py > -30 && py < h + 30) items.push({ l, px, py, disp });
      }
    }
    items.sort((a, b) => a.l.p - b.l.p);
    // (the most important names, countries, states, seas and the big cities, need keep clear only of each other: the airfields are drawn over them)
    const fields = boxes.length;
    const seen = new Map(), hit = (b, from) => { for (let i = from; i < boxes.length; i++) { const o = boxes[i]; if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true; } return false; };
    const spaced = 'letterSpacing' in g;
    g.lineJoin = 'round'; g.textBaseline = 'middle';
    for (const { l, px, py, disp } of items) {
      const st = LABEL[l.k];
      if (!st) continue;
      const key = l.k + '|' + l.n, gap = l.k === 'river' || l.k === 'shield' ? 300 : 120, rep = seen.get(key);
      if (rep && rep.some(([a, b]) => Math.hypot(a - px, b - py) < gap)) continue;
      const text = st.upper ? l.n.toUpperCase() : l.n;
      g.font = `${st.font} ${SANS}`;
      if (spaced) g.letterSpacing = st.spacing || '0px';
      const tw = g.measureText(text).width, th = st.size;
      let box, tx = px, ty = py, align = 'center';
      if (l.k === 'river') {
        if (l.len * disp < tw + 24) continue;                                 // no room along the river here
        const c = Math.abs(Math.cos(l.a)), s = Math.abs(Math.sin(l.a)), bw = tw * c + th * s, bh = tw * s + th * c;
        box = [px - bw / 2, py - bh / 2, px + bw / 2, py + bh / 2];
      } else if (l.k === 'shield') {
        const sw = Math.max(tw + 8, 18);
        box = [px - sw / 2 - 2, py - 9, px + sw / 2 + 2, py + 9];
      } else if (l.k === 'peak' || l.k === 'poi') {
        ty = py - (l.k === 'peak' ? 12 : 11);                                  // the name over its symbol (and a peak's height under it)
        box = [px - tw / 2 - 2, ty - th / 2 - 1, px + tw / 2 + 2, py + (l.k === 'peak' && l.e ? 16 : 5)];
      } else if (st.dot) {
        ty = py - st.dot - th / 2 - 1;                                         // the name over its dot
        box = [px - tw / 2 - 2, ty - th / 2 - 1, px + tw / 2 + 2, py + st.dot + 1];
      } else box = [px - tw / 2 - 2, py - th / 2 - 1, px + tw / 2 + 2, py + th / 2 + 1];
      if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h || hit(box, l.p < 4.5 ? fields : 0)) continue;
      boxes.push(box);
      if (rep) rep.push([px, py]); else seen.set(key, [[px, py]]);

      if (l.k === 'shield') { this.drawShield(g, px, py, text, tw, l.net); continue; }
      g.save();
      if (l.k === 'river') { g.translate(px, py); g.rotate(l.a); tx = 0; ty = 0; }
      if (st.dot) {
        g.beginPath(); g.arc(px, py, st.dot, 0, 7); g.fillStyle = st.color; g.strokeStyle = 'rgba(9,13,18,0.9)'; g.lineWidth = 1.2; g.fill(); g.stroke();
        if (l.cap === 2) { g.beginPath(); g.arc(px, py, st.dot + 2.5, 0, 7); g.strokeStyle = st.color; g.lineWidth = 1; g.stroke(); }
      }
      if (l.k === 'peak') { g.beginPath(); g.moveTo(px, py - 5); g.lineTo(px + 4.5, py + 3); g.lineTo(px - 4.5, py + 3); g.closePath(); g.fillStyle = st.color; g.strokeStyle = 'rgba(9,13,18,0.9)'; g.lineWidth = 1.2; g.fill(); g.stroke(); }
      if (l.k === 'poi') { g.beginPath(); g.moveTo(px, py - 3.5); g.lineTo(px + 3.5, py); g.lineTo(px, py + 3.5); g.lineTo(px - 3.5, py); g.closePath(); g.fillStyle = st.color; g.fill(); }
      g.textAlign = align;
      g.strokeStyle = 'rgba(9,13,18,0.82)'; g.lineWidth = 3; g.strokeText(text, tx, ty);
      g.fillStyle = st.color; g.fillText(text, tx, ty);
      if (l.k === 'peak' && l.e) {
        g.font = `500 9.5px ${SANS}`; if (spaced) g.letterSpacing = '0px';
        const e = `${Math.round(l.e).toLocaleString('en-US')} ft`;
        g.strokeText(e, px, py + 11); g.fillStyle = 'rgba(216,204,180,0.7)'; g.fillText(e, px, py + 11);
      }
      g.restore();
    }
    if (spaced) g.letterSpacing = '0px';
  }

  /** A highway number: the interstates' blue shield, the US highways' white one, a plain plate for the rest. */
  drawShield(g, px, py, text, tw, net) {
    const sw = Math.max(tw + 8, 18), x = px - sw / 2, y = py - 8;
    const [bg, fg, edge] = net === 'i' ? ['#2c5aa0', '#fff', '#e6ecf2'] : net === 'us' ? ['#e9edf0', '#111', '#0a0e13'] : net === 'ca' ? ['#2f7a46', '#fff', '#e6ecf2'] : ['#39424b', '#e9edf0', '#69737d'];
    g.beginPath();
    if (net === 'i') { g.moveTo(x, y); g.lineTo(x + sw, y); g.lineTo(x + sw, y + 10); g.quadraticCurveTo(x + sw, y + 16, px, y + 17); g.quadraticCurveTo(x, y + 16, x, y + 10); g.closePath(); }
    else g.roundRect(x, y, sw, 16, net === 'us' ? 5 : 3);
    g.fillStyle = bg; g.fill(); g.strokeStyle = edge; g.lineWidth = 1; g.stroke();
    g.fillStyle = fg; g.textAlign = 'center'; g.fillText(text, px, py + (net === 'i' ? 0.5 : 0));
  }

  drawWeather(g, w, h, wx, X, Z) {
    const S = this.scale / (this._u || 1);
    g.save();
    // Wind arrows at 5,000 ft on a coarse grid
    const o = { x: 0, z: 0 }, stepPx = 64;
    g.strokeStyle = 'rgba(200,222,238,0.5)'; g.fillStyle = 'rgba(200,222,238,0.8)'; g.lineWidth = 1.2; g.font = `500 9.5px ${SANS}`; g.textAlign = 'center';
    for (let py = stepPx / 2; py < h; py += stepPx) for (let px = stepPx / 2; px < w; px += stepPx) {
      const x = this.cx + (px - w / 2) / S, z = this.cz + (py - h / 2) / S;
      wx.wind(x, z, 1500, 0, o);
      const sp = Math.hypot(o.x, o.z), kt = sp * 1.944;
      if (kt < 3) continue;
      const ux = o.x / sp, uz = o.z / sp, L = 7 + Math.min(kt, 50) * 0.32;
      g.beginPath(); g.moveTo(px - ux * L, py - uz * L); g.lineTo(px + ux * L, py + uz * L);
      g.lineTo(px + ux * L - (ux - uz) * 4, py + uz * L - (uz + ux) * 4); g.moveTo(px + ux * L, py + uz * L); g.lineTo(px + ux * L - (ux + uz) * 4, py + uz * L - (uz - ux) * 4); g.stroke();
      g.fillText(Math.round(kt), px - uz * 11, py + ux * 11 + 3);
    }
    // Fog banks
    for (const f of wx.fogs) {
      g.fillStyle = 'rgba(255,182,73,0.16)'; g.strokeStyle = 'rgba(255,182,73,0.8)'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(X(f.x), Z(f.z), f.r * S, 0, 7); g.fill(); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#ffb649'; g.font = `700 11px ${SANS}`; g.fillText('FOG', X(f.x), Z(f.z) + 4);
    }
    // Thunderstorm cells
    for (const c of wx.cells) {
      const ph = c.age / c.life, px = X(c.x), pz = Z(c.z), rr = Math.max(5, c.r * S);
      g.strokeStyle = `rgba(255,98,80,${0.35 + 0.6 * Math.sin(Math.PI * ph)})`; g.lineWidth = 1.75;
      g.beginPath();
      for (let k = 0; k < 8; k++) { const a = (k / 8) * 6.283; g.moveTo(px + Math.cos(a) * rr + rr * 0.42, pz + Math.sin(a) * rr); g.arc(px + Math.cos(a) * rr, pz + Math.sin(a) * rr, rr * 0.42, 0, 7); }
      g.stroke();
    }
    // Pressure centers and fronts
    for (const l of wx.lows) {
      const px = X(l.x), pz = Z(l.z);
      g.fillStyle = '#ff6250'; g.font = `700 24px ${SANS}`; g.textAlign = 'center'; g.fillText('L', px, pz + 9);
      if (!l.fronts) continue;
      for (const [th0, curl, len, col, warm] of [[l.thC, l.curlC, 2.4, '#5b9cff', false], [l.thW, l.curlW, 1.6, '#ff6250', true]]) {
        const pts = [];
        for (let ds = 0.12; ds <= len; ds += 0.06) { const th = th0 + curl * ds; pts.push([X(l.x + Math.cos(th) * ds * l.sig), Z(l.z - Math.sin(th) * ds * l.sig)]); }
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2.25; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
        // pips on the advancing side
        let acc = 0;
        for (let i = 1; i < pts.length; i++) {
          const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1], dl = Math.hypot(dx, dz);
          acc += dl;
          if (acc < 26) continue;
          acc = 0;
          const nx = dz / dl, nz = -dx / dl;           // the side the front is advancing toward
          g.beginPath();
          if (warm) g.arc(pts[i][0], pts[i][1], 6, Math.atan2(dz, dx) + Math.PI, Math.atan2(dz, dx), false);
          else { g.moveTo(pts[i][0] - dx / dl * 6, pts[i][1] - dz / dl * 6); g.lineTo(pts[i][0] + nx * 9, pts[i][1] + nz * 9); g.lineTo(pts[i][0] + dx / dl * 6, pts[i][1] + dz / dl * 6); }
          g.fill();
        }
      }
    }
    for (const hh of wx.highs) { g.fillStyle = '#5b9cff'; g.font = `700 24px ${SANS}`; g.textAlign = 'center'; g.fillText('H', X(hh.x), Z(hh.z) + 9); }
    g.restore();
  }
}
