// Traffic: cars and trucks driving the roads near the aircraft.
//
// The city tiles carry the center line of every road they draw, with its class and which way it runs
// (world/citybuild.js, buildRoads). Each piece of road is given vehicles in proportion to its length and to
// how major it is (a freeway carries one every sixty meters or so of roadway at midday, a residential
// street one every kilometer), keeping to the right, at a speed that suits the road. A vehicle is nothing but
// a place on its piece that moves with the clock: where it is this frame is worked out here and written to one
// instanced mesh, a few numbers a vehicle. At the end of its piece (the edge of a quarter of a tile, a junction,
// a bridge, which is built apart) a vehicle starts again at the other end, which from the air reads as the flow
// of the road. There are fewer on the roads at night, and they show their lights.

import * as THREE from 'three';

// By class of road (0 freeway, trunk, primary, secondary, tertiary, 5 minor): meters of lane to a vehicle at
// the busiest hour, speed (m/s), and what share of the vehicles are trucks.
const SPACING = [58, 80, 105, 170, 300, 1000], SPEED = [30, 25, 17, 14.5, 12.5, 8.5], TRUCK = [0.16, 0.12, 0.07, 0.05, 0.03, 0.01];
const MAX = 6000;                          // vehicles drawn at once
// Paint, as sold: mostly white, black, gray and silver.
const PAINT = [[0.74, 0.74, 0.72], [0.74, 0.74, 0.72], [0.035, 0.035, 0.04], [0.035, 0.035, 0.04], [0.2, 0.21, 0.22], [0.2, 0.21, 0.22], [0.46, 0.47, 0.48], [0.46, 0.47, 0.48],
  [0.3, 0.03, 0.03], [0.04, 0.08, 0.24], [0.1, 0.16, 0.3], [0.3, 0.27, 0.2], [0.08, 0.16, 0.1], [0.42, 0.2, 0.06]];
const hash = (a, b) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/** How busy the roads are by the hour, 0..1: quiet before dawn, peaks at eight and at five thirty. */
export function trafficLevel(hour) {
  const bump = (h, w) => Math.exp(-(((hour - h + 36) % 24 - 12) ** 2) / (2 * w * w));
  return Math.min(1, 0.07 + 0.62 * bump(13, 4.2) + 0.42 * bump(8, 1.1) + 0.5 * bump(17.4, 1.4) + 0.14 * bump(21, 1.6));
}

// One vehicle to scale, nose toward +z, standing on y = 0: a body and a cabin. aPart: 0 body, 1 cabin.
function vehicleGeometry() {
  const pos = [], nrm = [], part = [], idx = [];
  const box = (x0, y0, z0, x1, y1, z1, p) => {
    const f = [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0]]];
    for (const q of f) { const b = pos.length / 3; for (let i = 0; i < 4; i++) { pos.push(...q[i]); nrm.push(...q[4]); part.push(p); } idx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
  };
  box(-0.5, 0.18, -0.5, 0.5, 0.56, 0.5, 0);            // unit box: the shader gives it the vehicle's length, width and height
  box(-0.5, 0.56, -0.5, 0.5, 1, 0.5, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1)); g.setIndex(idx);
  return g;
}

// The size of a vehicle by its kind (length, width, height, m): the GLSL of every pass below starts from it.
const SIZE_GLSL = /* glsl */`
vec3 vehicleSize(float kind) { return kind < 0.5 ? vec3(4.5, 1.8, 1.42) : kind < 1.5 ? vec3(4.9, 1.95, 1.75) : kind < 2.5 ? vec3(6.2, 2.1, 2.5) : vec3(15.5, 2.5, 3.9); }`;

