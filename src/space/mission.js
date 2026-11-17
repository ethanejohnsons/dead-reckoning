// A rocket flight: what main.js runs instead of the airplane when the craft chosen is a launch vehicle.
//
// The rocket lives in the inertial frame of frames.js (rocket.js); the game's world is a flat window of the
// Earth. This module stands between them:
//   - Near the ground the rocket is shown in the game's own scene, through the weather, at the world position
//     of its latitude, longitude and height; the game's airplane object is driven as a stand-in at the same
//     place so that everything that follows "the aircraft" (weather, sky, scenery streaming, rain) follows the rocket.
//   - Between 24 and 36 km up, the view from space (cosmos.js) is faded in over that picture; above, it is the
//     only thing drawn, and the game's window of the world is left where it was until the craft comes back down.
//   - `mix` says which: 0 the ground view, 1 the view from space.
// It also owns the vehicle's model, flame and smoke, the pad, dropped stages, the cameras (chase, onboard and
// the orbit map), time acceleration, the autopilot to orbit, and the rocket's panel on the HUD.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { clamp, smoothstep } from '../core/noise.js';
import { groundHeight } from '../world/terrain.js';
import { toWorld, toLatLon, WORLD_HALF, REGION } from '../world/geo.js';
import { Rocket, guidance, airPressure, ROCKETS } from './rocket.js';
import { makeClock, RE, RM, D2R, ATMO_TOP, MU_E, enu, moonPos, moonVel, worldToRenderQuat, eciToGeo, len, dot } from './frames.js';
import { gravity } from './orbit.js';
import { Cosmos } from './cosmos.js';
import { OrbitMap } from './orbitmap.js';
import { Satellites } from './satellites.js';
import { RocketSound } from './rocketsound.js';
import { ReentryGlow } from './reentry.js';
import { plan as planTransfer, planPath, pass as moonPass, TransferPilot } from './transfer.js';

const MIX_LO = 24000, MIX_HI = 36000;     // the band (m) over which the view from space takes over
const STEP = 1 / 60;
export const WARPS = [1, 2, 4, 10, 50, 100, 1000, 10000, 100000];
const PHYS_WARP = 2;                      // index of the fastest rate the engines and the air can be flown at
const $ = (id) => document.getElementById(id);

// The models are another module's business; until they have loaded (or if one fails) a plain stand-in flies.
const lazy = import.meta.glob(['./vehicles.js', './plume.js', './pad.js', './satmodels.js']);
const mods = {};
export async function loadSpaceAssets() {
  await Promise.all(Object.entries(lazy).map(async ([k, f]) => { try { mods[k.slice(2, -3)] = await f(); } catch (e) { console.warn(`${k} did not load:`, e.message); } }));
  return mods;
}
function standIn(id) {
  const h = id === 'starship' ? 121 : 110, r = id === 'starship' ? 4.5 : 5, root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.6, metalness: id === 'starship' ? 0.8 : 0 });
  const n = ROCKETS[id].stages.length, stages = [];
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group(), y0 = (h * i) / n, y1 = (h * (i + 1)) / n;
    const m = new THREE.Mesh(i === n - 1 ? new THREE.ConeGeometry(r, y1 - y0, 24) : new THREE.CylinderGeometry(r, r, y1 - y0, 24), mat);
    m.position.y = (y0 + y1) / 2; g.add(m); root.add(g);
    stages.push({ name: ROCKETS[id].stages[i].name, group: g, bottomY: y0, topY: y1, nozzles: [new THREE.Vector3(0, y0, 0)], nozzleRadius: r * 0.5, propellant: 'kerolox' });
  }
  return { id, root, height: h, radius: r, stages, setStage(k) { stages.forEach((s, i) => { s.group.visible = i >= k; }); }, spent(k) { const o = stages[k].group.clone(); o.visible = true; return o; }, update() {}, dispose() { mat.dispose(); } };
}

