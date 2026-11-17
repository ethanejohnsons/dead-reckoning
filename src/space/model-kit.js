// Building blocks shared by the space models (rockets, pads, satellites): surfaces of revolution with
// automatic creases, flat-shaded solids from corner lists, a batch for lattice beams, canvas-texture
// helpers and the small tiling "hardware" texture every engine uses. It builds on the aircraft's kit
// (aircraft/kit.js): every geometry made here carries position, normal, uv and color, so anything can be
// merged with anything and drawn with one material per finish.
//
// Azimuth convention used by every model here: a = 0 is +X (east), a = 90 degrees is -Z (north), so angles
// run counterclockwise seen from above and a texture wrapped with u = a / 360 reads the right way round
// from outside.

import * as THREE from 'three';
import { prim, merge, rod, canvas, tex, normalFromHeight, BLANK, lin, lerp, clamp01, sstep, pchip, loftGrid } from '../aircraft/kit.js';

export { prim, merge, rod, canvas, tex, normalFromHeight, BLANK, lin, lerp, clamp01, sstep, pchip, loftGrid };
export const TAU = Math.PI * 2, D2R = Math.PI / 180;
export const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/** Point at radius r, azimuth a (radians), height y. */
export const polar = (r, a, y = 0) => [r * Math.cos(a), y, -r * Math.sin(a)];

/** Bell contour: 0..1 along the length to 0..1 of the radius gained; `a` is the slope left at the exit (1 = a cone). */
export const bell = (s, a = 0.5) => a * s + (1 - a) * (2 * s - s * s);

/**
 * Surface of revolution about +Y. profile: [[r, y], ...] listed with the outside on its right (bottom to
 * top for an outer wall, top to bottom for an inner one). Joints sharper than `crease` degrees stay hard.
 * o.uv(u, y, r, k) gives the texture coordinate (u = azimuth / 360), o.rgb a color or (a, y, r) => color,
 * o.a0/o.a1 an arc in radians, o.seg the number of facets around.
 */
export function revolve(profile, o = {}) {
  const seg = o.seg || 48, a0 = o.a0 || 0, a1 = o.a1 ?? TAU, n = profile.length - 1;
  const rgbf = typeof o.rgb === 'function' ? o.rgb : null, rgb = o.rgb || [1, 1, 1], uvf = o.uv || null;
  const cr = Math.cos((o.crease ?? 28) * D2R);
  const sn = [];
  for (let k = 0; k < n; k++) {
    const dr = profile[k + 1][0] - profile[k][0], dy = profile[k + 1][1] - profile[k][1], l = Math.hypot(dr, dy) || 1;
    sn.push([dy / l, -dr / l]);
  }
  const join = (k) => {                          // normal shared by segments k-1 and k, or null at a crease
    if (k <= 0 || k >= n) return null;
    const a = sn[k - 1], b = sn[k];
    if (a[0] * b[0] + a[1] * b[1] < cr) return null;
    const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  const pos = [], nor = [], uv = [], col = [];
  const cs = new Float64Array(seg + 1), sns = new Float64Array(seg + 1);
  for (let j = 0; j <= seg; j++) { const a = a0 + ((a1 - a0) * j) / seg; cs[j] = Math.cos(a); sns[j] = Math.sin(a); }
  const put = (k, j, nn) => {
    const p = profile[k], a = a0 + ((a1 - a0) * j) / seg;
    pos.push(p[0] * cs[j], p[1], -p[0] * sns[j]);
    nor.push(nn[0] * cs[j], nn[1], -nn[0] * sns[j]);
    const t = uvf ? uvf(a / TAU, p[1], p[0], k) : BLANK; uv.push(t[0], t[1]);
    const c = rgbf ? rgbf(a, p[1], p[0]) : rgb; col.push(c[0], c[1], c[2]);
  };
  for (let k = 0; k < n; k++) {
    const n0 = join(k) || sn[k], n1 = join(k + 1) || sn[k];
    const r0 = profile[k][0], r1 = profile[k + 1][0];
    for (let j = 0; j < seg; j++) {
      if (r0 > 1e-6) { put(k, j, n0); put(k, j + 1, n0); put(k + 1, j, n1); }
      if (r1 > 1e-6) { put(k, j + 1, n0); put(k + 1, j + 1, n1); put(k + 1, j, n1); }
    }
  }
  return finish(pos, nor, uv, col);
}

function finish(pos, nor, uv, col) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Flat-shaded polygons: faces = [[p0, p1, p2, ...], ...] (convex, counterclockwise seen from outside). */
export function facets(faces, rgb = [1, 1, 1], o = {}) {
  const pos = [], nor = [], uv = [], col = [];
  for (const f of faces) {
    const c = f.rgb || rgb, pts = f.pts || f, a = pts[0];
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; nx += (p[1] - q[1]) * (p[2] + q[2]); ny += (p[2] - q[2]) * (p[0] + q[0]); nz += (p[0] - q[0]) * (p[1] + q[1]); }
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    for (let i = 1; i < pts.length - 1; i++) for (const p of [a, pts[i], pts[i + 1]]) {
      pos.push(p[0], p[1], p[2]); nor.push(nx, ny, nz); col.push(c[0], c[1], c[2]);
      const t = o.uv ? o.uv(p) : BLANK; uv.push(t[0], t[1]);
    }
  }
  return finish(pos, nor, uv, col);
}

