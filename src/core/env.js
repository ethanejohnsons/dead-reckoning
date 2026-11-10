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
  uTime: { value: 0 },
  uNight: { value: 0 },
  uWxHalf: { value: 262144 },
  tWxA: { value: null },   // r: cloud cover, g: convective, b: precip, a: cirrus
  tWxB: { value: null },   // r: base/12800, g: top/12800
  tDetail: { value: null },
  uCloudDrift: { value: new THREE.Vector3() },
  uFlashPos: { value: new THREE.Vector3() },
  uFlash: { value: 0 },
  uTAnom: { value: 0 },      // air-mass temperature anomaly, lays fresh snow on cold days
};
