// Aircraft that come as model files (glTF) rather than being generated in code (model.js): the jets.
//
// The files in public/models/ are made by tools/ac2glb.py from FlightGear's aircraft: already in the game's axes
// (meters, +X right wing, +Y up, -Z out the nose), every part a node of its own at the origin, and the hinges of
// the landing gear and control surfaces stored with the scene as a `rig` (see that tool for its fields).
//
// loadAircraft() fetches a variant's file, sets it on its center of gravity and its wheels, merges the parts that
// never move into a few meshes, and wraps it in the same { root, parts } that buildAircraft() returns, so the camera,
// the shadows, the weather and the post-processing treat it like any other aircraft. What the file does not bring is
// added here: navigation lights, an engine nozzle, the flame of an afterburner, the sheen of rain on the paint.
//
// A variant describes its file in `model` (see variants.js):
//   url       path under the site root
//   cg        station (the file's Z) of the center of gravity, and
//   ground    height (the file's Y) of the undersides of the main wheels as drawn: they stand on the runway
//   hide      optional, names (regular expressions) of parts not to draw
//   stow      optional, names of parts that are out of sight once the landing gear is up
//   drive     optional, { driver: (ac) => value } for the rig's drivers, over the usual ones (see DRIVE)
//   skip      optional, drivers of the rig to leave alone
//   rig       optional, hinges of our own, ahead of the file's (the same fields as the file's rig)
//   lights    { navL, navR, strobeL, strobeR, tail, beacon, landing }: positions, in the aircraft's axes (as below)
//   exhaust   nozzles, for the heat shimmer and the contrails: [[x, y, z, plume length, width], ...]
//   nozzle    optional, a plain engine nozzle to add: { at: [x, y, z], r0, r1, len }
//   burner    optional afterburner: { at: [[x, y, z], ...], r, len }
//   tips      [y, z] of the wingtips (their x is half the span)
//   clear     optional, names of parts whose texture is see-through in places (a propeller's blur disk)
//   prop      optional propeller: { blades, disk: names of the parts that turn and of the blur drawn in their place
//             once it is running, hub: [x, y] of the shaft }

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PILOT_EYE, PILOT_VIEW } from './model.js';

const files = new Map();                 // url -> promise of the file's bytes (kept: a model is parsed afresh each time it is chosen)
const fetchFile = (url) => {
  if (!files.has(url)) files.set(url, fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); }).catch((e) => { files.delete(url); throw e; }));
  return files.get(url);
};

let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.85)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.16)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); glowTex.userData.shared = true;
  return glowTex;
}

// What moves the rig, from the flight model's state. A variant's `drive` adds to these or replaces them.
const DRIVE = {
  gear: (ac) => ac.gear, flap: (ac) => ac.flap, brake: (ac) => ac.airbrake,
  elev: (ac) => ac.elev, rud: (ac) => ac.rud, ail: (ac) => ac.ail, ailL: (ac) => ac.ail, ailR: (ac) => -ac.ail,
};

// The flame of an afterburner: a cone of light behind the nozzle, hot and blue-white at the root, orange and
// thinning toward the tip, with the shock diamonds standing in it.
const BURNER_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN, vV;
void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const BURNER_FRAG = /* glsl */`
uniform float uLevel, uTime;
varying vec2 vUv; varying vec3 vN, vV;
void main() {
  float t = 1.0 - vUv.y;                                            // 0 at the nozzle, 1 at the tip
  float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.4);     // brightest where the cone is seen through its middle
  float diamonds = 0.65 + 0.35 * pow(0.5 + 0.5 * sin(t * 26.0 - 1.2), 3.0) * (1.0 - t);
  float flick = 0.9 + 0.1 * sin(uTime * 71.0 + t * 9.0) * sin(uTime * 43.0);
  float a = pow(max(1.0 - t, 0.0), 1.6) * rim * diamonds * flick * uLevel;
  vec3 c = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.42, 0.12), smoothstep(0.0, 0.5, t));
  gl_FragColor = vec4(c * a * 9.0, a);
}`;

const namesOf = (o) => [o.userData.name ?? o.name, ...(o.userData.path || [])];

