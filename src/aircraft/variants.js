// The aircraft the player can choose from. Each entry is one variant: its menu name and blurb, the
// proportions that reshape the shared airframe (geom), its paint and fittings (look), the speeds its
// instruments are marked with (speeds) and its flight-model numbers (spec).
//
// Every variant is the same procedural high-wing single (see model.js), built to the 172's lines and
// then stretched: `warp` below moves any point of the 172 to where it sits on the variant. The flight
// model takes its wheel and hull contact points through the same function, so what touches the ground
// in the physics is what touches it on screen.

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Break lines of the stretch, in the 172's own coordinates (nose toward -Z, origin at the center of gravity).
const FW = -1.0, C0 = 0.30, C1 = 1.16;      // firewall; front and back of the rear-seat bay
const XB = 0.55;                            // cabin side: inboard of it the cabin width scales, outboard the span
const YB = -0.6;                            // belly line: below it the landing gear length scales

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

// Contact points on the 172 (body frame, legs unloaded). Wheels: two mains just aft of the center of
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
  { part: 'top', p: [0, 0.93, 0.0], vMax: 0, k: 60e3, c: 6e3 },              // cabin roof and wing center section
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
  sinkMax: 7.0,                               // closing speed the landing gear survives, m/s
  tipDrag: 20,                                // a wingtip that digs in faster than this over the ground cartwheels, m/s
  // What the rest of the game asks of an aircraft (the same for the three Cessnas; the jets bring their own).
  spool: 0.9,                                 // seconds for the engine to follow the lever
  flapLift: 0.7,                              // lift coefficient full flap adds
  pitchStiff: 9.5,                            // how hard the tail holds the angle of attack (angular acceleration per radian at vRef)
  steerFade: 22,                              // ground speed (m/s) by which nose-wheel steering has faded to a trace
  cruise: 54, cruiseThrottle: 0.7,            // speed (m/s) and lever position of a start in the air
  startAgl: 450,                              // height above the ground of a start in the air, m
  ceiling: 7500,                              // highest altitude the autopilot will hold, m
  apClimb: 3.6, apSink: 5, apSlow: 33,        // autopilot: most climb and descent (m/s), and the airspeed (m/s) at which it stops climbing
  apPitch: 0.25, apRoll: 2.2, apBank: 25,     // autopilot: how hard it pulls and rolls, and its steepest bank (degrees)
  apStep: 55,                                 // how fast the autopilot's altitude is wound up and down, m/s
  flapAuto: [40, 35, 45],                     // the flaps set themselves: half below, full below, up above (m/s indicated)
  runway: 0,                                  // shortest runway it will start from, m (a shorter one: the flight starts in the air)
};

/** Build a variant's spec: the 172's numbers with `over` laid on top, contact points moved by its geometry. */
function makeSpec(geom, over) {
  const s = { ...BASE, ...over }, mk = s.mass / BASE.mass, p = [];
  s.wheels = WHEELS.map(([x, y, z, main]) => { warp(geom, x, y, z, p); return { x: p[0], y: p[1], z: p[2], k: (main ? 59e3 : 28.5e3) * mk, c: (main ? 5400 : 2600) * mk, main }; });
  s.hull = HULL.map((h) => { warp(geom, h.p[0], h.p[1], h.p[2], p); return { part: h.part, p: [p[0], p[1], p[2]], vMax: h.vMax, k: h.k * mk, c: h.c * mk }; });
  s.washRef = s.staticThrust / 1.2;           // propeller wash over the tail, relative to this engine's pull
  s.gearHeight = -s.wheels[0].y - 0.07;       // center of gravity above the ground when parked
  return s;
}

// ---------------------------------------------------------------- jets

// What every jet shares, laid over BASE. Thrust: staticThrust at rest with the lever forward (without afterburner),
// times (1 - thrustLapse * M + thrustRam * M^2), thinning with the air; `reheat` is what the afterburner multiplies
// it by over the last part of the lever's travel (0: none). Drag: waveDrag is added as the Mach number passes mCrit,
// gearDrag with the legs down, brakeDrag with the airbrakes open (they open as the lever reaches idle).
const JET = {
  jet: true, spool: 2.2, idleThrust: 0.06, thrustLapse: 0.45, thrustRam: 0, reheat: 0,
  mCrit: 0.8, waveDrag: 0.06, gearDrag: 0.018, brakeDrag: 0.035,
  retract: 5, gearSpeed: 105,                 // seconds the legs take to travel; fastest indicated airspeed (m/s) they come down at
  rpmIdle: 22, rpmMax: 100,                   // fan speed, percent
  steerFade: 60, gearRebound: 0.65,
};
const HULL_K = { nose: 60e3, tail: 40e3, tipL: 25e3, tipR: 25e3, belly: 90e3, top: 60e3 };
const HULL_V = { nose: 4, tail: 4.5, tipL: 3, tipR: 3, belly: 5, top: 0 };

