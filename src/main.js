// Dead Reckoning — boot, game loop and flight logic.

import * as THREE from 'three';
import { ENV } from './core/env.js';
import { Input } from './core/input.js';
import { Sound } from './core/audio.js';
import { clamp, noise1, smoothstep } from './core/noise.js';
import * as dem from './world/dem.js';
import { REGION, RECENTER_AT, setRegion, toWorld, toLatLon } from './world/geo.js';
import { groundHeight, isWater, buildWorld, BN } from './world/terrain.js';
import { loadAirports, clearAirports, inWindow, AIRPORTS, FIELDS, fieldById, DEFAULT_FIELD, airportById, nearestAirport, airfieldSurface } from './world/airports.js';
import { OSM_ATTRIBUTION } from './world/airfield-index.js';
import { Terrain, setUrbanGrid } from './world/chunks.js';
import { Sky } from './world/sky.js';
import { STARS_CREDIT } from './world/stars.js';
import { skyRadiance } from './world/atmosphere.js';
import { Airfields } from './world/airfield.js';
import { TownLights, loadTowns, placeTowns, TOWNS_ATTRIBUTION } from './world/towns.js';
import { Cities, CITY_ATTRIBUTION } from './world/cities.js';
import { Imagery, IMAGERY_ATTRIBUTION } from './world/imagery.js';
import { GroundLight } from './world/groundlight.js';
import { SunShadows } from './world/sunshadow.js';
import { Weather, SITUATIONS, CLOUD_SIGMA } from './weather/weather.js';
import { CloudRenderer } from './weather/clouds.js';
import { Precip } from './weather/precip.js';
import { Aircraft, FT, NM } from './aircraft/physics.js';
import { buildAircraft, animateAircraft, disposeAircraft } from './aircraft/model.js';
import { AIRCRAFT, aircraftById } from './aircraft/variants.js';
import { cockpitCamera } from './aircraft/cockpitcam.js';
import { Chart, bakeChart, loadOverview, fmtPlace } from './ui/chart.js';
import { perf } from './render/perf.js';
import { uploads } from './render/budget.js';
import { DynRes } from './render/dynres.js';
import { AutoQuality, tierForHardware, TIER_NAMES } from './render/autoquality.js';
import { FlightPanel, FrameMeter, weatherWords, passRows, fahrenheit, visibilityWords } from './ui/hud.js';
import { enhanceSelect, syncPickers } from './ui/picker.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const STEP = 1 / 120;
const SAVE_KEY = 'dead-reckoning-v3';     // bumped when the defaults changed (high graphics), so old saves do not pin the old ones
const SAVE_VERSION = 3;
const HOURS = [[5.7, 'First light'], [7.5, 'Early morning'], [10, 'Morning'], [13, 'Midday'], [15.5, 'Afternoon'], [17.3, 'Golden hour'], [18.4, 'Dusk'], [22, 'Night']];
// Yield to the browser so loading text can paint; the timeout keeps boot moving in a background tab.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 60); });
const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const magnetic = (trueDeg) => (trueDeg - REGION.magVar + 720) % 360;

// ------------------------------------------------------------------ state

// How rough each kind of weather leaves open water whatever the wind at the aircraft says (0 calm .. 1 a storm sea).
let seaSnap = true;          // set the water's state outright on the next frame (a flight starting, weather set at once)
const SEA_STATE = { storms: 0.85, scattered: 0.55, hail: 0.8, coldfront: 0.7, gale: 0.9, monsoon: 0.8, blizzard: 0.9, lakeeffect: 0.75, icestorm: 0.45, derecho: 1, chinook: 0.7, rain: 0.35, snow: 0.3 };
const S = {
  mode: 'loading', paused: false, timeAccel: 1, view: 'chase', chartOpen: false, time: 0, busy: false, frost: 0, moving: false,
  flight: null, field: null,
  opts: { field: DEFAULT_FIELD, wx: 'fair', hour: 7.5, air: false, plane: 'c172' },
  settings: { sound: true, invert: false, quality: 'auto', autoTier: '', imagery: true, exposure: 1, fx: {}, wxOver: 0, resolution: 'auto' },   // wxOver: seconds a weather change takes (0 = at once); resolution: 'auto' (follows the frame rate) or 'fixed'
};
try {
  const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (raw) {
    Object.assign(S.opts, raw.opts || {}); Object.assign(S.settings, raw.settings || {});
    if ((raw.v || 1) < 2) S.opts.hour = 7.5;                    // the default time changed to early morning: older saves pick it up once
    if ((raw.v || 1) < 3) S.settings.quality = 'auto';          // and so does the automatic graphics quality, when that came
  }
} catch { /* a corrupt save just starts fresh */ }
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION, opts: S.opts, settings: S.settings })); } catch { /* storage unavailable */ } };

let renderer, scene, camera, terrain, sky, airfields, towns, cities, imagery, weather, clouds, precip, chart, input, sound, groundLight, sunShadows;
let ac, model, cityShadeT = 0, cityShadeN = 0;
const roadClock = { time: 0, hour: 12 };   // what the traffic runs on (world/traffic.js)
const wx = { x: 0, y: 0, z: 0, turb: 0, temp: 15, cloud: 0, precip: 0, snow: false, icing: 0, visibility: 60000, overcast: 0, shade: 0, col: null };
const env = { wind: new THREE.Vector3(), turb: 0, ground: groundHeight, surface: surfaceAt };
const ctl = { pitch: 0, roll: 0, yaw: 0 };
const ap = { on: false, hdg: 0, alt: 1000 };
const camState = { yaw: 0, pitch: 0, vel: new THREE.Vector3(), prev: new THREE.Vector3() };
// Graphics tiers: the most device pixels per CSS pixel each draws at ('ultra' takes whatever the screen has).
const PIXEL_CAP = { low: 1, med: 1.25, high: 1.25, ultra: 3 };
const res = new DynRes();                  // dynamic resolution: see onResize and the end of tick
// Graphics quality: the tier chosen in the menu, or with "Automatic" the one the game has settled on for this
// machine (render/autoquality.js: a guess from the graphics card at first, then by how the frames come).
const auto = new AutoQuality();
const tier = () => (S.settings.quality === 'auto' ? auto.tier : S.settings.quality);
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), q1 = new THREE.Quaternion(), e1 = new THREE.Euler(0, 0, 0, 'YXZ');

function surfaceAt(x, z) {
  return airfieldSurface(x, z) || (isWater(x, z) ? 'water' : 'grass');      // runways, taxiways and aprons first
}

// ------------------------------------------------------------------ boot

// Loading progress on the title screen: a message and a bar. A step with no fraction of its own moves the bar on a little.
let loadFrac = 0;
function loadBar(f) {
  const bar = $('loadBar');
  if (f == null) { bar.hidden = true; loadFrac = 0; return; }
  loadFrac = Math.max(0, Math.min(1, f));
  bar.hidden = false; bar.firstElementChild.style.width = `${(loadFrac * 100).toFixed(1)}%`;
}
const msg = (t, f) => { $('loadMsg').textContent = t; loadBar(f ?? loadFrac + (1 - loadFrac) * 0.3); return nextFrame().then(nextFrame); };

// Scenery streaming in flight: how much of what has been asked for since things were last quiet has arrived
// (elevation tiles, terrain and tree jobs, imagery, city tiles). Shown as a small bar while anything is outstanding.
const stream = { peak: 0, shown: false, quiet: 0 };
function streamPending() {
  return dem.pendingCount() + terrain.flying + terrain.done.length + terrain.trees.farFlying + terrain.trees.farDone.length
    + (imagery.enabled ? imagery.queue.size + imagery.inFlight.size + imagery.ready.length : 0) + cities.queue.length + cities.jobs.size;
}
function updateStream(dt) {
  const n = streamPending(), el = $('stream');
  if (n > stream.peak) stream.peak = n;
  if (n === 0) { stream.quiet += dt; if (stream.quiet > 0.6) stream.peak = 0; } else stream.quiet = 0;
  const show = S.mode === 'flying' && stream.peak >= 12 && n > 0;          // a handful of tiles is not worth a bar
  if (show !== stream.shown) { stream.shown = show; el.hidden = !show; }
  if (show) {
    const f = 1 - n / stream.peak;
    $('streamBar').style.width = `${(f * 100).toFixed(0)}%`;
    $('streamTxt').textContent = S.busy ? 'Loading the area' : 'Loading scenery';
    $('streamN').textContent = `${Math.round(f * 100)}%`;
  }
}

