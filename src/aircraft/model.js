// Procedural low-poly model of the Wayfarer: a high-wing, single-engine
// turboprop bush plane. Nose points down -Z; origin is the centre of gravity.
import * as THREE from 'three';

const CREAM = new THREE.Color(0.86, 0.82, 0.70), ORANGE = new THREE.Color(0.80, 0.22, 0.06),
  NAVY = new THREE.Color(0.05, 0.09, 0.20), GLASS = new THREE.Color(0.03, 0.06, 0.10), DARK = new THREE.Color(0.05, 0.05, 0.055);

export function buildAircraft() {
  const root = new THREE.Group();
  const body = new THREE.Group();            // hidden in cockpit view
  root.add(body);
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  const cream = lam(CREAM), orange = lam(ORANGE), navy = lam(NAVY), glass = lam(GLASS), dark = lam(DARK);
  const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };

  // Fuselage: lathe profile from tail (-y) to nose (+y), laid along Z.
  const prof = [[0.05, -5.9], [0.16, -5.6], [0.36, -4.0], [0.6, -2.2], [0.8, -0.5], [0.84, 1.0], [0.8, 2.2], [0.66, 3.3], [0.54, 4.3], [0.46, 4.85], [0.3, 4.95]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const fg = new THREE.LatheGeometry(prof, 18);
  fg.rotateX(-Math.PI / 2);
  const fp = fg.attributes.position, fc = new Float32Array(fp.count * 3);
  for (let i = 0; i < fp.count; i++) {
    let x = fp.getX(i), y = fp.getY(i) * 1.14, z = fp.getZ(i);
    const tail = Math.max(0, z - 0.5);
    y += tail * 0.11 - 0.12;                                   // tail boom sweeps up
    fp.setXYZ(i, x, y, z);
    const c = y < -0.45 - tail * 0.02 ? NAVY : (Math.abs(y + 0.18 - tail * 0.11) < 0.17 && z < 4.6) ? ORANGE : (z < -4.3 ? DARK : CREAM);
    fc[i * 3] = c.r; fc[i * 3 + 1] = c.g; fc[i * 3 + 2] = c.b;
  }
  fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  fg.computeVertexNormals();
  body.add(new THREE.Mesh(fg, new THREE.MeshLambertMaterial({ vertexColors: true })));

  // Glazing
  const ws = add(body, new THREE.BoxGeometry(1.22, 0.74, 0.06), glass, 0, 0.5, -1.92); ws.rotation.x = -0.95;
  for (const s of [-1, 1]) add(body, new THREE.BoxGeometry(0.06, 0.46, 2.5), glass, s * 0.8, 0.32, -0.15);

  // Wing with taper and a touch of dihedral
  const wg = new THREE.BoxGeometry(15.9, 0.2, 1.9, 8, 1, 1);
  const wp = wg.attributes.position;
  for (let i = 0; i < wp.count; i++) {
    const ax = Math.abs(wp.getX(i)) / 7.95;
    wp.setZ(i, wp.getZ(i) * (1 - 0.3 * ax) - 0.12 * ax);
    wp.setY(i, wp.getY(i) * (1 - 0.45 * ax) + ax * 0.26);
  }
  wg.computeVertexNormals();
  const wingY = 0.92, wingZ = -0.25;
  add(root, wg, cream, 0, wingY, wingZ);
  for (const s of [-1, 1]) {
    add(root, new THREE.BoxGeometry(0.9, 0.14, 1.36), orange, s * 7.5, wingY + 0.25, wingZ - 0.1);
    const st = add(root, new THREE.CylinderGeometry(0.05, 0.05, 3.25, 6), cream, s * 2.2, 0.05, wingZ);
    st.rotation.z = s * 1.08;
  }
  // Control surfaces hinge about X; meshes are offset aft of the hinge line.
  const surf = (w, chord, x, y, z, mat = cream) => {
    const g = new THREE.Group(); g.position.set(x, y, z);
    add(g, new THREE.BoxGeometry(w, 0.07, chord), mat, 0, 0, chord / 2);
    root.add(g); return g;
  };
  const parts = {
    ailL: surf(3.1, 0.42, -5.85, wingY + 0.2, wingZ + 0.62), ailR: surf(3.1, 0.42, 5.85, wingY + 0.2, wingZ + 0.62),
    flapL: surf(3.2, 0.5, -2.55, wingY + 0.06, wingZ + 0.8), flapR: surf(3.2, 0.5, 2.55, wingY + 0.06, wingZ + 0.8),
    elev: surf(5.4, 0.5, 0, 0.62, 5.65),
  };
  add(body, new THREE.BoxGeometry(5.4, 0.12, 1.15), cream, 0, 0.62, 5.1);
  // Fin and rudder
  const fin = new THREE.Shape([new THREE.Vector2(3.9, 0.45), new THREE.Vector2(5.3, 2.75), new THREE.Vector2(5.95, 2.75), new THREE.Vector2(5.8, 0.45)]);
  const fing = new THREE.ExtrudeGeometry(fin, { depth: 0.12, bevelEnabled: false });
  fing.translate(0, 0, -0.06); fing.rotateY(-Math.PI / 2);     // shape x -> +z
  add(body, fing, orange);
  const rud = new THREE.Group(); rud.position.set(0, 1.6, 5.85);
  add(rud, new THREE.BoxGeometry(0.09, 2.2, 0.55), cream, 0, 0, 0.27);
  root.add(rud); parts.rud = rud;

  // Landing gear
  const wheel = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 14); wheel.rotateZ(Math.PI / 2);
  for (const s of [-1, 1]) {
    add(root, wheel, dark, s * 1.7, -1.39, 0.3);
    const leg = add(root, new THREE.BoxGeometry(0.12, 1.35, 0.3), cream, s * 1.12, -0.95, 0.3); leg.rotation.z = s * 0.95;
  }
  const nw = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12); nw.rotateZ(Math.PI / 2);
  add(root, nw, dark, 0, -1.45, -3.1);
  add(root, new THREE.CylinderGeometry(0.06, 0.06, 0.95, 6), cream, 0, -0.95, -3.1);

  // Propeller: blades at low rpm, a translucent disc at speed
  const prop = new THREE.Group(); prop.position.set(0, -0.12, -5.0);
  const spin = new THREE.ConeGeometry(0.3, 0.7, 12); spin.rotateX(-Math.PI / 2);
  add(prop, spin, orange, 0, 0, -0.3);
  const blades = new THREE.Group(); prop.add(blades);
  for (let i = 0; i < 3; i++) {
    const b = add(blades, new THREE.BoxGeometry(0.2, 1.35, 0.05), dark, 0, 0, -0.18);
    b.geometry = b.geometry.clone(); b.geometry.translate(0, 0.72, 0); b.rotation.z = (i * Math.PI * 2) / 3;
  }
  const disc = add(prop, new THREE.CircleGeometry(1.42, 28), new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }), 0, 0, -0.18);
  root.add(prop);

  // Lights
  const bulb = (c, x, y, z) => add(root, new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: c }), x, y, z);
  parts.navL = bulb(0xff2010, -7.95, wingY + 0.27, wingZ); parts.navR = bulb(0x10ff40, 7.95, wingY + 0.27, wingZ);
  parts.strobe = bulb(0xffffff, 0, 2.85, 5.6); parts.beacon = bulb(0xff3020, 0, -0.95, 0.4);

  // Cockpit-view furniture: cowling, glareshield and windscreen posts, shown only from the pilot's seat.
  const pit = new THREE.Group(); pit.visible = false; root.add(pit);
  add(pit, new THREE.BoxGeometry(1.2, 0.5, 3.1), cream, 0, 0.02, -3.5);
  add(pit, new THREE.BoxGeometry(0.2, 0.52, 3.1), orange, 0, 0.03, -3.5);
  add(pit, new THREE.BoxGeometry(1.7, 0.16, 0.6), dark, 0, 0.3, -1.95);
  add(pit, new THREE.BoxGeometry(1.7, 1.2, 0.1), dark, 0, -0.34, -1.72);
  for (const s of [-1, 1]) { const post = add(pit, new THREE.BoxGeometry(0.07, 1.0, 0.07), dark, s * 0.72, 0.78, -1.72); post.rotation.x = 0.5; post.rotation.z = -s * 0.1; }
  add(pit, new THREE.BoxGeometry(1.5, 0.07, 0.07), dark, 0, 1.2, -1.48);

  Object.assign(parts, { prop, blades, disc, body, pit });
  return { root, parts };
}

