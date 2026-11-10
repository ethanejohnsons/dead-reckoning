// The aeronautical chart. A relief-shaded base map is baked once from the
// terrain, then drawn with airfields, the planned course, the dead-reckoning
// track and (optionally) the synoptic weather picture on top.

import { height, terrainColor, LAND_HALF } from '../world/terrain.js';
import { AIRPORTS } from '../world/airports.js';
import { NM } from '../aircraft/physics.js';

const D2R = Math.PI / 180;
const INK = '#2a2f3a', MAGENTA = '#b01872', BLUE = '#1c56a8', PENCIL = '#3b3b3b';

export function bakeChart(size = 768) {
  const H = LAND_HALF, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  const hs = new Float32Array(size * size), col = [0, 0, 0], px = (2 * H) / size;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) hs[j * size + i] = height(((i + 0.5) / size) * 2 * H - H, ((j + 0.5) / size) * 2 * H - H, 1);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i, h = hs[k], o = k * 4;
    const hx = hs[j * size + Math.min(i + 1, size - 1)] - hs[j * size + Math.max(i - 1, 0)];
    const hz = hs[Math.min(j + 1, size - 1) * size + i] - hs[Math.max(j - 1, 0) * size + i];
    const nx = -hx / (2 * px), nz = -hz / (2 * px), nl = Math.hypot(nx, 1, nz);
    let r, gr, b;
    if (h <= 0) {
      const t = Math.min(1, -h / 250);
      r = 0.80 - 0.14 * t; gr = 0.87 - 0.10 * t; b = 0.90 - 0.05 * t;
    } else {
      terrainColor(((i + 0.5) / size) * 2 * H - H, ((j + 0.5) / size) * 2 * H - H, h, 1 - 1 / nl, col, 0);
      // Lift toward paper tone, then shade relief from the northwest.
      const sh = Math.max(0.62, Math.min(1.18, 0.82 + (nx * -0.7 + nz * -0.7) / nl * 1.1));
      r = (Math.pow(col[0], 0.45) * 0.62 + 0.36) * sh; gr = (Math.pow(col[1], 0.45) * 0.62 + 0.35) * sh; b = (Math.pow(col[2], 0.45) * 0.62 + 0.30) * sh;
      // contour every 500 m
      const lv = Math.floor(h / 500);
      if (lv !== Math.floor(hs[k + (i < size - 1 ? 1 : 0)] / 500) || lv !== Math.floor(hs[k + (j < size - 1 ? size : 0)] / 500)) { r *= 0.8; gr *= 0.76; b *= 0.7; }
      if (hs[k + (i < size - 1 ? 1 : 0)] <= 0 || hs[k + (j < size - 1 ? size : 0)] <= 0 || hs[k - (i > 0 ? 1 : 0)] <= 0 || hs[k - (j > 0 ? size : 0)] <= 0) { r = 0.25; gr = 0.38; b = 0.5; }
    }
    d[o] = Math.min(255, r * 255); d[o + 1] = Math.min(255, gr * 255); d[o + 2] = Math.min(255, b * 255); d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

