// Sky dome, sun, moon, stars, time of day and the scene lights.
//
// The sky's colour comes from the lookup-table atmosphere (atmosphere.js, skylut.js). A small copy of
// it is read back each frame or two, and from that copy come the ambient light (spherical harmonics),
// the haze and horizon colours, the image-based lighting on the aircraft and the exposure: everything
// is lit by the sky you can see.
//
// Units. Light is kept in the engine's daylight units all the way to starlight: uSunCol is irradiance / pi
// (what a white card facing the light shows), about 1.4 for the midday sun. A full moon is 2.5 millionths
// of that and starlight a thousandth of the moon. What makes night visible is `gain`, the eye opening:
// one number, set from the brightness of the clear sky, that multiplies every natural light alike (sun,
// moon, sky, stars), so their proportions hold. sky.exposure (1 to 3.8) is the part of the adaptation
// left to the post-processing, as before.

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { REGION } from './geo.js';
import { clamp, smoothstep } from '../core/noise.js';
import {
  ATMO_GLSL, ATMO_UNIFORMS, air, horizonDip, opticalDepth, lightTransmittance, setProbe, setSkyMix, skyRadiance, skyMeans,
  fitSkyIrradiance, skyIrradiance,
} from './atmosphere.js';
import { SkyLUT, AP_NEAR } from './skylut.js';
import { skyAt, makeSky, sunTimes, MARCH_EQUINOX } from './celestial.js';
import { Stars, MILKY_CDM2 } from './stars.js';

// ---- calibration
const S0 = 1.56;                 // sunlight above the air, as irradiance / pi in engine units (sets the midday sun to its old level)
const SUN_LUX = 133000;          // the same in lux
const K_LUM = (S0 * Math.PI) / SUN_LUX;       // engine radiance per cd/m2
const SKY_GAIN = 1.5;            // sky tables against the sun: 1 is what the model gives, the old sky was nearer 2.3; at 1.5 the zenith is about 4000 cd/m2
const AMB_SCALE = 0.87, AMB_GREY = 0.0;       // sky light on surfaces against the sky's own irradiance (set so midday ambient is the old ambient), and how far it is greyed (not at all)
const M_REF = 0.242, DOWN_REF = 1.05;         // the clear sky at 13:00 on the equinox: its mean luminance, and the light on level ground / pi (the adaptation's references)
const OVC_K = 0.455;             // overcast sky radiance against the light falling on level ground under a clear sky (/ pi)
const GLOW_CDM2 = 2.2e-4;        // airglow, zodiacal light and unresolved stars at the zenith on a moonless night (about 21.9 mag per square arcsecond)
const GLOW_TINT = [0.62, 0.85, 1.12];         // (as the dark-adapted eye has it: blue-grey, not the airglow's green)
const MOON_TINT = [1.06, 1.0, 0.9];           // moonlight is sunlight off grey-brown rock
const MOON_CDM2 = 4700;          // mean luminance of the full moon's disc
const MILKY_GAIN = 2.5;          // the Milky Way against the rest of the night: shown as a long exposure shows it
const MOON_RADIUS = 0.0090;      // radians: drawn twice life size, like the sun's disc
const DISC_CAP = 1.5;            // brightest the moon's disc is shown, as a display value before tone mapping

