// Standalone viewer for the space models: a launch vehicle (with its plume and exhaust trail), a launch pad
// and a satellite, under three lighting rigs: "studio" (a neutral room), "day" (sun, sky, fog and a ground
// plane, like the game's ground scene) and "space" (one hard sun, a whisper of ambient, black sky).
//
// URL parameters: v=saturnv|starship|none, pad=1|saturnv|starship, sat=iss|hubble|tiangong|gps|comsat|starlink,
// stage, throttle, pressure, time, t (seconds since liftoff, for the pad), night, light=studio|day|space,
// bloom=0|1, trail=1, speed, launch=1 (a scripted launch: see V.launch), wind=x,z (m/s), quality=low|med|high|ultra.
// Keys: V vehicle, P pad, L light, [ ] stage, - = throttle, , . pressure, B bloom, T trail, G launch, F follow the
// vehicle, space pauses. Drag to orbit, wheel to zoom, right-drag to pan.
//
// From code: window.V. V.set({...}) takes the same names as the URL; V.view({ target, az, el, dist, fov })
// places the camera; V.frame(dt) advances by dt seconds and draws one frame (the page also runs on its
// own while it is visible); V.calls('vehicle'|'pad'|'sat'|'plume'|'trail'|'all') counts draw calls.
// V.launch({ hold: seconds of venting before ignition, wind: [x, z], follow: true|false, shade: 0..1 }) stands the
// vehicle on its pad and flies a scripted climb straight up, feeding the exhaust trail the same fields the game
// does (ignition, liftoff, speed, air pressure, Mach number); V.run(seconds, dt) advances without drawing.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const hud = document.getElementById('hud'), errBox = document.getElementById('err');
const fail = (what, e) => { console.error(what, e); errBox.textContent += `${what}: ${e && e.message ? e.message : e}\n`; };
const load = async (path) => { try { return await import(/* @vite-ignore */ path); } catch (e) { fail(path, e); return null; } };

const [vehMod, plumeMod, padMod, satMod] = await Promise.all([
  load('../src/space/vehicles.js'), load('../src/space/plume.js'), load('../src/space/pad.js'), load('../src/space/satmodels.js'),
]);

const q = new URLSearchParams(location.search), num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
const S = {
  vehicle: q.get('v') || (q.has('sat') ? 'none' : 'saturnv'), pad: q.get('pad') || '', sat: q.get('sat') || '',
  stage: num('stage', 0), throttle: num('throttle', 0), pressure: num('pressure', 1), time: num('time', 0), t: num('t', -10),
  night: num('night', 0), light: q.get('light') || 'studio', bloom: num('bloom', 1), trail: num('trail', 0), speed: num('speed', 0),
  gimbal: { x: 0, y: 0 }, flaps: null, paused: false, altitude: 0, quality: q.get('quality') || 'high',
  wind: (q.get('wind') || '3,1').split(',').map(Number), shade: 0, sunEl: num('sunel', 0), sunAz: num('sunaz', 0),
};
// The scripted launch: height above the stand, speed, what the engines give, seconds since liftoff.
const A = { on: false, y: 0, vy: 0, th: 0, met: -1, lifted: false, hold: 0, follow: true };

// ---------------------------------------------------------------- renderer and rigs
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.7;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 60000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false; controls.zoomSpeed = 1.4;

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.1, 0.7, 2.0);
composer.addPass(bloom); composer.addPass(new OutputPass());

const pmrem = new THREE.PMREMGenerator(renderer);
const envStudio = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// a plain sky for the day rig: blue overhead, pale at the horizon, a dull ground
const skyScene = new THREE.Scene();
{
  const g = new THREE.SphereGeometry(100, 32, 16), c = [], p = g.attributes.position, col = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const h = p.getY(i) / 100;
    if (h >= 0) col.setRGB(0.75, 0.86, 1.0).lerp(new THREE.Color(0.2, 0.42, 0.9), Math.pow(h, 0.5)); else col.setRGB(0.33, 0.33, 0.3);
    c.push(col.r, col.g, col.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  skyScene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
}
const envDay = pmrem.fromScene(skyScene, 0.02).texture;

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
Object.assign(sun.shadow.camera, { left: -180, right: 180, top: 220, bottom: -60, near: 10, far: 1500 });
const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x5a5850, 0.6), amb = new THREE.AmbientLight(0xffffff, 0.03);
scene.add(sun, sun.target, hemi, amb);
const ground = new THREE.Mesh(new THREE.CircleGeometry(20000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x566049, roughness: 1 }));
ground.receiveShadow = true; ground.position.y = -0.3; scene.add(ground);
const skyDome = skyScene.children[0].clone(); skyDome.scale.setScalar(300); skyDome.material = skyDome.material.clone(); skyDome.material.fog = false; scene.add(skyDome);

