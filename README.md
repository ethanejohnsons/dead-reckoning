# Dead Reckoning

A browser flight simulator set over the real terrain of the whole earth. Fly a
four-seat high-wing single from any of five thousand real airfields: six
hundred of them in full detail (every state of the United States, every
province and territory of Canada, Mexico, Central America, the Caribbean, and
some forty of the world's great and famous airports, from Heathrow to Lukla),
and the runways of every other large and medium airport on earth;
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

There is no server side: `dist/` (about 18 MB, 11 of it the airfields, each
fetched only when it comes into view) can be served by any web server,
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
for the second or two that takes. So there is no edge to reach anywhere on
earth, the 180th meridian included (longitudes are taken the short way round
from the window's center, and the map tiles' columns wrap: `wrapTile` in
`src/world/geo.js`). Only toward the poles is there an end: the plane the world
lies on is Web Mercator, which stretches without limit and whose tiles stop at
85 degrees, so the window's center goes no nearer a pole than 80 degrees, a
flight cannot be started beyond 81, and an aircraft that flies on is turned back
at about 81.5 with a word of why.

What is the same everywhere: the terrain, the satellite picture, buildings,
roads and bridges, the land cover, the map, the weather, the sky for the
latitude and the season for the hemisphere. What is better in the United
States: the aerial photography that sharpens the ground close to the aircraft
exists only there, and the elevation survey is three times finer. What is
better in North America: the detailed airfields, towns down to 1,500 people
(5,000 elsewhere), and a climate drawn by hand.

What grows where no satellite picture has loaded, where the tree line is, how
warm an ordinary day is (59°F in Minnesota, the low 80s in the tropics, a few
degrees above freezing on the Arctic coast) and how readily the picture's dark
green is taken for woodland come from a rough climate in
`src/world/terrain.js` (`lowlandMoisture`, `treelineAt`, `seaTempAt`, `seasonShift`): prairie and plowed country keep trees to their shelter belts,
river bottoms and towns, however green the crops are in the picture. North
America's climate is drawn by hand there. The rest of the world's is broader:
how wet its lowlands are is read off a half-degree grid
(`public/data/climate.bin`, baked by `tools/bake-climate.py` from the color of
the ground in the satellite picture itself, fitted to the hand-drawn map), the
tree line follows latitude, hemisphere and the sea (4,000 m in Nepal, 2,000 m in
the Alps, 400 m above the Beagle Channel), and the seasons swing less where
the weather comes off the sea (London, Sydney) than inside a continent. South
of the equator the seasons are half a year on: "summer" is January.

Magnetic variation is the World Magnetic Model's (WMM2025 by NOAA NCEI and the
British Geological Survey, public domain), evaluated to degree 12 for mid-2026
(`magVarAt` in `src/world/geo.js`; `tools/bake-magvar.mjs` prints its table of
coefficients and checks the evaluator against the model's test values).

## Terrain data

Elevation comes from the public [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
dataset on AWS (Mapzen "terrarium" tiles; in the United States the sources are
the USGS 3DEP survey, SRTM, GMTED and ETOPO1). No key is needed. It is used down
to zoom 14, about 7 m a pixel, which is as fine as the 10 m survey goes. The
rest of the world is SRTM's 30 m survey between 60° north and 56° south (with
finer national surveys in places) and GMTED's 250 m beyond, so the far north is
soft. Close to the 180th meridian the data's zoom levels disagree in places
(Taveuni in Fiji is land at one zoom and sea at the next), which shows as
steps in the ground there.

Water is found in the data, with no list of lakes (`src/world/water.js`): the
survey levels every lake, so a patch of pixels at one level, big enough for its
zoom, is water. That finds the Great Lakes, Minnesota's lakes down to a few
acres, the reservoirs of the Missouri and the dammed pools of the big rivers,
and nothing on the flattest farmland. Where the fine data is stored in whole
meters instead (Hawaii, and much of the world outside the United States), every
gentle slope is a staircase of level terraces; such tiles are recognized, and in
them only the sea is water. Free-flowing rivers are not leveled in
the survey; they, and the lakes of country whose data is in whole meters, come
from the map instead: within about 8 km of the aircraft the `water` and
`waterway` layers of the building tiles (lakes, the sea, rivers) are drawn from
above into a mask (`waterCover` in `src/world/cities.js`), and the terrain
shades whatever it covers as water, reflections and all; the flight model
takes it for water too (`Cities.waterAt`). Open water answers the
weather: in a gale or under a storm the big lakes run long seas with white
horses breaking on them, and small lakes take a share of it.

The ground is colored by real satellite imagery:
[Sentinel-2 cloudless 2016](https://s2maps.eu) by EOX IT Services GmbH
(contains modified Copernicus Sentinel data 2016 & 2017), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is streamed as
seven nested windows of tiles around the aircraft, about 10 m a pixel at the
finest, with shadows lifted and close-up detail added in the shader. Close to
the aircraft it is sharpened by aerial photography from the USGS National Map
(USDA NAIP orthoimagery, public domain), about a meter a pixel, in the United
States and its territories; nothing is asked of those servers anywhere else
(`aerialCovers` in `src/world/imagery.js`), and the ground there is the
satellite's picture with the shader's own close-up detail. Trees
stand where the picture shows woods, except where the land cover says the
ground is open: from space a summer's corn is as dark a green as a forest, so a
map of woods and open country (`src/world/landcover.js`) is drawn around the
aircraft from [Overture Maps](https://overturemaps.org)' base tiles, whose land
cover is [ESA WorldCover](https://esa-worldcover.org) (a 10 m classification of
Sentinel-2 imagery, CC BY 4.0), with OpenStreetMap's woods and farmland on top
where they are mapped. On cropland, grassland and marsh only belts of trees
darker than their field (shelter belts, farmstead groves) and the odd lone tree
stand. Until a tile arrives, and with imagery
switched off in the menu, the surface falls back to cropland, prairie,
sagebrush, forest, rock and snow derived from height, slope, latitude and a
map of how wet the country is (`buildWorld` in `src/world/terrain.js`).
The attribution is shown on the title screen and must stay with any copy.

## Airfields and towns

The airfields are the real places. There are two kinds.

The detailed ones (606: North America, and about forty flagship airports of
the rest of the world): every runway where it really is, with its
heading, length, width, surface and designators, the taxiways, aprons, hold
lines and parking spots, and the footprints of the terminals, hangars and towers.
The layout comes from [OpenStreetMap](https://www.openstreetmap.org). The list
of fields is `tools/airfield-list.mjs`; the bake writes one file per field to
`public/airfields/` (fetched when the field comes into the window) and the
index of them all to `src/world/airfield-index.js`.

The plain ones (about 4,500): every other large and medium airport on earth,
from [OurAirports](https://ourairports.com) (public domain), baked by
`tools/bake-world-airfields.mjs` into one file, `public/data/world-airfields.json`:
each field's names and the two ends, width and surface of each of its runways.
The game lays out a field from those on the spot (`worldData` in
`src/world/airports.js`): runways where they really are, with their markings,
lights and a windsock, the ground graded under them. Their buildings are
whatever the map has there (the streamed buildings of `src/world/cities.js`),
and their taxiways and aprons are only the satellite picture's: no pavement is
invented where the picture would contradict it. About one runway in nine has
no surveyed ends in the data and is laid through the airport's listed position
on its heading. A field baked in detail wins over its plain entry.

```bash
node tools/bake-world-airfields.mjs DIR   # DIR: OurAirports' airports.csv, runways.csv, countries.csv, regions.csv
```

The detailed fields and the towns:

```bash
node tools/fetch-airfields.mjs            # the fields of the list not baked yet: a batch per Overpass request, with pauses
node tools/fetch-airfields.mjs --all      # every field again (--offline: from the cached answers)
node tools/fetch-airfields.mjs --source api   # the same from the main OpenStreetMap API, a field at a time, when no Overpass server answers
node tools/fetch-towns.mjs                # towns and cities (a request for each box of the map) -> public/data/towns.json
node tools/fetch-towns.mjs --geonames cities1000.txt   # fill the boxes that have no towns yet from GeoNames, with no network
node tools/fetch-towns.mjs --world cities5000.txt      # the rest of the world's towns from GeoNames, with no network
```

The scripts keep the raw answers in a cache directory outside the repository
(`--cache DIR`, default the system temp directory) and print what each field
had and what was filled in (missing widths, surfaces, designators and building
heights get defaults by runway length and building size; the big hubs are
simplified harder and keep only their larger buildings).

The towns of Hawaii, of Mexico below the Tropic, of Central America and of the
Caribbean in `public/data/towns.json` are from [GeoNames](https://www.geonames.org)
(`cities1000`, CC BY 4.0), taken while no Overpass server answered, and so are
the towns of the rest of the world (`cities5000`: places of 5,000 people and
more); its credit is on the title screen too. A town's size on the ground is
worked out from its population and how closely its part of the world builds.

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

The buildings are the real ones. Footprints and heights come from
[Overture Maps](https://overturemaps.org)' building tiles: OpenStreetMap's
buildings where it has them, and elsewhere footprints traced from aerial
imagery by Microsoft, Google and Esri, most with an estimated height. That
matters in the country: around many rural lakes and small towns OpenStreetMap
has the roads and not one house. They are read straight from Overture's public
PMTiles archives by HTTP range (`src/world/overture.js`, the newest monthly
release, found by listing the bucket). Roads, bridges and water come from
[OpenStreetMap](https://www.openstreetmap.org) as vector tiles (zoom 14, the
`transportation` and water layers of the
[OpenMapTiles](https://www.openmaptiles.org) schema) from the public
[OpenFreeMap](https://openfreemap.org) server, whose `building` layer stands in
if Overture cannot be reached (Overture describes these tiles as meant for
looking at its data rather than for production use). No key is needed and
nothing is bundled; a request carries no cookie and no referrer. A worker
fetches, decodes and builds each tile (`src/world/cities.worker.js`,
`citybuild.js`, `mvt.js`); `src/world/cities.js` decides what is wanted and
draws it:

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
Robert Street bridge and a few more) supplies what the map cannot. The great
suspension bridges are in that table too, with their real spans, tower heights,
deck clearances and colors: the Golden Gate, the western Bay Bridge, Mackinac,
Brooklyn, the George Washington, the Verrazzano-Narrows and both Tacoma Narrows
spans. Each gets its towers, main cables, hangers and stiffening truss, and a
lighter version of all of them from far away. You can fly under a deck;
hitting one, a pier, a tower or a cable ends the flight.

The tiles are © [OpenMapTiles](https://www.openmaptiles.org), with data
© OpenStreetMap contributors under the ODbL. Overture's buildings are under the
ODbL (OpenStreetMap, Microsoft, Google, Esri) and its land cover under CC BY 4.0
(ESA WorldCover). The credits "Buildings, roads and bridges: OpenFreeMap ©
OpenMapTiles, data from OpenStreetMap (openstreetmap.org/copyright)" and
"Buildings and land cover: Overture Maps Foundation (overturemaps.org), with
data from OpenStreetMap, Microsoft, Google, Esri and ESA WorldCover (CC BY 4.0)"
are shown on the title screen and must stay with any copy.

## Layout

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers what the game is built with, which threads do what, where the
data comes from, and has a line on every file. In short:

- `src/world/` the window of the world and its projection, elevation tile cache, water detection, satellite imagery
  windows, terrain mesh and shaders, trees (sixteen species models grown at
  start-up, drawn as meshes close in and as baked impostors beyond), airfields
  (layout data, grading, pavement, buildings and lights), cities (streamed
  buildings, roads and bridges, and the traffic on the roads), the climate of
  the earth, sky and atmospheric scattering
- `tools/` the scripts that bake the airfields and towns from OpenStreetMap,
  OurAirports and GeoNames (Node), and the climate grid, wall materials, stars
  and Milky Way (Python)
- `src/weather/` weather simulation, volumetric clouds (ray-marched at half
  resolution, accumulated over time and composited against full-resolution
  depth), rain/snow/hail/lightning
- `src/render/` post-processing: `postfx-scene.js` works in scene space (water
  reflections, ambient occlusion, temporal anti-aliasing, motion blur, depth
  of field), `postfx-lens.js` is the lens and sensor (distortion, dirt,
  streaks, halation, grain, sharpening), `postfx.js` ties them together with
  bloom, sun rays, rain and frost on the glass, tone curve and grading; and
  the frame's plumbing: upload budget, dynamic resolution, automatic quality,
  timing
- `src/aircraft/` flight model; the fleet (`variants.js`); the Cessna airframe
  and cockpit with working instruments, generated in code; the loader for the
  aircraft that come as model files (`public/models/`); first-person head camera
- `src/core/` input, sound (recordings in `public/audio/`, mixed and pitched
  in `audio.js`), shared uniforms
- `src/ui/` the flight panel, the map (the world, the window, pin, street-map
  tiles), the drop-down lists, styles
- `src/main.js` boot, game loop, flight logic

Apart from the elevation, imagery, building and land cover tiles, the baked airfields and
towns, the sound recordings and three aircraft models, everything (detail textures, clouds, trees,
the Cessnas) is generated in code.

## Aircraft

Six aircraft, chosen on the title screen or under Menu:

- **Cessna 172, 152 and 182**: piston singles, generated in code, with a
  modeled cabin and working instruments.
- **P-51D Mustang**: 1,500 horsepower and a tail wheel.
- **F-16**: with the power lever all the way forward the afterburner lights,
  and it goes supersonic.
- **Boeing 737-800**: wants a runway of 1,500 m (the F-16 900 m, the P-51 550
  m); from a shorter one the flight starts in the air over the field.

The last three are FlightGear's models, converted by `tools/ac2glb.py`, and
are under the GNU General Public License, version 2 (see
`public/models/CREDITS.md`). Their landing gear and flaps look after
themselves, the airbrakes of the jets open when the power lever is at idle,
and the jets leave contrails in air colder than about -38 °C (above roughly
28,000 feet on an ordinary day). The flight panel shows the Mach number for a
jet where it shows rpm for the others. They have no modeled cockpit: `C`
gives a clear view from the pilot's seat.

## Sound

Nearly everything you hear is a recording. The engine is a Cessna 152 recorded
in its own cabin at five engine speeds (idle, fast idle, descent, cruise and
full-throttle climb); the game cross-fades between them and plays each at
exactly the rpm the flight model gives. From outside you hear a Cessna 172 and
an idling four-cylinder single recorded on an airfield. Rain and hail were
recorded inside cars, the thunder is five different storms, and the wheels are
the same Cessna landing on grass. The stall horn, the buffet of a stalled wing
and the swell of gusts are synthesized, and so is a stand-in for any file that
fails to load. The jets have their own engine recordings: an F-80 at full
power for the roar, an idling F-22 for the whine, the cabin of a 737 in
cruise, and an F-4 taking off for the afterburner. (The P-51 borrows the
Cessna's engine for now.)

All the recordings are public domain (CC0) from Freesound;
`public/audio/CREDITS.md` lists each file with its author and source. They were
made from Freesound's public previews, not the lossless originals. The files
add about 4 MB and load after you press Fly. Mix levels are in the `MIX`
table at the top of `src/core/audio.js`.

## Playing

Pick an airfield (the list is grouped by state and province, then Mexico,
Central America and the Caribbean, then every other country; type a name, a
city, a state, a country or a code to search it), a weather system, a time of day and
whether to start on the runway or already in the air over the field, then
press Fly. Or press Map and click an airfield to start from it, or click
anywhere else on earth (the map can be moved and zoomed all the way round it) to drop a pin and press Fly from pin to start in
the air over that spot; the same works from the
map in flight (`M`). While a pin is set, the flight panel points the way to it:
an arrow, the heading to steer, the distance and the time at your present speed. `W`/`S` pitch, `A`/`D` roll, `Q`/`E` rudder, `R`/`F` faster and
slower; flaps, brakes and fuel take care of themselves. `C` switches between the
chase view and the cockpit (drag to look around, wheel to zoom). `G` hands the
aircraft to the autopilot, and `T` speeds time up: ×2, ×4, ×8, ×16, ×32, ×64,
then back to normal. `Esc` opens the menu.

### Rockets

Choose the Saturn V or Starship under Craft and the airfield gives way to a launch site (Kennedy's two
Apollo pads, Cape Canaveral, Starbase, Vandenberg, Wallops, Kodiak, and the world's others from Kourou to
Tanegashima: every one a place with real launch pads). Or
press Map, drop a pin anywhere on earth and press Launch from here: a pad is built on the spot. The weather
chosen is the weather the rocket climbs through.

`Space` lights the engines and lets go; after that it drops the stage. `G` is the autopilot, which flies the
whole climb to a circular orbit about 118 miles up and shuts the engines down. By hand: `W`/`S` lower and
raise the nose against the horizon, `A`/`D` swing it around the compass, `R`/`F` (or `Z`/`X`) set the thrust,
and `1`/`2`/`3` hold the attitude, the nose on the direction of travel, or the tail to it. There is no fuel
to run out. Between 15 and 22 miles up the game's world gives way to the view from space: the same
satellite picture on a globe, the weather you left as cloud below, the thin blue line of the air, the Moon
where the sky had it.

`L`, from a low orbit of the Earth, is the way to the Moon: it works out the burn, waits (with time run fast)
until the Moon is where it needs to be, burns, coasts for three days, trims the path as it nears the Moon and
brakes into a circular orbit about 95 miles above it. The plan is drawn on the map; touch any control to take
over. The Moon itself is NASA's: the Lunar Reconnaissance Orbiter's color mosaic and elevation.

A rocket is heard through the air it is in: a crackling roar on the pad (recordings of real launches), duller and
fainter as the air thins, a rumble through the structure in the onboard view (`C`) all the way to orbit. Coming
home, the air glows around the craft.

`M` in a rocket is the orbit map: the path ahead, with its high and low points, drawn around the Earth, and
around the Moon for the part of it inside the Moon's pull. `.` and `,` run time faster and slower (up to
100,000 times, engines off, above the air). `N` picks a satellite to aim for: the ISS (whose orbit passes
over the launch site as the flight starts), Tiangong, Hubble, a Starlink train, GPS, a weather satellite.
Start can also be "In orbit of the Earth" or "In orbit of the Moon" to skip the climb. Coming back, the air
slows the craft, the ground is fetched again under wherever it comes down, and a rocket set down upright
and gently on its engines has landed.

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