async function boot() {
  $('splash').classList.add('loading');
  $('credit').innerHTML = `${dem.ATTRIBUTION}<br>${IMAGERY_ATTRIBUTION}<br>${OSM_ATTRIBUTION}<br>${TOWNS_ATTRIBUTION}<br>${CITY_ATTRIBUTION}<br>${STARS_CREDIT}`;
  if (!fieldById(S.opts.field)) S.opts.field = DEFAULT_FIELD;
  await loadTowns();
  await loadWorld(placeOfField(fieldById(S.opts.field)));

  const canvas = $('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 1.2, 320000);

  auto.start(S.settings.autoTier || tierForHardware(renderer.getContext()));
  imagery = new Imagery(renderer, tier() === 'ultra' ? 'high' : tier());
  imagery.enabled = S.settings.imagery;

  await msg('Stirring the atmosphere…');
  weather = new Weather();
  await msg('Raising mountains…');
  terrain = new Terrain(scene);
  await terrain.init();
  sky = new Sky(scene, renderer);
  // three.js's own shadow map covers only a small box around the aircraft: it is what the aircraft's own
  // materials read (a strut's shadow on the wing). What the sun throws on the ground is SunShadows' business.
  const sh = sky.sun.shadow;
  sky.sun.castShadow = true; sh.mapSize.set(2048, 2048); sh.bias = -0.0004; sh.normalBias = 0.03;
  Object.assign(sh.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 260 }); sh.camera.updateProjectionMatrix();
  airfields = new Airfields(scene);
  towns = new TownLights(scene);
  cities = new Cities(scene, renderer);                 // real buildings, streamed around the aircraft (world/cities.js)
  precip = new Precip(scene);
  clouds = new CloudRenderer(renderer, weather);
  // Light on the ground: mountain shadow, cloud shadow and sky occlusion baked into maps around the camera,
  // and the shadows of the aircraft and of the airfield buildings (see world/groundlight.js, world/sunshadow.js).
  groundLight = new GroundLight(renderer);
  sunShadows = new SunShadows(renderer);
  groundLight.raise = (x0, z0, step, n, h) => cities.raise(x0, z0, step, n, h);
  sunShadows.casterRoots = [airfields.group, cities.group]; sunShadows.ground = groundHeight;
  sunShadows.isCaster = (o) => o.isMesh && (o.castShadow || o.material === airfields.bldMat || o.material === airfields.poleMat || o.material === airfields.sockMat || o.userData.cityCaster);
  perf.tag(airfields.group, 'airfields');            // GPU time of the scene by part, in the debug panel (the terrain and the trees tag themselves)

  ac = new Aircraft();
  selectAircraft(aircraftById(S.opts.plane).id);    // builds the model and points the weather and post-processing at it

  await msg('Printing charts…');
  chart = new Chart(bakeChart(900));
  loadOverview().then((o) => { chart.over = o; }).catch((e) => console.warn('The map of the continent could not be loaded:', e.message));      // (the map works without it, a window at a time)
  input = new Input(canvas);
  sound = new Sound(); sound.enabled = S.settings.sound;

  bindUI();
  applySettings();
  onResize();
  addEventListener('resize', onResize);
  // Debug handle: lets tests drive the sim from the console without rendering every step.
  window.DR = { S, ac, weather, precip, setWeather, imagery, terrain, camera, wx, ap, env, tick, input, clouds, sky, dem, AIRPORTS, FIELDS, REGION, toWorld, toLatLon, towns, cities, chart, loadWorld, ENV, skyRadiance, scene, renderer, get model() { return model; }, selectAircraft, groundLight, sunShadows, airfields, fly: (o) => { Object.assign(S.opts, o); return startFlight(); },
    flyAt: (lat, lon) => startFlight({ lat, lon }), followAircraft,
    perf, uploads, res, auto, tier, applySettings,
    sim: (dt) => { S.time += dt; input.update(dt); if (S.mode === 'flying') simulate(dt * S.timeAccel); } };

  if (!SITUATIONS[S.opts.wx]) S.opts.wx = 'fair';
  S.opts.plane = aircraftById(S.opts.plane).id;
  $('splash').classList.remove('loading');
  $('loadMsg').textContent = ''; loadBar(null);
  $('setup').hidden = false;
  enterSplash();
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ the window of the world

/** Where the window of the world goes for an airfield of the index: what loadWorld takes. */
const placeOfField = (f) => ({ lat: f.lat, lon: f.lon, title: regionOf(f), near: `${f.city}, ${f.state}` });
/** A field's part of the world, for the line above the title screen's choices: "Minnesota · United States", "Jalisco · Mexico", "Jamaica". */
const regionOf = (f) => (f.state && f.state !== f.country ? `${f.state} · ${f.country || 'United States'}` : f.country || f.state);
/** And for any point of the earth: named after the nearest airfield of the index if one is at all near, else by its position. */
function placeOfPoint(lat, lon) {
  const c = Math.cos(lat * D2R);
  let best = null, bd = 250;                                  // km
  for (const f of FIELDS) { const d = Math.hypot(f.lat - lat, (f.lon - lon) * c) * 111.2; if (d < bd) { bd = d; best = f; } }
  const where = fmtPlace(lat, lon, 1);
  return best ? { lat, lon, title: regionOf(best), near: bd < 40 ? `${best.city}, ${best.state}` : `${where}, ${best.state}` } : { lat, lon, title: where, near: where };
}

/**
 * Put the game's window of the world (524 km square) around a place (placeOfField, placeOfPoint), and build everything
 * that depends on where that is: the elevation base and its water, the regional maps and towns, the
 * airfields inside the window with their grading, and (once they exist: at boot they are made afterward)
 * the terrain, the weather's terrain grids, the town lights and the chart. A few seconds, mostly download.
 */
async function loadWorld(place) {
  const t0 = performance.now();
  S.moving = true;                                   // nothing is drawn or simulated while the world is in pieces
  terrain?.reset(); airfields?.reset(); clearAirports();
  setRegion(place.lat, place.lon, place.title);
  cities?.reset();                                   // its tiles are laid out in the old window's meters
  const say = `Downloading terrain round ${place.near}…`;
  await msg(say, 0.05);
  const base = await dem.loadBase(BN, (p) => { $('loadMsg').textContent = `${say} ${Math.round(p * 100)}%`; loadBar(0.05 + 0.55 * p); });
  await msg('Mapping lakes, towns and climate…', 0.62);
  const urban = placeTowns();
  setUrbanGrid(urban);                               // the terrain's workers build town patches from it
  buildWorld(base, urban);
  await msg('Surveying airfields…', 0.66);
  await loadAirports((p) => { $('loadMsg').textContent = `Surveying airfields… ${Math.round(p * 100)}%`; loadBar(0.66 + 0.2 * p); });
  if (terrain) {
    await msg('Raising the land…', 0.9);
    await terrain.init();
    weather.readTerrain();
    groundLight?.reset();                              // its baked shadow maps describe the old place
    towns.rebuild();
    chart.base = bakeChart(900);
    S.field = null;
  }
  S.moving = false;
  console.info(`World round ${place.near} loaded in ${Math.round(performance.now() - t0)} ms, ${AIRPORTS.length} airfields`);
}

/** Is this airfield loaded, with at least 120 km of the window on every side of it? If not, the window moves to it. */
const worldHolds = (id) => !!airportById(id) && !!inWindow(fieldById(id), -120000);
/** The same for any point. */
const worldHoldsPoint = (p) => !!inWindow(p, -120000);
let worldQueue = Promise.resolve(), worldWanted = null;
/** Make sure the window of the world holds a place (held() says whether it does), moving it there if need be. One move at a time; the latest request wins. */
function ensureWorld(place, held) {
  worldWanted = place;
  worldQueue = worldQueue.then(async () => {
    if (place !== worldWanted || held()) return;
    $('splash').classList.add('loading');
    try { await loadWorld(place); } finally { $('splash').classList.remove('loading'); $('loadMsg').textContent = ''; loadBar(null); }
  }).catch((e) => { console.error(e); S.moving = false; $('loadMsg').textContent = 'Could not load that part of the world: ' + e.message; });
  return worldQueue;
}
const ensureField = (id) => ensureWorld(placeOfField(fieldById(id)), () => worldHolds(id));

/**
 * The window follows the aircraft. Before it comes within reach of an edge (RECENTER_AT from the center), the
 * window is moved to lie around a point a little ahead of it, the aircraft is set down in the new coordinates
 * exactly where it was over the ground, and the weather is carried along. The flight stands still for the few
 * seconds that takes. So there is no edge of the world to reach: keep flying and the country keeps coming.
 */
async function followAircraft() {
  if (S.busy || S.mode !== 'flying') return;
  S.busy = true;
  const flight = S.flight, here = toLatLon(ac.pos.x, ac.pos.z), old = { x: ac.pos.x, z: ac.pos.z };
  const h = ac.heading * D2R, ahead = ac.onGround ? 0 : 60000, c = toLatLon(old.x + Math.sin(h) * ahead, old.z - Math.cos(h) * ahead);
  toast('Unrolling the next chart…', 120);
  try {
    const move = worldQueue.then(() => loadWorld(placeOfPoint(c.lat, c.lon)));
    worldQueue = move.catch(() => {});                       // (a failed move must not block the next one)
    await move;
    if (S.flight !== flight) return;                         // the flight ended while the world was moving
    const p = toWorld(here.lat, here.lon), dx = p.x - old.x, dz = p.z - old.z;
    ac.pos.x = p.x; ac.pos.z = p.z;
    weather.shift(dx, dz); weather.bakeAll();
    chart.cx += dx; chart.cz += dz;
    camState.prev.x += dx; camState.prev.z += dz;
    clouds.resetHistory?.();
    syncModel(); updateCamera(0);
    await dem.loadArea(dem.MAX_Z, ac.pos.x - 1800, ac.pos.z - 1800, ac.pos.x + 1800, ac.pos.z + 1800, 0);
    await terrain.warm(camera.position, 8000);
    toastT = 0.01;
  } catch (e) {
    console.error(e); S.moving = false;
    toast('The country ahead could not be loaded: ' + e.message, 8);
  } finally { S.busy = false; $('loadMsg').textContent = ''; loadBar(null); }
}

function onResize() {
  const w = Math.max(innerWidth, 64), h = Math.max(innerHeight, 64), pr = Math.min(devicePixelRatio || 1, PIXEL_CAP[tier()] ?? 1.25);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  // The picture (and the cloud buffer with it) is drawn at res.scale of the canvas and scaled up by the last pass.
  const rw = Math.max(64, Math.round(w * pr * res.scale)), rh = Math.max(64, Math.round(h * pr * res.scale));
  if (rw !== clouds.w || rh !== clouds.h) clouds.setSize(rw, rh);
}

function applySettings() {
  const s = S.settings;
  $('sSound').checked = s.sound; $('sInvert').checked = s.invert; $('sQuality').value = s.quality; $('sImagery').checked = s.imagery;
  if ($('sRes')) $('sRes').value = s.resolution === 'fixed' ? 'fixed' : 'auto';
  const q = tier();
  { const o = $('sQuality').querySelector('option[value="auto"]'), text = s.quality === 'auto' ? `Automatic (${TIER_NAMES[q]})` : 'Automatic'; if (o && o.textContent !== text) { o.textContent = text; syncPickers(); } }
  imagery.enabled = s.imagery; imagery.setQuality(q === 'ultra' ? 'high' : q);
  sound.setEnabled(s.sound);
  clouds.setQuality(q);
  terrain.setQuality(q);
  sunShadows.setQuality(q);
  sky.setQuality(q === 'ultra' ? 'high' : q);      // the sky's tables have no step above 'high'
  cities.setQuality(q);
  // the aircraft's own shadow map (three.js's): half the size on 'low'
  const sh = sky.sun.shadow, shSize = q === 'low' ? 1024 : 2048;
  if (sh.mapSize.x !== shSize) { sh.mapSize.set(shSize, shSize); sh.map?.dispose(); sh.map = null; }
  res.enabled = s.resolution !== 'fixed';
  perf.watch = res.enabled;                // one GPU timer a frame for it to steer by
  if (!res.enabled) res.scale = res.max;
  onResize();                              // the tier sets the pixel ratio
}

// ------------------------------------------------------------------ flow

let toastT = 0;
function toast(text, secs = 4) { const t = $('toast'); t.textContent = text; t.classList.add('show'); toastT = secs; }

function show(name) {
  $('splash').classList.toggle('show', name === 'splash');
  $('pause').classList.toggle('show', name === 'pause');
  $('hud').hidden = S.mode !== 'flying';
  if (S.mode !== 'flying') { setPanel('wxPanel', false); setPanel('dbgPanel', false); document.body.classList.remove('pit'); }
  if (name === 'pause') setChart(false);
  document.body.classList.toggle('title', S.mode !== 'flying');
  syncPickers();                           // the menus' selects may just have been refilled or set from code
}

/** Set up weather and time around an airfield, and put the aircraft on the into-wind runway threshold. */
function stage(a) {
  stageAround(a.x, a.z, a.ux, a.uz, a);
  placeAt(a);
  S.field = a;
}
/** Arrange the weather between a point and an airfield about 110 km from it (none in the window: along the line ux, uz). */
function stageAround(x, z, ux, uz, but = null) {
  const far = AIRPORTS.filter((b) => b !== but).sort((p, q) => Math.abs(Math.hypot(p.x - x, p.z - z) - 110000) - Math.abs(Math.hypot(q.x - x, q.z - z) - 110000))[0]
    || { x: x + 110000 * ux, z: z + 110000 * uz };
  weather.setup(S.opts.wx, { ax: x, az: z, bx: far.x, bz: far.z }, S.opts.hour, 1 + Math.floor(Math.random() * 1e6));
}
function placeAt(a) {
  const w = weather.wind(a.x, a.z, a.elev + 10, a.elev, { x: 0, z: 0 });
  const head = -(w.x * a.ux + w.z * a.uz) >= 0 ? 1 : -1;
  const x = a.x - head * a.ux * (a.len / 2 - 70), z = a.z - head * a.uz * (a.len / 2 - 70);
  const hdg = (a.hdg + (head > 0 ? 0 : 180)) % 360;
  ac.placeOnGround(x, z, groundHeight(x, z), hdg);      // the runway may slope: stand on the ground where the aircraft is
  ac.fuel = ac.spec.fuelCap;
  ap.on = false;
  clouds?.resetHistory?.();                 // the camera is about to jump: drop the clouds' frame history
  camState.yaw = hdg * D2R; camState.pitch = 0;
  input.look.yaw = 0; input.look.pitch = 0; input.zoom = input.zoomTarget = 1;
  return head > 0 ? a.numbers[0] : a.numbers[1];
}

/** "Start in the air": from the runway spot placeAt chose (or over any point, on any heading), lift the aircraft
 *  to cruise, high enough to clear whatever lies ahead and whatever stands close by on any side. */
function placeAloft(x = ac.pos.x, z = ac.pos.z, hdg = ac.heading) {
  const h = hdg * D2R;
  let top = groundHeight(x, z);
  // the way ahead for 9 km, and everything within 4 km whichever way the pilot turns first (a valley's walls)
  for (let d = 300; d <= 9000; d += 300) top = Math.max(top, groundHeight(x + Math.sin(h) * d, z - Math.cos(h) * d));
  for (let a = 0; a < 6.2832; a += 0.3927) for (let d = 500; d <= 4000; d += 500) top = Math.max(top, groundHeight(x + Math.sin(a) * d, z - Math.cos(a) * d));
  const alt = Math.max(groundHeight(x, z) + 450, top + 250);
  ac.placeInAir(x, alt, z, hdg, 54);                       // about 105 knots, cruise power
  ac.fuel = ac.spec.fuelCap; ap.on = false;
  clouds?.resetHistory?.();
  camState.yaw = hdg * D2R; camState.pitch = 0;
  input.look.yaw = 0; input.look.pitch = 0; input.zoom = input.zoomTarget = 1;
  return { alt, hdg };
}

/** Make the chosen variant the aircraft in the scene: its model, paint and flight-model numbers.
 *  The old model's geometry, materials and textures are freed; the weather and the post-processing
 *  are pointed at the new one (wingtips for the vapor trails, glazing for the rain, exhaust for the shimmer). */
function selectAircraft(id) {
  const v = aircraftById(id);
  if (model && S.plane === v.id) return;
  S.plane = v.id;
  if (model) disposeAircraft(model);
  ac.setSpec(v.spec);
  model = buildAircraft(v); scene.add(model.root);
  perf.tag(model.root, 'aircraft');
  sunShadows.setAircraft(model.root, [model.parts.body], [model.parts.pit]);     // the outside of the aircraft throws the shadow, in either view
  // Post-processing follows the aircraft as its own moving subject (sharp under motion blur), and
  // knows where the exhaust ends under the cowl, for the heat shimmer.
  clouds.fx.subject = model.root;
  clouds.fx.glass = model.parts.glass;            // rain and frost are drawn on the cockpit glazing itself
  clouds.fx.exhaust = model.parts.exhaust;
  clouds.subjBox = null;                          // the subject's cached bounding box belongs to the old model
  precip.tips = model.parts.wingtips;
}

async function enterSplash() {
  S.mode = 'splash'; S.paused = false; S.flight = null;
  show('splash');
  // A field in another part of the country: the world is moved there now, behind the loading message, so the
  // backdrop is the place chosen. The menu stays usable meanwhile, and a later choice overtakes this one.
  if (!worldHolds(S.opts.field)) { const id = S.opts.field; await ensureField(id); if (S.mode !== 'splash' || id !== S.opts.field || !airportById(id)) return; }
  const a = airportById(S.opts.field);
  selectAircraft(S.opts.plane);
  $('where').textContent = REGION.title;
  stage(a);
  camState.yaw = ac.heading * D2R + 2.4;
  $('blurb').textContent = `${a.name}: ${a.blurb} ${SITUATIONS[S.opts.wx].blurb}`;
  syncModel(); updateCamera(0.016);
  show('splash');
}

/** Start a flight: from the airfield chosen (on its runway, or over it), or, given a pin { lat, lon }, in the air over that point. */
async function startFlight(pin = null) {
  seaSnap = true;
  if (S.busy) return;
  S.busy = true;
  persist();
  const hdg0 = S.mode === 'flying' ? ac.heading : null;        // a pin dropped in flight keeps the heading being flown
  setChart(false);
  if (pin ? !worldHoldsPoint(pin) : !worldHolds(S.opts.field)) {       // starting outside the window: move the world first
    S.mode = 'splash'; S.paused = false; show('splash');
    if (pin) await ensureWorld(placeOfPoint(pin.lat, pin.lon), () => worldHoldsPoint(pin)); else await ensureField(S.opts.field);
    if (pin ? !worldHoldsPoint(pin) : !airportById(S.opts.field)) { S.busy = false; return; }
  }
  selectAircraft(S.opts.plane);
  let a = null, rwy = null, air = null;
  if (pin) {
    const p = toWorld(pin.lat, pin.lon), near = nearestAirport(p.x, p.z).airport;
    // Toward the nearest airfield, unless a heading is already being flown (or there is no field for a long way).
    const hdg = hdg0 ?? (near && Math.hypot(near.x - p.x, near.z - p.z) > 3000 ? (Math.atan2(near.x - p.x, -(near.z - p.z)) / D2R + 360) % 360 : 0);
    stageAround(p.x, p.z, Math.sin(hdg * D2R), -Math.cos(hdg * D2R));
    await dem.loadArea(11, p.x - 9000, p.z - 9000, p.x + 9000, p.z + 9000, 0);       // enough of the ground to know how high to start
    air = placeAloft(p.x, p.z, hdg);
    S.field = null;
  } else {
    a = airportById(S.opts.field);
    stage(a);
    rwy = placeAt(a);
    air = S.opts.air ? placeAloft() : null;
  }
  S.flight = { airborne: !!air, stopT: 0, endT: 0, lastTd: null, from: pin ? { lat: pin.lat, lon: pin.lon, hdg: air.hdg } : null };
  S.mode = 'flying'; S.paused = false; S.timeAccel = 1; S.view = 'chase'; S.frost = 0;
  syncModel(); updateCamera(0.016);
  show(null);
  sound.start();
  toast(pin ? 'Loading the terrain below…' : 'Loading the terrain around the airfield…', 30);
  stream.peak = 0;
  // Make sure the ground under the wheels is at full detail before handing over.
  await dem.loadArea(dem.MAX_Z, ac.pos.x - 1800, ac.pos.z - 1800, ac.pos.x + 1800, ac.pos.z + 1800, 0);
  await terrain.warm(camera.position, 8000);
  const at = `${(Math.round((ac.pos.y * FT) / 100) * 100).toLocaleString()} feet, heading ${String(Math.round(magnetic(ac.heading))).padStart(3, '0')}°`;
  if (pin) { const near = nearestAirport(ac.pos.x, ac.pos.z); toast(`${near.airport ? `${Math.round(near.dist / NM)} NM from ${near.airport.name}` : fmtPlace(pin.lat, pin.lon)}, at ${at}. You have control. C for the cockpit, Esc for controls.`, 9); }
  else if (air) toast(`Over ${a.name} at ${at}. You have control. C for the cockpit, Esc for controls.`, 9);
  else toast(`Runway ${rwy}, ${a.name}. Hold R for power, ease back at ${aircraftById(S.plane).speeds?.vr ?? 55} knots. C for the cockpit, Esc for controls.`, 9);
  S.busy = false;
}

function respawn(reason) {
  const near = nearestAirport(ac.pos.x, ac.pos.z).airport, f = S.flight;
  f.endT = 0; f.stopT = 0;
  if (near) { placeAt(near); f.airborne = false; toast(`${reason} You are back on the runway at ${near.name}.`, 7); }
  else {
    // No airfield anywhere near: back in the air, where the flight began if that is in reach, else where it ended.
    const p = f.from && worldHoldsPoint(f.from) ? toWorld(f.from.lat, f.from.lon) : ac.pos;
    placeAloft(p.x, p.z, f.from?.hdg ?? ac.heading); f.airborne = true;
    toast(`${reason} You are back in the air.`, 7);
  }
  syncModel(); updateCamera(0.016);
}

function bindUI() {
  const click = (id, fn) => $(id).addEventListener('click', fn);
  const opt = (v, t, sel, find = '') => `<option value="${v}"${sel ? ' selected' : ''}${find ? ` data-find="${find.replace(/"/g, '&quot;')}"` : ''}>${t}</option>`;
  const fill = () => {
    for (const p of ['o', 'p']) {
      // Airfields are grouped by state or province (beyond the two countries, by region: Mexico, Central America,
      // the Caribbean); the search also finds them by city, state or island, and country.
      const groups = new Map();
      for (const a of FIELDS) { const g = a.group || a.state || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
      $(p + 'Field').innerHTML = [...groups].map(([g, list]) => { const o = list.map((a) => opt(a.id, a.name, a.id === S.opts.field, `${a.city} ${a.state} ${a.country || ''}`)).join(''); return g ? `<optgroup label="${g}">${o}</optgroup>` : o; }).join('');
      $(p + 'Plane').innerHTML = AIRCRAFT.map((a) => opt(a.id, a.name, a.id === S.opts.plane)).join('');
      $(p + 'Wx').innerHTML = Object.entries(SITUATIONS).map(([k, v]) => opt(k, v.title, k === S.opts.wx)).join('');
      $(p + 'Hour').innerHTML = HOURS.map(([h, t]) => opt(h, t, h === S.opts.hour)).join('');
      $(p + 'Start').value = S.opts.air ? 'air' : 'ground';
    }
  };
  fill();
  // The flight choices are drop-downs of our own (grouped, searchable when long); the <select>s stay as the values.
  for (const p of ['o', 'p']) {
    enhanceSelect($(p + 'Plane'), { describe: (id) => aircraftById(id).blurb });
    enhanceSelect($(p + 'Field'), { code: true, placeholder: 'Search by name, city, state or code', hint: (id) => { const f = fieldById(id); return f?.group ? f.state : f?.city; } });
    for (const k of ['Wx', 'Hour', 'Start']) enhanceSelect($(p + k));
  }
  panel = new FlightPanel();
  const read = (p) => { S.opts.field = $(p + 'Field').value; S.opts.wx = $(p + 'Wx').value; S.opts.hour = +$(p + 'Hour').value; S.opts.air = $(p + 'Start').value === 'air'; S.opts.plane = $(p + 'Plane').value; };
  $('oStart').addEventListener('change', () => read('o'));
  for (const id of ['oField', 'oWx', 'oHour', 'oPlane']) $(id).addEventListener('change', () => { read('o'); enterSplash(); });
  click('btnFly', () => { read('o'); startFlight(); });
  click('pResume', () => togglePause(false));
  click('pApply', () => { read('p'); S.paused = false; startFlight(); });
  click('pQuit', () => { fill(); enterSplash(); });
  for (const [id, key] of [['sSound', 'sound'], ['sInvert', 'invert'], ['sImagery', 'imagery']]) $(id).addEventListener('change', (e) => { S.settings[key] = e.target.checked; applySettings(); persist(); });
  $('sQuality').addEventListener('change', (e) => { S.settings.quality = e.target.value; applySettings(); persist(); });
  $('sRes')?.addEventListener('change', (e) => { S.settings.resolution = e.target.value; applySettings(); persist(); });

  const flying = () => S.mode === 'flying' && !S.paused;
  const togglePause = (on) => { if (on) fill(); S.paused = on; show(on ? 'pause' : null); };
  input.on('pause', () => { if (S.mode === 'flying') togglePause(!S.paused); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && S.mode !== 'flying' && S.chartOpen) setChart(false); });      // (the game's own keys are off on the title screen)
  input.on('help', () => { if (S.mode === 'flying') togglePause(!S.paused); });
  input.on('camera', () => { if (flying()) { S.view = S.view === 'chase' ? 'cockpit' : 'chase'; input.look.yaw = 0; input.look.pitch = 0; input.zoom = input.zoomTarget = 1; } });
  input.on('timeAccel', () => { if (flying()) S.timeAccel = S.timeAccel >= 64 ? 1 : S.timeAccel * 2; });
  input.on('autopilot', () => {
    if (!flying()) return;
    if (!ap.on && ac.onGround) { toast('Autopilot is for the air.', 2); return; }
    ap.on = !ap.on;
    if (ap.on) { ap.hdg = Math.round(ac.heading); ap.alt = Math.round((ac.pos.y * FT) / 100) * 100 / FT; toast('Autopilot holding heading and altitude. A/D and W/S adjust.', 4); } else toast('Autopilot off. You have control.', 2);
  });
  input.on('chart', () => { if (flying()) toggleChart(); });
  input.on('wxPanel', () => { if (flying()) toggleWxPanel(); });
  input.on('debug', () => { if (flying()) toggleDebugPanel(); });
  click('mapBtn', () => { if (flying()) toggleChart(); });
  click('btnMap', () => { if (S.mode === 'splash') toggleChart(); });
  click('chartFly', () => {
    const pin = chart.pin;
    if (!pin || S.busy || !(S.mode === 'splash' || flying())) return;
    if (S.mode === 'splash') read('o');
    // A pin on an airfield starts the flight from that airfield, on the runway or over it as the Start choice says; any other, in the air over the pin.
    if (pin.field && fieldById(pin.field)) { S.opts.field = pin.field; fill(); syncPickers(); startFlight(); } else startFlight(pin);
  });
  click('menuBtn', () => { if (S.mode === 'flying') togglePause(true); });
  bindWeatherPanel();
  // After any click or change in the HUD and its panels, hand the keyboard back to the aircraft.
  for (const id of ['hud', 'wxPanel', 'dbgPanel', 'chartPanel']) {
    $(id).addEventListener('click', (e) => e.target.closest('button, summary')?.blur());
    $(id).addEventListener('change', (e) => e.target.blur());
  }

  click('chartClose', toggleChart);
  click('chartWx', () => { chart.showWx = !chart.showWx; $('chartWx').classList.toggle('on', chart.showWx); });
  click('chartCenter', () => { chart.cx = ac.pos.x; chart.cz = ac.pos.z; drawChart(); });
  // Drag to move the map, wheel to zoom about the pointer, click to drop the pin (click the pin to take it away).
  const cc = $('chart');
  let drag = null;
  cc.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, far: 0 }; cc.setPointerCapture(e.pointerId); });
  cc.addEventListener('pointermove', (e) => { if (!drag) return; drag.far = Math.max(drag.far, Math.hypot(e.clientX - drag.x, e.clientY - drag.y)); chart.pan(e.movementX, e.movementY); drawChart(); });
  cc.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d || d.far > 5) return;
    const r = cc.getBoundingClientRect();
    chart.pinAt(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    drawChart();
  });
  cc.addEventListener('pointercancel', () => { drag = null; });
  cc.addEventListener('wheel', (e) => { const r = cc.getBoundingClientRect(); chart.zoom(e.deltaY > 0 ? 0.87 : 1.15, r.width, r.height, e.clientX - r.left, e.clientY - r.top); drawChart(); e.preventDefault(); }, { passive: false });
}

