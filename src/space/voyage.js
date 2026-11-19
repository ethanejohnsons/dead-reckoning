// A starship flight: what mission.js hands a flight over to when the craft is the Enterprise.
//
// Nothing here is rocketry. The ship goes where its bow points, at the speed asked of it, and stops when asked:
// no fuel, no gravity, no orbit to fall out of. Arcade on purpose, like the rest of the game.
//
// Where it is. The ship belongs to one world at a time (`ref`: the one that looks largest from where it is,
// solar.js) and its place is kept relative to that world (`rel`, in the axes of frames.js), so a ship at rest
// by Saturn stays by Saturn as Saturn goes round the sun. Low over the Earth it is also carried round with
// the ground, so at rest it hangs over one spot.
//
// How it flies.
//   - Impulse: the throttle asks for a share of the fastest speed that makes sense where the ship is, and that
//     grows with its height above the world below: a few hundred miles an hour down among the hills, miles a
//     second in a low orbit, a quarter of the speed of light between the planets. Diving at a planet therefore
//     slows the ship by itself, and it cannot be flown into the ground: it skims.
//   - Close to a world the ship follows the curve of it: left alone at a height it keeps that height all the
//     way round, and it rights itself against the horizon. Far from any world it flies straight and keeps
//     whatever attitude it is given.
//   - Warp: factors 1 to 9, at the speed the factor always meant (the cube root of its tenth power, times
//     light): the Moon in a second at warp 1, Neptune in ten at warp 9. The ship winds up for a moment, then
//     jumps. A ship at warp comes out of it by itself where it would otherwise run into a world's neighborhood.
//   Its sound is shipsound.js's.
//   - The helm (G) flies to the destination chosen with N: turns the ship (round the planet it is leaving, or
//     round the sun, if they are in the way), goes to warp, comes out near the destination on its sunlit side
//     and takes up a standard orbit. O takes up a standard orbit of the world below at any time.
//
//   - M is the chart of the solar system (solarchart.js): the same view from far off, with the orbits drawn.
//   - Left alone, the ship goes round the sun. By a world it goes with that world; out in the open it keeps the
//     velocity of the world it last left (the drives move the ship without changing that, as a warp drive would)
//     and falls round the sun on whatever orbit that makes from where it has got to: `drift`. At thirty
//     kilometers a second none of it shows in flight; the chart draws the path.
//
// What mission.js still does: the view from space and the fade between it and the game's world (drawSpace,
// renderSpace, `mix`), the satellites, the shadows. This module sets what those read: the craft (`mission.rk`
// for the length of the flight), the model, the stand-in airplane the rest of the game follows, the cameras.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { clamp, smoothstep } from '../core/noise.js';
import { groundHeight } from '../world/terrain.js';
import { toWorld, WORLD_HALF } from '../world/geo.js';
import { makeClock, RE, D2R, OMEGA_E, eciToGeo, geoToEci, enu, worldToRenderQuat } from './frames.js';
import { airPressure } from './rocket.js';
import { AU, LIGHT } from './solar.js';
import { WarpStreaks } from './warpfx.js';
import { ShipSound } from './shipsound.js';
import { SolarChart } from './solarchart.js';

export const STARSHIPS = [
  { id: 'enterprise', name: 'U.S.S. Enterprise NCC-1701-D', blurb: 'Galaxy class: 2,100 feet of starship. Impulse engines for the neighborhood, warp drive for the rest of the solar system.' },
];
export const isStarship = (id) => STARSHIPS.some((s) => s.id === id);
/** Where a starship flight can begin (the menu's "Start"). */
export const VOYAGE_STARTS = [
  ['orbit', 'In orbit of the Earth'], ['low', 'Low over the place chosen'], ['moon', 'At the Moon'], ['mars', 'At Mars'], ['jupiter', 'At Jupiter'],
  ['saturn', 'At Saturn'], ['uranus', 'At Uranus'], ['neptune', 'At Neptune'], ['venus', 'At Venus'], ['mercury', 'At Mercury'],
];
const DESTINATIONS = ['earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'venus', 'mercury', 'sun'];

const MIX_LO = 24000, MIX_HI = 36000;      // the band (m) over which the view from space takes over (as mission.js)
const STEP = 1 / 60;
const FULL_IMPULSE = 0.25 * LIGHT;
const SPOOL = 0.9;                          // the moment the ship takes to wind up before it jumps to warp (s)
const KEEL = 170;                          // the ship's center is kept this far above the ground (m): the engineering hull hangs 100 m below it
const SIZE = 642.5;
const TAU = Math.PI * 2;
const warpSpeed = (w) => LIGHT * Math.pow(w, 10 / 3);
const warpOf = (v) => Math.pow(v / LIGHT, 0.3);
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

// The model is another module's business (model-enterprise.js); until it has loaded, or if it fails, a plain stand-in flies.
// So is the bridge (bridge-enterprise.js): without it the view from the bridge is the bare view ahead.
const lazyShip = import.meta.glob('./model-enterprise.js'), lazyBridge = import.meta.glob('./bridge-enterprise.js');
let shipMod = null, bridgeMod = null;
export async function loadShip() {
  const f = Object.values(lazyShip)[0], fb = Object.values(lazyBridge)[0];
  await Promise.all([
    f && f().then((mod) => { shipMod = mod; }, (e) => console.warn('The Enterprise model did not load:', e.message)),
    fb && fb().then((mod) => { bridgeMod = mod; }, (e) => console.warn('The Enterprise\'s bridge did not load:', e.message)),
  ]);
}
function standInShip() {
  const root = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: 0xb9c6cf, roughness: 0.55, metalness: 0.1 });
  const part = (geo, x, y, z, sx, sy, sz) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); root.add(m); return m; };
  const ball = new THREE.SphereGeometry(1, 40, 20);
  part(ball, 0, 4, -128, 232, 24, 193); part(ball, 0, -62, 62, 60, 44, 150); part(ball, -128, -4, 178, 26, 16, 143); part(ball, 128, -4, 178, 26, 16, 143);
  return { id: 'enterprise', root, length: SIZE, beam: 464, height: 137, points: { bridge: new THREE.Vector3(0, 30, -128) }, update() {}, dispose() { ball.dispose(); mat.dispose(); } };
}

const shipSound = new ShipSound();         // one for every flight: its recordings are loaded once, and its loops run on
let solarChart = null;                     // and one chart (its lines and names are made once, on the first flight)
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1), RIGHT = new THREE.Vector3(1, 0, 0), ZERO = new THREE.Vector3();
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), up1 = new THREE.Vector3(), up2 = new THREE.Vector3();
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), qWR = new THREE.Quaternion(), qI = new THREE.Quaternion(), m1 = new THREE.Matrix4(), eu = new THREE.Euler();
const geo = {}, tA = [0, 0, 0], B = new Array(9);
/** The axes of frames.js (an array) to the drawing axes of the view from space (a Vector3), and back. */
const toDraw = (a, out) => out.set(a[0], a[2], -a[1]);
const fromDraw = (v, out) => { out[0] = v.x; out[1] = -v.z; out[2] = v.y; return out; };

/** A distance for the panel: [number, unit]. */
function distText(m) {
  const mi = m / 1609.344;
  if (mi < 100) return [mi.toFixed(1), 'mi'];
  if (mi < 2e6) return [fmt(mi), 'mi'];
  if (m < 0.1 * AU) return [(mi / 1e6).toFixed(mi < 2e7 ? 2 : 1), 'million mi'];
  return [(m / AU).toFixed(m < 10 * AU ? 2 : 1), 'AU'];
}

