// Things met in orbit, as procedural models at true scale: buildSatellite(kind) -> { root, radius }.
// Kinds: 'iss' (109 m truss, eight gold array wings, radiators, the module stack along the direction of
// flight), 'hubble', 'tiangong' (the T of three modules), 'gps', 'comsat' (a generic geostationary
// communications satellite) and 'starlink'.
//
// Axes: origin at the center, +Y away from the Earth, -Z along the direction of flight. Each model is at
// most five meshes: solar cells (one small canvas of cells, tiled in meters), gold or silver insulation
// blanket (a crinkle normal map), and vertex-colored paint and metal for everything else, with lattice
// trusses built member by member (model-kit's Beams).

import * as THREE from 'three';
import { TAU, D2R, revolve, box, cyl, ball, Beams, meshOf, rng, disposeTree, canvas, tex, normalFromHeight, lin, rod } from './model-kit.js';

const WHITE = lin('#e6e6e2'), GRAY = lin('#8b8e92'), DARK = lin('#2a2b2e'), RUSSIAN = lin('#b9b6a8'), SILVER = [0.8, 0.81, 0.82];

function cellTexture() {
  const N = 256, [C, g] = canvas(N, N, '#0a1030'), rnd = rng(3);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) {
    const v = rnd() * 10;
    g.fillStyle = `rgb(${8 + v},${14 + v},${46 + v * 2.2})`; g.fillRect(x * 64 + 1.5, y * 32 + 1.5, 61, 29);
    g.fillStyle = 'rgba(150,160,200,0.22)'; g.fillRect(x * 64 + 21, y * 32 + 1.5, 0.8, 29); g.fillRect(x * 64 + 42, y * 32 + 1.5, 0.8, 29);
  }
  g.fillStyle = 'rgba(190,196,210,0.55)';
  for (let k = 0; k <= 4; k++) g.fillRect(k * 64 - 0.75, 0, 1.5, N);
  for (let k = 0; k <= 8; k++) g.fillRect(0, k * 32 - 0.75, N, 1.5);
  const t = tex(C, true, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}
function crinkleTexture() {
  const N = 256, [Hc, g] = canvas(N, N, '#808080'), rnd = rng(8);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * N, y = rnd() * N, w = 6 + rnd() * 30, h = 6 + rnd() * 30, v = Math.round(60 + rnd() * 140);
    g.fillStyle = `rgba(${v},${v},${v},0.5)`; g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y + (rnd() - 0.5) * h); g.lineTo(x + w * rnd(), y + h); g.closePath(); g.fill();
  }
  const t = tex(normalFromHeight(Hc, 1.6), false, true); t.wrapS = THREE.RepeatWrapping;
  return t;
}

function materials() {
  const cells = cellTexture(), crinkle = crinkleTexture();
  return {
    cells: new THREE.MeshStandardMaterial({ map: cells, roughness: 0.32, metalness: 0.35, emissive: new THREE.Color(0.01, 0.014, 0.05), side: THREE.DoubleSide }),
    gold: new THREE.MeshStandardMaterial({ map: cells, color: new THREE.Color(2.6, 1.5, 0.55), roughness: 0.36, metalness: 0.5, emissive: new THREE.Color(0.05, 0.028, 0.006), side: THREE.DoubleSide }),
    foil: new THREE.MeshStandardMaterial({ vertexColors: true, normalMap: crinkle, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.38, metalness: 0.9 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.8 }),
  };
}
const GOLD = [1.0, 0.72, 0.3], FOIL_SILVER = [0.86, 0.87, 0.88];

/** A flat panel centered at c spanning ±u and ±v (vectors); cells tile every (cu, cv) meters. */
function panel(c, u, v, cu = 1.6, cv = 1.6) {
  const p = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b]);
  const lu = Math.hypot(...u) * 2, lv = Math.hypot(...v) * 2, n = new THREE.Vector3(...u).cross(new THREE.Vector3(...v)).normalize();
  const g = new THREE.BufferGeometry(), uv = [[0, 0], [lu / cu, 0], [lu / cu, lv / cv], [0, lv / cv]], pos = [], nor = [], uvs = [], col = [];
  for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...p[i]); nor.push(n.x, n.y, n.z); uvs.push(...uv[i]); col.push(1, 1, 1); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