/**
 * A jet's spec. `over` are its numbers; `shape` says where it meets the ground, in its own axes (origin at the
 * center of gravity, nose toward -Z):
 *   gear   { track, zNose, zMain, y, yNose, defl }: distance between the main wheels, stations of the nose and main
 *          legs, height of the wheels' undersides with the legs hanging free (the nose wheel's too, where it differs),
 *          and how far they settle under the parked weight
 *   hull   [[part, x, y, z], ...]: nose, tail, tipL, tipR, belly (engine pods count), top
 */
function jetSpec(over, shape) {
  const s = stand({ ...BASE, ...JET, ...over }, shape);
  s.washRef = Infinity;                       // no propeller blowing over the tail
  return s;
}
/** A propeller aircraft's spec from the same description (for one that is not the stretched Cessna): BASE with `over` laid on top. */
function pistonSpec(over, shape) {
  const s = stand({ ...BASE, ...over }, shape);
  s.washRef = s.staticThrust / 1.2;
  return s;
}
/** Stand a spec on its legs: the wheels' springs sized to the weight each carries, the hull points, and how it sits at rest. */
function stand(s, shape) {
  const m = s.mass, mk = m / BASE.mass;
  const { track, zNose, zMain, y, yNose = y, defl } = shape.gear;       // (zNose: the third wheel, under the nose or the tail)
  const nose = zMain / (zMain - zNose), main = (1 - nose) / 2;       // share of the weight on each leg
  const leg = (x, z, share, isMain) => { const k = (share * m * 9.81) / defl; return { x, y: isMain ? y : yNose, z, k, c: 1.08 * Math.sqrt(k * share * m), main: isMain }; };
  s.wheels = [leg(-track / 2, zMain, main, true), leg(track / 2, zMain, main, true), leg(0, zNose, nose, false)];
  s.hull = shape.hull.map(([part, hx, hy, hz]) => ({ part, p: [hx, hy, hz], vMax: HULL_V[part], k: HULL_K[part] * mk, c: HULL_K[part] * mk * 0.1 }));
  s.wheelDrop = -y - defl;                    // the center of gravity above the undersides of the main wheels as they stand
  s.gearHeight = s.wheelDrop;                 // ... and above the ground when parked
  if (zNose > 0) {
    // A tail wheel: at rest the aircraft sits nose-high on all three.
    const th = Math.atan2(yNose - y, zNose - zMain);
    s.groundPitch = th; s.gearHeight = -((y + defl) * Math.cos(th) - zMain * Math.sin(th));
    s.tailSteady = 0.4 - zMain;               // how far back the main wheels' grip is taken to act, for steering (see the wheels in physics.js)
  }
  return s;
}

/**
 * A jet's airframe as the weather sees it (what rain is kept out of and hail strikes: see AIRFRAME_172 in
 * weather/precip.js), from a few measurements: a round fuselage from z0 to z1 of radius r about height y, its nose
 * tapering over noseLen and its tail over tailLen (rising tailUp); the stretches of its upper surface (cowl: the
 * nose ahead of the windshield, screen, aft); and the wing, stabilizer and fin as flat panels.
 */
function tubeFrame({ z0, z1, r, y, noseLen, tailLen, tailUp = 0, screen, wing, stab, fin }) {
  const hull = [], N = 15;
  for (let i = 0; i <= N; i++) {
    const z = z0 + ((z1 - z0) * i) / N, a = (z1 - z) / tailLen;
    const k = z < z0 + noseLen ? Math.pow(Math.max((z - z0) / noseLen, 0.03), 0.6) : a < 1 ? Math.max(0.08, Math.pow(a, 0.8)) : 1;
    const yc = y + (a < 1 ? tailUp * (1 - a) : 0);
    hull.push([z, yc + r * k, yc - r * k, r * k, yc, 2]);
  }
  return { hull, cabin: [screen[0], z1 - tailLen], cowl: [z0 + 0.1 * noseLen, screen[0]], screen, aft: [screen[1], z1 - tailLen], wing, stab, fin };
}

