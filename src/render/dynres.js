// Dynamic resolution: the picture is drawn at a share of the canvas's size (and the cloud buffer with it)
// and scaled up to the canvas by the last pass, and that share follows the measured frame time so the game
// holds its frame rate. The temporal passes smooth over a change of size; changes are kept few all the same,
// because each one rebuilds the render targets and starts their histories again.
//
//   const res = new DynRes();
//   res.enabled = true; res.target = 60;
//   if (res.update(frameMs, gpuMs, scriptMs)) resize(res.scale);       once a frame
//
// Two ways of steering, by what can be measured:
//   - with GPU timers (render/perf.js: perf.gpu) the load is the graphics card's time for a frame against
//     the share of the frame it may have. Over 100% for a moment: fewer pixels, by as much as the load says.
//     Under 78% for a few seconds: more. In between nothing changes, and a step lands in the middle of
//     that band, which is what keeps it from pumping;
//   - without them, all that is known is whether frames come on time. Late frames: a step down. A spell
//     with none: one step up, to see if it holds; if it does not, the step is taken back and the next try
//     waits longer (up to a minute), and sooner again once a try has held.
// A frame held up by the game's own script is not helped by fewer pixels and is left out of it.

const STEP = 0.05;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class DynRes {
  constructor() {
    this.enabled = true;
    this.target = 60;           // frames a second to hold
    this.min = 0.5; this.max = 1;
    this.scale = 1;
    this.share = 0.82;          // of a frame, for the graphics card
    this.load = 0.9; this.miss = 0; this.slow = 1; this.over = 0; this.under = 0; this.hold = 0;
    this.calm = 0; this.probeWait = 4; this.probed = -1e9; this.failed = false; this.clock = 0;
    /** For the debug panel: 'gpu' or 'frames', by what it is steering. */
    this.by = 'frames';
    /** Changes of size so far. */
    this.changes = 0;
  }

  set(scale) {
    const s = clamp(Math.round(scale / STEP) * STEP, this.min, this.max);
    if (Math.abs(s - this.scale) < 1e-6) return false;
    this.scale = s; this.changes++;
    this.hold = 0.75;           // seconds for the new size to settle in, and its timings with it
    this.load = 0.9; this.miss = 0; this.over = 0; this.under = 0; this.calm = 0;
    return true;
  }

  /**
   * frameMs: the last frame, start to start. gpuMs: a frame's time on the graphics card (NaN if not known).
   * scriptMs: the frame's script. Returns true if `scale` has changed: the caller resizes its targets.
   */
  update(frameMs, gpuMs, scriptMs) {
    if (!this.enabled) return this.scale !== this.max ? this.set(this.max) : false;
    if (this.scale > this.max || this.scale < this.min) return this.set(this.scale);
    if (!(frameMs > 0) || frameMs > 250) return false;          // paused, hidden, or the first frame
    const dt = frameMs / 1000, budget = 1000 / this.target;
    this.clock += dt;
    if (this.hold > 0) { this.hold -= dt; return false; }
    const cpuBound = scriptMs > budget * 0.9;

    if (gpuMs === gpuMs && gpuMs > 0.05) {
      this.by = 'gpu';
      this.load += (gpuMs / (budget * this.share) - this.load) * 0.2;
      this.over = this.load > 1 ? this.over + dt : 0;
      this.under = this.load < 0.78 ? this.under + dt : 0;
      // aim for 90% of the share; a step is never tiny, and never more than a quarter
      if (this.over > 0.3 && this.scale > this.min) return this.set(Math.min(this.scale * clamp(Math.sqrt(0.9 / this.load), 0.75, 0.97), this.scale - STEP));
      if (this.under > 2.5 && this.scale < this.max) return this.set(Math.max(this.scale * clamp(Math.sqrt(0.9 / this.load), 1.03, 1.25), this.scale + STEP));
      return false;
    }

    this.by = 'frames';
    const late = frameMs > budget * 1.3 && !cpuBound;
    this.miss += ((late ? 1 : 0) - this.miss) * 0.04;
    if (late) this.slow += (frameMs / budget - this.slow) * 0.1;
    this.over = this.miss > 0.25 ? this.over + dt : 0;
    this.calm = this.miss < 0.02 ? this.calm + dt : 0;
    if (this.over > 0.5 && this.scale > this.min) {
      const back = this.clock - this.probed < 4;                  // the last step up did not hold: take it back, and wait longer
      if (back) { this.failed = true; this.probed = -1e9; this.probeWait = Math.min(Math.max(this.probeWait * 2.5, 8), 60); }
      // a few late frames among many on time: one step; mostly late: a tenth, or a fifth if they take two frames' time
      return this.set(back || this.miss < 0.4 ? this.scale - STEP : this.scale * (this.slow > 1.8 ? 0.8 : 0.9));
    }
    if (this.calm > this.probeWait && this.scale < this.max && !cpuBound) {
      if (!this.failed) this.probeWait = Math.max(2.5, this.probeWait * 0.7);       // the last one held: try sooner
      this.probed = this.clock; this.failed = false;
      return this.set(this.scale + STEP);
    }
    return false;
  }
}
