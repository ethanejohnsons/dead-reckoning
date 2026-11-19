// The main bridge of the starship (model-enterprise.js): the Galaxy-class bridge of "Star Trek: The Next
// Generation" as the set stood in the later seasons, seen from the captain's chair.
//
// Axes are the ship's: -Z forward (toward the main viewer), +Y up, +X starboard, in meters. The origin is on
// the centerline, on the floor of the command area, under the captain's chair. The room is laid out about a
// point 1 m forward of the chair (under the skylight), by angle from dead ahead, clockwise seen from above:
//   - the wall is a ring of flat bays. Ahead, the main viewer in its dark surround. Either side of it an
//     alcove with two doors, a tall black display, a bank of lockers, a door in an alcove at the top of the
//     ramp, and across the back the five aft stations under one band of black glass (from port: Science I,
//     Science II, Environment, Mission Ops, Engineering);
//   - the floor has two levels: the command area and everything forward of it, and the aft level 0.36 m
//     higher, reached by a ramp along either side wall. The carpet is gray, with red round the walls and red
//     under the command area;
//   - the horseshoe is a leaning band of wood that rises from the floor either side of the command seats to
//     the tactical desk behind the captain, over a low paneled wall that holds the aft level back;
//   - ops (port) and conn (starboard) sit between the captain and the viewer: a ribbed seat and a slab of a
//     console on a wedge with lit sides, both on one plate;
//   - above, a deep cornice and a luminous ceiling: a dome of white panels between thin ribs and three broad
//     arms, rising to the round skylight.
//
// The main viewer is an opening in the forward wall with nothing in it: the game draws space first and the
// room after it, so what is ahead of the ship shows there for real. The skylight is open in the same way.
//
// Light. No window lets the sun in, so nothing of the scene's light is used (uSceneK = 0, and what a scene
// light would add as a highlight is thrown away: see roomMat). Every surface carries the baked `lit`
// attribute of the cabins (cabin-kit.js): x is the light that reaches the point from the luminous ceiling, the strips and the lit
// sides of the consoles, and what the surfaces round it bounce back (which also tints its color); y is the glow of
// the displays it can see. All of it is found by casting rays through a grid of small cells filled from the room's
// own triangles (lightRoom), once: the result is kept for the next build. The carpet takes the same
// light as a picture in plan, painted into its map: pools under the dome, the dimmer margins
// and the soft shadows on the floor under everything that stands on it. update() holds all of it steady
// against the picture's exposure. Gloss comes from a small painted panorama of the room itself, used as the
// environment of every material and turned with the ship.
//
// Displays are drawn on canvas in the manner of the show's panels: rounded elbows, bars and blocks of orange,
// lilac and blue, condensed capitals (a plain bold face squeezed sideways). The still ones share one atlas;
// three are live and redraw only when what they show changes (at most two a frame): conn (speed, the helm's
// phrase, the warp field and impulse power), ops (where the ship is, how high, where it is going, how far)
// and the Engineering station on the aft wall (the warp core winding up and running).
//
// Crew. Five generic officers in the duty uniform of the period, nobody in particular: seated at conn and ops, standing
// at tactical and at two of the aft stations. They are lofted like the furniture, take the same baked light and shade
// what is round them; each head is a small mesh of its own, turned a little now and then by update().
//
// buildBridge() -> { root, height, eye, fov, reach, viewer, skylight, update(dt, s), dispose() }.
// viewer = { center, width, height } is the opening of the main viewer in root coordinates.
// update takes s = { time, exposure, speed (m/s), warp, spool, impulse, world, height (m), dest, distance (m),
// helm, orbit }; anything missing counts as zero or empty.

import * as THREE from 'three';
import { TAU, D2R, FONT, BLANK, box, cyl, lerp, clamp01, sstep, rng, canvas, tex, normalFromHeight, disposeTree } from './model-kit.js';
import { cabinLight, cabMat, constLit, boxUv, Parts, meshFrom, plateGeo, Live, flushLive, softPad } from './cabin-kit.js';

// ---------------------------------------------------------------- the plan

const ZC = -1.0;                                   // the room's center (under the skylight), from the captain's chair
const RF = 5.9, RS = 5.0, RA = 5.6;                // the wall's distance from it: ahead, to either side, astern
const UP = 0.36, WALL = 2.6, TOP = 4.2;            // the aft level, the top of the walls, the skylight's rim
const HC = -0.35, HX = 2.85, HZ = 1.6;             // the horseshoe's top edge: an ellipse about (0, HC)
const TIP = 32, DESK = 147;                        // degrees off dead ahead: where the horseshoe's ends touch the floor, where the tactical desk begins
const VIEW = { w: 4.3, h: 2.05, y: 1.5, r: 0.27 }; // the main viewer's opening, the height of its middle, its corners
const EYE = [0, 1.24, 0];
const HELM = { x: 1.28, z: -3.1 };                 // the conn seat (ops mirrors it)

const ONE = [1, 1, 1];
const WALLC = [0.68, 0.56, 0.4], CORN = [0.74, 0.64, 0.47], KICK = [0.11, 0.09, 0.08], MOCHA = [0.2, 0.13, 0.085], DARK = [0.02, 0.02, 0.023];
const PLASTIC = [0.62, 0.52, 0.41], TANP = [0.12, 0.065, 0.035], GRAYP = [0.17, 0.175, 0.19], TANL = [0.6, 0.37, 0.12], METAL = [0.36, 0.36, 0.38], SLED = [0.36, 0.27, 0.18], PANEL = [0.55, 0.47, 0.38], QUILT = [0.5, 0.47, 0.43];

const fold = (a) => Math.abs(((((a / D2R) % 360) + 540) % 360) - 180);       // an angle as degrees off dead ahead, 0..180
const Rw = (a) => { const c = Math.cos(a); return RS + (c > 0 ? RF - RS : RA - RS) * c * c; };
const at = (a, r, y = 0) => [r * Math.sin(a), y, ZC - r * Math.cos(a)];
const floorH = (a) => UP * clamp01((fold(a) - 78) / 50);                      // the floor outside the horseshoe: the ramps, 78 to 128 degrees

const BAYS = (() => {
  const half = [[27, 'falc'], [56, 'tall'], [64, 'lock'], [100, 'plain'], [118, 'aalc'], [144, 'strip'], [149, 'aft'], [161.4, 'aft'], [173.8, 'aft']];
  const deg = [-27, ...half.map((h) => h[0]), 186.2, 198.6, 211, 216, 242, 260, 296, 304, 333];
  const kind = ['viewer', ...half.map((h) => h[1]), 'aft', 'aft', 'strip', 'aalc', 'plain', 'lock', 'tall', 'falc'];
  return kind.map((k, i) => {
    const a0 = deg[i] * D2R, a1 = deg[i + 1] * D2R, p0 = at(a0, Rw(a0)), p1 = at(a1, Rw(a1)), w = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]), tx = (p1[0] - p0[0]) / w, tz = (p1[2] - p0[2]) / w;
    // the bay's own axes: x along the wall (to the right, facing it), y up, z out of the wall into the room
    const M = new THREE.Matrix4().makeBasis(new THREE.Vector3(tx, 0, tz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-tz, 0, tx)).setPosition((p0[0] + p1[0]) / 2, 0, (p0[2] + p1[2]) / 2);
    return { kind: k, a0, a1, p0, p1, w, nin: [-tz, tx], M, f0: floorH(a0), f1: floorH(a1), port: deg[i] > 180 };
  });
})();
/** The wall's distance from the room's center along the ray at angle a. */
function wallR(a) {
  const s = BAYS[0].a0; a = s + ((((a - s) % TAU) + TAU) % TAU);
  const b = BAYS.find((q) => a <= q.a1 + 1e-9) || BAYS[BAYS.length - 1];
  const dx = Math.sin(a), dz = -Math.cos(a), ex = b.p1[0] - b.p0[0], ez = b.p1[2] - b.p0[2];
  return (b.p0[0] * ez - (b.p0[2] - ZC) * ex) / (dx * ez - dz * ex);
}
/** The horseshoe's top edge at parameter a: a point in plan and the way out from the command area. */
const hsAt = (a) => { const tx = HX * Math.cos(a), tz = HZ * Math.sin(a), l = Math.hypot(tx, tz); return { a, p: [HX * Math.sin(a), HC - HZ * Math.cos(a)], n: [tz / l, -tx / l] }; };
const railY = (a) => 0.05 + 1.17 * Math.pow(clamp01((fold(a) - TIP) / 118), 1.05);          // how high that edge stands: from the floor at its ends to the desk
const lean = (a) => 0.025 + 0.42 * (railY(a) - floorH(a));                                    // how far out from under it the band's foot stands
const riserY = (a) => floorH(a) + 0.03 + (0.89 - floorH(a)) * sstep(118, 150, fold(a));           // the top of the low wall inside it
const domeY = (t) => 3.05 + 0.86 * Math.sin((Math.PI / 2) * clamp01((0.82 - t) / 0.62));    // the luminous ceiling, by fraction t of the wall's radius

// ---------------------------------------------------------------- geometry

function geoOf(pos, nor, uv, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Skin a grid of points P[i][j] = [x, y, z]: smooth where neighboring faces meet at less than o.crease degrees, hard where
 * they meet at more. o.closedI / o.closedJ: the grid wraps. The surface faces o.seen (a point) or away from o.away (a point,
 * or (i, j) => point for a body that bends). o.color(i, j) colors a face, o.uv(i, j, p) a corner, o.skip(i, j) leaves a face out.
 */
function skin(P, o = {}) {
  const M = P.length, N = P[0].length, wi = !!o.closedI, wj = !!o.closedJ, QI = wi ? M : M - 1, QJ = wj ? N : N - 1;
  const cr = Math.cos((o.crease ?? 32) * D2R), qn = new Float64Array(QI * QJ * 3), pt = (i, j) => P[i % M][j % N], seen = o.seen || [0, 1.4, ZC];
  let vote = 0;
  for (let i = 0; i < QI; i++) for (let j = 0; j < QJ; j++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2], vx = d[0] - b[0], vy = d[1] - b[1], vz = d[2] - b[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    const k = (i * QJ + j) * 3; qn[k] = nx / l; qn[k + 1] = ny / l; qn[k + 2] = nz / l;
    const mx = (a[0] + b[0] + c[0] + d[0]) / 4, my = (a[1] + b[1] + c[1] + d[1]) / 4, mz = (a[2] + b[2] + c[2] + d[2]) / 4;
    if (o.away) { const w = typeof o.away === 'function' ? o.away(i, j) : o.away; vote += nx * (mx - w[0]) + ny * (my - w[1]) + nz * (mz - w[2]); }
    else vote += nx * (seen[0] - mx) + ny * (seen[1] - my) + nz * (seen[2] - mz);
  }
  const sg = (vote < 0 ? -1 : 1) * (o.flip ? -1 : 1), pos = [], nor = [], uv = [], col = [], rgb = o.rgb || ONE;
  const put = (i, j, k0, c) => {
    const p = pt(i, j); let x = 0, y = 0, z = 0;
    for (let di = -1; di <= 0; di++) for (let dj = -1; dj <= 0; dj++) {
      let qi = i + di, qj = j + dj;
      if (wi) qi = (qi + QI) % QI; else if (qi < 0 || qi >= QI) continue;
      if (wj) qj = (qj + QJ) % QJ; else if (qj < 0 || qj >= QJ) continue;
      const k = (qi * QJ + qj) * 3;
      if (qn[k] * qn[k0] + qn[k + 1] * qn[k0 + 1] + qn[k + 2] * qn[k0 + 2] > cr) { x += qn[k]; y += qn[k + 1]; z += qn[k + 2]; }
    }
    const l = sg / (Math.hypot(x, y, z) || 1);
    pos.push(p[0], p[1], p[2]); nor.push(x * l, y * l, z * l); col.push(c[0], c[1], c[2]);
    const t = o.uv ? o.uv(i, j, p) : BLANK; uv.push(t[0], t[1]);
  };
  for (let i = 0; i < QI; i++) for (let j = 0; j < QJ; j++) {
    const k0 = (i * QJ + j) * 3;
    if ((qn[k0] === 0 && qn[k0 + 1] === 0 && qn[k0 + 2] === 0) || (o.skip && o.skip(i, j))) continue;
    const c = o.color ? o.color(i, j) : rgb, A = [i, j], B = [i + 1, j], C = [i + 1, j + 1], D = [i, j + 1];
    for (const [vi, vj] of sg > 0 ? [A, B, C, A, C, D] : [A, C, B, A, D, C]) put(vi, vj, k0, c);
  }
  return geoOf(pos, nor, uv, col);
}
/** One flat face a, b, c, d (in order round it); o as for skin(), o.uv(i, j) with (0,0) = a, (1,0) = b, (1,1) = c, (0,1) = d. */
const quad = (a, b, c, d, rgb, o = {}) => skin([[a, d], [b, c]], { rgb, ...o });
/** A flat face (its outline seen whole from its middle) that looks away from the point `away`. */
function cap(pts, away, rgb = ONE) {
  const n = pts.length, m = [0, 0, 0], pos = [], nor = [], uv = [], col = [];
  for (const p of pts) { m[0] += p[0] / n; m[1] += p[1] / n; m[2] += p[2] / n; }
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
  const l = Math.hypot(nx, ny, nz) || 1, fl = nx * (m[0] - away[0]) + ny * (m[1] - away[1]) + nz * (m[2] - away[2]) < 0, s = (fl ? -1 : 1) / l;
  for (let i = 0; i < n; i++) for (const p of fl ? [m, pts[(i + 1) % n], pts[i]] : [m, pts[i], pts[(i + 1) % n]]) { pos.push(p[0], p[1], p[2]); nor.push(nx * s, ny * s, nz * s); uv.push(BLANK[0], BLANK[1]); col.push(rgb[0], rgb[1], rgb[2]); }
  return geoOf(pos, nor, uv, col);
}
/** Stand a section [[u, y], ...] (or (sample, i) => section) on each sample { p: [x, z], n: [nx, nz] } of a path in plan: u runs along n. */
const stand = (samples, section) => samples.map((s, i) => (typeof section === 'function' ? section(s, i) : section).map(([u, y]) => [s.p[0] + s.n[0] * u, y, s.p[1] + s.n[1] * u]));
/** Round the corners of a section [[u, y], ...] to radius r (n steps each). Each point of the result carries the index of the
 *  corner it came from as its third number, so a face can still be colored by the stretch of the section it belongs to. */
function fillet(pts, r, n = 3, closed = false) {
  const out = [], N = pts.length;
  for (let i = 0; i < N; i++) {
    const p = pts[i], a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    if (!closed && (i === 0 || i === N - 1)) { out.push([p[0], p[1], i]); continue; }
    const ax = a[0] - p[0], ay = a[1] - p[1], bx = b[0] - p[0], by = b[1] - p[1], la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), d = Math.min(r, la * 0.45, lb * 0.45);
    if (d < 1e-4) { out.push([p[0], p[1], i]); continue; }
    const s = [p[0] + (ax / la) * d, p[1] + (ay / la) * d], e = [p[0] + (bx / lb) * d, p[1] + (by / lb) * d];
    for (let k = 0; k <= n; k++) { const t = k / n, u = 1 - t; out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1], k < n ? i - 1 + (i === 0 ? N : 0) : i]); }
  }
  return out;
}
/** A rectangle w by h about the origin with corners of radius r, counterclockwise from the right. */
function rrect(w, h, r, n = 4) {
  const out = []; r = Math.max(1e-3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3));
  [[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sy], k) => { for (let i = 0; i <= n; i++) { const a = ((k + i / n) * Math.PI) / 2; out.push([sx * (w / 2 - r) + r * Math.cos(a), sy * (h / 2 - r) + r * Math.sin(a)]); } });
  return out;
}
/** A block with rounded upright edges and a softened top, standing on y0 about the origin: w across (x), d deep (z). */
function rbox(w, d, y0, y1, r, rgb, top = true) {
  const e = Math.min(0.014, (y1 - y0) * 0.3), P = [rrect(w, d, r).map(([x, z]) => [x, y0, z]), rrect(w, d, r).map(([x, z]) => [x, y1 - e, z]), rrect(w - 2 * e, d - 2 * e, Math.max(0.004, r - e)).map(([x, z]) => [x, y1, z])];
  const g = [skin(P, { closedJ: true, away: [0, (y0 + y1) / 2, 0], rgb, crease: 50 })];
  if (top) g.push(cap(P[2], [0, y0, 0], rgb));
  return g;
}
/** A slab with a rounded outline lying in its own XY plane (w by h, corners r), t thick, its edge rounded right over: a console's top. */
function slab(w, h, r, t, rgb) {
  const e = t / 2, P = [];
  for (let k = 0; k <= 6; k++) { const f = -Math.PI / 2 + (Math.PI * k) / 6, q = e * (1 - Math.cos(f)); P.push(rrect(w - 2 * q, h - 2 * q, Math.max(0.004, r - q), 5).map(([x, y]) => [x, y, -e + e * Math.sin(f)])); }
  return [skin(P, { closedJ: true, away: [0, 0, -e], rgb, crease: 50 }), cap(P[6], [0, 0, -t], rgb), cap(P[0], [0, 0, 0], rgb)];
}
/** A surface turned about a vertical axis: prof [[r, y], ...] from the floor up. */
function lathe(prof, rgb, seg = 18) {
  return skin(prof.map(([r, y]) => Array.from({ length: seg }, (_, k) => [r * Math.cos((k / seg) * TAU), y, r * Math.sin((k / seg) * TAU)])), { closedJ: true, away: [0, prof[prof.length >> 1][1], 0], rgb, crease: 40 });
}
/** A stretch of wall in a bay's own axes from x0 to x1, cut fine enough for the light to fall off across it. rows: [[z, y, rel], ...]
 *  from the floor up (rel: y is measured from the floor, which stands at f0 at x0 and f1 at x1); cols: a color for each gap. */
