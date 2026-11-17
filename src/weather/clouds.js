// Volumetric cloud renderer.
//   1. the scene renders to an HDR target with a depth texture
//   2. the player's aircraft is drawn again on its own (see renderSubject), so
//      the cloud buffer need not have an edge along it; then a ray-march pass
//      (reduced resolution, jittered every frame) integrates cloud, fog and
//      rain shafts along each view ray up to the scene depth.
//      At silhouettes its texels alternate, checkerboard fashion, between the
//      surface in front and the one behind, so both get marched
//   3. a temporal pass reprojects last frame's result (following the wind) and
//      blends the new samples in, which removes the grain of sparse sampling;
//      it only mixes texels that were marched to the same surface
//   4. a resolve pass takes a 3x3 mean where the history has not yet smoothed
//      the sampling pattern away (fresh or flickering texels, and near cloud)
//   5. a composite pass lays the clouds over the scene in HDR at full
//      resolution, taking for each pixel the texels marched to its surface and,
//      on antialiased silhouette pixels, splitting the pixel between the two
//   6. PostFX (bloom, rays, glass, tone mapping) takes it to the screen

import * as THREE from 'three';
import { ENV } from '../core/env.js';
import { WX_N, TEX_ALT, CLOUD_SIGMA, NOISE_SCALE, LOBE_SCALE, FINE_SCALE, LOBE_ROT, FINE_ROT, LOBE_AMP, FINE_AMP, LOBE_WARP, TURRET, CLEFT, FOG_TOP_MARGIN, WARP_SCALE, WARP_AMP, VARY_SCALE, VARY_AMP, MESO_AMP, NOISE_SQUASH, SCUD_CONV, SCUD_LAYER, CELL_RMAX, CELL_R0, CELL_R1 } from './weather.js';
import { NOISE_SIZE, DETAIL_SIZE, CURL_SIZE, makeDetailNoise, makeCurlNoise } from './cloudnoise.js';
import { FullscreenQuad, fsMaterial } from '../render/fullscreen.js';
import { PostFX } from '../render/postfx.js';
import { ATMO_GLSL, ATMO_UNIFORMS } from '../world/atmosphere.js';
import { perf } from '../render/perf.js';

// scale: size of the cloud buffer against the screen   steps: most samples along a ray   kc: how fast strides grow with distance
// light: samples toward the sun (lightTier: which stages of the density they read, lightNear: the same for the
// first two; lightSite: follow the weather map along the way instead of taking it as it is at the sample)
// sky: 0 no samples for sky light (the maps alone), 1 one straight up, 2 two up and one toward the sky opposite the sun
const TIERS = {
  low: { scale: 0.34, steps: 44, kc: 0.1, light: 2, lightTier: 0, lightNear: 0, lightSite: 0, sky: 0, far: 0, bow: 0, alpha: 0.1 },
  med: { scale: 0.5, steps: 80, kc: 0.085, light: 4, lightTier: 1, lightNear: 0, lightSite: 1, sky: 1, far: 1, bow: 1, alpha: 0.075 },
  high: { scale: 0.8, steps: 120, kc: 0.07, light: 6, lightTier: 1, lightNear: 2, lightSite: 1, sky: 2, far: 1, bow: 1, alpha: 0.065 },
  ultra: { scale: 1, steps: 144, kc: 0.06, light: 6, lightTier: 1, lightNear: 2, lightSite: 1, sky: 2, far: 1, bow: 1, alpha: 0.065 },
};

const TKEEP = 1 - 0.5 * (TURRET[0] + TURRET[1]);      // the least a storm tower's radius is multiplied by where a turret bulges out
const m3 = (a) => `mat3(${a.map((v) => v.toFixed(6)).join(', ')})`;