const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.56).normalize();
function applyLight() {
  const day = S.light === 'day', space = S.light === 'space', n = S.night;
  if (S.sunEl) { const e = (S.sunEl * Math.PI) / 180, a = (S.sunAz * Math.PI) / 180; SUN_DIR.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)); }
  scene.environment = space ? null : day ? envDay : envStudio;
  scene.environmentIntensity = day ? 0.8 * (1 - 0.96 * n) : 0.75;
  scene.background = new THREE.Color(space ? 0x000000 : 0x2a2d31);
  scene.fog = day ? new THREE.FogExp2(new THREE.Color(0.72, 0.8, 0.9).multiplyScalar(1 - 0.97 * n), 0.00012) : null;
  skyDome.visible = day; skyDome.material.color.setScalar(1 - 0.985 * n);
  ground.visible = day;
  sun.position.copy(SUN_DIR).multiplyScalar(600); sun.intensity = space ? 3.4 : day ? 2.6 * (1 - 0.98 * n) : 1.8;
  hemi.intensity = space ? 0 : day ? 0.3 * (1 - 0.95 * n) : 0.2; amb.intensity = space ? 0.03 : 0;
}

// ---------------------------------------------------------------- what is on stage
let vehicle = null, pad = null, sat = null, plume = null, trail = null, built = {};
const spentBits = [];
function clear(o) { if (!o) return; (o.root || o.group || o.object).removeFromParent(); o.dispose && o.dispose(); }
function rebuild() {
  clear(vehicle); clear(pad); clear(sat); clear(plume); clear(trail);
  for (const b of spentBits.splice(0)) b.removeFromParent();
  vehicle = pad = sat = plume = trail = null; built = {};
  const time = (name, fn) => { const t0 = performance.now(); try { const r = fn(); built[name] = +(performance.now() - t0).toFixed(1); return r; } catch (e) { fail(name, e); return null; } };
  if (S.vehicle && S.vehicle !== 'none' && vehMod) { vehicle = time('vehicle', () => vehMod.buildVehicle(S.vehicle)); if (vehicle) scene.add(vehicle.root); }
  const padKind = S.pad === '1' ? S.vehicle : S.pad;
  if (padKind && padKind !== '0' && padMod) { pad = time('pad', () => padMod.buildPad(padKind)); if (pad) scene.add(pad.root); }
  if (S.sat && satMod) { sat = time('sat', () => satMod.buildSatellite(S.sat)); if (sat) scene.add(sat.root); }
  if (vehicle && plumeMod) {
    plume = time('plume', () => new plumeMod.Plume()); if (plume) vehicle.root.add(plume.group);
    trail = time('trail', () => new plumeMod.ExhaustTrail(S.quality)); if (trail) scene.add(trail.object);
  }
  if (vehicle) { vehicle.root.position.set(0, pad ? pad.standY : 0, 0); vehicle.setStage(S.stage); }
  ground.position.y = pad ? -0.3 : vehicle ? -0.3 : -1e4;
}

