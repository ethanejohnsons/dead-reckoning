// Sound. Almost everything heard is a recording (see public/audio/CREDITS.md): a Cessna 152 recorded in its
// own cabin at five engine speeds, a Cessna 172 and an idling four-cylinder single recorded from outside, rain
// and hail on a car body, wind, thunder, tires. This file loads them after the Fly click and plays them as a
// mix that follows the flight: engine bands cross-faded and pitched by rpm, air noise by airspeed, weather by
// intensity, with one switch between the microphone in the cabin and the one flying behind the aircraft.
//
// Three things are synthesized because no free recording exists or can exist: the reed stall horn, the buffet
// of a stalled wing, and the slow swell of gusts (which only moves the gain of recorded wind). One thing is
// processing rather than playback: the recorded engine is also bent through a soft curve to bring out exhaust
// harmonics, more of them under load. If a file fails to load, a synthesized stand-in takes its place so the
// game still sounds like something.
//
// A jet has its own engine voice (the roar of the exhaust, the whine of the fan, the rumble that reaches the
// cabin, an afterburner), driven by thrust and fan speed where the piston engine is driven by rpm. Its layers
// are recordings too (jet_roar: an F-80 at full power; jet_whine: an F-22 idling; jet_cabin: the cabin of a 737 in
// cruise; jet_burner: an F-4 taking off in afterburner), with synthesized stand-ins (shaped noise, a cluster of
// tones) for any that fail to load.

import { gustBuffer, buffetBuffer, reedWave, noiseBuffer, standInEngine, standInBurst, whineBuffer, rng } from './audio-synth.js';

const AUDIO_URL = `${import.meta.env.BASE_URL}audio/`;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const dB = (d) => Math.pow(10, d / 20);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const HALF_PI = Math.PI / 2;

/** Piecewise-linear lookup through [x, y] pairs sorted by x. */
function curve(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  return pts[pts.length - 1][1];
}

/**
 * Equal-power weights for recordings made at the given engine speeds (ascending). Each neighboring pair
 * hands over across a zone centered on the geometric mean of their speeds, `half` wide in log rpm either side,
 * so at any moment one or two bands play and their combined power is constant.
 */
export function bandWeights(rpms, rpm, half) {
  const n = rpms.length, w = new Array(n).fill(0);
  if (n === 0) return w;
  if (n === 1) { w[0] = 1; return w; }
  const x = Math.log(Math.max(rpm, 1));
  for (let i = 0; i < n - 1; i++) {
    const a = Math.log(rpms[i]), b = Math.log(rpms[i + 1]), h = Math.min(half, 0.45 * (b - a));
    const t = (x - (0.5 * (a + b) - h)) / (2 * h);
    if (t >= 1) continue;
    if (t <= 0) w[i] = 1; else { w[i] = Math.cos(t * HALF_PI); w[i + 1] = Math.sin(t * HALF_PI); }
    return w;
  }
  w[n - 1] = 1;
  return w;
}

// Mix levels in one place. Loop files are all normalized to -23 LUFS and one-shots to about -20, so these
// numbers are the balance of the mix itself.
export const MIX = {
  master: dB(1),
  outside: dB(-3),              // the whole outside microphone against the cabin one
  // Engine level against rpm (dB), heard at the load that normally goes with that speed.
  engineByRpm: [[500, -10.5], [700, -9.5], [1100, -9], [1500, -7], [2000, -4.5], [2400, -2], [2700, 0]],
  engineCabin: dB(3.5),         // the cabin recording, cockpit view
  engineBody: dB(2),            // the same recording filtered into the outside view, above the low engine orders
  engineOutside: dB(3),         // the outside recordings, chase view
  exciteCabin: dB(-15), exciteOutside: dB(-8),
  startCabin: dB(-3), startOutside: dB(-1),
  airCabin: dB(-3), airRush: dB(1), airRushInCabin: dB(-13), airGust: dB(1.5), buffet: dB(-6),
  rain: dB(6), rainOutside: dB(-2), hail: dB(7), hailOutside: dB(-2),
  roll: dB(1), rollOutside: dB(-7),
  thunder: dB(6), worldInCabin: dB(-2.5),
  horn: 0.13, hornOutside: dB(-1),
  jetOutside: dB(4), jetCabin: dB(-3), jetWhineCabin: dB(-13), jetBurner: dB(5),
};

/** A looping recording behind its own gain. The source is (re)made when the buffer arrives. */
class Loop {
  constructor(ctx, dest) {
    this.ctx = ctx; this.src = null; this.rate = 1; this.level = 0;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    if (dest) this.gain.connect(dest);
  }
  set(buffer, loop, phase = 0) {
    if (this.src) { try { this.src.stop(); } catch { /* never started */ } this.src.disconnect(); }
    const s = this.src = this.ctx.createBufferSource();
    s.buffer = buffer; s.loop = true;
    const a = loop ? loop[0] : 0, b = loop ? loop[1] : buffer.duration;
    s.loopStart = a; s.loopEnd = b;
    s.playbackRate.value = this.rate;
    s.connect(this.gain);
    s.start(0, a + (b - a) * phase);
    return this;
  }
  get loaded() { return !!this.src; }
  setLevel(v, t, tau = 0.06) { this.level = v; this.gain.gain.setTargetAtTime(v, t, tau); }
  setRate(r, t, tau = 0.05) { this.rate = r; if (this.src) this.src.playbackRate.setTargetAtTime(r, t, tau); }
}

