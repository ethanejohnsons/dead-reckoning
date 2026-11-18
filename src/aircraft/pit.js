// The cockpits of the aircraft that come as model files (the P-51D, the F-16, the 737): FlightGear's own, converted
// by tools/ac2glb.py into public/models/*_pit.glb in the same axes and about the same origin as the outside of the
// aircraft, so the two line up. gltfmodel.js asks for one when its aircraft is chosen; the aircraft flies meanwhile.
//
// loadPit() fetches the file, merges what never moves into one mesh a material (the converter has already put the
// colors in the vertices and the textures on a few sheets), and keeps apart what a hinge moves: instrument needles,
// the stick, the throttle, the pedals, each set of parts that the same hinges move as one mesh a material; drums of
// digits, which only slide their texture, share one mesh. That comes to some fifty draw calls for a cockpit. The
// hinges are the file's `rig` (FlightGear's own animations, with their axes and tables), each named for what drives
// it: DRIVE below turns the flight model's state into those values, in the units the instruments are marked in
// (knots, feet, feet a minute, inches of mercury, degrees). A part is only moved again when a value it follows has
// changed. A hinge of kind `s` shows or hides its part instead (an altimeter's flag below 10,000 feet).
//
// What FlightGear draws with its own canvas code is drawn here instead (displays.js): the 737's and the F-16's
// screens onto the screens' own polygons, and the F-16's head-up display.
//
// Light: by day the cockpit takes the scene's; a trace of its own keeps the shaded side out of the murk. As it gets
// dark the panels are floodlit (every surface gives back a little of its own color), and what is lit from within
// (annunciators, the screens) stays as it is.
//
// A variant describes its cockpit in `model.pit` (see variants.js):
//   url       path under the site root
//   hide      optional, names (regular expressions) of parts not to draw
//   oneSided  optional, true to draw its surfaces from their front only (as it is, both sides: the walls of a
//             cockpit are often the inside of something drawn for the outside)
//   own       optional, names of parts kept apart (not merged) and handed to the screens' code by name
//   env, fill optional, how much of the sky's light the surfaces take (0.28) and how much they give back by day (0.035):
//             more for a cockpit under a clear canopy than for one under a roof
//   flood     optional, how much they give back under the floodlights at night (0.22): less for a pale flight deck
//   plain     optional, [r, g, b]: the color given to what the file left bare white (neither painted nor textured)
//   tint      optional, [[names, [r, g, b]], ...]: parts whose color is multiplied (a seat cover, a column left unpainted)
//   rig       optional, hinges of our own, ahead of the file's (the same fields); rigInner: the same, after the file's
//             (where two move one part, the earlier is the outer)
//   drive     optional, { driver: (ac, s) => value } over DRIVE below
//   screens   optional, which of displays.js's sets of screens it has
//   glass     optional, names of the parts of the OUTSIDE model that are its glazing as the pilot sees it: gltfmodel.js
//             makes of them the surface the post-processing draws rain and frost on
//   fuelLb    optional, what its real tanks hold (pounds), for a fuel display

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { REGION } from '../world/geo.js';
import { SCREENS } from './displays.js';

const KT = 1.94384, FT = 3.28084, R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const files = new Map();                 // url -> promise of the file's bytes
const fetchFile = (url) => {
  if (!files.has(url)) files.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); }).catch((e) => { files.delete(url); throw e; }));
  return files.get(url);
};

/** Value of a hinge's table [[driver value, degrees or meters], ...] at x. */
export function table(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) { const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return x1 > x0 ? y0 + (y1 - y0) * (x - x0) / (x1 - x0) : y1; }
  return tab[tab.length - 1][1];
}

