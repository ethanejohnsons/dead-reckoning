// The instrument panel: six analogue dials drawn on a canvas each frame.
// Airspeed, attitude, altimeter, radio compass (heading card + ADF needle),
// vertical speed, and an engine/clock cluster. Units are aviation standard:
// knots, feet, feet per minute.

import { KT, FT, SPEC } from '../aircraft/physics.js';

const D2R = Math.PI / 180;
const CREAM = '#e9e2cc', DIM = '#9a947f', AMBER = '#f0a030', RED = '#e04530', GREEN = '#58b56a', FACE = '#15171a';

export class HUD {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.R = 62; this.n = 6;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const maxW = Math.min(innerWidth - 24, 900);
    this.R = Math.floor(Math.min(66, (maxW / this.n - 14) / 2));
    this.cell = this.R * 2 + 14;
    const w = this.cell * this.n + 10, h = this.cell + 12;
    this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  face(i, label) {
    const g = this.ctx, R = this.R, cx = 5 + this.cell * i + this.cell / 2, cy = 6 + this.cell / 2;
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.arc(0, 0, R + 5, 0, 7); g.fillStyle = '#2b2d31'; g.fill();
    g.beginPath(); g.arc(0, 0, R + 2.5, 0, 7); g.fillStyle = '#0b0c0e'; g.fill();
    g.beginPath(); g.arc(0, 0, R, 0, 7); g.fillStyle = FACE; g.fill();
    if (label) { g.fillStyle = DIM; g.font = `600 ${R * 0.14}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 0, -R * 0.34); }
    return g;
  }
  // angle helper: 0 = 12 o'clock, clockwise positive
  tick(g, deg, r0, r1, w = 1.5, col = CREAM) {
    const a = (deg - 90) * D2R;
    g.beginPath(); g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.strokeStyle = col; g.lineWidth = w; g.stroke();
  }
  num(g, deg, r, text, size, col = CREAM) {
    const a = (deg - 90) * D2R;
    g.fillStyle = col; g.font = `600 ${size}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, Math.cos(a) * r, Math.sin(a) * r);
  }
  arc(g, d0, d1, r, w, col) {
    g.beginPath(); g.arc(0, 0, r, (d0 - 90) * D2R, (d1 - 90) * D2R); g.strokeStyle = col; g.lineWidth = w; g.stroke();
  }
  needle(g, deg, len, w = 3, col = '#f4f0e4', tail = 0.18) {
    const R = this.R;
    g.save(); g.rotate(deg * D2R);
    g.beginPath(); g.moveTo(-w / 2, R * tail); g.lineTo(-w / 2, -len * 0.75); g.lineTo(0, -len); g.lineTo(w / 2, -len * 0.75); g.lineTo(w / 2, R * tail); g.closePath();
    g.fillStyle = col; g.fill(); g.restore();
    g.beginPath(); g.arc(0, 0, R * 0.07, 0, 7); g.fillStyle = '#3a3c40'; g.fill();
  }