const _v = new THREE.Vector3(), _d = new THREE.Vector3(0, -1, 0), _w = new THREE.Vector3(3, 0, 1), _vel = new THREE.Vector3(), _base = new THREE.Vector3(), _nose = new THREE.Vector3(0, 1, 0);
const sunColor = new THREE.Color(), ambColor = new THREE.Color();
const ACCEL = { saturnv: 11.9, starship: 14.7 };
/** One step of the scripted launch: engines come up, the vehicle lets go when they carry it, then climbs straight up. */
function ascent(dt) {
  if (A.hold > 0) { A.hold -= dt; return; }
  A.th += (1 - A.th) * Math.min(1, dt / 0.7);
  const a0 = ACCEL[S.vehicle] || 12;
  if (!A.lifted && A.th * a0 > 9.91) { A.lifted = true; A.met = 0; }
  if (A.lifted) { A.met += dt; A.vy += (A.th * (a0 + 0.16 * A.met) - 9.81 - 2e-5 * A.vy * A.vy * Math.exp(-A.y / 7200)) * dt; A.y += A.vy * dt; }
}
function step(dt) {
  if (!S.paused || dt) { S.time += dt; S.t += dt; }
  if (A.on && dt > 0) { ascent(dt); S.throttle = A.th; S.pressure = Math.exp(-A.y / 7200); S.t = A.lifted ? A.met : -10; S.altitude = A.y; }
  if (vehicle) {
    const stage = Math.min(S.stage, vehicle.stages.length - 1), st = vehicle.stages[stage], standY = pad ? pad.standY : 0;
    if (A.on) vehicle.root.position.y = standY + A.y;
    vehicle.update(dt, { throttle: S.throttle, stage, gimbal: S.gimbal, altitude: S.altitude, mach: A.on ? A.vy / 310 : 0, q: 0, night: S.night, time: S.time, flaps: S.flaps || undefined });
    if (plume) plume.update(dt, { nozzles: st.nozzles, nozzleRadius: st.nozzleRadius, nozzleRadii: st.nozzleRadii, throttle: S.throttle, pressure: S.pressure, propellant: st.propellant, speed: S.speed, time: S.time, night: S.night });
    if (trail) {
      if ((S.trail || A.on) && dt > 0) {
        if (!A.on) { vehicle.root.position.y += S.speed * dt; _vel.set(0, S.speed, 0); } else _vel.set(0, A.vy, 0);
        _base.copy(vehicle.root.position); _base.y += st.bottomY;
        _v.set(0, st.nozzles && st.nozzles.length ? st.nozzles[0].y : st.bottomY, 0).add(vehicle.root.position);
        _w.set(S.wind[0] || 0, 0, S.wind[1] || 0);
        const up = vehicle.root.position.y - standY, onStand = up < 0.01;
        // the same fields the game's mission.js gives
        trail.emit(dt, {
          pos: _v, dir: _d, vel: _vel, throttle: S.throttle, pressure: S.pressure, propellant: st.propellant, radius: vehicle.radius, wind: _w,
          onPad: up < 40, groundY: 0, vehicle: S.vehicle, stage, landed: A.on ? !A.lifted : onStand && !S.speed, held: A.on ? !A.lifted && A.th < 0.01 : onStand && S.throttle < 0.01,
          met: A.on ? (A.lifted ? A.met : -1) : S.t, agl: up, mach: _vel.y / 310, q: 0, padY: 0, standY, hasPad: !!pad && up < 400, base: _base, nose: _nose, height: vehicle.height, heat: 0, shade: S.shade,
        });
      }
      sunColor.copy(sun.color).multiplyScalar(sun.intensity / Math.PI); ambColor.setRGB(0.3, 0.38, 0.5).multiplyScalar(S.light === 'space' ? 0.02 : 1 - 0.95 * S.night);
      trail.update(dt, { camPos: camera.position, sunDir: SUN_DIR, sunColor, ambient: ambColor, time: S.time });
    }
    if (A.on && A.follow) { const y = vehicle.root.position.y + vehicle.height * 0.3, d = y - controls.target.y; controls.target.y = y; camera.position.y += d; }
  }
  if (pad) pad.update(dt, { t: S.t, night: S.night });
}

