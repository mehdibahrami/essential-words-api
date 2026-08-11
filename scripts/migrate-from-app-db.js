#!/usr/bin/env node
/**
 * One-time migration: read the iOS/Catalyst app's SQLite DB and write it straight into
 * the backend's own SQLite DB (preserving IDs). Direct-to-SQLite, like
 * populate-dutch-nouns-db.js — intended to run on the server, since it needs filesystem
 * access to the backend DB file rather than going over the (now-removed) sync API.
 *
 * Usage (on the Pi):
 *   APP_DB="/path/to/essentialWords_v5.sqlite" node scripts/migrate-from-app-db.js
 */
const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { nowIso, startOfDay } = require('../src/utils/time');

const APP_DB = process.env.APP_DB;

if (!APP_DB) {
  console.error('Set APP_DB to the path of the app\'s SQLite database.');
  process.exit(1);
}

/** GRDB stores UTC as "YYYY-MM-DD HH:MM:SS.SSS"; convert to ISO-8601 "...Z". */
function toIso(v) {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  if (v.includes('T')) return v.endsWith('Z') ? v : `${v}Z`;
  return `${v.replace(' ', 'T')}Z`;
}

const LANGUAGE_COLS = ['id', 'name', 'code', 'sourceFileName', 'createdAt', 'updatedAt', 'deletedAt'];
const SET_COLS = ['id', 'name', 'languageId', 'createdAt', 'updatedAt', 'deletedAt'];
const WORD_COLS = [
  'id', 'languageId', 'wordSetId', 'word', 'wordTranslated', 'partOfSpeech',
  'definition', 'definitionTranslated', 'example1', 'example1Translated',
  'example2', 'example2Translated', 'example3', 'example3Translated',
  'leitnerBox', 'nextPracticeDate', 'isLearned', 'lastReviewedDate', 'grammar',
  'createdAt', 'updatedAt', 'deletedAt',
];

function upsertRow(db, table, cols, row, now) {
  const record = {};
  for (const c of cols) record[c] = row[c] !== undefined ? row[c] : null;
  if (record.id == null) return; // import requires stable IDs
  if (record.isLearned !== undefined && typeof record.isLearned === 'boolean') {
    record.isLearned = record.isLearned ? 1 : 0;
  }
  if (record.grammar && typeof record.grammar === 'object') {
    record.grammar = JSON.stringify(record.grammar);
  }
  record.createdAt = record.createdAt || now;
  record.updatedAt = record.updatedAt || now;
  const updatable = cols.filter((c) => c !== 'id');
  db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})
     ON CONFLICT(id) DO UPDATE SET ${updatable.map((c) => `${c}=excluded.${c}`).join(', ')}`
  ).run(record);
}

/** Bulk seed/replace, preserving incoming IDs. */
function importData(db, { languages = [], sets = [], words = [] } = {}) {
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const l of languages) upsertRow(db, 'languages', LANGUAGE_COLS, l, now);
    for (const s of sets) upsertRow(db, 'word_sets', SET_COLS, s, now);
    for (const w of words) {
      const row = { ...w };
      // Fill NOT-NULL columns the app DB may omit.
      row.wordTranslated = row.wordTranslated ?? '';
      row.partOfSpeech = row.partOfSpeech ?? '';
      row.definition = row.definition ?? '';
      row.definitionTranslated = row.definitionTranslated ?? '';
      row.leitnerBox = row.leitnerBox ?? 0;
      row.isLearned = row.isLearned ?? false;
      if (row.nextPracticeDate == null) row.nextPracticeDate = startOfDay(new Date());
      upsertRow(db, 'words', WORD_COLS, row, now);
    }
  });
  tx();
  return { languages: languages.length, sets: sets.length, words: words.length };
}

const appDb = new Database(APP_DB, { readonly: true });

const languages = appDb.prepare('SELECT id, name, code, sourceFileName FROM languages').all();
const sets = appDb.prepare('SELECT id, name, languageId, createdAt FROM wordSet').all().map((s) => ({
  ...s,
  createdAt: toIso(s.createdAt),
}));
const words = appDb.prepare('SELECT * FROM wordRecords').all().map((w) => ({
  ...w,
  isLearned: !!w.isLearned,
  nextPracticeDate: toIso(w.nextPracticeDate),
  lastReviewedDate: toIso(w.lastReviewedDate),
  createdAt: toIso(w.createdAt),
}));
appDb.close();

console.log(`Read ${languages.length} languages, ${sets.length} sets, ${words.length} words from app DB.`);

const db = openDatabase();
const result = importData(db, { languages, sets, words });
db.close();

console.log('Import OK:', result);
