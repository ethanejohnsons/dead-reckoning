#!/usr/bin/env node
// Bakes the towns and cities of the game's world into public/data/towns.json: name, latitude, longitude,
// population, biggest first. The game turns them into the built-up tint of the regional map and the lights
// at night (src/world/towns.js). North America (BOXES) comes from OpenStreetMap, places of 1,500 people and
// more; the rest of the world from GeoNames (--world), places of 5,000 and more.
//
//   node tools/fetch-towns.mjs [--cache DIR] [--offline] [--skip-missing] [--endpoint URL]
//                                             (--skip-missing: an interim bake from the boxes already in the cache, when the server is down)
//   node tools/fetch-towns.mjs --geonames FILE          (a second source, for when no Overpass server answers: fills the boxes
//                                                        the file in public/data has no towns in from GeoNames' cities1000.txt,
//                                                        download.geonames.org/export/dump, CC BY 4.0; no network; the rest is kept)
//   node tools/fetch-towns.mjs --world FILE             (the rest of the world: adds the places of GeoNames' cities5000.txt, same
//                                                        site and license, that lie outside the boxes; no network; what is baked
//                                                        inside the boxes is kept, and places added by an earlier run are replaced.
//                                                        The smaller of them, under WORLD_NAMED people, whose names the game
//                                                        never writes, go without a name into a list of their own, "small":
//                                                        latitude and longitude in thousandths of a degree and population in
//                                                        hundreds, three whole numbers a place, which keeps the file short)
//   node tools/fetch-towns.mjs --natural-earth FILE     (fallback: Natural Earth's populated places, public domain;
//                                                        ne_10m_populated_places_simple.geojson; far fewer places, no suburbs)
//
// One Overpass request for each box of BOXES (place nodes, with pauses between and another try or two when a
// request fails), their raw answers kept in a cache directory outside the repository. The result is a derived database of OpenStreetMap
// data, © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/data/towns.json');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const CACHE = opt('--cache', join(tmpdir(), 'airfield-osm-cache'));
const OFFLINE = args.includes('--offline'), SKIP_MISSING = args.includes('--skip-missing');
const ENDPOINT = opt('--endpoint', 'https://overpass-api.de/api/interpreter');
const USER_AGENT = 'airfield-geometry-fetch/1.0';
// South, west, north, east of each request: between them the lower forty-eight and the south of Canada (with
// the north of Mexico and the Bahamas), the North, Alaska with the Aleutians, Hawaii, and the rest of the continent to Panama.
const BOXES = [
  [24, -125, 40, -114], [24, -114, 40, -103], [24, -103, 40, -92], [24, -92, 40, -81], [24, -81, 40, -66],
  [40, -141, 56, -125], [40, -125, 56, -114], [40, -114, 56, -103], [40, -103, 56, -92], [40, -92, 56, -81], [40, -81, 56, -70], [40, -70, 56, -52],
  [56, -170, 72, -141], [56, -141, 72, -100], [56, -100, 72, -52], [50, -180, 56, -141], [18.5, -161, 22.5, -154.5],
  // Mexico below the Tropic, Central America and the Caribbean
  [14, -118, 24, -106], [14, -106, 24, -97], [14, -97, 24, -86], [14, -86, 24, -73], [10, -73, 24, -59], [7, -93, 14, -77],
];
const MIN_POP = 1500, WORLD_MIN_POP = 5000, WORLD_NAMED = 30000;

