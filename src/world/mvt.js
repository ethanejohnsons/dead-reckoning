// A minimal reader for Mapbox Vector Tiles (protocol buffers): it decodes only the layers asked for, and of each
// feature its type, its properties and its geometry as rings or lines in tile units (0..extent, x east, y south).
// No dependencies; used by the city, land cover and map workers (OpenFreeMap's tiles and Overture's), and from Node.
//
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

const td = new TextDecoder();

class Reader {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  varint() {
    const b = this.b; let p = this.p, r = 0, s = 0, c;
    do { c = b[p++]; if (s < 28) r |= (c & 127) << s; else r += (c & 127) * 2 ** s; s += 7; } while (c > 127 && s < 64);
    this.p = p; return s > 28 ? r : r >>> 0;
  }
  skip(wire) {
    if (wire === 0) { while (this.b[this.p++] > 127); }
    else if (wire === 1) this.p += 8;
    else if (wire === 2) { const n = this.varint(); this.p += n; }
    else if (wire === 5) this.p += 4;
    else throw new Error('bad wire type ' + wire);
  }
  sub() { const n = this.varint(), r = new Reader(this.b, this.p, this.p + n); this.p += n; return r; }
}

function readValue(r) {
  let v = null;
  const dv = new DataView(r.b.buffer, r.b.byteOffset);
  while (r.p < r.end) {
    const k = r.varint(), f = k >> 3, w = k & 7;
    if (f === 1) { const n = r.varint(); v = td.decode(r.b.subarray(r.p, r.p + n)); r.p += n; }
    else if (f === 2) { v = dv.getFloat32(r.p, true); r.p += 4; }
    else if (f === 3) { v = dv.getFloat64(r.p, true); r.p += 8; }
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) { const n = r.varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; }
    else if (f === 7) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}

/** Geometry commands -> a list of Int32Array rings/lines [x0, y0, x1, y1, ...] (a polygon ring is not closed by a repeated point). */
function readGeometry(r, type) {
  const out = [];
  let x = 0, y = 0, cur = null, n = 0;
  while (r.p < r.end) {
    const cmd = r.varint(), id = cmd & 7; let count = cmd >> 3;
    if (id === 1) {
      while (count-- > 0) {
        const dx = r.varint(), dy = r.varint();
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
        if (cur) out.push(cur.subarray(0, n));
        cur = new Int32Array(Math.max(16, 2 * ((r.end - r.p) / 2 + 2 | 0) > 4096 ? 4096 : 64)); n = 0;
        cur[n++] = x; cur[n++] = y;
      }
    } else if (id === 2) {
      if (n + 2 * count > cur.length) { const g = new Int32Array(Math.max(cur.length * 2, n + 2 * count)); g.set(cur.subarray(0, n)); cur = g; }
      while (count-- > 0) {
        const dx = r.varint(), dy = r.varint();
        x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
        cur[n++] = x; cur[n++] = y;
      }
    } else if (id === 7) { /* close: the ring is implicitly closed */ } else break;
  }
  if (cur && n >= (type === 1 ? 2 : 4)) out.push(cur.subarray(0, n));
  return out;
}

/**
 * Decode the wanted layers of a tile. buf: Uint8Array (already gunzipped). want: { layerName: true }.
 * Returns { layerName: { extent, features: [{ type (1 point, 2 line, 3 polygon), props, geom: [Int32Array] }] } }.
 */
export function decodeTile(buf, want) {
  const tile = new Reader(buf), out = {};
  while (tile.p < tile.end) {
    const k = tile.varint();
    if (k >> 3 !== 3) { tile.skip(k & 7); continue; }
    const L = tile.sub(), start = L.p;
    // first pass: the name (to skip layers nobody asked for), keys, values, extent
    let name = '', extent = 4096; const keys = [], values = [], feats = [];
    while (L.p < L.end) {
      const kk = L.varint(), f = kk >> 3;
      if (f === 1) { const n = L.varint(); name = td.decode(L.b.subarray(L.p, L.p + n)); L.p += n; if (!want[name]) break; }
      else if (f === 2) { const s = L.sub(); feats.push(s); }
      else if (f === 3) { const n = L.varint(); keys.push(td.decode(L.b.subarray(L.p, L.p + n))); L.p += n; }
      else if (f === 4) values.push(readValue(L.sub()));
      else if (f === 5) extent = L.varint();
      else L.skip(kk & 7);
    }
    if (!want[name]) continue;
    void start;
    const features = [];
    for (const F of feats) {
      let type = 0, tags = null, geom = null;
      while (F.p < F.end) {
        const kk = F.varint(), f = kk >> 3;
        if (f === 2) tags = F.sub();
        else if (f === 3) type = F.varint();
        else if (f === 4) geom = F.sub();
        else F.skip(kk & 7);
      }
      const props = {};
      if (tags) while (tags.p < tags.end) { const a = tags.varint(), b = tags.varint(); props[keys[a]] = values[b]; }
      features.push({ type, props, geom: geom ? readGeometry(geom, type) : [] });
    }
    out[name] = { extent, features };
  }
  return out;
}

/** Twice the signed area of a ring in tile units: positive for an outer ring (y down), negative for a hole. */
export function ringArea2(p) {
  let a = 0;
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a;
}