function setChart(open) {
  if (open === S.chartOpen) return;
  S.chartOpen = open; $('chartPanel').hidden = !open;
  document.body.classList.toggle('chart-open', open);
  if (open) { chart.cx = ac.pos.x; chart.cz = ac.pos.z; chart.scale = S.mode === 'flying' ? 0.0035 : 0.0012; drawChart(); }
}
const toggleChart = () => setChart(!S.chartOpen);

/** Draw the map, and say in its header where the aircraft and the pin are. */
let chartSaid = '';
function drawChart() {
  if (!S.chartOpen) return;
  const c = $('chart'), pr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
  if (!w || !h) return;
  if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) { c.width = Math.round(w * pr); c.height = Math.round(h * pr); }
  const g = c.getContext('2d'); g.setTransform(pr, 0, 0, pr, 0, 0);
  const inFlight = S.mode === 'flying';
  chart.draw(g, w, h, { ac, weather, line: inFlight });
  const near = nearestAirport(ac.pos.x, ac.pos.z), pin = chart.pin;
  let say = inFlight && near.airport ? `${Math.round(near.dist / NM)} NM from ${near.airport.name}` : '';
  if (pin) {
    const p = toWorld(pin.lat, pin.lon), dx = p.x - ac.pos.x, dz = p.z - ac.pos.z;
    const what = pin.field ? `${fieldById(pin.field)?.name || pin.field} (${pin.field})` : 'Pin';
    say = inFlight ? `${what} ${String(Math.round(magnetic((Math.atan2(dx, -dz) / D2R + 360) % 360)) || 360).padStart(3, '0')}° ${Math.round(Math.hypot(dx, dz) / NM)} NM` : pin.field ? what : `Pin at ${fmtPlace(pin.lat, pin.lon)}`;
  } else if (!inFlight) say = 'Click an airfield, or anywhere to drop a pin';
  if (say !== chartSaid) { chartSaid = say; $('chartInfo').textContent = say; }
  if ($('chartFly').hidden !== !pin) $('chartFly').hidden = !pin;
  const go = pin?.field ? `Fly from ${pin.field}` : 'Fly from pin';
  if ($('chartFly').textContent !== go) $('chartFly').textContent = go;
}

