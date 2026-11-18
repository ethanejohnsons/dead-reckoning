// What FlightGear draws with its own canvas code and this game has to draw itself: the screens of the cockpits that
// come as model files (pit.js), and the F-16's head-up display.
//
// A screen is a canvas drawn in the style of the real display and laid on the screen's own polygon in the cockpit
// model (its texture coordinates are worked out again from the polygon, so the picture always sits square and
// upright on it). The 737 has its primary flight display (attitude with pitch ladder and bank scale, speed and
// altitude tapes, vertical speed, heading), its navigation display (a track-up compass arc with the map pin where
// there is one) and its engine display (N1 and EGT dials, fuel); the F-16 its two multifunction displays (radar
// format with the horizon line, horizontal situation), its electronic horizontal situation indicator and the data
// entry display.
//
// Drawing a canvas and sending it to the GPU is not free, so the discipline of the Cessna's panel holds here too:
// every screen has a signature (the numbers it shows, rounded to what a pixel can tell apart) and a shortest time
// between redraws; a frame redraws at most two screens, and none whose signature has not changed.
//
// The head-up display is not a picture on the glass: its light is collimated, so the symbols lie at infinity over
// the world and stay on the horizon as the head moves. Here they are geometry given as directions from the eye
// (HUD_VERT), drawn as light added to the scene, and cut off where the line of sight misses the combiner glass (HUD_FRAG works out
// where each ray crosses the pane). The pitch ladder turns and slides with the real horizon every frame, as does
// the flight path marker with the velocity; only the numbers (speed, altitude, heading tape, g, Mach) are a canvas.

import * as THREE from 'three';
import { FONT } from './kit.js';

const KT = 1.94384, FT = 3.28084, R2D = 180 / Math.PI, D2R = Math.PI / 180;
const MONO = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, monospace';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const pad = (n, w) => String(Math.round(n)).padStart(w, '0');

// ---------------------------------------------------------------- screens in general

// TOP: every canvas here is sent to the GPU as it lies, its top row first (flipY off), and the texture coordinates
// are turned over instead. The world's imagery is uploaded with WebGL calls of its own that leave "do not flip"
// set behind three.js's back; a canvas that asked three.js to flip it would now and then arrive upside down.

/** A canvas and its texture. `draw(g, st)` paints it; `sig(st)` says what it would show; `every` is the least seconds between redraws. */
function screen(w, h, every, sig, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.flipY = false;         // (see TOP below)
  return { c, g: c.getContext('2d'), tex, w, h, every, sig, draw, last: null, at: -1e9, mat: new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }) };
}

/** Lay a screen on a polygon of the cockpit model: the picture's right is the pilot's right, its top the polygon's upper edge. */
function mount(obj, scr, inset = 0) {
  if (!obj) return;
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry, p = g.attributes.position, n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ix = g.index;
    for (let i = 0; i < (ix ? ix.count : p.count); i += 3) {
      a.fromBufferAttribute(p, ix ? ix.getX(i) : i); b.fromBufferAttribute(p, ix ? ix.getX(i + 1) : i + 1); c.fromBufferAttribute(p, ix ? ix.getX(i + 2) : i + 2);
      n.add(b.sub(a).cross(c.sub(a)));
    }
    n.normalize(); if (n.z < 0) n.negate();                     // the face toward the pilot (aft)
    const u = new THREE.Vector3(1, 0, 0).addScaledVector(n, -n.x).normalize(), v = new THREE.Vector3().crossVectors(n, u);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < p.count; i++) { a.fromBufferAttribute(p, i); const x = a.dot(u), y = a.dot(v); u0 = Math.min(u0, x); u1 = Math.max(u1, x); v0 = Math.min(v0, y); v1 = Math.max(v1, y); }
    const uv = new Float32Array(p.count * 2), k = 1 + 2 * inset;
    for (let i = 0; i < p.count; i++) { a.fromBufferAttribute(p, i); uv[i * 2] = ((a.dot(u) - u0) / (u1 - u0) - 0.5) * k + 0.5; uv[i * 2 + 1] = 0.5 - ((a.dot(v) - v0) / (v1 - v0) - 0.5) * k; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    m.material = scr.mat; m.receiveShadow = false; m.renderOrder = 0;
  });
}

/** Keep a set of screens up to date: at most two redrawn a frame, each no more often than it asks, none that would look the same. */
function keeper(screens) {
  let turn = 0;
  return (st, night) => {
    const now = performance.now() / 1000;
    let left = 2;
    for (let k = 0; k < screens.length && left > 0; k++) {
      const s = screens[(turn + k) % screens.length];
      if (now - s.at < s.every) continue;
      const sig = s.sig(st);
      if (sig === s.last) continue;
      s.last = sig; s.at = now; s.draw(s.g, st, s); s.tex.needsUpdate = true; left--;
    }
    turn = (turn + 1) % screens.length;
    const lum = 1.05 - 0.6 * night;                             // dimmed for the dark, as the crew would
    for (const s of screens) if (s.lum !== lum) { s.lum = lum; s.mat.color.setScalar(lum); }
  };
}

/** What the screens read, worked out once a frame from the flight model. */
function state(ac, s, parts, st = {}) {
  st.kt = ac.ias * KT; st.alt = Math.max(0, ac.pos.y * FT); st.vs = s.vs; st.hdg = s.mag; st.pitch = ac.pitch * R2D; st.roll = ac.bank * R2D;
  st.mach = ac.mach; st.g = ac.gLoad; st.agl = Math.max(0, ac.agl * FT); st.n1 = ac.rpm; st.thr = ac.thrustLevel; st.gs = (ac.groundSpeed ?? ac.tas) * KT; st.tas = ac.tas * KT;
  // Fuel as the gauges of the real aircraft would put it (pounds, pounds an hour): the share left of its real tanks, and a
  // flow that follows the thrust and thins with the air (0.38 lb an hour for a pound of thrust, as a turbofan of the kind burns).
  const tanks = variantTanks(ac.spec, parts);
  st.fuel = tanks * (ac.fuel / ac.spec.fuelCap);
  st.ff = ac.fuel > 0 ? (ac.spec.staticThrust / 4.448) * 0.38 * (0.06 + 0.94 * ac.thrustLevel) * Math.exp(-ac.pos.y / 11000) * (1 + 0.9 * (ac.reheat || 0)) : 0;
  st.gear = ac.gear; st.flap = ac.flap; st.t = ac.t + 37800; st.reheat = ac.reheat || 0; st.onGround = ac.onGround; st.oat = 15 - 0.0065 * ac.pos.y;
  // the map pin, where the game has handed one over: its bearing (magnetic) and distance in nautical miles
  const nav = parts.nav;
  if (nav) { const dx = nav.x - ac.pos.x, dz = nav.z - ac.pos.z; st.navBrg = ((Math.atan2(dx, -dz) * R2D - (ac.heading - s.mag)) % 360 + 360) % 360; st.navNm = Math.hypot(dx, dz) / 1852; st.navName = nav.label || 'PIN'; }
  else st.navBrg = null;
  return st;
}

