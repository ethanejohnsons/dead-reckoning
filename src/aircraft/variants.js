// The aircraft the player can choose from. Each entry is one variant: its menu name and blurb, the
// proportions that reshape the shared airframe (geom), its paint and fittings (look), the speeds its
// instruments are marked with (speeds) and its flight-model numbers (spec).
//
// Every variant is the same procedural high-wing single (see model.js), built to the 172's lines and
// then stretched: `warp` below moves any point of the 172 to where it sits on the variant. The flight
// model takes its wheel and hull contact points through the same function, so what touches the ground
// in the physics is what touches it on screen.

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Break lines of the stretch, in the 172's own coordinates (nose toward -Z, origin at the centre of gravity).
const FW = -1.0, C0 = 0.30, C1 = 1.16;      // firewall; front and back of the rear-seat bay
const XB = 0.55;                            // cabin side: inboard of it the cabin width scales, outboard the span
const YB = -0.6;                            // belly line: below it the undercarriage length scales

/**
 * Move a point of the 172 airframe to its place on a variant.
 *   g    { nose, cabin, tail, width, span, gear, cowl }: length factors ahead of the firewall, through the
 *        rear-seat bay and aft of it; cabin width and outer span factors; leg length factor; extra cowl depth (m)
 *   out  optional array: receives [x, y, z, sx, sy, sz] (position, then the local stretch along each axis)
 */
export function warp(g, x, y, z, out = []) {
  let zz, sz;
  if (z < FW) { zz = FW + (z - FW) * g.nose; sz = g.nose; }
  else if (z < C0) { zz = z; sz = 1; }
  else if (z < C1) { zz = C0 + (z - C0) * g.cabin; sz = g.cabin; }
  else { zz = C0 + (C1 - C0) * g.cabin + (z - C1) * g.tail; sz = g.tail; }
  const ax = Math.abs(x), wide = ax < XB;
  const xx = (wide ? ax * g.width : XB * g.width + (ax - XB) * g.span) * (x < 0 ? -1 : 1);
  let yy = y, sy = 1;
  if (y < YB) { yy = YB + (y - YB) * g.gear; sy = g.gear; }
  // a deeper cowl: the underside of the nose drops, fading out toward the top line and toward the wheels
  if (g.cowl && z < FW + 0.1) yy -= g.cowl * sstep(FW + 0.1, FW - 0.3, z) * sstep(0.05, -0.3, y) * (1 - sstep(-0.62, -0.92, y));
  out[0] = xx; out[1] = yy; out[2] = zz; out[3] = wide ? g.width : g.span; out[4] = sy; out[5] = sz;
  return out;
}

/** Station of the 172 that ends up at station z of the variant (the inverse of warp along the fuselage). */
export function unwarpZ(g, z) {
  const c1 = C0 + (C1 - C0) * g.cabin;
  return z < FW ? FW + (z - FW) / g.nose : z < C0 ? z : z < c1 ? C0 + (z - C0) / g.cabin : C1 + (z - c1) / g.tail;
}

// ---------------------------------------------------------------- flight-model numbers

// Contact points on the 172 (body frame, legs unloaded). Wheels: two mains just aft of the centre of
// gravity and a nose wheel; each leg settles about 7 cm under the parked weight.
const WHEELS = [[-1.25, -1.22, 0.32, true], [1.25, -1.22, 0.32, true], [0, -1.22, -1.33, false]];
// Hull: the parts that can meet the ground. vMax is the closing speed (m/s, along the ground's normal)
// that part survives; k and c are how hard it pushes back (N/m, N s/m, for the 172's weight).
const HULL = [
  { part: 'nose', p: [0, 0.03, -2.25], vMax: 4.0, k: 60e3, c: 6e3 },         // spinner
  { part: 'nose', p: [0, -0.42, -1.70], vMax: 4.0, k: 60e3, c: 6e3 },        // cowl chin
  { part: 'tail', p: [0, 0.22, 5.75], vMax: 4.5, k: 40e3, c: 4e3 },          // tie-down ring under the tail cone
  { part: 'tipL', p: [-5.48, 0.97, 0.3], vMax: 3.0, k: 25e3, c: 2.5e3 },
  { part: 'tipR', p: [5.48, 0.97, 0.3], vMax: 3.0, k: 25e3, c: 2.5e3 },
  { part: 'belly', p: [0, -0.6, 0.3], vMax: 5.0, k: 90e3, c: 9e3 },
  { part: 'top', p: [0, 0.93, 0.0], vMax: 0, k: 60e3, c: 6e3 },              // cabin roof and wing centre section
  { part: 'top', p: [0, 1.55, 5.70], vMax: 0, k: 40e3, c: 4e3 },             // fin tip
];

