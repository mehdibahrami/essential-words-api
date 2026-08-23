const { badRequest, notFound } = require('../middleware/errorHandler');
const { startOfDayAfterDays } = require('../utils/time');
const { serializeWord, getWordRow } = require('./words');

/**
 * Recall: the reverse of Practice — prompt in the learner's own language, answer in the
 * language being learned. Its whole reason to exist as a separate service is that it
 * NEVER writes to `words`: no Leitner box, no nextPracticeDate, no lapse columns. The
 * history lives in its own append-only table, which makes that structural rather than a
 * matter of discipline. Same rule `learning.openLapses` states for quiz lapses:
 * scheduling has one authority and it is the Practice flow.
 */

/** The five recency filters the app offers. An unknown value is a 400, never a fallback. */
const WRONG_FILTERS = ['all', 'lastTime', 'week', 'month', 'ever'];

/**
 * Default AND cap for `/recall/queue`'s limit — the same number on purpose, so the
 * count the app's filter panel promises and the session it then gets cannot diverge.
 * (`TroubleWordsSession.maxSessionWords` in the app is 500 for the same reason.)
 */
const MAX_SESSION_WORDS = 500;

/** Highest box the app's chip row offers; a selected 6 means "6 or higher". */
const MAX_BOX = 6;

/** `?boxes=1,3,6` -> [1, 3, 6]. Junk is dropped; empty means "no box restriction". */
function parseBoxes(raw) {
  if (raw == null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const boxes = list
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_BOX);
  return [...new Set(boxes)].sort((a, b) => a - b);
}

/**
 * The clauses shared by `queue` and `count`. Built once so the two can never drift —
 * a count that disagrees with the session it predicts is the specific bug this guards.
 * Mutates `params` with the bindings the returned clauses reference.
 */
function poolClauses(params, { languageId, setId, boxes, wrong } = {}) {
  const clauses = ['deletedAt IS NULL', 'isLearned = 1', 'leitnerBox >= 1'];

  if (languageId != null && languageId !== '') {
    clauses.push('languageId = @languageId');
    params.languageId = Number(languageId);
  }
  if (setId != null && setId !== '') {
    clauses.push('wordSetId = @setId');
    params.setId = Number(setId);
  }

  const selected = parseBoxes(boxes);
  if (selected.length) {
    const parts = [];
    const exact = selected.filter((b) => b < MAX_BOX);
    if (exact.length) parts.push(`leitnerBox IN (${exact.join(', ')})`);
    // Mastered words sit in boxes 7+ (leitner.intervalDaysForBox's mastered stages).
    // Folding them into the top chip is what keeps them reachable at all.
    if (selected.includes(MAX_BOX)) parts.push(`leitnerBox >= ${MAX_BOX}`);
    clauses.push(`(${parts.join(' OR ')})`);
  }

  const filter = wrong == null || wrong === '' ? 'all' : String(wrong);
  if (!WRONG_FILTERS.includes(filter)) {
    throw badRequest(`Unknown wrong filter: ${filter}`);
  }
  const wrongClause = wrongFilterClause(filter, params);
  if (wrongClause) clauses.push(wrongClause);

  return clauses;
}

/**
 * The SQL for one recency filter, or null for "no restriction".
 *
 * Every clause correlates on `words.id`, so it is only valid inside a
 * `SELECT ... FROM words` — which is what both callers use.
 *
 * `lastTime` deliberately excludes a word with no attempts at all: it was not
 * "answered wrongly last time", it was not answered. The window filters are
 * start-of-day aligned in APP_TIMEZONE (`startOfDayAfterDays`), not hour-precise, so
 * "this past week" cannot quietly mean something different depending on what time of
 * day the app was opened.
 */
function wrongFilterClause(filter, params) {
  switch (filter) {
    case 'all':
      return null;
    case 'lastTime':
      return `(SELECT a.correct FROM recall_attempts a
                WHERE a.wordId = words.id
                ORDER BY a.createdAt DESC, a.id DESC
                LIMIT 1) = 0`;
    case 'ever':
      return `EXISTS (SELECT 1 FROM recall_attempts a
                       WHERE a.wordId = words.id AND a.correct = 0)`;
    case 'week':
    case 'month':
      params.since = startOfDayAfterDays(filter === 'week' ? -7 : -30);
      return `EXISTS (SELECT 1 FROM recall_attempts a
                       WHERE a.wordId = words.id AND a.correct = 0
                         AND a.createdAt >= @since)`;
    default:
      return null;
  }
}

/** A shuffled page of the filtered pool. */
function queue(db, { languageId, setId, boxes, wrong, limit } = {}) {
  const params = {};
  const clauses = poolClauses(params, { languageId, setId, boxes, wrong });
  const requested = Number(limit);
  params.limit = Number.isInteger(requested) && requested > 0
    ? Math.min(requested, MAX_SESSION_WORDS)
    : MAX_SESSION_WORDS;
  return db
    .prepare(`SELECT * FROM words WHERE ${clauses.join(' AND ')} ORDER BY RANDOM() LIMIT @limit`)
    .all(params)
    .map((r) => serializeWord(r, db));
}

/** How many words the same filters match, for the app's live filter readout. */
function count(db, { languageId, setId, boxes, wrong } = {}) {
  const params = {};
  const clauses = poolClauses(params, { languageId, setId, boxes, wrong });
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM words WHERE ${clauses.join(' AND ')}`)
    .get(params);
  return { count: row.n };
}

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

/**
 * Drop the Recall history for every word in scope. Called by `learning.resetProgress`
 * so "Reset progress" in Library means what it says — otherwise a user who reset a set
 * would still be told, by the recency filters, that they got its words wrong last month.
 *
 * Scoped over `words`, not over the Recall pool: a word that has since fallen out of
 * the pool still has history that a reset should clear.
 */
function clearForScope(db, { languageId, setId } = {}) {
  const clauses = [];
  const params = {};
  if (languageId != null) {
    clauses.push('languageId = @languageId');
    params.languageId = Number(languageId);
  }
  if (setId != null) {
    clauses.push('wordSetId = @setId');
    params.setId = Number(setId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const info = db
    .prepare(`DELETE FROM recall_attempts WHERE wordId IN (SELECT id FROM words ${where})`)
    .run(params);
  return { cleared: info.changes };
}

module.exports = { queue, count, record, clearForScope, WRONG_FILTERS, MAX_SESSION_WORDS };