const variantTanks = (spec, parts) => parts.variant?.model?.pit?.fuelLb ?? spec.fuelCap * 2.20462;

const text = (g, str, x, y, px, col, align = 'center', font = FONT, weight = 600) => { g.fillStyle = col; g.font = `${weight} ${px}px ${font}`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(str, x, y); };
const line = (g, x0, y0, x1, y1, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };

// ---------------------------------------------------------------- the 737

const B = { sky: '#1f7fd0', ground: '#7d5320', tape: '#3b3f47', white: '#f2f2f2', green: '#22e04a', magenta: '#f25fe8', cyan: '#35d7f2', amber: '#f2a53a', red: '#f23b30', bg: '#05060a' };

/** Primary flight display: 512 x 512. */
function drawPFD(g, st) {
  const W = 512;
  g.fillStyle = B.bg; g.fillRect(0, 0, W, W);
  // ---- attitude: sky and ground behind a window, turned by the bank and slid by the pitch
  const ax = 232, ay = 232, aw = 122, ah = 118, ppd = 5.4;        // center, half size, pixels a degree of pitch
  g.save();
  g.beginPath(); g.roundRect(ax - aw, ay - ah, 2 * aw, 2 * ah, 16); g.clip();
  g.translate(ax, ay); g.rotate(-st.roll * D2R); g.translate(0, st.pitch * ppd);
  g.fillStyle = B.sky; g.fillRect(-400, -900, 800, 900); g.fillStyle = B.ground; g.fillRect(-400, 0, 800, 900);
  line(g, -400, 0, 400, 0, 2.5, B.white);
  for (let d = -80; d <= 80; d += 2.5) {
    if (!d || Math.abs(d * ppd + st.pitch * ppd) > 150) continue;
    const y = -d * ppd, w = d % 10 === 0 ? 46 : d % 5 === 0 ? 24 : 11;
    line(g, -w, y, w, y, 2, B.white);
    if (d % 10 === 0) { text(g, String(Math.abs(d)), -w - 17, y, 15, B.white); text(g, String(Math.abs(d)), w + 17, y, 15, B.white); }
  }
  g.restore();
  // bank scale and pointer
  g.save(); g.beginPath(); g.roundRect(ax - aw, ay - ah, 2 * aw, 2 * ah, 16); g.clip(); g.translate(ax, ay);
  for (const d of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) { const a = d * D2R, r0 = 100, r1 = Math.abs(d) % 30 === 0 ? 114 : 108; line(g, Math.sin(a) * r0, -Math.cos(a) * r0, Math.sin(a) * r1, -Math.cos(a) * r1, 2, B.white); }
  g.fillStyle = B.white; g.beginPath(); g.moveTo(0, -100); g.lineTo(-8, -114); g.lineTo(8, -114); g.fill();
  g.rotate(-st.roll * D2R); g.strokeStyle = B.white; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -99); g.lineTo(-8, -85); g.lineTo(8, -85); g.closePath(); g.stroke();
  g.restore();
  // the airplane: two wings and a square, black edged in white
  g.fillStyle = '#0a0a0a'; g.strokeStyle = B.white; g.lineWidth = 2;
  for (const s of [-1, 1]) { g.beginPath(); g.moveTo(ax + s * 34, ay - 4); g.lineTo(ax + s * 90, ay - 4); g.lineTo(ax + s * 90, ay + 4); g.lineTo(ax + s * 42, ay + 4); g.lineTo(ax + s * 42, ay + 16); g.lineTo(ax + s * 34, ay + 16); g.closePath(); g.fill(); g.stroke(); }
  g.beginPath(); g.rect(ax - 4, ay - 4, 8, 8); g.fill(); g.stroke();
  if (st.agl < 2500) text(g, String(Math.round(st.agl / (st.agl < 100 ? 2 : 10)) * (st.agl < 100 ? 2 : 10)), ax, ay + ah - 18, 20, B.white, 'center', FONT, 700);

  // ---- speed tape
  const sx = 40, sw = 62, ppk = 2.9;
  g.fillStyle = B.tape; g.fillRect(sx, ay - 150, sw, 300);
  g.save(); g.beginPath(); g.rect(sx, ay - 150, sw, 300); g.clip();
  const k0 = Math.max(30, Math.floor((st.kt - 60) / 10) * 10);
  for (let k = k0; k <= st.kt + 60; k += 10) { const y = ay + (st.kt - k) * ppk; line(g, sx + sw - 12, y, sx + sw, y, 2, B.white); if (k % 20 === 0) text(g, String(k), sx + sw - 18, y, 18, B.white, 'right'); }
  g.restore();
  g.fillStyle = '#000'; g.strokeStyle = B.white; g.lineWidth = 2;
  g.beginPath(); g.moveTo(sx - 4, ay - 19); g.lineTo(sx + sw - 14, ay - 19); g.lineTo(sx + sw - 14, ay - 7); g.lineTo(sx + sw - 4, ay); g.lineTo(sx + sw - 14, ay + 7); g.lineTo(sx + sw - 14, ay + 19); g.lineTo(sx - 4, ay + 19); g.closePath(); g.fill(); g.stroke();
  text(g, String(Math.round(Math.max(st.kt, 30))), sx + sw - 20, ay + 1, 24, B.white, 'right', FONT, 700);
  if (st.mach >= 0.4) text(g, '.' + pad(st.mach * 1000, 3), sx + sw / 2, ay + 168, 20, B.white);
  else text(g, 'GS ' + Math.round(st.gs), sx + sw / 2, ay + 168, 17, B.white);

  // ---- altitude tape
  const tx = 376, tw = 74, ppf = 0.3;
  g.fillStyle = B.tape; g.fillRect(tx, ay - 150, tw, 300);
  g.save(); g.beginPath(); g.rect(tx, ay - 150, tw, 300); g.clip();
  const a0 = Math.floor((st.alt - 600) / 100) * 100;
  for (let a = a0; a <= st.alt + 600; a += 100) {
    const y = ay + (st.alt - a) * ppf;
    line(g, tx, y, tx + 10, y, 2, B.white);
    if (a % 200 === 0) { const th = Math.floor(Math.abs(a) / 1000), hu = pad(Math.abs(a) % 1000, 3); if (th) text(g, (a < 0 ? '-' : '') + th, tx + 38, y, 19, B.white, 'right', FONT, 700); text(g, hu, tx + 70, y, 15, B.white, 'right'); }
  }
  g.restore();
  g.fillStyle = '#000'; g.strokeStyle = B.white; g.lineWidth = 2;
  g.beginPath(); g.moveTo(tx + 4, ay); g.lineTo(tx + 14, ay - 8); g.lineTo(tx + 14, ay - 19); g.lineTo(tx + tw + 14, ay - 19); g.lineTo(tx + tw + 14, ay + 19); g.lineTo(tx + 14, ay + 19); g.lineTo(tx + 14, ay + 8); g.closePath(); g.fill(); g.stroke();
  { const a = Math.round(st.alt / 20) * 20, th = Math.floor(a / 1000); if (th) text(g, String(th), tx + 50, ay + 1, 25, B.white, 'right', FONT, 700); text(g, pad(a % 1000, 3), tx + tw + 10, ay + 2, 19, B.white, 'right', FONT, 700); }
  text(g, '29.92', tx + 26, ay + 168, 18, B.green, 'center'); text(g, 'IN', tx + 66, ay + 169, 14, B.green);

  // ---- vertical speed: a scale that closes up toward its ends, a pointer from the right, the figure when it matters
  const vx = 468, vy = (fpm) => { const a = Math.min(Math.abs(fpm), 6000), d = a <= 1000 ? a * 0.06 : a <= 2000 ? 60 + (a - 1000) * 0.035 : 95 + (a - 2000) * 0.01; return ay - Math.sign(fpm) * d; };
  g.fillStyle = B.tape; g.beginPath(); g.moveTo(vx, ay - 150); g.lineTo(vx + 24, ay - 150); g.lineTo(vx + 40, ay - 96); g.lineTo(vx + 40, ay + 96); g.lineTo(vx + 24, ay + 150); g.lineTo(vx, ay + 150); g.lineTo(vx, ay + 50); g.lineTo(vx + 9, ay + 36); g.lineTo(vx + 9, ay - 36); g.lineTo(vx, ay - 50); g.closePath(); g.fill();
  for (const f of [-6000, -2000, -1000, 1000, 2000, 6000]) { line(g, vx + 14, vy(f), vx + 22, vy(f), 2, B.white); text(g, String(Math.abs(f) / 1000), vx + 7, vy(f), 13, B.white); }
  for (const f of [-500, 500]) line(g, vx + 16, vy(f), vx + 22, vy(f), 1.5, B.white);
  line(g, vx + 12, ay, vx + 22, ay, 2.5, B.white);
  line(g, vx + 44, ay, vx + 14, vy(st.vs), 3, B.white);
  if (Math.abs(st.vs) > 400) text(g, String(Math.round(Math.abs(st.vs) / 50) * 50), vx + 20, st.vs > 0 ? ay - 166 : ay + 166, 16, B.white);

  // ---- heading: the top of a compass rose, track up
  const hy = 640, hr = 190;
  g.save(); g.beginPath(); g.rect(ax - 130, 408, 260, 104); g.clip();
  g.fillStyle = B.tape; g.beginPath(); g.arc(ax, hy, hr, 0, 7); g.fill();
  g.translate(ax, hy);
  for (let d = Math.floor((st.hdg - 40) / 5) * 5; d <= st.hdg + 40; d += 5) {
    const a = (d - st.hdg) * D2R, c = Math.cos(a), s = Math.sin(a), dd = ((d % 360) + 360) % 360;
    line(g, s * hr, -c * hr, s * (hr - (dd % 10 ? 8 : 14)), -c * (hr - (dd % 10 ? 8 : 14)), 2, B.white);
    if (dd % 30 === 0) { g.save(); g.rotate(a); text(g, String(dd / 10), 0, -hr + 28, 20, B.white, 'center', FONT, 700); g.restore(); }
    else if (dd % 10 === 0) { g.save(); g.rotate(a); text(g, String(dd / 10), 0, -hr + 25, 14, B.white); g.restore(); }
  }
  g.restore();
  g.strokeStyle = B.white; g.lineWidth = 2; g.beginPath(); g.moveTo(ax, hy - hr); g.lineTo(ax - 9, hy - hr - 16); g.lineTo(ax + 9, hy - hr - 16); g.closePath(); g.stroke();
  text(g, pad(Math.round(st.hdg) % 360 || 360, 3) + ' MAG', ax - 96, 498, 16, B.green, 'left');

  // ---- flight mode annunciations: three columns above the attitude
  g.strokeStyle = '#8b9099'; g.lineWidth = 1.5; g.strokeRect(ax - aw, 46, 2 * aw, 46);
  line(g, ax - aw / 3, 46, ax - aw / 3, 92, 1.5, '#8b9099'); line(g, ax + aw / 3, 46, ax + aw / 3, 92, 1.5, '#8b9099');
  text(g, st.onGround ? 'TO/GA' : 'MCP SPD', ax - aw * 0.66, 60, 15, B.green); text(g, st.onGround ? 'TO/GA' : 'HDG SEL', ax, 60, 15, B.green); text(g, st.onGround ? 'TO/GA' : 'ALT HOLD', ax + aw * 0.66, 60, 15, B.green);
  text(g, 'FD', ax, 104, 17, B.green, 'center', FONT, 700);
}
const sigPFD = (st) => [Math.round(st.kt * 2), Math.round(st.alt / 4), Math.round(st.vs / 40), Math.round(st.hdg * 4), Math.round(st.pitch * 6), Math.round(st.roll * 3), Math.round(st.mach * 500), st.agl < 2500 ? Math.round(st.agl / 10) : -1, st.onGround].join();

