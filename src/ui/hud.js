// The flight panel, the words for the weather, and the frame-time meter of the debug tools.
//
// FlightPanel drives the readouts in #fp. It runs every frame, so it touches the page as little as it can:
// the horizon, the bars and the wind arrow move by transform alone (no layout), numbers are written ten
// times a second and only when their text has changed, everything else four times a second.

import { FT, KT, G, RHO0, SPEC } from '../aircraft/physics.js';

const R2D = 180 / Math.PI;
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** 12345 -> "12,345" (a true minus sign for negatives, so the figure keeps its width). */
export const thousands = (n) => { const a = Math.abs(n), s = a < 1000 ? String(a) : `${Math.floor(a / 1000)},${String(a % 1000).padStart(3, '0')}`; return n < 0 ? '−' + s : s; };
/** A heading the way it is spoken: three digits, 360 for north. */
export const hdg3 = (deg) => String(Math.round(((deg % 360) + 360) % 360) || 360).padStart(3, '0');

/** A text slot that touches the page only when its text changes. */
function slot(id) {
  const el = $(id), node = document.createTextNode('');
  let last = '';
  el.textContent = ''; el.appendChild(node);
  return (s) => { if (s !== last) { last = s; node.data = s; } };
}
/** One of a few named states on an element ('' for none), written only on change. */
function state(el) {
  let last = '';
  return (s) => { if (s === last) return; if (last) el.classList.remove(last); if (s) el.classList.add(s); last = s; };
}
/** The hidden attribute, written only on change. */
function shown(el) { let last = !el.hidden; return (on) => { if (on !== last) { last = on; el.hidden = !on; } }; }

const PITCH_EM = 0.025;        // the horizon moves this many ball diameters per degree of pitch: 20 degrees reaches the rim
const VS_FULL = 1500;          // ft/min at which the climb bar is full
const LOW_AGL = 760;           // meters above ground under which the height above ground is shown (2,500 ft)

export class FlightPanel {
  constructor() {
    this.t = {};
    for (const k of ['Clk', 'Tod', 'Spd', 'Hdg', 'Alt', 'Vs', 'Pwr', 'Rpm', 'RpmUnit', 'Flap', 'Agl', 'Wind', 'Oat', 'ApHdg', 'ApAlt', 'AccelV', 'SpdLbl', 'NavLbl', 'NavHdg', 'NavDist', 'NavEte']) this.t[k] = slot('fp' + k);
    this.ball = $('fpBall').style; this.vsBar = $('fpVsBar').style; this.pwrBar = $('fpPwrBar').style; this.arrow = $('fpWindArrow').style;
    this.spdState = state($('fpSpdCell')); this.altState = state($('fpAltCell')); this.vsState = state($('fpVsCell'));
    this.flapOn = state($('fpFlapBox')); this.low = state($('fpAltCell').querySelector('.lbl'));
    this.apShown = shown($('fpAp')); this.accelShown = shown($('fpAccel')); this.arrowShown = shown($('fpWindArrow'));
    this.navShown = shown($('fpNav')); this.navArrow = $('fpNavArrow').style; this.navRel = 0;
    this.vs = 0; this.rel = 0; this.fastT = 0; this.slowT = 0; this.flight = null; this.elapsed = 0;
    this.k = { bank: 1e9, pitch: 1e9, vs: 1e9, pwr: 1e9, rel: 1e9, nav: 1e9 };
  }

