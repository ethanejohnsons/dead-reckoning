// The crew cabins of the launch vehicles, for the view from the commander's seat.
//
//   buildCabin('saturnv' | 'starship') -> { root, eye, look, up, fov, reach, update(dt, s), dispose() }
//
// root is a THREE.Group in the vehicle root's axes (meters, origin at the center of the base of the stack,
// +Y toward the nose, +Z the underside), to be added to the vehicle's root and shown while the outside of
// the vehicle is hidden: the cabin brings its own walls and its windows are open to the scene. eye is the
// commander's eye point, look and up the resting gaze and the top of the head (unit vectors), fov the
// resting vertical field of view in degrees, reach { yaw, up, down } how far the head turns (radians).
// update(dt, s) takes the flight (see mission.js) and runs the instruments; s.exposure, if given, is the
// picture's exposure relative to daylight (the cabin's own lights are held steady against it).
//
// The cabins do not use the scene's lights (they would shine through the hull): see cabin-kit.js.
// cabin-apollo.js is the Apollo command module on top of the Saturn V, cabin-starship.js the flight deck
// in the nose of the Ship.

import { buildApollo } from './cabin-apollo.js';
import { buildStarshipCabin } from './cabin-starship.js';

const BUILDERS = { saturnv: buildApollo, starship: buildStarshipCabin };

export function buildCabin(vehicleId) {
  const build = BUILDERS[vehicleId];
  if (!build) throw new Error(`no cabin for vehicle "${vehicleId}"`);
  return build();
}
