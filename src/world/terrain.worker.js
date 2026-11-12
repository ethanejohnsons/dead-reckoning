// The worker side of world/workers.js: elevation tiles decoded and searched for water, terrain patches
// built, trees placed, all away from the main thread. A job carries everything it needs, and every typed
// array of an answer is handed back without a copy. Nothing is kept between jobs but the airfields' grading
// grids, which are filled in piece by piece as jobs bring the parts they cover.
//
//   { id, t: 'tile', z, x, y, url }       -> { id, ok, h, water, bytes, ms }     fetch, decode, water rules
//   { id, t: 'patch', job, flatParts }    -> { id, ok, ...patchbuild.buildPatch(job), ms }
//   { id, t: 'far', job, flatParts }      -> { id, ok, ...treeplace.placeFar(job), ms }
//   { t: 'cancel', id }                   a tile that is no longer wanted: its download is dropped
//   { t: 'forget' }                       the window of the world has moved: let go of the airfields
// A job that fails answers { id, ok: false, err }.

import { waterMask } from './water.js';
import { buildPatch, buffersOf, inRegion } from './patchbuild.js';
import { placeFar } from './treeplace.js';

const flats = new Map(), fetching = new Map();
let canvas = null, ctx = null;

// (as dem.js does it on the main thread, when there are no workers)
function decode(bitmap) {
  if (!canvas) { canvas = new OffscreenCanvas(256, 256); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bitmap, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
  for (let i = 0, o = 0; i < 65536; i++, o += 4) h[i] = d[o] * 256 + d[o + 1] + d[o + 2] / 256 - 32768;
  return h;
}

async function tile(m) {
  const stop = new AbortController();
  fetching.set(m.id, stop);
  try {
    const r = await fetch(m.url, { signal: stop.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob();
    const bmp = await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const t0 = performance.now();
    const h = decode(bmp); bmp.close?.();
    const water = waterMask(m.z, m.x, m.y, h);
    postMessage({ id: m.id, ok: true, h, water, bytes: b.size, ms: performance.now() - t0 }, [h.buffer, water.buffer]);
  } catch (e) {
    postMessage({ id: m.id, ok: false, err: String(e && e.message || e), dropped: !!(e && e.name === 'AbortError') });
  } finally { fetching.delete(m.id); }
}

// Each airfield's grading grid is kept at its full size and filled in where jobs have covered it: the grading
// functions of terrain.js then read it as they read the whole grid on the main thread. (What no job has
// brought stays zero, and no job reads outside what it brought.)
function withFlats(m) {
  m.job.flats = (m.flatParts || []).map((p) => {
    let f = flats.get(p.id);
    if (!f) flats.set(p.id, f = { x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, cell: p.cell, nx: p.nx, nz: p.nz, cx: p.cx, cz: p.cz, e0: p.e0, gx: p.gx, gz: p.gz, w: new Float32Array(p.nx * p.nz), dry: null });
    if (p.dry && !f.dry) f.dry = new Float32Array(p.nx * p.nz);
    for (let j = 0; j < p.ch; j++) {
      const d = (p.j0 + j) * p.nx + p.i0;
      f.w.set(p.w.subarray(j * p.cw, (j + 1) * p.cw), d);
      if (p.dry) f.dry.set(p.dry.subarray(j * p.cw, (j + 1) * p.cw), d);
    }
    return f;
  });
  return m.job;
}

onmessage = (e) => {
  const m = e.data;
  if (m.t === 'tile') { tile(m); return; }
  if (m.t === 'cancel') { fetching.get(m.id)?.abort(); return; }
  if (m.t === 'forget') { flats.clear(); return; }
  try {
    const t0 = performance.now(), job = withFlats(m);
    let r;
    if (m.t === 'patch') r = buildPatch(job);
    else if (m.t === 'far') { inRegion(job.region); r = placeFar(job); }
    else throw new Error('unknown job ' + m.t);
    r.id = m.id; r.ok = true; r.ms = performance.now() - t0;
    postMessage(r, buffersOf(r));
  } catch (err) {
    postMessage({ id: m.id, ok: false, err: String(err && err.stack || err) });
  }
};

postMessage({ t: 'ready', canvas: typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined' });
