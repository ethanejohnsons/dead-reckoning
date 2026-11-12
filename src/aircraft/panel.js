// The instrument panel: the plate with its placards, radios and switches, and the instruments a pilot
// flies by when the weather takes the ground away: airspeed, attitude, altimeter (pointer and drum),
// turn coordinator, heading indicator, vertical speed, tachometer, a clock with a sweep second hand and
// an elapsed-time counter, and the magnetic compass on the glareshield.
//
// Faces are drawn large into one atlas (512 px a dial, mip-mapped, sampled with a sharpening bias);
// pointers, cards, drums and symbols are geometry over them, so they stay crisp at any zoom.
// Lighting: by day the faces take the cabin's light; as it gets dark the dials light from within and
// post lights pool on the plate, held under the level that would bloom.

import * as THREE from 'three';
import { D2R, canvas, prim, merge, rod, speckle, lerp, FONT } from './kit.js';
import { cabinMat, flatAO, bakeAO, shared } from './cabinkit.js';
import { REGION } from '../world/geo.js';

const KT = 1.94384, FT = 3.28084;
export const PANEL_Z = -0.70;

/** Where things sit on the panel of a variant (metres, aircraft coordinates; the plate faces aft at z = PANEL_Z). */
export function panelLayout(A) {
  const sx = A.sx, xP = -0.27 * sx, d = 0.123, R = 0.054, yT = 0.231, yB = 0.108, xC = xP + d + R + 0.05;
  return {
    sx, xP, R, w: 0.96 * sx, y0: -0.16, y1: 0.32,
    gauges: {
      asi: [xP - d, yT, R], att: [xP, yT, R], alt: [xP + d, yT, R], tc: [xP - d, yB, R], hdg: [xP, yB, R], vsi: [xP + d, yB, R],
      tach: [xC, yB - 0.004, 0.038], clock: [xC, yT + 0.018, 0.034],
    },
    timer: [xC, 0.183],                                   // elapsed-time display between the clock and the tachometer
    stack: [xC + 0.054, xC + 0.054 + 0.165],              // avionics stack, left and right edge
    yokeY: -0.035, throttle: [0.05 * sx + 0.01, -0.085], mixture: [0.05 * sx + 0.07, -0.085],
    switches: [xP - 0.11, 0.012, 0.026],                  // first rocker, row height, pitch
    flap: [0.17 * sx + 0.01, -0.04],
    compass: [0.02, 0.398, PANEL_Z + 0.03],
  };
}

const ATLAS = { asi: [0, 0], att: [1, 0], alt: [2, 0], tach: [3, 0], tc: [0, 1], hdg: [1, 1], vsi: [2, 1], clock: [3, 1] };
const CELL = 512, FACE = 0.46;                             // a dial's radius is this share of its atlas cell

const asiK = (v) => 316 / (v.speeds.asiMax - 20);
const asiAngle = (kt, v) => (22 + (Math.max(20, Math.min(v.speeds.asiMax, kt)) - 20) * asiK(v)) * D2R;      // clockwise from the top
const vsiAngle = (fpm) => (270 + (Math.max(-2000, Math.min(2000, fpm)) / 2000) * 172) * D2R;
const tachAngle = (rpm) => (-135 + (Math.max(0, Math.min(3500, rpm)) / 3500) * 270) * D2R;

const INK = '#f4f2e8';

