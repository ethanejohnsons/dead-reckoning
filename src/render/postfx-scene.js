// Depth-aware half of the post stack: the passes that need to know where things
// are, not just what color they came out.
//
//   AO_FRAG       horizon-based ambient occlusion at half resolution
//   SCENE_FRAG    applies the occlusion, mirrors the world in open water, bends the
//                 air behind the exhaust, and writes a motion + depth buffer
//   TAA_FRAG      temporal anti-aliasing (reprojection, variance clip, sharp history)
//   MBLUR_FRAG    camera motion blur that leaves the aircraft alone
//   FOCUS_FRAG    autofocus: a 1x1 target that eases toward what is in the middle
//   TILE_FRAG     widest circle of confusion in each neighborhood
//   DOF_FRAG      depth of field as a scatter-as-gather disk blur at half resolution
//
// Depth is three.js's ordinary 0..1 depth; z everywhere below is meters in front
// of the camera. Positions are kept relative to the camera so nothing depends on
// how far from the world origin the flight has wandered.

const COMMON = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tDepth;
uniform vec4 uProj;            // near, far, tan(half fov x), tan(half fov y)
float linZ(float d) { return uProj.x * uProj.y / (uProj.y - d * (uProj.y - uProj.x)); }
vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uProj.zw * z, -z); }
float zAt(vec2 uv) { return linZ(textureLod(tDepth, uv, 0.0).r); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// Not a number, infinite, or absurd: a pixel some scene shader broke. Left alone it would bloom,
// smear through the history and flash; every pass that reads the raw scene checks for it.
// (on the bits as well: some shader compilers assume there are no such numbers and drop isnan() and isinf())
bool broken(vec3 c) { return any(equal(floatBitsToUint(c) & uvec3(0x7F800000u), uvec3(0x7F800000u))) || any(isnan(c)) || any(isinf(c)) || !(c.r + c.g + c.b < 1.0e5 && c.r + c.g + c.b > -1.0); }
`;

export const AO_FRAG = COMMON + /* glsl */`
uniform vec2 uRes;             // full-resolution size
uniform float uFrame;
in vec2 vUv;
out vec4 outColor;             // r: how much of the sky dome each point can see, g: its distance
// Position of whatever the depth buffer holds at uv. The lookup is snapped to the center of
// its texel: on ground seen at a shallow angle, half a texel of mismatch is meters of height.
vec3 posAt(vec2 uv) {
  ivec2 p = clamp(ivec2(uv * uRes), ivec2(0), ivec2(uRes) - 1);
  return viewPos((vec2(p) + 0.5) / uRes, linZ(texelFetch(tDepth, p, 0).r));
}
void main() {
  ivec2 p0 = clamp(ivec2(vUv * uRes), ivec2(0), ivec2(uRes) - 1);
  float d = texelFetch(tDepth, p0, 0).r;
  if (d >= 0.999999) { outColor = vec4(1.0, 60000.0, 0.0, 1.0); return; }
  float z = linZ(d);
  if (z > 600.0) { outColor = vec4(1.0, min(z, 60000.0), 0.0, 1.0); return; }      // not used beyond this (see where it is applied in SCENE_FRAG): nothing to work out
  vec2 uvc = (vec2(p0) + 0.5) / uRes, t = 1.0 / uRes;
  vec3 P = viewPos(uvc, z);
  // Surface normal from depth, each axis taken across whichever neighbor lies on the same surface.
  vec3 Pl = posAt(uvc - vec2(t.x, 0.0)), Pr = posAt(uvc + vec2(t.x, 0.0)), Pd = posAt(uvc - vec2(0.0, t.y)), Pu = posAt(uvc + vec2(0.0, t.y));
  vec3 dx = abs(Pl.z - P.z) < abs(Pr.z - P.z) ? P - Pl : Pr - P;
  vec3 dy = abs(Pd.z - P.z) < abs(Pu.z - P.z) ? P - Pd : Pu - P;
  vec3 N = normalize(cross(dx, dy) + vec3(0.0, 0.0, 1.0e-9));
  vec3 V = normalize(-P);
  // The radius grows with distance, so it covers the same patch of screen: struts
  // and wing roots up close, a hangar and its apron a few hundred meters off.
  float rW = max(z * 0.09, 0.3);
  float rS = min(rW / (z * 2.0 * uProj.w), 0.16);
  rW = rS * z * 2.0 * uProj.w;
  // The dice are rolled once per pixel and then turned a quarter of the way around each frame, in the order that
  // evens out soonest (0, 2, 1, 3 quarters): any four frames running hold every direction and every step equally.
  // A fresh roll every frame left the temporal filter a slow boil under the aircraft and round buildings, which
  // the eye picks up; what is left now repeats every four frames, too fast to see.
  float fk = mod(uFrame, 4.0), turn = (mod(fk, 2.0) * 2.0 + floor(fk * 0.5)) * 0.25;
  float n1 = fract(ign(gl_FragCoord.xy) + turn), n2 = fract(ign(gl_FragCoord.yx * 1.31 + 17.0) + fract(fk * 0.75));
  vec2 asp = vec2(uRes.y / uRes.x, 1.0);
  float vis = 0.0;
  for (int i = 0; i < AO_SLICES; i++) {
    float phi = (float(i) + n1) * 3.14159265 / float(AO_SLICES);
    vec2 om = vec2(cos(phi), sin(phi));
    vec3 dirV = vec3(om, 0.0);
    vec3 ortho = dirV - dot(dirV, V) * V;
    vec3 axis = normalize(cross(dirV, V) + vec3(1.0e-6, 0.0, 0.0));
    vec3 pN = N - axis * dot(N, axis);
    float pl = max(length(pN), 1.0e-5);
    float n = sign(dot(ortho, pN)) * acos(clamp(dot(pN, V) / pl, 0.0, 1.0));
    // Horizons start on the tangent plane, so a flat surface never shades itself.
    float low0 = cos(n + 1.5707963), low1 = cos(n - 1.5707963), hc0 = low0, hc1 = low1;
    for (int j = 0; j < AO_STEPS; j++) {
      float s = (float(j) + n2) / float(AO_STEPS);
      s = mix(s, s * s, 0.5);
      vec2 o = om * asp * max(rS * s, 1.6 / uRes.y);                      // never the texel we started on
      vec3 h0 = posAt(uvc + o) - P, h1 = posAt(uvc - o) - P;
      float l0 = max(length(h0), 1.0e-6 * z), l1 = max(length(h1), 1.0e-6 * z);
      // Anything further than the radius is somebody else's business: no halo around the aircraft.
      float w0 = clamp(2.0 - 2.0 * l0 / rW, 0.0, 1.0) * step(1.0e-5 * z, l0), w1 = clamp(2.0 - 2.0 * l1 / rW, 0.0, 1.0) * step(1.0e-5 * z, l1);
      hc0 = max(hc0, mix(low0, dot(h0 / l0, V), w0));
      hc1 = max(hc1, mix(low1, dot(h1 / l1, V), w1));
    }
    float a0 = n + clamp(-acos(clamp(hc1, -1.0, 1.0)) - n, -1.5707963, 1.5707963);
    float a1 = n + clamp(acos(clamp(hc0, -1.0, 1.0)) - n, -1.5707963, 1.5707963);
    vis += pl * (2.0 * cos(n) + 2.0 * (a0 + a1) * sin(n) - cos(2.0 * a0 - n) - cos(2.0 * a1 - n)) * 0.25;
  }
  outColor = vec4(clamp(vis / float(AO_SLICES), 0.0, 1.0), min(z, 60000.0), 0.0, 1.0);
}`;

export const SCENE_FRAG = COMMON + /* glsl */`
uniform sampler2D tHdr, tScene, tAO, tCloud, tDetail;
uniform mat3 uCamRot, uCamRotInv;
uniform mat4 uPrevVP;          // last frame's projection * view rotation
uniform vec3 uCamDelta, uCamPos, uSunCol;
uniform mat3 uSubInvRot, uSubDRot;
uniform vec3 uSubInvOff, uSubDOff, uBoxMin, uBoxMax;
uniform vec4 uHeatA[2], uHeatB[2];   // exhaust plume ends: uv, distance, radius (in screen heights)
uniform vec2 uRes;
uniform float uFrame, uTime, uWind, uFog, uAO, uSSR, uHeat, uRough, uRigid;
in vec2 vUv;
layout(location = 0) out vec4 outColor;   // rgb: lit HDR, a: open-sky mask (passed through)
layout(location = 1) out vec4 outVel;     // rg: motion since last frame in uv, b: 1 on the aircraft, a: distance

float edgeFade(vec2 uv) { vec2 e = smoothstep(vec2(0.0), vec2(0.07), uv) * (1.0 - smoothstep(vec2(0.93), vec2(1.0), uv)); return e.x * e.y; }

// Hot exhaust: the air behind the stacks wobbles whatever is seen through it.
vec2 heat(vec2 uv, float z) {
  vec2 off = vec2(0.0), asp = vec2(uRes.x / uRes.y, 1.0);
  for (int i = 0; i < 2; i++) {
    vec4 A = uHeatA[i], B = uHeatB[i];
    if (A.w <= 0.0) continue;
    vec2 pa = (uv - A.xy) * asp, ba = (B.xy - A.xy) * asp;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-8), 0.0, 1.0);
    float rad = mix(A.w, B.w, t), zp = mix(A.z, B.z, t);
    float m = (1.0 - smoothstep(0.25, 1.0, length(pa - ba * t) / rad)) * (1.0 - t) * smoothstep(0.0, 0.1, t) * step(zp, z);
    if (m <= 0.0) continue;
    vec2 q = pa / rad * 0.4;
    vec2 n = texture(tDetail, q + uTime * vec2(0.9, 0.35)).rg + texture(tDetail, q * 2.3 - uTime * vec2(0.6, 1.1)).gr - 1.0;
    off += n * m * rad * 0.55 / asp;
  }
  return off * uHeat;
}

