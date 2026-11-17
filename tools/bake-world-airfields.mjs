#!/usr/bin/env node
// Bakes the airfields of the rest of the world from OurAirports (ourairports.com, public domain) into
// public/data/world-airfields.json: every large and medium airport on earth that the game does not already
// have in detail (src/world/airfield-index.js, baked from OpenStreetMap by fetch-airfields.mjs), with the two
// ends, width and surface of each of its runways. The game lists them beside the detailed fields and lays out
// a plain field for each from its runways (src/world/airports.js: worldData).
//
//   curl -LO https://davidmegginson.github.io/ourairports-data/airports.csv     (and runways.csv, countries.csv, regions.csv)
//   node tools/bake-world-airfields.mjs DIR            DIR: the folder the four files are in
//
// Run it again after fetch-airfields.mjs has added detailed fields: a field baked there is left out here.
//
// The file: { credit, countries: { code: name }, fields: [[id, name, city, region, country code, big (1: a large
// airport), runways]] }, runways: [[designator, designator, lat, lon, lat, lon (the two ends, in the designators'
// order), width (m), surface (a asphalt, c concrete, g grass, v gravel), displaced threshold at each end (m)]],
// the main runway (the longest paved one) first. Sorted by country, region and name: the order of the menu.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIRFIELD_INDEX } from '../src/world/airfield-index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/world-airfields.json');
const DIR = process.argv[2];
if (!DIR) { console.error('usage: node tools/bake-world-airfields.mjs <folder with airports.csv, runways.csv, countries.csv, regions.csv>'); process.exit(1); }

// Small fields worth having all the same: mountain strips and islands people fly to for their own sake.
const EXTRA = new Set(['VNLK', 'LFLJ', 'LSZS', 'LSGS', 'LOWZ', 'EGHE', 'EGPR', 'BGBW', 'BGGH', 'NZMF', 'FHSH', 'SCIP', 'SEGS', 'EGYP', 'ENSB', 'VNJS', 'VNSB', 'LIMW', 'LFKC', 'EKVG', 'NTTB', 'NCRG', 'FMEE', 'TFFJ', 'TNCS', 'LXGB']);

