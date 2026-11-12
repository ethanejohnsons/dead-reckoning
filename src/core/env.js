// Shared lighting/atmosphere state. Every custom shader references these
// uniform objects directly, so updating a value here updates the whole scene.
import * as THREE from 'three';

export const ENV = {
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
  uSunCol: { value: new THREE.Color(2.2, 2.1, 1.9) },
  uAmbSky: { value: new THREE.Color(0.3, 0.4, 0.55) },
  uAmbGround: { value: new THREE.Color(0.12, 0.11, 0.09) },
  uFogCol: { value: new THREE.Color(0.62, 0.74, 0.88) },
  uZenith: { value: new THREE.Color(0.16, 0.36, 0.78) },
  uFogDensity: { value: 0.00004 },
  // Atmosphere model (see world/atmosphere.js)
  uSkySun: { value: new THREE.Vector3(0, 1, 0) },
  uBetaR: { value: new THREE.Vector3(1e-5, 2e-5, 4e-5) },
  uBetaM: { value: new THREE.Vector3(2e-6, 3e-6, 5e-6) },
  uSkyOvc: { value: new THREE.Color(0.5, 0.5, 0.5) },
  uSunE: { value: 1000 },
  uSkyP: { value: new THREE.Vector4(0.8, 1, 0, 0) },
  uHaze: { value: new THREE.Vector4(5e-5, 1800, 1, 0) },
  uHorizon: { value: new THREE.Color(0.6, 0.7, 0.85) },   // horizon sky colour averaged round the compass
  // Lookup-table atmosphere and sky light (see world/atmosphere.js, world/skylut.js)
  tAtmSky: { value: null },                                        // sky-view table: the sky all round, from the camera's height
  tAtmAP: { value: null },                                         // aerial table: the haze's colour by direction and distance
  uAtmSky: { value: new THREE.Vector4(0, 0, 0, 0) },               // x: sine of the horizon's dip, y: how clear the horizon stays under overcast
  uAtmAP: { value: new THREE.Vector4(32, Math.log(50), 1, 1 / 64) },   // x: slices, y: ln(first slice, m), z: 1 / ln(slice ratio), w: half a row
  uSkySH: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },   // sky irradiance / pi as spherical harmonics (skyIrradiance in ATMO_GLSL)
  tRegion: { value: null },    // r: terrain height (m), g: moisture 0..1, over the whole region
  uWind: { value: 0 },
  uSea: { value: 0 },        // how rough open water is, 0 calm .. 1 a full storm sea (eased; set in main.js)
  // Satellite imagery clip levels (see world/imagery.js)
  tImagery: { value: null },
  uImgA: { value: Array.from({ length: 7 }, () => new THREE.Vector4(0, 0, 1, 0)) },   // x0, z0, 1/extent, valid half-width
  uImgC: { value: Array.from({ length: 7 }, () => new THREE.Vector2()) },            // window centre
  uImgOn: { value: 0 },
  uPixAngle: { value: 0.001 },   // radians per screen pixel         // surface wind speed, m/s (whitecaps)
  uTime: { value: 0 },
  uNight: { value: 0 },
  uWxHalf: { value: 262144 },
  tWxA: { value: null },   // r: cloud cover, g: convective, b: precip, a: cirrus
  tWxB: { value: null },   // r: base/12800, g: top/12800
  tDetail: { value: null },
  uCloudDrift: { value: new THREE.Vector3() },
  // Cloud shapes for ground shadows: filled by the cloud renderer, read by the terrain and tree shaders
  // (see CLOUD_SHADOW_GLSL in weather/clouds.js).
  tWxC: { value: null }, tCloudNoise: { value: null }, tCloudDetail: { value: null }, tCloudCurl: { value: null },
  uCloudDriftN: { value: new THREE.Vector2() }, uCloudDriftM: { value: new THREE.Vector2() }, uCloudDriftD: { value: new THREE.Vector2() },
  uCloudDriftC: { value: new THREE.Vector2() }, uCloudDriftW: { value: new THREE.Vector2() }, uCloudDriftV: { value: new THREE.Vector2() },
  uCloudDriftS: { value: new THREE.Vector2() }, uCloudShear: { value: new THREE.Vector2() }, uCloudCells: { value: 0 },
  uFlashPos: { value: new THREE.Vector3() },
  uFlash: { value: 0 },
  uTAnom: { value: 0 },      // air-mass temperature anomaly, lays fresh snow on cold days
  uWet: { value: 0 },        // ground wetness around the aircraft, 0 dry .. 1 soaked (Weather.wet: rises in rain, dries with warmth, wind and sun)
  uSnow: { value: 0 },       // snow lying on the ground around the aircraft, 0 none .. 1 a full cover (Weather.snowpack: builds under snowfall, melts above freezing)
  uRain: { value: 0 },       // rain falling on the ground at the aircraft right now, 0..1 (rings in the puddles)
  uGroundT: { value: 15 },   // air temperature at the ground under the aircraft, deg C: where uSnow was measured (snow lies on ground as cold as that, not on ground much warmer)
};
