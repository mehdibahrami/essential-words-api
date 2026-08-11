const { nowIso, startOfDay } = require('../utils/time');
const { badRequest, notFound } = require('../middleware/errorHandler');
const dutchGrammar = require('./dutchGrammar');

const WORD_FIELDS = [
  'word', 'wordTranslated', 'partOfSpeech', 'definition', 'definitionTranslated',
  'example1', 'example1Translated', 'example2', 'example2Translated',
  'example3', 'example3Translated',
];

/**
 * Fields whose text the generated material is built from. A change to any of these
 * invalidates every cached sentence for the word; a Leitner or review-date update does
 * not, which is why this is a field allow-list rather than "any update". Currently an
 * alias for WORD_FIELDS (every word field the client can edit happens to also be
 * material-relevant) — kept as a separate name because the two lists answer different
 * questions and are free to diverge if a future WORD_FIELDS addition (e.g. a
 * non-textual flag) shouldn't invalidate cached material.
 */
const MATERIAL_FIELDS = WORD_FIELDS;

function dropCachedMaterial(db, wordId) {
  db.prepare('DELETE FROM word_material WHERE wordId = ?').run(Number(wordId));
}

// Cache of languageId -> code, per DB instance (a WeakMap so test DBs don't collide
// and are GC'd). Language codes are stable, so no invalidation is needed.
const langCodeByDb = new WeakMap();
function languageCode(db, languageId) {
  // Guard: serializeWord is sometimes reached via `.map(serializeWord)`, which would
  // pass the array index here. Only a real db handle (object) is usable as a WeakMap key.
  if (!db || typeof db !== 'object' || typeof db.prepare !== 'function') return null;
  let byId = langCodeByDb.get(db);
  if (!byId) { byId = new Map(); langCodeByDb.set(db, byId); }
  if (byId.has(languageId)) return byId.get(languageId);
  const row = db.prepare('SELECT code FROM languages WHERE id = ?').get(languageId);
  const code = row ? row.code : null;
  byId.set(languageId, code);
  return code;
}

/**
 * Build the grammar DTO for a word. Stored grammar (nouns; manual verb overrides)
 * always wins; otherwise Dutch verbs are conjugated live from the infinitive.
 */
function buildGrammar(row, db) {
  let stored = null;
  if (row.grammar) { try { stored = JSON.parse(row.grammar); } catch (_) { stored = null; } }
  const pos = (row.partOfSpeech || '').toLowerCase();
  const isDutch = languageCode(db, row.languageId) === 'nl-NL';

  if (stored) {
    if (stored.kind === 'verb' && stored.present) return stored;
    if (stored.article && stored.plural) return dutchGrammar.buildNounGrammar(row.word, stored);
  }
  if (isDutch && (pos === 'verb' || pos.startsWith('verb '))) {
    return dutchGrammar.buildVerbGrammar(row.word);
  }
  return null;
}

/** Present isLearned as a boolean and attach the grammar DTO. */
function serializeWord(row, db) {
  if (!row) return row;
  return { ...row, isLearned: !!row.isLearned, grammar: buildGrammar(row, db) };
}

/** Normalize an incoming grammar value (object or JSON string) to a stored TEXT column. */
function serializeGrammarField(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value; // assume already-serialized JSON
  return JSON.stringify(value);
}

function getWordRow(db, id) {
  return db.prepare('SELECT * FROM words WHERE id = ?').get(id);
}

function getWord(db, id) {
  return serializeWord(getWordRow(db, id), db);
}

function listWords(db, { setId, languageId, includeDeleted = false } = {}) {
  const clauses = [];
  const params = {};
  if (!includeDeleted) clauses.push('deletedAt IS NULL');
  if (setId != null) { clauses.push('wordSetId = @setId'); params.setId = Number(setId); }
  if (languageId != null) { clauses.push('languageId = @languageId'); params.languageId = Number(languageId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM words ${where} ORDER BY id ASC`).all(params).map((r) => serializeWord(r, db));
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
  record.grammar = serializeGrammarField(body.grammar);

  const cols = ['languageId', 'wordSetId', ...WORD_FIELDS, 'grammar', 'leitnerBox', 'nextPracticeDate', 'isLearned', 'lastReviewedDate', 'createdAt', 'updatedAt'];
  const info = db
    .prepare(`INSERT INTO words (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`)
    .run(record);
  return getWord(db, info.lastInsertRowid);
}

/**
 * Update editable/content fields. Leitner state (leitnerBox/isLearned/nextPracticeDate)
 * has exactly one authority — the /review and /practice endpoints — and is deliberately
 * NOT accepted here, even if a caller passes it directly: this used to be a documented
 * "allow explicit correction" escape hatch with no client ever exercising it, which is
 * exactly the kind of latent hole that stops being latent the moment an edit UI is
 * wired onto this route (see CLAUDE.md H2).
 */
function updateWord(db, id, fields) {
  const existing = getWordRow(db, id);
  if (!existing || existing.deletedAt) throw notFound('Word not found');
  const next = { ...existing };
  for (const f of WORD_FIELDS) if (fields[f] !== undefined) next[f] = fields[f];
  if (fields.wordSetId !== undefined) next.wordSetId = Number(fields.wordSetId);
  if (fields.grammar !== undefined) next.grammar = serializeGrammarField(fields.grammar);
  next.updatedAt = nowIso();

  const assignable = [...WORD_FIELDS, 'grammar', 'wordSetId', 'updatedAt'];
  const patch = { id };
  for (const f of assignable) patch[f] = next[f];
  db.prepare(`UPDATE words SET ${assignable.map((c) => `${c}=@${c}`).join(', ')} WHERE id=@id`)
    .run(patch);

  if (MATERIAL_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(fields, f))) {
    dropCachedMaterial(db, id);
  }
  return getWord(db, id);
}

function deleteWord(db, id) {
  const existing = getWordRow(db, id);
  if (!existing || existing.deletedAt) throw notFound('Word not found');
  db.prepare('UPDATE words SET deletedAt=@now, updatedAt=@now WHERE id=@id').run({ id, now: nowIso() });
  dropCachedMaterial(db, id);
}

const NOT_NULL_TEXT = new Set(['word', 'wordTranslated', 'partOfSpeech', 'definition', 'definitionTranslated']);

/** Bulk-insert words into a set (server assigns IDs). Used for CSV import / seeding. */
function bulkCreateWords(db, setId, wordsInput = []) {
  const set = db.prepare('SELECT id, languageId FROM word_sets WHERE id = ? AND deletedAt IS NULL').get(setId);
  if (!set) throw badRequest('set not found');
  const now = nowIso();
  const npd = startOfDay(new Date());
  const cols = ['languageId', 'wordSetId', ...WORD_FIELDS, 'grammar', 'leitnerBox', 'nextPracticeDate', 'isLearned', 'lastReviewedDate', 'createdAt', 'updatedAt'];
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
      rec.grammar = serializeGrammarField(w.grammar);
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
