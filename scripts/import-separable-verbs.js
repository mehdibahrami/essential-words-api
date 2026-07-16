#!/usr/bin/env node
'use strict';

/**
 * Create the "Separable Verbs" set and bulk-import its words (one HTTP call, so the
 * rate limiter is fine). Present-tense conjugation is computed server-side — no grammar
 * is sent. Idempotent-ish: refuses to double-import if the set already has words.
 *
 * Usage: BASE_URL=http://100.107.130.120:3100 API_KEY=xxxx node scripts/import-separable-verbs.js
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3100';
const API_KEY = process.env.API_KEY;
if (!API_KEY) { console.error('Set API_KEY'); process.exit(1); }

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'separable-verbs.json'), 'utf8'));

async function api(method, url, body) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

(async () => {
  const langs = await api('GET', '/api/languages');
  const lang = langs.find((l) => l.code === data.languageCode);
  if (!lang) throw new Error(`language ${data.languageCode} not found`);

  const sets = await api('GET', `/api/sets?languageId=${lang.id}`);
  let set = sets.find((s) => s.name === data.setName);
  if (!set) {
    set = await api('POST', '/api/sets', { name: data.setName, languageId: lang.id });
    console.log(`Created set "${data.setName}" (id ${set.id}).`);
  } else {
    const existing = await api('GET', `/api/words?setId=${set.id}`);
    if (existing.length) {
      console.log(`Set "${data.setName}" already has ${existing.length} words — aborting to avoid duplicates.`);
      return;
    }
  }

  const words = data.words.map((w) => ({
    word: w.word,
    wordTranslated: w.tr,
    partOfSpeech: data.partOfSpeech,
    definition: w.def,
    definitionTranslated: w.tr,
    example1: w.ex1, example1Translated: w.ex1t,
    example2: w.ex2, example2Translated: w.ex2t,
  }));

  const result = await api('POST', `/api/sets/${set.id}/words/bulk`, { words });
  console.log(`Imported ${result.inserted}/${words.length} words into "${data.setName}" (set ${set.id}).`);
})().catch((e) => { console.error(e.message); process.exit(1); });
