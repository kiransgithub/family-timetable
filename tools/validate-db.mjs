#!/usr/bin/env node
// Checks a db.json and prints problems:  node tools/validate-db.mjs path/to/db.json

import { readFile } from 'node:fs/promises';
import { normalizeDb } from '../js/core/model.js';
import { validateDb } from '../js/core/validate.js';

const path = process.argv[2] || 'db.json';
let db;
try {
  db = normalizeDb(JSON.parse(await readFile(path, 'utf8')));
} catch (e) {
  console.error(`${path}: ${e.message}`);
  process.exit(1);
}
const { errors, warnings } = validateDb(db);
for (const w of warnings) console.log(`note: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(errors.length ? `\n${errors.length} problem(s) found.` : `\n${path} looks good.`);
process.exit(errors.length ? 1 : 0);
