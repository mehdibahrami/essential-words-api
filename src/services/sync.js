const { nowIso, startOfDay } = require('../utils/time');
const { serializeWord } = require('./words');

/**
 * Delta snapshot. With `since` (ISO), returns rows changed after it — including
 * tombstones (deletedAt set). Without `since`, returns the full live dataset.
 */
function snapshot(db, since) {
  const serverTime = nowIso();
  const q = (table, mapper = (r) => r) => {
    if (since) {
      return db.prepare(`SELECT * FROM ${table} WHERE updatedAt > @since ORDER BY id ASC`).all({ since }).map(mapper);
    }
    return db.prepare(`SELECT * FROM ${table} WHERE deletedAt IS NULL ORDER BY id ASC`).all().map(mapper);
  };
  return {
    serverTime,
    languages: q('languages'),
    sets: q('word_sets'),
    words: q('words', (r) => serializeWord(r, db)),
  };
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

/** Bulk seed/replace, preserving incoming IDs. Used for the one-time migration. */
function importData(db, { languages = [], sets = [], words = [] } = {}) {
  const now = nowIso();
  const tx = db.transaction(() => {
    for (const l of languages) upsertRow(db, 'languages', LANGUAGE_COLS, l, now);
    for (const s of sets) upsertRow(db, 'word_sets', SET_COLS, s, now);
    for (const w of words) {
      const row = { ...w };
      // Fill NOT-NULL columns the client may omit.
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

module.exports = { snapshot, importData };
