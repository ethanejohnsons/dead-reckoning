// Real imagery of the ground, streamed and draped over the terrain.
//
// Two sources work together:
//  - Sentinel-2 cloudless 2016 by EOX (CC BY 4.0), about 10 m per pixel: one even, cloud-free picture of
//    the whole earth. It gives the ground its COLOR everywhere, and it is what imagery() returns, so the
//    trees and the water read the same picture they always have.
//  - Aerial photography from the USGS National Map (NAIP, public domain), 0.6 to 1 m per pixel: it gives the
//    ground its DETAIL near the aircraft, in the United States and its territories only (COVERAGE: nothing is
//    asked of those servers anywhere else, and the ground there is the satellite's picture with the terrain
//    shader's own fine grain). Aerial surveys are flown county by county and year by year and do
//    not match in tone (a river is brown in one and blue-black in the next), so they are never shown as they
//    are: the survey is divided by its own blur at the satellite's resolution, and that ratio (roofs, roads,
//    furrows, crowns of trees) multiplies the satellite's color. Tone stays the satellite's from the nose
//    to the horizon and there is no seam between the two sources to hide.
//
// The pictures are held as a stack of "clip" levels in one array texture: each level is a square of 256-pixel
// tiles at one zoom, twice as coarse and twice as wide as the level before, addressed toroidally (a tile's
// slot is its index modulo the window size), so when the camera moves only the newly exposed tiles are
// uploaded. Every tile is uploaded with its own mip chain (tiles sit on 256-pixel boundaries, so the
// addressing holds at every mip), which lets the texture be filtered anisotropically: the ground is mostly
// seen at a shallow angle. On the ground a level gives way to the next over a band at its edge, and a tile
// that has just arrived fades in (a small second texture holds each slot's fade), so there are no rings
// around the aircraft and nothing pops.
//
// Tiles are fetched, decoded and reduced to their mip chains in a worker; the frame only pays for the upload.

import * as THREE from 'three';
import { pixelX, pixelY, metersPerPixel, toLatLon, REGION } from './geo.js';
import { groundHeight } from './terrain.js';
import { uploads } from '../render/budget.js';
import { ENV } from '../core/env.js';

export const IMAGERY_ATTRIBUTION = 'Imagery: Sentinel-2 cloudless (s2maps.eu) by EOX IT Services GmbH, contains modified Copernicus Sentinel data 2016 & 2017'
  + '<br>Aerial imagery: USDA NAIP orthoimagery. Map services and data available from U.S. Geological Survey, National Geospatial Program';

export const IMG_LEVELS = 7;          // satellite levels: zoom 14 (about 7 m per pixel here) down to zoom 8
export const IMG_FINE_Z = 14;
const FINE_MAX = 3;                   // aerial levels at most: zoom 17, 16, 15
const TILE = 256, MIPS = 6;           // each tile carries mips down to 8 x 8
const XOFF = 262144;                  // see Imagery.key
const PYRAMID = (() => { let n = 0; for (let k = 0; k < MIPS; k++) n += (TILE >> k) ** 2 * 4; return n; })();
const LOW_M = 27;                     // meters: the scale at which the satellite's color and the survey's detail are joined
const FADE_S = 0.6;                   // seconds a tile takes to appear
const EDGE = 0.72;                    // a level starts giving way to the next at this fraction of the radius it is sure to cover
const LEAD_S = 6, LEAD_MAX = 0.3;     // the aerial levels are centered this many seconds of flight ahead (at most this fraction of their half-width)
const MAX_UPLOADS = 8, UPLOAD_MS = 3; // tiles a frame, and the time they may take
const MERC = 2 * Math.PI * 6378137;

// Where the aerial surveys reach: the United States and its territories, as boxes [south, north, west, east]
// (generous at the borders: the servers answer "no such tile" just beyond them, and that is remembered).
// The contiguous states, Alaska (and the Aleutians beyond the 180th meridian), Hawaii, Puerto Rico and the
// Virgin Islands, Guam and the Northern Marianas, American Samoa.
const COVERAGE = [[24.3, 49.6, -125.5, -66.5], [51, 71.8, -180, -129.5], [51, 54, 172, 180], [18.5, 22.6, -161, -154.5], [17.5, 18.8, -67.6, -64.3], [13, 20.8, 144.4, 146.3], [-14.7, -10.9, -171.3, -168]];
/** Is this place where the aerial surveys have pictures? */
export const aerialCovers = (lat, lon) => COVERAGE.some((b) => lat > b[0] && lat < b[1] && lon > b[2] && lon < b[3]);
/** A tile's column in its zoom's grid: the columns of a window across the 180th meridian run on round the earth (geo.js). */
const col = (x, z) => { const n = 2 ** z; return ((x % n) + n) % n; };

