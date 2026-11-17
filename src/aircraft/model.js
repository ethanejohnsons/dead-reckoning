// Procedural model of a high-wing, strut-braced piston single on fixed tricycle gear, in the mold of
// the classic Cessna singles. Everything is generated here: lofted fuselage, airfoil wing and tail
// with separate control surfaces, spring-leg gear, glazing, lights, and the canvas textures (livery,
// panel lines, rivets, dirt). The cabin comes from interior.js and the instruments from panel.js.
//
// The airframe is drawn to the 172's lines (span 11.0 m, length 8.3 m) and then stretched into the
// chosen variant by `warp` (variants.js): a 152 loses its rear-seat bay, a 182 grows a longer nose.
// Paint, propeller, wheel fairings, windows and registration come from the variant's `look`.
//
// Body axes: nose down -Z, +Y up, +X right wing; origin at the center of gravity.
// Wheel contact points and extremities match the variant's spec (variants.js).

import * as THREE from 'three';
import { D2R, lerp, clamp01, sstep, lin, BLANK, pchip, loftGrid, sweep, ellipse, prim, merge, rod, foil, foilPts, canvas, rough, normalFromHeight, tex, speckle, FONT, setDefaultRgb } from './kit.js';
import { aircraftById, warp, unwarpZ } from './variants.js';
import { buildInterior, animateInterior } from './interior.js';
import { buildPanel, animatePanel } from './panel.js';

/** Pilot's eye point (left seat) in body coordinates, for the cockpit camera. Set for the variant on build. */
export const PILOT_EYE = new THREE.Vector3(-0.27, 0.42, -0.23);
/** How the pilot's gaze rests: `down` radians below the horizon (onto the instruments here; an aircraft without a panel looks ahead). */
export const PILOT_VIEW = { down: 0.31 };

// Livery of the variant being built (set by buildAircraft): base paint, accent, pinstripe.
let CSS = { white: '#f2f1ec', red: '#b0151b', dark: '#22252b', black: '#141516' };
let WHITE = lin(CSS.white), RED = lin(CSS.red), LINE = lin(CSS.dark), LOOK = null, REG = '';
const BLACK = [0.012, 0.012, 0.013], GRAY = [0.3, 0.31, 0.32];

// Stretch of the variant being built (see variants.js): W moves a finished geometry, Wp a point.
let GEOM = null;
const wv = [];
const Wp = (p) => { warp(GEOM, p[0], p[1], p[2], wv); return [wv[0], wv[1], wv[2]]; };
function W(geo) {
  const g = GEOM;
  if (g.nose === 1 && g.cabin === 1 && g.tail === 1 && g.width === 1 && g.span === 1 && g.gear === 1 && !g.cowl) return geo;
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    warp(g, pos.getX(i), pos.getY(i), pos.getZ(i), wv);
    pos.setXYZ(i, wv[0], wv[1], wv[2]);
    if (nor) { const nx = nor.getX(i) / wv[3], ny = nor.getY(i) / wv[4], nz = nor.getZ(i) / wv[5], l = Math.hypot(nx, ny, nz) || 1; nor.setXYZ(i, nx / l, ny / l, nz / l); }
  }
  pos.needsUpdate = true; geo.boundingBox = null; geo.boundingSphere = null;
  return geo;
}

// ---------------------------------------------------------------- fuselage definition

// z, top, bottom, half-width, height of maximum width, superellipse exponent
const FUS = [
  [-1.92, 0.225, -0.235, 0.36, -0.01, 2.6], [-1.90, 0.255, -0.275, 0.405, -0.01, 2.6], [-1.85, 0.28, -0.315, 0.44, -0.02, 2.6],   // nose bowl
  [-1.73, 0.305, -0.365, 0.468, -0.03, 2.7], [-1.40, 0.34, -0.44, 0.492, -0.04, 2.8], [-1.00, 0.38, -0.52, 0.51, -0.05, 2.9],    // cowl, firewall
  [-0.94, 0.40, -0.53, 0.513, -0.05, 2.9], [-0.78, 0.545, -0.555, 0.52, -0.03, 3.1], [-0.62, 0.69, -0.575, 0.527, -0.01, 3.3],   // windshield
  [-0.47, 0.80, -0.59, 0.532, 0.0, 3.5], [-0.30, 0.86, -0.60, 0.535, 0.0, 3.6], [-0.05, 0.885, -0.60, 0.535, 0.0, 3.6],          // cabin; the roof stays just under the wing skin
  [0.35, 0.87, -0.60, 0.535, 0.0, 3.6], [0.80, 0.815, -0.59, 0.527, 0.0, 3.6], [1.16, 0.765, -0.565, 0.505, 0.0, 3.5],
  [1.60, 0.63, -0.50, 0.465, 0.01, 3.2], [2.00, 0.505, -0.42, 0.42, 0.03, 2.9], [2.40, 0.455, -0.335, 0.37, 0.06, 2.7],          // rear window, tail cone
  [3.20, 0.42, -0.18, 0.28, 0.12, 2.4], [4.20, 0.39, -0.01, 0.18, 0.19, 2.2], [5.00, 0.37, 0.11, 0.105, 0.24, 2.1],
  [5.55, 0.36, 0.19, 0.06, 0.275, 2.0], [5.75, 0.345, 0.225, 0.035, 0.285, 2.0],
];
const Z0 = FUS[0][0], Z1 = FUS[FUS.length - 1][0], FW = -1.0, AFT = 2.1;
const fz = FUS.map((s) => s[0]);
const [fTop, fBot, fWid, fCen, fExp] = [1, 2, 3, 4, 5].map((k) => pchip(fz, FUS.map((s) => s[k])));

