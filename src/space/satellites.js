// Things already in orbit, to go and find: the space stations, Hubble, a navigation satellite, a weather
// satellite in geostationary orbit and a string of small ones.
//
// Each rides a circular orbit (position(t) below). The International Space Station's orbit is turned so that
// it passes over the launch site at the moment a flight starts, a little ahead of it: launch along its
// inclination and it is there to be chased. From far away a satellite is a point of light (hidden behind the
// Earth by the stand-in sphere's depth); within 60 km its model is drawn (space/satmodels.js).

import * as THREE from 'three';
import { RE, MU_E, D2R, earthAngle, sunDir, dot } from './frames.js';

const LIST = [
  { id: 'iss', name: 'ISS', kind: 'iss', alt: 420e3, inc: 51.64, over: 12 },             // over: degrees along its orbit past the launch site at t = 0
  { id: 'tiangong', name: 'Tiangong', kind: 'tiangong', alt: 390e3, inc: 41.47, node: 70, u0: 200 },
  { id: 'hubble', name: 'Hubble', kind: 'hubble', alt: 540e3, inc: 28.47, node: 150, u0: 40 },
  { id: 'starlink1', name: 'Starlink train', kind: 'starlink', alt: 550e3, inc: 53.05, node: 20, u0: 300, train: 7 },
  { id: 'gps', name: 'GPS', kind: 'gps', alt: 20180e3, inc: 55, node: 110, u0: 0 },
  { id: 'goes', name: 'GOES East', kind: 'comsat', alt: 35786e3, inc: 0, lon: -75.2 },
];
const RING = 180;

export class Satellites {
  constructor(cosmos, mods) {
    this.cosmos = cosmos; this.mods = mods;
    this.sats = []; this.target = null; this.ti = -1;
    const pos = new Float32Array(64 * 3);
    this.geo = new THREE.BufferGeometry(); this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
    this.points = new THREE.Points(this.geo, new THREE.PointsMaterial({ color: new THREE.Color(2.2, 2.2, 2.0), size: 3, sizeAttenuation: false, fog: false, toneMapped: false }));
    this.points.frustumCulled = false;
    cosmos.far.add(this.points);
    this.rings = new THREE.Group(); this.rings.visible = false; cosmos.far.add(this.rings);
    this.sun = [1, 0, 0];
  }

