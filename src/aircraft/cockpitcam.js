// The pilot's head in the seat (the left one of a Cessna or an airliner, the only one of a fighter).
//
// cockpitCamera() places the camera at the eye point and gives it a neck: free look
// from the mouse with a little inertia, wheel zoom, a slight glance into the turn,
// and a head that rides the aircraft on a soft spring so g, rough air, the runway
// and the touchdown all register without the horizon ever lurching. Where the eye is,
// how far down the gaze rests and how far the head can lean toward a window come with
// the aircraft (PILOT_EYE, PILOT_VIEW).

import * as THREE from 'three';
import { PILOT_EYE, PILOT_VIEW } from './model.js';

/** Near plane the cockpit needs: the door frame is a hand's width from the pilot's ear. */
export const COCKPIT_NEAR = 0.08;
// The resting view is an instrument pilot's: the eye sits low (see PILOT_EYE in model.js) and the gaze rests
// 18 degrees below the horizon, so the six flight instruments fill the middle of the screen and a band of
// windshield stays above the glareshield for the horizon and the runway. Looking round with the mouse lifts
// the gaze back toward level, so the side windows show the world and not the door cards.
// (PILOT_VIEW.down is set with the aircraft: a fighter looking through its head-up display rests its gaze nearly level.)
const FOV = 50;                              // resting field of view (deg); the downward tilt is PILOT_VIEW.down (rad)
const LEAN = [0.035, 0.085];                 // the Cessna's lean (see below); PILOT_VIEW.lean replaces it for another aircraft

const S = { yaw: 0, pitch: -PILOT_VIEW.down, fov: FOV, lead: 0, last: -1, t: 0, wasDown: true, strike: null, off: new THREE.Vector3(), vel: new THREE.Vector3() };
const v = new THREE.Vector3(), tgt = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ease = (dt, rate) => 1 - Math.exp(-dt * rate);
/** Smooth wandering signal in -1..1, different for each k. */
const wander = (t, k) => 0.5 * Math.sin(t * 1.0 + k * 1.7) + 0.3 * Math.sin(t * 2.31 + k * 4.1) + 0.2 * Math.sin(t * 4.07 + k * 9.3);

/**
 * Point `camera` out of the cockpit. Call once a frame while the cockpit view is up.
 *   ac     Aircraft (pos, quat, bank, beta, gLoad, onGround, groundSpeed, surface, touchdown, omega)
 *   input  { look: { yaw, pitch }, zoom } as kept by core/input.js. look.yaw is held to what a neck can do.
 *   dt     frame time in seconds (0 while paused: the view snaps to where it is aimed)
 *   turb   0..1 roughness of the air around the aircraft
 * Sets camera.position, quaternion, fov and near; the caller updates the projection matrix.
 * A scrape along the ground (ac.scrape) shakes the seat.
 */
