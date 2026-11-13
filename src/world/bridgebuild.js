// Bridges, from the same vector tiles as the buildings: every line of the `transportation` layer that the map
// marks as a bridge becomes a deck standing on piers. Pure arithmetic on typed arrays (no DOM, no three.js),
// so it runs in the city worker and can be exercised from Node.
//
//   parseBridges   a decoded tile -> its bridge lines cut to the tile's own square, the lines that pass under
//                  bridges (roads, railroads, rivers) and its water polygons, in meters from the tile's corner
//   assemble       the tiles around one tile -> the bridges that touch it, whole: lines joined end to end across
//                  tile edges into chains, sampled at stations, with what each station passes over. Says which
//                  further tiles it needs when a bridge runs on beyond what it was given. The result names the
//                  points whose ground height it needs (the main thread has the elevation; the worker has not)
//   buildBridges   that, with the ground heights -> the height of every deck, and the meshes of the part
//                  that lies in the tile: decks, parapets, piers, abutments, arches, trusses, light poles
//
// Heights. The elevation is bare earth: under a bridge it follows the river or the road beneath. A deck is
// the taut string between its abutments (the ground where the bridge meets the land, read a little way back
// along the approach), held up wherever it must clear something: the ground itself, a road or railroad that
// crosses beneath, water. Where chains meet (a ramp leaving a viaduct) their heights are solved together.
// Every tile that holds part of a bridge assembles all of it and reaches the same heights, so the parts
// built by different tiles join.

const KIND_ROAD = 0, KIND_RAIL = 1, KIND_PATH = 2;
// class -> kind, half the width of the made way (m), rank (0 lane .. 3 freeway)
const SPEC = {
  motorway: [KIND_ROAD, 6.4, 3], trunk: [KIND_ROAD, 5.6, 2], primary: [KIND_ROAD, 5.4, 2], secondary: [KIND_ROAD, 4.6, 2], tertiary: [KIND_ROAD, 3.9, 1],
  minor: [KIND_ROAD, 3.3, 0], service: [KIND_ROAD, 2.6, 0], track: [KIND_ROAD, 2.2, 0], busway: [KIND_ROAD, 3.3, 0],
  rail: [KIND_RAIL, 2.6, 0], transit: [KIND_RAIL, 2.4, 0], path: [KIND_PATH, 1.6, 0],
};
const DEPTH = [1.5, 1.9, 0.7];             // structure depth under the running surface, by kind (m)
const GRADE = [0.07, 0.03, 0.10];          // the steepest a deck climbs to clear something, by kind
// what passes beneath: 1 road, 2 railroad, 3 path, 4 river or canal, 5 stream, 6 open water
const U_ROAD = 1, U_RAIL = 2, U_PATH = 3, U_RIVER = 4, U_STREAM = 5, U_WATER = 6;
const STEP = 14;                           // stations are no farther apart than this (m)
const AP = 8;                              // points read back along the approach from each abutment, 7 m apart
const JOIN = 2.5;                          // decks side by side with less than this between them are made to meet (m)
export const LONG = 200;                   // a crossing this long is a landmark: it is kept in view farther out

// A few crossings whose form no rule could guess from the map (it does not say what a bridge is made of, nor
// how high it must stand for ships): latitude, longitude, form, length of the main span (m), height of what
// stands over the deck (m), height of the deck over the water at the main span (m; 0: as the land has it),
// the color of the steel (or of the concrete, for an arch that is concrete).
//   'lift'     a truss span between two towers        'through'  an arch over the deck, the deck hung from it
//   'arch'     arches under the deck (the rule finds most of these by their height; not on a freeway)
const LANDMARKS = [
  [46.77895, -92.09283, 'lift', 118, 41, 0, [0.36, 0.38, 0.39]],        // Aerial Lift Bridge, Duluth
  [46.74800, -92.10030, 'through', 180, 36, 40, [0.17, 0.26, 0.22]],    // Blatnik Bridge, Duluth - Superior
  [46.73300, -92.14700, 'through', 152, 30, 40, [0.40, 0.42, 0.43]],    // Bong Bridge, Duluth - Superior
  [44.94385, -93.08665, 'through', 80, 16, 0, [0.52, 0.50, 0.46]],      // Robert Street, St. Paul (a concrete rainbow arch)
  [45.01305, -93.27550, 'through', 137, 27, 0, [0.55, 0.56, 0.57]],     // Lowry Avenue, Minneapolis
  [44.74680, -92.85300, 'through', 166, 30, 0, [0.50, 0.17, 0.09]],     // Hastings
  [45.05660, -92.80200, 'lift', 43, 24, 0, [0.20, 0.27, 0.23]],         // Stillwater
  [44.88870, -93.18000, 'arch', 0, 0, 0, null],           // Mendota
];

export const S_ROAD = 0, S_CONC = 1, S_SOFFIT = 2, S_STEEL = 3, S_RAIL = 4, S_WALK = 5, S_FASCIA = 6;

// ------------------------------------------------------------------ a tile's bridges

function clipLine(P, size, emit) {
  const snap = (v) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(v - size) < 1e-6 ? size : v);
  let cur = null;
  for (let i = 2; i < P.length; i += 2) {
    const ax = P[i - 2], az = P[i - 1], dx = P[i] - ax, dz = P[i + 1] - az;
    let t0 = 0, t1 = 1, ok = true;
    const edge = (pp, qq) => { if (pp === 0) { if (qq < 0) ok = false; } else { const t = qq / pp; if (pp < 0) { if (t > t1) ok = false; else if (t > t0) t0 = t; } else if (t < t0) ok = false; else if (t < t1) t1 = t; } };
    edge(-dx, ax); edge(dx, size - ax); edge(-dz, az); edge(dz, size - az);
    if (!ok || t1 - t0 <= 1e-9) { if (cur) { emit(cur); cur = null; } continue; }
    if (!cur || t0 > 0) { if (cur) emit(cur); cur = [snap(ax + dx * t0), snap(az + dz * t0)]; }
    cur.push(snap(ax + dx * t1), snap(az + dz * t1));
    if (t1 < 1) { emit(cur); cur = null; }
  }
  if (cur) emit(cur);
}

const lineLength = (p) => { let l = 0; for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return l; };
function boxOf(p) { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (let i = 0; i < p.length; i += 2) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < z0) z0 = p[i + 1]; if (p[i + 1] > z1) z1 = p[i + 1]; } return [x0, z0, x1, z1]; }

/**
 * layers: decodeTile()'s result with `transportation`, `water` and `waterway`; size: meters across the tile.
 * Returns { ways, under, water }: bridge lines cut to the tile (each { p, kind, hw, rank, layer, oneway, sig, box }),
 * what may pass beneath ({ p, t, hw, box }), and water polygons ({ rings, box }).
 */
export function parseBridges(layers, size) {
  const out = { ways: [], under: [], water: [], polys: [], size };
  const T = layers.transportation;
  if (T) {
    const k = size / T.extent, ends = new Set(), feats = [], key = (x, y) => (x + 4096) * 16384 + (y + 4096);
    const land = [new Set(), new Set(), new Set()], portal = [new Set(), new Set(), new Set()];      // (and where tunnels of each kind begin)       // the points of the lines on the ground, by kind: a bridge line that ends on one lands there
    for (const f of T.features) {
      if (f.type === 3 && f.props.class === 'bridge') {
        // the outline of a bridge, where the map has one: it gives the deck's true width
        for (const g of f.geom) { if (g.length < 8) continue; const p = new Float32Array(g.length); for (let i = 0; i < g.length; i++) p[i] = g[i] * k; out.polys.push({ p, box: boxOf(p) }); }
        continue;
      }
      if (f.type !== 2) continue;
      const pr = f.props, sp = SPEC[pr.class];
      if (!sp) continue;
      if (pr.brunnel === 'tunnel') { for (const g of f.geom) { portal[sp[0]].add(key(g[0], g[1])); portal[sp[0]].add(key(g[g.length - 2], g[g.length - 1])); } continue; }
      if (sp[0] === KIND_PATH && (pr.indoor || pr.subclass === 'steps' || pr.subclass === 'platform' || pr.subclass === 'corridor')) continue;     // (skyways between buildings are not bridges to fly under)
      if (pr.brunnel === 'bridge') {
        feats.push(f);
        for (const g of f.geom) { ends.add(key(g[0], g[1])); ends.add(key(g[g.length - 2], g[g.length - 1])); }
      } else {
        const t = sp[0] === KIND_ROAD ? U_ROAD : sp[0] === KIND_RAIL ? U_RAIL : U_PATH;
        for (const g of f.geom) { if (g.length < 4) continue; const p = new Float32Array(g.length); for (let i = 0; i < g.length; i++) p[i] = g[i] * k; out.under.push({ p, t, hw: sp[1] * (pr.ramp ? 0.75 : 1), box: boxOf(p) }); for (let i = 0; i < g.length; i += 2) land[sp[0]].add(key(g[i], g[i + 1])); }
      }
    }
    for (const f of feats) {
      const pr = f.props, sp = SPEC[pr.class], kind = sp[0];
      let hw = sp[1];
      if (pr.ramp) hw *= 0.75; else if (pr.oneway && pr.class !== 'motorway' && kind === KIND_ROAD) hw *= 0.82;
      if (pr.subclass === 'pedestrian') hw = 2.4;
      if (pr.service === 'driveway' || pr.service === 'parking_aisle' || pr.service === 'alley') hw = Math.min(hw, 2.2);
      const layer = +pr.layer || 1, oneway = pr.oneway ? 1 : 0;
      // road paint: 0 none, 1 a center line, 2 center and edge lines, 3 lane dashes and edge lines (a roadway)
      const mark = kind !== KIND_ROAD ? 0 : sp[2] === 0 ? 0 : pr.class === 'motorway' || (oneway && !pr.ramp && sp[2] >= 2) ? 3 : pr.ramp ? 0 : sp[2] >= 2 ? 2 : 1;
      const sig = `${pr.class}|${pr.ramp ? 1 : 0}|${oneway}|${layer}|${hw.toFixed(1)}`;
      for (const g of f.geom) {
        // a line another bridge line ends on is cut there (a ramp leaving a viaduct): their heights are solved together
        let from = 0;
        for (let i = 2; i <= g.length - 2; i += 2) {
          const last = i === g.length - 2;
          if (!last && !ends.has(key(g[i], g[i + 1]))) continue;
          const P = []; for (let j = from; j <= i + 1; j++) P.push(g[j] * k);
          from = i;
          clipLine(P, size, (q) => {
            if (lineLength(q) <= 0.4) return;
            // does an end stand on a line of its own kind that is on the ground? (only a true end: not one the tile's edge made)
            const on = (x, z, set) => { const u = x / k, v = z / k, iu = Math.round(u), iv = Math.round(v); return Math.abs(u - iu) < 1e-6 && Math.abs(v - iv) < 1e-6 && set.has(key(iu, iv)); };
            const m = q.length;
            out.ways.push({ p: Float64Array.from(q), kind, hw, rank: sp[2], mark, layer, oneway, sig, box: boxOf(q), g0: on(q[0], q[1], land[kind]), g1: on(q[m - 2], q[m - 1], land[kind]), t0: on(q[0], q[1], portal[kind]), t1: on(q[m - 2], q[m - 1], portal[kind]) });
          });
        }
      }
    }
  }
  const W = layers.waterway;
  if (W) {
    const k = size / W.extent;
    for (const f of W.features) {
      if (f.type !== 2 || f.props.brunnel === 'tunnel' || f.props.intermittent) continue;
      const big = f.props.class === 'river' || f.props.class === 'canal';
      for (const g of f.geom) { if (g.length < 4) continue; const p = new Float32Array(g.length); for (let i = 0; i < g.length; i++) p[i] = g[i] * k; out.under.push({ p, t: big ? U_RIVER : U_STREAM, hw: big ? 8 : 1.5, box: boxOf(p) }); }
    }
  }
  // Only what lies by a bridge is kept: the rest of the tile's roads and streams are of no use here, and a tile's
  // bridges are held in memory long after the tile itself has been let go.
  const near = (b) => { for (const w of out.ways) if (b[0] < w.box[2] + 45 && b[2] > w.box[0] - 45 && b[1] < w.box[3] + 45 && b[3] > w.box[1] - 45) return true; return false; };
  out.under = out.under.filter((u) => near(u.box));
  const A = layers.water;
  if (A && out.ways.length) {
    const k = size / A.extent;
    for (const f of A.features) {
      if (f.type !== 3 || f.props.class === 'swimming_pool' || f.props.intermittent) continue;
      const rings = []; let box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const g of f.geom) { if (g.length < 6) continue; const p = new Float32Array(g.length); for (let i = 0; i < g.length; i++) p[i] = g[i] * k; rings.push(p); const b = boxOf(p); box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]; }
      if (rings.length && near(box)) out.water.push({ rings, box });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the bridges around a tile, whole

/** Where segment a-b meets c-d: [t along a-b, u along c-d], or null. */
function meet(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}
function inRings(x, z, rings) {
  let c = false;
  for (const p of rings) for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) if ((p[i + 1] > z) !== (p[j + 1] > z) && x < p[i] + ((z - p[i + 1]) / (p[j + 1] - p[i + 1])) * (p[j] - p[i])) c = !c;
  return c;
}
const tkey = (dx, dy) => dx + ',' + dy;