/** A module: a cylinder along Z from z0 to z1 with coned ends and a few ring frames. Geometry for the foil or paint bucket. */
function module(x, y, z0, z1, r, rgb, axis = 'z', seg = 24) {
  const L = z1 - z0, e = Math.min(0.6, L * 0.12);
  const g = revolve([[r * 0.55, 0], [r, e], [r, L * 0.33], [r + 0.03, L * 0.33 + 0.02], [r + 0.03, L * 0.33 + 0.12], [r, L * 0.33 + 0.14], [r, L * 0.66], [r + 0.03, L * 0.66 + 0.02], [r + 0.03, L * 0.66 + 0.12], [r, L * 0.66 + 0.14], [r, L - e], [r * 0.55, L], [0, L]], { seg, rgb, crease: 30, uv: (u, yy) => [u * 6, yy / 3] });
  g.translate(0, -L / 2, 0);
  if (axis === 'z') g.rotateX(Math.PI / 2); else if (axis === 'x') g.rotateZ(Math.PI / 2);
  g.translate(axis === 'x' ? x + (z0 + z1) / 2 : x, y, axis === 'z' ? (z0 + z1) / 2 : axis === 'x' ? 0 : 0);
  return g;
}
const finish = (M, o) => {
  const root = new THREE.Group();
  for (const k of ['cells', 'gold', 'foil', 'paint', 'metal']) { const m = meshOf(o[k], M[k]); if (m) root.add(m); }
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root), s = b.getBoundingSphere(new THREE.Sphere());
  return { root, radius: s.center.length() + s.radius, dispose() { disposeTree(root); } };
};

// ---------------------------------------------------------------- International Space Station