// What moves the cockpit's hinges: [value from the flight model (ac) and the smoothed state (s), the step it is
// rounded to]. The step is what keeps a still needle from being redone every frame.
const DRIVE = {
  kt: [(ac) => ac.ias * KT, 0.2], mach: [(ac) => ac.mach, 0.002],
  altft: [(ac) => Math.max(0, ac.pos.y * FT), 1], fpm: [(ac, s) => s.vs, 10],
  hdg: [(ac, s) => s.mag, 0.1], pitch: [(ac) => ac.pitch * R2D, 0.1], roll: [(ac) => ac.bank * R2D, 0.1],
  turn: [(ac, s) => s.turn, 0.05], slip: [(ac, s) => s.slip, 0.01],
  g: [(ac) => ac.gLoad, 0.02], aoa: [(ac) => ac.alpha * R2D, 0.1],
  rpm: [(ac) => ac.rpm, 5], n1: [(ac) => ac.rpm, 0.1],
  // manifold pressure of a supercharged piston engine, inches of mercury: about 20 at idle, 61 with the lever forward
  map: [(ac) => (ac.fuel > 0 && !ac.crashed ? 20 + 41 * ac.thrustLevel : 29.9), 0.1],
  thr: [(ac) => ac.throttle, 0.005],
  // (the controls as FlightGear counts them: stick forward, stick right and right pedal are positive)
  stickP: [(ac) => -ac.elev, 0.01], stickR: [(ac) => ac.ail, 0.01], pedal: [(ac) => ac.rud, 0.01],
  gear: [(ac) => ac.gear, 0.01], gearLever: [(ac) => ac.gearTarget, 0.5], flap: [(ac) => ac.flap, 0.01], flapLever: [(ac) => ac.flapTarget, 0.05],
  // the clock runs on the aircraft's own time (it starts at ten thirty, as the Cessna's does)
  clock: [(ac) => (ac.t + 37800) % 43200, 0.05], clockH: [(ac) => Math.floor((ac.t + 37800) / 3600) % 24, 1], clockM: [(ac) => Math.floor((ac.t + 37800) / 60) % 60, 1],
  // what the flight model does not follow: an engine that is running sits in the green
  oilP: [(ac) => (run(ac) ? 55 + 30 * ac.thrustLevel : 0), 0.5], oilT: [(ac) => (run(ac) ? 60 + 22 * ac.thrustLevel : 15), 0.5],
  coolT: [(ac) => (run(ac) ? 85 + 20 * ac.thrustLevel : 15), 0.5], fuelP: [(ac) => (run(ac) ? 17 : 0), 0.5], vac: [(ac) => (run(ac) ? 4.6 : 0), 0.1],
  oat: [(ac) => 15 - 0.0065 * ac.pos.y, 0.5],
  ftit: [(ac) => (run(ac) ? 480 + 320 * ac.thrustLevel + 120 * (ac.reheat || 0) : 20), 2], noz: [(ac) => (run(ac) ? Math.max(0.75 - 1.1 * ac.thrustLevel, ac.reheat || 0, 0.06) : 0.9), 0.01],
};

const run = (ac) => ac.fuel > 0 && !ac.crashed;
// Drivers that never change: the altimeter setting, the oxygen in the bottles.
const STILL = { baro: 29.92, oxP: 400 };