#define MIRROR_TAPS 8
// Open water mirrors what stands over it. The surface is level, so the reflected
// ray is known from the view ray and a rippled normal; walk it across the screen
// against the depth buffer.
vec4 mirror(vec3 Prel, float z) {
  vec3 Vw = normalize(Prel);
  vec2 wp = uCamPos.xz + Prel.xz;
  float wind = clamp(uWind / 14.0, 0.06, 1.0), lakeK = smoothstep(1.0, 4.0, uCamPos.y + Prel.y);
  // The same three wave trains the water shader lights itself with, so the mirror ripples in step.
  const mat2 W1 = mat2(0.89, 0.45, -0.45, 0.89), W2 = mat2(0.75, -0.66, 0.66, 0.75);
  vec2 w1 = (texture(tDetail, W1 * wp / 37.0 + uTime * vec2(0.021, 0.013)).ba - 0.5) * W1;
  vec2 w2 = (texture(tDetail, W2 * wp / 11.0 - uTime * vec2(0.034, 0.027)).ba - 0.5) * W2;
  // Only a little of that swell bends the mirror. Most of what wind does to a reflection is
  // blur it, because the ripples are far smaller than a pixel: every pixel holds facets tilted
  // every way, and shows the long vertical smear of all of them at once. So the ray is walked
  // once, off the mean surface, and the color is the average of what a spread of facets would
  // show (MIRROR_TAPS of them, spaced evenly along the line of sight, where a tilt moves the
  // reflection most). One random facet a pixel each frame, left to the temporal filter to gather,
  // shimmered wherever that filter let go.
  float jit = ign(gl_FragCoord.xy + uFrame * 5.588238), jit2 = ign(gl_FragCoord.yx * 1.7 + uFrame * 7.31 + 5.0);
  vec2 swell = (w1 + w2 * 0.6) * (0.2 + wind) * exp(-z / 3500.0) * (1.0 - 0.45 * lakeK) * 0.12;
  float spread = uRough * (0.03 + 0.16 * wind) * (1.0 - 0.4 * lakeK);
  vec2 along = normalize(Vw.xz + vec2(1e-5)), across = vec2(-along.y, along.x);
  vec3 wn = normalize(vec3(swell.x, 1.0, swell.y));
  vec3 R = reflect(Vw, wn); R.y = abs(R.y) + 0.003; R = normalize(R);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - dot(-Vw, wn), 0.0, 1.0), 5.0);
  if (fres < 0.03) return vec4(0.0);

  vec3 Rv = uCamRotInv * R;
  float L = 90000.0;
  if (Rv.z > 0.0) L = min(L, (z - uProj.x * 2.0) / Rv.z);
  vec3 Pe = viewPos(vUv, z) + Rv * L;
  float z1 = max(-Pe.z, uProj.x);
  vec2 duv = (Pe.xy / (z1 * uProj.zw)) * 0.5 + 0.5 - vUv;
  float tMax = 1.0;
  if (duv.x > 0.0) tMax = min(tMax, (1.0 - vUv.x) / duv.x); else if (duv.x < 0.0) tMax = min(tMax, -vUv.x / duv.x);
  if (duv.y > 0.0) tMax = min(tMax, (1.0 - vUv.y) / duv.y); else if (duv.y < 0.0) tMax = min(tMax, -vUv.y / duv.y);
  float k0 = 1.0 / z, k1 = 1.0 / z1;
  float tPrev = 0.0, tHit = -1.0, zPrev = z;
  for (int i = 0; i < SSR_STEPS; i++) {
    float t = tMax * (float(i) + jit) / float(SSR_STEPS);
    float zr = 1.0 / mix(k0, k1, t), zs = zAt(vUv + duv * t);
    // A hit is a surface the ray crossed during this step. Something much nearer (a strut,
    // the aircraft, a hill in front) only hid the ray from view; it was not struck.
    if (zr - zs > zr * 0.0015 && zs > min(zPrev, zr) - abs(zr - zPrev) * 0.5 - zr * 0.02) { tHit = t; break; }
    tPrev = t; zPrev = zr;
  }
  float rough = mix(1.0, 0.4, smoothstep(5.0, 16.0, uWind) * (1.0 - 0.6 * lakeK));
  vec2 huv = vec2(0.0), suv0 = Rv.z < -0.01 ? (Rv.xy / (-Rv.z * uProj.zw)) * 0.5 + 0.5 : vec2(-1.0);
  if (tHit > 0.0) {
    for (int i = 0; i < 4; i++) {
      float m = 0.5 * (tPrev + tHit);
      if (1.0 / mix(k0, k1, m) > zAt(vUv + duv * m)) tHit = m; else tPrev = m;
    }
    huv = vUv + duv * tHit;
  } else if (suv0.x < 0.0) return vec4(0.0);
  // What the facets show: where each one's reflected ray leaves the picture, as an offset from the mean ray's.
  vec3 acc = vec3(0.0);
  float got = 0.0;
  for (int i = 0; i < MIRROR_TAPS; i++) {
    vec2 f = vec2((float(i) + jit2) / float(MIRROR_TAPS) - 0.5, fract(jit + float(i) * 0.618034) - 0.5) * spread;
    vec2 sl = swell + along * f.x + across * f.y;
    vec3 Ri = reflect(Vw, normalize(vec3(sl.x, 1.0, sl.y))); Ri.y = abs(Ri.y) + 0.003;
    vec3 Rvi = uCamRotInv * normalize(Ri);
    if (Rvi.z > -0.01) continue;
    vec2 s = (Rvi.xy / (-Rvi.z * uProj.zw)) * 0.5 + 0.5;
    if (tHit > 0.0) {
      // (a thing that was struck stands nearer than the sky: its reflection shifts less)
      vec2 q = huv + (suv0.x < 0.0 ? vec2(0.0) : (s - suv0) * 0.7);
      vec3 hit = texture(tHdr, q).rgb;
      if (broken(hit)) continue;
      float e = edgeFade(q) * mix(0.25, 1.0, smoothstep(0.3, 0.7, texture(tScene, q).a));       // water does not mirror water
      acc += hit * e; got += e;
    } else {
      // Nothing in the way. If the sky the ray ends in is in view, mirror that, clouds and all.
      if (s.x <= 0.0 || s.x >= 1.0 || s.y <= 0.0 || s.y >= 1.0 || textureLod(tDepth, s, 0.0).r < 0.999999) continue;
      vec3 hit = texture(tHdr, s).rgb;
      if (broken(hit)) continue;
      float e = edgeFade(s) * 0.85;
      acc += hit * e; got += e;
    }
  }
  return got > 0.0 ? vec4(acc / got, fres * rough * got / float(MIRROR_TAPS)) : vec4(0.0);
}

