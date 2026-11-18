// Launch pads, as procedural models: buildPad('saturnv') is a Launch Complex 39 pad with the Mobile
// Launcher and its red umbilical tower on it; buildPad('starship') is an orbital launch mount beside its
// light gray lattice tower, the tower's two dark arms, a tank farm and the worked ground of the site.
//
//   { root, standY, towerTop, lights, update(dt, s), dispose() }
//
// The origin is ground level under the vehicle's centerline, +Y up, -Z north; the vehicle goes at
// (0, standY, 0) and both towers stand north of it. Launch Complex 39 rests on an octagonal concrete apron
// whose walls go 60 m down, so the pad can sit on a slope without showing daylight underneath; the Starship
// site's ground (siteGround) is flat as far out, then banks down into the land.
//
// Lattice structures are real members (model-kit's Beams: four quads a beam, merged into one mesh per
// finish), not textured cards, so they light, shadow and parallax properly: the umbilical tower is about
// 1,500 members. Concrete wears one tiling canvas mapped in world meters. update(dt, s) takes
// s = { t: seconds since liftoff, night: 0..1, arms }: the swing arms (and Starship's quick-disconnect arm) let
// go and swing clear as t passes 0, the lamps glow and the floodlights come up with night. Starship's tower
// has its two "chopstick" arms on hinges: s.arms sets them (0 shut under a vehicle's catch pins, 1 open as
// for launch, 1.4 wide open for one coming back); `catchY` is the height of their rails.
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
      if (extra.animate) extra.animate(s.t ?? -1e9, dt, s);
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