// ------------------------------------------------------------------ weather panel and debug tools

/** Stage a weather system around the aircraft, right now, keeping the time of day. */
/** Change the weather around the aircraft: at once, or over `seconds` when the weather model can blend (transitionTo). */
function setWeather(kind, seconds = S.settings.wxOver || 0) {
  const h = ac.heading * D2R, far = 100000;
  const route = { ax: ac.pos.x, az: ac.pos.z, bx: ac.pos.x + Math.sin(h) * far, bz: ac.pos.z - Math.cos(h) * far };
  S.opts.wx = kind;
  if (seconds > 0 && weather.transitionTo) weather.transitionTo(kind, route, seconds);
  else { weather.setup(kind, route, weather.hour, 1 + Math.floor(Math.random() * 1e6)); clouds.resetHistory?.(); seaSnap = true; }
  syncWeatherPanel();
}

// The Weather panel (V, or the chip at the top left) is part of the game: choose a weather system, how long
// the change takes and the time of day, and read what the weather is doing where you are. Everything else,
// the overrides, the effect sliders and the frame times, lives in the debug tools (the backquote key).

let wxChange = null;          // a weather change in progress: { to, secs, left, flight }. The panel keeps its own clock for it.
const wxKind = () => (wxChange ? wxChange.to : SITUATIONS[weather.kind] ? weather.kind : S.opts.wx);

