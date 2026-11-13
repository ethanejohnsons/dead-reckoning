// The cabin, as it looks from the left seat and through the windows: lining and window surrounds, carpet,
// upholstered seats with fluted cloth inserts and piping, door cards with armrests, pockets, handles and
// window latches, headliner, visors, glareshield, pedestal, pedals, yokes, and the people on board
// (the pilot's body below the camera, a passenger in the right seat).
//
// Everything is built straight in the variant's own coordinates from the cabin's measured width
// (A.hullX), so a narrow 152 and a wide 182 each get a cabin that fits. Surfaces carry tiling grain
// textures by box projection, and soft contact shading baked per vertex (see cabinkit.js).

import * as THREE from 'three';
import { lerp, clamp01, sstep, lin, loftGrid, sweep, ellipse, prim, merge, rod, canvas, normalFromHeight } from './kit.js';
import { cabinMat, grainMat, grain, boxUv, flatAO, bakeAO, shared } from './cabinkit.js';
import { PANEL_Z, panelLayout } from './panel.js';

const SKIN = [0.4, 0.235, 0.16];
const DARK = [0.02, 0.02, 0.022], CHROME = [0.72, 0.73, 0.75], RUBBER = [0.012, 0.012, 0.013];
const V = (a) => new THREE.Vector3(...a);
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------- upholstery

/** A soft-edged pad swept from a to b: width along `ref`, thickness across it. */
function pad(a, b, w0, w1, t, rgb, ref = [1, 0, 0]) {
  const path = Array.from({ length: 8 }, (_, k) => [0, 1, 2].map((i) => lerp(a[i], b[i], k / 7)));
  return sweep(path, (u) => { const r = Math.max(Math.pow(Math.sin(Math.PI * clamp01(0.06 + 0.88 * u)), 0.3), 0.3), w = lerp(w0, w1, u) * 0.5 * (0.8 + 0.2 * r), h = t * 0.5 * r; return Array.from({ length: 16 }, (_, j) => { const an = (j / 16) * 2 * Math.PI, c = Math.cos(an), sn = Math.sin(an); return [w * Math.sign(c) * Math.pow(Math.abs(c), 0.5), h * Math.sign(sn) * Math.pow(Math.abs(sn), 0.5)]; }); }, ref, { rgb });
}
/**
 * The cloth panel let into the face of a pad running a to b (width along x): raised flutes, worn darker
 * and flatter in the middle where someone sits, with a piped edge. Returns [cloth, piping].
 */
function insert(a, b, wi, t, rgb, pipe, flutes = 5) {
  const A = V(a), B = V(b), dir = B.clone().sub(A).normalize(), f = new THREE.Vector3(0, dir.z, -dir.y).normalize(), M = 12, N = 4 * flutes + 1, rows = [];
  const at = (s, u, lift) => {
    const sp = lerp(0.1, 0.9, s), r = Math.max(Math.pow(Math.sin(Math.PI * clamp01(0.06 + 0.88 * sp)), 0.3), 0.3), end = sstep(0, 0.12, s) * sstep(1, 0.88, s);
    const wear = Math.exp(-(u * u) / 0.06 - Math.pow(s - 0.45, 2) / 0.08);
    const h = t * 0.5 * r * (1 - 0.22 * u * u) + 0.002 + lift * end * (1 - 0.45 * wear);
    const p = A.clone().lerp(B, sp).addScaledVector(f, h); p.x += u * wi;
    return [p.x, p.y, p.z, wear];
  };
  for (let i = 0; i <= M; i++) rows.push(Array.from({ length: N }, (_, j) => { const u = j / (N - 1) - 0.5; return at(i / M, u, 0.009 * Math.sqrt(Math.abs(Math.sin(Math.PI * flutes * (u + 0.5))))); }));
  const cloth = loftGrid(rows, { out: [f.x, f.y, f.z], color: (p) => mul(rgb, 1 - 0.2 * p[3]), uv: (p) => [p[0], p[2]] });
  const edge = (u) => sweep(Array.from({ length: M + 1 }, (_, i) => at(i / M, u, 0.003).slice(0, 3)), ellipse(0.0055, 0.0055, 6), [1, 0, 0], { rgb: pipe });
  const ends = [0, 1].map((s) => sweep(Array.from({ length: 7 }, (_, j) => at(s, j / 6 - 0.5, 0.003).slice(0, 3)), ellipse(0.0055, 0.0055, 6), [0, 0, 1], { rgb: pipe }));
  return [cloth, merge([edge(-0.5), edge(0.5), ...ends])];
}

// ---------------------------------------------------------------- people

/** A tapered limb from a to b with rounded joints. */
function limb(a, b, r0, r1, rgb, n = 10) {
  return merge([sweep([a, b], (t) => ellipse(lerp(r0, r1, t), lerp(r0, r1, t), n), Math.abs(b[1] - a[1]) > Math.abs(b[2] - a[2]) ? [0, 0, 1] : [0, 1, 0], { rgb }),
    prim(new THREE.SphereGeometry(r0, n, 8), { pos: a, rgb }), prim(new THREE.SphereGeometry(r1, n, 8), { pos: b, rgb })]);
}
/**
 * A hand. Built with the wrist at the origin, fingers along -Z, palm facing -Y, then turned so the fingers
 * point along `fwd` and the palm faces `palm`. curl 0 = flat, 1 = fist.
 */
