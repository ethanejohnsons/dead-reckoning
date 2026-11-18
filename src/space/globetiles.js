// Pictures of the whole Earth for the view from space: the same cloud-free Sentinel-2 mosaic the ground is
// draped with (world/imagery.js), held as a stack of "clip" levels in one array texture.
//
// Level i holds Web Mercator zoom Z0 + i as a square window of W x W tiles of 256 pixels around the point
// the camera is over (pushed a little toward where it looks), addressed toroidally: a tile's slot is its
// index modulo W, so as the craft moves only the tiles that come into the window are fetched. Zoom 2 is the
// whole world in sixteen tiles and is always there; each level above is twice as sharp and half as wide.
// A second small texture says how far each slot has faded in (0: not there yet). The planet's shader
// (cosmos.js) walks from the sharpest level it wants down to the first one that has the place.
//
// Web Mercator ends at 85.05 degrees; the shader paints the caps beyond that itself.

import * as THREE from 'three';

export const GLOBE_Z0 = 2;
const TILE = 256, FADE_S = 0.5, MAX_FLIGHT = 6;
const url = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${z}/${y}/${x}.jpg`;

/** Mercator v (0 at 85.05 N, 1 at 85.05 S) of a latitude in degrees. */
export const mercV = (lat) => { const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

export class GlobeTiles {
  /** levels: how many zooms above Z0 are kept (11 reaches zoom 12, about 30 m a pixel); W: tiles per side of each window. */
  constructor(renderer, W = 6, levels = 11) {
    this.renderer = renderer; this.W = W; this.NL = levels;
    this.texture = new THREE.DataArrayTexture(null, 1, 1, 1);          // a handle only: the storage is made below
    this.mask = new Uint8Array(W * W * levels);
    this.maskTexture = new THREE.DataArrayTexture(null, 1, 1, 1);      // (a handle as well: uploaded by hand in putMask)
    /** Per level, for the shader: x, y: the window's first tile (unwrapped); z: tiles around the world at this zoom; w: tiles per side in use. */
    this.uniform = Array.from({ length: levels }, () => new THREE.Vector4(0, 0, 1, 0));
    this.levels = Array.from({ length: levels }, (_, i) => ({ z: GLOBE_Z0 + i, tx0: 0, ty0: 0, slots: new Array(W * W).fill(null) }));      // slot: { key, t0 (arrival, s), done }
    this.flying = new Map();        // key -> true while a tile is on its way
    this.ready = [];                // decoded tiles waiting for their upload
    this.maxLevel = 0; this.fading = false; this.time = 0;
    this.alloc();
  }

  alloc() {
    const r = this.renderer, gl = r.getContext(), A = gl.TEXTURE_2D_ARRAY, S = this.W * TILE;
    const t = gl.createTexture();
    r.state.activeTexture(gl.TEXTURE0); r.state.bindTexture(A, t);
    gl.texStorage3D(A, 1, gl.SRGB8_ALPHA8, S, S, this.NL);
    gl.texParameteri(A, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(A, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(A, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(A, gl.TEXTURE_WRAP_T, gl.REPEAT);
    r.properties.get(this.texture).__webglTexture = t;          // three binds this as it is (the texture's version stays 0, so it never uploads over it)
    this.glTex = t;
    const k = gl.createTexture();
    r.state.bindTexture(A, k);
    gl.texStorage3D(A, 1, gl.R8, this.W, this.W, this.NL);
    gl.texParameteri(A, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(A, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(A, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(A, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    r.properties.get(this.maskTexture).__webglTexture = k;
    r.state.bindTexture(A, null);
    this.glMask = k;
    this.putMask();
  }
  /** Send the fade values to their texture. (Unpack state goes through three's own cache, renderer.state.pixelStorei:
   *  set behind its back, three's next upload of a canvas comes out upside down or misaligned.) */
  putMask() {
    const r = this.renderer, gl = r.getContext(), A = gl.TEXTURE_2D_ARRAY;
    r.state.activeTexture(gl.TEXTURE0); r.state.bindTexture(A, this.glMask);
    r.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); r.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); r.state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(A, 0, 0, 0, 0, this.W, this.W, this.NL, gl.RED, gl.UNSIGNED_BYTE, this.mask);
    r.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    r.state.bindTexture(A, null);
  }

  /** Bytes of texture held. */
  get bytes() { return (this.W * TILE) ** 2 * 4 * this.NL; }

  /**
   * Once a frame. lat, lon (degrees): the point of the Earth the windows are centered on; aim: { e, n } how far
   * (as a fraction of a window, about -0.35..0.35) to push them east and north of it, toward where the camera looks;
   * maxLevel: the sharpest level worth having at this height (0 .. levels - 1).
   */
  update(dt, lat, lon, aim, maxLevel) {
    this.time += dt;
    const W = this.W, u = lon / 360 + 0.5, v = mercV(lat);
    this.maxLevel = Math.max(0, Math.min(this.NL - 1, Math.round(maxLevel)));
    for (let i = 0; i < this.NL; i++) {
      const L = this.levels[i], n = 2 ** L.z, used = Math.min(W, n);
      let tx0 = 0, ty0 = 0;
      if (n > W) {
        tx0 = Math.round(u * n - W / 2 + aim.e * W);
        ty0 = Math.max(0, Math.min(n - W, Math.round(v * n - W / 2 - aim.n * W)));
      }
      L.tx0 = tx0; L.ty0 = ty0;
      this.uniform[i].set(tx0, ty0, n, i <= this.maxLevel ? used : 0);
      if (i > this.maxLevel) continue;
      for (let dy = 0; dy < used; dy++) for (let dx = 0; dx < used; dx++) {
        const tx = tx0 + dx, ty = ty0 + dy, sx = ((tx % W) + W) % W, sy = ((ty % W) + W) % W, si = sy * W + sx;
        const key = `${L.z}/${((tx % n) + n) % n}/${ty}`, slot = L.slots[si];
        if (slot && slot.key === key) continue;
        // The slot holds another tile (the window has moved on): it is blank until this one arrives.
        L.slots[si] = { key, t0: -1, done: false, d: Math.hypot(dx - used / 2 + 0.5, dy - used / 2 + 0.5) };
        this.mask[i * W * W + si] = 0; this.maskDirty = true;
      }
    }
    this.request();
    this.upload();
    // Tiles fade in.
    if (this.fading || this.maskDirty) {
      let fading = false;
      for (let i = 0; i <= this.maxLevel; i++) {
        const L = this.levels[i];
        for (let si = 0; si < W * W; si++) {
          const s = L.slots[si];
          if (!s || !s.done) continue;
          const f = Math.min(1, (this.time - s.t0) / FADE_S), b = Math.round(f * 255);
          if (f < 1) fading = true;
          if (this.mask[i * W * W + si] !== b) { this.mask[i * W * W + si] = b; this.maskDirty = true; }
        }
      }
      this.fading = fading;
      if (this.maskDirty) { this.putMask(); this.maskDirty = false; }
    }
  }

  /** Ask for what is missing: coarse levels first, and within a level from the middle out. */
  request() {
    if (this.flying.size >= MAX_FLIGHT) return;
    for (let i = 0; i <= this.maxLevel && this.flying.size < MAX_FLIGHT; i++) {
      const L = this.levels[i], want = [];
      for (let si = 0; si < L.slots.length; si++) { const s = L.slots[si]; if (s && !s.done && !s.failed && !this.flying.has(s.key)) want.push([s, si]); }
      want.sort((a, b) => a[0].d - b[0].d);
      for (const [s, si] of want) {
        if (this.flying.size >= MAX_FLIGHT) break;
        this.fetch(i, si, s);
      }
    }
  }
  async fetch(level, si, slot) {
    const key = slot.key, [z, x, y] = key.split('/');
    this.flying.set(key, true);
    try {
      const res = await fetch(url(z, x, y), { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(res.status);
      const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      this.ready.push({ level, si, key, bmp });
    } catch { slot.failed = true; setTimeout(() => { slot.failed = false; }, 8000); }      // (try again in a while: the level below shows meanwhile)
    this.flying.delete(key);
  }
  /** Put arrived tiles into the texture: a few a frame. */
  upload() {
    if (!this.ready.length) return;
    const r = this.renderer, gl = r.getContext(), A = gl.TEXTURE_2D_ARRAY, W = this.W;
    r.state.activeTexture(gl.TEXTURE0); r.state.bindTexture(A, this.glTex);
    r.state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); r.state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    r.state.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); r.state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (let k = 0; k < 6 && this.ready.length; k++) {
      const t = this.ready.shift(), s = this.levels[t.level].slots[t.si];
      if (s && s.key === t.key && !s.done && t.bmp.width === TILE && t.bmp.height === TILE) {       // (else the window moved on while it was coming)
        gl.texSubImage3D(A, 0, (t.si % W) * TILE, Math.floor(t.si / W) * TILE, t.level, TILE, TILE, 1, gl.RGBA, gl.UNSIGNED_BYTE, t.bmp);
        s.done = true; s.t0 = this.time; this.fading = true;
      }
      t.bmp.close?.();
    }
    r.state.bindTexture(A, null);
  }

  /** Is everything asked for there? (For tests and for holding a screenshot.) */
  get pending() {
    let n = this.flying.size + this.ready.length;
    for (let i = 0; i <= this.maxLevel; i++) for (const s of this.levels[i].slots) if (s && !s.done) n++;
    return n;
  }
}