// ---------------------------------------------------------------- the fleet

const G172 = { nose: 1, cabin: 1, tail: 1, width: 1, span: 1, gear: 1, cowl: 0 };
// Two seats: the rear-seat bay all but disappears, everything a little narrower, shorter and lower.
const G152 = { nose: 0.93, cabin: 0.3, tail: 0.93, width: 0.93, span: 0.92, gear: 0.86, cowl: 0 };
// The big six up front: a longer, deeper cowl, a wider cabin, a slightly longer tail on taller legs.
const G182 = { nose: 1.3, cabin: 1.05, tail: 1.03, width: 1.06, span: 0.993, gear: 1.04, cowl: 0.05 };

export const AIRCRAFT = [
  {
    id: 'c172', group: 'Piston singles', name: 'Cessna 172 Skyhawk', blurb: 'The four-seat trainer everyone learns on. Forgiving and steady.',
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
    id: 'c152', group: 'Piston singles', name: 'Cessna 152', blurb: 'Two seats and 110 horsepower. Light on the controls, quick in roll, and it floats.',
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
    id: 'c182', group: 'Piston singles', name: 'Cessna 182 Skylane', blurb: 'The big-engined one. Climbs hard and cruises fast, heavy in pitch, and wants more runway to stop.',
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
  {
    id: 'p51d', name: 'P-51D Mustang', group: 'Warbirds', blurb: 'A 1,500-horsepower fighter from 1944 with a tail wheel. Fast and eager; the legs fold away by themselves once you are climbing.',
    reg: '', seats: 1,
    speeds: { vr: 95 },
    // (The file's origin is the spinner's back plate; the center of gravity is taken 2.55 m behind it, on the thrust line.)
    model: {
      url: 'models/p51d.glb', cg: 2.55, ground: -2.22,
      clear: [/^PropellerDisk$/],
      prop: { blades: [/^propBlade\d$/], disk: [/^PropellerDisk$/], hub: [0, -0.07] },
      drive: { elev: (ac) => -ac.elev },
      lights: { navL: [-5.67, -0.2, 2.53], navR: [5.67, -0.19, 2.53], tail: [0, 0.2, 9.04], landing: [-0.9, -0.72, 2.45] },
      exhaust: [[-0.47, 0, 1.1], [0.47, 0, 1.1]],
      tips: [-0.2, 2.9],
    },
    eye: [0, 0.6, 3.75], view: { scale: 1.15, down: 0.06 },
    frame: tubeFrame({ z0: -3.3, z1: 6.45, r: 0.5, y: -0.1, noseLen: 0.7, tailLen: 3.5, tailUp: 0.3, screen: [0.35, 0.9], wing: { span: 11.3, y: -0.4, rise: 0.5, zLE: -1.25, zTE: 1.4, thick: 0.25 }, stab: { half: 2, y: 0.3, zLE: 4.4, zTE: 5.7 }, fin: { foot: [4.2, 0.4], tip: [5.6, 1.66], thick: 0.1 } }),
    spec: pistonSpec({
      mass: 4100, S: 21.83, span: 11.28, Ipitch: 12e3, Iyaw: 17e3, Iroll: 8e3,
      CL0: 0.25, CLa: 4.6, CD0: 0.0045, K: 0.068, aStall: 16, groundEffect: 0.4, flapDrag: 1,
      power: 1110e3, propEff: 0.82, staticThrust: 15e3, propZero: 330,
      rpmIdle: 700, rpmStatic: 2800, rpmWind: 1, rpmMax: 3000,
      vRef: 90, rollPower: 7, rollDamp: 4.6, pitchPower: 4.2, pitchDamp: 3.4, pitchGain: 1.8, pitchRate: 0.6, gPull: 6, yawPower: 1.3,
      rotatePitch: 0.14, brake: 0.4, gearRebound: 0.4, sinkMax: 6, tipDrag: 25, steerFade: 30,
      retract: 4, gearSpeed: 75, gearDrag: 0.012,
      cruise: 110, cruiseThrottle: 0.6, startAgl: 800, ceiling: 10000,
      apClimb: 12, apSink: 12, apSlow: 60, apPitch: 0.12, apRoll: 2, apBank: 35, apStep: 100,
      flapAuto: [70, 58, 80], runway: 550,
    }, {
      gear: { track: 3.66, zNose: 4.32, zMain: -0.64, y: -2.34, yNose: -1.04, defl: 0.12 },
      hull: [['nose', 0, -0.07, -3.35], ['nose', 0, -1.78, -2.95], ['tail', 0, -0.4, 5.6], ['tipL', -5.65, -0.2, 0.2], ['tipR', 5.65, -0.2, 0.2], ['belly', 0, -1.16, 1.6], ['top', 0, 0.95, 1.0], ['top', 0, 1.66, 6.0]],
    }),
  },
  {
    id: 'f16', name: 'F-16 Fighting Falcon', group: 'Fighter jets', blurb: 'A single-engine fighter. Rolls in a blink, pulls eight g, and with the lever all the way forward the afterburner takes it past the speed of sound.',
    seats: 1,
    speeds: { vr: 150 },
    // The model file (see gltfmodel.js for the fields). Positions here are the file's own: its origin is where the
    // center of gravity is taken to be, and its main wheels stand 1.80 m below it.
    model: {
      url: 'models/f16.glb', cg: 0, ground: -1.8,
      stow: [/Tire|Strut/],
      // The nose leg is drawn hanging free: on the ground it is pushed in by what the main legs settle.
      rig: [{ on: ['FrontGear'], by: 'gear', kind: 't', axis: [0, 1, 0], c: [0, 0, 0], tab: [[0, 0], [1, 0.12]] }],
      // Flaperons: both down as flaps, opposite ways as ailerons. The leading-edge flaps droop with them.
      // The tailplanes move together for pitch and a little apart for roll.
      drive: {
        flapL: (ac) => -0.75 * ac.flap - 0.6 * ac.ail, flapR: (ac) => 0.75 * ac.flap - 0.6 * ac.ail,
        elevL: (ac) => ac.elev - 0.3 * ac.ail, elevR: (ac) => -ac.elev - 0.3 * ac.ail,
      },
      skip: ['flap'],
      lights: { navL: [-4.57, 0.02, 1.62], navR: [4.57, 0.02, 1.62], tail: [0, 1.15, 5.52], strobeL: [0, 3.26, 5.31], landing: [0, -1.25, -3.08] },
      exhaust: [[0, 0, 5.4, 14, 2.6]],
      nozzle: { at: [0, 0.005, 4.45], r0: 0.55, r1: 0.4, len: 1.0 },
      burner: { at: [[0, 0.005, 5.3]], r: 0.38, len: 5.5 },
      tips: [0, 1.5],
    },
    eye: [0, 0.98, -4.25], view: { scale: 1.35, down: 0.06 },
    frame: tubeFrame({ z0: -7.6, z1: 5.4, r: 0.7, y: 0, noseLen: 4.5, tailLen: 1, screen: [-5.4, -3.4], wing: { span: 9.6, y: 0.1, rise: 0, zLE: -0.6, zTE: 2.3, thick: 0.15 }, stab: { half: 2.8, y: -0.1, zLE: 3.4, zTE: 5.5 }, fin: { foot: [2.9, 1.1], tip: [5.1, 3.2], thick: 0.1 } }),
    spec: jetSpec({
      mass: 10800, S: 27.9, span: 9.6, Ipitch: 78e3, Iyaw: 95e3, Iroll: 14e3,
      CL0: 0.04, CLa: 3.6, CD0: 0.008, K: 0.12, aStall: 26, flapLift: 0.45, flapDrag: 0.6, groundEffect: 0.3,
      staticThrust: 76e3, reheat: 1.68, thrustLapse: 0.32, thrustRam: 0.2, idleThrust: 0.05, spool: 1.4,
      mCrit: 0.92, waveDrag: 0.022, gearDrag: 0.02, brakeDrag: 0.045, retract: 3.5, gearSpeed: 110,
      vRef: 150, rollPower: 11, rollDamp: 5, pitchPower: 7, pitchDamp: 4, pitchGain: 2.2, pitchRate: 0.55, gPull: 8, yawPower: 1.2,
      rotatePitch: 0.2, brake: 0.5, sinkMax: 6, tipDrag: 30,
      cruise: 230, cruiseThrottle: 0.25, startAgl: 1500, ceiling: 15000,
      apClimb: 60, apSink: 50, apSlow: 80, apPitch: 0.05, apRoll: 1.2, apBank: 45, apStep: 300,
      flapAuto: [105, 90, 120], runway: 900,
    }, {
      gear: { track: 2.44, zNose: -3.02, zMain: 0.56, y: -1.92, defl: 0.12 },
      hull: [['nose', 0, -0.2, -7.6], ['tail', 0, -1.26, 2.6], ['tail', 0, -0.55, 5.3], ['tipL', -4.8, 0, 1.3], ['tipR', 4.8, 0, 1.3], ['belly', 0, -0.88, 0], ['top', 0, 1.13, -4], ['top', 0, 3.2, 5.4]],
    }),
  },
  {
    id: 'b737', name: 'Boeing 737-800', group: 'Airliners', blurb: 'A twin-jet airliner with 160 seats behind you. Heavy and unhurried: plan the turns, and give it a long runway.',
    seats: 162,
    speeds: { vr: 145 },
    // (The file's origin is amidships: the center of gravity is taken a meter ahead of it, 1.3 m ahead of the main wheels.)
    model: {
      url: 'models/b738.glb', cg: -1.0, ground: -3.01,
      drive: { elev: (ac) => -ac.elev },
      lights: { navL: [-17.03, 1.06, 3.62], navR: [17.03, 1.06, 3.62], strobeL: [-17.03, 1.08, 3.9], strobeR: [17.03, 1.08, 3.9], tail: [0, 2.06, 18.62], beacon: [0, 2.62, -1], landing: [0, -1.6, -15.73] },
      exhaust: [[-5.16, -1.25, -0.9, 16, 3], [5.16, -1.25, -0.9, 16, 3]],
      tips: [1.1, 4.3],
    },
    eye: [-0.5, 1.15, -17.95], view: { scale: 3.3, down: 0.06 },
    frame: tubeFrame({ z0: -18.8, z1: 20.6, r: 1.88, y: 0.58, noseLen: 4.5, tailLen: 8, tailUp: 0.9, screen: [-17.4, -15.6], wing: { span: 34.3, y: -0.3, rise: 1.4, zLE: -1.5, zTE: 4, thick: 0.5 }, stab: { half: 5.9, y: 2.1, zLE: 16.5, zTE: 20.2 }, fin: { foot: [11, 2.5], tip: [19, 9.9], thick: 0.3 } }),
    spec: jetSpec({
      mass: 62000, S: 124.6, span: 35.7, Ipitch: 3.2e6, Iyaw: 4.2e6, Iroll: 1.2e6,
      CL0: 0.2, CLa: 5.5, CD0: 0.008, K: 0.042, aStall: 14, flapLift: 1.1, flapDrag: 1.2, groundEffect: 0.3,
      staticThrust: 234e3, thrustLapse: 0.5, idleThrust: 0.06, spool: 2.5,
      mCrit: 0.8, waveDrag: 0.07, gearDrag: 0.018, brakeDrag: 0.035, retract: 6, gearSpeed: 105,
      vRef: 110, rollPower: 1.9, rollDamp: 4.5, pitchPower: 2.6, pitchDamp: 3.6, pitchGain: 1.6, pitchRate: 0.14, gPull: 2.2, yawPower: 0.8,
      rotatePitch: 0.16, brake: 0.45, sinkMax: 6.5, tipDrag: 30,
      cruise: 150, cruiseThrottle: 0.2, startAgl: 3000, ceiling: 12500,
      apClimb: 15, apSink: 12, apSlow: 95, apPitch: 0.08, apRoll: 2.2, apBank: 25, apStep: 150,
      flapAuto: [115, 90, 125], runway: 1500,
    }, {
      gear: { track: 5.74, zNose: -14.5, zMain: 1.29, y: -3.19, yNose: -3.02, defl: 0.18 },
      hull: [['nose', 0, -0.4, -17.8], ['tail', 0, -0.3, 15.3], ['tipL', -17.3, 1.1, 5.5], ['tipR', 17.3, 1.1, 5.5], ['belly', 0, -1.5, 0], ['belly', -5.15, -2.2, -2.6], ['belly', 5.15, -2.2, -2.6], ['top', 0, 2.56, -5], ['top', 0, 9.9, 20.5]],
    }),
  },
];
export const aircraftById = (id) => AIRCRAFT.find((a) => a.id === id) || AIRCRAFT[0];