function setPanel(id, open) {
  $(id).hidden = !open;
  if (id === 'wxPanel') $('wxBtn').setAttribute('aria-expanded', open);
}
function toggleWxPanel() {
  const open = $('wxPanel').hidden;
  setPanel('wxPanel', open);
  if (open) { syncWeatherPanel(); updateWeatherSummary(); }
}
function toggleDebugPanel() {
  const open = $('dbgPanel').hidden;
  setPanel('dbgPanel', open);
  perf.enabled = open;                    // GPU pass timings (window.DR.perf.passes) are only taken while the debug panel is open
  if (open) { syncWeatherPanel(); updateWeatherReadout(); updateDebugReadout(); }
}

/** The player's choice of weather: over S.settings.wxOver seconds when the weather model can blend. */
function chooseWeather(kind) {
  const secs = S.settings.wxOver || 0;
  wxChange = secs > 0 && weather.transitionTo ? { to: kind, secs, left: secs, flight: S.flight } : null;
  setWeather(kind, secs);
}

function syncWeatherPanel() {
  const kind = wxKind(), over = S.settings.wxOver || 0;
  for (const b of $('wxPresets').children) { const on = b.dataset.kind === kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  for (const b of $('wxOver').children) { const on = +b.dataset.secs === over; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
  $('wxBlurb').textContent = SITUATIONS[kind]?.blurb || '';
  $('wxProgress').hidden = !wxChange;
  $('wHour').value = weather.hour; $('wCover').value = weather.ctl.cover; $('wPrecip').value = weather.ctl.precip;
  $('wVis').value = Math.round(weather.haze / 1000); $('wTemp').value = weather.tAnom;
  $('wWindOn').checked = !!weather.ctl.wind;
  labelWeatherPanel();
}
function labelWeatherPanel() {
  $('wHourV').textContent = fmtHour(+$('wHour').value); $('wCoverV').textContent = `${Math.round($('wCover').value * 100)}%`;
  $('wPrecipV').textContent = `${Math.round($('wPrecip').value * 100)}%`; $('wVisV').textContent = visibilityWords($('wVis').value * 1000);
  $('wTempV').textContent = `${$('wTemp').value > 0 ? '+' : ''}${Math.round($('wTemp').value * 1.8)}°F`;
  $('wWindV').textContent = $('wWindOn').checked ? `${String($('wDir').value).padStart(3, '0')}° / ${$('wSpd').value} kt` : 'from the weather';
}

function bindWeatherPanel() {
  // The list is built from SITUATIONS, so it grows as weather systems are added.
  $('wxPresets').innerHTML = Object.entries(SITUATIONS).map(([k, v]) => `<button role="radio" data-kind="${k}">${v.title}</button>`).join('');
  $('wxPresets').addEventListener('click', (e) => { const k = e.target.closest('button')?.dataset.kind; if (k) chooseWeather(k); });
  $('wxOver').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.settings.wxOver = +b.dataset.secs; persist(); syncWeatherPanel(); } });
  let bakeT = 0;
  const rebake = () => { clearTimeout(bakeT); bakeT = setTimeout(() => { weather.bakeAll(); clouds.resetHistory?.(); }, 120); };
  $('wHour').addEventListener('input', () => { weather.hour = +$('wHour').value; labelWeatherPanel(); rebake(); });
  // Debug overrides.
  const apply = () => {
    weather.ctl.cover = +$('wCover').value; weather.ctl.precip = +$('wPrecip').value;
    weather.haze = +$('wVis').value * 1000; weather.tAnom = +$('wTemp').value;
    if ($('wWindOn').checked) {
      // Direction is where the wind comes from; the vector is where the air goes.
      const d = +$('wDir').value * D2R, sp = +$('wSpd').value / 1.944;
      weather.ctl.wind = { x: -Math.sin(d) * sp, z: Math.cos(d) * sp };
    } else weather.ctl.wind = null;
    labelWeatherPanel(); rebake();
  };
  for (const id of ['wCover', 'wPrecip', 'wVis', 'wTemp', 'wDir', 'wSpd', 'wWindOn']) $(id).addEventListener('input', apply);
  $('wStrike').addEventListener('click', () => {
    const h = ac.heading * D2R, d = 2500 + Math.random() * 3500, a = h + (Math.random() - 0.5) * 1.2;
    weather.flashes.push({ x: ac.pos.x + Math.sin(a) * d, z: ac.pos.z - Math.cos(a) * d, y: Math.max(wx.col?.base || 1200, ac.pos.y - 300), ground: true });
  });
  $('wHere').addEventListener('click', () => { wxChange = null; setWeather(wxKind(), 0); });
  $('wxClose').addEventListener('click', toggleWxPanel);
  $('dbgClose').addEventListener('click', toggleDebugPanel);
  $('wxBtn').addEventListener('click', toggleWxPanel);
  bindFxPanel();
}

