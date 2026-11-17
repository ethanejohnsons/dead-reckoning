// Launch pads, as procedural models: buildPad('saturnv') is a Launch Complex 39 pad with the Mobile
// Launcher and its red umbilical tower on it; buildPad('starship') is an orbital launch mount beside its
// tower and tank farm.
//
//   { root, standY, towerTop, lights, update(dt, s), dispose() }
//
// The origin is ground level under the vehicle's centerline, +Y up, -Z north; the vehicle goes at
// (0, standY, 0) and both towers stand north of it. Everything rests on an octagonal concrete apron whose
// walls go 60 m down, so the pad can sit on a slope without showing daylight underneath.
//
// Lattice structures are real members (model-kit's Beams: four quads a beam, merged into one mesh per
// finish), not textured cards, so they light, shadow and parallax properly: the umbilical tower is about
// 1,500 members. Concrete wears one tiling canvas mapped in world meters. update(dt, s) takes
// s = { t: seconds since liftoff, night: 0..1 }: the swing arms (and Starship's quick-disconnect arm) let
// go and swing clear as t passes 0, the lamps glow and the floodlights come up with night.
//
// The floodlights are real SpotLights (no shadows) so the vehicle is lit at night; they stay in the scene
// at zero intensity by day so no shader is recompiled at dusk. buildPad(kind, { lights: false }) leaves
// them out.

import * as THREE from 'three';
import { TAU, D2R, polar, revolve, facets, box, cyl, ball, atAz, Beams, meshOf, rng, disposeTree, canvas, tex, lin, lerp, sstep, rod } from './model-kit.js';

/** Floodlighting: illuminance on the vehicle at full night relative to a sun of intensity 1, and the HDR radiance of a lamp's face. */
export const PAD_TUNING = { floodlight: 0.55, lamp: 14 };

const CONCRETE = lin('#b4b0a6'), DARK_CONCRETE = lin('#77746e'), BRICK = lin('#5b4a40'), GRAVEL = lin('#b4a98f'), ASPHALT = lin('#3b3c3e');
const ML_GRAY = lin('#878b90'), LUT_RED = lin('#a8321e'), STEEL = lin('#5e6166'), DARK = lin('#232427'), WHITE = lin('#e9e9e6'), BLACKISH = lin('#2a2b2e');

// ---------------------------------------------------------------- shared pieces