/** Dial faces for one variant: eight 512 px cells. */
function dialAtlas(v) {
  const [c, g] = canvas(CELL * 4, CELL * 2, '#050506');
  const pol = (a, r) => [Math.sin(a) * r, -Math.cos(a) * r];
  const disc = (r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill(); };
  const tick = (a, r0, r1, w = 5, col = INK) => { const p = pol(a, r0), q = pol(a, r1); g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'butt'; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
  const label = (a, r, str, px, col = INK, weight = 700) => { const p = pol(a, r); g.fillStyle = col; g.font = `${weight} ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, p[0], p[1] + px * 0.04); };
  const word = (x, y, str, px, col = '#c9c7bd', weight = 600) => { g.fillStyle = col; g.font = `${weight} ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, x, y); };
  const arc = (a0, a1, r, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'butt'; g.beginPath(); g.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2); g.stroke(); };
  const face = (name, draw) => {
    const [cx, cy] = ATLAS[name], R = CELL * FACE;
    g.save(); g.beginPath(); g.rect(cx * CELL, cy * CELL, CELL, CELL); g.clip();
    g.translate((cx + 0.5) * CELL, (cy + 0.5) * CELL);
    disc(CELL, '#0b0b0c'); disc(R * 1.0, '#050506');
    draw(R); g.restore();
  };
  const sp = v.speeds, aA = (kt) => asiAngle(kt, v);

  face('asi', (R) => {
    arc(aA(sp.vs0), aA(sp.vfe), R * 0.79, R * 0.07, '#f0eee4');
    arc(aA(sp.vs1), aA(sp.vno), R * 0.88, R * 0.09, '#2fa84f');
    arc(aA(sp.vno), aA(sp.vne), R * 0.88, R * 0.09, '#e3bd2c');
    tick(aA(sp.vne), R * 0.72, R * 0.97, 10, '#e03426');
    for (let k = 30; k <= sp.asiMax; k += 5) tick(aA(k), R * (k % 10 ? 0.85 : 0.78), R * 0.94, k % 10 ? 3.5 : 6);
    for (let k = 40; k <= sp.asiMax - 10; k += 20) label(aA(k), R * 0.58, String(k), R * 0.23);
    word(0, -R * 0.26, 'AIRSPEED', R * 0.105); word(0, R * 0.3, 'KNOTS', R * 0.115);
  });
  face('att', (R) => {                                      // bank scale round the moving ball
    for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) tick(d * D2R, R * 0.82, R * (d % 30 ? 0.91 : 0.99), d % 30 ? 5 : 9);
    for (const d of [-90, 90]) tick(d * D2R, R * 0.82, R * 0.99, 9);
    g.fillStyle = INK; g.beginPath(); g.moveTo(0, -R * 0.82); g.lineTo(-R * 0.075, -R * 0.99); g.lineTo(R * 0.075, -R * 0.99); g.fill();
  });
  face('alt', (R) => {
    for (let k = 0; k < 50; k++) tick((k / 50) * 2 * Math.PI, R * (k % 5 ? 0.86 : 0.78), R * 0.95, k % 5 ? 3.5 : 6.5);
    for (let k = 0; k < 10; k++) label((k / 10) * 2 * Math.PI, R * 0.62, String(k), R * 0.25);
    word(0, -R * 0.36, 'ALT', R * 0.1);
    // window for the altitude drum, and the pressure setting
    g.fillStyle = '#000'; g.strokeStyle = '#6c6d70'; g.lineWidth = 3;
    g.beginPath(); g.roundRect(-R * 0.5, R * 0.045, R * 0.98, R * 0.34, R * 0.03); g.fill(); g.stroke();
    g.fillStyle = INK; g.font = `700 ${R * 0.2}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('00', R * 0.35, R * 0.225);
    word(0, -R * 0.2, 'FEET', R * 0.09, '#c9c7bd');
  });
  face('tc', (R) => {
    for (const d of [-90, 90]) { tick(d * D2R, R * 0.78, R * 0.97, 10); tick((d + (d > 0 ? 20 : -20)) * D2R, R * 0.78, R * 0.97, 10); }
    word(-R * 0.68, R * 0.42, 'L', R * 0.19, INK, 700); word(R * 0.68, R * 0.42, 'R', R * 0.19, INK, 700);
    word(0, -R * 0.62, 'TURN COORDINATOR', R * 0.085); word(0, R * 0.86, '2 MIN', R * 0.1);
    g.fillStyle = '#d6d2bf'; g.beginPath(); g.roundRect(-R * 0.52, R * 0.4, R * 1.04, R * 0.27, R * 0.135); g.fill();
    g.fillStyle = '#0a0a0b'; g.fillRect(-R * 0.165, R * 0.4, R * 0.035, R * 0.27); g.fillRect(R * 0.13, R * 0.4, R * 0.035, R * 0.27);
  });
  face('hdg', (R) => {                                      // lubber marks round the rotating card
    for (let d = 45; d < 360; d += 45) tick(d * D2R, R * 0.91, R * 1.0, 8);
    g.fillStyle = '#ff9a1f'; g.beginPath(); g.moveTo(0, -R * 0.86); g.lineTo(-R * 0.09, -R * 1.0); g.lineTo(R * 0.09, -R * 1.0); g.fill();
  });
  face('vsi', (R) => {
    for (let f = -2000; f <= 2000; f += 100) tick(vsiAngle(f), R * (f % 500 ? 0.86 : 0.78), R * 0.95, f % 500 ? 3.5 : 6.5);
    for (const f of [500, 1000, 1500]) { label(vsiAngle(f), R * 0.6, String(f / 100), R * 0.23); label(vsiAngle(-f), R * 0.6, String(f / 100), R * 0.23); }
    label(vsiAngle(0), R * 0.6, '0', R * 0.25); label(Math.PI / 2, R * 0.6, '20', R * 0.23);
    word(R * 0.14, -R * 0.17, 'VERTICAL SPEED', R * 0.08); word(R * 0.14, R * 0.19, '100 FT PER MIN', R * 0.08);
    word(-R * 0.3, -R * 0.33, 'UP', R * 0.12, INK); word(-R * 0.3, R * 0.35, 'DN', R * 0.12, INK);
  });
  face('tach', (R) => {
    arc(tachAngle(sp.rpmGreen[0]), tachAngle(sp.rpmGreen[1]), R * 0.88, R * 0.09, '#2fa84f'); tick(tachAngle(sp.rpmRed), R * 0.7, R * 0.97, 10, '#e03426');
    for (let r = 0; r <= 3500; r += 100) tick(tachAngle(r), R * (r % 500 ? 0.86 : 0.76), R * 0.94, r % 500 ? 3.5 : 6.5);
    for (let r = 0; r <= 3500; r += 500) label(tachAngle(r), R * 0.56, String(r / 100), R * 0.24);
    word(0, -R * 0.24, 'RPM', R * 0.15, INK, 700); word(0, R * 0.32, 'X 100', R * 0.12);
  });
  face('clock', (R) => {
    for (let k = 0; k < 60; k++) tick((k / 60) * 2 * Math.PI, R * (k % 5 ? 0.88 : 0.78), R * 0.96, k % 5 ? 3.5 : 8);
    for (let k = 1; k <= 12; k++) label((k / 12) * 2 * Math.PI, R * 0.58, String(k), R * (k % 3 ? 0.2 : 0.27));
  });
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Attitude ball: sky over earth with a pitch ladder, 80 degrees of pitch from edge to edge. */
function attitudeTexture() {
  const S = 1024, [c, g] = canvas(S, S), k = S / 80;
  const sky = g.createLinearGradient(0, 0, 0, S / 2); sky.addColorStop(0, '#1b5fb4'); sky.addColorStop(1, '#3d8fe0');
  g.fillStyle = sky; g.fillRect(0, 0, S, S / 2);
  const gnd = g.createLinearGradient(0, S / 2, 0, S); gnd.addColorStop(0, '#8a5524'); gnd.addColorStop(1, '#5c3716');
  g.fillStyle = gnd; g.fillRect(0, S / 2, S, S / 2);
  g.strokeStyle = INK; g.lineWidth = 9; g.beginPath(); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
  g.fillStyle = INK; g.font = `700 44px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = -35; d <= 35; d += 5) {
    if (!d) continue;
    const y = S / 2 - d * k, w = d % 10 ? 42 : 92;
    g.lineWidth = 7; g.beginPath(); g.moveTo(S / 2 - w, y); g.lineTo(S / 2 + w, y); g.stroke();
    if (d % 10 === 0) { g.fillText(String(Math.abs(d)), S / 2 - w - 46, y + 2); g.fillText(String(Math.abs(d)), S / 2 + w + 46, y + 2); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  t.center.set(0.5, 0.5); t.repeat.set(0.5, 0.5);
  return t;
}

/** Compass rose for the heading indicator, north up. */
function headingTexture() {
  const S = 768, [c, g] = canvas(S, S), R = S / 2;
  g.translate(R, R);
  g.fillStyle = '#060607'; g.beginPath(); g.arc(0, 0, R - 1, 0, 7); g.fill();
  for (let d = 0; d < 360; d += 5) {
    g.save(); g.rotate(d * D2R);
    g.strokeStyle = INK; g.lineWidth = d % 10 ? 5 : 8; g.beginPath(); g.moveTo(0, -R + 8); g.lineTo(0, -R + (d % 10 ? 40 : 66)); g.stroke();
    if (d % 30 === 0) { g.fillStyle = d % 90 ? INK : '#ffffff'; g.font = `700 ${d % 90 ? 84 : 104}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(d % 90 ? String(d / 10) : 'NESW'[d / 90], 0, -R + 124); }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return t;
}

/** Card for the magnetic compass: one turn of headings round a drum. */
function compassTexture() {
  const W = 2048, H = 128, [c, g] = canvas(W, H, '#08080a');
  g.fillStyle = INK; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    // headings run right to left, as on the real card: at north, 33 is to the right and 3 to the left
    for (const x of [W - (d / 360) * W, -(d / 360) * W]) {
      const h = d % 30 === 0 ? 40 : d % 10 === 0 ? 30 : 18;
      g.fillRect(x - (d % 10 ? 2 : 3.5), H - h, d % 10 ? 4 : 7, h);
      if (d % 30 === 0) { g.font = `700 ${d % 90 ? 62 : 72}px ${FONT}`; g.fillText(d % 90 ? String(d / 10) : 'NESW'[d / 90], x, 46); }
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.anisotropy = 16;
  return t;
}

/** A column of digits 0-9 and 0 again, for drums and counters that roll. */
function digitStrip(color, bg, font) {
  const W = 64, H = 96, [c, g] = canvas(W, H * 11, bg);
  g.fillStyle = color; g.font = `700 82px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let k = 0; k <= 10; k++) g.fillText(String(k % 10), W / 2, H * (k + 0.5) + 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
/** A row of rolling digits: n quads, each showing a window one digit tall on the strip. */
function digitRow(n, w, h, gap, material) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < n; i++) {
    const x0 = i * (w + gap) - (n * (w + gap) - gap) / 2, b = i * 4;
    pos.push(x0, -h / 2, 0, x0 + w, -h / 2, 0, x0 + w, h / 2, 0, x0, h / 2, 0); uv.push(0, 0, 1, 0, 1, 1, 0, 1); idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(n * 12).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, material);
  /** Show digit value d (0..10, fractions roll) in place i. */
  m.userData.set = (i, d) => { const a = g.attributes.uv, top = 1 - d / 11, bot = top - 1 / 11; a.setY(i * 4, bot); a.setY(i * 4 + 1, bot); a.setY(i * 4 + 2, top); a.setY(i * 4 + 3, top); a.needsUpdate = true; };
  return m;
}
/** Odometer digits of a value: place k (0 = units) turns over only as the place below it passes 9. */
function odometer(value, places, out = []) {
  // each place sits square on its digit and turns over in the last fifth of the one below
  const f = value % 1; let roll = f < 0.8 ? 0 : (f - 0.8) * 5, v = Math.floor(value);
  roll = roll * roll * (3 - 2 * roll);
  for (let k = 0; k < places; k++) { const d = v % 10; out[k] = d + roll; roll = d === 9 ? roll : 0; v = Math.floor(v / 10); }
  return out;
}

/** A tapered pointer in the XY plane, pivot at the origin, pointing up; turn it with rotation.z. */
function needleGeo(len, w, tail = 0.2, tip = 0.3) {
  const g = new THREE.BufferGeometry(), t = -tail * len;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w, t, 0, w, t, 0, w * tip, len, 0, -w * tip, len, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Static artwork of the plate: radios, the right-hand gauges, placards, switch legends, screws. */
function plateTextures(A, L) {
  const v = A.variant, S = 2048 / L.w, W = 2048, H = Math.round((L.y1 - L.y0) * S);
  const [c, g] = canvas(W, H, A.look.interior.panel), [ec, ge] = canvas(W, H, '#000'), [hc, gh] = canvas(W / 2, H / 2, '#808080');
  const PX = (x) => (x + L.w / 2) * S, PY = (y) => (L.y1 - y) * S;
  speckle(g, W, H, 2400, 5);
  const pol = (a, r) => [Math.sin(a) * r, -Math.cos(a) * r];
  const disc = (r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill(); };
  const tick = (a, r0, r1, w = 2, col = '#eceae0') => { const p = pol(a, r0), q = pol(a, r1); g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
  const word = (x, y, str, px, col = '#d0cec4', weight = 600) => { g.fillStyle = col; g.font = `${weight} ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(str, PX(x), PY(y)); };
  const arc = (a0, a1, r, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, a0 - Math.PI / 2, a1 - Math.PI / 2); g.stroke(); };
  const screw = (x, y, r = 0.0035) => {
    g.save(); g.translate(PX(x), PY(y)); disc(r * S, '#4d4f54'); disc(r * S * 0.75, '#75777c'); g.rotate(x * 91 + y * 57); g.fillStyle = '#1b1c1e'; g.fillRect(-r * S * 0.7, -1.2, r * S * 1.4, 2.4); g.fillRect(-1.2, -r * S * 0.7, 2.4, r * S * 1.4); g.restore();
    gh.fillStyle = '#b8b8b8'; gh.beginPath(); gh.arc(PX(x) / 2, PY(y) / 2, r * S / 2, 0, 7); gh.fill(); gh.fillStyle = '#585858'; gh.fillRect(PX(x) / 2 - r * S * 0.35, PY(y) / 2 - 0.8, r * S * 0.7, 1.6);
  };
  const placard = (x, y, w, h, lines, px, bg = '#17181a', fg = '#e4e2d8') => {
    g.fillStyle = bg; g.fillRect(PX(x - w / 2), PY(y + h / 2), w * S, h * S); g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1.5; g.strokeRect(PX(x - w / 2), PY(y + h / 2), w * S, h * S);
    gh.fillStyle = '#8e8e8e'; gh.fillRect(PX(x - w / 2) / 2, PY(y + h / 2) / 2, w * S / 2, h * S / 2);
    lines.forEach((s, i) => word(x, y + ((lines.length - 1) / 2 - i) * px * 1.25 / S, s, px, fg));
  };
  const section = (x0, y1, x1, y0) => { g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 3; g.strokeRect(PX(x0), PY(y1), (x1 - x0) * S, (y1 - y0) * S); gh.strokeStyle = '#4a4a4a'; gh.lineWidth = 2; gh.strokeRect(PX(x0) / 2, PY(y1) / 2, (x1 - x0) * S / 2, (y1 - y0) * S / 2); };

  // the flight-instrument sub-panel, shock mounted, and a recess with four screws behind every dial
  const G = L.gauges, R = L.R;
  section(G.asi[0] - R - 0.02, G.asi[1] + R + 0.016, G.alt[0] + R + 0.014, G.tc[1] - R - 0.016);
  for (const k of Object.keys(G)) {
    const [x, y, r] = G[k];
    g.save(); g.translate(PX(x), PY(y)); disc(r * 1.2 * S, '#0d0d0e'); g.restore();
    if (k !== 'clock' && k !== 'tach') for (const q of [0, 1, 2, 3]) { const p = pol(Math.PI / 4 + q * Math.PI / 2, r * 1.27); screw(x + p[0], y - p[1], 0.0032); }
  }
  for (const [x, y] of [[G.asi[0] - R - 0.012, G.asi[1] + R + 0.008], [G.alt[0] + R + 0.006, G.asi[1] + R + 0.008], [G.asi[0] - R - 0.012, G.tc[1] - R - 0.008], [G.alt[0] + R + 0.006, G.tc[1] - R - 0.008]]) screw(x, y);

  // displays glow, so they are drawn on the emissive layer too
  const lit = (x, y, w, h, draw) => { for (const ctx of [g, ge]) { ctx.save(); ctx.translate(PX(x), PY(y)); draw(ctx, w * S, h * S); ctx.restore(); } };
  // elapsed-time counter: a dark window (its digits are live geometry) with the legend beside it
  { const [tx, ty] = L.timer; g.fillStyle = '#0a0a0b'; g.fillRect(PX(tx - 0.041), PY(ty + 0.017), 0.082 * S, 0.034 * S); g.strokeStyle = '#4a4c50'; g.lineWidth = 2; g.strokeRect(PX(tx - 0.041), PY(ty + 0.017), 0.082 * S, 0.034 * S);
    lit(tx - 0.036, ty + 0.0125, 0.072, 0.025, (ctx, pw, ph) => { ctx.fillStyle = '#060a08'; ctx.fillRect(0, 0, pw, ph); ctx.fillStyle = '#ffb030'; ctx.beginPath(); ctx.arc(pw * 0.5, ph * 0.33, ph * 0.07, 0, 7); ctx.arc(pw * 0.5, ph * 0.67, ph * 0.07, 0, 7); ctx.fill(); });
    word(tx, ty - 0.0225, 'FLIGHT TIME  MIN : SEC', 12); }

  // avionics stack
  const [sx0, sx1] = L.stack, sw = sx1 - sx0;
  const unit = (y, h, draw) => { g.fillStyle = '#0c0c0d'; g.fillRect(PX(sx0), PY(y), sw * S, h * S); g.strokeStyle = '#3a3c40'; g.lineWidth = 1.5; g.strokeRect(PX(sx0), PY(y), sw * S, h * S); gh.strokeStyle = '#5a5a5a'; gh.lineWidth = 1.5; gh.strokeRect(PX(sx0) / 2, PY(y) / 2, sw * S / 2, h * S / 2); draw(); };
  const knob = (x, y, r) => { g.save(); g.translate(PX(x), PY(y)); disc(r * S, '#1c1c1e'); disc(r * S * 0.72, '#2c2d30'); g.restore(); };
  const lcd = (x, y, w, h, str, col, px) => lit(x, y, w, h, (ctx, pw, ph) => { ctx.fillStyle = '#04090a'; ctx.fillRect(0, 0, pw, ph); ctx.fillStyle = col; ctx.font = `600 ${px}px ui-monospace, Menlo, Consolas, monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(str, pw * 0.05, ph * 0.56); });
  section(sx0 - 0.004, 0.3, sx1 + 0.004, 0.022);
  unit(0.296, 0.03, () => { for (let k = 0; k < 9; k++) { g.fillStyle = k % 3 ? '#1d1e20' : '#3c3d40'; g.fillRect(PX(sx0 + 0.01 + k * 0.0165), PY(0.288), 0.011 * S, 0.014 * S); } });
  unit(0.264, 0.082, () => {
    lit(sx0 + 0.016, 0.256, 0.104, 0.066, (ctx, pw, ph) => {
      ctx.fillStyle = '#061a22'; ctx.fillRect(0, 0, pw, ph);
      ctx.fillStyle = '#12303a'; ctx.beginPath(); ctx.moveTo(0, ph * 0.7); ctx.quadraticCurveTo(pw * 0.3, ph * 0.3, pw * 0.55, ph * 0.62); ctx.quadraticCurveTo(pw * 0.8, ph * 0.9, pw, ph * 0.5); ctx.lineTo(pw, ph); ctx.lineTo(0, ph); ctx.fill();
      ctx.strokeStyle = '#d04fc0'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(pw * 0.12, ph * 0.86); ctx.lineTo(pw * 0.5, ph * 0.5); ctx.lineTo(pw * 0.9, ph * 0.2); ctx.stroke();
      ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.moveTo(pw * 0.5, ph * 0.42); ctx.lineTo(pw * 0.46, ph * 0.58); ctx.lineTo(pw * 0.54, ph * 0.58); ctx.fill();
      ctx.fillStyle = '#58d6ea'; ctx.font = `600 ${ph * 0.14}px ui-monospace, Menlo, monospace`; ctx.textAlign = 'left'; ctx.fillText('DTK 214  12.4NM', pw * 0.04, ph * 0.13);
    });
    knob(sx0 + 0.144, 0.24, 0.011); knob(sx0 + 0.144, 0.204, 0.009);
  });
  unit(0.178, 0.044, () => { lcd(sx0 + 0.008, 0.17, 0.104, 0.028, '118.70  121.90', '#f0a030', 31); knob(sx0 + 0.144, 0.156, 0.01); });
  unit(0.13, 0.044, () => { lcd(sx0 + 0.008, 0.122, 0.104, 0.028, '113.90  109.30', '#f0a030', 31); knob(sx0 + 0.144, 0.108, 0.01); });
  unit(0.082, 0.04, () => { lcd(sx0 + 0.008, 0.075, 0.074, 0.026, '1200 ALT', '#f0a030', 31); for (let k = 0; k < 4; k++) { g.fillStyle = '#2c2d30'; g.fillRect(PX(sx0 + 0.09 + k * 0.018), PY(0.07), 0.013 * S, 0.016 * S); } });
  for (const y of [0.296, 0.264, 0.178, 0.13, 0.082]) { screw(sx0 + 0.004, y - 0.006, 0.0022); screw(sx1 - 0.004, y - 0.006, 0.0022); }

  // right-hand side: fixed engine and fuel gauges, a navigation head
  const fixed = (x, y, r, name, a, marks = 9) => {
    g.save(); g.translate(PX(x), PY(y)); const Rr = r * S;
    disc(Rr * 1.16, '#101011'); disc(Rr * 1.1, '#303236'); disc(Rr * 1.02, '#050506');
    for (let k = 0; k <= marks; k++) tick((-120 + (240 * k) / marks) * D2R, Rr * 0.78, Rr * 0.93, 2.4);
    arc(-60 * D2R, 40 * D2R, Rr * 0.88, Rr * 0.08, '#2e9a4a'); arc(40 * D2R, 120 * D2R, Rr * 0.88, Rr * 0.08, '#b9302a');
    g.fillStyle = '#d0cec4'; g.font = `700 ${Rr * 0.26}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, 0, Rr * 0.48);
    g.strokeStyle = '#f2f0e6'; g.lineWidth = 3.5; g.lineCap = 'round'; g.beginPath(); g.moveTo(0, 0); const p = pol(a * D2R, Rr * 0.76); g.lineTo(p[0], p[1]); g.stroke(); disc(Rr * 0.13, '#1a1a1c');
    g.restore();
    gh.fillStyle = '#9a9a9a'; gh.beginPath(); gh.arc(PX(x) / 2, PY(y) / 2, r * S * 0.58, 0, 7); gh.fill(); gh.fillStyle = '#707070'; gh.beginPath(); gh.arc(PX(x) / 2, PY(y) / 2, r * S * 0.5, 0, 7); gh.fill();
  };
  const xr = sx1 + 0.02, wr = L.w / 2 - 0.035 - xr;         // room right of the stack
  if (wr > 0.1) {
    const cols = wr > 0.19 ? 3 : 2, pitch = wr / cols, r = Math.min(0.028, pitch * 0.42), names = ['FUEL L', 'FUEL R', 'OIL T', 'OIL P', 'EGT', 'AMP', 'SUCT', 'CHT', 'CARB'];
    const ang = [48, 55, 4, 10, 26, -8, 12, -4, -30];
    section(xr - 0.006, 0.3, xr + wr + 0.004, 0.3 - 3 * (2 * r + 0.016) - 0.012);
    for (let j = 0; j < 3; j++) for (let i = 0; i < cols; i++) fixed(xr + pitch * (i + 0.5), 0.3 - 0.012 - r - j * (2 * r + 0.016), r, names[j * cols + i] || 'VAC', ang[j * cols + i] || 0, 6);
  }
  // annunciators above the six, switch legends below it
  for (let k = 0; k < 6; k++) { const x = L.xP - 0.09 + k * 0.036; g.fillStyle = ['#3a1512', '#3a2c0c', '#12301a'][k % 3]; g.fillRect(PX(x - 0.015), PY(0.308), 0.03 * S, 0.012 * S); word(x, 0.302, ['OIL', 'VOLTS', 'VAC', 'FUEL', 'PITOT', 'DOOR'][k], 11, 'rgba(255,255,255,0.35)'); }
  const [swx, swy, swp] = L.switches, names = ['MASTER', 'AVN', 'BCN', 'NAV', 'STROBE', 'LAND', 'TAXI', 'PITOT', 'PUMP'];
  names.forEach((nm, k) => { word(swx + k * swp, swy + 0.027, nm, 13); g.fillStyle = '#08080a'; g.fillRect(PX(swx + k * swp - 0.0095), PY(swy + 0.019), 0.019 * S, 0.038 * S); });
  word(swx - 0.05, swy + 0.03, 'OFF R L BOTH START', 9); word(swx - 0.05, swy - 0.03, 'MAGNETOS', 12);
  // engine controls, flaps, breakers
  word(L.throttle[0], L.throttle[1] - 0.036, 'THROTTLE', 13); word(L.mixture[0], L.mixture[1] - 0.036, 'MIXTURE', 13);
  word(L.mixture[0] + 0.02, L.mixture[1] + 0.03, 'PULL LEAN', 10);
  for (const p of [L.throttle, L.mixture]) { g.save(); g.translate(PX(p[0]), PY(p[1])); disc(0.018 * S, '#3a3c40'); disc(0.012 * S, '#101011'); g.restore(); }
  for (const x of [L.xP, -L.xP]) { g.save(); g.translate(PX(x), PY(L.yokeY)); disc(0.026 * S, '#2c2d30'); disc(0.018 * S, '#0a0a0b'); g.restore(); }
  { const [fx, fy] = L.flap; g.fillStyle = '#060607'; g.fillRect(PX(fx - 0.006), PY(fy + 0.01), 0.012 * S, 0.1 * S); for (const [k, str] of [[0, 'UP'], [1, '10°'], [2, '20°'], [3, 'FULL']]) { word(fx + 0.032, fy - k * 0.027, str, 14); g.fillStyle = '#d0cec4'; g.fillRect(PX(fx + 0.008), PY(fy - k * 0.027) - 1.5, 0.008 * S, 3); } word(fx + 0.012, fy + 0.024, 'WING FLAPS', 13); }
  { const x0 = L.flap[0] + 0.065, n = Math.max(3, Math.floor((L.w / 2 - 0.04 - x0) / 0.022)); for (let j = 0; j < 2; j++) for (let k = 0; k < n; k++) { g.save(); g.translate(PX(x0 + k * 0.022), PY(-0.1 - j * 0.032)); disc(0.0085 * S, '#0c0c0d'); disc(0.0062 * S, '#1f2023'); g.fillStyle = '#b9b7ae'; g.font = `600 9px ${FONT}`; g.textAlign = 'center'; g.fillText(String([5, 10, 15, 5, 10, 60, 5, 10, 15, 5, 5][(k + j * 3) % 11]), 0, 3); g.restore(); } word(x0 + (n - 1) * 0.011, -0.08, 'CIRCUIT BREAKERS', 12); }
  // placards
  placard(L.w / 2 - 0.1, 0.306, 0.11, 0.019, [v.reg], 30, '#d8d6cc', '#17181a');
  placard(L.xP + 0.185, 0.012, 0.118, 0.024, ['MANEUVERING SPEED ' + Math.round(v.speeds.vs1 * 1.95) + ' KIAS', 'NO ACROBATIC MANEUVERS APPROVED'], 9.5);
  placard(L.xP - 0.12, -0.085, 0.085, 0.03, ['ALT STATIC AIR', 'PULL ON'], 11);
  placard(-L.xP, 0.0, 0.16, 0.026, ['THIS AIRPLANE MUST BE OPERATED AS A NORMAL OR UTILITY', 'CATEGORY AIRPLANE IN COMPLIANCE WITH THE OPERATING LIMITATIONS'], 7.5);
  placard(L.xP + 0.19, -0.13, 0.07, 0.022, ['PARKING BRAKE', 'PULL ON'], 10);
  placard(L.throttle[0] + 0.03, -0.14, 0.09, 0.018, ['FUEL 100LL  ' + Math.round(v.spec.fuelCap / 0.72 / 3.785) + ' US GAL'], 10);
  for (let x = -L.w / 2 + 0.05; x < L.w / 2 - 0.03; x += 0.11) { screw(x, -0.148); screw(x + 0.05, 0.312, 0.0028); }

  // scuffs and finger wear round the things that get handled
  g.save(); g.filter = 'blur(6px)'; g.globalCompositeOperation = 'lighter';
  for (const [x, y, r] of [[L.throttle[0], L.throttle[1], 0.045], [L.mixture[0], L.mixture[1], 0.035], [swx + 4 * swp, swy, 0.1], [L.flap[0], L.flap[1] - 0.04, 0.04], [swx - 0.05, swy, 0.03]]) { const gr = g.createRadialGradient(PX(x), PY(y), 0, PX(x), PY(y), r * S); gr.addColorStop(0, 'rgba(120,118,110,0.11)'); gr.addColorStop(1, 'rgba(120,118,110,0)'); g.fillStyle = gr; g.fillRect(PX(x - r), PY(y + r), 2 * r * S, 2 * r * S); }
  g.restore();
  const rnd = speckle(g, W, H, 0, 9);
  g.strokeStyle = 'rgba(190,188,180,0.07)'; g.lineWidth = 1;
  for (let i = 0; i < 90; i++) { const x = rnd() * W, y = rnd() * H, a = rnd() * 7, l = 6 + rnd() * 40; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }

  // night layer: post lights pooling on the plate round each dial and along the switches, displays at full strength
  const [fc, gf] = canvas(W / 2, H / 2, '#000');
  gf.drawImage(c, 0, 0, W / 2, H / 2);
  const [pc, gp] = canvas(W / 2, H / 2, '#161616');
  const pool = (x, y, r, a) => { const gr = gp.createRadialGradient(PX(x) / 2, PY(y) / 2, 0, PX(x) / 2, PY(y) / 2, r * S / 2); gr.addColorStop(0, `rgba(255,236,205,${a})`); gr.addColorStop(1, 'rgba(255,236,205,0)'); gp.fillStyle = gr; gp.fillRect(0, 0, W / 2, H / 2); };
  for (const k of Object.keys(G)) pool(G[k][0], G[k][1] + G[k][2] * 0.9, G[k][2] * 2.6, 0.75);
  for (let k = 0; k < 9; k += 2) pool(swx + k * swp, swy + 0.02, 0.06, 0.5);
  pool(L.throttle[0] + 0.03, L.throttle[1], 0.09, 0.5); pool(L.flap[0] + 0.02, L.flap[1] - 0.03, 0.08, 0.45); pool((sx0 + sx1) / 2, 0.16, 0.16, 0.3);
  gf.globalCompositeOperation = 'multiply'; gf.drawImage(pc, 0, 0);
  gf.globalCompositeOperation = 'lighten'; gf.drawImage(ec, 0, 0, W / 2, H / 2);
  const mk = (cv, srgb = true) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 16; return t; };
  // height to normal (clamped edges)
  const hw = W / 2, hh = H / 2, src = gh.getImageData(0, 0, hw, hh).data, [nc, gn] = canvas(hw, hh), ni = gn.createImageData(hw, hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const o = (y * hw + x) * 4, dx = (src[(y * hw + Math.min(x + 1, hw - 1)) * 4] - src[(y * hw + Math.max(x - 1, 0)) * 4]) / 255, dy = (src[(Math.min(y + 1, hh - 1) * hw + x) * 4] - src[(Math.max(y - 1, 0) * hw + x) * 4]) / 255;
    const nx = -dx * 2.5, ny = dy * 2.5, l = 1 / Math.hypot(nx, ny, 1);
    ni.data[o] = (nx * l * 0.5 + 0.5) * 255; ni.data[o + 1] = (ny * l * 0.5 + 0.5) * 255; ni.data[o + 2] = (l * 0.5 + 0.5) * 255; ni.data[o + 3] = 255;
  }
  gn.putImageData(ni, 0, 0);
  return { map: mk(c), emissive: mk(fc), normal: mk(nc, false) };
}

/** Sample a texture one mip level sharper than the GPU would choose: small numerals keep their edges. */
function sharpen(mat, bias = -0.7) {
  mat.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#ifdef USE_MAP\n vec4 sampledDiffuseColor = texture2D( map, vMapUv, ${bias.toFixed(2)} );\n diffuseColor *= sampledDiffuseColor;\n#endif`).replace('#include <emissivemap_fragment>', `#ifdef USE_EMISSIVEMAP\n totalEmissiveRadiance *= texture2D( emissiveMap, vEmissiveMapUv, ${bias.toFixed(2)} ).rgb;\n#endif`); };
  mat.customProgramCacheKey = () => 'sharp' + bias;
  return mat;
}

/**
 * Build the panel into the aircraft. Returns { parts } with parts.ins (the live instruments) and what animatePanel moves.
 * The plate, bezels and compass body are drawn in every view; faces, pointers and switches only from the cockpit.
 */
export function buildPanel(A, { cabin, pit }) {
  const v = A.variant, L = panelLayout(A), pz = PANEL_Z, parts = { layout: L };
  const warm = new THREE.Color(1, 0.84, 0.66), PLATE = [0.02, 0.02, 0.022];
  const boxes = [[0, 0.34, -0.83, 0.6, 0.02, 0.19]];         // the glareshield above shades the top of the plate
  const room = (x, y) => lerp(0.5, 0.95, Math.max(0, Math.min(1, (0.33 - y) / 0.2)));

  // ---- plate, cut to the inside of the hull
  const pt = plateTextures(A, L);
  const ys = [-0.15, -0.08, 0.0, 0.08, 0.16, 0.24, 0.312], edge = ys.map((y) => [Math.min(0.5 * A.sx, A.hullX(pz, y) - 0.034), y]);
  const shape = new THREE.Shape([...edge, ...edge.slice().reverse().map(([x, y]) => [-x, y])].map(([x, y]) => new THREE.Vector2(x, y)));
  const plateGeo = new THREE.ShapeGeometry(shape);
  { const p = plateGeo.attributes.position, uv = plateGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + L.w / 2) / L.w, (p.getY(i) - L.y0) / (L.y1 - L.y0)); }
  plateGeo.translate(0, 0, pz);
  plateGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(plateGeo.attributes.position.count * 3).fill(1), 3));
  const matPlate = cabinMat({ map: pt.map, normalMap: pt.normal, normalScale: new THREE.Vector2(0.8, 0.8), emissiveMap: pt.emissive, emissive: warm.clone(), emissiveIntensity: 0, roughness: 0.66, metalness: 0.1, envMapIntensity: 0.2 });
  const plate = new THREE.Mesh(bakeAO(plateGeo, boxes, room), matPlate); plate.receiveShadow = true; cabin.add(plate);
  parts.panelFace = plate;

  // ---- bezels (and the back of the panel), in every view
  const G = L.gauges, fixed = [];
  const bezel = (x, y, r) => {
    const prof = [[r * 0.985, 0.0005], [r * 1.0, 0.0045], [r * 1.05, 0.0058], [r * 1.12, 0.005], [r * 1.16, 0.0005]].map(([a, b]) => new THREE.Vector2(a, b));
    const g = prim(new THREE.LatheGeometry(prof, 40), { rot: [Math.PI / 2, 0, 0], pos: [x, y, pz], rgb: [0.022, 0.022, 0.024] });
    g.scale(1, 1, 1); return g;
  };
  for (const k of Object.keys(G)) fixed.push(bezel(...G[k]));
  { const back = prim(new THREE.ShapeGeometry(shape), { pos: [0, 0, pz - 0.05], rot: [0, Math.PI, 0], rgb: PLATE }); fixed.push(back); }
  // rocker switches, breakers, key switch, flap lever slot guard, mixture knob
  const [swx, swy, swp] = L.switches;
  for (let k = 0; k < 9; k++) fixed.push(prim(new THREE.BoxGeometry(0.015, 0.03, 0.01), { pos: [swx + k * swp, swy, pz + 0.004], rot: [k < 5 ? 0.25 : -0.25, 0, 0], rgb: k === 0 ? [0.5, 0.05, 0.04] : [0.75, 0.74, 0.7] }));
  fixed.push(prim(new THREE.CylinderGeometry(0.016, 0.018, 0.01, 24), { pos: [swx - 0.05, swy, pz + 0.005], rot: [Math.PI / 2, 0, 0], rgb: [0.3, 0.3, 0.32] }), prim(new THREE.BoxGeometry(0.004, 0.022, 0.02), { pos: [swx - 0.05, swy, pz + 0.018], rot: [0, 0, 0.6], rgb: [0.62, 0.6, 0.55] }));
  { const x0 = L.flap[0] + 0.065, n = Math.max(3, Math.floor((L.w / 2 - 0.04 - x0) / 0.022)); for (let j = 0; j < 2; j++) for (let k = 0; k < n; k++) fixed.push(prim(new THREE.CylinderGeometry(0.0058, 0.0062, 0.008, 12), { pos: [x0 + k * 0.022, -0.1 - j * 0.032, pz + 0.004], rot: [Math.PI / 2, 0, 0], rgb: [0.03, 0.03, 0.032] })); }
  const plunger = (rgb, r = 0.019) => merge([rod([0, 0, -0.04], [0, 0, 0.1], 0.006, [0.6, 0.6, 0.6], 6), prim(new THREE.CylinderGeometry(r, r, 0.026, 20), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.115], rgb }), prim(new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, 1.2), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.122], scale: [1, 1, 0.5], rgb })]);
  { const mix = plunger([0.55, 0.04, 0.03], 0.017); mix.translate(L.mixture[0], L.mixture[1], pz - 0.05); fixed.push(mix); }
  parts.plunger = plunger;
  // nuts round the engine controls and the yoke bushings
  for (const p of [L.throttle, L.mixture]) fixed.push(prim(new THREE.CylinderGeometry(0.013, 0.013, 0.008, 6), { pos: [p[0], p[1], pz + 0.004], rot: [Math.PI / 2, 0, 0], rgb: [0.45, 0.45, 0.46] }));
  for (const x of [L.xP, -L.xP]) fixed.push(prim(new THREE.CylinderGeometry(0.022, 0.024, 0.014, 24), { pos: [x, L.yokeY, pz + 0.007], rot: [Math.PI / 2, 0, 0], rgb: [0.05, 0.05, 0.055] }));
  // magnetic compass on the glareshield: case, mounting foot, lubber line
  const [cx, cy, cz] = L.compass;
  fixed.push(prim(new THREE.BoxGeometry(0.112, 0.056, 0.07), { pos: [cx, cy, cz - 0.022], rgb: [0.014, 0.014, 0.016] }), prim(new THREE.BoxGeometry(0.05, 0.03, 0.05), { pos: [cx, cy - 0.04, cz - 0.02], rgb: [0.014, 0.014, 0.016] }));
  for (const sy of [-1, 1]) fixed.push(prim(new THREE.BoxGeometry(0.112, 0.01, 0.022), { pos: [cx, cy + sy * 0.024, cz + 0.018], rgb: [0.014, 0.014, 0.016] }));
  for (const s of [-1, 1]) fixed.push(prim(new THREE.BoxGeometry(0.008, 0.056, 0.022), { pos: [cx + s * 0.052, cy, cz + 0.018], rgb: [0.014, 0.014, 0.016] }));
  const fixedMesh = new THREE.Mesh(bakeAO(merge(fixed), boxes, room), cabinMat({ roughness: 0.5, envMapIntensity: 0.35 }));
  fixedMesh.castShadow = false; fixedMesh.receiveShadow = true; cabin.add(fixedMesh);

  // ---- faces: one mesh, eight discs on the atlas
  const atlas = dialAtlas(v), fz0 = pz + 0.0012;
  const faces = [];
  for (const k of Object.keys(G)) {
    const [x, y, r] = G[k], [cx0, cy0] = ATLAS[k], d = new THREE.CircleGeometry(r, 56), uv = d.attributes.uv, p = d.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (cx0 + 0.5 + (FACE * p.getX(i)) / r) / 4, 1 - (cy0 + 0.5 - (FACE * p.getY(i)) / r) / 2);
    d.translate(x, y, fz0); faces.push(d);
  }
  const matFace = sharpen(new THREE.MeshStandardMaterial({ map: atlas, emissiveMap: atlas, emissive: warm.clone(), emissiveIntensity: 0.05, roughness: 0.78, envMapIntensity: 0.08 }));
  const faceMesh = new THREE.Mesh(merge(faces), matFace); faceMesh.receiveShadow = true; pit.add(faceMesh);

  // ---- pointers, cards, drums
  const matNeedle = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.95, 0.95, 0.9), emissive: warm.clone(), emissiveIntensity: 0.04, roughness: 0.55, envMapIntensity: 0.1 });
  const matOrange = new THREE.MeshStandardMaterial({ color: new THREE.Color(1.0, 0.42, 0.03), emissive: new THREE.Color(1.0, 0.42, 0.03), emissiveIntensity: 0.06, roughness: 0.55, envMapIntensity: 0.1 });
  const matCard = (map) => sharpen(new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: warm.clone(), emissiveIntensity: 0.05, roughness: 0.75, envMapIntensity: 0.08 }), -0.5);
  const at3 = (name, dz) => { const p = G[name]; return [p[0], p[1], fz0 + dz]; };
  const put = (m, name, dz) => { m.position.set(...at3(name, dz)); pit.add(m); return m; };
  const R = L.R, ins = { v };
  ins.asi = put(new THREE.Mesh(needleGeo(R * 0.84, R * 0.055), matNeedle), 'asi', 0.003);
  ins.vsi = put(new THREE.Mesh(needleGeo(R * 0.84, R * 0.055), matNeedle), 'vsi', 0.003);
  ins.tach = put(new THREE.Mesh(needleGeo(G.tach[2] * 0.82, G.tach[2] * 0.06), matNeedle), 'tach', 0.003);
  ins.alt100 = put(new THREE.Mesh(needleGeo(R * 0.88, R * 0.05, 0.22, 0.25), matNeedle), 'alt', 0.0036);
  const ballTex = attitudeTexture(), cardTex = headingTexture();
  ins.att = put(new THREE.Mesh(new THREE.CircleGeometry(R * 0.8, 48), matCard(ballTex)), 'att', 0.0012); ins.attTex = ballTex;
  ins.hdg = put(new THREE.Mesh(new THREE.CircleGeometry(R * 0.89, 48), matCard(cardTex)), 'hdg', 0.0012);
  // bank pointer riding the ball's edge
  { const s = new THREE.Shape([new THREE.Vector2(0, R * 0.79), new THREE.Vector2(-R * 0.07, R * 0.66), new THREE.Vector2(R * 0.07, R * 0.66)]); ins.bank = put(new THREE.Mesh(new THREE.ShapeGeometry(s), matOrange), 'att', 0.0022); }
  // turn coordinator: a little aeroplane seen from behind, and the slip ball
  { const s = R; ins.turn = put(new THREE.Mesh(merge([prim(new THREE.PlaneGeometry(s * 1.5, s * 0.085)), prim(new THREE.CircleGeometry(s * 0.14, 20)), prim(new THREE.PlaneGeometry(s * 0.07, s * 0.3), { pos: [0, s * 0.16, 0] }), prim(new THREE.PlaneGeometry(s * 0.42, s * 0.06), { pos: [0, s * 0.28, 0] })]), matNeedle), 'tc', 0.003); }
  ins.ball = put(new THREE.Mesh(new THREE.CircleGeometry(R * 0.118, 20), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.3 })), 'tc', 0.003);
  ins.ballBase = ins.ball.position.clone(); ins.ball.position.y -= R * 0.535;
  // clock hands
  const cr = G.clock[2];
  ins.hour = put(new THREE.Mesh(needleGeo(cr * 0.5, cr * 0.075, 0.15, 0.5), matNeedle), 'clock', 0.0024);
  ins.minute = put(new THREE.Mesh(needleGeo(cr * 0.8, cr * 0.055, 0.15, 0.4), matNeedle), 'clock', 0.003);
  ins.second = put(new THREE.Mesh(needleGeo(cr * 0.9, cr * 0.03, 0.3, 0.4), matOrange), 'clock', 0.0036);
  // altitude drum: ten-thousands, thousands, hundreds
  const drumTex = shared('digits:drum', () => digitStrip('#f4f2e8', '#0a0a0b', FONT));
  const matDrum = sharpen(new THREE.MeshStandardMaterial({ map: drumTex, emissiveMap: drumTex, emissive: warm.clone(), emissiveIntensity: 0.05, roughness: 0.75, envMapIntensity: 0.08 }), -0.4);
  ins.drum = digitRow(3, R * 0.22, R * 0.3, R * 0.015, matDrum); ins.drum.position.set(G.alt[0] - R * 0.125, G.alt[1] - R * 0.215, fz0 + 0.001); pit.add(ins.drum);
  // elapsed time: minutes and seconds, lit from behind
  const lcdTex = shared('digits:lcd', () => digitStrip('#ffb030', '#060a08', 'ui-monospace, Menlo, Consolas, monospace'));
  const matLcd = new THREE.MeshBasicMaterial({ map: lcdTex });
  ins.timer = [digitRow(2, 0.013, 0.021, 0.002, matLcd), digitRow(2, 0.013, 0.021, 0.002, matLcd)];
  ins.timer[0].position.set(L.timer[0] - 0.018, L.timer[1], pz + 0.0015); ins.timer[1].position.set(L.timer[0] + 0.018, L.timer[1], pz + 0.0015);
  pit.add(ins.timer[0], ins.timer[1]);

  // fixed overlays: hub caps, the attitude and heading aeroplane symbols, the compass lubber line
  const HUB = [0.02, 0.02, 0.022], ov = [], hubs = [];
  const flat = (w, h, x, y, name, rot = 0) => { const p = at3(name, 0.0042); ov.push(prim(new THREE.PlaneGeometry(w, h), { pos: [p[0] + x, p[1] + y, p[2]], rot: [0, 0, rot] })); };
  flat(R * 0.4, R * 0.075, -R * 0.44, 0, 'att'); flat(R * 0.4, R * 0.075, R * 0.44, 0, 'att'); flat(R * 0.075, R * 0.16, -R * 0.275, -R * 0.045, 'att'); flat(R * 0.075, R * 0.16, R * 0.275, -R * 0.045, 'att'); flat(R * 0.1, R * 0.1, 0, 0, 'att', Math.PI / 4);
  flat(R * 0.055, R * 0.84, 0, -R * 0.03, 'hdg'); flat(R * 0.7, R * 0.08, 0, R * 0.1, 'hdg'); flat(R * 0.3, R * 0.06, 0, -R * 0.4, 'hdg');
  pit.add(new THREE.Mesh(merge(ov), matOrange));
  for (const n of ['asi', 'vsi', 'alt', 'tach', 'clock']) hubs.push(prim(new THREE.CircleGeometry(G[n][2] * 0.11, 20), { pos: at3(n, 0.0048), rgb: HUB }));
  hubs.push(prim(new THREE.BoxGeometry(0.0022, 0.04, 0.002), { pos: [cx, cy, cz + 0.031], rgb: [0.95, 0.95, 0.9] }));
  pit.add(new THREE.Mesh(flatAO(merge(hubs), 0.9), cabinMat({ roughness: 0.5 })));
  // compass card
  const compTex = compassTexture();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.04, 48, 1, true), new THREE.MeshStandardMaterial({ map: compTex, emissiveMap: compTex, emissive: warm.clone(), emissiveIntensity: 0.05, roughness: 0.7, envMapIntensity: 0.1 }));
  drum.position.set(cx, cy, cz - 0.02); pit.add(drum); ins.compass = drum;
  // flap lever
  parts.flapLever = new THREE.Mesh(flatAO(merge([prim(new THREE.BoxGeometry(0.03, 0.012, 0.012), { pos: [0, 0, 0.03], rgb: [0.85, 0.84, 0.8] }), rod([0, 0, 0], [0, 0, 0.026], 0.0035, [0.5, 0.5, 0.5], 5)]), 0.9), cabinMat({ roughness: 0.5 }));
  parts.flapLever.position.set(L.flap[0], L.flap[1], pz); pit.add(parts.flapLever);

  ins.lit = [matFace, matNeedle, ins.att.material, ins.hdg.material, matDrum, drum.material];       // light from within after dark
  ins.orange = matOrange; ins.lcd = matLcd; ins.plate = matPlate;
  ins.t0 = null; ins.et = 0; ins.wasDown = true;
  parts.ins = ins;
  return { parts };
}