  /**
   * d: { ac (aircraft), wx (weather at the aircraft), ap (autopilot), accel (time acceleration),
   *      magVar (degrees east), hour (time of day), flight (any object that is new for each flight: the
   *      stopwatch restarts with it), running (false while paused),
   *      pit (true in the cockpit, where only the strip is kept up to date),
   *      nav (where the player is going, if they have said: { x, z, label }, a world position and a word for it) }
   */
  update(dt, d) {
    const { ac, wx, ap, pit } = d, t = this.t, k = this.k;
    // The stopwatch: heading, speed and time are how a pilot keeps track of where they are.
    if (d.flight !== this.flight) { this.flight = d.flight; this.elapsed = 0; }
    if (d.running) this.elapsed += dt * d.accel;
    const ease = dt > 0 ? 1 - Math.exp(-dt * 5) : 1;
    this.vs += (ac.vel.y * FT * 60 - this.vs) * ease;            // eased, so the figure does not chatter in rough air

    // ---- every frame: transforms only
    if (!pit) {
      const bank = Math.round(ac.bank * R2D * 5) / 5, pitch = Math.round(clamp(ac.pitch * R2D, -45, 45) * 5) / 5;
      if (bank !== k.bank || pitch !== k.pitch) { k.bank = bank; k.pitch = pitch; this.ball.transform = `rotate(${-bank}deg) translateY(${(pitch * PITCH_EM).toFixed(3)}em)`; }
      const vs = Math.round(clamp(this.vs / VS_FULL, -1, 1) * 50) / 50;
      if (vs !== k.vs) { k.vs = vs; this.vsBar.transform = `scaleY(${-vs})`; }
      const pwr = Math.round(ac.throttle * 100) / 100;
      if (pwr !== k.pwr) { k.pwr = pwr; this.pwrBar.transform = `scaleX(${pwr})`; }
      // Wind arrow: the way the air is moving, seen from above with the nose at the top. Down the panel is a headwind.
      const to = Math.atan2(wx.x, -wx.z) * R2D - ac.heading;
      this.rel += ((((to - this.rel) % 360) + 540) % 360 - 180) * ease;
      const rel = Math.round(this.rel);
      if (rel !== k.rel) { k.rel = rel; this.arrow.transform = `rotate(${rel}deg)`; }
    }

    // To the pin: an arrow that points at it, with the nose at the top (shown in the cockpit too: it is how the way is found).
    const nav = d.nav;
    if (nav) {
      const to = Math.atan2(nav.x - ac.pos.x, -(nav.z - ac.pos.z)) * R2D - ac.heading;
      this.navRel += ((((to - this.navRel) % 360) + 540) % 360 - 180) * ease;
      const rel = Math.round(this.navRel);
      if (rel !== k.nav) { k.nav = rel; this.navArrow.transform = `rotate(${rel}deg)`; }
    }

    // ---- ten times a second: the figures
    if ((this.fastT -= dt) <= 0) {
      this.fastT = 0.1;
      t.Spd(String(Math.round(ac.ias * KT)));
      t.Alt(thousands(Math.round((ac.pos.y * FT) / 10) * 10));
      t.Hdg(hdg3(ac.heading - d.magVar));
      const e = Math.floor(this.elapsed), mm = Math.floor(e / 60) % 60, ss = String(e % 60).padStart(2, '0');
      t.Clk(e >= 3600 ? `${Math.floor(e / 3600)}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`);
      if (!pit) {
        const v = Math.round(this.vs / 50) * 50;
        t.Vs(v > 0 ? '+' + thousands(v) : thousands(v));
        t.Pwr(Math.round(ac.throttle * 100) + '%');
        // a piston engine's speed; for a jet, the Mach number
        const jet = !!ac.spec?.jet;
        t.Rpm(jet ? ac.mach.toFixed(2) : thousands(Math.round(ac.rpm / 10) * 10)); t.RpmUnit(jet ? 'Mach' : 'rpm');
        const low = !ac.onGround && ac.agl < LOW_AGL;
        this.low(low ? 'low' : '');
        if (low) t.Agl(`${thousands(Math.max(0, Math.round((ac.agl * FT) / 10) * 10))} ft above ground`);
      }
    }

    // ---- four times a second: states and slow values
    if ((this.slowT -= dt) <= 0) {
      this.slowT = 0.25;
      const air = !ac.onGround && !ac.crashed;
      // Near the stall: within a few degrees of the angle where the wing lets go, or flying barely faster than
      // the speed at which it would in level flight. (The stalling angle, 15.5 degrees clean and 13 with full
      // flap, and the flaps' lift are the flight model's own numbers, repeated here.)
      const sp = ac.spec || SPEC, aStall = sp.aStall - 2.5 * ac.flap, clMax = sp.CL0 + sp.flapLift * ac.flap + (sp.CLa * aStall) / R2D;
      const vStall = Math.sqrt((2 * sp.mass * G) / (RHO0 * sp.S * clMax));
      const spd = !air ? '' : ac.stall > 0.45 ? 'alert' : ac.stall > 0.03 || aStall - ac.alpha * R2D < 2.5 || ac.ias < vStall * 1.06 ? 'caution' : '';
      // Sinking fast near the ground: seconds to the ground at this rate.
      const sink = -ac.vel.y, tti = sink > 0.5 ? ac.agl / sink : 1e9;
      const gnd = !air ? '' : (ac.agl < 220 && sink > 14) || (sink > 6 && tti < 5) ? 'alert' : sink > 5 && tti < 15 ? 'caution' : '';
      this.spdState(spd); this.altState(gnd); this.vsState(gnd);
      t.SpdLbl(spd === 'alert' ? 'Stall' : spd === 'caution' ? 'Slow' : 'Speed');

      // To the pin: the heading to steer (magnetic, like the compass), how far, and how long at the speed made good toward it.
      this.navShown(!!nav);
      if (nav) {
        const dx = nav.x - ac.pos.x, dz = nav.z - ac.pos.z, dist = Math.hypot(dx, dz), nm = dist / 1852;
        const closing = dist > 1 ? (ac.vel.x * dx + ac.vel.z * dz) / dist : 0, mins = closing > 8 ? dist / closing / 60 : -1;
        t.NavLbl(nav.label);
        t.NavHdg(hdg3(Math.atan2(dx, -dz) * R2D - d.magVar) + '°');
        t.NavDist(`${nm < 10 ? nm.toFixed(1) : Math.round(nm)} NM`);
        t.NavEte(mins < 0 ? '' : mins < 1 ? 'under a min' : mins < 90 ? `${Math.round(mins)} min` : `${Math.floor(mins / 60)} h ${String(Math.round(mins % 60)).padStart(2, '0')}`);
      }
      this.apShown(ap.on);
      if (ap.on) { t.ApHdg(hdg3(ap.hdg - d.magVar) + '°'); t.ApAlt(thousands(Math.round((ap.alt * FT) / 100) * 100) + ' ft'); }
      this.accelShown(d.accel > 1);
      t.Tod(`${String(Math.floor(d.hour)).padStart(2, '0')}:${String(Math.floor((d.hour % 1) * 60)).padStart(2, '0')}`);
      if (d.accel > 1) t.AccelV('×' + d.accel);

      if (!pit) {
        t.Flap(ac.flap < 0.05 ? 'up' : ac.flap < 0.75 ? 'half' : 'full');
        this.flapOn(ac.flap < 0.05 ? '' : 'on');
        const kt = Math.hypot(wx.x, wx.z) * KT, calm = kt < 1.5;
        this.arrowShown(!calm);
        t.Wind(calm ? 'calm' : `${hdg3(Math.atan2(-wx.x, wx.z) * R2D - d.magVar)}° ${Math.round(kt)} kt`);
        t.Oat(`${fahrenheit(wx.temp)}°F`);
      }
    }
  }
}