/** Geometry as the merge wants it: every attribute a plain one (the file's byte normals come interleaved with their padding). */
function plain(geo) {
  for (const k of Object.keys(geo.attributes)) {
    const a = geo.attributes[k];
    if (!a.isInterleavedBufferAttribute) continue;
    const out = new a.array.constructor(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.data.array[i * a.data.stride + a.offset + j];
    geo.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
  }
  return geo;
}

/** The cockpit's surfaces give back a share of their own color as light: `emissive` is how much (the floodlights, or a lamp within). */
function flood(m) {
  m.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = diffuseColor.rgb * emissive;'); };
  m.customProgramCacheKey = () => 'pit-flood';
}

/**
 * Load a variant's cockpit into parts.pit. `at` is where the outside model's origin sits in the aircraft's axes.
 * Resolves once it is in (or to nothing if the aircraft was given up meanwhile); rejects if the file cannot be had.
 */
export async function loadPit(variant, parts, at) {
  const C = variant.model.pit;
  const data = await fetchFile(C.url);
  if (parts.disposed) return;
  const gltf = await new GLTFLoader().parseAsync(data.slice(0), C.url.slice(0, C.url.lastIndexOf('/') + 1));
  const src = gltf.scene;
  if (parts.disposed) { src.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose(); } }); return; }
  const rig = [...(C.rig || []), ...(src.userData.rig || []), ...(C.rigInner || [])];
  const group = new THREE.Group(); group.position.copy(at);

  // Materials: the file has one for every finish; here those that would draw alike (same sheet, same kind of
  // transparency, lit or not, dull or glossy) become one, so that what they cover can be one mesh.
  const mats = [], seen = new Map(), alike = new Map();
  const tune = (m) => {
    if (seen.has(m)) return seen.get(m);
    if (m.map) m.map.anisotropy = 8;
    m.envMapIntensity = C.env ?? 0.28; m.metalness = 0; m.roughness = m.roughness < 0.6 ? 0.5 : 0.85;
    if (!C.oneSided) m.side = THREE.DoubleSide;        // (walls drawn for the outside are seen from within)
    if (m.transparent) m.depthWrite = false;
    m.userData.lamp = Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 0.2;       // lit from within, in the file
    const key = [m.map ? m.map.uuid : '', m.transparent, m.alphaTest > 0, m.userData.lamp, m.roughness, m.vertexColors].join();
    if (!alike.has(key)) { alike.set(key, m); flood(m); mats.push(m); }
    seen.set(m, alike.get(key));
    return alike.get(key);
  };

  // Parts: those the same hinges move are merged together, one mesh a material; those nothing moves likewise.
  // A hinge whose driver never changes (STILL) is applied here and now, and its part counts as one that does not move.
  const is = (list, chain) => (list || []).some((re) => chain.some((n) => re.test(n)));
  const moving = [], named = new Map(), sets = new Map();
  const put = (key, hinges, mat, geo) => {
    if (!sets.has(key)) sets.set(key, { hinges, by: new Map() });
    const by = sets.get(key).by;
    if (!by.has(mat)) by.set(mat, []);
    by.get(mat).push(geo);
  };
  const list = [...(src.children.length === 1 && !src.children[0].isMesh ? src.children[0].children : src.children)];
  for (const o of list) {
    const name = o.userData.name ?? o.name, chain = [...(o.userData.path || []), name];
    if (is(C.hide, chain)) continue;
    // Its hinges, the outermost first: one that moves a whole sub-model comes before one that moves a part of it.
    let hinges = rig.map((r, i) => ({ r, i, d: chain.findIndex((n) => r.on.includes(n)) })).filter((h) => h.d >= 0).sort((a, b) => a.d - b.d || a.i - b.i);
    const fixed = hinges.length && hinges.every((h) => h.r.by in STILL && h.r.kind !== 's');
    const key = fixed ? '' : hinges.map((h) => h.i).join();
    hinges = hinges.map((h) => h.r);
    o.traverse((c) => { if (c.isMesh) { plain(c.geometry); c.material = tune(c.material); c.castShadow = false; c.receiveShadow = !c.material.transparent; if (c.material.transparent) c.renderOrder = 3; } });
    const tint = (C.tint || []).find(([re]) => chain.some((x) => re.test(x))) || (C.plain && [null, C.plain, true]);
    if (tint) o.traverse((c) => {
      // (`plain`: only what the file left bare and white, a wall or a pedestal with neither paint nor texture)
      const a = c.isMesh && c.geometry.attributes.color;
      if (!a || (tint[2] && (c.material.map || a.getX(0) < 0.85 || a.getY(0) < 0.85 || a.getZ(0) < 0.85))) return;
      for (let i = 0; i < a.count; i++) a.setXYZ(i, a.getX(i) * tint[1][0], a.getY(i) * tint[1][1], a.getZ(i) * tint[1][2]);
    });
    if (fixed) {
      const m = new THREE.Matrix4(); let du = 0, dv = 0;
      for (const h of hinges) { const val = hingeValue(h, STILL[h.by]); if (h.kind === 'u') { du += h.axis[0] * val; dv += h.axis[1] * val; } else m.multiply(hingeMatrix(h, val)); }
      o.traverse((c) => { if (!c.isMesh) return; c.geometry.applyMatrix4(m); if (du || dv) { const a = c.geometry.attributes.uv.array; for (let i = 0; i < a.length; i += 2) { a[i] += du; a[i + 1] += dv; } } });
    }
    if (is(C.own, chain)) { named.set(name, o); group.add(o); if (key) moving.push(part(o, hinges)); }
    else o.traverse((c) => { if (c.isMesh) put(key, hinges, c.material, c.geometry); });
  }
  // Drums of digits (parts that only slide their texture) need no place of their own: those of one material are one
  // mesh, and each keeps the stretch of its texture coordinates that is its to move.
  const drums = new Map();
  for (const [key, set] of sets) {
    if (!key || !set.hinges.every((h) => h.kind === 'u')) continue;
    for (const [mat, geos] of set.by) { if (!drums.has(mat)) drums.set(mat, []); for (const geo of geos) drums.get(mat).push({ set, geo }); }
    sets.delete(key);
  }
  for (const [mat, list] of drums) {
    const g = list.length > 1 ? mergeGeometries(list.map((e) => e.geo), false) : list[0].geo;
    if (!g) { for (const e of list) { const m = new THREE.Mesh(e.geo, mat); group.add(m); moving.push(part(m, e.set.hinges)); } continue; }       // (unlike geometries: each on its own)
    const uv = g.attributes.uv;
    let at = 0;
    for (const e of list) { const n = e.geo.attributes.position.count * 2; (e.set.uv || (e.set.uv = [])).push({ a: uv, at, base: uv.array.slice(at, at + n) }); at += n; if (list.length > 1) e.geo.dispose(); }
    const m = new THREE.Mesh(g, mat); m.castShadow = false; m.receiveShadow = !mat.transparent; if (mat.transparent) m.renderOrder = 3;
    group.add(m);
  }
  for (const set of new Set([...drums.values()].flat().map((e) => e.set))) moving.push({ o: null, hinges: set.hinges, key: '', uv: set.uv });
  for (const [key, set] of sets) {
    const holder = key ? new THREE.Group() : group;
    for (const [mat, geos] of set.by) {
      const g = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
      for (const x of g ? [g] : geos) {                          // (geometries that will not merge: each on its own)
        const m = new THREE.Mesh(x, mat);
        m.castShadow = false; m.receiveShadow = !mat.transparent; if (mat.transparent) m.renderOrder = 3;
        holder.add(m);
      }
      if (g && geos.length > 1) for (const x of geos) x.dispose();
    }
    if (key) { group.add(holder); moving.push(part(holder, set.hinges)); }
  }

  const P = { group, moving, named, mats, variant, fill: C.fill, flood: C.flood, drive: { ...DRIVE }, D: {}, s: { vs: 0, turn: 0, slip: 0, mag: 0, last: undefined, seen: -1 }, night: -1, screens: null };
  for (const k in C.drive || {}) P.drive[k] = [C.drive[k], DRIVE[k]?.[1] ?? 0.005];
  P.used = [...new Set(moving.flatMap((p) => p.hinges.map((h) => h.by)))].filter((k) => P.drive[k]);
  if (C.screens && SCREENS[C.screens]) P.screens = SCREENS[C.screens](P, variant, parts);
  parts.pit.add(group);
  parts.cockpit = P;
}

