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

module.exports = { WORD_FIELDS, serializeWord, getWord, getWordRow, listWords, createWord, updateWord, deleteWord };
