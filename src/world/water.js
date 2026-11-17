// Which pixels of an elevation tile are water. There is no list of lakes: the answer comes from the
// data alone, by rules that hold for the United States' elevation data at every zoom the terrain uses.
//
// What the data looks like (checked on tiles from Michigan to Montana):
//   zoom 11 and finer   meters with fractions (the USGS 3DEP survey). Water bodies are leveled: a lake is one
//                       value, give or take the 4 mm the tiles are stored to, or a plane tilting by a few
//                       millimeters a pixel. The flattest farmland (the Red River valley) still wanders by
//                       centimeters from pixel to pixel, so none of it passes as level.
//   zoom 10 and coarser whole meters. Water is one value here too, but so are terraces of the plains a few
//                       pixels across, where the land falls less than a meter in a kilometer.
// So: a patch of pixels each level with all its neighbors is water if it is big enough for its zoom
// (a few acres in the fine data; some square kilometers in the coarse data, where only the larger
// lakes can be told from terraces). Rivers that flow are not leveled in the survey and are not found.
//
// Two traps:
//   Under big cities (Chicago above all) the survey has dead-level blobs hundreds of meters across where
//   buildings were taken out. A lake has banks; these have none: the ground stays within a hand's breadth
//   of their level for 150 m all around. Such patches are marked doubtful (2) rather than water (1), at the
//   one zoom where a tile is wide enough to judge it, and the game drops the doubtful ones where the map
//   says the land is built up. The Great Lakes have beaches as flat as that and cities on them, so a patch
//   at a Great Lake's own level, where that lake is, is never doubted (the only list in here: five levels).
//   The Great Lakes were leveled a survey quadrangle at a time, to slightly different heights, and the
//   joins are ramps a hundred meters wide: they are filled in (step 3b).
//   Where the fine data is not the survey but something stored in whole meters and resampled (Hawaii, and
//   much of the world beyond the United States), every gentle slope is a staircase of dead-level terraces,
//   each of them "a patch of pixels at one level": a coastal plain a meter above the sea read as sea, and
//   the terraces behind it as lakes, so Honolulu stood under water. Such a tile gives itself away: its level
//   patches sit on exact whole numbers, at more than one height. In one, only the sea is water (what lies
//   below zero, and level ground at zero); its lakes cannot be told from its terraces and are left as land.

const N = 256, NN = N * N;
const TOL = 0.011;                      // level means within this of every neighbor (m)
// Smallest patch that can be water, in pixels of its level core, by zoom (a pixel is about 7 m at zoom 14
// and doubles each step down). A patch that runs off the edge of the tile may be the corner of something
// bigger, and gets by on half of this.
const MIN_AREA = (z) => (z >= 14 ? 900 : z === 13 ? 240 : z === 12 ? 56 : z === 11 ? 12 : z === 10 ? 300 : z === 9 ? 48 : z === 8 ? 10 : 8);
const SEA = 1.0;
const SEAM_LAKE = 3000;                 // joins are only looked for between patches of this many pixels: pieces of one big lake
// (one of the two must be that big; the other may be a tenth of it, since a tile's edge cuts a lake's pieces short. On a
// Great Lake any piece will do: beside a join the resampling leaves a shelf of a few dozen level pixels, a patch of its own.)
const bigPair = (a, b, great) => Math.max(a, b) >= SEAM_LAKE && (great || Math.min(a, b) >= SEAM_LAKE / 10);
const SEAM = 0.006;                     // see step 3b: how far a join's ramp may step back (the tiles are stored to 4 mm)
// The doubt is judged at one zoom only, where a tile (14 km) is wide enough to take in a blob and the ground
// around it; the game looks there for every finer patch. Nothing over DOUBT_MAX pixels (6 km2) is doubted.
export const DOUBT_Z = 11;
const DOUBT_MAX = 2000;
const BANK = 0.3, BANK_SHARE = 0.05;    // a lake's surroundings: this share of the ground about 150 m out from its edge differs from its level by this much (m)
// The Great Lakes: surface level in the survey (m), south, north, west, east.
export const GREAT_LAKES = [[183.0, 46.3, 49.1, -92.4, -84.2], [176.3, 41.5, 46.4, -88.2, -79.6], [174.9, 42.2, 43.1, -83.3, -82.3], [173.8, 41.3, 43.0, -83.7, -78.8], [74.6, 43.1, 44.4, -79.9, -75.9]];

