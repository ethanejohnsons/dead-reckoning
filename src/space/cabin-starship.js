// The flight deck in the nose of the Ship, from the commander's seat (front left).
//
// No crewed Starship has flown, so this is a design, kept to what the company has shown of its cabins: white
// panels, black carbon and glass, slim seats, few physical controls. The deck is the nose between stations
// 112.4 m and 117.4 m above the booster's engines (the ogive is 6.8 m across at its aft bulkhead and 4 m at
// the forward one), with a floor 0.3 m to leeward of the centerline. The crew sit with their heads to
// leeward (the vehicle's -Z, away from the heat shield) and face the nose: on their backs on the pad,
// upright when the ship flies belly-first. Ten panes of glass in two rows wrap the leeward side from one
// shoulder over the head to the other and forward to the bulkhead, so the view is ahead and out the back.
//
// In front of each front seat a slim console carries three touchscreens on an arc about the eye: attitude
// (horizon, prograde marker, speed, altitude), trajectory (the climb against downrange, then the orbit with
// its apoapsis and periapsis) and vehicle (the stack, engines lit, throttle, g, mission time, the next
// event), with a row of buttons under them. The screens are canvases redrawn only when their numbers move.

import * as THREE from 'three';
import { TAU, D2R, FONT, prim, rod, lerp, box, Beams, disposeTree } from './model-kit.js';
import {
  V2C, pointToVehicle, dirToVehicle, cabinLight, cabMat, bakeLit, boxUv, Parts, meshFrom, shellWall, plateGeo, block, ringZ,
  Live, flushLive, Sheet, paintTexture, weaveTexture, carbonTexture, occluder, softPad, basis,
} from './cabin-kit.js';

const YD = 112.4, DECK = 5.0, FLOOR = 0.3;           // station of the aft bulkhead, length of the deck, the floor above the centerline
const R_HULL = 4.5, SHIP_CYL = 102.5, TIP = 121.3;   // the ship's own numbers (model-starship.js)
function noseR(y) { if (y <= SHIP_CYL) return R_HULL; const L = TIP + 0.9 - SHIP_CYL, rho = (R_HULL * R_HULL + L * L) / (2 * R_HULL), d = y - SHIP_CYL; return Math.max(0, Math.sqrt(Math.max(0, rho * rho - d * d)) - (rho - R_HULL)); }
const RIN = (h) => noseR(YD + h) - 0.22;
const MPH = 2.23694, FT = 3.28084, MI = 1609.344;

const WHITE = [0.74, 0.74, 0.72], CARBON = [1, 1, 1], BLACKP = [0.03, 0.03, 0.032], LEATHER = [0.72, 0.71, 0.68], DARKL = [0.06, 0.06, 0.065], STEEL = [0.55, 0.56, 0.57];
const UI = { bg: '#04070a', dim: '#5d6b78', mid: '#9fb0bf', ink: '#eef3f7', acc: '#57c7ff', ok: '#6fe3a1', warn: '#ffb648', sky: '#1b4a73', sky2: '#0c2238', gnd: '#3b2d1f', gnd2: '#1d160f' };

const zUp = (g) => g.rotateX(Math.PI / 2);
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
const clock = (t) => { const s = Math.max(0, Math.floor(Math.abs(t))), p = (n) => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };
const altText = (m) => { const ft = m * FT; if (ft < 52800) return [fmtInt(ft), 'FT']; const mi = m / MI; return [mi < 1000 ? mi.toFixed(1) : fmtInt(mi), 'MI']; };

// ---------------------------------------------------------------- the three displays (1024 x 640 each)

const SW = 1024, SH = 640;
function frame(g, title, sub) {
  g.fillStyle = UI.bg; g.fillRect(0, 0, SW, SH);
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillStyle = UI.mid; g.font = `600 22px ${FONT}`; if ('letterSpacing' in g) g.letterSpacing = '3px';
  g.fillText(title, 28, 30); if (sub) { g.textAlign = 'right'; g.fillStyle = UI.dim; g.fillText(sub, SW - 28, 30); }
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  g.fillStyle = 'rgba(159,176,191,0.25)'; g.fillRect(28, 52, SW - 56, 1.5);
}
const txt = (g, s, x, y, px, col = UI.ink, align = 'left', w = 500) => { g.font = `${w} ${px}px ${FONT}`; g.fillStyle = col; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); };
/** A labeled number: small caption over a large figure with its unit. */
function readout(g, x, y, cap, val, unit, col = UI.ink, px = 46, align = 'left') {
  txt(g, cap, x, y, 18, UI.dim, align, 600);
  let uw = 0; if (unit && align === 'right') { g.font = `600 20px ${FONT}`; uw = g.measureText(unit).width + 10; txt(g, unit, x, y + px * 0.72 + px * 0.16, 20, UI.mid, 'right', 600); }
  txt(g, val, x - uw, y + px * 0.72, px, col, align, 500);
  if (unit && align !== 'right') { g.font = `500 ${px}px ${FONT}`; const w = g.measureText(val).width; txt(g, unit, x + w + 10, y + px * 0.72 + px * 0.16, 20, UI.mid, 'left', 600); }
}