const VERT = /* glsl */`
attribute float aPart;
attribute vec4 aP;            // where it stands, relative to the mesh; kind (0 car, 1 tall car or pickup, 2 van, 3 truck) + fade / 2
attribute vec4 aD;            // the way it faces (unit vector); paint, packed
centroid varying vec3 vWorld, vN, vPaint;
centroid varying vec3 vL;     // position in the vehicle: across, up, along (-0.5 .. 0.5, 0 .. 1, -0.5 .. 0.5)
flat varying vec2 vKind;      // kind, part
${SIZE_GLSL}
void main() {
  float kind = floor(aP.w), show = fract(aP.w) * 2.0;
  // length, width, height; where the cabin starts and ends along the body, and how far it is drawn in from the sides
  vec3 size = vehicleSize(kind);
  vec3 p = position;
  if (aPart > 0.5) {
    vec2 cab = kind < 0.5 ? vec2(-0.3, 0.14) : kind < 1.5 ? vec2(-0.42, 0.16) : kind < 2.5 ? vec2(-0.5, 0.36) : vec2(-0.5, 0.33);
    p.z = mix(cab.x, cab.y, p.z + 0.5);
    p.x *= kind < 1.5 ? 0.88 : 1.0;
    if (kind > 2.5 && position.y > 0.9) p.y = 1.0;
  } else if (kind > 2.5 && p.z > 0.33) p.y = min(p.y, 0.5) + (p.y > 0.5 ? 0.22 : 0.0);        // a truck's tractor stands lower than its trailer
  vL = vec3(position.x, p.y, p.z);
  vec3 f = normalize(aD.xyz), r = normalize(vec3(f.z, 0.0, -f.x)), u = cross(f, r);
  vec3 local = vec3(p.x * size.y, p.y * size.z, p.z * size.x) * show;
  vec3 wp = (modelMatrix * vec4(aP.xyz, 1.0)).xyz + r * local.x + u * local.y + f * local.z;
  vWorld = wp; vN = r * normal.x + u * normal.y + f * normal.z;
  float c = aD.w;
  vPaint = vec3(mod(c, 256.0), mod(floor(c / 256.0), 256.0), floor(c / 65536.0)) / 255.0;
  vKind = vec2(kind, aPart);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const frag = (LIGHT_GLSL, ATMO_GLSL) => /* glsl */`