function concreteTexture() {
  const N = 512, [C, g] = canvas(N, N, '#ffffff'), rnd = rng(5);
  for (let i = 0; i < 2600; i++) { const v = rnd() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${0.012 + rnd() * 0.02})`; g.fillRect(rnd() * N, rnd() * N, 2 + rnd() * 26, 2 + rnd() * 26); }
  for (let i = 0; i < 26; i++) {                     // stains
    const x = rnd() * N, y = rnd() * N, r = 20 + rnd() * 70, gd = g.createRadialGradient(x, y, 0, x, y, r);
    gd.addColorStop(0, 'rgba(40,36,30,0.06)'); gd.addColorStop(1, 'rgba(40,36,30,0)'); g.fillStyle = gd; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.strokeStyle = 'rgba(40,40,40,0.3)'; g.lineWidth = 1.2;
  for (let k = 0; k <= 4; k++) { g.beginPath(); g.moveTo(k * 128, 0); g.lineTo(k * 128, N); g.moveTo(0, k * 128); g.lineTo(N, k * 128); g.stroke(); }
  const t = tex(C, true, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}
const UV_SCALE = 24;          // meters a tile of the concrete canvas covers

/** A flat polygon facing `hint`, mapped in world meters. */
function face(pts, hint, rgb) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
  const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0, ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const uv = ay >= ax && ay >= az ? (p) => [p[0] / UV_SCALE, p[2] / UV_SCALE] : ax > az ? (p) => [p[2] / UV_SCALE, p[1] / UV_SCALE] : (p) => [p[0] / UV_SCALE, p[1] / UV_SCALE];
  return facets([flip ? pts.slice().reverse() : pts], rgb, { uv });
}
/** A convex polygon [[x, z], ...] extruded from y0 to y1, optionally spreading to `base` at the bottom. */
function prism(top, y0, y1, rgb, o = {}) {
  const base = o.base || top, out = [], n = top.length, cx = top.reduce((s, p) => s + p[0], 0) / n, cz = top.reduce((s, p) => s + p[1], 0) / n;
  if (!o.noTop) out.push(face(top.map(([x, z]) => [x, y1, z]), [0, 1, 0], o.topRgb || rgb));
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = top[i], b = top[j], c = base[j], d = base[i];
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
    out.push(face([[a[0], y1, a[1]], [b[0], y1, b[1]], [c[0], y0, c[1]], [d[0], y0, d[1]]], [mx, 0.2, mz], (o.sideRgb && o.sideRgb(i)) || rgb));
  }
  return out;
}
/** An axis-aligned block mapped in world meters. */
function block(x0, x1, y0, y1, z0, z1, rgb, o) { return prism([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], y0, y1, rgb, o); }
const octagon = (rx, rz, cut) => [[rx - cut, -rz], [rx, -rz + cut], [rx, rz - cut], [rx - cut, rz], [-rx + cut, rz], [-rx, rz - cut], [-rx, -rz + cut], [-rx + cut, -rz]];

/** The apron everything stands on: an octagon at height y with walls 60 m down. */
function apron(r, y, rgb = CONCRETE) { return prism(octagon(r, r, r * 0.4), -60, y, rgb, { sideRgb: () => DARK_CONCRETE }); }

/** A lattice floodlight mast with a bank of lamps aimed at the origin. Returns { beams, lamps } geometry lists. */
function floodMast(x, z, y0, h, bm, lamps, struct) {
  const s = 1.6, C = STEEL;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) bm.add([x + dx * s, y0, z + dz * s], [x + dx * s * 0.4, y0 + h, z + dz * s * 0.4], 0.16, C);
  const n = Math.round(h / 4);
  for (let k = 0; k < n; k++) {
    const f0 = k / n, f1 = (k + 1) / n, w0 = s * lerp(1, 0.4, f0), w1 = s * lerp(1, 0.4, f1), ya = y0 + h * f0, yb = y0 + h * f1;
    const c0 = [[-w0, -w0], [w0, -w0], [w0, w0], [-w0, w0]], c1 = [[-w1, -w1], [w1, -w1], [w1, w1], [-w1, w1]];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; bm.add([x + c0[i][0], ya, z + c0[i][1]], [x + c1[j][0], yb, z + c1[j][1]], 0.07, C); bm.add([x + c1[i][0], yb, z + c1[i][1]], [x + c1[j][0], yb, z + c1[j][1]], 0.07, C); }
  }
  const a = Math.atan2(z, -x), yT = y0 + h + 1.2;                   // azimuth from the mast toward the origin
  struct.push(atAzAt(box(0.5, 2.6, 5.2, [0, 0, 0], DARK), a, [x, yT, z]));
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) lamps.push(atAzAt(box(0.12, 0.95, 0.95, [0.3, -0.62 + r * 1.24, -1.86 + c * 1.24], [1, 1, 1]), a, [x, yT, z]));
}
function atAzAt(g, a, pos) { g.rotateY(a); g.translate(pos[0], pos[1], pos[2]); return g; }

function materials() {
  return {
    concrete: new THREE.MeshStandardMaterial({ map: concreteTexture(), vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.5 }),
    struct: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.15, envMapIntensity: 0.6 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.4, emissive: new THREE.Color(1, 0.96, 0.86), emissiveIntensity: 0 }),
  };
}
function spot(root, from, to, angle) {
  const l = new THREE.SpotLight(0xfff4e0, 0, 0, angle, 0.6, 2);
  l.position.set(...from); l.target.position.set(...to); l.userData.reach2 = new THREE.Vector3(...from).distanceToSquared(new THREE.Vector3(...to));
  root.add(l, l.target);
  return l;
}
function finish(root, M, lights, extra) {
  return {
    root, lights, ...extra,
    update(dt, s = {}) {
      const night = Math.max(0, Math.min(1, s.night || 0));
      M.lamp.emissiveIntensity = PAD_TUNING.lamp * (0.04 + 0.96 * night);
      for (const l of lights) l.intensity = night * PAD_TUNING.floodlight * l.userData.reach2;
      if (extra.animate) extra.animate(s.t ?? -1e9, dt);
    },
    dispose() { disposeTree(root); for (const l of lights) l.dispose(); },
  };
}

// ---------------------------------------------------------------- Launch Complex 39

const LC39 = { padH: 12.2, trench: 9, pedestal: 6.7, mlH: 7.6, towerZ: -24.4, towerHalf: 6.1, towerH: 116 };
const DECK = LC39.padH + LC39.pedestal + LC39.mlH;                   // top of the Mobile Launcher: 26.5 m
const STAND_39 = DECK - 0.6;                                         // the F-1 bells end just below deck level, over the exhaust hole

/** A swing arm built along +X from its hinge: box truss, walkway, umbilical carrier at the tip. */
function swingArm(L, whiteRoom) {
  const bm = new Beams(), parts = [], w = 2.4, h = 2.7, n = Math.max(2, Math.round((L - 2.2) / 2.8)), bay = (L - 2.2) / n;
  for (const z of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) bm.add([0, y, z], [L - 2.2, y, z], 0.26, LUT_RED);
  for (let k = 0; k <= n; k++) {
    const x = k * bay;
    for (const z of [-w / 2, w / 2]) { bm.add([x, -h / 2, z], [x, h / 2, z], 0.16, LUT_RED); if (k < n) bm.add([x, (k & 1 ? 1 : -1) * h / 2, z], [x + bay, (k & 1 ? -1 : 1) * h / 2, z], 0.13, LUT_RED); }
    for (const y of [-h / 2, h / 2]) { bm.add([x, y, -w / 2], [x, y, w / 2], 0.16, LUT_RED); if (k < n) bm.add([x, y, (k & 1 ? 1 : -1) * w / 2], [x + bay, y, (k & 1 ? -1 : 1) * w / 2], 0.11, LUT_RED); }
  }
  bm.add([0, -h / 2 - 0.4, 0], [0, h / 2 + 0.4, 0], 0.55, DARK, 0.55, true);                    // hinge pin
  parts.push(bm.build(), box(L - 2.2, 0.08, w - 0.5, [(L - 2.2) / 2, -h / 2 + 0.25, 0], STEEL));
  if (whiteRoom) parts.push(box(4.0, 3.3, 3.6, [L - 2.0, 0.1, 0], WHITE), box(0.5, 2.2, 1.4, [L + 0.15, -0.3, 0], DARK));
  else {
    parts.push(box(2.0, h + 0.3, w + 0.4, [L - 1.2, 0, 0], lin('#9a9da1')), box(0.35, 1.6, 1.8, [L - 0.05, 0, 0], DARK));
    for (const z of [-0.7, 0, 0.7]) parts.push(rod([L - 2.4, -h / 2, z], [L - 6, -h / 2 - 0.9, z * 1.3], 0.09, DARK, 6));
  }
  return parts;
}

function buildLC39(M, opts) {
  const root = new THREE.Group(); root.name = 'Launch Complex 39';
  const con = [], st = [], lamps = [], bm = new Beams(), H = LC39.padH, T = LC39.trench, G = 0.6;
  // ---- ground: apron, the raised hardstand in two halves either side of the flame trench, the crawler ramp
  con.push(...apron(175, G));
  const top = [[T, -62], [44, -62], [62, -44], [62, 44], [44, 62], [T, 62]], base = [[T, -86], [56, -86], [86, -56], [86, 56], [56, 86], [T, 86]];
  for (const sx of [1, -1]) {
    const m = (p) => [p[0] * sx, p[1]], tp = top.map(m), bp = base.map(m);
    con.push(...prism(sx > 0 ? tp : tp.slice().reverse(), G, H, CONCRETE, { base: sx > 0 ? bp : bp.slice().reverse(), sideRgb: (i) => (i === 5 ? BRICK : DARK_CONCRETE) }));
    // crawler track: gravel across the hardstand and down the ramp to the south
    con.push(face([[sx * (T + 2), H + 0.03, -40], [sx * (T + 16), H + 0.03, -40], [sx * (T + 16), H + 0.03, 62], [sx * (T + 2), H + 0.03, 62]], [0, 1, 0], GRAVEL));
    const x0 = sx * (T + 1), x1 = sx * (T + 19), z1 = 62 + (H - G) / 0.1;
    con.push(face([[x0, H, 62], [x1, H, 62], [x1, G, z1], [x0, G, z1]], [0, 1, 0.05], GRAVEL));
    con.push(face([[x0, H, 62], [x0, G, z1], [x0, G, 62]], [-sx, 0, 0], DARK_CONCRETE), face([[x1, H, 62], [x1, G, z1], [x1, G, 62]], [sx, 0, 0], DARK_CONCRETE));
    // scorch along the trench lip
    con.push(face([[sx * T, H + 0.04, -30], [sx * (T + 1.6), H + 0.04, -30], [sx * (T + 1.6), H + 0.04, 30], [sx * T, H + 0.04, 30]], [0, 1, 0], DARK_CONCRETE));
  }
  // trench floor and the flame deflector: a wedge that turns the exhaust north and south
  con.push(face([[-T, G + 0.05, -150], [T, G + 0.05, -150], [T, G + 0.05, 150], [-T, G + 0.05, 150]], [0, 1, 0], BRICK));
  const dz = 14, ridge = H - 0.6;
  for (const s of [1, -1]) st.push(face([[-T + 0.4, ridge, 0], [T - 0.4, ridge, 0], [T - 0.4, G, s * dz], [-T + 0.4, G, s * dz]], [0, 1, s], DARK));
  for (const sx of [1, -1]) st.push(face([[sx * (T - 0.4), ridge, 0], [sx * (T - 0.4), G, dz], [sx * (T - 0.4), G, -dz]], [sx, 0, 0], DARK));

  // ---- Mobile Launcher: a two-story steel box on six pedestals, with the 13.7 m exhaust hole under the vehicle
  const y0 = H + LC39.pedestal, hx = 20.5, zN = -33, zS = 16, e = 6.85;
  for (const x of [-17, 17]) for (const z of [-30, -9, 13]) st.push(...block(x - 1.6, x + 1.6, H, y0, z - 1.6, z + 1.6, STEEL));
  const panel = (i) => (i % 2 ? ML_GRAY : lin('#7d8186'));
  st.push(...block(-hx, hx, y0, DECK, zN, -e, ML_GRAY, { sideRgb: panel }), ...block(-hx, hx, y0, DECK, e, zS, ML_GRAY, { sideRgb: panel }));
  st.push(...block(-hx, -e, y0, DECK, -e, e, ML_GRAY), ...block(e, hx, y0, DECK, -e, e, ML_GRAY));
  // belt lines and doors down the sides, deck railing
  for (const y of [y0 + 2.5, y0 + 5.0]) for (const [a, b] of [[[-hx, zN], [hx, zN]], [[hx, zN], [hx, zS]], [[hx, zS], [-hx, zS]], [[-hx, zS], [-hx, zN]]]) bm.add([a[0], y, a[1]], [b[0], y, b[1]], 0.14, DARK, 0.22);
  for (let x = -hx; x <= hx + 0.1; x += 4.1) for (const z of [zN, zS]) bm.add([x, y0, z], [x, DECK, z], 0.1, DARK, 0.16);
  for (let z = zN; z <= zS + 0.1; z += 4.083) for (const x of [-hx, hx]) bm.add([x, y0, z], [x, DECK, z], 0.16, DARK, 0.1);
  const rail = [[-hx, zN], [hx, zN], [hx, zS], [-hx, zS]];
  rail.forEach((a, i) => { const b = rail[(i + 1) % 4]; for (const dy of [0.55, 1.1]) bm.add([a[0], DECK + dy, a[1]], [b[0], DECK + dy, b[1]], 0.05, STEEL); });
  // hold-down arms between the engines, tail service masts leaning in beside them
  for (const d of [0, 90, 180, 270]) {
    const g1 = facets(wedge(7.9, 5.25, 3.7, 1.5), lin('#70747a'));
    st.push(atAz(g1, d * D2R).translate(0, DECK, 0));
  }
  for (const d of [22, 158, 270 + 22]) {
    const p = (r, y) => polar(r, d * D2R, DECK + y);
    bm.add(p(13.5, 0), p(9.2, 6.4), 1.3, lin('#8f9296'), 1.6, true); bm.add(p(11.2, 0), p(9.0, 5.0), 0.5, STEEL); bm.add(p(9.3, 6.2), p(6.2, 6.0), 0.5, DARK, 0.7, true);
  }
  for (const [x, z] of [[14, 10], [-14, 10], [15, -12], [-15, -12]]) st.push(box(3.2, 2.2, 2.4, [x, DECK + 1.1, z], lin('#94979b')));

  // ---- Launch Umbilical Tower: 18 levels of red steel, 116 m above the deck
  const tz = LC39.towerZ, th = LC39.towerHalf, levels = [0, 9.1, 18.3];
  while (levels[levels.length - 1] < LC39.towerH - 0.1) levels.push(Math.min(LC39.towerH, levels[levels.length - 1] + 6.1));
  const corner = [[-th, tz - th], [th, tz - th], [th, tz + th], [-th, tz + th]];
  for (const [x, z] of corner) bm.add([x, DECK, z], [x, DECK + LC39.towerH, z], 0.85, LUT_RED);
  for (let k = 0; k < levels.length - 1; k++) {
    const ya = DECK + levels[k], yb = DECK + levels[k + 1];
    for (let i = 0; i < 4; i++) {
      const a = corner[i], b = corner[(i + 1) % 4], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      bm.add([a[0], yb, a[1]], [b[0], yb, b[1]], 0.5, LUT_RED, 0.6);
      bm.add([a[0], ya, a[1]], [mx, yb, mz], 0.3, LUT_RED); bm.add([b[0], ya, b[1]], [mx, yb, mz], 0.3, LUT_RED);       // K bracing
      for (const dy of [0.55, 1.1]) bm.add([a[0], yb + dy, a[1]], [b[0], yb + dy, b[1]], 0.05, STEEL);
      lamps.push(box(0.3, 0.3, 0.3, [lerp(a[0], b[0], 0.3), yb - 0.5, lerp(a[1], b[1], 0.3)], [1, 1, 1]), box(0.3, 0.3, 0.3, [lerp(a[0], b[0], 0.7), yb - 0.5, lerp(a[1], b[1], 0.7)], [1, 1, 1]));
    }
    st.push(box(th * 2 - 0.3, 0.14, th * 2 - 0.3, [0, yb + 0.05, tz], lin('#55585c')));
    // floor beams and stairs
    bm.add([-th, yb - 0.25, tz], [th, yb - 0.25, tz], 0.3, LUT_RED, 0.5); bm.add([0, yb - 0.25, tz - th], [0, yb - 0.25, tz + th], 0.3, LUT_RED, 0.5);
    bm.add([th - 1.2, ya + 0.2, tz - th + 1], [th - 1.2, yb, tz - th + 5], 1.0, STEEL, 0.12);
  }
  // elevator shafts and the pipe runs up the back
  st.push(box(3.6, LC39.towerH, 3.2, [-1.2, DECK + LC39.towerH / 2, tz - 1.2], lin('#8c8f93')));
  for (const x of [-4.6, -3.9, 3.3, 4.2]) bm.add([x, DECK, tz - th + 0.6], [x, DECK + LC39.towerH - 3, tz - th + 0.6], 0.32, lin('#c9cbcd'));
  // hammerhead crane and lightning mast
  const yC = DECK + LC39.towerH, ca = 28 * D2R, cdir = (r, y, s = 0) => [Math.cos(ca) * r - Math.sin(ca) * s, yC + y, tz - Math.sin(ca) * r - Math.cos(ca) * s];
  st.push(cyl(2.4, 2.0, 4.2, [0, yC + 2.1, tz], LUT_RED, 16));
  for (const s of [-1.3, 1.3]) for (const y of [4.4, 7.2]) bm.add(cdir(-10, y, s), cdir(y > 5 ? 21 : 23, y > 5 ? y - 1.2 : y, s), 0.3, LUT_RED);
  for (let r = -10; r < 21; r += 2.9) for (const s of [-1.3, 1.3]) {
    const yt = lerp(7.2, 6.05, Math.max(0, r) / 21), yt1 = lerp(7.2, 6.05, Math.max(0, r + 2.9) / 21);
    bm.add(cdir(r, 4.4, s), cdir(r, yt, s), 0.16, LUT_RED); bm.add(cdir(r, 4.4, s), cdir(r + 2.9, yt1, s), 0.14, LUT_RED);
    if (s > 0) { bm.add(cdir(r, 4.4, -1.3), cdir(r, 4.4, 1.3), 0.14, LUT_RED); bm.add(cdir(r, yt, -1.3), cdir(r, yt, 1.3), 0.14, LUT_RED); }
  }
  st.push(atAzAt(box(5.5, 3.0, 3.4, [0, 0, 0], lin('#8d3a2a')), ca, cdir(-6.5, 6.0)), atAzAt(box(2.4, 1.6, 3.0, [0, 0, 0], DARK), ca, cdir(-10.4, 3.9)));
  bm.add(cdir(17, 4.4), cdir(17, -9), 0.08, DARK); st.push(box(0.9, 1.4, 0.9, cdir(17, -9.6), DARK));
  bm.add([0, yC + 4.2, tz], [0, yC + 13.5, tz], 0.4, LUT_RED); bm.add([0, yC + 13.5, tz], [0, yC + 21, tz], 0.14, lin('#c8c8c8'));
  lamps.push(box(0.5, 0.5, 0.5, [0, yC + 13.6, tz], [1, 1, 1]));

  // ---- surroundings: floodlight masts, water tower, propellant spheres
  const masts = [[-118, 70], [118, 70], [-128, -30], [128, -30], [0, 150]];
  for (const [x, z] of masts) floodMast(x, z, G, 31, bm, lamps, st);
  // water tower to the northeast
  { const x = 120, z = -120, h = 72;
    for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU, b = ((k + 1) / 6) * TAU; bm.add([x + Math.cos(a) * 9, G, z + Math.sin(a) * 9], [x + Math.cos(a) * 5, G + h, z + Math.sin(a) * 5], 0.7, WHITE);
      for (let j = 0; j < 4; j++) { const f0 = j / 4, f1 = (j + 1) / 4, r0 = lerp(9, 5, f0), r1 = lerp(9, 5, f1); bm.add([x + Math.cos(a) * r0, G + h * f0, z + Math.sin(a) * r0], [x + Math.cos(b) * r1, G + h * f1, z + Math.sin(b) * r1], 0.22, WHITE); bm.add([x + Math.cos(a) * r1, G + h * f1, z + Math.sin(a) * r1], [x + Math.cos(b) * r1, G + h * f1, z + Math.sin(b) * r1], 0.22, WHITE); } }
    st.push(revolve([[0.8, G + h - 14], [1.2, G + h - 2], [6.5, G + h], [9.5, G + h + 4], [9.5, G + h + 8], [6, G + h + 11.5], [0, G + h + 12.5]], { seg: 28, rgb: WHITE, crease: 50 }).translate(x, 0, z));
    st.push(cyl(1.0, 1.0, h - 12, [x, G + (h - 12) / 2, z], WHITE, 12));
  }
  // liquid oxygen sphere to the northwest, liquid hydrogen sphere to the northeast
  for (const [x, z, r] of [[-125, -105, 11], [70, -150, 10.5]]) {
    st.push(ball(r, [x, G + r + 3, z], WHITE, 28));
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; bm.add([x + Math.cos(a) * r * 0.95, G, z + Math.sin(a) * r * 0.95], [x + Math.cos(a) * r * 0.95, G + r + 3, z + Math.sin(a) * r * 0.95], 0.5, lin('#c4c6c8')); }
    bm.add([x, G + 1.2, z], [x * 0.2, G + 1.2, z * 0.42], 0.5, lin('#c9cbcd'));
  }
  st.push(bm.build());
  root.add(meshOf(con, M.concrete, false, true), meshOf(st, M.struct), meshOf(lamps, M.lamp, false, false));

  // ---- nine swing arms, hinged on the tower's southeast corner
  const R1 = 5.03, armsAt = [[26, R1], [39.8, R1], [48.6, R1], [56.5, R1], [65, R1], [73.8, 3.3], [83.3, 3.3], [95.8, 1.96], [99.6, 1.45]];
  const arms = armsAt.map(([vy, rv], i) => {
    const hinge = new THREE.Vector3(th - 0.4, STAND_39 + vy, tz + th + 0.3), tip = new THREE.Vector3(i === 8 ? 1.0 : 0.5, hinge.y, -(rv + 0.45));
    const d = tip.clone().sub(hinge), L = d.length(), a0 = Math.atan2(-d.z, d.x);
    const g = new THREE.Group(); g.position.copy(hinge); g.rotation.y = a0;
    g.add(meshOf(swingArm(L, i === 8), M.struct));
    root.add(g);
    return { g, a0, delay: i === 8 ? -300 : 0.15 + 0.22 * ((i * 5) % 8), dur: i === 8 ? 12 : 4.5 + (i % 3) * 0.7, sweep: (118 + (i % 2) * 14) * D2R };
  });
  const lights = [];
  if (opts.lights !== false) for (const [x, z] of [[-118, 70], [118, 70], [0, 150]]) lights.push(spot(root, [x, G + 33, z], [0, STAND_39 + 55, 0], 0.42));
  return finish(root, M, lights, {
    standY: STAND_39, towerTop: DECK + LC39.towerH + 21, deckY: DECK, arms,
    animate(t) { for (const a of arms) a.g.rotation.y = a.a0 + a.sweep * sstep(0, 1, (t - a.delay) / a.dur); },
  });
}

/** A hold-down arm as flat faces: a sloped block from radius r0 out to r1, h tall, half-width w, standing on y = 0 at azimuth 0. */
function wedge(r1, r0, h, w) {
  const a = [r0, 0, -w], b = [r1, 0, -w], c = [r1, 0, w], d = [r0, 0, w], e = [r0, h, -w * 0.7], f = [r0 + 1.3, h, -w * 0.7], g = [r0 + 1.3, h, w * 0.7], k = [r0, h, w * 0.7];
  return [[e, k, g, f], [a, e, f, b], [d, c, g, k], [b, f, g, c], [a, d, k, e]];
}

// ---------------------------------------------------------------- Starship launch site

const SB = { mountTop: 20.6, legR: 9.6, towerZ: -22.5, towerHalf: 6, towerH: 139, rodH: 146.5 };
const STAND_SB = SB.mountTop - 1.1;                                  // the booster's skirt sits on the clamps

function buildStarbase(M, opts) {
  const root = new THREE.Group(); root.name = 'Starship launch site';
  const con = [], st = [], lamps = [], bm = new Beams(), G = 0.5, MT = SB.mountTop, PLATE = lin('#34363a'), TOWER = lin('#26282b'), MOUNT = lin('#4b4e53');
  con.push(...apron(165, G));
  // ---- water-deluge plate under the mount, scorched concrete round it
  st.push(revolve([[13.5, G], [12.5, G + 0.5], [0, G + 0.5]], { seg: 24, rgb: PLATE, crease: 20 }));
  for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; bm.add(polar(2.5, a, G + 0.52), polar(12.3, a, G + 0.52), 0.12, DARK, 0.06); }
  con.push(revolve([[24, G + 0.03], [13.5, G + 0.03]], { seg: 32, rgb: lin('#85827c'), uv: () => [0.3, 0.3] }));
  // ---- orbital launch mount: six legs, a ring table with the booster's seat cut through it
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + Math.PI / 6;
    st.push(atAz(cyl(1.25, 1.25, MT - 3.2 - G, [SB.legR, (MT - 3.2 + G) / 2, 0], MOUNT, 16), a));
    st.push(atAz(box(3.4, 1.0, 3.4, [SB.legR, G + 0.5, 0], lin('#7c7a75')), a));
    bm.add(polar(SB.legR, a, MT - 9), polar(SB.legR, a + TAU / 6, MT - 9), 0.6, MOUNT);                      // ring brace between legs
    bm.add(polar(SB.legR, a, G + 5), polar(SB.legR * 0.9, a + TAU / 12, MT - 3.4), 0.45, MOUNT);
  }
  st.push(revolve([[4.75, MT - 3.4], [11.2, MT - 3.4], [11.6, MT - 3.0], [11.6, MT - 0.2], [11.2, MT], [4.75, MT], [4.75, MT - 3.4]], { seg: 36, rgb: MOUNT, crease: 25 }));
  for (let k = 0; k < 36; k++) { const a = (k / 36) * TAU; bm.add(polar(11.64, a, MT - 3.0), polar(11.64, a, MT - 0.2), 0.14, DARK, 0.1); }
  for (let k = 0; k < 20; k++) st.push(atAz(box(0.9, 0.7, 0.7, [5.15, MT + 0.3, 0], lin('#8a8d91')), ((k + 0.5) / 20) * TAU));        // hold-down clamps
  st.push(atAz(box(3.2, 3.0, 4.4, [8.3, MT + 1.5, 0], lin('#3c3e42')), 90 * D2R));                                                    // booster quick-disconnect hood
  for (const a of [200, 250, 290, 340]) st.push(atAz(box(2.2, 1.6, 2.6, [9.6, MT + 0.8, 0], lin('#56595e')), a * D2R));
  for (let k = 0; k < 36; k++) { const a = (k / 36) * TAU; bm.add(polar(11.5, a, MT + 1.1), polar(11.5, a + TAU / 36, MT + 1.1), 0.06, STEEL); bm.add(polar(11.5, a, MT), polar(11.5, a, MT + 1.1), 0.06, STEEL); }
  // ---- launch tower: four heavy columns, X-braced in nine modules, the vehicle face left open for the carriage rails
  const tz = SB.towerZ, th = SB.towerHalf, H = SB.towerH, corner = [[-th, tz - th], [th, tz - th], [th, tz + th], [-th, tz + th]];
  for (const [x, z] of corner) bm.add([x, G, z], [x, G + H, z], 1.7, TOWER);
  const nMod = 9, mh = H / nMod;
  for (let k = 0; k < nMod; k++) {
    const ya = G + k * mh, yb = ya + mh;
    for (let i = 0; i < 4; i++) {
      const a = corner[i], b = corner[(i + 1) % 4], south = i === 2;
      bm.add([a[0], yb, a[1]], [b[0], yb, b[1]], 0.8, TOWER, 1.0);
      if (!south) { bm.add([a[0], ya, a[1]], [b[0], yb, b[1]], 0.6, TOWER); bm.add([b[0], ya, b[1]], [a[0], yb, a[1]], 0.6, TOWER); }
      for (const f of [0.25, 0.75]) lamps.push(box(0.35, 0.35, 0.35, [lerp(a[0], b[0], f), yb - 0.9, lerp(a[1], b[1], f)], [1, 1, 1]));
    }
    st.push(box(th * 2 - 1.8, 0.2, th * 2 - 1.8, [0, yb - 0.5, tz], lin('#303236')));
  }
  for (const x of [-2.6, 2.6]) bm.add([x, G + 8, tz + th + 0.5], [x, G + H - 2, tz + th + 0.5], 0.5, lin('#4a4c50'), 0.7);            // carriage rails
  st.push(box(4, H - 4, 3.4, [1.5, G + H / 2, tz - 1.6], lin('#2e3033')));                                                              // elevator and services core
  st.push(box(th * 2 + 2.4, 0.5, th * 2 + 2.4, [0, G + H + 0.25, tz], TOWER), box(5, 3.2, 5, [0, G + H + 2.1, tz], lin('#3a3c40')));
  bm.add([th - 1, G + H + 0.5, tz - th + 1], [th - 1, G + SB.rodH, tz - th + 1], 0.3, lin('#9a9c9f'));
  lamps.push(box(0.6, 0.6, 0.6, [th - 1, G + H + 4, tz - th + 1], [1, 1, 1]));
  // ---- chopsticks: a carriage on the vehicle face and two long arms held open round the ship
  const yCar = STAND_SB + 86, armL = 36, open = 27 * D2R;
  st.push(box(th * 2 + 2.2, 8.5, 2.6, [0, yCar, tz + th + 1.6], lin('#2f3134')));
  for (const sx of [1, -1]) {
    const hx = sx * (th + 0.9), hz = tz + th + 2.4, dx = Math.sin(open) * sx, dzz = Math.cos(open), at = (d, y, off = 0) => [hx + dx * d + dzz * off * sx, yCar + y, hz + dzz * d - dx * off * sx];
    bm.add(at(0, 0.6), at(armL, 0.2), 2.0, lin('#2b2d30'), 3.0, true);                       // box girder
    bm.add(at(0, -3.4), at(armL * 0.6, -1.4), 0.8, TOWER); bm.add(at(0, -3.4), at(0, 0.6), 0.9, TOWER);
    bm.add(at(6, 2.0, -1.25), at(armL - 0.5, 1.85, -1.25), 0.5, lin('#55585d'), 0.4);        // landing rail on the inner edge
    for (let d = 3; d < armL; d += 5.5) bm.add(at(d, -0.9, 1.02), at(d, 1.6, 1.02), 0.12, lin('#44474b'), 0.5);
    st.push(atAzAt(cyl(1.3, 1.3, 6.5, [0, 0, 0], lin('#3a3c40'), 14), 0, [hx, yCar - 0.6, hz]));
  }
  // ---- tank farm to the west: vertical tanks in two rows, a few horizontal ones, a berm wall
  for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) {
    const x = -78 - r * 13, z = -30 + k * 13.5, h = r ? 26 : 30;
    st.push(revolve([[4.5, G + 0.4], [4.5, G + h], [3.6, G + h + 1.6], [1.5, G + h + 2.5], [0, G + h + 2.7]], { seg: 28, rgb: WHITE }).translate(x, 0, z));
    for (const y of [9.5, 18.6]) st.push(revolve([[4.5, G + y - 0.06], [4.56, G + y - 0.05], [4.56, G + y + 0.05], [4.5, G + y + 0.06]], { seg: 28, rgb: lin('#c9cac8') }).translate(x, 0, z));
    bm.add([x + 4.7, G + 0.5, z], [x + 4.7, G + h, z], 0.3, lin('#c8cacc'));
  }
  for (let k = 0; k < 5; k++) { const z = -34 + k * 6.5; st.push(cyl(2, 2, 20, [-56, G + 3.2, z], WHITE, 18, [0, 0, Math.PI / 2]), ball(2, [-66, G + 3.2, z], WHITE, 16), ball(2, [-46, G + 3.2, z], WHITE, 16)); for (const x of [-62, -50]) st.push(box(0.6, 1.4, 3.6, [x, G + 0.7, z], DARK_CONCRETE)); }
  con.push(...block(-104, -40, G, G + 3.2, -44, -42.6, DARK_CONCRETE), ...block(-104, -40, G, G + 3.2, 30, 31.4, DARK_CONCRETE), ...block(-41.4, -40, G, G + 3.2, -44, 31.4, DARK_CONCRETE));
  bm.add([-40, G + 1.6, -6], [-14, G + 1.6, -6], 1.2, lin('#b9bbbd'), 0.8); bm.add([-14, G + 1.6, -6], [-9, G + 1.6, -3], 1.2, lin('#b9bbbd'), 0.8);       // pipe rack to the mount
  // ---- floodlight masts
  const masts = [[95, 70], [-95, 80], [100, -60], [0, 130]];
  for (const [x, z] of masts) floodMast(x, z, G, 34, bm, lamps, st);
  st.push(bm.build());
  root.add(meshOf(con, M.concrete, false, true), meshOf(st, M.struct), meshOf(lamps, M.lamp, false, false));

  // ---- ship quick-disconnect arm: swings back against the tower as the stack lifts off
  const qd = new THREE.Group(), yQ = STAND_SB + 73.4, hinge = [th - 0.6, yQ, tz + th + 0.4], tipZ = -4.75;
  const L = Math.hypot(hinge[0] - 0, hinge[2] - tipZ), a0 = Math.atan2(-(tipZ - hinge[2]), 0 - hinge[0]), qb = new Beams(), w = 3, h = 3.4, n = 4, bay = (L - 2.6) / n;
  for (const z of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) qb.add([0, y, z], [L - 2.6, y, z], 0.4, TOWER);
  for (let k = 0; k <= n; k++) {
    const x = k * bay;
    for (const z of [-w / 2, w / 2]) { qb.add([x, -h / 2, z], [x, h / 2, z], 0.25, TOWER); if (k < n) qb.add([x, (k & 1 ? 1 : -1) * h / 2, z], [x + bay, (k & 1 ? -1 : 1) * h / 2, z], 0.2, TOWER); }
    for (const y of [-h / 2, h / 2]) qb.add([x, y, -w / 2], [x, y, w / 2], 0.25, TOWER);
  }
  qd.add(meshOf([qb.build(), box(2.8, h + 0.6, w + 0.6, [L - 1.5, 0, 0], lin('#3a3c40')), box(0.4, 2.2, 2.4, [L - 0.05, -0.2, 0], lin('#7d8084')), box(L - 2.6, 0.12, w - 0.6, [(L - 2.6) / 2, -h / 2 + 0.3, 0], STEEL)], M.struct));
  qd.position.set(...hinge); qd.rotation.y = a0; root.add(qd);
  const lights = [];
  if (opts.lights !== false) for (const [x, z] of [[95, 70], [-95, 80], [0, 130]]) lights.push(spot(root, [x, G + 36, z], [0, STAND_SB + 60, 0], 0.5));
  return finish(root, M, lights, {
    standY: STAND_SB, towerTop: G + SB.rodH, deckY: MT, chopsticksY: yCar,
    animate(t) { qd.rotation.y = a0 + 62 * D2R * sstep(-2.5, 0.5, t); },
  });
}

export function buildPad(kind, opts = {}) {
  const M = materials();
  if (kind === 'saturnv') return buildLC39(M, opts);
  if (kind === 'starship') return buildStarbase(M, opts);
  throw new Error(`unknown pad "${kind}"`);
}