const ringCache = new Map();
function fineRing(z) {
  const key = Math.round(z * 1000);
  let r = ringCache.get(key);
  if (r) return r;
  const S = 160, top = fTop(z), bot = fBot(z), w = fWid(z), c = fCen(z), e = 2 / fExp(z);
  const xs = new Float64Array(S + 1), ys = new Float64Array(S + 1), ln = new Float64Array(S + 1);
  for (let k = 0; k <= S; k++) {
    const ph = (k / S) * Math.PI * 2 - Math.PI / 2, cs = Math.cos(ph), sn = Math.sin(ph);
    xs[k] = Math.abs(cs) < 1e-9 ? 0 : w * Math.sign(cs) * Math.pow(Math.abs(cs), e);
    ys[k] = c + (sn >= 0 ? top - c : c - bot) * Math.sign(sn) * Math.pow(Math.abs(sn), e);
    if (k) ln[k] = ln[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
  }
  r = { xs, ys, ln, S, perim: ln[S] };
  ringCache.set(key, r);
  return r;
}
/** Point on the hull at station z, a fraction t of the way round (0 = keel, 0.25 = right, 0.5 = roof). */
function ringPoint(z, t) {
  const r = fineRing(z), target = (((t % 1) + 1) % 1) * r.perim;
  let k = 1; while (k < r.S && r.ln[k] < target) k++;
  const f = (target - r.ln[k - 1]) / Math.max(r.ln[k] - r.ln[k - 1], 1e-9);
  return [lerp(r.xs[k - 1], r.xs[k], f), lerp(r.ys[k - 1], r.ys[k], f), z];
}
/** Texture v of the hull point at station z and height y on one side (+1 right, -1 left). */
function vOf(z, y, side) {
  const r = fineRing(z), half = r.S / 2;
  let k = 1; while (k < half && r.ys[k] < y) k++;
  const f = clamp01((y - r.ys[k - 1]) / Math.max(r.ys[k] - r.ys[k - 1], 1e-9));
  const t = lerp(r.ln[k - 1], r.ln[k], f) / r.perim;
  return side > 0 ? t : 1 - t;
}
/** Hull half-width at station z and height y. */
function hullX(z, y) { const p = ringPoint(z, vOf(z, y, 1)); return p[0]; }


// Paint scheme: red upper cowl flowing into a sweep along the cabin side that climbs into the fin,
// with a dark pinstripe beneath it. Heights are hull y at station z.
const sweepLo = pchip([Z0, -1.0, -0.5, 0.5, 2.0, 3.2, 4.0, 4.6, 5.2, Z1], [0.05, -0.03, -0.10, -0.12, -0.10, -0.03, 0.06, 0.16, 0.25, 0.30]);
const sweepHi = (z) => (z < -0.80 ? 9 : z < -0.55 ? lerp(0.56, 0.14, sstep(-0.80, -0.55, z)) : z < 3.2 ? lerp(0.14, 0.09, sstep(1.2, 3.2, z)) : 0.09 + 0.42 * Math.pow((z - 3.2) / 1.3, 2));
// Each scheme is a set of filled bands between two heights and of thin lines, all along the hull.
function scheme(name) {
  if (name === 'belly') {           // color below a waistline that climbs toward the tail, a bright line above it
    const waist = pchip([Z0, -1.0, 0.3, 2.0, 3.6, 5.0, Z1], [-0.16, -0.19, -0.2, -0.13, 0.0, 0.17, 0.24]);
    return { bands: [{ lo: () => -9, hi: waist, css: CSS.red }], lines: [{ y: (z) => waist(z) + 0.075, css: CSS.dark, w: 9, z1: Z1 }, { y: (z) => waist(z) + 0.125, css: CSS.red, w: 3.5, z1: 5.2 }] };
  }
  if (name === 'twin') {            // a slim band from the cowl cheek rising into the fin, a second color under it, dark belly
    const mid = pchip([Z0, -1.0, 0.3, 2.0, 3.4, 4.4, 5.2, Z1], [0.06, 0.02, -0.02, 0.0, 0.07, 0.19, 0.3, 0.33]);
    const th = (z) => lerp(0.05, 0.13, sstep(Z0, -0.6, z)) * lerp(1, 0.45, sstep(2.6, 5.2, z));
    return { bands: [{ lo: mid, hi: (z) => mid(z) + th(z) + 0.5 * Math.pow(Math.max(0, (z - 4.3) / 1.4), 2), css: CSS.red }, { lo: () => -9, hi: (z) => lerp(-0.4, -0.2, sstep(1.5, 5.2, z)) - 0.4 * sstep(-1.3, -1.9, z), css: CSS.red }], lines: [{ y: (z) => mid(z) - 0.05, css: CSS.dark, w: 10, z1: 5.5 }] };
  }
  return { bands: [{ lo: sweepLo, hi: sweepHi, css: CSS.red }], lines: [{ y: (z) => sweepLo(z) - 0.048, css: CSS.dark, w: 3.4, z1: 5.3 }] };
}

// Glazing, as polygons of {z, y} (hull height) or {z, c} (c = distance in meters from the roof centerline).
const POST = (y) => -0.70 + 0.7 * (y - 0.30);                 // center line of the raked windshield post
const ALL_WINDOWS = [
  [{ z: -0.945, c: 0 }, { z: -0.945, c: 0.36 }, { z: POST(0.30) - 0.036, y: 0.30 }, { z: POST(0.70) - 0.036, y: 0.70 }, { z: -0.50, c: 0 }],   // windshield half
  [{ z: POST(0.20) + 0.036, y: 0.20 }, { z: 0.24, y: 0.20 }, { z: 0.24, y: 0.70 }, { z: POST(0.70) + 0.036, y: 0.70 }],                       // door window
  [{ z: 0.33, y: 0.20 }, { z: 1.13, y: 0.24 }, { z: 1.03, y: 0.68 }, { z: 0.33, y: 0.70 }],                                                    // rear side window
  [{ z: 1.26, c: 0 }, { z: 1.14, y: 0.66 }, { z: 1.23, y: 0.28 }, { z: 1.93, y: 0.36 }, { z: 1.97, c: 0 }],                                   // rear window half
];
let WINDOWS = ALL_WINDOWS;

function fuselageTextures() {
  const W = 2048, H = 1024;
  const [C, g] = canvas(W, H, CSS.white), [Hc, gh] = canvas(W, H, '#808080'), [R, gr] = canvas(W, H, rough(0.29)), [Mk, gm] = canvas(W, H, '#000');
  const X = (z) => ((z - Z0) / (Z1 - Z0)) * W, Y = (z, y, s) => (1 - vOf(z, y, s)) * H;
  const zsteps = (a, b, st = 0.05) => { const o = []; for (let z = a; z < b - 1e-6; z += st) o.push(z); o.push(b); return o; };
  const along = (ctx, yfn, a, b, s) => { ctx.beginPath(); zsteps(a, b).forEach((z, i) => (i ? ctx.lineTo(X(z), Y(z, yfn(z), s)) : ctx.moveTo(X(z), Y(z, yfn(z), s)))); };

  const sch = scheme(LOOK.scheme);
  for (const s of [1, -1]) {
    const zz = zsteps(Z0, Z1, 0.04);
    for (const b of sch.bands) {
      g.beginPath();
      zz.forEach((z, i) => (i ? g.lineTo(X(z), Y(z, b.lo(z), s)) : g.moveTo(X(z), Y(z, b.lo(z), s))));
      zz.slice().reverse().forEach((z) => g.lineTo(X(z), Y(z, b.hi(z), s)));
      g.closePath(); g.fillStyle = b.css; g.fill();
    }
    for (const l of sch.lines) { along(g, l.y, Z0, l.z1, s); g.strokeStyle = l.css; g.lineWidth = l.w; g.stroke(); }
  }

  // the top of the cowl is finished satin rather than gloss, so it does not glare back at the pilot
  const [Cc, gc] = canvas(W / 4, H / 4, '#fff');
  const cowlTop = (ctx) => {
    ctx.beginPath();
    const zz = zsteps(Z0 + 0.02, -0.97, 0.06), half = (z) => (0.36 * Math.min(1, (z - Z0 + 0.06) / 0.2)) / fineRing(z).perim;
    zz.forEach((z, i) => (i ? ctx.lineTo(X(z), (0.5 - half(z)) * H) : ctx.moveTo(X(z), (0.5 - half(z)) * H)));
    zz.slice().reverse().forEach((z) => ctx.lineTo(X(z), (0.5 + half(z)) * H));
    ctx.closePath();
  };
  gr.save(); gr.filter = 'blur(10px)'; cowlTop(gr); gr.fillStyle = rough(0.52); gr.fill(); gr.restore();
  gc.save(); gc.scale(0.25, 0.25); gc.filter = 'blur(12px)'; cowlTop(gc); gc.fillStyle = '#383838'; gc.fill(); gc.restore();

  // lettering, placed a character at a time so it keeps its height as the tail cone tapers;
  // mirrored per side so it reads correctly from outside
  const text = (str, zc, yc, capM, s, font, color) => {
    const ref = 100, em = capM / 0.72, px = W / (Z1 - Z0);
    g.font = `${font} ${ref}px ${FONT}`;
    const adv = [...str].map((ch) => (g.measureText(ch).width / ref) * em), total = adv.reduce((a, b) => a + b, 0);
    let run = 0;
    [...str].forEach((ch, i) => {
      const off = run + adv[i] / 2 - total / 2; run += adv[i];
      const z = zc + (s > 0 ? -off : off), py = H / fineRing(z).perim;
      g.save(); g.translate(X(z), Y(z, yc, s)); g.scale((s > 0 ? -1 : 1) * (px / py), s > 0 ? 1 : -1);
      g.font = `${font} ${em * py}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = color; g.fillText(ch, 0, 0); g.restore();
    });
  };
  for (const s of [1, -1]) text(REG, 2.92, LOOK.scheme === 'belly' ? 0.33 : 0.275, LOOK.scheme === 'belly' ? 0.17 : 0.2, s, 'italic 800', LOOK.scheme === 'twin' ? CSS.red : CSS.black);

  // panel breaks, stringers and rivet rows, on color and height maps
  const seam = (draw, depth = 1) => {
    draw(g); g.setLineDash([]); g.strokeStyle = `rgba(28,32,40,${0.3 * depth})`; g.lineWidth = 1.5; g.stroke();
    draw(gh); gh.setLineDash([]); gh.strokeStyle = depth > 1 ? '#3c3c3c' : '#565656'; gh.lineWidth = 2.6; gh.stroke();
  };
  const rivets = (draw, gap = 9) => {
    draw(g); g.setLineDash([1.6, gap]); g.strokeStyle = 'rgba(40,44,52,0.22)'; g.lineWidth = 1.6; g.stroke(); g.setLineDash([]);
    draw(gh); gh.setLineDash([1.6, gap]); gh.strokeStyle = '#a2a2a2'; gh.lineWidth = 2; gh.stroke(); gh.setLineDash([]);
  };
  const vline = (x) => (ctx) => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); };
  for (const z of [-1.86, FW, 2.12, 2.9, 3.65, 4.35, 4.95, 5.45]) {
    seam(vline(X(z)), z === FW ? 2 : 1);
    if (z > FW) { rivets(vline(X(z) - 5)); rivets(vline(X(z) + 5)); }
  }
  for (const s of [1, -1]) {
    seam((ctx) => along(ctx, () => -0.07, -1.86, FW, s), 2);                                   // cowl split line
    rivets((ctx) => along(ctx, () => -0.045, -1.84, FW - 0.02, s), 22);
    rivets((ctx) => along(ctx, () => -0.4, -1.8, FW - 0.02, s), 14);
    for (const y of [-0.5, -0.33]) rivets((ctx) => along(ctx, () => y, FW + 0.05, 1.9, s));
    for (const y of [-0.2, 0.05, 0.3]) rivets((ctx) => along(ctx, (z) => y + (z - 2.1) * 0.075, 2.15, 5.5, s));
    seam((ctx) => along(ctx, () => -0.52, FW, 1.3, s));
    // cabin door each side, baggage door on the left
    const door = (pts, d = 2) => seam((ctx) => { ctx.beginPath(); pts.forEach(([z, y], i) => (i ? ctx.lineTo(X(z), Y(z, y, s)) : ctx.moveTo(X(z), Y(z, y, s)))); ctx.closePath(); ctx.lineJoin = 'round'; }, d);
    const dp = [[-0.80, -0.50], [-0.80, 0.12]];
    for (let y = 0.15; y <= 0.751; y += 0.05) dp.push([POST(y) - 0.01, y]);
    dp.push([0.285, 0.75], [0.285, -0.50]);
    door(dp);
    if (s < 0) door([[1.3, -0.3], [1.86, -0.24], [1.86, 0.2], [1.3, 0.2]], 1.5);
    g.fillStyle = '#2a2c30'; g.fillRect(X(0.14), Y(0.14, 0.02, s) - 3, 30, 6);                  // door handle
    gh.fillStyle = '#b8b8b8'; gh.fillRect(X(0.14), Y(0.14, 0.02, s) - 3, 30, 6);
    for (const z of [-0.74, 0.22]) { g.fillStyle = 'rgba(30,32,36,0.8)'; g.fillRect(X(z) - 5, Y(z, -0.38, s) - 5, 10, 10); }   // hinges
    // static port and fuel drain stencils
    g.fillStyle = '#3a3c40'; g.beginPath(); g.arc(X(-0.9), Y(-0.9, -0.2, s), 4, 0, 7); g.fill();
  }

  // weathering: a little exhaust soot under the nose, belly streaks, general variation
  for (const ctx of [g, gr]) {
    ctx.save(); ctx.filter = 'blur(8px)';
    const x0 = X(-1.25), x1 = X(0.9), grad = ctx.createLinearGradient(x0, 0, x1, 0);
    if (ctx === g) { grad.addColorStop(0, 'rgba(26,20,14,0.5)'); grad.addColorStop(0.4, 'rgba(36,28,20,0.2)'); grad.addColorStop(1, 'rgba(40,32,24,0)'); }
    else { grad.addColorStop(0, 'rgba(0,215,0,0.8)'); grad.addColorStop(1, 'rgba(0,200,0,0)'); }
    ctx.strokeStyle = grad; ctx.lineWidth = 26; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, H - 46); ctx.lineTo(x1, H - 22); ctx.stroke();
    ctx.restore();
  }
  g.save(); g.filter = 'blur(5px)';
  const rnd = speckle(g, W, H, 0);
  for (let i = 0; i < 60; i++) {
    const x = X(-1.6 + rnd() * 6.5), top = rnd() < 0.5, y = top ? rnd() * 50 : H - rnd() * 50, len = 40 + rnd() * 220;
    g.strokeStyle = `rgba(52,44,36,${0.03 + rnd() * 0.08})`; g.lineWidth = 3 + rnd() * 9; g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (rnd() - 0.5) * 8); g.stroke();
  }
  g.restore();
  speckle(g, W, H, 1800, 3);
  { const r2 = speckle(gr, W, H, 0, 7); gr.save(); gr.filter = 'blur(18px)'; for (let i = 0; i < 140; i++) { gr.fillStyle = rough(0.22 + r2() * 0.2); gr.globalAlpha = 0.35; gr.beginPath(); gr.ellipse(r2() * W, r2() * H, 30 + r2() * 90, 14 + r2() * 30, 0, 0, 7); gr.fill(); } gr.restore(); }

  // glazing: rubber seals on the paint first, then cut every opening; the same shapes make the glass mask
  const delta = (z, c) => c / fineRing(z).perim, paths = [];
  for (const s of [1, -1]) for (const poly of WINDOWS) {
    const P = (p) => [X(p.z), p.c !== undefined ? (1 - (s > 0 ? 0.5 - delta(p.z, p.c) : 0.5 + delta(p.z, p.c))) * H : Y(p.z, p.y, s)];
    const pts = [];
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length];
      if (a.y !== undefined && b.y !== undefined) for (let k = 0; k < 16; k++) pts.push(P({ z: lerp(a.z, b.z, k / 16), y: lerp(a.y, b.y, k / 16) })); else pts.push(P(a));
    });
    paths.push((ctx) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.lineJoin = 'round'; });
  }
  for (const path of paths) {
    path(g); g.strokeStyle = '#17181a'; g.lineWidth = 16; g.stroke();
    path(gr); gr.strokeStyle = rough(0.7); gr.lineWidth = 16; gr.stroke();
    path(gh); gh.strokeStyle = '#989898'; gh.lineWidth = 16; gh.stroke();
  }
  for (const path of paths) {
    g.save(); g.globalCompositeOperation = 'destination-out'; path(g); g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineWidth = 8; g.fill(); g.stroke(); g.restore();
    path(gm); gm.fillStyle = '#fff'; gm.strokeStyle = '#fff'; gm.lineWidth = 8; gm.fill(); gm.stroke();
  }
  const [Pm, gp] = canvas(W, H, '#fff');
  gp.globalCompositeOperation = 'difference'; gp.drawImage(Mk, 0, 0);
  return { map: tex(C, true, true), normal: tex(normalFromHeight(Hc, 2.2), false, true), rough: tex(R, false, true), coat: tex(Cc, false, true), glassMask: tex(Mk, false, true), paintMask: tex(Pm, false, true) };
}

/** Shared airframe texture: three chordwise bands (lower left with the registration, lower right, upper). */
function airframeTextures() {
  const W = 2048, H = 1024;
  const [C, g] = canvas(W, H, CSS.white), [Hc, gh] = canvas(W, H, '#808080'), [R, gr] = canvas(W, H, rough(0.29));
  const yOf = (band, xc) => H * (1 - (band + 0.01 + 0.98 * xc) / 3), U = (u) => u * W;
  const rnd = speckle(g, W, H, 1800, 11);
  for (let band = 0; band < 3; band++) {
    const line = (ctx, x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); };
    const both = (x0, y0, x1, y1, dash) => {
      line(g, x0, y0, x1, y1); g.setLineDash(dash || []); g.strokeStyle = dash ? 'rgba(40,44,52,0.13)' : 'rgba(28,32,40,0.18)'; g.lineWidth = 1.4; g.stroke(); g.setLineDash([]);
      line(gh, x0, y0, x1, y1); gh.setLineDash(dash || []); gh.strokeStyle = dash ? '#a4a4a4' : '#565656'; gh.lineWidth = dash ? 2 : 2.6; gh.stroke(); gh.setLineDash([]);
    };
    // spars and stringers along the span, ribs across the chord
    for (const xc of [0.12, 0.3, 0.52]) { both(U(0.02), yOf(band, xc), U(0.96), yOf(band, xc)); both(U(0.02), yOf(band, xc) - 5, U(0.96), yOf(band, xc) - 5, [1.6, 9]); both(U(0.02), yOf(band, xc) + 5, U(0.96), yOf(band, xc) + 5, [1.6, 9]); }
    for (let u = 0.0545; u < 0.96; u += 0.0545) { both(U(u), yOf(band, 0.05), U(u), yOf(band, 0.99)); both(U(u) + 5, yOf(band, 0.05), U(u) + 5, yOf(band, 0.99), [1.6, 10]); }
    // chordwise streaks, heavier underneath
    g.save(); g.filter = 'blur(3px)';
    for (let i = 0; i < (band === 2 ? 30 : 80); i++) { const x = U(0.03 + rnd() * 0.93), a = 0.1 + rnd() * 0.5; g.strokeStyle = `rgba(60,52,44,${0.025 + rnd() * (band === 2 ? 0.04 : 0.07)})`; g.lineWidth = 2 + rnd() * 6; line(g, x, yOf(band, a), x + (rnd() - 0.5) * 6, yOf(band, Math.min(0.99, a + 0.2 + rnd() * 0.5))); g.stroke(); }
    g.restore();
  }
  // upper surface: fuel filler cap and its placard ring
  g.lineWidth = 3; g.strokeStyle = CSS.red; g.beginPath(); g.arc(U(0.3), yOf(2, 0.3), 10, 0, 7); g.stroke();
  g.fillStyle = '#3a3c40'; g.beginPath(); g.arc(U(0.3), yOf(2, 0.3), 6.5, 0, 7); g.fill();
  gh.fillStyle = '#b0b0b0'; gh.beginPath(); gh.arc(U(0.3), yOf(2, 0.3), 6.5, 0, 7); gh.fill();
  // registration under the left wing, read from below with the leading edge at the top
  g.save(); g.translate(U(0.6), yOf(0, 0.36)); g.scale(1.78, -1); g.font = `800 132px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = CSS.black; g.fillText(REG, 0, 0); g.restore();
  // clean patch for small parts
  for (const [ctx, style] of [[g, CSS.white], [gh, '#808080'], [gr, rough(0.32)]]) { ctx.fillStyle = style; ctx.fillRect(W * 0.972, 0, W * 0.028, H * 0.028); }
  return { map: tex(C, true), normal: tex(normalFromHeight(Hc, 2.2), false), rough: tex(R, false) };
}

function glowTexture() {
  const [c, g] = canvas(64, 64), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Motion-blurred propeller disk: faint smear, darker toward the hub, pale tip ring. */
function propDiskTexture(blades) {
  const S = 256, [c, g] = canvas(S, S), img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x - S / 2 + 0.5) / (S / 2), dy = (y - S / 2 + 0.5) / (S / 2), r = Math.hypot(dx, dy), a = Math.atan2(dy, dx), o = (y * S + x) * 4;
    let al = 0.2 * sstep(0.15, 0.24, r) * (1 - 0.6 * r) * (0.62 + 0.38 * Math.cos(blades * a)) * (1 - sstep(0.955, 0.985, r));
    let cr = 24, cg = 24, cb = 26;
    const tip = sstep(0.9, 0.915, r) * (1 - sstep(0.94, 0.955, r));
    if (tip > 0) { cr = lerp(cr, 225, tip); cg = lerp(cg, 222, tip); cb = lerp(cb, 214, tip); al += 0.03 * tip; }
    d[o] = cr; d[o + 1] = cg; d[o + 2] = cb; d[o + 3] = al * 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- flying surfaces

const SPAN2 = 5.5;                                 // half span
const HF = 0.7;                                    // flap and aileron hinge, fraction of chord
// Wing: constant chord out to the strut, tapered beyond it; 1.7 degrees of dihedral, 3 of washout.
const wingSt = (ax) => { const k = clamp01((ax - 2.55) / 2.95); return { chord: lerp(1.63, 1.13, k), zLE: -0.47 + 0.15 * k, y: 0.80 + 0.0302 * Math.max(0, ax - 0.5), t: 0.12, inc: (1.5 - 3 * clamp01(ax / SPAN2)) * D2R, m: 0.02 }; };
const stabSt = (ax) => { const chord = lerp(1.2, 0.72, clamp01(ax / 1.725)); return { chord, zLE: 5.92 - chord, y: 0.30, t: 0.09, inc: 0, m: 0 }; };
const FIN_Y0 = 0.34, FIN_Y1 = 1.52;
const finSt = (y) => { const k = clamp01((y - FIN_Y0) / (FIN_Y1 - FIN_Y0)), zLE = lerp(4.40, 5.40, k), zTE = lerp(5.86, 6.04, k), zH = lerp(5.50, 5.79, k); return { chord: zTE - zLE, zLE, hr: (zH - zLE) / (zTE - zLE), t: lerp(0.085, 0.08, k), m: 0 }; };
const HE = 0.58;

/** Wingtip positions in body coordinates (for vapor trails). Moved to the variant's tips on build; parts.wingtips is the same pair. */
export const WINGTIPS = [new THREE.Vector3(-5.46, 0.99, 0.42), new THREE.Vector3(5.46, 0.99, 0.42)];

/** Place a section point on a horizontal surface: spanwise x, chord fraction xc, height yc (chords). */
function surfPt(st, x, xc, yc) {
  const dx = xc - 0.25, ca = Math.cos(st.inc), sa = Math.sin(st.inc);
  return [x, st.y + st.chord * (-dx * sa + yc * ca), st.zLE + st.chord * (0.25 + dx * ca + yc * sa)];
}
/** Loft a horizontal surface through spanwise stations: x, or [x, chord scale, thickness scale, lift]. */
function surfLoft(xs, stFn, spec, o) {
  const rings = xs.map((x) => {
    const X = Array.isArray(x) ? x : [x, 1, 1, 0], st = stFn(Math.abs(X[0]));
    return foilPts(st.t, st.m, spec.xa, spec.xb, spec.n || 12, spec.nose).map(([xc, yc, up]) => { const p = surfPt(st, X[0], 0.5 + (xc - 0.5) * X[1], yc * X[2]); p[1] += X[3] || 0; p.push(xc, up); return p; });
  });
  return loftGrid(rings, o);
}
/** Extra stations that round off a tip beyond span position x0. */
const tipRound = (x0, len, sg) => [1, 2, 3, 4, 5, 6].map((k) => { const f = (k / 6) * Math.PI / 2, s = Math.max(Math.cos(f), 0.05); return [sg * (x0 + len * Math.sin(f)), 0.7 + 0.3 * s, s, 0]; });

const X_AXIS = new THREE.Vector3(1, 0, 0), Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Mount a surface on a hinge line a->b: returns the group to rotate about its local axis. */
function hinged(parent, geo, a, b, mat, axis = X_AXIS) {
  W(geo); a = Wp(a); b = Wp(b);
  const pivot = new THREE.Group(), inner = new THREE.Group();
  pivot.position.set(...a);
  pivot.quaternion.setFromUnitVectors(axis, new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
  pivot.updateMatrix();
  geo.applyMatrix4(pivot.matrix.clone().invert());
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  inner.add(mesh); pivot.add(inner); parent.add(pivot);
  return inner;
}

/** Streamlined wheel fairing: a teardrop with a flat underside that the tire pokes through. */
function pantGeo(cx, cy, cz, R, L, wd, rgbFn) {
  const N = 16, K = 18, rings = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, z = cz + (t - 0.4) * L;
    const f = Math.max(t < 0.4 ? Math.sqrt(1 - ((0.4 - t) / 0.4) ** 2) : Math.pow(Math.cos(((t - 0.4) / 0.6) * Math.PI / 2), 0.8), 0.03);
    const w = wd * f, up = (R + 0.055) * f, dn = (R - 0.085) * Math.min(1, f * 1.25), yc = cy + 0.05 * sstep(0.45, 1, t);
    rings.push(Array.from({ length: K }, (_, j) => {
      const a = (j / K) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a), e = s >= 0 ? 2 / 2.3 : 2 / 4;
      return [cx + w * Math.sign(c) * Math.pow(Math.abs(c), e), yc + (s >= 0 ? up : dn) * Math.sign(s) * Math.pow(Math.abs(s), e), z];
    }));
  }
  return loftGrid(rings, { closed: true, capStart: true, capEnd: true, uv: () => BLANK, color: rgbFn });
}

// ---------------------------------------------------------------- window frames

/**
 * Trim frames around every window: a molded surround standing proud of the cabin lining, and the reveal
 * that joins it to the outer skin, so posts and sills have thickness from inside and out.
 * Built in the 172's coordinates; the caller stretches it.
 */
function windowFrames(trimRgb) {
  const SEAL = [0.012, 0.012, 0.013], geos = [];
  // cross-section: [distance out from the opening's edge along the wall, depth in from the outer skin, color]
  const prof = [[0.004, -0.004, SEAL], [0.007, 0.012, SEAL], [0.008, 0.03, trimRgb], [0.012, 0.04, trimRgb], [0.022, 0.044, trimRgb], [0.046, 0.04, trimRgb], [0.058, 0.028, trimRgb]];
  const at = (z, m, depth) => {
    const zc = Math.max(Z0 + 0.02, Math.min(Z1 - 0.02, z)), per = fineRing(zc).perim, t = m / per, e = 0.004;
    const p = ringPoint(zc, t), a = ringPoint(zc, t + e / per), b = ringPoint(zc + e, (m / fineRing(zc + e).perim));
    // inward normal: across the ring tangent and the fore-and-aft tangent, pointed at the cabin axis
    const tx = a[0] - p[0], ty = a[1] - p[1], ux = b[0] - p[0], uy = b[1] - p[1], uz = e;
    let nx = ty * uz, ny = -tx * uz, nz = tx * uy - ty * ux; const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nx * p[0] + ny * (p[1] - 0.2) > 0) { nx = -nx; ny = -ny; nz = -nz; }
    return [p[0] + nx * depth, p[1] + ny * depth, zc + nz * depth];
  };
  for (const s of [1, -1]) for (const poly of WINDOWS) {
    // the opening's edge in (station, meters around the hull), sampled as the paint mask draws it
    const M = (p) => { const per = fineRing(p.z).perim; return [p.z, (p.c !== undefined ? (s > 0 ? 0.5 - p.c / per : 0.5 + p.c / per) : vOf(p.z, p.y, s)) * per]; };
    const pts = [], open = [];
    poly.forEach((a, i) => {
      const b = poly[(i + 1) % poly.length], center = a.c === 0 && b.c === 0;
      if (center) { open.push(pts.length); pts.push(M(a)); return; }
      const n = a.y !== undefined && b.y !== undefined ? 10 : 6;
      for (let k = 0; k < n; k++) pts.push(a.y !== undefined && b.y !== undefined ? M({ z: lerp(a.z, b.z, k / n), y: lerp(a.y, b.y, k / n) }) : (() => { const A = M(a), B = M(b); return [lerp(A[0], B[0], k / n), lerp(A[1], B[1], k / n)]; })());
    });
    // start the chain after the centerline edge, if there is one, so it runs open from end to end
    const N = pts.length, start = open.length ? (open[0] + 1) % N : 0, chain = Array.from({ length: N }, (_, k) => pts[(start + k) % N]);
    let area = 0; for (let i = 0; i < N; i++) { const a = chain[i], b = chain[(i + 1) % N]; area += a[0] * b[1] - b[0] * a[1]; }
    const sg = area > 0 ? 1 : -1, closed = !open.length;
    const nrm = chain.map((p, i) => {
      const a = chain[closed ? (i + N - 1) % N : Math.max(i - 1, 0)], b = chain[closed ? (i + 1) % N : Math.min(i + 1, N - 1)];
      const dz = b[0] - a[0], dm = b[1] - a[1], l = Math.hypot(dz, dm) || 1;
      return [(sg * dm) / l, (-sg * dz) / l];                    // outward from the opening
    });
    const rows = prof.map(([d, depth, rgb]) => chain.map((p, i) => { const q = at(p[0] + nrm[i][0] * d, p[1] + nrm[i][1] * d, depth); q.push(...rgb); return q; }));
    geos.push(loftGrid(rows, { closed, uv: (p, i, j) => [j * 0.06, i * 0.12], color: (p) => [p[3], p[4], p[5]] }));
  }
  return merge(geos);
}

// ---------------------------------------------------------------- build

const TIP0 = [[-5.46, 0.99, 0.42], [5.46, 0.99, 0.42]];

/**
 * Build one variant (an id from variants.js, or the variant itself).
 * Returns { root, parts, variant }. parts.body is what only outside views draw (glazing, the pilot's head),
 * parts.pit what only the pilot's own view draws; parts.glass, parts.wingtips, parts.exhaust and
 * parts.gearHeight are what the weather and post-processing follow. Free it with disposeAircraft.
 */
export function buildAircraft(variant) {
  const v = !variant || typeof variant === 'string' ? aircraftById(variant) : variant;
  LOOK = v.look; GEOM = v.geom; REG = v.reg;
  CSS = { white: LOOK.base, red: LOOK.accent, dark: LOOK.line, black: '#141516' };
  WHITE = lin(CSS.white); RED = lin(CSS.red); LINE = lin(CSS.dark); setDefaultRgb(WHITE);
  WINDOWS = LOOK.rearWindow ? ALL_WINDOWS : ALL_WINDOWS.filter((_, i) => i !== 2);

  const root = new THREE.Group(), body = new THREE.Group(), pit = new THREE.Group();
  root.add(body, pit); pit.visible = false;
  const parts = { body, pit };
  const ft = fuselageTextures(), at = airframeTextures();

  const paint = { roughness: 1, metalness: 0.03, clearcoat: 0.75, clearcoatRoughness: 0.1, envMapIntensity: 0.8, normalScale: new THREE.Vector2(0.5, 0.5) };
  const matSkin = new THREE.MeshPhysicalMaterial({ ...paint, map: ft.map, normalMap: ft.normal, roughnessMap: ft.rough, clearcoatMap: ft.coat, alphaTest: 0.5, alphaToCoverage: true });
  const matAir = new THREE.MeshPhysicalMaterial({ ...paint, map: at.map, normalMap: at.normal, roughnessMap: at.rough, vertexColors: true });
  const matGlass = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.52, 0.6, 0.63), metalness: 1, roughness: 0.035, transparent: true, opacity: 0.3, alphaMap: ft.glassMask, alphaTest: 0.16, depthWrite: false, envMapIntensity: 1.25 });
  const matIn = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, envMapIntensity: 0.25 });
  const matMetal = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.85, roughness: 0.36, envMapIntensity: 0.9 });
  const matSpin = LOOK.spinner < 1
    ? new THREE.MeshPhysicalMaterial({ color: new THREE.Color(...WHITE), roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.8 })
    : new THREE.MeshStandardMaterial({ color: new THREE.Color(0.86, 0.87, 0.89), metalness: 1, roughness: 0.12, envMapIntensity: 1.1 });
  const matTire = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.4 });
  const matBlade = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, envMapIntensity: 0.6 });
  parts.paint = [matSkin, matAir];
  const shadow = (m, cast = true, recv = true) => { m.castShadow = cast; m.receiveShadow = recv; return m; };
  const mesh = (parent, geo, mat, cast, recv) => { const m = shadow(new THREE.Mesh(geo, mat), cast, recv); parent.add(m); return m; };

  // ---- fuselage: one lofted hull, split into cowl and cabin so the cowl stays in view from the cockpit
  const zs = [...fz];
  for (let z = Z0 + 0.07; z < Z1; z += 0.07) if (!fz.some((s) => Math.abs(s - z) < 0.03)) zs.push(z);
  zs.sort((a, b) => a - b);
  const K = 72, hullPts = zs.map((z) => Array.from({ length: K }, (_, j) => ringPoint(z, j / K)));
  const hull = loftGrid(hullPts, { closed: true, capStart: true, capEnd: true, capUv: [0.002, 0.004], uv: (p, i, j) => [(zs[i] - Z0) / (Z1 - Z0), j / K] });
  const row = (z) => zs.findIndex((s) => s >= z - 1e-6), iF = row(FW), iA = row(AFT), rs = hull.userData.rowStride, caps = hull.userData.caps;
  // inner lining, a few centimeters inside the skin, open at the same windows (handed to the cabin builder)
  const hn = hull.attributes.normal, C = hull.userData.cols;
  const linerPts = zs.slice(iF, iA + 1).map((z, r) => hullPts[iF + r].map((p, j) => { const k = (iF + r) * C + j; return [p[0] - hn.getX(k) * 0.03, p[1] - hn.getY(k) * 0.03, z]; }));
  const linerGeo = W(loftGrid(linerPts, { closed: true, flip: true, capStart: true, capEnd: true, capUv: [0.5, 0.004], uv: (p, i, j) => [(zs[iF + i] - Z0) / (Z1 - Z0), j / K] }));
  W(hull);
  const sub = (ranges) => {
    const g = new THREE.BufferGeometry(), src = hull.index.array, out = [];
    for (const k of Object.keys(hull.attributes)) g.setAttribute(k, hull.attributes[k]);
    for (const [a, n] of ranges) for (let i = a; i < a + n; i++) out.push(src[i]);
    g.setIndex(out); g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  };
  mesh(root, sub([[0, iF * rs], caps.start]), matSkin);
  const cabin = new THREE.Group(); root.add(cabin);
  mesh(cabin, sub([[iF * rs, (zs.length - 1 - iF) * rs], caps.end]), matSkin);
  const glass = mesh(body, sub([[iF * rs, (row(2.05) - iF) * rs]]), matGlass, false, false);
  glass.renderOrder = 3; parts.glass = glass;          // the post stack draws rain and frost in this surface's own coordinates
  hull.dispose();

  // firewall: seals the cabin from the hollow cowl
  { const ring = hullPts[iF], cy = fCen(FW); mesh(cabin, W(loftGrid([ring, ring.map((p) => [p[0] * 0.01, cy + (p[1] - cy) * 0.01, p[2]])], { closed: true, out: [0, 0, 1], rgb: [0.02, 0.02, 0.022], uv: () => BLANK })), matIn, false, false); }

  // ---- wing, stabilizer and fin
  const air = [];                                             // static painted parts, merged into one mesh
  const e = 0.002, TIPX = 5.14, sch = LOOK.scheme;
  const wcol = (p) => (Math.abs(p[0]) > TIPX ? RED : WHITE);
  const wingUv = (lowBand) => (p) => [Math.min(Math.abs(p[0]) / SPAN2, 1), ((p[4] > 0.5 ? 2 : lowBand) + 0.01 + 0.98 * p[3]) / 3];
  const tailUv = (len) => (p) => [0.2 + (0.4 * Math.abs(p[0])) / len, (1.01 + 0.98 * p[3]) / 3];
  // center section across the cabin roof
  air.push(surfLoft([-0.6, 0, 0.6], wingSt, { xa: 0, xb: 1, n: 14 }, { uv: wingUv(1), capStart: true, capEnd: true }));
  const surfaces = {};
  for (const sg of [1, -1]) {
    const lb = sg > 0 ? 1 : 0, uvw = wingUv(lb);
    const xs = [0.6, 1.25, 1.9, 2.55, 3.3, 4.2, TIPX - e, TIPX + e, 5.3].map((x) => sg * x);
    air.push(surfLoft(xs, wingSt, { xa: 0, xb: HF, n: 14 }, { uv: uvw, color: wcol }));
    // rear spar web behind the flaps and ailerons
    air.push(loftGrid(xs.map((x) => { const st = wingSt(Math.abs(x)), [u, l] = foil(HF, st.t, st.m); return [surfPt(st, x, HF, u), surfPt(st, x, HF, l)]; }), { out: [0, 0, 1], rgb: GRAY, uv: () => BLANK }));
    // squared tip, turned up a little
    air.push(surfLoft([[5.3, 1, 1, 0], [5.37, 0.996, 0.92, 0.01], [5.43, 0.988, 0.72, 0.03], [5.47, 0.975, 0.45, 0.052], [5.5, 0.96, 0.16, 0.068]].map(([x, ...r]) => [sg * x, ...r]), wingSt, { xa: 0, xb: 1, n: 14 }, { uv: uvw, color: () => RED, capStart: true, capEnd: true }));
    // flap (slotted: hinge below the wing so it moves aft as it lowers) and aileron
    const mk = (name, stn, hingeY, wicks) => {
      const geos = [surfLoft(stn.map((x) => sg * x), wingSt, { xa: HF, xb: 1, n: 7, nose: 0.035 }, { uv: uvw, color: wcol, capStart: true, capEnd: true })];
      for (const x of wicks) { const st = wingSt(x), p = surfPt(st, sg * x, 1, 0); geos.push(rod(p, [p[0], p[1], p[2] + 0.13], 0.005, BLACK, 5)); }
      const hp = (x) => { const st = wingSt(x), [u, l] = foil(HF, st.t, st.m); return surfPt(st, sg * x, HF + (hingeY ? 0.03 : 0), hingeY ? l - 0.04 : (u + l) / 2); };
      const a = stn[0], b = stn[stn.length - 1];
      surfaces[name] = hinged(root, merge(geos), sg > 0 ? hp(a) : hp(b), sg > 0 ? hp(b) : hp(a), matAir);
    };
    mk(sg > 0 ? 'flapR' : 'flapL', [0.62, 1.25, 1.9, 2.5], true, []);
    mk(sg > 0 ? 'ailR' : 'ailL', [2.58, 3.3, 4.2, TIPX - e, TIPX + e, 5.25], false, [3.1, 4.0, 4.8]);
    // flap track fairings
    for (const x of [0.95, 2.2]) { const st = wingSt(x), p = surfPt(st, sg * x, 0.66, foil(0.66, st.t, st.m)[1] - 0.006); air.push(prim(new THREE.SphereGeometry(1, 12, 8), { pos: p, scale: [0.016, 0.026, 0.19] })); }
    // stabilizer half
    const uvs = tailUv(1.725), sx = [0, 0.8, 1.6, 1.675].map((x) => sg * x);
    air.push(surfLoft(sx, stabSt, { xa: 0, xb: HE, n: 10 }, { uv: uvs }));
    air.push(loftGrid(sx.map((x) => { const st = stabSt(Math.abs(x)), [u, l] = foil(HE, st.t, 0); return [surfPt(st, x, HE, u), surfPt(st, x, HE, l)]; }), { out: [0, 0, 1], rgb: GRAY, uv: () => BLANK }));
    air.push(surfLoft([[sg * 1.675, 1, 1, 0], ...tipRound(1.675, 0.05, sg)], stabSt, { xa: 0, xb: 1, n: 10 }, { uv: uvs, capStart: true, capEnd: true }));
    // elevator half, on its own swept hinge line
    {
      const stn = [0.07, 0.8, 1.6, 1.665];
      const geos = [surfLoft(stn.map((x) => sg * x), stabSt, { xa: HE, xb: 1, n: 7, nose: 0.04 }, { uv: uvs, capStart: true, capEnd: true })];
      for (const x of [0.9, 1.45]) { const p = surfPt(stabSt(x), sg * x, 1, 0); geos.push(rod(p, [p[0], p[1], p[2] + 0.12], 0.005, BLACK, 5)); }
      const hp = (x) => surfPt(stabSt(x), sg * x, HE, 0);
      surfaces[sg > 0 ? 'elevR' : 'elevL'] = hinged(root, merge(geos), sg > 0 ? hp(0.07) : hp(1.665), sg > 0 ? hp(1.665) : hp(0.07), matAir);
    }
    // one strut each side, with fairings where it meets the wing and the fuselage
    const sa = [sg * 0.44, -0.47, 0.03], st = wingSt(2.55), sb = surfPt(st, sg * 2.55, 0.31, foil(0.31, st.t, st.m)[1] + 0.012);
    air.push(sweep([sa, sb], ellipse(0.062, 0.019, 14), [0, 0, 1]));
    air.push(prim(new THREE.SphereGeometry(1, 14, 10), { pos: [sg * 0.47, -0.45, 0.03], scale: [0.07, 0.09, 0.16] }), prim(new THREE.SphereGeometry(1, 14, 10), { pos: [sb[0], sb[1] - 0.02, sb[2]], scale: [0.09, 0.045, 0.17] }));
    // main gear leg: a tapered spring-steel tube, splayed out to the wheel
    const leg = Array.from({ length: 9 }, (_, k) => { const t = k / 8; return [sg * lerp(0.34, 1.17, t), lerp(-0.5, -0.95, Math.pow(t, 1.2)), 0.32]; });
    air.push(sweep(leg, (t) => ellipse(lerp(0.04, 0.03, t), lerp(0.033, 0.026, t), 12), [0, 0, 1]));
    air.push(prim(new THREE.SphereGeometry(1, 12, 8), { pos: [sg * 0.44, -0.555, 0.32], scale: [0.09, 0.05, 0.12] }));
    // boarding step on the leg
    air.push(prim(new THREE.BoxGeometry(0.16, 0.014, 0.1), { pos: [sg * 0.72, -0.66, 0.2], rgb: GRAY }), rod([sg * 0.72, -0.66, 0.24], [sg * 0.7, -0.69, 0.32], 0.009, GRAY, 5));
    // wheel fairings, or a bare axle and brake disk
    if (LOOK.pants) air.push(pantGeo(sg * 1.25, -0.95, 0.32, 0.2, 0.9, 0.115, () => (sch === 'twin' ? RED : WHITE)));
    else air.push(rod([sg * 1.15, -0.95, 0.32], [sg * 1.3, -0.95, 0.32], 0.02, GRAY, 8), prim(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 20), { pos: [sg * 1.165, -0.95, 0.32], rot: [0, 0, Math.PI / 2], rgb: [0.35, 0.33, 0.3] }));
  }
  if (LOOK.pants) air.push(pantGeo(0, -0.98, -1.33, 0.17, 0.74, 0.095, () => (sch === 'twin' ? RED : WHITE)));
  else for (const sg of [1, -1]) air.push(rod([sg * 0.075, -0.72, -1.26], [sg * 0.075, -0.98, -1.33], 0.014, WHITE, 6), rod([-0.075 * sg, -0.72, -1.26], [0, -0.7, -1.26], 0.014, WHITE, 6));
  // fin, rudder and dorsal fillet
  {
    const finPt = (y, xc, yc) => { const st = finSt(y); return [yc * st.chord, y, st.zLE + st.chord * xc]; };
    const band = (p) => p[1] > 1.3 && p[1] < 1.39;
    const fcol = sch === 'belly' ? (p) => (p[1] > 1.39 ? RED : band(p) ? LINE : WHITE) : sch === 'twin' ? (p) => (band(p) ? LINE : RED) : (p) => (band(p) ? WHITE : RED);
    const capCol = sch === 'belly' ? WHITE : RED;
    const uvf = (p) => [0.2 + (0.4 * (p[1] - FIN_Y0)) / 1.3, (1.01 + 0.98 * p[3]) / 3];
    const sec = (y, xa, xb, n, nose, cs = 1, ts = 1) => { const st = finSt(y); return foilPts(st.t, 0, xa === 'h' ? st.hr : xa, xb === 'h' ? st.hr : xb, n, nose).map(([xc, yc, up]) => { const p = finPt(y, 0.5 + (xc - 0.5) * cs, yc * ts); p.push(xc, up); return p; }); };
    const ys = [FIN_Y0, 0.7, 1.0, 1.3 - e, 1.3 + e, 1.39 - e, 1.39 + e, FIN_Y1];
    air.push(loftGrid(ys.map((y) => sec(y, 0, 'h', 12)), { uv: uvf, color: fcol }));
    air.push(loftGrid(ys.map((y) => { const st = finSt(y), t = foil(st.hr, st.t, 0)[0]; return [finPt(y, st.hr, t), finPt(y, st.hr, -t)]; }), { out: [0, 0, 1], rgb: GRAY, uv: () => BLANK }));
    air.push(loftGrid([[FIN_Y1, 1, 1], ...[1, 2, 3, 4].map((k) => { const f = (k / 4) * Math.PI / 2; return [FIN_Y1 + 0.045 * Math.sin(f), 0.86 + 0.14 * Math.cos(f), Math.max(Math.cos(f), 0.08)]; })].map(([y, cs, ts]) => sec(y, 0, 1, 12, 0, cs, ts)), { uv: uvf, color: () => RED, capStart: true, capEnd: true }));
    const ry = [0.41, 0.7, 1.0, 1.3 - e, 1.3 + e, 1.39 - e, 1.39 + e, FIN_Y1 - 0.004];
    const rud = [loftGrid(ry.map((y) => sec(y, 'h', 1, 7, 0.03)), { uv: uvf, color: fcol, capStart: true, capEnd: true })];
    for (const y of [0.75, 1.2]) { const p = finPt(y, 1, 0); rud.push(rod(p, [p[0], p[1], p[2] + 0.12], 0.005, BLACK, 5)); }
    surfaces.rud = hinged(root, merge(rud), finPt(0.41, finSt(0.41).hr, 0), finPt(FIN_Y1, finSt(FIN_Y1).hr, 0), matAir, Y_AXIS);
    // dorsal fillet from the tail cone up to the fin leading edge
    const dz = [3.3, 3.65, 4.0, 4.35, 4.7];
    air.push(loftGrid(dz.map((z) => { const yb = fTop(z) - 0.04, yr = lerp(fTop(3.3), 0.7, Math.pow((z - 3.3) / 1.4, 1.5)); return [[0.03, yb, z], [0, yr, z], [0, yr, z], [-0.03, yb, z]]; }), { out: [0, 1, 0], rgb: capCol, uv: () => BLANK }));
  }
  // nose gear leg, antennas, tail stinger
  air.push(rod([0, -0.4, -1.1], [0, -0.7, -1.26], 0.034, WHITE, 12));
  air.push(prim(new THREE.BoxGeometry(0.009, 0.2, 0.05), { pos: [-0.16, 1.01, 0.34], rot: [0.5, 0, 0] }), prim(new THREE.BoxGeometry(0.009, 0.2, 0.05), { pos: [0.16, 1.0, 0.76], rot: [0.5, 0, 0] }));
  air.push(prim(new THREE.SphereGeometry(1, 12, 8), { pos: [0, 0.935, -0.08], scale: [0.05, 0.02, 0.065] }), rod([0, 0.44, 2.5], [0, 0.72, 2.86], 0.005, GRAY, 5));
  air.push(prim(new THREE.BoxGeometry(0.2, 0.012, 0.035), { pos: [0, 1.38, 5.52], rgb: GRAY }));          // nav antenna across the fin
  const airMesh = mesh(root, W(merge(air)), matAir);
  parts.airframe = airMesh;

  // ---- metal: exhaust, oleo, torque links, pitot, stall vane
  const met = [], STEEL = [0.5, 0.5, 0.52], BURNT = [0.2, 0.15, 0.12], CHROME = [0.84, 0.85, 0.87];
  met.push(sweep([[0.19, -0.36, -1.34], [0.2, -0.45, -1.28], [0.21, -0.52, -1.2], [0.21, -0.56, -1.1]], (t) => ellipse(0.03, 0.03, 12), [1, 0, 0], { rgb: BURNT, capRgb: [0.004, 0.004, 0.004] }));
  if (LOOK.blades > 2) met.push(sweep([[-0.19, -0.36, -1.34], [-0.2, -0.45, -1.28], [-0.21, -0.52, -1.2], [-0.21, -0.56, -1.1]], (t) => ellipse(0.03, 0.03, 12), [1, 0, 0], { rgb: BURNT, capRgb: [0.004, 0.004, 0.004] }));   // the six breathes through two stacks
  met.push(rod([0, -0.68, -1.25], [0, -0.84, -1.335], 0.022, CHROME, 10));
  met.push(rod([0, -0.62, -1.19], [0, -0.72, -1.12], 0.01, STEEL, 5), rod([0, -0.72, -1.12], [0, -0.82, -1.22], 0.01, STEEL, 5));
  { const st = wingSt(2.0), p = surfPt(st, -2.0, 0.22, foil(0.22, st.t, st.m)[1]); met.push(sweep([[p[0], p[1] + 0.01, p[2]], [p[0], p[1] - 0.09, p[2]], [p[0], p[1] - 0.115, p[2] - 0.04], [p[0], p[1] - 0.115, p[2] - 0.26]], ellipse(0.009, 0.009, 8), [1, 0, 0], { rgb: STEEL })); }
  mesh(root, W(merge(met)), matMetal);
  parts.exhaust = [Wp([0.21, -0.58, -1.06]), Wp([LOOK.blades > 2 ? -0.21 : 0.21, -0.58, -1.06])];

  // ---- dark openings: cooling inlets either side of the spinner, carburettor air intake below it
  {
    const hole = (w, h, r) => { const s = new THREE.Shape(); s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2); return new THREE.ShapeGeometry(s, 6); };
    const DK = [0.006, 0.006, 0.007], g = [];
    for (const sg of [1, -1]) g.push(prim(hole(0.155, 0.09, 0.035), { pos: [sg * 0.205, 0.105, Z0 - 0.003], rot: [0, Math.PI, 0], rgb: DK }));
    g.push(prim(hole(0.13, 0.05, 0.022), { pos: [0, -0.165, Z0 - 0.003], rot: [0, Math.PI, 0], rgb: DK }));
    mesh(root, W(merge(g)), matIn, false, false);
  }

  // ---- wheels (spin with ground speed), sitting where the flight model's contact points put them
  const wheelGeo = (R, w) => {
    const k = R / 0.36, h = w / 0.21;
    const prof = [[0.19, -0.086], [0.25, -0.104], [0.32, -0.1], [0.352, -0.072], [0.36, -0.03], [0.36, 0.03], [0.352, 0.072], [0.32, 0.1], [0.25, 0.104], [0.19, 0.086]].map(([r, y]) => new THREE.Vector2(r * k, y * h));
    const tire = prim(new THREE.LatheGeometry(prof, 24), { rot: [0, 0, Math.PI / 2], rgb: [0.014, 0.014, 0.015] });
    const hub = prim(new THREE.CylinderGeometry(0.19 * k, 0.19 * k, 0.15 * h, 16), { rot: [0, 0, Math.PI / 2], rgb: [0.62, 0.62, 0.6] });
    return merge([tire, hub]);
  };
  const mainGeo = wheelGeo(0.2, 0.14), noseGeo = wheelGeo(0.17, 0.12);
  parts.wheels = v.spec.wheels.map((w) => { const R = w.main ? 0.2 : 0.17, m = mesh(root, w.main ? mainGeo : noseGeo, matTire); m.position.set(w.x, w.y + R + 0.07, w.z); return m; });
  parts.wheelSpin = 0;
  parts.gearHeight = v.spec.gearHeight;

  // ---- propeller: pointed spinner, twisted blades, and a blur disk for when it is turning
  const PROP_Y = 0.03, PROP_R = LOOK.propR, hubP = Wp([0, PROP_Y, -1.99]), sp = LOOK.spinner;
  const prop = new THREE.Group(); prop.position.set(...hubP); root.add(prop);
  const spin = [];
  for (let k = 0; k <= 18; k++) { const t = k / 18; spin.push(new THREE.Vector2((0.152 * Math.pow(1 - Math.pow(t, 1.75), 0.82) + 0.0004) * sp, -0.33 * t * sp)); }
  const spinGeo = new THREE.LatheGeometry(spin.reverse(), 32); spinGeo.rotateX(Math.PI / 2); spinGeo.translate(0, 0, 0.06);
  mesh(prop, spinGeo, matSpin);
  mesh(prop, prim(new THREE.CylinderGeometry(0.152 * sp, 0.156 * sp, 0.02, 32), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.065], rgb: [0.3, 0.3, 0.31] }), matMetal);
  const bladeRings = [];
  for (let k = 0; k <= 15; k++) {
    const t = k / 15, r = lerp(0.1, PROP_R, t), tipF = Math.sqrt(Math.max(1 - Math.pow(sstep(0.84, 1, t), 2), 0.002));
    const chord = lerp(0.075, 0.155, sstep(0, 0.42, t)) * lerp(1, 0.6, sstep(0.5, 1, t)) * tipF, thick = lerp(0.85, 0.08, sstep(0, 0.34, t)) * (0.5 + 0.5 * tipF);
    const beta = Math.atan2(0.4, r) + 0.1, cb = Math.cos(beta), sb = Math.sin(beta);
    bladeRings.push(Array.from({ length: 14 }, (_, j) => { const a = (j / 14) * 2 * Math.PI, u = Math.cos(a) * chord * 0.5, w = Math.sin(a) * chord * 0.5 * thick; return [u * cb - w * sb, r, -(u * sb + w * cb) + 0.0 + 0.012 * t]; }));
  }
  const tipY = PROP_R - 0.06;
  const bladeGeo = loftGrid(bladeRings, { closed: true, capEnd: true, uv: () => BLANK, color: (p) => (p[1] > tipY ? [0.82, 0.82, 0.8] : p[1] > tipY - 0.06 ? [0.6, 0.06, 0.05] : p[1] > tipY - 0.12 ? [0.82, 0.82, 0.8] : [0.022, 0.022, 0.024]) });
  const blades = new THREE.Group(); prop.add(blades);
  for (let i = 0; i < LOOK.blades; i++) { const b = mesh(blades, bladeGeo, matBlade); b.rotation.z = (i * 2 * Math.PI) / LOOK.blades; }
  const disk = new THREE.Mesh(new THREE.CircleGeometry(PROP_R + 0.012, 48), new THREE.MeshStandardMaterial({ map: propDiskTexture(LOOK.blades), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.6, envMapIntensity: 0.3 }));
  disk.position.set(hubP[0], hubP[1], hubP[2] - 0.01); disk.renderOrder = 4; root.add(disk);
  Object.assign(parts, { prop, blades, disk });

  // ---- cabin and instrument panel
  const g = GEOM, trimRgb = lin(LOOK.interior.trim);
  const A = {
    variant: v, look: LOOK, geom: g, sx: g.width, FW, linerGeo, frameGeo: W(windowFrames(trimRgb)),
    hullX: (z, y) => hullX(unwarpZ(g, z), y) * g.width,           // cabin half-width at a station and height, as built
    top: (z) => fTop(unwarpZ(g, z)), bot: (z) => fBot(unwarpZ(g, z)),
    zW: (z) => Wp([0, 0, z])[2], post: POST, paintMask: ft.paintMask,
  };
  PILOT_EYE.set(-0.27 * g.width, 0.42, -0.23); PILOT_VIEW.down = 0.31;
  parts.eye = PILOT_EYE.clone();
  const cab = buildInterior(A, { root, cabin, body, pit });
  const pan = buildPanel(A, { root, cabin, body, pit });
  Object.assign(parts, cab.parts, pan.parts);
  parts.cabin = cabin;

  // ---- lights: lens plus an additive glow that grows at night
  const glow = glowTexture(), lights = {};
  const lamp = (name, color, x, y, z, r = 0.035) => {
    const p = Wp([x, y, z]);
    const lens = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color }));
    lens.position.set(...p); root.add(lens);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.position.set(...p); s.renderOrder = 6; root.add(s);
    lights[name] = { lens, glow: s };
  };
  { const st = wingSt(5.4), p = surfPt(st, 5.4, 0.06, 0); const ty = p[1] + 0.045, tz = p[2];
    lamp('navL', new THREE.Color(1.6, 0.05, 0.03), -5.5, ty, tz, 0.024); lamp('navR', new THREE.Color(0.05, 1.5, 0.25), 5.5, ty, tz, 0.024);
    lamp('strobeL', new THREE.Color(2.2, 2.2, 2.4), -5.5, ty + 0.005, tz + 0.3, 0.022); lamp('strobeR', new THREE.Color(2.2, 2.2, 2.4), 5.5, ty + 0.005, tz + 0.3, 0.022); }
  lamp('tail', new THREE.Color(1.3, 1.3, 1.2), 0, 0.29, Z1 + 0.015, 0.02);
  lamp('beacon', new THREE.Color(2.0, 0.08, 0.04), 0, FIN_Y1 + 0.075, 5.72, 0.032);
  // landing light: in the wing's leading edge on the 172, in the nose bowl on the others
  if (LOOK.landing === 'wing') { const st = wingSt(2.95), p = surfPt(st, -2.95, 0.003, -0.004); lamp('landing', new THREE.Color(2.6, 2.5, 2.2), p[0], p[1], p[2] + 0.012, 0.045); }
  else lamp('landing', new THREE.Color(2.6, 2.5, 2.2), 0, -0.238, -1.905, LOOK.landing === 'cowl2' ? 0.05 : 0.04);
  parts.lights = lights;
  parts.wingtips = TIP0.map((p, i) => WINGTIPS[i].set(...Wp(p)));
  // legacy aliases kept so older callers do not break
  Object.assign(parts, surfaces, { elev: surfaces.elevR, navL: lights.navL.lens, navR: lights.navR.lens, strobe: lights.strobeL.lens, beacon: lights.beacon.lens });
  setDefaultRgb([1, 1, 1]);
  return { root, parts, variant: v };
}

