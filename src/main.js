// Dead Reckoning — boot, game loop and flight logic.

import * as THREE from 'three';
import { ENV } from './core/env.js';
import { Input } from './core/input.js';
import { Nav } from './core/nav.js';
import { Sound } from './core/audio.js';
import { clamp, noise1, smoothstep } from './core/noise.js';
import { groundHeight, height, LAND_HALF } from './world/terrain.js';
import { initAirports, AIRPORTS, airportById, nearestAirport, runwayCoords } from './world/airports.js';
import { Terrain } from './world/chunks.js';
import { Sky } from './world/sky.js';
import { Airfields } from './world/airfield.js';
import { Weather, SITUATIONS } from './weather/weather.js';
import { CloudRenderer } from './weather/clouds.js';
import { Precip } from './weather/precip.js';
import { Aircraft, SPEC, KT, FT, NM } from './aircraft/physics.js';
import { buildAircraft, buildShadow, animateAircraft } from './aircraft/model.js';
import { HUD } from './ui/hud.js';
import { Chart, bakeChart } from './ui/chart.js';
import { makeOffers, makePlan, fmtHdg, fmtTime, fmtHour, nm } from './game/flightplan.js';

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const STEP = 1 / 120;
const SAVE_KEY = 'dead-reckoning-v1';
// Yield to the browser so loading text can paint; the timeout keeps boot moving in a background tab.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 60); });

// ------------------------------------------------------------------ state

const S = {
  mode: 'loading', paused: false, timeAccel: 1, view: 'chase', chartOpen: false,
  flight: null, plan: null, offers: [], time: 0, helpFrom: null,
  save: { at: 'HAL', log: [], settings: { gps: false, sound: true, invert: false, quality: 'med' } },
};
try {
  const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  if (raw && raw.at) { S.save = { ...S.save, ...raw, settings: { ...S.save.settings, ...(raw.settings || {}) } }; }
} catch { /* a corrupt save just starts fresh */ }
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S.save)); } catch { /* storage unavailable */ } };

let renderer, scene, camera, terrain, sky, airfields, weather, clouds, precip, hud, chart, input, sound, nav;
let ac, model, shadow;
const wx = { x: 0, y: 0, z: 0, turb: 0, temp: 15, cloud: 0, precip: 0, snow: false, icing: 0, visibility: 60000, overcast: 0, shade: 0, col: null };
const env = { wind: new THREE.Vector3(), turb: 0, ground: groundHeight, surface: surfaceAt };
const ctl = { pitch: 0, roll: 0, yaw: 0 };
const ap = { on: false, hdg: 0, alt: 1000 };
const camState = { yaw: 0, pitch: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3() };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), q1 = new THREE.Quaternion(), e1 = new THREE.Euler(0, 0, 0, 'YXZ');

function surfaceAt(x, z) {
  for (const a of AIRPORTS) {
    const dx = x - a.x, dz = z - a.z;
    if (Math.abs(dx) > 2500 || Math.abs(dz) > 2500) continue;
    const along = dx * a.ux + dz * a.uz, cross = dx * -a.uz + dz * a.ux;
    if (Math.abs(along) < a.len / 2 && Math.abs(cross) < a.width / 2) return a.surface;
    if (Math.abs(along) < 90 && cross > 0 && cross < a.width / 2 + 160) return a.surface;   // taxiway and apron
  }
  return groundHeight(x, z) <= 0.3 ? 'water' : 'grass';
}

// ------------------------------------------------------------------ boot

