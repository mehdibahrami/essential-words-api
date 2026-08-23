const { notFound } = require('../middleware/errorHandler');
const { getWordRow } = require('./words');

/**
 * Recall: the reverse of Practice — prompt in the learner's own language, answer in the
 * language being learned. Its whole reason to exist as a separate service is that it
 * NEVER writes to `words`: no Leitner box, no nextPracticeDate, no lapse columns. The
 * history lives in its own append-only table, which makes that structural rather than a
 * matter of discipline. Same rule `learning.openLapses` states for quiz lapses:
 * scheduling has one authority and it is the Practice flow.
 */

/** Append one Recall answer. Never touches the word row. */
function record(db, wordId, correct, now = new Date()) {
  const row = getWordRow(db, wordId);
  if (!row || row.deletedAt) throw notFound('Word not found');
  const createdAt = now.toISOString();
  db.prepare(
    'INSERT INTO recall_attempts (wordId, correct, createdAt) VALUES (@wordId, @correct, @createdAt)'
  ).run({ wordId, correct: correct ? 1 : 0, createdAt });
  return { wordId, correct: !!correct, createdAt };
}

module.exports = { record };