function wallGrid(x0, x1, f0, f1, rows, cols, step = 0.16) {
  const nc = Math.max(1, Math.ceil((x1 - x0) / step)), sub = [], cmap = [], P = [];
  for (let j = 0; j < rows.length - 1; j++) { const ya = rows[j][1] + (rows[j][2] ? f0 : 0), yb = rows[j + 1][1] + (rows[j + 1][2] ? f0 : 0), n = Math.max(1, Math.ceil(Math.hypot(yb - ya, rows[j + 1][0] - rows[j][0]) / step)); sub.push(n); for (let k = 0; k < n; k++) cmap.push(j); }
  for (let i = 0; i <= nc; i++) {
    const e = i / nc, x = lerp(x0, x1, e), f = lerp(f0, f1, e), col = [];
    for (let j = 0; j < rows.length; j++) {
      const a = rows[j], ya = a[1] + (a[2] ? f : 0); col.push([x, ya, a[0]]);
      if (j < rows.length - 1) { const b = rows[j + 1], yb = b[1] + (b[2] ? f : 0); for (let k = 1; k < sub[j]; k++) col.push([x, lerp(ya, yb, k / sub[j]), lerp(a[0], b[0], k / sub[j])]); }
    }
    P.push(col);
  }
  return skin(P, { seen: [(x0 + x1) / 2, 1.4, 3], color: (i, j) => cols[cmap[j]], crease: 20 });
}
/** A flat panel in a bay's own axes (x0..x1, y0..y1 at depth z), cut into a grid, with texture coordinates from uv(s, t) (0..1 across, up). */
const panel = (x0, y0, x1, y1, z, uv, rgb = ONE, step = 0.3) => plateGeo(x0, y0, x1, y1, Math.max(1, Math.ceil((x1 - x0) / step)), Math.max(1, Math.ceil((y1 - y0) / step)), uv ? (x, y) => uv((x - x0) / (x1 - x0), (y - y0) / (y1 - y0)) : () => BLANK, [], z, rgb);
const place = (x, z, yaw = 0, y = 0) => new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);

// ---------------------------------------------------------------- display graphics

const LC = { or: '#ff9d1e', go: '#ffcc66', pe: '#ffc48f', li: '#cc99cc', vi: '#9a8fd6', bl: '#8f9fff', sk: '#99ccff', re: '#d8695a', off: '#2a2140' };
const fontOf = (px, w = 700) => `${w} ${px}px ${FONT}`;
/** Condensed capitals: a bold face squeezed sideways. */
function lt(g, s, x, y, px, col, align = 'left', sq = 0.62) {
  g.save(); g.translate(x, y); g.scale(sq, 1); g.font = fontOf(px); g.textAlign = align; g.textBaseline = 'middle'; g.fillStyle = col; g.fillText(s, 0, px * 0.05); g.restore();
}
const ltw = (g, s, px, sq = 0.62) => { g.font = fontOf(px); return g.measureText(s).width * sq; };
/** The same, squeezed further if it would run past maxW. */
function ltFit(g, s, x, y, px, col, maxW, align = 'left') { const w = ltw(g, s, px); lt(g, s, x, y, px, col, align, w > maxW ? (0.62 * maxW) / w : 0.62); }
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
/** A bar with rounded ends (l, r: which ends). */
function pill(g, x, y, w, h, col, l = 1, r = 1) {
  const q = h / 2; g.beginPath(); g.moveTo(x + (l ? q : 0), y); g.lineTo(x + w - (r ? q : 0), y);
  if (r) g.arc(x + w - q, y + q, q, -Math.PI / 2, Math.PI / 2); else g.lineTo(x + w, y + h);
  g.lineTo(x + (l ? q : 0), y + h); if (l) g.arc(x + q, y + q, q, Math.PI / 2, Math.PI * 1.5);
  g.closePath(); g.fillStyle = col; g.fill();
}
/** An elbow: from its outer corner (x, y) a bar bw wide runs ly along y and a bar bh thick runs lx along x; sx, sy: which way. */
function elbow(g, x, y, lx, ly, bw, bh, sx, sy, col) {
  const R = Math.min(bw * 0.85, bh * 2.4), r = Math.min(bh * 1.2, R * 0.6);
  g.save(); g.translate(x, y); g.scale(sx, sy); g.beginPath();
  g.moveTo(0, ly); g.lineTo(0, R); g.arcTo(0, 0, R, 0, R); g.lineTo(lx, 0); g.lineTo(lx, bh); g.lineTo(bw + r, bh); g.arcTo(bw, bh, bw, bh + r, r); g.lineTo(bw, ly); g.closePath();
  g.fillStyle = col; g.fill(); g.restore();
}
/** The frame of a wall display: elbows at the top and bottom left with numbered blocks between them, bars along the top and the
 *  bottom, the title at the top right. Returns the clear area [x, y, w, h]. */
function lcFrame(g, W, H, title, rnd, pal) {
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const m = Math.round(W * 0.025), bw = Math.round(W * 0.17), bh = Math.round(H * 0.052), gp = Math.max(3, Math.round(W * 0.012)), ex = W * 0.34;
  const yA = Math.round(H * 0.3), yB = Math.round(H * 0.74), px = Math.round(bh * 0.66);
  const code = () => `${Math.floor(rnd() * 90 + 10)}-${Math.floor(rnd() * 9000 + 1000)}`;
  elbow(g, m, m, ex, yA - m, bw, bh, 1, 1, pal[0]); elbow(g, m, H - m, ex, H - m - yB, bw, bh, 1, -1, pal[1]);
  lt(g, code(), m + bw - 5, yA - px * 0.8, px, '#000', 'right'); lt(g, code(), m + bw - 5, yB + px * 0.8, px, '#000', 'right');
  let y = yA + gp; const cuts = [0.3, 0.2, 0.5];
  cuts.forEach((f, k) => { const h = (yB - yA - gp * (cuts.length + 1)) * f; g.fillStyle = pal[(k + 2) % pal.length]; g.fillRect(m, y, bw, h); lt(g, code(), m + bw - 5, y + h - px * 0.8, px, '#000', 'right'); y += h + gp; });
  let x = m + ex + gp;
  for (const [f, c] of [[0.16, pal[2]], [0.05, pal[3]]]) { g.fillStyle = c; g.fillRect(x, m, W * f, bh); x += W * f + gp; }
  lt(g, title, W - m, m + bh * 0.55, bh * 1.5, pal[0], 'right');
  x = m + ex + gp;
  for (const [f, c] of [[0.1, pal[3]], [0.26, pal[2]]]) { g.fillStyle = c; g.fillRect(x, H - m - bh, W * f, bh); x += W * f + gp; }
  pill(g, x, H - m - bh, W - m - x, bh, pal[4], 0, 1);
  return [m + bw + gp * 2.5, m + bh + gp * 3, W - m * 2 - bw - gp * 2.5, H - 2 * (m + bh + gp * 3)];
}
/** A column of figures, right-aligned. */
function figures(g, x, y, w, h, rnd, px = 15, cols = [LC.pe, LC.vi, LC.or, LC.sk]) {
  const n = Math.floor(h / (px * 1.25));
  for (let k = 0; k < n; k++) { const d = 3 + Math.floor(rnd() * 5); let s = ''; for (let q = 0; q < d; q++) s += Math.floor(rnd() * 10); lt(g, s, x + w, y + (k + 0.5) * px * 1.25, px, cols[Math.floor(rnd() * cols.length)], 'right'); }
}
/** The ship from above, bow up, s pixels long. */
function shipPlan(g, cx, cy, s, col) {
  g.strokeStyle = col; g.lineWidth = Math.max(1.5, s * 0.009); g.fillStyle = 'rgba(153,204,255,0.16)';
  for (const sx of [-1, 1]) { rr(g, cx + sx * s * 0.2 - s * 0.035, cy + s * 0.08, s * 0.07, s * 0.42, s * 0.03); g.fill(); g.stroke(); g.beginPath(); g.moveTo(cx + sx * s * 0.07, cy + s * 0.27); g.lineTo(cx + sx * s * 0.165, cy + s * 0.31); g.stroke(); }
  g.beginPath(); g.ellipse(cx, cy + s * 0.2, s * 0.085, s * 0.2, 0, 0, TAU); g.fillStyle = '#000'; g.fill(); g.fillStyle = 'rgba(153,204,255,0.16)'; g.fill(); g.stroke();
  g.beginPath(); g.ellipse(cx, cy - s * 0.2, s * 0.36, s * 0.3, 0, 0, TAU); g.fillStyle = '#000'; g.fill(); g.fillStyle = 'rgba(153,204,255,0.16)'; g.fill(); g.stroke();
  g.lineWidth = Math.max(1, s * 0.005); for (const k of [0.62, 0.3]) { g.beginPath(); g.ellipse(cx, cy - s * 0.2, s * 0.36 * k, s * 0.3 * k, 0, 0, TAU); g.stroke(); }
}
/** A console's keys: a bar along the top and clusters of rounded keys under it. */
function drawKeys(g, W, H, rnd, pal) {
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const m = 5, bh = Math.round(H * 0.13);
  pill(g, m, m, W * 0.3, bh, pal[0], 1, 0); g.fillStyle = pal[1]; g.fillRect(m + W * 0.3 + 4, m, W * 0.2, bh); pill(g, m + W * 0.5 + 8, m, W * 0.5 - 2 * m - 8, bh, pal[2], 0, 1);
  let x = m; const y0 = m + bh + 7, kh = (H - y0 - m - 8) / 3;
  for (const n of [4, 3, 5, 3]) {
    const cw = ((W - 2 * m) * n) / 15 - 7, kw = (cw - (n - 1) * 3) / n;
    for (let r = 0; r < 3; r++) for (let c = 0; c < n; c++) { rr(g, x + c * (kw + 3), y0 + r * (kh + 4), kw, kh, Math.min(kh, kw) * 0.32); g.fillStyle = rnd() < 0.14 ? LC.off : pal[Math.floor(rnd() * pal.length)]; g.fill(); }
    x += cw + 7;
  }
}

/** A tall wall display: a frame down one side, a column of blocks, an emblem. */
function drawTall(g, w, h, rnd, pal, emblem) {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  elbow(g, 6, 6, w * 0.8, h * 0.16, w * 0.3, 12, 1, 1, pal[0]); elbow(g, 6, h - 6, w * 0.8, h * 0.12, w * 0.3, 12, 1, -1, pal[1]);
  let y = h * 0.16 + 12; for (let k = 0; k < 5; k++) { const bh = (h * 0.72 - 40) * [0.14, 0.3, 0.1, 0.26, 0.2][k]; g.fillStyle = pal[(k + 2) % pal.length]; g.fillRect(6, y, w * 0.3, bh); y += bh + 5; }
  const cx = w * 0.66, cy = h * 0.34;
  if (emblem) { g.fillStyle = LC.go; g.beginPath(); g.moveTo(cx, cy - 34); g.quadraticCurveTo(cx + 26, cy + 6, cx + 20, cy + 30); g.quadraticCurveTo(cx, cy + 12, cx - 20, cy + 30); g.quadraticCurveTo(cx - 26, cy + 6, cx, cy - 34); g.fill(); g.strokeStyle = LC.go; g.lineWidth = 3; g.beginPath(); g.ellipse(cx, cy + 2, 34, 22, 0, 0, TAU); g.stroke(); }
  else for (let k = 0; k < 7; k++) { g.fillStyle = pal[k % pal.length]; rr(g, w * 0.44, h * 0.2 + k * 26, w * 0.46, 20, 8); g.fill(); }
  for (let k = 0; k < 9; k++) { rr(g, w * 0.44 + (k % 2) * w * 0.25, h * 0.58 + Math.floor(k / 2) * 24, w * 0.21, 18, 6); g.fillStyle = rnd() < 0.2 ? LC.off : pal[Math.floor(rnd() * pal.length)]; g.fill(); }
}

