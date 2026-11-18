// The Apollo command module from the commander's couch (the left one).
//
// The crew lie on their backs with their heads toward the hatch (the vehicle's -Z side) and look up the
// stack at the main display console, which hangs across the cabin an arm's length from their faces, tilted
// to face them. Over its top edge are the two rendezvous windows that look along the nose; the square side
// windows are by the outer couches' shoulders and the round hatch window is over the center couch's head.
//
// Dimensions: the model's own command module (model-saturnv.js): base at station 3749.5, 3.91 m across,
// the conical wall leaning in 30.5 degrees. The pressure wall here runs 0.12 m inside that mold line from
// 0.34 m above the base to the forward bulkhead at 2.2 m, where the docking tunnel and its hatch begin.
//
// The console is three painted plates (2275 texels a meter on the commander's and the center one) carrying
// every label, dial face and annunciator legend, with the hardware as geometry over them: toggle switches
// between their wicket guards, rotary selectors, pushbuttons, bezels, the DSKY's keys. What moves:
// the two attitude balls (spheres behind their bezels), rate and error needles, roll bugs, the altimeter,
// the accelerometer, the LV angle-of-attack / SPS chamber pressure meter, the tank pressure pointers, the
// entry monitor's roll pointer, velocity counter and scroll, the mission and event timers, the DSKY and
// the lamps (launch vehicle engines, LIFT OFF, S-II SEP, master alarm, caution and warning matrix).

import * as THREE from 'three';
import { TAU, D2R, FONT, prim, rod, lerp, box, ball, Beams, disposeTree } from './model-kit.js';
import {
  V2C, pointToVehicle, dirToVehicle, cabinLight, cabMat, bakeLit, constLit, boxUv, Parts, meshFrom, shellWall, plateGeo, block, ringZ, discZ,
  Needles, blade, triangle, Live, flushLive, Sheet, segText, paintTexture, weaveTexture, occluder, insideOut, softPad, basis as mB,
} from './cabin-kit.js';

const YC = (3749.5 + 115.5) * 0.0254 + 0.02;        // the command module's base in the stack (model-saturnv.js: yc)
const RIN = (h) => 1.806 - 0.5883 * (h - 0.3);       // inner radius of the pressure wall at height h above that base
const H0 = 0.34, H1 = 2.2;                           // aft and forward bulkheads
const FT = 3.28084, NMI = 1852;

const INK = '#f1f0e9', PANEL = '#7b8386', FACE = '#0b0b0c';
const CHROME = [0.66, 0.67, 0.68], NUT = [0.4, 0.41, 0.42], BLACK = [0.022, 0.022, 0.024], GRAYP = [0.2, 0.215, 0.225];
const WALL = [0.36, 0.38, 0.37], CLOTH = [0.56, 0.54, 0.47];

// ---------------------------------------------------------------- hardware, built once and copied

const TPL = {};
function tpl(name, make) { return (TPL[name] || (TPL[name] = make())).clone(); }
const zUp = (g) => g.rotateX(Math.PI / 2);          // a shape built along +Y stood on the panel (+Z)
function mergeList(list) { const P = new Parts(); P.add('a', ...list); return P.geometry('a'); }

/** A locking toggle: st 1 up, 0 center, -1 down. */
const toggle = (st) => tpl('tg' + st, () => {
  const h = prim(new THREE.CylinderGeometry(0.0031, 0.002, 0.017, 7), { pos: [0, 0.0105, 0], rgb: CHROME }).rotateX(Math.PI / 2 - st * 0.36);
  const tip = prim(new THREE.SphereGeometry(0.0031, 7, 5), { pos: [0, 0.019, 0], rgb: CHROME }).rotateX(Math.PI / 2 - st * 0.36);
  const nut = zUp(prim(new THREE.CylinderGeometry(0.0056, 0.0056, 0.003, 6), { pos: [0, 0.0015, 0], rgb: NUT }));
  const bush = zUp(prim(new THREE.CylinderGeometry(0.0034, 0.0038, 0.005, 8), { pos: [0, 0.004, 0], rgb: NUT }));
  return mergeList([h, tip, nut, bush]);
});
/** The wire guard that stands either side of a toggle. */
const wicket = () => tpl('wk', () => prim(new THREE.TorusGeometry(0.0108, 0.00095, 4, 9, Math.PI), { rgb: [0.56, 0.57, 0.58] }).applyMatrix4(mB([0, 1, 0], [0, 0, 1.3], [1, 0, 0])));
/** A lift cover over a switch that must not be thrown by accident. */
const cover = (rgb) => mergeList([box(0.0135, 0.027, 0.0022, [0, 0.0005, 0.0212], rgb, [0.16, 0, 0]), box(0.0018, 0.027, 0.019, [-0.0068, 0, 0.0098], rgb), box(0.0018, 0.027, 0.019, [0.0068, 0, 0.0098], rgb), box(0.0135, 0.0024, 0.021, [0, 0.0135, 0.0105], rgb), zUp(prim(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0155, 8), { rgb: [0.45, 0.46, 0.47], rot: [0, 0, Math.PI / 2] })).translate(0, 0.0135, 0.0212)]);
/** A rotary selector pointing `deg` clockwise from the top. */
function knob(deg, r = 0.0095) {
  const g = mergeList([
    zUp(prim(new THREE.CylinderGeometry(r * 1.32, r * 1.38, 0.003, 20), { pos: [0, 0.0015, 0], rgb: [0.06, 0.06, 0.065] })),
    zUp(prim(new THREE.CylinderGeometry(r * 0.92, r, 0.013, 16), { pos: [0, 0.0095, 0], rgb: BLACK })),
    box(0.0018, r * 1.25, 0.0012, [0, r * 0.5, 0.0164], [0.86, 0.86, 0.82]),
    box(r * 0.7, r * 2.0, 0.006, [0, 0, 0.0135], [0.035, 0.035, 0.038]),
  ]);
  return g.rotateZ(-deg * D2R);
}
const breaker = () => tpl('cb', () => mergeList([
  zUp(prim(new THREE.CylinderGeometry(0.0042, 0.0042, 0.009, 8), { pos: [0, 0.0045, 0], rgb: BLACK })),
  zUp(prim(new THREE.CylinderGeometry(0.0045, 0.0045, 0.0018, 8), { pos: [0, 0.0062, 0], rgb: [0.8, 0.8, 0.76] })),
  zUp(prim(new THREE.CylinderGeometry(0.0062, 0.0062, 0.0016, 6), { pos: [0, 0.0008, 0], rgb: NUT })),
]));

// ---------------------------------------------------------------- a panel: sheets to paint on, hardware over them

class Panel {
  /** sheets: [Sheet], mats: the global list name of each sheet's material, M: where the panel stands in the cab. */
  constructor(sheets, mats, M) { this.sheets = sheets; this.mats = mats; this.M = M; this.P = new Parts(); this.wk = new Map(); this.lamps = []; }
  D(x, y, fn, m = 0.15) { for (const S of this.sheets) if (S.has(x, y, m)) fn(S); }
  si(x, y) { const i = this.sheets.findIndex((S) => S.has(x, y)); return i < 0 ? 0 : i; }
  text(str, x, y, h = 0.003, o) { this.D(x, y, (S) => S.text(str, x, y, h, o)); }
  rect(x0, y0, x1, y1, fill, stroke, lw, r) { this.D((x0 + x1) / 2, (y0 + y1) / 2, (S) => S.rect(x0, y0, x1, y1, fill, stroke, lw, r), Math.max(x1 - x0, y1 - y0)); }
  /** Something cut into the plate: a dark opening with a shaded edge. */
  well(x0, y0, x1, y1, r = 0.003, fill = FACE) { this.rect(x0 - 0.0012, y0 - 0.0012, x1 + 0.0012, y1 + 0.0012, 'rgba(20,22,24,0.55)', null, 0, r + 0.001); this.rect(x0, y0, x1, y1, fill, 'rgba(160,165,168,0.35)', 0.0004, r); }
  screw(x, y, r = 0.0026) { this.D(x, y, (S) => { S.disc(x, y, r * 1.25, 'rgba(0,0,0,0.25)'); S.disc(x, y, r, '#8d9093', 'rgba(30,30,30,0.6)', 0.0003); const a = (x * 977 + y * 613) % 3; S.line([[x - r * 0.7 * Math.cos(a), y - r * 0.7 * Math.sin(a)], [x + r * 0.7 * Math.cos(a), y + r * 0.7 * Math.sin(a)]], 'rgba(20,20,20,0.75)', 0.0005); }, 0.02); }
  /** The outline of a sub-panel, with a fastener at each corner. */
  plate(x0, y0, x1, y1) {
    this.D((x0 + x1) / 2, (y0 + y1) / 2, (S) => { S.rect(x0, y0, x1, y1, null, 'rgba(18,20,22,0.7)', 0.0007, 0.002); S.rect(x0 + 0.0008, y0 + 0.0008, x1 - 0.0008, y1 - 0.0008, null, 'rgba(200,205,208,0.16)', 0.0005, 0.002); }, 1.5);
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) this.screw(x + Math.sign((x0 + x1) / 2 - x) * 0.008, y + Math.sign((y0 + y1) / 2 - y) * 0.008);
  }
  /** A title over a run of switches, with rules either side of it. */
  title(str, x0, x1, y, h = 0.0036) {
    const xm = (x0 + x1) / 2, w = str.length * h * 0.78 + 0.006;
    this.D(xm, y, (S) => {
      if (x1 - x0 > w + 0.012) { S.line([[x0, y - 0.0035], [x0, y], [xm - w / 2, y]], INK, 0.00045); S.line([[xm + w / 2, y], [x1, y], [x1, y - 0.0035]], INK, 0.00045); }
      S.text(str, xm, y, h);
    }, 0.6);
  }
  wicketAt(x, y) { const k = Math.round(x * 2000) + ':' + Math.round(y * 2000); if (!this.wk.has(k)) { this.wk.set(k, 1); this.P.add('metal', wicket().translate(x, y, 0)); } }
  /** A toggle: name over it, the names of its positions above and below. o: { pitch, guard, tb (talkback: 0 gray, 1 barber pole), wick } */
  sw(x, y, name, up, dn, st = 1, o = {}) {
    const lift = o.tb != null ? 0.019 : 0;
    this.D(x, y, (S) => {
      S.disc(x, y - 0.0006, 0.0078, 'rgba(0,0,0,0.3)');
      if (name) S.text(name, x, y + 0.0305 + lift, 0.0034);
      if (up) S.text(up, x, y + 0.0138, 0.0029);
      if (dn) S.text(dn, x, y - 0.0144, 0.0029);
      if (o.tb != null) {
        S.rect(x - 0.0072, y + 0.0222, x + 0.0072, y + 0.0338, '#050506', 'rgba(170,175,178,0.5)', 0.0004, 0.001);
        if (o.tb) { for (let k = -3; k < 4; k++) S.poly([[x - 0.0062 + k * 0.0042, y + 0.0232], [x - 0.0041 + k * 0.0042, y + 0.0232], [x - 0.0011 + k * 0.0042, y + 0.0328], [x - 0.0032 + k * 0.0042, y + 0.0328]].map(([a, b]) => [Math.max(x - 0.0062, Math.min(x + 0.0062, a)), b]), '#d9d7cc'); }
        else S.rect(x - 0.0062, y + 0.0232, x + 0.0062, y + 0.0328, '#8c8f8c');
      }
    });
    this.P.add('metal', toggle(st).translate(x, y, 0));
    if (o.guard) this.P.add('paint', cover(o.guard === 2 ? [0.42, 0.43, 0.44] : [0.5, 0.045, 0.035]).translate(x, y, 0));
    const p = o.pitch || 0.04;
    if (o.wick !== false) { this.wicketAt(x - p / 2, y); this.wicketAt(x + p / 2, y); }
  }
  /** A row of toggles from x0 at `pitch`: items [name, up, down, state, options] or null for a gap. */
  row(y, x0, pitch, items) { items.forEach((it, i) => { if (it) this.sw(x0 + i * pitch, y, it[0], it[1], it[2], it[3] ?? 1, { pitch, ...(it[4] || {}) }); }); }
  /** A rotary selector: positions lettered round it from a0 to a1 degrees (clockwise from the top), `sel` the one it points at. */
  rot(x, y, name, labels, sel = 0, a0 = -120, a1 = 120, r = 0.0095, h = 0.0027) {
    const ang = (i) => (labels.length > 1 ? a0 + ((a1 - a0) * i) / (labels.length - 1) : 0);
    this.D(x, y, (S) => {
      S.disc(x, y, r * 1.6, 'rgba(0,0,0,0.28)');
      labels.forEach((l, i) => { const a = ang(i) * D2R, rr = r * 1.55 + 0.0075 + Math.abs(Math.sin(a)) * l.length * h * 0.3; S.tick(x, y, ang(i), r * 1.5, r * 1.5 + 0.003, INK, 0.0005); S.text(l, x + Math.sin(a) * rr, y + Math.cos(a) * rr, h); });
      if (name) S.text(name, x, y + r * 1.55 + 0.02, 0.0034);
    });
    this.P.add('paint', knob(ang(sel), r).translate(x, y, 0));
  }
  /** A square pushbutton with its legend, standing proud of the plate. */
  pb(x, y, w, h, legend, fill = '#d8d6ca', ink = '#111', th = 0.0026, z = 0.006) {
    this.rect(x - w / 2 - 0.002, y - h / 2 - 0.002, x + w / 2 + 0.002, y + h / 2 + 0.002, '#101112', 'rgba(0,0,0,0.5)', 0.0005, 0.002);
    this.rect(x - w / 2, y - h / 2, x + w / 2, y + h / 2, fill, null, 0, 0.0015);
    this.text(legend, x, y, th, { color: ink });
    const i = this.si(x, y);
    this.P.add('t' + i, block(x - w / 2, y - h / 2, x + w / 2, y + h / 2, 0, z, this.sheets[i].uv, [0.07, 0.07, 0.07], [1, 1, 1], this.sheets[i].bl));
  }
  /** A vertical meter with one or two pointers (vals 0..1), lettered over and under. */
  vmeter(x, y, name, vals, sub, h = 0.066, w = 0.019) {
    this.well(x - w / 2, y - h / 2, x + w / 2, y + h / 2, 0.002);
    this.D(x, y, (S) => {
      for (let k = 0; k <= 10; k++) { const yy = y - h / 2 + 0.006 + ((h - 0.012) * k) / 10, l = k % 5 === 0 ? 0.0034 : 0.002; S.line([[x - l, yy], [x + l, yy]], '#e8e6dc', k % 5 === 0 ? 0.0006 : 0.0004); }
      S.line([[x, y - h / 2 + 0.006], [x, y + h / 2 - 0.006]], 'rgba(232,230,220,0.5)', 0.0003);
      vals.forEach((v, i) => { const yy = y - h / 2 + 0.006 + (h - 0.012) * v, sx = vals.length === 1 ? -1 : i ? 1 : -1; S.poly([[x + sx * 0.0045, yy], [x + sx * 0.0086, yy + 0.0022], [x + sx * 0.0086, yy - 0.0022]], '#f4f2e6'); });
      if (name) S.text(name, x, y + h / 2 + 0.0075 + (name.includes('\n') ? 0.0024 : 0), 0.0029);
      if (sub) S.text(sub, x, y - h / 2 - 0.0055, 0.0026);
    });
  }
  /** A round instrument: the face is painted by `face(S)`, the bezel and glass are geometry. */
  dial(x, y, r, face, bz = 0.0065) {
    this.D(x, y, (S) => { S.disc(x, y, r + bz + 0.002, 'rgba(0,0,0,0.4)'); S.disc(x, y, r + 0.001, FACE); face(S); });
    this.P.add('paint', ringZ(x, y, r, r + bz, 0, 0.0075, BLACK, 40, 0, 0.002));
    this.P.add('glassI', discZ(x, y, r, 0.006));
  }
  /** A lamp whose face is a region of the lamps canvas: remembers where to put it. */
  lamp(id, x, y, w, h, z = 0.003, round = false) {
    this.rect(x - w / 2 - 0.0015, y - h / 2 - 0.0015, x + w / 2 + 0.0015, y + h / 2 + 0.0015, '#0a0a0b', null, 0, round ? w : 0.002);
    this.lamps.push({ id, x, y, w, h, z, round, M: this.M });
  }
  /** Hand the hardware to the cabin's lists, moved to where the panel stands. */
  flush(G) {
    for (const name of Object.keys(this.P.lists)) {
      const g = this.P.geometry(name, this.M); if (!g) continue;
      G.add(name[0] === 't' && name.length === 2 ? this.mats[+name[1]] : name, g);
    }
  }
}

// ---------------------------------------------------------------- the attitude ball