// Where the fine data is known to be in whole meters, whatever a single tile shows (a tile with one terrace and
// the sea has only one level to give itself away by): south, north, west, east. The Hawaiian islands.
const WHOLE_METERS = [[18.5, 22.6, -161, -154.5]];
const WHOLE = 0.002;                    // a height is a whole number of meters within this (the tiles are stored to 4 mm)

const stack = new Int32Array(NN), seen = new Uint8Array(NN), owner = new Int32Array(NN);

/**
 * z, x, y: the tile; h: its 256 x 256 heights (m). Returns 256 x 256 of 0 (land), 1 (water) or, at zoom
 * DOUBT_Z, 2 (level like water, but with no bank anywhere around it: not to be believed in a city).
 */
export function waterMask(z, x, y, h) {
  const w = new Uint8Array(NN), flat = new Uint8Array(NN);
  // 1. Level pixels: the whole 3 x 3 neighborhood within the tolerance.
  for (let j = 0; j < N; j++) {
    const j0 = (j > 0 ? j - 1 : 0) * N, j1 = j * N, j2 = (j < N - 1 ? j + 1 : j) * N;
    for (let i = 0; i < N; i++) {
      const c = h[j1 + i], a = i > 0 ? i - 1 : 0, b = i < N - 1 ? i + 1 : i;
      flat[j1 + i] = Math.abs(h[j0 + a] - c) <= TOL && Math.abs(h[j0 + i] - c) <= TOL && Math.abs(h[j0 + b] - c) <= TOL
        && Math.abs(h[j1 + a] - c) <= TOL && Math.abs(h[j1 + b] - c) <= TOL
        && Math.abs(h[j2 + a] - c) <= TOL && Math.abs(h[j2 + i] - c) <= TOL && Math.abs(h[j2 + b] - c) <= TOL ? 1 : 0;
    }
  }
  // Where this tile is, for the Great Lakes' levels.
  const n2 = 2 ** z, lon = ((x + 0.5) / n2) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n2))) * 180) / Math.PI;
  const lakes = GREAT_LAKES.filter((l) => lat > l[1] - 0.3 && lat < l[2] + 0.3 && lon > l[3] - 0.3 && lon < l[4] + 0.3);
  // 2. Level patches, one at a time: big enough to be a lake, or at sea level.
  seen.fill(0); owner.fill(0);
  const minArea = MIN_AREA(z), sizes = [0], patches = [];
  let id = 0;
  for (let start = 0; start < NN; start++) {
    if (!flat[start] || seen[start]) continue;
    id++;
    let n = 0, top = 0, edge = false, sum = 0, ints = 0;
    const members = [];
    stack[top++] = start; seen[start] = 1;
    while (top) {
      const k = stack[--top], i = k & 255, j = k >> 8;
      members.push(k); n++; sum += h[k]; owner[k] = id;
      if (Math.abs(h[k] - Math.round(h[k])) < WHOLE) ints++;
      if (i === 0 || j === 0 || i === N - 1 || j === N - 1) edge = true;
      if (i > 0 && flat[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[top++] = k - 1; }
      if (i < N - 1 && flat[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[top++] = k + 1; }
      if (j > 0 && flat[k - N] && !seen[k - N]) { seen[k - N] = 1; stack[top++] = k - N; }
      if (j < N - 1 && flat[k + N] && !seen[k + N]) { seen[k + N] = 1; stack[top++] = k + N; }
    }
    sizes.push(n);
    patches.push({ id, members, n, edge, level: sum / n, whole: ints >= 0.6 * n });
  }
  // Is this tile whole-meter data (see the traps above)? Its level patches are then on whole numbers, at two heights or more.
  let wholePx = 0, flatPx = 0;
  const heights = new Set();
  for (const p of patches) {
    if (lakes.some((l) => Math.abs(p.level - l[0]) < 2)) continue;
    flatPx += p.n;
    if (p.whole) { wholePx += p.n; if (p.n >= 20) heights.add(Math.round(p.level)); }
  }
  // (Only in the fine data: from zoom 10 down every tile is in whole meters, and the patch sizes asked for there allow for it.)
  const terraced = z >= 11 && ((heights.size >= 2 && wholePx >= 0.7 * flatPx) || WHOLE_METERS.some((b) => lat > b[0] && lat < b[1] && lon > b[2] && lon < b[3]));
  for (const p of patches) {
    const { id, members, n, edge, level } = p;
    if (terraced ? level > 0.5 : level > SEA && n < (edge ? minArea / 2 : minArea)) continue;
    let code = 1;
    if (!terraced && z === DOUBT_Z && level > SEA && n < DOUBT_MAX && !lakes.some((l) => Math.abs(level - l[0]) < 2)) {
      // Has it banks? Look three pixels (about 150 m) out from its edge, eight ways.
      const D = 3;
      let ring = 0, relief = 0;
      for (const k of members) {
        const i = k & 255, j = k >> 8;
        if (i > 0 && i < N - 1 && j > 0 && j < N - 1 && owner[k - 1] === id && owner[k + 1] === id && owner[k - N] === id && owner[k + N] === id) continue;
        for (let dj = -D; dj <= D; dj += D) {
          const jj = j + dj;
          if (jj < 0 || jj >= N) continue;
          for (let di = -D; di <= D; di += D) {
            const ii = i + di;
            if (ii < 0 || ii >= N || (!di && !dj)) continue;
            const q = jj * N + ii;
            if (owner[q] === id) continue;
            ring++;
            if (Math.abs(h[q] - level) > BANK) relief++;
          }
        }
      }
      if (ring > 24 && relief < BANK_SHARE * ring) code = 2;
    }
    for (const k of members) w[k] = code;
  }
  // 3. Out onto the shoreline: a pixel beside a water pixel and at its level is water too.
  const grown = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (w[k] || flat[k]) continue;                       // level pixels were judged with their patch
    const c = h[k];
    let found = 0;
    for (let dj = -1; dj <= 1 && !found; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= N) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= N) continue;
        const q = jj * N + ii;
        if (flat[q] && w[q] && Math.abs(h[q] - c) <= TOL) { found = w[q]; owner[k] = owner[q]; break; }
      }
    }
    if (found) grown.push(k, found);
  }
  for (let g = 0; g < grown.length; g += 2) w[grown[g]] = grown[g + 1];
  // 3b. Seams. A big lake is leveled quadrangle by quadrangle of the survey, a few centimeters or decimeters
  // apart, and along the joins the tiles ramp from one level to the other: bands of "land" a hundred meters
  // wide, straight across the water. A short run (up to about 700 m) of pixels along a row or a column, with
  // big water at both ends and climbing steadily from the one level to the other, is water.
  if (z >= 11) {
    const great = (v) => lakes.some((l) => Math.abs(v - l[0]) < 5);
    const reach = 14 * 2 ** (z - 11), run = (step, count, at) => {
      for (let line = 0; line < N; line++) {
        let last = -1;                                          // index along the line of the last water pixel
        for (let p = 0; p < N; p++) {
          const k = at(line, p);
          if (!w[k]) continue;
          if (last >= 0 && p - last > 1 && p - last - 1 <= reach && bigPair(sizes[owner[k]], sizes[owner[at(line, last)]], great(h[k]) && great(h[at(line, last)]))) {
            // The ramp of a join climbs steadily from one level to the other; ground between two ponds does not.
            // (Round Duluth the pieces of Lake Superior stand as much as four meters apart, and the filter that
            // resampled the tiles rings beside a step: it steps back by up to an eighth of the step in one pixel,
            // on either side. Allowing a twentieth left most joins on the open lake as dark straight bands.)
            const k0 = at(line, last), gap = Math.abs(h[k] - h[k0]), sign = h[k] >= h[k0] ? 1 : -1, back = SEAM + 0.15 * gap;
            let ok = gap < 5, prev = h[k0];
            for (let q = last + 1; q <= p && ok; q++) { const v = h[at(line, q)]; if ((v - prev) * sign < -back) ok = false; prev = v; }
            if (ok) { const code = Math.min(w[k0], w[k]); for (let q = last + 1; q < p; q++) { w[at(line, q)] = code; owner[at(line, q)] = owner[k]; } }
          }
          last = p;
        }
      }
    };
    const row = (j, i) => j * N + i, col = (i, j) => j * N + i;
    run(1, N, row); run(N, N, col); run(1, N, row);
  }
  // 4. The sea: everything below zero, and the stray ridges a pixel or two wide and under a meter high that
  // the surveys leave in it (flooded from the sea beside them, a few pixels at most).
  let sea = false;
  const shore = terraced ? 0.5 : 1.2;                    // (a terrace a meter up is the land's first step, not a ridge in the sea)
  for (let k = 0; k < NN; k++) if (h[k] < 0) { w[k] = 1; sea = true; }
  if (sea) {
    for (let pass = 0; pass < 3; pass++) {
      const add = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i;
        if (w[k] || h[k] > shore) continue;
        const s = (q) => w[q] && h[q] <= shore;
        if ((i > 0 && s(k - 1)) || (i < N - 1 && s(k + 1)) || (j > 0 && s(k - N)) || (j < N - 1 && s(k + N))) add.push(k);
      }
      if (!add.length) break;
      for (const k of add) w[k] = 1;
    }
    // 4b. Along some coasts (Maine's) the sea is not leveled at all: it is a smooth sheet wandering a meter either
    // side of zero, interpolated between soundings, with level patches here and there. The ramps between them, left
    // as land, drew the patches' outlines across open water as lines of surf. Such a ramp is glassy: it bends by a
    // few centimeters a pixel at most, where the land round Frenchman Bay bends by tens of centimeters. So the sea
    // floods on, as far as it likes, over ground as low as the shore rule allows that is that smooth.
    if (!terraced) {
      // (The test is per pixel, and the fill spreads only where most pixels pass: on the Chesapeake's marshes, as low and
      // nearly as smooth, a fifth to a third of them pass at this bend, not enough to carry it; on Maine's sea, three quarters.)
      const bend = 0.015;
      // (the bend across three pixels, moved inward at the tile's edge)
      const smooth = (k, i, j) => {
        const a = k + (i === 0 ? 1 : i === N - 1 ? -1 : 0), b = k + (j === 0 ? N : j === N - 1 ? -N : 0);
        return Math.abs(h[a - 1] + h[a + 1] - 2 * h[a]) < bend && Math.abs(h[b - N] + h[b + N] - 2 * h[b]) < bend;
      };
      let top = 0;
      for (let k = 0; k < NN; k++) if (w[k] === 1 && h[k] <= shore) stack[top++] = k;
      while (top) {
        const k = stack[--top], i = k & 255, j = k >> 8;
        const go = (q, qi, qj) => { if (!w[q] && h[q] <= shore && smooth(q, qi, qj)) { w[q] = 1; stack[top++] = q; } };
        if (i > 0) go(k - 1, i - 1, j);
        if (i < N - 1) go(k + 1, i + 1, j);
        if (j > 0) go(k - N, i, j - 1);
        if (j < N - 1) go(k + N, i, j + 1);
      }
      // and what is left between the patches, where the sheet steps by a few centimeters: low ground in small
      // pieces with sea all round (nothing higher than the shore rule touches them, and they stop short of the tile's edge)
      seen.fill(0);
      const piece = [];
      for (let k0 = 0; k0 < NN; k0++) {
        if (w[k0] || seen[k0] || h[k0] > shore) continue;
        piece.length = 0; seen[k0] = 1; top = 0; stack[top++] = k0;
        let open = false;
        while (top) {
          const k = stack[--top], i = k & 255, j = k >> 8;
          piece.push(k);
          if (i === 0 || i === N - 1 || j === 0 || j === N - 1) open = true;
          for (const q of [i > 0 ? k - 1 : -1, i < N - 1 ? k + 1 : -1, j > 0 ? k - N : -1, j < N - 1 ? k + N : -1]) {
            if (q < 0 || w[q] || seen[q]) continue;
            if (h[q] > shore) { open = true; continue; }
            seen[q] = 1; stack[top++] = q;
          }
        }
        if (!open && piece.length <= 64) for (const k of piece) w[k] = 1;
      }
    }
  }
  return w;
}