/** Navigation display, the expanded map: a track-up arc of the compass with the airplane at the foot of it. 512 x 512. */
function drawND(g, st) {
  const W = 512, cx = 256, cy = 440, R = 340;
  g.fillStyle = B.bg; g.fillRect(0, 0, W, W);
  text(g, 'GS', 14, 22, 15, B.white, 'left'); text(g, String(Math.round(st.gs)), 42, 22, 20, B.white, 'left', FONT, 700);
  text(g, 'TAS', 96, 22, 15, B.white, 'left'); text(g, String(Math.round(st.tas)), 132, 22, 20, B.white, 'left', FONT, 700);
  g.save(); g.beginPath(); g.rect(0, 62, W, 400); g.clip(); g.translate(cx, cy);
  g.strokeStyle = B.white; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, R, -Math.PI * 0.86, -Math.PI * 0.14); g.stroke();
  for (let d = Math.floor((st.hdg - 45) / 5) * 5; d <= st.hdg + 45; d += 5) {
    const a = (d - st.hdg) * D2R, dd = ((d % 360) + 360) % 360;
    g.save(); g.rotate(a); line(g, 0, -R, 0, -R + (dd % 10 ? 10 : 18), 2, B.white);
    if (dd % 30 === 0) text(g, String(dd / 10), 0, -R + 36, 24, B.white, 'center', FONT, 700); else if (dd % 10 === 0) text(g, String(dd / 10), 0, -R + 32, 17, B.white);
    g.restore();
  }
  // range arcs and the track line
  g.setLineDash([]); g.strokeStyle = '#c8ccd2'; g.lineWidth = 1.5;
  for (const k of [0.5]) { g.beginPath(); g.arc(0, 0, R * k, -Math.PI * 0.86, -Math.PI * 0.14); g.stroke(); }
  line(g, 0, -18, 0, -R + 20, 2, B.white);
  text(g, '20', -16, -R * 0.5 - 12, 15, B.white);
  // the map pin: a waypoint star on its bearing, with the leg to it
  if (st.navBrg !== null) {
    const a = (st.navBrg - st.hdg) * D2R, r = clamp(st.navNm / 40, 0, 1.2) * R;
    const x = Math.sin(a) * r, y = -Math.cos(a) * r;
    g.strokeStyle = B.magenta; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, 0); g.lineTo(x, y); g.stroke();
    g.fillStyle = B.bg; g.beginPath(); for (let i = 0; i < 8; i++) { const q = (i / 8) * 2 * Math.PI, rr = i % 2 ? 4 : 12; g.lineTo(x + Math.sin(q) * rr, y - Math.cos(q) * rr); } g.closePath(); g.fill(); g.stroke();
    text(g, st.navName.slice(0, 6).toUpperCase(), x + 16, y + 2, 16, B.magenta, 'left');
  }
  g.restore();
  // the airplane, the track box, what is selected
  g.strokeStyle = B.white; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx, cy - 18); g.lineTo(cx - 14, cy + 14); g.lineTo(cx + 14, cy + 14); g.closePath(); g.stroke();
  g.fillStyle = B.bg; g.fillRect(cx - 44, 40, 88, 34); g.strokeStyle = B.white; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - 44, 40); g.lineTo(cx - 44, 74); g.lineTo(cx + 44, 74); g.lineTo(cx + 44, 40); g.stroke();
  text(g, pad(Math.round(st.hdg) % 360 || 360, 3), cx, 58, 28, B.white, 'center', FONT, 700);
  text(g, 'TRK', cx - 70, 60, 17, B.green); text(g, 'MAG', cx + 72, 60, 17, B.green);
  g.fillStyle = B.white; g.beginPath(); g.moveTo(cx, cy - R + 2); g.lineTo(cx - 7, cy - R - 12); g.lineTo(cx + 7, cy - R - 12); g.fill();
  if (st.navBrg !== null) { text(g, st.navName.slice(0, 6).toUpperCase(), W - 12, 20, 19, B.magenta, 'right', FONT, 700); text(g, st.navNm.toFixed(st.navNm < 100 ? 1 : 0) + ' NM', W - 12, 44, 17, B.white, 'right'); }
  text(g, 'MAP', 14, W - 18, 15, B.green, 'left');
}
const sigND = (st) => [Math.round(st.hdg * 3), Math.round(st.gs), Math.round(st.tas), st.navBrg === null ? '' : Math.round(st.navBrg * 3) + ':' + Math.round(st.navNm * 10)].join();

