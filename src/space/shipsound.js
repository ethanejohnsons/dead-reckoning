// The sound of the starship: five recordings (public/audio/ship_*.mp3, credited in public/audio/CREDITS.md)
// played through filters that follow the flight. None is a recording of a starship; each is a real machine
// doing what the ship is imagined to do.
//
//   hum      the ship itself, always there: the deep drone of refrigeration plant, most of it below 120 Hz.
//   impulse  the impulse engines: an industrial turbine's motor, rising in pitch and level with their power.
//   warp     the warp field: a power transformer's hum, played higher the higher the warp factor, with a
//            second voice a fifth above it.
//   spool    winding up for the jump: the climbing whine of an electric train's motor, played fast so its
//            three seconds fit the moment before the ship goes (and played backward as it comes out of warp).
//   boom     the jump itself: a sonic boom and its roll, with a slowed copy under it for weight.
//
// Space is silent, and this is not: the ship is heard as its crew hears it, from inside, wherever the camera
// is. The views differ only in how much of it comes through: the bridge is closest to the machinery; the
// chase view is the same sound held back and duller; a camera left in the ship's path hears it swell as it
// passes. Everything goes into the game's master bus (core/audio.js: Sound.sum), as the rocket's sounds do.

const URL_BASE = `${import.meta.env.BASE_URL}audio/`;
const dB = (d) => Math.pow(10, d / 20);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** The mix, in one place: each layer's level at its fullest, from the bridge. */
export const SHIP_MIX = { hum: dB(-4), impulse: dB(0), warp: dB(1), warpFifth: dB(-7), spool: dB(7), boom: dB(6), boomLow: dB(3), chase: 0.7, flyby: 0.75 };

export class ShipSound {
  constructor() { this.ctx = null; this.ready = false; this.loading = false; this.state = {}; }