/**
 * tiles: Map 'dx,dy' -> parseBridges() result (null: that tile cannot be had), holding at least '0,0'.
 * Returns { need: [[dx, dy], ...] } while a bridge of tile 0,0 runs on into a tile not in the map, else the
 * plan: { chains, nodes, cross, pts } with pts the points (x, z from the tile's corner) whose ground is wanted.
 */
export function assemble(tiles, size, maxR = 3, origin = null) {
  // ---- every piece of every tile to hand, in this tile's meters
  const P = [];
  for (const [k, br] of tiles) {
    if (!br) continue;
    const [dx, dy] = k.split(',').map(Number), ox = dx * size, oz = dy * size;
    for (const w of br.ways) P.push({ w, dx, dy, ox, oz, n0: -1, n1: -1, comp: -1, used: false, box: [w.box[0] + ox, w.box[1] + oz, w.box[2] + ox, w.box[3] + oz] });
  }
  // ---- nodes: where pieces end. Ends cut by a tile's edge find their other half within a meter and a half.
  const nodes = [], grid = new Map();
  const nodeAt = (x, z, pi, tk) => {
    const onEdge = Math.abs(x / size - Math.round(x / size)) * size < 1e-4 || Math.abs(z / size - Math.round(z / size)) * size < 1e-4;
    const ix = Math.floor(x / 2), iz = Math.floor(z / 2);
    let best = -1, bd = Infinity;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const list = grid.get((ix + i) + ',' + (iz + j));
      if (list) for (const id of list) { const n = nodes[id], d = Math.hypot(n.x - x, n.z - z), tol = onEdge && n.cut && !n.tiles.has(tk) ? 1.6 : 0.3; if (d <= tol && d < bd) { bd = d; best = id; } }
    }
    if (best < 0) { best = nodes.length; nodes.push({ x, z, cut: onEdge, tiles: new Set(), ends: [], id: best, land: false, portal: false }); const gk = ix + ',' + iz; if (!grid.has(gk)) grid.set(gk, []); grid.get(gk).push(best); }
    nodes[best].tiles.add(tk); nodes[best].ends.push(pi);
    return best;
  };
  for (let i = 0; i < P.length; i++) {
    const q = P[i], p = q.w.p, n = p.length, tk = tkey(q.dx, q.dy);
    q.n0 = nodeAt(p[0] + q.ox, p[1] + q.oz, i * 2, tk); q.n1 = nodeAt(p[n - 2] + q.ox, p[n - 1] + q.oz, i * 2 + 1, tk);
    if (q.w.g0) nodes[q.n0].land = true; if (q.w.g1) nodes[q.n1].land = true;
    if (q.w.t0) nodes[q.n0].portal = true; if (q.w.t1) nodes[q.n1].portal = true;
  }
  // ---- connected sets
  const parent = P.map((_, i) => i), find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const n of nodes) for (let k = 1; k < n.ends.length; k++) parent[find(n.ends[k] >> 1)] = find(n.ends[0] >> 1);
  const chosen = new Set();
  for (let i = 0; i < P.length; i++) if (P[i].dx === 0 && P[i].dy === 0) chosen.add(find(i));
  // a bridge that crosses over a lower one must know that one's height: take those in too (and theirs)
  const byTile = new Map();
  for (let i = 0; i < P.length; i++) { const k = tkey(P[i].dx, P[i].dy); if (!byTile.has(k)) byTile.set(k, []); byTile.get(k).push(i); }
  for (let grew = true; grew;) {
    grew = false;
    for (const list of byTile.values()) for (const i of list) {
      const a = P[i];
      if (a.w.layer < 2 || !chosen.has(find(i))) continue;
      for (const j of list) {
        const b = P[j];
        if (b.w.layer >= a.w.layer || chosen.has(find(j))) continue;
        if (a.box[0] > b.box[2] || a.box[2] < b.box[0] || a.box[1] > b.box[3] || a.box[3] < b.box[1]) continue;
        const p = a.w.p, q = b.w.p; let hit = false;
        for (let s = 2; s < p.length && !hit; s += 2) for (let r = 2; r < q.length && !hit; r += 2) hit = !!meet(p[s - 2], p[s - 1], p[s], p[s + 1], q[r - 2], q[r - 1], q[r], q[r + 1]);
        if (hit) { chosen.add(find(j)); grew = true; }
      }
    }
  }
  // ---- does any of it run on into a tile not to hand?
  const need = new Map();
  for (const n of nodes) {
    if (!n.cut || n.tiles.size > 1 || !chosen.has(find(n.ends[0] >> 1))) continue;
    const q = P[n.ends[0] >> 1];
    const fx = n.x / size, fz = n.z / size, rx = Math.round(fx), rz = Math.round(fz);
    const want = [];
    if (Math.abs(fx - rx) * size < 1e-4) want.push([rx === q.dx ? q.dx - 1 : q.dx + 1, q.dy]);
    if (Math.abs(fz - rz) * size < 1e-4) want.push([q.dx, rz === q.dy ? q.dy - 1 : q.dy + 1]);
    for (const [dx, dy] of want) if (tiles.get(tkey(dx, dy)) === undefined && Math.abs(dx) <= maxR && Math.abs(dy) <= maxR) need.set(tkey(dx, dy), [dx, dy]);
  }
  if (need.size) return { need: [...need.values()] };

  // ---- chains: pieces of one kind joined end to end
  const through = (n) => !n.land && n.ends.length === 2 && P[n.ends[0] >> 1].w.sig === P[n.ends[1] >> 1].w.sig && (n.ends[0] >> 1) !== (n.ends[1] >> 1);
  const chains = [], used = new Map();       // node id -> index among the plan's nodes
  const planNodes = [];
  const nodeOf = (id) => { let k = used.get(id); if (k === undefined) { k = planNodes.length; used.set(id, k); const n = nodes[id]; const open = n.cut && n.tiles.size < 2, mouth = n.portal && !n.land; planNodes.push({ x: n.x, z: n.z, deg: n.ends.length, cut: open, ends: [], abut: !mouth && (n.land || (n.ends.length === 1 && !open)), free: mouth || (!n.land && n.ends.length === 1 && open), mouth, ap: -1, h: 0, c: -Infinity }); } return k; };
  for (let i = 0; i < P.length; i++) {
    if (P[i].used || !chosen.has(find(i))) continue;
    // walk back to where the chain starts, then forward
    let pi = i, end = 0, guard = 0;
    while (through(nodes[end ? P[pi].n1 : P[pi].n0]) && guard++ < 10000) {
      const n = nodes[end ? P[pi].n1 : P[pi].n0], other = n.ends[0] === pi * 2 + end ? n.ends[1] : n.ends[0];
      if ((other >> 1) === i) break;                      // a closed ring: start here
      pi = other >> 1; end = (other & 1) ^ 1;
    }
    const pts = [], own = [], startNode = end ? P[pi].n1 : P[pi].n0;
    let endNode = startNode, w0 = P[pi].w;
    for (guard = 0; guard < 10000; guard++) {
      const q = P[pi], p = q.w.p, n = p.length / 2;
      if (q.used) break;
      q.used = true;
      const mine = q.dx === 0 && q.dy === 0 ? 1 : 0, tk = tkey(q.dx, q.dy);
      for (let k = 0; k < n; k++) {
        const j = end ? n - 1 - k : k, x = p[2 * j] + q.ox, z = p[2 * j + 1] + q.oz;
        if (k === 0 && pts.length) { pts[pts.length - 2] = (pts[pts.length - 2] + x) / 2; pts[pts.length - 1] = (pts[pts.length - 1] + z) / 2; continue; }
        if (pts.length) own.push([mine, tk]);
        pts.push(x, z);
      }
      endNode = end ? q.n0 : q.n1;
      const nn = nodes[endNode];
      if (!through(nn)) break;
      const other = nn.ends[0] === pi * 2 + (end ^ 1) ? nn.ends[1] : nn.ends[0];
      pi = other >> 1; end = other & 1;
    }
    if (pts.length < 4) continue;
    // always the same way round, whichever tile is asking
    let rev = pts[pts.length - 2] < pts[0] - 0.01 || (Math.abs(pts[pts.length - 2] - pts[0]) <= 0.01 && pts[pts.length - 1] < pts[1]);
    if (rev) { const r = []; for (let k = pts.length - 2; k >= 0; k -= 2) r.push(pts[k], pts[k + 1]); pts.length = 0; pts.push(...r); own.reverse(); }
    const c = { kind: w0.kind, hw: w0.hw, rank: w0.rank, mark: w0.mark, layer: w0.layer, oneway: w0.oneway, nA: nodeOf(rev ? endNode : startNode), nB: nodeOf(rev ? startNode : endNode), poly: pts, own, cross: [], id: chains.length };
    chains.push(c);
  }
  // ---- stations, and what each chain passes over
  for (const c of chains) {
    const p = c.poly, cum = [0];
    for (let i = 2; i < p.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]));
    c.L = cum[cum.length - 1];
    c.box = boxOf(p);
    // crossings: with the lines of the tile each stretch lies in
    for (let i = 2; i < p.length; i += 2) {
      const br = tiles.get(c.own[i / 2 - 1][1]), [dx, dy] = c.own[i / 2 - 1][1].split(',').map(Number), ox = dx * size, oz = dy * size;
      const ax = p[i - 2] - ox, az = p[i - 1] - oz, bx = p[i] - ox, bz = p[i + 1] - oz, len = cum[i / 2] - cum[i / 2 - 1];
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), z0 = Math.min(az, bz), z1 = Math.max(az, bz);
      for (const u of br.under) {
        if (u.box[0] > x1 || u.box[2] < x0 || u.box[1] > z1 || u.box[3] < z0) continue;
        if (u.t === U_PATH && c.kind === KIND_PATH) continue;
        const q = u.p;
        for (let r = 2; r < q.length; r += 2) {
          const m = meet(ax, az, bx, bz, q[r - 2], q[r - 1], q[r], q[r + 1]);
          if (!m || (r === 2 && m[1] < 0.004) || (r === q.length - 2 && m[1] > 0.996) || (m[1] === 1 && r < q.length - 2)) continue;
          c.cross.push({ s: cum[i / 2 - 1] + m[0] * len, t: u.t, hw: u.hw });
        }
      }
    }
  }
  // bridges over bridges
  const cross = [];
  for (const a of chains) for (const b of chains) {
    if (b.layer >= a.layer || a.box[0] > b.box[2] || a.box[2] < b.box[0] || a.box[1] > b.box[3] || a.box[3] < b.box[1]) continue;
    const p = a.poly, q = b.poly; let sa = 0;
    for (let i = 2; i < p.length; i += 2) {
      const la = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); let sb = 0;
      for (let r = 2; r < q.length; r += 2) {
        const lb = Math.hypot(q[r] - q[r - 2], q[r + 1] - q[r - 1]);
        const m = meet(p[i - 2], p[i - 1], p[i], p[i + 1], q[r - 2], q[r - 1], q[r], q[r + 1]);
        if (m) { a.cross.push({ s: sa + m[0] * la, t: 0, hw: b.hw, over: cross.length }); b.cross.push({ s: sb + m[1] * lb, t: 0, hw: 0, under: cross.length }); cross.push({ hi: a.id, lo: b.id, iHi: -1, iLo: -1, kind: b.kind }); }
        sb += lb;
      }
      sa += la;
    }
  }
  let npts = 0;
  const RANK = [0, 4, 5, 3, 2, 1, 0];
  for (const c of chains) {
    const p = c.poly, X = [], Z = [], S = [], OWN = [];
    // (a line that meets the bridge within a few meters of where it lands is the junction there, not something beneath)
    for (const x of c.cross) if (x.t && x.t <= U_PATH && ((x.s < 6 && planNodes[c.nA].abut) || (x.s > c.L - 6 && planNodes[c.nB].abut))) x.skip = true;
    let s = 0;
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05 && i < p.length - 2) { s += len; continue; }
      // the fixed stations of this stretch, and its crossings among them
      const m = Math.max(1, Math.ceil(len / STEP)), at = [];
      for (let k = X.length ? 1 : 0; k <= m; k++) at.push((k / m) * len);
      for (const x of c.cross) { if (x.skip) continue; const d = x.s - s; if (d > 0.8 && d < len - 0.8 && !at.some((v) => Math.abs(v - d) < 0.8)) at.push(d); }
      at.sort((u, v) => u - v);
      for (const d of at) { if (X.length) OWN.push(c.own[i / 2 - 1][0]); X.push(ax + ((bx - ax) * d) / (len || 1)); Z.push(az + ((bz - az) * d) / (len || 1)); S.push(s + d); }
      s += len;
    }
    const n = X.length;
    c.X = Float64Array.from(X); c.Z = Float64Array.from(Z); c.S = Float64Array.from(S); c.own = Uint8Array.from(OWN); c.n = n;
    c.under = new Uint8Array(n); c.uhw = new Float32Array(n);
    const near = (sv) => { let b = 0; for (let i = 1; i < n; i++) if (Math.abs(S[i] - sv) < Math.abs(S[b] - sv)) b = i; return b; };
    for (const x of c.cross) {
      const i = near(x.s);
      if (x.over !== undefined) { cross[x.over].iHi = i; continue; }
      if (x.under !== undefined) { cross[x.under].iLo = i; continue; }
      if (!x.skip && RANK[x.t] > RANK[c.under[i]]) { c.under[i] = x.t; c.uhw[i] = x.hw; }
    }
    // open water under a station (of the tile it stands in)
    for (let i = 0; i < n; i++) {
      if (c.under[i]) continue;
      const dx = Math.floor(X[i] / size), dy = Math.floor(Z[i] / size), br = tiles.get(tkey(dx, dy));
      if (!br) continue;
      const lx = X[i] - dx * size, lz = Z[i] - dy * size;
      for (const w of br.water) if (lx >= w.box[0] && lx <= w.box[2] && lz >= w.box[1] && lz <= w.box[3] && inRings(lx, lz, w.rings)) { c.under[i] = U_WATER; break; }
    }
    c.pt0 = npts; npts += n;
    planNodes[c.nA].ends.push([c.id, 0]); planNodes[c.nB].ends.push([c.id, 1]);
    delete c.poly;
  }
  // A deck's width, from the outline the map gives of the bridge, where a chain has one to itself (the lines
  // alone say only what kind of way it is: an old railroad viaduct that now carries a path is as wide as ever).
  {
    const inside = new Map();        // outline -> the chains that run through it
    for (const c of chains) {
      const d = [], ids = new Map();
      for (let i = 0; i < c.n; i += 2) {
        const dx = Math.floor(c.X[i] / size), dy = Math.floor(c.Z[i] / size), br = tiles.get(tkey(dx, dy));
        if (!br || !br.polys.length) continue;
        const lx = c.X[i] - dx * size, lz = c.Z[i] - dy * size;
        for (let k = 0; k < br.polys.length; k++) {
          const q = br.polys[k], p = q.p;
          if (lx < q.box[0] || lx > q.box[2] || lz < q.box[1] || lz > q.box[3] || !inRings(lx, lz, [p])) continue;
          let best = Infinity;
          for (let a = 0, m = p.length, b = m - 2; a < m; b = a, a += 2) {
            const ex = p[a] - p[b], ez = p[a + 1] - p[b + 1], l2 = ex * ex + ez * ez || 1, t = Math.min(1, Math.max(0, ((lx - p[b]) * ex + (lz - p[b + 1]) * ez) / l2));
            // (an edge that lies along the tile's rim is where the outline was cut, not the side of the bridge)
            if ((Math.abs(p[a]) < 0.5 && Math.abs(p[b]) < 0.5) || (Math.abs(p[a + 1]) < 0.5 && Math.abs(p[b + 1]) < 0.5)) continue;
            const dd = Math.hypot(p[b] + ex * t - lx, p[b + 1] + ez * t - lz); if (dd < best) best = dd;
          }
          d.push(best); const id = dx + ',' + dy + ',' + k; ids.set(id, (ids.get(id) || 0) + 1);
          break;
        }
      }
      const samples = Math.ceil(c.n / 2);
      c.rw = c.hw;
      if (d.length < 0.6 * samples) { for (const id of ids.keys()) { if (!inside.has(id)) inside.set(id, new Set()); inside.get(id).add(c.id); } continue; }
      d.sort((u, v) => u - v);
      c.polyW = d[d.length >> 1]; c.polyIds = [...ids.keys()];
      for (const id of ids.keys()) { if (!inside.has(id)) inside.set(id, new Set()); inside.get(id).add(c.id); }
    }
    for (const c of chains) {
      if (!c.polyW || c.polyIds.some((id) => inside.get(id).size > 1)) continue;
      c.hw = Math.min(Math.max(c.hw, c.polyW), c.kind === KIND_ROAD ? c.hw + 5 : 9);
    }
  }
  // the few crossings that are known by name: which chains are theirs, and where along them the main span stands
  if (origin) for (const [lat, lon, form, span, tall, clear, col] of LANDMARKS) {
    const nT = 2 ** origin.z, lx = ((lon + 180) / 360 * nT - origin.x) * size, lz = ((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * nT - origin.y) * size;
    if (Math.abs(lx) > (maxR + 2) * size || Math.abs(lz) > (maxR + 2) * size) continue;
    for (const c of chains) {
      if (lx < c.box[0] - 70 || lx > c.box[2] + 70 || lz < c.box[1] - 70 || lz > c.box[3] + 70) continue;
      let best = 70, bi = -1;
      for (let i = 0; i < c.n; i++) { const d = Math.hypot(c.X[i] - lx, c.Z[i] - lz); if (d < best) { best = d; bi = i; } }
      if (bi >= 0) c.lm = { s: c.S[bi], form, span, tall, clear, col };
    }
  }
  // total length of each connected structure
  {
    const par = planNodes.map((_, i) => i), f = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; }, len = new Map();
    for (const c of chains) par[f(c.nA)] = f(c.nB);
    for (const c of chains) len.set(f(c.nA), (len.get(f(c.nA)) || 0) + c.L);
    for (const c of chains) c.total = len.get(f(c.nA));
  }
  // ---- the land at each end: where a chain stops and nothing carries on, the bridge meets the ground
  for (const n of planNodes) {
    if (!n.abut || !n.ends.length) { n.abut = false; continue; }      // (a free end ran off the edge of what could be had)
    const [ci, e] = n.ends[0], c = chains[ci], i0 = e ? c.n - 1 : 0, i1 = e ? c.n - 2 : 1;
    let tx = c.X[i0] - c.X[i1], tz = c.Z[i0] - c.Z[i1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    // the road that carries on from here, if the tile has it: its line is followed back; else straight on
    const dx = Math.floor(n.x / size), dy = Math.floor(n.z / size), br = tiles.get(tkey(dx, dy));
    let line = null, fromEnd = false;
    if (br) {
      const lx = n.x - dx * size, lz = n.z - dy * size, want = c.kind === KIND_ROAD ? U_ROAD : c.kind === KIND_RAIL ? U_RAIL : U_PATH;
      for (const u of br.under) {
        if (u.t !== want) continue;
        const q = u.p, m = q.length;
        if (Math.hypot(q[0] - lx, q[1] - lz) < 0.3) { line = u.p; fromEnd = false; } else if (Math.hypot(q[m - 2] - lx, q[m - 1] - lz) < 0.3) { line = u.p; fromEnd = true; } else continue;
        // the one that goes straightest on
        const j = fromEnd ? m - 4 : 2, ddx = q[j] - lx, ddz = q[j + 1] - lz, dl = Math.hypot(ddx, ddz) || 1;
        if ((ddx * tx + ddz * tz) / dl > 0.7) break;
        line = null;
      }
      n.ap = npts; n.pts = [];
      for (let k = 1; k <= AP; k++) {
        let want2 = k * 7, x = n.x + tx * want2, z = n.z + tz * want2;
        if (line) {
          const q = line, m = q.length / 2; let px = lx, pz = lz;
          for (let a = 1; a < m; a++) { const j = fromEnd ? m - 1 - a : a, qx = q[2 * j], qz = q[2 * j + 1], d = Math.hypot(qx - px, qz - pz); if (d >= want2) { x = px + ((qx - px) * want2) / d + dx * size; z = pz + ((qz - pz) * want2) / d + dy * size; want2 = -1; break; } want2 -= d; px = qx; pz = qz; }
          if (want2 >= 0) { x = px + dx * size + tx * want2; z = pz + dy * size + tz * want2; }
        }
        n.pts.push(x, z);
      }
      npts += AP;
    } else { n.ap = npts; n.pts = []; for (let k = 1; k <= AP; k++) n.pts.push(n.x + tx * k * 7, n.z + tz * k * 7); npts += AP; }
    n.tx = tx; n.tz = tz;
  }
  const pts = new Float32Array(npts * 2);
  for (const c of chains) for (let i = 0; i < c.n; i++) { pts[(c.pt0 + i) * 2] = c.X[i]; pts[(c.pt0 + i) * 2 + 1] = c.Z[i]; }
  for (const n of planNodes) if (n.abut) for (let k = 0; k < 2 * AP; k++) pts[n.ap * 2 + k] = n.pts[k];
  let mine = 0; for (const c of chains) for (let i = 0; i < c.n - 1; i++) if (c.own[i]) { mine++; break; }
  return { need: [], chains, nodes: planNodes, cross, pts, size, mine };
}

