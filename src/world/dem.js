// Real-world elevation, streamed as "terrarium" PNG tiles from the public
// Mapzen/AWS Terrain Tiles dataset (no key needed). Tiles are decoded to
// float heights, cached, and sampled by the terrain mesher, the flight
// physics and the regional maps. Water is detected from the data itself
// (water.js). Tiles are addressed by their place on the globe, so the cache
// stays good when the game's window of the world moves. A window across the
// 180th meridian has tile columns beyond either end of the grid (geo.js):
// they are brought round into it wherever a tile is looked up or asked for.
//
// Downloading, decoding and the water rules run in the worker pool (workers.js), a few milliseconds a tile
// that the frame no longer pays; only the finished arrays come back. The cache itself stays here on the
// main thread, where heightAt() must answer at once for the flight physics. Without workers the same work
// is done here as it always was.

import { pixelX, pixelY, metersPerPixel, WORLD_HALF } from './geo.js';
import { waterMask, DOUBT_Z } from './water.js';
import { pool } from './workers.js';
import { perf } from '../render/perf.js';

// Zoom 14 is as fine as the data goes in the United States (the 10 m 3DEP survey; a pixel is about 7 m
// here). Zoom 15 exists but is the same survey resampled. The rest of the world is SRTM's 30 m between 60 N
// and 56 S (with finer national surveys in places: much of Europe, New Zealand), and GMTED's 250 m beyond.
export const BASE_Z = 8, MAX_Z = 14;
export const ATTRIBUTION = 'Terrain: Mapzen Terrain Tiles on AWS (USGS 3DEP, SRTM, GMTED, ETOPO1 and national surveys: github.com/tilezen/joerd/blob/master/docs/attribution.md)';
export const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const KEY = (z, x, y) => z * 67108864 + (x & ((1 << z) - 1)) * 16384 + y;          // (the column wrapped round the earth)
const MAX_ACTIVE = 8, CACHE_LIMIT = 300;

// A tile asked for only in passing (ensure(): a patch that wants it asks again every frame) is let go if
// nobody has asked for this long: the camera has left it behind, and its place in the queue is better spent.
const STALE_MS = 4000;

const tiles = new Map();          // key -> tile {z,x,y,h,water,used} once loaded
const pending = new Map();        // key -> {z,x,y,prio,promise,resolve,tries,active,keep,seen,job}
let active = 0, stamp = 0, swept = 0;
let canvas = null, ctx = null;
export const stats = { loaded: 0, failed: 0, bytes: 0, dropped: 0 };
let wake = null, woken = null;
/** A promise for the next tile to arrive (for whoever is waiting on elevation while a flight loads). */
export function arrived() { return woken || (woken = new Promise((r) => { wake = r; })); }