export class Sound {
  constructor() {
    this.ctx = null; this.enabled = true;
    this.ready = false;            // every file has loaded or been replaced by a stand-in
    this.failed = [];              // files that did not load
    this.loaded = null;            // promise, resolves when `ready` turns true
    this._started = false; this._running = false; this._active = false; this._offline = false; this._hidden = false;
    this._fresh = false; this._engOn = false; this._engT0 = -1e9; this._settleRpm = 1330; this._surface = 'paved'; this._lastClap = null;
    this._view = 1; this._rand = rng(20231); this._jet = false;
    this.state = {};               // what the last update asked for (rates, weights, levels); read by tests
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  /** Call from a user gesture (the Fly click). Creates the audio context the first time and loads the files. */
  start() {
    this._started = true;
    this._fresh = true;                          // the next live frame starts the engine from cold
    if (!this.enabled) return;                   // sound off: nothing is created, fetched or run
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      this.attach(new C({ latencyHint: 'interactive' }));
      // Browsers that refuse to start audio outside a gesture get another chance on the next key or click.
      const wake = () => { if (this._running && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); };
      addEventListener('pointerdown', wake, true); addEventListener('keydown', wake, true);
      document.addEventListener('visibilitychange', () => { this._hidden = document.hidden; this._run(this._active && this.enabled && !this._hidden); });
    } else if (this.ctx.state === 'suspended' && this._running) this.ctx.resume().catch(() => {});
  }

  /** The Sound checkbox. Off means the context is suspended: no audio thread work at all. */
  setEnabled(on) {
    this.enabled = !!on;
    if (on && this._started && !this.ctx) { this.start(); this._fresh = 'running'; }   // switched on in mid-flight: join the engine as it is
    if (this.ctx) this._run(this._active && this.enabled && !this._hidden);
  }

  /**
   * Build the graph on a context and start loading. `start()` calls this with a live AudioContext; tests call
   * it with an OfflineAudioContext (and may pass decoded buffers to skip the network).
   */
  attach(ctx, { offline = false, buffers = null, manifest = null } = {}) {
    this.ctx = ctx; this._offline = offline;
    if (!offline) this._rand = rng(Date.now() >>> 0);            // a different run of thunderclaps every session
    this._build(ctx);
    this.loaded = (buffers ? this._adopt(buffers, manifest) : this._load()).then(() => { this._standIns(); this.ready = true; });
    return this.loaded;
  }

  /** Fade the whole mix in or out and stop the audio thread when silent. */
  _run(want) {
    if (want === this._running || !this.ctx) return;
    this._running = want;
    const ctx = this.ctx, t = ctx.currentTime, g = this.out.gain;
    clearTimeout(this._sleep);
    if (want) {
      if (!this._offline && ctx.state === 'suspended') ctx.resume().catch(() => {});
      g.cancelScheduledValues(t); g.setTargetAtTime(1, t, 0.09);
    } else {
      g.cancelScheduledValues(t); g.setTargetAtTime(0, t, 0.045);
      if (!this._offline) this._sleep = setTimeout(() => { if (!this._running && ctx.state === 'running') ctx.suspend().catch(() => {}); }, 400);
    }
  }

  // ------------------------------------------------------------------------------------------ graph

