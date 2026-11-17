// Overture Maps' own vector tiles, read straight from its public bucket on AWS: one PMTiles archive a theme
// (buildings, base, ...), each hundreds of gigabytes, of which only the directory pages and the tiles wanted are
// fetched, by HTTP range. No dependencies; runs in a worker (or in Node 18+).
//
// Why Overture: OpenStreetMap is thin in much of rural America (around Diamond Lake, Minnesota, it has the lake
// and the roads and not one house or wood). Overture's buildings are OpenStreetMap's where it has them and
// Microsoft's and Google's footprints traced from aerial imagery elsewhere; its land cover is ESA WorldCover,
// a 10 m classification of Sentinel-2 imagery (forest, crop, grass, shrub, built-up...).
//
// The tiles are rebuilt with each monthly release, under a path named for it, and old releases are taken down
// after a couple of months: the newest is found by listing the bucket. Overture says these tiles are meant for
// looking at its data, not for production use, so everything that reads them has a way to carry on without them.
//
//   const a = archive('buildings');
//   await a.tile(z, x, y)     the tile's bytes (gunzipped), null where the archive has no tile, or throws
//   await a.available()       can it be read? (false for a minute after it could not be opened)
//
// Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md

const BUCKET = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/';
// Nothing about the player goes with a request: no cookies, no referrer.
const QUIET = { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' };
const HEAD = 16384;               // the first read: the header and (always, in Overture's archives) the root directory
const KEEP_LEAVES = 96;           // directory pages kept (a page covers a run of tiles along the archive's curve)
const RETRY = 60000;              // after a failure to open, ask again no sooner than this (ms)

/** The releases that have tiles, newest first, e.g. ['2026-10-21.0', '2026-09-23.1', ...]. */
let releases = null;
function listReleases() {
  if (!releases) {
    releases = (async () => {
      const r = await fetch(`${BUCKET}?list-type=2&prefix=tiles/&delimiter=/`, { ...QUIET, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('tile releases: HTTP ' + r.status);
      const names = [...(await r.text()).matchAll(/<Prefix>tiles\/(\d{4}-\d\d-\d\d\.\d+)\/<\/Prefix>/g)].map((m) => m[1]).sort().reverse();
      if (!names.length) throw new Error('tile releases: none listed');
      return names;
    })();
    releases.catch(() => { releases = null; });
  }
  return releases;
}

async function get(url, from, len) {
  const r = await fetch(url, { ...QUIET, headers: { Range: `bytes=${from}-${from + len - 1}` }, signal: AbortSignal.timeout(25000) });
  if (r.status !== 206 && r.status !== 200) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const b = new Uint8Array(await r.arrayBuffer());
  return r.status === 200 && b.length > len ? b.subarray(from, from + len) : b;       // (a server that ignored the range)
}

async function gunzip(b) {
  if (b[0] !== 0x1f || b[1] !== 0x8b) return b;
  return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/** A directory page -> [{ id, run, len, off }] (run 0: a pointer to a deeper page). */
function readDir(b) {
  let p = 0;
  const v = () => { let r = 0, s = 0, c; do { c = b[p++]; r += (c & 127) * 2 ** s; s += 7; } while (c & 128); return r; };
  const n = v(), e = new Array(n);
  let id = 0;
  for (let i = 0; i < n; i++) { id += v(); e[i] = { id, run: 0, len: 0, off: 0 }; }
  for (let i = 0; i < n; i++) e[i].run = v();
  for (let i = 0; i < n; i++) e[i].len = v();
  for (let i = 0; i < n; i++) { const o = v(); e[i].off = o === 0 && i > 0 ? e[i - 1].off + e[i - 1].len : o - 1; }
  return e;
}

/** A tile's place along the archive's Hilbert curve. */
function tileId(z, x, y) {
  let d = 0, tx = x, ty = y;
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0, ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) { if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; } const t = tx; tx = ty; ty = t; }
  }
  return (4 ** z - 1) / 3 + d;
}

class Archive {
  constructor(theme) { this.theme = theme; this.head = null; this.failedAt = -Infinity; this.leaves = new Map(); }

  /** Can the archive be read? (Opens it if need be; false for a while after it could not be.) */
  available() { return this.open().then(() => true, () => false); }

  /** The archive's header and root directory (fetched once). */
  open() {
    if (!this.head) {
      if (performance.now() - this.failedAt < RETRY) return Promise.reject(new Error(`Overture ${this.theme}: unavailable`));
      this.head = (async () => {
        // the newest release that has this theme (one may be listed before all its archives are up)
        let url = null, h = null, err = null;
        for (const rel of (await listReleases()).slice(0, 3)) {
          url = `${BUCKET}tiles/${rel}/${this.theme}.pmtiles`;
          try { h = await get(url, 0, HEAD); break; } catch (e) { err = e; if (e.status !== 403 && e.status !== 404) break; }
        }
        if (!h) throw err;
        const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
        if (String.fromCharCode(...h.subarray(0, 7)) !== 'PMTiles' || h[7] !== 3) throw new Error('not a PMTiles v3 archive');
        const u64 = (o) => Number(dv.getBigUint64(o, true));
        const H = { rootOff: u64(8), rootLen: u64(16), leafOff: u64(40), dataOff: u64(56), ic: h[97], tc: h[98], minz: h[100], maxz: h[101] };
        if (H.ic !== 2 && H.ic !== 1) throw new Error('unknown directory compression ' + H.ic);
        const raw = H.rootOff + H.rootLen <= h.length ? h.subarray(H.rootOff, H.rootOff + H.rootLen) : await get(url, H.rootOff, H.rootLen);
        return { url, H, root: readDir(await gunzip(raw)) };
      })();
      this.head.catch(() => { this.head = null; this.failedAt = performance.now(); releases = null; });
    }
    return this.head;
  }

  page(A, e) {
    let p = this.leaves.get(e.off);
    if (p) { this.leaves.delete(e.off); this.leaves.set(e.off, p); return p; }
    p = get(A.url, A.H.leafOff + e.off, e.len).then(gunzip).then(readDir);
    this.leaves.set(e.off, p);
    p.catch(() => this.leaves.delete(e.off));
    if (this.leaves.size > KEEP_LEAVES) this.leaves.delete(this.leaves.keys().next().value);
    return p;
  }

  /**
   * The tile's bytes, gunzipped; null where the archive has none (nothing mapped there). Throws if it cannot be had.
   * info (optional): its `bytes` is increased by what this call fetched.
   */
  async tile(z, x, y, info = null) {
    const A = await this.open();
    if (z < A.H.minz || z > A.H.maxz) return null;
    const n = 2 ** z;
    const id = tileId(z, ((x % n) + n) % n, y);          // (a window across the 180th meridian asks for columns beyond the grid: world/geo.js)
    let dir = A.root;
    try {
      for (let depth = 0; depth < 4; depth++) {
        let lo = 0, hi = dir.length - 1, f = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (dir[m].id <= id) { f = m; lo = m + 1; } else hi = m - 1; }
        if (f < 0) return null;
        const e = dir[f];
        if (e.run === 0) { const had = this.leaves.has(e.off); dir = await this.page(A, e); if (!had && info) info.bytes += e.len; continue; }
        if (id - e.id >= e.run) return null;
        const b = await get(A.url, A.H.dataOff + e.off, e.len);
        if (info) info.bytes += b.length;
        return await gunzip(b);
      }
      return null;
    } catch (err) {
      // the release has been taken down: look for the new one next time
      if (err.status === 403 || err.status === 404) { this.head = null; releases = null; this.leaves.clear(); }
      throw err;
    }
  }
}

const archives = new Map();
/** The archive of a theme ('buildings', 'base', ...), one per worker. */
export function archive(theme) {
  let a = archives.get(theme);
  if (!a) archives.set(theme, a = new Archive(theme));
  return a;
}
/** The credit Overture asks for (its data comes from these, under ODbL and CC BY 4.0). */
export const OVERTURE_ATTRIBUTION = 'Buildings and land cover: Overture Maps Foundation (overturemaps.org), with data from OpenStreetMap, Microsoft, Google, Esri and ESA WorldCover (CC BY 4.0)';
