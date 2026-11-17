// Starship on its Super Heavy booster: 121.3 m of stainless steel, 9 m across. The booster (71 m with
// its vented hot-staging ring) carries 33 sea-level Raptor engines in rings of 3, 10 and 20, four grid
// fins near the top and four long chines low on the oxygen tank; the ship (50.3 m) has a tangent-ogive
// nose, black hexagonal heat-shield tiles over its windward side (+Z, away from the launch tower) up to
// a clean line and over the tip of the nose, two forward and two aft flaps that fold toward the leeward
// side, and three sea-level plus three vacuum Raptors.
//
// The steel is painted, not shaded: every 1.83 m barrel ring gets its own tone, brushed streaks around
// it, a weld with its heat tint at each joint and one down its side, a roughness map that streaks the
// same way, and a soft low-resolution normal map that gives the rings their slightly dented reflections.
// The tiles are a small tiling texture on their own shell a few centimeters proud of the steel. There
// are no logos or wordmarks.
//
// Stages: 0 Super Heavy, 1 Ship. update() takes s.flaps = { fwd, aft }, each -1..1: 0 is the flap
// standing straight out, +1 folded 70 degrees to leeward, -1 pushed 20 degrees to windward.

import * as THREE from 'three';
import {
  TAU, D2R, polar, bell, revolve, facets, box, cyl, atAz, Beams, meshOf, wrapTex, rng,
  hardwareTextures, GLOW_RGB, engineSet, assembleVehicle, prim, rod, canvas, tex, normalFromHeight, BLANK, lerp, loftGrid,
} from './model-kit.js';

const R = 4.5, RING = 1.83;
const B = { skirt: 1.1, top: 69.2, ringTop: 71.0, fins: 66.2 };                 // booster heights (m above the engine exit plane)
const SHIP0 = B.ringTop, SHIP_CYL = SHIP0 + 31.5, TIP = SHIP0 + 50.3;           // ship: base, top of the barrel, nose tip
const RAPTOR = { len: 3.1, exitR: 0.65, max: 12 * D2R }, RVAC = { len: 4.6, exitR: 1.2 };
const TILE_FROM = 165, TILE_TO = 375, CAP = 1.9;                                // tiled arc (degrees of azimuth) and the all-round cap at the tip
const HEX = 0.295, TILE_U = 8 * HEX, TILE_V = 8 * 0.75 * HEX * 1.1547;          // tile size and the span of the 8 x 8 tile texture

const STEEL = [0.74, 0.74, 0.73], DARK_STEEL = [0.2, 0.2, 0.21], BLACK = [0.016, 0.016, 0.018], NOZZLE = [0.34, 0.33, 0.33];

/** Nose radius at height y: a tangent ogive off the barrel, blunted at the tip. */
function noseR(y) {
  if (y <= SHIP_CYL) return R;
  const L = TIP + 0.9 - SHIP_CYL, rho = (R * R + L * L) / (2 * R), d = y - SHIP_CYL;
  return Math.max(0, Math.sqrt(Math.max(0, rho * rho - d * d)) - (rho - R));
}

// ---------------------------------------------------------------- stainless steel

