// The night sky's fixed lights: the stars of the Yale Bright Star Catalogue as points, and the Milky Way
// as a texture for the sky dome.
//
// public/data/stars.bin   The Bright Star Catalogue, 5th revised edition (Hoffleit & Warren 1991, Yale
//   University Observatory; public domain, from the Astronomical Data Center via
//   http://tdc-www.harvard.edu/catalogs/bsc5.html): 9096 stars to about magnitude 7, packed by
//   tools/bake-stars.py as 'DRS1', a uint32 count, then per star uint16 RA, int16 Dec (J2000),
//   uint8 (V + 2) * 25, uint8 (B-V + 0.5) * 100, brightest first.
// public/data/milkyway.jpg   NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star
//   Maps 2020 (svs.gsfc.nasa.gov/4851), the Milky Way background made from Gaia DR2 (ESA/Gaia/DPAC),
//   celestial coordinates, reduced to 2048 x 1024 and stored as sqrt(linear / 0.6) by tools/bake-milkyway.py.
//
// Brightness is photometric: a star of magnitude 0 gives 2.08e-6 lux, a pixel spans uPixAngle squared
// steradians, so the radiance a star puts into its few pixels follows, and the sky's adaptation gain
// (sky.js) decides what of that the eye, or the display, sees. Nothing here knows whether it is night.

import * as THREE from 'three';
import { ENV } from '../core/env.js';

export const STARS_CREDIT = 'Stars: Yale Bright Star Catalogue, 5th ed. (Hoffleit &amp; Warren 1991). Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio; Gaia DR2: ESA/Gaia/DPAC';
const STAR_URL = `${import.meta.env.BASE_URL}data/stars.bin`, MILKY_URL = `${import.meta.env.BASE_URL}data/milkyway.jpg`;
export const STAR_LUX = 2.08e-6;            // illuminance from a star of visual magnitude 0, outside the air
const STAR_GAIN = 3;                        // stars against the rest of the night: the eye gathers a point's light better than a pixel shows it
export const MILKY_CDM2 = 0.6 * 3.2e-3;     // luminance (cd/m2) of a texel that decodes to 1: the Scutum cloud comes out near 7e-4, 20.5 mag per square arcsecond

const VERT = /* glsl */`
attribute vec3 aCol;
attribute float aMag;
uniform mat3 uCel;       // equatorial to world
uniform vec4 uStar;      // x: radiance of a magnitude-0 star spread over one pixel, y: time (s), z: sine of the horizon's dip, w: pixels per CSS pixel
uniform vec3 uTau;       // optical depth of the air straight up, per channel
varying vec3 vCol;
varying float vSig;
void main() {
  vec3 d = uCel * position;
  float y = d.y + uStar.z, yc = max(y, 0.0);
  float air = 1.0 / (yc + 0.025 * exp(-11.0 * yc));                      // air masses on the line of sight (Rozenberg): 1 overhead, 40 at the horizon
  vec3 ext = exp(-uTau * air) * smoothstep(-0.003, 0.006, y);
  float flux = uStar.x * exp(-0.921034 * aMag);
  // Scintillation: the low stars flicker and flash colour, the high ones barely stir.
  float ph = dot(position, vec3(127.1, 311.7, 74.7)), t = uStar.y, amp = min(0.045 * pow(air, 1.1), 0.6);
  float tw = 1.0 + amp * (0.6 * sin(t * 23.0 + ph * 7.0) + 0.4 * sin(t * 37.1 + ph * 11.0));
  vec3 chroma = 1.0 + amp * 0.5 * smoothstep(3.0, 12.0, air) * vec3(sin(t * 29.0 + ph * 3.0), sin(t * 31.0 + ph * 5.0), sin(t * 27.0 + ph * 9.0));
  // A star is a point: it lands as a small Gaussian. The bright ones are spread a little wider than the faint,
  // as the eye and every lens spread them, with the light they carry unchanged.
  float sig = uStar.w * (0.72 + 0.45 * smoothstep(0.05, 12.0, flux));
  vSig = sig;
  vCol = aCol * ext * chroma * (flux * tw / (6.2832 * sig * sig));
  gl_PointSize = max(2.0, ceil(sig * 6.0));
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * d * 1000.0, 1.0);
  gl_Position.z = gl_Position.w * 0.9999995;                              // on the far plane: behind everything, in front of nothing
  if (dot(vCol, vec3(1.0)) < 2e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // too faint to show: cull
}`;