// One entry per server. `max` caps the requests in flight; `n` is tiles per side of one request.
const SOURCES = {
  s2: { max: 6, timeout: 20000, n: 1, url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${col(x, z)}.jpg` },
  // The National Map's cached base map: fast, but it stops at zoom 16 (1.7 m per pixel at 45 N).
  usgs: { max: 6, timeout: 20000, n: 1, url: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${col(x, z)}` },
  // Zoom 17 only exists as a dynamic service: slow (2 to 30 s a request), so it is asked for a block of 4 x 4
  // tiles at a time, two requests at once at the most, and the game never waits for it.
  naip: {
    max: 2, timeout: 40000, n: 4,
    url: (z, x, y) => {
      const w = MERC / 2 ** z, x0 = -MERC / 2 + col(x, z) * w, y1 = MERC / 2 - y * w;
      return 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage'
        + `?bbox=${x0.toFixed(3)},${(y1 - 4 * w).toFixed(3)},${(x0 + 4 * w).toFixed(3)},${y1.toFixed(3)}`
        + '&bboxSR=3857&imageSR=3857&size=1024,1024&format=jpg&interpolation=RSP_BilinearInterpolation&f=image';
    },
  },
};

/** What each graphics setting buys: tiles per side of every level's window, the aerial zooms, the filtering. */
const QUALITY = {
  low: { tiles: 4, fine: [16, 15], aniso: 4 },          //  48 MB of texture
  med: { tiles: 6, fine: [16, 15], aniso: 8 },          // 108 MB
  high: { tiles: 8, fine: [17, 16, 15], aniso: 16 },    // 213 MB
};

// Uniforms of its own, beside the ones core/env.js already holds (tImagery, uImgA, uImgC, uImgOn, uPixAngle).
Object.assign(ENV, {
  tImgFade: { value: null },                                                                  // r: how far each slot has faded in (one texel a tile, one layer a level)
  uImgFA: { value: Array.from({ length: FINE_MAX }, () => new THREE.Vector4(0, 0, 1, 0)) },   // aerial levels: x0, z0, 1/extent, radius covered for certain (0: no such level)
  uImgFC: { value: Array.from({ length: FINE_MAX }, () => new THREE.Vector4()) },             // their center x, z; the mip that holds LOW_M; their layer
  uImgCam: { value: new THREE.Vector2() },                                                    // the camera, on the ground plane
  uImgM: { value: new THREE.Vector3(7, 6000, 2) },                                            // satellite level 0: meters per texel, radius covered for certain, the mip that holds LOW_M
});