// ------------------------------------------------------------------ heights

/** The taut string over a chain's obstacles between its two end heights: fills c.h, and notes the first and last points it rests on. */
function string(c, hA, hB) {
  const n = c.n, S = c.S, ob = c.ob, hull = c.hull || (c.hull = new Int32Array(n)), a0 = ob[0], a1 = ob[n - 1];
  ob[0] = hA; ob[n - 1] = hB;                 // (the ends are held; their own obstacle is the node's business)
  let m = 0; hull[m++] = 0;
  for (let i = 1; i < n; i++) {
    while (m >= 2) {
      const a = hull[m - 2], b = hull[m - 1];
      if ((ob[b] - ob[a]) * (S[i] - S[a]) <= (ob[i] - ob[a]) * (S[b] - S[a])) m--; else break;
    }
    hull[m++] = i;
  }
  for (let k = 0; k < m - 1; k++) {
    const a = hull[k], b = hull[k + 1], ya = ob[a], yb = ob[b], d = S[b] - S[a] || 1;
    for (let i = a; i <= b; i++) c.h[i] = ya + ((yb - ya) * (S[i] - S[a])) / d;
  }
  c.first = hull[1]; c.last = hull[m - 2];
  ob[0] = a0; ob[n - 1] = a1;
}

/** Clearance a deck's running surface needs over the ground at a station (m). */
function clearance(c, i) {
  const D = DEPTH[c.kind], u = c.under[i];
  if (u === U_ROAD) return 5.0 + D;
  if (u === U_RAIL) return 6.9 + D;
  if (u === U_PATH) return 3.0 + D;
  if (c.lm && c.lm.clear && Math.abs(c.S[i] - c.lm.s) < c.lm.span / 2) return c.lm.clear;
  // a river a ship can use is wide, and a bridge over it stands high (the map does not say how high: this much is common)
  // (a railroad cannot climb to it: its bridges over such rivers are low, with a span that lifts or swings)
  if (u === U_RIVER) return Math.max(Math.min(5, 1.5 + c.L / 40), c.kind === KIND_ROAD ? Math.min(16, 5 + (c.wet - 100) / 25) : 0);
  if (u === U_STREAM) return Math.min(1.6, 0.6 + c.L / 60);
  if (u === U_WATER) return Math.min(3.5, 1.2 + c.L / 50);
  return 0.25;
}