/** Engine display: N1 and EGT for the two engines, fuel flow, the fuel in the tanks (pounds). 512 x 512. */
function drawEICAS(g, st) {
  const W = 512;
  g.fillStyle = B.bg; g.fillRect(0, 0, W, W);
  const tat = Math.round(st.oat + 0.9 * (st.tas / KT) ** 2 / 2010);
  text(g, 'TAT', 20, 26, 17, B.cyan, 'left'); text(g, (tat >= 0 ? '+' : '') + tat + 'c', 62, 26, 20, B.white, 'left', FONT, 700);
  text(g, st.onGround ? 'TO' : st.thr > 0.75 ? 'CLB' : 'CRZ', 190, 26, 20, B.green, 'center', FONT, 700);
  const dial = (x, y, r, frac, str, red, label) => {
    const a0 = 0, a1 = 210 * D2R, a = a0 + clamp(frac, 0, 1.08) * (a1 - a0) / 1.08;
    g.fillStyle = '#3a3e45'; g.beginPath(); g.moveTo(x, y); g.arc(x, y, r - 2, a0, a); g.closePath(); g.fill();
    g.strokeStyle = B.white; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, r, a0, a1); g.stroke();
    for (let k = 0; k <= 10; k += 2) { const q = a0 + (k / 10.8) * (a1 - a0); line(g, x + Math.cos(q) * r, y + Math.sin(q) * r, x + Math.cos(q) * (r - 8), y + Math.sin(q) * (r - 8), 2, B.white); }
    const qr = a0 + (red / 1.08) * (a1 - a0); line(g, x + Math.cos(qr) * (r + 9), y + Math.sin(qr) * (r + 9), x + Math.cos(qr) * (r - 2), y + Math.sin(qr) * (r - 2), 4, B.red);
    line(g, x, y, x + Math.cos(a) * r, y + Math.sin(a) * r, 3.5, B.white);
    g.strokeStyle = B.white; g.lineWidth = 2; g.strokeRect(x + 4, y - r - 6, 74, 32); text(g, str, x + 72, y - r + 11, 23, B.white, 'right', FONT, 700);
    if (label) text(g, label, 162, y + 4, 17, B.cyan);
  };
  const n1 = st.n1, egt = st.fuel > 0 ? 370 + 4.6 * n1 + (st.onGround ? 20 : 0) : st.oat;
  dial(86, 118, 58, n1 / 100, n1.toFixed(1), 1.04, 'N1'); dial(238, 118, 58, n1 / 100, n1.toFixed(1), 1.04);
  dial(86, 268, 46, egt / 950, String(Math.round(egt)), 0.98, 'EGT'); dial(238, 268, 46, egt / 950, String(Math.round(egt)), 0.98);
  const ff = (st.ff / 2000).toFixed(2);
  text(g, 'FF', 162, 362, 17, B.cyan); g.strokeStyle = B.white; g.lineWidth = 1.5; g.strokeRect(52, 346, 76, 32); g.strokeRect(204, 346, 76, 32);
  text(g, ff, 122, 363, 22, B.white, 'right', FONT, 700); text(g, ff, 274, 363, 22, B.white, 'right', FONT, 700);
  // fuel: two wing tanks and the center tank, thousands of pounds
  const wing = Math.min(st.fuel / 2, 8600), ctr = Math.max(0, st.fuel - 2 * wing);
  text(g, 'FUEL', 410, 300, 17, B.cyan); text(g, 'LB x 1000', 410, 494, 13, B.cyan);
  const tank = (x, y, v, name) => { g.strokeStyle = B.white; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 34, Math.PI * 0.75, Math.PI * 2.25); g.stroke(); text(g, (v / 1000).toFixed(1), x, y, 22, B.white, 'center', FONT, 700); text(g, name, x, y + 26, 14, B.cyan); };
  tank(410, 350, ctr, 'CTR'); tank(360, 430, wing, '1'); tank(460, 430, wing, '2');
  // gear and flaps, as the crew alerting area would say them
  text(g, st.gear > 0.98 ? 'GEAR DOWN' : st.gear < 0.02 ? '' : 'GEAR', 410, 100, 18, st.gear > 0.98 ? B.green : B.amber, 'center', FONT, 700);
  text(g, 'FLAPS ' + (st.flap < 0.05 ? 'UP' : st.flap < 0.75 ? '15' : '30'), 410, 130, 18, B.green, 'center', FONT, 700);
  text(g, 'TOTAL FUEL', 410, 180, 15, B.cyan); text(g, (st.fuel / 1000).toFixed(1), 410, 206, 22, B.white, 'center', FONT, 700);
}
const sigEICAS = (st) => [Math.round(st.n1 * 5), Math.round(st.ff / 40), Math.round(st.fuel / 100), Math.round(st.gear * 4), Math.round(st.flap * 4), Math.round(st.oat), st.onGround].join();