function iss(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] }, bm = new Beams(), TY = 4.6;
  // modules along the direction of flight (-Z is forward): Harmony, Destiny, Unity, Zarya, Zvezda
  o.paint.push(module(0, 0, -24.5, -17.5, 2.2, WHITE), module(0, 0, -17, -8.5, 2.15, WHITE), module(0, 0, -8, -2.5, 2.2, WHITE));
  o.paint.push(module(0, 0, -1.5, 11, 2.05, RUSSIAN), module(0, 0, 11.6, 24.7, 2.05, RUSSIAN), module(0, 0, -2.5, -1.5, 1.0, DARK));
  // Columbus and Kibo off Harmony, Quest and Tranquility off Unity, the cupola, visiting ships
  o.paint.push(module(2.2, 0, 0, 6.9, 2.2, WHITE, 'x').translate(0, 0, -21), module(-13.4, 0, 0, 11.2, 2.2, WHITE, 'x').translate(0, 0, -21));
  o.paint.push(box(5.2, 0.5, 5.0, [-15.5, -0.6, -25.8], GRAY), module(-9.5, 3.4, -23, -19, 1.6, WHITE));
  o.paint.push(module(2.2, 0, 0, 5.5, 1.9, WHITE, 'x').translate(0, 0, -5.2), module(-9, 0, 0, 6.8, 2.2, WHITE, 'x').translate(0, 0, -5.2));
  o.metal.push(cyl(1.4, 0.9, 1.3, [-6, -2.6, -5.2], GRAY, 8));
  o.paint.push(module(0, 0, 25, 32.2, 1.35, RUSSIAN));
  o.paint.push(cyl(1.1, 1.3, 6.8, [0, -5.6, 15], RUSSIAN, 16), cyl(1.1, 1.2, 6.5, [0, -5.5, -5.2], WHITE, 16));
  // Russian arrays: Zvezda's pair, and the visiting ships' little wings
  for (const s of [1, -1]) { o.cells.push(panel([s * 9.2, 0, 20], [6.6, 0, 0], [0, 1.2, 1.1], 1.1, 0.8), panel([s * 4.6, 0, 28.5], [2.4, 0, 0], [0, 0.2, 0.75], 0.8, 0.5)); bm.add([s * 2, 0, 20], [s * 2.8, 0, 20], 0.2, GRAY); }
  // integrated truss: a covered box across the middle, open lattice out to the arrays
  o.paint.push(box(4.6, 3.6, 13, [0, TY + 0.2, -9], lin('#c9cac8'), [0, Math.PI / 2, 0]));
  for (const s of [1, -1]) {
    o.paint.push(box(14, 3.4, 4.2, [s * 13.5, TY + 0.2, -9], lin('#d2d3d0')), box(9, 4.4, 4.6, [s * 28.5, TY + 0.2, -9], lin('#c6c7c5')));
    const zc = -9, h = 1.9;
    for (const [dy, dz] of [[-h, -h], [h, -h], [h, h], [-h, h]]) bm.add([s * 33, TY + dy, zc + dz], [s * 54.5, TY + dy, zc + dz], 0.22, GRAY);
    for (let x = 33; x < 54.4; x += 3.07) {
      const xa = s * x, xb = s * (x + 3.07);
      bm.add([xa, TY - h, zc - h], [xb, TY + h, zc - h], 0.14, GRAY); bm.add([xa, TY + h, zc + h], [xb, TY - h, zc + h], 0.14, GRAY);
      bm.add([xa, TY + h, zc - h], [xb, TY + h, zc + h], 0.14, GRAY); bm.add([xa, TY - h, zc + h], [xb, TY - h, zc - h], 0.14, GRAY);
      for (const [a, b] of [[[-h, -h], [h, -h]], [[h, -h], [h, h]], [[h, h], [-h, h]], [[-h, h], [-h, -h]]]) bm.add([xa, TY + a[0], zc + a[1]], [xa, TY + b[0], zc + b[1]], 0.12, GRAY);
    }
    // four array wings a side: each two blankets 35 m long on a mast, tilted on the alpha joint
    for (const x of [36.5, 51.5]) for (const dir of [1, -1]) {
      const tilt = (x > 40 ? 32 : 18) * D2R * s, ux = Math.cos(tilt), uy = Math.sin(tilt), zc2 = zc + dir * 21.5;
      for (const side of [-1, 1]) o.gold.push(panel([s * x + side * 3.25 * ux, TY + side * 3.25 * uy, zc2], [2.35 * ux, 2.35 * uy, 0], [0, 0, 17.3], 1.17, 0.865));
      bm.add([s * x, TY, zc + dir * 2.2], [s * x, TY, zc + dir * 38.8], 0.3, GRAY);
      for (const zz of [4.2, 38.8]) bm.add([s * x - 5.6 * ux, TY - 5.6 * uy, zc + dir * zz], [s * x + 5.6 * ux, TY + 5.6 * uy, zc + dir * zz], 0.22, GRAY);
      o.metal.push(cyl(0.7, 0.7, 4.4, [s * x, TY, zc + dir * 2.2], GRAY, 10, [Math.PI / 2, 0, 0]));
    }
    // thermal radiators: three white panels trailing from each inboard truss, one from each array module
    for (let k = 0; k < 3; k++) o.paint.push(box(3.2, 0.08, 22.5, [s * (9.5 + k * 3.7), TY - 0.4, zc + 13.5], WHITE, [0.14 * (k - 1), 0, 0.5 * s]));
    o.paint.push(box(3.3, 0.08, 13, [s * 33.5, TY - 1, zc + 8.5], WHITE, [0, 0, 1.2]), box(3.3, 0.08, 13, [s * 54, TY - 1, zc - 8.5], WHITE, [0, 0, 1.2]));
  }
  // robot arm on the truss, antenna dish
  bm.add([4, TY + 2, -9], [7.5, TY + 8, -12], 0.36, WHITE); bm.add([7.5, TY + 8, -12], [13, TY + 4.5, -15], 0.36, WHITE);
  o.metal.push(cyl(0.2, 1.1, 0.7, [-3.5, TY + 5.6, -9], lin('#d8d8d4'), 16), rod([-3.5, TY + 2, -9], [-3.5, TY + 5.3, -9], 0.1, GRAY));
  o.paint.push(bm.build());
  return finish(M, o);
}