function part(o, hinges) {
  o.matrixAutoUpdate = false; o.matrix.identity();
  const p = { o, hinges, key: '', uv: null };
  if (hinges.some((h) => h.kind === 'u')) {
    // a drum or a tape: its texture slides, so the object keeps coordinates of its own
    p.uv = [];
    o.traverse((c) => { if (c.isMesh) { const a = c.geometry.attributes.uv; p.uv.push({ a, at: 0, base: a.array.slice() }); } });
  }
  return p;
}

const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mC = new THREE.Matrix4(), axis = new THREE.Vector3();
/** A hinge turned or slid by `val` (degrees or meters), as a matrix (mA: used at once). */
function hingeMatrix(h, val) {
  axis.set(h.axis[0], h.axis[1], h.axis[2]);
  if (h.kind === 't') return mA.makeTranslation(axis.x * val, axis.y * val, axis.z * val);
  return mA.makeTranslation(h.c[0], h.c[1], h.c[2]).multiply(mB.makeRotationAxis(axis, val * Math.PI / 180)).multiply(mC.makeTranslation(-h.c[0], -h.c[1], -h.c[2]));
}
/** A hinge's value in its own units: its table, after the stepping of a drum of digits (FlightGear's step and scroll). */
function hingeValue(h, x) {
  if (h.bias) x += h.bias;
  if (h.step > 0) {
    let roll = 0;
    if (h.scroll > 0) { const rem = h.step - (Math.abs(x) % h.step); if (rem < h.scroll) roll = ((h.scroll - rem) / h.scroll) * h.step; }
    x = (x > 0 ? Math.floor(x / h.step) : Math.ceil(x / h.step)) * h.step + roll;
  }
  return table(h.tab, x);
}