const BASE = {
  mass: 1050, S: 16.2, span: 11.0,
  Ipitch: 1825, Iyaw: 2670, Iroll: 1285,
  CL0: 0.32, CLa: 4.8, CD0: 0.025, K: 0.057,
  aStall: 15.5,                               // clean stalling angle of attack, degrees
  groundEffect: 0.45,                         // share of the induced drag lost close to the runway
  flapDrag: 1,                                // drag of the flaps, relative to the 172's
  // Power through the propeller: thrust falls away steadily with airspeed (it would reach zero at
  // propZero) and is power-limited beyond top speed.
  power: 135e3, propEff: 0.78, staticThrust: 2400, propZero: 205,
  rpmIdle: 1000, rpmStatic: 2300, rpmWind: 6.2, rpmMax: 2700,
  fuelCap: 150, fuelFlow: 0.011,              // kg, kg/s at full power
  // Handling. The control gains are angular accelerations at the dynamic pressure of vRef (m/s).
  vRef: 44,
  rollPower: 4.6, rollDamp: 4.2,              // aileron authority and roll damping: their ratio sets the roll rate
  pitchPower: 3.5, pitchDamp: 3.2, pitchGain: 1.6,
  pitchRate: 0.62, gPull: 2.7,                // most pitch rate the stick asks for (rad/s), and the g it is held to
  yawPower: 1.25,
  rotatePitch: 0.19,                          // attitude the elevator will hold the nose to on the runway (rad)
  brake: 0.42,                                // wheel braking, share of the weight on the mains
  gearRebound: 0.3,                           // share of the legs' damping that acts on the rebound: low, so a hard landing hops
  sinkMax: 7.0,                               // closing speed the undercarriage survives, m/s
  tipDrag: 20,                                // a wingtip that digs in faster than this over the ground cartwheels, m/s
};

/** Build a variant's spec: the 172's numbers with `over` laid on top, contact points moved by its geometry. */
function makeSpec(geom, over) {
  const s = { ...BASE, ...over }, mk = s.mass / BASE.mass, p = [];
  s.wheels = WHEELS.map(([x, y, z, main]) => { warp(geom, x, y, z, p); return { x: p[0], y: p[1], z: p[2], k: (main ? 59e3 : 28.5e3) * mk, c: (main ? 5400 : 2600) * mk, main }; });
  s.hull = HULL.map((h) => { warp(geom, h.p[0], h.p[1], h.p[2], p); return { part: h.part, p: [p[0], p[1], p[2]], vMax: h.vMax, k: h.k * mk, c: h.c * mk }; });
  s.washRef = s.staticThrust / 1.2;           // propeller wash over the tail, relative to this engine's pull
  s.gearHeight = -s.wheels[0].y - 0.07;       // centre of gravity above the ground when parked
  return s;
}

// ---------------------------------------------------------------- the fleet

const G172 = { nose: 1, cabin: 1, tail: 1, width: 1, span: 1, gear: 1, cowl: 0 };
// Two seats: the rear-seat bay all but disappears, everything a little narrower, shorter and lower.
const G152 = { nose: 0.93, cabin: 0.3, tail: 0.93, width: 0.93, span: 0.92, gear: 0.86, cowl: 0 };
// The big six up front: a longer, deeper cowl, a wider cabin, a slightly longer tail on taller legs.
const G182 = { nose: 1.3, cabin: 1.05, tail: 1.03, width: 1.06, span: 0.993, gear: 1.04, cowl: 0.05 };