// Where the cloud is: shared by the march and by the test probe (CloudRenderer.probeDensity).
// Weather.density() mirrors getSite() + siteNoise() + cloudDensity() up to the lobe stage (tier 1).
const DENSITY_GLSL = /* glsl */`
uniform sampler2D tWxA, tWxB, tWxC, tCurl;
uniform sampler3D tNoise, tDetail;
uniform vec2 uDriftN, uDriftC, uDriftW, uDriftV, uDriftS, uShear, uAniso;
uniform vec3 uDriftM, uDriftD;
uniform float uWxHalf;
#if FOG
uniform vec4 uFogBank[4];     // fog banks: x, z, radius (m), top (m above sea level)
uniform vec4 uFogAmt;         // how much of each there is now (0: none, or burnt off)
#endif

const float TEX_ALT = ${TEX_ALT.toFixed(1)};
const float SIGMA = ${CLOUD_SIGMA};
const float NS = ${NOISE_SCALE.toFixed(1)}, SQ = ${NOISE_SQUASH.toFixed(3)}, TEXB = ${(NOISE_SCALE / NOISE_SIZE).toFixed(3)};
const float WS = ${WARP_SCALE.toFixed(1)}, WAX = ${WARP_AMP[0].toFixed(1)}, WAZ = ${WARP_AMP[1].toFixed(1)}, VS = ${VARY_SCALE.toFixed(1)}, VA = ${VARY_AMP.toFixed(3)}, MA = ${MESO_AMP.toFixed(3)};
const float LS = ${LOBE_SCALE.toFixed(1)}, TEXL = ${(LOBE_SCALE / DETAIL_SIZE).toFixed(4)}, LW = ${LOBE_WARP.toFixed(1)};
const float FS = ${FINE_SCALE.toFixed(1)}, TEXF = ${(FINE_SCALE / DETAIL_SIZE).toFixed(4)};
const mat3 LROT = ${m3(LOBE_ROT)}, FROT = ${m3(FINE_ROT)};
const float CELL_R0 = ${CELL_R0.toFixed(2)}, CELL_R1 = ${CELL_R1.toFixed(2)};

// What the weather maps say about the air over a point, plus the slow noise that is the same for
// every sample near it (so the light march does not have to look any of it up again).
struct Site {
  float cov, conv, precip, base, wb, top;      // the layer: cover, convective share, rain, base, base lowered by scud under rain, top
  float rho, rhoA, ph, cwb, ctop, cw;          // the storm cell here (see Weather.cellAt): radii from its axis and its anvil's, phase, its own base and top, its say
  vec2 warp; float aged, meso, rough, vary;    // bend of the sampling domain (m), how old this patch of cloud is, clustering at a few km, how knobbly, slow swell in amount
  float lo, hi, alo, ahi;                      // altitudes between which there can be cloud, and a second such band above (an anvil), if alo < ahi
  float fog, ftop;                             // how far inside a fog bank this is (0: outside), and the bank's top (m)
  float fresh;                                 // how much of the layer's cover here is still forming (Weather.M, FORM_TIME): 0 grown .. 1 just come
};
Site getSite(vec3 p) {
  vec2 uv = p.xz / (2.0 * uWxHalf) + 0.5;
  vec4 a = texture(tWxA, uv), b = texture(tWxB, uv);
  #if CELLS
  vec4 c = texture(tWxC, uv);
  #else
  const vec4 c = vec4(CELL_R1 + 0.1, CELL_R1 + 0.1, 0.0, 0.064);      // (no storm cells anywhere: the compiler drops all they would do)
  #endif
  Site s;
  s.cov = a.r; s.conv = a.g; s.precip = a.b; s.base = b.r * TEX_ALT; s.top = b.g * TEX_ALT; s.fresh = b.a;
  // Fog banks are drawn from their own outlines (see fogDensity), not from the weather map: the map can only say
  // "layer cloud with its base at sea level" two kilometers to the texel, which climbs the hillsides and stops at
  // valley mouths. Inside a bank and for a few kilometers around it the map's layer is that stand-in, and is dropped.
  s.fog = 0.0; s.ftop = -1.0e9;
  #if FOG
  float fw = 0.0, ft = 0.0, sup = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 fb = uFogBank[i];
    float fd = distance(p.xz, fb.xy), fa = uFogAmt[i] * (1.0 - smoothstep(0.65 * fb.z, 1.12 * fb.z, fd));
    s.fog = max(s.fog, fa); fw += fa; ft += fa * fb.w;
    sup = max(sup, min(uFogAmt[i] * 4.0, 1.0) * (1.0 - smoothstep(1.3 * fb.z + 3000.0, 1.3 * fb.z + 6000.0, fd)));
  }
  if (fw > 0.0) s.ftop = ft / fw;
  s.cov *= 1.0 - sup;
  #endif
  // Under rain the base hangs lower: in ragged scud under a shower, in shreds of fractus under steady rain.
  float drop = s.precip * mix(${SCUD_LAYER.toFixed(1)}, ${SCUD_CONV.toFixed(1)}, s.conv);
  s.wb = s.base - drop;
  s.rho = c.r; s.rhoA = c.g; s.ph = c.b;
  s.cw = 1.0 - smoothstep(CELL_R0, CELL_R1, min(c.r, c.g));
  s.cwb = c.a * TEX_ALT - drop;
  s.ctop = c.a * TEX_ALT + 2980.0 + 7600.0 * smoothstep(0.0, 0.42, c.b);
  // Where there can be cloud. Round a storm cell that is not its whole depth: beyond the tower
  // the flanking cloud stands no higher than hT (cellCover cannot give more at this distance,
  // whatever the noise), and the anvil keeps to a band under the top. The march strides freely
  // through the clear air in between.
  bool g = s.cov > 0.01 && s.cw < 0.999, k = s.cw > 0.001;
  float cth = s.ctop - s.cwb;
  // (Turrets push the tower's wall out by up to a fifth, see TURRET: the radii here are cellCover's, divided by what is left.)
  float hT = s.rho < ${(0.84 / TKEEP + 0.02).toFixed(3)} ? 1.0 : s.rho < ${(2.1 / TKEEP).toFixed(3)} ? 0.53 * sqrt(1.0 - sqrt((s.rho - ${(0.84 / TKEEP).toFixed(3)}) / ${(1.26 / TKEEP).toFixed(3)})) + 0.02 : 0.0;
  bool tow = k && hT > 0.0, anv = k && hT < 0.7 && s.rhoA < 2.5 && s.ph > 0.3;
  float tTop = s.cwb + hT * cth;
  s.lo = g ? (tow ? min(s.wb, s.cwb) : s.wb) : (tow ? s.cwb : 1.0e9);
  s.hi = g ? (tow ? max(s.top, tTop) : s.top) : (tow ? tTop : -1.0e9);
  s.alo = anv ? s.cwb + (s.rho < ${(1.1 / TKEEP + 0.03).toFixed(3)} ? 0.6 : 0.72) * cth : 1.0e9; s.ahi = anv ? s.ctop : -1.0e9;      // (lower by the tower, where it flares into the anvil)
  if (anv && s.hi >= s.alo) { s.hi = s.ahi; s.alo = 1.0e9; s.ahi = -1.0e9; }           // the two run together
  else if (anv && s.hi < s.lo) { s.lo = s.alo; s.hi = s.ahi; s.alo = 1.0e9; s.ahi = -1.0e9; }
  s.warp = vec2(0.0); s.aged = 0.5; s.meso = 0.5; s.rough = 0.5; s.vary = 0.0;
  return s;
}
// The scales above the base noise. Bend the sampling domain with a slow, smooth field at a scale
// that shares no period with the noise tiles, so cells shear, stretch and merge instead of sitting
// side by side (it moves a sample by up to 850 m but changes by no more than a fifth of a meter per
// meter: shapes lean and stretch, they are never turned or folded. Eddies used to stir the domain as
// well, at half a meter per meter, and what they drew was hooks and curls no convective cloud has);
// let the amount of cloud swell and thin in clusters a few kilometers across (meso)
// and again over tens of kilometers (vary), so a field has a few large clouds, many small ones and
// clear lanes, and the tile never repeats visibly; and let some clouds be knobbly and others smooth.
void siteNoise(inout Site s, vec3 p) {
  vec4 wv = textureLod(tNoise, (p + vec3(uDriftW.x, 0.0, uDriftW.y)) / WS, 0.0);
  s.warp = (wv.ba - 0.5) * vec2(WAX, WAZ); s.aged = wv.g; s.meso = wv.r;
  vec4 vv = textureLod(tNoise, (p + vec3(uDriftV.x, 0.0, uDriftV.y)).xzy / VS, 0.0);
  s.vary = (vv.a - 0.5) * 0.6 + (vv.r - 0.5) * 0.4; s.rough = vv.g;
}
// The site a fraction k of the way from a to b (the slow noise stays a's).
Site mixSite(Site a, Site b, float k) {
  Site s = a;
  s.cov = mix(a.cov, b.cov, k); s.conv = mix(a.conv, b.conv, k); s.precip = mix(a.precip, b.precip, k);
  s.base = mix(a.base, b.base, k); s.wb = mix(a.wb, b.wb, k); s.top = mix(a.top, b.top, k);
  s.rho = mix(a.rho, b.rho, k); s.rhoA = mix(a.rhoA, b.rhoA, k); s.ph = mix(a.ph, b.ph, k);
  s.cwb = mix(a.cwb, b.cwb, k); s.ctop = mix(a.ctop, b.ctop, k); s.cw = mix(a.cw, b.cw, k);
  s.fog = mix(a.fog, b.fog, k); s.ftop = a.fog > 0.0 ? (b.fog > 0.0 ? mix(a.ftop, b.ftop, k) : a.ftop) : b.ftop;
  s.fresh = mix(a.fresh, b.fresh, k);
  return s;
}

// How much of the sky a storm cell fills at height fraction hc of its depth, rho cell radii from its
// axis (twin of cellCover() in weather.js, which explains the shape). anv: how far this is anvil, not
// tower; und: how far it is the anvil's underside.
float cellCover(float rho, float rhoA, float hc, float ph, float skirt, float tall, out float anv, out float und) {
  float grow = smoothstep(0.0, 0.25, ph), fade = 1.0 - smoothstep(0.8, 1.0, ph), an = smoothstep(0.3, 0.5, ph) * (1.0 - smoothstep(0.93, 1.0, ph));
  float lw = 1.0 - smoothstep(0.0, 0.32 * tall, hc), low = lw * lw, cap = smoothstep(mix(0.72, 0.9, an), 1.0, hc);
  float taper = smoothstep(0.25, 0.85, hc) * (1.0 - an), flare = an * smoothstep(0.6, 0.86, hc);
  float rin = mix(0.56 - 0.12 * taper + 0.12 * flare, 0.7 * skirt, low) * (1.0 - cap), rout = mix(0.84 - 0.22 * taper + 0.26 * flare, 1.45 * skirt, low) * (1.0 - 0.8 * cap);
  float k = (1.0 - smoothstep(rin, rout, rho)) * grow * fade;
  float e = smoothstep(0.3, 2.4, rhoA), lo = 0.79 + 0.11 * e, up = 0.95 - 0.03 * e;
  float ka = an * smoothstep(lo - 0.03, lo + 0.03, hc) * (1.0 - smoothstep(up - 0.035, up + 0.015, hc)) * (1.0 - smoothstep(1.1, 2.5, rhoA));
  anv = clamp((ka - k) * 4.0, 0.0, 1.0);
  und = 1.0 - smoothstep(lo + 0.01, lo + 0.07, hc);
  return max(k, ka);
}

// Cloud extinction (1/m).
//   s     the site (weather and slow noise) the sample belongs to
//   fp    sample footprint in meters (pixel size at this distance); picks mip levels
//   tier  -1: probe (returns > 0 where cloud is possible)  0: shape, the lobes' average
//         1: + lobes down to 60 m (what Weather.density() returns)    2: + fine detail down to a few meters
// The cloud is where a noise field stands above a threshold field. The threshold is the design:
// it says how much of the sky is filled at each height (a dome over every cell of the noise for
// cumulus, a slab with a rolling top for layer cloud, a tower, shoulders and anvil around a storm
// cell); the noise says where. The noise is a ladder of octaves a factor of two apart, each about
// 0.6 of the one above: 3.2 km to 400 m in the base volume (clusters and lanes come from the slower
// fields in the site), 460 to 57 m and then 34 to 4 m from the lobe volume read at two scales and
// rotations. The lobe octaves push the surface out and in around the threshold, as billows (round
// heads, plain creases) where the cloud is growing and as wisps (ragged shreds) where it is old,
// layered, anvil or scud; and the density climbs from that surface inward, crisply where growing.
// They are only looked up near the surface: deep inside, the answer is "solid" whatever they say.
float gDetail = 0.0, gPix = 0.0;                           // set by the march, see main(): smallest detail worth sampling (m), and the size of a pixel out there (m)
float gCrease = 0.0, gAnvil = 0.0, gH = 0.0, gFog = 0.0;   // left for whoever asks: how deep a crease between lobes this is (0: the crown of a lobe; the probe reports it, the lighting no longer reads it), anvil share, height fraction, fog share
float layerDensity(vec3 p, Site s, float fp, int tier) {
  float lod = clamp(log2(fp / TEXB), 0.0, 6.0);
  float thick = max(s.top - s.wb, 1.0), h = (p.y - s.wb) / thick;
  float cthick = max(s.ctop - s.cwb, 1.0), hc = (p.y - s.cwb) / cthick;
  bool inG = s.cov > 0.01 && h > 0.0 && h < 1.0, inC = s.cw > 0.001 && hc > 0.0 && hc < 1.0;
  if (!inG && !inC) return tier < 0 ? -1.0 : 0.0;
  float cv = smoothstep(0.1, 0.5, s.conv);
  float hh = mix(clamp(h, 0.0, 1.0), clamp(hc, 0.0, 1.0), s.cw), cve = max(cv, s.cw);
  float hm = mix(clamp(h, 0.0, 1.0) * thick, clamp(hc, 0.0, 1.0) * cthick, s.cw);       // meters above the base
  // Towers lean downwind as they rise.
  vec3 q = p;
  q.xz += uShear * (hh * hh * mix(thick, cthick, s.cw) * 0.2 * mix(s.conv, 1.0, s.cw)) + s.warp;
  vec4 nz = textureLod(tNoise, (vec3(q.x, q.y * SQ, q.z) + vec3(uDriftN.x, 0.0, uDriftN.y)) / NS, lod);
  float n = nz.r;
  float thG = 2.0, deep = 0.0, topz = 0.0, scud = 0.0;
  if (inG) {
    float ce = clamp(s.cov * (1.0 + 0.3 * cv) * (1.0 + VA * s.vary * mix(0.3, 1.0, cv)) * (1.0 + MA * (s.meso - 0.5) * cv), 0.0, 1.0);
    float rag = (s.base - s.wb) / thick;
    scud = (1.0 - smoothstep(0.6 * rag, rag + 0.004, h)) * step(0.0005, rag);
    deep = smoothstep(5000.0, 8000.0, thick);
    // Cumulus: a flat base, and a dome over each cell of the noise, taller the stronger the cell.
    float tC = (0.12 + ce) * h * h + 0.05 * (1.0 - smoothstep(0.0, 200.0, h * thick)) - 0.45 * deep * smoothstep(0.76, 0.9, h) * (1.0 - smoothstep(0.95, 1.0, h)) + 1.0 - smoothstep(0.0, 0.035 + rag * 1.6, h);
    // Layer cloud: a slab whose top rolls over a few hundred meters, in sheets where it is deep.
    float zt = clamp(450.0 / thick, 0.06, 0.5), zb = clamp(110.0 / thick, 0.02, 0.2) + rag * 1.3;
    float tS = smoothstep(1.0 - zt, 1.0, h) + 1.0 - smoothstep(0.0, zb, h) + 0.3 * smoothstep(2000.0, 4000.0, thick) * (0.5 - 0.5 * cos(h * thick * 0.0037));
    // The top of a layer is a pavement of cells, each a low dome, with narrow clefts between them; half of
    // the cells are drawn out into rolls along the wind (the cell noise read stretched four to one).
    topz = (1.0 - cv) * smoothstep(1.0 - 2.2 * zt, 1.0 - zt, h) * (1.0 - s.cw);
    if (topz > 0.02) {
      vec2 f = vec2(dot(p.xz, uAniso), dot(p.xz, vec2(-uAniso.y, uAniso.x))) + uDriftS;
      float cleft = 1.0 - mix(nz.g, textureLod(tNoise, vec3(f.x / 29200.0, p.y / 7300.0, f.y / 7300.0), max(lod - 0.8, 0.0)).g, 0.5);
      tS += topz * ${CLEFT} * (cleft * cleft - 0.3);
    }
    thG = 1.0 - ce + mix(tS, tC, cv);
  }
  float thC = 2.0, anv = 0.0, und = 0.0;
  if (inC) {
    // (The flanking towers stand taller in some places than others: the slow channel of the noise stretches their height.)
    // Turrets: the tower's wall is pushed out and in by the slowest octaves of the noise (bulges of 6 to 3 km) and by its
    // cells (1.6 km to 400 m), so the tower is one solid body with towers of every size standing out of it.
    float rho = s.rho * (1.0 - ${TURRET[0]} * (nz.a - 0.5) - ${TURRET[1]} * (nz.g - 0.5));
    float k = cellCover(rho, s.rhoA, hc, s.ph, 1.0 + 0.9 * s.vary, 1.0 + 1.3 * (nz.a - 0.5), anv, und);
    thC = (1.0 - k) * 1.35 + 1.0 - smoothstep(0.0, 0.03 + (s.base - s.wb) / cthick * 1.6, hc);
  }
  float th = mix(thG, thC, s.cw);
  float fd = max(fp, gDetail);
  und *= anv;
  #if CELLS
  if (anv > 0.0) {
    // An anvil is a smooth sheet, not a heap, combed out along the wind into fibers at two widths;
    // on its underside the fibers give way to mammatus, pouches a few hundred meters across hanging in patches.
    vec2 f = vec2(dot(p.xz, uAniso), dot(p.xz, vec2(-uAniso.y, uAniso.x))) + uDriftS;
    float streak = textureLod(tNoise, vec3(f.x / 14600.0, p.y / 7300.0, f.y / 1825.0), clamp(log2(fd / 14.0), 0.0, 6.0)).b;
    float fib = textureLod(tDetail, vec3(f.x / 3650.0, p.y / 1825.0, f.y / 608.3333), clamp(log2(fd / 4.8), 0.0, 7.0)).b;
    float na = 0.5 + (n - 0.5) * 0.3 + ((streak - 0.5) * 0.5 + (fib - 0.5) * 0.2) * (1.0 - 0.9 * und);
    if (und > 0.01) {
      float mam = textureLod(tDetail, vec3(q.x + uDriftN.x, 950.0, q.z + uDriftN.y) / 3175.0, clamp(log2(fd / 25.0), 0.0, 7.0)).r;
      na += (mam - 0.5) * 0.34 * und * smoothstep(0.45, 0.7, s.aged) * (1.0 - smoothstep(1.3, 2.1, s.rhoA));
    }
    n = mix(n, na, anv);
  }
  #endif
  // Lobes. The threshold is where the cloud's surface lies on average; the lobe octaves push it out
  // and cut it in around that, by up to eL (460 to 57 m) and eF (34 to 4 m) in units of the noise.
  // Old cloud frays; anvils and fog stay smoother, and so does the underside of layer cloud.
  float soft = smoothstep(0.55, 0.9, s.aged);
  // How far the lobes are wisps instead of billows.
  float tw = mix(mix(0.7 - 0.45 * topz, 0.06 + 0.8 * soft * (1.0 - 0.8 * s.cw) + 0.45 * (1.0 - smoothstep(0.0, 160.0, hm)), cve), 1.0, max(anv * (1.0 - und), scud));
  tw = clamp(mix(tw, 0.0, und), 0.0, 1.0);
  // Cloud that is still forming (not a storm cell: those grow up by their own stages) starts as wisps, a soft and thin
  // haze of them, and fills out into its finished shape: it does not appear whole where the sky was clear.
  float form = s.fresh * (1.0 - s.cw);
  tw = mix(tw, 1.0, 0.75 * form);
  float topw = mix(0.35, 1.0, max(smoothstep(0.0, 250.0, hm), cve)) * (1.0 - 0.55 * deep * (1.0 - s.cw) * smoothstep(0.7, 0.9, hh)) * (1.0 - 0.5 * anv);
  float eL = mix(${LOBE_AMP[0]}, ${LOBE_AMP[1]}, cve) * topw * mix(0.6, 1.35, s.rough) * (1.0 + 0.35 * tw) * (1.0 - 0.1 * s.cw) * (1.0 - 0.7 * und), eF = ${FINE_AMP} * eL;
  // What a lobe octave takes away, 0..1, from its value v. A billow is a round head: what it takes away
  // grows as the square of the distance from the head's middle, so heads are domes and meet in plain
  // V-shaped creases. (The volume's values are spread evenly, which makes the shortfall b go as the cube
  // of that distance: the dome is b to the power 2/3, 0.61 on average. Its square, as this was, is the
  // sixth power: a flat-topped boulder with a slot around it, and every slot dark.) A wisp leaves only
  // its shreds (0.70 on average). The threshold is moved by that average, so the cloud's surface lies
  // where the design put it whether or not the octaves are resolved.
  float cutAvg = mix(0.61, 0.70, tw);
  float y = n - th + cutAvg * (eL + eF);
  // Probe: is there possibly cloud near here? Before any lobe is cut in, and biased toward yes.
  if (tier < 0) return y + 0.04 + 0.05 * lod;
  if (y <= 0.0) return 0.0;
  // Density climbs from the surface inward, and how quickly is most of what tells a growing cloud from
  // a dying one: within about ten meters on the crown of a young turret (a hard edge), over thirty on
  // its lower flanks, over a hundred wherever the cloud is old (a ragged, translucent fringe),
  // over a couple of hundred where it is layered or anvil. Never thinner than two or three pixels:
  // a far cloud has no hard outline against the sky.
  float crisp = cve * smoothstep(0.0, 160.0, hm) * (1.0 - anv) * (1.0 - 0.6 * tw);
  float young = (1.0 - soft) * mix(0.75 + 0.25 * smoothstep(0.15, 0.7, hh), 1.0, s.cw);
  float edge = mix(mix(0.14, 0.03, smoothstep(0.45, 0.85, hh) * (1.0 - anv)), mix(0.08, 0.009, young), crisp);   // (the top of a layer is sharp too, under its inversion)
  edge = max(edge * (1.0 + 0.6 * lod) * (1.0 + 6.0 * form), gPix * 0.0028);
  // The lobes matter only within their reach of the surface.
  bool skin = y < eL + eF + edge;
  float cutL = cutAvg, cutF = cutAvg;
  if (tier > 0 && skin) {
    float lodL = log2(fd / TEXL);
    if (lodL < 5.5) {
      // (The lookup is bent by the other channels of the base noise, so the lobes are of uneven size, not packed bubbles.)
      vec4 d = textureLod(tDetail, (LROT * (q + (nz.bga - 0.5) * vec3(LW, 0.4 * LW, -LW)) + uDriftM) / LS, max(lodL, 0.0));
      float b = 1.0 - mix(d.r, d.g, 0.36 * (1.0 - und)), w = mix(d.b, d.a, 0.42);
      cutL = mix(pow(b, 0.6667), 1.0 - w * w, tw);
    }
  }
  y -= eL * cutL;
  if (y <= 0.0) return 0.0;
  if (tier > 1 && skin) {
    float lodF = log2(fd / TEXF);
    if (lodF < 4.6) {
      // Fine detail: the same volume a thirteenth the size, turned so it lines up with nothing above it.
      vec4 d = textureLod(tDetail, (FROT * q + uDriftD) / FS, max(lodF, 0.0));
      float b = 1.0 - mix(d.r, d.g, 0.36), w = mix(d.b, d.a, 0.42);
      cutF = mix(pow(b, 0.6667), 1.0 - w * w, tw);
    }
  }
  y -= eF * cutF;
  if (y <= 0.0) return 0.0;
  gCrease = clamp((eL * cutL + eF * cutF) / max(eL + eF, 0.001), 0.0, 1.0); gAnvil = anv; gH = hh;
  float x = min(y / edge, 1.0);
  x *= 0.3 + 0.7 * x;                                          // (thin at first: the outermost of the fringe is haze, not wall)
  return x * SIGMA * mix(0.75, 1.35, cve) * mix(1.0, 0.8 + 0.45 * hh, cve) * (1.0 - 0.7 * anv) * (1.0 - 0.7 * form);
}

// Fog: a bank standing on the ground and the water, as deep as its top allows, so valleys and lakes fill and
// the hills stand out of it. The top rolls gently (sheets a hundred meters deep, a kilometer or two across) and
// frays into wisps; under it the fog is thick everywhere, in denser and thinner patches a few hundred meters
// across (visibility from about 150 m to 400 m); toward the edge of the bank it breaks up.
float fogDensity(vec3 p, Site s, float fp, int tier) {
  float dy = s.ftop - p.y;
  if (s.fog < 0.02 || dy < -${FOG_TOP_MARGIN.toFixed(1)}) return tier < 0 ? -1.0 : 0.0;
  if (tier < 0) return 1.0;
  vec3 q = vec3(p.x + s.warp.x, p.y * 4.0, p.z + s.warp.y);
  vec4 nz = textureLod(tNoise, (q + vec3(uDriftN.x, 0.0, uDriftN.y)) / ${(NOISE_SCALE / 2).toFixed(1)}, clamp(log2(fp / ${(NOISE_SCALE / 2 / NOISE_SIZE).toFixed(2)}), 0.0, 6.0));
  float y = min((dy + (nz.r - 0.5) * 90.0 + s.vary * 50.0) / 45.0, (nz.a * 0.6 + nz.r * 0.4 - 1.0 + 1.35 * s.fog) / 0.12);
  if (y <= 0.0) return 0.0;
  if (tier > 0 && y < 1.6) {
    float lodL = log2(max(fp, gDetail) / TEXL);
    if (lodL < 5.5) {
      vec4 d = textureLod(tDetail, (LROT * vec3(q.x, p.y * 1.5, q.z) + uDriftM) / LS, max(lodL, 0.0));
      float w = mix(d.b, d.a, 0.4);
      y += 0.9 * (w * w - 0.3333);
    }
  }
  gFog = 1.0;
  return clamp(y, 0.0, 1.0) * (0.37 + 0.63 * smoothstep(0.15, 0.8, nz.g)) * SIGMA * 0.87;
}

float cloudDensity(vec3 p, Site s, float fp, int tier) {
  gCrease = 0.0; gAnvil = 0.0; gH = 0.0; gFog = 0.0;
  float d = layerDensity(p, s, fp, tier);
  #if FOG
  float f = fogDensity(p, s, fp, tier);
  d = tier < 0 ? max(d, f) : d + f;
  #endif
  return d;
}
`;