uniform float uLamps;         // 0 by day .. 1 at night: headlights and taillights
centroid varying vec3 vWorld, vN, vPaint;
centroid varying vec3 vL;
flat varying vec2 vKind;
${LIGHT_GLSL}
${ATMO_GLSL}
void main() {
  vec3 N = normalize(vN);
  float kind = vKind.x, cabin = vKind.y;
  vec3 alb = vPaint;
  float gloss = 0.35;
  // glass around the cabin of anything that is not a van or a truck's box; a windshield on those
  bool side = abs(vN.y) < 0.5;
  if (cabin > 0.5 && side && (kind < 1.5 || vL.z > 0.3)) { alb = vec3(0.03, 0.04, 0.05); gloss = 1.0; }
  if (kind > 2.5 && cabin > 0.5 && vL.z < 0.3) alb = vec3(0.62, 0.62, 0.6);                    // a truck's trailer is white, whatever its tractor
  if (cabin < 0.5 && vL.y < 0.26) alb = vec3(0.02);                                             // the shadow under the sills, the tires
  vec2 gLit = terrainLight(vWorld, regionHeight(vWorld.xz));
  float shadow = gLit.x * localShadow(vWorld) * (1.0 - 0.9 * cloudShadow(vWorld));
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 V = normalize(cameraPosition - vWorld), H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 60.0) * gloss * 1.6;
  vec3 col = alb * (uSunCol * ndl * shadow + uAmbSky * (0.55 + 0.45 * N.y) + uAmbGround * (0.5 - 0.5 * N.y)) + uSunCol * spec * shadow * step(0.0, uSunDir.y);
  col += alb * localLight(vWorld, N);
  // lamps: the whole end of the body glows a little, so that a road at night is a string of white and red points
  if (uLamps > 0.0 && cabin < 0.5 && side && abs(vL.z) > 0.49 && vL.y > 0.3) col += (vL.z > 0.0 ? vec3(1.0, 0.92, 0.75) * 3.2 : vec3(1.0, 0.05, 0.02) * 0.9) * uLamps;
  vec4 outc = vec4(applyAtmosphere(col, cameraPosition, vWorld), 1.0);
  if (any(isnan(outc)) || any(isinf(outc)) || !(outc.r + outc.g + outc.b < 1e4)) discard;
  gl_FragColor = outc;
}`;

// The shadow a vehicle throws: a soft-edged dark patch on the road under it, pushed away from the sun by its
// height (the sun's shadow maps do not take in the traffic). Under cloud and at night what is left is the
// darkness under the sills. Blended over the road like the road itself, never written to depth.
const SHADOW_VERT = /* glsl */`
attribute vec4 aP, aD;
uniform vec3 uSunDir;
centroid varying vec3 vWorld;
centroid varying vec2 vQ;
flat varying vec3 vHalf;      // half the patch across and along (m); how much of the vehicle is shown
${SIZE_GLSL}
void main() {
  float kind = floor(aP.w), show = fract(aP.w) * 2.0;
  vec3 size = vehicleSize(kind);
  vec2 fl = aD.xz / max(length(aD.xz), 1e-4);
  vec3 f = vec3(fl.x, 0.0, fl.y), r = vec3(f.z, 0.0, -f.x);
  float up = step(0.03, uSunDir.y);
  vec2 away = -uSunDir.xz / max(uSunDir.y, 0.35) * size.z * 0.4 * up;
  vec2 half2 = vec2(size.y, size.x) * 0.5 + 0.35 + 0.25 * size.z * up;
  vec3 wp = (modelMatrix * vec4(aP.xyz, 1.0)).xyz + vec3(away.x, 0.05, away.y) + r * (position.x * 2.0 * half2.x) + f * (position.z * 2.0 * half2.y);
  vWorld = wp; vQ = position.xz * 2.0; vHalf = vec3(half2, show);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (show < 0.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const shadowFrag = (LIGHT_GLSL) => /* glsl */`
uniform float uLamps;
centroid varying vec3 vWorld;
centroid varying vec2 vQ;
flat varying vec3 vHalf;
${LIGHT_GLSL}
void main() {
  vec2 d = (1.0 - abs(vQ)) * vHalf.xy;                         // meters in from the patch's edge
  float a = smoothstep(0.0, 0.8, min(d.x, d.y));
  float sun = step(0.03, uSunDir.y) * terrainLight(vWorld, regionHeight(vWorld.xz)).x * (1.0 - 0.9 * cloudShadow(vWorld));
  gl_FragColor = vec4(vec3(0.0), a * mix(0.2, 0.58, sun) * vHalf.z * (1.0 - 0.6 * uLamps));
}`;

// Headlamps and tail lamps after dark, as the lamps on the towers are drawn: a soft round spot at each end of a
// vehicle that never shrinks below a pixel or two (it dims instead), so a road reads as a string of white and red
// points from as far off as its vehicles are drawn. Each is seen only from the end it is on. Added to the picture.
const GLOW_VERT = /* glsl */`
attribute vec4 aP, aD;
attribute float aEnd;         // 1 the front, -1 the back
uniform float uLamps, uViewH;
varying vec3 vCol;
varying vec2 vQ;
${SIZE_GLSL}
void main() {
  float kind = floor(aP.w), show = fract(aP.w) * 2.0;
  vec3 size = vehicleSize(kind), f = normalize(aD.xyz + vec3(0.0, 0.0, 1e-5));
  vec3 c = (modelMatrix * vec4(aP.xyz, 1.0)).xyz + f * (aEnd * size.x * 0.5) + vec3(0.0, 0.65, 0.0);
  vec3 toCam = cameraPosition - c;
  float dist = max(length(toCam), 0.5), facing = dot(toCam / dist, f) * aEnd;
  float vis = smoothstep(-0.05, 0.3, facing) * uLamps * show;
  vec4 clip = projectionMatrix * viewMatrix * vec4(c, 1.0);
  float pxm = 2.0 * max(clip.w, 0.1) / (uViewH * projectionMatrix[1][1]);      // meters to a pixel at the lamp
  float lamp = aEnd > 0.0 ? 0.5 : 0.38, rad = max(lamp, 1.6 * pxm);
  vCol = (aEnd > 0.0 ? vec3(1.0, 0.93, 0.78) * 5.0 : vec3(1.0, 0.07, 0.03) * 1.4) * vis * pow(min(1.0, lamp / rad), 1.2);
  vQ = position.xy;
  clip.xy += position.xy * rad * vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
  gl_Position = vis < 0.003 ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}`;
const GLOW_FRAG = /* glsl */`
varying vec3 vCol;
varying vec2 vQ;
void main() {
  float r2 = dot(vQ, vQ);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.5) - 0.03;
  gl_FragColor = vec4(vCol * max(a, 0.0), 0.0);
}`;

export class Traffic {
  /** group: where the mesh goes; glsl: { light, atmo } the lighting code of the city shaders; uniforms: what that code reads. */
  constructor(group, glsl, uniforms) {
    this.uLamps = { value: 0 };
    this.data = new Float32Array(MAX * 8);
    const g = vehicleGeometry(), ib = this.buffer = new THREE.InstancedInterleavedBuffer(this.data, 8);
    ib.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aP', new THREE.InterleavedBufferAttribute(ib, 4, 0)); g.setAttribute('aD', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { ...uniforms, uLamps: this.uLamps }, vertexShader: VERT, fragmentShader: frag(glsl.light, glsl.atmo) }));
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.userData.traffic = true;
    group.add(this.mesh);
    // The same vehicles twice more, from the same numbers: their shadows on the road, and their lamps at night.
    const inst = (geo) => { geo.setAttribute('aP', new THREE.InterleavedBufferAttribute(ib, 4, 0)); geo.setAttribute('aD', new THREE.InterleavedBufferAttribute(ib, 4, 4)); geo.instanceCount = 0; return geo; };
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5], 3)); sg.setIndex([0, 2, 1, 0, 3, 2]);
    this.shadow = new THREE.Mesh(inst(sg), new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uLamps: this.uLamps }, vertexShader: SHADOW_VERT, fragmentShader: shadowFrag(glsl.light), side: THREE.DoubleSide,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12,
    }));
    this.shadow.frustumCulled = false; this.shadow.visible = false; this.shadow.renderOrder = -7;            // (over the roads, which are -8)
    group.add(this.shadow);
    const gg = new THREE.InstancedBufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    gg.setAttribute('aEnd', new THREE.Float32BufferAttribute([1, 1, 1, 1, -1, -1, -1, -1], 1)); gg.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.uViewH = { value: 1080 };
    this.glow = new THREE.Mesh(inst(gg), new THREE.ShaderMaterial({
      uniforms: { uLamps: this.uLamps, uViewH: this.uViewH }, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    }));
    this.glow.frustumCulled = false; this.glow.visible = false; this.glow.renderOrder = 5;
    this.glow.onBeforeRender = (r) => { const rt = r.getRenderTarget(); this.uViewH.value = rt ? rt.height : r.domElement.height; };
    group.add(this.glow);
    this.sets = new Set();                // the pieces of road that have vehicles, a set to a quarter of a tile
    this.enabled = true; this.count = 0;
  }

  /**
   * Put vehicles on the roads of a quarter of a tile. paths: from buildRoads ({ p, m }); x0, z0: the tile's corner in
   * the world; seed: a number of the quarter's own. Returns the set (hand it to remove() when the quarter goes).
   */
  add(paths, x0, z0, seed) {
    const P = paths.p, M = paths.m, cars = [];
    for (let k = 0; k < M.length; k += 5) {
      const start = M[k], n = M[k + 1], cls = M[k + 2] & 7, ramp = M[k + 2] >= 8, one = M[k + 3], hw = M[k + 4];
      const pts = new Float32Array(n * 3), cum = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = (start + i) * 3; pts[i * 3] = P[o] + x0; pts[i * 3 + 1] = P[o + 1]; pts[i * 3 + 2] = P[o + 2] + z0;
        if (i) cum[i] = cum[i - 1] + Math.hypot(P[o] - P[o - 3], P[o + 1] - P[o - 2], P[o + 2] - P[o - 1]);
      }
      const len = cum[n - 1];
      if (len < 12) continue;
      // Lanes: a roadway of a freeway has three, a one-way street two if it is wide; a two-way road one each way, two on the widest.
      const lanes = one ? (cls === 0 && !ramp ? 3 : hw > 4.5 ? 2 : 1) : hw > 5 ? 4 : 2;
      const path = { pts, cum, len, n };
      for (let lane = 0; lane < lanes; lane++) {
        const dir = one || (lane < lanes / 2 ? 1 : -1), h0 = seed * 131 + k * 17 + lane;
        // Across the road, in meters to the right of the line as it is mapped: on a two-way road each keeps to the right
        // of the middle for the way it is going; a roadway's lanes are spread over its width.
        const off = one ? ((lane + 0.5) / lanes - 0.5) * 2 * (hw - 0.9) : (hw * ((lane % (lanes / 2)) + 0.5)) / (lanes / 2) * dir;
        const want = len / (SPACING[cls] * (ramp ? 2 : 1)), count = Math.floor(want) + (hash(h0, 1) < want % 1 ? 1 : 0);
        for (let c = 0; c < count; c++) {
          const h = (i) => hash(h0 * 31 + c, i), truck = h(2) < TRUCK[cls];
          const kind = truck ? 3 : h(3) < 0.5 ? 0 : h(3) < 0.86 ? 1 : 2;
          const paint = truck ? PAINT[(h(4) * 8) | 0] : PAINT[(h(4) * PAINT.length) | 0], shade = 0.85 + 0.3 * h(5);
          cars.push({ path, dir, off, s0: h(6) * len, v: SPEED[cls] * (ramp ? 0.6 : 1) * (0.86 + 0.28 * h(7)) * (truck ? 0.9 : 1) * (1 - 0.06 * lane),
            kind, rank: h(8), col: Math.round(Math.min(255, paint[0] * shade * 255)) + 256 * Math.round(Math.min(255, paint[1] * shade * 255)) + 65536 * Math.round(Math.min(255, paint[2] * shade * 255)) });
        }
      }
    }
    if (!cars.length) return null;
    const set = { cars, on: false };
    this.sets.add(set);
    return set;
  }
  remove(set) { if (set) this.sets.delete(set); }
  clear() { this.sets.clear(); for (const m of [this.mesh, this.shadow, this.glow]) { m.geometry.instanceCount = 0; m.visible = false; } }

  /**
   * Move every vehicle of the sets marked `on` to where it is at `time` (s), and draw those within `far` of the camera
   * (they shrink away over the last third of it). hour: the time of day; night: 0 by day .. 1 in the dark.
   */
  update(time, cam, far, hour, night) {
    const d = this.data, level = trafficLevel(hour), ox = Math.round(cam.x / 512) * 512, oz = Math.round(cam.z / 512) * 512, near = far * 0.66;
    let n = 0;
    if (this.enabled) for (const set of this.sets) {
      if (!set.on) continue;
      for (const c of set.cars) {
        if (c.rank > level || n >= MAX) continue;
        const p = c.path, len = p.len;
        let s = (c.s0 + c.v * time) % len;
        if (c.dir < 0) s = len - s;
        // the segment it is on: a first guess from how far along it is, then a step or two either way
        let i = Math.min(p.n - 2, Math.max(0, ((s / len) * (p.n - 1)) | 0));
        while (i > 0 && p.cum[i] > s) i--;
        while (i < p.n - 2 && p.cum[i + 1] < s) i++;
        const a = i * 3, seg = p.cum[i + 1] - p.cum[i] || 1, t = (s - p.cum[i]) / seg, P = p.pts;
        let dx = P[a + 3] - P[a], dy = P[a + 4] - P[a + 1], dz = P[a + 5] - P[a + 2];
        const x = P[a] + dx * t, y = P[a + 1] + dy * t, z = P[a + 2] + dz * t;
        const dist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
        if (dist > far) continue;
        dx /= seg; dy /= seg; dz /= seg;
        const hl = Math.hypot(dx, dz) || 1, o = n * 8, show = dist < near ? 1 : 1 - (dist - near) / (far - near);
        // (to the right of the way the line runs is +dz, -dx turned a quarter: x across = -dz, z across = dx, for a line running north)
        d[o] = x - (dz / hl) * c.off - ox; d[o + 1] = y; d[o + 2] = z + (dx / hl) * c.off - oz; d[o + 3] = c.kind + Math.min(0.499, show * 0.4995);
        d[o + 4] = dx * c.dir; d[o + 5] = dy * c.dir; d[o + 6] = dz * c.dir; d[o + 7] = c.col;
        n++;
      }
    }
    this.count = n;
    this.uLamps.value = Math.min(1, Math.max(0, (night - 0.15) / 0.35));
    for (const m of [this.mesh, this.shadow, this.glow]) {
      m.visible = n > 0 && (m !== this.glow || this.uLamps.value > 0);
      m.geometry.instanceCount = n;
      if (n) { m.position.set(ox, 0, oz); m.updateMatrixWorld(true); }
    }
    if (!n) return;
    this.buffer.clearUpdateRanges?.(); this.buffer.addUpdateRange?.(0, n * 8); this.buffer.needsUpdate = true;
  }
}
