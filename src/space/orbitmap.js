// The orbit map: the view from space pulled far back, with the path ahead drawn on it.
//
// The path is the craft's free fall integrated forward (orbit.js predict), redrawn a few times a second: a
// closed orbit shows once around, an escape or a trip to the Moon as far as it goes in twelve days. The part
// of it inside the Moon's sphere of influence is drawn around the Moon where the Moon is now, in another
// color, as it would look to someone riding along with the Moon: a flyby shows as a bend around it and a
// capture as a loop. Labels (plain HTML over the canvas) mark the bodies, the craft, the high and low points
// of the orbit, the closest pass of the Moon, an impact, and the satellites.
//
// The map's camera circles a focus (the body being orbited, the craft, the Earth or the Moon: Tab cycles),
// north up; drag turns it and the wheel sets the distance.

import * as THREE from 'three';
import { RE, RM, MOON_A, moonPos, len } from './frames.js';
import { predict, makePath } from './orbit.js';

const SEG = 2400;
const miles = (m) => Math.round(m / 1609.344).toLocaleString('en-US');
const mA = [0, 0, 0], f = [0, 0, 0], v = new THREE.Vector3(), m4 = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);

export class OrbitMap {
  constructor(cosmos, mission) {
    this.cosmos = cosmos; this.mission = mission;
    this.path = makePath(SEG); this.pathT = 0; this.visible = false;
    const line = (n, loop, color, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
      const mat = new THREE.LineBasicMaterial({ color, vertexColors: true, transparent: opacity < 1, opacity, fog: false, toneMapped: false });
      const o = loop ? new THREE.LineLoop(g, mat) : new THREE.LineSegments(g, mat);
      o.frustumCulled = false; o.visible = false; cosmos.far.add(o);
      return o;
    };
    this.line = line(SEG * 2, false, new THREE.Color(1, 1, 1));
    this.moonRing = line(256, true, new THREE.Color(0.35, 0.35, 0.4), 0.6);
    // The transfer helper's plan: the path from its burn to the Moon.
    { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(700 * 3), 3)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
      this.planLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: new THREE.Color(0.5, 1.5, 0.6), transparent: true, opacity: 0.85, fog: false, toneMapped: false }));
      this.planLine.frustumCulled = false; this.planLine.visible = false; cosmos.far.add(this.planLine); }
    this.craft = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)),
      new THREE.PointsMaterial({ color: new THREE.Color(3, 3, 3), size: 7, sizeAttenuation: false, fog: false, toneMapped: false, depthTest: false }));
    this.craft.frustumCulled = false; this.craft.visible = false; cosmos.far.add(this.craft);
    this.box = document.createElement('div'); this.box.id = 'orbLabels'; this.box.hidden = true;
    document.body.appendChild(this.box);
    this.labels = new Map();
    this.marks = [];
  }

  setVisible(on) {
    this.visible = on; this.planLine.visible = false; this.line.visible = on; this.moonRing.visible = on; this.craft.visible = on; this.box.hidden = !on;
    this.pathT = 0;
  }

  /** The point the map's camera circles (ECI), into out. */
  focus(out) {
    const ms = this.mission, rk = ms.rk, c = ms.cam.focus, which = c === 'body' ? rk.body : c;
    if (which === 'moon') moonPos(ms.clock, rk.t, out);
    else if (which === 'craft') { out[0] = rk.r[0]; out[1] = rk.r[1]; out[2] = rk.r[2]; }
    else { out[0] = out[1] = out[2] = 0; }
    return which;
  }
  minDist() { const w = this.focus(f); return w === 'craft' ? 300 : w === 'moon' ? RM * 1.2 : RE * 1.15; }
  /** Pull back far enough to see the whole orbit around the focus. */
  fit() {
    const ms = this.mission, rk = ms.rk, w = this.focus(f), o = rk.orbit(ms.clock);
    const R = w === 'moon' ? RM : RE;
    let d = w === 'craft' ? 3e6 : 3.6 * R;
    if (w !== 'craft' && o.body === w && isFinite(o.ap)) d = Math.max(d, 3.0 * (o.ap + R));
    if (w === 'earth' && (o.body === 'moon' || !isFinite(o.ap) || o.ap > 1e8)) d = MOON_A * 2.7;
    ms.cam.mapDist = Math.min(d, 2.5e9);
  }
  /** The map camera's place and orientation (drawing axes), into eye (ECI) and quat. */
  camera(eye, quat) {
    const c = this.mission.cam;
    this.focus(f);
    const cp = Math.cos(c.mapPitch), dx = cp * Math.cos(c.mapYaw), dy = cp * Math.sin(c.mapYaw), dz = Math.sin(c.mapPitch);
    eye[0] = f[0] + dx * c.mapDist; eye[1] = f[1] + dy * c.mapDist; eye[2] = f[2] + dz * c.mapDist;
    m4.lookAt(v.set(dx, dz, -dy), new THREE.Vector3(0, 0, 0), UP);
    quat.setFromRotationMatrix(m4);
  }

  /** Once a frame while the map shows, after the view from space has been set up (cosmos.begin). */
  update(dt) {
    if (!this.visible) return;
    const ms = this.mission, rk = ms.rk, cs = this.cosmos, cam = cs.cam, path = this.path;
    moonPos(ms.clock, rk.t, mA);
    if ((this.pathT -= dt) <= 0) {
      this.pathT = 0.25;
      if (rk.landed) path.n = 0; else predict(ms.clock, rk.t, rk.r, rk.v, path);
      this.findMarks();
    }
    // The path, as segments from each point to the next (broken where it passes from one body's frame to the other's).
    const pos = this.line.geometry.attributes.position.array, col = this.line.geometry.attributes.color.array, pts = path.pts;
    let k = 0;
    for (let i = 0; i + 1 < path.n && k < SEG * 2 - 2; i++) {
      const a = i * 5, b = a + 5;
      if (pts[a + 4] !== pts[b + 4]) continue;
      const onMoon = pts[a + 4] === 1, ox = onMoon ? mA[0] : 0, oy = onMoon ? mA[1] : 0, oz = onMoon ? mA[2] : 0;
      for (const o of [a, b]) {
        pos[k * 3] = pts[o] + ox - cam[0]; pos[k * 3 + 1] = pts[o + 2] + oz - cam[2]; pos[k * 3 + 2] = -(pts[o + 1] + oy - cam[1]);
        if (onMoon) { col[k * 3] = 1.6; col[k * 3 + 1] = 0.9; col[k * 3 + 2] = 0.3; } else { col[k * 3] = 0.35; col[k * 3 + 1] = 1.2; col[k * 3 + 2] = 1.7; }
        k++;
      }
    }
    this.line.geometry.setDrawRange(0, k);
    this.line.geometry.attributes.position.needsUpdate = true; this.line.geometry.attributes.color.needsUpdate = true;
    // The Moon's own orbit: a circle through where it is, in the plane it is moving in.
    const mp = this.moonRing.geometry.attributes.position.array, mB = moonPos(ms.clock, rk.t + 3 * 86400, [0, 0, 0]);
    const ux = mA[0] / MOON_A, uy = mA[1] / MOON_A, uz = mA[2] / MOON_A, dp = (mB[0] * ux + mB[1] * uy + mB[2] * uz);
    let wx = mB[0] - dp * ux, wy = mB[1] - dp * uy, wz = mB[2] - dp * uz; const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl;
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * 2 * Math.PI, c = Math.cos(a) * MOON_A, s = Math.sin(a) * MOON_A;
      mp[i * 3] = c * ux + s * wx - cam[0]; mp[i * 3 + 1] = c * uz + s * wz - cam[2]; mp[i * 3 + 2] = -(c * uy + s * wy - cam[1]);
    }
    this.moonRing.geometry.attributes.position.needsUpdate = true;
    // The plan, while its burn is still ahead (afterward the craft's own path is the plan).
    const xf = ms.xfer, showPlan = !!xf && xf.n > 1 && xf.pts[3] > rk.t - 600;
    this.planLine.visible = showPlan;
    if (showPlan) {
      const pp = this.planLine.geometry.attributes.position.array;
      for (let i = 0; i < xf.n; i++) { pp[i * 3] = xf.pts[i * 4] - cam[0]; pp[i * 3 + 1] = xf.pts[i * 4 + 2] - cam[2]; pp[i * 3 + 2] = -(xf.pts[i * 4 + 1] - cam[1]); }
      this.planLine.geometry.setDrawRange(0, xf.n); this.planLine.geometry.attributes.position.needsUpdate = true;
    }
    const cp = this.craft.geometry.attributes.position.array;
    cp[0] = rk.r[0] - cam[0]; cp[1] = rk.r[2] - cam[2]; cp[2] = -(rk.r[1] - cam[1]);
    this.craft.geometry.attributes.position.needsUpdate = true;
    this.label();
  }

  /** The points of the path worth a label: highest and lowest around each body, the Moon's closest pass, an impact. */
  findMarks() {
    const path = this.path, pts = path.pts, marks = this.marks, ms = this.mission;
    marks.length = 0;
    if (path.n < 3) return;
    for (const body of [0, 1]) {
      const R = body ? RM : RE;
      let hi = -1, lo = -1, dh = -Infinity, dl = Infinity, first = -1, last = -1;
      for (let i = 0; i < path.n; i++) {
        if (pts[i * 5 + 4] !== body) continue;
        if (first < 0) first = i; last = i;
        const d = Math.hypot(pts[i * 5], pts[i * 5 + 1], pts[i * 5 + 2]);
        if (d > dh) { dh = d; hi = i; } if (d < dl) { dl = d; lo = i; }
      }
      if (first < 0) continue;
      // An end of the stretch is not a turning point unless the path really turns there.
      if (lo > first && lo < last) marks.push({ i: lo, body, text: `${body ? 'Low point' : 'Periapsis'} ${miles(dl - R)} mi`, cls: 'pe' });
      if (hi > first && hi < last) marks.push({ i: hi, body, text: `${body ? 'High point' : 'Apoapsis'} ${miles(dh - R)} mi`, cls: 'ap' });
    }
    if (path.impact) marks.push({ i: path.n - 1, body: pts[(path.n - 1) * 5 + 4], text: path.impact.body === 'moon' ? 'Impact' : 'Reentry', cls: 'hit' });
    void ms;
  }

  /** Lay the HTML labels over the picture. */
  label() {
    const ms = this.mission, rk = ms.rk, cs = this.cosmos, cam = cs.camera, pts = this.path.pts, seen = new Set();
    cam.updateMatrixWorld(); const w = innerWidth, h = innerHeight;
    const E = cs.u.uEarthC.value, M = cs.u.uMoonC.value;
    const put = (key, x, y, z, text, cls, hideBehind = true) => {
      // x, y, z: ECI. Hidden when behind the camera, or behind the Earth or the Moon.
      v.set(x - cs.cam[0], z - cs.cam[2], -(y - cs.cam[1]));
      const dist = v.length();
      if (hideBehind) for (const [C, R] of [[E, RE], [M, RM]]) {
        const b = v.dot(C) / dist, k = C.lengthSq() - R * R, disc = b * b - k;
        if (b > 0 && disc > 0 && b - Math.sqrt(disc) < dist * 0.999) return;
      }
      v.project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return;
      let el = this.labels.get(key);
      if (!el) { el = document.createElement('span'); this.box.appendChild(el); this.labels.set(key, el); }
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((0.5 - v.y * 0.5) * h).toFixed(1)}px)`;
      el.hidden = false; seen.add(key);
    };
    put('earth', 0, 0, 0, 'Earth', 'body', false);
    put('moon', mA[0], mA[1], mA[2], 'Moon', 'body', false);
    put('craft', rk.r[0], rk.r[1], rk.r[2], rk.id === 'starship' ? 'Starship' : 'Saturn V', 'craft', false);
    for (let i = 0; i < this.marks.length; i++) {
      const m = this.marks[i], o = m.i * 5, k = m.body ? 1 : 0;
      put('m' + i, pts[o] + k * mA[0], pts[o + 1] + k * mA[1], pts[o + 2] + k * mA[2], m.text, 'mark ' + m.cls);
    }
    { const xf = ms.xfer; if (xf && xf.n > 1 && xf.pts[3] > rk.t) put('xburn', xf.pts[0], xf.pts[1], xf.pts[2], 'Transfer burn', 'mark plan'); }
    for (const s of ms.sats.sats) if (s.lead) put('s' + s.id, s.r[0], s.r[1], s.r[2], s.name, s === ms.sats.target ? 'sat on' : 'sat');
    for (const [key, el] of this.labels) if (!seen.has(key)) el.hidden = true;
  }
}
void len;