// Ground shadows that follow the clouds drawn here. For a terrain shader: it must already declare
// tWxA, tWxB, uWxHalf and uSunDir, and must be given the uniforms listed in CLOUD_SHADOW_UNIFORMS,
// which this renderer keeps in ENV. cloudShadowDepth(p) is the optical depth of the cloud between
// the ground point p and the sun: three samples of the cloud's shape (without its lobes) through
// the depth of the layer the sun's ray crosses, and one more through a storm's anvil. A shadow
// term is then, say, od / (od + 1.5).
export const CLOUD_SHADOW_UNIFORMS = ['tWxC', 'tCloudNoise', 'tCloudDetail', 'tCloudCurl', 'uCloudDriftN', 'uCloudDriftM', 'uCloudDriftD', 'uCloudDriftC', 'uCloudDriftW', 'uCloudDriftV', 'uCloudDriftS', 'uCloudShear', 'uCloudAniso', 'uCloudCells', 'uCloudFogBank', 'uCloudFogAmt'];
// The holders exist from the moment this module loads, so a terrain shader built before the renderer has them.
for (const k of CLOUD_SHADOW_UNIFORMS) {
  if (k === 'uCloudFogBank') ENV[k] = { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, -1e5)) };
  else if (k === 'uCloudFogAmt') ENV[k] = { value: new THREE.Vector4() };
  else if (!ENV[k]) ENV[k] = { value: k[0] === 't' ? null : k === 'uCloudCells' ? 0 : new THREE.Vector2(k === 'uCloudAniso' || k === 'uCloudShear' ? 1 : 0, 0) };
}
export const CLOUD_SHADOW_GLSL = '#define CELLS 1\n#define FOG 1\n' + DENSITY_GLSL
  .replace('uniform sampler2D tWxA, tWxB, tWxC, tCurl;', 'uniform sampler2D tWxC, tCloudCurl;')
  .replace('uniform sampler3D tNoise, tDetail;', 'uniform sampler3D tCloudNoise, tCloudDetail;')
  .replace('uniform float uWxHalf;', '')
  .replace(/\btNoise\b/g, 'tCloudNoise').replace(/\btDetail\b/g, 'tCloudDetail').replace(/\btCurl\b/g, 'tCloudCurl')
  .replace(/\buDrift([NMDCWVS])\b/g, 'uCloudDrift$1').replace(/\buShear\b/g, 'uCloudShear').replace(/\buAniso\b/g, 'uCloudAniso').replace(/\buFog(Bank|Amt)\b/g, 'uCloudFog$1') + /* glsl */`
uniform float uCloudCells;                                  // 1 while there are storm cells
float cloudShadowDepth(vec3 p) {
  vec3 L = uSunDir / max(uSunDir.y, 0.12);                 // along the sun's ray, one meter up per unit
  float od = 0.0;
  Site a = getSite(p + L * max(1200.0 - p.y, 100.0));      // the weather where the ray is about at cloud base
  if (a.hi > a.lo) {
    siteNoise(a, p + L * max(a.lo + 300.0 - p.y, 100.0));
    float y0 = max(a.lo, p.y), D = max(a.hi - y0, 0.0);
    for (int k = 0; k < 3; k++) {                          // most of a cloud's depth is near its base: sample there most closely
      float f = k == 0 ? 0.05 : k == 1 ? 0.2 : 0.6, w = k == 0 ? 0.1 : k == 1 ? 0.2 : 0.7;
      vec3 q = p + L * (y0 + D * f - p.y);
      Site s = getSite(q);
      s.warp = a.warp; s.aged = a.aged; s.meso = a.meso; s.rough = a.rough; s.vary = a.vary;
      od += layerDensity(q, s, max(D * w * 0.5, 150.0), 0) * D * w;
    }
  }
  if (uCloudCells > 0.5) {
    // A storm's anvil lies ten kilometers up, so the one in the way is far sunward of the ground it shades.
    Site c = getSite(p + L * (9600.0 - p.y));
    if (c.cw > 0.001) {
      vec3 q = p + L * (mix(c.cwb, c.ctop, 0.87) - p.y);
      c = getSite(q);
      siteNoise(c, q);
      od += layerDensity(q, c, 600.0, 0) * 0.16 * (c.ctop - c.cwb);
    }
  }
  // Under fog the ground is in its shade, by as much fog as stands over it.
  Site g = getSite(p);
  if (g.fog > 0.02) od += SIGMA * 0.55 * min(g.fog * 1.35, 1.0) * max(g.ftop - p.y, 0.0);
  return od * length(L);
}`;

const CLOUD_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler2D tDepth, tSubjDepth;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos, uSunDir, uSunCol, uAmbSky, uAmbGround, uFogCol, uZenith, uFlashPos;
uniform vec2 uDriftR, uDriftCi;
uniform float uNear, uFar, uFogDensity, uFlash, uFrame, uPixAngle;
in vec2 vUv;
layout(location = 0) out vec4 outColor;   // rgb: light scattered toward the eye, a: transmittance
layout(location = 1) out vec4 outAux;     // r: distance to the cloud front, g: scene depth limit

const float PI = 3.14159265;
// Brightness of sunlit cloud: set so that the crown of a thick cloud square to the sun comes out a little under white paint in the same light
// (a deep cloud sends back eight or nine tenths of what falls on it; the sum in the lighting below comes to about 1.5 there).
const float SUN_GAIN = 0.4;
// How fast light that has lost its direction dies away with optical depth, in a cloud that absorbs nothing:
// 0.75 * (1 - g), with g = 0.85 for cloud droplets (the two-stream figure for the light a slab lets through, 1 / (1 + GAMMA * depth)).
const float GAMMA = 0.1125;
${DENSITY_GLSL}

// ---- The air between the eye and the cloud is the shared sky model's (world/atmosphere.js), the same the
// ground is seen through: atmosphereTransmittance() for what survives of the cloud's light (the haze thins
// with height there, so cloud above the haze layer fades more slowly than the ground under it, with no
// factor of our own), and atmosphereInscatter() for the light the air adds on the way.
${ATMO_GLSL}
vec3 desat(vec3 c, float k) { return mix(c, vec3(dot(c, vec3(0.25, 0.6, 0.15))), k); }

// A rough optical depth of the cloud standing over altitude y at a site, from the maps alone.
float overhead(Site s, float y) {
  float cv = smoothstep(0.1, 0.5, s.conv);
  float layer = s.cov * s.cov * max(s.top - max(y, s.wb), 0.0) * mix(1.0, 0.3, cv);
  float an = smoothstep(0.3, 0.5, s.ph) * (1.0 - smoothstep(1.1, 2.5, s.rhoA));
  float cthick = max(s.ctop - s.cwb, 1.0);
  float cell = (1.0 - smoothstep(0.3, 0.9, s.rho)) * max(s.ctop - max(y, s.cwb), 0.0) + an * 0.12 * cthick * step(y, s.cwb + 0.85 * cthick) * 0.4;
  return SIGMA * 0.4 * mix(layer, cell, s.cw);
}

// Optical depth from p toward the sun: a few exponentially growing strides,
// then one long reach so tall towers shade what stands behind them.
float lightDepth(vec3 p, Site s, float fp) {
  float od = 0.0, st = 22.0, t = 0.0;
  #if LIGHT_SITE
  // The weather changes along the way (a storm cell's flank is clear air a kilometer sunward of
  // where it is solid): take it at the far end as well and read each sample in between.
  Site s2 = getSite(p + uSunDir * 1500.0);
  #endif
  for (int i = 0; i < LIGHT_STEPS; i++) {
    // One sample in the middle of each stride, read at a level of detail as coarse as the stride is
    // long, so it stands for the whole stride. (Jittering these instead made the lit skin of a
    // cloud flicker by tens of percent from frame to frame.)
    float tm = t + st * 0.5;
    // (The first two also read the fine detail: it is what shades one small lobe against the next.)
    #if LIGHT_SITE
    od += cloudDensity(p + uSunDir * tm, mixSite(s, s2, min(tm / 1500.0, 1.3)), max(fp, st * 0.7), i < 2 ? LIGHT_NEAR : LIGHT_TIER) * st;
    #else
    od += cloudDensity(p + uSunDir * tm, s, max(fp, st * 0.7), i < 2 ? LIGHT_NEAR : LIGHT_TIER) * st;
    #endif
    t += st; st *= 2.2;
  }
  #if FAR_SHADOW
  vec3 pf = p + uSunDir * (t + 1000.0);
  Site sf = getSite(pf);
  sf.warp = s.warp; sf.aged = s.aged; sf.meso = s.meso; sf.rough = s.rough; sf.vary = s.vary;
  od += cloudDensity(pf, sf, 900.0, 0) * 2200.0;
  #endif
  return od;
}

// Optical depth over the first few hundred meters straight up from p, and (far) a rough figure for
// the rest of the cloud overhead. side: the same toward the sky opposite the sun, the fill light
// that models a shaded flank.
float skyDepth(vec3 p, Site s, float fp, out float side, out float far) {
  float od = 0.0, y = p.y;
  side = 0.0;
  vec2 sh = -uSunDir.xz / max(length(uSunDir.xz), 0.05);
  vec3 back = normalize(vec3(sh.x, 0.35, sh.y));
  #if SKY_STEPS == 1
  od += cloudDensity(p + vec3(0.0, 100.0, 0.0), s, max(fp, 140.0), 0) * 200.0;
  y += 200.0;
  #elif SKY_STEPS > 1
  od += cloudDensity(p + vec3(0.0, 45.0, 0.0), s, max(fp, 60.0), LIGHT_TIER) * 90.0;
  od += cloudDensity(p + vec3(0.0, 290.0, 0.0), s, max(fp, 280.0), 0) * 400.0;
  y += 490.0;
  side = cloudDensity(p + back * 130.0, s, max(fp, 180.0), 0) * 300.0;
  #endif
  far = overhead(s, y);
  return od;
}

float hg(float mu, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5); }
// Two lobes: a sharp forward peak (silver linings) and a broad backscatter. 1.0 = isotropic.
float phase(float mu, float k) { return mix(hg(mu, -0.1 * k), hg(mu, 0.8 * k), 0.5); }

// Interleaved gradient noise: every 3x3 block of pixels holds an even spread of values, so
// what is left after temporal accumulation is a fine, uniform grain instead of clumps.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// Scene depth at a screen pixel, or -1 where what shows there is the player's own aircraft (it is
// drawn a second time on its own, see render(): where the two depths agree, the pixel is aircraft).
float backDepth(ivec2 q) {
  float d = texelFetch(tDepth, q, 0).r, a = texelFetch(tSubjDepth, q, 0).r;
  return a < 0.9999999 && a <= d + 2.0e-6 ? -1.0 : d;
}
float linearZ(float depth) { return 2.0 * uNear * uFar / (uFar + uNear - (depth * 2.0 - 1.0) * (uFar - uNear)); }

vec3 rainbow(float deg) {
  // Primary bow 40.5-42.5 degrees from the antisolar point, red outermost; faint reversed secondary near 51.
  float a = (deg - 40.4) / 2.2, b = (53.2 - deg) / 3.2;
  vec3 c1 = clamp(vec3(1.5 - abs(a * 4.0 - 3.3), 1.5 - abs(a * 4.0 - 2.1), 1.5 - abs(a * 4.0 - 0.8)), 0.0, 1.0) * smoothstep(0.0, 0.12, a) * (1.0 - smoothstep(0.85, 1.0, a));
  vec3 c2 = clamp(vec3(1.5 - abs(b * 4.0 - 3.3), 1.5 - abs(b * 4.0 - 2.1), 1.5 - abs(b * 4.0 - 0.8)), 0.0, 1.0) * smoothstep(0.0, 0.12, b) * (1.0 - smoothstep(0.85, 1.0, b));
  return c1 + c2 * 0.22 + vec3(0.05) * (1.0 - smoothstep(38.0, 40.4, deg));
}