void main() {
  float d = textureLod(tDepth, vUv, 0.0).r;
  bool sky = d >= 0.999999;
  float z = linZ(d);
  vec3 Prel = uCamRot * viewPos(vUv, z);

  // Where was this point a frame ago? The world stands still; the aircraft carries its own motion.
  vec3 local = uSubInvRot * Prel + uSubInvOff;
  bool sub = !sky && all(greaterThan(local, uBoxMin)) && all(lessThan(local, uBoxMax));
  vec4 clip = uPrevVP * vec4(sub ? uSubDRot * Prel + uSubDOff : Prel + uCamDelta, 1.0);
  vec2 vel = clip.w > 0.0 ? vUv - (clip.xy / clip.w * 0.5 + 0.5) : vec2(0.0);
  // Not told which object is the aircraft: treat whatever is close as riding with the camera.
  if (z < uRigid) { sub = true; vel = vec2(0.0); }
  outVel = vec4(clamp(vel, -1.0, 1.0), sub ? 1.0 : 0.0, sky ? 65000.0 : min(z, 60000.0));

  vec4 c = texture(tHdr, uHeat > 0.0 ? vUv + heat(vUv, z) : vUv);
  if (broken(c.rgb)) {
    // Rebuild a broken pixel from whichever of its four neighbors are sound.
    vec3 acc = vec3(0.0); float n = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 s = texture(tHdr, vUv + vec2(i == 0 ? 1.0 : i == 1 ? -1.0 : 0.0, i == 2 ? 1.0 : i == 3 ? -1.0 : 0.0) / uRes).rgb;
      if (!broken(s)) { acc += s; n += 1.0; }
    }
    c.rgb = n > 0.0 ? acc / n : vec3(0.0);
    if (isnan(c.a) || isinf(c.a)) c.a = 0.0;
  }
  vec3 col = c.rgb;
  if (!sky) {
    float cloudT = texture(tCloud, vUv).a;
    #if AO_ON
    if (uAO > 0.0) {
      // Half-resolution occlusion, taken from the texels that sit on this pixel's surface. Sixteen of them:
      // each was made with a different roll of the dice, and the pattern of those rolls is one that evens out
      // over a small block, so the average is far steadier from frame to frame than any four.
      ivec2 hs = textureSize(tAO, 0);
      vec2 f = vUv * vec2(hs) - 0.5, b = floor(f), fr = f - b;
      float acc = 0.0, ws = 0.0;
      for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
        vec2 a = texelFetch(tAO, clamp(ivec2(b) + ivec2(i, j), ivec2(0), hs - 1), 0).rg;
        vec2 o = vec2(float(i), float(j)) - fr;
        float w = (exp(-0.4 * dot(o, o)) + 0.02) / (0.004 + abs(a.g - z) / z);
        acc += a.r * w; ws += w;
      }
      float ao = acc / ws;
      // Occlusion belongs to the surface, not to the air in front of it: fade it with haze
      // and cloud, where the depth buffer runs out of precision, and in direct sun.
      float fade = exp(-uFog * z) * cloudT * (1.0 - smoothstep(0.02, 0.06, 0.7e-6 * z / uProj.x));
      // And it belongs to what is near. A few hundred meters off, a house is a handful of this pass's texels: the
      // occlusion it found between the houses of a town changed with every step of the camera (measured: the
      // ground and walls it touched flickered half as much again at 500 m, twice as much past a kilometer), as it
      // did on the trees' cards. Out there the land's own baked occlusion and the buildings' own shading stand in.
      fade *= 1.0 - smoothstep(200.0, 600.0, z);
      float lit = smoothstep(0.25, 1.0, luma(col) / (luma(uSunCol) * 0.25 + 0.01));
      // Trees tag their pixels (scene alpha above 1) and are left out: to this pass a forest is thousands of
      // cards at unrelated depths, and what it made of them changed every frame. They carry their own occlusion.
      float tree = clamp((texture(tScene, vUv).a - 1.0) * 12.0, 0.0, 1.0);
      col *= mix(1.0, pow(ao, 1.0 + 0.6 * uAO), clamp(uAO * fade * (1.0 - 0.45 * lit), 0.0, 1.0) * (1.0 - tree));
    }
    #endif
    #if SSR_STEPS > 0
    float water = clamp((1.0 - texture(tScene, vUv).a) / 0.75, 0.0, 1.0);
    if (water > 0.02 && uSSR > 0.0) {
      vec4 m = mirror(Prel, z);
      col = mix(col, m.rgb, clamp(m.a * water * uSSR * cloudT * exp(-uFog * z * 0.5), 0.0, 1.0));
    }
    #endif
  }
  outColor = vec4(col, c.a);
}`;

export const TAA_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tCur, tVel, tHist, tCloud;
uniform vec2 uRes;
uniform vec2 uJitter;           // this frame's sub-pixel offset, pixels
uniform float uBlend, uReset, uPrecip, uSubject;
in vec2 vUv;
out vec4 outColor;
// Work in a compressed range so one bright pixel cannot outvote its neighbors.
vec3 tm(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1.0e-3); }
vec3 hs(vec2 uv) { return tm(texture(tHist, uv).rgb); }
// Catmull-Rom from five bilinear taps: a sharp read of the history, so it does not blur a little more every frame.
vec3 history(vec2 uv) {
  vec2 p = uv * uRes, tc = floor(p - 0.5) + 0.5, f = p - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t0 = (tc - 1.0) / uRes, t3 = (tc + 2.0) / uRes, t12 = (tc + w2 / w12) / uRes;
  vec3 r = hs(vec2(t12.x, t0.y)) * (w12.x * w0.y) + hs(vec2(t0.x, t12.y)) * (w0.x * w12.y) + hs(t12) * (w12.x * w12.y)
    + hs(vec2(t3.x, t12.y)) * (w3.x * w12.y) + hs(vec2(t12.x, t3.y)) * (w12.x * w3.y);
  return max(r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y), 0.0);
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  vec4 cur4 = texelFetch(tCur, px, 0);
  if (uReset > 0.5) { outColor = cur4; return; }
  vec3 cur = tm(cur4.rgb);
  // The nearest surface in the neighborhood decides the motion, so an edge carries its own history.
  vec4 v = texelFetch(tVel, px, 0);
  vec3 m1 = cur, m2 = cur * cur, lo = cur, hi = cur;
  // This frame was drawn a fraction of a pixel off-center. Each neighbor's sample is weighted by how
  // close it really fell to this pixel's center, so a star or a distant lamp smaller than a pixel feeds
  // two or three pixels every frame instead of one pixel on one frame in eight (which twinkles).
  float wf = exp(-2.29 * dot(uJitter, uJitter));
  vec3 flt = cur * wf;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    ivec2 q = clamp(px + ivec2(i, j), ivec2(0), mx);
    vec3 c = tm(texelFetch(tCur, q, 0).rgb);
    vec2 dj = vec2(float(i), float(j)) + uJitter;
    float w = exp(-2.29 * dot(dj, dj));
    flt += c * w; wf += w;
    m1 += c; m2 += c * c; lo = min(lo, c); hi = max(hi, c);
    if (i != 0 && j != 0) { vec4 n = texelFetch(tVel, q, 0); if (n.a < v.a) v = n; }
  }
  vec2 huv = vUv - v.xy;
  // The aircraft seen from inside (uSubject 1) is the one thing looked at closely, and it is drawn with four
  // samples a pixel already. Its history counts for less there, is clipped tighter (needles, cards and digits
  // move inside it, which the reprojection knows nothing of), and the present is taken as drawn instead of
  // smoothed over its neighbors: the panel stays sharp and nothing on it trails.
  float own = v.b * uSubject;
  float keep = 1.0 - max(uBlend, 0.22 * own);
  if (huv.x < 0.0 || huv.y < 0.0 || huv.x > 1.0 || huv.y > 1.0) keep = 0.0;
  vec3 hist = history(huv);
  if (any(isnan(hist)) || any(isinf(hist))) { hist = cur; keep = 0.0; }      // never let a bad pixel live on in the history
  // Clip the history to what the neighborhood looks like now.
  vec3 mu = m1 / 9.0, sg = sqrt(max(m2 / 9.0 - mu * mu, 0.0));
  // A lone bright point (a star, a runway light a few pixels across) is nearly all of its neighborhood's
  // variance. A tight clip would cut its history each time the jitter carries it over a pixel boundary,
  // and it would twinkle. There, open the clip out to everything the neighborhood holds.
  float iso = smoothstep(1.0, 2.0, max(sg.r, max(sg.g, sg.b)) / max(max(mu.r, max(mu.g, mu.b)), 1.0e-4));
  vec3 dv = (hist - mu) / (mix(sg * mix(1.2, 0.85, own), max(hi - mu, mu - lo), iso) + 1.0e-4);
  float ma = max(abs(dv.x), max(abs(dv.y), abs(dv.z)));
  if (ma > 1.0) hist = mu + (hist - mu) / ma;
  // Lean on the present when things move fast, and inside cloud, which keeps its own history.
  keep *= mix(1.0, 0.75, clamp(length(v.xy * uRes) / 24.0, 0.0, 1.0));
  keep *= smoothstep(0.05, 0.6, texture(tCloud, vUv).a);
  // Rain, snow and hail are drawn fresh each frame and are brighter than what was behind
  // them: while they fall, anything that has just brightened is taken at its word.
  keep *= 1.0 - uPrecip * smoothstep(0.004, 0.03, dot(cur - hist, vec3(0.2126, 0.7152, 0.0722)));
  outColor = vec4(itm(mix(mix(cur, flt / wf, clamp(keep / max(1.0 - uBlend, 1.0e-3), 0.0, 1.0) * (1.0 - 0.7 * own)), hist, keep)), cur4.a);
}`;