/** A solid from eight corners: the bottom face b0..b3 counterclockwise seen from below... or any twisted box:
 *  c = [four corners of one end, the matching four of the other end], both listed the same way round. */
export function hexa(c, rgb, o) {
  const [a, b, d, e, f, g, h, i] = c;
  const faces = [[a, e, d, b], [f, g, h, i], [a, b, g, f], [b, d, h, g], [d, e, i, h], [e, a, f, i]];
  const geo = facets(faces, rgb, o);
  // orient every face away from the centroid
  const pos = geo.attributes.position, nor = geo.attributes.normal, m = [0, 0, 0];
  for (const p of c) { m[0] += p[0] / 8; m[1] += p[1] / 8; m[2] += p[2] / 8; }
  for (let t = 0; t < pos.count; t += 3) {
    const d0 = (pos.getX(t) - m[0]) * nor.getX(t) + (pos.getY(t) - m[1]) * nor.getY(t) + (pos.getZ(t) - m[2]) * nor.getZ(t);
    if (d0 < 0) {
      for (const at of [pos, geo.attributes.uv, geo.attributes.color]) { const s = at.itemSize, A = at.array; for (let q = 0; q < s; q++) { const x = A[(t + 1) * s + q]; A[(t + 1) * s + q] = A[(t + 2) * s + q]; A[(t + 2) * s + q] = x; } }
      for (let q = 0; q < 3; q++) nor.setXYZ(t + q, -nor.getX(t + q), -nor.getY(t + q), -nor.getZ(t + q));
    }
  }
  return geo;
}

/** A box of size (sx, sy, sz) centered at pos, turned by rot (Euler XYZ). */
export const box = (sx, sy, sz, pos, rgb, rot) => prim(new THREE.BoxGeometry(sx, sy, sz), { pos, rgb, rot });
/** A capped cylinder along +Y, centered at pos. */
export const cyl = (r0, r1, h, pos, rgb, seg = 16, rot, open = false) => prim(new THREE.CylinderGeometry(r1, r0, h, seg, 1, open), { pos, rgb, rot });
export const ball = (r, pos, rgb, seg = 16, scale) => prim(new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)), { pos, rgb, scale });
/** Turn a geometry built at azimuth 0 (+X) to azimuth a (radians). */
export const atAz = (g, a) => g.rotateY(a);