function hand(left, wrist, fwd, palm, curl, rgb = SKIN) {
  const g = [prim(new THREE.SphereGeometry(1, 12, 8), { pos: [0, 0, -0.05], scale: [0.042, 0.017, 0.05], rgb })], tx = left ? 1 : -1;
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * 0.02, len = [0.036, 0.042, 0.04, 0.03][left ? 3 - k : k];
    let p = [x, 0, -0.09], a = curl * 1.15;
    for (const [l, r, da] of [[len, 0.0098, 1.3], [len * 0.72, 0.0088, 0.9], [len * 0.55, 0.008, 0]]) { const q = [x, p[1] - l * Math.sin(a), p[2] - l * Math.cos(a)]; g.push(rod(p, q, r, rgb, 6)); p = q; a += curl * da; }
  }
  g.push(rod([tx * 0.03, -0.004, -0.028], [tx * 0.058, -0.008 - 0.012 * curl, -0.062], 0.0115, rgb, 6), rod([tx * 0.058, -0.008 - 0.012 * curl, -0.062], [tx * 0.06 - tx * 0.012 * curl, -0.012 - 0.03 * curl, -0.094], 0.0098, rgb, 6));
  const F = V(fwd).normalize(), Nn = V(palm).normalize(), Z = F.clone().negate(), Y = Nn.clone().negate(), X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  Y.crossVectors(Z, X).normalize();
  const m = merge(g); m.applyMatrix4(new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(V(wrist)));
  return m;
}
/** Forearm for a moving hand: a unit limb along +Z, to be placed at the elbow, aimed at the wrist and scaled to length. */
function forearmGeo(rgb) {
  return merge([sweep([[0, 0, 0], [0, 0, 1]], (t) => ellipse(lerp(0.043, 0.03, t), lerp(0.043, 0.03, t), 10), [0, 1, 0], { rgb }), prim(new THREE.SphereGeometry(0.044, 10, 8), { scale: [1, 1, 0.3], rgb })]);
}

/**
 * Someone sitting in a seat whose cushion is centered at (x, z). Returns { body, head }: lists of geometry.
 *   o.lean      how far the shoulders sit ahead (-) or behind (+) the hips, meters
 *   o.arms      { L, R }: each null (the arm is animated elsewhere) or [elbow, wrist, handForward, palmNormal, curl]
 *   o.feet      x offsets of the two ankles from the seat center line
 */
function person(x, z, o) {
  const body = [], head = [], hipZ = z + 0.1, shZ = hipZ + o.lean, shY = 0.265, { shirt, trousers, hair, skin = SKIN } = o;
  // torso: hips, waist, chest, shoulders
  const Wd = [0.165, 0.15, 0.168, 0.188, 0.186, 0.1], Dp = [0.115, 0.1, 0.105, 0.11, 0.098, 0.07];
  const path = Array.from({ length: 6 }, (_, k) => [x, lerp(-0.2, shY + 0.03, k / 5), lerp(hipZ, shZ, k / 5)]);
  body.push(sweep(path, (t) => { const k = Math.min(4.999, t * 5), i = Math.floor(k), f = k - i; return ellipse(lerp(Wd[i], Wd[i + 1], f), lerp(Dp[i], Dp[i + 1], f), 18); }, [1, 0, 0], { rgb: shirt }));
  // collar and neck
  body.push(prim(new THREE.TorusGeometry(0.062, 0.014, 6, 16), { pos: [x, shY + 0.045, shZ - 0.005], rot: [Math.PI / 2 - 0.25, 0, 0], rgb: mul(shirt, 0.85) }));
  body.push(limb([x, shY + 0.02, shZ + 0.005], [x, shY + 0.1, shZ - 0.004], 0.046, 0.04, skin));
  // legs, feet on or near the pedals
  for (const s of [-1, 1]) {
    const hip = [x + s * 0.09, -0.185, hipZ - 0.04], knee = [x + s * 0.115, -0.13, hipZ - 0.44], ank = [x + s * o.feet, -0.415, hipZ - 0.66];
    body.push(limb(hip, knee, 0.082, 0.062, trousers, 12), limb(knee, ank, 0.058, 0.044, trousers, 10));
    body.push(limb([ank[0], ank[1] - 0.03, ank[2] + 0.03], [ank[0], ank[1] + 0.005, ank[2] - 0.15], 0.045, 0.036, [0.03, 0.028, 0.026], 10));
    // arms: sleeve to the elbow, bare forearm
    const sh = [x + s * 0.2, shY - 0.01, shZ], arm = o.arms[s < 0 ? 'L' : 'R'], elbow = arm ? arm[0] : o.elbows[s < 0 ? 'L' : 'R'];
    body.push(prim(new THREE.SphereGeometry(0.058, 12, 8), { pos: sh, rgb: shirt }), limb(sh, elbow, 0.054, 0.046, shirt, 10));
    if (arm) body.push(limb(arm[0], arm[1], 0.043, 0.03, skin, 10), hand(s < 0, arm[1], arm[2], arm[3], arm[4], skin));
  }
  // shoulder harness and lap belt
  { const d = o.belt, zc = (y) => lerp(hipZ, shZ, clamp01((y + 0.2) / (shY + 0.23))) - 0.118;
    const pts = [[x + d * 0.17, shY + 0.07, shZ + 0.06], [x + d * 0.13, shY + 0.045, shZ - 0.07], [x + d * 0.06, 0.12, zc(0.12) - 0.004], [x - d * 0.05, -0.04, zc(-0.04) - 0.012], [x - d * 0.14, -0.15, zc(-0.15) - 0.004]];
    body.push(sweep(pts, ellipse(0.024, 0.0035, 8), [1, 0, 0], { rgb: [0.06, 0.06, 0.065] }));
    body.push(sweep([[x - 0.17, -0.165, hipZ - 0.03], [x - 0.09, -0.115, hipZ - 0.125], [x + 0.09, -0.115, hipZ - 0.125], [x + 0.17, -0.165, hipZ - 0.03]], ellipse(0.0035, 0.024, 8), [0, 1, 0], { rgb: [0.06, 0.06, 0.065] }));
    body.push(prim(new THREE.BoxGeometry(0.05, 0.035, 0.012), { pos: [x - d * 0.1, -0.11, hipZ - 0.132], rgb: CHROME })); }
  // head: skull, jaw, nose, mouth, hair, sunglasses, headset with a boom microphone
  const C = [x, shY + 0.185, shZ - 0.02], P = (dx, dy, dz) => [C[0] + dx, C[1] + dy, C[2] + dz], tw = o.turn || 0;
  const hp = [];
  // skull and face as one loft, chin to crown: [height, half-width, depth to the front, depth to the back]
  const HEAD = [[-0.12, 0.026, 0.056, -0.022], [-0.104, 0.046, 0.076, 0.008], [-0.075, 0.06, 0.088, 0.042], [-0.04, 0.068, 0.093, 0.068], [0.0, 0.074, 0.091, 0.086], [0.04, 0.077, 0.089, 0.097], [0.075, 0.073, 0.08, 0.098], [0.1, 0.06, 0.062, 0.086], [0.12, 0.034, 0.03, 0.055]];
  const ring = (y, w, f, b) => Array.from({ length: 22 }, (_, j) => { const a = (j / 22) * 2 * Math.PI, sn = Math.sin(a); return P(w * Math.cos(a), y, sn < 0 ? f * sn : b * sn); });
  hp.push(loftGrid(HEAD.map(([y, w, f, b]) => ring(y, w, f, b)), { closed: true, capStart: true, capEnd: true, rgb: skin, uv: () => [0.5, 0.5] }));
  // hair: a shell over the crown and the back of the head, the hairline across the forehead
  const hairRows = HEAD.filter((r) => r[0] >= -0.08).map(([y, w, f, b]) => ring(y, w * 1.07 + 0.003, y > 0.058 ? f * 1.07 + 0.003 : -0.012, b * 1.07 + 0.004));
  if (o.longHair) hairRows.unshift(ring(-0.17, 0.07, -0.02, 0.075), ring(-0.12, 0.078, -0.015, 0.085));
  hp.push(loftGrid(hairRows, { closed: true, capStart: true, capEnd: true, rgb: hair, uv: () => [0.5, 0.5] }));
  hp.push(prim(new THREE.SphereGeometry(1, 10, 8), { pos: P(0, -0.026, -0.094), scale: [0.013, 0.026, 0.022], rgb: mul(skin, 0.94) }));         // nose
  hp.push(prim(new THREE.SphereGeometry(1, 10, 6), { pos: P(0, -0.07, -0.084), scale: [0.021, 0.0055, 0.008], rgb: [0.42, 0.2, 0.17] }));        // mouth
  for (const s of [-1, 1]) {
    hp.push(prim(new THREE.SphereGeometry(0.027, 12, 8), { pos: P(s * 0.035, 0.008, -0.087), scale: [1, 0.78, 0.25], rgb: [0.012, 0.012, 0.016] }));        // lens
    hp.push(rod(P(s * 0.06, 0.012, -0.08), P(s * 0.082, 0.012, 0.0), 0.003, CHROME, 4));
    hp.push(prim(new THREE.SphereGeometry(0.047, 12, 10), { pos: P(s * 0.09, -0.012, 0.012), scale: [0.55, 1.12, 0.95], rgb: o.cups || [0.05, 0.11, 0.08] }));
    hp.push(prim(new THREE.TorusGeometry(0.036, 0.011, 6, 14), { pos: P(s * 0.08, -0.012, 0.012), rot: [0, Math.PI / 2, 0], scale: [1, 1.12, 0.95], rgb: RUBBER }));
  }
  hp.push(rod(P(-0.012, 0.012, -0.093), P(0.012, 0.012, -0.093), 0.003, CHROME, 4));
  hp.push(prim(new THREE.TorusGeometry(0.103, 0.011, 6, 18, Math.PI), { pos: P(0, 0.03, 0.014), scale: [0.9, 1, 1], rgb: RUBBER }));
  hp.push(rod(P(-0.096, -0.04, -0.005), P(-0.075, -0.078, -0.06), 0.004, DARK, 5), rod(P(-0.075, -0.078, -0.06), P(-0.03, -0.076, -0.098), 0.004, DARK, 5), prim(new THREE.SphereGeometry(0.012, 8, 6), { pos: P(-0.026, -0.076, -0.1), rgb: DARK }));
  const hg = merge(hp);
  if (tw) { hg.translate(-C[0], -C[1], -C[2]); hg.rotateY(tw); hg.translate(C[0], C[1], C[2]); }
  head.push(hg);
  return { body, head, C };
}