/** Soft shadow sprite projected onto the ground beneath the aircraft. */
export function buildShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.filter = 'blur(5px)'; g.fillStyle = '#000';
  g.fillRect(8, 50, 112, 13);            // wing
  g.fillRect(58, 22, 12, 88);            // fuselage
  g.fillRect(44, 98, 40, 8);             // tailplane
  const t = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.MeshBasicMaterial({
    map: t, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: false,
  }));
  m.geometry.rotateX(-Math.PI / 2);
  m.renderOrder = 2;
  return m;
}

/** Drive moving parts from flight state each frame. */
export function animateAircraft(parts, ac, dt, time, night) {
  parts.ailL.rotation.x = ac.ail * 0.35; parts.ailR.rotation.x = -ac.ail * 0.35;
  parts.elev.rotation.x = -ac.elev * 0.4;
  parts.rud.rotation.y = ac.rud * 0.45;
  parts.flapL.rotation.x = parts.flapR.rotation.x = ac.flap * 0.6;
  const rpm = 0.25 + 0.75 * ac.thrustLevel;
  parts.prop.rotation.z -= dt * (ac.fuel > 0 ? 30 + 160 * ac.thrustLevel : Math.min(ac.tas, 40));
  parts.blades.visible = rpm < 0.5 || ac.fuel <= 0;
  parts.disc.visible = ac.fuel > 0;
  parts.disc.material.opacity = 0.1 + 0.16 * rpm;
  const blink = (time % 1.3) < 0.07, beacon = (time % 1.1) < 0.12;
  parts.strobe.visible = blink; parts.beacon.visible = beacon;
  parts.navL.scale.setScalar(1 + night * 1.2); parts.navR.scale.setScalar(1 + night * 1.2);
}
