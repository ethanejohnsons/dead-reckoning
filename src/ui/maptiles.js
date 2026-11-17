// The map's tiles of real map data (ui/maptiles.worker.js paints them): which are wanted for the view, fetched
// a few at a time nearest the middle first, kept for a while, and drawn under the map's own symbols. While a
// tile is on its way, the nearest coarser tile already here stands in for it.

import { worldX, worldZ, metersPerPixel } from '../world/geo.js';

export const MAP_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';
// KEEP: tiles held, at 1 MB each (512 x 512 RGBA): a full-screen map shows about 40 at a time
const MAXZ = 14, SIZE = 512, KEEP = 64, PARALLEL = 6, RETRY = 15000;

export class MapTiles {
  constructor() {
    this.tiles = new Map();                    // 'z/x/y' -> { bmp, labels, state: 'wait' | 'ok' | 'fail', at }
    this.want = [];                            // this frame's wanted tiles: [key, z, x, y, distance]
    this.busy = 0;
    this.ok = false;                           // a tile has come: the map has real data (else ui/chart.js draws its own cities)
    this.onLoad = null;
    this.worker = null;
  }

  /** The tile zoom for a view of `scale` CSS pixels per meter: one whose tiles show about 256 pixels across. */
  zoomFor(scale) { return Math.max(0, Math.min(MAXZ, Math.round(Math.log2(scale * metersPerPixel(0))))); }

  /** The world rectangle of a tile: [x0, z0, x1, z1]. */
  rect(z, x, y) { return [worldX(x * 256, z), worldZ(y * 256, z), worldX((x + 1) * 256, z), worldZ((y + 1) * 256, z)]; }

  /**
   * The tiles covering a world rectangle at zoom z: [{ z, x, y, t (the tile, or the coarser one standing in), sub
   * ([sx, sy, sw] of the stand-in's bitmap, in its pixels) }]. Asks for those that are missing.
   */
  cover(z, x0, z0, x1, z1, cx, cz) {
    const n = 2 ** z, tw = worldX(256, z) - worldX(0, z);
    const ix0 = Math.floor((x0 - worldX(0, z)) / tw), ix1 = Math.floor((x1 - worldX(0, z)) / tw);
    const iy0 = Math.max(0, Math.floor((z0 - worldZ(0, z)) / tw)), iy1 = Math.min(n - 1, Math.floor((z1 - worldZ(0, z)) / tw));
    const out = [];
    for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) {
      if (x < 0 || x >= n) continue;
      const key = `${z}/${x}/${y}`, t = this.tiles.get(key);
      if (t) { t.at = performance.now(); }
      if (t?.state === 'ok') { out.push({ z, x, y, t, sub: null }); continue; }
      if (!t || (t.state === 'fail' && performance.now() - t.failed > RETRY)) {
        const r = this.rect(z, x, y);
        this.want.push([key, z, x, y, Math.hypot((r[0] + r[2]) / 2 - cx, (r[1] + r[3]) / 2 - cz)]);
      }
      // a coarser tile that is here already, the part of it over this one
      for (let up = 1; up <= Math.min(z, 6); up++) {
        const pz = z - up, px = x >> up, py = y >> up, p = this.tiles.get(`${pz}/${px}/${py}`);
        if (p?.state !== 'ok') continue;
        p.at = performance.now();
        const f = SIZE / 2 ** up;
        out.push({ z, x, y, t: p, sub: [(x - (px << up)) * f, (y - (py << up)) * f, f] });
        break;
      }
    }
    return out;
  }

  /** Send for what the frame wanted (nearest the middle first), and forget what has not been seen for a while. */
  pump() {
    this.want.sort((a, b) => a[4] - b[4]);
    for (const [key, z, x, y] of this.want) {
      if (this.busy >= PARALLEL) break;
      const t = this.tiles.get(key);
      if (t && t.state !== 'fail') continue;
      this.start(key, z, x, y);
    }
    this.want.length = 0;
    if (this.tiles.size > KEEP) {
      const old = [...this.tiles].filter(([, t]) => t.state !== 'wait').sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < old.length && this.tiles.size > KEEP; i++) { old[i][1].bmp?.close?.(); this.tiles.delete(old[i][0]); }
    }
  }

  start(key, z, x, y) {
    if (!this.worker) {
      try { this.worker = new Worker(new URL('./maptiles.worker.js', import.meta.url), { type: 'module', name: 'map tiles' }); } catch (e) { console.warn('The map tiles are not available:', e.message); this.worker = false; }
      if (this.worker) this.worker.onmessage = (e) => this.done(e.data);
    }
    if (!this.worker) return;
    this.tiles.set(key, { state: 'wait', z, at: performance.now(), bmp: null, labels: null });
    this.busy++;
    this.worker.postMessage({ type: 'tile', key, z, x, y, size: SIZE });
  }

  done(m) {
    this.busy = Math.max(0, this.busy - 1);
    const t = this.tiles.get(m.key) || { at: performance.now() };
    if (m.type === 'tile') {
      Object.assign(t, { state: 'ok', bmp: m.bitmap, labels: m.labels });
      this.ok = true;
    } else {
      Object.assign(t, { state: 'fail', failed: performance.now() });
      console.warn('Map tile could not be loaded:', m.key, m.error);
    }
    this.tiles.set(m.key, t);
    this.onLoad?.();
  }
}
