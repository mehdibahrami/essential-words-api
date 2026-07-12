const { nowIso, startOfDay } = require('../utils/time');
const { badRequest, notFound } = require('../middleware/errorHandler');

const WORD_FIELDS = [
  'word', 'wordTranslated', 'partOfSpeech', 'definition', 'definitionTranslated',
  'example1', 'example1Translated', 'example2', 'example2Translated',
  'example3', 'example3Translated',
];

/** Present isLearned as a boolean; leave the rest as stored. */
function serializeWord(row) {
  if (!row) return row;
  return { ...row, isLearned: !!row.isLearned };
}

function getWordRow(db, id) {
  return db.prepare('SELECT * FROM words WHERE id = ?').get(id);
}

function getWord(db, id) {
  return serializeWord(getWordRow(db, id));
}

function listWords(db, { setId, languageId, includeDeleted = false } = {}) {
  const clauses = [];
  const params = {};
  if (!includeDeleted) clauses.push('deletedAt IS NULL');
  if (setId != null) { clauses.push('wordSetId = @setId'); params.setId = Number(setId); }
  if (languageId != null) { clauses.push('languageId = @languageId'); params.languageId = Number(languageId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM words ${where} ORDER BY id ASC`).all(params).map(serializeWord);
}

function createWord(db, body) {
  const { word, languageId, wordSetId } = body;
  if (!word || languageId == null || wordSetId == null) {
    throw badRequest('word, languageId and wordSetId are required');
  }
  const set = db.prepare('SELECT id FROM word_sets WHERE id = ? AND deletedAt IS NULL').get(wordSetId);
  if (!set) throw badRequest('wordSetId does not reference an existing set');
  const now = nowIso();
  // Text columns default to '', example columns default to null.
  const notNullText = new Set(['word', 'wordTranslated', 'partOfSpeech', 'definition', 'definitionTranslated']);
  const record = {
    languageId: Number(languageId),
    wordSetId: Number(wordSetId),
    leitnerBox: 0,
    nextPracticeDate: startOfDay(new Date()),
    isLearned: 0,
    lastReviewedDate: null,
    createdAt: now,
    updatedAt: now,
  };
  for (const f of WORD_FIELDS) record[f] = body[f] ?? (notNullText.has(f) ? '' : null);
  record.word = word; // required, keep verbatim

  const cols = ['languageId', 'wordSetId', ...WORD_FIELDS, 'leitnerBox', 'nextPracticeDate', 'isLearned', 'lastReviewedDate', 'createdAt', 'updatedAt'];
  const info = db
    .prepare(`INSERT INTO words (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(record);
  return getWord(db, info.lastInsertRowid);
}

/** Update editable/content fields (not the Leitner state — that goes through /practice). */
function updateWord(db, id, fields) {
  const existing = getWordRow(db, id);
  if (!existing || existing.deletedAt) throw notFound('Word not found');
  const next = { ...existing };
  for (const f of WORD_FIELDS) if (fields[f] !== undefined) next[f] = fields[f];
  // Allow explicit correction of learning state if provided.
  if (fields.leitnerBox !== undefined) next.leitnerBox = Number(fields.leitnerBox);
  if (fields.isLearned !== undefined) next.isLearned = fields.isLearned ? 1 : 0;
  if (fields.nextPracticeDate !== undefined) next.nextPracticeDate = fields.nextPracticeDate;
  if (fields.wordSetId !== undefined) next.wordSetId = Number(fields.wordSetId);
  next.updatedAt = nowIso();

  const assignable = [...WORD_FIELDS, 'leitnerBox', 'isLearned', 'nextPracticeDate', 'wordSetId', 'updatedAt'];
  db.prepare(`UPDATE words SET ${assignable.map((c) => `${c}=@${c}`).join(', ')} WHERE id=@id`)
    .run({ ...next, id });
  return getWord(db, id);
}

function deleteWord(db, id) {
  const existing = getWordRow(db, id);
  if (!existing || existing.deletedAt) throw notFound('Word not found');
  db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE id=@id').run({ id, now: nowIso() });
}

const NOT_NULL_TEXT = new Set(['word', 'wordTranslated', 'partOfSpeech', 'definition', 'definitionTranslated']);

/** Bulk-insert words into a set (server assigns IDs). Used for CSV import / seeding. */
function bulkCreateWords(db, setId, wordsInput = []) {
  const set = db.prepare('SELECT id, languageId FROM word_sets WHERE id = ? AND deletedAt IS NULL').get(setId);
  if (!set) throw badRequest('set not found');
  const now = nowIso();
  const npd = startOfDay(new Date());
  const cols = ['languageId', 'wordSetId', ...WORD_FIELDS, 'leitnerBox', 'nextPracticeDate', 'isLearned', 'lastReviewedDate', 'createdAt', 'updatedAt'];
  const stmt = db.prepare(`INSERT INTO words (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`);
  const tx = db.transaction((items) => {
    let count = 0;
    for (const w of items) {
      if (!w || !w.word) continue;
      const rec = {
        languageId: set.languageId, wordSetId: setId,
        leitnerBox: 0, nextPracticeDate: npd, isLearned: 0, lastReviewedDate: null,
        createdAt: now, updatedAt: now,
      };
      for (const f of WORD_FIELDS) rec[f] = w[f] ?? (NOT_NULL_TEXT.has(f) ? '' : null);
      rec.word = w.word;
      stmt.run(rec);
      count += 1;
    }
    return count;
  });
  return { inserted: tx(wordsInput) };
}

/** Soft-delete every word in a set. */
function deleteWordsInSet(db, setId) {
  const now = nowIso();
  const info = db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE wordSetId=@setId AND deletedAt IS NULL').run({ setId, now });
  return { deleted: info.changes };
}

/** Soft-delete every word for a language. */
function deleteWordsForLanguage(db, languageId) {
  const now = nowIso();
  const info = db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE languageId=@languageId AND deletedAt IS NULL').run({ languageId, now });
  return { deleted: info.changes };
}

module.exports = {
  WORD_FIELDS, serializeWord, getWord, getWordRow, listWords, createWord, updateWord, deleteWord,
  bulkCreateWords, deleteWordsInSet, deleteWordsForLanguage,
};