// ------------------------------------------------------------------ the weather in plain words

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const feet = (m, step) => thousands(Math.max(0, Math.round((m * FT) / step) * step));

/** Degrees Fahrenheit, to the degree, from degrees Celsius (what the weather model works in). */
export const fahrenheit = (c) => Math.round((c || 0) * 1.8 + 32) || 0;
/** A visibility in meters as a pilot in the United States hears it: statute miles, fractions of a mile, then feet. */
export function visibilityWords(m) {
  const mi = m / 1609.344;
  if (mi >= 30) return 'More than 30 miles';
  if (mi >= 6) return `${Math.round(mi)} miles`;
  if (mi >= 1.25) return `${(Math.round(mi * 2) / 2).toString()} miles`;
  if (mi >= 0.875) return '1 mile';
  if (mi >= 0.2) return `${['1/4', '1/2', '3/4'][Math.min(2, Math.max(0, Math.round(mi * 4) - 1))]} mile`;
  return `${Math.max(100, Math.round((m * 3.281) / 100) * 100).toLocaleString()} ft`;
}

/**
 * What the weather is doing where the aircraft is, for the Weather panel.
 * wx: the sample main.js keeps (wind x/z, temp, visibility, precip, snow, hail, turb, cloud, col); alt: meters.
 * Returns { head, cloud, vis, wind, fallLabel, fall, air }, or null before the first sample.
 */
