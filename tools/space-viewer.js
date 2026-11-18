// Standalone viewer for the space models: a launch vehicle (with its plume and exhaust trail), a launch pad
// and a satellite, under three lighting rigs: "studio" (a neutral room), "day" (sun, sky, fog and a ground
// plane, like the game's ground scene) and "space" (one hard sun, a whisper of ambient, black sky).
//
// URL parameters: v=saturnv|starship|enterprise|bridge|none, pad=1|saturnv|starship, sat=iss|hubble|tiangong|gps|comsat|starlink,
// stage, throttle, pressure, time, t (seconds since liftoff, for the pad), night, light=studio|day|space,
// bloom=0|1, trail=1, speed, launch=1 (a scripted launch: see V.launch), wind=x,z (m/s), quality=low|med|high|ultra.
// v=enterprise shows the starship (src/space/model-enterprise.js) by itself: warp, impulse, flash (each 0..1) and night
// drive its lights (also V.set({ warp: 1 })); in the space rig it gets the game's sunlight and eye and the Earth's light from
// below (earth=strength), and night takes both away.
// v=bridge shows the starship's bridge (src/space/bridge-enterprise.js) from the captain's chair, in front of a bright painted
// sky (the main viewer and the skylight are openings: the sky shows in them). Drag to turn the head, wheel to zoom.
// yaw, pitch (degrees: to starboard, up), fov, expo (the picture's exposure, as the game gives it) and the flight the displays
// show: spd (m/s), warp (the factor), spool, impulse, world, height (m), dest, distance (m), helm, orbit=1.
// From code: V.bridge({ yaw, pitch, fov, zoom, expo, free, data: { speed, warp, spool, impulse, world, height, dest, distance,
// helm, orbit } }), V.bridgeInfo() (draw calls, triangles, textures), V.B.room (what buildBridge() returned).
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

const [vehMod, plumeMod, padMod, satMod, cabMod] = await Promise.all([
  load('../src/space/vehicles.js'), load('../src/space/plume.js'), load('../src/space/pad.js'), load('../src/space/satmodels.js'), load('../src/space/cabin.js'),
]);

const q = new URLSearchParams(location.search), num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
const S = {
  vehicle: q.get('v') || (q.has('sat') ? 'none' : 'saturnv'), pad: q.get('pad') || '', sat: q.get('sat') || '',
  stage: num('stage', 0), throttle: num('throttle', 0), pressure: num('pressure', 1), time: num('time', 0), t: num('t', -10),
  night: num('night', 0), light: q.get('light') || 'studio', bloom: num('bloom', 1), trail: num('trail', 0), speed: num('speed', 0),
  warp: num('warp', 0), impulse: num('impulse', 0), flash: num('flash', 0), earth: num('earth', 1.1),
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
const earthshine = new THREE.DirectionalLight(new THREE.Color(0.55, 0.72, 1.0), 0); earthshine.position.set(100, -500, 150); scene.add(earthshine);       // the sunlit Earth under the starship (v=enterprise in the space rig; earth=0 takes it away)
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
  if (ship) {
    // a 640 m ship: a wider shadow, and in space the game's own sunlight (4.9) and eye (which opens in the dark)
    sun.position.copy(SUN_DIR).multiplyScalar(1200); Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 100, far: 2400 }); sun.shadow.camera.updateProjectionMatrix();
    renderer.toneMappingExposure = space ? 0.64 * (1.25 + 1.5 * n * n) : 0.7;
    if (space) sun.intensity = 4.9 * (1 - n);
    earthshine.intensity = space ? S.earth * (1 - n) : 0;
  } else if (sun.shadow.camera.right !== 180) { Object.assign(sun.shadow.camera, { left: -180, right: 180, top: 220, bottom: -60, near: 10, far: 1500 }); sun.shadow.camera.updateProjectionMatrix(); renderer.toneMappingExposure = 0.7; earthshine.intensity = 0; }
  hemi.intensity = space ? 0 : day ? 0.3 * (1 - 0.95 * n) : 0.2; amb.intensity = space ? 0.03 : 0;
}