/** Give every station of the plan its ground (c.g) and deck height (c.h). H: the ground at plan.pts. */
export function solveHeights(plan, H) {
  const { chains, nodes, cross } = plan;
  for (const c of chains) {
    const n = c.n; c.g = new Float32Array(n); c.h = new Float32Array(n); c.ob = new Float32Array(n);
    c.wet = 0; for (let i = 1; i < n; i++) if ((c.under[i] === U_WATER || c.under[i] === U_RIVER) && (c.under[i - 1] === U_WATER || c.under[i - 1] === U_RIVER)) c.wet += c.S[i] - c.S[i - 1];      // meters of it over open water
    for (let i = 0; i < n; i++) { c.g[i] = H[c.pt0 + i]; c.ob[i] = c.g[i] + clearance(c, i); }
    // (where a bridge runs into a tunnel the survey shows the hillside over the tunnel's mouth, not the road: no guide to the deck there)
    if (nodes[c.nA].mouth) for (let i = 0; i < n && c.S[i] < 45; i++) c.ob[i] = -1e6;
    if (nodes[c.nB].mouth) for (let i = n - 1; i >= 0 && c.L - c.S[i] < 45; i--) c.ob[i] = -1e6;
  }
  for (const nd of nodes) {
    nd.c = -Infinity;
    for (const [ci, e] of nd.ends) { const c = chains[ci]; nd.c = Math.max(nd.c, c.ob[e ? c.n - 1 : 0]); }
    if (!nd.abut) { nd.h = nd.c; continue; }
    const [ci0, e0] = nd.ends[0], c0 = chains[ci0], h0 = c0.g[e0 ? c0.n - 1 : 0];
    const a1 = H[nd.ap], a2 = H[nd.ap + 1], a3 = H[nd.ap + 2], a4 = H[nd.ap + 3];
    // The road's own level, read back along the approach: the end itself often stands on the slope of the bank.
    nd.g = h0; nd.apg = Array.from({ length: AP }, (_, k) => H[nd.ap + k]);
    nd.h = Math.max(h0, Math.min(a2 + (a2 - a4), Math.max(a1, a2, a3)));
    // and no lower than whatever the deck must clear allows at the steepest climb
    for (const [ci, e] of nd.ends) {
      const c = chains[ci], G = GRADE[c.kind];
      for (let i = 1; i < c.n - 1; i++) { const d = Math.abs(c.S[i] - c.S[e ? c.n - 1 : 0]); if (c.ob[i] - G * d > nd.h) nd.h = c.ob[i] - G * d; }
    }
  }
  // Chains are strung between their nodes; a node that is not held by the land takes the height its chains
  // pull it to (each by the slope to the first point it rests on), and no lower than it must be. Repeated, for
  // the chains whose ends moved, until nothing moves.
  const dirty = new Uint8Array(chains.length).fill(1);
  const relax = () => {
    for (let it = 0; it < 400; it++) {
      let any = false;
      for (const c of chains) if (dirty[c.id]) { string(c, nodes[c.nA].h, nodes[c.nB].h); dirty[c.id] = 0; c.moved = true; any = true; }
      if (!any) break;
      for (const nd of nodes) {
        if (nd.abut) continue;
        let touched = false; for (const [ci] of nd.ends) if (chains[ci].moved) touched = true;
        if (!touched) continue;
        let num = 0, den = 0;
        for (const [ci, e] of nd.ends) { const c = chains[ci], j = e ? c.last : c.first, d = Math.max(0.5, Math.abs(c.S[j] - c.S[e ? c.n - 1 : 0])); num += c.h[j] / d; den += 1 / d; }
        const h = Math.max(nd.c, den ? num / den : nd.c);
        if (Math.abs(h - nd.h) > 0.004) { nd.h = h; for (const [ci] of nd.ends) dirty[ci] = 1; }
      }
      for (const c of chains) c.moved = false;
    }
  };
  relax();
  // (a short bridge between two tunnels has nothing to say how high it is: it lies on the ground at its ends)
  { let fixed = false; for (const nd of nodes) if (!nd.abut && !(nd.h > -1e5)) { const [ci, e] = nd.ends[0], c = chains[ci]; nd.c = nd.h = c.g[e ? c.n - 1 : 0]; for (const [cj] of nd.ends) dirty[cj] = 1; fixed = true; } if (fixed) relax(); }
  // decks that cross over lower decks clear them (a few rounds: a stack is at most a few levels deep)
  for (let round = 0; round < 4 && cross.length; round++) {
    let changed = false;
    for (const x of cross) {
      if (x.iHi < 0 || x.iLo < 0) continue;
      const hi = chains[x.hi], lo = chains[x.lo], want = lo.h[x.iLo] + (x.kind === KIND_RAIL ? 6.9 : x.kind === KIND_PATH ? 3.0 : 5.0) + DEPTH[hi.kind];
      if (want > hi.ob[x.iHi] + 0.01) {
        hi.ob[x.iHi] = want; changed = true; dirty[hi.id] = 1;
        if (x.iHi === 0 || x.iHi === hi.n - 1) { const nd = nodes[x.iHi ? hi.nB : hi.nA]; nd.c = Math.max(nd.c, want); if (nd.abut && want > nd.h) nd.h = want; for (const [ci] of nd.ends) dirty[ci] = 1; }
        for (const e of [0, 1]) { const nd = nodes[e ? hi.nB : hi.nA]; if (nd.abut) { const v = want - GRADE[hi.kind] * Math.abs(hi.S[x.iHi] - hi.S[e ? hi.n - 1 : 0]); if (v > nd.h) { nd.h = v; for (const [ci] of nd.ends) dirty[ci] = 1; } } }
      }
    }
    if (!changed) break;
    relax();
  }
}

// ------------------------------------------------------------------ meshes