/** The still displays, on one canvas. uv(name) gives (s, t) => texture coordinate over that display (s right, t up). */
function buildAtlas() {
  const W = 2048, H = 1024, [c, g] = canvas(W, H, '#000'), R = {};
  const region = (name, x, y, w, h, draw) => { R[name] = [x, y, w, h]; g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(w, h, rng(name.length * 131 + x + y * 7)); g.restore(); };
  region('sci1', 0, 0, 480, 404, (w, h, rnd) => {
    const [x, y, cw, ch] = lcFrame(g, w, h, 'SCIENCE I', rnd, [LC.or, LC.li, LC.vi, LC.pe, LC.bl]), gw = cw * 0.68;
    for (let k = 0; k < 3; k++) {
      const gy = y + (ch * k) / 3 + 5, gh = ch / 3 - 12;
      g.strokeStyle = 'rgba(143,159,255,0.4)'; g.lineWidth = 1; g.beginPath();
      for (let q = 0; q <= 6; q++) { const xx = x + (gw * q) / 6; g.moveTo(xx, gy); g.lineTo(xx, gy + gh); }
      for (let q = 0; q <= 2; q++) { const yy = gy + (gh * q) / 2; g.moveTo(x, yy); g.lineTo(x + gw, yy); }
      g.stroke();
      g.strokeStyle = [LC.go, LC.sk, LC.re][k]; g.lineWidth = 2.4; g.beginPath();
      const f1 = 2 + rnd() * 4, f2 = 7 + rnd() * 9, p1 = rnd() * 6, p2 = rnd() * 6;
      for (let q = 0; q <= 70; q++) { const u = q / 70, v = 0.5 + 0.3 * Math.sin(u * f1 * TAU + p1) * Math.sin(u * 3.1 + p2) + 0.14 * Math.sin(u * f2 * TAU + p2); if (q) g.lineTo(x + gw * u, gy + gh * v); else g.moveTo(x + gw * u, gy + gh * v); }
      g.stroke();
    }
    figures(g, x + gw + 8, y, cw - gw - 8, ch, rnd);
  });
  region('sci2', 484, 0, 480, 404, (w, h, rnd) => {
    const [x, y, cw, ch] = lcFrame(g, w, h, 'SCIENCE II', rnd, [LC.vi, LC.or, LC.pe, LC.bl, LC.li]), cx = x + cw * 0.4, cy = y + ch * 0.5;
    g.strokeStyle = 'rgba(143,159,255,0.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, cy); g.lineTo(x + cw * 0.8, cy); g.moveTo(cx, y); g.lineTo(cx, y + ch); g.stroke();
    for (let k = 1; k <= 5; k++) {
      const rx = cw * 0.075 * k, ry = rx * 0.62, a = rnd() * TAU;
      g.strokeStyle = k === 3 ? LC.or : LC.vi; g.lineWidth = k === 3 ? 2.2 : 1.4; g.beginPath(); g.ellipse(cx, cy, rx, ry, -0.3, 0, TAU); g.stroke();
      const px = cx + rx * Math.cos(a) * Math.cos(0.3) + ry * Math.sin(a) * Math.sin(0.3), py = cy - rx * Math.cos(a) * Math.sin(0.3) + ry * Math.sin(a) * Math.cos(0.3);
      g.fillStyle = [LC.sk, LC.pe, LC.go, LC.re, LC.sk][k - 1]; g.beginPath(); g.arc(px, py, 3 + (k % 3) * 1.6, 0, TAU); g.fill();
      if (k === 3) { g.strokeStyle = LC.go; g.lineWidth = 1.5; g.strokeRect(px - 11, py - 11, 22, 22); lt(g, 'SOL III', px + 16, py - 12, 15, LC.go); }
    }
    g.fillStyle = LC.or; g.beginPath(); g.arc(cx, cy, 7, 0, TAU); g.fill();
    lt(g, 'SECTOR 001', x + 2, y + 10, 18, LC.pe); figures(g, x + cw * 0.82, y, cw * 0.18, ch, rnd);
  });
  region('env', 968, 0, 480, 404, (w, h, rnd) => {
    const [x, y, cw, ch] = lcFrame(g, w, h, 'ENVIRONMENT', rnd, [LC.pe, LC.bl, LC.or, LC.li, LC.vi]), n = 11, rh = ch / n;
    for (let k = 0; k < n; k++) {
      const yy = y + k * rh, v = 0.35 + 0.6 * rnd(), bx = x + cw * 0.24, bw = cw * 0.56;
      lt(g, 'DECK ' + String(k * 4 + 1).padStart(2, '0'), x, yy + rh * 0.5, 15, LC.vi);
      g.fillStyle = LC.off; g.fillRect(bx, yy + rh * 0.22, bw, rh * 0.56); g.fillStyle = v > 0.86 ? LC.or : k % 3 ? LC.bl : LC.li; g.fillRect(bx, yy + rh * 0.22, bw * v, rh * 0.56);
      lt(g, (v * 100).toFixed(1), x + cw, yy + rh * 0.5, 15, LC.pe, 'right');
    }
  });
  region('ops2', 1452, 0, 480, 404, (w, h, rnd) => {
    const [x, y, cw, ch] = lcFrame(g, w, h, 'MISSION OPS', rnd, [LC.li, LC.or, LC.bl, LC.pe, LC.vi]);
    shipPlan(g, x + cw * 0.34, y + ch * 0.5, ch * 0.96, LC.sk);
    for (const [fx, fy, cc] of [[0.34, 0.3, LC.or], [0.2, 0.36, LC.go], [0.5, 0.24, LC.re], [0.34, 0.72, LC.go], [0.145, 0.74, LC.or], [0.535, 0.74, LC.or]]) { g.fillStyle = cc; g.fillRect(x + cw * fx - 4, y + ch * fy - 4, 8, 8); }
    ['SENSORS', 'COMM', 'TRANSPORT', 'DEFLECTOR', 'SHUTTLEBAY', 'IMPULSE', 'WARP'].forEach((s, k) => { const yy = y + 8 + k * ch * 0.14; pill(g, x + cw * 0.7, yy, cw * 0.3, ch * 0.1, [LC.bl, LC.li, LC.pe][k % 3]); lt(g, s, x + cw - 10, yy + ch * 0.052, 15, '#000', 'right'); });
  });
  const P1 = [LC.or, LC.li, LC.bl, LC.pe, LC.vi], P2 = [LC.vi, LC.pe, LC.or, LC.bl, LC.go];
  region('keys', 0, 408, 480, 200, (w, h, rnd) => drawKeys(g, w, h, rnd, P1)); region('keys2', 484, 408, 480, 200, (w, h, rnd) => drawKeys(g, w, h, rnd, P2));
  region('tact', 968, 408, 480, 200, (w, h, rnd) => { drawKeys(g, w, h, rnd, [LC.go, LC.or, LC.pe, LC.re, LC.li]); g.fillStyle = '#000'; g.fillRect(w * 0.36, h * 0.24, w * 0.28, h * 0.7); g.strokeStyle = LC.or; g.lineWidth = 3; for (const r of [0.3, 0.2, 0.1]) { g.beginPath(); g.arc(w / 2, h * 0.6, h * r, 0, TAU); g.stroke(); } g.fillStyle = LC.re; g.fillRect(w / 2 - 4, h * 0.6 - 4, 8, 8); });
  region('tact2', 1452, 408, 480, 200, (w, h, rnd) => drawKeys(g, w, h, rnd, [LC.pe, LC.go, LC.bl, LC.or, LC.re]));
  region('tall1', 0, 612, 136, 408, (w, h, rnd) => drawTall(g, w, h, rnd, P1, true)); region('tall2', 140, 612, 136, 408, (w, h, rnd) => drawTall(g, w, h, rnd, P2, false));
  region('vstrip', 280, 612, 44, 408, (w, h, rnd) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); pill(g, 8, 6, w - 16, 40, LC.or); let y = 54; for (let k = 0; k < 9; k++) { const bh = 20 + rnd() * 34; g.fillStyle = [LC.or, LC.go, LC.pe][k % 3]; g.fillRect(8, y, w - 16, bh); y += bh + 5; } });
  for (const [name, x, pal] of [['ledge1', 330, P1], ['ledge2', 734, P2]]) region(name, x, 612, 400, 110, (w, h, rnd) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); pill(g, 6, 6, w * 0.34, 20, pal[0], 1, 0); g.fillStyle = pal[1]; g.fillRect(w * 0.34 + 10, 6, w * 0.3, 20); pill(g, w * 0.64 + 14, 6, w * 0.36 - 20, 20, pal[2], 0, 1); for (let k = 0; k < 14; k++) { rr(g, 8 + (k % 7) * (w - 16) / 7, 36 + Math.floor(k / 7) * 36, (w - 16) / 7 - 6, 28, 9); g.fillStyle = rnd() < 0.15 ? LC.off : pal[Math.floor(rnd() * pal.length)]; g.fill(); } });
  for (const [name, x] of [['side', 330], ['side2', 600]]) region(name, x, 730, 264, 180, (w, h, rnd) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h); elbow(g, 5, 5, 96, 100, 46, 18, 1, 1, LC.or); g.fillStyle = LC.li; g.fillRect(5, 110, 46, 64); g.fillStyle = LC.pe; g.fillRect(108, 5, 80, 18); pill(g, 194, 5, 64, 18, LC.vi, 0, 1);
    for (let r = 0; r < 4; r++) for (let q = 0; q < 5; q++) { rr(g, 62 + q * 40, 36 + r * 35, 34, 28, 9); g.fillStyle = rnd() < 0.15 ? LC.off : [LC.bl, LC.pe, LC.or, LC.li][Math.floor(rnd() * 4)]; g.fill(); }
  });
  region('arm', 870, 730, 130, 200, (w, h, rnd) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h); pill(g, 6, 6, w - 12, 18, LC.or);
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) { rr(g, 9 + q * 39, 34 + r * 31, 34, 25, 8); g.fillStyle = r === 4 && q === 2 ? LC.re : rnd() < 0.12 ? LC.off : [LC.pe, LC.li, LC.bl, LC.go][Math.floor(rnd() * 4)]; g.fill(); }
  });
  const t = tex(c, true); t.anisotropy = 16;
  return { tex: t, canvas: c, uv: (name) => { const [x, y, w, h] = R[name]; return (s, v) => [(x + 0.5 + s * (w - 1)) / W, 1 - (y + 0.5 + (1 - v) * (h - 1)) / H]; } };
}

// ---- the three live displays

const MPH = 2.23694, MI = 1609.344, FT = 3.28084, AU = 149597870700, LIGHT = 299792458;
const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
/** A speed as [figure, unit, the same another way]. */
function speedText(v, warp) {
  const c = v / LIGHT, mis = v / MI, mph = v * MPH;
  if (warp > 0) return ['WARP ' + (Math.abs(warp - Math.round(warp)) < 0.05 ? Math.round(warp) : warp.toFixed(1)), '', (c >= 100 ? fmtInt(c) : c.toFixed(1)) + ' × LIGHT'];
  if (mph < 100000) return [fmtInt(mph), 'MPH', (mis < 10 ? mis.toFixed(2) : mis.toFixed(1)) + ' MI/S'];
  if (c < 0.01) return [mis < 100 ? mis.toFixed(1) : fmtInt(mis), 'MI/S', (c * 100).toFixed(c < 0.001 ? 3 : 2) + '% OF LIGHT'];
  return [c.toFixed(c < 0.1 ? 3 : 2), 'OF LIGHT', fmtInt(mis) + ' MI/S'];
}
/** A distance in feet, miles, millions of miles or astronomical units, as [figure, unit]. */
function distText(m) {
  const ft = m * FT, mi = m / MI;
  if (ft < 10000) return [fmtInt(ft), 'FT'];
  if (mi < 100) return [mi.toFixed(1), 'MI'];
  if (mi < 1e6) return [fmtInt(mi), 'MI'];
  if (m < 0.1 * AU) return [(mi / 1e6).toFixed(2), 'MILLION MI'];
  const au = m / AU; return [au < 10 ? au.toFixed(2) : au.toFixed(1), 'AU'];
}
const hash = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };

// From the captain's chair each of these consoles is seen past its own seat: the half nearer the centerline is the half in plain
// view, so conn (to starboard) carries its figures on the left and ops (to port) on the right.
const LW = 1024, LH = 512, EW = 512, EH = 432;
function drawConn(g, s) {
  g.fillStyle = '#000'; g.fillRect(0, 0, LW, LH);
  elbow(g, 10, 10, 190, 190, 110, 34, 1, 1, LC.or); lt(g, 'CONN', 112, 172, 40, '#000', 'right');
  g.fillStyle = LC.li; g.fillRect(10, 208, 110, 90); lt(g, '02-1701', 112, 280, 22, '#000', 'right');
  elbow(g, 10, 502, 190, 196, 110, 26, 1, -1, LC.vi);
  g.fillStyle = LC.pe; g.fillRect(208, 10, 190, 34); lt(g, 'FLIGHT CONTROL', 410, 28, 40, LC.or);
  g.fillStyle = LC.bl; g.fillRect(208, 476, 190, 26); pill(g, 406, 476, 150, 26, LC.pe, 0, 1);
  lt(g, 'VELOCITY', 146, 92, 36, LC.vi); ltFit(g, s.v[0], 144, 182, 150, LC.go, 420);
  const uw = s.v[1] ? ltw(g, s.v[1], 50) + 22 : 0; if (s.v[1]) lt(g, s.v[1], 146, 286, 50, LC.or); ltFit(g, s.v[2], 146 + uw, 288, 40, LC.li, 420 - uw);
  pill(g, 142, 348, 430, 84, s.helm ? LC.or : LC.off); ltFit(g, s.helm || 'HELM STANDING BY', 178, 391, 54, s.helm ? '#000' : LC.vi, 360);
  lt(g, 'WARP FIELD', 612, 92, 36, LC.sk);
  for (let k = 0; k < 12; k++) { const x = 612 + k * 33, lv = s.bars[k], h = Math.round(200 * lv); g.fillStyle = LC.off; g.fillRect(x, 124, 24, 200); g.fillStyle = lv > 0.85 ? LC.or : k % 3 === 2 ? LC.li : LC.bl; g.fillRect(x, 324 - h, 24, h); }
  lt(g, 'IMPULSE', 612, 366, 34, LC.sk); lt(g, Math.round(s.imp * 100) + '%', 1004, 366, 34, LC.pe, 'right');
  g.fillStyle = LC.off; g.fillRect(612, 392, 392, 36); g.fillStyle = LC.re; g.fillRect(612, 392, 392 * s.imp, 36);
  for (let k = 1; k < 8; k++) { g.fillStyle = '#000'; g.fillRect(612 + k * 49, 392, 4, 36); }
  for (let k = 0; k < 8; k++) { rr(g, 612 + k * 49, 446, 43, 50, 12); g.fillStyle = [LC.pe, LC.bl, LC.li, LC.or][k % 4]; g.fill(); }
}
function drawOps(g, s) {
  g.fillStyle = '#000'; g.fillRect(0, 0, LW, LH);
  elbow(g, LW - 10, 10, 190, 190, 110, 34, -1, 1, LC.li); lt(g, 'OPS', LW - 20, 172, 40, '#000', 'right');
  g.fillStyle = LC.or; g.fillRect(LW - 120, 208, 110, 90); lt(g, '04-2364', LW - 20, 280, 22, '#000', 'right');
  elbow(g, LW - 10, 502, 190, 196, 110, 26, -1, -1, LC.bl);
  g.fillStyle = LC.vi; g.fillRect(LW - 398, 10, 190, 34); g.fillStyle = LC.pe; g.fillRect(LW - 398, 476, 190, 26);
  const x = 548, mw = 330, fig = (v, y) => { if (v) { const w = Math.min(ltw(g, v[0], 62), mw * 0.6); ltFit(g, v[0], x, y, 62, LC.pe, mw * 0.6); ltFit(g, v[1], x + w + 12, y + 8, 36, LC.or, mw - w - 12); } else lt(g, '—', x, y, 62, LC.vi); };
  lt(g, 'POSITION', x + 2, 72, 30, LC.vi); ltFit(g, s.world || 'DEEP SPACE', x, 128, 88, LC.go, mw); lt(g, 'ALTITUDE', x + 2, 186, 24, LC.vi); fig(s.alt, 226);
  lt(g, 'DESTINATION', x + 2, 284, 30, LC.vi); ltFit(g, s.dest || 'NO COURSE', x, 340, 88, s.dest ? LC.or : LC.vi, mw); lt(g, 'RANGE', x + 2, 398, 24, LC.vi); fig(s.rng, 438);
  // the far half: status and keys
  pill(g, 16, 10, 190, 34, LC.or, 1, 0); g.fillStyle = LC.pe; g.fillRect(214, 10, 120, 34); lt(g, 'OPERATIONS', 346, 28, 40, LC.li);
  pill(g, 16, 64, 480, 60, s.orbit ? LC.go : LC.off); lt(g, s.orbit ? 'STANDARD ORBIT' : 'UNDER WAY', 46, 95, 40, s.orbit ? '#000' : LC.vi);
  const rnd = rng(12); for (let r = 0; r < 5; r++) for (let q = 0; q < 8; q++) { rr(g, 16 + q * 61, 144 + r * 66, 53, 56, 14); g.fillStyle = rnd() < 0.14 ? LC.off : [LC.bl, LC.pe, LC.li, LC.or, LC.vi][Math.floor(rnd() * 5)]; g.fill(); }
  pill(g, 16, 476, 480, 26, LC.vi);
}
function drawEng(g, s) {
  const [x, y, w, h] = lcFrame(g, EW, EH, 'ENGINEERING', rng(5), [LC.or, LC.re, LC.pe, LC.li, LC.go]);
  // the warp core: a column of segments that light in turn toward the chamber in the middle
  const cx = x + w * 0.16, n = 8, sh = h / (2 * n + 3), cw = w * 0.13;
  for (let k = 0; k < n; k++) for (const top of [1, 0]) {
    const yy = top ? y + k * sh : y + h - (k + 1) * sh, on = s.run > 0.02 && (((k - s.phase) % 4) + 4) % 4 === 0;
    g.fillStyle = on ? (top ? LC.sk : LC.re) : s.run > 0.02 ? (top ? '#2f4a66' : '#5a2c26') : LC.off; g.fillRect(cx - cw / 2, yy + 1.5, cw, sh - 3);
  }
  g.fillStyle = s.run > 0.02 ? (s.phase % 2 ? '#ffffff' : LC.go) : LC.vi; g.beginPath(); g.arc(cx, y + h / 2, sh * 1.25, 0, TAU); g.fill();
  // the nacelles' field, port and starboard
  for (const [k, name] of [[0, 'PORT'], [1, 'STBD']]) {
    const bx = x + w * (0.36 + 0.33 * k), bw = w * 0.27;
    lt(g, name, bx, y + 9, 17, LC.sk);
    for (let q = 0; q < 10; q++) { const on = q < Math.round(s.field[k] * 10 + 0.3 * (hash(q + k * 9, s.phase) - 0.5) * (s.run > 0.02 ? 1 : 0)); g.fillStyle = on ? (q > 7 ? LC.or : LC.bl) : LC.off; g.fillRect(bx, y + h * 0.62 - q * h * 0.057, bw, h * 0.042); }
  }
  lt(g, s.label, x + w * 0.36, y + h * 0.75, 40, s.run > 0.02 ? LC.go : LC.vi);
  lt(g, 'IMPULSE', x + w * 0.36, y + h * 0.9, 17, LC.sk); g.fillStyle = LC.off; g.fillRect(x + w * 0.56, y + h * 0.865, w * 0.44, h * 0.07); g.fillStyle = LC.re; g.fillRect(x + w * 0.56, y + h * 0.865, w * 0.44 * s.imp, h * 0.07);
}

// ---------------------------------------------------------------- finishes