export const MBLUR_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc, tVel;
uniform vec2 uRes;
uniform float uScale, uMaxPx, uFrame;
in vec2 vUv;
out vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), mx = ivec2(uRes) - 1;
  vec4 c0 = texelFetch(tSrc, px, 0), v0 = texelFetch(tVel, px, 0);
  vec2 v = v0.xy * uScale;
  float len = length(v * uRes);
  // The aircraft is never blurred, by its own motion or by the camera's: from the cockpit a turn of the head
  // would otherwise smear the whole cabin and the panel with it.
  if (len < 0.8 || v0.b > 0.5) { outColor = c0; return; }
  v *= min(1.0, uMaxPx / len); len = min(len, uMaxPx);
  float n = ign(gl_FragCoord.xy + uFrame * 5.588238) - 0.5;
  vec3 acc = c0.rgb; float ws = 1.0;
  for (int i = 0; i < MB_TAPS; i++) {
    float t = (float(i) + 0.5 + n) / float(MB_TAPS) - 0.5;
    vec2 suv = vUv + v * t;
    vec4 vs = texelFetch(tVel, clamp(ivec2(suv * uRes), ivec2(0), mx), 0);
    // A sample belongs in this pixel's streak if its own streak reaches here, or if it
    // lies behind and this pixel's streak sweeps across it. A still aircraft in front does neither.
    float reach = clamp(length(vs.xy * uRes) * uScale * 0.5 - abs(t) * len + 1.0, 0.0, 1.0) * (1.0 - vs.b);
    float behind = clamp((vs.a - v0.a) / (0.04 * v0.a) + 1.0, 0.0, 1.0) * (1.0 - vs.b * (1.0 - v0.b));
    float w = max(reach, behind);
    acc += texture(tSrc, suv).rgb * w; ws += w;
  }
  outColor = vec4(acc / ws, c0.a);
}`;

export const FOCUS_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tVel, tPrev;
uniform float uRate, uAspect;
out vec4 outColor;             // focus distance in dioptres (1/m)
void main() {
  // Nine looks at the middle of the frame; the majority (near or far) decides.
  float far = 0.0, near = 0.0, nf = 0.0;
  for (int i = 0; i < 9; i++) {
    float a = float(i) * 2.399963, r = sqrt(float(i) / 9.0) * 0.05;
    float z = texture(tVel, vec2(0.5) + vec2(cos(a) * r / uAspect, sin(a) * r)).a;
    if (z > 3.0) { far += 1.0 / z; nf += 1.0; } else near += 1.0 / max(z, 0.2);
  }
  float target = nf > 4.5 ? far / nf : near / max(9.0 - nf, 1.0);
  outColor = vec4(mix(texelFetch(tPrev, ivec2(0), 0).r, target, uRate));
}`;

