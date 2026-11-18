// Starship on its Super Heavy booster: 121.3 m of stainless steel, 9 m across. The booster (71 m with
// its vented hot-staging ring) carries 33 sea-level Raptor engines in rings of 3, 10 and 20, four grid
// fins near the top and four long chines low on the oxygen tank; the ship (50.3 m) has a tangent-ogive
// nose, black hexagonal heat-shield tiles over its windward side (+Z, away from the launch tower) up to
// a clean line and over the tip of the nose, two forward and two aft flaps that fold toward the leeward
// side, and three sea-level plus three vacuum Raptors.
//
// The steel is painted, not shaded: it is bare mill-finish stainless, a mid gray that takes its light from
// the sky, so the color map is kept dark and the metal nearly pure and the look comes from the reflection.
// Every 1.83 m barrel ring gets its own tone and polish, brushed streaks around it, the faint lines of the
// stringers welded on inside with a spot weld at each end, a weld with its heat tint at each joint and one
// down its side, a roughness map that streaks the same way, and a soft low-resolution normal map that
// gives the rings their slightly dented reflections. The Ship's leeward side carries what the real one
// does: a tray of red-brown cable up to a junction box, round ports, vents, the quick-disconnect plate.
//
// The tiles are real hexagons, one polygon each, a few centimeters proud of the steel: that is what
// gives the heat shield its ragged, stepped edge where it laps round onto the leeward side (further round
// under the forward flaps, beside the aft ones and up the nose, until it closes over the tip). Up the
// nose the count of tiles around drops in bands so they keep their size. They share one small tiling
// texture. There are no logos or wordmarks.
//
// Stages: 0 Super Heavy, 1 Ship. update() takes s.flaps = { fwd, aft }, each -1..1: 0 is the flap
// standing straight out, +1 folded 70 degrees to leeward, -1 pushed 20 degrees to windward.

import * as THREE from 'three';
import {
  TAU, D2R, polar, bell, revolve, facets, box, cyl, atAz, Beams, meshOf, wrapTex, rng,
  hardwareTextures, GLOW_RGB, engineSet, assembleVehicle, prim, rod, canvas, tex, normalFromHeight, BLANK, lerp, sstep, loftGrid,
} from './model-kit.js';

const R = 4.5, RING = 1.83;
const B = { skirt: 1.1, top: 69.2, ringTop: 71.0, fins: 66.2 };                 // booster heights (m above the engine exit plane)
const SHIP0 = B.ringTop, SHIP_CYL = SHIP0 + 31.5, TIP = SHIP0 + 50.3;           // ship: base, top of the barrel, nose tip
const RAPTOR = { len: 3.1, exitR: 0.65, max: 12 * D2R }, RVAC = { len: 4.6, exitR: 1.2 };
const CAP = 1.9;                                                                // the steel's texture stops this far under the tip: everything above is tiled all round
const HEX = (TAU * R) / 96, ROW = 0.75 * HEX * 1.1547, TILE_U = 8 * HEX, TILE_V = 8 * ROW;      // a tile (96 round the barrel), the pitch of its rows, the span of the 8 x 8 tile texture
const PROUD = 0.04;                                                             // how far the tiles stand off the steel
// On the Ship's leeward side, by azimuth (degrees; 90 is the middle of the leeward side) and height above its base (m):
const RACEWAY = 112, PORTS = [[62, 23.3, 1.25], [58, 12.0, 1.35], [141, 14.5, 1.2]], VENTS = [[47, 22.2], [93, 23.5], [137, 23.2], [150, 21.3]];
// The tower's arms take the Ship by two pins, one on each flank just under the forward flaps: mission.js hangs it
// with the top of the arms' rails 32.76 m above the Ship's base, so that is where the pins' undersides are.
const PIN = { y: 32.76, r: 0.17 };

const STEEL = [0.56, 0.57, 0.58], DARK_STEEL = [0.2, 0.2, 0.21], BLACK = [0.016, 0.016, 0.018], NOZZLE = [0.34, 0.33, 0.33];
// How much of a metal the steel is drawn as. A pure metal shows only what it mirrors, and an upright wall mirrors the
// horizon: dark under a bright sky. Some diffuse light with it is what keeps the steel a mid gray in sunlight.
const METAL = 0.72;
const pbr = (rough, metal) => `rgb(0,${Math.round(rough * 255)},${Math.round(metal * 255)})`;           // a roughness / metalness map's color

/** Nose radius at height y: a tangent ogive off the barrel, blunted at the tip. */
function noseR(y) {
  if (y <= SHIP_CYL) return R;
  const L = TIP + 0.9 - SHIP_CYL, rho = (R * R + L * L) / (2 * R), d = y - SHIP_CYL;
  return Math.max(0, Math.sqrt(Math.max(0, rho * rho - d * d)) - (rho - R));
}

// ---------------------------------------------------------------- stainless steel