// ---------------------------------------------------------------- Hubble Space Telescope

function hubble(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] };
  const uv = (u, y) => [u * 5, y / 2.2];
  o.foil.push(revolve([[0, -6.6], [1.9, -6.6], [2.14, -6.35], [2.14, -2.9], [2.2, -2.88], [2.2, -1.42], [2.14, -1.4], [1.6, -1.25], [1.55, -1.2], [1.55, 6.5], [1.6, 6.52], [1.6, 6.62], [1.5, 6.62]], { seg: 40, rgb: FOIL_SILVER, crease: 25, uv }));
  o.metal.push(revolve([[1.5, 6.62], [1.5, -0.8]], { seg: 32, rgb: [0.02, 0.02, 0.02] }), revolve([[1.5, -0.8], [0.3, -0.8], [0.3, 1.5], [0, 1.5]], { seg: 24, rgb: [0.05, 0.05, 0.06] }));
  for (const y of [-2.9, -1.4, 0.9, 2.6, 4.6]) o.metal.push(revolve([[y < -1 ? 2.2 : 1.55, y - 0.05], [(y < -1 ? 2.2 : 1.55) + 0.04, y - 0.04], [(y < -1 ? 2.2 : 1.55) + 0.04, y + 0.04], [y < -1 ? 2.2 : 1.55, y + 0.05]], { seg: 40, rgb: SILVER }));
  // equipment bay doors, as slightly whiter panels round the middle section
  for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU; o.paint.push(box(0.03, 1.25, 1.15, [2.215, -2.15, 0], lin('#d9dadc')).rotateY(a)); }
  // aperture door, open
  o.foil.push(cyl(1.6, 1.6, 0.08, [0, 0, 0], FOIL_SILVER, 32).translate(-1.6, 0, 0).rotateZ(-105 * D2R).translate(1.6, 6.62, 0));
  // two rigid solar arrays on masts either side, high-gain dishes on their booms
  for (const s of [1, -1]) {
    o.cells.push(panel([0, 0.4, s * 3.7], [1.22, 0, 0], [0, 3.55, 0], 0.61, 0.44));
    o.metal.push(rod([0, 0.4, s * 1.5], [0, 0.4, s * 3.7], 0.07, SILVER), rod([-1.3, 0.4 - 3.7, s * 3.7], [-1.3, 0.4 + 3.7, s * 3.7], 0.05, SILVER), rod([1.3, 0.4 - 3.7, s * 3.7], [1.3, 0.4 + 3.7, s * 3.7], 0.05, SILVER));
    o.metal.push(rod([s * 1.55, 1.2, 0], [s * 3.4, 3.4, 0], 0.04, SILVER));
    o.paint.push(cyl(0.05, 0.62, 0.3, [s * 3.5, 3.5, 0], WHITE, 18, [0, 0, -s * 0.7]));
  }
  return finish(M, o);
}

// ---------------------------------------------------------------- Tiangong