/** Drive the instruments from the flight state. `n` is darkness, 0..1. */
export function animatePanel(parts, ac, dt, time, n) {
  const I = parts.ins, L = parts.layout, v = I.v, R = L.R;
  I.asi.rotation.z = -asiAngle(ac.ias * KT, v);
  const altFt = Math.max(0, ac.pos.y * FT);
  I.alt100.rotation.z = -((altFt % 1000) / 1000) * 2 * Math.PI;
  const od = odometer(altFt / 100, 3, I.od || (I.od = []));
  for (let k = 0; k < 3; k++) I.drum.userData.set(2 - k, od[k]);
  const k = dt > 0 ? 1 - Math.exp(-dt * 2.2) : 1;           // the vertical speed needle lags, as the real one does
  I.vsFpm = (I.vsFpm || 0) + (ac.vel.y * FT * 60 - (I.vsFpm || 0)) * k;
  I.vsi.rotation.z = -vsiAngle(I.vsFpm);
  I.tach.rotation.z = -tachAngle(ac.rpm);
  const pitch = ac.pitch, bank = ac.bank;
  I.attTex.rotation = bank; I.attTex.offset.y = Math.max(-0.36, Math.min(0.36, pitch / D2R / 80));
  I.bank.rotation.z = bank;
  const mag = (ac.heading - REGION.magVar) * D2R;           // the compass and the gyro set from it read magnetic, like the readout
  I.hdg.rotation.z = mag;
  I.compass.rotation.y = mag;
  // turn coordinator: rate of turn (standard rate tilts the wings to the mark) and the slip ball
  const turnRate = dt > 0 && I.lastHdg !== undefined ? ((((ac.heading - I.lastHdg + 540) % 360) - 180) / dt) : 0;
  I.lastHdg = ac.heading;
  I.turnS = (I.turnS || 0) + (Math.max(-9, Math.min(9, turnRate)) - (I.turnS || 0)) * (dt > 0 ? 1 - Math.exp(-dt * 3) : 0);
  I.turn.rotation.z = -(I.turnS / 3) * 20 * D2R;
  const slip = Math.max(-1, Math.min(1, (ac.onGround ? 0 : ac.beta) / 0.1));
  I.ball.position.x = I.ballBase.x + slip * R * 0.36; I.ball.position.y = I.ballBase.y - R * (0.535 - 0.04 * slip * slip);
  // clock: runs on the aircraft's own time, so it stops with the pause and keeps up with time compression
  const t = ac.t + 37800;                                    // (the hands start at half past ten)
  I.second.rotation.z = -((t % 60) / 60) * 2 * Math.PI; I.minute.rotation.z = -((t % 3600) / 3600) * 2 * Math.PI; I.hour.rotation.z = -((t % 43200) / 43200) * 2 * Math.PI;
  // elapsed time: starts as the wheels leave the ground, holds on landing
  if (I.wasDown && !ac.onGround) I.t0 = ac.t;
  I.wasDown = ac.onGround;
  if (I.t0 !== null && !ac.onGround) I.et = ac.t - I.t0;
  const sec = Math.floor(I.et) % 60, min = Math.floor(I.et / 60) % 100;
  I.timer[0].userData.set(0, Math.floor(min / 10)); I.timer[0].userData.set(1, min % 10); I.timer[1].userData.set(0, Math.floor(sec / 10)); I.timer[1].userData.set(1, sec % 10);
  parts.flapLever.position.y = L.flap[1] - 0.081 * ac.flapTarget;
  // lighting: a trace by day so shaded markings never go to murk; after dark the dials light from within
  // and the post lights come up, both well under what would bloom
  const e = 0.05 + 0.3 * n;
  for (const m of I.lit) m.emissiveIntensity = e;
  I.orange.emissiveIntensity = 0.08 + 0.5 * n;
  I.plate.emissiveIntensity = 0.02 + 0.3 * n;
  I.lcd.color.setScalar(1.1 - 0.72 * n);
}
