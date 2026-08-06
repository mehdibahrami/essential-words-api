const { badRequest } = require('../middleware/errorHandler');
const { getLanguage } = require('./languages');
const { generateQuizFromPrompt } = require('./gemini');

const MAX_DRILL_WORDS = 8;
/** A hub session can be 30 exercises long, so it needs more material than a drill. */
const MAX_MATERIAL_WORDS = 20;
const BLANK = '____';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The headword without a leading Dutch article, which is not part of what is recalled. */
function bareWord(word) {
  return String(word || '').replace(/^\s*(de|het)\s+/i, '').trim();
}

/** A trimmed non-empty string, or null. Used for every optional text field we return. */
function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
  const examples = [
    [row.example1, row.example1Translated],
    [row.example2, row.example2Translated],
    [row.example3, row.example3Translated],
  ];
  for (const [sentence, translated] of examples) {
    if (!sentence) continue;
    for (let len = stem.length; len >= 3; len--) {
      const re = new RegExp(`\\b${escapeRegExp(stem.slice(0, len))}\\w*`, 'i');
      const m = sentence.match(re);
      if (m) {
        return {
          sentence: sentence.replace(re, BLANK),
          answer: m[0],
          distractors: [],
          // The cloze IS this example with a blank cut into it, so its stored
          // translation describes exactly the sentence the learner is shown.
          sentenceTranslation: cleanText(translated),
        };
      }
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

/** How many known headwords the prompt will carry, at most. Bounds prompt size. */
const MAX_KNOWN_WORDS = 80;
/** Below this, the list is too thin to constrain by and would force unnatural sentences. */
const MIN_KNOWN_WORDS = 10;

/**
 * Headwords the learner has actually learned, best-known first.
 *
 * `leitnerBox >= 1` is the definition of "learned" everywhere else in the app: a new
 * word sits at box 0 and only enters box 1 once it has been marked learned.
 */
function knownWords(db, languageId, limit = MAX_KNOWN_WORDS) {
  return db
    .prepare(
      `SELECT word FROM words
       WHERE deletedAt IS NULL AND languageId = @languageId AND leitnerBox >= 1
       ORDER BY leitnerBox DESC, lastReviewedDate DESC
       LIMIT @limit`
    )
    .all({ languageId: Number(languageId), limit })
    .map((r) => bareWord(r.word))
    .filter(Boolean);
}

function drillPrompt(language, rows, level = 'A1', known = []) {
  const list = rows
    .map((r) => `- id ${r.id}: "${r.word}" (${r.partOfSpeech || 'unknown'}) = ${r.definition || r.wordTranslated}`)
    .join('\n');

  // A SOFT constraint. A sentence needing a function word outside the list is still
  // better than no sentence, so nothing downstream validates or rejects on this basis —
  // `validCloze` is unchanged.
  const knownBlock = known.length >= MIN_KNOWN_WORDS
    ? [
        '',
        `The student already knows these ${language.name} words:`,
        known.join(', '),
        `Build each sentence from those words plus the word being practised. Prefer the`,
        `shortest natural sentence that uses it. If a sentence genuinely needs a word that`,
        `is not listed, use it — a natural sentence matters more than a perfect match.`,
      ].join('\n')
    : '';

  return [
    `The student keeps forgetting these ${language.name} (${language.code}) words:`,
    list,
    '',
    `Write every sentence at CEFR level ${level} — vocabulary and grammar the student can read at that level.`,
    `Every sentence must be between 4 and 8 words long. Longer sentences cannot be used as word-bank exercises.`,
    knownBlock,
    '',
    `For EACH word return one object with:`,
    `- "wordId": the numeric id given above.`,
    `- "cloze": { "sentence", "answer", "distractors", "sentenceTranslation" } — a short natural ${language.name} sentence that uses the word,`,
    `  with the word replaced by exactly "${BLANK}". "answer" is the exact form that belongs in the blank`,
    `  (it may be inflected). "distractors" is 3 wrong forms that are plausible but clearly incorrect here.`,
    `  The answer must NOT appear anywhere else in the sentence.`,
    `  "sentenceTranslation" is a natural English translation of the COMPLETE sentence with the blank filled in.`,
    `- "hook": one or two sentences of memory aid — a mnemonic, an etymology, or a sharp contrast with the word`,
    `  it is most often confused with. Written in English. Make it concrete and visual, not a restatement of the definition.`,
    `- "confusables": an array of ${language.name} words this one is easily mixed up with (may be empty).`,
    '',
    'Return a JSON array of these objects and nothing else.',
  ].join('\n');
}

/** The complete sentence a cloze was cut from — what a word-bank exercise scrambles. */
function unblank(cloze) {
  if (!cloze || typeof cloze.sentence !== 'string') return null;
  return cloze.sentence.split(BLANK).join(cloze.answer);
}

/** Rows already generated for these (wordId, level) pairs, in drill shape. */
function readCachedMaterial(db, ids, level) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db
    .prepare(
      `SELECT * FROM word_material
       WHERE level = ? AND wordId IN (${ids.map(() => '?').join(',')})`
    )
    .all(level, ...ids);
  for (const r of rows) {
    out.set(r.wordId, {
      wordId: r.wordId,
      sentence: r.sentence,
      cloze: r.clozeSentence
        ? {
            sentence: r.clozeSentence,
            answer: r.clozeAnswer,
            distractors: JSON.parse(r.clozeDistractors || '[]'),
            sentenceTranslation: r.sentenceTranslation,
          }
        : null,
      hook: r.hook,
      confusables: JSON.parse(r.confusables || '[]'),
    });
  }
  return out;
}

/**
 * Persist one drill. Written for EVERY resolved word, including the local
 * `clozeFromExamples` fallback and including words that resolved to no cloze at all —
 * a null result is a real answer worth remembering, and re-asking Gemini for it on
 * every session is exactly the latency this cache exists to remove.
 */
function writeCachedMaterial(db, level, drill) {
  db.prepare(
    `INSERT INTO word_material
       (wordId, level, sentence, clozeSentence, clozeAnswer, clozeDistractors,
        sentenceTranslation, hook, confusables)
     VALUES (@wordId, @level, @sentence, @clozeSentence, @clozeAnswer, @clozeDistractors,
             @sentenceTranslation, @hook, @confusables)
     ON CONFLICT(wordId, level) DO UPDATE SET
       sentence = excluded.sentence,
       clozeSentence = excluded.clozeSentence,
       clozeAnswer = excluded.clozeAnswer,
       clozeDistractors = excluded.clozeDistractors,
       sentenceTranslation = excluded.sentenceTranslation,
       hook = excluded.hook,
       confusables = excluded.confusables`
  ).run({
    wordId: drill.wordId,
    level,
    sentence: drill.sentence ?? null,
    clozeSentence: drill.cloze ? drill.cloze.sentence : null,
    clozeAnswer: drill.cloze ? drill.cloze.answer : null,
    clozeDistractors: drill.cloze ? JSON.stringify(drill.cloze.distractors || []) : null,
    sentenceTranslation: drill.cloze ? drill.cloze.sentenceTranslation ?? null : null,
    hook: drill.hook ?? null,
    confusables: JSON.stringify(drill.confusables || []),
  });
}

/**
 * Build a drill pack for the given word ids. One batched AI call; every word falls
 * back to a cloze cut from its own example sentences if the model fails or returns
 * something unusable, so a session is always startable.
 */
async function generateDrills(db, body, deps = {}) {
  const { languageId, setId = null, wordIds = [], level = 'A1', limit } = body || {};
  if (languageId == null) throw badRequest('languageId is required');
  const language = getLanguage(db, languageId);
  if (!language || language.deletedAt) throw badRequest('languageId does not reference an existing language');

  // `Number(limit) || MAX_DRILL_WORDS` would treat 0 as unset and let a negative
  // through to `slice`, which truncates from the end instead of capping.
  const requested = Number(limit);
  const cap = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : MAX_DRILL_WORDS,
    MAX_MATERIAL_WORDS
  );
  const ids = [...new Set((wordIds || []).map(Number).filter(Number.isFinite))].slice(0, cap);
  if (!ids.length) throw badRequest('wordIds must contain at least one word id');

  const rows = db
    .prepare(`SELECT * FROM words WHERE deletedAt IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .all(ids);
  if (!rows.length) throw badRequest('none of the given wordIds exist');

  const cached = readCachedMaterial(db, ids, level);
  const missing = rows.filter((r) => !cached.has(r.id));

  // Nothing to generate: serve the cache and skip Gemini entirely.
  if (!missing.length) {
    return rows.map((r) => cached.get(r.id));
  }

  const pool = decoyPool(db, languageId, setId);

  const aiById = new Map();
  try {
    const generate = deps.generate || generateQuizFromPrompt;
    const raw = await generate(drillPrompt(language, missing, level, knownWords(db, languageId)));
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (entry && entry.wordId != null) aiById.set(Number(entry.wordId), entry);
    }
  } catch (_) {
    // Leave aiById empty: every missing word takes the local fallback below.
  }

  const built = missing.map((row) => {
    const ai = aiById.get(row.id);
    if (ai && validCloze(ai.cloze)) {
      const cloze = {
        sentence: ai.cloze.sentence,
        answer: ai.cloze.answer.trim(),
        distractors: usableDistractors(ai.cloze.distractors, ai.cloze.answer).slice(0, 3),
        sentenceTranslation: cleanText(ai.cloze.sentenceTranslation),
      };
      return {
        wordId: row.id,
        sentence: unblank(cloze),
        cloze,
        hook: typeof ai.hook === 'string' && ai.hook.trim() ? ai.hook.trim() : null,
        confusables: Array.isArray(ai.confusables) ? ai.confusables.filter((c) => typeof c === 'string') : [],
      };
    }
    const local = clozeFromExamples(row);
    if (local) local.distractors = usableDistractors(pickDistractors(pool, local.answer, bareWord(row.word)), local.answer);
    const usable = local && validCloze(local) ? local : null;
    return {
      wordId: row.id,
      // A word-bank exercise needs no distractors, only the intact sentence — so
      // `sentence` comes from `local` directly rather than `usable`. `cloze` still
      // requires 2+ distractors, so it can legitimately be null while `sentence` is not.
      sentence: local ? unblank(local) : null,
      cloze: usable,
      hook: null,
      confusables: [],
    };
  });

  const write = db.transaction((list) => {
    for (const d of list) writeCachedMaterial(db, level, d);
  });
  write(built);

  const byId = new Map(built.map((d) => [d.wordId, d]));
  return rows.map((r) => cached.get(r.id) || byId.get(r.id));
}

module.exports = {
  generateDrills, drillPrompt, clozeFromExamples, validCloze, unblank,
  readCachedMaterial, writeCachedMaterial, knownWords,
  MAX_DRILL_WORDS, MAX_MATERIAL_WORDS,
};