function tiangong(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] }, bm = new Beams(), C = lin('#d8d6cf');
  // Tianhe core: wide work section, narrower service section aft, the node forward
  o.paint.push(module(0, 0, -2.2, 6.0, 2.1, C), module(0, 0, 6.0, 12.5, 1.4, C), ball(1.45, [0, 0, -3.6], C, 20));
  // Wentian and Mengtian either side of the node
  for (const s of [1, -1]) {
    o.paint.push(module(s > 0 ? 1.4 : -19.3, 0, 0, 17.9, 2.05, C, 'x').translate(0, 0, -3.6));
    // each lab's pair of long wings on a truss at its far end
    const xe = s * 21.6;
    bm.add([s * 19.3, 0, -3.6], [s * 23.6, 0, -3.6], 1.1, GRAY, 1.1, true);
    for (const d of [1, -1]) { o.cells.push(panel([xe, 0, -3.6 + d * 15.2], [2.1, 0.5, 0], [0, 0, 13.2], 1.05, 0.66)); bm.add([xe, 0, -3.6 + d * 1], [xe, 0, -3.6 + d * 2.1], 0.3, GRAY); }
    // Tianhe's own wings
    o.cells.push(panel([s * 8.0, 0, 9.2], [5.8, 0, 0], [0, 0.6, 1.25], 0.97, 0.62)); bm.add([s * 1.4, 0, 9.2], [s * 2.3, 0, 9.2], 0.18, GRAY);
  }
  // cargo ship aft, crew ship forward and one under the node
  o.paint.push(module(0, 0, 12.9, 22.6, 1.65, lin('#cfcfca')), module(0, 0, -13.2, -5.2, 1.25, lin('#c9c9c4')), cyl(1.15, 1.25, 7.6, [0, -5.6, -3.6], lin('#c9c9c4'), 16));
  for (const s of [1, -1]) o.cells.push(panel([s * 3.6, 0, 20.5], [2.2, 0, 0], [0, 0.2, 0.9], 0.73, 0.6), panel([s * 2.9, 0, -7.0], [1.6, 0, 0], [0, 0.2, 0.6], 0.8, 0.6), panel([s * 2.9, -7.2, -3.6], [1.6, 0, 0], [0, 0.6, 0.2], 0.8, 0.6));
  // robotic arm folded along the core
  bm.add([1.6, 2.0, -1], [1.9, 2.5, 4], 0.25, WHITE); bm.add([1.9, 2.5, 4], [1.2, 2.2, -0.2], 0.22, WHITE);
  o.paint.push(bm.build());
  return finish(M, o);
}

// ---------------------------------------------------------------- GPS, comsat, Starlink

function gps(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] };
  o.foil.push(setBoxUv(box(2.5, 2.2, 2.0, [0, 0, 0], GOLD), 1.2));
  // Earth-facing antenna farm: twelve L-band helices in two rings, and the stubby UHF and S-band antennas
  o.paint.push(box(2.3, 0.08, 1.9, [0, -1.14, 0], lin('#d0d0cc')));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; o.metal.push(cyl(0.11, 0.06, 0.62, [Math.cos(a) * 0.82, -1.48, Math.sin(a) * 0.7], SILVER, 10)); }
  for (let k = 0; k < 4; k++) { const a = (k / 4) * TAU + 0.6; o.metal.push(cyl(0.11, 0.06, 0.62, [Math.cos(a) * 0.3, -1.48, Math.sin(a) * 0.3], SILVER, 10)); }
  o.metal.push(rod([1.05, -1.2, 0.8], [1.05, -2.3, 0.8], 0.03, SILVER), rod([-1.05, -1.2, -0.8], [-1.05, -2.0, -0.8], 0.03, SILVER), cyl(0.05, 0.3, 0.25, [-0.9, 1.25, 0.6], WHITE, 14));
  for (const s of [1, -1]) {
    o.metal.push(rod([s * 1.25, 0, 0], [s * 2.4, 0, 0], 0.06, SILVER), rod([s * 2.4, 0, -1.0], [s * 2.4, 0, 1.0], 0.04, SILVER));
    for (let k = 0; k < 3; k++) o.cells.push(panel([s * (3.55 + k * 2.3), 0, 0], [1.1, 0, 0], [0, 0.45, 1.2], 0.55, 0.4));
  }
  return finish(M, o);
}
/** Give a box made by kit.prim (which blanks its UVs) coordinates in meters so the crinkle map shows. */
function setBoxUv(g, scale) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (ax > 0.5) uv.setXY(i, p.getZ(i) / scale, p.getY(i) / scale); else if (ay > 0.5) uv.setXY(i, p.getX(i) / scale, p.getZ(i) / scale); else uv.setXY(i, p.getX(i) / scale, p.getY(i) / scale);
  }
  return g;
}