const wrap = (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
/** A tiling grain: soft dots of height (their size in pixels from r0 to r1) on a canvas, as { map (a pale mottled color), normalMap }. */
function grain(S, seed, n, r0, r1, strength, tone = 10) {
  const [hc, hg] = canvas(S, S, '#808080'), [cc, cg] = canvas(S, S, '#f4f4f4'), rnd = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = rnd() * S, y = rnd() * S, r = r0 + rnd() * (r1 - r0), up = rnd() < 0.5, v = Math.floor(128 + (up ? 1 : -1) * (40 + rnd() * 80)), a = 0.25 + rnd() * 0.5;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox < -r || x + ox > S + r || y + oy < -r || y + oy > S + r) continue;
      hg.fillStyle = `rgba(${v},${v},${v},${a})`; hg.beginPath(); hg.arc(x + ox, y + oy, r, 0, TAU); hg.fill();
      cg.fillStyle = up ? `rgba(255,255,255,${a * 0.5})` : `rgba(${255 - tone * 6},${255 - tone * 6},${255 - tone * 6},${a * 0.22})`; cg.beginPath(); cg.arc(x + ox, y + oy, r * 1.1, 0, TAU); cg.fill();
    }
  }
  return { map: wrap(tex(cc, true)), normalMap: wrap(tex(normalFromHeight(hc, strength), false)) };
}
/** A plain weave as a height canvas turned into a normal map, and its pale color. */
function weave(S, n, strength) {
  const [hc, hg] = canvas(S, S), [cc, cg] = canvas(S, S), hi = hg.getImageData(0, 0, S, S), ci = cg.getImageData(0, 0, S, S), rnd = rng(77);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const a = Math.sin((x / S) * TAU * n), b = Math.sin((y / S) * TAU * n), h = a * b > 0 ? Math.abs(a) : -0.6 * Math.abs(b), o = (y * S + x) * 4, v = 236 + 14 * h + (rnd() - 0.5) * 8;
    hi.data[o] = hi.data[o + 1] = hi.data[o + 2] = 128 + 110 * h; hi.data[o + 3] = 255; ci.data[o] = ci.data[o + 1] = ci.data[o + 2] = v; ci.data[o + 3] = 255;
  }
  hg.putImageData(hi, 0, 0); cg.putImageData(ci, 0, 0);
  return { map: wrap(tex(cc, true)), normalMap: wrap(tex(normalFromHeight(hc, strength), false)) };
}
/** The horseshoe's wood: color, relief and roughness painted by the same strokes of grain. */
function woodTextures() {
  const W = 1024, H = 256, [cc, cg] = canvas(W, H), [hc, hg] = canvas(W, H, '#b0b0b0'), [rc, rg] = canvas(W, H, 'rgb(0,96,0)'), rnd = rng(31);
  const gd = cg.createLinearGradient(0, 0, 0, H); for (const [k, c] of [[0, '#bd8450'], [0.3, '#b17846'], [0.62, '#c18a55'], [1, '#bd8450']]) gd.addColorStop(k, c); cg.fillStyle = gd; cg.fillRect(0, 0, W, H);
  for (let i = 0; i < 520; i++) {
    const y = rnd() * H, a = 0.05 + rnd() * 0.16, amp = 0.3 + rnd() * 1.6, ph = rnd() * TAU, n = 1 + Math.floor(rnd() * 2), lw = 0.5 + rnd() * rnd() * 2.4, dark = rnd() < 0.7;
    const path = (g) => { g.beginPath(); for (let x = 0; x <= W; x += 16) { const yy = y + amp * Math.sin((x / W) * TAU * n + ph); if (x) g.lineTo(x, yy); else g.moveTo(x, yy); } g.stroke(); };
    cg.strokeStyle = dark ? `rgba(92,48,18,${a})` : `rgba(246,196,136,${a * 0.6})`; cg.lineWidth = lw; path(cg);
    if (dark) { hg.strokeStyle = `rgba(40,40,40,${a * 2.2})`; hg.lineWidth = lw; path(hg); rg.strokeStyle = `rgba(0,170,0,${a * 2})`; rg.lineWidth = lw; path(rg); }
  }
  return { map: wrap(tex(cc, true)), normalMap: wrap(tex(normalFromHeight(hc, 1.1), false)), roughnessMap: wrap(tex(rc, false)) };
}
/** Tints for everything that shines, picked by texture coordinate: the ceiling's panels, the cool strips over the walls, the lit sides
 *  of the consoles, the red signs over the doors, a dim warm one, amber. */
function lampTexture() {
  const [c, g] = canvas(8, 1);
  ['#fff4e2', '#cfe0ff', '#eef4ff', '#ff3a2a', '#b9ad98', '#ffb040', '#ffffff', '#4a0b08'].forEach((k, i) => { g.fillStyle = k; g.fillRect(i, 0, 1, 1); });
  const t = tex(c, true); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}
const LAMP = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [(k + 0.5) / 8, 0.5]);
/** The room as its own shiny surfaces see it: a small panorama (forward a quarter of the way along, up at the top), for reflections. */
function envTexture() {
  const W = 512, H = 256, [c, g] = canvas(W, H, '#2b2627'), ua = (deg) => ((deg + 90) / 360) * W + W * 0.0, row = (el) => H / 2 - (el / 180) * H;      // u of an angle off dead ahead (to starboard), row of an elevation
  let gd = g.createLinearGradient(0, H / 2, 0, H); gd.addColorStop(0, '#5a5350'); gd.addColorStop(0.25, '#4a4648'); gd.addColorStop(1, '#3a3134'); g.fillStyle = gd; g.fillRect(0, H / 2, W, H / 2);
  gd = g.createLinearGradient(0, row(26), 0, H / 2); gd.addColorStop(0, '#cdbca6'); gd.addColorStop(1, '#9d8a74'); g.fillStyle = gd; g.fillRect(0, row(26), W, H / 2 - row(26));
  g.fillStyle = '#d9cbb6'; g.fillRect(0, row(34), W, row(26) - row(34));                                // the cornice
  g.fillStyle = '#fff9ee'; g.fillRect(0, 0, W, row(34));                                                // the luminous ceiling
  g.fillStyle = '#d9cbb6'; for (let k = 0; k < 40; k++) g.fillRect((k / 40) * W, row(70), 2, row(34) - row(70)); g.fillRect(0, row(52), W, 2);
  for (const d of [0, 135, -135]) for (const o of [-W, 0, W]) g.fillRect(ua(d) - 14 + o, 0, 28, row(34));      // the three arms
  g.fillStyle = '#0a0a0c'; g.fillRect(0, 0, W, row(80));                                                // the skylight
  for (const o of [-W, 0, W]) {
    g.fillStyle = '#050608'; g.fillRect(ua(-20) + o, row(12), ua(20) - ua(-20), row(-7) - row(12));     // the main viewer
    g.fillStyle = '#0b0b0d'; g.fillRect(ua(150) + o, row(12), ua(210) - ua(150), row(-2) - row(12));    // the aft stations' glass
    g.fillStyle = '#c98a3a'; for (let k = 0; k < 16; k++) g.fillRect(ua(152 + k * 3.6) + o, row(10 - (k % 3) * 3), 4, 3);
  }
  const t = tex(c, true); t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/** Painted panels that take the room's light: the lockers, a door, the quilted lining of the alcoves, the paneling of the low wall, the plaque. */
function buildTrim() {
  const S = 1024, [c, g] = canvas(S, S, '#b8ac9c'), R = {};
  const region = (name, x, y, w, h, draw) => { R[name] = [x, y, w, h]; g.save(); g.translate(x, y); g.beginPath(); g.rect(0, 0, w, h); g.clip(); draw(w, h); g.restore(); };
  const groove = (x, y, w, h, r, a = 0.5) => { rr(g, x, y, w, h, r); g.strokeStyle = `rgba(30,24,20,${a})`; g.lineWidth = 3; g.stroke(); rr(g, x + 1.5, y + 2.5, w - 3, h - 3, r); g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 1.2; g.stroke(); };
  region('lockers', 0, 0, 640, 416, (w, h) => {
    g.fillStyle = '#8f8271'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) {
      const x = 8 + q * (w - 10) / 3, y = 8 + r * (h - 10) / 5, dw = (w - 10) / 3 - 8, dh = (h - 10) / 5 - 8, gd = g.createLinearGradient(0, y, 0, y + dh);
      gd.addColorStop(0, '#ded3c2'); gd.addColorStop(0.12, '#d3c7b5'); gd.addColorStop(1, '#c4b7a4'); rr(g, x, y, dw, dh, 7); g.fillStyle = gd; g.fill(); groove(x, y, dw, dh, 7, 0.55);
      if (r === 1) { g.fillStyle = '#141416'; g.fillRect(x + 10, y + dh * 0.3, dw - 20, dh * 0.34); g.fillStyle = '#e09a3c'; g.fillRect(x + 16, y + dh * 0.4, 26, dh * 0.14); }
      rr(g, x + dw - 46, y + dh - 22, 36, 12, 4); g.fillStyle = '#2a2623'; g.fill();
    }
  });
  region('door', 644, 0, 376, 640, (w, h) => {
    const gd = g.createLinearGradient(0, 0, w, 0); gd.addColorStop(0, '#a9a096'); gd.addColorStop(0.5, '#bdb4aa'); gd.addColorStop(1, '#a9a096'); g.fillStyle = gd; g.fillRect(0, 0, w, h);
    for (const x of [8, w / 2 + 3]) for (const [y0, y1] of [[10, h * 0.5 - 6], [h * 0.5 + 4, h - 12]]) groove(x, y0, w / 2 - 11, y1 - y0, 10, 0.32);
    g.fillStyle = '#1b1917'; g.fillRect(w / 2 - 2, 0, 4, h); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, w, 10); g.fillRect(0, h - 8, w, 8);
  });
  region('quilt', 0, 420, 256, 256, (w, h) => {
    g.fillStyle = '#8d8983'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < 2; r++) for (let q = 0; q < 2; q++) { const gd = g.createLinearGradient(0, r * 128, 0, r * 128 + 128); gd.addColorStop(0, '#b9b4ac'); gd.addColorStop(1, '#a39e96'); rr(g, q * 128 + 5, r * 128 + 5, 118, 118, 16); g.fillStyle = gd; g.fill(); groove(q * 128 + 5, r * 128 + 5, 118, 118, 16, 0.4); }
  });
  region('low', 260, 420, 384, 256, (w, h) => {
    g.fillStyle = '#8a7a66'; g.fillRect(0, 0, w, h);
    for (let r = 0; r < 2; r++) for (let q = 0; q < 3; q++) { const gd = g.createLinearGradient(0, r * 128, 0, r * 128 + 128); gd.addColorStop(0, '#cdbfa9'); gd.addColorStop(1, '#b3a48d'); rr(g, q * 128 + 4, r * 128 + 4, 120, 120, 12); g.fillStyle = gd; g.fill(); groove(q * 128 + 4, r * 128 + 4, 120, 120, 12, 0.45); }
  });
  region('plaque', 0, 680, 200, 150, (w, h) => {
    const gd = g.createLinearGradient(0, 0, w, h); gd.addColorStop(0, '#b8893f'); gd.addColorStop(0.5, '#d9b160'); gd.addColorStop(1, '#a87a34'); g.fillStyle = gd; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#5d4218'; g.lineWidth = 4; g.strokeRect(5, 5, w - 10, h - 10); lt(g, 'U.S.S. ENTERPRISE', w / 2, 34, 24, '#3d2a0c', 'center'); lt(g, 'GALAXY CLASS · NCC-1701-D', w / 2, 60, 13, '#4a3410', 'center');
    g.fillStyle = 'rgba(61,42,12,0.75)'; for (let k = 0; k < 6; k++) g.fillRect(24 + (k % 2) * 6, 78 + k * 10, w - 48 - (k % 3) * 14, 3);
  });
  const t = tex(c, true); t.anisotropy = 16;
  return { tex: t, uv: (name) => { const [x, y, w, h] = R[name]; return (s, v) => [(x + 1 + s * (w - 2)) / S, 1 - (y + 1 + (1 - v) * (h - 2)) / S]; } };
}

/**
 * The carpet, painted in plan with its light: gray, with red round the walls and under the command area, the pools of the ceiling's
 * light, and the soft shadows of what stands on it. shadows: [{ x, z, w, d, yaw, r (how far it spreads, m), a (how dark) }];
 * glows: [{ x, z, r, a }] (the lit sides of the consoles). uv(x, z) gives the texture coordinate of a point of the floor.
 */
const FLOOR = { x0: -6.3, z0: -7.2, span: 12.6, S: 2048 };
function paintFloor(irr) {
  const S = FLOOR.S, k = S / FLOOR.span, [c, g] = canvas(S, S, '#8f4640'), X = (x) => (x - FLOOR.x0) * k, Z = (z) => (z - FLOOR.z0) * k;
  const loop = (pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p[0]), Z(p[1])) : g.moveTo(X(p[0]), Z(p[1])))); g.closePath(); };
  // gray inside a red margin that follows the walls
  const inner = []; for (let d = 0; d < 360; d += 2) { const a = d * D2R, r = Math.min(wallR(a), Rw(a)) - 0.5 - 0.35 * sstep(25, 60, fold(a)) * (1 - sstep(60, 110, fold(a))); inner.push([r * Math.sin(a), ZC - r * Math.cos(a)]); }
  loop(inner); g.fillStyle = '#9499a2'; g.fill();
  // red under the command area: out to a little beyond the horseshoe's foot, and a tongue forward of the seats
  const red = []; for (let d = TIP; d <= 360 - TIP; d += 2) { const s = hsAt(d * D2R), u = lean(s.a) + 0.2; red.push([s.p[0] + s.n[0] * u, s.p[1] + s.n[1] * u]); }
  loop(red); g.fillStyle = '#8f4640'; g.fill();
  g.beginPath(); g.ellipse(X(0), Z(-1.5), 2.2 * k, 1.2 * k, 0, 0, TAU); g.fill();
  // pile: a fine speckle over everything
  { const [nc, ng] = canvas(256, 256, '#d8d8d8'), im = ng.getImageData(0, 0, 256, 256), rnd = rng(9); for (let i = 0; i < im.data.length; i += 4) { const v = 196 + rnd() * 59; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; } ng.putImageData(im, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = g.createPattern(nc, 'repeat'); g.fillRect(0, 0, S, S); }
  // a little unevenness, as a carpet that has been walked on has
  { const rnd = rng(4); g.globalCompositeOperation = 'source-over'; for (let i = 0; i < 90; i++) { const x = rnd() * S, y = rnd() * S, r = (0.3 + rnd() * 0.9) * k, gd = g.createRadialGradient(x, y, 0, x, y, r), v = rnd() < 0.5 ? '255,255,255' : '0,0,0'; gd.addColorStop(0, `rgba(${v},0.045)`); gd.addColorStop(1, `rgba(${v},0)`); g.fillStyle = gd; g.fillRect(x - r, y - r, 2 * r, 2 * r); } }
  // its light: what the bake found reaches each spot of the floor (lightRoom), spread smoothly over it
  g.globalCompositeOperation = 'multiply'; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(irr, 0, 0, S, S); g.globalCompositeOperation = 'source-over';
  const t = tex(c, true); t.anisotropy = 16;
  return t;
}
const floorUv = (x, z) => [(x - FLOOR.x0) / FLOOR.span, 1 - (z - FLOOR.z0) / FLOOR.span];

// ---------------------------------------------------------------- furniture

/** An upholstered slab from a to b (in a plane of constant x), w wide across and t thick, its far end rounded off: a seat's back. */
function roundPad(a, b, w, t, rgb, round = 0.55) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]), T = d.map((v) => v / l), N = [0, -T[2], T[1]];
  const u0 = Math.max(0.2, 1 - (round * w) / 2 / l), rows = [[0, 0.82, 0.7], [0.04, 1, 1], [u0 * 0.5, 1, 1], [u0, 1, 1]];           // [how far along, width, thickness]
  for (let q = 1; q <= 6; q++) { const f = (q / 6) * 80 * D2R; rows.push([u0 + (1 - u0) * Math.sin(f), Math.cos(f), 0.6 + 0.4 * Math.cos(f)]); }
  const mid = (i) => { const u = rows[Math.min(i, rows.length - 1)][0] * l; return [a[0] + T[0] * u, a[1] + T[1] * u, a[2] + T[2] * u]; };
  const P = rows.map((r, i) => { const c = mid(i); return Array.from({ length: 12 }, (_, j) => { const an = (j / 12) * TAU, cs = Math.cos(an), sn = Math.sin(an), x = (w / 2) * r[1] * Math.sign(cs) * Math.sqrt(Math.abs(cs)), y = (t / 2) * r[2] * Math.sign(sn) * Math.sqrt(Math.abs(sn)); return [c[0] + x, c[1] + N[1] * y, c[2] + N[2] * y]; }); });
  return [skin(P, { closedJ: true, away: mid, rgb, crease: 55 }), cap(P[0], mid(1), rgb), cap(P[P.length - 1], mid(P.length - 2), rgb)];
}

/**
 * A seat molded in one piece: a shell that runs from the front of the seat back and up into the back, its sides curling up round
 * the sitter, lined with leather in three padded channels. spine: [[z, y], ...] the middle of the lining from the front edge to the
 * top (z aft, y up); w(t), wing(t): its width and how far its sides curl, by the fraction t of the way along.
 */
