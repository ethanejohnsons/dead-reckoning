# How Dead Reckoning is put together

A map of the code for someone opening it for the first time: what it is written
in, what runs where, where the data comes from, and what each file does. The
README says what the game does; the long comment at the top of each file says
how that file does it. This document sits between the two.

## Stack

| | |
|---|---|
| Language | JavaScript (ES modules, no TypeScript, no framework), with the shaders in GLSL ES 3.0 inside template strings |
| Rendering | [three.js](https://threejs.org) 0.187 on WebGL2: the only runtime dependency. Mostly custom `ShaderMaterial`s; three.js supplies the scene graph, render targets, buffers and math |
| Build | [Vite](https://vite.dev) 8, with no config file: `npm run dev` serves, `npm run build` writes a static site to `dist/`. Workers are bundled from `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })` |
| UI | Plain HTML (`index.html`) and CSS (`src/ui/style.css`), driven from `src/main.js` by element id. No UI library |
| Offline tools | Node scripts (`tools/*.mjs`: airfield and town bakes from OpenStreetMap, OurAirports and GeoNames; the magnetic model's table) and Python 3 with NumPy and Pillow (`tools/*.py`: climate grid, wall materials, stars, Milky Way) |
| Hosting | A static site. `Dockerfile` builds it with Node 22 and serves it with nginx (`deploy/nginx.conf`); `compose.yaml` wraps that |
| Tests, lint | None |

Two pieces of three.js are imported by path rather than from the package root:
`three/src/extras/lib/earcut.js` (polygon triangulation, in the city and land
cover workers) and `three/addons/utils/BufferGeometryUtils.js` (merging the
aircraft's parts, `src/aircraft/kit.js`, `gltfmodel.js` and `pit.js`). `gltfmodel.js`
and `pit.js` also use `three/addons/loaders/GLTFLoader.js`.

### Adding an aircraft

An aircraft is one entry in `AIRCRAFT` (`src/aircraft/variants.js`). For one
that comes as a model file: convert it with `tools/ac2glb.py` (or supply any
`.glb` already in the game's axes: meters, +X right wing, +Y up, -Z out the
nose), put it in `public/models/`, and give the entry a `model` block (where
the file's center of gravity and wheels are, lights, nozzles: the fields are
listed at the top of `gltfmodel.js`), a `spec` from `jetSpec` or `pistonSpec`
(the flight model's numbers, the wheels and the points of the hull that can
meet the ground), an `eye` point, a `view.scale` (how far back the cameras
stand) and a `frame` (its shape for the rain and hail). A cockpit is a second
file beside it (`model.pit`: its fields are listed at the top of `pit.js`),
converted from the FlightGear model `.xml` that assembles it (`--model`), with
the eye point set in the seat and `view.down`, `view.lean` saying how the
pilot's gaze rests and how far the head can lean; screens that FlightGear
draws in code need a drawing of their own in `displays.js`. The menu, the cameras,
the autopilot, the sound and the weather read everything else from the spec.
Flight-model changes can be tried without the browser: `physics.js` and
`variants.js` import nothing but three's math classes, so Node can fly them.

## What runs where

The game is one page. Everything that streams from the network is fetched and
decoded off the main thread:

| Thread | Code | Does |
|---|---|---|
| Main | `src/main.js` and everything it imports | Boot, the frame loop, the flight model, input, sound, UI, and every draw call |
| Terrain workers (1-3, by core count) | `src/world/terrain.worker.js`, pooled by `workers.js` | Decode elevation tiles and find their water; build terrain patches (`patchbuild.js`); place far trees (`treeplace.js`) |
| City worker | `src/world/cities.worker.js` | Fetch zoom-14 map tiles (OpenFreeMap for roads, bridges and water; Overture for buildings), build building, road and bridge meshes (`citybuild.js`, `bridgebuild.js`) |
| Land cover worker | `src/world/landcover.worker.js` | Fetch Overture's base tiles and triangulate their woods and open country |
| Imagery worker | `src/world/imagery.js` (its source is a string in that file, started from a Blob URL) | Fetch satellite and aerial tiles and reduce them to mip chains |
| Map worker | `src/ui/maptiles.worker.js` | Paint OpenFreeMap tiles for the map screen |

Workers answer with typed arrays handed over without a copy. The main thread
uploads what comes back to the GPU a little at a time under a shared byte budget
(`src/render/budget.js`), so a burst of arrivals never stalls a frame.

## The world and its coordinates

The game world is a 524 km square window of the earth on a Web Mercator plane,
scaled to true meters at its center: +X east, +Z south, +Y up, origin at the
window's center (`src/world/geo.js`). The window can be anywhere on earth short
of the poles: its center goes no nearer one than 80 degrees (`LAT_MAX`; the
plane and its tiles end at 85), nothing starts beyond 81 (`PIN_LAT_MAX`), and
an aircraft that flies on poleward is turned back (`strayed` in `main.js`).
Longitudes are taken the short way round from the window's center (`toWorld`),
so a window across the 180th meridian is like any other. In flight, 150 km from the center the window
is moved to lie ahead of the aircraft (`loadWorld` in `main.js`) and everything
laid out in the old window's meters is reset: terrain, cities, land cover,
airfields, weather grids. Streaming modules guard against answers that arrive
after such a move with a generation counter (`gen`) or a `forget` message to
their worker.

Map tiles are addressed in the usual slippy-map grid (zoom, x, y); each streaming
module converts a tile's corner to world meters with `pixelX`/`pixelY`/
`metersPerPixel` from `geo.js`. Those are not wrapped: in a window across the
180th meridian the columns run on past the end of the grid (or below zero), and
every module that fetches or looks up a tile brings the column round first
(`wrapTile`, or the same arithmetic where a worker cannot import it: `dem.js`'s
`KEY`, `imagery.js`'s `col`, `overture.js`'s `tile`, the two map-tile workers).

Three things differ by place and are decided in one spot each: which hemisphere
(`hemisphere()` in `geo.js`: the sun's side, the seasons' half year, the turn of
the weather), whether a place has North America's hand-drawn climate or the
world's (`northAmerica()` in `terrain.js`), and whether the aerial surveys reach
it (`aerialCovers()` in `imagery.js`).

## Shared GPU state

Uniforms that more than one material reads (sun, sky, weather, region maps, the
cover maps) live in one registry, `ENV` (`src/core/env.js`). A module that owns
such a uniform registers it there and exports the list of names and the GLSL
that reads it; materials take `ENV[name]` by reference, so one assignment
reaches every shader. The top-down maps the ground shaders read are built the
same way:

| Map | Owner | Says |
|---|---|---|
| `tBldCover` | `cities.js` | Where buildings stand (trees keep clear) |
| `tWaterCover` | `cities.js` | Where the map has water (rivers, lakes the elevation data misses) |
| `tLandCover` | `landcover.js` | Where the map says woods, and where open country (trees stay off fields) |
| Ground light maps | `groundlight.js` | Terrain shadow, cloud shadow, sky occlusion |
| Tree shade maps | `trees.js` | The shade the trees throw on the ground |

## Data sources

Nothing is fetched with a key, and no request carries cookies or a referrer.

| Data | Source | Read by |
|---|---|---|
| Elevation | AWS Terrain Tiles (Mapzen terrarium PNGs), `s3.amazonaws.com/elevation-tiles-prod` | `dem.js`, terrain workers |
| Ground color | Sentinel-2 cloudless 2016 by EOX, `tiles.maps.eox.at` | `imagery.js` |
| Ground detail | USGS National Map imagery and NAIP, `basemap.nationalmap.gov`, `imagery.nationalmap.gov`: the United States and its territories only | `imagery.js` |
| Roads, bridges, water; map screen | OpenFreeMap vector tiles (OpenMapTiles schema, OpenStreetMap data), `tiles.openfreemap.org` | `cities.worker.js`, `maptiles.worker.js` |
| Buildings | Overture Maps building PMTiles (OpenStreetMap plus Microsoft, Google and Esri footprints), `overturemaps-extras-us-west-2` bucket; OpenFreeMap's `building` layer if Overture cannot be reached | `overture.js`, `cities.worker.js` |
| Land cover | Overture Maps base PMTiles (ESA WorldCover, plus OpenStreetMap woods and farmland) | `overture.js`, `landcover.worker.js` |
| Airfields, detailed | Baked from OpenStreetMap into `public/airfields/*.json` (606 files, fetched as they come into view): North America and some forty flagship airports elsewhere | `airfield-index.js`, `airports.js`, `airfield.js` |
| Airfields, the rest of the world | The runways of about 4,500 large and medium airports, baked from OurAirports (public domain) into `public/data/world-airfields.json`, fetched at start-up | `airports.js` |
| Towns | Baked into `public/data/towns.json` from OpenStreetMap (the United States, Canada, northern Mexico) and GeoNames (everywhere else) | `towns.js` |
| Climate | How wet the lowlands are, half a degree to the cell, baked from the Sentinel-2 picture's colors into `public/data/climate.bin`; North America's is drawn by hand in the code | `terrain.js` |
| Magnetic variation | The World Magnetic Model 2025 (NOAA NCEI and BGS, public domain): its coefficients, in the code | `geo.js` |
| Stars, Milky Way | Baked into `public/data/stars.bin`, `milkyway.jpg` | `stars.js` |
| Wall materials | ambientCG photographs (CC0), baked into `public/facades/` | `cities.js` |
| Sounds | Freesound recordings (CC0), `public/audio/` with a manifest | `core/audio.js` |

The credits for all of these are assembled on the title screen from each
module's `*_ATTRIBUTION` export (`boot` in `main.js`) and must stay with any copy.

## Debugging

`window.DR` (set in `main.js`) exposes the live objects: `DR.S` (game state and
settings), `DR.ac` (the aircraft), `DR.terrain`, `DR.cities`, `DR.landCover`,
`DR.imagery`, `DR.weather`, `DR.camera`, `DR.renderer`, `DR.ENV`, and helpers:
`DR.tick(dt)` runs one frame, `DR.sim(dt)` one step of simulation without
drawing, `DR.fly({...})` and `DR.flyAt(lat, lon)` start a flight,
`DR.toWorld(lat, lon)` / `DR.toLatLon(x, z)` convert coordinates. `DR.launch({ plane: 'saturnv', site: 'ksc39a', rstart: 'pad' | 'orbit' | 'moon' })` starts a rocket flight and `DR.mission` is its controller (`DR.mission.rk` the rocket, `.cosmos` the view from space, `.forceMix` to pin the ground/space blend in a test). The backquote
key opens a debug panel in flight.

## A frame

`tick` in `main.js` runs once per animation frame, in this order:

1. Input.
2. Simulation, while flying: the weather, the autopilot, the flight model in fixed steps of 1/120 s (several per frame,
   more under time acceleration), icing, lightning, touchdown and crash, and moving the window when the aircraft
   strays too far from its middle.
3. The aircraft's model and the camera.
4. The `ENV` uniforms for this frame: time, wind, sea state, snow, rain.
5. Sky and sun, ground light, sun shadows.
6. Each streaming system's `update`: terrain, imagery, airfields, cities, land cover, towns, precipitation. Each one
   plans what it wants around the camera, sends work to its worker, and uploads what has come back within the
   upload budget.
7. Drawing: `clouds.render` draws the scene into an HDR target, ray-marches the clouds over it, and hands the result
   to the post-processing chain (`render/postfx.js`), which ends on the screen.
8. The HUD, the chart (five times a second), sound.
9. Frame timing feeds dynamic resolution (`render/dynres.js`) and automatic quality (`render/autoquality.js`).

## Files

Each file opens with a comment that says what it does and how; this is the index to those comments.

### `src/` and `index.html`

| File | What it is |
|---|---|
| `index.html` | The page: the canvas, HUD, flight panel, weather/debug/chart side panels, title screen and pause menu |
| `main.js` | Boot, game state `S` and saved settings, the window of the world (`loadWorld`, `followAircraft`), starting a flight, the frame loop, camera, autopilot, and the menus' event handlers |

### `src/core/`: shared plumbing

| File | What it is |
|---|---|
| `env.js` | `ENV`, the registry of uniforms shared by every shader |
| `noise.js` | Seeded random numbers and value/simplex noise, plus `clamp`/`lerp`/`smoothstep` |
| `input.js` | Keyboard, mouse and gamepad, smoothed into flight axes and actions |
| `audio.js` | Sound: the Web Audio graph that mixes and pitches the recordings in `public/audio/` |
| `audio-synth.js` | The few synthesized sounds (stall horn, buffet, gusts) and stand-ins for recordings that fail to load |

### `src/aircraft/`: the airplane

| File | What it is |
|---|---|
| `physics.js` | The flight model: forces from lift, drag and thrust; stalls, slips, wind and ground effect follow from them. Propeller or jet thrust, drag near the speed of sound, legs that fold, a tail wheel: all by the numbers of the aircraft flown |
| `variants.js` | The fleet. Three Cessnas (152, 172, 182: proportions that reshape one generated airframe, paint, V-speeds, flight-model numbers) and the aircraft that come as model files (P-51D, F-16, 737-800): flight-model numbers, where the wheels and hull meet the ground, and how the file is fitted (`model`) |
| `model.js` | The Cessna airframe, generated in code: fuselage, wings, tail, gear, glazing, prop; moving surfaces |
| `gltfmodel.js` | Aircraft from model files (`public/models/*.glb`): loading, standing them on their wheels, merging what never moves, moving what does (the `rig` each file carries: landing gear, control surfaces), propeller, lights, nozzle, afterburner flame; what of the outside stays in view from the seat, window panes that turn to glass there, the surface rain and frost are drawn on |
| `pit.js` | The cockpits of those aircraft (`public/models/*_pit.glb`, FlightGear's own): fetched when the aircraft is chosen, merged into a few dozen meshes, with needles, drums of digits, flags, stick, throttle and pedals moved by the file's hinges from the flight model's state (knots, feet, inches of mercury); panel lighting at night |
| `displays.js` | What FlightGear draws in code and the game draws itself: the 737's primary flight, navigation and engine displays, the F-16's multifunction displays, EHSI and data entry display (canvases, redrawn only when what they show has changed, two a frame at most), and the F-16's head-up display (collimated symbols clipped to the combiner glass) |
| `kit.js` | Building blocks for the model: lofts, airfoils, merged primitives, canvas textures |
| `panel.js` | The instrument panel and its working instruments |
| `interior.js` | The cabin: seats, lining, door cards, headliner |
| `cabinkit.js` | The cabin's materials and baked contact shading |
| `cockpitcam.js` | The pilot's head: eye point, free look, zoom, a little movement with the airplane, a lean toward the window that each aircraft sets |

### `src/world/`: the earth

Where the game is and how it maps to meters:

| File | What it is |
|---|---|
| `geo.js` | The 524 km window on a Web Mercator plane; lat/lon to world meters and back, round the earth; tile coordinates; magnetic variation (the World Magnetic Model) |
| `terrain.js` | The world model: ground height, water and climate (moisture, temperature, snow line, season) for the window, read by physics, shaders and the chart; the climate of North America by hand and of the rest of the world from the climate grid |
| `dem.js` | Elevation tiles: fetch, decode, cache, sample |
| `demwindow.js` | A cut of the elevation cache to hand to a worker |
| `water.js` | Which pixels of an elevation tile are water, found from the heights alone |

Terrain and what grows on it:

| File | What it is |
|---|---|
| `chunks.js` | The quadtree terrain: patches, their level of detail and geomorphing, and the terrain shader |
| `patchbuild.js` | One patch's mesh and data texture, as plain arithmetic (runs in a worker) |
| `workers.js` | The pool of terrain workers |
| `terrain.worker.js` | The terrain workers: decode tiles, build patches, place far trees |
| `imagery.js` | Satellite and aerial pictures of the ground, streamed into a texture array and draped over the terrain |
| `landcover.js` | The land cover map (woods vs. open country) around the camera, read by trees and terrain |
| `landcover.worker.js` | Fetches and triangulates the land cover tiles |
| `trees.js` | Trees: species models grown at start-up, impostor atlases, near and far tree patches, their shade on the ground |
| `treeplace.js` | Where trees may stand, as plain arithmetic (runs in a worker) |

Built things:

| File | What it is |
|---|---|
| `cities.js` | Buildings, roads and bridges near the aircraft: streaming, levels of detail, materials, night lights, the building and water cover maps |
| `cities.worker.js` | The city worker: fetches map tiles and builds their meshes |
| `citybuild.js` | One tile's buildings and roads as meshes (plain arithmetic, testable from Node) |
| `bridgebuild.js` | Bridges: decks, piers, trusses and arches from the map's bridge lines |
| `mvt.js` | A minimal Mapbox Vector Tile decoder |
| `overture.js` | A reader for Overture Maps' PMTiles archives by HTTP range |
| `traffic.js` | Cars and trucks on the roads near the aircraft |
| `towns.js` | Towns: the built-up tint in the terrain and the scatter of lights at night |
| `airports.js` | The airfields: the index for the menu (the detailed fields, and the world's other airports added at start-up), and each field's geometry, fetched as it comes into the window or made from its runways alone |
| `airfield-index.js` | Generated by `tools/fetch-airfields.mjs`: every detailed field's place and main runway |
| `airfield.js` | Airfield scenery: pavement, markings, buildings, lights, windsock |

Light and sky:

| File | What it is |
|---|---|
| `atmosphere.js` | Atmospheric scattering shared by the sky, haze, water and clouds |
| `skylut.js` | The atmosphere's lookup tables (after Hillaire 2020) |
| `sky.js` | The sky dome, sun, moon, stars, time of day, and the scene's lights |
| `celestial.js` | Where the sun, moon and stars are for a place, a day and an hour |
| `stars.js` | The star catalogue as points, and the Milky Way texture |
| `groundlight.js` | Mountain shadow, cloud shadow and sky occlusion baked into top-down maps |
| `sunshadow.js` | The shadows of the aircraft and of buildings |

### `src/weather/`

| File | What it is |
|---|---|
| `weather.js` | The weather simulation: highs, lows, fronts, cloud layers, wind, turbulence, precipitation, icing; the weather situations the menu offers, and how they develop (lows deepening and filling, storms building in the afternoon heat, night fog, one situation drifting into the next) |
| `moisture.js` | The moisture the wind carries over the weather map: lifted up slopes, dried in the lee and under highs, picked up over lakes, raised at the sea-breeze front; cloud forms where it saturates and drifts on with the wind |
| `clouds.js` | Volumetric clouds ray-marched at reduced resolution and accumulated over time; also runs the frame's draw order (scene, clouds, post) |
| `cloudnoise.js` | The tiling 3D noise volumes the clouds are shaped from |
| `precip.js` | Rain, snow, hail, cloud vapor, wingtip trails and lightning, as particles |

### `src/render/`: frame plumbing

| File | What it is |
|---|---|
| `postfx.js` | The post-processing chain; its shaders are in `postfx-scene.js` (occlusion, reflections, anti-aliasing, motion blur, depth of field) and `postfx-lens.js` (glass, lens, sensor, tone) |
| `fullscreen.js` | Full-screen quad and render-target helpers for the passes |
| `budget.js` | The per-frame budget for uploads to the GPU |
| `dynres.js` | Dynamic resolution: draw smaller when frames run long |
| `autoquality.js` | Picks the graphics tier from the GPU's name, then from measured frame times |
| `perf.js` | GPU and CPU timing per pass and stage, for the debug panel |

### `src/ui/`

| File | What it is |
|---|---|
| `hud.js` | The flight panel, weather wording, the frame-time meter |
| `chart.js` | The map, of the whole earth: relief of the world, of the region and of the window, airfields, labels, the pin, the weather |
| `maptiles.js`, `maptiles.worker.js` | The map's street-map tiles, painted to bitmaps in a worker |
| `picker.js` | The searchable drop-down that stands in for `<select>` |
| `style.css` | All of the interface's styles |

### `src/space/`: rockets, orbit and the view from space

A rocket flight is run by `mission.js` in place of the airplane (`tick` in `main.js` asks `mission.active`).
The craft is simulated in an Earth-centered inertial frame in double precision; the game's flat window of
the world is only where it is *shown* while it is low. Between 24 and 36 km up the view from space is
cross-faded over the ground view (`clouds.mixIn`, a hook in `weather/clouds.js`); above that only the view
from space is drawn, through the same post-processing chain, and the window of the world stays where it was
until the craft comes back down (`arriveFromSpace` in `main.js` fetches it again under the craft).

| File | What it is |
|---|---|
| `frames.js` | The inertial frame (the equatorial frame of `world/celestial.js`), the mission clock, where the Earth's turn, the sun and the Moon are at a time, and the conversions to latitude/longitude/height and to the flat world's axes |
| `orbit.js` | Gravity of the Earth and the Moon, the coasting integrator (RK4), orbital elements for the readouts, and the predicted path the map draws |
| `rocket.js` | The vehicle as a point with a nose: thrust per stage (no fuel to run out), drag, attitude against the local horizon, ground contact, and the autopilot that flies to a parking orbit |
| `mission.js` | The flight itself: start on a pad (or in orbit), keys, staging, time acceleration, which view shows (`mix`), the cameras, the stand-in that makes the rest of the game follow the rocket, the rocket's HUD panel |
| `cosmos.js` | The view from space: one full-screen pass that ray-traces the Earth (ground from the clip levels, clouds, marched atmosphere), the Moon (NASA's color and relief maps, with generated craters below their resolution), sun and Milky Way; then the things with shape, lit by sun and Earthshine |
| `globetiles.js` | The Earth's picture for that pass: Sentinel-2 cloudless tiles as clip levels in one array texture, zoom 2 to 12, streamed around the point under the camera |
| `orbitmap.js` | The orbit map (`M` in a rocket): the path ahead, the Moon's orbit, labels |
| `satellites.js` | The space stations and satellites on their orbits, as points far off and models near |
| `sites.js` | The world's launch sites (only places with real pads; a pin on the map makes a pad anywhere) |
| `transfer.js` | The way to the Moon (`L`): plans the burn by flying it ahead, then flies it: wait for the Moon, burn, coast, trim, brake into lunar orbit |
| `rocketsound.js` | The rocket's sound: three recordings through filters that follow the air's pressure, the view and the thrust |
| `reentry.js` | The glow of reentry: a shell of shocked air around the craft, by the flight model's heating |
| `vehicles.js`, `model-saturnv.js`, `model-starship.js`, `model-kit.js` | The Saturn V and Starship as procedural models, stage by stage |
| `plume.js` | The flame (widening as the air thins), and `ExhaustTrail`, the door to the smoke below |
| `fx-smoke.js` | The smoke itself: a particle field simulated on the CPU (drag, buoyancy, wind, eddies, riding the ground), sorted and shadowed puff against puff, drawn as one instanced call plus a depth-only one so the weather's clouds and the lens treat it as solid |
| `fx-launch.js` | What a launch puts into that field: the two jets out of Launch Complex 39's flame trench, the ring of steam and dust under Starship's mount, the column on the way up, ice off the tanks, vent wisps, the vapor collar at Mach 1 |
| `pad.js` | The launch pads: a Launch Complex 39 pad with its tower, and an orbital launch mount with its tower |
| `satmodels.js` | Models of the satellites |
| `cabin.js`, `cabin-apollo.js`, `cabin-starship.js`, `cabin-kit.js` | The crew's cabins, for the view from the commander's seat (`C`): the Apollo Command Module's main display console with working attitude balls, computer display, timers and meters, and a flight deck for Starship with three live screens. Built in code, lit by their own baked lighting; the outside of the vehicle is hidden while they show |

`tools/space-viewer.html` shows the models on their own (through the dev server). `tools/bake-moon.py` bakes NASA's Moon maps into `public/data/moon_*.jpg` and `tools/bake-rocket-sounds.py` cuts the rocket recordings in `public/audio/`.

Shadows: the vehicle is handed to `world/sunshadow.js` as "the aircraft" (its shadow on the ground) and the pad as a caster of structures; three.js's own shadow map, widened to the stack, gives the vehicle's shadow on itself, and a second one does the same in the view from space.

### `tools/`: offline bakes (not part of the build)

| File | What it is |
|---|---|
| `ac2glb.py` | Turns FlightGear aircraft (AC3D `.ac` files and the hinges in their model `.xml`) into the `.glb` files in `public/models/` (`CREDITS.md` there has the command for each). For a cockpit it follows a model `.xml` through every sub-model it places, keeps the hinges of instruments and controls, and packs the textures onto shared sheets |
| `airfield-list.mjs` | The game's detailed airfields, by hand |
| `fetch-airfields.mjs` | Bakes each of those fields' geometry from OpenStreetMap into `public/airfields/` and writes `src/world/airfield-index.js` |
| `bake-world-airfields.mjs` | Bakes the runways of the world's other large and medium airports from OurAirports into `public/data/world-airfields.json` |
| `fetch-towns.mjs` | Bakes `public/data/towns.json` from OpenStreetMap and GeoNames |
| `bake-climate.py` | Bakes the world's lowland moisture, `public/data/climate.bin`, from the satellite picture |
| `bake-magvar.mjs` | Prints the World Magnetic Model's coefficients as `geo.js` carries them, and checks its evaluator against the model's test values |
| `bake-facades.py` | Bakes the wall materials in `public/facades/` from ambientCG sets |
| `bake-stars.py`, `bake-milkyway.py` | Bake the star catalogue and the Milky Way image in `public/data/` |

### Elsewhere

| Path | What it is |
|---|---|
| `public/` | Served as is: airfields, towns, stars, wall materials, sounds (each with its credits) |
| `Dockerfile`, `compose.yaml`, `deploy/nginx.conf` | Build the static site and serve it with nginx |
| `TODO-visuals.md` | The visual backlog (mostly done; see its notes) |