// ---------------------------------------------------------------- door card texture

/** One door card: stitched vinyl with a cloth panel, a scuffed kick strip, screws. Gray, tinted by the material. */
function doorTextures() {
  const W = 1024, H = 512, [c, g] = canvas(W, H, '#9a9a9a'), [hc, gh] = canvas(W, H, '#808080');
  let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  // cloth panel in the middle, carpeted kick strip along the bottom
  g.fillStyle = '#c4c4c4'; g.beginPath(); g.roundRect(70, 150, W - 140, 150, 26); g.fill();
  gh.fillStyle = '#8c8c8c'; gh.beginPath(); gh.roundRect(70, 150, W - 140, 150, 26); gh.fill();
  for (let x = 90; x < W - 80; x += 44) { gh.strokeStyle = '#5a5a5a'; gh.lineWidth = 5; gh.beginPath(); gh.moveTo(x, 154); gh.lineTo(x, 296); gh.stroke(); g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, 154); g.lineTo(x, 296); g.stroke(); }
  g.fillStyle = '#585858'; g.fillRect(0, 392, W, 120);
  for (let i = 0; i < 9000; i++) { const x = rnd() * W, y = 392 + rnd() * 120, v = 60 + rnd() * 80; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 2, 2); gh.fillStyle = `rgb(${v + 40},${v + 40},${v + 40})`; gh.fillRect(x, y, 2, 2); }
  // seams with stitching
  const seam = (draw) => { draw(gh); gh.strokeStyle = '#4c4c4c'; gh.lineWidth = 6; gh.setLineDash([]); gh.stroke(); draw(g); g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 4; g.setLineDash([]); g.stroke(); };
  const stitch = (draw) => { draw(g); g.strokeStyle = 'rgba(235,232,220,0.75)'; g.lineWidth = 2; g.setLineDash([7, 5]); g.stroke(); g.setLineDash([]); draw(gh); gh.strokeStyle = '#b4b4b4'; gh.lineWidth = 2.5; gh.setLineDash([7, 5]); gh.stroke(); gh.setLineDash([]); };
  seam((x) => { x.beginPath(); x.roundRect(70, 150, W - 140, 150, 26); });
  stitch((x) => { x.beginPath(); x.roundRect(60, 140, W - 120, 170, 32); }); stitch((x) => { x.beginPath(); x.roundRect(80, 160, W - 160, 130, 20); });
  seam((x) => { x.beginPath(); x.moveTo(0, 390); x.lineTo(W, 390); }); stitch((x) => { x.beginPath(); x.moveTo(0, 380); x.lineTo(W, 380); });
  seam((x) => { x.beginPath(); x.moveTo(0, 60); x.lineTo(W, 60); }); stitch((x) => { x.beginPath(); x.moveTo(0, 70); x.lineTo(W, 70); });
  // screws along the edges
  for (const [x, y] of [[24, 24], [W - 24, 24], [24, 360], [W - 24, 360], [W / 2, 24], [24, 200], [W - 24, 200], [W / 3, 500], [2 * W / 3, 500]]) {
    g.fillStyle = '#d8d8d8'; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill(); g.fillStyle = '#404040'; g.fillRect(x - 6, y - 1.2, 12, 2.4); g.fillRect(x - 1.2, y - 6, 2.4, 12);
    gh.fillStyle = '#c0c0c0'; gh.beginPath(); gh.arc(x, y, 8, 0, 7); gh.fill(); gh.fillStyle = '#606060'; gh.fillRect(x - 6, y - 1.2, 12, 2.4);
  }
  // shoe scuffs low down, hand grime around the handle end, general variation
  g.save(); g.filter = 'blur(1.5px)';
  for (let i = 0; i < 70; i++) { const x = rnd() * W, y = 300 + rnd() * 200, l = 20 + rnd() * 90, a = (rnd() - 0.5) * 0.9; g.strokeStyle = rnd() < 0.6 ? `rgba(225,222,210,${0.05 + rnd() * 0.16})` : `rgba(0,0,0,${0.05 + rnd() * 0.14})`; g.lineWidth = 1 + rnd() * 3; g.beginPath(); g.moveTo(x, y); g.lineTo(x + l * Math.cos(a), y + l * Math.sin(a)); g.stroke(); }
  g.restore();
  g.save(); g.filter = 'blur(26px)'; for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.07})`; g.beginPath(); g.ellipse(rnd() * W, rnd() * H, 40 + rnd() * 120, 20 + rnd() * 60, 0, 0, 7); g.fill(); } g.fillStyle = 'rgba(0,0,0,0.16)'; g.beginPath(); g.ellipse(260, 250, 110, 50, 0, 0, 7); g.fill(); g.restore();
  const mk = (cv, srgb) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; };
  return [mk(c, true), mk(normalFromHeight(hc, 2.4), false)];
}

let DOOR = null;
const doorTex = () => DOOR || (DOOR = doorTextures());

// ---------------------------------------------------------------- build

/**
 * Build the cabin of a variant into its groups. A: see buildAircraft (variant, look, sx, hullX, top, zW,
 * linerGeo, frameGeo, paintMask). Returns { parts } with what animateInterior moves.
 */
export function buildInterior(A, { cabin, body, pit }) {
  const sx = A.sx, L = panelLayout(A), look = A.look.interior, four = A.variant.seats > 2, pz = PANEL_Z, xP = L.xP;
  const SEAT = lin(look.seat), INSERT = lin(look.insert), TRIM = lin(look.trim), CARPET = lin(look.carpet), PIPE = mul(SEAT, 0.55);
  const zS = -0.24, zR = A.zW(0.735), zEnd = A.zW(2.05), wall = (z, y) => A.hullX(z, y) - 0.034;
  const bins = { cloth: [], vinyl: [], carpet: [], plastic: [], perf: [], plain: [], metal: [] }, boxes = [];
  const parts = { cab: { L } };

  // how open each part of the cabin is to the windows, before anything stands in the way
  const room = (x, y, z) => {
    let a = lerp(0.36, 1, sstep(-0.5, 0.15, y));
    if (z < pz + 0.1 && y < 0.31) a *= lerp(0.3, 1, sstep(pz - 0.22, pz + 0.1, z));          // the footwell under the panel
    if (y > 0.6) a *= 0.78;                                                                    // the headliner is lit from below
    return a * lerp(1, 0.8, sstep(0.3, 0.5, Math.abs(x)) * sstep(0.1, -0.3, y));               // low against the walls
  };

  // ---- floor
  { const zz = [-1.0, -0.7, -0.3, 0.1, lerp(0.1, zEnd, 0.5), four ? A.zW(1.2) : 0.12];
    bins.carpet.push(loftGrid(zz.map((z) => { const w = A.hullX(Math.min(z, 0.25), -0.5) - 0.02; return [[-w, -0.485, z], [w, -0.485, z]]; }), { out: [0, 1, 0], rgb: CARPET }));
    // baggage shelf, a step up behind the seats
    const z0 = four ? A.zW(1.2) : 0.1;
    bins.carpet.push(loftGrid([z0, lerp(z0, zEnd, 0.5), zEnd].map((z) => { const w = A.hullX(z, -0.3) - 0.03; return [[-w, -0.3, z], [w, -0.3, z]]; }), { out: [0, 1, 0], rgb: CARPET }));
    bins.carpet.push(loftGrid([-0.5, -0.3].map((y) => { const w = A.hullX(z0, y) - 0.03; return [[-w, y, z0], [w, y, z0]]; }), { out: [0, 0, -1], rgb: mul(CARPET, 0.8) }));
    boxes.push([0, -0.56, 0, 0.6, 0.06, 2]);
    // heel plates under the pedals, worn bright
    for (const x of [xP, -xP]) bins.metal.push(prim(new THREE.BoxGeometry(0.3, 0.003, 0.16), { pos: [x, -0.4835, -0.86], rgb: [0.5, 0.5, 0.5] })); }

  // ---- seats
  const seat = (x, z, w, low) => {
    bins.plain.push(prim(new THREE.BoxGeometry(w * 0.62, 0.11, 0.36), { pos: [x, -0.425, z - 0.02], rgb: DARK }));
    for (const s of [-1, 1]) bins.metal.push(rod([x + s * w * 0.34, -0.474, z - 0.34], [x + s * w * 0.34, -0.474, z + 0.3], 0.008, CHROME, 6));
    const c0 = [x, -0.325, z - 0.26], c1 = [x, -0.345, z + 0.22], b0 = [x, -0.3, z + 0.235], b1 = low ? [x, 0.25, z + 0.335] : [x, 0.34, z + 0.365];
    bins.vinyl.push(pad(c0, c1, w, w, 0.13, SEAT), pad(b0, b1, w, w * 0.88, 0.1, SEAT));
    const [ca, cp] = insert(c0, c1, w * 0.62, 0.13, INSERT, PIPE), [ba, bp] = insert(b0, b1, w * 0.58, 0.1, INSERT, PIPE);
    bins.cloth.push(ca, ba); bins.vinyl.push(cp, bp);
    if (!low) { bins.vinyl.push(pad([x, 0.345, z + 0.378], [x, 0.53, z + 0.405], w * 0.56, w * 0.5, 0.085, SEAT)); for (const s of [-1, 1]) bins.metal.push(rod([x + s * 0.06, 0.3, z + 0.368], [x + s * 0.06, 0.37, z + 0.382], 0.006, CHROME, 5)); }
    // recline lever and a seat-back pocket
    bins.plain.push(prim(new THREE.BoxGeometry(0.012, 0.02, 0.09), { pos: [x + Math.sign(x) * w * 0.47, -0.37, z + 0.02], rgb: [0.5, 0.05, 0.04] }));
    boxes.push([x, -0.35, z - 0.02, w / 2 - 0.04, 0.045, 0.2], [x, 0.0, z + 0.3, w / 2 - 0.04, 0.28, 0.035]);
  };
  const wSeat = 0.44 * sx;
  seat(xP, zS, wSeat, !four); seat(-xP, zS, wSeat, !four);
  if (four) {
    const w = 0.94 * sx;
    bins.plain.push(prim(new THREE.BoxGeometry(w * 0.66, 0.11, 0.4), { pos: [0, -0.425, zR], rgb: DARK }));
    const c0 = [0, -0.325, zR - 0.24], c1 = [0, -0.345, zR + 0.23], b0 = [0, -0.3, zR + 0.245], b1 = [0, 0.3, zR + 0.385];
    bins.vinyl.push(pad(c0, c1, w, w, 0.13, SEAT), pad(b0, b1, w, w * 0.92, 0.1, SEAT));
    for (const s of [-1, 1]) { const o = s * w * 0.235; const [ca, cp] = insert([o, c0[1], c0[2]], [o, c1[1], c1[2]], w * 0.36, 0.13, INSERT, PIPE, 4), [ba, bp] = insert([o, b0[1], b0[2]], [o, b1[1], b1[2]], w * 0.36, 0.1, INSERT, PIPE, 4); bins.cloth.push(ca, ba); bins.vinyl.push(cp, bp); }
    boxes.push([0, -0.35, zR, w / 2 - 0.04, 0.045, 0.2], [0, -0.02, zR + 0.31, w / 2 - 0.04, 0.26, 0.035]);
    // what is riding in the back: a flight bag and a folded chart
    bins.vinyl.push(pad([0.24 * sx, -0.19, zR - 0.12], [0.24 * sx, -0.19, zR + 0.16], 0.3, 0.3, 0.17, [0.03, 0.035, 0.05]));
    bins.plain.push(prim(new THREE.BoxGeometry(0.22, 0.008, 0.13), { pos: [-0.2 * sx, -0.262, zR - 0.02], rot: [0, 0.4, 0], rgb: [0.72, 0.74, 0.66] }), rod([0.24 * sx - 0.08, -0.1, zR - 0.02], [0.24 * sx + 0.08, -0.1, zR + 0.06], 0.012, [0.02, 0.02, 0.025], 6));
  } else {
    bins.vinyl.push(pad([0.12, -0.2, 0.3], [0.12, -0.2, 0.62], 0.36, 0.36, 0.19, [0.05, 0.045, 0.04]));
    bins.plain.push(prim(new THREE.BoxGeometry(0.22, 0.008, 0.13), { pos: [-0.2, -0.292, 0.32], rot: [0, 0.4, 0], rgb: [0.72, 0.74, 0.66] }));
  }

  // ---- doors: card, armrest, pocket, handle, window latch
  const doorMap = shared('door:map', () => doorTex()[0]), doorNormal = shared('door:normal', () => doorTex()[1]);
  const doorGeos = [];
  for (const s of [-1, 1]) {
    const z0 = -0.76, z1 = 0.25, y0 = -0.47, y1 = 0.132, xw = (z, y) => s * (wall(z, y) - 0.009);
    const rows = Array.from({ length: 13 }, (_, i) => Array.from({ length: 9 }, (_, j) => { const u = i / 12, v = j / 8, z = lerp(z0, z1, u), y = lerp(y0, y1, v); return [xw(z, y) - s * 0.006 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v), y, z, u, v]; }));
    doorGeos.push(loftGrid(rows, { out: [-s, 0, 0], uv: (p) => [s > 0 ? 1 - p[3] : p[3], p[4]], rgb: [1, 1, 1] }));
    // armrest with a pull cup behind it
    const ya = -0.005, xa = (z) => s * (wall(z, ya) - 0.045);
    bins.vinyl.push(pad([xa(-0.42), ya, -0.42], [xa(0.1), ya, 0.1], 0.052, 0.052, 0.085, mul(SEAT, 0.9), [0, 1, 0]));
    bins.plastic.push(prim(new THREE.BoxGeometry(0.05, 0.03, 0.4), { pos: [s * (wall(-0.16, ya) - 0.028), ya - 0.035, -0.16], rgb: mul(TRIM, 0.5) }));
    boxes.push([s * (wall(-0.16, ya) - 0.03), ya, -0.16, 0.035, 0.02, 0.24]);
    // inside handle in its recess
    const hz = -0.56, hy = -0.13, hx = xw(hz, hy);
    bins.plastic.push(prim(new THREE.BoxGeometry(0.014, 0.06, 0.15), { pos: [hx - s * 0.006, hy, hz], rgb: DARK }));
    bins.metal.push(rod([hx - s * 0.02, hy, hz - 0.05], [hx - s * 0.024, hy + 0.004, hz + 0.045], 0.008, CHROME, 6), rod([hx - s * 0.004, hy, hz - 0.05], [hx - s * 0.02, hy, hz - 0.05], 0.007, CHROME, 5));
    // map pocket with an elastic top, something in it on the pilot's side
    const pk = Array.from({ length: 9 }, (_, i) => Array.from({ length: 6 }, (_, j) => { const u = i / 8, v = j / 5, z = lerp(-0.62, -0.04, u), y = lerp(-0.445, -0.26, v), out = 0.012 + 0.03 * Math.pow(Math.sin(Math.PI * u), 0.5) * (0.35 + 0.65 * v); return [xw(z, y) - s * out, y, z]; }));
    bins.vinyl.push(loftGrid(pk, { out: [-s, 0, 0], rgb: mul(SEAT, 0.8) }));
    bins.plain.push(sweep(pk.map((r) => [r[5][0], r[5][1] + 0.004, r[5][2]]), ellipse(0.006, 0.006, 6), [0, 1, 0], { rgb: DARK }));
    if (s < 0) bins.plain.push(prim(new THREE.BoxGeometry(0.01, 0.14, 0.2), { pos: [xw(-0.3, -0.3) + 0.022, -0.25, -0.3], rot: [0.12, 0, 0], rgb: [0.74, 0.76, 0.68] }), prim(new THREE.BoxGeometry(0.012, 0.1, 0.13), { pos: [xw(-0.48, -0.3) + 0.03, -0.26, -0.48], rot: [-0.2, 0, 0], rgb: [0.1, 0.16, 0.3] }));
    // window latch on the sill
    const lz = -0.2, ly = 0.178, lx = xw(lz, ly);
    bins.plastic.push(prim(new THREE.BoxGeometry(0.016, 0.022, 0.07), { pos: [lx - s * 0.008, ly, lz], rgb: DARK }));
    bins.metal.push(rod([lx - s * 0.02, ly, lz - 0.02], [lx - s * 0.03, ly + 0.012, lz + 0.03], 0.0045, CHROME, 5));
    bins.plain.push(prim(new THREE.SphereGeometry(0.009, 8, 6), { pos: [lx - s * 0.031, ly + 0.013, lz + 0.034], rgb: DARK }));
    // overhead air vent at the wing root
    const vx = s * (wall(-0.36, 0.6) - 0.05);
    bins.plastic.push(prim(new THREE.CylinderGeometry(0.02, 0.024, 0.07, 14), { pos: [vx, 0.63, -0.37], rot: [1.0, 0, s * 0.3], rgb: DARK }));
    bins.metal.push(prim(new THREE.TorusGeometry(0.021, 0.004, 6, 14), { pos: [vx + s * 0.0, 0.612, -0.342], rot: [-0.57, 0, s * 0.3], rgb: CHROME }));
  }

  // ---- headliner, dome light, speaker, visors
  { const zz = [-0.44, -0.2, 0.2, A.zW(0.6), A.zW(0.9), A.zW(1.16)];
    bins.perf.push(loftGrid(zz.map((z) => { const w = A.hullX(z, 0.716) - 0.012; return [[-w, 0.716, z], [w, 0.716, z], [w, 0.702, z], [-w, 0.702, z]]; }), { closed: true, capStart: true, capEnd: true, rgb: mul(TRIM, 1.25) }));
    bins.plain.push(prim(new THREE.CylinderGeometry(0.045, 0.05, 0.012, 20), { pos: [0, 0.697, 0.12], rgb: [0.78, 0.76, 0.68] }), prim(new THREE.CylinderGeometry(0.07, 0.07, 0.004, 24), { pos: [0, 0.7, -0.12], rgb: DARK }));
    bins.plain.push(prim(new THREE.BoxGeometry(0.004, 0.003, zz[5] - zz[0] - 0.4), { pos: [0, 0.7005, (zz[5] + zz[0]) / 2 + 0.16], rgb: mul(TRIM, 0.6) }));
    for (const s of [-1, 1]) {
      const x = s * 0.25 * sx, a = [x, 0.682, -0.5], b = [x, 0.652, -0.385];
      bins.vinyl.push(pad(a, b, 0.3 * sx, 0.3 * sx, 0.016, mul(TRIM, 0.45)));
      bins.metal.push(rod([x - 0.16 * sx, 0.69, -0.505], [x + 0.14 * sx, 0.69, -0.505], 0.005, CHROME, 5), prim(new THREE.BoxGeometry(0.03, 0.006, 0.02), { pos: [x, 0.648, -0.4], rgb: CHROME }));
      bins.plain.push(prim(new THREE.BoxGeometry(0.09, 0.002, 0.05), { pos: [x, 0.6625, -0.445], rot: [0.255, 0, 0], rgb: [0.8, 0.79, 0.74] }));      // checklist card under the visor strap
    } }

  // ---- glareshield: grained vinyl with a rolled, padded lip; defrost outlets
  { const zz = [-0.99, -0.9, -0.78, pz, pz + 0.03, pz + 0.05];
    bins.vinyl.push(loftGrid(zz.map((z, i) => { const w = A.hullX(Math.min(z, pz), 0.33) - 0.04, y = i === 5 ? 0.318 : Math.max(0.335, Math.min(A.top(z) - 0.055, 0.345)), t = i === 5 ? 0.012 : 0.03; return [[-w, y, z], [w, y, z], [w, y - t, z], [-w, y - t, z]]; }), { closed: true, capStart: true, capEnd: true, rgb: [0.016, 0.016, 0.018] }));
    const w = A.hullX(pz, 0.33) - 0.045;
    bins.vinyl.push(sweep([[-w, 0.33, pz + 0.05], [w, 0.33, pz + 0.05]], ellipse(0.013, 0.017, 10), [0, 0, 1], { rgb: [0.02, 0.02, 0.022] }));
    for (const s of [-1, 1]) { bins.plain.push(prim(new THREE.BoxGeometry(0.2 * sx, 0.003, 0.03), { pos: [s * 0.22 * sx, 0.3465, -0.9], rgb: [0.004, 0.004, 0.004] })); for (let k = 0; k < 5; k++) bins.plain.push(prim(new THREE.BoxGeometry(0.2 * sx, 0.004, 0.0025), { pos: [s * 0.22 * sx, 0.348, -0.912 + k * 0.006], rgb: [0.03, 0.03, 0.032] })); }
    boxes.push([0, 0.34, -0.83, 0.6, 0.02, 0.19], [0, 0.08, pz - 0.03, 0.6, 0.24, 0.03]); }

  // ---- pedestal with the trim wheel; fuel selector on the floor
  { const px = (L.throttle[0] + L.mixture[0]) / 2 - 0.01;
    bins.plastic.push(prim(new THREE.BoxGeometry(0.16, 0.36, 0.15), { pos: [px, -0.33, pz + 0.045], rgb: mul(TRIM, 0.22) }));
    boxes.push([px, -0.33, pz + 0.045, 0.07, 0.17, 0.065]);
    const wx = px - 0.088, wy = -0.3, wz = pz + 0.07, wheel = [prim(new THREE.CylinderGeometry(0.068, 0.068, 0.02, 28), { pos: [wx, wy, wz], rot: [0, 0, Math.PI / 2], rgb: [0.03, 0.03, 0.032] })];
    for (let k = 0; k < 20; k++) { const a = (k / 20) * 2 * Math.PI; wheel.push(prim(new THREE.BoxGeometry(0.022, 0.009, 0.006), { pos: [wx, wy + Math.sin(a) * 0.069, wz + Math.cos(a) * 0.069], rot: [-a, 0, 0], rgb: [0.06, 0.06, 0.064] })); }
    bins.plain.push(...wheel, prim(new THREE.BoxGeometry(0.002, 0.11, 0.012), { pos: [px - 0.0805, -0.22, pz + 0.118], rgb: [0.8, 0.8, 0.76] }));
    bins.plain.push(prim(new THREE.CylinderGeometry(0.05, 0.055, 0.016, 20), { pos: [0.02, -0.477, -0.42], rgb: [0.1, 0.1, 0.105] }), prim(new THREE.BoxGeometry(0.022, 0.022, 0.1), { pos: [0.02, -0.462, -0.42], rgb: [0.55, 0.07, 0.05] })); }

  // ---- lining and window surrounds
  { const p = A.linerGeo.attributes.position, c = A.linerGeo.attributes.color, side = mul(SEAT, 0.75), pale = mul(TRIM, 1.05);
    for (let i = 0; i < p.count; i++) { const y = p.getY(i), a = sstep(-0.44, -0.36, y), b = sstep(0.14, 0.2, y); c.setXYZ(i, lerp(lerp(CARPET[0], side[0], a), pale[0], b), lerp(lerp(CARPET[1], side[1], a), pale[1], b), lerp(lerp(CARPET[2], side[2], a), pale[2], b)); } }
  const stipple = grain('plastic').normalMap.clone(); stipple.repeat.set(110, 44); stipple.needsUpdate = true;
  const matLiner = cabinMat({ alphaMap: A.paintMask, alphaTest: 0.5, normalMap: stipple, normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.82 });
  const mesh = (parent, geo, mat, cast = false) => { const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; parent.add(m); return m; };
  mesh(cabin, bakeAO(A.linerGeo, boxes, room), matLiner);
  mesh(cabin, flatAO(A.frameGeo, 0.72), cabinMat({ side: THREE.DoubleSide, roughness: 0.6 }));

  // ---- people
  const yokeGrip = [-0.157, 0.05, 0.288], knobHold = [0.004, 0.034, 0.185];
  const elbowL = [xP - 0.255, -0.005, zS + 0.0], elbowR = [xP + 0.25, -0.03, zS - 0.03];
  const pilot = person(xP, zS, { lean: 0.04, shirt: [0.46, 0.5, 0.56], trousers: [0.045, 0.05, 0.07], hair: [0.08, 0.06, 0.04], feet: 0.085, belt: -1, arms: { L: null, R: null }, elbows: { L: elbowL, R: elbowR } });
  const px2 = -xP, pax = person(px2, zS, {
    lean: 0.085, shirt: [0.42, 0.09, 0.08], trousers: [0.2, 0.19, 0.16], hair: [0.3, 0.17, 0.07], skin: [0.44, 0.27, 0.19], longHair: true, feet: 0.085, belt: 1, turn: 0.22, cups: [0.08, 0.08, 0.09],
    arms: { L: [[px2 - 0.215, -0.01, zS + 0.07], [px2 - 0.1, -0.075, zS - 0.17], [0.25, -0.25, -1], [0, -1, -0.25], 0.35], R: [[px2 + 0.22, -0.01, zS + 0.07], [px2 + 0.12, -0.07, zS - 0.19], [-0.2, -0.25, -1], [0, -1, -0.25], 0.3] },
  });
  bins.plain.push(...pilot.body, ...pax.body, ...pax.head);
  boxes.push([xP, 0.05, zS + 0.12, 0.13, 0.22, 0.07], [px2, 0.05, zS + 0.14, 0.13, 0.22, 0.07], [xP, -0.17, zS - 0.1, 0.15, 0.05, 0.2], [px2, -0.17, zS - 0.1, 0.15, 0.05, 0.2]);
  // the pilot's head is drawn only from outside (from the cockpit the camera is in it)
  mesh(body, flatAO(merge(pilot.head), 0.85), cabinMat({ roughness: 0.6 }), true);

  // ---- finish: one mesh per material, textured by box projection, contact shading baked in
  const mats = {
    cloth: grainMat('cloth', 0.07, { roughness: 0.96 }), vinyl: grainMat('vinyl', 0.06, { roughness: 0.5, bump: 0.7 }), carpet: grainMat('carpet', 0.1, { roughness: 1 }),
    plastic: grainMat('plastic', 0.05, { roughness: 0.62, bump: 0.5 }), perf: grainMat('perf', 0.06, { roughness: 0.85, bump: 0.8 }),
    plain: cabinMat({ roughness: 0.7 }), metal: cabinMat({ metalness: 0.9, roughness: 0.28, envMapIntensity: 0.9 }),
  };
  for (const k of Object.keys(bins)) {
    if (!bins[k].length) continue;
    const geo = merge(bins[k]);
    if (mats[k].userData.tile) boxUv(geo, mats[k].userData.tile);
    mesh(cabin, bakeAO(geo, boxes, room), mats[k], k !== 'metal' && k !== 'perf');
  }
  const matDoor = cabinMat({ map: doorMap, normalMap: doorNormal, normalScale: new THREE.Vector2(0.9, 0.9), color: new THREE.Color(...mul(SEAT, 1.5)), roughness: 0.55 });
  mesh(cabin, bakeAO(merge(doorGeos), boxes, room), matDoor);

  // ---- controls that move, and the hands on them
  const matCtl = cabinMat({ roughness: 0.55 });
  const yokeGeo = (withHand) => {
    const g = [rod([0, 0, -0.1], [0, 0, 0.2], 0.014, [0.6, 0.6, 0.62], 10), prim(new THREE.BoxGeometry(0.1, 0.055, 0.035), { pos: [0, 0, 0.215], rgb: DARK }), rod([-0.115, -0.005, 0.22], [0.115, -0.005, 0.22], 0.015, DARK, 8)];
    for (const s of [-1, 1]) g.push(rod([s * 0.115, -0.005, 0.22], [s * 0.135, 0.1, 0.235], 0.017, DARK, 10), prim(new THREE.SphereGeometry(0.02, 10, 8), { pos: [s * 0.136, 0.115, 0.237], rgb: DARK }));
    // chart clip on the hub, push-to-talk on the left horn, the maker's badge
    g.push(prim(new THREE.BoxGeometry(0.07, 0.045, 0.004), { pos: [0, 0.012, 0.236], rgb: [0.55, 0.56, 0.58] }), prim(new THREE.BoxGeometry(0.075, 0.01, 0.01), { pos: [0, 0.036, 0.238], rgb: CHROME }), prim(new THREE.BoxGeometry(0.062, 0.05, 0.002), { pos: [0, 0.01, 0.239], rot: [0, 0, 0.04], rgb: [0.82, 0.81, 0.74] }));
    g.push(prim(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 10), { pos: [-0.138, 0.1, 0.252], rot: [Math.PI / 2, 0, 0], rgb: [0.6, 0.05, 0.04] }));
    if (withHand) g.push(hand(true, yokeGrip, [0.12, 0.25, -1], [1, 0, 0.1], 0.86));
    return flatAO(merge(g), 0.8);
  };
  parts.yokes = [[xP, true], [-xP, false]].map(([x, h]) => { const m = mesh(cabin, yokeGeo(h), matCtl, true); m.position.set(x, L.yokeY, pz); return m; });
  const plunger = (rgb) => merge([rod([0, 0, -0.04], [0, 0, 0.1], 0.006, [0.6, 0.6, 0.6], 6), prim(new THREE.CylinderGeometry(0.019, 0.019, 0.026, 20), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.115], rgb }), prim(new THREE.SphereGeometry(0.019, 16, 8, 0, Math.PI * 2, 0, 1.3), { rot: [Math.PI / 2, 0, 0], pos: [0, 0, 0.126], scale: [1, 1, 0.5], rgb })]);
  parts.throttle = mesh(cabin, flatAO(merge([plunger([0.02, 0.02, 0.02]), hand(false, knobHold, [-0.05, -0.3, -1], [0, -1, 0.3], 0.62)]), 0.8), matCtl);
  parts.throttle.position.set(L.throttle[0], L.throttle[1], pz);
  // rudder pedals: left pair and right pair move opposite ways
  const pedal = (xs) => merge(xs.map((x) => merge([
    prim(new THREE.BoxGeometry(0.082, 0.115, 0.01), { pos: [x, -0.385, -0.955], rot: [-0.45, 0, 0], rgb: [0.2, 0.2, 0.21] }),
    ...[-1, 0, 1].map((k) => prim(new THREE.BoxGeometry(0.07, 0.008, 0.008), { pos: [x, -0.385 + k * 0.032, -0.948 + k * 0.0155], rot: [-0.45, 0, 0], rgb: [0.42, 0.42, 0.43] })),
    rod([x - 0.04, -0.333, -0.98], [x + 0.04, -0.333, -0.98], 0.008, [0.3, 0.3, 0.3], 6), rod([x, -0.43, -0.955], [x, -0.5, -0.99], 0.009, [0.3, 0.3, 0.3], 5),
  ])));
  parts.pedals = [pedal([xP - 0.085, -xP - 0.085]), pedal([xP + 0.085, -xP + 0.085])].map((geo) => mesh(cabin, flatAO(geo, 0.35), cabinMat({ metalness: 0.5, roughness: 0.45 })));
  // forearms follow the hands
  const fa = forearmGeo(SKIN);
  parts.arms = [{ m: mesh(cabin, flatAO(fa, 0.85), matCtl, true), elbow: V(elbowL), grip: V(yokeGrip) }, { m: mesh(cabin, flatAO(fa.clone(), 0.85), matCtl, true), elbow: V(elbowR), grip: V(knobHold) }];
  return { parts };
}

const Zp = new THREE.Vector3(0, 0, 1), w3 = new THREE.Vector3();
/** Move the controls and the pilot's arms with the flight state. */
export function animateInterior(parts, ac, dt, time, n) {
  const [yL, yR] = parts.yokes, roll = -ac.ail * 1.0;
  for (const y of parts.yokes) { y.position.z = PANEL_Z + 0.02 + 0.05 * ac.elev; y.rotation.z = roll; }
  parts.throttle.position.z = PANEL_Z - 0.05 + 0.065 * (1 - ac.throttle);
  parts.pedals[0].position.z = 0.035 * ac.rud; parts.pedals[1].position.z = -0.035 * ac.rud;
  // left arm to the yoke horn, right arm to the throttle
  const [aL, aR] = parts.arms, c = Math.cos(roll), s = Math.sin(roll);
  w3.set(aL.grip.x * c - aL.grip.y * s, aL.grip.x * s + aL.grip.y * c, aL.grip.z).add(yL.position);
  aim(aL, w3);
  aim(aR, w3.copy(aR.grip).add(parts.throttle.position));
}
function aim(arm, wrist) {
  const d = wrist.sub(arm.elbow), len = d.length();
  arm.m.position.copy(arm.elbow); arm.m.quaternion.setFromUnitVectors(Zp, d.multiplyScalar(1 / len)); arm.m.scale.set(1, 1, len);
}