export class Chart {
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
   * opts: { route, nav, ac (true position, only shown with GPS assist), gps, weather, elapsed, lop }
   */
  draw(g, w, h, opts = {}) {
    const S = this.scale, X = (x) => w / 2 + (x - this.cx) * S, Z = (z) => h / 2 + (z - this.cz) * S;
    g.save();
    g.fillStyle = '#a8c4d9'; g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(this.base, X(-LAND_HALF), Z(-LAND_HALF), LAND_HALF * 2 * S, LAND_HALF * 2 * S);

    // Graticule every 20 NM
    g.strokeStyle = 'rgba(40,50,70,0.22)'; g.lineWidth = 1; g.fillStyle = 'rgba(40,50,70,0.6)'; g.font = '10px ui-monospace, Menlo, monospace';
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

    // Planned course
    const r = opts.route;
    if (r) {
      g.strokeStyle = MAGENTA; g.lineWidth = 2.2; g.setLineDash([]);
      g.beginPath(); g.moveTo(X(r.ax), Z(r.az)); g.lineTo(X(r.bx), Z(r.bz)); g.stroke();
      const mx = (X(r.ax) + X(r.bx)) / 2, mz = (Z(r.az) + Z(r.bz)) / 2;
      const crs = (Math.atan2(r.bx - r.ax, -(r.bz - r.az)) / D2R + 360) % 360, dist = Math.hypot(r.bx - r.ax, r.bz - r.az) / NM;
      const label = `${String(Math.round(crs)).padStart(3, '0')}°  ${Math.round(dist)} NM`;
      g.font = '600 12px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tw = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(244,238,220,0.92)'; g.fillRect(mx - tw / 2, mz - 9, tw, 18);
      g.fillStyle = MAGENTA; g.fillText(label, mx, mz + 1);
      // tick marks every 10 NM along the course
      const ux = (r.bx - r.ax) / (dist * NM), uz = (r.bz - r.az) / (dist * NM);
      for (let m = 10; m < dist; m += 10) {
        const px = X(r.ax + ux * m * NM), pz = Z(r.az + uz * m * NM);
        g.beginPath(); g.moveTo(px - uz * 5, pz + ux * 5); g.lineTo(px + uz * 5, pz - ux * 5); g.lineWidth = 1.5; g.stroke();
      }
    }

    // Airfields
    for (const a of AIRPORTS) {
      const px = X(a.x), pz = Z(a.z);
      if (px < -60 || px > w + 60 || pz < -30 || pz > h + 30) continue;
      const hot = r && (a.id === r.to || a.id === r.from);
      g.strokeStyle = hot ? MAGENTA : BLUE; g.fillStyle = 'rgba(244,238,220,0.9)'; g.lineWidth = 2;
      g.beginPath(); g.arc(px, pz, 6.5, 0, 7); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(px - a.ux * 5, pz - a.uz * 5); g.lineTo(px + a.ux * 5, pz + a.uz * 5); g.lineWidth = 2.5; g.stroke();
      if (opts.nav?.station === a) { g.setLineDash([2, 3]); g.beginPath(); g.arc(px, pz, 12, 0, 7); g.lineWidth = 1.5; g.stroke(); g.setLineDash([]); }
      g.font = `${hot ? '700' : '600'} 11.5px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
      const name = `${a.name}  ${a.id}`, tw = g.measureText(name).width;
      g.fillStyle = 'rgba(244,238,220,0.78)'; g.fillRect(px + 11, pz - 14, tw + 6, 15);
      g.fillStyle = hot ? MAGENTA : INK; g.fillText(name, px + 14, pz - 6);
      g.font = '10px ui-monospace, Menlo, monospace'; g.fillStyle = 'rgba(42,47,58,0.85)';
      g.fillText(`${Math.round(a.elev * 3.281)} ft · ${a.numbers.join('/')}`, px + 14, pz + 7);
    }

    const nav = opts.nav;
    if (nav) {
      // Line of position from the tuned beacon
      if (opts.lop) {
        const s = opts.lop.station, b = opts.lop.bearing * D2R;
        g.strokeStyle = 'rgba(28,86,168,0.75)'; g.lineWidth = 1.4; g.setLineDash([7, 5]);
        g.beginPath(); g.moveTo(X(s.x), Z(s.z)); g.lineTo(X(s.x + Math.sin(b) * 260000), Z(s.z - Math.cos(b) * 260000)); g.stroke(); g.setLineDash([]);
      }
      // Pencilled dead-reckoning track
      const t = nav.track;
      g.strokeStyle = PENCIL; g.lineWidth = 1.6; g.setLineDash([5, 4]);
      g.beginPath();
      for (let i = 0; i < t.length; i += 2) i ? g.lineTo(X(t[i]), Z(t[i + 1])) : g.moveTo(X(t[i]), Z(t[i + 1]));
      g.lineTo(X(nav.dr.x), Z(nav.dr.z)); g.stroke(); g.setLineDash([]);
      for (const f of nav.fixes) {
        const px = X(f.x), pz = Z(f.z);
        g.beginPath(); g.moveTo(px, pz - 6); g.lineTo(px + 5.5, pz + 4); g.lineTo(px - 5.5, pz + 4); g.closePath(); g.strokeStyle = PENCIL; g.lineWidth = 1.5; g.stroke();
      }
      const px = X(nav.dr.x), pz = Z(nav.dr.z), ur = nav.uncertainty * S;
      g.fillStyle = 'rgba(59,59,59,0.10)'; g.strokeStyle = 'rgba(59,59,59,0.55)'; g.lineWidth = 1;
      g.beginPath(); g.arc(px, pz, Math.max(ur, 5), 0, 7); g.fill(); g.stroke();
      g.strokeStyle = PENCIL; g.lineWidth = 2; g.beginPath(); g.moveTo(px - 7, pz); g.lineTo(px + 7, pz); g.moveTo(px, pz - 7); g.lineTo(px, pz + 7); g.stroke();
      g.font = '600 11px ui-monospace, Menlo, monospace'; g.textAlign = 'left'; g.fillStyle = PENCIL;
      g.fillText('DR', px + 9, pz - 9);
    }
    if (opts.gps && opts.ac) {
      const px = X(opts.ac.pos.x), pz = Z(opts.ac.pos.z);
      g.save(); g.translate(px, pz); g.rotate(opts.ac.heading * D2R);
      g.fillStyle = '#d0301a'; g.strokeStyle = '#fff'; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(0, -11); g.lineTo(3, -2); g.lineTo(11, 3); g.lineTo(3, 3); g.lineTo(2, 9); g.lineTo(-2, 9); g.lineTo(-3, 3); g.lineTo(-11, 3); g.lineTo(-3, -2); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }

    // Scale bar
    const barNm = [5, 10, 20, 50].find((v) => v * NM * S > 60) || 50, bw = barNm * NM * S;
    g.fillStyle = 'rgba(244,238,220,0.9)'; g.fillRect(12, h - 34, bw + 16, 24);
    g.strokeStyle = INK; g.lineWidth = 2; g.beginPath(); g.moveTo(20, h - 24); g.lineTo(20, h - 18); g.lineTo(20 + bw, h - 18); g.lineTo(20 + bw, h - 24); g.stroke();
    g.fillStyle = INK; g.font = '10px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(`${barNm} NM`, 20 + bw / 2, h - 22);
    g.restore();
  }

  drawWeather(g, w, h, wx, X, Z) {
    const S = this.scale;
    g.save();
    // Wind arrows at 5,000 ft on a coarse grid
    const o = { x: 0, z: 0 }, stepPx = 64;
    g.strokeStyle = 'rgba(20,40,90,0.55)'; g.fillStyle = 'rgba(20,40,90,0.75)'; g.lineWidth = 1.3; g.font = '9px ui-monospace, Menlo, monospace'; g.textAlign = 'center';
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
      g.fillStyle = 'rgba(200,170,60,0.25)'; g.strokeStyle = 'rgba(150,120,20,0.8)'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.beginPath(); g.arc(X(f.x), Z(f.z), f.r * S, 0, 7); g.fill(); g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(120,95,10,0.95)'; g.font = '700 12px ui-sans-serif, system-ui, sans-serif'; g.fillText('FOG', X(f.x), Z(f.z) + 4);
    }
    // Thunderstorm cells
    for (const c of wx.cells) {
      const ph = c.age / c.life, px = X(c.x), pz = Z(c.z), rr = Math.max(5, c.r * S);
      g.strokeStyle = `rgba(190,30,30,${0.35 + 0.6 * Math.sin(Math.PI * ph)})`; g.lineWidth = 2;
      g.beginPath();
      for (let k = 0; k < 8; k++) { const a = (k / 8) * 6.283; g.moveTo(px + Math.cos(a) * rr + rr * 0.42, pz + Math.sin(a) * rr); g.arc(px + Math.cos(a) * rr, pz + Math.sin(a) * rr, rr * 0.42, 0, 7); }
      g.stroke();
    }
    // Pressure centres and fronts
    for (const l of wx.lows) {
      const px = X(l.x), pz = Z(l.z);
      g.fillStyle = '#b3201a'; g.font = '700 26px ui-serif, Georgia, serif'; g.textAlign = 'center'; g.fillText('L', px, pz + 9);
      if (!l.fronts) continue;
      for (const [th0, curl, len, col, warm] of [[l.thC, l.curlC, 2.4, '#1746b0', false], [l.thW, l.curlW, 1.6, '#c0201a', true]]) {
        const pts = [];
        for (let ds = 0.12; ds <= len; ds += 0.06) { const th = th0 + curl * ds; pts.push([X(l.x + Math.cos(th) * ds * l.sig), Z(l.z - Math.sin(th) * ds * l.sig)]); }
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2.5; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
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
    for (const hh of wx.highs) { g.fillStyle = '#1746b0'; g.font = '700 26px ui-serif, Georgia, serif'; g.textAlign = 'center'; g.fillText('H', X(hh.x), Z(hh.z) + 9); }
    g.restore();
  }
}
