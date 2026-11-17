// The sound of a rocket: three recordings (public/audio/rocket_*.mp3, credited in public/audio/CREDITS.md) played
// through filters that follow the flight.
//
//   roar     a Space Shuttle launch from the press site: the roar and its crackle. Played twice, once as it
//            is and once slowed to two thirds (lower and slower, the body of a bigger vehicle).
//   rumble   a launch recorded 20 km away, where only what is below 120 Hz arrives: the part that is felt.
//   ignite   the Artemis II engines lighting, once, when the thrust comes up from nothing.
//
// What the filters do is the physics, roughly. Sound needs air: the thinner the air around the vehicle, the
// less of the roar there is and the duller what is left (the highs go first), so the climb goes from a
// crackling roar on the pad to a low thunder by 10 miles up to almost nothing by 30. The microphone matters:
//   chase    flying beside the vehicle. Loudest and brightest near the ground (the pad throws the sound back),
//            less with distance, and past Mach 1 the vehicle is outrunning most of its own noise.
//   onboard  bolted to the skin. The engines come through the structure whatever the air is doing: a heavy
//            rumble with the roar muffled over it, all the way to orbit.
//   map      everything turned well down.
// In vacuum the chase view keeps a trace of the rumble under a burn (felt rather than heard): a choice for the
// player's sake, not physics.
//
// Everything goes into the game's master bus (core/audio.js: Sound.sum), so the compressor, the limiter and the
// pause that govern the airplane's sounds govern these.

const URL_BASE = `${import.meta.env.BASE_URL}audio/`;
const dB = (d) => Math.pow(10, d / 20);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** The mix, in one place: each layer's level at full thrust of the biggest stage, at sea level, in the chase view. */
export const ROCKET_MIX = { roar: dB(5), low: dB(3), rumble: dB(7), ignite: dB(6), vacuum: 0.1, map: 0.3 };

export class RocketSound {
  constructor() { this.ctx = null; this.ready = false; this.loading = false; this.thrustWas = 0; this.state = {}; }