/** Free everything a built aircraft holds on the GPU. Textures shared between variants (marked userData.shared) stay. */
export function disposeAircraft(model) {
  const seen = new Set();
  model.root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
      if (seen.has(m)) continue; seen.add(m);
      for (const k of Object.keys(m)) { const t = m[k]; if (t && t.isTexture && !t.userData.shared && !seen.has(t)) { seen.add(t); t.dispose(); } }
      m.dispose();
    }
  });
  for (const t of model.parts.textures || []) if (!seen.has(t)) t.dispose();
  model.root.removeFromParent();
}

/** Soft shadow sprite projected onto the ground beneath the aircraft (14 m square, nose toward -Z). */
export function buildShadow(variant) {
  const g0 = GEOM; GEOM = (!variant || typeof variant === 'string' ? aircraftById(variant) : variant).geom;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), k = 128 / 14, P = (x, z) => { const p = Wp([x, 0, z]); return [64 + p[0] * k, 64 + p[2] * k]; };
  const poly = (pts) => { g.beginPath(); pts.forEach(([x, z], i) => { const p = P(x, z); if (i) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); }); g.fill(); };
  g.filter = 'blur(4px)'; g.fillStyle = '#000';
  poly([[-5.5, -0.45], [5.5, -0.45], [5.5, 1.05], [-5.5, 1.05]]);                 // wing
  poly([[-0.5, -2.0], [0.5, -2.0], [0.5, 1.6], [-0.5, 1.6]]);                     // nose and cabin
  poly([[-0.5, 1.6], [0.5, 1.6], [0.08, 5.9], [-0.08, 5.9]]);                     // tail cone
  poly([[-1.7, 4.85], [1.7, 4.85], [1.7, 5.9], [-1.7, 5.9]]);                     // stabilizer
  GEOM = g0;
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshBasicMaterial({
    map: t, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: false,
  }));
  m.geometry.rotateX(-Math.PI / 2);
  m.renderOrder = 2;
  return m;
}