export const TILE_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tVel, tFocus;
uniform vec2 uRes;
uniform float uCoc, uMaxCoc;
in vec2 vUv;
out vec4 outColor;
void main() {
  float f = texelFetch(tFocus, ivec2(0), 0).r, m = 0.0;
  for (int j = -3; j <= 2; j++) for (int i = -3; i <= 2; i++) {
    float z = texture(tVel, vUv + (vec2(float(i), float(j)) + 0.5) * 4.0 / uRes).a;
    m = max(m, min(uCoc * abs(1.0 / z - f), uMaxCoc));
  }
  outColor = vec4(m);
}`;

export const DOF_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tSrc, tVel, tTile, tFocus;
uniform vec2 uRes;
uniform float uCoc, uMaxCoc;
in vec2 vUv;
out vec4 outColor;             // premultiplied: rgb is the blurred light, a how much of the sharp image it replaces
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float R = texture(tTile, vUv).r;
  if (R < 0.6) { outColor = vec4(0.0); return; }
  float f = texelFetch(tFocus, ivec2(0), 0).r;
  float z0 = texture(tVel, vUv).a, c0 = min(uCoc * abs(1.0 / z0 - f), uMaxCoc);
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  vec2 px = 1.0 / uRes;
  bool wide = R > c0 + 1.0;
  vec3 own = vec3(0.0), spill = vec3(0.0);
  float wo = 0.0, wsp = 0.0;
  for (int i = 0; i < DOF_TAPS; i++) {
    float rr = sqrt((float(i) + 0.5) / float(DOF_TAPS)), a = float(i) * 2.399963 + rot;
    vec2 dir = vec2(cos(a), sin(a)) * rr * px;
    // This pixel's own circle. Something sharp in front of it keeps out; everything else is in.
    vec2 u1 = vUv + dir * c0;
    float z1 = texture(tVel, u1).a;
    float w1 = z1 < z0 * 0.97 ? smoothstep(rr * c0 - 1.0, rr * c0 + 1.0, min(uCoc * abs(1.0 / z1 - f), uMaxCoc)) : 1.0;
    own += texture(tSrc, u1).rgb * w1; wo += w1;
    // Out to the widest circle nearby: blurred things in front spill over a sharp background.
    if (wide) {
      vec2 u2 = vUv + dir * R;
      float z2 = texture(tVel, u2).a;
      float w2 = z2 < z0 * 0.97 ? smoothstep(rr * R - 1.0, rr * R + 1.0, min(uCoc * abs(1.0 / z2 - f), uMaxCoc)) : 0.0;
      spill += texture(tSrc, u2).rgb * w2; wsp += w2;
    }
  }
  float ao = smoothstep(0.4, 1.4, c0), cov = clamp(wsp / float(DOF_TAPS) * 1.6, 0.0, 1.0);
  vec3 rgb = (1.0 - cov) * ao * own / max(wo, 1.0e-4) + cov * spill / max(wsp, 1.0e-4);
  outColor = vec4(rgb, 1.0 - (1.0 - cov) * (1.0 - ao));
}`;