void main() {
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec3 fwd = -normalize(uCamWorld[2].xyz);
  // Scene depth under this cloud texel. A texel covers several screen pixels, and at a silhouette
  // (wing against cloud, ridge against fog) those pixels lie on two surfaces. There, alternate
  // texels in a checkerboard march to the nearest and to the farthest surface under them, so the
  // composite always finds a neighbor that was marched to the surface it is drawing.
  ivec2 dsz = textureSize(tDepth, 0), dmx = dsz - 1, dc = ivec2(vUv * vec2(dsz));
  // The player's own aircraft is the exception. It is always a few meters from the eye, far
  // smaller than any cloud, and its thin, antialiased, sub-pixel-jittered outline is exactly what a
  // coarse cloud buffer cannot follow. So the march looks straight through it, to whatever lies
  // behind, and the cloud buffer has no edge there at all; the composite puts the aircraft back
  // on top at full resolution, with the coverage the rasterizer gave it.
  float depth = backDepth(clamp(dc, ivec2(0), dmx));
  bool own = depth < 0.0;
  float dMin = own ? 2.0 : depth, dMax = depth, bend = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(0, 1) : k == 2 ? ivec2(1, 1) : ivec2(1, -1);
    float da = backDepth(clamp(dc + o, ivec2(0), dmx)), db = backDepth(clamp(dc - o, ivec2(0), dmx));
    if (da >= 0.0) { dMin = min(dMin, da); dMax = max(dMax, da); }
    if (db >= 0.0) { dMin = min(dMin, db); dMax = max(dMax, db); }
    if (!own && da >= 0.0 && db >= 0.0) bend = max(bend, abs(da + db - 2.0 * depth));
  }
  if (own) {
    // Under the aircraft: take the farthest thing visible around it, searching a little way out.
    for (int k = 0; k < 16 && dMax < 0.0; k++) {
      float an = float(k) * 0.7853982 + (k < 8 ? 0.0 : 0.39), rr = k < 8 ? 5.0 : 13.0;
      dMax = max(dMax, backDepth(clamp(dc + ivec2(round(vec2(cos(an), sin(an)) * rr)), ivec2(0), dmx)));
    }
    depth = dMax < 0.0 ? 1.0 : dMax;
    dMin = dMax = depth;
  }
  // Buffer depth is linear across a flat surface, so "bend" is zero on smooth ground however steep;
  // scaled like this it is the size of a depth step relative to the distance. Rough ground bends
  // too, so the two surfaces must also be far enough apart that the composite would tell them
  // apart; anything closer is one surface, and splitting it would print the checkerboard in the haze.
  // (With the cockpit's near plane a few centimeters out, the far distance has only a handful of
  // depth values left; a step of one or two of those is rounding, not a silhouette.)
  if (dMax - dMin > 6.0e-7 && bend * linearZ(depth) * (uFar - uNear) / (uFar * uNear) > 0.08 && linearZ(dMax) > 1.15 * linearZ(dMin)) {
    ivec2 pc = ivec2(gl_FragCoord.xy);
    depth = ((pc.x + pc.y) & 1) == 0 ? dMin : dMax;
  }
  float viewZ = linearZ(depth);
  bool sky = depth >= 0.9999999;     // nothing drawn here (anything looser calls far mountains sky when the near plane is very close)
  float sceneDist = sky ? 1.0e9 : viewZ / max(dot(rd, fwd), 0.05);
  float limit = sky ? 60000.0 : min(viewZ, 60000.0);

  float t0 = 0.0, t1 = min(sceneDist, 170000.0);
  const float yTop = 12600.0;
  if (abs(rd.y) > 1.0e-5) {
    float ta = -uCamPos.y / rd.y, tb = (yTop - uCamPos.y) / rd.y;
    t0 = max(0.0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (uCamPos.y > yTop) t1 = -1.0;

  vec3 col = vec3(0.0);
  float T = 1.0, tSum = 0.0, wSum = 0.0, bow = 0.0;
  float mu = dot(rd, uSunDir);
  float ph0 = phase(mu, 1.0), ph1 = phase(mu, 0.5), ph2 = phase(mu, 0.25);
  vec3 hz = vec3(0.0);            // how much of the cloud's light the air took out on the way, weighted like col
  // (In murk, rain or fog, much of what cuts the visibility is drawn by this march itself, as rain shafts
  // and fog banks: the air's share of it is taken as less than half, or it would be counted twice and
  // the sky under a storm would be a pale fog instead of a dark cloud base.)
  vec3 airK = vec3(mix(1.0, 0.4, uSkyP.z));
  // Light that is not straight from the sun, from the sky model's own irradiance: the sky overhead on
  // what faces up, the low sky and the land (the half of each a wall facing away from the sun sees) on
  // a cloud's sides, and the land's own brightness on what faces down. Grayed a little: sunlit cloud
  // and ground around about light the shaded side of a cloud as well as the blue sky does.
  vec2 awayH = -uSunDir.xz / max(length(uSunDir.xz), 0.05);
  vec3 ambUp = uAmbSky, ambSide = desat(skyIrradiance(vec3(awayH.x, 0.0, awayH.y)), 0.2), ambDn = desat(uAmbGround, 0.1);
  // Two-phase march: long cheap strides probe for cloud; on a hit the ray goes back to the last
  // clear point and walks in finely, so the thin sunlit skin of a dense cloud is resolved.
  // The ray is cut into strides laid end to end from t0, and each is sampled once, a fraction
  // "jit" of the way along it: nothing is left out or counted twice, so the only noise is in
  // where the samples fall, never in how much air they stand for.
  const float MINC = 64.0, MINF = 16.0;
  if (t1 > t0) {
    // The fraction is spread evenly over neighboring pixels and advanced by the golden ratio each
    // frame: evenly spread in time too, which is what the temporal pass needs to converge.
    float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803399);
    float t = t0;                   // start of the stride about to be taken
    float tRain = t0;               // rain is already integrated up to here (by coarse strides)
    float tBack = t0;               // the last place known to be clear of cloud: where a hit goes back to
    float cap = 1.0e9;              // longest coarse stride the layer here allows
    float tClear = -1.0;            // the last fine sample found clear on this walk (-1: none yet)
    float ramp = 1.0;               // fine strides start short at a cloud's surface and grow back
    bool fine = false, wasClear = true, held = false;
    int miss = 0, anchors = 0;
    vec3 Slit = vec3(0.0);          // the light found at the last cloud sample that was lit in full
    float Tlit = -1.0, tLit = 0.0;  // the transmittance and the distance there (-1: none yet)
    for (int i = 0; i < STEPS; i++) {
      if (t >= t1 - 0.25) break;
      // With most of the budget spent the strides lengthen, so a layer seen edge-on fades into
      // the distance instead of stopping where the steps run out.
      float tired = smoothstep(0.6, 1.0, float(i) / float(STEPS));
      float stpC = max(MINC, t * KC * (1.0 + smoothstep(12000.0, 40000.0, t))) * (1.0 + 2.0 * tired);
      // Fine strides shorten close to the eye, where each one is a visible share of the fog.
      float stp = fine ? max(stpC * mix(0.2, 0.6, tired), clamp(t * 0.1, 6.0, MINF)) * ramp : min(stpC, cap);
      // What lies behind cloud that has already taken most of the light counts for little: the strides
      // lengthen as the ray dims (up to two and a half times), which is most of the cost of thin, deep
      // cloud (scud under a storm, an anvil, fog seen from inside) and none of a cloud's lit face.
      if (fine) stp *= 1.0 + 1.5 * (1.0 - T) * (1.0 - T);
      stp = min(stp, t1 - t);
      float ts = t + stp * jit;
      vec3 p = uCamPos + rd * ts;
      Site w = getSite(p);
      bool any = w.hi > w.lo, two = w.ahi > w.alo, in2 = two && p.y > w.alo && p.y < w.ahi;
      bool fg = w.fog > 0.02, inF = fg && p.y < w.ftop + ${FOG_TOP_MARGIN.toFixed(1)};
      bool inLayer = in2 || (any && p.y > w.lo && p.y < w.hi) || inF;
      // Rain hangs under the base and reaches some way up into the cloud; it fades in with the
      // rain rate and out with height (a threshold on either draws a straight edge in the air).
      float rainK = w.precip * smoothstep(0.0, 0.1, w.precip) * (1.0 - smoothstep(w.base - 150.0, w.base + 450.0, p.y));
      bool rain = rainK > 0.002;
      // The thinnest thing a coarse stride must not step over: the layer, or a storm cell's anvil.
      cap = any ? max(MINC, min(w.hi - w.lo, two ? w.ahi - w.alo : 1.0e9) / max(abs(rd.y), 0.02) * 0.4) : 1.0e9;
      if (!inLayer && !rain) {
        // Clear air: stride quickly, and land on the edge of the layer ahead, so the strides
        // inside it are placed (and jittered) from where the ray enters it. Samples snapped to
        // a fixed depth past the edge would line up into stripes when skimming a layer.
        float skip = stpC * 3.0;
        if (any) {
          float te = 1.0e9;
          if (rd.y < 0.0) { if (two && p.y >= w.ahi) te = (p.y - w.ahi) / -rd.y; else if (p.y >= w.hi) te = (p.y - w.hi) / -rd.y; }
          else if (rd.y > 0.0) { if (p.y <= w.lo) te = (w.lo - p.y) / rd.y; else if (two && p.y <= w.alo) te = (w.alo - p.y) / rd.y; }
          skip = min(skip, te);
        }
        if (fg && rd.y < 0.0) skip = min(skip, (p.y - w.ftop - ${FOG_TOP_MARGIN.toFixed(1)}) / -rd.y);      // (not in the fog, so above it)
        t = ts + max(skip, max(12.0, stpC * 0.12));
        fine = false; wasClear = true; tBack = t; tRain = t;
        continue;
      }
      siteNoise(w, p);
      float pix = max(ts * uPixAngle, 1.5);
      gPix = pix;
      float dr = 0.0;
      if (rain) {
        // Rain falls in curtains: modulate along the wind by a slow noise.
        float streak = textureLod(tNoise, vec3(p.x + uDriftR.x, 900.0, p.z + uDriftR.y) / 2900.0, 1.0).a;
        dr = rainK * 0.0008 * (0.3 + 1.4 * streak * streak);
      }
      float d = 0.0, anv = 0.0, hL = 0.0, fogS = 0.0;
      if (!fine) {
        // Probe once per stride, reading the noise as coarsely as the stride is long and leaning
        // toward yes: a sharp probe finds a small cloud on some frames and steps over it on others,
        // and that flicker is too sparse to average out. (Two sharp probes a stride cost half as much again.)
        if (inLayer && cloudDensity(p, w, max(pix, stp * 0.6), -1) > -0.03) {
          fine = true; miss = 0; wasClear = true; ramp = 1.0;
          tClear = tBack > t0 ? tBack : -1.0;
          t = tBack;
          continue;
        }
        tBack = ts;
      } else {
        float fpF = pix * (1.0 + 0.45 * max(log2(stp / 110.0), 0.0));
        // Erosion detail finer than the strides can follow in depth cannot be drawn, only aliased:
        // it turns into a speckle that crawls as the camera moves. Read the detail no finer than
        // features about a stride deep. (Across the screen the footprint above already limits it
        // to a couple of cloud texels. The short strides just under a surface earn finer
        // detail there, where it shows.)
        gDetail = 0.5 * stp;
        if (inLayer) { d = cloudDensity(p, w, fpF, 2); anv = gAnvil; hL = gH; fogS = gFog; }
        if (d > 0.0 && wasClear && !held && anchors < 3) {
          // First sample inside a cloud. One stride here can be most of the way to opaque, so where
          // in it the sample happened to fall would decide the color of the whole lit skin, and
          // that changes every frame. Instead find the surface (bisect between the last clear
          // sample and this one) and restart there with short strides sampled at their middles:
          // the samples now sit at fixed depths under the surface, the same every frame.
          float lo = tClear >= 0.0 ? tClear : t, hi = ts;
          bool found = tClear >= 0.0;
          gDetail = 0.125 * stp / ramp;                     // the detail the first short stride will see
          for (int k = 0; k < 3; k++) {
            float tm = 0.5 * (lo + hi);
            if (cloudDensity(uCamPos + rd * tm, w, fpF, 2) > 0.0) hi = tm; else { lo = tm; found = true; }
          }
          if (found) { t = hi; jit = 0.5; ramp = 0.25; held = true; anchors++; continue; }   // (not found: the walk began inside cloud)
        }
        held = false;
        ramp = min(1.0, ramp * 2.0);
        if (d > 0.0) miss = 0; else { tClear = ts; if (++miss > 6) { fine = false; tBack = ts; } }
      }
      // A fine walk that went back re-crosses air whose rain is already counted.
      dr *= clamp((t + stp - max(t, tRain)) / stp, 0.0, 1.0);
      tRain = max(tRain, t + stp);
      float ext = d + dr;
      if (ext > 1.0e-6) {
        float hN = any ? clamp((p.y - w.lo) / max(max(w.hi, w.ahi) - w.lo, 1.0), 0.0, 1.0) : 0.0;
        vec3 S = Slit;
        // Lighting a sample costs several times what finding it does, so thin cloud (an anvil, a
        // frayed edge, fog), where dozens of samples each add a few percent, is lit afresh only
        // when the ray has lost a fifth of its light or gone a few strides since the last time
        // (and not at all for the last tenth of a ray's light, deep inside).
        if (d > 0.0 && (Tlit < 0.0 || wasClear || (T < Tlit * 0.8 && T > 0.12) || ts - tLit > max(4.0 * stp, 250.0))) {
          // Entering cloud: light the surface, not a point half a stride inside it.
          vec3 pl = wasClear ? p - rd * (stp * 0.5) : p;
          float od = lightDepth(pl, w, pix);
          // Sky light from above gets in as far as the cloud overhead lets it.
          float sd, far;
          float up = skyDepth(pl, w, pix, sd, far);
          #if SKY_STEPS < 2
          sd = d * 110.0 * exp(-0.12 * od);                  // (no sample behind on this tier: as much cloud as there is here for a hundred meters, less the deeper in shade this is)
          #endif
          // Sunlight. What comes straight through and what has been scattered a few times: three octaves
          // of the usual approximation (Wrenninge, Kulla and Lundqvist 2013, as in Hillaire 2016), each
          // half as strong, half as attenuated and half as forward-peaked as the one before. The octaves
          // after those are light that has forgotten where it came from, and their sum is replaced by
          // what diffusion gives for it: under an optical depth tau toward the sun, with tb more cloud
          // behind to send light back, (1 + 2 GAMMA tb) / (1 + GAMMA (tau + tb)). That is what a slab
          // lets through, 1 / (1 + GAMMA tau), at its far side (a kilometer of cumulus passes a fifth of
          // the sunlight, and that light, not the blue sky, is what its base and its shaded side are
          // seen by); and at the lit face it is why a deep cloud is brilliant and a shred of one is not.
          // Nothing here asks how deep a crease the sample is in: a crease is darker by the cloud that
          // really stands between it and the sun and the sky, which the samples above have measured.
          float tauD = od + 0.5 * far, tb = sd * (1.0 - fogS);      // (fog is lit as it was: a bank on the ground has nothing behind it but the ground)
          float sun = exp(-od) * ph0 + 0.5 * exp(-od * 0.5) * ph1 + 0.25 * exp(-od * 0.25) * ph2 + 0.5 * (1.0 + 2.0 * GAMMA * tb) / (1.0 + GAMMA * (tauD + tb));
          float vB = 0.6 * exp(-0.5 * sd) + 0.4 * exp(-0.1 * sd);
          // (Cloud far overhead, an anvil or the tower's own top, hides the zenith but not the sky further out.)
          float vU = (0.5 * exp(-0.6 * up) + 0.32 * exp(-0.15 * up) + 0.18 * exp(-0.04 * up)) * (0.35 + 0.65 * exp(-0.25 * far));
          // The cloud's sides are lit by the low sky and by everything bright around (more where they
          // are open to the sky opposite the sun), hardly at all on the underside of a wide base.
          float wide = mix(smoothstep(0.3, 0.9, w.cov), 1.0 - smoothstep(0.6, 1.3, w.rho), w.cw);
          float vS = (1.0 - 0.85 * wide * (1.0 - smoothstep(0.0, 0.12, hL))) * mix(1.0, vB, 0.55);
          // Light off the ground comes up through whatever cloud lies below.
          float dn = (in2 ? p.y - w.alo : any ? max(p.y - w.lo, 0.0) : 0.0) * SIGMA * 0.6;
          float vD = 0.55 * exp(-0.3 * dn) + 0.45 * exp(-0.02 * dn);
          // (The crown of a cloud gets the sky's light as white paint lying under it would: it is that blue, added to
          // the yellow of the sun, that makes both of them white. The sides and the base get a share of theirs.)
          vec3 amb = ambUp * vU + 0.6 * ambSide * vS + 0.7 * ambDn * vD;
          amb *= 1.0 + 0.25 * fogS;                          // (fog kept as bright as it was under the old weights)
          amb *= 1.0 - 0.5 * w.precip * (1.0 - hN);
          S = uSunCol * sun * SUN_GAIN + amb;
          float fd = distance(p, uFlashPos);
          S += vec3(0.72, 0.8, 1.0) * uFlash * 16.0 * exp(-fd / 2400.0) / (1.0 + fd * fd * 1.5e-7);
          Slit = S; Tlit = T; tLit = ts;
        }
        if (dr > 0.0) {
          vec3 Lr = (ambUp * 0.62 + ambDn * 0.3) * (1.0 - 0.45 * w.precip) + uSunCol * 0.035 * hg(mu, 0.6);
          Lr += vec3(0.72, 0.8, 1.0) * uFlash * 2.0 * exp(-distance(p, uFlashPos) / 3500.0);
          S = (S * d + Lr * dr) / ext;
          #if RAINBOW
          if (mu < -0.55 && uSunDir.y > 0.02 && T > 0.05) {
            vec3 ps = p + uSunDir * ((w.base - p.y) / max(uSunDir.y, 0.12));
            float cs = texture(tWxA, ps.xz / (2.0 * uWxHalf) + 0.5).r;
            bow += T * (1.0 - exp(-dr * stp)) * (1.0 - smoothstep(0.25, 0.8, cs));
          }
          #endif
        }
        float a = 1.0 - exp(-ext * stp);
        vec3 Ta = pow(atmosphereTransmittance(uCamPos, p), airK);
        col += T * a * S * Ta; hz += T * a * (1.0 - Ta);
        tSum += T * a * ts; wSum += T * a;
        T *= 1.0 - a;
        if (T < 0.012) { T = 0.0; break; }
      }
      wasClear = d <= 0.0;
      t += stp;
    }
  }

  // The light the air scatters toward the eye in front of the cloud: the sky model's, for the distance of the cloud front along this ray.
  if (wSum > 1.0e-4) col += hz * atmosphereInscatter(rd, tSum / wSum);
  #if RAINBOW
  if (bow > 0.001) col += rainbow(degrees(acos(clamp(-mu, -1.0, 1.0)))) * uSunCol * min(bow, 0.6) * 0.55;
  #endif

  // High cloud above everything the aircraft can reach, as two thin sheets (looked up once a pixel, not marched).
  // Cirrus at ten kilometers: where the slow noise allows it, in bands drawn out along the wind, and
  // within the bands in threads (noise read stretched fifteen to one), bent a little by a field of slow eddies.
  const float yCi = 10400.0, yAc = 6600.0;
  vec2 gx = uAniso, gz = vec2(-uAniso.y, uAniso.x);
  if (T > 0.01 && uCamPos.y < yCi && rd.y > 0.012) {
    float tc = (yCi - uCamPos.y) / rd.y;
    if (tc < sceneDist && tc < 260000.0) {
      vec3 pc = uCamPos + rd * tc;
      float ci = texture(tWxA, pc.xz / (2.0 * uWxHalf) + 0.5).a;
      vec2 q = pc.xz + uDriftCi;
      vec2 f = vec2(dot(q, gx), dot(q, gz));
      // (The eddies bend the bands by a tenth of a meter per meter at most. At six times that, as it was, the threads were the grain of a plank.)
      vec4 cw = texture(tCurl, f / vec2(61000.0, 30500.0)) - 0.5;
      f += vec2(cw.r * 700.0, cw.g * 450.0);
      float band = texture(tNoise, vec3(f.x / 27000.0, 0.31, f.y / 9000.0)).b * 0.6 + texture(tNoise, vec3(f.x / 9000.0, 0.71, f.y / 2700.0)).b * 0.4;
      float thr = texture(tNoise, vec3(f.x / 23000.0, 0.63, f.y / 1500.0)).b * 0.6 + texture(tDetail, vec3(f.x / 9000.0, 0.17, f.y / 600.0)).r * 0.4;
      float a = smoothstep(0.38 - ci * 0.4, 1.08 - ci * 0.4, band + (thr - 0.5) * 0.3) * (0.55 + 0.9 * (thr - 0.5));
      a *= min(1.0, ci * 3.0) * 0.55 * exp(-tc / 110000.0);
      vec3 cc = uSunCol * (0.2 + 0.14 * hg(mu, 0.7)) + uAmbSky * 1.2;
      vec3 Ta = atmosphereTransmittance(uCamPos, pc);
      col += T * a * (cc * Ta + atmosphereInscatter(rd, tc) * (1.0 - Ta));
      T *= 1.0 - a;
    }
  }
  // Altocumulus (and cirrocumulus) at six and a half kilometers: patches of small arounded elements, some of
  // them marshalled into ripples across the wind. Each element is brighter at its thin rim than in its middle from below.
  if (T > 0.01 && uCamPos.y < yAc - 300.0 && rd.y > 0.02) {
    float tc = (yAc - uCamPos.y) / rd.y;
    if (tc < sceneDist && tc < 120000.0) {
      vec3 pc = uCamPos + rd * tc;
      float ci = texture(tWxA, pc.xz / (2.0 * uWxHalf) + 0.5).a;
      vec2 q = pc.xz + uDriftCi * 0.5;
      vec2 f = vec2(dot(q, gx), dot(q, gz));
      vec4 cw = texture(tCurl, f / 19000.0) - 0.5;
      f += cw.rg * 280.0;
      float inPatch = texture(tNoise, vec3(f.x / 39000.0, 0.57, f.y / 29000.0)).r * 0.65 + texture(tNoise, vec3(f.x / 12700.0, 0.21, f.y / 12700.0)).g * 0.35;
      float wave = texture(tNoise, vec3(f.x / 9100.0, 0.44, f.y / 31000.0)).g;                 // ripples across the wind
      vec4 e = texture(tDetail, vec3(f.x / 3300.0, 0.29, f.y / 3300.0));                       // elements 800 and 400 m across, 200 m within them
      float el = e.r * 0.7 + e.g * 0.3 + (wave - 0.5) * 0.5;
      float amt = smoothstep(0.05, 0.3, ci) * (1.0 - smoothstep(0.55, 0.9, ci));
      float inP = smoothstep(0.62, 0.8, inPatch) * amt;
      float a = smoothstep(0.42, 0.7, el) * inP * 0.8 * exp(-tc / 60000.0) * smoothstep(yAc - 300.0, yAc - 1500.0, uCamPos.y);
      float thickE = smoothstep(0.6, 0.95, el);
      vec3 cc = uSunCol * (0.22 + 0.2 * hg(mu, 0.6)) * mix(1.0, 0.5, thickE) + uAmbSky * mix(1.15, 0.8, thickE) + uAmbGround * 0.3;
      vec3 Ta = atmosphereTransmittance(uCamPos, pc);
      col += T * a * (cc * Ta + atmosphereInscatter(rd, tc) * (1.0 - Ta));
      T *= 1.0 - a;
    }
  }
  outColor = vec4(col, T);
  outAux = vec4(wSum > 1.0e-4 ? min(tSum / wSum, 60000.0) : min(sceneDist, 30000.0), limit, 0.0, 1.0);
}`;

// Test probe: the cloud extinction at given world points, for checking Weather.density() against the shader.
const PROBE_FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler2D tPts;
out vec4 outColor;
${DENSITY_GLSL}
void main() {
  vec3 p = texelFetch(tPts, ivec2(gl_FragCoord.xy), 0).xyz;
  Site s = getSite(p);
  siteNoise(s, p);
  gDetail = 0.0;
  float d = cloudDensity(p, s, 1.0, PROBE_TIER);
  outColor = vec4(d, gCrease, gH, s.cw);
}`;