/**
 * Canvases for a steel barrel from y0 to y1: color (half the circumference, tiled twice), roughness and a soft normal map.
 * opts.marks(o) paints what is particular to the vehicle: o.paint(color, pbr, draw) draws the same shape on the color map
 * and (unless pbr is null) on the roughness / metalness map; o.X(degrees) and o.Y(height) place it, o.pxm is pixels a meter.
 */
function steel(y0, y1, seed, opts = {}) {
  const W = 1024, H = 2048, [C, g] = canvas(W, H, '#babcbe'), [Rm, gr] = canvas(512, 1024, pbr(0.56, METAL)), [Hc, gh] = canvas(256, 512, '#808080');
  const rnd = rng(seed), Yp = (y, h = H) => h - ((y - y0) / (y1 - y0)) * h, pxm = H / (y1 - y0);
  const rings = [];
  for (let y = y0; y < y1 - 0.01; y += RING) rings.push([y, Math.min(y1, y + RING)]);
  const noseFrom = opts.noseFrom ?? 1e9;
  const wrap = (ctx, x, y, w, h, Wc = W) => { x = ((x % Wc) + Wc) % Wc; ctx.fillRect(x, y, w, h); if (x + w > Wc) ctx.fillRect(x - Wc, y, w, h); };       // a rectangle that goes on round the seam
  rings.forEach(([ya, yb], k) => {
    const top = Yp(yb), hpx = Yp(ya) - top;
    // every ring is its own coil of sheet: its own gray, a touch warm or cool, its own polish
    const v = 172 + Math.round(rnd() * 28) + (rnd() < 0.22 ? -18 : 0) + (rnd() < 0.22 ? 12 : 0), warm = (rnd() - 0.5) * 9;
    g.fillStyle = `rgb(${v + warm},${v + warm * 0.2},${v - warm})`; g.fillRect(0, top, W, hpx + 1);
    gr.fillStyle = pbr(0.46 + rnd() * 0.2, METAL); gr.fillRect(0, top / 2, 512, hpx / 2 + 1);
    // the mill's finish: brushed streaks around the ring
    for (let i = 0; i < 80; i++) {
      const sy = top + rnd() * hpx, len = 80 + rnd() * 700, a = 0.02 + rnd() * 0.05;
      g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(30,32,38,${a})`;
      wrap(g, rnd() * W, sy, len, 0.6 + rnd() * 2.2);
    }
    // broad soft bands up the sheet where it came off the roll a little brighter or duller
    for (let i = 0; i < 7; i++) {
      const cx = rnd() * W, bw = 24 + rnd() * 120, c = rnd() < 0.5 ? '255,255,255' : '28,30,36', a = 0.04 + rnd() * 0.07;
      for (const ox of [0, W, -W]) { const gd = g.createLinearGradient(cx + ox - bw, 0, cx + ox + bw, 0); gd.addColorStop(0, `rgba(${c},0)`); gd.addColorStop(0.5, `rgba(${c},${a})`); gd.addColorStop(1, `rgba(${c},0)`); g.fillStyle = gd; g.fillRect(cx + ox - bw, top, bw * 2, hpx); }
    }
    // soft tonal blotches where the sheet was handled, and the runs condensation leaves
    for (let i = 0; i < 5; i++) {
      const cx = rnd() * W, cy = top + rnd() * hpx, rr = 40 + rnd() * 120, gd = g.createRadialGradient(cx, cy, 0, cx, cy, rr), c = rnd() < 0.5 ? '255,255,255' : '40,42,48';
      gd.addColorStop(0, `rgba(${c},0.08)`); gd.addColorStop(1, `rgba(${c},0)`); g.fillStyle = gd; g.fillRect(cx - rr, top, rr * 2, hpx);
    }
    for (let i = 0; i < 9; i++) { const sx = rnd() * W, sh = hpx * (0.3 + rnd() * 0.7); const gd = g.createLinearGradient(0, top, 0, top + sh); gd.addColorStop(0, 'rgba(52,48,42,0.12)'); gd.addColorStop(1, 'rgba(52,48,42,0)'); g.fillStyle = gd; g.fillRect(sx, top, 1.5 + rnd() * 4, sh); }
    // the stringers welded on inside show through as faint lines up the ring, each with a spot weld at its ends
    if (ya < noseFrom && rnd() < 0.7) {
      const n = [18, 24, 30][Math.floor(rnd() * 3)], ph = rnd(), a = 0.06 + rnd() * 0.09, tick = rnd() < 0.7;
      for (let i = 0; i < n; i++) {
        const sx = ((i + ph) / n) * W;
        g.fillStyle = `rgba(34,36,42,${a})`; g.fillRect(sx - 0.8, top + 3, 1.6, hpx - 6);
        g.fillStyle = `rgba(255,255,255,${a * 0.6})`; g.fillRect(sx + 0.8, top + 3, 1, hpx - 6);
        if (tick) { g.fillStyle = 'rgba(30,32,36,0.55)'; g.fillRect(sx - 1.6, top + 0.1 * pxm, 3.2, 0.14 * pxm); g.fillRect(sx - 1.6, top + hpx - 0.24 * pxm, 3.2, 0.14 * pxm); }
      }
    }
    // a row of small weld pads part of the way round
    if (rnd() < 0.45) {
      const yy = top + hpx * (0.22 + 0.56 * rnd()), x0 = rnd() * W, len = W * (0.15 + rnd() * 0.5), st = 11 + rnd() * 14;
      g.fillStyle = 'rgba(32,34,38,0.5)';
      for (let x = x0; x < x0 + len; x += st) wrap(g, x, yy, 3.5, 0.13 * pxm);
    }
    // the ring's own vertical weld (nose rings are gores: a weld every 22.5 degrees)
    const seams = ya >= noseFrom ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ((i + 0.5 * (k % 2)) / 8) * W) : [rnd() * W];
    for (const sx of seams) {
      g.fillStyle = 'rgba(88,76,62,0.16)'; g.fillRect(sx - 3.5, top, 7, hpx); g.fillStyle = 'rgba(30,31,34,0.42)'; g.fillRect(sx - 1.2, top, 2.4, hpx); g.fillStyle = 'rgba(232,233,235,0.34)'; g.fillRect(sx + 1.2, top, 1, hpx);
      gr.fillStyle = pbr(0.74, METAL); gr.fillRect(sx / 2 - 2, top / 2, 4, hpx / 2);
      gh.fillStyle = '#a8a8a8'; gh.fillRect(sx / 4 - 0.5, top / 4, 1, hpx / 4);
    }
    // roughness: streaks the same way round
    for (let i = 0; i < 26; i++) { const sy = (top + rnd() * hpx) / 2, len = 60 + rnd() * 300, sx = rnd() * 512; gr.fillStyle = `rgba(0,${rnd() < 0.5 ? 84 : 190},${Math.round(METAL * 255)},${0.1 + rnd() * 0.25})`; wrap(gr, sx, sy, len, 0.5 + rnd() * 2, 512); }
    // gentle dents between the stiffening rings: what makes the reflections wander
    for (let i = 0; i < 7; i++) {
      const cx = rnd() * 256, cy = (top + hpx * (0.2 + 0.6 * rnd())) / 4, rx = 12 + rnd() * 26, up = rnd() < 0.5;
      for (const ox of [0, 256, -256]) { const gd = gh.createRadialGradient(cx + ox, cy, 0, cx + ox, cy, rx); gd.addColorStop(0, up ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)'); gd.addColorStop(1, 'rgba(128,128,128,0)'); gh.fillStyle = gd; gh.save(); gh.translate(0, cy); gh.scale(1, (hpx / 4) / (rx * 2.2)); gh.translate(0, -cy); gh.fillRect(cx + ox - rx, cy - rx, rx * 2, rx * 2); gh.restore(); }
    }
  });
  // circumferential welds: a dark bead between two bright ground edges, in a band of heat tint
  for (const [ya] of rings.slice(1)) {
    const y = Yp(ya), gd = g.createLinearGradient(0, y - 0.12 * pxm, 0, y + 0.12 * pxm);
    gd.addColorStop(0, 'rgba(100,86,70,0)'); gd.addColorStop(0.35, 'rgba(94,80,66,0.22)'); gd.addColorStop(0.5, 'rgba(52,48,46,0.4)'); gd.addColorStop(0.65, 'rgba(94,80,66,0.22)'); gd.addColorStop(1, 'rgba(100,86,70,0)');
    g.fillStyle = gd; g.fillRect(0, y - 0.12 * pxm, W, 0.24 * pxm);
    g.fillStyle = 'rgba(26,27,30,0.6)'; g.fillRect(0, y - 1.3, W, 2.6);
    g.fillStyle = 'rgba(228,230,233,0.36)'; g.fillRect(0, y - 2.5, W, 1.1); g.fillRect(0, y + 1.4, W, 1.1);
    gr.fillStyle = pbr(0.76, METAL); gr.fillRect(0, y / 2 - 1.5, 512, 3);
    gh.fillStyle = 'rgba(40,40,40,0.75)'; gh.fillRect(0, y / 4 - 1, 256, 2); gh.fillStyle = '#b0b0b0'; gh.fillRect(0, y / 4 - 0.4, 256, 0.8);
  }
  if (opts.marks) {
    gr.save(); gr.scale(0.5, 0.5);                 // (so one set of coordinates serves both maps)
    const paint = (fill, pb, draw) => { g.fillStyle = g.strokeStyle = fill; draw(g); if (pb) { gr.fillStyle = gr.strokeStyle = pb; draw(gr); } };
    opts.marks({ g, gr, W, H, X: (deg) => (deg / 180) * W, Y: Yp, pxm: [W / (Math.PI * R), pxm], rnd, paint });
    gr.restore();
  }
  const map = wrapTex(C, true, 2), rm = wrapTex(Rm, false, 2), normal = wrapTex(normalFromHeight(Hc, 1.6), false, 2);
  return new THREE.MeshStandardMaterial({ map, roughnessMap: rm, metalnessMap: rm, normalMap: normal, normalScale: new THREE.Vector2(0.55, 0.55), roughness: 1, metalness: 1, envMapIntensity: 1.0 });
}

/** What the Ship carries on its leeward steel (see RACEWAY, PORTS, VENTS): the flat part of each; buildShip adds what stands off the skin. */
function shipMarks({ g, X, Y, pxm: [pu, pv], rnd, paint }) {
  const yh = (m) => Y(SHIP0 + m);
  const rect = (deg, m0, m1, w, off = 0) => (c) => c.fillRect(X(deg) + (off - w / 2) * pu, yh(m1), w * pu, yh(m0) - yh(m1));
  const oval = (x, y, rx, ry) => (c) => { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, TAU); c.fill(); };
  const run = (deg, m, len) => { const x = X(deg), y = yh(m), gd = g.createLinearGradient(0, y, 0, y + len * pv); gd.addColorStop(0, 'rgba(58,50,40,0.3)'); gd.addColorStop(1, 'rgba(58,50,40,0)'); g.fillStyle = gd; g.fillRect(x - 0.1 * pu, y, 0.2 * pu, len * pv); };
  // soot and scorching up from the skirt
  { const gd = g.createLinearGradient(0, yh(0), 0, yh(3.2)); gd.addColorStop(0, 'rgba(30,28,26,0.42)'); gd.addColorStop(1, 'rgba(30,28,26,0)'); g.fillStyle = gd; g.fillRect(0, yh(3.2), X(180), yh(0) - yh(3.2)); }
  // rows of weld pads over the engine bay and under the nose, where the skin is stiffened most
  g.fillStyle = 'rgba(30,32,36,0.52)';
  for (const [m0, m1] of [[1.2, 8.6], [24.4, 31.2]]) for (let m = m0; m < m1; m += 0.61) {
    if (rnd() < 0.3) continue;
    const a0 = 30 + rnd() * 60, a1 = a0 + 20 + rnd() * 70, st = 0.16 + rnd() * 0.12;
    for (let x = X(a0); x < X(Math.min(a1, 152)); x += st * pu) g.fillRect(x, yh(m), 0.045 * pu, 0.13 * pv);
  }
  // the raceway: a tray of red-brown cable from above the quick-disconnect up to its junction box, clamped at every ring,
  // with a branch across to a box on either side and a loop of slack here and there
  paint('rgba(46,48,52,0.5)', pbr(0.6, 0.7), rect(RACEWAY, 5.4, 22.0, 0.42));
  [['#6a332b', -0.125], ['#7c4033', -0.045], ['#5c2e28', 0.035], ['#74392e', 0.115]].forEach(([col, off]) => paint(col, pbr(0.8, 0), rect(RACEWAY, 5.8, 22.0, 0.06, off)));
  for (const s of [-1, 1]) { paint('#84372a', pbr(0.8, 0), rect(RACEWAY, 12.92, 13.0, 1.5, s * 0.78)); paint('#6c2b23', pbr(0.8, 0), rect(RACEWAY, 13.06, 13.13, 1.5, s * 0.78)); }
  for (const m of [7.5, 9.4, 11.1, 14.9, 16.7, 18.6, 20.3]) paint('#8a382a', pbr(0.8, 0), (c) => { c.lineWidth = 2.6; c.beginPath(); c.ellipse(X(RACEWAY) - 0.3 * pu, yh(m), 0.2 * pu, 0.26 * pv, 0, 0.5, TAU - 0.9); c.stroke(); });
  for (const [m, d] of [[5.6, 0.34], [5.2, 0.5]]) for (const s of [-1, 1]) paint('#7a3125', pbr(0.8, 0), (c) => { c.lineWidth = 2.6; c.beginPath(); c.moveTo(X(RACEWAY) + s * 0.1 * pu, yh(5.9)); c.lineTo(X(RACEWAY) + s * d * pu, yh(m)); c.stroke(); });
  paint('#bdbbb4', pbr(0.6, 0.1), rect(RACEWAY, 21.85, 23.35, 0.86)); paint('rgba(40,40,40,0.5)', null, rect(RACEWAY, 21.85, 21.93, 0.86));
  run(RACEWAY - 2, 21.85, 2.2);
  // the quick-disconnect plate by the skirt
  paint('#1c1d20', pbr(0.6, 0.4), rect(90, 0.4, 3.1, 1.7));
  // ports: black glass in a bolted steel ring
  for (const [deg, m, d] of PORTS) {
    const x = X(deg), y = yh(m), rx = (d / 2) * pu, ry = (d / 2) * pv;
    paint('#b9bcbf', pbr(0.3, 0.95), oval(x, y, rx * 1.22, ry * 1.22)); paint('#34363a', pbr(0.5, 0.9), oval(x, y, rx * 1.05, ry * 1.05)); paint('#07080a', pbr(0.08, 0), oval(x, y, rx * 0.95, ry * 0.95));
    for (let i = 0; i < 12; i++) { const a = (i / 12) * TAU; paint('#4a4c50', null, oval(x + Math.cos(a) * rx * 1.135, y + Math.sin(a) * ry * 1.135, 1.7, 1.3)); }
    run(deg, m - d * 0.6, 1.8);
  }
  // vents and their stains; the payload door's outline round the base of the nose; two small slots near the tip
  for (const [deg, m] of VENTS) { paint('#26282b', pbr(0.6, 0.5), rect(deg, m - 0.34, m + 0.34, 0.5)); run(deg, m - 0.34, 2.6); }
  g.strokeStyle = 'rgba(30,32,38,0.6)'; g.lineWidth = 1.6; g.strokeRect(X(64), yh(33.3), X(116) - X(64), yh(32.4) - yh(33.3));
  for (const deg of [76, 104]) paint('#141518', pbr(0.6, 0.3), rect(deg, 45.8, 45.95, 0.42));
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
  // (vertex colors: every tile of the shell is its own polygon with its own shade. The offset keeps the tiles in front of
  // the steel 4 cm under them from a mile away, where the depth buffer can no longer tell the two apart.)
  return new THREE.MeshStandardMaterial({ map: mk(C, true), normalMap: mk(Hc, false, true), roughnessMap: mk(Rm, false), roughness: 1, metalness: 0.0, envMapIntensity: 0.9, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
}

/** Slope dr/dy of the nose at height y. */
function noseSlope(y) {
  if (y <= SHIP_CYL) return 0;
  const L = TIP + 0.9 - SHIP_CYL, rho = (R * R + L * L) / (2 * R), d = y - SHIP_CYL;
  return -d / Math.sqrt(Math.max(1e-6, rho * rho - d * d));
}

/** How far round toward the leeward side the tiles reach at height h above the Ship's base, in degrees past the flank
 *  (azimuth 0 or 180): further beside the aft flaps' roots and under the forward ones, and up the nose until, past 90, they close over it. */
function tileReach(h) {
  const hump = (a, b, w) => sstep(a - w, a + w, h) * (1 - sstep(b - w, b + w, h));
  return 15 + 15 * hump(9.6, 15.8, 0.5) + 22 * hump(27.4, 32.6, 0.5) + 36 * sstep(41.8, 47.2, h) + 70 * sstep(47.0, 48.5, h);
}

/**
 * The heat shield from the Ship's base (y0) to just under its tip: every tile a hexagon of its own, whole or not there at
 * all, which is what steps the leeward edge. The tiles line up with the tile texture (rows ROW apart, 8 to a repeat); a tile
 * at the top or bottom of a band of the nose is cut square so the bands meet in a straight joint.
 */
function tileShell(y0) {
  const pos = [], nor = [], uv = [], col = [], rnd = rng(77), hh = ROW / 0.75;
  const zones = [[y0 + 0.06, 96], [SHIP_CYL + 10.36, 64], [SHIP_CYL + 14.26, 40], [SHIP_CYL + 16.48, 24], [SHIP_CYL + 17.94, 16], [SHIP_CYL + 18.5, 0]];       // from this height, this many tiles around
  const k0 = Math.floor(zones[0][0] / ROW), kN = Math.ceil(zones[zones.length - 1][0] / ROW);
  // the leeward edge on each flank: held for a few rows at a time, then stepped a tile either way
  const reach = [0, 1].map(() => {
    const out = [];
    for (let k = k0, left = 0, cur = 0; k <= kN; k++) {
      const h = (k + 0.5) * ROW - y0;
      if (left-- <= 0) { left = h > 42 ? 0 : 1 + Math.floor(rnd() * 4); cur = tileReach(h) + (Math.floor(rnd() * 3) - 1) * (h > 42 ? 2 : 3.75); }
      out.push(cur);
    }
    return out;
  });
  for (let z = 0; z < zones.length - 1; z++) {
    const [ya, N] = zones[z], yb = zones[z + 1][0];
    for (let k = Math.floor(ya / ROW); (k + 0.5) * ROW < yb; k++) {
      const yc = (k + 0.5) * ROW;
      if (yc < ya) continue;
      const first = yc - ROW < ya, last = yc + ROW >= yb, off = (7 - (k % 8)) & 1 ? 0.5 : 0, T = last ? yb - yc : hh / 2, Bt = first ? ya - yc : -hh / 2;
      // the outline, counterclockwise seen from outside: [across (tiles), up (m)]
      const poly = [...(last ? [[0.5, T], [-0.5, T]] : [[0.5, hh / 4], [0, T], [-0.5, hh / 4]]), ...(first ? [[-0.5, Bt], [0.5, Bt]] : [[-0.5, -hh / 4], [0, Bt], [0.5, -hh / 4]])];
      for (let c = 0; c < N; c++) {
        const uc = (c + 0.5 + off) / N, deg = (uc * 360) % 360;
        if (deg < 180) { const s = deg < 90 ? 0 : 1; if ((s ? 180 - deg : deg) > reach[s][k - k0]) continue; }
        // its own shade (now and then a newer, grayer one) and its own slight tilt, which is what makes the shield glint tile by tile
        const shade = rnd() < 0.02 ? 1.6 + rnd() * 1.6 : 0.75 + rnd() * 0.5, jx = (rnd() - 0.5) * 0.035, jy = (rnd() - 0.5) * 0.035;
        const vs = poly.map(([du, dy]) => {
          const a = (uc + du / N) * TAU, y = yc + dy, r = noseR(y) + PROUD, ca = Math.cos(a), sa = Math.sin(a);
          const nx = ca - sa * jx, ny = -noseSlope(y) + jy, nz = -sa - ca * jx, l = Math.hypot(nx, ny, nz);
          return [r * ca, y, -r * sa, nx / l, ny / l, nz / l, (c + 0.5 + off + du) / 8, y / TILE_V];
        });
        for (let i = 1; i < vs.length - 1; i++) for (const q of [vs[0], vs[i], vs[i + 1]]) { pos.push(q[0], q[1], q[2]); nor.push(q[3], q[4], q[5]); uv.push(q[6], q[7]); col.push(shade, shade, shade); }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** Steel for the leeward face of a flap: sheets in a grid over the ribs and spars, 8 m by 16 m of it (u = out / 8,
 *  v = along / 16). Past u = 0.7 are two plain swatches, black below and bare steel above, for the hinge's parts. */
function flapSteel() {
  const W = 512, H = 1024, px = 64, [C, g] = canvas(W, H, '#babcbe'), rnd = rng(21), cw = 1.19 * px, rh = (RING / 2) * px;
  for (let r = 0; r * rh < H; r++) for (let c = 0; c * cw < 0.7 * W; c++) {
    const v = 176 + Math.round(rnd() * 26);
    g.fillStyle = `rgb(${v},${v},${v + 2})`; g.fillRect(c * cw, H - (r + 1) * rh, cw, rh);
  }
  for (let i = 0; i < 500; i++) { const a = 0.02 + rnd() * 0.05; g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(30,32,38,${a})`; g.fillRect(rnd() * 0.7 * W, rnd() * H, 20 + rnd() * 160, 0.6 + rnd() * 2); }
  for (let r = 0; r * rh < H; r++) {
    const y = H - r * rh;
    g.fillStyle = 'rgba(26,27,30,0.55)'; g.fillRect(0, y - 1, 0.7 * W, 2); g.fillStyle = 'rgba(228,230,233,0.3)'; g.fillRect(0, y + 1, 0.7 * W, 1);
    g.fillStyle = 'rgba(30,32,36,0.5)'; for (let x = 4; x < 0.7 * W; x += 9) g.fillRect(x, y - rh / 2, 2, 2);          // a row of fasteners along the rib between
  }
  for (let c = 1; c * cw < 0.7 * W; c++) { g.fillStyle = 'rgba(26,27,30,0.5)'; g.fillRect(c * cw - 1, 0, 2, H); g.fillStyle = 'rgba(228,230,233,0.26)'; g.fillRect(c * cw + 1, 0, 1, H); }
  g.fillStyle = '#bcbec0'; g.fillRect(0.7 * W, 0, 0.3 * W, H / 2); g.fillStyle = '#060607'; g.fillRect(0.7 * W, H / 2, 0.3 * W, H / 2);
  return new THREE.MeshStandardMaterial({ map: tex(C, true), roughness: 0.56, metalness: METAL, envMapIntensity: 1.0 });
}

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
  const xa = R + 0.75, xb = R + 6.6, za = -2.2, zb = 2.2, dep = 0.72, bm = new Beams({ outward: true }), G = [0.56, 0.56, 0.57], xm = xa, step = 0.66;
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

/** A convex outline [[x, y], ...] (counterclockwise) moved in by d on every side. */
function inset(poly, d) {
  const n = poly.length, unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l]; };       // (the inward normal of an edge)
  return poly.map((p, i) => {
    const n1 = unit(poly[(i + n - 1) % n], p), n2 = unit(p, poly[(i + 1) % n]), k = d / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k];
  });
}