function ballTexture() {
  const W = 2048, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), SKY = '#b9bab3', GND = '#0d0d0e', X = (lon) => W * (0.25 + lon / 360), Y = (lat) => H * (0.5 - lat / 180);
  g.fillStyle = SKY; g.fillRect(0, 0, W, H / 2); g.fillStyle = GND; g.fillRect(0, H / 2, W, H / 2);
  const ink = (lat) => (lat > 0 ? '#0c0c0d' : '#f0efe8');
  for (let lat = -80; lat <= 80; lat += 10) {
    if (!lat) continue;
    g.fillStyle = ink(lat); const th = lat % 30 === 0 ? 3 : 1.6;
    if (lat % 30 === 0) g.fillRect(0, Y(lat) - th / 2, W, th);
    for (let lon = -30; lon < 360; lon += 30) for (const dx of [0, W, -W]) {             // the ladders: one every 30 degrees round
      const k = 1 / Math.max(0.2, Math.cos(lat * D2R)), half = (lat % 30 === 0 ? 34 : 20) * k;
      g.fillRect(X(lon) + dx - half, Y(lat) - th / 2, half * 2, th);
    }
  }
  for (let lat = -85; lat <= 85; lat += 5) { if (lat % 10 === 0) continue; g.fillStyle = ink(lat); const k = 1 / Math.max(0.2, Math.cos(lat * D2R)); for (let lon = -30; lon < 360; lon += 30) for (const dx of [0, W, -W]) g.fillRect(X(lon) + dx - 9 * k, Y(lat) - 0.8, 18 * k, 1.6); }
  for (let lon = -30; lon < 360; lon += 30) for (const dx of [0, W, -W]) { g.fillStyle = '#0c0c0d'; g.fillRect(X(lon) + dx - 1, Y(80), 2, Y(0) - Y(80)); g.fillStyle = '#f0efe8'; g.fillRect(X(lon) + dx - 1, Y(0), 2, Y(-80) - Y(0)); }
  for (let lon = -30; lon < 360; lon += 10) for (const dx of [0, W, -W]) { if (lon % 30 === 0) continue; g.fillStyle = '#0c0c0d'; g.fillRect(X(lon) + dx - 0.8, Y(4), 1.6, Y(0) - Y(4)); g.fillStyle = '#f0efe8'; g.fillRect(X(lon) + dx - 0.8, Y(0), 1.6, Y(-4) - Y(0)); }
  g.fillStyle = '#f0efe8'; g.fillRect(0, H / 2 - 2.5, W, 5); g.fillStyle = '#0c0c0d'; g.fillRect(0, H / 2 - 5.5, W, 3);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const num = (str, lon, lat, px) => { for (const dx of [0, W, -W]) { g.save(); g.translate(X(lon) + dx, Y(lat)); g.scale(1 / Math.max(0.25, Math.cos(lat * D2R)), 1); g.font = `700 ${px}px ${FONT}`; g.fillStyle = ink(lat || -1); g.fillText(str, 0, 2); g.restore(); } };
  for (let lon = 0; lon < 360; lon += 30) {
    num(String(lon / 10), lon + 5.2, -8, 34); num(String(lon / 10), lon + 5.2, 8, 34);          // heading in tens of degrees, either side of the horizon
    for (const lat of [30, 60, -30, -60]) num(String(Math.abs(lat) / 10), lon + 7.5 / Math.cos(lat * D2R) * 0.55, lat + 4.6 * Math.sign(lat), 30);
  }
  // the poles: a ring and a disc where the ladders meet (straight up and straight down)
  g.fillStyle = '#0c0c0d'; g.fillRect(0, Y(80) - 1.5, W, 3); g.fillStyle = '#a3261d'; g.fillRect(0, 0, W, Y(86.5));
  g.fillStyle = '#f0efe8'; g.fillRect(0, Y(-80) - 1.5, W, 3); g.fillStyle = '#a3261d'; g.fillRect(0, Y(-86.5), W, H - Y(-86.5));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 16; t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- the cabin