function screens737(P, variant, parts) {
  const pfd = screen(512, 512, 1 / 24, sigPFD, drawPFD), nd = screen(512, 512, 1 / 12, sigND, drawND), eng = screen(512, 512, 1 / 8, sigEICAS, drawEICAS);
  for (const [name, o] of P.named) {
    if (/PFD\d\/pfdScreen$/.test(name)) mount(o, pfd); else if (/ND\d\/ndScreen/.test(name)) mount(o, nd); else if (/flightdesk\/EICAS\/upperEICASScreen$/.test(name)) mount(o, eng);
    else if (/EICAS2\/upperEICASScreen$/.test(name)) o.traverse((m) => { if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ color: 0x020203, side: THREE.DoubleSide }); });
  }
  const keep = keeper([pfd, nd, eng]), st = {};
  return { update: (ac, dt, time, night, s) => keep(state(ac, s, parts, st), night) };
}

// ---------------------------------------------------------------- the F-16

const F = { green: '#3dfc5a', dim: '#1f9a36', white: '#eef2ee', cyan: '#4fe3f0', bg: '#020403', amber: '#f0c040' };

/** The labels at the twenty buttons round a multifunction display: top, right, bottom, left, five each; `hot` names the one shown in reverse. */
function osb(g, top, right, bottom, left, hot) {
  const W = 512, at = (i) => 96 + i * 80;
  const lab = (s, x, y, align) => {
    if (!s) return;
    if (s === hot) { g.font = `700 21px ${MONO}`; const w = g.measureText(s).width + 10; g.fillStyle = F.white; g.fillRect(align === 'left' ? x - 4 : align === 'right' ? x - w + 4 : x - w / 2, y - 13, w, 26); text(g, s, x, y + 1, 21, '#000', align, MONO, 700); }
    else text(g, s, x, y + 1, 21, F.white, align, MONO, 700);
  };
  top.forEach((s, i) => lab(s, at(i), 20, 'center')); bottom.forEach((s, i) => lab(s, at(i), W - 20, 'center'));
  left.forEach((s, i) => lab(s, 10, at(i), 'left')); right.forEach((s, i) => lab(s, W - 10, at(i), 'right'));
}

/** Left display, the radar format: the scan area with its range and azimuth marks, and the horizon line that shows the attitude. */
function drawFCR(g, st) {
  const W = 512;
  g.fillStyle = F.bg; g.fillRect(0, 0, W, W);
  osb(g, ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL'], ['', '', '', '', ''], ['SWAP', 'FCR', 'HSD', 'SMS', 'DCLT'], ['40', 'A', '6', '3', 'B'], 'FCR');
  g.strokeStyle = F.cyan; g.lineWidth = 1.5;
  for (const k of [0.25, 0.5, 0.75]) { line(g, 70, 60 + 390 * k, 82, 60 + 390 * k, 2, F.cyan); line(g, W - 82, 60 + 390 * k, W - 70, 60 + 390 * k, 2, F.cyan); line(g, 70 + 372 * k, 438, 70 + 372 * k, 450, 2, F.cyan); }
  line(g, 256, 428, 256, 450, 2, F.cyan);
  // horizon line: turns with the bank, rides up and down with the pitch
  g.save(); g.beginPath(); g.rect(64, 52, 384, 400); g.clip(); g.translate(256, 250); g.rotate(-st.roll * D2R); g.translate(0, st.pitch * 3.2);
  line(g, -150, 0, -34, 0, 2.5, F.cyan); line(g, 34, 0, 150, 0, 2.5, F.cyan); line(g, -150, 0, -150, 16, 2.5, F.cyan); line(g, 150, 0, 150, 16, 2.5, F.cyan);
  g.restore();
  // antenna azimuth and elevation carets, the cursor
  const sweep = Math.sin(st.t * 1.3) * 150; g.fillStyle = F.cyan;
  g.beginPath(); g.moveTo(256 + sweep, 452); g.lineTo(256 + sweep - 7, 466); g.lineTo(256 + sweep + 7, 466); g.fill();
  g.beginPath(); g.moveTo(64, 250); g.lineTo(50, 243); g.lineTo(50, 257); g.fill();
  line(g, 246, 150, 246, 176, 2, F.white); line(g, 266, 150, 266, 176, 2, F.white);
  text(g, pad(Math.round(st.kt), 3), 100, 462, 19, F.white, 'left', MONO, 700); text(g, pad(Math.round(st.alt / 100), 3), W - 100, 462, 19, F.white, 'right', MONO, 700);
}
const sigFCR = (st) => [Math.round(st.roll * 2), Math.round(st.pitch * 3), Math.round(st.t * 12), Math.round(st.kt), Math.round(st.alt / 100)].join();

/** Right display, the horizontal situation: range rings about the airplane, north and the cardinal points turning with the heading, the steerpoint. */
function drawHSD(g, st) {
  const W = 512, cx = 256, cy = 330, R = 220;
  g.fillStyle = F.bg; g.fillRect(0, 0, W, W);
  osb(g, ['DEP', 'DCPL', 'NORM', '', 'CNTL'], ['', '', '', '', ''], ['SWAP', 'SMS', 'HSD', '', 'DCLT'], ['30', '', '', 'FZ', ''], 'HSD');
  g.save(); g.beginPath(); g.rect(40, 44, 432, 424); g.clip(); g.translate(cx, cy);
  g.strokeStyle = F.cyan; g.lineWidth = 1.5;
  for (const k of [1 / 3, 2 / 3, 1]) { g.beginPath(); g.arc(0, 0, R * k, 0, 7); g.stroke(); }
  g.rotate(-st.hdg * D2R);
  for (let d = 0; d < 360; d += 30) { g.save(); g.rotate(d * D2R); if (d % 90) line(g, 0, -R * 2 / 3 - 7, 0, -R * 2 / 3 + 7, 2, F.cyan); else if (d) line(g, 0, -R * 2 / 3 - 12, 0, -R * 2 / 3 + 12, 2.5, F.cyan); else { g.fillStyle = F.cyan; g.beginPath(); g.moveTo(0, -R * 2 / 3 - 16); g.lineTo(-8, -R * 2 / 3 + 4); g.lineTo(8, -R * 2 / 3 + 4); g.fill(); } g.restore(); }
  if (st.navBrg !== null) {
    const a = st.navBrg * D2R, r = clamp(st.navNm / 30, 0, 1.3) * R, x = Math.sin(a) * r, y = -Math.cos(a) * r;
    g.setLineDash([]); line(g, 0, 0, x, y, 2, F.white); g.strokeStyle = F.white; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 9, 0, 7); g.stroke();
  }
  g.restore();
  // the airplane
  g.strokeStyle = F.cyan; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx, cy - 16); g.lineTo(cx, cy + 14); g.moveTo(cx - 13, cy); g.lineTo(cx + 13, cy); g.moveTo(cx - 6, cy + 13); g.lineTo(cx + 6, cy + 13); g.stroke();
  text(g, pad(Math.round(st.hdg) % 360 || 360, 3), cx, 60, 22, F.white, 'center', MONO, 700);
  if (st.navBrg !== null) text(g, pad(st.navBrg, 3) + ' ' + pad(Math.min(st.navNm, 999), 3), W - 60, 440, 19, F.white, 'right', MONO, 700);
}
const sigHSD = (st) => [Math.round(st.hdg * 2), st.navBrg === null ? '' : Math.round(st.navBrg) + ':' + Math.round(st.navNm)].join();

