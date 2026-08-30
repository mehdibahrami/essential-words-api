const { badRequest } = require('../middleware/errorHandler');

/**
 * Part-of-speech FAMILIES, for the app's "show me only verbs" filter.
 *
 * `words.partOfSpeech` is free text on purpose (see CLAUDE.md, AI word generation): the
 * live DB holds ~30 distinct labels — case variants (`verb` / `Verb`), qualified forms
 * (`verb (separable)`, `verb (auxiliary)`), and combined ones (`Noun / Verb`,
 * `adjective/adverb`). A filter offering one chip per stored label would therefore offer
 * ~30 chips and list `verb` and `Verb` as two different things, which is why the app
 * filters by family instead.
 *
 * Matching is by TOKEN, not substring: the label is lowercased, its separators turned
 * into spaces, and the result padded with spaces, so a family matches only a whole word.
 * That is what keeps **adverb out of the verb family** — the trap a plain
 * `LIKE '%verb%'` falls straight into. A combined label belongs to every family it
 * names: `Noun / Verb` is both a noun and a verb.
 */
const POS_FAMILIES = {
  verb: ['verb', 'vb'],
  noun: ['noun'],
  adjective: ['adjective', 'adj'],
  adverb: ['adverb', 'adv'],
};

/** The values `?pos=` accepts. `other` is "in none of the four families". */
const POS_FILTERS = [...Object.keys(POS_FAMILIES), 'other'];

const EVERY_TOKEN = Object.values(POS_FAMILIES).flat();

/** `"Noun / Verb"` -> `" noun   verb "`, so a token match is `LIKE '% token %'`. */
function tokenize(label) {
  return ` ${String(label || '').toLowerCase().replace(/[/()\-,]/g, ' ')} `;
}

/**
 * JS twin of `posClause`'s SQL. Both are driven by the same `POS_FAMILIES` table, so the
 * app's locally-computed chip counts and the queue the server actually returns cannot
 * disagree about what a "verb" is.
 */
function matchesPosFamily(label, family) {
  const tokens = tokenize(label);
  const has = (list) => list.some((t) => tokens.includes(` ${t} `));
  if (family === 'other') return !has(EVERY_TOKEN);
  const wanted = POS_FAMILIES[family];
  return wanted ? has(wanted) : false;
}

/**
 * SQL fragment restricting `words.partOfSpeech` to one family, or `null` for "no
 * restriction" (`pos` absent, empty, or the explicit `all`). Mutates `params` with the
 * bindings it references, the same contract `recall.poolClauses` uses.
 *
 * An unrecognised family is a 400, never a silent fallback to unfiltered — a filter that
 * quietly does nothing is worse than one that says it cannot.
 */
function posClause(params, pos) {
  if (pos == null || pos === '' || pos === 'all') return null;
  const family = String(pos).trim().toLowerCase();
  if (!POS_FILTERS.includes(family)) {
    throw badRequest(`Unknown pos '${pos}'. Expected one of: ${POS_FILTERS.join(', ')}, all.`);
  }

  // Mirror of `tokenize()` in SQLite.
  const tokens = "(' ' || REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(partOfSpeech), '/', ' '), '(', ' '), ')', ' '), '-', ' '), ',', ' ') || ' ')";
  const wanted = family === 'other' ? EVERY_TOKEN : POS_FAMILIES[family];
  const likes = wanted.map((token, i) => {
    params[`posToken${i}`] = `% ${token} %`;
    return `${tokens} LIKE @posToken${i}`;
  });
  const any = `(${likes.join(' OR ')})`;
  return family === 'other' ? `NOT ${any}` : any;
}

module.exports = { POS_FAMILIES, POS_FILTERS, matchesPosFamily, posClause, tokenize };
