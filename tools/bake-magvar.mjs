// Prints the World Magnetic Model's coefficients as the table src/world/geo.js carries (WMM), and checks the
// game's evaluator (magVarAt) against the model's published test values.
//
// The model: WMM2025, by NOAA's National Centers for Environmental Information and the British Geological
// Survey (public domain). Download and unpack https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip
// and give this script the folder:
//
//   node tools/bake-magvar.mjs /tmp/dr-world-bake/wmm/WMM2025COF
//
// The table is one row of the file after another, degree 1 to 12, order 0 to the degree: g, h (nT) and their
// change a year. Paste it over the one in geo.js when the model is replaced (every five years).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { magVarAt } from '../src/world/geo.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node tools/bake-magvar.mjs <folder with WMM.COF>'); process.exit(1); }
const rows = readFileSync(join(dir, 'WMM.COF'), 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length === 6 && /^\d+$/.test(r[0]));
const out = [];
for (const r of rows) out.push(+r[2], +r[3], +r[4], +r[5]);
console.log(`// ${rows.length} rows\nconst WMM = [${out.join(',')}];`);

let worst = 0, n = 0;
for (const line of readFileSync(join(dir, 'WMM2025_TestValues.txt'), 'utf8').split('\n')) {
  if (!line.trim() || line.startsWith('#')) continue;
  const [year, alt, lat, lon, decl] = line.trim().split(/\s+/).map(Number);
  const got = magVarAt(lat, lon, year, alt, 2);
  let err = Math.abs(got - decl); if (err > 180) err = 360 - err;
  worst = Math.max(worst, err); n++;
  if (err > 0.02) console.log(`  ${year} ${alt} km ${lat} ${lon}: ${got} against ${decl}`);
}
console.log(`// checked against ${n} test values: worst error ${worst.toFixed(3)} degrees`);
