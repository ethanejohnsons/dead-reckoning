// The Apollo Saturn V, built from the vehicle's own station numbers (inches along the stack, converted
// to meters above the F-1 exit plane): 110.6 m tall, 10.06 m across the first two stages, 6.6 m across
// the third. Every stage is a surface of revolution wearing one painted canvas (the black and white roll
// pattern, the red lettering, the flag) and a small tiling normal map that corrugates the skirts,
// intertank and interstages; fairings, fins, tunnels, domes and thrust structures are merged geometry
// in two vertex-colored finishes, and each stage's engines are one instanced set that can swivel.
//
// Stages: 0 S-IC (with the S-IC/S-II interstage ring, which really fell away half a minute later),
// 1 S-II (with the conical interstage it kept), 2 S-IVB (with the instrument unit and the closed
// adapter cone), 3 the Apollo spacecraft. The launch escape tower and the white boost cover over the
// command module are an "extra" that leaves with stage 0 (in flight it went half a minute after);
// vehicle.spentExtra('tower') gives it as its own piece to throw clear.

import * as THREE from 'three';
import {
  TAU, D2R, FONT, polar, bell, revolve, facets, box, cyl, ball, atAz, Beams, meshOf, wrapTex, rng, weather,
  hardwareTextures, GLOW_RGB, engineSet, assembleVehicle, prim, rod, canvas, normalFromHeight, BLANK, lin, lerp, loftGrid,
} from './model-kit.js';

const IN = 0.0254, st = (s) => (s + 115.5) * IN;      // vehicle station (inches) to meters above the F-1 exit plane
const R1 = 5.029, R3 = 3.302, RSM = 1.956;             // 396 in, 260 in, 154 in diameters
const Y = {
  heat: st(48.5), base: st(52), thrustTop: st(345), fuelTop: st(772), interTop: st(1034), loxTop: st(1401), s1Top: st(1541),
  s2Sep: st(1760), s2AftTop: st(1848), s2TankTop: st(2387), s2Top: st(2519),
  s4Base: st(2746.5), s4AftTop: st(2832), s4TankTop: st(3100), iuBase: st(3222.6), iuTop: st(3258.6),
  slaTop: st(3594.6), smTop: st(3749.5), top: st(4240.8),
};
const F1 = { gimbalY: st(100), ring: 4.623, exitR: 1.78, max: 6 * D2R };
const J2 = { len: 3.38, exitR: 0.98, ring: 2.667, max: 7 * D2R };
const S2_GIMBAL = 46.45, S4_GIMBAL = Y.s4Base - 1.1, SPS_EXIT = Y.slaTop - 2.8;

const WHITE = lin('#eceae4'), BLACK = lin('#17171a'), FOIL = [0.62, 0.62, 0.6], STEEL = [0.1, 0.095, 0.09], TUBE = [0.6, 0.57, 0.5];
const PRIMER = lin('#8b9160'), FOAM = lin('#d9d2bd'), DARK = [0.03, 0.03, 0.032];
const CSS = { white: '#edebe5', black: '#19191b', red: '#b4161f', ribbed: '#e4e2dc' };

// ---------------------------------------------------------------- painted skins

/**
 * One stage's canvases. The color map covers half the circumference (every marking repeats on the far
 * side) and the stage's height; the normal map is a strip 64 texels wide that tiles `tiles` times around.
 */