// The worker: fetch one image (a tile, or a block of n x n tiles), cut it into tiles and give each its mip chain.
// The mips are averaged in linear light. Kept as source text so that no bundler can rename what it refers to.
const WORKER_SRC = `
const TILE = ${TILE}, MIPS = ${MIPS}, PYRAMID = ${PYRAMID};
const lin = new Float32Array(256), enc = new Uint8Array(4097);
for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
for (let i = 0; i <= 4096; i++) { const c = i / 4096; enc[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }
let canvas = null, ctx = null;
function pyramid(src, stride, ox, oy) {
  const out = new Uint8Array(PYRAMID), row = TILE * 4;
  for (let y = 0; y < TILE; y++) { const s = ((oy + y) * stride + ox) * 4; out.set(src.subarray(s, s + row), y * row); }
  // Where a survey has no picture (open water, beyond the border) its tiles are transparent: those pixels are
  // stored as nothing at all (color weighted by alpha, here 0 or 1), which the mips and the shader carry through.
  for (let i = 0; i < TILE * row; i += 4) { if (out[i + 3] < 128) out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; else out[i + 3] = 255; }
  let po = 0, w = TILE;
  for (let k = 1; k < MIPS; k++) {
    const no = po + w * w * 4, h = w >> 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) {
      const a = po + (2 * y * w + 2 * x) * 4, b = a + 4, c = a + w * 4, d = c + 4, o = no + (y * h + x) * 4;
      out[o] = enc[((lin[out[a]] + lin[out[b]] + lin[out[c]] + lin[out[d]]) * 1024 + 0.5) | 0];
      out[o + 1] = enc[((lin[out[a + 1]] + lin[out[b + 1]] + lin[out[c + 1]] + lin[out[d + 1]]) * 1024 + 0.5) | 0];
      out[o + 2] = enc[((lin[out[a + 2]] + lin[out[b + 2]] + lin[out[c + 2]] + lin[out[d + 2]]) * 1024 + 0.5) | 0];
      out[o + 3] = (out[a + 3] + out[b + 3] + out[c + 3] + out[d + 3] + 2) >> 2;
    }
    po = no; w = h;
  }
  return out;
}
onmessage = async (e) => {
  const { id, url, n, timeout } = e.data, stop = new AbortController(), timer = setTimeout(() => stop.abort(), timeout);
  try {
    const r = await fetch(url, { signal: stop.signal });
    if (!r.ok) throw r.status;
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw 415;             // the map servers report some errors as JSON under a 200
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }), S = TILE * n;
    if (bmp.width !== S || bmp.height !== S) { bmp.close(); throw 416; }
    if (!canvas || canvas.width !== S) { canvas = new OffscreenCanvas(S, S); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
    ctx.drawImage(bmp, 0, 0); bmp.close();
    const px = ctx.getImageData(0, 0, S, S).data, tiles = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) tiles.push(pyramid(px, S, i * TILE, j * TILE));
    postMessage({ id, ok: true, bytes: blob.size, tiles }, tiles.map((t) => t.buffer));
  } catch (err) { postMessage({ id, ok: false, status: typeof err === 'number' ? err : 0 }); }
  clearTimeout(timer);
};`;

const now = () => performance.now() / 1000;

export class Imagery {
  /** quality: 'low' | 'med' | 'high' (S.settings.quality). */
  constructor(renderer, quality = 'high') {
    this.renderer = renderer; this.gl = renderer.getContext();
    this.queue = new Map();            // request key -> {L, x, y, n, active, prio}: waiting or in flight
    this.ready = [];                   // tiles decoded and waiting for their upload slot
    this.spare = new Map();            // tiles that came in a block but lay outside the window: they may be wanted in a moment
    this.fails = new Map();            // request key -> {tries, until}
    this.inFlight = new Map();         // worker message id -> request
    this.active = 0; this.failed = 0; this.count = 0; this.bytes = 0; this.requests = 0;
    this.fading = 0;                   // slots still fading in
    this.uploadMs = 0; this.uploadMax = 0;
    this.enabled = true; this.epoch = 0; this.msgId = 0;
    this.vel = new THREE.Vector2(); this.prev = null;
    this.blank = new Uint8Array(PYRAMID);
    for (const s of Object.values(SOURCES)) { s.active = 0; s.streak = 0; s.pauses = 0; s.pauseUntil = 0; }
    try {
      this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
      this.worker.onmessage = (e) => this.arrived(e.data);
      this.worker.onerror = () => { this.enabled = false; };
    } catch { this.worker = null; this.enabled = false; }      // no workers here: the ground keeps its procedural surface
    this.texture = new THREE.DataArrayTexture(null, 1, 1, 1);  // handles only: the storage is made (and remade) in alloc()
    this.fadeTexture = new THREE.DataArrayTexture(null, 1, 1, 1);
    ENV.tImagery.value = this.texture; ENV.tImgFade.value = this.fadeTexture;
    this.setQuality(quality);
  }

  /** Change the graphics setting: the textures are made again at their new size and everything streams in afresh. */
  setQuality(quality) {
    if (typeof quality === 'number') quality = quality <= 4 ? 'low' : 'high';      // (it used to take the window size in tiles)
    if (!QUALITY[quality]) quality = 'high';
    if (quality === this.quality) return;
    this.quality = quality;
    const q = QUALITY[quality];
    this.T = q.tiles; this.S = q.tiles * TILE;
    this.levels = [];
    for (let l = 0; l < IMG_LEVELS; l++) this.levels.push({ layer: l, src: SOURCES.s2, z: IMG_FINE_Z - l, fine: -1 });
    q.fine.forEach((z, f) => this.levels.push({ layer: IMG_LEVELS + f, src: z > 16 ? SOURCES.naip : SOURCES.usgs, z, fine: f }));
    const n = this.T * this.T;
    for (const L of this.levels) Object.assign(L, { key: new Float64Array(n), state: new Uint8Array(n), arrive: new Float64Array(n), want: true, tx0: null, ty0: null });
    this.fade = new Uint8Array(n * this.levels.length);
    this.reset();
  }