// Camera and lens effects in the debug panel: [key in clouds.fx, label, slider maximum]. 1 is each effect's
// natural strength (bloom is a share of the image), 0 switches it off.
const FX_CONTROLS = [
  ['ssr', 'Water reflections', 1], ['ao', 'Ambient occlusion', 2], ['taa', 'Temporal anti-aliasing', 1], ['motionBlur', 'Motion blur', 4],
  ['dof', 'Depth of field', 8], ['bloom', 'Bloom', 0.4], ['rays', 'Sun rays', 3], ['flare', 'Lens flare', 3], ['streak', 'Light streaks', 5],
  ['halation', 'Halation', 3], ['glare', 'Veiling glare', 3], ['dirt', 'Lens dirt', 6], ['mist', 'Mist halos', 3], ['heat', 'Exhaust heat shimmer', 10],
  ['distort', 'Lens distortion', 4], ['chroma', 'Color fringing', 3], ['vignette', 'Vignette', 3], ['grain', 'Film grain', 3],
  ['filmic', 'Highlight roll-off', 2], ['wb', 'White balance', 2], ['clarity', 'Local contrast', 3], ['grade', 'Color grade', 2], ['sharpen', 'Sharpening', 1.4],
];
function bindFxPanel() {
  const fx = clouds.fx, saved = S.settings.fx, defaults = Object.fromEntries(FX_CONTROLS.map(([k]) => [k, fx[k]]));
  $('fxControls').innerHTML = FX_CONTROLS.map(([k, label, max]) =>
    `<label>${label} <output id="fxV_${k}"></output><input type="range" data-fx="${k}" min="0" max="${max}" step="${max > 0.5 ? 0.05 : 0.005}" /></label>`).join('');
  const show = () => {
    for (const el of $('fxControls').querySelectorAll('input')) { const k = el.dataset.fx; el.value = fx[k]; $('fxV_' + k).textContent = fx[k] === 0 ? 'off' : (+fx[k]).toFixed(2); }
    $('fxExp').value = S.settings.exposure; $('fxExpV').textContent = '×' + (+S.settings.exposure).toFixed(2);
  };
  const set = (k, v) => { fx[k] = v; if (v === defaults[k]) delete saved[k]; else saved[k] = v; };
  for (const [k] of FX_CONTROLS) if (typeof saved[k] === 'number') fx[k] = saved[k];
  $('fxControls').addEventListener('input', (e) => { const k = e.target.dataset?.fx; if (k) { set(k, +e.target.value); show(); persist(); } });
  $('fxControls').addEventListener('change', (e) => e.target.blur());
  $('fxExp').addEventListener('input', (e) => { S.settings.exposure = +e.target.value; show(); persist(); });
  $('fxExp').addEventListener('change', (e) => e.target.blur());
  $('fxReset').addEventListener('click', (e) => { for (const [k] of FX_CONTROLS) set(k, defaults[k]); S.settings.exposure = 1; show(); persist(); e.target.blur(); });
  $('fxOff').addEventListener('click', (e) => { for (const [k] of FX_CONTROLS) set(k, 0); show(); persist(); e.target.blur(); });
  $('fxDebug').addEventListener('change', (e) => { clouds.post.debug = e.target.value || null; e.target.blur(); });
  show();
}

function updateWeatherReadout() {
  const c = wx.col;
  if (!c) return;
  const from = (Math.atan2(-wx.x, wx.z) / D2R + 360) % 360, kt = Math.hypot(wx.x, wx.z) * 1.944;
  $('wxNow').textContent =
    `cloud ${Math.round(c.cov * 100)}%  base ${(Math.round((c.base * FT) / 100) * 100).toLocaleString()} ft  tops ${(Math.round((c.top * FT) / 500) * 500).toLocaleString()} ft\n` +
    `${wx.snow ? 'snow' : 'rain'} ${Math.round(wx.precip * 100)}%${wx.hail > 0.05 ? `  hail ${Math.round(wx.hail * 100)}%` : ''}  vis ${visibilityWords(wx.visibility).toLowerCase()}\n` +
    `wind ${String(Math.round(from)).padStart(3, '0')}° / ${Math.round(kt)} kt  air ${fahrenheit(wx.temp)}°F  bumps ${Math.round(wx.turb * 100)}%${wx.cloud > 0 ? '  in the clouds' : ''}`;
}

/** The Weather panel's account of the weather at the aircraft, in plain words, and the progress of a change. */
const wxText = {};
function updateWeatherSummary() {
  const w = weatherWords(wx, ac.pos.y);
  if (!w) return;
  const put = (id, text) => { if (wxText[id] !== text) { wxText[id] = text; $(id).textContent = text; } };
  put('wxHead', w.head); put('wxCloud', w.cloud); put('wxVis', w.vis); put('wxWind', w.wind); put('wxFallLbl', w.fallLabel); put('wxFall', w.fall); put('wxTemp', w.air);
  if (document.activeElement !== $('wHour')) { $('wHour').value = weather.hour; put('wHourV', fmtHour(weather.hour)); }
  if (wxChange) put('wxProgress', `${SITUATIONS[wxChange.to].title} in ${fmtLeft(wxChange.left)}`);
}
const fmtLeft = (secs) => (secs >= 90 ? `${Math.round(secs / 60)} min` : secs >= 45 ? '1 min' : `${Math.max(5, Math.ceil(secs / 5) * 5)} s`);

/** The debug tools' frame times, and GPU time per render pass when the renderer reports it (DR.perf.passes). */
const meter = new FrameMeter();
function updateDebugReadout() {
  $('dbgPerf').textContent = meter.text(renderer.domElement)
    + `\ndrawn at ${clouds.w}×${clouds.h}, ${Math.round(res.scale * 100)}%\n  ${res.enabled ? `auto for ${res.target} fps, by ${res.by === 'gpu' ? 'GPU time' : 'frame times'}` : 'fixed'}`
    + `\nuploads: ${uploads.last.pieces}, ${(uploads.last.bytes / 1024).toFixed(0)} KB, ${uploads.last.ms.toFixed(2)} ms${uploads.last.late ? ' (late frame)' : ''}`
    + `\n  waiting ${terrain.done.length + terrain.trees.farDone.length}, building ${terrain.flying + terrain.trees.farFlying}, tiles on order ${dem.pendingCount()}`
    + '\n' + perf.cpuText();
  const passes = window.DR?.perf?.passes, rows = passes ? passRows(passes) : '';
  if (wxText.passes !== rows) { wxText.passes = rows; $('dbgPasses').innerHTML = rows; $('dbgPasses').hidden = !rows; }
}

// ------------------------------------------------------------------ simulation

/** The autopilot's hands on the controls: bank toward its heading, climb or descend toward its altitude. */
function autopilot() {
  let he = ap.hdg - ac.heading; he = ((he + 540) % 360) - 180;
  const bankT = clamp(he * 1.6, -25, 25) * D2R;
  ctl.roll = clamp((bankT - ac.bank) * 2.2, -0.8, 0.8);
  const vsT = clamp((ap.alt - ac.pos.y) * 0.02, ac.ias < 34 ? -4 : -5, clamp((ac.ias - 33) * 0.4, 0, 3.6));
  ctl.pitch = clamp((vsT - ac.vel.y) * 0.25, -0.7, 0.7);
  ctl.yaw = input.yaw;
}