function drawAttitude(g, s) {
  const cx = SW / 2, cy = SH / 2 + 16, ppd = 8.5, roll = s.roll * D2R;
  g.fillStyle = UI.bg; g.fillRect(0, 0, SW, SH);
  g.save(); g.beginPath(); g.rect(0, 0, SW, SH); g.clip();
  g.translate(cx, cy); g.rotate(-roll); g.translate(0, s.pitch * ppd);
  const big = 2600;
  let gd = g.createLinearGradient(0, -90 * ppd, 0, 0); gd.addColorStop(0, UI.sky2); gd.addColorStop(1, UI.sky); g.fillStyle = gd; g.fillRect(-big, -big, big * 2, big);
  gd = g.createLinearGradient(0, 0, 0, 90 * ppd); gd.addColorStop(0, UI.gnd); gd.addColorStop(1, UI.gnd2); g.fillStyle = gd; g.fillRect(-big, 0, big * 2, big);
  g.fillStyle = UI.ink; g.fillRect(-big, -1.5, big * 2, 3);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let p = -90; p <= 90; p += 5) {
    if (!p || Math.abs(p - s.pitch) > 42) continue;
    const y = -p * ppd, w = p % 10 === 0 ? 110 : 46;
    g.fillStyle = 'rgba(238,243,247,0.85)'; g.fillRect(-w, y - 1, w * 2, 2);
    if (p % 10 === 0) { g.font = `500 22px ${FONT}`; g.fillText(String(Math.abs(p)), -w - 28, y + 1); g.fillText(String(Math.abs(p)), w + 28, y + 1); if (p < 0) { g.fillRect(-w, y - 9, 2, 9); g.fillRect(w - 2, y - 9, 2, 9); } }
  }
  // prograde: where the craft is actually going
  if (s.fpa != null) { const y = -s.fpa * ppd; g.strokeStyle = UI.ok; g.lineWidth = 3; g.beginPath(); g.arc(0, y, 13, 0, TAU); g.moveTo(-34, y); g.lineTo(-13, y); g.moveTo(13, y); g.lineTo(34, y); g.moveTo(0, y - 13); g.lineTo(0, y - 30); g.stroke(); g.fillStyle = UI.ok; g.beginPath(); g.arc(0, y, 2.5, 0, TAU); g.fill(); }
  g.restore();
  // the craft: fixed
  g.strokeStyle = '#ffd24a'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx - 150, cy); g.lineTo(cx - 56, cy); g.lineTo(cx - 56, cy + 16); g.moveTo(cx + 150, cy); g.lineTo(cx + 56, cy); g.lineTo(cx + 56, cy + 16); g.stroke();
  g.fillStyle = '#ffd24a'; g.fillRect(cx - 5, cy - 5, 10, 10);
  // roll scale
  g.save(); g.translate(cx, cy); g.strokeStyle = UI.ink; g.lineWidth = 2.5; g.beginPath(); g.arc(0, 0, 236, -Math.PI / 2 - 1.05, -Math.PI / 2 + 1.05); g.stroke();
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) { const r = a * D2R, l = a % 30 === 0 ? 20 : 11; g.beginPath(); g.moveTo(Math.sin(r) * 236, -Math.cos(r) * 236); g.lineTo(Math.sin(r) * (236 + l), -Math.cos(r) * (236 + l)); g.stroke(); }
  g.rotate(-roll); g.fillStyle = '#ffd24a'; g.beginPath(); g.moveTo(0, -233); g.lineTo(-11, -212); g.lineTo(11, -212); g.closePath(); g.fill(); g.restore();
  // heading tape
  g.fillStyle = 'rgba(4,7,10,0.72)'; g.fillRect(0, 0, SW, 56); g.save(); g.beginPath(); g.rect(232, 0, SW - 464, 56); g.clip();
  for (let d = Math.floor((s.hdg - 34) / 5) * 5; d <= s.hdg + 34; d += 5) {
    const x = cx + (d - s.hdg) * 8, hd = ((d % 360) + 360) % 360;
    g.fillStyle = UI.mid; g.fillRect(x - 1, 38, 2, hd % 10 === 0 ? 14 : 8);
    if (hd % 10 === 0) txt(g, hd % 90 === 0 ? 'NESW'[hd / 90] : String(hd / 10).padStart(2, '0'), x, 21, hd % 90 === 0 ? 24 : 20, hd % 90 === 0 ? UI.ink : UI.mid, 'center', 600);
  }
  g.restore(); g.fillStyle = '#ffd24a'; g.beginPath(); g.moveTo(cx, 58); g.lineTo(cx - 9, 72); g.lineTo(cx + 9, 72); g.closePath(); g.fill();
  // speed and altitude either side
  const panel = (x, w) => { g.fillStyle = 'rgba(4,7,10,0.78)'; g.fillRect(x, 96, w, SH - 132); g.fillStyle = 'rgba(159,176,191,0.2)'; g.fillRect(x, 96, w, 1.5); };
  panel(0, 214); panel(SW - 214, 214);
  readout(g, 24, 126, s.orbital ? 'ORBITAL SPEED' : 'SPEED', fmtInt(s.speed * MPH), 'MPH', UI.ink, 50);
  readout(g, 24, 250, 'MACH', s.mach < 30 && !s.orbital ? s.mach.toFixed(2) : '–', '', UI.mid, 36);
  readout(g, 24, 340, 'G', s.g.toFixed(1), '', s.g > 4 ? UI.warn : UI.mid, 36);
  readout(g, 24, 430, 'HEADING', String(Math.round(((s.hdg % 360) + 360) % 360)).padStart(3, '0') + '°', '', UI.mid, 36);
  const [av, au] = altText(s.alt);
  readout(g, SW - 24, 126, 'ALTITUDE', av, au, UI.ink, 50, 'right');
  readout(g, SW - 24, 250, 'CLIMB', (s.vs >= 0 ? '+' : '−') + fmtInt(Math.abs(s.vs) * MPH), 'MPH', s.vs < -40 && s.alt < 20000 ? UI.warn : UI.mid, 36, 'right');
  readout(g, SW - 24, 340, 'PITCH', (s.pitch >= 0 ? '+' : '−') + Math.abs(s.pitch).toFixed(0) + '°', '', UI.mid, 36, 'right');
  readout(g, SW - 24, 430, 'ROLL', (s.roll >= 0 ? '+' : '−') + Math.abs(s.roll).toFixed(0) + '°', '', UI.mid, 36, 'right');
  g.fillStyle = 'rgba(4,7,10,0.78)'; g.fillRect(214, SH - 36, SW - 428, 36);
  txt(g, s.sas, cx, SH - 17, 20, UI.acc, 'center', 600);
}

