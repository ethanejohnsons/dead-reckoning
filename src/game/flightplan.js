// Flight planning: the dispatch board's offers, and the briefing sheet's
// numbers (course, safe altitude, wind-corrected heading, hazards en route).

import { AIRPORTS, airportById } from '../world/airports.js';
import { height } from '../world/terrain.js';
import { SITUATIONS } from '../weather/weather.js';
import { bearing, windCorrection } from '../core/nav.js';
import { NM, FT } from '../aircraft/physics.js';
import { mulberry32 } from '../core/noise.js';

export const CRUISE_TAS = 72;                   // m/s, about 140 knots

const routeOf = (a, b) => ({ ax: a.x, az: a.z, bx: b.x, bz: b.z, from: a.id, to: b.id });

/** Which situations make sense for this pair of airfields. */
function plausible(kind, a, b) {
  if (kind === 'winter') return Math.min(a.z, b.z) < -50000;
  if (kind === 'monsoon') return Math.max(a.z, b.z) > 55000;
  if (kind === 'fog') return b.elev < 90;
  return true;
}

/** Four flights on offer from an airfield. Stable for a given logbook length. */
export function makeOffers(fromId, flightsFlown) {
  const from = airportById(fromId), rnd = mulberry32(flightsFlown * 131 + fromId.charCodeAt(0) * 7 + fromId.charCodeAt(2));
  const others = AIRPORTS.filter((a) => a !== from).map((a) => ({ a, d: Math.hypot(a.x - from.x, a.z - from.z) })).sort((p, q) => p.d - q.d);
  const pick = (lo, hi, used) => {
    const pool = others.filter((o, i) => i >= lo && i < hi && !used.has(o.a));
    const o = pool[Math.floor(rnd() * pool.length)] || others.find((x) => !used.has(x.a));
    used.add(o.a); return o.a;
  };
  const used = new Set();
  const dests = [pick(0, 3, used), pick(1, 6, used), pick(3, 9, used), pick(6, 13, used)];
  const kinds = Object.keys(SITUATIONS), usedK = new Set(), offers = [];
  dests.forEach((to, i) => {
    let pool = kinds.filter((k) => !usedK.has(k) && plausible(k, from, to));
    // The first offer is always a gentle one; the first ever flight is fair weather.
    if (i === 0) pool = pool.filter((k) => SITUATIONS[k].difficulty <= (flightsFlown === 0 ? 1 : 2));
    if (!pool.length) pool = ['fair'];
    const kind = pool[Math.floor(rnd() * pool.length)];
    usedK.add(kind);
    const hrs = SITUATIONS[kind].hours;
    offers.push({ from: from.id, to: to.id, kind, hour: hrs[Math.floor(rnd() * hrs.length)], seed: 1 + Math.floor(rnd() * 1e6) });
  });
  return offers;
}

/** Everything on the briefing sheet. Call after weather.setup() for this flight. */
export function makePlan(offer, weather) {
  const a = airportById(offer.from), b = airportById(offer.to), route = routeOf(a, b);
  const dist = Math.hypot(b.x - a.x, b.z - a.z), course = bearing(a.x, a.z, b.x, b.z);
  const ux = (b.x - a.x) / dist, uz = (b.z - a.z) / dist;

  // Minimum safe altitude: highest ground within ~6 km of track, plus 1,500 ft.
  let top = 0;
  for (let s = 0; s <= dist; s += 2500) for (const off of [-6000, 0, 6000]) top = Math.max(top, height(a.x + ux * s - uz * off, a.z + uz * s + ux * off, 1));
  const msaFt = Math.ceil(((top * FT) + 1500) / 500) * 500;
  const cruiseFt = Math.min(13500, Math.max(msaFt, 4500));
  const cruiseM = cruiseFt / FT;

  const pts = [0.1, 0.5, 0.9].map((t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }));
  const winds = pts.map((p) => weather.windAloft(p.x, p.z, cruiseM));
  const mean = { x: (winds[0].x + winds[1].x + winds[2].x) / 3, z: (winds[0].z + winds[1].z + winds[2].z) / 3 };
  const wc = windCorrection(course, CRUISE_TAS, mean);
  const ete = dist / Math.max(wc.gs, 20) + 150;

  // Hazard scan along the route (one line per kind of hazard)
  const hz = new Map(), c = {};
  let maxWind = 0, minFl = Infinity;
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    weather.column(x, z, c);
    const terr = height(x, z, 1), fl = (weather.grid(weather.tsea, x, z) + weather.tAnom - 6.5 * c.cold) / 0.0065;
    if (c.cell > 0.25 || c.front > 0.3) hz.set('ts', 'Thunderstorms on or near track. Severe turbulence and downdraughts inside; go around them.');
    if (c.cov > 0.55 && c.fog < 0.3 && c.base - Math.max(terr, 0) < 380) hz.set('ceil', 'Low ceilings: cloud base within 1,200 ft of the ground in places.');
    if (c.cov > 0.5 && terr > c.base + 100 && terr > 600) hz.set('obsc', 'High ground hidden in cloud along the route.');
    if (c.cov > 0.4 && fl < Math.min(c.top, cruiseM + 400)) minFl = Math.min(minFl, fl);
    if (c.precip > 0.35) hz.set('precip', fl < 300 ? 'Snow reducing visibility.' : 'Heavy rain reducing visibility.');
    const w = weather.windAloft(x, z, cruiseM); maxWind = Math.max(maxWind, w.kt);
  }
  if (!hz.has('ts') && weather.cells.length) hz.set('ts', 'Scattered thunderstorm cells in the area. Give each one a wide berth.');
  if (minFl < Infinity) hz.set('ice', minFl < 200 ? 'Freezing at the surface: ice will build in any cloud.' : `Icing in cloud above the freezing level (about ${(Math.round((minFl * FT) / 500) * 500).toLocaleString()} ft).`);
  if (maxWind > 28) hz.set('wind', `Strong winds aloft, up to ${Math.round(maxWind)} kt. Uncorrected drift would be about ${Math.round(Math.atan(maxWind / 140) * 57.3)}°.`);
  if (maxWind > 24 && top > 1300) hz.set('wave', 'Mountain wave and lee-side turbulence near the high ground.');
  const depWx = weather.report(a.x, a.z, a.elev), dstWx = weather.report(b.x, b.z, b.elev);
  if (dstWx.fog) hz.set('fog', 'Fog at the destination. Home on the beacon and descend with great care.');
  const sw = weather.wind(b.x, b.z, b.elev + 10, b.elev, { x: 0, z: 0 });
  const xw = Math.abs(sw.x * -b.uz + sw.z * b.ux) * 1.944;
  if (xw > 10) hz.set('xw', `Crosswind of about ${Math.round(xw)} kt on the destination runway.`);
  if (dstWx.gust) hz.set('gust', `Gusts to ${dstWx.gust} kt at the destination.`);
  if (!hz.size) hz.set('none', 'No significant weather.');

  return {
    ...offer, a, b, route, dist, course, msaFt, cruiseFt, winds, wc, ete,
    depWx, dstWx, hazards: [...hz.values()], sit: SITUATIONS[offer.kind],
  };
}

export const fmtHdg = (d) => String(Math.round(d) % 360 || 360).padStart(3, '0') + '°';
export const fmtTime = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };
export const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
export const nm = (m) => m / NM;