function simulate(dt) {
  const f = S.flight;
  perf.cpuBegin('weather');
  weather.update(dt);
  const gy = groundHeight(ac.pos.x, ac.pos.z);
  weather.sample(ac.pos.x, ac.pos.y, ac.pos.z, gy, wx);
  perf.cpuEnd();

  // Controls: pilot, or autopilot steered by the same keys.
  const inv = S.settings.invert ? -1 : 1;
  if (ap.on) {
    ap.hdg = (ap.hdg + input.raw.roll * 22 * dt / S.timeAccel + 360) % 360;
    ap.alt = clamp(ap.alt + input.raw.pitch * inv * 55 * dt / S.timeAccel, 100, 7500);
    autopilot();
    if (ac.onGround || ac.stall > 0.6) { ap.on = false; toast('Autopilot disconnected.', 3); }
  } else { ctl.pitch = input.pitch * inv; ctl.roll = input.roll; ctl.yaw = input.yaw; }
  ac.throttle = clamp(ac.throttle + input.raw.throttle * 0.55 * dt / S.timeAccel, 0, 1);
  // No systems to manage: the tank never empties, the wheel brakes come on by themselves at idle on the
  // ground, and the flaps follow airspeed (out for a slow approach, in again as power comes on).
  ac.fuel = ac.spec.fuelCap; ac.ice = 0;
  ac.brake = Math.max(input.brake, ac.onGround && ac.throttle < 0.03 ? 1 : 0);
  if (ac.throttle < 0.45 && ac.ias < 40 && !ac.onGround) ac.flapTarget = ac.ias < 35 ? 1 : 0.5;
  else if (ac.throttle > 0.6 || ac.ias > 45 || ac.onGround) ac.flapTarget = 0;

  // Fixed-step flight physics with gusts layered on the mean wind.
  let n = Math.min(Math.round(dt / STEP), 640);            // (640: sixty-four times real time holds down to 12 frames a second)
  const gust = wx.turb * 7.5;
  while (n-- > 0) {
    const t = ac.t;
    env.wind.set(wx.x + gust * (noise1(t * 0.9, 1) + 0.5 * noise1(t * 2.7, 4)), wx.y + gust * 0.8 * (noise1(t * 1.1, 2) + 0.5 * noise1(t * 3.1, 5)), wx.z + gust * (noise1(t * 0.8, 3) + 0.5 * noise1(t * 2.3, 6)));
    env.turb = wx.turb;
    if (ap.on && (n & 3) === 0) autopilot();          // it flies every few steps, not once a frame: at x64 a frame is a second of flight
    ac.step(STEP, ctl, env);
    if (!ac.crashed && ac.agl < 600 && cities.hit(ac.pos)) ac.crashed = cities.lastHit === 'bridge' ? 'Flew into a bridge' : 'Flew into a building';
    if (ac.crashed) break;
  }

  // Frost on the glass is a visual only: it creeps in while flying through freezing cloud.
  S.frost += ((wx.icing > 0 ? 0.55 : 0) - S.frost) * Math.min(1, dt * (wx.icing > 0 ? 0.03 : wx.temp > 1 ? 0.3 : 0.08));   // melts quickly in warm air
  // Rain on the airframe (a sheen on the paint, see animateAircraft): a few seconds of rain or a minute in cloud wets it;
  // the airflow dries it in about a minute of flight, standing still in mild air it takes several.
  { const rain = wx.precip * (1 - (wx.snowMix ?? (wx.snow ? 1 : 0))), to = rain > 0.03 ? 1 : wx.cloud > 0 && wx.temp > 0 ? 0.6 : 0;
    if (S.acWetFor !== f) { S.acWetFor = f; S.acWet = rain > 0.03 ? 1 : 0; }               // a new flight: it has stood out in whatever is falling
    const w = S.acWet;
    S.acWet = clamp(w + (to > w ? dt * (0.05 + 0.4 * rain) : -dt * (1 / 300 + ac.tas / 4200) * clamp(0.4 + wx.temp / 15, 0.2, 1.6)), 0, Math.max(to, w)); }

  // Lightning
  for (const fl of weather.flashes) {
    const d = Math.hypot(fl.x - ac.pos.x, fl.z - ac.pos.z);
    if (d < 110000) { precip.strike(fl, groundHeight(fl.x, fl.z)); if (d < 45000) sound.thunder(d); if (d < 9000) clouds.uFlashScreen.value = 0.35 * (1 - d / 9000); }
  }
  weather.flashes.length = 0;

  // Touchdowns and crashes
  if (ac.maxAgl > 15) f.airborne = true;
  if (ac.touchdown && ac.touchdown !== f.lastTd) {
    f.lastTd = ac.touchdown;
    if (f.airborne && !ac.crashed) { sound.chirp(clamp(ac.touchdown.sink / 5, 0, 1), ac.surface); toast(`Touchdown at ${Math.round(ac.touchdown.sink * FT * 60)} ft/min.`, 3); }
  }
  if (ac.crashed) { if (!f.endT) { f.endT = 2.4; sound.crash(); clouds.uFlashScreen.value = 0.5; toast(`${ac.crashed}.`, 3); } }
  else if (f.airborne && ac.onGround && ac.groundSpeed < 1 && ac.throttle < 0.15) {
    f.stopT += dt / S.timeAccel;
    if (f.stopT > 2) { const near = nearestAirport(ac.pos.x, ac.pos.z); toast(!near.airport ? 'Down in one piece, a long way from anywhere.' : near.dist < 1800 ? `Down and stopped at ${near.airport.name}.` : `Down in one piece, ${Math.round(near.dist / NM)} NM from ${near.airport.name}.`, 6); f.airborne = false; ac.maxAgl = 0; f.stopT = 0; }
  } else f.stopT = 0;
  // The world has no edge: the window is moved along under the aircraft well before one comes near.
  if (Math.max(Math.abs(ac.pos.x), Math.abs(ac.pos.z)) > RECENTER_AT && !ac.crashed) followAircraft();
}

function syncModel() {
  model.root.position.copy(ac.pos);
  model.root.quaternion.copy(ac.quat);
}

