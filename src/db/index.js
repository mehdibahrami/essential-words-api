const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS languages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  sourceFileName TEXT,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS word_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  languageId INTEGER NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deletedAt TEXT
);

CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  languageId INTEGER NOT NULL REFERENCES languages(id) ON DELETE CASCADE,
  wordSetId INTEGER NOT NULL REFERENCES word_sets(id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  wordTranslated TEXT NOT NULL DEFAULT '',
  partOfSpeech TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  definitionTranslated TEXT NOT NULL DEFAULT '',
  example1 TEXT, example1Translated TEXT,
  example2 TEXT, example2Translated TEXT,
  example3 TEXT, example3Translated TEXT,
  leitnerBox INTEGER NOT NULL DEFAULT 0,
  nextPracticeDate TEXT,
  isLearned INTEGER NOT NULL DEFAULT 0,
  lastReviewedDate TEXT,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deletedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_sets_language ON word_sets(languageId);
CREATE INDEX IF NOT EXISTS idx_words_set ON words(wordSetId);
CREATE INDEX IF NOT EXISTS idx_words_language ON words(languageId);
CREATE INDEX IF NOT EXISTS idx_words_due ON words(languageId, wordSetId, isLearned, leitnerBox, nextPracticeDate);
`;

/**
 * Open (or create) the SQLite database, apply PRAGMAs and the schema, and return
 * the better-sqlite3 handle. Pass ':memory:' for tests.
 */
function openDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// Shared singleton for the running server. Tests open their own in-memory DBs.
let sharedDb = null;
function getDb() {
  if (!sharedDb) sharedDb = openDatabase();
  return sharedDb;
}

module.exports = { openDatabase, getDb, SCHEMA };
