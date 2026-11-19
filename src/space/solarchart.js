// The chart of the solar system: M in a starship. The view from space pulled far back, with the orbits drawn on it.
//
// It is the picture itself, not a diagram of it: the camera circles a point (the sun, the ship or the
// destination: Tab goes round them) from above the plane the planets move in, and everything is where it
// is, so drawing in close on Saturn shows Saturn. What the chart adds:
//   - each planet's orbit, and each moon's about its planet, as a line through where the world is now (the points come from
//     solar.js, sampled round one whole turn starting at this moment);
//   - a dot for each world and for the ship, since from here they are far smaller than a pixel;
//   - the course: a line from the ship to its destination;
//   - the ship's own path: where it goes if left alone, which is round the sun (voyage.js: with the world it is
//     at, or, out in the open, on whatever orbit its speed and place make). Drawn from its place and velocity
//     as the conic they fix: an ellipse, or the open arm of a hyperbola if it is going too fast to stay;
//   - names (plain HTML over the canvas). A click on one lays in a course for that world.
// The lines live in cosmos.js's `chart` scene, which is drawn without depth at any distance. Their points
// are worked out from the camera every frame in double precision, like everything else in the view from
// space, so the same lines hold from a low orbit out to the whole system on one screen.

import * as THREE from 'three';
import { OBLIQUITY } from '../world/celestial.js';
import { AU } from './solar.js';

const N = 360, PN = 240;
const CE = Math.cos(OBLIQUITY), SE = Math.sin(OBLIQUITY);
const POLE = new THREE.Vector3(0, CE, SE), ZERO = new THREE.Vector3();      // the north pole of the planets' plane, in the drawing axes
const FOV = 45, D2R = Math.PI / 180;
const v = new THREE.Vector3(), m4 = new THREE.Matrix4(), qi = new THREE.Quaternion();
// Which name gives way when two would lie on top of each other: the first listed stays.
const RANK = ['sun', 'neptune', 'uranus', 'saturn', 'jupiter', 'mars', 'earth', 'venus', 'mercury', 'moon'];
const short = (b) => b.name.replace(/^the /, '');

