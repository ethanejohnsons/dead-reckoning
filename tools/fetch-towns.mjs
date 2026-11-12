#!/usr/bin/env node
// Bakes the towns and cities of the game's part of the United States from OpenStreetMap into
// public/data/towns.json: name, latitude, longitude, population, biggest first. The game turns them into
// the built-up tint of the regional map and the lights at night (src/world/towns.js).
//
//   node tools/fetch-towns.mjs [--cache DIR] [--offline] [--endpoint URL]
//   node tools/fetch-towns.mjs --natural-earth FILE     (fallback: Natural Earth's populated places, public domain;
//                                                        ne_10m_populated_places_simple.geojson; far fewer places, no suburbs)
//
// Eight Overpass requests (place nodes in a box from the Great Lakes to the northern Rockies, a tile at a
// time, with pauses), their raw answers kept in a cache directory outside the repository. The result is a derived database of OpenStreetMap
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
const OFFLINE = args.includes('--offline');
const ENDPOINT = opt('--endpoint', 'https://overpass-api.de/api/interpreter');
const USER_AGENT = 'airfield-geometry-fetch/1.0';
// South, west, north, east: the ten states of the game and a margin of their neighbours (a window of the
// world centred on a border airfield reaches 260 km past it).
const BOX = '34.6,-119.5,51.4,-79.8';
const MIN_POP = 1500;

const NE = opt('--natural-earth', null);
const [S0, W0, N0, E0] = BOX.split(',').map(Number);
const towns = [];
let defaulted = 0, credit = '© OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)';
if (NE) {
  credit = 'Made with Natural Earth (naturalearthdata.com), public domain';
  for (const f of JSON.parse(await readFile(NE, 'utf8')).features) {
    const p = f.properties;
    if (p.latitude > S0 && p.latitude < N0 && p.longitude > W0 && p.longitude < E0 && p.pop_max >= MIN_POP) towns.push([String(p.name).slice(0, 40), +p.latitude.toFixed(4), +p.longitude.toFixed(4), Math.round(p.pop_max)]);
  }
} else {
// The box is asked for in tiles, a request each with a pause between: one request for all of it times out.
const COLS = 4, ROWS = 2, PAUSE_MS = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { elements: [] };
let asked = 0;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const box = [S0 + ((N0 - S0) * r) / ROWS, W0 + ((E0 - W0) * c) / COLS, S0 + ((N0 - S0) * (r + 1)) / ROWS, W0 + ((E0 - W0) * (c + 1)) / COLS].map((v) => v.toFixed(3)).join(',');
  const file = join(CACHE, `towns-${r}-${c}.json`);
  if (existsSync(file)) { json.elements.push(...JSON.parse(await readFile(file, 'utf8')).elements); continue; }
  if (OFFLINE) throw new Error(`--offline, but ${file} is not in the cache`);
  const query = `[out:json][timeout:170];\n(\n  node["place"~"^(city|town)$"](${box});\n  node["place"="village"]["population"~"^([2-9][0-9]{3}|1[5-9][0-9]{2}|[0-9]{5,})$"](${box});\n);\nout;`;
  if (asked++) await sleep(PAUSE_MS);
  process.stderr.write(`Overpass: towns ${r * COLS + c + 1} of ${ROWS * COLS}…\n`);
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' }, body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(240000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  const part = JSON.parse(text);                // data only: parsed, never evaluated
  if (!Array.isArray(part.elements)) throw new Error('no elements in the answer');
  if (part.remark) throw new Error(`Overpass: ${String(part.remark).slice(0, 160)}`);       // timed out or ran out of memory: not an answer to keep
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, text);
  json.elements.push(...part.elements);
}
for (const el of json.elements) {
  const t = el.tags || {};
  if (el.type !== 'node' || !t.name) continue;
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