/**
 * Many straight members in one geometry: lattice towers, trusses, railings. add() pushes a prism of
 * rectangular section between two points; nothing is allocated per beam beyond the array growth.
 */
export class Beams {
  constructor() { this.p = []; this.n = []; this.c = []; }
  add(a, b, w, rgb, h = w, caps = false) {
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
    const l = Math.hypot(tx, ty, tz); if (l < 1e-6) return this;
    tx /= l; ty /= l; tz /= l;
    // u: horizontal and square to the beam (or +X for a vertical one), v completes the frame
    let ux = tz, uy = 0, uz = -tx, ul = Math.hypot(ux, uz);
    if (ul < 1e-4) { ux = 1; uz = 0; ul = 1; }
    ux /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const hw = w / 2, hh = h / 2, P = this.p, N = this.n, C = this.c;
    const corner = (e, su, sv) => [e[0] + ux * hw * su + vx * hh * sv, e[1] + uy * hw * su + vy * hh * sv, e[2] + uz * hw * su + vz * hh * sv];
    const quad = (p0, p1, p2, p3, nx, ny, nz) => {
      for (const p of [p0, p1, p2, p0, p2, p3]) { P.push(p[0], p[1], p[2]); N.push(nx, ny, nz); C.push(rgb[0], rgb[1], rgb[2]); }
    };
    const a00 = corner(a, -1, -1), a10 = corner(a, 1, -1), a11 = corner(a, 1, 1), a01 = corner(a, -1, 1);
    const b00 = corner(b, -1, -1), b10 = corner(b, 1, -1), b11 = corner(b, 1, 1), b01 = corner(b, -1, 1);
    quad(a10, b10, b11, a11, ux, uy, uz); quad(a01, b01, b00, a00, -ux, -uy, -uz);
    quad(a11, b11, b01, a01, vx, vy, vz); quad(a00, b00, b10, a10, -vx, -vy, -vz);
    if (caps) { quad(a00, a10, a11, a01, -tx, -ty, -tz); quad(b10, b00, b01, b11, tx, ty, tz); }
    return this;
  }
  /** Axis-aligned box. */
  box(cx, cy, cz, sx, sy, sz, rgb) { return this.add([cx, cy - sy / 2, cz], [cx, cy + sy / 2, cz], sx, rgb, sz, true); }
  get count() { return this.p.length / 3; }
  build() {
    const uv = new Float32Array((this.p.length / 3) * 2);
    for (let i = 0; i < uv.length; i += 2) { uv[i] = BLANK[0]; uv[i + 1] = BLANK[1]; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

/** Mesh from a list of geometries (merged), or null when the list is empty. */
export function meshOf(list, mat, cast = true, recv = true) {
  if (!list || !list.length) return null;
  const m = new THREE.Mesh(list.length === 1 ? (list[0].index ? list[0].toNonIndexed() : list[0]) : merge(list), mat);
  m.castShadow = cast; m.receiveShadow = recv;
  return m;
}

/** Canvas texture that tiles around the body (u) and clamps along it (v). */
export function wrapTex(c, srgb, repeatU = 1) {
  const t = tex(c, srgb);
  t.wrapS = THREE.RepeatWrapping; t.repeat.x = repeatU;
  return t;
}

/** Seeded random numbers in [0, 1). */
export function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Faint streaks and blotches of grime over a canvas region: vertical runs (rain, frost melt) and soft patches. */
export function weather(g, x, y, w, h, rnd, { streaks = 60, alpha = 0.05, dark = '20,22,26', light = '255,255,255' } = {}) {
  for (let i = 0; i < streaks; i++) {
    const sx = x + rnd() * w, sw = 1 + rnd() * 5, sy = y + rnd() * h * 0.8, sh = h * (0.08 + rnd() * 0.5);
    const gr = g.createLinearGradient(0, sy, 0, sy + sh), c = rnd() < 0.6 ? dark : light, a = alpha * (0.4 + rnd() * 0.6);
    gr.addColorStop(0, `rgba(${c},${a})`); gr.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gr; g.fillRect(sx, sy, sw, Math.min(sh, y + h - sy));
  }
}

/**
 * The tiling texture every piece of engine hardware shares. It repeats around (u) and is banded along v:
 * v 0..0.45 is a tube-wall nozzle (brazed coolant tubes with hat bands across them), v 0.5..0.8 plain
 * circumferential ribs, and the top strip is flat, which is where kit.BLANK points every untextured part.
 */
let HW = null;
export function hardwareTextures() {
  if (HW) return HW;
  const W = 128, H = 256, [Hc, gh] = canvas(W, H, '#808080'), [C, g] = canvas(W, H, '#ffffff');
  const Y = (v) => (1 - v) * H;
  // tube wall: eight tubes a tile
  for (let x = 0; x < W; x++) {
    const ph = ((x % 16) + 0.5) / 16, hgt = Math.sin(ph * Math.PI);
    gh.fillStyle = `rgb(${Math.round(70 + 150 * hgt)},0,0)`; gh.fillRect(x, Y(0.45), 1, Y(0) - Y(0.45));
    g.fillStyle = `rgb(${Math.round(190 + 65 * hgt)},${Math.round(188 + 65 * hgt)},${Math.round(184 + 65 * hgt)})`; g.fillRect(x, Y(0.45), 1, Y(0) - Y(0.45));
  }
  for (const v of [0.04, 0.115, 0.19, 0.265, 0.34, 0.415]) {           // hat bands
    gh.fillStyle = '#ff0000'; gh.fillRect(0, Y(v) - 2, W, 4);
    g.fillStyle = '#c9c6c0'; g.fillRect(0, Y(v) - 2, W, 4);
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, Y(v) + 2, W, 1.5);
  }
  for (let k = 0; k < 9; k++) {                                         // ribs
    const y = Y(0.52 + k * 0.03);
    const gr = gh.createLinearGradient(0, y - 3, 0, y + 3); gr.addColorStop(0, '#800000'); gr.addColorStop(0.5, '#ff0000'); gr.addColorStop(1, '#800000');
    gh.fillStyle = gr; gh.fillRect(0, y - 3, W, 6);
  }
  const normal = tex(normalFromHeight(Hc, 2.2), false), map = tex(C, true);
  for (const t of [normal, map]) { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; }
  // nozzle interior: emissive ramp from the throat (v = 0) to the lip (v = 1)
  const [G, gg] = canvas(4, 64);
  const gr = gg.createLinearGradient(0, 64, 0, 0);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.25, '#d8d8d8'); gr.addColorStop(0.7, '#8c8c8c'); gr.addColorStop(1, '#5a5a5a');
  gg.fillStyle = gr; gg.fillRect(0, 0, 4, 64);
  const glow = tex(G, true);
  HW = { normal, map, glow };
  return HW;
}

/** Emissive color of a firing nozzle's inner wall, by propellant (linear, before intensity). */
export const GLOW_RGB = { kerolox: [1.0, 0.42, 0.1], hydrolox: [1.0, 0.5, 0.28], methalox: [1.0, 0.45, 0.2], hypergolic: [1.0, 0.5, 0.22] };

/** Dispose every geometry, material and texture under root exactly once. */
export function disposeTree(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) {
      if (seen.has(m)) continue; seen.add(m);
      for (const k of Object.keys(m)) { const t = m[k]; if (t && t.isTexture && !seen.has(t) && !(HW && (t === HW.normal || t === HW.map || t === HW.glow))) { seen.add(t); t.dispose(); } }
      m.dispose();
    }
  });
}

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
/**
 * A set of identical engines as instanced meshes (one per material), each able to swivel about its own
 * gimbal point. parts = [[geometry, material], ...] with the gimbal at the geometry's origin.
 * mounts = [{ pos: [x, y, z], yaw (radians about +Y), gimbal: bool }].
 */
