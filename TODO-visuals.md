# Dead Reckoning — visual fidelity backlog

## Context for the implementing agent
- Browser game: vanilla JS (ES modules), three.js 0.187 on WebGL2 (`THREE.WebGLRenderer`), Vite 8.
  Nearly all shading is hand-written GLSL in ShaderMaterial / RawShaderMaterial. No WebGPU, no TSL.
- Design rule: arcade, not simulator. Visuals and weather come first; keep HUD and menus minimal.
- Assets: prefer free-license sources (CC0 / CC BY / public domain) over generated ones. Add every
  attribution to the title-screen credit (`main.js`, `$('credit')`).
- Testing: drive the sim with `window.DR.tick` / `window.DR.sim`; screenshots lag one frame;
  clear the test save between runs.
- Priority: P1 = biggest visible gain, P2 = strong, P3 = polish.

## Data
- [P1] Ground imagery: Sentinel-2 at 10 m/px (`world/imagery.js`) → USGS NAIP aerial imagery,
  0.6–1 m/px, public domain, no key (the National Map services). The sharper photos have harder
  baked shadows, so revisit the de-lighting step in `world/chunks.js` (~line 160).
- [P1] Elevation: Terrain Tiles zoom 13 (`world/dem.js:9`) → USGS 3DEP elevation (1 m lidar / 10 m DEM).
  Confirm the tile format and encoding first.
- [P2] Water mask for rivers: the free-flowing rivers (the braided Platte, the Yellowstone, the
  upper Missouri) are only photo pixels now. Use the river polygons of the USGS National
  Hydrography Dataset so they get the water shader's sun glint.

## Sky and atmosphere
- [P1] Replace the Preetham sky + exponential haze (`world/atmosphere.js`) with Hillaire's 2020
  lookup-table atmosphere: transmittance, multiple scattering, sky view, and an aerial-perspective
  volume (WebGL3DRenderTarget). Wanted: correct dawn and dusk, the Earth's shadow / Belt of Venus,
  the sky darkening with altitude. Keep the `skyRadiance` / `atmosphereTransmittance` interface so
  terrain, water, trees and clouds pick it up.
- [P2] Real night sky: the hash stars in `world/sky.js` → a star catalog (Yale Bright
  Star, public domain) placed for the latitude and time, the Big Dipper, Orion, a
  Milky Way texture (NASA SVS Deep Star Maps; check the license). The northern plains and the
  Great Basin are some of the darkest skies in the country, so this is a selling point.
- [P2] Moon: a disk with phase and earthshine, and moonlight color and strength from the phase.
  `sky.js` lights the scene from the "sun (or moon)" but draws no moon.
- [P3] Optical phenomena: a glory around the aircraft's shadow on cloud tops (the antisolar point);
  a 22° halo and sundogs in cirrostratus; a fogbow / cloudbow (pale, wide) next to the rainbow code
  in `weather/clouds.js`.

## Weather
- [P1] Wet ground after rain: darker albedo, a specular sheen on runways, roads and rock,
  puddles on aprons and grass strips, runway and approach lights reflected at night.
  Drying time comes from the weather state.
- [P2] Virga: rain shafts that evaporate before reaching the ground, under high-based showers.
- [P2] Chinook: the chinook arch (a clear slot over the Rocky Mountain Front under a sharp-edged
  cloud sheet) and lenticular stacks downwind of the Continental Divide. Check the `weather.js` presets first.
- [P3] Prop-tip vapor spirals and wingtip condensation in humid air at high power.
- [P3] Spray from the wheels on wet runways; dust and grass clippings blown back by the
  propeller on dry grass strips.

## Terrain and ground lighting
- [P1] Mountain shadows: the march through the 512 m regional grid (`chunks.js:36`) gives soft,
  shifted valley shadows at low sun. Add a finer near-field source (per-patch horizon angles
  from the patch data, or a mid-resolution height texture around the camera).
- [P1] Sky light: replace the two-color ambient mix (`chunks.js:192`) with irradiance from the
  real sky, e.g. spherical harmonics fitted to `skyRadiance` each frame. Share it with the trees.
