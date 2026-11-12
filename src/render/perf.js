// Where a frame's time goes, for the debug panel: GPU time per render pass, and main-thread time per stage.
//
//   import { perf } from '../render/perf.js';
//   perf.init(renderer);                 once, by whoever gets the renderer first (later calls are ignored)
//
// GPU time per pass
//   perf.frame();                        once a frame, before the passes: collects the timings that have come back
//   perf.begin('clouds march'); ...draw...; perf.end();
//   perf.time('terrain', () => renderer.render(scene, camera));        the same, wrapped round a function
//   perf.passes                          { 'clouds march': 1.84, ... } milliseconds a frame, smoothed over about half a second
//   perf.gpu                             the whole frame on the graphics card, ms (NaN until a figure has come back);
//                                        perf.restart() forgets it, when the picture's size changes
//   perf.enabled = true                  no pass is measured until this is set (the debug panel sets it while open)
//   perf.watch = true                    with `enabled` off, time each frame whole instead (one timer a frame:
//                                        what dynamic resolution steers by); needs frameBegin() / frameEnd()
//   perf.tag(material or object, 'trees')   while the pass called 'scene' is open, draws are sorted into
//                                        'scene: trees', 'scene: terrain', ... by their material's tag, else by
//                                        the nearest tagged ancestor of the object drawn ('scene: other' if none)
//
// Timings come from EXT_disjoint_timer_query_webgl2. A graphics card answers a few frames late, and in a hidden
// tab perhaps never, so nothing here waits: a pass whose answer has not come simply keeps its last figure.
// Only one timer can run at a time, so passes cannot nest: begin() closes whichever pass is open.
// A pass that is opened several times in a frame (the scene's parts are, as the draw order weaves between them)
// is the sum of its pieces. With `enabled` false, begin(), end() and frame() are one test each and touch nothing else.
//
// Main-thread time per stage (always on: a dozen clock readings a frame)
//   perf.frameBegin(); ... perf.frameEnd();        round one frame of the game loop
//   perf.cpuBegin('terrain'); ...; perf.cpuEnd();  a stage; stages nest, and each is charged its own time only
//   perf.cpuAdd('elevation decode', ms);           main-thread work measured elsewhere (between frames, say):
//                                                  counted into the frame that follows
//   perf.worker('patch build', ms);                work done off the main thread, for the record only
//   perf.cpu                                       { stage: { ms: smoothed mean, max: worst of the last two seconds } }
//   perf.script                                    { ms, max }: the whole frame's script, the same way
//   perf.long()                                    { over20, over33, frames }: frames of the last minute that took
//                                                  longer than that from one frame's start to the next
//   perf.log = []                                  set to an array to have every frame's stages pushed onto it
// The object also appears as window.DR.perf.

const POOL = 256;        // most timers waiting for an answer at once; beyond that new passes go unmeasured
const SMOOTH = 0.08;     // share of each new figure taken into the running value
const RING = 20000;      // frame starts and lengths kept for the count of long frames: a minute's worth at 160 frames a second
const now = () => performance.now();