// ---------------------------------------------------------------- what is on stage
let vehicle = null, pad = null, sat = null, plume = null, trail = null, built = {};
let ship = null, shipMod = S.vehicle === 'enterprise' ? await load('../src/space/model-enterprise.js') : null;          // the starship: not a launch vehicle, so it has a slot of its own
let bridgeMod = S.vehicle === 'bridge' ? await load('../src/space/bridge-enterprise.js') : null;                          // its bridge: a room, seen from the captain's chair (B, below)
const spentBits = [];
function clear(o) { if (!o) return; (o.root || o.group || o.object).removeFromParent(); o.dispose && o.dispose(); }
function rebuild() {
  leaveCabin(); leaveBridge();
  clear(vehicle); clear(pad); clear(sat); clear(plume); clear(trail); clear(ship); ship = null;
  for (const b of spentBits.splice(0)) b.removeFromParent();
  vehicle = pad = sat = plume = trail = null; built = {};
  const time = (name, fn) => { const t0 = performance.now(); try { const r = fn(); built[name] = +(performance.now() - t0).toFixed(1); return r; } catch (e) { fail(name, e); return null; } };
  if (S.vehicle === 'enterprise') { if (shipMod) { ship = time('ship', () => shipMod.buildEnterprise()); if (ship) scene.add(ship.root); } }
  else if (S.vehicle === 'bridge') { if (bridgeMod) enterBridge(time('bridge', () => bridgeMod.buildBridge())); }
  else if (S.vehicle && S.vehicle !== 'none' && vehMod) { vehicle = time('vehicle', () => vehMod.buildVehicle(S.vehicle)); if (vehicle) scene.add(vehicle.root); }
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
  if (ship) ship.update(dt, { time: S.time, impulse: S.impulse, warp: S.warp, night: S.night, flash: S.flash });
  if (B.room) { try { B.room.update(dt, { time: S.time, exposure: B.expo, ...B.data }); } catch (e) { fail('bridge.update', e); leaveBridge(); } }
  if (C.on && C.cabin) {
    if (C.run) C.t += dt;
    C.s = { ...flight(C.t, S.vehicle), time: S.time, night: S.night, lit: C.lit, sunDir: C.sun || SUN_DIR, ...C.data };
    try { C.cabin.update(dt, C.s); } catch (e) { fail('cabin.update', e); C.on = false; }
  }
}

