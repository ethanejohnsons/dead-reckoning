// Airport scenery: runway with painted markings, apron, hangars, edge lights,
// a rotating beacon and a windsock that answers to the real wind.
import * as THREE from 'three';
import { AIRPORTS } from './airports.js';

function runwayTexture(a) {
  const W = 128, H = 4096, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), paved = a.surface === 'paved';
  g.fillStyle = paved ? '#34363a' : '#7d6f5a'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 5000; i++) {
    const v = Math.random();
    g.fillStyle = paved ? `rgba(${v * 90},${v * 90},${v * 95},0.2)` : `rgba(${90 + v * 80},${80 + v * 70},${60 + v * 50},0.25)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 3, 6 + Math.random() * 40);
  }
  // Draw in metres: x across the runway, y along it from the far end (numbers[1]) to the near end.
  g.scale(W / a.width, H / a.len);
  const L = a.len, Wd = a.width;
  g.fillStyle = paved ? '#e8e6dc' : '#d9d2c0';
  if (paved) {
    g.fillRect(0.6, 0, 0.6, L); g.fillRect(Wd - 1.2, 0, 0.6, L);                 // edge lines
    for (let y = 120; y < L - 120; y += 60) g.fillRect(Wd / 2 - 0.45, y, 0.9, 30);   // centreline
    for (const y0 of [8, L - 38]) for (let k = 0; k < 8; k++) g.fillRect(3 + k * 3.05 + (k > 3 ? 1.5 : 0), y0, 1.8, 30); // piano keys
    for (const off of [300, 450]) for (const sx of [Wd / 2 - 8.5, Wd / 2 + 5]) { g.fillRect(sx, off, 3.5, 22); g.fillRect(sx, L - off - 22, 3.5, 22); }
  } else {
    g.fillRect(2, 6, Wd - 4, 3); g.fillRect(2, L - 9, Wd - 4, 3);
  }
  g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.save(); g.translate(Wd / 2, L - 54); g.scale(0.8, 1.25); g.fillText(a.numbers[0], 0, 0); g.restore();
  g.save(); g.translate(Wd / 2, 54); g.rotate(Math.PI); g.scale(0.8, 1.25); g.fillText(a.numbers[1], 0, 0); g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16;
  return t;
}

export class Airfields {
  constructor(scene) {
    this.group = new THREE.Group(); scene.add(this.group);
    this.socks = []; this.beacons = [];
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const wall = lam(0xb9b2a0), roof = lam(0x7a3b2a), roof2 = lam(0x4d5a66), apronM = lam(0x54565a), pole = lam(0x888888);
    const pm = (c) => new THREE.PointsMaterial({ color: c, size: 3, sizeAttenuation: false });
    this.lightMats = [pm(0xfff0b8), pm(0x40ff70), pm(0xff3828)];
    this.lightBase = this.lightMats.map((m) => m.color.clone());
    const points = (arr, mat, g) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
      g.add(new THREE.Points(geo, mat));
    };

    for (const a of AIRPORTS) {
      const g = new THREE.Group();
      g.position.set(a.x, a.elev, a.z);
      g.rotation.y = -(a.hdg * Math.PI) / 180;                 // local -Z points along the runway heading
      const off = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
      const rw = new THREE.Mesh(new THREE.PlaneGeometry(a.width, a.len), new THREE.MeshLambertMaterial({ map: runwayTexture(a), ...off }));
      rw.rotation.x = -Math.PI / 2; rw.position.y = 0.06; g.add(rw);

      // Apron and buildings to the right of the runway, mid-field.
      const ax = a.width / 2 + 95;
      const apron = new THREE.Mesh(new THREE.PlaneGeometry(120, 170), a.surface === 'paved' ? Object.assign(apronM.clone(), off) : Object.assign(lam(0x77705f), off));
      apron.rotation.x = -Math.PI / 2; apron.position.set(ax, 0.05, 0); g.add(apron);
      const tw = new THREE.Mesh(new THREE.PlaneGeometry(52, 18), apron.material);
      tw.rotation.x = -Math.PI / 2; tw.position.set(a.width / 2 + 24, 0.05, 0); g.add(tw);
      const box = (w, h, d, x, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, h / 2, z); g.add(b); return b; };
      box(34, 11, 30, ax + 30, -45, wall); box(36, 2.5, 32, ax + 30, -45, roof).position.y = 12;
      box(26, 9, 24, ax + 34, 5, wall); box(28, 2, 26, ax + 34, 5, roof2).position.y = 10;
      box(9, 7, 9, ax + 30, 52, wall);
      if (a.surface === 'paved') { box(6, 16, 6, ax - 10, 62, wall); box(9, 4, 9, ax - 10, 62, lam(0x29404a)).position.y = 18; }

      // Windsock
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 6), pole); sp.position.set(-a.width / 2 - 38, 3.5, a.len * 0.28); g.add(sp);
      const sockG = new THREE.ConeGeometry(0.75, 4.2, 8, 1, true); sockG.rotateX(Math.PI / 2); sockG.translate(0, 0, 2.1);
      const sock = new THREE.Mesh(sockG, new THREE.MeshLambertMaterial({ color: 0xff6a14, side: THREE.DoubleSide }));
      sock.position.set(-a.width / 2 - 38, 7, a.len * 0.28); sock.rotation.order = 'YXZ'; g.add(sock);
      this.socks.push({ sock, a });

      // Beacon on the tallest building
      const bc = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }));
      bc.position.set(ax + 30, 15, -45); g.add(bc); this.beacons.push(bc);

      // Edge and threshold lights, drawn as fixed-size points so they carry through murk.
      const n = Math.floor(a.len / 60) + 1, edge = [], green = [], red = [];
      for (let i = 0; i < n; i++) for (const sd of [-1, 1]) edge.push(sd * (a.width / 2 + 1.5), 0.6, -a.len / 2 + i * (a.len / (n - 1)));
      for (let k = 0; k < 8; k++) {
        const x = -a.width / 2 + (k + 0.5) * (a.width / 8);
        green.push(x, 0.6, a.len / 2 + 3); red.push(x, 0.6, -a.len / 2 - 3);
      }
      points(edge, this.lightMats[0], g); points(green, this.lightMats[1], g); points(red, this.lightMats[2], g);
      this.group.add(g);
    }
  }

  /** Swing windsocks to the wind; scale lights up at night and in murk so they read from afar. */
  update(time, weather, dark, camPos) {
    const w = { x: 0, z: 0 };
    for (const { sock, a } of this.socks) {
      if (Math.abs(a.x - camPos.x) > 8000 || Math.abs(a.z - camPos.z) > 8000) continue;
      weather.wind(a.x, a.z, a.elev + 7, a.elev, w);
      const sp = Math.hypot(w.x, w.z);
      // World yaw so the sock's +Z tail streams downwind, expressed in the airport's local frame.
      const yawWorld = Math.atan2(w.x, w.z);
      sock.rotation.y = yawWorld + (a.hdg * Math.PI) / 180 + Math.sin(time * 3 + a.x) * 0.08;
      sock.rotation.x = Math.max(0, 1.2 - sp / 7);             // droops in light wind
    }
    const on = (time % 2) < 0.25;
    for (const b of this.beacons) b.visible = on;
    // Lights burn brighter at night and in poor light.
    this.lightMats.forEach((m, i) => { m.color.copy(this.lightBase[i]).multiplyScalar(0.9 + dark * 3.5); m.size = 3 + dark * 1.5; });
  }
}
