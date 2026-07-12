#!/usr/bin/env node
/**
 * One-time migration: read the iOS/Catalyst app's SQLite DB and POST it to the
 * backend's /api/sync/import (preserving IDs).
 *
 * Usage:
 *   APP_DB="/path/to/essentialWords_v5.sqlite" \
 *   API_URL="http://192.168.2.10:3100" API_KEY="..." \
 *   node scripts/migrate-from-app-db.js
 */
const Database = require('better-sqlite3');

const APP_DB = process.env.APP_DB;
const API_URL = (process.env.API_URL || 'http://localhost:3100').replace(/\/$/, '');
const API_KEY = process.env.API_KEY;

if (!APP_DB || !API_KEY) {
  console.error('Set APP_DB and API_KEY (and optionally API_URL).');
  process.exit(1);
}

/** GRDB stores UTC as "YYYY-MM-DD HH:MM:SS.SSS"; convert to ISO-8601 "...Z". */
function toIso(v) {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  if (v.includes('T')) return v.endsWith('Z') ? v : `${v}Z`;
  return `${v.replace(' ', 'T')}Z`;
}

const db = new Database(APP_DB, { readonly: true });

const languages = db.prepare('SELECT id, name, code, sourceFileName FROM languages').all();
const sets = db.prepare('SELECT id, name, languageId, createdAt FROM wordSet').all().map((s) => ({
  ...s,
  createdAt: toIso(s.createdAt),
}));
const words = db.prepare('SELECT * FROM wordRecords').all().map((w) => ({
  ...w,
  isLearned: !!w.isLearned,
  nextPracticeDate: toIso(w.nextPracticeDate),
  lastReviewedDate: toIso(w.lastReviewedDate),
  createdAt: toIso(w.createdAt),
}));

console.log(`Read ${languages.length} languages, ${sets.length} sets, ${words.length} words from app DB.`);

(async () => {
  const res = await fetch(`${API_URL}/api/sync/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ languages, sets, words }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Import failed (${res.status}): ${text}`);
    process.exit(1);
  }
  console.log('Import OK:', text);
})().catch((e) => {
  console.error('Migration error:', e.message);
  process.exit(1);
});