export function engineSet(parts, mounts) {
  const group = new THREE.Group(), meshes = [];
  for (const [geo, mat] of parts) {
    const im = new THREE.InstancedMesh(geo, mat, mounts.length);
    im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
    meshes.push(im); group.add(im);
  }
  const set = (gx, gz) => {
    mounts.forEach((mt, i) => {
      _e.set(mt.gimbal ? gx : 0, 0, mt.gimbal ? gz : 0, 'XZY');
      _q.setFromEuler(_e);
      if (mt.yaw) { if (!mt.q) mt.q = new THREE.Quaternion().setFromAxisAngle(_up, mt.yaw); _q.multiply(mt.q); }
      _p.set(mt.pos[0], mt.pos[1], mt.pos[2]); _s.setScalar(mt.scale || 1);
      _m.compose(_p, _q, _s);
      for (const im of meshes) im.setMatrixAt(i, _m);
    });
    for (const im of meshes) im.instanceMatrix.needsUpdate = true;
  };
  set(0, 0);
  let lx = 0, lz = 0;
  return { group, meshes, set: (gx, gz) => { if (Math.abs(gx - lx) > 1e-4 || Math.abs(gz - lz) > 1e-4) { lx = gx; lz = gz; set(gx, gz); } } };
}

/**
 * Wrap a finished stack in the vehicle interface (see vehicles.js).
 * o = { id, root, height, radius, stages, glow: [material per stage], extras: [{ object, withStage }],
 *       animate(dt, s) }. An extra is drawn while stage `withStage` is still attached.
 */