/** The electronic horizontal situation indicator under the attitude ball: a compass card turning under a lubber line, the course to the steerpoint. 256 x 256. */
function drawEHSI(g, st) {
  const W = 256, c = W / 2, R = 96;
  g.fillStyle = '#020303'; g.fillRect(0, 0, W, W);
  g.save(); g.translate(c, c + 8); g.rotate(-st.hdg * D2R);
  for (let d = 0; d < 360; d += 5) {
    g.save(); g.rotate(d * D2R); line(g, 0, -R, 0, -R + (d % 10 ? 6 : 11), d % 10 ? 1.5 : 2, F.white);
    if (d % 30 === 0) text(g, d % 90 ? String(d / 10) : 'NESW'[d / 90], 0, -R + 24, d % 90 ? 15 : 17, F.white, 'center', MONO, 700);
    g.restore();
  }
  if (st.navBrg !== null) { g.rotate(st.navBrg * D2R); line(g, 0, R - 34, 0, -R + 34, 2.5, F.amber); g.fillStyle = F.amber; g.beginPath(); g.moveTo(0, -R + 26); g.lineTo(-7, -R + 40); g.lineTo(7, -R + 40); g.fill(); }
  g.restore();
  g.fillStyle = F.white; g.beginPath(); g.moveTo(c, c + 8 - R + 2); g.lineTo(c - 6, c + 8 - R - 10); g.lineTo(c + 6, c + 8 - R - 10); g.fill();
  g.strokeStyle = F.white; g.lineWidth = 2; g.beginPath(); g.moveTo(c, c - 6); g.lineTo(c, c + 24); g.moveTo(c - 13, c + 6); g.lineTo(c + 13, c + 6); g.moveTo(c - 6, c + 22); g.lineTo(c + 6, c + 22); g.stroke();
  text(g, st.navBrg === null ? '--- NM' : pad(Math.min(st.navNm, 999), 3) + ' NM', 6, 14, 14, F.white, 'left', MONO, 700);
  text(g, 'CRS ' + pad(Math.round(st.navBrg ?? st.hdg) % 360 || 360, 3), W - 6, 14, 14, F.white, 'right', MONO, 700);
  text(g, 'NAV', 6, W - 12, 13, F.cyan, 'left', MONO, 700);
}
const sigEHSI = (st) => [Math.round(st.hdg * 2), st.navBrg === null ? '' : Math.round(st.navBrg) + ':' + Math.round(st.navNm)].join();

/** The data entry display: the page the avionics come up with (radios, steerpoint, the time of day). 320 x 128. */
function drawDED(g, st) {
  g.fillStyle = '#060a04'; g.fillRect(0, 0, 320, 128);
  const t = st.t, hh = pad(Math.floor(t / 3600) % 24, 2), mm = pad(Math.floor(t / 60) % 60, 2), ss = pad(Math.floor(t) % 60, 2);
  const rows = [' UHF  305.00   STPT   1', ' VHF  121.50   ' + `${hh}:${mm}:${ss}`, ' M1 3 C 1200   MAN  T75X'];
  rows.forEach((r, i) => text(g, r, 8, 28 + i * 36, 21, '#b8f04a', 'left', MONO, 700));
}
const sigDED = (st) => String(Math.floor(st.t));

// The head-up display's light. A vertex is a direction from the eye (in the mesh's own frame), not a place.
const HUD_VERT = /* glsl */`
uniform float uDist;
varying vec2 vUv; varying vec3 vDir;
void main() {
  vUv = uv;
  vDir = mat3(modelMatrix) * position;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + normalize(vDir) * uDist, 1.0);
}`;
const HUD_FRAG = /* glsl */`
uniform sampler2D map;
uniform vec3 uColor, uO, uU, uV, uN;     // the combiner pane: its middle, its two half-widths (as 1 / length), its normal
uniform float uGain;
varying vec2 vUv; varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float dn = dot(d, uN);
  float t = dot(uO - cameraPosition, uN) / (abs(dn) < 1e-4 ? 1e-4 : dn);
  if (t <= 0.0) discard;
  vec3 q = cameraPosition + d * t - uO;
  vec2 p = abs(vec2(dot(q, uU), dot(q, uV)));
  float a = texture2D(map, vUv).r * (1.0 - smoothstep(0.93, 1.0, p.x)) * (1.0 - smoothstep(0.93, 1.0, p.y));
  if (a < 0.02) discard;
  // Light added to the world behind, which a stroke also holds back a little: over a sunlit cloud it still reads green.
  gl_FragColor = vec4(uColor * (a * uGain), a * 0.82);
}`;