// ---------------------------------------------------------------- the crew cabin
const C = { on: false, cabin: null, yaw: 0, pitch: 0, zoom: 1, fov: 0, t: -8, run: true, lit: 1, sun: null, data: {}, hidden: null, s: null, light: 'daylight', free: false, ms: 0 };
const earth = new THREE.Mesh(new THREE.SphereGeometry(6.371e6, 96, 48), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, fog: false }));
{
  const c = document.createElement('canvas'); c.width = 1024; c.height = 512; const g = c.getContext('2d');
  g.fillStyle = '#1d4f9c'; g.fillRect(0, 0, 1024, 512);
  let sd = 7; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${rnd() < 0.3 ? '70,110,60' : '250,250,250'},${0.1 + rnd() * 0.35})`; g.beginPath(); g.ellipse(rnd() * 1024, rnd() * 512, 8 + rnd() * 70, 4 + rnd() * 22, rnd() * 3, 0, 7); g.fill(); }
  earth.material.map = new THREE.CanvasTexture(c); earth.material.map.colorSpace = THREE.SRGBColorSpace;
  earth.position.set(0, 1.2e6, -6.6e6); earth.visible = false; earth.frustumCulled = false; scene.add(earth);
}
const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** A scripted flight to a 115 mile orbit, as the fields the game's mission.js gives a cabin. */
function flight(t, id) {
  const ss = id === 'starship', T = ss ? 520 : 700, cuts = ss ? [[0, 162], [168, T]] : [[0, 161], [166, 548], [553, T]], names = ss ? ['Super Heavy', 'Ship'] : ['S-IC', 'S-II', 'S-IVB', 'CSM'];
  const at = (tt) => {
    const f = Math.max(0, Math.min(1, tt / T));
    return { alt: 185000 * (1 - Math.pow(1 - f, 2.3)) + (tt > T ? 3000 * Math.sin((tt - T) / 860) : 0), so: 408 + (7793 - 408) * Math.pow(f, 1.55), pitch: tt < 12 ? 90 : 90 * Math.pow(1 - sm(12 / T, 1, f), 1.6) };
  };
  if (t < 0) return { met: -1, throttle: t > -3 ? 1 : 0, thrust: t > -3 ? (t + 3) / 3 : 0, stage: 0, stageName: names[0], stages: names.length, alt: 0, vs: 0, speedSurf: 0, speedOrb: 408, pitch: 90, hdg: 72, roll: 0, gLoad: 1, mach: 0, q: 0, ap: 0, pe: -6.36e6, tAp: NaN, tPe: NaN, body: 'earth', warp: 1, autopilot: true, sas: 'hold', pilot: null, landed: true, held: true };
  const a = at(t), b = at(t + 0.5), f = Math.min(1, t / T), orbit = t >= T;
  let stage = cuts.findIndex(([, e]) => t < e + 4); if (stage < 0) stage = cuts.length - 1;
  const [s0, s1] = cuts[stage], burning = !orbit && t >= s0 && t < s1, k = Math.max(0, Math.min(1, (t - s0) / (s1 - s0)));
  const g = burning ? (ss ? [1.5 + 1.9 * k, 0.8 + 2.7 * k * k][stage] : [1.2 + 2.75 * k * k, 0.85 + 0.95 * k, 0.52 + 0.2 * k][stage]) : 0;
  const surf = Math.max(0, a.so - 408 * Math.cos(a.pitch * Math.PI / 180) * (1 - f * 0.1)), rho = 1.225 * Math.exp(-a.alt / 7200);
  const ap = orbit ? 191000 : Math.min(191000, a.alt + (a.so * a.so) / 19.6 * 0.02 * Math.pow(f, 3) + 60000 * f * f), pe = orbit ? 183000 : -6.36e6 + (6.36e6 + 183000) * Math.pow(f, 7);
  return {
    met: t, throttle: burning ? 1 : 0, thrust: burning ? 1 : 0, stage, stageName: names[stage], stages: names.length, alt: a.alt, vs: (b.alt - a.alt) / 0.5, speedSurf: surf, speedOrb: a.so,
    pitch: a.pitch + (orbit ? 0 : 0.6 * Math.sin(t * 0.7)), hdg: 72 + 14 * f + (t < 30 ? 0 : 0.4 * Math.sin(t * 0.31)), roll: t > 12 && t < 30 ? 18 * Math.sin(((t - 12) / 18) * Math.PI) : 0.5 * Math.sin(t * 0.45),
    gLoad: g, mach: surf / 300, q: 0.5 * rho * surf * surf, ap, pe, tAp: orbit ? 2650 - ((t - T) % 5300) / 2 : (T - t) * 0.6, tPe: orbit ? 5300 - ((t - T) % 5300) : NaN, body: 'earth', warp: 1, autopilot: !orbit, sas: orbit ? 'prograde' : 'hold', pilot: null, landed: false, held: false,
  };
}
function leaveCabin() {
  if (!C.on && !C.cabin) return;
  if (C.cabin) { C.cabin.root.removeFromParent(); try { C.cabin.dispose(); } catch (e) { fail('cabin.dispose', e); } C.cabin = null; }
  for (const o of C.hidden || []) o.visible = true; C.hidden = null; C.on = false;
  earth.visible = false; controls.enabled = true; renderer.toneMappingExposure = 0.7; camera.near = 0.5; camera.far = 60000; camera.fov = 35; camera.updateProjectionMatrix();
}
function enterCabin(o = {}) {
  if (o.vehicle && o.vehicle !== S.vehicle) V.set({ vehicle: o.vehicle });
  if (!vehicle || !cabMod) return;
  if (!C.cabin) {
    const t0 = performance.now();
    try { C.cabin = cabMod.buildCabin(S.vehicle); } catch (e) { fail('buildCabin', e); return; }
    C.ms = +(performance.now() - t0).toFixed(1); built.cabin = C.ms;
    vehicle.root.add(C.cabin.root); C.yaw = 0; C.pitch = 0; C.zoom = 1;
    C.hidden = vehicle.root.children.filter((x) => x !== C.cabin.root && x.visible && !(plume && x === plume.group)); for (const x of C.hidden) x.visible = false;
  }
  C.on = true; controls.enabled = false;
  for (const k of ['t', 'run', 'lit', 'free']) if (k in o) C[k] = o[k];
  if ('yaw' in o) C.yaw = (o.yaw * Math.PI) / 180; if ('pitch' in o) C.pitch = (o.pitch * Math.PI) / 180;
  if ('fov' in o) C.fov = o.fov; if ('zoom' in o) C.zoom = o.zoom;
  if ('sun' in o) C.sun = o.sun ? new THREE.Vector3(...o.sun).normalize() : null;
  if ('data' in o) C.data = o.data || {};
  if (o.light) C.light = o.light;
  S.light = C.light === 'space' ? 'space' : 'day'; S.night = C.light === 'night' ? 1 : 0; earth.visible = C.light === 'space';
  if (C.sun) { SUN_DIR.copy(C.sun); S.sunEl = 0; }
  applyLight();
}
const _m1 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _e1 = new THREE.Euler(), _z = new THREE.Vector3();
function cabinCamera() {
  const cb = C.cabin, R = cb.reach || { yaw: 1.5, up: 0.8, down: 0.8 };
  if (!C.free) { C.yaw = Math.max(-R.yaw, Math.min(R.yaw, C.yaw)); C.pitch = Math.max(-R.down, Math.min(R.up, C.pitch)); }
  vehicle.root.updateMatrixWorld(true);
  camera.position.copy(cb.eye).applyMatrix4(vehicle.root.matrixWorld);
  _m1.lookAt(_z.set(0, 0, 0), cb.look, cb.up); camera.quaternion.setFromRotationMatrix(_m1).multiply(_q1.setFromEuler(_e1.set(C.pitch, C.yaw, 0, 'YXZ'))).premultiply(vehicle.root.quaternion);
  // the game's eye opens as the light goes (sky.js on the ground, cosmos.js in space): stand in for it here
  renderer.toneMappingExposure = 0.7 * (C.light === 'space' ? 1.25 + 1.5 * (1 - C.lit) * (1 - C.lit) : 1 + 2.8 * S.night);
  camera.fov = Math.max(12, Math.min(100, (C.fov || cb.fov || 62) * C.zoom)); camera.near = 0.05; camera.far = C.light === 'space' ? 2e7 : 60000; camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- the starship's bridge (v=bridge)
// The room alone, from the captain's chair. Behind it a bright painted sky with a planet dead ahead, so that an opening in the
// room (the main viewer, the skylight) is plainly an opening. B.data is the flight its displays show.
const B = {
  room: null, sky: null, yaw: num('yaw', 0), pitch: num('pitch', 0), zoom: 1, fov: num('fov', 0), expo: num('expo', 1.25), free: false,
  data: { speed: num('spd', 7660), warp: S.vehicle === 'bridge' ? S.warp : 0, spool: num('spool', 0), impulse: S.vehicle === 'bridge' ? S.impulse : 0, world: q.get('world') || 'Earth', height: num('height', 408000), dest: q.get('dest'), distance: num('distance', 1.28e12), helm: q.get('helm'), orbit: q.has('orbit') },
};
function bridgeSky() {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 1024; const g = c.getContext('2d');
  const gd = g.createLinearGradient(0, 0, 0, 1024); gd.addColorStop(0, '#2b6fff'); gd.addColorStop(0.35, '#ff5fa8'); gd.addColorStop(0.5, '#ffd24a'); gd.addColorStop(0.65, '#3fd68a'); gd.addColorStop(1, '#15306b'); g.fillStyle = gd; g.fillRect(0, 0, 2048, 1024);
  let sd = 11; const rnd = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  for (let i = 0; i < 90; i++) { g.fillStyle = `hsla(${Math.floor(rnd() * 360)},90%,60%,0.5)`; g.beginPath(); g.ellipse(rnd() * 2048, rnd() * 1024, 20 + rnd() * 120, 10 + rnd() * 60, rnd() * 3, 0, 7); g.fill(); }
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 3;
  for (let k = 0; k <= 24; k++) { g.beginPath(); g.moveTo((k * 2048) / 24, 0); g.lineTo((k * 2048) / 24, 1024); g.stroke(); }
  for (let k = 1; k < 12; k++) { g.beginPath(); g.moveTo(0, (k * 1024) / 12); g.lineTo(2048, (k * 1024) / 12); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Group(), dome = new THREE.Mesh(new THREE.SphereGeometry(20000, 48, 24), new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false }));
  const pc = document.createElement('canvas'); pc.width = 512; pc.height = 256; const pg = pc.getContext('2d');
  for (let y = 0; y < 256; y += 8) { pg.fillStyle = `hsl(${28 + 14 * Math.sin(y * 0.11)},${55 + 25 * Math.sin(y * 0.07)}%,${52 + 22 * Math.sin(y * 0.23)}%)`; pg.fillRect(0, y, 512, 8); }
  const pt = new THREE.CanvasTexture(pc); pt.colorSpace = THREE.SRGBColorSpace;
  const planet = new THREE.Mesh(new THREE.SphereGeometry(2600, 64, 32), new THREE.MeshBasicMaterial({ map: pt, fog: false })); planet.position.set(900, 500, -9000); planet.rotation.z = 0.4;
  for (const m of [dome, planet]) m.frustumCulled = false;
  sky.add(dome, planet);
  return sky;
}
function leaveBridge() {
  if (!B.room) return;
  B.room.root.removeFromParent(); try { B.room.dispose(); } catch (e) { fail('bridge.dispose', e); } B.room = null;
  if (B.sky) B.sky.visible = false;
  controls.enabled = true; renderer.toneMappingExposure = 0.7; camera.near = 0.5; camera.far = 60000; camera.fov = 35; camera.updateProjectionMatrix();
}
function enterBridge(room) {
  if (!room) return;
  B.room = room; scene.add(room.root);
  if (!B.sky) { B.sky = bridgeSky(); scene.add(B.sky); } B.sky.visible = true;
  controls.enabled = false; if (!q.has('light')) S.light = 'space';
}
function bridgeCamera() {
  const r = B.room, R = r.reach || { yaw: 2.6, up: 1.1, down: 0.9 }, D = Math.PI / 180;
  if (!B.free) { B.yaw = Math.max(-R.yaw / D, Math.min(R.yaw / D, B.yaw)); B.pitch = Math.max(-R.down / D, Math.min(R.up / D, B.pitch)); }
  r.root.updateMatrixWorld(true);
  camera.position.copy(r.eye).applyMatrix4(r.root.matrixWorld);
  camera.quaternion.setFromEuler(_e1.set(B.pitch * D, -B.yaw * D, 0, 'YXZ')).premultiply(r.root.getWorldQuaternion(_q1));          // the game's own head: pitch, then yaw about the ship's up (turn V.B.room.root to turn the ship)
  renderer.toneMappingExposure = 0.64 * B.expo;                                         // the game's picture in space (mission.js)
  camera.fov = Math.max(5, Math.min(110, (B.fov || r.fov || 55) * B.zoom)); camera.near = 0.06; camera.far = 60000; camera.updateProjectionMatrix();
}

function resize() {
  const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight, pr = renderer.getPixelRatio();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setSize(w, h, false); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function draw() {
  resize(); if (C.on && C.cabin) cabinCamera(); else if (B.room) bridgeCamera(); else controls.update();
  renderer.info.reset();
  if (S.bloom) composer.render(); else renderer.render(scene, camera);
  const st = vehicle ? vehicle.stages[Math.min(S.stage, vehicle.stages.length - 1)] : null;
  hud.textContent = `${S.vehicle}${pad ? ' + pad' : ''}${S.sat ? ' ' + S.sat : ''}  light ${S.light}  night ${S.night}${ship ? `  warp ${S.warp}  impulse ${S.impulse}  flash ${S.flash}` : ''}\n` +
    (st ? `stage ${S.stage} ${st.name} (${st.propellant})  throttle ${S.throttle.toFixed(2)}  pressure ${S.pressure.toFixed(3)}  time ${S.time.toFixed(1)}  t ${S.t.toFixed(1)}\n` : '') +
    `build ms ${JSON.stringify(built)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}` +
    (trail && trail.count ? `\nsmoke ${trail.count} puffs  overdraw ${trail.overdraw.toFixed(1)} screens  quality ${S.quality}` : '') + (A.on ? `  T${A.lifted ? '+' + A.met.toFixed(1) : '-'}  height ${A.y.toFixed(0)} m  ${A.vy.toFixed(0)} m/s` : '') +
    (C.on && C.s ? `\ncabin (${C.light})  T${C.t < 0 ? '' : '+'}${C.t.toFixed(1)}  ${C.s.stageName}  alt ${(C.s.alt / 1000).toFixed(1)} km  ${C.s.speedOrb.toFixed(0)} m/s  pitch ${C.s.pitch.toFixed(1)}  g ${C.s.gLoad.toFixed(2)}  head ${(C.yaw * 57.3).toFixed(0)}/${(C.pitch * 57.3).toFixed(0)}  fov ${camera.fov.toFixed(0)}` : '') +
    (B.room ? `\nbridge  head ${B.yaw.toFixed(0)}/${B.pitch.toFixed(0)}  fov ${camera.fov.toFixed(0)}  expo ${B.expo}  warp ${B.data.warp}  spool ${B.data.spool}  impulse ${B.data.impulse}` : '');
}
renderer.info.autoReset = false;

const V = (window.V = {
  S, THREE, scene, camera, controls, renderer, sun, SUN_DIR,
  get vehicle() { return vehicle; }, get pad() { return pad; }, get sat() { return sat; }, get plume() { return plume; }, get trail() { return trail; }, get built() { return built; }, get ship() { return ship; },
  set(o = {}) {
    const re = ['vehicle', 'pad', 'sat'].some((k) => k in o && o[k] !== S[k]);
    Object.assign(S, o);
    if (S.vehicle === 'enterprise' && !shipMod) { load('../src/space/model-enterprise.js').then((m) => { shipMod = m; rebuild(); applyLight(); }); return V; }
    if (S.vehicle === 'bridge' && !bridgeMod) { load('../src/space/bridge-enterprise.js').then((m) => { bridgeMod = m; rebuild(); applyLight(); }); return V; }
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
    const parts = { vehicle: vehicle && vehicle.root, pad: pad && pad.root, sat: sat && sat.root, plume: plume && plume.group, trail: trail && trail.object, ship: ship && ship.root };
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
  /** The view from the commander's seat (see the top of the file). */
  cabin(o = {}) { if (o.off) leaveCabin(); else enterCabin(o); return V; },
  get C() { return C; },
  /** The starship's bridge (v=bridge): turn the head, set the lens and the exposure, give the displays a flight to show. */
  bridge(o = {}) {
    for (const k of ['yaw', 'pitch', 'fov', 'zoom', 'expo', 'free']) if (k in o) B[k] = o[k];
    if (o.data) Object.assign(B.data, o.data);
    return V;
  },
  get B() { return B; },
  /** Draw calls and triangles of the bridge alone (per mesh too), its textures and how long it took to build. */
  bridgeInfo() {
    if (!B.room) return null;
    const sky = B.sky.visible; B.sky.visible = false; renderer.info.reset(); renderer.render(scene, camera);
    const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles; B.sky.visible = sky;
    const tex = new Map(), meshes = {};
    B.room.root.traverse((x) => { if (x.isMesh) meshes[x.name] = x.geometry.attributes.position.count / 3; for (const m of x.material ? [].concat(x.material) : []) for (const k of Object.keys(m)) { const t = m[k]; if (t && t.isTexture && t.image) tex.set(t.uuid, [t.image.width, t.image.height, t.generateMipmaps ? 1.34 : 1]); } });
    let bytes = 0; for (const [w, h, k] of tex.values()) bytes += w * h * 4 * k;
    return { calls, triangles, meshes, textures: tex.size, textureMB: +(bytes / 1048576).toFixed(1), sizes: [...tex.values()].map((x) => x[0] + 'x' + x[1]).join(' '), buildMs: built.bridge, programs: renderer.info.programs.filter((p) => p.diagnostics && !p.diagnostics.runnable).length };
  },
  flight,
  /** Draw calls and triangles of the cabin alone, its textures and how long it took to build. */
  cabinInfo() {
    if (!C.cabin) return null;
    const keep = []; scene.traverse((x) => { if ((x.isMesh || x.isPoints || x.isLine) && x.visible) { let p = x, inside = false; while (p) { if (p === C.cabin.root) inside = true; p = p.parent; } if (!inside) { keep.push(x); x.visible = false; } } });
    const smE = renderer.shadowMap.enabled; renderer.shadowMap.enabled = false; renderer.info.reset(); renderer.render(scene, camera);
    const calls = renderer.info.render.calls, triangles = renderer.info.render.triangles; renderer.shadowMap.enabled = smE; for (const x of keep) x.visible = true;
    const tex = new Map(); let lights = 0;
    C.cabin.root.traverse((x) => { if (x.isLight) lights++; for (const m of x.material ? [].concat(x.material) : []) for (const k of Object.keys(m)) { const t = m[k]; if (t && t.isTexture && t.image) tex.set(t.uuid, [t.image.width, t.image.height]); } });
    let bytes = 0; for (const [w, h] of tex.values()) bytes += w * h * 4 * 1.34;
    return { calls, triangles, textures: tex.size, textureMB: +(bytes / 1048576).toFixed(1), sizes: [...tex.values()].map((x) => x.join('x')).join(' '), lights, buildMs: C.ms, info: C.cabin.info };
  },
});
// the head turns with a drag and the lens zooms with the wheel while in the cabin
{
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (C.on || B.room) drag = [e.clientX, e.clientY]; });
  addEventListener('pointerup', () => { drag = null; });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (B.room) { const k = camera.fov / canvas.clientHeight; B.yaw -= (e.clientX - drag[0]) * k; B.pitch += (e.clientY - drag[1]) * k; drag = [e.clientX, e.clientY]; return; }
    if (!C.on) return; const k = (camera.fov * Math.PI / 180) / canvas.clientHeight; C.yaw += (e.clientX - drag[0]) * k; C.pitch += (e.clientY - drag[1]) * k; drag = [e.clientX, e.clientY];
  });
  canvas.addEventListener('wheel', (e) => {
    if (B.room) { B.zoom = Math.max(0.15, Math.min(1.6, B.zoom * (e.deltaY > 0 ? 1.08 : 0.926))); e.preventDefault(); }
    else if (C.on) { C.zoom = Math.max(0.3, Math.min(1.5, C.zoom * (e.deltaY > 0 ? 1.08 : 0.926))); e.preventDefault(); }
  }, { passive: false });
}

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
  else if (k === 'c') V.cabin(C.on ? { off: true } : {});
  else if (k === 'k' && C.on) V.cabin({ light: { daylight: 'space', space: 'night', night: 'daylight' }[C.light] });
  else if (k === ' ') S.paused = !S.paused;
});

rebuild(); applyLight();
if (num('launch', 0)) V.launch();
if (q.has('cabin')) V.cabin({ light: q.get('cabin') === '1' ? 'daylight' : q.get('cabin'), t: num('ct', -8) });
{
  const h = vehicle ? vehicle.height : sat ? sat.radius : 100, base = pad && vehicle ? pad.standY : 0;
  if (ship) V.view({ target: [0, -30, 0], az: 145, el: 22, dist: 1050 });
  else if (sat && !vehicle) V.view({ target: [0, 0, 0], az: 35, el: 20, dist: sat.radius * 3.4 });
  else V.view({ target: [0, base + h * 0.5, 0], az: 35, el: 6, dist: h * 2.1 });
}
let last = performance.now();
(function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!S.paused) step(dt);
  draw();
})(last);
