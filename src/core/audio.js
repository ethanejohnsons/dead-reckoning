// Procedural sound: turboprop drone, slipstream, rain on the airframe,
// thunder, stall warning and tyre chirp. Everything is synthesised with
// WebAudio, so there are no audio files to ship.

export class Sound {
  constructor() { this.ctx = null; this.enabled = true; }

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.enabled ? 0.7 : 0; this.master.connect(ctx.destination);

    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noiseBuf;
    const noise = (type, freq, q = 0.7) => {
      const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(this.master); s.start();
      return { f, g };
    };

    // Engine: two detuned saws through a low-pass (prop), plus a thin turbine whine.
    this.engF = ctx.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.frequency.value = 300;
    this.engG = ctx.createGain(); this.engG.gain.value = 0;
    this.osc = [0, 1].map((i) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 70; o.detune.value = i * 14; o.connect(this.engF); o.start(); return o; });
    this.engF.connect(this.engG); this.engG.connect(this.master);
    this.whine = ctx.createOscillator(); this.whine.type = 'sine'; this.whineG = ctx.createGain(); this.whineG.gain.value = 0;
    this.whine.connect(this.whineG); this.whineG.connect(this.master); this.whine.start();

    this.wind = noise('bandpass', 500, 0.5);
    this.rain = noise('highpass', 2500);
    this.horn = ctx.createOscillator(); this.horn.type = 'square'; this.horn.frequency.value = 2100;
    this.hornG = ctx.createGain(); this.hornG.gain.value = 0; this.horn.connect(this.hornG); this.hornG.connect(this.master); this.horn.start();
  }

  setEnabled(on) { this.enabled = on; if (this.master) this.master.gain.value = on ? 0.7 : 0; }

  /** s: {power 0..1, ias m/s, rain 0..1, stall bool, active bool, time} */
  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.08;
    const on = s.active ? 1 : 0;
    const rpm = 0.3 + 0.7 * s.power;
    for (const o of this.osc) o.frequency.setTargetAtTime(48 + 46 * rpm, t, k);
    this.engF.frequency.setTargetAtTime(160 + 520 * rpm, t, k);
    this.engG.gain.setTargetAtTime(on * (0.05 + 0.13 * rpm) * (s.engine ? 1 : 0), t, k);
    this.whine.frequency.setTargetAtTime(1900 + 1700 * rpm, t, k);
    this.whineG.gain.setTargetAtTime(on * 0.006 * rpm * (s.engine ? 1 : 0), t, k);
    const v = Math.min(s.ias / 90, 1.4);
    this.wind.f.frequency.setTargetAtTime(280 + 700 * v, t, k);
    this.wind.g.gain.setTargetAtTime(on * 0.16 * v * v, t, k);
    this.rain.g.gain.setTargetAtTime(on * s.rain * (0.05 + 0.12 * v), t, 0.3);
    this.hornG.gain.setTargetAtTime(on && s.stall && (s.time * 5) % 1 < 0.6 ? 0.035 : 0, t, 0.01);
  }

  burst(freq, dur, gain, delay = 0, type = 'lowpass') {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.1);
  }
  /** Thunder arrives late and quiet from far away. */
  thunder(distM) {
    const delay = Math.min(distM / 343, 14), gain = Math.min(0.9, 2600 / (distM + 1500));
    this.burst(90 + 200 * gain, 2.5 + 3 * (1 - gain), gain, delay);
    this.burst(420, 0.5, gain * 0.5, delay);
  }
  chirp(hard) { this.burst(1400, 0.22, 0.2 + 0.3 * hard, 0, 'bandpass'); this.burst(120, 0.35, 0.25 + 0.4 * hard); }
  crash() { this.burst(200, 1.6, 0.9); this.burst(1800, 0.5, 0.4, 0, 'bandpass'); }
}