export const AIRCRAFT = [
  {
    id: 'c172', name: 'Cessna 172 Skyhawk', blurb: 'The four-seat trainer everyone learns on. Forgiving and steady.',
    reg: 'N172DR', seats: 4, geom: G172,
    look: {
      scheme: 'sweep', base: '#f2f1ec', accent: '#b0151b', line: '#22252b',
      blades: 2, propR: 0.95, spinner: 1, pants: true, rearWindow: true, landing: 'wing',
      interior: { seat: '#3c4252', insert: '#565d6e', trim: '#8f8a80', carpet: '#33353a', panel: '#3b3c40' },
    },
    speeds: { vs0: 40, vs1: 48, vfe: 85, vno: 129, vne: 163, vr: 55, vy: 74, asiMax: 190, rpmGreen: [2100, 2700], rpmRed: 2700 },
    spec: makeSpec(G172, {}),
  },
  {
    id: 'c152', name: 'Cessna 152', blurb: 'Two seats and 110 horsepower. Light on the controls, quick in roll, and it floats.',
    reg: 'N152DR', seats: 2, geom: G152,
    look: {
      scheme: 'belly', base: '#f4f3ee', accent: '#1d4f91', line: '#e8a713',
      blades: 2, propR: 0.88, spinner: 0.86, pants: false, rearWindow: false, landing: 'cowl',
      interior: { seat: '#5a3a2a', insert: '#8a6a4c', trim: '#a39a88', carpet: '#3a3530', panel: '#45423c' },
    },
    speeds: { vs0: 35, vs1: 40, vfe: 85, vno: 111, vne: 149, vr: 50, vy: 67, asiMax: 160, rpmGreen: [1900, 2550], rpmRed: 2550 },
    spec: makeSpec(G152, {
      mass: 720, S: 14.9, span: 10.2, Ipitch: 980, Iyaw: 1500, Iroll: 760,
      CD0: 0.027, groundEffect: 0.75, flapDrag: 0.4,
      power: 82e3, propEff: 0.78, staticThrust: 1600, propZero: 195,
      rpmIdle: 950, rpmStatic: 2250, rpmWind: 6.4, rpmMax: 2550,
      fuelCap: 70, fuelFlow: 0.0065,
      vRef: 40, rollPower: 5.6, rollDamp: 4.0, pitchPower: 3.9, pitchDamp: 3.1, pitchGain: 1.9, pitchRate: 0.7, yawPower: 1.4,
      brake: 0.44,
    }),
  },
  {
    id: 'c182', name: 'Cessna 182 Skylane', blurb: 'The big-engined one. Climbs hard and cruises fast, heavy in pitch, and wants more runway to stop.',
    reg: 'N182DR', seats: 4, geom: G182,
    look: {
      scheme: 'twin', base: '#eeece4', accent: '#16243c', line: '#c8641a',
      blades: 3, propR: 1.0, spinner: 1.12, pants: true, rearWindow: true, landing: 'cowl2',
      interior: { seat: '#6b6558', insert: '#8c8676', trim: '#9a968c', carpet: '#2c3038', panel: '#34373c' },
    },
    speeds: { vs0: 45, vs1: 52, vfe: 100, vno: 140, vne: 175, vr: 60, vy: 88, asiMax: 200, rpmGreen: [2100, 2400], rpmRed: 2400 },
    spec: makeSpec(G182, {
      mass: 1300, S: 16.2, span: 11.0, Ipitch: 2500, Iyaw: 3500, Iroll: 1620,
      CD0: 0.024,
      power: 172e3, propEff: 0.85, staticThrust: 3450, propZero: 265,
      rpmIdle: 900, rpmStatic: 2400, rpmWind: 3, rpmMax: 2400,
      fuelCap: 230, fuelFlow: 0.015,
      vRef: 48, rollPower: 3.9, rollDamp: 4.4, pitchPower: 3.1, pitchDamp: 3.4, pitchGain: 1.2, pitchRate: 0.5, gPull: 2.5, yawPower: 1.15,
      brake: 0.36,
    }),
  },
];
export const aircraftById = (id) => AIRCRAFT.find((a) => a.id === id) || AIRCRAFT[0];