const NE = opt('--natural-earth', null), GEONAMES = opt('--geonames', null), WORLD = opt('--world', null);
const inBoxes = (lat, lon) => BOXES.some(([s, w, n, e]) => lat > s && lat <= n && lon > w && lon <= e);
const towns = [], small = [];
let defaulted = 0, credit = '© OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)';
if (WORLD) {
  // Keep what is baked inside the boxes; everywhere else, GeoNames' places (the columns as below; sections of a
  // city, PPLX, and places that are no more are left out: their people are counted in the city's own entry).
  const have = JSON.parse(await readFile(OUT, 'utf8'));
  towns.push(...have.towns.filter((t) => inBoxes(t[1], t[2])));
  let added = 0;
  for (const line of (await readFile(WORLD, 'utf8')).split('\n')) {
    const c = line.split('\t');
    if (c.length < 15 || c[6] !== 'P' || /^PPL[XHQW]$/.test(c[7])) continue;
    const lat = +c[4], lon = +c[5], pop = +c[14];
    if (!(pop >= WORLD_MIN_POP) || !(Math.abs(lat) < 85) || inBoxes(lat, lon)) continue;
    if (pop >= WORLD_NAMED) towns.push([c[1].slice(0, 40), +lat.toFixed(3), +lon.toFixed(3), pop]);
    else small.push([Math.round(lat * 1000), Math.round(lon * 1000), Math.round(pop / 100)]);
    added++;
  }
  process.stderr.write(`GeoNames: ${added} places of ${WORLD_MIN_POP} people or more outside the boxes\n`);
  credit = `${have.credit.split('; ')[0]}; beyond the United States, Canada and northern Mexico: GeoNames (geonames.org), CC BY 4.0`;
} else if (GEONAMES) {
  // Keep what is baked; where a box has nothing in it, take GeoNames' places there (tab-separated: id, name, ascii name,
  // other names, latitude, longitude, feature class, feature code, country, ..., population in the fifteenth column).
  const have = JSON.parse(await readFile(OUT, 'utf8'));
  towns.push(...have.towns);
  const empty = BOXES.filter(([s, w, n, e]) => !have.towns.some((t) => t[1] > s && t[1] <= n && t[2] > w && t[2] <= e));
  let added = 0;
  for (const line of (await readFile(GEONAMES, 'utf8')).split('\n')) {
    const c = line.split('\t');
    if (c.length < 15 || c[6] !== 'P') continue;
    const lat = +c[4], lon = +c[5], pop = +c[14];
    if (!(pop >= MIN_POP) || !empty.some(([s, w, n, e]) => lat > s && lat <= n && lon > w && lon <= e)) continue;
    towns.push([c[1].slice(0, 40), +lat.toFixed(4), +lon.toFixed(4), pop]); added++;
  }
  process.stderr.write(`GeoNames: ${added} places in the ${empty.length} boxes that had none (${empty.map((b) => b.join(',')).join(' | ')})\n`);
  credit = have.credit.includes('GeoNames') || !added ? have.credit : `${have.credit}; where OpenStreetMap had not been asked yet: GeoNames (geonames.org), CC BY 4.0`;
} else if (NE) {
  credit = 'Made with Natural Earth (naturalearthdata.com), public domain';
  for (const f of JSON.parse(await readFile(NE, 'utf8')).features) {
    const p = f.properties;
    if (inBoxes(p.latitude, p.longitude) && p.pop_max >= MIN_POP) towns.push([String(p.name).slice(0, 40), +p.latitude.toFixed(4), +p.longitude.toFixed(4), Math.round(p.pop_max)]);
  }
} else {
const PAUSE_MS = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { elements: [] };
let asked = 0;
for (const [n, b] of BOXES.entries()) {
  const box = b.join(',');
  const file = join(CACHE, `towns-${box.replace(/[^0-9]+/g, '_')}.json`);
  if (existsSync(file)) { json.elements.push(...JSON.parse(await readFile(file, 'utf8')).elements); continue; }
  if (SKIP_MISSING) { process.stderr.write(`--skip-missing: no cached answer for the box ${box}, its towns are left out\n`); continue; }
  if (OFFLINE) throw new Error(`--offline, but ${file} is not in the cache`);
  // (each kind of place by its exact value: a pattern for two of them makes the server read every place node of the box)
  const query = `[out:json][timeout:170];\n(\n  node["place"="city"](${box});\n  node["place"="town"](${box});\n  node["place"="village"]["population"~"^([2-9][0-9]{3}|1[5-9][0-9]{2}|[0-9]{5,})$"](${box});\n);\nout;`;
  for (let attempt = 1; ; attempt++) {
    if (asked++) await sleep(PAUSE_MS * (attempt > 1 ? 3 * (attempt - 1) : 1));
    process.stderr.write(`Overpass: towns ${n + 1} of ${BOXES.length}${attempt > 1 ? ` (attempt ${attempt})` : ''}…\n`);
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' }, body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(240000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
      const part = JSON.parse(text);                // data only: parsed, never evaluated
      if (!Array.isArray(part.elements)) throw new Error('no elements in the answer');
      if (part.remark) throw new Error(`Overpass: ${String(part.remark).slice(0, 160)}`);       // timed out or ran out of memory: not an answer to keep
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, text);
      json.elements.push(...part.elements);
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      process.stderr.write(`  failed (${e.message}); waiting before another try\n`);
    }
  }
}
const seen = new Set();
for (const el of json.elements) {
  const t = el.tags || {};
  if (el.type !== 'node' || !t.name || seen.has(el.id)) continue;
  seen.add(el.id);
  let pop = parseInt(String(t.population || '').replace(/[,\s]/g, ''), 10);
  if (!(pop > 0)) { pop = t.place === 'city' ? 60000 : t.place === 'town' ? 4000 : 0; defaulted++; }      // no population on the map: a typical one for its rank
  if (pop < MIN_POP) continue;
  towns.push([String(t['name:en'] || t.name).slice(0, 40), +el.lat.toFixed(4), +el.lon.toFixed(4), pop]);
}
}
if (!towns.length) throw new Error('no towns found: nothing written');
towns.sort((a, b) => b[3] - a[3]);
await mkdir(dirname(OUT), { recursive: true });
small.sort((a, b) => b[2] - a[2]);
const text = `{"credit":"${credit}","towns":[\n${towns.map((t) => JSON.stringify(t)).join(',\n')}\n]${small.length ? `,"small":[\n${small.map((t) => t.join(',')).join(',\n')}\n]` : ''}}\n`;
await writeFile(OUT, text);
console.log(`${towns.length + small.length} towns of ${MIN_POP} people or more (${WORLD_MIN_POP} beyond North America) (${defaulted} places had no population and took a default) written to ${OUT} (${(text.length / 1024).toFixed(0)} kB)`);
console.log('largest:', towns.slice(0, 12).map((t) => `${t[0]} ${t[3]}`).join(', '));