  _build(ctx) {
    const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filter = (type, f, q = 0.707, g = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };
    const chain = (...nodes) => { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; };
    this._filter = filter;

    // Master bus: everything sums here, then a gentle compressor glues it, a fast one catches thunder and
    // crashes, and a soft clipper guarantees the output never reaches full scale.
    this.sum = gain(1);
    this.cloudEq = filter('highshelf', 2200, 0.707, 0);         // dulls the whole world inside cloud
    this.comp = ctx.createDynamicsCompressor();
    const dyn = (node, threshold, knee, ratio, attack, release) => { node.threshold.value = threshold; node.knee.value = knee; node.ratio.value = ratio; node.attack.value = attack; node.release.value = release; };
    dyn(this.comp, -20, 14, 2.5, 0.02, 0.3);
    const compTrim = gain(dB(-4.52));                            // the node adds make-up gain of its own; take it back out
    this.limiter = ctx.createDynamicsCompressor();
    dyn(this.limiter, -3, 2, 20, 0.002, 0.12);
    const limTrim = gain(dB(-1.37));
    const clip = ctx.createWaveShaper(), cv = new Float32Array(2049);
    for (let i = 0; i < cv.length; i++) { const x = (i / 1024 - 1) * 2, a = Math.abs(x), k = 0.8; cv[i] = Math.sign(x) * (a <= k ? a : k + (0.98 - k) * Math.tanh((a - k) / (0.98 - k))); }
    clip.curve = cv;
    const clipIn = gain(0.5);                                    // the curve spans -2..2, so halve on the way in
    this.out = gain(0);
    chain(this.sum, this.cloudEq, gain(MIX.master), this.comp, compTrim, this.limiter, limTrim, clipIn, clip, this.out, ctx.destination);

    // Perspective: three buses. `cabin` is what the microphone inside hears, `outside` what one flying just
    // behind the aircraft hears, `world` is everything that happens out in the weather (thunder, a crash)
    // and reaches the cabin through the airframe, duller and quieter.
    this.cabin = gain(0); this.outside = gain(1); this.world = gain(1);
    this.worldDirect = gain(1); this.worldThrough = gain(0);
    this.bed = gain(1);                                          // engine, air and weather; dips for a close thunderclap
    this.cabin.connect(this.bed); this.outside.connect(this.bed); this.bed.connect(this.sum);
    chain(this.world, this.worldDirect, this.sum);
    chain(this.world, filter('lowpass', 4200, 0.6), this.worldThrough, this.sum);

    // Engine. Cabin loops -> engOn (start-up, shutdown) -> level by rpm and load -> tone by load.
    this.bands = []; this.ext = [];
    this.engLoops = gain(0);                                     // 0 until the engine is started
    this.engLevel = gain(0);
    this.engBark = filter('peaking', 210, 0.8, 0);               // exhaust note: fuller under load
    this.engAir = filter('highshelf', 1500, 0.707, 0);           // lighter with the throttle closed
    this.engPre = gain(1);
    chain(this.engLoops, this.engLevel, this.engBark, this.engAir, this.engPre);
    chain(this.engPre, gain(MIX.engineCabin), this.cabin);
    // Outside, the low engine orders come from the outside recordings alone: two recordings of the same note at
    // the same pitch drift in and out of phase and the drone would throb. The cabin recording adds only what
    // lies above them.
    chain(this.engPre, filter('highpass', 280), filter('lowpass', 2400), gain(MIX.engineBody), this.outside);
    // Exhaust harmonics: the low engine orders of the recording, bent through a soft asymmetric curve, make
    // the harmonics an exhaust has outside the cabin (and that small speakers need to carry the note at all).
    const shaper = ctx.createWaveShaper(), sc = new Float32Array(2049), bias = 0.16, k = 1.7;
    for (let i = 0; i < sc.length; i++) { const x = i / 1024 - 1; sc[i] = (Math.tanh(k * (x + bias)) - Math.tanh(k * bias)) / Math.tanh(k); }
    shaper.curve = sc; shaper.oversample = '4x';
    this.excDrive = gain(2); this.excLevel = gain(0);
    chain(this.engLoops, filter('lowpass', 300), filter('lowpass', 300), this.excDrive, shaper, filter('highpass', 150), filter('highpass', 150), filter('lowpass', 3200), this.excLevel);
    chain(this.excLevel, gain(MIX.exciteCabin), this.cabin);
    chain(this.excLevel, filter('highpass', 250), gain(MIX.exciteOutside), this.outside);
    // The recorded start (starter, first firing) reaches both microphones on its own path.
    this.startBus = gain(1);
    chain(this.startBus, gain(MIX.startCabin), this.cabin); chain(this.startBus, filter('highpass', 70), gain(MIX.startOutside), this.outside);
    // Outside recordings.
    this.extLoops = gain(0); this.extLevel = gain(0);
    chain(this.extLoops, this.extLevel, gain(MIX.engineOutside), this.outside);
    // Windmilling propeller when the engine has stopped in flight: the idle recording with the fire taken out.
    this.mill = new Loop(ctx, null);
    const millOut = chain(this.mill.gain, filter('lowpass', 420), gain(1));
    millOut.connect(this.cabin); chain(millOut, gain(0.7), this.outside);

    // Jet engine: roar (dull and low at idle, opening up with thrust), whine (pitched by fan speed), the rumble in
    // the cabin, and the afterburner. Silent while a piston aircraft is flown, as the piston loops are for a jet.
    this.jetOn = gain(0); this.jetOnCab = gain(0);
    this.jetRoarLP = filter('lowpass', 500, 0.5);
    this.jetRoar = new Loop(ctx, this.jetRoarLP); this.jetWhine = new Loop(ctx, null); this.jetCabin = new Loop(ctx, null); this.jetBurner = new Loop(ctx, null);
    const jetOut = gain(1), jetIn = gain(1);
    chain(this.jetRoarLP, jetOut); chain(this.jetWhine.gain, filter('highpass', 500), jetOut);
    chain(this.jetBurner.gain, filter('lowpass', 1400, 0.5), gain(MIX.jetBurner), jetOut);
    chain(this.jetRoarLP, filter('lowpass', 420, 0.5), gain(dB(-6)), jetIn); chain(this.jetCabin.gain, jetIn);
    chain(this.jetWhine.gain, filter('lowpass', 3200), gain(MIX.jetWhineCabin), jetIn);
    chain(this.jetBurner.gain, filter('lowpass', 260), gain(dB(-2)), jetIn);
    chain(jetOut, this.jetOn, gain(MIX.jetOutside), this.outside); chain(jetIn, this.jetOnCab, gain(MIX.jetCabin), this.cabin);

    // Air.
    this.airCabLP = filter('lowpass', 3000, 0.5);
    this.airCab = new Loop(ctx, this.airCabLP); chain(this.airCabLP, gain(MIX.airCabin), this.cabin);
    this.rushLP = filter('lowpass', 9000, 0.5);
    this.airRush = new Loop(ctx, null);
    chain(this.airRush.gain, filter('highpass', 110), this.rushLP, gain(MIX.airRush), this.outside);
    chain(this.airRush.gain, filter('lowpass', 260), gain(MIX.airRushInCabin), this.cabin);   // low buffeting under the cabin hiss
    this.airGust = new Loop(ctx, null);
    chain(this.airGust.gain, gain(MIX.airGust), this.outside); chain(this.airGust.gain, gain(MIX.airGust * 0.6), this.cabin);
    // Gusts: a slow control signal added to the wind gains. Its depth is set every frame from the turbulence.
    this.gustLfo = ctx.createBufferSource(); this.gustLfo.buffer = gustBuffer(ctx); this.gustLfo.loop = true;
    this.gustCab = gain(0); this.gustRush = gain(0); this.gustGust = gain(0);
    this.gustLfo.connect(this.gustCab); this.gustLfo.connect(this.gustRush); this.gustLfo.connect(this.gustGust);
    this.gustCab.connect(this.airCab.gain.gain); this.gustRush.connect(this.airRush.gain.gain); this.gustGust.connect(this.airGust.gain.gain);
    this.gustLfo.start();
    this.buffet = new Loop(ctx, null).set(buffetBuffer(ctx), null);
    chain(this.buffet.gain, gain(MIX.buffet), this.cabin); chain(this.buffet.gain, gain(MIX.buffet * 0.35), this.outside);

    // Weather on the airframe.
    this.rainBus = gain(1); this.hailBus = gain(1);
    this.rainLight = new Loop(ctx, this.rainBus); this.rainHeavy = new Loop(ctx, this.rainBus); this.hail = new Loop(ctx, this.hailBus);
    chain(this.rainBus, gain(MIX.rain), this.cabin); chain(this.rainBus, filter('highpass', 700), gain(MIX.rainOutside), this.outside);
    chain(this.hailBus, gain(MIX.hail), this.cabin); chain(this.hailBus, filter('highpass', 500), gain(MIX.hailOutside), this.outside);

    // Thunder rolls on after the clap: three recirculating delays, each duller than the last pass.
    this.rollIn = gain(1);
    const rollOut = gain(0.6); rollOut.connect(this.world);
    for (const [time, feedback, hz] of [[0.47, 0.36, 520], [0.83, 0.4, 380], [1.31, 0.34, 300]]) {
      const d = ctx.createDelay(2), lp = filter('lowpass', hz), fb = gain(feedback);
      d.delayTime.value = time;
      this.rollIn.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(rollOut);
    }

    // Wheels: the Cessna's own landing roll on grass. A paved runway keeps only the low rumble of it, gravel
    // gets it brighter and busier.
    this.rollLP = filter('lowpass', 4000, 0.6); this.rollTone = filter('highshelf', 900, 0.707, 0);
    this.roll = new Loop(ctx, this.rollLP);
    chain(this.rollLP, this.rollTone, gain(MIX.roll), this.cabin); chain(this.rollTone, gain(MIX.rollOutside), this.outside);

    // Stall warning: a reed horn in the wing root, blown harder and sharper as the wing gets closer to the stall.
    this.horn = ctx.createOscillator(); this.horn.setPeriodicWave(reedWave(ctx)); this.horn.frequency.value = 430;
    this.hornGain = gain(0);
    const hornBody = gain(1);
    chain(this.horn, filter('bandpass', 1250, 2.2), hornBody); chain(this.horn, filter('bandpass', 2900, 3), gain(0.7), hornBody); chain(this.horn, gain(0.25), hornBody);
    // A reed is never steady: its pitch wanders a little, and the air that drives it hisses through the slot.
    const air = ctx.createBufferSource(); air.buffer = noiseBuffer(ctx, 3.7, 'white', 77, 1); air.loop = true;
    chain(air, filter('lowpass', 14), gain(2600), this.horn.frequency);
    chain(air, filter('bandpass', 2300, 0.7), gain(2.2), hornBody);
    air.start();
    chain(hornBody, this.hornGain, this.cabin); chain(this.hornGain, filter('lowpass', 3500), gain(MIX.hornOutside), this.outside);
    this.horn.start();

    this.buf = {};                                               // one-shots by name
    this.claps = [];                                             // thunder recordings: { name, buffer, kind, long }
    this._perspective(1, ctx.currentTime, true);
  }