async function boot() {
  const msg = (t) => { $('loadMsg').textContent = t; return nextFrame().then(nextFrame); };
  await msg('Surveying the continent…');
  initAirports();

  const canvas = $('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 1.2, 220000);

  await msg('Stirring the atmosphere…');
  weather = new Weather();
  await msg('Raising mountains…');
  terrain = new Terrain(scene);
  sky = new Sky(scene);
  airfields = new Airfields(scene);
  precip = new Precip(scene);
  clouds = new CloudRenderer(renderer, weather);

  ac = new Aircraft();
  model = buildAircraft(); scene.add(model.root);
  shadow = buildShadow(); scene.add(shadow);

  await msg('Printing charts…');
  chart = new Chart(bakeChart(768));
  hud = new HUD($('panel'));
  input = new Input(canvas);
  sound = new Sound(); sound.enabled = S.save.settings.sound;
  nav = new Nav();
  nav.onFix = (a, err) => toast(`Position fix: overhead ${a.name}. Your reckoning was ${nm(err).toFixed(1)} NM out.`, 6);

  bindUI();
  applySettings();
  onResize();
  addEventListener('resize', onResize);
  // Debug handle: lets tests drive the sim from the console without rendering every step.
  window.DR = { S, ac, weather, nav, terrain, camera, wx, ap, startFlight, makePlan, AIRPORTS, env, tick, input, clouds, sim: (dt) => { S.time += dt; input.update(dt); if (S.mode === 'flying') simulate(dt * S.timeAccel); } };

  if (!airportById(S.save.at)) S.save.at = 'HAL';
  enterTitle();
  requestAnimationFrame(loop);
}

function onResize() {
  const w = innerWidth, h = innerHeight, pr = Math.min(devicePixelRatio || 1, 1.25);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  clouds.setSize(Math.round(w * pr), Math.round(h * pr));
}

function applySettings() {
  const s = S.save.settings;
  $('sGps').checked = s.gps; $('sSound').checked = s.sound; $('sInvert').checked = s.invert; $('sQuality').value = s.quality;
  sound.setEnabled(s.sound);
  const q = { low: [0.4, 56], med: [0.5, 88], high: [0.75, 120] }[s.quality] || [0.5, 88];
  clouds.setQuality(q[0], q[1]);
}

// ------------------------------------------------------------------ screens

function show(name) {
  for (const el of document.querySelectorAll('.screen')) el.classList.toggle('show', el.id === name);
  $('hud').hidden = !(S.mode === 'flying');
  if (S.mode !== 'flying') { $('chartPanel').hidden = true; S.chartOpen = false; document.body.classList.remove('chart-open'); }
}

let toastT = 0;
function toast(text, secs = 4) { const t = $('toast'); t.textContent = text; t.classList.add('show'); toastT = secs; }

/** Park the aircraft at an airfield for the menu backdrop. */
function parkAt(a, hour, kind = 'fair', seed = 3) {
  weather.setup(kind, { ax: a.x - 40000, az: a.z, bx: a.x + 40000, bz: a.z }, hour, seed);
  const x = a.x - a.ux * (a.len / 2 - 70), z = a.z - a.uz * (a.len / 2 - 70);
  ac.placeOnGround(x, z, groundHeight(x, z), a.hdg);
  ac.fuel = SPEC.fuelCap;
  camState.yaw = a.hdg * D2R + 2.5; camState.pitch = 0.1;
  syncModel();
  updateCamera(0.016, true);
  terrain.warm(camera.position);
}

function enterTitle() {
  S.mode = 'title'; S.paused = false; S.flight = null;
  const a = airportById(S.save.at);
  parkAt(a, 17.2, 'fair', 5 + S.save.log.length);
  $('titleWhere').textContent = `You are at ${a.name} (${a.id}). ${S.save.log.length ? `${S.save.log.length} flight${S.save.log.length > 1 ? 's' : ''} in the logbook.` : 'The logbook is empty.'}`;
  show('title');
}

function enterDispatch() {
  S.mode = 'dispatch';
  const a = airportById(S.save.at);
  S.offers = makeOffers(a.id, S.save.log.length);
  $('dispWhere').textContent = `${a.name} · ${a.id}`;
  $('dispBlurb').textContent = a.blurb;
  const hrs = S.save.log.reduce((s, l) => s + (l.time || 0), 0) / 3600;
  $('dispLog').innerHTML = `LOGBOOK<br>${S.save.log.length} flights · ${hrs.toFixed(1)} h`;
  const rows = S.offers.map((o, i) => {
    const b = airportById(o.to), d = Math.hypot(b.x - a.x, b.z - a.z), crs = (Math.atan2(b.x - a.x, -(b.z - a.z)) / D2R + 360) % 360;
    const sit = SITUATIONS[o.kind];
    return `<tr><td><div class="dest">${b.name}</div><div class="leg">${b.id} · ${fmtHdg(crs)} · ${Math.round(nm(d))} NM · dep ${fmtHour(o.hour)}</div></td>
      <td><div class="sit">${sit.title}</div><div class="blurb">${sit.blurb}</div></td>
      <td><div class="pips" title="Difficulty ${sit.difficulty} of 3">${'●'.repeat(sit.difficulty)}<i>${'●'.repeat(3 - sit.difficulty)}</i></div></td>
      <td><button class="btn" data-offer="${i}">Briefing</button></td></tr>`;
  });
  $('offers').innerHTML = rows.join('');
  const opt = (v, t, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${t}</option>`;
  $('cFrom').innerHTML = AIRPORTS.map((p) => opt(p.id, p.name, p.id === a.id)).join('');
  $('cTo').innerHTML = AIRPORTS.map((p) => opt(p.id, p.name, p.id === S.offers[0].to)).join('');
  $('cWx').innerHTML = Object.entries(SITUATIONS).map(([k, v]) => opt(k, v.title)).join('');
  $('cHour').innerHTML = [5.5, 7, 9, 12, 15, 17.5, 19, 22].map((h) => opt(h, fmtHour(h), h === 12)).join('');
  show('dispatch');
}

function enterBriefing(offer) {
  S.mode = 'briefing';
  const a = airportById(offer.from), b = airportById(offer.to);
  weather.setup(offer.kind, { ax: a.x, az: a.z, bx: b.x, bz: b.z }, offer.hour, offer.seed);
  const p = S.plan = makePlan(offer, weather);
  $('brTitle').textContent = `${a.name} to ${b.name}`;
  $('brSit').textContent = `${p.sit.title}. ${p.sit.blurb}`;
  const w = (i) => `${fmtHdg(p.winds[i].dir)} / ${Math.round(p.winds[i].kt)} kt`;
  $('brPlan').innerHTML = `
    <div class="steer">Steer <b>${fmtHdg(p.wc.heading)}</b> for <b>${fmtTime(p.ete)}</b> at ${p.cruiseFt.toLocaleString()} ft</div>
    <table>
      <tr><td>True course</td><td class="num">${fmtHdg(p.course)} · ${Math.round(nm(p.dist))} NM</td></tr>
      <tr><td>Wind correction</td><td class="num">${p.wc.wca >= 0 ? '+' : '−'}${Math.abs(p.wc.wca).toFixed(0)}° · ground speed ${Math.round(p.wc.gs * KT)} kt at 140 kt TAS</td></tr>
      <tr><td>Minimum safe altitude</td><td class="num">${p.msaFt.toLocaleString()} ft</td></tr>
      <tr><td>Winds at ${p.cruiseFt.toLocaleString()} ft</td><td class="num">${w(0)} · ${w(1)} · ${w(2)}</td></tr>
      <tr><td>Departure</td><td class="num">${fmtHour(p.hour)} local · runway ${a.numbers.join('/')} · ${Math.round(a.elev * FT)} ft</td></tr>
      <tr><td>Destination</td><td class="num">runway ${b.numbers.join('/')} · ${Math.round(b.len)} m ${b.surface} · ${Math.round(b.elev * FT)} ft</td></tr>
    </table>
    <h3>Observations</h3>
    <div class="metar">${a.id} ${p.depWx.text}</div>
    <div class="metar">${b.id} ${p.dstWx.text}</div>
    <h3>Hazards</h3>
    <ul>${p.hazards.map((h) => `<li>${h}</li>`).join('')}</ul>`;
  show('briefing');
  // Forecast chart
  const c = $('brChart'), size = Math.round(c.clientWidth * Math.min(devicePixelRatio || 1, 2)) || 600;
  c.width = c.height = size;
  const bc = new Chart(chart.base);
  bc.fit(size, size, p.route, 0.55); bc.showWx = true;
  bc.draw(c.getContext('2d'), size, size, { route: p.route, weather });
}

function startFlight(plan = S.plan) {
  const { a, b } = plan;
  weather.setup(plan.kind, { ax: a.x, az: a.z, bx: b.x, bz: b.z }, plan.hour, plan.seed);
  // Take off into wind.
  const w = weather.wind(a.x, a.z, a.elev + 10, a.elev, { x: 0, z: 0 });
  const head = -(w.x * a.ux + w.z * a.uz) >= 0 ? 1 : -1;
  const x = a.x - head * a.ux * (a.len / 2 - 70), z = a.z - head * a.uz * (a.len / 2 - 70);
  const hdg = (a.hdg + (head > 0 ? 0 : 180)) % 360;
  ac.placeOnGround(x, z, groundHeight(x, z), hdg);
  ac.fuel = SPEC.fuelCap; ac.t = 0;
  nav.reset(x, z, a.name, b);
  ap.on = false; ap.hdg = plan.wc.heading; ap.alt = plan.cruiseFt / FT;
  S.flight = { plan, elapsed: 0, airborne: false, stopT: 0, endT: 0, lastTd: null, td: null, maxIce: 0, iceWarned: false, fuelWarned: false, edgeWarned: 0, rwy: head > 0 ? a.numbers[0] : a.numbers[1] };
  S.mode = 'flying'; S.paused = false; S.timeAccel = 1; S.view = 'chase';
  input.look.yaw = 0; input.look.pitch = 0; input.zoom = 1;
  camState.yaw = hdg * D2R; camState.pitch = 0;
  syncModel(); updateCamera(0.016, true);
  terrain.warm(camera.position);
  chart.fit(600, 800, plan.route, 0.3); chart.showWx = false;
  show(null);
  sound.start();
  toast(`Runway ${S.flight.rwy}, ${a.name}. Steer ${fmtHdg(plan.wc.heading)} for ${fmtTime(plan.ete)}. Hold R for power.`, 9);
}

function finishFlight(kind) {
  const f = S.flight, p = f.plan;
  S.mode = 'debrief';
  const near = nearestAirport(ac.pos.x, ac.pos.z);
  const rc = runwayCoords(near.airport, ac.pos.x, ac.pos.z);
  const onRunway = Math.abs(rc.along) < near.airport.len / 2 + 80 && Math.abs(rc.cross) < near.airport.width / 2 + 12;
  const onField = onRunway || near.dist < 1600;
  let title, text, cap = 'Logbook entry', ok = false;
  if (kind === 'crash') {
    cap = 'Accident report'; title = 'Aircraft lost';
    text = `${ac.crashed}, ${Math.round(nm(near.dist))} NM from ${near.airport.name}. The air-taxi company has found you another Wayfarer.`;
  } else if (kind === 'lost') {
    cap = 'Overdue'; title = 'Lost at sea'; text = 'You flew off the edge of the chart and were not heard from again.';
  } else if (onField && near.airport === p.b) {
    ok = true; title = `Arrived at ${p.b.name}`;
    text = onRunway ? 'Down and stopped on the runway.' : 'Down on the airfield, if not quite on the runway.';
    S.save.at = p.b.id;
  } else if (onField) {
    ok = true; title = `Diverted to ${near.airport.name}`; text = `Not where you were going, but a runway is a runway.`;
    S.save.at = near.airport.id;
  } else {
    title = 'Forced landing'; text = `You walked away from a field ${Math.round(nm(near.dist))} NM from ${near.airport.name}. A truck brings you and the aircraft in.`;
    S.save.at = near.airport.id;
  }
  const rows = [['Route', `${p.a.id} → ${p.b.id} · ${Math.round(nm(p.dist))} NM`], ['Weather', p.sit.title], ['Flight time', fmtTime(f.elapsed)]];
  if (f.td && kind !== 'crash') {
    const fpm = Math.round(f.td.sink * FT * 60);
    rows.push(['Touchdown', `${fpm} ft/min · ${fpm < 150 ? 'a greaser' : fpm < 350 ? 'good' : fpm < 600 ? 'firm' : 'hard'}`]);
    if (onRunway) rows.push(['Off the centreline', `${Math.abs(rc.cross).toFixed(1)} m`]);
  }
  rows.push(['Worst reckoning error', `${nm(nav.maxError).toFixed(1)} NM`]);
  if (f.maxIce > 0.05) rows.push(['Peak airframe ice', `${Math.round(f.maxIce * 100)}%`]);
  $('dbCap').textContent = cap; $('dbTitle').textContent = title; $('dbText').textContent = text;
  $('dbStats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  if (kind !== 'crash' && kind !== 'lost') S.save.log.push({ from: p.a.id, to: p.b.id, kind: p.kind, time: f.elapsed, ok, at: S.save.at });
  persist();
  show('debrief');
}

function bindUI() {
  const click = (id, fn) => $(id).addEventListener('click', fn);
  click('btnFly', () => { sound.start(); enterDispatch(); });
  click('btnHow', () => { S.helpFrom = 'title'; show('help'); });
  click('helpClose', () => { if (S.helpFrom === 'pause') show('pause'); else if (S.mode === 'flying') { S.paused = false; show(null); } else show(S.helpFrom || 'title'); });
  click('dispBack', enterTitle);
  $('offers').addEventListener('click', (e) => { const i = e.target.dataset?.offer; if (i !== undefined) enterBriefing(S.offers[+i]); });
  click('cGo', () => {
    const from = $('cFrom').value, to = $('cTo').value;
    if (from === to) return;
    enterBriefing({ from, to, kind: $('cWx').value, hour: +$('cHour').value, seed: 1 + Math.floor(Math.random() * 1e6) });
  });
  click('brBack', enterDispatch);
  click('brGo', () => startFlight());
  click('dbNext', enterDispatch);
  click('dbRetry', () => startFlight(S.flight.plan));
  click('pResume', () => togglePause(false));
  click('pHelp', () => { S.helpFrom = 'pause'; show('help'); });
  click('pRestart', () => startFlight(S.flight.plan));
  click('pAbandon', enterDispatch);
  for (const [id, key] of [['sGps', 'gps'], ['sSound', 'sound'], ['sInvert', 'invert']]) $(id).addEventListener('change', (e) => { S.save.settings[key] = e.target.checked; applySettings(); persist(); });
  $('sQuality').addEventListener('change', (e) => { S.save.settings.quality = e.target.value; applySettings(); persist(); });

  const flying = () => S.mode === 'flying' && !S.paused;
  input.on('pause', () => { if (S.mode === 'flying') togglePause(!S.paused); });
  input.on('help', () => { if (S.mode === 'flying') { S.paused = true; S.helpFrom = 'flight'; show('help'); } });
  input.on('camera', () => { if (flying()) { S.view = S.view === 'chase' ? 'cockpit' : 'chase'; input.look.yaw = 0; input.look.pitch = 0; } });
  input.on('flapsDown', () => { if (flying()) { ac.flapTarget = Math.min(1, ac.flapTarget + 0.5); toast(`Flaps ${ac.flapTarget === 1 ? 'full' : 'half'}`, 1.5); } });
  input.on('flapsUp', () => { if (flying()) { ac.flapTarget = Math.max(0, ac.flapTarget - 0.5); toast(`Flaps ${ac.flapTarget === 0 ? 'up' : 'half'}`, 1.5); } });
  input.on('timeAccel', () => { if (flying()) { S.timeAccel = S.timeAccel >= 8 ? 1 : S.timeAccel * 2; } });
  input.on('autopilot', () => {
    if (!flying()) return;
    if (!ap.on && ac.onGround) { toast('Autopilot is for the air.', 2); return; }
    ap.on = !ap.on;
    if (ap.on) { ap.hdg = Math.round(ac.heading); ap.alt = Math.round((ac.pos.y * FT) / 100) * 100 / FT; toast('Autopilot holding heading and altitude. A/D and W/S adjust.', 4); } else toast('Autopilot off. You have control.', 2);
  });
  input.on('tune', (shift) => { if (flying()) { const s = nav.tuneNext(shift ? -1 : 1); toast(`Radio compass tuned to ${s.name} (${s.id})`, 2.5); } });
  input.on('chart', () => { if (flying()) toggleChart(); });
  input.on('gps', () => { if (flying()) { S.save.settings.gps = !S.save.settings.gps; applySettings(); persist(); toast(S.save.settings.gps ? 'GPS assist on: true position shown on the chart.' : 'GPS assist off. Compass and clock only.', 3); } });
  input.on('weatherOverlay', () => { if (flying()) { chart.showWx = !chart.showWx; $('chartWx').classList.toggle('on', chart.showWx); } });

  click('chartClose', toggleChart);
  click('chartWx', () => { chart.showWx = !chart.showWx; $('chartWx').classList.toggle('on', chart.showWx); });
  click('chartCentre', () => { chart.cx = nav.dr.x; chart.cz = nav.dr.z; });
  const cc = $('chart');
  let drag = false;
  cc.addEventListener('pointerdown', (e) => { drag = true; cc.setPointerCapture(e.pointerId); });
  cc.addEventListener('pointerup', () => { drag = false; });
  cc.addEventListener('pointermove', (e) => { if (drag) chart.pan(e.movementX, e.movementY); });
  cc.addEventListener('wheel', (e) => { chart.zoom(e.deltaY > 0 ? 0.87 : 1.15, cc.clientWidth, cc.clientHeight); e.preventDefault(); }, { passive: false });
}

function togglePause(on) { S.paused = on; show(on ? 'pause' : null); }
function toggleChart() {
  S.chartOpen = !S.chartOpen; $('chartPanel').hidden = !S.chartOpen;
  document.body.classList.toggle('chart-open', S.chartOpen);
  if (S.chartOpen) { const c = $('chart'); chart.fit(c.clientWidth, c.clientHeight, S.flight.plan.route, 0.3); }
}

// ------------------------------------------------------------------ simulation

function simulate(dt) {
  const f = S.flight;
  weather.update(dt);
  const gy = groundHeight(ac.pos.x, ac.pos.z);
  weather.sample(ac.pos.x, ac.pos.y, ac.pos.z, gy, wx);

  // Controls: pilot, or autopilot steered by the same keys.
  const inv = S.save.settings.invert ? -1 : 1;
  if (ap.on) {
    ap.hdg = (ap.hdg + input.raw.roll * 22 * dt / S.timeAccel + 360) % 360;
    ap.alt = clamp(ap.alt + input.raw.pitch * inv * 55 * dt / S.timeAccel, 100, 7500);
    let he = ap.hdg - ac.heading; he = ((he + 540) % 360) - 180;
    const bankT = clamp(he * 1.6, -25, 25) * D2R;
    ctl.roll = clamp((bankT - ac.bank) * 2.2, -0.8, 0.8);
    const vsT = clamp((ap.alt - ac.pos.y) * 0.02, ac.ias < 45 ? -6 : -7, ac.ias < 48 ? 0 : 6);
    ctl.pitch = clamp((vsT - ac.vel.y) * 0.25, -0.7, 0.7);
    ctl.yaw = input.yaw;
    if (ac.onGround || ac.stall > 0.6) { ap.on = false; toast('Autopilot disconnected.', 3); }
  } else { ctl.pitch = input.pitch * inv; ctl.roll = input.roll; ctl.yaw = input.yaw; }
  ac.throttle = clamp(ac.throttle + input.raw.throttle * 0.55 * dt / S.timeAccel, 0, 1);
  ac.brake = input.brake;

  // Fixed-step flight physics with gusts layered on the mean wind.
  let n = Math.min(Math.round(dt / STEP), 80);
  const gust = wx.turb * 7.5;
  while (n-- > 0) {
    const t = ac.t;
    env.wind.set(wx.x + gust * (noise1(t * 0.9, 1) + 0.5 * noise1(t * 2.7, 4)), wx.y + gust * 0.8 * (noise1(t * 1.1, 2) + 0.5 * noise1(t * 3.1, 5)), wx.z + gust * (noise1(t * 0.8, 3) + 0.5 * noise1(t * 2.3, 6)));
    env.turb = wx.turb;
    ac.step(STEP, ctl, env);
    if (ac.crashed) break;
  }

  // Airframe icing
  if (wx.icing > 0) ac.ice = Math.min(1, ac.ice + wx.icing * dt * 0.0045);
  else ac.ice = Math.max(0, ac.ice - dt * (wx.temp > 1 ? 0.012 : 0.0006));
  f.maxIce = Math.max(f.maxIce, ac.ice);
  if (ac.ice > 0.12 && !f.iceWarned) { f.iceWarned = true; toast('Ice is building on the wings. Get out of cloud or down into warmer air.', 7); }
  if (ac.ice < 0.03) f.iceWarned = false;
  if (ac.fuel <= 0 && !f.fuelWarned) { f.fuelWarned = true; toast('Fuel exhausted. You are a glider now.', 6); }

  f.elapsed += dt;
  nav.update(dt, ac, f.elapsed);

  // Lightning
  for (const fl of weather.flashes) {
    const d = Math.hypot(fl.x - ac.pos.x, fl.z - ac.pos.z);
    if (d < 110000) { precip.strike(fl, Math.max(0, height(fl.x, fl.z, 1))); if (d < 45000) sound.thunder(d); if (d < 9000) clouds.uFlashScreen.value = 0.35 * (1 - d / 9000); }
  }
  weather.flashes.length = 0;

  // Flight progress
  if (ac.maxAgl > 15) f.airborne = true;
  if (ac.touchdown && ac.touchdown !== f.lastTd) {
    f.lastTd = ac.touchdown;
    if (f.airborne && !ac.crashed) { f.td = ac.touchdown; sound.chirp(clamp(f.td.sink / 5, 0, 1)); toast(`Touchdown at ${Math.round(f.td.sink * FT * 60)} ft/min.`, 3); }
  }
  if (ac.crashed) { if (!f.endT) { f.endT = 1.4; sound.crash(); clouds.uFlashScreen.value = 0.5; } }
  else if (f.airborne && ac.onGround && ac.groundSpeed < 1 && ac.throttle < 0.15) { f.stopT += dt / S.timeAccel; if (f.stopT > 2.2) return finishFlight('landed'); } else f.stopT = 0;
  const edge = Math.max(Math.abs(ac.pos.x), Math.abs(ac.pos.z)) - LAND_HALF;
  if (edge > 0 && S.time - f.edgeWarned > 20) { f.edgeWarned = S.time; toast('You are off the edge of the chart. Turn back.', 6); }
  if (edge > 40000) finishFlight('lost');
}

function syncModel() {
  model.root.position.copy(ac.pos);
  model.root.quaternion.copy(ac.quat);
}

function updateCamera(dt, snap = false) {
  const cs = camState;
  if (S.mode !== 'flying') {
    // Slow orbit of the parked aircraft behind the menus.
    cs.yaw += dt * 0.05;
    const d = 30, y = 5.5;
    camera.position.set(ac.pos.x - Math.sin(cs.yaw) * d, ac.pos.y + y, ac.pos.z + Math.cos(cs.yaw) * d);
    camera.up.set(0, 1, 0);
    camera.lookAt(v1.copy(ac.pos).add(v2.set(Math.cos(cs.yaw) * 6, 2.5, Math.sin(cs.yaw) * 6)));
    camera.fov = 50; camera.near = 1.2;
    model.parts.body.visible = true; model.parts.pit.visible = false;
  } else if (S.view === 'cockpit') {
    camera.position.copy(v1.set(0, 0.62, -1.3).applyQuaternion(ac.quat)).add(ac.pos);
    e1.set(-input.look.pitch * 0.8, input.look.yaw, 0);
    camera.quaternion.copy(ac.quat).multiply(q1.setFromEuler(e1));
    camera.fov = 68 / Math.sqrt(input.zoom); camera.near = 0.3;
    model.parts.body.visible = false; model.parts.pit.visible = true;
  } else {
    // Chase: follow the heading with a little lag, stay level with the horizon.
    const hdg = ac.heading * D2R;
    let dy = hdg - cs.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const k = snap ? 1 : 1 - Math.exp(-dt * 3.2);
    cs.yaw += dy * k; cs.pitch += (ac.pitch * 0.55 - cs.pitch) * k;
    const yaw = cs.yaw - input.look.yaw, pit = clamp(cs.pitch - 0.2 - input.look.pitch, -1.4, 1.4);
    const dist = 26 * input.zoom;
    v1.set(Math.sin(yaw) * Math.cos(pit), Math.sin(pit), -Math.cos(yaw) * Math.cos(pit));   // view direction
    camera.position.copy(ac.pos).addScaledVector(v1, -dist); camera.position.y += 2.5;
    const floor = groundHeight(camera.position.x, camera.position.z) + 1.5;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.up.set(0, 1, 0);
    camera.lookAt(v2.copy(ac.pos).addScaledVector(v1, 12).setY(ac.pos.y + 2.5 + v1.y * 12));
    camera.fov = 58; camera.near = 1.2;
    model.parts.body.visible = true; model.parts.pit.visible = false;
  }
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  if (dt > 0) cs.vel.copy(camera.position).sub(cs.prev).multiplyScalar(1 / dt);
  cs.prev.copy(camera.position);
}

const hs = { ias: 0, alt: 0, vs: 0, heading: 0, pitch: 0, bank: 0, adf: null, station: '', apOn: false, apHdg: 0, throttle: 0, power: 0, fuel: 1, flap: 0, elapsed: 0 };
let uiT = 0, chartT = 0;

function updateHud(dt) {
  const f = S.flight, p = f.plan;
  hs.ias = ac.ias; hs.alt = ac.pos.y; hs.vs = ac.vel.y; hs.heading = ac.heading; hs.pitch = ac.pitch; hs.bank = ac.bank;
  hs.adf = nav.adf(ac, S.time); hs.station = nav.station?.id || '---'; hs.apOn = ap.on; hs.apHdg = ap.hdg;
  hs.throttle = ac.throttle; hs.power = ac.thrustLevel; hs.fuel = ac.fuel / SPEC.fuelCap; hs.flap = ac.flap; hs.elapsed = f.elapsed;
  hud.draw(hs);

  if ((uiT -= dt) <= 0) {
    uiT = 0.25;
    $('strip').innerHTML = `<b>${p.a.id} → ${p.b.id}</b> ${p.b.name} <span class="dim">· ${p.sit.title}</span><br>` +
      `PLAN  steer <b>${fmtHdg(p.wc.heading)}</b> · ${fmtTime(p.ete)} · ${p.cruiseFt.toLocaleString()} ft<br>` +
      `<span class="dim">HDG</span> <b>${fmtHdg(ac.heading)}</b>  <span class="dim">OAT</span> ${Math.round(wx.temp)}°C  <span class="dim">LOCAL</span> ${fmtHour(weather.hour)}`;
    const st = [];
    if (S.timeAccel > 1) st.push(`<span class="on">TIME ×${S.timeAccel}</span>`);
    if (ap.on) st.push(`<span class="on">AP</span> HDG ${fmtHdg(ap.hdg)} · ALT ${(Math.round((ap.alt * FT) / 100) * 100).toLocaleString()}`);
    if (ac.ice > 0.05) st.push(`<span class="on">ICE ${Math.round(ac.ice * 100)}%</span>`);
    if (ac.brake > 0.5 && ac.onGround) st.push('BRAKES');
    if (S.save.settings.gps) st.push('<span class="dim">GPS ASSIST</span>');
    if (wx.cloud > 0) st.push('<span class="dim">IN CLOUD</span>');
    st.push(`<span class="dim">ADF</span> ${nav.station?.id || '---'}${hs.adf === null ? ' no signal' : ''}`);
    $('status').innerHTML = st.join('<br>');
    const warn = [];
    if (ac.stall > 0.45 && !ac.onGround) warn.push('STALL');
    else if (!ac.onGround && ac.agl < 220 && ac.vel.y < -14) warn.push('PULL UP');
    if (ac.crashed) warn.length = 0;
    $('warn').textContent = warn.join('\n');
  }
  if (S.chartOpen && (chartT -= dt) <= 0) {
    chartT = 0.2;
    const c = $('chart'), pr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * pr) || c.height !== Math.round(h * pr)) { c.width = Math.round(w * pr); c.height = Math.round(h * pr); }
    const g = c.getContext('2d'); g.setTransform(pr, 0, 0, pr, 0, 0);
    chart.draw(g, w, h, { route: p.route, nav, ac, gps: S.save.settings.gps, weather, lop: nav.lop(ac) });
    $('chartInfo').textContent = `since fix ${fmtTime(nav.sinceFix)} · ${nm(nav.distSinceFix).toFixed(0)} NM run`;
  }
}

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  tick(dt);
}

function tick(dt) {
  S.time += dt;
  input.update(dt);
  input.enabled = S.mode === 'flying';
  const flying = S.mode === 'flying' && !S.paused;

  if (flying) {
    if (S.flight.endT > 0) { S.flight.endT -= dt; if (S.flight.endT <= 0) { finishFlight('crash'); } }
    else simulate(dt * S.timeAccel);
  } else if (S.mode !== 'flying') {
    weather.update(dt);
    weather.sample(ac.pos.x, ac.pos.y, ac.pos.z, groundHeight(ac.pos.x, ac.pos.z), wx);
  }
  if (S.mode === 'loading') return;

  syncModel();
  updateCamera(dt);
  ENV.uTime.value = S.time; ENV.uTAnom.value = weather.tAnom;
  const night = ENV.uNight.value;
  animateAircraft(model.parts, ac, flying || S.mode !== 'flying' ? dt : 0, S.time, night);

  // Atmosphere seen from the camera. In cloud the light is flat and grey.
  sky.update(weather.hour, wx, ac.pos);
  // Shadow on the ground under the aircraft
  const sd = ENV.uSunDir.value, agl = Math.max(0, ac.agl + SPEC.gearHeight);
  const sx = ac.pos.x - (sd.x / sd.y) * agl, sz = ac.pos.z - (sd.z / sd.y) * agl;
  shadow.position.set(sx, groundHeight(sx, sz) + 0.12, sz);
  shadow.rotation.y = -ac.heading * D2R;
  shadow.material.opacity = 0.55 * (1 - wx.shade) * smoothstep(700, 60, agl) * smoothstep(-2, 6, sky.elev);
  shadow.visible = shadow.material.opacity > 0.01 && groundHeight(sx, sz) > 0.3;

  terrain.update(camera.position, 5);
  airfields.update(S.time, weather, clamp(night + wx.overcast * 0.35 + (wx.visibility < 6000 ? 0.4 : 0), 0, 1), camera.position);
  precip.update(dt, flying || S.mode !== 'flying' ? wx.precip : precip.level, wx.snow, v1.set(wx.x, wx.y, wx.z), camState.vel, camera.position);
  clouds.uFlashScreen.value *= Math.exp(-dt * 7);

  clouds.render(scene, camera);

  if (S.mode === 'flying') updateHud(dt);
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').classList.remove('show'); }
  sound.update({ active: flying, power: ac.thrustLevel, engine: ac.fuel > 0, ias: ac.ias, rain: wx.precip * (wx.snow ? 0.15 : 1), stall: ac.stall > 0.45 && !ac.onGround, time: S.time });
}

boot().catch((e) => { console.error(e); $('loadMsg').textContent = 'Could not start: ' + e.message; });