/** The numbers of the head-up display: 20 degrees square, 512 pixels; white on black (the shader gives it its green). */
function drawHUD(g, st) {
  const W = 512, ppd = W / 20, cx = W / 2, y0 = 8 * ppd;                 // the top edge is 8 degrees above the boresight
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  const X = (deg) => cx + deg * ppd, Y = (deg) => y0 - deg * ppd, ink = '#fff';
  // gun cross at the boresight
  line(g, X(-0.5), Y(0), X(-0.15), Y(0), 2, ink); line(g, X(0.15), Y(0), X(0.5), Y(0), 2, ink); line(g, X(0), Y(0.5), X(0), Y(0.15), 2, ink); line(g, X(0), Y(-0.15), X(0), Y(-0.5), 2, ink);
  // airspeed (left) and altitude (right): a moving scale and a boxed figure
  const scale = (x, val, per, step, label, side, fmt) => {
    g.save(); g.beginPath(); g.rect(x - 60, Y(1.2), 120, 5.4 * ppd); g.clip();
    for (let v = Math.floor((val - 2.7 * per) / step) * step; v <= val + 2.7 * per; v += step) {
      if (v < 0) continue;
      const y = Y(-1.5) + ((val - v) / per) * ppd, big = Math.round(v / step) % label === 0;
      line(g, x + side * 16, y, x + side * (big ? 28 : 23), y, 2, ink);
      if (big && Math.abs(y - Y(-1.5)) > 20) text(g, fmt(v), x + side * 34, y + 1, 17, ink, side > 0 ? 'left' : 'right', MONO, 700);
    }
    g.restore();
  };
  scale(X(-4.3), st.kt, 20, 10, 5, 1, (v) => pad(v / 10, 2)); scale(X(4.1), st.alt, 200, 100, 5, -1, (v) => (v / 1000).toFixed(1).replace('.', ','));
  g.strokeStyle = ink; g.lineWidth = 2;
  g.fillStyle = '#000'; g.fillRect(X(-6.3), Y(-1.5) - 14, 58, 28); g.strokeRect(X(-6.3), Y(-1.5) - 14, 58, 28); text(g, String(Math.round(st.kt)), X(-6.3) + 53, Y(-1.5) + 1, 22, ink, 'right', MONO, 700);
  { const a = Math.round(st.alt / 10) * 10; g.fillStyle = '#000'; g.fillRect(X(6.5) - 80, Y(-1.5) - 14, 80, 28); g.strokeRect(X(6.5) - 80, Y(-1.5) - 14, 80, 28); text(g, a >= 1000 ? Math.floor(a / 1000) + ',' + pad(a % 1000, 3) : String(a), X(6.5) - 5, Y(-1.5) + 1, 21, ink, 'right', MONO, 700); }
  // g and Mach, the mode, the height over the ground
  text(g, st.g.toFixed(1), X(-5.6), Y(3.2), 20, ink, 'left', MONO, 700);
  text(g, st.mach.toFixed(2), X(-6.2), Y(-5.4), 19, ink, 'left', MONO, 700);
  text(g, st.gear > 0.5 ? 'ILS' : 'NAV', X(-6.2), Y(-6.4), 19, ink, 'left', MONO, 700);
  text(g, st.reheat > 0.02 ? 'AB' : '', X(-6.2), Y(-7.4), 19, ink, 'left', MONO, 700);
  if (st.agl < 5000) { text(g, 'R ' + Math.round(st.agl / 10) * 10, X(6.4), Y(-5.4), 19, ink, 'right', MONO, 700); }
  if (st.navBrg !== null) text(g, pad(Math.min(st.navNm, 999), 3) + '>01', X(6.4), Y(-6.4), 19, ink, 'right', MONO, 700);
  // heading tape along the bottom
  const hy = Y(-8.3);
  g.save(); g.beginPath(); g.rect(X(-4.6), hy - 34, 9.2 * ppd, 60); g.clip();
  for (let d = Math.floor((st.hdg - 22) / 5) * 5; d <= st.hdg + 22; d += 5) {
    const x = cx + (d - st.hdg) * 5.2, dd = ((d % 360) + 360) % 360;
    line(g, x, hy, x, hy + (dd % 10 ? 7 : 12), 2, ink);
    if (dd % 10 === 0 && Math.abs(x - cx) > 30) text(g, pad(dd / 10, 2), x, hy - 14, 18, ink, 'center', MONO, 700);
  }
  g.restore();
  g.fillStyle = '#000'; g.fillRect(cx - 27, hy - 30, 54, 26); g.strokeRect(cx - 27, hy - 30, 54, 26); text(g, pad(Math.round(st.hdg) % 360 || 360, 3), cx, hy - 16, 20, ink, 'center', MONO, 700);
  line(g, cx, hy + 2, cx, hy + 14, 2.5, ink);
}
const sigHUD = (st) => [Math.round(st.kt), Math.round(st.alt / 10), Math.round(st.hdg * 2), Math.round(st.g * 10), Math.round(st.mach * 100), st.gear > 0.5, st.reheat > 0.02, st.agl < 5000 ? Math.round(st.agl / 10) : -1, st.navBrg === null ? '' : Math.round(st.navNm)].join();

/** The pitch ladder: a strip of the sky from straight down to straight up, 18 degrees wide; bars every five degrees, the horizon across all of it. */
function ladderTexture() {
  const W = 512, H = 4096, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), ppd = H / 180, px = W / 18, cx = W / 2;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  for (let d = -85; d <= 85; d += 5) {
    const y = H / 2 - d * ppd;
    if (!d) { line(g, 0, y, cx - 1.2 * px, y, 2.5, '#fff'); line(g, cx + 1.2 * px, y, W, y, 2.5, '#fff'); continue; }
    g.setLineDash(d < 0 ? [12, 8] : []);
    for (const s of [-1, 1]) {
      line(g, cx + s * 1.3 * px, y, cx + s * 3.9 * px, y, 2.5, '#fff');
      g.setLineDash([]); line(g, cx + s * 3.9 * px, y, cx + s * 3.9 * px, y + (d > 0 ? 9 : -9), 2.5, '#fff'); g.setLineDash(d < 0 ? [12, 8] : []);
      text(g, String(Math.abs(d)), cx + s * 4.7 * px, y + (d > 0 ? 5 : -5), 19, '#fff', 'center', MONO, 700);
    }
  }
  g.setLineDash([]);
  const t = new THREE.CanvasTexture(c); t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.anisotropy = 4; t.flipY = false; t.format = THREE.RedFormat;
  return t;
}
/** The flight path marker: a circle with wings and a fin. */
function markerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 9, 0, 7); g.stroke();
  line(g, 4, 32, 23, 32, 3, '#fff'); line(g, 41, 32, 60, 32, 3, '#fff'); line(g, 32, 23, 32, 11, 3, '#fff');
  const t = new THREE.CanvasTexture(c); t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = false; t.format = THREE.RedFormat;
  return t;
}