function shellSeat(spine, w, wing, NS = 44) {
  const pts = fillet(spine, 0.16, 5), acc = [0]; for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const len = acc[acc.length - 1], NU = 8, th = 0.045, P = [], C = [];
  const on = (d) => { let k = 1; while (k < pts.length - 1 && acc[k] < d) k++; const f = (d - acc[k - 1]) / (acc[k] - acc[k - 1] || 1); return [lerp(pts[k - 1][0], pts[k][0], f), lerp(pts[k - 1][1], pts[k][1], f)]; };
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, d = t * len, c = on(d), a = on(Math.max(0, d - 0.04)), b = on(Math.min(len, d + 0.04)), tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nz = -(b[1] - a[1]) / tl, ny = (b[0] - a[0]) / tl;      // (the normal looks at the sitter)
    const hw = w(t) / 2, e = wing(t), fade = Math.min(1, Math.min(t, 1 - t) / 0.07), row = [];
    for (let j = -NU; j <= NU; j++) { const u = j / NU, au = Math.abs(u), l = e * Math.pow(au, 2.6) + (au < 0.84 ? 0.022 * Math.pow(Math.abs(Math.cos((Math.PI * 1.5 * u) / 0.84)), 0.5) * fade : 0); row.push([u * hw, c[1] + ny * l, c[0] + nz * l]); }
    for (let j = NU; j >= -NU; j--) { const u = j / NU, l = e * Math.pow(Math.abs(u), 2.6) - th * (1 - 0.6 * u ** 4); row.push([u * (hw + 0.012), c[1] + ny * l, c[0] + nz * l]); }
    P.push(row); C.push([0, c[1] - ny * th * 0.5, c[0] - nz * th * 0.5]);
  }
  const mid = (i) => C[Math.min(i, NS)], lining = 2 * NU;
  return { leather: skin(P, { closedJ: true, away: mid, rgb: TANL, crease: 42, skip: (i, j) => j >= lining }), shell: [skin(P, { closedJ: true, away: mid, rgb: TANP, crease: 42, skip: (i, j) => j < lining }), cap(P[0], mid(1), TANP), cap(P[NS], mid(NS - 1), TANP)] };
}

/** A seat in its own axes (the sitter faces -Z, the floor at 0): a molded shell (shellSeat) on a pedestal with a foot ring and a swivel
 *  collar. kind: 'helm' (tall, reclined), 'cmd' (with padded arms), 'capt' (the same cut low, so that the eye that sits in it never
 *  sees it; its arms carry pads of keys), 'end' (small), 'stool'. */
function seat(P, kind, A) {
  const X = [1, 0, 0];
  if (kind === 'stool') {
    P.add('dark', lathe([[0.2, 0], [0.2, 0.025], [0.05, 0.05], [0.035, 0.44]], METAL, 12));
    P.add('leather', cyl(0.19, 0.2, 0.07, [0, 0.485, 0], TANL, 16), ...roundPad([0, 0.57, 0.17], [0, 0.84, 0.2], 0.32, 0.06, TANL, 0.7));
    return;
  }
  const end = kind === 'end', capt = kind === 'capt', helm = kind === 'helm', W = end ? 0.46 : helm ? 0.56 : 0.62, top = capt || end ? 1 : 0.86;
  const pw = (t, pts) => { let k = 1; while (k < pts.length - 1 && t > pts[k][0]) k++; return lerp(pts[k - 1][1], pts[k][1], sstep(pts[k - 1][0], pts[k][0], t)); };
  const spine = helm ? [[-0.31, 0.4], [-0.27, 0.46], [0.2, 0.44], [0.33, 0.78], [0.41, 1.09]] : capt ? [[-0.33, 0.4], [-0.29, 0.465], [0.2, 0.445], [0.27, 0.66], [0.3, 0.8]] : end ? [[-0.27, 0.4], [-0.23, 0.45], [0.16, 0.43], [0.22, 0.62], [0.25, 0.78]] : [[-0.33, 0.4], [-0.29, 0.465], [0.2, 0.445], [0.3, 0.78], [0.36, 1.1]];
  const w = (t) => W * (1 - 0.1 * sstep(0.4, 0.6, t)) * (t > top ? Math.sqrt(1 - 0.6 * ((t - top) / (1 - top)) ** 2) : 1);
  const wing = (t) => pw(t, end ? [[0, 0.02], [0.3, 0.06], [1, 0.03]] : helm ? [[0, 0.02], [0.22, 0.1], [0.46, 0.14], [0.8, 0.07], [1, 0.02]] : [[0, 0.03], [0.14, 0.17], [0.42, 0.18], [0.6, 0.08], [1, 0.03]]);
  const sh = shellSeat(spine, w, wing, capt || end ? 26 : 36);
  P.add('leather', sh.leather); P.add('wall', ...sh.shell);
  P.add('dark', lathe(fillet([[0.27, 0], [0.27, 0.028], [0.11, 0.05], [0.07, 0.12], [0.07, 0.3], [0.105, 0.315], [0.105, 0.355], [0.2, 0.39], [0.22, 0.42]], 0.012, 2), METAL));
  if (!end && !helm) for (const sg of [-1, 1]) {
    const x = sg * (W / 2 - 0.012);
    P.add('leather', softPad([x, 0.632, 0.2], [x, 0.646, -0.27], 0.1, 0.05, TANL, X, 6));
    if (capt) { const uv = A.uv('arm'); P.add('dark', box(0.1, 0.012, 0.19, [x, 0.674, -0.16], DARK)); P.add('lcars', plateGeo(-0.045, -0.09, 0.045, 0.09, 1, 1, (px, py) => uv((px + 0.045) / 0.09, (py + 0.09) / 0.18)).rotateX(-Math.PI / 2).translate(x, 0.6815, -0.16)); }
  }
}
/** Stand a seat in the room, with the shade it throws. */
function putSeat(K, M, kind) {
  const P = new Parts(); seat(P, kind, K.A);
  for (const k of Object.keys(P.lists)) { const g = P.geometry(k, M); if (g) K.G.add(k, g); }
  const c = K.wpt(M, [0, 0, 0]), yaw = Math.atan2(-M.elements[2], M.elements[0]), w = kind === 'stool' ? 0.36 : 0.62;
  K.shadows.push({ x: c[0], z: c[2], w: w + 0.2, d: w + 0.25, yaw, r: 0.26, a: kind === 'stool' ? 0.4 : 0.62 });
  if (kind === 'stool') return;
  K.ao(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(0, 0.3, 0)), [0.3, 0.14, 0.32]);
  if (kind !== 'capt' && kind !== 'end') K.ao(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeRotationX(0.25).setPosition(0, 0.8, 0.42)), [0.27, 0.34, 0.05]);
}

/** Ops or conn: a plate on the floor carrying a wedge with lit sides, the slab of a console on it (its glass the live display `live`)
 *  and the officer's seat behind. (x, z) is the seat. */
function helmUnit(K, x, z, live) {
  const M = place(x, z), tilt = 0.42, MS = new THREE.Matrix4().makeRotationX(-Math.PI / 2 + tilt).setPosition(0, 0.83, -0.86), put = (list, ...g) => K.put(list, M, ...g);
  const sec = fillet([[0.5, 0], [-1.3, 0], [-1.36, 0.93], [-0.72, 0.7], [-0.5, 0.2], [0.46, 0.09]], 0.05, 3, true), W = [[-0.36, 1], [-0.32, 0], [0.32, 0], [0.36, 1]].map(([px, k]) => sec.map(([pz, py]) => [px, lerp(py, 0.3, 0.1 * k), lerp(pz, -0.5, 0.06 * k)]));      // (its side edges drawn in a little: rounded)
  put('wall', skin(W, { closedJ: true, away: [0, 0.3, -0.9], rgb: SLED, crease: 40 }), cap(W[0], [0, 0.3, -0.9], SLED), cap(W[3], [0, 0.3, -0.9], SLED));
  for (const s of [-1, 1]) {
    const px = s * 0.363;
    put('lamp', K.lamp(quad([px, 0.14, -1.22], [px, 0.14, -0.62], [px, 0.4, -0.66], [px, 0.7, -1.24], ONE, { seen: [s * 5, 0.4, -0.9] }), 2));
    K.glows.push({ x: x + s * 0.6, z: z - 0.9, r: 0.95, a: 0.34 }); K.floods.push({ p: [x + s * 0.5, 0.4, z - 0.9], i: 0.3, r: 0.55 });
  }
  put('wall', slab(1.22, 0.7, 0.1, 0.1, PLASTIC).map((g) => g.applyMatrix4(MS)));
  put('dark', plateGeo(-0.545, -0.285, 0.545, 0.285, 1, 1, () => BLANK, [], 0.0015, DARK).applyMatrix4(MS));
  put(live, plateGeo(-0.53, -0.27, 0.53, 0.27, 1, 1, (px, py) => [(px + 0.53) / 1.06, (py + 0.27) / 0.54], [], 0.003).applyMatrix4(MS));
  putSeat(K, place(x, z + 0.05), 'helm');
  const T = (m) => new THREE.Matrix4().multiplyMatrices(M, m);
  K.ao(T(new THREE.Matrix4().makeTranslation(0, 0.4, -0.9)), [0.3, 0.36, 0.3]); K.ao(T(new THREE.Matrix4().makeRotationX(tilt).setPosition(0, 0.8, -0.86)), [0.58, 0.05, 0.32]);
  K.shadows.push({ x, z: z - 0.42, w: 1.5, d: 2.15, r: 0.3, a: 0.55 });
  K.wins.push({ c: K.wpt(M, [0, 0.9, -0.8]), n: [0, 0.91, 0.41], area: 0.5 });
}

/** A small console at one end of the command seats: a pedestal with a lit side and a slanted display, turned by yaw. */
function pod(K, x, z, yaw, s) {
  const M = place(x, z, yaw), MS = new THREE.Matrix4().makeRotationX(-Math.PI / 2 + 0.5).setPosition(0, 0.66, 0), uv = K.A.uv(s > 0 ? 'side' : 'side2');
  K.put('wall', M, rbox(0.4, 0.34, 0, 0.6, 0.07, PLASTIC), slab(0.46, 0.34, 0.05, 0.06, PLASTIC).map((g) => g.applyMatrix4(MS)));
  K.put('lcars', M, plateGeo(-0.2, -0.14, 0.2, 0.14, 1, 1, (px, py) => uv((px + 0.2) / 0.4, (py + 0.14) / 0.28), [], 0.003).applyMatrix4(MS));
  K.put('lamp', M, K.lamp(quad([-0.15, 0.1, -0.172], [0.15, 0.1, -0.172], [0.15, 0.46, -0.172], [-0.15, 0.46, -0.172], ONE, { seen: [0, 0.3, -3] }), 2));
  const c = K.wpt(M, [0, 0.3, -0.5]); K.glows.push({ x: c[0], z: c[2], r: 0.8, a: 0.3 }); K.floods.push({ p: c, i: 0.25, r: 0.5 });
  K.ao(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(0, 0.32, 0)), [0.2, 0.3, 0.17]); K.shadows.push({ x, z, w: 0.44, d: 0.38, yaw, r: 0.12, a: 0.6 });
}

// ---------------------------------------------------------------- crew

const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], vmix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const vunit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** A rounded limb lofted along a path. radii: [[across, through], ...] at each point; side: the way "across" runs; color: one, or (i) => one for each stretch. */
function limb(path, radii, side, color, seg = 10) {
  const n = path.length, col = typeof color === 'function' ? color : () => color, mid = (i) => path[Math.min(i, n - 1)];
  const P = path.map((p, i) => {
    const t = vunit(vsub(path[Math.min(i + 1, n - 1)], path[Math.max(i - 1, 0)])), d = side[0] * t[0] + side[1] * t[1] + side[2] * t[2], s = vunit([side[0] - t[0] * d, side[1] - t[1] * d, side[2] - t[2] * d]), b = [t[1] * s[2] - t[2] * s[1], t[2] * s[0] - t[0] * s[2], t[0] * s[1] - t[1] * s[0]], r = radii[i];
    return Array.from({ length: seg }, (_, k) => { const a = (k / seg) * TAU, c = Math.cos(a) * r[0], q = Math.sin(a) * r[1]; return [p[0] + s[0] * c + b[0] * q, p[1] + s[1] * c + b[1] * q, p[2] + s[2] * c + b[2] * q]; });
  });
  return [skin(P, { closedJ: true, away: mid, color: (i) => col(i), crease: 70 }), cap(P[0], path[1], col(0)), cap(P[n - 1], path[n - 2], col(n - 2))];
}
/**
 * One of the crew, in their own axes (facing -Z, their floor at 0): a generic officer in the duty uniform of the period, nobody in
 * particular. o: { sit, k (stature), wide (build), dept (the uniform's color), tone (skin), hair, hands: [left, right] where the
 * fingertips rest, foot: [height, how far forward] of a seated officer's ankles }. Returns { cloth, skin, dark, head: geometries,
 * neck: the point the head turns about }.
 */
function figure(o) {
  const k = o.k, w = o.wide, X = [1, 0, 0], BLK = [0.012, 0.012, 0.014], hip = o.sit ? [0, 0.575, -0.02] : [0, 0.93 * k, 0], lz = o.sit ? -0.06 : 0.02, up = (s) => [0, hip[1] + s * 0.52 * k, hip[2] + s * lz];
  const cloth = [], sk = [], dark = [], head = [];
  // the trunk: hips, waist, chest, and the black yoke over the shoulders
  cloth.push(...limb([up(-0.12), up(0), up(0.35), up(0.7), up(0.86), up(0.97), up(1.03)], [[0.1 * w, 0.07], [0.17 * w, 0.115], [0.15 * w, 0.1], [0.18 * w, 0.118], [0.19 * w, 0.11], [0.17 * w, 0.085], [0.07, 0.065]], X, (i) => (i >= 4 || i === 0 ? BLK : o.dept), 14));
  dark.push(box(0.028, 0.036, 0.006, vadd(up(0.72), [0.078 * w, 0, -0.121]), [0.75, 0.6, 0.25]));      // the badge
  // the neck and the head: an egg with a jaw, a nose, a brow, a chin and eye sockets pressed into it, the hair standing a little proud
  const nk = up(1.03), nt = [nk[0], nk[1] + 0.07 * k, nk[2] - 0.005], hc = [nt[0], nt[1] + 0.1 * k, nt[2] - 0.012], rx = 0.076 * k, ry = 0.118 * k, rz = 0.094 * k;
  head.push(...limb([nk, nt, [nt[0], nt[1] + 0.03, nt[2]]], [[0.058, 0.058], [0.052, 0.055], [0.05, 0.05]], X, o.tone, 10));
  const NV = 13, NA = 18, hairAt = (v, f) => v > 0.45 || (Math.abs(f) > 1.15 && v > lerp(0.05, -0.5, sstep(1.15, 2.4, Math.abs(f)))), bell = (x, c, s) => Math.exp(-(((x - c) / s) ** 2));
  const hp = (v, f) => {
    const rho = Math.sqrt(1 - v * v) * (1 - 0.2 * sstep(-0.25, -0.9, v)), af = Math.abs(f);
    const e = 0.02 * bell(f, 0, 0.2) * bell(v, -0.1, 0.17) + 0.006 * bell(f, 0, 0.7) * bell(v, 0.2, 0.1) - 0.007 * bell(af, 0.38, 0.16) * bell(v, 0.07, 0.09) + 0.01 * bell(f, 0, 0.4) * bell(v, -0.72, 0.15) + (hairAt(v, f) ? 0.008 : 0);
    return [hc[0] + Math.sin(f) * (rx * rho + e), hc[1] + v * ry, hc[2] - Math.cos(f) * (rz * rho + e)];
  };
  const HP = Array.from({ length: NV + 1 }, (_, i) => Array.from({ length: NA }, (_, j) => hp(-0.97 + (1.94 * i) / NV, -Math.PI + (TAU * (j + 0.5)) / NA)));
  head.push(skin(HP, { closedJ: true, away: hc, crease: 70, color: (i, j) => (hairAt(-0.97 + (1.94 * (i + 0.5)) / NV, -Math.PI + (TAU * (j + 1)) / NA) ? o.hair : o.tone) }), cap(HP[0], hc, o.tone), cap(HP[NV], hc, o.hair));
  const on = (v, f, lift = 0.002) => { const p = hp(v, f); return [p[0] + Math.sin(f) * lift, p[1], p[2] - Math.cos(f) * lift]; };
  for (const s of [-1, 1]) head.push(box(0.02, 0.007, 0.004, on(0.07, s * 0.38), [0.03, 0.02, 0.02]), box(0.03, 0.006, 0.004, on(0.2, s * 0.36, 0.003), o.hair), box(0.012, 0.05, 0.026, on(0, s * 1.57, 0.004), o.tone));      // eyes, brows, ears
  head.push(box(0.04, 0.005, 0.004, on(-0.42, 0), o.tone.map((c) => c * 0.5)));
  // arms to where the hands rest, hands as a palm, a mitten of fingers and a thumb
  const sh = up(0.93);
  for (const s of [-1, 1]) {
    const S = [s * 0.19 * w, sh[1], sh[2]], H = o.hands[s < 0 ? 0 : 1], Wr = [H[0], H[1] + 0.015, H[2] + 0.13], E = vadd(vmix(S, Wr, 0.52), [s * 0.05, -0.1, 0.1]);
    cloth.push(...limb([S, vmix(S, E, 0.5), E, vmix(E, Wr, 0.5), Wr], [[0.054, 0.054], [0.05, 0.048], [0.043, 0.043], [0.038, 0.036], [0.03, 0.027]], X, (i) => (i === 0 ? BLK : o.dept)));
    sk.push(...limb([Wr, vmix(Wr, H, 0.5), H, vadd(H, [0, -0.004, -0.035])], [[0.027, 0.02], [0.042, 0.013], [0.038, 0.011], [0.02, 0.007]], X, o.tone), ...limb([vadd(vmix(Wr, H, 0.3), [-s * 0.03, 0, 0]), vadd(vmix(Wr, H, 0.3), [-s * 0.062, -0.004, -0.04])], [[0.012, 0.011], [0.009, 0.008]], X, o.tone, 6));
  }
  // legs and boots
  for (const s of [-1, 1]) {
    const J = [s * 0.09 * w, hip[1] - 0.02, hip[2]], K = o.sit ? [s * 0.11, hip[1], hip[2] - 0.43 * k] : [s * 0.1, 0.5 * k, 0.01], A = o.sit ? [s * 0.11, o.foot[0], hip[2] + o.foot[1]] : [s * 0.1, 0.09, 0.02];
    cloth.push(...limb([J, vmix(J, K, 0.5), K, vmix(K, A, 0.5), A], [[0.085, 0.085], [0.078, 0.075], [0.06, 0.06], [0.052, 0.055], [0.042, 0.045]], X, BLK));
    cloth.push(...limb([vadd(A, [0, 0.03, 0.02]), vadd(A, [0, -0.05, -0.02]), vadd(A, [0, -0.055, -0.21])], [[0.045, 0.05], [0.048, 0.045], [0.04, 0.028]], X, BLK));
  }
  return { cloth, skin: sk, dark, head, neck: nt };
}

