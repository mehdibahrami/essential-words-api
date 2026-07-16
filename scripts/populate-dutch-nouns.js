#!/usr/bin/env node
'use strict';

/**
 * Populate Dutch noun grammar (article + plural) into the words table via the REST API.
 *
 * Data (scripts/data/dutch-nouns.json) was authored from the app's noun list and each
 * gender/plural verified against en.wiktionary.org. Verbs need no population — their
 * present tense is computed live server-side.
 *
 * Usage:
 *   BASE_URL=http://100.107.130.120:3100 API_KEY=xxxx node scripts/populate-dutch-nouns.js
 *   node scripts/populate-dutch-nouns.js --dry-run
 *
 * Idempotent: re-running overwrites each word's grammar with the same value.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const API_KEY = process.env.API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');

if (!API_KEY && !DRY_RUN) {
  console.error('Set API_KEY (or pass --dry-run).');
  process.exit(1);
}

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'dutch-nouns.json'), 'utf8')
);

async function putGrammar(rec) {
  const body = { grammar: { kind: 'noun', article: rec.article, plural: rec.plural } };
  const res = await fetch(`${BASE_URL}/api/words/${rec.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Populating ${data.length} Dutch nouns at ${BASE_URL}`);
  let ok = 0; const failures = [];
  for (const rec of data) {
    if (DRY_RUN) { ok++; continue; }
    try {
      const w = await putGrammar(rec);
      // Sanity: server should echo back a noun grammar object.
      if (!w.grammar || w.grammar.kind !== 'noun') throw new Error('no grammar echoed');
      ok++;
    } catch (e) {
      failures.push(`${rec.word} (id ${rec.id}): ${e.message}`);
    }
  }
  console.log(`Done: ${ok}/${data.length} updated.`);
  if (failures.length) {
    console.log(`Failures (${failures.length}):`);
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
})();