const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), vA = new THREE.Vector3(), eA = new THREE.Euler(0, 0, 0, 'YXZ');

function screensF16(P, variant, parts) {
  const fcr = screen(512, 512, 1 / 12, sigFCR, drawFCR), hsd = screen(512, 512, 1 / 8, sigHSD, drawHSD), ded = screen(320, 128, 0.5, sigDED, drawDED);
  const ehsi = screen(256, 256, 1 / 10, sigEHSI, drawEHSI);
  const list = [fcr, hsd, ded, ehsi];
  let glass = null;
  for (const [name, o] of P.named) {
    if (/MFDimage1$/.test(name)) mount(o, fcr); else if (/MFDimage2$/.test(name)) mount(o, hsd); else if (/^DED\/poly\.003$/.test(name)) mount(o, ded); else if (/EHSI-Display$/.test(name)) mount(o, ehsi);
    else if (/HUDImage/.test(name)) glass = o;
  }
  // ---- head-up display, where the cockpit has its combiner glass
  let hud = null;
  if (glass) {
    // the pane: middle, half-widths across and up its slope, normal (in the cockpit's own axes)
    const box = new THREE.Box3().setFromObject(glass), mid = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const up = new THREE.Vector3(0, half.y, half.z), upLen = up.length(); up.normalize();        // (it leans back: its top is nearer the pilot)
    const pane = { o: mid.add(P.group.position), u: new THREE.Vector3(1 / half.x, 0, 0), v: up.clone().multiplyScalar(1 / upLen), n: new THREE.Vector3(0, up.z, -up.y) };
    const uni = { uDist: { value: 2.5 }, uColor: { value: new THREE.Color(0.2, 1.0, 0.32) }, uGain: { value: 1 }, uO: { value: new THREE.Vector3() }, uU: { value: new THREE.Vector3() }, uV: { value: new THREE.Vector3() }, uN: { value: new THREE.Vector3() } };
    const mat = (map) => new THREE.ShaderMaterial({ vertexShader: HUD_VERT, fragmentShader: HUD_FRAG, uniforms: { ...uni, map: { value: map } }, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    // (the pane itself: all but clear, with a breath of its coating's color)
    glass.traverse((m) => { if (m.isMesh) { m.material = new THREE.MeshBasicMaterial({ color: 0x9fc4b0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }); m.renderOrder = 4; } });
    const mesh = (geo, map) => { const m = new THREE.Mesh(geo, mat(map)); m.frustumCulled = false; m.renderOrder = 7; P.group.add(m); return m; };
    // ladder: a strip on the unit sphere, rows of elevation from -90 to 90 degrees, nine degrees to either side
    const pos = [], uv = [], idx = [], N = 72, wd = 9 * D2R;
    for (let i = 0; i <= N; i++) { const e = (-90 + (180 * i) / N) * D2R; for (const s of [-1, 1]) { pos.push(Math.sin(s * wd) * Math.cos(e), Math.sin(e), -Math.cos(s * wd) * Math.cos(e)); uv.push(s < 0 ? 0 : 1, 1 - i / N); } if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2); }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); lg.setIndex(idx);
    const quad = (hw, hh, cy) => { const q = new THREE.BufferGeometry(), t = Math.tan; q.setAttribute('position', new THREE.Float32BufferAttribute([-t(hw), t(cy - hh), -1, t(hw), t(cy - hh), -1, t(hw), t(cy + hh), -1, -t(hw), t(cy + hh), -1], 3)); q.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2)); q.setIndex([0, 1, 2, 0, 2, 3]); return q; };
    const num = screen(512, 512, 1 / 15, sigHUD, drawHUD); num.tex.colorSpace = THREE.NoColorSpace; num.tex.format = THREE.RedFormat; list.push(num);      // (white on black: one channel is all of it)
    hud = { pane, uni, ladder: mesh(lg, ladderTexture()), fpm: mesh(quad(1.25 * D2R, 1.25 * D2R, 0), markerTexture()), num: mesh(quad(10 * D2R, 10 * D2R, -2 * D2R), num.tex) };
  }
  const keep = keeper(list), st = {};
  return {
    update(ac, dt, time, night, s) {
      keep(state(ac, s, parts, st), night);
      if (!hud) return;
      // the pane in the world's axes, for the shader
      const { pane, uni } = hud;
      uni.uO.value.copy(pane.o).applyQuaternion(ac.quat).add(ac.pos); uni.uU.value.copy(pane.u).applyQuaternion(ac.quat); uni.uV.value.copy(pane.v).applyQuaternion(ac.quat); uni.uN.value.copy(pane.n).applyQuaternion(ac.quat);
      uni.uGain.value = 3.4 - 2.6 * night;
      // the ladder stands on the real horizon, along the way the aircraft is going (its heading when it is hardly moving)
      const v = ac.vel, sp = Math.hypot(v.x, v.z);
      const yaw = sp > 15 ? Math.atan2(-v.x, -v.z) : (eA.setFromQuaternion(ac.quat, 'YXZ'), eA.y);
      qA.copy(ac.quat).invert();
      hud.ladder.quaternion.copy(qA).multiply(qB.setFromAxisAngle(vA.set(0, 1, 0), yaw));
      // the marker rides the velocity, kept within the glass
      vA.copy(v); if (vA.lengthSq() < 100) vA.set(0, 0, -1).applyQuaternion(ac.quat); vA.normalize().applyQuaternion(qA);
      const az = clamp(Math.atan2(vA.x, -vA.z), -6.5 * D2R, 6.5 * D2R), el = clamp(Math.asin(clamp(vA.y, -1, 1)), -10.5 * D2R, 6.5 * D2R);
      hud.fpm.quaternion.setFromEuler(eA.set(el, -az, 0, 'YXZ'));
    },
  };
}

export const SCREENS = { b737: screens737, f16: screensF16 };
