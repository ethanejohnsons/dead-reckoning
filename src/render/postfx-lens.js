// The camera half of the post stack: glass in front of the lens, the lens, the
// sensor and the print.
//
//   GLASS_VERT/FRAG  the cockpit glazing drawn into a target as "where on the glass is this pixel"
//   FINAL_FRAG    rain and frost on that glass, lens distortion and fringing, depth
//                 of field composite, bloom/dirt/streak/halation, light shafts,
//                 flare and veiling glare, exposure, white balance, tone curve, grade
//   OUT_FRAG      FXAA, contrast-adaptive sharpening, grain, dither
//   STREAK_FRAG   horizontal smear of the brightest light (anamorphic streak)
//   makeLensDirt  smudges and dust for bright light to catch on

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

// Water and frost live on the windscreen, not on the screen. In cockpit view the aircraft's
// glazing (the hull shell, cut to the window openings by its mask) is drawn from the pilot's eye
// into a small target that records, per pixel, the position on the glass in metres along and
// around the hull. The final pass builds every drop in those coordinates, so the water stays put
// on the glass when the head turns, and nothing can land on the panel or the posts.
export const GLASS_VERT = /* glsl */`
precision highp float;
uniform mat4 modelViewMatrix, projectionMatrix;
in vec3 position, normal;
in vec2 uv;
out vec2 vHull;
out vec3 vObj;
out float vZ, vNz;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vHull = uv; vObj = position; vZ = -mv.z; vNz = normal.z;
  gl_Position = projectionMatrix * mv;
}`;