  /** Lay the orbits out for a flight starting now from a site. */
  reset(clock, site) {
    for (const s of this.sats) { if (s.model) s.model.root.parent?.remove(s.model.root); if (s.ring) { this.rings.remove(s.ring); s.ring.geometry.dispose(); } }
    this.sats.length = 0; this.target = null; this.ti = -1;
    const th0 = earthAngle(clock, 0);
    for (const d of LIST) {
      const a = RE + d.alt, n = Math.sqrt(MU_E / (a * a * a)), i = d.inc * D2R;
      let node = (d.node || 0) * D2R, u0 = (d.u0 || 0) * D2R;
      if (d.lon !== undefined) { node = 0; u0 = th0 + d.lon * D2R; }                // geostationary: over one longitude for good
      else if (d.over !== undefined && site) {
        // The plane that carries the satellite over the site, northbound.
        const ls = th0 + site.lon * D2R, sl = Math.sin(site.lat * D2R) / Math.sin(i);
        const us = Math.abs(sl) <= 1 ? Math.asin(sl) : Math.sign(sl) * Math.PI / 2;
        node = ls - Math.atan2(Math.cos(i) * Math.sin(us), Math.cos(us)); u0 = us + d.over * D2R;
      }
      const P = [Math.cos(node), Math.sin(node), 0], Q = [-Math.cos(i) * Math.sin(node), Math.cos(i) * Math.cos(node), Math.sin(i)];
      for (let k = 0; k < (d.train || 1); k++) {
        const s = { ...d, name: d.train ? `${d.name} ${k + 1}` : d.name, a, n, P, Q, u0: u0 - k * 0.6 * D2R, r: [0, 0, 0], v: [0, 0, 0], dist: 0, model: null, ring: null, lead: k === 0 };
        if (s.lead) {
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING * 3), 3)); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e12);
          s.ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: new THREE.Color(0.5, 0.42, 0.22), transparent: true, opacity: 0.55, fog: false, toneMapped: false }));
          s.ring.frustumCulled = false; this.rings.add(s.ring);
        }
        this.sats.push(s);
      }
    }
    this.update(clock, 0);
  }

  update(clock, t) {
    for (const s of this.sats) {
      const u = s.u0 + s.n * t, c = Math.cos(u), sn = Math.sin(u), vv = s.a * s.n;
      for (let k = 0; k < 3; k++) { s.r[k] = s.a * (c * s.P[k] + sn * s.Q[k]); s.v[k] = vv * (-sn * s.P[k] + c * s.Q[k]); }
    }
    sunDir(clock, t, this.sun);
  }

  /** The next one to aim for (N). */
  next() { const leads = this.sats.filter((s) => s.lead); this.ti = this.ti + 1 >= leads.length ? -1 : this.ti + 1; this.target = this.ti < 0 ? null : leads[this.ti]; }

  /** Put them in this frame's picture: points far off, models close by (pushed onto `near`, the list of things drawn up close). eye: the camera, ECI. */
  draw(eye, near, map) {
    const cs = this.cosmos, pos = this.geo.attributes.position.array;
    let n = 0;
    for (const s of this.sats) {
      const dx = s.r[0] - eye[0], dy = s.r[1] - eye[1], dz = s.r[2] - eye[2], d = Math.hypot(dx, dy, dz);
      s.dist = d;
      // In the Earth's shadow a satellite is not lit (on the map they all show).
      const along = dot(s.r, this.sun), lit = map || along > 0 || Math.sqrt(Math.max(dot(s.r, s.r) - along * along, 0)) > RE;
      if (d < 60000 && this.mods.satmodels) {
        if (!s.model) { try { s.model = this.mods.satmodels.buildSatellite(s.kind); } catch (e) { console.warn(e); s.model = { root: new THREE.Group(), failed: true }; } }
        const root = s.model.root;
        // +Y away from the Earth, -Z the way it is going.
        const up = new THREE.Vector3(s.r[0], s.r[2], -s.r[1]).normalize(), fw = new THREE.Vector3(s.v[0], s.v[2], -s.v[1]).normalize();
        const right = new THREE.Vector3().crossVectors(up, fw.clone().negate()).normalize();
        root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fw.clone().negate()));
        cs.place(root, s.r); root.updateMatrixWorld(true);
        near.push(root);
        if (!s.model.failed) continue;
      }
      if (!lit || n >= 64) continue;
      pos[n * 3] = dx; pos[n * 3 + 1] = dz; pos[n * 3 + 2] = -dy; n++;
    }
    this.geo.setDrawRange(0, n); this.geo.attributes.position.needsUpdate = true;
    this.points.material.size = map ? 5 : 3;
    // The orbits, on the map.
    this.rings.visible = map;
    if (map) {
      for (const s of this.sats) {
        if (!s.ring) continue;
        const p = s.ring.geometry.attributes.position.array;
        for (let i = 0; i < RING; i++) {
          const u = (i / RING) * 2 * Math.PI, c = Math.cos(u), sn = Math.sin(u);
          const x = s.a * (c * s.P[0] + sn * s.Q[0]) - eye[0], y = s.a * (c * s.P[1] + sn * s.Q[1]) - eye[1], z = s.a * (c * s.P[2] + sn * s.Q[2]) - eye[2];
          p[i * 3] = x; p[i * 3 + 1] = z; p[i * 3 + 2] = -y;
        }
        s.ring.geometry.attributes.position.needsUpdate = true;
        s.ring.material.opacity = s === this.target ? 0.95 : 0.4;
      }
    }
    // The target's distance is from the craft, not the camera: the mission sets that after (see Mission.hud).
  }
}