// Display brightness against the light there is (both log10, relative to the clear midday sky). Down to a
// tenth of midday the picture follows the light with the old exposure law; below that it is held up, more
// and more, the way the eye adapts, until under starlight alone the eye has no more to give.
const ADAPT = [[-1, -0.45], [-2, -0.57], [-3.5, -0.67], [-5.6, -0.84], [-6.1, -1.02], [-6.7, -1.3], [-7.2, -1.42], [-8.2, -2.4]];
function displayLevel(x) {
  const A = ADAPT, n = A.length;
  if (x >= 0) return x;                      // brighter than the reference: nothing to add
  if (x >= A[0][0]) return 0.45 * x;         // the exposure's own range
  if (x <= A[n - 1][0]) return A[n - 1][1] + (x - A[n - 1][0]);
  let i = 0; while (x < A[i + 1][0]) i++;
  // Monotone cubic through the knots (Fritsch-Carlson tangents, clamped), so there is no step in slope.
  const slope = (k) => (A[k + 1][1] - A[k][1]) / (A[k + 1][0] - A[k][0]);
  const tan = (k) => (k === 0 ? 0.45 : k === n - 1 ? 1 : (() => { const a = slope(k - 1), b = slope(k); return (2 * a * b) / (a + b); })());
  const h = A[i + 1][0] - A[i][0], t = (x - A[i][0]) / h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * A[i][1] + (t3 - 2 * t2 + t) * h * tan(i) + (-2 * t3 + 3 * t2) * A[i + 1][1] + (t3 - t2) * h * tan(i + 1);
}
const baseExposure = (m) => clamp(Math.pow(1 / Math.max(m, 1e-12), 0.55), 1, 3.8);
/** The eye's gain for a sky of mean luminance m (relative to midday): what the exposure cannot give. */
const adaptGain = (m) => Math.pow(10, displayLevel(Math.log10(Math.max(m, 1e-12)))) / (Math.max(m, 1e-12) * baseExposure(m));

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position * 1000.0, 1.0);
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDisc, uGround, uSunPos;
uniform vec3 uMoonPos, uMoonRight, uMoonUp, uMoonLit, uMoonEarth, uMilky, uTau;
uniform vec2 uMoonR;      // cosine and sine of the moon's radius
uniform mat3 uToEq;       // world to equatorial
uniform sampler2D tMilky;
uniform float uEnvPass;
varying vec3 vDir;
${ATMO_GLSL}
float blob(vec2 q, float x, float y, float r) { vec2 d = (q - vec2(x, y)) / r; return 1.0 - smoothstep(0.1, 1.3, dot(d, d)); }
// The near side's seas, north up: enough for a disc a dozen pixels across.
float moonAlbedo(vec2 q) {
  q += 0.05 * vec2(sin(q.y * 9.0 + 1.3) + sin(q.y * 17.0), sin(q.x * 8.0 + 0.7) + sin(q.x * 19.0 + 2.0));      // ragged shores
  float m = blob(q, -0.25, 0.50, 0.33) + blob(q, 0.27, 0.45, 0.20) + blob(q, 0.45, 0.14, 0.23) + blob(q, 0.78, 0.28, 0.12)
    + blob(q, 0.73, -0.08, 0.15) + blob(q, 0.52, -0.28, 0.10) + blob(q, -0.62, 0.22, 0.36) + blob(q, -0.58, -0.40, 0.11)
    + blob(q, -0.22, -0.38, 0.22) + blob(q, 0.04, 0.20, 0.09) + 0.6 * blob(q, 0.0, 0.84, 0.13) + 0.6 * blob(q, -0.32, 0.86, 0.12);
  float rays = blob(q, -0.10, -0.68, 0.07) + 0.5 * blob(q, -0.33, 0.16, 0.05) + 0.4 * blob(q, -0.62, 0.40, 0.04);
  return 1.14 - 0.5 * smoothstep(0.25, 0.95, m) + 0.3 * rays;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyRadiance(d);
  // What lies beyond the air is dimmed and reddened by the air in front of it.
  float yh = d.y + uAtmSky.x, yc = max(yh, 0.0);
  vec3 ext = exp(-uTau / (yc + 0.025 * exp(-11.0 * yc))) * smoothstep(-0.002, 0.004, yh);
  if (uMilky.g > 0.0 && yh > 0.0) {
    vec3 e = uToEq * d;
    vec3 m = texture2D(tMilky, vec2(0.5 - atan(e.y, e.x) * 0.15915494, 0.5 + asin(clamp(e.z, -1.0, 1.0)) * 0.31830989)).rgb;
    col += m * m * uMilky * ext;
  }
  float s = dot(d, uSunPos);
  // Sun disc, kept very bright so the lens and bloom respond to it. Its aureole is in the sky table already.
  float disc = smoothstep(0.99996, 0.999985, s);
  col += uSunDisc * (disc * 60.0 + pow(max(s, 0.0), 2500.0) * 3.0 + pow(max(s, 0.0), 180.0) * 0.12) * (1.0 - uEnvPass * 0.9);
  float mc = dot(d, uMoonPos);
  if (mc > uMoonR.x) {
    vec3 off = d - uMoonPos * mc;
    vec2 q = vec2(dot(off, uMoonRight), dot(off, uMoonUp)) / uMoonR.y;
    float r2 = dot(q, q), z = sqrt(max(1.0 - r2, 0.0));
    vec3 n = q.x * uMoonRight + q.y * uMoonUp - z * uMoonPos;
    float mu0 = dot(n, uSunPos);
    // Lunar soil is no matt ball: it is as bright at the limb as at the centre (Lommel-Seeliger), so the full moon is a flat disc.
    float lit = smoothstep(-0.02, 0.08, mu0) * 2.0 * max(mu0, 0.0) / (max(mu0, 0.0) + z + 0.02);
    float edge = 1.0 - smoothstep(0.80, 1.0, r2 * r2);
    col += moonAlbedo(q) * (uMoonLit * min(lit, 1.3) + uMoonEarth) * ext * edge;
  }
  col += uMoonLit * (pow(max(mc, 0.0), 3000.0) * 0.10 + pow(max(mc, 0.0), 300.0) * 0.006) * ext * (1.0 - uEnvPass * 0.8);
  // For reflections, the lower hemisphere is ground, not sky.
  col = mix(col, uGround, uEnvPass * smoothstep(0.02, -0.12, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

const tmp = new THREE.Color(), tmp2 = new THREE.Color(), acc = new THREE.Color(), v3 = new THREE.Vector3();
const lum = (c) => c.r * 0.25 + c.g * 0.6 + c.b * 0.15;
const means = { mean: [0, 0, 0], down: [0, 0, 0] }, tau = [0, 0, 0];

export class Sky {
  constructor(scene, renderer) {
    this.scene = scene; this.renderer = renderer;
    this.lut = new SkyLUT(renderer);
    this.stars = new Stars(scene);
    ENV.tAtmSky.value = this.lut.sky.texture; ENV.tAtmAP.value = this.lut.ap.texture;

    const C = () => ({ value: new THREE.Color(0, 0, 0) }), V = () => ({ value: new THREE.Vector3(0, 1, 0) });
    this.uSunDisc = C(); this.uGround = { value: new THREE.Color(0.05, 0.06, 0.04) }; this.uSunPos = V();
    this.uMoonPos = V(); this.uMoonRight = V(); this.uMoonUp = V(); this.uMoonLit = C(); this.uMoonEarth = C(); this.uMilky = C();
    this.uTau = { value: new THREE.Vector3() };
    this.uMoonR = { value: new THREE.Vector2(Math.cos(MOON_RADIUS), Math.sin(MOON_RADIUS)) };
    this.uToEq = { value: new THREE.Matrix3() };
    this.tMilky = { value: this.stars.milky };
    this.stars.onMilky = (t) => { this.tMilky.value = t; };
    this.uEnvPass = { value: 0 };
    const uniforms = {
      uSunDisc: this.uSunDisc, uGround: this.uGround, uEnvPass: this.uEnvPass, uSunPos: this.uSunPos,
      uMoonPos: this.uMoonPos, uMoonRight: this.uMoonRight, uMoonUp: this.uMoonUp, uMoonLit: this.uMoonLit, uMoonEarth: this.uMoonEarth,
      uMoonR: this.uMoonR, uMilky: this.uMilky, uTau: this.uTau, uToEq: this.uToEq, tMilky: this.tMilky,
    };
    for (const k of ATMO_UNIFORMS) uniforms[k] = ENV[k];
    this.mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5),
      new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
    scene.add(this.sun, this.sun.target, this.hemi);
    this.fog = new THREE.FogExp2(0xffffff, 0.00004);
    scene.fog = this.fog;

    // Image-based lighting: a small cube map of the sky, refreshed as the light changes.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(this.mesh.geometry, this.mesh.material);
    this.envMesh.frustumCulled = false;
    this.envScene.add(this.envMesh);
    this.envRT = null; this.envKey = ''; this.envT = 0;

    this.trueSun = new THREE.Vector3(0, 1, 0); this.skySun = new THREE.Vector3(0, 1, 0); this.moonDir = new THREE.Vector3(0, 1, 0);
    this.elev = 45;             // the sun's elevation, degrees
    this.moonElev = 0;
    this.exposure = 1;          // eye adaptation: the composite brightens the image as the light goes
    this.gain = 1;              // the rest of the adaptation, inside the light itself (see the note on units above)
    this.logM = 0;              // adapted light level, log10 against the clear midday sky
    /** Day of the year (1..365). The default is the March equinox: sunrise at 06:00, sunset at 18:00. */
    this.day = MARCH_EQUINOX;
    /** The moon's phase at noon: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. The default is a waxing gibbous moon, up from mid-afternoon until the small hours. */
    this.moonPhase = 0.375;
    this.cel = makeSky();
    this.sunPhys = new THREE.Color(); this.moonPhys = new THREE.Color(); this.sunEng = new THREE.Color(); this.moonEng = new THREE.Color();
    this.bakedGain = 1; this.frame = 0; this.last = null; this.airKey = '';
    this.lightIsMoon = false;
  }

  setQuality(q) {
    if (!this.lut.setQuality(q)) return;
    ENV.tAtmSky.value = this.lut.sky.texture; ENV.tAtmAP.value = this.lut.ap.texture;
    this.last = null;                         // redraw everything on the next update
  }
  /** Sunrise and sunset (local solar hours) for the date and the region's latitude. */
  sunTimes() { return sunTimes(REGION.lat0, this.day); }

  /**
   * hour: local solar time 0..24. wx: {overcast 0..1, shade 0..1 on the aircraft, visibility m, precip 0..1}.
   * haze: clear-air visibility of the air mass (m). focus: point the sun light follows (its height is the
   * height the atmosphere is seen from). opt.humidity 0..1 swells the haze particles (a whiter, more forward-scattering haze).
   */
  update(hour, wx, haze, focus, dt, opt) {
    const lut = this.lut, u = lut.u, cel = skyAt(REGION.lat0, this.day, hour, this.moonPhase, this.cel);
    this.trueSun.set(cel.sun[0], cel.sun[1], cel.sun[2]); this.moonDir.set(cel.moon[0], cel.moon[1], cel.moon[2]);
    const el = Math.asin(clamp(cel.sun[1], -1, 1)), e = (el * 180) / Math.PI, elM = Math.asin(clamp(cel.moon[1], -1, 1));
    this.elev = e; this.moonElev = (elM * 180) / Math.PI;
    const altKm = Math.max(focus.y, 0) / 1000, sdip = horizonDip(altKm);

    // ---- weather
    const night = 1 - smoothstep(-14, -5, e);
    const ov = clamp(wx.overcast, 0, 1), dim = 1 - 0.45 * wx.precip, shade = clamp(wx.shade, 0, 1);
    const visMurk = smoothstep(9000, 1500, wx.visibility);
    const murk = Math.max(ov * 0.88, wx.precip * 0.8, visMurk);
    // Under a deck the far horizon stays lighter and keeps the sky's colour (the red band at dusk); rain and fog close it.
    const slot = murk > 0.01 ? 0.8 * clamp((ov * 0.88) / murk, 0, 1) * (1 - clamp(Math.max(wx.precip * 1.5, visMurk), 0, 1)) : 0;
    const sigma = 1.3 / Math.max(wx.visibility, 250), hazeH = 1900 + 2200 * smoothstep(20000, 60000, wx.visibility);
    ENV.uHaze.value.set(sigma, hazeH, 1.0, 0);
    // The air mass: murkier air scatters more, and holds its haze lower.
    const hz = clamp(haze, 3000, 400000), hum = clamp(opt?.humidity ?? 0.4, 0, 1);
    air.ext = 1300 / hz; air.H = (1900 + 2200 * smoothstep(20000, 60000, hz)) / 1000; air.g = 0.76 + 0.1 * hum; air.albedo = 0.9 + 0.06 * hum;
    const airKey = `${Math.round(Math.log(air.ext) * 60)}|${Math.round(air.H * 40)}|${Math.round(air.g * 100)}`;

    // ---- the lights as they are, before the eye adapts
    lightTransmittance(altKm, el, this.sunPhys).multiplyScalar(S0);
    lightTransmittance(altKm, elM, this.moonPhys).multiplyScalar((S0 * cel.moonLux) / SUN_LUX);
    // In the dark the eye's rods take over and the world turns blue-grey (the Purkinje shift): moonlight is drawn the way it is seen.
    const rods = smoothstep(1.5, 4, Math.log10(this.gain));
    const mt = [MOON_TINT[0] * (1 - 0.2 * rods), MOON_TINT[1] * (1 - 0.03 * rods), MOON_TINT[2] * (1 + 0.28 * rods)];
    this.moonPhys.r *= mt[0]; this.moonPhys.g *= mt[1]; this.moonPhys.b *= mt[2];
    const sunSky = e > -19, moonSky = this.moonElev > -4 && e < 2 && cel.moonLux > 1e-4;

    // ---- a cut (a new flight, a new time of day, a new place): everything is redrawn now, the probe is read back
    // at once (the one place the frame waits for the GPU, some milliseconds) and the eye is taken as adapted.
    // A scrub (the clock being dragged): everything is redrawn each frame and the eye keeps up, without the wait.
    // (Weather comes and goes at its own pace: the tables follow within two frames and the eye in a second or two.)
    const L = this.last, dh = L ? Math.abs(hour - L.hour) : 99;
    const jump = !L || dt === 0 || dh > 0.25 || Math.abs(altKm - L.alt) > 0.4
      || L.phase !== this.moonPhase || L.day !== this.day || L.lat !== REGION.lat0;
    const scrub = !jump && dh > 0.004;
    this.last = { hour, alt: altKm, phase: this.moonPhase, day: this.day, lat: REGION.lat0 };

    const setTables = (g) => {
      u.uAer.value.set(air.ext, air.H, air.albedo, air.g);
      u.uSun.value.copy(this.trueSun); u.uMoon.value.copy(this.moonDir);
      const eS = sunSky ? Math.PI * S0 * SKY_GAIN * g : 0, eM = moonSky ? (Math.PI * S0 * SKY_GAIN * g * cel.moonLux) / SUN_LUX : 0;
      u.uSunE.value.set(eS, eS, eS); u.uMoonE.value.set(eM * mt[0], eM * mt[1], eM * mt[2]);
      const gl = K_LUM * GLOW_CDM2 * g;
      u.uGlow.value.set(gl * GLOW_TINT[0], gl * GLOW_TINT[1], gl * GLOW_TINT[2]);
      u.uCam.value.set(6360 + Math.max(altKm, 0.002), sdip, 0, 0);
      // Haze thicker than the air mass's own is fog, rain or cloud: it glows grey instead of scattering sunlight.
      const share = clamp(1 - (2 * air.ext) / (sigma * 1000), 0, 1);
      u.uLoc.value.set(sigma * 1000, hazeH / 1000, share, murk);
      u.uApP.value.w = 1 - 0.85 * shade;
      const oc = ENV.uSkyOvc.value, ok = g / this.gain;
      u.uOvc.value.set(oc.r * ok, oc.g * ok, oc.b * ok);
    };
    // The light there is, read from the probe: sets the gain, the overcast's colour and how the tables are mixed.
    const meter = (snap) => {
      skyMeans(means);
      const sinS = Math.max(cel.sun[1], 0), sinM = Math.max(cel.moon[1], 0);
      const down = (means.down[0] + this.sunPhys.r * sinS + this.moonPhys.r * sinM) * 0.25 + (means.down[1] + this.sunPhys.g * sinS + this.moonPhys.g * sinM) * 0.6
        + (means.down[2] + this.sunPhys.b * sinS + this.moonPhys.b * sinM) * 0.15;
      // The light there is to see by: the sky's brightness and the light on the ground, taken together (after
      // sunset the sky is still bright and the land is not; an eye, or a pilot, cares about both).
      // Cloud overhead takes its share, as the old exposure had it.
      const m = Math.sqrt(((means.mean[0] * 0.25 + means.mean[1] * 0.6 + means.mean[2] * 0.15) / M_REF) * (down / DOWN_REF)) * (1 - 0.45 * murk) * (1 - 0.55 * shade);
      const target = Math.log10(Math.max(m, 1e-12));
      this.logM = snap ? target : this.logM + (target - this.logM) * Math.min(1, dt * 0.8);
      this.gain = adaptGain(Math.pow(10, this.logM));
      this.m = m;
      // Overcast: grey, as bright as the light a clear sky would put on level ground allows.
      this.down = down;
      ENV.uSkyOvc.value.setRGB(0.50, 0.53, 0.57).multiplyScalar(OVC_K * down * this.gain * dim * (0.55 + 0.45 * (1 - wx.precip)) / 0.53);
      setSkyMix(this.gain, murk, slot, ENV.uSkyOvc.value);
    };

    if (airKey !== this.airKey || jump) { this.airKey = airKey; u.uAer.value.set(air.ext, air.H, air.albedo, air.g); lut.renderAir(); }
    if (jump) {
      // Once round as a rule. Twice from day into night: a moonless sky drawn at the day's gain underflows a half float.
      for (let i = 0; i < 2; i++) {
        setTables(this.gain); lut.renderSky();
        lut.renderProbe({ gain: this.gain }, true);
        setProbe(lut.data, lut.meta.gain);
        const before = this.gain;
        meter(true);
        if (Math.abs(Math.log(this.gain / before)) < 4) break;
      }
      setTables(this.gain); lut.renderSky(); lut.renderAP();
      this.bakedGain = this.gain;
    } else if (scrub) {
      if (lut.poll(2)) setProbe(lut.data, lut.meta.gain);
      meter(true);
      setTables(this.gain); lut.renderSky(); lut.renderProbe({ gain: this.gain }, false); lut.renderAP();
      this.bakedGain = this.gain;
    } else {
      if (lut.poll()) setProbe(lut.data, lut.meta.gain);
      meter(false);
      // The sun moves a quarter of a degree a minute: the tables are redrawn in turn, one a frame. Both carry
      // the gain of the moment the sky view was drawn; uSkyP.y brings them to the gain of the frame that reads them.
      if (this.frame++ % 2 === 0) { setTables(this.gain); lut.renderSky(); lut.renderProbe({ gain: this.gain }, false); this.bakedGain = this.gain; }
      else { setTables(this.bakedGain); lut.renderAP(); }
    }
    const g = this.gain;
    ENV.uSkyP.value.set(air.g, g / this.bakedGain, murk, night);
    ENV.uAtmSky.value.set(sdip, slot, 0, 0);
    const ap = lut.size.ap;
    ENV.uAtmAP.value.set(ap[2], Math.log(AP_NEAR), 1 / Math.log(lut.apRatio), 0.5 / ap[1]);

    // ---- sun or moon as the scene's light: whichever is the stronger.
    this.sunEng.copy(this.sunPhys).multiplyScalar(g); this.moonEng.copy(this.moonPhys).multiplyScalar(g);
    const moonLight = lum(this.moonEng) > lum(this.sunEng);
    this.lightIsMoon = moonLight;
    const sc = ENV.uSunCol.value.copy(moonLight ? this.moonEng : this.sunEng), dir = moonLight ? this.moonDir : this.trueSun;
    const scl = lum(sc);
    sc.lerp(tmp2.setRGB(scl, scl, scl), 0.2);        // (a fifth of the way to grey, as the old light was: the post-processing's white balance leans on this colour)
    ENV.uSunDir.value.copy(dir);
    if (ENV.uSunDir.value.y < 0.035) { ENV.uSunDir.value.y = 0.035; ENV.uSunDir.value.normalize(); }
    this.skySun.copy(ENV.uSunDir.value);
    ENV.uSkySun.value.copy(dir);
    ENV.uNight.value = night;

    // ---- ambient light from the sky dome itself: first the sky alone, then with the ground's bounce below.
    fitSkyIrradiance(tmp.setRGB(0, 0, 0), AMB_SCALE, AMB_GREY);
    skyIrradiance(0, 1, 0, acc);
    // Ground bounce: a little of the sunlight and skylight coming back up off the land.
    tmp.copy(acc).multiplyScalar(0.3).add(tmp2.copy(sc).multiplyScalar(0.066 * Math.max(dir.y, 0) * (1 - 0.8 * shade)));
    fitSkyIrradiance(tmp.multiplyScalar(1 / AMB_SCALE), AMB_SCALE, AMB_GREY);
    skyIrradiance(0, 1, 0, ENV.uAmbSky.value);
    skyIrradiance(0, -1, 0, ENV.uAmbGround.value);
    ENV.uZenith.value.copy(skyRadiance(0, 1, 0, tmp));
    // Horizon colour for haze: average round the compass, leaving out the bright patch under the sun.
    acc.setRGB(0, 0, 0);
    let brightest = -1; tmp2.setRGB(0, 0, 0);
    for (let k = 0; k < 6; k++) {
      const a = k * 1.0472 + 0.3; skyRadiance(Math.cos(a), 0.05, Math.sin(a), tmp); acc.add(tmp);
      const l = tmp.r + tmp.g + tmp.b; if (l > brightest) { brightest = l; tmp2.copy(tmp); }
    }
    ENV.uFogCol.value.copy(acc).sub(tmp2).multiplyScalar(0.2);
    ENV.uHorizon.value.copy(ENV.uFogCol.value);
    this.uGround.value.setRGB(0.07, 0.08, 0.05).multiply(tmp.copy(sc).multiplyScalar(0.7 * Math.max(dir.y, 0.1) * (1 - 0.8 * shade)).add(ENV.uAmbSky.value));

    // ---- discs, stars and the Milky Way
    const clear = 1 - murk;
    this.uSunDisc.value.copy(this.sunEng).multiplyScalar(clear);
    this.uSunPos.value.copy(this.trueSun);
    if (!opticalDepth(altKm, 1, tau)) tau.fill(0);
    this.uTau.value.set(tau[0], tau[1], tau[2]);
    const m = cel.m;
    this.uToEq.value.set(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);       // the inverse of a rotation is its transpose
    this.uMoonPos.value.copy(this.moonDir);
    v3.set(cel.pole[0], cel.pole[1], cel.pole[2]);
    this.uMoonUp.value.copy(v3).addScaledVector(this.moonDir, -this.moonDir.dot(v3)).normalize();         // celestial north, across the line of sight
    this.uMoonRight.value.crossVectors(this.moonDir, this.uMoonUp.value).normalize();
    // The disc: its true luminance by day (a pale moon in a blue sky); by night held to what the display can show.
    const total = 0.64 * this.exposure, disc = Math.min(K_LUM * MOON_CDM2 * g, DISC_CAP / total) * clear;
    this.uMoonLit.value.setRGB(MOON_TINT[0], MOON_TINT[1], MOON_TINT[2]).multiplyScalar(disc);
    // Earthshine: the dark part lit by a nearly full Earth, a ten-thousandth of the sunlit part and plain to a dark-adapted eye.
    this.uMoonEarth.value.setRGB(0.75, 0.9, 1.1).multiplyScalar(Math.min(K_LUM * MOON_CDM2 * g * 1.4e-4 * cel.earthshine, 0.012 * DISC_CAP / total) * clear);
    const mw = MILKY_GAIN * K_LUM * MILKY_CDM2 * g * clear * clear;
    this.uMilky.value.setRGB(mw, mw, mw);
    if (mw < 1e-4 || !this.stars.milkyReady) this.uMilky.value.setRGB(0, 0, 0);
    this.stars.update(m, K_LUM * g * clear * clear, tau, sdip, ENV.uTime.value, this.renderer.getPixelRatio());

    // ---- eyes (and cameras) adapt: open up as the sky dims, and a little under heavy cloud.
    const target = baseExposure(this.m);
    this.exposure += (target - this.exposure) * Math.min(1, dt * 0.8 + (jump || scrub ? 1 : 0));

    // three.js lights and fog for the standard materials (aircraft, airfield buildings).
    ENV.uFogDensity.value = 1.98 / Math.max(wx.visibility, 300);
    this.fog.color.copy(ENV.uFogCol.value);
    this.fog.density = ENV.uFogDensity.value * 0.8;
    this.sun.color.copy(sc).multiplyScalar(Math.PI * (1 - 0.85 * shade));
    this.sun.position.copy(focus).addScaledVector(ENV.uSunDir.value, 120);
    this.sun.target.position.copy(focus);
    this.hemi.color.copy(ENV.uAmbSky.value).multiplyScalar(Math.PI);
    this.hemi.groundColor.copy(ENV.uAmbGround.value).multiplyScalar(Math.PI);

    // Refresh the reflection environment when the light has changed enough to see.
    this.envT -= dt;
    const key = `${Math.round(e * 1.5)}|${Math.round(this.moonElev)}|${Math.round(hour * 4)}|${Math.round(murk * 12)}|${Math.round(shade * 6)}|${airKey}|${Math.round(Math.log(g) * 6)}|${moonLight}`;
    if (!this.envRT || (key !== this.envKey && (this.envT <= 0 || jump))) {
      this.envKey = key; this.envT = 1.2;
      this.uEnvPass.value = 1;
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 5000);
      this.uEnvPass.value = 0;
      this.envRT?.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
  }
}