const B = new Array(9), rel = [0, 0, 0], vrel = [0, 0, 0], rm = [0, 0, 0], mv = [0, 0, 0], tmpA = [0, 0, 0], geo = {}, gacc = [0, 0, 0];
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), m1 = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
const miles = (m) => m / 1609.344;
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export class Mission {
  /** g: the game's objects (see main.js): { S, scene, camera, renderer, clouds, sky, weather, input, ac, wx, toast, sound, restart, tier } */
  constructor(g) {
    this.g = g;
    this.active = false;
    this.rk = new Rocket('saturnv');
    this.clock = makeClock(0, 80, 12, 0.375);
    this.cosmos = new Cosmos(g.renderer, g.tier());
    this.sats = new Satellites(this.cosmos, mods);
    this.map = new OrbitMap(this.cosmos, this);
    this.vehicle = null; this.plume = null; this.trail = null; this.pad = null; this.site = null;
    this.spent = [];                       // dropped stages still in sight: { obj, r, v, q (local world), spin, age }
    this.mix = 0; this.groundOK = true;
    this.warp = 0; this.autopilot = false; this.view = 'chase'; this.mapOpen = false;
    this.cam = { yaw: -2.2, pitch: -0.1, dist: 1, mapYaw: 0.6, mapPitch: 0.35, mapDist: 4 * RE, focus: 'body' };
    this.env = { clock: this.clock, ground: (lat, lon) => this.groundAt(lat, lon), wind: [0, 0, 0] };
    this.ctl = { pitch: 0, yaw: 0, roll: 0 };
    this.eye = [0, 0, 0]; this.eyeQuat = new THREE.Quaternion();          // the camera in the inertial frame
    this.qLocal = new THREE.Quaternion(); this.posW = new THREE.Vector3(); this.baseW = new THREE.Vector3();
    this.said = {}; this.endT = 0; this.uiT = 0; this.maxQ = 0;
    this.snd = new RocketSound(); this.ambience = 1; this.camDist = 300;
    this.keys();
  }

  get ready() { return !!mods.vehicles; }

  /** Terrain height (m above the sphere) under a place, where the game's window of the world holds it. */
  groundAt(lat, lon) {
    if (!this.groundOK) return 0;
    const p = toWorld(lat, lon);
    return Math.abs(p.x) < WORLD_HALF && Math.abs(p.z) < WORLD_HALF ? Math.max(groundHeight(p.x, p.z), 0) : 0;
  }

  // ------------------------------------------------------------------ start and end

  /** Stand a vehicle on a pad at a site ({ lat, lon, name, az }). The game's window must already hold the place. */
  start(vehicleId, site) {
    const g = this.g, id = ROCKETS[vehicleId] ? vehicleId : 'saturnv';
    this.stop(true);
    this.site = site; this.active = true;
    this.clock = this.env.clock = makeClock(site.lon, g.sky.day, g.weather.hour, g.sky.moonPhase);
    this.vehicle = mods.vehicles ? mods.vehicles.buildVehicle(id) : standIn(id);
    this.vehicle.setStage(0);
    this.pad = mods.pad ? mods.pad.buildPad(id) : null;
    this.plume = mods.plume ? new mods.plume.Plume() : null;
    this.trail = mods.plume ? new mods.plume.ExhaustTrail() : null;
    if (this.trail) { this.trail.setQuality?.(g.tier()); this.trail.terrainAt = groundHeight; this.trailTier = g.tier(); }      // (the land the pad cloud rolls out over, and how many puffs it may spend)
    if (this.plume) this.vehicle.root.add(this.plume.group);
    this.glow = new ReentryGlow(); this.vehicle.root.add(this.glow.mesh);
    if (this.trail) g.scene.add(this.trail.object);
    g.scene.add(this.vehicle.root);
    // The pad stands on the highest ground under its hardstand, so no hillock comes up through the concrete (its walls reach down the rest).
    const p = toWorld(site.lat, site.lon);
    let gy = Math.max(groundHeight(p.x, p.z), 0);
    if (this.pad) for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) gy = Math.max(gy, groundHeight(p.x + i * 80, p.z + j * 80));
    if (this.pad) { this.pad.root.position.set(p.x, gy, p.z); g.scene.add(this.pad.root); }
    g.cities?.setKeepClear(this.pad ? [[p.x - 420, p.z - 420, p.x + 420, p.z + 420]] : []);      // the map's own buildings make way for the pad's
    this.padY = gy; this.standY = this.pad?.standY || 0;
    this.groundOK = true;
    this.rk.setSpec(id);
    this.rk.placeOnPad(this.clock, 0, site.lat, site.lon, gy + this.standY, site.az ?? 90);
    this.rk.roll = ((((site.az ?? 90) - 180) % 360) + 360) % 360;        // on the pad the vehicle's +Z side faces south, away from the tower; it rolls onto its heading after liftoff
    this.rk.baseY = 0;
    this.azimuth = site.az ?? 90;
    this.warp = 0; this.autopilot = false; this.view = 'chase'; this.setMap(false);
    this.cam.yaw = (this.azimuth - 55) * D2R; this.cam.pitch = -0.06; this.cam.dist = 1;
    this.said = {}; this.endT = 0; this.maxQ = 0; this.mix = 0; this.pilot = null; this.xfer = null;
    this.sats.reset(this.clock, site);
    // Shadows: the vehicle's on the ground and on itself, the pad's structures' on the ground.
    this.shadows();
    if (this.pad) { this.pad.root.traverse((o) => { if (o.isMesh && !o.material?.transparent) o.receiveShadow = true; }); this.padCaster = this.pad.root; g.sunShadows.casterRoots.push(this.pad.root); }
    g.clouds.fx.subject = this.vehicle.root; g.clouds.fx.glass = null; g.clouds.fx.exhaust = null; g.clouds.subjBox = null;
    g.input.look.yaw = 0; g.input.look.pitch = 0; g.input.zoom = g.input.zoomTarget = 1;
    this.frame(0);
  }

  /** Skip the climb: put the craft in a low orbit of the Earth over the launch site, or of the Moon, with the stages that got it there gone. */
  startAloft(where) {
    const rk = this.rk, n = rk.spec.stages.length, site = this.site;
    if (where === 'moon') rk.placeAtMoon(this.clock, 0, 110000);
    else rk.placeInOrbit(this.clock, 0, 250000, Math.max(Math.abs(site.lat), 5), site.lon - 8);
    rk.stage = where === 'moon' ? n - 1 : Math.max(n - 2, 1);
    rk.roll = 0;
    this.vehicle.setStage(rk.stage); rk.baseY = this.vehicle.stages[rk.stage].bottomY;
    this.shadows();
    if (this.pad) this.pad.root.visible = false;
    this.said.ignite = this.said.tower = this.said.mach = this.said.maxq = this.said.space = this.said.orbit = this.said.lunar = true;
    this.cam.pitch = -0.3; this.cam.dist = 1.6;
    this.frame(0);
  }

  /** Point the game's shadows at the vehicle as it now is (again after a stage has gone: the map is fitted to its size). */
  shadows() {
    const g = this.g, v = this.vehicle, half = Math.max(40, (v.height - (this.rk.baseY || 0)) * 0.62);
    v.root.traverse((o) => { if (o.isMesh && !o.material?.transparent && o.material?.isMeshStandardMaterial) { o.castShadow = true; o.receiveShadow = true; } });
    g.sunShadows.setAircraft(v.root, [v.root], []);
    const sh = g.sky.sun.shadow, c = sh.camera;                 // three.js's own map: what the vehicle's materials read (the tower's shadow on the stack, the stack's on itself)
    c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.updateProjectionMatrix(); sh.normalBias = 0.25; this.shadowHalf = half;
  }

  /** Take the rocket and everything of its flight out of the game. */
  stop(restarting = false) {
    const g = this.g;
    if (this.vehicle) { g.scene.remove(this.vehicle.root); this.vehicle.dispose?.(); this.vehicle = null; }
    if (this.pad) { g.scene.remove(this.pad.root); this.pad.dispose?.(); this.pad = null; }
    if (!restarting) g.cities?.setKeepClear([]);
    if (this.plume) { this.plume.dispose?.(); this.plume = null; }
    if (this.glow) { this.glow.dispose(); this.glow = null; }
    if (this.padCaster) { const cr = g.sunShadows.casterRoots, i = cr.indexOf(this.padCaster); if (i >= 0) cr.splice(i, 1); this.padCaster = null; }
    if (this.trail) { g.scene.remove(this.trail.object); this.trail.dispose?.(); this.trail = null; }
    for (const s of this.spent) g.scene.remove(s.obj);
    this.spent.length = 0;
    this.cosmos.near.children.length = 5;            // (its own lights stay)
    this.snd.silence();
    this.setMap(false);
    this.active = false; this.mix = 0; g.clouds.mixIn = null;
  }

  // ------------------------------------------------------------------ keys

  keys() {
    addEventListener('keydown', (e) => {
      const g = this.g;
      if (!this.active || g.S.mode !== 'flying' || g.S.paused || e.repeat) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space' && e.target instanceof Element && e.target.closest('button, summary, [role=option], [role=listbox]')) return;
      switch (e.code) {
        case 'Space': this.stageKey(); break;
        case 'KeyZ': this.rk.throttle = 1; this.manual(); break;
        case 'KeyX': this.rk.throttle = 0; this.manual(); break;
        case 'Digit1': this.setSas('hold'); break;
        case 'Digit2': this.setSas('prograde'); break;
        case 'Digit3': this.setSas('retrograde'); break;
        case 'Period': this.setWarp(this.warp + 1); break;
        case 'Comma': this.setWarp(this.warp - 1); break;
        case 'KeyL': this.toggleTransfer(); break;
        case 'KeyN': this.sats.next(); g.toast(this.sats.target ? `Target: ${this.sats.target.name}.` : 'No target.', 3); break;
        case 'Tab': if (this.mapOpen) { e.preventDefault(); this.cycleFocus(); } break;
        default:
      }
    });
  }
  manual() {
    if (this.autopilot) { this.autopilot = false; this.g.toast('Autopilot off. You have control.', 3); }
    if (this.pilot) { this.pilot = null; this.g.toast('Transfer helper off. You have control; the plan stays on the map.', 4); }
  }
  setSas(mode) { this.rk.sas = mode; this.manual(); this.g.toast(mode === 'hold' ? 'Holding attitude.' : mode === 'prograde' ? 'Holding the nose on the direction of travel.' : 'Holding the tail to the direction of travel.', 2.5); }
  /** Space: light the engines and let go, or drop the stage. */
  stageKey() {
    const rk = this.rk;
    if (rk.crashed) return;
    if (rk.landed && rk.held) { rk.held = false; if (rk.throttle < 0.5) rk.throttle = 1; this.say('ignite', 'Ignition. Liftoff!', 3); return; }
    if (rk.landed) { if (rk.throttle < 0.5) rk.throttle = 1; return; }
    this.dropStage();
  }
  dropStage() {
    const rk = this.rk, was = rk.stageNext();
    if (was < 0) { this.g.toast('Nothing left to drop.', 2); return; }
    const v = this.vehicle, name = ROCKETS[rk.id].stages[was].name;
    const obj = v.spent(was);
    v.setStage(rk.stage);
    rk.baseY = v.stages[rk.stage].bottomY;
    this.shadows();
    this.g.scene.add(obj);
    // The dropped stage falls behind: a push back along the axis, and a slow tumble.
    const r = [rk.r[0], rk.r[1], rk.r[2]], vv = [rk.v[0] - rk.nose[0] * 6, rk.v[1] - rk.nose[1] * 6, rk.v[2] - rk.nose[2] * 6];
    this.spent.push({ obj, r, v: vv, q: this.qLocal.clone(), spin: new THREE.Vector3(0.02 + Math.random() * 0.05, 0, 0.03 * (Math.random() - 0.5)), age: 0, pivot: rk.spec.stages[was].pivot });
    this.g.toast(`${name} away. ${ROCKETS[rk.id].stages[rk.stage].name} burning.`, 3);
  }
  toggleAutopilot() {
    const rk = this.rk;
    if (rk.crashed) return;
    if (this.autopilot) { this.manual(); return; }
    const o = rk.orbit(this.clock);
    if (!rk.landed && o.body === 'earth' && o.pe > ATMO_TOP) { this.g.toast('Already in orbit: the autopilot only flies the climb.', 3); return; }
    if (rk.body !== 'earth') { this.g.toast('The autopilot only flies the climb from the Earth.', 3); return; }
    this.autopilot = true; this.setWarp(Math.min(this.warp, PHYS_WARP), true);
    this.g.toast(`Autopilot: flying to orbit, ${Math.round(miles(this.target || 190000))} miles up, heading ${String(Math.round(this.azimuth)).padStart(3, '0')}°.`, 4);
    if (rk.landed) this.say('ignite', 'Ignition. Liftoff!', 3);
  }
  /** L: plan the way to the Moon from this orbit and fly it (transfer.js). Again, or any control input, to take over. */
  toggleTransfer() {
    const rk = this.rk, g = this.g, c = this.clock;
    if (this.pilot) { this.manual(); return; }
    if (rk.crashed) return;
    const o = rk.orbit(c);
    if (rk.landed || rk.body !== 'earth' || !o.bound || o.pe < ATMO_TOP || o.ap > 2e6) { g.toast(rk.body === 'moon' ? 'You are already at the Moon.' : 'The way to the Moon starts from a low orbit of the Earth: G flies you to one.', 5); return; }
    this.autopilot = false;
    const S = rk.stageSpec, accel = (bt) => S.a0 / (1 - (1 - S.a0 / S.a1) * Math.min(bt / S.burn, 1));
    const p = planTransfer(c, rk.t, rk.r, rk.v, accel, rk.burnT);
    if (!p) { g.toast('No way to the Moon could be found from this orbit.', 5); return; }
    this.pilot = new TransferPilot(p);
    this.xfer = { pts: new Float64Array(700 * 4), n: 0 };
    this.xfer.n = planPath(c, rk.t, rk.r, rk.v, p, accel, rk.burnT, this.xfer.pts);
    const wait = p.tBurn - rk.t, days = (p.tArrive - p.tBurn) / 86400;
    g.toast(`To the Moon: a burn of ${Math.round(p.secs / 60)} minutes ${wait > 5400 ? `in ${this.span(wait)}, when the Moon will be crossing the plane of this orbit` : `in ${this.span(wait)}`}, then ${days.toFixed(1)} days of coasting. Time runs fast in between. M shows the plan; any control takes over.`, 10);
  }
  span(s) { return s < 90 ? `${Math.round(s)} seconds` : s < 5400 ? `${Math.round(s / 60)} minutes` : s < 1.5 * 86400 ? `${Math.round(s / 3600)} hours` : `${(s / 86400).toFixed(1)} days`; }
  /** What the transfer helper's pilot just did. */
  pilotSaid(ev) {
    const g = this.g, rk = this.rk, p = this.pilot;
    if (ev === 'burn') g.toast(`Transfer burn: ${Math.round(p.plan.secs / 60)} minutes at full thrust, for the Moon.`, 6);
    else if (ev === 'coast') g.toast(`Engines off. Coasting to the Moon: ${((p.plan.tArrive - rk.t) / 86400).toFixed(1)} days.`, 6);
    else if (ev === 'trimmed') g.toast('Course trimmed for the pass.', 4);
    else if (ev === 'capture') g.toast('Braking into orbit of the Moon.', 5);
    else if (ev === 'done') { const o = rk.orbit(this.clock); g.toast(`In orbit of the Moon: ${fmt(miles(o.pe))} by ${fmt(miles(o.ap))} miles. You have control.`, 9); this.said.lunar = true; this.pilot = null; this.warp = 0; }
    else if (ev === 'lost') { g.toast('The pass of the Moon went wrong. You have control.', 7); this.pilot = null; this.warp = 0; }
  }

  setWarp(i, quiet = false) {
    const rk = this.rk, max = rk.canCoast ? WARPS.length - 1 : PHYS_WARP;
    const n = clamp(i, 0, max);
    if (i > max && !quiet) this.g.toast(rk.landed || rk.throttle > 0 ? 'Time can run faster only with the engines off.' : 'Time can run faster above the air.', 2.5);
    this.warp = n;
  }
  cycleWarp() { this.setWarp(this.warp >= (this.rk.canCoast ? WARPS.length - 1 : PHYS_WARP) ? 0 : this.warp + 1, true); }
  setMap(on) {
    if (on === this.mapOpen) return;
    this.mapOpen = on; document.body.classList.toggle('orbit-map', on);
    if (on) { this.cam.focus = 'body'; this.map.fit(); }
    this.map.setVisible(on);
  }
  cycleFocus() { const c = this.cam, order = ['body', 'craft', 'earth', 'moon']; c.focus = order[(order.indexOf(c.focus) + 1) % order.length]; this.map.fit(); this.g.toast(`Map centered on ${c.focus === 'body' ? (this.rk.body === 'moon' ? 'the Moon' : 'the Earth') : c.focus === 'craft' ? 'your craft' : c.focus === 'earth' ? 'the Earth' : 'the Moon'}.`, 2); }
  toggleView() { this.view = this.view === 'chase' ? 'onboard' : 'chase'; }
  say(key, text, secs = 4) { if (this.said[key]) return; this.said[key] = true; this.g.toast(text, secs); }

  // ------------------------------------------------------------------ simulation

  simulate(dt) {
    const g = this.g, rk = this.rk, input = g.input, c = this.clock;
    if (rk.crashed) {
      if (!this.endT) { this.endT = 3.5; g.toast(`${rk.crashed}. That one will need a new rocket.`, 4); g.sound?.crash?.(); g.clouds.uFlashScreen.value = 0.5; }
      this.endT -= dt;
      if (this.endT <= 0) { this.endT = 0; g.restart(); }
      return;
    }
    // Weather where the rocket is, while it is in the game's world.
    if (this.mix < 1) {
      g.weather.update(dt * Math.min(WARPS[this.warp], 4));
      g.weather.sample(g.ac.pos.x, g.ac.pos.y, g.ac.pos.z, groundHeight(g.ac.pos.x, g.ac.pos.z), g.wx);
      enu(rk.r, B);
      const w = g.wx, k = rk.alt < 30000 ? 1 : 0;
      for (let i = 0; i < 3; i++) this.env.wind[i] = k * (w.x * B[i] - w.z * B[3 + i] + w.y * B[6 + i]);
    } else this.env.wind[0] = this.env.wind[1] = this.env.wind[2] = 0;

    // Hands on the controls.
    const inv = g.S.settings.invert ? -1 : 1;
    this.ctl.pitch = input.raw.pitch * inv; this.ctl.yaw = input.raw.roll; this.ctl.roll = input.raw.yaw;
    if (input.raw.throttle) { rk.throttle = clamp(rk.throttle + input.raw.throttle * 0.7 * dt, 0, 1); this.manual(); }
    if ((this.autopilot || this.pilot) && (this.ctl.pitch || this.ctl.yaw)) this.manual();

    // The roll program: in the first half minute the vehicle turns its underside to the way it is going.
    if (rk.lifted && !rk.landed && rk.met > 4 && rk.met < 40 && !this.ctl.roll && rk.roll) { const d = rk.roll > 180 ? 360 - rk.roll : -rk.roll, st = Math.sign(d) * Math.min(Math.abs(d), 14 * dt * Math.min(WARPS[this.warp], 4)); rk.roll = (rk.roll + st + 360) % 360; if (Math.abs(d) < 0.05) rk.roll = 0; }
    // Time acceleration only holds while coasting above the air; and it eases off before the air or the ground arrives.
    if (this.warp > PHYS_WARP && !rk.canCoast) { this.warp = PHYS_WARP; }
    if (this.warp > PHYS_WARP && !rk.landed) {
      const floor = rk.body === 'moon' ? 3000 : ATMO_TOP + 2000;
      const tHit = rk.vs < -1 ? (rk.alt - floor) / -rk.vs : Infinity;
      while (this.warp > PHYS_WARP && tHit < 4 * dt * WARPS[this.warp] * 30) this.warp--;
      if (rk.alt < floor && rk.vs < 0) this.warp = PHYS_WARP;
    }
    // The transfer helper runs time as fast as what it is waiting for allows, and at its true pace while the engines burn.
    const pilot = this.pilot, predictMoon = () => moonPass(c, rk.t, [rk.r[0], rk.r[1], rk.r[2]], [rk.v[0], rk.v[1], rk.v[2]], 9 * 86400).dist;
    if (pilot) {
      const eta = pilot.eta(rk, c);
      let w = 0;
      if (rk.canCoast && rk.throttle === 0 && eta > 12) while (w < WARPS.length - 1 && WARPS[w + 1] <= eta / 5) w++;
      this.warp = w;
    }
    const warp = WARPS[this.warp], wasBody = rk.body, wasStage = rk.stage;
    if (this.warp > PHYS_WARP) { rk.coast(dt * warp, this.env); if (pilot) { const ev = pilot.step(rk, c, predictMoon); if (ev) this.pilotSaid(ev); } }
    else {
      let n = Math.max(1, Math.round((dt * warp) / STEP));
      const h = (dt * warp) / n;
      while (n-- > 0 && !rk.crashed) {
        if (this.autopilot) {
          const st = guidance(rk, c, this.target || 190000, this.azimuth);
          if (st === 'orbit') { this.autopilot = false; const o = rk.orbit(c); g.toast(`Engines off. In orbit: ${fmt(miles(o.pe))} by ${fmt(miles(o.ap))} miles. M for the map.`, 8); }
          else if (rk.stage !== this.modelStage()) this.syncStage();
        }
        if (this.pilot) { const ev = this.pilot.step(rk, c, predictMoon); if (ev) this.pilotSaid(ev); }
        rk.step(h, this.ctl, this.env);
      }
    }
    if (rk.stage !== wasStage) this.syncStage();
    this.events(wasBody);
    this.sats.update(c, rk.t);

    // Dropped stages fall on their own.
    for (let i = this.spent.length - 1; i >= 0; i--) {
      const s = this.spent[i], h = dt * warp;
      s.age += h;
      if (s.age > 240 || warp > 4) { g.scene.remove(s.obj); this.spent.splice(i, 1); continue; }
      gravity(c, rk.t, s.r, gacc);
      for (let k = 0; k < 3; k++) { s.v[k] += gacc[k] * h; s.r[k] += s.v[k] * h; }
      q1.setFromAxisAngle(v1.copy(s.spin).normalize(), s.spin.length() * h); s.q.multiply(q1);
    }
  }
  modelStage() { let n = 0; for (const s of this.vehicle.stages) { if (s.group.visible) break; n++; } return n; }
  /** The autopilot dropped a stage inside the physics loop: make the model and the debris match. */
  syncStage() {
    const rk = this.rk, v = this.vehicle;
    for (let k = this.modelStage(); k < rk.stage; k++) {
      const obj = v.spent(k); this.g.scene.add(obj);
      this.spent.push({ obj, r: [rk.r[0], rk.r[1], rk.r[2]], v: [rk.v[0] - rk.nose[0] * 6, rk.v[1] - rk.nose[1] * 6, rk.v[2] - rk.nose[2] * 6], q: this.qLocal.clone(), spin: new THREE.Vector3(0.02 + Math.random() * 0.05, 0, 0.03 * (Math.random() - 0.5)), age: 0, pivot: rk.spec.stages[k].pivot });
      this.g.toast(`${ROCKETS[rk.id].stages[k].name} away. ${ROCKETS[rk.id].stages[k + 1].name} burning.`, 3);
    }
    v.setStage(rk.stage); rk.baseY = v.stages[rk.stage].bottomY;
    this.shadows();
  }

  /** The moments worth a word. */
  events(wasBody) {
    const rk = this.rk, g = this.g;
    if (rk.lifted && rk.agl > 60 && !rk.landed) this.say('tower', 'Tower cleared.', 2.5);
    if (rk.mach > 1 && rk.alt < 30000) this.say('mach', 'Supersonic.', 2.5);
    if (rk.q > this.maxQ) this.maxQ = rk.q; else if (this.maxQ > 12000 && rk.q < 0.9 * this.maxQ && rk.vs > 0) this.say('maxq', 'Through maximum dynamic pressure.', 3);
    if (rk.alt > 100000 && rk.body === 'earth') this.say('space', 'Passing 62 miles: you are in space.', 4);
    if (rk.body === 'earth' && !rk.landed && rk.alt > ATMO_TOP) {
      const o = rk.orbit(this.clock);
      if (o.pe > ATMO_TOP && o.bound && !this.autopilot) this.say('orbit', `You are in orbit: ${fmt(miles(o.pe))} by ${fmt(miles(o.ap))} miles. M for the map; period and comma run time faster and slower.`, 9);
    }
    if (rk.body !== wasBody) {
      g.toast(rk.body === 'moon' ? 'Entering the Moon\'s sphere of influence. Burn against your direction of travel (3, then R) near the low point to stay.' : 'Leaving the Moon behind.', 7);
      if (this.mapOpen && this.cam.focus === 'body') this.map.fit();
    }
    if (rk.body === 'moon' && !rk.landed) { const o = rk.orbit(this.clock); if (o.bound && o.pe > 5000) this.say('lunar', `Captured: in orbit of the Moon, ${fmt(miles(o.pe))} by ${fmt(miles(o.ap))} miles.`, 8); }
    if (rk.heat > 6e8 && rk.vs < 0) this.say('entry', 'Reentry: the air is slowing you down.', 4);
    if (rk.touchdown && rk.touchdown !== this.lastTd) {
      this.lastTd = rk.touchdown;
      if (rk.landed) g.toast(rk.body === 'moon' ? `Down on the Moon at ${rk.touchdown.sink.toFixed(1)} m/s. The Eagle has nothing on you.` : `Landed at ${rk.touchdown.sink.toFixed(1)} m/s.`, 7);
    }
  }

  // ------------------------------------------------------------------ where everything is, this frame

  /** Local axes of the body the craft is near, into B; the craft relative to that body into rel / vrel. */
  local() {
    const rk = this.rk;
    if (rk.body === 'moon') { moonPos(this.clock, rk.t, rm); moonVel(this.clock, rk.t, mv); for (let k = 0; k < 3; k++) { rel[k] = rk.r[k] - rm[k]; vrel[k] = rk.v[k] - mv[k]; } }
    else for (let k = 0; k < 3; k++) { rel[k] = rk.r[k]; vrel[k] = rk.v[k]; }
    enu(rel, B);
  }
  /** A direction given east, up, south (the game world's axes) at the craft, as an ECI vector. */
  toEci(x, y, z, out) { for (let k = 0; k < 3; k++) out[k] = x * B[k] + y * B[6 + k] - z * B[3 + k]; return out; }

  /** After the simulation: the craft in the game's world, the model's attitude, the cameras, and which view shows. */
  frame(dt) {
    const g = this.g, rk = this.rk, ac = g.ac, cam = g.camera, input = g.input;
    this.local();
    const onEarth = rk.body === 'earth';
    // Where the craft is in the game's world, if it is over the window at all.
    const p = onEarth ? toWorld(rk.lat, rk.lon) : { x: 1e9, z: 1e9 };
    const inWindow = Math.abs(p.x) < WORLD_HALF - 30000 && Math.abs(p.z) < WORLD_HALF - 30000;
    this.groundOK = onEarth && inWindow;
    const want = this.mapOpen ? 1 : this.groundOK ? smoothstep(MIX_LO, MIX_HI, rk.alt) : 1;
    this.mix = this.forceMix ?? want;                     // (forceMix: a test's override)

    // Attitude in the game world's axes: +Y of the model is the nose; its back is turned from the heading when it stands upright.
    const h = rk.hdg * D2R, pt = rk.pitch * D2R, ch = Math.cos(h), sh = Math.sin(h), cp = Math.cos(pt), sp = Math.sin(pt);
    v1.set(cp * sh, sp, -cp * ch);                          // nose
    v2.set(sp * sh, -cp, -sp * ch);                         // model +Z: the side that is underneath when it flies level (Starship's heat shield)
    v3.crossVectors(v1, v2);                                // model X = Y x Z
    m1.makeBasis(v3, v1, v2);
    this.qLocal.setFromRotationMatrix(m1);
    if (rk.roll) this.qLocal.multiply(q1.setFromAxisAngle(UP, rk.roll * D2R));
    const nose = v1;

    // The stand-in airplane: position, attitude as a compass heading, and the numbers the rest of the game reads.
    if (this.groundOK) {
      this.posW.set(p.x, rk.alt, p.z);
      ac.pos.copy(this.posW);
      ac.quat.setFromAxisAngle(UP, -rk.hdg * D2R);
      const ve = dot(vrel, [B[0], B[1], B[2]]) - (onEarth ? 7.2921159e-5 * Math.hypot(rk.r[0], rk.r[1]) : 0), vn = dot(vrel, [B[3], B[4], B[5]]), vu = dot(vrel, [B[6], B[7], B[8]]);
      ac.vel.set(ve, vu, -vn);
      ac.agl = Math.max(rk.agl, 0); ac.maxAgl = rk.maxAlt; ac.tas = rk.speedSurf; ac.ias = rk.speedSurf * Math.sqrt(airPressure(rk.alt)); ac.onGround = !!rk.landed;
      ac.gLoad = rk.gLoad; ac.throttle = rk.throttle; ac.thrustLevel = rk.thrustLevel; ac.crashed = null; ac.stall = 0; ac.surface = 'paved';
    }
    this.baseW.copy(this.posW).addScaledVector(nose, -rk.pivot);

    // ---- cameras
    // Free look accumulates (the rocket's camera stays where it is left); the wheel sets the distance.
    const c = this.cam, look = input.look;
    if (this.mapOpen) {
      c.mapYaw += look.yaw; c.mapPitch = clamp(c.mapPitch + look.pitch, -1.5, 1.5);
      c.mapDist = clamp(c.mapDist * (input.zoomTarget / (this.zoomWas || 1)), this.map.minDist(), 3e9);
    } else { c.yaw -= look.yaw; c.pitch = clamp(c.pitch - look.pitch, -1.45, 1.45); }
    look.yaw = 0; look.pitch = 0; this.zoomWas = input.zoomTarget;
    input.zoom += (input.zoomTarget - input.zoom) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 9));

    const size = this.vehicle ? this.vehicle.height - (rk.baseY || 0) : 100;
    let eyeW = v2, qW = q2, fov = 55;                       // the camera in the game world's axes, relative to posW
    if (this.view === 'onboard' && !this.mapOpen) {
      // On the vehicle's skin, looking back down its length at the flame and whatever is being left behind.
      const rad = (this.vehicle?.radius || 5) * 1.35;
      v3.set(rad, (this.vehicle ? this.vehicle.stages[rk.stage].topY - 4 : 60) - rk.pivot, 0).applyQuaternion(this.qLocal);
      eyeW.copy(v3);
      const back = new THREE.Vector3(0.22, -1, 0).normalize().applyQuaternion(this.qLocal), side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.qLocal);
      m1.lookAt(eyeW, v3.copy(eyeW).add(back), side); qW.setFromRotationMatrix(m1); fov = 70;
    } else {
      const dist = clamp(size * 2.3 * c.dist * input.zoom, size * 0.6, 60000);
      const dir = v3.set(Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), -Math.cos(c.yaw) * Math.cos(c.pitch));
      eyeW.copy(dir).multiplyScalar(-dist); eyeW.y += size * 0.06;
      // Keep the camera out of the ground.
      if (this.groundOK && this.mix < 1) {
        const floor = groundHeight(this.posW.x + eyeW.x, this.posW.z + eyeW.z) + 2.5 - this.posW.y;
        if (eyeW.y < floor) eyeW.y = floor;
      }
      const tgt = new THREE.Vector3(0, size * (rk.landed ? 0.12 : 0.02), 0);
      m1.lookAt(eyeW, tgt, UP); qW.setFromRotationMatrix(m1);
    }
    this.camDist = eyeW.length();
    if (this.mix < 1) {
      cam.position.copy(this.posW).add(eyeW); cam.quaternion.copy(qW); cam.up.set(0, 1, 0);
      cam.fov = fov; cam.near = 1.5; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      if (dt > 0) g.camState.vel.copy(cam.position).sub(g.camState.prev).multiplyScalar(1 / dt);
      g.camState.prev.copy(cam.position);
    }
    // The same camera in the inertial frame (or the map's own).
    if (this.mapOpen) this.map.camera(this.eye, this.eyeQuat);
    else {
      this.toEci(eyeW.x, eyeW.y, eyeW.z, tmpA);
      for (let k = 0; k < 3; k++) this.eye[k] = rk.r[k] + tmpA[k];
      worldToRenderQuat(rel, q1, m1); this.eyeQuat.copy(q1).multiply(qW);
    }
    this.fov = this.mapOpen ? 45 : fov;

    // ---- the model, its flame and smoke
    const v = this.vehicle;
    if (v) {
      const st = v.stages[rk.stage], pres = onEarth ? airPressure(rk.alt) : 0, night = ENV.uNight.value;
      v.update(dt, { throttle: rk.thrustLevel, stage: rk.stage, gimbal: { x: this.ctl.yaw * 0.5, y: this.ctl.pitch * 0.5 }, altitude: rk.alt, mach: rk.mach, q: rk.q, night, time: g.S.time, heat: rk.heat });
      this.plume?.update(dt, { nozzles: st.nozzles, nozzleRadius: st.nozzleRadius, throttle: rk.thrustLevel, pressure: pres, propellant: st.propellant, speed: rk.speedSurf, time: g.S.time, night });
      if (this.trail) {
        if (this.groundOK && this.mix < 1) {
          const nz = st.nozzles, cy = nz.length ? nz[0].y : st.bottomY;
          v3.copy(this.baseW).addScaledVector(nose, cy);
          if (this.trailTier !== g.tier()) { this.trailTier = g.tier(); this.trail.setQuality?.(this.trailTier); }
          // Everything the smoke needs to know about the vehicle this frame (it decides what, if anything, to make of it).
          if (dt > 0) {
            this.trail.emit(dt, {
              pos: v3, dir: nose.clone().negate(), vel: g.ac.vel, throttle: rk.thrustLevel, pressure: pres, propellant: st.propellant, radius: v.radius,
              wind: new THREE.Vector3(g.wx.x, g.wx.y, g.wx.z), onPad: rk.agl < 40, groundY: this.padY + (rk.agl < 200 ? 0 : -1e4),
              vehicle: rk.id, stage: rk.stage, landed: !!rk.landed, held: rk.held, met: rk.lifted ? rk.met : -1, agl: rk.agl, mach: rk.mach, q: rk.q,
              padY: this.padY, standY: this.standY, hasPad: !!this.pad && rk.agl < 400, base: this.baseW, nose, height: v.height, heat: rk.heat,
              shade: g.wx.shade, flameLen: this.plume?.length || undefined,
            });
          }
          this.trail.update(dt, { camPos: cam.position, sunDir: ENV.uSunDir.value, sunColor: ENV.uSunCol.value, ambient: ENV.uAmbSky.value, time: g.S.time });
          this.trail.object.visible = true;
        } else this.trail.object.visible = false;
      }
      // The glow of reentry: which way the craft is going through the air, in its own axes.
      if (this.glow) {
        const wE = onEarth ? 7.2921159e-5 * Math.hypot(rk.r[0], rk.r[1]) : 0;
        const fl = new THREE.Vector3(dot(vrel, [B[0], B[1], B[2]]) - wE, dot(vrel, [B[6], B[7], B[8]]), -dot(vrel, [B[3], B[4], B[5]]));
        if (fl.lengthSq() > 1) fl.normalize().applyQuaternion(q1.copy(this.qLocal).invert()); else fl.set(0, 1, 0);
        const len0 = v.height - (rk.baseY || 0);
        this.glow.update(dt, { heat: onEarth && !rk.landed ? rk.heat : 0, flow: fl, length: len0, radius: v.radius, centerY: (rk.baseY || 0) + len0 / 2, time: g.S.time });
      }
      this.pad?.update(dt, { t: rk.lifted ? rk.met : -10, night });
      this.groundPose();
    }
    // ---- sound: the engines through whatever air there is, and how much of the weather's own sound still reaches the craft
    const airNow = onEarth ? airPressure(rk.alt) : 0;
    this.ambience = this.groundOK ? Math.sqrt(airNow) * (1 - this.mix) : 0;
    this.snd.attach(g.sound);
    this.snd.update(g.S.mode === 'flying' ? dt : 0, {
      thrust: g.S.mode === 'flying' ? rk.thrustLevel : 0, size: rk.stageSpec.thrust / 35.1e6, pressure: airNow,
      view: this.mapOpen ? 'map' : this.view, dist: this.camDist, agl: rk.agl, mach: rk.mach, q: rk.q, pitch: rk.id === 'starship' ? 1.07 : 0.96,
    });
    this.hud(dt);
  }

  /** Put the vehicle and its debris where the game's scene wants them. */
  groundPose() {
    const v = this.vehicle;
    v.root.position.copy(this.baseW); v.root.quaternion.copy(this.qLocal);
    v.root.visible = this.groundOK;
    for (const s of this.spent) {
      eciToGeo(this.clock, this.rk.t, s.r, geo);
      const p = toWorld(geo.lat, geo.lon);
      v1.set(0, 1, 0).applyQuaternion(s.q);
      s.obj.position.set(p.x, geo.alt, p.z).addScaledVector(v1, -s.pivot); s.obj.quaternion.copy(s.q); s.obj.visible = this.groundOK;
    }
  }
  /** And where the view from space wants them: relative to its camera, in its axes. */
  spacePose() {
    const v = this.vehicle, rk = this.rk, cs = this.cosmos;
    worldToRenderQuat(rel, q1, m1);
    v.root.visible = true;
    v.root.quaternion.copy(q1).multiply(this.qLocal);
    for (let k = 0; k < 3; k++) tmpA[k] = rk.r[k] - rk.nose[k] * rk.pivot;
    cs.place(v.root, tmpA);
    for (const s of this.spent) {
      s.obj.visible = true; s.obj.quaternion.copy(q1).multiply(s.q);
      v1.set(0, 1, 0).applyQuaternion(s.obj.quaternion);
      cs.place(s.obj, s.r); s.obj.position.addScaledVector(v1, -s.pivot);
    }
  }

  /** Draw the view from space into its own target. Returns the texture (for the fade over the ground view). */
  drawSpace(dt) {
    const g = this.g, cs = this.cosmos, v = this.vehicle;
    cs.setQuality(g.tier());
    cs.setSize(g.clouds.w, g.clouds.h);
    cs.weatherOn = true;
    cs.begin({ pos: this.eye, quat: this.eyeQuat, fov: this.fov, aspect: g.camera.aspect }, this.clock, this.rk.t, dt);
    // The craft and its debris are children of the game's scene; the view from space borrows them for its own pass.
    const kids = cs.near.children; kids.length = 5;
    const hideCraft = this.mapOpen && len([this.eye[0] - this.rk.r[0], this.eye[1] - this.rk.r[1], this.eye[2] - this.rk.r[2]]) > 40000;
    if (v && !hideCraft) { this.spacePose(); cs.shadowAround(v3.set(0, this.rk.pivot, 0).applyQuaternion(v.root.quaternion).add(v.root.position), this.shadowHalf || 70); kids.push(v.root); for (const s of this.spent) kids.push(s.obj); v.root.updateMatrixWorld(true); for (const s of this.spent) s.obj.updateMatrixWorld(true); }
    this.sats.draw(this.eye, kids, this.mapOpen);
    this.map.update(dt);
    const tex = cs.draw();
    kids.length = 5;
    if (this.mix < 1) this.expo = g.sky.exposure;
    if (v) { this.groundPose(); v.root.updateMatrixWorld(true); }
    return tex;
  }

  /** Nothing but space: draw it and send it through the game's post-processing to the screen. */
  renderSpace(dt) {
    const g = this.g, cs = this.cosmos, fx = g.clouds.fx;
    const tex = this.drawSpace(dt);
    const sun = ENV.uSunDir.value.clone(), fog = ENV.uFogDensity.value, night = ENV.uNight.value;
    ENV.uSunDir.value.copy(cs.u.uSun.value); ENV.uFogDensity.value = 1e-6; ENV.uNight.value = 0;
    fx.time = g.S.time; fx.rain = 0; fx.snow = 0; fx.ice = 0; fx.cockpit = 0; fx.airspeed = 0; fx.flash = g.clouds.uFlashScreen.value; fx.clearance = 1e6;
    // The eye carries over from the climb (the ground view opens its exposure as the sky darkens) and settles to space's own.
    this.expo = this.expo ? this.expo + (cs.exposure - this.expo) * Math.min(1, dt * 0.35) : cs.exposure;
    fx.exposure = 0.64 * this.expo * g.S.settings.exposure;
    g.clouds.uFlashScreen.value *= Math.exp(-dt * 7);
    g.clouds.post.flashExtra = g.clouds.uFlashScreen.value;
    g.clouds.post.render(tex, cs.camera, null, {});
    ENV.uSunDir.value.copy(sun); ENV.uFogDensity.value = fog; ENV.uNight.value = night;
  }

  /** The game's window of the world moved by (dx, dz): everything of ours that is kept in its meters moves with it. */
  worldMoved(dx, dz) {
    this.trail?.shift?.(dx, 0, dz);
    if (this.pad && this.site) { const p = toWorld(this.site.lat, this.site.lon); this.pad.root.position.set(p.x, this.padY, p.z); this.g.cities?.setKeepClear([[p.x - 420, p.z - 420, p.x + 420, p.z + 420]]); }
  }
  /** Local solar time (hours) where the craft is: what the game's sky should show when it comes back down. */
  localHour() { return ((((this.clock.hourG0 + this.rk.t / 3600 + (this.rk.lon || 0) / 15) % 24) + 24) % 24); }

  // ------------------------------------------------------------------ the panel

  hud(dt) {
    if ((this.uiT -= dt) > 0 && dt > 0) return;
    this.uiT = 0.1;
    const rk = this.rk, o = rk.orbit(this.clock), put = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
    const st = ROCKETS[rk.id].stages[rk.stage];
    put('rpStage', st.name);
    put('rpThr', `${Math.round(rk.throttle * 100)}%`);
    const bar = $('rpThrBar'); if (bar) bar.style.width = `${Math.round(rk.thrustLevel * 100)}%`;
    put('rpG', `${rk.gLoad.toFixed(1)} g`);
    const met = Math.max(rk.met, 0), d = Math.floor(met / 86400), hh = Math.floor((met % 86400) / 3600), mm = Math.floor((met % 3600) / 60), ss = Math.floor(met % 60);
    put('rpClk', `${d ? d + 'd ' : ''}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
    // Speed: over the ground while in the air, around the planet (or the Moon) above it.
    const orbital = rk.body === 'moon' || rk.alt > 60000;
    put('rpSpdLbl', orbital ? 'Orbital speed' : 'Speed');
    put('rpSpd', fmt((orbital ? rk.speedOrb : rk.speedSurf) * 2.23694));
    const alt = rk.landed ? Math.max(rk.agl, 0) : rk.alt;
    if (alt < 15240) { put('rpAlt', fmt(alt * 3.28084)); put('rpAltU', 'ft'); } else { const mi = miles(alt); put('rpAlt', mi < 100 ? mi.toFixed(1) : fmt(mi)); put('rpAltU', 'mi'); }
    put('rpAltLbl', rk.body === 'moon' ? 'Above the Moon' : 'Altitude');
    put('rpPitch', `${Math.round(rk.pitch)}°`); put('rpHdg', String(Math.round(rk.hdg) % 360).padStart(3, '0') + '°');
    const mi = (m) => (!isFinite(m) ? 'escape' : m < -RE * 0.5 ? '—' : `${m < 0 ? '−' : ''}${fmt(Math.abs(miles(m)))}`);
    put('rpAp', mi(o.ap)); put('rpPe', mi(o.pe));
    const tt = (s) => (!isFinite(s) || s < 0 ? '' : s < 3600 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s` : s < 86400 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : `${(s / 86400).toFixed(1)}d`);
    put('rpApT', rk.landed ? '' : tt(o.tAp)); put('rpPeT', rk.landed ? '' : tt(o.tPe));
    put('rpBody', rk.body === 'moon' ? 'Moon' : 'Earth');
    const ann = (id, on, text) => { const e = $(id); if (!e) return; if (e.hidden === on) e.hidden = !on; if (on && text != null) put(id + 'V', text); };
    ann('rpAuto', this.autopilot);
    ann('rpSas', !this.autopilot && rk.sas !== 'hold', rk.sas === 'prograde' ? 'Prograde' : 'Retrograde');
    const pl = this.pilot;
    ann('rpXfer', !!pl, pl ? (pl.phase === 'wait' ? `burn in ${tt(pl.plan.tBurn - rk.t) || 'a moment'}` : pl.phase === 'burn' ? 'transfer burn' : pl.phase === 'capture' ? 'braking into orbit' : rk.throttle > 0 ? 'trimming course' : `coasting, ${tt(Math.max(pl.plan.tArrive - rk.t, 0)) || 'arriving'}`) : '');
    ann('rpWarp', this.warp > 0, `×${fmt(WARPS[this.warp])}`);
    const tg = this.sats.target;
    ann('rpTgt', !!tg, tg ? `${tg.name} ${fmt(miles(tg.dist))} mi` : '');
    const warn = rk.crashed ? '' : rk.landed && rk.held ? '' : !rk.landed && rk.body === 'earth' && rk.alt < 3000 && rk.vs < -60 ? 'PULL UP' : '';
    put('warn', warn);
  }
}