function triN(o, a, b, c, nx, ny, nz) {
  const p = o.pos, ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az, vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  if ((uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz >= 0) o.tri(a, b, c); else o.tri(a, c, b);
}
/** A band of quads through n stations: put(i) lays two vertices and returns the band's normal there. */
function ribbon(o, n, put, skip) {
  o.need(n * 2, (n - 1) * 6);
  const base = o.n, N = [];
  for (let i = 0; i < n; i++) N.push(put(i));
  for (let i = 0; i < n - 1; i++) {
    if (skip && skip(i)) continue;
    const a = base + 2 * i, m = N[i];
    triN(o, a, a + 1, a + 2, m[0], m[1], m[2]); triN(o, a + 1, a + 3, a + 2, m[0], m[1], m[2]);
  }
}
/** An upright block: center, across axis (ax, az), half-widths across and along, from y0 to y1, its foot `flare` times as big. caps: 1 top, 2 bottom. */
function block(o, cx, cz, ax, az, a, b, y0, y1, flare = 1, caps = 0) {
  const bx = -az, bz = ax;
  const corner = (s, d, k) => [cx + s * a * k * ax + d * b * k * bx, cz + s * a * k * az + d * b * k * bz];
  const sides = [[1, 1, 1, -1, ax, az, 2 * b], [1, -1, -1, -1, -bx, -bz, 2 * a], [-1, -1, -1, 1, -ax, -az, 2 * b], [-1, 1, 1, 1, bx, bz, 2 * a]];
  o.need(16 + (caps & 1 ? 4 : 0) + (caps & 2 ? 4 : 0), 24 + (caps & 1 ? 6 : 0) + (caps & 2 ? 6 : 0));
  for (const [s0, d0, s1, d1, nx, nz, w] of sides) {
    const p0 = corner(s0, d0, flare), p1 = corner(s1, d1, flare), q0 = corner(s0, d0, 1), q1 = corner(s1, d1, 1);
    const i0 = o.v(p0[0], y0, p0[1], nx, 0, nz, 0, y0 - y1), i1 = o.v(p1[0], y0, p1[1], nx, 0, nz, w, y0 - y1), i2 = o.v(q0[0], y1, q0[1], nx, 0, nz, 0, 0), i3 = o.v(q1[0], y1, q1[1], nx, 0, nz, w, 0);
    triN(o, i0, i1, i2, nx, 0, nz); triN(o, i1, i3, i2, nx, 0, nz);
  }
  for (const top of [1, 0]) {
    if (!(caps & (top ? 1 : 2))) continue;
    const y = top ? y1 : y0, k = top ? 1 : flare, ny = top ? 1 : -1, c = [corner(1, 1, k), corner(1, -1, k), corner(-1, -1, k), corner(-1, 1, k)];
    const i = c.map((q) => o.v(q[0], y, q[1], 0, ny, 0, 0, 0));
    triN(o, i[0], i[1], i[2], 0, ny, 0); triN(o, i[0], i[2], i[3], 0, ny, 0);
  }
}
/** A straight bar of square section w between two points. */
function bar(o, x0, y0, z0, x1, y1, z1, w) {
  let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0; const l = Math.hypot(dx, dy, dz);
  if (l < 0.05) return;
  dx /= l; dy /= l; dz /= l;
  // two axes across it
  let ux, uy, uz;
  if (Math.abs(dy) > 0.95) { ux = 1; uy = 0; uz = 0; } else { ux = -dz; uy = 0; uz = dx; const m = Math.hypot(ux, uz); ux /= m; uz /= m; }
  const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux, h = w / 2;
  o.need(16, 24);
  for (const [a, b, nx, ny, nz] of [[1, 1, ux, uy, uz], [-1, 1, -ux, -uy, -uz], [1, 0, vx, vy, vz], [-1, 0, -vx, -vy, -vz]]) {
    // the face on the +/- u side (b = 1) or the +/- v side (b = 0)
    const fx = b ? ux : vx, fy = b ? uy : vy, fz = b ? uz : vz, gx = b ? vx : ux, gy = b ? vy : uy, gz = b ? vz : uz;
    const cx = fx * h * a, cy = fy * h * a, cz = fz * h * a;
    const i0 = o.v(x0 + cx - gx * h, y0 + cy - gy * h, z0 + cz - gz * h, nx, ny, nz, 0, 0), i1 = o.v(x0 + cx + gx * h, y0 + cy + gy * h, z0 + cz + gz * h, nx, ny, nz, w, 0);
    const i2 = o.v(x1 + cx - gx * h, y1 + cy - gy * h, z1 + cz - gz * h, nx, ny, nz, 0, l), i3 = o.v(x1 + cx + gx * h, y1 + cy + gy * h, z1 + cz + gz * h, nx, ny, nz, w, l);
    triN(o, i0, i1, i2, nx, ny, nz); triN(o, i1, i3, i2, nx, ny, nz);
  }
}

function hash2(x, z) { let h = (Math.round(x * 3) * 0x9e3779b1) ^ (Math.round(z * 3) * 0x85ebca6b); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; }
const CONCRETE = [0.50, 0.49, 0.46], ASPHALT = [0.115, 0.115, 0.12], BALLAST = [0.27, 0.25, 0.23], WALK = [0.42, 0.41, 0.38];
const STEEL = [[0.13, 0.19, 0.16], [0.17, 0.11, 0.085], [0.30, 0.32, 0.34], [0.11, 0.11, 0.115], [0.20, 0.27, 0.33], [0.33, 0.20, 0.13]];

/** Position along a chain at distance s: [x, z, tangent x, tangent z, deck height, ground]. */
function at(c, s) {
  const S = c.S, n = c.n; let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
  const d = S[hi] - S[lo] || 1, t = Math.min(1, Math.max(0, (s - S[lo]) / d));
  let tx = c.X[hi] - c.X[lo], tz = c.Z[hi] - c.Z[lo]; const l = Math.hypot(tx, tz) || 1;
  return [c.X[lo] + (c.X[hi] - c.X[lo]) * t, c.Z[lo] + (c.Z[hi] - c.Z[lo]) * t, tx / l, tz / l, c.h[lo] + (c.h[hi] - c.h[lo]) * t, Math.min(c.g[lo], c.g[hi]), lo];
}

/** Where a chain's piers stand (distances along it), what each span is, and the chain's form. */
function layout(c, hGroup = 0) {
  const n = c.n, D = DEPTH[c.kind];
  let hMax = 0, hSum = 0, wet = 0;
  for (let i = 0; i < n; i++) { const H = c.h[i] - D - c.g[i]; if (H > hMax) hMax = H; hSum += H; if (c.under[i] === U_RIVER || c.under[i] === U_WATER) wet++; }
  const hMean = hSum / n;
  c.hMax = hMax; hMax = Math.max(hMax, hGroup);
  // the form: a deck arch for a high road bridge, a through truss for a railroad over water, a girder otherwise
  c.form = c.kind === KIND_ROAD && c.rank < 3 && c.rank >= 1 && hMax >= 17 && c.L >= 110 ? 'arch' : c.kind === KIND_RAIL && wet && c.L >= 55 ? 'truss' : c.kind === KIND_PATH && c.hw >= 3 && hMax >= 9 && c.L >= 150 ? 'arch' : 'girder';
  c.main = null;
  if (c.lm && c.lm.form === 'arch' && hMax >= 12) c.form = 'arch';
  let span = c.kind === KIND_PATH ? Math.min(36, 20 + 0.6 * hMean) : Math.min(52, Math.max(22, 20 + 1.0 * hMean));
  if (c.form === 'arch') span = c.kind === KIND_PATH ? Math.min(40, Math.max(26, 2.2 * hMax)) : Math.min(88, Math.max(48, 2.3 * hMax));
  if (c.form === 'truss') span = 62;
  const N = Math.max(1, Math.round(c.L / span)), piers = [];
  // what must be kept clear on the ground: roads and tracks beneath
  const keep = [];
  for (let i = 0; i < n; i++) if (c.under[i] === U_ROAD || c.under[i] === U_RAIL || c.under[i] === U_PATH) keep.push([c.S[i], c.uhw[i] + (c.under[i] === U_RAIL ? 2.2 : 1.6)]);
  if (c.lm && c.lm.span) {
    // a main span of known length, the rest of the crossing in ordinary spans either side of it
    const half = Math.min(c.lm.span, c.L - 8) / 2, mid = Math.min(c.L - half - 4, Math.max(half + 4, c.lm.s)), s0 = mid - half, s1 = mid + half;
    c.form = 'girder'; c.main = [s0, s1];
    const nA = Math.max(1, Math.round(s0 / span)), nB = Math.max(1, Math.round((c.L - s1) / span));
    for (let k = 1; k < nA; k++) piers.push((k / nA) * s0);
    if (s0 > 6) piers.push(s0); if (s1 < c.L - 6) piers.push(s1);
    for (let k = 1; k < nB; k++) piers.push(s1 + (k / nB) * (c.L - s1));
  } else for (let k = 1; k < N; k++) {
    let s = (k / N) * c.L, ok = true;
    for (let pass = 0; pass < 3; pass++) for (const [ks, kw] of keep) if (Math.abs(s - ks) < kw) s = s < ks ? ks - kw - 0.1 : ks + kw + 0.1;
    for (const [ks, kw] of keep) if (Math.abs(s - ks) < kw - 0.01) ok = false;
    if (!ok || s < 5 || s > c.L - 5 || (piers.length && s - piers[piers.length - 1] < 7)) continue;
    piers.push(s);
  }
  c.piers = piers;
  const h = hash2(c.X[0], c.Z[0]);
  c.seed = Math.floor(h * 255);
  const g = 0.9 + 0.2 * hash2(c.Z[0], c.X[0]);
  c.conc = [CONCRETE[0] * g, CONCRETE[1] * g, CONCRETE[2] * g];
  c.steel = STEEL[Math.floor(h * STEEL.length) % STEEL.length];
  if (c.kind === KIND_RAIL) c.steel = h < 0.6 ? STEEL[3] : STEEL[1];
}

/**
 * Build the part of a plan that lies in tile 0,0. H: ground heights at plan.pts; detail: 0 near, 1 far.
 * o: an Out (world/citybuild.js) to lay the vertices in: quarter 0 takes the long crossings, quarter 1 the rest.
 * urban: the tile is built up (its road bridges have lamps; out in the country only the great ones do).
 * Returns { coll, shade, lamps, count } (see world/cities.js).
 */
export function buildBridges(plan, H, detail, o, urban = true) {
  const { chains, nodes, size } = plan, far = detail > 0;
  solveHeights(plan, H);
  const segs = [], piersC = [], shP = [], shA = [], shI = [], lamps = [];
  let count = 0, yMax = -Infinity;
  o.raw = true; o.central = false;
  const set = (kind, col, seed, y = 255, z = 0, w = 0) => { o.kind = kind; o.style = y; o.kz = z; o.kw = w; o.c = col; o.seed = seed; };
  // which chains lie beside a station, on which side (for decks that must meet instead of overlapping)
  const prio = (a, b) => a.hw !== b.hw ? a.hw > b.hw : a.L !== b.L ? a.L > b.L : a.X[0] !== b.X[0] ? a.X[0] < b.X[0] : a.Z[0] < b.Z[0];
  // every stretch of every chain, in a grid of 32 m cells
  const CELL = 32, cells = new Map(), ck = (ix, iz) => (ix + 2048) * 8192 + (iz + 2048);
  for (const b of chains) for (let i = 0; i < b.n - 1; i++) {
    const x0 = Math.floor(Math.min(b.X[i], b.X[i + 1]) / CELL), x1 = Math.floor(Math.max(b.X[i], b.X[i + 1]) / CELL), z0 = Math.floor(Math.min(b.Z[i], b.Z[i + 1]) / CELL), z1 = Math.floor(Math.max(b.Z[i], b.Z[i + 1]) / CELL);
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) { const k = ck(ix, iz); let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(b.id, i); }
  }
  const nb = chains.length, bBest = new Float64Array(nb), bD = new Float64Array(nb), bH = new Float64Array(nb), bDot = new Float64Array(nb), bStamp = new Int32Array(nb), touched = [];
  let stamp = 0;
  const beside = (c, x, z, rx, rz, h, out, sAt = 0) => {
    out[0] = -c.hw; out[1] = c.hw; out[2] = 0; out[3] = 0; out[4] = 0; out[5] = -1;       // left edge, right edge (m from the center line, signed), joined left, joined right, beside a wider deck, the other deck of the same crossing
    let eL = -Infinity, eR = Infinity;
    const reach = c.hw + 7 + 14;
    stamp++; touched.length = 0;
    for (let iz = Math.floor((z - reach) / CELL); iz <= Math.floor((z + reach) / CELL); iz++) for (let ix = Math.floor((x - reach) / CELL); ix <= Math.floor((x + reach) / CELL); ix++) {
      const l = cells.get(ck(ix, iz));
      if (!l) continue;
      for (let k = 0; k < l.length; k += 2) {
        const b = chains[l[k]], i = l[k + 1];
        const ax = b.X[i], az = b.Z[i], ex = b.X[i + 1] - ax, ez = b.Z[i + 1] - az, l2 = ex * ex + ez * ez || 1;
        const t = ((x - ax) * ex + (z - az) * ez) / l2;
        if (t < -0.02 || t > 1.02 || (b === c && Math.abs(b.S[i] - sAt) < 60)) continue;       // (a chain that doubles back runs beside itself: the two roadways of one crossing)
        const px = ax + ex * t - x, pz = az + ez * t - z, d = Math.hypot(px, pz), id = b.id;
        if (bStamp[id] !== stamp) { bStamp[id] = stamp; bBest[id] = Infinity; touched.push(id); }
        if (d < bBest[id]) { bBest[id] = d; bD[id] = px * rx + pz * rz; bH[id] = b.h[i] + (b.h[i + 1] - b.h[i]) * t; bDot[id] = Math.abs(ex * rz - ez * rx) / Math.sqrt(l2); }
      }
    }
    for (const id of touched) {
      const b = chains[id], best = bBest[id], bd = bD[id], bh = bH[id];
      const join = (c.kind === KIND_PATH) !== (b.kind === KIND_PATH) ? 6 : JOIN;       // (a sidewalk is mapped where people walk: well out from the road's center line on a wide bridge)
      if (bDot[id] < 0.9 || Math.abs(Math.abs(bd) - best) > 0.5) continue;
      if (b !== c && best <= c.hw + b.hw + 14 && Math.abs(bh - h) <= 5 && (out[5] < 0 || prio(b, chains[out[5]]))) { out[5] = b.id; out[6] = bh; out[7] = best <= c.hw + b.hw + join ? 1 : 0; out[8] = bd; }
      if (best > c.hw + b.hw + join || Math.abs(bh - h) > 1.6) continue;
      const side = bd >= 0 ? 1 : 0;
      out[2 + side] = 1;
      if (b !== c && prio(b, c)) { out[4] = 1; const e = Math.abs(bd) - b.hw - 0.03; if (side) eR = Math.min(eR, e); else eL = Math.max(eL, -e); }
    }
    // the wider deck keeps its width; the other is cut back (or carried out) to its edge
    if (eR < Infinity) out[1] = Math.max(eR, -c.hw);
    if (eL > -Infinity) out[0] = Math.min(eL, out[1]);
    return out;
  };

  // A narrow deck that runs along a wider one (the sidewalk of a road bridge, mapped as a line of its own) is part of
  // that structure: it takes that deck's height, easing back to its own where the two part.
  {
    const e = [0, 0, 0, 0, 0, 0, 0, 0];
    for (const c of chains) {
      if (c.box[0] > size + 400 || c.box[2] < -400 || c.box[1] > size + 400 || c.box[3] < -400) continue;
      const n = c.n, dh = new Float32Array(n).fill(NaN); let on = 0, id = -1; const votes = new Map();
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), tx = c.X[b] - c.X[a], tz = c.Z[b] - c.Z[a], l = Math.hypot(tx, tz) || 1;
        beside(c, c.X[i], c.Z[i], -tz / l, tx / l, c.h[i], e, c.S[i]);
        if (e[5] >= 0 && e[7] && chains[e[5]].hw > c.hw + 0.5) { dh[i] = e[6] - c.h[i]; on++; votes.set(e[5], (votes.get(e[5]) || 0) + 1); }
      }
      if (on < 0.6 * n) continue;
      // carry the offset out from the stretch that runs alongside, fading over 40 m
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (dh[i] === dh[i]) { out[i] = dh[i]; continue; }
        let best = Infinity, v = 0;
        for (let j = 0; j < n; j++) if (dh[j] === dh[j] && Math.abs(c.S[j] - c.S[i]) < best) { best = Math.abs(c.S[j] - c.S[i]); v = dh[j]; }
        out[i] = v * Math.max(0, 1 - best / 40);
      }
      for (let i = 0; i < n; i++) c.h[i] = Math.max(c.h[i] + out[i], c.g[i] + 0.25);
    }
  }
  for (const c of chains) { c.hGroup = 0; layout(c); }
  // Decks that run side by side for most of their length are one crossing: a narrow one beside a wider (a sidewalk
  // along a road bridge) stands on that one's piers; two alike (the roadways of a freeway) take the same form
  // and stand their piers in line.
  {
    const e = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const c of chains) {
      c.mate = null; c.rides = false;
      if (c.box[0] > size + 40 || c.box[2] < -40 || c.box[1] > size + 40 || c.box[3] < -40) continue;        // (nothing of it is built here)
      const seen = new Map(); let tot = 0, on = 0, off = 0, offN = 0;
      for (let i = 0; i < c.n; i += 2) {
        const a = Math.max(0, i - 1), b = Math.min(c.n - 1, i + 1), tx = c.X[b] - c.X[a], tz = c.Z[b] - c.Z[a], l = Math.hypot(tx, tz) || 1;
        beside(c, c.X[i], c.Z[i], -tz / l, tx / l, c.h[i], e, c.S[i]); tot++;
        if (e[5] >= 0) { seen.set(e[5], (seen.get(e[5]) || 0) + 1); off += e[8]; offN++; }
        if (e[4]) on++;
      }
      for (const [id, k] of seen) if (k >= 0.6 * tot && prio(chains[id], c)) c.mate = chains[id];
      c.rides = on >= 0.6 * tot; c.mateOff = offN ? off / offN : 0;
    }
    const lead = (c) => { let m = c.mate, guard = 0; while (m && m.mate && guard++ < 4) m = m.mate; return !m || c.rides || Math.abs(m.L / c.L - 1) > 0.25 ? null : m; };
    for (const c of chains) { const m = lead(c); if (m && c.hMax > (m.hGroup || m.hMax)) m.hGroup = c.hMax; }
    for (const c of chains) if (c.hGroup) layout(c, c.hGroup);
    for (const c of chains) { c.follows = false; c.extL = -c.hw; c.extR = c.hw; }
    for (const c of chains) {
      const m = lead(c);
      if (!m) continue;
      c.form = m.form; c.piers = m.piers.map((s) => (s / m.L) * c.L); c.follows = true; c.main = null;
      if (c.mate === m) { m.extL = Math.min(m.extL, -c.mateOff - c.hw); m.extR = Math.max(m.extR, -c.mateOff + c.hw); }       // (what a truss around both must span)
    }
  }
  const isLit = (c) => c.kind === KIND_ROAD && c.rank >= 1 && c.total >= 50 && (urban || c.total >= 400);
  /** The deck through a row of stations: surface, parapets, outer faces, underside. solid: an embankment instead, walled down to the ground. */
  const deck = (c, st, solid) => {
    const m = st.length, D = DEPTH[c.kind];
    const pw = far ? 0 : c.kind === KIND_ROAD ? 0.4 : c.kind === KIND_RAIL ? 0.3 : 0.12, ph = far ? 0 : c.kind === KIND_ROAD ? 0.85 : c.kind === KIND_RAIL ? 0.3 : 1.05;
    const s0 = st[0].s;
    const top = c.kind === KIND_ROAD ? S_ROAD : c.kind === KIND_RAIL ? S_RAIL : S_WALK, topCol = c.kind === KIND_ROAD ? ASPHALT : c.kind === KIND_RAIL ? BALLAST : WALK;
    const hwq = Math.min(255, Math.round((c.rw || c.hw) * 8)), lit = isLit(c) ? 1 : 0;
    const P = (q, d, y) => [q.x + q.rx * d, y, q.z + q.rz * d];
    const inL = (q) => q.L + (q.jL ? 0 : pw), inR = (q) => q.R - (q.jR ? 0 : pw);
    // the running surface
    set(top, topCol, c.seed, c.mark + (c.oneway ? 8 : 0), hwq, lit);
    ribbon(o, m, (k) => { const q = st[k], l = Math.min(inL(q), inR(q)), r = inR(q), a = P(q, l, q.h), b = P(q, r, q.h); o.v(a[0], a[1], a[2], 0, 1, 0, l, q.s - s0); o.v(b[0], b[1], b[2], 0, 1, 0, r, q.s - s0); return [0, 1, 0]; });
    for (const side of [-1, 1]) {
      const edge = (q) => (side < 0 ? q.L : q.R), joined = (q) => (side < 0 ? q.jL : q.jR), inner = (q) => (side < 0 ? Math.min(inL(q), inR(q)) : inR(q));
      const noPar = (k) => !!(joined(st[k]) || joined(st[k + 1]));
      if (!far) {
        // the parapet: its inner face and its top
        set(c.kind === KIND_PATH ? S_STEEL : S_CONC, c.kind === KIND_PATH ? [0.2, 0.21, 0.22] : c.conc, c.seed, 255, 0, lit);
        ribbon(o, m, (k) => { const q = st[k], a = P(q, inner(q), q.h), b = P(q, inner(q), q.h + ph); o.v(a[0], a[1], a[2], -side * q.nx, 0, -side * q.nz, q.s - s0, -ph); o.v(b[0], b[1], b[2], -side * q.nx, 0, -side * q.nz, q.s - s0, 0); return [-side * q.nx, 0, -side * q.nz]; }, noPar);
        ribbon(o, m, (k) => { const q = st[k], a = P(q, inner(q), q.h + ph), b = P(q, edge(q), q.h + ph); o.v(a[0], a[1], a[2], 0, 1, 0, q.s - s0, 0); o.v(b[0], b[1], b[2], 0, 1, 0, q.s - s0, 0); return [0, 1, 0]; }, noPar);
      }
      // the outer face, from the top of the parapet to the foot of the girders
      set(S_FASCIA, c.form === 'girder' && c.kind === KIND_RAIL ? c.steel : c.conc, c.seed, 255, c.kind === KIND_RAIL && c.form === 'girder' ? 1 : 0, lit);
      ribbon(o, m, (k) => { const q = st[k], up = joined(q) ? 0 : ph, a = P(q, edge(q), q.h + up), lo = solid ? q.g - 2.5 : q.h - D, b = P(q, edge(q), lo); o.v(a[0], a[1], a[2], side * q.nx, 0, side * q.nz, q.s - s0, up); o.v(b[0], b[1], b[2], side * q.nx, 0, side * q.nz, q.s - s0, solid ? 0 : -D); return [side * q.nx, 0, side * q.nz]; });
    }
    if (solid) { for (let k = 0; k < m - 1; k++) { const a = st[k], b = st[k + 1]; segs.push(a.x, a.z, a.h, b.x, b.z, b.h, Math.max(-a.L, a.R, -b.L, b.R) + 0.2, Math.max(a.h - a.g, b.h - b.g, 0) + 3, 1.1); } return; }      // (an embankment: nothing under it)
    set(S_SOFFIT, c.conc, c.seed, 60);
    ribbon(o, m, (k) => { const q = st[k], a = P(q, q.L, q.h - D), b = P(q, q.R, q.h - D); o.v(a[0], a[1], a[2], 0, -1, 0, q.L, q.s - s0); o.v(b[0], b[1], b[2], 0, -1, 0, q.R, q.s - s0); return [0, -1, 0]; });
    // for the flight model, and the shade on the ground beneath
    const above = c.form === 'truss' ? 11.5 : 1.1;
    for (let k = 0; k < m - 1; k++) { const a = st[k], b = st[k + 1]; segs.push(a.x, a.z, a.h, b.x, b.z, b.h, Math.max(-a.L, a.R, -b.L, b.R) + 0.2, D, above); if (a.h + above > yMax) yMax = a.h + above; if (b.h + above > yMax) yMax = b.h + above; }
    let prev = -1;
    for (let k = 0; k < m; k++) {
      const q = st[k], Hc = q.h - D - q.g;
      if (Hc < 1.6) { prev = -1; continue; }
      const w = Math.max(-q.L, q.R) + 0.6, base = shP.length / 3, mid = (q.L + q.R) / 2;
      for (const cast of [0, 1]) for (const sd of [-1, 1]) { shP.push(q.x + q.rx * (mid + sd * w), q.g + 0.35 + 0.1 * cast, q.z + q.rz * (mid + sd * w)); shA.push(sd, Hc, w, cast); }
      if (prev >= 0) shI.push(prev, prev + 1, base, prev + 1, base + 1, base, prev + 2, prev + 3, base + 2, prev + 3, base + 3, base + 2);
      prev = base;
    }
  };
  const inTile = (x, z) => x >= 0 && x < size && z >= 0 && z < size;
  for (let pass = 0; pass < 2; pass++) {
    o.quadrant(pass);
    for (const c of chains) {
      if ((c.total >= LONG ? 0 : 1) !== pass) continue;
      if (far && c.kind === KIND_PATH && c.total < 60) continue;
      const D = DEPTH[c.kind], n = c.n;
      let any = false;
      // ---- the deck: one run for each stretch of the chain that lies in this tile
      for (let i0 = 0; i0 < n - 1; i0++) {
        if (!c.own[i0]) continue;
        let i1 = i0; while (i1 < n - 1 && c.own[i1]) i1++;
        any = true;
        // every station of the run, with what lies beside it
        const all = [], e = [0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = i0; i <= i1; i++) {
          const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
          // the tangent bisects the stretches either side (the same in every tile: it comes from the whole chain)
          let ax = c.X[i] - c.X[a], az = c.Z[i] - c.Z[a], bx = c.X[b] - c.X[i], bz = c.Z[b] - c.Z[i];
          const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1; ax /= la; az /= la; bx /= lb; bz /= lb;
          if (i === 0) { ax = bx; az = bz; } if (i === n - 1) { bx = ax; bz = az; }
          let tx = ax + bx, tz = az + bz; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
          const mitre = Math.min(1.6, 1 / Math.max(0.3, tx * bx + tz * bz));
          const rx = -tz, rz = tx;
          beside(c, c.X[i], c.Z[i], rx, rz, c.h[i], e, c.S[i]);
          all.push({ i, x: c.X[i], z: c.Z[i], h: c.h[i], g: c.g[i], s: c.S[i], rx: rx * mitre, rz: rz * mitre, nx: rx, nz: rz, L: e[0], R: e[1], jL: e[2], jR: e[3] });
        }
        // keep the ones that shape it
        const st = [all[0]], tolH = far ? 0.5 : 0.1, tolV = far ? 0.35 : 0.08, maxGap = far ? 150 : 42;
        for (let k = 1; k < all.length - 1; k++) {
          const a = st[st.length - 1], q = all[k], b = all[k + 1];
          const ex = b.x - a.x, ez = b.z - a.z, l = Math.hypot(ex, ez) || 1, t = (q.s - a.s) / (b.s - a.s || 1);
          const off = Math.abs((q.x - a.x) * ez - (q.z - a.z) * ex) / l, dv = Math.abs(q.h - (a.h + (b.h - a.h) * t));
          const side = q.jL !== a.jL || q.jR !== a.jR || q.jL !== b.jL || q.jR !== b.jR || Math.abs(q.L - (a.L + (b.L - a.L) * t)) > 0.15 || Math.abs(q.R - (a.R + (b.R - a.R) * t)) > 0.15;
          if (off > tolH || dv > tolV || b.s - a.s > maxGap || side) st.push(q);
        }
        st.push(all[all.length - 1]);
        deck(c, st, false);
        i0 = i1;
      }
      if (any) count++;
      // ---- piers, with whatever springs from them
      const pierAt = [];
      for (const s of c.piers) pierAt.push(at(c, s));
      set(S_CONC, c.conc, c.seed, 110);
      for (let k = 0; k < c.piers.length; k++) {
        const q = pierAt[k], x = q[0], z = q[1];
        if (!inTile(x, z) || c.rides) continue;
        const yT = q[4] - D, Hp = yT - q[5];
        if (Hp < 1.2) continue;
        const W = 2 * c.hw, tall = Hp > 18, a = c.kind === KIND_PATH && c.hw < 3 ? 0.45 : W <= 6.5 ? Math.max(0.7, 0.3 * W) : (tall ? 0.3 : 0.36) * W;
        const b = c.form === 'arch' ? 1.6 + Hp / 50 : (c.kind === KIND_PATH && c.hw < 3 ? 0.35 : 0.6) + Hp / 45;
        const rx = -q[3], rz = q[2], flare = 1 + Math.min(0.35, Hp / 110);
        if (far) block(o, x, z, rx, rz, a, b, q[5] - 3, yT, flare);
        else {
          const cap = c.kind === KIND_PATH || c.form === 'arch' ? 0 : Math.min(1.3, Hp * 0.25);
          block(o, x, z, rx, rz, a, b, q[5] - 3, yT - cap, flare);
          if (cap) block(o, x, z, rx, rz, Math.min(c.hw - 0.3, a * 1.28), b + 0.25, yT - cap, yT, 0.86, 2);
        }
        piersC.push(x, z, rx, rz, Math.max(a, c.hw * 0.46) + 0.3, b + 0.5, yT);
      }
      // ---- abutments: a wall under each end that meets the land
      for (const e of [0, 1]) {
        const nd = nodes[e ? c.nB : c.nA], i = e ? n - 1 : 0, j = e ? n - 2 : 1;
        if (!nd.abut || c.rides || !inTile(c.X[i], c.Z[i]) || (i === 0 ? !c.own[0] : !c.own[n - 2])) continue;
        let tx = c.X[j] - c.X[i], tz = c.Z[j] - c.Z[i]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
        const lift = c.h[i] - Math.min(c.g[i], c.g[j]);
        if (lift < 1.0) continue;
        set(S_CONC, c.conc, c.seed, 150);
        block(o, c.X[i] + tx * 0.9, c.Z[i] + tz * 0.9, -tz, tx, c.hw + 0.25, 0.9, Math.min(c.g[i], c.g[j]) - 3, c.h[i] - 0.12, 1, 0);
        piersC.push(c.X[i] + tx * 0.9, c.Z[i] + tz * 0.9, -tz, tx, c.hw + 0.5, 1.2, c.h[i]);
        // Where the deck had to end above the land (the survey does not always show the embankment a bridge
        // lands on), an embankment carries the road down along the approach.
        if (nd.h - Math.max(nd.g, nd.apg[0]) < 0.9 || nd.ends[0][0] !== c.id) continue;
        let kEnd = AP, grade = 0.07;
        for (let k = 1; k <= AP; k++) if (nd.h - grade * 7 * k <= nd.apg[k - 1] + 0.3) { kEnd = k; break; }
        if (nd.h - grade * 7 * kEnd > nd.apg[kEnd - 1] + 0.3) grade = (nd.h - nd.apg[kEnd - 1]) / (7 * kEnd);
        const wide = nd.ends.length > 1 ? 1.7 : 1, R = [];
        for (let k = kEnd; k >= 0; k--) {
          const x = k ? nd.pts[2 * k - 2] : nd.x, z = k ? nd.pts[2 * k - 1] : nd.z, g = k ? nd.apg[k - 1] : nd.g;
          R.push({ x, z, g, h: Math.max(g + 0.06, nd.h - grade * 7 * k), s: 7 * (kEnd - k), L: -c.hw * wide, R: c.hw * wide, jL: 0, jR: 0 });
        }
        for (let k = 0; k < R.length; k++) {
          const a = R[Math.max(0, k - 1)], b = R[Math.min(R.length - 1, k + 1)], dx = b.x - a.x, dz = b.z - a.z, dl = Math.hypot(dx, dz) || 1;
          R[k].rx = R[k].nx = -dz / dl; R[k].rz = R[k].nz = dx / dl;
        }
        deck(c, R, true);
      }
      // ---- spans
      const stops = [0, ...c.piers, c.L];
      if (c.rides) { /* nothing of its own under it */ } else if (c.form === 'arch') {
        for (let k = 0; k < stops.length - 1; k++) {
          const sa = stops[k], sb = stops[k + 1], len = sb - sa, A = at(c, sa), B = at(c, sb), M = at(c, (sa + sb) / 2);
          const stone = c.kind === KIND_PATH;       // (an old masonry viaduct: round arches close together)
          if (!inTile(M[0], M[1]) || len < (stone ? 16 : 30)) continue;
          const yb = M[4] - D, clear = yb - Math.max(A[5], B[5], M[5]);
          if (clear < (stone ? 5 : 11)) continue;
          const rise = stone ? Math.min(0.45 * len, clear - 1.2) : Math.min(0.26 * len, clear - 3.5, 30), nSeg = far ? 6 : 12, rx = -M[3], rz = M[2];
          const ribs = far ? [[0, 0.62 * c.hw]] : [[-0.52 * c.hw, 0.55], [0.52 * c.hw, 0.55]], tk = 0.9 + len / 70;
          const sect = [];
          for (let j = 0; j <= nSeg; j++) { const t = j / nSeg, q = at(c, sa + len * t), u = 2 * t - 1; sect.push([q[0], q[1], q[4] - D - 0.35 - rise * u * u, q[4] - D, (sa + len * t)]); }
          for (const [off, hw] of ribs) {
            set(S_CONC, c.conc, c.seed, 90);
            for (const sd of [-1, 1]) ribbon(o, nSeg + 1, (j) => { const q = sect[j], x = q[0] + rx * (off + sd * hw), z = q[1] + rz * (off + sd * hw); o.v(x, q[2], z, sd * rx, 0, sd * rz, q[4], 0); o.v(x, q[2] - tk, z, sd * rx, 0, sd * rz, q[4], -tk); return [sd * rx, 0, sd * rz]; });
            set(S_SOFFIT, c.conc, c.seed, 60);
            ribbon(o, nSeg + 1, (j) => { const q = sect[j]; o.v(q[0] + rx * (off - hw), q[2] - tk, q[1] + rz * (off - hw), 0, -1, 0, -hw, q[4]); o.v(q[0] + rx * (off + hw), q[2] - tk, q[1] + rz * (off + hw), 0, -1, 0, hw, q[4]); return [0, -1, 0]; });
            if (!far) {
              set(S_CONC, c.conc, c.seed, 120);
              ribbon(o, nSeg + 1, (j) => { const q = sect[j]; o.v(q[0] + rx * (off - hw), q[2], q[1] + rz * (off - hw), 0, 1, 0, -hw, q[4]); o.v(q[0] + rx * (off + hw), q[2], q[1] + rz * (off + hw), 0, 1, 0, hw, q[4]); return [0, 1, 0]; });
              // the columns that carry the deck down to the rib
              for (let j = 1; j < nSeg; j++) { const q = sect[j]; if (q[3] - q[2] > 1.2) block(o, q[0] + rx * off, q[1] + rz * off, rx, rz, hw * 0.8, 0.4, q[2] - 0.1, q[3], 1, 0); }
            }
          }
        }
      } else if (c.form === 'truss') {
        set(S_STEEL, c.steel, c.seed, 255);
        for (let k = 0; k < stops.length - 1; k++) {
          const sa = stops[k], sb = stops[k + 1], len = sb - sa, A = at(c, sa), B = at(c, sb), M = at(c, (sa + sb) / 2);
          if (!inTile(M[0], M[1]) || len < 36) continue;
          // only over the water, and only where the line runs straight
          let wet = false; for (let i = 0; i < n; i++) if (c.S[i] >= sa && c.S[i] <= sb && (c.under[i] === U_RIVER || c.under[i] === U_WATER)) wet = true;
          const bow = Math.hypot(M[0] - (A[0] + B[0]) / 2, M[1] - (A[1] + B[1]) / 2);
          if (!wet || bow > 0.6 || c.follows) continue;        // (two tracks side by side cross in one truss: the leader's)
          const mid = (c.extL + c.extR) / 2, rx = -(B[1] - A[1]) / len, rz = (B[0] - A[0]) / len;
          truss(o, A[0] + rx * mid, A[4], A[1] + rz * mid, B[0] + rx * mid, B[4], B[1] + rz * mid, (c.extR - c.extL) / 2 + 0.35, Math.min(11, Math.max(7.5, len / 7)), far);
        }
      }
      // ---- the main span of a crossing known by name: an arch over the deck, or a lift span between its towers
      if (c.main && !c.follows && !c.rides) {
        const A = at(c, c.main[0]), B = at(c, c.main[1]), M = at(c, (c.main[0] + c.main[1]) / 2), len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        if (inTile(M[0], M[1])) {
          const rx = -(B[1] - A[1]) / len, rz = (B[0] - A[0]) / len, mid = (c.extL + c.extR) / 2, hw = (c.extR - c.extL) / 2 + 0.6, tall = c.lm.tall;
          const ax = A[0] + rx * mid, az = A[1] + rz * mid, bx = B[0] + rx * mid, bz = B[1] + rz * mid;
          set(S_STEEL, c.lm.col || c.steel, c.seed, 255);
          if (c.lm.form === 'lift') {
            truss(o, ax, A[4], az, bx, B[4], bz, hw, Math.min(13, len / 8), far);
            for (const [px, py, pz] of [[ax, A[4], az], [bx, B[4], bz]]) {
              for (const sd of [-1, 1]) bar(o, px + rx * sd * (hw + 1.6), py - 4, pz + rz * sd * (hw + 1.6), px + rx * sd * (hw + 1.6), py + tall, pz + rz * sd * (hw + 1.6), 2.4);
              for (const f of far ? [1] : [0.45, 0.72, 1]) bar(o, px - rx * (hw + 1.6), py + tall * f - 1, pz - rz * (hw + 1.6), px + rx * (hw + 1.6), py + tall * f - 1, pz + rz * (hw + 1.6), 1.6);
            }
            if (tall > 30) {
              // the span across the top, from tower to tower
              const y0 = A[4] + tall - 1, y1 = B[4] + tall - 1, nP = Math.max(4, Math.round(len / 12));
              for (const sd of [-1, 1]) { bar(o, ax + rx * sd * (hw + 1.6), y0, az + rz * sd * (hw + 1.6), bx + rx * sd * (hw + 1.6), y1, bz + rz * sd * (hw + 1.6), 1.4); bar(o, ax + rx * sd * (hw + 1.6), y0 - 6, az + rz * sd * (hw + 1.6), bx + rx * sd * (hw + 1.6), y1 - 6, bz + rz * sd * (hw + 1.6), 1.0); }
              if (!far) for (let k = 0; k <= nP; k++) for (const sd of [-1, 1]) { const t = k / nP, x = ax + (bx - ax) * t + rx * sd * (hw + 1.6), z = az + (bz - az) * t + rz * sd * (hw + 1.6), y = y0 + (y1 - y0) * t; bar(o, x, y - 6, z, x, y, z, 0.5); if (k < nP) { const t2 = (k + 1) / nP; bar(o, x, k & 1 ? y : y - 6, z, ax + (bx - ax) * t2 + rx * sd * (hw + 1.6), y0 + (y1 - y0) * t2 - (k & 1 ? 6 : 0), az + (bz - az) * t2 + rz * sd * (hw + 1.6), 0.4); } }
            }
          } else {
            // two ribs over the deck, hangers down to it, struts between the ribs where traffic clears them
            const nS = far ? 8 : 16, P = [];
            for (let k = 0; k <= nS; k++) { const t = k / nS, u = 2 * t - 1; P.push([ax + (bx - ax) * t, A[4] + (B[4] - A[4]) * t, az + (bz - az) * t, tall * (1 - u * u)]); }
            for (const sd of [-1, 1]) for (let k = 0; k < nS; k++) {
              const p = P[k], q = P[k + 1], ox = rx * sd * hw, oz = rz * sd * hw;
              bar(o, p[0] + ox, p[1] + p[3] - 0.4, p[2] + oz, q[0] + ox, q[1] + q[3] - 0.4, q[2] + oz, 1.5);
              if (k > 0 && (!far || !(k & 1))) bar(o, p[0] + ox, p[1], p[2] + oz, p[0] + ox, p[1] + p[3] - 0.4, p[2] + oz, far ? 0.5 : 0.3);
            }
            for (let k = 1; k < nS; k++) if (P[k][3] > 7.5 && (!far || !(k & 1))) bar(o, P[k][0] - rx * hw, P[k][1] + P[k][3] - 0.4, P[k][2] - rz * hw, P[k][0] + rx * hw, P[k][1] + P[k][3] - 0.4, P[k][2] + rz * hw, 0.7);
          }
          segs.push(ax, az, A[4], bx, bz, B[4], hw + 2.5, DEPTH[c.kind], tall + 1); if (Math.max(A[4], B[4]) + tall + 1 > yMax) yMax = Math.max(A[4], B[4]) + tall + 1;
        }
      }
      // ---- lamps along a road bridge
      if (isLit(c)) {
        const gap = 42, cnt = Math.floor((c.L - 10) / gap) + 1, s1 = (c.L - (cnt - 1) * gap) / 2;
        for (let k = 0; k < cnt && c.L > 24; k++) {
          const q = at(c, s1 + k * gap), side = c.oneway ? 1 : k & 1 ? 1 : -1, x = q[0] - q[3] * side * (c.hw - 0.2), z = q[1] + q[2] * side * (c.hw - 0.2);
          if (!inTile(q[0], q[1]) || !c.own[Math.min(q[6], n - 2)]) continue;
          lamps.push(x + q[3] * side * 1.6, q[4] + 9.2, z - q[2] * side * 1.6);
          if (!far) { set(S_STEEL, [0.3, 0.31, 0.32], c.seed, 255); bar(o, x, q[4], z, x, q[4] + 9.2, z, 0.22); bar(o, x, q[4] + 9.2, z, x + q[3] * side * 2.0, q[4] + 9.35, z - q[2] * side * 2.0, 0.16); }
        }
      }
    }
  }
  o.raw = false;
  o.flush();
  // a grid over the tile for the flight model's questions: which deck stretches and piers are near a point
  const G = 16, cell = size / G, lists = Array.from({ length: G * G }, () => []);
  const mark = (x0, z0, x1, z1, id) => { for (let j = Math.max(0, Math.floor(z0 / cell)); j <= Math.min(G - 1, Math.floor(z1 / cell)); j++) for (let i = Math.max(0, Math.floor(x0 / cell)); i <= Math.min(G - 1, Math.floor(x1 / cell)); i++) lists[j * G + i].push(id); };
  for (let k = 0; k < segs.length; k += 9) { const r = segs[k + 6] + 6; mark(Math.min(segs[k], segs[k + 3]) - r, Math.min(segs[k + 1], segs[k + 4]) - r, Math.max(segs[k], segs[k + 3]) + r, Math.max(segs[k + 1], segs[k + 4]) + r, k / 9); }
  const nSeg = segs.length / 9;
  for (let k = 0; k < piersC.length; k += 7) { const r = Math.max(piersC[k + 4], piersC[k + 5]) + 6; mark(piersC[k] - r, piersC[k + 1] - r, piersC[k] + r, piersC[k + 1] + r, nSeg + k / 7); }
  const start = new Uint32Array(G * G + 1); let tot = 0;
  for (let k = 0; k < G * G; k++) { start[k] = tot; tot += lists[k].length; } start[G * G] = tot;
  const ids = new Uint16Array(tot); for (let k = 0, a = 0; k < G * G; k++) for (const id of lists[k]) ids[a++] = id;
  return {
    count, coll: { segs: Float32Array.from(segs), piers: Float32Array.from(piersC), start, ids, G, yMax },
    shade: shI.length ? { pos: Float32Array.from(shP), a: Float32Array.from(shA), idx: shP.length / 3 > 65535 ? Uint32Array.from(shI) : Uint16Array.from(shI) } : null,
    lamps: Float32Array.from(lamps),
  };
}