  /** s: snapshot of flight state assembled by main.js */
  draw(s) {
    const g = this.ctx, R = this.R;
    g.clearRect(0, 0, this.w, this.h);

    // 1. Airspeed (knots): 0 at 7 o'clock sweeping 300 degrees to 200 kt
    {
      this.face(0, 'AIRSPEED');
      const A = (kt) => -150 + (Math.min(kt, 200) / 200) * 300;
      this.arc(g, A(58), A(105), R * 0.9, R * 0.045, '#d8d4c6');
      this.arc(g, A(67), A(150), R * 0.96, R * 0.06, GREEN);
      this.arc(g, A(150), A(178), R * 0.96, R * 0.06, AMBER);
      this.tick(g, A(178), R * 0.8, R, 3, RED);
      for (let k = 0; k <= 200; k += 10) this.tick(g, A(k), R * (k % 20 ? 0.86 : 0.8), R * 0.93, k % 20 ? 1 : 1.8);
      for (let k = 40; k <= 200; k += 40) this.num(g, A(k), R * 0.64, k, R * 0.17);
      g.fillStyle = DIM; g.font = `${R * 0.13}px ui-sans-serif, system-ui, sans-serif`; g.fillText('KT', 0, R * 0.42);
      this.needle(g, A(s.ias * KT), R * 0.88);
      g.restore();
    }
    // 2. Attitude
    {
      this.face(1);
      g.save(); g.beginPath(); g.arc(0, 0, R * 0.94, 0, 7); g.clip();
      g.rotate(-s.bank);
      const ppd = R / 32, off = (s.pitch / D2R) * ppd;
      g.fillStyle = '#3f86c9'; g.fillRect(-R * 2, -R * 3 + off, R * 4, R * 3);
      g.fillStyle = '#7a5433'; g.fillRect(-R * 2, off, R * 4, R * 3);
      g.strokeStyle = '#f4f0e4'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-R * 2, off); g.lineTo(R * 2, off); g.stroke();
      g.fillStyle = '#f4f0e4'; g.font = `${R * 0.13}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      for (let p = -60; p <= 60; p += 5) {
        if (!p) continue;
        const y = off - p * ppd, w = p % 10 ? R * 0.12 : R * 0.26;
        if (Math.abs(y) > R) continue;
        g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.lineWidth = 1.2; g.stroke();
        if (p % 10 === 0) { g.fillText(Math.abs(p), -w - R * 0.13, y); g.fillText(Math.abs(p), w + R * 0.13, y); }
      }
      // bank scale rotates with the horizon
      for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) this.tick(g, b, R * (b % 30 ? 0.86 : 0.8), R * 0.94, b ? 1.5 : 3, '#f4f0e4');
      g.restore();
      // fixed aircraft symbol and bank pointer
      g.strokeStyle = AMBER; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-R * 0.55, 0); g.lineTo(-R * 0.2, 0); g.lineTo(-R * 0.2, R * 0.08); g.moveTo(R * 0.55, 0); g.lineTo(R * 0.2, 0); g.lineTo(R * 0.2, R * 0.08); g.stroke();
      g.fillStyle = AMBER; g.beginPath(); g.arc(0, 0, 2.5, 0, 7); g.fill();
      g.beginPath(); g.moveTo(0, -R * 0.94); g.lineTo(-R * 0.07, -R * 0.8); g.lineTo(R * 0.07, -R * 0.8); g.closePath(); g.fill();
      g.lineCap = 'butt';
      g.restore();
    }
    // 3. Altimeter (feet)
    {
      this.face(2, 'ALT');
      const ft = s.alt * FT;
      for (let k = 0; k < 50; k++) this.tick(g, k * 7.2, R * (k % 5 ? 0.88 : 0.8), R * 0.95, k % 5 ? 1 : 1.8);
      for (let k = 0; k < 10; k++) this.num(g, k * 36, R * 0.66, k, R * 0.18);
      // drum readout
      const bw = R * 0.92, bh = R * 0.3;
      g.fillStyle = '#000'; g.strokeStyle = '#444'; g.lineWidth = 1; g.fillRect(-bw / 2, R * 0.18, bw, bh); g.strokeRect(-bw / 2, R * 0.18, bw, bh);
      g.fillStyle = CREAM; g.font = `600 ${R * 0.23}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(Math.round(ft / 10) * 10), 0, R * 0.34);
      g.fillStyle = DIM; g.font = `${R * 0.12}px ui-sans-serif, system-ui, sans-serif`; g.fillText('FEET', 0, R * 0.6);
      this.needle(g, ((ft % 10000) / 10000) * 360, R * 0.5, 5, '#cfcab8', 0);
      this.needle(g, ((ft % 1000) / 1000) * 360, R * 0.9, 3);
      g.restore();
    }
    // 4. Radio compass: rotating heading card, fixed lubber line, ADF needle, autopilot bug
    {
      this.face(3);
      g.save(); g.rotate(-s.heading * D2R);
      for (let d = 0; d < 360; d += 5) this.tick(g, d, R * (d % 30 ? (d % 10 ? 0.9 : 0.86) : 0.82), R * 0.96, d % 30 ? 1 : 1.8);
      for (let d = 0; d < 360; d += 30) {
        const lab = d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : d / 10;
        g.save(); g.rotate(d * D2R); g.fillStyle = d % 90 ? CREAM : AMBER; g.font = `600 ${R * (d % 90 ? 0.16 : 0.2)}px ui-sans-serif, system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(lab, 0, -R * 0.68); g.restore();
      }
      if (s.apOn) { g.save(); g.rotate(s.apHdg * D2R); g.fillStyle = '#ff7a1a'; g.fillRect(-R * 0.09, -R * 0.99, R * 0.18, R * 0.1); g.restore(); }
      g.restore();
      if (s.adf !== null) {
        g.save(); g.rotate(s.adf * D2R);
        g.strokeStyle = '#ffd24a'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, R * 0.52); g.lineTo(0, -R * 0.44); g.stroke();
        g.fillStyle = '#ffd24a'; g.beginPath(); g.moveTo(0, -R * 0.58); g.lineTo(-R * 0.09, -R * 0.4); g.lineTo(R * 0.09, -R * 0.4); g.closePath(); g.fill();
        g.restore();
      }
      g.fillStyle = '#f4f0e4'; g.beginPath(); g.moveTo(0, -R * 0.99); g.lineTo(-R * 0.06, -R * 1.1); g.lineTo(R * 0.06, -R * 1.1); g.closePath(); g.fill();
      g.strokeStyle = '#f4f0e4'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -R * 0.2); g.lineTo(0, R * 0.2); g.moveTo(-R * 0.16, 0); g.lineTo(R * 0.16, 0); g.moveTo(-R * 0.07, R * 0.15); g.lineTo(R * 0.07, R * 0.15); g.stroke();
      g.font = `600 ${R * 0.15}px ui-monospace, Menlo, Consolas, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = s.adf !== null ? '#ffd24a' : RED; g.fillText(s.adf !== null ? s.station : s.station + ' ✕', 0, R * 0.36);
      g.restore();
    }
    // 5. Vertical speed (x1000 ft/min)
    {
      this.face(4, 'VERT SPEED');
      const fpm = Math.max(-2000, Math.min(2000, s.vs * FT * 60));
      const A = (v) => -90 + (v / 2000) * 172;
      for (let v = -2000; v <= 2000; v += 100) this.tick(g, A(v), R * (v % 500 ? 0.88 : 0.8), R * 0.95, v % 500 ? 1 : 1.8);
      for (const v of [-2000, -1000, 0, 1000, 2000]) this.num(g, A(v), R * 0.64, Math.abs(v / 1000), R * 0.18);
      g.fillStyle = DIM; g.font = `${R * 0.115}px ui-sans-serif, system-ui, sans-serif`; g.fillText('×1000 FT/MIN', R * 0.12, R * 0.4);
      this.needle(g, A(fpm), R * 0.88);
      g.restore();
    }
    // 6. Engine, fuel, flaps, clock
    {
      this.face(5);
      const A = (p) => -130 + p * 260;
      this.arc(g, A(0), A(1), R * 0.9, R * 0.06, '#3a3d42');
      this.arc(g, A(0), A(s.power), R * 0.9, R * 0.06, s.power > 0.92 ? AMBER : GREEN);
      this.tick(g, A(s.throttle), R * 0.78, R * 0.99, 3, '#f4f0e4');
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = CREAM; g.font = `600 ${R * 0.26}px ui-monospace, Menlo, Consolas, monospace`; g.fillText(Math.round(s.throttle * 100) + '%', 0, -R * 0.42);
      g.fillStyle = DIM; g.font = `${R * 0.115}px ui-sans-serif, system-ui, sans-serif`; g.fillText('POWER', 0, -R * 0.2);
      // fuel and flaps bars
      const bar = (y, frac, label, col) => {
        g.fillStyle = '#2a2c30'; g.fillRect(-R * 0.5, y, R, R * 0.09);
        g.fillStyle = col; g.fillRect(-R * 0.5, y, R * frac, R * 0.09);
        g.fillStyle = DIM; g.font = `${R * 0.11}px ui-sans-serif, system-ui, sans-serif`; g.textAlign = 'right'; g.fillText(label, -R * 0.54, y + R * 0.05); g.textAlign = 'center';
      };
      bar(-R * 0.04, s.fuel, 'F', s.fuel < 0.15 ? RED : CREAM);
      bar(R * 0.13, s.flap, 'FL', '#7fb7e6');
      g.fillStyle = CREAM; g.font = `600 ${R * 0.2}px ui-monospace, Menlo, Consolas, monospace`;
      const t = Math.max(0, s.elapsed), hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
      g.fillText(`${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, 0, R * 0.46);
      g.fillStyle = DIM; g.font = `${R * 0.11}px ui-sans-serif, system-ui, sans-serif`; g.fillText('ELAPSED', 0, R * 0.66);
      g.restore();
    }
  }
}