export class SolarChart {
  constructor(cosmos) {
    this.cosmos = cosmos; this.solar = cosmos.solar; this.voy = null; this.visible = false;
    this.focus = 'ship'; this.yaw = -1.1; this.pitch = 0.8; this.dist = 6 * AU;
    this.goal = this.dist;                     // the distance the wheel has asked for: the camera eases to it
    this.off = [0, 0, 0];                      // how far the camera's center still is from the thing it is going to (after Tab)
    this.group = new THREE.Group(); this.group.visible = false; cosmos.chart.add(this.group);
    const line = (n, loop, opacity) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e15);
      const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(1, 1, 1), transparent: true, opacity, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
      const o = loop ? new THREE.LineLoop(g, mat) : new THREE.Line(g, mat);
      o.frustumCulled = false; this.group.add(o);
      return o;
    };
    this.rings = this.solar.bodies.filter((b) => b.id !== 'sun').map((b) => ({ body: b, line: line(N, true, 0.8), path: null }));
    this.course = line(2, false, 0.9);
    this.path = line(PN + 1, false, 0.9);
    // A dot for every world, and one for the ship.
    const n = this.solar.bodies.length + 1, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e15);
    this.dots = new THREE.Points(g, new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    this.dots.frustumCulled = false; this.group.add(this.dots);
    this.box = document.createElement('div'); this.box.id = 'solLabels'; this.box.hidden = true;
    document.body.appendChild(this.box);
    this.labels = new Map();
    this.rank = [...RANK, ...this.solar.bodies.map((b) => b.id).filter((id) => !RANK.includes(id))];       // (the planets' moons last)
  }

  /** Open the chart for a flight (voyage.js): the orbits as they are at this moment, the camera where it shows the ship and where it is going. */
  open(voy) {
    this.voy = voy;
    const c = voy.craft, clock = voy.m.clock;
    for (const r of this.rings) r.path = this.solar.orbit(r.body, clock, c.t, N);
    this.focus = 'ship'; this.fit(); this.dist = this.goal; this.off[0] = this.off[1] = this.off[2] = 0;      // centered on the ship: you are here
    this.visible = true; this.group.visible = true; this.box.hidden = false;
  }
  close() {
    this.visible = false; this.group.visible = false; this.box.hidden = true;
    for (const el of this.labels.values()) el.hidden = true;
  }

  /** The point the camera circles (the axes of frames.js), and the world there, if it is one. */
  center() {
    const voy = this.voy, s = this.solar;
    if (this.focus === 'ship') return { r: voy.craft.r, body: null };
    if (this.focus === 'dest' && voy.dest) return { r: voy.dest.r, body: voy.dest };
    return { r: s.sun.r, body: s.sun };
  }
  /** Stand back far enough to see what the focus is for. */
  fit() {
    const voy = this.voy, s = this.solar.sun.r, c = voy.craft.r, d = voy.dest;
    const fromSun = (r) => Math.hypot(r[0] - s[0], r[1] - s[1], r[2] - s[2]);
    // Round the ship: far enough back to see where it is going (or, with no course, the sun it goes round).
    if (this.focus === 'ship') this.goal = Math.max(2.6 * (d ? Math.hypot(d.r[0] - c[0], d.r[1] - c[1], d.r[2] - c[2]) : fromSun(c)), 4.5 * Math.hypot(voy.rel[0], voy.rel[1], voy.rel[2]), 4e7);
    else if (this.focus === 'dest' && d) this.goal = 14 * d.R * (d.ring ? 1.6 : 1);
    else this.goal = 2.7 * Math.max(fromSun(c), d ? fromSun(d.r) : 0, 1.7 * AU);                                         // the sun, the ship and the destination, on one screen
  }
  /** Tab: the next thing to center on. */
  cycleFocus() {
    const order = this.voy.dest ? ['ship', 'dest', 'sun'] : ['ship', 'sun'];
    const was = this.center().r, from = [was[0] + this.off[0], was[1] + this.off[1], was[2] + this.off[2]];
    this.focus = order[(order.indexOf(this.focus) + 1) % order.length];
    const to = this.center().r;
    for (let k = 0; k < 3; k++) this.off[k] = from[k] - to[k];        // (the camera travels there; it does not jump)
    this.fit();
    return this.focus === 'ship' ? 'the ship' : this.focus === 'dest' ? this.voy.dest.name : 'the Sun';
  }
  /** The mouse, once a frame: turn by (dyaw, dpitch) radians, and ask for nearer or farther by a factor. The camera eases to what was asked over dt seconds. */
  drag(dyaw, dpitch, zoom, dt) {
    this.yaw += dyaw; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dpitch));
    const body = this.center().body;
    this.goal = Math.max(body ? body.R * 2.2 : 3000, Math.min(4e13, this.goal * zoom));
    const k = dt > 0 ? 1 - Math.exp(-dt * 9) : 0, ko = dt > 0 ? Math.exp(-dt * 4.5) : 1;
    this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.goal) - Math.log(this.dist)) * k);       // (by the order of magnitude: the chart spans eight of them)
    for (let i = 0; i < 3; i++) this.off[i] *= ko;
  }

  /** The chart camera's place (into eye, the axes of frames.js) and orientation (into quat, the drawing axes): the planets' plane level, its north up. */
  camera(eye, quat) {
    const C = this.center().r, F = [C[0] + this.off[0], C[1] + this.off[1], C[2] + this.off[2]], cp = Math.cos(this.pitch), x = cp * Math.cos(this.yaw), ye = cp * Math.sin(this.yaw), ze = Math.sin(this.pitch);
    const y = ye * CE - ze * SE, z = ye * SE + ze * CE;                 // from the planets' plane to the Earth's equator, which the axes are laid on
    eye[0] = F[0] + x * this.dist; eye[1] = F[1] + y * this.dist; eye[2] = F[2] + z * this.dist;
    m4.lookAt(v.set(x, z, -y), ZERO, POLE);
    quat.setFromRotationMatrix(m4);
    return FOV;
  }

  /** Once a frame while the chart shows, after the view from space has been set up (cosmos.begin). */
  update() {
    if (!this.visible) return;
    const voy = this.voy, cs = this.cosmos, cam = cs.cam, sol = this.solar, dest = voy.dest, ship = voy.craft.r;
    // The orbits: brighter for the destination's, fainter for the Moon's.
    for (const r of this.rings) {
      const p = r.path, pos = r.line.geometry.attributes.position.array;
      if (!p) { r.line.visible = false; continue; }
      const a = p.about.r, ox = a[0] - cam[0], oy = a[1] - cam[1], oz = a[2] - cam[2], q = p.pts;
      for (let k = 0; k < N; k++) { pos[k * 3] = q[k * 3] + ox; pos[k * 3 + 1] = q[k * 3 + 2] + oz; pos[k * 3 + 2] = -(q[k * 3 + 1] + oy); }
      r.line.geometry.attributes.position.needsUpdate = true;
      const on = r.body === dest, moon = r.body.id === 'moon' || !!r.body.orb;
      r.line.material.color.setRGB(0.22, 0.34, 0.5).multiplyScalar(on ? 2.6 : moon ? 0.7 : 1);
    }
    // The course.
    this.course.visible = !!dest;
    if (dest) {
      const pos = this.course.geometry.attributes.position.array;
      pos[0] = ship[0] - cam[0]; pos[1] = ship[2] - cam[2]; pos[2] = -(ship[1] - cam[1]);
      pos[3] = dest.r[0] - cam[0]; pos[4] = dest.r[2] - cam[2]; pos[5] = -(dest.r[1] - cam[1]);
      this.course.geometry.attributes.position.needsUpdate = true;
      this.course.material.color.setRGB(0.5, 1.5, 1.9).multiplyScalar(voy.ap ? 1.4 : 0.8);
    }
    // The ship's own path round the sun: the conic its place and velocity fix (p, u from the sun; h their cross product).
    {
      const tr = voy.trajectory(), p = tr.p, u = tr.u, mu = sol.sun.mu, s = sol.sun.r, pos = this.path.geometry.attributes.position.array;
      const h = [p[1] * u[2] - p[2] * u[1], p[2] * u[0] - p[0] * u[2], p[0] * u[1] - p[1] * u[0]], hl = Math.hypot(h[0], h[1], h[2]), pl = Math.hypot(p[0], p[1], p[2]);
      let n = 0;
      if (hl > 1 && pl > sol.sun.R) {
        // The eccentricity vector points at the nearest point of the orbit to the sun; q is a quarter turn on from it.
        const ev = [(u[1] * h[2] - u[2] * h[1]) / mu - p[0] / pl, (u[2] * h[0] - u[0] * h[2]) / mu - p[1] / pl, (u[0] * h[1] - u[1] * h[0]) / mu - p[2] / pl];
        const e = Math.hypot(ev[0], ev[1], ev[2]), l = (hl * hl) / mu, ex = e > 1e-6 ? [ev[0] / e, ev[1] / e, ev[2] / e] : [p[0] / pl, p[1] / pl, p[2] / pl];
        const q = [(h[1] * ex[2] - h[2] * ex[1]) / hl, (h[2] * ex[0] - h[0] * ex[2]) / hl, (h[0] * ex[1] - h[1] * ex[0]) / hl];
        // A closed orbit is drawn all the way round; an open one as far as 60 AU out on either arm.
        const far = 60 * AU, lim = e < 1e-6 ? Math.PI : Math.acos(Math.max(-1, Math.min(1, (l / far - 1) / e)));
        const th = e < 0.98 && l / (1 - e) < far ? Math.PI : Math.max(lim - 1e-3, 0.01);
        for (let k = 0; k <= PN; k++) {
          const a = -th + (2 * th * k) / PN, r = l / (1 + e * Math.cos(a)), ca = Math.cos(a) * r, sa = Math.sin(a) * r;
          const x = s[0] + ca * ex[0] + sa * q[0] - cam[0], y = s[1] + ca * ex[1] + sa * q[1] - cam[1], z = s[2] + ca * ex[2] + sa * q[2] - cam[2];
          pos[n * 3] = x; pos[n * 3 + 1] = z; pos[n * 3 + 2] = -y; n++;
        }
      }
      this.path.visible = n > 1; this.path.geometry.setDrawRange(0, n); this.path.geometry.attributes.position.needsUpdate = true;
      this.path.material.color.setRGB(0.75, 1.5, 0.55);
    }
    // The dots.
    const dp = this.dots.geometry.attributes.position.array, dc = this.dots.geometry.attributes.color.array;
    let n = 0;
    const dot = (r, cr, cg, cb) => { dp[n * 3] = r[0] - cam[0]; dp[n * 3 + 1] = r[2] - cam[2]; dp[n * 3 + 2] = -(r[1] - cam[1]); dc[n * 3] = cr; dc[n * 3 + 1] = cg; dc[n * 3 + 2] = cb; n++; };
    for (const b of sol.bodies) {
      if (b.px > 2.5 && b.id !== 'sun') continue;                       // (it shows as itself)
      const l = 0.2126 * b.color[0] + 0.7152 * b.color[1] + 0.0722 * b.color[2], k = 1.5 / l;
      dot(b.r, b.color[0] * k, b.color[1] * k, b.color[2] * k);
    }
    dot(ship, 3, 3, 3);
    this.dots.geometry.setDrawRange(0, n);
    this.dots.geometry.attributes.position.needsUpdate = true; this.dots.geometry.attributes.color.needsUpdate = true;
    this.label();
  }

  /** Lay the names over the picture: the ship's and the destination's always, the rest where there is room. */
  label() {
    const voy = this.voy, cs = this.cosmos, sol = this.solar, dest = voy.dest, w = innerWidth, h = innerHeight;
    const tY = Math.tan((FOV * D2R) / 2), tX = tY * cs.camera.aspect, placed = [], seen = new Set();
    qi.copy(cs.camera.quaternion).invert();
    const put = (key, r, text, cls, body, must) => {
      v.set(r[0] - cs.cam[0], r[2] - cs.cam[2], -(r[1] - cs.cam[1])).applyQuaternion(qi);
      if (v.z >= 0) return;
      const x = (v.x / (-v.z * tX) * 0.5 + 0.5) * w, y = (0.5 - v.y / (-v.z * tY) * 0.5) * h;
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
      if (!must) for (const p of placed) if (Math.abs(p[0] - x) < 64 && Math.abs(p[1] - y) < 15) return;
      if (body) placed.push([x, y]);                                    // (the ship's name hangs below its dot, out of the others' way)
      let el = this.labels.get(key);
      if (!el) {
        el = document.createElement('span'); this.box.appendChild(el); this.labels.set(key, el);
        if (body) { el.title = `Lay in a course for ${body.name}`; el.addEventListener('click', () => { if (this.visible) this.voy.setDest(body); }); }
      }
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.hidden = false; seen.add(key);
    };
    put('ship', voy.craft.r, 'Enterprise', 'ship', null, true);
    if (dest) put(dest.id, dest.r, short(dest), 'body dest', dest, true);
    for (const id of this.rank) { const b = sol.by[id]; if (b !== dest) put(id, b.r, short(b), 'body', b, false); }
    for (const [key, el] of this.labels) if (!seen.has(key)) el.hidden = true;
  }
}
