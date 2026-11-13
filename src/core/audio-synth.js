// Synthesized sound sources. Two kinds live here: the few sounds no free recording covers (the reed stall
// horn, the airframe buffet of a stalled wing, the slow wander of a gusting wind), and plain stand-ins for the
// recordings, used only when a file fails to load so the game is never silent.

const TAU = Math.PI * 2;

/** Small seeded generator: the same buffers every run, which keeps offline test renders comparable. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One-pole low-pass run twice around a buffer, so the result is periodic and loops without a seam. */
function lowpassPeriodic(d, sampleRate, hz) {
  const k = 1 - Math.exp(-TAU * hz / sampleRate);
  let y = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < d.length; i++) { y += k * (d[i] - y); if (pass) d[i] = y; }
}
function highpassPeriodic(d, sampleRate, hz) {
  const k = 1 - Math.exp(-TAU * hz / sampleRate);
  let y = 0;
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < d.length; i++) { y += k * (d[i] - y); if (pass) d[i] -= y; }
}
function normalize(d, peak) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
}
/** Scale to an RMS level in dBFS, so stand-ins sit where the recordings (all near -23 LUFS) would. */
function setRms(d, db) {
  let e = 0;
  for (let i = 0; i < d.length; i++) e += d[i] * d[i];
  const g = Math.pow(10, db / 20) / Math.sqrt(e / d.length + 1e-20);
  for (let i = 0; i < d.length; i++) d[i] *= g;
}

/**
 * A slow, smooth, loopable control signal in -1..1: a handful of sines whose periods divide the buffer exactly.
 * Played into a gain's AudioParam it makes the wind swell and sag without any stepping.
 */
export function gustBuffer(ctx, seconds = 29, seed = 7) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), r = rng(seed);
  const parts = [];
  for (const cycles of [2, 3, 5, 7, 11, 17, 26, 41]) parts.push({ w: TAU * cycles / n, a: 1 / Math.pow(cycles, 0.55), p: r() * TAU });
  for (let i = 0; i < n; i++) { let v = 0; for (const p of parts) v += p.a * Math.sin(p.w * i + p.p); d[i] = v; }
  normalize(d, 1);
  return buf;
}

/**
 * Stall buffet: separated flow hammering the tail. Low-passed noise in irregular bursts at eight to fourteen a
 * second, which is the part of a stall you feel through the seat.
 */
export function buffetBuffer(ctx, seconds = 5, seed = 11) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), r = rng(seed);
  for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
  lowpassPeriodic(d, sr, 70); lowpassPeriodic(d, sr, 110); highpassPeriodic(d, sr, 14);
  const beats = [37, 46, 59, 68].map((c) => ({ w: TAU * c / n, p: r() * TAU }));     // 7.4, 9.2, 11.8, 13.6 Hz over five seconds
  for (let i = 0; i < n; i++) {
    let e = 0;
    for (const b of beats) e += Math.sin(b.w * i + b.p);
    e = Math.max(0, e / 2.2);
    d[i] *= 0.25 + e * e;
  }
  normalize(d, 0.9);
  return buf;
}

/**
 * The waveform of a reed horn. A reed that shuts against its slot once a cycle lets the air through in short
 * puffs, so the spectrum falls slowly at first (it is nearly a pulse train) and faster above a couple of
 * kilohertz. The horn's body is added afterward with filters.
 */
export function reedWave(ctx, harmonics = 36) {
  const real = new Float32Array(harmonics + 1), imag = new Float32Array(harmonics + 1);
  for (let k = 1; k <= harmonics; k++) {
    const a = (k <= 5 ? Math.pow(k, -0.45) : Math.pow(5, -0.45) * Math.pow(k / 5, -1.5)) * (k % 2 ? 1 : 0.8);
    imag[k] = a * Math.cos(k * 0.9); real[k] = a * Math.sin(k * 0.9);
  }
  return ctx.createPeriodicWave(real, imag);
}

/** White, pink or brown noise that loops cleanly. */
export function noiseBuffer(ctx, seconds, color = 'white', seed = 3, channels = 2) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr), buf = ctx.createBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c), r = rng(seed + c * 101);
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1;
    if (color === 'pink') { lowpassPeriodic(d, sr, 2400); highpassPeriodic(d, sr, 90); }
    if (color === 'brown') { lowpassPeriodic(d, sr, 260); lowpassPeriodic(d, sr, 700); highpassPeriodic(d, sr, 40); }
    setRms(d, color === 'white' ? -29 : color === 'pink' ? -26 : -23);
  }
  return buf;
}

// ---------------------------------------------------------------------------------------------- stand-ins

/**
 * Stand-in engine: a four-cylinder four-stroke at 2000 rpm built from its engine orders (every half
 * revolution up to the eighth firing harmonic, the firing harmonics strongest) with a little noise pulsed at
 * the firing rate. A whole number of cycles, so it loops.
 */
export function standInEngine(ctx, rpm = 2000, seed = 5) {
  const sr = ctx.sampleRate, cycleHz = rpm / 120, cycles = 64, n = Math.round(cycles / cycleHz * sr);
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), r = rng(seed);
  const parts = [];
  for (let k = 1; k <= 64; k++) {
    const f = k * cycleHz, firing = k % 4 === 0;
    parts.push({ w: TAU * k * cycles / n, a: (firing ? 1 : 0.22) / (1 + Math.pow(f / 170, 1.6)), p: r() * TAU });
  }
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = r() * 2 - 1;
  lowpassPeriodic(noise, sr, 900);
  const wf = TAU * 4 * cycles / n;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const p of parts) v += p.a * Math.sin(p.w * i + p.p);
    d[i] = v + noise[i] * 1.2 * (0.55 + 0.45 * Math.sin(wf * i));
  }
  setRms(d, -22);
  return { buffer: buf, rpm, loop: [0, n / sr] };
}

/** Stand-in one-shot: a burst of filtered noise with a fast attack and an exponential tail. */
export function standInBurst(ctx, seconds, lowpassHz, decay, seed = 9) {
  const sr = ctx.sampleRate, n = Math.round(seconds * sr), buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0), r = rng(seed);
  const k = 1 - Math.exp(-TAU * lowpassHz / sr);
  let y = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    y += k * ((r() * 2 - 1) - y); y2 += k * (y - y2);
    d[i] = y2 * Math.min(1, t / 0.012) * Math.exp(-t / decay) * (1 + 0.5 * Math.sin(t * 9 + seed)) * Math.min(1, (seconds - t) / 0.05);
  }
  normalize(d, 0.6);
  return buf;
}