- [P2] Vegetation hotspot: brightening of vegetation around the antisolar point (the opposition
  effect), plus mild backscatter for forest and prairie grass. A strong cue in aerial photos, and cheap.
- [P2] Snow and ice: a microfacet specular in place of `pow(...,24)`, a blue tint in shadowed
  snow, crevasse and serac detail on the glaciers (Glacier National Park, the Wind Rivers, the Alaska Range).
- [P2] Coast: a surf/foam line on exposed Pacific and Great Lakes beaches, shallow-water color from depth,
  wave breaking linked to the wind.
- [P3] Seasons: snow line by month, fall gold in the aspens of Colorado and the hardwoods of
  New England, spring green on the prairie.

## Near-ground detail (taxiing, takeoff, low flying)
- [P1] Sun shadows near the ground: only the aircraft casts real shadows, inside an 18 m box
  (`main.js:100`). Add cascaded shadow maps (`three/addons/csm/CSM.js`) over roughly 1–2 km, so
  hangars, terminals and parked objects cast shadows.
- [P2] Grass on grass strips and verges: instanced blades or shell rendering within ~100 m,
  bent by the propeller wash and the wind.
- [P2] Buildings: towns are point lights only (`world/towns.js`). Extrude OSM footprints
  near towns and airfields (Minneapolis, Denver, Bozeman) with simple roofs.
- [P3] Roads, fences, shelterbelts, power lines and transmission towers from OSM (power lines are
  also a real low-flying hazard).

## Night lighting
- [P2] Landing and taxi lights: today they are glow sprites (`aircraft/model.js:1054`). Cast a
  real cone onto the terrain and runway, with fog and rain scattering in the beam.
- [P2] Town lights: the points → a street-light layout from the OSM road network, mixing
  sodium-orange and LED-white; or NASA Black Marble for distant towns (check the license).

## Aircraft and cockpit
- [P2] The instrument panel reflected faintly in the windshield in bright sun; fine scratches
  in the plexiglass that catch light near the sun.
- [P3] Weathering: exhaust soot behind the stacks, oil streaks under the cowl, chipped leading
  edges, bug splatter.
- [P3] Rain on the airframe: a wet sheen and droplets running back over the wing, as seen from
  the cockpit.

## Image quality
- [P2] Pixel-ratio cap of 1.25 (`main.js:139`) and cloud buffer at 0.8 on high quality
  (`weather/clouds.js` TIERS): add an "ultra" tier for high-DPI screens and fast GPUs.