/** One panel of the luminous ceiling: brightest in the middle, a little dimmer and warmer toward the ribs that frame it. */
function panelTexture() {
  const S = 64, [c, g] = canvas(S, S, '#e9dfcd'), gd = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S * 0.72);
  gd.addColorStop(0, '#fffaf0'); gd.addColorStop(0.6, '#f4ebdb'); gd.addColorStop(1, '#cfc2ac'); g.fillStyle = gd; g.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(110,98,82,0.6)'; g.lineWidth = 2.5; g.strokeRect(0, 0, S, S);
  return wrap(tex(c, true));
}

// ---------------------------------------------------------------- light

const VX = 0.06, G0 = [-6.4, -0.12, -7.3], GN = [214, 76, 220];        // the grid of cells the room is poured into: their size, a corner, how many each way
const FMAX = 1.3, FG = 128;                                            // the brightest the carpet's picture of its light can say, and how many samples across it
const LIT = {};                                                        // what the rays found, kept from one build to the next: the room is the same every time

/**
 * Light the room from its own geometry. Every triangle is poured into a grid of 6 cm cells: plain surfaces with their color, the
 * luminous ceiling and the alcoves' lit ceilings as light, the displays as glow. Then each vertex casts a fan of rays into the room:
 * the share that reaches the ceiling is its light, what the rest strike is bounced back at it in their own color, and the small
 * lamps (the strips over the walls, the lit sides of the consoles) are reached, or not, along a ray each. Sets `lit` on the baked
 * meshes and tints their colors with the bounce; returns a small picture of the light on the floor, in plan, for the carpet's map.
 */
function lightRoom(geos, floods) {
  const names = Object.keys(geos).filter((n) => /^(wall|trim|leather|wood|dark|cloth|skin|head\d+)$/.test(n));
  const give = (name) => { const g = geos[name], k = LIT[name]; g.attributes.color.array.set(k.col); g.setAttribute('lit', new THREE.BufferAttribute(k.lit.slice(), 2)); };
  const sig = (g) => { const p = g.attributes.position.array; let s = 0; for (let i = 0; i < p.length; i += 53) s += p[i]; return p.length + ':' + Math.round(s * 1000); };
  if (LIT.floor && names.every((n) => LIT[n] && LIT[n].n === sig(geos[n]))) { names.forEach(give); return LIT.floor; }
  const [NX, NY, NZ] = GN, type = new Uint8Array(NX * NY * NZ), alb = new Uint16Array(NX * NY * NZ);
  const cell = (x, y, z) => { const ix = Math.floor((x - G0[0]) / VX), iy = Math.floor((y - G0[1]) / VX), iz = Math.floor((z - G0[2]) / VX); return ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ ? -1 : (iy * NZ + iz) * NX + ix; };
  // kind: 1 a plain surface (tone: what its map makes of its color, or (x, z) => that), 2 light, 3 a display; or (u) => kind by a lamp's tint
  const pour = (g, kind, tone) => {
    if (!g) return;
    const p = g.attributes.position.array, c = g.attributes.color.array, u = g.attributes.uv.array;
    for (let i = 0; i < p.length; i += 9) {
      const ax = p[i], ay = p[i + 1], az = p[i + 2], e1x = p[i + 3] - ax, e1y = p[i + 4] - ay, e1z = p[i + 5] - az, e2x = p[i + 6] - ax, e2y = p[i + 7] - ay, e2z = p[i + 8] - az;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x; const nl = Math.hypot(nx, ny, nz); if (nl < 1e-10) continue; nx /= nl; ny /= nl; nz /= nl;
      const n = Math.max(1, Math.ceil(Math.max(Math.hypot(e1x, e1y, e1z), Math.hypot(e2x, e2y, e2z)) / (VX * 0.55))), k = typeof kind === 'function' ? kind(u[(i / 3) * 2]) : kind;
      let col = 0;
      if (k === 1) { const t = typeof tone === 'function' ? tone(ax + (e1x + e2x) / 3, az + (e1z + e2z) / 3) : tone; col = (Math.min(31, Math.round(c[i] * t[0] * 31)) << 10) | (Math.min(31, Math.round(c[i + 1] * t[1] * 31)) << 5) | Math.min(31, Math.round(c[i + 2] * t[2] * 31)); }
      for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) {
        const x = ax + (e1x * a + e2x * b) / n, y = ay + (e1y * a + e2y * b) / n, z = az + (e1z * a + e2z * b) / n;
        for (const d of [0, -0.9]) { const q = cell(x + nx * VX * d, y + ny * VX * d, z + nz * VX * d); if (q >= 0 && (k !== 1 || type[q] < 2)) { type[q] = k; alb[q] = col; } }      // (two cells thick, so that no ray slips through)
      }
    }
  };
  const carpet = (x, z) => { const a = Math.atan2(x, ZC - z), red = Math.hypot(x, z - ZC) > Math.min(wallR(a), Rw(a)) - 0.6 || (x / (HX + 0.5)) ** 2 + ((z - HC) / (HZ + 0.5)) ** 2 < 1 || (x / 2.2) ** 2 + ((z + 1.5) / 1.2) ** 2 < 1; return red ? [0.27, 0.07, 0.06] : [0.3, 0.32, 0.36]; };
  pour(geos.wall, 1, [0.9, 0.9, 0.9]); pour(geos.trim, 1, [0.6, 0.55, 0.48]); pour(geos.leather, 1, [0.9, 0.9, 0.9]); pour(geos.wood, 1, [0.5, 0.25, 0.11]); pour(geos.dark, 1, ONE); pour(geos.floor, 1, carpet); for (const n of names) if (/^(cloth|skin|head)/.test(n)) pour(geos[n], 1, [0.9, 0.9, 0.9]);
  pour(geos.lamp, (u) => (Math.abs(u - LAMP[0][0]) < 0.03 ? 2 : 1), [0.8, 0.8, 0.8]); pour(geos.dome, 2); for (const n of ['lcars', 'eng', 'conn', 'ops']) pour(geos[n], 3);

  const NR = 20, RD = Array.from({ length: NR }, (_, k) => { const u1 = (k + 0.5) / NR, ph = TAU * ((k * 0.61803398875) % 1), r = Math.sqrt(u1); return [r * Math.cos(ph), r * Math.sin(ph), Math.sqrt(1 - u1)]; });
  const step = VX * 0.95, o = [0, 0, 0, 0, 0];         // what a point receives: [light, then red, green and blue bounced to it, the displays' glow]
  const hit = (x, y, z, dx, dy, dz, far) => { let d = step; while (d < far) { const q = cell(x + dx * d, y + dy * d, z + dz * d); if (q < 0) return -1; if (type[q]) return q; d += d < 0.6 ? step : 0.105; } return -1; };      // (fine steps near the point, then steps no longer than the two cells every surface is thick)
  const gather = (x, y, z, nx, ny, nz) => {
    const ox = x + nx * VX * 1.7, oy = y + ny * VX * 1.7, oz = z + nz * VX * 1.7;
    let tx, ty, tz; if (Math.abs(ny) < 0.9) { tx = nz; ty = 0; tz = -nx; } else { tx = 0; ty = -nz; tz = ny; }
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl; const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    let L = 0, r = 0, g = 0, b = 0, d = 0, F = 0;
    for (const v of RD) {
      const q = hit(ox, oy, oz, tx * v[0] + bx * v[1] + nx * v[2], ty * v[0] + by * v[1] + ny * v[2], tz * v[0] + bz * v[1] + nz * v[2], 6.9); if (q < 0) continue;
      const t = type[q]; if (t === 2) L++; else if (t === 3) d++; else { const c = alb[q]; r += (c >> 10) & 31; g += (c >> 5) & 31; b += c & 31; }
    }
    for (const f of floods) {
      const fx = f.p[0] - ox, fy = f.p[1] - oy, fz = f.p[2] - oz, dd = fx * fx + fy * fy + fz * fz; if (dd > f.r * f.r * 9) continue;
      const dl = Math.sqrt(dd) || 1e-6, k = (f.i * Math.max(0, ((nx * fx + ny * fy + nz * fz) / dl + 0.3) / 1.3)) / (1 + dd / (f.r * f.r)); if (k < 0.01) continue;
      F += hit(ox, oy, oz, fx / dl, fy / dl, fz / dl, dl - 0.12) >= 0 ? k * 0.15 : k;
    }
    o[0] = (L / NR) * 1.75 + F; o[1] = (0.8 * r) / (31 * NR); o[2] = (0.8 * g) / (31 * NR); o[3] = (0.8 * b) / (31 * NR); o[4] = d / NR;
  };
  for (const name of names) {
    const g = geos[name], P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color.array, n = P.length / 3, lit = new Float32Array(n * 2), T = new Float32Array(n * 3), seen = new Map();
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
      const key = ((Math.round((x + 8) * 200) * 4096 + Math.round((y + 1) * 200)) * 4096 + Math.round((z + 8) * 200)) * 32 + (Math.round(nx * 1.4) + 1) * 9 + (Math.round(ny * 1.4) + 1) * 3 + Math.round(nz * 1.4) + 1;
      let j = seen.get(key);
      if (j === undefined) {
        gather(x, y, z, nx, ny, nz); j = i; seen.set(key, i);
        const R = o[0] + o[1], Gr = o[0] + o[2], B = o[0] + o[3], Y = 0.3 * R + 0.55 * Gr + 0.15 * B + 1e-4;
        lit[i * 2] = Math.min(Y, 1.8); lit[i * 2 + 1] = o[4] * 3.5; T[i * 3] = Math.max(0.78, Math.min(1.3, R / Y)); T[i * 3 + 1] = Math.max(0.78, Math.min(1.3, Gr / Y)); T[i * 3 + 2] = Math.max(0.78, Math.min(1.3, B / Y));
      } else { lit[i * 2] = lit[j * 2]; lit[i * 2 + 1] = lit[j * 2 + 1]; T[i * 3] = T[j * 3]; T[i * 3 + 1] = T[j * 3 + 1]; T[i * 3 + 2] = T[j * 3 + 2]; }
      C[i * 3] *= T[i * 3]; C[i * 3 + 1] *= T[i * 3 + 1]; C[i * 3 + 2] *= T[i * 3 + 2];
    }
    LIT[name] = { n: sig(g), lit, col: C.slice() }; g.setAttribute('lit', new THREE.BufferAttribute(lit.slice(), 2));
  }
  // the floor, in plan
  const [fc, fg] = canvas(FG, FG), im = fg.createImageData(FG, FG);
  for (let j = 0; j < FG; j++) for (let i = 0; i < FG; i++) {
    const x = FLOOR.x0 + ((i + 0.5) / FG) * FLOOR.span, z = FLOOR.z0 + ((j + 0.5) / FG) * FLOOR.span, y = (x / HX) ** 2 + ((z - HC) / HZ) ** 2 < 1.02 ? 0 : floorH(Math.atan2(x, ZC - z));
    gather(x, y, z, 0, 1, 0);
    const v = 255 * Math.pow(Math.min(1, (o[0] + 0.3 * o[1] + 0.55 * o[2] + 0.15 * o[3]) / FMAX), 1 / 2.2), q = (j * FG + i) * 4; im.data[q] = im.data[q + 1] = im.data[q + 2] = v; im.data[q + 3] = 255;
  }
  fg.putImageData(im, 0, 0); LIT.floor = fc;
  return fc;
}

// ---------------------------------------------------------------- the room

/** A cabin material (cabin-kit.js) for a room with no window: whatever highlight a light of the scene would put on it is thrown away. */
function roomMat(U, opts) {
  const m = cabMat(U, opts), patch = m.onBeforeCompile, key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, r) => { patch(sh, r); sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directSpecular = vec3( 0.0 );'); };
  m.customProgramCacheKey = () => key + 'room';
  return m;
}

