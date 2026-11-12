// The aeronautical chart. A relief-shaded base map is baked once from the
// regional elevation grid, then drawn with airfields, the aircraft and
// (optionally) the synoptic weather picture on top.

import { baseHeight, baseWater, moisture, LAND_HALF } from '../world/terrain.js';
import { AIRPORTS } from '../world/airports.js';
import { NM } from '../aircraft/physics.js';

const D2R = Math.PI / 180;
// The map is drawn dark, like the rest of the interface: muted relief, one cool colour for airfields.
const INK = '#edf1f4', MAGENTA = '#ffffff', BLUE = '#74d7f4', PLATE = 'rgba(13,18,24,0.74)', SOFT = 'rgba(170,181,191,0.95)';
const SANS = '"Inter", "Adwaita Sans", -apple-system, "Segoe UI", Roboto, "Noto Sans", system-ui, sans-serif';
/** Type and symbols follow the interface's root size, so the map reads the same at 720p and at 4K. */
const uiScale = () => (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;

export function bakeChart(size = 900) {
  const H = LAND_HALF, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
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
      // Hypsometric tint, dark: deep green lowlands, olive uplands, brown-grey ranges, pale tops; greener where wet.
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
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class Chart {
  /** base: the canvas from bakeChart (give it a new one, `chart.base = bakeChart()`, when the world moves). */
  constructor(base) {
    this.base = base;
    this.cx = 0; this.cz = 0; this.scale = 0.0016;       // pixels per metre
    this.showWx = false;
  }

  /** Fit a route (or the whole map) into a viewport of w x h pixels. */
  fit(w, h, route, pad = 0.25) {
    if (!route) { this.cx = 0; this.cz = 0; this.scale = Math.min(w, h) / (LAND_HALF * 2); return; }
    this.cx = (route.ax + route.bx) / 2; this.cz = (route.az + route.bz) / 2;
    const span = Math.max(Math.abs(route.bx - route.ax), Math.abs(route.bz - route.az), 60000);
    this.scale = Math.min(w, h) / (span * (1 + pad * 2));
  }
  zoom(f, w, h) { this.scale = Math.max(Math.min(w, h) / (LAND_HALF * 2.4), Math.min(0.03, this.scale * f)); }
  pan(dxPx, dzPx) {
    this.cx = Math.max(-LAND_HALF, Math.min(LAND_HALF, this.cx - dxPx / this.scale));
    this.cz = Math.max(-LAND_HALF, Math.min(LAND_HALF, this.cz - dzPx / this.scale));
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
    g.drawImage(this.base, X(-LAND_HALF), Z(-LAND_HALF), LAND_HALF * 2 * S, LAND_HALF * 2 * S);

    // Graticule every 20 NM
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1; g.fillStyle = 'rgba(237,241,244,0.42)'; g.font = `500 10.5px ${SANS}`;
    const stepM = 20 * NM, n = Math.floor(LAND_HALF / stepM);
    for (let k = -n; k <= n; k++) {
      const p = k * stepM;
      g.beginPath(); g.moveTo(X(p), Z(-LAND_HALF)); g.lineTo(X(p), Z(LAND_HALF)); g.moveTo(X(-LAND_HALF), Z(p)); g.lineTo(X(LAND_HALF), Z(p)); g.stroke();
      if (S * stepM > 34) {
        g.textAlign = 'left'; g.textBaseline = 'top';
        g.fillText(`${Math.abs(k * 20)}${k < 0 ? 'W' : 'E'}`, X(p) + 3, 3);
        g.fillText(`${Math.abs(k * 20)}${k < 0 ? 'N' : 'S'}`, 3, Z(p) + 3);
      }
    }

    if (opts.weather && this.showWx) this.drawWeather(g, w, h, opts.weather, X, Z);

    // Airfields
    for (const a of AIRPORTS) {
      const px = X(a.x), pz = Z(a.z);
      if (px < -60 || px > w + 60 || pz < -30 || pz > h + 30) continue;
      const hot = opts.station === a;
      g.strokeStyle = hot ? MAGENTA : BLUE; g.fillStyle = '#0d1218'; g.lineWidth = 1.75;
      g.beginPath(); g.arc(px, pz, 6.5, 0, 7); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(px - a.ux * 5, pz - a.uz * 5); g.lineTo(px + a.ux * 5, pz + a.uz * 5); g.lineWidth = 2.25; g.stroke();
      if (hot) { g.setLineDash([2, 3]); g.beginPath(); g.arc(px, pz, 12, 0, 7); g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      g.font = `${hot ? '700' : '600'} 12.5px ${SANS}`; g.textAlign = 'left'; g.textBaseline = 'middle';
      const name = `${a.name}  ${a.id}`, tw = g.measureText(name).width;
      g.fillStyle = PLATE; g.fillRect(px + 11, pz - 14, tw + 6, 15);
      g.fillStyle = hot ? MAGENTA : INK; g.fillText(name, px + 14, pz - 6);
      g.font = `500 10.5px ${SANS}`; g.fillStyle = SOFT;
      g.fillText(`${Math.round(a.elev * 3.281)} ft · ${a.numbers.join('/')}`, px + 14, pz + 7);
    }

    if (opts.ac) {
      const px = X(opts.ac.pos.x), pz = Z(opts.ac.pos.z);
      g.save(); g.translate(px, pz); g.rotate(opts.ac.heading * D2R);
      g.fillStyle = '#fff'; g.strokeStyle = '#0a0e13'; g.lineWidth = 1.5; g.shadowColor = 'rgba(116,215,244,0.9)'; g.shadowBlur = 8;
      g.beginPath(); g.moveTo(0, -11); g.lineTo(3, -2); g.lineTo(11, 3); g.lineTo(3, 3); g.lineTo(2, 9); g.lineTo(-2, 9); g.lineTo(-3, 3); g.lineTo(-11, 3); g.lineTo(-3, -2); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }

    // Scale bar
    const barNm = [5, 10, 20, 50].find((v) => v * NM * S > 60) || 50, bw = barNm * NM * S;
    g.fillStyle = PLATE; g.fillRect(12, h - 34, bw + 16, 24);
    g.strokeStyle = INK; g.lineWidth = 1.5; g.beginPath(); g.moveTo(20, h - 24); g.lineTo(20, h - 18); g.lineTo(20 + bw, h - 18); g.lineTo(20 + bw, h - 24); g.stroke();
    g.fillStyle = INK; g.font = `600 10.5px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(`${barNm} NM`, 20 + bw / 2, h - 22);
    g.restore();
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
    // Pressure centres and fronts
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
