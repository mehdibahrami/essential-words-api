const leitner = require('../utils/leitner');
const { nowIso, startOfDay } = require('../utils/time');
const { notFound } = require('../middleware/errorHandler');
const { serializeWord, getWordRow } = require('./words');

function scope(clauses, params, { languageId, setId }) {
  if (languageId != null) { clauses.push('languageId = @languageId'); params.languageId = Number(languageId); }
  if (setId != null) { clauses.push('wordSetId = @setId'); params.setId = Number(setId); }
}

/** New-word queue: unlearned, box 0, due. Mirrors fetchWordsForInitialReview. */
function reviewNext(db, { languageId, setId, limit = 20 } = {}) {
  const clauses = ['deletedAt IS NULL', 'isLearned = 0', 'leitnerBox = 0', 'nextPracticeDate <= @now'];
  const params = { now: nowIso(), limit: Number(limit) || 20 };
  scope(clauses, params, { languageId, setId });
  return db
    .prepare(`SELECT * FROM words WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT @limit`)
    .all(params)
    .map((r) => serializeWord(r, db));
}

/** Next due learned word. Mirrors fetchWordForPractice ordering. */
function practiceNext(db, { languageId, setId } = {}) {
  const clauses = ['deletedAt IS NULL', 'isLearned = 1', 'leitnerBox >= 1', 'nextPracticeDate <= @now'];
  const params = { now: nowIso() };
  scope(clauses, params, { languageId, setId });
  const row = db
    .prepare(
      `SELECT * FROM words WHERE ${clauses.join(' AND ')}
       ORDER BY leitnerBox ASC, nextPracticeDate ASC, lastReviewedDate IS NULL, lastReviewedDate ASC, createdAt ASC
       LIMIT 1`
    )
    .get(params);
  return serializeWord(row, db);
}

function applyLeitner(db, wordId, changes) {
  const row = getWordRow(db, wordId);
  if (!row || row.deletedAt) throw notFound('Word not found');
  const patch = { ...changes, updatedAt: nowIso() };
  const assignments = Object.keys(patch).map((k) => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE words SET ${assignments} WHERE id=@id`).run({ ...patch, id: wordId });
  return serializeWord(getWordRow(db, wordId), db);
}

const markLearned = (db, wordId, now = new Date()) => applyLeitner(db, wordId, leitner.markLearned(now));

function practiceCorrect(db, wordId, now = new Date()) {
  const row = getWordRow(db, wordId);
  if (!row || row.deletedAt) throw notFound('Word not found');
  // Passing the word in real review is the only thing that closes a lapse.
  // lapseCount is kept: it is the lifetime severity score that ranks chronic
  // problem words above one-off slips the next time they lapse.
  return applyLeitner(db, wordId, { ...leitner.practicedCorrectly(row.leitnerBox, now), openLapse: 0 });
}

function practiceIncorrect(db, wordId, now = new Date()) {
  const row = getWordRow(db, wordId);
  if (!row || row.deletedAt) throw notFound('Word not found');
  return applyLeitner(db, wordId, {
    ...leitner.practicedIncorrectly(now),
    lapseCount: (row.lapseCount || 0) + 1,
    openLapse: 1,
    lastLapsedAt: now.toISOString(),
  });
}

function stats(db, { languageId, setId } = {}) {
  const base = ['deletedAt IS NULL'];
  const params = { now: nowIso() };
  scope(base, params, { languageId, setId });
  const scopeSql = base.join(' AND ');
  const count = (extra) => db.prepare(`SELECT COUNT(*) AS n FROM words WHERE ${[scopeSql, ...extra].join(' AND ')}`).get(params).n;
  return {
    newWords: count(['isLearned = 0', 'leitnerBox = 0', 'nextPracticeDate <= @now']),
    dueForPractice: count(['isLearned = 1', 'leitnerBox >= 1', 'nextPracticeDate <= @now']),
    troubleWords: count(['openLapse = 1']),
    learned: count(['isLearned = 1']),
    total: count([]),
  };
}

function resetProgress(db, { languageId, setId } = {}) {
  const clauses = [];
  const params = { now: startOfDay(new Date()) };
  scope(clauses, params, { languageId, setId });
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const info = db
    .prepare(
      `UPDATE words SET isLearned=0, leitnerBox=0, nextPracticeDate=@now, lastReviewedDate=NULL,
       lapseCount=0, openLapse=0, lastLapsedAt=NULL, updatedAt=@now ${where}`
    )
    .run(params);
  return { reset: info.changes };
}

module.exports = { reviewNext, practiceNext, markLearned, practiceCorrect, practiceIncorrect, stats, resetProgress };
