const { badRequest } = require('../middleware/errorHandler');
const { getLanguage } = require('./languages');
const { generateQuizFromPrompt } = require('./gemini');

const MAX_DRILL_WORDS = 8;
const BLANK = '____';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The headword without a leading Dutch article, which is not part of what is recalled. */
function bareWord(word) {
  return String(word || '').replace(/^\s*(de|het)\s+/i, '').trim();
}

/**
 * Blank the word out of one of its own example sentences.
 *
 * The example almost never contains the citation form — "liggen" appears as "ligt".
 * So try progressively shorter prefixes of the headword (longest first, floor of 3
 * characters) and blank the first whole word that starts with one. "liggen" → "lig"
 * matches "ligt"; the longest-first order stops a short prefix from winning when a
 * fuller form is present. Returns null when no example contains the word.
 */
function clozeFromExamples(row) {
  const stem = bareWord(row.word).toLowerCase();
  if (stem.length < 3) return null;
  for (const sentence of [row.example1, row.example2, row.example3]) {
    if (!sentence) continue;
    for (let len = stem.length; len >= 3; len--) {
      const re = new RegExp(`\\b${escapeRegExp(stem.slice(0, len))}\\w*`, 'i');
      const m = sentence.match(re);
      if (m) return { sentence: sentence.replace(re, BLANK), answer: m[0], distractors: [] };
    }
  }
  return null;
}

/** Candidate wrong answers: other words in the same scope, bare (no article). */
function decoyPool(db, languageId, setId) {
  const clauses = ['deletedAt IS NULL', 'languageId = @languageId'];
  const params = { languageId: Number(languageId) };
  if (setId != null) { clauses.push('wordSetId = @setId'); params.setId = Number(setId); }
  return db
    .prepare(`SELECT word FROM words WHERE ${clauses.join(' AND ')} ORDER BY RANDOM() LIMIT 40`)
    .all(params)
    .map((r) => bareWord(r.word))
    .filter(Boolean);
}

/**
 * Up to `count` distractors, excluding the answer and the headword being drilled.
 * Only the drilled word is excluded, not every word in the session — excluding them
 * all can empty the pool on a small set.
 */
function pickDistractors(pool, answer, headword, count = 3) {
  const seen = new Set([String(answer).toLowerCase(), String(headword).toLowerCase()]);
  const out = [];
  for (const candidate of pool) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length === count) break;
  }
  return out;
}

/**
 * The distractors the client can actually show: trimmed, distinct from each other and
 * from the answer, both compared case- and trim-insensitively.
 *
 * The client renders the options as `distractors + [answer]` and grades by string
 * equality, so a distractor repeating the answer would make two options correct at
 * once — and duplicate strings collide as identities in its `ForEach(id: \.self)`.
 * The model is asked for distinct wrong forms but nothing enforces it, so normalise
 * here: a malformed cloze reaching the client is worse than no cloze.
 */
function usableDistractors(distractors, answer) {
  const seen = new Set([String(answer || '').trim().toLowerCase()]);
  const out = [];
  for (const candidate of Array.isArray(distractors) ? distractors : []) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * A cloze is usable only if it has a blank, a non-empty answer, at least two
 * distinct distractors, and does not leak the answer outside the blank.
 */
function validCloze(cloze) {
  if (!cloze || typeof cloze.sentence !== 'string' || typeof cloze.answer !== 'string') return false;
  if (!cloze.sentence.includes(BLANK)) return false;
  if (!cloze.answer.trim()) return false;
  if (usableDistractors(cloze.distractors, cloze.answer).length < 2) return false;
  const withoutBlank = cloze.sentence.split(BLANK).join(' ').toLowerCase();
  const re = new RegExp(`\\b${escapeRegExp(cloze.answer.trim().toLowerCase())}\\b`);
  return !re.test(withoutBlank);
}

function drillPrompt(language, rows) {
  const list = rows
    .map((r) => `- id ${r.id}: "${r.word}" (${r.partOfSpeech || 'unknown'}) = ${r.definition || r.wordTranslated}`)
    .join('\n');
  return [
    `The student keeps forgetting these ${language.name} (${language.code}) words:`,
    list,
    '',
    `For EACH word return one object with:`,
    `- "wordId": the numeric id given above.`,
    `- "cloze": { "sentence", "answer", "distractors" } — a short natural ${language.name} sentence that uses the word,`,
    `  with the word replaced by exactly "${BLANK}". "answer" is the exact form that belongs in the blank`,
    `  (it may be inflected). "distractors" is 3 wrong forms that are plausible but clearly incorrect here.`,
    `  The answer must NOT appear anywhere else in the sentence.`,
    `- "hook": one or two sentences of memory aid — a mnemonic, an etymology, or a sharp contrast with the word`,
    `  it is most often confused with. Written in English. Make it concrete and visual, not a restatement of the definition.`,
    `- "confusables": an array of ${language.name} words this one is easily mixed up with (may be empty).`,
    '',
    'Return a JSON array of these objects and nothing else.',
  ].join('\n');
}

/**
 * Build a drill pack for the given word ids. One batched AI call; every word falls
 * back to a cloze cut from its own example sentences if the model fails or returns
 * something unusable, so a session is always startable.
 */
async function generateDrills(db, body, deps = {}) {
  const { languageId, setId = null, wordIds = [] } = body || {};
  if (languageId == null) throw badRequest('languageId is required');
  const language = getLanguage(db, languageId);
  if (!language || language.deletedAt) throw badRequest('languageId does not reference an existing language');

  const ids = [...new Set((wordIds || []).map(Number).filter(Number.isFinite))].slice(0, MAX_DRILL_WORDS);
  if (!ids.length) throw badRequest('wordIds must contain at least one word id');

  const rows = db
    .prepare(`SELECT * FROM words WHERE deletedAt IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .all(ids);
  if (!rows.length) throw badRequest('none of the given wordIds exist');

  const pool = decoyPool(db, languageId, setId);

  const aiById = new Map();
  try {
    const generate = deps.generate || generateQuizFromPrompt;
    const raw = await generate(drillPrompt(language, rows));
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (entry && entry.wordId != null) aiById.set(Number(entry.wordId), entry);
    }
  } catch (_) {
    // Leave aiById empty: every word takes the local fallback below.
  }

  return rows.map((row) => {
    const ai = aiById.get(row.id);
    if (ai && validCloze(ai.cloze)) {
      return {
        wordId: row.id,
        cloze: {
          sentence: ai.cloze.sentence,
          answer: ai.cloze.answer.trim(),
          distractors: usableDistractors(ai.cloze.distractors, ai.cloze.answer).slice(0, 3),
        },
        hook: typeof ai.hook === 'string' && ai.hook.trim() ? ai.hook.trim() : null,
        confusables: Array.isArray(ai.confusables) ? ai.confusables.filter((c) => typeof c === 'string') : [],
      };
    }
    const local = clozeFromExamples(row);
    if (local) local.distractors = usableDistractors(pickDistractors(pool, local.answer, bareWord(row.word)), local.answer);
    return {
      wordId: row.id,
      cloze: local && validCloze(local) ? local : null,
      hook: null,
      confusables: [],
    };
  });
}

module.exports = { generateDrills, drillPrompt, clozeFromExamples, validCloze, MAX_DRILL_WORDS };
