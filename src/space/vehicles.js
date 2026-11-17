// The launch vehicles the game can fly, as procedural models: the list the menus show (VEHICLES) and
// buildVehicle(id), which returns the model wrapped in one interface whatever the rocket:
//
//   { id, root, height, radius, stages, setStage(n), spent(n), update(dt, s), dispose() }
//
// root is a THREE.Group in meters with its origin at the center of the plane the first-stage engine bells
// end on and +Y toward the nose. stages[i] = { name, group, bottomY, topY, nozzles (exit-plane centers in
// root coordinates), nozzleRadius, propellant }; some stages add nozzleRadii, one radius per nozzle, where
// the engines differ. setStage(n) hides the stages below n, spent(n) returns a detached copy of stage n to
// drift away, update(dt, s) swivels the engines, lights the nozzles and moves Starship's flaps.
//
// The models themselves are in model-saturnv.js and model-starship.js; what they share (surfaces of
// revolution, lattice beams, the engine texture, the stage bookkeeping) is in model-kit.js.

import { buildSaturnV } from './model-saturnv.js';
import { buildStarship } from './model-starship.js';

export const VEHICLES = [
  {
    id: 'saturnv', name: 'Saturn V', height: 110.6, diameter: 10.1,
    blurb: 'The Apollo moon rocket: three stages, eleven engines and a spacecraft that can go on to lunar orbit.',
    stages: [
      { name: 'S-IC', propellant: 'kerolox', engines: 5 },
      { name: 'S-II', propellant: 'hydrolox', engines: 5 },
      { name: 'S-IVB', propellant: 'hydrolox', engines: 1 },
      { name: 'CSM', propellant: 'hypergolic', engines: 1 },
    ],
  },
  {
    id: 'starship', name: 'Starship', height: 121.3, diameter: 9,
    blurb: 'A stainless-steel giant: thirty-three methane engines under the booster, and a ship that flies itself to orbit.',
    stages: [
      { name: 'Super Heavy', propellant: 'methalox', engines: 33 },
      { name: 'Ship', propellant: 'methalox', engines: 6 },
    ],
  },
];

const BUILDERS = { saturnv: buildSaturnV, starship: buildStarship };

export function buildVehicle(id) {
  const build = BUILDERS[id];
  if (!build) throw new Error(`unknown vehicle "${id}"`);
  return build();
}
