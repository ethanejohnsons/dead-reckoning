// Reading elevation away from the tile cache. The cache lives on the main thread (world/dem.js), where the
// flight physics needs it at once; a worker that builds a terrain patch is sent a "window" instead: the
// texels of one zoom level under the patch, copied out of the tiles (dem.window), a few tens of kilobytes.
// The functions here read a window exactly as dem.js reads the tiles themselves: the same arithmetic in the
// same order, down to the special case along a tile's edge, so a patch comes out the same to the last bit
// whichever thread built it. The same goes for the crop of the towns' density grid a job carries.
//
//   window  { z, x0, y0, w, h, H, W }   zoom; global pixel coordinates of its first texel; size in texels;
//           H: Float32Array heights (NaN where no tile was loaded); W: Uint8Array water codes of water.js
//           (0 where no tile was loaded), or null
//
// The region must be set (geo.setRegion) as it is on the thread that made the window.

import { pixelX, pixelY, metersPerPixel, WORLD_HALF } from './geo.js';
import { DOUBT_Z } from './water.js';

/**
 * dem.sampleGrid from a window: fill a regular grid of n x n samples starting at (x0, z0) with spacing `step`,
 * bilinearly filtered. outW (optional) receives water coverage (0..255).
 */
export function sampleWindow(win, x0, z0, step, n, outH, outW) {
  const z = win.z, mpp = metersPerPixel(z), sx = step / mpp;
  const fx0 = pixelX(x0, z) - 0.5, fy0 = pixelY(z0, z) - 0.5;
  const ww = win.w, wh = win.h, ox = win.x0, oy = win.y0, h = win.H, w = win.W;
  const hAt = (ix, iy) => { const i = ix - ox, j = iy - oy; return i >= 0 && j >= 0 && i < ww && j < wh ? h[j * ww + i] : NaN; };
  for (let j = 0; j < n; j++) {
    const fy = fy0 + j * sx, iy = Math.floor(fy), v = fy - iy;
    for (let i = 0; i < n; i++) {
      const fx = fx0 + i * sx, ix = Math.floor(fx), u = fx - ix, k = j * n + i;
      let a, b, c, d;
      const lx = ix & 255, ly = iy & 255, wi = ix - ox, wj = iy - oy, o = wj * ww + wi;
      // inside one tile (and that tile was loaded): the four texels are its own
      if (lx < 255 && ly < 255 && wi >= 0 && wj >= 0 && wi < ww - 1 && wj < wh - 1 && (a = h[o]) === a) {
        b = h[o + 1]; c = h[o + ww]; d = h[o + ww + 1];
        if (outW) { const wa = w[o] ? 1 : 0, wb = w[o + 1] ? 1 : 0, wc = w[o + ww] ? 1 : 0, wd = w[o + ww + 1] ? 1 : 0; outW[k] = ((wa + (wb - wa) * u) * (1 - v) + (wc + (wd - wc) * u) * v) * 255; }
      } else {
        // across a tile's edge: missing neighbors clamp to what is there, and water goes by the nearest texel
        a = hAt(ix, iy); b = hAt(ix + 1, iy); c = hAt(ix, iy + 1); d = hAt(ix + 1, iy + 1);
        if (a !== a) a = b === b ? b : c === c ? c : d === d ? d : 0;
        if (b !== b) b = a; if (c !== c) c = a; if (d !== d) d = a;
        if (outW) { const qi = (u < 0.5 ? ix : ix + 1) - ox, qj = (v < 0.5 ? iy : iy + 1) - oy; outW[k] = qi >= 0 && qj >= 0 && qi < ww && qj < wh && w[qj * ww + qi] ? 255 : 0; }
      }
      outH[k] = (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }
  }
}

/** dem.doubtfulAt from a window of the water codes at zoom DOUBT_Z. */
export function doubtfulIn(win, x, zw) {
  const ix = Math.floor(pixelX(x, DOUBT_Z)) - win.x0, iy = Math.floor(pixelY(zw, DOUBT_Z)) - win.y0, ww = win.w, wh = win.h, w = win.W;
  let doubt = false;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ix + di, j = iy + dj, c = i >= 0 && j >= 0 && i < ww && j < wh ? w[j * ww + i] : 0;
    if (c === 1) return false;
    if (c === 2) doubt = true;
  }
  return doubt;
}

/**
 * towns.urbanDensity from a crop of its grid: { bn, i0, j0, w, data } (bn: the whole grid's size; i0, j0: the
 * crop's first node; w: its width in nodes). On the main thread a job may carry { fn } instead: the function itself.
 */
export function urbanAt(c, x, z) {
  if (c.fn) return c.fn(x, z);
  const BN = c.bn, fx = ((x + WORLD_HALF) / (2 * WORLD_HALF)) * (BN - 1), fz = ((z + WORLD_HALF) / (2 * WORLD_HALF)) * (BN - 1);
  if (!(fx >= 0 && fz >= 0 && fx < BN - 1 && fz < BN - 1)) return 0;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, cw = c.w, g = c.data, k = (j - c.j0) * cw + (i - c.i0);
  return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + cw] * (1 - u) + g[k + cw + 1] * u) * v;
}