  /** Megabytes of texture held. */
  get memory() { return (this.S * this.S * 4 * this.levels.length * (1 - 0.25 ** MIPS)) / 0.75 / 1048576; }
  /** True while anything is on its way or still fading in. */
  get busy() { return this.queue.size + this.ready.length + this.fading > 0; }

  /** Forget everything (the window of the world has moved, or the quality changed): empty textures, nothing in flight counts. */
  reset() {
    this.epoch++;
    this.queue.clear(); this.ready.length = 0; this.spare.clear(); this.fails.clear(); this.inFlight.clear();
    this.active = 0; this.fading = 0; this.prev = null; this.vel.set(0, 0);
    for (const s of Object.values(SOURCES)) { s.active = 0; s.streak = 0; s.pauses = 0; s.pauseUntil = 0; }
    for (const L of this.levels) { L.key.fill(-1); L.state.fill(0); L.arrive.fill(-1); L.tx0 = L.ty0 = null; L.want = true; }
    this.fade.fill(0);
    this.lat0 = REGION.lat0; this.lon0 = REGION.lon0; this.fadeDirty = true; this.coverT = 0;
    const shape = this.S * 100 + this.levels.length;
    if (this.stale !== false || shape !== this.shape) this.alloc();        // (textures nothing has been written to are as good as new)
    this.stale = false; this.shape = shape;
    for (let f = 0; f < FINE_MAX; f++) ENV.uImgFA.value[f].set(0, 0, 1, 0);
  }