function drawTrajectory(g, s) {
  const orbit = s.mode === 'orbit';
  frame(g, 'TRAJECTORY', orbit ? (s.body === 'moon' ? 'MOON ORBIT' : 'EARTH ORBIT') : 'ASCENT');
  const X0 = 52, Y0 = 84, PW = 620, PH = 500;
  g.save(); g.beginPath(); g.rect(X0, Y0, PW, PH); g.clip();
  if (!orbit) {
    // altitude against distance downrange, miles; the scale grows with the flight
    const maxX = Math.max(60, Math.ceil((s.down / MI) * 1.35 / 60) * 60), maxY = Math.max(30, Math.ceil(Math.max(s.alt, s.target * 0.2) / MI * 1.3 / 30) * 30);
    const px = (mi) => X0 + 46 + (mi / maxX) * (PW - 60), py = (mi) => Y0 + PH - 34 - (mi / maxY) * (PH - 56);
    g.strokeStyle = 'rgba(159,176,191,0.16)'; g.lineWidth = 1; g.fillStyle = UI.dim; g.font = `500 17px ${FONT}`;
    for (let k = 0; k <= 6; k++) { const v = (maxY * k) / 6, y = py(v); g.beginPath(); g.moveTo(px(0), y); g.lineTo(px(maxX), y); g.stroke(); g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(String(Math.round(v)), px(0) - 8, y); }
    for (let k = 0; k <= 6; k++) { const v = (maxX * k) / 6, x = px(v); g.beginPath(); g.moveTo(x, py(0)); g.lineTo(x, py(maxY)); g.stroke(); g.textAlign = 'center'; g.fillText(String(Math.round(v)), x, py(0) + 18); }
    const ty = py(s.target / MI); if (ty > Y0) { g.setLineDash([10, 8]); g.strokeStyle = 'rgba(87,199,255,0.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px(0), ty); g.lineTo(px(maxX), ty); g.stroke(); g.setLineDash([]); txt(g, 'ORBIT', px(maxX) - 6, ty - 13, 16, UI.acc, 'right', 600); }
    g.strokeStyle = UI.ink; g.lineWidth = 3; g.lineJoin = 'round'; g.beginPath(); s.track.forEach(([d, a], k) => (k ? g.lineTo(px(d / MI), py(a / MI)) : g.moveTo(px(d / MI), py(a / MI)))); g.lineTo(px(s.down / MI), py(s.alt / MI)); g.stroke();
    const mx = px(s.down / MI), my = py(s.alt / MI); g.fillStyle = UI.acc; g.beginPath(); g.arc(mx, my, 7, 0, TAU); g.fill(); g.strokeStyle = 'rgba(87,199,255,0.4)'; g.lineWidth = 2; g.beginPath(); g.arc(mx, my, 14, 0, TAU); g.stroke();
    g.restore(); txt(g, 'ALTITUDE  MI', X0 + 50, Y0 + 12, 16, UI.dim, 'left', 600); txt(g, 'DOWNRANGE  MI', X0 + PW - 12, Y0 + PH - 6, 16, UI.dim, 'right', 600);
  } else {
    // the orbit to scale round its body
    const Rb = s.body === 'moon' ? 1737400 : 6371000, ap = Number.isFinite(s.ap) ? s.ap : Rb * 6, ra = Rb + Math.max(ap, s.alt), rp = Rb + Math.max(-Rb * 0.9, s.pe), a = (ra + rp) / 2, e = (ra - rp) / (ra + rp), b = a * Math.sqrt(Math.max(0.02, 1 - e * e));
    const cx = X0 + PW / 2, cy = Y0 + PH / 2, k = Math.min((PW - 70) / (2 * a), (PH - 70) / (2 * Math.max(b, Rb))), c = a * e;      // periapsis to the right of the body
    const bx = cx + c * k, ox = cx;                           // the body at the right-hand focus: periapsis to the right, apoapsis to the left
    const gd = g.createRadialGradient(bx - Rb * k * 0.3, cy - Rb * k * 0.3, Rb * k * 0.1, bx, cy, Rb * k); gd.addColorStop(0, s.body === 'moon' ? '#8d8f93' : '#2a6cae'); gd.addColorStop(1, s.body === 'moon' ? '#3a3b3f' : '#0d2a4c');
    g.fillStyle = gd; g.beginPath(); g.arc(bx, cy, Rb * k, 0, TAU); g.fill();
    if (s.body !== 'moon') { g.strokeStyle = 'rgba(120,190,255,0.5)'; g.lineWidth = 2; g.beginPath(); g.arc(bx, cy, (Rb + 100000) * k, 0, TAU); g.stroke(); }
    g.strokeStyle = UI.ink; g.lineWidth = 2.5; if (!Number.isFinite(s.ap)) g.setLineDash([12, 8]);
    g.beginPath(); g.ellipse(ox, cy, a * k, b * k, 0, 0, TAU); g.stroke(); g.setLineDash([]);
    const mark = (x, lab, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, cy, 6, 0, TAU); g.fill(); txt(g, lab, x, cy - 20, 18, col, 'center', 700); };
    mark(bx + rp * k, 'PE', UI.acc); if (Number.isFinite(s.ap)) mark(bx - ra * k, 'AP', UI.acc);
    // the craft: its distance gives the angle from periapsis, its climb or descent the side
    const r = Rb + s.alt, cosv = e > 1e-4 ? Math.max(-1, Math.min(1, ((a * (1 - e * e)) / r - 1) / e)) : Math.cos((s.time || 0) * 0.02), nu = Math.acos(cosv) * (s.vs >= 0 ? 1 : -1);
    const sx = bx + r * k * Math.cos(nu), sy = cy - r * k * Math.sin(nu); g.fillStyle = UI.ok; g.beginPath(); g.arc(sx, sy, 8, 0, TAU); g.fill(); g.strokeStyle = 'rgba(111,227,161,0.45)'; g.lineWidth = 2; g.beginPath(); g.arc(sx, sy, 16, 0, TAU); g.stroke();
    g.restore();
  }
  g.fillStyle = 'rgba(159,176,191,0.2)'; g.fillRect(700, 84, 1.5, 500);
  const [av, au] = altText(s.alt), fm = (m) => (Number.isFinite(m) ? (Math.abs(m / MI) < 1000 ? (m / MI).toFixed(1) : fmtInt(m / MI)) : '∞');
  readout(g, 726, 92, 'ALTITUDE', av, au, UI.ink, 40);
  readout(g, 726, 180, orbit ? 'ORBITAL SPEED' : 'DOWNRANGE', orbit ? fmtInt(s.speedOrb * MPH) : (s.down / MI).toFixed(1), orbit ? 'MPH' : 'MI', UI.ink, 40);
  readout(g, 726, 268, 'APOAPSIS', fm(s.ap), 'MI', UI.acc, 40);
  readout(g, 726, 356, 'PERIAPSIS', s.pe < -3e6 ? '–' : fm(s.pe), s.pe < -3e6 ? '' : 'MI', s.pe > 80000 || s.body === 'moon' ? UI.acc : UI.mid, 40);
  readout(g, 726, 444, s.nextApsis ? 'TIME TO ' + s.nextApsis : 'TIME TO APOAPSIS', s.tNext != null ? clock(s.tNext) : '–', '', UI.mid, 40);
  if (s.warp > 1) txt(g, 'TIME ×' + fmtInt(s.warp), 726, 566, 22, UI.warn, 'left', 600);
}

