// Airfields of the continent. Each has a target location; at startup we search
// nearby for the flattest dry ground and grade a runway into the terrain.

import { rawHeight, setFlats } from './terrain.js';

// id, name, x km, z km, runway length m, surface, blurb
const DEFS = [
  ['HAL', 'Port Halcyon', -112, 84, 1800, 'paved', 'Southwest harbour town. The main hub.'],
  ['GRW', 'Greywater', -150, -22, 1500, 'paved', 'West-coast fishing port, famous for its sea fog.'],
  ['NET', 'Nettle Bay', -104, -112, 1300, 'gravel', 'Cold northwest inlet under the Northern Range.'],
  ['SBR', 'Saint Brannoc', -6, -150, 1400, 'gravel', 'Tundra outpost on the north shore.'],
  ['VAN', 'Vantry', 108, -106, 1500, 'paved', 'Northeast market town.'],
  ['MRL', "Morrow's Landing", 150, -4, 1600, 'paved', 'East-coast port on the dry side of the mountains.'],
  ['CIN', 'Cinder Flats', 66, 34, 1700, 'gravel', 'Desert strip in the rain shadow. Hot, high thermals.'],
  ['LMW', 'Low Marrow', 34, -44, 1400, 'paved', 'Farm country east of the spine.'],
  ['THW', 'Thornwick Gap', -34, 30, 1100, 'gravel', 'Short strip in a pass through the spine.'],
  ['HMR', 'Highmoor', -40, -66, 1200, 'gravel', 'High moorland field. Mind the density altitude.'],
  ['ASH', 'Ashgrove', -88, 16, 1300, 'paved', 'Timber town in the wet western foothills.'],
  ['SAB', 'Sable Point', 116, 104, 1500, 'paved', 'Southeast cape, first landfall for tropical squalls.'],
  ['KES', 'Kestrel Rock', 24, 176, 1200, 'paved', 'Island field far off the south coast.'],
  ['CAL', 'Calder Island', -98, 156, 1300, 'paved', 'Tropical island strip in the southwest.'],
];

export const AIRPORTS = [];
export const airportById = (id) => AIRPORTS.find((a) => a.id === id);

function siteCost(x, z, ux, uz, len) {
  let lo = 1e9, hi = -1e9, sum = 0, n = 0;
  for (let i = -4; i <= 4; i++) {
    const t = (i / 4) * (len / 2 + 250);
    for (let j = -1; j <= 1; j++) {
      const px = x + ux * t - uz * j * 220, pz = z + uz * t + ux * j * 220;
      const h = rawHeight(px, pz, 1);
      if (h < 6) return null;
      if (h < lo) lo = h; if (h > hi) hi = h;
      sum += h; n++;
    }
  }
  return { range: hi - lo, elev: sum / n };
}

function findSite(tx, tz, len) {
  let best = null;
  for (let ring = 0; ring <= 40; ring++) {
    const rad = ring * 1500, steps = ring === 0 ? 1 : Math.min(24, 6 + ring * 2);
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2 + ring * 0.7;
      const x = tx + Math.cos(a) * rad, z = tz + Math.sin(a) * rad;
      // Cheap prefilter: five points must be dry and roughly level.
      let lo = 1e9, hi = -1e9, wet = false;
      for (const [ox, oz] of [[0, 0], [700, 0], [-700, 0], [0, 700], [0, -700]]) {
        const h = rawHeight(x + ox, z + oz, 1);
        if (h < 6 || h > 2300) { wet = true; break; }
        if (h < lo) lo = h; if (h > hi) hi = h;
      }
      if (wet || hi - lo > 90) continue;
      for (let o = 0; o < 6; o++) {
        const hdg = o * 30 + ((ring * 7 + s * 3) % 3) * 10;
        const th = (hdg * Math.PI) / 180;
        const ux = Math.sin(th), uz = -Math.cos(th);
        const c = siteCost(x, z, ux, uz, len);
        if (!c) continue;
        const cost = c.range + rad * 0.0012;
        if (!best || cost < best.cost) best = { cost, x, z, hdg, ux, uz, elev: c.elev, range: c.range };
      }
    }
    if (best && best.cost < 14 + ring * 1.2) break;
  }
  return best;
}

export function initAirports() {
  if (AIRPORTS.length) return AIRPORTS;
  for (const [id, name, xk, zk, len, surface, blurb] of DEFS) {
    const s = findSite(xk * 1000, zk * 1000, len);
    if (!s) { console.warn('No site for airport', id); continue; }
    const n1 = ((Math.round(s.hdg / 10) + 35) % 36) + 1, n2 = ((n1 + 17) % 36) + 1;
    AIRPORTS.push({
      id, name, blurb, surface, len, width: surface === 'paved' ? 30 : 24,
      x: s.x, z: s.z, elev: Math.max(s.elev, 8), hdg: s.hdg, ux: s.ux, uz: s.uz,
      numbers: [String(n1).padStart(2, '0'), String(n2).padStart(2, '0')],
    });
  }
  setFlats(AIRPORTS.map((a) => ({
    x: a.x, z: a.z, ux: a.ux, uz: a.uz, elev: a.elev,
    half: a.len / 2 + 180, r0: 280, r1: 1500, R: a.len / 2 + 180 + 1500,
  })));
  return AIRPORTS;
}

/** Signed along/cross-track position of a point relative to a runway centreline. */
export function runwayCoords(a, x, z) {
  const dx = x - a.x, dz = z - a.z;
  return { along: dx * a.ux + dz * a.uz, cross: dx * -a.uz + dz * a.ux };
}

export function nearestAirport(x, z) {
  let best = null, bd = Infinity;
  for (const a of AIRPORTS) {
    const d = Math.hypot(a.x - x, a.z - z);
    if (d < bd) { bd = d; best = a; }
  }
  return { airport: best, dist: bd };
}
