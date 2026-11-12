// A small pool of workers for the streaming work that used to interrupt the frame: decoding elevation tiles
// and finding their water, building terrain patches, placing trees (world/terrain.worker.js does the work).
//
//   import { pool } from './workers.js';
//   pool.ok                          false if there are no workers: the caller does the work itself
//   pool.run(message, transfer)      a promise for the worker's answer (rejects if the job failed or the
//                                    worker died; the caller then tries again, or does it itself)
//   pool.busy(kind)                  jobs of a kind ('tile', 'patch', 'far') now with the workers
//   pool.cancel(id)                  drop a tile's download (the promise still settles)
//   pool.forget()                    the window of the world has moved
//
// A message with `flats` (airfield grading grids, terrain.flatsIn) and `rect` (the ground the job covers,
// [x0, z0, x1, z1]) has each grid replaced by the part of it under the rectangle: the grids run to megabytes,
// and a job reads a corner of one. The worker lays the part into a grid of the full size (see its `withFlats`),
// so terrain.js's own grading functions read it there exactly as they read the whole one here.
// The pool is made at the first call, and only on a page: `?workers=0` in the address switches it off.

const WANT = typeof document !== 'undefined' && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
  && typeof createImageBitmap !== 'undefined' && !/[?&]workers=0/.test(location.search);
const flatIds = new WeakMap();
let nextFlat = 1, nextId = 1, made = false;

export const pool = {
  /** Workers still alive. */
  list: [],
  size: 0,
  waiting: new Map(),          // job id -> { resolve, reject, worker, kind }
  counts: { tile: 0, patch: 0, far: 0 },
  failed: 0,

  get ok() { if (!made) this.make(); return this.size > 0; },

  make() {
    made = true;
    if (!WANT) return;
    const cores = navigator.hardwareConcurrency || 4, n = cores >= 8 ? 3 : cores >= 4 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      let w;
      try { w = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module', name: 'terrain ' + i }); } catch (e) { console.warn('Terrain workers are not available:', e.message); break; }
      const entry = { w, load: 0, ready: false };
      w.onmessage = (e) => this.answer(entry, e.data);
      w.onerror = (e) => { console.warn('A terrain worker stopped:', e.message || e); this.drop(entry); };
      // one that never reports for duty (its script would not load) is let go, and its jobs with it
      setTimeout(() => { if (!entry.ready) { console.warn('A terrain worker did not start'); this.drop(entry); } }, 20000);
      this.list.push(entry);
    }
    this.size = this.list.length;
  },

  answer(entry, m) {
    if (m.t === 'ready') { entry.ready = true; if (!m.canvas) this.drop(entry); return; }
    const job = this.waiting.get(m.id);
    if (!job) return;
    this.waiting.delete(m.id); entry.load--; this.counts[job.kind]--;
    if (m.ok) job.resolve(m); else job.reject(m);
  },

  /** A worker has died (or never started): its jobs fail back to their callers. */
  drop(entry) {
    const i = this.list.indexOf(entry);
    if (i < 0) return;
    this.list.splice(i, 1); this.size = this.list.length; this.failed++;
    try { entry.w.terminate(); } catch { /* already gone */ }
    for (const [id, job] of this.waiting) if (job.worker === entry) { this.waiting.delete(id); this.counts[job.kind]--; job.reject({ ok: false, err: 'worker stopped', dead: true }); }
  },

  run(m, transfer = []) {
    if (!this.ok) return Promise.reject({ ok: false, err: 'no workers', dead: true });
    let entry = this.list[0];
    for (const e of this.list) if (e.load < entry.load) entry = e;
    m.id = nextId++;
    if (m.flats) {
      const [xa, za, xb, zb] = m.rect;
      m.flatParts = m.flats.map((f) => {
        let id = flatIds.get(f);
        if (!id) flatIds.set(f, id = nextFlat++);
        // the cells the grading reads for points of the rectangle (terrain.js: gradeWeight), and one to spare
        const i0 = Math.max(0, Math.floor((xa - f.x0) / f.cell) - 1), i1 = Math.min(f.nx - 1, Math.floor((xb - f.x0) / f.cell) + 2);
        const j0 = Math.max(0, Math.floor((za - f.z0) / f.cell) - 1), j1 = Math.min(f.nz - 1, Math.floor((zb - f.z0) / f.cell) + 2);
        const cw = Math.max(0, i1 - i0 + 1), ch = Math.max(0, j1 - j0 + 1), dry = f.dry && f.dry !== f.w ? f.dry : null;
        const w = new Float32Array(cw * ch), d = dry ? new Float32Array(cw * ch) : null;
        for (let j = 0; j < ch; j++) {
          const s = (j0 + j) * f.nx + i0;
          w.set(f.w.subarray(s, s + cw), j * cw);
          if (d) d.set(dry.subarray(s, s + cw), j * cw);
        }
        transfer.push(w.buffer); if (d) transfer.push(d.buffer);
        return { id, x0: f.x0, z0: f.z0, x1: f.x1, z1: f.z1, cell: f.cell, nx: f.nx, nz: f.nz, cx: f.cx, cz: f.cz, e0: f.e0, gx: f.gx, gz: f.gz, i0, j0, cw, ch, w, dry: d };
      });
      delete m.flats; delete m.rect;
    }
    return new Promise((resolve, reject) => {
      this.waiting.set(m.id, { resolve, reject, worker: entry, kind: m.t });
      entry.load++; this.counts[m.t]++;
      try { entry.w.postMessage(m, transfer); } catch (e) { this.waiting.delete(m.id); entry.load--; this.counts[m.t]--; reject({ ok: false, err: String(e) }); }
    });
  },

  busy(kind) { return this.counts[kind]; },
  cancel(id) { const job = this.waiting.get(id); if (job) job.worker.w.postMessage({ t: 'cancel', id }); },
  forget() { for (const e of this.list) e.w.postMessage({ t: 'forget' }); },
};