// Temporal accumulation: find where each cloud sample was on screen last frame,
// and blend the fresh, noisy sample into that history.
const TEMPORAL_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tCur, tCurAux, tHist, tHistAux;
uniform mat4 uProjInv, uCamWorld, uPrevVP;
uniform vec3 uCamDelta;                    // how far the camera moved since last frame, plus how far the wind carried the cloud
uniform float uAlpha, uStill, uReset;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;     // r: distance to the cloud front, g: scene depth limit, b: frames accumulated,
                                          // a: how much this texel flickers from frame to frame (variance, in units of opacity)
// Catmull-Rom resampling in five bilinear taps: reprojecting with plain bilinear
// filtering every frame would blur the history a little more each time.
vec4 sharpSample(sampler2D tex, vec2 uv) {
  vec2 res = vec2(textureSize(tex, 0)), pos = uv * res, tc = floor(pos - 0.5) + 0.5, f = pos - tc;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, t0 = (tc - 1.0) / res, t3 = (tc + 2.0) / res, t12 = (tc + w2 / w12) / res;
  vec4 r = texture(tex, vec2(t12.x, t0.y)) * (w12.x * w0.y) + texture(tex, vec2(t0.x, t12.y)) * (w0.x * w12.y)
    + texture(tex, t12) * (w12.x * w12.y) + texture(tex, vec2(t3.x, t12.y)) * (w3.x * w12.y) + texture(tex, vec2(t12.x, t3.y)) * (w12.x * w3.y);
  r /= w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  // Anti-ringing: the sharp filter overshoots, and in a feedback loop that overshoot
  // would grow into a grain pattern. Keep the result inside the four texels it sits between.
  ivec2 b = ivec2(tc - 0.5), m = ivec2(res) - 1;
  vec4 a0 = texelFetch(tex, clamp(b, ivec2(0), m), 0), a1 = texelFetch(tex, clamp(b + ivec2(1, 0), ivec2(0), m), 0);
  vec4 a2 = texelFetch(tex, clamp(b + ivec2(0, 1), ivec2(0), m), 0), a3 = texelFetch(tex, clamp(b + ivec2(1, 1), ivec2(0), m), 0);
  return clamp(r, min(min(a0, a1), min(a2, a3)), max(max(a0, a1), max(a2, a3)));
}
// 1 where two texels were marched to the same surface. Where the cloud in front of both is
// opaque (transmittance ta, tb near zero) the surface behind does not matter.
float same(float da, float db, float ta, float tb) {
  float m = 1.0 - smoothstep(0.08, 0.3, abs(da - db) / max(min(da, db), 1.0));
  return max(m, (1.0 - smoothstep(0.02, 0.1, ta)) * (1.0 - smoothstep(0.02, 0.1, tb)));
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), mx = textureSize(tCur, 0) - 1;
  vec4 cur = texelFetch(tCur, px, 0), aux = texelFetch(tCurAux, px, 0);
  // What the neighborhood sees now, counting only texels marched to the same surface as this
  // one (at a silhouette every other texel belongs to the surface behind or in front).
  vec4 m1 = cur, m2 = cur * cur, nLo = cur, nHi = cur;
  float wn = 1.0, fw = 1.02 - cur.a, fi = fw / max(aux.r, 1.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    ivec2 q = clamp(px + ivec2(i, j), ivec2(0), mx);
    vec4 c = texelFetch(tCur, q, 0), ca = texelFetch(tCurAux, q, 0);
    float w = same(ca.g, aux.g, c.a, cur.a);
    m1 += c * w; m2 += c * c * w; wn += w;
    if (w > 0.5) { nLo = min(nLo, c); nHi = max(nHi, c); }
    float o = w * (1.02 - c.a);
    fw += o; fi += o / max(ca.r, 1.0);
  }
  m1 /= wn;
  vec4 sd = sqrt(max(m2 / wn - m1 * m1, 0.0));
  float front = fw / fi;

  // Where this cloud was on last frame's screen. It is placed at the distance of the cloud front
  // around here, each texel counting by how opaque it is: the edge of a cloud then moves with
  // the cloud rather than with what lies behind it, and one ray that grazed a faint wisp on
  // this frame cannot drag its neighbors' history out of place.
  vec4 v = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
  vec4 clip = uPrevVP * vec4(rd * front + uCamDelta, 1.0);
  vec2 huv = clip.xy / max(clip.w, 1.0e-4) * 0.5 + 0.5;
  bool off = uReset > 0.5 || clip.w <= 0.0 || huv.x < 0.0 || huv.y < 0.0 || huv.x > 1.0 || huv.y > 1.0;

  // Read the history from the texels that were marched to this surface. Mixing in the others is
  // what leaves a trail behind a wing or smears fog along a ridgeline.
  vec2 hp = huv * vec2(mx + 1) - 0.5, hf = fract(hp);
  ivec2 hb = ivec2(floor(hp));
  vec4 hist = vec4(0.0);
  float hFront = 0.0, hCount = 0.0, hVar = 0.0, hw = 0.0, agree = 1.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 q = clamp(hb + ivec2(i, j), ivec2(0), mx);
    vec4 h = texelFetch(tHist, q, 0), ha = texelFetch(tHistAux, q, 0);
    float m = same(ha.g, aux.g, h.a, m1.a);
    float w = (i == 0 ? 1.0 - hf.x : hf.x) * (j == 0 ? 1.0 - hf.y : hf.y) * m;
    hist += h * w; hFront += ha.r * w; hCount += ha.b * w; hVar += ha.a * w; hw += w; agree = min(agree, m);
  }
  float valid = off ? 0.0 : smoothstep(0.0, 0.08, hw);
  hist /= max(hw, 1.0e-5); hFront /= max(hw, 1.0e-5); hVar /= max(hw, 1.0e-5); hCount = hCount / max(hw, 1.0e-5) * valid;
  if (agree > 0.99) hist = sharpSample(tHist, huv);
  if (valid <= 0.0) { hist = cur; hFront = aux.r; hCount = 0.0; hVar = 0.0; }    // nothing usable: start again from this frame
  // Hold the history to what the neighborhood shows now (mean and spread), to stop trails.
  // Thin cloud is the exception: there a ray finds cloud on some frames and none on others, the
  // neighborhood often shows no cloud at all, and clamping to it would throw the history away
  // every frame and leave the raw speckle. Where the history says this spot flickers, the box
  // widens by that much (and the color by the light that comes with that much opacity).
  float tsd = sqrt(max(hVar, 0.0)) * valid;
  vec3 per = min(hist.rgb / max(1.0 - hist.a, 0.05), 40.0);          // light per unit of opacity
  float lref = max(dot(per, vec3(0.3, 0.5, 0.2)), 0.02);
  vec4 box = sd * (1.5 + 3.0 / wn) + 0.004 + 2.0 * tsd * vec4(per, 1.0);
  vec4 hRaw = hist;
  // But never past the least and the most the texels around about hold on this frame (two texels out
  // each way: twenty-five rays, which the sampling pattern spreads evenly through their strides, so
  // thin cloud that is really there shows in some of them, and its history, their mean, lies between).
  // What does not show in any of them is cloud that has gone. A history that differs from every frame
  // the same way looks, to the measure of flicker above, exactly like flicker of that size, so the
  // widened box never closed on it: the light of an edge that had slid on stayed where the sky was
  // clear until the history ran out, a second later, and every cloud passing close by drew a pale
  // streak out behind it along the line of flight.
  for (int k = 0; k < 16; k++) {
    ivec2 o = k < 5 ? ivec2(k - 2, -2) : k < 10 ? ivec2(k - 7, 2) : k < 13 ? ivec2(-2, k - 11) : ivec2(2, k - 14);
    vec4 c = texelFetch(tCur, clamp(px + o, ivec2(0), mx), 0);
    nLo = min(nLo, c); nHi = max(nHi, c);
  }
  hist = clamp(hist, max(m1 - box, nLo - 0.004), min(m1 + box, nHi + 0.004));
  vec4 out4 = abs(hRaw - hist) / (box + 1.0e-4);
  float bite = clamp(max(max(out4.r, out4.g), max(out4.b, out4.a)), 0.0, 1.0);    // how far outside the box the history was

  // Each texel counts the frames it has accumulated. A new one (just uncovered, or after a
  // reset) takes a plain running average, which converges as fast as the samples allow, and
  // while one frame still weighs heavily in it the neighborhood mean stands in for the raw sample.
  // How long a history may run depends on how fast it is sliding across the screen: every
  // resampling softens it a little, so moving cloud keeps a short one, while cloud that is
  // (nearly) still, most of the sky from a cruising aircraft, keeps averaging for several times
  // as long, which is what takes the last of the sampling pattern out of it. A history
  // that had to be pulled back into the box is out of date, and is cut short.
  float slide = length((huv - vUv) * vec2(mx + 1));
  float longest = (1.0 / uAlpha - 1.0) * mix(uStill, min(uStill, 2.5), smoothstep(0.05, 2.0, slide));
  hCount = min(hCount, longest) * (1.0 - 0.5 * smoothstep(0.3, 1.0, bite));
  float alpha = 1.0 / (hCount + 1.0);
  float fresh = clamp(alpha * 1.25 - 0.2, 0.0, 1.0);    // also true of every texel while lightning forces the blend up
  // Flicker, in units of opacity: the change in transmittance, and the change in brightness as a
  // share of what a fully opaque cloud here would show.
  float dT = cur.a - hist.a, dL = dot(cur.rgb - hist.rgb, vec3(0.3, 0.5, 0.2)) / lref, sL = dot(sd.rgb, vec3(0.3, 0.5, 0.2)) / lref;
  float var = mix((1.0 - alpha) * (hVar + alpha * (dT * dT + dL * dL)), sd.a * sd.a + sL * sL, fresh);
  // Flickering spots also take the neighborhood mean, in proportion: nine evenly spread samples instead of one.
  cur = mix(cur, m1, max(fresh, 0.7 * smoothstep(0.04, 0.2, tsd)));
  outColor = mix(hist, cur, alpha);
  outAux = vec4(mix(hFront, aux.r, max(alpha, 0.5)), aux.g, hCount + 1.0, var);
}`;

// Spatial clean-up of the accumulated cloud before it is laid over the scene. What the temporal
// pass could not average away (a texel with little history, or one that flickers hard) is the
// sampling pattern itself, and that pattern is built so that any 3x3 block of texels holds an
// even spread of it: a 3x3 mean over texels on the same surface removes it. Each texel gets as
// much of that mean as it has noise left; cloud close to the eye, whose detail is many texels
// wide, takes most of it regardless. The result is not fed back into the history.
const RESOLVE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tCloud, tCloudAux;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), mx = textureSize(tCloud, 0) - 1;
  vec4 c0 = texelFetch(tCloud, px, 0), a0 = texelFetch(tCloudAux, px, 0);
  float left = sqrt(max(a0.a, 0.0) / (2.0 * max(a0.b, 1.0) + 1.0));      // flicker / sqrt(frames behind it)
  float k = max(smoothstep(0.004, 0.02, left), 0.7 * (1.0 - smoothstep(600.0, 2500.0, a0.r)));
  // Besides that, texels that differ from this one by no more than a few percent always join the mean:
  // what a 3x3 mean removes there is not cloud detail (edges and gradients survive it) but the
  // faint texel-sized mesh the sampling pattern leaves on smooth cloud, which sharpening
  // further down the pipeline would otherwise bring out.
  float l0 = dot(c0.rgb, vec3(0.3, 0.5, 0.2));
  vec4 acc = c0; float ws = 1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    ivec2 q = clamp(px + ivec2(i, j), ivec2(0), mx);
    vec4 c = texelFetch(tCloud, q, 0);
    float g = texelFetch(tCloudAux, q, 0).g, l = dot(c.rgb, vec3(0.3, 0.5, 0.2));
    float alike = 1.0 - smoothstep(0.03, 0.09, abs(l - l0) / (max(l, l0) + 0.005) + abs(c.a - c0.a));
    float w = max(1.0 - smoothstep(0.08, 0.3, abs(g - a0.g) / max(min(g, a0.g), 1.0)), (1.0 - smoothstep(0.02, 0.1, c.a)) * (1.0 - smoothstep(0.02, 0.1, c0.a)));
    w *= max(k, alike);
    acc += c * w; ws += w;
  }
  c0 = acc / ws;
  outColor = c0;
  outAux = a0;
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tScene, tCloud, tCloudAux, tDepth, tSubject, tSubjDepth;
uniform float uNear, uFar, uNearSigma, uSubjDist;
in vec2 vUv;
layout(location = 0) out vec4 outColor;      // rgb: HDR scene with clouds, a: how much open sky shows here (for sun rays)
// The cloud between the eye and what this pixel shows (rgb: its light, a: how much shows through it),
// for the post stack. On the player's aircraft that is the few meters of air in front of it, not the
// cloud behind, which is what the cloud buffer holds there: taken from that, post-processing would
// treat the aircraft as lying behind the cloud (no temporal antialiasing, a misty glow laid over it).
layout(location = 1) out vec4 outFront;

// 1 where a cloud texel marched to depth cd can stand for a surface at depth d.
float match(float cd, float d) { return 1.0 - smoothstep(0.1, 0.3, abs(cd - d) / max(min(cd, d), 1.0)); }

// The cloud in front of a surface at depth d (m) at this pixel: an interpolation of the
// low-resolution cloud that uses only the texels marched to that surface.
vec4 cloudAt(float d) {
  vec2 res = vec2(textureSize(tCloud, 0));
  vec2 f = vUv * res - 0.5;
  ivec2 b = ivec2(floor(f)), mx = ivec2(res) - 1;
  vec2 fr = f - vec2(b);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 c = clamp(b + ivec2(i, j), ivec2(0), mx);
    float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y) * match(texelFetch(tCloudAux, c, 0).g, d);
    acc += texelFetch(tCloud, c, 0) * w; wsum += w;
  }
  if (wsum > 0.04) return acc / wsum;
  // None of the four around it was marched to this surface (a strut, a twig, a wing tip):
  // look one ring further out, and failing that take the texel nearest in depth.
  acc = vec4(0.0); wsum = 0.0;
  vec4 nearest = vec4(0.0, 0.0, 0.0, 1.0); float miss = 1.0e9;
  for (int j = -1; j <= 2; j++) for (int i = -1; i <= 2; i++) {
    ivec2 c = clamp(b + ivec2(i, j), ivec2(0), mx);
    float cd = texelFetch(tCloudAux, c, 0).g;
    vec4 cc = texelFetch(tCloud, c, 0);
    vec2 dv = vec2(float(i), float(j)) - fr;
    float w = exp(-dot(dv, dv)) * match(cd, d);
    acc += cc * w; wsum += w;
    float e = abs(cd - d) / max(min(cd, d), 1.0) + 0.01 * dot(dv, dv);
    if (e < miss) { miss = e; nearest = cc; }
  }
  return wsum > 1.0e-3 ? acc / wsum : nearest;
}

float viewDepth(float depth) {
  return depth >= 0.9999999 ? 60000.0 : min(2.0 * uNear * uFar / (uFar + uNear - (depth * 2.0 - 1.0) * (uFar - uNear)), 60000.0);
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy), mx = textureSize(tDepth, 0) - 1;
  vec3 s = texelFetch(tScene, px, 0).rgb;
  float depth = texelFetch(tDepth, px, 0).r, d0 = viewDepth(depth);
  // The player's own aircraft, drawn alone: its color times its coverage of this pixel, and that
  // coverage (which also counts the glass and the propeller disk for as much as they hide).
  vec4 A = texelFetch(tSubject, px, 0);
  float rawS = texelFetch(tSubjDepth, px, 0).r;
  bool hitS = rawS < 0.9999999, own = hitS && rawS <= depth + 2.0e-6;
  if (hitS && !own) A = vec4(0.0);                              // something nearer hides it here
  A.a = clamp(A.a, 0.0, 1.0);
  // The nearest and the farthest surface among this pixel and the four beside it (the aircraft
  // does not count: the cloud was marched as if it were not there).
  float dn = own ? 1.0e9 : d0, df = own ? -1.0 : d0, rawF = own ? 1.0 : depth;
  ivec2 on = ivec2(0), of = ivec2(0);
  for (int k = 0; k < 4; k++) {
    ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
    ivec2 q = clamp(px + o, ivec2(0), mx);
    float raw = texelFetch(tDepth, q, 0).r, dk = viewDepth(raw), rs = texelFetch(tSubjDepth, q, 0).r;
    if (rs < 0.9999999 && rs <= raw + 2.0e-6) continue;
    if (dk < dn) { dn = dk; on = o; }
    if (dk > df) { df = dk; of = o; rawF = raw; }
  }
  if (own) { d0 = df < 0.0 ? 60000.0 : df; dn = d0; df = d0; }   // what lies behind the aircraft here
  vec4 c = cloudAt(d0);
  vec3 col = s * c.a + c.rgb;
  vec4 ahead = c;
  float open = (own ? rawF : depth) >= 0.9999999 ? c.a : 0.0;
  if (A.a < 0.002 && match(dn, df) < 0.5) {
    // A silhouette pixel. The scene color here is already an antialiased blend of the surface in
    // front and whatever is behind it, but its depth is only one of the two, and cloud laid over
    // the whole pixel for that one depth leaves a hard, wrongly tinted rim (a strut in fog turns
    // into a dotted line). So work out how much of the pixel each surface covers, from where its
    // color lies between a pixel further onto the front surface and one further onto the back,
    // and give each share the cloud that belongs in front of it.
    bool front = match(d0, dn) > 0.5;
    ivec2 o = front ? of : on;                                    // which way the other surface lies
    vec3 sOther = texelFetch(tScene, clamp(px + o, ivec2(0), mx), 0).rgb;
    ivec2 pb = clamp(px - o, ivec2(0), mx);
    vec3 sOwn = match(viewDepth(texelFetch(tDepth, pb, 0).r), d0) > 0.5 ? texelFetch(tScene, pb, 0).rgb : s;
    vec3 sN = front ? sOwn : sOther, sF = front ? sOther : sOwn, e = sN - sF;
    float e2 = dot(e, e), f = front ? 1.0 : 0.0;
    if (e2 > 2.0e-3 * (dot(sN, sN) + dot(sF, sF)) + 1.0e-7) {
      float g = clamp(dot(s - sF, e) / e2, 0.0, 1.0);
      vec3 off = s - sF - g * e;                                  // how far the color is from being a blend of the two
      f = mix(g, f, smoothstep(0.02, 0.1, dot(off, off) / e2));
    }
    vec4 cN = front ? c : cloudAt(dn), cF = front ? cloudAt(df) : c;
    col = s * cN.a + cN.rgb + (1.0 - f) * (sF * (cF.a - cN.a) + cF.rgb - cN.rgb);
    open = rawF >= 0.9999999 ? (1.0 - f) * cF.a : 0.0;
    ahead = mix(cF, cN, f);
  }
  if (A.a >= 0.002) {
    // A pixel the aircraft covers, wholly or in part. The aircraft's share sees only the few meters
    // of air between the eye and itself (clear, unless the eye is inside cloud: then a smooth fog
    // from the density around the camera); everything else in the pixel is behind the whole
    // cloud. Along the outline the two shares are exactly the rasterizer's antialiasing.
    float Tn = exp(-uNearSigma * (hitS ? min(uNear * uFar / (uFar - rawS * (uFar - uNear)), 300.0) : uSubjDist));
    vec3 Sn = c.rgb / max(1.0 - c.a, 0.03);
    vec3 rest = s - A.rgb;
    // ("rest" is the background's share of the pixel, behind all the cloud; only where the aircraft
    // fills the pixel can it be something in front of the aircraft, such as rain streaks.)
    col = A.rgb * Tn + A.a * Sn * (1.0 - Tn) + rest * (A.a > 0.995 ? Tn : c.a) + (1.0 - A.a) * c.rgb;
    open *= 1.0 - A.a;
    ahead = mix(c, vec4(Sn * (1.0 - Tn), Tn), A.a);
  }
  // The aircraft's antialiased outline moves by a fraction of a pixel every frame (the scene is
  // jittered for temporal antialiasing), so the pixels just outside it this frame are part of it
  // on the next: they must count as in front of the cloud too, or the post stack antialiases the
  // outline on some frames and not on others, and it crawls.
  float cover = A.a;
  for (int k = 0; k < 12; k++) {
    ivec2 o = k < 8 ? ivec2(k < 3 ? k - 1 : k < 5 ? (k == 3 ? -1 : 1) : k - 6, k < 3 ? -1 : k < 5 ? 0 : 1) : ivec2(k == 8 ? -2 : k == 9 ? 2 : 0, k == 10 ? -2 : k == 11 ? 2 : 0);
    cover = max(cover, texelFetch(tSubject, clamp(px + o, ivec2(0), mx), 0).a * (k < 8 ? 1.0 : 0.7));
  }
  if (cover > A.a) ahead.a = mix(ahead.a, max(ahead.a, exp(-uNearSigma * uSubjDist)), clamp(cover, 0.0, 1.0));
  outColor = vec4(col, open);
  outFront = ahead;
}`;

