// One budget a frame for the streaming work that has to run on the main thread: sending a terrain patch's
// data-texture layer and vertex buffer to the graphics card, a tree patch's instance buffer, an imagery
// tile. Everything that streams asks here before each piece, so a frame's uploads add up to a known few
// milliseconds whoever they belong to, and a frame that is already late takes none at all.
//
//   import { uploads } from '../render/budget.js';
//
//   uploads.begin(lastFrameMs)      once a frame, by the game loop, before anything streams
//   uploads.take(bytes)             true: go ahead with one piece of about that many bytes (it is counted);
//                                   false: keep it for a later frame
//   uploads.spend(ms)               after the piece: the main-thread time it really took
//   uploads.run(bytes, fn)          the three together: runs fn() if there is room, returns whether it ran
//   uploads.behind                  true on a late frame: for work that is not an upload but can wait as well
//
// A module that uploads in a loop does:
//
//   while (queue.length && uploads.take(tileBytes)) { const t = performance.now(); upload(queue.shift()); uploads.spend(performance.now() - t); }
//
// Rules:
//   - a frame has `ms` milliseconds and `bytes` bytes; a piece is granted while both have something left,
//     so one piece can overrun, and the overrun is taken off the next frame;
//   - on a late frame nothing is granted. A frame is late when the one before it ran well over the usual
//     frame time (a hitch, or the graphics card behind), or when this frame's script has already used
//     `lateMs` by the time the question is asked;
//   - so that streaming cannot starve on a machine that is always late, after `maxSkip` frames with
//     nothing granted one piece is let through.
// Work outside the game loop (while a flight loads) does not ask: see `open`.

const now = () => performance.now();

export const uploads = {
  ms: 2.5,                // main-thread time for uploads in one frame
  bytes: 2 * 1024 * 1024, // bytes sent to the graphics card in one frame (a patch is about 100 KB, an imagery tile 260 KB)
  lateMs: 9,              // a frame whose script has run this long before it asks gets nothing
  maxSkip: 6,             // frames in a row that may go without, before one piece is let through
  /** True while no frame is being drawn (a flight is loading): everything is granted. */
  open: false,

  leftMs: 0, leftBytes: 0, late: false, skipped: 0, granted: 0, t0: 0, usual: 16.7,
  /** For the debug panel: what the last finished frame used. */
  last: { ms: 0, bytes: 0, pieces: 0, late: false }, usedMs: 0, usedBytes: 0,

  /** Start a frame. lastFrameMs: how long the frame before took, end to end (leave out if unknown). */
  begin(lastFrameMs) {
    this.last.ms = this.usedMs; this.last.bytes = this.usedBytes; this.last.pieces = this.granted; this.last.late = this.late;
    if (this.granted) this.skipped = 0; else if (this.late) this.skipped++;
    this.t0 = now();
    this.late = false;
    if (lastFrameMs > 0 && lastFrameMs < 250) {
      // the usual frame time follows slowly, and downwards at once: a hitch does not teach it anything
      this.late = lastFrameMs > Math.max(this.usual * 1.35, this.usual + 4);
      this.usual += (Math.min(lastFrameMs, this.usual * 1.35) - this.usual) * 0.05;
    }
    // an overrun last frame comes off this one
    this.leftMs = this.ms + Math.min(this.leftMs, 0); this.leftBytes = this.bytes + Math.min(this.leftBytes, 0);
    this.usedMs = 0; this.usedBytes = 0; this.granted = 0;
  },

  /** Is this frame late (see the rules above)? For work that is not an upload but should not land on a late frame either. */
  get behind() {
    if (this.open) return false;
    if (!this.late && now() - this.t0 > this.lateMs) this.late = true;
    return this.late;
  },

  /** May one piece of about `bytes` go now? Counts it if so. */
  take(bytes = 0) {
    if (this.open) return true;
    if (!this.late && now() - this.t0 > this.lateMs) this.late = true;
    if (this.late) {
      if (this.skipped < this.maxSkip || this.granted) return false;
    } else if (this.leftMs <= 0 || this.leftBytes <= 0) return false;
    this.leftBytes -= bytes; this.usedBytes += bytes; this.granted++;
    return true;
  },

  /** The time a granted piece took. */
  spend(ms) { this.leftMs -= ms; this.usedMs += ms; },

  run(bytes, fn) {
    if (!this.take(bytes)) return false;
    const t = now();
    try { fn(); } finally { this.spend(now() - t); }
    return true;
  },
};