function updateCamera(dt) {
  input.zoom += (input.zoomTarget - input.zoom) * (dt <= 0 ? 1 : 1 - Math.exp(-dt * 9));     // wheel zoom glides instead of stepping
  const cs = camState, parts = model.parts;
  if (S.mode !== 'flying') {
    // Slow orbit of the parked aircraft behind the splash screen.
    cs.yaw += dt * 0.045;
    const d = 21, y = 3.8;
    camera.position.set(ac.pos.x - Math.sin(cs.yaw) * d, ac.pos.y + y, ac.pos.z + Math.cos(cs.yaw) * d);
    camera.up.set(0, 1, 0);
    camera.lookAt(v1.copy(ac.pos).add(v2.set(Math.cos(cs.yaw) * 4.2, 1.9, Math.sin(cs.yaw) * 4.2)));
    camera.fov = 50; camera.near = 1.2;
    parts.body.visible = true; parts.pit.visible = false;
  } else if (S.view === 'cockpit') {
    cockpitCamera(camera, ac, input, dt, wx.turb);
    parts.body.visible = false; parts.pit.visible = true;
  } else {
    // Chase: follow the heading with a little lag, stay level with the horizon.
    const hdg = ac.heading * D2R;
    let dy = hdg - cs.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const k = dt <= 0 ? 1 : 1 - Math.exp(-dt * 3.2);
    cs.yaw += dy * k; cs.pitch += (ac.pitch * 0.55 - cs.pitch) * k;
    const yaw = cs.yaw - input.look.yaw, pit = clamp(cs.pitch - 0.2 - input.look.pitch, -1.4, 1.4);
    const dist = 18 * input.zoom;
    v1.set(Math.sin(yaw) * Math.cos(pit), Math.sin(pit), -Math.cos(yaw) * Math.cos(pit));   // view direction
    camera.position.copy(ac.pos).addScaledVector(v1, -dist); camera.position.y += 1.8;
    const floor = groundHeight(camera.position.x, camera.position.z) + 1.5;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.up.set(0, 1, 0);
    camera.lookAt(v2.copy(ac.pos).addScaledVector(v1, 8.5).setY(ac.pos.y + 1.8 + v1.y * 8.5));
    camera.fov = 58; camera.near = 1.2;
    parts.body.visible = true; parts.pit.visible = false;
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  if (dt > 0) cs.vel.copy(camera.position).sub(cs.prev).multiplyScalar(1 / dt);
  cs.prev.copy(camera.position);
}

let uiT = 0, chartT = 0, panel = null, pitShown = false, placeShown = '', warnShown = '';

function updateHud(dt) {
  updateStream(dt);
  const t0 = performance.now();
  const pit = S.view === 'cockpit';
  if (pit !== pitShown) { pitShown = pit; document.body.classList.toggle('pit', pit); }      // in the cockpit the panel folds to a strip at the top, clear of the dials
  // Where the player is going, if they have pinned it on the map: the flight panel points the way.
  let nav = null;
  if (chart.pin) { const p = toWorld(chart.pin.lat, chart.pin.lon); nav = { x: p.x, z: p.z, label: chart.pin.field || 'Pin' }; }
  panel.update(dt, { ac, wx, ap, accel: S.timeAccel, magVar: REGION.magVar, hour: weather.hour, flight: S.flight, running: !S.paused && !S.busy, pit, nav });
  if (weather.trans && !wxChange) wxChange = { to: weather.kind, secs: weather.trans.seconds, left: weather.trans.remaining, flight: S.flight };   // a change started elsewhere (debug handle, evolving weather)
  if (wxChange && !S.paused) {
    wxChange.left = weather.trans ? weather.trans.remaining : wxChange.left - dt * S.timeAccel;        // the weather model's own clock when it has one
    if (wxChange.left <= 0 || wxChange.flight !== S.flight || (weather.transitionTo && !weather.trans)) { wxChange = null; syncWeatherPanel(); }
  }
  if ((uiT -= dt) <= 0) {
    uiT = 0.25;
    const place = `<b>${SITUATIONS[wxKind()].title}</b>${wxChange ? ` <span class="dim">in ${fmtLeft(wxChange.left)}</span>` : ''}<span class="sep"> · </span><span class="num">${fmtHour(weather.hour)}</span>`;
    if (place !== placeShown) { placeShown = place; $('place').innerHTML = place; }
    if (!$('wxPanel').hidden) updateWeatherSummary();
    if (!$('dbgPanel').hidden) { updateWeatherReadout(); updateDebugReadout(); }
    const warn = ac.crashed || ac.onGround ? '' : ac.stall > 0.45 ? 'STALL' : ac.agl < 220 && ac.vel.y < -14 ? 'PULL UP' : '';
    if (warn !== warnShown) { warnShown = warn; $('warn').textContent = warn; }
  }
  meter.frame(performance.now() - t0);
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  tick(dt, true);
}

/** One frame. shown: it is one of the browser's own frames (not a test stepping the game by hand through DR.tick),
 *  so the time since the last one says something about the frame rate. */
function tick(dt, shown = false) {
  if (S.moving) return;                               // the window of the world is being moved: see loadWorld
  // Frame accounting (render/perf.js: main-thread time per stage, for the debug panel) and the frame's budget
  // for uploads to the graphics card (render/budget.js), which every streaming module draws on.
  const frameMs = perf.frameBegin();
  uploads.open = S.busy; uploads.begin(shown ? frameMs : 0);
  S.time += dt;
  input.update(dt);
  input.enabled = S.mode === 'flying';
  const flying = S.mode === 'flying' && !S.paused && !S.busy;

  perf.cpuBegin('simulation');
  if (flying) {
    if (S.flight.endT > 0) { S.flight.endT -= dt; if (S.flight.endT <= 0) respawn('That one will need a new airplane.'); }
    else simulate(dt * S.timeAccel);
  } else {
    if (S.mode === 'splash') weather.update(dt);
    weather.sample(ac.pos.x, ac.pos.y, ac.pos.z, groundHeight(ac.pos.x, ac.pos.z), wx);
  }
  perf.cpuEnd();

  syncModel();
  updateCamera(dt);
  ENV.uTime.value = S.time; ENV.uTAnom.value = weather.tAnom; ENV.uWind.value = Math.hypot(wx.x, wx.z);
  // The state of open water: from the wind, the kind of weather, and any heavy rain overhead. It builds and settles over
  // half a minute (longer through a slow change of weather), so a passing squall raises the lakes gradually.
  { const w = ENV.uWind.value, seaT = Math.min(1, Math.max(Math.min(1, Math.max(0, (w - 5) / 11)), SEA_STATE[weather.kind] || 0, 0.8 * wx.precip));
    ENV.uSea.value = S.mode === 'flying' && dt > 0 && !seaSnap ? ENV.uSea.value + (seaT - ENV.uSea.value) * Math.min(1, dt / Math.max(30, 0.6 * (weather.trans?.remaining || 0))) : seaT; seaSnap = false; }
  // the ground's weather (ENV.uWet is set by the weather itself)
  ENV.uSnow.value = weather.snowpack; ENV.uRain.value = wx.precip * (1 - (wx.snowMix ?? (wx.snow ? 1 : 0))); ENV.uGroundT.value = wx.temp + 0.0065 * Math.max(ac.agl || 0, 0);
  const night = ENV.uNight.value;
  animateAircraft(model.parts, ac, S.paused ? 0 : dt, S.time, night, Math.round((S.acWet || 0) * 50) / 50);
  // The eye adapts at night, so pull the light glows back or they burn out into white balls.
  for (const l of Object.values(model.parts.lights || {})) { l.glow.material.opacity = Math.min(1, 1.3 / sky.exposure); l.glow.scale.multiplyScalar(1 - 0.45 * night); }

  perf.cpuBegin('sky, light, shadows');
  sky.update(weather.hour, wx, weather.haze, ac.pos, dt, weather);
  // Light and shadow on the ground, for everything drawn this frame.
  groundLight.update(camera.position, groundHeight(camera.position.x, camera.position.z));
  const sunOut = 1 - smoothstep(0.3, 0.8, wx.shade);                    // no shadows under cloud
  sunShadows.update(camera, sunOut * (1 - 0.4 * night));               // fainter by moonlight
  perf.cpuEnd();
  // The landing light throws a cone of light on the ground ahead once it is dark enough to see it (the sprite on
  // the wing is only the lamp itself): position and reach, direction and cone, color and strength.
  const spot = ENV.uSpot.value, lamp = model.parts.lights?.landing;
  if (lamp && night > 0.03 && (ac.agl < 350 || night > 0.5)) {
    lamp.lens.getWorldPosition(v1); v2.set(0, -0.105, -1).normalize().applyQuaternion(ac.quat);
    spot[0].set(v1.x, v1.y, v1.z, 700); spot[1].set(v2.x, v2.y, v2.z, Math.cos(0.3)); spot[2].set(1, 0.95, 0.84, 2.4 * night);
  } else spot[2].w = 0;

  terrain.update(camera.position, 5);               // (times its own stages)
  terrain.trees.shade(renderer, camera.position, sunOut);     // the shade of the trees on the ground, drawn into its maps for this frame (world/trees.js)
  perf.cpuBegin('imagery');
  imagery.update(camera.position, camera.fov, clouds.h || renderer.domElement.height);      // the height the picture is drawn at
  perf.cpuEnd(); perf.cpuBegin('airfields, towns, rain');
  airfields.update(S.time, weather, clamp(night + wx.overcast * 0.35 + (wx.visibility < 6000 ? 0.4 : 0), 0, 1), camera.position, sky.exposure);
  const dusk = clamp(night * 1.2 + smoothstep(8, -2, sky.elev) * 0.6, 0, 1);
  if (flying) roadClock.time += dt * S.timeAccel;         // the traffic stands still with the flight
  roadClock.hour = weather.hour;
  cities.update(dt, camera, dusk, sky.exposure, roadClock);
  // New buildings change the height map the baked shadows are marched through: refill it now and then while they arrive.
  if ((cityShadeT -= dt) <= 0) { cityShadeT = 5; if (cities.builtCount !== cityShadeN) { cityShadeN = cities.builtCount; groundLight.stale(); } }
  towns.update(dt, dusk, camera.position, sky.exposure, cities);
  const live = !S.paused, pr = live ? wx.precip : precip.level, sn = wx.snowMix ?? (wx.snow ? 1 : 0);   // rain turns to snow over a couple of degrees
  precip.update({
    dt: live ? dt : 0, time: S.time, rain: pr * (1 - sn), snow: pr * sn,
    hail: live ? wx.hail || 0 : 0, blow: wx.blow || 0, ground: groundHeight(camera.position.x, camera.position.z),
    wind: v1.set(wx.x, wx.y, wx.z), camVel: camState.vel, camPos: camera.position, camera,
    cloud: wx.cloud / CLOUD_SIGMA, humidity: weather.humidity * 0.6,
    aircraft: { pos: ac.pos, quat: ac.quat, vel: ac.vel, root: model.root, tas: ac.tas, gLoad: ac.gLoad, onGround: ac.onGround },
  });
  clouds.uFlashScreen.value *= Math.exp(-dt * 7);
  const fx = clouds.fx;
  fx.time = S.time; fx.rain = wx.snow ? 0 : pr; fx.snow = wx.snow ? pr : 0; fx.ice = S.frost;
  fx.cockpit = S.mode === 'flying' && S.view === 'cockpit' ? 1 : 0; fx.airspeed = ac.tas; fx.flash = clouds.uFlashScreen.value;
  fx.clearance = Math.max(camera.position.y - groundHeight(camera.position.x, camera.position.z), 1);      // lets post skip motion blur when nothing is near enough to streak
  fx.exposure = 0.64 * sky.exposure * S.settings.exposure;
  perf.cpuEnd();

  perf.cpuBegin('render (draw calls)');
  clouds.render(scene, camera);
  perf.cpuEnd();

  perf.cpuBegin('HUD, sound');
  if (S.mode === 'flying') updateHud(dt);
  if (S.chartOpen && (chartT -= dt) <= 0) { chartT = 0.2; drawChart(); }
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
  sound.update({
    active: flying, view: S.view, time: S.time,
    rpm: ac.rpm, power: ac.thrustLevel, engine: ac.fuel > 0, crashed: !!ac.crashed,
    ias: ac.ias, onGround: ac.onGround, groundSpeed: ac.groundSpeed, surface: ac.surface,
    rain: wx.snow ? 0 : wx.precip, snow: wx.snow ? wx.precip : 0, hail: wx.hail || 0, hailHits: precip.hits.rate, turb: wx.turb, cloud: wx.cloud / CLOUD_SIGMA,
    stall: ac.stall > 0.45 && !ac.onGround, stallLevel: ac.stall,
  });
  perf.cpuEnd();
  const scriptMs = perf.frameEnd();
  // Dynamic resolution: steer by the graphics card's time for a frame when the browser can tell it (and has
  // told it lately), else by whether frames come on time. Only in flight (a menu or a loading screen proves nothing),
  // and only on the browser's own frames (a test stepping the game by hand keeps the size it has).
  if (flying && shown && res.update(frameMs, performance.now() - perf.gpuAt < 1500 ? perf.gpu : NaN, scriptMs)) { onResize(); perf.restart(); }      // (the old size's timings say nothing about the new)
  // Automatic quality: when a smaller picture is not enough (or there is plenty to spare), the tier itself moves.
  if (flying && shown && S.settings.quality === 'auto') {
    const was = auto.tier, now = auto.update(frameMs, res);
    if (now) {
      const down = ['low', 'med', 'high'].indexOf(now) < ['low', 'med', 'high'].indexOf(was);
      S.settings.autoTier = now; applySettings(); persist(); perf.restart();
      toast(down ? `Graphics lowered to ${TIER_NAMES[now]} to hold the frame rate.` : `Graphics raised to ${TIER_NAMES[now]}: there is frame rate to spare.`, 4);
    }
  }
}

boot().catch((e) => { console.error(e); $('splash').classList.add('show'); $('loadMsg').textContent = 'Could not start: ' + e.message; });
