# Dead Reckoning

A browser flight simulator about navigating by compass, clock and weather.
Fly a turboprop bush plane between 14 airfields on a fictional 400 km
continent, through simulated pressure systems, fronts, thunderstorms, fog,
snow, icing and mountain wave.

## Run

```bash
npm install
npm run dev
```

`npm run build` writes a static site to `dist/`.

## Layout

- `src/world/` terrain generator, level-of-detail mesh, airfields, sky
- `src/weather/` weather simulation, volumetric clouds, rain/snow/lightning
- `src/aircraft/` flight model and aircraft mesh
- `src/core/` input, navigation (dead reckoning), sound, shared uniforms
- `src/game/` flight planning and dispatch offers
- `src/ui/` instruments, chart, styles
- `src/main.js` boot, game loop, flight logic

Everything (terrain, clouds, aircraft, sound) is generated in code; there are
no asset files. Press `H` in flight for controls.