/** Canvases for a steel barrel from y0 to y1: color (half the circumference, tiled twice), roughness and a soft normal map. */
function steel(y0, y1, seed, opts = {}) {
  const W = 1024, H = 2048, [C, g] = canvas(W, H, '#c9c9c8'), [Rm, gr] = canvas(512, 1024, 'rgb(0,104,160)'), [Hc, gh] = canvas(256, 512, '#808080');
  const rnd = rng(seed), Yp = (y, h = H) => h - ((y - y0) / (y1 - y0)) * h, pxm = H / (y1 - y0);
  const rings = [];
  for (let y = y0; y < y1 - 0.01; y += RING) rings.push([y, Math.min(y1, y + RING)]);
  const noseFrom = opts.noseFrom ?? 1e9;
  rings.forEach(([ya, yb], k) => {
    const top = Yp(yb), hpx = Yp(ya) - top, v = 190 + Math.round(rnd() * 26), warm = (rnd() - 0.5) * 7;
    g.fillStyle = `rgb(${v + warm},${v},${v - warm})`; g.fillRect(0, top, W, hpx + 1);
    // brushed streaks around the ring
    for (let i = 0; i < 70; i++) {
      const sy = top + rnd() * hpx, len = 80 + rnd() * 700, sx = rnd() * W, a = 0.015 + rnd() * 0.035;
      g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(40,42,48,${a})`;
      const th = 0.6 + rnd() * 2.2; g.fillRect(sx, sy, len, th); if (sx + len > W) g.fillRect(sx - W, sy, len, th);
    }
    // soft tonal blotches where the sheet was handled, and the runs condensation leaves
    for (let i = 0; i < 5; i++) {
      const cx = rnd() * W, cy = top + rnd() * hpx, rr = 40 + rnd() * 120, gd = g.createRadialGradient(cx, cy, 0, cx, cy, rr), c = rnd() < 0.5 ? '255,255,255' : '50,52,58';
      gd.addColorStop(0, `rgba(${c},0.07)`); gd.addColorStop(1, `rgba(${c},0)`); g.fillStyle = gd; g.fillRect(cx - rr, top, rr * 2, hpx);
    }
    for (let i = 0; i < 9; i++) { const sx = rnd() * W, sh = hpx * (0.3 + rnd() * 0.7); const gd = g.createLinearGradient(0, top, 0, top + sh); gd.addColorStop(0, 'rgba(60,58,54,0.07)'); gd.addColorStop(1, 'rgba(60,58,54,0)'); g.fillStyle = gd; g.fillRect(sx, top, 1.5 + rnd() * 4, sh); }
    // the ring's own vertical weld (nose rings are gores: a weld every 30 degrees)
    const seams = ya >= noseFrom ? [0, 1, 2, 3, 4, 5].map((i) => ((i + 0.5 * (k % 2)) / 6) * W) : [rnd() * W];
    for (const sx of seams) {
      g.fillStyle = 'rgba(96,84,70,0.14)'; g.fillRect(sx - 3, top, 6, hpx); g.fillStyle = 'rgba(235,235,235,0.4)'; g.fillRect(sx - 0.6, top, 1.2, hpx);
      gr.fillStyle = 'rgb(0,140,160)'; gr.fillRect(sx / 2 - 2, top / 2, 4, hpx / 2);
      gh.fillStyle = '#a8a8a8'; gh.fillRect(sx / 4 - 0.5, top / 4, 1, hpx / 4);
    }
    // roughness: streaks the same way round
    for (let i = 0; i < 26; i++) { const sy = (top + rnd() * hpx) / 2, len = 60 + rnd() * 300, sx = rnd() * 512; gr.fillStyle = `rgba(0,${rnd() < 0.5 ? 60 : 130},160,${0.1 + rnd() * 0.25})`; const th = 0.5 + rnd() * 2; gr.fillRect(sx, sy, len, th); if (sx + len > 512) gr.fillRect(sx - 512, sy, len, th); }
    // gentle dents between the stiffening rings: what makes the reflections wander
    for (let i = 0; i < 7; i++) {
      const cx = rnd() * 256, cy = (top + hpx * (0.2 + 0.6 * rnd())) / 4, rx = 12 + rnd() * 26, up = rnd() < 0.5;
      for (const ox of [0, 256, -256]) { const gd = gh.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, rx); gd.addColorStop(0, up ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)'); gd.addColorStop(1, 'rgba(128,128,128,0)'); gh.fillStyle = gd; gh.save(); gh.translate(0, cy); gh.scale(1, (hpx / 4) / (rx * 2.2)); gh.translate(0, -cy); gh.fillRect(cx + ox - rx, cy - rx, rx * 2, rx * 2); gh.restore(); }
    }
  });
  // circumferential welds with their heat tint
  for (const [ya] of rings.slice(1)) {
    const y = Yp(ya), gd = g.createLinearGradient(0, y - 0.11 * pxm, 0, y + 0.11 * pxm);
    gd.addColorStop(0, 'rgba(110,96,78,0)'); gd.addColorStop(0.35, 'rgba(104,90,74,0.2)'); gd.addColorStop(0.5, 'rgba(70,64,60,0.34)'); gd.addColorStop(0.65, 'rgba(104,90,74,0.2)'); gd.addColorStop(1, 'rgba(110,96,78,0)');
    g.fillStyle = gd; g.fillRect(0, y - 0.11 * pxm, W, 0.22 * pxm);
    g.fillStyle = 'rgba(240,240,240,0.55)'; g.fillRect(0, y - 0.7, W, 1.4);
    gr.fillStyle = 'rgb(0,150,160)'; gr.fillRect(0, y / 2 - 1.5, 512, 3);
    gh.fillStyle = 'rgba(40,40,40,0.75)'; gh.fillRect(0, y / 4 - 1, 256, 2); gh.fillStyle = '#b0b0b0'; gh.fillRect(0, y / 4 - 0.4, 256, 0.8);
  }
  if (opts.marks) opts.marks({ g, gr, W, H, X: (deg) => (deg / 180) * W, Y: Yp, pxm: [W / (Math.PI * R), pxm] });
  const map = wrapTex(C, true, 2), rm = wrapTex(Rm, false, 2), normal = wrapTex(normalFromHeight(Hc, 1.6), false, 2);
  return new THREE.MeshStandardMaterial({ map, roughnessMap: rm, metalnessMap: rm, normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 1, metalness: 1, envMapIntensity: 1.0 });
}

/** The heat-shield tile texture: 8 x 8 hexagons, points up, each its own shade of black. */
function tileMaterial() {
  const N = 512, [C, g] = canvas(N, N, '#0b0b0d'), [Hc, gh] = canvas(N, N, '#b0b0b0'), [Rm, gr] = canvas(N, N, 'rgb(0,200,0)');
  const w = N / 8, rowH = N / 8, hh = rowH / 0.75;           // hexagon width, row pitch, point-to-point height
  const hex = (ctx, cx, cy, inset) => {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k + Math.PI / 6, x = cx + (w / 2 / Math.cos(Math.PI / 6) - inset) * Math.cos(a), y = cy + (hh / 2 - inset) * Math.sin(a); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.closePath();
  };
  gh.fillStyle = '#303030'; gh.fillRect(0, 0, N, N);
  g.fillStyle = '#242427'; g.fillRect(0, 0, N, N);                         // the gaps
  for (let r = -1; r <= 8; r++) for (let c = -1; c <= 8; c++) {
    const cx = (c + 0.5 + (r & 1 ? 0.5 : 0)) * w, cy = (r + 0.5) * rowH, seed = ((r + 8) % 8) * 8 + ((c + 8) % 8);
    const q = rng(seed * 31 + 5), v = 10 + Math.round(q() * 4), gloss = q();
    hex(g, cx, cy, 1.4); g.fillStyle = `rgb(${v},${v},${v + 1})`; g.fill();
    hex(gh, cx, cy, 2.2); gh.fillStyle = '#b4b4b4'; gh.fill();
    hex(gr, cx, cy, 1.4); gr.fillStyle = `rgb(0,${Math.round(170 + gloss * 40)},0)`; gr.fill();
    g.fillStyle = 'rgba(70,70,74,0.5)'; g.beginPath(); g.arc(cx, cy, 1.6, 0, TAU); g.fill();       // the pin that holds the tile
  }
  const mk = (c, srgb, n) => { const t = tex(n ? normalFromHeight(c, 1.4) : c, srgb, true); t.wrapS = THREE.RepeatWrapping; return t; };
  return new THREE.MeshStandardMaterial({ map: mk(C, true), normalMap: mk(Hc, false, true), roughnessMap: mk(Rm, false), roughness: 1, metalness: 0.0, envMapIntensity: 0.9 });
}
const tileUv = (u, y) => [(u * TAU * R) / TILE_U, y / TILE_V];

// ---------------------------------------------------------------- engines

function nozzleProfile(yT, rT, yE, rE, shape, n) {
  const pts = [];
  for (let k = 0; k <= n; k++) { const s = 1 - k / n; pts.push([rT + (rE - rT) * bell(s, shape), lerp(yT, yE, s)]); }
  return pts;
}
function inside(profile, wall, seg) {
  const inner = profile.slice().reverse().map(([r, y]) => [Math.max(0.02, r - wall), y]), y0 = inner[0][1], y1 = inner[inner.length - 1][1], lip = profile[0];
  return [
    revolve(inner, { seg, uv: (u, y) => [0.5, (y - y0) / (y1 - y0)] }),
    revolve([[0, y0], [inner[0][0], y0]], { seg, uv: () => [0.5, 0] }),
    revolve([[lip[0] - wall, lip[1]], [lip[0], lip[1]]], { seg, uv: () => [0.5, 1] }),
  ];
}
const geoOf = (list) => meshOf(list, null).geometry;

/** Raptor: a smooth regeneratively cooled bell under a tight knot of pumps and manifolds. Origin at the gimbal. */
function raptor(vac) {
  const len = vac ? RVAC.len : RAPTOR.len, rE = vac ? RVAC.exitR : RAPTOR.exitR, yT = -1.05, rT = 0.115, seg = vac ? 28 : 18, m = [];
  const pr = nozzleProfile(yT, rT, -len, rE, vac ? 0.28 : 0.3, vac ? 14 : 9);
  if (vac) {
    // the vacuum bell: a welded skirt with stiffening hoops
    const hoop = [];
    pr.forEach(([r, y], k) => { if (k > 0 && k < 11 && k % 2 === 0) hoop.push([r, y - 0.03], [r + 0.04, y - 0.025], [r + 0.04, y + 0.025], [r, y + 0.03]); else hoop.push([r, y]); });
    m.push(revolve(hoop, { seg, rgb: NOZZLE, crease: 40 }));
  } else m.push(revolve(pr, { seg, rgb: NOZZLE }));
  m.push(revolve([[rT, yT], [0.2, -0.86], [0.21, -0.55], [0.15, -0.4], [0.15, -0.05], [0, -0.05]], { seg: 12, rgb: [0.5, 0.5, 0.5], crease: 35 }));
  m.push(prim(new THREE.TorusGeometry(0.33, 0.07, 6, 16), { pos: [0, yT - 0.22, 0], rot: [Math.PI / 2, 0, 0], rgb: [0.55, 0.55, 0.56] }));
  m.push(prim(new THREE.TorusGeometry(0.27, 0.06, 6, 14), { pos: [0, -0.6, 0], rot: [Math.PI / 2, 0, 0], rgb: [0.55, 0.55, 0.56] }));
  m.push(cyl(0.19, 0.19, 0.7, [0.34, -0.55, 0.08], [0.6, 0.6, 0.6], 10), cyl(0.16, 0.16, 0.62, [-0.3, -0.5, -0.16], [0.52, 0.52, 0.53], 10));
  m.push(cyl(0.13, 0.13, 0.4, [0.02, -0.28, 0.33], [0.45, 0.45, 0.46], 8));
  m.push(rod([0.34, -0.9, 0.08], [0.33, yT - 0.2, 0.02], 0.06, [0.5, 0.5, 0.5], 6), rod([-0.3, -0.82, -0.16], [-0.24, -0.62, -0.1], 0.05, [0.5, 0.5, 0.5], 6));
  return { metal: geoOf(m), glow: geoOf(inside(pr, 0.012, seg)) };
}

// ---------------------------------------------------------------- pieces

/** A long cover standing off the hull (chine, raceway): rounded section, faired in over `taper` meters at each end. */
function strake(deg, y0, y1, w, d, taper, rgb = STEEL, Rb = R) {
  const hw = w / 2, sec = [[-0.06, -hw], [d * 0.55, -hw], [d * 0.92, -hw * 0.62], [d, -hw * 0.2], [d, hw * 0.2], [d * 0.92, hw * 0.62], [d * 0.55, hw], [-0.06, hw]];
  const rows = [[y0, 0.02], [y0 + taper * 0.5, 0.6], [y0 + taper, 1], [y1 - taper, 1], [y1 - taper * 0.5, 0.6], [y1, 0.02]].map(([y, s]) => sec.map(([x, z]) => [Rb + Math.max(-0.06, x * s), y, z * (0.6 + 0.4 * s)]));
  return atAz(loftGrid(rows, { uv: () => BLANK, rgb, inside: [Rb - 1, (y0 + y1) / 2, 0] }), deg * D2R);
}

/** Grid fin standing out along +X from the hull at height y: a lattice slab 6.2 m by 4.4 m. */
function gridFin(y) {
  const xa = R + 0.75, xb = R + 6.6, za = -2.2, zb = 2.2, dep = 0.72, bm = new Beams(), G = [0.56, 0.56, 0.57], xm = xa, step = 0.66;
  const pt = (x, z) => [x, y, z];
  for (let c = za - (xb - xa); c <= zb + (xb - xa); c += step) {
    let x0 = Math.max(xa, xm + (za - c)), x1 = Math.min(xb, xm + (zb - c));
    if (x1 - x0 > 0.05) bm.add(pt(x0, x0 - xm + c), pt(x1, x1 - xm + c), 0.045, G, dep);
    x0 = Math.max(xa, xm - (zb - c)); x1 = Math.min(xb, xm - (za - c));
    if (x1 - x0 > 0.05) bm.add(pt(x0, -(x0 - xm) + c), pt(x1, -(x1 - xm) + c), 0.045, G, dep);
  }
  // frame, with the outer corners cut
  const cut = 0.9, loop = [[xa, za], [xb - cut, za], [xb, za + cut], [xb, zb - cut], [xb - cut, zb], [xa, zb]];
  loop.forEach((p, i) => { const q2 = loop[(i + 1) % loop.length]; bm.add(pt(p[0], p[1]), pt(q2[0], q2[1]), 0.11, G, dep + 0.04, true); });
  const parts = [bm.build()];
  // root: the shaft into the hull and its fairing
  parts.push(cyl(0.42, 0.42, 1.3, [R + 0.3, y, 0], DARK_STEEL, 14, [0, 0, Math.PI / 2]));
  parts.push(box(0.5, dep + 0.2, 2.6, [xa - 0.1, y, 0], G));
  parts.push(strake(0, y - 1.5, y + 1.5, 2.2, 0.5, 0.9, STEEL));
  return geoOf(parts);
}

/** One flap as a hinged group. poly: outline [[out, along], ...] from the hinge line; side +1 puts the tiles on local +Z.
 *  The leeward face wears the hull's own steel (vOf gives the texture v of a height along the hinge). */
function flap(poly, tRoot, tTip, side, M, steelMat, vOf) {
  const span = Math.max(...poly.map((p) => p[0])), th = (x) => lerp(tRoot, tTip, x / span) / 2;
  const face = (sgn) => poly.map(([x, y]) => [x, y, sgn * th(x)]);
  const wind = face(side), lee = face(-side), tUv = (p) => [p[0] / TILE_U, p[1] / TILE_V], sUv = (p) => [0.02 + p[0] / (TAU * R), vOf(p[1])];
  const tile = [facets([side > 0 ? wind : wind.slice().reverse()], [1, 1, 1], { uv: tUv })];
  const steelParts = [facets([side > 0 ? lee.slice().reverse() : lee], [1, 1, 1], { uv: sUv })];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    if (poly[i][0] < 0.01 && poly[j][0] < 0.01) continue;                    // the root edge is buried in the hinge fairing
    const q = [wind[i], wind[j], lee[j], lee[i]];
    tile.push(facets([side > 0 ? q.slice().reverse() : q], [1, 1, 1], { uv: tUv }));
  }
  // hinge fairing along the root: tiled toward the wind, steel behind
  const y0 = Math.min(...poly.map((p) => p[1])), y1 = Math.max(...poly.map((p) => p[1])), rf = tRoot * 0.62;
  const fp = [[0.02, y0 - 0.5], [rf, y0 - 0.1], [rf, y1 + 0.1], [0.02, y1 + 0.6]];
  const windA = side > 0 ? [Math.PI, TAU] : [0, Math.PI], leeA = side > 0 ? [0, Math.PI] : [Math.PI, TAU];
  tile.push(revolve(fp, { seg: 8, a0: windA[0], a1: windA[1], uv: (u, y) => [(u * TAU * rf) / TILE_U, y / TILE_V] }));
  steelParts.push(revolve(fp, { seg: 8, a0: leeA[0], a1: leeA[1], uv: (u, y) => [0.4 + u * 0.05, vOf(y)] }));
  const pivot = new THREE.Group();
  pivot.add(meshOf(tile, M.tile), meshOf(steelParts, steelMat));
  return pivot;
}

function buildBooster(M) {
  const y0 = B.skirt, y1 = B.top, metal = [];
  const mat = steel(y0, y1, 3, {
    marks({ g, W, Y, X }) {
      // the band the grid fins and catch fittings are bolted to
      g.fillStyle = 'rgba(70,72,78,0.16)'; g.fillRect(0, Y(B.fins + 2.2), W, Y(B.fins - 2.4) - Y(B.fins + 2.2));
      for (const d of [0, 90]) { g.fillStyle = 'rgba(40,42,46,0.5)'; g.fillRect(X(d) - 14, Y(64.4), 28, 24); }
    },
  });
  const uv = (u, y) => [u, (y - y0) / (y1 - y0)];
  const skinGeo = [revolve([[R, y0], [R, y1]], { seg: 96, uv })];
  // hot-staging ring: a band, thirty posts and a rim, around the shield over the forward dome
  metal.push(revolve([[R, y1], [R + 0.03, y1 + 0.02], [R + 0.03, y1 + 0.34], [R - 0.14, y1 + 0.34]], { seg: 72, rgb: DARK_STEEL, crease: 20 }));
  metal.push(revolve([[R - 0.14, B.ringTop - 0.3], [R + 0.03, B.ringTop - 0.3], [R + 0.03, B.ringTop], [R - 0.14, B.ringTop], [R - 0.14, B.ringTop - 0.3]], { seg: 72, rgb: DARK_STEEL, crease: 20 }));
  for (let k = 0; k < 30; k++) metal.push(atAz(box(0.17, B.ringTop - y1 - 0.62, 0.36, [R - 0.055, (y1 + B.ringTop) / 2 + 0.02, 0], DARK_STEEL), (k / 30) * TAU));
  metal.push(revolve([[3.95, y1 + 0.3], [3.95, B.ringTop - 0.05]], { seg: 48, rgb: [0.05, 0.05, 0.055] }));
  metal.push(revolve([[R - 0.14, y1 + 0.2], [3.2, y1 + 0.75], [1.2, y1 + 1.2], [0, y1 + 1.28]], { seg: 48, rgb: [0.13, 0.13, 0.14], crease: 50 }));
  // aft: skirt lip, inner wall, the shield the engines poke through
  metal.push(revolve([[R - 0.06, y0], [R, y0]], { seg: 72, rgb: STEEL }), revolve([[R - 0.06, y0 + 1.2], [R - 0.06, y0]], { seg: 72, rgb: DARK_STEEL }));
  metal.push(revolve([[0, 1.9], [R - 0.06, 1.9]], { seg: 48, rgb: [0.09, 0.09, 0.1] }));
  // chines, raceway, catch pins
  for (const d of [60, 120, 240, 300]) metal.push(strake(d, 2.6, 22.5, 1.7, 1.05, 3.2));
  metal.push(strake(90, 3.0, 64.0, 0.55, 0.3, 0.8), strake(270, 24, 63.5, 0.4, 0.22, 0.6));
  for (const d of [0, 180]) metal.push(atAz(cyl(0.2, 0.2, 0.75, [R + 0.3, 64.6, 0], DARK_STEEL, 12, [0, 0, Math.PI / 2]), d * D2R), atAz(box(0.3, 0.9, 0.9, [R + 0.08, 64.6, 0], STEEL), d * D2R));
  const fin = gridFin(B.fins);
  for (const d of [60, 120, 240, 300]) metal.push(atAz(fin.clone(), d * D2R));

  // 33 Raptors: 3 and 10 that swivel, 20 fixed round the rim
  const gy = RAPTOR.len, mounts = [];
  for (let k = 0; k < 3; k++) mounts.push({ pos: polar(0.86, (k / 3) * TAU + 0.5, gy), yaw: (k / 3) * TAU, gimbal: true });
  for (let k = 0; k < 10; k++) mounts.push({ pos: polar(2.45, (k / 10) * TAU, gy), yaw: (k / 10) * TAU, gimbal: true });
  for (let k = 0; k < 20; k++) mounts.push({ pos: polar(3.82, ((k + 0.5) / 20) * TAU, gy), yaw: ((k + 0.5) / 20) * TAU, gimbal: false });
  const e = raptor(false), engines = engineSet([[e.metal, M.metal], [e.glow, M.glow[0]]], mounts);
  const group = new THREE.Group(); group.name = 'Super Heavy';
  group.add(meshOf(skinGeo, mat), meshOf(metal, M.metal), engines.group);
  return {
    name: 'Super Heavy', group, bottomY: 0, topY: B.ringTop, propellant: 'methalox', nozzleRadius: RAPTOR.exitR, engines: [engines], gimbalMax: RAPTOR.max,
    nozzles: mounts.map((m) => new THREE.Vector3(m.pos[0], 0, m.pos[2])),
  };
}

function buildShip(M) {
  const y0 = SHIP0, y1 = TIP - CAP, metal = [], tiles = [];
  const mat = steel(y0, y1, 9, {
    noseFrom: SHIP_CYL - 0.1,
    marks({ g, X, Y }) {
      // payload door on the leeward side, and the quick-disconnect plate by the skirt
      g.strokeStyle = 'rgba(40,42,48,0.55)'; g.lineWidth = 2; g.strokeRect(X(62), Y(SHIP0 + 31), X(118) - X(62), Y(SHIP0 + 29.4) - Y(SHIP0 + 31));
      g.fillStyle = 'rgba(40,42,46,0.6)'; g.fillRect(X(90) - 30, Y(SHIP0 + 2.6), 60, Y(SHIP0 + 1.4) - Y(SHIP0 + 2.6));
    },
  });
  // profile of the hull, bottom to top
  const prof = [[R, y0], [R, SHIP_CYL]];
  for (let k = 1; k <= 16; k++) { const y = lerp(SHIP_CYL, y1, k / 16); prof.push([noseR(y), y]); }
  const uv = (u, y) => [u, (y - y0) / (y1 - y0)];
  const a0 = (TILE_TO - 360 - 2) * D2R, a1 = (TILE_FROM + 2) * D2R;
  const skinGeo = [revolve(prof, { seg: 44, a0, a1, uv, crease: 12 })];
  // tile shell, 4 cm proud, and the cap over the tip
  const proud = prof.map(([r, y]) => [r + 0.04, y]);
  tiles.push(revolve(proud, { seg: 56, a0: TILE_FROM * D2R, a1: TILE_TO * D2R, uv: tileUv, crease: 12 }));
  const capP = [];
  for (let k = 0; k <= 8; k++) { const y = lerp(y1, TIP, k / 8); capP.push([k === 8 ? 0 : Math.max(noseR(y), 0.02) + 0.04, y]); }
  tiles.push(revolve(capP, { seg: 48, uv: tileUv, crease: 30 }));
  // the step at the tile line
  for (const d of [TILE_FROM, TILE_TO]) metal.push(atAz(loftGrid(prof.map(([r, y]) => [[r - 0.01, y, 0], [r + 0.04, y, 0]]), { uv: () => BLANK, rgb: BLACK, out: [0, 0, d === TILE_FROM ? 1 : -1] }), d * D2R));
  // aft: skirt lip and wall, engine bay shield
  metal.push(revolve([[R - 0.05, y0], [R + 0.04, y0]], { seg: 72, rgb: DARK_STEEL }), revolve([[R - 0.05, y0 + 2.8], [R - 0.05, y0]], { seg: 72, rgb: DARK_STEEL }));
  metal.push(revolve([[0, y0 + 2.8], [R - 0.05, y0 + 2.8]], { seg: 48, rgb: [0.1, 0.1, 0.11] }));
  // leeward raceway, and the static fairings the flaps hinge on
  metal.push(strake(90, y0 + 1.2, y0 + 28.5, 0.5, 0.28, 0.8), strake(60, y0 + 4, y0 + 27, 0.3, 0.18, 0.6));

  const group = new THREE.Group(); group.name = 'Ship';
  // flaps: aft pair on the sides, forward pair on the nose, a little to leeward
  const flaps = [];
  const aftPoly = [[0, 0.9], [4.75, 0.9], [4.75, 5.3], [4.2, 6.9], [2.8, 8.7], [1.2, 9.7], [0, 10.0]];
  const fwdPoly = [[0, 0], [3.3, 0.5], [3.45, 2.7], [2.5, 5.0], [1.0, 6.9], [0, 7.3]];
  for (const deg of [0, 180]) {
    const side = deg === 0 ? 1 : -1, p = flap(aftPoly, 0.9, 0.34, side, M, mat, (y) => y / (y1 - y0));
    p.position.set(...polar(R + 0.12, deg * D2R, y0)); p.rotation.y = deg * D2R;
    flaps.push({ pivot: p, base: p.quaternion.clone(), side, fwd: false }); group.add(p);
  }
  for (const deg of [12, 168]) {
    const side = deg < 90 ? 1 : -1, ya = y0 + 33.6, yb = ya + 7.3, p = flap(fwdPoly, 0.7, 0.28, side, M, mat, (y) => (33.6 + y) / (y1 - y0));
    const pa = new THREE.Vector3(...polar(noseR(ya) + 0.1, deg * D2R, ya)), pb = new THREE.Vector3(...polar(noseR(yb) + 0.1, deg * D2R, yb));
    const yAxis = pb.clone().sub(pa).normalize(), zAxis = new THREE.Vector3(Math.sin(deg * D2R), 0, Math.cos(deg * D2R)), xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    p.position.copy(pa); p.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, new THREE.Vector3().crossVectors(xAxis, yAxis)));
    flaps.push({ pivot: p, base: p.quaternion.clone(), side, fwd: true }); group.add(p);
  }

  // three sea-level Raptors that swivel, three vacuum Raptors fixed outside them
  const sl = raptor(false), vac = raptor(true), ySL = y0 + 0.25, yV = y0 + 0.15;
  const mSL = [0, 1, 2].map((k) => ({ pos: polar(0.92, (k / 3) * TAU + Math.PI / 2, ySL + RAPTOR.len), yaw: (k / 3) * TAU, gimbal: true }));
  const mV = [0, 1, 2].map((k) => ({ pos: polar(2.95, (k / 3) * TAU + Math.PI / 2 + Math.PI / 3, yV + RVAC.len), yaw: (k / 3) * TAU, gimbal: false }));
  const eSL = engineSet([[sl.metal, M.metal], [sl.glow, M.glow[1]]], mSL), eV = engineSet([[vac.metal, M.metal], [vac.glow, M.glow[1]]], mV);
  group.add(meshOf(skinGeo, mat), meshOf(tiles, M.tile), meshOf(metal, M.metal), eSL.group, eV.group);
  return {
    name: 'Ship', group, bottomY: yV, topY: TIP, propellant: 'methalox', nozzleRadius: RAPTOR.exitR, engines: [eSL], gimbalMax: RAPTOR.max, flaps,
    nozzles: [...mSL.map((m) => new THREE.Vector3(m.pos[0], ySL, m.pos[2])), ...mV.map((m) => new THREE.Vector3(m.pos[0], yV, m.pos[2]))],
    nozzleRadii: [RAPTOR.exitR, RAPTOR.exitR, RAPTOR.exitR, RVAC.exitR, RVAC.exitR, RVAC.exitR],
  };
}

const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

export function buildStarship() {
  const hw = hardwareTextures();
  const M = {
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, map: hw.map, normalMap: hw.normal, roughness: 0.42, metalness: 0.66, envMapIntensity: 1.0 }),
    tile: tileMaterial(),
    glow: [0, 1].map(() => new THREE.MeshStandardMaterial({ color: 0x15110f, roughness: 0.7, metalness: 0.3, emissive: new THREE.Color(...GLOW_RGB.methalox), emissiveMap: hw.glow, emissiveIntensity: 0 })),
  };
  const root = new THREE.Group(); root.name = 'Starship';
  const stages = [buildBooster(M), buildShip(M)];
  for (const s of stages) root.add(s.group);
  const flaps = stages[1].flaps, pose = { fwd: 0.1, aft: 0.06 };
  const setFlaps = (fwd, aft) => {
    for (const f of flaps) {
      const v = f.fwd ? fwd : aft, ang = (v > 0 ? v * 70 : v * 20) * D2R * f.side;
      f.pivot.quaternion.copy(f.base).multiply(_q.setFromAxisAngle(_up, ang));
    }
  };
  setFlaps(pose.fwd, pose.aft);
  return assembleVehicle({
    id: 'starship', root, height: TIP, radius: R, stages, glow: M.glow, materials: M,
    animate(dt, s) {
      const gx = s.gimbal?.y || 0, gz = s.gimbal?.x || 0, cur = s.stage ?? 0;
      stages.forEach((stg, i) => { for (const e of stg.engines) e.set(i === cur ? gx * stg.gimbalMax : 0, i === cur ? gz * stg.gimbalMax : 0); });
      const f = s.flaps, fw = f && f.fwd != null ? f.fwd : 0.1, af = f && f.aft != null ? f.aft : 0.06;
      if (fw !== pose.fwd || af !== pose.aft) { pose.fwd = fw; pose.aft = af; setFlaps(fw, af); }
    },
  });
}

export const STARSHIP_DIMENSIONS = { height: TIP, diameter: R * 2, boosterTop: B.ringTop, gridFinY: B.fins };