  /** Build on the game's audio context once it exists (it is made at the first Fly click), and load the recordings. */
  attach(sound) {
    if (this.ctx || this.loading || !sound?.ctx || !sound.sum) return;
    const ctx = this.ctx = sound.ctx;
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filter = (type, f, q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    this.out = gain(0); this.out.connect(sound.sum);
    this.tone = filter('lowpass', 2000, 0.6); this.tone.connect(this.out);            // the view: how much of the ship's top end comes through
    this.gHum = gain(); this.gImpulse = gain(); this.gWarp = gain(); this.gFifth = gain(); this.gShots = gain(1);
    this.impulseLp = filter('lowpass', 900, 0.7);
    for (const g of [this.gHum, this.gWarp, this.gFifth]) g.connect(this.tone);
    this.impulseLp.connect(this.gImpulse); this.gImpulse.connect(this.tone);
    this.gShots.connect(this.out);                                                    // (the jump is heard in full whatever the view)
    this.loading = true;
    this.load().then(() => { this.ready = true; this.startLoops(); }).catch((e) => console.warn('The starship\'s sounds did not load:', e.message)).finally(() => { this.loading = false; });
  }

  async load() {
    const man = await (await fetch(`${URL_BASE}ship.json`)).json();
    this.info = man.sounds; this.buf = {};
    await Promise.all(Object.entries(man.sounds).map(async ([k, v]) => {
      const data = await (await fetch(URL_BASE + v.file)).arrayBuffer();
      this.buf[k] = await new Promise((res, rej) => { const p = this.ctx.decodeAudioData(data, res, rej); if (p && p.catch) p.catch(rej); });
    }));
    // The spool-up backward: the same motor winding down, for coming out of warp.
    const s = this.buf.ship_spool, r = this.ctx.createBuffer(s.numberOfChannels, s.length, s.sampleRate);
    for (let c = 0; c < s.numberOfChannels; c++) { const a = s.getChannelData(c), b = r.getChannelData(c); for (let i = 0, n = a.length; i < n; i++) b[i] = a[n - 1 - i]; }
    this.buf.ship_unspool = r;
  }

  startLoops() {
    const play = (name, rate, to, offset = 0) => {
      const s = this.ctx.createBufferSource(), i = this.info[name];
      s.buffer = this.buf[name]; s.loop = true; s.loopStart = i.loop[0]; s.loopEnd = i.loop[1]; s.playbackRate.value = rate;
      s.connect(to); s.start(0, i.loop[0] + offset);
      return s;
    };
    this.sHum = play('ship_hum', 1, this.gHum);
    this.sImpulse = play('ship_impulse', 0.8, this.impulseLp);
    this.sWarp = play('ship_warp', 1, this.gWarp);
    this.sFifth = play('ship_warp', 1.5, this.gFifth, 3.7);          // (started elsewhere in the loop, so the two never line up)
  }

  /** One of the single sounds, once: at a playback rate and level, after a delay (s). */
  shot(name, rate, level, delay = 0) {
    if (!this.ready || !this.live) return;
    const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = this.buf[name]; src.playbackRate.value = rate; g.gain.value = level;
    src.connect(g); g.connect(this.gShots); src.start(ctx.currentTime + delay);
    src.onended = () => { g.disconnect(); };
  }
  /** The ship winds up for warp: the jump will follow in `secs`. */
  spoolUp(secs) { this.shot('ship_spool', this.info ? this.info.ship_spool.duration / Math.max(secs, 0.2) : 3, SHIP_MIX.spool); }
  /** The jump to warp. */
  jump() { this.shot('ship_boom', 1, SHIP_MIX.boom); this.shot('ship_boom', 0.5, SHIP_MIX.boomLow); }
  /** Out of warp: the motor winds down, and a softer, lower boom. */
  drop() { this.shot('ship_unspool', 2.3, SHIP_MIX.spool * 0.8); this.shot('ship_boom', 0.7, SHIP_MIX.boom * 0.45, 0.25); }

  /**
   * Once a frame. s: { on (is the flight running: false on the title screen), view: 'chase' | 'bridge' | 'flyby',
   * impulse 0..1 (what the impulse engines are giving), warp (the warp factor the ship is at, 0 under impulse),
   * spool 0..1 (winding up for the jump), dist (camera to ship, m) }
   */
  update(dt, s) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, M = SHIP_MIX;
    this.live = !!s.on;
    const set = (p, v, tau = 0.15) => p.setTargetAtTime(v, t, tau);
    // The view.
    let level = 1, fc = 2600;
    if (s.view === 'chase') { level = M.chase; fc = s.warp >= 1 ? 1900 : 900; }                // (at warp more of it comes through)
    else if (s.view === 'flyby') { const near = clamp(Math.pow(900 / Math.max(s.dist || 900, 200), 0.8), 0.12, 1.3); level = M.flyby * near; fc = 500 + 1800 * clamp(near, 0, 1); }
    set(this.out.gain, s.on ? level : 0, 0.25); set(this.tone.frequency, fc, 0.3);
    const P = clamp(s.impulse || 0, 0, 1), W = clamp((s.warp || 0) / 9, 0, 1), at = s.warp >= 1 ? 1 : 0, sp = clamp(s.spool || 0, 0, 1);
    set(this.gHum.gain, M.hum * (1 + 0.25 * P), 0.4);
    // Impulse: from a murmur to a full-throated drone, the pitch climbing with it; drowned by the warp field when at warp.
    set(this.gImpulse.gain, M.impulse * (0.12 + 0.88 * Math.pow(P, 0.8)) * (1 - 0.6 * at), 0.3);
    set(this.sImpulse.playbackRate, 0.72 + 0.6 * P + 0.25 * sp, 0.3); set(this.impulseLp.frequency, 500 + 2400 * P + 1500 * sp, 0.3);
    // The warp field: there as the ship winds up, full at warp, higher with the factor.
    const wl = Math.max(at, 0.5 * sp * sp);
    set(this.gWarp.gain, M.warp * wl, at ? 0.12 : 0.35); set(this.gFifth.gain, M.warpFifth * wl * (0.4 + 0.6 * W), 0.3);
    const rate = 0.85 + 1.0 * W + 0.3 * sp;
    set(this.sWarp.playbackRate, rate, 0.25); set(this.sFifth.playbackRate, rate * 1.5, 0.25);
    this.state = { level: s.on ? level : 0, fc, impulse: P, warp: wl, rate };
  }

  /** The flight is over: let everything die away. */
  silence() {
    this.live = false;
    if (!this.ready) return;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}