/**
 * Load a variant's model file and make it the game's kind of aircraft. Resolves to { root, parts, variant }
 * (see buildAircraft in model.js for what `parts` holds); free it with disposeAircraft.
 */
export async function loadAircraft(variant) {
  const v = variant, M = v.model, sp = v.spec;
  const data = await fetchFile(M.url);
  const gltf = await new GLTFLoader().parseAsync(data.slice(0), M.url.slice(0, M.url.lastIndexOf('/') + 1));
  const src = gltf.scene, rig = [...(M.rig || []), ...(src.userData.rig || [])].filter((r) => !(M.skip || []).includes(r.by));

  const root = new THREE.Group(), body = new THREE.Group(), pit = new THREE.Group();
  root.add(body, pit); pit.visible = false;
  const parts = { body, pit, glass: null, variant: v };
  // The file's origin is moved so that the center of gravity is the aircraft's own, and the wheels stand on the runway.
  const holder = new THREE.Group(); body.add(holder);
  holder.position.set(0, -sp.wheelDrop - M.ground, -M.cg);

  // ---- materials: lit by the sky like the rest of the scene; glass let through
  const paint = [], seen = new Set();
  const tidy = (m) => {
    if (seen.has(m)) return; seen.add(m);
    if (m.map) m.map.anisotropy = 8;
    if (m.userData.decal) return;
    if (m.transparent || m.opacity < 0.99) {
      m.transparent = true; m.depthWrite = false; m.envMapIntensity = 1.3;
      if (m.isMeshStandardMaterial) { m.roughness = 0.06; m.metalness = 0.9; }
      return;
    }
    if (m.isMeshStandardMaterial) { m.envMapIntensity = M.env ?? 0.9; paint.push({ m, rough: m.roughness, env: m.envMapIntensity }); }
  };

  // ---- parts: those a hinge moves stay as they are; the rest are merged, one mesh a material
  const moving = [], still = new Map(), list = [...(src.children.length === 1 && !src.children[0].isMesh ? src.children[0].children : src.children)];
  for (const o of list) {
    const names = namesOf(o);
    if ((M.hide || []).some((re) => names.some((n) => re.test(n)))) continue;
    const hinges = rig.filter((r) => r.on.some((n) => names.includes(n)));
    const is = (list) => (list || []).some((re) => names.some((n) => re.test(n)));
    if (is(M.clear)) o.traverse((c) => { if (c.isMesh) { c.material = c.material.clone(); c.material.transparent = true; c.material.depthWrite = false; c.material.userData.decal = true; } });
    if (M.prop && (is(M.prop.blades) || is(M.prop.disk))) {
      // the propeller: turned about its shaft each frame; the blades give way to the blur once the engine runs
      const disk = is(M.prop.disk);
      o.traverse((c) => { if (c.isMesh) { tidy(c.material); c.castShadow = !disk; c.receiveShadow = !disk; if (disk) c.renderOrder = 4; } });
      o.matrixAutoUpdate = false; holder.add(o); (parts.prop || (parts.prop = { blades: [], disk: [], angle: 0, hub: M.prop.hub }))[disk ? 'disk' : 'blades'].push(o);
      continue;
    }
    o.traverse((c) => { if (c.isMesh) { tidy(c.material); const clear = c.material.transparent; c.castShadow = !clear; c.receiveShadow = !clear; if (clear) c.renderOrder = 3; } });
    if (hinges.length) {
      o.matrixAutoUpdate = false; o.matrix.identity();
      moving.push({ o, hinges, stow: (M.stow || []).some((re) => names.some((n) => re.test(n))), key: '' });
      holder.add(o);
    } else o.traverse((c) => { if (c.isMesh) { if (!still.has(c.material)) still.set(c.material, []); still.get(c.material).push(c.geometry); } });
  }
  for (const [mat, geos] of still) {
    const g = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    if (geos.length > 1) for (const x of geos) x.dispose();
    const m = new THREE.Mesh(g, mat), clear = mat.transparent;
    m.castShadow = !clear; m.receiveShadow = !clear; if (clear) m.renderOrder = 3;
    holder.add(m);
  }
  parts.paint = paint; parts.moving = moving;
  parts.drive = { ...DRIVE, ...(M.drive || {}) }; parts.driven = {};

  // ---- what the file leaves out: a plain engine nozzle
  const P = (p) => [p[0], p[1] - sp.wheelDrop - M.ground, p[2] - M.cg];      // a point of the file, in the aircraft's axes
  if (M.nozzle) {
    const N = M.nozzle, geo = new THREE.CylinderGeometry(N.r1, N.r0, N.len, 28, 1, true);
    geo.translate(0, N.len / 2, 0); geo.rotateX(Math.PI / 2);                                 // from the origin toward +Z
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2826, metalness: 0.85, roughness: 0.42, side: THREE.DoubleSide, envMapIntensity: 0.7 });
    const m = new THREE.Mesh(geo, mat); m.position.set(...P(N.at)); m.castShadow = true; body.add(m);
  }

  // ---- lights: a lens and an additive glow that grows at night (as on the generated aircraft)
  const lights = {};
  const lamp = (name, color, p, r) => {
    if (!p) return;
    const lens = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ color }));
    lens.position.set(...P(p)); root.add(lens);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.position.copy(lens.position); s.renderOrder = 6; root.add(s);
    lights[name] = { lens, glow: s };
  };
  const L = M.lights || {}, big = v.view?.scale ?? 1;
  lamp('navL', new THREE.Color(1.6, 0.05, 0.03), L.navL, 0.03); lamp('navR', new THREE.Color(0.05, 1.5, 0.25), L.navR, 0.03);
  lamp('strobeL', new THREE.Color(2.2, 2.2, 2.4), L.strobeL, 0.03); lamp('strobeR', new THREE.Color(2.2, 2.2, 2.4), L.strobeR, 0.03);
  lamp('tail', new THREE.Color(1.3, 1.3, 1.2), L.tail, 0.03);
  lamp('beacon', new THREE.Color(2.0, 0.08, 0.04), L.beacon, 0.04);
  lamp('landing', new THREE.Color(2.6, 2.5, 2.2), L.landing, 0.07);
  parts.lights = lights; parts.lightScale = 0.6 + 0.4 * big;

  // ---- afterburner
  if (M.burner) {
    const B = M.burner, geo = new THREE.CylinderGeometry(B.r, B.r * 0.22, B.len, 24, 1, true);
    geo.translate(0, -B.len / 2, 0); geo.rotateX(-Math.PI / 2);                   // the nozzle end at the origin, the flame toward +Z
    const mat = new THREE.ShaderMaterial({ vertexShader: BURNER_VERT, fragmentShader: BURNER_FRAG, uniforms: { uLevel: { value: 0 }, uTime: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    parts.burners = B.at.map((p) => { const m = new THREE.Mesh(geo, mat); m.position.set(...P(p)); m.renderOrder = 5; m.visible = false; m.frustumCulled = false; root.add(m); return m; });
    parts.burnerMat = mat;
  }

  // ---- what the weather, the camera and the post-processing follow
  const hw = sp.span / 2, tip = P([0, M.tips?.[0] ?? 0, M.tips?.[1] ?? 0]);
  parts.wingtips = [new THREE.Vector3(-hw, tip[1], tip[2]), new THREE.Vector3(hw, tip[1], tip[2])];
  parts.exhaust = (M.exhaust || []).map((e) => [...P(e), e[3], e[4]]);
  parts.nozzles = parts.exhaust.map((e) => new THREE.Vector3(e[0], e[1], e[2]));     // where the contrails begin
  parts.gearHeight = sp.gearHeight;
  PILOT_EYE.set(...P(v.eye)); parts.eye = PILOT_EYE.clone();
  PILOT_VIEW.down = v.view?.down ?? 0.08;
  parts.animate = animate;
  animate(parts, { gear: 1, flap: 0, airbrake: 0, elev: 0, rud: 0, ail: 0, reheat: 0, agl: 0, crashed: null, fuel: 1, thrustLevel: 0 }, 0, 0, 0, 0);
  return { root, parts, variant: v };
}

const mA = new THREE.Matrix4(), mB = new THREE.Matrix4(), mC = new THREE.Matrix4(), axis = new THREE.Vector3();
/** Value of a hinge's table [[driver value, degrees or meters], ...] at x. */
function table(tab, x) {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) if (x <= tab[i][0]) { const [x0, y0] = tab[i - 1], [x1, y1] = tab[i]; return x1 > x0 ? y0 + (y1 - y0) * (x - x0) / (x1 - x0) : y1; }
  return tab[tab.length - 1][1];
}

/** Each frame: hinged parts, afterburner, lights, rain on the paint (the generated aircraft's animateAircraft hands over to this). */
function animate(parts, ac, dt, time, night, wet = 0) {
  // Hinges: each part is turned and slid by its own, the first listed outermost. Only parts whose drivers have moved are redone.
  const D = parts.driven;
  for (const k in parts.drive) D[k] = Math.round(Math.max(-1, Math.min(1, parts.drive[k](ac) || 0)) * 400) / 400;
  for (const p of parts.moving) {
    let key = '';
    for (const h of p.hinges) key += D[h.by] + ',';
    if (key === p.key) continue;
    p.key = key;
    const m = p.o.matrix.identity();
    for (const h of p.hinges) {
      const val = table(h.tab, D[h.by] ?? 0);
      axis.set(h.axis[0], h.axis[1], h.axis[2]);
      if (h.kind === 't') mA.makeTranslation(axis.x * val, axis.y * val, axis.z * val);
      else mA.makeTranslation(h.c[0], h.c[1], h.c[2]).multiply(mB.makeRotationAxis(axis, val * Math.PI / 180)).multiply(mC.makeTranslation(-h.c[0], -h.c[1], -h.c[2]));
      m.multiply(mA);
    }
    p.o.matrixWorldNeedsUpdate = true;
    if (p.stow) p.o.visible = D.gear > 0.02;
  }

  if (parts.prop) {
    // (the blur is drawn while the engine runs, fainter the faster it turns; the blades when it has stopped)
    const pr = parts.prop, running = ac.fuel > 0 && !ac.crashed, thr = ac.thrustLevel || 0;
    pr.angle -= dt * (running ? 24 + 140 * thr : Math.min(ac.tas || 0, 45) * 0.5);
    mA.makeTranslation(pr.hub[0], pr.hub[1], 0).multiply(mB.makeRotationZ(pr.angle)).multiply(mC.makeTranslation(-pr.hub[0], -pr.hub[1], 0));
    for (const o of pr.blades) { o.visible = !running; o.matrix.copy(mA); o.matrixWorldNeedsUpdate = true; }
    for (const o of pr.disk) { o.visible = running; o.matrix.copy(mA); o.matrixWorldNeedsUpdate = true; o.traverse((c) => { if (c.isMesh) c.material.opacity = 1.05 - 0.45 * thr; }); }
  }

  if (parts.burners) {
    const on = ac.reheat > 0.01 && !ac.crashed;
    for (const b of parts.burners) b.visible = on;
    if (on) { parts.burnerMat.uniforms.uLevel.value = ac.reheat; parts.burnerMat.uniforms.uTime.value = time; }
  }

  if (parts.wetNow !== wet) {
    parts.wetNow = wet;
    for (const p of parts.paint) { p.m.roughness = p.rough * (1 - 0.5 * wet); p.m.envMapIntensity = p.env + 0.5 * wet; }
  }

  const L = parts.lights, n = Math.max(0, Math.min(1, night || 0)), k = parts.lightScale;
  const set = (l, on, size) => { if (!l) return; l.glow.visible = on; l.lens.visible = on; if (on) l.glow.scale.setScalar(size * k); };
  set(L.navL, true, 0.3 + 1.6 * n); set(L.navR, true, 0.3 + 1.6 * n); set(L.tail, true, 0.24 + 1.2 * n);
  const ph = time % 1.3, strobe = ph < 0.05 || (ph > 0.13 && ph < 0.18);
  set(L.strobeL, strobe, 0.7 + 1.9 * n); set(L.strobeR, strobe, 0.7 + 1.9 * n);
  set(L.beacon, time % 1.05 < 0.13, 0.6 + 1.5 * n);
  set(L.landing, ac.gear > 0.9 && (ac.agl < 600 || n > 0.5), 0.4 + 3.6 * n);       // the landing lights ride on the legs: out with them
}
