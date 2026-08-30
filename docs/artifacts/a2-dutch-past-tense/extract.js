#!/usr/bin/env node
'use strict';

/**
 * Extract every Dutch verb in a word set together with its past tense (OVT) and past
 * participle (VD), ordered by the time the word was added to the set.
 *
 * Source of truth is the server's own `words.serializeWord`, so the forms this emits are
 * byte-identical to what the API serves and the app renders — including the split between
 * a *stored* grammar object and one derived live by `dutchGrammar.js`. Do not reimplement
 * the grammar logic here; that divergence is exactly what this script exists to avoid.
 *
 * Usage (run on the Pi, where the live DB lives):
 *   node docs/artifacts/a2-dutch-past-tense/extract.js [setId] > a2-dutch-verbs.json
 *
 * Env:
 *   EW_DB   path to the SQLite file (default ../../data/essential-words.sqlite)
 */

const path = require('path');
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const Database = require(path.join(repoRoot, 'node_modules', 'better-sqlite3'));
const words = require(path.join(repoRoot, 'src', 'services', 'words.js'));
const dutchGrammar = require(path.join(repoRoot, 'src', 'services', 'dutchGrammar.js'));

const SET_ID = Number(process.argv[2] || 8); // 8 = "A2 essentials" (nl-NL)
const DB_PATH = process.env.EW_DB || path.join(repoRoot, 'data', 'essential-words.sqlite');

const db = new Database(DB_PATH, { readonly: true });

// `partOfSpeech` is free text (~45 distinct labels), so match the same way the server does
// rather than an enum — and anchor at the start, since LIKE '%verb%' also matches "adverb".
const rows = db.prepare(`
  SELECT * FROM words
  WHERE wordSetId = @setId AND deletedAt IS NULL
    AND (LOWER(partOfSpeech) = 'verb'
      OR LOWER(partOfSpeech) LIKE 'verb %'
      OR LOWER(partOfSpeech) LIKE 'verb(%')
  ORDER BY createdAt ASC, id ASC
`).all({ setId: SET_ID });

const setRow = db.prepare('SELECT name FROM word_sets WHERE id = ?').get(SET_ID);

const verbs = rows.map((row, i) => {
  const grammar = words.serializeWord(row, db).grammar || {};

  let stored = null;
  try { stored = row.grammar ? JSON.parse(row.grammar) : null; } catch (_) { stored = null; }
  const isStored = !!(stored && stored.kind === 'verb' && stored.present);

  // Provenance matters for review: a form from the pinned IRREGULAR_PAST table or a stored
  // grammar object was entered deliberately, whereas a 't kofschip fallback form is a guess.
  const infinitive = row.word.trim().toLowerCase();
  const source = isStored ? 'stored'
    : dutchGrammar.IRREGULAR_PAST[infinitive] ? 'table'
    : 'weak-fallback';

  return {
    n: i + 1,
    id: row.id,
    word: row.word,
    translation: row.wordTranslated,
    partOfSpeech: row.partOfSpeech,
    definition: row.definition,
    createdAt: row.createdAt,
    present: grammar.present || null,
    pastSingular: grammar.past ? grammar.past.singular : null,
    pastPlural: grammar.past ? grammar.past.plural : null,
    pastParticiple: grammar.pastParticiple || null,
    // `irregular` here is the PRESENT-tense flag off the grammar object. The sheet's own
    // weak/strong/irregular `class` is NOT emitted here: it is derived from the participle by
    // classify.js and applied by build.js, so changing that rule never needs the live DB.
    presentIrregular: !!grammar.irregular,
    separable: !!grammar.separable,
    source,
  };
});

console.log(JSON.stringify({
  setId: SET_ID,
  setName: setRow ? setRow.name : null,
  generatedAt: new Date().toISOString(),
  count: verbs.length,
  verbs,
}, null, 2));