/** One flap as a hinged group. poly: outline [[out, along], ...] from the hinge line, counterclockwise, its first and last
 *  points on that line; side +1 puts the tiles on local +Z. The blade stops short of the hinge: the slot between it and
 *  the hull, with the hinge's knuckles across it, is the black line down each flap's root seen from the leeward side.
 *  That side is bare steel inside a frame of tiles lapping round from the windward face. */
function flap(poly, tRoot, tTip, side, M) {
  const SLOT = 0.42, FRAME = 0.17, n = poly.length, span = Math.max(...poly.map((p) => p[0])), th = (x) => lerp(tRoot, tTip, x / span) / 2;
  const y0 = Math.min(...poly.map((p) => p[1])), y1 = Math.max(...poly.map((p) => p[1]));
  const blade = poly.map((p, i) => { if (p[0] >= SLOT) return p; const q = poly[i === 0 ? 1 : n - 2], t = (SLOT - p[0]) / (q[0] - p[0]); return [SLOT, p[1] + (q[1] - p[1]) * t]; });
  const at = (pts, sgn) => pts.map(([x, y]) => [x, y, sgn * th(x)]), facing = (pts, sgn) => (sgn > 0 ? pts : pts.slice().reverse());      // (an outline listed counterclockwise, to face +Z or -Z)
  const wind = at(blade, side), lee = at(blade, -side), leeIn = at(inset(blade, FRAME), -side);
  const tUv = (p) => [p[0] / TILE_U, p[1] / TILE_V], sUv = (p) => [p[0] / 8, (p[1] - y0) / 16], W = [1, 1, 1];
  const swatch = (geo, u, v) => { const a = geo.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, u, v); return geo; };
  const tile = [facets([facing(wind, side)], W, { uv: tUv })], steelParts = [facets([facing(leeIn, -side)], W, { uv: sUv })];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tile.push(facets([facing([wind[j], wind[i], lee[i], lee[j]], side)], W, { uv: tUv }));               // the rim
    tile.push(facets([facing([lee[i], lee[j], leeIn[j], leeIn[i]], -side)], W, { uv: tUv }));            // the frame on the leeward face
  }
  // in the slot: a dark web, and the knuckles of the hinge across it
  steelParts.push(swatch(box(SLOT + 0.1, y1 - y0 - 0.3, tRoot * 0.3, [(SLOT + 0.1) / 2 - 0.02, (y0 + y1) / 2, 0], W), 0.86, 0.25));
  const nk = Math.max(3, Math.round((y1 - y0) / 2.7));
  for (let i = 0; i < nk; i++) steelParts.push(swatch(box(SLOT + 0.5, 0.5, tRoot * 0.84, [(SLOT + 0.5) / 2 - 0.12, lerp(y0 + 0.8, y1 - 1.5, i / (nk - 1)), 0], W), 0.86, 0.75));
  // hinge fairing along the root: tiled toward the wind; behind, only its pointed ends are closed in
  const rf = tRoot * 0.62, fUv = (u, y) => [(u * TAU * rf) / TILE_U, y / TILE_V];
  const windA = side > 0 ? [Math.PI, TAU] : [0, Math.PI], leeA = side > 0 ? [0, Math.PI] : [Math.PI, TAU];
  tile.push(revolve([[0.02, y0 - 0.5], [rf, y0 - 0.1], [rf, y1 + 0.1], [0.02, y1 + 0.6]], { seg: 8, a0: windA[0], a1: windA[1], uv: fUv }));
  for (const end of [[[0.02, y0 - 0.5], [rf, y0 - 0.1], [0.02, y0 - 0.1]], [[0.02, y1 + 0.1], [rf, y1 + 0.1], [0.02, y1 + 0.6]]]) tile.push(revolve(end, { seg: 8, a0: leeA[0], a1: leeA[1], uv: fUv }));
  const pivot = new THREE.Group();
  pivot.add(meshOf(tile, M.tile), meshOf(steelParts, M.flap));
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
  // (the arms' rails come up under the pins 0.21 m above the height mission.js catches the booster by, 7 m under its top)
  for (const d of [0, 180]) metal.push(atAz(cyl(0.2, 0.2, 0.75, [R + 0.3, B.ringTop - 7 + 0.21 + 0.2, 0], DARK_STEEL, 12, [0, 0, Math.PI / 2]), d * D2R), atAz(box(0.1, 0.9, 0.9, [R - 0.02, 64.6, 0], STEEL), d * D2R));
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
  const mat = steel(y0, y1, 9, { noseFrom: SHIP_CYL - 0.1, marks: shipMarks });
  // profile of the hull, bottom to top (the steel goes on a little way under the tiles of the tip)
  const prof = [[R, y0], [R, SHIP_CYL]];
  for (let k = 1; k <= 17; k++) { const y = lerp(SHIP_CYL, y1, k / 16); prof.push([noseR(y), y]); }
  const uv = (u, y) => [u, (y - y0) / (y1 - y0)];
  // steel wherever the tiles' edge can leave it showing: the leeward half and 45 degrees past each flank
  const skinGeo = [revolve(prof, { seg: 72, a0: -45 * D2R, a1: 225 * D2R, uv, crease: 12 })];
  // the tiles, and the blunt tip over them
  tiles.push(tileShell(y0));
  const dome = [];
  for (let k = 0; k <= 3; k++) { const y = lerp(SHIP_CYL + 18.5, TIP - 0.25, k / 3); dome.push([noseR(y) + PROUD, y]); }
  dome.push([0.42, TIP - 0.1], [0.24, TIP - 0.025], [0, TIP]);
  tiles.push(revolve(dome, { seg: 24, uv: (u, y) => [u * 2, y / TILE_V], crease: 50 }));
  // aft: skirt lip and wall, engine bay shield
  metal.push(revolve([[R - 0.05, y0], [R + 0.04, y0]], { seg: 72, rgb: DARK_STEEL }), revolve([[R - 0.05, y0 + 2.8], [R - 0.05, y0]], { seg: 72, rgb: DARK_STEEL }));
  metal.push(revolve([[0, y0 + 2.8], [R - 0.05, y0 + 2.8]], { seg: 48, rgb: [0.1, 0.1, 0.11] }));
  // what stands off the leeward steel (shipMarks paints the flat part of each): the raceway's junction box, the clamps over
  // its cables and the boxes at the ends of its branch; vents; the rims of the ports; the pipes of the quick-disconnect plate
  const on = (deg, geo) => atAz(geo, deg * D2R), PAINT = [0.72, 0.71, 0.68];
  metal.push(on(RACEWAY, box(0.24, 1.4, 0.8, [R + 0.1, y0 + 22.6, 0], PAINT)));
  for (let h = 6.0; h < 21.6; h += RING) metal.push(on(RACEWAY, box(0.07, 0.08, 0.5, [R + 0.03, y0 + h, 0], [0.6, 0.6, 0.6])));
  for (const s of [-1, 1]) metal.push(on(RACEWAY + s * 20, box(0.16, 0.85, 0.45, [R + 0.06, y0 + 13.0, 0], [0.62, 0.62, 0.6])));
  for (const [deg, h] of VENTS) metal.push(on(deg, box(0.2, 0.5, 0.32, [R + 0.08, y0 + h, 0], DARK_STEEL)), on(deg, box(0.24, 0.14, 0.2, [R + 0.1, y0 + h - 0.12, 0], PAINT)));
  for (const [deg, h, d] of PORTS) metal.push(on(deg, prim(new THREE.TorusGeometry(d / 2 + 0.05, 0.05, 6, 28), { pos: [R - 0.01, y0 + h, 0], rot: [0, Math.PI / 2, 0], rgb: [0.62, 0.63, 0.65] })));
  for (let i = -2; i <= 2; i++) metal.push(on(90, cyl(0.055, 0.055, 2.3, [R + 0.09, y0 + 1.7, i * 0.27], [0.66, 0.66, 0.64], 6)));
  for (const h of [0.65, 2.85]) metal.push(on(90, box(0.16, 0.16, 1.7, [R + 0.06, y0 + h, 0], DARK_STEEL)));
  // catch pins: one on each flank just under the forward flaps, on a pad among the tiles; they come down on the rails of the tower's arms
  const yp = y0 + PIN.y + PIN.r, rp = noseR(yp);
  for (const d of [0, 180]) metal.push(on(d, cyl(PIN.r, PIN.r, 0.8, [rp + 0.3, yp, 0], [0.3, 0.3, 0.31], 12, [0, 0, Math.PI / 2])), on(d, box(0.1, 0.62, 0.8, [rp + 0.01, yp, 0], BLACK)));

  const group = new THREE.Group(); group.name = 'Ship';
  // flaps: aft pair on the flanks, forward pair on the nose, a little to leeward
  const flaps = [];
  const aftPoly = [[0, 0.6], [4.75, 0.6], [4.75, 10.2], [4.0, 12.0], [1.5, 14.5], [0, 15.2]];
  const fwdPoly = [[0, 0], [3.3, 0.2], [3.45, 4.4], [2.5, 5.9], [0.9, 7.5], [0, 7.9]];
  for (const deg of [0, 180]) {
    const side = deg === 0 ? 1 : -1, p = flap(aftPoly, 0.9, 0.34, side, M);
    p.position.set(...polar(R + 0.12, deg * D2R, y0)); p.rotation.y = deg * D2R;
    flaps.push({ pivot: p, base: p.quaternion.clone(), side, fwd: false }); group.add(p);
  }
  for (const deg of [12, 168]) {
    const side = deg < 90 ? 1 : -1, ya = y0 + 33.6, yb = ya + 7.3, p = flap(fwdPoly, 0.7, 0.28, side, M);
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
    tile: tileMaterial(), flap: flapSteel(),
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