/** A through truss between two points of a deck: two sides of half-spacing hw and height ht, braced across the top. */
function truss(o, x0, y0, z0, x1, y1, z1, hw, ht, far) {
  const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(4, 2 * Math.round(len / 15)), tx = (x1 - x0) / len, tz = (z1 - z0) / len, rx = -tz, rz = tx;
  const w = 0.5, pt = (k, side, up) => [x0 + (x1 - x0) * (k / n) + rx * side * hw, y0 + (y1 - y0) * (k / n) + (up ? ht : 0.2), z0 + (z1 - z0) * (k / n) + rz * side * hw];
  const B = (a, b, ww = w) => bar(o, a[0], a[1], a[2], b[0], b[1], b[2], ww);
  for (const side of [-1, 1]) {
    B(pt(1, side, 1), pt(n - 1, side, 1), 0.6);                         // top chord
    B(pt(0, side, 0), pt(1, side, 1), 0.6); B(pt(n, side, 0), pt(n - 1, side, 1), 0.6);     // end posts
    B(pt(0, side, 0), pt(n, side, 0), 0.6);                             // bottom chord
    for (let k = 1; k < n; k++) {
      if (far && k % 2 && k !== 1 && k !== n - 1) continue;
      B(pt(k, side, 0), pt(k, side, 1), 0.38);
      if (!far && k < n - 1) { if (k < n / 2) B(pt(k, side, 1), pt(k + 1, side, 0), 0.32); else B(pt(k, side, 0), pt(k + 1, side, 1), 0.32); }
    }
  }
  for (let k = 1; k < n; k++) { if (far && k % 2 === 0) continue; B(pt(k, -1, 1), pt(k, 1, 1), 0.34); }
}
