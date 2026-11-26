#!/usr/bin/env node
// Checks a rewards.json and prints each child's balance:
//   node tools/validate-rewards.mjs path/to/rewards.json [path/to/db.json]

import { readFile } from 'node:fs/promises';
import { normalizeRewards, validateRewards, balanceOf, fmtMoney, fmtPoints } from '../js/core/rewards.js';

const [path = 'rewards.json', dbPath] = process.argv.slice(2);
let r;
let members;
try {
  r = normalizeRewards(JSON.parse(await readFile(path, 'utf8')));
  if (dbPath) members = JSON.parse(await readFile(dbPath, 'utf8')).members;
} catch (e) {
  console.error(`${e.path || path}: ${e.message}`);
  process.exit(1);
}
const { errors, warnings } = validateRewards(r, { members });
for (const w of warnings) console.log(`note: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
if (!errors.length) {
  for (const kid of r.kids) {
    const name = members?.find((m) => m.id === kid)?.name || kid;
    const bal = balanceOf(r, kid);
    console.log(`${name}: ${fmtMoney(bal, r.pointsPerDollar)} (${fmtPoints(bal)})`);
  }
}
console.log(errors.length ? `\n${errors.length} problem(s) found.` : `\n${path} looks good.`);
process.exit(errors.length ? 1 : 0);