export function buildApollo() {
  const t0 = performance.now();
  const root = new THREE.Group(); root.name = 'Apollo command module cabin';
  const cab = new THREE.Group(); cab.quaternion.setFromRotationMatrix(V2C); cab.position.set(0, YC, 0); root.add(cab);
  const G = new Parts();                               // everything static, in the cab's axes, by finish
  const EYE = [-0.6, 0.53, -0.78];

  // ---- the pressure wall and its five windows
  const up = [0, 1, 0];
  const sh = shellWall(RIN, H0, H1, {
    segA: 80, segH: 12, rgb: WALL,
    holes: [
      { id: 'rdzL', ac: 63.5 * D2R, hc: 1.9, w: 0.2, hgt: 0.32, rad: 0.035, margin: 0.04 },
      { id: 'rdzR', ac: 116.5 * D2R, hc: 1.9, w: 0.2, hgt: 0.32, rad: 0.035, margin: 0.04 },
      { id: 'sideL', ac: 35 * D2R, hc: 1.37, w: 0.33, hgt: 0.33, rad: 0.05, margin: 0.045 },
      { id: 'sideR', ac: 145 * D2R, hc: 1.37, w: 0.33, hgt: 0.33, rad: 0.05, margin: 0.045 },
      { id: 'hatch', ac: 90 * D2R, hc: 1.28, w: 0.23, hgt: 0.23, rad: 0.115, margin: 0.03 },
    ],
  });
  const windows = [], shellParts = [sh.wall], glass = [];
  for (const H of sh.holes) {
    const rdz = H.id.startsWith('rdz'), depth = rdz ? 0.2 : 0.105, dir = rdz ? up : null;
    shellParts.push(H.reveal(depth, [0.07, 0.075, 0.08], dir), H.bezel(rdz ? 0.022 : 0.03, 0.012, [0.3, 0.31, 0.32]));
    glass.push(H.pane(depth * 0.25, dir), H.pane(depth * 0.92, dir));
    windows.push(H.window(depth, dir));
  }
  const U = cabinLight(windows);
  const toCab = (g) => g.applyMatrix4(V2C);
  for (const g of shellParts) G.add('paint', toCab(g));
  for (const g of glass) G.add('glass', toCab(g));

  /** A frame standing on the wall at azimuth az (degrees) and height h: X round the wall (toward the crew's right at the hatch), Y up the slope, Z into the cabin. */
  const onWall = (az, h, inset = 0) => {
    const a = az * D2R, p = new THREE.Vector3(...sh.P(a, h, inset)).applyMatrix4(V2C), n = new THREE.Vector3(...sh.Nin(a, h)).transformDirection(V2C);
    const x = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).transformDirection(V2C), y = new THREE.Vector3().crossVectors(n, x).normalize();
    return new THREE.Matrix4().makeBasis(x, y, n).setPosition(p);
  };
  const put = (list, M, ...geos) => { for (const g of geos) G.add(list, g.applyMatrix4(M)); };

  // bulkheads, tunnel and its hatch
  {
    const disc = (r0, r1, z, rgb, towardCrew = true, seg = 64) => { const g = prim(new THREE.RingGeometry(r0, r1, seg, 3), { pos: [0, 0, z], rgb }); if (!towardCrew) g.rotateY(Math.PI).translate(0, 0, 2 * z); return g; };
    G.add('paint', disc(0.0, RIN(H0) + 0.01, -H0, [0.4, 0.41, 0.4], false));                  // aft bulkhead, facing the apex
    G.add('paint', disc(0.4, RIN(H1) + 0.01, -H1, WALL));                                      // forward bulkhead, facing the crew
    G.add('paint', insideOut(prim(new THREE.CylinderGeometry(0.4, 0.4, 0.12, 40, 1, true), { rgb: [0.36, 0.37, 0.37] })).rotateX(Math.PI / 2).translate(0, 0, -H1 - 0.06));
    G.add('paint', disc(0, 0.4, -H1 - 0.12, [0.44, 0.45, 0.45]));
    const hz = -H1 - 0.12;
    for (let k = 0; k < 6; k++) G.add('paint', box(0.05, 0.36, 0.022, [0, 0, 0], [0.36, 0.37, 0.38]).translate(0, 0.19, 0).rotateZ((k / 6) * TAU).translate(0, 0, hz + 0.011));
    G.add('paint', zUp(prim(new THREE.CylinderGeometry(0.075, 0.085, 0.04, 20), { rgb: [0.3, 0.31, 0.32] })).translate(0, 0, hz + 0.02), ringZ(0, 0, 0.36, 0.4, hz, hz + 0.03, [0.32, 0.33, 0.34], 40));
    G.add('metal', rod([-0.07, 0.0, hz + 0.07], [0.07, 0.0, hz + 0.07], 0.009, CHROME), rod([-0.07, 0, hz + 0.02], [-0.07, 0, hz + 0.07], 0.007, CHROME), rod([0.07, 0, hz + 0.02], [0.07, 0, hz + 0.07], 0.007, CHROME));
  }

  // structure showing on the wall: longerons between the windows, a ring frame under the forward bulkhead
  {
    const bm = new Beams(), q = (az, h, e) => { const v = new THREE.Vector3(...sh.P(az * D2R, h, e)).applyMatrix4(V2C); return [v.x, v.y, v.z]; };
    for (const az of [3, 16, 49.5, 130.5, 164, 177, 196, 214, 232, 250, 270, 290, 308, 326, 344]) bm.add(q(az, H0, 0.009), q(az, H1, 0.009), 0.03, [0.44, 0.46, 0.45], 0.02);
    G.add('paint', bm.build());
    for (const h of [2.13, 0.6]) for (let k = 0; k < 72; k++) {
      const a0 = (k / 72) * 360, a1 = ((k + 1) / 72) * 360; if (h < 1 && a0 > 60 && a0 < 120) continue;
      const b2 = new Beams(); b2.add(q(a0, h, 0.007), q(a1, h, 0.007), 0.016, [0.44, 0.46, 0.45], 0.034); G.add('paint', b2.build());
    }
  }

  // ---- the main display console
  const TILT = 15 * D2R, MC = [0, 0.065, -1.3835];
  const Mmdc = new THREE.Matrix4().makeRotationX(-TILT).setPosition(...MC);
  const K = 2275;
  const sheets = [new Sheet(-1.05, -0.45, -0.3, 0.45, K, PANEL), new Sheet(-0.3, -0.45, 0.35, 0.45, K, PANEL), new Sheet(0.35, -0.45, 1.05, 0.45, 1600, PANEL)];
  for (const S of sheets) { S.noise(5200, 7 + S.W, 0.03); const g = S.g, gd = g.createLinearGradient(0, 0, 0, S.H); gd.addColorStop(0, 'rgba(255,255,255,0.05)'); gd.addColorStop(1, 'rgba(0,0,0,0.1)'); g.fillStyle = gd; g.fillRect(0, 0, S.W, S.H); }
  sheets[0].bl = sheets[0].uv(-1.04, 0.44); sheets[1].bl = sheets[1].uv(-0.15, 0.268); sheets[2].bl = sheets[2].uv(1.04, 0.44);      // hidden places (cut corners, behind a ball) for the white texel plain faces sample
  const mdc = new Panel(sheets, ['mdc0', 'mdc1', 'mdc2'], Mmdc);
  const ND = new Needles(), nd = {};
  const Mat = (M, x, y, z = 0) => new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(x, y, z));
  const needle = (id, shape, M, x, y, z, rgb = [0.93, 0.92, 0.86]) => { nd[id] = ND.add(shape, Mat(M, x, y, 0), rgb, [0.95, 0.5], z); };
  const balls = [];

  /** A flight director attitude indicator: the ball behind its bezel, the roll bug, three rate and three error needles. */
  function fdai(cx, cy, id) {
    const b = 0.093, rB = 0.068, rH = 0.056, zc = -0.05, zt = 0.02, i = mdc.si(cx, cy), S = mdc.sheets[i];
    // the mask's face: scales for the rate needles, roll index round the opening
    S.rect(cx - b - 0.004, cy - b - 0.004, cx + b + 0.004, cy + b + 0.004, 'rgba(0,0,0,0.45)', null, 0, 0.012);
    S.rect(cx - b, cy - b, cx + b, cy + b, '#141516', null, 0, 0.01);
    S.disc(cx, cy, rH + 0.012, '#0b0b0c', 'rgba(210,210,200,0.6)', 0.0005);
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60, 90, -90, 120, -120, 150, -150, 180]) S.tick(cx, cy, a, rH + 0.0015, rH + (a % 30 === 0 ? 0.009 : 0.006), INK, a % 30 === 0 ? 0.0009 : 0.0006);
    for (let k = -5; k <= 5; k++) {
      const d = k * 0.0085, l = k % 5 === 0 ? 0.0062 : 0.0036, w = k % 5 === 0 ? 0.0008 : 0.0005;
      S.line([[cx + d, cy + 0.089], [cx + d, cy + 0.089 - l]], INK, w); S.line([[cx + d, cy - 0.089], [cx + d, cy - 0.089 + l]], INK, w); S.line([[cx + 0.089, cy + d], [cx + 0.089 - l, cy + d]], INK, w);
    }
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) mdc.screw(cx + sx * (b - 0.008), cy + sy * (b - 0.008), 0.003);
    mdc.P.add('t' + i, ringZ(cx, cy, rH, b, 0, zt, [0.03, 0.03, 0.032], 56, 9, 0, S.uv, [1, 1, 1], S.bl));
    mdc.P.add('glassI', discZ(cx, cy, rH, zt + 0.004));
    // the fixed symbol: a ring and wings, orange
    const OR = [0.95, 0.42, 0.05], zs = zt + 0.0018;
    mdc.P.add('paint', ringZ(cx, cy, 0.0042, 0.0062, zs - 0.0006, zs, OR, 16), box(0.02, 0.0018, 0.0008, [cx - 0.019, cy, zs], OR), box(0.02, 0.0018, 0.0008, [cx + 0.019, cy, zs], OR),
      box(0.0018, 0.006, 0.0008, [cx - 0.0099, cy - 0.003, zs], OR), box(0.0018, 0.006, 0.0008, [cx + 0.0099, cy - 0.003, zs], OR), box(0.0016, 0.012, 0.0008, [cx, cy + rH - 0.006, zs], OR));
    const sphere = new THREE.SphereGeometry(rB, 56, 36); constLit(sphere, 1.0, 0.45);
    sphere.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sphere.attributes.position.count * 3).fill(1), 3));
    balls.push({ geo: sphere, pos: new THREE.Vector3(cx, cy, zc).applyMatrix4(Mmdc) });
    const Y = [0.96, 0.8, 0.12];
    needle(id + 'bug', triangle(0.008, 0.008, rH + 0.0015), Mmdc, cx, cy, zt + 0.0006, [0.95, 0.94, 0.88]);
    needle(id + 'rr', [[-0.00375, -0.0075], [0.00375, -0.0075], [0, 0]], Mmdc, cx, cy + 0.082, zt + 0.0007);
    needle(id + 'pr', [[-0.0075, -0.00375], [-0.0075, 0.00375], [0, 0]], Mmdc, cx + 0.082, cy, zt + 0.0007);
    needle(id + 'yr', [[-0.00375, 0.0075], [0.00375, 0.0075], [0, 0]], Mmdc, cx, cy - 0.082, zt + 0.0007);
    needle(id + 're', blade(0.03, 0.0014, 0.0014, 0), Mmdc, cx, cy + rH - 0.03, zt + 0.0024, Y);
    needle(id + 'pe', [[0, -0.0007], [0.03, -0.0007], [0.03, 0.0007], [0, -0.0007], [0.03, 0.0007], [0, 0.0007]], Mmdc, cx + rH - 0.03, cy, zt + 0.0024, Y);
    needle(id + 'ye', blade(0.03, 0.0014, 0.0014, 0), Mmdc, cx, cy - rH, zt + 0.0024, Y);
  }

  const lampDefs = {};                                 // id -> how its face is drawn (see the lamps canvas)
  const liveQuads = { lamps: [], dsky: [], timers: [], scroll: [] };
  const quadAt = (M, x0, y0, x1, y1, z, uv0, uv1, round) => {
    const g = round ? prim(new THREE.CircleGeometry((x1 - x0) / 2, 24), { pos: [(x0 + x1) / 2, (y0 + y1) / 2, z], keepUv: true }) : prim(new THREE.PlaneGeometry(x1 - x0, y1 - y0), { pos: [(x0 + x1) / 2, (y0 + y1) / 2, z], keepUv: true });
    const t = g.attributes.uv; for (let i = 0; i < t.count; i++) t.setXY(i, lerp(uv0[0], uv1[0], t.getX(i)), lerp(uv0[1], uv1[1], t.getY(i)));
    return g.applyMatrix4(M);
  };

  // ======== panel 1: the commander's
  {
    const P = mdc;
    P.plate(-1.045, -0.445, -0.305, 0.445); P.plate(-0.86, 0.0, -0.652, 0.44); P.plate(-0.646, -0.004, -0.44, 0.44); P.plate(-0.436, -0.004, -0.305, 0.44);
    // barometric altimeter
    const ax = -0.945, ay = 0.2, ar = 0.058;
    P.dial(ax, ay, ar, (S) => {
      for (let k = 0; k <= 60; k++) { const a = -150 + k * 5; S.tick(ax, ay, a, ar - (k % 5 === 0 ? 0.011 : k % 5 ? 0.006 : 0.008), ar - 0.002, INK, k % 5 === 0 ? 0.0011 : 0.0006); }
      for (let k = 0; k <= 60; k += 10) { const a = (-150 + k * 5) * D2R; S.text(String(k), ax + Math.sin(a) * (ar - 0.019), ay + Math.cos(a) * (ar - 0.019), 0.0055); }
      S.text('ALT', ax, ay + 0.02, 0.0036); S.text('1000 FT', ax, ay - 0.02, 0.003);
    });
    needle('alt', blade(ar - 0.008, 0.0044, 0.0012, 0.012), Mmdc, ax, ay, 0.0042);
    P.text('ALTIMETER', ax, ay - ar - 0.014, 0.003);
    // accelerometer
    const gx = -0.945, gy = 0.062, gr = 0.045;
    P.dial(gx, gy, gr, (S) => {
      for (let k = -2; k <= 20; k++) { const v = k / 2, a = -135 + ((v + 1) / 11) * 270; S.tick(gx, gy, a, gr - (k % 2 === 0 ? 0.009 : 0.005), gr - 0.002, INK, k % 2 === 0 ? 0.001 : 0.0006); }
      for (let v = 0; v <= 10; v += 2) { const a = (-135 + ((v + 1) / 11) * 270) * D2R; S.text(String(v), gx + Math.sin(a) * (gr - 0.0155), gy + Math.cos(a) * (gr - 0.0155), 0.0048); }
      S.text('G', gx, gy + 0.014, 0.005); S.text('ACCEL', gx, gy - 0.017, 0.0026);
    });
    needle('g', blade(gr - 0.007, 0.004, 0.0011, 0.01), Mmdc, gx, gy, 0.0042);
    P.text('ACCEL G', gx, gy - gr - 0.012, 0.003);

    // entry monitor system
    const ex0 = -0.852, ex1 = -0.66;
    P.rect(ex0, 0.008, ex1, 0.432, '#121314', 'rgba(0,0,0,0.6)', 0.0008, 0.004);
    P.text('ENTRY MONITOR', (ex0 + ex1) / 2, 0.423, 0.0029);
    const rx = -0.775, ry = 0.362, rr = 0.04;
    P.dial(rx, ry, rr, (S) => {
      for (let a = 0; a < 360; a += 15) S.tick(rx, ry, a, rr - (a % 45 === 0 ? 0.008 : 0.005), rr - 0.002, INK, a % 45 === 0 ? 0.0009 : 0.0005);
      S.text('0', rx, ry + rr - 0.0135, 0.0036); S.text('18', rx, ry - rr + 0.0135, 0.0036); S.text('9', rx + rr - 0.013, ry, 0.0036); S.text('27', rx - rr + 0.0145, ry, 0.0036);
      S.text('LIFT\nVECTOR', rx, ry - 0.012, 0.002);
    }, 0.005);
    needle('rsi', blade(rr - 0.006, 0.005, 0.0012, 0.008), Mmdc, rx, ry, 0.004);
    P.lamp('g05', -0.697, 0.392, 0.024, 0.014); P.text('.05 G', -0.697, 0.405, 0.0023);
    P.lamp('corrU', -0.703, 0.366, 0.012, 0.012, 0.003, true); P.lamp('corrD', -0.703, 0.342, 0.012, 0.012, 0.003, true);
    P.lamp('sps', -0.697, 0.312, 0.024, 0.014); P.text('SPS THRUST', -0.699, 0.3, 0.0021);
    P.well(-0.84, 0.196, -0.722, 0.298, 0.003); P.text('G', -0.846, 0.247, 0.0026); P.text('V  FT/SEC x 1000', -0.781, 0.19, 0.0021);
    liveQuads.scroll.push(quadAt(Mmdc, -0.838, 0.198, -0.724, 0.296, 0.0008, [0, 0], [1, 1]));
    P.well(-0.822, 0.142, -0.726, 0.174, 0.002); P.text('ΔV / RANGE', -0.774, 0.181, 0.0024); P.text('FT/SEC', -0.774, 0.136, 0.0021);
    liveQuads.timers.push(quadAt(Mmdc, -0.82, 0.144, -0.728, 0.172, 0.0008, [272 / 512, 1 - 185 / 256], [1, 1 - 112 / 256]));
    P.rot(-0.795, 0.07, 'FUNCTION', ['OFF', 'TEST 1', '2', '3', '4', '5', 'RNG SET', 'Vo SET', 'ENTRY', 'ΔV TEST', 'ΔV SET', 'ΔV'], 11, -150, 150, 0.0115, 0.0021);
    P.sw(-0.7, 0.07, 'MODE', 'NORMAL', 'BACKUP/\nVHF RNG', 1, { wick: false }); P.text('STBY', -0.683, 0.07, 0.0021, { align: 'left' });
    P.sw(-0.7, 0.238, 'GTA', '', 'OFF', -1, { guard: 2, wick: false });

    // above the commander's ball: abort and liftoff lights, the event timer
    P.lamp('abort', -0.613, 0.399, 0.034, 0.026); P.lamp('liftoff', -0.574, 0.399, 0.034, 0.026);
    P.well(-0.548, 0.38, -0.452, 0.418, 0.002); P.text('EVENT TIMER', -0.5, 0.428, 0.0028); P.text('MIN', -0.524, 0.3735, 0.0022); P.text('SEC', -0.476, 0.3735, 0.0022);
    liveQuads.timers.push(quadAt(Mmdc, -0.546, 0.382, -0.454, 0.416, 0.0008, [0, 1 - 211 / 256], [267 / 512, 1 - 112 / 256]));
    fdai(-0.535, 0.225, 'a');
    // attitude set
    P.rect(-0.632, 0.002, -0.446, 0.118, '#141516', 'rgba(0,0,0,0.5)', 0.0006, 0.003); P.text('ATTITUDE SET', -0.539, 0.108, 0.0028);
    ['ROLL', 'PITCH', 'YAW'].forEach((n, k) => {
      const x = -0.597 + k * 0.058;
      P.text(n, x, 0.093, 0.0025); P.rect(x - 0.019, 0.062, x + 0.019, 0.084, '#050505', 'rgba(170,175,178,0.5)', 0.0004, 0.0015);
      P.text(['000', '090', '000'][k], x, 0.073, 0.0062, { font: '"DejaVu Sans Mono", Menlo, monospace', color: '#e6e4d6', squeeze: 0.9, track: 0.12 });
      P.rect(x - 0.013, 0.02, x + 0.013, 0.05, '#050505', null, 0, 0.002);
      P.P.add('paint', prim(new THREE.CylinderGeometry(0.0125, 0.0125, 0.02, 22), { rgb: [0.045, 0.045, 0.05], rot: [0, 0, Math.PI / 2], pos: [x, 0.035, -0.0055] }));
      for (let j = -3; j <= 3; j++) P.P.add('paint', box(0.02, 0.0012, 0.002, [x, 0.035 + Math.sin(j * 0.4) * 0.0125, -0.0055 + Math.cos(j * 0.4) * 0.0125], [0.11, 0.11, 0.115], [-j * 0.4, 0, 0]));
    });

    // launch vehicle lights, the master alarm, angle of attack / chamber pressure, tank pressures
    P.text('LV ENGINES', -0.396, 0.428, 0.0026);
    [[-1, 1], [1, 1], [1, -1], [-1, -1], [0, 0]].forEach(([sx, sy], k) => P.lamp('eng' + (k + 1), -0.396 + sx * 0.017, 0.388 + sy * 0.017, 0.019, 0.019, 0.003, true));
    P.lamp('lvrate', -0.333, 0.413, 0.036, 0.015); P.lamp('lvguid', -0.333, 0.394, 0.036, 0.015); P.lamp('s2sep', -0.333, 0.375, 0.036, 0.015);
    P.lamp('master', -0.333, 0.338, 0.034, 0.03, 0.006);
    const qx = -0.395, qy = 0.292, qr = 0.036;
    P.dial(qx, qy, qr, (S) => {
      for (let k = 0; k <= 15; k++) { const a = -130 + (k / 15) * 260; S.tick(qx, qy, a, qr - (k % 5 === 0 ? 0.008 : 0.0045), qr - 0.002, INK, k % 5 === 0 ? 0.001 : 0.0006); }
      for (const v of [0, 50, 100, 150]) { const a = (-130 + (v / 150) * 260) * D2R; S.text(String(v), qx + Math.sin(a) * (qr - 0.014), qy + Math.cos(a) * (qr - 0.014), 0.0036); }
      S.text('%', qx, qy + 0.0105, 0.003); S.text('LV α', qx, qy - 0.009, 0.0026); S.text('SPS Pc', qx, qy - 0.0165, 0.0024);
    }, 0.0055);
    needle('aoa', blade(qr - 0.006, 0.0036, 0.001, 0.008), Mmdc, qx, qy, 0.0042);
    P.text('LV α / SPS Pc', qx, qy - qr - 0.0105, 0.0026);
    P.rect(-0.432, 0.128, -0.31, 0.236, '#141516', 'rgba(0,0,0,0.5)', 0.0006, 0.003);
    P.text('S-II', -0.4, 0.2285, 0.0024); P.text('S-IVB', -0.342, 0.2285, 0.0024);
    [-0.4135, -0.3865, -0.3555, -0.3285].forEach((x, k) => {
      P.well(x - 0.0085, 0.148, x + 0.0085, 0.22, 0.0015);
      P.D(x, 0.18, (S) => { for (let j = 0; j <= 10; j++) { const yy = 0.153 + j * 0.0062, l = j % 5 === 0 ? 0.0042 : 0.0024; S.line([[x - 0.0075, yy], [x - 0.0075 + l, yy]], INK, j % 5 === 0 ? 0.0006 : 0.0004); } S.text(['0', '25', '50'][0], x + 0.0045, 0.153, 0.0019); S.text('25', x + 0.0045, 0.184, 0.0019); S.text('50', x + 0.0045, 0.215, 0.0019); });
      P.text(k % 2 ? 'OXID' : 'FUEL', x, 0.1415, 0.0021);
      needle('tp' + k, [[-0.0075, 0], [-0.002, 0.0022], [-0.002, -0.0022]], Mmdc, x, 0.153, 0.0012);
    });
    P.text('PRESS  PSIA', -0.371, 0.1335, 0.002);
    // the checklist card by the computer: what its registers show
    P.rect(-0.431, 0.002, -0.309, 0.122, 'rgba(0,0,0,0.35)', null, 0, 0.001); P.rect(-0.43, 0.004, -0.31, 0.121, '#b3ae9d', null, 0, 0.001);
    P.D(-0.37, 0.06, (S) => { const g = S.g, gd = g.createLinearGradient(S.X(-0.43), 0, S.X(-0.31), 0); gd.addColorStop(0, 'rgba(255,255,255,0.08)'); gd.addColorStop(1, 'rgba(0,0,0,0.1)'); g.fillStyle = gd; g.fillRect(S.X(-0.43), S.Y(0.121), 0.12 * S.k, 0.117 * S.k); });
    for (const [x, y] of [[-0.3165, 0.1155], [-0.3165, 0.0095]]) P.rect(x - 0.005, y - 0.004, x + 0.005, y + 0.004, '#3c4b7a');
    const card = (s, y, o = {}) => P.text(s, o.x ?? -0.424, y, o.h ?? 0.0037, { color: '#15161a', align: o.align || 'left', weight: o.w || 600, squeeze: 0.8, track: 0.02 });
    card('CMC DISPLAYS', 0.1105, { x: -0.37, align: 'center', w: 700 });
    card('V16 N62  BOOST', 0.097, { w: 800 }); card('R1 VELOCITY  FT/S', 0.0865); card('R2 ALT RATE  FT/S', 0.076); card('R3 ALTITUDE  .1 NM', 0.0655);
    card('V16 N44  ORBIT', 0.052, { w: 800 }); card('R1 APOGEE  .1 NM', 0.0415); card('R2 PERIGEE  .1 NM', 0.031); card('R3 TO NEXT  MIN SEC', 0.0205);

    // the switches
    const x0 = -1.005, p = 0.04, X = (i) => x0 + i * p;
    let y = -0.062;
    P.title('ATTITUDE', X(0) - 0.016, X(4) + 0.016, y + 0.043); P.title('MANUAL ATTITUDE', X(5) - 0.016, X(7) + 0.016, y + 0.043); P.title('ROT CONTR PWR', X(12) - 0.016, X(15) + 0.016, y + 0.043);
    P.row(y, x0, p, [['CMC ATT', 'IMU', 'GDC', 1], ['FDAI SCALE', '5/1', '50/15', 0], ['FDAI SELECT', '1/2', '1', 1], ['FDAI SOURCE', 'CMC', 'GDC', 1], ['ATT SET', 'IMU', 'GDC', 1],
      ['ROLL', 'ACCEL CMD', 'MIN IMP', 0], ['PITCH', 'ACCEL CMD', 'MIN IMP', 0], ['YAW', 'ACCEL CMD', 'MIN IMP', 0],
      ['LIMIT\nCYCLE', '', 'OFF', -1], ['ATT\nDEADBAND', 'MAX', 'MIN', -1], ['RATE', 'HIGH', 'LOW', -1], ['TRANS\nCONTR PWR', '', 'OFF', 1],
      ['NORMAL 1', 'AC/DC', 'AC', 1], ['NORMAL 2', 'AC/DC', 'AC', 1], ['DIRECT 1', 'MNA/MNB', 'MNA', 0], ['DIRECT 2', 'MNA/MNB', 'MNB', 0]]);
    y = -0.13;
    P.title('BMAG MODE', X(2) - 0.016, X(4) + 0.016, y + 0.043); P.title('SPS THRUST', X(5) - 0.016, X(7) + 0.016, y + 0.043); P.title('SCS TVC', X(8) - 0.016, X(9) + 0.016, y + 0.043); P.title('SPS GMBL MOTORS', X(10) - 0.016, X(13) + 0.016, y + 0.043);
    P.row(y, x0, p, [['SC CONT', 'CMC', 'SCS', 1], ['CMC MODE', 'AUTO', 'FREE', 1],
      ['ROLL', 'RATE 2', 'RATE 1', 0], ['PITCH', 'RATE 2', 'RATE 1', 0], ['YAW', 'RATE 2', 'RATE 1', 0],
      ['DIRECT', 'ON', 'NORMAL', -1, { guard: 1 }], ['ΔV THRUST A', 'NORMAL', 'OFF', -1, { guard: 2 }], ['ΔV THRUST B', 'NORMAL', 'OFF', -1, { guard: 2 }],
      ['PITCH', 'AUTO', 'ACCEL CMD', 1], ['YAW', 'AUTO', 'ACCEL CMD', 1],
      ['PITCH 1', 'START', 'OFF', -1], ['YAW 1', 'START', 'OFF', -1], ['PITCH 2', 'START', 'OFF', -1], ['YAW 2', 'START', 'OFF', -1],
      ['ΔV CG', 'LM/CSM', 'CSM', 1], ['ELS LOGIC', '', 'OFF', -1, { guard: 1 }]]);
    y = -0.198;
    P.title('CM RCS', X(1) - 0.016, X(3) + 0.016, y + 0.043); P.title('ENTRY', X(5) - 0.016, X(6) + 0.016, y + 0.043); P.title('LV/SPS IND', X(7) - 0.016, X(8) + 0.016, y + 0.043); P.title('TVC GMBL DRIVE', X(9) - 0.016, X(10) + 0.016, y + 0.043); P.title('EVENT TIMER', X(11) - 0.016, X(14) + 0.016, y + 0.043);
    P.row(y, x0, p, [['ELS', 'AUTO', 'MAN', 1], ['LOGIC', '', 'OFF', -1, { guard: 1 }], ['PRPLNT\nDUMP', '', 'OFF', -1, { guard: 1 }], ['PRPLNT\nPURG', '', 'OFF', -1, { guard: 1 }],
      ['IMU CAGE', '', 'OFF', -1, { guard: 1 }], ['EMS ROLL', '', 'OFF', -1], ['.05 G', '', 'OFF', -1],
      ['', 'Pc', 'α', -1], ['', 'SII/SIVB', 'GPI', 1], ['PITCH', '1', '2', 0], ['YAW', '1', '2', 0],
      ['', 'RESET', 'DOWN', 0], ['', 'START', 'STOP', 0], ['MIN', 'TENS', 'UNITS', 0], ['SEC', 'TENS', 'UNITS', 0], null]);
    y = -0.266;
    P.title('CSM/LM FINAL SEP', X(1) - 0.016, X(2) + 0.016, y + 0.043); P.title('CM/SM SEP', X(3) - 0.016, X(4) + 0.016, y + 0.043); P.title('TWR JETT', X(9) - 0.016, X(10) + 0.016, y + 0.043); P.title('LAUNCH VEHICLE', X(11) - 0.016, X(13) + 0.016, y + 0.043);
    P.row(y, x0, p, [['EDS', 'AUTO', 'OFF', 1], ['1', '', 'OFF', -1, { guard: 1 }], ['2', '', 'OFF', -1, { guard: 1 }], ['1', '', 'OFF', -1, { guard: 1 }], ['2', '', 'OFF', -1, { guard: 1 }], ['S-IVB/LM\nSEP', '', 'OFF', -1, { guard: 1 }],
      ['PRPLNT\nDUMP', 'AUTO', 'RCS CMD', 1], ['2 ENG OUT', 'AUTO', 'OFF', 1], ['LV RATES', 'AUTO', 'OFF', 1],
      ['1', 'AUTO', 'OFF', 1, { guard: 2 }], ['2', 'AUTO', 'OFF', 1, { guard: 2 }], ['GUIDANCE', 'IU', 'CMC', 1], ['S-II/S-IVB', 'LV STAGE', 'OFF', -1], ['XLUNAR', 'INJECT', 'SAFE', 1],
      ['MAIN\nRELEASE', '', 'OFF', -1, { guard: 1 }], null]);
    y = -0.352;
    P.title('SEQUENCE EVENTS  MANUAL', X(0) - 0.012, X(0) + 6 * 0.056 + 0.012, y + 0.03);
    ['LES\nMOTOR\nFIRE', 'CANARD\nDEPLOY', 'CSM/LV\nSEP', 'APEX\nCOVER\nJETT', 'DROGUE\nDEPLOY', 'MAIN\nDEPLOY', 'CM RCS\nHe DUMP'].forEach((s, k) => {
      const x = X(0) + k * 0.056;
      P.pb(x, y, 0.026, 0.026, s, '#c9c6b8', '#16171a', 0.0023, 0.005);
      P.P.add('paint', block(x - 0.018, y - 0.018, x + 0.018, y - 0.0155, 0, 0.012, null, [0.33, 0.34, 0.35], [0.33, 0.34, 0.35]), block(x - 0.018, y + 0.0155, x + 0.018, y + 0.018, 0, 0.012, null, [0.33, 0.34, 0.35], [0.33, 0.34, 0.35]),
        block(x - 0.018, y - 0.018, x - 0.0155, y + 0.018, 0, 0.012, null, [0.33, 0.34, 0.35], [0.33, 0.34, 0.35]), block(x + 0.0155, y - 0.018, x + 0.018, y + 0.018, 0, 0.012, null, [0.33, 0.34, 0.35], [0.33, 0.34, 0.35]));
    });
    P.pb(X(11), y, 0.03, 0.03, 'THRUST\nON', '#d9d7ca', '#16171a', 0.0026); P.pb(X(13), y, 0.03, 0.03, 'DIRECT\nULLAGE', '#d9d7ca', '#16171a', 0.0026);
    P.text('SPS', X(12), y + 0.03, 0.003);
    P.text('MDC-1', -0.4, -0.428, 0.0026, { color: 'rgba(240,239,232,0.75)' });
  }

  // ======== panel 2: the center
  {
    const P = mdc;
    P.plate(-0.295, -0.445, 0.345, 0.445); P.plate(-0.262, -0.068, -0.038, 0.166);
    P.well(-0.218, 0.384, -0.082, 0.424, 0.002); P.text('MISSION TIMER', -0.15, 0.433, 0.0028); P.text('HOURS', -0.193, 0.3775, 0.0022); P.text('MIN', -0.143, 0.3775, 0.0022); P.text('SEC', -0.102, 0.3775, 0.0022);
    liveQuads.timers.push(quadAt(Mmdc, -0.216, 0.386, -0.084, 0.422, 0.0008, [0, 1 - 104 / 256], [384 / 512, 1]));
    fdai(-0.15, 0.268, 'b');

    // the DSKY
    const dx = -0.25, dy = -0.06, dw = 0.2, dh = 0.218, zF = 0.008, i = P.si(dx + 0.1, dy + 0.1), S = P.sheets[i];
    S.rect(dx - 0.003, dy - 0.003, dx + dw + 0.003, dy + dh + 0.003, 'rgba(0,0,0,0.4)', null, 0, 0.006);
    S.rect(dx, dy, dx + dw, dy + dh, '#8e9495', 'rgba(30,32,34,0.6)', 0.0006, 0.004);
    for (const [sx, sy] of [[0.006, 0.006], [dw - 0.006, 0.006], [0.006, dh - 0.006], [dw - 0.006, dh - 0.006], [dw / 2, 0.006], [dw / 2, dh - 0.006]]) P.screw(dx + sx, dy + sy, 0.0022);
    S.rect(dx + 0.011, dy + 0.097, dx + 0.079, dy + 0.207, '#050505', 'rgba(20,20,20,0.8)', 0.0006, 0.002);
    S.rect(dx + 0.087, dy + 0.097, dx + 0.19, dy + 0.207, '#050505', 'rgba(20,20,20,0.8)', 0.0006, 0.002);
    P.P.add('t' + i, block(dx, dy, dx + dw, dy + dh, 0, zF, S.uv, [0.2, 0.21, 0.215], [1, 1, 1], S.bl));
    liveQuads.dsky.push(quadAt(Mmdc, dx + 0.0125, dy + 0.0985, dx + 0.0775, dy + 0.2055, zF + 0.0006, [0, 0], [306 / 1024, 1]), quadAt(Mmdc, dx + 0.0885, dy + 0.0985, dx + 0.1885, dy + 0.2055, zF + 0.0006, [320 / 1024, 0], [790 / 1024, 1]));
    P.P.add('glassI', block(dx + 0.011, dy + 0.097, dx + 0.19, dy + 0.207, zF + 0.0014, zF + 0.0016, null));
    const kw = 0.0212, kp = 0.0256, kx = dx + 0.0105 + kw / 2, kr = [dy + 0.0715, dy + 0.047, dy + 0.0225];
    const key = (col, rowF, leg, small) => {
      const x = kx + col * kp, y = lerp(kr[Math.floor(rowF)], kr[Math.min(2, Math.floor(rowF) + 1)], rowF % 1);
      S.rect(x - kw / 2 - 0.001, y - kw / 2 - 0.001, x + kw / 2 + 0.001, y + kw / 2 + 0.001, '#0b0b0c', null, 0, 0.002);
      S.rect(x - kw / 2, y - kw / 2, x + kw / 2, y + kw / 2, '#2c2e30', 'rgba(120,124,126,0.5)', 0.0004, 0.0018);
      S.text(leg, x, y, small ? 0.0031 : 0.0068, { color: '#f2f1ea', weight: small ? 700 : 600 });
      P.P.add('t' + i, block(x - kw / 2, y - kw / 2, x + kw / 2, y + kw / 2, zF, zF + 0.0055, S.uv, [0.05, 0.05, 0.055], [1, 1, 1], S.bl));
    };
    key(0, 0.5, 'VERB', 1); key(0, 1.5, 'NOUN', 1); key(6, 0.5, 'ENTR', 1); key(6, 1.5, 'RSET', 1);
    ['+', '−', '0'].forEach((s, r) => key(1, r, s)); ['7', '4', '1'].forEach((s, r) => key(2, r, s)); ['8', '5', '2'].forEach((s, r) => key(3, r, s)); ['9', '6', '3'].forEach((s, r) => key(4, r, s));
    ['CLR', 'PRO', 'KEY\nREL'].forEach((s, r) => key(5, r, s, 1));

    // caution and warning
    P.text('CAUTION / WARNING', 0.155, 0.4375, 0.0028);
    P.rect(0.0, 0.352, 0.31, 0.43, '#060607', 'rgba(170,175,178,0.4)', 0.0005, 0.002);
    P.lamps.push({ id: 'cw', x: 0.155, y: 0.391, w: 0.306, h: 0.074, z: 0.003, M: Mmdc });
    // meters: reaction control, cryogenics, environment
    P.title('SM RCS', 0.008, 0.16, 0.341);
    [['TEMP\nPKG', [0.55]], ['He\nPRESS', [0.72]], ['SEC\nFUEL', [0.6]], ['PRPLNT\nQTY', [0.86]]].forEach(([n, v], k) => P.vmeter(0.022 + k * 0.042, 0.283, n, v, null));
    P.rot(0.218, 0.282, 'RCS INDICATORS', ['CM 1', '2', 'SM A', 'B', 'C', 'D'], 2, -100, 100, 0.0095);
    [['CM RCS\nHe', [0.7, 0.68]], ['MANF', [0.62, 0.6]]].forEach(([n, v], k) => P.vmeter(0.283 + k * 0.042, 0.283, n, v, '1  2'));
    P.title('CRYOGENIC TANKS', 0.008, 0.16, 0.232);
    [['PRESS\nH2', [0.5, 0.52]], ['PRESS\nO2', [0.68, 0.66]], ['QTY\nH2', [0.88, 0.86]], ['QTY\nO2', [0.9, 0.91]]].forEach(([n, v], k) => P.vmeter(0.022 + k * 0.042, 0.176, n, v, '1  2'));
    [['ECS RAD\nTEMP', [0.4, 0.3], 'PRIM SEC'], ['GLY EVAP', [0.45, 0.2], 'TEMP PRESS'], ['TEMP', [0.5, 0.52], 'SUIT CABIN'], ['PRESS', [0.33, 0.36], 'SUIT CABIN'], ['PART\nPRESS', [0.12], 'CO2']].forEach(([n, v, s], k) => P.vmeter(0.19 + k * 0.0365, 0.176, n, v, null));
    P.text('SUIT  CABIN', 0.281, 0.1365, 0.002); P.text('CO2', 0.336, 0.1365, 0.002); P.text('PRIM SEC', 0.19, 0.1365, 0.0019); P.text('T    P', 0.2265, 0.1365, 0.002);
    // reaction control switches, with their talkbacks
    const x0 = -0.005, p = 0.04, X = (k) => x0 + k * p;
    let y = 0.035;
    P.title('SM RCS HELIUM 1', X(0) - 0.016, X(3) + 0.016, y + 0.062); P.title('SM RCS PRIM PRPLNT', X(4) - 0.016, X(7) + 0.016, y + 0.062);
    P.row(y, x0, p, ['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D'].map((n, k) => [n, 'OPEN', 'CLOSE', 0, { tb: k === 6 ? 1 : 0 }]));
    y = -0.045;
    P.title('SM RCS HEATERS', X(0) - 0.016, X(3) + 0.016, y + 0.043); P.title('CM RCS PRPLNT', X(6) - 0.016, X(7) + 0.016, y + 0.043);
    P.row(y, x0, p, [['A', 'PRIM', 'SEC', 1], ['B', 'PRIM', 'SEC', 1], ['C', 'PRIM', 'SEC', 1], ['D', 'PRIM', 'SEC', 1], ['RCS CMD', 'ON', 'OFF', 0], ['RCS TRNFR', 'CM', 'SM', -1], ['1', 'ON', 'OFF', -1], ['2', 'ON', 'OFF', -1]]);
    P.sw(X(8), 0.035, 'CM RCS\nPRESS', '', 'OFF', -1, { guard: 1 });
    // the full-width rows under the DSKY
    const fx = -0.275, FX = (k) => fx + k * p;
    y = -0.13;
    P.title('CAUTION/WARNING', FX(0) - 0.016, FX(3) + 0.016, y + 0.043); P.title('MISSION TIMER', FX(4) - 0.016, FX(7) + 0.016, y + 0.043); P.title('DOCKING PROBE', FX(8) - 0.016, FX(10) + 0.016, y + 0.043); P.title('EXTERIOR LIGHTS', FX(11) - 0.016, FX(12) + 0.016, y + 0.043);
    P.row(y, fx, p, [['', 'NORMAL', 'ACK', 0], ['', 'CSM', 'CM', 1], ['POWER', '1', '2', 1], ['LAMP TEST', '1', '2', 0],
      ['HOURS', 'TENS', 'UNITS', 0], ['MIN', 'TENS', 'UNITS', 0], ['SEC', 'TENS', 'UNITS', 0], ['', 'START', 'RESET', 1],
      ['EXTD/REL', '', 'RETRACT', 0, { guard: 2 }], ['RETRACT\nPRIM', '1', '2', 0], ['RETRACT\nSEC', '1', '2', 0], ['RUN/EVA', '', 'OFF', -1], ['RNDZ/SPOT', 'RNDZ', 'SPOT', 0],
      ['TUNNEL\nLIGHTS', '', 'OFF', -1], ['LM PWR', 'CSM', 'RESET', 0], ['UP TLM', 'ACCEPT', 'BLOCK', -1]]);
    y = -0.198;
    P.title('SM RCS HELIUM 2', FX(0) - 0.016, FX(3) + 0.016, y + 0.043); P.title('SM RCS SEC FUEL PRESS', FX(4) - 0.016, FX(7) + 0.016, y + 0.043); P.title('CABIN FAN', FX(8) - 0.016, FX(9) + 0.016, y + 0.043); P.title('H2 HEATERS', FX(10) - 0.016, FX(11) + 0.016, y + 0.043); P.title('O2 HEATERS', FX(12) - 0.016, FX(13) + 0.016, y + 0.043);
    P.row(y, fx, p, [...['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D'].map((n) => [n, 'OPEN', 'CLOSE', 0]), ['1', '', 'OFF', 1], ['2', '', 'OFF', -1], ['1', 'AUTO', 'ON', 1], ['2', 'AUTO', 'ON', 1], ['1', 'AUTO', 'ON', 1], ['2', 'AUTO', 'ON', 1], ['O2 PRESS\nIND', 'TANK 1', 'SURGE', 1], ['H2 PURGE\nLINE HTR', '', 'OFF', -1]]);
    y = -0.266;
    P.title('H2 FANS', FX(0) - 0.016, FX(1) + 0.016, y + 0.043); P.title('O2 FANS', FX(2) - 0.016, FX(3) + 0.016, y + 0.043); P.title('ECS RADIATORS', FX(4) - 0.016, FX(8) + 0.016, y + 0.043); P.title('SUIT CIRCUIT', FX(10) - 0.016, FX(12) + 0.016, y + 0.043); P.title('SEC COOLANT LOOP', FX(13) - 0.016, FX(14) + 0.016, y + 0.043);
    P.row(y, fx, p, [['1', 'AUTO', 'ON', 1], ['2', 'AUTO', 'ON', 1], ['1', 'AUTO', 'ON', 1], ['2', 'AUTO', 'ON', 1],
      ['FLOW CONT', 'AUTO', '2', 1], ['FLOW CONT\nPWR', '', 'OFF', 1], ['MAN SEL', 'RAD 1', 'RAD 2', 0], ['HEATER\nPRIM', '1', '2', 0], ['HEATER\nSEC', '', 'OFF', -1],
      ['POT H2O\nHTR', 'MNA', 'MNB', 0], ['H2O ACCUM', 'AUTO 1', 'AUTO 2', 1], ['HEAT EXCH', 'ON', 'BYPASS', 1], ['SUIT\nCOMPR', '1', '2', 1], ['EVAP', '', 'RESET', 0], ['PUMP', 'AC1', 'AC2', 0], ['CABIN TEMP', 'AUTO', 'MAN', 1]]);
    y = -0.334;
    P.title('HIGH GAIN ANTENNA', FX(0) - 0.016, FX(3) + 0.016, y + 0.043); P.title('GLYCOL EVAP', FX(8) - 0.016, FX(10) + 0.016, y + 0.043);
    P.row(y, fx, p, [['TRACK', 'AUTO', 'REACQ', 0], ['BEAM', 'WIDE', 'NARROW', 0], ['PWR', '', 'STBY', -1], ['SERVO\nELEC', 'PRIM', 'SEC', 1], null, null, null, null,
      ['TEMP IN', 'AUTO', 'MAN', 1], ['STEAM\nPRESS', 'AUTO', 'MAN', 1], ['H2O FLOW', 'AUTO', 'ON', 1], null, null, null, null, null]);
    P.rot(FX(5), y - 0.022, 'PITCH POSITION', ['-90', '-60', '-30', '0', '30', '60', '90'], 3, -110, 110, 0.0095); P.rot(FX(6.75), y - 0.022, 'YAW POSITION', ['0', '90', '180', '270'], 1, -110, 110, 0.0095);
    P.rot(FX(12), y - 0.022, 'S BAND ANT', ['OMNI A', 'B', 'C', 'D', 'HI GAIN'], 1, -100, 100, 0.0095);
    P.vmeter(FX(14.4), y - 0.012, 'S BAND\nAGC', [0.62], null, 0.058);
    P.text('MDC-2', 0.3, -0.428, 0.0026, { color: 'rgba(240,239,232,0.75)' });
  }

  // ======== panel 3: the systems
  {
    const P = mdc;
    P.plate(0.355, -0.445, 1.045, 0.445);
    P.lamp('master2', 0.39, 0.4, 0.034, 0.03, 0.006);
    P.title('SPS PRPLNT TANKS', 0.42, 0.6, 0.428);
    [['TEMP', [0.5]], ['He\nPRESS', [0.7]], ['N2', [0.6, 0.62]], ['PRESS', [0.55, 0.57]]].forEach(([n, v], k) => P.vmeter(0.443 + k * 0.045, 0.362, n, v, k === 2 ? 'A  B' : k === 3 ? 'FUEL OXID' : null));
    P.well(0.632, 0.372, 0.69, 0.394, 0.002); P.well(0.632, 0.335, 0.69, 0.357, 0.002);
    P.text('OXID', 0.661, 0.4, 0.0024); P.text('FUEL', 0.661, 0.363, 0.0024); P.text('QUANTITY  %', 0.661, 0.326, 0.0022);
    P.text('99.4', 0.661, 0.383, 0.0075, { font: '"DejaVu Sans Mono", Menlo, monospace', color: '#e8e6d8' }); P.text('99.6', 0.661, 0.346, 0.0075, { font: '"DejaVu Sans Mono", Menlo, monospace', color: '#e8e6d8' });
    const rd = (x, y, r, name, lo, hi, step, v, unit) => {
      P.dial(x, y, r, (S) => {
        const n = Math.round((hi - lo) / step);
        for (let k = 0; k <= n * 2; k++) { const a = -120 + (k / (n * 2)) * 240; S.tick(x, y, a, r - (k % 2 === 0 ? 0.007 : 0.004), r - 0.002, INK, k % 2 === 0 ? 0.0009 : 0.0005); }
        for (let k = 0; k <= n; k++) { const a = (-120 + (k / n) * 240) * D2R; S.text(String(lo + k * step), x + Math.sin(a) * (r - 0.0125), y + Math.cos(a) * (r - 0.0125), 0.003); }
        S.text(unit, x, y - 0.011, 0.0028);
        const a = (-120 + ((v - lo) / (hi - lo)) * 240) * D2R; S.line([[x - Math.sin(a) * 0.006, y - Math.cos(a) * 0.006], [x + Math.sin(a) * (r - 0.006), y + Math.cos(a) * (r - 0.006)]], '#f2f0e4', 0.0012, 'round'); S.disc(x, y, 0.0032, '#1c1c1d', '#555', 0.0003);
      }, 0.005);
      P.text(name, x, y - r - 0.011, 0.0027);
    };
    rd(0.745, 0.375, 0.03, 'UNBAL', -6, 6, 3, 0.4, 'LB x100');
    P.title('FUEL CELL', 0.42, 0.56, 0.305);
    [['FLOW', [0.4, 0.42], 'H2  O2'], ['MODULE\nTEMP', [0.6, 0.5], 'SKIN EXH']].forEach(([n, v, s], k) => P.vmeter(0.443 + k * 0.045, 0.24, n, v, s));
    P.rot(0.54, 0.245, 'INDICATOR', ['1', '2', '3'], 1, -60, 60, 0.0095);
    rd(0.635, 0.245, 0.032, 'DC VOLTS', 20, 40, 5, 28.6, 'VOLTS'); rd(0.72, 0.245, 0.032, 'DC AMPS', 0, 100, 25, 24, 'AMPS'); rd(0.805, 0.245, 0.032, 'AC VOLTS', 90, 130, 10, 115, 'VOLTS');
    P.rot(0.89, 0.255, 'DC INDICATORS', ['FC 1', '2', '3', 'MN A', 'MN B', 'BAT A', 'B', 'C'], 3, -130, 130, 0.0095); P.rot(0.975, 0.2, 'AC IND', ['BUS 1 ϕA', 'ϕB', 'ϕC', 'BUS 2 ϕA', 'ϕB', 'ϕC'], 0, -120, 120, 0.0085, 0.002);
    const x0 = 0.385, p = 0.04, X = (k) => x0 + k * p;
    let y = 0.1;
    P.title('FUEL CELL MAIN BUS A', X(0) - 0.016, X(2) + 0.016, y + 0.062); P.title('MAIN BUS B', X(3) - 0.016, X(5) + 0.016, y + 0.062); P.title('REACTANTS', X(6) - 0.016, X(8) + 0.016, y + 0.062); P.title('RADIATORS', X(9) - 0.016, X(11) + 0.016, y + 0.062); P.title('PURGE', X(12) - 0.016, X(14) + 0.016, y + 0.043);
    P.row(y, x0, p, [...[1, 2, 3, 1, 2, 3].map((n, k) => [String(n), 'ON', 'OFF', 0, { tb: k === 5 ? 1 : 0 }]), ...[1, 2, 3].map((n) => [String(n), 'ON', 'OFF', 0, { tb: 0 }]), ...[1, 2, 3].map((n) => [String(n), 'NORMAL', 'BYPASS', 1, { tb: 0 }]), ...[1, 2, 3].map((n) => [String(n), 'H2', 'O2', 0])]);
    y = 0.006;
    P.title('AC INVERTER', X(0) - 0.016, X(2) + 0.016, y + 0.043); P.title('INVERTER 1 2 3  AC BUS 1', X(3) - 0.016, X(5) + 0.016, y + 0.043); P.title('AC BUS 2', X(6) - 0.016, X(8) + 0.016, y + 0.043); P.title('MAIN BUS TIE', X(11) - 0.016, X(12) + 0.016, y + 0.043);
    P.row(y, x0, p, [['1', 'MN A', 'OFF', 1], ['2', 'MN B', 'OFF', 1], ['3', 'MN A', 'MN B', 0], ['1', 'ON', 'OFF', 1], ['2', 'ON', 'OFF', -1], ['3', 'ON', 'OFF', -1], ['1', 'ON', 'OFF', -1], ['2', 'ON', 'OFF', 1], ['3', 'ON', 'OFF', -1],
      ['AC BUS 1', 'RESET', 'OFF', 0], ['AC BUS 2', 'RESET', 'OFF', 0], ['BAT A/C', 'ON', 'OFF', 0], ['BAT B/C', 'ON', 'OFF', 0], ['NONESS\nBUS', 'MN A', 'MN B', 0], ['BAT CHGR', 'AC 1', 'AC 2', 1]]);
    y = -0.062;
    P.title('S BAND NORMAL', X(0) - 0.016, X(5) + 0.016, y + 0.043); P.title('S BAND AUX', X(6) - 0.016, X(7) + 0.016, y + 0.043); P.title('UP TLM', X(8) - 0.016, X(9) + 0.016, y + 0.043); P.title('S BAND ANTENNA', X(10) - 0.016, X(12) + 0.016, y + 0.043);
    P.row(y, x0, p, [['XPNDR', 'PRIM', 'SEC', 1], ['PWR AMPL', 'PRIM', 'SEC', 1], ['PWR AMPL', 'HIGH', 'LOW', 1], ['MODE', 'VOICE', 'RELAY', 1], ['MODE', 'PCM', 'KEY', 1], ['MODE', 'RANGING', 'OFF', 1],
      ['TAPE', '', 'DN VOICE BU', 0], ['TV', '', 'SCI', 0], ['DATA', '', 'UP VOICE BU', 1], ['CMD', 'NORM', 'RESET', 1], ['OMNI', 'A', 'B', -1], ['OMNI', 'C', 'D', 0], ['', 'OMNI', 'HIGH GAIN', 1], ['SQUELCH', 'A', 'B', 0], ['PWR SCE', 'NORMAL', 'AUX', 1]]);
    y = -0.13;
    P.title('VHF AM', X(0) - 0.016, X(2) + 0.016, y + 0.043); P.title('TAPE RECORDER', X(5) - 0.016, X(7) + 0.016, y + 0.043); P.title('POWER', X(8) - 0.016, X(9) + 0.016, y + 0.043);
    P.row(y, x0, p, [['A', 'DUPLEX', 'SIMPLEX', 1], ['B', 'DUPLEX', 'SIMPLEX', 0], ['RCV ONLY', 'B DATA', 'A', 0], ['VHF BCN', 'ON', 'OFF', -1], ['VHF RNG', 'ON', 'OFF', -1],
      ['', 'PCM/ANLG', 'LBR', 1], ['', 'RECORD', 'PLAY', 0], ['', 'FWD', 'REWIND', 0], ['SCE', 'NORMAL', 'AUX', 1], ['PMP', 'NORMAL', 'AUX', 1], ['PCM\nBIT RATE', 'HIGH', 'LOW', 1], ['VHF\nANTENNA', 'SM LEFT', 'SM RIGHT', 1], ['TELCOM\nGROUP 1', 'AC 1', 'AC 2', 1], ['TELCOM\nGROUP 2', 'AC 1', 'AC 2', -1], null]);
    y = -0.198;
    P.title('SERVICE PROPULSION SYSTEM', X(0) - 0.016, X(8) + 0.016, y + 0.043); P.title('FLOOD', X(11) - 0.016, X(12) + 0.016, y + 0.043);
    P.row(y, x0, p, [['LINE HTRS', 'A/B', 'A', 0], ['PRESS IND', 'He', 'N2 B', 1], ['PUG MODE', 'PRIM', 'AUX', 1], ['He VLV 1', 'AUTO', 'ON', 1, { tb: 1 }], ['He VLV 2', 'AUTO', 'ON', 1, { tb: 1 }],
      ['OXID\nFLOW VLV', 'INCR', 'DECR', 0], ['OXID\nFLOW VLV', 'PRIM', 'SEC', 1], ['TEST', '1', '2', 0], ['SPS ENG\nINJ VLV', '', '', 0, { wick: false }], null, null, ['DIM', '1', '2', 1], ['', 'FIXED', 'POST LDG', 0], null, null]);
    y = -0.266;
    P.title('BATTERY CHARGE', X(0) - 0.016, X(1) + 0.016, y + 0.043); P.title('CRYOGENIC FAN MOTORS', X(3) - 0.016, X(6) + 0.016, y + 0.043);
    P.rot(X(0.5), y - 0.004, '', ['OFF', 'A', 'B', 'C'], 0, -90, 90, 0.0095);
    P.row(y, x0, p, [null, null, null, ['TANK 1 AC1', 'ϕA', '', 1], ['TANK 1 AC1', 'ϕB', '', 1], ['TANK 2 AC2', 'ϕA', '', 1], ['TANK 2 AC2', 'ϕB', '', 1], null, ['FC PUMPS\n1', 'AC 1', 'AC 2', 1], ['2', 'AC 1', 'AC 2', 1], ['3', 'AC 1', 'AC 2', -1], ['G/N PWR', 'AC 1', 'AC 2', 1], ['MAIN BUS\nA RESET', '', '', 0], ['B RESET', '', '', 0], null]);
    P.text('MDC-3', 0.42, -0.428, 0.0034, { color: 'rgba(240,239,232,0.75)' });
  }

  // the plates themselves, and the box behind them
  const corner = [[0.25, -0.23, 0.3085], [-0.25, -0.23, 0.3085], [1, 1, 1.35], [-1, 1, 1.35]];
  sheets[0].blankAt(-1.04, 0.44); sheets[1].blankAt(-0.15, 0.268); sheets[2].blankAt(1.04, 0.44);
  sheets.forEach((S, i) => { G.add('mdc' + i, plateGeo(S.x0, S.y0, S.x1, S.y1, Math.round((S.x1 - S.x0) / 0.05), 18, S.uv, corner).applyMatrix4(Mmdc)); });
  put('paint', Mmdc, block(-1.048, -0.298, 1.048, 0.198, -0.11, -0.0005, null, [0.12, 0.125, 0.13], [0.12, 0.125, 0.13]), block(-0.818, -0.448, 0.818, 0.448, -0.11, -0.0005, null, [0.12, 0.125, 0.13], [0.12, 0.125, 0.13]));
  // a rolled edge round the console: where the hands rest and nothing snags
  {
    const out = [[-1.05, -0.3], [-0.9, -0.45], [0.9, -0.45], [1.05, -0.3], [1.05, 0.2], [0.82, 0.45], [-0.82, 0.45], [-1.05, 0.2]];
    out.forEach((a, k) => { const b = out[(k + 1) % out.length]; put('paint', Mmdc, rod([a[0], a[1], -0.004], [b[0], b[1], -0.004], 0.009, [0.33, 0.345, 0.35], 6)); });
  }

  // ======== the wings either side: breakers, attitude jets, lighting
  const wing = (side) => {
    const Xw = [0.581, 0, -0.814 * side], Nw = [0.814 * side, 0, 0.581];
    const M = new THREE.Matrix4().multiplyMatrices(Mmdc, mB(Xw, [0, 1, 0], Nw).setPosition(-1.15 * side, -0.06, 0.14));
    const S = new Sheet(-0.172, -0.24, 0.172, 0.24, side > 0 ? K : 1100, PANEL); S.noise(900, 31, 0.03);
    const P = new Panel([S], ['wing' + (side > 0 ? 0 : 1)], M);
    P.plate(-0.168, -0.236, 0.168, 0.236);
    const names = side > 0
      ? [['SCS', ['LOGIC BUS\n1', '2', '3', '4', 'SYS\nMNA', 'MNB']], ['SPS', ['PITCH 1', 'YAW 1', 'PITCH 2', 'YAW 2', 'P1 BAT A', 'Y1 BAT A']], ['EDS', ['1', '2', '3', 'ELS\nBAT A', 'BAT B', 'FLOAT\nBAG']], ['SEQ EVENTS CONT SYS', ['LOGIC\nA', 'B', 'ARM\nA', 'B', 'PYRO\nA', 'B']]]
      : [['ECS', ['POT H2O\nHTR', 'WASTE\nH2O', 'PRESS\nXDUCER', 'TEMP\nXDUCER', 'SEC\nLOOP', 'RAD\nHTR']], ['EPS', ['SENSOR\nSIG', 'BAT\nCHGR', 'BAT BUS\nA', 'B', 'INV\nCONT 1', '2']], ['TELCOM', ['GROUP\n1', '2', '3', '4', '5', 'CTE']], ['INSTRUMENTS', ['ESS\nMNA', 'MNB', 'NONESS', 'SCI\nEQUIP', 'DSE', 'TV']]];
    names.forEach(([t, list], r) => {
      const y = 0.185 - r * 0.052;
      P.title(t, -0.158, 0.158, y + 0.029, 0.0028);
      list.forEach((n, k) => { const x = -0.13 + k * 0.052; P.text(n, x, y + 0.0155, 0.0027); P.D(x, y, (S2) => S2.disc(x, y, 0.0075, 'rgba(0,0,0,0.3)')); P.P.add('paint', breaker().translate(x, y, 0)); });
    });
    let y = -0.058;
    P.title(side > 0 ? 'AUTO RCS SELECT' : 'COMMUNICATIONS', -0.158, 0.158, y + 0.043, 0.0028);
    P.row(y, -0.14, 0.04, (side > 0 ? ['A/C ROLL\nA1', 'C1', 'A2', 'C2', 'B/D ROLL\nB1', 'D1', 'B2', 'D2'] : ['S BAND', 'T/R', 'VHF AM', 'T/R', 'INTERCOM', 'T/R', 'PAD COMM', 'SUIT PWR']).map((n) => [n, 'MNA', 'MNB', 1]));
    y = -0.126;
    P.row(y, -0.14, 0.04, (side > 0 ? ['PITCH\nA3', 'C3', 'A4', 'C4', 'YAW\nB3', 'D3', 'B4', 'D4'] : ['AUDIO\nCONT', 'MODE', 'PTT', 'VOX', 'TONE', 'BOOST', 'BU', 'HOT MIC']).map((n, k) => [n, 'MNA', 'MNB', k % 3 ? 1 : -1]));
    y = -0.195;
    P.title(side > 0 ? 'INTERIOR LIGHTS' : 'INTERIOR LIGHTS', -0.158, 0.02, y + 0.034, 0.0028);
    ['NUMERICS', 'FLOOD', 'INTEGRAL'].forEach((n, k) => P.rot(-0.125 + k * 0.058, y - 0.006, n, ['OFF', '', '', '', 'BRT'], 3 - k, -130, 130, 0.0105));
    P.title(side > 0 ? 'SECS' : 'FLOAT BAG', 0.05, 0.158, y + 0.034, 0.0028);
    P.row(y - 0.006, 0.064, 0.04, side > 0 ? [['LOGIC', '', 'OFF', -1, { guard: 1 }], ['PYRO ARM', '', 'SAFE', -1, { guard: 1 }], ['ARM', '', 'SAFE', -1, { guard: 1 }]] : [['1', 'FILL', 'VENT', 0, { guard: 2 }], ['2', 'FILL', 'VENT', 0, { guard: 2 }], ['3', 'FILL', 'VENT', 0, { guard: 2 }]]);
    P.P.add('t0', plateGeo(S.x0, S.y0, S.x1, S.y1, 6, 8, S.uv));
    P.P.add('paint', block(-0.172, -0.24, 0.172, 0.24, -0.09, -0.0005, null, [0.12, 0.125, 0.13], [0.12, 0.125, 0.13]));
    P.flush(G);
    return S;
  };
  const wingSheets = [wing(1), wing(-1)];
  mdc.flush(G);

  // ---- the hatch: a slab standing proud of the wall round its window, with its latch drive
  {
    const M = onWall(90, 1.28, 0.03);
    // the slab, as strips that follow the cone, parted round the window
    const bm = new Beams(), q = (az, h, e) => new THREE.Vector3(...sh.P(az * D2R, h, e)).applyMatrix4(V2C).toArray(), SL = [0.47, 0.49, 0.48];
    for (let k = 0; k < 17; k++) {
      const am = 74 + 2 * k, w = RIN(1.0) * 2 * D2R * 1.02;
      if (am > 83.5 && am < 96.5) { bm.add(q(am, 0.88, 0.015), q(am, 1.165, 0.015), w, SL, 0.03); bm.add(q(am, 1.395, 0.015), q(am, 1.7, 0.015), w, SL, 0.03); } else bm.add(q(am, 0.88, 0.015), q(am, 1.7, 0.015), w, SL, 0.03);
    }
    // the frame round the slab, and the latches along it
    for (const az of [72.2, 107.8]) bm.add(q(az, 0.86, 0.022), q(az, 1.72, 0.022), 0.03, [0.33, 0.34, 0.35], 0.045, true);
    for (const h of [0.865, 1.715]) for (let k = 0; k < 8; k++) bm.add(q(72.2 + (35.6 * k) / 8, h, 0.022), q(72.2 + (35.6 * (k + 1)) / 8, h, 0.022), 0.045, [0.33, 0.34, 0.35], 0.03);
    for (const az of [75, 105]) for (const h of [0.98, 1.2, 1.42, 1.62]) bm.add(q(az, h - 0.03, 0.045), q(az, h + 0.03, 0.045), 0.028, [0.62, 0.63, 0.64], 0.03, true);
    for (const az of [82, 90, 98]) for (const h of [0.905, 1.675]) bm.add(q(az - 1.4, h, 0.045), q(az + 1.4, h, 0.045), 0.028, [0.62, 0.63, 0.64], 0.03, true);
    G.add('paint', bm.build());
    // gearbox and pump handle, the bottle that counterbalances the hatch, the window's bolted ring
    put('paint', M, box(0.1, 0.18, 0.06, [0.27, -0.2, 0.03], [0.27, 0.28, 0.29]), box(0.07, 0.07, 0.03, [0.27, -0.2, 0.075], [0.2, 0.21, 0.22]), ringZ(0, 0, 0.118, 0.205, -0.012, 0.013, [0.3, 0.31, 0.32], 48));
    for (let k = 0; k < 16; k++) put('metal', M, zUp(prim(new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 6), { rgb: NUT })).translate(Math.cos((k / 16) * TAU) * 0.165, Math.sin((k / 16) * TAU) * 0.165, 0.015));
    put('metal', M, rod([0.27, -0.2, 0.09], [0.27, -0.04, 0.12], 0.008, CHROME), rod([0.27, -0.04, 0.12], [0.27, 0.02, 0.12], 0.014, [0.1, 0.1, 0.1]), rod([-0.28, -0.33, 0.04], [-0.28, 0.02, 0.04], 0.034, [0.5, 0.42, 0.2], 12));
    put('paint', M, box(0.16, 0.05, 0.004, [0.0, -0.3, 0.004], [0.75, 0.6, 0.08]), box(0.1, 0.03, 0.004, [0.0, 0.3, 0.004], [0.7, 0.7, 0.66]));
  }

  // ---- the lower equipment bay, past the crew's feet: guidance station and lockers
  {
    const M = mB([1, 0, 0], [0, 0, -1], [0, 1, 0]).setPosition(0, -1.0, 0);
    const S = new Sheet(-1.4, H0, 1.4, 1.66, 620, '#8d9291'); S.noise(1500, 17, 0.03);
    const P = new Panel([S], ['leb'], M);
    const door = (x0, y0, x1, y1, tag, sub) => {
      S.rect(x0 + 0.004, y0 + 0.004, x1 - 0.004, y1 - 0.004, '#a6a8a2', 'rgba(20,22,24,0.7)', 0.0016, 0.012);
      S.rect(x0 + 0.012, y0 + 0.012, x1 - 0.012, y1 - 0.012, null, 'rgba(255,255,255,0.12)', 0.001, 0.008);
      S.text(tag, x0 + 0.045, y1 - 0.035, 0.014, { color: '#1c1d20' }); if (sub) S.text(sub, (x0 + x1) / 2, (y0 + y1) / 2, 0.011, { color: '#1c1d20' });
      P.P.add('paint', box(0.05, 0.016, 0.014, [(x0 + x1) / 2, y1 - 0.03, 0.007], [0.5, 0.51, 0.52]), box(0.012, 0.012, 0.01, [x1 - 0.03, (y0 + y1) / 2, 0.005], [0.16, 0.2, 0.42]));
    };
    const cols = [-1.36, -1.0, -0.66, -0.36], hs = [H0, 0.66, 0.98, 1.3, 1.62];
    [['A', ['FOOD', 'FOOD', 'CAMERA', 'DATA']], ['B', ['LiOH', 'LiOH', 'HYGIENE', 'SUITS']], ['', []]].slice(0, 2).forEach(([L, subs], c) => { for (let r = 0; r < 4; r++) for (const s of [1, -1]) { const xa = cols[c], xb = cols[c + 1]; door(s > 0 ? xa : -xb, hs[r], s > 0 ? xb : -xa, hs[r + 1], L + (r + 1) + (s > 0 ? '' : 'R'), subs[r]); } });
    for (let r = 0; r < 4; r++) for (const s of [1, -1]) door(s > 0 ? cols[2] : -cols[3], hs[r], s > 0 ? cols[3] : -cols[2], hs[r + 1], 'U' + (r + 1), ['MED', 'TOOLS', 'OPTICS', 'FLIGHT DATA'][r]);
    // the guidance and navigation station
    S.rect(-0.355, H0, 0.355, 1.62, '#7b8386', 'rgba(20,22,24,0.8)', 0.002, 0.006);
    S.rect(-0.33, 1.08, 0.33, 1.6, '#16181a', null, 0, 0.01); S.text('OPTICS', 0, 1.57, 0.012, { color: INK });
    for (const [x, r] of [[-0.13, 0.06], [0.14, 0.045]]) { S.disc(x, 1.36, r + 0.03, '#0a0a0b', 'rgba(150,152,154,0.5)', 0.002); P.P.add('paint', zUp(prim(new THREE.CylinderGeometry(r, r + 0.012, 0.11, 24), { rgb: [0.05, 0.05, 0.055] })).translate(x, 1.36, 0.055), zUp(prim(new THREE.CylinderGeometry(r * 0.78, r, 0.06, 20), { rgb: [0.02, 0.02, 0.022] })).translate(x, 1.36, 0.14)); }
    S.text('SXT', -0.13, 1.25, 0.01, { color: INK }); S.text('SCT', 0.14, 1.27, 0.01, { color: INK });
    S.rect(0.08, 0.72, 0.31, 0.98, '#8e9495', 'rgba(20,22,24,0.7)', 0.0016, 0.006); S.rect(0.095, 0.855, 0.18, 0.965, '#050505'); S.rect(0.19, 0.855, 0.295, 0.965, '#050505');
    for (let r = 0; r < 3; r++) for (let c = 0; c < 7; c++) S.rect(0.093 + c * 0.03, 0.735 + r * 0.035, 0.093 + c * 0.03 + 0.025, 0.735 + r * 0.035 + 0.029, '#2c2e30', null, 0, 0.003);
    P.P.add('paint', block(0.08, 0.72, 0.31, 0.98, 0, 0.012, null, [0.2, 0.21, 0.215], [0.36, 0.38, 0.385]));
    S.text('G/N', -0.2, 1.04, 0.012, { color: INK });
    for (let k = 0; k < 5; k++) { const x = -0.29 + k * 0.06; S.text(['IMU', 'OPT', 'ZERO', 'SPEED', 'MODE'][k], x, 0.99, 0.006, { color: INK }); P.P.add('metal', toggle(k % 2 ? 1 : -1).scale(1.5, 1.5, 1.5).translate(x, 0.95, 0)); }
    S.rect(-0.32, 0.4, 0.04, 0.9, null, 'rgba(240,239,232,0.5)', 0.0012, 0.004);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) { const x = -0.29 + c * 0.055, y = 0.84 - r * 0.11; S.disc(x, y, 0.012, 'rgba(0,0,0,0.35)'); P.P.add('paint', breaker().scale(1.6, 1.6, 1.4).translate(x, y, 0)); }
    P.P.add('t0', plateGeo(S.x0, S.y0, S.x1, S.y1, 14, 8, S.uv));
    P.flush(G);
    wingSheets.push(S);
  }

  // ---- couches: three, on a frame of tubes hung from struts
  {
    const TUBE = [0.56, 0.57, 0.58], pad = (cx, a, b, w, t, rgb = CLOTH) => { const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), l = d.length(); const g = box(w, l, t, [0, 0, 0], rgb); const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(cx + (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), q, new THREE.Vector3(1, 1, 1))); return g; };
    const path = [[0.86, -0.52], [0.45, -0.5], [-0.3, -0.5], [-0.46, -0.92], [-0.92, -0.86]];                // (y, z) down a couch's side rail
    for (const cx of [-0.6, 0, 0.6]) {
      for (const s of [-0.265, 0.265]) for (let k = 0; k < path.length - 1; k++) G.add('metal', rod([cx + s, path[k][0], path[k][1]], [cx + s, path[k + 1][0], path[k + 1][1]], 0.015, TUBE, 8));
      for (const k of [0, 2, 3, 4]) G.add('metal', rod([cx - 0.265, path[k][0], path[k][1]], [cx + 0.265, path[k][0], path[k][1]], 0.013, TUBE, 8));
      G.add('cloth', softPad([cx, 0.47, -0.505], [cx, -0.29, -0.505], 0.5, 0.032, CLOTH), softPad([cx, -0.31, -0.52], [cx, -0.45, -0.9], 0.5, 0.03, CLOTH), softPad([cx, -0.47, -0.925], [cx, -0.9, -0.87], 0.5, 0.03, CLOTH));
      for (const y of [0.3, 0.1, -0.1]) G.add('cloth', box(0.5, 0.004, 0.003, [cx, y, -0.5225], [0.4, 0.38, 0.33]));                // seams across the back pan
      for (const sd of [-0.262, 0.262]) for (let k = 0; k < 9; k++) G.add('cloth', rod([cx + sd * 0.93, 0.42 - k * 0.085, -0.52], [cx + sd, 0.4 - k * 0.085, -0.504], 0.0028, [0.72, 0.7, 0.62], 4));     // the lacing to the rails
      // headrest and its wings; the commander's own is behind the eye
      G.add('cloth', softPad([cx, 0.74, -0.56], [cx, 0.5, -0.56], 0.25, 0.085, [0.1, 0.1, 0.105]), softPad([cx - 0.135, 0.71, -0.61], [cx - 0.135, 0.53, -0.61], 0.11, 0.035, [0.1, 0.1, 0.105], [0, 0, 1]), softPad([cx + 0.135, 0.71, -0.61], [cx + 0.135, 0.53, -0.61], 0.11, 0.035, [0.1, 0.1, 0.105], [0, 0, 1]));
      // straps of the harness lying on the pad
      for (const s of [-0.09, 0.09]) G.add('cloth', pad(cx + s, [0, 0.4, -0.5235], [0, -0.05, -0.5235], 0.045, 0.005, [0.2, 0.2, 0.19]));
      G.add('metal', zUp(prim(new THREE.CylinderGeometry(0.032, 0.032, 0.014, 16), { rgb: [0.58, 0.59, 0.6] })).translate(cx, -0.08, -0.531));
      // armrests
      for (const s of [-0.3, 0.3]) { G.add('metal', rod([cx + s, 0.1, -0.56], [cx + s, -0.26, -0.69], 0.013, TUBE, 8)); G.add('cloth', softPad([cx + s, 0.04, -0.6], [cx + s, -0.24, -0.702], 0.062, 0.03, [0.11, 0.11, 0.115])); }
    }
    // hand controllers: translation (a T-handle) on the commander's left arm, rotation (a pistol grip) on his right and on the right couch
    const thc = (x) => { G.add('paint', box(0.07, 0.075, 0.06, [x, -0.3, -0.74], [0.34, 0.35, 0.36]), box(0.05, 0.02, 0.02, [x, -0.262, -0.765], [0.5, 0.05, 0.04])); G.add('metal', rod([x, -0.3, -0.77], [x, -0.3, -0.83], 0.011, CHROME), rod([x - 0.05, -0.3, -0.835], [x + 0.05, -0.3, -0.835], 0.014, [0.1, 0.1, 0.105], 10)); };
    const rhc = (x) => { G.add('paint', box(0.075, 0.085, 0.07, [x, -0.3, -0.745], [0.34, 0.35, 0.36]), box(0.012, 0.022, 0.03, [x, -0.262, -0.845], [0.55, 0.06, 0.05])); G.add('metal', rod([x, -0.3, -0.78], [x, -0.285, -0.89], 0.019, [0.09, 0.09, 0.095], 10), rod([x, -0.285, -0.89], [x, -0.275, -0.905], 0.022, [0.09, 0.09, 0.095], 10)); };
    thc(-0.9); rhc(-0.3); rhc(0.9);
    // the struts that carry the couch frame: two up to the forward wall beside the heads, two out to the sides, the head and foot beams
    const strut = (a, b) => { const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), m1 = A.clone().lerp(B, 0.3), m2 = A.clone().lerp(B, 0.72); G.add('metal', rod(a, b, 0.016, [0.6, 0.61, 0.62], 10), rod(m1.toArray(), m2.toArray(), 0.027, [0.56, 0.5, 0.34], 12), rod(m1.clone().lerp(m2, -0.03).toArray(), m1.toArray(), 0.031, [0.4, 0.41, 0.42], 12), rod(m2.toArray(), m2.clone().lerp(m1, -0.03).toArray(), 0.031, [0.4, 0.41, 0.42], 12)); };
    for (const s of [-1, 1]) { strut([0.95 * s, 0.9, -0.52], [0.662 * s, 0.789, -1.62]); strut([0.87 * s, -0.3, -0.5], [1.5 * s, -0.36, -0.62]); G.add('metal', ball(0.035, [0.662 * s, 0.789, -1.62], [0.4, 0.41, 0.42], 10)); }
    G.add('metal', rod([-0.93, 0.86, -0.52], [0.93, 0.86, -0.52], 0.022, TUBE, 10), rod([-0.93, -0.92, -0.86], [0.93, -0.92, -0.86], 0.02, TUBE, 10));
    // lockers on the aft bulkhead, under the couches
    for (const [x, y, w, d] of [[-0.75, 0.2, 0.6, 0.9], [0, 0.3, 0.7, 1.0], [0.75, 0.2, 0.6, 0.9], [-0.5, -0.65, 0.8, 0.5], [0.5, -0.65, 0.8, 0.5]]) G.add('paint', box(w, d, 0.11, [x, y, -H0 - 0.055], [0.55, 0.56, 0.54]));
  }

  // ---- on the walls: flood lights, the sight by the commander's window, hose panels, handholds, cable runs, Velcro
  const floodFix = [], floodPts = [];
  {
    for (const [az, h, i, r] of [[12, 0.98, 0.7, 0.8], [168, 0.98, 0.7, 0.8], [58, 1.5, 0.36, 0.6], [122, 1.5, 0.36, 0.6]]) {
      const M = onWall(az, h, 0.002);
      put('paint', M, box(0.19, 0.07, 0.032, [0, 0, 0.016], [0.24, 0.25, 0.26]));
      floodFix.push(quadAt(M, -0.085, -0.026, 0.085, 0.026, 0.0335, [0.96, 0.96], [0.99, 0.99]));
      floodPts.push({ p: new THREE.Vector3(0, 0, 0.07).applyMatrix4(M).toArray(), i, r });
    }
    { const M = mB([1, 0, 0], [0, 0, -1], [0, 1, 0]).setPosition(0, -0.998, -1.585); put('paint', M, box(0.3, 0.06, 0.03, [0, 0, 0.015], [0.24, 0.25, 0.26])); floodFix.push(quadAt(M, -0.14, -0.022, 0.14, 0.022, 0.0315, [0.96, 0.96], [0.99, 0.99])); floodPts.push({ p: [0, -0.93, -1.585], i: 0.55, r: 0.9 }); }
    // fasteners down the longerons and round the ring frame, the seams between the wall's panels
    const fast = prim(new THREE.CircleGeometry(0.0042, 6), { rgb: [0.47, 0.49, 0.49] });
    for (const az of [3, 16, 49.5, 130.5, 164, 177]) for (let h = 0.44; h < 2.1; h += 0.085) put('paint', onWall(az, h, 0.0196), fast.clone());
    for (let az = 2.5; az < 180; az += 5) put('paint', onWall(az, 2.13, 0.0156), fast.clone());
    { const bm = new Beams(), q = (az, h, e) => new THREE.Vector3(...sh.P(az * D2R, h, e)).applyMatrix4(V2C).toArray();
      for (const h of [1.06, 1.64]) for (let az = 0; az < 180; az += 3) { if (az >= 70 && az < 110) continue; bm.add(q(az, h, 0.0006), q(az + 3, h, 0.0006), 0.0012, [0.16, 0.17, 0.17], 0.004); }
      for (const az of [26, 68, 112, 154]) bm.add(q(az, 1.64, 0.0006), q(az, 2.12, 0.0006), 0.004, [0.16, 0.17, 0.17], 0.0012);
      G.add('paint', bm.build()); }
    // window shades, rolled and clipped over each window; stowage pouches and equipment boxes
    for (const H of sh.holes) { if (H.id === 'hatch') continue; const az = H.ac / D2R, hTop = H.hc + (H.hb + 0.055) / H.lc, M = onWall(az, hTop, 0.0); put('cloth', M, rod([-H.ha - 0.01, 0, 0.02], [H.ha + 0.01, 0, 0.02], 0.016, [0.5, 0.47, 0.38], 10)); for (const sx of [-1, 1]) put('metal', M, box(0.012, 0.04, 0.03, [sx * H.ha * 0.7, 0, 0.018], [0.4, 0.41, 0.42])); }
    for (const [az, h, w, hh, d, c] of [[17.5, 1.5, 0.15, 0.2, 0.05, 0], [162.5, 1.5, 0.15, 0.2, 0.05, 0], [9, 1.28, 0.13, 0.11, 0.07, 1], [171, 1.28, 0.13, 0.11, 0.07, 1], [44, 1.86, 0.1, 0.14, 0.04, 0], [136, 1.86, 0.1, 0.14, 0.04, 0], [84, 1.93, 0.14, 0.09, 0.05, 1], [20, 0.66, 0.2, 0.14, 0.08, 1], [160, 0.66, 0.2, 0.14, 0.08, 1]]) {
      const M = onWall(az, h, 0.0);
      if (c) { put('paint', M, box(w, hh, d, [0, 0, d / 2], [0.27, 0.28, 0.29]), box(w * 0.5, 0.012, 0.004, [0, -hh * 0.22, d + 0.002], [0.13, 0.13, 0.14])); for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put('paint', M, fast.clone().translate(sx * (w / 2 - 0.012), sy * (hh / 2 - 0.012), d + 0.0008)); }
      else { put('cloth', M, softPad([0, hh / 2, d / 2], [0, -hh / 2, d / 2], w, d, [0.6, 0.58, 0.5])); put('cloth', M, box(w * 0.94, 0.02, 0.004, [0, hh * 0.3, d + 0.001], [0.42, 0.4, 0.34])); put('metal', M, fast.clone().translate(-w * 0.3, hh * 0.3, d + 0.0035), fast.clone().translate(w * 0.3, hh * 0.3, d + 0.0035)); }
    }
    // the optical sight, on its mount beside the left rendezvous window
    { const M = onWall(53.5, 1.8, 0.0); put('paint', M, box(0.04, 0.04, 0.05, [0, 0, 0.04], [0.05, 0.05, 0.055]), box(0.03, 0.08, 0.016, [0, 0, 0.008], [0.3, 0.31, 0.32]), zUp(prim(new THREE.CylinderGeometry(0.016, 0.016, 0.06, 14), { rgb: [0.04, 0.04, 0.045] })).rotateX(-1.05).translate(0, 0.035, 0.07)); }
    // oxygen and communications panels by the outer couches' shoulders
    for (const [az, s] of [[8, 1], [172, -1]]) {
      const M = onWall(az, 0.72, 0.002);
      put('paint', M, box(0.3, 0.16, 0.03, [0, 0, 0.015], [0.3, 0.31, 0.32]));
      for (let k = 0; k < 3; k++) { put('metal', M, zUp(prim(new THREE.CylinderGeometry(0.024, 0.026, 0.035, 16), { rgb: [[0.12, 0.2, 0.5], [0.55, 0.1, 0.08], [0.55, 0.56, 0.57]][k] })).translate(-0.095 + k * 0.095, 0.01, 0.047)); put('metal', M, zUp(prim(new THREE.CylinderGeometry(0.03, 0.03, 0.008, 16), { rgb: [0.5, 0.51, 0.52] })).translate(-0.095 + k * 0.095, 0.01, 0.034)); }
      void s;
    }
    // handholds
    for (const [az, h] of [[20, 1.18], [160, 1.18], [80, 1.84], [100, 1.84]]) { const M = onWall(az, h, 0); put('metal', M, rod([-0.07, 0, 0.045], [0.07, 0, 0.045], 0.009, [0.6, 0.61, 0.62]), rod([-0.07, 0, 0], [-0.07, 0, 0.045], 0.008, [0.6, 0.61, 0.62]), rod([0.07, 0, 0], [0.07, 0, 0.045], 0.008, [0.6, 0.61, 0.62])); }
    // cable runs in their white sleeving, clamped to the wall
    const cab2 = (az0, h0, az1, h1, r = 0.011) => { const n = 12; for (let k = 0; k < n; k++) { const f0 = k / n, f1 = (k + 1) / n, a = new THREE.Vector3(...sh.P(lerp(az0, az1, f0) * D2R, lerp(h0, h1, f0), r + 0.004)).applyMatrix4(V2C), b = new THREE.Vector3(...sh.P(lerp(az0, az1, f1) * D2R, lerp(h0, h1, f1), r + 0.004)).applyMatrix4(V2C); G.add('cloth', rod(a.toArray(), b.toArray(), r, [0.7, 0.69, 0.64], 6)); if (k % 3 === 1) G.add('metal', rod(a.toArray(), a.clone().lerp(b, 0.12).toArray(), r + 0.003, [0.45, 0.46, 0.47], 6)); } };
    cab2(22, 0.5, 22, 1.12); cab2(22, 1.12, 47, 1.66); cab2(47, 1.66, 52, 2.12); cab2(158, 0.5, 158, 1.12); cab2(158, 1.12, 133, 1.66); cab2(133, 1.66, 128, 2.12); cab2(24.5, 0.5, 24.5, 1.1, 0.007); cab2(75, 1.76, 75, 2.16, 0.008); cab2(105, 1.76, 105, 2.16, 0.008);
    // Velcro, in the blue and tan squares the crews stuck everything to
    const vel = [[44, 1.72, 0], [52, 1.48, 1], [70, 1.6, 0], [15, 1.3, 1], [28, 1.72, 0], [110, 1.6, 0], [128, 1.48, 1], [136, 1.72, 0], [165, 1.3, 1], [49, 2.02, 1], [84, 2.1, 0], [96, 2.1, 1], [10, 0.98, 0]];
    for (const [az, h, t] of vel) put('cloth', onWall(az, h, 0), box(0.03, 0.03, 0.003, [0, 0, 0.0015], t ? [0.36, 0.3, 0.2] : [0.12, 0.17, 0.42]));
  }

  // ---------------------------------------------------------------- light, materials, meshes
  const L = {
    floods: floodPts, wins: windows.map((w) => ({ c: w.c, n: w.n, area: w.area * 0.9 })), amb: [0.15, 0.05],
    occ: [occluder(new THREE.Matrix4().multiplyMatrices(Mmdc, new THREE.Matrix4().makeTranslation(0, 0, -0.056)), [1.05, 0.45, 0.055]),
      ...[-0.6, 0, 0.6].map((cx) => occluder(new THREE.Matrix4().makeTranslation(cx, 0.09, -0.5), [0.28, 0.42, 0.02])), ...[-0.6, 0, 0.6].map((cx) => occluder(new THREE.Matrix4().makeTranslation(cx, -0.68, -0.89), [0.27, 0.24, 0.03]))],
    shade: (x, y, z) => (z > -0.5 ? 0.6 + 0.4 * Math.max(0, Math.min(1, (-z - H0) / 0.16)) : 1),              // the aft bulkhead, down among the lockers
  };
  const paintTex = paintTexture(5, 256, 1), clothTex = weaveTexture(22, 256, 0.3);
  const M = {
    paint: cabMat(U, { map: paintTex, roughness: 0.72 }),
    metal: cabMat(U, { map: paintTex, roughness: 0.34, metalness: 0.85, envMapIntensity: 0.55 }),
    cloth: cabMat(U, { map: clothTex, roughness: 0.95 }),
    mdc0: cabMat(U, { map: sheets[0].texture(), roughness: 0.62 }, { el: true, sharp: -0.45 }),
    mdc1: cabMat(U, { map: sheets[1].texture(), roughness: 0.62 }, { el: true, sharp: -0.45 }),
    mdc2: cabMat(U, { map: sheets[2].texture(), roughness: 0.62 }, { el: true, sharp: -0.45 }),
    wing0: cabMat(U, { map: wingSheets[0].texture(), roughness: 0.62 }, { el: true, sharp: -0.45 }),
    wing1: cabMat(U, { map: wingSheets[1].texture(), roughness: 0.62 }, { el: true, sharp: -0.45 }),
    leb: cabMat(U, { map: wingSheets[2].texture(), roughness: 0.7 }, { el: true }),
    glass: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.04, metalness: 0, envMapIntensity: 1.0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    glassI: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.08, metalness: 0, envMapIntensity: 0.3, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  };
  for (const name of Object.keys(G.lists)) {
    const g = G.geometry(name); if (!g) continue;
    if (name === 'paint' || name === 'cloth' || name === 'metal') boxUv(g, name === 'cloth' ? 0.045 : 0.3);
    if (name !== 'glass' && name !== 'glassI') bakeLit(g, L, name !== 'metal');
    const m = meshFrom(g, M[name]); m.name = name; if (name.startsWith('glass')) m.renderOrder = 2;
    cab.add(m);
  }
  // the balls
  const ballMat = cabMat(U, { map: ballTexture(), roughness: 0.4, envMapIntensity: 0.05 }, { shafts: false, el: true });
  const qMdc = new THREE.Quaternion().setFromRotationMatrix(Mmdc), ballMeshes = balls.map((b) => { const m = meshFrom(b.geo, ballMat); m.position.copy(b.pos); m.quaternion.copy(qMdc); cab.add(m); return m; });
  const needleMat = cabMat(U, { roughness: 0.5, side: THREE.DoubleSide }, { shafts: false });
  cab.add(ND.build(needleMat));

  // ---------------------------------------------------------------- what is drawn while flying
  const GREEN = '#58ffa0', GREEN_OFF = 'rgba(60,160,110,0.07)';
  // lamps: every annunciator's face in one canvas
  const LW = 1024, LH = 512, slots = {};
  {
    let x = 4, y = 4, rowH = 0;
    const slot = (id, w, h) => { if (x + w > LW - 40) { x = 4; y += rowH + 4; rowH = 0; } slots[id] = [x, y, w, h]; x += w + 4; rowH = Math.max(rowH, h); };
    slot('cw', 700, 170);
    for (const l of [...mdc.lamps]) if (l.id !== 'cw') slot(l.id, l.round ? 72 : 112, l.round ? 72 : Math.round(112 * (l.h / l.w)));
  }
  const CW = ['BMAG 1\nTEMP', 'PITCH\nGMBL 1', 'CO2\nPP HI', 'FC 1', 'INV 1\nTEMP HI', 'SPS\nPRESS', 'BMAG 2\nTEMP', 'YAW\nGMBL 1', 'SM RCS\nA', 'FC 2', 'INV 2\nTEMP HI', 'AC BUS 1',
    'CRYO\nPRESS', 'PITCH\nGMBL 2', 'SM RCS\nB', 'FC 3', 'INV 3\nTEMP HI', 'AC BUS 2', 'GLYCOL\nTEMP LOW', 'YAW\nGMBL 2', 'SM RCS\nC', 'FC BUS\nDISCONNECT', 'MN BUS A\nUNDERVOLT', 'AC BUS 1\nOVERLOAD',
    'CM RCS 1', 'CM RCS 2', 'SM RCS\nD', 'CMC', 'MN BUS B\nUNDERVOLT', 'AC BUS 2\nOVERLOAD', 'CREW\nALERT', 'ISS', 'C/W', 'O2 FLOW\nHI', 'SUIT\nCOMPRESSOR', 'SPS ROUGH\nECO'];
  const LEG = { abort: ['ABORT', '#ff2a14', '#3a0d09'], liftoff: ['LIFT OFF', '#fff2cf', '#35322a'], lvrate: ['LV RATE', '#ff3a1c', '#3a0d09'], lvguid: ['LV GUID', '#ff3a1c', '#3a0d09'], s2sep: ['S-II SEP', '#ffe9a8', '#35301e'], master: ['MASTER\nALARM', '#ff2410', '#4a100b'], master2: ['MASTER\nALARM', '#ff2410', '#4a100b'], g05: ['', '#b8ffb0', '#1c2a1a'], sps: ['', '#fff0b8', '#2e2a1c'] };
  const lamps = new Live(LW, LH, (g, st) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, LW, LH);
    g.fillStyle = '#fff'; g.fillRect(LW * 0.95, 0, LW * 0.05, LH * 0.05);                      // the flood lights' diffusers sample this corner
    const on = (id) => !!(st && st[id]);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    { const [x, y, w, h] = slots.cw, cw = w / 6, ch = h / 6;
      CW.forEach((s, k) => { const cx = x + (k % 6) * cw, cy = y + Math.floor(k / 6) * ch, lit = st && st.cw === k, red = k >= 30 && k < 31; g.fillStyle = lit ? (red ? '#ff3a22' : '#ffd24a') : '#1d1a12'; g.fillRect(cx + 2, cy + 2, cw - 4, ch - 4); g.fillStyle = lit ? '#1a0e04' : '#6f6648'; g.font = `700 10.5px ${FONT}`; s.split('\n').forEach((ln, i, a) => g.fillText(ln, cx + cw / 2, cy + ch / 2 + (i - (a.length - 1) / 2) * 11 + 0.5)); }); }
    for (const id of Object.keys(slots)) {
      if (id === 'cw') continue;
      const [x, y, w, h] = slots[id], lit = on(id);
      if (id.startsWith('eng')) { g.fillStyle = lit ? '#ffc93a' : '#2b2412'; g.beginPath(); g.arc(x + w / 2, y + h / 2, w / 2, 0, TAU); g.fill(); g.fillStyle = lit ? '#2a1800' : '#8a7a48'; g.font = `700 40px ${FONT}`; g.fillText(id[3], x + w / 2, y + h / 2 + 3); continue; }
      if (id.startsWith('corr')) { g.fillStyle = lit ? '#fff0b8' : '#2a281e'; g.beginPath(); g.arc(x + w / 2, y + h / 2, w / 2, 0, TAU); g.fill(); continue; }
      const [leg, cOn, cOff] = LEG[id] || ['', '#fff', '#222'];
      if (id === 'liftoff') { g.fillStyle = lit ? cOn : cOff; g.fillRect(x, y, w, h / 2); g.fillStyle = st && st.noauto ? '#ff3a1c' : '#3a0d09'; g.fillRect(x, y + h / 2, w, h / 2); g.fillStyle = lit ? '#201808' : '#8f886e'; g.font = `700 21px ${FONT}`; g.fillText('LIFT OFF', x + w / 2, y + h * 0.26); g.fillStyle = '#9c6a5c'; g.font = `700 15px ${FONT}`; g.fillText('NO AUTO', x + w / 2, y + h * 0.64); g.fillText('ABORT', x + w / 2, y + h * 0.86); continue; }
      g.fillStyle = lit ? cOn : cOff; g.fillRect(x, y, w, h);
      g.fillStyle = lit ? '#240a04' : 'rgba(210,190,170,0.55)'; const lines = leg.split('\n'), px = lines.length > 1 ? 24 : id === 'abort' ? 30 : 21; g.font = `700 ${px}px ${FONT}`;
      lines.forEach((ln, i) => g.fillText(ln, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * px * 1.05 + 1));
    }
  });
  for (const l of mdc.lamps) { const [x, y, w, h] = slots[l.id]; liveQuads.lamps.push(quadAt(l.M, l.x - l.w / 2, l.y - l.h / 2, l.x + l.w / 2, l.y + l.h / 2, l.z, [x / LW, 1 - (y + h) / LH], [(x + w) / LW, 1 - y / LH], l.round)); }
  // the lamps stand on little bodies of their own
  { const bodies = new Parts(); for (const l of mdc.lamps) if (l.id !== 'cw') bodies.add('b', block(l.x - l.w / 2, l.y - l.h / 2, l.x + l.w / 2, l.y + l.h / 2, 0, l.z - 0.0003, null, [0.03, 0.03, 0.03], [0.03, 0.03, 0.03]).applyMatrix4(l.M)); const g = bodies.geometry('b'); boxUv(g, 0.35); bakeLit(g, L); cab.add(meshFrom(g, M.paint)); }
  liveQuads.lamps.push(...floodFix);

  // DSKY: status lights on the left of the canvas, the electroluminescent display beside them (4700 texels a meter)
  const DW = 1024, DH = 512;
  const dsky = new Live(DW, DH, (g, st) => {
    g.fillStyle = '#020403'; g.fillRect(0, 0, DW, DH);
    const s = st || { prog: '  ', verb: '  ', noun: '  ', r: ['      ', '      ', '      '], acty: false, lights: {} };
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const LIGHTS = [['UPLINK\nACTY', 'TEMP'], ['NO ATT', 'GIMBAL\nLOCK'], ['STBY', 'PROG'], ['KEY REL', 'RESTART'], ['OPR ERR', 'TRACKER'], ['', ''], ['', '']];
    LIGHTS.forEach((row, r) => row.forEach((leg, c) => {
      const x = 5 + c * 150, y = 6 + r * 72, lit = s.lights[leg.replace('\n', ' ')];
      g.fillStyle = lit ? (c === 1 ? '#ffc23a' : '#f4f2e0') : '#24251f'; g.fillRect(x, y, 144, 66);
      g.fillStyle = lit ? '#1c1408' : '#7c7d70'; g.font = `700 23px ${FONT}`; leg.split('\n').forEach((ln, i, a) => g.fillText(ln, x + 72, y + 34 + (i - (a.length - 1) / 2) * 24));
    }));
    const X0 = 320, lab = (t, x, y, w = 124) => { g.fillStyle = '#2f8f5e'; g.fillRect(x, y, w, 24); g.fillStyle = '#04140b'; g.font = `700 20px ${FONT}`; g.fillText(t, x + w / 2, y + 13); };
    g.fillStyle = s.acty ? '#3fe08a' : '#0c2417'; g.fillRect(X0 + 26, 10, 134, 92); g.fillStyle = s.acty ? '#04140b' : '#1d5a3a'; g.font = `700 26px ${FONT}`; g.fillText('COMP', X0 + 93, 42); g.fillText('ACTY', X0 + 93, 72);
    lab('PROG', X0 + 300, 8); segText(g, s.prog, X0 + 306, 37, 46, 66, 20, GREEN, GREEN_OFF);
    lab('VERB', X0 + 30, 112); segText(g, s.verb, X0 + 36, 141, 46, 66, 20, GREEN, GREEN_OFF);
    lab('NOUN', X0 + 300, 112); segText(g, s.noun, X0 + 306, 141, 46, 66, 20, GREEN, GREEN_OFF);
    s.r.forEach((str, k) => { const y = 228 + k * 92; g.fillStyle = '#2f8f5e'; g.fillRect(X0 + 26, y - 11, 418, 5); segText(g, str, X0 + 28, y + 4, 50, 70, 20, GREEN, GREEN_OFF); });
  });
  // timers: the mission timer along the top, the event timer's wheels and the entry monitor's counter under it
  const timers = new Live(512, 256, (g, st) => {
    g.fillStyle = '#020303'; g.fillRect(0, 0, 512, 256);
    const s = st || { mt: '000 00 00', ev: '00 00', dv: ' 00000' };
    const EL = '#d9f4ff', OFF = 'rgba(120,160,180,0.07)';
    let x = 12; for (const part of s.mt.split(' ')) { x = segText(g, part, x, 21, 36, 62, 9, EL, OFF) + 13; }
    segText(g, s.dv, 284, 124, 28, 48, 8, '#e8f6e2', 'rgba(140,170,140,0.07)');
    // the event timer's digits are painted wheels, not lit segments
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `700 58px "DejaVu Sans Mono", Menlo, monospace`;
    [...s.ev.replace(' ', '')].forEach((ch, k) => { const cx = 48 + k * 58 + (k > 1 ? 18 : 0); g.fillStyle = '#131415'; g.fillRect(cx - 26, 126, 52, 70); g.fillStyle = '#eceadc'; g.fillText(ch, cx, 164); g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(cx - 26, 126, 52, 9); g.fillRect(cx - 26, 187, 52, 9); });
  });
  // the entry monitor's scroll: g against velocity, with the trace scribed so far
  const trace = [];
  const scroll = new Live(256, 256, (g) => {
    g.fillStyle = '#d6d1b8'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(40,40,36,0.75)'; g.lineWidth = 1;
    for (let k = 0; k <= 9; k++) { const y = 240 - k * 25; g.beginPath(); g.moveTo(22, y); g.lineTo(256, y); g.stroke(); g.fillStyle = '#26261f'; g.font = `700 13px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(String(k), 18, y); }
    for (let v = 0; v <= 36; v += 4) { const x = 250 - (v / 37) * 226; g.beginPath(); g.moveTo(x, 15); g.lineTo(x, 240); g.stroke(); g.textAlign = 'center'; g.fillText(String(v), x, 249); }
    g.strokeStyle = 'rgba(40,40,36,0.5)'; g.lineWidth = 1.2;
    for (let k = 0; k < 9; k++) { g.beginPath(); g.moveTo(250 - (36 / 37) * 226, 240 - (0.6 + k * 0.9) * 25); g.quadraticCurveTo(140, 240 - (2.6 + k * 0.8) * 25, 250 - ((6 + k * 2.6) / 37) * 226, 240); g.stroke(); }     // the g onset and offset lines
    if (trace.length > 1) { g.strokeStyle = '#141412'; g.lineWidth = 2.2; g.lineJoin = 'round'; g.beginPath(); trace.forEach(([v, a], k) => { const x = 250 - (Math.min(37, v) / 37) * 226, y = 240 - Math.max(0, Math.min(9, a)) * 25; k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
    if (trace.length) { const [v, a] = trace[trace.length - 1]; g.fillStyle = '#b3261a'; g.beginPath(); g.arc(250 - (Math.min(37, v) / 37) * 226, 240 - Math.max(0, Math.min(9, a)) * 25, 3.2, 0, TAU); g.fill(); }
  });
  const lives = [lamps, dsky, timers, scroll];
  const display = (live, k, quads) => { const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: live.tex, emissiveIntensity: k, roughness: 0.4, fog: false, envMapIntensity: 0.1 }); const g = new Parts().add('q', ...quads).geometry('q'); const mesh = meshFrom(g, m); cab.add(mesh); return m; };
  const dm = { lamps: display(lamps, 1, liveQuads.lamps), dsky: display(dsky, 1, liveQuads.dsky), timers: display(timers, 1, liveQuads.timers), scroll: display(scroll, 0.5, liveQuads.scroll) };
  for (const l of lives) l.flush();

  // ---------------------------------------------------------------- the interface
  const eye = pointToVehicle(EYE, YC);
  const gaze = new THREE.Vector3(Math.sin(4 * D2R), -Math.sin(14 * D2R), -Math.cos(14 * D2R)).normalize();      // up the stack, tipped 14 degrees toward the panel and 4 inboard
  const look = dirToVehicle(gaze.toArray()), upV = dirToVehicle([0, Math.cos(14 * D2R), -Math.sin(14 * D2R)]);
  const st = { turn: 0, stage: -1, tStage: -1e9, rate: [0, 0, 0], last: null, tSample: -1, dvShown: 0, dskyT: -1, acty: false, traceV: -1, built: 0 };
  const sunC = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), X1 = new THREE.Vector3(1, 0, 0), Y1 = new THREE.Vector3(0, 1, 0), Z1 = new THREE.Vector3(0, 0, 1);
  const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
  const reg = (v) => (Number.isFinite(v) ? (v < 0 ? '-' : '+') + String(Math.min(99999, Math.round(Math.abs(v)))).padStart(5, '0') : '+99999');
  const wrap = (d) => ((d + 540) % 360) - 180;

  function update(dt, s) {
    const night = s.night || 0, lit = s.lit ?? 1, space = s.alt > 45000 || s.body === 'moon';
    // light: floods always, daylight through the windows, sun in a shaft, lettering when it is dark
    const expo = s.exposure || (space ? 1.25 + 1.5 * (1 - lit) * (1 - lit) : 1 + 2.4 * night * night), gain = 1 / Math.pow(expo, 0.8);
    U.uFlood.value.set(1.0, 0.94, 0.84).multiplyScalar(0.92 * gain);
    const day = space ? 0.5 * lit : (1 - night) * (0.45 + 0.55 * lit);
    U.uDay.value.set(0.8, 0.9, 1.05).multiplyScalar(day * 1.1);
    let bounce = 0;
    if (s.sunDir) {
      sunC.set(-s.sunDir.x, -s.sunDir.z, -s.sunDir.y).normalize(); U.uSunDir.value.copy(sunC);
      for (const w of windows) bounce += Math.max(0, sunC.x * w.n[0] + sunC.y * w.n[1] + sunC.z * w.n[2]) * w.area;
      const k = lit * (space ? 1 : 1 - night);
      U.uSunCol.value.set(1.0, 0.95, 0.85).multiplyScalar(3.2 * k);
      U.uDay.value.addScaledVector(new THREE.Vector3(1.0, 0.93, 0.82), bounce * 2.2 * k);
    } else U.uSunCol.value.set(0, 0, 0);
    const dark = Math.max(0, 1 - (day + bounce * 3 * lit));
    U.uEL.value = (0.05 + 0.5 * dark) * gain;
    for (const k of ['lamps', 'dsky', 'timers']) dm[k].emissiveIntensity = (1.0 + 0.2 * dark) * gain;
    dm.scroll.emissiveIntensity = (0.2 + 0.25 * day) * gain;

    // attitude: both balls, the roll bugs, rates from the change in attitude
    const p = (s.pitch || 0) * D2R, h = (s.hdg || 0) * D2R, r = (s.roll || 0) * D2R;
    qa.setFromAxisAngle(Z1, r).multiply(qb.setFromAxisAngle(X1, p)).multiply(qb.setFromAxisAngle(Y1, -h));
    for (const m of ballMeshes) m.quaternion.copy(qMdc).multiply(qa);
    if (st.last && dt > 1e-4 && dt < 0.5) {
      const k = Math.min(1, dt * 6), tg = [wrap(s.roll - st.last[0]) / dt, wrap(s.pitch - st.last[1]) / dt, wrap(s.hdg - st.last[2]) / dt];
      for (let i = 0; i < 3; i++) st.rate[i] += (Math.max(-6, Math.min(6, tg[i])) - st.rate[i]) * k;
    } else if (dt >= 0.5) st.rate.fill(0);
    st.last = [s.roll || 0, s.pitch || 0, s.hdg || 0];
    const rs = 0.0085;                                   // meters a degree per second on the rate scales (full scale 5)
    for (const id of ['a', 'b']) {
      ND.set(nd[id + 'bug'], r);
      ND.set(nd[id + 'rr'], 0, Math.max(-5, Math.min(5, st.rate[0])) * rs, 0); ND.set(nd[id + 'pr'], 0, 0, Math.max(-5, Math.min(5, st.rate[1])) * rs); ND.set(nd[id + 'yr'], 0, Math.max(-5, Math.min(5, st.rate[2])) * rs, 0);
      ND.set(nd[id + 're'], 0, -st.rate[0] * 0.003, 0); ND.set(nd[id + 'pe'], 0, 0, -st.rate[1] * 0.003); ND.set(nd[id + 'ye'], 0, -st.rate[2] * 0.003, 0);
    }
    ND.set(nd.rsi, r);
    // gauges
    const kft = Math.max(0, Math.min(60, (s.alt * FT) / 1000));
    ND.set(nd.alt, -(-150 + kft * 5) * D2R);
    ND.set(nd.g, -(-135 + ((Math.max(-1, Math.min(10, s.gLoad || 0)) + 1) / 11) * 270) * D2R);
    const pct = s.stage >= 3 ? 100 * (s.thrust || 0) : Math.min(150, ((s.q || 0) / 35000) * 100);
    ND.set(nd.aoa, -(-130 + (Math.max(0, pct) / 150) * 260) * D2R);
    const wob = 0.4 * Math.sin(s.time * 2.3), th = s.thrust || 0;
    const tank = [s.stage <= 1 ? 30 + 4 * (s.stage === 1 ? th : 0) + wob * (s.stage === 1 ? th : 0) : 0, s.stage <= 1 ? 36 + 3 * (s.stage === 1 ? th : 0) : 0, s.stage <= 2 ? 31 + 5 * (s.stage === 2 ? th : 0) + wob * (s.stage === 2 ? th : 0) : 0, s.stage <= 2 ? 39 + 2 * (s.stage === 2 ? th : 0) : 0];
    tank.forEach((v, k) => ND.set(nd['tp' + k], 0, 0, (Math.min(50, v) / 50) * 0.062));

    // staging, for the lights
    if (s.stage !== st.stage) { if (st.stage >= 0) st.tStage = s.time; st.stage = s.stage; }
    const off = (s.thrust || 0) < 0.03, L5 = s.stage <= 1 ? off : false, alarm = (s.gLoad || 0) > 6.5 || (s.body === 'earth' && !s.landed && s.alt < 3000 && s.vs < -60);
    const lampState = {
      eng1: s.stage <= 1 ? off : s.stage === 2 ? off : false, eng2: L5, eng3: L5, eng4: L5, eng5: L5,
      liftoff: s.met >= 0 && s.met < 15 && s.stage === 0, s2sep: s.stage === 1 && s.time - st.tStage < 30, master: alarm, master2: alarm, cw: alarm ? 30 : -1,
      g05: s.stage >= 3 && s.body === 'earth' && s.alt < 122000 && s.vs < 0 && (s.gLoad || 0) > 0.05, sps: s.stage >= 3 && !off,
    };
    lamps.want(JSON.stringify(lampState), lampState);

    // timers and the velocity counter (the counter no faster than five times a second)
    const met = Math.max(0, s.met || 0), slot5 = Math.floor(s.time * 5);
    if (slot5 !== st.tSample) { st.tSample = slot5; st.dvShown = Math.round((s.speedOrb || 0) * FT); }
    const mt = `${String(Math.floor(met / 3600) % 1000).padStart(3, '0')} ${pad2((met / 60) % 60)} ${pad2(met % 60)}`, ev = `${pad2((met / 60) % 60)} ${pad2(met % 60)}`, dv = ' ' + String(Math.min(99999, st.dvShown)).padStart(5, '0');
    timers.want(mt + ev + dv, { mt, ev, dv });

    // the computer: boost monitor while climbing, orbit parameters while coasting; it updates twice a second
    const slot2 = Math.floor(s.time * 2);
    if (slot2 !== st.dskyT) {
      st.dskyT = slot2; st.acty = !st.acty;
      const burning = !off, orbit = s.pe > 80000 || s.body === 'moon', boost = burning ? !orbit || s.stage < 2 : !orbit && s.alt < 150000;
      const prog = s.met < 0 ? '02' : burning && s.stage >= 3 ? '40' : orbit ? (burning ? '15' : '00') : s.stage < 3 ? '11' : '00';
      let R;
      if (boost || s.met < 0) R = [reg(s.speedOrb * FT), reg(s.vs * FT), reg((s.alt / NMI) * 10)];
      else {
        const tn = Math.min(Number.isFinite(s.tAp) && s.tAp > 0 ? s.tAp : Infinity, Number.isFinite(s.tPe) && s.tPe > 0 ? s.tPe : Infinity);
        const tff = Number.isFinite(tn) ? '+' + pad2(Math.min(59, tn / 60)) + ' ' + pad2(tn >= 3600 ? 59 : tn % 60) : '+59 59';
        R = [reg((s.ap / NMI) * 10), reg((s.pe / NMI) * 10), tff];
      }
      const state = { prog, verb: '16', noun: boost || s.met < 0 ? '62' : '44', r: R, acty: st.acty && (burning || s.warp > 1), lights: {} };
      dsky.want(JSON.stringify(state), state);
    }
    // the scroll gets a point whenever the velocity has moved 300 ft/s or the load a quarter of a g
    const vk = (s.speedOrb * FT) / 1000, tl = trace[trace.length - 1];
    if (!tl || Math.abs(tl[0] - vk) > 0.3 || Math.abs(tl[1] - (s.gLoad || 0)) > 0.25) { trace.push([vk, s.gLoad || 0]); if (trace.length > 400) trace.splice(0, 100); scroll.want(trace.length + ':' + vk.toFixed(1)); }

    flushLive(lives, st.turn++, 2);
  }

  const cabin = {
    root, eye, look, up: upV, fov: 66, reach: { yaw: 1.5, up: 0.75, down: 0.8 }, update,
    dispose() { disposeTree(root); for (const k of Object.keys(TPL)) { TPL[k].dispose(); delete TPL[k]; } },
    info: { ms: 0, windows, sheets: [...sheets, ...wingSheets].map((S) => S.c), lives: lives.map((l) => l.c) },
  };
  cabin.info.ms = +(performance.now() - t0).toFixed(1);
  return cabin;
}