export function assembleVehicle(o) {
  const { root, stages } = o, extras = o.extras || [], glow = o.glow || [];
  const level = stages.map(() => 0);
  let current = 0;
  const vehicle = {
    id: o.id, root, height: o.height, radius: o.radius, stages, materials: o.materials || {},
    setStage(n) {
      current = n;
      stages.forEach((st, i) => { st.group.visible = i >= n; });
      for (const e of extras) e.object.visible = n <= e.withStage;
      if (o.onStage) o.onStage(n);
    },
    spent(n) {
      const c = stages[n].group.clone(true);
      c.visible = true;
      c.position.copy(root.position); c.quaternion.copy(root.quaternion); c.scale.copy(root.scale);
      for (const e of extras) if (e.withStage === n && e.spentWith) { const x = e.object.clone(true); x.visible = true; c.add(x); }
      return c;
    },
    /** Detached copy of a named extra (the Saturn V's escape tower), placed like spent(). */
    spentExtra(name) {
      const e = extras.find((x) => x.name === name); if (!e) return null;
      const c = new THREE.Group(), x = e.object.clone(true); x.visible = true; c.add(x);
      c.position.copy(root.position); c.quaternion.copy(root.quaternion); c.scale.copy(root.scale);
      return c;
    },
    /** Show or hide a named extra by hand (overrides setStage until the next setStage). */
    setExtra(name, on) { const e = extras.find((x) => x.name === name); if (e) e.object.visible = on; },
    update(dt, s) {
      const k = 1 - Math.exp(-dt * 6);
      for (let i = 0; i < stages.length; i++) {
        const want = s && i === (s.stage ?? current) ? Math.max(0, Math.min(1, s.throttle || 0)) : 0;
        level[i] += (want - level[i]) * (dt > 0 ? k : 1);
        if (glow[i]) glow[i].emissiveIntensity = GLOW_PEAK * level[i] * (0.9 + 0.1 * Math.sin((s?.time || 0) * 31 + i));
      }
      if (o.animate) o.animate(dt, s || {});
    },
    dispose() { disposeTree(root); },
  };
  return vehicle;
}
/** Emissive intensity of a nozzle's inner wall at full throttle (the game renders HDR: above 1 blooms). */
export const GLOW_PEAK = 7;