export function cockpitCamera(camera, ac, input, dt, turb = 0) {
  const now = performance.now(), fresh = S.last < 0 || now - S.last > 400;       // first frame, or back from another view
  S.last = now;
  const look = input.look;
  look.yaw = clamp(look.yaw, -2.55, 2.55);                                       // about 145 degrees over either shoulder
  const yawT = look.yaw, down = PILOT_VIEW.down * (1 - 0.7 * sstep(0.35, 1.2, Math.abs(look.yaw)));
  const pitchT = clamp(-look.pitch * 0.8 - down, -1.25, 1.0);
  const fovT = clamp(FOV * input.zoom, 28, 96);
  const airborne = !ac.onGround;

  // a glance into the turn, fading as the pilot looks somewhere of their own choosing
  const leadT = airborne ? -clamp(ac.bank * 0.2, -0.15, 0.15) * (1 - sstep(0.25, 0.9, Math.abs(yawT))) : 0;   // yaw is positive to the left

  // what the seat is doing to the pilot: load factor, slip, rough air, runway rumble
  const g = airborne ? clamp(ac.gLoad, -1, 4) : 1;
  const roll = !airborne ? clamp(ac.groundSpeed / 25, 0, 1) * (ac.surface === 'paved' ? 0.3 : 1) : 0;      // wheels drumming on the runway
  const rough = clamp(turb, 0, 1) * (airborne ? 1 : 0.3);
  S.t += dt * (6 + 3 * roll);
  // How far the head leans as it turns to look back: [to the left, to the right] meters. In the Cessna the door is
  // close on the left and there is more room to the right; another aircraft says what its canopy or wall allows.
  const lean = PILOT_VIEW.lean || LEAN, side = yawT > 0 ? lean[0] : lean[1];
  tgt.set(
    -Math.sin(yawT) * side * sstep(0.5, 1.5, Math.abs(yawT)) - clamp((airborne ? ac.beta : 0) * 0.2, -0.018, 0.018) + rough * 0.011 * wander(S.t, 1),
    -clamp((g - 1) * 0.022, -0.03, 0.04) + rough * 0.02 * wander(S.t * 1.3, 2),
    rough * 0.006 * wander(S.t * 0.8, 3),
  );

  if (fresh || !(dt > 0)) {
    S.yaw = yawT + leadT; S.pitch = pitchT; S.fov = fovT; S.lead = leadT; S.off.copy(tgt); S.vel.set(0, 0, 0);
  } else {
    const h = Math.min(dt, 0.05);
    S.lead += (leadT - S.lead) * ease(h, 1.6);
    S.yaw += (yawT + S.lead - S.yaw) * ease(h, 13);
    S.pitch += (pitchT - S.pitch) * ease(h, 13);
    S.fov += (fovT - S.fov) * ease(h, 9);
    // the wheels meeting the runway push the head down into the seat
    if (S.wasDown === false && ac.onGround && ac.touchdown) S.vel.y -= clamp(ac.touchdown.sink, 0, 4) * 0.13;
    // anything else touching the ground (tail, wingtip) arrives as a jolt
    if (ac.strike && ac.strike !== S.strike) { S.vel.y -= clamp(ac.strike.vn, 0.5, 4) * 0.1; S.vel.z += (ac.strike.part === 'tail' ? -1 : 1) * 0.12; }
    // head on a damped spring (about 1.6 Hz, a little under critical so a bump rings once)
    const W = 10, Z = 0.6;
    v.copy(tgt).sub(S.off).multiplyScalar(W * W).addScaledVector(S.vel, -2 * Z * W);
    S.vel.addScaledVector(v, h); S.off.addScaledVector(S.vel, h);
    const reach = Math.max(0.1, lean[0] + 0.015, lean[1] + 0.015);
    S.off.set(clamp(S.off.x, -reach, reach), clamp(S.off.y, -0.05, 0.05), clamp(S.off.z, -0.03, 0.03));
  }
  S.wasDown = ac.onGround; S.strike = ac.strike || null;

  // the runway comes straight up through the seat: a fine, quick tremor that the neck does not have time to smooth
  const scr = clamp(ac.scrape || 0, 0, 1);
  v.set(roll * 0.0012 * wander(S.t * 2.7, 11) + scr * 0.004 * wander(S.t * 5.1, 13), roll * 0.003 * wander(S.t * 3.3, 9) + scr * 0.006 * wander(S.t * 6.3, 15), 0);
  camera.position.copy(PILOT_EYE).add(S.off).add(v).applyQuaternion(ac.quat).add(ac.pos);
  // the eyes dip a touch as the head is pressed down, and tremble very slightly in rough air
  e.set(S.pitch + S.off.y * 0.5 + rough * 0.004 * wander(S.t * 1.1, 5), S.yaw, rough * 0.004 * wander(S.t * 0.9, 7));
  camera.quaternion.copy(ac.quat).multiply(q.setFromEuler(e));
  camera.fov = S.fov; camera.near = COCKPIT_NEAR;
}