const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpC = new THREE.Color(), tmpBox = new THREE.Box3(), tmpM2 = new THREE.Matrix4();

export class CloudRenderer {
  constructor(renderer, weather) {
    this.renderer = renderer; this.weather = weather;
    this.tier = 'med';
    const N = WX_N;
    const mk = (data) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
      t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
    };
    this.wxA = mk(weather.A); this.wxB = mk(weather.B);
    ENV.tWxA.value = this.wxA; ENV.tWxB.value = this.wxB;
    // Storm cells, baked over the same grid (Weather.bakeCells): r: radii from the nearest cell's axis,
    // g: from its anvil's, b: its phase, a: its base / TEX_ALT. Floats, so a growing cell rises smoothly.
    this.cellData = new Float32Array(N * N * 4);
    this.floatLinear = renderer.extensions.has('OES_texture_float_linear');
    this.cellHalf = this.floatLinear ? null : new Uint16Array(N * N * 4);
    this.wxC = new THREE.DataTexture(this.cellHalf || this.cellData, N, N, THREE.RGBAFormat, this.floatLinear ? THREE.FloatType : THREE.HalfFloatType);
    this.wxC.magFilter = this.wxC.minFilter = THREE.LinearFilter;
    this.cellsBaked = -1;
    this.bakeCells();
    (ENV.tWxC || (ENV.tWxC = { value: null })).value = this.wxC;
    // What the shaders read is not these maps themselves but a blend, made on the GPU each frame, from the maps as they
    // were shown when the weather last finished a refresh toward the newest, as far as the weather has got with the next
    // one (blendMaps). The clouds then change shape smoothly instead of in a step at every refresh, which shows most
    // with the clock sped up. A change made at once (a new situation, the window moving) is shown at once.
    const rt = (type) => new THREE.WebGLRenderTarget(N, N, { type, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.blend = [[this.wxA, 'tWxA', THREE.UnsignedByteType], [this.wxB, 'tWxB', THREE.UnsignedByteType], [this.wxC, 'tWxC', THREE.HalfFloatType]]
      .map(([next, env, type]) => ({ next, env: ENV[env], rt: [rt(type), rt(type)], out: 0 }));
    this.blendMat = fsMaterial(`precision highp float; uniform sampler2D tPrev, tNext; uniform float uT; out vec4 outColor;
      void main() { ivec2 p = ivec2(gl_FragCoord.xy); outColor = mix(texelFetch(tPrev, p, 0), texelFetch(tNext, p, 0), uT); }`,
      { tPrev: { value: null }, tNext: { value: null }, uT: { value: 0 } });
    this.blendT = -1;
    const vol = (data, size) => {
      const t = new THREE.Data3DTexture(data, size, size, size);
      t.format = THREE.RGBAFormat; t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true; t.unpackAlignment = 1; t.needsUpdate = true;
      return t;
    };
    this.noiseTex = vol(weather.noise, NOISE_SIZE);
    this.detailTex = vol(weather.noise.detail || makeDetailNoise(), DETAIL_SIZE);
    this.curlTex = new THREE.DataTexture(makeCurlNoise(), CURL_SIZE, CURL_SIZE, THREE.RGBAFormat);
    this.curlTex.wrapS = this.curlTex.wrapT = THREE.RepeatWrapping;
    this.curlTex.magFilter = this.curlTex.minFilter = THREE.LinearFilter; this.curlTex.needsUpdate = true;

    this.post = new PostFX(renderer);
    this.fx = this.post.fx;                    // per-frame effect parameters, filled by the game
    this.uFlashScreen = { value: 0 };          // legacy hook: full-screen flash, read as fx.flash when that is unset

    const V2 = () => ({ value: new THREE.Vector2() }), M4 = () => ({ value: new THREE.Matrix4() });
    // What a terrain shader needs to cast these clouds' shadows (see CLOUD_SHADOW_GLSL) lives in ENV, like the
    // weather maps: the holders env.js declares if it declares them (so a shader built before this renderer
    // has them), new ones otherwise.
    const env = (k, make) => ENV[k] || (ENV[k] = make());
    const tex = (k, t) => { const u = env(k, () => ({ value: null })); u.value = t; return u; };
    this.cloudMat = fsMaterial(CLOUD_FRAG, {
      tDepth: { value: null }, tSubjDepth: { value: null }, tWxA: ENV.tWxA, tWxB: ENV.tWxB, tWxC: ENV.tWxC, tNoise: tex('tCloudNoise', this.noiseTex), tDetail: tex('tCloudDetail', this.detailTex), tCurl: tex('tCloudCurl', this.curlTex),
      uProjInv: M4(), uCamWorld: M4(), uCamPos: { value: new THREE.Vector3() },
      uSunDir: ENV.uSunDir, uSunCol: ENV.uSunCol, uAmbSky: ENV.uAmbSky, uAmbGround: ENV.uAmbGround, uFogCol: ENV.uFogCol, uZenith: ENV.uZenith,
      uFlashPos: ENV.uFlashPos, uFlash: ENV.uFlash, uWxHalf: ENV.uWxHalf, uFogDensity: ENV.uFogDensity,
      ...Object.fromEntries(ATMO_UNIFORMS.map((k) => [k, ENV[k]])),
      uDriftN: env('uCloudDriftN', V2), uDriftW: env('uCloudDriftW', V2), uDriftV: env('uCloudDriftV', V2), uDriftS: env('uCloudDriftS', V2), uDriftM: ENV.uCloudDriftM,
      uDriftD: ENV.uCloudDriftD, uDriftC: env('uCloudDriftC', V2), uShear: env('uCloudShear', V2), uAniso: ENV.uCloudAniso, uFogBank: ENV.uCloudFogBank, uFogAmt: ENV.uCloudFogAmt, uDriftR: V2(), uDriftCi: V2(),
      uNear: { value: 1 }, uFar: { value: 1 }, uFrame: { value: 0 }, uPixAngle: { value: 0.001 },
    }, { defines: this.defines() });
    env('uCloudCells', () => ({ value: 0 })).value = this.cellsBaked > 0 ? 1 : 0;
    this.temporalMat = fsMaterial(TEMPORAL_FRAG, {
      tCur: { value: null }, tCurAux: { value: null }, tHist: { value: null }, tHistAux: { value: null },
      uProjInv: M4(), uCamWorld: M4(), uPrevVP: M4(), uCamDelta: { value: new THREE.Vector3() },
      uAlpha: { value: 0.11 }, uStill: { value: 1 }, uReset: { value: 1 },
    });
    this.filterMat = fsMaterial(RESOLVE_FRAG, { tCloud: { value: null }, tCloudAux: { value: null } });
    this.compMat = fsMaterial(COMPOSITE_FRAG, {
      tScene: { value: null }, tCloud: { value: null }, tCloudAux: { value: null }, tDepth: { value: null },
      tSubject: { value: null }, tSubjDepth: { value: null }, uNearSigma: { value: 0 }, uSubjDist: { value: 15 },
      uNear: { value: 1 }, uFar: { value: 1 },
    });
    this.quad = new FullscreenQuad();
    this.sceneRT = null; this.cloudRT = null; this.hist = [null, null]; this.hdrRT = null;
    this.frame = 0; this.reset = true;
    this.prevVP = new THREE.Matrix4(); this.prevPos = new THREE.Vector3(); this.prevFlash = 0;
    this.prevDrift = { x: 0, z: 0 };
  }

  defines() {
    const t = TIERS[this.tier];
    return { STEPS: t.steps, KC: t.kc.toFixed(3), LIGHT_STEPS: t.light, LIGHT_TIER: t.lightTier, LIGHT_NEAR: t.lightNear, LIGHT_SITE: t.lightSite, CELLS: this.cellsBaked > 0 ? 1 : 0, SKY_STEPS: t.sky, FAR_SHADOW: t.far, RAINBOW: t.bow, FOG: this.fogOn ? 1 : 0 };
  }

  /**
   * Move the maps the shaders read (ENV.tWxA, tWxB, tWxC) on toward the newest: the share of the way is how far the
   * weather has got with baking the next refresh, so the blend arrives just as that refresh does. When one arrives,
   * what was being shown becomes the start of the next blend; when the weather was rebaked at once (Weather.snap), the
   * newest maps are shown as they are.
   */
  blendMaps() {
    const wx = this.weather, r = this.renderer, u = this.blendMat.uniforms;
    if (wx.dirty) {
      this.wxA.needsUpdate = true; this.wxB.needsUpdate = true; this.bakeCells();
      for (const b of this.blend) b.out ^= 1;
      wx.dirty = false;
    } else if (!wx.snap && wx.row / WX_N === this.blendT) return;   // (nothing has moved: paused)
    const snap = wx.snap || this.blendT < 0, t = snap ? 1 : wx.row / WX_N;
    wx.snap = false; this.blendT = wx.row / WX_N;
    const was = r.getRenderTarget();
    for (const b of this.blend) {
      const out = b.rt[b.out];
      u.tPrev.value = snap ? b.next : b.rt[b.out ^ 1].texture; u.tNext.value = b.next; u.uT.value = t;
      this.quad.draw(r, this.blendMat, out);
      b.env.value = out.texture;
    }
    r.setRenderTarget(was);
  }

  /** Refresh the storm-cell map from the weather (cells drift, grow and die). */
  bakeCells() {
    const wx = this.weather, n = wx.cells?.length || 0;
    if (!n && !this.cellsBaked) return;                 // none now and none before: the map is already empty
    wx.bakeCells(this.cellData);
    if (this.cellHalf) for (let i = 0; i < this.cellData.length; i++) this.cellHalf[i] = THREE.DataUtils.toHalfFloat(this.cellData[i]);
    this.wxC.needsUpdate = true;
    // With no storm cells anywhere the shader is compiled without them (it is a good deal quicker).
    if (this.cloudMat && (n > 0) !== (this.cellsBaked > 0)) { this.cellsBaked = n; this.cloudMat.defines = this.defines(); this.cloudMat.needsUpdate = true; }
    this.cellsBaked = n;
    if (ENV.uCloudCells) ENV.uCloudCells.value = n > 0 ? 1 : 0;
  }

  /** Test hook: cloudShadowDepth() of CLOUD_SHADOW_GLSL at ground points [x, y, z, ...], as a terrain shader would see it. */
  probeShadow(points) {
    const n = points.length / 3, r = this.renderer, data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { data[i * 4] = points[i * 3]; data[i * 4 + 1] = points[i * 3 + 1]; data[i * 4 + 2] = points[i * 3 + 2]; }
    const pts = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType); pts.needsUpdate = true;
    const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const mat = fsMaterial(`precision highp float; precision highp sampler3D; uniform sampler2D tPts, tWxA, tWxB; uniform float uWxHalf; uniform vec3 uSunDir; out vec4 outColor;
${CLOUD_SHADOW_GLSL}
void main() { outColor = vec4(cloudShadowDepth(texelFetch(tPts, ivec2(gl_FragCoord.xy), 0).xyz)); }`,
      { tPts: { value: pts }, tWxA: ENV.tWxA, tWxB: ENV.tWxB, uWxHalf: ENV.uWxHalf, uSunDir: ENV.uSunDir, ...Object.fromEntries(CLOUD_SHADOW_UNIFORMS.map((k) => [k, ENV[k]])) });
    const prev = r.getRenderTarget(), out = new Float32Array(n * 4);
    this.quad.draw(r, mat, rt);
    r.readRenderTargetPixels(rt, 0, 0, n, 1, out);
    r.setRenderTarget(prev);
    pts.dispose(); rt.dispose(); mat.dispose();
    return Array.from({ length: n }, (_, i) => out[i * 4]);
  }