export const perf = {
  enabled: false,
  watch: false,
  /** Pass name -> milliseconds on the graphics card a frame, smoothed. */
  passes: {},
  /** The whole frame on the graphics card, ms, smoothed: the passes' sum, or the one timer of `watch`. */
  gpu: NaN, gpuAt: 0, gpuFrom: 0,
  /** False if the browser has no GPU timers (then `passes` stays empty). */
  supported: null,
  gl: null, ext: null, open: null, pending: [], free: [], was: false,
  frameNo: 0, sums: new Map(), seen: {}, collected: -1, whole: null,
  tags: new WeakMap(), labels: new WeakMap(),

  init(renderer) {
    if (this.gl) return;
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = !!this.ext;
    this.hook(renderer);
  },

  /** Start timing the GPU work issued from here to end(). */
  begin(name) {
    if (!this.enabled || !this.ext || this.whole) return;
    const gl = this.gl;
    if (this.open) this.end();
    if (this.pending.length >= POOL) return;
    const q = this.free.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.open = { q, name, frame: this.frameNo, scene: name === 'scene' || name.startsWith('scene:') };
  },

  end() {
    if (!this.open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.open); this.open = null;
  },

  time(name, fn) { this.begin(name); try { return fn(); } finally { this.end(); } },

  /** The picture has changed size: `gpu` starts again from the frames drawn from now on. */
  restart() { this.gpu = NaN; this.gpuFrom = this.frameNo + 1; },

  /** Name a material's draws, or those of everything under an object, within the 'scene' pass. */
  tag(what, name) { if (what) this.tags.set(what, 'scene: ' + name); },

  /** Sort the scene's draws into its parts: called for every draw while the 'scene' pass is open. */
  part(material, object) {
    let label = this.tags.get(material) || this.labels.get(material);
    if (!label) {
      for (let o = object; o && !label; o = o.parent) label = this.tags.get(o);
      this.labels.set(material, label = label || 'scene: other');
    }
    if (this.open.name !== label) this.begin(label);
  },

  hook(renderer) {
    const draw = renderer.renderBufferDirect, sm = renderer.shadowMap, shadows = sm && sm.render;
    if (typeof draw !== 'function') return;
    renderer.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      if (this.open && this.open.scene) this.part(material, object);
      return draw(camera, scene, geometry, material, object, group);
    };
    // three.js draws its own shadow maps (the aircraft's) inside the scene's render: keep them apart
    if (typeof shadows === 'function') sm.render = (lights, scene, camera) => {
      if (!this.open || !this.open.scene || !lights.length || !sm.enabled || (!sm.autoUpdate && !sm.needsUpdate)) return shadows.call(sm, lights, scene, camera);
      this.begin('shadow maps');
      try { return shadows.call(sm, lights, scene, camera); } finally { this.begin('scene'); }
    };
  },

  /** Collect whatever has come back. Call once a frame (again in the same frame does nothing). */
  frame() {
    if (typeof window !== 'undefined' && window.DR && !window.DR.perf) window.DR.perf = this;
    // (the game loop's frameBegin() has collected already; without one, this call is what marks the frame)
    if (this.cpuOpen) { if (this.collected === this.frameNo) return; } else this.frameNo++;
    this.collected = this.frameNo;
    if (!this.enabled) {
      if (this.was) { this.end(); this.passes = {}; this.sums.clear(); this.seen = {}; this.was = false; }          // switched off: forget the figures, let the timers drain
      if (!this.pending.length) return;
    }
    this.was = this.enabled;
    if (!this.ext) return;
    const gl = this.gl, ext = this.ext;
    // A "disjoint" event (the card was interrupted) spoils every timer that was running: throw those answers away.
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    let n = 0, newest = -1;
    for (const p of this.pending) {
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) { this.pending[n++] = p; continue; }
      if (!disjoint) {
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        if (p.name === null) { if (p.frame >= this.gpuFrom) { this.gpu = this.gpu === this.gpu ? this.gpu + (ms - this.gpu) * SMOOTH : ms; this.gpuAt = now(); } }
        else if (this.enabled) {
          let s = this.sums.get(p.frame);
          if (!s) this.sums.set(p.frame, s = {});
          s[p.name] = (s[p.name] || 0) + ms;
          if (p.frame > newest) newest = p.frame;
        }
      }
      this.free.push(p.q);
    }
    this.pending.length = n;
    // A frame's passes are added up once answers from a later frame have come: then all of its own are in
    // (or lost, when the card was interrupted). Passes that have stopped being drawn fade from the table.
    let oldest = Infinity;
    for (const p of this.pending) if (p.name !== null && p.frame < oldest) oldest = p.frame;
    for (const [f, s] of this.sums) {
      if (f >= oldest || f >= this.frameNo) continue;
      let total = 0;
      if (this.gpuLog) this.gpuLog.push(s);
      for (const k in s) { const old = this.passes[k]; this.passes[k] = old === undefined ? s[k] : old + (s[k] - old) * SMOOTH; this.seen[k] = f; total += s[k]; }
      for (const k in this.passes) if (!(k in s) && f - (this.seen[k] ?? f) > 90) { delete this.passes[k]; delete this.seen[k]; }
        else if (!(k in s) && f > (this.seen[k] ?? -1)) this.passes[k] += (0 - this.passes[k]) * SMOOTH;
      if (f >= this.gpuFrom) { this.gpu = this.gpu === this.gpu ? this.gpu + (total - this.gpu) * SMOOTH : total; this.gpuAt = now(); }
      this.sums.delete(f);
    }
  },

  // ---------------------------------------------------------------- main-thread time

  /** Stage -> { ms: mean a frame (smoothed), max: the worst frame of the last two seconds }. */
  cpu: {},
  script: { ms: 0, max: 0 },
  /** Off the main thread: kind -> { ms: mean a job (smoothed), n: jobs so far }. */
  workers: {},
  log: null,
  /** Set to an array to have every frame's GPU passes pushed onto it ({ pass: ms }), unsmoothed. */
  gpuLog: null,
  cur: {}, stack: [], carry: {}, cpuOpen: false, t0: 0, lastBegin: 0, frames: [], ring: 0, win: {}, winT: 0, scriptWin: 0,

  /** Start of a frame of the game loop. Returns how long the frame before took, start to start (ms; 0 if unknown). */
  frameBegin() {
    const t = now(), gap = this.lastBegin ? t - this.lastBegin : 0;
    this.lastBegin = t;
    if (gap > 0 && gap < 250) {                        // (longer: the tab was hidden or the game stood still)
      const F = this.frames;
      if (F.length < RING) F.push(t, gap); else { F[this.ring] = t; F[this.ring + 1] = gap; this.ring = (this.ring + 2) % RING; }
    }
    this.frameNo++; this.cpuOpen = true;
    this.frame();
    this.cur = this.carry; this.carry = {}; this.stack.length = 0;
    this.t0 = t;
    if (this.watch && !this.enabled && this.ext && !this.open && this.pending.length < 8) {
      const q = this.free.pop() || this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.whole = { q, name: null, frame: this.frameNo };
    }
    return gap > 0 && gap < 250 ? gap : 0;
  },

  /** End of the frame: adds its stages into the running figures. Returns the frame's script time (ms). */
  frameEnd() {
    if (this.whole) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(this.whole); this.whole = null; }
    if (!this.cpuOpen) return 0;
    this.cpuOpen = false;
    const t = now(), cur = this.cur;
    let between = 0;                                    // work that landed between frames belongs to the frame as the player sees it
    for (const k in cur) if (cur[k].between) between += cur[k].between;
    const total = t - this.t0 + between;
    const fold = (o, ms) => { o.ms += (ms - o.ms) * SMOOTH; if (ms > o.win) o.win = ms; };
    for (const k in cur) { const o = this.cpu[k] || (this.cpu[k] = { ms: cur[k].ms, max: 0, win: 0 }); fold(o, cur[k].ms); }
    for (const k in this.cpu) if (!(k in cur)) fold(this.cpu[k], 0);
    const s = this.script; s.ms += (total - s.ms) * SMOOTH; if (total > this.scriptWin) this.scriptWin = total;
    if (t - this.winT > 2000) {                         // the worst of each two seconds
      this.winT = t;
      for (const k in this.cpu) { const o = this.cpu[k]; o.max = o.win; o.win = 0; }
      s.max = this.scriptWin; this.scriptWin = 0;
    }
    if (this.log) { const r = { script: total }; for (const k in cur) r[k] = cur[k].ms; this.log.push(r); }
    return total;
  },

  cpuBegin(name) { this.stack.push(name, now(), 0); },
  cpuEnd() {
    const S = this.stack;
    if (S.length < 3) return;
    const child = S.pop(), t0 = S.pop(), name = S.pop(), dt = now() - t0;
    const o = this.cur[name] || (this.cur[name] = { ms: 0, between: 0 });
    o.ms += dt - child;
    if (S.length) S[S.length - 1] += dt;
  },
  /** Main-thread work timed by its owner. Outside a frame (a tile arriving, say) it is counted into the next one. */
  cpuAdd(name, ms) {
    const into = this.cpuOpen ? this.cur : this.carry, o = into[name] || (into[name] = { ms: 0, between: 0 });
    o.ms += ms;
    if (!this.cpuOpen) o.between += ms; else if (this.stack.length) this.stack[this.stack.length - 1] += ms;
  },
  worker(name, ms) {
    const o = this.workers[name] || (this.workers[name] = { ms, n: 0, max: 0 });
    o.ms += (ms - o.ms) * SMOOTH; o.n++; if (ms > o.max) o.max = ms;
  },

  /** Frames of the last minute that ran long, by the time from one frame's start to the next. */
  long() {
    const F = this.frames, since = now() - 60000;
    let over20 = 0, over33 = 0, frames = 0;
    for (let i = 0; i < F.length; i += 2) if (F[i] >= since) { frames++; if (F[i + 1] > 20) over20++; if (F[i + 1] > 33.4) over33++; }
    return { over20, over33, frames };
  },

  /** The debug panel's lines about the main thread (the panel is about forty characters wide). */
  cpuText() {
    const f = (x, w = 6) => (Number.isFinite(x) ? x.toFixed(2) : '–').padStart(w), L = this.long();
    const rows = Object.entries(this.cpu).filter(([, o]) => o.ms > 0.004 || o.max > 0.05).sort((a, b) => b[1].ms - a[1].ms);
    let out = `long frames in the last minute:\n  ${L.over20} over 20 ms, ${L.over33} over 33 ms, of ${L.frames}\n`;
    out += `${'main thread, ms a frame'.padEnd(25)}  mean  worst\n`;
    out += ` ${'script, whole frame'.padEnd(24)}${f(this.script.ms)} ${f(this.script.max)}\n`;
    for (const [k, o] of rows) out += ` ${k.padEnd(24)}${f(o.ms)} ${f(o.max)}\n`;
    const w = Object.entries(this.workers);
    if (w.length) out += `${'workers, ms a job'.padEnd(25)}  mean  worst\n` + w.map(([k, o]) => ` ${(k + ' (' + o.n + ')').padEnd(24)}${f(o.ms)} ${f(o.max)}\n`).join('');
    if (this.gpu === this.gpu) out += `GPU, whole frame ${this.gpu.toFixed(2)} ms\n`;
    return out;
  },
};