function resize() {
  const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight, pr = renderer.getPixelRatio();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function draw() {
  resize(); controls.update();
  renderer.info.reset();
  if (S.bloom) composer.render(); else renderer.render(scene, camera);
  const st = vehicle ? vehicle.stages[Math.min(S.stage, vehicle.stages.length - 1)] : null;
  hud.textContent = `${S.vehicle}${pad ? ' + pad' : ''}${S.sat ? ' ' + S.sat : ''}  light ${S.light}  night ${S.night}\n` +
    (st ? `stage ${S.stage} ${st.name} (${st.propellant})  throttle ${S.throttle.toFixed(2)}  pressure ${S.pressure.toFixed(3)}  time ${S.time.toFixed(1)}  t ${S.t.toFixed(1)}\n` : '') +
    `build ms ${JSON.stringify(built)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}` +
    (trail && trail.count ? `\nsmoke ${trail.count} puffs  overdraw ${trail.overdraw.toFixed(1)} screens  quality ${S.quality}` : '') + (A.on ? `  T${A.lifted ? '+' + A.met.toFixed(1) : '-'}  height ${A.y.toFixed(0)} m  ${A.vy.toFixed(0)} m/s` : '');
}
renderer.info.autoReset = false;

const V = (window.V = {
  S, THREE, scene, camera, controls, renderer, sun, SUN_DIR,
  get vehicle() { return vehicle; }, get pad() { return pad; }, get sat() { return sat; }, get plume() { return plume; }, get trail() { return trail; }, get built() { return built; },
  set(o = {}) {
    const re = ['vehicle', 'pad', 'sat'].some((k) => k in o && o[k] !== S[k]);
    Object.assign(S, o);
    if (re) rebuild();
    if (vehicle && 'stage' in o) vehicle.setStage(S.stage);
    if (trail && 'quality' in o) trail.setQuality(S.quality);
    applyLight();
    return V;
  },
  /** Camera on a sphere round `target`: az degrees from south toward east, el degrees above the horizon. */
  view({ target, az = 30, el = 10, dist = 200, fov } = {}) {
    if (target) controls.target.set(...target);
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    camera.position.set(controls.target.x + dist * Math.cos(e) * Math.sin(a), controls.target.y + dist * Math.sin(e), controls.target.z + dist * Math.cos(e) * Math.cos(a));
    if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    controls.update();
    return V;
  },
  frame(dt = 0) { step(dt); draw(); return renderer.info.render.calls; },
  /** Advance by `seconds` in steps of dt without drawing. */
  run(seconds, dt = 1 / 30) { for (let t = 0; t < seconds - 1e-6; t += dt) step(dt); return V; },
  /** Stand the vehicle on its pad and fly the scripted climb. */
  launch(o = {}) {
    if (!S.pad) V.set({ pad: '1' });
    if (S.light === 'studio') V.set({ light: 'day' });
    if (o.wind) S.wind = o.wind;
    if (o.shade != null) S.shade = o.shade;
    if (trail) trail.clear();
    Object.assign(A, { on: true, y: 0, vy: 0, th: 0, met: -1, lifted: false, hold: o.hold ?? 2, follow: o.follow ?? true });
    S.stage = 0; if (vehicle) vehicle.setStage(0);
    S.paused = false;
    return V;
  },
  A,
  /** Draw calls of one part alone, in a plain render with no shadows or post-processing. */
  calls(which = 'all') {
    const parts = { vehicle: vehicle && vehicle.root, pad: pad && pad.root, sat: sat && sat.root, plume: plume && plume.group, trail: trail && trail.object };
    const keep = [], hide = (o) => { if (o && o.visible) { keep.push(o); o.visible = false; } };
    if (which !== 'all') { for (const k of Object.keys(parts)) if (k !== which && !(which === 'plume' && k === 'vehicle')) hide(parts[k]); hide(ground); hide(skyDome); }
    if (which === 'plume' && vehicle) vehicle.stages.forEach((s) => hide(s.group));
    const sm = renderer.shadowMap.enabled; renderer.shadowMap.enabled = false;
    renderer.info.reset(); renderer.render(scene, camera);
    const n = renderer.info.render.calls, tris = renderer.info.render.triangles;
    renderer.shadowMap.enabled = sm; for (const o of keep) o.visible = true;
    return { calls: n, triangles: tris };
  },
  /** Throw stage n clear, as the game would: returns the detached copy, already in the scene. */
  spent(n, offset = [30, -20, 0]) { const c = vehicle.spent(n); scene.add(c); c.position.add(new THREE.Vector3(...offset)); c.rotation.z += 0.25; spentBits.push(c); return c; },
  errors: () => errBox.textContent,
});

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase(), ids = vehMod ? vehMod.VEHICLES.map((v) => v.id) : [];
  if (k === 'v') V.set({ vehicle: ids[(ids.indexOf(S.vehicle) + 1) % ids.length] });
  else if (k === 'p') V.set({ pad: S.pad ? '' : '1' });
  else if (k === 'l') V.set({ light: { studio: 'day', day: 'space', space: 'studio' }[S.light] });
  else if (k === '[') V.set({ stage: Math.max(0, S.stage - 1) });
  else if (k === ']') V.set({ stage: Math.min(vehicle ? vehicle.stages.length - 1 : 0, S.stage + 1) });
  else if (k === '-') S.throttle = Math.max(0, S.throttle - 0.1);
  else if (k === '=') S.throttle = Math.min(1, S.throttle + 0.1);
  else if (k === ',') S.pressure = Math.max(0, S.pressure * 0.7 - 0.0005);
  else if (k === '.') S.pressure = Math.min(1, S.pressure / 0.7 + 0.001);
  else if (k === 'b') S.bloom = S.bloom ? 0 : 1;
  else if (k === 't') S.trail = S.trail ? 0 : 1;
  else if (k === 'g') V.launch();
  else if (k === 'f') A.follow = !A.follow;
  else if (k === 'n') V.set({ night: S.night > 0.5 ? 0 : 1 });
  else if (k === ' ') S.paused = !S.paused;
});

rebuild(); applyLight();
if (num('launch', 0)) V.launch();
{
  const h = vehicle ? vehicle.height : sat ? sat.radius : 100, base = pad && vehicle ? pad.standY : 0;
  if (sat && !vehicle) V.view({ target: [0, 0, 0], az: 35, el: 20, dist: sat.radius * 3.4 });
  else V.view({ target: [0, base + h * 0.5, 0], az: 35, el: 6, dist: h * 2.1 });
}
let last = performance.now();
(function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!S.paused) step(dt);
  draw();
})(last);