  /** Build on the game's audio context once it exists (it is made at the first Fly click), and load the recordings. */
  attach(sound) {
    if (this.ctx || this.loading || !sound?.ctx || !sound.sum) return;
    const ctx = this.ctx = sound.ctx;
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filter = (type, f, q = 0.707, g = 0) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = g; return b; };
    this.out = gain(1); this.out.connect(sound.sum);
    // roar -> presence (the crackle, near the ground) -> low-pass (the air) -> level
    this.gRoar = gain(); this.gLow = gain(); this.gRumble = gain(); this.gIgnite = gain(1);
    this.air = filter('lowpass', 14000, 0.6); this.air2 = filter('lowpass', 14000, 0.5);
    this.presence = filter('peaking', 2600, 0.8, 0);
    this.lowLp = filter('lowpass', 700, 0.6);
    this.rumbleLp = filter('lowpass', 150, 0.7);
    this.presence.connect(this.air); this.air.connect(this.air2); this.air2.connect(this.gRoar); this.gRoar.connect(this.out);
    this.lowLp.connect(this.gLow); this.gLow.connect(this.out);
    this.rumbleLp.connect(this.gRumble); this.gRumble.connect(this.out);
    this.igniteLp = filter('lowpass', 14000, 0.6); this.igniteLp.connect(this.gIgnite); this.gIgnite.connect(this.out);
    this.loading = true;
    this.load().then(() => { this.ready = true; this.startLoops(); }).catch((e) => console.warn('The rocket\'s sounds did not load:', e.message)).finally(() => { this.loading = false; });
  }

  async load() {
    const man = await (await fetch(`${URL_BASE}rocket.json`)).json();
    this.info = man.sounds; this.buf = {};
    await Promise.all(Object.entries(man.sounds).map(async ([k, v]) => {
      const data = await (await fetch(URL_BASE + v.file)).arrayBuffer();
      this.buf[k] = await new Promise((res, rej) => { const p = this.ctx.decodeAudioData(data, res, rej); if (p && p.catch) p.catch(rej); });
    }));
  }

  startLoops() {
    const play = (name, rate, to, offset = 0) => {
      const s = this.ctx.createBufferSource(), i = this.info[name];
      s.buffer = this.buf[name]; s.loop = true; s.loopStart = i.loop[0]; s.loopEnd = i.loop[1]; s.playbackRate.value = rate;
      s.connect(to); s.start(0, i.loop[0] + offset);
      return s;
    };
    this.sRoar = play('rocket_roar', 1, this.presence);
    this.sLow = play('rocket_roar', 0.66, this.lowLp, 3.1);          // (started elsewhere in the loop, so the two never line up)
    this.sRumble = play('rocket_rumble', 1, this.rumbleLp);
  }

  /**
   * Once a frame. s: { thrust 0..1 (what the engines are giving), size (the stage's thrust against a Saturn V first
   * stage's, 0..1.2), pressure 0..1 (air around the vehicle against sea level), view: 'chase' | 'onboard' | 'map',
   * dist (camera to vehicle, m), agl (m), mach, pitch (playback rate of the roar: a little higher for smaller engines),
   * q (dynamic pressure, Pa: the air itself roars past at max-Q and again coming home) }
   */
  update(dt, s) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, M = ROCKET_MIX;
    const T = clamp(s.thrust || 0, 0, 1), K = clamp(Math.sqrt(s.size || 1), 0.3, 1.1), air = Math.sqrt(clamp(s.pressure || 0, 0, 1));
    let roar, low, rumble, fc, pres = 0, rfc = 150;
    if (s.view === 'onboard') {
      fc = 420 + 1300 * air; roar = 0.22 + 0.3 * air; low = 0.6; rumble = 1.1; rfc = 190;
    } else {
      const near = clamp(Math.pow(320 / Math.max(s.dist || 320, 30), 0.6), 0.45, 1.4), ground = Math.exp(-Math.max(s.agl || 0, 0) / 300);
      const outrun = 1 - 0.4 * smooth(0.9, 2.2, s.mach || 0);
      fc = 180 * Math.exp(Math.log(14000 / 180) * Math.pow(air, 0.8)) * outrun;
      roar = Math.pow(air, 0.9) * near * (1 + 0.35 * ground) * outrun;
      low = Math.pow(air, 0.6) * (0.75 + 0.25 * near);
      rumble = Math.max(0.2 * air + 0.8 * Math.pow(air, 0.5), M.vacuum);
      pres = 7 * ground * air;
      if (s.view === 'map') { roar *= M.map; low *= M.map; rumble *= M.map; fc = Math.min(fc, 500); pres = 0; }
    }
    // The air's own roar: with the engines at max-Q, and alone on the way back down (a low thunder; the hiss of the wind is the game's).
    const aero = smooth(1500, 30000, s.q || 0) * (s.view === 'onboard' ? 0.8 : s.view === 'map' ? 0.2 : 0.3 + 0.4 * Math.pow(air, 0.3));
    const set = (p, v, tau = 0.12) => p.setTargetAtTime(v, t, tau);
    set(this.gRoar.gain, T * K * roar * M.roar); set(this.gLow.gain, (T * K * low + 0.55 * aero) * M.low); set(this.gRumble.gain, (T * K * rumble + 0.6 * aero) * M.rumble);
    set(this.air.frequency, fc, 0.2); set(this.air2.frequency, fc * 1.3, 0.2); set(this.lowLp.frequency, Math.min(700, fc * 0.7), 0.2);
    set(this.rumbleLp.frequency, rfc, 0.2); set(this.presence.gain, pres, 0.3); set(this.igniteLp.frequency, Math.max(fc, 300), 0.2);
    if (this.sRoar && s.pitch) set(this.sRoar.playbackRate, s.pitch, 0.3);
    // Engines lighting: once, as the thrust comes up from nothing.
    if (T > 0.06 && this.thrustWas < 0.03 && dt > 0) {
      const level = s.view === 'onboard' ? 0.5 : s.view === 'map' ? 0.15 : Math.max(Math.pow(air, 0.8), 0.05);
      const src = ctx.createBufferSource(); src.buffer = this.buf.rocket_ignite;
      const g = ctx.createGain(); g.gain.value = K * level * M.ignite;
      src.connect(g); g.connect(this.igniteLp); src.start();
      src.onended = () => { g.disconnect(); };
    }
    if (dt > 0) this.thrustWas = T;
    this.state = { thrust: T, air, fc, roar: T * K * roar, low: T * K * low, rumble: T * K * rumble };
  }

  /** The flight is over: let everything die away. */
  silence() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    for (const g of [this.gRoar, this.gLow, this.gRumble]) g.gain.setTargetAtTime(0, t, 0.1);
    this.thrustWas = 0;
  }
}