function skin(R, y0, y1, tiles, paint, relief, H = 2048) {
  const W = 1024, [C, g] = canvas(W, H, CSS.white);
  const X = (deg) => (deg / 180) * W, Yp = (y) => H - ((y - y0) / (y1 - y0)) * H;
  const pxm = [W / (Math.PI * R), H / (y1 - y0)];
  const api = {
    g, W, H, X, Y: Yp, pxm,
    band(ya, yb, css) { g.fillStyle = css; g.fillRect(0, Yp(yb), W, Yp(ya) - Yp(yb)); },
    panel(d0, d1, ya, yb, css) { g.fillStyle = css; g.fillRect(X(d0), Yp(yb), X(d1) - X(d0), Yp(ya) - Yp(yb)); },
    line(y, css = 'rgba(40,42,48,0.28)', w = 1.5) { g.fillStyle = css; g.fillRect(0, Yp(y) - w / 2, W, w); },
    /** Call fn with the canvas x of an azimuth, and again past the edge it wraps over. */
    at(deg, fn) { const x = X(((deg % 180) + 180) % 180); fn(x); if (x < 160) fn(x + W); if (x > W - 160) fn(x - W); },
    /** Letters stacked down the stage, the first one's top at yTop. */
    vtext(str, deg, yTop, h, pitch, css = CSS.red, wide = 1.12) {
      [...str].forEach((ch, i) => {
        if (ch === ' ') return;
        api.at(deg, (x) => {
          g.save(); g.translate(x, Yp(yTop - i * pitch - h / 2)); g.scale((pxm[0] / pxm[1]) * wide, 1);
          g.font = `bold ${(h * pxm[1]) / 0.716}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = css;
          g.fillText(ch, 0, h * pxm[1] * 0.03); g.restore();
        });
      });
    },
    flag(deg, yc, w, h) {
      api.at(deg, (x) => {
        const fw = w * pxm[0], fh = h * pxm[1], x0 = x - fw / 2, y0f = Yp(yc) - fh / 2;
        g.fillStyle = '#f4f2ee'; g.fillRect(x0, y0f, fw, fh);
        g.fillStyle = '#b01c2a'; for (let s = 0; s < 13; s += 2) g.fillRect(x0, y0f + (s * fh) / 13, fw, fh / 13);
        g.fillStyle = '#20305f'; g.fillRect(x0, y0f, fw * 0.4, (fh * 7) / 13);
        g.fillStyle = '#f4f2ee';
        for (let r = 0; r < 9; r++) for (let c = 0; c < (r % 2 ? 5 : 6); c++) {
          g.beginPath(); g.arc(x0 + fw * 0.4 * ((c + (r % 2 ? 1 : 0.5)) / 6), y0f + ((fh * 7) / 13) * ((r + 0.5) / 9), Math.max(0.6, fh * 0.012), 0, TAU); g.fill();
        }
      });
    },
  };
  paint(api);
  const rnd = rng(Math.round(y0 * 100) + 7);
  weather(g, 0, 0, W, H, rnd, { streaks: 90, alpha: 0.035 });

  const NH = 512, [Hc, gh] = canvas(64, NH, '#404040'), Yh = (y) => NH - ((y - y0) / (y1 - y0)) * NH;
  relief({
    /** Corrugation between two heights: `per` ridges a tile; sharp > 1 narrows them into stringers on flat skin. */
    corr(ya, yb, per, amp = 0.6, sharp = 1) {
      for (let x = 0; x < 64; x++) {
        const c = 0.5 + 0.5 * Math.cos((TAU * (x + 0.5) * per) / 64), v = 64 + 191 * amp * Math.pow(c, sharp);
        gh.fillStyle = `rgb(${Math.round(v)},0,0)`; gh.fillRect(x, Yh(yb), 1, Yh(ya) - Yh(yb));
      }
    },
    ring(y, w = 2, v = 150) { gh.fillStyle = `rgb(${v},0,0)`; gh.fillRect(0, Yh(y) - w / 2, 64, w); },
  });
  const map = wrapTex(C, true, 2), normal = wrapTex(normalFromHeight(Hc, 3.2), false, tiles);
  return new THREE.MeshStandardMaterial({ map, normalMap: normal, roughness: 0.56, metalness: 0.0, envMapIntensity: 0.7 });
}

const skinUv = (y0, y1) => (u, y) => [u, (y - y0) / (y1 - y0)];

// ---------------------------------------------------------------- engines

/** Outer wall of a bell from the throat down, as a profile listed bottom to top. */
function bellProfile(yThroat, rThroat, yExit, rExit, shape, n = 14) {
  const pts = [];
  for (let k = 0; k <= n; k++) { const s = 1 - k / n; pts.push([rThroat + (rExit - rThroat) * bell(s, shape), lerp(yThroat, yExit, s)]); }
  return pts;
}
/** The glowing inside of a bell (throat at v = 0, lip at v = 1), with the throat closed off. */
function bellInside(profile, wall = 0.02) {
  const inner = profile.slice().reverse().map(([r, y]) => [Math.max(0.02, r - wall), y]);
  const y0 = inner[0][1], y1 = inner[inner.length - 1][1];
  const lip = profile[0];
  return [
    revolve(inner, { seg: 32, uv: (u, y) => [0.5, (y - y0) / (y1 - y0)], rgb: [1, 1, 1] }),
    revolve([[0, y0], [inner[0][0], y0]], { seg: 32, uv: () => [0.5, 0.0], rgb: [1, 1, 1] }),
    revolve([[lip[0] - wall, lip[1]], [lip[0], lip[1]]], { seg: 32, uv: () => [0.5, 1.0], rgb: [1, 1, 1] }),
  ];
}
const tubeUv = (rep, yA, yB) => (u, y) => [u * rep, 0.02 + 0.42 * ((y - yA) / (yB - yA))];

/** Rocketdyne F-1: 5.8 m from gimbal to lip, 3.6 m across the exit. Origin at the gimbal. */
function f1Engine() {
  const yE = -F1.gimbalY, yM = -3.35, yT = -1.6, rT = 0.445, rM = 1.407, m = [];
  // the uncooled nozzle extension below the turbine-exhaust manifold, with its stiffening bands
  const ext = bellProfile(yM, rM, yE, F1.exitR, 0.7, 16), banded = [];
  ext.forEach(([r, y], k) => {
    if (k % 3 === 1) banded.push([r, y - 0.035], [r + 0.045, y - 0.03], [r + 0.045, y + 0.03], [r, y + 0.035]); else banded.push([r, y]);
  });
  m.push(revolve(banded, { seg: 36, rgb: STEEL, crease: 40 }));
  m.push(prim(new THREE.TorusGeometry(rM + 0.1, 0.2, 10, 36), { pos: [0, yM + 0.06, 0], rot: [Math.PI / 2, 0, 0], rgb: FOIL }));
  // tube-wall chamber and upper nozzle
  const up = bellProfile(yT, rT, yM, rM, 0.45, 12);
  m.push(revolve(up, { seg: 36, rgb: TUBE, uv: tubeUv(10, yT, yM) }));
  m.push(revolve([[rT, yT], [0.5, -1.2], [0.51, -0.6], [0.63, -0.58], [0.63, -0.38], [0.56, -0.36], [0.5, -0.2], [0.3, -0.04], [0.22, 0.0], [0.22, 0.14], [0, 0.14]], { seg: 28, rgb: FOIL, crease: 35 }));
  // turbopump stack on one side: LOX pump, fuel pump, turbine, and the duct to the manifold
  const px = 1.04;
  m.push(cyl(0.36, 0.36, 1.5, [px, -1.05, 0], FOIL, 18));
  m.push(cyl(0.56, 0.56, 0.26, [px, -0.62, 0], FOIL, 20), cyl(0.54, 0.54, 0.3, [px, -1.3, 0], FOIL, 20), cyl(0.47, 0.4, 0.42, [px, -2.0, 0], [0.5, 0.48, 0.44], 18));
  m.push(cyl(0.2, 0.3, 0.3, [px, -0.2, 0], FOIL, 14));
  m.push(rod([px, -2.2, 0], [px + 0.42, -3.2, 0], 0.26, FOIL, 12));
  for (const s of [1, -1]) {
    m.push(rod([px - 0.1, -0.62, 0.5 * s], [0.35, -0.47, 0.42 * s], 0.11, FOIL), rod([px - 0.1, -1.3, 0.5 * s], [0.42, -1.05, 0.4 * s], 0.1, FOIL));
    m.push(rod([-0.2, -0.3, 0.9 * s], [-0.65, -2.9, 1.25 * s], 0.05, [0.4, 0.4, 0.42]));          // gimbal actuator outrigger
  }
  m.push(cyl(0.18, 0.18, 1.0, [-0.55, -0.9, 0.55], FOIL, 10), ball(0.26, [-0.75, -1.25, -0.35], FOIL, 12));
  const inner = [...bellProfile(yT, rT, yM, rM, 0.45, 8).slice(1), ...bellProfile(yM, rM, yE, F1.exitR, 0.7, 8)].sort((a, b) => a[1] - b[1]);
  return { metal: mergeAll(m), glow: mergeAll(bellInside(inner, 0.03)) };
}

/** Rocketdyne J-2: 3.4 m long, 2 m across the exit, tube wall all the way down. Origin at the gimbal. */
function j2Engine() {
  const yE = -J2.len, yT = -0.92, rT = 0.19, m = [];
  const pr = bellProfile(yT, rT, yE, J2.exitR, 0.36, 18);
  m.push(revolve(pr, { seg: 36, rgb: [0.56, 0.56, 0.55], uv: tubeUv(7, yT, yE) }));
  m.push(revolve([[rT, yT], [0.24, -0.72], [0.25, -0.42], [0.32, -0.4], [0.32, -0.3], [0.24, -0.22], [0.12, -0.02], [0.12, 0.1], [0, 0.1]], { seg: 22, rgb: FOIL, crease: 35 }));
  const rAt = (y) => rT + (J2.exitR - rT) * bell((yT - y) / (yT - yE), 0.36);
  m.push(prim(new THREE.TorusGeometry(rAt(-2.0) + 0.07, 0.085, 8, 32), { pos: [0, -2.0, 0], rot: [Math.PI / 2, 0, 0], rgb: FOIL }));
  m.push(prim(new THREE.TorusGeometry(rAt(-1.35) + 0.05, 0.06, 8, 28), { pos: [0, -1.35, 0], rot: [Math.PI / 2, 0, 0], rgb: FOIL }));
  m.push(prim(new THREE.TorusGeometry(J2.exitR + 0.01, 0.035, 6, 36), { pos: [0, yE + 0.03, 0], rot: [Math.PI / 2, 0, 0], rgb: [0.4, 0.4, 0.4] }));
  // fuel and oxidizer turbopumps either side of the chamber, the spherical start tank between them
  m.push(cyl(0.2, 0.2, 0.85, [0.62, -0.62, 0], FOIL, 14), cyl(0.27, 0.27, 0.16, [0.62, -0.35, 0], FOIL, 14));
  m.push(cyl(0.19, 0.19, 0.62, [-0.6, -0.6, 0], FOIL, 14), cyl(0.26, 0.26, 0.16, [-0.6, -0.4, 0], FOIL, 14));
  m.push(ball(0.36, [0, -0.6, 0.62], [0.66, 0.66, 0.64], 16));
  m.push(rod([0.62, -1.05, 0], [0.75, -1.95, 0], 0.07, FOIL), rod([-0.6, -0.92, 0], [-0.74, -1.95, 0], 0.07, FOIL));
  m.push(rod([0.6, -0.3, 0.1], [0.15, -0.26, 0.2], 0.06, FOIL), rod([-0.58, -0.3, 0.1], [-0.15, -0.26, 0.2], 0.06, FOIL));
  return { metal: mergeAll(m), glow: mergeAll(bellInside(pr, 0.015)) };
}

/** Service Propulsion System engine: ablative chamber, then the big radiation-cooled skirt. Origin at the SM's base. */
function spsEngine() {
  const yE = SPS_EXIT - Y.slaTop, yT = 0.35, m = [];
  const pr = bellProfile(yT, 0.16, yE, 1.24, 0.42, 16);
  m.push(revolve(pr.slice(0, 12), { seg: 36, rgb: [0.3, 0.31, 0.34] }));
  m.push(revolve(pr.slice(11), { seg: 28, rgb: [0.2, 0.17, 0.14] }));
  m.push(prim(new THREE.TorusGeometry(pr[11][0] + 0.03, 0.04, 6, 28), { pos: [0, pr[11][1], 0], rot: [Math.PI / 2, 0, 0], rgb: [0.5, 0.5, 0.5] }));
  return { metal: mergeAll(m), glow: mergeAll(bellInside(pr, 0.012)) };
}

function mergeAll(list) { const m = meshOf(list, null); return m.geometry; }

// ---------------------------------------------------------------- stage pieces

/** A raised cable tunnel down the side of a stage: a rounded strip from y0 to y1 at azimuth deg. */
function tunnel(R, deg, y0, y1, w = 0.5, d = 0.22, rgb = WHITE) {
  const a = deg * D2R, hw = w / 2, pts = [[R - 0.05, -hw], [R + d * 0.7, -hw], [R + d, -hw * 0.5], [R + d, hw * 0.5], [R + d * 0.7, hw], [R - 0.05, hw]];
  const rows = [y0 - 0.5, y0, y1, y1 + 0.5].map((y, i) => pts.map(([x, z]) => [i === 0 || i === 3 ? Math.min(x, R + 0.01) : x, y, z]));
  return atAz(loftGrid(rows, { uv: () => BLANK, rgb, inside: [R - 1, (y0 + y1) / 2, 0] }), a);
}
/** A small teardrop blister (ullage motor, feed-line fairing) at azimuth deg. */
function blister(R, deg, y0, y1, w, d, rgb = WHITE, slope = 0) {
  const n = 7, rows = [];
  for (const [f, s] of [[0, 0.02], [0.12, 0.75], [0.3, 1], [0.72, 1], [0.9, 0.6], [1, 0.02]]) {
    const y = lerp(y0, y1, f), Rl = R + slope * (y - y0);
    rows.push(Array.from({ length: n }, (_, k) => { const ph = -Math.PI / 2 + (Math.PI * k) / (n - 1); return [Rl - 0.04 + Math.cos(ph) * d * s, y, Math.sin(ph) * (w / 2) * (0.35 + 0.65 * s)]; }));
  }
  return atAz(loftGrid(rows, { uv: () => BLANK, rgb, inside: [R - 1, (y0 + y1) / 2, 0] }), deg * D2R);
}
/** Ellipsoidal tank dome: `up` picks the forward dome (apex above the rim) or the aft one. */
function dome(R, yRim, depth, up, rgb, seg = 48) {
  const n = 9, pr = [];
  for (let k = 0; k <= n; k++) { const t = (k / n) * Math.PI / 2; pr.push(up ? [R * Math.cos(t), yRim + depth * Math.sin(t)] : [R * Math.sin(t), yRim - depth * Math.cos(t)]); }
  return revolve(pr, { seg, rgb });
}

function buildSIC(M) {
  const y0 = Y.base, y1 = Y.s2Sep, paintList = [], metal = [];
  const mat = skin(R1, y0, y1, 54, (p) => {
    for (const y of [[Y.base, Y.thrustTop], [Y.fuelTop, Y.interTop], [Y.loxTop, Y.s2Sep]]) p.band(y[0], y[1], CSS.ribbed);
    // roll pattern: black from each fin line a quarter of the way round, up to a third of the fuel tank
    const yBlack = Y.thrustTop + 6.6;
    for (const d of [45, 135]) p.panel(d, d + 45, Y.base, yBlack, CSS.black);
    // forward skirt: black blocks between the fin lines
    for (const d of [0, 90]) p.panel(d, d + 45, Y.loxTop, Y.s1Top, CSS.black);
    for (const d of [0, 90]) p.vtext('USA', d, Y.loxTop - 0.95, 2.0, 2.75);
    for (const y of [Y.thrustTop, Y.fuelTop, Y.interTop, Y.loxTop, Y.s1Top]) p.line(y, 'rgba(30,32,36,0.35)', 2);
    for (let y = Y.thrustTop + 2.7; y < Y.fuelTop - 1; y += 2.7) p.line(y, 'rgba(60,62,66,0.14)');
    for (let y = Y.interTop + 2.33; y < Y.loxTop - 1; y += 2.33) p.line(y, 'rgba(60,62,66,0.14)');
    p.line(st(1564), 'rgba(20,20,22,0.5)', 2.5);
  }, (r) => {
    r.corr(Y.base, Y.thrustTop, 8, 0.55, 2.2); r.corr(Y.fuelTop, Y.interTop, 4, 0.75, 1); r.corr(Y.loxTop, Y.s1Top, 8, 0.5, 2.2); r.corr(Y.s1Top, Y.s2Sep, 8, 0.55, 2.2);
    for (const y of [Y.thrustTop, Y.fuelTop, Y.interTop, Y.loxTop, Y.s1Top, st(1564)]) r.ring(y, 3, 235);
    for (let y = Y.thrustTop + 2.7; y < Y.fuelTop - 1; y += 2.7) r.ring(y, 1.6, 120);
    for (let y = Y.interTop + 2.33; y < Y.loxTop - 1; y += 2.33) r.ring(y, 1.6, 120);
    r.ring(Y.base + 2.4, 2, 215); r.ring(Y.base + 5, 2, 215); r.ring(Y.s1Top + 2.8, 2, 215);
  });
  const uv = skinUv(y0, y1);
  const skinGeo = [revolve([[R1, y0], [R1, y1]], { seg: 96, uv })];

  // inside the open top: skirt wall in primer, the LOX tank's forward dome
  metal.push(revolve([[R1 - 0.07, y1], [R1 - 0.07, Y.loxTop]], { seg: 64, rgb: PRIMER }), revolve([[R1, y1], [R1 - 0.07, y1]], { seg: 64, rgb: PRIMER }));
  metal.push(dome(R1 - 0.07, Y.loxTop, 3.3, true, [0.72, 0.72, 0.7]));
  // base heat shield, and the rim under the skin
  metal.push(revolve([[0, Y.heat], [R1 - 0.02, Y.heat], [R1, Y.base]], { seg: 64, rgb: [0.3, 0.27, 0.24], crease: 20 }));

  // engine fairings and fins on the four fin lines
  const yF0 = Y.heat - 0.02, yF1 = Y.thrustTop - 0.2, rc = (t) => lerp(F1.ring, R1 - 0.1, t), rho = (t) => 2.35 * (1 - Math.pow(t, 1.3)) + 0.12;
  const rOut = (y) => { const t = (y - yF0) / (yF1 - yF0); return rc(t) + rho(t); };
  const fair = [], NF = 13, phis = [];
  for (let k = 0; k <= 12; k++) phis.push(-118 + (236 * k) / 12);
  phis.splice(7, 0, 0.6); phis[6] = -0.6;
  for (let i = 0; i <= NF; i++) {
    const t = i / NF, y = lerp(yF0, yF1, t);
    fair.push(phis.map((ph) => [rc(t) + rho(t) * Math.cos(ph * D2R), y, -rho(t) * Math.sin(ph * D2R)]));
  }
  // closed tip
  fair.push(phis.map(() => [R1 - 0.1, yF1 + 0.1, 0]));
  const fairGeo = loftGrid(fair, { uv: () => BLANK, color: (p, i, j) => (j >= 7 ? BLACK : WHITE), inside: [R1 - 2, 8, 0] });
  // fin: swept leading edge, 19.2 m from tip to opposite tip
  const yTip = yF0 + 0.05, tipR = 9.6, sec = (x0, x1, yTE, yLE, th) => {
    const ym = lerp(yTE, yLE, 0.55), xm = lerp(x0, x1, 0.55);
    return [[x0, yTE, th * 0.3], [xm, ym, th / 2], [x1, yLE, 0.02], [xm, ym, -th / 2], [x0, yTE, -th * 0.3]];
  };
  const root = sec(rOut(yTip) - 0.25, rOut(8.6) - 0.25, yTip, 8.6, 0.42), tipS = sec(tipR, tipR, yTip, 6.6, 0.14);
  const finGeo = loftGrid([root, tipS], { closed: true, capEnd: true, uv: () => BLANK, color: (p, i, j) => (j === 3 || j === 4 ? BLACK : WHITE), capRgb: WHITE });
  // flat-shade the fin: its faces meet at real edges
  const finFlat = finGeo.toNonIndexed(); finFlat.computeVertexNormals();
  for (let k = 0; k < 4; k++) {
    const a = (45 + 90 * k) * D2R;
    paintList.push(atAz(fairGeo.clone(), a), atAz(finFlat.clone(), a));
  }
  // cable and pressurization tunnels, ullage motors on the interstage
  paintList.push(tunnel(R1, 22.5, Y.thrustTop - 1, Y.loxTop + 1, 0.55, 0.26), tunnel(R1, 202.5, Y.thrustTop - 1, Y.loxTop + 1, 0.55, 0.26));
  paintList.push(tunnel(R1, 112.5, Y.fuelTop - 2, Y.loxTop - 2, 0.4, 0.2), tunnel(R1, 292.5, Y.fuelTop - 2, Y.loxTop - 2, 0.4, 0.2));
  for (let k = 0; k < 4; k++) paintList.push(blister(R1, 90 * k + 67.5, Y.s1Top + 1.2, Y.s1Top + 3.9, 0.75, 0.42));

  const group = new THREE.Group(); group.name = 'S-IC';
  const e = f1Engine(), mounts = [{ pos: [0, F1.gimbalY, 0], yaw: 0.6, gimbal: false }];
  for (let k = 0; k < 4; k++) { const a = (45 + 90 * k) * D2R; mounts.push({ pos: polar(F1.ring, a, F1.gimbalY), yaw: a + Math.PI, gimbal: true }); }
  const engines = engineSet([[e.metal, M.metal], [e.glow, M.glow[0]]], mounts);
  group.add(meshOf(skinGeo, mat), meshOf(paintList, M.paint), meshOf(metal, M.metal), engines.group);
  return {
    name: 'S-IC', group, bottomY: 0, topY: Y.s2Sep, propellant: 'kerolox', nozzleRadius: F1.exitR, engines, gimbalMax: F1.max,
    nozzles: mounts.map((m) => new THREE.Vector3(m.pos[0], 0, m.pos[2])),
  };
}

function buildSII(M) {
  const y0 = Y.s2Sep, y1 = Y.s4Base, paintList = [], metal = [];
  const mat = skin(R1, y0, y1, 54, (p) => {
    p.band(Y.s2Sep, Y.s2AftTop, CSS.black);
    p.band(Y.s2AftTop, Y.s2TankTop, '#eeece4');
    p.band(Y.s2TankTop, y1, CSS.ribbed);
    for (const d of [0]) p.vtext('UNITED STATES', d, Y.s2TankTop - 1.6, 0.66, 0.84, CSS.red, 1.15);
    for (const y of [Y.s2AftTop, Y.s2TankTop, Y.s2Top]) p.line(y, 'rgba(30,32,36,0.35)', 2);
    for (let k = 1; k < 5; k++) p.line(lerp(Y.s2AftTop, Y.s2TankTop, k / 5), 'rgba(60,62,66,0.16)');
  }, (r) => {
    r.corr(Y.s2Sep, Y.s2AftTop, 8, 0.5, 2.2); r.corr(Y.s2TankTop, Y.s2Top, 8, 0.5, 2.2); r.corr(Y.s2Top, y1, 8, 0.55, 2.2);
    for (const y of [Y.s2AftTop, Y.s2TankTop, Y.s2Top]) r.ring(y, 3, 235);
    for (let k = 1; k < 5; k++) r.ring(lerp(Y.s2AftTop, Y.s2TankTop, k / 5), 1.6, 120);
    r.ring(Y.s2Top + 2.9, 2, 215);
  });
  const uv = skinUv(y0, y1);
  const skinGeo = [revolve([[R1, y0], [R1, Y.s2Top], [R3, y1]], { seg: 96, uv, crease: 10 })];
  // open top: inner wall of the cone, the hydrogen tank's forward dome
  metal.push(revolve([[R3 - 0.06, y1], [R1 - 0.06, Y.s2Top], [R1 - 0.06, Y.s2TankTop]], { seg: 64, rgb: PRIMER }), revolve([[R3, y1], [R3 - 0.06, y1]], { seg: 64, rgb: PRIMER }));
  paintList.push(dome(R1 - 0.06, Y.s2TankTop, 2.9, true, FOAM));
  // underneath: the LOX tank's aft dome, the conical thrust structure and its cross beam
  paintList.push(dome(R1 - 0.02, Y.s2AftTop, 3.25, false, FOAM));
  metal.push(revolve([[R1 - 0.02, Y.s2AftTop], [R1, y0]], { seg: 64, rgb: PRIMER }));
  metal.push(revolve([[2.95, S2_GIMBAL - 0.1], [4.5, Y.s2AftTop - 1.45]], { seg: 48, rgb: [0.62, 0.63, 0.62] }), revolve([[4.5, Y.s2AftTop - 1.45], [2.95, S2_GIMBAL - 0.1]], { seg: 48, rgb: PRIMER }));
  metal.push(box(5.9, 0.45, 0.4, [0, S2_GIMBAL + 0.2, 0], [0.55, 0.56, 0.55], [0, 45 * D2R, 0]), box(5.9, 0.45, 0.4, [0, S2_GIMBAL + 0.2, 0], [0.55, 0.56, 0.55], [0, -45 * D2R, 0]));
  // five hydrogen feed-line fairings low on the tank, the systems tunnel, the LOX vent line
  for (let k = 0; k < 5; k++) paintList.push(blister(R1, 18 + 72 * k, Y.s2AftTop - 1.3, Y.s2AftTop + 2.6, 0.7, 0.4));
  paintList.push(tunnel(R1, 115, Y.s2AftTop + 0.5, Y.s2TankTop + 1.5, 0.6, 0.26), tunnel(R1, 250, Y.s2AftTop + 3, Y.s2TankTop - 1, 0.3, 0.16));

  const group = new THREE.Group(); group.name = 'S-II';
  const e = j2Engine(), mounts = [{ pos: [0, S2_GIMBAL, 0], yaw: 0.4, gimbal: false }];
  for (let k = 0; k < 4; k++) { const a = (45 + 90 * k) * D2R; mounts.push({ pos: polar(J2.ring, a, S2_GIMBAL), yaw: a + Math.PI / 2, gimbal: true }); }
  const engines = engineSet([[e.metal, M.metal], [e.glow, M.glow[1]]], mounts);
  group.add(meshOf(skinGeo, mat), meshOf(paintList, M.paint), meshOf(metal, M.metal), engines.group);
  return {
    name: 'S-II', group, bottomY: S2_GIMBAL - J2.len, topY: y1, propellant: 'hydrolox', nozzleRadius: J2.exitR, engines, gimbalMax: J2.max,
    nozzles: mounts.map((m) => new THREE.Vector3(m.pos[0], S2_GIMBAL - J2.len, m.pos[2])),
  };
}

function buildSIVB(M) {
  const y0 = Y.s4Base, y1 = Y.slaTop, paintList = [], metal = [];
  const mat = skin(R3, y0, y1, 36, (p) => {
    p.band(Y.s4Base, Y.s4AftTop, CSS.ribbed); p.band(Y.s4TankTop, Y.iuBase, CSS.ribbed);
    for (const d of [45, 135]) p.panel(d, d + 45, Y.s4Base, Y.s4AftTop, CSS.black);
    for (const d of [0, 90]) p.panel(d + 12, d + 45, Y.iuBase, Y.iuTop, CSS.black);
    p.band(Y.iuBase, Y.iuBase + 0.05, CSS.black);
    p.flag(45, Y.s4TankTop - 2.0, 2.5, 1.32);
    for (const y of [Y.s4AftTop, Y.s4TankTop, Y.iuBase, Y.iuTop]) p.line(y, 'rgba(30,32,36,0.35)', 2);
    for (let k = 1; k < 3; k++) p.line(lerp(Y.s4AftTop, Y.s4TankTop, k / 3), 'rgba(60,62,66,0.14)');
    // adapter panels: four petals hinged a third of the way up, fixed panels above them
    const hinge = Y.iuTop + 6.4;
    p.line(hinge, 'rgba(30,32,36,0.4)', 2);
    for (const d of [0, 90]) p.at(d + 22.5, (x) => { p.g.fillStyle = 'rgba(30,32,36,0.4)'; p.g.fillRect(x - 1, p.Y(y1), 2, p.Y(Y.iuTop) - p.Y(y1)); });
  }, (r) => {
    r.corr(Y.s4Base, Y.s4AftTop, 8, 0.5, 2.2); r.corr(Y.s4TankTop, Y.iuBase, 8, 0.5, 2.2);
    for (const y of [Y.s4AftTop, Y.s4TankTop, Y.iuBase, Y.iuTop, Y.iuTop + 6.4]) r.ring(y, 3, 235);
    for (let k = 1; k < 3; k++) r.ring(lerp(Y.s4AftTop, Y.s4TankTop, k / 3), 1.6, 120);
  });
  const uv = skinUv(y0, y1);
  const skinGeo = [revolve([[R3, y0], [R3, Y.iuTop], [RSM, y1]], { seg: 80, uv, crease: 8 })];
  // open top once the spacecraft has gone: inside of the adapter, a deck at the instrument unit
  metal.push(revolve([[RSM - 0.04, y1], [R3 - 0.05, Y.iuTop], [R3 - 0.05, Y.iuBase]], { seg: 48, rgb: PRIMER }), revolve([[RSM, y1], [RSM - 0.04, y1]], { seg: 48, rgb: PRIMER }));
  paintList.push(dome(R3 - 0.05, Y.s4TankTop + 0.4, 2.0, true, FOAM, 40));
  // underneath: aft dome, thrust cone
  paintList.push(dome(R3 - 0.02, Y.s4AftTop, 2.15, false, FOAM, 40));
  metal.push(revolve([[R3 - 0.02, Y.s4AftTop], [R3, y0]], { seg: 48, rgb: PRIMER }));
  metal.push(revolve([[0.42, S4_GIMBAL], [2.1, Y.s4AftTop - 1.65]], { seg: 32, rgb: [0.62, 0.63, 0.62] }));
  // auxiliary propulsion modules, ullage motors, tunnels
  for (const d of [0, 180]) {
    paintList.push(blister(R3, d, Y.s4Base + 0.25, Y.s4AftTop + 0.7, 1.0, 0.62));
    for (const dy of [0.9, 1.5]) metal.push(atAz(cyl(0.05, 0.1, 0.22, [R3 + 0.66, Y.s4Base + dy, 0], DARK, 10, [0, 0, -Math.PI / 2]), d * D2R));
  }
  for (const d of [90, 270]) paintList.push(blister(R3, d, Y.s4Base + 0.5, Y.s4Base + 1.9, 0.5, 0.36));
  paintList.push(tunnel(R3, 135, Y.s4AftTop - 0.6, Y.s4TankTop + 1.2, 0.55, 0.24), tunnel(R3, 315, Y.s4AftTop + 1.5, Y.s4TankTop, 0.3, 0.15));

  const group = new THREE.Group(); group.name = 'S-IVB';
  const e = j2Engine(), mounts = [{ pos: [0, S4_GIMBAL, 0], yaw: 0.9, gimbal: true }];
  const engines = engineSet([[e.metal, M.metal], [e.glow, M.glow[2]]], mounts);
  group.add(meshOf(skinGeo, mat), meshOf(paintList, M.paint), meshOf(metal, M.metal), engines.group);
  return {
    name: 'S-IVB', group, bottomY: S4_GIMBAL - J2.len, topY: y1, propellant: 'hydrolox', nozzleRadius: J2.exitR, engines, gimbalMax: J2.max,
    nozzles: [new THREE.Vector3(0, S4_GIMBAL - J2.len, 0)],
  };
}

/** Service module skin: aluminized sectors, white radiators, and the maps that make only the bare parts metallic. */
function smMaterial() {
  const W = 512, H = 512, y0 = Y.slaTop, y1 = Y.smTop;
  const [C, g] = canvas(W, H, '#b4b8bd'), [Rm, gr] = canvas(W, H, 'rgb(0,96,224)');
  const X = (deg) => (deg / 180) * W, Yp = (y) => H - ((y - y0) / (y1 - y0)) * H;
  const white = (d0, d1, ya, yb, lines = 0) => {
    g.fillStyle = '#eeeeea'; g.fillRect(X(d0), Yp(yb), X(d1) - X(d0), Yp(ya) - Yp(yb));
    gr.fillStyle = 'rgb(0,150,0)'; gr.fillRect(X(d0), Yp(yb), X(d1) - X(d0), Yp(ya) - Yp(yb));
    g.fillStyle = 'rgba(70,74,80,0.3)';
    for (let k = 1; k < lines; k++) g.fillRect(X(d0), Yp(lerp(ya, yb, k / lines)), X(d1) - X(d0), 1);
    g.strokeStyle = 'rgba(40,44,50,0.5)'; g.lineWidth = 1.2; g.strokeRect(X(d0), Yp(yb), X(d1) - X(d0), Yp(ya) - Yp(yb));
  };
  const rnd = rng(11);
  for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '40,44,52'},${0.02 + rnd() * 0.04})`; g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 30, 1 + rnd() * 2); }
  white(60, 120, y0 + 0.35, y0 + 2.15, 9);                         // environmental-control radiator
  for (const d of [8, 52, 128, 172]) white(d - 15, d + 15, y1 - 1.25, y1 - 0.55, 4);      // fuel-cell radiators
  white(0, 180, y1 - 0.33, y1);                                    // fairing to the command module
  g.fillStyle = 'rgba(30,34,40,0.55)';
  for (const d of [0, 60, 120]) g.fillRect(X(d) - 1, 0, 2, H);    // sector seams
  g.fillRect(0, Yp(y1 - 0.33) - 1, W, 2); g.fillRect(0, Yp(y0 + 0.2), W, 1.5);
  for (const d of [45, 135]) { g.fillStyle = '#d7d9db'; g.fillRect(X(d) - 26, Yp(y1 - 1.05) - 30, 52, 60); g.strokeStyle = 'rgba(30,34,40,0.5)'; g.strokeRect(X(d) - 26, Yp(y1 - 1.05) - 30, 52, 60); }
  // "UNITED STATES" and the flag on one sector
  g.save(); g.translate(X(155), Yp(y0 + 1.7)); g.fillStyle = '#b01c2a'; g.fillRect(-22, -30, 44, 3.6); g.fillRect(-22, -22.8, 44, 3.6); g.fillRect(-22, -15.6, 44, 3.6); g.fillRect(-22, -8.4, 44, 3.6);
  g.fillStyle = '#f2f0ec'; g.fillRect(-22, -26.4, 44, 3.6); g.fillRect(-22, -19.2, 44, 3.6); g.fillRect(-22, -12, 44, 3.6); g.fillStyle = '#20305f'; g.fillRect(-22, -30, 18, 14.4);
  g.font = `bold 15px ${FONT}`; g.fillStyle = '#1c1d20'; g.textAlign = 'center'; g.fillText('UNITED', 0, 14); g.fillText('STATES', 0, 31); g.restore();
  const map = wrapTex(C, true, 2), rm = wrapTex(Rm, false, 2);
  return new THREE.MeshStandardMaterial({ map, roughnessMap: rm, metalnessMap: rm, roughness: 1, metalness: 1, envMapIntensity: 1.0 });
}

function buildCSM(M) {
  const paintList = [], metal = [], y0 = Y.slaTop, y1 = Y.smTop;
  const skinGeo = [revolve([[RSM, y0], [RSM, y1]], { seg: 64, uv: skinUv(y0, y1) })];
  // aft bulkhead and heat shield round the engine
  metal.push(revolve([[0.5, y0 - 0.1], [RSM - 0.25, y0 - 0.1], [RSM, y0]], { seg: 48, rgb: [0.5, 0.5, 0.52], crease: 20 }));
  // four reaction-control quads
  for (let k = 0; k < 4; k++) {
    const a = (52.25 + 90 * k) * D2R, yq = y1 - 1.05, q = [];
    q.push(box(0.26, 0.5, 0.46, [RSM + 0.1, yq, 0], [0.74, 0.75, 0.76]));
    const noz = (rot, pos) => cyl(0.045, 0.11, 0.3, pos, [0.25, 0.24, 0.24], 10, rot, true);
    q.push(noz([Math.PI, 0, 0], [RSM + 0.27, yq + 0.38, 0]), noz([0, 0, 0], [RSM + 0.27, yq - 0.38, 0]));
    q.push(noz([Math.PI / 2, 0, 0], [RSM + 0.27, yq, 0.36]), noz([-Math.PI / 2, 0, 0], [RSM + 0.27, yq, -0.36]));
    for (const g of q) metal.push(atAz(g, a));
  }
  // command module: heat-shield shoulder, 33-degree cone, docking tunnel
  const yc = y1 + 0.02, cmSilver = [0.78, 0.79, 0.8];
  metal.push(revolve([[RSM - 0.06, yc - 0.12], [RSM, yc + 0.12], [RSM - 0.03, yc + 0.3], [0.62, yc + 2.52], [0.5, yc + 2.86], [0.42, yc + 3.02], [0, yc + 3.05]], { seg: 64, rgb: cmSilver, crease: 30 }));
  // windows, hatch outline and the pitch thrusters, as dark insets just proud of the cone
  const onCone = (deg, yRel, w, h, rgb) => {
    const sl = Math.atan2(RSM - 0.03 - 0.62, 2.22), r = lerp(RSM - 0.03, 0.62, (yRel - 0.3) / 2.22) + 0.012;
    return atAz(box(0.02, h, w, [r, yc + yRel, 0], rgb, [0, 0, sl]), deg * D2R);
  };
  for (const [d, yr, w, h] of [[90, 1.35, 0.32, 0.32], [60, 1.5, 0.3, 0.34], [120, 1.5, 0.3, 0.34], [78, 2.0, 0.16, 0.3], [102, 2.0, 0.16, 0.3]]) paintList.push(onCone(d, yr, w, h, DARK));
  paintList.push(onCone(90, 0.9, 0.86, 0.035, [0.2, 0.2, 0.22]), onCone(90, 1.75, 0.86, 0.035, [0.2, 0.2, 0.22]));
  for (const d of [0, 180, 270]) paintList.push(onCone(d - 4, 0.75, 0.1, 0.16, DARK), onCone(d + 4, 0.75, 0.1, 0.16, DARK));

  const group = new THREE.Group(); group.name = 'CSM';
  const e = spsEngine();
  const engines = engineSet([[e.metal, M.metal], [e.glow, M.glow[3]]], [{ pos: [0, y0, 0], gimbal: true }]);
  group.add(meshOf(skinGeo, smMaterial()), meshOf(paintList, M.paint), meshOf(metal, M.metal), engines.group);
  return {
    name: 'CSM', group, bottomY: SPS_EXIT, topY: yc + 3.05, propellant: 'hypergolic', nozzleRadius: 1.24, engines, gimbalMax: 4.5 * D2R,
    nozzles: [new THREE.Vector3(0, SPS_EXIT, 0)],
  };
}

/** Launch escape tower and the boost protective cover it carries away with it. */
function buildTower(M) {
  const paintList = [], metal = [], yc = Y.smTop + 0.02, apex = yc + 3.1;
  paintList.push(revolve([[RSM + 0.03, yc + 0.02], [RSM + 0.015, yc + 0.32], [0.66, yc + 2.55], [0.54, yc + 2.9], [0.46, apex], [0, apex + 0.02]], { seg: 64, rgb: WHITE, crease: 30 }));
  paintList.push(atAz(box(0.02, 0.3, 0.3, [1.19, yc + 1.37, 0], DARK, [0, 0, Math.atan2(RSM - 0.66, 2.23)]), 90 * D2R));
  const yM = Y.top - 6.75, bm = new Beams(), GRAY = [0.6, 0.61, 0.62];
  const leg = (k, t) => { const a = (45 + 90 * k) * D2R, r = lerp(0.56, 0.3, t); return polar(r, a, lerp(apex - 0.15, yM, t)); };
  for (let k = 0; k < 4; k++) {
    bm.add(leg(k, 0), leg(k, 1), 0.075, GRAY);
    for (const [t0, t1] of [[0.02, 0.36], [0.36, 0.68], [0.68, 0.98]]) { bm.add(leg(k, t0), leg(k + 1, t1), 0.045, GRAY); bm.add(leg(k + 1, t0), leg(k, t1), 0.045, GRAY); }
    for (const t of [0.36, 0.68]) bm.add(leg(k, t), leg(k + 1, t), 0.045, GRAY);
  }
  paintList.push(bm.build());
  // structural skirt, the escape motor's four canted nozzles, motor case, jettison motor, canards, ballast and Q-ball
  const rM = 0.33;
  paintList.push(revolve([[0.3, yM], [0.6, yM + 0.12], [rM + 0.04, yM + 0.75], [rM, yM + 0.8], [rM, Y.top - 1.75], [0.27, Y.top - 1.2], [0.1, Y.top - 0.12], [0, Y.top]], { seg: 28, rgb: WHITE, crease: 25 }));
  for (let k = 0; k < 4; k++) metal.push(atAz(cyl(0.2, 0.09, 0.5, [0.5, yM + 0.3, 0], DARK, 12, [0, 0, 35 * D2R], true), (90 * k) * D2R));
  for (const s of [1, -1]) {
    metal.push(cyl(0.1, 0.05, 0.3, [s * 0.36, Y.top - 2.35, 0], DARK, 10, [0, 0, s * 30 * D2R], true));
    paintList.push(box(0.03, 0.75, 0.34, [0, Y.top - 1.45, s * 0.37], WHITE));
  }
  for (const y of [yM + 2.2, Y.top - 2.75, Y.top - 1.75]) paintList.push(revolve([[rM, y - 0.04], [rM + 0.02, y - 0.03], [rM + 0.02, y + 0.03], [rM, y + 0.04]], { seg: 24, rgb: [0.55, 0.55, 0.55] }));
  const group = new THREE.Group(); group.name = 'launch escape tower';
  group.add(meshOf(paintList, M.paint), meshOf(metal, M.metal));
  return group;
}

export function buildSaturnV() {
  const hw = hardwareTextures();
  const M = {
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.56, metalness: 0, envMapIntensity: 0.7 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, map: hw.map, normalMap: hw.normal, roughness: 0.42, metalness: 0.72, envMapIntensity: 1.0 }),
    glow: ['kerolox', 'hydrolox', 'hydrolox', 'hypergolic'].map((p) => new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.7, metalness: 0.3, emissive: new THREE.Color(...GLOW_RGB[p]), emissiveMap: hw.glow, emissiveIntensity: 0 })),
  };
  const root = new THREE.Group(); root.name = 'Saturn V';
  const stages = [buildSIC(M), buildSII(M), buildSIVB(M), buildCSM(M)];
  for (const s of stages) root.add(s.group);
  const tower = buildTower(M); root.add(tower);
  return assembleVehicle({
    id: 'saturnv', root, height: Y.top, radius: R1, stages, glow: M.glow, materials: M,
    extras: [{ name: 'tower', object: tower, withStage: 0 }],
    animate(dt, s) {
      const gx = (s.gimbal?.y || 0), gz = (s.gimbal?.x || 0), cur = s.stage ?? 0;
      stages.forEach((stg, i) => stg.engines.set(i === cur ? gx * stg.gimbalMax : 0, i === cur ? gz * stg.gimbalMax : 0));
    },
  });
}

export const SATURN_V_DIMENSIONS = { height: Y.top, diameter: R1 * 2, stations: Y };