  /**
   * Test hook: the shader's cloud extinction (1/m) at world points [x, y, z, x, y, z, ...], at a stage of the
   * density (1: what Weather.density() mirrors, 2: with the fine detail). Returns four floats a point:
   * extinction, depth into the shell, billow value, the storm cell's say.
   */
  probeDensity(points, tier = 1) {
    const n = points.length / 3, r = this.renderer, cu = this.cloudMat.uniforms;
    const w = Math.min(n, 4096), hgt = Math.ceil(n / w);
    const data = new Float32Array(w * hgt * 4);
    for (let i = 0; i < n; i++) { data[i * 4] = points[i * 3]; data[i * 4 + 1] = points[i * 3 + 1]; data[i * 4 + 2] = points[i * 3 + 2]; }
    const pts = new THREE.DataTexture(data, w, hgt, THREE.RGBAFormat, THREE.FloatType); pts.needsUpdate = true;
    const rt = new THREE.WebGLRenderTarget(w, hgt, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const key = tier + '|' + (this.cellsBaked > 0 ? 1 : 0), cache = this.probeMats || (this.probeMats = {});
    const mat = cache[key] || (cache[key] = fsMaterial(PROBE_FRAG, { tPts: { value: null }, ...Object.fromEntries(['tWxA', 'tWxB', 'tWxC', 'tCurl', 'tNoise', 'tDetail', 'uDriftN', 'uDriftM', 'uDriftD', 'uDriftC', 'uDriftW', 'uDriftV', 'uDriftS', 'uShear', 'uAniso', 'uFogBank', 'uFogAmt', 'uWxHalf'].map((k) => [k, cu[k]])) },
      { defines: { PROBE_TIER: tier, CELLS: this.cellsBaked > 0 ? 1 : 0, FOG: 1 } }));
    mat.uniforms.tPts.value = pts;
    const prev = r.getRenderTarget();
    this.quad.draw(r, mat, rt);
    const out = new Float32Array(w * hgt * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, hgt, out);
    r.setRenderTarget(prev);
    pts.dispose(); rt.dispose();
    return out;
  }

  /** 'low' | 'med' | 'high' | 'ultra'. (A numeric scale from the old API maps to the nearest tier.) */
  setQuality(tier) {
    if (typeof tier === 'number') tier = tier < 0.45 ? 'low' : tier > 0.65 ? 'high' : 'med';
    if (!TIERS[tier] || tier === this.tier) return;
    this.tier = tier;
    this.cloudMat.defines = this.defines(); this.cloudMat.needsUpdate = true;
    this.post.setQuality(tier);
    if (this.w) this.setSize(this.w, this.h);
  }

  setSize(w, h) {
    // A change of size in flight (dynamic resolution) keeps the cloud's accumulated history: it is carried over,
    // scaled, into the new buffers (below), as the post stack does with its own (PostFX.setSize). Starting again
    // from nothing showed as a flicker of the whole picture at every step.
    const carry = !this.reset && this.w > 0 && this.hist[0] ? this.hist[(this.frame + 1) & 1] : null;
    this.w = w; this.h = h;
    this.sceneRT?.dispose(); this.cloudRT?.dispose(); this.hdrRT?.dispose();
    for (const t of this.hist) if (t !== carry) t?.dispose();
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    const s = TIERS[this.tier].scale;
    const cw = Math.max(2, Math.round(w * s)), ch = Math.max(2, Math.round(h * s));
    const mrt = (filter) => {
      const rt = new THREE.WebGLRenderTarget(cw, ch, { type: THREE.HalfFloatType, count: 2, depthBuffer: false, minFilter: filter, magFilter: filter });
      rt.textures[1].minFilter = rt.textures[1].magFilter = THREE.NearestFilter;
      return rt;
    };
    this.cloudRT = mrt(THREE.LinearFilter);    // read here texel by texel; the post stack may sample it smoothly
    this.hist = [mrt(THREE.LinearFilter), mrt(THREE.LinearFilter)];
    // The composite's two outputs: the picture, and the cloud in front of what it shows (see COMPOSITE_FRAG).
    this.hdrRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, count: 2, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    // The player's own aircraft on its own, antialiased the same way as the scene (see renderSubject).
    this.subjectRT?.dispose();
    this.subjectRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, samples: this.sceneRT.samples, depthBuffer: true,
      depthTexture: new THREE.DepthTexture(w, h, THREE.FloatType),
    });
    this.subjRect = null;                      // nothing in it yet: the first draw clears all of it
    this.post.setSize(w, h);
    if (carry) {
      const r = this.renderer, prev = r.getRenderTarget();
      if (!this.carryMat) this.carryMat = fsMaterial('precision highp float;\nuniform sampler2D tA, tB;\nin vec2 vUv;\nlayout(location = 0) out vec4 oA;\nlayout(location = 1) out vec4 oB;\nvoid main() { oA = texture(tA, vUv); oB = texture(tB, vUv); }', { tA: { value: null }, tB: { value: null } });
      this.carryMat.uniforms.tA.value = carry.textures[0]; this.carryMat.uniforms.tB.value = carry.textures[1];
      this.quad.draw(r, this.carryMat, this.hist[(this.frame + 1) & 1]);
      this.carryMat.uniforms.tA.value = this.carryMat.uniforms.tB.value = null;
      r.setRenderTarget(prev);
      carry.dispose();
    } else this.reset = true;
  }

  /** Forget accumulated history (call after teleporting the camera). */
  resetHistory() { this.reset = true; this.post.resetHistory(); }

  /**
   * Draw the player's own aircraft (fx.subject) alone into subjectRT, lit and shadowed exactly as
   * in the scene: color times coverage in rgb, coverage in alpha, and its depth. The cloud march
   * uses the depth to look through the aircraft; the composite uses the rest to lay it back on top.
   */
  renderSubject(scene, camera) {
    const r = this.renderer, rt = this.subjectRT, subj = this.fx.subject?.isObject3D && !this.ignoreSubject ? this.fx.subject : null;
    // Only the part of the screen the aircraft can touch is cleared, drawn and resolved (clearing and
    // resolving a whole multisampled target is wasted on the chase view, where the aircraft covers a
    // third of it at most): the rectangle around its bounding box, together with last frame's, so
    // what was drawn there is wiped.
    const w = rt.width, h = rt.height, prev = this.subjRect, rect = subj ? this.subjectRect(subj, camera, w, h) : [0, 0, 0, 0];
    if (!subj && prev && prev[2] === 0) return;             // nothing drawn last frame, nothing to draw now
    const full = !prev || (prev[2] - prev[0]) * (prev[3] - prev[1]) + (rect[2] - rect[0]) * (rect[3] - rect[1]) > 0.6 * w * h;
    if (full) rt.scissorTest = false;
    else {
      const x0 = Math.min(prev[2] > prev[0] ? prev[0] : w, rect[2] > rect[0] ? rect[0] : w), y0 = Math.min(prev[3] > prev[1] ? prev[1] : h, rect[3] > rect[1] ? rect[1] : h);
      const x1 = Math.max(prev[2], rect[2]), y1 = Math.max(prev[3], rect[3]);
      rt.scissorTest = true; rt.scissor.set(x0, y0, Math.max(x1 - x0, 1), Math.max(y1 - y0, 1));
    }
    this.subjRect = rect;                                    // (a full clear leaves only this to wipe next time)
    const clear = r.getClearColor(tmpC), alpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    // The aircraft and the lights go into a scene of their own for this (their places in the real
    // one are untouched): drawing the real scene again, even filtered down to the aircraft, makes
    // the renderer walk every terrain chunk and tree to find it, which cost more than all the rest of this pass.
    const own = this.subjScene || (this.subjScene = new THREE.Scene());
    if (!this.subjLights || !(this.frame % 120)) {
      const inSubj = (o) => { for (; o; o = o.parent) if (o === subj) return true; return false; };
      this.subjLights = [];
      scene.traverse((o) => { if (o.isLight && !inSubj(o)) this.subjLights.push(o); });      // (the aircraft's own lights come with it)
    }
    own.children = subj ? [subj, ...this.subjLights] : [];
    own.fog = scene.fog; own.environment = scene.environment; own.matrixWorldAutoUpdate = false;
    const auto = r.shadowMap.autoUpdate, autoClear = r.autoClear;
    r.shadowMap.autoUpdate = false; r.autoClear = false;
    r.render(own, camera);                                  // (with no subject this draws nothing, but resolves the cleared target)
    r.shadowMap.autoUpdate = auto; r.autoClear = autoClear;
    r.setClearColor(clear, alpha);
  }

  /** Pixel rectangle [x0, y0, x1, y1] of the target that holds the subject: its bounding box as the camera sees it, padded. */
  subjectRect(subj, camera, w, h) {
    if (!this.subjBox || !(this.frame % 600)) {
      // The subject's bounding box in its own frame, with room for what moves (propeller, gear, control surfaces).
      const box = this.subjBox || (this.subjBox = new THREE.Box3()), inv = tmpM.copy(subj.matrixWorld).invert();
      box.makeEmpty();
      subj.traverse((o) => {
        const g = o.geometry;
        if (!g || o.visible === false) return;
        if (!g.boundingBox) g.computeBoundingBox();
        tmpBox.copy(g.boundingBox).applyMatrix4(tmpM2.multiplyMatrices(inv, o.matrixWorld));
        box.union(tmpBox);
      });
      box.expandByVector(box.getSize(tmpV2).multiplyScalar(0.08).addScalar(0.15));
    }
    const b = this.subjBox, e = camera.projectionMatrix.elements, mv = tmpM2.multiplyMatrices(camera.matrixWorldInverse, subj.matrixWorld);
    let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
    for (let k = 0; k < 8; k++) {
      const v = tmpV2.set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).applyMatrix4(mv);
      if (-v.z <= camera.near * 1.01) return [0, 0, w, h];   // the camera is inside it (the cockpit) or it reaches behind
      const nx = (v.x * e[0]) / -v.z, ny = (v.y * e[5]) / -v.z;
      x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
    }
    const px = (n, s) => Math.min(Math.max((n * 0.5 + 0.5) * s, 0), s);
    const r = [Math.max(Math.floor(px(x0, w)) - 4, 0), Math.max(Math.floor(px(y0, h)) - 4, 0), Math.min(Math.ceil(px(x1, w)) + 4, w), Math.min(Math.ceil(px(y1, h)) + 4, h)];
    return r[2] > r[0] && r[3] > r[1] ? r : [0, 0, 0, 0];
  }

  render(scene, camera) {
    const r = this.renderer, wx = this.weather, tier = TIERS[this.tier];
    this.blendMaps();
    // Terrain cloud shadows read this; 138700 m is a common period of the scales they use.
    ENV.uCloudDrift.value.set(wx.drift.x % 138700, 0, wx.drift.z % 138700);
    const cu = this.cloudMat.uniforms, wrap = (u, s, k = 1) => u.value.set((wx.drift.x * k) % s, (wx.drift.z * k) % s);
    wrap(cu.uDriftN, NOISE_SCALE); wrap(cu.uDriftW, WARP_SCALE); wrap(cu.uDriftV, VARY_SCALE); wrap(cu.uDriftC, 6000, 0.8);      // (uDriftC: nothing in the density reads it now; kept for whoever was given CLOUD_SHADOW_UNIFORMS)
    // The lobe volume is read through a rotation: its drift is turned the same way, then wrapped to its tile.
    // (The finest detail drifts a little faster than the cloud, so edges keep changing.)
    const turned = (u, R, scale, k) => u.value.set(((R[0] * wx.drift.x + R[6] * wx.drift.z) * k) % scale, ((R[1] * wx.drift.x + R[7] * wx.drift.z) * k) % scale, ((R[2] * wx.drift.x + R[8] * wx.drift.z) * k) % scale);
    turned(cu.uDriftM, LOBE_ROT, LOBE_SCALE, 1); turned(cu.uDriftD, FINE_ROT, FINE_SCALE, 1.1);
    wrap(cu.uDriftR, 2900); wrap(cu.uDriftCi, 4.0e6, 2);      // (the high cloud is read along the grain, where no short wrap fits: it runs on unwrapped)
    const fl = Math.hypot(wx.flowX, wx.flowZ);
    cu.uShear.value.set(fl > 0.2 ? wx.flowX / fl : 1, fl > 0.2 ? wx.flowZ / fl : 0);
    // What the wind combs out (anvil fibers, rolls on a layer's top) is laid along the grain the weather holds; the drift along and across it.
    const gr = wx.grain ? wx.grain() : { x: cu.uShear.value.x, z: cu.uShear.value.y };
    cu.uAniso.value.set(gr.x, gr.z);
    cu.uDriftS.value.set((wx.drift.x * gr.x + wx.drift.z * gr.z) % 29200, (wx.drift.z * gr.x - wx.drift.x * gr.z) % 7300);

    // Fog banks: the four nearest the camera, each with how much of it there is now.
    const fogs = wx.fogs || [], fb = cu.uFogBank.value, fa = cu.uFogAmt.value, cam = camera.position;
    const near4 = fogs.length > 4 ? [...fogs].sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) - a.r - Math.hypot(b.x - cam.x, b.z - cam.z) + b.r).slice(0, 4) : fogs;
    let fogOn = false;
    for (let i = 0; i < 4; i++) {
      const f = near4[i], amt = f ? (wx.fogAmount ? wx.fogAmount(f) : 1) : 0;
      if (f) fb[i].set(f.x, f.z, f.r, f.top); else fb[i].set(0, 0, 1, -1e5);
      fa.setComponent(i, amt); fogOn = fogOn || amt > 0.001;
    }
    if (fogOn !== !!this.fogOn) { this.fogOn = fogOn; this.cloudMat.defines = this.defines(); this.cloudMat.needsUpdate = true; }

    r.setRenderTarget(this.sceneRT);
    this.post.jitter(camera);                 // TAA: a sub-pixel offset for the scene pass only
    perf.begin('scene');                      // (perf sorts its draws into 'scene: terrain', 'scene: trees', ...)
    r.render(scene, camera);
    this.renderSubject(scene, camera);        // same sub-pixel offset as the scene
    this.post.unjitter(camera);

    // 1. Ray march, jittered differently every frame.
    const pos = tmpV.setFromMatrixPosition(camera.matrixWorld);
    cu.tDepth.value = this.sceneRT.depthTexture; cu.tSubjDepth.value = this.subjectRT.depthTexture;
    cu.uProjInv.value.copy(camera.projectionMatrixInverse);
    cu.uCamWorld.value.copy(camera.matrixWorld);
    cu.uCamPos.value.copy(pos);
    cu.uNear.value = camera.near; cu.uFar.value = camera.far;
    cu.uFrame.value = this.frame % 1024;
    cu.uPixAngle.value = ((camera.fov * Math.PI) / 180) / this.cloudRT.height;
    perf.begin('cloud march');
    this.quad.draw(r, this.cloudMat, this.cloudRT);

    // 2. Temporal accumulation into the history buffer.
    const cur = this.hist[this.frame & 1], prev = this.hist[(this.frame + 1) & 1];
    const tu = this.temporalMat.uniforms;
    // The wind carries the cloud between frames; follow it, or its detail smears (worst with time sped up).
    const dx = wx.drift.x - this.prevDrift.x, dz = wx.drift.z - this.prevDrift.z;
    if (pos.distanceTo(this.prevPos) > 400 || Math.hypot(dx, dz) > 60) this.reset = true;
    const flash = ENV.uFlash.value;
    tu.tCur.value = this.cloudRT.textures[0]; tu.tCurAux.value = this.cloudRT.textures[1];
    tu.tHist.value = prev.textures[0]; tu.tHistAux.value = prev.textures[1];
    tu.uProjInv.value.copy(camera.projectionMatrixInverse);
    tu.uCamWorld.value.copy(camera.matrixWorld);
    tu.uPrevVP.value.copy(this.prevVP);
    tu.uCamDelta.value.copy(pos).sub(this.prevPos); tu.uCamDelta.value.x += dx; tu.uCamDelta.value.z += dz;
    // Lightning changes the light in one frame; let it through instead of smearing it.
    const strobe = Math.abs(flash - this.prevFlash) * 2.5 + flash * 0.4;
    tu.uAlpha.value = Math.min(1, tier.alpha + strobe);
    tu.uStill.value = strobe > 0.002 ? 1 : 5;      // still cloud may average five times longer, unless the light is changing
    tu.uReset.value = this.reset ? 1 : 0;
    perf.begin('cloud temporal');
    this.quad.draw(r, this.temporalMat, cur);

    // 3. Spatial clean-up of what the history has not smoothed yet (into the march target, which is free again).
    this.filterMat.uniforms.tCloud.value = cur.textures[0]; this.filterMat.uniforms.tCloudAux.value = cur.textures[1];
    perf.begin('cloud resolve');
    this.quad.draw(r, this.filterMat, this.cloudRT);

    // 4. Composite over the scene, then post-process to the screen.
    const co = this.compMat.uniforms;
    co.tScene.value = this.sceneRT.texture;
    co.tCloud.value = this.cloudRT.textures[0]; co.tCloudAux.value = this.cloudRT.textures[1];
    co.tDepth.value = this.sceneRT.depthTexture;
    co.tSubject.value = this.subjectRT.texture; co.tSubjDepth.value = this.subjectRT.depthTexture;
    // Fog between the eye and the aircraft: the large-scale cloud density around the camera.
    let sig = 0, dist = 15;
    const sj = this.fx.subject?.isObject3D ? this.fx.subject : null;
    if (sj && wx.column && wx.density) {
      const sp = tmpV2.setFromMatrixPosition(sj.matrixWorld);
      dist = Math.max(pos.distanceTo(sp), 0.5);
      const col = this.col || (this.col = {});
      for (const k of [0, 0.5]) {
        const x = pos.x + (sp.x - pos.x) * k, y = pos.y + (sp.y - pos.y) * k, z = pos.z + (sp.z - pos.z) * k;
        sig += 0.5 * (wx.density(x, y, z, wx.column(x, z, col)) || 0);
      }
    }
    co.uNearSigma.value = sig; co.uSubjDist.value = dist;
    co.uNear.value = camera.near; co.uFar.value = camera.far;
    perf.begin('cloud composite');
    this.quad.draw(r, this.compMat, this.hdrRT);
    perf.end();

    // Leaving the atmosphere, the view from space (space/mission.js sets mixIn: { texture, f }) is faded in over this picture.
    let hdr = this.hdrRT.textures[0];
    if (this.mixIn && this.mixIn.f > 0) {
      const w = this.hdrRT.width, h = this.hdrRT.height;
      if (!this.mixRT || this.mixRT.width !== w || this.mixRT.height !== h) { this.mixRT?.dispose(); this.mixRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }); }
      const mm = this.mixMat || (this.mixMat = fsMaterial('precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D tA, tB; uniform float uMix; void main() { o = mix(texture(tA, vUv), texture(tB, vUv), uMix); }', { tA: { value: null }, tB: { value: null }, uMix: { value: 0 } }));
      mm.uniforms.tA.value = hdr; mm.uniforms.tB.value = this.mixIn.texture; mm.uniforms.uMix.value = Math.min(this.mixIn.f, 1);
      this.quad.draw(r, mm, this.mixRT);
      hdr = this.mixRT.texture;
    }
    this.post.flashExtra = this.uFlashScreen.value;
    this.post.render(hdr, camera, null, { depth: this.sceneRT.depthTexture, scene: this.sceneRT.texture, cloud: this.hdrRT.textures[1] });

    // Remember this camera for next frame's reprojection (rotation only; translation goes in uCamDelta).
    tmpM.copy(camera.matrixWorldInverse).setPosition(0, 0, 0);
    this.prevVP.multiplyMatrices(camera.projectionMatrix, tmpM);
    this.prevPos.copy(pos); this.prevFlash = flash; this.prevDrift.x = wx.drift.x; this.prevDrift.z = wx.drift.z;
    this.reset = false; this.frame++;
  }
}