  /** Cockpit (0) or chase (1): one place moves the three buses, smoothly. */
  _perspective(p, t, now = false) {
    this._view = p;
    const set = (param, v) => (now ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, 0.12));
    set(this.cabin.gain, Math.cos(p * HALF_PI));
    set(this.outside.gain, Math.sin(p * HALF_PI) * MIX.outside);
    set(this.worldDirect.gain, Math.sin(p * HALF_PI));
    set(this.worldThrough.gain, Math.cos(p * HALF_PI) * MIX.worldInCabin);
  }

  // ------------------------------------------------------------------------------------------ loading

  async _load() {
    let manifest;
    try {
      const r = await fetch(`${AUDIO_URL}manifest.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      manifest = await r.json();
    } catch (e) { console.warn('Sound: no manifest, using synthesized stand-ins.', e); this.failed.push('manifest.json'); return; }
    this.manifest = manifest;
    await Promise.all(Object.entries(manifest.sounds).map(async ([name, meta]) => {
      try {
        const r = await fetch(AUDIO_URL + meta.file);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.arrayBuffer();
        const buffer = await new Promise((res, rej) => { const p = this.ctx.decodeAudioData(data, res, rej); if (p && p.catch) p.catch(rej); });
        this._arrive(name, buffer, meta);
      } catch (e) { console.warn(`Sound: ${meta.file} did not load.`, e); this.failed.push(name); }
    }));
  }

  async _adopt(buffers, manifest) {
    this.manifest = manifest;
    for (const [name, meta] of Object.entries(manifest.sounds)) if (buffers[name]) this._arrive(name, buffers[name], meta); else this.failed.push(name);
  }

  /** A decoded file goes to the layer that plays it. Loops start at once, silent until a gain opens them. */
  _arrive(name, buffer, meta) {
    const ctx = this.ctx, phase = this._rand();
    if (name.startsWith('eng_cab_') || name.startsWith('eng_ext_')) {
      const cabin = name.startsWith('eng_cab_'), list = cabin ? this.bands : this.ext;
      list.push({ name, rpm: meta.rpm, loop: new Loop(ctx, cabin ? this.engLoops : this.extLoops).set(buffer, meta.loop, phase) });
      list.sort((a, b) => a.rpm - b.rpm);
      if (cabin && list[0].name === name) this.mill.set(buffer, meta.loop, this._rand()), this.millRpm = meta.rpm;
      return;
    }
    const loops = { jet_roar: this.jetRoar, jet_whine: this.jetWhine, jet_cabin: this.jetCabin, jet_burner: this.jetBurner, air_cabin: this.airCab, air_rush: this.airRush, air_gust: this.airGust, rain_light: this.rainLight, rain_heavy: this.rainHeavy, hail: this.hail, roll_grass: this.roll };
    if (name === 'jet_whine') this.whineRef = meta.n1 ?? 0.08;      // how fast the engine was turning in the recording (0 idle .. 1 full)
    if (loops[name]) { loops[name].set(buffer, meta.loop, phase); return; }
    if (name.startsWith('thunder_')) this.claps.push({ name, buffer, kind: name.includes('near') ? 'near' : 'far', long: buffer.duration > 16 });
    else { this.buf[name] = buffer; if (name === 'eng_start') this.startMeta = meta; }
  }

  /** Whatever is still missing after loading gets a synthesized replacement. */
  _standIns() {
    const ctx = this.ctx, used = [];
    if (!this.bands.length) {
      const e = standInEngine(ctx);
      this.bands.push({ name: 'stand-in', rpm: e.rpm, loop: new Loop(ctx, this.engLoops).set(e.buffer, e.loop) });
      this.mill.set(e.buffer, e.loop, 0.5); this.millRpm = e.rpm; used.push('engine');
    }
    const noise = (loop, color, seed, what) => { if (!loop.loaded) { loop.set(noiseBuffer(ctx, 6, color, seed), null); used.push(what); } };
    noise(this.airCab, 'pink', 31, 'cabin air'); noise(this.airRush, 'brown', 37, 'wind');
    if (!this.rainHeavy.loaded && !this.rainLight.loaded) noise(this.rainHeavy, 'white', 41, 'rain');
    noise(this.roll, 'brown', 43, 'wheels');
    noise(this.jetRoar, 'pink', 61, 'jet roar'); noise(this.jetCabin, 'brown', 67, 'jet cabin'); noise(this.jetBurner, 'brown', 71, 'afterburner');
    if (!this.jetWhine.loaded) { this.jetWhine.set(whineBuffer(ctx), null); this.whineRef = 0.75; used.push('jet whine'); }
    if (!this.claps.length) {
      this.claps.push({ name: 'stand-in near', buffer: standInBurst(ctx, 7, 700, 1.6, 51), kind: 'near' }, { name: 'stand-in far', buffer: standInBurst(ctx, 9, 160, 2.6, 53), kind: 'far' });
      used.push('thunder');
    }
    if (!this.buf.crash) { this.buf.crash = standInBurst(ctx, 2, 1400, 0.45, 57); used.push('crash'); }
    if (!this.buf.touchdown) { this.buf.touchdown = standInBurst(ctx, 0.6, 160, 0.14, 59); used.push('touchdown'); }
    this.standIns = used;
    if (used.length) console.warn(`Sound: synthesized stand-ins in use for ${used.join(', ')}.`);
  }

  // ------------------------------------------------------------------------------------------ per frame

  /**
   * Every frame. Only `active` is required; everything else has a sensible default.
   *   active      flying, not paused, not loading
   *   view        'cockpit' or 'chase'
   *   rpm         engine speed (falls back to an estimate from `power`); for a jet, fan speed in percent
   *   jet         true for a jet: its own engine voice. reheat 0..1: the afterburner. jetTone 0..1: from an airliner's
   *               deep fan to a fighter's hard-edged exhaust
   *   airRef      airspeed (m/s) at which the airflow is as loud as a Cessna's in cruise (default 52)
   *   power       thrust lever position after engine lag, 0..1
   *   engine      false when the engine has stopped (fuel) and the propeller windmills
   *   crashed     true while the wreck sits there
   *   ias         indicated airspeed, m/s
   *   onGround, groundSpeed (m/s), surface ('paved' | 'gravel' | 'grass')
   *   rain, snow, hail   0..1 at the aircraft
   *   turb        turbulence 0..1
   *   cloud       0..1, how deep in cloud
   *   stall       warning on;  stallLevel 0..1 how far into the stall
   */
  update(s) {
    this._active = !!s.active;
    if (!this.ctx) return;
    const live = this._active && this.enabled && !this._hidden;
    this._run(live);
    if (!live) return;
    const ctx = this.ctx, t = ctx.currentTime, st = this.state;

    const view = s.view === 'cockpit' ? 0 : 1;
    if (view !== this._view) this._perspective(view, t);

    const power = clamp(s.power ?? 0, 0, 1);
    const rpmIn = s.rpm ?? 650 + 1650 * Math.pow(power, 0.8);
    const ias = Math.max(0, s.ias || 0), onGround = !!s.onGround, crashed = !!s.crashed;
    const fire = s.engine !== false && !crashed;                 // the engine is running under its own power
    if (s.surface) this._surface = s.surface;
    const jet = !!s.jet;
    if (jet !== this._jet) { this._jet = jet; if (this._engOn && !this._fresh) this._fresh = 'running'; }    // another kind of engine: hand over to its voice

    // ---- engine state: start from cold, cut on a crash, die away when it stops
    if (fire !== this._engOn) {
      this._engOn = fire;
      if (fire) this._fresh = this._fresh || true; else this._stopEngine(t, crashed ? 0.025 : 0.45);
    }
    if (fire && this._fresh) {
      // Wait for the files (the start is a recording) unless they are taking too long.
      this._freshAt ??= t;
      if (this.ready || t - this._freshAt > 2.5) { this._startEngine(t, this._fresh === true); this._fresh = false; this._freshAt = undefined; }
    }

    // A started engine runs up before it settles to idle. The loops take over from the recorded start at the
    // speed that recording has reached, then come down to whatever the flight model says.
    const since = t - this._engT0, settle = this._settleRpm;
    const flare = since < 9 && rpmIn < settle ? (settle - rpmIn) * (since < 1.2 ? 1 : Math.exp(-(since - 1.2) / 0.85)) : 0;
    const rpm = clamp(rpmIn + flare, 300, 3200);
    // Load: where the throttle is against where it would be for this speed in steady running.
    const expected = Math.pow(clamp((rpm - 650) / 1650, 0, 1), 1.25);
    const load = clamp(power + 0.5 * (power - expected), 0, 1), surge = clamp(power - expected, -1, 1);
    const level = dB(curve(MIX.engineByRpm, rpm) + 3.5 * surge);

    const rpms = this.bands.map((b) => b.rpm), w = bandWeights(rpms, rpm, 0.06);
    st.rates = []; st.weights = w;
    this.bands.forEach((b, i) => { const r = clamp(rpm / b.rpm, 0.3, 2); b.loop.setRate(r, t, 0.04); b.loop.setLevel(w[i], t, 0.04); st.rates.push(r); });
    const we = bandWeights(this.ext.map((b) => b.rpm), rpm, 0.1);
    this.ext.forEach((b, i) => { b.loop.setRate(clamp(rpm / b.rpm, 0.3, 2.2), t, 0.04); b.loop.setLevel(we[i], t, 0.04); });
    this.engLevel.gain.setTargetAtTime(level, t, 0.07);
    this.extLevel.gain.setTargetAtTime(level, t, 0.07);
    this.engBark.gain.setTargetAtTime(-2 + 5.5 * load, t, 0.1);
    this.engAir.gain.setTargetAtTime(-5 * (1 - load) * smooth(900, 1900, rpm), t, 0.1);   // a closed throttle at speed is hushed; an idle is not
    // At low speed the firing strokes are far enough apart to hear singly, and it is these harmonics that carry them.
    const slow = smooth(1700, 800, rpm);
    this.excDrive.gain.setTargetAtTime(1.3 + 1.5 * load + 1.2 * slow, t, 0.1);
    this.excLevel.gain.setTargetAtTime(level * (0.5 + 0.6 * load) * (1 + 5 * slow), t, 0.08);
    // Stopped engine, propeller still turning in the airflow.
    const mill = !fire && !crashed ? clamp(rpmIn / 900, 0, 1) : 0;
    this.mill.setRate(clamp(rpmIn / (this.millRpm || 1100), 0.12, 1.3), t, 0.1);
    this.mill.setLevel(mill * dB(-9), t, 0.25);
    st.rpm = rpm; st.load = load; st.engineLevel = level;

    // ---- jet engine: thrust sets the roar, fan speed the pitch of the whine
    if (jet) {
      const n1 = clamp((rpmIn - 15) / 85, 0, 1), tone = clamp(s.jetTone ?? 0, 0, 1), ab = clamp(s.reheat || 0, 0, 1);
      this.jetRoar.setLevel(dB(-17 + (17 + 3 * tone) * Math.pow(power, 0.6)), t, 0.15); this.jetRoar.setRate(0.7 + 0.3 * n1, t, 0.2);
      this.jetRoarLP.frequency.setTargetAtTime(260 + (1700 + 2600 * tone) * Math.pow(power, 1.3), t, 0.15);
      this.jetWhine.setLevel(dB(-9 - 9 * power - 3 * tone), t, 0.15); this.jetWhine.setRate((0.6 + 0.5 * n1) / (0.6 + 0.5 * (this.whineRef ?? 0.08)), t, 0.12);
      this.jetCabin.setLevel(dB(-12 + 10 * power), t, 0.2); this.jetCabin.setRate(0.8 + 0.3 * n1, t, 0.2);
      this.jetBurner.setLevel(ab, t, 0.12); this.jetBurner.setRate(0.85 + 0.2 * ab, t, 0.2);
      st.n1 = n1; st.reheat = ab;
    }

    // ---- air: dynamic pressure, so the square of airspeed
    const aref = s.airRef || 52, q = clamp((ias / aref) * (ias / aref), 0, 2.2), v1 = clamp(ias / (aref * 1.15), 0, 1.3);
    const turb = clamp(s.turb || 0, 0, 1), cloud = clamp(s.cloud || 0, 0, 1);
    const swell = clamp(0.1 + 1.5 * turb, 0, 1) * 0.6;           // how far gusts move the wind level
    const cab = 0.9 * Math.pow(q, 0.85), rush = Math.pow(q, 0.85), gust = turb * (0.2 + 0.8 * Math.min(q, 1.3));
    this.airCab.setLevel(cab, t, 0.12); this.airCab.setRate(0.82 + 0.3 * v1, t, 0.2);
    this.airCabLP.frequency.setTargetAtTime((1300 + 5200 * Math.min(v1, 1)) * (1 - 0.45 * cloud), t, 0.15);
    this.airRush.setLevel(rush, t, 0.12); this.airRush.setRate(0.8 + 0.35 * v1, t, 0.2);
    this.rushLP.frequency.setTargetAtTime(1200 + 8500 * Math.min(v1, 1) * (1 - 0.5 * cloud), t, 0.15);
    this.airGust.setLevel(gust, t, 0.25); this.airGust.setRate(0.9 + 0.25 * Math.min(q, 1), t, 0.3);
    this.gustCab.gain.setTargetAtTime(cab * swell, t, 0.2); this.gustRush.gain.setTargetAtTime(rush * swell, t, 0.2); this.gustGust.gain.setTargetAtTime(gust * 0.7, t, 0.2);
    this.cloudEq.gain.setTargetAtTime(-7 * cloud, t, 0.35);
    // Stall buffet comes in before the break and shakes hardest in it.
    const deep = clamp(s.stallLevel ?? (s.stall ? 0.7 : 0), 0, 1);
    const buffet = onGround ? 0 : smooth(0.3, 0.85, deep) * clamp(ias / 22, 0, 1);
    this.buffet.setLevel(buffet, t, 0.1); this.buffet.setRate(0.9 + 0.3 * buffet, t, 0.2);

    // ---- weather: what hits the windshield depends on how fast you fly into it
    const drive = 0.5 + 0.5 * clamp(ias / 45, 0, 1.3);
    const R = clamp((s.rain || 0) * drive + (s.snow || 0) * 0.07, 0, 1.3);
    const x = smooth(0.16, 0.7, R), rg = R > 0.004 ? 0.3 + 0.7 * Math.pow(Math.min(R, 1), 0.6) : 0;
    this.rainLight.setLevel(rg * Math.cos(x * HALF_PI) * Math.sqrt(clamp(R / 0.1, 0, 1)), t, 0.3);
    this.rainHeavy.setLevel(rg * Math.sin(x * HALF_PI), t, 0.3);
    const fast = 0.95 + 0.14 * clamp(ias / 50, 0, 1.2);
    this.rainLight.setRate(fast, t, 0.3); this.rainHeavy.setRate(fast, t, 0.3);
    const H = clamp((s.hail || 0) * (0.55 + 0.45 * clamp(ias / 45, 0, 1.3)), 0, 1.2);
    this.hail.setLevel(H > 0.004 ? Math.pow(H, 0.7) : 0, t, 0.3); this.hail.setRate(0.9 + 0.22 * clamp(ias / 50, 0, 1.2), t, 0.3);
    st.rain = R; st.hail = H;

    // ---- wheels on the ground
    const gs = onGround && !crashed ? Math.max(0, s.groundSpeed || 0) : 0, vr = clamp(gs / 30, 0, 1.3), roll = Math.pow(vr, 0.75);
    const surf = this._surface, gravel = surf === 'gravel', paved = surf === 'paved';
    this.roll.setLevel(roll * (paved ? 0.5 : gravel ? 0.85 : 1), t, 0.08);
    this.roll.setRate((gravel ? 0.9 : 0.7) + 0.45 * vr, t, 0.15);
    this.rollLP.frequency.setTargetAtTime(paved ? 190 : gravel ? 9000 : 4200, t, 0.1);
    this.rollTone.gain.setTargetAtTime(gravel ? 7 : 0, t, 0.1);

    // ---- stall horn
    const horn = s.stall && !crashed ? smooth(0.4, 0.95, deep) : -1;
    this.hornGain.gain.setTargetAtTime(horn < 0 ? 0 : MIX.horn * (0.55 + 0.45 * horn), t, horn < 0 ? 0.05 : 0.04);
    this.horn.frequency.setTargetAtTime(horn < 0 ? 395 : 425 * (1 + 0.17 * horn), t, 0.09);      // it speaks from a little flat
    st.horn = horn; st.buffet = buffet; st.q = q;
  }

  /** Bring the engine in: from cold with the recorded start, or straight in if it was running all along. */
  _startEngine(t, cold = true) {
    const g = this.engLoops.gain, e = this.extLoops.gain, shot = cold && this.buf.eng_start, meta = this.startMeta || {};
    const at = shot ? meta.catchAt ?? 1.3 : 0;                   // when the engine catches, after the starter
    for (const p of [g, e, this.jetOn.gain, this.jetOnCab.gain]) { p.cancelScheduledValues(t); p.setValueAtTime(0, t); }
    if (this._jet) {                                             // a jet winds up over a few seconds, with no starter to hear
      for (const p of [this.jetOn.gain, this.jetOnCab.gain]) p.linearRampToValueAtTime(1, t + (cold ? 2.4 : 0.4));
      this._engT0 = -1e9; return;
    }
    this._engT0 = cold ? t + at : -1e9; this._settleRpm = shot ? meta.settleRpm ?? 1330 : 1100;
    if (!cold) for (const p of [g, e]) p.linearRampToValueAtTime(1, t + 0.4);
    else if (shot) {
      // Starter and first firing from the recording, then a short hand-over to the loops at the same speed.
      const s = this._starter = this._shot(shot, this.startBus, { when: t });
      s.gain.gain.setValueAtTime(1, t + at + 0.45); s.gain.gain.linearRampToValueAtTime(0, t + at + 1.25);
      for (const p of [g, e]) { p.setValueAtTime(0, t + at + 0.3); p.linearRampToValueAtTime(1, t + at + 1.15); }
    } else for (const p of [g, e]) p.linearRampToValueAtTime(1, t + 1.4);
  }

  _stopEngine(t, tau) {
    for (const p of [this.engLoops.gain, this.extLoops.gain, this.jetOn.gain, this.jetOnCab.gain]) { p.cancelScheduledValues(t); p.setTargetAtTime(0, t, tau); }
    if (this._starter) { const g = this._starter.gain.gain; g.cancelScheduledValues(t); g.setTargetAtTime(0, t, tau); this._starter = null; }
    this._engT0 = -1e9;
  }

  /** Play a buffer once through its own gain (and optional filter); the nodes free themselves when it ends. */
  _shot(buffer, dest, { when = 0, gain = 1, rate = 1, lowpass = 0, send = null, sendGain = 0 } = {}) {
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffer; src.playbackRate.value = rate; g.gain.value = gain;
    let tail = src;
    if (lowpass) { const f = this._filter('lowpass', lowpass, 0.6); src.connect(f); tail = f; }
    tail.connect(g); g.connect(dest);
    let sg = null;
    if (send) { sg = ctx.createGain(); sg.gain.value = sendGain; g.connect(sg); sg.connect(send); }
    src.onended = () => { src.disconnect(); if (tail !== src) tail.disconnect(); g.disconnect(); if (sg) sg.disconnect(); };
    src.start(Math.max(when, ctx.currentTime));
    return { src, gain: g };
  }

  // ------------------------------------------------------------------------------------------ events

  /**
   * Lightning struck `distance` meters away. Close strikes crack with their whole spectrum almost at once;
   * distant ones arrive later as a low roll. Sound takes three seconds a kilometer, but the wait is eased off
   * with distance and stops at eight seconds, so the thunder still belongs to its flash.
   */
  thunder(distance) {
    if (!this.ctx || !this.enabled) return;
    const d = Math.max(0, distance), km = d / 1000, ctx = this.ctx;
    // Close strikes use the recordings of close cracks, far ones the distant rolls (and the one long roller);
    // in between anything goes. Never the same recording twice running.
    const fits = (c) => (d < 2500 ? c.kind === 'near' : d < 7000 ? true : c.kind === 'far' || c.long);
    let pool = this.claps.filter((c) => fits(c) && c !== this._lastClap);
    if (!pool.length) pool = this.claps.filter((c) => c !== this._lastClap);
    if (!pool.length) pool = this.claps;
    if (!pool.length) return;
    const clap = this._lastClap = pool[Math.floor(this._rand() * pool.length)], buffer = clap.buffer;
    const delay = 8 * (1 - Math.exp(-3 * km / 8));
    // Loudness falls with distance far more gently than it does in air: thunder twenty kilometers off is
    // still meant to be heard over an engine. What distance takes away is the top of the spectrum.
    const gain = MIX.thunder * dB(-9 * Math.log10(1 + d / 1500));
    const lowpass = clamp(16000 * Math.exp(-d / 2800), 500, 16000);
    const rate = (1 - 0.12 * clamp(km / 15, 0, 1)) * (0.95 + 0.1 * this._rand());
    const when = ctx.currentTime + delay;
    this._shot(buffer, this.world, { when, gain, rate, lowpass: lowpass < 15000 ? lowpass : 0, send: this.rollIn, sendGain: 0.3 + 0.5 * clamp(km / 8, 0, 1) });
    // A close strike takes over: everything else drops back for a moment and returns as the clap dies away.
    const duck = 6.5 * (1 - smooth(600, 6000, d));
    if (duck > 0.3) {
      const g = this.bed.gain;
      g.setTargetAtTime(dB(-duck), when, 0.03); g.setTargetAtTime(1, when + 0.9, 1.3);
    }
    this.state.thunder = { delay, gain, lowpass, rate, clap: clap.name };
  }

  /** Touchdown. k is the sink rate from 0 (kissed it on) to 1 (dropped it); surface as in update(). */
  chirp(k, surface) {
    if (!this.ctx || !this.enabled) return;
    if (surface) this._surface = surface;
    const t = this.ctx.currentTime, hard = clamp(k, 0, 1), paved = this._surface === 'paved';
    if (this.buf.touchdown) {
      // The gear taking the weight: the recorded thump, in the cabin and a little outside.
      this._shot(this.buf.touchdown, this.cabin, { when: t, gain: dB(-13 + 11 * hard), rate: 1.05 - 0.15 * hard, lowpass: paved ? 900 : 0 });
      this._shot(this.buf.touchdown, this.outside, { when: t, gain: dB(-19 + 11 * hard), rate: 1.05 - 0.15 * hard, lowpass: paved ? 900 : 2500 });
    }
    if (!paved) return;                                          // grass and gravel do not squeal
    // Two main wheels spinning up on a paved runway, a few hundredths of a second apart.
    const chirp = this.buf.tire_chirp, g = dB(-15 + 11 * hard);
    if (chirp) { this._shot(chirp, this.world, { when: t, gain: g, rate: 0.92 + 0.1 * this._rand() }); this._shot(chirp, this.world, { when: t + 0.045 + 0.05 * this._rand(), gain: g * 0.8, rate: 1.02 + 0.12 * this._rand() }); }
    if (this.buf.tire_screech && hard > 0.3) this._shot(this.buf.tire_screech, this.world, { when: t + 0.02, gain: dB(-20 + 12 * hard), rate: 1.1 + 0.2 * this._rand() });
  }

  crash() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    this._engOn = false; this._stopEngine(t, 0.025);
    if (this.buf.crash) this._shot(this.buf.crash, this.world, { when: t, gain: dB(4) });
    if (this.buf.touchdown) this._shot(this.buf.touchdown, this.cabin, { when: t, gain: dB(3), rate: 0.6 });
  }
}