export const GLASS_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tMask;       // 1 where the hull is glass
uniform float uBase;           // station of the windscreen's lower edge (m)
in vec2 vHull;
in vec3 vObj;
in float vZ, vNz;
layout(location = 0) out vec4 outGlass;   // xy: metres along the surface (aft +) and round the hull (0 on the roof line), z: distance, signed + on the windscreen; a: how far inside the pane
layout(location = 1) out vec4 outGrad;    // d(xy)/dx, d(xy)/dy: metres of glass per pixel
void main() {
  if (texture(tMask, vHull).g < 0.5) discard;
  // The windscreen leans back, so a metre of hull station is more than a metre of glass.
  float k = 1.0 / sqrt(max(1.0 - vNz * vNz, 0.25));
  vec2 p = vec2((vObj.z - uBase) * k, (vHull.y - 0.5) * 4.0);
  outGlass = vec4(p, vZ * (vNz < -0.25 ? 1.0 : -1.0), textureLod(tMask, vHull, 6.5).g);
  outGrad = vec4(dFdx(p), dFdy(p));
}`;

export const FINAL_VERT = /* glsl */`
precision highp float;
uniform sampler2D tHdr;
uniform vec2 uSun;
uniform float uAspect, uSunOn;
in vec2 position;
out vec2 vUv;
out float vSunVis;
void main() {
  vUv = position * 0.5 + 0.5;
  // How much of the sun's disc is in view: a few taps of the sky mask around it.
  float v = 0.0;
  if (uSunOn > 0.0) {
    for (int i = 0; i < 9; i++) {
      float a = float(i) * 2.399963, r = sqrt(float(i) / 9.0) * 0.012;
      vec2 uv = uSun + vec2(cos(a) / uAspect, sin(a)) * r;
      v += (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) ? 0.0 : textureLod(tHdr, uv, 0.0).a;
    }
    v /= 9.0;
  }
  vSunVis = v * uSunOn;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

export const FINAL_FRAG = /* glsl */`
precision highp float;
precision highp sampler2D;
uniform sampler2D tHdr, tBloom, tWide, tBlur, tDrop, tAvg, tRays, tDof, tVel, tDirt, tStreak, tCloud, tGlass, tGlassD, tDepth;
uniform mat3 uInset, uOutset;
uniform vec3 uSunCol, uWB;
uniform vec2 uSun, uRes;
uniform float uAspect, uTime, uExposure, uBloom, uGlow, uFlash, uRayGain, uFlare, uGlare;
uniform vec2 uNF;             // near, far
uniform float uWet, uGlassOn, uAir, uMist, uIce, uVignette, uChroma, uDistort;
uniform float uDofOn, uDeep, uDirt, uStreak, uHalation, uClarity, uGrade, uMurk;
in vec2 vUv;
in float vSunVis;
out vec4 outColor;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 h22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return vnoise(p) * 0.5 + vnoise(p * 2.03 + 11.0) * 0.25 + vnoise(p * 4.1 + 23.0) * 0.15 + vnoise(p * 8.3 + 37.0) * 0.1; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---- Water on the glass. Coordinates are metres on the glass in a frame whose +y runs downstream.
// Each function returns xy: position inside the drop (-1..1), z: coverage, w: wet trail.

// Beads on a jittered grid. They swell, sit, and are blown along; stretch pulls them into streaks.
vec4 beads(vec2 p, float scale, float amount, float t, float stretch, float slide) {
  vec2 g = p * vec2(scale, scale / stretch);
  float cid = floor(g.x);
  g.y -= t * slide * (0.35 + 1.3 * h11(cid * 7.3 + scale)) / stretch;      // each lane creeps at its own pace
  vec2 id = floor(g), f = fract(g) - 0.5, r = h22(id + scale);
  float on = step(1.0 - amount, h21(id * 1.31 + 3.7));
  float life = fract(t * (0.03 + 0.05 * r.x) + r.y * 7.0);
  float rad = (0.1 + 0.2 * h21(id + 9.1)) * smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.85, 1.0, life));
  vec2 d = f - (r - 0.5) * 0.28;
  float a = atan(d.y, d.x);
  rad *= 1.0 + 0.13 * sin(a * 3.0 + r.x * 20.0) + 0.07 * sin(a * 5.0 + r.y * 13.0);   // no drop is a circle
  vec2 n = d / max(rad, 1.0e-4);
  return vec4(n, (1.0 - smoothstep(0.7, 1.0, length(n))) * on, 0.0);
}

// Rivulets: a fat drop runs along the flow with a stick-slip gait and leaves a wet, beaded track.
vec4 runners(vec2 p, float t, float amount, vec2 cells, float speed) {
  vec2 g = p * cells;
  float cid = floor(g.x), rc = h11(cid * 17.3 + cells.x);
  g.y -= t * speed * (0.5 + 0.9 * rc) + rc * 31.0;
  vec2 id = floor(g), f = fract(g) - 0.5;
  float r = h21(id + cells), on = step(1.0 - amount, h21(id * 1.7 + 5.0));
  float tt = t * (0.8 + speed * 1.3) + r * 6.2832;
  vec2 dp = vec2((r - 0.5) * 0.5 + sin(g.y * 3.1 + r * 6.2832) * 0.09, sin(tt + sin(tt + sin(tt) * 0.5)) * 0.36);
  vec2 cs = vec2(1.0 / cells.x, 1.0 / cells.y);
  vec2 ds = (f - dp) * cs / min(cs.x, cs.y);
  vec2 n = ds * vec2(1.0, 0.62) / 0.24;                                    // the head, a little longer than wide
  float head = 1.0 - smoothstep(0.7, 1.0, length(n));
  // The track lies behind the head (lower y), narrows and dries with distance.
  float behind = 1.0 - smoothstep(-0.02, 0.06, f.y - dp.y), age = clamp((dp.y - f.y) / 0.9, 0.0, 1.0);
  float track = (1.0 - smoothstep(0.03, 0.16 * (1.0 - 0.6 * age), abs(ds.x))) * behind * (1.0 - age);
  // Beads the head sheds along the track.
  vec2 tq = vec2(ds.x + (h11(floor(g.y * 6.0) + cid) - 0.5) * 0.1, (fract(g.y * 6.0) - 0.5) * 1.4) / 0.11;
  float shed = (1.0 - smoothstep(0.7, 1.0, length(tq))) * behind * (1.0 - age) * step(0.4, h21(vec2(floor(g.y * 6.0), cid)));
  return vec4(head > shed ? n : tq, max(head, shed) * on, track * on);
}

// ---- Frost. Each cell of a jittered grid grows one feather: a spine with barbs
// leaving it at sixty degrees, and finer barbs off those. Returns x: ice, y: facet shade.
vec2 feathers(vec2 q, float scale) {
  vec2 g = q * scale, id = floor(g), f = fract(g);
  float best = 9.0; vec2 bc = vec2(0.0), bid = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)), c = o + h22(id + o + scale) - f;
    float d = dot(c, c);
    if (d < best) { best = d; bc = -c; bid = id + o; }
  }
  float a = h21(bid + scale) * 6.2832, sd = 1.0;
  vec2 dir = vec2(cos(a), sin(a));
  float along = dot(bc, dir), across = dot(bc, vec2(-dir.y, dir.x));
  if (across < 0.0) { sd = -1.0; across = -across; }
  float spine = exp(-across * 60.0);
  // Barbs: lines at 60 degrees to the spine, evenly spaced along it, fading outward.
  vec2 bd = vec2(0.5, 0.866);                                             // along the barb, in (along, across)
  float u = along * bd.y - across * bd.x, v = along * bd.x + across * bd.y;   // u: which barb, v: how far out along it
  float k = fract(u * 9.0 + h21(bid) * 3.0) - 0.5;
  float barb = exp(-abs(k) * 22.0) * exp(-across * 3.5);
  // Second order: barbs on the barbs.
  float k2 = fract(v * 26.0 + sd * 0.25) - 0.5;
  float fine = exp(-abs(k2) * 16.0) * exp(-abs(k) * 5.0) * exp(-across * 4.5) * 0.7;
  return vec2(max(spine, max(barb, fine)), h21(bid + 5.0 + sd));
}

vec3 curve(vec3 x) { return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); }

void main() {
  vec2 ac = vec2(uAspect, 1.0);

  // ---- The lens: a little barrel distortion, colour fringes toward the corners.
  vec2 lq = (vUv - 0.5) * ac;
  float r2 = dot(lq, lq), r2c = 0.25 * (uAspect * uAspect + 1.0);
  vec2 uv = 0.5 + (vUv - 0.5) * (1.0 + uDistort * r2) / (1.0 + uDistort * r2c);

  // ---- Rain and frost on the cockpit glass.
  vec4 drop = vec4(0.0);          // xy: position inside the drop as seen on screen, z: coverage
  float mist = 0.0, trail = 0.0, frost = 0.0, ice = 0.0, facet = 0.0;
  vec4 G = uGlassOn > 0.5 ? texture(tGlass, uv) : vec4(0.0);
  if (G.a > 0.0) {
    vec4 D = texture(tGlassD, uv);
    float zg = abs(G.z), det = D.x * D.w - D.y * D.z;
    // Glass shows only where it is the nearest thing: the panel, coaming, posts and compass stand in
    // front of it. Water also keeps clear of the seal round each pane.
    float open = smoothstep(zg - 0.05, zg + 0.03, uNF.x * uNF.y / (uNF.y - texture(tDepth, uv).r * (uNF.y - uNF.x))) * smoothstep(0.5, 0.66, G.a);
    if (open > 0.0 && abs(det) > 1.0e-14) {
      bool ws = G.z > 0.0;
      vec2 p = G.xy;
      mat2 toPx = inverse(mat2(D.xy, D.zw));                             // metres on the glass -> pixels
      float fine = 1.0 - smoothstep(0.0012, 0.003, sqrt(abs(det)));       // drops under a pixel across would only sparkle
      float sd = p.y < 0.0 ? -1.0 : 1.0;
      vec2 dir = vec2(0.0), flow = vec2(0.0, -1.0), q = p;
      if (uWet > 0.004) {
        float amt = clamp(uWet, 0.0, 1.0) * (ws ? 1.0 : 0.55), heavy = smoothstep(0.55, 1.0, uWet);
        // Still air: water beads, creeps and runs down the glass. At speed the airflow takes over:
        // it climbs the windscreen in streaks fanning out from the base, and runs aft on the sides.
        float wind = smoothstep(9.0, 26.0, uAir);
        vec4 b;
        if (wind < 0.97) {
          vec2 ex = ws ? vec2(0.0, 1.0) : vec2(1.0, 0.0), ey = ws ? vec2(-1.0, 0.0) : vec2(0.0, sd);
          vec2 qg = vec2(dot(p, ex), dot(p, ey));
          float a = amt * (1.0 - wind);
          b = beads(qg, 34.0, a * 0.42, uTime, 1.15, 0.03); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * 1.15 * ey; }
          b = beads(qg + 3.3, 70.0, a * 0.5, uTime * 1.2, 1.0, 0.02); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * ey; }
          b = beads(qg + 7.31, 150.0, a * 0.55 * fine, uTime * 1.5, 1.0, 0.0); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * ey; }
          b = runners(qg, uTime, a * 0.6, vec2(60.0, 7.5), 0.22); trail = max(trail, b.w); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * 1.6 * ey; }
          b = runners(qg + 3.17, uTime * 1.2, a * 0.5, vec2(105.0, 12.0), 0.3); trail = max(trail, b.w); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * 1.6 * ey; }
          flow = ey; q = qg;
        }
        if (wind > 0.03) {
          vec2 ex, ey, qw;
          float a = amt * wind;
          if (ws) {
            vec2 rel = p - vec2(-0.3, 0.0); float rr = max(length(rel), 1.0e-3);
            ey = rel / rr; ex = vec2(-ey.y, ey.x); qw = vec2(atan(rel.y, rel.x) * 0.6, rr);
            // The propwash scours a patch low in the middle of the screen nearly dry.
            a *= 1.0 - 0.75 * exp(-dot(p - vec2(0.1, 0.0), p - vec2(0.1, 0.0)) / 0.045);
          } else { ey = normalize(vec2(1.0, 0.16 * sd)); ex = vec2(-ey.y, ey.x); qw = vec2(dot(p, ex), dot(p, ey)); }
          float st = 1.0 + 2.0 * wind, sp = 0.5 + 2.2 * wind;
          b = beads(qw, 34.0, a * 0.4, uTime, st, sp * 0.5); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * st * ey; }
          b = beads(qw + 3.3, 70.0, a * 0.45, uTime * 1.2, st, sp * 0.35); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * st * ey; }
          b = beads(qw + 7.31, 150.0, a * 0.5 * fine, uTime * 1.5, 1.0 + 0.5 * (st - 1.0), sp * 0.2); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * ey; }
          b = runners(qw, uTime, a * 0.7, vec2(60.0, 7.5), 0.25 + sp); trail = max(trail, b.w); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * 1.6 * ey; }
          b = runners(qw + 3.17, uTime * 1.2, a * 0.55, vec2(105.0, 12.0), 0.35 + sp * 1.3); trail = max(trail, b.w); if (b.z > drop.z) { drop = b; dir = b.x * ex + b.y * 1.6 * ey; }
          if (wind > 0.5) { flow = ey; q = qw; }
        }
        // Heavy rain sheets: the whole pane swims before any single drop is seen.
        vec2 sw = vec2(fbm(q * vec2(11.0, 3.2) + vec2(0.0, -uTime * (0.5 + 2.0 * wind))), fbm(q * vec2(11.0, 3.2) + vec2(31.0, -uTime * (0.5 + 2.0 * wind)))) - 0.5;
        uv += sw * 0.02 * heavy * open / ac;
        // What the drop looks like from here: its outline on the glass, turned into screen directions.
        vec2 s = toPx * dir;
        drop.xy = s * (length(drop.xy) / max(length(s), 1.0e-6));
        drop.z *= open; trail *= open;
        mist = (uMist * (1.0 - clamp(max(drop.z, trail) * 1.5, 0.0, 1.0)) + heavy * 0.35) * open;
        uv -= normalize(toPx * flow) * trail * 0.004 * (1.0 - drop.z) / ac;      // a wet track bends the view a touch
      }
      // Frost feathers in from the edge of each pane; the middle is the last to go.
      if (uIce > 0.01) {
        float edge = 1.0 - smoothstep(0.5, 0.97, G.a);
        frost = smoothstep(1.0 - uIce * 1.05 - 0.1, 1.0 - uIce * 1.05 + 0.25, edge + (fbm(p * 9.0) - 0.5) * 0.7) * open;
        if (frost > 0.002) {
          vec2 pw = p + (vec2(vnoise(p * 30.0), vnoise(p * 30.0 + 41.0)) - 0.5) * 0.006;    // nothing in ice grows quite straight
          vec2 f1 = feathers(pw, 16.0), f2 = feathers(pw + 3.7, 38.0);
          // Crystals are dense where the frost is old (the rim) and stand alone at its growing edge.
          ice = clamp(max(f1.x, f2.x * 0.8 * fine) * smoothstep(0.0, 0.5, frost) + smoothstep(0.55, 1.0, frost) * 0.5, 0.0, 1.0);
          facet = mix(f1.y, f2.y, step(f1.x, f2.x * 0.8));
          uv += (vec2(facet, fract(facet * 7.3)) - 0.5) * 0.012 * frost * (0.4 + ice);
        }
      }
    }
  }

  // ---- Colour fringes toward the corners.
  vec3 col;
  #if CHROMA
    vec2 cd = (uv - 0.5) * r2 * uChroma;
    col = vec3(texture(tHdr, uv + cd).r, texture(tHdr, uv).g, texture(tHdr, uv - cd).b);
  #else
    col = texture(tHdr, uv).rgb;
  #endif
  // Depth of field: the blurred layer is premultiplied by how much of the sharp image it replaces.
  if (uDofOn > 0.5) {
    vec2 hp = 0.5 / vec2(textureSize(tDof, 0));
    vec4 dof = 0.25 * (texture(tDof, uv + hp) + texture(tDof, uv - hp) + texture(tDof, uv + vec2(hp.x, -hp.y)) + texture(tDof, uv + vec2(-hp.x, hp.y)));
    col = col * (1.0 - dof.a) + dof.rgb;
  }

  vec3 blur = texture(tBlur, uv).rgb, avg = texture(tAvg, vUv).rgb;
  // A pixel the scene broke (NaN, infinite) is replaced by its surroundings instead of flashing.
  if (any(isnan(col)) || any(isinf(col)) || !(col.r + col.g + col.b < 1.0e5)) col = blur;
  if (mist + frost > 0.003) col = mix(col, blur, clamp(mist + frost * 0.85, 0.0, 1.0));

  // A drop is a tiny wide-angle lens: inside it the whole view hangs upside down,
  // bright sky at the bottom, ringed by a dark rim where the light is thrown clear.
  if (drop.z > 0.001) {
    float l = length(drop.xy);
    vec2 duv = mix(vUv, vec2(0.5), 0.6) - drop.xy * (0.34 + 0.2 * l * l) * vec2(0.75, 1.0);
    vec3 inside = texture(tDrop, clamp(duv, 0.02, 0.98)).rgb;
    // The rim is darkest along the top, where the upside-down ground meets the edge.
    float rim = smoothstep(0.45, 1.0, l) * (0.6 + 0.4 * drop.y / max(l, 0.01));
    float glint = pow(max(1.0 - length(drop.xy - vec2(-0.3, 0.4)) * 4.5, 0.0), 2.0);
    vec3 dc = inside * (1.0 - 0.65 * rim * rim) + avg * 0.05 + texture(tAvg, vec2(0.5, 0.92)).rgb * glint * 1.2;
    col = mix(col, dc, drop.z);
  }

  // ---- Bloom: a share of the picture is replaced by its own blur. In mist, rain and
  // snow the air itself scatters, and every light grows a wide soft halo.
  vec3 bloom = texture(tBloom, uv).rgb, wide = texture(tWide, uv).rgb;
  col = mix(col, bloom, uBloom);
  // Fog and cloud between the lens and the ground do the same to whatever shines through them.
  float murk = uDeep > 0.5 ? (1.0 - texture(tCloud, uv).a) * step(texture(tVel, uv).a, 62000.0) : 0.0;
  col = mix(col, wide, clamp(uGlow + uMurk * murk * (1.0 - 0.6 * murk), 0.0, 0.7));
  // Halation: light that crosses the film and bounces back comes out red, hugging the highlights.
  col += max(blur - col, 0.0) * vec3(1.0, 0.3, 0.08) * uHalation;
  // Dust and smears on the front element catch whatever is bright.
  vec3 dirt = texture(tDirt, vUv).rgb;
  col += max(wide - avg * 1.2, 0.0) * dirt * uDirt;
  col += texture(tStreak, vUv).rgb * vec3(0.55, 0.75, 1.0) * uStreak;

  // ---- Shafts of light and lens flare, both gated by how much sun is actually visible.
  float rays = texture(tRays, vUv).r;
  // Light scattered in the air builds up with distance: nothing close to the lens is veiled by it.
  float airDepth = uDeep > 0.5 ? 1.0 - exp(-texture(tVel, uv).a / 900.0) : 1.0;
  col += uSunCol * rays * rays * uRayGain * airDepth;
  if (vSunVis > 0.002) {
    vec2 sd = (vUv - uSun) * ac, cdir = (vec2(0.5) - uSun) * ac;
    float r = length(sd), ang = atan(sd.y, sd.x);
    // Starburst: diffraction off a seven-bladed iris gives fourteen spikes, no two quite alike.
    float sp = abs(cos(ang * 7.0 + 0.4));
    float star = pow(sp, 90.0) * (0.6 + 0.4 * cos(ang * 3.0 + 1.0)) * exp(-r * 6.0) * 0.5 + pow(abs(cos(ang * 3.5 + 1.3)), 240.0) * exp(-r * 4.2) * 0.25;
    vec3 fl = uSunCol * (star + exp(-r * r * 60.0) * 0.5);
    // Ghosts strung along the line from the sun through the centre of the lens.
    vec2 g1 = sd - cdir * 1.45, g2 = sd - cdir * 1.9, g3 = sd - cdir * 0.55, g4 = sd - cdir * 2.6;
    fl += vec3(0.5, 0.75, 1.0) * (1.0 - smoothstep(0.03, 0.05, length(g1))) * 0.05;
    fl += vec3(1.0, 0.7, 0.4) * (1.0 - smoothstep(0.075, 0.085, length(g2))) * smoothstep(0.02, 0.085, length(g2)) * 0.045;
    fl += vec3(0.6, 1.0, 0.7) * (1.0 - smoothstep(0.0, 0.022, length(g3))) * 0.07;
    fl += vec3(0.8, 0.6, 1.0) * (1.0 - smoothstep(0.1, 0.16, length(g4))) * 0.02;
    float halo = exp(-pow((r - 0.42) * 16.0, 2.0));
    fl += vec3(1.0 + 0.4 * sin(ang * 2.0), 0.9, 0.8 - 0.3 * sin(ang * 2.0)) * halo * 0.02;
    float sunL = dot(uSunCol, vec3(0.3, 0.5, 0.2));
    col += fl * vSunVis * uFlare * sunL;
    // Veiling glare: with the sun in frame, stray light lifts the whole picture and washes the blacks.
    col += uSunCol * vSunVis * uGlare * (0.01 / (1.0 + r * r * 9.0) + dirt * 0.2 / (1.0 + r * r * 30.0));
  }

  if (frost > 0.0) {
    // Ice scatters: a milky veil, with the crystals themselves catching the light.
    col = mix(col, avg * 1.25 + 0.012, frost * (0.35 + 0.4 * ice));
    col += (avg * 1.3 + blur * 0.5 + 0.025) * ice * frost * (0.3 + 0.8 * facet * facet);
  }
  col += vec3(0.7, 0.78, 1.0) * uFlash;

  // ---- Print. Local contrast first, while the light is still linear.
  col *= pow(clamp((luma(col) + 0.002) / (luma(wide) + 0.002), 0.5, 2.0), uClarity);
  // Natural fall-off toward the corners of the frame.
  vec2 vq = (vUv - 0.5) * vec2(1.3, 1.0);
  float vg = 1.0 + dot(vq, vq) * uVignette;
  col /= vg * vg;
  // Exposure, white balance, then the film curve. The curve runs in a slightly
  // narrowed gamut, so bright saturated light rolls off toward white instead of
  // clipping to a pure hue; greys pass through untouched.
  col = max(col * uExposure * uWB, 0.0);
  col = uOutset * curve(uInset * col);
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  // Grade: a touch more contrast and colour, cooler shadows, warmer highlights.
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 1.0 + 0.06 * uGrade);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.12);
  col += (vec3(-0.010, 0.001, 0.014) * (1.0 - l) * (1.0 - l) + vec3(0.012, 0.004, -0.010) * l * l) * uGrade;
  col = clamp(col, 0.0, 1.0);
  outColor = vec4(col, dot(col, vec3(0.299, 0.587, 0.114)));
}`;

export const STREAK_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uStep;            // uv step between taps
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-float(i * i) / 14.0);
    vec3 c = texture(tSrc, vUv + uStep * float(i)).rgb;
    acc += max(c - uThreshold, 0.0) * w; ws += w;
  }
  outColor = vec4(acc / ws, 1.0);
}`;

export const OUT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;        // gamma-space colour, luma in alpha
uniform vec2 uTexel;
uniform float uTime, uGrain, uSharp, uFxaa;
in vec2 vUv;
out vec4 outColor;
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
void main() {
  vec4 m = texture(tSrc, vUv);
  vec3 col = m.rgb;
  // Edges are smoothed here only when the temporal filter is off (uFxaa 1). With it on they arrive already
  // resolved, and smoothing them again would only cost sharpness: everything goes to the sharpening below.
  float lNW = 0.0, lNE = 0.0, lSW = 0.0, lSE = 0.0, lMin = 0.0, lMax = 0.0;
  if (uFxaa > 0.5) {
    lNW = texture(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).a; lNE = texture(tSrc, vUv + vec2(1.0, -1.0) * uTexel).a;
    lSW = texture(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).a; lSE = texture(tSrc, vUv + vec2(1.0, 1.0) * uTexel).a;
    lMin = min(m.a, min(min(lNW, lNE), min(lSW, lSE))); lMax = max(m.a, max(max(lNW, lNE), max(lSW, lSE)));
  }
  if (uFxaa > 0.5 && lMax - lMin > max(0.035, lMax * 0.11)) {
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), -8.0, 8.0) * uTexel;
    vec3 a = 0.5 * (texture(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec4 b4 = 0.5 * (texture(tSrc, vUv - dir * 0.5) + texture(tSrc, vUv + dir * 0.5));
    vec3 b = a * 0.5 + b4.rgb * 0.5;
    float lB = dot(b, vec3(0.299, 0.587, 0.114));
    col = (lB < lMin || lB > lMax) ? a : b;
  } else if (uSharp > 0.0) {
    // Contrast-adaptive sharpening on everything the edge filter left alone: strongest where the picture is
    // smooth and soft, backing off as the local contrast rises, and never past the brightest or darkest of the
    // pixel's neighbours. So an edge gets steeper but grows no halo (fine dial markings do not ring), and a
    // pixel that flickers against its neighbours is not made to flicker harder.
    vec3 n = texture(tSrc, vUv + vec2(0.0, uTexel.y)).rgb, s = texture(tSrc, vUv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb, w = texture(tSrc, vUv - vec2(uTexel.x, 0.0)).rgb;
    vec3 mn = min(col, min(min(n, s), min(e, w))), mx = max(col, max(max(n, s), max(e, w)));
    vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 1.0e-3), 0.0, 1.0);
    amp = mix(amp, sqrt(amp), 0.5);
    vec3 k = -amp * uSharp;
    col = clamp((col + (n + s + e + w) * k) / (1.0 + 4.0 * k), mn, mx);
  }
  // Grain: silver, not pixels. A little coarser than the pixel grid, strongest in the
  // lower mid-tones, nearly gone in clean highlights; then a dither to hide banding in skies.
  vec2 gp = gl_FragCoord.xy + fract(uTime * vec2(7.13, 3.71)) * 311.0;
  float n = 0.4 * h21(gp) + 0.2 * (h21(gp + vec2(1.0, 0.0)) + h21(gp + vec2(0.0, 1.0)) + h21(gp + vec2(1.0, 1.0))), n2 = h21(gl_FragCoord.xy * 1.37 + 91.0);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float resp = (0.35 + 1.5 * sqrt(max(l, 0.0)) * (1.0 - l)) * (1.0 - 0.55 * l * l);
  vec3 tint = vec3(1.0) + (vec3(h21(gp + 13.0), h21(gp + 29.0), h21(gp + 43.0)) - 0.5) * 0.5;
  col += (n - 0.5) * 1.5 * uGrain * resp * tint + (n2 - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;

/** Smudges, dust and a few wiped streaks on the front of the lens. Light only; bright sources pick it out. */
export function makeLensDirt(w = 512, h = 288) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), rnd = mulberry32(90210);
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'lighter';
  const blob = (x, y, r, a, tint) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${tint},${a})`); gr.addColorStop(0.6, `rgba(${tint},${a * 0.45})`); gr.addColorStop(1, `rgba(${tint},0)`);
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  const tint = () => `${200 + Math.round(rnd() * 55)},${200 + Math.round(rnd() * 55)},${200 + Math.round(rnd() * 55)}`;
  for (let i = 0; i < 70; i++) blob(rnd() * w, rnd() * h, 14 + rnd() * 60, 0.02 + rnd() * 0.05, tint());       // greasy smudges
  for (let i = 0; i < 260; i++) blob(rnd() * w, rnd() * h, 2 + rnd() * 7, 0.05 + rnd() * 0.16, tint());        // out-of-focus dust
  for (let i = 0; i < 500; i++) blob(rnd() * w, rnd() * h, 0.6 + rnd() * 1.6, 0.1 + rnd() * 0.3, tint());      // specks
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {                                                                               // wipe marks
    const x = rnd() * w, y = rnd() * h, a = rnd() * 6.283, len = 40 + rnd() * 120;
    g.strokeStyle = `rgba(255,255,255,${0.012 + rnd() * 0.02})`; g.lineWidth = 3 + rnd() * 9;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 30, y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 30, x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}
