// The city worker: fetches a vector tile of building footprints, decodes it and builds the meshes of the
// level of detail asked for (world/citybuild.js), all off the main thread. One tile is built at a time;
// fetches overlap. Decoded tiles are kept for a while, so the other levels of a tile cost no download.
//
// Two sources of the same zoom-14 grid: OpenFreeMap's tiles (OpenStreetMap) give the roads, bridges and water,
// and Overture's (world/overture.js) the buildings, since it adds footprints traced from aerial imagery where
// OpenStreetMap has none (most of the rural US). Where Overture cannot be reached the buildings are
// OpenStreetMap's alone, from the first tile.
//
// in:   { type: 'build', id, key, z, x, y, level, quad, size, ground: { n, x0, z0, step, h }, skip: { rings: [Float32Array], boxes: Float32Array } }
//       { type: 'forget' }                       the window of the world moved: tile-local meters mean something else
//       { type: 'source', url }                  take the tiles from another server (TileJSON address)
//       { type: 'bplan', id, key, z, x, y, size }      bridges, first step: put together the bridges that touch this tile (fetching
//                                                       the tiles they run on into) and say where their ground heights are wanted
//       { type: 'bbuild', id, h, detail }               second step: the ground at those points -> the tile's bridge meshes (0 near, 1 far)
// out:  { type: 'built', id, key, level, quad, chunks, foot, lights, roads, count, tall, total, bridges, bytes, ms: { fetch, parse, build } }
//       { type: 'bplan', id, pts, tall, total, bridges, bytes, ms }      (pts: x, z in meters from the tile's corner)
//       { type: 'built', id, chunks, coll, shade, lamps, count, bridge: true, ms }
//       { type: 'failed', id, key, level, quad, error }

import { parseTile, parseOverture, clearOfTowers, buildLevel, Out } from './citybuild.js';
import { assemble, buildBridges } from './bridgebuild.js';
import { archive } from './overture.js';