function decode(bitmap) {
  if (!canvas) {
    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bitmap, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
  for (let i = 0, o = 0; i < 65536; i++, o += 4) h[i] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  return h;
}

function start(p) {
  p.active = true; active++;
  if (pool.ok) {
    // in a worker: download, decode and the water rules; the two arrays come back without a copy
    const m = { t: 'tile', z: p.z, x: p.x, y: p.y, url: tileUrl(p.z, p.x, p.y) };
    pool.run(m).then(
      (r) => { p.job = 0; stats.bytes += r.bytes; perf.worker('elevation decode', r.ms); finish(p, r.h, r.water); },
      (r) => {
        p.job = 0;
        if (r.dead) { active--; p.active = false; pump(); }          // the worker is gone: ask again (here, if it was the last)
        else failed(p, new Error(r.err), r.dropped);
      });
    p.job = m.id;
    return;
  }
  fetch(tileUrl(p.z, p.x, p.y))
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
    .then((b) => { stats.bytes += b.size; return createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); })
    .then((bmp) => { const t0 = performance.now(), h = decode(bmp); bmp.close?.(); finish(p, h, waterMask(p.z, p.x, p.y, h)); perf.cpuAdd('elevation decode', performance.now() - t0); })
    .catch((e) => failed(p, e, false));
}
function failed(p, e, dropped) {
  active--; p.active = false;
  // we stopped it ourselves (see sweep): forgotten, unless it has been asked for again in the meantime
  if (dropped) { if (!p.keep && performance.now() - p.seen >= STALE_MS) forget(p); pump(); return; }
  if (++p.tries < 3) { setTimeout(() => pump(), 400 * p.tries); return; }
  // Give up on this tile: stand in a flat patch of the best coarser data so meshing can proceed.
  stats.failed++; active++;
  const t0 = performance.now(), h = new Float32Array(65536), mpp = metersPerPixel(p.z);
  const around = 256 * 2 ** p.z, dpx = p.x * 256 + 0.5 - pixelX(0, p.z);       // (the copy of the tile nearest the window)
  const ox = (dpx - around * Math.round(dpx / around)) * mpp, oz = (p.y * 256 + 0.5 - pixelY(0, p.z)) * mpp;
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) h[j * 256 + i] = heightAt(ox + i * mpp, oz + j * mpp, p.z - 1);
  console.warn('Terrain tile failed, using coarser data:', p.z, p.x, p.y, e.message);
  finish(p, h, waterMask(p.z, p.x, p.y, h));
  perf.cpuAdd('elevation decode', performance.now() - t0);
}
function finish(p, h, water) {
  active--;
  const t = { z: p.z, x: p.x, y: p.y, h, water, used: ++stamp };
  const key = KEY(p.z, p.x, p.y);
  tiles.set(key, t); pending.delete(key); stats.loaded++;
  p.resolve(t);
  if (wake) { const w = wake; wake = woken = null; w(); }
  if (tiles.size > CACHE_LIMIT) evict();
  // (requests lapse here too: once the camera has left a place nothing may ask for a tile again for a while,
  // and the queue it left behind would otherwise be downloaded to the end)
  const now = performance.now();
  if (now - swept > 500) sweep(now);
  pump();
}
function forget(p) { pending.delete(KEY(p.z, p.x, p.y)); stats.dropped++; }
function pump() {
  if (active >= MAX_ACTIVE || !pending.size) return;
  const waiting = [...pending.values()].filter((p) => !p.active).sort((a, b) => a.prio - b.prio);
  for (const p of waiting) { if (active >= MAX_ACTIVE) break; start(p); }
}
/** Let go of requests nobody has repeated for a while: those still waiting are forgotten, a download under way is stopped. */
function sweep(now) {
  swept = now;
  let freed = false;
  for (const p of pending.values()) {
    if (p.keep || now - p.seen < STALE_MS) continue;
    if (!p.active) { forget(p); freed = true; } else if (p.job) pool.cancel(p.job);
  }
  if (freed) pump();
}
function evict() {
  const old = [...tiles.values()].filter((t) => t.z > BASE_Z).sort((a, b) => a.used - b.used);
  for (let i = 0; i < old.length && tiles.size > CACHE_LIMIT - 30; i++) tiles.delete(KEY(old[i].z, old[i].x, old[i].y));
}

/**
 * Request a tile. Returns a promise for it; lower prio numbers load first. keep: false for a request made in
 * passing, which lapses unless it is repeated (its promise then never settles: nobody is waiting on it).
 */
export function load(z, x, y, prio = 1, keep = true) {
  x &= (1 << z) - 1;
  const key = KEY(z, x, y), t = tiles.get(key);
  if (t) { t.used = ++stamp; return Promise.resolve(t); }
  const now = performance.now();
  let p = pending.get(key);
  if (p) { if (prio < p.prio) p.prio = prio; p.seen = now; if (keep) p.keep = true; }
  else {
    p = { z, x, y, prio, tries: 0, active: false, keep, seen: now, job: 0 };
    p.promise = new Promise((res) => { p.resolve = res; });
    pending.set(key, p);
    pump();
  }
  if (now - swept > 500) sweep(now);
  return p.promise;
}
export const pendingCount = () => pending.size;

/** Tile range covering a world rectangle (with a pixel of margin for filtering). */
function range(z, x0, z0, x1, z1) {
  const m = 2.5, max = 2 ** z - 1;          // (rows end at the edge of the map; columns go on round the earth)
  return [
    Math.floor((pixelX(x0, z) - m) / 256), Math.max(0, Math.floor((pixelY(z0, z) - m) / 256)),
    Math.floor((pixelX(x1, z) + m) / 256), Math.min(max, Math.floor((pixelY(z1, z) + m) / 256)),
  ];
}
/** True if every tile under the rectangle is loaded; otherwise requests the missing ones. */
export function ensure(z, x0, z0, x1, z1, prio = 1) {
  const [ax, ay, bx, by] = range(z, x0, z0, x1, z1);
  let ok = true;
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    const t = tiles.get(KEY(z, x, y));
    if (t) t.used = ++stamp; else { ok = false; load(z, x, y, prio, false); }
  }
  return ok;
}
/** Promise that resolves when the rectangle is fully loaded at zoom z. */
export function loadArea(z, x0, z0, x1, z1, prio = 0) {
  const [ax, ay, bx, by] = range(z, x0, z0, x1, z1), all = [];
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) all.push(load(z, x, y, prio));
  return Promise.all(all);
}