/** Each frame while the cockpit is drawn: needles, drums and controls, the screens, the lighting. */
export function animatePit(parts, ac, dt, time, night) {
  const P = parts.cockpit;
  if (!P) return;
  const s = P.s, D = P.D;
  // What the instruments lag behind or work out: vertical speed (as the Cessna's needle does), rate of turn, slip, magnetic heading.
  if (!(time - s.seen < 0.5)) { s.last = undefined; s.vs = ac.vel.y * FT * 60; s.turn = 0; }       // (back from another view: no catching up)
  s.seen = time;
  const k = dt > 0 ? 1 - Math.exp(-dt * 2.2) : 1;
  s.vs += (ac.vel.y * FT * 60 - s.vs) * k;
  const rate = dt > 0 && s.last !== undefined ? (((ac.heading - s.last + 540) % 360) - 180) / dt : 0;
  s.last = ac.heading;
  s.turn += (clamp(rate, -9, 9) - s.turn) * (dt > 0 ? 1 - Math.exp(-dt * 3) : 0);
  s.slip = clamp((ac.onGround ? 0 : ac.beta) / 0.1, -1, 1);
  s.mag = (((ac.heading - REGION.magVar) % 360) + 360) % 360;

  for (const name of P.used) { const d = P.drive[name], v = d[0](ac, s, time) || 0; D[name] = Math.round(v / d[1]) * d[1]; }
  for (const p of P.moving) {
    let key = '';
    for (const h of p.hinges) key += D[h.by] + ',';
    if (key === p.key) continue;
    p.key = key;
    const m = p.o ? p.o.matrix.identity() : null;
    let du = 0, dv = 0, shown = true;
    for (const h of p.hinges) {
      if (h.kind === 's') { const x = D[h.by] ?? 0; shown = shown && x >= h.show[0] && x < h.show[1]; continue; }       // (a flag that shows over part of the range)
      const val = hingeValue(h, D[h.by] ?? 0);
      if (h.kind === 'u') { du += h.axis[0] * val; dv += h.axis[1] * val; continue; }
      m.multiply(hingeMatrix(h, val));
    }
    if (p.o) { p.o.matrixWorldNeedsUpdate = true; p.o.visible = shown; }
    if (p.uv) for (const { a, at, base } of p.uv) { const arr = a.array; for (let i = 0; i < base.length; i += 2) { arr[at + i] = base[i] + du; arr[at + i + 1] = base[i + 1] + dv; } a.needsUpdate = true; }
  }

  const n = Math.round(clamp(night || 0, 0, 1) * 40) / 40;
  if (n !== P.night) {
    P.night = n;
    const fl = (P.fill ?? 0.035) + (P.flood ?? 0.22) * n;
    for (const m of P.mats) { if (m.userData.lamp) m.emissive.setScalar(1.0 - 0.45 * n); else m.emissive.setRGB(fl, fl * 0.86, fl * 0.7); }
  }
  if (P.screens) P.screens.update(ac, dt, time, n, s);
}
