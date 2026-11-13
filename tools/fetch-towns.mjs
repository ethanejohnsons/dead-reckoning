#!/usr/bin/env node
// Bakes the towns and cities of the game's world (the United States, Canada and their near neighbors) from OpenStreetMap into
// public/data/towns.json: name, latitude, longitude, population, biggest first. The game turns them into
// the built-up tint of the regional map and the lights at night (src/world/towns.js).
//
//   node tools/fetch-towns.mjs [--cache DIR] [--offline] [--skip-missing] [--endpoint URL]
//                                             (--skip-missing: an interim bake from the boxes already in the cache, when the server is down)
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
// the north of Mexico and the Bahamas), the North, Alaska with the Aleutians, and Hawaii.
const BOXES = [
  [24, -125, 40, -114], [24, -114, 40, -103], [24, -103, 40, -92], [24, -92, 40, -81], [24, -81, 40, -66],
  [40, -141, 56, -125], [40, -125, 56, -114], [40, -114, 56, -103], [40, -103, 56, -92], [40, -92, 56, -81], [40, -81, 56, -70], [40, -70, 56, -52],
  [56, -170, 72, -141], [56, -141, 72, -100], [56, -100, 72, -52], [50, -180, 56, -141], [18.5, -161, 22.5, -154.5],
];
const MIN_POP = 1500;

const NE = opt('--natural-earth', null);
const inBoxes = (lat, lon) => BOXES.some(([s, w, n, e]) => lat > s && lat <= n && lon > w && lon <= e);
const towns = [];
let defaulted = 0, credit = '© OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)';
if (NE) {
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
const text = `{"credit":"${credit}","towns":[\n${towns.map((t) => JSON.stringify(t)).join(',\n')}\n]}\n`;
await writeFile(OUT, text);
console.log(`${towns.length} towns of ${MIN_POP} people or more (${defaulted} places had no population and took a default) written to ${OUT} (${(text.length / 1024).toFixed(0)} kB)`);
console.log('largest:', towns.slice(0, 12).map((t) => `${t[0]} ${t[3]}`).join(', '));