/**
 * Drive moving parts from flight state each frame.
 *   night  0..1 darkness (panel and cabin lighting follow it, and the ambient light itself)
 *   wet    0..1 optional: rain on the airframe, as a sheen on the paint
 */
export function animateAircraft(parts, ac, dt, time, night, wet = 0) {
  if (parts.animate) { parts.animate(parts, ac, dt, time, night, wet); return; }      // an aircraft from a model file moves its own parts (gltfmodel.js)
  // control surfaces: positive rotation about a hinge lowers the trailing edge
  parts.ailL.rotation.x = ac.ail * 0.35; parts.ailR.rotation.x = -ac.ail * 0.35;
  parts.elevL.rotation.x = parts.elevR.rotation.x = -ac.elev * 0.44;
  parts.rud.rotation.y = ac.rud * 0.42;
  for (const f of [parts.flapL, parts.flapR]) { f.rotation.x = ac.flap * 0.52; f.position.set(0, -0.015 * ac.flap, 0.09 * ac.flap); }

  const running = ac.fuel > 0, thr = ac.thrustLevel;
  parts.prop.rotation.z -= dt * (running ? 24 + 140 * thr : Math.min(ac.tas, 45) * 0.5);
  parts.blades.visible = !running;
  parts.disk.visible = running;
  parts.disk.rotation.z -= dt * (2.2 + 5 * thr);          // slow strobing of the blur
  parts.disk.material.opacity = running ? 1.05 - 0.45 * thr : 0;

  // wheels roll on the ground and spin down after lift-off
  parts.wheelSpin = ac.onGround ? ac.groundSpeed : parts.wheelSpin * Math.exp(-dt * 0.6);
  parts.wheels.forEach((w, i) => { w.rotation.x -= (parts.wheelSpin / (i < 2 ? 0.2 : 0.17)) * dt; });

  // rain on the paint: the clear coat goes glassy and the dull patches fill in
  if (parts.wetNow !== wet) {
    parts.wetNow = wet;
    for (const m of parts.paint) { m.clearcoat = 0.75 + 0.25 * wet; m.clearcoatRoughness = 0.1 - 0.07 * wet; m.roughness = 1 - 0.45 * wet; m.envMapIntensity = 0.8 + 0.5 * wet; }
  }

  // lights
  const L = parts.lights, n = Math.max(0, Math.min(1, night || 0));
  const set = (l, on, size) => { l.glow.visible = on; l.lens.visible = on || l === L.landing; if (on) l.glow.scale.setScalar(size); };
  set(L.navL, true, 0.26 + 1.4 * n); set(L.navR, true, 0.26 + 1.4 * n); set(L.tail, true, 0.2 + 1.0 * n);
  const ph = time % 1.3, strobe = ph < 0.05 || (ph > 0.13 && ph < 0.18);
  set(L.strobeL, strobe, 0.6 + 1.6 * n); set(L.strobeR, strobe, 0.6 + 1.6 * n);     // a flash, not a ball of light: the lens adds its own glow
  set(L.beacon, time % 1.05 < 0.13, 0.5 + 1.3 * n);
  const landing = ac.agl < 350 || n > 0.5;
  set(L.landing, landing, 0.26 + 3.2 * n);
  if (landing) L.landing.lens.material.color.setRGB(2.6, 2.5, 2.2); else L.landing.lens.material.color.setRGB(0.16, 0.17, 0.18);   // an unlit lamp is just dark glass

  // cabin: controls and the people at them; then the instruments (skipped when the cockpit is not being drawn)
  animateInterior(parts, ac, dt, time, n);
  if (parts.pit.visible) animatePanel(parts, ac, dt, time, n);
}