function comsat(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] };
  o.foil.push(setBoxUv(box(2.4, 4.6, 2.6, [0, 0, 0], GOLD), 1.3));
  o.paint.push(box(2.42, 1.5, 2.62, [0, -0.6, 0], lin('#2b2c2f')));
  // apogee engine on the zenith face, feed horns and a small dish on the Earth deck
  o.metal.push(cyl(0.12, 0.42, 0.7, [0, 2.65, 0], [0.3, 0.3, 0.32], 16, undefined, true));
  o.paint.push(box(1.2, 0.5, 1.0, [0, -2.55, 0], WHITE), cyl(0.08, 0.45, 0.3, [0.6, -2.5, 0.8], WHITE, 16, [Math.PI, 0, 0]));
  for (const s of [1, -1]) {
    // reflectors on the east and west faces, tipped toward the Earth, on their booms
    const dish = revolve([[0, 0], [0.5, 0.03], [0.9, 0.11], [1.25, 0.22], [1.25, 0.26], [0.9, 0.15], [0.5, 0.07], [0, 0.04]], { seg: 32, rgb: WHITE, crease: 60 });
    dish.rotateX(s * (Math.PI / 2 + 0.5)).translate(0, -0.6, s * 3.1);
    o.paint.push(dish);
    o.metal.push(rod([0.5, -0.2, s * 1.3], [0.4, -0.9, s * 2.6], 0.04, SILVER), rod([-0.5, -0.2, s * 1.3], [-0.4, -0.9, s * 2.6], 0.04, SILVER), cyl(0.07, 0.16, 0.4, [0, -2.2, s * 1.0], SILVER, 10, [s * 0.5, 0, 0]));
    // solar wings north and south: a yoke and five panels each
    o.metal.push(rod([s * 1.2, 0.6, 0], [s * 2.8, 0.6, 0], 0.05, SILVER), rod([s * 1.9, 0.6, 0], [s * 2.9, 0.6, -1.0], 0.03, SILVER), rod([s * 1.9, 0.6, 0], [s * 2.9, 0.6, 1.0], 0.03, SILVER));
    for (let k = 0; k < 5; k++) o.cells.push(panel([s * (4.1 + k * 2.42), 0.6, 0], [1.17, 0, 0], [0, 0.35, 1.25], 0.585, 0.44));
  }
  return finish(M, o);
}

function starlink(M) {
  const o = { cells: [], gold: [], foil: [], paint: [], metal: [] };
  // the flat bus, its four phased-array antennas looking down, and the single array standing up from one edge
  o.metal.push(box(3.1, 0.22, 1.6, [0, 0, 0], [0.62, 0.63, 0.65]));
  o.paint.push(box(3.12, 0.1, 1.62, [0, 0.07, 0], lin('#2c2d30')));
  for (const [x, z, r] of [[-0.95, 0, 0.6], [0.5, -0.3, 0.42], [0.5, 0.42, 0.3], [1.25, 0.1, 0.25]]) o.paint.push(cyl(r, r, 0.03, [x, -0.125, z], lin('#d6d6d2'), 24));
  o.metal.push(cyl(0.09, 0.09, 0.3, [1.35, -0.2, -0.6], DARK, 10), rod([-1.55, 0.1, 0], [-1.55, 0.7, 0], 0.04, SILVER));
  for (let k = 0; k < 4; k++) o.cells.push(panel([-1.55, 1.7 + k * 2.02, 0], [0, 1.0, 0], [0.12, 0, 1.4], 0.5, 0.47));
  return finish(M, o);
}

const KINDS = { iss, hubble, tiangong, gps, comsat, starlink };
export const SATELLITES = Object.keys(KINDS);

export function buildSatellite(kind) {
  const build = KINDS[kind];
  if (!build) throw new Error(`unknown satellite "${kind}"`);
  return build(materials());
}