export function weatherWords(wx, alt) {
  const miles = visibilityWords;
  const c = wx.col;
  if (!c) return null;
  const inCloud = wx.cloud > 0, fog = c.fog > 0.3 && alt < c.top, storm = c.cell > 0.3 || c.front > 0.35;
  const sky = c.cov < 0.06 ? 'Clear sky' : c.cov < 0.3 ? 'A few clouds' : c.cov < 0.55 ? 'Scattered clouds' : c.cov < 0.88 ? 'Broken clouds' : 'Overcast';
  const cloud = fog ? `Fog up to ${feet(c.top, 100)} ft`
    : c.cov < 0.06 ? 'None'
      : `${sky.replace(' clouds', '')}, bases ${feet(c.base, 100)} ft, tops ${feet(c.top, 500)} ft`;

  const p = wx.precip, hail = (wx.hail || 0) > 0.05;
  const amount = p < 0.05 ? '' : p < 0.3 ? 'Light' : p < 0.65 ? 'Steady' : 'Heavy';
  const kind = wx.snow ? 'snow' : 'rain';
  const fall = (amount ? amount : 'None') + (hail ? (amount ? ', with hail' : ' but hail') : '');

  const v = wx.visibility;
  const vis = inCloud ? 'Near zero: in the clouds' : fog ? `${miles((0.3 + (1 - c.fog) * 2) * 1000)}, in fog` : miles(v);

  const kt = Math.hypot(wx.x, wx.z) * KT, from = (Math.atan2(-wx.x, wx.z) * R2D + 360) % 360;
  const bumps = wx.turb > 0.5 ? ', rough air' : wx.turb > 0.2 ? ', a few bumps' : '';
  const wind = kt < 1.5 ? 'Calm' + bumps : `From the ${COMPASS[Math.round(from / 45) % 8]} at ${Math.round(kt)} kt${bumps}`;

  const air = `${fahrenheit(wx.temp)}°F${wx.temp <= 0 ? ', freezing' : ''}`;

  const first = inCloud ? 'In the clouds' : storm ? 'Thunderstorm' : fog ? 'Fog' : sky;
  const second = hail ? (amount ? `${amount.toLowerCase()} ${kind} and hail` : 'hail') : amount ? `${amount.toLowerCase()} ${kind}` : kt >= 34 ? 'gale' : kt >= 22 ? 'strong wind' : '';
  return { head: second ? `${first}, ${second}` : first, cloud, vis, wind, fallLabel: wx.snow ? 'Snow' : 'Rain', fall, air };
}

// ------------------------------------------------------------------ frame-time meter (debug tools)

/** Rows for the debug tools' table of GPU time per render pass: `passes` maps a pass name to milliseconds. */
export function passRows(passes) {
  const rows = Object.entries(passes).filter(([, v]) => Number.isFinite(v));
  if (!rows.length) return '';
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return '<caption>GPU time per pass, ms</caption>' + rows.map(([k, v]) => `<tr><td>${String(k).replace(/[&<>]/g, '')}</td><td>${v.toFixed(2)}</td></tr>`).join('') + `<tr><td>total</td><td>${total.toFixed(2)}</td></tr>`;
}

/** Averages frame times over half a second. Call frame() once a frame; text() gives the readout. */
export class FrameMeter {
  constructor() { this.last = 0; this.n = 0; this.sum = 0; this.max = 0; this.jsN = 0; this.jsSum = 0; this.hudSum = 0; this.out = null; }
  /** hudMs: what the HUD update itself took this frame. */
  frame(hudMs) {
    const now = performance.now(), gap = now - this.last;
    this.last = now;
    if (gap > 0 && gap < 1000) { this.n++; this.sum += gap; if (gap > this.max) this.max = gap; this.hudSum += hudMs; }
    // The document timeline's clock is the time this frame began, so the difference is the script time spent
    // on the frame so far: simulation, scene and submitting the draw calls. (Not the time the GPU then takes.)
    const js = now - (document.timeline?.currentTime ?? NaN);
    if (js >= 0 && js < 250) { this.jsN++; this.jsSum += js; }
    if (this.sum >= 500) {
      this.out = { ms: this.sum / this.n, max: this.max, fps: (1000 * this.n) / this.sum, js: this.jsN ? this.jsSum / this.jsN : NaN, hud: this.hudSum / this.n };
      this.n = 0; this.sum = 0; this.max = 0; this.jsN = 0; this.jsSum = 0; this.hudSum = 0;
    }
  }
  text(canvas) {
    const o = this.out, f = (x, w = 5) => (Number.isFinite(x) ? x.toFixed(1) : '–').padStart(w);
    const size = canvas ? `canvas ${canvas.width}×${canvas.height}, ${(canvas.width / Math.max(1, canvas.clientWidth)).toFixed(2)} per CSS px` : '';
    if (!o) return `frame      … measuring\n${size}`;
    return `frame  ${f(o.ms)} ms  ${f(o.fps)} fps\nworst  ${f(o.max)} ms\nscript ${f(o.js)} ms  sim + draw calls\nHUD    ${o.hud.toFixed(2).padStart(5)} ms\n${size}`;
  }
}