export class Voyage {
  constructor(mission) {
    this.m = mission; this.g = mission.g; this.solar = mission.cosmos.solar;
    // What the rest of the game reads of a craft (mission.rk, for the length of the flight).
    this.craft = { id: 'enterprise', r: [RE + 4e5, 0, 0], v: [0, 0, 0], nose: [0, 1, 0], pivot: 0, baseY: 0, t: 0, met: 0, body: 'earth', alt: 4e5, agl: 4e5, vs: 0, lat: 0, lon: 0, maxAlt: 0, crashed: null, landed: null, lifted: true };
    this.ref = this.solar.earth; this.rel = [RE + 4e5, 0, 0];
    this.q = new THREE.Quaternion();           // the ship's axes (-Z the bow, +Y up) in the drawing axes of the view from space
    this.rate = new THREE.Vector3();           // its turning about its own axes (rad/s)
    this.bank = 0;                             // the lean it shows in a turn (only the model's)
    this.thr = 0; this.warp = 0; this.speed = 0; this.atWarp = false; this.jump = 0; this.streakAmt = 0;
    this.spool = 0; this.pending = 0;          // winding up for warp: seconds left, and the factor it will jump to
    this.snd = shipSound; this.chart = null; this.chartOpen = false;
    this.drift = [0, 0, 0];                    // out in the open: the ship's velocity round the sun (m/s, the axes of frames.js)
    this.glow = null;                          // the light the nacelles throw round themselves going to warp
    this.bridge = null;                        // the room the view from the bridge is seen from (bridge-enterprise.js), if it loaded
    this.dest = null; this.ap = null; this.orbit = null;
    this.want = new THREE.Vector3(); this.wantUp = new THREE.Vector3();
    this.camQ = new THREE.Quaternion(); this.fly = null; this.view = 'chase'; this.qShown = new THREE.Quaternion(); this.orbitSpeed = 0;
    this.qW = new THREE.Quaternion();          // the ship's attitude in the game world's axes
    this.uiT = 0; this.model = null; this.root = null; this.streaks = null; this.camEase = null;
    this.rocketWas = null;
  }

  // ------------------------------------------------------------------ start and end