export function buildBridge() {
  const t0 = performance.now();
  const root = new THREE.Group(); root.name = 'Enterprise bridge';
  const G = new Parts(), A = buildAtlas(), TR = buildTrim(), shadows = [], glows = [], floods = [], wins = [];
  const put = (list, M, ...geos) => { for (const g of geos.flat(2)) if (g) G.add(list, M ? g.applyMatrix4(M) : g); };
  const lamp = (g, k) => { const u = g.attributes.uv; for (let i = 0; i < u.count; i++) u.setXY(i, LAMP[k][0], LAMP[k][1]); return g; };
  const wpt = (M, p) => new THREE.Vector3(...p).applyMatrix4(M).toArray(), wdir = (M, d) => new THREE.Vector3(...d).transformDirection(M).toArray();
  const ao = () => {};          // (the furniture once shaded the bake as boxes: the light is cast through the room's own geometry now, see lightRoom)
  const K = { G, A, TR, put, lamp, ao, wpt, shadows, glows, floods, wins };

  // ---- the crew: generic officers at conn and ops, at tactical and at two of the aft stations (their heads apart, to turn)
  const crew = [], RED = [0.36, 0.03, 0.035], GOLD = [0.5, 0.33, 0.06], BLUE = [0.04, 0.2, 0.3];
  const man = (M, o) => { const f = figure(o), i = crew.length; put('cloth', M, f.cloth); put('skin', M, f.skin); put('dark', M, f.dark); put('head' + i, M, f.head); crew.push({ neck: wpt(M, f.neck), ph: i * 1.7 + 0.4, mesh: null }); };

  // ---- the walls, bay by bay
  const ROWS = [[0.022, -0.03, 1], [0.022, 0.1, 1], [0, 0.104, 1], [0, WALL, 0]];
  const strip = (M, x0, x1, y = WALL - 0.045, z = 0.004) => { put('lamp', M, lamp(quad([x0, y - 0.03, z], [x1, y - 0.03, z], [x1, y + 0.03, z], [x0, y + 0.03, z], ONE, { seen: [0, 1.5, 3] }), 1)); for (let x = x0 + 0.3; x < x1; x += 0.9) floods.push({ p: wpt(M, [x, y - 0.1, 0.22]), i: 0.14, r: 0.9 }); };      // a cool strip of light under the cornice
  const glass = (M, x0, y0, x1, y1, uv, list = 'lcars', m = 0.03) => { put('dark', M, panel(x0 - m, y0 - m, x1 + m, y1 + m, 0.007, null, DARK)); put(list, M, panel(x0, y0, x1, y1, 0.013, uv, ONE, 9)); wins.push({ c: wpt(M, [(x0 + x1) / 2, (y0 + y1) / 2, 0.08]), n: wdir(M, [0, 0, 1]), area: (x1 - x0) * (y1 - y0) }); };
  let aftN = 0;
  for (const b of BAYS) {
    const W = b.w, M = b.M, f = b.f0, hw = W / 2, see = { seen: [0, 1.4, 3] }, yaw = Math.atan2(-M.elements[2], M.elements[0]), cols = [KICK, KICK, WALLC.map((v) => v * (0.965 + 0.07 * hash(b.a0, 3)))];
    if (b.kind === 'viewer') {
      // the main viewer: a hole with rounded corners in a dark surround, a bezel round it, and a ledge of small displays under it
      const hole = rrect(VIEW.w, VIEW.h, VIEW.r, 10), yb = VIEW.y + 0.03;
      const P = hole.map(([x, y]) => { const k = Math.min(hw / Math.max(Math.abs(x), 1e-6), (y > 0 ? WALL - VIEW.y : yb) / Math.max(Math.abs(y), 1e-6)); return [0, 0.35, 0.7, 1].map((t) => [x * lerp(1, k, t), VIEW.y + y * lerp(1, k, t), 0]); });
      put('wall', M, skin(P, { closedI: true, ...see, rgb: MOCHA }), box(W, 0.11, 0.02, [0, 0.045, 0.012], KICK));
      for (const sg of [-1, 1]) put('lamp', M, lamp(panel(sg * (VIEW.w / 2 + 0.2) - 0.03, 1.05, sg * (VIEW.w / 2 + 0.2) + 0.03, 1.95, 0.006, null), 7));      // the alert bars, unlit
      put('dark', M, panel(-hw, 0.015, hw, 0.085, 0.026, null, METAL));
      const ring = [[0.075, 0], [0.075, 0.03], [0.014, 0.046], [0, 0.03], [0, -0.16]];
      put('dark', M, skin(ring.map(([e, z]) => rrect(VIEW.w + 2 * e, VIEW.h + 2 * e, VIEW.r + e, 10).map(([x, y]) => [x, VIEW.y + y, z])), { closedJ: true, ...see, rgb: DARK }));
      put('wall', M, wallGrid(-1.9, 1.9, 0, 0, [[0, 0.2, 0], [0.24, 0.31, 0], [0.265, 0.365, 0], [0.02, 0.458, 0]], [MOCHA, MOCHA, DARK]));
      [-1.26, -0.42, 0.42, 1.26].forEach((x, k) => { const uv = A.uv(k % 2 ? 'ledge2' : 'ledge1'); put('lcars', M, quad([x - 0.31, 0.372, 0.236], [x + 0.31, 0.372, 0.236], [x + 0.31, 0.446, 0.054], [x - 0.31, 0.446, 0.054], ONE, { ...see, uv: (i, j) => uv(i, j) })); });
    } else if (b.kind === 'falc' || b.kind === 'aalc') {
      // an alcove: an opening with a rounded frame into a recess lined with quilted panels, a lit ceiling, and its doors at the back
      const fw = b.kind === 'falc', ox = fw ? 1.03 : 0.72, oh = 2.14, d = fw ? 0.72 : 0.62, top = f + oh, q = TR.uv('quilt'), du = TR.uv('door');
      put('wall', M, wallGrid(-hw, -ox, f, f, ROWS, cols), wallGrid(ox, hw, f, f, ROWS, cols), panel(-ox, top, ox, WALL, 0, null, WALLC));
      const path = fillet([[-ox, f - 0.03], [-ox, top], [ox, top], [ox, f - 0.03]], 0.24, 5), ring = [[0.11, 0], [0.11, 0.03], [0.025, 0.048], [0, 0.03], [0, -0.05]];
      put('wall', M, skin(path.map((p, i) => { const a = path[Math.max(i - 1, 0)], c = path[Math.min(i + 1, path.length - 1)], l = Math.hypot(c[0] - a[0], c[1] - a[1]), nx = -(c[1] - a[1]) / l, ny = (c[0] - a[0]) / l; return ring.map(([e, z]) => [p[0] + nx * e, p[1] + ny * e, z]); }), { ...see, rgb: CORN }));
      for (let r = 0; r < 3; r++) { const y0 = f + (oh * r) / 3, y1 = f + (oh * (r + 1)) / 3; for (const s of [-1, 1]) put('trim', M, quad([s * ox, y0, s < 0 ? -d : 0], [s * ox, y0, s < 0 ? 0 : -d], [s * ox, y1, s < 0 ? 0 : -d], [s * ox, y1, s < 0 ? -d : 0], QUILT.map((v) => v * 1.9), { ...see, uv: (i, j) => q(i, j) })); }
      put('lamp', M, lamp(quad([-ox + 0.12, top - 0.004, -d + 0.08], [ox - 0.12, top - 0.004, -d + 0.08], [ox - 0.12, top - 0.004, -0.1], [-ox + 0.12, top - 0.004, -0.1], ONE, { seen: [0, 0, 0] }), 0));
      put('wall', M, quad([-ox, top, -d], [ox, top, -d], [ox, top, 0], [-ox, top, 0], CORN, { seen: [0, 0, 0] }), panel(-ox, f - 0.03, ox, top, -d - (fw ? 0.3 : 0), null, QUILT), box(2 * ox, 0.012, d, [0, f + 0.006, -d / 2], KICK));
      for (const cx of fw ? [-0.52, 0.52] : [0]) {      // (a forward alcove's two doors stand at an angle to each other and meet at a post set further back)
        const dw = fw ? 0.5 : 0.55, Md = new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeRotationY(fw ? -Math.sign(cx) * 0.3 : 0).setPosition(cx, 0, fw ? -d - 0.14 : -d));
        put('trim', Md, panel(-dw, f, dw, f + 2.02, 0.005, du, ONE, 0.25)); put('wall', Md, box(2 * dw + 0.06, 0.05, 0.03, [0, f + 2.045, 0.015], QUILT));
        put('lamp', Md, lamp(quad([-0.09, f + 2.085, 0.008], [0.09, f + 2.085, 0.008], [0.09, f + 2.125, 0.008], [-0.09, f + 2.125, 0.008], ONE, see), 3));
      }
      if (fw) { const uv = A.uv('vstrip'); put('lcars', M, panel(-0.045, f + 0.75, 0.045, f + 1.6, -d - 0.272, uv, ONE, 9)); put('wall', M, box(0.14, oh, 0.04, [0, f + oh / 2, -d - 0.296], QUILT)); }
      put('lamp', M, lamp(panel(-ox - 0.29, f + 1.15, -ox - 0.235, f + 1.85, 0.006, null), 7));      // the alert bar, unlit
      put('dark', M, panel(ox + 0.185, f + 1.285, ox + 0.305, f + 1.485, 0.003, null, DARK)); put('lcars', M, panel(ox + 0.2, f + 1.3, ox + 0.29, f + 1.47, 0.006, A.uv('arm'), ONE, 9));      // the door's pad
      floods.push({ p: wpt(M, [0, top - 0.25, -d / 2]), i: 0.34, r: 0.9 }); glows.push({ x: wpt(M, [0, 0, -d / 2])[0], z: wpt(M, [0, 0, -d / 2])[2], r: 1.1, a: 0.2 });
    } else if (b.kind === 'aft') {
      // an aft station: its display in the band of black glass that runs across the back, over a console with a glass top, a stool before it
      const k = aftN++, name = ['eng', 'ops2', 'env', 'sci2', 'sci1'][k], live = name === 'eng', y0 = f + 1.0, y1 = f + 1.98;
      const rows = [[0.3, f - 0.03], [0.3, f + 0.09], [0.26, f + 0.1], [0.26, f + 0.7], [0.56, f + 0.74], [0.58, f + 0.8], [0.56, f + 0.83], [0.03, f + 0.975], [0.03, y0], [0.012, y0], [0.012, y1], [0, y1], [0, WALL]].map(([z, y]) => [z, y, 0]);
      put('wall', M, wallGrid(-hw, hw, 0, 0, rows, [KICK, KICK, QUILT, PLASTIC, PLASTIC, PLASTIC, DARK, DARK, DARK, DARK, DARK, WALLC]));
      if (k === 0 || k === 4) { const x = k === 0 ? -hw : hw; put('wall', M, cap(rows.slice(0, 9).map(([z, y]) => [x, y, z]).concat([[x, y0, 0], [x, f - 0.03, 0]]), [0, f + 0.5, 0.2], PLASTIC)); }
      put('dark', M, panel(-hw, y0, hw, y1, 0.014, null, DARK), quad([-hw, f + 0.832, 0.558], [hw, f + 0.832, 0.558], [hw, f + 0.977, 0.032], [-hw, f + 0.977, 0.032], DARK, see));
      const uv = live ? (s, t) => [s, t] : A.uv(name), ku = A.uv(k % 2 ? 'keys2' : 'keys'), sl = (z) => f + 0.975 - 0.2736 * (z - 0.03) + 0.006;
      put(live ? 'eng' : 'lcars', M, panel(-0.5, y0 + 0.07, 0.5, y0 + 0.91, 0.019, uv, ONE, 9));
      put('lcars', M, quad([-0.52, sl(0.52), 0.52], [0.52, sl(0.52), 0.52], [0.52, sl(0.07), 0.07], [-0.52, sl(0.07), 0.07], ONE, { ...see, uv: (i, j) => ku(i, j) }));
      wins.push({ c: wpt(M, [0, y0 + 0.5, 0.1]), n: wdir(M, [0, 0, 1]), area: 0.8 });
      strip(M, -hw, hw, y1 + 0.07);
      if (k === 1 || k === 4) man(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(k === 1 ? 0.1 : -0.08, f, 0.8)), k === 1 ? { k: 0.95, wide: 0.93, dept: GOLD, tone: [0.55, 0.36, 0.26], hair: [0.16, 0.07, 0.03], hands: [[-0.2, 0.9, -0.5], [0.17, 0.9, -0.46]] } : { k: 1.01, wide: 1.03, dept: BLUE, tone: [0.3, 0.17, 0.1], hair: [0.02, 0.015, 0.012], hands: [[-0.16, 0.9, -0.46], [0.22, 0.9, -0.5]] });
      else putSeat(K, new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(0, f, 1.02)), 'stool');
      ao(new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(0, f + 0.42, 0.3)), [hw, 0.4, 0.27]);
      const c = wpt(M, [0, 0, 0.3]); shadows.push({ x: c[0], z: c[2], w: W, d: 0.62, yaw, r: 0.16, a: 0.55 });
    } else {
      put('wall', M, wallGrid(-hw, hw, b.f0, b.f1, ROWS, cols)); strip(M, -hw + 0.05, hw - 0.05);
      put('dark', M, quad([-hw, b.f0 + 0.015, 0.026], [hw, b.f1 + 0.015, 0.026], [hw, b.f1 + 0.085, 0.026], [-hw, b.f0 + 0.085, 0.026], METAL, see));      // a kick plate of brushed metal
      if (b.kind === 'tall') glass(M, -0.2, 0.75, 0.2, 1.95, A.uv('tall1'));
      else if (b.kind === 'strip') glass(M, -0.065, f + 0.7, 0.065, f + 1.9, A.uv('vstrip'), 'lcars', 0.02);
      else if (b.kind === 'lock') {
        // a bank of lockers let into the wall, in a frame with rounded corners
        const lw = 1.02, y0 = 0.78, y1 = 2.1, uv = TR.uv('lockers'), ring = [[0.07, 0], [0.07, 0.026], [0.014, 0.036], [0, 0.022], [0, 0.004]];
        put('trim', M, panel(-lw, y0, lw, y1, 0.005, uv, ONE, 0.33));
        put('wall', M, skin(ring.map(([e, z]) => rrect(2 * lw + 2 * e, y1 - y0 + 2 * e, 0.07 + e, 4).map(([x, y]) => [x, (y0 + y1) / 2 + y, z])), { closedJ: true, ...see, rgb: CORN }));
      } else if (b.port) { const uv = TR.uv('plaque'); put('trim', M, panel(-0.2, f + 1.37, 0.2, f + 1.67, 0.006, uv, ONE, 1)); put('dark', M, panel(-0.215, f + 1.355, 0.215, f + 1.685, 0.003, null, KICK)); }      // the dedication plaque
    }
  }

  // ---- the cornice, and the luminous ceiling: a dome of white panels between ribs and three broad arms, up to the skylight
  const CA = []; for (const b of BAYS) { const n = Math.max(1, Math.ceil((b.a1 - b.a0) / (3 * D2R) - 1e-6)); for (let k = 0; k < n; k++) CA.push(b.a0 + ((b.a1 - b.a0) * k) / n); }
  const CB = [...CA, CA[0] + TAU], dome = (a, t, drop = 0) => at(a, t * Rw(a), domeY(t) - drop), ARMS = [0, 135 * D2R, -135 * D2R];
  {
    const cs = (a) => { const R = wallR(a), Rs = Rw(a); return fillet([[R + 0.03, WALL], [R - 0.1, WALL], [R - 0.12, WALL + 0.1], [R - 0.5, WALL + 0.13], [R - 0.93, WALL + 0.2], [R - 1.03, WALL + 0.32], [R - 0.97, WALL + 0.45], [Math.max(0.82 * Rs, R - 0.9), 3.05]], 0.07, 3); };
    const ccol = [KICK, KICK, CORN, CORN, CORN, CORN, CORN], S0 = cs(0);
    G.add('wall', skin(CA.map((a) => cs(a).map(([r, y]) => at(a, r, y))), { closedI: true, color: (i, j) => ccol[S0[j][2]] }));
    const ts = Array.from({ length: 11 }, (_, q) => 0.82 - 0.062 * q);
    G.add('dome', skin(CA.map((a) => ts.map((t) => dome(a, t))), { closedI: true, uv: (i, j) => [(CA[i % CA.length] / TAU) * 40 + (i >= CA.length ? 40 : 0), j / 5] }));      // (a panel of the texture to each bay between ribs)
    G.add('wall', skin(CA.map((a) => { const r = 0.2 * Rw(a), y = domeY(0.2); return [at(a, r + 0.02, y + 0.01), at(a, r, y - 0.07), at(a, r * 0.78, y - 0.07), at(a, r * 0.78, TOP)]; }), { closedI: true, color: (i, j) => (j === 2 ? DARK : CORN) }));
    for (const a of ARMS) {            // the arms: broad beams from the cornice to the hub
      G.add('wall', skin(Array.from({ length: 12 }, (_, q) => { const t = 0.84 - 0.059 * q, p = dome(a, t), w = lerp(0.3, 0.48, (t - 0.19) / 0.65), tx = Math.cos(a) * w, tz = Math.sin(a) * w; return [[p[0] - tx, p[1] + 0.04, p[2] - tz], [p[0] - tx, p[1] - 0.07, p[2] - tz], [p[0] + tx, p[1] - 0.07, p[2] + tz], [p[0] + tx, p[1] + 0.04, p[2] + tz]]; }), { rgb: CORN, seen: [0, 1, ZC] }));
    }
    { const c = (t, s) => { const p = dome(0, t, 0.076); return [p[0] + s * 0.22, p[1], p[2]]; }; G.add('dark', quad(c(0.42, -1), c(0.42, 1), c(0.3, 1), c(0.3, -1), DARK, { seen: [0, 1, ZC] })); }      // the grille in the forward arm
    for (let k = 0; k < 40; k++) {      // thin ribs between the panels, every other one stopping at the ring half way up
      const a = (k / 40) * TAU; if (ARMS.some((m) => Math.abs(Math.atan2(Math.sin(a - m), Math.cos(a - m))) < 0.14)) continue;
      const t1 = k % 2 ? 0.5 : 0.21, tx = Math.cos(a) * 0.034, tz = Math.sin(a) * 0.034;
      G.add('wall', skin(Array.from({ length: 8 }, (_, q) => { const p = dome(a, lerp(0.82, t1, q / 7)); return [[p[0] - tx, p[1] + 0.02, p[2] - tz], [p[0] - tx, p[1] - 0.05, p[2] - tz], [p[0] + tx, p[1] - 0.05, p[2] + tz], [p[0] + tx, p[1] + 0.02, p[2] + tz]]; }), { rgb: CORN, seen: [0, 1, ZC] }));
    }
    for (const t of [0.51, 0.345]) G.add('wall', skin(CB.map((a) => [dome(a, t + 0.022, -0.02), dome(a, t + 0.022, 0.05), dome(a, t - 0.022, 0.053), dome(a, t - 0.022, -0.02)]), { rgb: CORN, seen: [0, 1, ZC] }));      // two rings round the dome
    for (let k = 0; k < 10; k++) floods.push({ p: dome((k / 10) * TAU, 0.6, 0.15), i: 0.25, r: 3.4 });
    for (let k = 0; k < 5; k++) floods.push({ p: dome(((k + 0.5) / 5) * TAU, 0.3, 0.15), i: 0.27, r: 3.8 });
  }

  // ---- the horseshoe: a leaning band of wood over a low wall, and the tactical desk at its back
  const NH = 112, hs = Array.from({ length: NH + 1 }, (_, k) => hsAt((TIP + ((360 - 2 * TIP) * k) / NH) * D2R));
  {
    let acc = 0; hs.forEach((s, k) => { if (k) acc += Math.hypot(s.p[0] - hs[k - 1].p[0], s.p[1] - hs[k - 1].p[1]); s.s = acc; });
    const foot = (s) => { const T = railY(s.a), h = floorH(s.a), L = lean(s.a), k = Math.min(1, 0.46 / Math.hypot(L, T - h)); return [L * k, T - (T - h) * k - (k === 1 ? 0.02 : 0)]; };      // the band's lower edge: on the floor near its ends, in the air further back
    const BP = stand(hs, (s) => { const T = railY(s.a), f = foot(s); return fillet([f, [0.014, T - 0.008], [-0.03, T], [-0.06, T - 0.034], [f[0] - 0.07, f[1] + 0.025]], 0.02, 3, true); });
    const core = (i) => { const s = hs[Math.min(i, NH)], f = foot(s), u = f[0] * 0.5 - 0.03; return [s.p[0] + s.n[0] * u, (railY(s.a) + f[1]) / 2, s.p[1] + s.n[1] * u]; };
    G.add('wood', skin(BP, { closedJ: true, away: core, crease: 40, uv: (i, j) => [hs[i].s / 1.5, j * 0.07] }), cap(BP[0], core(1)), cap(BP[NH], core(NH - 1)));
    const RP = stand(hs, (s) => { const W = riserY(s.a); return [[0.1, -0.02], [0.1, W * 0.33], [0.1, W * 0.66], [0.1, W], [0.24, W]]; });
    G.add('wall', skin(RP, { color: (i, j) => (j === 3 ? DARK : PANEL), crease: 30 }));
    for (let k = 4; k < NH; k += 4) {                     // the low wall's paneling: seams up it, and one along it where it stands tall
      const s = hs[k], W = riserY(s.a); if (W < 0.25) continue;
      const tx = -s.n[1] * 0.006, tz = s.n[0] * 0.006, x = s.p[0] + s.n[0] * 0.096, z = s.p[1] + s.n[1] * 0.096;
      G.add('wall', quad([x - tx, 0.02, z - tz], [x + tx, 0.02, z + tz], [x + tx, W - 0.02, z + tz], [x - tx, W - 0.02, z - tz], KICK, {}));
    }
    for (let k = 3; k < NH; k += 5) { const s = hs[k], T = railY(s.a), h = floorH(s.a), L = lean(s.a); if (T - h < 0.2) continue; ao(new THREE.Matrix4().makeRotationY(Math.atan2(s.n[0], s.n[1])).setPosition(s.p[0] + s.n[0] * L * 0.55, (T + h) / 2, s.p[1] + s.n[1] * L * 0.55), [0.34, (T - h) / 2, 0.06 + L * 0.3]); }
    // tactical: a desk of the same wood across the back, three panels of glass let into it, on a pedestal either side of the low wall
    const NT = 28, td = Array.from({ length: NT + 1 }, (_, k) => hsAt((DESK + ((360 - 2 * DESK) * k) / NT) * D2R)), dsec = fillet([[-0.16, 1.2], [-0.14, 1.246], [0.62, 1.186], [0.66, 1.15], [0.62, 1.112], [-0.12, 1.142]], 0.016, 2, true);
    const DP = stand(td, dsec), dc = (i) => { const s = td[Math.min(i, NT)]; return [s.p[0] + s.n[0] * 0.25, 1.17, s.p[1] + s.n[1] * 0.25]; };
    G.add('wood', skin(DP, { closedJ: true, away: dc, crease: 40, uv: (i, j) => [i * 0.11, j * 0.05] }), cap(DP[0], dc(1)), cap(DP[NT], dc(NT - 1)));
    for (const [k0, k1, name] of [[1, 9, 'tact2'], [10, 18, 'tact'], [19, 27, 'keys2']]) {
      const uv = A.uv(name), Q = stand(td.slice(k0, k1 + 1), [[-0.1, 1.2468], [0.6, 1.1916]]);
      G.add('dark', skin(stand(td.slice(k0, k1 + 1), [[-0.115, 1.2462], [0.615, 1.1886]]), { seen: [0, 6, 2], rgb: DARK })); G.add('lcars', skin(Q, { seen: [0, 6, 2], uv: (i, j) => uv(1 - i / (k1 - k0), 1 - j) }));
    }
    for (let k = 2; k < NT; k += 4) { const s = td[k]; ao(new THREE.Matrix4().makeRotationY(Math.atan2(s.n[0], s.n[1])).setPosition(s.p[0] + s.n[0] * 0.25, 1.17, s.p[1] + s.n[1] * 0.25), [0.3, 0.04, 0.4]); }
    const zb = HC + HZ, ped = [rrect(0.52, 0.16, 0.05).map(([x, z]) => [x, 0, z + zb + 0.02]), rrect(1.0, 0.22, 0.06).map(([x, z]) => [x, 1.135, z + zb - 0.02])];
    G.add('wall', skin(ped, { closedJ: true, away: [0, 0.8, zb], rgb: CORN }), ...rbox(0.74, 0.3, UP, 1.13, 0.07, CORN).map((g) => g.translate(0, 0, zb + 0.42)));
    shadows.push({ x: 0, z: zb + 0.42, w: 0.78, d: 0.34, r: 0.14, a: 0.55 });
  }

  // ---- the floor: the command area and everything forward of it, then the ramps and the aft level outside the horseshoe
  {
    const clip = BAYS.map((b) => [b.nin[0], -b.nin[1], -(b.nin[0] * b.p0[0] + b.nin[1] * b.p0[2]) + (b.kind === 'viewer' ? 0.02 : b.kind.endsWith('alc') ? 1.1 : 0.08)]);
    G.add('floor', plateGeo(-6.2, -5.6, 6.2, 7.1, 12, 13, (x, y) => floorUv(x, -y), clip).rotateX(-Math.PI / 2));
    const P = Array.from({ length: 69 }, (_, k) => { const a = (78 + 3 * k) * D2R, e = hsAt(a), h = floorH(a), o = at(a, wallR(a) + 1.1, h); return Array.from({ length: 5 }, (_, j) => [lerp(e.p[0] + e.n[0] * 0.1, o[0], j / 4), h, lerp(e.p[1] + e.n[1] * 0.1, o[2], j / 4)]); });
    G.add('floor', skin(P, { seen: [0, 6, 0], uv: (i, j, p) => floorUv(p[0], p[2]) }));
  }

  // ---- ops and conn, and the command seats with a small console at either end
  helmUnit(K, HELM.x, HELM.z, 'conn'); helmUnit(K, -HELM.x, HELM.z, 'ops');
  for (const [x, z, yaw, kind] of [[0, 0.02, 0, 'capt'], [1.0, -0.06, 0.12, 'cmd'], [-1.0, -0.06, -0.12, 'cmd'], [1.8, -0.36, 0.42, 'end'], [-1.8, -0.36, -0.42, 'end']]) putSeat(K, place(x, z, yaw), kind);
  pod(K, 2.28, -0.86, -0.86, 1); pod(K, -2.28, -0.86, 0.86, -1);
  man(place(HELM.x, HELM.z + 0.05), { sit: 1, k: 0.97, wide: 1.0, dept: RED, tone: [0.5, 0.3, 0.2], hair: [0.03, 0.02, 0.015], hands: [[-0.2, 0.765, -0.7], [0.23, 0.765, -0.72]], foot: [0.3, -0.6] });
  man(place(-HELM.x, HELM.z + 0.05), { sit: 1, k: 1.0, wide: 1.06, dept: GOLD, tone: [0.22, 0.12, 0.07], hair: [0.01, 0.01, 0.01], hands: [[-0.24, 0.765, -0.72], [0.18, 0.765, -0.7]], foot: [0.3, -0.6] });
  man(place(0, HC + HZ + 0.78, 0, UP), { k: 1.04, wide: 1.1, dept: GOLD, tone: [0.42, 0.26, 0.17], hair: [0.05, 0.03, 0.02], hands: [[-0.25, 0.86, -0.34], [0.22, 0.86, -0.36]] });

  // ---------------------------------------------------------------- light, materials, meshes
  const U = cabinLight([]); U.uSceneK.value = 0;              // no window: nothing of the scene's light comes in
  const env = envTexture(), fab = weave(256, 44, 0.9), lea = grain(256, 5, 2600, 1.2, 3.4, 1.2, 3), pile = grain(256, 8, 5200, 0.8, 1.9, 2.4, 0), wd = woodTextures(), V2 = (v) => new THREE.Vector2(v, v);
  pile.normalMap.repeat.set(FLOOR.span / 0.14, FLOOR.span / 0.14); pile.map.dispose();
  const screen = (t) => new THREE.MeshBasicMaterial({ map: t, envMap: env, combine: THREE.AddOperation, reflectivity: 0.1, fog: false });
  const mkLive = (w, h, draw) => { const l = new Live(w, h, (g, st) => { if (st) draw(g, st); }); l.tex.anisotropy = 16; return l; };
  const lives = { conn: mkLive(LW, LH, drawConn), ops: mkLive(LW, LH, drawOps), eng: mkLive(EW, EH, drawEng) }, liveList = [lives.conn, lives.ops, lives.eng];
  const mats = {
    wall: roomMat(U, { map: fab.map, normalMap: fab.normalMap, normalScale: V2(0.3), roughness: 0.68, envMap: env }),
    trim: roomMat(U, { map: TR.tex, roughness: 0.6, envMap: env }),
    floor: roomMat(U, { map: A.tex, normalMap: pile.normalMap, normalScale: V2(0.9), roughness: 0.97, envMap: env }),
    leather: roomMat(U, { map: lea.map, normalMap: lea.normalMap, normalScale: V2(0.28), roughness: 0.44, envMap: env }),
    wood: roomMat(U, { map: wd.map, normalMap: wd.normalMap, roughnessMap: wd.roughnessMap, normalScale: V2(0.5), roughness: 1, envMap: env }),
    dark: roomMat(U, { roughness: 0.2, envMap: env }),
    cloth: roomMat(U, { map: fab.map, normalMap: fab.normalMap, normalScale: V2(0.6), roughness: 0.86, envMap: env }), skin: roomMat(U, { roughness: 0.55, envMap: env }),
    lcars: screen(A.tex), conn: screen(lives.conn.tex), ops: screen(lives.ops.tex), eng: screen(lives.eng.tex),
    lamp: new THREE.MeshBasicMaterial({ map: lampTexture(), fog: false }), dome: new THREE.MeshBasicMaterial({ map: panelTexture(), fog: false }),
  };
  const GLOSS = { wall: 0.55, trim: 0.5, floor: 0.25, leather: 0.8, wood: 1.0, dark: 1.3, cloth: 0.3, skin: 0.6 }, TILE = { wall: 0.3, leather: 0.2, dark: 0.3, cloth: 0.1 }, screens = [mats.lcars, mats.conn, mats.ops, mats.eng];
  let tris = 0; const geos = {};
  for (const name of Object.keys(G.lists)) { const g = G.geometry(name); if (!g) continue; if (TILE[name]) boxUv(g, TILE[name]); geos[name] = g; tris += g.attributes.position.count / 3; }
  mats.floor.map = paintFloor(lightRoom(geos, floods)); constLit(geos.floor, FMAX, 0.2);
  for (const name of Object.keys(geos)) {
    const m = meshFrom(geos[name], mats[name] || mats.skin); m.name = name; root.add(m);
    if (name.startsWith('head')) { const c = crew[+name.slice(4)]; geos[name].translate(-c.neck[0], -c.neck[1], -c.neck[2]); m.position.set(c.neck[0], c.neck[1], c.neck[2]); c.mesh = m; }      // (a head turns about its neck)
  }

  // ---------------------------------------------------------------- the interface
  const st = { turn: 0, clock: 0, slot: -1, phase: 0, v: ['0', 'MPH', ''], alt: null, rng: null }, q0 = new THREE.Quaternion(), e0 = new THREE.Euler();
  function update(dt, s = {}) {
    // the room's own lights, held steady as the picture's exposure opens and closes
    const gain = 1 / Math.pow(s.exposure || 1.25, 0.8);
    U.uFlood.value.set(1.0, 0.95, 0.87).multiplyScalar(0.78 * gain); U.uDay.value.set(1.0, 0.72, 0.5).multiplyScalar(0.16 * gain);
    mats.lamp.color.setScalar(1.1 * gain); mats.dome.color.setScalar(0.8 * gain); for (const m of screens) { m.color.setScalar(1.15 * gain); m.reflectivity = 0.1 * gain; }
    // reflections: the room's own panorama, kept square with the room as the ship turns
    root.getWorldQuaternion(q0); e0.setFromQuaternion(q0, 'XYZ');          // (three turns the lookup by the inverse of this: checked by turning the room and comparing pictures)
    for (const k of Object.keys(mats)) { const m = mats[k]; if (m.envMap) m.envMapRotation.copy(e0); if (GLOSS[k]) m.envMapIntensity = GLOSS[k] * gain; }
    // the displays: figures ten times a second, words as they change
    st.clock += dt || 0;
    const time = s.time ?? st.clock, warp = Math.max(0, s.warp || 0), spool = clamp01(s.spool || 0), imp = clamp01(s.impulse || 0), slot = Math.floor(time * 10);
    if (slot !== st.slot) {
      st.slot = slot;
      st.v = speedText(Math.max(0, s.speed || 0), warp); st.alt = s.world ? distText(Math.max(0, s.height || 0)) : null; st.rng = s.dest ? distText(Math.max(0, s.distance || 0)) : null;
    }
    const run = Math.max(spool, warp > 0 ? 1 : 0); st.phase = run > 0.02 ? (st.phase + Math.min(dt || 0, 0.1) * (4 + 6 * spool)) % 4096 : 0;      // the warp core beats faster as it winds up
    const ph = Math.floor(st.phase), level = warp > 0 ? 0.5 + 0.45 * Math.min(1, warp / 9) : 0;
    const bars = Array.from({ length: 12 }, (_, k) => clamp01(Math.max(level, spool * (0.55 + 0.6 * hash(k, ph))) + (run > 0.02 ? (hash(k + 20, ph) - 0.5) * 0.16 : 0)));
    const helm = s.helm ? String(s.helm).toUpperCase() : s.orbit ? 'STANDARD ORBIT' : '', impQ = Math.round(imp * 50) / 50;
    lives.conn.want(`${st.v.join('|')}|${helm}|${impQ}|${bars.map((b) => Math.round(b * 30)).join(',')}`, { v: st.v, helm, imp: impQ, bars });
    const world = String(s.world || '').toUpperCase(), dest = s.dest ? String(s.dest).toUpperCase() : '';
    lives.ops.want(`${world}|${st.alt}|${dest}|${st.rng}|${!!s.orbit}`, { world, alt: st.alt, dest, rng: st.rng, orbit: !!s.orbit });
    const fl = clamp01(Math.max(level, spool * 0.9)), label = warp > 0 ? st.v[0] : spool > 0.02 ? 'ENGAGING' : imp > 0.02 ? 'IMPULSE' : 'STANDBY';
    lives.eng.want(`${ph}|${Math.round(fl * 20)}|${impQ}|${label}`, { run, phase: ph, field: [fl, fl], imp: impQ, label });
    flushLive(liveList, st.turn++, 2);
    // the crew: a head turns a little now and then, and rides the breath
    for (const c of crew) if (c.mesh) { const t = time * 0.23 + c.ph; c.mesh.rotation.y = 0.24 * Math.sin(t) * Math.sin(t * 0.37 + 1) + 0.05 * Math.sin(t * 2.3 + c.ph); c.mesh.rotation.x = 0.05 * Math.sin(t * 0.61 + 2); c.mesh.position.y = c.neck[1] + 0.0025 * Math.sin(time * 1.3 + c.ph); }
  }
  update(0, {}); for (const l of liveList) if (l.dirty) l.flush();

  const bridge = {
    root, height: TOP + 0.05, eye: new THREE.Vector3(...EYE), fov: 55, reach: { yaw: 2.9, up: 1.25, down: 0.95 },
    viewer: { center: new THREE.Vector3(0, VIEW.y, BAYS[0].p0[2]), width: VIEW.w, height: VIEW.h, corner: VIEW.r },
    skylight: { center: new THREE.Vector3(0, TOP, ZC), rx: 0.156 * RS, rz: 0.156 * (RF + RA) / 2 },
    update, dispose() { disposeTree(root); },
    info: { ms: 0, triangles: tris, atlas: A.canvas, lives: liveList.map((l) => l.c) },
  };
  bridge.info.ms = +(performance.now() - t0).toFixed(1);
  return bridge;
}
