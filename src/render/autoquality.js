// Automatic graphics quality: which tier ('low', 'med', 'high') the game draws at when the Graphics setting is
// "Automatic". Two parts:
//
//   tierForHardware(gl)   a first guess from the name of the graphics card, for the first flight on a machine;
//   AutoQuality           the judge in flight. Dynamic resolution (render/dynres.js) is the first thing to give
//                         when frames come late: it is quick and nobody sees it go. Only once it has given all it
//                         can and frames are still late does the tier step down, which costs a hitch (shaders and
//                         render targets are rebuilt) and so is done rarely. With the picture at full size and time
//                         to spare for a good while, the tier steps up again, but never back to one that has
//                         already proved too much in this session.
//
// 'ultra' is never chosen automatically: it is for whoever asks for it.

const ORDER = ['low', 'med', 'high'];
export const TIER_NAMES = { low: 'Low', med: 'Medium', high: 'High', ultra: 'Ultra' };

/** A first guess at the tier from what the browser says the graphics card is. */
export function tierForHardware(gl) {
  let name = '';
  try { const e = gl.getExtension('WEBGL_debug_renderer_info'); name = String(e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { /* not told */ }
  if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';                          // no graphics card at all
  if (/adreno|mali|powervr|apple a\d+/i.test(name)) return 'low';                                         // phones, tablets and the laptops built on their chips
  if (/apple m\d+ (pro|max|ultra)/i.test(name)) return 'high';
  if (/apple/i.test(name)) return 'med';                                                                  // the plain M-series, and Safari, which says only "Apple GPU"
  if (/rtx|gtx (1[0-9]|9)\d\d|radeon rx|radeon pro|arc\b|quadro/i.test(name)) return 'high';
  if (/iris(\(r\))? ?xe|radeon(?! rx)|geforce/i.test(name)) return 'med';
  if (/intel/i.test(name)) return 'low';                                                                 // older integrated graphics
  return 'med';
}

export class AutoQuality {
  constructor() {
    this.tier = 'med';
    this.miss = 0; this.low = 0; this.high = 0; this.hold = 8;
    this.failed = ORDER.length;         // the lowest tier that has proved too much (an index into ORDER)
    /** Changes of tier so far. */
    this.changes = 0;
  }

  /** Begin at a tier (the hardware's guess, or what the last session settled on). */
  start(tier) { this.tier = ORDER.includes(tier) ? tier : 'med'; this.hold = 8; }

  set(tier) {
    this.tier = tier; this.changes++;
    this.hold = 6;                      // seconds for the new tier to be built and its frame times to settle
    this.miss = 0; this.low = 0; this.high = 0;
    return tier;
  }

  /**
   * Once a frame, in flight. frameMs: the last frame, start to start; res: the dynamic resolution (DynRes).
   * Returns the new tier if it has changed (the caller applies it), else null.
   */
  update(frameMs, res) {
    if (!(frameMs > 0) || frameMs > 250) return null;            // paused, hidden, or the first frame
    const dt = frameMs / 1000, budget = 1000 / res.target;
    if (this.hold > 0) { this.hold -= dt; return null; }
    this.miss += ((frameMs > budget * 1.3 ? 1 : 0) - this.miss) * 0.03;
    const floor = !res.enabled || res.scale <= res.min + 0.051;                                        // resolution has given all it can
    const timed = res.by === 'gpu';
    const room = (!res.enabled || res.scale >= res.max - 1e-6) && this.miss < 0.02 && (!timed || res.load < 0.6);
    this.low = floor && this.miss > 0.3 ? this.low + dt : 0;
    this.high = room ? this.high + dt : 0;
    const i = ORDER.indexOf(this.tier);
    if (this.low > 4 && i > 0) { this.failed = Math.min(this.failed, i); return this.set(ORDER[i - 1]); }
    // (without a timer on the graphics card, frames on time say little about how much is to spare: wait longer)
    if (this.high > (timed ? 25 : 50) && i < ORDER.length - 1 && i + 1 < this.failed) return this.set(ORDER[i + 1]);
    return null;
  }
}