// Texel fetch with a one-tile memo; missing neighbors clamp to the current tile's edge.
let memo = null;
function texel(z, ix, iy, channel) {
  const tx = (ix >> 8) & ((1 << z) - 1), ty = iy >> 8;
  let t = memo;
  if (!t || t.z !== z || t.x !== tx || t.y !== ty) { t = tiles.get(KEY(z, tx, ty)); if (!t) return NaN; memo = t; }
  return channel ? t.water[(iy & 255) * 256 + (ix & 255)] : t.h[(iy & 255) * 256 + (ix & 255)];
}

/**
 * Fill a regular grid of n x n samples starting at (x0, z0) with spacing `step`,
 * bilinearly filtered from zoom z. outW (optional) receives water coverage (0..255).
 * The caller must have ensure()d the area first.
 */
export function sampleGrid(z, x0, z0, step, n, outH, outW) {
  const mpp = metersPerPixel(z), sx = step / mpp;
  const fx0 = pixelX(x0, z) - 0.5, fy0 = pixelY(z0, z) - 0.5, wrap = (1 << z) - 1;
  for (let j = 0; j < n; j++) {
    const fy = fy0 + j * sx, iy = Math.floor(fy), v = fy - iy;
    for (let i = 0; i < n; i++) {
      const fx = fx0 + i * sx, ix = Math.floor(fx), u = fx - ix, k = j * n + i;
      let a, b, c, d;
      const lx = ix & 255, ly = iy & 255, tx = (ix >> 8) & wrap;
      const t = (memo && memo.z === z && memo.x === tx && memo.y === iy >> 8) ? memo : (texel(z, ix, iy, 0), memo);
      if (t && lx < 255 && ly < 255 && t.z === z && t.x === tx && t.y === iy >> 8) {
        const o = ly * 256 + lx, h = t.h;
        a = h[o]; b = h[o + 1]; c = h[o + 256]; d = h[o + 257];
        if (outW) { const w = t.water, wa = w[o] ? 1 : 0, wb = w[o + 1] ? 1 : 0, wc = w[o + 256] ? 1 : 0, wd = w[o + 257] ? 1 : 0; outW[k] = ((wa + (wb - wa) * u) * (1 - v) + (wc + (wd - wc) * u) * v) * 255; }
      } else {
        a = texel(z, ix, iy, 0); b = texel(z, ix + 1, iy, 0); c = texel(z, ix, iy + 1, 0); d = texel(z, ix + 1, iy + 1, 0);
        if (a !== a) a = b === b ? b : c === c ? c : d === d ? d : 0;
        if (b !== b) b = a; if (c !== c) c = a; if (d !== d) d = a;
        if (outW) { const w = texel(z, u < 0.5 ? ix : ix + 1, v < 0.5 ? iy : iy + 1, 1); outW[k] = w === w && w ? 255 : 0; }
      }
      outH[k] = (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }
  }
}

/**
 * A copy of the texels of zoom z that sampleGrid() reads for points inside a world rectangle (and doubtfulAt(),
 * at zoom DOUBT_Z): what a worker is sent in place of the tiles. See demwindow.js, which reads it the same way.
 * heights: false for the water codes alone. Tiles that are not loaded leave NaN heights and no water.
 */
export function cut(z, x0, z0, x1, z1, heights = true) {
  // sampleGrid reads texel floor(p - 0.5) and the one after it; one more each way for rounding
  const ax = Math.floor(pixelX(x0, z) - 0.5) - 1, ay = Math.floor(pixelY(z0, z) - 0.5) - 1;
  const bx = Math.floor(pixelX(x1, z) - 0.5) + 2, by = Math.floor(pixelY(z1, z) - 0.5) + 2;
  const w = bx - ax + 1, h = by - ay + 1;
  const H = heights ? new Float32Array(w * h).fill(NaN) : null, W = new Uint8Array(w * h);
  for (let ty = ay >> 8; ty <= by >> 8; ty++) for (let tx = ax >> 8; tx <= bx >> 8; tx++) {
    const t = tiles.get(KEY(z, tx, ty));
    if (!t) continue;
    t.used = ++stamp;
    const i0 = Math.max(ax, tx * 256), i1 = Math.min(bx, tx * 256 + 255), j0 = Math.max(ay, ty * 256), j1 = Math.min(by, ty * 256 + 255), len = i1 - i0 + 1;
    for (let j = j0; j <= j1; j++) {
      const s = (j - ty * 256) * 256 + (i0 - tx * 256), d = (j - ay) * w + (i0 - ax);
      if (H) H.set(t.h.subarray(s, s + len), d);
      W.set(t.water.subarray(s, s + len), d);
    }
  }
  return { z, x0: ax, y0: ay, w, h, H, W };
}
/** A loaded tile { z, x, y, h, water }, or undefined (for tests). */
export const tileAt = (z, x, y) => tiles.get(KEY(z, x, y));

const one = new Float32Array(1), oneW = new Uint8Array(1);
/** Finest loaded zoom at a point, at or below maxZ (-1 if nothing is loaded there). */
function bestZoom(x, zw, maxZ) {
  for (let z = maxZ; z >= 0; z--) {
    const t = tiles.get(KEY(z, Math.floor(pixelX(x, z)) >> 8, Math.floor(pixelY(zw, z)) >> 8));
    if (t) { t.used = ++stamp; return z; }
  }
  return -1;
}

/** Ground elevation from the finest loaded data at a point (m; sea floor is negative in coarse data). */
export function heightAt(x, zw, maxZ = MAX_Z) {
  const z = bestZoom(x, zw, maxZ);
  if (z < 0) return 0;
  sampleGrid(z, x, zw, 1, 1, one, null);
  return one[0];
}
/** Is this point lake or sea, according to the finest loaded data? */
export function waterAt(x, zw) {
  const z = bestZoom(x, zw, MAX_Z);
  if (z < 0) return false;
  sampleGrid(z, x, zw, 1, 1, one, oneW);
  return oneW[0] > 127;
}

/** Let go of the coarse tiles (never evicted otherwise) that lie outside the window of the world as it is now. */
function forgetOutside() {
  memo = null;
  for (const [key, t] of tiles) {
    if (t.z > BASE_Z) continue;
    const [ax, ay, bx, by] = range(t.z, -WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF);
    if (((t.x - ax) & ((1 << t.z) - 1)) > bx - ax || t.y < ay || t.y > by) tiles.delete(key);
  }
}

/**
 * Is the water at this point of the doubtful kind (level, but with no bank around it: see water.js)? That is
 * judged at zoom DOUBT_Z; false if the tile there is not loaded (wantDoubt asks for it).
 */
export function doubtfulAt(x, zw) {
  const ix = Math.floor(pixelX(x, DOUBT_Z)), iy = Math.floor(pixelY(zw, DOUBT_Z));
  let doubt = false;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const w = texel(DOUBT_Z, ix + di, iy + dj, 1); if (w === 1) return false; if (w === 2) doubt = true; }
  return doubt;
}
/** True once the tiles doubtfulAt reads are loaded under a rectangle (and asks for them if not). */
export const wantDoubt = (x0, z0, x1, z1, prio) => ensure(DOUBT_Z, x0, z0, x1, z1, prio);

/**
 * Load the regional base layer for the window of the world as it is now. onProgress(fraction).
 * Resolves with { height, water }: BN x BN grids covering +/- WORLD_HALF (m; water 0..255).
 */
export async function loadBase(BN, onProgress) {
  forgetOutside();
  const failedBefore = stats.failed;
  const H = WORLD_HALF, [ax, ay, bx, by] = range(BASE_Z, -H, -H, H, H), all = [];
  let done = 0;
  const total = (bx - ax + 1) * (by - ay + 1);
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) all.push(load(BASE_Z, x, y, 0).then(() => onProgress?.(++done / total)));
  await Promise.all(all);
  if (stats.failed - failedBefore >= total) throw new Error('No terrain data could be downloaded. Check the internet connection.');
  const height = new Float32Array(BN * BN), water = new Uint8Array(BN * BN);
  sampleGrid(BASE_Z, -H, -H, (2 * H) / (BN - 1), BN, height, water);
  return { height, water };
}