const ENG = { 0: [[3, 0.19, 9], [10, 0.54, 9], [20, 0.86, 9]], 1: [[3, 0.24, 13], [3, 0.66, 22]] };
function drawVehicle(g, s) {
  frame(g, 'VEHICLE', s.stageName ? s.stageName.toUpperCase() : '');
  // the stack, nose up: 121.3 m in 500 px
  const bx = 150, by = 590, k = 500 / 121.3, Y = (m) => by - m * k, half = 4.5 * k;
  const part = (active, gone, path) => { g.beginPath(); path(); g.closePath(); if (!gone) { g.fillStyle = active ? 'rgba(87,199,255,0.16)' : 'rgba(159,176,191,0.07)'; g.fill(); } g.setLineDash(gone ? [5, 6] : []); g.strokeStyle = gone ? UI.dim : active ? UI.acc : UI.mid; g.lineWidth = gone ? 1.2 : 2.2; g.stroke(); g.setLineDash([]); };
  part(s.stage === 0, s.stage > 0, () => { g.moveTo(bx - half, Y(0)); g.lineTo(bx - half, Y(71)); g.lineTo(bx + half, Y(71)); g.lineTo(bx + half, Y(0)); });
  if (s.stage === 0) for (const sx of [-1, 1]) { g.fillStyle = UI.mid; g.fillRect(bx + sx * half - (sx < 0 ? 16 : 0), Y(67), 16, 5); g.fillRect(bx + sx * half - (sx < 0 ? 5 : 0), Y(20), 5, 62); }
  part(s.stage === 1, false, () => { g.moveTo(bx - half, Y(71.4)); g.lineTo(bx - half, Y(102.5)); for (let y = 102.5; y <= 121.3; y += 1.2) g.lineTo(bx - noseR(y) * k, Y(y)); for (let y = 121.3; y >= 102.5; y -= 1.2) g.lineTo(bx + noseR(y) * k, Y(y)); g.lineTo(bx + half, Y(71.4)); });
  for (const sx of [-1, 1]) { g.strokeStyle = s.stage === 1 ? UI.acc : UI.mid; g.lineWidth = 2; g.beginPath(); g.moveTo(bx + sx * half, Y(72)); g.lineTo(bx + sx * (half + 17), Y(73)); g.lineTo(bx + sx * (half + 17), Y(78)); g.lineTo(bx + sx * half, Y(81)); g.moveTo(bx + sx * noseR(105) * k, Y(105)); g.lineTo(bx + sx * (noseR(105) * k + 13), Y(106)); g.lineTo(bx + sx * (noseR(109) * k + 11), Y(110)); g.lineTo(bx + sx * noseR(112) * k, Y(112)); g.stroke(); }
  txt(g, 'SHIP', bx + 62, Y(96), 18, s.stage === 1 ? UI.acc : UI.mid, 'left', 600); txt(g, 'BOOSTER', bx + 62, Y(36), 18, s.stage === 0 ? UI.acc : UI.dim, 'left', 600);
  if (s.stage > 0) txt(g, 'SEPARATED', bx + 62, Y(36) + 22, 15, UI.dim, 'left', 600);
  // engines of the stage that is flying
  const ex = 440, ey = 250, er = 128, lit = s.thrust > 0.02; let n = 0;
  g.strokeStyle = 'rgba(159,176,191,0.3)'; g.lineWidth = 1.5; g.beginPath(); g.arc(ex, ey, er + 14, 0, TAU); g.stroke();
  for (const [cnt, rr, sz] of ENG[Math.min(1, s.stage)]) for (let i = 0; i < cnt; i++) {
    const a = (i / cnt) * TAU + (rr > 0.6 ? 0.52 : 0.2), x = ex + Math.cos(a) * rr * er, y = ey + Math.sin(a) * rr * er; n++;
    g.beginPath(); g.arc(x, y, sz, 0, TAU); if (lit) { g.fillStyle = `rgba(87,199,255,${0.35 + 0.65 * s.thrust})`; g.fill(); g.strokeStyle = UI.ink; } else g.strokeStyle = UI.dim; g.lineWidth = 2; g.stroke();
  }
  txt(g, 'ENGINES', ex, ey + er + 42, 18, UI.dim, 'center', 600); txt(g, `${lit ? n : 0} / ${n}`, ex, ey + er + 74, 34, lit ? UI.ink : UI.mid, 'center');
  const bar = (x, y, w, cap, v, max, str, col = UI.acc) => { txt(g, cap, x, y, 18, UI.dim, 'left', 600); txt(g, str, x + w, y, 22, UI.ink, 'right', 600); g.fillStyle = 'rgba(159,176,191,0.16)'; g.fillRect(x, y + 18, w, 10); g.fillStyle = col; g.fillRect(x, y + 18, w * Math.max(0, Math.min(1, v / max)), 10); };
  bar(310, 490, 260, 'THROTTLE', s.throttle, 1, Math.round(s.throttle * 100) + '%'); bar(310, 548, 260, 'G LOAD', s.g, 6, s.g.toFixed(1), s.g > 4 ? UI.warn : UI.acc);
  g.fillStyle = 'rgba(159,176,191,0.2)'; g.fillRect(620, 84, 1.5, 500);
  readout(g, 648, 92, 'MISSION TIME', (s.met < 0 ? 'T− ' : 'T+ ') + clock(Math.max(0, s.met)), '', UI.ink, 48);
  readout(g, 648, 196, 'STAGE', `${s.stage + 1} of ${s.stages}`, '', UI.ink, 36);
  readout(g, 648, 284, 'NEXT EVENT', s.next, '', UI.acc, s.next.length > 16 ? 26 : 32);
  if (s.nextIn != null) txt(g, 'IN ' + clock(s.nextIn), 648, 364, 22, UI.mid, 'left', 600);
  readout(g, 648, 400, 'GUIDANCE', s.autopilot ? 'AUTO' : 'MANUAL', '', s.autopilot ? UI.ok : UI.warn, 32);
  readout(g, 648, 484, 'ATTITUDE HOLD', s.sas, '', UI.mid, 32);
  if (s.warp > 1) txt(g, 'TIME ×' + fmtInt(s.warp), 648, 592, 22, UI.warn, 'left', 600);
}

// ---------------------------------------------------------------- a seat (origin at the hip point; y up, z back)

function seat(P, at, stick = true) {
  const b = [0, 0.951, 0.309], n = [0, -0.309, 0.951], on = (u, d, x = 0) => [at[0] + x, at[1] + b[1] * u + n[1] * d, at[2] + b[2] * u + n[2] * d], q = (x, y, z) => [at[0] + x, at[1] + y, at[2] + z];
  // carbon shell: back, pan, leg rest, the pedestal and its rails
  P.add('carbon', softPad(on(-0.08, 0.075), on(0.95, 0.075), 0.53, 0.04, CARBON, [1, 0, 0], 9, 0.5), softPad(q(0, -0.075, 0.1), q(0, -0.035, -0.47), 0.52, 0.04, CARBON, [1, 0, 0], 7, 0.5), softPad(q(0, -0.05, -0.46), q(0, -0.37, -0.72), 0.46, 0.035, CARBON, [1, 0, 0], 6, 0.5));
  P.add('carbon', box(0.3, 0.36, 0.34, q(0, -0.27, -0.12), CARBON), box(0.07, 0.03, 1.1, q(-0.2, -0.465, -0.15), [0.5, 0.5, 0.5]), box(0.07, 0.03, 1.1, q(0.2, -0.465, -0.15), [0.5, 0.5, 0.5]));
  // cushions: back in three quilted panels, seat, leg rest; black bolsters down the sides
  for (const [u0, u1] of [[0.03, 0.22], [0.235, 0.43], [0.445, 0.64]]) P.add('leather', softPad(on(u0, 0.022), on(u1, 0.022), 0.4, 0.07, LEATHER, [1, 0, 0], 5));
  P.add('leather', softPad(q(0, -0.02, 0.03), q(0, 0.0, -0.2), 0.4, 0.075, LEATHER, [1, 0, 0], 5), softPad(q(0, 0.0, -0.215), q(0, 0.015, -0.44), 0.4, 0.07, LEATHER, [1, 0, 0], 5), softPad(q(0, -0.035, -0.47), q(0, -0.33, -0.7), 0.36, 0.05, LEATHER, [1, 0, 0], 5));
  for (const sx of [-1, 1]) P.add('leather', softPad(on(0.02, 0.03, sx * 0.235), on(0.66, 0.03, sx * 0.235), 0.075, 0.1, DARKL, [1, 0, 0], 6), softPad(q(sx * 0.235, 0.0, 0.03), q(sx * 0.235, 0.02, -0.43), 0.075, 0.1, DARKL, [1, 0, 0], 6));
  // headrest with wings
  P.add('leather', softPad(on(0.68, 0.035), on(0.92, 0.035), 0.24, 0.075, DARKL, [1, 0, 0], 5));
  for (const sx of [-1, 1]) P.add('leather', softPad(on(0.7, -0.03, sx * 0.145), on(0.9, -0.03, sx * 0.145), 0.15, 0.04, DARKL, [0, 0.309, -0.951], 5));
  // harness: shoulder straps to the buckle, lap belts out to the sides
  for (const sx of [-1, 1]) { P.add('belt', rodFlat(on(0.66, -0.016, sx * 0.085), on(0.2, -0.016, sx * 0.07), 0.042, 0.004), rodFlat(on(0.2, -0.016, sx * 0.07), on(0.1, -0.02, sx * 0.012), 0.042, 0.004), rodFlat(q(sx * 0.02, 0.04, -0.06), q(sx * 0.2, 0.035, -0.02), 0.042, 0.004)); }
  P.add('steel', zUp(prim(new THREE.CylinderGeometry(0.034, 0.034, 0.016, 18), { rgb: STEEL })).rotateX(-0.31).translate(...on(0.09, -0.03)));
  // armrests; the right one carries the hand controller
  for (const sx of [-1, 1]) {
    P.add('carbon', box(0.05, 0.16, 0.05, q(sx * 0.3, 0.07, -0.02), CARBON)); P.add('leather', softPad(q(sx * 0.3, 0.165, 0.06), q(sx * 0.3, 0.175, -0.3), 0.07, 0.035, DARKL, [1, 0, 0], 5));
    if (stick && sx > 0) { P.add('carbon', box(0.06, 0.03, 0.07, q(0.3, 0.185, -0.335), CARBON)); P.add('steel', rod(q(0.3, 0.195, -0.335), q(0.3, 0.25, -0.345), 0.008, STEEL, 6)); P.add('leather', rod(q(0.3, 0.25, -0.345), q(0.3, 0.3, -0.352), 0.017, DARKL, 10)); }
  }
  P.add('steel', rod(q(-0.2, -0.4, -0.77), q(0.2, -0.4, -0.77), 0.012, STEEL, 8));
}
/** A flat strap from a to b. */
function rodFlat(a, b, w, t) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), l = d.length(), g = box(w, l, t, [0, 0, 0], [0.08, 0.08, 0.085]);
  const y = d.clone().normalize(), x = new THREE.Vector3(1, 0, 0).addScaledVector(y, -y.x).normalize(), z = new THREE.Vector3().crossVectors(x, y);
  return g.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2));
}

