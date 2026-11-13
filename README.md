# Dead Reckoning

A browser flight simulator set over the real terrain of North America. Fly a
four-seat high-wing single from any of more than five hundred real airfields in
every state of the United States, every province and territory of Canada,
Mexico, Central America and the Caribbean,
or start in the air over any point you pin on the map, from outside or from the
cockpit, through volumetric cloud, rain, thunderstorms, hail, snow, fog and
fronts. There is no edge to the world: keep flying and the country keeps coming.

## Run

```bash
npm install
npm run dev
```

`npm run build` writes a static site to `dist/`. The game needs an internet
connection while it runs: terrain is streamed, not bundled.

## Hosting

There is no server side: `dist/` (about 8 MB) can be served by any web server,
from the top of a domain. For a sub-path, build with
`npx vite build --base=/your/path/`.

Or build the Docker image, which builds the site and serves it with nginx on
port 80 (`Dockerfile`, `deploy/nginx.conf`):

```bash
docker build -t dead-reckoning .
docker run -d --name dead-reckoning --restart unless-stopped -p 8080:80 dead-reckoning
```

Or let Compose do both (`compose.yaml`):

```bash
docker compose up -d --build
```

For a sub-path, add `--build-arg BASE=/your/path/` to the build and proxy that
path to the container; with Compose, set `BASE` (and `PORT`, 8080 unless you
say otherwise) in the environment or in a `.env` file. `/healthz` answers
`ok`. Put TLS in front with whatever reverse proxy the server already runs.

The server only hands out the game. Each player's browser fetches terrain,
imagery and building tiles straight from the services named in the credits.

## The world