/** Smooth value noise over the plane, 0..1: n(x, z, cell) has features `cell` meters across. */
function valueNoise(seed) {
  const N = 64, rnd = rng(seed), t = new Float32Array(N * N).map(() => rnd());
  const at = (i, j) => t[(((i % N) + N) % N) + (((j % N) + N) % N) * N];
  return (x, z, cell) => {
    const fx = x / cell, fz = z / cell, ix = Math.floor(fx), iz = Math.floor(fz), ux = fx - ix, uz = fz - iz, sx = ux * ux * (3 - 2 * ux), sz = uz * uz * (3 - 2 * uz);
    return lerp(lerp(at(ix, iz), at(ix + 1, iz), sx), lerp(at(ix, iz + 1), at(ix + 1, iz + 1), sx), sz);
  };
}
/** A plain tiling grain for bare ground: gravel, sand, asphalt (their color is on the corners). */
function earthTexture() {
  const N = 256, [C, g] = canvas(N, N, '#f2f2f2'), rnd = rng(11);
  for (let i = 0; i < 6000; i++) { const v = rnd() < 0.55 ? 0 : 255, sz = 1 + rnd() * 4; g.fillStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.06})`; g.fillRect(rnd() * N, rnd() * N, sz, sz); }
  const t = tex(C, true, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}
const EARTH_SCALE = 14;        // meters a tile of the grain covers

/**
 * The ground of the Starship site, seen mostly from the air. It is flat at height G out to an octagon 165 m from the mount
 * (the launch smoke and dust count on hard ground that far), then falls away as a bank of sand until the land takes over.
 * A grid of 6 m cells, each one concrete hardstand, asphalt or bare ground, gives pads and roads their hard edges on the
 * joints of the concrete; the bare ground goes from compacted gravel round the works to sand at no edge in particular, so
 * the octagon itself never shows. Mottling, the scorch round the mount and the wear of traffic are colors on the corners.
 * Returns [geometry for the concrete canvas, geometry for the plain grain].
 */
function siteGround(G) {
  const S = 6, HALF = 234, n1 = valueNoise(31), n2 = valueNoise(47);
  const out = (x, z) => Math.max(Math.abs(x) - 165, Math.abs(z) - 165, (Math.abs(x) + Math.abs(z) - 264) / Math.SQRT2);          // meters outside the octagon
  // (the bank begins up to 34 m beyond the octagon, here sooner and there later, so its foot is no octagon; the last cells go straight down, as the old apron's walls did)
  const yAt = (x, z) => { const d = out(x, z); if (d <= 0) return G; const y = G - Math.max(0, Math.min(d, 56) - 34 * n1(x, z, 90)) / 7; return d < 56 ? y : y - (d - 56) * 8; };
  const PADS = [[-54, 78, -60, 66], [-114, -36, -54, 42], [78, 120, -24, 30], [-30, 54, 66, 108], [36, 96, -96, -60], [-12, 12, -96, -60]];       // hardstands: [x0, x1, z0, z1]
  const ROADS = [[-234, 234, 138, 150], [-6, 6, 108, 138], [54, 102, 108, 138], [-234, -114, -6, 6], [96, 108, -60, -24]];                         // asphalt: the road past the site and the ways in
  const inAny = (L, x, z) => L.some(([x0, x1, z0, z1]) => x > x0 && x < x1 && z > z0 && z < z1);
  const hash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  const GRAVEL_A = lin('#cbc7bb'), GRAVEL_B = lin('#a9a59a'), SAND_A = lin('#beb9a0'), SAND_B = lin('#9fa28a'), ROAD = lin('#656565');
  const scorch = (x, z) => { const r = Math.hypot(x, z); return r > 90 ? 0 : (1 - sstep(15, 90, r)) * (0.45 + 0.55 * n1(x, z, 13)); };
  const bufs = [0, 1].map(() => ({ p: [], n: [], u: [], c: [] }));
  for (let i = -HALF; i < HALF; i += S) for (let j = -HALF; j < HALF; j += S) {
    const cx = i + S / 2, cz = j + S / 2;
    if (out(cx, cz) > 66) continue;
    const kind = inAny(PADS, cx, cz) ? 0 : inAny(ROADS, cx, cz) ? 1 : 2, b = bufs[kind ? 1 : 0], sc = kind ? EARTH_SCALE : UV_SCALE;
    const slab = 0.88 + 0.2 * hash(Math.floor(cx / 12), Math.floor(cz / 12)) + (hash(i, j) < 0.06 ? -0.12 : 0);                    // concrete: each pour its own tone, a patched one here and there
    for (const [x, z] of [[i, j], [i, j + S], [i + S, j + S], [i, j], [i + S, j + S], [i + S, j]]) {
      const e = 1, gx = (yAt(x + e, z) - yAt(x - e, z)) / (2 * e), gz = (yAt(x, z + e) - yAt(x, z - e)) / (2 * e), l = Math.hypot(gx, 1, gz);
      let k = (0.82 + 0.34 * n2(x, z, 34)) * (0.9 + 0.2 * n1(x, z, 11)) * (1 - 0.6 * scorch(x, z)), col;
      if (kind === 0) { col = CONCRETE; k *= slab * (0.93 + 0.14 * n1(x, z, 9)); }
      else if (kind === 1) { col = ROAD; k = 0.9 + 0.2 * n2(x, z, 20); }
      else {
        // worked ground: gravel where the site is busy, darker where wheels go, giving way to sand toward the edge
        const w = sstep(-6, 22, -out(x, z) - 14 - 50 * (n1(x, z, 64) - 0.4)), g = n1(x * 0.35, z * 2.2, 22), sn = sstep(0.3, 0.7, n2(x, z, 46));
        col = [0, 1, 2].map((q) => lerp(lerp(SAND_A[q], SAND_B[q], sn), lerp(GRAVEL_A[q], GRAVEL_B[q], g), w));
      }
      b.p.push(x, yAt(x, z), z); b.n.push(-gx / l, 1 / l, -gz / l); b.u.push(x / sc, z / sc); b.c.push(col[0] * k, col[1] * k, col[2] * k);
    }
  }
  return bufs.map((b) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
    return g;
  });
}

const SB = { mountTop: 20.6, legR: 9.6, towerZ: -22.5, towerHalf: 6, towerH: 139, rodH: 146.5 };
const STAND_SB = SB.mountTop - 1.1;                                  // the booster's skirt sits on the clamps

function buildStarbase(M, opts) {
  const root = new THREE.Group(); root.name = 'Starship launch site';
  const con = [], st = [], lamps = [], bm = new Beams({ outward: true }), G = 0.5, MT = SB.mountTop, PLATE = lin('#34363a'), MOUNT = lin('#4b4e53');
  const TOWER = lin('#adb0b3'), CLADDING = lin('#8f9397'), STAIR = lin('#7c8084'), CARRIAGE = lin('#2b2d30'), ARM = lin('#2f3134'), QD = lin('#56595d');
  const [hard, soft] = siteGround(G);
  con.push(hard);
  // ---- water-deluge plate under the mount (the scorched concrete round it is siteGround's)
  st.push(revolve([[13.5, G], [12.5, G + 0.5], [0, G + 0.5]], { seg: 24, rgb: PLATE, crease: 20 }));
  for (let k = 0; k < 24; k++) { const a = (k / 24) * TAU; bm.add(polar(2.5, a, G + 0.52), polar(12.3, a, G + 0.52), 0.12, DARK, 0.06); }
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
  // ---- launch tower: four square columns of light gray steel, X-braced on every face in nine modules, the top of the
  // last one clad, a railed deck over it. (Light against the sky and heavy enough in its members that it still reads as
  // a lattice, not a stick, from two kilometers away.)
  const tz = SB.towerZ, th = SB.towerHalf, H = SB.towerH, corner = [[-th, tz - th], [th, tz - th], [th, tz + th], [-th, tz + th]];
  const nMod = 9, mh = H / nMod, CLAD = 9.5, yClad = G + H - CLAD;
  con.push(...block(-th - 2.5, th + 2.5, G, G + 1.3, tz - th - 2.5, tz + th + 2.5, CONCRETE));                                 // its footing
  for (const [x, z] of corner) bm.add([x, G, z], [x, G + H, z], 1.9, TOWER);
  for (let k = 0; k < nMod; k++) {
    const ya = G + k * mh, yb = ya + mh, yx = k === nMod - 1 ? yClad : yb;
    for (let i = 0; i < 4; i++) {
      const a = corner[i], b = corner[(i + 1) % 4], ns = i % 2 === 0;
      bm.add([a[0], yb, a[1]], [b[0], yb, b[1]], 1.0, TOWER, 1.2);
      bm.add([a[0], ya, a[1]], [b[0], yx, b[1]], 0.85, TOWER); bm.add([b[0], ya, b[1]], [a[0], yx, a[1]], 0.85, TOWER);
      st.push(box(ns ? 1.8 : 0.5, 1.8, ns ? 0.5 : 1.8, [(a[0] + b[0]) / 2, (ya + yx) / 2, (a[1] + b[1]) / 2], TOWER));           // the gusset where the braces cross
      for (const f of [0.25, 0.75]) lamps.push(box(0.35, 0.35, 0.35, [lerp(a[0], b[0], f), yb - 0.9, lerp(a[1], b[1], f)], [1, 1, 1]));
    }
    st.push(box(th * 2 - 1.8, 0.2, th * 2 - 1.8, [0, yb - 0.5, tz], lin('#63666a')));                                            // floor grating
    // stairs up the inside of the west face, two flights a module
    bm.add([-th + 1.6, ya + 0.3, tz - 3.6], [-th + 1.6, ya + mh / 2, tz + 3.6], 1.1, STAIR, 0.16); bm.add([-th + 2.9, ya + mh / 2, tz + 3.6], [-th + 2.9, yb - 0.4, tz - 3.6], 1.1, STAIR, 0.16);
  }
  // the clad section under the deck: ribbed sheet between the columns, a frame under it
  for (let i = 0; i < 4; i++) {
    const a = corner[i], b = corner[(i + 1) % 4], ns = i % 2 === 0, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    bm.add([a[0], yClad, a[1]], [b[0], yClad, b[1]], 1.0, TOWER, 1.0);
    st.push(box(ns ? th * 2 - 1.9 : 0.3, CLAD - 1.0, ns ? 0.3 : th * 2 - 1.9, [mx, yClad + CLAD / 2 - 0.1, mz], CLADDING));
    const out = ns ? [0, Math.sign(mz - tz) * 0.2] : [Math.sign(mx) * 0.2, 0];
    for (let f = 0.1; f < 0.95; f += 0.1) { const x = lerp(a[0], b[0], f) + out[0], z = lerp(a[1], b[1], f) + out[1]; bm.add([x, yClad + 0.5, z], [x, G + H - 0.6, z], 0.16, TOWER); }
  }
  for (const x of [-th, th]) bm.add([x, G + 6, tz + th + 0.98], [x, yClad, tz + th + 0.98], 0.55, lin('#585b5f'), 0.1);       // the rails the carriage rides, on the vehicle face of the two near columns
  st.push(box(3.2, H - 4, 3.2, [2.2, G + H / 2, tz - 2.2], lin('#8a8e92')));                                                      // elevator and services core
  for (const x of [-0.6, 0.1, 0.8]) bm.add([x, G + 1, tz - th + 1.3], [x, yClad, tz - th + 1.3], 0.42, lin('#c7c9cb'));         // propellant and water risers up the back
  // the deck: a railed plate, the winch house and the sheaves the carriage hangs from, the lightning rod on its corner
  const yD = G + H + 0.5, dh = th + 1.6;
  st.push(box(dh * 2, 0.5, dh * 2, [0, G + H + 0.25, tz], lin('#7b7f83')), box(5, 3.2, 5, [0, yD + 1.6, tz - 1.2], lin('#8d9195')));
  [[-dh, -dh], [dh, -dh], [dh, dh], [-dh, dh]].forEach(([x0, z0], i, a) => {
    const [x1, z1] = a[(i + 1) % 4];
    for (const dy of [0.6, 1.15]) bm.add([x0, yD + dy, tz + z0], [x1, yD + dy, tz + z1], 0.09, TOWER);
    for (let f = 0; f < 1; f += 0.125) bm.add([lerp(x0, x1, f), yD, tz + lerp(z0, z1, f)], [lerp(x0, x1, f), yD + 1.15, tz + lerp(z0, z1, f)], 0.09, TOWER);
  });
  for (const x of [-2.2, 2.2]) { bm.add([x, yD, tz + 2.2], [x, yD + 3.4, tz + th + 1.3], 0.5, TOWER); bm.add([x, yD, tz + th + 0.4], [x, yD + 3.4, tz + th + 1.3], 0.4, TOWER); }
  bm.add([-2.6, yD + 3.4, tz + th + 1.3], [2.6, yD + 3.4, tz + th + 1.3], 0.7, lin('#55585c'));
  bm.add([th - 1, G + H + 0.5, tz - th + 1], [th - 1, G + SB.rodH, tz - th + 1], 0.3, lin('#9a9c9f'));
  lamps.push(box(0.6, 0.6, 0.6, [th - 1, G + H + 4, tz - th + 1], [1, 1, 1]));
  // ---- chopsticks: a dark carriage round three sides of the tower, hung from the sheaves, and two long arms on hinges at
  // its near corners. Each arm is a deep truss of its own, three chords and their webs, that swings about its hinge:
  // held open round the ship for launch, opened wide for a vehicle coming back, closed under its catch pins.
  const yCar = STAND_SB + 86, armL = 36, OPEN = 27 * D2R, SHUT = -4.3 * D2R, hz = tz + th + 2.4, hx = th + 0.9;
  const cT = yCar + 2.3, cB = yCar - 7.3, zf = tz + th + 1.4, xs = th + 1.5, zb = tz - th - 0.6;        // the carriage: its top and bottom, its near frame, its side frames, how far back they run
  for (const y of [cT, cB]) {
    bm.add([-xs, y, zf], [xs, y, zf], 0.8, CARRIAGE, 1.0);
    for (const sx of [1, -1]) { bm.add([sx * xs, y, zf], [sx * xs, y, zb], 0.8, CARRIAGE, 1.0); st.push(box(2.8, 0.5, 2.6, [sx * hx, y, hz - 0.35], CARRIAGE)); }       // (and the lug each hinge turns in)
    for (const sx of [1, -1]) for (const z of [tz - th, tz + th]) st.push(box(0.7, 1.7, 2.3, [sx * (th + 1.25), y + (y === cT ? -0.5 : 0.5), z], lin('#4d5054')));     // the skates on the columns
  }
  for (const x of [-xs, -2.6, 2.6, xs]) bm.add([x, cB, zf], [x, cT, zf], 0.7, CARRIAGE);
  bm.add([-2.6, cB, zf], [2.6, cT, zf], 0.5, CARRIAGE); bm.add([2.6, cB, zf], [-2.6, cT, zf], 0.5, CARRIAGE);
  for (const sx of [1, -1]) {
    bm.add([sx * 2.6, cT, zf], [sx * xs, cB, zf], 0.5, CARRIAGE);
    for (const z of [zb, (zf + zb) / 2]) bm.add([sx * xs, cB, z], [sx * xs, cT, z], 0.7, CARRIAGE);
    bm.add([sx * xs, cB, zf], [sx * xs, cT, (zf + zb) / 2], 0.5, CARRIAGE); bm.add([sx * xs, cT, (zf + zb) / 2], [sx * xs, cB, zb], 0.5, CARRIAGE);
    bm.add([sx * 2.2, cT, zf - 0.1], [sx * 2.2, yD + 3.4, tz + th + 1.3], 0.16, DARK);                                           // the cables it hangs from
  }
  const chop = [1, -1].map((sx) => {
    // Built straight out from the hinge along +Z; `off` is toward the outside of the pair. Two top chords and one bottom
    // chord, deep at the root and rising to the tip, with a frame at every panel point and diagonals between; nothing
    // near the vehicle stands higher than the rail (the Ship's forward flaps are just above it).
    const ab = new Beams({ outward: true }), at = (d, y, off = 0) => [off * sx, y, d];
    const yT = 1.45, ti = -0.75, to = 1.05, tb = 0.15, low = (d) => (d < 13 ? lerp(-6.3, -5.0, d / 13) : lerp(-5.0, -0.25, (d - 13) / (armL - 13)));
    ab.add(at(0.4, yT, ti), at(armL, yT, ti), 0.7, ARM, 0.8, true); ab.add(at(0.4, yT, to), at(armL - 1.4, yT, to), 0.7, ARM, 0.8, true);
    ab.add(at(0.4, low(0.4), tb), at(13, low(13), tb), 0.8, ARM); ab.add(at(13, low(13), tb), at(armL - 0.4, low(armL - 0.4), tb), 0.8, ARM, 0.8, true);
    const P = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => 0.9 + i * 4.2125);
    P.forEach((d, i) => {
      for (const o of [ti, to]) ab.add(at(d, yT, o), at(d, low(d), tb), 0.42, ARM);
      ab.add(at(d, yT, ti), at(d, yT, to), 0.4, ARM, 0.5);
      if (i === P.length - 1) return;
      const e = P[i + 1], up = i & 1;
      for (const o of [ti, to]) ab.add(at(d, up ? low(d) : yT, up ? tb : o), at(e, up ? yT : low(e), up ? o : tb), 0.36, ARM);
      ab.add(at(d, yT, up ? ti : to), at(e, yT, up ? to : ti), 0.3, ARM);
    });
    ab.add(at(P[8], yT, to), at(armL, yT, ti), 0.6, ARM, 0.7);                               // the tip closes to a point
    // The landing rail on the inner edge: what a vehicle's pins come down on. (Narrow, so that closed under the pins it
    // lies just clear of a 9 m hull.)
    ab.add(at(6, 2.0, -1.15), at(armL - 0.5, 1.85, -1.15), 0.3, lin('#74787d'), 0.4, true);
    const g = new THREE.Group(); g.add(meshOf([ab.build(), cyl(0.95, 0.95, 9.0, [0, -2.45, 0], lin('#3a3c40'), 16)], M.struct));           // (the barrel of the hinge turns with the arm)
    g.position.set(sx * hx, yCar, hz); g.rotation.y = sx * OPEN; root.add(g);
    return { g, sx };
  });
  let armNow = 1;                                                                            // 0 shut on the pins, 1 open as for launch, up to 1.4 wide open

  // ---- tank farm to the west: two rows of tall tanks, each built up of rings as the vehicles are (some left bare steel, most
  // painted and weathered), with a vent, a railed top, a ladder and a fill line; a battery of horizontal tanks on saddles;
  // pump skids; a berm wall round it all; a vent stack. Plant, not white cylinders.
  const PIPE = lin('#c3c5c7'), PAINT = lin('#d6d5cf');
  const tank = (x, z, h, r, rgb) => {
    const q = rng(Math.round(x * 7 + z * 13) + 5), at = (g) => g.translate(x, 0, z);
    for (let y = 0.5; y < h - 0.01; y += 1.83) { const k = 0.88 + q() * 0.18; st.push(at(revolve([[r, G + y], [r, G + Math.min(h, y + 1.83)]], { seg: 20, rgb: rgb.map((c) => c * k) }))); }
    st.push(at(revolve([[r, G + h], [r * 0.8, G + h + r * 0.36], [r * 0.34, G + h + r * 0.56], [0, G + h + r * 0.6]], { seg: 20, rgb: rgb.map((c) => c * 0.94) })));
    st.push(at(revolve([[r + 0.3, G], [r + 0.3, G + 0.5], [r, G + 0.5]], { seg: 20, rgb: DARK_CONCRETE, crease: 20 })));
    bm.add([x, G + h + r * 0.55, z], [x, G + h + r * 0.6 + 2.4, z], 0.35, STEEL);                                    // vent
    for (let i = 0; i < 10; i++) {
      const p = (k, y) => [x + Math.cos((k / 10) * TAU) * (r - 0.25), G + h + y, z + Math.sin((k / 10) * TAU) * (r - 0.25)];
      bm.add(p(i, 1.1), p(i + 1, 1.1), 0.09, STEEL); bm.add(p(i, 0), p(i, 1.1), 0.09, STEEL);
    }
    bm.add([x + r + 0.3, G + 0.5, z], [x + r + 0.3, G + h + 1.0, z], 0.12, DARK, 0.7);                               // ladder cage
    bm.add([x, G + 0.5, z + r + 0.3], [x, G + h * 0.82, z + r + 0.3], 0.38, PIPE);                                   // fill line
  };
  for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) tank(-78 - r * 13, -30 + k * 13.5, r ? 26 : 30, 4.5, (k + r) % 3 === 0 ? lin('#8b9095') : (k + r) % 3 === 1 ? PAINT : lin('#c2c2bc'));
  for (let k = 0; k < 5; k++) {
    const z = -34 + k * 6.5, c = k === 3 ? lin('#a9adb0') : PAINT;
    st.push(cyl(2, 2, 20, [-56, G + 3.2, z], c, 18, [0, 0, Math.PI / 2]), ball(2, [-66, G + 3.2, z], c, 16), ball(2, [-46, G + 3.2, z], c, 16));
    for (const x of [-62, -50]) st.push(box(0.6, 1.4, 3.6, [x, G + 0.7, z], DARK_CONCRETE));
    bm.add([-56, G + 5.2, z], [-56, G + 6.0, z], 0.3, STEEL);
  }
  bm.add([-56, G + 6.0, -34], [-56, G + 6.0, -8], 0.3, PIPE);                                                        // their manifold
  for (const [x, z, w] of [[-64, 14, 5], [-64, 22, 4], [-98, -44, 5], [-100, 22, 4], [-50, 24, 3.4], [-46, -46, 4]]) st.push(box(w, 2.4, 2.6, [x, G + 1.2, z], lin('#6c7176')), box(1.2, 1.3, 1.2, [x + 0.8, G + 3.0, z], lin('#8b8f93')), box(w + 0.6, 0.3, 3.2, [x, G + 0.15, z], DARK_CONCRETE));
  con.push(...block(-104, -40, G, G + 3.2, -44, -42.6, DARK_CONCRETE), ...block(-104, -40, G, G + 3.2, 30, 31.4, DARK_CONCRETE), ...block(-41.4, -40, G, G + 3.2, -44, 31.4, DARK_CONCRETE));
  { const x = -108, z = 36, h = 40;                                                                                  // vent stack in its lattice
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      bm.add([x + dx * 1.6, G, z + dz * 1.6], [x + dx * 0.7, G + h, z + dz * 0.7], 0.2, STEEL);
      for (let k = 0; k < 8; k++) { const w0 = lerp(1.6, 0.7, k / 8), w1 = lerp(1.6, 0.7, (k + 1) / 8), ya = G + (h * k) / 8, yb = G + (h * (k + 1)) / 8; bm.add([x + dx * w0, ya, z + dz * w0], [x - dz * w1, yb, z + dx * w1], 0.1, STEEL); }
    }
    bm.add([x, G, z], [x, G + h + 4, z], 0.7, PIPE);
  }
  // pipe rack from the farm over its wall to the mount
  for (const [dz, w, c] of [[-0.8, 0.5, PIPE], [0, 0.4, lin('#9da1a5')], [0.8, 0.5, PIPE]]) { bm.add([-48, G + 4.4, -6 + dz], [-17, G + 4.4, -6 + dz], w, c); bm.add([-17, G + 4.4, -6 + dz], [-9.8, G + 1.6, -2.6 + dz * 0.8], w, c); }
  for (let x = -46; x <= -18; x += 7) { for (const z of [-7.5, -4.5]) bm.add([x, G, z], [x, G + 4.0, z], 0.25, STEEL); bm.add([x, G + 4.0, -7.5], [x, G + 4.0, -4.5], 0.25, STEEL); }
  // ---- deluge water to the northeast: a big tank, the gas bottles that drive it out, the main to the plate
  st.push(revolve([[8, G], [8, G + 11], [7.2, G + 11.9], [0, G + 12.6]], { seg: 28, rgb: PAINT, crease: 30 }).translate(62, 0, -78));
  for (const y of [3.7, 7.4]) st.push(revolve([[8, G + y - 0.08], [8.08, G + y - 0.06], [8.08, G + y + 0.06], [8, G + y + 0.08]], { seg: 28, rgb: lin('#b4b4ae') }).translate(62, 0, -78));
  for (let k = 0; k < 5; k++) st.push(cyl(1.0, 1.0, 13, [84, G + 1.5, -90 + k * 2.6], lin('#3f4347'), 12, [0, 0, Math.PI / 2]));
  bm.add([55, G + 0.7, -73], [10, G + 0.7, -8.5], 0.9, PIPE);
  // ---- what else stands about a working pad: containers and sheds, a blockhouse, a crawler crane with its boom up
  for (const [x, z, turn, c, len] of [[18, 84, 0, '#c6c5bf', 12.2], [18, 88, 0, '#58677a', 12.2], [34, 86, 0, '#84463a', 6.1], [-20, 96, 1, '#c6c5bf', 12.2], [108, 6, 1, '#767b81', 12.2], [112, 6, 1, '#c6c5bf', 12.2], [62, 54, 0, '#4d594f', 6.1], [-8, -80, 0, '#c6c5bf', 12.2], [-8, -76, 0, '#6a7178', 12.2]])
    st.push(box(turn ? 2.44 : len, 2.6, turn ? len : 2.44, [x, G + 1.3, z], lin(c)));
  con.push(...block(86, 102, G, G + 4.6, -14, -2, lin('#a39f95')));
  st.push(box(17, 0.4, 13, [94, G + 4.8, -8], lin('#5b5d60')));
  { const A = [40, G + 2.6, 92], Bt = [22, G + 60, 66], C = lin('#b0481c'), n = 16, ux = 0.82, uz = -0.57;         // (u: level and square to the boom)
    st.push(box(7.5, 1.6, 6.5, [42, G + 0.8, 93], DARK), box(6, 2.6, 4.4, [43, G + 2.9, 93.5], C), box(3, 2, 3.4, [47, G + 2.6, 95], lin('#4a4c4f')));
    const dx = Bt[0] - A[0], dy = Bt[1] - A[1], dz = Bt[2] - A[2], L = Math.hypot(dx, dy, dz), t = [dx / L, dy / L, dz / L], v = [t[1] * uz, t[2] * ux - t[0] * uz, -t[1] * ux];
    const P = (f, a, b2) => { const w = 0.95 * Math.min(1, 4 * f + 0.25, 4 * (1 - f) + 0.25); return [A[0] + dx * f + (ux * a + v[0] * b2) * w, A[1] + dy * f + v[1] * b2 * w, A[2] + dz * f + (uz * a + v[2] * b2) * w]; };
    const cn = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    cn.forEach(([a, b2], i) => {
      const [a2, b3] = cn[(i + 1) % 4];
      for (let k = 0; k < n; k++) { bm.add(P(k / n, a, b2), P((k + 1) / n, a, b2), 0.2, C); bm.add(P(k / n, a, b2), P((k + 1) / n, a2, b3), 0.1, C); }
    });
    bm.add(Bt, [Bt[0] - 3, G + 22, Bt[2] - 4.3], 0.1, DARK); st.push(box(1, 1.6, 1, [Bt[0] - 3, G + 21.4, Bt[2] - 4.3], DARK));
    bm.add([44, G + 5, 94], [44, G + 16, 97], 0.5, C); bm.add([44, G + 16, 97], Bt, 0.1, DARK);                    // mast and pendants
  }
  // ---- floodlight masts
  const masts = [[95, 70], [-95, 80], [100, -60], [0, 130]];
  for (const [x, z] of masts) floodMast(x, z, G, 34, bm, lamps, st);
  st.push(bm.build());
  M.earth = new THREE.MeshStandardMaterial({ map: earthTexture(), vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.2 });          // (little of the sky's light: the land round it darkens early toward dusk, and the site should go with it)
  root.add(meshOf(con, M.concrete, false, true), meshOf([soft], M.earth, false, true), meshOf(st, M.struct), meshOf(lamps, M.lamp, false, false));

  // ---- ship quick-disconnect arm: swings back against the tower as the stack lifts off
  const qd = new THREE.Group(), yQ = STAND_SB + 73.4, hinge = [th - 0.6, yQ, tz + th + 0.4], tipZ = -4.75;
  const L = Math.hypot(hinge[0] - 0, hinge[2] - tipZ), a0 = Math.atan2(-(tipZ - hinge[2]), 0 - hinge[0]), qb = new Beams({ outward: true }), w = 3, h = 3.4, n = 4, bay = (L - 2.6) / n;
  for (const z of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) qb.add([0, y, z], [L - 2.6, y, z], 0.4, QD);
  for (let k = 0; k <= n; k++) {
    const x = k * bay;
    for (const z of [-w / 2, w / 2]) { qb.add([x, -h / 2, z], [x, h / 2, z], 0.25, QD); if (k < n) qb.add([x, (k & 1 ? 1 : -1) * h / 2, z], [x + bay, (k & 1 ? -1 : 1) * h / 2, z], 0.2, QD); }
    for (const y of [-h / 2, h / 2]) qb.add([x, y, -w / 2], [x, y, w / 2], 0.25, QD);
  }
  qd.add(meshOf([qb.build(), box(2.8, h + 0.6, w + 0.6, [L - 1.5, 0, 0], lin('#3a3c40')), box(0.4, 2.2, 2.4, [L - 0.05, -0.2, 0], lin('#7d8084')), box(L - 2.6, 0.12, w - 0.6, [(L - 2.6) / 2, -h / 2 + 0.3, 0], STEEL)], M.struct));
  qd.position.set(...hinge); qd.rotation.y = a0; root.add(qd);
  const lights = [];
  if (opts.lights !== false) for (const [x, z] of [[95, 70], [-95, 80], [0, 130]]) lights.push(spot(root, [x, G + 36, z], [0, STAND_SB + 60, 0], 0.5));
  return finish(root, M, lights, {
    standY: STAND_SB, towerTop: G + SB.rodH, deckY: MT, chopsticksY: yCar,
    /** Where a vehicle is caught: the top of the arms' rails (above the pad's origin), on the vehicle's own centerline. */
    catchY: yCar + 1.95,
    animate(t, dt, st2) {
      qd.rotation.y = a0 + 62 * D2R * sstep(-2.5, 0.5, t);
      // The arms: toward what is asked (s.arms: 0 shut .. 1 open as for launch .. 1.4 wide), at the pace of heavy steel.
      const want = Math.max(0, Math.min(1.4, st2?.arms ?? 1));
      armNow = dt > 0 ? armNow + Math.max(-dt * 0.55, Math.min(dt * 0.55, want - armNow)) : want;
      for (const c of chop) c.g.rotation.y = c.sx * (SHUT + (OPEN - SHUT) * armNow);
    },
  });
}

export function buildPad(kind, opts = {}) {
  const M = materials();
  if (kind === 'saturnv') return buildLC39(M, opts);
  if (kind === 'starship') return buildStarbase(M, opts);
  throw new Error(`unknown pad "${kind}"`);
}