  /** (Re)make the two textures. Storage from texStorage3D starts out zero: transparent black, which reads as "no picture here". */
  alloc() {
    const gl = this.gl, r = this.renderer, A = gl.TEXTURE_2D_ARRAY, layers = this.levels.length;
    const make = (tex, old, levels, format, size, linear) => {
      if (old) gl.deleteTexture(old);
      const t = gl.createTexture();
      r.state.activeTexture(gl.TEXTURE0); r.state.bindTexture(A, t);
      gl.texStorage3D(A, levels, format, size, size, layers);
      gl.texParameteri(A, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(A, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(A, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(A, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // The browser clears a level of the storage the first time part of it is written (tens of milliseconds for the
      // big ones): have that happen now, behind the loading screen, not when the first tile lands in flight.
      this.renderer.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); this.renderer.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); this.renderer.state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (let k = 0; k < levels; k++) for (let l = 0; l < layers; l++) gl.texSubImage3D(A, k, 0, 0, l, 1, 1, 1, format === gl.R8 ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, this.blank, 0);
      this.renderer.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      r.properties.get(tex).__webglTexture = t;          // three binds this as it is: the texture's version stays 0, so it never uploads over it
      return t;
    };
    this.glTex = make(this.texture, this.glTex, MIPS, gl.SRGB8_ALPHA8, this.S, false);
    const ext = r.extensions.get('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(A, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(QUALITY[this.quality].aniso, r.capabilities.getMaxAnisotropy()));
    this.glFade = make(this.fadeTexture, this.glFade, 1, gl.R8, this.T, true);
    r.state.bindTexture(A, null);
  }

  // (a tile's column may lie beyond either end of the grid, across the 180th meridian: it is kept with XOFF added, so the key stays positive)
  key(layer, x, y) { return layer * 1099511627776 + (x + XOFF) * 1048576 + y; }
  slot(x, y) { const T = this.T; return (((y % T) + T) % T) * T + (((x % T) + T) % T); }

  /** Recenter every level, ask for what is missing, upload what has arrived, and move the fades on. */
  update(cam, fovY, viewportH) {
    const pix = ENV.uPixAngle.value = (2 * Math.tan((fovY * Math.PI) / 360)) / Math.max(viewportH, 1);
    ENV.uImgOn.value = this.enabled ? 1 : 0;
    if (!this.enabled) return;
    if (this.lat0 !== REGION.lat0 || this.lon0 !== REGION.lon0) this.reset();     // world coordinates mean somewhere else now
    const T = this.T, S = this.S, t = now();

    // Which way the camera is going, smoothed, so that the aerial levels can be laid out ahead of it.
    if (this.prev) {
      const dt = t - this.prev.t, dx = cam.x - this.prev.x, dz = cam.z - this.prev.z;
      if (Math.hypot(dx, dz) > 3000) this.vel.set(0, 0);                    // put somewhere else
      else if (dt > 0.004 && dt < 1) { const k = 1 - Math.exp(-dt / 1.5); this.vel.x += (dx / dt - this.vel.x) * k; this.vel.y += (dz / dt - this.vel.y) * k; }
    }
    this.prev = { x: cam.x, z: cam.z, t };
    // An aerial level is only worth its download while its texels are no smaller than a pixel straight down.
    const foot = Math.max(cam.y - groundHeight(cam.x, cam.z), 0) * pix;
    // ... and where there is a survey at all (asked a few times a minute: the camera crosses a border slowly).
    if (!(t < this.coverT)) { const ll = toLatLon(cam.x, cam.z); this.covered = aerialCovers(ll.lat, ll.lon); this.coverT = t + 5; }

    for (const L of this.levels) {
      const z = L.z, mpp = metersPerPixel(z), n = 2 ** z, half = (T / 2) * TILE * mpp;
      let cx = cam.x, cz = cam.z;
      if (L.fine >= 0) {
        const lead = Math.min(LEAD_S, (LEAD_MAX * half) / Math.max(this.vel.length(), 1e-3));
        cx += this.vel.x * lead; cz += this.vel.y * lead;
        L.want = this.covered && foot < mpp * (L.want ? 2.8 : 2.2);
      }
      const px = pixelX(cx, z), py = pixelY(cz, z);
      const tx0 = Math.round(px / TILE - T / 2), ty0 = Math.round(py / TILE - T / 2);
      if (tx0 !== L.tx0 || ty0 !== L.ty0) {
        // Tiles that slid out of the window give up their slots: each is blanked for the newcomer.
        for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
          const x = tx0 + i, y = ty0 + j, s = this.slot(x, y);
          const k = y < 0 || y >= n ? -1 : this.key(L.layer, x, y);
          if (L.key[s] === k) continue;
          if (L.state[s] === 2) this.upload(L, s, null);
          L.key[s] = k; L.state[s] = 0; L.arrive[s] = -1;
        }
        L.tx0 = tx0; L.ty0 = ty0; this.fadeDirty = true;
      }
      // Ask for what is missing (a block at a time where the server serves blocks).
      const N = L.src.n;
      if (L.want && t >= L.src.pauseUntil) {
        for (let s = 0; s < T * T; s++) {
          if (L.state[s] !== 0 || L.key[s] < 0) continue;
          const y = L.key[s] % 1048576, x = (Math.floor(L.key[s] / 1048576) % 1048576) - XOFF;
          const sp = this.spare.get(L.key[s]);
          if (sp) { this.spare.delete(L.key[s]); this.ready.push({ L, x, y, key: L.key[s], buf: sp }); L.state[s] = 1; continue; }
          const bx = Math.floor(x / N) * N, by = y - (y % N), rk = this.key(L.layer, bx, by);
          if (this.queue.has(rk)) continue;
          const f = this.fails.get(rk);
          if (f && t < f.until) continue;
          this.queue.set(rk, { L, x: bx, y: by, n: N, key: rk, active: false, prio: 0, epoch: this.epoch });
        }
      }
      // Shader mapping for this level: u = (x - x0) * invExtent, repeating.
      const x0 = (Math.floor(px / S) * S - pixelX(0, z)) * mpp, z0 = (Math.floor(py / S) * S - pixelY(0, z)) * mpp;
      if (L.fine < 0) {
        // (uImgA.w and uImgC keep their meaning for imagery(): the half-width that is inside the window, about its center)
        ENV.uImgA.value[L.layer].set(x0, z0, 1 / (S * mpp), half - 3 * mpp);
        ENV.uImgC.value[L.layer].set(((tx0 + T / 2) * TILE - pixelX(0, z)) * mpp, ((ty0 + T / 2) * TILE - pixelY(0, z)) * mpp);
      } else {
        ENV.uImgFA.value[L.fine].set(x0, z0, 1 / (S * mpp), (T / 2 - 0.5) * TILE * mpp - 3 * mpp);
        ENV.uImgFC.value[L.fine].set(cx, cz, Math.max(Math.log2(LOW_M / mpp), 0), L.layer);
      }
    }
    const m0 = metersPerPixel(IMG_FINE_Z);
    ENV.uImgCam.value.set(cam.x, cam.z);
    ENV.uImgM.value.set(m0, (T / 2 - 0.5) * TILE * m0 - 3 * m0, Math.max(Math.log2(LOW_M / m0), 0));

    this.startFetches(cam);
    this.uploadReady(t);
    this.updateFade(t);
  }

  /** Start fetches: coarse levels first (they cover the most ground), then nearest the middle of their window. */
  startFetches(cam) {
    this.cam = cam;
    if (!this.queue.size || !this.worker || this.ready.length > 32) return;      // (decoded tiles are a third of a megabyte each: no more are asked for while a pile of them waits to be uploaded)
    const T = this.T, waiting = [], t = now();
    for (const [k, q] of this.queue) {
      if (q.active) continue;
      const L = q.L;
      // no longer wanted: the window has moved off it, or the camera has climbed out of this level's use
      if (!L.want || q.x + q.n <= L.tx0 || q.x >= L.tx0 + T || q.y + q.n <= L.ty0 || q.y >= L.ty0 + T) { this.queue.delete(k); continue; }
      if (L.src.active >= L.src.max || t < L.src.pauseUntil) continue;
      const mpp = metersPerPixel(L.z), c = L.fine >= 0 ? ENV.uImgFC.value[L.fine] : cam, cz = L.fine >= 0 ? c.y : cam.z;
      const dx = ((q.x + q.n / 2) * TILE - pixelX(c.x, L.z)) * mpp, dz = ((q.y + q.n / 2) * TILE - pixelY(cz, L.z)) * mpp;
      q.prio = (20 - L.z) * 1e7 - Math.hypot(dx, dz);
      waiting.push(q);
    }
    waiting.sort((a, b) => b.prio - a.prio);
    for (const q of waiting) {
      const s = q.L.src;
      if (s.active >= s.max) continue;
      q.active = true; s.active++; this.active++; this.requests++;
      const id = ++this.msgId;
      this.inFlight.set(id, q);
      this.worker.postMessage({ id, url: s.url(q.L.z, q.x, q.y), n: q.n, timeout: s.timeout });
    }
  }

  /** A request has come back from the worker. */
  arrived(m) {
    const q = this.inFlight.get(m.id);
    if (!q) return;                                              // asked before a reset
    this.inFlight.delete(m.id);
    const L = q.L, s = L.src, t = now();
    s.active--; this.active--; this.queue.delete(q.key);
    if (!m.ok) {
      this.failed++; this.lastFail = { z: L.z, status: m.status };
      // Ask again later, and later still each time (30 s, 1 min, 2 min, then every 5); a tile the server says it has not got waits 10 minutes.
      const f = this.fails.get(q.key) || { tries: 0, until: 0 };
      f.tries++; f.until = t + (m.status === 404 ? 600 : Math.min(15 * 2 ** f.tries, 300));
      if (this.fails.size > 2000) this.fails.clear();
      this.fails.set(q.key, f);
      // Eight failures in a row: the server is down or drowning. Leave it alone for half a minute, then a minute,
      // up to five, until it answers again; the ground meanwhile shows the next coarser level, or the rules.
      if (++s.streak >= 8) { s.streak = 0; s.pauseUntil = t + Math.min(30 * 2 ** s.pauses++, 300); }
      return;
    }
    s.streak = 0; s.pauses = 0; this.bytes += m.bytes; this.fails.delete(q.key);
    for (let j = 0; j < q.n; j++) for (let i = 0; i < q.n; i++) {
      const x = q.x + i, y = q.y + j, k = this.key(L.layer, x, y), sl = this.slot(x, y), buf = m.tiles[j * q.n + i];
      if (L.key[sl] === k && L.state[sl] === 0) { L.state[sl] = 1; this.ready.push({ L, x, y, key: k, buf }); }
      else if (q.n > 1 && L.key[sl] !== k) {
        this.spare.set(k, buf);
        if (this.spare.size > 48) this.spare.delete(this.spare.keys().next().value);
      }
    }
    if (this.cam) this.startFetches(this.cam);                   // the next request goes out now, not at the next frame
  }

  uploadReady(t) {
    if (!this.ready.length) { this.uploadMs = 0; return; }
    const t0 = performance.now();
    for (let i = 0; i < MAX_UPLOADS && this.ready.length; i++) {
      if (!uploads.take(350000)) break;                                     // the frame's shared upload budget (render/budget.js)
      const r = this.ready.shift(), s = this.slot(r.x, r.y);
      if (r.L.key[s] !== r.key || r.L.state[s] !== 1) continue;             // its slot has gone to another tile meanwhile
      this.upload(r.L, s, r.buf);
      r.L.state[s] = 2; r.L.arrive[s] = t; this.count++; this.fading++;
      if (performance.now() - t0 > UPLOAD_MS) break;
    }
    this.uploadMs = performance.now() - t0;
    if (this.uploadMs > this.uploadMax) this.uploadMax = this.uploadMs;
  }

  /** Write one tile and its mips (or blank them) into a slot of a level. */
  upload(L, slot, buf) {
    const gl = this.gl, T = this.T, A = gl.TEXTURE_2D_ARRAY;
    this.renderer.state.activeTexture(gl.TEXTURE0);
    this.renderer.state.bindTexture(A, this.glTex);
    this.renderer.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.renderer.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.renderer.state.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.renderer.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const sx = (slot % T) * TILE, sy = Math.floor(slot / T) * TILE, src = buf || this.blank;
    this.stale = true;
    for (let k = 0, o = 0; k < MIPS; k++) {
      const w = TILE >> k;
      gl.texSubImage3D(A, k, sx >> k, sy >> k, L.layer, w, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, src, o);
      o += w * w * 4;
    }
  }

  /** Each slot's fade, 0 (nothing there) to 255 (all there), rewritten while any tile is still arriving. */
  updateFade(t) {
    if (!this.fading && !this.fadeDirty) return;
    const n = this.T * this.T, f = this.fade;
    let fading = 0;
    for (const L of this.levels) {
      const o = L.layer * n;
      for (let s = 0; s < n; s++) {
        if (L.state[s] !== 2) { f[o + s] = 0; continue; }
        const a = Math.min((t - L.arrive[s]) / FADE_S, 1);
        if (a < 1) fading++;
        f[o + s] = Math.round(255 * a * a * (3 - 2 * a));
      }
    }
    this.fading = fading; this.fadeDirty = false;
    const gl = this.gl, A = gl.TEXTURE_2D_ARRAY;
    this.renderer.state.activeTexture(gl.TEXTURE0);
    this.renderer.state.bindTexture(A, this.glFade);
    this.renderer.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.renderer.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.renderer.state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(A, 0, 0, 0, 0, this.T, this.T, this.levels.length, gl.RED, gl.UNSIGNED_BYTE, f);
    this.renderer.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }
}

/**
 * GLSL.
 *  imagery(worldXZ, level): the satellite picture at one level (0 = zoom 14, each level twice as coarse; where a
 *    level has nothing the next coarser answers). rgb linear, a = 1 where there is a picture. For anything that
 *    judges the ground by its color at a point (trees, water); it can be called from a vertex shader.
 *  imageryView(worldXZ, dFdx(worldXZ), dFdy(worldXZ)): the satellite picture as a pixel of the ground should show
 *    it: filtered along the line of sight, each level blended into the next at its edge, tiles fading in.
 *    a = how much of a picture there is, 0 to 1.
 *  imageryDetail(the same): what the aerial survey adds: rgb is the factor that carries its detail (1 = none),
 *    a = how much of the pixel it covers. Multiply it into imageryLow(), the satellite picture blurred to the
 *    scale the detail starts at.
 */
export const IMAGERY_GLSL = /* glsl */`
precision highp sampler2DArray;
uniform sampler2DArray tImagery, tImgFade;
uniform vec4 uImgA[${IMG_LEVELS}];
uniform vec2 uImgC[${IMG_LEVELS}];
uniform vec4 uImgFA[${FINE_MAX}], uImgFC[${FINE_MAX}];
uniform vec3 uImgM;
uniform vec2 uImgCam;
uniform float uImgOn, uPixAngle;
vec4 imagery(vec2 xz, float level) {
  if (uImgOn < 0.5) return vec4(0.0);
  for (int l = int(clamp(level, 0.0, ${(IMG_LEVELS - 1).toFixed(1)})); l < ${IMG_LEVELS}; l++) {
    vec2 d = abs(xz - uImgC[l]);
    if (max(d.x, d.y) < uImgA[l].w) {
      vec4 s = textureLod(tImagery, vec3((xz - uImgA[l].xy) * uImgA[l].z, float(l)), 0.0);
      if (s.a > 0.98) return s;
    }
  }
  return vec4(0.0);
}
// Level whose texels are about one screen pixel at this distance.
float imageryLevel(float dist) { return log2(max(dist, 1.0) * uPixAngle / uImgM.x); }

vec4 imageryView(vec2 xz, vec2 gx, vec2 gy) {
  if (uImgOn < 0.5) return vec4(0.0);
  vec2 dc = abs(xz - uImgCam);
  float d = max(dc.x, dc.y), rem = 1.0;
  vec3 acc = vec3(0.0);
  // From the finest level that reaches this far, each level covers what the ones before it left: all of it in
  // its own ground, less and less across the band at its edge, nothing where its tile has not come.
  for (int l = int(clamp(ceil(log2(max(d, 1.0) / uImgM.y)), 0.0, ${(IMG_LEVELS - 1).toFixed(1)})); l < ${IMG_LEVELS}; l++) {
    float r = uImgM.y * exp2(float(l)), e = 1.0 - smoothstep(${EDGE} * r, r, d);
    if (e <= 0.0) continue;
    vec3 P = vec3((xz - uImgA[l].xy) * uImgA[l].z, float(l));
    float k = uImgA[l].z * 0.75;                                 // a little sharper than the footprint asks: the frame is resolved over several jittered samples
    vec4 s = textureGrad(tImagery, P, gx * k, gy * k);           // (rgb comes weighted by a: a blank neighbor bleeds no black in)
    float w = e * textureLod(tImgFade, P, 0.0).r;
    acc += rem * w * s.rgb; rem *= 1.0 - w * s.a;
    if (rem < 0.004) break;
  }
  return vec4(acc / max(1.0 - rem, 0.004), 1.0 - rem);
}

// The satellite picture blurred to the scale at which the aerial detail is laid over it.
vec3 imageryLow(vec2 xz, vec3 fallback) {
  for (int l = 0; l < 3; l++) {
    vec2 d = abs(xz - uImgC[l]);
    if (max(d.x, d.y) < uImgA[l].w) {
      vec4 s = textureLod(tImagery, vec3((xz - uImgA[l].xy) * uImgA[l].z, float(l)), max(uImgM.z - float(l), 0.0));
      if (s.a > 0.9) return s.rgb / s.a;
    }
  }
  return fallback;
}

vec4 imageryDetail(vec2 xz, vec2 gx, vec2 gy) {
  // (nothing to add once a pixel is wider than the scale the detail starts at)
  if (uImgOn < 0.5 || min(dot(gx, gx), dot(gy, gy)) > ${(LOW_M * LOW_M).toFixed(1)}) return vec4(1.0, 1.0, 1.0, 0.0);
  float rem = 1.0;
  vec3 acc = vec3(0.0);
  for (int f = 0; f < ${FINE_MAX}; f++) {
    float r = uImgFA[f].w;
    if (r <= 0.0) continue;
    vec2 dc = abs(xz - uImgFC[f].xy);
    float e = 1.0 - smoothstep(${EDGE} * r, r, max(dc.x, dc.y));
    if (e <= 0.0) continue;
    vec3 P = vec3((xz - uImgFA[f].xy) * uImgFA[f].z, uImgFC[f].w);
    float w = e * textureLod(tImgFade, P, 0.0).r;
    if (w < 0.004) continue;
    float k = uImgFA[f].z * 0.75;
    vec4 s = textureGrad(tImagery, P, gx * k, gy * k), lo = textureLod(tImagery, P, uImgFC[f].z);
    w *= s.a * step(0.5, lo.a);
    // the survey over its own blur: what is in it that the satellite could not see
    acc += rem * w * (s.rgb / max(s.a, 0.004) + 0.006) / (lo.rgb / max(lo.a, 0.004) + 0.006);
    rem *= 1.0 - w;
    if (rem < 0.004) break;
  }
  return vec4(acc / max(1.0 - rem, 0.004), 1.0 - rem);
}
`;
export const IMAGERY_UNIFORMS = ['tImagery', 'tImgFade', 'uImgA', 'uImgC', 'uImgFA', 'uImgFC', 'uImgM', 'uImgCam', 'uImgOn', 'uPixAngle'];
