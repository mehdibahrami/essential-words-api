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
      CREATE TABLE word_material (
        wordId INTEGER NOT NULL, level TEXT NOT NULL, sentence TEXT, clozeSentence TEXT,
        clozeAnswer TEXT, clozeDistractors TEXT, sentenceTranslation TEXT, hook TEXT,
        confusables TEXT, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (wordId, level)
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

describe('migration 002: word_material gets a FK + index', () => {
  test('a fresh database already has the FK and the index', () => {
    const db = openDatabase(':memory:');
    const fks = db.prepare('PRAGMA foreign_key_list(word_material)').all();
    expect(fks.some((fk) => fk.table === 'words' && fk.on_delete === 'CASCADE')).toBe(true);
    const indexes = db.prepare('PRAGMA index_list(word_material)').all();
    expect(indexes.some((ix) => ix.name === 'idx_word_material_wordId')).toBe(true);
  });

  test('rebuild drops orphan rows and keeps valid ones, tolerating a pre-FK database', () => {
    // Simulate a real pre-migration database: word_material with no FK, carrying an
    // orphan row left behind from before the FK existed (§3.3's stated risk).
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt TEXT);
      CREATE TABLE languages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, code TEXT UNIQUE, createdAt TEXT, updatedAt TEXT, deletedAt TEXT);
      CREATE TABLE word_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, languageId INTEGER, createdAt TEXT, updatedAt TEXT, deletedAt TEXT);
      CREATE TABLE words (
        id INTEGER PRIMARY KEY AUTOINCREMENT, languageId INTEGER, wordSetId INTEGER, word TEXT NOT NULL,
        wordTranslated TEXT NOT NULL DEFAULT '', partOfSpeech TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL DEFAULT '', definitionTranslated TEXT NOT NULL DEFAULT '',
        example1 TEXT, example1Translated TEXT, example2 TEXT, example2Translated TEXT,
        example3 TEXT, example3Translated TEXT, leitnerBox INTEGER NOT NULL DEFAULT 0,
        nextPracticeDate TEXT, isLearned INTEGER NOT NULL DEFAULT 0, lastReviewedDate TEXT,
        lapseCount INTEGER NOT NULL DEFAULT 0, openLapse INTEGER NOT NULL DEFAULT 0, lastLapsedAt TEXT,
        grammar TEXT, createdAt TEXT, updatedAt TEXT, deletedAt TEXT
      );
      CREATE TABLE word_material (
        wordId INTEGER NOT NULL, level TEXT NOT NULL, sentence TEXT, clozeSentence TEXT,
        clozeAnswer TEXT, clozeDistractors TEXT, sentenceTranslation TEXT, hook TEXT,
        confusables TEXT, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (wordId, level)
      );
    `);
    db.prepare("INSERT INTO languages (id, name, code) VALUES (1, 'Dutch', 'nl-NL')").run();
    db.prepare("INSERT INTO word_sets (id, name, languageId) VALUES (1, 'S', 1)").run();
    db.prepare("INSERT INTO words (id, languageId, wordSetId, word) VALUES (1, 1, 1, 'liggen')").run();
    db.prepare("INSERT INTO word_material (wordId, level, sentence) VALUES (1, 'A1', 'valid row')").run();
    // Orphan: no word with id 999 -- exactly the pre-FK state the migration must handle.
    db.prepare("INSERT INTO word_material (wordId, level, sentence) VALUES (999, 'A1', 'orphan row')").run();

    runMigrations(db);

    const rows = db.prepare('SELECT wordId, sentence FROM word_material ORDER BY wordId').all();
    expect(rows).toEqual([{ wordId: 1, sentence: 'valid row' }]);
    const fks = db.prepare('PRAGMA foreign_key_list(word_material)').all();
    expect(fks.some((fk) => fk.table === 'words' && fk.on_delete === 'CASCADE')).toBe(true);
    const indexes = db.prepare('PRAGMA index_list(word_material)').all();
    expect(indexes.some((ix) => ix.name === 'idx_word_material_wordId')).toBe(true);
  });

  test('a hard delete of a word cascades to its cached material', () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO languages (id, name, code) VALUES (1, 'Dutch', 'nl-NL')").run();
    db.prepare("INSERT INTO word_sets (id, name, languageId) VALUES (1, 'S', 1)").run();
    db.prepare("INSERT INTO words (id, languageId, wordSetId, word) VALUES (1, 1, 1, 'liggen')").run();
    db.prepare("INSERT INTO word_material (wordId, level, sentence) VALUES (1, 'A1', 'x')").run();

    db.prepare('DELETE FROM words WHERE id = 1').run(); // a real hard delete, not the app's soft delete
    expect(db.prepare('SELECT COUNT(*) c FROM word_material WHERE wordId = 1').get().c).toBe(0);
  });
});
