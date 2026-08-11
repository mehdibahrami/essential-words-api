/**
 * `word_material` was created with no foreign key to `words` and no index on
 * `wordId`. Soft-deletes call dropCachedMaterial explicitly, but a hard delete or a
 * direct DB edit orphans rows permanently -- and SQLite cannot ALTER a FK onto an
 * existing table, so this rebuilds it: a fresh table with the constraint, copying
 * over only rows whose word still exists (a pre-FK database may already carry
 * orphans from before this constraint existed -- those are dropped rather than
 * failing the migration).
 */
function up(db) {
  db.exec(`
    CREATE TABLE word_material_new (
      wordId              INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      level               TEXT    NOT NULL,
      sentence            TEXT,
      clozeSentence       TEXT,
      clozeAnswer         TEXT,
      clozeDistractors    TEXT,
      sentenceTranslation TEXT,
      hook                TEXT,
      confusables         TEXT,
      createdAt           TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wordId, level)
    );

    INSERT INTO word_material_new
      (wordId, level, sentence, clozeSentence, clozeAnswer, clozeDistractors, sentenceTranslation, hook, confusables, createdAt)
    SELECT wordId, level, sentence, clozeSentence, clozeAnswer, clozeDistractors, sentenceTranslation, hook, confusables, createdAt
    FROM word_material
    WHERE wordId IN (SELECT id FROM words);

    DROP TABLE word_material;
    ALTER TABLE word_material_new RENAME TO word_material;
    CREATE INDEX IF NOT EXISTS idx_word_material_wordId ON word_material(wordId);
  `);
}

module.exports = { version: 2, name: 'word_material_fk', up };