The game holds one square window of the earth at a time, 524 km on a side
(`REGION` in `src/world/geo.js`). Pick an airfield, or pin a point on the map,
more than 120 km from the center of the window and the window moves to it:
`loadWorld` in `src/main.js` fetches the coarse elevation for the new square
and rebuilds what depends on place (water, regional maps, towns, airfields and
their grading, terrain, the weather's terrain grids, the map) in a few seconds.

In flight the window follows the aircraft (`followAircraft` in `src/main.js`):
150 km from its center the window is moved to lie around a point 60 km ahead,
the aircraft is put where it was over the ground in the new coordinates, and
the weather is carried along with it (`Weather.shift`). The flight stands still
for the second or two that takes. So there is no edge to reach, in the United
States, Canada or beyond them; only the airfields, the towns' lights and the
climate rules stop at the two countries. (The plane the world lies on is Web
Mercator, so the far Arctic is stretched, and a flight across the 180th
meridian is not provided for.)

What grows where no satellite picture has loaded, where the tree line is and
how readily the picture's dark green is taken for woodland come from a rough
climate of the continent in `src/world/terrain.js` (`lowlandMoisture`,
`treelineAt`): prairie and plowed country keep trees to their shelter belts,
river bottoms and towns, however green the crops are in the picture. Magnetic
variation is interpolated from a table of values around the continent
(`magVarAt` in `src/world/geo.js`), good to a degree or two.

## Terrain data

Elevation comes from the public [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
dataset on AWS (Mapzen "terrarium" tiles; in the United States the sources are
the USGS 3DEP survey, SRTM, GMTED and ETOPO1). No key is needed. It is used down
to zoom 14, about 7 m a pixel, which is as fine as the 10 m survey goes.

Water is found in the data, with no list of lakes (`src/world/water.js`): the
survey levels every lake, so a patch of pixels at one level, big enough for its
zoom, is water. That finds the Great Lakes, Minnesota's lakes down to a few
acres, the reservoirs of the Missouri and the dammed pools of the big rivers,
and nothing on the flattest farmland. Where the fine data is stored in whole
meters instead (Hawaii, and much of the world outside the United States), every
gentle slope is a staircase of level terraces; such tiles are recognized, and in
them only the sea is water. Free-flowing rivers are not leveled in
the survey and show only in the satellite picture. Open water answers the
weather: in a gale or under a storm the big lakes run long seas with white
horses breaking on them, and small lakes take a share of it.

The ground is colored by real satellite imagery:
[Sentinel-2 cloudless 2016](https://s2maps.eu) by EOX IT Services GmbH
(contains modified Copernicus Sentinel data 2016 & 2017), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is streamed as
seven nested windows of tiles around the aircraft, about 10 m a pixel at the
finest, with shadows lifted and close-up detail added in the shader. Close to
the aircraft it is sharpened by aerial photography from the USGS National Map
(USDA NAIP orthoimagery, public domain), about a meter a pixel. Trees
stand where the picture shows woods. Until a tile arrives, and with imagery
switched off in the menu, the surface falls back to cropland, prairie,
sagebrush, forest, rock and snow derived from height, slope, latitude and a
map of how wet the country is (`buildWorld` in `src/world/terrain.js`).
The attribution is shown on the title screen and must stay with any copy.

## Airfields and towns

The airfields are the real places: every runway where it really is, with its
heading, length, width, surface and designators, the taxiways, aprons, hold
lines and parking spots, and the footprints of the terminals, hangars and towers.
The layout comes from [OpenStreetMap](https://www.openstreetmap.org). The list
of fields is `tools/airfield-list.mjs`; the bake writes one file per field to
`public/airfields/` (fetched when the field comes into the window) and the
index of them all to `src/world/airfield-index.js`:

```bash
node tools/fetch-airfields.mjs            # the fields of the list not baked yet: a batch per Overpass request, with pauses
node tools/fetch-airfields.mjs --all      # every field again (--offline: from the cached answers)
node tools/fetch-airfields.mjs --source api   # the same from the main OpenStreetMap API, a field at a time, when no Overpass server answers
node tools/fetch-towns.mjs                # towns and cities (seventeen requests) -> public/data/towns.json
```

The scripts keep the raw answers in a cache directory outside the repository
(`--cache DIR`, default the system temp directory) and print what each field
had and what was filled in (missing widths, surfaces, designators and building
heights get defaults by runway length and building size; the big hubs are
simplified harder and keep only their larger buildings).

`src/world/airfield-index.js`, `public/airfields/*.json` and
`public/data/towns.json` are a derived database of OpenStreetMap data,
© OpenStreetMap contributors, made available under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/);
see <https://www.openstreetmap.org/copyright>. The credit "Airfields and towns:
© OpenStreetMap contributors (openstreetmap.org/copyright)" is shown on the
title screen with the others and must stay with any copy; anyone who passes on
a changed copy of those files must offer it under the ODbL too.

The ground under each field is graded to one gently tilted plane fitted
through the elevation data there, blending back into the natural terrain over
a few hundred meters. Pavement, paint and lights are drawn in code
(`src/world/airfield.js`): markings are worked out per pixel, so they stay
sharp at any distance. A field's scenery exists within 60 km of the camera.

Towns (name, position, population) give the built-up tint of the fallback
surface, the street trees and the lights at night.

## Cities

The buildings are the real ones: footprints and, where the map has them,
heights from [OpenStreetMap](https://www.openstreetmap.org), streamed around the
aircraft as vector tiles (zoom 14, the `building` and `transportation` layers of
the [OpenMapTiles](https://www.openmaptiles.org) schema) from the public
[OpenFreeMap](https://openfreemap.org) server. No key is needed and nothing is
bundled; a request carries no cookie and no referrer. A worker fetches, decodes
and builds each tile (`src/world/cities.worker.js`, `citybuild.js`, `mvt.js`);
`src/world/cities.js` decides what is wanted and draws it:

- within 2 km every building, houses with pitched roofs, the roads as
  ribbons on the ground, and the traffic on them (`src/world/traffic.js`):
  cars, vans and trucks keeping to their lanes, one every sixty meters of a
  motorway's roadway at the busiest hour and one a kilometer on a
  residential street, fewer at night, when they show their lights;
- to 8 km buildings of 350 m² or 12 m and over, simplified;
- to 42 km buildings of 35 m and over, as plain prisms, looked for around the
  center of every town of 60,000 people or more and wherever towers turn up
  next to towers: the skyline.

A building without a mapped height gets one from its footprint and from how tall
its neighbors are. Its walls are photographed materials from
[ambientCG](https://ambientcg.com) (CC0), in `public/facades` (baked by
`tools/bake-facades.py`): towers and office blocks take a whole facade with its
windows (glass curtain wall, banded glass, brick, concrete frame), in the
building's own color; houses, shops and sheds take a surface (boards, brick,
stone, concrete, steel sheeting) and the shader draws their windows on it. The
map says nothing about what a building is made of, so the choice follows its
size and shape. Whatever the material, a building of several stories has a
ground floor of storefronts and lobbies between piers, a coping along its roof
line and, on a tower, a blind band of louvres for the plant floor at the top;
drawn windows are set back in the wall, with the shadow of their head and jamb
on the glass, and each pane of a glass wall reflects a slightly different sky. A roof takes its tone from the satellite picture under it. Windows are lit after dark, and
buildings over 60 m carry red obstruction lights. Buildings inside an airport's
boundary are left to the airfield. Flying into one ends the flight. If the tile
server cannot be reached the game carries on without buildings and tries again
every half minute. `Cities.setSource(url)` points it at another server of the
same schema.

Bridges come from the same tiles (`src/world/bridgebuild.js`): every road,
railroad and sidewalk the map marks as a bridge is a deck on piers, strung
between its abutments and held clear of the water, roads and lower decks
beneath it. High road bridges get arches, railroads over water a truss, and a
short table of named crossings (the Duluth lift bridge, the Blatnik, St. Paul's
High Bridge and a few more) supplies what the map cannot. You can fly under a
deck; hitting one, or a pier, ends the flight.

The tiles are © [OpenMapTiles](https://www.openmaptiles.org), with data
© OpenStreetMap contributors under the ODbL. The credit "Buildings:
OpenFreeMap © OpenMapTiles, data from OpenStreetMap
(openstreetmap.org/copyright)" is shown on the title screen and must stay with
any copy.

## Layout

- `src/world/` the window of the world and its projection, elevation tile cache, water detection, satellite imagery
  windows, terrain mesh and shaders, trees (sixteen species models grown at
  start-up, drawn as meshes close in and as baked impostors beyond), airfields
  (layout data, grading, pavement, buildings and lights), cities (streamed
  buildings, roads and bridges, and the traffic on the roads), the climate of
  the continent, sky and atmospheric scattering
- `tools/` the scripts that bake the airfields and towns from OpenStreetMap
- `src/weather/` weather simulation, volumetric clouds (ray-marched at half
  resolution, accumulated over time and composited against full-resolution
  depth), rain/snow/hail/lightning
- `src/render/` post-processing: `postfx-scene.js` works in scene space (water
  reflections, ambient occlusion, temporal anti-aliasing, motion blur, depth
  of field), `postfx-lens.js` is the lens and sensor (distortion, dirt,
  streaks, halation, grain, sharpening), `postfx.js` ties them together with
  bloom, sun rays, rain and frost on the glass, tone curve and grading
- `src/aircraft/` flight model, aircraft and cockpit mesh with working
  instruments, first-person head camera
- `src/core/` input, sound (recordings in `public/audio/`, mixed and pitched
  in `audio.js`), shared uniforms
- `src/ui/` the map (continent, window, pin), the drop-down lists, styles
- `src/main.js` boot, game loop, flight logic

Apart from the elevation, imagery and building tiles, the baked airfields and
towns and the sound recordings, everything (detail textures, clouds, trees,
aircraft) is generated in code.

## Sound

Nearly everything you hear is a recording. The engine is a Cessna 152 recorded
in its own cabin at five engine speeds (idle, fast idle, descent, cruise and
full-throttle climb); the game cross-fades between them and plays each at
exactly the rpm the flight model gives. From outside you hear a Cessna 172 and
an idling four-cylinder single recorded on an airfield. Rain and hail were
recorded inside cars, the thunder is five different storms, and the wheels are
the same Cessna landing on grass. The stall horn, the buffet of a stalled wing
and the swell of gusts are synthesized, and so is a stand-in for any file that
fails to load.

All the recordings are public domain (CC0) from Freesound;
`public/audio/CREDITS.md` lists each file with its author and source. They were
made from Freesound's public previews, not the lossless originals. The files
add about 3.5 MB and load after you press Fly. Mix levels are in the `MIX`
table at the top of `src/core/audio.js`.

## Playing

Pick an airfield (the list is grouped by state and province, then Mexico,
Central America and the Caribbean; type a name, a
city, a state or a code to search it), a weather system, a time of day and
whether to start on the runway or already in the air over the field, then
press Fly. Or press Map, click anywhere on the continent to drop a pin, and
press Fly from pin to start in the air over that spot; the same works from the
map in flight (`M`), where the pin also shows as a bearing and distance. `W`/`S` pitch, `A`/`D` roll, `Q`/`E` rudder, `R`/`F` faster and
slower; flaps, brakes and fuel take care of themselves. `C` switches between the
chase view and the cockpit (drag to look around, wheel to zoom). `G` hands the
aircraft to the autopilot, and `T` speeds time up: ×2, ×4, ×8, ×16, ×32, ×64,
then back to normal. `Esc` opens the menu.

Graphics is "Automatic" unless you choose a tier in the menu. The first guess
comes from the name of the graphics card (`src/render/autoquality.js`); in
flight the picture's resolution follows the frame rate first
(`src/render/dynres.js`), and when it has given all it can and frames still
come late the tier itself steps down (High, Medium, Low), which trims the
clouds, the post-processing, the shadows and how far the buildings reach. With
frame rate to spare for a while it steps up again, though not back to a tier
that has already proved too much in that session. The tier it settles on is
remembered for the next start.

`V` (or the weather chip at the top left) opens the Weather panel: choose a
weather system, how long the change takes and the time of day, and read what
the weather is doing where you are. In the chase view a flight panel along the
bottom shows speed, heading, attitude, altitude, climb, power, elapsed time
and wind.

Developer tools: the backquote key (`` ` ``) toggles a debug panel in flight
(weather overrides, lightning strike, a strength slider for every camera
effect, buffer view, frame times and per-pass GPU times). It is deliberately
not shown anywhere in the game's own interface.