  start(id, site) {
    const m = this.m, g = this.g;
    m.site = site; m.active = true;
    m.clock = m.env.clock = makeClock(site.lon, g.sky.day, g.weather.hour, g.sky.moonPhase);
    this.solar.place(m.clock, 0);
    // (the saucer's paint is most of the model's memory: the lower graphics tiers get it smaller)
    const tier = g.tier(), detail = tier === 'low' ? 0.5 : tier === 'med' ? 0.75 : 1;
    try { this.model = shipMod ? shipMod.buildEnterprise({ detail }) : standInShip(); } catch (e) { console.warn('The Enterprise could not be built:', e); this.model = standInShip(); }
    this.root = new THREE.Group(); this.root.add(this.model.root);
    this.streaks = new WarpStreaks(); this.root.add(this.streaks.object);
    // The nacelles' glow going to warp: soft blue light along each, over the grilles' own (the model's), so it reads from any side.
    this.glow = null;
    if (this.model.points?.nacelles) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      const gx = cv.getContext('2d'), gr = gx.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.42)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      gx.fillStyle = gr; gx.fillRect(0, 0, 128, 128);
      const map = new THREE.CanvasTexture(cv), mat = new THREE.SpriteMaterial({ map, color: 0x000000, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false });
      for (const p of this.model.points.nacelles) for (const dz of [-100, -40, 20, 80]) { const sp = new THREE.Sprite(mat); sp.position.set(p.x, p.y, p.z + dz); sp.scale.set(170, 110, 1); sp.visible = false; this.model.root.add(sp); }
      this.glow = { map, mat };
    }
    m.vehicle = { id, root: this.root, height: SIZE, radius: 232, stages: [], setStage() {}, update() {}, dispose: () => { this.model.dispose?.(); this.streaks.dispose(); this.bridge?.dispose?.(); this.glow?.map.dispose(); this.glow?.mat.dispose(); } };
    g.scene.add(this.root);
    this.rocketWas = m.rk; m.rk = this.craft;
    m.groundOK = true; m.mix = 0; m.view = 'chase'; this.view = 'chase';
    m.cam.yaw = 0.55; m.cam.pitch = 0.2; m.cam.dist = 1; m.cam.headYaw = 0; m.cam.headPitch = 0;
    m.shadows();
    this.model.root.traverse((o) => { if (o.userData.noShadow) o.castShadow = false; });      // (the model says which of its parts throw shadows: its windows and lettering do not)
    // The bridge: a room of its own inside the ship, under the dome on top of the saucer, shown only in the view from it
    // (when the outside of the ship is hidden, as with the rockets' cabins). It is lit by its own lights and throws no shadows.
    this.bridge = null;
    if (bridgeMod) {
      try {
        const b = this.bridge = bridgeMod.buildBridge(), top = this.model.points?.bridge || new THREE.Vector3(0, 33.8, -115.25);
        b.root.position.set(top.x, top.y - (b.height || 4) - 0.3, top.z);
        b.root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
        b.root.visible = false; this.root.add(b.root);
      } catch (e) { console.warn('The bridge could not be built:', e); this.bridge = null; }
    }
    g.clouds.fx.subject = this.root; g.clouds.fx.glass = null; g.clouds.fx.exhaust = null; g.clouds.subjBox = null;
    g.input.look.yaw = 0; g.input.look.pitch = 0; g.input.zoom = g.input.zoomTarget = 1;
    m.sats.reset(m.clock, site);
    m.snd.silence();
    this.chart = solarChart = solarChart || new SolarChart(m.cosmos);
    document.body.classList.add('starship');
    this.dest = this.solar.by.moon;
    this.place('orbit');
  }

  /** Put the ship somewhere: 'orbit' (of the Earth, over the launch site), 'low' (over the site, in the air), or a world's id. */
  place(where) {
    const m = this.m, c = this.craft, sol = this.solar, site = m.site;
    c.t = 0; c.met = 0;
    sol.place(m.clock, 0);
    this.ap = null; this.orbit = null; this.warp = 0; this.atWarp = false; this.speed = 0; this.thr = 0; this.rate.set(0, 0, 0); this.bank = 0; this.fly = null; this.spool = 0; this.pending = 0;
    const body = sol.by[where];
    if (body && body.id !== 'earth') {
      // Beside the world, on its sunlit side, the sun over one shoulder.
      this.ref = body;
      const s = body.toSun, side = [-s[1], s[0], 0], sl = Math.hypot(side[0], side[1]) || 1, d = body.R * Math.min(body.near, 3.1), P = this.sunnyPole(body);
      for (let k = 0; k < 3; k++) this.rel[k] = 0.8 * s[k] + 0.6 * side[k] / sl + 0.38 * P[k];
      { const l = Math.hypot(this.rel[0], this.rel[1], this.rel[2]); for (let k = 0; k < 3; k++) this.rel[k] *= d / l; }
      toDraw(this.rel, up1).normalize();
      this.face(toDraw([0.6 * s[0] - 0.8 * side[0] / sl, 0.6 * s[1] - 0.8 * side[1] / sl, 0.6 * s[2]], v1), up1);      // bow toward the middle of the day side
      this.takeOrbit(true);
      m.cam.pitch = 1.2; m.cam.yaw = 0.7;                     // from above, so the world is behind the ship
      this.dest = sol.by.earth;
    } else {
      this.ref = sol.earth;
      const low = where === 'low';
      const gy = low ? Math.max(m.groundAt(site.lat, site.lon), 0) : 0;
      geoToEci(m.clock, 0, site.lat, low ? site.lon : site.lon - 2, low ? gy + 1500 : 4e5, this.rel);
      enu(this.rel, B);
      toDraw([B[6], B[7], B[8]], up1);
      const az = (low ? (site.az ?? 90) : 90) * D2R;
      toDraw([Math.sin(az) * B[0] + Math.cos(az) * B[3], Math.sin(az) * B[1] + Math.cos(az) * B[4], Math.sin(az) * B[2] + Math.cos(az) * B[5]], v1);
      this.face(v1, up1);
      m.cam.pitch = 0.2;
      if (low) this.thr = 0.55; else this.takeOrbit(true);
      this.dest = sol.by.moon;
    }
    this.camQ.copy(this.q);
    this.data(0);
    this.frame(0);
  }

  /** A world's pole on the side of its equator the sun lights (the axes of frames.js): where Saturn's rings are bright. Nothing for a world with no pole given. */
  sunnyPole(b) {
    if (!b.globe) return [0, 0, 0];
    const P = [b.poleV.x, -b.poleV.z, b.poleV.y], k = Math.sign(P[0] * b.toSun[0] + P[1] * b.toSun[1] + P[2] * b.toSun[2]) || 1;
    return [P[0] * k, P[1] * k, P[2] * k];
  }

  /** Point the bow along f with the ship's top toward u (drawing axes). */
  face(f, u) {
    v2.copy(f).normalize(); v3.crossVectors(v2, u).normalize(); v4.crossVectors(v3, v2);
    this.q.setFromRotationMatrix(m1.makeBasis(v3, v4, v2.negate()));
  }

  stop() {
    const m = this.m;
    this.setMap(false);
    document.body.classList.remove('starship');
    const mk = $('spMark'); if (mk) mk.hidden = true;
    if (this.rocketWas) m.rk = this.rocketWas;
    m.forceMix = undefined;
    { const fx = this.g.clouds.fx; fx.flare = fx.glare = fx.rays = 1; }
    shipSound.silence();
  }

  // ------------------------------------------------------------------ keys

  key(e) {
    switch (e.code) {
      case 'KeyZ': this.manual(); this.thr = 1; break;
      case 'KeyX': this.manual(); this.thr = 0; if (this.warping) this.setWarp(0); break;
      case 'Period': this.manual(true); this.setWarp(Math.floor((this.warp || this.pending) + 1e-6) + 1); break;
      case 'Comma': this.manual(true); this.setWarp(Math.ceil((this.warp || this.pending) - 1e-6) - 1); break;
      case 'KeyN': this.nextDest(e.shiftKey ? -1 : 1); break;
      case 'Tab': if (this.chartOpen) { e.preventDefault(); this.g.toast(`Chart centered on ${this.chart.cycleFocus()}.`, 2); } break;
      case 'KeyO': if (this.orbit) this.manual(); else { this.manual(); this.takeOrbit(); } break;
      case 'Space': this.manual(); this.thr = 0; if (this.warping) this.setWarp(0); break;
      default:
    }
  }
  /** The player's hands on the controls: the helm and the standard orbit let go (quiet: without a word, and without coming out of warp). */
  manual(quiet = false) {
    const had = this.ap || this.orbit;
    if (this.ap) { this.ap = null; if (this.warping && !quiet) this.setWarp(0); }
    this.orbit = null;
    if (had && !quiet) this.g.toast('You have the helm.', 2.5);
  }
  nextDest(dir = 1) {
    // The worlds, with the moons of the planet the ship is at straight after their planet (the others' are a click away on the chart).
    const sol = this.solar, home = this.ref.orb ? this.ref.orb.about : this.ref.id;
    const list = DESTINATIONS.flatMap((id) => [sol.by[id], ...(id === home ? sol.bodies.filter((b) => b.orb && b.orb.about === id) : [])]).filter((b) => b !== this.ref || this.height() > b.R * b.near);
    const i = list.indexOf(this.dest);
    this.setDest(list[(i + dir + list.length) % list.length]);
  }
  /** Lay in a course for a world (N, or a click on its name on the chart). With the helm already flying, it turns for the new one. */
  setDest(b) {
    this.dest = b;
    const [n, u] = distText(this.distTo(b));
    if (this.ap && this.ap.dest !== b) { if (this.warping) this.setWarp(0, true); this.ap = { phase: 'turn', dest: b, t: 0 }; this.g.toast(`New course: ${b.name}, ${n} ${u}.`, 4); return; }
    this.g.toast(`Course laid in: ${b.name}, ${n} ${u}. G to engage.`, 4);
  }
  distTo(b) { const c = this.craft; return Math.hypot(b.r[0] - c.r[0], b.r[1] - c.r[1], b.r[2] - c.r[2]); }
  /** Height above the world the ship belongs to: over the ground where the game holds the ground, else over its sphere. */
  height() { const c = this.craft; return this.ref.id === 'earth' ? Math.max(c.agl, 0) : Math.hypot(this.rel[0], this.rel[1], this.rel[2]) - this.ref.R; }
  /** The lowest the ship can go to warp from, above the world below (m). */
  warpFloor() { return Math.max(0.03 * this.ref.R, 150000); }

  setWarp(w, quiet = false) {
    const g = this.g;
    w = clamp(w, 0, 9);
    if (w < 1) {
      if (this.warp >= 1 && !quiet) g.toast('Out of warp.', 2);
      this.warp = 0; this.spool = 0; this.pending = 0; return;
    }
    if (this.height() < this.warpFloor()) { if (!quiet) g.toast(`Too deep in ${this.ref.name === 'the Sun' ? 'the Sun\'s' : this.ref.name + '\'s'} neighborhood for warp: climb above ${fmt(this.warpFloor() / 1609.344)} miles first.`, 4); return; }
    this.orbit = null;
    if (!quiet) g.toast(`Warp ${w % 1 ? w.toFixed(1) : w}.`, 2);
    if (this.warp >= 1) { this.warp = w; return; }           // already at warp: a new factor, at once
    // From impulse the ship winds up first (the nacelles surge, the motors climb), then jumps: step() does that.
    this.pending = w;
    if (this.spool <= 0) { this.spool = SPOOL; shipSound.spoolUp(SPOOL); }
  }
  /** At warp, or winding up for it. */
  get warping() { return this.warp >= 1 || this.spool > 0; }
  /** T: the next warp factor up, and round again. */
  warpStep() { this.manual(true); const w = this.warp || this.pending; this.setWarp(w >= 9 ? 0 : Math.floor(w) + 1); }

  /** G: the helm flies to the destination. Again, or any control, takes over. */
  engage() {
    const g = this.g, b = this.dest;
    if (this.ap) { this.manual(); return; }
    if (!b) { g.toast('No course laid in: N chooses a destination.', 3); return; }
    const d = this.distTo(b);
    if (d < b.R * b.near * 1.05) { this.ap = null; this.takeOrbit(); return; }
    this.orbit = null;
    this.ap = { phase: 'turn', dest: b, t: 0 };
    const [n, u] = distText(d);
    g.toast(`Course laid in for ${b.name}, ${n} ${u}. Engage.`, 5);
  }
  /** M: the chart of the solar system (solarchart.js), in place of the view of the ship. */
  setMap(on) {
    if (on === this.chartOpen || !this.chart) return;
    this.chartOpen = on; this.m.mapOpen = on;
    this.g.input.zoom = this.g.input.zoomTarget = 1;
    if (on) { this.chart.open(this); this.g.toast('The solar system. Drag to turn it, wheel for nearer and farther, Tab to center on the ship, the destination or the Sun. Click a world to lay in a course; G engages. M closes.', 9); }
    else this.chart.close();
  }
  /** After the view from space has been set up for the frame: the chart's lines and names. */
  chartFrame() { if (this.chartOpen) this.chart.update(); }
  /** C: behind the ship, the view from the bridge, a camera left in space for the ship to pass. */
  toggleView() {
    const order = ['chase', 'bridge', 'flyby'];
    this.view = order[(order.indexOf(this.view) + 1) % order.length];
    this.m.cam.headYaw = 0; this.m.cam.headPitch = 0; this.g.input.zoom = this.g.input.zoomTarget = 1; this.fly = null;
    if (this.view === 'flyby') this.g.toast('A camera in the ship\'s path, watching it go by.', 3);
  }

  /** Is the picture the one from the captain's chair? (mission.js asks: the room wants a near plane of centimeters, and no lens effects.) */
  get inBridge() { return this.view === 'bridge' && !!this.bridge && !this.chartOpen && this.g.S.mode === 'flying'; }

  /**
   * From the captain's chair, can the sun be seen: through the main viewer, or the skylight in the dome? 0..1. The lens
   * effects (flare, rays, veiling glare) are drawn from where the sun is whether or not a wall stands in front of it, so
   * in the room they are let through only by this much.
   */
  sunThrough(br) {
    const m = this.m, sky = m.mix >= 1;
    // The way to the sun in the room's axes (the ship's).
    if (sky) v3.copy(m.cosmos.solar.sunView).applyQuaternion(qI.copy(this.qShown).invert());
    else v3.copy(ENV.uSunDir.value).applyQuaternion(qI.copy(this.qW).invert());
    let best = 0;
    const vw = br.viewer;
    if (vw && v3.z < -0.05) {
      // Where that line from the eye crosses the plane of the viewer.
      const k = (vw.center.z - br.eye.z) / v3.z, x = br.eye.x + v3.x * k - vw.center.x, y = br.eye.y + v3.y * k - vw.center.y;
      best = (1 - smoothstep(0.85, 1.1, Math.abs(x) / (vw.width / 2))) * (1 - smoothstep(0.85, 1.1, Math.abs(y) / (vw.height / 2)));
    }
    const sl = br.skylight;
    if (sl && sl.center && v3.y > 0.05) {
      const k = (sl.center.y - br.eye.y) / v3.y, x = br.eye.x + v3.x * k - sl.center.x, z = br.eye.z + v3.z * k - sl.center.z, r = Math.hypot(x / (sl.rx || sl.radius || 0.8), z / (sl.rz || sl.radius || 0.8));
      best = Math.max(best, 1 - smoothstep(0.8, 1.1, r));
    }
    return best;
  }

  /** O: circle the world below at this height, bow along the way round, level with the horizon. */
  takeOrbit(quiet = false) {
    if (!quiet && this.height() < this.warpFloor()) { this.g.toast(`Too low for a standard orbit: climb above ${fmt(this.warpFloor() / 1609.344)} miles.`, 4); return; }
    const rel = this.rel, d = Math.hypot(rel[0], rel[1], rel[2]);
    toDraw(rel, up1).divideScalar(d);
    v1.copy(FWD).applyQuaternion(this.q); v1.addScaledVector(up1, -v1.dot(up1));
    if (v1.lengthSq() < 0.01) v1.copy(RIGHT).applyQuaternion(this.q).addScaledVector(up1, -v1.dot(up1));
    v1.normalize();
    // (the true rate low down; from high up, where that would not show, never slower than once round in a quarter of an hour)
    this.orbit = { axis: new THREE.Vector3().crossVectors(up1, v1).normalize(), w: Math.max(Math.sqrt(this.ref.mu / (d * d * d)), (TAU / 900) * smoothstep(1.3, 2.6, d / this.ref.R)) };
    this.ap = null; this.warp = 0; this.spool = 0; this.pending = 0;
    if (!quiet) this.g.toast(`Standard orbit of ${this.ref.name}.`, 3);
  }

  // ------------------------------------------------------------------ simulation

  simulate(dt) {
    const m = this.m, g = this.g, c = this.craft, input = g.input;
    if (m.mix < 1) {
      g.weather.update(dt);
      g.weather.sample(g.ac.pos.x, g.ac.pos.y, g.ac.pos.z, groundHeight(g.ac.pos.x, g.ac.pos.z), g.wx);
    }
    const hands = input.raw.pitch || input.raw.roll || input.raw.yaw;
    if (hands && (this.ap || this.orbit)) this.manual();
    if (input.raw.throttle) { if (this.ap || this.orbit) this.manual(); this.thr = clamp(this.thr + input.raw.throttle * 0.5 * dt, 0, 1); }
    const inv = g.S.settings.invert ? -1 : 1;
    const ctl = { pitch: input.pitch * inv, yaw: input.roll, roll: input.yaw };
    let n = Math.max(1, Math.round(dt / STEP));
    const h = dt / n;
    while (n-- > 0) this.step(h, ctl);
    this.jump *= Math.exp(-dt * 2.2);
    m.sats.update(m.clock, c.t);
  }

  /** The helm: where the bow should point (this.want) and how fast to go; returns that speed, or -1 to leave the throttle be. */
  pilot(dt, hs) {
    const ap = this.ap, b = ap.dest, c = this.craft, sol = this.solar, g = this.g;
    ap.t += dt;
    const to = [b.r[0] - c.r[0], b.r[1] - c.r[1], b.r[2] - c.r[2]], dist = Math.hypot(to[0], to[1], to[2]), reach = b.R * b.near;
    if (dist <= reach * 1.03) {
      this.ap = null; if (this.warping) this.setWarp(0, true);
      this.takeOrbit(true);
      this.camEase = 1.2;                                    // the chase camera rises to look down on the ship, the world behind it
      g.toast(`Standard orbit of ${b.name}. Any control takes the helm.`, 6);
      return -1;
    }
    // Aim to one side of the world, toward the sun's side of it, so it is lit when it comes up.
    const dir = [to[0] / dist, to[1] / dist, to[2] / dist], s = b.toSun, sd = s[0] * dir[0] + s[1] * dir[1] + s[2] * dir[2];
    const side = [s[0] - sd * dir[0], s[1] - sd * dir[1], s[2] - sd * dir[2]], sl = Math.hypot(side[0], side[1], side[2]);
    const off = b.id === 'sun' || sl < 0.05 ? 0 : (0.55 * reach) / sl, P = this.sunnyPole(b), po = b.id === 'sun' ? 0 : 0.36 * reach;      // (and to the sunlit side of its equator)
    let aim = [to[0] + side[0] * off + P[0] * po, to[1] + side[1] * off + P[1] * po, to[2] + side[2] * off + P[2] * po], al = Math.hypot(aim[0], aim[1], aim[2]);
    aim = [aim[0] / al, aim[1] / al, aim[2] / al];
    // Is something in the way: the world being left, or the sun? Then go round it.
    let blocked = false, routed = false;
    const planet = (w) => (w.orb ? sol.by[w.orb.about] : null);        // (a moon's planet may stand between the ship and it)
    for (const ob of new Set([this.ref, planet(this.ref), planet(b), sol.sun])) {
      if (!ob || ob === b || routed) continue;
      const cx = ob.r[0] - c.r[0], cy = ob.r[1] - c.r[1], cz = ob.r[2] - c.r[2], od = Math.hypot(cx, cy, cz), proj = cx * aim[0] + cy * aim[1] + cz * aim[2];
      if (proj <= 0 || proj > al) continue;
      const clear = od > ob.R * ob.near ? ob.R * ob.near * 1.08 : ob.R * (1.06 + (ob.low || 0));
      const px = cx - proj * aim[0], py = cy - proj * aim[1], pz = cz - proj * aim[2], pl = Math.hypot(px, py, pz);
      if (pl >= clear) continue;
      // A point beside it, on the side the course already leans to (or, dead ahead, the way the ship's top points).
      let ox = -px, oy = -py, oz = -pz, ol = pl;
      if (pl < clear * 0.02) { fromDraw(v1.copy(UP).applyQuaternion(this.q), tA); const k = tA[0] * aim[0] + tA[1] * aim[1] + tA[2] * aim[2]; ox = tA[0] - k * aim[0]; oy = tA[1] - k * aim[1]; oz = tA[2] - k * aim[2]; ol = Math.hypot(ox, oy, oz) || 1; }
      const wx = cx + (ox / ol) * clear * 1.35, wy = cy + (oy / ol) * clear * 1.35, wz = cz + (oz / ol) * clear * 1.35, wl = Math.hypot(wx, wy, wz);
      aim = [wx / wl, wy / wl, wz / wl]; routed = true;
      blocked = od <= ob.R * ob.near;                          // close under a world: no warp until the way is clear (a far one is simply steered round, at warp)
    }
    toDraw(aim, this.want);
    const ang = v1.copy(FWD).applyQuaternion(this.q).angleTo(this.want);
    const trip = dist - reach;
    if (ap.phase === 'warp') {
      if (!this.warping) ap.phase = 'turn';                    // something brought the ship out of warp short of the destination: lay the course in again
      else if (blocked) { this.setWarp(0, true); ap.phase = 'turn'; }
      else return -1;
    }
    if (ap.phase === 'turn') {
      const deep = hs < this.warpFloor();
      if (ang < 0.012 && !blocked && !deep) {
        // The warp factor that makes the trip about a quarter of a minute; below warp 1, the impulse engines do it.
        const w = warpOf(trip / 14);
        if (w >= 1) { const f = Math.min(Math.round(w * 10) / 10, 9); this.setWarp(f, true); ap.phase = 'warp'; g.toast(`Warp ${f % 1 ? f.toFixed(1) : f}. Engaged.`, 3); return -1; }
        ap.phase = 'cruise';
      } else return blocked || deep ? this.vmax(hs, 0.5) * (ang < 0.6 ? 1 : 0.25) : 0;      // climbing out and round while the bow comes about
    }
    // Under impulse all the way: quickly out, then slowing as the destination comes up.
    return Math.min(FULL_IMPULSE, this.vmax(hs, 0.5), 0.55 * trip + 400) * (ang < 0.3 ? 1 : 0.2);
  }

  /** The fastest the impulse engines go at a height above the world below (m/s): k is the share of that height covered in a second, out in the open. */
  vmax(hs, k = 0.18) { return Math.min(FULL_IMPULSE, 420 + hs * (0.08 + (k - 0.08) * smoothstep(2e4, 1.5e5, hs))); }

  /** One step of flight (dt up to about 1/30 s). ctl: { pitch, yaw, roll }, each -1..1. */
  step(dt, ctl) {
    const m = this.m, c = this.craft, sol = this.solar, rel = this.rel, q = this.q;
    c.t += dt; c.met += dt;
    sol.place(m.clock, c.t);
    const ref = this.ref, d0 = Math.hypot(rel[0], rel[1], rel[2]), hs = this.height();
    toDraw(rel, up1).divideScalar(d0);
    // How closely the ship follows the curve of the world below: wholly when low, not at all from far off or at warp.
    const follow = this.atWarp ? 0 : 1 - smoothstep(0.08 * ref.R, 0.6 * ref.R, d0 - ref.R);

    // ---- the helm, or the player's hands
    let wp = 0, wy = 0, wr = 0, apSpeed = -1, steer = false;
    if (this.orbit) {
      this.want.crossVectors(this.orbit.axis, up1).normalize(); this.wantUp.copy(up1); steer = true;
    } else if (this.ap) {
      apSpeed = this.pilot(dt, hs);
      if (this.ap) { steer = true; this.wantUp.set(0, 0, 0); }
    }
    if (steer) {
      // Turn the bow onto the course by the shortest way, and (in orbit) the top away from the world.
      v1.copy(FWD).applyQuaternion(q); v2.crossVectors(v1, this.want);
      const sin = v2.length(), ang = Math.atan2(sin, v1.dot(this.want));
      if (sin > 1e-6) {
        v2.multiplyScalar(1 / sin).applyQuaternion(qI.copy(q).invert());
        const rate = Math.min(ang * 1.6, this.atWarp ? 0.25 : 0.55);
        wp = v2.x * rate; wy = v2.y * rate;
      }
      if (this.wantUp.lengthSq() > 0) wr = -0.9 * v3.copy(RIGHT).applyQuaternion(q).dot(this.wantUp);
    } else {
      const slow = this.atWarp ? 0.3 : 1;
      wp = ctl.pitch * 0.4 * slow; wy = -ctl.yaw * 0.32 * slow; wr = -ctl.roll * 0.7;
      // Near a world, with the hands off the roll, the ship rights itself against the horizon.
      if (follow > 0 && Math.abs(ctl.roll) < 0.05) {
        v1.copy(FWD).applyQuaternion(q); v2.copy(up1).addScaledVector(v1, -up1.dot(v1));
        const l = v2.length();
        if (l > 0.25) wr += -0.8 * follow * v3.copy(RIGHT).applyQuaternion(q).dot(v2) / l;
      }
    }
    const k = 1 - Math.exp(-dt / 0.3);
    this.rate.x += (wp - this.rate.x) * k; this.rate.y += (wy - this.rate.y) * k; this.rate.z += (wr - this.rate.z) * k;
    q.multiply(q1.setFromEuler(eu.set(this.rate.x * dt, this.rate.y * dt, this.rate.z * dt, 'YXZ'))).normalize();
    this.bank += (clamp(-this.rate.y * 0.9, -0.45, 0.45) - this.bank) * (1 - Math.exp(-dt * 1.5));

    // ---- speed
    if (this.spool > 0 && (this.spool -= dt) <= 0) {
      // Wound up: the jump.
      this.spool = 0; this.warp = this.pending; this.pending = 0; this.jump = 1;
      this.speed = Math.max(this.speed, 0.35 * LIGHT);       // (gone at once: the rest of the way to the factor's speed follows in a moment)
      this.g.clouds.uFlashScreen.value = Math.max(this.g.clouds.uFlashScreen.value, 0.3);
      shipSound.jump();
    }
    if (this.warp >= 1 && hs < this.warpFloor() * 0.5) this.setWarp(0, true);
    let target;
    if (this.warp >= 1) target = warpSpeed(this.warp);
    else if (apSpeed >= 0) target = apSpeed;
    else target = this.thr * this.thr * this.vmax(hs);
    if (this.orbit) target = 0;
    const was = this.atWarp;
    if (this.warp >= 1 || this.speed > LIGHT) {
      // In and out of warp: the speed moves by its order of magnitude, in a moment.
      const a = Math.log(Math.max(this.speed, 100)), b = Math.log(Math.max(target, 100));
      this.speed = Math.exp(a + (b - a) * (1 - Math.exp(-dt / 0.22)));
    } else this.speed += (Math.min(target, this.vmax(hs, 0.5)) - this.speed) * (1 - Math.exp(-dt / (target < this.speed ? 0.6 : 1.2)));
    this.atWarp = this.speed > 0.3 * LIGHT;                  // (the impulse engines stop at a quarter of light: anything faster is the warp drive's)
    if (was && !this.atWarp) { this.jump = Math.max(this.jump, 0.6); this.g.clouds.uFlashScreen.value = Math.max(this.g.clouds.uFlashScreen.value, 0.18); shipSound.drop(); }

    // ---- motion
    v1.copy(FWD).applyQuaternion(q); fromDraw(v1, c.nose);
    const nose = c.nose;
    if (this.orbit) {
      // Round the world: the place is turned about the orbit's axis, and the ship's attitude with it.
      const a = this.orbit.w * dt;
      toDraw(rel, v2).applyAxisAngle(this.orbit.axis, a); fromDraw(v2, rel);
      q.premultiply(q1.setFromAxisAngle(this.orbit.axis, a));
      this.orbitSpeed = this.orbit.w * d0;
    } else {
      let L = this.speed * dt;
      if (this.atWarp) {
        // Out of warp by itself, where the way ahead runs into a world's neighborhood (or, leaving one, into the world).
        let stop = null;
        const r = c.r;
        for (const b of sol.bodies) {
          const cx = b.r[0] - r[0], cy = b.r[1] - r[1], cz = b.r[2] - r[2], proj = cx * nose[0] + cy * nose[1] + cz * nose[2];
          if (proj <= 0) continue;
          const d2 = cx * cx + cy * cy + cz * cz, far = b.R * b.near, keep = d2 > far * far * 1.002 ? far : b.R * (1.03 + (b.low || 0)), perp2 = d2 - proj * proj;
          if (perp2 >= keep * keep) continue;
          const s = proj - Math.sqrt(keep * keep - perp2);
          if (s < L) { L = Math.max(s, 0); stop = b; }
        }
        if (stop) {
          // (and nearly at rest: at a fraction of light the ship would be through the planet before the engines had spooled down)
          const left = Math.hypot(stop.r[0] - r[0] - nose[0] * L, stop.r[1] - r[1] - nose[1] * L, stop.r[2] - r[2] - nose[2] * L) - stop.R;
          this.warp = 0; this.speed = Math.min(this.speed, 0.12 * Math.max(left, 0) + 200);
          if (!this.ap) this.g.toast(`Out of warp: ${stop.name} ahead.`, 4);
        }
      }
      const vr = this.speed * (nose[0] * rel[0] + nose[1] * rel[1] + nose[2] * rel[2]) / d0;
      rel[0] += nose[0] * L; rel[1] += nose[1] * L; rel[2] += nose[2] * L;
      if (follow > 0) {
        // Level flight keeps its height: the straight step is bent onto the curve of the world.
        const dStr = Math.hypot(rel[0], rel[1], rel[2]), dWant = dStr + (d0 + vr * dt - dStr) * follow, s = dWant / dStr;
        rel[0] *= s; rel[1] *= s; rel[2] *= s;
      }
    }
    // Low over the Earth the ship is carried round with the ground (and a camera left in its path with it).
    if (ref.id === 'earth' && !this.orbit) {
      const carry = 1 - smoothstep(1e5, 2e6, d0 - ref.R);
      if (carry > 0) {
        const a = OMEGA_E * dt * carry, ca = Math.cos(a), sa = Math.sin(a), x = rel[0], y = rel[1];
        rel[0] = x * ca - y * sa; rel[1] = x * sa + y * ca;
        q.premultiply(q1.setFromAxisAngle(UP, a));
        if (this.fly) { const f = this.fly.pos, fx = f[0], fy = f[1]; f[0] = fx * ca - fy * sa; f[1] = fx * sa + fy * ca; }
      }
    }
    // The floor: the ground and the ship's own depth below its center; a margin over a world with no ground to stand on.
    let d1 = Math.hypot(rel[0], rel[1], rel[2]);
    {
      let floor = ref.R * (1 + (ref.low || 0));
      if (ref.id === 'earth') {
        eciToGeo(m.clock, c.t, rel, geo);
        // (with no ground in hand the ship stays where the view from space still serves, or as low as it already is)
        floor = m.groundOK ? RE + m.groundAt(geo.lat, geo.lon) + KEEL : Math.min(RE + MIX_HI + 4000, Math.max(d0, RE + KEEL));
      }
      if (d1 < floor) { const s = floor / d1; rel[0] *= s; rel[1] *= s; rel[2] *= s; d1 = floor; }
    }
    // The attitude follows the horizon round.
    if (follow > 0 && !this.orbit) {
      toDraw(rel, up2).divideScalar(d1);
      q1.setFromUnitVectors(up1, up2);
      if (follow < 1) q1.slerp(q2.identity(), 1 - follow);
      q.premultiply(q1).normalize();
    }
    // Out in the open, left alone or not, the ship is falling round the sun.
    if (ref.id === 'sun' && !this.orbit) {
      const k = (-ref.mu / (d0 * d0 * d0)) * dt, v = this.drift;
      for (let i = 0; i < 3; i++) { v[i] += rel[i] * k; rel[i] += v[i] * dt; }
    }
    // ---- which world it belongs to now
    for (let i = 0; i < 3; i++) c.r[i] = ref.r[i] + rel[i];
    const nb = sol.nearest(c.r, ref);
    if (nb !== ref) {
      if (nb.id === 'sun') sol.velocity(this.planetOf(ref), m.clock, c.t, this.drift);      // leaving a world for the open: the ship keeps that world's way round the sun
      this.ref = nb; this.orbit = null;
      for (let i = 0; i < 3; i++) rel[i] = c.r[i] - nb.r[i];
    }
    this.data(dt);
  }

  /** The planet a world belongs with: itself, or the planet a moon goes round. */
  planetOf(b) { return b.orb ? this.solar.by[b.orb.about] : b.id === 'moon' ? this.solar.earth : b; }
  /** Where the ship goes if left alone: its place and velocity round the sun ({ p, u }: m and m/s, the axes of frames.js). By a world it goes round the sun with that world. */
  trajectory() {
    const sol = this.solar, s = sol.sun.r, c = this.craft.r, p = [c[0] - s[0], c[1] - s[1], c[2] - s[2]];
    if (this.ref.id === 'sun') return { p, u: this.drift };
    return { p, u: sol.velocity(this.planetOf(this.ref), this.m.clock, this.craft.t, this.tu || (this.tu = [0, 0, 0])) };
  }
  /** Is the ship clear above the air, where the view from space is the whole picture? (main.js asks: such a ship flies on while the country below is being fetched.) */
  get aloft() { return this.ref.id !== 'earth' || this.craft.alt > MIX_HI + 2000; }

  /** Refresh what the rest of the game reads of the craft. */
  data(dt) {
    const m = this.m, c = this.craft, ref = this.ref, rel = this.rel;
    for (let i = 0; i < 3; i++) c.r[i] = ref.r[i] + rel[i];
    fromDraw(v1.copy(FWD).applyQuaternion(this.q), c.nose);
    c.body = ref.id;
    const was = c.alt;
    if (ref.id === 'earth') {
      eciToGeo(m.clock, c.t, c.r, geo);
      c.lat = geo.lat; c.lon = geo.lon; c.alt = geo.alt; c.agl = geo.alt - (m.groundOK ? m.groundAt(geo.lat, geo.lon) : 0);
    } else { c.alt = Math.hypot(rel[0], rel[1], rel[2]) - ref.R; c.agl = c.alt; }
    c.vs = dt > 0 ? (c.alt - was) / dt : 0;
    if (c.alt > c.maxAlt) c.maxAlt = c.alt;
  }

  // ------------------------------------------------------------------ where everything is, this frame

  frame(dt) {
    const m = this.m, g = this.g, c = this.craft, ac = g.ac, cam = g.camera, input = g.input;
    const onEarth = this.ref.id === 'earth';
    const p = onEarth ? toWorld(c.lat, c.lon) : { x: 1e9, z: 1e9 };
    m.groundOK = onEarth && !g.S.moving && Math.abs(p.x) < WORLD_HALF - 30000 && Math.abs(p.z) < WORLD_HALF - 30000;      // (not while the window of the world is being moved under the ship: main.js)
    const charting = this.chartOpen;
    m.mix = m.forceMix ?? (charting ? 1 : m.groundOK ? smoothstep(MIX_LO, MIX_HI, c.alt) : 1);

    // The ship in the game world's axes (the same attitude, seen from the ground under it).
    worldToRenderQuat(onEarth ? c.r : this.rel, qWR, m1);
    this.qW.copy(qWR).invert().multiply(this.q);
    q1.setFromAxisAngle(FWD, this.bank);
    m.qLocal.copy(this.qW).multiply(q1);
    this.qShown.copy(this.q).multiply(q1);                 // (as drawn: with the lean of the turn)
    if (m.groundOK) {
      m.posW.set(p.x, c.alt, p.z);
      ac.pos.copy(m.posW);
      v1.copy(FWD).applyQuaternion(this.qW);
      ac.quat.setFromAxisAngle(UP, Math.atan2(-v1.x, -v1.z));
      ac.vel.copy(v1).multiplyScalar(this.speed);
      ac.agl = Math.max(c.agl, 0); ac.maxAgl = c.maxAlt; ac.tas = this.speed; ac.ias = Math.min(this.speed, 130) * Math.sqrt(airPressure(c.alt)); ac.onGround = false;      // (the wind's sound is the game's, made for airplanes: it hears no more than an airliner's speed)
      ac.gLoad = 1; ac.throttle = this.thr; ac.thrustLevel = this.thr; ac.crashed = null; ac.stall = 0; ac.surface = 'paved';
    }
    m.baseW.copy(m.posW);

    // ---- cameras: everything is worked out in the drawing axes of the view from space, about the ship
    const cc = m.cam, look = input.look;
    if (charting) {
      // The mouse is the chart's: drag turns it, and the wheel (which the game keeps as a factor near 1) takes it nearer or farther.
      this.chart.drag(look.yaw, look.pitch, Math.pow(input.zoomTarget, 4), dt);
      input.zoom = input.zoomTarget = 1;
    } else if (this.view === 'bridge') { cc.headYaw = clamp(cc.headYaw + look.yaw, -3.1, 3.1); cc.headPitch = clamp(cc.headPitch - look.pitch, -1.3, 1.3); }      // (the room's own reach is applied below)
    else {
      if (look.yaw || look.pitch) this.camEase = null;
      if (this.camEase != null && dt > 0) { cc.pitch += (this.camEase - cc.pitch) * (1 - Math.exp(-dt * 1.6)); if (Math.abs(this.camEase - cc.pitch) < 0.01) this.camEase = null; }
      cc.yaw += look.yaw; cc.pitch = clamp(cc.pitch + look.pitch, -1.45, 1.45);      // (a drag swings the camera the way it does round the airplanes and the rockets)
    }
    look.yaw = 0; look.pitch = 0;
    input.zoom += (input.zoomTarget - input.zoom) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 9));
    // The chase camera's frame trails the ship's, so a turn shows as a turn.
    if (dt > 0) this.camQ.slerp(this.q, 1 - Math.exp(-dt * 2.4)); else if (g.S.mode !== 'flying') this.camQ.copy(this.q);
    const wind = this.spool > 0 ? 1 - this.spool / SPOOL : 0;                // how far the ship has wound up for the jump, 0..1
    const kick = (1 + 0.45 * this.jump) * (1 - 0.1 * wind * wind);          // the lens draws in as it winds up, and opens as it jumps
    const eye = v2, qc = q2; let fov = 55, view = charting ? 'chase' : this.view;
    const going = this.orbit ? this.orbitSpeed : this.speed;
    if (view === 'flyby' && (this.atWarp || going > 4e5)) view = 'chase';                 // (too fast for any camera to be left in its path)
    this.model.root.visible = view !== 'bridge';
    const br = this.bridge, seated = view === 'bridge' && !!br && g.S.mode === 'flying';
    let sunIn = 1;                                           // how much of the sun's glare reaches the lens: in the bridge, only what comes through an opening
    if (br) br.root.visible = seated;
    if (seated) {
      // The captain's chair: the room's own eye point, the head turned by the mouse, and the deck trembling as the ship jumps.
      const R = br.reach || { yaw: 2.6, up: 1.1, down: 0.9 }, t = g.S.time, shake = 0.012 * this.jump + 0.004 * wind;
      cc.headYaw = clamp(cc.headYaw, -R.yaw, R.yaw); cc.headPitch = clamp(cc.headPitch, -R.down, R.up);
      // (All in the ship's axes as the ship is drawn, the lean of a turn included: the room leans with the hull, a hundred
      // feet above the axis it leans about, and an eye left upright was thrown out through the wall by every turn.)
      eye.copy(br.root.position).add(br.eye);
      eye.x += shake * Math.sin(t * 47.0); eye.y += shake * Math.sin(t * 61.3 + 1.0); eye.z += shake * Math.sin(t * 53.7 + 2.0);
      eye.applyQuaternion(this.qShown);
      qc.copy(this.qShown).multiply(q1.setFromEuler(eu.set(cc.headPitch, cc.headYaw, 0, 'YXZ')));
      fov = clamp((br.fov || 62) * input.zoom * (1 + 0.12 * this.jump), 22, 100);
      sunIn = this.sunThrough(br);
    } else if (view === 'bridge') {
      // (no room to sit in: the bare view ahead, from the top of the saucer)
      eye.copy(this.model.points?.bridge || v3.set(0, 30, -128)).add(v3.set(0, 4, -6)).applyQuaternion(this.q);
      qc.copy(this.q).multiply(q1.setFromEuler(eu.set(cc.headPitch, cc.headYaw, 0, 'YXZ')));
      fov = clamp(68 * input.zoom * kick, 25, 110);
    } else if (view === 'flyby') {
      // A camera left in space ahead of the ship, a little to one side: it watches the ship come, pass and go, then is set down again.
      const f = this.fly, rel = this.rel;
      const gone = f && Math.hypot(f.pos[0] - rel[0], f.pos[1] - rel[1], f.pos[2] - rel[2]);
      if (!f || f.ref !== this.ref || gone > f.reach * 1.6 || (gone > f.reach * 0.5 && v3.set(f.pos[0] - rel[0], f.pos[2] - rel[2], -(f.pos[1] - rel[1])).dot(v1.copy(FWD).applyQuaternion(this.q)) < -f.reach * 0.9)) {
        const lead = clamp(going * 3.5, SIZE * 2.2, 60000), side = SIZE * (0.55 + 0.25 * Math.random()) * (Math.random() < 0.5 ? -1 : 1);
        v3.set(side, SIZE * (0.3 * Math.random() - 0.08), -lead).applyQuaternion(this.q); fromDraw(v3, tA);
        this.fly = { pos: [rel[0] + tA[0], rel[1] + tA[1], rel[2] + tA[2]], ref: this.ref, reach: lead, up: new THREE.Vector3().copy(UP).applyQuaternion(this.q) };
      }
      const fp = this.fly.pos;
      eye.set(fp[0] - rel[0], fp[2] - rel[2], -(fp[1] - rel[1]));
      m1.lookAt(eye, v3.set(0, 0, 0), this.fly.up); qc.setFromRotationMatrix(m1);
      fov = clamp((2 * Math.atan((SIZE * 1.1) / Math.max(eye.length(), 1)) / D2R) * input.zoom, 3, 62);
    } else {
      const dist = clamp(SIZE * 2.3 * cc.dist * input.zoom, SIZE * 0.75, 40000);
      eye.set(Math.sin(cc.yaw) * Math.cos(cc.pitch), Math.sin(cc.pitch), Math.cos(cc.yaw) * Math.cos(cc.pitch)).multiplyScalar(dist).applyQuaternion(this.camQ);
      m1.lookAt(eye, v3.set(0, SIZE * 0.03, 0).applyQuaternion(this.camQ), v4.copy(UP).applyQuaternion(this.camQ)); qc.setFromRotationMatrix(m1);
      fov = clamp(55 * kick, 20, 100);
    }
    // The same camera in the game's world, kept out of the ground.
    if (m.mix < 1) {
      qI.copy(qWR).invert();
      v3.copy(eye).applyQuaternion(qI);
      const floor = groundHeight(m.posW.x + v3.x, m.posW.z + v3.z) + 3 - m.posW.y;
      if (v3.y < floor && view !== 'bridge') {
        v3.y = floor; eye.copy(v3).applyQuaternion(qWR);
        m1.lookAt(eye, ZERO, v4.copy(UP).applyQuaternion(view === 'flyby' ? qWR : this.camQ)); qc.setFromRotationMatrix(m1);
      }
      cam.position.copy(m.posW).add(v3); cam.quaternion.copy(qI).multiply(qc); cam.up.set(0, 1, 0);
      cam.fov = fov; cam.near = seated ? 0.06 : 2; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      if (dt > 0) g.camState.vel.copy(cam.position).sub(g.camState.prev).multiplyScalar(1 / dt);
      g.camState.prev.copy(cam.position);
    }
    if (charting) {
      m.fov = this.chart.camera(m.eye, m.eyeQuat);
      m.camDist = Math.hypot(m.eye[0] - c.r[0], m.eye[1] - c.r[1], m.eye[2] - c.r[2]);
    } else {
      fromDraw(eye, tA);
      for (let i = 0; i < 3; i++) m.eye[i] = c.r[i] + tA[i];
      m.eyeQuat.copy(qc); m.fov = fov; m.camDist = eye.length();
    }

    // ---- the model and its lights
    // (in space, "night" is how little sun reaches the ship: a world's shadow, or the dimness of the outer planets, where it lights itself)
    const night = m.mix >= 1 ? 1 - clamp(m.cosmos.sunlit * m.cosmos.solar.sunPower * 1.2, 0, 1) : ENV.uNight.value;
    const power = this.atWarp ? 1 : clamp(this.speed / Math.max(this.vmax(this.height()), 1), 0, 1);
    const impulse = this.orbit ? 0.25 : Math.max(power, this.thr * 0.6);
    this.model.update(dt, { time: g.S.time, impulse, warp: this.atWarp ? 1 : this.warp >= 1 ? 0.7 : 0.12 + 0.5 * wind, night, flash: Math.max(this.jump, wind * wind) });
    { const fx = g.clouds.fx; fx.flare = fx.glare = fx.rays = sunIn; }
    if (seated) {
      const d = this.dest, ap = this.ap;
      br.update(dt, {
        time: g.S.time, exposure: m.mix >= 1 ? (m.expo || 1) : g.sky.exposure,          // (how far the picture is opened up against daylight: the room holds its own lights steady against it)
        speed: this.orbit ? this.orbitSpeed : this.speed, warp: this.atWarp ? Math.max(1, warpOf(this.speed)) : 0, spool: wind, impulse,
        world: this.ref.name.replace(/^the /, ''), height: Math.max(this.height(), 0), dest: d ? d.name.replace(/^the /, '') : null, distance: d ? Math.max(this.distTo(d) - d.R, 0) : 0,
        helm: ap ? (ap.phase === 'turn' ? 'coming about' : ap.phase === 'warp' ? `at warp for ${ap.dest.name}` : `on impulse for ${ap.dest.name}`) : null, orbit: !!this.orbit,
      });
    }
    if (this.glow) {
      const surge = Math.max(this.jump, wind * wind), k = (this.atWarp ? 0.9 : 0.5 * wind) + 9 * surge * surge, on = k > 0.01 && view !== 'bridge';
      this.glow.mat.color.setRGB(0.2, 0.48, 1).multiplyScalar(k);
      for (const o of this.model.root.children) if (o.isSprite) o.visible = on;
    }
    shipSound.attach(g.sound);
    shipSound.update(dt, { on: g.S.mode === 'flying' && !g.S.busy, view, impulse: this.atWarp ? 0.5 : impulse, warp: this.atWarp ? Math.max(1, warpOf(this.speed)) : 0, spool: wind, dist: m.camDist });
    this.streakAmt += ((this.atWarp ? 1 : 0) - this.streakAmt) * (dt > 0 ? 1 - Math.exp(-dt * (this.atWarp ? 5 : 9)) : 0);
    this.streaks.update(dt, this.streakAmt, this.atWarp ? warpOf(this.speed) : 1, this.jump);
    this.groundPose();
    m.ambience = m.groundOK ? Math.sqrt(airPressure(c.alt)) * (1 - m.mix) : 0;
    this.hud(dt);
  }

  /** The ship in the game's scene. */
  groundPose() {
    const m = this.m;
    this.root.position.copy(m.posW); this.root.quaternion.copy(m.qLocal); this.root.visible = m.groundOK;
  }
  /** And in the view from space: relative to its camera, in its axes. */
  spacePose() {
    this.root.visible = true;
    this.root.quaternion.copy(this.qShown || this.q);
    this.m.cosmos.place(this.root, this.craft.r);
  }

  // ------------------------------------------------------------------ the panel

  hud(dt) {
    const m = this.m, c = this.craft, sol = this.solar;
    this.mark();
    if ((this.uiT -= dt) > 0 && dt > 0) return;
    this.uiT = 0.1;
    const put = (id, t) => { const e = $(id); if (e && e.textContent !== t) e.textContent = t; };
    const ann = (id, on, text) => { const e = $(id); if (!e) return; if (e.hidden === on) e.hidden = !on; if (on && text != null) put(id + 'V', text); };
    put('spThr', `${Math.round(this.thr * 100)}%`);
    const bar = $('spThrBar'); if (bar) bar.style.width = `${Math.round(this.thr * 100)}%`;
    const v = this.orbit ? this.orbitSpeed || 0 : this.speed;
    if (this.atWarp) { put('spSpdLbl', 'Warp'); put('spSpd', warpOf(v).toFixed(1)); put('spSpdU', `${fmt(v / LIGHT)} c`); }
    else {
      put('spSpdLbl', 'Speed');
      if (v < 2e4) { put('spSpd', fmt(v * 2.23694)); put('spSpdU', 'mph'); }
      else if (v < 0.01 * LIGHT) { put('spSpd', fmt(v / 1609.344)); put('spSpdU', 'mi/s'); }
      else { put('spSpd', (v / LIGHT).toFixed(2)); put('spSpdU', 'c'); }
    }
    put('spDrive', this.atWarp || this.spool > 0 ? 'Warp drive' : this.orbit ? 'Standard orbit' : 'Impulse');
    put('spAltLbl', `Above ${this.ref.name}`);
    const h = this.ref.id === 'earth' && m.groundOK && c.alt < 20000 ? Math.max(c.agl - KEEL + 60, 0) : c.alt;
    if (this.ref.id === 'earth' && h < 15240) { put('spAlt', fmt(h * 3.28084)); put('spAltU', 'ft'); }
    else { const [n, u] = distText(h); put('spAlt', n); put('spAltU', u); }
    const b = this.dest;
    if (b) { const [n, u] = distText(Math.max(this.distTo(b) - b.R, 0)); put('spTgt', b.name.replace(/^the /, '')); put('spTgtD', `${n} ${u}`); }
    else { put('spTgt', '—'); put('spTgtD', ''); }
    const ap = this.ap;
    ann('spAuto', !!ap, ap ? (ap.phase === 'turn' ? 'coming about' : ap.phase === 'warp' ? `at warp for ${ap.dest.name}` : `on impulse for ${ap.dest.name}`) : '');
    ann('spOrb', !!this.orbit, this.ref.name.replace(/^the /, ''));
    put('warn', '');
  }

  /** The bracket round the destination, where it is in the picture. */
  mark() {
    const m = this.m, b = this.dest, el = $('spMark');
    if (!el) return;
    let show = false;
    if (b && m.mix >= 1 && !this.chartOpen && !this.inBridge && this.g.S.mode === 'flying' && !this.g.S.paused) {      // (not from the bridge: its walls are in the way, and ops has the course)
      v1.set(b.r[0] - m.eye[0], b.r[2] - m.eye[2], -(b.r[1] - m.eye[1]));
      const dist = v1.length();
      v1.applyQuaternion(qI.copy(m.eyeQuat).invert());
      const tY = Math.tan((m.fov * D2R) / 2), tX = tY * this.g.camera.aspect;
      if (v1.z < 0 && b.R / dist < 0.12 * tY) {
        const x = v1.x / (-v1.z * tX), y = v1.y / (-v1.z * tY);
        if (Math.abs(x) < 0.97 && Math.abs(y) < 0.94) {
          show = true;
          const w = el.parentElement.clientWidth, h = el.parentElement.clientHeight, size = Math.max(22, (b.R / dist / tY) * h + 14);
          el.style.transform = `translate(${((x * 0.5 + 0.5) * w).toFixed(1)}px, ${((0.5 - y * 0.5) * h).toFixed(1)}px)`;
          el.style.setProperty('--s', `${size.toFixed(0)}px`);
          const t = $('spMarkT'); if (t && t.textContent !== b.name.replace(/^the /, '')) t.textContent = b.name.replace(/^the /, '');
        }
      }
    }
    if (el.hidden === show) el.hidden = !show;
  }

  /** A line for the start of a flight. */
  hello(where) {
    const b = this.ref;
    return where === 'low' ? `The Enterprise, low over ${this.m.site?.name || 'the place chosen'}. W S A D fly her, R and F are the impulse engines; climb out of the air for warp. Esc for controls.`
      : `The Enterprise in standard orbit of ${b.name}. N chooses a destination and G flies there; or take the helm: W S A D, R and F for impulse, period and comma for warp. Esc for controls.`;
  }
}
