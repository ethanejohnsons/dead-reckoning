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
| Offline tools | Node scripts (`tools/*.mjs`: airfield and town bakes from OpenStreetMap and GeoNames) and Python 3 with NumPy and Pillow (`tools/*.py`: wall materials, stars, Milky Way) |
| Hosting | A static site. `Dockerfile` builds it with Node 22 and serves it with nginx (`deploy/nginx.conf`); `compose.yaml` wraps that |
| Tests, lint | None |

Two pieces of three.js are imported by path rather than from the package root:
`three/src/extras/lib/earcut.js` (polygon triangulation, in the city and land
cover workers) and `three/addons/utils/BufferGeometryUtils.js` (merging the
aircraft's parts, `src/aircraft/kit.js`).

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
window's center (`src/world/geo.js`). In flight, 150 km from the center the window
is moved to lie ahead of the aircraft (`loadWorld` in `main.js`) and everything
laid out in the old window's meters is reset: terrain, cities, land cover,
airfields, weather grids. Streaming modules guard against answers that arrive
after such a move with a generation counter (`gen`) or a `forget` message to
their worker.

Map tiles are addressed in the usual slippy-map grid (zoom, x, y); each streaming
module converts a tile's corner to world meters with `pixelX`/`pixelY`/
`metersPerPixel` from `geo.js`.

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
| Ground detail | USGS National Map imagery and NAIP, `basemap.nationalmap.gov`, `imagery.nationalmap.gov` | `imagery.js` |
| Roads, bridges, water; map screen | OpenFreeMap vector tiles (OpenMapTiles schema, OpenStreetMap data), `tiles.openfreemap.org` | `cities.worker.js`, `maptiles.worker.js` |
| Buildings | Overture Maps building PMTiles (OpenStreetMap plus Microsoft, Google and Esri footprints), `overturemaps-extras-us-west-2` bucket; OpenFreeMap's `building` layer if Overture cannot be reached | `overture.js`, `cities.worker.js` |
| Land cover | Overture Maps base PMTiles (ESA WorldCover, plus OpenStreetMap woods and farmland) | `overture.js`, `landcover.worker.js` |
| Airfields | Baked from OpenStreetMap into `public/airfields/*.json` (565 files, fetched as they come into view) | `airfield-index.js`, `airfield.js` |
| Towns | Baked from OpenStreetMap and GeoNames into `public/data/towns.json` | `towns.js` |
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
`DR.toWorld(lat, lon)` / `DR.toLatLon(x, z)` convert coordinates. The backquote
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
| `physics.js` | The flight model: forces from lift, drag and thrust; stalls, slips, wind and ground effect follow from them |
| `variants.js` | The three aircraft (152, 172, 182): proportions, paint, V-speeds and flight-model numbers |
| `model.js` | The airframe, generated in code: fuselage, wings, tail, gear, glazing, prop; moving surfaces |
| `kit.js` | Building blocks for the model: lofts, airfoils, merged primitives, canvas textures |
| `panel.js` | The instrument panel and its working instruments |
| `interior.js` | The cabin: seats, lining, door cards, headliner |
| `cabinkit.js` | The cabin's materials and baked contact shading |
| `cockpitcam.js` | The pilot's head: eye point, free look, zoom, a little movement with the airplane |

### `src/world/`: the earth

Where the game is and how it maps to meters:

| File | What it is |
|---|---|
| `geo.js` | The 524 km window on a Web Mercator plane; lat/lon to world meters and back; tile coordinates |
| `terrain.js` | The world model: ground height, water and climate (moisture, temperature, snow line, season) for the window, read by physics, shaders and the chart |
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
| `airports.js` | The airfields: the index for the menu, and each field's geometry, fetched as it comes into the window |
| `airfield-index.js` | Generated by `tools/fetch-airfields.mjs`: every field's place and main runway |
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
| `weather.js` | The weather simulation: highs, lows, fronts, cloud layers, wind, turbulence, precipitation, icing; the weather situations the menu offers |
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
| `chart.js` | The map: relief of the continent and of the window, airfields, labels, the weather |
| `maptiles.js`, `maptiles.worker.js` | The map's street-map tiles, painted to bitmaps in a worker |
| `picker.js` | The searchable drop-down that stands in for `<select>` |
| `style.css` | All of the interface's styles |

### `tools/`: offline bakes (not part of the build)

| File | What it is |
|---|---|
| `airfield-list.mjs` | The game's airfields, by hand |
| `fetch-airfields.mjs` | Bakes each field's geometry from OpenStreetMap into `public/airfields/` and writes `src/world/airfield-index.js` |
| `fetch-towns.mjs` | Bakes `public/data/towns.json` from OpenStreetMap and GeoNames |
| `bake-facades.py` | Bakes the wall materials in `public/facades/` from ambientCG sets |
| `bake-stars.py`, `bake-milkyway.py` | Bake the star catalogue and the Milky Way image in `public/data/` |

### Elsewhere

| Path | What it is |
|---|---|
| `public/` | Served as is: airfields, towns, stars, wall materials, sounds (each with its credits) |
| `Dockerfile`, `compose.yaml`, `deploy/nginx.conf` | Build the static site and serve it with nginx |
| `TODO-visuals.md` | The visual backlog (mostly done; see its notes) |