/** A CSV file as a list of objects, by its header row. (Quoted fields, doubled quotes inside them.) */
function csv(name) {
  const text = readFileSync(join(DIR, name), 'utf8'), rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const D2R = Math.PI / 180, FT = 0.3048;
const dist = (lat1, lon1, lat2, lon2) => { let dl = lon2 - lon1; dl -= 360 * Math.round(dl / 360); return Math.hypot((lat2 - lat1) * 111200, dl * 111200 * Math.cos(((lat1 + lat2) / 2) * D2R)); };
const num = (v) => (v === '' || v == null ? NaN : +v);

// The countries the game already groups by region in the menu, and the territories it lists under the United States.
const CENTRAL = new Set(['BZ', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA']);
const CARIBBEAN = new Set(['BS', 'CU', 'JM', 'HT', 'DO', 'KY', 'TC', 'VG', 'AI', 'MF', 'SX', 'BL', 'KN', 'AG', 'MS', 'GP', 'DM', 'MQ', 'LC', 'VC', 'BB', 'GD', 'TT', 'AW', 'CW', 'BQ', 'BM']);
const US_TERRITORY = { PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', MP: 'Northern Mariana Islands', AS: 'American Samoa' };
// A few names as US English has them.
const COUNTRY_NAME = { BS: 'The Bahamas', CZ: 'Czechia', CI: 'Ivory Coast', CD: 'Democratic Republic of the Congo', CG: 'Republic of the Congo', TR: 'Turkey', MM: 'Myanmar', TL: 'East Timor', CV: 'Cape Verde', SZ: 'Eswatini', MK: 'North Macedonia', VA: 'Vatican City', FM: 'Micronesia', BQ: 'Caribbean Netherlands' };

function surface(s) {
  const t = String(s || '').toUpperCase();
  if (/WATER/.test(t)) return null;
  if (/CON|PCC|PEM|CEMENT/.test(t) && !/ASP|BIT/.test(t)) return 'c';
  if (/ASP|BIT|TAR|PAVED|MAC|SEAL|PSP|MET|COP|BRI/.test(t)) return 'a';
  if (/GRS|GRASS|TURF|SOD/.test(t)) return 'g';
  if (/GR|GVL|DIRT|EARTH|SAND|CLAY|LAT|SOIL|CORAL|ICE|SNOW|UNPAVED|ROCK|SHALE|CALICHE|MUD|CAL/.test(t)) return 'v';
  return '';                                               // not said: paved at an airport of this size
}

const countries = Object.fromEntries(csv('countries.csv').map((c) => [c.code, COUNTRY_NAME[c.code] || c.name]));
const regions = Object.fromEntries(csv('regions.csv').map((r) => [r.code, r.name]));
const runwaysOf = new Map();
for (const r of csv('runways.csv')) { if (!runwaysOf.has(r.airport_ref)) runwaysOf.set(r.airport_ref, []); runwaysOf.get(r.airport_ref).push(r); }

const have = new Set(AIRFIELD_INDEX.map((f) => f.id));
const fields = [], seen = new Set(), used = new Set();
let noRunway = 0, guessed = 0, dupe = 0;
for (const a of csv('airports.csv')) {
  const code = [a.icao_code, a.gps_code, a.ident].find((c) => /^[A-Z0-9]{3,4}$/.test(c || '')) || a.ident;
  const wanted = a.type === 'large_airport' || a.type === 'medium_airport' || EXTRA.has(code) || EXTRA.has(a.ident);
  if (!wanted || !/^[A-Z0-9-]{2,7}$/.test(code)) continue;
  const lat = num(a.latitude_deg), lon = num(a.longitude_deg);
  if (!(Math.abs(lat) <= 84) || !(Math.abs(lon) <= 180)) continue;
  if (have.has(code) || have.has(a.ident) || have.has(a.gps_code) || have.has(a.local_code) || AIRFIELD_INDEX.some((f) => dist(f.lat, f.lon, lat, lon) < 2500)) { dupe++; continue; }
  if (seen.has(code)) continue;
  const big = a.type === 'large_airport' ? 1 : 0, rws = [];
  for (const r of runwaysOf.get(a.id) || []) {
    if (r.closed === '1') continue;
    const s = surface(r.surface);
    if (s === null) continue;
    let len = num(r.length_ft) * FT;
    let la = num(r.le_latitude_deg), lo = num(r.le_longitude_deg), ha = num(r.he_latitude_deg), ho = num(r.he_longitude_deg);
    const ends = [la, lo, ha, ho].every(Number.isFinite) && dist(la, lo, lat, lon) < 12000 && dist(ha, ho, lat, lon) < 12000;
    const span = ends ? dist(la, lo, ha, ho) : 0;
    if (ends && span >= 300 && span <= 6500 && (!(len > 0) || Math.abs(span - len) < 0.3 * len + 150)) len = span;
    else {
      // No usable ends: a runway of the stated length through the airport's position, on the heading given or the one its number says.
      let hdg = num(r.le_heading_degT);
      if (!Number.isFinite(hdg)) { const n = parseInt(r.le_ident, 10); if (n >= 1 && n <= 36) hdg = n * 10; }
      if (!(len >= 300 && len <= 6500) || !Number.isFinite(hdg) || !/^\d\d?[LRC]?$/.test(r.le_ident || '')) continue;
      const ux = Math.sin(hdg * D2R), uy = Math.cos(hdg * D2R), dLat = (uy * len) / 2 / 111200, dLon = (ux * len) / 2 / (111200 * Math.cos(lat * D2R));
      la = lat - dLat; lo = lon - dLon; ha = lat + dLat; ho = lon + dLon; guessed++;
    }
    if (len < 300) continue;
    let w = num(r.width_ft) * FT;
    if (!(w >= 8 && w <= 100)) w = big ? 45 : 30;
    const n1 = (r.le_ident || '').trim(), n2 = (r.he_ident || '').trim();
    if (!n1 || !n2) continue;
    const dt = [Math.round(num(r.le_displaced_threshold_ft) * FT) || 0, Math.round(num(r.he_displaced_threshold_ft) * FT) || 0];
    rws.push({ n1, n2, la, lo, ha, ho, w: Math.round(w), s: s || 'a', len, dt });
  }
  if (!rws.length) { noRunway++; continue; }
  // The main runway first: the longest paved one (as fetch-airfields.mjs chooses it).
  rws.sort((p, q) => (q.s <= 'c') - (p.s <= 'c') || q.len - p.len);
  const cc = a.iso_country, terr = US_TERRITORY[cc];
  const name = a.name.replace(/\s*\/\s*/g, ' / ').replace(/\s+(International\s+)?Airport$/i, (m, intl) => (intl ? ' International' : '')).replace(/\s+/g, ' ').trim().slice(0, 60);
  let region = terr || regions[a.iso_region] || '';
  if (/^\(unassigned\)$/i.test(region) || region === countries[cc]) region = '';
  seen.add(code); used.add(terr ? 'US' : cc);
  const r5 = (v) => +v.toFixed(5);
  fields.push([code, name, (a.municipality || '').slice(0, 40), region.replace(/ (Region|Province|Prefecture|Oblast|County|Department|District|Governorate|State)$/i, ''), terr ? 'US' : cc, big,
    rws.slice(0, 6).map((r) => { const o = [r.n1, r.n2, r5(r.la), r5(r.lo), r5(r.ha), r5(r.ho), r.w, r.s]; if (r.dt[0] || r.dt[1]) o.push(r.dt[0], r.dt[1]); return o; })]);
}
const cname = (cc) => countries[cc] || cc;
fields.sort((p, q) => cname(p[4]).localeCompare(cname(q[4])) || p[3].localeCompare(q[3]) || p[1].localeCompare(q[1]));

// How the menu groups them: by state or province in the United States and Canada (as the detailed fields are),
// by region where the game has regions, by country everywhere else.
const groups = { MX: 'Mexico' };
for (const c of CENTRAL) groups[c] = 'Central America';
for (const c of CARIBBEAN) groups[c] = 'The Caribbean and Bermuda';

const credit = 'Airports and runways: OurAirports (ourairports.com), public domain';
const out = { credit, countries: Object.fromEntries([...used].sort().map((c) => [c, cname(c)])), groups, fields };
mkdirSync(dirname(OUT), { recursive: true });
const text = `{"credit":${JSON.stringify(credit)},"countries":${JSON.stringify(out.countries)},"groups":${JSON.stringify(groups)},"fields":[\n${fields.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;
writeFileSync(OUT, text);
console.log(`${fields.length} airfields in ${used.size} countries (${fields.filter((f) => f[5]).length} large), ${fields.reduce((s, f) => s + f[6].length, 0)} runways (${guessed} laid through the airport's position for want of their ends)`);
console.log(`left out: ${dupe} the game has in detail, ${noRunway} with no usable runway. Written to ${OUT} (${(text.length / 1024).toFixed(0)} kB)`);
