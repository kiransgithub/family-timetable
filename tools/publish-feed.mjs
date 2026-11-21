#!/usr/bin/env node
// Builds the .ics calendar feed from db.json and updates the secret gist.
// Used by the GitHub Action in the private data repo, so hand edits to
// db.json (on GitHub, or by an assistant) reach everyone's calendar too.
//
//   node tools/publish-feed.mjs path/to/db.json            # update the gist (needs GIST_TOKEN)
//   node tools/publish-feed.mjs path/to/db.json --out x.ics  # just write the file

import { readFile, writeFile } from 'node:fs/promises';
import { normalizeDb } from '../js/core/model.js';
import { validateDb } from '../js/core/validate.js';
import { buildIcs, icsEventCount } from '../js/core/ics.js';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const dbPath = args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) || 'db.json';

const db = normalizeDb(JSON.parse(await readFile(dbPath, 'utf8')));
const { errors, warnings } = validateDb(db);
for (const w of warnings) console.log(`note: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`error: ${e}`);
  console.error(`\n${dbPath} has ${errors.length} problem(s); the feed was not published.`);
  process.exit(1);
}

const ics = buildIcs(db, { nowMs: Date.now() });
console.log(`Built ${icsEventCount(ics)} calendar events.`);

if (out) {
  await writeFile(out, ics);
  console.log(`Wrote ${out}`);
  process.exit(0);
}

const feed = db.settings.feed;
if (!feed.enabled) {
  console.log('settings.feed.enabled is false; nothing to publish.');
  process.exit(0);
}
if (!feed.gistId) {
  console.log('No settings.feed.gistId yet. Open the app → Manage → Calendar feed → "Create my private calendar feed" once.');
  process.exit(0);
}
const token = process.env.GIST_TOKEN;
if (!token) {
  console.error('GIST_TOKEN is not set. Add it as a repository secret (a token with Gists: read and write).');
  process.exit(1);
}

const res = await fetch(`https://api.github.com/gists/${feed.gistId}`, {
  method: 'PATCH',
  headers: {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ files: { [feed.filename || 'family-timetable.ics']: { content: ics } } }),
});
if (!res.ok) {
  console.error(`Gist update failed: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Feed updated: https://gist.githubusercontent.com/${feed.gistOwner}/${feed.gistId}/raw/${feed.filename}`);