let SOURCE = 'https://tiles.openfreemap.org/planet';            // TileJSON: names the current weekly tile set
const KEEP = 36;
// Nothing about the player goes with a request: no cookies, no referrer.
const QUIET = { credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' };

let template = null, templateAt = 0;
const cache = new Map();           // url -> Promise<{ tile, bytes }>
const ovCache = new Map();         // tile -> Promise of its buildings from Overture (see overtureBuildings)
const bridges = new Map();         // tile -> its bridge lines (small: kept long after the tile itself has gone from the cache)
const plans = new Map();           // job id -> the bridges put together for it, waiting for their ground heights
const made = new Map();            // tile -> the plan last made for it (its other level of detail asks for the same one soon after)
const KEEP_BRIDGES = 400, KEEP_PLANS = 48, KEEP_MADE = 24;

async function tileUrl(z, x, y) {
  if (!template || performance.now() - templateAt > 6 * 3600e3) {
    template = (async () => {
      const r = await fetch(SOURCE, { ...QUIET, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error('tile index: HTTP ' + r.status);
      const t = (await r.json()).tiles?.[0];
      if (typeof t !== 'string' || !t.startsWith(new URL(SOURCE).origin + '/')) throw new Error('tile index: no tile address');      // tiles only from the host that was asked
      return t;
    })();
    templateAt = performance.now();
    template.catch(() => { template = null; });
  }
  const n = 2 ** z;          // (a window across the 180th meridian asks for columns beyond the grid: world/geo.js)
  return (await template).replace('{z}', z).replace('{x}', ((x % n) + n) % n).replace('{y}', y);
}

function getTile(job) {
  const id = `${job.z}/${job.x}/${job.y}`;
  let p = cache.get(id);
  if (p) { cache.delete(id); cache.set(id, p); return p.then((r) => ({ ...r, bytes: 0, fetch: 0 })); }
  p = (async () => {
    const t0 = performance.now();
    const url = await tileUrl(job.z, job.x, job.y);
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 25000);       // a server that never answers is a failure, not a wait
    let r, buf = null, wire = 0;
    try {
      r = await fetch(url, { ...QUIET, signal: stop.signal });
      if (r.ok && r.status !== 204) buf = new Uint8Array(await r.arrayBuffer());
    } finally { clearTimeout(timer); }
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);                       // (404: no tile there, open country or water)
    if (buf) wire = +r.headers.get('content-length') || Math.round(buf.length * 0.6);         // bytes on the wire (the tiles come gzipped)
    const t1 = performance.now();
    const tile = buf && buf.length ? parseTile(buf, job.size, job.x, job.y) : { blds: [], roads: [], size: job.size, tall: 0, br: { ways: [], under: [], water: [], polys: [], size: job.size } };
    bridges.delete(id); bridges.set(id, { br: tile.br, tall: tile.tall, total: tile.blds.length, water: tile.water || null });
    if (bridges.size > KEEP_BRIDGES) bridges.delete(bridges.keys().next().value);
    return { tile, bytes: wire, fetch: t1 - t0, parse: performance.now() - t1 };
  })();
  cache.set(id, p);
  p.catch(() => cache.delete(id));
  if (cache.size > KEEP) cache.delete(cache.keys().next().value);
  return p;
}

/**
 * A tile's buildings from Overture: { blds, tall, bytes, fetch, parse }; or { off: true } where Overture cannot be
 * reached at all (the buildings are then OpenFreeMap's, as they always were), or { failed: true } where this one
 * tile could not be had (its OpenFreeMap buildings stand in, and how many it has is not reported: see 'built').
 */
function overtureBuildings(job) {
  const id = `${job.z}/${job.x}/${job.y}`;
  let p = ovCache.get(id);
  if (p) { ovCache.delete(id); ovCache.set(id, p); return p.then((r) => (r.blds ? { ...r, bytes: 0, fetch: 0 } : r)); }
  p = (async () => {
    const A = archive('buildings');
    if (!(await A.available())) return { off: true };
    const t0 = performance.now(), info = { bytes: 0 };
    let buf;
    try { buf = await A.tile(job.z, job.x, job.y, info); } catch { try { buf = await A.tile(job.z, job.x, job.y, info); } catch { return { failed: true }; } }
    const t1 = performance.now(), r = parseOverture(buf, job.size, job.x, job.y);
    return { ...r, bytes: info.bytes, fetch: t1 - t0, parse: performance.now() - t1 };
  })();
  ovCache.set(id, p);
  p.then((r) => { if (!r.blds) ovCache.delete(id); });
  if (ovCache.size > KEEP) ovCache.delete(ovCache.keys().next().value);
  return p;
}

/** A tile's bridge lines: from memory, or by fetching the tile. */
async function bridgeTile(z, x, y, size) {
  const b = bridges.get(`${z}/${x}/${y}`);
  if (b) return { ...b, bytes: 0, fetch: 0, parse: 0 };
  const r = await getTile({ z, x, y, size });
  return { br: r.tile.br, tall: r.tile.tall, total: r.tile.blds.length, water: r.tile.water || null, bytes: r.bytes, fetch: r.fetch, parse: r.parse || 0 };
}

async function planBridges(job) {
  const base = await bridgeTile(job.z, job.x, job.y, job.size);
  const tiles = new Map([['0,0', base.br]]);
  let ms = 0;
  const tid = `${job.z}/${job.x}/${job.y}`;
  let plan = made.get(tid) || null, bytes = base.bytes, extra = 0, extraBytes = 0, whole = true;
  if (base.br.ways.length && !plan) for (let round = 0; round < 40; round++) {
    const t0 = performance.now();
    plan = assemble(tiles, job.size, 3, job);
    ms += performance.now() - t0;
    if (!plan.need.length) break;
    // A bridge runs on into tiles not looked at yet: fetch those (they are wanted for their own sake soon enough).
    // After a good many rounds, or where a tile cannot be had, the bridge is left open-ended there.
    if (round >= 8) { for (const [dx, dy] of plan.need) tiles.set(dx + ',' + dy, null); continue; }
    await Promise.all(plan.need.map(([dx, dy]) => bridgeTile(job.z, job.x + dx, job.y + dy, job.size).then((r) => { tiles.set(dx + ',' + dy, r.br); if (r.bytes) { extra++; extraBytes += r.bytes; } }, () => { tiles.set(dx + ',' + dy, null); whole = false; })));
  }
  if (plan && !plan.need.length && whole) { made.delete(tid); made.set(tid, plan); if (made.size > KEEP_MADE) made.delete(made.keys().next().value); }
  // (the tile's water goes with the far level's answer: copies, since the tile's own stay here for the next asking)
  const wm = job.level === 'bf' && base.water ? { pos: base.water.pos.slice(), idx: base.water.idx.slice() } : null;
  // (how many buildings the tile has is told by the building levels when they come from Overture)
  const ovOff = !(await archive('buildings').available());
  const info = { tall: ovOff ? base.tall : undefined, total: ovOff ? base.total : undefined, bridges: base.br.ways.length, water: base.water ? base.water.idx.length / 3 : 0, waterMesh: wm, bytes: bytes + extraBytes, fetched: (base.bytes ? 1 : 0) + extra, extra, extraBytes, ms: { fetch: base.fetch, parse: base.parse, build: ms } };
  if (!plan || plan.need.length || !plan.mine) { self.postMessage({ type: 'built', id: job.id, key: job.key, level: job.level, bridge: true, chunks: [], coll: null, shade: null, lamps: new Float32Array(0), count: 0, ...info }); return; }
  plan.urban = base.total >= 120;
  plans.set(job.id, plan);
  if (plans.size > KEEP_PLANS) plans.delete(plans.keys().next().value);
  self.postMessage({ type: 'bplan', id: job.id, key: job.key, level: job.level, pts: plan.pts.slice(), ...info });
}

function finishBridges(job) {
  const plan = plans.get(job.id);
  if (!plan) throw new Error('the plan was let go');
  plans.delete(job.id);
  const t0 = performance.now(), o = new Out();
  const out = buildBridges(plan, job.h, job.detail, o, plan.urban);
  const transfer = [out.lamps.buffer, out.coll.segs.buffer, out.coll.piers.buffer, out.coll.start.buffer, out.coll.ids.buffer];
  if (out.shade) transfer.push(out.shade.pos.buffer, out.shade.a.buffer, out.shade.idx.buffer);
  for (const c of o.chunks) transfer.push(c.pos.buffer, c.nrm.buffer, c.uv.buffer, c.col.buffer, c.k.buffer, c.idx.buffer, c.ranges.buffer);
  self.postMessage({ type: 'built', id: job.id, key: job.key, level: job.level, bridge: true, chunks: o.chunks, ...out, ms: { fetch: 0, parse: 0, build: performance.now() - t0 } }, transfer);
}

self.onmessage = async (e) => {
  const job = e.data;
  if (job.type === 'forget') { cache.clear(); ovCache.clear(); bridges.clear(); plans.clear(); made.clear(); return; }
  if (job.type === 'source') { SOURCE = job.url; template = null; cache.clear(); bridges.clear(); made.clear(); return; }      // another server of the same tiles (a mirror of one's own)
  if (job.type === 'bplan' || job.type === 'bbuild') {
    try { if (job.type === 'bplan') await planBridges(job); else finishBridges(job); }
    catch (err) { self.postMessage({ type: 'failed', id: job.id, key: job.key, level: job.level, quad: 0, error: String(err?.message || err) }); }
    return;
  }
  if (job.type !== 'build') return;
  try {
    const [got, ov] = await Promise.all([getTile(job), overtureBuildings(job)]);
    const tile = ov.blds ? { ...got.tile, blds: clearOfTowers(ov.blds, got.tile.br, job.x, job.y, job.size), tall: ov.tall } : got.tile;     // (the bridges come from the first tile)
    const bytes = got.bytes + (ov.bytes || 0), tf = Math.max(got.fetch, ov.fetch || 0), parse = (got.parse || 0) + (ov.parse || 0);
    const t0 = performance.now();
    let skip = null;
    const S = job.skip;
    if (S && (S.rings.length || S.boxes.length)) {
      skip = (x, z) => {
        for (let i = 0; i < S.boxes.length; i += 4) if (x > S.boxes[i] && z > S.boxes[i + 1] && x < S.boxes[i + 2] && z < S.boxes[i + 3]) return true;
        for (const p of S.rings) {
          let c = false;
          for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) if ((p[i + 1] > z) !== (p[j + 1] > z) && x < p[i] + ((z - p[i + 1]) / (p[j + 1] - p[i + 1])) * (p[j] - p[i])) c = !c;
          if (c) return true;
        }
        return false;
      };
    }
    const out = buildLevel(tile, job.level, job.quad, job.ground, skip);
    const transfer = [out.lights.buffer, out.foot.box.buffer, out.foot.q.buffer, out.foot.start.buffer, out.foot.pts.buffer];
    if (out.roads) transfer.push(out.roads.pos.buffer, out.roads.ar.buffer, out.roads.idx.buffer, out.roads.paths.p.buffer, out.roads.paths.m.buffer);
    for (const c of out.chunks) transfer.push(c.pos.buffer, c.nrm.buffer, c.uv.buffer, c.col.buffer, c.k.buffer, c.idx.buffer, c.ranges.buffer);
    const known = !ov.failed;          // (a tile whose Overture buildings could not be had does not say it has none)
    self.postMessage({ type: 'built', id: job.id, key: job.key, level: job.level, quad: job.quad, ...out, tall: known ? tile.tall : undefined, total: known ? tile.blds.length : undefined, bridges: tile.br.ways.length, water: tile.water ? tile.water.idx.length / 3 : 0, bytes, ms: { fetch: tf, parse: parse || 0, build: performance.now() - t0 } }, transfer);
  } catch (err) {
    self.postMessage({ type: 'failed', id: job.id, key: job.key, level: job.level, quad: job.quad, error: String(err?.message || err) });
  }
};