## Small wins
- [P1] Imagery level rings: `imagery()` in `world/imagery.js` (~line 131) rounds the level down
  and switches level abruptly, so each halving of resolution shows as a ring around the aircraft.
  Sample level l and l+1 and blend by `fract(level)` (falling back to l+1 where l isn't loaded).
- [P1] Imagery mipmaps + anisotropic filtering: the imagery DataArrayTexture has no mipmaps
  (`imagery.js:29`), so it can't be filtered anisotropically, and the ground is mostly seen at a
  shallow angle. When a tile arrives, also upload its half/quarter/... copies (made with
  `createImageBitmap` resizing) to the matching mip of the same slot. Tiles sit on 256-px
  boundaries, so the toroidal addressing holds at every mip. Then use the GPU's maximum
  anisotropy, and pick the level from screen-space derivatives instead of distance alone.
- [P2] Imagery pop-in: a newly arrived tile replaces the procedural colors instantly (the
  `s.a > 0.98` test). Keep each slot's arrival time and fade it in over about 0.5 s.
- [P2] Terrain geomorphing: the quadtree patches (`world/chunks.js`) jump between levels when
  they split or merge, which shows on ridgelines against the sky. In the vertex shader, ease
  vertices toward the parent level's height as they near the split distance.
- [P3] Anisotropy is hard-coded to 8 (`chunks.js:266`, `chunks.js:295`): use
  `renderer.capabilities.getMaxAnisotropy()` (usually 16).

## Bugs found in passing
- [P1] The sharpen setting does nothing: at `render/postfx.js:503` the line
  `xu.uSharp.value = 0.14 * (fx.sharpen ?? 1);` sits inside the end-of-line comment after the
  grain line, so `uSharp` stays at its default of 0.14. Move it onto its own line.

## GPU performance (none of this needs WebGPU)
- [P1] Measure first: time each pass with `EXT_disjoint_timer_query_webgl2` (scene, cloud march,
  cloud temporal/resolve/composite, AO, scene FX, TAA, motion blur, DoF, bloom, final, out) and
  show the timings in the weather debug panel. Every item below should be checked against it.
- [P1] Bake the ground's light terms instead of computing them per pixel. Each terrain pixel now
  runs a 10-step mountain-shadow march (`chunks.js:36`), 4 sky-occlusion taps (`chunks.js:49`)
  and `cloudShadowDepth` (`weather/clouds.js` ~line 250: about 4–5 `getSite` reads plus 3–4
  `cloudDensity` calls with 3D-noise lookups). Trees run the same per vertex (`trees.js:511`,
  `:698`) and airfields per vertex or pixel (`airfield.js:78`, `:323`, `:346`, `:407`).
  Render these once into a top-down texture centered on the camera (e.g. 1024² over ~40 km plus
  a coarser ring): r = terrain shadow, g = cloud optical depth, b = sky occlusion. Refresh it
  a slice at a time over several frames, since the sun moves slowly, and between refreshes
  just shift the cloud term along with the wind drift. All the ground shaders then do one
  texture read. The bake can also use finer elevation than the 512 m regional grid, which
  fixes the soft mountain shadows listed above for free.
- [P2] Cloud lighting can use the same bake: the far reach in `lightDepth` (FAR_SHADOW) and
  `overhead()` can read optical depth from it instead of evaluating density again.
  Consider a low-resolution 3D sun-transmittance volume for the near light steps too
  (6 light steps + 3 sky steps of `cloudDensity` per lit sample on high).
- [P2] Cloud march resolution: high runs the march at 0.8 screen scale every frame
  (`weather/clouds.js` TIERS). Temporal reprojection already exists, so try a lower scale
  with interleaved marching (e.g. each texel of a 2×2 block on alternate frames), the usual
  approach in shipped games. Compare quality in fast turns and when breaking out of cloud.
- [P2] Dynamic resolution: scale the main render resolution (and the cloud buffer) from the
  measured GPU frame time to hold the target frame rate. TAA hides the changes. This pairs
  with the "ultra" tier for fast GPUs listed above.
- [P2] FXAA runs on top of TAA (`OUT_FRAG` in `render/postfx-lens.js`): with TAA on, skip the
  FXAA branch and keep only the contrast-adaptive sharpening. That's cheaper and sharper.
- [P3] Fewer full-resolution passes: scene FX, TAA, motion blur, final and out each read and
  write the whole screen in half-float, plus the cloud composite and the glass buffer. Skip
  motion blur when the largest velocity on screen is under about half a pixel (the DoF tile
  pass already computes a tiled maximum); look at folding sharpening into the TAA resolve.
- [P3] Bandwidth: the velocity output of the scene pass is a full RGBA16F texture; if three.js
  allows a different format per MRT texture, make it RG16F.
- [P3] Terrain depth pre-pass: terrain pixels are expensive and mountains overlap each other.
  Once the light terms are baked this matters less; measure before adding one.

## Frame pacing (not visual, but very visible)
- [P1] Move terrain work off the main thread. Patch building runs on the main thread inside a 5 ms
  per-frame budget (`chunks.js:490`), and height-tile decoding (`world/dem.js:23`) and tree
  placement do too. Move them into a small pool of Web Workers: `OffscreenCanvas` and
  `createImageBitmap` both work there, and typed arrays can be handed back without copying.
  Only after that, profile. If one worker routine is still slow, port just that routine to
  Rust/WASM inside the worker; don't port the whole engine.