// ---------------------------------------------------------------- the cabin

export function buildStarshipCabin() {
  const t0 = performance.now();
  const root = new THREE.Group(); root.name = 'Starship flight deck';
  const cab = new THREE.Group(); cab.quaternion.setFromRotationMatrix(V2C); cab.position.set(0, YD, 0); root.add(cab);
  const G = new Parts();
  const EYE = [-0.8, 1.5, -2.0], HIP = [-0.8, 0.728, -2.083];

  // ---- the hull's lining and the ten panes
  const holes = [];
  for (const az of [40, 65, 90, 115, 140]) {
    holes.push({ ac: az * D2R, hc: 1.95, w: 21 * D2R * RIN(1.95), hgt: 1.86, rad: 0.16, margin: 0.07, conformal: true });
    holes.push({ ac: az * D2R, hc: 3.85, w: 21 * D2R * RIN(3.85), hgt: 1.66, rad: 0.16, margin: 0.07, conformal: true });
  }
  const sh = shellWall(RIN, 0, DECK, { az0: -5 * D2R, az1: 185 * D2R, segA: 64, segH: 18, rgb: WHITE, holes, NS: 40 });
  const windows = [], toCab = (g) => g.applyMatrix4(V2C);
  G.add('white', toCab(sh.wall));
  for (const H of sh.holes) { G.add('white', toCab(H.reveal(0.15, [0.5, 0.5, 0.49]))); G.add('black', toCab(H.bezel(0.03, 0.012, BLACKP))); G.add('glass', toCab(H.pane(0.13))); windows.push(H.window(0.15)); }
  const U = cabinLight(windows);
  const onWall = (az, h, inset = 0) => {
    const a = az * D2R, p = new THREE.Vector3(...sh.P(a, h, inset)).applyMatrix4(V2C), n = new THREE.Vector3(...sh.Nin(a, h)).transformDirection(V2C);
    const x = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).transformDirection(V2C), y = new THREE.Vector3().crossVectors(n, x).normalize();
    return new THREE.Matrix4().makeBasis(x, y, n).setPosition(p);
  };
  const put = (list, M, ...geos) => { for (const g of geos) G.add(list, g.applyMatrix4(M)); };
  const q = (az, h, e) => new THREE.Vector3(...sh.P(az * D2R, h, e)).applyMatrix4(V2C).toArray();
  const glow = [];                                     // light strips: emissive, one mesh

  // seams between the lining's panels, grab rails along the mullions, light strips along the sills
  {
    const bm = new Beams();
    for (const az of [27.5, 52.5, 77.5, 102.5, 127.5, 152.5]) for (let k = 0; k < 20; k++) bm.add(q(az, 0.05 + k * 0.245, 0.0008), q(az, 0.05 + (k + 1) * 0.245, 0.0008), 0.006, [0.3, 0.3, 0.3], 0.0016);
    for (const h of [0.92, 2.94, 4.78]) for (let az = 6; az < 174; az += 3) bm.add(q(az, h, 0.0008), q(az + 3, h, 0.0008), 0.0016, [0.3, 0.3, 0.3], 0.006);
    G.add('white', bm.build());
    for (const az of [52.5, 127.5]) for (const [h0, h1] of [[1.3, 2.6], [3.3, 4.4]]) {
      G.add('steel', rod(q(az, h0, 0.07), q(az, h1, 0.07), 0.013, STEEL, 8), rod(q(az, h0, 0), q(az, h0, 0.07), 0.01, STEEL, 6), rod(q(az, h1, 0), q(az, h1, 0.07), 0.01, STEEL, 6), rod(q(az, (h0 + h1) / 2, 0), q(az, (h0 + h1) / 2, 0.07), 0.01, STEEL, 6));
    }
    for (const az of [26, 154]) { const b2 = new Beams(); for (let k = 0; k < 16; k++) b2.add(q(az, 0.3 + k * 0.28, 0.012), q(az, 0.3 + (k + 1) * 0.28, 0.012), 0.03, [1, 1, 1], 0.008); glow.push(b2.build()); const b3 = new Beams(); for (let k = 0; k < 16; k++) b3.add(q(az - (az < 90 ? 0.9 : -0.9), 0.3 + k * 0.28, 0.008), q(az - (az < 90 ? 0.9 : -0.9), 0.3 + (k + 1) * 0.28, 0.008), 0.11, BLACKP, 0.016); G.add('black', b3.build()); }
  }
  // lockers along both sides under the windows: doors standing a little proud, a pull let into each
  for (const s of [1, -1]) for (const [h0, h1] of [[0.12, 0.98], [1.06, 1.92], [2.0, 2.86], [2.94, 3.8], [3.88, 4.7]]) {
    const az = s > 0 ? 15.8 : 164.2, hm = (h0 + h1) / 2, w = RIN(hm) * 13.5 * D2R, bm = new Beams();
    bm.add(q(az, h0, 0.012), q(az, h1, 0.012), w, [0.7, 0.7, 0.68], 0.024, true); G.add('white', bm.build());
    put('black', onWall(az, hm, 0.024), box(0.16, 0.035, 0.004, [0, w * 0.32, 0.002], BLACKP));
  }

  // floor, bulkheads
  {
    const half = RIN(0) + 0.05;
    G.add('floor', plateGeo(-half, 0, half, DECK, 12, 10, () => [0, 0], [], 0, [0.2, 0.205, 0.21]).rotateX(-Math.PI / 2).translate(0, FLOOR, 0));
    // an aisle strip and seams
    for (const x of [-1.5, -0.35, 0.35, 1.5]) G.add('black', box(0.012, 0.004, DECK, [x, FLOOR + 0.002, -DECK / 2], [0.07, 0.07, 0.075]));
    for (let k = 1; k < 6; k++) G.add('black', box(half * 2, 0.004, 0.012, [0, FLOOR + 0.002, -k * 0.83], [0.07, 0.07, 0.075]));
    for (const s of [1, -1]) glow.push(box(0.03, 0.01, DECK - 0.3, [s * 0.35, FLOOR + 0.006, -DECK / 2], [1, 1, 1]));
    // aft bulkhead (behind the seats) with the hatch down to the rest of the ship
    G.add('white', prim(new THREE.CircleGeometry(RIN(0) + 0.05, 64), { rgb: [0.7, 0.7, 0.68] }).rotateY(Math.PI).translate(0, 0, -0.001));
    put('black', new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.4, -0.002), ringZ(0, 0, 0.56, 0.66, 0, 0.03, BLACKP, 48)); put('white', new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.4, -0.002), prim(new THREE.CircleGeometry(0.56, 40), { rgb: [0.62, 0.62, 0.6], pos: [0, 0, 0.012] })); put('steel', new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, 1.4, -0.002), rod([-0.18, 0, 0.06], [0.18, 0, 0.06], 0.014, STEEL), rod([-0.18, 0, 0.012], [-0.18, 0, 0.06], 0.011, STEEL), rod([0.18, 0, 0.012], [0.18, 0, 0.06], 0.011, STEEL));
  }
  // forward bulkhead: painted, with the hatch to the nose
  const fwd = new Sheet(-2.0, FLOOR, 2.0, 1.9, 500, '#b9b9b5');
  {
    const S = fwd; S.noise(1200, 5, 0.02);
    for (const x of [-1.25, -0.72, 0.72, 1.25]) S.line([[x, FLOOR], [x, 1.9]], 'rgba(40,42,44,0.55)', 0.004);
    S.line([[-2, 0.62], [-0.72, 0.62]], 'rgba(40,42,44,0.55)', 0.004); S.line([[0.72, 0.62], [2, 0.62]], 'rgba(40,42,44,0.55)', 0.004);
    S.disc(0, 1.02, 0.62, '#0c0c0d'); S.disc(0, 1.02, 0.55, '#a9a9a5', 'rgba(30,30,30,0.6)', 0.004); S.disc(0, 1.02, 0.5, null, 'rgba(60,62,64,0.35)', 0.003);
    S.disc(0, 1.2, 0.11, '#07090b', 'rgba(30,30,30,0.9)', 0.012);
    S.text('FORWARD HATCH', 0, 0.74, 0.03, { color: '#2a2c2f', weight: 600, track: 0.12 }); S.text('DOCKING PORT', 0, 0.68, 0.018, { color: '#55585c', weight: 600, track: 0.12 });
    for (const sx of [-1, 1]) { S.rect(sx * 0.99 - 0.2, 0.74, sx * 0.99 + 0.2, 1.6, null, 'rgba(40,42,44,0.5)', 0.004, 0.03); S.rect(sx * 0.99 - 0.07, 1.46, sx * 0.99 + 0.07, 1.5, '#0c0c0d', null, 0, 0.01); S.text(sx < 0 ? 'SUITS' : 'SURVIVAL', sx * 0.99, 1.38, 0.022, { color: '#55585c', weight: 600, track: 0.12 }); }
    for (const sx of [-1, 1]) { S.rect(sx * 1.52 - 0.17, 0.74, sx * 1.52 + 0.17, 1.3, null, 'rgba(40,42,44,0.5)', 0.004, 0.03); S.rect(sx * 1.52 - 0.06, 1.2, sx * 1.52 + 0.06, 1.235, '#0c0c0d', null, 0, 0.01); S.text(sx < 0 ? 'MEDICAL' : 'FIRE', sx * 1.52, 1.12, 0.02, { color: sx < 0 ? '#55585c' : '#a3261d', weight: 600, track: 0.12 }); }
    const M = new THREE.Matrix4().makeTranslation(0, 0, -DECK);
    put('fwd', M, plateGeo(S.x0, S.y0, S.x1, S.y1, 16, 8, S.uv));
    put('black', M, ringZ(0, 1.02, 0.55, 0.63, 0, 0.035, BLACKP, 56)); put('steel', M, rod([-0.2, 0.95, 0.07], [0.2, 0.95, 0.07], 0.015, STEEL), rod([-0.2, 0.95, 0], [-0.2, 0.95, 0.07], 0.012, STEEL), rod([0.2, 0.95, 0], [0.2, 0.95, 0.07], 0.012, STEEL));
    put('glassI', M, prim(new THREE.CircleGeometry(0.11, 24), { pos: [0, 1.2, 0.004] }));
    glow.push(box(2.5, 0.025, 0.012, [0, 1.76, -DECK + 0.02], [1, 1, 1]));
    put('black', M, box(2.6, 0.06, 0.016, [0, 1.76, 0.008], BLACKP));
  }

  // ---- seats: two in front, four behind
  const SP = new Parts();
  seat(SP, HIP); seat(SP, [0.8, HIP[1], HIP[2]]);
  for (const x of [-2.0, -0.8, 0.8, 2.0]) seat(SP, [x, HIP[1], -0.8], false);
  for (const k of Object.keys(SP.lists)) G.add(k, SP.geometry(k));

  // ---- consoles: three screens on an arc about each front seat's eye
  const K = 2400, facets = [new Sheet(-0.205, -0.215, 0.205, 0.135, K, '#060708'), new Sheet(-0.205, -0.215, 0.205, 0.135, K, '#060708'), new Sheet(-0.205, -0.215, 0.205, 0.135, K, '#060708')];
  const BTN = [[['ABORT', 1], ['ENGINE\nCUTOFF', 0], ['HOLD\nATTITUDE', 0], ['MANUAL\nCONTROL', 0], ['AUTO\nPILOT', 0]], [['EXECUTE', 0], ['CANCEL', 0], ['PAGE\n◀', 0], ['PAGE\n▶', 0], ['DISPLAY\nDIM', 0]], [['CABIN\nLIGHTS', 0], ['COMM', 0], ['VENT', 0], ['CAUTION\nACK', 0], ['FIRE\nSUPPRESS', 1]]];
  const screenQuads = [[], [], []], occ = [];
  facets.forEach((S, f) => {
    S.bl = S.uv(0, 0);
    const g = S.g; { const gd = g.createLinearGradient(0, 0, 0, S.H); gd.addColorStop(0, '#0b0c0e'); gd.addColorStop(1, '#040506'); g.fillStyle = gd; g.fillRect(0, 0, S.W, S.H); }
    S.rect(-0.183, -0.1155, 0.183, 0.1155, '#000', 'rgba(90,96,102,0.5)', 0.0006, 0.004);
    S.rect(-0.198, -0.205, 0.198, -0.132, '#0f1012', 'rgba(90,96,102,0.35)', 0.0006, 0.006);
    BTN[f].forEach(([leg, red], k) => {
      const x = -0.148 + k * 0.074, y = -0.168;
      S.rect(x - 0.0305, y - 0.0215, x + 0.0305, y + 0.0215, '#000', null, 0, 0.004);
      S.rect(x - 0.028, y - 0.019, x + 0.028, y + 0.019, red ? '#3a0c0a' : '#1b1d20', red ? 'rgba(255,90,70,0.8)' : 'rgba(150,160,170,0.55)', 0.0006, 0.003);
      S.text(leg, x, y, 0.0048, { color: red ? '#ffd9d2' : '#f1f3f5', weight: 600, track: 0.05, squeeze: 0.88 });
    });
    S.blankAt(0, 0, 0.006);
  });
  const consoleAt = (ex) => {
    [32, 0, -32].forEach((yaw, f) => {
      const S = facets[f], M = new THREE.Matrix4().makeTranslation(ex, EYE[1], EYE[2]).multiply(new THREE.Matrix4().makeRotationY(yaw * D2R)).multiply(new THREE.Matrix4().makeRotationX(-12 * D2R)).multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.72));
      const P = new Parts();
      P.add('f' + f, plateGeo(S.x0, S.y0, S.x1, S.y1, 2, 2, S.uv));
      BTN[f].forEach(([, red], k) => { const x = -0.148 + k * 0.074, y = -0.168; P.add('f' + f, block(x - 0.028, y - 0.019, x + 0.028, y + 0.019, 0, 0.005, S.uv, [0.02, 0.02, 0.022], [1, 1, 1], S.bl)); if (red) P.add('black', box(0.064, 0.004, 0.02, [x, y + 0.025, 0.01], [0.45, 0.05, 0.04]), box(0.004, 0.046, 0.02, [x - 0.032, y + 0.002, 0.01], [0.45, 0.05, 0.04]), box(0.004, 0.046, 0.02, [x + 0.032, y + 0.002, 0.01], [0.45, 0.05, 0.04])); });
      P.add('carbon', block(-0.21, -0.222, 0.21, 0.14, -0.035, -0.0006, null, CARBON, CARBON), softPad([-0.2, -0.232, 0.012], [0.2, -0.232, 0.012], 0.05, 0.03, [0.5, 0.5, 0.5], [0, 0, 1], 5));
      P.add('glassI', plateGeo(-0.183, -0.1155, 0.183, 0.1155, 1, 1, () => [0, 0], [], 0.0012));
      for (const name of Object.keys(P.lists)) { const g = P.geometry(name, M); if (g) G.add(name, g); }
      const sq = plateGeo(-0.18, -0.1125, 0.18, 0.1125, 1, 1, (x, y) => [(x + 0.18) / 0.36, (y + 0.1125) / 0.225], [], 0.0006).applyMatrix4(M); screenQuads[f].push(sq);
      occ.push(occluder(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(0, -0.04, -0.018)), [0.21, 0.18, 0.018]));
    });
    // the arm that carries it: up from the floor ahead of the knees, a yoke under the three facets
    const base = [ex, FLOOR, EYE[2] - 1.05], top = [ex, EYE[1] - 0.44, EYE[2] - 0.86];
    G.add('carbon', softPad(base, top, 0.11, 0.06, CARBON, [1, 0, 0], 6, 0.6), softPad([ex - 0.36, EYE[1] - 0.435, EYE[2] - 0.62], [ex, EYE[1] - 0.43, EYE[2] - 0.84], 0.08, 0.035, CARBON, [0, 1, 0], 5, 0.6), softPad([ex + 0.36, EYE[1] - 0.435, EYE[2] - 0.62], [ex, EYE[1] - 0.43, EYE[2] - 0.84], 0.08, 0.035, CARBON, [0, 1, 0], 5, 0.6), box(0.3, 0.02, 0.24, [ex, FLOOR + 0.01, EYE[2] - 1.05], [0.6, 0.6, 0.6]));
  };
  consoleAt(EYE[0]); consoleAt(-EYE[0]);

  // ---------------------------------------------------------------- light, materials, meshes
  for (const [x, z] of [[-0.8, HIP[2]], [0.8, HIP[2]], [-2.0, -0.8], [-0.8, -0.8], [0.8, -0.8], [2.0, -0.8]]) occ.push(occluder(new THREE.Matrix4().makeRotationX(0.314).setPosition(x, 1.14, z + 0.187), [0.26, 0.48, 0.05]), occluder(new THREE.Matrix4().makeTranslation(x, 0.7, z - 0.22), [0.26, 0.05, 0.26]));
  const L = {
    floods: [{ p: [0, 1.7, -DECK + 0.15], i: 0.55, r: 1.6 }, { p: [-2.4, 1.05, -2.5], i: 0.4, r: 1.5 }, { p: [2.4, 1.05, -2.5], i: 0.4, r: 1.5 }, { p: [-2.6, 1.0, -0.8], i: 0.3, r: 1.5 }, { p: [2.6, 1.0, -0.8], i: 0.3, r: 1.5 }, { p: [0, 0.5, -2.5], i: 0.2, r: 1.2 }],
    wins: windows.map((w) => ({ c: w.c, n: w.n, area: w.area * 0.3 })), amb: [0.2, 0.1], occ,
  };
  const paintTex = paintTexture(11, 256, 0.7), M = {
    white: cabMat(U, { map: paintTex, roughness: 0.62 }),
    black: cabMat(U, { map: paintTex, roughness: 0.4, envMapIntensity: 0.25 }),
    floor: cabMat(U, { map: weaveTexture(10, 256, 0.35), roughness: 0.85 }),
    carbon: cabMat(U, { map: carbonTexture(256, 8), roughness: 0.32, envMapIntensity: 0.4 }),
    leather: cabMat(U, { map: paintTexture(4, 256, 1.6), roughness: 0.7 }),
    belt: cabMat(U, { map: weaveTexture(30, 256, 0.4), roughness: 0.9 }),
    steel: cabMat(U, { map: paintTex, roughness: 0.3, metalness: 0.9, envMapIntensity: 0.6 }),
    fwd: cabMat(U, { map: fwd.texture(), roughness: 0.62 }),
    f0: cabMat(U, { map: facets[0].texture(), roughness: 0.25, envMapIntensity: 0.3 }, { el: true, sharp: -0.4 }),
    f1: cabMat(U, { map: facets[1].texture(), roughness: 0.25, envMapIntensity: 0.3 }, { el: true, sharp: -0.4 }),
    f2: cabMat(U, { map: facets[2].texture(), roughness: 0.25, envMapIntensity: 0.3 }, { el: true, sharp: -0.4 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.03, metalness: 0, envMapIntensity: 1.0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    glassI: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 0, envMapIntensity: 0.35, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  };
  const TILE = { white: 0.5, black: 0.3, floor: 0.06, carbon: 0.07, leather: 0.25, belt: 0.03, steel: 0.3 };
  for (const name of Object.keys(G.lists)) {
    const g = G.geometry(name); if (!g) continue;
    if (TILE[name]) boxUv(g, TILE[name]);
    if (!name.startsWith('glass')) bakeLit(g, L, true);
    const m = meshFrom(g, M[name]); m.name = name; if (name.startsWith('glass')) m.renderOrder = 2;
    cab.add(m);
  }
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1.0, 0.97, 0.92), emissiveIntensity: 1.3, fog: false });
  { const P = new Parts(); P.add('g', ...glow); cab.add(meshFrom(P.geometry('g'), glowMat)); }

  // ---------------------------------------------------------------- the displays
  const mkLive = (draw) => new Live(SW, SH, (g, st) => { if (st) draw(g, st); else { g.fillStyle = UI.bg; g.fillRect(0, 0, SW, SH); } });
  const lives = [mkLive(drawAttitude), mkLive(drawTrajectory), mkLive(drawVehicle)];
  const dmats = lives.map((l, f) => { const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: l.tex, emissiveIntensity: 1, roughness: 0.3, fog: false, envMapIntensity: 0.1 }); const P = new Parts(); P.add('q', ...screenQuads[f]); cab.add(meshFrom(P.geometry('q'), m)); l.tex.anisotropy = 16; return m; });

  // ---------------------------------------------------------------- the interface
  const eye = pointToVehicle(EYE, YD), look = dirToVehicle([0, -Math.sin(4 * D2R), -Math.cos(4 * D2R)]), upV = dirToVehicle([0, Math.cos(4 * D2R), -Math.sin(4 * D2R)]);
  const st = { turn: 0, down: 0, track: [[0, 0]], qPeak: 0, pastQ: false, t2: -1, t4: -1, target: 185000 };
  const sunC = new THREE.Vector3(), tmp = new THREE.Vector3();

  function update(dt, s) {
    const night = s.night || 0, lit = s.lit ?? 1, space = s.alt > 45000 || s.body === 'moon';
    const expo = s.exposure || (space ? 1.25 + 1.5 * (1 - lit) * (1 - lit) : 1 + 2.4 * night * night), gain = 1 / Math.pow(expo, 0.8);
    U.uFlood.value.set(1.0, 0.97, 0.92).multiplyScalar(0.8 * gain);
    const day = space ? 0.55 * lit : (1 - night) * (0.45 + 0.55 * lit);
    U.uDay.value.set(0.82, 0.9, 1.04).multiplyScalar(day * 1.25);
    let bounce = 0;
    if (s.sunDir) {
      sunC.set(-s.sunDir.x, -s.sunDir.z, -s.sunDir.y).normalize(); U.uSunDir.value.copy(sunC);
      for (const w of windows) bounce += Math.max(0, sunC.x * w.n[0] + sunC.y * w.n[1] + sunC.z * w.n[2]) * w.area;
      const k = lit * (space ? 1 : 1 - night);
      U.uSunCol.value.set(1.0, 0.95, 0.86).multiplyScalar(3.0 * k);
      U.uDay.value.addScaledVector(tmp.set(1.0, 0.94, 0.84), Math.min(1, bounce * 0.12) * k);
    } else U.uSunCol.value.set(0, 0, 0);
    const dark = Math.max(0, 1 - day * 1.4);
    U.uEL.value = (0.25 + 0.5 * dark) * gain;
    glowMat.emissiveIntensity = (0.9 + 0.5 * dark) * gain;
    for (const m of dmats) m.emissiveIntensity = (1.3 - 0.1 * dark) * gain;

    // the flight, as the displays show it
    const horiz = Math.sqrt(Math.max(0, (s.speedSurf || 0) ** 2 - (s.vs || 0) ** 2));
    if (s.met >= 0 && dt > 0 && !s.landed) st.down += horiz * dt * (6371000 / (6371000 + s.alt));
    if (s.met < 0) { st.down = 0; st.track = [[0, 0]]; st.qPeak = 0; st.pastQ = false; }
    const tl = st.track[st.track.length - 1];
    if (Math.abs(st.down - tl[0]) > 4000 || Math.abs(s.alt - tl[1]) > 2500) { st.track.push([st.down, s.alt]); if (st.track.length > 300) st.track.splice(1, 2); }
    if (s.q > st.qPeak) st.qPeak = s.q; else if (st.qPeak > 5000 && s.q < 0.85 * st.qPeak) st.pastQ = true;
    const orbital = s.alt > 90000 || s.body === 'moon', vh = orbital ? Math.sqrt(Math.max(0, s.speedOrb ** 2 - s.vs ** 2)) : horiz, speed = orbital ? s.speedOrb : s.speedSurf;
    const fpa = speed > 30 ? Math.atan2(s.vs, vh) / D2R : null, sas = (s.autopilot ? 'AUTOPILOT' : 'MANUAL') + '  ·  ' + ({ hold: 'HOLD ATTITUDE', prograde: 'HOLD PROGRADE', retrograde: 'HOLD RETROGRADE' }[s.sas] || 'FREE');
    const [av, au] = altText(s.alt);
    const A = { pitch: s.pitch || 0, roll: ((((s.roll || 0) + 180) % 360) + 360) % 360 - 180, hdg: s.hdg || 0, fpa, speed, orbital, mach: s.mach || 0, g: s.gLoad || 0, alt: s.alt, vs: s.vs || 0, sas };
    lives[0].want(`${Math.round(A.pitch * 4)},${Math.round(A.roll * 4)},${Math.round(A.hdg * 4)},${fpa == null ? '' : Math.round(fpa * 4)},${Math.round(speed * MPH)},${av}${au},${A.g.toFixed(1)},${Math.round(A.vs * MPH)},${sas},${A.mach.toFixed(2)}`, A);
    // trajectory: twice a second
    const tA = Number.isFinite(s.tAp) && s.tAp > 0 ? s.tAp : Infinity, tP = Number.isFinite(s.tPe) && s.tPe > 0 ? s.tPe : Infinity, tNext = Math.min(tA, tP);
    const mode = s.body === 'earth' && s.pe < 60000 && s.alt < 400000 && !s.landed ? 'ascent' : s.landed && s.body === 'earth' ? 'ascent' : 'orbit';
    const slot2 = Math.floor(s.time * 2);
    if (slot2 !== st.t2) {
      st.t2 = slot2;
      const T = { mode, body: s.body, alt: s.alt, vs: s.vs, down: st.down, track: st.track, target: st.target, ap: s.ap, pe: s.pe, speedOrb: s.speedOrb, tNext: Number.isFinite(tNext) ? tNext : null, nextApsis: tA <= tP ? 'APOAPSIS' : 'PERIAPSIS', warp: s.warp, time: s.time };
      lives[1].want(`${mode},${av}${au},${Math.round(st.down / 300)},${Math.round(s.ap / 500)},${Math.round(s.pe / 500)},${T.tNext == null ? '' : Math.floor(T.tNext)},${s.warp},${st.track.length}`, T);
    }
    // vehicle: four times a second
    const slot4 = Math.floor(s.time * 4);
    if (slot4 !== st.t4) {
      st.t4 = slot4;
      let next = 'LIFTOFF', nextIn = null;
      if (s.pilot) next = { wait: 'TRANSFER BURN', burn: 'TRANSFER CUTOFF', coast: 'LUNAR ARRIVAL', capture: 'LUNAR ORBIT' }[s.pilot] || 'COAST';
      else if (s.landed && s.met >= 0) next = 'ON THE SURFACE';
      else if (s.met >= 0 && s.thrust > 0.02 && s.stage === 0) next = s.mach < 1 ? 'MACH 1' : !st.pastQ ? 'MAX Q' : 'STAGE SEPARATION';
      else if (s.met >= 0 && s.thrust > 0.02) next = s.pe < 80000 && s.body === 'earth' ? 'ORBIT INSERTION' : 'ENGINE CUTOFF';
      else if (s.met >= 0 && s.stage === 0) next = 'SHIP IGNITION';
      else if (s.met >= 0) { next = Number.isFinite(tNext) ? (tA <= tP ? 'APOAPSIS' : 'PERIAPSIS') : 'COAST'; nextIn = Number.isFinite(tNext) ? tNext : null; }
      const Vv = { stage: s.stage, stages: s.stages || 2, stageName: s.stageName, thrust: s.thrust || 0, throttle: s.throttle || 0, g: s.gLoad || 0, met: s.met, next, nextIn, autopilot: !!s.autopilot, sas: { hold: 'HOLD', prograde: 'PROGRADE', retrograde: 'RETROGRADE' }[s.sas] || 'FREE', warp: s.warp };
      lives[2].want(`${s.stage},${Math.round(Vv.thrust * 20)},${Math.round(Vv.throttle * 100)},${Vv.g.toFixed(1)},${Math.floor(s.met)},${next},${nextIn == null ? '' : Math.floor(nextIn)},${Vv.autopilot},${Vv.sas},${s.warp}`, Vv);
    }
    flushLive(lives, st.turn++, 2);
  }

  const cabin = {
    root, eye, look, up: upV, fov: 64, reach: { yaw: 1.5, up: 1.15, down: 0.75 }, update,
    dispose() { disposeTree(root); },
    info: { ms: 0, windows, sheets: [...facets, fwd].map((S) => S.c), lives: lives.map((l) => l.c) },
  };
  cabin.info.ms = +(performance.now() - t0).toFixed(1);
  return cabin;
}