const FRAG = /* glsl */`
varying vec3 vCol;
varying float vSig;
void main() {
  vec2 p = (gl_PointCoord - 0.5) * max(2.0, ceil(vSig * 6.0));
  gl_FragColor = vec4(vCol * exp(-dot(p, p) / (2.0 * vSig * vSig)), 0.0);
}`;

/** Colour of a star from its B-V index: blackbody temperature (Ballesteros 2012), then a fit to the blackbody's colour, at unit luminance. */
function starColour(bv, out, o) {
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)), t = T / 100;
  let r = t <= 66 ? 1 : 1.292936 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 0.390082 * Math.log(t) - 0.631841 : 1.129891 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 1 : t <= 19 ? 0 : 0.543207 * Math.log(t - 10) - 1.196254;
  r = Math.min(Math.max(r, 0), 1) ** 2.2; g = Math.min(Math.max(g, 0), 1) ** 2.2; b = Math.min(Math.max(b, 0), 1) ** 2.2;   // the fit is for display values
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b, k = 0.75;         // the eye sees star colours weakly: keep three quarters of the saturation
  out[o] = (1 + (r / l - 1) * k); out[o + 1] = (1 + (g / l - 1) * k); out[o + 2] = (1 + (b / l - 1) * k);
}

export class Stars {
  constructor(scene) {
    this.scene = scene;
    this.uCel = { value: new THREE.Matrix3() };
    this.uStar = { value: new THREE.Vector4(0, 0, 0, 1) };
    this.uTau = { value: new THREE.Vector3(0.05, 0.1, 0.25) };
    this.points = null;
    this.count = 0;
    this.milky = new THREE.Texture();              // filled when the image arrives; black until then
    this.milkyReady = false;
    this.load();
  }

  async load() {
    new THREE.TextureLoader().load(MILKY_URL, (t) => {
      t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
      this.milky.dispose(); this.milky = t; this.milkyReady = true;
      this.onMilky?.(t);
    }, undefined, () => console.warn('Milky Way map did not load'));
    try {
      const buf = await (await fetch(STAR_URL)).arrayBuffer(), dv = new DataView(buf);
      if (dv.getUint32(0, false) !== 0x44525331) throw new Error('not a star file');
      const n = dv.getUint32(4, true), pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n);
      for (let i = 0, o = 8; i < n; i++, o += 6) {
        const ra = (dv.getUint16(o, true) / 65536) * 2 * Math.PI, dec = (dv.getInt16(o + 2, true) / 32767) * (Math.PI / 2);
        pos[i * 3] = Math.cos(dec) * Math.cos(ra); pos[i * 3 + 1] = Math.cos(dec) * Math.sin(ra); pos[i * 3 + 2] = Math.sin(dec);
        mag[i] = dv.getUint8(o + 4) / 25 - 2;
        starColour(dv.getUint8(o + 5) / 100 - 0.5, col, i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uCel: this.uCel, uStar: this.uStar, uTau: this.uTau }, vertexShader: VERT, fragmentShader: FRAG,
        // Added to the sky behind, leaving the target's alpha alone.
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        depthTest: true, depthWrite: false, transparent: false, fog: false,
      });
      this.points = new THREE.Points(geo, mat);
      this.points.frustumCulled = false; this.points.renderOrder = -999;       // straight after the sky dome
      this.points.visible = false;
      this.count = n; this.mag = mag;
      this.scene.add(this.points);
    } catch (e) { console.warn('Star catalogue did not load:', e.message); }
  }

  /**
   * m: equatorial-to-world rotation (9 numbers, row-major). perLuxSr: engine radiance per lux per
   * steradian (that is, per cd/m2), adaptation gain and cloud dimming included. tau: the air's optical
   * depth straight up, per channel. sinDip: sine of the horizon's dip. pixelRatio: device pixels per CSS pixel.
   */
  update(m, perLuxSr, tau, sinDip, time, pixelRatio) {
    if (!this.points) return;
    const pix = ENV.uPixAngle.value;
    const flux0 = (STAR_GAIN * perLuxSr * STAR_LUX) / (pix * pix);
    // Sirius (magnitude -1.46) is 3.8 times a magnitude-0 star: if even it would not show, skip the draw.
    this.points.visible = flux0 * 3.8 > 2e-3;
    if (!this.points.visible) return;
    this.uCel.value.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    this.uStar.value.set(flux0, time % 1000, sinDip, pixelRatio);
    this.uTau.value.set(tau[0], tau[1], tau[2]);
  }
}
