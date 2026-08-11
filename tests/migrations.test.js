const Database = require('better-sqlite3');
const { openDatabase } = require('../src/db');
const { runMigrations, migrations } = require('../src/db/migrations');

describe('schema_migrations', () => {
  test('a fresh database records every migration as applied', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    expect(rows[0].name).toBe('baseline_columns');
  });

  test('running migrations twice is a no-op the second time', () => {
    const db = openDatabase(':memory:');
    const before = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
    runMigrations(db); // already applied by openDatabase; must not throw or re-insert
    const after = db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c;
    expect(after).toBe(before);
  });

  test('migration 001 back-fills the four columns on a database that predates them', () => {
    // Simulate a real pre-lapse-tracking, pre-grammar database: hand-build the
    // `words`/`schema_migrations` tables without those four columns, skipping
    // openDatabase's SCHEMA (which already bakes them into CREATE TABLE).
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT);
      CREATE TABLE languages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, code TEXT UNIQUE, createdAt TEXT, updatedAt TEXT, deletedAt TEXT);
      CREATE TABLE word_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, languageId INTEGER, createdAt TEXT, updatedAt TEXT, deletedAt TEXT);
      CREATE TABLE words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        languageId INTEGER, wordSetId INTEGER, word TEXT NOT NULL,
        wordTranslated TEXT NOT NULL DEFAULT '', partOfSpeech TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL DEFAULT '', definitionTranslated TEXT NOT NULL DEFAULT '',
        example1 TEXT, example1Translated TEXT, example2 TEXT, example2Translated TEXT,
        example3 TEXT, example3Translated TEXT,
        leitnerBox INTEGER NOT NULL DEFAULT 0, nextPracticeDate TEXT, isLearned INTEGER NOT NULL DEFAULT 0,
        lastReviewedDate TEXT, createdAt TEXT, updatedAt TEXT, deletedAt TEXT
      );
    `);
    const colsBefore = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
    expect(colsBefore).not.toContain('grammar');
    expect(colsBefore).not.toContain('lapseCount');

    runMigrations(db);

    const colsAfter = db.prepare('PRAGMA table_info(words)').all().map((c) => c.name);
    expect(colsAfter).toEqual(expect.arrayContaining(['grammar', 'lapseCount', 'openLapse', 'lastLapsedAt']));
    const applied = db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version);
    expect(applied).toContain(1);

    // Idempotent: running again on the now-migrated DB must not re-ALTER (which
    // would throw "duplicate column name") or duplicate the ledger row.
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 1').get().c).toBe(1);
  });
});
